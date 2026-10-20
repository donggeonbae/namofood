// Fully isolated Cafe/Store fixtures; all external requests are blocked.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{for(const app of ['cafe','store']){
    const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.addInitScript(app=>{localStorage.setItem('nmf_app',app);localStorage.setItem('nmf_supa_'+app,'{"url":"","key":""}');sessionStorage.setItem('nmf_session_pw','isolated');},app);
    await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
    await p.goto('https://other-profit.test');
    for(const populated of [false,true]){
      const original=await p.evaluate(({app,populated})=>{
        clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;taxAiLoad=async()=>{};
        S=normalize(defaultState());S.month='2026-10';S.staff=[];S.staffArchive=[];S.roster={};S.settings.fixed=[];S.fixedMonthly={'2026-10':[]};S.supplies=[];
        S.sales={'2026-10':populated?(app==='cafe'?{'1|rev':1234567,'1|other':100,'2|rev':0}:{'1|storeTickets':5,'1|storeCash':5000,'1|storeCard':5000,'2|storeTickets':0}):{}};
        go('pl');return JSON.stringify(S);
      },{app,populated});
      assert(await p.locator('#profit-revenue-chart').isVisible());
      assert.equal(await p.locator('#profit-cost-benchmark').count(),0);
      const values=await p.evaluate(()=>profitRevenueSeries()[0].points.slice(0,2).map(x=>x.value));
      assert.deepEqual(values,populated?(app==='cafe'?[1234667,0]:[60000,0]):[null,null]);
      for(const width of [1440,390,320]){
        await p.setViewportSize({width,height:1100});
        // Include the old expected-profit panel, even when actual sales exist.
        await p.evaluate(()=>main.querySelectorAll('details.card').forEach(el=>el.open=true));
        assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1),`${app} ${populated?'entered':'empty'} ${width} fits`);
        if(app==='cafe'&&width===390)await p.screenshot({path:'/tmp/nmf-cafe-profit-'+(populated?'entered':'empty')+'.png',fullPage:true});
      }
      assert.equal(await p.evaluate(()=>JSON.stringify(S)),original);
    }
    assert.deepEqual(errors,[]);await p.close();
  }
  console.log('CAFE_STORE_PROFIT_CHARTS_EMPTY_ZERO_ENTERED_READONLY_OPEN_LEGACY_TABLES_PC_390_320_NO_OVERFLOW_OK');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
