// Browser checks use synthetic fixtures; all outgoing requests are blocked or mocked.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const source=fs.readFileSync(path.join(__dirname,'..','나모푸드_관리앱.html'),'utf8');
    for(const m of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))new Function(m[1]);
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let writeRequests=0;
    const blockWrites=async route=>{
      const req=route.request();
      if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
      if(!['GET','HEAD'].includes(req.method()))writeRequests++;
      if(req.url().includes('/rest/v1/namofood_state')&&req.method()==='GET')return route.fulfill({json:[]});
      return route.abort();
    };
    await page.route('**/*',blockWrites);
    await page.goto('https://namofood.test/');
    await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;recipeQ='';rCat='전체';rSel=null;go('recipe');});
    if(process.argv.includes('--baseline')){
      assert.equal(await page.locator('#recipe-methods').count(),0,'RED: cooking-method filter is absent before implementation');
      assert.equal(await page.locator('#recipe-draft').count(),0,'RED: temporary meal builder is absent before implementation');
      console.log('RECIPE_BUILDER_BASELINE_RED_CONFIRMED');return;
    }
    assert.equal(await page.locator('#recipe-methods').count(),1,'food recipes need cooking-method filters');
    assert.equal(await page.locator('#recipe-draft').count(),0,'temporary meal builder is retired from recipes');
    const injectionName='닭볶음 "한상" <img src=x onerror=window.recipeInjected=1>';
    await page.evaluate(injectionName=>{
      S.month='2026-10';S.recipes=[];S.methods={};S.recipeMeta={};S.sources={};S.recipeAsk={};
      const add=(menu,item,comp='부찬',qty=80)=>S.recipes.push({menu,item,comp,qty,unit:'g',loss:0,storage:'냉장',form:'원물'});
      add('생선까스','흰살생선','주찬');add('소고기튀김','소고기','주찬');add('치킨너겟','닭고기','주찬');add('당근튀김','당근');
      add('콩나물무침','콩나물');add('콩나물무침','다진마늘','부찬',4);add('당근무침','당근');add('시금치나물','시금치');
      add('애호박부침','애호박');add('가지볶음','가지');add('근대나물','근대');add('청경채무침','청경채');add('계란말이','달걀','주찬');add('두부부침','두부','주찬');
      add('고사리볶음','고사리');add('참나물무침','참나물');add('미나리무침','미나리');add('숙주나물','숙주');add('취나물','취나물');
      add('우엉조림','우엉');add('브로콜리무침','브로콜리');add('배추김치','배추','김치');add('된장국','두부','국');
      add('우동','우동면','국');add('대구지리','대구살','국');add('청국장','청국장','국');add('닭볶음탕','닭고기','주찬');add('제육볶음','돼지고기','주찬');add('새급식볶음','다진마늘','주찬',5);add('새급식볶음','소스','주찬',20);add('새급식볶음','돈육','주찬',100);
      add('새급식무침','다진마늘','부찬',4);add('새급식무침','양배추','부찬',80);add('알수없는찬','미상재료');
      add('맥주','맥주','후식');add('맥주 닭찜','닭고기','주찬');add('채소주먹밥','쌀','밥');add('푸딩','우유','후식');add(injectionName,'닭고기','주찬');
      S.menus={
        '2026-10':{'12|중식|1':'현재달국','12|중식|n':'210'},
        '2026-11':{'12|중식|0':'쌀밥','12|중식|1':'옛국','12|중식|2':'옛주찬','12|중식|5':'옛김치','12|중식|11':'옛추가','12|중식|n':'333','12|중식|notes':'주방 메모','12|석식|2':'보호할석식','13|중식|2':'보호할다음날','13|중식|n':250},
      };
      S.menuPlanMeta={'2026-11-12|중식':{by:'manual',runId:'old'},'2026-11-12|석식':{by:'manual',runId:'keep'}};
      S.headcountMeta={'2026-11-12|중식':{by:'photo-plan',updated:'2026-10-01',source:'keep-exact'},'2026-11-13|중식':{by:'manual',updated:'2026-10-01'}};
      S.settings.fixtureSentinel={value:'preserve'};cloudMenuBase=captureCloudMenuBase(S);
      recipeDraftClear();recipeResetFilters();rSel=null;go('recipe');clearTimeout(saveTimer);
      localStorage.setItem(KEY,JSON.stringify(S));
    },injectionName);
    const original=await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)}));
    const listNames=()=>page.locator('#rlist .rchip').allTextContents();
    await page.locator('#recipe-ingredients [data-ingredient="생선·해산물"]').click();
    await page.locator('#recipe-methods [data-method="튀김"]').click();
    assert.deepEqual(await listNames(),['생선까스']);
    assert.equal(await page.locator('#recipe-ingredients [data-ingredient="마늘"]').count(),0,'sauce garlic is not a main ingredient');
    assert.match(await page.locator('#recipe-active-filter').innerText(),/생선·해산물.*→.*튀김/);
    assert.equal(await page.locator('#recipe-methods [data-method="튀김"] small').textContent(),'1');
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.locator('#recipe-ingredients [data-ingredient="야채"]').click();
    await page.locator('#recipe-methods [data-method="무침"]').click();
    assert.equal(await page.locator('#recipe-subingredients').evaluate(element=>element.open),false,'vegetable ingredient details start collapsed');
    await page.locator('#recipe-subingredients summary').click();
    for(const name of ['콩나물','당근','시금치','근대','청경채','참나물','미나리','숙주','취나물','브로콜리','양배추'])assert.equal(await page.locator(`#recipe-subingredients [data-subingredient="${name}"]`).count(),1,`vegetable subgroup ${name} must be discoverable`);
    await page.locator('#recipe-subingredients [data-subingredient="콩나물"]').click();
    assert.deepEqual(await listNames(),['콩나물무침']);
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.locator('#rqq').fill('돈육');await page.waitForTimeout(200);
    assert.deepEqual(await listNames(),['새급식볶음'],'global ingredient search must match ingredient rows');
    const classified=await page.evaluate(()=>({
      fallback:recipeMainIngredients('새급식볶음',recipeMap()['새급식볶음']),
      vegetable:recipeMainIngredients('새급식무침',recipeMap()['새급식무침']),
      noodle:recipeCookingMethod('우동',recipeMap()['우동']),
      namedSoup:recipeCookingMethod('대구지리',recipeMap()['대구지리']),
      fermentedSoup:recipeCookingMethod('청국장',recipeMap()['청국장']),
      noodleSoup:recipeCookingMethod('우동국',[{comp:'국'}]),
      doughSoup:recipeCookingMethod('수제비',[{comp:'국'}]),
      aliases:recipeMainIngredients('소불고기',[{item:'마늘',qty:20}]),
      chickenStew:recipeCookingMethod('닭볶음탕',[{comp:'국'}]),
      chickenAlias:recipeCookingMethod('닭도리탕',[{comp:'국'}]),
      patty:recipeCookingMethod('동그랑땡',[{comp:'부찬'}]),
    }));
    assert.deepEqual(classified,{fallback:['돼지고기'],vegetable:['양배추'],noodle:'밥·면',namedSoup:'국·찌개',fermentedSoup:'국·찌개',noodleSoup:'밥·면',doughSoup:'밥·면',aliases:['소고기'],chickenStew:'찜',chickenAlias:'찜',patty:'부침'});
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.locator('#recipe-course').selectOption('김치');
    assert.deepEqual(await listNames(),['배추김치']);
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.locator('#recipe-methods [data-method="기타/미분류"]').click();
    assert((await listNames()).includes('알수없는찬'),'unknown recipes stay discoverable');
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.locator('#rlist .rchip').filter({hasText:injectionName}).click();
    assert.equal(await page.evaluate(()=>window.recipeInjected||0),0);
    assert((await page.locator('#rdetail h2').textContent()).includes(injectionName));
    assert.equal(await page.locator('#recipe-draft,#recipe-draft-slot,#recipe-draft-apply').count(),0,'retired temporary meal controls remain absent after recipe selection');
    assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)})),original,'recipe discovery remains non-mutating after retiring drafts');
    await page.evaluate(()=>{rAdd('직접추가반찬');rRenameTo('직접추가반찬','직접추가 당근무침');});
    await page.locator('#rdetail tbody tr').first().locator('input').first().fill('당근');
    await page.locator('#rdetail tbody tr').first().locator('input').first().blur();
    assert.equal(await page.evaluate(()=>recipeMap()['직접추가 당근무침'][0].item),'당근');
    await page.locator('#rqq').fill('직접추가');await page.waitForTimeout(200);
    assert.deepEqual(await listNames(),['직접추가 당근무침']);
    page.once('dialog',d=>d.accept());await page.locator('#rdetail').getByRole('button',{name:'음식 삭제',exact:true}).click();
    assert.equal(await page.evaluate(()=>!!recipeMap()['직접추가 당근무침']),false);
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.evaluate(()=>rPick('생선까스'));
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`no full-page horizontal overflow at ${width}px`);
      assert.equal(await page.locator('#recipe-draft-slot').count(),0,'draft chooser stays absent at every width');
      if(process.env.NMF_RECIPE_PREVIEW_DIR)await page.screenshot({path:path.join(process.env.NMF_RECIPE_PREVIEW_DIR,`recipe-builder-${width}.png`),fullPage:true});
    }
    await page.emulateMedia({media:'print'});
    assert.equal(await page.locator('#recipe-draft').isVisible(),false);
    assert.equal(await page.locator('#recipe-draft-slot').isVisible(),false);
    await page.emulateMedia({media:'screen'});
    const cafe=await browser.newPage({viewport:{width:390,height:844}});
    await cafe.addInitScript(()=>localStorage.setItem('nmf_app','cafe'));
    await cafe.route('**/*',blockWrites);await cafe.goto('https://namofood.test/');
    await cafe.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('recipe');});
    assert.equal(await cafe.locator('#recipe-methods').count(),0);
    assert.equal(await cafe.locator('#recipe-draft').count(),0);
    assert.match(await cafe.locator('#main h1').innerText(),/레시피 \(1잔 · 1개 분량표\)/);
    assert.equal(await cafe.locator('#main .tabs button').filter({hasText:/^커피\s/}).count(),1,'cafe course filters stay available');
    await cafe.close();
    assert.equal(writeRequests,0,'synthetic UI tests send no network writes');
    assert.deepEqual(errors,[]);
    console.log('RECIPE_INGREDIENT_METHOD_FILTERS / COLLAPSED_SUBINGREDIENTS / ALIASES_WEIGHTED_INGREDIENTS / GLOBAL_SEARCH / UNKNOWN_GROUP / INJECTION_SAFE / TEMPORARY_MEAL_RETIRED / DISCOVERY_NO_PERSIST / MANUAL_RECIPE_CRUD / 320_390_1280 / PRINT / CAFE_PASS');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
