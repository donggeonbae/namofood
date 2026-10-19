// Operator-only, read-only by default. Password is supplied through NMF_PW.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'나모푸드_관리앱.html'),'utf8');
const cfg=vm.runInNewContext('('+source.match(/const SUPA_DEFAULT = (\{[^\n]+\});/)[1]+')',{APP:'food'});
const headers={apikey:cfg.key,Authorization:'Bearer '+cfg.key};
async function decrypt(data){const o=JSON.parse(data),key=crypto.pbkdf2Sync(process.env.NMF_PW,Buffer.from(o.salt,'base64'),150000,32,'sha256'),bytes=Buffer.from(o.ct,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(o.iv,'base64'));d.setAuthTag(bytes.subarray(-16));let plain=Buffer.concat([d.update(bytes.subarray(0,-16)),d.final()]);if(o.z)plain=zlib.gunzipSync(plain);return JSON.parse(plain.toString());}
async function read(id){const r=await fetch(cfg.url+'/rest/v1/'+cfg.table+'?id=eq.'+encodeURIComponent(id)+'&select=id,data,updated_at',{headers});if(!r.ok)throw Error('Read HTTP '+r.status);const rows=await r.json();if(rows.length!==1)throw Error('Expected exactly one row: '+id);return {row:rows[0],state:await decrypt(rows[0].data)};}
async function main(){
 if(!process.env.NMF_PW)throw Error('NMF_PW required');
 const {row,state}=await read('namofood'),num=v=>v==null||v===''?null:Number(String(v).replaceAll(',',''));
 const orders=Object.values(state.orders||{}).flat().filter(o=>!state.orderEdits?.[o.id]?.deleted);
 const target=orders.find(o=>o.date==='2026-10-17'&&o.items?.length===46&&(num(o.total)===3122900||o.items.reduce((n,x)=>n+(num(x.amt)||0),0)===3122900));
 console.log(JSON.stringify({updatedAt:row.updated_at,count:orders.length,target:target?{...target,invoicePhoto:target.invoicePhoto,invoiceFile:target.invoiceFile}:null,suspects:orders.filter(o=>!o.vendor||!o.date||o.balanceTotal==null||o.items?.some(x=>num(x.amt)===null)||num(o.total)!==o.items?.reduce((s,x)=>s+(num(x.amt)||0),0)).map(o=>({id:o.id,date:o.date,vendor:o.vendor,total:o.total,balance:o.balanceTotal,previous:o.previousBalance,items:o.items?.length,sum:o.items?.reduce((s,x)=>s+(num(x.amt)||0),0),missing:o.items?.filter(x=>num(x.amt)===null).length,photo:!!o.invoicePhoto,file:!!o.invoiceFile,review:o.ocrMeta?.labelReview}))},null,2));
 if(process.env.NMF_AUDIT_ORIGINALS==='1'){
  const dir=fs.mkdtempSync('/tmp/nmf-invoice-audit-');fs.chmodSync(dir,0o700);
  fs.writeFileSync(path.join(dir,'namofood.encrypted.json'),JSON.stringify(row),{mode:0o600});
  for(const o of orders.filter(o=>!o.vendor||num(o.total)!==o.items?.reduce((s,x)=>s+(num(x.amt)||0),0))){
   for(const [field,kind] of [['invoicePhoto','photo'],['invoiceFile','file']]){const meta=o[field];if(!meta?.hash)continue;const {state:payload}=await read('namofood#invoice-'+kind+'#'+meta.hash),bytes=Buffer.from(payload.bytes,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==meta.hash||bytes.length!==meta.size)throw Error('Attachment integrity failure');const ext=kind==='photo'?'.jpg':path.extname(meta.name||'')||'.bin',out=path.join(dir,String(o.id).replace(/[^a-zA-Z0-9_-]/g,'_')+ext);fs.writeFileSync(out,bytes,{mode:0o600});console.log(JSON.stringify({original:out,id:o.id,date:o.date,vendor:o.vendor}));}
  }console.log(JSON.stringify({backupDir:dir}));
 }
}
module.exports={read,decrypt,headers,cfg};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
