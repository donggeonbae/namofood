// Daily endpoint/cache safety contracts retained under the automatic weekly UX.
// Only recommendation HTTP responses are mocked; app validation and picks are real.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash, createHmac} = require('node:crypto');
const {chromium} = require('playwright');
const password = 'daily-recommend-fixture-password';
const date = '2026-10-12';
const expected = {
  '1': ['된장국', '미역국', '어묵국'], '2': ['제육볶음', '닭갈비', '소불고기'],
  '7': ['고등어구이', '생선까스', '오징어볶음'], '8': ['계란말이', '두부부침', '만두튀김'],
  '3': ['콩나물무침', '시금치나물', '배추김치'], '4': ['오이무침', '숙주나물', '가지볶음'],
};
const slotOrder = ['1', '2', '7', '8', '3', '4'];
const aiReply = (day, model = 'mock-ai-provider') => ({ok: true, date: day, source: 'ai', serverStored: true, storage: 'server', model, generatedAt: '2026-10-09T09:00:00.000Z', slots: Object.fromEntries(Object.entries(expected).map(([ci, names]) => [ci, names.map(name => ({name, reason: '등록된 대량 조리 메뉴를 추천합니다.'}))])), aliases: {'돈육고추장볶음': '제육볶음', '제육볶음': '제육볶음'}, excludedCount: 0, warnings: []});

(async () => {
  const source = fs.readFileSync(process.env.NMF_APP_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
  for (const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(match[1]);
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [], routeErrors = [], requests = [], requestTimes = [], responses = new Map(), held = new Map(), pendingReplies = new Set();
    let forbiddenWrites = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request();
      if (req.isNavigationRequest()) return route.fulfill({contentType: 'text/html', body: source});
      if (req.url().endsWith('/functions/v1/nmf-menu-recommend')) {
        try {
          const body = req.postDataJSON(), headers = req.headers();
          assert.equal(req.method(), 'POST'); assert.deepEqual(Object.keys(body).sort(), ['date', 'nonce']);
          assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/); assert.equal(typeof body.nonce, 'string'); assert(body.nonce.length >= 8);
          assert.match(headers['x-nmf-time'] || '', /^\d+$/);
          assert.equal(headers['x-nmf-signature'], createHmac('sha256', password).update(`nmf-menu-recommend:${body.date}:${body.nonce}:${headers['x-nmf-time']}`).digest('hex'));
          assert(headers.apikey); requests.push(body); requestTimes.push(headers['x-nmf-time']);
          const planned = responses.get(body.date);
          if (planned?.hold) await new Promise(resolve => held.set(body.date, resolve));
          if (planned?.offline) return route.abort('internetdisconnected');
          if (planned?.pendingForever || planned?.pendingRemaining > 0) {
            if (planned.pendingRemaining > 0) planned.pendingRemaining--;
            await route.fulfill({status: 202, json: {ok: false, reason: 'bank_pending', retryAfterSeconds: 0.01}});
            pendingReplies.add(body.date); return;
          }
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
      selDay = 12; viewCfg(); clearTimeout(saveTimer); clearTimeout(cloudTimer); localStorage.setItem(KEY, JSON.stringify(S));
    }, password);
    const snapshot = () => page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)}));
    const before = await snapshot();
    const load = async (day, refresh = false) => {await page.evaluate(({day, refresh}) => menuRecommendLoad(day, refresh, true), {day, refresh}); if (routeErrors.length) throw routeErrors[0];};
    const namesAt = async (day, ci) => page.evaluate(({day, ci}) => (menuRecommendCandidates(menuRecommendCached(day), day)[ci] || []).map(item => item.name), {day, ci});
    await load(date);
    assert.equal(requests.length, 1); for (const ci of slotOrder) assert.deepEqual(await namesAt(date, ci), expected[ci]);
    assert.deepEqual(await snapshot(), before, 'daily transport never edits saved meals, headcounts or other data');
    await load(date); assert.equal(requests.length, 1, 'the same date reuses its bank');
    const firstNonce = requests[0].nonce;
    responses.set(date, {json: aiReply(date, 'mock-ai-refreshed')}); await load(date, true);
    assert.equal(requests.length, 2); assert.notEqual(requests.at(-1).nonce, firstNonce); assert.equal(await page.evaluate(day => menuRecommendCached(day).model, date), 'mock-ai-refreshed');
    assert.deepEqual(await snapshot(), before, 'a replacement cache remains isolated');
    await page.evaluate(() => openPicker(12, '중식', 2));
    assert.equal(await page.locator('#pk-recommendations').evaluate(element => element.tagName), 'DETAILS', 'the picker AI recommendations are a native expandable section');
    assert.equal(await page.locator('#pk-recommendations').evaluate(element => element.open), false, 'a fresh meal picker starts with AI recommendations collapsed');
    await page.waitForFunction(() => !menuRecommendPending.size);
    assert.equal(await page.locator('#pk-recommend-content').isVisible(), false, 'asynchronous preparation does not expand a collapsed picker');
    assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').first().isVisible(), false, 'prepared AI choices are not shown before the user expands them');
    const beforePickerExpansion = requests.length;
    await page.locator('#pk-recommendations > summary').click();
    assert.equal(await page.locator('#pk-recommend-content').isVisible(), true);
    assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]:visible').count(), 3, 'one summary click reveals exactly three validated choices');
    await page.evaluate(() => {paintMenuRecommendations(); renderPickerList();});
    assert.equal(await page.locator('#pk-recommendations').evaluate(element => element.open), true, 'recommendation and picker filter updates preserve expansion');
    assert.equal(requests.length, beforePickerExpansion, 'expanding the existing AI bank does not make another recommendation request');
    assert.deepEqual(await snapshot(), before, 'recommendation expansion state remains outside application state and main storage');
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['2']);
    await page.evaluate(() => closePicker());
    await page.evaluate(() => {recipeDraft.date = '2026-10-12'; openDraftPicker(7);});
    assert.equal(await page.locator('#pk-recommendations').evaluate(element => element.open), false, 'a fresh draft picker does not inherit a previous meal picker expansion');
    await page.locator('#pk-recommendations > summary').click();
    await page.locator('#pk-recommendations button[data-recommend-name="생선까스"]').click();
    assert.equal(await page.evaluate(() => recipeDraft.slots[7]), '생선까스'); assert.deepEqual(await snapshot(), before); await page.evaluate(() => recipeDraftClear());

    const hostile = aiReply('2026-10-16');
    hostile.slots['2'] = [{name: '생선까스', reason: 'wrong group'}, {name: '목록밖AI고기', reason: 'not registered'}, {name: '제육볶음', reason: '<img src=x onerror="window.dailyInjected=1">'}, {name: '제육볶음', reason: 'duplicate'}, {name: '소불고기', reason: 'valid'}, {name: '닭갈비', reason: 'valid'}, {name: '훈제오리구이', reason: 'fourth valid'}, {name: {bad: true}, reason: 'malformed'}];
    hostile.slots['7'].unshift({name: '제육볶음', reason: 'wrong group'}); hostile.slots['8'].unshift({name: '배추김치', reason: 'wrong group'}); hostile.slots['3'].unshift({name: '닭갈비', reason: 'wrong group'});
    responses.set('2026-10-16', {json: hostile}); await load('2026-10-16', true);
    for (const ci of slotOrder) {
      const names = await namesAt('2026-10-16', ci); assert(names.length <= 3); assert.equal(new Set(names).size, names.length);
      assert(await page.evaluate(({ci, names}) => names.every(name => !!recipeMap()[name] && recipeMatchesSlot(name, +ci)), {ci, names}));
    }
    await page.evaluate(() => openPicker(16, '중식', 2));
    await page.locator('#pk-recommendations > summary').click();
    assert.equal(await page.evaluate(() => window.dailyInjected || 0), 0, 'recommendation text cannot execute HTML');
    assert.match(await page.locator('#pk-recommendations').innerText(), /제외|오류|등록|맞지|확인|응답/);
    await page.evaluate(() => closePicker()); assert.deepEqual(await snapshot(), before);

    await load('2026-10-20'); const beforeAlias = requests.length;
    await page.evaluate(() => {S.menus['2026-10']['21|중식|2'] = '돈육고추장볶음'; paintMenuRecommendations();});
    const aliasFixture = await snapshot();
    assert.deepEqual(await namesAt('2026-10-20', '2'), ['닭갈비', '소불고기']); assert.equal(requests.length, beforeAlias);
    await page.evaluate(() => menuRecommendPick(2, '제육볶음', '중식', '2026-10-20')); assert.deepEqual(await snapshot(), aliasFixture);
    await page.evaluate(() => {delete S.menus['2026-10']['21|중식|2']; paintMenuRecommendations();});
    assert.deepEqual(await namesAt('2026-10-20', '2'), expected['2']); assert.deepEqual(await snapshot(), before);
    await page.evaluate(() => {S.recipeAsk['닭갈비'] = {status: 'pending'}; paintMenuRecommendations();});
    const changedCatalog = await snapshot(); assert.equal(await page.evaluate(() => menuRecommendCached('2026-10-20')), null);
    await page.evaluate(() => menuRecommendPick(2, '닭갈비', '중식', '2026-10-20')); assert.deepEqual(await snapshot(), changedCatalog, 'a stale catalog candidate cannot be committed');
    await page.evaluate(() => {delete S.recipeAsk['닭갈비']; paintMenuRecommendations();});
    assert.deepEqual(await namesAt('2026-10-20', '2'), expected['2']); assert.deepEqual(await snapshot(), before);

    responses.set('2026-10-22', {json: aiReply('2026-10-23')}); await load('2026-10-22');
    assert(await page.evaluate(() => !!menuRecommendErrors.get('2026-10-22'))); assert.equal(await page.evaluate(() => menuRecommendCached('2026-10-22')), null);
    responses.set('2026-10-22', {json: {...aiReply('2026-10-22'), source: 'local'}}); await load('2026-10-22', true);
    assert(await page.evaluate(() => !!menuRecommendErrors.get('2026-10-22'))); assert.equal(await page.evaluate(() => menuRecommendCached('2026-10-22')), null);
    const beforeInvalid = requests.length; assert.equal(await page.evaluate(() => menuRecommendLoad('2026-02-30')), false); assert.equal(requests.length, beforeInvalid);
    responses.delete('2026-10-22'); await load('2026-10-22', true); assert.equal(await page.evaluate(() => menuRecommendErrors.get('2026-10-22') || ''), '');
    responses.set('2026-10-24', {offline: true}); await load('2026-10-24'); assert(await page.evaluate(() => !!menuRecommendErrors.get('2026-10-24')));
    assert.equal(await page.evaluate(() => menuRecommendCached('2026-10-24')), null); responses.delete('2026-10-24'); await load('2026-10-24', true);
    assert.equal(await page.evaluate(() => menuRecommendErrors.get('2026-10-24') || ''), ''); assert.deepEqual(await snapshot(), before);

    responses.set('2026-10-17', {hold: true, json: aiReply('2026-10-17', 'slow-old-date')});
    await page.evaluate(() => {window.slowRecommendation = menuRecommendLoad('2026-10-17', true);});
    for (let attempt = 0; attempt < 100 && !held.has('2026-10-17'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(held.has('2026-10-17')); await page.evaluate(() => menuRecommendLoad('2026-10-18', true));
    held.get('2026-10-17')(); await page.evaluate(() => window.slowRecommendation);
    assert.equal(await page.evaluate(() => menuRecommend.date), '2026-10-18'); assert.equal(await page.evaluate(() => menuRecommend.data?.date), '2026-10-18');
    assert.deepEqual(await snapshot(), before, 'late responses cannot replace another selected date or mutate data');

    const wrongPickBefore = await snapshot();
    await page.evaluate(day => menuRecommendPick(2, '생선까스', '중식', day), date); await page.evaluate(day => menuRecommendPick(2, '목록밖AI고기', '중식', day), date);
    assert.deepEqual(await snapshot(), wrongPickBefore, 'direct calls cannot bypass slot and catalog validation');
    await page.evaluate(() => openPicker(12, '중식', 2));
    await page.locator('#pk-recommendations > summary').click();
    let canceled = ''; page.once('dialog', async dialog => {canceled = dialog.message(); await dialog.dismiss();});
    await page.locator('#pk-recommendations button[data-recommend-name="제육볶음"]').click();
    assert.match(canceled, /수동고기|중식|바꿀|교체|덮어/); assert.deepEqual(await snapshot(), before);
    const beforePick = await page.evaluate(() => structuredClone(S)); page.once('dialog', dialog => dialog.accept());
    await page.locator('#pk-recommendations button[data-recommend-name="제육볶음"]').click(); await page.waitForTimeout(500);
    const picked = await page.evaluate(() => structuredClone(S)); const expectedMenus = structuredClone(beforePick.menus); expectedMenus['2026-10']['12|중식|2'] = '제육볶음';
    assert.deepEqual(picked.menus, expectedMenus, 'confirmed picker recommendation changes exactly one meal cell');
    const unrelated = state => Object.fromEntries(Object.entries(state).filter(([key]) => !['menus', 'menuPlanMeta', 'menuManualEdits', 'updatedAt'].includes(key)));
    assert.deepEqual(unrelated(picked), unrelated(beforePick)); assert.deepEqual(Object.keys(picked.menuManualEdits['2026-10']), ['12|중식|2']);
    assert(Number.isFinite(Date.parse(picked.menuManualEdits['2026-10']['12|중식|2'].at))); assert.equal(picked.menuPlanMeta['2026-10-12|중식'], undefined);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).menus['2026-10']['12|중식|2']), '제육볶음');
    const beforeSecond = await page.evaluate(() => structuredClone(S)); await page.evaluate(() => openPicker(12, '중식', 7));
    assert.equal(await page.locator('#pk-recommendations').evaluate(element => element.open), false, 'the next meal picker again starts collapsed');
    await page.locator('#pk-recommendations > summary').click();
    page.once('dialog', dialog => dialog.accept()); await page.locator('#pk-recommendations button[data-recommend-name="생선까스"]').click(); await page.waitForTimeout(500);
    const second = await page.evaluate(() => structuredClone(S)), secondMenus = structuredClone(beforeSecond.menus); secondMenus['2026-10']['12|중식|7'] = '생선까스';
    assert.deepEqual(second.menus, secondMenus); assert.deepEqual(unrelated(second), unrelated(beforeSecond));
    assert.deepEqual(second.menuManualEdits['2026-10']['12|중식|2'], beforeSecond.menuManualEdits['2026-10']['12|중식|2']);
    assert.deepEqual(Object.keys(second.menuManualEdits['2026-10']), ['12|중식|2', '12|중식|7']);
    assert.equal(await page.locator('#picker').evaluate(element => element.classList.contains('show')), false);
    await load('2026-11-11'); const beforeCross = await page.evaluate(() => structuredClone(S));
    await page.evaluate(() => {recipeDraft.date = '2026-11-11'; openDraftPicker(7);}); await page.waitForFunction(() => !menuRecommendPending.size); await page.evaluate(() => closePicker());
    await page.evaluate(() => menuRecommendPick(7, '고등어구이', '석식', '2026-11-11')); await page.waitForTimeout(500);
    const cross = await page.evaluate(() => structuredClone(S)), crossMenus = structuredClone(beforeCross.menus); crossMenus['2026-11'] = {'11|석식|7': '고등어구이'};
    assert.deepEqual(cross.menus, crossMenus); assert.deepEqual(unrelated(cross), unrelated(beforeCross)); assert.equal(cross.month, '2026-10');
    assert.deepEqual(Object.keys(cross.menuManualEdits['2026-11']), ['11|석식|7']);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(KEY)).menus['2026-11']['11|석식|7']), '고등어구이');

    const beforePendingState = await snapshot(), beforePendingCalls = requests.length;
    responses.set('2026-12-01', {pendingRemaining: 1});
    await load('2026-12-01');
    assert.equal(requests.length, beforePendingCalls + 2, 'a bank being generated on another device is polled once and then read when ready');
    assert.deepEqual(requests.slice(beforePendingCalls).map(row => row.date), ['2026-12-01', '2026-12-01'], 'pending polling remains scoped to the same server bank, not a replacement week');
    assert.equal(requests.at(-1).nonce, requests.at(-2).nonce, 'a pending poll retains the same recommendation-bank nonce');
    assert(Number(requestTimes.at(-1)) > Number(requestTimes.at(-2)), 'each pending-bank poll signs a fresh timestamp');
    assert.equal(await page.evaluate(() => menuRecommendErrors.get('2026-12-01') || ''), '', 'HTTP 202 is not shown as an AI failure while the server bank is being prepared');
    for (const ci of slotOrder) assert.deepEqual(await namesAt('2026-12-01', ci), expected[ci], 'the completed pending server bank supplies the same three validated candidates');
    assert.deepEqual(await snapshot(), beforePendingState, 'waiting for a server bank never changes meal plans or main app storage');

    // Advance only this final browser deadline case; all earlier UI and queue
    // scenarios use real timers. The signed transport boundary remains real.
    responses.set('2026-12-02', {pendingForever: true});
    await page.clock.install({time: new Date()});
    await page.evaluate(() => {window.pendingServerBankCheck = menuRecommendLoad('2026-12-02', false, true);});
    for (let attempt = 0; attempt < 100 && !pendingReplies.has('2026-12-02'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(pendingReplies.has('2026-12-02'), 'the timeout case received an actual pending-server response');
    await page.clock.fastForward(181000);
    await page.evaluate(() => window.pendingServerBankCheck);
    assert.equal(await page.evaluate(() => menuRecommendCached('2026-12-02')), null, 'an expired pending deadline never fabricates a recommendation bank');
    assert(await page.evaluate(() => !!menuRecommendErrors.get('2026-12-02')), 'an expired pending deadline is surfaced as an actionable error');
    const callsAfterPendingTimeout = requests.length;
    await page.evaluate(() => {paintMenuRecommendations(); menuRecommendEnsureWeek('2026-12-02');});
    await page.waitForFunction(() => !menuRecommendPending.size);
    assert.equal(requests.filter(row => row.date === '2026-12-02').length, requests.slice(0, callsAfterPendingTimeout).filter(row => row.date === '2026-12-02').length, 'rendering an expired pending bank never creates an automatic retry loop');
    assert.deepEqual(await snapshot(), beforePendingState, 'pending timeout errors also remain outside main application data');
    assert.equal(forbiddenWrites, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({recommendations: 18, recommendationPickerDefaultCollapsed: true, summaryRevealsThreeChoices: true, expandedPickerUpdateRetained: true, toggleDoesNotRequestOrSave: true, signedMockTransport: true, cacheDateSeparation: true, refreshNonce: true, pickerAndDraftSubset: true, unsavedNearbyCanonicalRevalidation: true, catalogCacheInvalidation: true, hostileResponsesRejected: true, responseProvenanceRejected: true, offlineRetry: true, pendingServerBankPolled: true, pendingPollFreshSignature: true, pendingServerDeadlineBounded: true, lateDateResponseRejected: true, explicitSingleCellOnly: true, pickerSingleCellOnly: true, explicitCrossMonthTarget: true, unchangedHeadcountsAndOtherState: true, productionWrites: 0, sourceSha256: createHash('sha256').update(source).digest('hex')}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exit(1);});
