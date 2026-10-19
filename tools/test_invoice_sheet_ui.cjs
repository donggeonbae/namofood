// Real browser + worker parsing; all ledger, source storage and AI calls isolated.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{chromium}=require('playwright');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'나모푸드_관리앱.html'),'utf8'),password='offline-sheet-password';
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[],db=new Map();let aiCalls=0,failStore=true,dataReads=0,ledgerMode=false;
 page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(pw=>{sessionStorage.setItem('nmf_session_pw',pw);localStorage.setItem('nmf_pw',pw);localStorage.setItem('nmf_cloud_bootstrap_done','1');},password);
 await context.route('**/*',async route=>{const q=route.request(),u=new URL(q.url());
  if(q.isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
  if(u.pathname.startsWith('/assets/')){const name=u.pathname.split('/').pop();if(['invoice-sheet-worker.js','xlsx-0.20.3.full.min.js'].includes(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'assets',name))});}
  if(u.hostname==='sheet-store.namofood.test'&&u.pathname==='/functions/v1/nmf-invoice-ocr'){
   const body=q.postDataJSON();assert.equal(body.documentType,'spreadsheet');assert(!body.image);const ts=q.headers()['x-nmf-time'],digest=crypto.createHash('sha256').update(q.postData()).digest('hex');assert.equal(q.headers()['x-nmf-signature'],crypto.createHmac('sha256',password).update('nmf-invoice:'+digest+':'+ts).digest('hex'));aiCalls++;
   assert(body.spreadsheet.cells.some(c=>c.a==='A2'&&c.v==='26-10-12'),'actual worker sends original date text');
   await new Promise(r=>setTimeout(r,50));
   return route.fulfill({json:{ok:true,documentType:'spreadsheet',model:'offline-fixture',processedAt:'2026-10-17T00:00:00Z',labelReview:{status:'completed',model:'offline',reviewedRows:3,changedRows:0},documents:[
    {...(ledgerMode?{sourceAudit:{sourceType:'period-ledger',rowCount:2,sheetItemCount:3,periodTotal:35000,totalMatches:true}}:{}),sourceKey:'1'.repeat(64),sourceRefs:['A2','C2','E2'],document:{date:'2026-10-12',vendor:'검증유통',total:30000,tax:null,rawText:'A2: 26-10-12\nC2: 양파',warnings:[],items:[{name:'양파',qty:2,price:15000,amt:30000,tax:0},{name:'세제',qty:'생수×3',price:null,amt:null,tax:null}]}},
    {...(ledgerMode?{sourceAudit:{sourceType:'period-ledger',rowCount:1,sheetItemCount:3,periodTotal:35000,totalMatches:true}}:{}),sourceKey:'2'.repeat(64),sourceRefs:['A4','C4','E4'],document:{date:'2026-10-13',vendor:'검증유통',total:5000,rawText:'A4: 26-10-13\nC4: 당근',warnings:[],items:[{name:'당근',qty:1,amt:5000}]}},
   ]}});
  }
  if(u.hostname==='sheet-store.namofood.test'&&u.pathname==='/rest/v1/namofood_state'){
   const id=(u.searchParams.get('id')||'').replace(/^eq\./,'');
   if(q.method()==='GET'){const row=db.get(id),select=u.searchParams.get('select');if(select==='data')dataReads++;return route.fulfill({json:row?[Object.fromEntries(select.split(',').map(k=>[k,row[k]]))]:[]});}
   assert.equal(q.method(),'POST','no production/main ledger writes');const rows=q.postDataJSON();assert.equal(rows.length,1);assert(rows[0].id.startsWith('namofood#invoice-file#'));assert.equal(u.searchParams.get('select'),'id');
   if(failStore)return route.fulfill({status:503,json:{error:'offline storage failure'}});
   if(db.has(rows[0].id))return route.fulfill({json:[]});db.set(rows[0].id,rows[0]);return route.fulfill({status:201,json:[{id:rows[0].id}]});
  }
  return route.abort();
 });
 try{
  await page.goto('https://files.namofood.test/');await page.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;cloud.url='https://sheet-store.namofood.test';cloud.key='offline-key';cloud.table='namofood_state';cloud.room='namofood';S=normalize(defaultState());S.month='2026-10';S.orders={};S.orderEdits={};orderRange.mode='month';orderView='sheet';go('order');});
  assert((await page.locator('#invoice-files').getAttribute('accept')).includes('.xlsx'));
  const bytes=Buffer.from('\uFEFF거래일,업체,품목,수량,금액\n26-10-12,검증유통,양파,2,"30,000"\n26-10-12,검증유통,세제,생수×3,\n26-10-13,검증유통,당근,1,5000\n');
  const upload=async()=>{await page.locator('#invoice-files').setInputFiles({name:'새로운양식.csv',mimeType:'text/csv',buffer:bytes});await page.waitForFunction(()=>!invoiceOcr.busy,{},{timeout:40000});};
  await upload();assert.equal(aiCalls,1);assert.equal(await page.evaluate(()=>Object.values(S.orders).flat().length),1,'failed source storage leaves accepted rows recoverable, not discarded');assert.equal(await page.evaluate(()=>invoiceOcr.progress.failed),1);assert(!(await page.evaluate(()=>Object.values(S.orders).flat()[0].ocrMeta.sourceFileComplete)),'partial batches cannot be marked complete');
  failStore=false;await upload();assert.equal(aiCalls,2,'partial file retries AI instead of silently skipping remaining invoices');
  const state=await page.evaluate(()=>Object.values(S.orders).flat());assert.equal(state.length,2);assert.equal(state.find(o=>o.date==='2026-10-12').items.length,2);assert.equal(state.find(o=>o.date==='2026-10-12').items[1].amt,null);assert(state.every(o=>o.invoiceFile?.hash&&o.ocrMeta.sourceFileComplete));assert.equal(db.size,1,'both invoices share one encrypted source file');assert.equal(dataReads,0,'source is lazy-loaded');
  const row=db.values().next().value;assert(!row.data.includes('검증유통'));assert(!JSON.stringify(state).includes(bytes.toString('base64')),'base64 never enters main shared state');
  await upload();assert.equal(aiCalls,2,'fully imported identical file avoids provider calls and duplicate rows');assert.equal(await page.evaluate(()=>Object.values(S.orders).flat().length),2);assert.equal(await page.evaluate(()=>invoiceOcr.progress.skipped),1);
  await page.evaluate(()=>invoiceOpenExisting(Object.values(S.orders).flat()[0].id));const downloadPromise=page.waitForEvent('download');await page.locator('[data-invoice-file-download]:visible').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'새로운양식.csv');assert.deepEqual(fs.readFileSync(await download.path()),bytes);assert.equal(dataReads,1);
  assert(await page.evaluate(()=>{const before=structuredClone(S);delete before.orders['2026-10'][0].invoiceFile;return taxAiFinanceKey(before)===taxAiFinanceKey(S);}), 'attachment-only edits do not change financial hash');
  assert(await page.evaluate(()=>{const remote=structuredClone(S);const left=S.orders['2026-10'][0],right=remote.orders['2026-10'][0];delete right.invoiceFile;const target=structuredClone(right);preserveInvoicePhoto(target,left,right);return !!target.invoiceFile;}),'stale financial edits preserve original file references');
  for(const width of [1920,390,320]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.getElementById('main').scrollWidth<=document.getElementById('main').clientWidth+1),'no page overflow '+width);}
  ledgerMode=true;await page.locator('#invoice-files').setInputFiles({name:'기간원장.csv',mimeType:'text/csv',buffer:Buffer.concat([bytes,Buffer.from('\n')])});await page.waitForFunction(()=>!invoiceOcr.busy,{},{timeout:40000});const preserved=await page.evaluate(()=>{const all=Object.values(S.orders).flat();return {financial:all.filter(invoiceFinancial).length,financialTotal:all.filter(invoiceFinancial).reduce((n,o)=>n+orderAmt(o),0),refs:all.filter(o=>o.ocrMeta?.referenceOnly).map(o=>({source:o.ocrMeta.sourceAudit?.sourceType,pending:o.ocrMeta.sourceAudit?.reconcilePending,file:!!o.invoiceFile,items:o.items.length}))};});assert.equal(preserved.financial,0);assert.equal(preserved.financialTotal,0);assert.equal(preserved.refs.length,4);assert(preserved.refs.every(o=>o.pending&&o.file),'without the reconciliation service, every upload stays linked and pending, never silently counted');assert.equal(preserved.refs.filter(o=>o.source==='period-ledger').length,2);assert.equal(await page.locator('[data-ledger-resume]').count(),4,'pending uploads are resumable after reconnecting');
  assert.deepEqual(errors,[]);console.log('INVOICE_SHEET_BROWSER_WORKER_UPLOAD_HMAC_PARTIAL_RETRY_DEDUP_ENCRYPTED_ORIGINAL_DOWNLOAD_MOBILE_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
