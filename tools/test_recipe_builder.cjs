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
    assert.equal(await page.locator('#recipe-draft').count(),1,'food recipes need a local temporary meal builder');
    const injectionName='닭볶음 "한상" <img src=x onerror=window.recipeInjected=1>';
    await page.evaluate(injectionName=>{
      S.month='2026-10';S.recipes=[];S.methods={};S.recipeMeta={};S.sources={};S.recipeAsk={};
      const add=(menu,item,comp='부찬',qty=80)=>S.recipes.push({menu,item,comp,qty,unit:'g',loss:0,storage:'냉장',form:'원물'});
      add('생선까스','흰살생선','주찬');add('소고기튀김','소고기','주찬');add('치킨너겟','닭고기','주찬');add('당근튀김','당근');
      add('콩나물무침','콩나물');add('콩나물무침','다진마늘','부찬',4);add('당근무침','당근');add('시금치나물','시금치');
      add('애호박부침','애호박');add('가지볶음','가지');add('근대나물','근대');add('청경채무침','청경채');
      add('고사리볶음','고사리');add('참나물무침','참나물');add('미나리무침','미나리');add('숙주나물','숙주');add('취나물','취나물');
      add('우엉조림','우엉');add('브로콜리무침','브로콜리');add('배추김치','배추','김치');add('된장국','두부','국');
      add('우동','우동면','국');add('대구지리','대구살','국');add('청국장','청국장','국');add('닭볶음탕','닭고기','주찬');add('제육볶음','돼지고기','주찬');add('새급식볶음','다진마늘','주찬',5);add('새급식볶음','소스','주찬',20);add('새급식볶음','돈육','주찬',100);
      add('새급식무침','다진마늘','부찬',4);add('새급식무침','양배추','부찬',80);add('알수없는찬','미상재료');
      add('맥주','맥주','후식');add('맥주 닭찜','닭고기','주찬');add('채소주먹밥','쌀','밥');add('푸딩','우유','후식');add(injectionName,'닭고기','주찬');
      S.menus={
        '2026-10':{'12|중식|1':'현재달국','12|중식|n':'210'},
        '2026-11':{'12|중식|0':'쌀밥','12|중식|1':'옛국','12|중식|2':'옛주찬','12|중식|5':'옛김치','12|중식|11':'옛추가','12|중식|n':'333','12|중식|notes':'주방 메모','12|석식|2':'보호할석식','13|중식|2':'보호할다음날','13|중식|n':250},
      };
      S.menuPlanMeta={'2026-11-12|중식':{by:'ai',runId:'old'},'2026-11-12|석식':{by:'ai',runId:'keep'}};
      S.headcountMeta={'2026-11-12|중식':{by:'photo-plan',updated:'2026-10-01',source:'keep-exact'},'2026-11-13|중식':{by:'manual',updated:'2026-10-01'}};
      S.settings.fixtureSentinel={value:'preserve'};cloudMenuBase=captureCloudMenuBase(S);
      recipeDraftClear();recipeResetFilters();rSel=null;go('recipe');clearTimeout(saveTimer);
      localStorage.setItem(KEY,JSON.stringify(S));
    },injectionName);
    const original=await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)}));
    const listNames=()=>page.locator('#rlist .rchip').allTextContents();
    await page.locator('#recipe-methods [data-method="튀김"]').click();
    assert.deepEqual((await listNames()).sort(),['당근튀김','생선까스','소고기튀김','치킨너겟'].sort());
    assert.equal(await page.locator('#recipe-ingredients [data-ingredient="마늘"]').count(),0,'sauce garlic is not a main ingredient');
    await page.locator('#recipe-ingredients [data-ingredient="생선"]').click();
    assert.deepEqual(await listNames(),['생선까스']);
    assert.match(await page.locator('#recipe-active-filter').innerText(),/튀김 → 생선/);
    assert.equal(await page.locator('#recipe-methods [data-method="튀김"] small').textContent(),'4');
    await page.locator('#recipe-methods [data-method="무침"]').click();
    for(const name of ['나물','콩나물','당근','시금치','근대','청경채','참나물','미나리','숙주','취나물','브로콜리','양배추'])assert.equal(await page.locator(`#recipe-ingredients [data-ingredient="${name}"]`).count(),1,`vegetable group ${name} must be discoverable`);
    await page.locator('#recipe-ingredients [data-ingredient="콩나물"]').click();
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
    const addDetail=async(name,slot)=>{
      await page.evaluate(name=>rPick(name),name);
      await page.locator('#recipe-draft-slot').selectOption(String(slot));
      await page.locator('#rdetail').getByRole('button',{name:'임시 식단에 담기',exact:true}).click();
    };
    await addDetail('된장국',1);await addDetail('생선까스',2);await addDetail('제육볶음',7);
    await page.locator('[data-draft-slot="3"]').selectOption('콩나물무침');
    await page.locator('[data-draft-slot="4"]').selectOption('당근무침');
    await page.locator('[data-draft-slot="8"]').selectOption('배추김치');
    await addDetail('푸딩','extra');
    assert.equal(await page.locator('#recipe-draft-count').textContent(),'7개 선택');
    assert.equal(await page.locator('#recipe-draft-apply').isEnabled(),true);
    await page.locator('#recipe-draft-apply').click();
    assert.match(await page.locator('.toast').innerText(),/날짜와 끼니/,'date and meal must be explicitly supplied');
    assert.equal(await page.locator('#recipe-draft-date').getAttribute('min'),null,'explicit past dates remain available');
    await page.locator('#recipe-draft-date').fill('2026-11-12');
    await page.locator('#recipe-draft-meal').selectOption('중식');
    if(process.env.NMF_RECIPE_PREVIEW_DIR){
      await page.evaluate(()=>document.querySelector('.toast').classList.remove('show'));
      for(const width of [320,390,1280]){
        await page.setViewportSize({width,height:width<620?1800:1100});
        await page.locator('#recipe-draft').screenshot({path:path.join(process.env.NMF_RECIPE_PREVIEW_DIR,`recipe-draft-${width}.png`)});
        await page.evaluate(()=>document.getElementById('main').scrollTop=0);
        await page.screenshot({path:path.join(process.env.NMF_RECIPE_PREVIEW_DIR,`recipe-discovery-${width}.png`)});
      }
      await page.setViewportSize({width:1280,height:900});
    }
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)})),original,'all draft selection and target controls are non-persistent');
    await page.locator('[data-draft-slot="7"]').selectOption('생선까스');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'duplicate dish blocks applying');
    await page.locator('[data-draft-slot="7"]').selectOption('제육볶음');
    await page.locator('[data-draft-slot="1"]').selectOption('대구지리');
    assert.equal(await page.locator('#recipe-draft-apply').isEnabled(),true,'stored soup course supports a name without a soup suffix');
    await page.locator('[data-draft-slot="1"]').selectOption('청국장');
    assert.equal(await page.locator('#recipe-draft-apply').isEnabled(),true,'fermented soybean soup remains a valid soup');
    await page.locator('[data-draft-slot="1"]').selectOption('우동');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'noodles are not a soup');
    await page.locator('[data-draft-slot="1"]').selectOption('된장국');
    await page.locator('[data-draft-slot="1"]').selectOption('닭볶음탕');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'braised chicken main cannot occupy the soup slot');
    await page.locator('[data-draft-slot="1"]').selectOption('된장국');
    await page.locator('[data-draft-slot="8"]').selectOption('시금치나물');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'kimchi is required among the three sides');
    await page.locator('[data-draft-slot="8"]').selectOption('배추김치');
    await page.locator('[data-draft-slot="10"]').selectOption('맥주');
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'served alcohol blocks applying');
    await page.locator('[data-draft-slot="10"]').selectOption('푸딩');
    const drinkChecks=await page.evaluate(()=>Object.fromEntries(['맥주','무알코올 맥주','카스','테라 500ml','맥주+치킨','맥주 닭찜','채소주먹밥','청주식돼지불고기','칵테일새우','복분자주스','진저에일'].map(name=>[name,!!recipeDraftProhibitedReason(name)])));
    assert.deepEqual(drinkChecks,{'맥주':true,'무알코올 맥주':true,'카스':true,'테라 500ml':true,'맥주+치킨':true,'맥주 닭찜':false,'채소주먹밥':false,'청주식돼지불고기':false,'칵테일새우':false,'복분자주스':false,'진저에일':false});
    let dialogText='';
    page.once('dialog',async d=>{dialogText=d.message();await d.dismiss();});
    await page.locator('#recipe-draft-apply').click();
    assert.match(dialogText,/2026-11-12 중식/);assert.match(dialogText,/기존 음식 5개/);
    assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)})),original,'canceling overwrite preserves state and persistence exactly');
    const beforeApply=await page.evaluate(()=>structuredClone(S));
    page.once('dialog',d=>d.accept());await page.locator('#recipe-draft-apply').click();
    const applied=await page.evaluate(()=>structuredClone(S));
    const expectedMenus=structuredClone(beforeApply.menus);
    expectedMenus['2026-11']={'12|중식|1':'된장국','12|중식|2':'생선까스','12|중식|7':'제육볶음','12|중식|3':'콩나물무침','12|중식|4':'당근무침','12|중식|8':'배추김치','12|중식|10':'푸딩','12|중식|n':'333','12|중식|notes':'주방 메모','12|석식|2':'보호할석식','13|중식|2':'보호할다음날','13|중식|n':250};
    assert.deepEqual(applied.menus,expectedMenus);
    assert.equal(applied.month,'2026-10','applying a different month does not change the current view month');
    assert.deepEqual(applied.headcountMeta,beforeApply.headcountMeta,'count provenance is preserved byte for byte');
    const expectedMeta=structuredClone(beforeApply.menuPlanMeta);delete expectedMeta['2026-11-12|중식'];
    assert.deepEqual(applied.menuPlanMeta,expectedMeta,'manual meal removes only its own AI marker');
    const unaffected=s=>Object.fromEntries(Object.entries(s).filter(([key])=>!['menus','menuPlanMeta','updatedAt'].includes(key)));
    assert.deepEqual(unaffected(applied),unaffected(beforeApply),'all non-menu state is preserved');
    assert.equal(await page.locator('#recipe-draft-count').textContent(),'0개 선택');
    const merge=await page.evaluate(()=>{
      const remote=structuredClone(cloudMenuBase);remote.menus['2026-11']['12|중식|2']='서버AI다른주찬';remote.menuPlanMeta['2026-11-12|중식']={by:'ai',runId:'later'};
      mergeRemoteMenus(remote);return {name:S.menus['2026-11']['12|중식|2'],marker:S.menuPlanMeta['2026-11-12|중식']||null};
    });
    assert.deepEqual(merge,{name:'생선까스',marker:null},'later server AI merge must retain a manually applied meal');
    await addDetail('된장국',1);
    await page.evaluate(()=>{S.recipes=S.recipes.filter(r=>r.menu!=='된장국');render();});
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true);
    const beforeInvalid=await page.evaluate(()=>JSON.stringify(S));
    assert.equal(await page.evaluate(()=>recipeDraftApply()),false);
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),beforeInvalid,'a deleted recipe invalidates the draft without writes');
    await page.locator('#recipe-draft').getByRole('button',{name:'국 비우기',exact:true}).click();
    assert.equal(await page.locator('[data-draft-slot="1"]').inputValue(),'');
    await page.getByRole('button',{name:'임시선택 비우기',exact:true}).click();
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
      const bounds=await page.locator('#recipe-draft').boundingBox();assert(bounds.width<=width&&bounds.x>=0);
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
    console.log('RECIPE_METHOD_INGREDIENT_FILTERS / ALIASES_WEIGHTED_INGREDIENTS / GLOBAL_SEARCH / UNKNOWN_GROUP / INJECTION_SAFE / DRAFT_NO_PERSIST / SIX_SLOT_VALIDATION / ALCOHOL_EXCEPTIONS / OVERWRITE_CANCEL / TARGET_MONTH_MEAL_ONLY / EXACT_HEADCOUNT_PRESERVATION / MANUAL_AI_MERGE_PROTECTION / DELETED_RECIPE / MANUAL_RECIPE_CRUD / 320_390_1280 / PRINT / CAFE_PASS');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
