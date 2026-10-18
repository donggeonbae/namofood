import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanText } from '../../supabase/functions/nmf-coupang/protocol.mjs';

export const ORDER_URL='https://mc.coupang.com/ssr/desktop/order/list';
export class CoupangBrowser {
  constructor(profile) { this.profile=profile;this.context=null;this.page=null;this.browser=null;this.child=null; }
  async open() {
    if(!this.context){
      await mkdir(this.profile,{recursive:true,mode:0o700});
      // Start ordinary Chrome, not a test-runner browser. CDP stays on loopback only.
      const port=await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
      this.child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--user-data-dir='+this.profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
      let endpoint=null,launchFailed=false;this.child.once('error',()=>{launchFailed=true;});
      for(let i=0;i<60;i++){
        if(launchFailed||this.child.exitCode!==null)throw Error('browser_read_failed');
        try{const response=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(500)});if(response.ok){const data=await response.json(),url=new URL(data.webSocketDebuggerUrl);if(url.hostname!=='127.0.0.1'||Number(url.port)!==port)throw Error('invalid_local_browser');endpoint=url.href;break;}}catch{}
        await delay(250);
      }
      if(!endpoint)throw Error('browser_read_failed');
      this.browser=await chromium.connectOverCDP(endpoint);this.context=this.browser.contexts()[0];
      this.browser.on('disconnected',()=>{this.browser=null;this.context=null;this.page=null;});
      this.context.on('close',()=>{this.context=null;this.page=null;});
    }
    if(!this.page||this.page.isClosed())this.page=this.context.pages()[0]||await this.context.newPage();
    this.page.setDefaultTimeout(15000);return this.page;
  }
  async state() {
    const page=await this.open();
    if(!/^https:\/\/(?:[a-z0-9-]+\.)*coupang\.com\//i.test(page.url()))return 'login_required';
    const value=await page.evaluate(()=>({title:document.title,text:(document.body?.innerText||'').slice(0,10000),password:!!document.querySelector('input[type="password"]'),url:location.href}));
    if(/access\s*denied|접근이 차단|접속이 차단/i.test(value.title+' '+value.text))return 'blocked';
    if(value.password||/login\.coupang\.com|\/login(?:\/|\.)/.test(value.url)||/로그인 후 이용/.test(value.text))return 'login_required';
    return /order\/list|mycoupang\/list\/orders/.test(value.url)&&/주문목록|주문 목록|주문내역|주문내역이 없|주문한 상품/.test(value.text)?'ready':'login_required';
  }
  async login() {
    const page=await this.open();await page.goto(ORDER_URL,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForFunction(()=>document.querySelector('input[type="password"]')||/access\s*denied|주문목록|주문 목록|주문내역/i.test(document.title+' '+(document.body?.innerText||'')),null,{timeout:20000}).catch(()=>{});
    let state=await this.state();
    if(state==='login_required'&&!await page.locator('input[type="password"]').count()){
      await page.goto('https://login.coupang.com/login/login.pang',{waitUntil:'domcontentloaded',timeout:45000});
      await page.waitForSelector('input[type="password"]',{state:'attached',timeout:20000}).catch(()=>{});state=await this.state();
    }
    if(state==='login_required'&&!await page.locator('input[type="password"]').count())throw Error('browser_read_failed');
    await page.bringToFront();return state;
  }
  async read(progress=async()=>{}) {
    const page=await this.open();await page.goto(ORDER_URL,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForFunction(()=>document.querySelector('input[type="password"]')||/access\s*denied|주문목록|주문 목록|주문내역|주문한 상품/i.test(document.title+' '+(document.body?.innerText||'')),null,{timeout:30000}).catch(()=>{});
    const state=await this.state();if(state!=='ready')throw Error(state);
    const pages=[],visited=new Set();let truncated=false;
    for(let i=0;i<10;i++){
      if(visited.has(page.url()))break;visited.add(page.url());
      await page.waitForLoadState('networkidle',{timeout:12000}).catch(()=>{});
      if(await this.state()!=='ready')throw Error('login_required');
      const snapshot=await page.evaluate(()=>{
        const root=(document.querySelector('main')||document.body).cloneNode(true);
        root.querySelectorAll('header,footer,nav,aside,form,input,script,style,[class*="address"],[class*="receiver"]').forEach(el=>el.remove());
        const links=[...document.querySelectorAll('a[href]')].map(a=>({text:a.textContent.trim(),url:a.href})).filter(x=>/^https:\/\/(?:[a-z0-9-]+\.)*coupang\.com\//i.test(x.url)&&/order|주문상세/.test(x.url+' '+x.text));
        const next=[...document.querySelectorAll('a[href]')].find(a=>a.rel==='next'||/^(?:다음|다음 페이지|Next|›|>)$/i.test(a.textContent.trim())||/다음 페이지/.test(a.getAttribute('aria-label')||''));
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),lines=[];let node;
        while((node=walker.nextNode())){const text=node.textContent.trim();if(text)lines.push(text);}
        return {text:lines.join('\n'),links,next:next?.href||null};
      });
      const text=cleanText(snapshot.text,20000),links=snapshot.links.map(link=>{const u=new URL(link.url);return {text:cleanText(link.text,80),path:u.pathname,orderNo:u.searchParams.get('orderId')||u.searchParams.get('orderNo')||u.pathname.match(/\d{6,30}/)?.[0]||''};});
      if(snapshot.text.length>20000)truncated=true;
      pages.push({text,links});await progress('reading',Math.min(65,15+pages.length*5));
      if(!snapshot.next)break;
      const next=new URL(snapshot.next);if(next.protocol!=='https:'||!/(^|\.)coupang\.com$/.test(next.hostname)||!/(?:order\/list|mycoupang\/list\/orders)/.test(next.pathname))break;
      if(pages.reduce((n,p)=>n+p.text.length,0)>70000||i===9){truncated=true;break;}
      await page.goto(next.href,{waitUntil:'domcontentloaded',timeout:45000});
    }
    if(!pages.length)throw Error('no_order_evidence');
    return {pages,truncated};
  }
  async close() {
    if(this.browser){try{const session=await this.browser.newBrowserCDPSession();await session.send('Browser.close');}catch{}try{await this.browser?.close();}catch{}}
    if(this.child?.exitCode===null){await delay(500);if(this.child.exitCode===null)this.child.kill('SIGTERM');}
    this.browser=null;this.child=null;this.context=null;this.page=null;
  }
}
