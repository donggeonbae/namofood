// Tokens and admin password are memory-only. A refresh starts as a guest.
(function(){
  'use strict';
  if(!window.NMF_ACCESS_REQUIRED)return;
  const rawFetch=window.fetch.bind(window),get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
  const roots=['namofood_v2','namocafe_v1','namostore_v1'],roomFor={namofood_v2:'namofood',namocafe_v1:'namocafe',namostore_v1:'namostore'};
  const policy=globalThis.NmfAccessPolicy,pendingLegacy=new Map(),revisions=new Map(),privateDrafts=new Map();
  let token='',password='',expires=0,writeChain=Promise.resolve(),cachePending=0,cacheError='',expiryTimer;
  let operationBase={};
  const endpoint='https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-access';
  function isAdmin(){return !!token&&Date.now()<expires;}
  for(const key of roots){const value=get.call(localStorage,key);if(value){try{const s=JSON.parse(value),publicValue=JSON.stringify(policy.project(s));if(value!==publicValue)pendingLegacy.set(key,value);set.call(localStorage,key,publicValue);}catch{pendingLegacy.set(key,value);remove.call(localStorage,key);}}}
  for(const [app,key]of Object.entries({food:roots[0],cafe:roots[1],store:roots[2]})){
    const draftKey='nmf_card_draft_'+app,value=get.call(localStorage,draftKey);if(!value)continue;
    try{const archive=JSON.parse(pendingLegacy.get(key)||'{"settings":{},"staff":[]}');archive.legacyLocalDrafts||={};archive.legacyLocalDrafts[draftKey]=JSON.parse(value);pendingLegacy.set(key,JSON.stringify(archive));remove.call(localStorage,draftKey);}catch{/* An invalid legacy draft is never silently deleted. */}
  }
  Storage.prototype.getItem=function(key){
    const value=get.call(this,key);
    if(this===localStorage&&roots.includes(key)&&value){try{return JSON.stringify(policy.project(JSON.parse(value)));}catch{return null;}}
    if(this===localStorage&&String(key).startsWith('nmf_card_draft_'))return isAdmin()?(privateDrafts.get(key)||null):null;
    return value;
  };
  Storage.prototype.setItem=function(key,value){
    if(this===localStorage&&roots.includes(key)){
      const s=JSON.parse(value);set.call(this,key,JSON.stringify(policy.project(s)));
      if(isAdmin()){
        const pass=password;cachePending++;
        writeChain=writeChain.then(async()=>{const blob=await encryptText(pass,value);set.call(localStorage,key+'#admin-draft',blob);cacheError='';}).catch(()=>{cacheError='관리자 임시저장 실패 · 서버 저장 상태를 확인해 주세요.';setSave(cacheError);}).finally(()=>cachePending--);
      }
      return;
    }
    if(this===localStorage&&String(key).startsWith('nmf_card_draft_')){
      if(!isAdmin())return;
      privateDrafts.set(key,value);const pass=password;writeChain=writeChain.then(async()=>{const blob=await encryptText(pass,value);if(privateDrafts.get(key)===value)set.call(localStorage,key+'#private',blob);}).catch(()=>{cacheError='카드 임시저장 실패';setSave(cacheError);});return;
    }
    set.call(this,key,value);
  };
  Storage.prototype.removeItem=function(key){if(this===localStorage&&String(key).startsWith('nmf_card_draft_')){privateDrafts.delete(key);remove.call(this,key+'#private');}remove.call(this,key);};
  async function call(body,signal){
    const raw=JSON.stringify(body),time=String(Date.now()),pw=get.call(sessionStorage,'nmf_session_pw')||get.call(localStorage,'nmf_pw');
    if(!pw)throw Error('홈페이지를 다시 열어 로그인해 주세요.');
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('nmf-access\n'+time+'\n'+raw));
    const signature=btoa(String.fromCharCode(...new Uint8Array(signed)));
    return rawFetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-nmf-time':time,'x-nmf-signature':signature,...(isAdmin()?{'x-nmf-admin-session':token}:{})},body:raw,cache:'no-store',signal:signal||AbortSignal.timeout(30000)});
  }
  window.fetch=async function(input,init={}){
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.origin==='https://rycibsczsgbkgtwfxyim.supabase.co'){
      if(url.pathname.startsWith('/rest/v1/')){
        const method=init.method||(input instanceof Request?input.method:'GET');
        // Guest backups are made from the full state on the server, not supplied by an unprivileged browser.
        if(!isAdmin()&&method==='POST'&&String(init.body||'').includes('"id":"'+roomFor[KEY]+'@'))return new Response('[]',{status:200});
        const response=await call({action:'rest',path:url.pathname+url.search,method,prefer:new Headers(init.headers).get('Prefer')||'',body:init.body?JSON.parse(init.body):undefined},init.signal);
        if(response.ok&&method==='GET'&&url.pathname==='/rest/v1/namofood_state'){
          const rows=await response.clone().json(),id=(url.searchParams.get('id')||'').replace(/^eq\./,'');if(rows[0]?.source_revision)revisions.set(id,rows[0].source_revision);
        }
        return response;
      }
      if(['/functions/v1/nmf-invoice-ocr','/functions/v1/nmf-coupang','/functions/v1/nmf-payment-match','/functions/v1/nmf-tax-auto'].includes(url.pathname)&&isAdmin()){
        const headers=new Headers(init.headers||(input instanceof Request?input.headers:{}));headers.set('x-nmf-admin-session',token);return rawFetch(input,{...init,headers});
      }
    }
    return rawFetch(input,init);
  };
  const privatePages=new Set(['pl','overview','fixed','settings','data']);
  let salesTab='sales';
  function ticketHistoryHtml(){
    const dates=new Set();for(const key of Object.keys(S.sales[ym()]||{}))if(/^\d+\|(?:ticketIssued|ticketBuyer|ticketCompany)/.test(key))dates.add(dateKeyAt(ym(),Number(key.split('|')[0])));
    const rows=[...dates].sort().reverse().map(date=>{const day=foodTicketDay(date);return '<tr><td><button class="btn small" onclick="NmfAccess.openTicketDate('+jsarg(date)+')">'+esc(date)+'</button></td><td>'+day.companies.map(c=>esc(c.name||'회사 미입력')).join(' · ')+'</td><td class="num">'+(day.issued===null?'미입력':num(day.issued,0)+'장')+'</td><td class="num">'+(day.issued===null?'미입력':won(day.amount))+'</td></tr>';}).join('');
    return '<section class="card" data-ticket-history><h2>'+kmonth()+' 식권 거래 기록</h2><p class="hint">날짜를 누르면 기존 회사별 판매 내역을 열어 수정할 수 있습니다.</p><div class="tbl"><table><thead><tr><th>날짜</th><th>거래 회사</th><th>판매 식권</th><th>거래 금액</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(rows?'':'<p class="hint">이 달에 입력된 회사 식권 거래가 없습니다. 다른 달은 위 날짜에서 선택하세요.</p>')+'</section>';
  }
  function sharedSalesHtml(original){
    if(APP==='cafe')return cafeDailySalesHtml();
    if(APP==='store')return storeChannelSalesHtml(original());
    if(APP!=='food')return original();
    if(salesTab==='ticket')return '<h1>식권</h1>'+periodPicker('sales')+foodTicketLedgerHtml(periodCurrent('sales').date)+ticketHistoryHtml();
    const t=document.createElement('template');t.innerHTML=original();t.content.querySelectorAll('#food-ticket-ledger,#food-ticket-documents').forEach(el=>el.remove());return t.innerHTML;
  }
  const storeChannels=[['ticketQty','식권'],['cardQty','카드'],['cashQty','현금'],['creditQty','당일 외상']];
  function storeChannelSalesHtml(html){
    const t=document.createElement('template');t.innerHTML=html;const date=periodCurrent('sales').date,day=Number(date.slice(8));
    for(const tr of t.content.querySelectorAll('[data-store-sale]')){
      const id=tr.dataset.storeSale,sale=S.storeSales[date+'|'+id],old=sale&&!sale.deleted?sale:null,disabled=old&&!old.paymentSplit&&old.qty>0;
      const editButton=tr.querySelector('[data-store-payment-open]');if(editButton)editButton.textContent=old?.paymentSplit?'결제별 수량 수정':'결제별 입력';
      if(S.storeProducts[id]?.priceConfigured)tr.querySelectorAll('small').forEach(el=>{if(el.textContent.includes('판매가 설정 필요'))el.remove();});
      tr.cells[0].insertAdjacentHTML('beforeend','<div class="store-channel-grid">'+storeChannels.map(([key,label])=>'<label class="f">'+label+'(개)<input type="number" min="0" step="1" data-store-channel="'+key+'" data-product-id="'+esc(id)+'" value="'+(old?.paymentSplit?old[key]??0:'')+'" placeholder="0" '+(disabled?'disabled title="기존 미분류 기록은 결제별 수량 수정에서 전환해 주세요."':'')+' oninput="NmfAccess.setStoreChannel('+day+','+jsarg(id)+','+jsarg(key)+',this)" onchange="render()"></label>').join('')+'</div>');
    }return t.innerHTML;
  }
  function setStoreChannel(day,id,key,el){
    if(!storeChannels.some(([k])=>k===key))return false;const raw=el.value.replaceAll(',','').trim(),n=raw===''?0:Number(raw);if(!Number.isSafeInteger(n)||n<0){el.setCustomValidity('0 이상의 상품 개수를 입력하세요.');return false;}el.setCustomValidity('');
    const date=dateKeyAt(ym(),day),k=date+'|'+id,p=S.storeProducts[id],old=S.storeSales[k];if(!p&&!old)return false;if(old&&!old.paymentSplit&&old.qty>0)return false;
    const priced=old?.price??p?.price;if(priced==null&&!(old?.priceConfigured||p?.priceConfigured)){toast('관리자에게 상품 판매가 설정을 요청해 주세요.');return false;}
    const row={...(old||{id,date,name:p.name,category:p.category,unit:p.unit,price:priced,cost:p.cost}),...Object.fromEntries(storeChannels.map(([key])=>[key,old?.paymentSplit?old[key]??0:0])),[key]:n};
    if(!row.ticketQty&&row.tickets>0){toast('실제로 받은 식권 장수를 먼저 비워 주세요.');return false;}
    row.qty=storeChannels.reduce((sum,[key])=>sum+row[key],0);row.paymentSplit=true;row.deleted=false;row.at=storeStamp(old);S.storeSales[k]=row;save();return true;
  }
  function cafeDailySalesHtml(){
    const date=periodCurrent('sales').date,d=Number(date.slice(8)),field=(day,key,label)=>'<label class="f">'+label+'<input type="text" inputmode="numeric" data-cafe-amount="'+key+'" data-sales-day-number="'+day+'" value="'+esc(_fmtNum(salesGet(day,key)))+'" placeholder="미입력" onchange="NmfAccess.setCafeAmount('+day+',\''+key+'\',this)"></label>';
    const rows=periodDays('sales').map(day=>'<tr><td>'+esc(dateKeyAt(ym(),day))+'</td><td>'+field(day,'rev','당일 매출(원)')+'</td><td>'+field(day,'other','기타 매출(원)')+'</td>'+(isAdmin()?'<td class="num">'+won(dayRevenue(day))+'</td>':'')+'</tr>').join('');
    return '<h1>카페 판매 실적</h1><p class="sub">포스기에서 확인한 날짜별 매출 금액을 입력하세요. 판매 잔수는 입력하지 않습니다. 기타 매출은 포스기 매출에 포함되지 않은 금액만 적어 주세요.</p>'+periodPicker('sales')+'<section class="card" data-cafe-daily><h2>'+esc(date)+' 매출 입력</h2><div class="row">'+field(d,'rev','당일 매출(원)')+field(d,'other','기타 매출(원)')+'</div></section>'+(isAdmin()?'<section class="card" data-cafe-month-summary><h2>'+kmonth()+' 월간 매출</h2><b>'+won(salesSummary().revenue)+'</b></section>':'')+'<section class="card"><h2>날짜별 입력</h2><div class="tbl"><table><thead><tr><th>날짜</th><th>당일 매출(원)</th><th>기타 매출(원)</th>'+(isAdmin()?'<th>일 합계</th>':'')+'</tr></thead><tbody>'+rows+'</tbody></table></div></section>';
  }
  function paint(){
    const bar=document.getElementById('admin-access');if(!bar)return;
    if(isAdmin())bar.innerHTML='<span>관리자 모드</span><button type="button" class="btn small" id="admin-lock">잠그기</button>';
    else bar.innerHTML='<form id="admin-form"><label for="admin-password">관리자</label><input id="admin-password" type="password" inputmode="numeric" autocomplete="off" placeholder="비밀번호" maxlength="128"><button class="btn small" type="submit">열기</button></form><small id="admin-message" role="status"></small>';
    bar.querySelector('#admin-form')?.addEventListener('submit',login);
    bar.querySelector('#admin-lock')?.addEventListener('click',()=>lock(false));
    for(const b of document.querySelectorAll('nav [data-p]'))b.hidden=!isAdmin()&&privatePages.has(b.dataset.p);
    document.documentElement.dataset.access=isAdmin()?'admin':'guest';
    bar.classList.toggle('is-admin',isAdmin());
  }
  async function archiveLegacy(){
    for(const [key,raw]of pendingLegacy){
      try{
        const parsed=JSON.parse(raw);if(!parsed.settings||!parsed.staff)continue;
        const pw=get.call(sessionStorage,'nmf_session_pw')||get.call(localStorage,'nmf_pw');
        const r=await call({action:'archiveLocal',room:roomFor[key],data:await encryptText(pw,raw)});
        if(!r.ok)throw Error();pendingLegacy.delete(key);
      }catch{setCloudStatus('☁ 이전 기기 자료 보관 대기 · 창을 닫기 전 관리자 확인 필요',false);}
    }
  }
  async function login(event){
    event.preventDefault();const input=document.getElementById('admin-password'),pass=input.value;input.value='';const button=event.currentTarget.querySelector('button');button.disabled=true;
    try{
      if(cloudBusy||cloudDirty||saveTimer){await cloudSave(true);if(cloudBusy||cloudDirty)throw Error('현재 입력 저장이 끝난 뒤 다시 열어 주세요.');}
      const r=await call({action:'login',password:pass}),j=await r.json();if(!r.ok)throw Error(j.error||'관리자 인증 실패');
      if(typeof j.cacheKey!=='string'||j.cacheKey.length<32)throw Error('관리자 보안 설정을 확인해 주세요.');
      token=j.token;expires=j.expiresAt;password=j.cacheKey;
      for(const app of ['food','cafe','store']){const key='nmf_card_draft_'+app,blob=get.call(localStorage,key+'#private');if(blob)try{privateDrafts.set(key,await decryptText(password,blob));}catch{toast('이전 카드 임시저장을 열지 못했습니다. 기존 파일은 보존합니다.');}}
      // Full state is loaded only after server authentication. Do not merge projected defaults into private fields.
      const remote=await cloudFetch();if(!remote)throw Error('서버 자료를 찾지 못했습니다.');
      const pw=get.call(sessionStorage,'nmf_session_pw')||get.call(localStorage,'nmf_pw');
      S=normalize(Object.assign(defaultState(),JSON.parse(await decryptText(pw,remote.data))));
      operationBase=policy.operations(S);
      cloudRemoteAt=remote.updated_at;cloudRemoteData=remote.data;cloudDirty=false;
      cloudMenuBase=captureCloudMenuBase(S);cloudStaffBase=captureCloudStaffBase(S);cloudConfigBase=captureCloudConfigBase(S);cloudOrderBase=captureCloudOrderBase(S);cloudCardBase=captureCloudCardBase(S);cloudSalesBase=captureCloudSalesBase(S);
      const draft=get.call(localStorage,KEY+'#admin-draft');
      paint();render();
      if(draft){try{const restored=JSON.parse(await decryptText(password,draft));if(JSON.stringify(restored)!==JSON.stringify(S))toast('이 기기의 이전 관리자 임시저장은 백업 화면에서 내려받을 수 있습니다. 서버 자료는 그대로 유지합니다.');}catch{toast('이전 관리자 임시저장을 열 수 없습니다. 서버 자료는 정상입니다.');}}
      clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>lock(true),Math.max(0,expires-Date.now()));
    }catch(error){token='';password='';expires=0;S=normalize(Object.assign(defaultState(),policy.project(S)));paint();go('home');document.getElementById('admin-message').textContent=error.message;}
  }
  async function lock(force){
    if(!force&&(cloudBusy||saveTimer||cloudDirty)){clearTimeout(saveTimer);saveTimer=null;try{await cloudSave(true);}catch{}if(cloudBusy||cloudDirty){toast('입력을 저장하지 못해 잠그지 않았습니다. 저장 상태를 확인해 주세요.');return;}}
    await writeChain;
    if(password){try{set.call(localStorage,KEY+'#admin-draft',await encryptText(password,JSON.stringify(S)));}catch{toast('기기 임시저장에 실패했습니다. 서버 저장 내역을 확인해 주세요.');}}
    token='';password='';expires=0;privateDrafts.clear();clearTimeout(expiryTimer);
    S=normalize(Object.assign(defaultState(),policy.project(S)));cloudRemoteAt='';cloudRemoteData='';
    // Remove detached dialogs, previews and data URLs as well as financial DOM.
    document.querySelectorAll('dialog').forEach(el=>el.remove());document.getElementById('codepick').style.display='none';
    document.getElementById('main').replaceChildren();paint();go('home');
    // Clear all private lexical caches without persisting a login token.
    location.reload();
  }
  function scheduleHtml(){
    rosterBulkSync();
    const {off}=ymParts(),days=periodDays('roster'),mode=periodViews.roster.mode,people=rosterStaff();
    const week=rosterBulk.activeWeek??Math.floor((off+Number(periodCurrent('roster').date.slice(8))-1)/7),active=rosterBulk.enabled;
    const head=days.map(d=>'<th>'+((active&&rosterBulkActiveDay(d))?'<input class="roster-bulk-group noprint" type="checkbox" aria-label="'+d+'일 전체 선택" onchange="selectRosterBulkDay('+d+')">':'')+d+'일<small>'+KDAY[(off+d-1)%7]+'</small></th>').join('');
    const rows=people.map(e=>'<tr><td class="roster-person" title="'+esc(e.name)+'">'+((active)?'<input class="roster-bulk-group noprint" type="checkbox" aria-label="'+esc(e.name)+' 주차 선택" onchange="selectRosterBulkRow('+jsarg(e.id)+','+week+')">':'')+'<span>'+esc(e.name||'이름 없음')+'</span></td>'+days.map(d=>cellHtml(e,d,(off+d-1)%7)).join('')+'</tr>').join('');
    const count='<tr class="chk"><td class="roster-person">근무 인원</td>'+days.map(d=>'<td>'+people.filter(e=>isWork(rosterGet(e.id,d))).length+'</td>').join('')+'</tr>';
    const weeks=Math.ceil((off+ymParts().days)/7);
    return '<section class="card common-roster" data-roster-common><div class="row noprint roster-common-toolbar"><b>'+kmonth()+' 근무표</b><label class="f">일괄 입력 주차<select aria-label="일괄 입력 주차" onchange="toggleRosterBulk(true,+this.value)">'+Array.from({length:weeks},(_,w)=>'<option value="'+w+'" '+(w===week?'selected':'')+'>'+(w+1)+'주 · '+rosterBulkWeekRange(w)+'</option>').join('')+'</select></label><button class="btn small" onclick="toggleRosterBulk('+(!active)+','+week+')">'+(active?'일괄 입력 닫기':'여러 칸 선택 · 일괄 입력')+'</button></div>'+rosterBulkPanel(week)+'<div class="tbl"><table class="roster unified-roster '+(mode==='month'?'roster-monthly':'')+'" data-roster-mode="'+mode+'"><colgroup><col class="roster-person-col">'+days.map(()=>'<col>').join('')+'</colgroup><thead><tr><th class="roster-person">이름</th>'+head+'</tr></thead><tbody>'+rows+count+'</tbody></table></div></section>';
  }
  function commonRoster(html){
    const t=document.createElement('template');t.innerHTML=html;
    const blocks=[...t.content.querySelectorAll('.roster-week-card')],replacement=document.createElement('div');replacement.innerHTML=scheduleHtml();
    if(blocks.length){blocks[0].replaceWith(replacement);blocks.slice(1).forEach(el=>el.remove());}
    return t.innerHTML;
  }
  function removeMoney(html,currentPage){
    const t=document.createElement('template');t.innerHTML=html;const root=t.content;
    if(currentPage==='order'){
      root.querySelector('#invoice-monthly-summary')?.remove();root.querySelector('[data-order-view="card"]')?.remove();
      root.querySelectorAll('.kpi').forEach(el=>{if(/금액|식재비|미수|공급가|세액/.test(el.textContent))el.remove();});
      return t.innerHTML;
    }
    if(APP==='cafe'&&currentPage==='sales')return html;
    const retained=[];for(const el of root.querySelectorAll('#food-ticket-ledger,#food-ticket-documents,[data-ticket-history]')){const marker=document.createComment('shared-ticket-operations');el.replaceWith(marker);retained.push([marker,el]);}
    root.querySelectorAll('input').forEach(el=>{if(el.hasAttribute('data-sales-other')||/salesSet\([^)]*,\s*['"]other['"]/.test((el.getAttribute('oninput')||'')+' '+(el.getAttribute('onchange')||'')))el.dataset.publicEntry='other';});
    root.querySelectorAll('[data-admin-only],[data-month-company-sales],[data-sales-month-total],#ticketMealStats,[data-sales-xlsx],[data-sales-export-status],#staffRoleSettings').forEach(el=>el.remove());
    root.querySelectorAll('.kpi').forEach(el=>{if(/원|매출|인건비|급여|순익|수익|수당|사업자 부담|세금/.test(el.textContent))el.remove();});
    root.querySelectorAll('table').forEach(table=>{
      const header=table.tHead?.rows[table.tHead.rows.length-1];if(!header)return;
      const count=header.cells.length,money=[...header.cells].flatMap((cell,i)=>(/금액|단가|판매가|가격|매출|원가|시급|수당|급여|지급|공제|실입금|연락|계좌/.test(cell.textContent)||/^(HOT|ICE)$/.test(cell.textContent.trim()))&&!/일 합계|기타.*매출|지급·관리/.test(cell.textContent)?[i]:[]);
      for(const row of table.rows)if(row.cells.length===count)for(const i of [...money].reverse())row.cells[i]?.remove();
      const columns=[...table.querySelectorAll(':scope > colgroup > col')];for(const i of [...money].reverse())columns[i]?.remove();
    });
    root.querySelectorAll('input,select,textarea').forEach(el=>{
      if(el.hasAttribute('data-public-entry')||el.hasAttribute('data-staff-paid'))return;
      const action=[el.getAttribute('oninput'),el.getAttribute('onchange'),el.dataset.field].join(' '),label=el.closest('label');
      if(/(?:wage|bonus|burden|deduct|tax|account|bank|phone|roleWage|staffPayment|payrollMethod|insured|ticketIssuePrice|ticketIssued)|(?:storeSaleSet\([^)]*,\s*['"](?:price|cost)['"])|(?:S\.prices)/i.test(action)||label&&/\(원\)|（원）|금액|매출|시급|수당|계좌|전화|연락처|이메일/.test(label.textContent)) (label||el.closest('td')||el).remove();
    });
    root.querySelectorAll('button,a').forEach(el=>{
      const action=el.getAttribute('onclick')||'';
      if(/salesExportXlsx|csvSales|storeSalesCsv|openStaffDetails|staffDeduction|staffPayment|staffPay|fixedDoc|foodTicket|downloadJSON/.test(action))el.remove();
      if(privatePages.has((/go\(['"]([^'"]+)/.exec(action)||[])[1]))el.remove();
    });
    // Retain the same day/month cards and input controls; only money parts disappear.
    root.querySelectorAll('.sales-meal-money').forEach(el=>{
      const hint=el.nextElementSibling,total=hint?.querySelector('b');
      if(hint?.classList.contains('hint')&&total)hint.replaceChildren(document.createTextNode('식수 입력 합계 '),total);
    });
    root.querySelectorAll('[data-sales-meal-comparison] span').forEach(el=>{if(/금액|회수액/.test(el.textContent))el.remove();});
    root.querySelectorAll('[data-sales-day-total]').forEach(el=>{
      const first=el.firstElementChild;if(first){const b=first.querySelector('b');if(b&&first.textContent.startsWith('회사 판매')){b.previousSibling?.remove();b.nextSibling?.remove();b.remove();}}
      el.querySelectorAll('.hint,[data-sales-unassigned]').forEach(child=>child.remove());
      [...el.children].filter(child=>/실제 매출/.test(child.textContent)).forEach(child=>child.remove());
    });
    if(currentPage==='roster'){
      root.querySelector('#staff-payroll-table')?.closest('.card')?.remove();
      // Directory operations remain shared; wage/contact/payroll documents stay private.
      root.querySelectorAll('.staff-detail-button,.staff-order-controls,.staff-insured').forEach(el=>el.remove());
      const archiveHint=root.querySelector('#staffArchive > p.hint');if(archiveHint)archiveHint.textContent='보관 직원도 이름 수정·명단 복귀·삭제와 선택 월의 지급 완료 체크가 가능합니다. 명단에서 삭제해도 기존 근무 기록은 유지됩니다. 이전 이름으로도 검색할 수 있습니다.';
    }
    if(APP==='store'){
      const form=root.querySelector('#store-add-form');if(form)form.innerHTML='<h2>새 상품 추가</h2><p class="hint">새 상품·가격 설정은 관리자 모드에서 합니다. 등록된 상품의 판매수량은 일반 모드에서도 입력할 수 있습니다.</p>';
      root.querySelectorAll('[data-field="price"],[data-field="cost"]').forEach(el=>el.closest('td')?.remove());
    }
    root.querySelectorAll('[data-sales-extra]:not([data-sales-other])').forEach(el=>(el.closest('label')||el).remove());
    root.querySelectorAll('.pr').forEach(el=>el.remove());
    root.querySelectorAll('.row > b,.row > span').forEach(el=>{if(/매출|금액|원가|단가/.test(el.textContent))el.remove();});
    // Mixed footer cells have count totals and currency. Drop currency-only leaf nodes, not count inputs/cards.
    const nodes=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),texts=[];while(nodes.nextNode())texts.push(nodes.currentNode);
    for(const text of texts){if(/^[\s+−-]*[\d,.]+원[\s]*$/.test(text.textContent))text.parentElement?.remove();}
    for(const [marker,el]of retained)marker.replaceWith(el);
    root.querySelectorAll('.grid2,.grid3,.row').forEach(el=>{if(!el.children.length&&!el.textContent.trim())el.remove();});
    return t.innerHTML;
  }
  window.NmfAccess={isAdmin,setStoreChannel,showSalesTab(tab){go(tab==='ticket'?'ticketSales':'sales');},openTicketDate(date){if(!invoiceValidDate(date))return;S.month=date.slice(0,7);periodViews.sales={mode:'day',date};go('ticketSales');},setCafeAmount(day,key,el){const raw=el.value.replaceAll(',','').trim();if(!['rev','other'].includes(key)||raw!==''&&(!/^\d+$/.test(raw)||!Number.isSafeInteger(+raw))){el.setCustomValidity('0 이상의 원 단위 금액을 입력하세요.');return false;}el.setCustomValidity('');salesSet(day,key,raw);render();return true;},initialize(){
    const bar=document.createElement('div');bar.id='admin-access';bar.className='noprint';
    const switches=document.querySelector('.appsw'),stack=document.createElement('div');stack.className='access-switch-stack noprint';switches.before(stack);stack.append(switches,bar);
    const originalGo=go,originalRender=render;
    if(APP==='food'){PAGES.ticketSales=PAGES.sales;const ticketNav=document.createElement('button');ticketNav.dataset.p='ticketSales';ticketNav.innerHTML='<span class="ic">🎫</span>식권';ticketNav.addEventListener('click',()=>go('ticketSales'));document.querySelector('nav [data-p=sales]').after(ticketNav);}
    const originalTicketScope=foodTicketUiScope;foodTicketUiScope=function(){const before=foodTicketUi.scope,result=originalTicketScope();if(before!==foodTicketUi.scope)foodTicketUi.settingsOpen=true;return result;};foodTicketUi.settingsOpen=true;
    const originalStorePayment=storePaymentOpen;storePaymentOpen=function(day,id){originalStorePayment(day,id);const dialog=document.getElementById('store-payment-dialog');if(!dialog)return;const old=S.storeSales[dateKeyAt(ym(),day)+'|'+id],tickets=dialog.querySelector('[data-store-payment=tickets]')?.closest('label');tickets?.insertAdjacentHTML('beforebegin','<label class="f">당일 외상으로 판매한 상품 수<input data-store-payment="creditQty" type="number" min="0" step="1" value="'+(old?.creditQty??'')+'" placeholder="0"></label>');dialog.querySelector('p.hint:last-of-type').textContent='총 판매 수량 = 식권·카드·현금·외상 상품 수 합계. 카드·현금·외상은 당시 판매가 기준으로 매출에 포함합니다. 실제 받은 식권 장수는 따로 입력하며, 식권 회수에 현금·카드·외상 수량은 포함하지 않습니다.';};
    const originalPaidCurrent=staffPaymentCurrent;staffPaymentCurrent=function(row,month=ym()){const record=staffPayment(row.e.id,month);return record?.basis==='manual-check-v1'?!!record.paid:originalPaidCurrent(row,month);};
    const originalSetPaid=setStaffPaid;setStaffPaid=function(id,paid,month=ym()){
      const row=laborRows().find(r=>r.e.id===id);if(isAdmin()&&row&&staffNetPay(row,month).ready)return originalSetPaid(id,paid,month);
      if(month!==ym()||!findStaff(id))return;const previous=staffPayment(id,month),at=new Date(Math.max(Date.now(),(Date.parse(previous?.at)||0)+1)).toISOString();S.staffPayments||={};S.staffPayments[month]||={};S.staffPayments[month][id]={paid:!!paid,basis:'manual-check-v1',at,paidAt:paid?at:null};save();render();
    };
    const originalArchivePayment=staffArchivePaymentHtml;staffArchivePaymentHtml=function(e,row){if(isAdmin()&&row&&staffNetPay(row).ready)return originalArchivePayment(e,row);return '<label class="payroll-paid"><input type="checkbox" data-staff-paid="'+esc(e.id)+'" '+(staffPayment(e.id)?.paid?'checked':'')+' onchange="setStaffPaid('+jsarg(e.id)+',this.checked)">'+kmonth()+' 지급 완료</label>';};
    const originalRosterCsv=csvRoster;csvRoster=function(){if(isAdmin())return originalRosterCsv();const days=periodDays('roster');csv('근무표_'+ym(),[['이름',...days.map(d=>d+'일')],...rosterStaff().map(e=>[e.name,...days.map(d=>{const c=rosterGet(e.id,d);return isWork(c)?c.s+'~'+c.e+' (휴게 '+c.b+'분)':c||'';})])]);};
    for(const name of ['invoiceMonthlySummaryHtml','invoicePaymentHtml','paymentAiPanelHtml','coupangPanelHtml']){const original=window[name];window[name]=function(...args){return isAdmin()?original(...args):'';};}
    for(const name of ['paymentAiSchedule','coupangResume']){const original=window[name];window[name]=function(...args){if(isAdmin())return original(...args);};}
    operationBase=policy.operations(S);
    const originalSave=save;save=function(){
      const next=policy.operations(S);if(!cloudApplying){S.accessEdits||={};for(const key of new Set([...Object.keys(operationBase),...Object.keys(next)]))if(JSON.stringify(operationBase[key])!==JSON.stringify(next[key]))S.accessEdits[key]={at:new Date(Math.max(Date.now(),(Date.parse(S.accessEdits[key]?.at)||0)+1)).toISOString()};}
      operationBase=next;return originalSave();
    };
    const originalApply=applyState;applyState=function(...args){const result=originalApply(...args);operationBase=policy.operations(S);return result;};
    cloudRevisionUnchanged=async function(){
      if(!cloudRemoteAt||!revisions.has(cloud.room))return false;
      const before=cloudRemoteAt;try{const r=await call({action:'rest',method:'GET',path:'/rest/v1/rpc/nmf_state_revision?room='+encodeURIComponent(cloud.room)});if(!r.ok)return false;const [row]=await r.json();return cloudRemoteAt===before&&Date.parse(row?.updated_at)===Date.parse(before)&&row.revision===revisions.get(cloud.room);}catch{return false;}
    };
    go=function(p){if(p==='ticketSales'){salesTab=APP==='food'?'ticket':'sales';p='sales';}else if(p==='sales')salesTab='sales';return originalGo(!isAdmin()&&privatePages.has(p)?'home':p);};
    const originals={...PAGES};
    for(const p of Object.keys(PAGES))PAGES[p]=()=>{
      if(!isAdmin()&&privatePages.has(p))return '<h1>관리자 전용</h1><p>상단에서 관리자 비밀번호를 입력해 주세요.</p>';
      if(p==='order'&&!isAdmin()&&orderView==='card')orderView='sheet';
      const html=p==='roster'?commonRoster(originals[p]()):p==='sales'?sharedSalesHtml(originals[p]):originals[p]();
      return isAdmin()?html:removeMoney(html,p);
    };
    render=function(){paint();originalRender();if(APP==='food'){const ticket=page==='sales'&&salesTab==='ticket';document.querySelector('nav [data-p=ticketSales]')?.classList.toggle('on',ticket);document.querySelector('nav [data-p=sales]')?.classList.toggle('on',page==='sales'&&!ticket);if(ticket)history.replaceState(null,'','#ticketSales');}if(isAdmin()&&page==='data'){
      const card=document.createElement('div');card.className='card';card.innerHTML='<h2>이 기기 관리자 임시저장</h2><p class="hint">자동으로 서버 자료를 덮어쓰지 않습니다. 필요하면 JSON으로 내려받아 비교하세요.</p><button class="btn" id="admin-draft-download">임시저장 내려받기</button>';
      card.querySelector('button').onclick=async()=>{const blob=get.call(localStorage,KEY+'#admin-draft');if(!blob)return toast('임시저장이 없습니다.');try{const raw=await decryptText(password,blob);const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='관리자_임시저장_'+todayKey()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{toast('임시저장을 열지 못했습니다.');}};document.getElementById('main').prepend(card);
    }};
    const oldMenuSet=menuSet;menuSet=function(d,meal,ci,val,month=ym()){
      if(!isAdmin()){S.menuManualEdits||={};S.menuManualEdits[month]||={};S.menuManualEdits[month][`${d}|${meal}|${ci}`]={at:new Date().toISOString()};}
      return oldMenuSet(d,meal,ci,val,month);
    };
    paint();setTimeout(archiveLegacy,1000);
  }};
  addEventListener('beforeunload',event=>{if(cachePending||pendingLegacy.size||cacheError){event.preventDefault();event.returnValue='';}});
  addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
})();
