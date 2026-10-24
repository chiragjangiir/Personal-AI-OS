import assert from 'node:assert/strict';
import test from 'node:test';
import {paymentFixture,passing,phone} from './payment-fixture.ts';

async function ready(t:test.TestContext,auto=false){
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,auto);return f;
}
test('owner override disables voice and auto while signed per-request phone cards still pay',async t=>{
  const f=await ready(t,true);f.override(true);
  const requested=await f.request(f.initiating());assert.deepEqual(requested.hint,{voice:false,auto:false});
  const c=await f.open({initiating:f.initiating()});
  assert.equal(f.authority.store.getPayment(c.payment_id)!.state,'awaiting_owner');
  await f.authority.observePayUtterance('owner',f.utterance());
  assert.equal(f.verifierCalls.pay,0);assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  await f.pay(c.payment_id);await f.complete(c.payment_id);
  assert.equal(f.authority.store.getPayment(c.payment_id)!.state,'paid');
  assert.equal(f.authority.store.getGrant(c.payment_id)!.method,'card');
});
test('owner override activated while pay verifier is pending cannot authorize payment',async t=>{
  const f=await ready(t);const c=await f.open({initiating:f.initiating()});
  let resolve!:(v:typeof passing)=>void;f.deferVoice(new Promise(r=>{resolve=r;}));
  let started!:()=>void;const began=new Promise<void>(r=>{started=r;});
  const stop=await f.authority.watch(phone,async()=>{
    if(f.authority.store.getPayment(c.payment_id)!.state==='verifying')started();
  });
  const verifying=f.authority.observePayUtterance('owner',f.utterance());await began;
  f.override(true);resolve(passing);await verifying;stop();
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  assert.equal(f.authority.store.getPayment(c.payment_id)!.state,'awaiting_owner');
  await f.pay(c.payment_id);await f.complete(c.payment_id);
});
test('owner override stops an already scheduled automatic grant',async t=>{
  const f=await ready(t,true);const c=await f.open({initiating:f.initiating()});
  assert.equal(f.authority.store.getPayment(c.payment_id)!.state,'auto_pending');
  f.override(true);await f.advance(f.config.auto.undo_s*1000);
  assert.equal(f.authority.store.getGrant(c.payment_id),undefined);
  assert.equal(f.authority.store.getPayment(c.payment_id)!.state,'awaiting_owner');
  await f.pay(c.payment_id);await f.complete(c.payment_id);
});
for(const method of ['voice','auto'] as const)test(`owner override blocks consuming a preexisting ${method} grant`,async t=>{
  const f=await ready(t,method==='auto');const c=await f.open({initiating:f.initiating()});
  if(method==='auto')await f.advance(f.config.auto.undo_s*1000);
  else await f.authority.observePayUtterance('owner',f.utterance());
  const g=f.authority.store.getGrant(c.payment_id)!;assert.equal(g.method,method);
  f.override(true);
  await assert.rejects(f.authority.tap(c.payment_id,{grant_id:g.grant_id,step:1,read_amount_fen:g.amount_fen,screen_sha256:'b'.repeat(64)}),{code:'PAYMENT_OWNER_OVERRIDE_ACTIVE'});
  assert.equal(f.authority.store.getGrant(c.payment_id)!.taps,0);
});
