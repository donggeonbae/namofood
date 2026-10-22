// Read the deployed app and shared sales data. Block every business write/provider call.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{assert(process.env.NMF_PW,'Secure credential runner required');const version=JSON.parse(fs.readFileSync('ver.json','utf8')).v,b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];let blockedWrites=0;
 p.on('pageerror',e=>errors.push(e.message));await p.addInitScript(pw=>{localStorage.setItem('nmf_app','food');sessionStorage.setItem('nmf_session_pw',pw);},process.env.NMF_PW);
 await p.route('**/*',r=>{const q=r.request(),u=new URL(q.url());if(['GET','HEAD','OPTIONS'].includes(q.method()))return r.continue();const body=q.postDataJSON();if(u.pathname.endsWith('/nmf-access')&&body.action==='rest'&&body.method==='GET')return r.continue();blockedWrites++;return r.fulfill({status:503,json:{ok:false,error:'Read-only verification'}});});
 await p.goto('https://d-bae.com/namofood/?v='+version);await p.waitForFunction(v=>typeof cloudRemoteAt!=='undefined'&&!!cloudRemoteAt&&document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:60000});
 const before=await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;return JSON.stringify([S.sales,S.menus,S.orders,S.salesEdits]);});
 await p.evaluate(()=>{S.month='2026-10';periodViews.sales={mode:'day',date:'2026-10-22'};go('sales');});
 const result=await p.evaluate(()=>{const day=salesComparison(22),byMeal=MEALS.map(me=>{const c=salesMealComparison(22,me),entered=[me,...SALES_COUNT_CHANNELS.map(([k])=>k+'|'+me)].some(k=>salesGet(22,k)!=null);return {meal:me,expected:c.expected,recovered:c.sold,cash:Number(salesGet(22,'cashCount|'+me))||0,card:Number(salesGet(22,'cardCount|'+me))||0,credit:Number(salesGet(22,'creditCount|'+me))||0,served:salesServedCount(22,me),entered,difference:c.countDifference};});return {date:'2026-10-22',expected:byMeal.reduce((s,m)=>s+m.expected,0),expectedCompared:byMeal.filter(m=>m.entered).reduce((s,m)=>s+m.expected,0),served:byMeal.reduce((s,m)=>s+m.served,0),difference:day.countDifference,byMeal};});
 if(process.env.NMF_EXPECT_CORRECT_HEADCOUNT==='1'){
  assert.equal(result.difference,result.expectedCompared-result.served,'live difference includes every entered payment-channel headcount and excludes unentered meals');
  for(const m of result.byMeal)if(m.entered){assert.equal(m.difference,m.expected-m.served);const panel=p.locator('[data-sales-selected-date] [data-sales-meal-comparison="2026-10-22|'+m.meal+'"]');assert((await panel.innerText()).includes('인원 차이 '+(m.difference>0?'+':'')+m.difference+'명'));}
  const row=await p.locator('[data-sales-day-total="2026-10-22"]').innerText();assert(row.includes('식수 입력 합계 '+result.served+'식'));assert(row.includes('인원 차이 '+(result.difference>0?'+':'')+result.difference+'명'));
  for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1),'live sales fit '+width);}
 }
 assert.equal(await p.evaluate(()=>JSON.stringify([S.sales,S.menus,S.orders,S.salesEdits])),before);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({version,...result,sourceUnchanged:true,blockedWrites,productionWrites:0}));
}finally{await b.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
