// Offline two-client regressions. Every network request is intercepted; no production is contacted.
// UI typing cases use the still-editable vacancy percentage. Food's old tax
// percentage control was retired by AI tax calculation; data-only tax cases remain.
// Run with Playwright available through NODE_PATH. NMF_SETTINGS_SOURCE may point to an authentic saved source.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const password = 'offline-settings-fixture-password';
const sourcePath = process.env.NMF_SETTINGS_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html');
let source = fs.readFileSync(sourcePath, 'utf8');
const sourceFileHash = createHash('sha256').update(source).digest('hex');
const negativeControl = process.env.NMF_SETTINGS_NEGATIVE_CONTROL;
if (negativeControl) {
  const controls = {
    'omit-config': ['mergeRemoteConfig(other);', '/* config reconciliation omitted only in this disposable browser page */'],
    'remote-overwrite': ['mergeRemoteConfig(other);', 'S.settings=structuredClone(other.settings);S.view=structuredClone(other.view);'],
    'live-baseline': ['cloudConfigBase=captureCloudConfigBase(sent);', 'cloudConfigBase=captureCloudConfigBase(S);'],
    'timestamp-only': ['&&row.data===cloudRemoteData', ''],
  };
  assert(controls[negativeControl], 'unknown isolated negative control');
  const [before, after] = controls[negativeControl];
  assert.equal(source.split(before).length, 2, 'negative control requires one exact integration point');
  source = source.replace(before, after);
}
const allMeals = ['조식', '중식', '석식', '야식'];
const noBreakfast = allMeals.slice(1);
const clone = value => structuredClone(value);

async function quiesce(page) {
  await page.evaluate(() => {
    clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
  });
}

async function stateOf(page) { return page.evaluate(() => structuredClone(S)); }
function protectedData(state) {
  return Object.fromEntries(['menus', 'menuPlanMeta', 'headcountMeta', 'staff', 'staffArchive', 'staffEdits', 'staffFieldEdits', 'roster', 'rosterEdits', 'recipes', 'methods', 'recipeMeta'].map(key => [key, state[key]]));
}

async function fixture(browser) {
  const contexts = [], pages = [], routeErrors = [];
  let remote = null, patches = 0, backups = 0, rejected = 0, conflictRow = null;
  const commits = [];
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
      contexts.push(context);
      await context.addInitScript(({ password }) => {
        localStorage.setItem('nmf_app', 'food');
        localStorage.setItem('nmf_supa_food', JSON.stringify({ url: '', key: '' }));
        sessionStorage.setItem('nmf_session_pw', password);
      }, { password });
      const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(5000);
      page.on('pageerror', error => routeErrors.push(error));
      page.on('dialog', async dialog => { routeErrors.push(new Error('Unexpected dialog: ' + dialog.message())); await dialog.dismiss(); });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        try {
          if (request.isNavigationRequest()) {
            assert.equal(url.origin, 'https://offline.namofood.test');
            return route.fulfill({ contentType: 'text/html', body: source });
          }
          if (url.pathname === '/functions/v1/nmf-recipe-fill') {
            return route.fulfill({ json: { ok: true, running: null, runs: [], last: null } });
          }
          if (url.origin === 'https://offline-cloud.namofood.test' && url.pathname === '/rest/v1/namofood_state') {
            assert.equal(request.headers().apikey, 'offline-anon-fixture');
            if (request.method() === 'GET') {
              assert.equal(url.searchParams.get('id'), 'eq.namofood');
              return route.fulfill({ json: remote ? [remote] : [] });
            }
            if (request.method() === 'PATCH') {
              patches++; assert.equal(url.searchParams.get('id'), 'eq.namofood');
              if (conflictRow) { remote = conflictRow; conflictRow = null; rejected++; return route.fulfill({ json: [] }); }
              if (url.searchParams.get('updated_at') !== 'eq.' + remote.updated_at) { rejected++; return route.fulfill({ json: [] }); }
              remote = { id: 'namofood', ...request.postDataJSON() }; commits.push(clone(remote));
              return route.fulfill({ json: [{ id: 'namofood' }] });
            }
            assert.equal(request.method(), 'POST', 'only snapshots may be inserted after the room exists');
            const rows = request.postDataJSON();
            assert(Array.isArray(rows) && rows.every(row => row.id.startsWith('namofood@')), 'backups must not replace the shared room');
            backups++; return route.fulfill({ json: [] });
          }
          return route.abort();
        } catch (error) { routeErrors.push(error); return route.abort(); }
      });
      await page.goto('https://offline.namofood.test/');
      await page.evaluate(() => {
        clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer);
        cloud.url = 'https://offline-cloud.namofood.test'; cloud.key = 'offline-anon-fixture';
        cloud.table = 'namofood_state'; cloud.room = 'namofood';
        cloudRemoteAt = null; cloudDirty = false; cloudBusy = false; lastInputAt = 0;
      });
    }
    const [a, b] = pages;
    const base = await a.evaluate(() => {
      const state = normalize(defaultState()); state.month = '2026-10';
      state.menus = { '2026-10': { '14|중식|2': '기존 수동주찬', '14|중식|n': '250', '15|석식|2': '원격 수동주찬' } };
      state.menuPlanMeta = { '2026-10-14|중식': { by: 'manual', runId: 'fixture-baseline' }, '2026-10-15|석식': { by: 'manual', runId: 'fixture-peer' } };
      state.headcountMeta = { '2026-10-14|중식': { by: 'manual', updated: '2026-10-01' } };
      state.staff = [{ id: 'active-fixture', name: '현직 검증직원', role: '조리', wage: 15000, bonus: 1000, def: { s: '09:00', e: '18:00', b: 60 }, off: [] }];
      state.staffArchive = [{ id: 'archive-fixture', name: '보관 검증직원', role: '보조', wage: 13000, archivedWage: 13000, bonus: 0, def: { s: '09:00', e: '18:00', b: 60 }, off: [], archivedAt: '2026-09-01T00:00:00.000Z' }];
      state.staffEdits = { 'archive-fixture': { at: '2026-09-01T00:00:00.000Z', status: 'archive' } }; state.staffFieldEdits = {}; state.rosterEdits = { '2026-09': {}, '2026-10': {} };
      state.roster = { '2026-09': { 'archive-fixture|2': { s: '22:00', e: '06:00', b: 60 } }, '2026-10': { 'active-fixture|14': { s: '09:00', e: '18:00', b: 60 } } };
      state.recipes = ['기존 수동주찬', '원격 수동주찬', 'PC A 수동주찬'].map(menu => ({ menu, item: '검증재료', qty: 100, unit: 'g', comp: '주찬' }));
      state.methods = {}; state.sources = {}; state.recipeMeta = {}; state.recipeAsk = {};
      state.purch = []; state.purchEdit = {}; state.stock = []; state.stockLog = [];
      state.view = { range: 'day', mode: 'public', ing: false, printMeals: ['중식', '석식', '야식'] };
      state.settings.tax = .1; state.settings.vacancy = .1; state.settings.target = .08; state.settings.burden = .18;
      state.settings.tickets = { '조식': 10000, '중식': 10000, '석식': 10000, '야식': 10000 };
      state.settings.foodOverride = { '2026-09': 900000 };
      S = state; return structuredClone(state);
    });
    const wrap = async (state, updated_at) => ({ id: 'namofood', data: await a.evaluate(async ({ state, password }) => encryptText(password, JSON.stringify(state)), { state, password }), updated_at });
    const put = async (state, at = '2026-10-01T00:00:00.000Z') => { remote = await wrap(state, at); };
    const readRemote = async () => a.evaluate(async ({ row, password }) => JSON.parse(await decryptText(password, row.data)), { row: remote, password });
    await put(base);
    for (const page of pages) {
      assert.equal(await page.evaluate(() => cloudLoad(false)), true, 'real cloudLoad establishes each client baseline');
      await page.evaluate(() => { go('menu'); clearTimeout(cloudTimer); clearTimeout(saveTimer); });
      assert.deepEqual(await page.locator('input[data-print-meal]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.printMeal)), noBreakfast);
    }
    const save = async page => {
      await quiesce(page);
      await page.evaluate(() => cloudSave(true));
      await quiesce(page);
      assert.equal(await page.evaluate(() => cloudBusy), false, 'save completed');
      if (routeErrors.length) throw routeErrors[0];
    };
    const poll = page => page.evaluate(() => { lastInputAt = 0; return cloudLoad(true); });
    const check = () => { if (routeErrors.length) throw routeErrors[0]; };
    return { a, b, base, put, wrap, save, poll, readRemote, check, commits, count: () => ({ patches, backups, rejected }), conflict: row => { conflictRow = row; }, close: async () => { await Promise.all(contexts.map(context => context.close())); } };
  } catch (error) { await Promise.all(contexts.map(context => context.close())); throw error; }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const failures = [], passed = [];
  async function run(name, scenario) {
    const f = await fixture(browser);
    try { await scenario(f); f.check(); passed.push(name); console.log('PASS ' + name); }
    catch (error) { failures.push({ name, error }); console.error('FAIL ' + name + ': ' + error.message); }
    finally { await f.close(); }
  }
  try {
    await run('STALE_PC_MENU_STAFF_SAVE_CANNOT_REVERT_BREAKFAST', async f => {
      await f.b.locator('input[data-print-meal="조식"]').check();
      await f.save(f.b);
      const peer = await f.readRemote();
      assert.deepEqual(peer.view.printMeals, allMeals, 'PC B enabled breakfast through its real checkbox and saved it');
      assert.deepEqual(protectedData(peer), protectedData(f.base), 'changing print selection preserves all meal and staff data');
      assert.deepEqual((await stateOf(f.a)).view.printMeals, noBreakfast, 'PC A is authentically stale before its unrelated save');
      await f.a.evaluate(() => { menuSet(14, '중식', '2', 'PC A 수동주찬'); setStaffField('active-fixture', 'wage', 17000); });
      const local = await stateOf(f.a);
      await f.save(f.a);
      const committed = await f.readRemote();
      assert.deepEqual(committed.view.printMeals, allMeals, 'PC A saving meals/staff must not put its stale breakfast OFF over PC B ON');
      assert.deepEqual(protectedData(committed), protectedData(local), 'exact local meal/staff changes and all historical values are retained');
      assert.deepEqual((await stateOf(f.a)).view.printMeals, allMeals, 'PC A updates its own print UI after merging the server');
      assert.equal(await f.a.locator('input[data-print-meal="조식"]').isChecked(), true, 'PC A actual visible checkbox reflects the merged breakfast ON value');
      await f.save(f.a); await f.save(f.a);
      assert.deepEqual((await f.readRemote()).view.printMeals, allMeals, 'repeated idle saves cannot resurrect the old OFF value');
      await f.poll(f.b);
      assert.equal(await f.b.locator('input[data-print-meal="조식"]').isChecked(), true, 'PC B remains ON after receiving PC A saves');
      assert.deepEqual(protectedData(await stateOf(f.b)), protectedData(local), 'PC B receives the exact changed meal/wage and historical data');
      assert.equal(f.count().rejected, 0, 'this failure requires no artificial CAS conflict');
      assert(f.count().patches >= 4 && f.count().backups >= 4);
    });
    await run('STALE_GENERIC_SETTINGS_ADOPT_NEW_REMOTE_VALUES', async f => {
      await f.b.evaluate(() => {
        S.settings.tax = .13; S.settings.burden = .22;
        S.settings.meals['석식'].cost = 4400; S.settings.tickets['석식'] = 11500;
        S.settings.cafe.price = 5200; S.settings.shifts.B.end = '19:00';
        delete S.settings.foodOverride['2026-09'];
        setView('range', 'week'); setPrintMeal('조식', true); save();
      });
      await f.save(f.b);
      const peer = await f.readRemote();
      await f.a.evaluate(() => menuSet(14, '중식', '2', 'PC A 수동주찬'));
      const local = await stateOf(f.a);
      await f.save(f.a);
      const committed = await f.readRemote();
      assert.deepEqual(committed.settings, peer.settings, 'unrelated menu save must adopt every newer generic setting, including nested objects');
      assert.deepEqual(committed.view, peer.view, 'an unchanged local view cannot replace peer print/range preferences');
      assert.deepEqual(protectedData(committed), protectedData(local));
      assert.deepEqual((await stateOf(f.a)).settings, peer.settings, 'merged settings update the open client as well as its ciphertext');
    });
    await run('PENDING_LOCAL_AND_DISTINCT_NESTED_PEER_SETTINGS_MERGE', async f => {
      await f.b.evaluate(() => {
        S.settings.tax = .14; S.settings.tickets['석식'] = 11500;
        S.settings.meals['석식'].cost = 4400; S.settings.shifts.B.end = '19:00';
        setView('mode', 'internal'); setPrintMeal('조식', true); save();
      });
      await f.save(f.b);
      const peer = await f.readRemote();
      await f.a.evaluate(() => {
        S.settings.target = .12; S.settings.tickets['중식'] = 12500;
        S.settings.meals['조식'].count = 135; S.settings.shifts.B.start = '11:00';
        delete S.settings.foodOverride['2026-09']; S.settings.foodOverride['2026-10'] = 1200000;
        setView('range', 'week'); save();
      });
      const expectedSettings = clone(peer.settings);
      expectedSettings.target = .12; expectedSettings.tickets['중식'] = 12500;
      expectedSettings.meals['조식'].count = 135; expectedSettings.shifts.B.start = '11:00';
      delete expectedSettings.foodOverride['2026-09']; expectedSettings.foodOverride['2026-10'] = 1200000;
      await f.save(f.a);
      const committed = await f.readRemote();
      assert.deepEqual(committed.settings, expectedSettings, 'distinct nested leaves merge while explicit local additions/deletions survive');
      assert.deepEqual(committed.view, { range: 'week', mode: 'internal', ing: false, printMeals: allMeals }, 'local range, peer mode and peer print subset are independent choices');
      assert.deepEqual(protectedData(committed), protectedData(f.base), 'settings reconciliation cannot modify meals, employee fields or historical payroll data');
    });
    await run('CAS_RETRY_REBASES_CONFIG_WITHOUT_PROMOTING_REMOTE_TO_LOCAL_EDIT', async f => {
      const peer = clone(f.base); peer.settings.tax = .13; peer.view.printMeals = allMeals;
      await f.put(peer, '2026-10-02T00:00:00.000Z');
      const newer = clone(peer); newer.settings.tax = .17; newer.settings.tickets['석식'] = 11700; newer.view.mode = 'internal';
      f.conflict(await f.wrap(newer, '2026-10-02T00:00:01.000Z'));
      await f.a.evaluate(() => { S.settings.target = .12; setView('range', 'week'); save(); });
      await f.save(f.a);
      assert.equal(f.count().rejected, 1, 'the fake server actually rejects the first CAS after another client changes the room');
      assert.equal(f.commits.length, 0, 'rejected ciphertext never becomes a shared commit');
      assert.equal(await f.a.evaluate(() => cloudDirty), true, 'CAS rejection leaves the local save pending');
      await f.save(f.a);
      const committed = await f.readRemote(), expected = clone(newer.settings); expected.target = .12;
      assert.equal(f.count().patches, 2);
      assert.deepEqual(committed.settings, expected, 'retry adopts the second remote tax/ticket values and retains the independently edited local target');
      assert.deepEqual(committed.view, { range: 'week', mode: 'internal', ing: false, printMeals: allMeals });
      assert.deepEqual(protectedData(committed), protectedData(f.base));
    });
    await run('SETTINGS_EDIT_DURING_ENCRYPTION_IS_NOT_BASELINED_AS_ALREADY_SENT', async f => {
      await f.a.evaluate(() => {
        const original = encryptText;
        encryptText = async (pw, text) => {
          const encrypted = await original(pw, text);
          if (window.__settingsEditDuringEncryption) {
            window.__settingsEditDuringEncryption = false;
            S.settings.tax = .14; setView('range', 'week'); save();
          }
          return encrypted;
        };
        S.settings.tax = .12; save(); window.__settingsEditDuringEncryption = true;
      });
      await f.save(f.a);
      const firstSent = await f.readRemote();
      assert.equal(firstSent.settings.tax, .12, 'the first ciphertext contains the snapshot captured before the late user edit');
      assert.equal((await stateOf(f.a)).settings.tax, .14, 'the later user edit remains visible');
      const peer = clone(firstSent); peer.settings.tax = .13; peer.settings.tickets['석식'] = 11800; peer.view.range = 'month'; peer.view.printMeals = allMeals;
      await f.put(peer, '2026-10-03T00:00:00.000Z');
      await f.save(f.a);
      const committed = await f.readRemote(), expected = clone(peer.settings); expected.tax = .14;
      assert.deepEqual(committed.settings, expected, 'late local tax change beats a later peer tax while the untouched peer ticket value merges');
      assert.deepEqual(committed.view, { range: 'week', mode: 'public', ing: false, printMeals: allMeals }, 'late local range is pending, and unchanged print selection adopts the server');
      assert.deepEqual(protectedData(committed), protectedData(f.base));
    });
    await run('DISTINCT_REMOTE_REVISION_WITHIN_1500MS_IS_APPLIED', async f => {
      const peer = clone(f.base); peer.settings.tax = .17; peer.view.printMeals = allMeals;
      await f.put(peer, '2026-10-01T00:00:00.500Z');
      assert.equal(await f.poll(f.a), true, 'a distinct shared revision only 500ms later must be loaded');
      const loaded = await stateOf(f.a);
      assert.equal(loaded.settings.tax, .17);
      assert.equal(await f.a.locator('input[data-print-meal="조식"]').isChecked(), true, 'rapid peer breakfast change reaches the visible checkbox');
      assert.deepEqual(protectedData(loaded), protectedData(f.base));
    });
    await run('SAME_TIMESTAMP_DIFFERENT_CIPHERTEXT_IS_A_NEW_REVISION', async f => {
      const peer = clone(f.base); peer.settings.tax = .19; peer.view.printMeals = allMeals;
      await f.put(peer, '2026-10-01T00:00:00.000Z');
      assert.equal(await f.poll(f.a), true, 'the same millisecond with different encrypted data is still a peer revision');
      const loaded = await stateOf(f.a);
      assert.equal(loaded.settings.tax, .19);
      assert.deepEqual(loaded.view.printMeals, allMeals);
      assert.deepEqual(protectedData(loaded), protectedData(f.base));
      assert.equal(await f.poll(f.a), false, 'an exact duplicate timestamp and ciphertext is skipped');
      assert.deepEqual(protectedData(await stateOf(f.a)), protectedData(loaded));
    });
    await run('LAZILY_ADDED_SETTING_OBJECTS_MERGE_ZERO_AND_NULL_LEAVES', async f => {
      const optionalBaseline = clone(f.base);
      delete optionalBaseline.settings.tickets; delete optionalBaseline.settings.foodOverride;
      optionalBaseline.settings.opdays = 24;
      await f.put(optionalBaseline, '2026-10-05T00:00:00.000Z');
      for (const page of [f.a, f.b]) assert.equal(await page.evaluate(() => cloudLoad(false)), true, 'cloudLoad establishes a baseline before optional setting maps exist');
      await f.b.evaluate(() => {
        S.settings.tickets = { '석식': 11900, '야식': 11950 };
        S.settings.foodOverride = { '2026-09': 1300000 };
        S.settings.opdays = 26; save();
      });
      await f.save(f.b);
      const peer = await f.readRemote();
      await f.a.evaluate(() => {
        S.settings.tickets = { '중식': 12500, '조식': 0 };
        S.settings.foodOverride = { '2026-10': null };
        S.settings.opdays = null; setPrintMeal('조식', true); save();
      });
      await f.save(f.a);
      const committed = await f.readRemote(), expected = clone(peer.settings);
      expected.tickets = { '석식': 11900, '야식': 11950, '중식': 12500, '조식': 0 };
      expected.foodOverride = { '2026-09': 1300000, '2026-10': null }; expected.opdays = null;
      assert.deepEqual(committed.settings, expected, 'independently created nested maps merge, zero is a value, and an intentional null remains null');
      assert.deepEqual(committed.view.printMeals, allMeals, 'pending local print selection survives unrelated server setting changes');
      assert.deepEqual(protectedData(committed), protectedData(f.base));
    });
    for (const silent of [true, false]) await run('SETTINGS_TYPED_DURING_ASYNC_' + (silent ? 'SILENT' : 'MANUAL') + '_PULL_SURVIVE_AND_MERGE_ON_SAVE', async f => {
      const peer = clone(f.base); peer.settings.target = .15; peer.view.printMeals = allMeals;
      peer.menus['2026-10']['15|석식|2'] = 'PC A 수동주찬';
      await f.put(peer, '2026-10-04T00:00:00.000Z');
      await f.a.evaluate(() => {
        go('settings');
        const original = decryptText;
        window.__settingsPullReady = false;
        decryptText = async (pw, data) => {
          const decoded = await original(pw, data);
          if (window.__holdSettingsPull) {
            window.__holdSettingsPull = false; window.__settingsPullReady = true;
            await new Promise(resolve => { window.__releaseSettingsPull = resolve; });
          }
          return decoded;
        };
        window.__holdSettingsPull = true;
      });
      const pull = f.a.evaluate(silent => cloudLoad(silent), silent);
      await f.a.waitForFunction(() => window.__settingsPullReady);
      const vacancyInput = f.a.locator('input[onchange*="[\'vacancy\']"]');
      assert.equal(await vacancyInput.count(), 1, 'the real Settings vacancy field is present');
      await vacancyInput.fill('12'); await vacancyInput.press('Tab');
      assert.equal((await stateOf(f.a)).settings.vacancy, .12, 'real input change sets local vacancy before the pending pull resumes');
      await f.a.evaluate(() => window.__releaseSettingsPull());
      await pull;
      assert.equal((await stateOf(f.a)).settings.vacancy, .12, 'finishing an older async pull cannot overwrite a setting just typed by the user');
      await f.save(f.a);
      const committed = await f.readRemote(), expected = clone(peer.settings); expected.vacancy = .12;
      assert.deepEqual(committed.settings, expected, 'next save retains the typed vacancy and merges unrelated peer settings');
      assert.deepEqual(committed.view.printMeals, allMeals);
      assert.deepEqual(protectedData(committed), protectedData(peer), 'unrelated peer meal edit and every employee record survive');
    });
    await run('UNCOMMITTED_INPUT_SURVIVES_PULL_AFTER_SIX_SECOND_TYPING_GUARD', async f => {
      const peer = clone(f.base); peer.settings.target = .15; peer.view.printMeals = allMeals;
      await f.put(peer, '2026-10-06T00:00:00.000Z');
      await f.a.evaluate(() => {
        go('settings');
        const original = decryptText;
        window.__settingsPullReady = false;
        decryptText = async (pw, data) => {
          const decoded = await original(pw, data);
          if (window.__holdSettingsPull) {
            window.__holdSettingsPull = false; window.__settingsPullReady = true;
            await new Promise(resolve => { window.__releaseSettingsPull = resolve; });
          }
          return decoded;
        };
        window.__holdSettingsPull = true;
      });
      const pull = f.a.evaluate(() => cloudLoad(true));
      await f.a.waitForFunction(() => window.__settingsPullReady);
      const vacancyInput = f.a.locator('input[onchange*="[\'vacancy\']"]');
      await vacancyInput.fill('12');
      assert.equal(await vacancyInput.inputValue(), '12');
      assert.equal((await stateOf(f.a)).settings.vacancy, .1, 'typing remains uncommitted until this real onchange field loses focus');
      await f.a.waitForTimeout(6100);
      assert(await f.a.evaluate(() => Date.now() - lastInputAt >= 6000), 'the ordinary time-based typing guard has actually expired');
      await f.a.evaluate(() => window.__releaseSettingsPull());
      await pull;
      assert.equal(await vacancyInput.inputValue(), '12', 'an async pull begun before typing must preserve the still-focused raw field even after six seconds');
      await vacancyInput.press('Tab');
      assert.equal((await stateOf(f.a)).settings.vacancy, .12, 'blur commits the preserved typed value');
      await f.save(f.a);
      const committed = await f.readRemote(), expected = clone(peer.settings); expected.vacancy = .12;
      assert.deepEqual(committed.settings, expected);
      assert.deepEqual(committed.view.printMeals, allMeals);
      assert.deepEqual(protectedData(committed), protectedData(f.base));
    });
    await run('EXPLICIT_BACKUP_CONFIG_REPLACEMENT_SURVIVES_CAS_AND_IS_CONSUMED', async f => {
      const peer = clone(f.base);
      peer.settings.tax = .17; peer.settings.tickets['중식'] = 17000;
      peer.view.mode = 'internal'; peer.view.printMeals = allMeals;
      peer.staff[0].wage = 18000;
      peer.staffFieldEdits['active-fixture'] = { wage: { at: '2026-10-07T00:00:00.000Z' } };
      peer.roster['2026-09']['archive-fixture|3'] = { s: '23:00', e: '07:00', b: 60 };
      await f.put(peer, '2026-10-07T00:00:00.000Z');
      const newer = clone(peer); newer.settings.tax = .19;
      newer.roster['2026-09']['archive-fixture|4'] = { s: '09:00', e: '18:00', b: 60 };
      f.conflict(await f.wrap(newer, '2026-10-07T00:00:01.000Z'));
      await f.a.evaluate(restored => { applyState(restored, true); save(); render(); }, f.base);
      assert.deepEqual((await stateOf(f.a)).settings, f.base.settings, 'explicit backup applies the selected old settings even when they equal the previous cloud baseline');
      await f.save(f.a);
      assert.equal(f.count().rejected, 1, 'another client advances the room during this explicit restore');
      assert.equal(f.commits.length, 0, 'a failed CAS has not consumed the replacement by committing it');
      await f.save(f.a);
      const restored = await f.readRemote();
      assert.deepEqual(restored.settings, f.base.settings, 'explicitly selected backup settings survive ordinary remote merge and its CAS retry');
      assert.deepEqual(restored.view, f.base.view, 'explicit backup print/view choices are preserved with the settings');
      assert.deepEqual(protectedData(restored), protectedData(newer), 'newer staff wage and every existing/concurrent historical roster cell remain protected');
      const nextPeer = clone(restored); nextPeer.settings.tax = .23; nextPeer.view.printMeals = allMeals;
      await f.put(nextPeer, '2026-10-08T00:00:00.000Z');
      await f.a.evaluate(() => menuSet(14, '중식', '2', 'PC A 수동주찬'));
      const local = await stateOf(f.a);
      await f.save(f.a);
      const committed = await f.readRemote();
      assert.deepEqual(committed.settings, nextPeer.settings, 'successful restore consumes its special replacement intent so subsequent ordinary saves adopt peer settings again');
      assert.deepEqual(committed.view, nextPeer.view, 'later peer breakfast ON is adopted after the explicit restore was completed');
      assert.deepEqual(protectedData(committed), protectedData(local), 'the next normal save retains the local manual meal and protected staff/history');
    });
    console.log('APP_SOURCE_SHA256 ' + createHash('sha256').update(source).digest('hex'));
    if (negativeControl) console.log('DISPOSABLE_NEGATIVE_CONTROL ' + negativeControl + ' SOURCE_FILE_SHA256 ' + sourceFileHash);
    console.log('CLOUD_SETTINGS_RESULTS ' + JSON.stringify({ passed, failed: failures.map(failure => failure.name) }));
    if (failures.length) throw new AggregateError(failures.map(failure => failure.error), 'Cloud settings regression failures: ' + failures.length);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
