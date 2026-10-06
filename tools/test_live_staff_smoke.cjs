// Read-only production smoke: reject writes and AI run requests before loading.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async()=>{
  const expected=process.env.NMF_EXPECTED_VER||'1006-1-staff-history';
  const password=process.env.NMF_PW;if(!password)throw new Error('NMF_PW is required');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),password);
    const page=await context.newPage();let documents=0,blockedWrites=0;const statuses=[];
    await page.route('**/*',route=>{
      const request=route.request();if(request.isNavigationRequest())documents++;
      if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
      let action;try{action=request.postDataJSON()?.action;}catch{}
      if(request.method()==='POST'&&request.url().endsWith('/functions/v1/nmf-recipe-fill')&&action==='status')return route.continue();
      blockedWrites++;return route.abort();
    });
    page.on('response',response=>{if(response.url().endsWith('/functions/v1/nmf-recipe-fill'))statuses.push({status:response.status(),origin:response.headers()['access-control-allow-origin']});});
    await page.goto('https://d-bae.com/namofood/?v='+encodeURIComponent(expected)+'#roster',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(version=>document.getElementById('appver')?.textContent==='버전 '+version,expected,{timeout:45000});
    await page.waitForFunction(()=>S.staff.length===12&&(S.staffArchive||[]).length>=7&&S.settings.rolePayInitialized,{timeout:20000});
    await page.evaluate(()=>{cloudApplying=true;clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);go('roster');});
    const staff=await page.evaluate(()=>{
      const targets=JSON.parse('['+initializeStaffPay.toString().match(/for\(const e of state\.staff\|\|\[\]\)if\(\[(.*?)\]\.includes\(e\.name\)\)e\.wage=20000/)[1].replaceAll("'",'"')+']');
      return {roles:staffRoles(),wages:S.settings.roleWages,named:targets.map(name=>staffWage(S.staff.find(e=>e.name===name))),archives:S.staffArchive.length,workedRows:laborRows().length,workedOnly:laborRows().every(r=>r.h>0)};
    });
    assert.deepEqual(staff.roles,['총괄','조리','보조','이송']);
    assert.deepEqual(staff.wages,{총괄:15000,조리:15000,보조:13000,이송:13000});
    assert.deepEqual(staff.named,[20000,20000,20000]);assert(staff.workedOnly);
    assert.equal(await page.locator('#staffArchive').getAttribute('open'),null);
    assert.equal(await page.locator('#staffRoleSettings').count(),1);
    await page.locator('#staffRoleSettings summary').click();
    assert.equal(await page.locator('input[data-role-wage]').count(),4);
    await page.screenshot({path:'/tmp/nmf-live-staff-roles.png',fullPage:true});
    await page.evaluate(()=>go('menu'));
    assert.equal(await page.locator('input[data-print-meal]').count(),4);
    await page.evaluate(()=>go('sales'));
    assert.equal(await page.locator('#ticketMealStats').getAttribute('open'),null);
    await page.evaluate(async()=>{go('recipe');await refreshRecipeMonitor(true);});
    const monitor=await page.evaluate(()=>({error:recipeMonitor.error,ready:!!recipeMonitor.data?.ok}));
    assert.equal(monitor.error,'');assert(monitor.ready);
    assert(statuses.some(r=>r.status===200&&r.origin==='https://d-bae.com'),'real signed browser status request succeeds with exact production CORS origin');
    await page.waitForTimeout(9000);
    assert.equal(documents,1,'new deployed page must not reload itself');
    assert.equal(await page.locator('#newver').count(),0);
    console.log(JSON.stringify({version:expected,staffChecks:staff,recipeStatus:monitor,origin:'https://d-bae.com',documents,blockedWrites,productionWrites:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exit(1);});
