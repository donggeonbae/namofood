// Pure, operator-reviewed source reconciliation. No AI, network, file or ledger writes.
const {createHash}=require('node:crypto');
const clone=x=>structuredClone(x),finite=x=>typeof x==='number'&&Number.isFinite(x),key=s=>String(s||'').replace(/\s/g,'').replace(/^한마음$/,'한마음푸드');
function reconcileLedger(state,plan,at){
 if(!plan?.reviewed||!finite(plan.expectedTotal)||!Array.isArray(plan.groups)||!plan.groups.length||!Number.isFinite(Date.parse(at)))throw Error('Reviewed source plan required');
 const input=Object.values(state.orders||{}).flat(),byId=new Map(input.map(o=>[o.id,o]));
 const sources=plan.sourceIds.map(id=>{const o=byId.get(id);if(!o||!o.ocrMeta?.referenceOnly||!o.invoicePhoto?.hash)throw Error('Reviewed source/photo unavailable: '+id);return o;});
 if(new Set(plan.sourceIds).size!==sources.length)throw Error('Duplicate source');
 const used=new Set(),dates=new Set(),documents=[],archiveMap=new Map();let quantity=0;
 for(const group of plan.groups){
  const date=group.date,day=new Date(date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(+day)||day.toISOString().slice(0,10)!==date||date<plan.from||date>plan.to||!group.account)throw Error('Invalid source date/account');
  const dateKey=date+'|'+group.account;if(dates.has(dateKey))throw Error('Duplicate date/account');dates.add(dateKey);
  const items=[],parts=[];for(const part of group.parts){
   const source=sources.find(o=>o.id===part.sourceId);if(!source||key(source.vendor)!==key(plan.vendor))throw Error('Source/vendor mismatch');
   const refs=[];for(const itemId of part.itemIds){const raw=source.items.find(x=>x.id===itemId),identity=source.id+'|'+itemId;if(!raw||used.has(identity))throw Error('Missing or repeated source row');used.add(identity);refs.push(itemId);const patch=plan.corrections?.[itemId];if(patch&&!patch.evidence)throw Error('Correction has no source evidence');const item={...clone(raw),...clone(patch?.fields||{})};if(!finite(item.amt)||!item.name)throw Error('Unconfirmed source amount/name');if(item.supplyAmount!=null&&!finite(item.supplyAmount)||item.tax!=null&&!finite(item.tax))throw Error('Invalid source tax/supply');items.push(item);if(finite(item.qty))quantity+=item.qty;}
   parts.push({orderId:source.id,itemIds:refs});
  }
  const total=items.reduce((n,x)=>n+x.amt,0);if(!items.length||total!==group.total)throw Error('Daily source total mismatch: '+date);
  if(group.tax!=null&&group.subtotal!=null&&group.tax+group.subtotal!==total)throw Error('Daily header mismatch');
  for(const item of items)if(item.supplyAmount!=null&&item.tax!=null&&Math.abs(item.supplyAmount+item.tax-item.amt)>1)throw Error('Source row supply/tax mismatch');
  if(group.subtotal!=null&&items.every(x=>finite(x.supplyAmount))&&Math.abs(items.reduce((s,x)=>s+x.supplyAmount,0)-group.subtotal)>1)throw Error('Daily source supply mismatch');
  if(group.tax!=null&&Math.abs(items.reduce((s,x)=>s+(x.tax??0),0)-group.tax)>1)throw Error('Daily source tax mismatch');
  const id='ledger-daily-'+createHash('sha256').update(JSON.stringify([plan.sourceIds.slice().sort(),date,group.account])).digest('hex');if(byId.has(id))throw Error('Reconciliation already exists; preserve subsequent manual edits');
  const first=sources.find(o=>o.id===parts[0].orderId),doc={id,date,vendor:plan.vendor,invoiceNo:'원장 '+date+' · '+group.account,subtotal:group.subtotal??null,tax:group.tax??null,total,previousBalance:null,balanceTotal:null,note:'원장 기준 날짜별 집계 · '+group.account,items,invoicePhoto:clone(first.invoicePhoto),ocr:'원장 원본을 날짜별로 대조한 내역입니다. 연결된 기준 원장에서 해당 날짜를 확인하세요.',warnings:[],ocrMeta:{by:'operator-source-review',confirmedAt:at,referenceOnly:false,referenceAt:at,ledgerDaily:{account:group.account,parts,reviewedAt:at},sourceAudit:{sourceType:'ledger-daily',by:'operator-source-review',at}}};
  documents.push(doc);
  for(const oldId of group.coveredIds||[]){const old=byId.get(oldId);if(!old||old.date!==date||key(old.vendor)!==key(plan.vendor)||old.ocrMeta?.referenceOnly||archiveMap.has(oldId))throw Error('Covered invoice scope mismatch');
   const amounts=new Map();for(const x of items)amounts.set(x.amt,(amounts.get(x.amt)||0)+1);let matched=0,basis=0;for(const x of old.items||[]){if(!finite(x.amt))continue;basis+=Math.abs(x.amt);if(amounts.get(x.amt)>0){matched+=Math.abs(x.amt);amounts.set(x.amt,amounts.get(x.amt)-1);}}
   if(!basis||matched/basis<.8)throw Error('Covered invoice lacks line-amount evidence: '+oldId);archiveMap.set(oldId,{id,matchedRatio:matched/basis});
  }
 }
 const total=documents.reduce((n,o)=>n+o.total,0);if(total!==plan.expectedTotal||plan.expectedQuantity!=null&&quantity!==plan.expectedQuantity)throw Error('Source grand total/quantity mismatch');
 const ignored=new Set((plan.ignored||[]).map(x=>{if(!x.reason||!plan.sourceIds.includes(x.sourceId)||!byId.get(x.sourceId)?.items.some(i=>i.id===x.itemId))throw Error('Invalid omitted source row');return x.sourceId+'|'+x.itemId;}));
 if(ignored.size!==(plan.ignored||[]).length||[...ignored].some(x=>used.has(x)))throw Error('Overlapping source omission');
 for(const source of sources)for(const item of source.items)if(!used.has(source.id+'|'+item.id)&&!ignored.has(source.id+'|'+item.id))throw Error('Unaccounted source row');
 const next=clone(state);next.orderEdits||={};const all=Object.values(next.orders).flat(),stamp=o=>{next.orderEdits[o.id]={at:new Date(Math.max(Date.parse(at),(Date.parse(state.orderEdits?.[o.id]?.at)||0)+1)).toISOString(),origin:'manual',deleted:false};};
 for(const source of sources){const o=all.find(x=>x.id===source.id),reviewedCorrections=[];for(const item of o.items){const correction=plan.corrections?.[item.id];if(!correction)continue;const before={};for(const field of Object.keys(correction.fields)){before[field]=clone(item[field]??null);}Object.assign(item,clone(correction.fields));reviewedCorrections.push({itemId:item.id,before,after:clone(correction.fields),evidence:correction.evidence,at});}Object.assign(o.ocrMeta,{referenceOnly:true,referenceAt:at,referenceReason:'원장 원본 · 날짜별 집계에 반영됨',ledgerMaster:{from:plan.from,to:plan.to,account:plan.account,total,days:documents.length,rows:used.size,derivedIds:documents.map(d=>d.id),reviewedAt:at,otherAccountIncomplete:ignored.size>0}});if(reviewedCorrections.length){o.ocrMeta.sourceAudit={...o.ocrMeta.sourceAudit,reviewedAt:at,reviewedCorrections:[...(o.ocrMeta.sourceAudit?.reviewedCorrections||[]),...reviewedCorrections]};}stamp(o);}
 for(const [oldId,covered] of archiveMap){const o=all.find(x=>x.id===oldId);Object.assign(o.ocrMeta||={}, {referenceOnly:true,referenceAt:at,referenceReason:'원장 기준 집계에 포함된 일별 명세서 · 중복 합산 제외',coveredByLedgerId:covered.id,balanceEvidence:finite(o.balanceTotal)});stamp(o);}
 for(const doc of documents){(next.orders[doc.date.slice(0,7)]||=[]).push(doc);stamp(doc);}
 return {state:next,summary:{days:documents.length,rows:used.size,quantity,total,archived:archiveMap.size,sourcePages:sources.length,ignoredRows:ignored.size},documents};
}
module.exports={reconcileLedger};
