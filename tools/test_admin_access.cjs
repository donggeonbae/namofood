// Uses a fake backend and disposable test password; never reads/writes production data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict'),zlib=require('node:zlib'),{chromium}=require('playwright');
require('../assets/access-policy.js');
const pw='test-common',admin='test-admin',python='/Users/donggeonbae/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
function encrypt(text){const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=crypto.pbkdf2Sync(pw,salt,150000,32,'sha256'),c=crypto.createCipheriv('aes-256-gcm',key,iv),ct=Buffer.concat([c.update(zlib.gzipSync(Buffer.from(text))),c.final(),c.getAuthTag()]);return JSON.stringify({v:1,z:1,salt:salt.toString('base64'),iv:iv.toString('base64'),ct:ct.toString('base64')});}
(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nmf-access-test-'));cp.execFileSync(python,['encrypt_app.py','나모푸드_관리앱.html',temp,pw],{stdio:'pipe'});
  const loader=fs.readFileSync(path.join(temp,'index.html'),'utf8'),blob=JSON.parse(loader.match(/<script id="payload" type="application\/json">(.*?)<\/script>/s)[1]);
  const ciphertext=Buffer.from(blob.ct,'base64'),key=crypto.pbkdf2Sync(pw,Buffer.from(blob.salt,'base64'),blob.iter,32,'sha256'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(blob.iv,'base64'));d.setAuthTag(ciphertext.subarray(-16));
  const html=Buffer.concat([d.update(ciphertext.subarray(0,-16)),d.final()]).toString();assert(html.includes('window.NMF_ACCESS_REQUIRED=true'));assert(!html.includes("['최동희','배선호','최영환']"));
  const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(e.message));let state,apiReads=0,privateCalls=0;const at='2026-10-19T01:00:00.000Z';
    await p.addInitScript(pw=>sessionStorage.setItem('nmf_session_pw',pw),pw);
    await p.route('**/*',async r=>{const req=r.request(),u=new URL(req.url());
      if(req.isNavigationRequest())return r.fulfill({contentType:'text/html',body:html});
      if(u.pathname.endsWith('/nmf-access')){
        const body=req.postDataJSON(),auth=req.headers()['x-nmf-admin-session']==='test-token';
        if(body.action==='login')return r.fulfill({status:body.password===admin?200:403,json:body.password===admin?{token:'test-token',expiresAt:Date.now()+3600000,cacheKey:"test-only-strong-cache-key-32-characters"}:{error:'관리자 비밀번호가 맞지 않습니다.'}});
        if(body.action==='archiveLocal')return r.fulfill({json:{ok:true}});
        const rest=new URL(body.path,'https://test');
        if(rest.pathname.includes('/rpc/'))return r.fulfill({json:[{updated_at:at,revision:'a'.repeat(64)}]});
        if(!state)state=await p.evaluate(()=>{const s=defaultState();s.month='2026-10';s.staff=[{id:'staff-a',name:'직원',role:'조리',wage:19999,phone:'PRIVATE_PHONE',def:{s:'09:00',e:'18:00',b:60},off:[]}];s.settings.fixed=[['PRIVATE_FIXED',123456]];s.settings.rolePayInitialized=true;s.settings.wage=19999;s.settings.roleWages={조리:19999};s.sales={'2026-10':{'19|ticketIssued':1000,'19|중식':10}};s.orders={'2026-10':[{id:'private-order',date:'2026-10-19',vendor:'PRIVATE_VENDOR',total:123456,items:[]}]};return s;});
        if(!auth&&(rest.searchParams.get('id')||'').includes('#')){privateCalls++;return r.fulfill({status:403,json:{error:'admin_required'}});}
        if(body.method!=='GET')return r.fulfill({json:[{id:'namofood'}]});
        apiReads++;return r.fulfill({json:[{data:encrypt(JSON.stringify(auth?state:globalThis.NmfAccessPolicy.project(state))),updated_at:at,source_revision:'a'.repeat(64)}]});
      }
      return r.abort();
    });
    await p.goto('https://offline.namofood.test');await p.waitForFunction(()=>!!cloudRemoteAt);await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudDirty=false;});
    assert(await p.locator('#admin-password').isVisible());for(const name of ['settings','data','pl','overview','fixed','order'])assert(await p.locator('nav [data-p='+name+']').isHidden(),name);
    assert(!JSON.stringify(await p.evaluate(()=>S)).includes('PRIVATE_'));assert.equal(await p.evaluate(()=>S.staff[0].wage),undefined);
    await p.evaluate(()=>go('settings'));assert.equal(await p.evaluate(()=>page),'home');
    await p.evaluate(()=>go('sales'));assert(await p.getByRole('heading',{name:'판매 실적 · 식수 입력'}).isVisible());assert(!(await p.locator('#main').innerText()).includes('이달 실제 매출'));
    await p.evaluate(()=>go('roster'));assert(!await p.locator('#staff-payroll-table').count());assert(!(await p.locator('#main').innerText()).includes('시급'));
    await p.evaluate(()=>go('recipe'));assert(await p.locator('#main details').count()>0);assert((await p.locator('#main').innerText()).includes('원본 레시피 수정은 관리자'));
    const before=apiReads;assert(await p.evaluate(()=>cloudRevisionUnchanged()));assert.equal(apiReads,before,'revision check must not download state');
    await p.locator('#admin-password').fill('wrong');await p.locator('#admin-form button').click();await p.waitForFunction(()=>document.getElementById('admin-message').textContent.includes('맞지'));assert.equal(await p.locator('#admin-password').inputValue(),'');
    await p.evaluate(()=>{clearTimeout(saveTimer);cloudDirty=false;});await p.locator('#admin-password').fill(admin);await p.locator('#admin-form button').click();await p.waitForFunction(()=>NmfAccess.isAdmin());await p.waitForFunction(()=>S.staff[0]?.wage===19999);
    for(const name of ['settings','data','pl','overview','fixed','order'])assert(await p.locator('nav [data-p='+name+']').isVisible(),name);
    await p.evaluate(()=>{go('settings');});assert((await p.locator('#main').innerText()).includes('설정'));
    await p.evaluate(()=>{localStorage.setItem(KEY,JSON.stringify(S));});await p.waitForTimeout(450);
    const caches=await p.evaluate(()=>Object.entries(localStorage));assert(caches.some(([key])=>key.endsWith('#admin-draft')));for(const [,value]of caches){assert(!value.includes('PRIVATE_PHONE'));assert(!value.includes('PRIVATE_FIXED'));assert(!value.includes('test-token'));assert(!value.includes('test-admin'));}
    await p.reload();await p.waitForFunction(()=>document.getElementById('admin-password'));assert(!await p.evaluate(()=>NmfAccess.isAdmin()));assert(await p.locator('nav [data-p=settings]').isHidden());
    for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});await p.evaluate(()=>go('home'));assert(await p.evaluate(()=>main.scrollWidth<=main.clientWidth+1));assert(await p.locator('#admin-access').evaluate(e=>e.scrollWidth<=e.clientWidth+1));const box=await p.locator('#admin-form button').boundingBox();assert(box.x>=0&&box.x+box.width<=width,'login button must fit on screen');}
    assert.deepEqual(errors,[]);console.log('ADMIN_GUEST_SERVER_PROJECTION_SETTINGS_BACKUP_DENIAL_LOGIN_CACHE_ENCRYPTION_RELOAD_RELOCK_REVISION_NO_FULL_DOWNLOAD_MOBILE_OK');
  }finally{await b.close();fs.rmSync(temp,{recursive:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
