// Offline behavioral integration checks for forecast headcounts and ticket sales.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '나모푸드_관리앱.html'), 'utf8');
    for(const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))new Function(match[1]);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ timezoneId: 'Asia/Seoul', viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', route => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html', body: source }) : route.abort());
    await page.goto('https://offline.namofood.test/');
    await page.evaluate(() => {
      clearInterval(cloudPollTimer); clearTimeout(cloudTimer); clearTimeout(saveTimer); cloudApplying = true;
      S.month = '2026-10'; S.sales = { '2026-10': { '1|조식': 12, '1|중식': 0, '1|석식': 6, '1|other': 500.5 }, '2026-09': { '30|조식': 3 } };
      S.menus = { '2026-10': { '1|조식|n': 10, '1|중식|n': 5, '1|석식|n': 8, '1|야식|n': 4, '1|조식|2': '수동 메뉴', '2|조식|2': '수동 메뉴' }, '2026-09': { '30|조식|n': 2 } };
      S.headcountMeta = { '2026-10-01|조식': { by: 'photo-plan', source: 'fixture' } };
      S.settings.tickets = { 조식: 10000.25, 중식: 11000, 석식: 12000.5, 야식: 13000 };
      S.settings.meals = { 조식: { count: 10, price: 9999, cost: 3000 }, 중식: { count: 20, price: 9999, cost: 4000 }, 석식: { count: 30, price: 9999, cost: 5000 }, 야식: { count: 40, price: 9999, cost: 6000 } };
      S.recipes = [{ comp: '주찬', menu: '수동 메뉴', item: '테스트 원료', qty: 200, unit: 'g', loss: .2, storage: '냉장', form: '원물' }];
      S.methods = { '수동 메뉴': '회전솥 조리' }; S.recipeMeta = {}; S.prices = {}; S.extraOrders = {}; S.orderAdj = {};
      go('sales');
    });
    const expectedInput = page.locator('input[data-sales-expected="2026-10-01|조식"]');
    assert.equal(await expectedInput.count(), 1, 'sales exposes forecast headcount independently from actual ticket count');
    assert.equal(await page.evaluate(() => menuCount(2, '조식')), 0, 'an absent food forecast means zero, not the settings headcount');
    const actualInput = page.locator('input[data-sales-actual="2026-10-01|조식"]');
    const dayRow = page.locator('[data-sales-day="2026-10-01"]');
    const baseline = await page.evaluate(() => ({ sales: structuredClone(S.sales), recipes: structuredClone(S.recipes), settings: structuredClone(S.settings), menu: S.menus['2026-10']['1|조식|2'], summary: salesSummary() }));
    assert.equal(await expectedInput.inputValue(), '10'); assert.equal(await actualInput.inputValue(), '12');
    assert.deepEqual(await page.evaluate(() => salesMealComparison(1,'조식')), { expected: 10, sold: 12, price: 10000.25, expectedAmount: 100002.5, soldAmount: 120003, countDifference: 2, amountDifference: 20000.5 });
    assert.deepEqual(await page.evaluate(() => salesMealComparison(1,'야식')), { expected: 4, sold: null, price: 13000, expectedAmount: 52000, soldAmount: null, countDifference: null, amountDifference: null }, 'missing ticket sales are unknown, not a false negative variance');
    assert.deepEqual(await page.evaluate(() => salesMealComparison(1,'중식')), { expected: 5, sold: 0, price: 11000, expectedAmount: 55000, soldAmount: 0, countDifference: -5, amountDifference: -55000 }, 'explicit zero ticket sales are known zero');
    const expectedAggregate = { expected: 27, sold: 18, expectedAmount: 303006.5, soldAmount: 192006, countDifference: -5, amountDifference: -59000.5, comparedMeals: 3 };
    for (const field of Object.keys(expectedAggregate)) {
      assert.equal(await page.evaluate(field => salesComparison(1)[field], field), expectedAggregate[field], 'independent daily ' + field);
      assert.equal(await page.evaluate(field => salesComparison()[field], field), expectedAggregate[field], 'month aggregation preserves incomplete-cell semantics: ' + field);
    }
    assert.equal(await page.evaluate(() => salesComparison().totalMeals), 124);
    assert.equal(baseline.summary.revenue, 192506.5, 'actual sales include other revenue, not forecast revenue');
    assert.equal(baseline.summary.foodCost, 66000, 'actual food cost uses sold tickets, not forecast headcounts');
    assert((await dayRow.innerText()).includes('+2명'));
    assert((await dayRow.innerText()).includes('-5명'));
    assert((await dayRow.innerText()).includes('미확인'));
    assert((await page.locator('[data-sales-month-total]').innerText()).includes('-59,000원'), 'display uses the established Math.round currency semantics for negative half units');
    const details = page.locator('#ticketMealStats');
    assert.equal(await details.evaluate(el => el.open), false, 'existing price/per-meal details remain initially collapsed');
    await details.locator('summary').click();
    assert.equal(await details.locator('input[onchange*="settings.tickets"]').count(), 4, 'all four editable per-meal ticket prices remain available');
    assert((await page.locator('[data-sales-month-meal="야식"]').innerText()).includes('미확인'));

    await expectedInput.fill('14'); await expectedInput.press('Tab');
    assert.equal(await page.evaluate(() => S.menus['2026-10']['1|조식|n']), 14, 'forecast edits use the canonical menu-headcount cell');
    assert.equal(await page.evaluate(() => S.headcountMeta['2026-10-01|조식'].by), 'manual');
    assert.deepEqual(await page.evaluate(() => S.sales), baseline.sales, 'forecast edits cannot alter any actual ticket data or other revenue');
    assert.deepEqual(await page.evaluate(() => S.recipes), baseline.recipes, 'forecast edits change scaled requirements, not recipe per-person quantities');
    assert.equal(await page.evaluate(() => S.menus['2026-10']['1|조식|2']), baseline.menu, 'forecast edits cannot change a manual menu');
    assert.equal(await page.evaluate(() => menuCount(1,'조식')), 14);
    assert.equal(await page.evaluate(() => ingredientsFor('수동 메뉴',menuCount(1,'조식'))[0].need), 3.5, 'recipe scaling uses the edited forecast, with the existing loss factor');
    assert.equal(await page.evaluate(() => requirements(new Set([1])).items.find(r=>r.item==='테스트 원료').total), 3.5, 'order requirements use the same canonical count');
    assert.deepEqual(await page.evaluate(() => salesSummary()), baseline.summary, 'forecast editing preserves exact actual revenue, costs and every existing summary field');
    await page.evaluate(() => { selDay=1; S.view={range:'day',mode:'internal',ing:true}; page='menu'; render(); });
    assert((await page.locator('.editor').innerText()).includes('14명'));
    assert((await page.locator('.editor').innerText()).includes('3.5kg'));
    assert.equal(await page.locator('.photo-count').count(), 0, 'photo-planning provenance has no visual badge');
    assert(!(await page.locator('#main').innerText()).includes('사진 계획'));
    await page.evaluate(() => go('sales'));
    await expectedInput.fill(''); await expectedInput.press('Tab');
    assert.equal(await page.evaluate(() => Object.hasOwn(S.menus['2026-10'],'1|조식|n')), false, 'clearing forecast removes its canonical cell rather than duplicating a separate sales forecast');
    assert.equal(await page.evaluate(() => menuCount(1,'조식')), 0);
    assert.equal(await page.evaluate(() => menuCountAt('2026-10',1,'조식')), 0);
    assert.equal(await page.evaluate(() => requirements(new Set([1])).items.find(r=>r.item==='테스트 원료').total), 0, 'zero forecast remains zero through order scaling');
    assert.equal(await page.evaluate(() => ingredientsFor('수동 메뉴',menuCount(1,'조식'))[0].need), 0);
    assert.deepEqual(await page.evaluate(() => S.sales), baseline.sales);
    await expectedInput.fill('0'); await expectedInput.press('Tab');
    assert.equal(await page.evaluate(() => S.menus['2026-10']['1|조식|n']), 0, 'explicit forecast zero is preserved as an explicit canonical value');
    assert.equal(await expectedInput.inputValue(), '0');
    await page.evaluate(() => { salesExpectedSet(1,'조식','-1'); salesExpectedSet(1,'조식','1.5'); salesExpectedSet(1,'조식','NaN'); salesExpectedSet(1,'invalid','4'); });
    assert.equal(await page.evaluate(() => menuCount(1,'조식')), 0, 'invalid forecast entries cannot inject negative, fractional or NaN headcounts');

    await actualInput.fill('0'); await actualInput.press('Tab');
    assert.equal(await page.evaluate(() => S.sales['2026-10']['1|조식']), 0);
    assert.equal(await page.evaluate(() => salesMealComparison(1,'조식').countDifference), 0);
    assert((await page.locator('[data-sales-meal-comparison="2026-10-01|조식"]').innerText()).includes('인원 차이 0명'));
    await actualInput.fill(''); await actualInput.press('Tab');
    assert.equal(await page.evaluate(() => Object.hasOwn(S.sales['2026-10'],'1|조식')), false);
    assert.equal(await page.evaluate(() => salesMealComparison(1,'조식').countDifference), null);
    await actualInput.fill('12'); await actualInput.press('Tab');
    await expectedInput.fill('10'); await expectedInput.press('Tab');
    assert.deepEqual(await page.evaluate(() => salesSummary()), baseline.summary);
    assert.deepEqual(await page.evaluate(() => S.sales['2026-09']), baseline.sales['2026-09'], 'current-month edits preserve another month');

    const monthBoundary = await page.evaluate(() => ({ september:salesComparison(null,'2026-09'), october:salesComparison(null,'2026-10'), november:salesComparison(null,'2026-11'), leap:salesComparison(null,'2028-02') }));
    assert.equal(monthBoundary.september.expected,2); assert.equal(monthBoundary.september.sold,3);
    assert.equal(monthBoundary.september.countDifference,1); assert.equal(monthBoundary.september.amountDifference,10000.25);
    assert.equal(monthBoundary.september.totalMeals,120); assert.equal(monthBoundary.october.totalMeals,124);
    assert.equal(monthBoundary.november.expected,0); assert.equal(monthBoundary.november.countDifference,null);
    assert.equal(monthBoundary.leap.totalMeals,116, 'month aggregation handles leap-year boundaries without nonexistent dates');
    await page.evaluate(() => { S.month='2026-10'; selDay=1; S.view={range:'week',mode:'internal',ing:true};page='menu';render(); });
    assert.equal(await page.locator('.photo-count').count(),0);
    assert(!(await page.locator('#main').innerText()).includes('📷'));
    assert.equal(await page.evaluate(() => menuCountAt('2026-09',30,'조식')),2, 'cross-month menu/ingredient views read the correct canonical month');
    const photoRecord = await page.evaluate(() => { S.headcountMeta['2026-10-01|조식']={by:'photo-plan',source:'retained fixture'}; return structuredClone(S.headcountMeta['2026-10-01|조식']); });
    for(const range of ['day','week','month']){
      await page.evaluate(range=>{S.view.range=range;render();},range);
      assert.equal(await page.locator('.photo-count').count(),0);
      assert(!(await page.locator('#main').innerText()).includes('사진 계획'));
      assert.deepEqual(await page.evaluate(()=>S.headcountMeta['2026-10-01|조식']),photoRecord,'presentation changes do not delete historical provenance');
    }
    await page.evaluate(() => { portion=300; rSel='수동 메뉴'; go('recipe'); });
    assert.equal(await page.evaluate(()=>portion),300,'ordinary recipe browsing retains its established default rather than binding unrelated meal counts');
    const portionInput=page.locator('#rdetail input[onchange*="portion="]');
    await portionInput.fill('0');await portionInput.press('Tab');
    assert.equal(await page.evaluate(()=>portion),0,'zero portions cannot fall back to one or a default recipe batch');
    assert((await page.locator('#rdetail').innerText()).includes('0인분 필요량'));

    await page.evaluate(()=>{go('sales');localStorage.setItem(KEY,JSON.stringify(S));});
    const csv = await page.evaluate(async()=>{const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;URL.createObjectURL=blob=>{window.__salesCsv=blob;return'blob:offline-sales';};HTMLAnchorElement.prototype.click=function(){};try{csvSales();return await window.__salesCsv.text();}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;delete window.__salesCsv;}});
    const csvLines=csv.replace(/^\uFEFF/,'').split(/\r?\n/),heads=csvLines[0].split(','),values=csvLines[1].split(',');
    assert.deepEqual(heads.slice(0,6),['날짜','조식','중식','석식','야식','기타매출'],'existing leading CSV columns remain compatible');
    assert.deepEqual(values.slice(0,6),['2026-10-01','12','0','6','','500.5']);
    assert.equal(values[heads.indexOf('조식 인원 차이(판매−예상)')],'2');
    assert.equal(values[heads.indexOf('조식 금액 차이(판매−예상)')],'20000.5');
    assert.equal(values[heads.indexOf('야식 금액 차이(판매−예상)')],'','CSV does not misrepresent missing sales as zero or a negative variance');
    assert.equal(values[heads.indexOf('비교 인원 차이')],'-5');
    await page.reload();await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S.month='2026-10';go('sales');});
    assert.equal(await expectedInput.inputValue(),'10');assert.equal(await actualInput.inputValue(),'12');
    assert.deepEqual(await page.evaluate(()=>salesSummary()),baseline.summary,'real localStorage reload preserves actual sales and revenue');
    assert.equal(await page.evaluate(()=>menuCount(2,'조식')),0);

    const cloud = await page.evaluate(()=>{
      const remote=structuredClone(S);cloudMenuBase=captureCloudMenuBase(S);
      salesExpectedSet(1,'조식','15');remote.menus['2026-10']['2|중식|n']=9;remote.headcountMeta['2026-10-02|중식']={by:'manual',updated:new Date().toISOString()};
      mergeRemoteMenus(remote);return {local:menuCount(1,'조식'),remote:menuCount(2,'중식'),sales:structuredClone(S.sales)};
    });
    assert.equal(cloud.local,15,'canonical forecast local edits are preserved by the existing menu merge');
    assert.equal(cloud.remote,9,'unmodified canonical forecast cells accept remote headcounts');
    assert.deepEqual(cloud.sales,baseline.sales,'existing menu-headcount merge never changes actual ticket sales');
    await page.evaluate(()=>{cloudMenuBase=captureCloudMenuBase(S);const remote=structuredClone(S);delete remote.menus['2026-10']['2|중식|n'];delete remote.headcountMeta['2026-10-02|중식'];mergeRemoteMenus(remote);});
    assert.equal(await page.evaluate(()=>menuCount(2,'중식')),0,'remote deletion of an unmodified forecast clears its count instead of reviving a settings fallback');
    const cafe=await browser.newPage();await cafe.addInitScript(()=>localStorage.setItem('nmf_app','cafe'));
    await cafe.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:source}):route.abort());
    await cafe.goto('https://offline.namofood.test/');
    await cafe.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S.month='2026-10';S.menus={};S.settings.meals['조식'].count=99;});
    assert.equal(await cafe.evaluate(()=>menuCount(1,'조식')),99,'the food-only zero fallback change preserves historical cafe fallback behavior');
    assert.equal(await cafe.evaluate(()=>menuCountAt('2026-09',30,'조식')),99);
    await cafe.evaluate(()=>{S.menus['2026-10']={'1|조식|n':0};go('sales');});
    assert.equal(await cafe.evaluate(()=>menuCount(1,'조식')),0);
    assert.equal(await cafe.locator('[data-sales-expected]').count(),0,'cafe selling still uses its existing cups/revenue screen');
    await cafe.evaluate(()=>{S.recipes=[{menu:'카페 검증',item:'원료',qty:20,unit:'g',loss:0,comp:'커피'}];rSel='카페 검증';portion=300;go('recipe');});
    const cafePortion=cafe.locator('#rdetail input[onchange*="portion="]');
    await cafePortion.fill('0');await cafePortion.press('Tab');
    assert.equal(await cafe.evaluate(()=>portion),1,'cafe portion input preserves its established zero fallback');
    await cafe.close();
    assert.deepEqual(errors,[],'sales, recipe and forecast views produce no browser errors');
    console.log('PASS forecast vs ticket sales: canonical separate inputs, blank forecast zero, exact meal/day/month money differences, incomplete-ticket semantics, recipe/order scaling, no photo badges, month boundaries, actual revenue/CSV persistence, and existing menu-cloud merge.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
