// Read-only deployed-page smoke. Status only: no photos, provider calls, or database writes.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
  const password=process.env.NMF_PW,version=process.env.NMF_EXPECTED_VER||'1011-4-invoice-review',model=process.env.NMF_EXPECTED_OCR_MODEL||'gpt-6-luna';
  if(!password)throw new Error('NMF_PW is required');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage();let status=null,documents=0,blockedWrites=0;const errors=[];
    await page.addInitScript(password=>{localStorage.setItem('nmf_app','food');sessionStorage.setItem('nmf_session_pw',password);},password);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.isNavigationRequest())documents++;
      if(url.pathname==='/rest/v1/namofood_state'&&request.method()==='GET')return route.fulfill({json:[]});
      if(request.method()==='POST'&&url.pathname==='/functions/v1/nmf-invoice-ocr'&&request.postDataJSON().action==='status'){
        const response=await route.fetch(),body=await response.json();
        status={http:response.status(),origin:response.headers()['access-control-allow-origin'],body};
        return route.fulfill({response});
      }
      if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
      blockedWrites++;return route.abort();
    });
    await page.goto('https://d-bae.com/namofood/?v='+encodeURIComponent(version)+'#order',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(version=>document.getElementById('appver')?.textContent==='버전 '+version,version,{timeout:45000});
    await page.evaluate(()=>{cloudApplying=true;clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);go('order');});
    assert.equal(await page.locator('#invoice-files').count(),1);
    assert.equal(await page.locator('#invoice-files').evaluate(input=>input.multiple),true);
    assert.equal(await page.locator('#invoice-progress-bar').evaluate(el=>el.tagName),'PROGRESS');
    assert.equal(await page.locator('#invoice-duplicate-review[role="dialog"]').count(),1);
    assert.equal(await page.locator('[data-invoice-date]').count(),31);
    assert.equal(await page.locator('[data-invoice-confirm],[data-invoice-commit]').count(),0);
    const before=await page.evaluate(()=>JSON.stringify(S));
    await page.locator('#invoice-status-refresh').click();
    await page.waitForFunction(()=>invoiceOcr.status.includes('정상')||!!invoiceOcr.error,null,{timeout:20000});
    assert.equal(await page.evaluate(()=>invoiceOcr.error),'');
    assert(status&&status.http===200);assert.equal(status.origin,'https://d-bae.com');
    assert.equal(status.body.configured,true);assert.equal(status.body.model,model);assert.equal(status.body.plan,'go');assert.equal(status.body.provider,'OpenCode Go');assert.equal(status.body.imageStored,false);
    assert.equal(status.body.labelReviewEnabled,true);assert.equal(status.body.maxProviderCalls,2);
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'status and navigation cannot mutate application records');
    await page.locator('[data-order-view="card"]').click();
    assert.equal(await page.locator('#card-history').count(),1);
    assert.equal(await page.locator('#card-files').evaluate(input=>input.multiple),true);
    assert.equal(await page.locator('#card-progress-bar').evaluate(el=>el.tagName),'PROGRESS');
    assert.equal(await page.locator('[data-card-date]').count(),31);
    await page.locator('#card-status-refresh').click();
    await page.waitForFunction(()=>cardOcr.status.includes('정상')||!!cardOcr.error,null,{timeout:20000});
    assert.equal(await page.evaluate(()=>cardOcr.error),'');
    assert.equal(status.body.cardOcrEnabled,true);assert.equal(status.body.cardMaxProviderCalls,1);
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'card status cannot register or modify financial records');
    await page.waitForTimeout(9000);
    assert.equal(documents,1,'the deployed build must not reload itself');assert.equal(await page.locator('#newver').count(),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({version,model,status,documents,blockedWrites,photosSent:0,providerCalls:0,productionDatabaseWrites:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
