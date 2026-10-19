// Shared server/browser projection. Fields not explicitly admitted stay private.
(function (root) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => x && Object.hasOwn(x,k)).map(k=>[k,clone(x[k])]));
  const meals = ['조식','중식','석식','야식'];
  const safeKey = k => !['__proto__','constructor','prototype'].includes(k);
  const salesKey = k => /^([1-9]|[12]\d|3[01])\|(?:(?:cashCount|cardCount|creditCount)\|)?(?:조식|중식|석식|야식)$/.test(k) || /^([1-9]|[12]\d|3[01])\|(?:cups|rev|other|ticketIssued|ticketIssuePrice|ticketBuyer|ticketCompany(?:Name|Qty|Price|Deleted)\|[a-zA-Z0-9_-]{1,64})$/.test(k);
  const rosterKey = k => /^[a-zA-Z0-9_-]{1,100}\|([1-9]|[12]\d|3[01])$/.test(k);
  function initializeBreakDefaults(s){
    s.settings||={};if(s.settings.defaultBreakZeroInitialized)return s;
    const shifts=s.settings.shifts||{};
    // Resolve legacy saved codes with their original breaks before changing templates.
    for(const month of Object.values(s.roster||{}))for(const [key,value]of Object.entries(month||{})){
      const shift=typeof value==='string'?shifts[value]:null;if(shift&&/^\d+$/.test(key.split('|')[1]))month[key]={s:shift.start,e:shift.end,b:shift.brk||0};
    }
    for(const person of [...(s.staff||[]),...(s.staffArchive||[])])if(person.def)person.def={...person.def,b:0};
    for(const shift of Object.values(shifts))if(shift&&typeof shift==='object')shift.brk=0;
    s.settings.defaultBreakMinutes=0;s.settings.defaultBreakZeroInitialized=true;return s;
  }
  const recipeFields=['comp','menu','item','qty','unit','storage','loss','form','method','allergy'];
  const productFields=['id','name','category','unit','price','ticketUnits','itemsPerTicket','at','deleted','sourceIdentity','sourceSpec'];
  const saleFields=['id','date','name','category','unit','price','ticketUnits','itemsPerTicket','settlementMode','cardAmount','cashAmount','qty','tickets','ticketQty','cardQty','cashQty','creditQty','paymentSplit','deleted','at'];
  const priced=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  const priceConfigured=v=>Object.hasOwn(v,'price')?priced(v.price):v.priceConfigured===true;
  const ticketRate=p=>p.ticketUnits==null?(priced(p.price)?p.price/10000:null):p.ticketUnits;
  const itemsPerTicket=p=>p.itemsPerTicket!=null?p.itemsPerTicket:ticketRate(p)==null?null:ticketRate(p)>0?1/ticketRate(p):0;
  const validRate=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1000000&&Math.abs(v*1000000-Math.round(v*1000000))<0.0001;
  function storeSettlement(product,values){
    const price=product.price,rate=ticketRate(product),tickets=values.tickets,cardAmount=values.cardAmount,cashAmount=values.cashAmount;
    const direct=product.itemsPerTicket!=null;
    if(!priced(price)||!validRate(direct?product.itemsPerTicket:rate))throw Error('상품 판매가와 식권 1장당 수량을 먼저 설정하세요.');
    if(!Number.isSafeInteger(tickets)||tickets<0||tickets>1000000)throw Error('받은 식권은 0 이상의 정수 장수로 입력하세요.');
    const goods=(amount,label)=>{if(!priced(amount)||amount>1e12)throw Error(label+' 금액은 0 이상의 정수 원으로 입력하세요.');if(!amount)return 0;if(!price||amount%price)throw Error(label+' 금액이 판매가로 나누어지지 않습니다. 결제 금액을 확인하세요.');return amount/price;};
    let ticketQty=0;
    if(direct){const scaled=BigInt(Math.round(product.itemsPerTicket*1000000))*BigInt(tickets);if(tickets&&(!product.itemsPerTicket||scaled%1000000n))throw Error('식권 장수 × 1장당 수량이 상품 개수로 나누어지지 않습니다.');ticketQty=Number(scaled/1000000n);}
    else{const scaled=Math.round(rate*1000000),ticketScaled=BigInt(tickets)*1000000n;if(tickets&&(!scaled||ticketScaled%BigInt(scaled)))throw Error('식권 장수가 상품 개수로 나누어지지 않습니다. 상품 기준을 확인하세요.');ticketQty=tickets?Number(ticketScaled/BigInt(scaled)):0;}
    const cardQty=goods(cardAmount,'카드'),cashQty=goods(cashAmount,'현금'),qty=ticketQty+cardQty+cashQty;
    if(!Number.isSafeInteger(qty)||qty>1000000)throw Error('하루 상품 판매 수량은 1,000,000개 이하로 입력하세요.');
    return {settlementMode:'amount-v1',paymentSplit:true,...(direct?{itemsPerTicket:product.itemsPerTicket}:{ticketUnits:rate}),tickets,cardAmount,cashAmount,ticketQty,cardQty,cashQty,creditQty:0,qty};
  }
  const stockFields=['id','orderNo','date','name','spec','unit','qty','storeProductId','storeUnitsPerPack','at','deleted'];
  const orderFields=['id','date','vendor','invoiceNo','note','ocr','rawText','subtotal','tax','total','previousBalance','balanceTotal','warnings','invoicePhoto','invoiceFile'];
  const orderItemFields=['id','name','spec','qty','unit','price','supplyAmount','tax','amt','warnings','confidence','labelReview','sourceRefs','storeProductId','storeUnitsPerPack','storeExcluded'];
  // Invoice OCR preserves signed returns/credits. Apply the same bounded-number
  // contract at shared save; a return must not orphan its encrypted source file.
  const invoiceNumberOK=(value,limit=1e12)=>value==null||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=limit;
  const ocrFields=['by','model','processedAt','registeredAt','confirmedAt','autoRegistered','imageSha256','fileName','sourceFileHash','sheetName','sourceKey','sourceRefs','sourceFileComplete','labelReview','duplicateCheckedIds','duplicateApprovedAt','duplicateReviewPending','referenceOnly','referenceAt','referenceReason','ledgerMaster','ledgerDaily','balanceEvidence','coveredByLedgerId','sourceAudit','supersedesIds','supersededById','duplicateAudit','purchaseRoute'];
  const orderView=o=>({...pick(o,orderFields),items:(o.items||[]).map(i=>pick(i,orderItemFields)),...(o.ocrMeta?{ocrMeta:pick(o.ocrMeta,ocrFields)}:{}),...(o.coupang?{coupang:pick(o.coupang,['orderNo','stockLinked','importedAt','partial','sourceItemCount','sourceTotal'])}:{})});
  const orderMap=s=>Object.fromEntries(Object.entries(s.orders||{}).filter(([m,rows])=>/^20\d{2}-(0[1-9]|1[0-2])$/.test(m)&&Array.isArray(rows)).map(([m,rows])=>[m,rows.map(orderView)]));
  const fixedPurchaseView=s=>Object.fromEntries(Object.entries(s.fixedPurchases||{}).filter(([m,rows])=>/^20\d{2}-(0[1-9]|1[0-2])$/.test(m)&&Array.isArray(rows)).map(([m,rows])=>[m,rows.filter(o=>o?.ocrMeta?.purchaseRoute?.target==='fixed'&&!s.orderEdits?.[o.id]?.deleted).map(orderView)]));
  function stockView(s){
    const out={},targets={},orders=Object.values(s.orders||{}).flat().filter(o=>o?.coupang&&!s.orderEdits?.[o.id]?.deleted&&!o.ocrMeta?.referenceOnly),linked=new Set(orders.filter(o=>o.coupang.stockLinked).map(o=>o.coupang.orderNo));
    for(const [id,row]of Object.entries(s.storeStockImports||{}))if(safeKey(id)&&!linked.has(row.orderNo))out[id]=pick(row,stockFields);
    const grouped=new Set(Object.values(out).map(r=>r.orderNo));
    for(const order of orders){if(grouped.has(order.coupang.orderNo))continue;
      for(const [i,item]of (order.items||[]).entries()){
        const id='@invoice:'+order.id+':'+i;
        out[id]={...pick(item,['name','spec','unit','qty','storeProductId','storeUnitsPerPack']),id,orderNo:order.coupang.orderNo,date:order.date,at:s.orderEdits?.[order.id]?.at||'1970-01-01',deleted:!!item.storeExcluded};targets[id]={orderId:order.id,index:i};
      }
    }
    return {rows:out,targets};
  }
  const boardView=s=>({...pick(s.board||{},['title','sub','note','hideUnpriced','order']),items:Object.fromEntries(Object.entries(s.board?.items||{}).filter(([k])=>safeKey(k)).map(([k,v])=>[k,pick(v,['on','desc'])]))});
  function operations(s){
    const result={},groups=new Map();for(const r of s.recipes||[]){if(!groups.has(r.menu))groups.set(r.menu,[]);groups.get(r.menu).push(pick(r,recipeFields));}
    for(const name of new Set([...groups.keys(),...Object.keys(s.methods||{}),...Object.keys(s.recipeResolutions||{})])){
      if(typeof name!=='string'||!safeKey(name))continue;
      result['recipe:'+name]={rows:groups.get(name)||[],method:s.methods?.[name]??null,source:s.sources?.[name]??null,meta:s.recipeMeta?.[name]?pick(s.recipeMeta[name],['by','updated','cookingProfile']):null,ask:s.recipeAsk?.[name]??null,resolution:s.recipeResolutions?.[name]??null};
    }
    for(const kind of ['daily','temp','keep','receive'])result['hyg:'+kind]=clone(s.hyg?.[kind]||[]);
    result.board=boardView(s);
    result.recipeAllowance=s.settings?.recipeOrderMultiplier??2;
    result.ticketConfig=pick(s.settings?.ticketLedger||{},['startDate','opening','buyer','supplier','unitPrice']);
    for(const person of [...(s.staff||[]),...(s.staffArchive||[])])if(safeKey(person.id))result['staff:'+person.id]=pick(person,['name','role','def','off']);
    for(const [item,value]of Object.entries(s.prices||{}))if(safeKey(item))result['purchasePrice:'+item]=pick(value,['price','vendor']);
    for(const month of new Set([...Object.keys(s.orderAdj||{}),...Object.keys(s.extraOrders||{})]))if(/^20\d{2}-\d{2}$/.test(month))result['purchaseCalc:'+month]={adjustments:clone(s.orderAdj?.[month]||{}),extras:clone(s.extraOrders?.[month]||[])};
    return result;
  }
  function maps(x, accept, value = v=>clone(v)) {
    const out={};
    for (const [month,cells] of Object.entries(x||{})) {
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !cells || typeof cells!=='object') continue;
      out[month]={};
      for(const [key,v] of Object.entries(cells)) if(safeKey(key)&&accept(key))out[month][key]=value(v);
    }
    return out;
  }
  function project(s) {
    const settings=pick(s.settings||{},['shifts','staffRoles','recipeOrderMultiplier','printMeals','defaultBreakMinutes','defaultBreakZeroInitialized']);
    settings.meals=Object.fromEntries(meals.map(m=>[m,pick(s.settings?.meals?.[m]||{},['count'])]));
    settings.ticketLedger=pick(s.settings?.ticketLedger||{},['startDate','opening','buyer','supplier','unitPrice']);
    // Payroll/contact data, recurring fixed costs, general documents and taxes
    // stay private. Operational invoices and routed fixed purchases are allowlisted.
    const staff = a => (a||[]).map(e=>({...pick(e,['id','name','role','off','archivedAt','historyNames']),...(e.def?{def:pick(e.def,['s','e','b'])}:{})}));
    const out=pick(s,['month','updatedAt','view','menus','menuManualEdits','menuExtraSlots','menuExtraEdits','menuRetirements','methods','hyg','cafeSeeded','recipeAsk','recipeResolutions','sources','accessEdits']);
    out.recipeMeta=Object.fromEntries(Object.entries(s.recipeMeta||{}).filter(([name])=>safeKey(name)).map(([name,v])=>[name,pick(v,['by','updated','cookingProfile'])]));
    out.board=boardView(s);
    out.orders=orderMap(s);out.orderEdits=Object.fromEntries(Object.entries(s.orderEdits||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,pick(v,['at','deleted','origin'])]));
    out.fixedPurchases=fixedPurchaseView(s);
    out.prices=Object.fromEntries(Object.entries(s.prices||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,pick(v,['price','vendor'])]));
    Object.assign(out,pick(s,['orderAdj','extraOrders']));
    out.storeProducts=Object.fromEntries(Object.entries(s.storeProducts||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,{...pick(v,productFields),priceConfigured:priceConfigured(v)}]));
    out.storeSales=Object.fromEntries(Object.entries(s.storeSales||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,{...pick(v,saleFields),priceConfigured:priceConfigured(v)}]));
    out.storeStockImports=stockView(s).rows;
    Object.assign(out,{settings,staff:staff(s.staff),staffArchive:staff(s.staffArchive),
      staffOrder:s.staffOrder?pick(s.staffOrder,['at','ids']):undefined,
      recipes:(s.recipes||[]).map(r=>pick(r,recipeFields)),
      roster:maps(s.roster,rosterKey,v=>v&&typeof v==='object'?pick(v,['s','e','b']):v),rosterEdits:maps(s.rosterEdits,rosterKey,v=>pick(v,['at','deleted'])),
      sales:maps(s.sales,salesKey),salesEdits:maps(s.salesEdits,salesKey,v=>pick(v,['at']))});
    out.staffEdits=Object.fromEntries(Object.entries(s.staffEdits||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,pick(v,['at','status','listed'])]));
    out.staffFieldEdits=Object.fromEntries(Object.entries(s.staffFieldEdits||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,pick(v,['name','role','historyNames'])]));
    out.staffPayments=maps(s.staffPayments,k=>safeKey(k),v=>pick(v,['paid','at','paidAt','basis']));
    return initializeBreakDefaults(out);
  }
  function mergeGuest(full, incoming) {
    const out=initializeBreakDefaults(clone(full)), staffIds=new Set([...(full.staff||[]),...(full.staffArchive||[])].map(e=>e.id));
    const count = v => Number.isSafeInteger(v)&&v>=0&&v<=1000000;
    const clock = v => typeof v?.at==='string'&&Number.isFinite(Date.parse(v.at))&&Date.parse(v.at)<=Date.now()+300000;
    const staffMap=new Map([...(out.staff||[]),...(out.staffArchive||[])].map(e=>[e.id,e]));out.staffEdits||={};out.staffFieldEdits||={};out.accessEdits||={};
    for(const person of [...(incoming.staff||[]),...(incoming.staffArchive||[])]){
      const id=person.id;if(typeof id!=='string'||!id||id.length>100||!safeKey(id))continue;
      const old=staffMap.get(id),status=incoming.staffEdits?.[id],statusNew=clock(status)&&['active','archive'].includes(status.status)&&Date.parse(status.at)>Date.parse(out.staffEdits[id]?.at||'1970-01-01'),edit=incoming.accessEdits?.['staff:'+id],fieldsNew=clock(edit)&&Date.parse(edit.at)>Date.parse(out.accessEdits['staff:'+id]?.at||'1970-01-01');
      if(!old&&!statusNew||old&&!statusNew&&!fieldsNew)continue;
      const next={...old,id};if(!old||fieldsNew){
        if(typeof person.name!=='string'||person.name.length>100||typeof person.role!=='string'||person.role.length>100||!person.def||!['s','e'].every(k=>/^([01]\d|2[0-3]):[0-5]\d$/.test(person.def[k]))||!Number.isInteger(person.def.b)||person.def.b<0||person.def.b>1440||!Array.isArray(person.off)||person.off.some(n=>!Number.isInteger(n)||n<0||n>6))throw Error('invalid_staff_operation');
        Object.assign(next,pick(person,['name','role','off']));next.def=pick(person.def,['s','e','b']);if(old?.name&&old.name!==next.name)next.historyNames=[...new Set([...(old.historyNames||[]),old.name])];
        if(fieldsNew)out.accessEdits['staff:'+id]={at:edit.at};
        for(const field of ['name','role','historyNames']){const fieldEdit=incoming.staffFieldEdits?.[id]?.[field];if(clock(fieldEdit)){out.staffFieldEdits[id]||={};out.staffFieldEdits[id][field]={at:fieldEdit.at};}}
      }
      if(statusNew){out.staffEdits[id]=pick(status,['at','status','listed']);if(status.status==='archive'){next.archivedAt=status.at;if(next.wage==null&&next.archivedWage==null)next.archivedWage=out.settings.roleWages?.[next.role]??out.settings.wage;}else{if(next.wage==null&&next.archivedWage!=null)next.wage=next.archivedWage;delete next.archivedAt;delete next.archivedWage;}}
      const archived=(out.staffEdits[id]?.status||((out.staffArchive||[]).some(e=>e.id===id)?'archive':'active'))==='archive';out.staff=(out.staff||[]).filter(e=>e.id!==id);out.staffArchive=(out.staffArchive||[]).filter(e=>e.id!==id);(archived?out.staffArchive:out.staff).push(next);staffMap.set(id,next);staffIds.add(id);
    }
    out.staffPayments||={};for(const [month,records]of Object.entries(incoming.staffPayments||{}))if(/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))for(const [id,record]of Object.entries(records||{})){
      if(!staffIds.has(id)||!clock(record)||typeof record.paid!=='boolean'||Date.parse(record.at)<=Date.parse(out.staffPayments[month]?.[id]?.at||'1970-01-01'))continue;
      out.staffPayments[month]||={};out.staffPayments[month][id]={...out.staffPayments[month][id],paid:record.paid,at:record.at,paidAt:record.paid?record.at:null,basis:'manual-check-v1'};
    }
    function merge(field, edits, keyOK, valueOK) {
      const cells=maps(incoming[field],keyOK), changes=maps(incoming[edits],keyOK);
      out[field]||={};out[edits]||={};
      for(const [month,entries] of Object.entries(changes))for(const [key,edit]of Object.entries(entries)){
        if(!clock(edit)||Date.parse(edit.at)<=Date.parse(out[edits][month]?.[key]?.at||'1970-01-01'))continue;
        const has=Object.hasOwn(cells[month]||{},key),v=cells[month]?.[key];
        if(has&&!valueOK(v,key))throw Error('invalid_operational_value');
        out[field][month]||={};out[edits][month]||={};
        if(has)out[field][month][key]=clone(v);else delete out[field][month][key];
        out[edits][month][key]={at:edit.at,...(field==='roster'?{deleted:!has}:{})};
      }
    }
    merge('sales','salesEdits',salesKey,(v,k)=>/\|(?:ticketBuyer|ticketCompanyName\|[a-zA-Z0-9_-]+)$/.test(k)?typeof v==='string'&&v.length<=100:/\|(?:rev|other|ticketIssuePrice|ticketCompanyPrice\|[a-zA-Z0-9_-]+)$/.test(k)?Number.isSafeInteger(v)&&v>=0:count(v));
    merge('roster','rosterEdits',k=>rosterKey(k)&&staffIds.has(k.split('|')[0]),v=>
      ['', '휴','연차','병가'].includes(v)||(v&&typeof v==='object'&&Object.keys(v).every(k=>['s','e','b'].includes(k))&&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(v.s)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v.e)&&Number.isInteger(v.b)&&v.b>=0&&v.b<=1440));
    merge('menus','menuManualEdits',k=>/^([1-9]|[12]\d|3[01])\|(조식|중식|석식|야식)\|(n|\d{1,2})$/.test(k),
      (v,k)=>k.endsWith('|n')?count(v):typeof v==='string'&&v.length<=200);
    // Recipe/hygiene/menu-board edits remain operational; a per-group clock
    // prevents unrelated recipes or private state from being replaced by a guest.
    const ops=operations(incoming);out.accessEdits||={};
    for(const [key,edit]of Object.entries(incoming.accessEdits||{})){
      if(!safeKey(key)||!clock(edit)||Date.parse(edit.at)<=Date.parse(out.accessEdits[key]?.at||'1970-01-01'))continue;
      if(key.startsWith('recipe:')){
        const name=key.slice(7);if(!name||name.length>200||!safeKey(name))continue;
        const value=ops[key]||{rows:[],method:null,source:null,meta:null,ask:null,resolution:null};
        if(value.rows.length>1000||value.rows.some(r=>r.menu!==name||typeof r.item!=='string'||r.item.length>300||r.qty!=null&&(typeof r.qty!=='number'||!Number.isFinite(r.qty)||r.qty<0)))throw Error('invalid_recipe');
        out.recipes=(out.recipes||[]).filter(r=>r.menu!==name).concat(value.rows);
        for(const [field,v]of Object.entries({methods:value.method,sources:value.source,recipeMeta:value.meta,recipeAsk:value.ask,recipeResolutions:value.resolution})){
          out[field]||={};if(v===null)delete out[field][name];else out[field][name]=field==='recipeMeta'?pick(v,['by','updated','cookingProfile']):clone(v);
        }
      }else if(key.startsWith('hyg:')&&['daily','temp','keep','receive'].includes(key.slice(4))){
        const kind=key.slice(4),rows=ops[key];if(!Array.isArray(rows)||rows.length>10000)throw Error('invalid_hygiene');
        out.hyg||={};out.hyg[kind]=clone(rows);
      }else if(key==='recipeAllowance'){
        const n=ops.recipeAllowance;if(typeof n!=='number'||!Number.isFinite(n)||n<1||n>10)throw Error('invalid_recipe_allowance');out.settings.recipeOrderMultiplier=n;
      }else if(key==='ticketConfig'){
        const v=ops.ticketConfig;if(['opening','unitPrice'].some(k=>v[k]!=null&&(!Number.isSafeInteger(v[k])||v[k]<0))||['buyer','supplier'].some(k=>v[k]!=null&&(typeof v[k]!=='string'||v[k].length>100))||v.startDate!=null&&!/^20\d{2}-\d{2}-\d{2}$/.test(v.startDate))throw Error('invalid_ticket_config');out.settings.ticketLedger={...out.settings.ticketLedger,...v};
      }else if(key.startsWith('purchasePrice:')){
        const item=key.slice(14),v=ops[key];if(!item||item.length>300||!safeKey(item)||!v||v.price!=null&&(typeof v.price!=='number'||!Number.isFinite(v.price)||v.price<0)||v.vendor!=null&&(typeof v.vendor!=='string'||v.vendor.length>300))throw Error('invalid_purchase_price');out.prices||={};out.prices[item]={...out.prices[item],...v};
      }else if(key.startsWith('purchaseCalc:')&&/^20\d{2}-\d{2}$/.test(key.slice(13))){
        const month=key.slice(13),v=ops[key];if(!v||!Array.isArray(v.extras)||v.extras.length>10000||Object.entries(v.adjustments).some(([name,n])=>!safeKey(name)||typeof n!=='number'||!Number.isFinite(n))||v.extras.some(x=>['qty','price'].some(k=>x[k]!=null&&(typeof x[k]!=='number'||!Number.isFinite(x[k])||x[k]<0))))throw Error('invalid_purchase_calculation');out.orderAdj||={};out.extraOrders||={};out.orderAdj[month]=clone(v.adjustments);out.extraOrders[month]=v.extras.map(x=>pick(x,['item','qty','unit','price','vendor','note']));
      }else if(key==='board'){
        out.board||={};Object.assign(out.board,pick(ops.board,['title','sub','note','hideUnpriced','order']));out.board.items||={};
        for(const [name,value]of Object.entries(ops.board.items)){out.board.items[name]={...out.board.items[name],...pick(value,['on','desc'])};}
      }else continue;
      out.accessEdits[key]={at:edit.at};
    }
    // Procurement is shared operational data. Only its explicit fields can change;
    // hidden card links, payroll, taxes and unrelated invoices stay on the server.
    out.orders||={};out.orderEdits||={};
    const incomingOrders=new Map(Object.values(orderMap(incoming)).flat().map(o=>[o.id,o]));
    for(const [id,edit]of Object.entries(incoming.orderEdits||{})){
      if(!safeKey(id)||!id||id.length>200||!clock(edit))continue;
      const previous=out.orderEdits[id],found=Object.entries(out.orders).filter(([,rows])=>Array.isArray(rows)).flatMap(([month,rows])=>rows.filter(o=>o.id===id).map(o=>({month,order:o}))),old=found[0]?.order;
      if(Date.parse(edit.at)<=Date.parse(previous?.at||'1970-01-01')||['ocr','coupang'].includes(edit.origin)&&previous&&(previous.deleted||!['ocr','coupang'].includes(previous.origin)))continue;
      const next=incomingOrders.get(id);
      if(!edit.deleted){
        if(!next||next.id!==id||!/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(next.date)||!Array.isArray(next.items)||next.items.length>10000||JSON.stringify(next).length>2*1024*1024||['subtotal','tax','total','previousBalance','balanceTotal'].some(k=>!invoiceNumberOK(next[k]))||next.items.some(i=>['price','supplyAmount','tax','amt'].some(k=>!invoiceNumberOK(i[k]))||i.qty!=null&&!(typeof i.qty==='string'&&i.qty.length<=200)&&!invoiceNumberOK(i.qty,1e9)))throw Error('invalid_invoice');
      }
      for(const {month}of found)out.orders[month]=out.orders[month].filter(o=>o.id!==id);
      if(!edit.deleted){
        const order={...old};for(const key of [...orderFields,'items','ocrMeta','coupang'])delete order[key];Object.assign(order,next);
        const month=next.date.slice(0,7);(out.orders[month]||=[]).push(order);
      }
      out.orderEdits[id]=pick(edit,['at','deleted','origin']);
    }
    out.storeProducts||={};
    for(const [id,p]of Object.entries(incoming.storeProducts||{})){
      const old=out.storeProducts[id];if(!safeKey(id)||!clock(p)||old&&Date.parse(p.at)<=Date.parse(old.at||'1970-01-01'))continue;
      if(['name','category','unit'].some(k=>typeof p[k]!=='string'||!p[k].trim()||p[k].length>100))throw Error('invalid_product');
      if(p.price!=null&&!priced(p.price)||p.ticketUnits!=null&&!validRate(p.ticketUnits)||p.itemsPerTicket!=null&&!validRate(p.itemsPerTicket))throw Error('invalid_product_price_or_ticket_rate');
      out.storeProducts[id]={...(old||{id,cost:null}),...pick(p,['name','category','unit','price','ticketUnits','itemsPerTicket','at','deleted','sourceIdentity','sourceSpec'])};
    }
    out.storeSales||={};
    for(const [key,r]of Object.entries(incoming.storeSales||{})){
      if(!safeKey(key)||!r||!clock(r)||!/^20\d{2}-\d{2}-\d{2}$/.test(r.date)||key!==r.date+'|'+r.id)continue;
      const old=out.storeSales[key],product=out.storeProducts[r.id];if(!old&&!product||old&&Date.parse(r.at)<=Date.parse(old.at||'1970-01-01'))continue;
      const base=old||{id:r.id,date:r.date,name:product.name,category:product.category,unit:product.unit,price:product.price,cost:product.cost,ticketUnits:ticketRate(product),...(product.itemsPerTicket!=null?{itemsPerTicket:product.itemsPerTicket}:{})};
      if(r.settlementMode==='amount-v1'){
        const result=storeSettlement({...base,ticketUnits:base.ticketUnits??ticketRate({price:base.price})},r);
        if(result.qty!==r.qty||['ticketQty','cardQty','cashQty','creditQty'].some(k=>result[k]!==r[k]))throw Error('invalid_store_derived_quantity');
        out.storeSales[key]={...base,...result,...pick(r,['at','deleted'])};continue;
      }
      if(old?.settlementMode==='amount-v1')throw Error('store_client_update_required');
      if(!count(r.qty)||r.tickets!=null&&!count(r.tickets))throw Error('invalid_store_quantity');
      if(r.paymentSplit&&(['ticketQty','cardQty','cashQty'].some(k=>!count(r[k]))||!count(r.creditQty??0)||r.qty!==r.ticketQty+r.cardQty+r.cashQty+(r.creditQty??0)||!r.ticketQty&&r.tickets>0))throw Error('invalid_store_channels');
      if(!priced(base.price))throw Error('store_price_needs_admin');
      out.storeSales[key]={...base,...pick(r,['qty','tickets','ticketQty','cardQty','cashQty','creditQty','paymentSplit','deleted','at'])};
    }
    const stock=stockView(out);out.storeStockImports||={};
    for(const [id,row]of Object.entries(incoming.storeStockImports||{})){
      const old=stock.rows[id];if(!old||!clock(row)||Date.parse(row.at)<=Date.parse(old.at||'1970-01-01'))continue;
      if(row.storeProductId&&!out.storeProducts[row.storeProductId]||row.storeUnitsPerPack!=null&&(!Number.isSafeInteger(row.storeUnitsPerPack)||row.storeUnitsPerPack<1||row.storeUnitsPerPack>100000))throw Error('invalid_stock_link');
      const edit=pick(row,['storeProductId','storeUnitsPerPack','deleted','at']),target=stock.targets[id];
      if(target){const order=Object.values(out.orders).flat().find(o=>o.id===target.orderId),item=order.items[target.index];Object.assign(item,pick(edit,['storeProductId','storeUnitsPerPack']));item.storeExcluded=!!edit.deleted;out.orderEdits||={};out.orderEdits[order.id]={...out.orderEdits[order.id],at:edit.at};}
      else out.storeStockImports[id]={...out.storeStockImports[id],...edit};
    }
    return out;
  }
  root.NmfAccessPolicy={project,mergeGuest,operations,initializeBreakDefaults,storeSettlement,ticketRate,itemsPerTicket};
})(globalThis);
