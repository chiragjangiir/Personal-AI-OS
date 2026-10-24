import assert from 'node:assert/strict';
import test from 'node:test';
import {paymentFixture} from './payment-fixture.ts';

test('I1 replay: an owner phrase captured before a card cannot authorize it when delivery is delayed',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const prior=f.utterance();await f.advance(3001);
  const card=await f.open({initiating:f.initiating('voice')});
  await f.authority.observePayUtterance('owner',prior);
  assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'awaiting_owner');
  assert.equal(f.authority.store.getGrant(card.payment_id),undefined);
  assert.equal(f.verifierCalls.pay,0);
});

test('I1 exact card binding: a phrase beginning before the new amount card is ignored; a fresh phrase can pay',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const card=await f.open({initiating:f.initiating('voice')}),opened=f.now;
  const overlapping=f.utterance();overlapping.start_ms=opened-1;
  await f.authority.observePayUtterance('owner',overlapping);
  assert.equal(f.authority.store.getGrant(card.payment_id),undefined);
  assert.equal(f.verifierCalls.pay,0);
  await f.advance(3001);await f.authority.observePayUtterance('owner',f.utterance());
  assert.equal(f.authority.store.getGrant(card.payment_id)!.method,'voice');
});
