import assert from 'node:assert/strict';
import test from 'node:test';
import {glasses, phone, passing, paymentFixture} from './payment-fixture.ts';

// Glasses voice payment requires a live glasses enrollment.
// Identity matching stays the shared registry's responsibility; verdicts here are explicit fakes.
for (const enrolled of [false, true]) test(`owner condition 8: glasses voice payment ${enrolled ? 'works after glasses enrollment' : 'requires glasses enrollment even when phone enrollment is live'}`, async t => {
  const f = await paymentFixture(t);
  await f.known(); await f.locks(); f.policy(true, false);
  f.ports.owner = async () => ({live: true, phone_app: true, glasses: enrolled});
  const card = await f.open({initiating: f.initiating('voice', glasses)});
  await f.authority.observePayUtterance('owner', f.utterance(glasses));
  const state = f.authority.store.getPayment(card.payment_id)!.state;
  if (enrolled) {
    assert.equal(state, 'granted');
    assert.equal(f.authority.store.getGrant(card.payment_id)!.method, 'voice');
  } else {
    assert.equal(state, 'awaiting_owner');
    assert.equal(f.authority.store.getGrant(card.payment_id), undefined);
  }
});

for (const source of [phone, glasses]) for (const method of ['voice', 'auto'] as const) {
  for (const enrolled of [false, true]) test(`current ${source.device_type} enrollment ${enrolled ? 'allows' : 'is required for'} ${method} payment`, async t => {
    const f = await paymentFixture(t);
    await f.known(); await f.locks(); f.policy(true, method === 'auto');
    f.ports.owner = async () => ({live: true, phone_app: source === phone ? enrolled : true, glasses: source === glasses ? enrolled : true});
    const card = await f.open({initiating: f.initiating('voice', source)});
    if (method === 'auto') {
      assert.equal(f.authority.store.getPayment(card.payment_id)!.state, enrolled ? 'auto_pending' : 'awaiting_owner');
      await f.advance(f.config.auto.undo_s * 1000);
    } else await f.authority.observePayUtterance('owner', f.utterance(source));
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state, enrolled ? 'granted' : 'awaiting_owner');
    assert.equal(f.authority.store.getGrant(card.payment_id)?.method, enrolled ? method : undefined);
    if (!enrolled && method === 'voice') assert.equal(f.verifierCalls.pay, 0);
  });

  test(`removing ${source.device_type} enrollment while ${method === 'voice' ? 'verification' : 'undo'} is pending prevents a grant`, async t => {
    const f = await paymentFixture(t);
    await f.known(); await f.locks(); f.policy(true, method === 'auto');
    let enrolled = true;
    f.ports.owner = async () => ({live: true, phone_app: source === phone ? enrolled : true, glasses: source === glasses ? enrolled : true});
    const card = await f.open({initiating: f.initiating('voice', source)});
    if (method === 'voice') {
      const verdict = Promise.withResolvers<typeof passing>(); f.deferVoice(verdict.promise);
      const pending = f.authority.observePayUtterance('owner', f.utterance(source));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.authority.store.getPayment(card.payment_id)!.state, 'verifying');
      enrolled = false; verdict.resolve(passing); await pending;
    } else {
      assert.equal(f.authority.store.getPayment(card.payment_id)!.state, 'auto_pending');
      enrolled = false; await f.advance(f.config.auto.undo_s * 1000);
    }
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state, 'awaiting_owner');
    assert.equal(f.authority.store.getGrant(card.payment_id), undefined);
  });

  test(`${method} re-reads ${source.device_type} enrollment after asynchronous grant-time device validation`, async t => {
    const f = await paymentFixture(t);
    await f.known(); await f.locks(); f.policy(true, method === 'auto');
    let enrolled = true;
    f.ports.owner = async () => ({live: true, phone_app: source === phone ? enrolled : true, glasses: source === glasses ? enrolled : true});
    const card = await f.open({initiating: f.initiating('voice', source)});
    const devices = f.ports.devices;
    if (method === 'voice') {
      const verdict = Promise.withResolvers<typeof passing>(); f.deferVoice(verdict.promise);
      const pending = f.authority.observePayUtterance('owner', f.utterance(source));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.authority.store.getPayment(card.payment_id)!.state, 'verifying');
      f.ports.devices = async principal => {enrolled = false; return devices(principal);};
      verdict.resolve(passing); await pending;
    } else {
      f.ports.devices = async principal => {enrolled = false; return devices(principal);};
      await f.advance(f.config.auto.undo_s * 1000);
    }
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state, 'awaiting_owner');
    assert.equal(f.authority.store.getGrant(card.payment_id), undefined);
  });
}

for (const [initiator, payer] of [[phone, glasses], [glasses, phone]] as const) {
  for (const missing of [initiator, payer]) test(`cross-terminal voice requires ${missing.device_type} enrollment (${initiator.device_type} to ${payer.device_type})`, async t => {
    const f = await paymentFixture(t, {voice: {require_same_terminal: false}});
    await f.known(); await f.locks(); f.policy(true, false);
    f.ports.owner = async () => ({live: true, phone_app: missing !== phone, glasses: missing !== glasses});
    const card = await f.open({initiating: f.initiating('voice', initiator)});
    await f.authority.observePayUtterance('owner', f.utterance(payer));
    assert.equal(f.authority.store.getPayment(card.payment_id)!.state, 'awaiting_owner');
    assert.equal(f.authority.store.getGrant(card.payment_id), undefined);
    assert.equal(f.verifierCalls.pay, 0);
  });
}

for (const source of [phone, glasses]) for (const method of ['voice', 'auto'] as const) {
  test(`${source.device_type} ${method} payment works with only its own current enrollment`, async t => {
    const f = await paymentFixture(t);
    await f.known(); await f.locks(); f.policy(true, method === 'auto');
    f.ports.owner = async () => ({live: true, phone_app: source === phone, glasses: source === glasses});
    const card = await f.open({initiating: f.initiating('voice', source)});
    if (method === 'auto') await f.advance(f.config.auto.undo_s * 1000);
    else await f.authority.observePayUtterance('owner', f.utterance(source));
    assert.equal(f.authority.store.getGrant(card.payment_id)?.method, method);
  });
}

test('cancel and unsigned OFF do not load enrollment for another pending voice card', async t => {
  const f = await paymentFixture(t);
  await f.known(); await f.locks(); f.policy(true, false);
  const first = await f.open({initiating: f.initiating('voice', phone)});
  const second = await f.open({initiating: f.initiating('voice', glasses)});
  const projections: string[] = [];
  await f.authority.watch(phone, async p => {projections.push(p.operation);});
  await f.authority.watch(glasses, async p => {projections.push(p.operation);});
  f.ports.owner = async () => {assert.fail('risk-reducing input must not load enrollment');};
  await f.authority.input(phone, {operation: 'payment_decide', payment_id: first.payment_id, decision: 'cancel'});
  for (const kind of ['auto', 'voice'] as const) await f.settings({kind, enabled: false}, false);
  assert.equal(f.authority.store.getPayment(first.payment_id)!.state, 'cancelled');
  assert.equal(f.authority.store.getPayment(second.payment_id)!.state, 'awaiting_owner');
  assert.equal(f.authority.store.getGrant(second.payment_id), undefined);
  assert.ok(projections.includes('payment_cards')); assert.ok(projections.includes('payment_notice'));
});
