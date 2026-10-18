// Real signed requests, isolated server and ledgers. A transient result failure must not require Status.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const jobId='01234567-1234-4234-8234-123456789012',fixture={orders:[
 {orderNo:'12345678901234',date:'2026-10-12',status:'배송완료',total:30000,items:[{name:'콜라',qty:2,unit:'박스',spec:'24개',amt:12000},{name:'개인 물건',qty:1,unit:'개',amt:18000}]},
 {orderNo:'12345678901235',date:'2026-10-13',status:'배송완료',total:9000,items:[{name:'물',qty:3,unit:'묶음',amt:9000}]}
],warnings:[]};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());let polls=0,statusCalls=0;
 await p.addInitScript(()=>{localStorage.setItem('nmf_app','store');localStorage.setItem('nmf_supa_store','{"url":"","key":""}');sessionStorage.setItem('nmf_session_pw','isolated-test-password');});
 await p.route('**/*',async r=>{const req=r.request(),url=new URL(req.url());if(req.isNavigationRequest())return r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')});
  if(url.pathname==='/functions/v1/nmf-coupang'){const b=req.postDataJSON();if(b.action==='start')return r.fulfill({json:{ok:true,jobId}});if(b.action==='status')statusCalls++;
   if(b.action==='result'&&++polls===1)return r.fulfill({status:503,json:{ok:false,error:'temporary outage'}});
   return r.fulfill({json:{ok:true,worker:{online:true,state:'ready'},job:{id:jobId,status:b.action==='result'&&polls===2?'processing':'done',stage:'ai',progress:80,result:fixture}}});}
  if(url.pathname==='/rest/v1/namofood_state')return r.fulfill({json:[]});return r.abort();});
 await p.goto('https://completion.namofood.test');await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;cloud.url='https://completion-server.namofood.test';cloud.key='isolated';S.month='2026-10';go('order');});
 await p.locator('#coupang-import').click();await p.waitForFunction(()=>!coupangUi.busy&&coupangUi.orders.length===2,null,{timeout:12000});
 assert.equal(statusCalls,0,'completion is displayed without any manual Status request');assert.equal(polls,3,'one failed read recovers without creating a second import job');
 assert.equal(await p.locator('[data-coupang-order]').count(),2);assert.equal(await p.locator('#coupang-stock-import').count(),0,'only one combined registration action');
 assert(await p.evaluate(()=>document.getElementById('coupang-selection').compareDocumentPosition(document.querySelector('[data-coupang-order]'))&Node.DOCUMENT_POSITION_FOLLOWING),'selection is above the first record');
 await p.locator('[data-coupang-date="2026-10-13"] [data-select="off"]').click();assert.equal(await p.evaluate(()=>coupangUi.picks.size),2,'date selection affects only that date');
 await p.locator('[data-coupang-item] input[type=checkbox]').nth(1).uncheck();await p.locator('#coupang-register').click();await p.waitForFunction(()=>!coupangUi.busy&&coupangUi.orders.length===0);
 const result=await p.evaluate(()=>({orders:Object.values(S.orders).flat(),stock:storeStock('2026-10-19'),receipt:S.storeCoupangReviews?.[coupangUi.jobId]}));
 assert.equal(result.orders.length,1);assert.equal(result.orders[0].items.length,1);assert.equal(result.orders[0].total,12000);assert.equal(result.orders[0].tax,null,'unknown VAT never invented');assert.equal(result.stock.lines.length,1,'registered selection enters inventory in the same transaction');assert(result.receipt?.at);
 assert.equal(await p.locator('[data-coupang-order]').count(),0,'unselected review rows are removed, never imported');
 await p.locator('#coupang-status').click();await p.waitForTimeout(300);assert.equal(await p.locator('[data-coupang-order]').count(),0,'processed cached result never reappears');
 await p.evaluate(()=>{localStorage.setItem(KEY,JSON.stringify(S));});await p.reload();await p.evaluate(()=>{clearInterval(cloudPollTimer);cloudApplying=true;cloud.url='https://completion-server.namofood.test';cloud.key='isolated';go('order');});await p.locator('#coupang-status').click();await p.waitForTimeout(300);assert.equal(await p.locator('[data-coupang-order]').count(),0,'completed review persists across reload');
 assert.equal(await p.evaluate(()=>Object.values(S.orders).flat().length),1);
 const failed=await p.evaluate(async fixture=>{coupangUi.jobId='second-job';coupangAccept(fixture);coupangUi.orders[1].items[0].qty=-1;const before=JSON.stringify(S.orders);await coupangRegister();return {same:before===JSON.stringify(S.orders),rows:coupangUi.orders.length,receipt:coupangReviewed()};},fixture);assert(failed.same);assert.equal(failed.rows,2);assert.equal(failed.receipt,false,'validation failure retains review without a completion receipt');
 const storageFailure=await p.evaluate(async()=>{coupangUi.orders[1].items[0].qty=3;const before=JSON.stringify(S.orders),set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===KEY)throw new DOMException('full','QuotaExceededError');return set.call(this,k,v);};try{await coupangRegister();}finally{Storage.prototype.setItem=set;}return {same:before===JSON.stringify(S.orders),rows:coupangUi.orders.length,receipt:coupangReviewed()};});assert(storageFailure.same);assert.equal(storageFailure.rows,2);assert.equal(storageFailure.receipt,false,'storage failure atomically rolls back order and review completion');
 await p.evaluate(()=>coupangRegister());assert.equal(await p.evaluate(()=>Object.values(S.orders).flat().length),2,'retry after failure registers once');
 await p.evaluate(fixture=>{coupangUi.jobId='third-job';coupangAccept(fixture);coupangUi.orders[0].orderNo='12345678909999';coupangSelectAll(true);},fixture);
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1100});assert(await p.evaluate(()=>document.getElementById('main').scrollWidth<=document.getElementById('main').clientWidth+1),'expanded review fits '+width);await p.screenshot({path:'/tmp/nmf-coupang-review-'+width+'.png'});}
 assert.deepEqual(errors,[]);console.log('COUPANG_AUTO_COMPLETION_TRANSIENT_RETRY_COMBINED_REGISTRATION_DATE_SELECTION_DURABLE_REVIEW_ATOMIC_FAILURE_OK');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
