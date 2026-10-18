// Real encrypted deployment/room reads. No provider calls or production writes.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const pw=process.env.NMF_PW;if(!pw)throw Error('NMF_PW required');const version=process.env.NMF_EXPECTED_VER||'1018-2-overview',b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const p=await b.newPage(),errors=[],reads=[];let writes=0;p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(pw=>{localStorage.setItem('nmf_app','store');sessionStorage.setItem('nmf_session_pw',pw);},pw);
 await p.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(!['GET','HEAD','OPTIONS'].includes(r.method())){writes++;return route.abort();}if(u.pathname==='/rest/v1/namofood_state')reads.push((u.searchParams.get('id')||'').replace(/^eq\./,''));return route.continue();});
 await p.goto('https://d-bae.com/namofood/?v='+version);await p.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
 await p.waitForFunction(()=>cloudRemoteAt||document.getElementById('cloudstate').textContent.includes('아직 저장된 데이터 없음'),null,{timeout:20000});
 await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;});const before=await p.evaluate(()=>JSON.stringify(S));
 await p.locator('nav [data-p="overview"]').click();await p.waitForFunction(()=>overview.loaded&&!overview.busy,null,{timeout:30000});
 const states=await p.evaluate(()=>overviewModel().rows.map(r=>({app:r.app,status:r.status})));assert(states.every(r=>['ready','empty'].includes(r.status)),JSON.stringify(states));assert(reads.includes('namofood')&&reads.includes('namocafe'),'peer encrypted rooms were actually read');
 const n=reads.length;await p.locator('#overview-month').fill('2026-09');assert.equal(reads.length,n,'month change stays local');assert.equal(await p.evaluate(()=>JSON.stringify(S)),before,'report never applies source states');
 assert.equal(await p.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--navy').trim()),'#245438','store uses dark green');assert.equal(writes,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({version,states,peerRoomsRead:true,sourceUnchanged:true,darkGreen:true,productionWrites:writes,providerCalls:0}));
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
