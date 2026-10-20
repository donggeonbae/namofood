import { bankTransactions } from './bank-transactions.ts';
function check(value: unknown, message = 'assertion failed') {if (!value) throw Error(message);}
const body = {startDate:'2026-10-01',endDate:'2026-10-21'};
const configured = (key: string) => key.endsWith('ACCOUNT_NUMBER') ? 'test-account' : 'secret-value';
Deno.test('admin and configuration gates never call provider', async () => {
  const fetcher = (() => {throw Error('must not fetch');}) as typeof fetch;
  check((await bankTransactions(body,false,{env:configured,fetch:fetcher})).status===403);
  check((await bankTransactions(body,true,{env:()=>'',fetch:fetcher})).status===503);
  check((await bankTransactions({...body,startDate:'2026-02-30'},true,{env:configured,fetch:fetcher})).status===400);
  check((await bankTransactions({...body,startDate:'2025-01-01'},true,{env:configured,fetch:fetcher})).status===400);
});
Deno.test('Shinhan request uses batch login; returns stable references and no secrets', async () => {
  let calls=0;
  const fetcher = (async (url: unknown, init: RequestInit) => {
    calls++;check(url==='https://api.bankapi.co.kr/v1/transactions/login');
    const request=JSON.parse(String(init.body));check(request.bankCode==='SH'&&request.accounts[0].accountNumber==='test-account');check(request.startDate==='20261001');
    return Response.json({success:true,results:[{accountNumber:'test-account',success:true,accountInfo:{password:'secret-value'},transactions:[{date:'2026/10/15',time:'12:00:00',type:'withdrawal',amount:10000,balance:90000,description:'공급업체',password:'secret-value'}]}]});
  }) as typeof fetch;
  const first=await bankTransactions(body,true,{env:configured,fetch:fetcher});
  const second=await bankTransactions(body,true,{env:configured,fetch:fetcher});
  check(first.status===200&&calls===2);const rows=first.data.transactions as Record<string,unknown>[];
  check(String(rows[0].id).length===64&&rows[0].id===(second.data.transactions as Record<string,unknown>[])[0].id);
  check(!JSON.stringify(first.data).includes('secret-value')&&!JSON.stringify(first.data).includes('test-account'));
});
Deno.test('HTTP 200 account failure is failure; no retries or raw error leak', async () => {
  let calls=0;
  const fetcher=(async()=>{calls++;return Response.json({success:true,results:[{accountNumber:'test-account',success:false,error:'secret-value'}]});}) as typeof fetch;
  const result=await bankTransactions(body,true,{env:configured,fetch:fetcher});
  check(result.status===502&&calls===1&&!JSON.stringify(result).includes('secret-value'));
});
Deno.test('provider cooldown returned for UI and malformed rows rejected', async () => {
  const limit=await bankTransactions(body,true,{env:configured,fetch:(async()=>Response.json({retryAfterSec:600},{status:429})) as typeof fetch});
  check(limit.status===429&&limit.data.retryAfterSec===600);
  const result=await bankTransactions(body,true,{env:configured,fetch:(async()=>Response.json({success:true,results:[{accountNumber:'test-account',success:true,transactions:[null]}]})) as typeof fetch});check(result.status===502);
});
