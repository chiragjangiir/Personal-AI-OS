// Enrollment uses the same explicitly configured origin as the fictional product fixture.
process.env.PAIOS_PUBLIC_API_URL = 'https://ai.example.invalid';
import { pathToFileURL } from 'node:url';
import { qualifiedT03AuthorityFixture } from './qualified-t03-authority-fixture.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type { RealtimeCurrentBindingProjection, RealtimeTransportBinding } from '../../../services/realtime-core/src/types.ts';
import {
  APPLE_E2EE_REGISTRATION_MAX_AGE_MS,
  APPLE_PRODUCTION_ENROLLMENT_BUNDLE_SCHEMA,
  AppleProductionEnrollmentOwnerError,
  assertAppleEnrollmentOwnerProtectedPath,
  createAppleProductionSuccessorEnrollmentPort,
  createAppleProductionEnrollmentOwner,
  parseAppleProductionEnrollmentCliArgs,
  runAppleProductionEnrollmentCli,
  validateApplePublicRegistration,
  type AppleProductionEnrollmentOwnerIssuer,
  type AppleProductionEnrollmentOwnerOptions,
  type AppleProductionEnrollmentPrepared,
  type ApplePublicRegistrationFileReader,
} from '../src/apple-production-enrollment-owner.ts';
import { validateAppleProductionEnrollmentBundle } from '../src/apple-production-enrollment-bundle.ts';
import { createRealtimeSchemaRegistry } from '../src/realtime-public-control-controller.ts';
import {
  T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
  T03_APPLE_CYCLING_PURPOSE,
} from '../src/t03-apple-cycling-lease-authority.ts';

const NOW = '2030-01-01T00:10:00.000Z';
const ISSUED = '2030-01-01T00:00:00.000Z';
const LEASE_EXPIRES = '2030-01-01T04:00:00.000Z';
const CONTINUITY_EXPIRES = '2030-01-02T00:00:00.000Z';
const USER = '01952f00-0000-7000-8000-000000000501';
const DEVICE = '01952f00-0000-7000-8000-000000000502';
const TARGET = '01952f00-0000-7000-8000-000000000503';
const CONTINUITY = '01952f00-0000-7000-8000-000000000504';
const SESSION_ID = '01952f00-0000-7000-8000-000000000505';
const LEASE_ID = '01952f00-0000-7000-8000-000000000506';
const GRANT_ID = '01952f00-0000-7000-8000-000000000507';
const POLICY_ID = '01952f00-0000-7000-8000-000000000508';
const CONSENT_ID = '01952f00-0000-7000-8000-000000000509';
const TOKEN_ID = '01952f00-0000-7000-8000-000000000510';
const CAPABILITY_ID = '01952f00-0000-7000-8000-000000000511';
const CREDENTIAL_ID = '01952f00-0000-7000-8000-000000000512';

type JsonRecord = Record<string, unknown>;
type RegistrationOwnerOptions = Extract<
  AppleProductionEnrollmentOwnerOptions,
  Readonly<{ readonly registration: ApplePublicRegistrationFileReader }>
>;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ref(type: string, id: string, fill: string): JsonRecord {
  return { ref_type: type, ref_id: id, object_version: '1', canonical_payload_sha256: fill.repeat(64) };
}

const SESSION_REF = ref('RealtimeSession', SESSION_ID, '1');
const LEASE_REF = ref('DeviceLease', LEASE_ID, '2');
const POLICY_REF = ref('PolicyDecision', POLICY_ID, '3');
const GOVERNANCE = {
  purpose_scopes: [T03_APPLE_CYCLING_PURPOSE],
  consent_record_refs: [ref('ConsentRecord', CONSENT_ID, '4')],
  policy_decision_refs: [POLICY_REF],
  purpose_token_refs: [ref('PurposeToken', TOKEN_ID, '5')],
  capability_grant_refs: [ref('CapabilityGrant', CAPABILITY_ID, '6')],
};
const AUTHORITY = qualifiedT03AuthorityFixture({
  schema: T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
  grant_id: GRANT_ID,
  issued_at_utc: ISSUED,
  expires_at_utc: CONTINUITY_EXPIRES,
  lease_expires_at_utc: LEASE_EXPIRES,
  user_id: USER,
  device_id: DEVICE,
  principal_ref: USER,
  capability_ref: ref('CapabilityGrant', CAPABILITY_ID, '6'),
  scopes: ['bootstrap', 'realtime_e2ee_key_resolve', 'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff'],
  operation_scopes: ['bootstrap', 'realtime_e2ee_key_resolve', 'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff'],
  purpose: T03_APPLE_CYCLING_PURPOSE,
  allowed_media_capabilities: ['audio', 'video', 'data'],
  governance: GOVERNANCE,
  revocable: true,
});
const AUTHORITY_BYTES = Buffer.from(`${canonical(AUTHORITY)}\n`, 'utf8');
const PUBLIC_KEY = Buffer.alloc(32, 6);
const REGISTRATION = {
  schema: 'paios.realtime-e2ee-recipient-registration.v1',
  public_raw32_base64url: PUBLIC_KEY.toString('base64url'),
  public_sha256: hash(PUBLIC_KEY),
  local_slot_ref_hash: 'a'.repeat(64),
  created_at: NOW,
};

function currentBinding(): RealtimeCurrentBindingProjection {
  const binding: RealtimeTransportBinding = {
    state: 'connected',
    realtimeSessionRef: SESSION_REF,
    deviceLeaseRef: LEASE_REF,
    continuityId: CONTINUITY,
    deviceId: DEVICE,
    connectionEpoch: '1' as never,
    provider: { alias_type: 'provider', issuer: 'livekit_cloud', value: 'cloud-1' },
    transportSessionAlias: { alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'session-1' },
    roomAlias: { alias_type: 'room', issuer: 'livekit_cloud', value: 'room-1' },
    deviceAlias: { alias_type: 'participant', issuer: 'livekit_cloud', value: 'participant-1' },
    connectionId: 'connection-1',
  };
  return {
    session: {
      realtimeSessionRef: SESSION_REF,
      userId: USER,
      continuityId: CONTINUITY,
      state: 'active',
      continuityState: 'active',
      connectionEpoch: '1' as never,
      continuityExpiresAt: CONTINUITY_EXPIRES as never,
      lastAcceptedUserActivityAt: NOW as never,
      activeDeviceId: DEVICE,
      activeDeviceLeaseRef: LEASE_REF,
      binding,
      revision: '1' as never,
    },
    lease: {
      deviceLeaseRef: LEASE_REF,
      realtimeSessionRef: SESSION_REF,
      continuityId: CONTINUITY,
      userId: USER,
      deviceId: DEVICE,
      state: 'active',
      capabilities: ['audio', 'video', 'data'],
      purpose: T03_APPLE_CYCLING_PURPOSE,
      issuedAt: ISSUED as never,
      expiresAt: LEASE_EXPIRES as never,
      revocable: true,
      leaseVersion: '1' as never,
      fencingToken: '1' as never,
      policyDecisionRef: POLICY_REF,
    },
  };
}

function issuer(): AppleProductionEnrollmentOwnerIssuer {
  const ids = [CREDENTIAL_ID, ...Array.from({ length: 6 }, (_, index) => `01952f00-0000-7${String(index + 20).padStart(3, '0')}-8000-0000000005${20 + index}`)];
  return {
    issueUuidV7() {
      const id = ids.shift();
      if (id === undefined) throw new Error('ISSUER_EXHAUSTED');
      return id;
    },
    issueCanonicalObjectVersionRef(input) {
      return {
        ref_type: input.refType,
        ref_id: input.refId,
        object_version: input.objectVersion,
        canonical_payload_sha256: input.canonicalPayloadSha256,
      };
    },
  };
}

function fixtureOptions(
  root = mkdtempSync(join(tmpdir(), 'apple-enrollment-test-')),
  handoffDeviceId: string | null = TARGET,
): RegistrationOwnerOptions & { readonly root: string; readonly authorityUpdates: { count: number } } {
  const authorityPath = join(root, 'authority.json');
  const outputPath = join(root, 'bundle.json');
  writeFileSync(authorityPath, AUTHORITY_BYTES, { mode: 0o600 });
  let authorityHash = hash(AUTHORITY_BYTES);
  const authorityUpdates = { count: 0 };
  return {
    root,
    authorityUpdates,
    registration: {
      path: join(root, 'mac-registration.json'),
      read: () => Buffer.from(JSON.stringify(REGISTRATION), 'utf8'),
      assertOwnerProtected: () => undefined,
    },
    authorityPath,
    expectedAuthoritySha256: authorityHash,
    authorityHashPort: {
      current: () => authorityHash,
      updateAfterCommit: ({ previousSha256, nextSha256 }) => {
        assert.equal(authorityHash, previousSha256);
        authorityHash = nextSha256;
        authorityUpdates.count += 1;
      },
    },
    currentBinding: {
      snapshotIsolation: 'REPEATABLE READ',
      readOnly: true,
      readCurrentBindingSnapshot: async () => ({
        binding: currentBinding(),
        ...(handoffDeviceId === null ? {} : { handoffDeviceId }),
      }),
    },
    issuer: issuer(),
    clock: { now: () => NOW },
    outputPath,
    schemaRegistry: createRealtimeSchemaRegistry(),
  };
}

function reboundBinding(): RealtimeCurrentBindingProjection {
  const base = currentBinding();
  const sessionRef = ref('RealtimeSession', '01952f00-0000-7000-8000-000000000513', '7');
  const leaseRef = ref('DeviceLease', '01952f00-0000-7000-8000-000000000514', '8');
  const binding = {
    ...base.session.binding,
    realtimeSessionRef: sessionRef,
    deviceLeaseRef: leaseRef,
    connectionEpoch: '2' as never,
  };
  return {
    session: {
      ...base.session,
      realtimeSessionRef: sessionRef,
      activeDeviceLeaseRef: leaseRef,
      connectionEpoch: '2' as never,
      binding,
      revision: '2' as never,
    },
    lease: {
      ...base.lease,
      deviceLeaseRef: leaseRef,
      realtimeSessionRef: sessionRef,
      leaseVersion: '2' as never,
      fencingToken: '2' as never,
    },
  };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('validates public raw32, hashes, closed registration, and age', () => {
  const parsed = validateApplePublicRegistration(Buffer.from(JSON.stringify(REGISTRATION)), NOW);
  assert.equal(parsed.publicRaw32.byteLength, 32);
  assert.equal(parsed.publicSha256, REGISTRATION.public_sha256);
  assert.throws(
    () => validateApplePublicRegistration(Buffer.from(JSON.stringify({ ...REGISTRATION, private_key: 'x' })), NOW),
    (error: unknown) => error instanceof AppleProductionEnrollmentOwnerError && error.code === 'APPLE_ENROLLMENT_REGISTRATION_SCHEMA_INVALID',
  );
  const stale = new Date(Date.parse(NOW) - APPLE_E2EE_REGISTRATION_MAX_AGE_MS - 1).toISOString();
  assert.throws(() => validateApplePublicRegistration(Buffer.from(JSON.stringify({ ...REGISTRATION, created_at: stale })), NOW), /APPLE_ENROLLMENT_REGISTRATION_STALE/u);
});

test('prepare emits the exact closed Apple bundle and five Ajv-valid bodies with a Watch target, without writing', async () => {
  const options = fixtureOptions();
  try {
    const owner = createAppleProductionEnrollmentOwner(options);
    const prepared = await owner.prepare();
    assert.equal(existsSync(options.outputPath), false);
    assert.equal(prepared.bundleSha256, hash(prepared.bundleBytes));
    const bundle = JSON.parse(Buffer.from(prepared.bundleBytes).toString('utf8')) as JsonRecord;
    assert.deepEqual(Object.keys(bundle).sort(), ['binding', 'canonical_bodies', 'credential_ref', 'expires_at', 'origin', 'schema']);
    assert.equal(bundle.schema, APPLE_PRODUCTION_ENROLLMENT_BUNDLE_SCHEMA);
    assert.equal(Object.hasOwn(bundle, 'private_key'), false);
    assert.equal(Object.hasOwn(bundle, 'bearer'), false);
    assert.equal(Object.hasOwn(bundle, 'local_slot_ref_hash'), false);
    const bodies = bundle.canonical_bodies as JsonRecord;
    assert.deepEqual(Object.keys(bodies).sort(), ['bootstrap', 'connected_credential_refresh', 'end_continuity', 'media_stop', 'realtime_e2ee_key_resolve']);
    for (const [operation, entry] of Object.entries(bodies)) {
      const item = entry as JsonRecord;
      assert.deepEqual(Object.keys(item).sort(), ['body_base64', 'body_sha256', 'route']);
      const body = JSON.parse(Buffer.from(String(item.body_base64), 'base64').toString('utf8')) as JsonRecord;
      assert.equal(body.operation, operation);
      assert.equal(item.body_sha256, hash(Buffer.from(String(item.body_base64), 'base64')));
    }
    assert.deepEqual(validateAppleProductionEnrollmentBundle(prepared.bundleBytes), bundle);
    const retired = { ...bundle, canonical_bodies: { ...bodies, handoff: bodies.media_stop } };
    assert.throws(() => validateAppleProductionEnrollmentBundle(Buffer.from(JSON.stringify(retired))), /APPLE_ENROLLMENT_BUNDLE_BODIES_INVALID/);
    const credential = bundle.credential_ref as JsonRecord;
    assert.equal(credential.ref_type, 'DeviceCredential');
    assert.equal((bodies.realtime_e2ee_key_resolve as JsonRecord).route, '/v1/realtime/e2ee/key/resolve');
  } finally {
    cleanup(options.root);
  }
});

test('iPhone-only enrollment accepts zero handoff targets and commits five valid bodies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apple-enrollment-iphone-only-'));
  const options = fixtureOptions(root, null);
  try {
    const owner = createAppleProductionEnrollmentOwner(options);
    const prepared = await owner.prepare();
    const bundle = JSON.parse(Buffer.from(prepared.bundleBytes).toString('utf8')) as JsonRecord;
    const bodies = bundle.canonical_bodies as JsonRecord;
    assert.deepEqual(Object.keys(bodies).sort(), [
      'bootstrap', 'connected_credential_refresh', 'end_continuity', 'media_stop', 'realtime_e2ee_key_resolve',
    ]);
    assert.deepEqual((bundle.binding as JsonRecord).realtime_session_ref, SESSION_REF);
    assert.deepEqual((bundle.binding as JsonRecord).device_lease_ref, LEASE_REF);
    for (const [operation, entry] of Object.entries(bodies)) {
      const item = entry as JsonRecord;
      const body = JSON.parse(Buffer.from(String(item.body_base64), 'base64').toString('utf8')) as JsonRecord;
      assert.equal(body.operation, operation);
      assert.equal(item.body_sha256, hash(Buffer.from(String(item.body_base64), 'base64')));
    }
    const committed = await owner.commit(prepared);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.canonicalBodyCount, 5);
  } finally {
    cleanup(root);
  }
});

test('commit is atomic, owner-only, and replay-safe', async () => {
  const options = fixtureOptions();
  try {
    const owner = createAppleProductionEnrollmentOwner(options);
    const prepared = await owner.prepare();
    const committed = await owner.commit(prepared);
    assert.equal(committed.status, 'committed');
    assert.equal(readFileSync(options.authorityPath).toString('utf8').includes('recipient_device_credential'), true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(options.authorityPath).mode & 0o077, 0);
      assert.equal(statSync(options.outputPath).mode & 0o077, 0);
    }
    const replay = await owner.commit(prepared);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.bundleSha256, committed.bundleSha256);
  } finally {
    cleanup(options.root);
  }
});

test('existing recipient re-sign keeps authority and key while replacing only the bundle', async () => {
  const options = fixtureOptions();
  try {
    const firstOwner = createAppleProductionEnrollmentOwner(options);
    const first = await firstOwner.prepare();
    await firstOwner.commit(first);
    const authorityBytes = readFileSync(options.authorityPath);
    const oldBundleHash = hash(readFileSync(options.outputPath));
    const renewed = currentBinding();
    const renewedBinding: RealtimeCurrentBindingProjection = {
      session: { ...renewed.session, revision: '2' as never },
      lease: { ...renewed.lease, leaseVersion: '2' as never, fencingToken: '2' as never },
    };
    const stale = new Date(Date.parse(NOW) - APPLE_E2EE_REGISTRATION_MAX_AGE_MS - 1).toISOString();
    const ids = Array.from(
      { length: 6 },
      (_, index) => `01952f00-0000-7${String(index + 30).padStart(3, '0')}-8000-0000000005${30 + index}`,
    );
    let credentialIssueCalls = 0;
    const resignOptions: AppleProductionEnrollmentOwnerOptions = {
      ...options,
      expectedAuthoritySha256: hash(authorityBytes),
      registration: {
        ...options.registration!,
        read: () => Buffer.from(JSON.stringify({ ...REGISTRATION, created_at: stale }), 'utf8'),
      },
      currentBinding: {
        snapshotIsolation: 'REPEATABLE READ',
        readOnly: true,
        readCurrentBindingSnapshot: async () => ({ binding: renewedBinding, handoffDeviceId: TARGET }),
      },
      issuer: {
        issueUuidV7() {
          const id = ids.shift();
          if (id === undefined) throw new Error('ISSUER_EXHAUSTED');
          return id;
        },
        issueCanonicalObjectVersionRef() {
          credentialIssueCalls += 1;
          throw new Error('CREDENTIAL_ROTATION_FORBIDDEN');
        },
      },
    };
    const owner = createAppleProductionEnrollmentOwner(resignOptions);
    const prepared = await owner.prepare();
    assert.equal(prepared.previousAuthoritySha256, hash(authorityBytes));
    assert.equal(prepared.nextAuthoritySha256, hash(authorityBytes));
    assert.notEqual(prepared.bundleSha256, oldBundleHash);
    assert.equal(credentialIssueCalls, 0);
    assert.equal((JSON.parse(Buffer.from(prepared.bundleBytes).toString('utf8')) as JsonRecord).canonical_bodies instanceof Object, true);

    const committed = await owner.commit(prepared);
    assert.equal(committed.status, 'committed');
    assert.equal(hash(readFileSync(options.authorityPath)), hash(authorityBytes));
    assert.equal(hash(readFileSync(options.outputPath)), prepared.bundleSha256);
    assert.equal((await owner.commit(prepared)).status, 'replayed');

    const differentKey = Buffer.alloc(32, 7);
    await assert.rejects(
      createAppleProductionEnrollmentOwner({
        ...resignOptions,
        registration: {
          ...resignOptions.registration!,
          read: () => Buffer.from(JSON.stringify({
            ...REGISTRATION,
            public_raw32_base64url: differentKey.toString('base64url'),
            public_sha256: hash(differentKey),
            created_at: stale,
          }), 'utf8'),
        },
      }).prepare(),
      /APPLE_ENROLLMENT_RECIPIENT_BINDING_MISMATCH/u,
    );
    await assert.rejects(
      createAppleProductionEnrollmentOwner({
        ...resignOptions,
        registration: {
          ...resignOptions.registration!,
          assertOwnerProtected: () => { throw new Error('UNPROTECTED'); },
        },
      }).prepare(),
      /APPLE_ENROLLMENT_REGISTRATION_OWNER_PROTECTION_INVALID/u,
    );
  } finally {
    cleanup(options.root);
  }
});

test('successor reuses the current recipient key without a registration file and durably replays', async () => {
  const options = fixtureOptions();
  try {
    const firstOwner = createAppleProductionEnrollmentOwner(options);
    await firstOwner.commit(await firstOwner.prepare());
    const oldAuthorityBytes = readFileSync(options.authorityPath);
    const oldAuthorityHash = hash(oldAuthorityBytes);
    const oldAuthority = JSON.parse(oldAuthorityBytes.toString('utf8')) as JsonRecord;
    const oldRecipient = oldAuthority.recipient_device_credential as JsonRecord;
    const next = reboundBinding();
    const { registration: _registration, ...withoutRegistration } = options;
    const successorOptions = {
      ...withoutRegistration,
      reuseCurrentRecipient: true as const,
      expectedAuthoritySha256: oldAuthorityHash,
      currentBinding: {
        snapshotIsolation: 'REPEATABLE READ' as const,
        readOnly: true as const,
        readCurrentBindingSnapshot: async () => ({ binding: next, handoffDeviceId: TARGET }),
      },
      issuer: issuer(),
    };
    const successor = createAppleProductionEnrollmentOwner(successorOptions);
    const prepared = await successor.prepare();
    const preparedAuthority = JSON.parse(Buffer.from(prepared.authorityBytes).toString('utf8')) as JsonRecord;
    const newRecipient = preparedAuthority.recipient_device_credential as JsonRecord;
    assert.notDeepEqual(newRecipient.device_credential_ref, oldRecipient.device_credential_ref);
    assert.deepEqual(newRecipient.public_key, oldRecipient.public_key);
    assert.equal(Object.hasOwn(newRecipient, 'local_slot_ref_hash'), false);
    const committed = await successor.commit(prepared);
    assert.equal(committed.status, 'committed');
    assert.equal(options.authorityUpdates.count, 2);

    const replayOptions = {
      ...successorOptions,
      expectedAuthoritySha256: hash(readFileSync(options.authorityPath)),
      issuer: {
        issueUuidV7: () => { throw new Error('REPLAY_MUST_NOT_ISSUE'); },
        issueCanonicalObjectVersionRef: () => { throw new Error('REPLAY_MUST_NOT_ISSUE'); },
      },
    };
    const replayOwner = createAppleProductionEnrollmentOwner(replayOptions);
    const replayPrepared = await replayOwner.prepare();
    assert.deepEqual(replayPrepared.bundleBytes, prepared.bundleBytes);
    assert.equal(replayPrepared.bundleSha256, prepared.bundleSha256);
    assert.deepEqual(replayPrepared.credentialRef, prepared.credentialRef);
    assert.equal((await replayOwner.commit(replayPrepared)).status, 'replayed');
    assert.equal(options.authorityUpdates.count, 2);

    const port = createAppleProductionSuccessorEnrollmentPort(replayOptions);
    const portResult = await port.ensure({
      requestId: '01952f00-0000-7000-8000-000000000515',
      request: { start: { started_at: NOW } },
    });
    assert.deepEqual(Object.keys(portResult.successorEnrollment).sort(), [
      'bundle_base64', 'bundle_sha256', 'expires_at', 'schema',
    ]);
    const wire = portResult.successorEnrollment;
    assert.equal(wire.schema, 'paios.realtime-production-enrollment-successor.v1');
    assert.equal(wire.bundle_sha256, prepared.bundleSha256);
    assert.equal(hash(Buffer.from(String(wire.bundle_base64), 'base64')), prepared.bundleSha256);
    assert.equal(options.authorityUpdates.count, 2);
    await port.close();
  } finally {
    cleanup(options.root);
  }
});

test('successor reuse fails closed for a missing recipient and binding drift', async () => {
  const missing = fixtureOptions();
  try {
    const { registration: _registration, ...withoutRegistration } = missing;
    await assert.rejects(
      createAppleProductionEnrollmentOwner({ ...withoutRegistration, reuseCurrentRecipient: true }).prepare(),
      /APPLE_ENROLLMENT_RECIPIENT_MISSING/u,
    );
  } finally {
    cleanup(missing.root);
  }

  const options = fixtureOptions();
  try {
    const firstOwner = createAppleProductionEnrollmentOwner(options);
    await firstOwner.commit(await firstOwner.prepare());
    const { registration: _registration, ...withoutRegistration } = options;
    const wrongContinuityBase = currentBinding();
    const wrongContinuityId = '01952f00-0000-7000-8000-000000000516';
    const wrongContinuity: RealtimeCurrentBindingProjection = {
      session: {
        ...wrongContinuityBase.session,
        continuityId: wrongContinuityId,
        binding: { ...wrongContinuityBase.session.binding, continuityId: wrongContinuityId },
      },
      lease: { ...wrongContinuityBase.lease, continuityId: wrongContinuityId },
    };
    await assert.rejects(
      createAppleProductionEnrollmentOwner({
        ...withoutRegistration,
        reuseCurrentRecipient: true,
        expectedAuthoritySha256: hash(readFileSync(options.authorityPath)),
        currentBinding: {
          snapshotIsolation: 'REPEATABLE READ',
          readOnly: true,
          readCurrentBindingSnapshot: async () => ({ binding: wrongContinuity, handoffDeviceId: TARGET }),
        },
      }).prepare(),
      /APPLE_ENROLLMENT_RECIPIENT_BINDING_MISMATCH/u,
    );
    const wrongDeviceBase = currentBinding();
    const wrongDevice: RealtimeCurrentBindingProjection = {
      session: {
        ...wrongDeviceBase.session,
        activeDeviceId: TARGET,
        binding: { ...wrongDeviceBase.session.binding, deviceId: TARGET },
      },
      lease: { ...wrongDeviceBase.lease, deviceId: TARGET },
    };
    await assert.rejects(
      createAppleProductionEnrollmentOwner({
        ...withoutRegistration,
        reuseCurrentRecipient: true,
        expectedAuthoritySha256: hash(readFileSync(options.authorityPath)),
        currentBinding: {
          snapshotIsolation: 'REPEATABLE READ',
          readOnly: true,
          readCurrentBindingSnapshot: async () => ({ binding: wrongDevice }),
        },
      }).prepare(),
      /APPLE_ENROLLMENT_CURRENT_AUTHORITY_MISMATCH/u,
    );
  } finally {
    cleanup(options.root);
  }
});

test('prepare rejects current-binding multiplicity, expiry, and drift', async () => {
  const multiple = fixtureOptions();
  try {
    const multipleProvider = {
      ...multiple.currentBinding,
      readCurrentBindingSnapshot: async () => [
        { binding: currentBinding(), handoffDeviceId: TARGET },
        { binding: currentBinding(), handoffDeviceId: TARGET },
      ],
    };
    await assert.rejects(createAppleProductionEnrollmentOwner({ ...multiple, currentBinding: multipleProvider }).prepare(), /APPLE_ENROLLMENT_CURRENT_BINDING_CONFLICT/u);
  } finally {
    cleanup(multiple.root);
  }

  const expired = fixtureOptions();
  try {
    const expiredOptions = {
      ...expired,
      registration: {
        ...expired.registration!,
        read: () => Buffer.from(JSON.stringify({ ...REGISTRATION, created_at: '2030-01-01T03:50:00.000Z' }), 'utf8'),
      },
      clock: { now: () => '2030-01-01T04:00:00.000Z' },
    };
    await assert.rejects(createAppleProductionEnrollmentOwner(expiredOptions).prepare(), /APPLE_ENROLLMENT_AUTHORITY_EXPIRED/u);
  } finally {
    cleanup(expired.root);
  }
});

test('prepare rejects a self target and malformed unknown target', async () => {
  for (const target of [DEVICE, 'unknown-target']) {
    const root = mkdtempSync(join(tmpdir(), 'apple-enrollment-target-invalid-'));
    const options = fixtureOptions(root, target);
    try {
      await assert.rejects(
        createAppleProductionEnrollmentOwner(options).prepare(),
        /APPLE_ENROLLMENT_HANDOFF_TARGET_INVALID/u,
      );
    } finally {
      cleanup(root);
    }
  }
});

test('commit fails closed on authority prehash drift and current snapshot drift', async () => {
  const options = fixtureOptions();
  try {
    const owner = createAppleProductionEnrollmentOwner(options);
    const prepared = await owner.prepare();
    writeFileSync(options.authorityPath, Buffer.from(`${canonical({ ...AUTHORITY, grant_id: '01952f00-0000-7000-8000-000000000599' })}\n`, 'utf8'));
    await assert.rejects(owner.commit(prepared), /APPLE_ENROLLMENT_AUTHORITY_HASH_MISMATCH/u);
  } finally {
    cleanup(options.root);
  }

  const drift = fixtureOptions();
  try {
    let reads = 0;
    const driftProvider = {
      ...drift.currentBinding,
      readCurrentBindingSnapshot: async () => {
        reads += 1;
        return reads === 1
          ? { binding: currentBinding(), handoffDeviceId: TARGET }
          : { binding: { ...currentBinding(), session: { ...currentBinding().session, revision: '2' as never } }, handoffDeviceId: TARGET };
      },
    };
    const driftOptions = { ...drift, currentBinding: driftProvider };
    const driftOwner = createAppleProductionEnrollmentOwner(driftOptions);
    const driftPrepared = await driftOwner.prepare();
    await assert.rejects(driftOwner.commit(driftPrepared), /APPLE_ENROLLMENT_CURRENT_BINDING_DRIFT/u);
  } finally {
    cleanup(drift.root);
  }
});

test('CLI admits only the bounded Windows enrollment argument surface', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'apple-cli-args-'));
  const enrollmentRoot = join(repoRoot, '.runtime', 'apple-production-enrollment');
  const registrationPath = join(enrollmentRoot, 'APPLE_E2EE_REGISTRATION_COMMIT.json');
  const outputPath = join(enrollmentRoot, 'bundle.custom.json');
  try {
    const parsed = parseAppleProductionEnrollmentCliArgs([
      '--registration-path', registrationPath,
      '--expected-authority-sha256', 'A'.repeat(64),
      '--mode', 'prepare',
      '--output-path', outputPath,
    ], repoRoot);
    assert.equal(parsed.registrationPath, registrationPath);
    assert.equal(parsed.expectedAuthoritySha256, 'a'.repeat(64));
    assert.equal(parsed.mode, 'prepare');
    assert.equal(parsed.outputPath, outputPath);
    assert.throws(
      () => parseAppleProductionEnrollmentCliArgs([
        '--registration-path', registrationPath,
        '--expected-authority-sha256', 'a'.repeat(64),
        '--mode', 'prepare', '--password', 'not-accepted',
      ], repoRoot),
      /APPLE_ENROLLMENT_CLI_ARGUMENT_FORBIDDEN/u,
    );
    assert.throws(
      () => parseAppleProductionEnrollmentCliArgs([
        '--registration-path', join(repoRoot, 'outside.json'),
        '--expected-authority-sha256', 'a'.repeat(64),
        '--mode', 'prepare',
      ], repoRoot),
      /APPLE_ENROLLMENT_CLI_REGISTRATION_PATH_INVALID/u,
    );
  } finally {
    cleanup(repoRoot);
  }
});

test('CLI uses an injected owner, emits only sanitized receipt fields, and always closes it', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'apple-cli-injected-'));
  const enrollmentRoot = join(repoRoot, '.runtime', 'apple-production-enrollment');
  const registrationPath = join(enrollmentRoot, 'registration.json');
  let captured: unknown;
  let closed = false;
  const fakePrepared: AppleProductionEnrollmentPrepared = {
    authorityPath: 'not-output',
    outputPath: 'not-output',
    previousAuthoritySha256: '1'.repeat(64),
    nextAuthoritySha256: '2'.repeat(64),
    bundleSha256: '3'.repeat(64),
    authorityBytes: new Uint8Array(),
    bundleBytes: new Uint8Array(),
    snapshotFingerprint: '4'.repeat(64),
    credentialRef: { ref_type: 'DeviceCredential', ref_id: CREDENTIAL_ID },
    expiresAt: '2030-01-01T04:00:00.000Z',
    canonicalBodySha256: {
      bootstrap: '5'.repeat(64),
      realtime_e2ee_key_resolve: '5'.repeat(64),
      connected_credential_refresh: '5'.repeat(64),
      media_stop: '5'.repeat(64),
      end_continuity: '5'.repeat(64),
    },
  };
  try {
    const receipt = await runAppleProductionEnrollmentCli([
      '--registration-path', registrationPath,
      '--expected-authority-sha256', '6'.repeat(64),
      '--mode', 'prepare',
    ], {
      createRuntimeOwner: async (args) => {
        captured = args;
        return {
          owner: {
            prepare: async () => fakePrepared,
            commit: async () => { throw new Error('UNUSED'); },
            run: async (mode = 'prepare') => {
              assert.equal(mode, 'prepare');
              return fakePrepared;
            },
          },
          close: async () => { closed = true; },
        };
      },
    }, repoRoot);
    assert.equal((captured as { readonly mode: string }).mode, 'prepare');
    assert.deepEqual(receipt, {
      status: 'prepared',
      authority_sha256: '2'.repeat(64),
      bundle_sha256: '3'.repeat(64),
      canonical_body_count: 5,
      expires_at: fakePrepared.expiresAt,
    });
    assert.equal(Object.hasOwn(receipt, 'credential_ref'), false);
    assert.equal(Object.hasOwn(receipt, 'output_path'), false);
    assert.equal(closed, true);
  } finally {
    cleanup(repoRoot);
  }
});

test('Windows owner ACL probe accepts only a protected single-owner regular file', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows ACL integration test');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'apple-acl-real-'));
  const protectedPath = join(root, 'protected.json');
  const inheritedPath = join(root, 'inherited.json');
  const wrongRulePath = join(root, 'wrong-rule.json');
  const reparsePath = join(root, 'reparse.json');
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  assert.equal(typeof username, 'string');
  assert.equal(typeof domain, 'string');
  const principal = `${domain}\\${username}`;
  try {
    writeFileSync(protectedPath, '{}\n', { mode: 0o600 });
    execFileSync('icacls.exe', [
      protectedPath, '/inheritance:r', '/grant:r', `${principal}:F`,
    ], { stdio: 'ignore', windowsHide: true });
    assertAppleEnrollmentOwnerProtectedPath(protectedPath);

    writeFileSync(inheritedPath, '{}\n');
    assert.throws(
      () => assertAppleEnrollmentOwnerProtectedPath(inheritedPath),
      /APPLE_ENROLLMENT_OWNER_ACL_INVALID/u,
    );

    writeFileSync(wrongRulePath, '{}\n', { mode: 0o600 });
    execFileSync('icacls.exe', [
      wrongRulePath, '/inheritance:r', '/grant:r', `${principal}:F`,
      '/grant', '*S-1-5-32-545:R',
    ], { stdio: 'ignore', windowsHide: true });
    assert.throws(
      () => assertAppleEnrollmentOwnerProtectedPath(wrongRulePath),
      /APPLE_ENROLLMENT_OWNER_ACL_INVALID/u,
    );

    try {
      symlinkSync(protectedPath, reparsePath, 'file');
    } catch {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    assert.throws(
      () => assertAppleEnrollmentOwnerProtectedPath(reparsePath),
      /APPLE_ENROLLMENT_OWNER_FILE_INVALID/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('durable recipient replay survives a fresh process without calling the issuer', async () => {
  const options = fixtureOptions();
  try {
    const owner = createAppleProductionEnrollmentOwner(options);
    const prepared = await owner.prepare();
    await owner.commit(prepared);
    const input = {
      authorityPath: options.authorityPath, outputPath: options.outputPath,
      authorityHash: hash(readFileSync(options.authorityPath)), binding: currentBinding(),
      handoffDeviceId: TARGET, now: NOW,
    };
    const moduleUrl = pathToFileURL(join(import.meta.dirname, '../src/apple-production-enrollment-owner.ts')).href;
    const child = `
      import { createAppleProductionEnrollmentOwner } from ${JSON.stringify(moduleUrl)};
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const owner = createAppleProductionEnrollmentOwner({
        authorityPath: input.authorityPath, outputPath: input.outputPath,
        reuseCurrentRecipient: true, expectedAuthoritySha256: input.authorityHash,
        authorityHashPort: { current: () => input.authorityHash, updateAfterCommit: () => { throw Error('REPLAY_HASH_MUST_NOT_UPDATE'); } },
        currentBinding: { snapshotIsolation: 'REPEATABLE READ', readOnly: true, readCurrentBindingSnapshot: async () => ({binding: input.binding, handoffDeviceId: input.handoffDeviceId}) },
        issuer: { issueUuidV7: () => { throw Error('REPLAY_MUST_NOT_ISSUE'); }, issueCanonicalObjectVersionRef: () => { throw Error('REPLAY_MUST_NOT_ISSUE'); } },
        clock: {now: () => input.now},
      });
      const prepared = await owner.prepare();
      console.log(JSON.stringify(await owner.commit(prepared)));
    `;
    const receipt = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', child], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000,
    }));
    assert.equal(receipt.status, 'replayed');
    assert.equal(receipt.bundleSha256, prepared.bundleSha256);
    assert.deepEqual(readFileSync(options.outputPath), Buffer.from(prepared.bundleBytes));
    assert.equal(options.authorityUpdates.count, 1);
  } finally { cleanup(options.root); }
});

test('durable recipient replay rejects contract, binding and hash drift and retains missing-result uncertainty', async () => {
  const options = fixtureOptions();
  try {
    const owner = createAppleProductionEnrollmentOwner(options);
    const prepared = await owner.prepare();
    await owner.commit(prepared);
    const { registration: _registration, ...base } = options;
    const replayOptions = {
      ...base, reuseCurrentRecipient: true as const,
      expectedAuthoritySha256: hash(readFileSync(options.authorityPath)),
      issuer: { issueUuidV7: () => { throw Error('REPLAY_MUST_NOT_ISSUE'); }, issueCanonicalObjectVersionRef: () => { throw Error('REPLAY_MUST_NOT_ISSUE'); } },
    };
    const port = createAppleProductionSuccessorEnrollmentPort(replayOptions);
    await assert.rejects(port.ensure({ requestId: 'short', request: { start: { started_at: NOW } } }), /APPLE_ENROLLMENT_SUCCESSOR_REQUEST_INVALID/u);
    writeFileSync(options.outputPath, '{invalid-json', { mode: 0o600 });
    await assert.rejects(createAppleProductionEnrollmentOwner(replayOptions).prepare(), /APPLE_ENROLLMENT_REPLAY_BUNDLE_INVALID/u);
    const bundle = JSON.parse(Buffer.from(prepared.bundleBytes).toString('utf8'));
    const entry = bundle.canonical_bodies.bootstrap;
    const body = JSON.parse(Buffer.from(entry.body_base64, 'base64').toString('utf8'));
    body.unapproved_field = true;
    const invalidBody = Buffer.from(canonical(body));
    entry.body_base64 = invalidBody.toString('base64'); entry.body_sha256 = hash(invalidBody);
    writeFileSync(options.outputPath, canonical(bundle), { mode: 0o600 });
    await assert.rejects(createAppleProductionEnrollmentOwner(replayOptions).prepare(), /APPLE_ENROLLMENT_REPLAY_BUNDLE_INVALID/u);
    writeFileSync(options.outputPath, prepared.bundleBytes, { mode: 0o600 });
    const changed = currentBinding();
    const driftBinding = { ...changed, session: { ...changed.session, connectionEpoch: '2' as never, binding: { ...changed.session.binding, connectionEpoch: '2' as never } } };
    await assert.rejects(createAppleProductionEnrollmentOwner({
      ...replayOptions, currentBinding: { ...options.currentBinding, readCurrentBindingSnapshot: async () => ({ binding: driftBinding, handoffDeviceId: TARGET }) },
    }).prepare(), /APPLE_ENROLLMENT_REPLAY_BUNDLE_MISMATCH/u);
    const authorityBytes = readFileSync(options.authorityPath);
    writeFileSync(options.authorityPath, Buffer.concat([authorityBytes, Buffer.from('\n')]), { mode: 0o600 });
    await assert.rejects(createAppleProductionEnrollmentOwner(replayOptions).prepare(), /APPLE_ENROLLMENT_AUTHORITY_HASH_MISMATCH/u);
    writeFileSync(options.authorityPath, authorityBytes, { mode: 0o600 });
    rmSync(options.outputPath);
    await assert.rejects(createAppleProductionEnrollmentOwner(replayOptions).prepare(), /APPLE_ENROLLMENT_OWNER_UUID_ISSUER_FAILED/u);
    assert.equal(existsSync(options.outputPath), false);
    assert.deepEqual(readFileSync(options.authorityPath), authorityBytes);
    assert.equal(options.authorityUpdates.count, 1);
  } finally { cleanup(options.root); }
});
