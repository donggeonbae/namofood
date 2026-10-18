// Real DOM/navigation fixture. No live account, cookies or provider calls.
const assert=require('node:assert/strict'),{chromium}=require('playwright');
(async()=>{
 const {CoupangBrowser,ORDER_URL}=await import('../connectors/coupang/browser.mjs');
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();let unsafe=0;page.on('pageerror',e=>console.error('FIXTURE_SCRIPT',e.message));
  await page.exposeFunction('unsafeAction',()=>{unsafe++;});
  await page.route('https://mc.coupang.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<body><script>
   let index=0;
   function list(){document.body.innerHTML='<h1>주문목록</h1><div><div>2026. 10. '+(14-index)+' 주문<div><span onclick="detail()">주문 상세보기</span></div></div><div>배송완료<br>검증 상품 '+index+'<br>12,000 원<br>2개<button onclick="unsafeAction()">장바구니 담기</button></div></div><button '+(index===1?'disabled':'')+' onclick="index++;list()">다음</button>';}
   function detail(){history.pushState(null,'','/ssr/desktop/order/'+(12103601548000+index));document.body.innerHTML='<h1>주문상세</h1>2026. 10. '+(14-index)+' 주문<br>주문번호 '+(12103601548000+index)+'<div>배송완료<br>검증 상품 '+index+'<br>12,000 원<br>2개</div><h2>받는 사람</h2>PRIVATE_RECIPIENT<br>PRIVATE_ADDRESS<h2>총 결제금액</h2>12,000 원<h2>결제영수증 정보</h2>PRIVATE_CARD';}
   onpopstate=list;list();
  </script></body>`}));
  const client=new CoupangBrowser('/unused');client.open=async()=>page;
  const snapshot=await client.read(async()=>{}, {from:'2026-10-01',to:'2026-10-31'});
  assert.equal(snapshot.pages.length,2);assert.equal(snapshot.truncated,false);
  assert.equal(unsafe,0);const source=JSON.stringify(snapshot);
  assert(!source.includes('PRIVATE_'),'address/payment sections must not reach AI');
  for(let i=0;i<2;i++){assert(snapshot.pages[i].text.includes('검증 상품 '+i));assert(snapshot.pages[i].text.includes('총 결제금액'));assert.equal(snapshot.pages[i].links[0].orderNo,String(12103601548000+i));}
  console.log('COUPANG_DETAIL_ID_BUTTON_PAGINATION_NO_PURCHASE_NO_PRIVATE_SECTIONS_OK');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
