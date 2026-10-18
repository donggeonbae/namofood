import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanText } from '../../supabase/functions/nmf-coupang/protocol.mjs';

export const ORDER_URL='https://mc.coupang.com/ssr/desktop/order/list';
export class CoupangBrowser {
  constructor(profile) { this.profile=profile;this.context=null;this.page=null;this.browser=null;this.child=null; }
  async open() {
    if(!this.context){
      await mkdir(this.profile,{recursive:true,mode:0o700});
      const endpointFile=join(dirname(this.profile),'browser.json');
      let cached=null;
      try{
        const value=JSON.parse(await readFile(endpointFile,'utf8'));
        if(Number.isInteger(value.port)&&value.port>1024&&value.port<65536&&Number.isInteger(value.pid)){
          const command=execFileSync('/bin/ps',['-p',String(value.pid),'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
          if(command.includes('--user-data-dir='+this.profile)&&command.includes('--remote-debugging-port='+value.port))cached=value;
        }
      }catch{}
      // Start ordinary Chrome, not a test-runner browser. CDP stays on loopback only.
      const port=cached?.port||await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
      let endpoint=null,launchFailed=false;
      if(!cached){
        this.child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--user-data-dir='+this.profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--no-first-run','--no-default-browser-check','--restore-last-session','about:blank'],{stdio:'ignore',detached:true});
        this.child.once('error',()=>{launchFailed=true;});this.child.unref();
        await writeFile(endpointFile,JSON.stringify({port,pid:this.child.pid}),{mode:0o600});
      }
      for(let i=0;i<60;i++){
        if(launchFailed||this.child&&this.child.exitCode!==null)throw Error('browser_read_failed');
        try{const response=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(500)});if(response.ok){const data=await response.json(),url=new URL(data.webSocketDebuggerUrl);if(url.hostname!=='127.0.0.1'||Number(url.port)!==port)throw Error('invalid_local_browser');endpoint=url.href;break;}}catch{}
        await delay(250);
      }
      if(!endpoint)throw Error('browser_read_failed');
      this.browser=await chromium.connectOverCDP(endpoint);this.context=this.browser.contexts()[0];
      this.browser.on('disconnected',()=>{this.browser=null;this.context=null;this.page=null;});
      this.context.on('close',()=>{this.context=null;this.page=null;});
    }
    const tabs=this.context.pages(),isCoupang=page=>!page.isClosed()&&/^https:\/\/(?:[a-z0-9-]+\.)*coupang\.com\//i.test(page.url());
    this.page=tabs.find(page=>isCoupang(page)&&/\/order\/list(?:[?#]|$)/.test(page.url()))
      ||(this.page&&isCoupang(this.page)?this.page:null)
      ||tabs.find(isCoupang)||await this.context.newPage();
    this.page.setDefaultTimeout(15000);return this.page;
  }
  async detach() {
    // Closing a CDP connection only detaches Playwright. Keep the owned Chrome
    // running across connector updates so session-only logins are not destroyed.
    try{await this.browser?.close();}catch{}
    this.child?.unref();this.browser=null;this.child=null;this.context=null;this.page=null;
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
  async read(progress=async()=>{},range={}) {
    const page=await this.open();await page.goto(ORDER_URL,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForFunction(()=>document.querySelector('input[type="password"]')||/access\s*denied|주문목록|주문 목록|주문내역|주문한 상품/i.test(document.title+' '+(document.body?.innerText||'')),null,{timeout:30000}).catch(()=>{});
    const state=await this.state();if(state!=='ready')throw Error(state);
    const pages=[],visited=new Set();let truncated=false,detailCount=0;
    for(let i=0;i<10;i++){
      await page.waitForLoadState('networkidle',{timeout:12000}).catch(()=>{});
      if(await this.state()!=='ready')throw Error('login_required');
      // Coupang uses React click controls, not order-detail anchors. Read only the
      // explicitly labelled detail controls; never click cart/return/payment actions.
      const cards=await page.getByText('주문 상세보기',{exact:true}).evaluateAll(elements=>elements.map(el=>{
        let root=el;
        for(let n=0;n<5&&root.parentElement;n++){
          root=root.parentElement;
          if(/20\d\d\.\s*\d{1,2}\.\s*\d{1,2}\s*주문/.test(root.textContent)&&/배송|취소|반품|구매확정/.test(root.textContent))break;
        }
        const text=root.textContent||'',m=text.match(/(20\d\d)\.\s*(\d{1,2})\.\s*(\d{1,2})\s*주문/);
        return {date:m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:'',completed:/배송\s*완료|구매\s*확정/.test(text),fingerprint:text};
      }));
      const fingerprint=cards.map(x=>x.fingerprint).join('\n');
      if(visited.has(fingerprint)){truncated=true;break;}visited.add(fingerprint);
      if(cards.length){
        for(let j=0;j<cards.length;j++){
          const card=cards[j];if(!card.completed||!card.date||range.from&&card.date<range.from||range.to&&card.date>range.to)continue;
          if(detailCount>=60||pages.reduce((n,p)=>n+p.text.length,0)>70000){truncated=true;break;}
          await page.getByText('주문 상세보기',{exact:true}).nth(j).dispatchEvent('click');
          await page.waitForURL(u=>/^https:\/\/mc\.coupang\.com\/ssr\/desktop\/order\/\d{6,30}$/.test(u.href),{timeout:15000});
          await page.waitForFunction(()=>/주문번호\s*\d{6,30}/.test(document.body?.innerText||''),null,{timeout:15000});
          const detail=await page.evaluate(()=>{
            const lines=document.body.innerText.split('\n'),start=lines.findIndex(x=>x.trim()==='주문상세'||x.trim()==='주문 상세');
            const end=lines.findIndex((x,index)=>index>start&&/받는\s*사람|배송지|수령인/.test(x));
            if(start<0||end<0)return null; // Do not send address/payment sections to AI.
            const totalIndex=lines.findIndex(x=>/^총 결제금액$/.test(x.trim()));
            const totals=totalIndex>=0?lines.slice(totalIndex,totalIndex+2):[];
            return {text:[...lines.slice(start,end),...totals].join('\n'),path:location.pathname};
          });
          if(!detail)throw Error('no_order_evidence');
          if(detail.text.length>20000)truncated=true;
          const record={text:cleanText(detail.text,20000),links:[{text:'주문 상세보기',path:detail.path,orderNo:detail.path.match(/\d{6,30}/)[0]}]};
          if(new TextEncoder().encode(JSON.stringify([...pages,record])).length>130000)truncated=true;
          else {pages.push(record);detailCount++;}
          await progress('reading',Math.min(65,15+detailCount));
          await page.goBack({waitUntil:'domcontentloaded',timeout:30000});
          await page.getByText('주문 상세보기',{exact:true}).nth(j).waitFor({state:'attached',timeout:15000});
          if(truncated)break;
        }
        if(truncated)break;
        const next=page.getByRole('button',{name:'다음',exact:true});
        if(!await next.count()||await next.isDisabled())break;
        if(cards.every(x=>x.date&&range.from&&x.date<range.from))break;
        if(i===9){truncated=true;break;}
        await next.dispatchEvent('click');
        await page.waitForFunction(previous=>{
          const labels=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()==='주문 상세보기');
          return labels.length&&labels.map(el=>{let root=el;for(let n=0;n<5&&root.parentElement;n++){root=root.parentElement;if(/20\d\d\.\s*\d{1,2}\.\s*\d{1,2}\s*주문/.test(root.textContent)&&/배송|취소|반품|구매확정/.test(root.textContent))break;}return root.textContent||'';}).join('\n')!==previous;
        },fingerprint,{timeout:15000}).catch(()=>{truncated=true;});
        if(truncated)break;continue;
      }
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
    if(!pages.length)return {pages:[{text:'선택 기간 내 완료 주문 없음',links:[]}],truncated};
    return {pages,truncated};
  }
  async close() {
    if(this.browser){try{const session=await this.browser.newBrowserCDPSession();await session.send('Browser.close');}catch{}try{await this.browser?.close();}catch{}}
    if(this.child?.exitCode===null){await delay(500);if(this.child.exitCode===null)this.child.kill('SIGTERM');}
    this.browser=null;this.child=null;this.context=null;this.page=null;
  }
}
