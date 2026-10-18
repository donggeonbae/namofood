// Production smoke: read connector status. Optional login opens the official Mac window only.
// Never reads/imports purchase records and blocks every business-ledger write.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const pw=process.env.NMF_PW;if(!pw)throw Error('NMF_PW required');const version=process.env.NMF_EXPECTED_VER||'1019-1-coupang',browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const p=await browser.newPage(),errors=[];let writes=0,statusCalls=0,loginCalls=0;p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(pw=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw',pw);},pw);
 await p.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());
  if(url.pathname==='/rest/v1/namofood_state')return r.method()==='GET'?route.fulfill({json:[]}):(writes++,route.abort());
  if(url.pathname==='/functions/v1/nmf-coupang'&&r.method()==='POST'){
   const body=r.postDataJSON();assert.equal(body.role,'app');assert.equal(body.room,'namostore');
   if(body.action==='status'){statusCalls++;return route.continue();}
   if(process.env.NMF_COUPANG_TEST_LOGIN==='1'&&['login','result'].includes(body.action)){if(body.action==='login')loginCalls++;return route.continue();}
  }
  if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();writes++;return route.abort();
 });
 await p.goto('https://d-bae.com/namofood/?v='+version);await p.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
 await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('order');});
 await p.locator('#coupang-status').click();await p.waitForFunction(()=>coupangUi.worker!==null||!!coupangUi.error);
 const result=await p.evaluate(()=>({worker:coupangUi.worker,error:coupangUi.error}));assert.equal(result.error,'');assert.equal(result.worker.online,true);
 if(process.env.NMF_COUPANG_TEST_LOGIN==='1'){
  await p.locator('#coupang-login').click();await p.waitForFunction(()=>!coupangUi.busy,{},{timeout:90000});
  const login=await p.evaluate(()=>({error:coupangUi.error,status:coupangUi.status,orders:Object.values(S.orders).flat().length}));
  assert.equal(login.error,'');assert.equal(login.orders,0);assert.equal(loginCalls,1);
 }
 assert.equal(writes,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({version,signedConnectorStatus:true,worker:result.worker,loginWindowRequested:loginCalls===1,businessWrites:writes,purchaseImports:0,providerCalls:0}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
