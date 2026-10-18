// Explicit live Go-provider probe. Isolated, expired test job; no browser or ledger.
// The exact temporary UUID is deleted in finally, even if the provider rejects it.
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {signature,unseal} from '../supabase/functions/nmf-coupang/protocol.mjs';
if(process.env.NMF_COUPANG_LIVE_PROVIDER!=='1')throw Error('explicit live-provider opt-in required');
const config=JSON.parse(await readFile(join(homedir(),'Library','Application Support','Namofood','Coupang','connector.json'),'utf8'));
const id=crypto.randomUUID(),lease=crypto.randomUUID();
function query(sql){return JSON.parse(execFileSync(join(homedir(),'.local','bin','supabase'),['db','query','--linked',sql],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));}
try{
 query(`insert into namofood_private.coupang_jobs(id,room,kind,from_date,to_date,status,stage,progress,lease_token,lease_until,created_at) values('${id}','namostore','import','2000-01-01','2000-01-02','running','reading',65,'${lease}',now()+interval '3 minutes',now()-interval '26 hours')`);
 const raw=JSON.stringify({role:'worker',action:'finish',nonce:crypto.randomUUID(),jobId:id,lease,snapshot:{pages:[{text:'2000. 1. 1 주문 주문번호 12345678901234 배송완료 검증용 콜라 2박스 30,000원 총 결제금액 30,000원',links:[]}],truncated:false}}),time=String(Date.now());
 const response=await fetch(config.endpoint,{method:'POST',headers:{'content-type':'application/json','x-nmf-time':time,'x-nmf-signature':await signature(config.token,'worker',time,raw)},body:raw,signal:AbortSignal.timeout(95000)});
 const data=await response.json();assert.equal(data.ok,true,JSON.stringify({http:response.status,error:data.error}));
 const row=query(`select status,error_code,result_ciphertext from namofood_private.coupang_jobs where id='${id}'`).rows[0];
 assert.equal(row.status,'done');const result=await unseal(config.token,id,row.result_ciphertext);
 assert.equal(result.orders.length,1);assert.equal(result.orders[0].date,'2000-01-01');assert.equal(result.orders[0].total,30000);
 console.log('LIVE_GO_GPT_6_LUNA_JSON_GROUNDING_ENCRYPTION_OK');
}finally{
 query(`delete from namofood_private.coupang_jobs where id='${id}' and lease_token='${lease}' and from_date='2000-01-01' and created_at<now()-interval '25 hours'`);
 console.log('ISOLATED_PROVIDER_TEST_JOB_REMOVED_NO_LEDGER_WRITES');
}
