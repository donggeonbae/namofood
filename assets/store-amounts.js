// Retail inputs are shared operational data; costs and financial summaries are not.
(function(root){
  'use strict';
  const policy=root.NmfAccessPolicy,fields=['tickets','cardAmount','cashAmount'];
  const fmt=v=>Number(v).toLocaleString('ko-KR',{maximumFractionDigits:6});
  const perTicket=p=>policy.itemsPerTicket(p);
  function context(date,id){
    const product=S.storeProducts?.[id],stored=S.storeSales?.[date+'|'+id],old=stored&&!stored.deleted?stored:null;
    if(!product&&!old)throw Error('상품을 찾을 수 없습니다.');
    const base=stored?{...stored,ticketUnits:stored.ticketUnits??(stored.price==null?null:stored.price/10000)}:product;
    return {product,old,base,stored};
  }
  function initial(old){return old?.settlementMode==='amount-v1'?old:{tickets:old?.tickets??'',cardAmount:old?.paymentSplit?(old.cardQty||0)*old.price:'',cashAmount:old?.paymentSplit?(old.cashQty||0)*old.price:''};}
  function status(row,message,error=false){const el=row.querySelector('[data-store-status]');el.textContent=message;el.style.color=error?'#b42318':'';}
  function values(row){return Object.fromEntries(fields.map(k=>{const raw=row.querySelector('[data-store-amount="'+k+'"]').value.replaceAll(',','').trim();if(!/^\d*$/.test(raw))throw Error('식권 장수와 결제 금액은 0 이상의 정수로 입력하세요.');return [k,raw===''?0:Number(raw)];}));}
  function preview(el){
    const row=el.closest('[data-store-amount-row]');try{const c=context(row.dataset.date,row.dataset.productId),n=policy.storeSettlement(c.base,values(row));row.querySelector('[data-store-qty]').textContent=fmt(n.qty)+' '+(c.base.unit||'개');status(row,'식권 '+fmt(n.ticketQty)+' · 카드 '+fmt(n.cardQty)+' · 현금 '+fmt(n.cashQty)+'개 · 다른 칸을 누르면 저장');return n;}catch(e){row.querySelector('[data-store-qty]').textContent='확인 필요';status(row,e.message,true);return null;}
  }
  function commit(el){
    const row=el.closest('[data-store-amount-row]'),date=row.dataset.date,id=row.dataset.productId;let c;try{c=context(date,id);}catch(e){status(row,e.message,true);return;}
    if((c.stored?.at||'')!==row.dataset.basis){status(row,'다른 기기에서 수정됐습니다. 화면을 다시 열고 입력해 주세요.',true);return;}
    const result=preview(el);if(!result)return;
    if(c.old&&c.old.settlementMode!=='amount-v1'&&!confirm('기존 기록 '+fmt(c.old.qty)+'개를 새 결제 기준 '+fmt(result.qty)+'개로 전환할까요? 기존 외상·미분류 수량은 새 입력으로 대체됩니다. 실제 식권 장수와 카드·현금 금액을 확인해 주세요.')){render();return;}
    if(c.old?.settlementMode==='amount-v1'&&fields.every(k=>c.old[k]===result[k]))return;
    const next={...c.base,id,date,...result,deleted:false,at:storeStamp(c.stored)};
    S.storeSales||={};S.storeSales[date+'|'+id]=next;row.dataset.basis=next.at;save();
    status(row,'저장 대기 · 식권 '+fmt(result.ticketQty)+' · 카드 '+fmt(result.cardQty)+' · 현금 '+fmt(result.cashQty)+'개');
    // Refresh derived panels without replacing any in-progress input.
    const derived=document.querySelector('[data-store-derived]');if(derived)derived.innerHTML=derivedHtml(date,NmfAccess.isAdmin());
  }
  function styles(){return `<style>
    .card>table.store-amount-table{display:table;width:100%;table-layout:fixed;border-collapse:collapse}.card>table.store-amount-table thead{display:table-header-group}.card>table.store-amount-table tbody{display:table-row-group}.card>table.store-amount-table tr{display:table-row}.store-amount-table th,.store-amount-table td{padding:10px 8px;vertical-align:top;overflow-wrap:anywhere}.store-amount-table th:first-child{width:27%}
    .store-amount-table input,.store-product-grid input{box-sizing:border-box;width:100%;min-width:0;font-variant-numeric:tabular-nums}.store-amount-table input{background:#fff9d9;color:#19324b;padding:8px;font-size:14px;text-align:right}.store-amount-table small{display:block;font-size:12px;line-height:1.6}.store-amount-table [data-store-status]{margin-top:5px}.store-amount-table [data-store-qty]{font-weight:700;white-space:nowrap}
    .store-product-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.store-product-grid label{display:grid;gap:4px;font-size:12px;min-width:0}.store-product-card .row{margin-top:8px}
    @media screen{
      #store-add-form{padding:12px}#store-add-form .store-product-grid{grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}#store-add-form input{font-size:13px;min-height:30px;padding:4px 6px}
      .store-catalog-wrap{max-height:min(70vh,720px);overflow:auto;overscroll-behavior:contain}
      .store-catalog-table{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:12px}
      .store-catalog-table th{position:sticky;top:0;z-index:2;padding:7px 5px;font-size:12px;white-space:normal}
      .store-catalog-table th:first-child{width:25%}.store-catalog-table th:last-child{width:12%}
      .store-catalog-table th:nth-child(2){width:9%}.store-catalog-table th:nth-child(3){width:5%}
      .store-catalog-stock strong,.store-catalog-stock small{display:block}.store-catalog-stock strong{font-size:13px}.store-catalog-stock small{font-size:10px;color:#526272}
      .store-catalog-table td{padding:5px;vertical-align:top;min-width:0;overflow-wrap:anywhere}
      .store-catalog-table input{width:100%;min-width:0;min-height:28px;padding:4px;font-size:13px;border-radius:4px}
      .store-catalog-table td[data-label=단위]{width:48px}.store-catalog-table [data-field=cost]{text-align:right}
      .store-catalog-table .btn.small{min-height:26px;padding:3px 6px;font-size:11px;margin:2px 0}
      .store-catalog-table small{font-size:11px;line-height:1.4}.store-catalog-table [data-store-spec]{display:block;color:#526272;padding:3px 0;overflow-wrap:anywhere}
      .store-catalog-table td[data-label=관리] .btn{display:block;max-width:100%}.store-catalog-table details>summary{font-size:11px}
      @media(max-width:800px){#store-add-form .store-product-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:650px){#store-add-form .store-product-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.store-catalog-wrap{max-height:70vh}.store-catalog-table,.store-catalog-table tbody{display:block}.store-catalog-table thead{display:none}.store-catalog-table tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid #ccd4dc;padding:5px 0}.store-catalog-table td{display:block;border:0;padding:4px}.store-catalog-table td:first-child,.store-catalog-table td:last-child{grid-column:1/-1}.store-catalog-table td[data-label]::before{content:attr(data-label);display:block;font-size:10px;color:#526272;margin-bottom:3px}.store-catalog-table td:first-child::before{display:none}.store-catalog-table input{font-size:16px;min-height:32px}.store-catalog-table td[data-label=관리]{display:flex;gap:5px;flex-wrap:wrap;align-items:center}.store-catalog-table td[data-label=관리]::before{display:none}}
    }
    @media(max-width:650px){.card>table.store-amount-table thead{display:none}.card>table.store-amount-table,.card>table.store-amount-table tbody{display:block}.card>table.store-amount-table tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid #ccd4dc;padding:10px 0}.store-amount-table td{display:block;border:0;min-width:0;padding:5px}.store-amount-table td:first-child,.store-amount-table td:last-child{grid-column:1/-1}.store-amount-table td[data-label]::before{content:attr(data-label);display:block;font-size:11px;color:#586779;margin-bottom:4px}.store-amount-table input,.store-product-grid input{font-size:16px}.store-product-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>`;}
  function rowHtml(date,p){
    const {old,base,stored}=context(date,p.id),input=initial(old),r=perTicket(base),ready=Number.isSafeInteger(base.price)&&base.price>=0&&r!=null;
    return `<tr data-store-amount-row data-product-id="${esc(p.id)}" data-date="${date}" data-basis="${esc(stored?.at||'')}"><td><b>${esc(base.name)}</b><small>${esc(base.category||'')} · ${esc(base.unit||'개')}</small><small>개당 ${base.price==null?'판매가 미설정':fmt(base.price)+'원'}</small><small>식권 1장 = ${r==null?'미설정':fmt(r)+' '+esc(base.unit||'개')}</small>${old&&old.settlementMode!=='amount-v1'?'<small>기존 기록 유지 · 수정 시 전환 확인</small>':''}</td>${[['tickets','받은 식권(장)'],['cardAmount','카드(원)'],['cashAmount','현금(원)']].map(([key,label])=>`<td data-label="${label}"><input type="text" inputmode="numeric" data-store-amount="${key}" aria-label="${esc(base.name+' '+label)}" value="${esc(input[key]??'')}" placeholder="0" ${ready?'':'disabled'} oninput="NmfStoreAmountsUI.preview(this)" onchange="NmfStoreAmountsUI.commit(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>`).join('')}<td data-label="판매 수량 · 자동"><span data-store-qty>${old?fmt(old.qty)+' '+esc(base.unit||'개'):'—'}</span><small data-store-status role="status">${ready?'식권·카드·현금에서 수량을 계산합니다.':'상품 관리에서 판매가·식권 기준을 설정하세요.'}</small></td></tr>`;
  }
  function derivedHtml(date,admin){
    const history=periodDays('sales').map(d=>{const s=storeSummary(d);return `<tr><td><button class="btn small" onclick="periodViews.sales={mode:'day',date:${jsarg(dateKeyAt(ym(),d))}};render()">${dateKeyAt(ym(),d)}</button></td><td>${fmt(s.count)}개</td><td>${fmt(s.tickets)}장</td>${admin?'<td>'+won(s.revenue)+'</td>':''}</tr>`;}).join('');
    return storeStockHtml(date)+(admin?'<h2>'+kmonth()+' 전체 합계</h2>'+storeKpis(storeSummary()):'')+`<section class="card"><div class="row"><h2>날짜별 판매 수량</h2><button class="btn small" onclick="storeSalesCsv()">CSV 내려받기</button></div><table class="store-table"><thead><tr><th>날짜</th><th>판매 수량</th><th>받은 식권</th>${admin?'<th>매출</th>':''}</tr></thead><tbody>${history}</tbody></table></section>`;
  }
  function sales(admin){
    storeProductsFromOrders();const date=periodCurrent('sales').date,day=Number(date.slice(8)),map=new Map(storeProductGroups().map(p=>[p.id,p]));
    for(const r of Object.values(S.storeSales||{}))if(r&&!r.deleted&&r.date===date&&!map.has(r.id)&&(!S.storeProducts?.[r.id]?.deleted||storeShowArchived))map.set(r.id,r);
    return styles()+`<h1>매점 판매 실적</h1><p class="sub">받은 식권은 장수, 카드·현금은 결제한 원으로 입력하세요. 상품별 판매 수량은 자동 계산합니다.</p>${periodPicker('sales')}
      ${storeArchivedToolsHtml()}<section class="card"><div class="row"><h2>${date} 판매 입력</h2><button class="btn small" onclick="go('recipe')">상품 · 판매가 · 식권 설정 →</button></div>
      <p class="hint">식권 1장 = 10,000원. 예: 개당 2,500원 · 식권 1장당 4개 상품은 식권 1장 → 4개, 카드 12,500원 → 5개. 수정 후 다른 칸을 누르면 저장됩니다.</p>
      <table class="store-amount-table store-sales-table"><thead><tr><th>상품 · 적용 기준</th><th>받은 식권(장)</th><th>카드(원)</th><th>현금(원)</th><th>판매 수량 · 자동</th></tr></thead><tbody>${[...map.values()].map(p=>rowHtml(date,p)).join('')||'<tr><td colspan="5">상품 관리에서 판매할 항목을 추가하세요.</td></tr>'}</tbody></table>
      <label class="f" style="margin-top:12px">기타 매출(원)<input type="text" inputmode="numeric" data-sales-other value="${esc(_fmtNum(salesGet(day,'other')))}" onchange="NmfAccess.setCafeAmount(${day},'other',this)"></label></section>
      <div data-store-derived>${derivedHtml(date,admin)}</div>`;
  }
  function products(admin){
    storeProductsFromOrders();const labels=[['name','상품명'],['category','분류'],['unit','단위'],['price','개당 판매가(원)'],['itemsPerTicket','식권 1장당 수량'],...(admin?[['cost','매입단가(원)']]:[])];
    const field=(p,key,label)=>`<label>${label}<input data-field="${key}" ${['price','cost','itemsPerTicket'].includes(key)?'type="number" min="0" step="'+(key==='itemsPerTicket'?'0.000001':'1')+'"':''} aria-label="${esc((p?.name||'새 상품')+' '+label)}" ${p?'':'id="store-'+key+'"'} value="${esc(p?(key==='itemsPerTicket'?(perTicket(p)==null?null:Number(perTicket(p).toFixed(6))):p[key])??'':key==='unit'?'개':'')}" ${p?'onchange="storeProductSet('+jsarg(p.id)+','+jsarg(key)+',this.value)"':''} ${key==='itemsPerTicket'?'placeholder="예: 4 · 비우면 10,000 ÷ 판매가"':''}></label>`;
    const cell=(p,key,label)=>`<td data-label="${label}">${field(p,key,label).replace(/^<label>[^<]*/,'').replace(/<\/label>$/,'').replace('storeProductSet(','storeCatalogSet(')}${key==='name'?`<small data-store-spec>규격: ${esc(p.sourceSpec||'미기재 · 발주서 확인')}</small>`:''}${key==='cost'?(()=>{const info=storeCatalogPurchaseInfo(p.id);return `<small>${info.average===null?'발주 평균 계산 불가':'발주 가중평균 '+fmt(info.average)+'원'}${info.varied?' · ⚠ 매입가 다른 발주 있음':''}${p.purchaseCostAuto===false?' · 직접 설정':''}</small>`;})():''}</td>`;
    const products=storeCatalogMonthProducts(),stockCell=p=>{const s=storeCatalogInventory(p.id);return `<td data-label="이월 · 입고 · 판매 · 잔여" class="store-catalog-stock"><strong>${fmt(s.remaining)} ${esc(p.unit||'개')}</strong><small>이월 ${fmt(s.opening)} · 입고 ${fmt(s.received)}<br>판매 ${fmt(s.sold)}${s.missing?' · ⚠ 수량 확인 '+s.missing+'건':''}${s.remaining<0?' · ⚠ 판매 초과':''}</small></td>`;};
    return styles()+`<h1>매점 상품 관리</h1>${monthPicker()}<p class="sub">같은 상품·규격·단위를 한 줄로 모았습니다. 용량·크기가 다르면 별도 상품입니다. 규격과 연결 발주서를 확인하세요.</p><p class="hint">매입가는 확인된 총 구매금액 ÷ 총 개수의 가중평균(원 단위 반올림)입니다. 개수 미확인 품목은 발주집계에서 확인 후 추가됩니다. 지난달 잔여는 이월하고, 전월 완판 상품은 제외합니다. 폐기·반품·실사 미반영 장부 수량입니다. 판매가·식권 기준 변경은 새 판매 기록부터 적용됩니다.</p>${storeArchivedToolsHtml()}<form class="card" id="store-add-form" onsubmit="event.preventDefault();storeProductAdd()"><h2>새 상품 추가</h2><div class="store-product-grid">${labels.map(([key,label])=>field(null,key,label)).join('')}</div><button class="btn primary" style="margin-top:8px">상품 추가</button></form><section class="card" style="padding:12px"><h2>${kmonth()} 판매 상품 ${products.length}개</h2><div class="store-catalog-wrap" role="region" tabindex="0" aria-label="매점 상품 목록 · 내부 스크롤"><table class="store-catalog-table"><thead><tr>${labels.map(([,label])=>`<th scope="col">${label}</th>`).join('')}<th scope="col">이월 · 입고 · 판매 · 잔여</th><th scope="col">관리</th></tr></thead><tbody>${products.map(p=>`<tr data-store-product="${esc(p.id)}">${labels.map(([key,label])=>cell(p,key,label)).join('')}${stockCell(p)}<td data-label="관리">${admin?`<button class="btn small" data-store-cost-calculate onclick="storeCostCalculator(${jsarg(p.id)})">구매금액 ÷ 개수</button>`:''}<button class="btn small danger" onclick="storeProductDelete(${jsarg(p.id)})">상품 삭제</button></td></tr>`).join('')||`<tr><td colspan="${labels.length+2}">등록된 상품이 없습니다. 개수 미입력 발주는 발주집계에서 수량을 확인해 주세요.</td></tr>`}</tbody></table></div></section>`;
  }
  function exportCsv(admin){
    const header=['날짜','상품명','단위','판매 수량','받은 식권(장)','카드 결제액(원)','현금 결제액(원)','당시 판매가(원)','식권 1장당 수량','식권 판매 수량','카드 판매 수량','현금 판매 수량','입력 방식','기존 외상 수량(보존)',...(admin?['정산 매출','당시 매입단가']:[])];
    const rows=Object.values(S.storeSales||{}).filter(r=>r&&!r.deleted&&r.date.startsWith(ym()+'-')).sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name,'ko')).map(r=>[r.date,r.name,r.unit,r.qty,r.tickets??'',r.settlementMode==='amount-v1'?r.cardAmount:r.paymentSplit?r.cardQty*r.price:'',r.settlementMode==='amount-v1'?r.cashAmount:r.paymentSplit?r.cashQty*r.price:'',r.price??'',perTicket(r)??'',r.ticketQty??'',r.cardQty??'',r.cashQty??'',r.settlementMode==='amount-v1'?'식권·결제금액':'기존 수량 기록',r.creditQty||'',...(admin?[storeSaleRevenue(r),r.cost??'']:[])]);
    for(let d=1;d<=ymParts().days;d++)if(salesGet(d,'other')!=null){const r=Array(header.length).fill('');r[0]=dateKeyAt(ym(),d);r[1]='기타 매출';r[12]='기타 매출 '+salesGet(d,'other')+'원';if(admin)r[14]=salesGet(d,'other');rows.push(r);}
    csv('나모매점_판매실적_'+ym(),[header,...rows]);
  }
  root.NmfStoreAmountsUI={sales,products,preview,commit,exportCsv};
})(globalThis);
