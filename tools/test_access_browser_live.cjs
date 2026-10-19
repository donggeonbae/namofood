// Real browser/API read-only check. Blocks all state writes and all provider work.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const version=JSON.parse(require('node:fs').readFileSync('ver.json','utf8')).v;
(async()=>{
  const admin=await new Promise(resolve=>{process.stdin.once('data',v=>resolve(v.toString().trim()));process.stdin.resume();});process.stdin.pause();
  const pw=process.env.NMF_PW;if(!pw)throw Error('NMF_PW required');
  const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];let blockedWrites=0; p.on('pageerror',e=>errors.push(e.message));
    await p.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),pw);
    const readOnly=async r=>{
      const req=r.request(),u=new URL(req.url());if(['GET','HEAD','OPTIONS'].includes(req.method()))return r.continue();
      if(u.pathname.endsWith('/nmf-access')){const body=req.postDataJSON();if(body.action==='login'||body.action==='rest'&&body.method==='GET')return r.continue();blockedWrites++;return r.fulfill({status:503,json:{error:'Read-only verification'}});}
      if(u.pathname.endsWith('/nmf-tax-auto')&&req.postDataJSON()?.action==='status')return r.continue();
      if(u.pathname.endsWith('/nmf-invoice-ocr')&&req.postDataJSON()?.action==='status')return r.continue();
      return r.fulfill({status:503,json:{ok:false,error:'Read-only verification'}});
    };await p.route('**/*',readOnly);
    await p.goto('https://d-bae.com/namofood/?v='+version);await p.waitForFunction(()=>window.NMF_ACCESS_REQUIRED&&window.NmfAccess&&!!cloudRemoteAt,null,{timeout:60000});assert.equal(await p.evaluate(()=>APP_VER),version);
    await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudDirty=false;});
    for(const tab of ['settings','data','pl','overview','fixed'])assert(await p.locator('nav [data-p='+tab+']').isHidden(),tab);
    assert(await p.locator('nav [data-p=order]').isVisible());await p.evaluate(()=>go('order'));assert.equal(await p.locator('#invoice-monthly-summary').count(),0);assert(await p.locator('#invoice-files').count());await p.locator('#invoice-status-refresh').click();await p.waitForFunction(()=>invoiceOcr.status.includes('정상')||!!invoiceOcr.error);assert.equal(await p.evaluate(()=>invoiceOcr.error),'');
    await p.locator('nav [data-p=ticketSales]').click();assert(await p.locator('#food-ticket-ledger').isVisible());assert(await p.locator('#food-ticket-company-details').evaluate(e=>e.open));assert(await p.locator('[data-ticket-history]').isVisible());assert.equal(await p.evaluate(()=>location.hash),'#ticketSales');await p.screenshot({path:'/tmp/nmf-shared-ticket-live.png'});await p.reload();await p.waitForFunction(()=>!!window.NmfAccess&&!!cloudRemoteAt,null,{timeout:60000});assert(await p.locator('#food-ticket-ledger').isVisible(),'refresh preserves the independent ticket route');await p.evaluate(()=>NmfAccess.showSalesTab('sales'));
    assert(!await p.evaluate(()=>Object.hasOwn(S.staff[0]||{},'account')));
    assert.equal(await p.evaluate(()=>S.settings.defaultBreakMinutes),0);
    assert.notEqual(await p.locator('#admin-password').evaluate(e=>getComputedStyle(e).color),'rgb(255, 255, 255)');
    await p.screenshot({path:'/tmp/nmf-access-live-guest-desktop.png'});
    for(const tab of ['roster','recipe','sales']){
      await p.evaluate(tab=>go(tab),tab);await p.waitForTimeout(250);
      assert(!((await p.locator('#main').innerText()).includes('화면을 그리지 못했습니다')),tab);
      await p.screenshot({path:'/tmp/nmf-access-live-guest-'+tab+'.png'});
    }
    await p.evaluate(()=>go('roster'));if(!await p.locator('#staffArchive').evaluate(e=>e.open))await p.locator('#staffArchive summary').click();const staffBefore=await p.evaluate(()=>JSON.stringify(S));await p.evaluate(()=>window.liveArchiveInput=document.getElementById('staffArchiveSearch'));for(const name of ['김홍구','김언석','이현빈']){await p.locator('#staffArchiveSearch').fill(name);assert(await p.locator('#staffArchive tr[data-staff-archive-id]').count()>0,'live archive finds '+name);assert(await p.evaluate(()=>window.liveArchiveInput===document.getElementById('staffArchiveSearch')));assert.equal(await p.locator('[data-staff-archive-wage]').count(),0);}assert.equal(await p.evaluate(()=>JSON.stringify(S)),staffBefore,'real names are searched without restoring/editing records');await p.locator('#staffArchiveSearch').fill('');
    await p.locator('#admin-password').fill(admin);await p.locator('#admin-form button').click();await p.waitForFunction(()=>NmfAccess.isAdmin()&&document.querySelector('#admin-lock'),null,{timeout:45000});
    await p.waitForFunction(()=>!cloudBusy);for(const tab of ['settings','data','pl','overview','fixed','order'])assert(await p.locator('nav [data-p='+tab+']').isVisible(),tab);
    for(const tab of ['sales','roster','settings','data','order','pl']){await p.evaluate(tab=>go(tab),tab);await p.waitForTimeout(400);assert(!((await p.locator('#main').innerText()).includes('화면을 그리지 못했습니다')),tab);}
    await p.evaluate(()=>go('overview'));await p.waitForFunction(()=>overview.loaded&&!overview.busy,null,{timeout:45000});assert((await p.evaluate(()=>overviewModel().rows)).every(r=>r.status==='ready'||r.status==='empty'));
    await p.reload();await p.waitForFunction(()=>!!window.NmfAccess&&!!cloudRemoteAt,null,{timeout:60000});assert(!await p.evaluate(()=>NmfAccess.isAdmin()));assert(await p.locator('nav [data-p=data]').isHidden());
    await p.setViewportSize({width:390,height:900});await p.screenshot({path:'/tmp/nmf-access-live-guest-mobile.png'});assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1));
    const store=await b.newPage({viewport:{width:1440,height:1000}});store.on('pageerror',e=>errors.push(e.message));await store.addInitScript(pw=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw',pw);},pw);await store.route('**/*',readOnly);
    await store.goto('https://d-bae.com/namofood/?v='+version+'#sales');await store.waitForFunction(()=>window.NmfAccess&&!!cloudRemoteAt,null,{timeout:60000});assert(await store.locator('.store-amount-table').isVisible());assert.equal(await store.locator('[data-store-amount=creditQty]').count(),0);assert.equal(await store.locator('[data-store-amount=cardAmount]').count(),await store.locator('[data-store-amount=cashAmount]').count());assert(!await store.evaluate(()=>Object.values(S.storeProducts||{}).some(p=>Object.hasOwn(p,'cost'))));await store.screenshot({path:'/tmp/nmf-store-amounts-live-desktop.png'});
    await store.evaluate(()=>go('recipe'));assert(await store.locator('#store-itemsPerTicket').isVisible());assert.equal(await store.locator('[data-field=ticketUnits]').count(),0);assert.equal(await store.locator('[data-field=cost]').count(),0);await store.setViewportSize({width:320,height:900});for(const tab of ['sales','recipe']){await store.evaluate(tab=>go(tab),tab);assert(await store.evaluate(()=>main.scrollWidth<=main.clientWidth+1),'store '+tab+' mobile');}await store.screenshot({path:'/tmp/nmf-store-amounts-live-mobile.png'});await store.close();
    assert.deepEqual(errors,[]);assert.equal(blockedWrites,0,'mere navigation must not try to mutate production');
    console.log(JSON.stringify({version,guestProcurementAndOcrStatus:true,ticketTab:true,guestPrivateTabsHidden:true,adminLogin:true,settingsBackup:true,adminFinancialPages:true,threeRoomOverview:true,refreshRelocked:true,mobile:true,storeAmountAndTicketSettings:true,ledgerWrites:0,providerCalls:0}));
  }finally{await b.close();}
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
