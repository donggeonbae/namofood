// Read deployed encrypted state; block all ledger writes and generation calls.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const pw=process.env.NMF_PW,version=process.env.NMF_EXPECTED_VER||'1019-10-ledger-basis';
 if(!pw)throw Error('NMF_PW required');
 const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];let writes=0;
  p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(pw=>{localStorage.setItem('nmf_app','food');sessionStorage.setItem('nmf_session_pw',pw);},pw);
  await p.route('**/*',r=>{const req=r.request(),u=new URL(req.url());if(!['GET','HEAD','OPTIONS'].includes(req.method())){if(u.pathname.startsWith('/rest/v1/'))writes++;return r.abort();}return r.continue();});
  await p.goto('https://d-bae.com/namofood/?v='+version);
  await p.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
  await p.waitForFunction(()=>!!cloudRemoteAt,null,{timeout:30000});
  await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('order');});
  const before=await p.evaluate(()=>JSON.stringify(S)),panel=p.locator('#invoice-reference-warning');
  assert(await panel.isVisible());assert.equal(await panel.evaluate(el=>el.open),false);
  assert(await p.locator('#invoice-monthly-summary').evaluate(el=>el.nextElementSibling?.id==='invoice-reference-warning'));
  const state=await p.evaluate(()=>{
   const all=S.orders[ym()]||[],refs=all.filter(o=>o.ocrMeta?.referenceOnly),masters=refs.filter(o=>o.ocrMeta?.ledgerMaster),daily=all.filter(o=>o.ocrMeta?.ledgerDaily),summary=invoiceMonthlyTotals(),orders=paymentOrders().filter(o=>invoiceValidDate(o.date)&&o.date.startsWith(ym()));
   const batches=[...new Map(masters.map(o=>[JSON.stringify(o.ocrMeta.ledgerMaster.derivedIds),o.ocrMeta.ledgerMaster])).values()];
   return {references:refs.length,masters:masters.length,archived:refs.filter(o=>o.ocrMeta?.coveredByLedgerId).length,daily:daily.length,rows:daily.reduce((s,o)=>s+o.items.length,0),ledgerTotal:daily.reduce((s,o)=>s+orderAmt(o),0),expectedDays:batches.reduce((s,b)=>s+b.days,0),expectedRows:batches.reduce((s,b)=>s+b.rows,0),expectedTotal:batches.reduce((s,b)=>s+b.total,0),monthly:summary.total,photos:masters.every(o=>invoicePhotoValid(o.invoicePhoto)),excluded:refs.every(o=>!orders.some(x=>x.id===o.id)),sumMatches:summary.total===orders.reduce((n,o)=>n+orderAmt(o),0),sourcesLinked:daily.every(o=>o.ocrMeta.ledgerDaily.parts.every(part=>masters.some(m=>m.id===part.orderId)))};
  });
  assert(state.masters>0&&state.archived>0);assert.deepEqual([state.daily,state.rows,state.ledgerTotal],[state.expectedDays,state.expectedRows,state.expectedTotal]);
  assert(state.photos&&state.excluded&&state.sumMatches&&state.sourcesLinked);
  await panel.locator('summary').click();await p.evaluate(()=>render());assert(await panel.evaluate(el=>el.open));
  await p.locator('[data-invoice-reference]').first().click();
  assert(await p.locator('[data-order-id]').first().isVisible());
  assert((await p.locator('#main').innerText()).includes('보관 서류 열람 중'));
  await p.locator('[data-reference-return]').click();
  await panel.locator('summary').click();assert.equal(await panel.evaluate(el=>el.open),false);
  await p.screenshot({path:'/tmp/nmf-live-invoice-reference-desktop.png'});
  for(const width of [390,320]){
   await p.setViewportSize({width,height:1000});
   assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1));
   await panel.locator('summary').click();assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1));
   await panel.locator('summary').click();
  }
  await p.screenshot({path:'/tmp/nmf-live-invoice-reference-phone.png'});
  await p.evaluate(()=>go('overview'));
  await p.waitForFunction(()=>overview.loaded&&!overview.busy,null,{timeout:30000});
  assert((await p.evaluate(()=>overviewModel().rows)).every(r=>['ready','empty'].includes(r.status)));
  assert((await p.locator('.overview-mobile').innerText()).includes('확인분'));
  assert.equal(await p.evaluate(()=>JSON.stringify(S)),before);assert.equal(writes,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({version,...state,allThreeRoomsLoaded:true,desktopAndPhone:true,sourceUnchanged:true,productionWrites:0,providerCalls:0}));
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
