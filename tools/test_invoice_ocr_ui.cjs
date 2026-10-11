// Offline invoice OCR UI and encrypted cloud-save regression. All network requests are intercepted.
// Run with Playwright available through NODE_PATH; NMF_INVOICE_UI_SOURCE can select an authentic baseline.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { chromium } = require('playwright');

let source = fs.readFileSync(process.env.NMF_INVOICE_UI_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
const sourceFileHash = createHash('sha256').update(source).digest('hex');
const negativeControl = process.env.NMF_INVOICE_UI_NEGATIVE_CONTROL;
if (negativeControl) {
  assert.equal(negativeControl, 'random-ocr-ids', 'unknown isolated negative control');
  const target = "id:'invoice-'+d.imageSha256";
  assert.equal(source.split(target).length, 2, 'negative control requires one OCR order identity integration point');
  source = source.replace(target, 'id:crypto.randomUUID()');
}
const password = 'offline-invoice-fixture-password';
const clone = value => structuredClone(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const itemKeys = ['name', 'spec', 'qty', 'unit', 'price', 'amt', 'tax'];
const existingId = '00000000-0000-4000-8000-000000000001';
const orderCard = (page, id) => page.locator(`[data-order-id="${id}"]`);
async function selectOrder(page, id) {
  const tab = page.locator(`[data-order-tab="${id}"]`);
  assert.equal(await tab.count(), 1, 'every saved invoice has its own selectable tab');
  await tab.click();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  assert.equal(await orderCard(page, id).isVisible(), true);
  return orderCard(page, id);
}
const extractionHash = request => createHash('sha256').update(Buffer.from(request.body.image.data, 'base64')).digest('hex');
async function progress(page) {
  const bar = page.locator('#invoice-progress-bar');
  assert.equal(await bar.count(), 1, 'photo processing exposes a real, accessible progress element');
  assert.equal(await bar.evaluate(el => el.tagName), 'PROGRESS');
  return bar.evaluate(el => ({ value: el.value, max: el.max, state: structuredClone(invoiceOcr.progress) }));
}
async function numberFit(input) {
  return input.evaluate(el => {
    const style = getComputedStyle(el), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
    return { text: context.measureText(el.value).width, available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), value: el.value,
      field: el.dataset.orderField || el.dataset.orderKey, width: el.getBoundingClientRect().width, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
      inlineFont: el.style.fontSize, computedFont: style.fontSize, measuredFont: context.font, padding: [style.paddingLeft, style.paddingRight],
      inlineMinWidth: el.style.minWidth, computedMinWidth: style.minWidth };
  });
}

function documentFixture(overrides = {}) {
  return { date: '2026-09-30', vendor: '검증유통', invoiceNo: 'T-100', subtotal: 30000, tax: 3000, total: 33000,
    items: [{ name: '양파', spec: '10kg', qty: 2, unit: '망', price: 15000, amt: 30000, tax: 3000, confidence: .95, warnings: [] }],
    rawText: '검증유통\n2026-09-30\n양파 10kg 2망 15,000 30,000\n부가세 3,000 합계 33,000', warnings: [], ...overrides };
}
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
function protectedState(state) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !['month', 'updatedAt', 'orders', 'orderEdits'].includes(key)));
}
const orderRecords = state => Object.values(state.orders).flat().sort((a, b) => a.id.localeCompare(b.id));
async function readState(page) { return page.evaluate(() => structuredClone(S)); }
async function quiesce(page) { await page.evaluate(() => { clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); }); }
async function photo(page, name, color = '#e61e50', width = 96, height = 72) {
  const encoded = await page.evaluate(({ color, width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#163bea'; ctx.fillRect(0, 0, width / 4, height / 4);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { color, width, height });
  return { name, mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}
async function imageInfo(page, image) {
  return page.evaluate(async image => {
    const bytes = Uint8Array.from(atob(image.data), ch => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mime }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const pixel = Array.from(ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data);
    const result = { width: bitmap.width, height: bitmap.height, pixel }; bitmap.close(); return result;
  }, image);
}

async function fixture(browser) {
  const contexts = [], pages = [], errors = [], dialogs = [], requests = [], responses = [], commits = [];
  let remote = null, conflictRow = null, rejected = 0;
  async function newPage() {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } }); contexts.push(context);
    await context.addInitScript(password => {
      localStorage.setItem('nmf_app', 'food'); localStorage.setItem('nmf_supa_food', JSON.stringify({ url: '', key: '' }));
      sessionStorage.setItem('nmf_session_pw', password);
    }, password);
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        if (request.isNavigationRequest()) {
          assert.equal(url.origin, 'https://offline.namofood.test');
          return route.fulfill({ contentType: 'text/html', body: source });
        }
        if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/functions/v1/nmf-invoice-ocr') {
          assert.equal(request.method(), 'POST');
          const raw = request.postData(), body = JSON.parse(raw), time = request.headers()['x-nmf-time'];
          assert.match(time || '', /^\d+$/); assert(Math.abs(Date.now() - Number(time)) < 30000);
          const hash = createHash('sha256').update(raw).digest('hex');
          const signature = createHmac('sha256', password).update('nmf-invoice:' + hash + ':' + time).digest('hex');
          assert.equal(request.headers()['x-nmf-signature'], signature, 'signature authenticates the exact serialized request body and time');
          assert.equal(request.headers().apikey, 'offline-anon-fixture');
          assert.equal(body.app, 'food'); assert.match(body.nonce, uuid);
          assert(['extract', 'status'].includes(body.action));
          const observed = { body, raw, page }; requests.push(observed);
          if (body.action === 'status') {
            assert.equal(body.image, undefined, 'status request contains no photograph');
            return route.fulfill({ json: { ok: true, enabled: true, configured: true, model: 'kimi-k2.6', provider: 'opencode-zen' } });
          }
          assert.equal(body.image.mime, 'image/jpeg', 'browser preprocessing sends color JPEG instead of original file bytes');
          assert.match(body.image.data, /^[A-Za-z0-9+/]+=*$/);
          const info = await imageInfo(page, body.image); observed.imageInfo = info;
          assert(Math.max(info.width, info.height) <= 3200, 'submitted photo never exceeds 3200 pixels');
          assert(info.pixel[0] > info.pixel[1] + 40, 'preprocessing preserves the fixture color instead of converting it to grayscale');
          const planned = responses.shift(); assert(planned, 'each extraction must have an explicit offline fixture response');
          if (planned.gate) await planned.gate;
          if (planned.status && planned.status !== 200) return route.fulfill({ status: planned.status, json: { ok: false, error: planned.error } });
          return route.fulfill({ json: { ok: true, document: planned.document, imageSha256: createHash('sha256').update(Buffer.from(body.image.data, 'base64')).digest('hex'), model: 'kimi-k2.6', processedAt: '2026-10-11T00:00:00.000Z' } });
        }
        if (url.pathname === '/functions/v1/nmf-recipe-fill') return route.fulfill({ json: { ok: true, running: null, runs: [], last: null } });
        if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/rest/v1/namofood_state') {
          if (request.method() === 'GET') return route.fulfill({ json: remote ? [remote] : [] });
          if (request.method() === 'PATCH') {
            assert.equal(url.searchParams.get('id'), 'eq.namofood');
            if (conflictRow) { remote = conflictRow; conflictRow = null; rejected++; return route.fulfill({ json: [] }); }
            if (url.searchParams.get('updated_at') !== 'eq.' + remote.updated_at) { rejected++; return route.fulfill({ json: [] }); }
            remote = { id: 'namofood', ...request.postDataJSON() }; commits.push(clone(remote));
            return route.fulfill({ json: [{ id: 'namofood' }] });
          }
          assert.equal(request.method(), 'POST');
          assert(request.postDataJSON().every(row => row.id.startsWith('namofood@')), 'only dated backups may be inserted');
          return route.fulfill({ json: [] });
        }
        return route.abort();
      } catch (error) { errors.push(error); return route.abort(); }
    });
    await page.goto('https://offline.namofood.test/');
    await page.evaluate(() => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
      cloud.url = 'https://offline-cloud.namofood.test'; cloud.key = 'offline-anon-fixture'; cloud.table = 'namofood_state'; cloud.room = 'namofood';
    });
    return page;
  }
  try {
    const a = await newPage();
    const base = await a.evaluate(existingId => {
      const state = normalize(defaultState()); state.month = '2026-10';
      state.view.printMeals = ['중식', '석식'];
      state.orders = { '2026-09': [{ id: existingId, date: '2026-09-25', vendor: '기존거래', note: '보존할 기록', items: [{ name: '쌀', qty: 1, unit: '포', price: 3000, amt: 3000 }], ocr: '' }], '2026-10': [] };
      state.orderEdits = {}; state.menus = { '2026-10': { '14|중식|2': '보존할 수동식단', '14|중식|n': '250' } };
      state.menuPlanMeta = {}; state.headcountMeta = {};
      state.staff = [{ id: 'active-fixture', name: '검증 직원', role: '조리', wage: 15000, bonus: 1000, def: { s: '09:00', e: '18:00', b: 60 }, off: [] }];
      state.staffArchive = []; state.staffEdits = {}; state.staffFieldEdits = {}; state.rosterEdits = { '2026-09': {} };
      state.roster = { '2026-09': { 'active-fixture|2': { s: '22:00', e: '06:00', b: 60 } } };
      state.recipes = []; state.methods = {}; state.sources = {}; state.recipeMeta = {}; state.recipeAsk = {};
      state.purch = []; state.purchEdit = {}; state.stock = []; state.stockLog = [];
      S = normalize(state); go('order'); localStorage.setItem(KEY, JSON.stringify(S));
      return structuredClone(S);
    }, existingId);
    assert.equal(await a.locator('#invoice-files').count(), 1, 'Orders must expose the photo OCR upload field #invoice-files');
    assert.equal(await a.locator('#invoice-files').evaluate(input => input.multiple), true);
    const accept = (await a.locator('#invoice-files').getAttribute('accept')).split(',').map(value => value.trim());
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) assert(accept.includes(mime), 'accepted photo format: ' + mime);
    const wrap = async (state, updated_at) => ({ id: 'namofood', data: await a.evaluate(async ({ state, password }) => encryptText(password, JSON.stringify(state)), { state, password }), updated_at });
    const put = async (state, at = '2026-10-01T00:00:00.000Z') => { remote = await wrap(state, at); };
    await put(base);
    const getRemote = async () => a.evaluate(async ({ row, password }) => JSON.parse(await decryptText(password, row.data)), { row: remote, password });
    const check = () => { if (errors.length) throw errors[0]; };
    const enqueue = (document = documentFixture(), options = {}) => {
      const planned = { document, ...options }; let release;
      if (options.hold) planned.gate = new Promise(resolve => { release = resolve; });
      responses.push(planned); return { release };
    };
    const idle = async (page = a) => { await page.waitForFunction(() => !invoiceOcr.busy); check(); };
    const save = async page => { await quiesce(page); await page.evaluate(() => cloudSave(true)); await quiesce(page); check(); };
    const peer = async () => { const b = await newPage(); assert.equal(await b.evaluate(() => cloudLoad(false)), true); await b.evaluate(() => go('order')); return b; };
    return { a, base, requests, commits, dialogs, enqueue, idle, save, put, wrap, getRemote, peer, check,
      conflict: row => { conflictRow = row; }, rejected: () => rejected, close: async () => Promise.all(contexts.map(context => context.close())) };
  } catch (error) { await Promise.all(contexts.map(context => context.close())); throw error; }
}

async function csvRows(page) {
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => orderCsv());
  const download = await downloadPromise, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (ch === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const passed = [], failures = [];
  async function run(name, scenario) {
    if (process.env.NMF_INVOICE_UI_SCENARIO && !name.includes(process.env.NMF_INVOICE_UI_SCENARIO)) return;
    let f;
    try { f = await fixture(browser); await scenario(f); f.check(); passed.push(name); console.log('PASS ' + name); }
    catch (error) { failures.push({ name, error }); console.error('FAIL ' + name + ': ' + error.message); }
    finally { if (f) await f.close(); }
  }
  try {
    await run('PHOTO_AUTO_REGISTERS_WITHOUT_CONFIRMATION_PRESERVES_ACTUAL_AMOUNTS', async f => {
      const before = await readState(f.a), persisted = await f.a.evaluate(() => localStorage.getItem(KEY));
      await f.a.locator('#invoice-status-refresh').click();
      await f.a.waitForFunction(() => invoiceOcr.status.includes('서버 연결 정상'));
      assert.equal(f.requests.filter(request => request.body.action === 'status').length, 1, 'real status button uses the same authenticated offline service');
      f.enqueue();
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'dummy-invoice.png', '#e61e50', 4000, 1200));
      await f.idle();
      const registered = orderRecords(await readState(f.a)).find(order => order.id !== existingId);
      assert(registered, 'successful recognition immediately registers an order, without any checkbox or commit button');
      assert.equal(await f.a.locator('[data-invoice-confirm],[data-invoice-commit]').count(), 0);
      const panel = orderCard(f.a, registered.id); assert.equal(await panel.count(), 1);
      assert.equal(f.requests.filter(request => request.body.action === 'extract').length, 1);
      assert.equal(Math.max(...Object.values(f.requests.find(request => request.body.action === 'extract').imageInfo).filter(value => typeof value === 'number')), 3200);
      await f.a.waitForFunction(id => Object.values(JSON.parse(localStorage.getItem(KEY)).orders).flat().some(order => order.id === id), registered.id);
      assert.notEqual(await f.a.evaluate(() => localStorage.getItem(KEY)), persisted, 'automatic registration changes durable local application state');
      const price = panel.locator('[data-order-item]').first().locator('[data-order-key="price"]');
      await price.fill('17000'); await price.press('Tab');
      assert.equal(Number((await panel.locator('[data-order-item]').first().locator('[data-order-key="amt"]').inputValue()).replace(/,/g, '')), 30000, 'correcting unit price never silently recalculates the printed amount');
      const after = await readState(f.a), added = after.orders['2026-09'].find(order => order.id !== existingId);
      const hash = extractionHash(f.requests.find(request => request.body.action === 'extract'));
      assert(added); assert.equal(added.id, 'invoice-' + hash, 'OCR order identity is deterministic across clients for the exact photo bytes');
      assert.deepEqual(pick(added, ['date', 'vendor', 'invoiceNo', 'subtotal', 'tax', 'total']), pick(documentFixture(), ['date', 'vendor', 'invoiceNo', 'subtotal', 'tax', 'total']));
      assert.deepEqual(pick(added.items[0], itemKeys), { name: '양파', spec: '10kg', qty: 2, unit: '망', price: 17000, amt: 30000, tax: 3000 });
      assert.equal(added.ocrMeta.model, 'kimi-k2.6'); assert.equal(added.ocrMeta.imageSha256, hash);
      assert.equal(added.ocrMeta.autoRegistered, true); assert(Number.isFinite(Date.parse(added.ocrMeta.registeredAt)));
      assert.equal(Object.hasOwn(added.ocrMeta, 'confirmedAt'), false, 'automatic recognition must not imply the user verified the original');
      assert.equal(await f.a.evaluate(id => orderAmt(Object.values(S.orders).flat().find(order => order.id === id)), added.id), 33000, 'visible order amount uses the invoice header total including tax');
      assert.equal(after.month, '2026-09', 'recognized September date saves in September and switches the visible month');
      assert.deepEqual(after.orders['2026-09'].find(order => order.id === existingId), before.orders['2026-09'][0]);
      assert.deepEqual(protectedState(after), protectedState(before), 'automatic invoice registration cannot change staff, historical roster, meals, settings or recipes');
      assert.match(await f.a.locator('summary').filter({ hasText: '검증유통' }).innerText(), /33,000/);
      const success = await progress(f.a); assert.equal(success.max, 3); assert.equal(success.value, 3);
      assert.equal(success.state.total, 1); assert.equal(success.state.completed, 1); assert.equal(success.state.registered, 1);
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'same-image-again.png', '#e61e50', 4000, 1200));
      await f.idle();
      assert.equal(orderRecords(await readState(f.a)).length, 2, 're-uploading the exact same image cannot create a duplicate order');
      assert.equal(f.requests.filter(request => request.body.action === 'extract').length, 1, 'exact duplicate photographs are rejected before another paid recognition');
      assert.equal(f.dialogs.length, 0, 'automatic registration and duplicate-photo handling need no confirmation dialogs');
      const finished = await progress(f.a); assert.equal(finished.state.registered, 0, 'the duplicate batch reports no new registration');
    });
    await run('EACH_PHOTO_HAS_ITS_OWN_DOCUMENT_AND_ORDER', async f => {
      f.enqueue(documentFixture()); f.enqueue(documentFixture({ date: '2026-10-02', vendor: '다른유통', invoiceNo: 'T-200', subtotal: 10000, tax: 1000, total: 11000 }));
      await f.a.locator('#invoice-files').setInputFiles([await photo(f.a, 'first.png'), await photo(f.a, 'second.png', '#ee7831')]);
      await f.idle();
      const orders = orderRecords(await readState(f.a)); assert.equal(orders.length, 3);
      assert.equal(orders.filter(order => order.invoiceNo === 'T-100').length, 1); assert.equal(orders.filter(order => order.invoiceNo === 'T-200').length, 1);
      assert.equal(orders.find(order => order.invoiceNo === 'T-100').vendor, '검증유통');
      assert.equal(orders.find(order => order.invoiceNo === 'T-200').vendor, '다른유통');
      assert.notEqual(orders.find(order => order.invoiceNo === 'T-100').ocrMeta.imageSha256, orders.find(order => order.invoiceNo === 'T-200').ocrMeta.imageSha256);
      const finished = await progress(f.a);
      assert.equal(finished.max, 6); assert.equal(finished.value, 6); assert.equal(finished.state.total, 2);
      assert.equal(finished.state.completed, 2); assert.equal(finished.state.registered, 2);
    });
    await run('FIRST_PHOTO_REGISTERS_WHILE_SECOND_PENDING_AND_PRESERVES_UNBLURRED_NOTE', async f => {
      f.enqueue(); const second = f.enqueue(documentFixture({ vendor: '두 번째 공급자', invoiceNo: 'T-200' }), { hold: true });
      await f.a.locator('#invoice-files').setInputFiles([await photo(f.a, 'first-review.png'), await photo(f.a, 'second-pending.png', '#ed7028')]);
      await f.a.waitForFunction(() => Object.values(S.orders).flat().some(order => order.invoiceNo === 'T-100') && invoiceOcr.busy);
      await f.a.waitForFunction(() => invoiceOcr.progress?.completed === 1 && invoiceOcr.progress?.step === 1);
      const first = orderRecords(await readState(f.a)).find(order => order.invoiceNo === 'T-100');
      assert.equal(orderRecords(await readState(f.a)).length, 2, 'first photograph is registered before the second server response arrives');
      const pending = await progress(f.a); assert.equal(pending.max, 6); assert.equal(pending.value, 4); assert.equal(pending.state.registered, 1);
      const note = orderCard(f.a, first.id).locator('[data-order-field="note"]');
      await note.fill('인식 중 직접 입력한 특이사항\n배송 확인');
      const node = await note.elementHandle();
      assert.equal(orderRecords(await readState(f.a)).find(order => order.id === first.id).note, '인식 중 직접 입력한 특이사항\n배송 확인', 'note input saves immediately without waiting for blur');
      assert.equal(await note.evaluate(input => document.activeElement === input), true);
      second.release(); await f.idle();
      assert.equal(orderRecords(await readState(f.a)).length, 3);
      assert.equal(await node.evaluate(input => input.isConnected && document.activeElement === input), true, 'second OCR result does not replace a focused note node');
      assert.equal(await note.inputValue(), '인식 중 직접 입력한 특이사항\n배송 확인');
      assert.equal(orderRecords(await readState(f.a)).find(order => order.id === first.id).note, '인식 중 직접 입력한 특이사항\n배송 확인');
      const finished = await progress(f.a); assert.equal(finished.value, 6); assert.equal(finished.state.registered, 2);
    });
    await run('GROSS_NET_TAX_AND_PREVIOUS_BALANCE_REMAIN_DISTINCT', async f => {
      const before = await readState(f.a);
      const layouts = [
        { date: '2026-10-08', vendor: '합계 검증업체 A', invoiceNo: 'GROSS-1', subtotal: 732550, tax: 53450, total: 786000, previousBalance: 890200, balanceTotal: 1676200 },
        { date: '2026-10-09', vendor: '합계 검증업체 B', invoiceNo: 'GROSS-2', subtotal: 691078, tax: 52102, total: 743180, previousBalance: 3128900, balanceTotal: 3872080 },
      ];
      for (const layout of layouts) f.enqueue(documentFixture({ ...layout, items: [{ name: '합계 검증 식자재', spec: '혼합 납품', qty: 1, unit: '건', price: layout.subtotal, supplyAmount: layout.subtotal, amt: layout.total, tax: layout.tax, confidence: .95, warnings: [] }] }));
      await f.a.locator('#invoice-files').setInputFiles([await photo(f.a, 'gross-a.png'), await photo(f.a, 'gross-b.png', '#ed6a31')]);
      await f.idle();
      const registered = orderRecords(await readState(f.a)).filter(order => order.id !== existingId); assert.equal(registered.length, 2);
      for (const layout of layouts) {
        const order = registered.find(order => order.invoiceNo === layout.invoiceNo), panel = await selectOrder(f.a, order.id);
        for (const field of ['subtotal', 'tax', 'total', 'previousBalance', 'balanceTotal']) {
          assert.equal(Number((await panel.locator(`[data-order-field="${field}"]`).inputValue()).replace(/,/g, '')), layout[field], 'saved field preserves ' + field);
        }
        assert.equal(Number((await panel.locator('[data-order-item]').first().locator('[data-order-key="supplyAmount"]').inputValue()).replace(/,/g, '')), layout.subtotal);
        assert.equal(order.items[0].amt, layout.total, 'row amount retains the gross printed amount');
      }
      const after = await readState(f.a);
      for (const layout of layouts) {
        const order = orderRecords(after).find(order => order.invoiceNo === layout.invoiceNo);
        assert.deepEqual(pick(order, Object.keys(layout)), layout);
        assert.equal(order.items[0].supplyAmount, layout.subtotal); assert.equal(order.items[0].amt, layout.total); assert.equal(order.items[0].tax, layout.tax);
        assert.equal(await f.a.evaluate(order => orderAmt(order), order), layout.total, 'current delivery cost excludes the previous unpaid balance');
      }
      const displayed = await f.a.locator('.kpi').filter({ hasText: '발주 금액 합계' }).locator('b').innerText();
      assert.equal(Number(displayed.replace(/\D/g, '')), 1529180, 'monthly order total adds current deliveries 786000 + 743180, not outstanding debt');
      assert.deepEqual(protectedState(after), protectedState(before));
    });
    await run('CLEARED_MODERN_HEADER_TOTAL_USES_GROSS_ROWS_WITHOUT_ADDING_VAT_TWICE', async f => {
      const before = await readState(f.a);
      await f.a.evaluate(id => {
        S.month = '2026-09'; go('order'); oItem(id, 0, 'price', '50000'); oSet(id, 'tax', '5000');
      }, existingId);
      await quiesce(f.a);
      const legacy = orderRecords(await readState(f.a)).find(order => order.id === existingId);
      assert.equal(legacy.ocrMeta, undefined); assert.equal(legacy.items[0].supplyAmount, undefined);
      assert.equal(legacy.items[0].amt, 50000); assert.equal(legacy.tax, 5000);
      assert.equal(await f.a.evaluate(order => orderAmt(order), legacy), 55000, 'legacy net-only rows without OCR metadata retain the separate header VAT fallback');
      assert.match(await f.a.locator('summary').filter({ hasText: '기존거래' }).innerText(), /55,000원/);
      const legacyCsv = (await csvRows(f.a)).find(row => row[1] === '기존거래');
      assert(legacyCsv); assert.equal(legacyCsv[8], '50000'); assert.equal(legacyCsv[11], '5000'); assert.equal(legacyCsv[12], '55000');
      f.enqueue(documentFixture({
        vendor: '세금 중복 검증', invoiceNo: 'VAT-FALLBACK', subtotal: 50000, tax: 5000, total: 55000,
        items: [{ name: '과세 식자재', spec: '1상자', qty: 1, unit: '상자', price: 50000, supplyAmount: 50000, tax: 5000, amt: 55000, confidence: .95, warnings: [] }],
      }));
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'vat-fallback.png')); await f.idle();
      await f.save(f.a);
      const saved = orderRecords(await f.getRemote()).find(order => order.invoiceNo === 'VAT-FALLBACK');
      assert(saved?.ocrMeta); assert.equal(saved.total, 55000); assert.equal(saved.items[0].supplyAmount, 50000); assert.equal(saved.items[0].amt, 55000);
      const card = f.a.locator('details.card').filter({ has: f.a.locator('summary', { hasText: '세금 중복 검증' }) });
      const total = card.locator('label').filter({ hasText: '이번 납품액' }).locator('input');
      assert.equal(Number((await total.inputValue()).replace(/,/g, '')), 55000); await total.fill(''); await total.press('Tab'); await quiesce(f.a);
      const after = await readState(f.a), cleared = orderRecords(after).find(order => order.id === saved.id);
      assert.equal(cleared.total, null, 'clearing the saved header input invokes its real oSet handler');
      assert.equal(cleared.tax, 5000); assert.equal(cleared.subtotal, 50000); assert.deepEqual(cleared.items, saved.items, 'clearing the header leaves gross, net and row VAT amounts exact');
      assert.deepEqual(protectedState(after), protectedState(before));
      const summary = await card.locator('summary').first().innerText(), exported = (await csvRows(f.a)).find(row => row[2] === 'VAT-FALLBACK');
      assert(exported); assert.equal(exported[8], '55000'); assert.equal(exported[9], '5000'); assert.equal(exported[14], '50000');
      const monthly = await f.a.locator('.kpi').filter({ hasText: '발주 금액 합계' }).locator('b').innerText();
      assert.deepEqual({
        computed: await f.a.evaluate(order => orderAmt(order), cleared),
        displayed: Number(summary.match(/([\d,]+)원\s*$/)[1].replace(/,/g, '')),
        exported: Number(exported[12]), monthly: Number(monthly.replace(/\D/g, '')),
      }, { computed: 55000, displayed: 55000, exported: 55000, monthly: 110000 }, 'gross OCR rows already include VAT: clearing the header must not add its 5000 tax a second time');
    });
    await run('MISSING_DATE_USES_PHOTO_START_DATE_WHEN_MONTH_CHANGES', async f => {
      await f.a.evaluate(() => { S.month = '2026-10'; orderRange.mode = 'day'; selDay = 12; render(); });
      const fallback = await f.a.evaluate(() => rangeDate()); assert.equal(fallback, '2026-10-12');
      const pending = f.enqueue(documentFixture({ date: null, warnings: ['날짜 확인 필요'] }), { hold: true });
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'undated.png'));
      await f.a.waitForFunction(() => invoiceOcr.busy);
      await f.a.waitForTimeout(100);
      await f.a.evaluate(() => { S.month = '2026-11'; selDay = 3; render(); });
      pending.release(); await f.idle();
      const added = orderRecords(await readState(f.a)).find(order => order.invoiceNo === 'T-100');
      assert.equal(added.date, fallback); assert.equal((await readState(f.a)).month, '2026-10');
      assert.equal(await orderCard(f.a, added.id).locator('[data-order-field="date"]').inputValue(), fallback, 'missing OCR date uses the captured start date, not the currently selected month');
      assert.match(added.note, /날짜|거래일/); assert(added.warnings.some(warning => /날짜|거래일/.test(warning)), 'missing-date uncertainty remains visible and saved');
    });
    await run('FAILED_OCR_PRESERVES_REGISTERED_ORDERS_AND_SHOWS_INCOMPLETE_PROGRESS', async f => {
      f.enqueue(); await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'good.png')); await f.idle();
      await quiesce(f.a); const before = await readState(f.a), commits = f.commits.length;
      f.enqueue(undefined, { status: 503, error: '검증 인식 서비스 일시 실패' });
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'failed.png', '#e45628')); await f.idle();
      assert.deepEqual((await readState(f.a)).orders, before.orders); assert.equal(f.commits.length, commits, 'failed recognition never writes another invoice');
      assert.match(await f.a.locator('#invoice-progress').innerText(), /실패|오류|다시/);
      assert.deepEqual(protectedState(await readState(f.a)), protectedState(before));
      const failed = await progress(f.a); assert.equal(failed.max, 3); assert(failed.value < 3); assert.equal(failed.state.registered, 0);
    });
    await run('PENDING_RECOGNITION_PROGRESS_AND_EXISTING_NOTE_EDIT_SURVIVE', async f => {
      await f.a.evaluate(() => { S.month = '2026-09'; go('order'); });
      const pending = f.enqueue(documentFixture({ invoiceNo: 'PENDING-1' }), { hold: true });
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'pending.png'));
      await f.a.waitForFunction(() => invoiceOcr.busy && invoiceOcr.progress?.step === 1);
      const inFlight = await progress(f.a); assert.equal(inFlight.max, 3); assert.equal(inFlight.value, 1);
      assert.equal(inFlight.state.registered, 0); assert.equal(inFlight.state.completed, 0);
      assert.equal(orderRecords(await readState(f.a)).length, 1, 'pending provider request never creates a placeholder order');
      const note = orderCard(f.a, existingId).locator('[data-order-field="note"]'), original = await note.elementHandle();
      await note.fill('다른 명세서를 수정 중\n결제는 다음 주');
      assert.equal(orderRecords(await readState(f.a))[0].note, '다른 명세서를 수정 중\n결제는 다음 주');
      assert.equal(await original.evaluate(el => el.isConnected && document.activeElement === el), true, 'note input does not rerender its own focused DOM');
      pending.release(); await f.idle();
      assert.equal(await original.evaluate(el => el.isConnected && document.activeElement === el), true, 'registration of another photo does not replace the focused existing record');
      assert.equal(await note.inputValue(), '다른 명세서를 수정 중\n결제는 다음 주');
      assert.equal(orderRecords(await readState(f.a)).find(order => order.id === existingId).note, '다른 명세서를 수정 중\n결제는 다음 주');
      const done = await progress(f.a); assert.equal(done.value, 3); assert.equal(done.state.registered, 1);
    });
    await run('LOCAL_STORAGE_FAILURE_RETAINS_MEMORY_RECORD_WITHOUT_CLAIMING_REGISTERED', async f => {
      const before = await readState(f.a), persisted = await f.a.evaluate(() => localStorage.getItem(KEY));
      await f.a.evaluate(() => {
        window.__invoiceOriginalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === KEY) throw new DOMException('offline fixture quota exceeded', 'QuotaExceededError');
          return window.__invoiceOriginalSetItem.call(this, key, value);
        };
      });
      try {
        f.enqueue(); await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'storage-failure.png')); await f.idle(); await quiesce(f.a);
        const after = await readState(f.a), added = orderRecords(after).find(order => order.id !== existingId);
        assert(added, 'recognized fields remain in memory so the user can copy or recover them');
        assert.deepEqual(after.orders['2026-09'].find(order => order.id === existingId), before.orders['2026-09'][0]);
        assert.deepEqual(pick(added, ['date', 'vendor', 'subtotal', 'tax', 'total']), pick(documentFixture(), ['date', 'vendor', 'subtotal', 'tax', 'total']));
        assert.deepEqual(pick(added.items[0], itemKeys), pick(documentFixture().items[0], itemKeys));
        assert.equal(await f.a.evaluate(() => localStorage.getItem(KEY)), persisted, 'failed storage does not replace any durable records');
        const failed = await progress(f.a); assert.equal(failed.value, 2); assert.equal(failed.max, 3);
        assert.equal(failed.state.registered, 0); assert.equal(failed.state.failed, 1);
        assert.match(await f.a.locator('#invoice-progress').innerText(), /저장.*실패|실패.*저장/);
        assert.deepEqual(protectedState(after), protectedState(before));
      } finally { await f.a.evaluate(() => { Storage.prototype.setItem = window.__invoiceOriginalSetItem; }); }
    });
    await run('UNCERTAIN_NULL_AND_MISMATCHED_VALUES_REGISTER_WITH_EDITABLE_WARNINGS', async f => {
      const warnings = ['품목명 일부가 흐림', '수량·단가와 합계가 일치하지 않음', '품목 합계와 이번 납품액 불일치'];
      const document = documentFixture({ vendor: '', subtotal: null, tax: null, total: 77, warnings,
        items: [{ name: '', spec: '', qty: null, unit: '', price: 20, supplyAmount: null, tax: null, amt: 12, confidence: .2, warnings: ['품목과 수량 확인 필요'] }] });
      f.enqueue(document); await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'uncertain.png')); await f.idle();
      const order = orderRecords(await readState(f.a)).find(order => order.id !== existingId); assert(order);
      assert.deepEqual(pick(order, ['date', 'vendor', 'subtotal', 'tax', 'total']), pick(document, ['date', 'vendor', 'subtotal', 'tax', 'total']));
      assert.deepEqual(pick(order.items[0], ['name', 'spec', 'qty', 'unit', 'price', 'supplyAmount', 'tax', 'amt', 'confidence', 'warnings']), document.items[0]);
      for (const warning of warnings) { assert(order.warnings.includes(warning)); assert(order.note.includes(warning)); }
      assert.equal(f.dialogs.length, 0, 'uncertain recognition is stored for correction without blocking auto registration');
      const note = orderCard(f.a, order.id).locator('[data-order-field="note"]');
      assert.equal(await note.evaluate(el => el.tagName), 'TEXTAREA');
      await note.fill('확인 후 직접 고친 특이사항');
      assert.equal(orderRecords(await readState(f.a)).find(row => row.id === order.id).note, '확인 후 직접 고친 특이사항');
      assert.equal(await note.evaluate(el => document.activeElement === el), true);
    });
    await run('SAME_VENDOR_AND_NUMBER_DIFFERENT_PHOTOS_WARN_WITHOUT_CONFIRM_DIALOG', async f => {
      f.enqueue(); f.enqueue();
      await f.a.locator('#invoice-files').setInputFiles([await photo(f.a, 'same-number-a.png'), await photo(f.a, 'same-number-b.png', '#ed7032')]); await f.idle();
      const duplicates = orderRecords(await readState(f.a)).filter(order => order.invoiceNo === 'T-100');
      assert.equal(duplicates.length, 2, 'same printed invoice number does not discard a distinct photograph');
      assert.notEqual(duplicates[0].id, duplicates[1].id);
      assert.equal(f.dialogs.length, 0, 'duplicate number is a warning rather than a confirmation gate');
      assert(duplicates.some(order => /같은|동일|중복/.test(order.note)), 'potential duplicate invoice number appears in saved special notes');
    });
    await run('NUMERIC_FIELDS_PRESERVE_FULL_LARGE_AND_DECIMAL_VALUES_DESKTOP_AND_MOBILE', async f => {
      f.enqueue(documentFixture({ total: 1000000000000, subtotal: 1000000000000, tax: null,
        items: [{ name: '큰 숫자 검증', spec: '소수 검증', qty: .125, unit: 'kg', price: 1000000000000, supplyAmount: 1000000000000, tax: null, amt: 1000000000000, confidence: .95, warnings: [] }] }));
      await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'large-number.png')); await f.idle();
      const order = orderRecords(await readState(f.a)).find(order => order.id !== existingId);
      for (const width of [1280, 390]) {
        await f.a.setViewportSize({ width, height: 1000 }); await f.a.waitForTimeout(60);
        const card = await selectOrder(f.a, order.id);
        await f.a.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        const values = [card.locator('[data-order-field="total"]'), card.locator('[data-order-item]').first().locator('[data-order-key="price"]'), card.locator('[data-order-item]').first().locator('[data-order-key="qty"]')];
        for (const input of values) {
          assert.equal(await input.getAttribute('type'), 'text'); assert.equal(await input.getAttribute('inputmode'), 'decimal');
          assert((await input.getAttribute('class')).includes('invoice-number')); assert.equal(await input.getAttribute('maxlength'), null);
          assert.equal(await input.isVisible(), true);
          const fit = await numberFit(input);
          if (fit.text > fit.available + 1 && process.env.NMF_INVOICE_UI_ARTIFACT_DIR) {
            await f.a.screenshot({ path: path.join(process.env.NMF_INVOICE_UI_ARTIFACT_DIR, 'numeric-' + width + '-' + fit.field + '.png'), fullPage: true });
          }
          assert(fit.text <= fit.available + 1, 'all digits must fit in the visible field at viewport ' + width + ': ' + JSON.stringify(fit));
        }
        assert.equal(Number((await values[0].inputValue()).replace(/,/g, '')), 1000000000000);
        const price = values[1]; await price.fill('123456789.123456'); assert.equal(await price.inputValue(), '123456789.123456');
        await price.press('Tab');
        assert.equal(orderRecords(await readState(f.a)).find(row => row.id === order.id).items[0].price, 123456789.123456, 'decimal edit remains exact in state');
        assert.equal(Number((await price.inputValue()).replace(/,/g, '')), 123456789.123456, 'decimal is not shortened when the input rerenders');
        assert.equal(orderRecords(await readState(f.a)).find(row => row.id === order.id).items[0].amt, 1000000000000, 'unit price editing never recalculates the printed amount');
        if (process.env.NMF_INVOICE_UI_ARTIFACT_DIR) await f.a.screenshot({ path: path.join(process.env.NMF_INVOICE_UI_ARTIFACT_DIR, 'numeric-success-' + width + '.png'), fullPage: true });
      }
    });
    await run('INVOICE_TABS_SELECT_EXPAND_KEEP_DOM_AND_SUPPORT_KEYBOARD_MOBILE', async f => {
      f.enqueue(documentFixture({ date: '2026-09-30', vendor: '탭 첫째', invoiceNo: 'TAB-1' }));
      f.enqueue(documentFixture({ date: '2026-09-29', vendor: '탭 둘째', invoiceNo: 'TAB-2' }));
      await f.a.locator('#invoice-files').setInputFiles([await photo(f.a, 'tab-first.png'), await photo(f.a, 'tab-second.png', '#eb6127')]); await f.idle();
      const tabs = f.a.getByRole('tablist').getByRole('tab'); assert.equal(await tabs.count(), 3);
      const orders = orderRecords(await readState(f.a));
      for (const width of [1280, 390]) {
        await f.a.setViewportSize({ width, height: 1000 });
        for (const order of orders) {
          const card = await selectOrder(f.a, order.id);
          assert.equal(await card.evaluate(el => el.open), true, 'selecting an invoice expands its detail view');
          assert.equal(await f.a.getByRole('tabpanel').count(), 1, 'only the selected invoice panel is accessible');
          assert.equal(await f.a.locator('[role="tabpanel"][hidden]').count(), 2);
          assert.equal(await f.a.locator('[data-order-id]').count(), 3, 'hidden invoice DOM stays present for stable-ID edit callbacks');
        }
        const first = tabs.first(), last = tabs.last(); await first.click(); await first.press('End');
        assert.equal(await last.getAttribute('aria-selected'), 'true'); assert.equal(await last.evaluate(el => el === document.activeElement), true);
        await last.press('Home'); assert.equal(await first.getAttribute('aria-selected'), 'true');
        await first.press('ArrowRight'); assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
        await tabs.nth(1).press('ArrowLeft'); assert.equal(await first.getAttribute('aria-selected'), 'true');
      }
      assert.equal(f.dialogs.length, 0); assert.deepEqual(protectedState(await readState(f.a)), protectedState(f.base));
    });
    await run('INVOICE_PRINT_TEMPORARILY_EXPANDS_ALL_FILTERED_TABS_AND_RESTORES_SELECTION', async f => {
      f.enqueue(documentFixture({ vendor: '인쇄 첫째', invoiceNo: 'PRINT-1', subtotal: 1000000000000, tax: null, total: 1000000000000,
        items: [{ name: '긴 숫자 인쇄 검증', spec: '', qty: 1, unit: '건', price: 1000000000000, supplyAmount: 1000000000000, tax: null, amt: 1000000000000, confidence: .95, warnings: [] }] }));
      f.enqueue(documentFixture({ vendor: '인쇄 둘째', invoiceNo: 'PRINT-2' }));
      await f.a.locator('#invoice-files').setInputFiles([await photo(f.a, 'print-a.png'), await photo(f.a, 'print-b.png', '#ec652a')]); await f.idle();
      await selectOrder(f.a, existingId);
      const before = await f.a.locator('[role="tabpanel"]').evaluateAll(panels => panels.map(panel => ({ id: panel.id, hidden: panel.hidden, open: panel.querySelector('details').open })));
      const records = await readState(f.a);
      await f.a.emulateMedia({ media: 'print' });
      await f.a.evaluate(() => dispatchEvent(new Event('beforeprint')));
      assert.equal(await f.a.locator('[role="tabpanel"][hidden]').count(), 0, 'printing includes all invoices in the selected date range, not only the active tab');
      for (const panel of await f.a.locator('[role="tabpanel"]').all()) assert.equal(await panel.isVisible(), true);
      assert.equal(await f.a.locator('[data-order-id]').evaluateAll(cards => cards.every(card => card.open)), true);
      await f.a.evaluate(() => dispatchEvent(new Event('afterprint'))); await f.a.emulateMedia({ media: 'screen' });
      assert.deepEqual(await f.a.locator('[role="tabpanel"]').evaluateAll(panels => panels.map(panel => ({ id: panel.id, hidden: panel.hidden, open: panel.querySelector('details').open }))), before);
      assert.equal(await f.a.locator(`[data-order-tab="${existingId}"]`).getAttribute('aria-selected'), 'true');
      assert.deepEqual((await readState(f.a)).orders, records.orders, 'printing never changes invoice records');
      await f.a.setViewportSize({ width: 320, height: 1000 });
      const large = orderRecords(records).find(order => order.invoiceNo === 'PRINT-1'); await selectOrder(f.a, large.id);
      await f.a.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      await f.a.emulateMedia({ media: 'print' }); await f.a.evaluate(() => dispatchEvent(new Event('beforeprint')));
      await f.a.emulateMedia({ media: 'screen' }); await f.a.evaluate(() => dispatchEvent(new Event('afterprint')));
      await f.a.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const total = orderCard(f.a, large.id).locator('[data-order-field="total"]'), fit = await numberFit(total);
      assert.equal(Number(fit.value.replace(/,/g, '')), 1000000000000);
      assert(fit.text <= fit.available + 1, 'returning from print must refit the full large number at 320px: ' + JSON.stringify(fit));
      assert.deepEqual((await readState(f.a)).orders, records.orders);
    });
    await run('DIRECT_PREPROCESS_AND_API_VERIFICATION_BYPASS_AUTO_REGISTRATION', async f => {
      const before = await readState(f.a), persisted = await f.a.evaluate(() => localStorage.getItem(KEY));
      const upload = await photo(f.a, 'read-only.png'); f.enqueue();
      const result = await f.a.evaluate(async data => {
        const file = new File([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], 'verification-photo', { type: 'image/png' });
        const image = await prepInvoiceImage(file); return invoiceOcrApi('extract', image);
      }, upload.buffer.toString('base64'));
      assert.equal(result.ok, true); assert.deepEqual(result.document, documentFixture());
      assert.equal(f.requests.filter(request => request.body.action === 'extract').length, 1);
      assert.deepEqual(await readState(f.a), before); assert.equal(await f.a.evaluate(() => localStorage.getItem(KEY)), persisted);
      assert.equal(f.commits.length, 0, 'the real verification path can read a photograph without writing an invoice');
    });
    await run('UPLOAD_BOUNDARIES_REJECT_UNSUPPORTED_OVERSIZE_AND_NINE_PHOTOS', async f => {
      const before = await readState(f.a);
      for (const invalid of [
        { name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
        { name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 dummy fixture') },
        { name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(32 * 1024 * 1024 + 1) },
      ]) {
        await f.a.locator('#invoice-files').setInputFiles(invalid); await f.idle();
        assert.equal(f.requests.filter(request => request.body.action === 'extract').length, 0, 'invalid files never leave the browser: ' + invalid.name);
        assert.deepEqual((await readState(f.a)).orders, before.orders);
      }
      const tiny = await photo(f.a, 'tiny.png');
      await f.a.locator('#invoice-files').setInputFiles(Array.from({ length: 9 }, (_, i) => ({ ...tiny, name: 'batch-' + i + '.png' }))); await f.idle();
      assert.equal(f.requests.filter(request => request.body.action === 'extract').length, 0, 'a batch exceeding eight photos is rejected before processing');
      assert.deepEqual((await readState(f.a)).orders, before.orders);
    });
    await run('OCR_TEXT_IS_ESCAPED_AND_ORDER_CSV_NEUTRALIZES_FORMULAS', async f => {
      const malicious = documentFixture({ vendor: '<img src=x onerror="window.__invoiceXss=1">', rawText: '</textarea><img src=x onerror="window.__invoiceXss=2">' });
      malicious.items[0].name = '<img src=x onerror="window.__invoiceXss=3">';
      f.enqueue(malicious); await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'escaping.png')); await f.idle();
      const added = orderRecords(await readState(f.a)).find(order => order.id !== existingId);
      assert.equal(await f.a.locator('img[src="x"]').count(), 0); assert.equal(await f.a.evaluate(() => window.__invoiceXss), undefined);
      const panel = orderCard(f.a, added.id);
      await panel.locator('[data-order-field="vendor"]').fill('=2+2'); await panel.locator('[data-order-field="vendor"]').press('Tab');
      await panel.locator('[data-order-item]').first().locator('[data-order-key="name"]').fill('@SUM(1+1)'); await panel.locator('[data-order-item]').first().locator('[data-order-key="name"]').press('Tab');
      assert.equal(await f.a.locator('img[src="x"]').count(), 0); assert.equal(await f.a.evaluate(() => window.__invoiceXss), undefined);
      const cells = (await csvRows(f.a)).flat();
      assert(cells.includes("'=2+2"), 'actual order CSV prefixes a supplier formula with an apostrophe');
      assert(cells.includes("'@SUM(1+1)"), 'actual order CSV prefixes an item formula with an apostrophe');
      assert(!cells.includes('=2+2') && !cells.includes('@SUM(1+1)'));
      assert(cells.includes('30000'), 'printed item amount remains exact in CSV');
    });
    await run('STALE_ORDER_ADDITIONS_MERGE_AND_TOMBSTONES_PREVENT_REVIVAL', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer();
      await b.evaluate(() => { oAdd(); oSet(0, 'vendor', 'PC B 신규 공급자'); });
      const peerAdded = orderRecords(await readState(b)).find(order => order.id !== existingId); assert.match(peerAdded.id, uuid);
      await f.save(b);
      await f.a.evaluate(() => { oAdd(); oSet(0, 'vendor', 'PC A 신규 공급자'); });
      const localAdded = orderRecords(await readState(f.a)).find(order => order.id !== existingId); assert.match(localAdded.id, uuid);
      await f.save(f.a); const merged = await f.getRemote();
      assert.deepEqual(orderRecords(merged), [f.base.orders['2026-09'][0], peerAdded, localAdded].sort((a, b) => a.id.localeCompare(b.id)), 'a stale PC adds its own order without erasing another PC order');
      await b.evaluate(id => { S.month = '2026-09'; go('order'); oDel(ordersOf().findIndex(order => order.id === id)); }, existingId);
      await f.save(b); assert.equal((await f.getRemote()).orderEdits[existingId].deleted, true);
      await f.a.evaluate(() => { S.settings.target = .12; save(); }); await f.save(f.a);
      const deleted = await f.getRemote();
      assert.equal(orderRecords(deleted).some(order => order.id === existingId), false, 'a stale client cannot resurrect an explicitly deleted order');
      assert.equal(deleted.orderEdits[existingId].deleted, true); assert.equal(orderRecords(deleted).length, 2);
      assert.deepEqual(deleted.staff, f.base.staff); assert.deepEqual(deleted.roster, f.base.roster);
    });
    await run('TWO_PCS_AUTO_REGISTERING_SAME_PHOTO_SAVE_ONE_INVOICE_AND_HONOR_DELETE', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer();
      f.enqueue(); await f.a.locator('#invoice-files').setInputFiles(await photo(f.a, 'pc-a.png')); await f.idle(); await quiesce(f.a);
      f.enqueue(); await b.locator('#invoice-files').setInputFiles(await photo(b, 'pc-b.png')); await f.idle(b); await quiesce(b);
      const aOrder = orderRecords(await readState(f.a)).find(order => order.id !== existingId), bOrder = orderRecords(await readState(b)).find(order => order.id !== existingId);
      assert(aOrder && bOrder, 'both stale PCs independently registered the photograph');
      assert.equal(aOrder.ocrMeta.imageSha256, bOrder.ocrMeta.imageSha256, 'both stale PCs received the exact same processed photo bytes');
      await f.save(f.a); await f.save(b);
      const merged = await f.getRemote(), invoices = orderRecords(merged).filter(order => order.ocrMeta?.imageSha256 === aOrder.ocrMeta.imageSha256);
      assert.equal(invoices.length, 1, 'two independent automatic registrations create one shared invoice, never two random-ID copies');
      assert.equal(orderRecords(merged).length, 2); assert.equal(invoices[0].total, 33000);
      assert.equal(await f.a.evaluate(order => orderAmt(order), invoices[0]), 33000, 'deduplication cannot double the invoice total');
      const id = invoices[0].id;
      await b.evaluate(id => { S.month = '2026-09'; go('order'); oDel(ordersOf().findIndex(order => order.id === id)); }, id);
      await f.save(b);
      await f.a.evaluate(() => { S.settings.target = .12; save(); }); await f.save(f.a);
      const deleted = await f.getRemote();
      assert.equal(orderRecords(deleted).filter(order => order.ocrMeta?.imageSha256 === aOrder.ocrMeta.imageSha256).length, 0, 'a stale unchanged copy cannot resurrect the deleted photo invoice');
      assert.equal(deleted.orderEdits[id].deleted, true);
      assert.deepEqual(orderRecords(deleted), orderRecords(f.base));
    });
    await run('CONCURRENT_SAME_ORDER_EDITS_USE_THE_NEWER_REAL_EDIT_CLOCK', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer();
      for (const page of [f.a, b]) await page.evaluate(() => { S.month = '2026-09'; go('order'); });
      await f.a.evaluate(() => oSet(0, 'note', '먼저 수정한 메모')); await quiesce(f.a);
      const earlier = (await readState(f.a)).orderEdits[existingId].at;
      await b.waitForTimeout(10); await b.evaluate(() => oSet(0, 'note', '나중에 수정한 메모'));
      const later = (await readState(b)).orderEdits[existingId].at;
      assert(Date.parse(later) > Date.parse(earlier), 'the peer edit is actually newer, without inventing a future timestamp');
      await f.save(b); await f.save(f.a);
      assert.equal(orderRecords(await f.getRemote())[0].note, '나중에 수정한 메모', 'conflicting edits to the same invoice use the existing newer-edit clock policy');
    });
    await run('PEER_ORDER_REORDER_CANNOT_REDIRECT_AN_UNBLURRED_EDIT_TO_ANOTHER_UUID', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true);
      await f.a.evaluate(() => { S.month = '2026-09'; go('order'); });
      const existingCard = f.a.locator('details.card').filter({ has: f.a.locator('summary', { hasText: '기존거래' }) });
      const vendor = existingCard.locator('input[placeholder="공급업체"]');
      await vendor.fill('원래 발주에 입력한 교정');
      const peer = clone(await f.getRemote()), added = { id: '00000000-0000-4000-8000-000000000004', date: '2026-09-29', vendor: '다른 PC가 추가한 발주', note: '', items: [], ocr: '' };
      peer.orders['2026-09'].push(added); await f.put(peer, '2026-10-21T00:00:00.000Z');
      await f.save(f.a);
      assert.equal(await vendor.inputValue(), '원래 발주에 입력한 교정', 'cloud reconciliation keeps the raw focused field while the underlying order list is reordered');
      await vendor.press('Tab'); await f.save(f.a);
      const committed = await f.getRemote();
      assert.equal(orderRecords(committed).find(order => order.id === existingId).vendor, '원래 발주에 입력한 교정', 'the old DOM callback targets the originally edited order UUID');
      assert.deepEqual(orderRecords(committed).find(order => order.id === added.id), added, 'the newly inserted peer order is never overwritten by the stale DOM index');
    });
    await run('PEER_LINE_PREPEND_CANNOT_REDIRECT_AN_UNBLURRED_EDIT_TO_ANOTHER_ITEM_ID', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true);
      await f.a.evaluate(() => { S.month = '2026-09'; go('order'); });
      const before = await readState(f.a), original = clone(before.orders['2026-09'][0].items[0]);
      assert.equal(typeof original.id, 'string', 'legacy invoice lines receive a stable identity before they are rendered');
      const existingCard = f.a.locator('details.card').filter({ has: f.a.locator('summary', { hasText: '기존거래' }) });
      const itemName = existingCard.locator('input[aria-label="품목"]');
      await itemName.fill('원래 품목에 입력한 교정');
      const peer = clone(await f.getRemote());
      const added = { id: 'peer-line-fixture', name: '다른 PC가 앞에 추가한 품목', spec: '1봉', qty: 1, unit: '봉', price: 1000, amt: 1000 };
      peer.orders['2026-09'][0].items.unshift(added);
      peer.orderEdits[existingId] = { at: new Date().toISOString(), deleted: false };
      await f.put(peer, new Date().toISOString()); await f.save(f.a);
      assert.equal(await itemName.inputValue(), '원래 품목에 입력한 교정', 'cloud reconciliation preserves the focused raw field while the underlying item list changes');
      assert.equal(await itemName.evaluate(input => document.activeElement === input), true, 'the item edit remains unblurred until after the peer line is merged');
      const reconciled = orderRecords(await readState(f.a)).find(order => order.id === existingId);
      assert.equal(reconciled.items[0].id, added.id, 'the peer line actually precedes the original item in application state');
      await itemName.press('Tab'); await f.save(f.a);
      const committed = await f.getRemote(), order = orderRecords(committed).find(order => order.id === existingId);
      assert.deepEqual(order.items.find(item => item.id === original.id), { ...original, name: '원래 품목에 입력한 교정' }, 'the old DOM callback saves the raw correction to the originally edited item ID');
      assert.deepEqual(order.items.find(item => item.id === added.id), added, 'the prepended peer item is never overwritten by a stale row index');
      assert.equal(order.items.length, 2); assert.deepEqual(protectedState(committed), protectedState(before));
    });
    await run('ORDER_EDITS_DURING_ENCRYPTION_KEEP_EXACT_SENT_BASELINE', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true);
      await f.a.evaluate(id => {
        S.month = '2026-09'; go('order'); const index = ordersOf().findIndex(order => order.id === id);
        oSet(index, 'note', '암호화 전 메모');
        const original = encryptText;
        encryptText = async (pw, text) => {
          const encrypted = await original(pw, text);
          if (window.__invoiceLateEdit) { window.__invoiceLateEdit = false; oSet(index, 'note', '암호화 중 추가 메모'); }
          return encrypted;
        };
        window.__invoiceLateEdit = true;
      }, existingId);
      await f.save(f.a); const sent = await f.getRemote();
      assert.equal(orderRecords(sent)[0].note, '암호화 전 메모');
      assert.equal(orderRecords(await readState(f.a))[0].note, '암호화 중 추가 메모');
      const peer = clone(sent); peer.orders['2026-10'] ||= [];
      peer.orders['2026-10'].push({ id: '00000000-0000-4000-8000-000000000003', date: '2026-10-11', vendor: '암호화 후 다른 PC 추가', note: '', items: [], ocr: '' });
      await f.put(peer, '2026-10-20T00:00:00.000Z'); await f.save(f.a);
      const committed = await f.getRemote();
      assert.equal(orderRecords(committed).find(order => order.id === existingId).note, '암호화 중 추가 메모', 'a late local edit remains pending instead of being mistaken for the older already-sent snapshot');
      assert.deepEqual(orderRecords(committed).find(order => order.id !== existingId), peer.orders['2026-10'][0], 'an unrelated peer order survives while the local late edit is saved');
    });
    await run('EXPLICIT_ORDER_BACKUP_RESTORE_REPLACES_LIST_THEN_NORMAL_SYNC_RESUMES', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer();
      await b.evaluate(() => { oAdd(); oSet(0, 'vendor', '복원 이전 서버 추가'); }); await f.save(b);
      await f.a.evaluate(backup => { applyState(backup, true); save(); }, f.base);
      await f.save(f.a);
      assert.deepEqual(orderRecords(await f.getRemote()), orderRecords(f.base), 'explicitly selected backup replaces the order list even if it equals the old cloud baseline');
      assert.deepEqual((await f.getRemote()).staff, f.base.staff); assert.deepEqual((await f.getRemote()).roster, f.base.roster);
      const later = clone(await f.getRemote());
      later.orders['2026-10'].push({ id: '00000000-0000-4000-8000-000000000003', date: '2026-10-11', vendor: '복원 후 서버 추가', note: '', items: [], ocr: '' });
      await f.put(later, '2026-10-22T00:00:00.000Z'); await f.a.evaluate(() => { S.settings.target = .12; save(); }); await f.save(f.a);
      assert.deepEqual(orderRecords(await f.getRemote()), orderRecords(later), 'completed replacement intent is consumed and subsequent unrelated saves retain new peer orders');
    });
    console.log('INVOICE_UI_RESULTS ' + JSON.stringify({ passed, failed: failures.map(failure => failure.name) }));
    assert(passed.length + failures.length > 0, 'the selected scenario must actually execute');
    if (failures.length) throw new AggregateError(failures.map(failure => failure.error), 'Invoice UI regressions: ' + failures.length);
  } finally {
    console.log('APP_SOURCE_SHA256 ' + createHash('sha256').update(source).digest('hex'));
    if (negativeControl) console.log('DISPOSABLE_NEGATIVE_CONTROL ' + negativeControl + ' SOURCE_FILE_SHA256 ' + sourceFileHash);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
