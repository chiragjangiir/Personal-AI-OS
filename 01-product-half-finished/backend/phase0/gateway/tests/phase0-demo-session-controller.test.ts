import assert from 'node:assert/strict';
import test from 'node:test';
import { Phase0DemoSessionController } from '../src/phase0-demo-session-controller.ts';
import type { AcceptedDemoEvent } from '../src/demo-state-projector.ts';

const START = Date.parse('2026-08-12T00:00:00.000Z');
const IPHONE = 'iphone_device_aaaaaaaaaaaaaaaaaaaa';
const WATCH = 'watch_device_bbbbbbbbbbbbbbbbbbbb';
const RAYNEO = 'rayneo_device_cccccccccccccccccccc';
const CLIENT = 'rayneo_client_dddddddddddddddddddd';

function admission(sessionId: string) {
  return {
    sessionId,
    startedAtMs: START,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
    readinessExpiresAtMs: START + 3_605_000,
    rayneoClientInstanceId: CLIENT,
    devices: [
      { deviceId: IPHONE, deviceClass: 'iphone' as const, connectionId: 'connection_iphone_aaaaaaaaaaaa' },
      { deviceId: WATCH, deviceClass: 'apple_watch' as const, connectionId: 'connection_watch_bbbbbbbbbbbbb' },
      { deviceId: RAYNEO, deviceClass: 'rayneo' as const, connectionId: 'connection_rayneo_cccccccccccc' },
    ],
  };
}

function moveToRayneo(controller: Phase0DemoSessionController, sessionId: string, now: number): void {
  controller.handoff({
    requestId: `handoff_watch_${sessionId.slice(-20)}`, sessionId,
    fromDeviceId: IPHONE, toDeviceId: WATCH, expectedLeaseVersion: 1,
    occurredAt: new Date(now).toISOString(),
  });
  controller.handoff({
    requestId: `handoff_rayneo_${sessionId.slice(-20)}`, sessionId,
    fromDeviceId: WATCH, toDeviceId: RAYNEO, expectedLeaseVersion: 2,
    occurredAt: new Date(now).toISOString(),
  });
}

test('owner-side admission exposes only unique existing lease-3 sessions and never refreshes TTL', () => {
  let now = START + 1_000;
  const controller = new Phase0DemoSessionController({ now: () => now });
  const first = 'phase0_session_11111111111111111111';
  const second = 'phase0_session_22222222222222222222';
  controller.admitExistingSession(admission(first));
  assert.deepEqual(controller.eligibleRayneoSessions(RAYNEO, CLIENT), []);
  moveToRayneo(controller, first, now);
  const selected = controller.eligibleRayneoSessions(RAYNEO, CLIENT);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.sessionId, first);
  assert.equal(selected[0]!.activeDeviceLeaseVersion, 3);
  assert.equal(selected[0]!.expiresAtMs, START + 3_600_000);

  controller.admitExistingSession(admission(second));
  moveToRayneo(controller, second, now);
  assert.equal(controller.eligibleRayneoSessions(RAYNEO, CLIENT).length, 2);
  now = START + 1_501_000;
  assert.equal(controller.eligibleRayneoSessions(RAYNEO, CLIENT).length, 0);
  assert.deepEqual(controller.activeSessionIds(), [first, second]);
});

test('owner-side standalone admission exposes one exact RayNeo binding with no handoff terminals', () => {
  const now = START + 1_000;
  const controller = new Phase0DemoSessionController({ now: () => now });
  const sessionId = 'phase0_session_standalone_01';
  controller.admitExistingSession({
    mode: 'rayneo_standalone',
    sessionId,
    startedAtMs: START,
    expiresAtMs: START + 3_600_000,
    cleanupDeadlineAtMs: START + 3_605_000,
    readinessExpiresAtMs: START + 3_605_000,
    rayneoClientInstanceId: CLIENT,
    devices: [{
      deviceId: RAYNEO,
      deviceClass: 'rayneo',
      connectionId: 'connection_rayneo_standalone_01',
    }],
  });
  const selected = controller.eligibleRayneoSessions(RAYNEO, CLIENT);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.sessionId, sessionId);
  assert.equal(selected[0]?.activeDeviceLeaseVersion, 3);
  assert.deepEqual(controller.orchestratorSnapshot(sessionId)?.devices.map((device) => device.deviceClass), ['rayneo']);
  assert.deepEqual(controller.eligibleRayneoSessions(RAYNEO, 'rayneo_client_wrong_01'), []);
});

test('existing-session admission carries 24 hours only for exact RayNeo standalone source', () => {
  const controller = new Phase0DemoSessionController({ now: () => START + 1_000 });
  const extended = {
    mode: 'rayneo_standalone' as const,
    rayneoStandaloneSessionDurationMs: 86_400_000,
    sessionId: 'phase0_session_controller_24h',
    startedAtMs: START,
    expiresAtMs: START + 86_400_000,
    cleanupDeadlineAtMs: START + 86_400_000 + 5_000,
    readinessExpiresAtMs: START + 86_400_000 + 5_000,
    rayneoClientInstanceId: CLIENT,
    devices: [{
      deviceId: RAYNEO,
      deviceClass: 'rayneo' as const,
      connectionId: 'connection_rayneo_controller_24h',
    }],
  };
  controller.admitExistingSession(extended);
  assert.equal(controller.eligibleRayneoSessions(RAYNEO, CLIENT)[0]?.expiresAtMs, START + 86_400_000);

  const invalid = new Phase0DemoSessionController({ now: () => START + 1_000 });
  const { rayneoStandaloneSessionDurationMs: _duration, ...withoutDuration } = extended;
  assert.throws(() => invalid.admitExistingSession({
    ...withoutDuration,
    sessionId: 'phase0_session_controller_missing',
  }), /SESSION_READINESS_INVALID/u);
  assert.throws(() => invalid.admitExistingSession({
    ...extended,
    mode: 'shared_handoff',
    sessionId: 'phase0_session_controller_wrong_mode',
  }), /SESSION_READINESS_INVALID/u);
  for (const value of [86_400_001, 7_200_000, 86_400_000.5]) {
    assert.throws(() => invalid.admitExistingSession({
      ...extended,
      sessionId: `phase0_session_controller_bad_${String(value).replace('.', '_')}`,
      rayneoStandaloneSessionDurationMs: value,
    }), /SESSION_READINESS_INVALID/u);
  }
});

test('Gateway emits ordered canonical telemetry then exactly one outer Stop and cleanup', async () => {
  let now = START + 1_000;
  let uuid = 0;
  let cleanupCount = 0;
  const cleanupOrder: string[] = [];
  const controller = new Phase0DemoSessionController({
    now: () => now,
    randomUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    cleanup: () => {
      cleanupCount += 1;
      cleanupOrder.push('outer');
      return { events: 2, media_objects: 1, session_rows: 1, model_cache_entries: 1 };
    },
  });
  const sessionId = 'phase0_session_33333333333333333333';
  controller.admitExistingSession(admission(sessionId));
  moveToRayneo(controller, sessionId, now);
  const streamed: string[] = [];
  controller.subscribe(sessionId, (event) => streamed.push(event.event_type));
  const telemetry = controller.emitTelemetry(sessionId, {
    idempotencyKey: 'rayneo_telemetry_aaaaaaaaaaaaaaaaaaaa',
    observedAt: new Date(now).toISOString(), batteryPercent: 81,
    temperatureCelsius: 37.25, frameRate: 0.5, cumulativeDroppedFrames: 2,
  });
  assert.equal(telemetry.event_type, 'paios.phase0.demo.device.telemetry');
  assert.deepEqual((telemetry.payload.metrics as unknown[]).map((metric) => (metric as { name: string }).name),
    ['battery', 'temperature', 'frame_rate', 'dropped_frames']);
  assert.equal(telemetry.origin.device_id, RAYNEO);
  assert.equal(telemetry.sequence.number, 1);

  now += 1_000;
  const stopped = await controller.publicStop(sessionId, {
    requestId: 'phase0_stop_bbbbbbbbbbbbbbbbbbbb', sessionId,
    initiatingDeviceId: RAYNEO, expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop', occurredAt: new Date(now).toISOString(),
  }, () => {
    cleanupOrder.push('low-rate');
    assert.equal(controller.orchestratorSnapshot(sessionId)?.state, 'terminal');
    assert.equal(controller.orchestratorSnapshot(sessionId)?.publicStopEffectCount, 1);
    return true;
  });
  assert.equal(stopped.publicStopEffectCount, 1);
  assert.equal(cleanupCount, 1);
  assert.deepEqual(cleanupOrder, ['low-rate', 'outer']);
  assert.deepEqual(streamed, [
    'paios.phase0.demo.device.telemetry',
    'paios.phase0.demo.session.ended',
    'paios.phase0.demo.session.cleanup.completed',
  ]);
  assert.equal(controller.orchestratorSnapshot(sessionId), undefined);
  assert.equal(controller.projectionSnapshot(sessionId), undefined);
  const tombstone = controller.terminalTombstone(sessionId)!;
  assert.equal(tombstone.publicStopEffectCount, 1);
  assert.equal(tombstone.cleanupCompleted, true);
  assert.deepEqual(tombstone.cleanupCounts, {
    events: 3, media_objects: 1, session_rows: 2, model_cache_entries: 1,
  });
  assert.deepEqual(controller.events(sessionId).map((event) => event.event_type), [
    'paios.phase0.demo.session.ended',
    'paios.phase0.demo.session.cleanup.completed',
  ]);
  assert.throws(() => controller.publicStop(sessionId, {
    requestId: 'phase0_stop_cccccccccccccccccccc', sessionId,
    initiatingDeviceId: RAYNEO, expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop', occurredAt: new Date(now).toISOString(),
  }), /SESSION_TERMINAL/);
});

test('cleanup failure clears live in-memory state and cannot emit cleanup.completed', async () => {
  const now = START + 1_000;
  const controller = new Phase0DemoSessionController({
    now: () => now,
    cleanup: () => { throw new Error('unknown'); },
  });
  const sessionId = 'phase0_session_44444444444444444444';
  controller.admitExistingSession(admission(sessionId));
  moveToRayneo(controller, sessionId, now);
  await assert.rejects(controller.publicStop(sessionId, {
    requestId: 'phase0_stop_dddddddddddddddddddd', sessionId,
    initiatingDeviceId: RAYNEO, expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop', occurredAt: new Date(now).toISOString(),
  }), /CLEANUP_UNCERTAIN/);
  assert.equal(controller.orchestratorSnapshot(sessionId), undefined);
  assert.equal(controller.projectionSnapshot(sessionId), undefined);
  assert.equal(controller.terminalTombstone(sessionId)?.cleanupCompleted, false);
  assert.deepEqual(controller.events(sessionId).map((event) => event.event_type), [
    'paios.phase0.demo.session.ended',
  ]);
});

test('owner pending IDs are wall-clock fenced and progressive enrollment materializes one controller record', () => {
  let now = START + 1;
  const controller = new Phase0DemoSessionController({ now: () => now });
  const sessionId = 'phase0_session_eeeeeeeeeeeeeeeeeeee';
  controller.beginOwnerSession({
    sessionId, startedAtMs: START, expiresAtMs: START + 3_600_000, cleanupDeadlineAtMs: START + 3_605_000,
    iphone: { deviceId: IPHONE, clientInstanceId: 'iphone_client_01', connectionId: 'iphone_connection_01', connectionEpoch: 0 },
  });
  assert.deepEqual(controller.activeSessionIds(), [sessionId]);
  assert.equal(controller.eligibleRayneoSessions(RAYNEO, CLIENT).length, 0);
  controller.registerOwnerTerminal(sessionId, {
    deviceId: WATCH, deviceClass: 'apple_watch', clientInstanceId: 'watch_client_01',
    connectionId: 'watch_connection_01', connectionEpoch: 0,
  });
  controller.registerOwnerTerminal(sessionId, {
    deviceId: RAYNEO, deviceClass: 'rayneo', clientInstanceId: CLIENT,
    connectionId: 'rayneo_connection_01', connectionEpoch: 0, readinessExpiresAtMs: START + 3_605_000,
  });
  assert.equal(controller.orchestratorSnapshot(sessionId)?.activeDeviceLeaseVersion, 1);
  now = START + 3_600_000;
  assert.deepEqual(controller.activeSessionIds(), []);
  assert.equal(controller.projectionSnapshot(sessionId), undefined);
});

test('reconnect authority remains unchanged when event admission fails at the atomic boundary', () => {
  const now = START + 1_000;
  let uuid = 0;
  const controller = new Phase0DemoSessionController({
    now: () => now,
    randomUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
  });
  const sessionId = 'phase0_session_ffffffffffffffffffff';
  controller.admitExistingSession(admission(sessionId));
  moveToRayneo(controller, sessionId, now);
  const telemetry = controller.emitTelemetry(sessionId, {
    idempotencyKey: 'telemetry_reconnect_collision_01', observedAt: new Date(now).toISOString(),
    batteryPercent: 80, temperatureCelsius: 36, frameRate: 0.5, cumulativeDroppedFrames: 0,
  });
  const event: AcceptedDemoEvent = {
    schema_version: 'phase0-demo/0.4',
    event_type: 'paios.phase0.demo.connection.reconnected',
    event_id: telemetry.event_id,
    session_id: sessionId,
    occurred_at: new Date(now).toISOString(),
    origin: { device_id: IPHONE, device_class: 'iphone' },
    payload: {},
  };
  const before = controller.orchestratorSnapshot(sessionId)!;
  const iphoneBefore = before.devices.find((device) => device.deviceId === IPHONE)!;
  assert.throws(() => controller.reconnectOwnerSessionAndAcceptEvent({
    sessionId, deviceId: IPHONE, previousConnectionId: iphoneBefore.connectionId,
    newConnectionId: 'connection_iphone_reconnected_01', previousEpoch: iphoneBefore.connectionEpoch,
  }, {
    ...event,
    payload: {
      previous_connection_id: iphoneBefore.connectionId,
      new_connection_id: 'connection_iphone_reconnected_01',
    },
  }), /PROJECTION_EVENT_ID_CONFLICT/u);
  const iphoneAfter = controller.orchestratorSnapshot(sessionId)!.devices.find((device) => device.deviceId === IPHONE)!;
  assert.deepEqual(iphoneAfter, iphoneBefore);
});

test('pending owner cleanup retains no accepted envelope index in its terminal tombstone', async () => {
  const controller = new Phase0DemoSessionController({
    now: () => START + 1,
    cleanup: () => { throw new Error('uncertain'); },
  });
  const sessionId = 'phase0_session_abababababababababab';
  controller.beginOwnerSessionWithEvent({
    sessionId, startedAtMs: START, expiresAtMs: START + 3_600_000, cleanupDeadlineAtMs: START + 3_605_000,
    iphone: { deviceId: IPHONE, clientInstanceId: 'iphone_client_01', connectionId: 'iphone_connection_01', connectionEpoch: 0 },
  }, {
    schema_version: 'phase0-demo/0.4', event_type: 'paios.phase0.demo.session.started',
    event_id: 'pending_owner_event_01', session_id: sessionId, occurred_at: new Date(START).toISOString(),
    origin: { device_id: IPHONE, device_class: 'iphone' }, payload: {},
  });
  assert.equal(await controller.terminateOwnerSession(sessionId, 'timeout'), false);
  assert.deepEqual(controller.terminalTombstone(sessionId)?.events, []);
  assert.equal(controller.projectionSnapshot(sessionId), undefined);
});
