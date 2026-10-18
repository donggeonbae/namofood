// Production smoke: signed connector status and web-login entry only.
// Purchase preview is opt-in; every business-ledger write stays blocked.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const pw=process.env.NMF_PW;if(!pw)throw Error('NMF_PW required');if(process.env.NMF_COUPANG_TEST_LOGIN==='1')throw Error('Native login button retired; use interactive web login/device approval instead.');const version=process.env.NMF_EXPECTED_VER||'1019-5-store-stock',browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const p=await browser.newPage(),errors=[];let writes=0,statusCalls=0,loginCalls=0;p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(pw=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw',pw);},pw);
 await p.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());
  if(url.pathname==='/rest/v1/namofood_state')return r.method()==='GET'?route.fulfill({json:[]}):(writes++,route.abort());
  if(url.pathname==='/functions/v1/nmf-coupang'&&r.method()==='POST'){
   const body=r.postDataJSON();assert.equal(body.role,'app');assert.equal(body.room,'namostore');
   if(body.action==='status'){statusCalls++;return route.continue();}
   if(process.env.NMF_COUPANG_TEST_IMPORT==='1'&&['start','result'].includes(body.action))return route.continue();
  }
  if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();writes++;return route.abort();
 });
 await p.goto('https://d-bae.com/namofood/?v='+version);await p.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
 await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('order');});
 await p.locator('#coupang-status').click();await p.waitForFunction(()=>coupangUi.worker!==null||!!coupangUi.error);
 const result=await p.evaluate(()=>({worker:coupangUi.worker,error:coupangUi.error,preview:{orders:coupangUi.orders.length,items:coupangUi.orders.reduce((n,o)=>n+o.items.length,0),missingTotals:coupangUi.orders.filter(o=>o.total==null).length,missingAmounts:coupangUi.orders.reduce((n,o)=>n+o.items.filter(x=>x.amt==null).length,0),missingQuantities:coupangUi.orders.reduce((n,o)=>n+o.items.filter(x=>x.qty==null).length,0)}}));assert.equal(result.error,'');assert.equal(result.worker.online,true);
 assert.equal(await p.locator('#coupang-login').count(),0);assert(await p.locator('#coupang-web-login').isVisible());assert.equal(await p.locator('#store-purchase-docs').count(),1);
 let preview=null;
 if(process.env.NMF_COUPANG_TEST_IMPORT==='1'){
  await p.locator('#coupang-import').click();
  await p.waitForFunction(()=>!coupangUi.busy,{},{timeout:240000});
  preview=await p.evaluate(()=>({error:coupangUi.error,status:coupangUi.status,jobId:coupangUi.jobId,orders:coupangUi.orders.length,items:coupangUi.orders.reduce((n,o)=>n+o.items.length,0),total:coupangUi.orders.reduce((n,o)=>n+(o.total||0),0),warnings:coupangUi.warnings,ledgerOrders:Object.values(S.orders).flat().length}));
  console.log(JSON.stringify({preview}));assert.equal(preview.error,'');assert.equal(preview.ledgerOrders,0);
  const shared=await p.evaluate(async()=>{const data=await coupangApi('status');return {id:data.job?.id,status:data.job?.status,orders:data.job?.result?.orders?.length};});
  assert.equal(shared.id,preview.jobId);assert.equal(shared.status,'done');assert.equal(shared.orders,preview.orders);
 }
 assert.equal(writes,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({version,signedConnectorStatus:true,worker:result.worker,recoveredPreview:result.preview,loginWindowRequested:loginCalls===1,businessWrites:writes,purchasePreviewRequested:!!preview}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
