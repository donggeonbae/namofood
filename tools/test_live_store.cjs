// Live encrypted frontend and signed OCR status only. Never write production data.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const pw=process.env.NMF_PW;if(!pw)throw Error('NMF_PW required');const version=process.env.NMF_EXPECTED_VER||'1018-1-store',browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const p=await browser.newPage(),errors=[];let writes=0,statusCalls=0;p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(pw=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw',pw);},pw);
 await p.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.pathname==='/rest/v1/namofood_state')return r.method()==='GET'?route.fulfill({json:[]}):(writes++,route.abort());if(r.method()==='POST'&&u.pathname==='/functions/v1/nmf-invoice-ocr'&&r.postDataJSON().action==='status'){assert.equal(r.postDataJSON().app,'store');statusCalls++;return route.continue();}if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();writes++;return route.abort();});
 await p.goto('https://d-bae.com/namofood/?v='+version);await p.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
 await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;});
 assert.deepEqual(await p.evaluate(()=>[APP,KEY,cloud.room,S.staff.length,storeProducts().length]),['store','namostore_v1','namostore',0,0]);
 await p.locator('nav button[data-p="recipe"]').click();assert.equal(await p.locator('#store-add').count(),1);await p.locator('nav button[data-p="sales"]').click();assert((await p.locator('#main').innerText()).includes('매점 판매 실적'));
 const before=await p.evaluate(()=>JSON.stringify(S));await p.evaluate(async()=>{const r=await invoiceOcrApi('status');if(!r.ok||!r.configured)throw Error('store OCR not configured');});assert.equal(await p.evaluate(()=>JSON.stringify(S)),before);
 assert.equal(statusCalls,1);assert.equal(writes,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({version,store:true,emptyCatalog:true,separateRoom:true,signedOcrStatus:true,productionWrites:writes,providerCalls:0}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
