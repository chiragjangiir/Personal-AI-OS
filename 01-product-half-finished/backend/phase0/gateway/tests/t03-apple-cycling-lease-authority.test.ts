import { qualifiedT03AuthorityFixture } from './qualified-t03-authority-fixture.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,
  T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
  T03_APPLE_CYCLING_PURPOSE,
  createT03AppleCyclingLeaseAuthority,
} from '../src/t03-apple-cycling-lease-authority.ts';
import { T03GovernanceDeviceCredentialRuntime } from '../src/t03-governance-device-credential-runtime.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';

const NOW_TEXT = '2030-01-01T00:10:00.000Z';
const NOW = Date.parse(NOW_TEXT);
const ISSUED = '2030-01-01T00:00:00.000Z';
const LEASE_EXPIRES = '2030-01-02T00:00:00.000Z';
const EXPIRES = '2030-01-02T00:10:00.000Z';
const USER = '01952f00-0000-7000-8000-000000000501';
const DEVICE = '01952f00-0000-7000-8000-000000000502';
const GRANT = '01952f00-0000-7000-8000-000000000503';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const PRINCIPAL = Object.freeze({ kind: 'principal_ref', value: 'apple-cycling-owner' });
const CAPABILITY = Object.freeze({ kind: 'capability_ref', value: 'apple-cycling-public-control' });
const OPERATIONS = Object.freeze([
  'bootstrap',
  'realtime_e2ee_key_resolve',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
]);
const RECIPIENT_PUBLIC_KEY = Buffer.alloc(32, 5).toString('base64url');

type JsonRecord = Record<string, unknown>;

function ref(type: string, idSuffix: string, hash: string): JsonRecord {
  return {
    ref_type: type,
    ref_id: `01952f00-0000-7000-8000-000000000${idSuffix}`,
    object_version: '1',
    canonical_payload_sha256: hash,
  };
}

const GOVERNANCE = Object.freeze({
  purpose_scopes: Object.freeze([T03_APPLE_CYCLING_PURPOSE]),
  consent_record_refs: Object.freeze([ref('ConsentRecord', '504', HASH_A)]),
  policy_decision_refs: Object.freeze([ref('PolicyDecision', '505', HASH_B)]),
  purpose_token_refs: Object.freeze([ref('PurposeToken', '506', HASH_C)]),
  capability_grant_refs: Object.freeze([ref('CapabilityGrant', '507', HASH_D)]),
});

function wireRef(value: JsonRecord): string {
  return value.ref_id as string;
}

const WIRE_GOVERNANCE = Object.freeze({
  purpose_scopes: Object.freeze([T03_APPLE_CYCLING_PURPOSE]),
  consent_record_refs: Object.freeze([wireRef(GOVERNANCE.consent_record_refs[0]!)]),
  policy_decision_refs: Object.freeze([wireRef(GOVERNANCE.policy_decision_refs[0]!)]),
  purpose_token_refs: Object.freeze([wireRef(GOVERNANCE.purpose_token_refs[0]!)]),
  capability_grant_refs: Object.freeze([wireRef(GOVERNANCE.capability_grant_refs[0]!)]),
});

function record(overrides: JsonRecord = {}): JsonRecord {
  return qualifiedT03AuthorityFixture({
    schema: T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
    grant_id: GRANT,
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
    allowed_media_capabilities: ['audio', 'video', 'data'],
    governance: GOVERNANCE,
    revocable: true,
    ...overrides,
  });
}

function recipientCredential(overrides: JsonRecord = {}): JsonRecord {
  return {
    device_credential_ref: ref('DeviceCredential', '510', 'e'.repeat(64)),
    algorithm: 'X25519',
    purpose: 'hpke_recipient',
    public_key: RECIPIENT_PUBLIC_KEY,
    public_key_sha256: createHash('sha256').update(Buffer.from(RECIPIENT_PUBLIC_KEY, 'base64url')).digest('hex'),
    audience: { alias_type: 'participant', issuer: 'livekit_cloud', value: 'participant-1' },
    device_id: DEVICE,
    realtime_session_ref: ref('RealtimeSession', '511', '1'.repeat(64)),
    device_lease_ref: ref('DeviceLease', '512', '2'.repeat(64)),
    continuity_id: '01952f00-0000-7000-8000-000000000513',
    expires_at: LEASE_EXPIRES,
    revocation: { status: 'active' },
    supersession: null,
    deletion: null,
    ...overrides,
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function bytes(value: JsonRecord): Uint8Array {
  return Buffer.from(`${canonical(value)}\n`, 'utf8');
}

function sha(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(value: JsonRecord = record(), options: { protected?: boolean; now?: number } = {}) {
  let current = bytes(value);
  let protectedValue = options.protected ?? true;
  const ownerChecks: string[] = [];
  const authority = createT03AppleCyclingLeaseAuthority({
    record: {
      path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,
      read: () => Buffer.from(current),
    },
    ownerProtection: {
      assertOwnerProtected: (path) => {
        ownerChecks.push(path);
        if (!protectedValue) throw new Error('OWNER_PROTECTION_INVALID');
      },
    },
    expectedRecordSha256: sha(current),
    now: () => options.now ?? NOW,
  });
  return {
    authority,
    ownerChecks,
    rotate: (next: JsonRecord) => { current = bytes(next); },
    setProtected: (next: boolean) => { protectedValue = next; },
  };
}

function dynamicFixture(value: JsonRecord = record()) {
  let current = bytes(value);
  let expected = sha(current);
  let expectedReader: () => string = () => expected;
  let calls = 0;
  const authority = createT03AppleCyclingLeaseAuthority({
    record: {
      path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,
      read: () => Buffer.from(current),
    },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256Port: {
      current: () => {
        calls += 1;
        return expectedReader();
      },
    },
    now: () => NOW,
  });
  return {
    authority,
    rotate: (next: JsonRecord) => { current = bytes(next); },
    setExpected: (next: string) => { expected = next; expectedReader = () => expected; },
    setExpectedReader: (next: () => string) => { expectedReader = next; },
    calls: () => calls,
    hash: () => sha(current),
  };
}

function evaluate(authority: ReturnType<typeof fixture>['authority'], overrides: JsonRecord = {}) {
  return authority.policy.port.evaluate({
    userId: USER,
    deviceId: DEVICE,
    capabilities: ['data'],
    purpose: T03_APPLE_CYCLING_PURPOSE,
    occurredAt: assertCanonicalTimestamp(NOW_TEXT),
    governance: WIRE_GOVERNANCE,
    ...overrides,
  } as never);
}

function bootstrapRequest(overrides: JsonRecord = {}): JsonRecord {
  return {
    operation: 'bootstrap',
    bootstrap_mode: 'initial',
    device_id: DEVICE,
    start: {
      kind: 'explicit_user_start',
      device_id: DEVICE,
      modalities: ['audio', 'video', 'data'],
      started_at: NOW_TEXT,
    },
    requested_media: { audio: true, video: true, data: true },
    governance: WIRE_GOVERNANCE,
    ...overrides,
  };
}

function bearer(overrides: JsonRecord = {}): JsonRecord {
  return {
    principal: PRINCIPAL,
    deviceId: DEVICE,
    capabilityRef: CAPABILITY,
    scopes: OPERATIONS,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

test('owner-issued record supplies production LeasePolicyPort and exact T03 permit snapshot', async () => {
  const f = fixture();
  assert.equal(f.authority.policy.readiness.environment, 'production');
  assert.equal(f.authority.policy.readiness.owner, 'T03.apple-cycling-governance');
  assert.equal(f.authority.isReady(), true);
  assert.equal(f.authority.policy.readiness.isReady(), true);
  assert.deepEqual(await evaluate(f.authority), {
    allowed: true,
    policyDecisionRef: GOVERNANCE.policy_decision_refs[0],
    capabilities: ['data'],
    purpose: T03_APPLE_CYCLING_PURPOSE,
    leaseExpiresAt: LEASE_EXPIRES,
    revocable: true,
  });
  assert.deepEqual(await f.authority.authoritySnapshot.resolve({
    operation: 'bootstrap',
    request: bootstrapRequest(),
    bearer: bearer() as never,
    atSystemTime: NOW_TEXT,
  }), {
    status: 'available',
    decision: 'permit',
    principal: PRINCIPAL,
    device_id: DEVICE,
    capability_ref: CAPABILITY,
    scopes: OPERATIONS,
    expires_at: EXPIRES,
    purpose: T03_APPLE_CYCLING_PURPOSE,
    policy_decision_ref: GOVERNANCE.policy_decision_refs[0],
    governance: GOVERNANCE,
  });
  assert.ok(f.ownerChecks.length >= 3);
  assert.ok(f.ownerChecks.every((path) => path === T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH));
});

test('current authority projection is secret-free, complete and deeply frozen', () => {
  const f = fixture();
  const projection = f.authority.readCurrentAuthority();
  assert.deepEqual(projection, {
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    leaseExpiresAt: LEASE_EXPIRES,
    userId: USER,
    deviceId: DEVICE,
    principal: PRINCIPAL,
    capabilityRef: CAPABILITY,
    operations: OPERATIONS,
    allowedMediaCapabilities: ['audio', 'video', 'data'],
    purpose: T03_APPLE_CYCLING_PURPOSE,
    governance: GOVERNANCE,
    policyDecisionRef: GOVERNANCE.policy_decision_refs[0],
  });
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.operations), true);
  assert.equal(Object.isFrozen(projection.allowedMediaCapabilities), true);
  assert.equal(Object.isFrozen(projection.governance), true);
  assert.equal(Object.hasOwn(projection, 'bytes'), false);
  assert.equal(Object.hasOwn(projection, 'path'), false);
});

test('optional owner-issued X25519 recipient credential is projected without private material', () => {
  const f = fixture(record({ recipient_device_credential: recipientCredential() }));
  const projection = f.authority.readCurrentAuthority(NOW_TEXT);
  assert.equal(projection.recipientCredential?.publicKey, RECIPIENT_PUBLIC_KEY);
  assert.equal(projection.recipientCredential?.deviceId, DEVICE);
  assert.equal(Object.hasOwn(projection.recipientCredential ?? {}, 'private_key'), false);
  assert.throws(
    () => fixture(record({ recipient_device_credential: recipientCredential({ private_key: 'forbidden' }) }))
      .authority.readCurrentAuthority(NOW_TEXT),
    /T03_APPLE_CYCLING_RECIPIENT_CREDENTIAL_INVALID|T03_APPLE_CYCLING_SECRET_FIELD_FORBIDDEN/u,
  );
});

test('existing production T03 runtime consumes the snapshot for an initial cycling bootstrap', async () => {
  const f = fixture();
  const runtime = new T03GovernanceDeviceCredentialRuntime({
    authority: f.authority.authoritySnapshot,
    now: () => NOW_TEXT,
  });
  const decision = await runtime.evaluate({
    operation: 'bootstrap',
    request: bootstrapRequest(),
    bearer: bearer() as never,
  });
  assert.deepEqual(decision, {
    accepted: true,
    refs: WIRE_GOVERNANCE,
  });
  assert.deepEqual(await f.authority.policy.port.evaluate({
    userId: USER,
    deviceId: DEVICE,
    capabilities: ['data'],
    purpose: T03_APPLE_CYCLING_PURPOSE,
    occurredAt: assertCanonicalTimestamp(NOW_TEXT),
    governance: decision.refs,
  }), {
    allowed: true,
    policyDecisionRef: GOVERNANCE.policy_decision_refs[0],
    capabilities: ['data'],
    purpose: T03_APPLE_CYCLING_PURPOSE,
    leaseExpiresAt: LEASE_EXPIRES,
    revocable: true,
  });
});

test('data is mandatory while audio/video remain explicit optional media capabilities', async () => {
  const f = fixture();
  assert.deepEqual((await evaluate(f.authority, { capabilities: ['audio', 'data'] })).capabilities, ['audio', 'data']);
  await assert.rejects(evaluate(f.authority, { capabilities: ['audio'] }), /REQUEST_CAPABILITY_INVALID/u);
  await assert.rejects(evaluate(f.authority, { capabilities: ['data', 'audio'] }), /REQUEST_CAPABILITY_INVALID/u);
  const dataOnly = fixture(record({ allowed_media_capabilities: ['data'] }));
  await assert.rejects(evaluate(dataOnly.authority, { capabilities: ['audio', 'data'] }), /REQUEST_CAPABILITY_DENIED/u);
  assert.deepEqual((await evaluate(dataOnly.authority)).capabilities, ['data']);
});

test('missing consent and malformed fixed business consent profile fail closed', async () => {
  const missing = record();
  delete missing.consent;
  assert.equal(fixture(missing).authority.isReady(), false);
  const wrongMetric = fixture(record({ consent: {
    watch_workout_metrics: ['heart_rate'],
    iphone_motion: ['speed', 'location'],
    navigation: 'user_toggle',
    audio_capture: 'explicit_wake_or_tap_only',
    video_capture: 'explicit_wake_or_tap_only',
    background_health: 'platform_authorized',
    background_location: 'platform_authorized',
  } }));
  assert.equal(wrongMetric.authority.isReady(), false);
  await assert.rejects(evaluate(wrongMetric.authority), /CONSENT_INVALID/u);
});

test('wrong purpose, server user/device, time, governance and capability refuse a lease', async () => {
  const f = fixture();
  await assert.rejects(evaluate(f.authority, { purpose: 'public_product_canary' }), /PURPOSE_MISMATCH/u);
  await assert.rejects(evaluate(f.authority, { userId: '01952f00-0000-7000-8000-000000000599' }), /USER_MISMATCH/u);
  await assert.rejects(evaluate(f.authority, { deviceId: '01952f00-0000-7000-8000-000000000598' }), /DEVICE_MISMATCH/u);
  await assert.rejects(evaluate(f.authority, { occurredAt: assertCanonicalTimestamp(EXPIRES) }), /REQUEST_TIME_INVALID/u);
  await assert.rejects(evaluate(f.authority, { governance: { ...WIRE_GOVERNANCE, purpose_scopes: ['other'] } }), /GOVERNANCE_MISMATCH/u);
  await assert.rejects(evaluate(f.authority, { governance: GOVERNANCE }), /GOVERNANCE_MISMATCH/u);
  await assert.rejects(evaluate(f.authority, { governance: {
    ...WIRE_GOVERNANCE,
    policy_decision_refs: ['01952f00-0000-7000-8000-000000000599'],
  } }), /GOVERNANCE_MISMATCH/u);
  await assert.rejects(evaluate(f.authority, { capabilities: ['audio', 'video'] }), /REQUEST_CAPABILITY_INVALID/u);
});

test('expired/future authority, missing protection, path/hash drift and rotation are fail closed', async () => {
  assert.equal(fixture(record(), { now: Date.parse(EXPIRES) }).authority.isReady(), false);
  assert.equal(fixture(record({ issued_at_utc: '2030-01-01T00:20:00.000Z' })).authority.isReady(), false);
  const protection = fixture();
  protection.setProtected(false);
  assert.equal(protection.authority.isReady(), false);
  await assert.rejects(evaluate(protection.authority), /OWNER_PROTECTION_INVALID/u);
  assert.throws(() => createT03AppleCyclingLeaseAuthority({
    record: { path: `${T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH}.other` as never, read: () => bytes(record()) },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256: sha(bytes(record())),
    now: () => NOW,
  }), /OPTIONS_INVALID/u);
  const rotated = fixture();
  rotated.rotate(record({ device_id: '01952f00-0000-7000-8000-000000000599' }));
  assert.equal(rotated.authority.isReady(), false);
  await assert.rejects(evaluate(rotated.authority), /HASH_MISMATCH/u);
  const hashMismatch = createT03AppleCyclingLeaseAuthority({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => bytes(record()) },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256: 'f'.repeat(64),
    now: () => NOW,
  });
  assert.equal(hashMismatch.policy.readiness.isReady(), false);
  assert.throws(() => createT03AppleCyclingLeaseAuthority({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => bytes(record()) },
    ownerProtection: { assertOwnerProtected() {} },
    now: () => NOW,
  } as never), /OPTIONS_INVALID/u);
  assert.throws(() => createT03AppleCyclingLeaseAuthority({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => bytes(record()) },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256Port: undefined,
    now: () => NOW,
  } as never), /OPTIONS_INVALID/u);
  assert.throws(() => createT03AppleCyclingLeaseAuthority({
    record: { path: T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, read: () => bytes(record()) },
    ownerProtection: { assertOwnerProtected() {} },
    expectedRecordSha256: sha(bytes(record())),
    expectedRecordSha256Port: { current: () => sha(bytes(record())) },
    now: () => NOW,
  } as never), /OPTIONS_INVALID/u);
});

test('dynamic expected hash supports atomic record rotation and fails closed across every hash window', () => {
  const nextPolicy = ref('PolicyDecision', '599', 'f'.repeat(64));
  const nextSession = ref('RealtimeSession', '600', '1'.repeat(64));
  const nextLease = ref('DeviceLease', '601', '2'.repeat(64));
  const next = record({
    device_id: '01952f00-0000-7000-8000-000000000599',
    governance: { ...GOVERNANCE, policy_decision_refs: [nextPolicy] },
    recipient_device_credential: recipientCredential({
      device_id: '01952f00-0000-7000-8000-000000000599',
      realtime_session_ref: nextSession,
      device_lease_ref: nextLease,
      continuity_id: '01952f00-0000-7000-8000-000000000602',
    }),
  });
  const initial = dynamicFixture();
  assert.equal(initial.authority.isReady(), true);

  const fileNewHashOld = dynamicFixture();
  fileNewHashOld.rotate(next);
  assert.equal(fileNewHashOld.authority.isReady(), false);
  assert.throws(() => fileNewHashOld.authority.readCurrentAuthority(), /HASH_MISMATCH/u);

  const hashNewFileOld = dynamicFixture();
  hashNewFileOld.setExpected(sha(bytes(next)));
  assert.equal(hashNewFileOld.authority.isReady(), false);
  assert.throws(() => hashNewFileOld.authority.readCurrentAuthority(), /HASH_MISMATCH/u);

  const rotated = dynamicFixture();
  rotated.rotate(next);
  rotated.setExpected(sha(bytes(next)));
  assert.equal(rotated.authority.isReady(), true);
  assert.equal(rotated.authority.policy.readiness.isReady(), true);
  const projection = rotated.authority.readCurrentAuthority(NOW_TEXT);
  assert.deepEqual(projection.policyDecisionRef, nextPolicy);
  assert.deepEqual(projection.recipientCredential?.realtimeSessionRef, nextSession);
  assert.deepEqual(projection.recipientCredential?.deviceLeaseRef, nextLease);

  const alternating = dynamicFixture();
  let alternatingCalls = 0;
  alternating.setExpectedReader(() => alternatingCalls++ % 2 === 0 ? alternating.hash() : 'e'.repeat(64));
  assert.throws(() => alternating.authority.readCurrentAuthority(), /AUTHORITY_DRIFT/u);

  const throwing = dynamicFixture();
  throwing.setExpectedReader(() => { throw new Error('OWNER_RAW_ERROR'); });
  assert.throws(() => throwing.authority.readCurrentAuthority(), /AUTHORITY_DRIFT/u);

  const invalid = dynamicFixture();
  invalid.setExpectedReader(() => 'invalid');
  assert.throws(() => invalid.authority.readCurrentAuthority(), /HASH_MISMATCH/u);

  const closed = dynamicFixture();
  closed.authority.close();
  assert.equal(closed.authority.isReady(), false);
  assert.equal(closed.calls(), 0);
  assert.throws(() => closed.authority.readCurrentAuthority(), /CLOSED/u);
});

test('authority snapshot denies wrong bearer, governance, non-explicit media and unscoped operation', async () => {
  const f = fixture();
  const resolve = (request: JsonRecord, bearerValue: JsonRecord = bearer(), operation = 'bootstrap') =>
    f.authority.authoritySnapshot.resolve({ operation: operation as never, request, bearer: bearerValue as never, atSystemTime: NOW_TEXT });
  assert.deepEqual(await resolve(bootstrapRequest(), bearer({ deviceId: '01952f00-0000-7000-8000-000000000599' })),
    { status: 'deny', decision: 'deny' });
  assert.deepEqual(await resolve(bootstrapRequest({ governance: { ...GOVERNANCE, purpose_scopes: ['other'] } })),
    { status: 'deny', decision: 'deny' });
  assert.deepEqual(await resolve(bootstrapRequest({ start: { kind: 'background', device_id: DEVICE, modalities: ['data'] } })),
    { status: 'deny', decision: 'deny' });
  const scoped = fixture(record({ operation_scopes: ['bootstrap'], scopes: ['bootstrap'] }));
  assert.deepEqual(await scoped.authority.authoritySnapshot.resolve({
    operation: 'media_stop', request: { governance: GOVERNANCE }, bearer: {
      principal: PRINCIPAL, deviceId: DEVICE, capabilityRef: CAPABILITY, scopes: ['bootstrap'],
    }, atSystemTime: NOW_TEXT,
  }), { status: 'deny', decision: 'deny' });
});

test('authority snapshot accepts wire governance and both bootstrap modes while rejecting object or ref drift', async () => {
  const f = fixture();
  const accepted = await f.authority.authoritySnapshot.resolve({
    operation: 'bootstrap',
    request: bootstrapRequest({
      bootstrap_mode: 'fully_disconnected',
      continuity_id: '01952f00-0000-7000-8000-000000000514',
      transport_aliases: ['transport-session', 'room', 'device'],
    }),
    bearer: bearer() as never,
    atSystemTime: NOW_TEXT,
  });
  assert.equal((accepted as JsonRecord).status, 'available');
  assert.deepEqual((accepted as JsonRecord).governance, GOVERNANCE);

  const resolve = (request: JsonRecord) => f.authority.authoritySnapshot.resolve({
    operation: 'bootstrap', request, bearer: bearer() as never, atSystemTime: NOW_TEXT,
  });
  assert.deepEqual(await resolve(bootstrapRequest({ governance: GOVERNANCE })), { status: 'deny', decision: 'deny' });
  assert.deepEqual(await resolve(bootstrapRequest({ governance: {
    ...WIRE_GOVERNANCE,
    policy_decision_refs: ['01952f00-0000-7000-8000-000000000599'],
  } })), { status: 'deny', decision: 'deny' });
  const missing: JsonRecord = { ...WIRE_GOVERNANCE };
  delete missing.policy_decision_refs;
  assert.deepEqual(await resolve(bootstrapRequest({ governance: missing })), { status: 'deny', decision: 'deny' });
  assert.deepEqual(await resolve(bootstrapRequest({ bootstrap_mode: 'unsupported' })), { status: 'deny', decision: 'deny' });

});

test('close fences readiness, policy and snapshot idempotently', async () => {
  const f = fixture();
  f.authority.close();
  f.authority.close();
  assert.equal(f.authority.isReady(), false);
  await assert.rejects(evaluate(f.authority), /CLOSED/u);
  await assert.rejects(f.authority.authoritySnapshot.resolve({
    operation: 'bootstrap', request: bootstrapRequest(), bearer: bearer() as never, atSystemTime: NOW_TEXT,
  }), /CLOSED/u);
});

test('source has no identity mint, ambient fallback, file write, PG or network implementation', async () => {
  const source = await readFile(new URL('../src/t03-apple-cycling-lease-authority.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /randomUUID|new\s+Map\s*\(|process\.env/u);
  assert.doesNotMatch(source, /writeFile|appendFile|openSync|createWriteStream|\bpg\b|postgres|fetch\s*\(|https?\.request/u);
  assert.doesNotMatch(source, /public_product_canary|rayneo/i);
});

test('formal Watch resolves primary authority from authenticated T03 principal rather than caller user assertions', async () => {
  const f = fixture();
  const resolved = await f.authority.formalWatchPrimaryAuthority.resolve(bearer());
  assert.deepEqual(resolved, { userId: USER, deviceId: DEVICE, principalRef: PRINCIPAL, expiresAt: EXPIRES, purpose: T03_APPLE_CYCLING_PURPOSE, policyDecisionRef: GOVERNANCE.policy_decision_refs[0], capabilities: ['audio', 'video', 'data'] });
  assert.notDeepEqual(resolved.principalRef, resolved.userId);
  for (const bad of [bearer({ principal: USER }), bearer({ deviceId: USER }), bearer({ scopes: ['media_stop'] }), bearer({ capabilityRef: 'invented' }), { userId: USER, deviceId: DEVICE, authenticated: true }]) {
    await assert.rejects(f.authority.formalWatchPrimaryAuthority.resolve(bad), /FORMAL_WATCH_AUTHORITY_DENIED/);
  }
  f.authority.close();
  await assert.rejects(f.authority.formalWatchPrimaryAuthority.resolve(bearer()), /CLOSED/);
});
