// Synthetic browser contract tests. No production state or network writes are used.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright');

(async()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(process.env.NMF_APP_SOURCE||path.join(root,'나모푸드_관리앱.html'),'utf8');
  for(const match of source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))new Function(match[1]);
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];let writeRequests=0;
    page.on('pageerror',error=>errors.push(error.message));
    const routeAll=async route=>{
      const request=route.request();
      if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
      if(!['GET','HEAD','OPTIONS'].includes(request.method()))writeRequests++;
      if(request.url().includes('/rest/v1/namofood_state')&&request.method()==='GET')return route.fulfill({json:[]});
      return route.abort();
    };
    await page.route('**/*',routeAll);await page.goto('https://namofood.test/');
    await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;});
    // This is the first discriminating oracle: the old layout has two mains/three sides.
    assert.deepEqual(await page.evaluate(()=>SLOT_ORDER),[1,2,7,8,3,4],'three ingredient-specific mains must precede two vegetable sides');
    await page.evaluate(()=>{
      S.month='2026-10';S.recipes=[];S.methods={};S.recipeMeta={};S.recipeAsk={};S.sources={};
      const add=(menu,item,comp='주찬',qty=100,unit='g')=>{S.recipes.push({menu,item,comp,qty,unit,loss:0,storage:'냉장',form:'원물'});S.methods[menu]='1. 식수를 확인해 계량한다. 2. 대형 조리기구에서 배치별로 조리한다.';};
      add('제육볶음','돼지고기');add('소불고기','소고기');add('닭갈비','닭고기');add('훈제오리구이','오리고기');
      add('작업장특식볶음','닭고기', '주찬',100);add('작업장특식볶음','양배추','주찬',180);add('작업장특식볶음','다진마늘','주찬',4);
      add('고등어구이','고등어');add('오징어볶음','오징어');add('생선까스','흰살생선');
      add('계란말이','달걀');add('두부부침','두부');add('감자튀김','감자');
      add('콩나물무침','콩나물','부찬');add('시금치나물','시금치','부찬');add('배추김치','배추','김치');
      add('작업장채소무침','양배추','부찬');add('작업장채소무침','다진마늘','부찬',4);add('작업장채소무침','멸치육수','부찬',30,'ml');
      add('고기조금넣은채소무침','양배추','부찬');add('고기조금넣은채소무침','돼지고기','부찬',5);
      add('들깨된장국','두부','국',25);add('들깨된장국','시래기','국',50);add('대구지리','대구살','국');
      add('쌀밥','쌀','밥');add('푸딩','우유','후식');add('맥주','맥주','후식');
      S.recipeMeta['닭갈비']={by:'ai',cookingProfile:'institutional-v1'};
      S.menus={'2026-10':{'12|중식|0':'쌀밥','12|중식|1':'들깨된장국','12|중식|2':'옛수동고기','12|중식|7':'옛수동생선','12|중식|8':'배추김치','12|중식|3':'옛나물','12|중식|4':'옛채소','12|중식|10':'추가수동찬','12|중식|n':'333','12|중식|notes':'작업 메모','12|석식|2':'보호할다른끼니','13|중식|2':'보호할다음날'}};
      S.menuPlanMeta={'2026-10-12|중식':{by:'manual',runId:'old-manual-marker'}};
      S.headcountMeta={'2026-10-12|중식':{by:'photo-plan',source:'keep-exact'}};
      S.settings.fixtureSentinel={value:'keep'};
      cloudMenuBase=captureCloudMenuBase(S);recipeDraftClear();recipeResetFilters();selDay=12;go('menu');clearTimeout(saveTimer);
      localStorage.setItem(KEY,JSON.stringify(S));
    });
    assert.deepEqual(await page.evaluate(()=>SLOT_ORDER.map(slotLabel)),['국','메인1 · 고기','메인2 · 생선·해산물','메인3 · 기타 주찬','부찬1 · 야채','부찬2 · 야채']);
    assert.equal(await page.locator('#main').getByText(/AI기반|AI 기반|AI 자동 편성|자동 식단/).count(),0,'automatic-menu controls and provenance are absent');
    for(const mode of ['public','internal']){
      await page.evaluate(mode=>{S.view={range:'day',mode,ing:false};render();},mode);
      assert.equal((await page.locator('#menu-print-sheet').innerText()).includes('🤖'),false,'menu print shows no AI badge in either mode');
    }
    const original=await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)}));
    // Rendering an old kimchi value in the newly-labelled main slot is not a migration.
    assert.equal(await page.evaluate(()=>menuGet(12,'중식',8)),'배추김치');
    const classifications=await page.evaluate(()=>{
      const recipes=recipeMap(),names=['제육볶음','소불고기','닭갈비','훈제오리구이','작업장특식볶음','고등어구이','오징어볶음','계란말이','두부부침','감자튀김','콩나물무침','배추김치','작업장채소무침','고기조금넣은채소무침','들깨된장국','푸딩','맥주'];
      return Object.fromEntries(names.map(name=>[name,recipeFoodProfile(name,recipes[name]).slotGroup]));
    });
    assert.deepEqual(classifications,{'제육볶음':'고기','소불고기':'고기','닭갈비':'고기','훈제오리구이':'고기','작업장특식볶음':'고기','고등어구이':'생선','오징어볶음':'생선','계란말이':'기타 주찬','두부부침':'기타 주찬','감자튀김':'야채','콩나물무침':'야채','배추김치':'야채','작업장채소무침':'야채','고기조금넣은채소무침':'야채','들깨된장국':'국','푸딩':'선택 제외','맥주':'선택 제외'});
    const pickerNames=()=>page.locator('#pklist>button').evaluateAll(buttons=>buttons.map(button=>button.firstChild.textContent.trim()));
    await page.evaluate(()=>openPicker(12,'중식',2));
    assert.deepEqual((await pickerNames()).sort(),['제육볶음','소불고기','닭갈비','훈제오리구이','작업장특식볶음'].sort());
    assert.equal(await page.locator('#pk-ingredients [data-ingredient="고기"]').count(),1,'one umbrella group includes all meat species');
    assert.equal(await page.locator('#pk-subingredients').evaluate(element=>element.open),false,'meat species are collapsed initially');
    assert(await page.evaluate(()=>!!(document.getElementById('pk-ingredients').compareDocumentPosition(document.getElementById('pk-methods'))&Node.DOCUMENT_POSITION_FOLLOWING)),'main ingredient precedes method');
    await page.locator('#pk-subingredients summary').click();
    assert.equal(await page.locator('#pk-subingredients').evaluate(element=>element.open),true,'species open only when requested');
    for(const meat of ['소고기','돼지고기','닭고기','오리고기'])assert.equal(await page.locator(`#pk-subingredients [data-subingredient="${meat}"]`).count(),1,`${meat} is a discoverable optional meat subtype`);
    assert.equal(await page.locator('#pk-subingredients [data-subingredient="양배추"]').count(),0,'incidental vegetables are not meat species');
    await page.locator('#pk-subingredients [data-subingredient="닭고기"]').click();
    assert.deepEqual((await pickerNames()).sort(),['닭갈비','작업장특식볶음'].sort(),'optional species narrows the shared meat group');
    await page.locator('#pk-subingredients [data-subingredient="전체"]').click();
    await page.locator('#pk-subingredients summary').click();
    assert.equal(await page.locator('#pk-subingredients').evaluate(element=>element.open),false,'species can be collapsed again');
    await page.locator('#pk-methods [data-method="구이"]').click();
    assert.deepEqual(await pickerNames(),['훈제오리구이']);
    await page.locator('#pkq').fill('오리');await page.waitForTimeout(180);
    assert.equal(await page.locator('#pkq').inputValue(),'오리');assert.equal(await page.locator('#pkq').evaluate(element=>element===document.activeElement),true,'search retains focus while filtering');
    await page.locator('#pkq').fill('콩나물');await page.waitForTimeout(180);
    assert.deepEqual(await pickerNames(),[],'search must never escape the ingredient-specific slot');
    await page.evaluate(()=>closePicker());
    for(const [ci,names] of [[7,['고등어구이','오징어볶음','생선까스']],[8,['계란말이','두부부침']],[3,['콩나물무침','시금치나물','배추김치','작업장채소무침','고기조금넣은채소무침','감자튀김']],[1,['들깨된장국','대구지리']]]){
      await page.evaluate(ci=>openPicker(12,'중식',ci),ci);assert.deepEqual((await pickerNames()).sort(),names.sort(),`slot ${ci} contains only its actual food group`);await page.evaluate(()=>closePicker());
    }
    assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)})),original,'rendering, ingredient/method filters and search never change stored menus or other state');
    await page.evaluate(()=>go('recipe'));
    assert(await page.evaluate(()=>!!(document.getElementById('recipe-ingredients').compareDocumentPosition(document.getElementById('recipe-methods'))&Node.DOCUMENT_POSITION_FOLLOWING)),'recipe discovery uses the same ingredient-first hierarchy');
    await page.locator('#recipe-ingredients [data-ingredient="고기"]').focus();
    await page.locator('#recipe-ingredients [data-ingredient="고기"]').press('Enter');
    assert.equal(await page.locator('#recipe-subingredients').evaluate(element=>element.open),false);
    assert.equal(await page.locator('#recipe-subingredients [data-subingredient="양배추"]').count(),0,'recipe meat subtypes use the same ingredient-group boundary');
    await page.locator('#recipe-methods [data-method="구이"]').click();
    assert.deepEqual(await page.locator('#rlist .rchip').allTextContents(),['훈제오리구이']);
    await page.getByRole('button',{name:'전체 초기화',exact:true}).click();
    await page.evaluate(()=>rPick('닭갈비'));
    assert.match(await page.locator('#rdetail').innerText(),/AI|🤖/,'recipe provenance remains independently visible');
    await page.locator('[data-draft-picker="8"]').focus();
    await page.locator('[data-draft-picker="8"]').press('Enter');
    assert.deepEqual((await pickerNames()).sort(),['계란말이','두부부침'].sort(),'draft reuses the filtered ingredient-first picker');
    await page.locator('#pklist>button').filter({hasText:'계란말이'}).click();
    assert.equal(await page.evaluate(()=>recipeDraft.slots[8]),'계란말이');
    assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(S),stored:localStorage.getItem(KEY)})),original,'draft-only selection is not persisted');
    await page.evaluate(()=>{recipeDraft.slots={1:'들깨된장국',2:'제육볶음',7:'고등어구이',3:'콩나물무침',4:'배추김치'};recipeDraft.extras=[];recipeDraft.date='2026-10-12';recipeDraft.meal='중식';refreshRecipeDraft();});
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'the third main is required');
    assert.equal(await page.evaluate(()=>recipeDraftApply()),false);
    await page.evaluate(()=>recipeDraftSet(8,'배추김치'));
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'a vegetable is not a third main');
    await page.evaluate(()=>recipeDraftSet(8,'두부부침'));
    assert.equal(await page.locator('#recipe-draft-apply').isEnabled(),true,'tofu provides a valid non-meat/fish/vegetable third main');
    await page.evaluate(()=>recipeDraftSet(2,'고등어구이'));
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'fish cannot pass meat-slot validation even via direct draft API');
    await page.evaluate(()=>{recipeDraftSet(2,'제육볶음');recipeDraftSet(4,'계란말이');});
    assert.equal(await page.locator('#recipe-draft-apply').isDisabled(),true,'eggs cannot pass vegetable-side validation');
    await page.evaluate(()=>recipeDraftSet(4,'배추김치'));
    const beforeApply=await page.evaluate(()=>structuredClone(S));
    let canceled='';page.once('dialog',async dialog=>{canceled=dialog.message();await dialog.dismiss();});
    await page.locator('#recipe-draft-apply').click();assert.match(canceled,/2026-10-12 중식/);
    assert.deepEqual(await page.evaluate(()=>structuredClone(S)),beforeApply,'canceling explicit replacement leaves all data unchanged');
    page.once('dialog',dialog=>dialog.accept());await page.locator('#recipe-draft-apply').click();
    const applied=await page.evaluate(()=>structuredClone(S));
    const expectedMenus=structuredClone(beforeApply.menus);
    expectedMenus['2026-10']={'12|중식|1':'들깨된장국','12|중식|2':'제육볶음','12|중식|7':'고등어구이','12|중식|8':'두부부침','12|중식|3':'콩나물무침','12|중식|4':'배추김치','12|중식|n':'333','12|중식|notes':'작업 메모','12|석식|2':'보호할다른끼니','13|중식|2':'보호할다음날'};
    assert.deepEqual(applied.menus,expectedMenus,'explicit draft application updates exactly one meal and preserves every headcount/other meal');
    const nonMenu=state=>Object.fromEntries(Object.entries(state).filter(([key])=>!['menus','menuPlanMeta','menuManualEdits','updatedAt'].includes(key)));
    assert.deepEqual(nonMenu(applied),nonMenu(beforeApply),'staff, recipes, recipe provenance, settings and headcount provenance are untouched');
    assert.deepEqual(Object.keys(applied.menuManualEdits['2026-10']).sort(),['1','2','3','4','7','8','10'].map(ci=>`12|중식|${ci}`).sort(),'manual-edit stamps cover only the explicitly replaced meal food cells');
    for(const edit of Object.values(applied.menuManualEdits['2026-10']))assert(Number.isFinite(Date.parse(edit.at)));
    assert.equal(applied.menuPlanMeta['2026-10-12|중식'],undefined,'manual application cannot retain an AI menu marker');
    await page.evaluate(()=>{go('menu');openPicker(12,'중식',2);});
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`no full-page overflow at ${width}px`);
      assert(await page.locator('#pickerbox').evaluate(element=>element.scrollWidth<=element.clientWidth),`picker has no horizontal scroll at ${width}px`);
      const bounds=await page.locator('#pickerbox').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1);
    }
    await page.evaluate(()=>closePicker());
    const retirement=await page.evaluate(()=>{
      const state=structuredClone(S),cutoff='2026-10-08T10:00:00.000Z';
      state.menuAutomation={enabled:false,disabledAt:cutoff,policy:'manual-menu-v1',removedCells:{'2026-10':{'14|중식|2':'삭제된AI주찬','15|중식|2':'같은값새수동선택','16|중식|2':'원래AI값'}},removedMealKeys:['2026-10-14|중식','2026-10-15|중식','2026-10-16|중식']};
      state.menus={'2026-10':{'13|중식|0':'쌀밥','13|중식|1':'복원된AI국','13|중식|2':'복원된AI고기','13|중식|n':'222','14|중식|2':'삭제된AI주찬','14|중식|n':'333','15|중식|2':'같은값새수동선택','16|중식|2':'다른수동값','17|중식|2':'온전한수동값'}};
      state.menuPlanMeta={'2026-10-13|중식':{by:'ai',runId:'stale-import'}};
      state.menuManualEdits={'2026-10':{'14|중식|2':{at:'2026-10-08T09:00:00.000Z'},'15|중식|2':{at:'2026-10-08T11:00:00.000Z'}}};
      return normalize(state);
    });
    assert.equal(retirement.menus['2026-10']['13|중식|1'],undefined,'import normalization removes AI soup');
    assert.equal(retirement.menus['2026-10']['13|중식|2'],undefined,'import normalization removes AI main');
    assert.equal(retirement.menus['2026-10']['13|중식|0'],'쌀밥');assert.equal(retirement.menus['2026-10']['13|중식|n'],'222');
    assert.equal(retirement.menus['2026-10']['14|중식|2'],undefined,'a tombstoned exact old AI value cannot return from a stale snapshot');
    assert.equal(retirement.menus['2026-10']['14|중식|n'],'333');
    assert.equal(retirement.menus['2026-10']['15|중식|2'],'같은값새수동선택','a later deliberate manual choice of the same food survives cleanup');
    assert.equal(retirement.menus['2026-10']['16|중식|2'],'다른수동값','a manual value different from its tombstone survives');
    assert.equal(retirement.menus['2026-10']['17|중식|2'],'온전한수동값');assert.deepEqual(retirement.menuPlanMeta,{});
    const newManualStamp=await page.evaluate(()=>{
      S.menuAutomation={enabled:false,disabledAt:'2020-01-01T00:00:00.000Z',policy:'manual-menu-v1',removedCells:{'2026-10':{'18|중식|2':'같은옛메뉴'}},removedMealKeys:['2026-10-18|중식']};
      menuSet(18,'중식',2,'같은옛메뉴');clearTimeout(saveTimer);clearTimeout(cloudTimer);
      return {stamp:S.menuManualEdits?.['2026-10']?.['18|중식|2'],menu:normalize(structuredClone(S)).menus['2026-10']['18|중식|2']};
    });
    assert(newManualStamp.stamp?.at>'2020-01-01T00:00:00.000Z','a real manual pick records a timestamp after retirement');
    assert.equal(newManualStamp.menu,'같은옛메뉴','an explicit new choice cannot be erased merely because the name was formerly AI generated');
    await page.evaluate(()=>{
      S.month='2026-10';S.menus={'2026-09':{'22|중식|2':'지난달수동동명메뉴','22|중식|n':'222'},'2026-10':{}};S.menuPlanMeta={};S.menuManualEdits={};
      S.menuAutomation={enabled:false,disabledAt:'2020-01-01T00:00:00.000Z',policy:'manual-menu-v1',removedCells:{'2026-10':{'22|중식|2':'지난달수동동명메뉴'}},removedMealKeys:['2026-10-22|중식']};
    });
    page.once('dialog',dialog=>dialog.accept());await page.evaluate(()=>{copyMonth();clearTimeout(saveTimer);clearTimeout(cloudTimer);});
    const copied=await page.evaluate(()=>({stamp:S.menuManualEdits?.['2026-10']?.['22|중식|2'],menus:normalize(structuredClone(S)).menus}));
    assert(copied.stamp?.at>'2020-01-01T00:00:00.000Z','explicit previous-month copy records the copied food as a new manual selection');
    assert.equal(copied.menus['2026-10']['22|중식|2'],'지난달수동동명메뉴','a confirmed manual month copy survives its earlier AI tombstone');
    assert.equal(copied.menus['2026-10']['22|중식|n'],'222','copying a month retains its established headcount behavior');
    const imported=await page.evaluate(()=>{
      const old=structuredClone(S);delete old.menuAutomation;delete old.menuManualEdits;
      old.menus['2026-10']['23|중식|2']='오래된AI주찬';old.menus['2026-10']['23|중식|0']='쌀밥';old.menus['2026-10']['23|중식|n']='233';
      old.menuPlanMeta={'2026-10-23|중식':{by:'ai',runId:'old-backup'}};
      const beforeRecipes=JSON.stringify({recipes:S.recipes,methods:S.methods,recipeMeta:S.recipeMeta});
      applyState(old);clearTimeout(saveTimer);clearTimeout(cloudTimer);
      return {menus:structuredClone(S.menus),policy:structuredClone(S.menuAutomation),meta:structuredClone(S.menuPlanMeta),recipesUnchanged:JSON.stringify({recipes:S.recipes,methods:S.methods,recipeMeta:S.recipeMeta})===beforeRecipes};
    });
    assert.equal(imported.policy.enabled,false,'restoring an old snapshot cannot erase the known retirement policy');
    assert.equal(imported.policy.policy,'manual-menu-v1');
    assert.equal(imported.menus['2026-10']['22|중식|2'],'지난달수동동명메뉴','latest local manual protection survives old-snapshot import');
    assert.equal(imported.menus['2026-10']['23|중식|2'],undefined,'real applyState import rejects old AI food');
    assert.equal(imported.menus['2026-10']['23|중식|0'],'쌀밥');assert.equal(imported.menus['2026-10']['23|중식|n'],'233');
    assert.deepEqual(imported.meta,{});assert.equal(imported.recipesUnchanged,true,'snapshot policy enforcement does not remove recipe AI');
    const cafe=await browser.newPage({viewport:{width:390,height:844}});
    await cafe.addInitScript(()=>localStorage.setItem('nmf_app','cafe'));await cafe.route('**/*',routeAll);await cafe.goto('https://namofood.test/');
    await cafe.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('recipe');});
    assert.equal(await cafe.locator('#recipe-ingredients').count(),0);assert.equal(await cafe.locator('#recipe-draft').count(),0);
    assert.match(await cafe.locator('#main h1').innerText(),/레시피 \(1잔 · 1개 분량표\)/);await cafe.close();
    assert.equal(writeRequests,0,'the fixture does not perform network writes');assert.deepEqual(errors,[]);
    console.log('MANUAL_MENU_PICKER: THREE_MAINS_TWO_VEGETABLES / WEIGHTED_PRIMARY / MEAT_UMBRELLA / COLLAPSED_SPECIES / INGREDIENT_BEFORE_METHOD / SLOT_SEARCH_BOUNDARIES / LEGACY_PRESERVED / FILTERS_NO_WRITES / DRAFT_TYPE_VALIDATION / CANCEL / TARGET_MEAL_ONLY / HEADCOUNTS_AND_NONMENU_PRESERVED / RECIPE_AI_RETAINED / 320_390_1280 / RETIRED_AI_IMPORT / EXACT_TOMBSTONE / LATER_SAME_MANUAL_CHOICE / EXPLICIT_MONTH_COPY / APPLY_STATE_IMPORT_POLICY / CAFE_PASS');
    console.log('APP_SOURCE_SHA256 '+createHash('sha256').update(source).digest('hex'));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
