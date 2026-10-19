// Shared server/browser projection. Fields not explicitly admitted stay private.
(function (root) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => x && Object.hasOwn(x,k)).map(k=>[k,clone(x[k])]));
  const meals = ['조식','중식','석식','야식'];
  const safeKey = k => !['__proto__','constructor','prototype'].includes(k);
  const salesKey = k => /^([1-9]|[12]\d|3[01])\|(?:(?:cashCount|cardCount|creditCount)\|)?(?:조식|중식|석식|야식)$/.test(k) || /^([1-9]|[12]\d|3[01])\|cups$/.test(k);
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
  const productFields=['id','name','category','unit','at','deleted','sourceIdentity','sourceSpec'];
  const saleFields=['id','date','name','category','unit','qty','tickets','ticketQty','cardQty','cashQty','paymentSplit','deleted','at'];
  const priced=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  const stockFields=['id','orderNo','date','name','spec','unit','qty','storeProductId','storeUnitsPerPack','at','deleted'];
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
    // Archive contact/payroll fields, purchasing, taxes and corporate ticket sales never cross this boundary.
    const staff = a => (a||[]).map(e=>({...pick(e,['id','name','role','off','archivedAt']),...(e.def?{def:pick(e.def,['s','e','b'])}:{})}));
    const out=pick(s,['month','updatedAt','view','menus','menuManualEdits','menuExtraSlots','menuExtraEdits','menuRetirements','methods','hyg','cafeSeeded','recipeAsk','recipeResolutions','sources','accessEdits']);
    out.recipeMeta=Object.fromEntries(Object.entries(s.recipeMeta||{}).filter(([name])=>safeKey(name)).map(([name,v])=>[name,pick(v,['by','updated','cookingProfile'])]));
    out.board=boardView(s);
    out.storeProducts=Object.fromEntries(Object.entries(s.storeProducts||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,{...pick(v,productFields),priceConfigured:priced(v.price)}]));
    out.storeSales=Object.fromEntries(Object.entries(s.storeSales||{}).filter(([id])=>safeKey(id)).map(([id,v])=>[id,{...pick(v,saleFields),priceConfigured:priced(v.price)}]));
    out.storeStockImports=stockView(s).rows;
    Object.assign(out,{settings,staff:staff(s.staff),staffArchive:staff(s.staffArchive),
      recipes:(s.recipes||[]).map(r=>pick(r,recipeFields)),
      roster:maps(s.roster,rosterKey,v=>v&&typeof v==='object'?pick(v,['s','e','b']):v),rosterEdits:maps(s.rosterEdits,rosterKey,v=>pick(v,['at','deleted'])),
      sales:maps(s.sales,salesKey),salesEdits:maps(s.salesEdits,salesKey,v=>pick(v,['at']))});
    return initializeBreakDefaults(out);
  }
  function mergeGuest(full, incoming) {
    const out=initializeBreakDefaults(clone(full)), staffIds=new Set([...(full.staff||[]),...(full.staffArchive||[])].map(e=>e.id));
    const count = v => Number.isSafeInteger(v)&&v>=0&&v<=1000000;
    const clock = v => typeof v?.at==='string'&&Number.isFinite(Date.parse(v.at))&&Date.parse(v.at)<=Date.now()+300000;
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
    merge('sales','salesEdits',salesKey,count);
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
      }else if(key==='board'){
        out.board||={};Object.assign(out.board,pick(ops.board,['title','sub','note','hideUnpriced','order']));out.board.items||={};
        for(const [name,value]of Object.entries(ops.board.items)){out.board.items[name]={...out.board.items[name],...pick(value,['on','desc'])};}
      }else continue;
      out.accessEdits[key]={at:edit.at};
    }
    out.storeProducts||={};
    for(const [id,p]of Object.entries(incoming.storeProducts||{})){
      const old=out.storeProducts[id];if(!safeKey(id)||!old||!clock(p)||Date.parse(p.at)<=Date.parse(old.at||'1970-01-01'))continue;
      if(['name','category','unit'].some(k=>typeof p[k]!=='string'||!p[k].trim()||p[k].length>100))throw Error('invalid_product');
      out.storeProducts[id]={...old,...pick(p,['name','category','unit','at','deleted'])};
    }
    out.storeSales||={};
    for(const [key,r]of Object.entries(incoming.storeSales||{})){
      if(!safeKey(key)||!r||!clock(r)||!/^20\d{2}-\d{2}-\d{2}$/.test(r.date)||key!==r.date+'|'+r.id)continue;
      const old=out.storeSales[key],product=out.storeProducts[r.id];if(!old&&!product||old&&Date.parse(r.at)<=Date.parse(old.at||'1970-01-01'))continue;
      if(!count(r.qty)||r.tickets!=null&&!count(r.tickets))throw Error('invalid_store_quantity');
      if(r.paymentSplit&&(['ticketQty','cardQty','cashQty'].some(k=>!count(r[k]))||r.qty!==r.ticketQty+r.cardQty+r.cashQty||!r.ticketQty&&r.tickets>0))throw Error('invalid_store_channels');
      const base=old||{id:r.id,date:r.date,name:product.name,category:product.category,unit:product.unit,price:product.price,cost:product.cost};
      if(!priced(base.price))throw Error('store_price_needs_admin');
      out.storeSales[key]={...base,...pick(r,['qty','tickets','ticketQty','cardQty','cashQty','paymentSplit','deleted','at'])};
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
  root.NmfAccessPolicy={project,mergeGuest,operations,initializeBreakDefaults};
})(globalThis);
