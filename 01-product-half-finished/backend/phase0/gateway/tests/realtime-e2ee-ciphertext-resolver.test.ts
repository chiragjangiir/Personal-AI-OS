import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  REALTIME_E2EE_CIPHER_SUITE,
  RealtimeE2eeCiphertextResolver,
  type ContentKeyLease,
  type DurableReplayClaim,
  type RealtimeE2eeDurableReplayPort,
  type RealtimeE2eeRequestValidatorPort,
  type RealtimeE2eeTerminalValidatorPort,
  type RecipientCredentialResolution,
  type RecipientCredentialPort,
} from '../src/realtime-e2ee-ciphertext-resolver.ts';
import type { JsonRecord } from '../src/realtime-public-control-runtime.ts';

const require = createRequire(import.meta.url);
const { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } = require('@hpke/core') as any;

const INFO_B64 = 'UEFJT1MtUlQtSFBLRS1JTkZPACBwYWlvcy1yZWFsdGltZS1lMmVlLWhwa2UtZnJhbWluZwANcmVhbHRpbWUvZTJlZQAFMS4wLjAAIAABAAIAABlyZWFsdGltZV9lMmVlX2tleV9yZXNvbHZlAA9SZWFsdGltZVNlc3Npb24Bjw4OAABwAIAAAAAAAAABAAExEREREREREREREREREREREREREREREREREREREREREREAC0RldmljZUxlYXNlAY8ODgAAcACAAAAAAAAAAgABMiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiAY8ODgAAcACAAAAAAAAAAwABNwAMa2V5X2VudmVsb3BlAAVwYWlvcwAHZW52LTAwMQAAATAAATEBjw4OAABwAIAAAAAAAAAEABBEZXZpY2VDcmVkZW50aWFsAY8ODgAAcACAAAAAAAAABgABMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzAAtwYXJ0aWNpcGFudAAFcGFpb3MAB2F1ZC0wMDEA';
const AAD_B64 = 'UEFJT1MtUlQtSFBLRS1BQUQAIHBhaW9zLXJlYWx0aW1lLWUyZWUtaHBrZS1mcmFtaW5nAA1yZWFsdGltZS9lMmVlAAUxLjAuMAAgAAEAAgAANERIS0VNKFgyNTUxOSwgSEtERi1TSEEyNTYpLCBIS0RGLVNIQTI1NiwgQUVTLTI1Ni1HQ00AGXJlYWx0aW1lX2UyZWVfa2V5X3Jlc29sdmUADGtleV9yZXNvbHZlZAARcmVxLXRlc3QtMDAwMDAwMDEABFQxMUIAGXJlYWx0aW1lX2UyZWVfa2V5X3Jlc29sdmUAD1JlYWx0aW1lU2Vzc2lvbgAAAAASaWRlbS10ZXN0LTAwMDAwMDAxAGBodHRwczovL3BlcnNvbmFsLWFpLW9zLmxvY2FsL2NvbnRyYWN0cy9yZWFsdGltZS9yZWFsdGltZS1lMmVlLWtleS1yZXNvbHZlLXJlcXVlc3QudjEuc2NoZW1hLmpzb24ABTEuMC4wRERERERERERERERERERERERERERERERERERERERERERVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQAPUmVhbHRpbWVTZXNzaW9uAY8ODgAAcACAAAAAAAAAAQABMRERERERERERERERERERERERERERERERERERERERERERAAtEZXZpY2VMZWFzZQGPDg4AAHAAgAAAAAAAAAIAATIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIgGPDg4AAHAAgAAAAAAAAAMAATcAAQAEcm9vbQANdGVzdF9wcm92aWRlcgAIcm9vbS0wMDEAAAxrZXlfZW52ZWxvcGUABXBhaW9zAAdlbnYtMDAxAAABMAABMQGPDg4AAHAAgAAAAAAAAAQAEERldmljZUNyZWRlbnRpYWwBjw4OAABwAIAAAAAAAAAGAAEzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMAC3BhcnRpY2lwYW50AAVwYWlvcwAHYXVkLTAwMQAAGDIwMjYtMDgtMjNUMTI6MDA6MDAuMDAwWgABAA5yZWFsdGltZV9hdWRpbwABAY8ODgAAcACAAAAAAAAABwABAY8ODgAAcACAAAAAAAAACAABAY8ODgAAcACAAAAAAAAACQABAY8ODgAAcACAAAAAAAAACg';
// Keep the test projection tied to the frozen RFC line; the embedded copy above is
// retained as a readable fixture and this insertion restores its missing MzMz segment.
const AAD_B64_RFC = `${AAD_B64.slice(0, 984)}MzMz${AAD_B64.slice(984)}`;
const CONTENT_KEY = hex('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
const RECIPIENT_PUBLIC = hex('8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f');
const RECIPIENT_PRIVATE = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const PLAINTEXT = hex('5041494f534b45590001000130000131a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
const DEVICE = '018f0e0e-0000-7000-8000-000000000004';
const GOVERNANCE = {
  purpose_scopes: ['realtime_audio'],
  consent_record_refs: ['018f0e0e-0000-7000-8000-000000000007'],
  policy_decision_refs: ['018f0e0e-0000-7000-8000-000000000008'],
  purpose_token_refs: ['018f0e0e-0000-7000-8000-000000000009'],
  capability_grant_refs: ['018f0e0e-0000-7000-8000-00000000000a'],
};
const REQUEST: JsonRecord = {
  operation: 'realtime_e2ee_key_resolve',
  request_id: 'req-test-00000001',
  idempotency_context: {
    idempotency_scope: { owner_module: 'T11B', operation_kind: 'realtime_e2ee_key_resolve', target_object_type: 'RealtimeSession' },
    idempotency_key: 'idem-test-00000001',
    idempotency_profile_id: 'https://personal-ai-os.local/contracts/realtime/realtime-e2ee-key-resolve-request.v1.schema.json',
    idempotency_profile_version: '1.0.0',
    idempotency_profile_sha256: '4'.repeat(64),
    idempotency_request_sha256: '5'.repeat(64),
  },
  realtime_session_ref: { ref_type: 'RealtimeSession', ref_id: '018f0e0e-0000-7000-8000-000000000001', object_version: '1', canonical_payload_sha256: '1'.repeat(64) },
  device_lease_ref: { ref_type: 'DeviceLease', ref_id: '018f0e0e-0000-7000-8000-000000000002', object_version: '2', canonical_payload_sha256: '2'.repeat(64) },
  continuity_id: '018f0e0e-0000-7000-8000-000000000003',
  connection_epoch: '7',
  transport_aliases: [{ alias_type: 'room', issuer: 'test_provider', value: 'room-001' }],
  key_envelope_ref: { alias_type: 'key_envelope', issuer: 'paios', value: 'env-001' },
  key_index: 0,
  key_generation: '1',
  device_id: DEVICE,
  recipient_device_credential_ref: { ref_type: 'DeviceCredential', ref_id: '018f0e0e-0000-7000-8000-000000000006', object_version: '3', canonical_payload_sha256: '3'.repeat(64) },
  participant_audience: { alias_type: 'participant', issuer: 'paios', value: 'aud-001' },
  governance: GOVERNANCE,
};

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu)!.map((part) => Number.parseInt(part, 16)));
}

function b64url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function replaceSequence(value: Uint8Array, expected: readonly number[], replacement: readonly number[]): Uint8Array {
  let found = -1;
  for (let index = 0; index <= value.length - expected.length; index += 1) {
    if (expected.every((byte, offset) => value[index + offset] === byte)) {
      assert.equal(found, -1, 'fixture mutation must identify one exact sequence');
      found = index;
    }
  }
  assert.notEqual(found, -1);
  return Uint8Array.from([...value.slice(0, found), ...replacement, ...value.slice(found + expected.length)]);
}

function replaceAt(value: Uint8Array, offset: number, length: number, replacement: readonly number[]): Uint8Array {
  return Uint8Array.from([...value.slice(0, offset), ...replacement, ...value.slice(offset + length)]);
}

class ReplayStore implements RealtimeE2eeDurableReplayPort {
  readonly records = new Map<string, { fingerprint: string; response: JsonRecord }>();
  claims = 0;
  commits = 0;
  releases = 0;

  async claim(input: { request: JsonRecord; idempotencyContext: JsonRecord; fingerprint: string }): Promise<DurableReplayClaim> {
    this.claims += 1;
    const key = String(input.idempotencyContext.idempotency_key);
    const existing = this.records.get(key);
    if (existing === undefined) return { disposition: 'claimed', claimId: key };
    if (existing.fingerprint !== input.fingerprint) return { disposition: 'conflict' };
    return { disposition: 'replay', response: existing.response };
  }

  async commit(input: { claimId: string; fingerprint: string; response: JsonRecord }): Promise<void> {
    this.commits += 1;
    this.records.set(input.claimId, { fingerprint: input.fingerprint, response: input.response });
  }

  async release(input: { claimId: string; fingerprint: string }): Promise<void> {
    this.releases += 1;
    const existing = this.records.get(input.claimId);
    if (existing?.fingerprint === input.fingerprint) this.records.delete(input.claimId);
  }
}

function makeResolver(overrides: {
  readonly replay?: ReplayStore;
  readonly credential?: Partial<RecipientCredentialResolution>;
  readonly lease?: Partial<ContentKeyLease>;
  readonly requestValidator?: RealtimeE2eeRequestValidatorPort;
  readonly terminalValidator?: RealtimeE2eeTerminalValidatorPort;
  readonly key?: Uint8Array;
  readonly keyCallback?: (key: Uint8Array) => Promise<unknown> | unknown;
  readonly now?: () => number;
} = {}) {
  const replay = overrides.replay ?? new ReplayStore();
  let leaseCalls = 0;
  let credentialCalls = 0;
  const credential: RecipientCredentialPort = {
    async resolve() {
      credentialCalls += 1;
      return {
        publicKey: RECIPIENT_PUBLIC,
        status: 'active',
        expiresAt: '2026-08-23T12:00:00.000Z',
        deviceId: DEVICE,
        credentialRef: REQUEST.recipient_device_credential_ref as JsonRecord,
        ...overrides.credential,
      };
    },
  };
  const lease: ContentKeyLease = {
    expiresAt: '2026-08-23T12:00:00.000Z',
    status: 'active',
    keyIndex: 0,
    keyGeneration: '1',
    binding: {
      realtime_session_ref: REQUEST.realtime_session_ref,
      device_lease_ref: REQUEST.device_lease_ref,
      continuity_id: REQUEST.continuity_id,
      connection_epoch: REQUEST.connection_epoch,
      key_envelope_ref: REQUEST.key_envelope_ref,
      participant_audience: REQUEST.participant_audience,
      governance: REQUEST.governance,
    },
    ...overrides.lease,
    async withKey<T>(callback: (key: Uint8Array) => Promise<T> | T): Promise<T> {
      leaseCalls += 1;
      const key = overrides.key ?? new Uint8Array(CONTENT_KEY);
      if (overrides.keyCallback !== undefined) await overrides.keyCallback(key);
      return await callback(key);
    },
  };
  const resolver = new RealtimeE2eeCiphertextResolver({
    recipientCredential: credential,
    contentKey: { async lease() { return lease; } },
    replay,
    requestValidator: overrides.requestValidator ?? requestValidator,
    terminalValidator: overrides.terminalValidator ?? terminalValidator,
    now: overrides.now ?? (() => Date.parse('2026-08-23T11:00:00.000Z')),
  });
  return { resolver, replay, lease, get leaseCalls() { return leaseCalls; }, get credentialCalls() { return credentialCalls; } };
}

const BEARER = { principal: 'test-principal', deviceId: DEVICE };

function terminalResult(status: 'expired' | 'revoked' | 'indeterminate'): JsonRecord {
  return {
    operation: 'realtime_e2ee_key_resolve',
    status,
    request_id: REQUEST.request_id,
    realtime_session_ref: REQUEST.realtime_session_ref,
    device_lease_ref: REQUEST.device_lease_ref,
    continuity_id: REQUEST.continuity_id,
    connection_epoch: REQUEST.connection_epoch,
    operation_outcome: {
      outcome_class: 'indeterminate',
      error: { error_family: 'state', error_code: 'state.e2ee_terminal', retry_class: 'never', trace_id: '018f0e0e-0000-7000-8000-000000000011', occurred_at: '2026-08-23T11:00:00.000Z' },
    },
    execution_facts: { closure_status: 'not_applicable' },
    governance: REQUEST.governance,
  };
}

const requestValidator: RealtimeE2eeRequestValidatorPort = {
  validateRequest(operation, request) {
    assert.equal(operation, 'realtime_e2ee_key_resolve');
    const value = request as JsonRecord;
    const context = value.idempotency_context as JsonRecord;
    const profileId = context.idempotency_profile_id;
    const profileVersion = context.idempotency_profile_version;
    assert.equal(typeof profileId, 'string');
    assert.match(profileId as string, /^https:\/\/[^\s]+$/u);
    assert.equal(typeof profileVersion, 'string');
    assert.match(profileVersion as string, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u);
  },
};

const terminalValidator: RealtimeE2eeTerminalValidatorPort = {
  validate(input) {
    const result = input.result;
    assert.equal(input.operation, 'realtime_e2ee_key_resolve');
    assert.ok(['expired', 'revoked', 'indeterminate'].includes(String(input.status)));
    const allowed = new Set(['operation', 'status', 'request_id', 'realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch', 'operation_outcome', 'execution_facts', 'governance']);
    assert.deepEqual(Object.keys(result).sort(), [...allowed].sort());
    const outcome = result.operation_outcome as JsonRecord;
    assert.ok(['pre_claim_rejection', 'rollback_no_commit', 'committed_rejection', 'committed_success', 'indeterminate'].includes(String(outcome.outcome_class)));
    const facts = result.execution_facts as JsonRecord;
    assert.deepEqual(Object.keys(facts), ['closure_status']);
    assert.ok(['not_applicable', 'verified_closed', 'failed', 'indeterminate'].includes(String(facts.closure_status)));
  },
};

test('RFC-009 positive resolve is ciphertext-only and decrypts to the exact frame', async () => {
  const fixture = makeResolver();
  const response = await fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  assert.equal(response.operation, 'realtime_e2ee_key_resolve');
  assert.equal(response.status, 'key_resolved');
  assert.equal(response.cipher_suite, REALTIME_E2EE_CIPHER_SUITE);
  assert.equal(response.aad_sha256, '5dcb52c670cc00be562f9ab41fb2ae14c2e89253a435d2a0569f64635a23fc9b');
  assert.equal(String(response.encapsulated_key).length, 43);
  assert.equal(String(response.ciphertext).length, 86);
  for (const key of ['plaintext', 'content_key', 'private_key', 'roomOptions']) assert.equal(Object.hasOwn(response, key), false);

  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const recipientKey = await suite.kem.deserializePrivateKey(RECIPIENT_PRIVATE);
  const opened = await suite.open({ recipientKey, enc: b64url(String(response.encapsulated_key)), info: b64url(INFO_B64) }, b64url(String(response.ciphertext)), b64url(AAD_B64_RFC));
  assert.deepEqual(new Uint8Array(opened), PLAINTEXT);
  assert.equal(fixture.replay.claims, 1);
  assert.equal(fixture.replay.commits, 1);
});

test('RFC-009 deterministic cross-end vector opens exactly and all four negative projections hash as frozen', async () => {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const recipientKey = await suite.kem.deserializePrivateKey(RECIPIENT_PRIVATE);
  const opened = await suite.open(
    { recipientKey, enc: hex('358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254'), info: b64url(INFO_B64) },
    hex('f34a71ee2caa4b25bd686e079bea8fd3b9fd24855f73c91fcdb96ba5121da387b7fe6d7790478ff3ac54396fc8eaf0d4171e7500e3f06b8cacf2330b7fd535d2'),
    b64url(AAD_B64_RFC),
  );
  assert.deepEqual(new Uint8Array(opened), PLAINTEXT);

  const info = b64url(INFO_B64);
  const aad = b64url(AAD_B64_RFC);
  const keyOrder = [0x00, 0x01, 0x30, 0x00, 0x01, 0x31];
  const keyOrderMutated = [0x00, 0x01, 0x31, 0x00, 0x01, 0x30];
  assert.equal(sha256(replaceSequence(info, keyOrder, keyOrderMutated)), 'cddfc5d05710ed6cf57a84ef8989cb2caa5cf89be1bbce81afcc502f33761a25');
  assert.equal(sha256(replaceSequence(aad, keyOrder, keyOrderMutated)), '3c99524f0a66e3cb5f7482435813419cc81802afa608229192aa39a01b944f1d');
  assert.equal(replaceSequence(info, [0x00, 0x01, 0x30], new Array(8).fill(0)).length, 416);
  assert.equal(sha256(replaceSequence(info, [0x00, 0x01, 0x30], new Array(8).fill(0))), 'b8f0e84831d6c8475c7595d49c54cadb4c5d0365770bb0dd061202917f8da9b4');
  assert.equal(sha256(replaceSequence(aad, [0x00, 0x01, 0x30], new Array(8).fill(0))), 'c81df0237c3c2767189774070b09ed81b9dbf14e1913927fd11ae11003d8ff1e');
  assert.equal(sha256(replaceAt(info, 67, 7, [0x00, 0x05, 0x31, 0x2e, 0x30, 0x2e, 0x31])), 'e4a15d8d972d38ed5b2953b2d2a589e398cdcc38c480cb97d0a7bcf4f63a560c');
  assert.equal(sha256(replaceAt(aad, 66, 7, [0x00, 0x05, 0x31, 0x2e, 0x30, 0x2e, 0x31])), '5ee1f0d73cbf0d6d46a5657c3c11ffa9f2d8b880f30d699ec017eacd76017bef');
  const generationMismatch = replaceSequence(PLAINTEXT, [0x00, 0x01, 0x31], [0x00, 0x01, 0x32]);
  assert.equal(sha256(generationMismatch), 'edc8daf95d8fd28c64ba7ca018fb46c67c2fd42e9f685b61a61c4308c70ee362');
});

test('RFC-009 key field order, decimal, and profile bindings fail closed', async () => {
  const profileDriftRequest = { ...REQUEST, idempotency_context: { ...(REQUEST.idempotency_context as JsonRecord), idempotency_profile_version: '1.0.1' } };
  assert.equal((profileDriftRequest.idempotency_context as JsonRecord).idempotency_profile_version, '1.0.1');
  const idempotencyFixture = makeResolver();
  await idempotencyFixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  await assert.rejects(idempotencyFixture.resolver.resolve({ request: profileDriftRequest, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_IDEMPOTENCY_CONFLICT/);
  const idDriftRequest = { ...REQUEST, idempotency_context: { ...(REQUEST.idempotency_context as JsonRecord), idempotency_profile_id: 'https://personal-ai-os.local/contracts/realtime/other-request.v1.schema.json' } };
  await assert.rejects(idempotencyFixture.resolver.resolve({ request: idDriftRequest, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_IDEMPOTENCY_CONFLICT/);
  const invalidUriRequest = { ...REQUEST, idempotency_context: { ...(REQUEST.idempotency_context as JsonRecord), idempotency_profile_id: 'not-a-uri' } };
  await assert.rejects(makeResolver().resolver.resolve({ request: invalidUriRequest, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_REQUEST_SCHEMA_INVALID/);
  const invalidSemVerRequest = { ...REQUEST, idempotency_context: { ...(REQUEST.idempotency_context as JsonRecord), idempotency_profile_version: '01.0.0' } };
  await assert.rejects(makeResolver().resolver.resolve({ request: invalidSemVerRequest, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_REQUEST_SCHEMA_INVALID/);
  const reordered = { ...REQUEST, transport_aliases: [{ alias_type: 'z_room', issuer: 'test_provider', value: 'room-002' }, { alias_type: 'a_room', issuer: 'test_provider', value: 'room-001' }] };
  await assert.rejects(makeResolver().resolver.resolve({ request: reordered, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_TRANSPORT_ALIASES_INVALID_ORDER/);
  await assert.rejects(makeResolver().resolver.resolve({ request: { ...REQUEST, key_index: '0' }, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_KEY_INDEX_INVALID/);
  await assert.rejects(makeResolver().resolver.resolve({ request: { ...REQUEST, idempotency_context: { ...(REQUEST.idempotency_context as JsonRecord), profile_drift: true } }, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID/);
  await assert.rejects(makeResolver().resolver.resolve({ request: { ...REQUEST, connection_epoch: '07' }, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_EPOCH_INVALID/);
});

test('tampered ciphertext and wrong recipient cannot open the response', async () => {
  const response = await makeResolver().resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const wrong = await suite.kem.deserializePrivateKey(hex('101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f'));
  await assert.rejects(suite.open({ recipientKey: wrong, enc: b64url(String(response.encapsulated_key)), info: b64url(INFO_B64) }, b64url(String(response.ciphertext)), b64url(AAD_B64_RFC)));
  const tampered = b64url(String(response.ciphertext));
  tampered[0]! ^= 1;
  const recipient = await suite.kem.deserializePrivateKey(RECIPIENT_PRIVATE);
  await assert.rejects(suite.open({ recipientKey: recipient, enc: b64url(String(response.encapsulated_key)), info: b64url(INFO_B64) }, tampered, b64url(AAD_B64_RFC)));
});

test('expired, revoked, and indeterminate owner outcomes never contain ciphertext', async () => {
  for (const status of ['expired', 'revoked', 'indeterminate'] as const) {
    const fixture = makeResolver({ credential: { status, terminalResult: terminalResult(status) } });
    const response = await fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
    assert.equal(response.status, status);
    assert.equal(response.operation, 'realtime_e2ee_key_resolve');
    assert.equal(response.request_id, REQUEST.request_id);
    assert.equal((response.operation_outcome as JsonRecord).outcome_class, 'indeterminate');
    assert.equal((response.execution_facts as JsonRecord).closure_status, 'not_applicable');
    assert.deepEqual(response.governance, GOVERNANCE);
    assert.equal(Object.hasOwn(response, 'ciphertext'), false);
    assert.equal(Object.hasOwn(response, 'encapsulated_key'), false);
    assert.equal(fixture.leaseCalls, 0);
  }
});

test('terminal validator gates invalid owner and replay outcomes before durable commit/return', async () => {
  const invalidOutcome = { ...terminalResult('revoked'), operation_outcome: { outcome_class: 'not-a-canonical-outcome' } };
  const outcomeFixture = makeResolver({ credential: { status: 'revoked', terminalResult: invalidOutcome } });
  await assert.rejects(outcomeFixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_TERMINAL_SCHEMA_INVALID/);
  assert.equal(outcomeFixture.replay.commits, 0);
  assert.equal(outcomeFixture.replay.releases, 1);

  const invalidFacts = { ...terminalResult('revoked'), execution_facts: { closure_status: 'not_applicable', extra: true } };
  const factsFixture = makeResolver({ credential: { status: 'revoked', terminalResult: invalidFacts } });
  await assert.rejects(factsFixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_TERMINAL_SCHEMA_INVALID/);
  assert.equal(factsFixture.replay.commits, 0);

  const replayFixture = makeResolver({ credential: { status: 'revoked', terminalResult: terminalResult('revoked') } });
  await replayFixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  const stored = replayFixture.replay.records.get('idem-test-00000001')!;
  stored.response = { ...stored.response, operation_outcome: { outcome_class: 'not-a-canonical-outcome' } };
  await assert.rejects(replayFixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_TERMINAL_SCHEMA_INVALID/);
  assert.equal(replayFixture.replay.commits, 1);
});

test('partial authority, raw-key shape, binding drift, and nested secret inputs fail closed', async () => {
  const minimalOptions = {
    recipientCredential: { async resolve() { return undefined; } },
    contentKey: { async lease() { return undefined; } },
    replay: new ReplayStore(),
    requestValidator,
    terminalValidator,
  };
  const topLevelSecret = 'top-level-secret-do-not-echo';
  assert.throws(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, recipientPrivateKey: topLevelSecret } as never), (error: unknown) => {
    assert.match((error as Error).message, /REALTIME_E2EE_RESOLVER_OPTIONS_UNKNOWN_FIELD/);
    assert.doesNotMatch((error as Error).message, new RegExp(topLevelSecret));
    return true;
  });
  assert.throws(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, recipientCredential: { resolve() {}, secret: 'port-secret-do-not-echo' } } as never), /REALTIME_E2EE_RECIPIENT_PORT_SECRET/);
  assert.throws(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, contentKey: { lease() {}, private_key: 'port-key-do-not-echo' } } as never), /REALTIME_E2EE_CONTENT_KEY_PORT_SECRET/);
  assert.throws(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, replay: { claim() {}, commit() {}, abort() {}, keyMaterial: 'port-material-do-not-echo' } } as never), /REALTIME_E2EE_REPLAY_PORT_SECRET/);
  assert.throws(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, requestValidator: { validateRequest() {}, plaintext: 'validator-plaintext-do-not-echo' } } as never), /REALTIME_E2EE_REQUEST_VALIDATOR_SECRET/);
  assert.throws(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, terminalValidator: { validate() {}, roomOptions: 'validator-room-options-do-not-echo' } } as never), /REALTIME_E2EE_TERMINAL_VALIDATOR_SECRET/);
  const opaqueRecipient = Object.create({ resolve() { return undefined; } }) as Record<string, unknown>;
  Object.defineProperty(opaqueRecipient, 'internalState', { value: 'opaque', enumerable: false });
  assert.doesNotThrow(() => new RealtimeE2eeCiphertextResolver({ ...minimalOptions, recipientCredential: opaqueRecipient } as never));

  assert.throws(() => new RealtimeE2eeCiphertextResolver({
    recipientCredential: { async resolve() { return undefined; } },
    contentKey: { async lease() { return undefined; } },
    replay: new ReplayStore(),
  } as never), /REALTIME_E2EE_REQUEST_VALIDATOR_MISSING/);
  const missing = new RealtimeE2eeCiphertextResolver({
    recipientCredential: { async resolve() { return undefined; } },
    contentKey: { async lease() { return undefined; } },
    replay: new ReplayStore(),
    requestValidator,
    terminalValidator,
    now: () => Date.parse('2026-08-23T11:00:00.000Z'),
  });
  await assert.rejects(missing.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_RECIPIENT_CREDENTIAL_INDETERMINATE/);
  await assert.rejects(makeResolver({ credential: { publicKey: { type: 'public' } } as never }).resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_RECIPIENT_PUBLIC_KEY_INVALID|REALTIME_E2EE_RECIPIENT_CREDENTIAL_INDETERMINATE|REALTIME_E2EE_BYTES_INVALID/);
  await assert.rejects(makeResolver({ lease: { binding: undefined } as never }).resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_CONTENT_KEY_INDETERMINATE/);
  await assert.rejects(makeResolver({ credential: { privateKey: new Uint8Array(1) } as never }).resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_RECIPIENT_CREDENTIAL_SECRET/);
  await assert.rejects(makeResolver({ credential: { authorityExtra: 'unknown' } as never }).resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_RECIPIENT_CREDENTIAL_UNKNOWN_FIELD/);
  await assert.rejects(makeResolver({ lease: { authorityExtra: 'unknown' } as never }).resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_CONTENT_KEY_UNKNOWN_FIELD/);
});

test('successful replay validates canonical encoding, raw lengths, expiry, and AAD hash', async () => {
  const fixture = makeResolver();
  const response = await fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  const stored = fixture.replay.records.get('idem-test-00000001')!;
  stored.response = { ...response, encapsulated_key: 'A' };
  await assert.rejects(fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_REPLAY_LENGTH_INVALID|REALTIME_E2EE_REPLAY_ENC_INVALID/);
  stored.response = { ...response, aad_sha256: '0'.repeat(64) };
  await assert.rejects(fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_REPLAY_AAD_HASH_INVALID/);
  stored.response = { ...response, expires_at: '2026-08-23T10:00:00.000Z' };
  await assert.rejects(fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_REPLAY_ENCODING_INVALID|REALTIME_E2EE_REPLAY_EXPIRY_INVALID/);
});

test('durable replay and local single-flight deduplicate identical requests', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fixture = makeResolver({ keyCallback: async (key) => { entered.resolve(); await release.promise; key.fill(0); } });
  const first = fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  await Promise.race([entered.promise, first.then(() => assert.fail('first resolution must wait for the key callback'))]);
  const second = fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  assert.equal(fixture.replay.claims, 1);
  release.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(fixture.credentialCalls, 1);
  assert.equal(fixture.leaseCalls, 1);
  const replay = await fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(replay, left);
  assert.equal(fixture.replay.claims, 2);
});

test('conflicting in-flight idempotency clears after a failure', async () => {
  let failOnce = true;
  const fixture = makeResolver({ keyCallback: async (key) => { if (failOnce) { failOnce = false; throw new Error('seal failure'); } key.fill(0); } });
  await assert.rejects(fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /seal failure/);
  assert.equal(fixture.replay.releases, 1);
  const response = await fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  assert.equal(response.status, 'key_resolved');
  const conflictRequest = { ...REQUEST, request_id: 'req-test-00000002' };
  await assert.rejects(fixture.resolver.resolve({ request: conflictRequest, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_IDEMPOTENCY_CONFLICT/);
});

test('content key bytes are zeroized in the callback finally path', async () => {
  const key = new Uint8Array(CONTENT_KEY);
  const fixture = makeResolver({ key });
  await fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(key, new Uint8Array(32));
});

test('close rejects later work and is idempotent', async () => {
  const fixture = makeResolver();
  await fixture.resolver.close();
  await fixture.resolver.close();
  await assert.rejects(fixture.resolver.resolve({ request: REQUEST, bearer: BEARER, governance: GOVERNANCE }), /REALTIME_E2EE_RESOLVER_CLOSED/);
});
