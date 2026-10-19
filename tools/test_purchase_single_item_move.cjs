// Real browser selection + real routing core; all state/transport is test-owned.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const {purchaseRoutingPlan,applyPurchaseRouting}=await import('../supabase/functions/_shared/purchase-routing.ts');
 const original={id:'sixteen',date:'2026-10-20',vendor:'선택이동검증',total:16000,invoiceFile:{hash:'a'.repeat(64)},items:Array.from({length:16},(_,i)=>({id:'line-'+i,name:i===7?'주방세제':'양파 '+i,qty:1,price:1000,amt:1000}))};
 const blank=()=>({settings:{},staff:[],orders:{},orderEdits:{},fixedPurchases:{}}),states={namofood:blank(),namostore:blank()};states.namofood.orders['2026-10']=[structuredClone(original)];let applies=0;
 const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
  await p.exposeFunction('singleMoveFixture',async body=>{
   if(body.mode==='preview')return {plans:[await purchaseRoutingPlan(states.namofood,'namofood','sixteen',body.choices||{})]};
   applies++;return applyPurchaseRouting(states,'namofood','sixteen',body.fingerprint,body.choices,body.confirmed,new Date().toISOString());
  });
  await p.goto('https://single-move-fixture.test');
  await p.evaluate(order=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;cloudDirty=false;cloudLoad=async()=>true;S=normalize(defaultState());S.month='2026-10';S.orders={'2026-10':[order]};S.orderEdits={};window.NmfAccess={isAdmin:()=>true,purchaseRoute:async body=>new Response(JSON.stringify(await singleMoveFixture(body)))};go('order');},original);
  await p.locator('[data-item-business-change="line-7"]').click();await p.waitForFunction(()=>!purchaseRouting.busy);
  assert.equal(await p.locator('[data-purchase-select]:checked').count(),1,'one row selected out of sixteen');
  await p.locator('[data-purchase-row-target="line-7"]').selectOption('fixed');
  const confirmation=p.waitForEvent('dialog');await p.locator('[data-purchase-routing-apply]').click();const d=await confirmation,message=d.message();await d.dismiss();await p.waitForFunction(()=>!purchaseRouting.busy);
  assert.equal(applies,0,'cancelling changes no purchases');
  assert.match(message,/16품목 중 선택한 1품목만 이동/,'confirmation counts the selected delta, not all source rows');
  assert.match(message,/고정비 발주/);assert.match(message,/주방세제/);assert.match(message,/나머지 15품목.*유지/);
  if(!await p.locator('[data-purchase-plan]').evaluate(el=>el.open))await p.locator('[data-purchase-plan] summary').click();const next=p.waitForEvent('dialog');await p.locator('[data-purchase-routing-apply]').click();await (await next).accept();await p.waitForFunction(()=>!purchaseRouting.busy);
  assert.equal(applies,1);const fixed=states.namofood.fixedPurchases['2026-10'],food=states.namofood.orders['2026-10'].filter(o=>!o.ocrMeta?.referenceOnly);
  assert.equal(fixed.length,1);assert.deepEqual(fixed[0].items,[original.items[7]],'only the checked line enters fixed purchases');assert.equal(fixed[0].total,1000);
  assert.equal(food.length,1);assert.deepEqual(food[0].items,original.items.filter((_,i)=>i!==7),'all fifteen unselected lines stay in food unchanged');assert.equal(food[0].total,15000);
  assert.equal(food[0].invoiceFile.hash,fixed[0].invoiceFile.hash,'both retain the shared original');assert.deepEqual(states.namofood.orders['2026-10'][0].items,original.items,'archived original is untouched');
  assert.match(await p.evaluate(()=>purchaseRouting.message),/이동 완료 · 1품목/,'completion reports only moved items');
  const unknown=structuredClone(original);unknown.items[7].amt=null;unknown.items[7].price=null;
  states.namofood=blank();states.namostore=blank();states.namofood.orders['2026-10']=[structuredClone(unknown)];
  await p.evaluate(order=>{S.orders={'2026-10':[order]};S.orderEdits={};purchaseRouting.plans=[];purchaseRouting.selected={};purchaseRouting.choices={};purchaseRouting.errors={};go('order');},unknown);
  await p.locator('[data-item-business-change="line-7"]').click();await p.waitForFunction(()=>!purchaseRouting.busy);await p.locator('[data-purchase-row-target="line-7"]').selectOption('fixed');
  let warning='';p.once('dialog',async d=>{warning=d.message();await d.accept();});await p.locator('[data-purchase-routing-apply]').click();await p.waitForFunction(()=>!purchaseRouting.busy);
  assert.match(warning,/전체 16품목 중 선택한 1품목만 이동/);assert.match(warning,/금액 확인 필요/);assert.match(warning,/금액 미입력 1품목/);
  const missing=states.namofood.fixedPurchases['2026-10'][0];assert.equal(missing.total,null);assert.equal(missing.items[0].amt,null);assert.match(await p.evaluate(()=>purchaseRouting.message),/금액 미입력/);
  await p.evaluate(fixed=>{S.fixedPurchases={'2026-10':[fixed]};go('fixed');},missing);assert.equal(await p.locator('[data-route-amount-warning]').count(),1);await p.locator('[data-fixed-purchases] details summary').click();assert.match(await p.locator('[data-route-amount-warning]').innerText(),/임의로 채우거나 배분하지 않았습니다/);
  assert.deepEqual(errors,[]);console.log('SIXTEEN_LINES_ONE_SELECTED_CONFIRM_CANCEL_REAL_SPLIT_FIFTEEN_REMAIN_SHARED_ORIGINAL_OK');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
