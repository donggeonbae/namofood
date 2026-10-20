// In-memory fixtures only. No live business state, provider calls or writes.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{localStorage.setItem('nmf_supa_food','{"url":"","key":""}');sessionStorage.setItem('nmf_session_pw','isolated');});
  await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
  await p.goto('https://stacked-charts.test');
  const facts=await p.evaluate(()=>{
   clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;taxAiLoad=async()=>{};overviewLoad=async()=>{};
   const base=()=>{const s=normalize(defaultState());s.month='2026-10';s.staff=[];s.staffArchive=[];s.roster={};s.settings.fixed=[];s.fixedMonthly={};s.supplies=[];s.sales={};s.settings.tickets=Object.fromEntries(MEALS.map(m=>[m,1000]));return s;};
   const food=base(),cafe=base(),store=base();
   food.sales={'2026-10':{'1|ticketIssued':100,'1|ticketIssuePrice':1000,'1|중식':2,'1|cashCount|중식':1,'2|중식':0,'3|other':-100,'4|중식':5,'25|중식':999}};
   cafe.sales={'2026-10':{'1|rev':5000,'2|rev':0,'3|other':-200}};
   store.sales={'2026-10':{'1|storeCash':1000,'1|storeTickets':1,'2|storeCash':0,'3|storeCard':100,'4|storeCash':100}};
   S=food;const before=JSON.stringify([food,cafe,store]),rows=[['food',food],['cafe',cafe],['store',store]].map(([app,s])=>({...overviewCalculate(s,app,'2026-10'),app,status:'ready'}));
   const individual=profitRevenueSeries('2026-10-21')[0].points.map(p=>p.value);S=cafe;
   const series=overviewRevenueSeries(rows,'2026-10');S=food;
   overview.month='2026-10';overview.loaded=true;overview.scope=overviewScope();overview.entries={cafe:{status:'ready',state:cafe},store:{status:'ready',state:store}};go('overview');
   return {series,individual,companyDay:rows[0].dailyRevenue[0].value,before,after:JSON.stringify([food,cafe,store])};
  });
  assert.deepEqual(facts.series.find(s=>s.id==='food').points.map(p=>p.value),facts.individual,'combined Food follows recovered-meal profit, even when Cafe is the current state');
  assert.equal(facts.companyDay,101000,'monthly accounting keeps company sales');
  assert.equal(facts.series.find(s=>s.id==='total').points[0].value,19000,'recovered Food + Cafe + Store; do not deduct Store tickets again');
  assert.equal(facts.series.find(s=>s.id==='total').points[2].value,-200);assert.equal(facts.before,facts.after);
  for(const width of [1440,390,320]){
   await p.setViewportSize({width,height:1000});
   const geometry=await p.evaluate(()=>{
    const svg=[...main.querySelectorAll('svg')].find(e=>getComputedStyle(e).display!=='none'),bars=[...svg.querySelectorAll('[data-revenue-bar-date="2026-10-01"]')];
    const saturday=svg.querySelector('text[data-revenue-axis-date="2026-10-03"]'),sunday=svg.querySelector('text[data-revenue-axis-date="2026-10-04"]'),monday=svg.querySelector('text[data-revenue-axis-date="2026-10-05"]');
    return {bars:bars.map(e=>({x:+e.getAttribute('x'),y:+e.getAttribute('y'),width:+e.getAttribute('width'),height:+e.getAttribute('height')})),weekend:[saturday,sunday].map(e=>e&&getComputedStyle(e).fill),weekday:monday&&getComputedStyle(monday).fill,overflow:main.scrollWidth>main.clientWidth+1,invalid:/NaN|Infinity/.test(svg.outerHTML),weekendBands:svg.querySelectorAll('.revenue-weekend-band').length};
   });
   assert.equal(geometry.bars.length,3);assert(geometry.bars.every(r=>r.x===geometry.bars[0].x&&r.width===geometry.bars[0].width),'one stacked daily bar, not side-by-side');
   for(let i=1;i<3;i++)assert(Math.abs(geometry.bars[i].y+geometry.bars[i].height-geometry.bars[i-1].y)<.01,'segments touch vertically');
   assert.deepEqual(geometry.weekend,['rgb(196, 49, 49)','rgb(196, 49, 49)']);assert.notEqual(geometry.weekday,geometry.weekend[0]);assert.equal(geometry.weekendBands,9);assert(!geometry.overflow);assert(!geometry.invalid);
   await p.locator('[data-revenue-date]').selectOption('2026-10-01');assert((await p.locator('[data-revenue-detail]').innerText()).includes('19,000'));
   if(width!==320)await p.screenshot({path:'/tmp/nmf-stacked-weekends-'+width+'.png'});
  }
  await p.evaluate(()=>go('pl'));assert(await p.locator('#profit-revenue-chart .revenue-weekend').count()>0,'individual profit also marks weekends');
  assert.deepEqual(errors,[]);console.log('RECOVERED_FOOD_NOT_COMPANY_SALES_STACKED_DAILY_SEGMENTS_WEEKEND_RED_NEGATIVE_ZERO_PARTIAL_CROSS_STATE_PC_MOBILE_OK');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
