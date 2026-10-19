const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({timezoneId:'Asia/Seoul'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
  await page.goto('https://offline.namofood.test/');
  await page.evaluate(()=>{
   clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;
   S=normalize(defaultState());S.month='2026-10';selDay=19;
   S.menus={'2026-10':{'19|중식|2':'시험 고기','19|중식|n':100,'20|중식|2':'시험 고기','20|중식|n':40}};
   S.recipes=[{menu:'시험 고기',item:'돼지고기',qty:100,unit:'g',loss:.2,comp:'주찬'},{menu:'시험 고기',item:'양념',qty:10,unit:'ml',loss:0},{menu:'시험 고기',item:'달걀',qty:.5,unit:'ea',loss:0},{menu:'쌀밥',item:'쌀',qty:105,unit:'g',loss:0}];
   S.methods={};S.prices={'돼지고기':{price:10000}};S.orderAdj={'2026-10':{'돼지고기':3}};S.extraOrders={'2026-10':[{item:'별도',qty:2,price:500,unit:'ea'}]};S.view={range:'day',mode:'internal',ing:true};go('menu');
  });
  assert.equal(await page.evaluate(()=>recipeOrderMultiplier()),2,'existing records without setting default to double');
  const before=await page.evaluate(()=>JSON.stringify({recipes:S.recipes,menus:S.menus,sales:S.sales,orders:S.orders,prices:S.prices,adj:S.orderAdj,extra:S.extraOrders}));
  assert.deepEqual(await page.evaluate(()=>{const g=ingredientsFor('시험 고기',100)[0];return {base:g.baseNeed,need:g.need,per:g.per,unit:g.needUnit};}),{base:12.5,need:25,per:100,unit:'kg'});
  assert.equal(await page.evaluate(()=>ingredientsFor('시험 고기',100)[1].need),2);
  assert.equal(await page.evaluate(()=>ingredientsFor('시험 고기',100)[2].need),100);
  assert.equal(await page.evaluate(()=>ingredientsFor('시험 고기',0)[0].need),0);
  assert.equal(await page.evaluate(()=>ingredientsFor('쌀밥',100)[0].need),21);
  assert((await page.evaluate(()=>JSON.stringify(menuPdfSnapshot()))).includes('발주 2배'),'internal PDF snapshot labels doubled quantities');
  assert((await page.evaluate(()=>JSON.stringify(menuPdfSnapshot()))).includes('25kg'),'internal PDF uses identical quantities');
  assert.deepEqual(await page.evaluate(()=>{const x=requirements(new Set([19,20])).items.find(x=>x.item==='돼지고기');return {total:x.total,base:x.baseTotal,week:x.weeks[2]};}),{total:35,base:17.5,week:35});
  assert((await page.locator('#menu-day-ingredients').innerText()).includes('기준 12.5kg'));
  assert((await page.locator('#menu-day-ingredients').innerText()).includes('25kg'));
  const panel=page.locator('#menu-day-ingredients [data-recipe-allowance]');
  assert.equal(await panel.evaluate(e=>e.open),false);
  await panel.locator('summary').click();const input=panel.locator('input');await input.fill('1.5');await input.dispatchEvent('change');
  assert.equal(await page.evaluate(()=>ingredientsFor('시험 고기',100)[0].need),18.75);
  for(const bad of ['','0','-1','11','abc']){await page.evaluate(v=>setRecipeOrderMultiplier(v),bad);assert.equal(await page.evaluate(()=>recipeOrderMultiplier()),1.5,'reject invalid allowance '+bad);}
  await page.evaluate(()=>{setRecipeOrderMultiplier('2');rSet(0,'qty',120);});
  assert.equal(await page.evaluate(()=>ingredientsFor('시험 고기',100)[0].need),30,'base edit scales exactly once');
  await page.evaluate(()=>rSet(0,'qty',100));
  await page.evaluate(()=>{portion=100;go('recipe');rSel='시험 고기';render();});
  assert((await page.locator('#rdetail').innerText()).includes('기준 12.5kg'));
  assert((await page.locator('#rdetail').innerText()).includes('25'));
  await page.emulateMedia({media:'print'});assert((await page.locator('#rdetail').innerText()).includes('2배'));await page.emulateMedia({media:'screen'});
  await page.evaluate(()=>{orderRange={mode:'day',date:'2026-10-19'};document.getElementById('main').innerHTML=orderCalc();});
  const exports=await page.evaluate(()=>{let data;const old=csv;csv=(name,rows)=>data=rows;[...document.querySelectorAll('button')].find(e=>e.textContent.includes('CSV')).click();csv=old;return data;});
  const row=exports.find(x=>x[0]==='돼지고기');assert.equal(+row[3],28,'manual adjustment is added after doubling, never doubled');
  const header=exports[0];assert.equal(+row[header.indexOf('기준 필요량')],12.5);assert.equal(+row[header.indexOf('발주 배수')],2);
  assert.equal(exports.find(x=>String(x[0]).includes('[추가]'))[3],2,'manual extra quantities unchanged');
  assert.equal(await page.evaluate(()=>JSON.stringify({recipes:S.recipes,menus:S.menus,sales:S.sales,orders:S.orders,prices:S.prices,adj:S.orderAdj,extra:S.extraOrders})),before,'no mutation of recipes, counts, actual ledgers, prices or manual adjustments');
  await page.evaluate(()=>{cloudConfigBase=captureCloudConfigBase(S);const remote=structuredClone(S);remote.settings.recipeOrderMultiplier=1.5;mergeRemoteConfig(remote);});
  assert.equal(await page.evaluate(()=>recipeOrderMultiplier()),1.5,'shared config adopts another PC edit');
  await page.evaluate(()=>{S.settings.recipeOrderMultiplier=2;save();selDay=19;go('menu');});await page.waitForTimeout(600);
  for(const width of [1440,620,390,320]){await page.setViewportSize({width,height:1000});await page.locator('#menu-day-ingredients [data-recipe-allowance]').evaluate(e=>e.open=true);assert(await page.evaluate(()=>{const m=document.getElementById('main');return m.scrollWidth<=m.clientWidth+1;}),'compact allowance fits '+width);if(width===1440||width===390)await page.locator('#menu-day-ingredients').screenshot({path:'/tmp/nmf-recipe-allowance-'+width+'.png'});}
  await page.reload();await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);cloudApplying=true;});
  assert.equal(await page.evaluate(()=>recipeOrderMultiplier()),2,'setting survives reload');
  const cafe=await browser.newPage();await cafe.addInitScript(()=>localStorage.setItem('nmf_app','cafe'));await cafe.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());await cafe.goto('https://offline.namofood.test/');
  assert.equal(await cafe.evaluate(()=>{S.settings.recipeOrderMultiplier=4;return recipeOrderMultiplier();}),1,'cafe is never multiplied');
  assert.equal(await cafe.evaluate(()=>recipeOrderAllowanceHtml()),'');
  assert.deepEqual(errors,[]);console.log('RECIPE_ORDER_ALLOWANCE_DEFAULT_DOUBLE_BASE_LOSS_UNITS_RICE_ZERO_INLINE_EDIT_CSV_ADJUSTMENTS_CONFIG_MERGE_RELOAD_MOBILE_NO_LEDGER_WRITES_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
