// Synthetic headcounts only. Never contact or mutate the production ledger.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
 await p.goto('https://served-difference.test');
 const before=await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';
  S.menus={'2026-10':Object.fromEntries(MEALS.map((m,i)=>['22|'+m+'|n',[100,150,100,89][i]]))};
  S.sales={'2026-10':Object.fromEntries(MEALS.flatMap((m,i)=>[['22|'+m,[80,120,80,54][i]],['22|cashCount|'+m,[5,10,5,5][i]],['22|cardCount|'+m,[5,10,5,5][i]],['22|creditCount|'+m,[5,5,5,0][i]]]))};
  S.sales['2026-10']['22|ticketIssued']=900;S.sales['2026-10']['22|other']=12345;
  periodViews.sales={mode:'day',date:'2026-10-22'};go('sales');return JSON.stringify([S.sales,S.menus,S.orders,S.salesEdits]);
 });
 const day=await p.evaluate(()=>salesComparison(22));
 assert.equal(day.countDifference,40,'439 forecast minus 399 served: all cash/card/credit headcounts must count, not just 334 recovered vouchers');
 assert.equal(day.expected,439);assert.equal(day.sold,334);assert.equal(day.served,399);assert.equal(day.countedMeals,4);
 assert.equal(await p.evaluate(()=>salesComparison().countDifference),40,'monthly headcount difference uses the same entered meals');
 for(const mode of ['day','week','month']){
  await p.evaluate(mode=>{periodViews.sales={mode,date:'2026-10-22'};render();},mode);
  const row=p.locator('[data-sales-day-total="2026-10-22"]');assert.match(await row.innerText(),/식수 입력 합계 399식/);assert.match(await row.innerText(),/인원 차이 \+40명/);
 }
 assert.match(await p.locator('[data-sales-month-total]').innerText(),/예상 − 전체 이용/);
 const report=await p.evaluate(()=>salesReportSnapshot().days[21]);assert.equal(report.meals.reduce((n,m)=>n+m.countDifference,0),40);assert.equal(report.meals.reduce((n,m)=>n+m.served,0),399);
 const csvData=await p.evaluate(()=>{let rows;const old=csv;csv=(_name,data)=>{rows=data;};try{csvSales();return rows;}finally{csv=old;}});
 assert.equal(csvData[22][csvData[0].indexOf('비교 인원 차이')],40);assert.equal(csvData[22][csvData[0].indexOf('전체 이용 식수 합계')],399);
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1),'comparison fits '+width);}
 assert.equal(await p.evaluate(()=>JSON.stringify([S.sales,S.menus,S.orders,S.salesEdits])),before,'comparison and view switches never rewrite any transactions');
 const cases=await p.evaluate(()=>{
  S.sales['2026-10']={'23|cashCount|조식':5,'24|cardCount|조식':0,'25|cash|조식':50000,'26|조식':120};
  for(const d of [23,24,25,26])S.menus['2026-10'][d+'|조식|n']=100;
  return [23,24,25,26].map(d=>salesMealComparison(d,'조식'));
 });
 assert.equal(cases[0].countDifference,95,'cash-only meal still has known attendance');assert.equal(cases[0].sold,null);assert.equal(cases[0].soldAmount,null);
 assert.equal(cases[1].countDifference,100,'explicit zero attendance is known zero');
 assert.equal(cases[2].countDifference,null,'legacy won amounts never fabricate headcounts');
 assert.equal(cases[3].countDifference,-20,'attendance above forecast has a negative shortage');
 assert.deepEqual(errors,[]);console.log('SALES_439_MINUS_399_ALL_CHANNELS_DAY_WEEK_MONTH_CASH_ONLY_ZERO_BLANK_LEGACY_NO_LEDGER_WRITE_RESPONSIVE_OK');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
