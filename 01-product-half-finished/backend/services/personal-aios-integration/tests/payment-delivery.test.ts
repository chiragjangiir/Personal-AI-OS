import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentFixture,phone} from './payment-fixture.ts';

const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));

for(const boundary of ['snapshot','publish','binding lookup'] as const)test(`payment delivery retries the latest snapshot after one ${boundary} failure`,async t=>{
  const f=await paymentFixture(t),card=await f.open(),frames:Record<string,unknown>[]=[],failed=Promise.withResolvers<void>();
  let fault=false;
  await f.authority.watch(phone,async frame=>{
    if(fault&&boundary==='publish'){fault=false;failed.resolve();throw Error('fixture publish');}
    frames.push(frame);
  });frames.length=0;
  const owner=f.ports.owner,revalidate=f.ports.revalidate;
  f.ports.owner=async principal=>{if(fault&&boundary==='snapshot'){fault=false;failed.resolve();throw Error('fixture snapshot');}return owner(principal);};
  f.ports.revalidate=async source=>{if(fault&&boundary==='binding lookup'){fault=false;failed.resolve();throw Error('fixture binding lookup');}return revalidate(source);};
  // terminalChanged validates its caller before reaching the watcher's own binding lookup.
  if(boundary==='binding lookup'){
    let calls=0;f.ports.revalidate=async source=>{if(fault&&++calls===2){fault=false;failed.resolve();throw Error('fixture binding lookup');}return revalidate(source);};
  }
  fault=true;
  await f.authority.terminalChanged(phone);await failed.promise;await settled();
  const original=f.authority.store.getPayment(card.payment_id)!;
  // The retry must rebuild from authority state, rather than replay the failed projection.
  f.setNow(original.expires_at_ms);
  await f.authority.tick();await settled();
  const cards=frames.filter(frame=>frame.operation==='payment_cards').at(-1)!.cards as {state:string;version:number}[];
  assert.equal(cards[0]!.state,'expired');
  assert.equal(cards[0]!.version,f.authority.store.getPayment(card.payment_id)!.version);
  assert.equal(f.authority.store.getGrant(card.payment_id),undefined);
});

test('payment retry uses the authority timer without another business event and stops on revocation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await paymentFixture(t);let fail=false,attempts=0;
  const failed=Promise.withResolvers<void>();
  await f.authority.watch(phone,async()=>{attempts++;if(fail){failed.resolve();throw Error('fixture publish');}});
  fail=true;await f.authority.terminalChanged(phone);await failed.promise;await settled();
  const before=attempts;
  for(let n=0;n<10;n++)await f.authority.terminalChanged(phone);
  assert.equal(attempts,before,'updates cannot bypass the retry cadence');
  fail=false;f.setNow(f.now+999);t.mock.timers.tick(999);await settled();assert.equal(attempts,before);
  f.setNow(f.now+1);t.mock.timers.tick(1);await settled();
  assert.ok(attempts>before,'the retry runs without a payment mutation or re-bootstrap');
  fail=true;await f.authority.terminalChanged(phone);await settled();
  const revokedAt=attempts;
  f.revoke(phone);f.authority.sourceRejected(phone,Object.assign(Error('revoked'),{code:'PAIRED_DEVICE_REVOKED'}));
  f.setNow(f.now+1000);t.mock.timers.tick(1000);await f.authority.tick();await settled();
  assert.equal(attempts,revokedAt,'revoked subscriptions never retry');
});

test('revocation during an in-flight payment snapshot stops its remaining projections',async t=>{
  const f=await paymentFixture(t),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let hold=false,deliveries=0;
  await f.authority.watch(phone,async()=>{if(hold){deliveries++;entered.resolve();await release.promise;}});
  hold=true;const changed=f.authority.terminalChanged(phone);
  try{
    await entered.promise;f.revoke(phone);
    f.authority.sourceRejected(phone,Object.assign(Error('revoked'),{code:'PAIRED_DEVICE_REVOKED'}));
  }finally{release.resolve();await changed;await settled();}
  assert.equal(deliveries,1);
});

test('a slow payment subscriber cannot block another subscriber or voice verification; backlog keeps only the latest snapshot',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true);
  const card=await f.open({initiating:f.initiating('voice')}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let slow=false,flights=0,maxFlights=0;const slowStates:string[]=[],fastStates:string[]=[];
  await f.authority.watch(phone,async frame=>{
    if(frame.operation!=='payment_cards')return;
    flights++;maxFlights=Math.max(maxFlights,flights);
    try{slowStates.push((frame.cards as {state:string}[])[0]!.state);if(slow){entered.resolve();await release.promise;}}
    finally{flights--;}
  });
  await f.authority.watch(phone,async frame=>{if(frame.operation==='payment_cards')fastStates.push((frame.cards as {state:string}[])[0]!.state);});
  slow=true;const phrase=f.utterance(),verification=f.authority.observePayUtterance('owner',phrase);
  try{
    await entered.promise;await settled();
    assert.equal(f.verifierCalls.pay,1,'the consumed phrase starts its verifier before delivery settles');
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'granted');
    assert.equal(fastStates.at(-1),'granted','other subscribers progress independently');
    for(let n=0;n<10;n++)await f.authority.terminalChanged(phone);
    assert.equal(maxFlights,1);assert.equal(slowStates.length,2,'updates coalesce behind one in-flight snapshot');
  }finally{slow=false;release.resolve();await verification;await settled();}
  assert.equal(slowStates.at(-1),'granted');
  await f.advance(3001);await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.verifierCalls.pay,1);assert.equal(f.authority.store.events(card.payment_id).filter(e=>e.kind==='grant_issued').length,1);
  assert.equal(f.authority.store.getGrant(card.payment_id)!.taps,0);
});

test('a durable verifying phrase starts exactly once even when after fails in the update outbox',async t=>{
  const f=await paymentFixture(t);await f.known();await f.locks();f.policy(true);
  const card=await f.open({initiating:f.initiating('voice')}),phrase=f.utterance(),original=f.ports.context;
  f.authority.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('payment-context:fixture',JSON.stringify({principal:'owner',text:'fixture'}));
  f.ports.context=async()=>{throw Error('fixture context delivery');};
  const verification=f.authority.observePayUtterance('owner',phrase);
  await assert.rejects(verification,/fixture context delivery/);
  assert.equal(f.verifierCalls.pay,1);assert.equal(f.authority.store.getPayment(card.payment_id)!.state,'granted');
  f.ports.context=original;await f.advance(3001);await f.authority.observePayUtterance('owner',phrase);
  assert.equal(f.verifierCalls.pay,1);assert.equal(f.authority.store.events(card.payment_id).filter(e=>e.kind==='grant_issued').length,1);
  assert.equal(f.authority.store.getGrant(card.payment_id)!.taps,0);
});
