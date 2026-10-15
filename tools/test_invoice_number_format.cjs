// Offline invoice numeric-display regressions. All requests are intercepted.
// NMF_NUMBER_UI_SOURCE can select an authentic baseline; optional NMF_NUMBER_UI_SCENARIO filters named cases.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const sourcePath = process.env.NMF_NUMBER_UI_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html');
const source = fs.readFileSync(sourcePath, 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const orderId = 'offline-number-order', itemId = 'offline-number-item';
const card = page => page.locator(`[data-order-id="${orderId}"]`);
const header = (page, key) => card(page).locator(`[data-order-field="${key}"]`);
const item = (page, key) => card(page).locator(`[data-order-item="${itemId}"] [data-order-key="${key}"]`);
const clone = value => structuredClone(value);
function orderFixture(overrides = {}) {
  return { id: orderId, date: '2026-10-11', vendor: '숫자검증유통', invoiceNo: '12345678', note: '보존할 메모',
    subtotal: 1234567, tax: 123456, total: 1358023, previousBalance: 2345678, balanceTotal: 3703701,
    items: [{ id: itemId, name: '숫자 검증 품목', spec: '1000ml', qty: 1234.5, unit: '1000ml', price: 234567,
      supplyAmount: 1234567, tax: 123456, amt: 1358023 }],
    ocr: '오프라인 고정 숫자 검증 원문', ocrMeta: { model: 'offline-ocr-fixture', autoRegistered: true }, ...overrides };
}

async function fixture(browser) {
  const errors = [], requests = [];
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(() => {
    localStorage.setItem('nmf_app', 'food');
    localStorage.setItem('nmf_supa_food', JSON.stringify({ url: '', key: '' }));
    sessionStorage.setItem('nmf_session_pw', 'offline-number-fixture-password');
  });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error));
  page.on('dialog', dialog => dialog.accept());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); requests.push({ url: request.url(), method: request.method() });
    try {
      if (request.isNavigationRequest()) {
        assert.equal(url.origin, 'https://offline.namofood.test');
        return route.fulfill({ contentType: 'text/html', body: source });
      }
      if (url.pathname === '/functions/v1/nmf-recipe-fill') return route.fulfill({ json: { ok: true, running: null, runs: [], last: null } });
      return route.abort();
    } catch (error) { errors.push(error); return route.abort(); }
  });
  const quiesce = () => page.evaluate(() => { clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); });
  try {
    await page.goto('https://offline.namofood.test/');
    const setOrder = async (order = orderFixture()) => {
      await quiesce();
      await page.evaluate(order => {
        const state = normalize(defaultState()); state.month = '2026-10';
        state.orders = { '2026-10': [order] }; state.orderEdits = {};
        S = normalize(state); orderRange.mode = 'month'; orderView = 'sheet'; invoiceSelectedDate = null; oSelected = order.id;
        go('order'); localStorage.setItem(KEY, JSON.stringify(S));
      }, order);
    };
    await setOrder();
    const readOrder = () => page.evaluate(id => structuredClone(orderRef(id).order), orderId);
    const blur = async input => { await input.evaluate(el => el.blur()); };
    const check = () => { if (errors.length) throw errors[0]; };
    return { page, context, requests, setOrder, readOrder, blur, quiesce, check,
      close: async () => { await quiesce(); await context.close(); } };
  } catch (error) { await context.close(); throw error; }
}

async function expectInput(input, expected, label) { assert.equal(await input.inputValue(), expected, label); }
async function csvRows(page) {
  const downloading = page.waitForEvent('download');
  await page.locator('button').filter({ hasText: 'CSV(엑셀) 내려받기' }).click();
  const download = await downloading, stream = await download.createReadStream(), chunks = [];
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
    if (process.env.NMF_NUMBER_UI_SCENARIO && !name.includes(process.env.NMF_NUMBER_UI_SCENARIO)) return;
    let f;
    try { f = await fixture(browser); await scenario(f); f.check(); passed.push(name); console.log('PASS ' + name); }
    catch (error) { failures.push({ name, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); }
    finally { if (f) await f.close(); }
  }
  try {
    await run('ALL_ITEM_AND_HEADER_NUMBERS_SHOW_THOUSANDS_COMMAS', async f => {
      for (const [key, expected] of Object.entries({ qty: '1,234.5', price: '234,567', supplyAmount: '1,234,567', tax: '123,456', amt: '1,358,023' })) {
        await expectInput(item(f.page, key), expected, 'item ' + key + ' groups integer thousands');
        assert.equal(await item(f.page, key).getAttribute('type'), 'text');
      }
      for (const [key, expected] of Object.entries({ subtotal: '1,234,567', tax: '123,456', total: '1,358,023', previousBalance: '2,345,678', balanceTotal: '3,703,701' })) {
        await expectInput(header(f.page, key), expected, 'header ' + key + ' groups integer thousands');
        assert.equal(await header(f.page, key).getAttribute('type'), 'text');
      }
    });
    await run('NEGATIVE_DECIMAL_ZERO_AND_NULL_VALUES_DISPLAY_WITHOUT_ROUNDING', async f => {
      await f.setOrder(orderFixture({ subtotal: -1234567.125, tax: 0, total: null, previousBalance: -987654.5, balanceTotal: 1000.001,
        items: [{ id: itemId, name: '검증', qty: -1234.125, unit: 'kg', price: 0, supplyAmount: null, tax: -1234.5, amt: 1000.001 }] }));
      for (const [key, expected] of Object.entries({ qty: '-1,234.125', price: '0', supplyAmount: '', tax: '-1,234.5', amt: '1,000.001' })) await expectInput(item(f.page, key), expected, key);
      for (const [key, expected] of Object.entries({ subtotal: '-1,234,567.125', tax: '0', total: '', previousBalance: '-987,654.5', balanceTotal: '1,000.001' })) await expectInput(header(f.page, key), expected, key);
      const row = await f.readOrder(); assert.equal(row.items[0].qty, -1234.125); assert.equal(row.balanceTotal, 1000.001); assert.equal(row.total, null);
    });
    await run('LONG_GROUPED_NUMBERS_REMAIN_READABLE_AND_NUMERIC', async f => {
      await f.setOrder(orderFixture({ total: 1000000000000, items: [{ id: itemId, name: '긴 숫자', qty: 1234567890.125, unit: 'kg', price: 1000000000000, amt: 999999999999 }] }));
      await expectInput(header(f.page, 'total'), '1,000,000,000,000', 'long total is fully grouped');
      await expectInput(item(f.page, 'qty'), '1,234,567,890.125', 'long quantity does not lose decimal precision');
      await expectInput(item(f.page, 'price'), '1,000,000,000,000', 'long price is fully grouped');
      await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const input of [header(f.page, 'total'), item(f.page, 'qty'), item(f.page, 'price')]) {
        const fit = await input.evaluate(el => {
          const style = getComputedStyle(el), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
          context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
          return { text: context.measureText(el.value).width, available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
        });
        assert(fit.text <= fit.available + 2, 'grouped long text fits its numeric input: ' + JSON.stringify(fit));
      }
      assert.equal((await f.readOrder()).total, 1000000000000);
    });
    await run('DISPLAY_PRESERVES_NUMERIC_STATE_AND_CALC_FIELDS_FORMAT_AND_PARSE', async f => {
      const before = await f.readOrder(); await f.page.evaluate(() => render());
      const after = await f.readOrder(); assert.deepEqual(after, before);
      const persisted = await f.page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).orders['2026-10'][0]);
      assert.deepEqual(persisted, before);
      for (const key of ['subtotal', 'tax', 'total', 'previousBalance', 'balanceTotal']) assert.equal(typeof after[key], 'number', key + ' remains a number');
      for (const key of ['qty', 'price', 'supplyAmount', 'tax', 'amt']) assert.equal(typeof after.items[0][key], 'number', key + ' remains a number');
      await f.page.evaluate(() => {
        S.menus['2026-10'] = { '11|중식|0': '숫자검증식단', '11|중식|n': '1' };
        S.recipes = [{ menu: '숫자검증식단', item: '계산검증재료', qty: 1, unit: 'kg', loss: 0 }];
        S.orderAdj['2026-10'] = { 계산검증재료: 1234.75 }; S.prices.계산검증재료 = { price: 234567 };
        S.extraOrders['2026-10'] = [{ item: '추가검증품목', qty: 1234.75, unit: 'kg', price: 234567, vendor: '', note: '' }];
        orderView = 'calc'; render();
      });
      const adjustment = f.page.locator('input[placeholder="±"]');
      const extras = f.page.locator('tbody tr').filter({ has: f.page.locator('input[placeholder="품목"]') });
      const extraQty = extras.locator('input').nth(1), extraPrice = extras.locator('input[placeholder="단가"]');
      await expectInput(adjustment, '1,234.75', 'calc adjustment permits grouped fractional quantities without step rounding');
      await expectInput(extraQty, '1,234.75', 'extra-order quantity uses the same grouping');
      await expectInput(extraPrice, '234,567', 'extra-order price is grouped');
      assert.equal(await adjustment.getAttribute('type'), 'text'); assert.equal(await extraQty.getAttribute('type'), 'text');
      await adjustment.fill('2,345.75'); await f.blur(adjustment);
      await extraQty.fill('3,456.75'); await f.blur(extraQty);
      await extraPrice.fill('456,789'); await f.blur(extraPrice);
      const calcState = await f.page.evaluate(() => ({ adj: S.orderAdj['2026-10'].계산검증재료, extra: structuredClone(S.extraOrders['2026-10'][0]) }));
      assert.equal(calcState.adj, 2345.75); assert.equal(typeof calcState.adj, 'number');
      assert.equal(calcState.extra.qty, 3456.75); assert.equal(calcState.extra.price, 456789);
      assert.equal(typeof calcState.extra.qty, 'number'); assert.equal(typeof calcState.extra.price, 'number');
      await extraPrice.fill('10,000,000,000,000'); await f.blur(extraPrice);
      const unrestrictedPrice = await f.page.evaluate(() => S.extraOrders['2026-10'][0].price);
      assert.equal(unrestrictedPrice, 10000000000000, 'calculation prices retain their previous range beyond the invoice OCR amount limit');
      assert.equal(typeof unrestrictedPrice, 'number');
      await expectInput(extraPrice, '10,000,000,000,000', 'large calculation price retains its full grouped display');
    });
    await run('KEYBOARD_TYPING_GROUPS_LIVE_AND_PRESERVES_FOCUS_AND_FRACTION', async f => {
      const input = item(f.page, 'price'); await input.fill('');
      await input.pressSequentially('1234567.50');
      await expectInput(input, '1,234,567.50', 'typing formats the integer part while retaining a typed fraction');
      assert.equal(await input.evaluate(el => document.activeElement === el), true, 'formatting cannot move focus');
      assert.equal(await input.evaluate(el => el.selectionStart), '1,234,567.50'.length, 'typing cursor stays at the end');
      await f.blur(input);
      assert.equal((await f.readOrder()).items[0].price, 1234567.5);
      await expectInput(item(f.page, 'price'), '1,234,567.5', 'blur renders the committed numeric value');
    });
    await run('MIDDLE_DIGIT_EDIT_PRESERVES_NUMERIC_CARET_POSITION', async f => {
      await f.setOrder(orderFixture({ items: [{ id: itemId, name: '검증', qty: 1, unit: 'ea', price: 1000, amt: 1234567 }] }));
      const input = item(f.page, 'amt'); await expectInput(input, '1,234,567'); await input.focus();
      await input.evaluate(el => el.setSelectionRange(2, 2)); await input.press('8');
      await expectInput(input, '18,234,567', 'insertion changes the intended digit position');
      assert.equal(await input.evaluate(el => el.value.slice(0, el.selectionStart).replace(/,/g, '').length), 2, 'caret follows the inserted digit after regrouping');
      await input.press('9'); await expectInput(input, '189,234,567', 'next insertion remains at the same logical position');
      assert.equal(await input.evaluate(el => document.activeElement === el), true); await f.blur(input);
      assert.equal((await f.readOrder()).items[0].amt, 189234567);
    });
    await run('CLIPBOARD_PASTE_UNGROUPED_DECIMAL_FORMATS_AND_COMMITS_NUMERIC', async f => {
      const input = header(f.page, 'previousBalance'); await input.fill('');
      await f.page.evaluate(() => navigator.clipboard.writeText('9876543.21'));
      await input.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      await expectInput(input, '9,876,543.21', 'native clipboard paste is grouped');
      assert.equal(await input.evaluate(el => document.activeElement === el), true);
      await f.blur(input); const row = await f.readOrder(); assert.equal(row.previousBalance, 9876543.21); assert.equal(typeof row.previousBalance, 'number');
    });
    await run('PARTIAL_SIGN_AND_TRAILING_DECIMAL_SURVIVE_ACTIVE_EDIT', async f => {
      const input = header(f.page, 'tax'); await input.fill('-');
      await expectInput(input, '-', 'a partial negative sign remains editable');
      await input.pressSequentially('1234.'); await expectInput(input, '-1,234.', 'grouping does not discard the unfinished decimal point');
      await input.press('5'); await expectInput(input, '-1,234.5');
      assert.equal(await input.evaluate(el => document.activeElement === el), true); await f.blur(input);
      assert.equal((await f.readOrder()).tax, -1234.5);
    });
    await run('COMMIT_GROUPED_NEGATIVE_DECIMAL_ZERO_AND_EMPTY_WITH_NUMERIC_TYPES', async f => {
      for (const [key, text, expected, display] of [['subtotal', '-1,234,567.125', -1234567.125, '-1,234,567.125'], ['tax', '0', 0, '0'], ['total', '', null, '']]) {
        const input = header(f.page, key); await input.fill(text); await f.blur(input);
        const row = await f.readOrder(); assert.equal(row[key], expected); if (expected !== null) assert.equal(typeof row[key], 'number');
        await expectInput(header(f.page, key), display);
      }
      const input = item(f.page, 'qty'); await input.fill('-1,234.125'); await f.blur(input);
      assert.equal((await f.readOrder()).items[0].qty, -1234.125); await expectInput(item(f.page, 'qty'), '-1,234.125');
    });
    await run('BACKGROUND_REPAINT_DEFERS_WHILE_ACTIVE_INPUT_AND_COMMITS_ON_BLUR', async f => {
      const input = header(f.page, 'total'); await input.fill('987654');
      await input.evaluate(el => { window.__numberEditingNode = el; el.setSelectionRange(3, 3); });
      const activeValue = await input.inputValue(), activeCaret = await input.evaluate(el => el.selectionStart);
      await f.page.evaluate(() => { invoiceOcr.status = '오프라인 배경 상태 변경'; invoicePaint(); });
      assert.equal(await input.evaluate(el => window.__numberEditingNode === el && el.isConnected && document.activeElement === el), true, 'background completion cannot replace the active editing node');
      await expectInput(input, activeValue); assert.equal(await input.evaluate(el => el.selectionStart), activeCaret);
      await f.blur(input); assert.equal((await f.readOrder()).total, 987654);
      await expectInput(header(f.page, 'total'), '987,654', 'blur shows the committed value after deferred repaint');
    });
    await run('DATE_UNIT_INVOICE_NUMBER_AND_CARD_LAST4_NOT_COMMA_FORMATTED', async f => {
      await expectInput(header(f.page, 'date'), '2026-10-11'); await expectInput(header(f.page, 'invoiceNo'), '12345678');
      await expectInput(item(f.page, 'unit'), '1000ml'); await expectInput(item(f.page, 'spec'), '1000ml');
      await f.page.evaluate(() => {
        S.cardTransactions['2026-10'] = [{ id: 'offline-number-card', date: '2026-10-11', time: '12:34', merchant: '오프라인 검증 가맹점', amount: 12345, status: 'approved', cardLabel: '검증카드', last4: '1234', approvalNo: '12345678', installment: '일시불', note: '', warnings: [] }];
        normalizeCards(S); orderView = 'card'; render();
      });
      await expectInput(f.page.locator('[data-card-field="last4"]'), '1234');
      await expectInput(f.page.locator('[data-card-field="approvalNo"]'), '12345678');
      await expectInput(f.page.locator('[data-card-field="date"]'), '2026-10-11');
      assert.equal(await f.page.locator('[data-card-field="last4"]').getAttribute('maxlength'), '4');
    });
    await run('CSV_EXPORT_RETAINS_RAW_NUMBERS_AND_UNCHANGED_IDENTIFIER_TEXT', async f => {
      const before = await f.readOrder(), rows = await csvRows(f.page); assert.equal(rows.length, 2);
      const exported = Object.fromEntries(rows[0].map((label, index) => [label, rows[1][index]]));
      assert.deepEqual(Object.fromEntries(['수량', '단가', '품목 금액', '품목 세액', '공급가 합계', '세액 합계', '명세서 총액', '품목 공급가액', '이전 미수금', '미수 포함 합계'].map(key => [key, exported[key]])),
        { 수량: '1234.5', 단가: '234567', '품목 금액': '1358023', '품목 세액': '123456', '공급가 합계': '1234567', '세액 합계': '123456', '명세서 총액': '1358023', '품목 공급가액': '1234567', '이전 미수금': '2345678', '미수 포함 합계': '3703701' });
      assert.equal(exported.날짜, '2026-10-11'); assert.equal(exported['명세서 번호'], '12345678'); assert.equal(exported.단위, '1000ml');
      assert.deepEqual(await f.readOrder(), before, 'download does not convert saved numbers into comma strings');
    });
    await run('MOBILE_390_LONG_GROUPED_NUMBERS_FIT_WITH_SCROLL_CONFINED_TO_TABLE', async f => {
      await f.page.setViewportSize({ width: 390, height: 844 });
      await f.setOrder(orderFixture({ total: 1000000000000, balanceTotal: 999999999999,
        items: [{ id: itemId, name: '모바일 긴 숫자', qty: 1234567890.125, unit: 'kg', price: 999999999999,
          supplyAmount: 999999999999, tax: 1234567890.125, amt: 999999999999 }] }));
      await expectInput(item(f.page, 'qty'), '1,234,567,890.125');
      await expectInput(item(f.page, 'amt'), '999,999,999,999');
      await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const input of [item(f.page, 'qty'), item(f.page, 'price'), item(f.page, 'supplyAmount'), item(f.page, 'tax'), item(f.page, 'amt'), header(f.page, 'total'), header(f.page, 'balanceTotal')]) {
        const fit = await input.evaluate(el => {
          const style = getComputedStyle(el), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
          context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
          return { value: el.value, field: el.dataset.orderField || el.dataset.orderKey,
            text: context.measureText(el.value).width, available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
        });
        assert(fit.text <= fit.available + 2, 'mobile input shows its complete grouped number: ' + JSON.stringify(fit));
      }
      const layout = await f.page.evaluate(() => {
        const table = document.querySelector('.invoice-panel:not([hidden]) .tbl'), rect = table.getBoundingClientRect();
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
          table: { left: rect.left, right: rect.right, clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, overflow: getComputedStyle(table).overflowX } };
      });
      assert(layout.documentWidth <= layout.viewport + 2 && layout.bodyWidth <= layout.viewport + 2, 'mobile document does not expand horizontally: ' + JSON.stringify(layout));
      assert(layout.table.left >= -2 && layout.table.right <= layout.viewport + 2, 'wide invoice table stays inside the mobile viewport: ' + JSON.stringify(layout));
      assert(['auto', 'scroll'].includes(layout.table.overflow), 'horizontal movement is confined to the existing invoice table scroller');
      assert(layout.table.scrollWidth > layout.table.clientWidth, 'wide columns use the allowed table scroll surface, rather than being clipped');
    });
    await run('PRINT_EVENTS_FORMAT_ALL_NUMBERS_PRESERVE_STATE_AND_RESTORE_PANELS', async f => {
      const second = orderFixture({ id: 'offline-number-second', date: '2026-10-12', vendor: '인쇄검증유통', total: 9876543,
        items: [{ id: 'offline-number-second-item', name: '둘째 인쇄 품목', qty: 7654321.125, unit: 'kg', price: 1234567, supplyAmount: 7654321, tax: 12345, amt: 9876543 }] });
      await f.page.evaluate(second => { S.orders['2026-10'].push(second); normalizeOrders(S); render(); }, second);
      await card(f.page).evaluate(el => { el.open = false; });
      const panels = () => f.page.evaluate(() => [...document.querySelectorAll('.invoice-panel')].map(panel => ({ id: panel.id, hidden: panel.hidden, open: panel.querySelector('details.card').open })));
      const beforePanels = await panels(); assert.equal(beforePanels.length, 2); assert(beforePanels.some(p => p.hidden)); assert(beforePanels.some(p => !p.open));
      const beforeState = await f.page.evaluate(() => structuredClone(S));
      const expectations = await f.page.evaluate(() => [...document.querySelectorAll('.invoice-panel .invoice-number')].map(input => {
        const raw = input.value.replace(/,/g, ''), parts = raw.split('.');
        const grouped = /^-?\d+(?:\.\d*)?$/.test(raw) ? parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts.length > 1 ? '.' + parts[1] : '') : raw;
        input.value = raw; return grouped;
      }));
      await f.page.evaluate(() => dispatchEvent(new Event('beforeprint')));
      const printing = await panels(); assert(printing.every(p => !p.hidden && p.open), 'printing expands every saved invoice panel');
      const printedNumbers = await f.page.locator('.invoice-panel .invoice-number').evaluateAll(inputs => inputs.map(input => input.value));
      assert.deepEqual(printedNumbers, expectations, 'beforeprint formats every quantity, amount, tax, and receivable field');
      assert.deepEqual(await f.page.evaluate(() => structuredClone(S)), beforeState, 'printing is presentation-only and never rewrites stored values');
      await f.page.evaluate(() => dispatchEvent(new Event('afterprint')));
      assert.deepEqual(await panels(), beforePanels, 'afterprint restores each invoice panel visibility and open/closed state');
      assert.deepEqual(await f.page.evaluate(() => structuredClone(S)), beforeState);
    });
    await run('DELETE_AT_COMMA_BOUNDARY_ADVANCES_AND_REMOVES_THE_NEXT_DIGIT', async f => {
      await f.setOrder(orderFixture({ items: [{ id: itemId, name: 'Delete 검증', qty: 1, unit: 'ea', price: 1000, amt: 1234567 }] }));
      const input = item(f.page, 'amt'); await expectInput(input, '1,234,567'); await input.focus();
      await input.evaluate(el => el.setSelectionRange(1, 1));
      await input.press('Delete'); await input.press('Delete');
      await expectInput(input, '134,567', 'Delete cannot repeatedly remove and restore the same grouping comma');
      assert.equal(await input.evaluate(el => document.activeElement === el), true, 'boundary deletion keeps focus on the edited number');
      await f.blur(input); assert.equal((await f.readOrder()).items[0].amt, 134567, 'deletion commits the intended numeric result');
    });
    await run('INVALID_TEXT_IS_NOT_SILENTLY_COMMITTED_AS_ZERO_OR_HEXADECIMAL', async f => {
      for (const value of [',', ',,,', '0x10', '0b10', 'Infinity', 'NaN']) {
        assert.equal(await f.page.evaluate(value => invoiceNumber(value), value), null, 'only finite decimal values can be committed: ' + value);
        await f.setOrder();
        const total = header(f.page, 'total'); await total.fill(value); await f.blur(total);
        assert.equal((await f.readOrder()).total, null, 'invalid header input cannot become an actual amount: ' + value);
        const quantity = item(f.page, 'qty'); await quantity.fill(value); await f.blur(quantity);
        assert.equal((await f.readOrder()).items[0].qty, value.trim() || null, 'quantity-cell text is retained literally, never coerced to zero or hexadecimal: ' + value);
      }
      assert.equal(await f.page.evaluate(() => invoiceNumber('0')), 0, 'explicit zero is still a known numeric value');
      assert.equal(await f.page.evaluate(() => invoiceNumber('-1,234.50')), -1234.5, 'grouped signed decimals retain their numeric value');
    });
  } finally { await browser.close(); }
  console.log(JSON.stringify({ source: sourcePath, sourceSha256, passed: passed.length, failed: failures.length, skipped: 0, failures }));
  assert.equal(createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), sourceSha256, 'tests never modify their source input');
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
