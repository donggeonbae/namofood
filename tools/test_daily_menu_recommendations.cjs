// Recommendation HTTP transport is mocked; recipe classification and UI are real.
// All other outbound requests are blocked. No production data or writes are used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash, createHmac} = require('node:crypto');
const {chromium} = require('playwright');
const password = 'daily-recommend-fixture-password';
const date = '2026-10-12';
const expected = {
  '1': ['된장국', '미역국', '어묵국'],
  '2': ['제육볶음', '닭갈비', '소불고기'],
  '7': ['고등어구이', '생선까스', '오징어볶음'],
  '8': ['계란말이', '두부부침', '만두튀김'],
  '3': ['콩나물무침', '시금치나물', '배추김치'],
  '4': ['오이무침', '숙주나물', '가지볶음'],
};
const slotOrder = ['1', '2', '7', '8', '3', '4'];
const aiReply = (day, model = 'mock-ai-provider') => ({ok: true, date: day, source: 'ai', model, generatedAt: '2026-10-09T09:00:00.000Z', slots: Object.fromEntries(Object.entries(expected).map(([ci, names]) => [ci, names.map(name => ({name, reason: '등록된 대량 조리 메뉴를 추천합니다.'}))])), aliases: {'돈육고추장볶음': '제육볶음', '제육볶음': '제육볶음'}, excludedCount: 0, warnings: []});

(async () => {
  const source = fs.readFileSync(process.env.NMF_APP_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
  for (const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(match[1]);
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [], routeErrors = [], requests = [], responses = new Map(), held = new Map();
    let forbiddenWrites = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request();
      if (req.isNavigationRequest()) return route.fulfill({contentType: 'text/html', body: source});
      if (req.url().endsWith('/functions/v1/nmf-menu-recommend')) {
        try {
        const body = req.postDataJSON(), headers = req.headers();
        assert.equal(req.method(), 'POST');
        assert.deepEqual(Object.keys(body).sort(), ['date', 'nonce']);
        assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(typeof body.nonce, 'string'); assert(body.nonce.length >= 8);
        assert.match(headers['x-nmf-time'] || '', /^\d+$/);
        const signature = createHmac('sha256', password).update(`nmf-menu-recommend:${body.date}:${body.nonce}:${headers['x-nmf-time']}`).digest('hex');
        assert.equal(headers['x-nmf-signature'], signature, 'request signs its date, nonce and timestamp');
        assert(headers.apikey, 'the existing public API-key header is retained');
        requests.push(body);
        const planned = responses.get(body.date);
        if (planned?.hold) await new Promise(resolve => held.set(body.date, resolve));
        if (planned?.offline) return route.abort('internetdisconnected');
        return route.fulfill({status: planned?.status || 200, json: planned?.json || aiReply(body.date)});
        } catch (error) {routeErrors.push(error); return route.fulfill({status: 500, json: {ok: false, error: 'mock transport assertion failed'}});}
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) forbiddenWrites++;
      if (req.url().includes('/rest/v1/namofood_state') && req.method() === 'GET') return route.fulfill({json: []});
      return route.abort();
    });
    await page.goto('https://namofood.test/');
    await page.evaluate(password => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); cloudApplying = true;
      sessionStorage.setItem('nmf_session_pw', password);
      S.month = '2026-10'; S.view = {range: 'day', mode: 'public', ing: false};
      S.recipes = []; S.methods = {}; S.recipeMeta = {}; S.recipeAsk = {}; S.sources = {};
      S.staff = []; S.staffArchive = []; S.roster = {}; S.rosterEdits = {};
      const add = (menu, item, comp = '주찬') => {S.recipes.push({menu, item, comp, qty: 100, unit: 'g', loss: 0}); S.methods[menu] = '식수를 확인하고 대형 조리기구에서 배치별로 조리한다.';};
      for (const soup of ['된장국', '미역국', '어묵국']) add(soup, '두부', '국');
      add('제육볶음', '돼지고기'); add('닭갈비', '닭고기'); add('소불고기', '소고기');
      add('고등어구이', '고등어'); add('생선까스', '흰살생선'); add('오징어볶음', '오징어');
      add('계란말이', '달걀'); add('두부부침', '두부'); add('만두튀김', '만두');
      for (const [name, item] of [['콩나물무침', '콩나물'], ['시금치나물', '시금치'], ['오이무침', '오이'], ['숙주나물', '숙주'], ['가지볶음', '가지']]) add(name, item, '부찬');
      add('배추김치', '배추', '김치'); add('훈제오리구이', '오리고기'); add('쌀밥', '쌀', '밥'); add('푸딩', '우유', '후식');
      S.menus = {'2026-10': {'12|중식|0': '쌀밥', '12|중식|1': '수동국', '12|중식|2': '수동고기', '12|중식|7': '수동생선', '12|중식|n': '333', '12|석식|2': '다른 끼니 고기', '13|중식|2': '다음 날 고기'}};
      S.menuPlanMeta = {'2026-10-12|중식': {by: 'manual'}}; S.menuManualEdits = {};
      S.headcountMeta = {'2026-10-12|중식': {by: 'manual', source: 'preserve'}};
      S.menuAutomation = {enabled: false, policy: 'manual-menu-v1'}; S.settings.fixtureSentinel = {value: 'preserve'};
      selDay = 12; viewCfg(); go('menu'); clearTimeout(saveTimer); clearTimeout(cloudTimer); localStorage.setItem(KEY, JSON.stringify(S));
    }, password);
    assert.equal(await page.locator('#menu-recommendations').count(), 1, 'daily editing exposes an explicit AI-recommendation panel');
    assert.equal(requests.length, 0, 'rendering never calls AI automatically');
    const before = await page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)}));
    const snapshot = () => page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)}));
    const settled = async () => {await page.waitForFunction(() => !menuRecommend.busy); if (routeErrors.length) throw routeErrors[0];};
    const chooseDate = async day => {await page.locator('#menu-recommend-date').fill(day); await page.locator('#menu-recommend-date').blur();};
    const namesAt = ci => page.locator(`#menu-recommendations button[data-recommend-slot="${ci}"]`).evaluateAll(buttons => buttons.map(button => button.dataset.recommendName));
    await page.locator('#menu-recommend-date').fill(date);
    await page.locator('#menu-recommend-load').click();
    await settled(); assert(await page.evaluate(() => !!menuRecommend.data), 'a valid AI response is displayed');
    assert.equal(requests.length, 1);
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 18);
    for (const ci of slotOrder) assert.deepEqual(await page.locator(`#menu-recommendations button[data-recommend-slot="${ci}"]`).evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected[ci]);
    assert.equal(await page.locator('#menu-recommend-meal').inputValue(), '중식');
    assert.deepEqual(await page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)})), before, 'fetching recommendations never edits saved meals, headcounts or other data');
    assert.match(await page.locator('#menu-recommendations').innerText(), /쌀밥/, 'default rice is explained without an extra AI menu slot');

    const afterFirst = requests.length;
    await page.evaluate(day => menuRecommendLoad(day), date); await settled();
    assert.equal(requests.length, afterFirst, 'the same date is served from the session cache');
    await chooseDate('2026-10-13');
    assert.equal(requests.length, afterFirst, 'changing dates is not an automatic AI call');
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 0, 'uncached dates cannot display the previous day bank');
    await page.locator('#menu-recommend-load').click(); await settled();
    assert.equal(requests.at(-1).date, '2026-10-13');
    assert.equal(await page.evaluate(() => menuRecommend.data.date), '2026-10-13');
    await chooseDate(date); await page.evaluate(day => menuRecommendLoad(day), date); await settled();
    const beforeRefresh = requests.length, firstNonce = requests.find(request => request.date === date).nonce;
    responses.set(date, {json: aiReply(date, 'mock-ai-refreshed')});
    await page.locator('#menu-recommend-refresh').click(); await settled();
    assert.equal(requests.length, beforeRefresh + 1); assert.notEqual(requests.at(-1).nonce, firstNonce, 'explicit refresh uses a new signed nonce');
    assert.equal(await page.evaluate(() => menuRecommend.data.model), 'mock-ai-refreshed');
    assert.deepEqual(await snapshot(), before, 'cache use and refresh remain ephemeral');

    await page.evaluate(() => openPicker(12, '중식', 2));
    assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').count(), 3, 'the actual meal picker shows only its three compatible AI suggestions');
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['2']);
    assert.equal(requests.length, beforeRefresh + 1, 'opening a cached picker does not call AI');
    await page.evaluate(() => closePicker());
    await page.evaluate(() => {recipeDraft.date = '2026-10-12'; openDraftPicker(7);});
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['7'], 'the draft picker uses its explicit target date and slot');
    await page.locator('#pk-recommendations button[data-recommend-name="생선까스"]').click();
    assert.equal(await page.evaluate(() => recipeDraft.slots[7]), '생선까스');
    assert.deepEqual(await snapshot(), before, 'explicit draft recommendation selection stays temporary');
    await page.evaluate(() => recipeDraftClear());

    await chooseDate('2026-11-11');
    const mainBeforePopup = await page.evaluate(() => ({date: menuRecommend.date, data: menuRecommend.data, error: menuRecommend.error, busy: menuRecommend.busy}));
    const beforePopupRequest = requests.length;
    await page.evaluate(() => openPicker(14, '중식', 2));
    await page.locator('#pk-recommendations button').filter({hasText: '추천 3개 보기'}).click();
    await page.waitForFunction(() => !!menuRecommendCached('2026-10-14') && !menuRecommendPending.has('2026-10-14'));
    if (routeErrors.length) throw routeErrors[0];
    assert.equal(requests.length, beforePopupRequest + 1);
    assert.equal(requests.at(-1).date, '2026-10-14', 'the picker requests its own captured meal date');
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['2']);
    assert.equal(await page.locator('#menu-recommend-date').inputValue(), '2026-11-11', 'popup recommendations do not replace a separately chosen main-panel date');
    assert.deepEqual(await page.evaluate(() => ({date: menuRecommend.date, data: menuRecommend.data, error: menuRecommend.error, busy: menuRecommend.busy})), mainBeforePopup, 'popup lookup does not leak request state into a different main date');
    assert.deepEqual(await snapshot(), before, 'popup lookup remains read-only');
    await page.evaluate(() => closePicker());

    responses.set('2026-10-15', {offline: true}); await chooseDate('2026-10-15');
    await page.locator('#menu-recommend-load').click(); await settled();
    assert(await page.evaluate(() => !!menuRecommend.error), 'an offline request exposes a real error');
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 0, 'network failures never become locally invented AI recommendations');
    assert.match(await page.locator('#menu-recommendations').innerText(), /실패|오류|다시|확인/, 'failure offers a visible retry path');
    const afterOffline = requests.length;
    await page.evaluate(() => {menuRecommend.followEditor = true; selDay = 19; render();});
    assert.equal(await page.locator('#menu-recommend-date').inputValue(), '2026-10-19');
    assert.equal(await page.locator('#menu-recommendations .menu-recommend-error').count(), 0, 'following another editor date cannot display the previous day failure');
    assert.equal(await page.evaluate(() => menuRecommend.error), '');
    assert.equal(requests.length, afterOffline, 'following editor dates remains an explicit-request workflow');
    await page.evaluate(() => {selDay = 15; render();});
    assert.equal(await page.locator('#menu-recommendations .menu-recommend-error').count(), 1, 'the failed date retains its own error until retry');
    await page.evaluate(() => {selDay = 12; render();});
    await chooseDate('2026-10-15');
    responses.delete('2026-10-15'); await page.locator('#menu-recommend-load').click(); await settled();
    assert.equal(await page.evaluate(() => menuRecommend.error), ''); assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 18, 'an explicit retry recovers normal recommendations');

    const hostile = aiReply('2026-10-16');
    hostile.slots['2'] = [{name: '생선까스', reason: 'wrong group'}, {name: '목록밖AI고기', reason: 'not registered'}, {name: '제육볶음', reason: '<img src=x onerror="window.dailyInjected=1">'}, {name: '제육볶음', reason: 'duplicate'}, {name: '소불고기', reason: 'valid'}, {name: '닭갈비', reason: 'valid'}, {name: '훈제오리구이', reason: 'fourth valid'}, {name: {bad: true}, reason: 'malformed'}];
    hostile.slots['7'].unshift({name: '제육볶음', reason: 'wrong group'});
    hostile.slots['8'].unshift({name: '배추김치', reason: 'wrong group'});
    hostile.slots['3'].unshift({name: '닭갈비', reason: 'wrong group'});
    responses.set('2026-10-16', {json: hostile}); await chooseDate('2026-10-16');
    await page.locator('#menu-recommend-load').click(); await settled();
    for (const ci of slotOrder) {
      const names = await namesAt(ci); assert(names.length <= 3, 'a hostile response cannot exceed three suggestions per slot');
      assert.equal(new Set(names).size, names.length, 'duplicates are removed');
      assert(await page.evaluate(({ci, names}) => names.every(name => !!recipeMap()[name] && recipeMatchesSlot(name, +ci)), {ci, names}), 'every displayed name belongs to the current real catalog and slot');
    }
    assert.equal(await page.evaluate(() => window.dailyInjected || 0), 0, 'recommendation names and reasons cannot execute HTML');
    assert.match(await page.locator('#menu-recommendations').innerText(), /제외|오류|등록|맞지|확인|응답/, 'rejected AI entries are communicated');
    assert.deepEqual(await snapshot(), before, 'malicious and incomplete recommendations cannot edit saved data');

    await chooseDate('2026-10-20'); await page.locator('#menu-recommend-load').click(); await settled();
    assert.deepEqual(await namesAt('2'), expected['2']);
    const beforeAlias = requests.length;
    await page.evaluate(() => {S.menus['2026-10']['21|중식|2'] = '돈육고추장볶음'; paintMenuRecommendations();});
    const aliasFixture = await snapshot();
    assert.deepEqual(await namesAt('2'), ['닭갈비', '소불고기'], 'unsaved nearby menus are revalidated against AI canonical aliases even with a cached bank');
    assert.equal(requests.length, beforeAlias, 'nearby-menu revalidation does not require another AI request');
    await page.evaluate(() => menuRecommendPick(2, '제육볶음', '중식', '2026-10-20'));
    assert.deepEqual(await snapshot(), aliasFixture, 'a direct choice cannot bypass current alias-aware duplicate checks');
    await page.evaluate(() => {delete S.menus['2026-10']['21|중식|2']; paintMenuRecommendations();});
    assert.deepEqual(await namesAt('2'), expected['2'], 'the cached bank is retained without destructive filtering');
    assert.deepEqual(await snapshot(), before, 'canonical checks do not persist or alter a temporary fixture change');

    const beforeCatalogChange = requests.length;
    await page.evaluate(() => {S.recipeAsk['닭갈비'] = {status: 'pending'}; paintMenuRecommendations();});
    const changedCatalogFixture = await snapshot();
    assert.equal(await page.evaluate(() => menuRecommendCached('2026-10-20')), null, 'a changed recipe catalog invalidates the old session cache');
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 0, 'stale recommendations disappear until an explicit valid reload');
    assert.equal(requests.length, beforeCatalogChange, 'catalog invalidation never starts AI automatically');
    await page.evaluate(() => menuRecommendPick(2, '닭갈비', '중식', '2026-10-20'));
    assert.deepEqual(await snapshot(), changedCatalogFixture, 'a stale cached candidate cannot be committed through a direct call');
    await page.evaluate(() => {delete S.recipeAsk['닭갈비']; paintMenuRecommendations();});
    assert.deepEqual(await namesAt('2'), expected['2']);
    assert.deepEqual(await snapshot(), before, 'catalog checks do not persist ephemeral recommendations');

    responses.set('2026-10-22', {json: aiReply('2026-10-23')}); await chooseDate('2026-10-22');
    await page.locator('#menu-recommend-load').click(); await settled();
    assert(await page.evaluate(() => !!menuRecommend.error), 'a mismatched response date is a failure, not usable AI advice');
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 0);
    responses.set('2026-10-22', {json: {...aiReply('2026-10-22'), source: 'local'}});
    await page.locator('#menu-recommend-load').click(); await settled();
    assert(await page.evaluate(() => !!menuRecommend.error), 'a non-AI source cannot be presented as AI recommendations');
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 0);
    const beforeInvalidDate = requests.length;
    assert.equal(await page.evaluate(() => menuRecommendLoad('2026-02-30')), false, 'nonexistent calendar dates are rejected before transport');
    assert.equal(requests.length, beforeInvalidDate);
    responses.delete('2026-10-22'); await page.locator('#menu-recommend-load').click(); await settled();
    assert.equal(await page.locator('#menu-recommendations button[data-recommend-name]').count(), 18, 'a valid retry recovers after rejected provenance');
    assert.deepEqual(await snapshot(), before, 'invalid dates and response provenance never mutate saved state');

    responses.set('2026-10-17', {hold: true, json: aiReply('2026-10-17', 'slow-old-date')});
    await chooseDate('2026-10-17');
    await page.evaluate(() => {window.slowRecommendation = menuRecommendLoad('2026-10-17', true);});
    await page.waitForFunction(() => menuRecommend.busy);
    assert.equal(await page.locator('#menu-recommend-load').isDisabled(), true, 'the active request exposes its busy state');
    for (let attempt = 0; attempt < 100 && !held.has('2026-10-17'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(held.has('2026-10-17'), 'the controlled old-date response is actually pending');
    await chooseDate('2026-10-18');
    await page.evaluate(() => {window.newRecommendation = menuRecommendLoad('2026-10-18', true);});
    await page.waitForFunction(() => !menuRecommend.busy && menuRecommend.data?.date === '2026-10-18');
    held.get('2026-10-17')(); await page.evaluate(() => window.slowRecommendation);
    assert.equal(await page.evaluate(() => menuRecommend.date), '2026-10-18');
    assert.equal(await page.evaluate(() => menuRecommend.data?.date), '2026-10-18', 'a late previous-day response cannot replace the chosen date');
    assert.equal(await page.evaluate(() => menuRecommend.data?.model), 'mock-ai-provider');
    assert.deepEqual(await snapshot(), before, 'busy/error/date races remain read-only');

    await chooseDate(date); await page.evaluate(day => menuRecommendLoad(day), date); await settled();
    const wrongPickBefore = await snapshot();
    await page.evaluate(day => menuRecommendPick(2, '생선까스', '중식', day), date);
    await page.evaluate(day => menuRecommendPick(2, '목록밖AI고기', '중식', day), date);
    assert.deepEqual(await snapshot(), wrongPickBefore, 'direct calls cannot bypass slot and catalog validation');
    let canceled = ''; page.once('dialog', async dialog => {canceled = dialog.message(); await dialog.dismiss();});
    await page.locator('#menu-recommendations button[data-recommend-slot="2"][data-recommend-name="제육볶음"]').click();
    assert.match(canceled, /수동고기|중식|바꿀|교체|덮어/);
    assert.deepEqual(await snapshot(), before, 'canceling replacement leaves all data untouched');
    const beforePick = await page.evaluate(() => structuredClone(S));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#menu-recommendations button[data-recommend-slot="2"][data-recommend-name="제육볶음"]').click();
    await page.waitForTimeout(500);
    const picked = await page.evaluate(() => structuredClone(S));
    const expectedMenus = structuredClone(beforePick.menus); expectedMenus['2026-10']['12|중식|2'] = '제육볶음';
    assert.deepEqual(picked.menus, expectedMenus, 'a confirmed recommendation changes exactly one explicitly chosen food cell');
    const unrelated = state => Object.fromEntries(Object.entries(state).filter(([key]) => !['menus', 'menuPlanMeta', 'menuManualEdits', 'updatedAt'].includes(key)));
    assert.deepEqual(unrelated(picked), unrelated(beforePick), 'headcounts, recipes, staff, prices, settings and automation policy are preserved');
    assert.deepEqual(Object.keys(picked.menuManualEdits['2026-10']), ['12|중식|2']);
    assert(Number.isFinite(Date.parse(picked.menuManualEdits['2026-10']['12|중식|2'].at)));
    assert.equal(picked.menuPlanMeta['2026-10-12|중식'], undefined, 'the chosen food is recorded as manual, not automatic AI');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).menus['2026-10']['12|중식|2']), '제육볶음', 'only an explicit choice is persisted locally');

    const beforePickerPick = await page.evaluate(() => structuredClone(S));
    const beforePickerRequest = requests.length;
    await page.evaluate(() => openPicker(12, '중식', 7));
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#pk-recommendations button[data-recommend-name="생선까스"]').click();
    await page.waitForTimeout(500);
    const pickerPicked = await page.evaluate(() => structuredClone(S));
    const pickerMenus = structuredClone(beforePickerPick.menus); pickerMenus['2026-10']['12|중식|7'] = '생선까스';
    assert.deepEqual(pickerPicked.menus, pickerMenus, 'an actual picker recommendation changes only its captured one meal slot');
    assert.deepEqual(unrelated(pickerPicked), unrelated(beforePickerPick));
    assert.deepEqual(pickerPicked.menuManualEdits['2026-10']['12|중식|2'], beforePickerPick.menuManualEdits['2026-10']['12|중식|2'], 'picker selection keeps other manual edit timestamps');
    assert.deepEqual(Object.keys(pickerPicked.menuManualEdits['2026-10']), ['12|중식|2', '12|중식|7']);
    assert(Number.isFinite(Date.parse(pickerPicked.menuManualEdits['2026-10']['12|중식|7'].at)));
    assert.equal(await page.locator('#picker').evaluate(element => element.classList.contains('show')), false);
    assert.equal(requests.length, beforePickerRequest, 'cached picker selection never starts a new AI request');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).menus['2026-10']['12|중식|7']), '생선까스');

    await chooseDate('2026-11-11'); await page.locator('#menu-recommend-load').click(); await settled();
    await page.locator('#menu-recommend-meal').selectOption('석식');
    const beforeOtherMonthPick = await page.evaluate(() => structuredClone(S));
    await page.locator('#menu-recommendations button[data-recommend-slot="7"][data-recommend-name="고등어구이"]').click();
    await page.waitForTimeout(500);
    const otherMonthPick = await page.evaluate(() => structuredClone(S));
    const otherMonthMenus = structuredClone(beforeOtherMonthPick.menus);
    otherMonthMenus['2026-11'] = {'11|석식|7': '고등어구이'};
    assert.deepEqual(otherMonthPick.menus, otherMonthMenus, 'the chosen target date and meal identify the one cell even outside the current month');
    assert.deepEqual(unrelated(otherMonthPick), unrelated(beforeOtherMonthPick), 'cross-month selection preserves the current month, headcounts, catalog and other state');
    assert.equal(otherMonthPick.month, '2026-10');
    assert.deepEqual(Object.keys(otherMonthPick.menuManualEdits['2026-11']), ['11|석식|7']);
    assert(Number.isFinite(Date.parse(otherMonthPick.menuManualEdits['2026-11']['11|석식|7'].at)));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).menus['2026-11']['11|석식|7']), '고등어구이');

    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({width, height: 900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `the recommendation page fits ${width}px`);
      assert(await page.locator('#menu-recommendations').evaluate(element => element.scrollWidth <= element.clientWidth), `the recommendation panel has no horizontal scroll at ${width}px`);
    }
    await page.emulateMedia({media: 'print'});
    assert.equal(await page.locator('#menu-recommendations').isVisible(), false, 'AI suggestion controls and reasons are excluded from print');
    await page.emulateMedia({media: 'screen'});
    assert.equal(forbiddenWrites, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({recommendations: 18, signedMockTransport: true, cacheDateSeparation: true, refreshNonce: true, pickerAndDraftSubset: true, popupDateIsolation: true, perDateErrors: true, unsavedNearbyCanonicalRevalidation: true, catalogCacheInvalidation: true, hostileResponsesRejected: true, responseProvenanceRejected: true, offlineRetry: true, lateDateResponseRejected: true, explicitSingleCellOnly: true, pickerSingleCellOnly: true, explicitCrossMonthTarget: true, unchangedHeadcountsAndOtherState: true, mobileWidths: [320, 390, 1280], printHidden: true, productionWrites: 0, sourceSha256: createHash('sha256').update(source).digest('hex')}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exit(1);});
