const fs=require('node:fs'),assert=require('node:assert/strict'),{createHmac,createHash}=require('node:crypto'),{chromium}=require('playwright');
const source=fs.readFileSync('나모푸드_관리앱.html','utf8'),pw='test-coupang-app-password';
const fixture={orders:[{orderNo:'12345678901234',date:'2026-10-12',status:'배송완료',total:30000,items:[{name:'콜라 <캔>',spec:'24개',qty:2,unit:'박스',price:null,amt:12000},{name:'생수',spec:'2L',qty:3,unit:'묶음',price:null,amt:18000}]}],warnings:[]};
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const ctx=await browser.newContext(),p=await ctx.newPage(),errors=[],calls=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
 await ctx.addInitScript(pw=>{localStorage.setItem('nmf_app','store');localStorage.setItem('nmf_supa_store',JSON.stringify({url:'',key:''}));sessionStorage.setItem('nmf_session_pw',pw);},pw);
 await p.route('**/*',async route=>{const r=route.request();if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:source});
  if(new URL(r.url()).pathname==='/functions/v1/nmf-coupang'){
   const raw=r.postData(),body=JSON.parse(raw),time=r.headers()['x-nmf-time'];calls.push(body.action);
   assert.equal(body.role,'app');assert.equal(body.room,'namostore');
   assert.equal(r.headers()['x-nmf-signature'],createHmac('sha256',pw).update('nmf-coupang:app:'+time+':'+createHash('sha256').update(raw).digest('hex')).digest('hex'));
   assert(!raw.includes(pw));
   if(body.action==='start'||body.action==='login')return route.fulfill({json:{ok:true,jobId:'01234567-1234-4234-8234-123456789012'}});
   return route.fulfill({json:{ok:true,worker:{online:true,state:'ready'},job:body.jobId?{id:body.jobId,status:'done',progress:100,result:fixture}:null}});
  }
  if(new URL(r.url()).pathname==='/rest/v1/namofood_state')return route.fulfill({json:[]});return route.abort();
 });
 await p.goto('https://coupang-ui.namofood.test');await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloud.url='https://coupang-server.namofood.test';cloud.key='test-publishable';cloudApplying=true;S.month='2026-10';go('order');});
 assert.equal(await p.locator('#coupang-panel').count(),1);
 await p.locator('#coupang-status').click();await p.waitForFunction(()=>coupangUi.worker?.online===true);
 await p.locator('#coupang-import').click();await p.waitForFunction(()=>!coupangUi.busy&&coupangUi.orders.length===1);
 assert.equal(await p.evaluate(()=>Object.values(S.orders).flat().length),0,'review does not create costs');
 assert.equal(await p.locator('#coupang-panel 캔').count(),0,'escaped product labels');
 await p.locator('[data-coupang-item] input[type=checkbox]').nth(1).uncheck();
 await p.locator('[data-coupang-item] input[aria-label="쿠팡 수량"]').first().fill('4');await p.locator('[data-coupang-item] input[aria-label="쿠팡 수량"]').first().press('Tab');
 await p.locator('#coupang-status').click();await p.waitForFunction(()=>coupangUi.status.includes('수정 내용은 유지'));
 assert.equal(await p.evaluate(()=>coupangUi.orders[0].items[0].qty),4,'status refresh preserves unsaved review edits');
 assert.equal(await p.locator('#coupang-stock-import').count(),0,'one combined action replaces the two separate registration steps');assert.equal(await p.evaluate(()=>storeStock('2026-10-19').lines.length),0,'unaccepted preview never becomes inventory');
 await p.locator('#coupang-register').click();await p.waitForFunction(()=>!coupangUi.busy&&!!orderRef('coupang-12345678901234'));
 const first=await p.evaluate(()=>{const o=orderRef('coupang-12345678901234').order;return {items:o.items,amount:orderAmt(o),partial:o.coupang.partial};});
 assert.equal(first.items.length,1);assert.equal(first.items[0].qty,4);assert.equal(first.amount,12000,'partial import uses selected recorded amounts, not order grand total');assert(first.partial);
 assert.equal(await p.evaluate(()=>storeStock('2026-10-19').lines.length),1,'same registration updates inventory');assert.equal(await p.locator('[data-coupang-order]').count(),0,'processed review is cleared');
 await p.evaluate(()=>{const o=orderRef('coupang-12345678901234').order;oItem(o.id,o.items[0].id,'qty','6');});
 assert.equal(await p.evaluate(()=>orderRef('coupang-12345678901234').order.items[0].amt),12000,'saved quantity edit does not fabricate a new paid amount');
 assert.equal(await p.locator('[aria-label="쿠팡 발주 반영 총액"]').count(),1,'imported total remains directly editable');
 await p.evaluate(()=>{coupangSelectAll(true);});assert.equal(await p.evaluate(()=>coupangUi.picks.size),0,'existing order excluded');
 await p.evaluate(()=>{const o=orderRef('coupang-12345678901234').order;o.note='수동 수정 유지';markOrder(o);const incoming=structuredClone(S);incoming.orders['2026-10'][0].note='old automatic';incoming.orderEdits[o.id]={origin:'coupang',at:'2099-01-01T00:00:00Z',deleted:false};mergeRemoteOrders(incoming);});
 assert.equal(await p.evaluate(()=>orderRef('coupang-12345678901234').order.note),'수동 수정 유지','automatic import never overwrites edited record');
 await p.evaluate(()=>{const o=orderRef('coupang-12345678901234').order;markOrder(o,true);S.orders['2026-10']=[];coupangSelectAll(true);});assert.equal(await p.evaluate(()=>coupangUi.picks.size),0,'deleted order does not resurrect');
 assert.equal(await p.evaluate(()=>JSON.stringify(S).includes('test-coupang-app-password')),false,'no credential in shared state');
 for(const width of [1600,390,320]){await p.setViewportSize({width,height:1000});assert(await p.evaluate(()=>document.getElementById('main').scrollWidth<=document.getElementById('main').clientWidth+1),'fits '+width);if(width!==320)await p.screenshot({path:'/tmp/nmf-coupang-'+width+'.png'});}
 assert.deepEqual(errors,[]);assert.deepEqual(calls.slice(0,4),['defaults','status','start','result']);console.log('COUPANG_SIGNED_UI_REVIEW_EDIT_PARTIAL_AMOUNT_DUPLICATE_TOMBSTONE_MANUAL_MERGE_RESPONSIVE_OK');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
