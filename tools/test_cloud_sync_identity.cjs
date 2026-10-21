// Encrypted guest/admin app, synthetic backend only. Never contacts production.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict'),{chromium}=require('playwright');
require('../assets/access-policy.js');
const password='sync-identity-test-password',adminPassword='sync-identity-test-admin';
function encrypt(state){const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=crypto.pbkdf2Sync(password,salt,150000,32,'sha256'),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(state)))),cipher.final(),cipher.getAuthTag()]);return JSON.stringify({v:2,z:1,iter:150000,salt:salt.toString('base64'),iv:iv.toString('base64'),ct:data.toString('base64')});}
function decrypt(blob){const o=JSON.parse(blob),bytes=Buffer.from(o.ct,'base64'),key=crypto.pbkdf2Sync(password,Buffer.from(o.salt,'base64'),150000,32,'sha256'),decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(o.iv,'base64'));decipher.setAuthTag(bytes.subarray(-16));const data=Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]);return JSON.parse((o.z?zlib.gunzipSync(data):data).toString());}
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nmf-sync-identity-'));let browser;
 try{
  cp.execFileSync('/Users/donggeonbae/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',['encrypt_app.py','나모푸드_관리앱.html',dir,password],{stdio:'pipe'});
  const loader=fs.readFileSync(path.join(dir,'index.html'),'utf8'),version=JSON.parse(fs.readFileSync(path.join(dir,'ver.json'),'utf8')).v;
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  let state,cipher,at='2026-10-21T08:00:00.000Z',revisionMode='failed',reads=0,writes=0,backups=0,held=null,omitRevision=false;
  const errors=[],pages=[];
  for(let i=0;i<2;i++){
   const context=await browser.newContext(),p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));pages.push(p);
   await p.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),password);
   await p.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url());if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:loader});
    if(u.pathname.endsWith('/ver.json'))return route.fulfill({json:{v:version}});
    if(!u.pathname.endsWith('/nmf-access'))return route.abort();
    const body=r.postDataJSON(),admin=r.headers()['x-nmf-admin-session']==='test-admin-token';
    if(body.action==='login')return route.fulfill({json:{token:'test-admin-token',expiresAt:Date.now()+3600000,cacheKey:'test-private-cache-key-32-characters-long'}});
    if(body.action!=='rest')return route.abort();
    if(body.path.includes('/rpc/'))return route.fulfill(revisionMode==='failed'?{status:503,json:{error:'metadata_unavailable'}}:{json:[{updated_at:at,revision:digest(cipher)}]});
    const id=new URL(body.path,'https://test').searchParams.get('id')||'';
    if(body.method==='GET'){
     if(!state){state=await p.evaluate(()=>{const s=normalize(defaultState());s.month='2026-10';s.sales={'2026-10':{'1|other':100}};s.salesEdits={};s.recipeResolutions={};s.staff=[];s.staffArchive=[];s.roster={};s.syncFixture={items:[1,2],name:'keep-business-data'};return s;});cipher=encrypt(state);}
     reads++;const row={data:admin?cipher:encrypt(globalThis.NmfAccessPolicy.project(state)),updated_at:at,...(omitRevision?{}:{source_revision:digest(cipher)})};
     const delay=held;held=null;if(delay){delay.started();await delay.wait;}
     return route.fulfill({json:[row]});
    }
    if(body.method==='PATCH'){
     assert.equal(new URL(body.path,'https://test').searchParams.get('updated_at'),'eq.'+at,'CAS preserved');
     const incoming=decrypt(body.body.data);state=admin?incoming:globalThis.NmfAccessPolicy.mergeGuest(state,incoming);cipher=encrypt(state);at=body.body.updated_at;writes++;
     return route.fulfill({json:[{id:'namofood',updated_at:at}]});
    }
    assert(id.startsWith('eq.namofood@')||body.body?.[0]?.id?.startsWith('namofood@'),'only dated fixture backups');backups++;return route.fulfill({json:[]});
   });
   await p.goto('https://sync-identity.test/?v='+version);await p.waitForSelector('#appver',{state:'attached'});await p.waitForFunction(()=>!!cloudRemoteAt);
   await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudDirty=false;cloudBusy=false;lastInputAt=0;window.__syncNotices=[];const old=toast;toast=t=>{__syncNotices.push(t);old(t);};});
  }
  const [a,b]=pages,stop=p=>p.evaluate(()=>{clearTimeout(cloudTimer);clearTimeout(saveTimer);lastInputAt=0;});
  const poll=async p=>{await stop(p);return p.evaluate(()=>cloudLoad(true));};
  const baseline=JSON.stringify(state);
  // A failed metadata endpoint must not turn randomized guest ciphertext into changes.
  for(let i=0;i<3;i++)assert.equal(await poll(a),false,'same guest data must not be re-applied');
  assert.equal(await a.evaluate(()=>__syncNotices.filter(t=>t.includes('다른 기기')).length),0);
  assert.equal(writes,0);assert.equal(JSON.stringify(state),baseline,'no-op reads never rewrite the source');
  // Old servers without a revision still need plaintext/order-insensitive fallback.
  omitRevision=true;for(let i=0;i<2;i++)assert.equal(await poll(a),false);omitRevision=false;
  state={...state,updatedAt:'2026-10-21T08:00:01.000Z'};cipher=encrypt(state);at='2026-10-21T08:00:01.000Z';assert.equal(await poll(a),false,'timestamp-only save is not a business edit');
  state.sales['2026-10']['1|other']=200;state.salesEdits={'2026-10':{'1|other':{at:'2026-10-21T08:00:02.000Z'}}};cipher=encrypt(state);at='2026-10-21T08:00:02.000Z';
  assert(await poll(a));assert.equal(await a.evaluate(()=>salesGet(1,'other','2026-10')),200);assert.equal(await poll(a),false);
  // A slow response must not advance the applied revision before the response is accepted.
  revisionMode='healthy';await b.evaluate(()=>{cloudRemoteAt=null;cloudRemoteData=null;});assert(await poll(b));
  state.sales['2026-10']['1|other']=300;state.salesEdits['2026-10']['1|other']={at:'2026-10-21T08:00:03.000Z'};cipher=encrypt(state); // deliberately same timestamp
  let release,started;const waiting=new Promise(r=>started=r);held={started,wait:new Promise(r=>release=r)};
  const pending=b.evaluate(()=>cloudLoad(true));await waiting;await b.evaluate(()=>{cloudInputRevision++;});release();assert.equal(await pending,false);assert(await poll(b),'deferred same-time real edit remains discoverable');assert.equal(await b.evaluate(()=>salesGet(1,'other','2026-10')),300);
  // An uncommitted input remains intact after an idle pause while another PC edits.
  await a.evaluate(()=>{const input=document.createElement('input');input.id='sync-uncommitted';input.value='before';main.append(input);input.focus();});
  await a.locator('#sync-uncommitted').fill('typed but not committed');await a.evaluate(()=>{lastInputAt=0;});
  state.sales['2026-10']['1|other']=400;state.salesEdits['2026-10']['1|other']={at:'2026-10-21T08:00:04.000Z'};cipher=encrypt(state);at='2026-10-21T08:00:04.000Z';
  assert.equal(await a.evaluate(()=>cloudLoad(true)),false);assert.equal(await a.locator('#sync-uncommitted').inputValue(),'typed but not committed');
  await a.locator('#sync-uncommitted').dispatchEvent('change');await a.locator('#sync-uncommitted').evaluate(e=>e.blur());assert(await poll(a));assert.equal(await a.evaluate(()=>salesGet(1,'other','2026-10')),400);
  // A guest's saved normalized defaults differ from its projected wire response.
  await poll(b);await b.evaluate(()=>{__syncNotices=[];salesSet(1,'other',450,'2026-10');clearTimeout(saveTimer);clearTimeout(cloudTimer);});await b.evaluate(()=>cloudSave(true));await stop(b);
  assert.equal(state.sales['2026-10']['1|other'],450);assert.equal(await poll(b),false,'guest own save is compared in the public view, not against private defaults');assert.equal(await b.evaluate(()=>__syncNotices.filter(t=>t.includes('다른 기기')).length),0);
  assert(await poll(a));assert.equal(await a.evaluate(()=>salesGet(1,'other','2026-10')),450);
  // Administrator save gets re-encrypted by the backend: the next poll is not a peer edit.
  await a.locator('#admin-password').fill(adminPassword);await a.locator('#admin-form button').click();await a.locator('#admin-lock').waitFor();
  await a.evaluate(()=>{__syncNotices=[];salesSet(1,'other',500,'2026-10');clearTimeout(saveTimer);clearTimeout(cloudTimer);});await a.evaluate(()=>cloudSave(true));await stop(a);
  assert.equal(state.sales['2026-10']['1|other'],500);assert.equal(await poll(a),false,'own save acknowledgement does not re-apply data');assert.equal(await a.evaluate(()=>__syncNotices.filter(t=>t.includes('다른 기기')).length),0);
  assert(await poll(b));assert.equal(await b.evaluate(()=>salesGet(1,'other','2026-10')),500);assert.equal(await poll(b),false,'other PC applies an actual edit exactly once');
  assert.deepEqual(state.syncFixture,{items:[1,2],name:'keep-business-data'});assert.equal(writes,2);assert(backups>=1);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({suite:'CLOUD_SYNC_STABLE_REVISION_RANDOM_CIPHER_METADATA_FAILURE_PLAINTEXT_FALLBACK_INPUT_DRAFT_RACE_SELF_SAVE_TWO_CLIENT_EDIT_ONCE',reads,writes,backups,productionRequests:0,passed:true}));
 }finally{if(browser)await browser.close();fs.rmSync(dir,{recursive:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
