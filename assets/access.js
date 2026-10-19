// Tokens and admin password are memory-only. A refresh starts as a guest.
(function(){
  'use strict';
  if(!window.NMF_ACCESS_REQUIRED)return;
  const rawFetch=window.fetch.bind(window),get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
  const roots=['namofood_v2','namocafe_v1','namostore_v1'],roomFor={namofood_v2:'namofood',namocafe_v1:'namocafe',namostore_v1:'namostore'};
  const policy=globalThis.NmfAccessPolicy,pendingLegacy=new Map(),revisions=new Map(),privateDrafts=new Map();
  let token='',password='',expires=0,writeChain=Promise.resolve(),cachePending=0,cacheError='',expiryTimer;
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
  const privatePages=new Set(['order','pl','overview','fixed','settings','data']);
  function paint(){
    const bar=document.getElementById('admin-access');if(!bar)return;
    if(isAdmin())bar.innerHTML='<span>관리자 모드</span><button type="button" class="btn small" id="admin-lock">잠그기</button>';
    else bar.innerHTML='<form id="admin-form"><label for="admin-password">관리자</label><input id="admin-password" type="password" inputmode="numeric" autocomplete="off" placeholder="비밀번호" maxlength="128"><button class="btn small" type="submit">열기</button></form><small id="admin-message" role="status"></small>';
    bar.querySelector('#admin-form')?.addEventListener('submit',login);
    bar.querySelector('#admin-lock')?.addEventListener('click',()=>lock(false));
    for(const b of document.querySelectorAll('nav [data-p]'))b.hidden=!isAdmin()&&privatePages.has(b.dataset.p);
    document.documentElement.dataset.access=isAdmin()?'admin':'guest';
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
  function guestSales(){
    if(APP==='store')return '<h1>매점 판매 실적</h1><div class="card"><p>상품별 결제·식권 정산 입력은 관리자 모드에서 이용해 주세요.</p></div>';
    return '<h1>판매 실적 · 식수 입력</h1>'+periodPicker('sales')+periodDays('sales').map(d=>'<div class="card"><h2>'+esc(dateKeyAt(ym(),d))+'</h2><div class="grid2">'+(APP==='cafe'?'<label class="f">판매 잔수<input type="number" min="0" value="'+(salesGet(d,'cups')??'')+'" onchange="salesSet('+d+',\'cups\',this.value)"></label>':MEALS.map(me=>'<section><h3>'+me+'</h3><div class="row"><label class="f">예상 식수<input type="number" min="0" value="'+(S.menus[ym()]?.[d+'|'+me+'|n']??'')+'" placeholder="기본 '+menuCountAt(ym(),d,me)+'" onchange="salesExpectedSet('+d+','+jsarg(me)+',this.value)"></label><label class="f">회수 식권<input type="number" min="0" value="'+(salesGet(d,me)??'')+'" onchange="salesSet('+d+','+jsarg(me)+',this.value)"></label></div><div class="row">'+SALES_COUNT_CHANNELS.map(([k])=>salesCountField(d,k,'day',me)).join('')+'</div></section>').join(''))+'</div></div>').join('');
  }
  function guestRoster(){
    const {off}=ymParts();return '<h1>근무표</h1>'+periodPicker('roster')+'<div class="card"><div class="tbl"><table class="roster"><thead><tr><th>이름</th>'+periodDays('roster').map(d=>'<th>'+d+'일</th>').join('')+'</tr></thead><tbody>'+rosterStaff().map(e=>'<tr><td>'+esc(e.name)+'</td>'+periodDays('roster').map(d=>cellHtml(e,d,(off+d-1)%7)).join('')+'</tr>').join('')+'</tbody></table></div></div>';
  }
  function guestRecipes(){
    const query=recipeQ.trim().toLowerCase(),map=recipeMap();
    return '<h1>레시피</h1><div class="card"><label class="f">음식·재료 검색<input id="rqq" value="'+esc(recipeQ)+'" onchange="recipeQ=this.value;render()" placeholder="검색어를 입력하고 Enter"></label><p class="hint">조리법·재료를 열람할 수 있습니다. 원본 레시피 수정은 관리자 모드에서 이용해 주세요.</p></div>'+Object.keys(map).filter(name=>!query||name.toLowerCase().includes(query)||map[name].some(r=>String(r.item).toLowerCase().includes(query))).sort((a,b)=>a.localeCompare(b,'ko')).map(name=>'<details class="card" '+(rSel===name?'open':'')+'><summary>'+esc(name)+'</summary><div class="tbl"><table><thead><tr><th>재료</th><th>1인 기준량</th></tr></thead><tbody>'+map[name].map(r=>'<tr><td>'+esc(r.item)+'</td><td>'+esc(r.qty)+' '+esc(r.unit)+'</td></tr>').join('')+'</tbody></table></div><p style="white-space:pre-wrap">'+esc(S.methods?.[name]||'')+'</p></details>').join('');
  }
  window.NmfAccess={isAdmin,initialize(){
    const bar=document.createElement('div');bar.id='admin-access';bar.className='noprint';
    const switches=document.querySelector('.appsw'),stack=document.createElement('div');stack.className='access-switch-stack noprint';switches.before(stack);stack.append(switches,bar);
    const originalGo=go,originalRender=render;
    cloudRevisionUnchanged=async function(){
      if(!cloudRemoteAt||!revisions.has(cloud.room))return false;
      const before=cloudRemoteAt;try{const r=await call({action:'rest',method:'GET',path:'/rest/v1/rpc/nmf_state_revision?room='+encodeURIComponent(cloud.room)});if(!r.ok)return false;const [row]=await r.json();return cloudRemoteAt===before&&Date.parse(row?.updated_at)===Date.parse(before)&&row.revision===revisions.get(cloud.room);}catch{return false;}
    };
    go=function(p){return originalGo(!isAdmin()&&privatePages.has(p)?'home':p);};
    const originals={...PAGES};
    for(const p of Object.keys(PAGES))PAGES[p]=()=>{
      if(isAdmin())return originals[p]();
      if(privatePages.has(p))return '<h1>관리자 전용</h1><p>상단에서 관리자 비밀번호를 입력해 주세요.</p>';
      if(p==='home')return '<h1>'+BRAND+' 업무 화면</h1><div class="card"><p>식단·레시피·근무표·식수 입력을 이용할 수 있습니다. 금액·설정·백업은 관리자 전용입니다.</p><button class="btn" onclick="go(\'sales\')">식수 입력</button></div>';
      if(p==='sales')return guestSales();if(p==='roster')return guestRoster();
      if(APP==='store'&&['recipe','board'].includes(p))return '<h1>매점</h1><p>상품·가격 관리는 관리자 전용입니다.</p>';
      if(p==='recipe')return guestRecipes();
      if(['hyg','board'].includes(p))return '<p class="hint">기록 열람 화면입니다. 수정은 관리자 모드를 이용해 주세요.</p><fieldset disabled style="border:0;padding:0;min-width:0">'+originals[p]()+'</fieldset>';
      return originals[p]();
    };
    render=function(){paint();originalRender();if(!isAdmin())document.querySelectorAll('[data-menu-recipe-qty],[data-menu-recipe-item],[data-menu-recipe-unit],[data-menu-delete-ingredient]').forEach(el=>{el.disabled=true;el.title='원본 재료 수정은 관리자 전용입니다.';});if(isAdmin()&&page==='data'){
      const card=document.createElement('div');card.className='card';card.innerHTML='<h2>이 기기 관리자 임시저장</h2><p class="hint">자동으로 서버 자료를 덮어쓰지 않습니다. 필요하면 JSON으로 내려받아 비교하세요.</p><button class="btn" id="admin-draft-download">임시저장 내려받기</button>';
      card.querySelector('button').onclick=async()=>{const blob=get.call(localStorage,KEY+'#admin-draft');if(!blob)return toast('임시저장이 없습니다.');try{const raw=await decryptText(password,blob);const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='관리자_임시저장_'+todayKey()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{toast('임시저장을 열지 못했습니다.');}};document.getElementById('main').prepend(card);
    }};
    const oldMenuSet=menuSet;menuSet=function(d,meal,ci,val,month=ym()){
      if(!isAdmin()){S.menuManualEdits||={};S.menuManualEdits[month]||={};S.menuManualEdits[month][`${d}|${meal}|${ci}`]={at:new Date().toISOString()};}
      return oldMenuSet(d,meal,ci,val,month);
    };
    for(const name of ['rSet','menuIngredientAdd','menuIngredientDelete','setRecipeOrderMultiplier']){
      const original=window[name];if(typeof original==='function')window[name]=function(...args){if(!isAdmin()){toast('원본 레시피·설정 수정은 관리자 모드를 이용해 주세요.');render();return false;}return original(...args);};
    }
    paint();setTimeout(archiveLegacy,1000);
  }};
  addEventListener('beforeunload',event=>{if(cachePending||pendingLegacy.size||cacheError){event.preventDefault();event.returnValue='';}});
  addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
})();
