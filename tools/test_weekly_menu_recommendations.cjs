// Only the signed, read-only recommendation transport is mocked. The app,
// catalog validation, week queue, browser persistence and picker are real.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash, createHmac} = require('node:crypto');
const {chromium} = require('playwright');
const password = 'weekly-recommend-fixture-password';
const week = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const expected = {
  '1': ['된장국', '미역국', '어묵국'],
  '2': ['제육볶음', '닭갈비', '소불고기'],
  '7': ['고등어구이', '생선까스', '오징어볶음'],
  '8': ['계란말이', '두부부침', '만두튀김'],
  '3': ['콩나물무침', '시금치나물', '배추김치'],
  '4': ['오이무침', '숙주나물', '가지볶음'],
};
const slotOrder = ['1', '2', '7', '8', '3', '4'];
const reply = day => ({ok: true, date: day, source: 'ai', model: 'mock-ai-provider', generatedAt: '2026-10-09T09:00:00.000Z', slots: Object.fromEntries(Object.entries(expected).map(([ci, names]) => [ci, names.map(name => ({name, reason: '등록된 대량 조리 메뉴를 추천합니다.'}))])), aliases: {'돈육고추장볶음': '제육볶음', '제육볶음': '제육볶음'}, excludedCount: 0, warnings: []});

(async () => {
  const source = fs.readFileSync(process.env.NMF_APP_SOURCE || path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
  for (const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Function(match[1]);
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await context.newPage();
    const errors = [], routeErrors = [], requests = [], responses = new Map(), held = new Map();
    let forbiddenWrites = 0, active = 0, maxActive = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request();
      if (req.isNavigationRequest()) return route.fulfill({contentType: 'text/html', body: source});
      if (req.url().endsWith('/functions/v1/nmf-menu-recommend')) {
        active++; maxActive = Math.max(maxActive, active);
        try {
          const body = req.postDataJSON(), headers = req.headers();
          assert.equal(req.method(), 'POST'); assert.deepEqual(Object.keys(body).sort(), ['date', 'nonce']);
          assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/); assert.equal(typeof body.nonce, 'string');
          assert.match(headers['x-nmf-time'] || '', /^\d+$/); assert(headers.apikey);
          const signature = createHmac('sha256', password).update(`nmf-menu-recommend:${body.date}:${body.nonce}:${headers['x-nmf-time']}`).digest('hex');
          assert.equal(headers['x-nmf-signature'], signature, 'the request signs its date, nonce and timestamp');
          requests.push(body);
          await new Promise(resolve => setTimeout(resolve, 100));
          const planned = responses.get(body.date);
          if (planned?.hold) await new Promise(resolve => held.set(body.date, resolve));
          if (planned?.offline) return route.abort('internetdisconnected');
          return route.fulfill({status: planned?.status || 200, json: planned?.json || reply(body.date)});
        } catch (error) {routeErrors.push(error); return route.fulfill({status: 500, json: {ok: false, error: 'mock transport assertion failed'}});}
        finally {active--;}
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
      S.staff = [{id: 'weekly-active', name: '보존 직원', role: '조리', wage: 15000, bonus: 0, def: {s: '09:00', e: '18:00', b: 60}, off: []}];
      S.staffArchive = [{id: 'weekly-archive', name: '보관 직원', role: '보조', wage: 13000, bonus: 0, def: {s: '09:00', e: '18:00', b: 60}, off: []}];
      S.roster = {'2026-10': {'weekly-active|1': {s: '09:00', e: '18:00', b: 60}, 'weekly-archive|1': {s: '09:00', e: '13:00', b: 0}}}; S.rosterEdits = {};
      const add = (menu, item, comp = '주찬') => {S.recipes.push({menu, item, comp, qty: 100, unit: 'g', loss: 0}); S.methods[menu] = '대형 조리기구에서 식수별로 배치 조리한다.';};
      for (const soup of ['된장국', '미역국', '어묵국']) add(soup, '두부', '국');
      add('제육볶음', '돼지고기'); add('닭갈비', '닭고기'); add('소불고기', '소고기');
      add('고등어구이', '고등어'); add('생선까스', '흰살생선'); add('오징어볶음', '오징어');
      add('계란말이', '달걀'); add('두부부침', '두부'); add('만두튀김', '만두');
      for (const [name, item] of [['콩나물무침', '콩나물'], ['시금치나물', '시금치'], ['오이무침', '오이'], ['숙주나물', '숙주'], ['가지볶음', '가지']]) add(name, item, '부찬');
      add('배추김치', '배추', '김치'); add('훈제오리구이', '오리고기'); add('쌀밥', '쌀', '밥'); add('푸딩', '우유', '후식');
      S.menus = {'2026-09': {'28|중식|n': '222'}, '2026-10': {'1|중식|0': '쌀밥', '1|중식|1': '수동국', '1|중식|2': '수동고기', '1|중식|7': '수동생선', '1|중식|n': '333', '1|석식|2': '다른 끼니 고기'}};
      S.menuPlanMeta = {'2026-10-01|중식': {by: 'manual'}}; S.menuManualEdits = {};
      S.headcountMeta = {'2026-10-01|중식': {by: 'manual', source: 'preserve'}};
      S.menuAutomation = {enabled: false, policy: 'manual-menu-v1'}; S.settings.fixtureSentinel = {value: 'preserve'};
      normalize(S); // Use a valid already-migrated fixture before asserting reload identity.
      selDay = 1; viewCfg(); clearTimeout(saveTimer); clearTimeout(cloudTimer);
      localStorage.setItem(KEY, JSON.stringify(S)); window.weeklySavedBefore = JSON.stringify(S);
      window.weeklyStorageWrites = []; const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {window.weeklyStorageWrites.push(key); return originalSet.call(this, key, value);};
      go('menu'); clearTimeout(saveTimer); clearTimeout(cloudTimer);
    }, password);
    assert.equal(await page.locator('#menu-recommend-load, #menu-recommend-refresh, #menu-recommend-date, #menu-recommend-meal').count(), 0, 'the old daily recommendation request/date panel is removed');
    assert.equal(await page.locator('#menu-recommend-week-status').count(), 1, 'the current week exposes a compact preparation status');
    await page.waitForFunction(days => days.every(day => !!menuRecommendCached(day)) && !menuRecommendPending.size, week);
    if (routeErrors.length) throw routeErrors[0];
    assert.deepEqual(requests.map(row => row.date).sort(), [...week].sort(), 'entering the week automatically prepares exactly its seven cross-month dates');
    assert.equal(requests[0].date, '2026-10-01', 'the currently edited date is prepared before the rest of the week');
    assert.equal(new Set(requests.map(row => row.date)).size, 7, 'queued renders coalesce each date into one request');
    assert(maxActive <= 2, `at most two AI calls run concurrently (observed ${maxActive})`);
    const before = await page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)}));
    const snapshot = () => page.evaluate(() => ({state: JSON.stringify(S), stored: localStorage.getItem(KEY)}));
    assert.equal(before.state, await page.evaluate(() => window.weeklySavedBefore), 'automatic week preparation does not alter application state');
    assert.equal(before.stored, before.state, 'automatic week preparation does not alter saved meals or other data');
    assert.equal(await page.evaluate(() => window.weeklyStorageWrites.filter(key => key === KEY).length), 0, 'the recommendation bank is never written into main app storage');
    assert(await page.evaluate(() => !!localStorage.getItem(menuRecommendStorageKey())), 'the completed bank is persisted in isolated recommendation storage');
    for (const day of week) {
      assert.equal(await page.evaluate(day => Object.values(menuRecommendCandidates(menuRecommendCached(day), day)).reduce((sum, rows) => sum + rows.length, 0), day), 18, `${day} retains three choices for each of six slots`);
    }
    const malformedCache = await page.evaluate(() => {
      const key = menuRecommendStorageKey(), original = localStorage.getItem(key), stored = JSON.parse(original);
      stored.banks.push({date: '2026-10-31', revision: menuRecommendRevision('2026-10-31'), expiresAt: Date.now() + 86400000, data: {ok: true, source: 'ai', date: '2026-10-31'}});
      localStorage.setItem(key, JSON.stringify(stored)); menuRecommendRestoredKey = ''; menuRecommendRestore();
      const cached = menuRecommendCached('2026-10-31'); let renderError = '';
      try {menuRecommendContent('2026-10-31', true);} catch (error) {renderError = error.message;}
      const validDates = menuRecommendWeekDates('2026-10-01').filter(day => !!menuRecommendCached(day));
      localStorage.setItem(key, original); menuRecommendRestoredKey = ''; menuRecommendRestore();
      return {cached, renderError, validDates};
    });
    assert.equal(malformedCache.cached, null, 'a matching-revision persistent bank without slot data is rejected');
    assert.equal(malformedCache.renderError, '', 'malformed browser recommendation storage cannot crash the picker');
    assert.deepEqual(malformedCache.validDates, week, 'rejecting a malformed bank retains the seven valid prepared dates');
    assert.deepEqual(await snapshot(), before, 'malformed isolated cache recovery never edits main application state');
    const quotaFailure = await page.evaluate(() => {
      const key = menuRecommendStorageKey(), originalSet = Storage.prototype.setItem; let error = '';
      Storage.prototype.setItem = function(storageKey, value) {
        if (storageKey === key) throw new DOMException('fixture quota exceeded', 'QuotaExceededError');
        return originalSet.call(this, storageKey, value);
      };
      try {menuRecommendPersist();} catch (caught) {error = caught.message;}
      finally {Storage.prototype.setItem = originalSet;}
      return {error, validDates: menuRecommendWeekDates('2026-10-01').filter(day => !!menuRecommendCached(day))};
    });
    assert.equal(quotaFailure.error, '', 'full browser storage does not crash recommendations');
    assert.deepEqual(quotaFailure.validDates, week, 'the in-memory week remains usable when persistence exceeds browser quota');
    assert.deepEqual(await snapshot(), before, 'recommendation storage quota errors never alter main app data');
    for (const ci of slotOrder) {
      await page.evaluate(ci => openPicker(1, '중식', +ci), ci);
      assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected[ci], 'the ordinary +고르기 picker immediately shows its three compatible choices');
      assert.equal(await page.locator('#pk-recommendations button').filter({hasText: /추천받기|추천 3개 보기|다른 후보 추천/}).count(), 0, 'opening the picker never needs a separate recommendation request button');
      await page.evaluate(() => closePicker());
    }
    const afterFirstWeek = requests.length;
    await page.evaluate(() => {selDay = 3; render(); openPicker(3, '야식', 2);});
    assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').count(), 3);
    await page.evaluate(() => closePicker()); await page.waitForTimeout(250);
    assert.equal(requests.length, afterFirstWeek, 'navigation and repeated pickers reuse the prepared week');
    await page.evaluate(() => {recipeDraft.date = '2026-09-30'; openDraftPicker(7);});
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['7']);
    await page.locator('#pk-recommendations button[data-recommend-name="생선까스"]').click();
    assert.equal(await page.evaluate(() => recipeDraft.slots[7]), '생선까스');
    assert.deepEqual(await snapshot(), before, 'draft recommendation selection remains unsaved');
    await page.evaluate(() => recipeDraftClear());

    // The app's existing startup selects today if opened directly on #menu.
    // Re-enter the intended cached week after a neutral reload, without claiming
    // that the editor focus itself is persisted (not part of this feature).
    await page.evaluate(() => history.replaceState(null, '', '#home'));
    await page.reload();
    await page.evaluate(() => {clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); cloudApplying = true; selDay = 1; go('menu');});
    await page.waitForTimeout(400);
    assert.equal(requests.length, afterFirstWeek, 'a browser reload reuses the isolated persisted bank without seven new AI calls');
    await page.evaluate(() => openPicker(1, '중식', 2));
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['2']);
    await page.evaluate(() => closePicker());
    assert.deepEqual(await snapshot(), before, 'reload preserves all app data');

    const nextWeek = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    responses.set('2026-10-06', {offline: true});
    await page.evaluate(() => {selDay = 6; render();});
    await page.waitForFunction(() => !menuRecommendPending.size && menuRecommendErrors.has('2026-10-06') && !!menuRecommendCached('2026-10-11'));
    assert.deepEqual(requests.slice(afterFirstWeek).map(row => row.date).sort(), nextWeek, 'changing weeks prepares only the newly entered week');
    const afterFailure = requests.length;
    await page.evaluate(() => {render(); render(); openPicker(6, '중식', 2);}); await page.waitForTimeout(350);
    assert.equal(requests.length, afterFailure, 'failed dates do not trigger an automatic retry loop on rendering or picker opening');
    assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').count(), 0, 'failure does not fabricate local AI advice or display another date');
    assert.match(await page.locator('#pk-recommendations').innerText(), /실패|오류|다시|확인/);
    responses.delete('2026-10-06');
    await page.locator('#pk-recommendations button').filter({hasText: /다시|재시도/}).click();
    await page.waitForFunction(() => !!menuRecommendCached('2026-10-06') && !menuRecommendPending.size);
    assert.equal(requests.length, afterFailure + 1, 'manual retry asks only for the failed date, not the other six successful banks');
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), expected['2']);
    await page.evaluate(() => closePicker());
    assert.deepEqual(await snapshot(), before, 'preparation failures and manual retry are read-only');

    await page.evaluate(() => {S.menus['2026-10']['7|중식|2'] = '돈육고추장볶음'; openPicker(6, '중식', 2);});
    const aliasFixture = await snapshot();
    assert.deepEqual(await page.locator('#pk-recommendations button[data-recommend-name]').evaluateAll(buttons => buttons.map(button => button.dataset.recommendName)), ['닭갈비', '소불고기'], 'cached bank revalidates unsaved nearby canonical aliases');
    await page.evaluate(() => pickerRecommendPick(2, '제육볶음', '2026-10-06'));
    assert.deepEqual(await snapshot(), aliasFixture, 'a direct pick cannot bypass current canonical exclusions');
    await page.evaluate(() => {closePicker(); delete S.menus['2026-10']['7|중식|2']; paintMenuRecommendations();});
    assert.deepEqual(await snapshot(), before);

    responses.set('2026-10-19', {hold: true}); responses.set('2026-10-20', {hold: true});
    const beforeRapid = requests.length;
    await page.evaluate(() => {selDay = 19; render();});
    for (let attempt = 0; attempt < 100 && !(held.has('2026-10-19') && held.has('2026-10-20')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(held.has('2026-10-19') && held.has('2026-10-20'), 'two calls of the abandoned week are really in flight');
    await page.evaluate(() => {selDay = 26; render();});
    await page.waitForTimeout(150);
    assert.equal(requests.length, beforeRapid + 2, 'entering another week does not exceed the global two-call limit while old calls run');
    held.get('2026-10-19')(); held.get('2026-10-20')();
    const lastWeek = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
    await page.waitForFunction(days => days.every(day => !!menuRecommendCached(day)) && !menuRecommendPending.size, lastWeek);
    assert.deepEqual(requests.slice(beforeRapid).map(row => row.date).sort(), ['2026-10-19', '2026-10-20', ...lastWeek].sort(), 'unsent dates of an abandoned week are cancelled rather than consuming five extra AI calls');
    assert(maxActive <= 2, 'concurrency remains globally bounded across rapid week changes');
    assert.deepEqual(await snapshot(), before, 'rapid week navigation and late old responses remain read-only');

    responses.set('2026-11-02', {hold: true}); responses.set('2026-11-03', {hold: true});
    await page.evaluate(() => {recipeDraft.date = '2026-11-02'; openDraftPicker(2);});
    for (let attempt = 0; attempt < 100 && !(held.has('2026-11-02') && held.has('2026-11-03')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(held.has('2026-11-02') && held.has('2026-11-03'), 'the old-catalog response is genuinely pending');
    await page.evaluate(() => {S.recipeAsk['훈제오리구이'] = {status: 'pending'};});
    responses.delete('2026-11-02'); responses.delete('2026-11-03');
    held.get('2026-11-02')(); held.get('2026-11-03')();
    await page.waitForFunction(() => !menuRecommendPending.size);
    assert.equal(await page.evaluate(() => menuRecommendCached('2026-11-02')), null, 'a response from an obsolete catalog cannot be saved as current recommendations');
    assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').count(), 0, 'obsolete candidates never appear in the target picker');
    await page.evaluate(() => {delete S.recipeAsk['훈제오리구이']; closePicker(); recipeDraftClear();});
    assert.deepEqual(await snapshot(), before, 'temporary catalog change and stale responses cannot alter saved app data');

    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({width, height: 900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `week editor fits ${width}px`);
      await page.evaluate(() => openPicker(6, '중식', 2));
      assert(await page.locator('#pk-recommendations').evaluate(element => element.scrollWidth <= element.clientWidth), `picker recommendation bank fits ${width}px`);
      await page.evaluate(() => closePicker());
    }
    await page.emulateMedia({media: 'print'});
    assert.equal(await page.locator('#menu-recommend-week-status').isVisible(), false, 'recommendation preparation status is not printed');
    await page.emulateMedia({media: 'screen'});
    assert.equal(forbiddenWrites, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({weekDates: week, recommendationsPerDate: 18, choicesPerSlot: 3, automaticWeeklyPreparation: true, maxConcurrency: maxActive, signedMockTransport: true, noRequestButton: true, isolatedPersistentCache: true, malformedPersistentBankRejected: true, storageQuotaMemoryFallback: true, weekReuse: true, reloadReuse: true, draftPreserved: true, failureRetryOnlyOnce: true, unsavedAliasRevalidation: true, abandonedWeekCancelled: true, staleCatalogResponseRejected: true, appStateUnchanged: true, printHidden: true, responsiveWidths: [320, 390, 1280], productionWrites: 0, sourceSha256: createHash('sha256').update(source).digest('hex')}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exit(1);});
