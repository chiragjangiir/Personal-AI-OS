import assert from 'node:assert/strict';
import test from 'node:test';
import {paymentFixture,passing,phone} from './payment-fixture.ts';

test('I1 replay: one archived owner phrase cannot authorize two cards that already existed before it',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const older=await f.open({initiating:f.initiating('voice')});
  await f.advance(1);const newer=await f.open({initiating:f.initiating('voice')});
  const phrase=f.utterance();await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.authority.store.getGrant(newer.payment_id)!.method,'voice');
  assert.equal(f.authority.store.getGrant(older.payment_id),undefined);
  const verified=f.verifierCalls.pay;
  await f.advance(3001);await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.authority.store.getPayment(older.payment_id)!.state,'awaiting_owner');
  assert.equal(f.authority.store.getGrant(older.payment_id),undefined);
  assert.equal(f.verifierCalls.pay,verified);
});

test('I1 replay: a phrase reserved by slow verification cannot verify another pending card after dedupe expires',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const older=await f.open({initiating:f.initiating('voice')});
  await f.advance(1);const newer=await f.open({initiating:f.initiating('voice')});
  const phrase=f.utterance(),verdict=Promise.withResolvers<typeof passing>();f.deferVoice(verdict.promise);
  const pending=f.authority.observePayUtterance('owner',phrase);
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.authority.store.getPayment(newer.payment_id)!.state,'verifying');
    f.deferVoice(undefined);await f.advance(3001);await f.authority.observePayUtterance('owner',phrase);
    assert.equal(f.authority.store.getPayment(older.payment_id)!.state,'awaiting_owner');
    assert.equal(f.authority.store.getGrant(older.payment_id),undefined);
    assert.equal(f.verifierCalls.pay,1);
  }finally{verdict.resolve(passing);await pending;}
  assert.equal(f.authority.store.getGrant(newer.payment_id)!.method,'voice');
});

test('I1 replay: repeated same-card phrase after restart preserves the original grant and verifier count',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const card=await f.open({initiating:f.initiating('voice')}),phrase=f.utterance();
  await f.authority.observePayUtterance('owner',phrase);const grant=f.authority.store.getGrant(card.payment_id)!;
  assert.equal(grant.method,'voice');
  await f.advance(3001);f.reopen();await f.unlock();
  await f.authority.observePayUtterance('owner',phrase);
  assert.deepEqual(f.authority.store.getGrant(card.payment_id),grant);
  assert.equal(f.verifierCalls.pay,1);
  assert.equal(f.authority.store.events(card.payment_id).filter(e=>e.kind==='grant_issued').length,1);
});

test('I1 replay: revision and event metadata cannot free a consumed archived phrase after restart',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const older=await f.open({initiating:f.initiating('voice')});
  await f.advance(1);const newer=await f.open({initiating:f.initiating('voice')});
  const phrase=f.utterance();await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.authority.store.getGrant(newer.payment_id)!.method,'voice');
  await f.advance(3001);f.reopen();await f.unlock();
  await f.authority.observePayUtterance('owner',{...phrase,raw_ref:'copied-archive-ref',end_ms:phrase.end_ms+1,archive_revision:'a'.repeat(64),processed_event_id:'replayed-event',captured_at:new Date(f.now).toISOString(),transcript:'付吧。'});
  assert.equal(f.authority.store.getPayment(older.payment_id)!.state,'awaiting_owner');
  assert.equal(f.authority.store.getGrant(older.payment_id),undefined);
  assert.equal(f.verifierCalls.pay,1);
});

test('I1 replay: restart during verification retains phrase consumption while a fresh phrase can pay',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const card=await f.open({initiating:f.initiating('voice')}),phrase=f.utterance();
  const verdict=Promise.withResolvers<typeof passing>();f.deferVoice(verdict.promise);
  const pending=f.authority.observePayUtterance('owner',phrase);
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'verifying');
    f.reopen();await f.unlock();
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'awaiting_owner');
  }finally{verdict.resolve(passing);await pending;f.deferVoice(undefined);}
  await f.advance(3001);
  await f.authority.observePayUtterance('owner',{...phrase,captured_at:new Date(f.now).toISOString()});
  assert.equal(f.authority.store.getGrant(card.payment_id),undefined);
  assert.equal(f.verifierCalls.pay,1);
  await f.authority.observePayUtterance('owner',f.utterance());
  assert.equal(f.authority.store.getGrant(card.payment_id)!.method,'voice');
  assert.equal(f.verifierCalls.pay,2);
});

test('I1 replay: a failed verification consumes that phrase without borrowing it for another card',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true,false);
  const older=await f.open({initiating:f.initiating('voice')});
  await f.advance(1);const newer=await f.open({initiating:f.initiating('voice')});
  const phrase=f.utterance();f.verdict({...passing,verdict:'uncertain'});
  await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.authority.store.getPayment(newer.payment_id)!.voice_attempts,1);
  await f.authority.input(phone,{operation:'payment_decide',control_id:'cancel-newer',payment_id:newer.payment_id,decision:'cancel'});
  f.verdict(passing);await f.advance(3001);await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.authority.store.getPayment(older.payment_id)!.state,'awaiting_owner');
  assert.equal(f.authority.store.getGrant(older.payment_id),undefined);
  assert.equal(f.verifierCalls.pay,1);
});
