// Real Chromium navigation: choose ORDER date, including undelivered orders.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{const {CoupangBrowser}=await import('../connectors/coupang/browser.mjs'),b=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{
 const p=await b.newPage();let clicked=0;
 await p.exposeFunction('recordDetail',()=>{clicked++;});
 await p.route('https://mc.coupang.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<body><script>
 function list(){document.body.innerHTML='<h1>주문목록</h1><div><div>2026. 10. 20 주문<div><span onclick="detail(0)">주문 상세보기</span></div></div><div>상품준비중<br>2026. 10. 23 도착예정<br>콜라</div></div><div><div>2026. 10. 19 주문<div><span onclick="detail(1)">주문 상세보기</span></div></div><div>배송완료<br>2026. 10. 20 도착<br>생수</div></div>';}
 function detail(i){recordDetail();history.pushState(null,'','/ssr/desktop/order/'+(12345678901234+i));document.body.innerHTML='<h1>주문상세</h1>2026. 10. '+(20-i)+' 주문<br>주문번호 '+(12345678901234+i)+'<div>상품준비중<br>콜라<br>10,000 원<br>1개</div><h2>받는 사람</h2>PRIVATE_ADDRESS<h2>총 상품가격</h2>10,000 원<h2>할인금액</h2>-1,000 원<h2>배송비</h2>0 원<h2>총 결제금액</h2>9,000 원<h2>결제수단</h2>PRIVATE_CARD';}
 onpopstate=list;list();</script></body>`}));
 const client=new CoupangBrowser('/unused');client.open=async()=>p;
 const result=await client.read(async()=>{}, {from:'2026-10-20',to:'2026-10-20'});
 assert.equal(clicked,1,'include pending order placed on 20th; exclude order delivered on 20th but placed on 19th');
 assert.equal(result.pages.length,1);const text=result.pages[0].text;
 assert(text.includes('상품준비중'));assert(text.includes('총 상품가격\n10,000 원'));assert(text.includes('할인금액\n-1,000 원'));assert(text.includes('배송비\n0 원'));assert(!JSON.stringify(result).includes('PRIVATE_'));
 console.log('COUPANG_BROWSER_ORDER_DATE_PENDING_CAPTURE_SAFE_PAYMENT_BREAKDOWN_OK');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
