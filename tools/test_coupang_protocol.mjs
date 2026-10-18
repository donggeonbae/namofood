import test from 'node:test';
import assert from 'node:assert/strict';
import { signature, validRange, validateOrders, seal, unseal } from '../supabase/functions/nmf-coupang/protocol.mjs';

test('signed full bodies separate worker and app authority', async () => {
  const a = await signature('test-secret', 'app', '123', '{"action":"start"}');
  assert.equal(a.length, 64);
  assert.notEqual(a, await signature('test-secret', 'worker', '123', '{"action":"start"}'));
  assert.notEqual(a, await signature('test-secret', 'app', '123', '{"action":"login"}'));
});
test('ranges are real, ordered, bounded dates', () => {
  assert(validRange('2026-10-01', '2026-10-31'));
  for(const [a,b] of [['2026-02-30','2026-03-01'],['2026-11-01','2026-10-01'],['2026-01-01','2026-12-31']]) assert(!validRange(a,b));
});
const source = '2026.10.12 주문 12345678901234 배송완료 콜라 24개 2박스 30,000원';
const sample = {orderNo:'12345678901234',date:'2026-10-12',status:'배송완료',total:30000,evidence:source,items:[{name:'콜라',spec:'24개',qty:2,unit:'박스',price:15000,amt:30000}]};
test('only grounded completed orders; no guessed blank prices or quantity', () => {
  const rows = validateOrders({orders:[sample]},source,{from:'2026-10-01',to:'2026-10-31'});
  assert.equal(rows[0].items[0].price,null,'unseen calculated price must not be introduced');
  assert.equal(rows[0].items[0].qty,2);
  assert.throws(()=>validateOrders({orders:[{...sample,status:'취소완료'}]},source,{from:'2026-10-01',to:'2026-10-31'}));
  assert.throws(()=>validateOrders({orders:[{...sample,evidence:'invented order'}]},source,{from:'2026-10-01',to:'2026-10-31'}));
  assert.throws(()=>validateOrders({orders:[{...sample,date:'2025-10-12'}]},source,{from:'2026-10-01',to:'2026-10-31'}));
});
test('result envelopes are authenticated and bind the job',async()=>{
  const ciphertext=await seal('test-worker-secret','job-one',{orders:[sample]});
  assert(!ciphertext.includes('콜라'));
  assert.deepEqual(await unseal('test-worker-secret','job-one',ciphertext),{orders:[sample]});
  await assert.rejects(unseal('other-secret','job-one',ciphertext));
  await assert.rejects(unseal('test-worker-secret','job-two',ciphertext));
});
