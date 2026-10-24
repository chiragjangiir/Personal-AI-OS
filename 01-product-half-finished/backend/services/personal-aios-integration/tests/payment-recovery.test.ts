import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentFixture} from './payment-fixture.ts';

test('unknown remains closed after reopen; only a new card and post-card decision can continue',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const original=await f.open({initiating:f.initiating('voice')});
  await f.authority.observePayUtterance('owner',f.utterance());
  const grant=f.authority.store.getGrant(original.payment_id)!;
  assert.equal(grant.method,'voice');
  const tap={grant_id:grant.grant_id,step:1,read_amount_fen:1660,screen_sha256:'b'.repeat(64)};
  await f.authority.tap(original.payment_id,tap);
  const result={grant_id:grant.grant_id,outcome:'unknown',signs:[],screen_sha256:'c'.repeat(64)};
  assert.deepEqual(await f.authority.result(original.payment_id,result),{state:'outcome_unknown'});
  f.reopen();await f.unlock();
  assert.equal(f.authority.store.getPayment(original.payment_id)!.state,'outcome_unknown');
  assert.equal(f.authority.store.getIntent(original.intent_id)!.state,'closed');
  assert.deepEqual(f.authority.store.getGrant(original.payment_id),{...grant,taps:1,first_tap_at_ms:f.now});
  assert.equal(f.authority.source(f.authority.store.getIntent(original.intent_id)!.run_id,original.intent_id),false);
  assert.deepEqual(await f.authority.tap(original.payment_id,tap),{ok:true},'same admission receipt is replayed; it is not a new input');
  assert.deepEqual(await f.authority.result(original.payment_id,result),{state:'outcome_unknown'});
  await assert.rejects(f.authority.tap(original.payment_id,{...tap,screen_sha256:'d'.repeat(64)}),/PAYMENT_ALREADY_DECIDED/);
  await assert.rejects(f.authority.tap(original.payment_id,{...tap,step:2}),/PAYMENT_TAP_LIMIT/);
  await assert.rejects(f.authority.checkpoint({...original.checkpoint,seq:2}),/PAYMENT_INTENT_CLOSED/);
  assert.equal(f.authority.store.getGrant(original.payment_id)!.taps,1);
  assert.equal(f.authority.store.events(original.payment_id).filter(e=>e.kind==='tap_started').length,1);
  assert.equal(f.authority.store.events(original.payment_id).filter(e=>e.kind==='grant_issued').length,1);

  await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance());
  assert.equal(f.authority.store.events().filter(e=>e.kind==='voice_ignored').at(-1)!.data.reason,'NO_PENDING_PAYMENT');
  const requested=await f.request(f.initiating('voice'));
  assert.equal(requested.status,'accepted');assert.notEqual(requested.intent_id,original.intent_id);
  await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance());
  assert.equal(f.authority.store.events().filter(e=>e.kind==='voice_ignored').at(-1)!.data.reason,'NO_PENDING_PAYMENT');
  const card=await f.authority.checkpoint({...original.checkpoint,intent_id:String(requested.intent_id),job_id:'same-order-continuation',seq:1});
  const id=String(card.payment_id);
  assert.equal(card.state,'awaiting_owner');assert.equal(f.authority.store.getGrant(id),undefined);
  await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance());
  const fresh=f.authority.store.getGrant(id)!;
  assert.equal(f.authority.store.getPayment(id)!.state,'granted');assert.equal(fresh.method,'voice');
  assert.notEqual(fresh.grant_id,grant.grant_id);
  await assert.rejects(f.authority.tap(id,{...tap,grant_id:grant.grant_id}),/PAYMENT_GRANT_INVALID/);
  assert.equal(f.authority.store.getGrant(id)!.taps,0);
  await f.complete(id);
  assert.equal(f.authority.store.getPayment(id)!.state,'paid');
  assert.equal(f.authority.store.getGrant(id)!.taps,1);
  assert.equal(f.authority.store.getPayment(original.payment_id)!.state,'outcome_unknown');
});

test('typed recovery requests remain card-only despite a later passing voice',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const card=await f.open({initiating:f.initiating('text')});
  await f.authority.observePayUtterance('owner',f.utterance());
  assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'awaiting_owner');
  assert.equal(f.authority.store.getPayment(card.payment_id)!.reason,'INITIATING_NOT_VOICE');
  assert.equal(f.authority.store.getGrant(card.payment_id),undefined);assert.equal(f.verifierCalls.pay,0);
  await f.pay(card.payment_id);assert.equal(f.authority.store.getGrant(card.payment_id)!.method,'card');
  await f.complete(card.payment_id);assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'paid');
});
