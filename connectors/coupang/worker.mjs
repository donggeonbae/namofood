import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { signature } from '../../supabase/functions/nmf-coupang/protocol.mjs';
import { CoupangBrowser } from './browser.mjs';

export const directory=join(homedir(),'Library','Application Support','Namofood','Coupang');
const browser=new CoupangBrowser(join(directory,'chrome-profile'));
let stopping=false, active=null, state='login_required',lastLog='',lastLogAt=0;
const log=message=>{if(message!==lastLog||Date.now()-lastLogAt>900000){console.log(message);lastLog=message;lastLogAt=Date.now();}};
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
async function loginOnly(){
  state=await browser.login();console.log('쿠팡 공식 창에서 로그인해 주세요. 비밀번호는 저장하거나 전송하지 않습니다.');
  const started=Date.now();
  while(!stopping&&Date.now()-started<10*60000){
    await delay(2000);state=await browser.state();
    if(state==='ready'){console.log('COUPANG_LOGIN_READY');await browser.close();return;}
    if(state==='blocked'){console.log('COUPANG_ACCESS_BLOCKED');await browser.close();process.exitCode=2;return;}
    if(browser.page&&!browser.page.isClosed()&&!/login/.test(browser.page.url())&&!/order\/list|mycoupang\/list\/orders/.test(browser.page.url()))await browser.login();
  }
  await browser.close();
}
async function run(){
  log('CONNECTOR_STARTED');
  const config=JSON.parse(await readFile(join(directory,'connector.json'),'utf8'));
  if(!/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/nmf-coupang$/.test(config.endpoint)||!/^[a-f0-9]{64}$/.test(config.token))throw Error('invalid_configuration');
  async function api(action,extra={}){
    const raw=JSON.stringify({role:'worker',action,nonce:crypto.randomUUID(),...extra}),time=String(Date.now());
    const response=await fetch(config.endpoint,{method:'POST',headers:{'content-type':'application/json','x-nmf-time':time,'x-nmf-signature':await signature(config.token,'worker',time,raw)},body:raw,signal:AbortSignal.timeout(action==='finish'?100000:20000)});
    const data=await response.json();if(!response.ok||!data.ok)throw Error('connector_request_failed');return data;
  }
  let polling=false;
  async function heartbeat(){try{await api('heartbeat',{state,...(active?{jobId:active.id,lease:active.lease}:{})});}catch{log('CONNECTOR_HEARTBEAT_RETRY');}}
  await heartbeat();const timer=setInterval(heartbeat,20000);
  try{while(!stopping){
    if(!polling){polling=true;
      try{
        const data=await api('claim');active=data.job||null;
        if(active){
          await api('progress',{jobId:active.id,lease:active.lease,stage:'opening',progress:10});
          try{
            if(active.kind==='login'){
              state=await browser.login();await api('finish',{jobId:active.id,lease:active.lease,state});
            }else{
              const snapshot=await browser.read((stage,progress)=>api('progress',{jobId:active.id,lease:active.lease,stage,progress}));state='ready';
              await api('finish',{jobId:active.id,lease:active.lease,state,snapshot});
            }
          }catch(error){
            const code=['login_required','blocked','no_order_evidence'].includes(error.message)?error.message:'browser_read_failed';
            if(code==='login_required'||code==='blocked')state=code;
            await api('fail',{jobId:active.id,lease:active.lease,code}).catch(()=>{});
          }
          active=null;
        }else if(browser.context){
          const next=await browser.state().catch(()=> 'login_required');
          if(next!==state){state=next;await heartbeat();}
        }
      }catch{log('CONNECTOR_POLL_RETRY');}finally{polling=false;}
    }
    await delay(5000);
  }}finally{clearInterval(timer);await browser.close();}
}
try{await mkdir(directory,{recursive:true,mode:0o700});await (process.argv.includes('--login')?loginOnly():run());}
catch{console.error('연결 프로그램을 시작하지 못했습니다. 설치 설정·전용 Chrome 창을 확인해 주세요.');process.exitCode=1;}
