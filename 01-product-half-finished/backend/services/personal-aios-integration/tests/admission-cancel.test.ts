import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { PosixStorage } from '../src/storage.ts';
import { EVENT_SCHEMA, digest, type ProcessedEvent } from '../src/contracts.ts';
import { RunAdmission, NativeNotAcceptedError, type AdmissionPolicy, type NativeClient, type NativeRun } from './native-source-fixture.ts';

const policy: AdmissionPolicy = {max_pending_events: 4, max_pending_bytes: 100000, max_event_age_ms: 10000,
  poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'cancel-test'};
// Fake native business state: creates are keyed by Idempotency-Key, stops record their run.
class FakeNative implements NativeClient {
  readonly runs = new Map<string, NativeRun>();
  readonly inputs: string[] = [];
  readonly keys: string[] = [];
  readonly stops: string[] = [];
  creates = 0; logicalRuns = 0; lost = false; busy = 0;
  async create(body: {input: string; session_id: string; care_decision?: true}, key: string): Promise<NativeRun> {
    this.creates++;
    this.keys.push(key);
    const previous = this.runs.get(key);
    if (previous) return {...previous, replayed: true};
    if (this.busy-- > 0) throw new NativeNotAcceptedError('gateway_draining');
    const run: NativeRun = {run_id: `run-${++this.logicalRuns}`, session_id: body.session_id, conversation_session_id: body.session_id, status: 'running'};
    if (body.care_decision) {run.session_id = `paios-care-${run.run_id}`; }
    this.runs.set(key, run); this.inputs.push(JSON.parse(body.input).processed_event_id);
    if (this.lost) {this.lost = false; throw new Error('RESPONSE_LOST');}
    return {...run};
  }
  async status(runId: string): Promise<NativeRun> {
    const run = [...this.runs.values()].find(r => r.run_id === runId); assert.ok(run); return {...run};
  }
  async cancel(runId: string): Promise<NativeRun> {
    this.stops.push(runId); const run = [...this.runs.values()].find(r => r.run_id === runId); assert.ok(run);
    if (run.status === 'running') run.status = 'cancelled';
    return {...run};
  }
  finish(runId: string, status = 'completed'): void {
    const run = [...this.runs.values()].find(r => r.run_id === runId); assert.ok(run); run.status = status;
  }
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('condition did not settle');
}
async function fixture(t: test.TestContext, override: Partial<AdmissionPolicy> = {}) {
  const path = await fs.mkdtemp(join(tmpdir(), 'paios-admission-cancel-'));
  const storage = new PosixStorage(path); const native = new FakeNative(); const instances: RunAdmission[] = [];
  const admission = (n: NativeClient = native) => {
    const instance = new RunAdmission(storage, n, {...policy, ...override}); instances.push(instance); return instance;
  };
  t.after(async () => {await Promise.all(instances.map(instance => instance.close())); await fs.rm(path, {recursive: true, force: true});});
  const ingress = new UnifiedIngress(new RawArchive(storage, 10000, () => '2026-10-01T00:00:00.000Z'));
  const d = async (eventId: string, care = false): Promise<ProcessedEvent> => ingress.accept({schema_version: EVENT_SCHEMA,
    event_id: eventId, device_id: 'mac', device_type: 'mac', captured_at: '2026-10-01T00:00:00.000Z',
    source: {channel: 'text'}, media_type: care ? 'app_event' : 'text', mime: care ? 'application/json' : 'text/plain;charset=utf-8', representation: 'uploaded_original',
    payload: Buffer.from(care ? JSON.stringify({kind:'proactive_care',care_id:eventId}) : eventId)}, {principal_id: 'owner', device_id: 'mac', device_type: 'mac',
    consent_ref: 'consent', channel: 'text', submission: care ? 'observation' : 'explicit_text'});
  const key = (dId: string) => digest({principal_id: 'owner', session_id: 'session', processed_event_id: dId});
  return {path, storage, native, admission, d, key};
}
function gate() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  return {entered: entered.promise, release: () => release.resolve(), block: async () => {entered.resolve(); await release.promise;}};
}

function scheduled(d: ProcessedEvent): ProcessedEvent {
  return {...d, processed_event_id:`d:${digest({origin:d.processed_event_id,kind:'scheduled_task'})}`, user_identity:'unknown', intent_class:'observation',
    media_type: 'app_event', origin: 'device_observation', content: {app_event: {kind: 'scheduled_task'}},
    processing: {...d.processing, path_id: 'direct_app'}};
}

for (const boundary of ['cancel', 'deadline', 'retention'] as const)
test(`owner grant preparation observes ${boundary} before native create`, async t => {
  const f = await fixture(t, {max_event_age_ms: 60000,
    ...(boundary === 'retention' ? {native_idempotency_retention_ms: 10000} : {})});
  const a = f.admission(), original = await f.d(`grant-${boundary}`), d = scheduled(original), g = gate();
  let resolves = 0;
  a.setOwnerOrigin(async () => {
    if (++resolves === (boundary === 'retention' ? 2 : 1)) await g.block();
    return original;
  });
  t.after(() => g.release());
  if (boundary === 'retention') f.native.busy = 1;
  const admitted = await a.admit(d, 'session', 'skill');
  let retentionExpires = 0;
  if (boundary === 'retention') {
    await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'retryable');
    const first = JSON.parse(Buffer.from(await f.storage.read('run-attempts', f.key(d.processed_event_id))).toString());
    retentionExpires = first.at_ms + 10000;
    await a.admit(d, 'session', 'skill');
  }
  await g.entered;
  let cancelling: ReturnType<RunAdmission['cancel']> | undefined;
  if (boundary === 'cancel') {
    cancelling = a.cancel('owner', 'session', d.processed_event_id);
    await until(() => a.get('owner', 'session', d.processed_event_id)?.cancel_requested_at_ms !== undefined);
  } else {
    const expires = boundary === 'deadline' ? admitted.deadline_ms : retentionExpires;
    t.mock.method(Date, 'now', () => expires + 1);
  }
  g.release();
  await cancelling;
  await until(async () => ['cancelled', 'expired'].includes((await a.readOnly('owner', 'session', d.processed_event_id))?.state ?? ''));
  assert.equal(f.native.creates, boundary === 'retention' ? 1 : 0);
  const ended = await a.readOnly('owner', 'session', d.processed_event_id);
  assert.equal(ended?.state, boundary === 'cancel' ? 'cancelled' : 'expired');
  assert.equal(ended?.retry_reason, boundary === 'cancel' ? 'cancelled_before_send' : `${boundary}_exhausted`);
});

test('owner grant preparation failure creates no attempt and manual recovery retains the native key', async t => {
  const f = await fixture(t, {native_retry: {max_attempts: 2, initial_backoff_ms: 1, max_backoff_ms: 1}});
  const a = f.admission(), original = await f.d('grant-failed'), d = scheduled(original);
  let fail = true, resolutions = 0;
  a.setOwnerOrigin(async () => {resolutions++; if (fail) throw new Error('ORIGIN_UNAVAILABLE'); return original;});
  const admitted = await a.admit(d, 'session', 'skill');
  await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'reconcile_required');
  await a.close();
  assert.equal(f.native.creates, 0);
  assert.deepEqual(await f.storage.list('run-attempts'), []);
  assert.equal(resolutions, 1, 'grant failure does not consume native retries');
  assert.equal(a.get('owner', 'session', d.processed_event_id)?.retry_reason, undefined);
  fail = false;
  const recovered = f.admission(); recovered.setOwnerOrigin(async () => original);
  await recovered.recover();
  await recovered.reconcile('owner', 'session', d.processed_event_id);
  await until(() => recovered.get('owner', 'session', d.processed_event_id)?.state === 'running');
  assert.equal(recovered.get('owner', 'session', d.processed_event_id)?.idempotency_key, admitted.idempotency_key);
  assert.deepEqual([...f.native.runs.keys()], [admitted.idempotency_key]);
});

test('queued unsent D cancelled behind a running D never reaches native create after the first run ends', async t => {
  const f = await fixture(t); const a = f.admission(); const first = await f.d('first'); const queued = await f.d('queued');
  await a.admit(first, 'session', 'skill');
  await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'running');
  await a.admit(queued, 'session', 'skill');
  const receipt = await a.cancel('owner', 'session', queued.processed_event_id);
  assert.deepEqual(receipt, {status: 'cancelled', run_id: null, state: 'cancelled'});
  const ended = await a.readOnly('owner', 'session', queued.processed_event_id);
  assert.equal(ended?.state, 'cancelled'); assert.equal(ended?.retry_reason, 'cancelled_before_send');
  const terminal = JSON.parse(await fs.readFile(join(f.path, 'run-terminals', f.key(queued.processed_event_id)), 'utf8'));
  assert.deepEqual(terminal, {status: 'cancelled', run_id: null, admission_reason: 'cancelled_before_send'});
  f.native.finish(a.get('owner', 'session', first.processed_event_id)!.run_id!);
  await until(async () => (await a.readOnly('owner', 'session', first.processed_event_id))?.state === 'completed');
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(f.native.inputs, [first.processed_event_id]); assert.equal(f.native.creates, 1);
  // Repeated cancel of the local terminal is idempotent; a restart never resurrects it.
  assert.deepEqual(await a.cancel('owner', 'session', queued.processed_event_id), receipt);
  await a.close(); const restarted = f.admission(); await restarted.recover();
  await new Promise(r => setTimeout(r, 30)); assert.equal(f.native.creates, 1);
});

for (const boundary of ['attempt-read', 'attempt-publish'] as const)
test(`cancel inside the start() to ${boundary} window settles cancelled without a native request`, async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d(`window-${boundary}`); const g = gate();
  const read = f.storage.read.bind(f.storage), publish = f.storage.publish.bind(f.storage); let held = false;
  f.storage.read = async (space, key) => {
    if (boundary === 'attempt-read' && space === 'run-attempts' && !held) {held = true; await g.block();}
    return read(space, key);
  };
  f.storage.publish = async (space, key, bytes) => {
    if (boundary === 'attempt-publish' && space === 'run-attempts' && !held) {held = true; const saved = await publish(space, key, bytes); await g.block(); return saved;}
    return publish(space, key, bytes);
  };
  t.after(() => g.release());
  await a.admit(d, 'session', 'skill'); await g.entered;
  const cancelling = a.cancel('owner', 'session', d.processed_event_id);
  // The intent is applied once durable; only then may execute resume toward its send decision.
  await until(() => a.get('owner', 'session', d.processed_event_id)?.cancel_requested_at_ms !== undefined);
  g.release();
  assert.deepEqual(await cancelling, {status: 'cancelled', run_id: null, state: 'cancelled'});
  assert.equal(f.native.creates, 0);
  const results = await f.storage.list('run-attempt-results');
  if (boundary === 'attempt-publish') {
    assert.equal(results.length, 1);
    assert.equal(JSON.parse(Buffer.from(await read('run-attempt-results', results[0]!)).toString()).local_unsent_reason, 'cancelled_before_send');
  } else assert.equal(results.length, 0);
  await a.close(); const restarted = f.admission();
  const record = await restarted.getAsync('owner', 'session', d.processed_event_id);
  assert.equal(record?.state, 'cancelled'); assert.equal(record?.retry_reason, 'cancelled_before_send'); assert.equal(f.native.creates, 0);
});

for (const outcome of ['accepted', 'refused'] as const)
test(`cancel while create is in flight: ${outcome} create is ${outcome === 'accepted' ? 'stopped after binding' : 'cancelled as never accepted'}`, async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d(`flight-${outcome}`); const next = await f.d(`flight-${outcome}-next`);
  const g = gate(); const create = f.native.create.bind(f.native); let first = true;
  f.native.create = async (body, key) => {
    if (first) {first = false; await g.block(); if (outcome === 'refused') {f.native.creates++; throw new NativeNotAcceptedError('gateway_draining');}}
    return create(body, key);
  };
  t.after(() => g.release());
  await a.admit(d, 'session', 'skill'); await a.admit(next, 'session', 'skill'); await g.entered;
  const receipt = await a.cancel('owner', 'session', d.processed_event_id);
  assert.deepEqual(receipt, {status: 'cancel_requested', run_id: null, state: 'submitting'});
  g.release();
  await until(async () => (await a.readOnly('owner', 'session', d.processed_event_id))?.state === 'cancelled');
  const ended = await a.readOnly('owner', 'session', d.processed_event_id);
  if (outcome === 'accepted') {
    assert.equal(ended?.run_id, 'run-1'); assert.deepEqual(f.native.stops, ['run-1']);
  } else {
    assert.equal(ended?.run_id, undefined); assert.equal(ended?.retry_reason, 'cancelled_before_send'); assert.deepEqual(f.native.stops, []);
  }
  // The barrier is released only by the authoritative terminal; the next D then runs once.
  await until(() => f.native.inputs.includes(next.processed_event_id));
  assert.equal(f.native.inputs.filter(x => x === d.processed_event_id).length, outcome === 'accepted' ? 1 : 0);
});

test('cancel with acceptance unknown is never marked cancelled; automatic replays stop; explicit reconcile binds then stops', async t => {
  const retry = {max_attempts: 5, initial_backoff_ms: 150, max_backoff_ms: 150};
  const f = await fixture(t, {native_retry: retry}); let a = f.admission();
  const d = await f.d('unknown'); const next = await f.d('unknown-next'); f.native.lost = true;
  const unknown = gate(), read = f.storage.read.bind(f.storage); let held = false;
  f.storage.read = async (space, key) => {
    const value = await read(space, key);
    if (space === 'run-attempts' && !held && a.get('owner', 'session', d.processed_event_id)?.state === 'reconcile_required') {
      held = true; await unknown.block();
    }
    return value;
  };
  await a.admit(d, 'session', 'skill');
  try {
    await unknown.entered;
    await a.admit(next, 'session', 'skill');
    const receipt = await a.cancel('owner', 'session', d.processed_event_id);
    assert.deepEqual(receipt, {status: 'cancel_requested', run_id: null, state: 'reconcile_required'});
  } finally { unknown.release(); }
  await new Promise(r => setTimeout(r, 400));
  assert.equal(f.native.creates, 1, 'no automatic same-key replay may start a cancelled request');
  assert.equal(a.get('owner', 'session', d.processed_event_id)?.state, 'reconcile_required');
  assert.equal(a.get('owner', 'session', next.processed_event_id)?.state, 'pending');
  // Restart honours the intent: still no automatic POST and still not cancelled.
  await a.close(); a = f.admission(); await a.recover(); await new Promise(r => setTimeout(r, 200));
  const restored = await a.getAsync('owner', 'session', d.processed_event_id);
  assert.equal(restored?.state, 'reconcile_required'); assert.equal(typeof restored?.cancel_requested_at_ms, 'number');
  assert.equal(f.native.creates, 1);
  await a.admit(d, 'session', 'skill'); await new Promise(r => setTimeout(r, 50)); assert.equal(f.native.creates, 1);
  // Explicit reconciliation replays the original key once, binds the real run and requests native stop.
  await a.reconcile('owner', 'session', d.processed_event_id);
  await until(async () => (await a.readOnly('owner', 'session', d.processed_event_id))?.state === 'cancelled');
  // Terminal completion releases the session barrier, so the next D can start before a terminal read returns.
  await until(() => f.native.inputs.includes(next.processed_event_id));
  assert.equal(f.native.keys.filter(key => key === restored?.idempotency_key).length, 2);
  assert.equal(f.native.keys.filter(key => key === a.get('owner', 'session', next.processed_event_id)?.idempotency_key).length, 1);
  assert.equal(f.native.creates, 3); assert.equal(f.native.logicalRuns, 2); assert.deepEqual(f.native.stops, ['run-1']);
  assert.equal((await a.readOnly('owner', 'session', d.processed_event_id))?.run_id, 'run-1');
});

test('cancel of a running D requests one native stop and waits for the native terminal', async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d('running'); const next = await f.d('running-next');
  const cancel = f.native.cancel.bind(f.native); f.native.cancel = async runId => {f.native.stops.push(runId); return f.native.status(runId);};
  await a.admit(d, 'session', 'skill'); await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'running');
  await a.admit(next, 'session', 'skill');
  assert.deepEqual(await a.cancel('owner', 'session', d.processed_event_id), {status: 'cancel_requested', run_id: 'run-1', state: 'running'});
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(f.native.stops, ['run-1'], 'the poll loop does not duplicate a stop already sent');
  assert.equal(a.get('owner', 'session', next.processed_event_id)?.state, 'pending', 'a stop response alone keeps the barrier');
  f.native.cancel = cancel; f.native.finish('run-1', 'interrupted');
  await until(async () => (await a.readOnly('owner', 'session', d.processed_event_id))?.state === 'cancelled');
  await until(() => f.native.inputs.includes(next.processed_event_id));
});

test('cancel intent survives restart: bound D re-issues native stop; unsent D finishes cancelled', async t => {
  const f = await fixture(t); let a = f.admission(); const bound = await f.d('restart-bound'); const queued = await f.d('restart-queued');
  const cancel = f.native.cancel.bind(f.native); let stopFails = true;
  f.native.cancel = async runId => {if (stopFails) {f.native.stops.push(`failed:${runId}`); throw new Error('STOP_TRANSPORT_LOST');} return cancel(runId);};
  const publish = f.storage.publish.bind(f.storage); let terminalFails = false;
  f.storage.publish = async (space, key, bytes) => {
    if (terminalFails && space === 'run-terminals') throw new Error('CRASH_BEFORE_TERMINAL');
    return publish(space, key, bytes);
  };
  await a.admit(bound, 'session', 'skill'); await until(() => a.get('owner', 'session', bound.processed_event_id)?.state === 'running');
  await a.admit(queued, 'session', 'skill');
  assert.equal((await a.cancel('owner', 'session', bound.processed_event_id)).status, 'cancel_requested');
  terminalFails = true;
  await assert.rejects(a.cancel('owner', 'session', queued.processed_event_id), /CRASH_BEFORE_TERMINAL/);
  await a.close(); terminalFails = false; stopFails = false;
  assert.equal((await f.storage.list('run-cancel-intents')).length, 2);
  a = f.admission(); await a.recover();
  await until(async () => (await a.readOnly('owner', 'session', bound.processed_event_id))?.state === 'cancelled');
  assert.ok(f.native.stops.includes('run-1'), 'restart re-issues native stop');
  assert.equal((await a.readOnly('owner', 'session', queued.processed_event_id))?.state, 'cancelled');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(f.native.inputs, [bound.processed_event_id]);
});

test('cancel of a terminal D writes no intent and returns its terminal; unknown D is not found', async t => {
  const f = await fixture(t); const a = f.admission(); const d = await f.d('terminal');
  await a.admit(d, 'session', 'skill'); await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'running');
  f.native.finish('run-1');
  await until(() => a.get('owner', 'session', d.processed_event_id) === undefined);
  assert.deepEqual(await a.cancel('owner', 'session', d.processed_event_id), {status: 'already_terminal', run_id: 'run-1', state: 'completed'});
  assert.deepEqual(await f.storage.list('run-cancel-intents'), []); assert.deepEqual(f.native.stops, []);
  await assert.rejects(a.cancel('owner', 'session', 'd:unknown'), /ADMISSION_NOT_FOUND/);
});

test('intent write failure returns an error and leaves the queued D runnable', async t => {
  const f = await fixture(t); const a = f.admission(); const first = await f.d('write-first'); const queued = await f.d('write-queued');
  const publish = f.storage.publish.bind(f.storage);
  f.storage.publish = async (space, key, bytes) => {
    if (space === 'run-cancel-intents') throw new Error('INTENT_WRITE_FAILED');
    return publish(space, key, bytes);
  };
  await a.admit(first, 'session', 'skill'); await until(() => a.get('owner', 'session', first.processed_event_id)?.state === 'running');
  await a.admit(queued, 'session', 'skill');
  await assert.rejects(a.cancel('owner', 'session', queued.processed_event_id), /INTENT_WRITE_FAILED/);
  assert.equal(a.get('owner', 'session', queued.processed_event_id)?.cancel_requested_at_ms, undefined);
  f.native.finish('run-1');
  await until(() => a.get('owner', 'session', queued.processed_event_id)?.state === 'running');
  assert.deepEqual(f.native.inputs, [first.processed_event_id, queued.processed_event_id]);
});

test('cancel of a retryable D sleeping in native Retry-After backoff wakes it and settles cancelled without another create', async t => {
  const f = await fixture(t, {native_retry: {max_attempts: 5, initial_backoff_ms: 2000, max_backoff_ms: 2000}});
  const a = f.admission(); const d = await f.d('backoff'); const next = await f.d('backoff-next'); f.native.busy = 100;
  await a.admit(d, 'session', 'skill'); await a.admit(next, 'session', 'skill');
  await until(() => a.get('owner', 'session', d.processed_event_id)?.state === 'retryable');
  const began = Date.now();
  assert.deepEqual(await a.cancel('owner', 'session', d.processed_event_id), {status: 'cancelled', run_id: null, state: 'cancelled'});
  assert.ok(Date.now() - began < 1000, 'cancel does not wait for the backoff to elapse');
  assert.equal(f.native.creates, 1); f.native.busy = 0;
  // The released session barrier lets the next D run; the cancelled D is never re-sent.
  await until(() => f.native.inputs.includes(next.processed_event_id));
  assert.deepEqual(f.native.inputs, [next.processed_event_id]);
});


test('restart restores independent care barriers and preserves ordinary conversation ordering', async t => {
  const f = await fixture(t); let a = f.admission();
  const owner = await f.d('owner'), care1 = await f.d('care-1', true), care2 = await f.d('care-2', true), queued = await f.d('queued');
  for (const d of [owner, care1, care2, queued]) await a.admit(d, 'session', 'skill');
  await until(() => f.native.logicalRuns === 3);
  assert.equal(a.get('owner', 'session', queued.processed_event_id)?.state, 'pending');
  await a.close(); a = f.admission(); await a.recover();
  assert.equal(f.native.logicalRuns, 3, 'bound care runs are polled, never recreated');
  await a.admit(care1, 'session', 'skill'); assert.equal(f.native.creates, 3, 'same care event is idempotent');
  f.native.finish(a.get('owner', 'session', owner.processed_event_id)!.run_id!);
  await until(() => f.native.logicalRuns === 4);
  assert.equal(a.get('owner', 'session', care2.processed_event_id)?.state, 'running');
  await a.cancel('owner', 'session', care1.processed_event_id);
  await until(async () => (await a.readOnly('owner', 'session', care1.processed_event_id))?.state === 'cancelled');
  assert.equal(a.get('owner', 'session', care2.processed_event_id)?.state, 'running');
});
