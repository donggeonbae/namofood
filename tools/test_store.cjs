// Store journeys against the real app; all network requests are isolated.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const source=fs.readFileSync(process.env.NMF_STORE_SOURCE||'나모푸드_관리앱.html','utf8');
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const context=await browser.newContext(),p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
 await context.addInitScript(()=>{if(!localStorage.getItem('nmf_app'))localStorage.setItem('nmf_app','store');localStorage.setItem('nmf_supa_store',JSON.stringify({url:'',key:''}));});
 await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:source}):r.abort());await p.goto('https://offline.namofood.test');
 assert.equal(await p.evaluate(()=>APP),'store','store switch selects independent app');
 assert.deepEqual(await p.evaluate(()=>[BRAND,KEY,SUPA_DEFAULT.room]),['나모매점','namostore_v1','namostore']);
 assert.deepEqual(await p.evaluate(()=>[S.staff.length,S.recipes.length,Object.keys(S.menus).length,S.purch.length,S.stock.length]),[0,0,0,0,0],'no food/cafe seed leakage');
 assert.equal(await p.locator('nav button[data-app="store"]').count(),1);await p.locator('nav [data-p="recipe"]').click();
 await p.locator('#store-name').fill('콜라 <캔>');await p.locator('#store-category').fill('음료');await p.locator('#store-price').fill('1500');await p.locator('#store-cost').fill('800');await p.locator('#store-add').click();
 const id=await p.evaluate(()=>storeProducts()[0].id);assert.equal(await p.locator('[data-store-product]').count(),1);
 assert.equal(await p.locator('[data-store-product] [data-field="name"]').inputValue(),'콜라 <캔>');assert.equal(await p.locator('#main 캔').count(),0,'names escaped');
 await p.evaluate(()=>{S.month='2026-10';periodViews.sales={mode:'day',date:'2026-10-17'};go('sales');});
 const qty=()=>p.locator('[data-store-sale] [data-field="qty"]');await qty().fill('3');await qty().press('Tab');
 assert.deepEqual(await p.evaluate(()=>{const x=storeSummary();return [x.count,x.revenue,x.cost,x.daysFilled];}),[3,4500,2400,1]);
 await p.evaluate(id=>storeProductSet(id,'price','2000'),id);assert.equal(await p.evaluate(()=>storeSummary().revenue),4500,'catalog price change never rewrites sales');
 await p.evaluate(id=>storeSaleSet(18,id,'qty','2'),id);assert.equal(await p.evaluate(()=>storeSummary().revenue),8500,'future sale uses new price');
 await p.evaluate(id=>storeProductSet(id,'name','새 콜라'),id);assert.equal(await p.evaluate(id=>S.storeSales['2026-10-17|'+id].name,id),'콜라 <캔>','historical name retained');
 await p.evaluate(id=>storeProductDelete(id),id);assert.equal(await p.evaluate(()=>storeProducts().length),0);assert.equal(await p.evaluate(()=>storeSummary().revenue),8500,'deleted product sales retained');
 await p.evaluate(()=>go('sales'));assert.equal(await p.locator('[data-store-sale]').count(),1,'historical deleted product is still editable');
 await qty().fill('4');await qty().press('Tab');assert.equal(await p.evaluate(()=>storeSummary().revenue),10000);
 const merge=await p.evaluate(()=>{const old=structuredClone(S),latest=structuredClone(S),key=Object.keys(S.storeSales)[0],id=Object.keys(S.storeProducts)[0];latest.storeProducts[id].at='2099-01-01T00:00:00Z';latest.storeProducts[id].deleted=true;latest.storeSales[key]={...latest.storeSales[key],qty:9,at:'2099-01-01T00:00:00Z'};mergeStoreRecords(old,latest);const one=old.storeSales[key].qty;mergeStoreRecords(old,S);return [one,old.storeSales[key].qty,old.storeProducts[id].deleted];});assert.deepEqual(merge,[9,9,true],'stale peer cannot resurrect product or old quantity');
 await p.evaluate(id=>storeSaleSet(17,id,'qty',''),id);assert.equal(await p.evaluate(()=>storeSummary().revenue),4000,'explicit clear removes only one day');
 assert.equal(await p.evaluate(id=>storeSaleSet(18,id,'qty','-1'),id),false);assert.equal(await p.evaluate(id=>storeSaleSet(18,id,'qty','1.5'),id),false);assert.equal(await p.evaluate(()=>storeSummary().revenue),4000);
 await p.evaluate(()=>{go('recipe');storeProductAdd({name:'라면',category:'식품',unit:'개',price:'1800',cost:''});});
 const id2=await p.evaluate(()=>storeProducts()[0].id);await p.evaluate(id=>storeSaleSet(17,id,'qty','1'),id2);assert.equal(await p.evaluate(()=>storeSummary().cost),null,'unknown cost not fabricated as zero');
 await p.evaluate(()=>localStorage.setItem(KEY,JSON.stringify(S)));await p.reload();assert.equal(await p.evaluate(()=>storeSummary().revenue),5800,'reload retains records');
 for(const page of ['home','recipe','board','sales','pl','settings','order','roster','fixed','data']){await p.evaluate(page=>go(page),page);for(const width of [1600,390,320]){await p.setViewportSize({width,height:1000});assert(await p.evaluate(()=>document.getElementById('main').scrollWidth<=document.getElementById('main').clientWidth+1),page+' fits '+width);if(['home','recipe','sales'].includes(page)&&[1600,390].includes(width))await p.screenshot({path:'/tmp/nmf-store-'+page+'-'+width+'.png'});}}
 await p.evaluate(()=>{localStorage.setItem('nmf_app','cafe');localStorage.setItem('nmf_supa_cafe',JSON.stringify({url:'',key:''}));});await p.reload();assert.equal(await p.evaluate(()=>APP),'cafe');assert((await p.evaluate(()=>S.recipes.length))>0);assert.equal(await p.evaluate(()=>Object.keys(S.storeProducts||{}).length),0);
 assert.deepEqual(errors,[]);console.log('STORE_ISOLATION_CATALOG_SALES_HISTORY_MERGE_RELOAD_PAGES_RESPONSIVE_OK');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
