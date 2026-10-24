import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Phase0SharedSessionOwner,
  type Phase0OwnerAuthenticatedIphone,
  type Phase0OwnerEvent,
} from '../src/phase0-shared-session-owner.ts';

const SESSION = 'phase0_session_aaaaaaaaaaaaaaaaaaaa';
const IPHONE = 'iphone_device_01';
const WATCH = 'watch_device_01';
const RAYNEO = 'rayneo_device_01';
const START = Date.parse('2026-08-12T01:00:00.000Z');
const EXPIRES = START + 3_600_000;
const CLEANUP = EXPIRES + 5_000;

function auth(): Phase0OwnerAuthenticatedIphone {
  return {
    sessionId: SESSION, deviceId: IPHONE, clientInstanceId: 'iphone_client_01',
    credentialId: 'iphone_credential_01', capabilitySha256: 'a'.repeat(64), sourceIpv4: '192.0.2.20',
  };
}

function envelope(input: Readonly<{
  type: string;
  eventId: string;
  idempotency: string;
  deviceId: string;
  deviceClass: 'iphone' | 'apple_watch';
  clientId: string;
  connectionId: string;
  payload: Record<string, unknown>;
}>): Phase0OwnerEvent {
  return {
    schema_version: 'phase0-demo/0.4', event_type: input.type,
    event_id: input.eventId, session_id: SESSION,
    trace_id: input.eventId.replace(/.$/u, 'f'), occurred_at: new Date(START).toISOString(),
    expires_at: new Date(CLEANUP).toISOString(),
    origin: {
      device_id: input.deviceId, device_class: input.deviceClass,
      client_instance_id: input.clientId,
      ...(input.deviceClass === 'apple_watch' ? {
        relay: { device_id: IPHONE, device_class: 'iphone' as const, transport: 'watch_connectivity' as const },
      } : {}),
    },
    connection: { id: input.connectionId, epoch: 0, state: 'connected' },
    sequence: { stream_id: `${input.deviceClass}_stream_01`, number: 1 },
    idempotency_key: input.idempotency, payload: input.payload,
  };
}

function started(): Phase0OwnerEvent {
  return envelope({
    type: 'paios.phase0.demo.session.started', eventId: '10000000-0000-4000-8000-000000000001',
    idempotency: 'owner_open_00000001', deviceId: IPHONE, deviceClass: 'iphone',
    clientId: 'iphone_client_01', connectionId: 'iphone_connection_01',
    payload: {
      active_device_id: IPHONE, active_device_lease_version: 1,
      session_expires_at: new Date(EXPIRES).toISOString(), cleanup_deadline_at: new Date(CLEANUP).toISOString(),
      credential_lease: {
        credential_id: 'iphone_credential_01', expires_at: new Date(EXPIRES).toISOString(),
        scopes: ['room_join', 'publish_audio'],
      },
    },
  });
}

function watchStatus(): Phase0OwnerEvent {
  return envelope({
    type: 'paios.phase0.demo.device.status', eventId: '10000000-0000-4000-8000-000000000002',
    idempotency: 'owner_watch_00000001', deviceId: WATCH, deviceClass: 'apple_watch',
    clientId: 'watch_client_01', connectionId: 'watch_connection_01',
    payload: {
      device_id: WATCH, status: 'online', transport: 'watch_connectivity', capabilities: ['workout'],
      observed_at: new Date(START).toISOString(),
    },
  });
}

function populate(owner: Phase0SharedSessionOwner): void {
  owner.openFromAuthenticatedIphoneSessionStarted(auth(), started());
  owner.registerWatchBeforeFirstRelayedEvent(auth(), watchStatus());
  owner.registerRayneoFromPairingV1Bootstrap({
    idempotencyKey: 'rayneo_bootstrap_aaaaaaaaaaaaaaaaaaaa', deviceId: RAYNEO,
    clientInstanceId: 'rayneo_client_01', keyId: 'b'.repeat(64), publicKeySpkiSha256: 'b'.repeat(64),
    sourceIpv4: '192.0.2.30',
  });
}

test('real owner enrolls iPhone, Watch and RayNeo once and drives exact shared lease CAS', () => {
  let now = START + 100;
  const owner = new Phase0SharedSessionOwner({ now: () => now });
  const revisions: number[] = [];
  owner.snapshotAndSubscribeLifecycle((transition) => revisions.push(transition.revision));
  const opened = owner.openFromAuthenticatedIphoneSessionStarted(auth(), started());
  assert.equal(opened.duplicate, false);
  assert.equal(owner.openFromAuthenticatedIphoneSessionStarted(auth(), started()).duplicate, true);
  assert.equal(owner.revision, 1);
  const watch = owner.registerWatchBeforeFirstRelayedEvent(auth(), watchStatus());
  assert.equal(watch.deviceClass, 'apple_watch');
  assert.equal(owner.registerWatchBeforeFirstRelayedEvent(auth(), watchStatus()).duplicate, true);
  assert.throws(() => owner.registerWatchBeforeFirstRelayedEvent(auth(), {
    ...structuredClone(watchStatus()), event_id: '10000000-0000-4000-8000-000000000097',
  }), /IDEMPOTENCY_CONFLICT/u);
  assert.throws(() => owner.registerWatchBeforeFirstRelayedEvent(auth(), {
    ...structuredClone(watchStatus()), idempotency_key: 'owner_watch_drift_00000001',
  }), /IDEMPOTENCY_CONFLICT/u);
  assert.throws(() => owner.registerWatchBeforeFirstRelayedEvent(auth(), {
    ...structuredClone(watchStatus()), trace_id: '10000000-0000-4000-8000-000000000099',
  }), /IDEMPOTENCY_CONFLICT/u);
  assert.equal(owner.revision, 2);
  assert.equal(owner.sessions.projectionSnapshot(SESSION)?.acceptedEventCount, 2);
  const joined = owner.registerRayneoFromPairingV1Bootstrap({
    idempotencyKey: 'rayneo_bootstrap_aaaaaaaaaaaaaaaaaaaa', deviceId: RAYNEO,
    clientInstanceId: 'rayneo_client_01', keyId: 'b'.repeat(64), publicKeySpkiSha256: 'b'.repeat(64),
    sourceIpv4: '192.0.2.30',
  });
  assert.match(joined.connectionId, /^phase0_rayneo_connection_[a-f0-9]{20}$/u);
  assert.equal(owner.sessions, owner.sessions);
  const first = owner.handoff(auth(), {
    requestId: 'handoff_owner_01', sessionId: SESSION, fromDeviceId: IPHONE, toDeviceId: WATCH,
    expectedLeaseVersion: 1, occurredAt: new Date(now).toISOString(),
  });
  assert.equal(first.activeDeviceLeaseVersion, 2);
  now += 1;
  const second = owner.handoff(auth(), {
    requestId: 'handoff_owner_02', sessionId: SESSION, fromDeviceId: WATCH, toDeviceId: RAYNEO,
    expectedLeaseVersion: 2, occurredAt: new Date(now).toISOString(),
  });
  assert.equal(second.activeDeviceLeaseVersion, 3);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
  assert.equal(owner.sessions.eligibleRayneoSessions(RAYNEO, 'rayneo_client_01').length, 1);
  assert.throws(() => owner.handoff(auth(), {
    requestId: 'handoff_forbidden_01', sessionId: SESSION, fromDeviceId: RAYNEO, toDeviceId: IPHONE,
    expectedLeaseVersion: 3, occurredAt: new Date(now).toISOString(),
  }), /CONTRACT_REJECTED/u);
  assert.throws(() => owner.handoff(auth(), {
    requestId: 'handoff_stale_01', sessionId: SESSION, fromDeviceId: WATCH, toDeviceId: IPHONE,
    expectedLeaseVersion: 2, occurredAt: new Date(now).toISOString(),
  }), /STALE_ACTIVE_DEVICE_LEASE/u);
  assert.equal(owner.revision, 5);
});

test('join is selection-only and zero or ambiguous owner state mutates no session', () => {
  const empty = new Phase0SharedSessionOwner({ now: () => START + 1 });
  const join = {
    idempotencyKey: 'rayneo_bootstrap_cccccccccccccccccccc', deviceId: RAYNEO,
    clientInstanceId: 'rayneo_client_01', keyId: 'c'.repeat(64), publicKeySpkiSha256: 'c'.repeat(64),
    sourceIpv4: '192.0.2.30',
  };
  assert.throws(() => empty.registerRayneoFromPairingV1Bootstrap(join), /SHARED_SESSION_JOIN_NOT_APPLICABLE/u);
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.sessions.activeSessionIds(), []);

  const ambiguous = new Phase0SharedSessionOwner({ now: () => START + 1 });
  for (const [index, sessionId] of ['phase0_session_11111111111111111111', 'phase0_session_22222222222222222222'].entries()) {
    const sessionAuth = { ...auth(), sessionId };
    const open = {
      ...structuredClone(started()), session_id: sessionId,
      event_id: `20000000-0000-4000-8000-00000000000${index + 1}`,
      trace_id: `20000000-0000-4000-8000-00000000001${index + 1}`,
      idempotency_key: `owner_ambiguous_open_${index + 1}`,
    };
    ambiguous.openFromAuthenticatedIphoneSessionStarted(sessionAuth, open);
    const watch = {
      ...structuredClone(watchStatus()), session_id: sessionId,
      event_id: `20000000-0000-4000-8000-00000000002${index + 1}`,
      trace_id: `20000000-0000-4000-8000-00000000003${index + 1}`,
      idempotency_key: `owner_ambiguous_watch_${index + 1}`,
    };
    ambiguous.registerWatchBeforeFirstRelayedEvent(sessionAuth, watch);
  }
  assert.throws(() => ambiguous.registerRayneoFromPairingV1Bootstrap(join), /ELIGIBLE_SHARED_SESSION_AMBIGUOUS/u);
  assert.equal(ambiguous.revision, 4);
});

test('paired RayNeo standalone open is exact-replay safe and owns one Stop cleanup', async () => {
  const now = START + 1;
  const owner = new Phase0SharedSessionOwner({ now: () => now });
  const join = {
    idempotencyKey: 'rayneo_standalone_open_01',
    deviceId: RAYNEO,
    clientInstanceId: 'rayneo_client_standalone_01',
    keyId: 'e'.repeat(64),
    publicKeySpkiSha256: 'e'.repeat(64),
    sourceIpv4: '0.0.0.0',
  };
  const first = owner.openRayneoStandaloneFromPairingV1Bootstrap(join);
  assert.equal(first.duplicate, false);
  assert.equal(first.deviceClass, 'rayneo');
  assert.equal(owner.openRayneoStandaloneFromPairingV1Bootstrap(join).duplicate, true);
  assert.deepEqual(owner.snapshotAndSubscribeLifecycle(() => undefined).snapshot.sessions[0]?.registeredDeviceClasses, ['rayneo']);
  const eligible = owner.sessions.eligibleRayneoSessions(RAYNEO, join.clientInstanceId);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]?.sessionId, first.sessionId);
  assert.equal(eligible[0]?.activeDeviceLeaseVersion, 3);
  assert.equal(eligible[0]?.expiresAtMs, now + 3_600_000);
  assert.throws(() => owner.openRayneoStandaloneFromPairingV1Bootstrap({
    ...join,
    clientInstanceId: 'rayneo_client_standalone_02',
  }), /IDEMPOTENCY_CONFLICT/u);
  assert.throws(() => owner.openRayneoStandaloneFromPairingV1Bootstrap({
    ...join,
    idempotencyKey: 'rayneo_standalone_bad_key_01',
    publicKeySpkiSha256: 'f'.repeat(64),
  }), /DEVICE_ORIGIN_MISMATCH/u);
  const stopped = await owner.sessions.publicStop(first.sessionId, {
    requestId: 'phase0_stop_standalone_owner_01',
    sessionId: first.sessionId,
    initiatingDeviceId: RAYNEO,
    expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop',
    occurredAt: new Date(now).toISOString(),
  });
  assert.equal(stopped.publicStopEffectCount, 1);
  assert.equal(owner.sessions.terminalTombstone(first.sessionId)?.cleanupCompleted, true);
  assert.throws(() => owner.sessions.publicStop(first.sessionId, {
    requestId: 'phase0_stop_standalone_owner_02',
    sessionId: first.sessionId,
    initiatingDeviceId: RAYNEO,
    expectedActiveDeviceLeaseVersion: 3,
    reason: 'user_stop',
    occurredAt: new Date(now).toISOString(),
  }), /SESSION_TERMINAL/u);
  await owner.close();
});

test('24-hour override is RayNeo-standalone-only and all other durations stay closed', async () => {
  const now = START + 1;
  assert.throws(() => new Phase0SharedSessionOwner({
    rayneoStandaloneSessionDurationMs: 3_600_001 as 3_600_000,
  }), /RAYNEO_STANDALONE_SESSION_DURATION_INVALID/u);
  assert.throws(() => new Phase0SharedSessionOwner({
    rayneoStandaloneSessionDurationMs: 86_400_001 as 86_400_000,
  }), /RAYNEO_STANDALONE_SESSION_DURATION_INVALID/u);

  const standalone = new Phase0SharedSessionOwner({
    now: () => now,
    rayneoStandaloneSessionDurationMs: 86_400_000,
  });
  const join = {
    idempotencyKey: 'rayneo_standalone_24h_01',
    deviceId: RAYNEO,
    clientInstanceId: 'rayneo_client_standalone_24h_01',
    keyId: 'f'.repeat(64),
    publicKeySpkiSha256: 'f'.repeat(64),
    sourceIpv4: '0.0.0.0',
  };
  const opened = standalone.openRayneoStandaloneFromPairingV1Bootstrap(join);
  const eligible = standalone.sessions.eligibleRayneoSessions(RAYNEO, join.clientInstanceId);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]?.sessionId, opened.sessionId);
  assert.equal(eligible[0]?.expiresAtMs, now + 86_400_000);
  assert.equal(eligible[0]?.cleanupDeadlineAtMs, now + 86_400_000 + 5_000);
  await standalone.close();

  const ordinary = new Phase0SharedSessionOwner({
    now: () => now,
    rayneoStandaloneSessionDurationMs: 86_400_000,
  });
  ordinary.openFromAuthenticatedIphoneSessionStarted(auth(), started());
  assert.equal(
    ordinary.snapshotAndSubscribeLifecycle(() => undefined).snapshot.sessions[0]?.expiresAtMs,
    EXPIRES,
  );
  await ordinary.close();

  const longExpires = START + 86_400_000;
  const longCleanup = longExpires + 5_000;
  const baseline = structuredClone(started());
  const payload = baseline.payload as Record<string, unknown>;
  const widened: Phase0OwnerEvent = {
    ...baseline,
    expires_at: new Date(longCleanup).toISOString(),
    payload: {
      ...payload,
      session_expires_at: new Date(longExpires).toISOString(),
      cleanup_deadline_at: new Date(longCleanup).toISOString(),
      credential_lease: {
        ...(payload.credential_lease as Record<string, unknown>),
        expires_at: new Date(longExpires).toISOString(),
      },
    },
  };
  const otherPath = new Phase0SharedSessionOwner({
    now: () => now,
    rayneoStandaloneSessionDurationMs: 86_400_000,
  });
  assert.throws(
    () => otherPath.openFromAuthenticatedIphoneSessionStarted(auth(), widened),
    /DEVICE_ORIGIN_MISMATCH/u,
  );
  await otherPath.close();
});

test('atomic snapshot subscription includes a forced boundary transition exactly once', () => {
  let forceBoundary = false;
  let owner!: Phase0SharedSessionOwner;
  owner = new Phase0SharedSessionOwner({
    now: () => START + 1,
    snapshotSubscribeBoundary: () => {
      if (!forceBoundary) return;
      forceBoundary = false;
      owner.registerWatchBeforeFirstRelayedEvent(auth(), watchStatus());
    },
  });
  owner.openFromAuthenticatedIphoneSessionStarted(auth(), started());
  const seen: number[] = [];
  forceBoundary = true;
  const attached = owner.snapshotAndSubscribeLifecycle((transition) => seen.push(transition.revision));
  assert.equal(attached.revision, 2);
  assert.deepEqual(attached.snapshot.sessions.map((item) => item.sessionId), [SESSION]);
  assert.deepEqual(attached.snapshot.sessions[0]?.registeredDeviceClasses, ['iphone', 'apple_watch']);
  assert.deepEqual(seen, []);
  owner.registerRayneoFromPairingV1Bootstrap({
    idempotencyKey: 'rayneo_bootstrap_boundary_01', deviceId: RAYNEO,
    clientInstanceId: 'rayneo_client_01', keyId: 'd'.repeat(64), publicKeySpkiSha256: 'd'.repeat(64),
    sourceIpv4: '192.0.2.30',
  });
  assert.deepEqual(seen, [3]);
  attached.unsubscribe();
});

test('Watch registration and first event admission roll back together on projector admission failure', () => {
  const owner = new Phase0SharedSessionOwner({ now: () => START + 1 });
  owner.openFromAuthenticatedIphoneSessionStarted(auth(), started());
  owner.sessions.acceptOwnerEvent({
    ...structuredClone(started()),
    event_id: watchStatus().event_id,
  });
  assert.throws(() => owner.registerWatchBeforeFirstRelayedEvent(auth(), watchStatus()), /PROJECTION_EVENT_ID_CONFLICT/u);
  assert.equal(owner.hasRegisteredTerminal(SESSION, 'apple_watch'), false);
  assert.deepEqual(owner.sessions.projectionSnapshot(SESSION)?.devices.map((device) => device.deviceClass), ['iphone']);
  assert.equal(owner.revision, 1);
  const retry = {
    ...structuredClone(watchStatus()),
    event_id: '10000000-0000-4000-8000-000000000098',
  };
  assert.equal(owner.registerWatchBeforeFirstRelayedEvent(auth(), retry).duplicate, false);
  assert.equal(owner.hasRegisteredTerminal(SESSION, 'apple_watch'), true);
  assert.equal(owner.revision, 2);
});

test('wall-clock expiry synchronously removes active ID and creates no public Stop effect', async () => {
  let now = START + 1;
  let timer: (() => void) | undefined;
  const owner = new Phase0SharedSessionOwner({
    now: () => now,
    setTimer: (callback) => { timer = callback; return { unref() {} } as unknown as NodeJS.Timeout; },
    clearTimer: () => undefined,
  });
  populate(owner);
  now = EXPIRES;
  assert.deepEqual(owner.sessions.activeSessionIds(), []);
  timer?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(owner.sessions.terminalTombstone(SESSION)?.publicStopEffectCount, 0);
  assert.equal(owner.sessions.isTerminal(SESSION), true);
});

test('reserved public terminal event is rejected before owner revision or reservation', () => {
  const owner = new Phase0SharedSessionOwner({ now: () => START + 1 });
  owner.openFromAuthenticatedIphoneSessionStarted(auth(), started());
  const forbidden = { ...started(), event_type: 'paios.phase0.demo.session.ended' } as Phase0OwnerEvent;
  assert.throws(() => owner.acceptEvent(auth(), forbidden), /CONTRACT_REJECTED/u);
  assert.equal(owner.revision, 1);
});

test('completed owner cleanup purges full replay indexes and retains only the controller tombstone', async () => {
  const owner = new Phase0SharedSessionOwner({ now: () => START + 1 });
  populate(owner);
  assert.equal(await owner.revokeRayneoPairing(RAYNEO, 'b'.repeat(64)), true);
  assert.deepEqual(owner.snapshotAndSubscribeLifecycle(() => undefined).snapshot.sessions, []);
  assert.equal(owner.sessions.isTerminal(SESSION), true);
  assert.deepEqual(owner.sessions.events(SESSION).map((event) => event.event_type), [
    'paios.phase0.demo.session.ended',
    'paios.phase0.demo.session.cleanup.completed',
  ]);

  const replacementSession = 'phase0_session_bbbbbbbbbbbbbbbbbbbb';
  const replacementAuth = { ...auth(), sessionId: replacementSession };
  const replacementStarted = {
    ...structuredClone(started()),
    session_id: replacementSession,
  };
  const reopened = owner.openFromAuthenticatedIphoneSessionStarted(replacementAuth, replacementStarted);
  assert.equal(reopened.duplicate, false);
  assert.equal(reopened.sessionId, replacementSession);
});
