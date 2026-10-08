// Synthetic browser coverage: menu choices never write production data.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright');

(async()=>{
  const source=fs.readFileSync(process.env.NMF_APP_SOURCE||path.join(__dirname,'..','나모푸드_관리앱.html'),'utf8');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];let writes=0;
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
      if(!['GET','HEAD','OPTIONS'].includes(route.request().method()))writes++;
      if(route.request().url().includes('/rest/v1/namofood_state'))return route.fulfill({json:[]});
      return route.abort();
    });
    await page.goto('https://namofood.test/');
    await page.evaluate(()=>{
      clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;
      S.month='2026-10';S.recipes=[];S.methods={};S.recipeMeta={};S.recipeAsk={};
      const add=(menu,item,comp='주찬')=>{S.recipes.push({menu,item,comp,qty:100,unit:'g'});S.methods[menu]='대량으로 조리한다.';};
      add('제육볶음','돼지고기');add('닭구이','닭고기');add('고등어구이','고등어');add('계란말이','달걀');
      add('콩나물무침','콩나물','부찬');add('된장국','두부','국');
      add('쌀밥','쌀','밥');add('카레라이스','쌀','밥');add('짜장밥','쌀','밥');add('보리밥','보리','밥');
      S.recipes.push({menu:'짜장밥',item:'춘장',comp:'밥',qty:20,unit:'g'});
      add('잔치국수','소면','밥');add('푸딩','우유','후식');add('맥주','맥주','후식');
      add('돈코츠풍라멘','중화면','밥');add('불고기버거','햄버거빵','밥');add('샌드위치','식빵','밥');
      add('채소무침 <img src=x onerror="window.nmfInjected=1">','양배추','부찬');
      S.menus={'2026-10':{'12|중식|1':'된장국','12|중식|2':'제육볶음','12|중식|7':'고등어구이','12|중식|8':'계란말이','12|중식|3':'콩나물무침','12|중식|4':'수동부찬','12|중식|n':'333','12|중식|notes':'메모 유지','12|석식|2':'보호할석식','13|중식|2':'보호할다음날'}};
      S.menuPlanMeta={'12-preserved':{by:'manual'},'2026-10-12|중식':{by:'manual'}};
      S.headcountMeta={'2026-10-12|중식':{by:'photo-plan',source:'keep'}};S.menuManualEdits={};
      S.view={range:'day',mode:'public',ing:false};selDay=12;cloudMenuBase=captureCloudMenuBase(S);go('menu');
      clearTimeout(saveTimer);localStorage.setItem(KEY,JSON.stringify(S));
    });
    const names=()=>page.locator('#pklist>button').evaluateAll(buttons=>buttons.map(button=>button.firstChild.textContent.trim()));
    const initial=await page.evaluate(()=>structuredClone(S));
    if(process.env.NMF_PICKER_PROBE==='rice'){
      assert.equal(await page.locator('[data-menu-rice="중식"]').count(),1,'existing rice chip must become a rice-changing button');
      console.log('RICE_BUTTON_PROBE_PASS');return;
    }
    await page.evaluate(()=>openPicker(12,'중식',2));
    assert.equal(await page.getByRole('button',{name:'전체 메뉴에서 선택',exact:true}).count(),1,'every category picker has a whole-catalog escape button');
    const allButton=page.getByRole('button',{name:'전체 메뉴에서 선택',exact:true});
    const directBox=await page.getByRole('button',{name:'✎ 직접 입력',exact:true}).boundingBox(),allBox=await allButton.boundingBox();
    assert(allBox.y>=directBox.y+directBox.height-1,'whole-catalog button is below direct entry and clear actions');
    await page.locator('#pkq').fill('없는 검색');await page.waitForTimeout(160);
    await allButton.focus();await allButton.press('Enter');
    const catalog=await page.evaluate(()=>Object.keys(recipeMap()).filter(name=>!recipeDraftProhibitedReason(name)).sort((a,b)=>a.localeCompare(b,'ko')));
    assert.deepEqual(await names(),catalog,'whole-catalog mode removes slot, search, ingredient and method limits, including rice and dessert');
    assert.equal(await page.evaluate(()=>pk.ci),2,'browsing whole catalog keeps the intended destination slot');
    assert.equal(await page.evaluate(()=>window.nmfInjected||0),0,'catalog labels are escaped');
    assert.equal(await page.locator('#pk-recommendations').evaluate(element=>element.open),false,'recommendations remain collapsed');
    await page.locator('#pk-ingredients [data-ingredient="생선·해산물"]').click();
    assert.deepEqual(await names(),['고등어구이'],'ingredient filters remain useful in the complete catalog');
    await page.getByRole('button',{name:'필터 초기화',exact:true}).click();assert.deepEqual(await names(),catalog,'filter reset stays in full-catalog mode');
    await page.getByRole('button',{name:'이 자리 메뉴만 보기',exact:true}).click();
    assert.deepEqual(await names(),['닭구이','제육볶음'],'returning restores the original category');
    for(const ci of [1,7,8,3,4]){
      await page.evaluate(ci=>openPicker(12,'중식',ci),ci);
      await page.getByRole('button',{name:'전체 메뉴에서 선택',exact:true}).click();assert.deepEqual(await names(),catalog,`slot ${ci} can view the same full catalog`);
    }
    await page.evaluate(()=>closePicker());
    assert.deepEqual(await page.evaluate(()=>structuredClone(S)),initial,'browsing and switching modes do not write stored state');
    await page.evaluate(()=>openPicker(12,'중식',2));
    assert.deepEqual(await names(),['닭구이','제육볶음'],'a fresh picker starts in its own category');
    await page.getByRole('button',{name:'전체 메뉴에서 선택',exact:true}).click();
    await page.locator('#pklist>button').filter({hasText:'고등어구이'}).click();
    const selected=await page.evaluate(()=>structuredClone(S)),expected=structuredClone(initial.menus);
    const untouched=state=>Object.fromEntries(Object.entries(state).filter(([key])=>!['menus','menuPlanMeta','menuManualEdits','updatedAt'].includes(key)));
    expected['2026-10']['12|중식|2']='고등어구이';assert.deepEqual(selected.menus,expected,'a cross-category manual selection changes only the chosen food cell');
    assert.deepEqual(untouched(selected),untouched(initial),'staff, recipes, settings, headcounts and all other state remain unchanged');
    assert.deepEqual(selected.headcountMeta,initial.headcountMeta);assert.deepEqual(selected.settings,initial.settings);
    assert.deepEqual(selected.menuPlanMeta,{'12-preserved':{by:'manual'}},'normal manual selection retires only the target meal marker');
    assert.deepEqual(Object.keys(selected.menuManualEdits['2026-10']),['12|중식|2']);
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem(KEY)).menus['2026-10']['12|중식|2']==='고등어구이');
    await page.evaluate(()=>{clearTimeout(saveTimer);clearTimeout(cloudTimer);S=normalize(JSON.parse(localStorage.getItem(KEY)));cloudApplying=true;go('menu');});
    assert.equal(await page.evaluate(()=>menuGet(12,'중식',2)),'고등어구이','whole-catalog selection persists through normalized reload');
    assert.equal(await page.locator('[data-menu-rice="중식"]').count(),1,'rice display itself is the selection button, not an extra choose slot');
    assert.equal(await page.locator('[data-menu-rice="중식"]').innerText(),'밥(기본) · 쌀밥');
    assert.equal(await page.locator('.mealbox').filter({has:page.locator('.mealbar',{hasText:'중식'})}).locator('.comps').first().locator('.pick').count(),6,'rice remains outside the six dish slots');
    const beforeRice=await page.evaluate(()=>structuredClone(S));
    await page.locator('[data-menu-rice="중식"]').focus();await page.locator('[data-menu-rice="중식"]').press('Enter');
    assert.equal(await page.evaluate(()=>pk.ci),0);assert.equal(await page.evaluate(()=>pickerCurrent()),'쌀밥');
    assert.deepEqual(await names(),['보리밥','쌀밥','짜장밥','카레라이스'],'rice choices include curry and jajang rice but not noodles or other dishes');
    assert.equal(await page.locator('#pk-recommendations').count(),0,'six-slot recommendation banks do not gain a rice slot');
    await page.locator('#pklist>button').filter({hasText:'짜장밥'}).click();
    const riceState=await page.evaluate(()=>structuredClone(S)),expectedRice=structuredClone(beforeRice.menus);
    expectedRice['2026-10']['12|중식|0']='짜장밥';assert.deepEqual(riceState.menus,expectedRice,'rice selection saves exactly legacy stable slot zero');
    assert.deepEqual(untouched(riceState),untouched(beforeRice),'rice selection cannot change unrelated application state');
    assert.deepEqual(riceState.headcountMeta,beforeRice.headcountMeta);assert.deepEqual(riceState.settings,beforeRice.settings);
    assert.deepEqual(riceState.menuPlanMeta,beforeRice.menuPlanMeta);assert(riceState.menuManualEdits['2026-10']['12|중식|0']?.at,'rice change receives a manual-edit timestamp');
    assert.equal(await page.locator('[data-menu-rice="중식"]').innerText(),'밥 · 짜장밥');
    for(const range of ['day','week','month']){
      await page.evaluate(range=>{S.view.range=range;render();},range);
      assert.match(await page.locator('#menu-print-sheet').innerText(),/짜장밥/,`${range} print preview uses the chosen rice`);
    }
    await page.evaluate(()=>{S.view.range='day';render();});
    const printed=await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
    const pdfjs=await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
    const pdf=await pdfjs.getDocument({data:new Uint8Array(printed),disableFontFace:true}).promise;
    const pdfText=(await (await pdf.getPage(1)).getTextContent()).items.map(item=>item.str).join(' ');await pdf.destroy();
    assert.match(pdfText,/짜장밥/,'actual generated PDF includes selected rice');
    const quantities=await page.evaluate(()=>requirements(new Set([12])).items);
    assert.equal(quantities.find(item=>item.item==='춘장')?.total,6.66,'orders consume the selected rice recipe rather than the default rice');
    const csvRows=await page.evaluate(()=>{let rows;const old=csv;csv=(filename,value)=>{rows=value;};csvMenu();csv=old;return rows;});
    assert.equal(csvRows.find(row=>row[0]==='2026-10-12'&&row[1]==='중식')[3],'짜장밥','menu CSV exports selected rice');
    await page.locator('[data-menu-rice="중식"]').click();
    await page.getByRole('button',{name:'비우기',exact:true}).click();
    assert.equal(await page.evaluate(()=>menuGet(12,'중식',0)),'');assert.equal(await page.locator('[data-menu-rice="중식"]').innerText(),'밥(기본) · 쌀밥','clearing rice restores the implicit default');
    assert.equal(await page.evaluate(()=>mealItems(ym(),12,'중식')[0]),'쌀밥');
    await page.locator('[data-menu-rice="중식"]').click();
    page.once('dialog',dialog=>dialog.accept('카레밥 직접입력'));
    await page.getByRole('button',{name:'✎ 직접 입력',exact:true}).click();
    assert.equal(await page.evaluate(()=>menuGet(12,'중식',0)),'카레밥 직접입력');
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem(KEY)).menus['2026-10']['12|중식|0']==='카레밥 직접입력');
    await page.evaluate(()=>{clearTimeout(saveTimer);clearTimeout(cloudTimer);S=normalize(JSON.parse(localStorage.getItem(KEY)));cloudApplying=true;go('menu');});
    assert.equal(await page.locator('[data-menu-rice="중식"]').innerText(),'밥 · 카레밥 직접입력','custom rice remains editable and survives reload');
    const mergeProof=await page.evaluate(()=>{
      const stale=structuredClone(S);cloudMenuBase=captureCloudMenuBase(stale);
      menuSet(12,'중식',0,'보리밥');clearTimeout(saveTimer);clearTimeout(cloudTimer);mergeRemoteMenus(stale);
      return {rice:menuGet(12,'중식',0),headcount:menuGet(12,'중식','n')};
    });
    assert.deepEqual(mergeProof,{rice:'보리밥',headcount:'333'},'stale cloud data cannot revert a locally changed rice cell');
    await page.evaluate(()=>{selDay=13;copyDay(-1);clearTimeout(saveTimer);clearTimeout(cloudTimer);});
    assert.equal(await page.evaluate(()=>menuGet(13,'중식',0)),'보리밥','previous-day copy includes custom rice');
    assert.equal(await page.evaluate(()=>mealItems(ym(),13,'중식')[0]),'보리밥');
    await page.evaluate(()=>{S.menus['2026-10']['14|중식|0']='짜장밥';});
    assert.deepEqual(await page.evaluate(()=>mealItems(ym(),14,'중식')),['짜장밥'],'a deliberate rice-only choice is not hidden');
    const normalizedRice=await page.evaluate(()=>{
      const snapshot=structuredClone(S);snapshot.menuPlanMeta['2026-10-14|중식']={by:'ai'};snapshot.menus['2026-10']['14|중식|2']='옛AI고기';
      const normalized=normalize(snapshot);return {rice:normalized.menus['2026-10']['14|중식|0'],main:normalized.menus['2026-10']['14|중식|2'],aiMarker:normalized.menuPlanMeta['2026-10-14|중식']};
    });
    assert.deepEqual(normalizedRice,{rice:'짜장밥',main:undefined,aiMarker:undefined},'retired AI cleanup and normalization preserve stable rice slot zero');
    const beforeMonthCopy=await page.evaluate(()=>{S.month='2026-11';S.menus['2026-11']={'1|중식|0':'기존 밥'};return structuredClone(S);});
    page.once('dialog',dialog=>dialog.accept());await page.evaluate(()=>copyMonth());
    const monthCopy=await page.evaluate(()=>structuredClone(S));
    assert.deepEqual(monthCopy.menus['2026-11'],beforeMonthCopy.menus['2026-10'],'previous-month copy preserves every rice, dish, headcount and note exactly');
    assert.deepEqual(monthCopy.menus['2026-10'],beforeMonthCopy.menus['2026-10'],'copying to another month does not modify the source meals');
    assert.deepEqual(monthCopy.headcountMeta,beforeMonthCopy.headcountMeta);assert.deepEqual(monthCopy.settings,beforeMonthCopy.settings);
    for(const day of [12,13,14])assert(monthCopy.menuManualEdits['2026-11'][`${day}|중식|0`]?.at,'copied rice receives a manual-edit timestamp');
    await page.evaluate(()=>{S.month='2026-10';});
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:900});await page.evaluate(()=>{selDay=12;go('menu');openPicker(12,'중식',0);});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`no page overflow at ${width}px`);
      assert(await page.locator('#pickerbox').evaluate(element=>element.scrollWidth<=element.clientWidth),`no picker overflow at ${width}px`);
    }
    assert.equal(writes,0);assert.deepEqual(errors,[]);
    console.log('MENU_ALL_RICE_PICKER: FULL_CATALOG_ESCAPE / CATEGORY_RETURN / NO_ALCOHOL / XSS_ESCAPED / NO_BROWSING_WRITES / CROSS_CATEGORY_TARGET_ONLY / RELOAD / RICE_SLOT_ZERO / CURRY_JAJANG / DEFAULT_FALLBACK / SIX_RECOMMEND_SLOTS_UNCHANGED / DAY_WEEK_MONTH_PRINT / ACTUAL_PDF / ORDER_CSV / DIRECT_INPUT / STALE_CLOUD / COPY_DAY_MONTH_EXACT_RICE_STAMPS / RICE_ONLY / 320_390_1280_PASS');
    console.log('APP_SOURCE_SHA256 '+createHash('sha256').update(source).digest('hex'));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
