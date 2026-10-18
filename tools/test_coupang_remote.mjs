import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {generateDevice,cipher,fingerprint,allowedNavigation,validInput} from '../connectors/coupang/remote-protocol.mjs';
import {approveDevice,locallyApproved,RemoteLogin} from '../connectors/coupang/remote.mjs';
test('remote login is end-to-end encrypted and rejects tampering/replay/other devices',async()=>{
 const viewer=await generateDevice(),worker=await generateDevice(),other=await generateDevice(),id=crypto.randomUUID();
 assert.equal(viewer.privateKey.extractable,false);assert.match(await fingerprint(viewer),/^[A-F0-9]{10}$/);
 const a=await cipher(viewer.privateKey,worker.publicKey,id,'viewer'),b=await cipher(worker.privateKey,viewer.publicKey,id,'worker'),wrong=await cipher(other.privateKey,worker.publicKey,id,'viewer');
 const packet=await a.seal({type:'text',text:'test-only-password'});assert(!JSON.stringify(packet).includes('test-only-password'));
 await assert.rejects(wrong.open(packet));assert.deepEqual(await b.open(packet),{type:'text',text:'test-only-password'});await assert.rejects(b.open(packet));
 const reply=await b.seal({type:'frame',image:'fake-jpeg'});assert.equal((await a.open(reply)).image,'fake-jpeg');await assert.rejects(a.open({...reply,seq:reply.seq+1}));
});
test('only explicit login pages and bounded input can be controlled',()=>{
 for(const url of ['https://login.coupang.com/login/login.pang','https://mc.coupang.com/ssr/desktop/order/list','https://www.coupang.com/'])assert(allowedNavigation(url));
 for(const url of ['https://login.coupang.com.evil.example/login/','http://login.coupang.com/login/login.pang','https://www.coupang.com/vp/products/123','https://example.com','file:///etc/passwd'])assert(!allowedNavigation(url));
 assert(validInput({type:'text',text:'test input'},980,760));assert(validInput({type:'click',x:10,y:20},980,760));
 for(const data of [{type:'eval',text:'document.cookie'},{type:'key',key:'Control+L'},{type:'text',text:'x'.repeat(257)},{type:'click',x:990,y:10},{type:'scroll',dy:900}])assert(!validInput(data,980,760));
});
test('server-issued metadata alone cannot authorize an unapproved local device',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nmf-login-device-')),device=await generateDevice();
 try{
  const remote=new RemoteLogin({},directory);await assert.rejects(remote.start({payload:{certificate:{device}}}),/unapproved_device/);
  assert.equal(await approveDevice(directory,device,async()=>false),false);assert.equal(await locallyApproved(directory,device),false);
  assert.equal(await approveDevice(directory,device,async code=>{assert.match(code,/^[A-F0-9]{10}$/);return true;}),true);
  assert.equal(await locallyApproved(directory,device),true);
  assert.equal(await locallyApproved(directory,await generateDevice()),false);
  const stored=await readFile(join(directory,'devices.json'),'utf8');assert(!stored.includes('privateKey'));assert(!stored.includes('password'));
 }finally{await rm(directory,{recursive:true});}
});
test('late encrypted frames and old close events cannot cross into a new login session',async()=>{
 const remote=new RemoteLogin({},'/unused');let resolve,oldSent=0,newSent=0;
 remote.generation=1;remote.active=true;remote.stopping=false;remote.sendChain=Promise.resolve();remote.crypto={seal:()=>new Promise(r=>{resolve=r;})};remote.relay={send:()=>oldSent++,close:()=>{}};
 const pending=remote.send({type:'frame',image:'old-session-only'},1);await new Promise(r=>setTimeout(r,0));
 await remote.close(1);remote.generation=3;remote.active=true;remote.stopping=false;remote.relay={send:()=>newSent++,close:()=>{}};
 resolve({ct:'old-ciphertext'});await pending;await remote.close(1);
 assert.equal(oldSent,0);assert.equal(newSent,0);assert.equal(remote.active,true,'old close must not terminate new session');
 await remote.close(3);
});
