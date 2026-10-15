// Synthetic read-only visual checks: never fetch or mutate real business data.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:fs.readFileSync('나모푸드_관리앱.html','utf8')}):r.abort());await p.goto('https://offline.namofood.test');
 await p.evaluate(()=>{clearInterval(cloudPollTimer);clearTimeout(cloudTimer);clearTimeout(saveTimer);cloudApplying=true;S=normalize(defaultState());S.month='2026-10';S.orders={'2026-10':[{id:'wide-invoice',date:'2026-10-12',vendor:'화면 검증용 업체',note:'저장 자료 아님',total:300000,items:[{id:'wide-row',name:'세제',qty:6,price:35000,amt:180000}]}]};});
 const before=await p.evaluate(()=>JSON.stringify({orders:S.orders,sales:S.sales,roster:S.roster,staff:S.staff}));let checks=0;
 for(const width of [1440,1699,1700,1920,2560,3440,390,320]){await p.setViewportSize({width,height:1100});for(const page of ['order','sales','roster','pl','fixed','menu','recipe','settings','home','data','hyg']){
  await p.evaluate(name=>go(name),page);await p.waitForTimeout(25);
  const layout=await p.evaluate(()=>{const main=document.getElementById('main'),m=main.getBoundingClientRect(),style=getComputedStyle(main),left=m.left+parseFloat(style.paddingLeft),right=m.left+main.clientWidth-parseFloat(style.paddingRight),center=(left+right)/2;return {fits:main.scrollWidth<=main.clientWidth+1,contentWidth:right-left,issues:[...main.children].filter(el=>{const c=getComputedStyle(el),r=el.getBoundingClientRect();return r.width>0&&r.height>0&&['block','flex','grid','flow-root'].includes(c.display)&&!['fixed','absolute'].includes(c.position)&&!['BUTTON','INPUT','LABEL','A','SELECT'].includes(el.tagName);}).map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id,class:el.className,delta:Math.abs((r.left+r.right)/2-center)};}).filter(el=>el.delta>1)};});
  assert(layout.fits,page+' fits '+width);if(width>=1700){assert(layout.contentWidth<=1581,page+' bounded reading width '+width);assert.deepEqual(layout.issues,[],page+' shares one content center at '+width);}checks++;
  if(page==='order'&&[1920,2560].includes(width))await p.screenshot({path:'/tmp/nmf-wide-order-'+width+'.png',fullPage:true});
 }}
 assert.equal(await p.evaluate(()=>JSON.stringify({orders:S.orders,sales:S.sales,roster:S.roster,staff:S.staff})),before,'layout work preserves financial and staff records');assert.deepEqual(errors,[]);console.log('WIDE_SHARED_CONTENT_FRAME_HEADERS_SUMMARY_TABS_CALENDAR_88_VIEWS_MOBILE_AND_RECORDS_UNCHANGED_OK '+checks);
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
