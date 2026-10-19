// Read-only production verification. Never logs credentials, ciphertext, private values or provider responses.
const fs=require('node:fs'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const base='https://rycibsczsgbkgtwfxyim.supabase.co',pw=process.env.NMF_PW;
function decrypt(blob){const o=JSON.parse(blob),c=Buffer.from(o.ct,'base64'),key=crypto.pbkdf2Sync(pw,Buffer.from(o.salt,'base64'),150000,32,'sha256'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(o.iv,'base64'));d.setAuthTag(c.subarray(-16));const bytes=Buffer.concat([d.update(c.subarray(0,-16)),d.final()]);return JSON.parse((o.z?zlib.gunzipSync(bytes):bytes).toString());}
async function call(body,token){const raw=JSON.stringify(body),time=String(Date.now()),sig=crypto.createHmac('sha256',pw).update('nmf-access\n'+time+'\n'+raw).digest('base64');return fetch(base+'/functions/v1/nmf-access',{method:'POST',headers:{'content-type':'application/json','x-nmf-time':time,'x-nmf-signature':sig,...(token?{'x-nmf-admin-session':token}:{})},body:raw,signal:AbortSignal.timeout(30000)});}
(async()=>{
  if(!pw)throw Error('NMF_PW required');
  let token='';if(process.env.NMF_READ_ADMIN_STDIN==='1'){
    const admin=await new Promise(resolve=>{process.stdin.once('data',v=>resolve(v.toString().trim()));process.stdin.resume();});
    const r=await call({action:'login',password:admin});assert.equal(r.status,200,'live admin login');const j=await r.json();token=j.token;assert(j.cacheKey?.length>=32);
    process.stdin.pause();
  }
  let roots=0,ticketFields=0;for(const room of ['namofood','namocafe','namostore']){
    const r=await call({action:'rest',method:'GET',path:'/rest/v1/namofood_state?id=eq.'+room});assert.equal(r.status,200,'guest state');const rows=await r.json();assert(rows[0]?.source_revision);const guest=decrypt(rows[0].data);
    for(const field of ['purch','cardTransactions','staffDeductions'])assert(!Object.hasOwn(guest,field),'guest leaked '+field);
    assert(guest.orders&&guest.prices,'procurement data is operational');for(const records of Object.values(guest.staffPayments||{}))for(const record of Object.values(records))for(const field of ['amount','gross','fingerprint'])assert(!Object.hasOwn(record,field),'private payroll field');
    for(const row of [...Object.values(guest.storeProducts||{}),...Object.values(guest.storeSales||{}),...Object.values(guest.storeStockImports||{})])for(const field of ['cost','amt','unitPrice','total','vat','vendor','supplyAmount'])assert(!Object.hasOwn(row,field),'guest private monetary field '+field);
    for(const row of Object.values(guest.storeStockImports||{}))assert(!Object.hasOwn(row,'price'),'stock costs stay private');
    for(const person of [...guest.staff,...guest.staffArchive])for(const field of ['wage','bonus','phone','bank','account'])assert(!Object.hasOwn(person,field),'guest staff '+field);
    assert(!Object.hasOwn(guest.settings,'fixed'));assert(!Object.hasOwn(guest.settings,'wage'));roots++;
    const privateRead=await call({action:'rest',method:'GET',path:'/rest/v1/namofood_state?id=eq.'+encodeURIComponent(room+'#fixed-documents')});assert.equal(privateRead.status,403,'private docs denied');
    const backup=await call({action:'rest',method:'GET',path:'/rest/v1/namofood_state?id=like.'+encodeURIComponent(room+'@%')});assert.equal(backup.status,403,'backup denied');
    if(token){const full=await call({action:'rest',method:'GET',path:'/rest/v1/namofood_state?id=eq.'+room},token);assert.equal(full.status,200);const [row]=await full.json(),state=decrypt(row.data);assert(state.settings);for(const [month,cells]of Object.entries(state.sales||{}))for(const [key,value]of Object.entries(cells))if(/^\d+\|(?:ticketIssued|ticketIssuePrice|ticketBuyer|ticketCompany)/.test(key)){assert.deepEqual(guest.sales?.[month]?.[key],value,'existing company ticket transaction must be identical in guest/admin');ticketFields++;}}
  }
  for(const endpoint of ['nmf-tax-auto','nmf-payment-match']){const r=await fetch(base+'/functions/v1/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'status'})});assert.equal(r.status,403,endpoint+' rejects guest');}
  for(const documentType of ['invoice','spreadsheet','card']){const raw=JSON.stringify({action:'status',app:'food',documentType,nonce:crypto.randomUUID()}),time=String(Date.now()),digest=crypto.createHash('sha256').update(raw).digest('hex'),signature=crypto.createHmac('sha256',pw).update('nmf-invoice:'+digest+':'+time).digest('hex');const r=await fetch(base+'/functions/v1/nmf-invoice-ocr',{method:'POST',headers:{'content-type':'application/json','x-nmf-time':time,'x-nmf-signature':signature},body:raw});assert.equal(r.status,documentType==='card'?403:200,'guest '+documentType+' OCR permission');}
  if(process.env.NMF_EXPECT_LOCKED==='1'){
    const source=fs.readFileSync('나모푸드_관리앱.html','utf8'),key=source.match(/const SUPA_DEFAULT = \{url:"[^"]+", key:"([^"]+)"/)[1];
    for(const id of ['namofood','namofood@2026-10-19','namofood#fixed-documents']){const r=await fetch(base+'/rest/v1/namofood_state?id=eq.'+encodeURIComponent(id)+'&select=data',{headers:{apikey:key,Authorization:'Bearer '+key}});assert.equal(r.status,401,'anonymous direct database access denied');const error=await r.json();assert.equal(error.code,'42501');assert.match(error.message,/permission denied for table namofood_state/);}
  }
  console.log(JSON.stringify({roots,adminRead:!!token,companyTicketFieldsVerified:ticketFields,guestProjection:true,privateDocumentsDenied:true,backupsDenied:true,financialEndpointsDenied:true,legacyApiLocked:process.env.NMF_EXPECT_LOCKED==='1',ledgerWrites:0,providerCalls:0}));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
