import {readFile,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fingerprint,publicKey,generateDevice,cipher,realtime,allowedNavigation,validInput} from './remote-protocol.mjs';
import {sha} from '../../supabase/functions/nmf-coupang/protocol.mjs';

export async function approveDevice(directory,device,confirm){
  if(await locallyApproved(directory,device))return true;
  const key=publicKey(device.publicKey),code=await fingerprint(device);
  const approved=confirm?await confirm(code):await new Promise(resolve=>{
    const message='나모푸드 웹앱에서 쿠팡 로그인용 기기 등록을 요청했습니다.\n\n웹앱에 표시된 확인번호: '+code+'\n\n본인이 요청했고 번호가 같을 때만 허용하세요. 승인한 기기는 쿠팡 로그인 화면을 원격 조작할 수 있습니다. 공용 기기는 거절하세요.';
    const script='display dialog '+JSON.stringify(message)+' with title "나모푸드 쿠팡 로그인 기기 승인" buttons {"거절", "허용"} default button "거절" cancel button "거절" giving up after 120';
    const process=spawn('/usr/bin/osascript',['-e',script],{stdio:['ignore','pipe','ignore']});let answer='';
    const timer=setTimeout(()=>{process.kill();resolve(false);},125000);
    process.stdout.on('data',chunk=>{if(answer.length<1000)answer+=chunk.toString();});
    process.on('error',()=>{clearTimeout(timer);resolve(false);});
    process.on('close',exit=>{clearTimeout(timer);resolve(exit===0&&/button returned:허용/.test(answer)&&!/gave up:true/.test(answer));});
  });
  if(!approved)return false;
  const file=join(directory,'devices.json');let devices=[];
  try{devices=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(devices))throw Error('invalid_devices');}catch(error){if(error.code!=='ENOENT')throw error;}
  devices=devices.filter(x=>x.id!==device.id&&x.expires>Date.now());
  devices.push({id:device.id,publicKey:key,expires:Date.now()+90*86400000});
  await writeFile(file,JSON.stringify(devices),{mode:0o600});await chmod(file,0o600);return true;
}
export async function locallyApproved(directory,device){
  try{const devices=JSON.parse(await readFile(join(directory,'devices.json'),'utf8'));const key=JSON.stringify(publicKey(device.publicKey));return devices.some(x=>x.id===device.id&&x.expires>Date.now()&&JSON.stringify(publicKey(x.publicKey))===key);}catch{return false;}
}
export class RemoteLogin{
  constructor(browser,directory,onState=async()=>{}){this.browser=browser;this.directory=directory;this.onState=onState;this.active=false;}
  async start(job){
    if(this.active||!await locallyApproved(this.directory,job.payload?.certificate?.device))throw Error('unapproved_device');
    this.generation=(this.generation||0)+1;const generation=this.generation;
    this.active=true;this.stopping=false;this.tickBusy=false;this.lastHello=0;this.lastHash='';this.received=0;this.errors=0;this.inputChain=Promise.resolve();
    try{
      await this.browser.open();this.page=await this.browser.context.newPage();
      const page=this.page,width=job.payload.width===390?390:980,height=760;
      await page.setViewportSize({width,height});page.setDefaultTimeout(10000);
      await page.addInitScript(()=>{window.open=()=>null;});
      page.on('popup',popup=>popup.close().catch(()=>{}));
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        const risky=/\/(?:cart|checkout|purchase|payments?|refund|cancel)(?:\/|\?|$)/i.test(url.pathname);
        const mutation=!['GET','HEAD','OPTIONS'].includes(request.method());
        const authMutation=url.hostname==='login.coupang.com'||['www.google.com','www.recaptcha.net','www.gstatic.com','challenges.cloudflare.com'].includes(url.hostname);
        if(risky||mutation&&!authMutation||request.isNavigationRequest()&&request.frame()===page.mainFrame()&&!allowedNavigation(request.url()))return route.abort();
        return route.fallback();
      });
      await page.goto('https://login.coupang.com/login/login.pang',{waitUntil:'domcontentloaded',timeout:45000});
      if(!allowedNavigation(page.url()))throw Error('login_navigation_blocked');
      const keys=await generateDevice();this.session={id:job.id,topic:'nmf-login-'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),publicKey:keys.publicKey,expires:Date.now()+300000,width,height};
      this.crypto=await cipher(keys.privateKey,job.payload.certificate.device.publicKey,job.id,'worker');this.sendChain=Promise.resolve();this.pendingInputs=0;this.inputWindow=Date.now();this.inputCount=0;
      this.relay=await realtime({...job.relay,topic:this.session.topic,onPacket:packet=>{
        if(this.stopping||this.generation!==generation)return;
        if(Date.now()-this.inputWindow>1000){this.inputWindow=Date.now();this.inputCount=0;}
        if(++this.inputCount>60||++this.pendingInputs>100){this.close(generation);return;}
        this.inputChain=this.inputChain.then(async()=>{
          if(this.stopping||this.generation!==generation)return;
          const data=await this.crypto.open(packet);if(!validInput(data,width,height))throw Error('invalid_input');
          this.lastHello=Date.now();this.errors=0;
          if(['hello','refresh'].includes(data.type)){this.lastHash='';await this.send({type:'state',status:'login_required',message:'쿠팡 공식 로그인 화면입니다. 직접 로그인하고 추가 인증을 완료하세요.'},generation);}
          else if(data.type==='click'){await page.mouse.click(data.x,data.y);await this.focus(generation);}
          else if(data.type==='text')await page.keyboard.insertText(data.text);
          else if(data.type==='fill'){
            const matches=await page.evaluate(id=>{const el=document.activeElement;return el?.dataset?.nmfLoginFocus===id&&['INPUT','TEXTAREA'].includes(el.tagName)&&!el.disabled&&!el.readOnly;},data.focusId);
            if(matches){await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(data.text);}
            await this.send({type:'input-result',id:data.id,ok:matches},generation);await this.focus(generation);
          }
          else if(data.type==='key'){await page.keyboard.press(data.key);await this.focus(generation);}
          else if(data.type==='scroll')await page.mouse.wheel(0,data.dy);
          else if(data.type==='verify')await this.verify(generation);
          else if(data.type==='close')await this.close(generation);
        }).catch(()=>{if(this.generation===generation&&++this.errors>=5)this.close(generation);}).finally(()=>{if(this.generation===generation)this.pendingInputs--;});
      },onClose:()=>this.close(generation)});
      this.timer=setInterval(()=>this.tick().catch(()=>this.close(generation)),1000);return this.session;
    }catch(error){await this.close(generation);throw error;}
  }
  async send(data,generation=this.generation){if(generation!==this.generation)return;this.sendChain=this.sendChain.then(async()=>{const peer=this.relay,key=this.crypto;if(peer&&!this.stopping&&generation===this.generation){const packet=await key.seal(data);if(generation===this.generation&&!this.stopping&&peer===this.relay)peer.send(packet);}});return this.sendChain;}
  async focus(generation=this.generation){
    const value=await this.page.evaluate(()=>{
      const el=document.activeElement;if(!el||!['INPUT','TEXTAREA'].includes(el.tagName)||el.disabled||el.readOnly||['hidden','checkbox','radio','submit','button','file'].includes(el.type))return {kind:'none',focusId:''};
      el.dataset.nmfLoginFocus||=crypto.randomUUID();return {kind:el.type==='password'?'password':el.type==='email'||/email|username/i.test(el.autocomplete+' '+el.name+' '+el.id)?'email':'text',focusId:el.dataset.nmfLoginFocus};
    });
    if(generation!==this.generation)return;const key=JSON.stringify(value);if(this.lastFocus!==key){this.lastFocus=key;await this.send({type:'focus',...value},generation);}
  }
  async verify(generation=this.generation){
    if(!this.active||this.stopping||generation!==this.generation)return;const page=this.page;
    if(!allowedNavigation(page.url()))return this.close(generation);
    const path=new URL(page.url()).pathname;
    if(path.startsWith('/login/')){await this.send({type:'state',status:'login_required',message:'아직 로그인 또는 추가 인증이 필요합니다.'},generation);return;}
    await page.goto('https://mc.coupang.com/ssr/desktop/order/list',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(()=>document.querySelector('input[type="password"]')||/주문목록|주문 목록/.test(document.body?.innerText||''),null,{timeout:15000}).catch(()=>{});
    const ready=await page.evaluate(()=>!document.querySelector('input[type="password"]')&&/주문목록|주문 목록/.test(document.body?.innerText||'')&&/\/order\/list/.test(location.pathname)&&(!!document.querySelector('a[href*="logout"]')||(document.body?.innerText||'').includes('로그아웃')));
    if(ready&&generation===this.generation){await this.onState('ready');await this.send({type:'state',status:'ready',message:'쿠팡 로그인 확인 완료. 웹앱에서 주문 가져오기를 누르세요.'},generation);await this.close(generation);}
  }
  async tick(){
    if(this.tickBusy||!this.active||this.stopping)return;this.tickBusy=true;const generation=this.generation,page=this.page;
    try{
      if(Date.now()>this.session.expires||this.lastHello&&Date.now()-this.lastHello>20000||!this.lastHello&&Date.now()>this.session.expires-240000)return await this.close();
      if(!allowedNavigation(page.url()))return await this.close(generation);
      if(!new URL(page.url()).pathname.startsWith('/login/')){await this.verify(generation);return;}
      if(!this.lastHello)return;
      await this.focus(generation);
      if(await page.evaluate(()=>/access\s*denied/i.test(document.title+' '+(document.body?.innerText||'')))){await this.send({type:'state',status:'blocked',message:'쿠팡에서 접근을 차단했습니다. 잠시 후 다시 시도하세요.'},generation);return await this.close(generation);}
      const frame=await page.screenshot({type:'jpeg',quality:48,timeout:7000});if(frame.length>110000||generation!==this.generation)return;
      const hash=await sha(frame.toString('base64'));if(hash===this.lastHash||generation!==this.generation)return;this.lastHash=hash;
      await this.send({type:'frame',image:frame.toString('base64'),width:this.session.width,height:this.session.height},generation);
    }finally{if(generation===this.generation)this.tickBusy=false;}
  }
  async close(generation=this.generation){
    if(this.stopping||generation!==this.generation)return;this.stopping=true;this.generation=(this.generation||0)+1;clearInterval(this.timer);
    this.relay?.close();this.relay=null;
    try{await this.page?.close();}catch{}this.page=null;this.crypto=null;this.active=false;
  }
}
