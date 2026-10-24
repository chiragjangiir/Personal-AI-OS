import { createRequire } from 'node:module';
import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeE2eeCiphertextResolverPort,
} from './realtime-public-control-runtime.ts';

/** The only operation and suite admitted by RFC-009. */
export const REALTIME_E2EE_OPERATION = 'realtime_e2ee_key_resolve' as const;
export const REALTIME_E2EE_CIPHER_SUITE =
  'DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM' as const;

const PROFILE_ID = 'paios-realtime-e2ee-hpke-framing';
const DOMAIN = 'realtime/e2ee';
const PROFILE_VERSION = '1.0.0';
// idempotency_profile_version and idempotency_profile_id are bound separately; PROFILE_VERSION and PROFILE_ID remain fixed.
const INFO_DOMAIN_SEPARATOR = 'PAIOS-RT-HPKE-INFO';
const AAD_DOMAIN_SEPARATOR = 'PAIOS-RT-HPKE-AAD';
const FRAME_MAGIC = 'PAIOSKEY';
const FRAME_VERSION = 0x0001;
const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
const SUCCESS_STATUS = 'key_resolved' as const;
const TERMINAL_STATUSES = ['expired', 'revoked', 'indeterminate'] as const;
const FORBIDDEN_KEYS = new Set([
  'privateKey',
  'private_key',
  'recipientPrivateKey',
  'recipient_private_key',
  'secret',
  'secretKey',
  'secret_key',
  'contentKey',
  'content_key',
  'keyMaterial',
  'key_material',
  'plaintext',
  'roomOptions',
  'room_options',
]);
const RESOLVER_OPTION_KEYS = new Set([
  'recipientCredential',
  'contentKey',
  'replay',
  'requestValidator',
  'terminalValidator',
  'now',
]);
const RECIPIENT_CREDENTIAL_KEYS = new Set([
  'publicKey',
  'status',
  'expiresAt',
  'deviceId',
  'credentialRef',
  'terminalResult',
]);
const CONTENT_KEY_LEASE_KEYS = new Set([
  'status',
  'expiresAt',
  'keyIndex',
  'keyGeneration',
  'binding',
  'terminalResult',
  'withKey',
  'use',
]);

type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
type ByteInput = ArrayBufferLike | ArrayBufferView;
type HpkeSuite = {
  readonly kem: { readonly deserializePublicKey: (value: ByteInput) => Promise<unknown> };
  readonly seal: (params: { readonly recipientPublicKey: unknown; readonly info: ByteInput }, plaintext: ByteInput, aad: ByteInput) => Promise<{ readonly enc: ByteInput; readonly ct: ByteInput }>;
};
type HpkeSuiteConstructor = new (params: unknown) => HpkeSuite;
const require = createRequire(import.meta.url);
const {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} = require('@hpke/core') as {
  readonly Aes256Gcm: new () => unknown;
  readonly CipherSuite: HpkeSuiteConstructor;
  readonly DhkemX25519HkdfSha256: new () => unknown;
  readonly HkdfSha256: new () => unknown;
};

export interface RecipientCredentialResolution {
  /** Exactly 32 raw X25519 public-key bytes. */
  readonly publicKey: ByteInput;
  readonly status: 'active' | TerminalStatus;
  readonly expiresAt: string;
  readonly deviceId: string;
  readonly credentialRef: JsonRecord;
  readonly terminalResult?: JsonRecord;
}

/** Owner-provided public credential lookup. The Gateway never receives a recipient private key. */
export interface RecipientCredentialPort {
  readonly resolve?: (input: {
    readonly request: JsonRecord;
    readonly deviceId: string;
    readonly credentialRef: JsonRecord;
  }) => Promise<RecipientCredentialResolution | undefined>;
  readonly get?: (input: {
    readonly request: JsonRecord;
    readonly deviceId: string;
    readonly credentialRef: JsonRecord;
  }) => Promise<RecipientCredentialResolution | undefined>;
  readonly close?: () => void | Promise<void>;
}

export interface ContentKeyLease {
  readonly status: 'active' | TerminalStatus;
  readonly expiresAt: string;
  readonly keyIndex: number;
  readonly keyGeneration: string;
  readonly binding: JsonRecord;
  readonly terminalResult?: JsonRecord;
  /** The key is available only for the duration of this callback. */
  readonly withKey?: <T>(callback: (key: Uint8Array) => Promise<T> | T) => Promise<T>;
  readonly use?: <T>(callback: (key: Uint8Array) => Promise<T> | T) => Promise<T>;
}

/** Owner-provided scoped content-key lease. A direct key property is deliberately not supported. */
export interface ContentKeyLeasePort {
  readonly lease?: (input: {
    readonly request: JsonRecord;
    readonly keyIndex: number;
    readonly keyGeneration: string;
  }) => Promise<ContentKeyLease | undefined>;
  readonly acquire?: (input: {
    readonly request: JsonRecord;
    readonly keyIndex: number;
    readonly keyGeneration: string;
  }) => Promise<ContentKeyLease | undefined>;
  readonly close?: () => void | Promise<void>;
}

export type DurableReplayClaim =
  | { readonly disposition: 'claimed'; readonly claimId: string }
  | { readonly disposition: 'replay'; readonly response: JsonRecord }
  | { readonly disposition: 'terminal'; readonly response: JsonRecord }
  | { readonly disposition: 'conflict' };

/** Durable idempotency/replay authority. The resolver only coordinates a local in-flight flight. */
export interface RealtimeE2eeDurableReplayPort {
  readonly claim: (input: {
    readonly request: JsonRecord;
    readonly idempotencyContext: JsonRecord;
    readonly fingerprint: string;
  }) => Promise<DurableReplayClaim>;
  readonly commit: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly response: JsonRecord;
  }) => Promise<void>;
  readonly release?: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
  }) => Promise<void>;
  readonly abort?: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
  }) => Promise<void>;
  readonly close?: () => void | Promise<void>;
}

/** Canonical T01 request/schema registry seam. The resolver does not own URI or SemVer policy. */
export interface RealtimeE2eeRequestValidatorPort {
  readonly validateRequest?: (operation: typeof REALTIME_E2EE_OPERATION, request: unknown) => void | boolean | Promise<void | boolean>;
  readonly validate?: (input: { readonly operation: typeof REALTIME_E2EE_OPERATION; readonly request: unknown }) => void | boolean | Promise<void | boolean>;
}

/** Canonical T01 realtime-terminal-result registry seam. */
export interface RealtimeE2eeTerminalValidatorPort {
  readonly validateTerminalResult?: (operation: typeof REALTIME_E2EE_OPERATION, result: JsonRecord, status?: TerminalStatus) => void | boolean | Promise<void | boolean>;
  readonly validate?: (input: { readonly operation: typeof REALTIME_E2EE_OPERATION; readonly result: JsonRecord; readonly status: TerminalStatus }) => void | boolean | Promise<void | boolean>;
}

export interface RealtimeE2eeCiphertextResolverOptions {
  readonly recipientCredential: RecipientCredentialPort;
  readonly contentKey: ContentKeyLeasePort;
  readonly replay: RealtimeE2eeDurableReplayPort;
  readonly requestValidator: RealtimeE2eeRequestValidatorPort;
  readonly terminalValidator: RealtimeE2eeTerminalValidatorPort;
  readonly now?: () => number;
}

export class RealtimeE2eeCiphertextResolverError extends Error {
  readonly code: string;
  readonly status: number;
  readonly terminalResult?: JsonRecord;

  constructor(code: string, status = 503, terminalResult?: JsonRecord) {
    super(code);
    this.name = 'RealtimeE2eeCiphertextResolverError';
    this.code = code;
    this.status = status;
    if (terminalResult !== undefined) this.terminalResult = terminalResult;
  }
}

interface RequestParts {
  readonly request: JsonRecord;
  readonly keyIndexDecimal: string;
  readonly keyGeneration: string;
  readonly connectionEpoch: string;
  readonly bearerExpiresAt?: string;
}

interface Projection {
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly aadSha256: string;
}

interface Flight {
  readonly fingerprint: string;
  readonly promise: Promise<JsonRecord>;
}

interface Sealed {
  readonly enc: Uint8Array;
  readonly ciphertext: Uint8Array;
}

type TerminalValidation = (result: JsonRecord, request: JsonRecord, status: TerminalStatus) => Promise<void>;

function fail(code: string, status = 503): never {
  throw new RealtimeE2eeCiphertextResolverError(code, status);
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, 422);
  return value as JsonRecord;
}

function own(value: JsonRecord, key: string, code: string): unknown {
  if (!Object.hasOwn(value, key)) fail(code, 422);
  return value[key];
}

function stringValue(value: unknown, code: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail(code, 422);
  return value;
}

function assertNoUnknown(value: JsonRecord, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(code, 422);
  }
}

function assertNoForbiddenOwnKeys(value: unknown, code: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) fail(code, 503);
  seen.add(value);
  for (const key of Object.keys(value as object)) {
    if (FORBIDDEN_KEYS.has(key)) fail(code, 503);
    assertNoForbiddenOwnKeys((value as JsonRecord)[key], code, seen);
  }
}

function ownPropertyNames(value: object, code: string): readonly string[] {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    fail(code, 503);
  }
}

function assertClosedOwnKeys(value: unknown, allowed: ReadonlySet<string>, code: string): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) fail(code, 503);
  for (const key of ownPropertyNames(value as object, code)) {
    if (!allowed.has(key)) fail(code, 503);
  }
}

/** Shallow by design: own-name inspection never reads a getter or traverses opaque state. */
function assertShallowForbiddenOwnKeys(value: unknown, code: string): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) fail(code, 503);
  for (const key of ownPropertyNames(value as object, code)) {
    if (FORBIDDEN_KEYS.has(key)) fail(code, 503);
  }
}

function assertSafeNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail('REALTIME_E2EE_CLOCK_INVALID', 503);
  return value;
}

function utf8(value: string, code = 'REALTIME_E2EE_TEXT_INVALID'): Uint8Array {
  if (value.normalize('NFC') !== value) fail(`${code}_NFC`, 422);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 0xffff) fail(`${code}_TOO_LONG`, 422);
  return bytes;
}

function ascii(value: string, code = 'REALTIME_E2EE_ASCII_INVALID'): Uint8Array {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) fail(code, 422);
  }
  return utf8(value, code);
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail('REALTIME_E2EE_U16_INVALID', 422);
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function toUint8Array(value: ByteInput): Uint8Array {
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('REALTIME_E2EE_BYTES_INVALID', 503);
}

function concat(...parts: readonly (ArrayBufferLike | ArrayBufferView)[]): Uint8Array {
  const views = parts.map((part) => {
    return toUint8Array(part);
  });
  const result = new Uint8Array(views.reduce((length, view) => length + view.byteLength, 0));
  let offset = 0;
  for (const view of views) {
    result.set(view, offset);
    offset += view.byteLength;
  }
  return result;
}

function l16(value: string, code = 'REALTIME_E2EE_TEXT_INVALID'): Uint8Array {
  const bytes = utf8(value, code);
  return concat(u16(bytes.byteLength), bytes);
}

function hexBytes(value: unknown, code: string, expectedLength: number): Uint8Array {
  const text = stringValue(value, code);
  if (text.length !== expectedLength * 2 || !/^[0-9a-f]+$/u.test(text)) fail(code, 422);
  const result = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    result[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function uuid16(value: unknown, code = 'REALTIME_E2EE_UUID_INVALID'): Uint8Array {
  const text = stringValue(value, code);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(text)) fail(code, 422);
  return hexBytes(text.replaceAll('-', ''), code, 16);
}

function hash32(value: unknown, code = 'REALTIME_E2EE_HASH_INVALID'): Uint8Array {
  return hexBytes(value, code, 32);
}

function canonicalPositiveDecimal(value: unknown, code: string): string {
  const text = stringValue(value, code);
  if (!/^[1-9][0-9]{0,37}$/u.test(text)) fail(code, 422);
  return text;
}

function canonicalKeyIndex(value: unknown): { readonly number: number; readonly decimal: string } {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('REALTIME_E2EE_KEY_INDEX_INVALID', 422);
  const number = value as number;
  return { number, decimal: String(number) };
}

function presence(value: JsonRecord, key: string, code: string): Uint8Array {
  if (!Object.hasOwn(value, key)) return u8(0);
  return concat(u8(1), uuid16(value[key], code));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}

function compareOptionalId(left: JsonRecord, right: JsonRecord): number {
  const leftPresent = Object.hasOwn(left, 'provider_id');
  const rightPresent = Object.hasOwn(right, 'provider_id');
  if (leftPresent !== rightPresent) return leftPresent ? 1 : -1;
  if (!leftPresent) return 0;
  return compareBytes(utf8(String(left.provider_id)), utf8(String(right.provider_id)));
}

function aliasTupleBytes(value: JsonRecord): readonly Uint8Array[] {
  return [
    utf8(String(value.alias_type)),
    utf8(String(value.issuer)),
    utf8(String(value.value)),
    u8(Object.hasOwn(value, 'provider_id') ? 1 : 0),
    Object.hasOwn(value, 'provider_id') ? utf8(String(value.provider_id)) : new Uint8Array(0),
  ];
}

function compareAliases(left: JsonRecord, right: JsonRecord): number {
  const leftParts = aliasTupleBytes(left);
  const rightParts = aliasTupleBytes(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const compared = compareBytes(leftParts[index]!, rightParts[index]!);
    if (compared !== 0) return compared;
  }
  return compareOptionalId(left, right);
}

function externalAlias(value: unknown, code = 'REALTIME_E2EE_ALIAS_INVALID'): Uint8Array {
  const alias = record(value, code);
  assertNoUnknown(alias, ['alias_type', 'issuer', 'value', 'provider_id'], code);
  const aliasType = stringValue(own(alias, 'alias_type', code), code);
  const issuer = stringValue(own(alias, 'issuer', code), code);
  const aliasValue = stringValue(own(alias, 'value', code), code);
  const provider = Object.hasOwn(alias, 'provider_id');
  return concat(
    l16(aliasType, code),
    l16(issuer, code),
    l16(aliasValue, code),
    provider ? concat(u8(1), uuid16(alias.provider_id, code)) : u8(0),
  );
}

function canonicalObjectVersionRef(value: unknown, code = 'REALTIME_E2EE_REF_INVALID'): Uint8Array {
  const ref = record(value, code);
  assertNoUnknown(ref, ['ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'], code);
  const refType = stringValue(own(ref, 'ref_type', code), code);
  const refId = uuid16(own(ref, 'ref_id', code), code);
  const version = canonicalPositiveDecimal(own(ref, 'object_version', code), code);
  const payloadHash = hash32(own(ref, 'canonical_payload_sha256', code), code);
  return concat(l16(refType, code), refId, l16(version, code), payloadHash);
}

function idempotencyContext(value: unknown): Uint8Array {
  const context = record(value, 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID');
  assertNoUnknown(context, [
    'idempotency_scope',
    'idempotency_key',
    'idempotency_profile_id',
    'idempotency_profile_version',
    'idempotency_profile_sha256',
    'idempotency_request_sha256',
  ], 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID');
  const scope = record(own(context, 'idempotency_scope', 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID');
  assertNoUnknown(scope, ['owner_module', 'operation_kind', 'target_object_type', 'user_id', 'tenant_id', 'target_object_id'], 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID');
  const profileId = stringValue(own(context, 'idempotency_profile_id', 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID');
  const profileVersion = stringValue(own(context, 'idempotency_profile_version', 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID');
  return concat(
    l16(stringValue(own(scope, 'owner_module', 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID')),
    l16(stringValue(own(scope, 'operation_kind', 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID')),
    l16(stringValue(own(scope, 'target_object_type', 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_SCOPE_INVALID')),
    presence(scope, 'user_id', 'REALTIME_E2EE_IDEMPOTENCY_UUID_INVALID'),
    presence(scope, 'tenant_id', 'REALTIME_E2EE_IDEMPOTENCY_UUID_INVALID'),
    presence(scope, 'target_object_id', 'REALTIME_E2EE_IDEMPOTENCY_UUID_INVALID'),
    l16(stringValue(own(context, 'idempotency_key', 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID')),
    l16(profileId),
    l16(profileVersion),
    hash32(own(context, 'idempotency_profile_sha256', 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'),
    hash32(own(context, 'idempotency_request_sha256', 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'), 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'),
  );
}

function orderedAliasArray(value: unknown, code: string): Uint8Array {
  if (!Array.isArray(value) || value.length === 0) fail(code, 422);
  const aliases = value.map((item) => record(item, code));
  for (let index = 1; index < aliases.length; index += 1) {
    if (compareAliases(aliases[index - 1]!, aliases[index]!) >= 0) fail(`${code}_ORDER`, 422);
  }
  return concat(u16(aliases.length), ...aliases.map((alias) => externalAlias(alias, code)));
}

function orderedPurposeArray(value: unknown, code: string): Uint8Array {
  if (!Array.isArray(value) || value.length === 0) fail(code, 422);
  const values = value.map((item) => stringValue(item, code));
  const bytes = values.map((item) => utf8(item, code));
  for (let index = 1; index < bytes.length; index += 1) {
    if (compareBytes(bytes[index - 1]!, bytes[index]!) >= 0) fail(`${code}_ORDER`, 422);
  }
  return concat(u16(bytes.length), ...bytes.map((item) => l16(new TextDecoder().decode(item), code)));
}

function orderedUuidArray(value: unknown, code: string): Uint8Array {
  if (!Array.isArray(value) || value.length === 0) fail(code, 422);
  const values = value.map((item) => stringValue(item, code));
  const bytes = values.map((item) => utf8(item, code));
  for (const valueBytes of bytes) uuid16(new TextDecoder().decode(valueBytes), code);
  for (let index = 1; index < bytes.length; index += 1) {
    if (compareBytes(bytes[index - 1]!, bytes[index]!) >= 0) fail(`${code}_ORDER`, 422);
  }
  return concat(u16(bytes.length), ...values.map((item) => uuid16(item, code)));
}

function governance(value: unknown): Uint8Array {
  const refs = record(value, 'REALTIME_E2EE_GOVERNANCE_INVALID');
  assertNoUnknown(refs, ['purpose_scopes', 'consent_record_refs', 'policy_decision_refs', 'purpose_token_refs', 'capability_grant_refs'], 'REALTIME_E2EE_GOVERNANCE_INVALID');
  return concat(
    orderedPurposeArray(own(refs, 'purpose_scopes', 'REALTIME_E2EE_GOVERNANCE_INVALID'), 'REALTIME_E2EE_PURPOSE_INVALID'),
    orderedUuidArray(own(refs, 'consent_record_refs', 'REALTIME_E2EE_GOVERNANCE_INVALID'), 'REALTIME_E2EE_CONSENT_REFS_INVALID'),
    orderedUuidArray(own(refs, 'policy_decision_refs', 'REALTIME_E2EE_GOVERNANCE_INVALID'), 'REALTIME_E2EE_POLICY_REFS_INVALID'),
    orderedUuidArray(own(refs, 'purpose_token_refs', 'REALTIME_E2EE_GOVERNANCE_INVALID'), 'REALTIME_E2EE_PURPOSE_TOKEN_REFS_INVALID'),
    orderedUuidArray(own(refs, 'capability_grant_refs', 'REALTIME_E2EE_GOVERNANCE_INVALID'), 'REALTIME_E2EE_CAPABILITY_REFS_INVALID'),
  );
}

function validateRequest(value: unknown, bearer: RealtimeBearerContext, suppliedGovernance: JsonRecord): RequestParts {
  const request = record(value, 'REALTIME_E2EE_REQUEST_INVALID');
  assertNoUnknown(request, [
    'operation',
    'request_id',
    'idempotency_context',
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'transport_aliases',
    'key_envelope_ref',
    'key_index',
    'key_generation',
    'device_id',
    'recipient_device_credential_ref',
    'participant_audience',
    'governance',
  ], 'REALTIME_E2EE_REQUEST_UNKNOWN_FIELD');
  if (request.operation !== REALTIME_E2EE_OPERATION) fail('REALTIME_E2EE_OPERATION_INVALID', 422);
  stringValue(own(request, 'request_id', 'REALTIME_E2EE_REQUEST_ID_INVALID'), 'REALTIME_E2EE_REQUEST_ID_INVALID');
  idempotencyContext(own(request, 'idempotency_context', 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'));
  canonicalObjectVersionRef(own(request, 'realtime_session_ref', 'REALTIME_E2EE_SESSION_REF_INVALID'));
  canonicalObjectVersionRef(own(request, 'device_lease_ref', 'REALTIME_E2EE_LEASE_REF_INVALID'));
  uuid16(own(request, 'continuity_id', 'REALTIME_E2EE_CONTINUITY_INVALID'));
  const connectionEpoch = canonicalPositiveDecimal(own(request, 'connection_epoch', 'REALTIME_E2EE_EPOCH_INVALID'), 'REALTIME_E2EE_EPOCH_INVALID');
  orderedAliasArray(own(request, 'transport_aliases', 'REALTIME_E2EE_TRANSPORT_ALIASES_INVALID'), 'REALTIME_E2EE_TRANSPORT_ALIASES_INVALID');
  externalAlias(own(request, 'key_envelope_ref', 'REALTIME_E2EE_ENVELOPE_REF_INVALID'), 'REALTIME_E2EE_ENVELOPE_REF_INVALID');
  const keyIndex = canonicalKeyIndex(own(request, 'key_index', 'REALTIME_E2EE_KEY_INDEX_INVALID'));
  const keyGeneration = canonicalPositiveDecimal(own(request, 'key_generation', 'REALTIME_E2EE_GENERATION_INVALID'), 'REALTIME_E2EE_GENERATION_INVALID');
  const deviceId = stringValue(own(request, 'device_id', 'REALTIME_E2EE_DEVICE_INVALID'), 'REALTIME_E2EE_DEVICE_INVALID');
  uuid16(deviceId, 'REALTIME_E2EE_DEVICE_INVALID');
  canonicalObjectVersionRef(own(request, 'recipient_device_credential_ref', 'REALTIME_E2EE_CREDENTIAL_REF_INVALID'), 'REALTIME_E2EE_CREDENTIAL_REF_INVALID');
  const credentialRef = record(request.recipient_device_credential_ref, 'REALTIME_E2EE_CREDENTIAL_REF_INVALID');
  if (credentialRef.ref_type !== 'DeviceCredential') fail('REALTIME_E2EE_CREDENTIAL_REF_TYPE_INVALID', 422);
  externalAlias(own(request, 'participant_audience', 'REALTIME_E2EE_AUDIENCE_INVALID'), 'REALTIME_E2EE_AUDIENCE_INVALID');
  governance(own(request, 'governance', 'REALTIME_E2EE_GOVERNANCE_INVALID'));
  if (stableStringify(request.governance) !== stableStringify(suppliedGovernance)) fail('REALTIME_E2EE_GOVERNANCE_BINDING_INVALID', 403);
  if (typeof bearer?.deviceId !== 'string' || bearer.deviceId !== deviceId) fail('REALTIME_E2EE_BEARER_DEVICE_INVALID', 403);
  if (bearer.expiresAt !== undefined) stringValue(bearer.expiresAt, 'REALTIME_E2EE_BEARER_EXPIRY_INVALID');
  assertNoForbiddenOwnKeys(request, 'REALTIME_E2EE_REQUEST_SECRET');
  return { request, keyIndexDecimal: keyIndex.decimal, keyGeneration, connectionEpoch, ...(bearer.expiresAt === undefined ? {} : { bearerExpiresAt: bearer.expiresAt }) };
}

function cvr(value: unknown): Uint8Array {
  return canonicalObjectVersionRef(value);
}

function buildInfo(parts: RequestParts): Uint8Array {
  const request = parts.request;
  return concat(
    ascii(INFO_DOMAIN_SEPARATOR),
    l16(PROFILE_ID),
    l16(DOMAIN),
    l16(PROFILE_VERSION),
    u16(KEM_ID),
    u16(KDF_ID),
    u16(AEAD_ID),
    u8(0),
    l16(REALTIME_E2EE_OPERATION),
    cvr(request.realtime_session_ref),
    cvr(request.device_lease_ref),
    uuid16(request.continuity_id),
    l16(parts.connectionEpoch),
    externalAlias(request.key_envelope_ref),
    l16(parts.keyIndexDecimal),
    l16(parts.keyGeneration),
    uuid16(request.device_id),
    cvr(request.recipient_device_credential_ref),
    externalAlias(request.participant_audience),
  );
}

function buildAad(parts: RequestParts, expiresAt: string): Uint8Array {
  const request = parts.request;
  return concat(
    ascii(AAD_DOMAIN_SEPARATOR),
    l16(PROFILE_ID),
    l16(DOMAIN),
    l16(PROFILE_VERSION),
    u16(KEM_ID),
    u16(KDF_ID),
    u16(AEAD_ID),
    u8(0),
    l16(REALTIME_E2EE_CIPHER_SUITE),
    l16(REALTIME_E2EE_OPERATION),
    l16(SUCCESS_STATUS),
    l16(stringValue(request.request_id, 'REALTIME_E2EE_REQUEST_ID_INVALID')),
    idempotencyContext(request.idempotency_context),
    cvr(request.realtime_session_ref),
    cvr(request.device_lease_ref),
    uuid16(request.continuity_id),
    l16(parts.connectionEpoch),
    orderedAliasArray(request.transport_aliases, 'REALTIME_E2EE_TRANSPORT_ALIASES_INVALID'),
    externalAlias(request.key_envelope_ref),
    l16(parts.keyIndexDecimal),
    l16(parts.keyGeneration),
    uuid16(request.device_id),
    cvr(request.recipient_device_credential_ref),
    externalAlias(request.participant_audience),
    l16(expiresAt),
    governance(request.governance),
  );
}

function buildPlaintext(parts: RequestParts, key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) fail('REALTIME_E2EE_CONTENT_KEY_LENGTH_INVALID', 503);
  return concat(
    ascii(FRAME_MAGIC),
    u16(FRAME_VERSION),
    l16(parts.keyIndexDecimal),
    l16(parts.keyGeneration),
    key,
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  // A copy is ArrayBuffer-backed, which BufferSource requires under stricter DOM typings; the AAD is small.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value !== null && typeof value === 'object') {
    const result: JsonRecord = {};
    for (const key of Object.keys(value as JsonRecord).sort()) result[key] = stableValue((value as JsonRecord)[key]);
    return result;
  }
  return value;
}

function stableStringify(value: unknown): string {
  const result = JSON.stringify(stableValue(value));
  if (result === undefined) fail('REALTIME_E2EE_CANONICALIZATION_INVALID', 422);
  return result;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === 'object') {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value as JsonRecord)) result[key] = cloneJson(item);
    return result;
  }
  return value;
}

function cloneRequestBinding(request: JsonRecord): JsonRecord {
  const result: JsonRecord = { operation: REALTIME_E2EE_OPERATION };
  for (const key of [
    'request_id',
    'idempotency_context',
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'transport_aliases',
    'key_envelope_ref',
    'key_index',
    'key_generation',
    'device_id',
    'recipient_device_credential_ref',
    'participant_audience',
    'governance',
  ]) {
    result[key] = cloneJson(request[key]);
  }
  return result;
}

async function completeTerminalResponse(value: unknown, request: JsonRecord, expectedStatus: TerminalStatus, validate: TerminalValidation): Promise<JsonRecord> {
  const candidate = record(value, 'REALTIME_E2EE_TERMINAL_RESULT_INVALID');
  assertNoUnknown(candidate, [
    'operation',
    'status',
    'request_id',
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'operation_outcome',
    'execution_facts',
    'governance',
  ], 'REALTIME_E2EE_TERMINAL_RESULT_INVALID');
  if (candidate.operation !== REALTIME_E2EE_OPERATION || candidate.status !== expectedStatus || candidate.request_id !== request.request_id) fail('REALTIME_E2EE_TERMINAL_BINDING_INVALID', 503);
  for (const key of ['realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch', 'governance']) {
    if (stableStringify(candidate[key]) !== stableStringify(request[key])) fail('REALTIME_E2EE_TERMINAL_BINDING_INVALID', 503);
  }
  const outcome = record(own(candidate, 'operation_outcome', 'REALTIME_E2EE_TERMINAL_OUTCOME_MISSING'), 'REALTIME_E2EE_TERMINAL_OUTCOME_INVALID');
  if (typeof outcome.outcome_class !== 'string') fail('REALTIME_E2EE_TERMINAL_OUTCOME_INVALID', 503);
  const facts = record(own(candidate, 'execution_facts', 'REALTIME_E2EE_TERMINAL_FACTS_MISSING'), 'REALTIME_E2EE_TERMINAL_FACTS_INVALID');
  if (typeof facts.closure_status !== 'string') fail('REALTIME_E2EE_TERMINAL_FACTS_INVALID', 503);
  if (Object.hasOwn(candidate, 'ciphertext') || Object.hasOwn(candidate, 'encapsulated_key') || Object.hasOwn(candidate, 'aad_sha256')) fail('REALTIME_E2EE_TERMINAL_CIPHERTEXT', 503);
  assertNoForbiddenOwnKeys(candidate, 'REALTIME_E2EE_TERMINAL_SECRET');
  const cloned = cloneJson(candidate) as JsonRecord;
  await validate(cloned, request, expectedStatus);
  return cloned;
}

function assertLeaseBinding(value: unknown, request: JsonRecord): void {
  const binding = record(value, 'REALTIME_E2EE_CONTENT_KEY_BINDING_MISSING');
  assertNoUnknown(binding, [
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'key_envelope_ref',
    'participant_audience',
    'governance',
  ], 'REALTIME_E2EE_CONTENT_KEY_BINDING_INVALID');
  for (const key of [
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'key_envelope_ref',
    'participant_audience',
    'governance',
  ]) {
    if (stableStringify(binding[key]) !== stableStringify(request[key])) fail('REALTIME_E2EE_CONTENT_KEY_BINDING_INVALID', 403);
  }
}

async function terminalFrom(value: unknown, request: JsonRecord, expectedStatus: TerminalStatus, validate: TerminalValidation): Promise<JsonRecord | undefined> {
  if (value === undefined) return undefined;
  return completeTerminalResponse(value, request, expectedStatus, validate);
}

function assertResponseBinding(response: JsonRecord, request: JsonRecord): void {
  if (response.operation !== REALTIME_E2EE_OPERATION || response.request_id !== request.request_id) fail('REALTIME_E2EE_REPLAY_BINDING_INVALID', 503);
  for (const key of [
    'idempotency_context',
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'transport_aliases',
    'key_envelope_ref',
    'key_index',
    'key_generation',
    'device_id',
    'recipient_device_credential_ref',
    'participant_audience',
    'governance',
  ]) {
    if (stableStringify(response[key]) !== stableStringify(request[key])) fail('REALTIME_E2EE_REPLAY_BINDING_INVALID', 503);
  }
  assertNoForbiddenOwnKeys(response, 'REALTIME_E2EE_RESPONSE_SECRET');
}

function decodeBase64url(value: unknown, code: string): Uint8Array {
  const text = stringValue(value, code);
  if (!/^[A-Za-z0-9_-]+$/u.test(text) || text.includes('=')) fail(code, 503);
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let decoded: Uint8Array;
  try { decoded = new Uint8Array(Buffer.from(padded, 'base64')); } catch { fail(code, 503); }
  if (base64url(decoded) !== text) fail(code, 503);
  return decoded;
}

async function normalizeReplayResponse(value: unknown, parts: RequestParts, nowMs: number, validateTerminal: TerminalValidation): Promise<JsonRecord> {
  const request = parts.request;
  const response = record(value, 'REALTIME_E2EE_REPLAY_INVALID');
  if (response.status === 'expired' || response.status === 'revoked' || response.status === 'indeterminate') {
    if (response.operation !== REALTIME_E2EE_OPERATION || response.request_id !== request.request_id) fail('REALTIME_E2EE_REPLAY_BINDING_INVALID', 503);
    return completeTerminalResponse(response, request, response.status, validateTerminal);
  }
  assertResponseBinding(response, request);
  if (response.status !== SUCCESS_STATUS) fail('REALTIME_E2EE_REPLAY_STATUS_INVALID', 503);
  assertNoUnknown(response, [
    'operation',
    'status',
    'request_id',
    'idempotency_context',
    'realtime_session_ref',
    'device_lease_ref',
    'continuity_id',
    'connection_epoch',
    'transport_aliases',
    'key_envelope_ref',
    'key_index',
    'key_generation',
    'device_id',
    'recipient_device_credential_ref',
    'participant_audience',
    'expires_at',
    'cipher_suite',
    'encapsulated_key',
    'ciphertext',
    'aad_sha256',
    'governance',
  ], 'REALTIME_E2EE_REPLAY_UNKNOWN_FIELD');
  const expiresAt = stringValue(response.expires_at, 'REALTIME_E2EE_REPLAY_EXPIRY_INVALID');
  const cipherSuite = stringValue(response.cipher_suite, 'REALTIME_E2EE_REPLAY_SUITE_INVALID');
  const encapsulatedKey = stringValue(response.encapsulated_key, 'REALTIME_E2EE_REPLAY_ENC_INVALID');
  const ciphertext = stringValue(response.ciphertext, 'REALTIME_E2EE_REPLAY_CIPHERTEXT_INVALID');
  const aadSha256 = stringValue(response.aad_sha256, 'REALTIME_E2EE_REPLAY_AAD_HASH_INVALID');
  const expiryValue = expiry(expiresAt, 'REALTIME_E2EE_REPLAY_EXPIRY_INVALID', nowMs);
  if (expiryValue.millis <= nowMs || cipherSuite !== REALTIME_E2EE_CIPHER_SUITE || !/^[0-9a-f]{64}$/u.test(aadSha256)) fail('REALTIME_E2EE_REPLAY_ENCODING_INVALID', 503);
  const encBytes = decodeBase64url(encapsulatedKey, 'REALTIME_E2EE_REPLAY_ENC_INVALID');
  const ciphertextBytes = decodeBase64url(ciphertext, 'REALTIME_E2EE_REPLAY_CIPHERTEXT_INVALID');
  const expectedCiphertextLength = 46 + parts.keyIndexDecimal.length + parts.keyGeneration.length + 16;
  if (encBytes.byteLength !== 32 || ciphertextBytes.byteLength !== expectedCiphertextLength) fail('REALTIME_E2EE_REPLAY_LENGTH_INVALID', 503);
  const expectedAadSha256 = await sha256Hex(buildAad(parts, expiresAt));
  if (expectedAadSha256 !== aadSha256) fail('REALTIME_E2EE_REPLAY_AAD_HASH_INVALID', 503);
  return {
    ...cloneRequestBinding(request),
    status: SUCCESS_STATUS,
    expires_at: expiresAt,
    cipher_suite: cipherSuite,
    encapsulated_key: encapsulatedKey,
    ciphertext,
    aad_sha256: aadSha256,
  };
}

function expiry(value: unknown, code: string, nowMs: number): { readonly text: string; readonly millis: number } {
  const text = stringValue(value, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) fail(code, 503);
  const millis = Date.parse(text);
  if (!Number.isSafeInteger(millis)) fail(code, 503);
  return { text, millis: millis as number };
}

function effectiveExpiry(nowMs: number, ...values: readonly (string | undefined)[]): string {
  const parsed = values.filter((value): value is string => value !== undefined).map((value) => expiry(value, 'REALTIME_E2EE_EXPIRY_INVALID', nowMs));
  if (parsed.length === 0) fail('REALTIME_E2EE_EXPIRY_MISSING', 503);
  const selected = parsed.reduce((left, right) => right.millis < left.millis ? right : left);
  if (selected.millis <= nowMs) fail('REALTIME_E2EE_EXPIRED', 410);
  return selected.text;
}

function publicKeyBytes(value: ByteInput): Uint8Array {
  let view: Uint8Array;
  try {
    view = toUint8Array(value);
  } catch {
    fail('REALTIME_E2EE_RECIPIENT_PUBLIC_KEY_INVALID', 503);
  }
  if (view.byteLength !== 32) fail('REALTIME_E2EE_RECIPIENT_PUBLIC_KEY_INVALID', 503);
  return new Uint8Array(view);
}

function makeProjection(parts: RequestParts, expiresAt: string): Projection {
  const info = buildInfo(parts);
  const aad = buildAad(parts, expiresAt);
  return { info, aad, aadSha256: '' };
}

/** Recipient side of the same framing: HPKE info and AAD for the request a device sent and the response expiry. */
export function realtimeE2eeRecipientBinding(request: unknown, expiresAt: string): { readonly info: Uint8Array; readonly aad: Uint8Array } {
  const value = record(request, 'REALTIME_E2EE_REQUEST_INVALID');
  const parts = validateRequest(value, { principal: undefined, deviceId: String(value.device_id) }, record(value.governance, 'REALTIME_E2EE_GOVERNANCE_BINDING_INVALID'));
  const { info, aad } = makeProjection(parts, expiresAt);
  return { info, aad };
}

async function invokeCallback(lease: ContentKeyLease, callback: (key: Uint8Array) => Promise<void>): Promise<void> {
  const withKey = lease.withKey ?? lease.use;
  if (withKey === undefined) fail('REALTIME_E2EE_CONTENT_KEY_CALLBACK_MISSING', 503);
  let callbackCount = 0;
  await withKey.call(lease, async (key) => {
    try {
      if (!(key instanceof Uint8Array)) fail('REALTIME_E2EE_CONTENT_KEY_CALLBACK_INVALID', 503);
      callbackCount += 1;
      if (callbackCount !== 1) fail('REALTIME_E2EE_CONTENT_KEY_CALLBACK_REUSED', 503);
      await callback(key);
    } finally {
      if (key instanceof Uint8Array) key.fill(0);
    }
  });
}

function normalizeClaim(value: unknown): DurableReplayClaim {
  const claim = record(value, 'REALTIME_E2EE_REPLAY_CLAIM_INVALID');
  if (claim.disposition === 'claimed') {
    const claimId = stringValue(claim.claimId, 'REALTIME_E2EE_REPLAY_CLAIM_ID_INVALID');
    return { disposition: 'claimed', claimId };
  }
  if (claim.disposition === 'replay' || claim.disposition === 'terminal') {
    return { disposition: claim.disposition, response: record(claim.response, 'REALTIME_E2EE_REPLAY_RESPONSE_INVALID') };
  }
  if (claim.disposition === 'conflict') return { disposition: 'conflict' };
  fail('REALTIME_E2EE_REPLAY_CLAIM_INVALID', 503);
}

export class RealtimeE2eeCiphertextResolver implements RealtimeE2eeCiphertextResolverPort {
  readonly #recipientCredential: RecipientCredentialPort;
  readonly #contentKey: ContentKeyLeasePort;
  readonly #replay: RealtimeE2eeDurableReplayPort;
  readonly #requestValidator: RealtimeE2eeRequestValidatorPort;
  readonly #terminalValidator: RealtimeE2eeTerminalValidatorPort;
  readonly #now: () => number;
  readonly #suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  readonly #flights = new Map<string, Flight>();
  #closed = false;
  #closeFlight?: Promise<void>;

  constructor(options: RealtimeE2eeCiphertextResolverOptions) {
    if (options === null || typeof options !== 'object') fail('REALTIME_E2EE_RESOLVER_OPTIONS_INVALID', 503);
    assertClosedOwnKeys(options, RESOLVER_OPTION_KEYS, 'REALTIME_E2EE_RESOLVER_OPTIONS_UNKNOWN_FIELD');
    if (options.recipientCredential !== undefined) assertShallowForbiddenOwnKeys(options.recipientCredential, 'REALTIME_E2EE_RECIPIENT_PORT_SECRET');
    if (options.contentKey !== undefined) assertShallowForbiddenOwnKeys(options.contentKey, 'REALTIME_E2EE_CONTENT_KEY_PORT_SECRET');
    if (options.replay !== undefined) assertShallowForbiddenOwnKeys(options.replay, 'REALTIME_E2EE_REPLAY_PORT_SECRET');
    if (options.requestValidator !== undefined) assertShallowForbiddenOwnKeys(options.requestValidator, 'REALTIME_E2EE_REQUEST_VALIDATOR_SECRET');
    if (options.terminalValidator !== undefined) assertShallowForbiddenOwnKeys(options.terminalValidator, 'REALTIME_E2EE_TERMINAL_VALIDATOR_SECRET');
    if (options.recipientCredential === undefined || (options.recipientCredential.resolve === undefined && options.recipientCredential.get === undefined)) fail('REALTIME_E2EE_RECIPIENT_PORT_MISSING', 503);
    if (options.contentKey === undefined || (options.contentKey.lease === undefined && options.contentKey.acquire === undefined)) fail('REALTIME_E2EE_CONTENT_KEY_PORT_MISSING', 503);
    if (options.replay === undefined || typeof options.replay.claim !== 'function' || typeof options.replay.commit !== 'function' || (options.replay.release === undefined && options.replay.abort === undefined)) fail('REALTIME_E2EE_REPLAY_PORT_MISSING', 503);
    if (options.requestValidator === undefined || (typeof options.requestValidator.validateRequest !== 'function' && typeof options.requestValidator.validate !== 'function')) fail('REALTIME_E2EE_REQUEST_VALIDATOR_MISSING', 503);
    if (options.terminalValidator === undefined || (typeof options.terminalValidator.validateTerminalResult !== 'function' && typeof options.terminalValidator.validate !== 'function')) fail('REALTIME_E2EE_TERMINAL_VALIDATOR_MISSING', 503);
    this.#recipientCredential = options.recipientCredential;
    this.#contentKey = options.contentKey;
    this.#replay = options.replay;
    this.#requestValidator = options.requestValidator!;
    this.#terminalValidator = options.terminalValidator!;
    this.#now = options.now ?? (() => Date.now());
  }

  async #validateCanonicalRequest(value: unknown): Promise<void> {
    const validator = this.#requestValidator.validateRequest;
    let verdict: void | boolean | Promise<void | boolean>;
    try {
      verdict = validator === undefined
        ? this.#requestValidator.validate!.call(this.#requestValidator, { operation: REALTIME_E2EE_OPERATION, request: value })
        : validator.call(this.#requestValidator, REALTIME_E2EE_OPERATION, value);
      if (await verdict === false) fail('REALTIME_E2EE_REQUEST_SCHEMA_INVALID', 422);
    } catch (error) {
      if (error instanceof RealtimeE2eeCiphertextResolverError) throw error;
      fail('REALTIME_E2EE_REQUEST_SCHEMA_INVALID', 422);
    }
  }

  async #validateTerminal(result: JsonRecord, request: JsonRecord, status: TerminalStatus): Promise<void> {
    const validator = this.#terminalValidator.validateTerminalResult;
    let verdict: void | boolean | Promise<void | boolean>;
    try {
      verdict = validator === undefined
        ? this.#terminalValidator.validate!.call(this.#terminalValidator, { operation: REALTIME_E2EE_OPERATION, result, status })
        : validator.call(this.#terminalValidator, REALTIME_E2EE_OPERATION, result, status);
      if (await verdict === false) fail('REALTIME_E2EE_TERMINAL_SCHEMA_INVALID', 503);
    } catch (error) {
      if (error instanceof RealtimeE2eeCiphertextResolverError) throw error;
      fail('REALTIME_E2EE_TERMINAL_SCHEMA_INVALID', 503);
    }
    if (stableStringify(result.governance) !== stableStringify(request.governance)) fail('REALTIME_E2EE_TERMINAL_BINDING_INVALID', 503);
  }

  async resolve(input: { readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }): Promise<JsonRecord> {
    if (this.#closed) fail('REALTIME_E2EE_RESOLVER_CLOSED', 503);
    await this.#validateCanonicalRequest(input.request);
    const parts = validateRequest(input.request, input.bearer, input.governance);
    const flightKey = stableStringify(parts.request.idempotency_context);
    const fingerprint = stableStringify(parts.request);
    const existing = this.#flights.get(flightKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) fail('REALTIME_E2EE_IDEMPOTENCY_CONFLICT', 409);
      return existing.promise;
    }
    const promise = this.#resolveOnce(parts, fingerprint);
    this.#flights.set(flightKey, { fingerprint, promise });
    void promise.finally(() => {
      const current = this.#flights.get(flightKey);
      if (current?.promise === promise) this.#flights.delete(flightKey);
    }).catch(() => undefined);
    return promise;
  }

  async #resolveOnce(parts: RequestParts, fingerprint: string): Promise<JsonRecord> {
    const request = parts.request;
    const claim = normalizeClaim(await this.#replay.claim.call(this.#replay, {
      request: cloneRequestBinding(request),
      idempotencyContext: record(cloneJson(request.idempotency_context), 'REALTIME_E2EE_IDEMPOTENCY_CONTEXT_INVALID'),
      fingerprint,
    }));
    if (claim.disposition === 'conflict') fail('REALTIME_E2EE_IDEMPOTENCY_CONFLICT', 409);
    if (claim.disposition === 'replay' || claim.disposition === 'terminal') return normalizeReplayResponse(
      claim.response,
      parts,
      assertSafeNow(this.#now),
      (result, terminalRequest, status) => this.#validateTerminal(result, terminalRequest, status),
    );

    let committed = false;
    try {
      const nowMs = assertSafeNow(this.#now);
      const credentialPort = this.#recipientCredential.resolve ?? this.#recipientCredential.get;
      if (credentialPort === undefined) fail('REALTIME_E2EE_RECIPIENT_PORT_MISSING', 503);
      const credential = await credentialPort.call(this.#recipientCredential, {
        request: cloneRequestBinding(request),
        deviceId: String(request.device_id),
        credentialRef: record(cloneJson(request.recipient_device_credential_ref), 'REALTIME_E2EE_CREDENTIAL_REF_INVALID'),
      });
      if (credential === undefined) fail('REALTIME_E2EE_RECIPIENT_CREDENTIAL_INDETERMINATE', 503);
      assertShallowForbiddenOwnKeys(credential, 'REALTIME_E2EE_RECIPIENT_CREDENTIAL_SECRET');
      assertClosedOwnKeys(credential, RECIPIENT_CREDENTIAL_KEYS, 'REALTIME_E2EE_RECIPIENT_CREDENTIAL_UNKNOWN_FIELD');
      if (credential.status === undefined || credential.expiresAt === undefined || credential.deviceId === undefined || credential.credentialRef === undefined || credential.publicKey === undefined) fail('REALTIME_E2EE_RECIPIENT_CREDENTIAL_INDETERMINATE', 503);
      if (credential.status !== 'active') {
        const response = await terminalFrom(credential.terminalResult, request, credential.status, (result, terminalRequest, status) => this.#validateTerminal(result, terminalRequest, status));
        if (response === undefined) fail('REALTIME_E2EE_TERMINAL_RESULT_MISSING', 503);
        await this.#replay.commit.call(this.#replay, { claimId: claim.claimId, fingerprint, response });
        committed = true;
        return response;
      }
      if (credential.deviceId !== request.device_id) fail('REALTIME_E2EE_RECIPIENT_DEVICE_BINDING_INVALID', 403);
      if (stableStringify(credential.credentialRef) !== stableStringify(request.recipient_device_credential_ref)) fail('REALTIME_E2EE_RECIPIENT_CREDENTIAL_BINDING_INVALID', 403);

      const leasePort = this.#contentKey.lease ?? this.#contentKey.acquire;
      if (leasePort === undefined) fail('REALTIME_E2EE_CONTENT_KEY_PORT_MISSING', 503);
      const lease = await leasePort.call(this.#contentKey, { request: cloneRequestBinding(request), keyIndex: Number(request.key_index), keyGeneration: parts.keyGeneration });
      if (lease === undefined) fail('REALTIME_E2EE_CONTENT_KEY_INDETERMINATE', 503);
      assertShallowForbiddenOwnKeys(lease, 'REALTIME_E2EE_CONTENT_KEY_LEASE_SECRET');
      assertClosedOwnKeys(lease, CONTENT_KEY_LEASE_KEYS, 'REALTIME_E2EE_CONTENT_KEY_UNKNOWN_FIELD');
      if (lease.status === undefined || lease.expiresAt === undefined || lease.keyIndex === undefined || lease.keyGeneration === undefined || lease.binding === undefined) fail('REALTIME_E2EE_CONTENT_KEY_INDETERMINATE', 503);
      if (lease.status !== 'active') {
        const response = await terminalFrom(lease.terminalResult, request, lease.status, (result, terminalRequest, status) => this.#validateTerminal(result, terminalRequest, status));
        if (response === undefined) fail('REALTIME_E2EE_TERMINAL_RESULT_MISSING', 503);
        await this.#replay.commit.call(this.#replay, { claimId: claim.claimId, fingerprint, response });
        committed = true;
        return response;
      }
      assertLeaseBinding(lease.binding, request);
      if (lease.keyIndex !== request.key_index) fail('REALTIME_E2EE_CONTENT_KEY_INDEX_BINDING_INVALID', 403);
      if (lease.keyGeneration !== parts.keyGeneration) fail('REALTIME_E2EE_CONTENT_KEY_GENERATION_BINDING_INVALID', 403);
      const expiresAt = effectiveExpiry(nowMs, lease.expiresAt, credential.expiresAt, parts.bearerExpiresAt);
      const projection = makeProjection(parts, expiresAt);
      const aadSha256 = await sha256Hex(projection.aad);
      const recipientPublicKey = await this.#suite.kem.deserializePublicKey(publicKeyBytes(credential.publicKey));
      let sealed: Sealed | undefined;
      await invokeCallback(lease, async (key) => {
        const plaintext = buildPlaintext(parts, key);
        try {
          const result = await this.#suite.seal({ recipientPublicKey, info: projection.info }, plaintext, projection.aad);
          sealed = { enc: toUint8Array(result.enc), ciphertext: toUint8Array(result.ct) };
        } finally {
          plaintext.fill(0);
        }
      });
      if (sealed === undefined) fail('REALTIME_E2EE_CONTENT_KEY_CALLBACK_EMPTY', 503);
      const response: JsonRecord = {
        ...cloneRequestBinding(request),
        status: SUCCESS_STATUS,
        expires_at: expiresAt,
        cipher_suite: REALTIME_E2EE_CIPHER_SUITE,
        encapsulated_key: base64url(sealed.enc),
        ciphertext: base64url(sealed.ciphertext),
        aad_sha256: aadSha256,
      };
      await this.#replay.commit.call(this.#replay, { claimId: claim.claimId, fingerprint, response });
      committed = true;
      return response;
    } catch (error) {
      if (!committed) {
        const release = this.#replay.release ?? this.#replay.abort;
        if (release !== undefined) await release.call(this.#replay, { claimId: claim.claimId, fingerprint }).catch(() => undefined);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    this.#closed = true;
    this.#closeFlight = (async () => {
      const flights = [...this.#flights.values()].map((flight) => flight.promise);
      await Promise.allSettled(flights);
      const failures: string[] = [];
      for (const [name, owner, close] of [
        ['recipient', this.#recipientCredential, this.#recipientCredential.close],
        ['content_key', this.#contentKey, this.#contentKey.close],
        ['replay', this.#replay, this.#replay.close],
      ] as const) {
        if (close === undefined) continue;
        try { await close.call(owner); } catch { failures.push(name); }
      }
      if (failures.length > 0) throw new RealtimeE2eeCiphertextResolverError('REALTIME_E2EE_RESOLVER_CLOSE_FAILED', 503);
    })();
    return this.#closeFlight;
  }
}

export function createRealtimeE2eeCiphertextResolver(options: RealtimeE2eeCiphertextResolverOptions): RealtimeE2eeCiphertextResolverPort {
  return new RealtimeE2eeCiphertextResolver(options);
}
