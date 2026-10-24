import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedSessionOrchestrator } from '../src/shared-session-orchestrator.ts';

const START = Date.parse('2026-08-12T02:00:00.000Z');
const SESSION = 'phase0_session_aaaaaaaaaaaaaaaaaaaa';
const IPHONE = 'iphone_device_bbbbbbbbbbbbbbbbbbbb';
const WATCH = 'watch_device_cccccccccccccccccccc';
const RAYNEO = 'rayneo_device_dddddddddddddddddddd';

function fixture() {
  let now = START + 1_000;
  const orchestrator = new SharedSessionOrchestrator({
    sessionId: SESSION,
    startedAtMs: START,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
    devices: [
      { deviceId: IPHONE, deviceClass: 'iphone', connectionId: 'iphone_conn_aaaaaaaaaaaaaaaaaaaa' },
      { deviceId: WATCH, deviceClass: 'apple_watch', connectionId: 'watch_conn_bbbbbbbbbbbbbbbbbbbb' },
      { deviceId: RAYNEO, deviceClass: 'rayneo', connectionId: 'rayneo_conn_cccccccccccccccccccc' },
    ],
  }, () => now);
  return { orchestrator, setNow: (value: number) => { now = value; } };
}

test('24-hour duration is admitted only by an exact RayNeo standalone input', () => {
  const extended = {
    mode: 'rayneo_standalone' as const,
    rayneoStandaloneSessionDurationMs: 86_400_000,
    sessionId: 'phase0_session_standalone_24h',
    startedAtMs: START,
    expiresAtMs: START + 86_400_000,
    cleanupDeadlineAtMs: START + 86_400_000 + 5_000,
    devices: [{
      deviceId: RAYNEO,
      deviceClass: 'rayneo' as const,
      connectionId: 'connection_rayneo_standalone_24h',
    }],
  };
  const orchestrator = new SharedSessionOrchestrator(extended, () => START + 1_000);
  assert.equal(orchestrator.snapshot().expiresAtMs, START + 86_400_000);

  const { rayneoStandaloneSessionDurationMs: _duration, ...withoutDuration } = extended;
  assert.throws(() => new SharedSessionOrchestrator({
    ...withoutDuration,
    sessionId: 'phase0_session_missing_duration',
  }, () => START + 1_000), /SESSION_TTL_INVALID/u);
  assert.throws(() => new SharedSessionOrchestrator({
    ...extended,
    mode: 'shared_handoff',
    sessionId: 'phase0_session_wrong_duration_mode',
  }, () => START + 1_000), /SESSION_TTL_INVALID/u);
  for (const value of [86_400_001, 7_200_000, 86_400_000.5]) {
    assert.throws(() => new SharedSessionOrchestrator({
      ...extended,
      sessionId: `phase0_session_bad_duration_${String(value).replace('.', '_')}`,
      rayneoStandaloneSessionDurationMs: value,
    }, () => START + 1_000), /SESSION_TTL_INVALID/u);
  }
  assert.throws(() => new SharedSessionOrchestrator({
    ...extended,
    sessionId: 'phase0_session_duration_mismatch',
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
  }, () => START + 1_000), /SESSION_TTL_INVALID/u);
});

test('starts with one shared iPhone lease and enforces ordered CAS with exact retry', () => {
  const { orchestrator, setNow } = fixture();
  assert.deepEqual(orchestrator.snapshot(), {
    sessionId: SESSION,
    state: 'live',
    activeDeviceId: IPHONE,
    activeDeviceLeaseVersion: 1,
    suppressedDeviceIds: [],
    publicStopEffectCount: 0,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
    devices: [
      { deviceId: IPHONE, deviceClass: 'iphone', connectionId: 'iphone_conn_aaaaaaaaaaaaaaaaaaaa', connectionEpoch: 0, locallyTornDown: false },
      { deviceId: WATCH, deviceClass: 'apple_watch', connectionId: 'watch_conn_bbbbbbbbbbbbbbbbbbbb', connectionEpoch: 0, locallyTornDown: false },
      { deviceId: RAYNEO, deviceClass: 'rayneo', connectionId: 'rayneo_conn_cccccccccccccccccccc', connectionEpoch: 0, locallyTornDown: false },
    ],
  });

  const request = {
    requestId: 'handoff_request_11111111111111111111', sessionId: SESSION,
    fromDeviceId: IPHONE, toDeviceId: WATCH, expectedLeaseVersion: 1,
    occurredAt: new Date(START + 500).toISOString(),
  } as const;
  const first = orchestrator.handoff(request);
  assert.equal(first.activeDeviceId, WATCH);
  assert.equal(first.activeDeviceLeaseVersion, 2);
  assert.equal(first.oldDeviceOutputSuppressed, true);
  assert.equal(first.latencyMs, 500);
  assert.equal(orchestrator.deliveryDisposition(IPHONE, 1), 'ignored_stale_lease');
  assert.equal(orchestrator.deliveryDisposition(WATCH, 2), 'render');
  assert.deepEqual(orchestrator.handoff(request), { ...first, retry: true });
  assert.throws(() => orchestrator.handoff({ ...request, toDeviceId: RAYNEO }), /IDEMPOTENCY_CONFLICT/);

  setNow(START + 2_000);
  const second = orchestrator.handoff({
    requestId: 'handoff_request_22222222222222222222', sessionId: SESSION,
    fromDeviceId: WATCH, toDeviceId: RAYNEO, expectedLeaseVersion: 2,
    occurredAt: new Date(START + 1_600).toISOString(),
  });
  assert.equal(second.activeDeviceId, RAYNEO);
  assert.equal(second.activeDeviceLeaseVersion, 3);
  assert.deepEqual(orchestrator.snapshot().suppressedDeviceIds, [IPHONE, WATCH]);
  assert.equal(orchestrator.deliveryDisposition(WATCH, 2), 'ignored_stale_lease');
  assert.equal(orchestrator.deliveryDisposition(RAYNEO, 3), 'render');
});

test('rejects stale or out-of-order handoffs and preserves the current lease', () => {
  const { orchestrator } = fixture();
  assert.throws(() => orchestrator.handoff({
    requestId: 'handoff_request_33333333333333333333', sessionId: SESSION,
    fromDeviceId: IPHONE, toDeviceId: RAYNEO, expectedLeaseVersion: 1,
    occurredAt: new Date(START + 500).toISOString(),
  }), /HANDOFF_ORDER_INVALID/);
  assert.throws(() => orchestrator.handoff({
    requestId: 'handoff_request_44444444444444444444', sessionId: SESSION,
    fromDeviceId: WATCH, toDeviceId: RAYNEO, expectedLeaseVersion: 2,
    occurredAt: new Date(START + 500).toISOString(),
  }), /STALE_ACTIVE_DEVICE_LEASE/);
  assert.equal(orchestrator.snapshot().activeDeviceLeaseVersion, 1);
});

test('reconnects under the same session and fences connection identity reuse', () => {
  const { orchestrator } = fixture();
  assert.deepEqual(orchestrator.reconnect({
    sessionId: SESSION, deviceId: IPHONE,
    previousConnectionId: 'iphone_conn_aaaaaaaaaaaaaaaaaaaa',
    newConnectionId: 'iphone_conn_dddddddddddddddddddd', previousEpoch: 0,
  }), {
    deviceId: IPHONE, connectionId: 'iphone_conn_dddddddddddddddddddd', connectionEpoch: 1,
  });
  assert.throws(() => orchestrator.reconnect({
    sessionId: SESSION, deviceId: IPHONE,
    previousConnectionId: 'iphone_conn_dddddddddddddddddddd',
    newConnectionId: 'iphone_conn_aaaaaaaaaaaaaaaaaaaa', previousEpoch: 1,
  }), /RECONNECT_BINDING_INVALID/);
  assert.throws(() => orchestrator.reconnect({
    sessionId: 'phase0_session_eeeeeeeeeeeeeeeeeeee', deviceId: IPHONE,
    previousConnectionId: 'iphone_conn_dddddddddddddddddddd',
    newConnectionId: 'iphone_conn_ffffffffffffffffffff', previousEpoch: 1,
  }), /SESSION_NOT_FOUND/);
});

test('RayNeo at lease 3 creates one public Stop and other terminals only tear down locally', () => {
  const { orchestrator, setNow } = fixture();
  orchestrator.handoff({
    requestId: 'handoff_request_55555555555555555555', sessionId: SESSION,
    fromDeviceId: IPHONE, toDeviceId: WATCH, expectedLeaseVersion: 1,
    occurredAt: new Date(START + 500).toISOString(),
  });
  setNow(START + 2_000);
  orchestrator.handoff({
    requestId: 'handoff_request_66666666666666666666', sessionId: SESSION,
    fromDeviceId: WATCH, toDeviceId: RAYNEO, expectedLeaseVersion: 2,
    occurredAt: new Date(START + 1_500).toISOString(),
  });
  setNow(START + 3_000);
  assert.deepEqual(orchestrator.publicStop({
    requestId: 'phase0_stop_77777777777777777777', sessionId: SESSION,
    initiatingDeviceId: RAYNEO, expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop', occurredAt: new Date(START + 3_000).toISOString(),
  }), {
    status: 'stop_accepted', publicStopEffectCount: 1,
    cleanupDeadlineAt: new Date(START + 8_000).toISOString(),
  });
  assert.throws(() => orchestrator.publicStop({
    requestId: 'phase0_stop_88888888888888888888', sessionId: SESSION,
    initiatingDeviceId: RAYNEO, expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop', occurredAt: new Date(START + 3_100).toISOString(),
  }), /SESSION_TERMINAL/);
  orchestrator.localTeardown(IPHONE);
  orchestrator.localTeardown(WATCH);
  assert.throws(() => orchestrator.localTeardown(RAYNEO), /PUBLIC_STOP_INITIATOR_NOT_LOCAL_ONLY/);
  const snapshot = orchestrator.snapshot();
  assert.equal(snapshot.publicStopEffectCount, 1);
  assert.equal(snapshot.state, 'terminal');
  assert.deepEqual(snapshot.devices.map((device) => device.locallyTornDown), [true, true, false]);
});

test('public Stop allows a bounded future device timestamp while preserving all authority fences', () => {
  const createStandalone = (now: number) => new SharedSessionOrchestrator({
    mode: 'rayneo_standalone',
    sessionId: 'phase0_session_77777777777777777777',
    startedAtMs: START,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
    devices: [{
      deviceId: RAYNEO,
      deviceClass: 'rayneo',
      connectionId: 'rayneo_conn_clock_skew_01',
    }],
  }, () => now);
  const stopRequest = (occurredAt: number, initiatingDeviceId = RAYNEO) => ({
    requestId: `phase0_stop_${String(occurredAt).slice(-20).padStart(20, '0')}`,
    sessionId: 'phase0_session_77777777777777777777',
    initiatingDeviceId,
    expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop' as const,
    occurredAt: new Date(occurredAt).toISOString(),
  });

  const now = START + 1_000;
  const accepted = createStandalone(now);
  const acceptedResult = accepted.publicStop(stopRequest(now + 2_500));
  assert.equal(acceptedResult.publicStopEffectCount, 1);
  assert.throws(() => accepted.publicStop(stopRequest(now + 2_500)), /SESSION_TERMINAL/u);
  assert.equal(accepted.snapshot().publicStopEffectCount, 1);

  const beyondTolerance = createStandalone(now);
  assert.throws(() => beyondTolerance.publicStop(stopRequest(now + 5_001)), /STOP_AUTHORITY_INVALID/u);
  const beforeStart = createStandalone(now);
  assert.throws(() => beforeStart.publicStop(stopRequest(START - 1)), /STOP_AUTHORITY_INVALID/u);
  const atExpiry = createStandalone(now);
  assert.throws(() => atExpiry.publicStop(stopRequest(START + 3_600_000)), /STOP_AUTHORITY_INVALID/u);
  const wrongAuthority = createStandalone(now);
  assert.throws(() => wrongAuthority.publicStop(stopRequest(now + 2_500, IPHONE)), /STOP_AUTHORITY_INVALID/u);
});

test('owner TTL/error termination fences synchronously without claiming a public Stop effect', () => {
  const timeout = fixture();
  timeout.setNow(START + 3_600_000);
  assert.deepEqual(timeout.orchestrator.terminate('timeout'), {
    reason: 'timeout', cleanupDeadlineAt: new Date(START + 3_605_000).toISOString(),
  });
  assert.equal(timeout.orchestrator.snapshot().state, 'terminal');
  assert.equal(timeout.orchestrator.snapshot().publicStopEffectCount, 0);
  assert.throws(() => timeout.orchestrator.terminate('error'), /SESSION_TERMINAL/u);
});

test('paired RayNeo standalone starts at the existing RayNeo fencing lease without synthetic terminals', () => {
  const now = START + 1_000;
  const orchestrator = new SharedSessionOrchestrator({
    mode: 'rayneo_standalone',
    sessionId: 'phase0_session_99999999999999999999',
    startedAtMs: START,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
    devices: [{
      deviceId: RAYNEO,
      deviceClass: 'rayneo',
      connectionId: 'rayneo_conn_standalone_01',
    }],
  }, () => now);
  const live = orchestrator.snapshot();
  assert.equal(live.activeDeviceId, RAYNEO);
  assert.equal(live.activeDeviceLeaseVersion, 3);
  assert.deepEqual(live.devices.map((device) => device.deviceClass), ['rayneo']);
  assert.equal(orchestrator.deliveryDisposition(RAYNEO, 3), 'render');
  assert.throws(() => orchestrator.handoff({
    requestId: 'handoff_standalone_forbidden_01',
    sessionId: live.sessionId,
    fromDeviceId: RAYNEO,
    toDeviceId: RAYNEO,
    expectedLeaseVersion: 3,
    occurredAt: new Date(now).toISOString(),
  }), /HANDOFF_TARGET_INVALID/u);
  assert.equal(orchestrator.publicStop({
    requestId: 'phase0_stop_standalone_01',
    sessionId: live.sessionId,
    initiatingDeviceId: RAYNEO,
    expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop',
    occurredAt: new Date(now).toISOString(),
  }).publicStopEffectCount, 1);
  assert.throws(() => orchestrator.publicStop({
    requestId: 'phase0_stop_standalone_02',
    sessionId: live.sessionId,
    initiatingDeviceId: RAYNEO,
    expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop',
    occurredAt: new Date(now).toISOString(),
  }), /SESSION_TERMINAL/u);
});

test('standalone mode rejects mixed or missing RayNeo terminal sets', () => {
  const base = {
    mode: 'rayneo_standalone' as const,
    sessionId: 'phase0_session_88888888888888888888',
    startedAtMs: START,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
  };
  assert.throws(() => new SharedSessionOrchestrator({ ...base, devices: [] }), /TERMINAL_SET_INVALID/u);
  assert.throws(() => new SharedSessionOrchestrator({
    ...base,
    devices: [{ deviceId: IPHONE, deviceClass: 'iphone', connectionId: 'iphone_conn_standalone_01' }],
  }), /TERMINAL_SET_INVALID/u);
});
