// Process explicitly supplied statement photographs through the deployed OCR server.
// Calls preprocessing + authenticated extraction directly; never invokes the auto-registering upload UI.
// No application-state, database/storage writes, or private output files.
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
    const before=await page.evaluate(()=>({state:JSON.stringify(S),persisted:localStorage.getItem(KEY)}));
    const statusResponse=page.waitForResponse(response=>response.url().endsWith('/functions/v1/nmf-invoice-ocr')&&response.request().method()==='POST'&&response.request().postDataJSON().action==='status');
    await page.locator('#invoice-status-refresh').click();
    const serverStatus=await (await statusResponse).json();
    assert.equal(serverStatus.configured,true,'the deployed OCR server must be configured');
    if(process.env.NMF_EXPECTED_OCR_PLAN)assert.equal(serverStatus.plan,process.env.NMF_EXPECTED_OCR_PLAN,'the explicitly selected plan must be used before sending a photograph');
    if(process.env.NMF_EXPECTED_OCR_MODEL)assert.equal(serverStatus.model,process.env.NMF_EXPECTED_OCR_MODEL,'the explicitly selected model must be verified before sending a photograph');
    await page.waitForFunction(()=>invoiceOcr.status.includes('정상')||!!invoiceOcr.error,null,{timeout:20000});
    assert.equal(await page.evaluate(()=>invoiceOcr.error),'');
    for(let i=0;i<photos.length;i++){
      const photo=typeof photos[i]==='string'?{path:photos[i]}:photos[i];
      const bytes=fs.readFileSync(photo.path),signature=bytes.subarray(0,12);
      const mime=signature[0]===0xff&&signature[1]===0xd8&&signature[2]===0xff?'image/jpeg':
        signature.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':
        signature.subarray(0,4).toString()==='RIFF'&&signature.subarray(8,12).toString()==='WEBP'?'image/webp':null;
      assert(mime,'explicitly supplied photograph must be JPEG, PNG or WebP');
      const result=await page.evaluate(async ({data,mime})=>{
        const file=new File([Uint8Array.from(atob(data),ch=>ch.charCodeAt(0))],'verification-photo',{type:mime});
        const image=await prepInvoiceImage(file);
        return invoiceOcrApi('extract',image);
      },{data:bytes.toString('base64'),mime});
      assert(result.ok&&result.document,'direct server extraction must return a document without registering it');
      if(process.env.NMF_EXPECTED_OCR_MODEL)assert.equal(result.model,process.env.NMF_EXPECTED_OCR_MODEL,'photograph must be processed by the explicitly selected model');
      const document=result.document;
      if(photo.expected)for(const [key,value]of Object.entries(photo.expected))assert.equal(key==='rows'?document.items.length:document[key],value,'photograph '+(i+1)+' '+key);
      console.log(JSON.stringify({photo:i+1,date:document.date,rows:document.items.length,total:document.total,subtotal:document.subtotal,tax:document.tax,previousBalance:document.previousBalance,balanceTotal:document.balanceTotal,model:result.model,itemGrossSum:document.items.reduce((s,x)=>s+(x.amt||0),0),itemSupplySum:document.items.reduce((s,x)=>s+(x.supplyAmount||0),0),itemTaxSum:document.items.reduce((s,x)=>s+(x.tax||0),0),warningCount:document.warnings?.length||0,autoRegistrationBypassed:true}));
    }
    assert.deepEqual(await page.evaluate(()=>({state:JSON.stringify(S),persisted:localStorage.getItem(KEY)})),before,'direct verification must not register orders or touch application/durable records');
    assert.equal(ocrCalls,photos.length+1,'one status and one extraction per photograph, without retry or paid fallback');
    console.log(JSON.stringify({processed:photos.length,ocrCalls,blockedWrites,productionDatabaseWrites:0,registeredOrders:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
