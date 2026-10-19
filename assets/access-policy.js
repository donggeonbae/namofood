// Shared server/browser projection. Fields not explicitly admitted stay private.
(function (root) {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const pick = (x, keys) => Object.fromEntries(keys.filter(k => x && Object.hasOwn(x,k)).map(k=>[k,clone(x[k])]));
  const meals = ['조식','중식','석식','야식'];
  const safeKey = k => !['__proto__','constructor','prototype'].includes(k);
  const salesKey = k => /^([1-9]|[12]\d|3[01])\|(?:(?:cashCount|cardCount|creditCount)\|)?(?:조식|중식|석식|야식)$/.test(k) || /^([1-9]|[12]\d|3[01])\|cups$/.test(k);
  const rosterKey = k => /^[a-zA-Z0-9_-]{1,100}\|([1-9]|[12]\d|3[01])$/.test(k);
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
    const settings=pick(s.settings||{},['shifts','staffRoles','recipeOrderMultiplier','printMeals']);
    settings.meals=Object.fromEntries(meals.map(m=>[m,pick(s.settings?.meals?.[m]||{},['count'])]));
    // Archive contact/payroll fields, purchasing, taxes and corporate ticket sales never cross this boundary.
    const staff = a => (a||[]).map(e=>({...pick(e,['id','name','role','off','archivedAt']),...(e.def?{def:pick(e.def,['s','e','b'])}:{})}));
    const out=pick(s,['month','updatedAt','view','menus','menuManualEdits','menuExtraSlots','menuExtraEdits','menuRetirements','methods','hyg','cafeSeeded','board']);
    Object.assign(out,{settings,staff:staff(s.staff),staffArchive:staff(s.staffArchive),
      recipes:(s.recipes||[]).map(r=>pick(r,['comp','menu','item','qty','unit','storage','loss','form','method','allergy'])),
      roster:maps(s.roster,rosterKey,v=>v&&typeof v==='object'?pick(v,['s','e','b']):v),rosterEdits:maps(s.rosterEdits,rosterKey,v=>pick(v,['at','deleted'])),
      sales:maps(s.sales,salesKey),salesEdits:maps(s.salesEdits,salesKey,v=>pick(v,['at']))});
    return out;
  }
  function mergeGuest(full, incoming) {
    const out=clone(full), staffIds=new Set([...(full.staff||[]),...(full.staffArchive||[])].map(e=>e.id));
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
    return out;
  }
  root.NmfAccessPolicy={project,mergeGuest};
})(globalThis);
