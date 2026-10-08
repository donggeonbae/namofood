// Read-only live checks. Never submit drafts, generate AI recipes, or save state.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async()=>{
  const password=process.env.NMF_PW;
  const version=process.env.NMF_EXPECTED_VER||'1009-1-meat-methods';
  const minimum=Number(process.env.NMF_EXPECTED_RECIPE_MIN||827);
  if(!password)throw Error('NMF_PW required');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];let blockedWrites=0,documents=0;
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),password);
    await page.route('**/*',route=>{
      const req=route.request();
      if(req.isNavigationRequest())documents++;
      if(['GET','HEAD','OPTIONS'].includes(req.method()))return route.continue();
      let action;try{action=req.postDataJSON()?.action;}catch{}
      if(req.method()==='POST'&&req.url().endsWith('/functions/v1/nmf-recipe-fill')&&action==='status')return route.continue();
      blockedWrites++;return route.abort();
    });
    await page.goto('https://d-bae.com/namofood/?v='+encodeURIComponent(version)+'#recipe',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
    await page.waitForFunction(n=>new Set(S.recipes.map(r=>r.menu)).size>=n,minimum,{timeout:25000});
    const before=await page.evaluate(()=>{
      clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('recipe');
      return JSON.stringify(S);
    });
    assert.deepEqual(await page.evaluate(()=>SLOT_ORDER),[1,2,7,8,3,4]);
    assert.equal(await page.locator('#recipe-methods').count(),1);
    assert.equal(await page.locator('#recipe-ingredients').count(),1);
    assert.equal(await page.locator('#recipe-draft').count(),1);
    assert(await page.evaluate(()=>!!(document.getElementById('recipe-ingredients').compareDocumentPosition(document.getElementById('recipe-methods'))&Node.DOCUMENT_POSITION_FOLLOWING)),'primary ingredient precedes cooking method');
    await page.locator('#recipe-ingredients [data-ingredient="고기"]').click();
    assert.equal(await page.getByText('2. 고기 조리방식',{exact:true}).count(),1);
    const meatMethods=['볶음','구이','찜','조림','튀김','부침','삶음'];
    for(const method of meatMethods){
      const button=page.locator(`#recipe-methods [data-method="${method}"]`);
      assert.equal(await button.count(),1,method+' meat category is consistently visible');
      const count=Number(await button.locator('small').textContent());
      assert.equal(await button.isDisabled(),count===0);
      if(count){await button.click();assert(await page.evaluate(method=>recipeList().list.every(entry=>entry.group==='고기'&&entry.method===method),method));}
    }
    const meatClassification=await page.evaluate(()=>{
      const map=recipeMap(),expected={'닭갈비':'볶음','깐풍기':'튀김','유린기':'튀김','돼지등심카라아게':'튀김','경장육슬':'볶음'};
      return Object.fromEntries(Object.entries(expected).filter(([name])=>map[name]).map(([name,expected])=>[name,{expected,actual:recipeCookingMethod(name,map[name])}]));
    });
    assert(Object.keys(meatClassification).length>=3,'representative stored meat recipes exercise the classification');
    for(const [name,result] of Object.entries(meatClassification))assert.equal(result.actual,result.expected,name);
    assert.equal(await page.locator('#recipe-subingredients').evaluate(element=>element.open),false,'meat species are initially collapsed');
    await page.locator('#recipe-subingredients summary').click();
    assert.equal(await page.locator('#recipe-subingredients').evaluate(element=>element.open),true);
    for(const meat of ['소고기','돼지고기','닭고기','오리고기'])assert.equal(await page.locator(`#recipe-subingredients [data-subingredient="${meat}"]`).count(),1,meat+' remains available inside the shared meat group');
    assert.equal(await page.locator('#recipe-subingredients [data-subingredient="양파"]').count(),0,'vegetables cannot appear as meat species');
    await page.locator('#recipe-subingredients [data-subingredient="오리고기"]').click();
    assert((await page.locator('#rlist .rchip').count())>0,'duck recipes are discoverable through the optional subtype');
    assert(await page.evaluate(()=>recipeList().list.every(entry=>entry.group==='고기'&&entry.ingredients.includes('오리고기'))));
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.locator('#recipe-ingredients [data-ingredient="생선·해산물"]').click();
    await page.locator('#recipe-methods [data-method="튀김"]').click();
    assert((await page.locator('#rlist .rchip').count())>0);
    assert.match(await page.locator('#recipe-active-filter').innerText(),/생선·해산물.*→.*튀김/);
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    const evidence=await page.evaluate(()=>({
      recipeCount:new Set(S.recipes.map(r=>r.menu)).size,
      institutionalCount:Object.values(S.recipeMeta||{}).filter(m=>m.cookingProfile==='institutional-v1').length,
      aiMenuMeals:Object.values(S.menuPlanMeta||{}).filter(meta=>meta?.by==='ai').length,
      menuAutomationEnabled:S.menuAutomation?.enabled,
      menuAutomationPolicy:S.menuAutomation?.policy,
    }));
    assert.equal(evidence.aiMenuMeals,0,'production contains no remaining AI-marked meals');
    assert.equal(evidence.menuAutomationEnabled,false,'production records the disabled menu automation policy');
    assert.equal(evidence.menuAutomationPolicy,'manual-menu-v1');
    const soup=await page.evaluate(()=>Object.entries(recipeMap()).find(([name,rows])=>recipeFoodProfile(name,rows).slotGroup==='국')[0]);
    await page.evaluate(name=>rPick(name),soup);
    await page.locator('#recipe-draft-slot').selectOption('1');
    await page.locator('#rdetail').getByRole('button',{name:'임시 식단에 담기',exact:true}).click();
    assert.equal(await page.locator('#recipe-draft-count').textContent(),'1개 선택');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true);
    await page.getByRole('button',{name:'임시선택 비우기',exact:true}).click();
    await page.locator('[data-draft-picker="8"]').click();
    assert.equal(await page.locator('#pk-ingredients').count(),1);
    assert(await page.evaluate(()=>!!(document.getElementById('pk-ingredients').compareDocumentPosition(document.getElementById('pk-methods'))&Node.DOCUMENT_POSITION_FOLLOWING)));
    assert(await page.evaluate(()=>pickerFilter().list.length>0&&pickerFilter().list.every(entry=>entry.slotGroup==='기타 주찬')),'the live third-main picker excludes meat, fish and vegetables');
    await page.evaluate(()=>closePicker());
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'live browse and draft selection never mutate real state');
    const widths=[];
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});
      const fit=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(fit.scroll<=fit.width,'recipe page fits '+width);widths.push(fit);
    }
    await page.evaluate(()=>go('menu'));
    assert.equal(await page.locator('#main .ai-menu').count(),0,'meal editing contains no AI menu badges');
    assert.equal(await page.locator('#main').getByText(/AI기반|AI 기반|AI 식단/).count(),0,'meal editing contains no AI menu update controls');
    assert.equal(await page.locator('#recipe-monitor').count(),1,'the separate recipe automation monitor remains available');
    assert.doesNotMatch(await page.locator('#recipe-monitor').innerText(),/14일 뒤 식단 작성|누락 식단은 15분마다/,'recipe monitoring cannot advertise retired menu schedules');
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'visiting meal editing does not migrate legacy food values or headcounts');
    await page.evaluate(()=>{go('recipe');recipeSetIngredient('고기');});
    await page.screenshot({path:'/tmp/nmf-live-recipe-browse.png',fullPage:true});
    await page.evaluate(async()=>{await refreshRecipeMonitor(true);});
    const status=await page.evaluate(()=>({error:recipeMonitor.error,ready:!!recipeMonitor.data?.ok}));
    assert.equal(status.error,'');assert(status.ready);
    await page.waitForTimeout(9000);
    assert.equal(documents,1);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({version,...evidence,meatMethods,meatClassification,widths,status,ingredientFirst:true,meatSpeciesCollapsed:true,thirdMainPicker:true,draftPreservedState:true,productionWrites:0,blockedWrites,documents}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1);});
