import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  CurrentBindingLookup,
  RealtimeCurrentBindingProjection,
} from '../../../services/realtime-core/src/types.ts';
import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeOperation,
} from '../src/realtime-public-control-runtime.ts';
import type {
  RecipientCredentialPort,
  RecipientCredentialResolution,
} from '../src/realtime-e2ee-ciphertext-resolver.ts';
import {
  createT03GovernanceDeviceCredentialProductionAdapter,
  T03_GOVERNANCE_BRIDGE_ERROR,
} from '../src/t03-governance-device-credential-production-adapter.ts';
import {
  projectT03RecipientX25519PublicKey,
  type T03AuthoritySnapshotPort,
} from '../src/t03-governance-device-credential-runtime.ts';

const NOW = '2026-08-23T12:00:00.000Z';
const EXPIRES = '2026-08-23T12:05:00.000Z';
const DEVICE = 'device-1';
const USER = 'user-1';
const AUDIENCE = 'rayneo-device';
const SESSION = Object.freeze({ ref_type: 'RealtimeSession', ref_id: 'session-1', object_version: '1' });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: 'lease-1', object_version: '1' });
const CREDENTIAL = Object.freeze({ ref_type: 'DeviceCredential', ref_id: 'credential-1', object_version: '1' });
const GOVERNANCE = Object.freeze({
  purpose_scopes: ['realtime_assistant'],
  consent_record_refs: ['consent-1'],
  policy_decision_refs: ['policy-1'],
  purpose_token_refs: ['purpose-token-1'],
  capability_grant_refs: ['grant-1'],
});
const PUBLIC_BYTES = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const PUBLIC_KEY = Buffer.from(PUBLIC_BYTES).toString('base64url');
const PUBLIC_KEY_SHA256 = createHash('sha256').update(PUBLIC_BYTES).digest('hex');
const BEARER: RealtimeBearerContext = Object.freeze({ principal: { principal: 'principal-1', userId: USER }, deviceId: DEVICE, scopes: ['audio', 'video', 'data'] });
const TRANSPORT_ALIASES = Object.freeze([
  Object.freeze({ alias_type: 'participant', issuer: 'livekit_cloud', value: DEVICE }),
  Object.freeze({ alias_type: 'room', issuer: 'livekit_cloud', value: 'room-1' }),
  Object.freeze({ alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'room-1' }),
]);

function credential(overrides: JsonRecord = {}): JsonRecord {
  return {
    device_credential_ref: CREDENTIAL,
    algorithm: 'X25519',
    purpose: 'hpke_recipient',
    public_key: PUBLIC_KEY,
    public_key_sha256: PUBLIC_KEY_SHA256,
    audience: AUDIENCE,
    device_id: DEVICE,
    realtime_session_ref: SESSION,
    device_lease_ref: LEASE,
    continuity_id: 'continuity-1',
    expires_at: EXPIRES,
    revocation: { status: 'active' },
    supersession: null,
    deletion: null,
    ...overrides,
  };
}

function authority(overrides: JsonRecord = {}): JsonRecord {
  return {
    status: 'available',
    decision: 'permit',
    principal: 'principal-1',
    user_id: USER,
    device_id: DEVICE,
    scopes: ['audio', 'video', 'data'],
    device_credential_ref: CREDENTIAL,
    device_credential: credential(),
    ...overrides,
  };
}

function currentBinding(overrides: JsonRecord = {}): RealtimeCurrentBindingProjection {
  const session = {
    realtimeSessionRef: SESSION,
    userId: USER,
    continuityId: 'continuity-1',
    state: 'active',
    continuityState: 'active',
    connectionEpoch: '1',
    continuityExpiresAt: EXPIRES,
    lastAcceptedUserActivityAt: NOW,
    activeDeviceId: DEVICE,
    activeDeviceLeaseRef: LEASE,
    binding: {
      state: 'connected',
      realtimeSessionRef: SESSION,
      deviceLeaseRef: LEASE,
      continuityId: 'continuity-1',
      deviceId: DEVICE,
      connectionEpoch: '1',
      provider: 'livekit',
      transportSessionAlias: 'room-1',
      roomAlias: 'room-1',
      deviceAlias: DEVICE,
      connectionId: 'connection-1',
    },
    revision: '1',
  };
  const lease = {
    deviceLeaseRef: LEASE,
    realtimeSessionRef: SESSION,
    continuityId: 'continuity-1',
    userId: USER,
    deviceId: DEVICE,
    state: 'active',
    capabilities: ['audio', 'video', 'data'],
    purpose: 'realtime_assistant',
    issuedAt: NOW,
    expiresAt: EXPIRES,
    revocable: true,
    leaseVersion: '1',
    fencingToken: '1',
    policyDecisionRef: { ref_type: 'PolicyDecision', ref_id: 'policy-1', object_version: '1' },
  };
  return { session: { ...session, ...(overrides.session as JsonRecord | undefined) }, lease: { ...lease, ...(overrides.lease as JsonRecord | undefined) } } as unknown as RealtimeCurrentBindingProjection;
}

function request(operation: RealtimeOperation, overrides: JsonRecord = {}): JsonRecord {
  return {
    device_id: DEVICE,
    realtime_session_ref: SESSION,
    device_lease_ref: LEASE,
    continuity_id: 'continuity-1',
    connection_epoch: '1',
    transport_aliases: TRANSPORT_ALIASES,
    governance: GOVERNANCE,
    ...overrides,
    ...(operation === 'realtime_e2ee_key_resolve'
      ? { participant_audience: AUDIENCE, recipient_device_credential_ref: CREDENTIAL }
      : {}),
  };
}

function bootstrapRequest(mode: 'initial' | 'fully_disconnected'): JsonRecord {
  const value = request('bootstrap', { bootstrap_mode: mode });
  if (mode === 'initial') {
    delete value.realtime_session_ref;
    delete value.device_lease_ref;
    delete value.continuity_id;
    delete value.connection_epoch;
    delete value.transport_aliases;
  }
  return value;
}

function recipientResolution(overrides: Partial<RecipientCredentialResolution> = {}): RecipientCredentialResolution {
  return {
    publicKey: PUBLIC_BYTES,
    status: 'active',
    expiresAt: EXPIRES,
    deviceId: DEVICE,
    credentialRef: CREDENTIAL,
    ...overrides,
  };
}

function makeAdapter(options: {
  readonly authorityValue?: unknown;
  readonly bindingValue?: RealtimeCurrentBindingProjection | undefined;
  readonly recipientValue?: RecipientCredentialResolution | undefined;
  readonly clock?: () => number | string | Date;
} = {}) {
  const authorityInputs: JsonRecord[] = [];
  const bindingInputs: CurrentBindingLookup[] = [];
  const recipientInputs: JsonRecord[] = [];
  let authorityCloseCount = 0;
  let bindingCloseCount = 0;
  let recipientCloseCount = 0;
  const ownerAuthority: T03AuthoritySnapshotPort & { readonly close: () => Promise<void> } = {
    async resolve(input: Parameters<T03AuthoritySnapshotPort['resolve']>[0]) {
      authorityInputs.push(input as unknown as JsonRecord);
      return Object.hasOwn(options, 'authorityValue') ? options.authorityValue : authority();
    },
    async close() { authorityCloseCount += 1; },
  };
  const readCurrentBinding = Object.assign(
    async (lookup: CurrentBindingLookup) => {
      bindingInputs.push(lookup);
      return Object.hasOwn(options, 'bindingValue') ? options.bindingValue : currentBinding();
    },
    { async close() { bindingCloseCount += 1; } },
  );
  const ownerRecipient: RecipientCredentialPort = {
    async resolve(input) {
      recipientInputs.push(input as unknown as JsonRecord);
      return Object.hasOwn(options, 'recipientValue') ? options.recipientValue : recipientResolution();
    },
    async close() { recipientCloseCount += 1; },
  };
  const adapter = createT03GovernanceDeviceCredentialProductionAdapter({
    authority: ownerAuthority,
    readCurrentBinding,
    recipientCredential: ownerRecipient,
    clock: options.clock ?? (() => NOW),
  });
  return { adapter, authorityInputs, bindingInputs, recipientInputs, getCloseCounts: () => [authorityCloseCount, bindingCloseCount, recipientCloseCount] as const };
}

async function assertBridgeRejected(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof Error && error.message === T03_GOVERNANCE_BRIDGE_ERROR);
}

test('production bridge adapts T02 binding and authorizes connected refresh and handoff', async () => {
  const harness = makeAdapter();
  const refreshDecision = await harness.adapter.governance.evaluate({
    operation: 'connected_credential_refresh',
    request: request('connected_credential_refresh'),
    bearer: BEARER,
  });
  assert.equal(refreshDecision.accepted, true, JSON.stringify(refreshDecision));
  const refresh = await harness.adapter.governance.assertAuthorized({
    operation: 'connected_credential_refresh',
    request: request('connected_credential_refresh'),
    bearer: BEARER,
    governance: GOVERNANCE,
  });
  assert.deepEqual(refresh, GOVERNANCE);
  const handoff = await harness.adapter.governance.assertAuthorized({
    operation: 'handoff',
    request: request('handoff', { current_device_lease_ref: LEASE, from_device_id: DEVICE, to_device_id: 'device-2' }),
    bearer: BEARER,
    governance: GOVERNANCE,
  });
  assert.deepEqual(handoff, GOVERNANCE);
  for (const [operation, wireRequest] of [
    ['bootstrap', bootstrapRequest('initial')],
    ['bootstrap', bootstrapRequest('fully_disconnected')],
    ['media_stop', request('media_stop')],
    ['end_continuity', request('end_continuity')],
  ] as const) {
    const decision = await harness.adapter.governance.evaluate({
      operation,
      request: { ...wireRequest, governance: GOVERNANCE },
      bearer: BEARER,
    });
    assert.equal(decision.accepted, true, `${operation}:${JSON.stringify(decision)}`);
    const accepted = await harness.adapter.governance.assertAuthorized({
      operation,
      request: wireRequest,
      bearer: BEARER,
      governance: GOVERNANCE,
    });
    assert.deepEqual(accepted, GOVERNANCE, operation);
  }
  assert.deepEqual(harness.bindingInputs[0], { realtimeSessionRef: SESSION });
  assert.deepEqual(harness.bindingInputs[1], { realtimeSessionRef: SESSION });
  assert.equal(harness.authorityInputs[0]?.atSystemTime, NOW);
});

test('binding adapter uses continuity lookup only when exact session ref is absent', async () => {
  const harness = makeAdapter();
  const port = harness.adapter.binding;
  assert.ok(port);
  await port.resolve({ operation: 'media_stop', request: request('media_stop'), bearer: BEARER, atSystemTime: NOW });
  await port.resolve({ operation: 'media_stop', request: request('media_stop', { realtime_session_ref: undefined }), bearer: BEARER, atSystemTime: NOW });
  assert.deepEqual(harness.bindingInputs[1], { continuityId: 'continuity-1' });
});

test('binding adapter projects sorted canonical aliases and rejects alias drift', async () => {
  const harness = makeAdapter();
  const projected = await harness.adapter.binding?.resolve({
    operation: 'media_stop',
    request: request('media_stop'),
    bearer: BEARER,
    atSystemTime: NOW,
  }) as JsonRecord | undefined;
  assert.deepEqual(projected?.transport_aliases, TRANSPORT_ALIASES);
  assert.deepEqual(projected?.capabilities, ['audio', 'video', 'data']);
  assert.equal(Object.hasOwn(projected ?? {}, 'capability_scopes'), false);
  assert.equal(Object.hasOwn((projected?.lease as JsonRecord | undefined) ?? {}, 'capability_scopes'), false);
  const variants: readonly [string, readonly unknown[]][] = [
    ['type', TRANSPORT_ALIASES.map((alias, index) => index === 0 ? { ...alias, alias_type: 'device' } : alias)],
    ['issuer', TRANSPORT_ALIASES.map((alias, index) => index === 0 ? { ...alias, issuer: 'other' } : alias)],
    ['bad-issuer-shape', TRANSPORT_ALIASES.map((alias, index) => index === 0 ? { ...alias, issuer: 'bad issuer' } : alias)],
    ['bad-provider', TRANSPORT_ALIASES.map((alias, index) => index === 0 ? { ...alias, provider_id: 'not-uuid' } : alias)],
    ['value', TRANSPORT_ALIASES.map((alias, index) => index === 0 ? { ...alias, value: 'drifted' } : alias)],
    ['duplicate', [TRANSPORT_ALIASES[0], TRANSPORT_ALIASES[0], TRANSPORT_ALIASES[2]]],
    ['missing', TRANSPORT_ALIASES.slice(1)],
    ['extra', [...TRANSPORT_ALIASES, TRANSPORT_ALIASES[0]]],
    ['unsorted', [...TRANSPORT_ALIASES].reverse()],
  ];
  const accepted = await harness.adapter.governance.evaluate({
    operation: 'media_stop',
    request: request('media_stop'),
    bearer: BEARER,
  });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  for (const [label, transportAliases] of variants) {
    const decision = await harness.adapter.governance.evaluate({
      operation: 'media_stop',
      request: request('media_stop', { transport_aliases: transportAliases }),
      bearer: BEARER,
    });
    assert.equal(decision.accepted, false, `${label}:${JSON.stringify(decision)}`);
  }
});

test('binding media capabilities stay distinct from operation scopes', async () => {
  const operationScopes: readonly string[] = [
    'bootstrap',
    'connected_credential_refresh',
    'end_continuity',
    'handoff',
    'media_stop',
    'realtime_e2ee_key_resolve',
  ];
  const bearer = { ...BEARER, scopes: operationScopes };
  const acceptedHarness = makeAdapter({ authorityValue: authority({ scopes: operationScopes }) });
  const accepted = await acceptedHarness.adapter.governance.evaluate({
    operation: 'media_stop',
    request: request('media_stop'),
    bearer,
  });
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));

  const drifted = makeAdapter({ authorityValue: authority({ scopes: operationScopes.slice(0, -1) }) });
  const rejected = await drifted.adapter.governance.evaluate({
    operation: 'media_stop',
    request: request('media_stop'),
    bearer,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'T03_CAPABILITY_MISMATCH');
});

test('recipient bridge exposes only current X25519 public material and rejects invalid key shape', async () => {
  const harness = makeAdapter();
  const view = harness.adapter.recipientCredential;
  assert.ok(view?.resolve);
  const resolved = await view.resolve({ request: request('realtime_e2ee_key_resolve'), deviceId: DEVICE, credentialRef: CREDENTIAL });
  assert.ok(resolved);
  assert.deepEqual(resolved.credentialRef, CREDENTIAL);
  assert.equal(resolved.status, 'active');
  assert.equal(Buffer.from(resolved.publicKey as Uint8Array).toString('base64url'), PUBLIC_KEY);
  assert.equal(resolved.expiresAt, EXPIRES);
  assert.equal(harness.recipientInputs[0]?.atSystemTime, undefined);

  const bad = makeAdapter({ recipientValue: recipientResolution({ publicKey: new Uint8Array(33) }) });
  const badView = bad.adapter.recipientCredential;
  assert.ok(badView?.resolve);
  assert.equal(await badView.resolve({ request: request('realtime_e2ee_key_resolve'), deviceId: DEVICE, credentialRef: CREDENTIAL }), undefined);
  assert.throws(() => projectT03RecipientX25519PublicKey({
    ...credential(),
    private_key: 'must-not-cross-boundary',
  }));
});

test('missing owner inputs, lifecycle failure, and clock failure stay fail closed', async () => {
  const input = {
    operation: 'connected_credential_refresh' as const,
    request: request('connected_credential_refresh'),
    bearer: BEARER,
    governance: GOVERNANCE,
  };
  const missing = createT03GovernanceDeviceCredentialProductionAdapter({ clock: () => NOW });
  await assertBridgeRejected(() => missing.governance.assertAuthorized(input));

  const noBinding = createT03GovernanceDeviceCredentialProductionAdapter({
    authority: { resolve: async () => authority() },
    clock: () => NOW,
  });
  await assertBridgeRejected(() => noBinding.governance.assertAuthorized(input));

  const revoked = makeAdapter({ authorityValue: authority({ device_credential: credential({ revocation: { status: 'revoked' } }) }) });
  await assertBridgeRejected(() => revoked.adapter.governance.assertAuthorized(input));

  const invalidClock = makeAdapter({ clock: () => 'not-a-time' });
  await assertBridgeRejected(() => invalidClock.adapter.governance.assertAuthorized(input));
});

test('injected clock reaches authority, binding, and recipient seams and close is idempotent', async () => {
  const times: unknown[] = [];
  const harness = makeAdapter({
    clock: () => {
      times.push(NOW);
      return NOW;
    },
  });
  const e2ee = await harness.adapter.governance.evaluate({
    operation: 'realtime_e2ee_key_resolve',
    request: request('realtime_e2ee_key_resolve'),
    bearer: BEARER,
  });
  assert.equal(e2ee.accepted, true, JSON.stringify(e2ee));
  assert.equal(times.length >= 1, true);
  assert.equal(harness.authorityInputs[0]?.atSystemTime, NOW);
  assert.equal(harness.bindingInputs.length, 1);
  assert.equal(harness.recipientInputs.length, 1);
  await Promise.all([harness.adapter.close(), harness.adapter.close()]);
  assert.deepEqual(harness.getCloseCounts(), [1, 1, 1]);
});
