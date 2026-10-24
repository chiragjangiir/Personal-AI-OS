import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRayneoDemoLeasePolicyForOwner,
  createRayneoDemoOwnerLeasePolicy,
  createRayneoDemoOwnerProjectionResolver,
  createRayneoLocalOwnerPolicyStore,
  RAYNEO_LOCAL_OWNER_POLICY_PATH,
  type RayneoDemoLiveSessionOutput,
  type RayneoLocalOwnerPolicy,
} from '../src/rayneo-demo-owner-projection.ts';
import { Phase0SharedSessionOwner } from '../src/phase0-shared-session-owner.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';

const SESSION_ID = 'phase0_session_owner_projection';
const DEVICE_ID = 'rayneo_device_owner_projection';
const CLIENT_ID = 'rayneo_client_owner_projection';
const USER_ID = '01952f00-0000-7000-8000-000000000901';
const OPENED_AT = '2026-08-28T10:00:00.000Z';
const OBSERVED_AT = '2026-08-28T10:01:00.000Z';
const LATER_AT = '2026-08-28T10:02:00.000Z';
const EXPIRES_AT = '2026-08-28T11:00:00.000Z';
const CLEANUP_AT = '2026-08-28T11:00:05.000Z';
const LEASE_EXPIRES_AT = '2026-08-28T10:55:00.000Z';

const policy = Object.freeze({
  schema: 'paios.windows.local-owner.v1' as const,
  userId: USER_ID,
  purpose: 'public_product_canary' as const,
  policyDecisionRef: Object.freeze({ ref: 'owner-policy-decision-901' }),
  governance: Object.freeze({
    purpose_scopes: Object.freeze(['public_product_canary']),
    policy_decision_refs: Object.freeze([{ ref: 'owner-policy-decision-901' }]),
    capability_grant_refs: Object.freeze(['realtime.audio', 'realtime.visual']),
  }),
  requestedCapabilities: Object.freeze(['realtime.audio', 'realtime.visual']),
  revocable: true as const,
});

function filePort(initial?: Buffer) {
  let bytes = initial;
  let writes = 0;
  let aclChecks = 0;
  const port = Object.freeze({
    path: RAYNEO_LOCAL_OWNER_POLICY_PATH,
    exists: () => bytes !== undefined,
    read: () => {
      if (bytes === undefined) throw new Error('FILE_MISSING');
      return Buffer.from(bytes);
    },
    verifyProtectedAcl: () => { aclChecks += 1; },
    createNewFlushedProtected: (next: Buffer) => {
      if (bytes !== undefined) throw new Error('FILE_EXISTS');
      bytes = Buffer.from(next);
      writes += 1;
    },
  });
  return { port, read: () => bytes, writes: () => writes, aclChecks: () => aclChecks };
}

function liveOutput(overrides: Record<string, unknown> = {}): RayneoDemoLiveSessionOutput {
  return Object.freeze({
    sessionId: SESSION_ID,
    deviceId: DEVICE_ID,
    clientInstanceId: CLIENT_ID,
    openedAt: OPENED_AT,
    expiresAt: EXPIRES_AT,
    cleanupDeadlineAt: CLEANUP_AT,
    continuityExpiresAt: EXPIRES_AT,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    connectionId: 'livekit-connection-owner-projection',
    ownerConnectionEpoch: '0',
    activeDeviceLeaseVersion: '3',
    livekit: Object.freeze({
      provider: 'livekit-provider-owner-projection',
      sessionAlias: 'livekit-session-owner-projection',
      roomAlias: 'livekit-room-owner-projection',
      participantAlias: 'livekit-participant-owner-projection',
      tokenExpiresAt: '2026-08-28T10:30:00.000Z',
    }),
    ...overrides,
  }) as RayneoDemoLiveSessionOutput;
}

function lookup(observedAt = OBSERVED_AT) {
  return Object.freeze({
    sessionId: SESSION_ID,
    deviceId: DEVICE_ID,
    clientInstanceId: CLIENT_ID,
    observedAt,
  });
}

function ownerFixture() {
  const owner = new Phase0SharedSessionOwner();
  let eligible = true;
  let currentLive = liveOutput();
  let liveResolves = 0;
  const eligibleRecord = Object.freeze({
    sessionId: SESSION_ID,
    deviceId: DEVICE_ID,
    clientInstanceId: CLIENT_ID,
    connectionId: 'livekit-connection-owner-projection',
    connectionEpoch: 0,
    expiresAtMs: Date.parse(EXPIRES_AT),
    cleanupDeadlineAtMs: Date.parse(CLEANUP_AT),
    activeDeviceLeaseVersion: 3 as const,
  });
  const eligibleRayneoSessions = () => eligible ? Object.freeze([eligibleRecord]) : Object.freeze([]);
  (owner.sessions as unknown as { eligibleRayneoSessions: typeof eligibleRayneoSessions }).eligibleRayneoSessions = eligibleRayneoSessions;
  const liveSession = Object.freeze({
    owner: 'RayNeo-live-bootstrap-production',
    environment: 'production' as const,
    isReady: () => true,
    resolve: async () => { liveResolves += 1; return currentLive; },
  });
  const file = filePort();
  const store = createRayneoLocalOwnerPolicyStore(file.port, 'RayNeo-local-owner-production');
  store.createOnce(policy);
  const resolver = createRayneoDemoOwnerProjectionResolver({ owner, policy: store, liveSession });
  return {
    owner, store, resolver, file, liveSession,
    setEligible: (value: boolean) => { eligible = value; },
    setLive: (value: RayneoDemoLiveSessionOutput) => { currentLive = value; },
    liveResolves: () => liveResolves,
  };
}

test('protected local policy is canonical and create-once', () => {
  const file = filePort();
  const store = createRayneoLocalOwnerPolicyStore(file.port, 'RayNeo-local-owner-production');
  assert.equal(store.isReady(), false);
  assert.deepEqual(store.createOnce(policy), policy);
  assert.equal(file.writes(), 1);
  const firstBytes = file.read();
  assert.ok(firstBytes);
  assert.deepEqual(store.createOnce(policy), policy);
  assert.equal(file.writes(), 1);
  assert.equal(store.isReady(), true);
  assert.ok(file.aclChecks() >= 3);
  assert.throws(() => store.createOnce({ ...policy, userId: '01952f00-0000-7000-8000-000000000999' }),
    /RAYNEO_LOCAL_OWNER_POLICY_COLLISION/u);
});

test('owner projection gates eligibility first and returns exact stable T02 input', async () => {
  const fixture = ownerFixture();
  try {
    fixture.setEligible(false);
    assert.equal(await fixture.resolver.resolve(lookup()), undefined);
    assert.equal(fixture.liveResolves(), 0);

    fixture.setEligible(true);
    const result = await fixture.resolver.resolve(lookup());
    assert.deepEqual(result, {
      stable: {
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        clientInstanceId: CLIENT_ID,
        userId: USER_ID,
        purpose: 'public_product_canary',
        governance: {
          purpose_scopes: ['public_product_canary'],
          policy_decision_refs: [{ ref: 'owner-policy-decision-901' }],
          capability_grant_refs: ['realtime.audio', 'realtime.visual'],
        },
        requestedCapabilities: ['realtime.audio', 'realtime.visual'],
        eligibilityObservedAt: OPENED_AT,
        sessionExpiresAt: EXPIRES_AT,
        cleanupDeadlineAt: CLEANUP_AT,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        connectionId: 'livekit-connection-owner-projection',
        ownerConnectionEpoch: '0',
        activeDeviceLeaseVersion: '3',
        providerAlias: 'livekit-provider-owner-projection',
        livekitSessionAlias: 'livekit-session-owner-projection',
        livekitRoomAlias: 'livekit-room-owner-projection',
        livekitParticipantAlias: 'livekit-participant-owner-projection',
      },
      resolution: { observedAt: OBSERVED_AT },
    });
    const replay = await fixture.resolver.resolve(lookup(LATER_AT));
    assert.deepEqual(replay?.stable, result?.stable);
    assert.equal(replay?.resolution.observedAt, LATER_AT);
  } finally {
    await fixture.owner.close();
  }
});

test('owner-scoped lease policy returns exact decision and re-reads policy', async () => {
  const fixture = ownerFixture();
  try {
    const ownerProjection = await fixture.resolver.resolve(lookup());
    assert.ok(ownerProjection);
    const leasePolicy = createRayneoDemoOwnerLeasePolicy({
      policy: fixture.store,
      verifiedOwner: ownerProjection,
    });
    const decision = await leasePolicy.evaluate({
      userId: USER_ID,
      deviceId: '01952f00-0000-7000-8000-000000000902',
      capabilities: ['realtime.audio', 'realtime.visual'],
      purpose: 'public_product_canary',
      occurredAt: assertCanonicalTimestamp(OPENED_AT),
      governance: policy.governance,
    });
    assert.deepEqual(decision, {
      allowed: true,
      policyDecisionRef: { ref: 'owner-policy-decision-901' },
      capabilities: ['realtime.audio', 'realtime.visual'],
      purpose: 'public_product_canary',
      leaseExpiresAt: LEASE_EXPIRES_AT,
      revocable: true,
    });
    const callback = createRayneoDemoLeasePolicyForOwner(fixture.store);
    const [first, second] = await Promise.all([
      callback(ownerProjection).evaluate({
        userId: USER_ID,
        deviceId: '01952f00-0000-7000-8000-000000000902',
        capabilities: ['realtime.audio', 'realtime.visual'],
        purpose: 'public_product_canary',
        occurredAt: assertCanonicalTimestamp(OPENED_AT),
        governance: policy.governance,
      }),
      callback(ownerProjection).evaluate({
        userId: USER_ID,
        deviceId: '01952f00-0000-7000-8000-000000000999',
        capabilities: ['realtime.audio', 'realtime.visual'],
        purpose: 'public_product_canary',
        occurredAt: assertCanonicalTimestamp(OPENED_AT),
        governance: policy.governance,
      }),
    ]);
    assert.deepEqual(first, second);
    await assert.rejects(leasePolicy.evaluate({
      userId: USER_ID,
      deviceId: '01952f00-0000-7000-8000-000000000902',
      capabilities: ['realtime.audio'],
      purpose: 'public_product_canary',
      occurredAt: assertCanonicalTimestamp(OPENED_AT),
      governance: policy.governance,
    }), /RAYNEO_DEMO_OWNER_LEASE_POLICY_INPUT_DRIFT/u);
  } finally {
    await fixture.owner.close();
  }
});

test('owner projection rejects missing authority and stable live drift without alias fallback', async () => {
  const fixture = ownerFixture();
  try {
    await fixture.resolver.resolve(lookup());
    fixture.setLive(liveOutput({ livekit: Object.freeze({
      provider: 'livekit-provider-owner-projection',
      sessionAlias: 'livekit-session-owner-projection',
      roomAlias: 'different-room',
      participantAlias: 'livekit-participant-owner-projection',
      tokenExpiresAt: '2026-08-28T10:30:00.000Z',
    }) }));
    await assert.rejects(fixture.resolver.resolve(lookup(LATER_AT)), /RAYNEO_DEMO_OWNER_PROJECTION_DRIFT|RAYNEO_DEMO_OWNER_CONNECTION_DRIFT/u);

    const missingOwnerEpoch = { ...liveOutput() } as Record<string, unknown>;
    delete missingOwnerEpoch.ownerConnectionEpoch;
    fixture.setLive(missingOwnerEpoch as unknown as RayneoDemoLiveSessionOutput);
    await assert.rejects(fixture.resolver.resolve(lookup(LATER_AT)), /RAYNEO_DEMO_LIVE_OUTPUT_INVALID/u);
  } finally {
    await fixture.owner.close();
  }
});

test('owner source has no ambient identity or in-memory alias fallback', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/rayneo-demo-owner-projection.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /process\.env|new\s+Map\s*\(/u);
});
