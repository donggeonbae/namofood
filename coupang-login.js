import {generateDevice,fingerprint,cipher,realtime} from './connectors/coupang/remote-protocol.mjs?v=1019-3-web-login';
const $=id=>document.getElementById(id),pending=new Map();let device,busy=false,peer,crypt,alive,expiry,closed=false,state='',generation=0,sendChain=Promise.resolve(),receiveChain=Promise.resolve();
const status=text=>$('status').textContent=text;
const error=e=>{$('error').textContent=typeof e==='string'?e:'연결하지 못했습니다. 웹앱에서 다시 열어 주세요.';};
const source=window.parent===window?window.opener:window.parent;
function api(action,extra={}){
 return new Promise((resolve,reject)=>{if(!source)return reject(Error('발주 집계의 쿠팡 로그인 버튼으로 열어 주세요.'));const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('웹앱 응답이 지연됩니다. 다시 열어 주세요.'));},25000);pending.set(id,{resolve,reject,timer});source.postMessage({type:'nmf-coupang-login-api',id,action,extra},location.origin);});
}
window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==source)return;
 if(event.data?.type==='nmf-coupang-login-close'){shutdown();return;}
 const message=event.data;if(message?.type!=='nmf-coupang-login-result')return;const p=pending.get(message.id);if(!p)return;clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(Error(message.error)):p.resolve(message.data);
});
async function storage(mode,operation){
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('nmf-coupang-login-device',1);r.onupgradeneeded=()=>r.result.createObjectStore('device');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('기기 보관함을 열 수 없습니다. 비공개 모드가 아닌 브라우저를 사용해 주세요.'));});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('device',mode),r=operation(tx.objectStore('device'));let result;r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(Error('승인 정보를 저장하지 못했습니다.'));tx.onabort=()=>reject(Error('승인 정보 저장이 취소됐습니다.'));});}finally{db.close();}
}
async function poll(id,seconds){
 const deadline=Date.now()+seconds*1000;
 while(!closed&&Date.now()<deadline){const r=await api('result',{jobId:id}),job=r.job;if(!job)throw Error('로그인 요청이 만료됐습니다.');if(job.status==='done')return job.result;if(job.status==='error')throw Error('로그인 연결 실패. 맥미니 연결 상태를 확인해 주세요.');await new Promise(resolve=>setTimeout(resolve,1500));}
 throw Error('승인 또는 연결 대기 시간이 지났습니다. 다시 시도해 주세요.');
}
async function send(data,gen=generation){if(!peer||!crypt||closed||gen!==generation)return;sendChain=sendChain.then(async()=>{const p=peer,key=crypt;if(!p||!key||gen!==generation)return;const packet=await key.seal(data);if(p===peer&&gen===generation)p.send(packet);}).catch(()=>{});return sendChain;}
function stopConnection(){generation++;clearInterval(alive);clearTimeout(expiry);peer?.close();peer=null;crypt=null;$('verify').hidden=true;$('show-keyboard').hidden=true;$('screen-box').hidden=true;$('screen').removeAttribute('src');}
async function shutdown(){await send({type:'close'});closed=true;stopConnection();source?.postMessage({type:'nmf-coupang-login-dismiss'},location.origin);}
async function start(){
 if(busy||peer)return;const gen=++generation;busy=true;state='';$('start').disabled=true;$('error').textContent='';
 try{
  if(!device.certificate||device.certificate.expires<=Date.now()){
   $('pair-info').hidden=false;$('code').textContent=await fingerprint(device);status('맥미니에서 이 기기의 최초 승인을 기다립니다…');
   const request=await api('pair',{device:{id:device.id,publicKey:device.publicKey}}),result=await poll(request.jobId,145);
   if(closed||gen!==generation)return;
   if(!result?.certificate)throw Error('맥미니에서 등록이 거절됐거나 대기 시간이 지났습니다.');
   device.certificate=result.certificate;await storage('readwrite',store=>store.put(device,'current'));$('pair-info').hidden=true;
  }
  if(closed||gen!==generation)return;
  status('쿠팡 공식 로그인 화면을 연결합니다…');
  const request=await api('remote_login',{certificate:device.certificate,width:innerWidth<600?390:980}),result=await poll(request.jobId,70),session=result?.session;
  if(closed||gen!==generation)return;
  if(!session||session.expires<=Date.now())throw Error('로그인 연결이 만료됐습니다. 다시 열어 주세요.');
  crypt=await cipher(device.privateKey,session.publicKey,session.id,'viewer');
  if(closed||gen!==generation)return;
  peer=await realtime({...result.relay,topic:session.topic,onPacket:packet=>{
   receiveChain=receiveChain.then(async()=>{if(gen!==generation||!crypt)return;const data=await crypt.open(packet);if(gen!==generation)return;
    if(data.type==='frame'&&typeof data.image==='string'&&data.image.length<=150000&&/^[A-Za-z0-9+/]+=*$/.test(data.image)){$('screen').src='data:image/jpeg;base64,'+data.image;$('screen-box').hidden=false;}
    if(data.type==='state'){
     state=data.status;status(String(data.message||'').slice(0,250));
     if(state==='ready'){stopConnection();$('start').disabled=false;$('start').textContent='다시 로그인 화면 열기';}
     if(state==='blocked'){stopConnection();$('start').disabled=false;error('쿠팡에서 접근을 제한했습니다. 잠시 후 다시 시도하세요.');}
    }
   }).catch(()=>{});
  },onClose:()=>{receiveChain.finally(()=>{if(gen===generation&&state!=='ready'&&!closed){stopConnection();status('실시간 연결이 종료됐습니다. 다시 열 수 있습니다.');$('start').disabled=false;}});}});
  $('verify').hidden=false;$('show-keyboard').hidden=false;await send({type:'hello'});
  alive=setInterval(()=>send({type:'alive'},gen),5000);
  expiry=setTimeout(()=>{if(gen!==generation)return;send({type:'close'},gen).finally(()=>{if(gen===generation){stopConnection();status('5분 제한 시간이 끝났습니다. 다시 열어 주세요.');$('start').disabled=false;}});},Math.max(0,session.expires-Date.now()));
 }catch(e){if(!closed&&gen===generation){stopConnection();error(e.message);$('start').disabled=false;}}
 finally{busy=false;}
}
$('start').onclick=start;$('close').onclick=shutdown;$('verify').onclick=()=>send({type:'verify'});
$('forget').onclick=async()=>{await send({type:'close'});stopConnection();await storage('readwrite',store=>store.delete('current'));device=await generateDevice();await storage('readwrite',store=>store.put(device,'current'));status('이 기기의 승인 정보를 지웠습니다. 다음 연결에는 맥미니 승인이 필요합니다.');$('start').disabled=false;};
const keyboard=$('keyboard');$('show-keyboard').onclick=()=>keyboard.focus({preventScroll:true});
$('screen').onpointerdown=event=>{if(!peer)return;event.preventDefault();const rect=event.currentTarget.getBoundingClientRect(),image=event.currentTarget;send({type:'click',x:(event.clientX-rect.left)*image.naturalWidth/rect.width,y:(event.clientY-rect.top)*image.naturalHeight/rect.height});keyboard.focus({preventScroll:true});};
$('screen').onwheel=event=>{if(peer){event.preventDefault();send({type:'scroll',dy:Math.max(-700,Math.min(700,event.deltaY))});}};
keyboard.addEventListener('keydown',event=>{
 if(!peer||event.isComposing)return;
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();send({type:'key',key:'ControlOrMeta+A'});return;}
 if(['Backspace','Delete','Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Escape'].includes(event.key)){event.preventDefault();send({type:'key',key:event.key});}
});
keyboard.addEventListener('input',event=>{if(event.isComposing)return;const text=keyboard.value;keyboard.value='';if(text)send({type:'text',text:text.slice(0,256)});});
keyboard.addEventListener('paste',event=>{const text=event.clipboardData?.getData('text');if(text){event.preventDefault();keyboard.value='';send({type:'text',text:text.slice(0,256)});}});
addEventListener('pagehide',()=>{send({type:'close'});stopConnection();});
(async()=>{try{device=await storage('readonly',store=>store.get('current'));if(!device?.privateKey){device=await generateDevice();await storage('readwrite',store=>store.put(device,'current'));}status(device.certificate?.expires>Date.now()?'이 기기는 승인돼 있습니다. 로그인 화면을 열 수 있습니다.':'이 기기는 최초 1회 맥미니 승인이 필요합니다.');$('start').disabled=false;await start();}catch(e){error(e.message);}})();
