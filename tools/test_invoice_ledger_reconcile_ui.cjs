// Browser + real reconciliation/routing core. Transport and state are test-owned.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const blank=()=>({settings:{},staff:[],staffArchive:[],orders:{},orderEdits:{},fixedPurchases:{}});
(async()=>{
 const {invoiceLedgerPlan,applyInvoiceLedger,preserveInvoiceLedgers}=await import('../supabase/functions/_shared/invoice-ledger.ts');
 const {purchaseRoutingPlan,applyPurchaseRouting,preservePurchaseRouting}=await import('../supabase/functions/_shared/purchase-routing.ts');
 let states={namofood:blank(),namostore:blank()},applyCalls=0,fail=false;
 const source=fs.readFileSync('나모푸드_관리앱.html','utf8'),b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({body:source,contentType:'text/html'}):r.abort());
  await p.exposeFunction('fixtureSave',s=>{states.namofood=preserveInvoiceLedgers(states.namofood,preservePurchaseRouting(states.namofood,s));});
  await p.exposeFunction('fixtureLoad',()=>structuredClone(states.namofood));
  await p.exposeFunction('fixtureLedger',async body=>{
    if(body.mode==='preview')return invoiceLedgerPlan(states,body.room,body.id,body.choices||{});
    applyCalls++;if(fail)throw Error('fixture atomic failure');
    return applyInvoiceLedger(states,body.room,body.id,body.fingerprint,body.replace,body.choices,body.confirmed,new Date().toISOString());
  });
  await p.exposeFunction('fixtureRoute',async body=>{
    if(body.mode==='preview')return {plans:[await purchaseRoutingPlan(states.namofood,'namofood',body.orderId,body.choices||{})]};
    return applyPurchaseRouting(states,'namofood',body.id,body.fingerprint,body.choices,true,new Date().toISOString());
  });
  await p.goto('https://ledger-fixture.test');
  await p.evaluate(()=>{
    clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;cloudDirty=false;cloud.room='namofood';S=normalize(defaultState());S.month='2026-10';S.orders={};S.orderEdits={};
    purchaseRoutingFlush=async()=>{clearTimeout(saveTimer);saveTimer=null;cloudDirty=false;await fixtureSave(structuredClone(S));};
    cloudLoad=async()=>{applyState(await fixtureLoad());return true;};
    window.NmfAccess={isAdmin:()=>true,invoiceLedger:async body=>new Response(JSON.stringify(await fixtureLedger(body))),purchaseRoute:async body=>new Response(JSON.stringify(await fixtureRoute(body)))};
    go('order');
  });
  const row=(name,amt,id)=>({id,name,spec:'1kg',unit:'개',qty:1,price:amt,supplyAmount:amt,tax:null,amt});
  const original={id:'old',date:'2026-10-03',vendor:'검증유통',total:3300,subtotal:3300,tax:null,items:[row('양파',1100,'a'),row('콜라',2200,'b')],invoiceFile:{hash:'a'.repeat(64),name:'원장.xlsx',size:1,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}};
  const incoming=(id,base=original)=>({...structuredClone(base),id,invoiceFile:{...original.invoiceFile,hash:'b'.repeat(64)},ocrMeta:{referenceOnly:true,sourceFileHash:'b'.repeat(64),sourceKey:id,sourceAudit:{reconcilePending:true}}});
  await p.evaluate(rows=>{S.orders={'2026-10':rows};S=normalize(S);render();},[original,incoming('new')]);
  await p.locator('[data-ledger-resume="new"]').click();await p.waitForFunction(()=>!invoiceLedgerUi.busy);
  assert.equal(applyCalls,1,'exact rows automatically reconcile');
  assert.equal(states.namostore.orders['2026-10'][0].items[0].name,'콜라','beverage auto routed');
  assert.equal(states.namostore.orders['2026-10'][0].invoiceFile.hash,'b'.repeat(64));
  assert.equal(await p.locator('[data-ledger-pending]').count(),0,'pending leaves after response');
  assert.equal(await p.locator('[data-item-business-change]').count(),1,'active food line has change button');
  await p.locator('[data-item-business-change]').click();await p.waitForFunction(()=>!purchaseRouting.busy);
  assert.equal(await p.locator('[data-purchase-select]:checked').count(),1,'only clicked line selected');
  await p.locator('[data-purchase-row-target=a]').selectOption('fixed');p.once('dialog',d=>d.accept());await p.locator('[data-purchase-routing-apply]').click();await p.waitForFunction(()=>!purchaseRouting.busy);
  assert.equal(states.namofood.fixedPurchases['2026-10'][0].items[0].name,'양파','manual business override uses same original');
  await p.evaluate(()=>{go('fixed');});assert.equal(await p.locator('[data-fixed-purchases] [data-item-business-change]').count(),1,'fixed purchase can move back');
  await p.locator('[data-fixed-purchases] details summary').click();await p.locator('[data-fixed-purchases] [data-item-business-change]').click();await p.waitForFunction(()=>!purchaseRouting.busy);assert.equal(await p.evaluate(()=>page),'order');
  const fixedId=states.namofood.fixedPurchases['2026-10'][0].id;
  assert.equal(await p.locator(`[data-purchase-plan="${fixedId}"] [data-purchase-select]:checked`).count(),1);
  await p.locator(`[data-purchase-plan="${fixedId}"] [data-purchase-row-target=a]`).selectOption('food');p.once('dialog',d=>d.accept());await p.locator(`[data-purchase-plan="${fixedId}"] [data-purchase-routing-apply]`).click();await p.waitForFunction(()=>!purchaseRouting.busy);await p.evaluate(()=>cloudLoad());assert.equal(await p.evaluate(()=>fixedPurchaseTotal()),0,'routed fixed archive no longer costs twice');
  // A partially overlapping receipt must stay pending until a human decides.
  const next=incoming('partial',{...original,total:2100,subtotal:2100,items:[row('양파',1100,'a'),row('감자',1000,'c')]});
  await p.evaluate(next=>{S.orders['2026-10'].push(next);S=normalize(S);go('order');},next);
  await p.locator('[data-ledger-resume="partial"]').click();await p.getByRole('dialog',{name:'엑셀 발주 중복 확인'}).waitFor();
  assert.equal(applyCalls,1,'partial not applied before confirmation');
  for(const width of [1920,390,320]){await p.setViewportSize({width,height:900});assert(await p.evaluate(()=>{const d=invoiceLedgerUi.dialog;return d.getBoundingClientRect().width<=innerWidth&&d.scrollWidth<=d.clientWidth+1;}),'review fits '+width);}
  await p.locator('[data-ledger-hold]').click();await p.waitForFunction(()=>!invoiceLedgerUi.busy);assert.equal(await p.locator('[data-ledger-resume="partial"]').count(),1);
  await p.locator('[data-ledger-resume="partial"]').click();await p.getByRole('dialog').waitFor();await p.locator('[data-ledger-candidate]').first().check();p.once('dialog',d=>d.accept());await p.locator('[data-ledger-replace]').click();await p.waitForFunction(()=>!invoiceLedgerUi.busy);assert.equal(applyCalls,2);
  assert.equal(await p.locator('[data-ledger-resume="partial"]').count(),0);
  // Original markup is escaped; source data cannot inject HTML into review.
  const xss=incoming('xss',{...original,vendor:'<img src=x onerror=alert(1)>',items:[row('양파<script>bad()</script>',500,'d')],total:500});xss.ocrMeta.sourceAudit.dateUncertain=true;
  await p.evaluate(x=>{S.orders['2026-10'].push(x);render();},xss);await p.locator('[data-ledger-resume="xss"]').click();await p.getByRole('dialog').waitFor();assert.equal(await p.locator('dialog img,dialog script').count(),0);await p.locator('[data-ledger-hold]').click();await p.waitForFunction(()=>!invoiceLedgerUi.busy);
  fail=true;const failed=incoming('failed',{...original,date:'2026-10-06'});await p.evaluate(x=>{S.orders['2026-10'].push(x);render();},failed);await p.locator('[data-ledger-resume="failed"]').click();await p.waitForFunction(()=>!invoiceLedgerUi.busy);assert.equal(await p.locator('[data-ledger-resume="failed"]').count(),1,'failed apply remains resumable');assert(states.namofood.orders['2026-10'].find(o=>o.id==='failed').ocrMeta.referenceOnly,'failed apply never counts a pending source');assert.match(await p.locator('[data-ledger-pending]').innerText(),/fixture atomic failure/);
  assert.deepEqual(errors,[]);console.log('LEDGER_BROWSER_AUTO_EXACT_CROSS_ROOM_SHARED_ORIGINAL_PARTIAL_HOLD_CONFIRM_LINE_OVERRIDE_FIXED_RETURN_MOBILE_ESCAPING_OK');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
