const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const live=process.env.NMF_LIVE==='1',version=process.env.NMF_VERSION||'1013-7-roster-profit';if(live&&!process.env.NMF_PW)throw Error('NMF_PW required');
 const p=await browser.newPage({timezoneId:'Asia/Seoul'});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 if(live)await p.addInitScript(pw=>{localStorage.setItem('nmf_app','food');sessionStorage.setItem('nmf_session_pw',pw);},process.env.NMF_PW);
 await p.route('**/*',r=>{const req=r.request(),url=new URL(req.url());if(!live)return req.isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort();if(url.pathname==='/rest/v1/namofood_state'&&req.method()==='GET')return r.fulfill({json:[]});return ['GET','HEAD','OPTIONS'].includes(req.method())?r.continue():r.abort();});
 await p.goto(live?'https://d-bae.com/namofood/?v='+version:'https://offline.namofood.test');if(live)await p.waitForFunction(v=>document.getElementById('appver')?.textContent==='버전 '+v,version,{timeout:45000});
 const result=await p.evaluate(()=>{
  clearInterval(cloudPollTimer);clearTimeout(cloudTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';S.settings.opdays=31;S.settings.night=.5;S.settings.burden=.1;S.settings.vacancy=.05;S.settings.roleWages={'보조':13000};
  const employee=(id,wage,bonus=0)=>({id,name:id,role:'보조',wage,bonus,off:[],def:{s:'09:00',e:'18:00',b:60}});
  S.staff=[employee('active',10000,30000),employee('role',null),employee('future',20000,99000),employee('zero',20000,55000)];
  S.staffArchive=[{...employee('stored',null,5000),archivedWage:16000,archivedAt:'2026-10-12T00:00:00Z'}];S.staffEdits={stored:{status:'archive',listed:false}};
  const day={s:'09:00',e:'18:00',b:60};S.roster={'2026-10':{'active|1':day,'active|13':{s:'22:00',e:'06:00',b:60},'active|14':day,'active|adj':-5000,'stored|12':{s:'12:00',e:'16:00',b:30},'stored|adj':1000,'role|13':{s:'06:00',e:'10:00',b:0},'role|12':'연차','future|14':day,'zero|2':{s:'00:00',e:'00:00',b:0},'zero|adj':77000}};
  S.sales={};salesSet(13,'other',1000000);salesSet(14,'other',700000);S.orders={'2026-10':[{id:'invoice',date:'2026-10-02',total:130000}]};S.fixedMonthly={'2026-10':[['임대',310000]]};S.supplies=[];
  const state=JSON.stringify(S),full=JSON.stringify(laborRows()),r=profitProgress('2026-10-13'),unchanged=state===JSON.stringify(S),defaultUnchanged=full===JSON.stringify(laborRows());
  salesSet(1,'other',0);const zeroSaleDay=profitProgress('2026-10-13'),past=profitProgress('2026-11-01');
  const cutoff=laborRows(13).map(x=>({id:x.e.id,h:x.h,nh:x.nh,wage:x.wage,pay:x.pay,total:x.total})),beforeWork=laborRows(0);
  S.month='2026-11';const futureMonth=profitProgress('2026-10-13');S.month='2026-10';todayStr=()=> '2026-10-13';go('pl');
  return {r,zeroSaleDay,past,cutoff,beforeWork,futureMonth,unchanged,defaultUnchanged,fullTotal:JSON.parse(full).reduce((n,x)=>n+x.total,0),hint:document.querySelector('#profit-progress').innerText};
 });
 const close=(actual,expected,label)=>assert(Math.abs(actual-expected)<1e-6,`${label}: ${actual} != ${expected}`);
 close(result.r.actual.labor,372600,'actual roster cost through Oct 13, not sales-day allocation');close(result.r.actual.ebit,487400,'roster cost deducted from accrued profit');close(result.r.actual.fixed,10000,'fixed allocation unchanged');
 close(result.r.forecast.labor,762450,'full-month roster includes future shifts');close(result.fullTotal,762450,'default payroll unchanged');close(result.zeroSaleDay.actual.labor,372600,'zero-sale recorded day cannot alter roster labor');close(result.past.actual.labor,762450,'past month includes all its shifts');
 assert.equal(result.r.salesDays,1);assert.equal(result.zeroSaleDay.salesDays,2);assert(result.unchanged&&result.defaultUnchanged,'calculation is read-only');assert.deepEqual(result.beforeWork,[]);assert.equal(result.futureMonth.elapsed,0);assert.equal(result.futureMonth.actual,null);
 assert.deepEqual(result.cutoff.map(x=>({id:x.id,h:x.h,nh:x.nh,wage:x.wage,pay:x.pay})),[{id:'active',h:15,nh:7,wage:10000,pay:210000},{id:'role',h:4,nh:0,wage:13000,pay:52000},{id:'stored',h:3.5,nh:0,wage:16000,pay:62000}],'breaks, overnight premiums, role wages and hidden stored employees preserved; leave/zero/future shifts excluded');
 assert(result.hint.includes('근무표'));assert(result.hint.includes('월 고정수당'));assert(!result.hint.includes('인건비·고정비는 기존 방식대로'),'no contradictory payroll allocation hint');
 for(const width of [1280,390,320]){await p.setViewportSize({width,height:1000});assert(await p.evaluate(()=>{const el=document.querySelector('#main');return el.scrollWidth<=el.clientWidth+1;}),'profit fits '+width);}
 assert.deepEqual(errors,[]);console.log('PROFIT_ROSTER_CUTOFF_ARCHIVE_NIGHT_BREAK_ALLOWANCE_FULL_MONTH_AND_READ_ONLY_OK'+(live?' · deployed '+version+' · all writes blocked':''));
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
