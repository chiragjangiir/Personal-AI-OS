import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import type { AcceptedUserActivity, RealtimeSessionRecord } from '../../../services/realtime-core/src/types.ts';
import {
  REALTIME_ACCEPTED_USER_ACTIONS,
  RealtimeAcceptedUserActivityProductionError,
  createRealtimeAcceptedUserActivityProduction,
  type RealtimeAcceptedUserActivityOwnerEvent,
  type RealtimeAcceptedUserActivityOwnerSource,
} from '../src/realtime-accepted-user-activity-production.ts';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const SESSION = Object.freeze({
  ref_type: 'RealtimeSession',
  ref_id: '018f0000-0000-7000-8000-000000000001',
  object_version: '1',
  canonical_payload_sha256: 'a'.repeat(64),
});
const ACCEPTANCE = Object.freeze({
  ref_type: 'ContextAssertion',
  ref_id: '018f0000-0000-7000-8000-000000000002',
  object_version: '1',
  canonical_payload_sha256: 'b'.repeat(64),
});
const WATCH_EVIDENCE = Object.freeze({
  ref_type: 'Observation',
  ref_id: '018f0000-0000-7000-8000-000000000003',
  object_version: '1',
  canonical_payload_sha256: 'c'.repeat(64),
});
const RESULT = Object.freeze({ state: 'active' }) as unknown as RealtimeSessionRecord;

function eventFor(
  activityId = 'owner-action-receipt-0001',
  action: string = 'cycling_start',
): RealtimeAcceptedUserActivityOwnerEvent {
  const activity = {
    activityId,
    kind: 'accepted_user_activity',
    userId: 'user-1',
    deviceId: 'iphone-canonical-1',
    realtimeSessionRef: SESSION,
    continuityId: 'continuity-1',
    occurredAt: '2026-08-30T11:59:30.000Z',
    acceptanceRef: ACCEPTANCE,
    accepted: true,
  } as const;
  return {
    activity: activity as unknown as AcceptedUserActivity,
    actionReceipt: {
      kind: 't04.accepted_user_action_receipt',
      activityId,
      action,
      purpose: 'cycling_assistant',
      origin: 'iphone',
      committed: true,
      revoked: false,
      deleted: false,
      stale: false,
      bindingCommitted: action === 'explicit_handoff',
    },
    currentBinding: {
      userId: activity.userId,
      activeDeviceId: activity.deviceId,
      realtimeSessionRef: SESSION,
      continuityId: activity.continuityId,
      sessionState: 'active',
      continuityState: 'active',
      transportState: 'connected',
      leaseState: 'active',
      lastAcceptedUserActivityAt: '2026-08-30T11:59:00.000Z',
      continuityExpiresAt: '2026-08-30T12:10:00.000Z',
      leaseExpiresAt: '2026-08-30T12:05:00.000Z',
    },
    authorityProjection: {
      kind: 't04.activity_authority_projection',
      environment: 'production',
      activityId,
      origin: 'user',
      userOriginated: true,
      accepted: true,
      current: true,
      deleted: false,
      suppressed: false,
      stale: false,
      purpose: 'cycling_assistant',
      userId: activity.userId,
      deviceId: activity.deviceId,
      realtimeSessionRef: SESSION,
      continuityId: activity.continuityId,
      sessionTime: activity.occurredAt,
      acceptanceRef: ACCEPTANCE,
      authorityWatermark: { owner: 'T04', sequence: '17' },
      watermarkCurrent: true,
      evidence: [{
        kind: 'ContextAssertion',
        evidenceRef: ACCEPTANCE,
        activityId,
        userOriginated: true,
        authority: true,
        current: true,
        deleted: false,
        suppressed: false,
        stale: false,
      }],
    },
  };
}

function mutableEvent(activityId = 'owner-action-receipt-0001', action = 'cycling_start'):
  Record<string, any> {
  return structuredClone(eventFor(activityId, action)) as Record<string, any>;
}

function sourceFixture(environment: 'production' | 'non-production' = 'production') {
  let consumer: ((event: RealtimeAcceptedUserActivityOwnerEvent) => Promise<RealtimeSessionRecord>) | undefined;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let closeCalls = 0;
  let ready = true;
  const source: RealtimeAcceptedUserActivityOwnerSource = {
    owner: 'T04.accepted-user-activity',
    environment,
    isReady: () => ready,
    subscribe(next) {
      subscribeCalls += 1;
      consumer = next;
      return () => { unsubscribeCalls += 1; consumer = undefined; };
    },
    close() { closeCalls += 1; },
  };
  return {
    source,
    emit(event: RealtimeAcceptedUserActivityOwnerEvent) {
      assert.ok(consumer, 'source is bound');
      return consumer(event);
    },
    setReady(value: boolean) { ready = value; },
    counts: () => ({ subscribeCalls, unsubscribeCalls, closeCalls }),
  };
}

function harness(environment: 'production' | 'non-production' = 'production') {
  const source = sourceFixture(environment);
  let sinkCalls = 0;
  const seen: unknown[] = [];
  const bridge = createRealtimeAcceptedUserActivityProduction({
    source: source.source,
    sink: {
      async recordAcceptedUserActivity(activity) {
        sinkCalls += 1;
        seen.push(activity);
        return RESULT;
      },
    },
    equality: createProductionStructuralEquality(),
    purpose: 'cycling_assistant',
    now: () => NOW,
  });
  return { bridge, source, sinkCalls: () => sinkCalls, seen };
}

async function rejectsCode(operation: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  await assert.rejects(
    typeof operation === 'function' ? async () => operation() : operation,
    (error: unknown) => error instanceof RealtimeAcceptedUserActivityProductionError && error.code === code,
  );
}

test('binds one production subscription and records every closed user-action class exactly once', async () => {
  const h = harness();
  assert.deepEqual(h.bridge.readiness(), {
    owner: 'T04.accepted-user-activity', environment: 'production', ready: true,
  });
  h.bridge.bind();
  h.bridge.bind();
  assert.equal(h.source.counts().subscribeCalls, 1);
  for (const [index, action] of REALTIME_ACCEPTED_USER_ACTIONS.entries()) {
    const result = await h.source.emit(eventFor(`owner-action-receipt-${index + 1}`, action));
    assert.equal(result, RESULT);
  }
  assert.equal(h.sinkCalls(), REALTIME_ACCEPTED_USER_ACTIONS.length);
  assert.equal(h.seen.length, REALTIME_ACCEPTED_USER_ACTIONS.length);
});

test('Watch actions retain the active iPhone device and require matching authority evidence', async () => {
  const h = harness();
  h.bridge.bind();
  const event = mutableEvent('watch-action-receipt-1', 'cycling_lap');
  event.actionReceipt = {
    ...event.actionReceipt,
    origin: 'watch_via_active_iphone',
    watchAuthorityEvidenceRef: WATCH_EVIDENCE,
  };
  event.authorityProjection.evidence.push({
    kind: 'Observation', evidenceRef: WATCH_EVIDENCE, activityId: event.activity.activityId,
    userOriginated: true, authority: true, current: true, deleted: false, suppressed: false, stale: false,
  });
  await h.source.emit(event as unknown as RealtimeAcceptedUserActivityOwnerEvent);
  assert.equal(h.sinkCalls(), 1);
  const invalid = structuredClone(event);
  invalid.activity.activityId = 'watch-action-receipt-2';
  invalid.actionReceipt.activityId = invalid.activity.activityId;
  invalid.authorityProjection.activityId = invalid.activity.activityId;
  for (const evidence of invalid.authorityProjection.evidence) evidence.activityId = invalid.activity.activityId;
  invalid.actionReceipt.watchAuthorityEvidenceRef = {
    ref_type: 'Observation', ref_id: '018f0000-0000-7000-8000-000000000099',
    object_version: '1', canonical_payload_sha256: 'f'.repeat(64),
  };
  await rejectsCode(
    h.source.emit(invalid as unknown as RealtimeAcceptedUserActivityOwnerEvent),
    'ACCEPTED_ACTIVITY_WATCH_RELAY_INVALID',
  );
  assert.equal(h.sinkCalls(), 1);
});

test('background telemetry, media, model, refresh and failed-request events never reach the sink', async () => {
  const forbidden = [
    'heartbeat', 'rtc_reconnect', 'frame', 'audio', 'video', 'heart_rate_sample', 'energy_sample',
    'speed_sample', 'location_sample', 'model_reply', 'tts_reply', 'display_receipt', 'media_receipt',
    'credential_refresh', 'e2ee_refresh', 'failed_request', 'bootstrap', 'media_stop', 'end_continuity',
  ];
  for (const [index, action] of forbidden.entries()) {
    const h = harness();
    h.bridge.bind();
    await rejectsCode(
      h.source.emit(eventFor(`forbidden-${index}`, action)),
      'ACCEPTED_ACTIVITY_RECEIPT_INVALID',
    );
    assert.equal(h.sinkCalls(), 0, action);
  }
});

test('revoked, deleted, stale, non-user and wrong-purpose authority all fail before the sink', async () => {
  const cases: Array<[string, (event: Record<string, any>) => void, string]> = [
    ['revoked', (event) => { event.actionReceipt.revoked = true; }, 'ACCEPTED_ACTIVITY_RECEIPT_INVALID'],
    ['deleted', (event) => { event.authorityProjection.deleted = true; }, 'ACCEPTED_ACTIVITY_AUTHORITY_INVALID'],
    ['stale', (event) => { event.authorityProjection.stale = true; }, 'ACCEPTED_ACTIVITY_AUTHORITY_INVALID'],
    ['non-user', (event) => { event.authorityProjection.origin = 'system'; }, 'ACCEPTED_ACTIVITY_AUTHORITY_INVALID'],
    ['wrong-purpose', (event) => { event.actionReceipt.purpose = 'background_sync'; }, 'ACCEPTED_ACTIVITY_RECEIPT_INVALID'],
  ];
  for (const [name, mutate, code] of cases) {
    const h = harness();
    h.bridge.bind();
    const event = mutableEvent(`invalid-${name}`);
    mutate(event);
    await rejectsCode(h.source.emit(event as unknown as RealtimeAcceptedUserActivityOwnerEvent), code);
    assert.equal(h.sinkCalls(), 0, name);
  }
});

test('wrong user, device, session, continuity and terminal binding fail before the sink', async () => {
  const cases: Array<[string, (event: Record<string, any>) => void]> = [
    ['user', (event) => { event.currentBinding.userId = 'other'; }],
    ['device', (event) => { event.currentBinding.activeDeviceId = 'watch-local'; }],
    ['session', (event) => { event.currentBinding.realtimeSessionRef = {
      ...event.currentBinding.realtimeSessionRef,
      object_version: '2',
    }; }],
    ['continuity', (event) => { event.currentBinding.continuityId = 'other'; }],
    ['terminal', (event) => { event.currentBinding.sessionState = 'terminal'; }],
  ];
  for (const [name, mutate] of cases) {
    const h = harness();
    h.bridge.bind();
    const event = mutableEvent(`binding-${name}`);
    mutate(event);
    await assert.rejects(h.source.emit(event as unknown as RealtimeAcceptedUserActivityOwnerEvent));
    assert.equal(h.sinkCalls(), 0, name);
  }
});

test('future, old and expired activities fail before the sink; the start instant reaches the owner', async () => {
  const cases: Array<[string, (event: Record<string, any>) => void, string]> = [
    ['future', (event) => { event.activity.occurredAt = '2026-08-30T12:02:00.001Z'; event.authorityProjection.sessionTime = event.activity.occurredAt; }, 'ACCEPTED_ACTIVITY_FUTURE'],
    ['old', (event) => { event.activity.occurredAt = '2026-08-30T11:58:59.999Z'; event.authorityProjection.sessionTime = event.activity.occurredAt; }, 'ACCEPTED_ACTIVITY_OUT_OF_ORDER'],
    ['expired', (event) => { event.currentBinding.leaseExpiresAt = '2026-08-30T12:00:00.000Z'; }, 'ACCEPTED_ACTIVITY_CURRENT_BINDING_EXPIRED'],
  ];
  for (const [name, mutate, code] of cases) {
    const h = harness();
    h.bridge.bind();
    const event = mutableEvent(`time-${name}`);
    mutate(event);
    await rejectsCode(h.source.emit(event as unknown as RealtimeAcceptedUserActivityOwnerEvent), code);
    assert.equal(h.sinkCalls(), 0, name);
  }
  const h = harness();
  h.bridge.bind();
  const start = mutableEvent('time-equal');
  start.activity.occurredAt = start.currentBinding.lastAcceptedUserActivityAt;
  start.authorityProjection.sessionTime = start.activity.occurredAt;
  await h.source.emit(start as unknown as RealtimeAcceptedUserActivityOwnerEvent);
  assert.equal(h.sinkCalls(), 1, 'equal');
  // A device clock a little ahead (the X3 glasses ran ~1.1 s fast) is inside DEVICE_CLOCK_LEAD_MS, as in T04 and pairing.
  const lead = mutableEvent('time-device-lead');
  lead.activity.occurredAt = '2026-08-30T12:00:01.500Z';
  lead.authorityProjection.sessionTime = lead.activity.occurredAt;
  await h.source.emit(lead as unknown as RealtimeAcceptedUserActivityOwnerEvent);
  assert.equal(h.sinkCalls(), 2, 'device clock lead');
});

test('ToolResult is only an attachment and cannot replace one current authority item', async () => {
  const h = harness();
  h.bridge.bind();
  const event = mutableEvent('tool-only');
  event.authorityProjection.evidence = [{
    kind: 'ToolResultArtifact',
    attachmentRef: {
      ref_type: 'ToolResultArtifact', ref_id: '018f0000-0000-7000-8000-000000000004',
      object_version: '1', canonical_payload_sha256: 'd'.repeat(64),
    },
    attachmentActivityId: event.activity.activityId,
    explicitUserInitiated: true,
    acceptedByT04: true,
    authority: false,
  }];
  await rejectsCode(
    h.source.emit(event as unknown as RealtimeAcceptedUserActivityOwnerEvent),
    'ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_REQUIRED',
  );
  assert.equal(h.sinkCalls(), 0);
});

test('missing, non-production and not-ready sources fail before subscription', async () => {
  assert.throws(
    () => createRealtimeAcceptedUserActivityProduction({
      source: undefined as never,
      sink: { recordAcceptedUserActivity: async () => RESULT },
      equality: createProductionStructuralEquality(),
      purpose: 'cycling_assistant',
    }),
    /ACCEPTED_ACTIVITY_OPTIONS_INVALID/u,
  );
  const nonProduction = harness('non-production');
  assert.throws(() => nonProduction.bridge.bind(), /ACCEPTED_ACTIVITY_SOURCE_NON_PRODUCTION/u);
  assert.equal(nonProduction.source.counts().subscribeCalls, 0);
  const notReady = harness();
  notReady.source.setReady(false);
  assert.throws(() => notReady.bridge.bind(), /ACCEPTED_ACTIVITY_SOURCE_NOT_READY/u);
  assert.equal(notReady.source.counts().subscribeCalls, 0);
});

test('close is idempotent, unsubscribes once, closes source once and fences late work', async () => {
  const h = harness();
  h.bridge.bind();
  await Promise.all([h.bridge.close(), h.bridge.close()]);
  assert.deepEqual(h.source.counts(), { subscribeCalls: 1, unsubscribeCalls: 1, closeCalls: 1 });
  assert.deepEqual(h.bridge.readiness(), {
    owner: 'T04.accepted-user-activity', environment: 'production', ready: false, reason: 'closed',
  });
  assert.throws(() => h.bridge.bind(), /ACCEPTED_ACTIVITY_BRIDGE_CLOSED/u);
});

test('settled activities return to the durable ledger with the complete owner event, including after bridge restart', async () => {
  const ledger = new Map<string, { fingerprint: string; result: RealtimeSessionRecord }>();
  let attempts = 0;
  const sink = {
    async recordAcceptedUserActivity(activity: AcceptedUserActivity, ownerEvent?: unknown) {
      attempts += 1;
      assert.ok(ownerEvent, 'complete owner evidence reaches durable idempotency authority');
      const fingerprint = JSON.stringify({ activity, ownerEvent });
      const prior = ledger.get(activity.activityId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
        return prior.result;
      }
      ledger.set(activity.activityId, { fingerprint, result: RESULT });
      return RESULT;
    },
  };
  const make = () => {
    const source = sourceFixture();
    const bridge = createRealtimeAcceptedUserActivityProduction({
      source: source.source, sink, equality: createProductionStructuralEquality(),
      purpose: 'cycling_assistant', now: () => NOW,
    });
    bridge.bind();
    return { source, bridge };
  };
  const event = eventFor('durable-replay');
  const first = make();
  assert.equal(await first.source.emit(event), RESULT);
  assert.equal(await first.source.emit(structuredClone(event)), RESULT);
  assert.equal(attempts, 2, 'settled results are not cached by the long-lived bridge');
  const conflict = mutableEvent('durable-replay', 'cycling_pause');
  await assert.rejects(first.source.emit(conflict as unknown as RealtimeAcceptedUserActivityOwnerEvent), /IDEMPOTENCY_CONFLICT/);
  await first.bridge.close();
  const restarted = make();
  assert.equal(await restarted.source.emit(structuredClone(event)), RESULT);
  await assert.rejects(restarted.source.emit(conflict as unknown as RealtimeAcceptedUserActivityOwnerEvent), /IDEMPOTENCY_CONFLICT/);
  assert.equal(ledger.size, 1);
  await restarted.bridge.close();
});
