// Runtime installer: generated worker secrets stay outside the repository (mode 0600).
import { mkdir,readFile,writeFile,chmod,cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root=dirname(fileURLToPath(import.meta.url)),directory=join(homedir(),'Library','Application Support','Namofood','Coupang');
await mkdir(directory,{recursive:true,mode:0o700});
const file=join(directory,'connector.json');let config;
try{config=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('기존 설정을 읽지 못했습니다. 덮어쓰지 않았습니다.');}
config ||= {endpoint:'https://rycibsczsgbkgtwfxyim.supabase.co/functions/v1/nmf-coupang',token:randomBytes(32).toString('hex')};
if(!/^[a-f0-9]{64}$/.test(config.token))throw Error('기존 연결 키 형식을 확인해 주세요.');
await writeFile(file,JSON.stringify(config),{mode:0o600});await chmod(file,0o600);
// stdin keeps the secret out of command arguments and console output.
if(process.argv.includes('--provision')){
  const r=spawnSync(join(homedir(),'.local','bin','supabase'),['secrets','set','--project-ref','rycibsczsgbkgtwfxyim','--env-file','/dev/stdin'],{cwd:join(root,'..','..'),input:'NMF_COUPANG_WORKER_TOKEN='+config.token+'\n',encoding:'utf8'});
  if(r.status!==0)throw Error('서버 비밀값 등록 실패. 로컬 설정은 안전하게 유지했습니다.');
  console.log('SERVER_WORKER_SECRET_CONFIGURED');
}
const xml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const agent=join(homedir(),'Library','LaunchAgents','com.namofood.coupang.plist');
// launchd must not depend on a protected Documents checkout or future Git edits.
const runtime=join(directory,'runtime');await mkdir(runtime,{recursive:true,mode:0o700});
for(const name of ['worker.mjs','browser.mjs']){
  const source=await readFile(join(root,name),'utf8');
  await writeFile(join(runtime,name),source.replaceAll('../../supabase/functions/nmf-coupang/protocol.mjs','./protocol.mjs'),{mode:0o600});
}
await cp(join(root,'..','..','supabase','functions','nmf-coupang','protocol.mjs'),join(runtime,'protocol.mjs'));
await cp(join(root,'node_modules'),join(runtime,'node_modules'),{recursive:true});
const contents=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.namofood.coupang</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(runtime,'worker.mjs'))}</string></array><key>WorkingDirectory</key><string>${xml(runtime)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(directory,'worker.log'))}</string><key>StandardErrorPath</key><string>${xml(join(directory,'worker-error.log'))}</string></dict></plist>`;
await mkdir(dirname(agent),{recursive:true});
try{const old=await readFile(agent,'utf8');if(old!==contents&&!old.includes('<string>com.namofood.coupang</string>'))throw Error('기존 다른 실행 항목은 덮어쓰지 않습니다.');}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(agent,contents,{mode:0o600});await chmod(agent,0o600);
console.log('LOCAL_CONNECTOR_CONFIGURED');
console.log('LaunchAgent: '+agent);
console.log('시작: launchctl bootstrap gui/'+process.getuid()+' "'+agent+'"');
console.log('중지: launchctl bootout gui/'+process.getuid()+'/com.namofood.coupang');
