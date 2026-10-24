import { qualifiedT03AuthorityFixture } from './qualified-t03-authority-fixture.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  OpaqueEqualityPort,
  RealtimeAuthorityRepository,
  RealtimeAuthorityTransaction,
  RealtimeClockPort,
  RealtimeIdentityPort,
  TransportDisconnectionPort,
} from '../../../services/realtime-core/src/ports.ts';
import { createProductionAuthorityFactory } from '../../../services/realtime-core/src/production-authority-factory.ts';
import type { ProductionPortRegistration } from '../../../services/realtime-core/src/production-owner-ports.ts';
import {
  assertCanonicalTimestamp,
  type RealtimeCurrentBindingProjection,
  type RealtimeTransportBinding,
} from '../../../services/realtime-core/src/types.ts';
import {
  T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,
  T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
  T03_APPLE_CYCLING_PURPOSE,
} from '../src/t03-apple-cycling-lease-authority.ts';
import {
  createT03AppleCyclingOwnerBundle,
} from '../src/t03-apple-cycling-owner-bundle.ts';

const NOW_TEXT = '2030-01-01T00:10:00.000Z';
const ISSUED = '2030-01-01T00:00:00.000Z';
const CONTINUITY_EXPIRES = '2030-01-01T00:30:00.000Z';
const LEASE_EXPIRES = '2030-01-02T00:00:00.000Z';
const EXPIRES = '2030-01-02T00:10:00.000Z';
const USER = '01952f00-0000-7000-8000-000000000501';
const DEVICE = '01952f00-0000-7000-8000-000000000502';
const SESSION = Object.freeze({ ref_type: 'RealtimeSession', ref_id: '01952f00-0000-7000-8000-000000000601', object_version: '1', canonical_payload_sha256: '1'.repeat(64) });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: '01952f00-0000-7000-8000-000000000602', object_version: '1', canonical_payload_sha256: '2'.repeat(64) });
const CREDENTIAL = Object.freeze({ ref_type: 'DeviceCredential', ref_id: '01952f00-0000-7000-8000-000000000608', object_version: '1', canonical_payload_sha256: 'e'.repeat(64) });
const RECIPIENT_PUBLIC_KEY = Buffer.alloc(32, 6).toString('base64url');
const PRINCIPAL = Object.freeze({ kind: 'principal_ref', value: 'apple-cycling-owner' });
const CAPABILITY = Object.freeze({ kind: 'capability_ref', value: 'apple-cycling-public-control' });
const POLICY = Object.freeze({ ref_type: 'PolicyDecision', ref_id: '01952f00-0000-7000-8000-000000000605', object_version: '1', canonical_payload_sha256: 'b'.repeat(64) });
const GOVERNANCE = Object.freeze({
  purpose_scopes: Object.freeze([T03_APPLE_CYCLING_PURPOSE]),
  consent_record_refs: Object.freeze([{ ref_type: 'ConsentRecord', ref_id: '01952f00-0000-7000-8000-000000000604', object_version: '1', canonical_payload_sha256: 'a'.repeat(64) }]),
  policy_decision_refs: Object.freeze([POLICY]),
  purpose_token_refs: Object.freeze([{ ref_type: 'PurposeToken', ref_id: '01952f00-0000-7000-8000-000000000606', object_version: '1', canonical_payload_sha256: 'c'.repeat(64) }]),
  capability_grant_refs: Object.freeze([{ ref_type: 'CapabilityGrant', ref_id: '01952f00-0000-7000-8000-000000000607', object_version: '1', canonical_payload_sha256: 'd'.repeat(64) }]),
});
const WIRE_GOVERNANCE = Object.freeze({
  purpose_scopes: Object.freeze([T03_APPLE_CYCLING_PURPOSE]),
  consent_record_refs: Object.freeze(['01952f00-0000-7000-8000-000000000604']),
  policy_decision_refs: Object.freeze(['01952f00-0000-7000-8000-000000000605']),
  purpose_token_refs: Object.freeze(['01952f00-0000-7000-8000-000000000606']),
  capability_grant_refs: Object.freeze(['01952f00-0000-7000-8000-000000000607']),
});
const OPERATIONS = Object.freeze([
  'bootstrap', 'realtime_e2ee_key_resolve', 'connected_credential_refresh',
  'media_stop', 'end_continuity', 'handoff',
]);
const MEDIA = Object.freeze(['audio', 'video', 'data']);

type JsonRecord = Record<string, unknown>;

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function refRecord(): JsonRecord {
  return qualifiedT03AuthorityFixture({
    schema: T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
    grant_id: '01952f00-0000-7000-8000-000000000503',
    issued_at_utc: ISSUED,
    expires_at_utc: EXPIRES,
    lease_expires_at_utc: LEASE_EXPIRES,
    user_id: USER,
    device_id: DEVICE,
    principal_ref: PRINCIPAL,
    capability_ref: CAPABILITY,
    scopes: OPERATIONS,
    operation_scopes: OPERATIONS,
    purpose: T03_APPLE_CYCLING_PURPOSE,
    allowed_media_capabilities: MEDIA,
    governance: GOVERNANCE,
    revocable: true,
  });
}

function recipientCredential(): JsonRecord {
  return {
    device_credential_ref: CREDENTIAL,
    algorithm: 'X25519', purpose: 'hpke_recipient', public_key: RECIPIENT_PUBLIC_KEY,
    public_key_sha256: createHash('sha256').update(Buffer.from(RECIPIENT_PUBLIC_KEY, 'base64url')).digest('hex'),
    audience: { alias_type: 'participant', issuer: 'livekit_cloud', value: 'participant-1' },
    device_id: DEVICE, realtime_session_ref: SESSION, device_lease_ref: LEASE,
    continuity_id: '01952f00-0000-7000-8000-000000000603', expires_at: CONTINUITY_EXPIRES,
    revocation: { status: 'active' }, supersession: null, deletion: null,
  };
}

function bytes(value: JsonRecord): Uint8Array {
  return Buffer.from(`${canonical(value)}\n`, 'utf8');
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function binding(overrides: JsonRecord = {}): RealtimeCurrentBindingProjection {
  const transport: RealtimeTransportBinding = {
    state: 'connected',
    realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE,
    continuityId: '01952f00-0000-7000-8000-000000000603',
    deviceId: DEVICE,
    connectionEpoch: '1' as never,
    provider: 'livekit-cloud',
    transportSessionAlias: 'transport-session-1',
    roomAlias: 'room-1',
    deviceAlias: 'device-1',
    connectionId: 'connection-1',
  };
  const current: RealtimeCurrentBindingProjection = {
    session: {
      realtimeSessionRef: SESSION,
      userId: USER,
      continuityId: transport.continuityId,
      state: 'active',
      continuityState: 'active',
      connectionEpoch: '1' as never,
      continuityExpiresAt: CONTINUITY_EXPIRES as never,
      lastAcceptedUserActivityAt: NOW_TEXT as never,
      activeDeviceId: DEVICE,
      activeDeviceLeaseRef: LEASE,
      binding: transport,
      revision: '1' as never,
    },
    lease: {
      deviceLeaseRef: LEASE,
      realtimeSessionRef: SESSION,
      continuityId: transport.continuityId,
      userId: USER,
      deviceId: DEVICE,
      state: 'active',
      capabilities: MEDIA,
      purpose: T03_APPLE_CYCLING_PURPOSE,
      issuedAt: ISSUED as never,
      expiresAt: LEASE_EXPIRES as never,
      revocable: true,
      leaseVersion: '1' as never,
      fencingToken: '1' as never,
      policyDecisionRef: POLICY,
    },
  };
  return {
    session: { ...current.session, ...(overrides.session as JsonRecord | undefined) },
    lease: { ...current.lease, ...(overrides.lease as JsonRecord | undefined) },
  } as RealtimeCurrentBindingProjection;
}

function registration<T extends object>(port: T, owner: string): ProductionPortRegistration<T> {
  return { port, readiness: { owner, environment: 'production', isReady: () => true } };
}

function productionFactory(read: () => RealtimeCurrentBindingProjection | undefined) {
  const repository: RealtimeAuthorityRepository = {
    async transaction<T>(_operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
      return work({
        async readCurrentBinding(lookup) {
          const current = read();
          if (current === undefined) return undefined;
          if (lookup.realtimeSessionRef !== undefined && !same(lookup.realtimeSessionRef, current.session.realtimeSessionRef)) return undefined;
          if (lookup.continuityId !== undefined && lookup.continuityId !== current.session.continuityId) return undefined;
          return current;
        },
      } as RealtimeAuthorityTransaction);
    },
  };
  const policy: LeasePolicyPort = { async evaluate() { throw new Error('TEST_POLICY_NOT_CALLED'); } };
  const activity: ActivityAcceptancePort = { async verify() { throw new Error('TEST_ACTIVITY_NOT_CALLED'); } };
  const transport: TransportDisconnectionPort = { async verify() { throw new Error('TEST_TRANSPORT_NOT_CALLED'); } };
  const identity: RealtimeIdentityPort = {
    createContinuityId: ({ requestId }) => `continuity-${requestId}`,
    assertRepositoryIssuedRef: () => undefined,
    createSessionRef: ({ requestId }) => `session-${requestId}`,
    createDeviceLeaseRef: ({ deviceId, requestId }) => `lease-${deviceId}-${requestId}`,
    createTransportAlias: ({ requestId }) => `alias-${requestId}`,
    createConnectionId: ({ requestId }) => `connection-${requestId}`,
  };
  const clock: RealtimeClockPort = { now: () => assertCanonicalTimestamp(NOW_TEXT) };
  const equality: OpaqueEqualityPort = { key: canonical, same };
  return createProductionAuthorityFactory({
    repository: registration(repository, 'T02'),
    policy: registration(policy, 'T03-test'),
    activityAcceptance: registration(activity, 'T04-test'),
    transportDisconnection: registration(transport, 'transport-test'),
    identity: registration(identity, 'T01-test'),
    clock: registration(clock, 'T11B-test'),
    equality: registration(equality, 'T11B-test'),
  });
}

function productionFactoryWithRealBundlePorts(
  bundle: ReturnType<typeof createT03AppleCyclingOwnerBundle>,
  read: () => RealtimeCurrentBindingProjection | undefined,
) {
  const repository: RealtimeAuthorityRepository = {
    async transaction<T>(_operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
      return work({
        async readCurrentBinding(lookup) {
          const current = read();
          if (current === undefined) return undefined;
          if (lookup.realtimeSessionRef !== undefined && !same(lookup.realtimeSessionRef, current.session.realtimeSessionRef)) return undefined;
          if (lookup.continuityId !== undefined && lookup.continuityId !== current.session.continuityId) return undefined;
          return current;
        },
      } as RealtimeAuthorityTransaction);
    },
  };
  const identity: RealtimeIdentityPort = {
    createContinuityId: ({ requestId }) => `continuity-${requestId}`,
    assertRepositoryIssuedRef: () => undefined,
    createSessionRef: ({ requestId }) => `session-${requestId}`,
    createDeviceLeaseRef: ({ deviceId, requestId }) => `lease-${deviceId}-${requestId}`,
    createTransportAlias: ({ requestId }) => `alias-${requestId}`,
    createConnectionId: ({ requestId }) => `connection-${requestId}`,
  };
  const clock: RealtimeClockPort = { now: () => assertCanonicalTimestamp(NOW_TEXT) };
  const equality: OpaqueEqualityPort = { key: canonical, same };
  return createProductionAuthorityFactory({
    repository: registration(repository, 'T02'),
    policy: bundle.policy,
    activityAcceptance: bundle.activityAcceptance,
    transportDisconnection: bundle.transportDisconnection,
    identity: registration(identity, 'T01-test'),
    clock: registration(clock, 'T11B-test'),
    equality: registration(equality, 'T11B-test'),
  });
}

function makeBundle(
  withRecipient = false,
  now: () => number = () => Date.parse(NOW_TEXT),
  expectedRecordSha256Port?: { readonly current: () => string },
) {
  let authorityBytes = bytes({
    ...refRecord(),
    ...(withRecipient ? { recipient_device_credential: recipientCredential() } : {}),
  });
  let current: RealtimeCurrentBindingProjection | undefined = binding();
  const bundle = createT03AppleCyclingOwnerBundle({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => Buffer.from(authorityBytes) },
    ownerProtection: { assertOwnerProtected() {} },
    ...(expectedRecordSha256Port === undefined
      ? { expectedRecordSha256: hash(authorityBytes) }
      : { expectedRecordSha256Port }),
    now,
  });
  const factory = productionFactory(() => current);
  return {
    bundle,
    factory,
    setCurrent: (next: RealtimeCurrentBindingProjection | undefined) => { current = next; },
    rotateAuthority: (next: JsonRecord) => { authorityBytes = bytes(next); },
  };
}

function bootstrapInput(startedAt: unknown = NOW_TEXT) {
  return {
    operation: 'bootstrap' as const,
    request: { device_id: 'request-device', start: { device_id: 'request-device', started_at: startedAt } },
    bearer: { principal: { request: 'principal' }, deviceId: 'request-device' },
    governance: { forged: true },
  };
}

function nonBootstrapInput() {
  return {
    operation: 'connected_credential_refresh' as const,
    request: {
      realtime_session_ref: SESSION,
      user_id: USER,
      device_id: DEVICE,
      purpose: T03_APPLE_CYCLING_PURPOSE,
      capabilities: MEDIA,
      governance: GOVERNANCE,
    },
    bearer: { principal: PRINCIPAL, deviceId: DEVICE, capabilityRef: CAPABILITY, scopes: OPERATIONS, expiresAt: EXPIRES },
    governance: GOVERNANCE,
  };
}

test('constructs unready, then becomes dynamically ready only after one real factory reader is bound', async () => {
  const f = makeBundle();
  assert.equal(f.bundle.readiness.isReady(), false);
  await assert.rejects(() => f.bundle.ownerContext.resolve(bootstrapInput()), /BUNDLE_NOT_READY/u);
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  assert.equal(f.bundle.readiness.isReady(), true);
  assert.deepEqual(await f.bundle.ownerContext.resolve(bootstrapInput()), {
    userId: USER,
    deviceId: DEVICE,
    purpose: T03_APPLE_CYCLING_PURPOSE,
    capabilities: MEDIA,
    occurredAt: NOW_TEXT,
  });
  assert.throws(() => f.bundle.bindCurrentBinding(f.factory.readCurrentBinding), /ALREADY_BOUND/u);
  await f.factory.close();
  await f.bundle.close();
});

test('bundle forwards the dynamic expected hash port and keeps the current binding bound across rotation', async () => {
  assert.throws(() => createT03AppleCyclingOwnerBundle({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => bytes(refRecord()) },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256Port: undefined,
    now: () => Date.parse(NOW_TEXT),
  } as never), /OPTIONS_INVALID/u);
  let expected = hash(bytes(refRecord()));
  let calls = 0;
  const expectedRecordSha256Port = {
    current: () => {
      calls += 1;
      return expected;
    },
  };
  const f = makeBundle(false, () => Date.parse(NOW_TEXT), expectedRecordSha256Port);
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  assert.equal(f.bundle.readiness.isReady(), true);
  assert.equal(f.bundle.readiness.current().bound, true);
  assert.ok(calls >= 4);

  const next = { ...refRecord(), grant_id: '01952f00-0000-7000-8000-000000000599' };
  f.rotateAuthority(next);
  assert.equal(f.bundle.readiness.isReady(), false);
  expected = hash(bytes(next));
  assert.equal(f.bundle.readiness.isReady(), true);
  assert.equal(f.bundle.readiness.current().bound, true);
  assert.throws(() => f.bundle.bindCurrentBinding(f.factory.readCurrentBinding), /ALREADY_BOUND/u);

  await f.bundle.close();
  const callsAfterClose = calls;
  assert.equal(f.bundle.readiness.isReady(), false);
  assert.equal(calls, callsAfterClose);
});

test('bootstrap owner context uses the issued start time and is stable across clock reads', async () => {
  let now = Date.parse(NOW_TEXT);
  const f = makeBundle(false, () => now);
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  const first = await f.bundle.ownerContext.resolve(bootstrapInput());
  now += 1_000;
  const second = await f.bundle.ownerContext.resolve(bootstrapInput());
  assert.equal(first.occurredAt, NOW_TEXT);
  assert.deepEqual(second, first);
  await f.bundle.close();
});

test('bootstrap owner context rejects missing, malformed, out-of-window, and future start times', async () => {
  const f = makeBundle();
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  const missing = bootstrapInput();
  delete (missing.request.start as JsonRecord).started_at;
  const invalid: readonly [string, unknown][] = [
    ['missing', missing],
    ['malformed', bootstrapInput('not-a-timestamp')],
    ['before-issued', bootstrapInput('2029-12-31T23:59:59.999Z')],
    ['at-lease-expiry', bootstrapInput(LEASE_EXPIRES)],
    ['future', bootstrapInput('2030-01-01T00:10:00.001Z')],
  ];
  for (const [label, input] of invalid) {
    await assert.rejects(() => f.bundle.ownerContext.resolve(input as ReturnType<typeof bootstrapInput>), /START_TIME_INVALID/u, label);
  }
  await f.bundle.close();
});

test('recipient credential readiness is independent and resolves only the bound T02 device credential', async () => {
  const f = makeBundle(true);
  assert.equal(f.bundle.readiness.isReady(), false);
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  assert.equal(f.bundle.readiness.isReady(), true);
  assert.equal(f.bundle.recipientCredential.readiness.isReady(), true);
  const resolved = await f.bundle.recipientCredential.port.resolve?.({
    request: {
      operation: 'realtime_e2ee_key_resolve', device_id: DEVICE,
      realtime_session_ref: SESSION, device_lease_ref: LEASE,
      continuity_id: '01952f00-0000-7000-8000-000000000603',
      participant_audience: { alias_type: 'participant', issuer: 'livekit_cloud', value: 'participant-1' },
      recipient_device_credential_ref: CREDENTIAL,
    },
    deviceId: DEVICE, credentialRef: CREDENTIAL,
  });
  assert.equal(Buffer.from(resolved!.publicKey as Uint8Array).toString('base64url'), RECIPIENT_PUBLIC_KEY);
  assert.equal(resolved?.deviceId, DEVICE);
  assert.equal(await f.bundle.recipientCredential.port.resolve?.({
    request: { device_id: 'other-device' }, deviceId: 'other-device', credentialRef: CREDENTIAL,
  }), undefined);
  await f.bundle.close();
});

test('real bundle owner registrations close the ProductionAuthorityFactory readiness cycle', async () => {
  const authorityBytes = bytes(refRecord());
  const bundle = createT03AppleCyclingOwnerBundle({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => Buffer.from(authorityBytes) },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256: hash(authorityBytes),
    now: () => Date.parse(NOW_TEXT),
  });
  let pgReads = 0;
  const factory = productionFactoryWithRealBundlePorts(bundle, () => {
    pgReads += 1;
    return binding();
  });

  assert.equal(bundle.readiness.current().ready, false);
  assert.equal(factory.readiness.current().ready, false);
  assert.throws(() => factory.assertReady(), /REALTIME_PRODUCTION_PORTS_NOT_READY/u);

  bundle.bindCurrentBinding(factory.readCurrentBinding);

  assert.equal(bundle.readiness.current().ready, true);
  assert.equal(factory.readiness.current().ready, true);
  factory.assertReady();
  assert.deepEqual(await bundle.ownerContext.resolve(nonBootstrapInput()), {
    userId: USER,
    deviceId: DEVICE,
    purpose: T03_APPLE_CYCLING_PURPOSE,
    capabilities: MEDIA,
    occurredAt: NOW_TEXT,
  });
  assert.equal(pgReads, 1);

  await factory.close();
  await bundle.close();
});

test('non-bootstrap owner context exact-checks PG identity, purpose, capability, policy, state and expiry', async () => {
  const f = makeBundle();
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  const input = nonBootstrapInput();
  await f.bundle.ownerContext.resolve(input);
  const mutations: readonly [string, (value: RealtimeCurrentBindingProjection) => RealtimeCurrentBindingProjection][] = [
    ['user', (value) => ({ ...value, session: { ...value.session, userId: '01952f00-0000-7000-8000-000000000599' } })],
    ['purpose', (value) => ({ ...value, lease: { ...value.lease, purpose: 'other' } })],
    ['capability', (value) => ({ ...value, lease: { ...value.lease, capabilities: ['data'] } })],
    ['policy', (value) => ({ ...value, lease: { ...value.lease, policyDecisionRef: { ...POLICY, canonical_payload_sha256: 'e'.repeat(64) } } })],
    ['state', (value) => ({ ...value, session: { ...value.session, state: 'terminal' as never } })],
    ['expiry', (value) => ({ ...value, lease: { ...value.lease, expiresAt: '2030-01-01T00:09:00.000Z' as never } })],
    ['linkage', (value) => ({ ...value, session: { ...value.session, activeDeviceLeaseRef: SESSION } })],
  ];
  for (const [, mutate] of mutations) {
    f.setCurrent(mutate(binding()));
    await assert.rejects(() => f.bundle.ownerContext.resolve(input));
  }
  await f.bundle.close();
});

test('non-bootstrap owner context keeps using the current server clock', async () => {
  let now = Date.parse(NOW_TEXT);
  const f = makeBundle(false, () => now);
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  const first = await f.bundle.ownerContext.resolve(nonBootstrapInput());
  now += 1_000;
  const second = await f.bundle.ownerContext.resolve(nonBootstrapInput());
  assert.equal(first.occurredAt, NOW_TEXT);
  assert.equal(second.occurredAt, '2030-01-01T00:10:01.000Z');
  assert.notEqual(second.occurredAt, first.occurredAt);
  await f.bundle.close();
});

test('activity acceptance uses no minted ref and returns the current policy ref as watermark', async () => {
  const f = makeBundle();
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  const accepted = await f.bundle.activityAcceptance.port.verify({
    activityId: 'activity-1',
    kind: 'accepted_user_activity',
    userId: USER,
    deviceId: DEVICE,
    realtimeSessionRef: SESSION,
    continuityId: binding().session.continuityId,
    occurredAt: NOW_TEXT as never,
    acceptanceRef: POLICY,
    accepted: true,
  });
  assert.deepEqual(accepted, { verified: true, acceptanceRef: POLICY, acceptedAt: NOW_TEXT, authorityWatermark: POLICY });
  await assert.rejects(() => f.bundle.activityAcceptance.port.verify({
    activityId: 'activity-forged', kind: 'accepted_user_activity', userId: USER, deviceId: DEVICE,
    realtimeSessionRef: SESSION, continuityId: binding().session.continuityId, occurredAt: NOW_TEXT as never,
    acceptanceRef: { ...POLICY, canonical_payload_sha256: 'f'.repeat(64) }, accepted: true,
  }), /ACCEPTANCE_MISMATCH/u);
  await f.bundle.close();
});

test('transport disconnection validates the connected binding but never fabricates a positive proof', async () => {
  const f = makeBundle();
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  await assert.rejects(() => f.bundle.transportDisconnection.port.verify({
    binding: binding().session.binding,
    userId: USER,
    deviceId: DEVICE,
    occurredAt: NOW_TEXT as never,
    governance: WIRE_GOVERNANCE,
  }), /PROOF_REQUIRED/u);
  await assert.rejects(() => f.bundle.transportDisconnection.port.verify({
    binding: binding().session.binding,
    userId: USER,
    deviceId: DEVICE,
    occurredAt: NOW_TEXT as never,
    governance: GOVERNANCE,
  }), /GOVERNANCE_MISMATCH/u);
  await assert.rejects(() => f.bundle.transportDisconnection.port.verify({
    binding: binding().session.binding,
    userId: USER,
    deviceId: DEVICE,
    occurredAt: NOW_TEXT as never,
    governance: {
      ...WIRE_GOVERNANCE,
      policy_decision_refs: ['01952f00-0000-7000-8000-000000000699'],
    },
  }), /GOVERNANCE_MISMATCH/u);
  await f.bundle.close();
});

test('missing PG binding, replayed close and late callbacks remain fail closed', async () => {
  const f = makeBundle();
  f.bundle.bindCurrentBinding(f.factory.readCurrentBinding);
  f.setCurrent(undefined);
  assert.equal(f.bundle.readiness.isReady(), true);
  await assert.rejects(() => f.bundle.ownerContext.resolve(nonBootstrapInput()), /PG_BINDING_MISSING/u);
  const first = f.bundle.close();
  const second = f.bundle.close();
  assert.strictEqual(first, second);
  await first;
  assert.equal(f.bundle.readiness.isReady(), false);
  await assert.rejects(() => f.bundle.governance.evaluate({ operation: 'bootstrap', request: {}, bearer: { principal: PRINCIPAL, deviceId: DEVICE } }), /BUNDLE_CLOSED/u);

  const late = makeBundle();
  let release!: (value: RealtimeCurrentBindingProjection) => void;
  const pending = new Promise<RealtimeCurrentBindingProjection>((resolve) => { release = resolve; });
  late.bundle.bindCurrentBinding(async () => pending);
  const resolving = late.bundle.ownerContext.resolve(nonBootstrapInput());
  const closing = late.bundle.close();
  release(binding());
  await closing;
  await assert.rejects(resolving, /BUNDLE_CLOSED/u);
});
