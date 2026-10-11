// Process explicitly supplied statement photographs through the deployed OCR server.
// No invoice confirmation, database/storage writes, or private output files.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
  const password=process.env.NMF_PW,photos=JSON.parse(process.env.NMF_INVOICE_PHOTOS||'[]');
  if(!password||!photos.length)throw new Error('Supply NMF_PW and explicit NMF_INVOICE_PHOTOS paths.');
  const source=fs.readFileSync(path.join(__dirname,'..','나모푸드_관리앱.html'),'utf8');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage();let blockedWrites=0,ocrCalls=0;
    page.on('response',async response=>{
      if(!response.url().endsWith('/functions/v1/nmf-invoice-ocr')||response.request().method()!=='POST')return;
      try{const body=await response.json();if(!response.ok())console.log(JSON.stringify({ocrHttpStatus:response.status(),code:body.code,providerStatus:body.providerStatus}));else if(response.request().postDataJSON().action==='status')console.log(JSON.stringify({ocrHttpStatus:response.status(),configured:body.configured,model:body.model}));}catch{}
    });
    await page.addInitScript(password=>{localStorage.setItem('nmf_app','food');sessionStorage.setItem('nmf_session_pw',password);},password);
    await page.route('**/*',route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
      if(url.pathname==='/functions/v1/nmf-invoice-ocr'){
        if(request.method()==='POST'){assert(['status','extract'].includes(request.postDataJSON().action));ocrCalls++;}
        return route.continue();
      }
      if(!['GET','HEAD','OPTIONS'].includes(request.method()))blockedWrites++;
      if(url.pathname==='/rest/v1/namofood_state'&&request.method()==='GET')return route.fulfill({json:[]});
      return route.abort();
    });
    await page.goto('https://d-bae.com/namofood/#order');
    await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('order');});
    const before=await page.evaluate(()=>JSON.stringify(S));
    await page.locator('#invoice-status-refresh').click();
    await page.waitForFunction(()=>invoiceOcr.status.includes('정상')||!!invoiceOcr.error,null,{timeout:20000});
    assert.equal(await page.evaluate(()=>invoiceOcr.error),'');
    if(process.env.NMF_EXPECTED_OCR_MODEL)assert((await page.evaluate(()=>invoiceOcr.status)).includes(process.env.NMF_EXPECTED_OCR_MODEL),'deployed server must use the explicitly selected OCR model before sending a photograph');
    for(let i=0;i<photos.length;i++){
      const photo=typeof photos[i]==='string'?{path:photos[i]}:photos[i];
      const prior=await page.evaluate(()=>invoiceOcr.drafts.length);
      await page.locator('#invoice-files').setInputFiles(photo.path);
      await page.waitForFunction(()=>!invoiceOcr.busy,null,{timeout:135000});
      const result=await page.evaluate(prior=>({error:invoiceOcr.error,draft:invoiceOcr.drafts[prior]?.document,model:invoiceOcr.drafts[prior]?.model}),prior);
      assert.equal(result.error,'','real server processing must succeed');assert(result.draft,'the uploaded photograph must produce a review draft');
      if(process.env.NMF_EXPECTED_OCR_MODEL)assert.equal(result.model,process.env.NMF_EXPECTED_OCR_MODEL,'photograph must be processed by the explicitly selected model');
      const document=result.draft;
      if(photo.expected)for(const [key,value]of Object.entries(photo.expected))assert.equal(key==='rows'?document.items.length:document[key],value,'photograph '+(i+1)+' '+key);
      console.log(JSON.stringify({photo:i+1,date:document.date,rows:document.items.length,total:document.total,subtotal:document.subtotal,tax:document.tax,previousBalance:document.previousBalance,balanceTotal:document.balanceTotal,model:result.model,itemGrossSum:document.items.reduce((s,x)=>s+(x.amt||0),0),itemSupplySum:document.items.reduce((s,x)=>s+(x.supplyAmount||0),0),itemTaxSum:document.items.reduce((s,x)=>s+(x.tax||0),0),warnings:document.warnings,confirmed:false}));
    }
    assert.equal(await page.evaluate(()=>JSON.stringify(S)),before,'processing photographs must not commit orders or touch application records');
    console.log(JSON.stringify({processed:photos.length,ocrCalls,blockedWrites,productionDatabaseWrites:0,confirmedOrders:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
