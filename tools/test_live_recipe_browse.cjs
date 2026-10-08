// Live observation: never submit drafts, generate AI recipes, or save meal state.
// NMF_VERIFY_RECOMMEND=1 permits the requested server bank preparation/retrieval only.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async()=>{
  const password=process.env.NMF_PW;
  const version=process.env.NMF_EXPECTED_VER||'1009-7-menu-staff';
  const verifyRecommend=process.env.NMF_VERIFY_RECOMMEND==='1';
  const minimum=Number(process.env.NMF_EXPECTED_RECIPE_MIN||827);
  if(!password)throw Error('NMF_PW required');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[],recommendRequestDates=[],recommendResponseTasks=[];let blockedWrites=0,blockedRecommendationRequests=0,documents=0,recommendRequests=0,recommendPendingResponses=0;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',response=>{
      if(!verifyRecommend||!response.url().endsWith('/functions/v1/nmf-menu-recommend'))return;
      recommendResponseTasks.push((async()=>{try{const body=response.request().postDataJSON(),data=await response.json();if(response.status()===202){assert.equal(data.reason,'bank_pending');recommendPendingResponses++;}console.log(JSON.stringify({phase:'weekly-ai-response',date:body.date,status:response.status(),ok:data?.ok===true,model:data?.model||null,cached:data?.cached||false,serverStored:data?.serverStored||false}));}catch(error){errors.push(error.message);}})());
    });
    await page.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),password);
    await page.route('**/*',route=>{
      const req=route.request();
      if(req.isNavigationRequest())documents++;
      if(['GET','HEAD','OPTIONS'].includes(req.method()))return route.continue();
      let action;try{action=req.postDataJSON()?.action;}catch{}
      if(req.method()==='POST'&&req.url().endsWith('/functions/v1/nmf-recipe-fill')&&action==='status')return route.continue();
      if(req.method()==='POST'&&req.url().endsWith('/functions/v1/nmf-menu-recommend')){
        if(!verifyRecommend){blockedRecommendationRequests++;return route.abort();}
        const body=req.postDataJSON(),headers=req.headers();
        assert.deepEqual(Object.keys(body).sort(),['date','nonce']);
        assert.match(body.date,/^\d{4}-\d{2}-\d{2}$/);assert.match(body.nonce,/^[A-Za-z0-9_-]{1,64}$/);
        assert.match(headers['x-nmf-time'],/^\d{13}$/);assert.match(headers['x-nmf-signature'],/^[a-f0-9]{64}$/);
        recommendRequests++;recommendRequestDates.push(body.date);return route.continue();
      }
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
    await page.evaluate(()=>openPicker(selDay,'중식',2));
    await page.getByRole('button',{name:'전체 메뉴에서 선택',exact:true}).click();
    const fullCatalog=await page.evaluate(()=>({shown:pickerFilter().list.map(entry=>entry.m).sort((a,b)=>a.localeCompare(b,'ko')),expected:Object.keys(recipeMap()).filter(name=>!recipeDraftProhibitedReason(name)).sort((a,b)=>a.localeCompare(b,'ko')),slot:pk.ci}));
    assert.deepEqual(fullCatalog.shown,fullCatalog.expected,'production whole-catalog picker shows every allowed recipe regardless of slot');
    assert.equal(fullCatalog.slot,2);assert.equal(await page.locator('#pk-recommendations').evaluate(element=>element.open),false);
    await page.locator('#pickerbox').screenshot({path:'/tmp/nmf-live-all-menu-picker.png'});
    await page.evaluate(()=>closePicker());
    await page.locator('[data-menu-rice="중식"]').click();
    assert.equal(await page.evaluate(()=>pk.ci),0,'the default rice display opens stable rice slot zero');
    assert.equal(await page.locator('#pk-recommendations').count(),0,'rice changes do not add a seventh AI recommendation category');
    assert(await page.evaluate(()=>{const rmap=recipeMap();return pickerFilter().list.length>0&&pickerFilter().list.every(entry=>recipeRiceChoice(entry.m,rmap[entry.m]));}),'production rice choices include only rice dishes by default');
    const riceNames=await page.evaluate(()=>pickerFilter().list.map(entry=>entry.m));
    assert(riceNames.some(name=>/카레/.test(name))&&riceNames.some(name=>/짜장/.test(name)),'real curry and jajang options are present');
    assert(riceNames.every(name=>!/국수|우동|라면|라멘|버거|샌드위치|토스트|피자|핫도그/.test(name)),'misclassified noodle and bread meals cannot leak into default rice choices');
    await page.locator('#pickerbox').screenshot({path:'/tmp/nmf-live-rice-picker.png'});
    await page.evaluate(()=>closePicker());
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'whole-catalog and rice browsing never mutate production data');
    let recommendation=null;
    if(verifyRecommend){
      await page.evaluate(()=>go('menu'));
      const result=await page.evaluate(async()=>{
        const date=menuRecommend.date;await menuRecommendEnsureWeek(date);
        const days=menuRecommendWeekDates(date),banks=days.map(day=>{
          const data=menuRecommendCached(day);if(!data)throw Error(day+': '+(menuRecommendErrors.get(day)||'AI recommendation failed'));
          const slots=menuRecommendCandidates(data,day);
          return {date:day,source:data.source,model:data.model,serverStored:data.serverStored,storage:data.storage,generatedAt:data.generatedAt,counts:Object.fromEntries(SLOT_ORDER.map(ci=>[ci,(slots[ci]||[]).length])),reasonCount:Object.values(slots).flat().filter(x=>x.reason).length,excludedCount:data.excludedCount,aliases:Object.keys(data.aliases||{}).length};
        });return {date,days,banks};
      });
      assert.equal(result.days.length,7);
      for(const bank of result.banks){assert.equal(bank.source,'ai');assert(bank.model);assert.equal(bank.serverStored,true);assert.equal(bank.storage,'server');assert(bank.generatedAt);assert.deepEqual(bank.counts,{'1':3,'2':3,'7':3,'8':3,'3':3,'4':3},bank.date+' has three compatible recommendations per slot');assert.equal(bank.reasonCount,18);assert(bank.aliases>0);}
      assert.equal(await page.locator('#menu-recommend-load,#menu-recommend-date,#menu-recommend-refresh').count(),0,'no explicit recommendation-request panel remains');
      assert.match(await page.locator('#menu-recommend-week-status').innerText(),/7\/7/);
      assert.equal(await page.locator('#menu-recommend-week-status').evaluate(el=>el.open),false,'live main recommendations default collapsed');
      await page.locator('#menu-recommend-week-status > summary').click();
      assert.equal(await page.locator('#menu-recommend-week-content').isVisible(),true);
      const afterWeek=recommendRequests;
      await page.evaluate(async()=>{await menuRecommendEnsureWeek(menuRecommend.date);});assert.equal(recommendRequests,afterWeek,'prepared week is reused without model calls');
      await Promise.all(recommendResponseTasks);
      assert.equal(new Set(recommendRequestDates).size,7,'only the seven weekly date banks are requested');
      assert.equal(recommendRequests,7+recommendPendingResponses,'additional calls must be exactly the bounded active-lease polls');
      assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'real AI week preparation cannot change stored menus, headcounts or other state');
      for(const ci of [1,2,7,8,3,4]){
        await page.evaluate(ci=>{recipeDraft.date=menuRecommend.date;openDraftPicker(ci);},ci);
        assert.equal(await page.locator('#pk-recommendations > summary > span').first().evaluate(el=>el.firstChild.textContent),'뭐 할지 모르겠다면? 동건이의 추천!');
        assert.equal(await page.locator('#pk-recommendations').evaluate(el=>el.open),false,'fresh live picker defaults collapsed');
        await page.locator('#pk-recommendations > summary').click();
        assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').count(),3,'live draft slot '+ci+' exposes three compatible candidates');
        assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').first().isVisible(),true);
        await page.evaluate(()=>closePicker());
      }
      await page.evaluate(()=>openPicker(selDay,'중식',2));
      assert.equal(await page.locator('#pk-recommendations').evaluate(el=>el.open),false);
      await page.locator('#pk-recommendations > summary').click();
      assert.equal(await page.locator('#pk-recommendations button[data-recommend-name]').count(),3,'+choose immediately shows the prepared date/slot candidates');
      await page.locator('#pk-recommendations').screenshot({path:'/tmp/nmf-live-weekly-recommend-picker.png'});await page.evaluate(()=>closePicker());
      assert.equal(recommendRequests,afterWeek,'six draft pickers and the actual meal picker reuse the weekly bank');
      await page.emulateMedia({media:'print'});assert.equal(await page.locator('#menu-recommend-week-status').evaluate(el=>getComputedStyle(el).display),'none');await page.emulateMedia({media:'screen'});
      await page.locator('#menu-recommend-week-status').screenshot({path:'/tmp/nmf-live-weekly-recommend.png'});
      const reloaded=await page.evaluate(async()=>{const date=menuRecommend.date;menuRecommendCache.clear();await menuRecommendEnsureWeek(date);return menuRecommendWeekDates(date).map(day=>{const data=menuRecommendCached(day);return {date:day,generatedAt:data.generatedAt,slots:JSON.stringify(data.slots),cached:data.cached,serverStored:data.serverStored};});});
      assert.equal(recommendRequests,afterWeek+7,'cleared memory refetches exactly seven server banks');
      for(const bank of reloaded){assert.equal(bank.serverStored,true);assert.equal(bank.cached,true);assert.equal(bank.generatedAt,result.banks.find(b=>b.date===bank.date).generatedAt,'server bank generation time remains identical');}
      assert.equal(await page.evaluate(()=>JSON.stringify(S)),before);
      recommendation={...result,requests:recommendRequests,pendingPolls:recommendPendingResponses,stateUnchanged:true,printHidden:true,serverReuse:true};
    }
    await page.evaluate(()=>{go('recipe');recipeSetIngredient('고기');});
    await page.screenshot({path:'/tmp/nmf-live-recipe-browse.png',fullPage:true});
    await page.evaluate(async()=>{await refreshRecipeMonitor(true);});
    await page.waitForFunction(()=>!recipeMonitor.busy&&recipeMonitor.checked>0,null,{timeout:20000});
    const status=await page.evaluate(()=>({error:recipeMonitor.error,ready:!!recipeMonitor.data?.ok}));
    assert.equal(status.error,'');assert(status.ready);
    await page.waitForTimeout(9000);
    assert.equal(documents,1);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({version,...evidence,meatMethods,meatClassification,widths,status,recommendation,ingredientFirst:true,meatSpeciesCollapsed:true,thirdMainPicker:true,draftPreservedState:true,productionMealWrites:0,blockedWrites,blockedRecommendationRequests,documents}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1);});
