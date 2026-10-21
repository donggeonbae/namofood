// Isolated review metadata only. No live imports, provider calls or business writes.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{localStorage.setItem('nmf_app','store');localStorage.setItem('nmf_supa_store','{"url":"","key":""}');});
  await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
  await p.goto('https://coupang-hidden.test');
  const before=await p.evaluate(()=>{
   clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';
   window.fixture={orders:[18,19,20].map(d=>({orderNo:'12345678900'+d,date:'2026-10-'+d,status:'배송완료',total:1000,items:[{name:'확인할 상품 <img onerror=alert(1)> '+d,qty:1,amt:1000}]}))};
   S.orders={'2026-10':[{...structuredClone(fixture.orders[0]),id:'coupang-1234567890018',invoiceNo:'1234567890018',vendor:'쿠팡'}]};
   S.orderEdits={'coupang-1234567890019':{deleted:true,at:'2026-10-21T00:00:00Z'}};
   S.storeCoupangReviews=Object.fromEntries(fixture.orders.map(o=>['hidden-order:'+o.orderNo,{at:'2026-10-21T00:00:00Z',hidden:true,orderNo:o.orderNo,date:o.date}]));
   window.staleState=structuredClone(S);coupangAccept(fixture);orderView='sheet';go('order');
   return JSON.stringify([S.orders,S.orderEdits,S.storeStockImports,S.storeSales]);
  });
  assert.equal(await p.locator('[data-coupang-order]').count(),0,'old list deletion remains effective by default');
  assert.equal(await p.locator('[data-coupang-hidden]').count(),1,'all-hidden successful results must offer an expandable history, not disappear');
  assert.match(await p.locator('[data-coupang-counts]').innerText(),/조회 3건.*확인 목록 0건.*정리한 목록 3건/);
  await p.locator('[data-coupang-hidden] > summary').click();
  assert.equal(await p.locator('[data-coupang-hidden-order]').count(),3);
  assert.equal(await p.locator('[data-coupang-hidden] img').count(),0,'source text remains escaped');
  assert.equal(await p.evaluate(()=>{
   const ready=cloudReady;cloudReady=()=>true;coupangUi.scope=coupangScope();coupangUi.jobId='hidden-job';
   sessionStorage.setItem('nmf_coupang_job',JSON.stringify({scope:coupangScope(),id:'hidden-job'}));
   try{coupangResume();return coupangUi.busy;}finally{cloudReady=ready;}
  }),false,'returning to a tab with hidden results must not restart completed polling and collapse the open history');
  for(const width of [1440,390,320]){
   await p.setViewportSize({width,height:1100});
   assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1),'hidden history fits '+width);
   await p.screenshot({path:'/tmp/nmf-coupang-hidden-'+width+'.png'});
  }
  p.once('dialog',d=>d.dismiss());await p.locator('[data-coupang-unhide="1234567890018"]').click();
  assert.equal(await p.locator('[data-coupang-order]').count(),0,'cancel leaves all rows hidden');
  p.once('dialog',d=>d.accept());await p.locator('[data-coupang-unhide="1234567890018"]').click();
  assert.equal(await p.locator('[data-coupang-order]').count(),1);
  assert.equal(await p.locator('[data-coupang-order] input[type=checkbox]').isDisabled(),true,'restoring a review never bypasses purchase duplication protection');
  assert.equal(await p.evaluate(()=>coupangUi.picks.size),0,'restored history is never automatically selected for registration');
  await p.evaluate(()=>{mergeStoreRecords(S,staleState);coupangPaint();});
  assert.equal(await p.locator('[data-coupang-order]').count(),1,'stale peer cannot undo an explicit newer unhide');
  const failure=await p.evaluate(()=>{
   const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===KEY)throw Error('full');return original.call(this,k,v);};
   const confirmBefore=window.confirm;window.confirm=()=>true;
   try{return {ok:coupangUnhide(),hidden:coupangUi.hiddenOrders.length,flag:S.storeCoupangReviews['hidden-order:1234567890019'].hidden};}
   finally{Storage.prototype.setItem=original;window.confirm=confirmBefore;}
  });
  assert.deepEqual(failure,{ok:false,hidden:2,flag:true},'failed local save rolls back review restoration');
  await p.locator('[data-coupang-hidden] > summary').click();
  p.once('dialog',d=>d.accept());await p.locator('[data-coupang-unhide-all]').click();
  assert.equal(await p.locator('[data-coupang-order]').count(),3);
  assert.equal(await p.locator('[data-coupang-hidden]').count(),0);
  assert(await p.locator('[data-coupang-order="1234567890019"] input[type=checkbox]').isDisabled(),'a deleted purchase is still not automatically restored');
  assert.equal(await p.evaluate(()=>JSON.stringify([S.orders,S.orderEdits,S.storeStockImports,S.storeSales])),before,'history visibility/restoration never changes financial records');
  await p.evaluate(()=>coupangAccept(fixture));
  assert.equal(await p.locator('[data-coupang-order]').count(),3,'fresh result honors restored metadata');
  assert.deepEqual(errors,[]);
  console.log('COUPANG_ALL_HIDDEN_HISTORY_VISIBLE_EXPLICIT_RESTORE_CANCEL_QUOTA_STALE_PEER_DUPLICATE_GUARDS_NO_LEDGER_WRITE_RESPONSIVE_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
