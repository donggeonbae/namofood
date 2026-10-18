// Full UI + actual Chromium input + encrypted relay, entirely isolated fake login.
// Native device approval is simulated ONLY in a temporary test registry.
const fs=require('node:fs'),assert=require('node:assert/strict'),{mkdtemp,rm}=require('node:fs/promises'),{join}=require('node:path'),{tmpdir}=require('node:os'),{chromium}=require('playwright');
(async()=>{
 const {RemoteLogin,approveDevice}=await import('../connectors/coupang/remote.mjs');
 const source=fs.readFileSync('나모푸드_관리앱.html','utf8'),directory=await mkdtemp(join(tmpdir(),'nmf-web-login-fixture-'));
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let remote;
 try{
  const bus=new Set();function broadcast(sender,raw){const m=JSON.parse(raw);if(m.event==='phx_join')sender.deliver(JSON.stringify({event:'phx_reply',ref:'1',payload:{status:'ok'}}));if(m.event==='broadcast')for(const peer of bus)if(peer!==sender)peer.deliver(raw);}
  class Socket{constructor(){this.readyState=1;this.deliver=data=>this.onmessage?.({data});bus.add(this);setTimeout(()=>this.onopen?.(),0);}send(raw){broadcast(this,raw);}close(){this.readyState=3;bus.delete(this);this.onclose?.();}}
  const native=await browser.newContext();let authenticated=false,unexpected=0,ready=false;
  await native.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.hostname==='login.coupang.com'){
   if(r.method()==='POST'){authenticated=true;return route.fulfill({status:302,headers:{location:'https://mc.coupang.com/ssr/desktop/order/list'}});}
   return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>테스트 전용 쿠팡 로그인</h1><form method="post" action="/login/fixture"><p>테스트 이메일 <input id="email" name="email"></p><p>테스트 비밀번호 <input id="password" name="password" type="password"></p><button id="submit">로그인</button></form>'});
  }if(u.hostname==='mc.coupang.com')return route.fulfill({contentType:'text/html; charset=utf-8',body:authenticated?'<a href="https://login.coupang.com/login/logout.pang">로그아웃</a><h1>주문목록</h1>':'<input type="password">'});unexpected++;return route.abort();});
  const ctx=await browser.newContext(),p=await ctx.newPage(),errors=[],calls=[];let writes=0,pairResult,sessionResult,lastKind;
  p.on('pageerror',e=>errors.push(e.message));await ctx.addInitScript(()=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw','test-app-password');});
  await ctx.routeWebSocket('wss://rycibsczsgbkgtwfxyim.supabase.co/realtime/v1/websocket*',socket=>{const peer={deliver:raw=>socket.send(raw)};bus.add(peer);socket.onMessage(raw=>broadcast(peer,raw));socket.onClose(()=>bus.delete(peer));});
  await ctx.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());
   if(u.pathname==='/namofood/')return route.fulfill({contentType:'text/html; charset=utf-8',body:source});
   const file=u.pathname.replace('/namofood/','');if(['coupang-login.html','coupang-login.js','connectors/coupang/remote-protocol.mjs'].includes(file))return route.fulfill({contentType:file.endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8',body:fs.readFileSync(file,'utf8')});
   if(u.pathname==='/rest/v1/namofood_state')return r.method()==='GET'?route.fulfill({json:[]}):(writes++,route.abort());
   if(u.pathname==='/functions/v1/nmf-coupang'){
    const b=r.postDataJSON();calls.push(b.action);assert(!r.postData().includes('fixture-only-secret'));assert(!r.postData().includes('privateKey'));
    if(b.action==='pair'){
     assert(await approveDevice(directory,b.device,async()=>true));pairResult={certificate:{device:b.device,expires:Date.now()+86400000,mac:'test-server-certificate'}};lastKind='pair';return route.fulfill({json:{ok:true,jobId:'11111111-1111-4111-8111-111111111111'}});
    }
    if(b.action==='remote_login'){
     remote=new RemoteLogin({open:async()=>{},context:native},directory,async state=>{ready=state==='ready';});
     const session=await remote.start({id:'22222222-2222-4222-8222-222222222222',payload:{certificate:b.certificate,width:b.width},relay:{url:'wss://rycibsczsgbkgtwfxyim.supabase.co/realtime/v1/websocket',key:'test-public-key',Socket}});
     sessionResult={session,relay:{url:'wss://rycibsczsgbkgtwfxyim.supabase.co/realtime/v1/websocket',key:'test-public-key'}};lastKind='remote';return route.fulfill({json:{ok:true,jobId:session.id}});
    }
    if(b.action==='result')return route.fulfill({json:{ok:true,job:{status:'done',result:lastKind==='pair'?pairResult:sessionResult}}});
    if(b.action==='status')return route.fulfill({json:{ok:true,worker:{online:true,state:'ready'},job:null}});
    writes++;return route.abort();
   }
   if(!['GET','HEAD','OPTIONS'].includes(r.method()))writes++;return route.abort();
  });
  await p.goto('https://web-login.namofood.test/namofood/');await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;go('order');});
  await p.locator('#coupang-web-login').click();const viewer=p.frameLocator('iframe[title="쿠팡 공식 원격 로그인"]');
  await viewer.locator('#screen').waitFor({state:'visible',timeout:30000});
  const frame=p.frames().find(f=>f.url().includes('coupang-login.html'));await frame.waitForFunction(()=>document.getElementById('screen').naturalWidth>0);
  assert.equal(await p.evaluate(()=>invoicePending()),true,'app switching protected during login');
  assert.equal(await frame.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('nmf-coupang-login-device');r.onsuccess=()=>resolve(r.result);});const value=await new Promise(resolve=>{const r=db.transaction('device').objectStore('device').get('current');r.onsuccess=()=>resolve(r.result);});db.close();return value.privateKey.extractable;}),false);
  for(const width of [1280,390]){await p.setViewportSize({width,height:1000});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await p.screenshot({path:'/tmp/nmf-web-login-'+width+'.png'});}
  await p.setViewportSize({width:1280,height:1000});
  const input=viewer.locator('#keyboard'),image=viewer.locator('#screen');
  async function clickField(id){const point=await remote.page.locator('#'+id).boundingBox(),rect=await image.boundingBox();await image.click({position:{x:(point.x+point.width/2)*rect.width/sessionResult.session.width,y:(point.y+point.height/2)*rect.height/sessionResult.session.height}});}
  await clickField('email');await input.fill('fixture@example.test');await remote.page.waitForFunction(()=>document.getElementById('email').value==='fixture@example.test');
  await input.press('Tab');await input.fill('fixture-only-secret');await remote.page.waitForFunction(()=>document.getElementById('password').value==='fixture-only-secret');
  assert.equal(await input.inputValue(),'','typed text is immediately cleared in viewer');
  await remote.page.evaluate(()=>fetch('https://www.coupang.com/api/cart',{method:'POST',body:'not-a-real-purchase'}).catch(()=>{}));assert.equal(unexpected,0,'purchase mutation never reaches network');
  await input.press('Enter');await viewer.locator('#status').filter({hasText:'로그인 확인 완료'}).waitFor({timeout:20000});assert(ready);
  await viewer.locator('#close').click();await p.waitForFunction(()=>!coupangWebDialog);assert.equal(await p.evaluate(()=>Object.values(S.orders).flat().length),0);assert.equal(writes,0);assert.deepEqual(errors,[]);
  assert(calls.includes('pair')&&calls.includes('remote_login'));console.log('WEB_LOGIN_MODAL_DEVICE_KEY_ENCRYPTED_IMAGE_INPUT_REAL_BROWSER_READY_MOBILE_NO_LEDGER_OK');
 }finally{await remote?.close();await browser.close();await rm(directory,{recursive:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
