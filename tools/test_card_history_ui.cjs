// Offline card-history UI, privacy and encrypted cloud-save regression; every network request is intercepted.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { chromium } = require('playwright');
let source = fs.readFileSync(process.env.NMF_CARD_UI_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
// Negative controls alter this browser-only source copy, never the app on disk or remote services.
if (process.env.NMF_CARD_UI_NEGATIVE_CONTROL) {
  const controls = {
    'approve-negative': ["conflict=amount!==null&&amount<0&&row.status!=='cancelled'", 'conflict=false'],
    'skip-remote-duplicate': ['      cardReviewRemoteDuplicates(other);', '      /* isolated negative control: skip remote card review */'],
    'overwrite-ocr': ['    else if(l&&r&&lo&&!ro){chosen=r;edit=re;}else if(l&&r&&ro&&!lo){chosen=l;edit=le;}', '    else if(l&&r&&lo&&!ro){chosen=l;edit=le;}else if(l&&r&&ro&&!lo){chosen=r;edit=re;}'],
    'revive-ocr': ['    if(lo&&re?.deleted){edit=re;}else if(ro&&le?.deleted){edit=le;}', '    if(lo&&re?.deleted){chosen=l;edit=le;}else if(ro&&le?.deleted){chosen=r;edit=re;}'],
    'leak-card-text': ["function cardText(value,max=200){return String(value??'')", "function cardText(value,max=200){return String(value??'').trim().slice(0,max);}function cardTextUnused(value,max=200){return String(value??'')"],
  };
  const control = controls[process.env.NMF_CARD_UI_NEGATIVE_CONTROL]; assert(control, 'named negative control exists');
  assert.equal(source.split(control[0]).length - 1, 1, 'negative control targets exactly one card behavior');
  source = source.replace(...control);
  console.log('CARD_UI_NEGATIVE_CONTROL ' + process.env.NMF_CARD_UI_NEGATIVE_CONTROL);
}
const password = 'offline-card-fixture-password';
const clone = value => structuredClone(value);
const seedId = 'card-existing-fixture';
const records = state => Object.values(state.cardTransactions || {}).flat().sort((a, b) => a.id.localeCompare(b.id));
const protectedState = state => Object.fromEntries(Object.entries(state).filter(([key]) => !['month', 'updatedAt', 'cardTransactions', 'cardEdits'].includes(key)));
const readState = page => page.evaluate(() => structuredClone(S));
const quiesce = page => page.evaluate(() => { clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); });
const connect = page => page.evaluate(() => { clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); cloud.url = 'https://offline-cloud.namofood.test'; cloud.key = 'offline-anon-fixture'; cloud.table = 'namofood_state'; cloud.room = 'namofood'; });
const fields = ['date', 'time', 'merchant', 'amount', 'status', 'cardLabel', 'last4', 'approvalNo', 'installment', 'note'];
const pick = object => Object.fromEntries(fields.map(key => [key, object[key]]));
function tx(overrides = {}) { return { date: '2026-09-30', time: '10:30', merchant: '검증식자재', amount: 33000, status: 'approved', cardLabel: '검증카드', last4: '1234', approvalNo: 'C-100', installment: '', note: '정상 승인', warnings: [], ...overrides }; }
function doc(transactions = [tx()]) { return { transactions, warnings: [], rawText: '카드 이용 내역 · 카드번호 1234567890123456' }; }
async function photo(page, name, color = '#e61e50') {
  const data = await page.evaluate(color => { const c = document.createElement('canvas'); c.width = 96; c.height = 72; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 96, 72); return c.toDataURL('image/png').split(',')[1]; }, color);
  return { name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}
async function view(page) { await page.evaluate(() => { orderView = 'card'; go('order'); }); }
async function fixture(browser) {
  const contexts = [], errors = [], requests = [], responses = [], dialogs = [], dialogChoices = [];
  let remote = null;
  async function newPage() {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } }); contexts.push(context);
    await context.addInitScript(password => { localStorage.setItem('nmf_app', 'food'); if (!localStorage.getItem('nmf_supa_food')) localStorage.setItem('nmf_supa_food', JSON.stringify({ url: '', key: '' })); sessionStorage.setItem('nmf_session_pw', password); }, password);
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error));
    page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); if (dialog.type() === 'alert' || dialogChoices.shift() === true) await dialog.accept(); else await dialog.dismiss(); });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        if (request.isNavigationRequest()) { assert.equal(url.origin, 'https://offline-card.namofood.test'); return route.fulfill({ contentType: 'text/html', body: source }); }
        if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/functions/v1/nmf-invoice-ocr') {
          const raw = request.postData(), body = JSON.parse(raw), at = request.headers()['x-nmf-time'];
          assert.equal(request.method(), 'POST'); assert.match(at, /^\d+$/); assert(Math.abs(Date.now() - Number(at)) < 30000);
          const digest = createHash('sha256').update(raw).digest('hex');
          assert.equal(request.headers()['x-nmf-signature'], createHmac('sha256', password).update('nmf-invoice:' + digest + ':' + at).digest('hex'));
          assert.equal(request.headers().apikey, 'offline-anon-fixture'); assert.equal(body.app, 'food'); assert.equal(body.documentType, 'card');
          requests.push(body);
          if (body.action === 'status') return route.fulfill({ json: { ok: true, configured: true, model: 'gpt-6-luna', provider: 'opencode-go', documentTypes: ['invoice', 'card'] } });
          assert.equal(body.action, 'extract'); assert.equal(body.image.mime, 'image/jpeg');
          const planned = responses.shift(); assert(planned, 'each photo has an explicit synthetic response'); if (planned.gate) await planned.gate;
          if (planned.status) return route.fulfill({ status: planned.status, json: { ok: false, error: planned.error } });
          return route.fulfill({ json: { ok: true, documentType: 'card', document: planned.document, model: 'gpt-6-luna', imageSha256: createHash('sha256').update(Buffer.from(body.image.data, 'base64')).digest('hex'), processedAt: '2026-10-11T00:00:00.000Z' } });
        }
        if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/rest/v1/namofood_state') {
          if (request.method() === 'GET') return route.fulfill({ json: remote ? [remote] : [] });
          if (request.method() === 'PATCH') { if (url.searchParams.get('updated_at') !== 'eq.' + remote.updated_at) return route.fulfill({ json: [] }); remote = { id: 'namofood', ...request.postDataJSON() }; return route.fulfill({ json: [{ id: 'namofood' }] }); }
          assert.equal(request.method(), 'POST'); assert(request.postDataJSON().every(row => row.id.startsWith('namofood@'))); return route.fulfill({ json: [] });
        }
        if (url.pathname === '/functions/v1/nmf-recipe-fill') return route.fulfill({ json: { ok: true, running: null, runs: [], last: null } });
        return route.abort();
      } catch (error) { errors.push(error); return route.abort(); }
    });
    await page.goto('https://offline-card.namofood.test/');
    await connect(page);
    return page;
  }
  const a = await newPage();
  const base = await a.evaluate(seedId => {
    const state = normalize(defaultState()); state.month = '2026-09';
    state.orders = { '2026-09': [{ id: 'order-protected', date: '2026-09-25', vendor: '보존할 발주', total: 20000, note: '실제 매입자료', items: [{ name: '쌀', qty: 1, price: 20000, amt: 20000 }], ocr: '' }] };
    state.orderEdits = {}; state.cardTransactions = { '2026-09': [{ id: seedId, ...{ date: '2026-09-25', time: '09:00', merchant: '보존할 카드기록', amount: 500, status: 'approved', cardLabel: '검증카드', last4: '1234', approvalNo: 'C-OLD', installment: '', note: '보존', warnings: [] } }] }; state.cardEdits = {};
    state.fixedMonthly = { '2026-09': [['보존할 고정비', 123456]], '2026-10': [['보존할 고정비', 123456]] };
    state.menus = { '2026-09': { '30|중식|2': '수동 식단 보존' } }; state.recipes = []; state.recipeAsk = {}; state.staff = [{ id: 'staff-protected', name: '보존 직원', role: '조리', wage: 15000, def: { s: '09:00', e: '18:00', b: 60 }, off: [] }]; state.roster = { '2026-09': { 'staff-protected|2': { s: '09:00', e: '18:00', b: 60 } } }; state.rosterEdits = { '2026-09': {} }; state.view.printMeals = [...MEALS];
    S = normalize(state); localStorage.setItem(KEY, JSON.stringify(S)); orderView = 'card'; go('order'); return structuredClone(S);
  }, seedId);
  const put = async (state, at = '2026-10-01T00:00:00.000Z') => { remote = { id: 'namofood', data: await a.evaluate(async ({ state, password }) => encryptText(password, JSON.stringify(state)), { state, password }), updated_at: at }; };
  await put(base);
  const getRemote = () => a.evaluate(async ({ remote, password }) => JSON.parse(await decryptText(password, remote.data)), { remote, password });
  const check = () => { if (errors.length) throw errors[0]; };
  const idle = async (page = a) => { await page.waitForFunction(() => !cardOcr.busy); await quiesce(page); check(); };
  const enqueue = (document = doc(), options = {}) => { let release; const planned = { document, ...options }; if (options.hold) planned.gate = new Promise(resolve => { release = resolve; }); responses.push(planned); return { release }; };
  const upload = async (document = doc(), page = a, color = '#e61e50') => { enqueue(document); assert.equal(await page.locator('#card-files').count(), 1, 'card tab exposes its separate screenshot/photo upload field'); await page.locator('#card-files').setInputFiles(await photo(page, 'card-photo.png', color)); await idle(page); };
  const commit = async (page = a) => { const button = page.locator('#card-register'); if (await button.isDisabled()) return false; await button.click(); await page.waitForFunction(() => !cardOcr.busy); await quiesce(page); check(); return true; };
  const save = async page => { await quiesce(page); await page.evaluate(() => cloudSave(true)); await quiesce(page); check(); };
  const peer = async () => { const page = await newPage(); assert.equal(await page.evaluate(() => cloudLoad(false)), true); await view(page); return page; };
  return { a, base, put, getRemote, enqueue, upload, commit, save, peer, idle, requests, dialogs, accept: () => dialogChoices.push(true), check, close: () => Promise.all(contexts.map(context => context.close())) };
}
async function setPreview(page, index, key, value) { const field = page.locator(`[data-card-preview-row="${index}"] [data-card-key="${key}"]`); if (await field.evaluate(el => el.tagName === 'SELECT')) await field.selectOption(value); else { await field.fill(value); await field.press('Tab'); } }
async function csv(page) { const waiting = page.waitForEvent('download'); await page.locator('#card-csv').click(); const download = await waiting, stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }
async function concurrentDuplicate(f) {
  assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer();
  await f.upload(); await f.commit(); const first = records(await readState(f.a)).find(row => row.id !== seedId);
  await f.upload(doc(), b, '#ed7032'); await f.commit(b); const proposal = records(await readState(b)).find(row => row.id !== seedId);
  assert.notEqual(first.id, proposal.id, 'different photos produce different OCR record identities');
  assert.equal(records(await f.getRemote()).length, 1, 'both local registrations are made before either PC publishes');
  await f.save(f.a); return { b, first, proposal };
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const passed = [], failed = [];
  async function run(name, test) { if (process.env.NMF_CARD_UI_SCENARIO && !name.includes(process.env.NMF_CARD_UI_SCENARIO)) return; let f; try { f = await fixture(browser); await test(f); f.check(); passed.push(name); console.log('PASS ' + name); } catch (error) { failed.push({ name, error }); console.error('FAIL ' + name + ': ' + error.message); } finally { if (f) await f.close(); } }
  try {
    await run('CARD_PHOTO_SIGNED_PREVIEW_DOES_NOT_AUTO_REGISTER_OR_STORE_PHOTO_PAN', async f => {
      const before = await readState(f.a); assert.equal(await f.a.locator('[data-order-view="card"]').count(), 1);
      await f.upload(); assert.equal(await f.a.locator('#card-ocr-preview [data-card-preview-row]').count(), 1);
      assert.deepEqual(await readState(f.a), before); assert.equal(f.requests.filter(body => body.action === 'extract').length, 1);
      const stored = await f.a.evaluate(() => localStorage.getItem('nmf_card_draft_' + APP)); assert(stored, 'the editable preview survives reload locally');
      assert(!stored.includes('1234567890123456')); assert(!stored.includes(f.requests[0].image.data), 'draft does not persist photograph bytes');
      assert.equal(await f.a.locator('#card-progress-bar').evaluate(el => el.tagName), 'PROGRESS');
    });
    await run('CARD_EXPLICIT_REGISTER_PRESERVES_FIELDS_AND_ALL_NON_CARD_DOMAINS', async f => {
      const before = await readState(f.a); await f.upload(); await f.commit();
      const after = await readState(f.a), added = records(after).find(row => row.id !== seedId); assert(added); assert.deepEqual(pick(added), pick(tx()));
      assert.match(added.id, /^card-/); assert.deepEqual(protectedState(after), protectedState(before));
      const persisted = await f.a.evaluate(() => JSON.parse(localStorage.getItem(KEY))); assert.deepEqual(records(persisted), records(after));
      assert(!JSON.stringify(after).includes('1234567890123456')); await f.save(f.a); assert.deepEqual(records(await f.getRemote()), records(after));
    });
    await run('CARD_INVALID_UNKNOWN_ROWS_CANNOT_REGISTER_UNTIL_MANUALLY_CORRECTED', async f => {
      await f.upload(doc([tx({ date: null, merchant: '', amount: null, status: 'unknown' })])); const box = f.a.locator('[data-card-select="0"]');
      assert.equal(await box.isChecked(), false); await f.commit(); assert.equal(records(await readState(f.a)).length, 1);
      for (const [key, value] of Object.entries({ date: '2026-09-30', merchant: '직접 확인업체', amount: '12500', status: 'approved' })) await setPreview(f.a, 0, key, value);
      await f.a.locator('[data-card-select="0"]').check(); await f.commit(); const added = records(await readState(f.a)).find(row => row.id !== seedId);
      assert.equal(added.date, '2026-09-30'); assert.equal(added.merchant, '직접 확인업체'); assert.equal(added.amount, 12500); assert.equal(added.status, 'approved');
    });
    await run('CARD_CANCELLED_AMOUNTS_STAY_POSITIVE_WITH_NEGATIVE_SIGNED_NET', async f => {
      await f.upload(doc([tx(), tx({ merchant: '반품처', amount: 12000, status: 'cancelled', approvalNo: 'C-CANCEL', time: '11:00' })])); await f.commit();
      const rows = records(await readState(f.a)).filter(row => row.id !== seedId); assert.equal(rows.length, 2); assert(rows.every(row => row.amount > 0));
      const signed = await f.a.evaluate(rows => rows.map(row => cardSignedAmount(row)), rows); assert.deepEqual(signed.sort((a, b) => a - b), [-12000, 33000]);
      assert.equal(signed.reduce((a, b) => a + b, 0), 21000); assert.deepEqual((await readState(f.a)).orders, f.base.orders);
    });
    await run('CARD_NEGATIVE_APPROVED_OCR_REQUIRES_STATUS_REVIEW_AND_REJECTS_NEGATIVE_MANUAL_INPUT', async f => {
      await f.upload(doc([tx({ amount: -33000 }), tx({ merchant: '명확한 취소처', amount: -12000, status: 'cancelled', approvalNo: 'C-CANCEL' })]));
      const draft = await f.a.evaluate(() => structuredClone(cardOcr.draft));
      assert.equal(draft[0].status, 'unknown'); assert.equal(draft[0].amount, 33000); assert.equal(draft[0].selected, false); assert(draft[0].warnings.some(warning => warning.includes('음수')));
      assert.equal(draft[1].status, 'cancelled'); assert.equal(draft[1].amount, 12000); assert.equal(draft[1].selected, true);
      await f.commit(); const approved = records(await readState(f.a)).filter(row => row.id !== seedId); assert.equal(approved.length, 1); assert.equal(approved[0].status, 'cancelled');
      assert.equal(await f.a.evaluate(row => cardSignedAmount(row), approved[0]), -12000); assert.equal(await f.a.evaluate(() => cardOcr.draft.length), 1);
      await f.a.locator('[data-card-select="0"]').check(); await f.commit(); assert.equal(records(await readState(f.a)).length, 2, 'unknown status cannot be explicitly forced into the ledger');
      await setPreview(f.a, 0, 'amount', '-700'); assert.equal(Number((await f.a.locator('[data-card-key="amount"]').inputValue()).replace(/,/g, '')), 33000); assert.equal(await f.a.evaluate(() => cardOcr.draft[0].status), 'unknown');
      await setPreview(f.a, 0, 'status', 'cancelled'); await f.a.locator('[data-card-select="0"]').check(); await f.commit();
      const corrected = records(await readState(f.a)).find(row => row.approvalNo === 'C-100'); assert.equal(corrected.amount, 33000); assert.equal(corrected.status, 'cancelled');
      assert.equal(await f.a.evaluate(row => cardSignedAmount(row), corrected), -33000);
      assert.equal(await f.a.evaluate(id => cardSet(id, 'amount', '-900'), corrected.id), false); assert.equal(records(await readState(f.a)).find(row => row.id === corrected.id).amount, 33000);
      assert.deepEqual(protectedState(await readState(f.a)), protectedState(f.base));
    });
    await run('CARD_DRAFT_REAL_RELOAD_RETAINS_CORRECTIONS_WITHOUT_AUTOMATIC_COMMIT', async f => {
      await f.upload(); await setPreview(f.a, 0, 'note', '등록 전에 직접 고친 메모'); f.accept(); await f.a.reload({ waitUntil: 'domcontentloaded' }); await view(f.a);
      assert.equal(await f.a.locator('[data-card-preview-row]').count(), 1); assert.equal(await f.a.locator('[data-card-key="note"]').inputValue(), '등록 전에 직접 고친 메모');
      assert.equal(records(await readState(f.a)).length, 1); assert.equal(await f.a.evaluate(() => invoicePending()), true);
    });
    await run('CARD_PARTIAL_BATCH_FAILURE_KEEPS_SUCCESSFUL_PREVIEW_AND_SHOWS_FAILURE', async f => {
      f.enqueue(); f.enqueue(undefined, { status: 503, error: '검증 카드 인식 실패' });
      await f.a.locator('#card-files').setInputFiles([await photo(f.a, 'good-card.png'), await photo(f.a, 'failed-card.png', '#ed7032')]); await f.idle();
      assert.equal(await f.a.locator('[data-card-preview-row]').count(), 1); assert.equal(records(await readState(f.a)).length, 1);
      assert.match(await f.a.evaluate(() => cardOcr.error + ' ' + cardOcr.status), /실패/); assert.equal(f.requests.filter(body => body.action === 'extract').length, 2);
    });
    await run('CARD_PENDING_RECOGNITION_PROGRESS_PREVENTS_PLACEHOLDER_TRANSACTION', async f => {
      const pending = f.enqueue(doc(), { hold: true });
      await f.a.locator('#card-files').setInputFiles(await photo(f.a, 'pending-card.png'));
      await f.a.waitForFunction(() => cardOcr.busy);
      assert.equal(await f.a.locator('#card-files').isDisabled(), true); assert.equal(records(await readState(f.a)).length, 1);
      const bar = f.a.locator('#card-progress-bar'); assert.equal(await bar.evaluate(el => el.tagName), 'PROGRESS'); assert.equal(await bar.evaluate(el => el.value < el.max), true);
      pending.release(); await f.idle(); assert.equal(await f.a.locator('[data-card-preview-row]').count(), 1); assert.equal(records(await readState(f.a)).length, 1);
    });
    await run('CARD_SEMANTIC_DUPLICATE_DEFAULT_UNCHECKED_REQUIRES_EXPLICIT_CONFIRM', async f => {
      await f.upload(); await f.commit(); const before = records(await readState(f.a));
      await f.upload(doc(), f.a, '#ed7032'); assert.equal(await f.a.locator('[data-card-select="0"]').isChecked(), false); await f.commit(); assert.deepEqual(records(await readState(f.a)), before);
      await f.a.locator('[data-card-select="0"]').check(); await f.commit(); assert.deepEqual(records(await readState(f.a)), before, 'dismissing the native duplicate confirmation cannot add a second transaction');
      await f.a.locator('[data-card-select="0"]').check(); f.accept(); await f.commit(); assert.equal(records(await readState(f.a)).length, 3); assert(f.dialogs.some(d => d.type === 'confirm'));
    });
    await run('CARD_APPROVAL_NUMBER_MATCH_DETECTS_OCR_VARIATION_BUT_CANCEL_IS_DISTINCT', async f => {
      await f.upload(); await f.commit();
      await f.upload(doc([tx({ merchant: '검증 식자재', time: '10:31', amount: 34000 })]), f.a, '#ed7032'); assert.equal(await f.a.locator('[data-card-select="0"]').isChecked(), false);
      await f.a.evaluate(() => { cardOcr.draft = []; cardPersistDraft(); }); await view(f.a);
      await f.upload(doc([tx({ status: 'cancelled' })]), f.a, '#e44128'); assert.equal(await f.a.locator('[data-card-select="0"]').isChecked(), true); await f.commit();
      assert.equal(records(await readState(f.a)).filter(row => row.approvalNo === 'C-100').length, 2);
    });
    await run('CARD_SAME_BATCH_DUPLICATE_ROWS_ARE_NOT_DOUBLE_REGISTERED', async f => {
      await f.upload(doc([tx(), tx()])); assert.equal(await f.a.locator('[data-card-select="0"]').isChecked(), true); assert.equal(await f.a.locator('[data-card-select="1"]').isChecked(), false);
      await f.commit(); assert.equal(records(await readState(f.a)).filter(row => row.approvalNo === 'C-100').length, 1);
    });
    await run('CARD_CAS_RACE_SEMANTIC_DUPLICATE_EXCLUDES_ONLY_NEW_PROPOSAL_AFTER_CANCEL', async f => {
      const { b, first, proposal } = await concurrentDuplicate(f); await f.save(b);
      const final = await f.getRemote(); assert.deepEqual(records(final), records(await readState(f.a)), 'existing transaction survives the later PC review unchanged');
      assert.equal(records(final).some(row => row.id === first.id), true); assert.equal(records(final).some(row => row.id === proposal.id), false); assert.equal(final.cardEdits[proposal.id].deleted, true);
      assert(f.dialogs.some(dialog => dialog.type === 'confirm' && dialog.message.includes('다른 PC')), 'the semantic cross-PC match requires an explicit choice');
      assert.deepEqual(protectedState(final), protectedState(f.base));
    });
    await run('CARD_CAS_RACE_EXPLICIT_SEPARATE_APPROVAL_PERSISTS_MANUAL_CORRECTION', async f => {
      const { b, first, proposal } = await concurrentDuplicate(f); await b.evaluate(id => cardSet(id, 'note', '별도 거래로 직접 확인'), proposal.id); await quiesce(b); f.accept(); await f.save(b);
      const final = await f.getRemote(), kept = records(final).find(row => row.id === proposal.id); assert(kept); assert.equal(records(final).length, 3); assert.equal(kept.note, '별도 거래로 직접 확인');
      assert.equal(final.cardEdits[proposal.id].origin, 'manual'); assert(kept.ocrMeta.duplicateCheckedIds.includes(first.id));
      const choices = f.dialogs.filter(dialog => dialog.type === 'confirm').length; assert.equal(choices, 1); assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); await f.save(f.a);
      assert.deepEqual(records(await f.getRemote()), records(final)); assert.equal(f.dialogs.filter(dialog => dialog.type === 'confirm').length, choices, 'already confirmed separate registration does not prompt again');
      assert.deepEqual(protectedState(await f.getRemote()), protectedState(f.base));
    });
    await run('CARD_PERSISTED_UNACKNOWLEDGED_RELOAD_STILL_REVIEWS_REMOTE_DUPLICATE', async f => {
      await f.upload(); await f.commit(); const pending = records(await readState(f.a)).find(row => row.id !== seedId), remote = clone(f.base), existing = { ...clone(pending), id: 'card-other-photo-remote' };
      remote.cardTransactions['2026-09'].push(existing); remote.cardEdits[existing.id] = { at: '2026-10-11T00:00:00.000Z', deleted: false, origin: 'ocr' }; await f.put(remote);
      assert.equal(records(await f.getRemote()).some(row => row.id === pending.id), false, 'the local import has never been acknowledged by the server');
      await f.a.reload({ waitUntil: 'domcontentloaded' }); await connect(f.a); await view(f.a);
      assert.equal(records(await readState(f.a)).some(row => row.id === pending.id), true, 'actual reload retains the unsynchronized local transaction'); await f.save(f.a);
      const final = await f.getRemote(); assert.equal(records(final).filter(row => row.approvalNo === 'C-100').length, 1); assert.deepEqual(records(final).find(row => row.id === existing.id), existing);
      assert.equal(final.cardEdits[pending.id].deleted, true); assert(f.dialogs.some(dialog => dialog.type === 'confirm' && dialog.message.includes('다른 PC')));
      assert.deepEqual(protectedState(final), protectedState(f.base));
    });
    await run('CARD_SAME_PHOTO_LATER_OCR_CANNOT_OVERWRITE_MANUAL_CORRECTION', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer(); await f.upload(); await f.commit(); const original = records(await readState(f.a)).find(row => row.id !== seedId);
      await f.a.evaluate(id => { cardSet(id, 'amount', '34567'); cardSet(id, 'note', '명세 확인 후 수동 보정'); }, original.id); await quiesce(f.a); const corrected = records(await readState(f.a)).find(row => row.id === original.id), manualAt = (await readState(f.a)).cardEdits[original.id].at;
      await f.upload(doc([tx({ amount: 99000, note: '뒤늦게 다시 인식한 값' })]), b); await f.commit(b); const later = await readState(b); assert.equal(records(later).find(row => row.id === original.id).amount, 99000); assert(Date.parse(later.cardEdits[original.id].at) > Date.parse(manualAt));
      await f.save(f.a); await f.save(b); const final = await f.getRemote(); assert.deepEqual(records(final).find(row => row.id === original.id), corrected); assert.equal(final.cardEdits[original.id].origin, 'manual'); assert.equal(records(final).length, 2);
      assert.deepEqual(protectedState(final), protectedState(f.base));
    });
    await run('CARD_SAME_PHOTO_NEW_OCR_CANNOT_REVIVE_EXPLICIT_DELETE', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer(); await f.upload(); await f.commit(); const original = records(await readState(f.a)).find(row => row.id !== seedId);
      f.accept(); await f.a.evaluate(id => cardDel(id), original.id); await quiesce(f.a);
      await f.upload(doc([tx({ amount: 99000 })]), b); await f.commit(b); assert.equal(records(await readState(b)).some(row => row.id === original.id), true, 'stale PC has a genuinely new same-photo OCR registration');
      await f.save(f.a); await f.save(b); const final = await f.getRemote(); assert.equal(records(final).some(row => row.id === original.id), false); assert.equal(final.cardEdits[original.id].deleted, true); assert.equal(records(final).length, 1);
      assert.deepEqual(protectedState(final), protectedState(f.base));
    });
    await run('CARD_CALENDAR_SEARCH_STATUS_FILTERS_ONLY_CARD_HISTORY', async f => {
      await f.upload(doc([tx(), tx({ date: '2026-09-29', merchant: '다른상점', approvalNo: 'C-200', status: 'cancelled', amount: 12000 })])); await f.commit(); const before = await readState(f.a);
      await f.a.locator('[data-card-date="2026-09-29"]').click(); assert.equal(await f.a.locator('[data-card-id]').count(), 1);
      await f.a.locator('[data-card-all-dates]').click(); await f.a.locator('#card-search').fill('검증식자재'); await f.a.locator('#card-search').press('Tab'); assert.equal(await f.a.locator('[data-card-id]').count(), 1);
      await f.a.locator('#card-search').fill(''); await f.a.locator('#card-search').press('Tab'); await f.a.locator('#card-status').selectOption('cancelled'); assert.equal(await f.a.locator('[data-card-id]').count(), 1);
      assert.deepEqual((await readState(f.a)).orders, before.orders);
    });
    await run('CARD_WEEK_CROSSES_MONTH_AND_DATE_CHANGE_RETAINS_TRANSACTION_ID', async f => {
      await f.upload(doc([tx(), tx({ date: '2026-10-01', approvalNo: 'C-OCT', merchant: '다음달상점' })])); await f.commit();
      await f.a.evaluate(() => { S.month = '2026-10'; selDay = 1; orderRange.mode = 'week'; render(); });
      assert.equal(await f.a.locator('[data-card-date="2026-09-30"]').count(), 1); await f.a.locator('[data-card-date="2026-09-30"]').click(); assert.equal(await f.a.locator('[data-card-id]').count(), 1);
      const moved = records(await readState(f.a)).find(row => row.approvalNo === 'C-100'); await f.a.evaluate(id => cardSet(id, 'date', '2026-10-02'), moved.id);
      const after = await readState(f.a); assert.equal(after.cardTransactions['2026-10'].find(row => row.id === moved.id).date, '2026-10-02'); assert(!after.cardTransactions['2026-09'].some(row => row.id === moved.id));
    });
    await run('CARD_MANUAL_ADD_PAST_MONTH_AND_CROSS_MONTH_DATE_SHOWS_EDITABLE_NULL_AMOUNT', async f => {
      await f.a.locator('#card-search').fill('일치하지 않는 검색어'); await f.a.locator('#card-search').press('Tab'); await f.a.locator('#card-status').selectOption('cancelled'); await f.a.locator('[data-card-date="2026-09-26"]').click();
      await f.a.locator('#card-add').click(); const first = records(await readState(f.a)).find(row => row.id !== seedId);
      assert.equal(first.date, '2026-09-26'); assert.equal(first.amount, null); assert.equal(first.merchant, ''); assert.equal(await f.a.locator(`[data-card-id="${first.id}"]`).count(), 1); assert.equal(await f.a.locator('#card-search').inputValue(), ''); assert.equal(await f.a.locator('#card-status').inputValue(), 'all');
      assert.equal(await f.a.evaluate(row => cardSignedAmount(row), first), 0); assert.equal(await f.a.locator('[data-card-net]').innerText(), '0원');
      const manualMerchant = f.a.locator(`[data-card-id="${first.id}"] [data-card-field="merchant"]`); await manualMerchant.fill('직접 추가 상점'); await manualMerchant.press('Tab');
      const manualAmount = f.a.locator(`[data-card-id="${first.id}"] [data-card-field="amount"]`); await manualAmount.fill('7777'); await manualAmount.press('Tab'); assert.match(await f.a.locator('[data-card-net]').innerText(), /7,777/);
      await f.a.evaluate(() => { S.month = '2026-10'; selDay = 1; orderRange.mode = 'week'; cardSelectedDate = null; render(); }); await f.a.locator('[data-card-date="2026-09-30"]').click(); await f.a.locator('#card-add').click();
      const second = records(await readState(f.a)).find(row => row.id !== seedId && row.id !== first.id); assert.equal(second.date, '2026-09-30'); assert.equal(second.amount, null); assert.equal(await f.a.locator(`[data-card-id="${second.id}"]`).count(), 1); assert.equal(await f.a.locator('[data-card-net]').innerText(), '0원'); assert.equal(await f.a.evaluate(row => cardSignedAmount(row), second), 0);
      assert.deepEqual((await readState(f.a)).orders, f.base.orders);
    });
    await run('CARD_MOBILE_LARGE_VALUES_VISIBLE_WITHOUT_PAGE_HORIZONTAL_OVERFLOW', async f => {
      await f.upload(doc([tx({ amount: 1000000000000 })])); await f.commit();
      const large = records(await readState(f.a)).find(row => row.id !== seedId);
      for (const width of [1280, 390]) {
        await f.a.setViewportSize({ width, height: 1000 }); await view(f.a); await f.a.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        const input = f.a.locator(`[data-card-id="${large.id}"] [data-card-field="amount"]`); assert.equal(Number((await input.inputValue()).replace(/,/g, '')), 1000000000000);
        const fit = await input.evaluate(el => { const s = getComputedStyle(el), c = document.createElement('canvas').getContext('2d'); c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`; return { text: c.measureText(el.value).width, available: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) }; });
        assert(fit.text <= fit.available + 1, 'full amount fits the editable field'); assert.equal(await f.a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await input.focus(); await input.press('Tab'); assert.equal(await input.evaluate(el => document.activeElement !== el), true);
      }
    });
    await run('CARD_UNTRUSTED_LABELS_ESCAPE_HTML_CSV_FORMULAS_AND_PRINT_NO_DATA_MUTATION', async f => {
      await f.upload(doc([tx({ merchant: '<img src=x onerror="window.__cardXss=1">' })])); await f.commit(); assert.equal(await f.a.locator('img[src="x"]').count(), 0); assert.equal(await f.a.evaluate(() => window.__cardXss), undefined);
      const added = records(await readState(f.a)).find(row => row.id !== seedId); await f.a.evaluate(id => { cardSet(id, 'merchant', '=2+2'); cardSet(id, 'note', '@SUM(1+1)'); }, added.id);
      const text = await csv(f.a); assert(text.includes("'=2+2")); assert(text.includes("'@SUM(1+1)")); assert(text.includes('33000'));
      const before = await readState(f.a); await f.a.emulateMedia({ media: 'print' }); await f.a.evaluate(() => dispatchEvent(new Event('beforeprint'))); assert(await f.a.locator('.card-print').isVisible()); assert.match(await f.a.locator('.card-print').innerText(), /=2\+2/); assert.match(await f.a.locator('.card-print').innerText(), /33,000/);
      await f.a.evaluate(() => dispatchEvent(new Event('afterprint'))); await f.a.emulateMedia({ media: 'screen' }); assert.deepEqual(await readState(f.a), before);
    });
    await run('CARD_SENSITIVE_OBFUSCATED_FIELDS_REDACT_IN_DRAFT_RELOAD_MANUAL_EDIT_AND_CLOUD', async f => {
      const privateNote = '메모 유지 | 카드번호 4111\u200b1111\u200b1111\u200b1111 | 계좌번호 123 45 678901 | 비밀번호: s e c r e t';
      const assertPrivate = value => { const normalized = JSON.stringify(value).replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ''); assert(!normalized.includes('4111111111111111')); assert(!normalized.includes('123 45 678901')); assert(!normalized.includes('s e c r e t')); assert(!normalized.includes('12345678')); };
      await f.upload(doc([tx({ note: privateNote, cardLabel: 'KB 12345678', approvalNo: '87654321' })]));
      const draft = await f.a.evaluate(() => structuredClone(cardOcr.draft)); assertPrivate(draft); assert.equal(draft[0].approvalNo, '87654321'); assert.equal(draft[0].date, '2026-09-30'); assert.equal(draft[0].time, '10:30'); assert.equal(draft[0].amount, 33000); assert.equal(draft[0].last4, '1234'); assert(draft[0].note.includes('메모 유지'));
      f.accept(); await f.a.reload({ waitUntil: 'domcontentloaded' }); await connect(f.a); await view(f.a); assertPrivate(await f.a.evaluate(() => JSON.parse(localStorage.getItem('nmf_card_draft_' + APP))));
      assert.equal(await f.a.locator('[data-card-key="approvalNo"]').inputValue(), '87654321'); await f.commit(); const added = records(await readState(f.a)).find(row => row.id !== seedId);
      await f.a.evaluate(({ id, privateNote }) => { cardSet(id, 'note', privateNote); cardSet(id, 'cardLabel', 'KB 12345678'); }, { id: added.id, privateNote }); await quiesce(f.a);
      const corrected = records(await readState(f.a)).find(row => row.id === added.id); assertPrivate(corrected); assert.equal(corrected.approvalNo, '87654321'); assert.equal(corrected.last4, '1234'); assert.equal(corrected.amount, 33000); assert(corrected.note.includes('메모 유지'));
      await f.save(f.a); assertPrivate(records(await f.getRemote())); assertPrivate(await f.a.evaluate(() => localStorage.getItem(KEY))); assert.deepEqual((await f.getRemote()).orders, f.base.orders);
    });
    await run('CARD_DELETE_TOMBSTONE_STALE_PC_ADDITIONS_AND_NON_CARD_DOMAINS_SURVIVE', async f => {
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true); const b = await f.peer();
      await f.upload(doc([tx({ approvalNo: 'PC-A' })])); await f.commit(); await f.save(f.a);
      await f.upload(doc([tx({ approvalNo: 'PC-B', merchant: '다른기기카드' })]), b, '#ed7032'); await f.commit(b); await f.save(b);
      assert.equal(records(await f.getRemote()).length, 3); assert.deepEqual((await f.getRemote()).orders, f.base.orders);
      f.accept(); await b.evaluate(id => cardDel(id), seedId); await f.save(b); await f.a.evaluate(() => { S.settings.target = .12; save(); }); await f.save(f.a);
      const final = await f.getRemote(); assert.equal(records(final).some(row => row.id === seedId), false); assert.equal(final.cardEdits[seedId].deleted, true); assert.equal(records(final).length, 2); assert.deepEqual(final.roster, f.base.roster);
    });
    await run('CARD_OLDER_REMOTE_PAYLOAD_WITHOUT_CARD_ARRAY_DOES_NOT_DELETE_HISTORY', async f => {
      await f.upload(); await f.commit(); await f.save(f.a); const local = records(await readState(f.a)), older = clone(await f.getRemote()); delete older.cardTransactions; delete older.cardEdits;
      await f.put(older, '2026-10-21T00:00:00.000Z'); await f.a.evaluate(() => cloudLoad(false)); assert.deepEqual(records(await readState(f.a)), local);
      await f.save(f.a); assert.deepEqual(records(await f.getRemote()), local);
    });
    console.log('CARD_UI_RESULTS ' + JSON.stringify({ passed, failed: failed.map(row => row.name) })); assert(passed.length + failed.length > 0);
    if (failed.length) throw new AggregateError(failed.map(row => row.error), 'Card UI regressions: ' + failed.length);
  } finally { console.log('APP_SOURCE_SHA256 ' + sourceHash); if (process.env.NMF_CARD_UI_NEGATIVE_CONTROL) console.log('TESTED_SOURCE_SHA256 ' + createHash('sha256').update(source).digest('hex')); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
