import test from 'node:test';
import assert from 'node:assert/strict';
import { CoupangBrowser,ORDER_URL } from '../connectors/coupang/browser.mjs';

function fixture({loginForm=true,ready=false}={}){
  const client=new CoupangBrowser('/not-used-by-test');let url='about:blank';const visits=[];
  const page={goto:async next=>{url=next;visits.push(next);},waitForFunction:async()=>{},waitForSelector:async()=>{},bringToFront:async()=>{},locator:()=>({count:async()=>url.includes('login.coupang.com')&&loginForm?1:0})};
  client.open=async()=>page;client.state=async()=>ready?'ready':'login_required';return {client,visits};
}
test('login uses official form when the order route does not present authentication',async()=>{
  const {client,visits}=fixture();assert.equal(await client.login(),'login_required');
  assert.deepEqual(visits,[ORDER_URL,'https://login.coupang.com/login/login.pang']);
});
test('unavailable login page cannot be reported as an opened login form',async()=>{
  const {client}=fixture({loginForm:false});await assert.rejects(client.login(),/browser_read_failed/);
});
test('existing authenticated order page is reused without navigating to login',async()=>{
  const {client,visits}=fixture({ready:true});assert.equal(await client.login(),'ready');assert.deepEqual(visits,[ORDER_URL]);
});
test('block detection includes title, not only body',async()=>{
  const client=new CoupangBrowser('/not-used-by-test');client.open=async()=>({url:()=>ORDER_URL,evaluate:async()=>({title:'Sorry! Access denied',text:'',password:false,url:ORDER_URL})});
  assert.equal(await client.state(),'blocked');
});
test('connector shutdown detaches without closing the logged-in Chrome',async()=>{
  const client=new CoupangBrowser('/not-used-by-test');let disconnected=0,unreferenced=0;
  client.browser={close:async()=>{disconnected++;},newBrowserCDPSession:async()=>{throw Error('must not close the native Chrome');}};
  client.child={unref:()=>{unreferenced++;}};client.context={};client.page={};
  await client.detach();assert.equal(disconnected,1);assert.equal(unreferenced,1);assert.equal(client.browser,null);assert.equal(client.context,null);
});
