// Pure app functions: no network, real files, or business-state writes.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'..','나모푸드_관리앱.html'),'utf8');
const ctx={structuredClone,console,Date,Set,Map,JSON,Number,String,Math,invoiceNumber:v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v),invoiceValidDate:v=>/^20\d{2}-\d{2}-\d{2}$/.test(v),invoiceFinancial:o=>!o.ocrMeta?.referenceOnly&&!o.ocrMeta?.duplicateReviewPending,markOrder(o,deleted=false,origin='manual'){ctx.S.orderEdits[o.id]={at:new Date().toISOString(),deleted,origin};},orderRef:id=>{for(const [month,rows]of Object.entries(ctx.S.orders))for(let index=0;index<rows.length;index++)if(rows[index].id===id)return {month,index,order:rows[index]};}};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function invoiceTextKey('),source.indexOf('function invoiceComparisonHtml(')),ctx);
const fixture=()=>({id:'old',date:'2026-10-12',vendor:'Test supplier',invoiceNo:'T-100',subtotal:3000,tax:300,total:3300,previousBalance:null,balanceTotal:null,items:[{name:'Onion',spec:'1kg',unit:'bag',qty:1,price:1100,supplyAmount:1000,tax:100,amt:1100},{name:'Carrot',spec:'2kg',unit:'bag',qty:1,price:2200,supplyAmount:2000,tax:200,amt:2200}],ocrMeta:{registeredAt:'2026-10-19T01:00:00Z'}});
assert.equal(typeof ctx.invoiceDuplicateAudit,'function','full-row verification must exist');
const left=fixture(),right=fixture();right.items.reverse();
assert(ctx.invoiceDuplicateAudit(left,right).same);
assert(ctx.invoiceDuplicateAudit(left,right).automatic);
for(const key of ['name','spec','unit','qty','price','supplyAmount','tax','amt']){
 const different=fixture();different.items[0][key]=typeof different.items[0][key]==='number'?different.items[0][key]+1:different.items[0][key]+' changed';
 assert(!ctx.invoiceDuplicateAudit(left,different).same,'every row field checked: '+key);
}
const repeated=fixture();repeated.items=[structuredClone(left.items[0]),structuredClone(left.items[0])];
assert(!ctx.invoiceDuplicateAudit(left,repeated).same,'a matching row cannot be counted twice');
for(const key of ['date','vendor','invoiceNo','subtotal','tax','total','previousBalance','balanceTotal']){
 const different=fixture();different[key]=typeof different[key]==='number'?different[key]+1:'different';
 assert(!ctx.invoiceDuplicateAudit(left,different).same,'header field checked: '+key);
}
for(const key of ['qty','price','supplyAmount','tax','amt']){
 const a=fixture(),b=fixture();a.items[0][key]=b.items[0][key]=null;
 assert(ctx.invoiceDuplicateAudit(a,b).same,'matching blanks are shown as matching but incomplete');
 assert(!ctx.invoiceDuplicateAudit(a,b).automatic,'blank must never prove automatic replacement: '+key);
}
const unnumbered=fixture();unnumbered.invoiceNo='';assert(!ctx.invoiceDuplicateAudit(unnumbered,unnumbered).automatic);
ctx.S={orders:{'2026-10':[left,{...fixture(),id:'latest',ocrMeta:{registeredAt:'2026-10-20T01:00:00Z'}}]},orderEdits:{}};
vm.runInContext(source.slice(source.indexOf('function invoiceArchiveDuplicates('),source.indexOf('async function invoiceReviewDocument(')),ctx);
const latest=ctx.S.orders['2026-10'][1],oldSnapshot=structuredClone(left);
ctx.invoiceArchiveDuplicates(latest,[left],true);
assert.equal(ctx.S.orders['2026-10'].filter(ctx.invoiceFinancial).length,1);
assert.equal(ctx.S.orders['2026-10'].filter(ctx.invoiceFinancial)[0].id,'latest');
assert.equal(left.ocrMeta.referenceOnly,true);
assert.equal(left.ocrMeta.supersededById,'latest');
assert.deepEqual(left.items,oldSnapshot.items);
assert.deepEqual(left.invoicePhoto,oldSnapshot.invoicePhoto);
assert.equal(left.total,oldSnapshot.total);
assert.equal(left.ocrMeta.balanceEvidence,false);
assert.equal(latest.ocrMeta.supersedesIds[0],'old');
const wrong=fixture();wrong.id='wrong';wrong.items[0].qty=99;
assert.throws(()=>ctx.invoiceArchiveDuplicates(latest,[wrong],true),/동일/);
console.log('INVOICE_ALL_ROWS_FIELDS_MULTISET_BLANK_ZERO_LATEST_ARCHIVE_ORIGINALS_SINGLE_TOTAL_OK');
