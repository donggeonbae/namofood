// Offline two-browser regressions for lightweight cloud polling; no production calls.
// Tax is now AI-managed/read-only in Food. Exercise the same real editable
// percentage control with vacancy instead; preserve all exact merge/race assertions.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { chromium } = require('playwright');
const source = fs.readFileSync(process.env.NMF_EGRESS_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const password = 'offline-egress-fixture-password';
const baseline = process.argv.includes('--baseline');
const digest = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const stateOf = page => page.evaluate(() => structuredClone(S));

async function fixture(browser, app = 'food', table = 'namofood_state') {
  const contexts = [], pages = [], failures = [], events = [];
  const room = app === 'cafe' ? 'namocafe' : 'namofood';
  let remote = null, revisionMode = 'valid', gate = null;
  const fulfill = async (route, kind, body, status = 200) => {
    const encoded = JSON.stringify(body);
    events.push({ kind, bytes: Buffer.byteLength(encoded), status, method: route.request().method() });
    return route.fulfill({ status, contentType: 'application/json', body: encoded });
  };
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    contexts.push(context);
    await context.addInitScript(({ password, app }) => {
      localStorage.setItem('nmf_app', app);
      localStorage.setItem('nmf_supa_' + app, JSON.stringify({ url: '', key: '' }));
      sessionStorage.setItem('nmf_session_pw', password);
      const realNow = Date.now;
      Date.now = () => window.__egressFixedNow ?? realNow();
    }, { password, app });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        if (request.isNavigationRequest()) {
          assert.equal(url.origin, 'https://offline.namofood.test');
          return route.fulfill({ contentType: 'text/html', body: source });
        }
        if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/rest/v1/rpc/nmf_state_revision') {
          assert.equal(request.method(), 'GET', 'revision inspection is a read');
          assert.equal(request.headers().apikey, 'offline-anon-fixture');
          assert.equal(url.searchParams.get('room'), room, 'revision targets the current food/cafe room');
          assert.deepEqual([...url.searchParams.keys()], ['room'], 'revision requests contain no password, key, ciphertext, or arbitrary table argument');
          const held = gate;
          if (held) { gate = null; held.entered(); await held.wait; }
          if (revisionMode === 'unavailable') return fulfill(route, 'revision', { code: 'PGRST202' }, 404);
          if (revisionMode === 'malformed') return fulfill(route, 'revision', [{ updated_at: remote.updated_at, revision: 'invalid-hash' }]);
          if (revisionMode === 'empty') return fulfill(route, 'revision', []);
          if (revisionMode === 'invalid-date') return fulfill(route, 'revision', [{ updated_at: 'invalid-date', revision: digest(remote.data) }]);
          if (revisionMode === 'timeout') { events.push({ kind: 'revision', bytes: 0, status: 0, method: 'GET' }); return route.abort('timedout'); }
          const body = remote ? [{ updated_at: remote.updated_at, revision: digest(remote.data) }] : [];
          for (const row of body) {
            assert.deepEqual(Object.keys(row).sort(), ['revision', 'updated_at'], 'revision response reveals metadata only');
            assert.match(row.revision, /^[a-f0-9]{64}$/);
          }
          const encoded = JSON.stringify(body);
          assert(!encoded.includes(password) && !encoded.includes('fixturePayload') && (!remote || !encoded.includes(remote.data)), 'revision response contains no password, state, or ciphertext');
          return fulfill(route, 'revision', body);
        }
        if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/rest/v1/' + table) {
          assert.equal(request.headers().apikey, 'offline-anon-fixture');
          if (request.method() === 'GET') {
            assert.equal(url.searchParams.get('id'), 'eq.' + room);
            assert.equal(url.searchParams.get('select'), 'data,updated_at');
            return fulfill(route, 'state', remote ? [remote] : []);
          }
          if (request.method() === 'PATCH') {
            assert.equal(url.searchParams.get('updated_at'), 'eq.' + remote.updated_at, 'writes still use full-state CAS');
            remote = { id: room, ...request.postDataJSON() };
            return fulfill(route, 'patch', [{ id: room }]);
          }
          assert.equal(request.method(), 'POST');
          const rows = request.postDataJSON();
          assert(Array.isArray(rows) && rows.every(row => row.id.startsWith(room + '@')), 'only synthetic snapshot inserts are permitted');
          return fulfill(route, 'backup', []);
        }
        if (url.pathname === '/functions/v1/nmf-recipe-fill') return route.fulfill({ json: { ok: true, running: null, runs: [], last: null } });
        return route.abort();
      } catch (error) { failures.push(error); return route.abort(); }
    });
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(5000);
    page.on('pageerror', error => failures.push(error));
    page.on('dialog', async dialog => { failures.push(new Error('Unexpected dialog: ' + dialog.type())); await dialog.dismiss(); });
    await page.goto('https://offline.namofood.test/');
    await page.evaluate(({ room, table }) => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
      cloud.url = 'https://offline-cloud.namofood.test'; cloud.key = 'offline-anon-fixture'; cloud.table = table; cloud.room = room;
      cloudRemoteAt = null; cloudRemoteData = null; cloudDirty = false; cloudBusy = false; lastInputAt = 0;
    }, { room, table });
  }
  const [a, b] = pages;
  const base = await a.evaluate(payload => {
    const state = normalize(defaultState()); state.month = '2026-10';
    state.staff = [{ id: 'egress-staff', name: '전송량 검증 직원', role: '조리', wage: 15750, bonus: 1200, def: { s: '09:00', e: '18:00', b: 60 }, off: [6] }];
    state.staffArchive = []; state.staffEdits = {}; state.staffFieldEdits = {};
    state.roster = { '2026-09': {}, '2026-10': { 'egress-staff|7': { s: '22:00', e: '06:00', b: 60 } } }; state.rosterEdits = { '2026-09': {}, '2026-10': {} };
    state.menus = { '2026-10': { '14|중식|2': '전송량 검증 수동주찬', '14|중식|n': '250' } };
    state.menuPlanMeta = { '2026-10-14|중식': { by: 'manual', runId: 'offline-egress' } }; state.headcountMeta = {};
    state.recipes = [{ menu: '전송량 검증 수동주찬', item: '검증재료', qty: 100, unit: 'g', comp: '주찬' }];
    state.methods = {}; state.sources = {}; state.recipeMeta = {}; state.recipeAsk = {};
    state.purch = []; state.purchEdit = {}; state.stock = []; state.stockLog = []; state.orders = {};
    state.settings.fixturePayload = payload; state.settings.vacancy = .1; state.settings.target = .08;
    state.view = { range: 'month', mode: 'public', ing: false, printMeals: ['중식', '석식', '야식'] };
    S = state; return structuredClone(state);
  }, randomBytes(120000).toString('base64'));
  const put = async (state, at = '2026-10-01T00:00:00.000Z') => { remote = { id: room, data: await a.evaluate(async ({ state, password }) => encryptText(password, JSON.stringify(state)), { state, password }), updated_at: at }; };
  await put(base);
  const stats = () => ({ revisions: events.filter(e => e.kind === 'revision').length, fullReads: events.filter(e => e.kind === 'state').length, stateBytes: events.filter(e => e.kind === 'state').reduce((sum, e) => sum + e.bytes, 0), revisionBytes: events.filter(e => e.kind === 'revision').reduce((sum, e) => sum + e.bytes, 0), writes: events.filter(e => ['patch', 'backup'].includes(e.kind)).length });
  const poll = page => page.evaluate(() => { lastInputAt = 0; return cloudLoad(true); });
  const initialize = async () => { for (const page of pages) assert.equal(await poll(page), true, 'first silent startup establishes its full encrypted baseline'); };
  const check = () => { if (failures.length) throw failures[0]; };
  const save = async page => {
    await page.evaluate(() => { clearTimeout(cloudTimer); clearTimeout(saveTimer); });
    await page.evaluate(() => cloudSave(true));
    await page.evaluate(() => { clearTimeout(cloudTimer); clearTimeout(saveTimer); });
    assert.equal(await page.evaluate(() => cloudBusy), false, 'real mocked CAS save completes'); check();
  };
  const readRemote = async () => a.evaluate(async ({ row, password }) => JSON.parse(await decryptText(password, row.data)), { row: remote, password });
  return { a, b, base, put, poll, initialize, save, readRemote, stats, events, check, reset: () => { events.length = 0; }, mode: value => { revisionMode = value; }, hold: () => { let release, entered; const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; }); gate = { wait, entered }; return { ready, release }; }, row: () => clone(remote), close: async () => { await Promise.all(contexts.map(context => context.close())); } };
}

function protectedData(state) {
  return Object.fromEntries(['menus', 'menuPlanMeta', 'headcountMeta', 'staff', 'staffArchive', 'staffEdits', 'staffFieldEdits', 'roster', 'rosterEdits', 'recipes', 'methods', 'recipeMeta'].map(key => [key, state[key]]));
}

async function editVacancy(page, percent) {
  await page.evaluate(() => { go('settings'); clearTimeout(cloudTimer); clearTimeout(saveTimer); });
  const input = page.locator('input[onchange*="[\'vacancy\']"]');
  assert.equal(await input.count(), 1, 'the genuine vacancy field exists');
  await input.fill(String(percent)); await input.press('Tab');
  await page.evaluate(() => { clearTimeout(cloudTimer); clearTimeout(saveTimer); });
  assert.equal((await stateOf(page)).settings.vacancy, percent / 100, 'genuine field edits commit the intended local setting');
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const passed = [];
    const run = async (name, scenario, app = 'food', table = 'namofood_state') => {
      const f = await fixture(browser, app, table);
      try { await scenario(f); f.check(); passed.push(name); console.log('PASS ' + name); }
      finally { await f.close(); }
    };
    await run('IDLE_TEN_POLLS_METADATA_ONLY_AND_STARTUP_FULL_READ', async f => {
      await f.initialize();
      assert.equal(f.stats().fullReads, 2, 'two startup clients each read full state once');
      assert.equal(f.stats().revisions, 0, 'startup without a baseline does not use the revision shortcut');
      f.reset();
      const before = await stateOf(f.a);
      for (let i = 0; i < 10; i++) assert.equal(await f.poll(f.a), false, 'idle polling must not apply an identical revision');
      const measured = f.stats();
      console.log(JSON.stringify({ sourceHash, phase: baseline ? 'baseline' : 'idle', polls: 10, ...measured }));
      assert.equal(measured.fullReads, 0, 'ten idle polls must not download any full ciphertext/state body');
      assert.equal(measured.revisions, 10, 'each idle poll uses one lightweight revision read');
      assert(measured.revisionBytes < 2000, 'ten metadata responses stay below 2 KB');
      assert.deepEqual(await stateOf(f.a), before, 'idle polling preserves exact client data');
    });
    if (baseline) return;
    await run('REAL_PEER_CHANGE_APPLIES_WITHIN_ONE_POLL_AND_SAVE_RETAINS_FULL_CAS', async f => {
      await f.initialize(); f.reset();
      await editVacancy(f.b, 17); await f.save(f.b);
      assert.equal(f.stats().fullReads, 1, 'saving still fetches full state to reconcile before CAS');
      assert.equal(f.stats().revisions, 0, 'saving does not substitute revision metadata for its reconciliation read');
      assert.equal(f.stats().writes, 2, 'mocked room update and daily snapshot both finish');
      const committed = await f.readRemote();
      assert.equal(committed.settings.vacancy, .17, 'peer genuine field value reached shared ciphertext');
      assert.deepEqual(protectedData(committed), protectedData(f.base), 'peer settings save preserves synthetic staff/menu/history');
      f.reset();
      assert.equal(await f.poll(f.a), true, 'one silent poll applies the newer peer revision');
      assert.equal(f.stats().revisions, 1); assert.equal(f.stats().fullReads, 1);
      const loaded = await stateOf(f.a);
      assert.equal(loaded.settings.vacancy, .17); assert.deepEqual(protectedData(loaded), protectedData(committed));
      await f.a.evaluate(() => go('settings'));
      assert.equal(await f.a.locator('input[onchange*="[\'vacancy\']"]').inputValue(), '17', 'the visible genuine field refreshes within the same poll');
      f.reset(); assert.equal(await f.poll(f.a), false);
      assert.equal(f.stats().fullReads, 0, 'hash cache is refreshed for the newly loaded ciphertext');
      assert.equal(f.stats().revisions, 1);
    });
    await run('SAME_TIMESTAMP_DIFFERENT_CIPHERTEXT_IS_NOT_SKIPPED', async f => {
      await f.initialize();
      const peer = clone(f.base); peer.settings.vacancy = .19;
      const previous = f.row(); await f.put(peer, previous.updated_at);
      assert.notEqual(f.row().data, previous.data, 'the authentic encryption yields different ciphertext at the same timestamp');
      f.reset(); assert.equal(await f.poll(f.a), true);
      assert.equal(f.stats().revisions, 1); assert.equal(f.stats().fullReads, 1);
      assert.equal((await stateOf(f.a)).settings.vacancy, .19);
      assert.deepEqual(protectedData(await stateOf(f.a)), protectedData(f.base));
      f.reset(); assert.equal(await f.poll(f.a), false); assert.equal(f.stats().fullReads, 0);
    });
    await run('LOCAL_EDIT_DURING_METADATA_RESPONSE_SURVIVES_AND_MERGES_ON_SAVE', async f => {
      await f.initialize();
      const peer = clone(f.base); peer.settings.vacancy = .2; peer.settings.target = .15;
      await f.put(peer, '2026-10-02T00:00:00.000Z'); f.reset();
      const held = f.hold(), pending = f.poll(f.a);
      await held.ready;
      await editVacancy(f.a, 12); const local = await stateOf(f.a);
      held.release(); assert.equal(await pending, false, 'in-flight metadata cannot apply a state captured before local editing');
      assert.deepEqual(await stateOf(f.a), local, 'every local value survives the delayed pull exactly');
      await f.save(f.a);
      const committed = await f.readRemote(), expected = clone(peer.settings); expected.vacancy = .12;
      assert.deepEqual(committed.settings, expected, 'the next full CAS save keeps the typed vacancy while merging the unrelated peer target');
      assert.deepEqual(protectedData(committed), protectedData(peer));
    });
    await run('UNCOMMITTED_INPUT_DURING_METADATA_RESPONSE_IS_NOT_DISCARDED', async f => {
      await f.initialize();
      const peer = clone(f.base); peer.settings.vacancy = .2; peer.settings.target = .16;
      await f.put(peer, '2026-10-03T00:00:00.000Z');
      await f.a.evaluate(() => go('settings'));
      const held = f.hold(), pending = f.poll(f.a); await held.ready;
      const input = f.a.locator('input[onchange*="[\'vacancy\']"]'); await input.fill('13');
      assert.equal((await stateOf(f.a)).settings.vacancy, .1, 'focused text is authentically uncommitted');
      await f.a.evaluate(() => { lastInputAt = 0; });
      held.release(); assert.equal(await pending, false, 'input revision protects typing even after its time guard expires');
      assert.equal(await input.inputValue(), '13', 'the visible typed text remains after metadata resolves');
      await input.press('Tab'); await f.save(f.a);
      const committed = await f.readRemote(); assert.equal(committed.settings.vacancy, .13); assert.equal(committed.settings.target, .16);
    });
    await run('MANUAL_PULL_ALWAYS_FETCHES_FULL_STATE', async f => {
      await f.initialize(); f.reset();
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), false, 'an exact duplicate manual pull reports latest state');
      assert.equal(f.stats().fullReads, 1); assert.equal(f.stats().revisions, 0);
      const peer = clone(f.base); peer.settings.vacancy = .21; await f.put(peer, '2026-10-04T00:00:00.000Z');
      assert.equal(await f.a.evaluate(() => cloudLoad(false)), true);
      assert.equal((await stateOf(f.a)).settings.vacancy, .21);
      assert.equal(f.stats().fullReads, 2); assert.equal(f.stats().revisions, 0);
    });
    for (const mode of ['unavailable', 'malformed', 'empty', 'invalid-date', 'timeout']) await run('RPC_' + mode.toUpperCase().replace('-', '_') + '_FULL_READ_FALLBACK_AND_60S_COOLDOWN', async f => {
      await f.initialize();
      const peer = clone(f.base); peer.settings.vacancy = .22; await f.put(peer, '2026-10-05T00:00:00.000Z');
      await f.a.evaluate(() => { window.__egressFixedNow = Date.now(); });
      f.mode(mode); f.reset(); assert.equal(await f.poll(f.a), true, 'invalid or unavailable metadata still loads a real changed full state');
      assert.equal((await stateOf(f.a)).settings.vacancy, .22);
      assert.equal(f.stats().revisions, 1); assert.equal(f.stats().fullReads, 1);
      f.mode('valid');
      for (let i = 0; i < 2; i++) assert.equal(await f.poll(f.a), false);
      assert.equal(f.stats().revisions, 1, 'RPC is not retried immediately during its cooldown');
      assert.equal(f.stats().fullReads, 3, 'cooldown retains compatible full-state reads');
      await f.a.evaluate(() => { window.__egressFixedNow += 59000; });
      await f.poll(f.a); assert.equal(f.stats().revisions, 1, 'failure cooldown still holds before sixty seconds');
      await f.a.evaluate(() => { window.__egressFixedNow += 2000; });
      f.reset(); assert.equal(await f.poll(f.a), false);
      assert.equal(f.stats().revisions, 1, 'RPC is retried after sixty seconds');
      assert.equal(f.stats().fullReads, 0, 'healthy metadata resumes its no-state-body optimization');
    });
    await run('CAFE_ROOM_USES_ONLY_CAFE_REVISION_AND_DETECTS_CHANGES', async f => {
      await f.initialize(); f.reset(); assert.equal(await f.poll(f.a), false);
      assert.equal(f.stats().revisions, 1); assert.equal(f.stats().fullReads, 0);
      const peer = clone(f.base); peer.settings.cafe.price = 5500; await f.put(peer, '2026-10-06T00:00:00.000Z');
      assert.equal(await f.poll(f.a), true); assert.equal((await stateOf(f.a)).settings.cafe.price, 5500);
      assert.equal(f.stats().fullReads, 1);
    }, 'cafe');
    await run('CUSTOM_TABLE_PRESERVES_FULL_FETCH_COMPATIBILITY', async f => {
      await f.initialize(); f.reset();
      for (let i = 0; i < 2; i++) assert.equal(await f.poll(f.a), false);
      assert.equal(f.stats().fullReads, 2); assert.equal(f.stats().revisions, 0, 'custom tables never call the restricted default-table RPC');
      const peer = clone(f.base); peer.settings.vacancy = .24; await f.put(peer, '2026-10-07T00:00:00.000Z');
      assert.equal(await f.poll(f.a), true); assert.equal((await stateOf(f.a)).settings.vacancy, .24);
    }, 'food', 'offline_custom_state');
    await run('HIDDEN_INTERVAL_TICK_SKIPS_POLLING', async f => {
      await f.initialize(); f.reset(); await f.a.clock.install();
      await f.a.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); cloudStartPolling(); });
      await f.a.clock.runFor(5001);
      assert.equal(f.stats().revisions, 0); assert.equal(f.stats().fullReads, 0, 'the actual hidden-page interval performs no network read');
      const visibleResponse = f.a.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/rpc/nmf_state_revision');
      await f.a.evaluate(() => { delete document.hidden; }); await f.a.clock.runFor(5000);
      await (await visibleResponse).finished();
      assert.equal(f.stats().revisions, 1, 'the actual visible interval returns to one lightweight read');
      assert.equal(f.stats().fullReads, 0);
    });
    console.log(JSON.stringify({ sourceHash, scenarios: passed.length, skipped: 0 }));
    console.log('CLOUD_EGRESS_METADATA_ONLY / STARTUP_MANUAL_FULL_READ / PEER_SINGLE_POLL / SAME_TIMESTAMP_HASH / LOCAL_EDIT_GUARDS / FULL_STATE_CAS / RPC_FALLBACK_COOLDOWN / CAFE_ROOM / CUSTOM_TABLE / HIDDEN_POLL / REVISION_NO_STATE_OR_SECRETS / ALL_NETWORK_INTERCEPTED_PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
