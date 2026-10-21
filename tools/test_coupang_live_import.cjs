// Explicitly authorized, read-only Coupang retrieval. Never register the preview.
// Signed queue start is opt-in; all business-state writes are blocked.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 if(process.env.NMF_COUPANG_LIVE_IMPORT!=='1'||!process.env.NMF_PW)throw Error('Explicit import opt-in and secure app credential required');
 const version=JSON.parse(fs.readFileSync('ver.json','utf8')).v;
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];let starts=0,businessWrites=0,lastStage='';
  p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(pw=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw',pw);},process.env.NMF_PW);
  await p.route('**/*',async route=>{
   const r=route.request(),url=new URL(r.url());
   if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();
   const body=r.postDataJSON();
   if(url.pathname.endsWith('/nmf-access')&&body.action==='rest'&&body.method==='GET')return route.continue();
   if(url.pathname.endsWith('/nmf-coupang')&&['defaults','start','status','result'].includes(body.action)){
    if(body.action==='start')starts++;
    return route.continue();
   }
   businessWrites++;return route.fulfill({status:503,json:{ok:false,error:'Verification blocks business writes'}});
  });
  await p.goto('https://d-bae.com/namofood/?v='+version);
  await p.waitForFunction(v=>window.NmfAccess&&!!cloudRemoteAt&&document.querySelector('#appver')?.textContent==='버전 '+v,version,{timeout:60000});
  await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('order');});
  await p.waitForFunction(()=>!!coupangUi.worker,null,{timeout:30000});
  const before=await p.evaluate(async()=>({orders:JSON.stringify(S.orders),revision:await cloudFetch(AbortSignal.timeout(20000)).then(r=>r?.updated_at)}));
  const defaultDates=await p.evaluate(()=>({from:coupangUi.from,to:coupangUi.to,lastImportThrough:coupangUi.worker?.lastImportThrough}));
  const from=process.env.NMF_IMPORT_FROM||'2026-10-18',to=process.env.NMF_IMPORT_TO||'2026-10-21';
  await p.locator('#coupang-from').fill(from);await p.locator('#coupang-to').fill(to);
  await p.locator('#coupang-import').click();
  const until=Date.now()+12*60000;
  while(Date.now()<until){
   const state=await p.evaluate(()=>({busy:coupangUi.busy,status:coupangUi.status,error:coupangUi.error,progress:coupangUi.progress}));
   if(state.status!==lastStage){lastStage=state.status;console.log(JSON.stringify({stage:state.status,progress:state.progress}));}
   if(!state.busy)break;
   await p.waitForTimeout(3000);
  }
  const result=await p.evaluate(async ({before,from,to})=>({error:coupangUi.error,busy:coupangUi.busy,orders:coupangUi.orders.length,items:coupangUi.orders.reduce((n,o)=>n+o.items.length,0),missingAmounts:coupangUi.orders.flatMap(o=>o.items).filter(i=>i.amt===null).length,outOfOrderRange:coupangUi.orders.filter(o=>o.date<from||o.date>to).length,warnings:coupangUi.warnings,sourceUnchanged:before.orders===JSON.stringify(S.orders),revisionUnchanged:before.revision===(await cloudFetch(AbortSignal.timeout(20000)))?.updated_at,jobId:coupangUi.jobId}),{before,from,to});
  assert.equal(result.busy,false);assert.equal(result.error,'');assert(result.orders>0,'actual completed orders must reach preview');
  assert.equal(result.sourceUnchanged,true);assert.equal(result.revisionUnchanged,true);assert.equal(result.outOfOrderRange,0);assert.equal(starts,1);assert.equal(businessWrites,0);assert.deepEqual(errors,[]);
  assert.equal(await p.locator('[data-coupang-order]').count(),result.orders,'every returned order appears without manual Status');
  if(process.env.NMF_EXPECT_AMOUNT_COMPLETE==='1'){assert.equal(result.missingAmounts,0);assert.equal(await p.locator('[data-coupang-item] [aria-label="쿠팡 품목 금액"]').evaluateAll(inputs=>inputs.filter(i=>i.value==='').length),0,'amounts must be visible in the actual preview inputs');}
  const status=await p.evaluate(async()=>{const d=await coupangApi('status');return {state:d.job?.status,through:d.worker?.lastImportThrough};});
  assert.equal(status.state,'done');
  if(!result.warnings.some(w=>w.includes('일부만')))assert.equal(status.through,to,'successful complete import persists its date cursor');
  console.log(JSON.stringify({version,range:{from,to},defaultDates,result,status,businessWrites,starts}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
