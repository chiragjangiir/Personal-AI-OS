import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeGovernanceDecision,
  RealtimeGovernancePort,
  RealtimeOperation,
} from '../src/realtime-public-control-runtime.ts';
import {
  T03_GOVERNANCE_REASONS,
  T03GovernanceDeviceCredentialRuntime,
  type T03AuthoritySnapshotPort,
  type T03RealtimeBindingPort,
  type T03RecipientX25519PublicKeyPort,
  projectT03RecipientX25519PublicKey,
} from '../src/t03-governance-device-credential-runtime.ts';

const NOW = '2026-08-23T12:00:00.000Z';
const EXPIRES = '2026-08-23T12:05:00.000Z';
const DEVICE = 'device-1';
const TO_DEVICE = 'device-2';
const AUDIENCE = 'rayneo-device';
const SESSION = Object.freeze({ ref_type: 'RealtimeSession', ref_id: 'session-1', object_version: '1' });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: 'lease-1', object_version: '1' });
const CREDENTIAL = Object.freeze({ ref_type: 'DeviceCredential', ref_id: 'credential-1', object_version: '1' });
const PUBLIC_BYTES = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const PUBLIC_KEY = Buffer.from(PUBLIC_BYTES).toString('base64url');
const PUBLIC_KEY_SHA256 = createHash('sha256').update(PUBLIC_BYTES).digest('hex');
const GOVERNANCE = Object.freeze({ purpose_scopes: ['realtime_assistant'], consent_record_refs: ['consent-1'], policy_decision_refs: ['policy-1'], purpose_token_refs: ['purpose-token-1'], capability_grant_refs: ['grant-1'] });
const BEARER: RealtimeBearerContext = Object.freeze({ principal: 'principal-1', deviceId: DEVICE });

function request(operation: RealtimeOperation, overrides: JsonRecord = {}): JsonRecord {
  const base: JsonRecord = {
    operation,
    device_id: DEVICE,
    realtime_session_ref: SESSION,
    device_lease_ref: LEASE,
    continuity_id: 'continuity-1',
    connection_epoch: '1',
    transport_aliases: ['room-1', 'participant-1'],
    participant_audience: AUDIENCE,
    recipient_device_credential_ref: CREDENTIAL,
    governance: GOVERNANCE,
  };
  if (operation === 'bootstrap') {
    delete base.realtime_session_ref;
    delete base.device_lease_ref;
    delete base.connection_epoch;
    delete base.continuity_id;
    delete base.transport_aliases;
    base.bootstrap_mode = 'initial';
    base.start = { kind: 'explicit_user_start', device_id: DEVICE, modalities: ['audio'], started_at: NOW };
    base.requested_media = { audio: true, video: false, data: false };
  }
  if (operation === 'end_continuity') {
    delete base.device_lease_ref;
    delete base.transport_aliases;
    delete base.participant_audience;
    delete base.recipient_device_credential_ref;
  }
  if (operation === 'handoff') {
    delete base.device_id;
    delete base.device_lease_ref;
    delete base.transport_aliases;
    base.current_device_lease_ref = LEASE;
    base.from_device_id = DEVICE;
    base.to_device_id = TO_DEVICE;
  }
  if (operation !== 'realtime_e2ee_key_resolve') {
    delete base.participant_audience;
    delete base.recipient_device_credential_ref;
  }
  return { ...base, ...overrides };
}

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
  return { status: 'available', decision: 'permit', device_credential: credential(), ...overrides };
}

function binding(overrides: JsonRecord = {}): JsonRecord {
  return { status: 'connected', device_id: DEVICE, realtime_session_ref: SESSION, device_lease_ref: LEASE, continuity_id: 'continuity-1', connection_epoch: '1', transport_aliases: ['room-1', 'participant-1'], audience: AUDIENCE, device_credential_ref: CREDENTIAL, ...overrides };
}

function harness(config: { authority?: unknown; binding?: unknown; recipient?: unknown; now?: () => number | string | Date } = {}): {
  readonly runtime: T03GovernanceDeviceCredentialRuntime;
  readonly authorityInputs: JsonRecord[];
  readonly bindingInputs: JsonRecord[];
  readonly recipientInputs: JsonRecord[];
} {
  const authorityInputs: JsonRecord[] = [];
  const bindingInputs: JsonRecord[] = [];
  const recipientInputs: JsonRecord[] = [];
  const authorityPort: T03AuthoritySnapshotPort = { async resolve(input) { authorityInputs.push(input as unknown as JsonRecord); return Object.hasOwn(config, 'authority') ? config.authority : authority(); } };
  const bindingPort: T03RealtimeBindingPort = { async resolve(input) { bindingInputs.push(input as unknown as JsonRecord); return Object.hasOwn(config, 'binding') ? config.binding : binding(); } };
  const recipientPort: T03RecipientX25519PublicKeyPort = { async resolve(input) { recipientInputs.push(input as unknown as JsonRecord); return Object.hasOwn(config, 'recipient') ? config.recipient : credential(); } };
  return {
    runtime: new T03GovernanceDeviceCredentialRuntime({ authority: authorityPort, binding: bindingPort, recipientPublicKey: recipientPort, now: config.now ?? (() => NOW) }),
    authorityInputs,
    bindingInputs,
    recipientInputs,
  };
}

async function decision(operation: RealtimeOperation, config: Parameters<typeof harness>[0] = {}, overrides: JsonRecord = {}): Promise<RealtimeGovernanceDecision> {
  return harness(config).runtime.evaluate({ operation, request: request(operation, overrides), bearer: BEARER });
}

test('structural ports assign and every supported operation accepts the injected current snapshot', async () => {
  const operations: readonly RealtimeOperation[] = ['bootstrap', 'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff', 'realtime_e2ee_key_resolve'];
  for (const operation of operations) {
    const result = await decision(operation);
    assert.equal(result.accepted, true, operation);
    assert.deepEqual(result.refs, GOVERNANCE);
    assert.notStrictEqual(result.refs, GOVERNANCE);
    assert.equal(Object.isFrozen(result.refs), true);
  }
  const port: RealtimeGovernancePort = harness().runtime;
  assert.equal(typeof port.evaluate, 'function');
});

test('handoff is supported with explicit permit, deny, abstain, and unavailable outcomes', async () => {
  assert.equal((await decision('handoff')).accepted, true);
  const authorityCases: readonly [unknown, string][] = [
    [{ status: 'deny' }, 'T03_AUTHORITY_DENIED'],
    [{ status: 'abstain' }, 'T03_AUTHORITY_ABSTAINED'],
    [{ status: 'unavailable' }, 'T03_AUTHORITY_UNAVAILABLE'],
  ];
  for (const [snapshot, reason] of authorityCases) {
    assert.deepEqual(await decision('handoff', { authority: snapshot }), { accepted: false, reason });
  }
  assert.deepEqual(await decision('handoff', { binding: { status: 'unavailable' } }), { accepted: false, reason: 'T03_BINDING_UNAVAILABLE' });
  assert.deepEqual(await decision('handoff', { binding: { status: 'unknown' } }), { accepted: false, reason: 'T03_BINDING_INVALID' });
});

test('runtime input undefined, null, and non-object values return request-invalid without throwing', async () => {
  const runtime = harness().runtime;
  for (const input of [undefined, null, 'not-an-input', 7, []] as unknown[]) {
    assert.deepEqual(await runtime.evaluate(input as never), { accepted: false, reason: 'T03_REQUEST_INVALID' });
  }
});

test('accepted governance is a deep frozen clone and the injected clock is passed deterministically', async () => {
  const h = harness({ now: () => new Date(NOW) });
  const result = await h.runtime.evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: BEARER });
  assert.equal(result.accepted, true);
  assert.equal((h.authorityInputs[0] as JsonRecord).atSystemTime, NOW);
  assert.equal((h.bindingInputs[0] as JsonRecord).atSystemTime, NOW);
  assert.throws(() => ((result.refs as JsonRecord).purpose_scopes as string[]).push('mutate'), TypeError);
});

test('missing, unavailable, deny, abstain, expired, revoked, superseded, and deleted authority states fail without refs', async () => {
  const cases: readonly [unknown, string][] = [
    [undefined, 'T03_AUTHORITY_MISSING'],
    [{ status: 'unavailable' }, 'T03_AUTHORITY_UNAVAILABLE'],
    [{ status: 'deny' }, 'T03_AUTHORITY_DENIED'],
    [{ decision: 'abstain' }, 'T03_AUTHORITY_ABSTAINED'],
    [{ status: 'expired' }, 'T03_AUTHORITY_EXPIRED'],
    [{ status: 'revoked' }, 'T03_AUTHORITY_REVOKED'],
    [{ status: 'superseded' }, 'T03_AUTHORITY_SUPERSEDED'],
    [{ status: 'deleted' }, 'T03_AUTHORITY_DELETED'],
  ];
  for (const [snapshot, reason] of cases) {
    const result = await decision('media_stop', { authority: snapshot });
    assert.deepEqual(result, { accepted: false, reason });
    assert.equal('refs' in result, false);
    assert.equal(T03_GOVERNANCE_REASONS.includes(result.reason as never), true);
  }
});

test('empty or evidence-free snapshots fail closed, and authority permit/binding active evidence is explicit', async () => {
  const authorityCases: readonly [unknown, string][] = [
    [null, 'T03_AUTHORITY_MISSING'],
    [{}, 'T03_AUTHORITY_INVALID'],
    [{ status: 'available', device_credential: credential() }, 'T03_AUTHORITY_INVALID'],
  ];
  for (const [snapshot, reason] of authorityCases) {
    const result = await decision('media_stop', { authority: snapshot });
    assert.deepEqual(result, { accepted: false, reason });
    assert.equal('refs' in result, false);
  }
  const bindingCases: readonly [unknown, string][] = [
    [null, 'T03_BINDING_MISSING'],
    [{}, 'T03_BINDING_INVALID'],
    [{ status: 'available' }, 'T03_BINDING_INVALID'],
  ];
  for (const [snapshot, reason] of bindingCases) {
    const result = await decision('media_stop', { binding: snapshot });
    assert.deepEqual(result, { accepted: false, reason });
    assert.equal('refs' in result, false);
  }
});

test('deterministic expiry rejects at and after the credential deadline', async () => {
  const atDeadline = await decision('realtime_e2ee_key_resolve', { now: () => EXPIRES }, { governance: GOVERNANCE });
  assert.deepEqual(atDeadline, { accepted: false, reason: 'T03_AUTHORITY_EXPIRED' });
  const afterDeadline = await decision('realtime_e2ee_key_resolve', { now: () => '2026-08-23T12:05:00.001Z' });
  assert.deepEqual(afterDeadline, { accepted: false, reason: 'T03_AUTHORITY_EXPIRED' });
});

test('handoff expiry is deterministic at the current DeviceCredential deadline', async () => {
  assert.deepEqual(await decision('handoff', { now: () => EXPIRES }), { accepted: false, reason: 'T03_AUTHORITY_EXPIRED' });
  assert.deepEqual(await decision('handoff', { now: () => '2026-08-23T12:05:00.001Z' }), { accepted: false, reason: 'T03_AUTHORITY_EXPIRED' });
});

test('T02 and T11B unavailable errors are normalized without owner error leakage', async () => {
  const authorityPort: T03AuthoritySnapshotPort = { async resolve() { throw new Error('T02_INTERNAL_SECRET_DATABASE_FAILURE'); } };
  const bindingPort: T03RealtimeBindingPort = { async resolve() { throw new Error('T11B_INTERNAL_SECRET_BINDING_FAILURE'); } };
  const recipientPort: T03RecipientX25519PublicKeyPort = { async resolve() { throw new Error('recipient owner detail'); } };
  const runtime = new T03GovernanceDeviceCredentialRuntime({ authority: authorityPort, binding: bindingPort, recipientPublicKey: recipientPort, now: () => NOW });
  const authorityResult = await runtime.evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: BEARER });
  assert.deepEqual(authorityResult, { accepted: false, reason: 'T03_AUTHORITY_UNAVAILABLE' });
  const bindingResult = await new T03GovernanceDeviceCredentialRuntime({ authority: { async resolve() { return authority(); } }, binding: bindingPort, now: () => NOW }).evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: BEARER });
  assert.deepEqual(bindingResult, { accepted: false, reason: 'T03_BINDING_UNAVAILABLE' });
  assert.equal(JSON.stringify(bindingResult).includes('SECRET'), false);
});

test('owner subject, user, capability reference, scope, and bearer expiry are rechecked', async () => {
  assert.deepEqual(await decision('media_stop', { authority: authority({ subject: 'other-subject' }) }), { accepted: false, reason: 'T03_SUBJECT_MISMATCH' });
  assert.deepEqual(await decision('media_stop', { authority: authority({ user_id: 'other-user' }) }), { accepted: false, reason: 'T03_USER_MISMATCH' });
  const capabilityRuntime = harness({ authority: authority({ capability_ref: 'capability-1' }) }).runtime;
  const capabilityResult = await capabilityRuntime.evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: { ...BEARER, capabilityRef: 'capability-2' } });
  assert.deepEqual(capabilityResult, { accepted: false, reason: 'T03_CAPABILITY_MISMATCH' });
  const scopeRuntime = harness({ authority: authority({ scopes: ['audio'] }) }).runtime;
  const scopeResult = await scopeRuntime.evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: { ...BEARER, scopes: ['video'] } });
  assert.deepEqual(scopeResult, { accepted: false, reason: 'T03_CAPABILITY_MISMATCH' });
  const expiredBearer = await harness().runtime.evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: { ...BEARER, expiresAt: NOW } });
  assert.deepEqual(expiredBearer, { accepted: false, reason: 'T03_BEARER_EXPIRED' });
});

test('bootstrap mode binding shape is fail-closed', async () => {
  assert.deepEqual(await decision('bootstrap', {}, { continuity_id: 'continuity-1' }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.deepEqual(await decision('bootstrap', {}, { bootstrap_mode: 'fully_disconnected', continuity_id: undefined }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.deepEqual(await decision('bootstrap', {}, { bootstrap_mode: 'fully_disconnected', transport_aliases: [] }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.deepEqual(await decision('bootstrap', { binding: binding({ device_lease_ref: undefined }) }, { bootstrap_mode: 'fully_disconnected' }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.equal((await decision('bootstrap')).accepted, true);
});

test('initial bootstrap does not resolve current binding but retains authority and bearer device binding', async () => {
  const h = harness();
  const accepted = await h.runtime.evaluate({ operation: 'bootstrap', request: request('bootstrap'), bearer: BEARER });
  assert.equal(accepted.accepted, true);
  assert.equal(h.bindingInputs.length, 0);
  assert.equal(h.authorityInputs.length, 1);

  const requestMismatch = await harness().runtime.evaluate({
    operation: 'bootstrap',
    request: request('bootstrap', { device_id: 'other-device' }),
    bearer: BEARER,
  });
  assert.deepEqual(requestMismatch, { accepted: false, reason: 'T03_BEARER_DEVICE_MISMATCH' });

  const authorityMismatch = await harness({ authority: authority({ device_credential: credential({ device_id: 'other-device' }) }) }).runtime.evaluate({
    operation: 'bootstrap',
    request: request('bootstrap'),
    bearer: BEARER,
  });
  assert.deepEqual(authorityMismatch, { accepted: false, reason: 'T03_BEARER_DEVICE_MISMATCH' });

  const authorityDeviceMissing = await harness({ authority: authority({ device_credential: credential({ device_id: undefined }) }) }).runtime.evaluate({
    operation: 'bootstrap',
    request: request('bootstrap'),
    bearer: BEARER,
  });
  assert.deepEqual(authorityDeviceMissing, { accepted: false, reason: 'T03_BINDING_MISMATCH' });
});

test('bootstrap ignores recipient credential linkage from a prior session while E2EE still rejects it', async () => {
  const priorSession = Object.freeze({ ...SESSION, ref_id: 'prior-session-1' });
  const priorLease = Object.freeze({ ...LEASE, ref_id: 'prior-lease-1' });
  const staleAuthority = authority({
    device_credential: credential({
      realtime_session_ref: priorSession,
      device_lease_ref: priorLease,
      continuity_id: 'prior-continuity-1',
    }),
  });
  const fullyDisconnected = {
    bootstrap_mode: 'fully_disconnected',
    continuity_id: 'continuity-1',
    transport_aliases: ['room-1', 'participant-1'],
  };
  const bootstrapResult = await decision('bootstrap', { authority: staleAuthority }, fullyDisconnected);
  assert.equal(bootstrapResult.accepted, true);
  const e2eeResult = await decision('realtime_e2ee_key_resolve', { authority: staleAuthority });
  assert.deepEqual(e2eeResult, { accepted: false, reason: 'T03_LINKAGE_MISMATCH' });
});

test('binding state matrix follows operation and bootstrap mode semantics', async () => {
  for (const status of ['active', 'connected', 'bound'] as const) {
    for (const operation of ['bootstrap', 'connected_credential_refresh', 'realtime_e2ee_key_resolve'] as const) {
      const result = await decision(operation, { binding: binding({ status }) });
      assert.equal(result.accepted, true, `${operation}:${status}`);
    }
  }
  const fullyDisconnected = await decision('bootstrap', { binding: binding({ status: 'disconnected' }) }, {
    bootstrap_mode: 'fully_disconnected',
    continuity_id: 'continuity-1',
    transport_aliases: ['room-1', 'participant-1'],
  });
  assert.equal(fullyDisconnected.accepted, true);
  for (const status of ['released', 'unknown'] as const) {
    const result = await decision('bootstrap', { binding: binding({ status }) }, {
      bootstrap_mode: 'fully_disconnected',
      continuity_id: 'continuity-1',
      transport_aliases: ['room-1', 'participant-1'],
    });
    assert.deepEqual(result, { accepted: false, reason: 'T03_BINDING_INVALID' }, `fully_disconnected:${status}`);
  }
  for (const status of ['connected', 'disconnected'] as const) {
    assert.equal((await decision('media_stop', { binding: binding({ status }) })).accepted, true, `media_stop:${status}`);
  }
  assert.deepEqual(await decision('media_stop', { binding: binding({ status: 'released' }) }), { accepted: false, reason: 'T03_BINDING_INVALID' });
  for (const status of ['connected', 'disconnected', 'released'] as const) {
    assert.equal((await decision('end_continuity', { binding: binding({ status }) })).accepted, true, `end_continuity:${status}`);
  }
  assert.deepEqual(await decision('end_continuity', { binding: binding({ status: 'unknown' }) }), { accepted: false, reason: 'T03_BINDING_INVALID' });
});

test('handoff requires a connected current binding state', async () => {
  assert.equal((await decision('handoff', { binding: binding({ status: 'connected' }) })).accepted, true);
  for (const status of ['active', 'bound', 'disconnected', 'released', 'unknown'] as const) {
    assert.deepEqual(await decision('handoff', { binding: binding({ status }) }), { accepted: false, reason: 'T03_BINDING_INVALID' }, status);
  }
});

test('governance minimum canonical refs are required by operation', async () => {
  const nonE2eeMinimum = { purpose_scopes: ['realtime_assistant'], policy_decision_refs: ['policy-1'], capability_grant_refs: ['grant-1'] };
  assert.equal((await decision('media_stop', {}, { governance: nonE2eeMinimum })).accepted, true);
  for (const key of ['purpose_scopes', 'policy_decision_refs', 'capability_grant_refs'] as const) {
    const missing = { ...nonE2eeMinimum, [key]: [] };
    assert.deepEqual(await decision('media_stop', {}, { governance: missing }), { accepted: false, reason: 'T03_GOVERNANCE_INVALID' }, key);
  }
  for (const key of ['consent_record_refs', 'purpose_token_refs'] as const) {
    const missing = { ...GOVERNANCE, [key]: [] };
    assert.deepEqual(await decision('realtime_e2ee_key_resolve', {}, { governance: missing }), { accepted: false, reason: 'T03_GOVERNANCE_INVALID' }, key);
  }
});

test('nested current DeviceCredential and lease lifecycle state rejects every supported operation', async () => {
  const operations: readonly RealtimeOperation[] = ['bootstrap', 'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff', 'realtime_e2ee_key_resolve'];
  const bindingOperations = operations.filter((operation) => operation !== 'bootstrap');
  const credentialStates: readonly [JsonRecord, string][] = [
    [{ revocation: { status: 'revoked' } }, 'T03_AUTHORITY_REVOKED'],
    [{ supersession: { status: 'superseded' } }, 'T03_AUTHORITY_SUPERSEDED'],
    [{ deletion: { status: 'deleted' } }, 'T03_AUTHORITY_DELETED'],
    [{ expires_at: NOW }, 'T03_AUTHORITY_EXPIRED'],
  ];
  for (const [state, reason] of credentialStates) {
    for (const operation of operations) {
      assert.deepEqual(await decision(operation, { authority: authority({ device_credential: credential(state) }) }), { accepted: false, reason }, `${operation}:${reason}`);
    }
  }
  for (const operation of bindingOperations) {
    assert.deepEqual(await decision(operation, { binding: binding({ lease: { status: 'revoked' } }) }), { accepted: false, reason: 'T03_AUTHORITY_REVOKED' }, `${operation}:lease`);
  }
});

test('bearer, binding, audience, credential, and linkage mismatches fail closed', async () => {
  const bearerMismatch = await harness().runtime.evaluate({ operation: 'media_stop', request: request('media_stop'), bearer: { ...BEARER, deviceId: 'other-device' } });
  assert.deepEqual(bearerMismatch, { accepted: false, reason: 'T03_BEARER_DEVICE_MISMATCH' });
  assert.deepEqual(await decision('media_stop', { binding: binding({ connection_epoch: '2' }) }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.deepEqual(await decision('realtime_e2ee_key_resolve', {}, { participant_audience: 'other-audience' }), { accepted: false, reason: 'T03_AUDIENCE_MISMATCH' });
  assert.deepEqual(await decision('realtime_e2ee_key_resolve', {}, { recipient_device_credential_ref: { ...CREDENTIAL, object_version: '2' } }), { accepted: false, reason: 'T03_LINKAGE_MISMATCH' });
  assert.deepEqual(await decision('realtime_e2ee_key_resolve', { authority: authority({ device_credential: credential({ continuity_id: 'other-continuity' }) }) }), { accepted: false, reason: 'T03_LINKAGE_MISMATCH' });
});

test('handoff binds the current session, lease, continuity, epoch, and from-device to the bearer', async () => {
  const cases: readonly [JsonRecord, string][] = [
    [{ realtime_session_ref: { ...SESSION, object_version: '2' } }, 'T03_BINDING_MISMATCH'],
    [{ current_device_lease_ref: { ...LEASE, object_version: '2' } }, 'T03_BINDING_MISMATCH'],
    [{ continuity_id: 'other-continuity' }, 'T03_BINDING_MISMATCH'],
    [{ connection_epoch: '2' }, 'T03_BINDING_MISMATCH'],
    [{ from_device_id: 'other-device' }, 'T03_BEARER_DEVICE_MISMATCH'],
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(await decision('handoff', {}, overrides), { accepted: false, reason });
  }
  assert.deepEqual(await decision('handoff', { binding: binding({ realtime_session_ref: { ...SESSION, object_version: '2' } }) }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.deepEqual(await decision('handoff', { binding: binding({ device_lease_ref: { ...LEASE, object_version: '2' } }) }), { accepted: false, reason: 'T03_BINDING_MISMATCH' });
  assert.deepEqual(await decision('handoff', { binding: binding({ device_id: 'other-device' }) }), { accepted: false, reason: 'T03_BEARER_DEVICE_MISMATCH' });
});

test('handoff rejects current credential and lease revocation, expiry, supersession, deletion, and unknown state', async () => {
  const credentialStates: readonly [JsonRecord, string][] = [
    [{ revocation: { status: 'revoked' } }, 'T03_AUTHORITY_REVOKED'],
    [{ supersession: { status: 'superseded' } }, 'T03_AUTHORITY_SUPERSEDED'],
    [{ deletion: { status: 'deleted' } }, 'T03_AUTHORITY_DELETED'],
    [{ expires_at: NOW }, 'T03_AUTHORITY_EXPIRED'],
  ];
  for (const [state, reason] of credentialStates) {
    assert.deepEqual(await decision('handoff', { authority: authority({ device_credential: credential(state) }) }), { accepted: false, reason });
  }
  const leaseStates: readonly [JsonRecord, string][] = [
    [{ status: 'revoked' }, 'T03_AUTHORITY_REVOKED'],
    [{ status: 'superseded' }, 'T03_AUTHORITY_SUPERSEDED'],
    [{ status: 'deleted' }, 'T03_AUTHORITY_DELETED'],
    [{ expires_at: NOW }, 'T03_AUTHORITY_EXPIRED'],
  ];
  for (const [state, reason] of leaseStates) {
    assert.deepEqual(await decision('handoff', { binding: binding({ lease: state }) }), { accepted: false, reason });
  }
});

test('X25519 projection returns raw 32-byte base64url key and SHA-256 fingerprint with all linkage', () => {
  const result = projectT03RecipientX25519PublicKey(credential());
  assert.deepEqual(result.deviceCredentialRef, CREDENTIAL);
  assert.equal(result.publicKeyAlgorithm, 'X25519');
  assert.equal(result.publicKeyPurpose, 'hpke_recipient');
  assert.equal(result.publicKeyEncoding, 'base64url-unpadded');
  assert.equal(result.publicKey, PUBLIC_KEY);
  assert.equal(result.publicKeySha256, PUBLIC_KEY_SHA256);
  assert.equal(result.audience, AUDIENCE);
  assert.equal(result.deviceId, DEVICE);
  assert.deepEqual(result.realtimeSessionRef, SESSION);
  assert.deepEqual(result.deviceLeaseRef, LEASE);
  assert.equal(result.continuityId, 'continuity-1');
  assert.equal(result.expiresAt, EXPIRES);
  assert.deepEqual(result.revocation, { status: 'active' });
  assert.equal(result.supersession, null);
  assert.equal(result.deletion, null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.fingerprintSha256, PUBLIC_KEY_SHA256);
});

test('P-256, private, plaintext, content-key, and secret shapes are rejected', () => {
  const bad: readonly JsonRecord[] = [
    credential({ algorithm: 'P-256' }),
    credential({ curve: 'secp256r1' }),
    credential({ private_key: PUBLIC_KEY }),
    credential({ plaintext: 'not-a-key' }),
    credential({ content_key: PUBLIC_KEY }),
    credential({ secret: 'not-a-key' }),
    credential({ public_key: `${PUBLIC_KEY}=` }),
    credential({ public_key: Buffer.alloc(31).toString('base64url') }),
    credential({ algorithm: undefined }),
    credential({ purpose: undefined }),
    credential({ device_credential_ref: undefined }),
    credential({ expires_at: undefined }),
    credential({ revocation: undefined }),
    credential({ supersession: undefined }),
    credential({ deletion: undefined }),
    credential({ purpose: 'signing' }),
  ];
  for (const candidate of bad) assert.throws(() => projectT03RecipientX25519PublicKey(candidate), /T03_RECIPIENT_INVALID/);
});

test('recipient DeviceCredential ref must be a canonical snake-case versioned object', () => {
  const badRefs: readonly JsonRecord[] = [
    credential({ device_credential_ref: 'credential-1' }),
    credential({ device_credential_ref: { ref_id: 'credential-1', object_version: '1' } }),
    credential({ device_credential_ref: { ref_type: 'DeviceCredential', object_version: '1' } }),
    credential({ device_credential_ref: { ref_type: 'DeviceCredential', ref_id: 'credential-1' } }),
    credential({ device_credential_ref: { ref_type: 'DeviceCredential', ref_id: 'credential-1', object_version: '0' } }),
    credential({ device_credential_ref: { ref_type: 'DeviceCredential', ref_id: 'credential-1', object_version: '01' } }),
  ];
  for (const candidate of badRefs) assert.throws(() => projectT03RecipientX25519PublicKey(candidate), /T03_RECIPIENT_INVALID/);
  assert.deepEqual(projectT03RecipientX25519PublicKey(credential()).deviceCredentialRef, CREDENTIAL);
});

test('E2EE recipient port receives only the injected current reference and accepted governance has no extra owner fields', async () => {
  const h = harness();
  const result = await h.runtime.evaluate({ operation: 'realtime_e2ee_key_resolve', request: request('realtime_e2ee_key_resolve'), bearer: BEARER });
  assert.equal(result.accepted, true);
  assert.deepEqual((h.recipientInputs[0] as JsonRecord).deviceCredentialRef, CREDENTIAL);
  assert.deepEqual(Object.keys(result).sort(), ['accepted', 'refs']);
});
