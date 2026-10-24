import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  LeasePolicyDecision,
  LeasePolicyPort,
} from '../../../services/realtime-core/src/ports.ts';
import type { ProductionPortRegistration } from '../../../services/realtime-core/src/production-owner-ports.ts';
import {
  assertCanonicalTimestamp,
  snapshotOpaqueOwnerValue,
  type OpaqueGovernanceValue,
} from '../../../services/realtime-core/src/types.ts';
import type {
  T03AuthoritySnapshotPort,
  T03AuthoritySnapshotResolveInput,
} from './t03-governance-device-credential-runtime.ts';

export const T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH =
  'D:\\AI\\personal ai os\\.runtime\\phase0-roaming\\windows\\config\\apple-cycling-governance-authority.v1.json' as const;
export const T03_APPLE_CYCLING_AUTHORITY_SCHEMA = 'paios.t03.apple_cycling_governance_authority.v1' as const;
export const T03_APPLE_CYCLING_PURPOSE = 'cycling_assistant' as const;

const OWNER = 'T03.apple-cycling-governance' as const;
const MAX_RECORD_BYTES = 65_536;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;
const X25519_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;
const OPERATIONS = Object.freeze([
  'bootstrap',
  'realtime_e2ee_key_resolve',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
] as const);
const MEDIA = Object.freeze(['audio', 'video', 'data'] as const);
const REQUIRED_GOVERNANCE_KEYS = Object.freeze([
  'purpose_scopes',
  'consent_record_refs',
  'policy_decision_refs',
  'purpose_token_refs',
  'capability_grant_refs',
] as const);
const FORBIDDEN_KEYS = new Set([
  'api_key', 'api_secret', 'bearer', 'key_material', 'password', 'plaintext', 'private_key', 'secret', 'token',
]);

type JsonRecord = Record<string, unknown>;
type Operation = (typeof OPERATIONS)[number];
type MediaCapability = (typeof MEDIA)[number];

export interface T03AppleCyclingAuthorityRecordReader {
  readonly path: string;
  readonly read: () => Uint8Array | undefined;
}

export interface T03AppleCyclingOwnerProtectionPort {
  readonly assertOwnerProtected: (path: string) => void;
}

export interface T03AppleCyclingExpectedRecordSha256Port {
  readonly current: () => string;
}

interface T03AppleCyclingLeaseAuthorityOptionsBase {
  readonly record: T03AppleCyclingAuthorityRecordReader;
  readonly expectedRecordPath?: string;
  readonly ownerProtection: T03AppleCyclingOwnerProtectionPort;
  readonly now?: () => number;
}

export type T03AppleCyclingLeaseAuthorityOptions = T03AppleCyclingLeaseAuthorityOptionsBase & (
  | {
      readonly expectedRecordSha256: string;
      readonly expectedRecordSha256Port?: never;
    }
  | {
      readonly expectedRecordSha256?: never;
      readonly expectedRecordSha256Port: T03AppleCyclingExpectedRecordSha256Port;
    }
);

export interface T03AppleCyclingLeaseAuthority {
  readonly policy: ProductionPortRegistration<LeasePolicyPort>;
  readonly authoritySnapshot: T03AuthoritySnapshotPort;
  readonly formalWatchPrimaryAuthority: { readonly resolve: (authenticatedBearer: unknown) => Promise<Readonly<{ userId: string; deviceId: string; principalRef: unknown; expiresAt: string; purpose: string; policyDecisionRef: unknown; capabilities: unknown }>> };
  readonly readCurrentAuthority: (atSystemTime?: string) => T03AppleCyclingCurrentAuthorityProjection;
  readonly currentAuthority: (atSystemTime?: string) => T03AppleCyclingCurrentAuthorityProjection;
  readonly isReady: () => boolean;
  readonly close: () => void;
}

export class T03AppleCyclingLeaseAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'T03AppleCyclingLeaseAuthorityError';
    this.code = code;
  }
}

interface NormalizedRecord {
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly principal: unknown;
  readonly capabilityRef?: unknown;
  readonly scopes: readonly Operation[];
  readonly allowedMediaCapabilities: readonly MediaCapability[];
  readonly governance: OpaqueGovernanceValue;
  readonly policyDecisionRef: OpaqueGovernanceValue;
  readonly recipientCredential?: T03AppleCyclingRecipientCredential;
}

export interface T03AppleCyclingRecipientCredential {
  readonly deviceCredentialRef: OpaqueGovernanceValue;
  readonly publicKey: string;
  readonly publicKeySha256: string;
  readonly audience: OpaqueGovernanceValue;
  readonly deviceId: string;
  readonly realtimeSessionRef: OpaqueGovernanceValue;
  readonly deviceLeaseRef: OpaqueGovernanceValue;
  readonly continuityId: string;
  readonly expiresAt: string;
}

export interface T03AppleCyclingCurrentAuthorityProjection {
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly principal: OpaqueGovernanceValue;
  readonly capabilityRef: OpaqueGovernanceValue;
  readonly operations: readonly Operation[];
  readonly allowedMediaCapabilities: readonly MediaCapability[];
  readonly purpose: typeof T03_APPLE_CYCLING_PURPOSE;
  readonly governance: OpaqueGovernanceValue;
  readonly policyDecisionRef: OpaqueGovernanceValue;
  readonly recipientCredential?: T03AppleCyclingRecipientCredential;
}

function fail(code: string): never {
  throw new T03AppleCyclingLeaseAuthorityError(code);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined ||
        descriptor.set !== undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(code);
  }
  return value;
}

function boundedString(value: unknown, code: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.trim() ||
      value.includes('\u0000')) fail(code);
  return value;
}

function uuidV7(value: unknown, code: string): string {
  const result = boundedString(value, code, 36);
  if (!UUID_V7.test(result)) fail(code);
  return result;
}

function timestamp(value: unknown, code: string): string {
  try {
    return assertCanonicalTimestamp(value);
  } catch {
    return fail(code);
  }
}

function timestampMs(value: string, code: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) fail(code);
  return result;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('T03_APPLE_CYCLING_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (!isPlainRecord(value) && !Array.isArray(value)) fail('T03_APPLE_CYCLING_VALUE_INVALID');
  if (ancestors.has(value)) fail('T03_APPLE_CYCLING_VALUE_INVALID');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail('T03_APPLE_CYCLING_SECRET_FIELD_FORBIDDEN');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined ||
          descriptor.set !== undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('T03_APPLE_CYCLING_VALUE_INVALID');
      }
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function opaque(value: unknown, code: string): unknown {
  try {
    const snapshot = snapshotOpaqueOwnerValue(value);
    const encoded = canonicalJson(snapshot);
    if (encoded.length === 0 || encoded.length > 16_384) fail(code);
    return snapshot;
  } catch (error) {
    if (error instanceof T03AppleCyclingLeaseAuthorityError) throw error;
    return fail(code);
  }
}

function canonicalRef(value: unknown, expectedType: string, code: string): OpaqueGovernanceValue {
  const record = exactRecord(value, [
    'canonical_payload_sha256', 'object_version', 'ref_id', 'ref_type',
  ], code);
  if (record.ref_type !== expectedType || !POSITIVE_DECIMAL.test(boundedString(record.object_version, code, 38))) fail(code);
  uuidV7(record.ref_id, code);
  digest(record.canonical_payload_sha256, code);
  return opaque(record, code) as OpaqueGovernanceValue;
}

function refArray(value: unknown, expectedType: string, code: string): readonly OpaqueGovernanceValue[] {
  if (!Array.isArray(value) || value.length !== 1) fail(code);
  return Object.freeze([canonicalRef(value[0], expectedType, code)]);
}

function canonicalSubset<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
  required?: T,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) fail(code);
  const expected = allowed.filter((item) => value.includes(item));
  if (expected.length !== value.length || expected.some((item, index) => item !== value[index]) ||
      new Set(value).size !== value.length || (required !== undefined && !expected.includes(required))) fail(code);
  return Object.freeze([...expected]);
}

function consent(value: unknown): void {
  const record = exactRecord(value, [
    'audio_capture', 'background_health', 'background_location', 'iphone_motion', 'navigation',
    'video_capture', 'watch_workout_metrics',
  ], 'T03_APPLE_CYCLING_CONSENT_INVALID');
  if (!same(record.watch_workout_metrics, ['heart_rate', 'active_energy']) ||
      !same(record.iphone_motion, ['speed', 'location']) || record.navigation !== 'user_toggle' ||
      record.audio_capture !== 'explicit_wake_or_tap_only' ||
      record.video_capture !== 'explicit_wake_or_tap_only' ||
      record.background_health !== 'platform_authorized' ||
      record.background_location !== 'platform_authorized') fail('T03_APPLE_CYCLING_CONSENT_INVALID');
}

function governance(value: unknown): Readonly<{
  readonly snapshot: OpaqueGovernanceValue;
  readonly policyDecisionRef: OpaqueGovernanceValue;
}> {
  const record = exactRecord(value, REQUIRED_GOVERNANCE_KEYS, 'T03_APPLE_CYCLING_GOVERNANCE_INVALID');
  if (!same(record.purpose_scopes, [T03_APPLE_CYCLING_PURPOSE])) fail('T03_APPLE_CYCLING_PURPOSE_INVALID');
  refArray(record.consent_record_refs, 'ConsentRecord', 'T03_APPLE_CYCLING_CONSENT_REF_INVALID');
  const decisions = refArray(record.policy_decision_refs, 'PolicyDecision', 'T03_APPLE_CYCLING_POLICY_REF_INVALID');
  refArray(record.purpose_token_refs, 'PurposeToken', 'T03_APPLE_CYCLING_PURPOSE_TOKEN_REF_INVALID');
  refArray(record.capability_grant_refs, 'CapabilityGrant', 'T03_APPLE_CYCLING_CAPABILITY_REF_INVALID');
  return Object.freeze({
    snapshot: opaque(record, 'T03_APPLE_CYCLING_GOVERNANCE_INVALID') as OpaqueGovernanceValue,
    policyDecisionRef: decisions[0]!,
  });
}

export function wireGovernance(value: OpaqueGovernanceValue): JsonRecord {
  const record = value as JsonRecord;
  const refId = (key: string): string => {
    const refs = record[key];
    const ref = Array.isArray(refs) && refs.length === 1 ? refs[0] : undefined;
    if (!isPlainRecord(ref) || typeof ref.ref_id !== 'string' || ref.ref_id.length === 0) {
      fail('T03_APPLE_CYCLING_GOVERNANCE_INVALID');
    }
    return ref.ref_id;
  };
  return Object.freeze({
    purpose_scopes: record.purpose_scopes,
    consent_record_refs: Object.freeze([refId('consent_record_refs')]),
    policy_decision_refs: Object.freeze([refId('policy_decision_refs')]),
    purpose_token_refs: Object.freeze([refId('purpose_token_refs')]),
    capability_grant_refs: Object.freeze([refId('capability_grant_refs')]),
  });
}

function recipientCredential(
  value: unknown,
  ownerDeviceId: string,
  issuedAt: string,
  leaseExpiresAt: string,
): T03AppleCyclingRecipientCredential {
  const record = exactRecord(value, [
    'algorithm', 'audience', 'continuity_id', 'deletion', 'device_credential_ref', 'device_id',
    'device_lease_ref', 'expires_at', 'public_key', 'public_key_sha256', 'purpose',
    'realtime_session_ref', 'revocation', 'supersession',
  ], 'T03_APPLE_CYCLING_RECIPIENT_CREDENTIAL_INVALID');
  if (record.algorithm !== 'X25519' || record.purpose !== 'hpke_recipient' || record.device_id !== ownerDeviceId ||
      !X25519_PUBLIC_KEY.test(boundedString(record.public_key, 'T03_APPLE_CYCLING_RECIPIENT_KEY_INVALID', 43))) {
    fail('T03_APPLE_CYCLING_RECIPIENT_CREDENTIAL_INVALID');
  }
  const publicKey = record.public_key as string;
  const decoded = Buffer.from(publicKey, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== publicKey ||
      digest(record.public_key_sha256, 'T03_APPLE_CYCLING_RECIPIENT_KEY_INVALID') !== sha256(decoded)) {
    fail('T03_APPLE_CYCLING_RECIPIENT_KEY_INVALID');
  }
  const expiresAt = timestamp(record.expires_at, 'T03_APPLE_CYCLING_RECIPIENT_TIME_INVALID');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) > Date.parse(leaseExpiresAt) ||
      !same(record.revocation, { status: 'active' }) || record.supersession !== null || record.deletion !== null) {
    fail('T03_APPLE_CYCLING_RECIPIENT_CREDENTIAL_INVALID');
  }
  return Object.freeze({
    deviceCredentialRef: canonicalRef(record.device_credential_ref, 'DeviceCredential', 'T03_APPLE_CYCLING_RECIPIENT_REF_INVALID'),
    publicKey,
    publicKeySha256: record.public_key_sha256 as string,
    audience: opaque(record.audience, 'T03_APPLE_CYCLING_RECIPIENT_AUDIENCE_INVALID') as OpaqueGovernanceValue,
    deviceId: ownerDeviceId,
    realtimeSessionRef: canonicalRef(record.realtime_session_ref, 'RealtimeSession', 'T03_APPLE_CYCLING_RECIPIENT_SESSION_INVALID'),
    deviceLeaseRef: canonicalRef(record.device_lease_ref, 'DeviceLease', 'T03_APPLE_CYCLING_RECIPIENT_LEASE_INVALID'),
    continuityId: uuidV7(record.continuity_id, 'T03_APPLE_CYCLING_RECIPIENT_CONTINUITY_INVALID'),
    expiresAt,
  });
}

function normalizeRecord(value: unknown): NormalizedRecord {
  const candidate = isPlainRecord(value) ? value : undefined;
  const record = exactRecord(value, [
    'allowed_media_capabilities', 'capability_ref', 'consent', 'device_id', 'expires_at_utc', 'governance',
    'grant_id', 'issued_at_utc', 'lease_expires_at_utc', 'operation_scopes', 'principal_ref', 'purpose',
    'revocable', 'schema', 'scopes', 'user_id',
    ...(candidate !== undefined && Object.hasOwn(candidate, 'recipient_device_credential')
      ? ['recipient_device_credential']
      : []),
  ], 'T03_APPLE_CYCLING_RECORD_INVALID');
  if (record.schema !== T03_APPLE_CYCLING_AUTHORITY_SCHEMA || record.purpose !== T03_APPLE_CYCLING_PURPOSE ||
      record.revocable !== true) fail('T03_APPLE_CYCLING_RECORD_INVALID');
  uuidV7(record.grant_id, 'T03_APPLE_CYCLING_GRANT_INVALID');
  const issuedAt = timestamp(record.issued_at_utc, 'T03_APPLE_CYCLING_TIME_INVALID');
  const expiresAt = timestamp(record.expires_at_utc, 'T03_APPLE_CYCLING_TIME_INVALID');
  const leaseExpiresAt = timestamp(record.lease_expires_at_utc, 'T03_APPLE_CYCLING_TIME_INVALID');
  const issuedMs = timestampMs(issuedAt, 'T03_APPLE_CYCLING_TIME_INVALID');
  const expiryMs = timestampMs(expiresAt, 'T03_APPLE_CYCLING_TIME_INVALID');
  const leaseExpiryMs = timestampMs(leaseExpiresAt, 'T03_APPLE_CYCLING_TIME_INVALID');
  if (expiryMs <= issuedMs || leaseExpiryMs <= issuedMs || leaseExpiryMs > expiryMs) fail('T03_APPLE_CYCLING_TIME_INVALID');
  const userId = uuidV7(record.user_id, 'T03_APPLE_CYCLING_USER_INVALID');
  const deviceId = uuidV7(record.device_id, 'T03_APPLE_CYCLING_DEVICE_INVALID');
  const principal = opaque(record.principal_ref, 'T03_APPLE_CYCLING_PRINCIPAL_INVALID');
  const capabilityRef = opaque(record.capability_ref, 'T03_APPLE_CYCLING_CAPABILITY_REF_INVALID');
  const scopes = canonicalSubset(record.operation_scopes, OPERATIONS, 'T03_APPLE_CYCLING_SCOPE_INVALID', 'bootstrap');
  const bearerScopes = canonicalSubset(record.scopes, OPERATIONS, 'T03_APPLE_CYCLING_BEARER_SCOPE_INVALID', 'bootstrap');
  if (!same(scopes, bearerScopes)) fail('T03_APPLE_CYCLING_BEARER_SCOPE_INVALID');
  const allowedMediaCapabilities = canonicalSubset(
    record.allowed_media_capabilities,
    MEDIA,
    'T03_APPLE_CYCLING_MEDIA_CAPABILITY_INVALID',
    'data',
  );
  consent(record.consent);
  const governanceValue = governance(record.governance);
  const credential = record.recipient_device_credential === undefined
    ? undefined
    : recipientCredential(record.recipient_device_credential, deviceId, issuedAt, leaseExpiresAt);
  return Object.freeze({
    issuedAt,
    expiresAt,
    leaseExpiresAt,
    userId,
    deviceId,
    principal,
    capabilityRef,
    scopes,
    allowedMediaCapabilities,
    governance: governanceValue.snapshot,
    policyDecisionRef: governanceValue.policyDecisionRef,
    ...(credential === undefined ? {} : { recipientCredential: credential }),
  });
}

function parseRecord(bytes: Uint8Array): NormalizedRecord {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_RECORD_BYTES) {
    fail('T03_APPLE_CYCLING_RECORD_BYTES_INVALID');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('T03_APPLE_CYCLING_RECORD_ENCODING_INVALID');
  }
  if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n') || text.charCodeAt(0) === 0xfeff) {
    fail('T03_APPLE_CYCLING_RECORD_ENCODING_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1)) as unknown;
  } catch {
    return fail('T03_APPLE_CYCLING_RECORD_JSON_INVALID');
  }
  const normalized = normalizeRecord(parsed);
  if (`${canonicalJson(parsed)}\n` !== text) fail('T03_APPLE_CYCLING_RECORD_CANONICAL_INVALID');
  return normalized;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function requestedMedia(request: JsonRecord): readonly MediaCapability[] | undefined {
  const media = asRecord(request.requested_media);
  const start = asRecord(request.start);
  const modalities = start?.modalities;
  if (media === undefined || start === undefined || start.kind !== 'explicit_user_start' ||
      !Array.isArray(modalities)) return undefined;
  const selected = MEDIA.filter((name) => media[name] === true);
  if (selected.length === 0 || selected.some((name) => !modalities.includes(name)) ||
      modalities.length !== selected.length || modalities.some((name, index) => name !== selected[index])) {
    return undefined;
  }
  return Object.freeze(selected);
}

function permitSnapshot(record: NormalizedRecord): JsonRecord {
  return Object.freeze({
    status: 'available',
    decision: 'permit',
    principal: snapshotOpaqueOwnerValue(record.principal),
    device_id: record.deviceId,
    capability_ref: snapshotOpaqueOwnerValue(record.capabilityRef),
    scopes: Object.freeze([...record.scopes]),
    expires_at: record.expiresAt,
    purpose: T03_APPLE_CYCLING_PURPOSE,
    policy_decision_ref: snapshotOpaqueOwnerValue(record.policyDecisionRef),
    governance: snapshotOpaqueOwnerValue(record.governance),
    ...(record.recipientCredential === undefined ? {} : {
      device_credential: Object.freeze({
        device_credential_ref: snapshotOpaqueOwnerValue(record.recipientCredential.deviceCredentialRef),
        algorithm: 'X25519',
        purpose: 'hpke_recipient',
        public_key: record.recipientCredential.publicKey,
        public_key_sha256: record.recipientCredential.publicKeySha256,
        audience: snapshotOpaqueOwnerValue(record.recipientCredential.audience),
        device_id: record.recipientCredential.deviceId,
        realtime_session_ref: snapshotOpaqueOwnerValue(record.recipientCredential.realtimeSessionRef),
        device_lease_ref: snapshotOpaqueOwnerValue(record.recipientCredential.deviceLeaseRef),
        continuity_id: record.recipientCredential.continuityId,
        expires_at: record.recipientCredential.expiresAt,
        revocation: Object.freeze({ status: 'active' }),
        supersession: null,
        deletion: null,
      }),
    }),
  });
}

function currentAuthorityProjection(record: NormalizedRecord): T03AppleCyclingCurrentAuthorityProjection {
  return Object.freeze({
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    leaseExpiresAt: record.leaseExpiresAt,
    userId: record.userId,
    deviceId: record.deviceId,
    principal: snapshotOpaqueOwnerValue(record.principal) as OpaqueGovernanceValue,
    capabilityRef: snapshotOpaqueOwnerValue(record.capabilityRef) as OpaqueGovernanceValue,
    operations: Object.freeze([...record.scopes]),
    allowedMediaCapabilities: Object.freeze([...record.allowedMediaCapabilities]),
    purpose: T03_APPLE_CYCLING_PURPOSE,
    governance: snapshotOpaqueOwnerValue(record.governance) as OpaqueGovernanceValue,
    policyDecisionRef: snapshotOpaqueOwnerValue(record.policyDecisionRef) as OpaqueGovernanceValue,
    ...(record.recipientCredential === undefined ? {} : { recipientCredential: record.recipientCredential }),
  });
}

const DENIED = Object.freeze({ status: 'deny', decision: 'deny' });

export function createT03AppleCyclingLeaseAuthority(
  options: T03AppleCyclingLeaseAuthorityOptions,
): T03AppleCyclingLeaseAuthority {
  if (!isPlainRecord(options) || typeof options.record?.path !== 'string' || options.record.path.length===0 || options.record?.path !== (options.expectedRecordPath ?? T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH) ||
      typeof options.record.read !== 'function' || typeof options.ownerProtection?.assertOwnerProtected !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')) fail('T03_APPLE_CYCLING_OPTIONS_INVALID');
  const hasExpectedSha256 = Object.hasOwn(options, 'expectedRecordSha256');
  const hasExpectedSha256Port = Object.hasOwn(options, 'expectedRecordSha256Port');
  if (hasExpectedSha256 === hasExpectedSha256Port) fail('T03_APPLE_CYCLING_OPTIONS_INVALID');
  const expectedSha256 = hasExpectedSha256
    ? digest(options.expectedRecordSha256, 'T03_APPLE_CYCLING_EXPECTED_HASH_INVALID')
    : undefined;
  const expectedSha256Port = hasExpectedSha256Port ? options.expectedRecordSha256Port : undefined;
  if (hasExpectedSha256Port && (!isPlainRecord(expectedSha256Port) || typeof expectedSha256Port.current !== 'function')) {
    fail('T03_APPLE_CYCLING_OPTIONS_INVALID');
  }
  const readExpectedSha256 = (): string => {
    if (expectedSha256Port === undefined) return expectedSha256!;
    let value: unknown;
    try {
      value = expectedSha256Port.current();
    } catch {
      return fail('T03_APPLE_CYCLING_AUTHORITY_DRIFT');
    }
    return digest(value, 'T03_APPLE_CYCLING_RECORD_HASH_MISMATCH');
  };
  const clock = options.now ?? Date.now;
  let closed = false;

  const load = (at?: string): NormalizedRecord => {
    if (closed) fail('T03_APPLE_CYCLING_CLOSED');
    try {
      options.ownerProtection.assertOwnerProtected(options.record.path);
    } catch {
      return fail('T03_APPLE_CYCLING_OWNER_PROTECTION_INVALID');
    }
    const expectedSha256A = readExpectedSha256();
    let bytes: Uint8Array | undefined;
    try {
      bytes = options.record.read();
    } catch {
      return fail('T03_APPLE_CYCLING_RECORD_UNAVAILABLE');
    }
    if (bytes === undefined) fail('T03_APPLE_CYCLING_RECORD_MISSING');
    const observedSha256 = sha256(bytes);
    const expectedSha256B = readExpectedSha256();
    if (!sameDigest(expectedSha256A, expectedSha256B)) fail('T03_APPLE_CYCLING_AUTHORITY_DRIFT');
    if (!sameDigest(observedSha256, expectedSha256A)) fail('T03_APPLE_CYCLING_RECORD_HASH_MISMATCH');
    const record = parseRecord(bytes);
    const observedMs = at === undefined ? clock() : timestampMs(timestamp(at, 'T03_APPLE_CYCLING_CLOCK_INVALID'), 'T03_APPLE_CYCLING_CLOCK_INVALID');
    if (!Number.isSafeInteger(observedMs)) fail('T03_APPLE_CYCLING_CLOCK_INVALID');
    if (observedMs < timestampMs(record.issuedAt, 'T03_APPLE_CYCLING_TIME_INVALID') ||
        observedMs >= timestampMs(record.expiresAt, 'T03_APPLE_CYCLING_TIME_INVALID') ||
        observedMs >= timestampMs(record.leaseExpiresAt, 'T03_APPLE_CYCLING_TIME_INVALID')) {
      fail('T03_APPLE_CYCLING_AUTHORITY_EXPIRED');
    }
    return record;
  };

  const readCurrentAuthority = (atSystemTime?: string): T03AppleCyclingCurrentAuthorityProjection =>
    currentAuthorityProjection(load(atSystemTime));

  const isReady = (): boolean => {
    try {
      load();
      return true;
    } catch {
      return false;
    }
  };

  const policyPort: LeasePolicyPort = Object.freeze({
    async evaluate(input: Parameters<LeasePolicyPort['evaluate']>[0]): Promise<LeasePolicyDecision> {
      const record = load();
      const occurredAt = timestamp(input.occurredAt, 'T03_APPLE_CYCLING_REQUEST_TIME_INVALID');
      const occurredMs = timestampMs(occurredAt, 'T03_APPLE_CYCLING_REQUEST_TIME_INVALID');
      if (input.userId !== record.userId) fail('T03_APPLE_CYCLING_USER_MISMATCH');
      if (input.deviceId !== record.deviceId) fail('T03_APPLE_CYCLING_DEVICE_MISMATCH');
      if (input.purpose !== T03_APPLE_CYCLING_PURPOSE) fail('T03_APPLE_CYCLING_PURPOSE_MISMATCH');
      const requested = canonicalSubset(input.capabilities, MEDIA, 'T03_APPLE_CYCLING_REQUEST_CAPABILITY_INVALID', 'data');
      if (requested.some((item) => !record.allowedMediaCapabilities.includes(item))) {
        fail('T03_APPLE_CYCLING_REQUEST_CAPABILITY_DENIED');
      }
      if (!same(input.governance, wireGovernance(record.governance))) fail('T03_APPLE_CYCLING_GOVERNANCE_MISMATCH');
      if (occurredMs < timestampMs(record.issuedAt, 'T03_APPLE_CYCLING_TIME_INVALID') ||
          occurredMs >= timestampMs(record.leaseExpiresAt, 'T03_APPLE_CYCLING_TIME_INVALID')) {
        fail('T03_APPLE_CYCLING_REQUEST_TIME_INVALID');
      }
      return Object.freeze({
        allowed: true,
        policyDecisionRef: snapshotOpaqueOwnerValue(record.policyDecisionRef) as OpaqueGovernanceValue,
        capabilities: Object.freeze([...requested]),
        purpose: T03_APPLE_CYCLING_PURPOSE,
        leaseExpiresAt: assertCanonicalTimestamp(record.leaseExpiresAt),
        revocable: true,
      });
    },
  });

  const authoritySnapshot: T03AuthoritySnapshotPort = Object.freeze({
    async resolve(input: T03AuthoritySnapshotResolveInput): Promise<unknown> {
      const record = load(input.atSystemTime);
      if (!record.scopes.includes(input.operation as Operation)) return DENIED;
      const bearer = asRecord(input.bearer);
      const request = asRecord(input.request);
      const wire = wireGovernance(record.governance);
      if (bearer === undefined || request === undefined || !same(bearer.principal, record.principal) ||
          bearer.deviceId !== record.deviceId || !same(bearer.capabilityRef, record.capabilityRef) ||
          !same(bearer.scopes, record.scopes) || !same(request.governance, wire)) return DENIED;
      if (input.operation === 'bootstrap') {
        if ((request.bootstrap_mode !== 'initial' && request.bootstrap_mode !== 'fully_disconnected') ||
            request.device_id !== record.deviceId ||
            asRecord(request.start)?.device_id !== record.deviceId) return DENIED;
        const media = requestedMedia(request);
        if (media === undefined || !media.includes('data') ||
            media.some((item) => !record.allowedMediaCapabilities.includes(item))) return DENIED;
      }
      return permitSnapshot(record);
    },
  });

  const policy: ProductionPortRegistration<LeasePolicyPort> = Object.freeze({
    port: policyPort,
    readiness: Object.freeze({
      owner: OWNER,
      environment: 'production' as const,
      isReady,
      reason: 'T03_APPLE_CYCLING_AUTHORITY_NOT_READY',
    }),
    close: () => { closed = true; },
  });

  return Object.freeze({
    formalWatchPrimaryAuthority: Object.freeze({
      resolve: async (authenticatedBearer: unknown) => {
        const record = load();
        const bearer = asRecord(authenticatedBearer);
        if (bearer === undefined || !same(bearer.principal, record.principal) ||
            bearer.deviceId !== record.deviceId || !same(bearer.capabilityRef, record.capabilityRef) ||
            !same(bearer.scopes, record.scopes) || !record.scopes.includes('bootstrap') ||
            !record.allowedMediaCapabilities.includes('data')) fail('T03_APPLE_CYCLING_FORMAL_WATCH_AUTHORITY_DENIED');
        return Object.freeze({ userId: record.userId, deviceId: record.deviceId,
          principalRef: snapshotOpaqueOwnerValue(record.principal), expiresAt: record.expiresAt, purpose: T03_APPLE_CYCLING_PURPOSE,
          policyDecisionRef: snapshotOpaqueOwnerValue(record.policyDecisionRef), capabilities: Object.freeze([...record.allowedMediaCapabilities]) });
      },
    }),
    policy,
    authoritySnapshot,
    readCurrentAuthority,
    currentAuthority: readCurrentAuthority,
    isReady,
    close: () => { closed = true; },
  });
}

export const T03_APPLE_CYCLING_OPERATIONS = OPERATIONS;
export const T03_APPLE_CYCLING_MEDIA_CAPABILITIES = MEDIA;
