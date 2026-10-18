// Browser + Node WebCrypto only. No credentials, screenshots or input are persisted.
const enc=new TextEncoder(),dec=new TextDecoder();
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const b64=bytes=>btoa(Array.from(new Uint8Array(bytes),b=>String.fromCharCode(b)).join(''));
const bytes=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export function publicKey(jwk){
  if(!jwk||jwk.kty!=='EC'||jwk.crv!=='P-256'||!/[A-Za-z0-9_-]{43}/.test(jwk.x||'')||!/[A-Za-z0-9_-]{43}/.test(jwk.y||'')||jwk.x.length!==43||jwk.y.length!==43||jwk.d)throw Error('invalid_device');
  return {kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,ext:true};
}
export async function generateDevice(){
  const keys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  return {id:crypto.randomUUID(),privateKey:keys.privateKey,publicKey:publicKey(await crypto.subtle.exportKey('jwk',keys.publicKey))};
}
export async function fingerprint(device){
  if(!UUID.test(device?.id||''))throw Error('invalid_device');
  const hash=await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify({id:device.id,key:publicKey(device.publicKey)})));
  return Array.from(new Uint8Array(hash).slice(0,5),b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
}
export async function cipher(privateKey,jwk,sessionId,role){
  if(!UUID.test(sessionId)||!['viewer','worker'].includes(role))throw Error('invalid_session');
  const peer=await crypto.subtle.importKey('jwk',publicKey(jwk),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:peer},privateKey,256);
  const material=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode(sessionId),info:enc.encode('nmf-coupang-login-v1')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  let sent=0,received=0;
  const aad=(side,seq)=>enc.encode(`nmf-coupang-login-v1:${sessionId}:${side}:${seq}`);
  return {
    async seal(data){const seq=++sent,iv=crypto.getRandomValues(new Uint8Array(12));const raw=enc.encode(JSON.stringify(data));if(raw.length>160000)throw Error('packet_too_large');const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(role,seq)},key,raw);return {seq,side:role,iv:b64(iv),ct:b64(ct)};},
    async open(packet){
      if(!packet||packet.side===(role)||!['viewer','worker'].includes(packet.side)||!Number.isSafeInteger(packet.seq)||packet.seq<=received||typeof packet.ct!=='string'||packet.ct.length>220000||typeof packet.iv!=='string'||packet.iv.length!==16)throw Error('invalid_packet');
      const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(packet.iv),additionalData:aad(packet.side,packet.seq)},key,bytes(packet.ct));
      const data=JSON.parse(dec.decode(raw));received=packet.seq;return data;
    },
  };
}
export async function realtime({url,key,topic,onPacket,onClose=()=>{},Socket=WebSocket}){
  if(!/^wss:\/\/[a-z0-9]+\.supabase\.co\/realtime\/v1\/websocket$/.test(url)||!/^nmf-login-[a-f0-9]{64}$/.test(topic)||typeof key!=='string'||key.length>1500)throw Error('invalid_relay');
  const ws=new Socket(url+'?apikey='+encodeURIComponent(key)+'&vsn=1.0.0'),name='realtime:'+topic;let ref=1,timer,done=false;
  const send=(event,payload,target=name)=>{if(ws.readyState!==1)throw Error('relay_disconnected');ws.send(JSON.stringify({topic:target,event,payload,ref:String(++ref),join_ref:target===name?'1':undefined}));};
  try{await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{ws.close();reject(Error('relay_timeout'));},15000);
    ws.onopen=()=>ws.send(JSON.stringify({topic:name,event:'phx_join',ref:'1',join_ref:'1',payload:{config:{broadcast:{self:false,ack:false},presence:{enabled:false},private:false},access_token:key}}));
    ws.onerror=()=>{clearTimeout(timeout);reject(Error('relay_network_error'));};
    ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.event==='phx_reply'&&m.ref==='1'){clearTimeout(timeout);m.payload?.status==='ok'?resolve():reject(Error('relay_denied'));}}catch{reject(Error('invalid_relay'));}};
    ws.onclose=()=>{clearTimeout(timeout);reject(Error('relay_disconnected'));};
  });}catch(error){ws.close();throw error;}
  ws.onmessage=e=>{try{if(typeof e.data!=='string'||e.data.length>225000)return;const m=JSON.parse(e.data);if(m.topic===name&&m.event==='broadcast'&&m.payload?.event==='encrypted-packet')onPacket(m.payload.payload);}catch{}};
  ws.onclose=()=>{clearInterval(timer);if(!done)onClose();};
  ws.onerror=()=>{clearInterval(timer);if(!done)onClose();};
  timer=setInterval(()=>{try{send('heartbeat',{},'phoenix');}catch{ws.close();}},20000);
  return {send:packet=>send('broadcast',{type:'broadcast',event:'encrypted-packet',payload:packet}),close(){done=true;clearInterval(timer);ws.close();}};
}
export function allowedNavigation(value){try{const u=new URL(value);return u.protocol==='https:'&&((u.hostname==='login.coupang.com'&&u.pathname.startsWith('/login/'))||(u.hostname==='www.coupang.com'&&u.pathname==='/')||(u.hostname==='mc.coupang.com'&&u.pathname==='/ssr/desktop/order/list'));}catch{return false;}}
export function validInput(data,width,height){
  if(!data||typeof data!=='object')return false;
  if(['hello','alive','refresh','close','verify'].includes(data.type))return true;
  if(data.type==='click')return Number.isFinite(data.x)&&Number.isFinite(data.y)&&data.x>=0&&data.y>=0&&data.x<width&&data.y<height;
  if(data.type==='text')return typeof data.text==='string'&&data.text.length>0&&data.text.length<=256&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.text);
  if(data.type==='fill')return UUID.test(data.focusId||'')&&UUID.test(data.id||'')&&typeof data.text==='string'&&data.text.length<=256&&!/[\u0000-\u001f\u007f]/.test(data.text);
  if(data.type==='key')return ['Backspace','Delete','Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Escape','ControlOrMeta+A'].includes(data.key);
  if(data.type==='scroll')return Number.isFinite(data.dy)&&Math.abs(data.dy)<=700;
  return false;
}
