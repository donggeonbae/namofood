// Two actual app clients against one encrypted, isolated REST store; no live writes.
const fs=require('node:fs'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{chromium}=require('playwright');
const source=fs.readFileSync('나모푸드_관리앱.html','utf8'),password='offline-store-password';
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 let remote=null,revision=0;const pages=[],errors=[],events=[];
 for(let i=0;i<2;i++){
  const ctx=await browser.newContext();await ctx.addInitScript(pw=>{if(!localStorage.getItem('nmf_app'))localStorage.setItem('nmf_app','store');localStorage.setItem('nmf_supa_store',JSON.stringify({url:'',key:''}));localStorage.setItem('nmf_supa_cafe',JSON.stringify({url:'',key:''}));sessionStorage.setItem('nmf_session_pw',pw);},password);
  await ctx.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());try{
   if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
   if(url.hostname!=='store-cloud.namofood.test')return route.abort();
   events.push({path:url.pathname,method:req.method(),id:url.searchParams.get('id')});
   if(url.pathname.endsWith('/rpc/nmf_state_revision')){assert.equal(url.searchParams.get('room'),'namostore');return route.fulfill({json:remote?[{updated_at:remote.updated_at,revision:createHash('sha256').update(remote.data).digest('hex')}]:[]});}
   assert.equal(url.pathname,'/rest/v1/namofood_state');
   if(req.method()==='GET'){assert.equal(url.searchParams.get('id'),'eq.namostore');return route.fulfill({json:remote?[remote]:[]});}
   if(req.method()==='PATCH'){assert.equal(url.searchParams.get('id'),'eq.namostore');assert.equal(url.searchParams.get('updated_at'),'eq.'+remote.updated_at);const body=req.postDataJSON();remote={...remote,...body,updated_at:new Date(Date.UTC(2026,9,18,1,0,++revision)).toISOString()};return route.fulfill({json:[{id:'namostore'}]});}
   assert.equal(req.method(),'POST');const body=req.postDataJSON();if(!Array.isArray(body)){assert.equal(body.id,'namostore');assert.equal(remote,null);remote=body;return route.fulfill({json:[{id:body.id}]});}assert(body.every(r=>r.id.startsWith('namostore@')),'snapshots never enter food/cafe namespace');return route.fulfill({json:[]});
  }catch(e){errors.push(e.message);return route.abort();}});
  const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());await p.goto('https://store-app.namofood.test');
  await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloud.url='https://store-cloud.namofood.test';cloud.key='isolated-key';S.month='2026-10';});pages.push(p);
 }
 const [a,b]=pages;
 const poll=p=>p.evaluate(async()=>{lastInputAt=0;return cloudLoad(true);});
 const save=async p=>{await p.evaluate(async()=>{clearTimeout(saveTimer);clearTimeout(cloudTimer);await cloudSave(true);clearTimeout(cloudTimer);});assert.equal(await p.evaluate(()=>cloudDirty),false);};
 await save(a);assert.equal(remote.id,'namostore','first save creates only the new store room');await poll(a);await poll(b);
 const x=await a.evaluate(()=>storeProductAdd({name:'콜라',category:'음료',unit:'캔',price:'1500',cost:'800'}));await save(a);
 const y=await b.evaluate(()=>storeProductAdd({name:'과자',category:'간식',unit:'봉',price:'2000',cost:'1000'}));await save(b);await poll(a);
 assert.equal(await a.evaluate(()=>storeProducts().length),2,'concurrent additions are unioned');
 await a.evaluate(id=>storeSaleSet(17,id,'qty','3'),x);await b.evaluate(id=>storeSaleSet(18,id,'qty','2'),y);await save(a);await save(b);await poll(a);
 assert.deepEqual(await a.evaluate(()=>[storeSummary().count,storeSummary().revenue]),[5,8500],'different day/product quantities survive concurrent full-state saves');
 await a.evaluate(id=>storeProductDelete(id),x);await save(a);
 await b.evaluate(id=>storeProductSet(id,'price','2500'),y);await save(b);await poll(a);
 assert.equal(await a.evaluate(id=>S.storeProducts[id].deleted,x),true,'stale catalog cannot resurrect deleted product');assert.equal(await a.evaluate(()=>storeSummary().revenue),8500,'catalog changes leave saved prices intact');
 await a.evaluate(id=>storeSaleSet(17,id,'qty',''),x);await save(a);
 await b.evaluate(id=>storeSaleSet(18,id,'qty','4'),y);await save(b);await poll(a);
 assert.deepEqual(await a.evaluate(()=>[storeSummary().count,storeSummary().revenue]),[4,8000],'clear tombstone survives stale peer and independent edit');
 const before=events.length;assert.equal(await poll(a),false);assert.equal(events[before].path,'/rest/v1/rpc/nmf_state_revision');assert.equal(events.length,before+1,'unchanged store poll never downloads full ledger');
 await a.evaluate(id=>storeSaleSet(18,id,'tickets','2'),y);await save(a);await poll(b);assert.equal(await b.evaluate(()=>storeSummary().revenue),20000,'ticket settlement merges through encrypted state');
 await a.evaluate(id=>{S.orders={'2026-10':[{id:'cp-stock',date:'2026-10-17',vendor:'쿠팡',coupang:{orderNo:'777777'},items:[{id:'stock-line',name:'과자 묶음',qty:2}]}]};markOrder(S.orders['2026-10'][0]);storeStockSet('cp-stock','stock-line','storeProductId',id);storeStockSet('cp-stock','stock-line','storeUnitsPerPack','12');},y);await save(a);await poll(b);assert.equal(await b.evaluate(()=>storeStock('2026-10-19').products.find(p=>p.name==='과자').remaining),20,'order line pack links survive cloud reconciliation');
 await a.evaluate(()=>{coupangUi.orders=[{orderNo:'888888',date:'2026-10-17',items:[{name:'개인 물건',qty:1}]}];coupangUi.picks=new Set(['0:0']);storeStockImport();storeStockExclude('@stock',storeStockKey(coupangUi.orders[0],0));});await save(a);await poll(b);assert.equal(await b.evaluate(()=>Object.values(S.storeStockImports)[0].deleted),true,'non-sale stock exclusion syncs without modifying expenses');
 await a.evaluate(id=>storeSaleSet(18,id,'qty','5'),y);await Promise.all([a.waitForEvent('domcontentloaded'),a.locator('nav button[data-app="cafe"]').click()]);assert.equal(await a.evaluate(()=>APP),'cafe');const sent=await a.evaluate(async ({data,pw})=>JSON.parse(await decryptText(pw,data)),{data:remote.data,pw:password});assert.equal(sent.storeSales['2026-10-18|'+y].qty,5,'app switch flushes pending store sales to encrypted server before leaving');
 assert.deepEqual(errors,[]);console.log('STORE_TWO_CLIENT_ENCRYPTED_CREATE_CAS_ADDITIONS_DELETIONS_SALES_CLEAR_LIGHTWEIGHT_POLL_SWITCH_FLUSH_OK');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
