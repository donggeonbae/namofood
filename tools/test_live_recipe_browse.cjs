// Read-only live checks. Never submit drafts, generate AI recipes, or save state.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async()=>{
  const password=process.env.NMF_PW;
  const version=process.env.NMF_EXPECTED_VER||'1008-1-institutional-recipes';
  const minimum=Number(process.env.NMF_EXPECTED_RECIPE_MIN||698);
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
    assert.equal(await page.locator('#recipe-methods').count(),1);
    assert.equal(await page.locator('#recipe-draft').count(),1);
    await page.locator('#recipe-methods [data-method="튀김"]').click();
    await page.locator('#recipe-ingredients [data-ingredient="생선"]').click();
    assert((await page.locator('#rlist .rchip').count())>0);
    assert.match(await page.locator('#recipe-active-filter').innerText(),/튀김 → 생선/);
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    const evidence=await page.evaluate(()=>({
      recipeCount:new Set(S.recipes.map(r=>r.menu)).size,
      institutionalCount:Object.values(S.recipeMeta||{}).filter(m=>m.cookingProfile==='institutional-v1').length,
      refreshedMeals:Object.entries(S.menuPlanMeta||{}).filter(([key,m])=>key.slice(0,10)>'2026-10-08'&&m.model==='codex-institutional-curation-v2').length,
    }));
    const soup=await page.evaluate(()=>Object.entries(recipeMap()).find(([name,rows])=>compNorm(name,rows[0].comp)==='국')[0]);
    await page.evaluate(name=>rPick(name),soup);
    await page.locator('#recipe-draft-slot').selectOption('1');
    await page.locator('#rdetail').getByRole('button',{name:'임시 식단에 담기',exact:true}).click();
    assert.equal(await page.locator('#recipe-draft-count').textContent(),'1개 선택');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true);
    await page.getByRole('button',{name:'임시선택 비우기',exact:true}).click();
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'live browse and draft selection never mutate real state');
    const widths=[];
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});
      const fit=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(fit.scroll<=fit.width,'recipe page fits '+width);widths.push(fit);
    }
    await page.screenshot({path:'/tmp/nmf-live-recipe-browse.png',fullPage:true});
    await page.evaluate(async()=>{await refreshRecipeMonitor(true);});
    const status=await page.evaluate(()=>({error:recipeMonitor.error,ready:!!recipeMonitor.data?.ok}));
    assert.equal(status.error,'');assert(status.ready);
    await page.waitForTimeout(9000);
    assert.equal(documents,1);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({version,...evidence,widths,status,draftPreservedState:true,productionWrites:0,blockedWrites,documents}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1);});
