const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const p=await b.newPage();await p.addInitScript(()=>{localStorage.setItem('nmf_app','store');localStorage.setItem('nmf_supa_store','{"url":"","key":""}');});
 await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());
 await p.goto('https://coupang-date-defaults.test');
 await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;todayStr=()=> '2026-10-21';cloud.url='https://coupang-date-defaults.test';cloud.key='fixture';S.month='2026-09';coupangUi.from='';coupangUi.to='';coupangApi=async action=>{if(action==='defaults')return new Promise(resolve=>window.defaultsReply=resolve);throw Error('unexpected');};go('order');});
 await p.waitForFunction(()=>typeof defaultsReply==='function');
 assert.equal(await p.locator('#coupang-to').inputValue(),'2026-10-21','end is today, not selected month end');
 await p.evaluate(()=>defaultsReply({ok:true,worker:{online:true,lastImportThrough:'2026-10-18'}}));
 await p.waitForFunction(()=>document.querySelector('#coupang-from').value==='2026-10-19');
 await p.evaluate(()=>{coupangApplyDateDefaults({lastImportThrough:'2026-10-31'});});
 assert.equal(await p.locator('#coupang-from').inputValue(),'2026-10-21','future or already-imported today never creates inverted dates');
 await p.locator('#coupang-from').fill('2026-10-05');await p.locator('#coupang-from').press('Tab');
 await p.evaluate(()=>coupangApplyDateDefaults({lastImportThrough:'2026-10-20'}));
 assert.equal(await p.locator('#coupang-from').inputValue(),'2026-10-05','late server response must not overwrite manual range');
 const before=await p.evaluate(()=>JSON.stringify(S));await p.evaluate(()=>coupangDefaults());assert.equal(await p.evaluate(()=>JSON.stringify(S)),before,'defaults never write business records');
 console.log('COUPANG_LAST_SUCCESS_NEXT_DAY_TODAY_MANUAL_INPUT_PROTECTED_NO_LEDGER_WRITE_OK');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
