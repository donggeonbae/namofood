const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const live=process.env.NMF_LIVE==='1',version=process.env.NMF_VERSION||'1014-2-menu-ingredients';
    const page=await browser.newPage({timezoneId:'Asia/Seoul'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    if(live){assert(process.env.NMF_PW);await page.addInitScript(pw=>{localStorage.setItem('nmf_app','food');sessionStorage.setItem('nmf_session_pw',pw);},process.env.NMF_PW);}
    await page.route('**/*',route=>{const q=route.request(),u=new URL(q.url());if(!live)return q.isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):route.abort();if(u.pathname==='/rest/v1/namofood_state'&&q.method()==='GET')return route.fulfill({json:[]});return ['GET','HEAD','OPTIONS'].includes(q.method())?route.continue():route.abort();});
    await page.goto(live?'https://d-bae.com/namofood/?v='+version:'https://offline.namofood.test');
    if(live)await page.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
    await page.evaluate(()=>{
      clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';selDay=14;
      S.menus={'2026-10':{'14|중식|2':'시험 제육','14|중식|n':100,'14|석식|2':'시험 제육','14|석식|n':40,'14|야식|2':'없는 음식','15|중식|2':'다음날 음식','15|중식|n':999}};
      S.recipes=[{menu:'시험 제육',item:'돼지고기',qty:100,unit:'g',loss:.2,comp:'주찬'}, {menu:'시험 제육',item:'소스',qty:10,unit:'ml',loss:0,comp:'주찬'}, {menu:'시험 제육',item:'포장김',qty:.5,unit:'ea',loss:0,comp:'주찬'}, {menu:'다음날 음식',item:'당근',qty:300,unit:'g',loss:0,comp:'주찬'}];
      S.riceRecipeInitialized=false;ensureDefaultRiceRecipe(S);S.methods={'시험 제육':'대형 솥에 나눠 볶는다.\n배식 전 보온한다.'};S.recipeMeta={'시험 제육':{by:'ai',cookingProfile:'institutional-v1'}};S.recipeAsk={};S.prices={};S.view={range:'day',mode:'public',ing:false};go('menu');
    });
    assert.equal(await page.locator('#menu-day-ingredients').count(),1,'day ingredient section exists independently');
    const ingredients=page.locator('#menu-day-ingredients'),methods=page.locator('#menu-day-methods');
    assert(!(await ingredients.innerText()).includes('대형 솥'),'cooking method is not mixed into ingredients');
    assert(!(await ingredients.innerText()).includes('당근'),'only selected day ingredients');
    assert((await ingredients.innerText()).includes('이 날 쌀 필요량(생쌀) · 50.4kg'),'rice includes explicit lunch/dinner counts and the default for the blank night forecast');
    assert((await ingredients.innerText()).includes('레시피 없음'),'missing recipes remain actionable');
    assert.equal(await methods.evaluate(e=>e.open),false,'methods initially collapsed');
    assert(await methods.evaluate(e=>e===document.getElementById('main').lastElementChild),'method panel at bottom of meal page');
    assert.equal(await ingredients.locator('input[data-menu-recipe-qty="0"]').count(),2,'same recipe appears in two meal contexts');
    const qty=ingredients.locator('[data-day-ingredient-meal="중식"] input[data-menu-recipe-qty="0"]');
    await methods.locator('summary').click();assert((await methods.innerText()).includes('대형 솥'));
    await qty.fill('125.5');await qty.press('Tab');
    assert.deepEqual(await page.evaluate(()=>({qty:S.recipes[0].qty,loss:S.recipes[0].loss,unit:S.recipes[0].unit,by:S.recipeMeta['시험 제육'].by,profile:S.recipeMeta['시험 제육'].cookingProfile})),{qty:125.5,loss:.2,unit:'g',by:'user',profile:'institutional-v1'});
    assert.equal(await ingredients.locator('[data-day-ingredient-meal="석식"] input[data-menu-recipe-qty="0"]').inputValue(),'125.5','same recipe refreshes across meals');
    assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',100)[0].need),31.375,'headcount and loss scale g to kg exactly');
    assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',40)[0].need),12.55);
    assert.equal(await page.evaluate(()=>requirements(new Set([14])).items.find(x=>x.item==='돼지고기').total),43.925,'day purchasing requirement also recalculates');
    assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',100)[1].need),2,'ml retains L scaling');
    assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',100)[2].need),100,'ea retains count scaling');
    assert.equal(await methods.evaluate(e=>e.open),true,'local expansion persists after quantity render');
    assert.equal(await page.evaluate(()=>S.recipes[3].qty),300,'unrelated recipe unchanged');
    assert.equal(await page.evaluate(()=>menuCount(14,'중식')),100,'quantity never changes headcount');
    await page.waitForTimeout(550);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem(KEY)).recipes[0].qty),125.5,'recipe saved to device');
    for(const invalid of ['-1','abc','','Infinity']){await qty.fill(invalid);await qty.dispatchEvent('change');assert.equal(await page.evaluate(()=>S.recipes[0].qty),125.5,'invalid quantity preserves existing recipe: '+invalid);}
    await qty.fill('0');await qty.dispatchEvent('change');assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',100)[0].need),0,'explicit zero valid');
    await qty.fill('1,250.75');await qty.dispatchEvent('change');assert.equal(await page.evaluate(()=>S.recipes[0].qty),1250.75,'commas and decimals accepted');
    await page.evaluate(()=>{selDay=15;render();});assert.equal(await methods.evaluate(e=>e.open),false,'new day methods initially collapsed');
    await page.evaluate(()=>{selDay=14;render();});assert.equal(await methods.evaluate(e=>e.open),true,'return to date preserves its expansion');
    await page.emulateMedia({media:'print'});assert.equal(await ingredients.isVisible(),false);assert.equal(await methods.isVisible(),false,'external meal printing unchanged');await page.emulateMedia({media:'screen'});
    await ingredients.locator('[data-day-ingredient-meal="중식"] input[data-menu-recipe-item="0"]').fill('돼지 앞다리');await ingredients.locator('[data-day-ingredient-meal="중식"] input[data-menu-recipe-item="0"]').dispatchEvent('change');assert.equal(await page.evaluate(()=>S.recipes[0].item),'돼지 앞다리');
    const unit=ingredients.locator('[data-day-ingredient-meal="중식"] select[data-menu-recipe-unit="0"]');await unit.selectOption('kg');assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',100)[0].needUnit),'kg');await unit.selectOption('g');
    page.once('dialog',d=>d.accept('양파'));await ingredients.locator('[data-day-ingredient-meal="중식"][data-day-ingredient-menu="시험 제육"] [data-menu-add-ingredient]').click();
    const added=ingredients.locator('[data-day-ingredient-meal="중식"] input[data-menu-recipe-qty][data-recipe-item="양파"]');await added.fill('20');await added.dispatchEvent('change');assert.equal(await page.evaluate(()=>ingredientsFor('시험 제육',100).find(x=>x.item==='양파').need),4,'new ingredient included in totals');
    const remove=ingredients.locator('[data-day-ingredient-meal="중식"] [data-menu-delete-ingredient][data-recipe-item="양파"]');page.once('dialog',d=>d.dismiss());await remove.click();assert.equal(await added.count(),1,'canceled removal preserves ingredient');page.once('dialog',d=>d.accept());await remove.click();assert.equal(await ingredients.locator('input[data-menu-recipe-qty][data-recipe-item="양파"]').count(),0,'deletion updates every same-menu meal');
    for(const width of [1440,900,620,390,320]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>{const m=document.getElementById('main');return m.scrollWidth<=m.clientWidth+1;}),'expanded ingredients and methods fit '+width);assert(await ingredients.locator('input[data-menu-recipe-qty]').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().right<=document.getElementById('main').getBoundingClientRect().right+1&&e.getBoundingClientRect().width<=100)),'quantity inputs compact and not clipped '+width);if(width===1440||width===390)await ingredients.screenshot({path:'/tmp/nmf-menu-ingredients-'+width+'.png'});}
    await page.waitForTimeout(550);await page.reload();if(live)await page.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);cloudApplying=true;selDay=14;go('menu');});assert.equal(await page.evaluate(()=>S.recipes[0].qty),1250.75,'reload retains recipe edit');
    await page.evaluate(()=>{S.menus={'2026-10':{}};render();});assert((await ingredients.innerText()).includes('이 날 식단이 비어 있습니다.'));
    assert.deepEqual(errors,[]);console.log('SELECTED_DAY_INGREDIENTS_INLINE_PER_PERSON_QTY_SHARED_RECIPE_LOSS_UNITS_VALIDATION_ZERO_PERSISTENCE_BOTTOM_COLLAPSED_METHODS_PRINT_MOBILE_NO_PRODUCTION_WRITES_OK'+(live?' · '+version:''));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
