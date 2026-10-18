const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 for(const app of ['food','cafe','store']){
  const ctx=await browser.newContext(),p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await ctx.addInitScript(({app,pw})=>{localStorage.setItem('nmf_app',app);localStorage.setItem('nmf_supa_'+app,JSON.stringify({url:'',key:''}));if(pw)sessionStorage.setItem('nmf_session_pw',pw);},{app,pw:process.env.NMF_PW||''});
  await ctx.route('**/*',r=>process.env.NMF_NAV_URL?(['GET','HEAD','OPTIONS'].includes(r.request().method())&&new URL(r.request().url()).hostname==='d-bae.com'?r.continue():r.abort()):r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
  await p.goto(process.env.NMF_NAV_URL||'https://navigation.namofood.test');if(process.env.NMF_NAV_URL)await p.waitForFunction(()=>document.getElementById('appver')?.textContent==='버전 1019-6-finance-nav',null,{timeout:45000});
  assert.deepEqual(await p.evaluate(()=>{const f=document.querySelector('nav [data-p=fixed]');return [f.dataset.p,f.nextElementSibling.dataset.p,f.nextElementSibling.nextElementSibling.dataset.p];}),['fixed','pl','overview'],app+' finance menus immediately follow fixed costs');
  assert.equal(await p.locator('nav [data-p=roster]').isVisible(),app!=='store','preserve food/cafe employee menus');
  assert.equal(await p.locator('nav [data-p=fixed]').isVisible(),app!=='store');
  const before=await p.evaluate(()=>{S.fixedMonthly[S.month]||=[];return JSON.stringify(S);}); // Existing records, not first-use fixed-category initialization.
  for(const width of [1440,390]){await p.setViewportSize({width,height:1000});await p.locator('nav [data-p=pl]').click();assert.equal(await p.evaluate(()=>page),'pl');if(app!=='store'){await p.locator('nav [data-p=fixed]').click();assert.equal(await p.evaluate(()=>page),'fixed');}assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  assert.equal(await p.evaluate(()=>JSON.stringify(S)),before,'navigation changes no ledger data');if(app==='store'){await p.locator('nav [data-p=settings]').click();assert.equal(await p.locator('#tax-tools').count(),1);assert(!(await p.locator('#main').innerText()).includes('기본 시급'));}assert.deepEqual(errors,[]);await ctx.close();
 }
 console.log('ALL_APPS_FIXED_PROFIT_OVERVIEW_ORDER_DESKTOP_MOBILE_ROUTES_NO_LEDGER_CHANGE_OK');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
