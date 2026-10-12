// Offline browser checks: no production requests or writes.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
 await page.goto('https://offline.namofood.test');
 await page.evaluate(()=>{
 clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;
 S=normalize(defaultState());S.month='2026-10';selDay=13;S.recipes=[];S.menus={};
 const item=(price,spec='1kg')=>({id:'item',name:'돼지고기',spec,unit:'kg',qty:1,price,amt:price});
 S.orders={'2026-09':[{id:'old',date:'2026-09-30',vendor:'한마음',items:[item(1000)],total:1000}], '2026-10':[{id:'invoice',date:'2026-10-13',vendor:'한마음',items:[item(1200)],total:1200},{id:'other',date:'2026-10-13',vendor:'한마음',items:[item(1500)],total:1500}]};
 S.cardTransactions={'2026-10':[{id:'pay',date:'2026-10-13',merchant:'한마음',amount:1200,status:'approved',note:''},{id:'cancel',date:'2026-10-13',merchant:'한마음',amount:1200,status:'cancelled',note:''}]};S.cardEdits={};S.orderEdits={};cloudOrderBase=captureCloudOrderBase(S);go('order');
 });
 assert.equal(await page.evaluate(()=>typeof invoiceLinkCard),'function','payment linking exists');
 const result=await page.evaluate(()=>{
 const o=orderRef('invoice').order,before=JSON.stringify(o.items),total=orderAmt(o);
 const change=invoicePriceChange(o,o.items[0]);
 const candidates=invoiceCardCandidates(o).map(r=>r.id);
 const linked=invoiceLinkCard('invoice','pay');
 const duplicate=invoiceLinkCard('other','pay');
 const cancelled=invoiceLinkCard('other','cancel');
 mergeRemoteOrders(structuredClone(cloudOrderBase));
 const persisted=normalize(JSON.parse(JSON.stringify(S))).orders['2026-10'].find(order=>order.id==='invoice').paymentCardId;
 return {change,candidates,linked,duplicate,cancelled,persisted,unchanged:before===JSON.stringify(o.items)&&total===orderAmt(o)};
 });
 assert.equal(result.change.percent,20);assert.deepEqual(result.candidates,['pay']);
 assert.equal(result.linked,true);assert.equal(result.duplicate,false);assert.equal(result.cancelled,false);assert.equal(result.persisted,'pay');assert.equal(result.unchanged,true);
 assert.equal(await page.locator('[data-payment-status="matched"]').count(),1);
 await page.evaluate(()=>{orderView='card';go('order');});
 assert.equal(await page.locator('[data-card-invoice="invoice"]').count(),1,'card shows reverse invoice link');
 await page.evaluate(()=>{S.cardTransactions['2026-10'][0].amount=1100;orderView='sheet';go('order');});
 assert.equal(await page.locator('[data-payment-status="difference"]').count(),1,'changed card amount recalculates mismatch');
 await page.evaluate(()=>{S.cardTransactions['2026-10']=[];go('order');});
 assert.equal(await page.locator('[data-payment-status="missing"]').count(),1,'deleted card does not claim paid');
 await page.evaluate(()=>invoiceLinkCard('invoice',''));
 assert.equal(await page.evaluate(()=>orderRef('invoice').order.paymentCardId),'');
 assert.equal(await page.evaluate(()=>invoicePriceChange(orderRef('invoice').order,{...orderRef('invoice').order.items[0],spec:'5kg'})),null,'different specs never compared');
 await page.evaluate(()=>{S.orders['2026-09'].push({...S.orders['2026-09'][0],id:'ambiguous',items:[{...S.orders['2026-09'][0].items[0],price:900}]});});
 assert.equal(await page.evaluate(()=>invoicePriceChange(orderRef('invoice').order,orderRef('invoice').order.items[0])),null,'conflicting same-day baselines not guessed');
 await page.evaluate(()=>{S.view={range:'week',mode:'public',ing:false};go('menu');});
 assert.equal(await page.locator('[data-menu-direct]').count(),24,'six direct fields for each of four meals');
 const positions=await page.evaluate(()=>({editor:document.querySelector('.editor').getBoundingClientRect().top,print:document.querySelector('#menu-print-sheet').getBoundingClientRect().top,rec:document.querySelector('#menu-recommend-week-status').getBoundingClientRect().bottom,meal:document.querySelector('.mealbox').getBoundingClientRect().top}));
 assert(positions.editor<positions.print);assert(positions.rec<=positions.meal);
 await page.locator('[data-menu-direct="중식|2"]').fill('직접 쓴 제육');await page.locator('[data-menu-direct="중식|2"]').press('Tab');
 assert.equal(await page.evaluate(()=>menuGet(13,'중식',2)),'직접 쓴 제육');assert.equal(await page.evaluate(()=>menuGet(13,'석식',2)),'');
 for(const width of [390,1280]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`/tmp/nmf-direct-${width}.png`,fullPage:true});}
 assert.deepEqual(errors,[]);console.log('PAYMENT_LINKS_PRICE_AND_DIRECT_MENU_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
