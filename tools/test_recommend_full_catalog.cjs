const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const p=await b.newPage();await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());await p.goto('https://full-catalog.test');
 const result=await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';S.recipes=[];S.methods={};S.recipeAsk={};S.menus={};S.menuRotationReference={version:'2026-10-24-two-week-methods-v1',names:['제육볶음']};
 const add=(menu,item,method)=>{S.recipes.push({menu,item,qty:100,unit:'g',comp:'주찬',method});S.methods[menu]=method};
 add('수육','돼지고기','삶음');add('생선구이','흰살생선','구이');add('생선튀김','흰살생선','튀김');add('생선조림','흰살생선','조림');add('돈가스','돼지고기','튀김');add('나물무침','시금치','무침');
 const before=JSON.stringify(S),revision=menuRecommendRevision('2026-10-26');S.menuRotationReference.names=['다른 기준 메뉴'];const revisionSame=revision===menuRecommendRevision('2026-10-26');S.menuRotationReference.names=['제육볶음'];
 const data={source:'ai',date:'2026-10-26',slots:{2:[{name:'수육'}],7:[{name:'생선구이'},{name:'생선튀김'},{name:'생선조림'}]}};
 const all=menuRecommendCandidates(data,data.date,'석식');const untouched=JSON.stringify(S)===before;
 S.menus={'2026-10':{'26|중식|2':'고기구이','26|중식|7':'생선조림','26|석식|2':'돈가스'}};
 return {meat:all[2].map(x=>x.name),fish:all[7].map(x=>x.name),revisionSame,untouched,methods:{crossGroupAllowed:menuRecommendMethodAllowed('생선구이',data.date,'석식',7),sameGroupBlocked:menuRecommendMethodAllowed('생선조림',data.date,'석식',7),sameMealBlocked:menuRecommendMethodAllowed('생선튀김',data.date,'석식',7),sideAllowed:menuRecommendMethodAllowed('나물무침',data.date,'석식',3)}};
 });
 assert.deepEqual(result.meat,['수육']);assert.deepEqual(result.fish,['생선구이','생선튀김','생선조림']);assert(result.revisionSame);assert(result.untouched);assert.deepEqual(result.methods,{crossGroupAllowed:true,sameGroupBlocked:false,sameMealBlocked:false,sideAllowed:true});
 console.log('UI_FULL_RECIPE_CATALOG_OUTSIDE_REFERENCE_METHOD_GUARDS_NO_STATE_WRITES_OK');
}finally{await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
