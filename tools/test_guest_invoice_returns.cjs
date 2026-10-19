// The shared save boundary must preserve signed source amounts and originals.
// Isolated state only: no database, provider calls, or real business writes.
const assert=require('node:assert/strict');
require('../assets/access-policy.js');
const {project,mergeGuest}=globalThis.NmfAccessPolicy;
const hash='a'.repeat(64),at=new Date().toISOString();
const full={settings:{defaultBreakZeroInitialized:true,fixed:[['PRIVATE',500]]},staff:[],staffArchive:[],orders:{},orderEdits:{},cardTransactions:{private:true}};
function pending(){
 const s=project(full);
 s.orders={'2026-10':[{id:'returns-ledger',date:'2026-10-12',vendor:'Test supplier',total:9000,subtotal:9000,tax:null,invoiceFile:{hash,name:'ledger.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:100,updatedAt:at},ocrMeta:{sourceFileHash:hash,referenceOnly:true,sourceAudit:{sourceType:'period-ledger'}},items:[{id:'sale',name:'Normal item',qty:10,price:1000,supplyAmount:10000,tax:null,amt:10000},{id:'return',name:'Returned item',qty:-1,price:1000,supplyAmount:-1000,tax:null,amt:-1000}]}]};
 s.orderEdits={'returns-ledger':{at,origin:'ocr'}};
 return s;
}
const saved=mergeGuest(full,pending()),invoice=saved.orders['2026-10'][0];
assert.equal(invoice.items[1].qty,-1);
assert.equal(invoice.items[1].amt,-1000);
assert.equal(invoice.items[1].tax,null);
assert.equal(invoice.invoiceFile.hash,hash);
assert.equal(invoice.ocrMeta.referenceOnly,true);
assert.deepEqual(saved.settings.fixed,full.settings.fixed);
assert.deepEqual(saved.cardTransactions,full.cardTransactions);
const credit=pending();credit.orders['2026-10'][0].total=-1000;credit.orders['2026-10'][0].subtotal=-1000;credit.orders['2026-10'][0].items=[credit.orders['2026-10'][0].items[1]];
assert.equal(mergeGuest(full,credit).orders['2026-10'][0].total,-1000);
for(const [field,value]of [['amt','-1000'],['amt',1e12+1],['qty',-1e9-1],['qty','x'.repeat(201)]]){
 const bad=pending();bad.orders['2026-10'][0].items[1][field]=value;
 assert.throws(()=>mergeGuest(full,bad),/invalid_invoice/);
}
// JSON transport canonicalizes non-finite values to null, never a stored amount.
const nonfinite=pending();nonfinite.orders['2026-10'][0].items[1].amt=Infinity;
assert.equal(mergeGuest(full,nonfinite).orders['2026-10'][0].items[1].amt,null);
const stale=pending();stale.orderEdits['returns-ledger'].at='2026-10-01T00:00:00Z';stale.orders['2026-10'][0].invoiceFile.hash='b'.repeat(64);
assert.equal(mergeGuest(saved,stale).orders['2026-10'][0].invoiceFile.hash,hash);
const deleted=structuredClone(saved);deleted.orders={};deleted.orderEdits['returns-ledger']={at,origin:'manual',deleted:true};
assert.equal(Object.values(mergeGuest(deleted,pending()).orders).flat().length,0,'OCR cannot revive deleted source records');
console.log('GUEST_SIGNED_RETURNS_ORIGINAL_LINK_BLANK_VAT_BOUNDS_STALE_DELETE_PRIVATE_FIELDS_OK');
