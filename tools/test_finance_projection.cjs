const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage();await page.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());await page.goto('https://offline.namofood.test');
 const result=await page.evaluate(()=>{
  clearInterval(cloudPollTimer);clearTimeout(cloudTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';S.staff=[];S.staffArchive=[];S.settings.opdays=31;S.settings.tax=.1;S.fixedMonthly={'2026-10':[['임대',310000]]};S.supplies=[];S.sales={};
  salesSet(1,'중식',10);salesSet(2,'중식',0);salesSet(13,'중식',20);salesSet(14,'중식',999);
  S.orders={'2026-10':[{id:'a',date:'2026-10-02',total:130000,previousBalance:900000,balanceTotal:1030000},{id:'b',date:'2026-10-14',total:900000},{id:'dup',date:'2026-10-03',total:777000,ocrMeta:{duplicateReviewPending:true}}]};
  const state=JSON.stringify(S),r=profitProgress('2026-10-13');const unchanged=state===JSON.stringify(S);
  S.orders={'2026-10':[]};const empty=profitProgress('2026-10-13');
  S.month='2026-11';const future=profitProgress('2026-10-13');
  return {r,unchanged,empty,future,vat:vatEstimate(2750000,100000),tax:[0,14000000,50000000,88000000,150000000,300000000,500000000,1000000000].map(incomeTaxEstimate)};
 });
 assert.equal(result.r.salesDays,3,'explicit zero is a recorded day');assert.equal(result.r.revenue,300000);assert.equal(result.r.elapsed,13);assert.equal(result.r.food,130000);assert.equal(result.r.forecast.revenue,3100000);assert.equal(result.r.forecast.food,310000);assert.equal(result.r.forecast.fixed,310000);assert(result.unchanged,'calculation does not write financial data');assert.equal(result.empty.forecast.net,null,'missing purchases are not declared free');assert.equal(result.future.forecast,null);assert.deepEqual(result.vat,{output:250000,input:100000,balance:150000});assert.deepEqual(result.tax,[0,840000,6240000,15360000,37060000,94060000,174060000,384060000]);
 await page.evaluate(()=>{S.month='2026-10';go('pl');});for(const width of [1280,390,320]){await page.setViewportSize({width,height:1000});assert(await page.locator('#profit-progress').count());assert(await page.locator('#profit-month-average').count());const fits=await page.evaluate(()=>{const m=document.querySelector('#main');return m.scrollWidth<=m.clientWidth+1;});assert(fits,`profit fits at ${width}`);await page.screenshot({path:`/tmp/nmf-finance-${width}.png`});}
 console.log('FINANCE_AVERAGES_PURCHASE_BASIS_AND_TAX_BOUNDARIES_OK');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
