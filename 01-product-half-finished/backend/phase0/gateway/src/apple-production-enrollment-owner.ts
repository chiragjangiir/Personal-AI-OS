import { configuredPublicApiOrigin } from './public-api-origins.ts';
import { assertAppleFormalWatchBindingReceipt, createApplePhysicalCanaryBindingPostgres, type AppleFormalWatchPairState, type AppleFormalWatchBindingReceipt } from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import { createProductionRealtimeCanonicalDeviceIdentityIssuer } from '../../../services/platform-data/src/realtime-canonical-device-issuer.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanonicalObjectVersionRef } from '../../../services/memory-os/src/canonical-ref.ts';
import {
  closePostgresPool,
  createPostgresPool,
  type PostgresPoolOptions,
} from '../../../services/platform-data/src/postgres-pool.ts';
import { createRealtimeAuthorityRepository } from '../../../services/platform-data/src/realtime-authority-repository.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import { withTransaction } from '../../../services/platform-data/src/transaction.ts';
import type { RealtimeIdentityPort } from '../../../services/realtime-core/src/ports.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';

import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import { createRealtimeSchemaRegistry, type RealtimeSchemaRegistry } from './realtime-public-control-controller.ts';
import { validateAppleProductionEnrollmentBundle } from './apple-production-enrollment-bundle.ts';
export { validateAppleProductionEnrollmentBundle };
import {
  createT03AppleCyclingLeaseAuthority,
  T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,
  T03_APPLE_CYCLING_AUTHORITY_SCHEMA,
  T03_APPLE_CYCLING_PURPOSE,
  type T03AppleCyclingExpectedRecordSha256Port,
} from './t03-apple-cycling-lease-authority.ts';

type JsonRecord = Record<string, unknown>;
type ClockValue = number | string | Date;
type RuntimePool = ReturnType<typeof createPostgresPool>;
type OperationKey =
  | 'bootstrap'
  | 'realtime_e2ee_key_resolve'
  | 'connected_credential_refresh'
  | 'media_stop'
  | 'end_continuity';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const B64URL_RAW32 = /^[A-Za-z0-9_-]{43}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/u;
const ALIAS_PART = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const REGISTRATION_SCHEMA = 'paios.realtime-e2ee-recipient-registration.v1' as const;
const BUNDLE_SCHEMA = 'paios.realtime-production-enrollment-bundle.v1' as const;
// Legacy enrollment stores its bundle here; paired-device enrollment uses configured public_api_url.
const BUNDLE_RELATIVE_PATH = '.runtime\\apple-production-enrollment\\apple-production-enrollment-bundle.v1.json' as const;
const MAX_REGISTRATION_BYTES = 16 * 1024;
const MAX_REGISTRATION_AGE_MS = 15 * 60 * 1000;
const MAX_REGISTRATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_BUNDLE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_AUTHORITY_BYTES = 65_536;
const ROUTES: Readonly<Record<OperationKey, string>> = Object.freeze({
  bootstrap: '/v1/realtime/bootstrap',
  realtime_e2ee_key_resolve: '/v1/realtime/e2ee/key/resolve',
  connected_credential_refresh: '/v1/realtime/credentials/refresh',
  media_stop: '/v1/realtime/media/stop',
  end_continuity: '/v1/realtime/end-continuity',
});
const SCHEMA_FILES: Readonly<Record<OperationKey, string>> = Object.freeze({
  bootstrap: 'realtime-bootstrap-request.v1.schema.json',
  realtime_e2ee_key_resolve: 'realtime-e2ee-key-resolve-request.v1.schema.json',
  connected_credential_refresh: 'realtime-credential-refresh-request.v1.schema.json',
  media_stop: 'realtime-media-stop-request.v1.schema.json',
  end_continuity: 'realtime-end-continuity-request.v1.schema.json',
});
const PROFILE_SLUGS: Readonly<Record<OperationKey, string>> = Object.freeze({
  bootstrap: 'bootstrap',
  realtime_e2ee_key_resolve: 'e2ee-key-resolve',
  connected_credential_refresh: 'credential-refresh',
  media_stop: 'media-stop',
  end_continuity: 'end-continuity',
});
const OPERATIONS = Object.freeze(Object.keys(ROUTES) as OperationKey[]);
// Existing authority grants can carry the retired scope; it does not produce a request body.
const AUTHORITY_SCOPES = Object.freeze([...OPERATIONS, 'handoff']);
const MEDIA = Object.freeze(['audio', 'video', 'data'] as const);
const FORBIDDEN_EXACT_KEYS = new Set([
  'api_key', 'api_secret', 'bearer', 'key_material', 'password', 'plaintext', 'private_key', 'secret',
]);

export const APPLE_PRODUCTION_ENROLLMENT_BUNDLE_PATH = BUNDLE_RELATIVE_PATH;
export const APPLE_PRODUCTION_ENROLLMENT_BUNDLE_SCHEMA = BUNDLE_SCHEMA;
export const APPLE_PRODUCTION_ENROLLMENT_ORIGIN = configuredPublicApiOrigin;
export const APPLE_E2EE_RECIPIENT_REGISTRATION_SCHEMA = REGISTRATION_SCHEMA;
export const APPLE_E2EE_REGISTRATION_MAX_AGE_MS = MAX_REGISTRATION_AGE_MS;

export class AppleProductionEnrollmentOwnerError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = 'AppleProductionEnrollmentOwnerError';
    this.code = code;
  }
}

/** A reader that has already established owner-only access to the Mac export. */
export interface ApplePublicRegistrationFileReader {
  readonly path: string;
  readonly read: () => Uint8Array | undefined;
  readonly assertOwnerProtected: (path: string) => void;
}

/**
 * The issuer is the T03 owner seam.  It must be backed by an owner UUIDv7
 * allocator and a CVR issuer; T02 identity and any Apple-local UUID are not
 * accepted at this boundary.
 */
export interface AppleProductionEnrollmentOwnerIssuer {
  readonly issueUuidV7: (input: {
    readonly purpose: string;
    readonly occurredAt: string;
  }) => string;
  readonly issueCanonicalObjectVersionRef: (input: {
    readonly refType: 'DeviceCredential';
    readonly refId: string;
    readonly objectVersion: '1';
    readonly canonicalPayloadSha256: string;
  }) => unknown;
}

export interface AppleProductionEnrollmentOwnerClock {
  readonly now: () => ClockValue;
}

export interface AppleAuthorityHashPort extends T03AppleCyclingExpectedRecordSha256Port {
  readonly updateAfterCommit: (input: Readonly<{ readonly previousSha256: string; readonly nextSha256: string }>) => void | Promise<void>;
}

/**
 * One call must read the exact current row set from one PostgreSQL 18
 * `REPEATABLE READ READ ONLY` snapshot.  `readCurrentBindingSnapshot` is the
 * explicit name; `readCurrentBinding` is accepted for existing repository
 * adapters that document the same transaction contract.
 */
export interface AppleCurrentBindingSnapshotProvider {
  readonly readCurrentBindingSnapshotInAdmission?: (client: import('../../../services/platform-data/src/realtime-credential-fence.ts').CredentialFenceAdmissionClient) => Promise<AppleCurrentBindingSnapshotEnvelope | undefined>;
  readonly readCurrentBindingSnapshot?: (lookup?: { readonly continuityId: string }) =>
    Promise<AppleCurrentBindingSnapshotResult | readonly AppleCurrentBindingSnapshotResult[] | undefined>;
  readonly readCurrentBinding?: (lookup?: { readonly continuityId: string }) =>
    Promise<AppleCurrentBindingSnapshotResult | readonly AppleCurrentBindingSnapshotResult[] | undefined>;
  readonly snapshotIsolation?: 'REPEATABLE READ';
  readonly readOnly?: true;
}

/** Optional metadata is authoritative only when returned by the same snapshot. */
export interface AppleCurrentBindingSnapshotEnvelope {
  readonly formalWatchBinding?: AppleFormalWatchBindingReceipt;
  readonly formalWatchPairState?: AppleFormalWatchPairState;
  readonly binding: RealtimeCurrentBindingProjection;
  readonly transportAliases?: readonly unknown[];
  readonly participantAudience?: unknown;
  readonly handoffDeviceId?: string;
  readonly toDeviceId?: string;
}

export type AppleCurrentBindingSnapshotResult =
  | RealtimeCurrentBindingProjection
  | AppleCurrentBindingSnapshotEnvelope;

interface AppleProductionEnrollmentOwnerCommonOptions {
  readonly authorityPath: string;
  readonly expectedAuthoritySha256: string;
  readonly currentBinding: AppleCurrentBindingSnapshotProvider;
  readonly issuer: AppleProductionEnrollmentOwnerIssuer;
  readonly clock: AppleProductionEnrollmentOwnerClock;
  readonly outputPath: string;
  readonly authorityHashPort: AppleAuthorityHashPort;
  readonly schemaRegistry?: RealtimeSchemaRegistry;
}

export type AppleProductionEnrollmentOwnerOptions = AppleProductionEnrollmentOwnerCommonOptions & (
  | Readonly<{
      readonly registration: ApplePublicRegistrationFileReader;
      readonly reuseCurrentRecipient?: never;
    }>
  | Readonly<{
      readonly registration?: never;
      readonly reuseCurrentRecipient: true;
    }>
);

interface AppleRecipientPublicKey {
  readonly publicRaw32Base64url: string;
  readonly publicRaw32: Uint8Array;
  readonly publicSha256: string;
}

export interface ApplePublicRegistration extends AppleRecipientPublicKey {
  readonly schema: typeof REGISTRATION_SCHEMA;
  readonly localSlotRefHash: string;
  readonly createdAt: string;
}

export interface AppleProductionEnrollmentPrepared {
  readonly authorityPath: string;
  readonly outputPath: string;
  readonly previousAuthoritySha256: string;
  readonly nextAuthoritySha256: string;
  readonly bundleSha256: string;
  readonly authorityBytes: Uint8Array;
  readonly bundleBytes: Uint8Array;
  readonly snapshotFingerprint: string;
  readonly credentialRef: JsonRecord;
  readonly expiresAt: string;
  readonly canonicalBodySha256: Readonly<Partial<Record<OperationKey, string>>>;
}

export interface AppleProductionEnrollmentCommitReceipt {
  readonly status: 'committed' | 'replayed';
  readonly authorityPath: string;
  readonly outputPath: string;
  readonly authoritySha256: string;
  readonly bundleSha256: string;
  readonly canonicalBodyCount?: number;
  readonly credentialRef: JsonRecord;
  readonly expiresAt: string;
}

export interface AppleProductionEnrollmentOwner {
  readonly prepare: () => Promise<AppleProductionEnrollmentPrepared>;
  readonly commit: (prepared: AppleProductionEnrollmentPrepared) => Promise<AppleProductionEnrollmentCommitReceipt>;
  readonly run: (mode?: 'prepare' | 'commit') => Promise<AppleProductionEnrollmentPrepared | AppleProductionEnrollmentCommitReceipt>;
}

interface ParsedAuthority {
  readonly value: JsonRecord;
  readonly governance: JsonRecord;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly allowedMedia: readonly string[];
  readonly policyDecisionRef: JsonRecord;
}

interface NormalizedCurrent {
  readonly formalWatchBinding?: AppleFormalWatchBindingReceipt;
  readonly formalWatchPairState?: AppleFormalWatchPairState;
  readonly binding: RealtimeCurrentBindingProjection;
  readonly aliases: readonly JsonRecord[];
  readonly participantAudience: JsonRecord;
  readonly handoffDeviceId?: string;
  readonly fingerprint: string;
}

interface BodyEntry {
  readonly route: string;
  readonly body_base64: string;
  readonly body_sha256: string;
}

interface BodyResult {
  readonly bodies: Readonly<Partial<Record<OperationKey, JsonRecord>>>;
  readonly entries: Readonly<Partial<Record<OperationKey, BodyEntry>>>;
  readonly hashes: Readonly<Partial<Record<OperationKey, string>>>;
}

function fail(code: string, cause?: unknown): never {
  throw new AppleProductionEnrollmentOwnerError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail(code);
  const actual = Object.keys(value).sort();
  const names = [...expected].sort();
  if (actual.length !== names.length || actual.some((key, index) => key !== names[index])) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined ||
        descriptor.set !== undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(code);
  }
  return value;
}

function stringValue(value: unknown, code: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value ||
      value.includes('\u0000')) fail(code);
  return value;
}

function uuidV7(value: unknown, code: string): string {
  const result = stringValue(value, code, 36);
  if (!UUID_V7.test(result)) fail(code);
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
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('APPLE_ENROLLMENT_NON_JCS_NUMBER');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || seen.has(value)) fail('APPLE_ENROLLMENT_VALUE_INVALID');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    if (!isPlainRecord(value)) fail('APPLE_ENROLLMENT_VALUE_INVALID');
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      if (FORBIDDEN_EXACT_KEYS.has(key.toLowerCase())) fail('APPLE_ENROLLMENT_SECRET_FIELD_FORBIDDEN');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined ||
          descriptor.set !== undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('APPLE_ENROLLMENT_VALUE_INVALID');
      }
      return `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`;
    }).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function timestamp(value: unknown, code: string): string {
  const result = stringValue(value, code, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/u.test(result) ||
      !Number.isSafeInteger(Date.parse(result))) fail(code);
  return result;
}

function clockMillis(clock: AppleProductionEnrollmentOwnerClock): number {
  let value: ClockValue;
  try {
    value = clock.now();
  } catch (error) {
    return fail('APPLE_ENROLLMENT_CLOCK_INVALID', error);
  }
  const millis = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(millis)) fail('APPLE_ENROLLMENT_CLOCK_INVALID');
  return millis;
}

function exactArray(value: unknown, code: string, allowed?: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) fail(code);
  const result = value as string[];
  if (new Set(result).size !== result.length) fail(code);
  if (allowed !== undefined) {
    const expected = allowed.filter((item) => result.includes(item));
    if (expected.length !== result.length || expected.some((item, index) => item !== result[index])) fail(code);
  }
  return Object.freeze([...result]);
}

function cvr(value: unknown, expectedType: string, code: string): JsonRecord {
  const record = exactKeys(value, ['ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256'], code);
  if (record.ref_type !== expectedType || !UUID_V7.test(stringValue(record.ref_id, code, 36)) ||
      !DECIMAL.test(stringValue(record.object_version, code, 38)) || !SHA256.test(stringValue(record.canonical_payload_sha256, code, 64))) {
    fail(code);
  }
  return cloneJson(record);
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function parseJsonBytes(bytes: Uint8Array, code: string, allowTrailingNewline = false): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 131_072) fail(code);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return fail(`${code}_ENCODING`, error);
  }
  if (text.charCodeAt(0) === 0xfeff || text.includes('\r')) fail(`${code}_ENCODING`);
  const jsonText = allowTrailingNewline && text.endsWith('\n') ? text.slice(0, -1) : text;
  if (jsonText.trim() !== jsonText) fail(`${code}_ENCODING`);
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    return fail(`${code}_JSON`, error);
  }
}

function parseRegistration(bytes: Uint8Array, nowMs: number, allowStale = false): ApplePublicRegistration {
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_REGISTRATION_BYTES) fail('APPLE_ENROLLMENT_REGISTRATION_BYTES_INVALID');
  const value = exactKeys(parseJsonBytes(bytes, 'APPLE_ENROLLMENT_REGISTRATION'), [
    'schema', 'public_raw32_base64url', 'public_sha256', 'local_slot_ref_hash', 'created_at',
  ], 'APPLE_ENROLLMENT_REGISTRATION_SCHEMA_INVALID');
  if (value.schema !== REGISTRATION_SCHEMA) fail('APPLE_ENROLLMENT_REGISTRATION_SCHEMA_INVALID');
  const encoded = stringValue(value.public_raw32_base64url, 'APPLE_ENROLLMENT_PUBLIC_KEY_INVALID', 43);
  if (!B64URL_RAW32.test(encoded)) fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID');
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, 'base64url');
  } catch (error) {
    return fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID', error);
  }
  if (raw.byteLength !== 32 || raw.toString('base64url') !== encoded) fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID');
  const publicSha256 = digest(value.public_sha256, 'APPLE_ENROLLMENT_PUBLIC_KEY_HASH_INVALID');
  if (!sameDigest(publicSha256, sha256(raw))) fail('APPLE_ENROLLMENT_PUBLIC_KEY_HASH_INVALID');
  const localSlotRefHash = digest(value.local_slot_ref_hash, 'APPLE_ENROLLMENT_SLOT_HASH_INVALID');
  const createdAt = timestamp(value.created_at, 'APPLE_ENROLLMENT_REGISTRATION_TIME_INVALID');
  const createdMs = Date.parse(createdAt);
  if (createdMs > nowMs + MAX_REGISTRATION_CLOCK_SKEW_MS) fail('APPLE_ENROLLMENT_REGISTRATION_FROM_FUTURE');
  if (!allowStale && nowMs - createdMs > MAX_REGISTRATION_AGE_MS) fail('APPLE_ENROLLMENT_REGISTRATION_STALE');
  return Object.freeze({
    schema: REGISTRATION_SCHEMA,
    publicRaw32Base64url: encoded,
    publicRaw32: new Uint8Array(raw),
    publicSha256,
    localSlotRefHash,
    createdAt,
  });
}

function authorityGovernance(value: unknown): { readonly governance: JsonRecord; readonly policyDecisionRef: JsonRecord } {
  const governance = exactKeys(value, [
    'purpose_scopes', 'consent_record_refs', 'policy_decision_refs', 'purpose_token_refs', 'capability_grant_refs',
  ], 'APPLE_ENROLLMENT_AUTHORITY_GOVERNANCE_INVALID');
  if (canonicalJson(governance.purpose_scopes) !== canonicalJson([T03_APPLE_CYCLING_PURPOSE])) {
    fail('APPLE_ENROLLMENT_AUTHORITY_GOVERNANCE_INVALID');
  }
  const consent = governance.consent_record_refs;
  const decisions = governance.policy_decision_refs;
  const tokens = governance.purpose_token_refs;
  const grants = governance.capability_grant_refs;
  if (!Array.isArray(consent) || consent.length === 0 || !Array.isArray(decisions) || decisions.length === 0 ||
      !Array.isArray(tokens) || tokens.length === 0 || !Array.isArray(grants) || grants.length === 0) fail('APPLE_ENROLLMENT_AUTHORITY_GOVERNANCE_INVALID');
  const decisionRefs = decisions.map((item) => cvr(item, 'PolicyDecision', 'APPLE_ENROLLMENT_AUTHORITY_POLICY_REF_INVALID'));
  tokens.forEach((item) => { cvr(item, 'PurposeToken', 'APPLE_ENROLLMENT_AUTHORITY_PURPOSE_TOKEN_INVALID'); });
  grants.forEach((item) => { cvr(item, 'CapabilityGrant', 'APPLE_ENROLLMENT_AUTHORITY_CAPABILITY_REF_INVALID'); });
  consent.forEach((item) => { cvr(item, 'ConsentRecord', 'APPLE_ENROLLMENT_AUTHORITY_CONSENT_REF_INVALID'); });
  consent.forEach((item) => { cvr(item, 'ConsentRecord', 'APPLE_ENROLLMENT_AUTHORITY_CONSENT_REF_INVALID'); });
  return Object.freeze({ governance: cloneJson(governance), policyDecisionRef: decisionRefs[0]! });
}

function parseAuthority(bytes: Uint8Array, nowMs: number): ParsedAuthority {
  if (bytes.byteLength > MAX_AUTHORITY_BYTES) fail('APPLE_ENROLLMENT_AUTHORITY_BYTES_INVALID');
  const parsed = parseJsonBytes(bytes, 'APPLE_ENROLLMENT_AUTHORITY', true);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('APPLE_ENROLLMENT_AUTHORITY_SCHEMA_INVALID');
  const keys = Object.keys(parsed);
  const baseKeys = [
    'allowed_media_capabilities', 'capability_ref', 'consent', 'device_id', 'expires_at_utc', 'governance',
    'grant_id', 'issued_at_utc', 'lease_expires_at_utc', 'operation_scopes', 'principal_ref', 'purpose',
    'revocable', 'schema', 'scopes', 'user_id',
  ];
  if (keys.some((key) => !baseKeys.includes(key) && key !== 'recipient_device_credential') ||
      keys.filter((key) => key !== 'recipient_device_credential').length !== baseKeys.length ||
      (keys.includes('recipient_device_credential') && keys.filter((key) => key === 'recipient_device_credential').length !== 1)) {
    fail('APPLE_ENROLLMENT_AUTHORITY_SCHEMA_INVALID');
  }
  const value = parsed as JsonRecord;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return fail('APPLE_ENROLLMENT_AUTHORITY_ENCODING_INVALID', error);
  }
  if (!text.endsWith('\n') || `${canonicalJson(value)}\n` !== text) fail('APPLE_ENROLLMENT_AUTHORITY_CANONICAL_INVALID');
  if (value.schema !== T03_APPLE_CYCLING_AUTHORITY_SCHEMA || value.purpose !== T03_APPLE_CYCLING_PURPOSE ||
      value.revocable !== true) fail('APPLE_ENROLLMENT_AUTHORITY_SCHEMA_INVALID');
  uuidV7(value.grant_id, 'APPLE_ENROLLMENT_AUTHORITY_GRANT_INVALID');
  const issuedAt = timestamp(value.issued_at_utc, 'APPLE_ENROLLMENT_AUTHORITY_TIME_INVALID');
  const expiresAt = timestamp(value.expires_at_utc, 'APPLE_ENROLLMENT_AUTHORITY_TIME_INVALID');
  const leaseExpiresAt = timestamp(value.lease_expires_at_utc, 'APPLE_ENROLLMENT_AUTHORITY_TIME_INVALID');
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  const leaseExpiresMs = Date.parse(leaseExpiresAt);
  if (nowMs < issuedMs || issuedMs >= expiresMs || issuedMs >= leaseExpiresMs || leaseExpiresMs > expiresMs || nowMs >= expiresMs || nowMs >= leaseExpiresMs) {
    fail('APPLE_ENROLLMENT_AUTHORITY_EXPIRED');
  }
  const userId = uuidV7(value.user_id, 'APPLE_ENROLLMENT_AUTHORITY_USER_INVALID');
  const deviceId = uuidV7(value.device_id, 'APPLE_ENROLLMENT_AUTHORITY_DEVICE_INVALID');
  cvr(value.capability_ref, 'CapabilityGrant', 'APPLE_ENROLLMENT_AUTHORITY_CAPABILITY_REF_INVALID');
  if (typeof value.principal_ref === 'string') uuidV7(value.principal_ref, 'APPLE_ENROLLMENT_AUTHORITY_PRINCIPAL_INVALID');
  else cvr(value.principal_ref, 'Principal', 'APPLE_ENROLLMENT_AUTHORITY_PRINCIPAL_INVALID');
  const allowedMedia = exactArray(value.allowed_media_capabilities, 'APPLE_ENROLLMENT_AUTHORITY_MEDIA_INVALID', MEDIA);
  const scopes = exactArray(value.operation_scopes, 'APPLE_ENROLLMENT_AUTHORITY_SCOPE_INVALID', AUTHORITY_SCOPES);
  const bearerScopes = exactArray(value.scopes, 'APPLE_ENROLLMENT_AUTHORITY_SCOPE_INVALID', AUTHORITY_SCOPES);
  if (canonicalJson(scopes) !== canonicalJson(bearerScopes)) fail('APPLE_ENROLLMENT_AUTHORITY_SCOPE_INVALID');
  const governanceValue = authorityGovernance(value.governance);
  exactKeys(value.consent, [
    'audio_capture', 'background_health', 'background_location', 'iphone_motion', 'navigation',
    'video_capture', 'watch_workout_metrics',
  ], 'APPLE_ENROLLMENT_AUTHORITY_CONSENT_INVALID');
  if (Object.hasOwn(value, 'recipient_device_credential')) {
    validateExistingRecipient(value.recipient_device_credential, deviceId, leaseExpiresAt, issuedAt);
  }
  return Object.freeze({
    value: cloneJson(value), governance: governanceValue.governance, issuedAt, expiresAt, leaseExpiresAt,
    userId, deviceId, allowedMedia, policyDecisionRef: governanceValue.policyDecisionRef,
  });
}

function validateOpaqueAlias(value: unknown, code: string): JsonRecord {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['alias_type', 'issuer', 'value', 'provider_id'].includes(key)) ||
      !Object.hasOwn(value, 'alias_type') || !Object.hasOwn(value, 'issuer') || !Object.hasOwn(value, 'value')) fail(code);
  const alias = value;
  if (!ALIAS_PART.test(stringValue(alias.alias_type, code, 80)) || !ALIAS_PART.test(stringValue(alias.issuer, code, 80)) ||
      stringValue(alias.value, code, 512).length === 0) fail(code);
  if (Object.hasOwn(alias, 'provider_id')) uuidV7(alias.provider_id, code);
  return cloneJson(alias);
}

function validateExistingRecipient(value: unknown, ownerDeviceId: string, leaseExpiresAt: string, issuedAt: string): void {
  const recipient = exactKeys(value, [
    'algorithm', 'audience', 'continuity_id', 'deletion', 'device_credential_ref', 'device_id', 'device_lease_ref',
    'expires_at', 'public_key', 'public_key_sha256', 'purpose', 'realtime_session_ref', 'revocation', 'supersession',
  ], 'APPLE_ENROLLMENT_RECIPIENT_INVALID');
  if (recipient.algorithm !== 'X25519' || recipient.purpose !== 'hpke_recipient' || recipient.device_id !== ownerDeviceId ||
      recipient.deletion !== null || recipient.supersession !== null || !isPlainRecord(recipient.revocation) || recipient.revocation.status !== 'active') {
    fail('APPLE_ENROLLMENT_RECIPIENT_INVALID');
  }
  cvr(recipient.device_credential_ref, 'DeviceCredential', 'APPLE_ENROLLMENT_CREDENTIAL_REF_INVALID');
  cvr(recipient.realtime_session_ref, 'RealtimeSession', 'APPLE_ENROLLMENT_SESSION_REF_INVALID');
  cvr(recipient.device_lease_ref, 'DeviceLease', 'APPLE_ENROLLMENT_LEASE_REF_INVALID');
  uuidV7(recipient.continuity_id, 'APPLE_ENROLLMENT_RECIPIENT_CONTINUITY_INVALID');
  const key = stringValue(recipient.public_key, 'APPLE_ENROLLMENT_PUBLIC_KEY_INVALID', 43);
  const keyBytes = Buffer.from(key, 'base64url');
  if (!B64URL_RAW32.test(key) || keyBytes.byteLength !== 32 || sha256(keyBytes) !== recipient.public_key_sha256) fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID');
  digest(recipient.public_key_sha256, 'APPLE_ENROLLMENT_PUBLIC_KEY_HASH_INVALID');
  const credentialExpiresAt = timestamp(recipient.expires_at, 'APPLE_ENROLLMENT_RECIPIENT_EXPIRY_INVALID');
  if (Date.parse(credentialExpiresAt) > Date.parse(leaseExpiresAt) || Date.parse(credentialExpiresAt) <= Date.parse(issuedAt)) {
    fail('APPLE_ENROLLMENT_RECIPIENT_EXPIRY_INVALID');
  }
}

function aliasFromBinding(value: unknown, role: 'session' | 'room' | 'participant' | 'provider', code: string): JsonRecord {
  if (isPlainRecord(value) && Object.hasOwn(value, 'alias_type')) return validateOpaqueAlias(value, code);
  if (isPlainRecord(value) && Object.hasOwn(value, 'provider') && Object.hasOwn(value, 'value')) {
    const provider = stringValue(value.provider, code, 80);
    return validateOpaqueAlias({
      alias_type: role === 'session' ? 'transport_session' : role === 'participant' ? 'participant' : role,
      issuer: provider,
      value: stringValue(value.value, code, 512),
    }, code);
  }
  return validateOpaqueAlias({
    alias_type: role === 'session' ? 'transport_session' : role === 'participant' ? 'participant' : role,
    issuer: 'livekit_cloud',
    value: stringValue(value, code, 512),
  }, code);
}

function aliasSort(left: JsonRecord, right: JsonRecord): number {
  for (const key of ['alias_type', 'issuer', 'value', 'provider_id'] as const) {
    const a = Buffer.from(String(left[key] ?? ''), 'utf8');
    const b = Buffer.from(String(right[key] ?? ''), 'utf8');
    const compared = Buffer.compare(a, b);
    if (compared !== 0) return compared;
  }
  return 0;
}

function normalizeAliases(current: RealtimeCurrentBindingProjection, supplied: readonly unknown[] | undefined): readonly JsonRecord[] {
  const raw = supplied === undefined
    ? [
      aliasFromBinding(current.session.binding.transportSessionAlias, 'session', 'APPLE_ENROLLMENT_ALIAS_INVALID'),
      aliasFromBinding(current.session.binding.roomAlias, 'room', 'APPLE_ENROLLMENT_ALIAS_INVALID'),
      aliasFromBinding(current.session.binding.deviceAlias, 'participant', 'APPLE_ENROLLMENT_ALIAS_INVALID'),
    ]
    : supplied.map((item) => validateOpaqueAlias(item, 'APPLE_ENROLLMENT_ALIAS_INVALID'));
  const aliases = raw.slice().sort(aliasSort);
  if (aliases.length === 0 || aliases.some((item, index) => index > 0 && aliasSort(aliases[index - 1]!, item) === 0)) {
    fail('APPLE_ENROLLMENT_ALIAS_INVALID');
  }
  return Object.freeze(aliases.map((item) => Object.freeze(item)));
}

function normalizeCurrent(result: AppleCurrentBindingSnapshotResult | readonly AppleCurrentBindingSnapshotResult[] | undefined, nowMs: number): NormalizedCurrent {
  if (result === undefined) fail('APPLE_ENROLLMENT_CURRENT_BINDING_MISSING');
  if (Array.isArray(result)) {
    if (result.length === 0) fail('APPLE_ENROLLMENT_CURRENT_BINDING_MISSING');
    if (result.length !== 1) fail('APPLE_ENROLLMENT_CURRENT_BINDING_CONFLICT');
    return normalizeCurrent(result[0], nowMs);
  }
  const envelope = isPlainRecord(result) && isPlainRecord(result.binding) ? result as AppleCurrentBindingSnapshotEnvelope : undefined;
  const current = envelope?.binding ?? result as RealtimeCurrentBindingProjection;
  if (!isPlainRecord(current) || !isPlainRecord(current.session) || !isPlainRecord(current.lease) || !isPlainRecord(current.session.binding)) {
    fail('APPLE_ENROLLMENT_CURRENT_BINDING_INVALID');
  }
  const session = current.session;
  const lease = current.lease;
  const transport = session.binding;
  if (session.state !== 'active' || session.continuityState !== 'active' || transport.state !== 'connected' || lease.state !== 'active' ||
      !same(session.realtimeSessionRef, lease.realtimeSessionRef) || !same(session.realtimeSessionRef, transport.realtimeSessionRef) ||
      !same(session.activeDeviceLeaseRef, lease.deviceLeaseRef) || !same(lease.deviceLeaseRef, transport.deviceLeaseRef) ||
      session.userId !== lease.userId || session.continuityId !== lease.continuityId || session.continuityId !== transport.continuityId ||
      session.activeDeviceId !== lease.deviceId || session.activeDeviceId !== transport.deviceId ||
      session.connectionEpoch !== transport.connectionEpoch || lease.purpose !== T03_APPLE_CYCLING_PURPOSE ||
      !UUID_V7.test(session.userId) || !UUID_V7.test(session.activeDeviceId) || !UUID_V7.test(session.continuityId) ||
      !DECIMAL.test(String(session.connectionEpoch)) || !DECIMAL.test(String(lease.leaseVersion)) ||
      !DECIMAL.test(String(lease.fencingToken)) || typeof transport.connectionId !== 'string' || transport.connectionId.length === 0) {
    fail('APPLE_ENROLLMENT_CURRENT_BINDING_INVALID');
  }
  const continuityExpiresAt = timestamp(session.continuityExpiresAt, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID');
  const leaseIssuedAt = timestamp(lease.issuedAt, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID');
  const leaseExpiresAt = timestamp(lease.expiresAt, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID');
  if (nowMs < Date.parse(leaseIssuedAt) || nowMs >= Date.parse(continuityExpiresAt) || nowMs >= Date.parse(leaseExpiresAt)) {
    fail('APPLE_ENROLLMENT_CURRENT_BINDING_EXPIRED');
  }
  if (!Array.isArray(lease.capabilities) || lease.capabilities.length === 0 || lease.capabilities.some((item) => typeof item !== 'string')) {
    fail('APPLE_ENROLLMENT_CURRENT_CAPABILITIES_INVALID');
  }
  const aliases = normalizeAliases(current, envelope?.transportAliases);
  const participantAudience = envelope?.participantAudience === undefined
    ? aliases.find((item) => item.alias_type === 'participant')
    : validateOpaqueAlias(envelope.participantAudience, 'APPLE_ENROLLMENT_AUDIENCE_INVALID');
  if (participantAudience === undefined) fail('APPLE_ENROLLMENT_AUDIENCE_MISSING');
  if (!aliases.some((alias) => same(alias, participantAudience))) fail('APPLE_ENROLLMENT_AUDIENCE_BINDING_INVALID');
  const handoffDeviceId = envelope?.handoffDeviceId ?? envelope?.toDeviceId;
  if (handoffDeviceId !== undefined) {
    uuidV7(handoffDeviceId, 'APPLE_ENROLLMENT_HANDOFF_TARGET_INVALID');
    if (handoffDeviceId === session.activeDeviceId) fail('APPLE_ENROLLMENT_HANDOFF_TARGET_INVALID');
  }
  const formalWatchBinding = envelope?.formalWatchBinding === undefined ? undefined : assertAppleFormalWatchBindingReceipt(envelope.formalWatchBinding);
  if (formalWatchBinding !== undefined && (formalWatchBinding.status !== 'active' ||
      !same(formalWatchBinding.realtimeSessionRef, session.realtimeSessionRef) ||
      !same(formalWatchBinding.iphone.deviceLeaseRef, lease.deviceLeaseRef) ||
      formalWatchBinding.userId !== session.userId || formalWatchBinding.iphone.deviceId !== lease.deviceId ||
      Date.parse(formalWatchBinding.expiresAt) <= nowMs)) fail('APPLE_ENROLLMENT_FORMAL_WATCH_BINDING_INVALID');
  const fingerprint = sha256(canonicalJson({
    realtime_session_ref: session.realtimeSessionRef,
    device_lease_ref: lease.deviceLeaseRef,
    continuity_id: session.continuityId,
    connection_epoch: session.connectionEpoch,
    session_revision: session.revision,
    lease_version: lease.leaseVersion,
    device_id: session.activeDeviceId,
    transport_aliases: aliases,
    participant_audience: participantAudience,
    ...(handoffDeviceId === undefined ? {} : { handoff_device_id: handoffDeviceId }),
    ...(formalWatchBinding === undefined ? {} : { formal_watch_binding: formalWatchBinding }),
    ...(envelope?.formalWatchPairState === undefined ? {} : { formal_watch_pair_state: envelope.formalWatchPairState }),
  }));
  return Object.freeze({
    binding: current,
    ...(formalWatchBinding === undefined ? {} : { formalWatchBinding }),
    ...(envelope?.formalWatchPairState === undefined ? {} : { formalWatchPairState: envelope.formalWatchPairState }),
    aliases,
    participantAudience,
    ...(handoffDeviceId === undefined ? {} : { handoffDeviceId }),
    fingerprint,
  });
}

function bodyGovernance(authority: ParsedAuthority): JsonRecord {
  const governance = authority.governance;
  const refIds = (value: unknown, expectedType: string): readonly string[] => {
    if (!Array.isArray(value) || value.length === 0) fail('APPLE_ENROLLMENT_GOVERNANCE_INVALID');
    return Object.freeze(value.map((item) => {
      if (typeof item === 'string') return uuidV7(item, 'APPLE_ENROLLMENT_GOVERNANCE_INVALID');
      return cvr(item, expectedType, 'APPLE_ENROLLMENT_GOVERNANCE_INVALID').ref_id as string;
    }));
  };
  return Object.freeze({
    purpose_scopes: cloneJson(governance.purpose_scopes),
    consent_record_refs: refIds(governance.consent_record_refs, 'ConsentRecord'),
    policy_decision_refs: refIds(governance.policy_decision_refs, 'PolicyDecision'),
    purpose_token_refs: refIds(governance.purpose_token_refs, 'PurposeToken'),
    capability_grant_refs: refIds(governance.capability_grant_refs, 'CapabilityGrant'),
  });
}

function schemaPath(filename: string): string {
  return fileURLToPath(new URL(`../../../contracts/json-schema/realtime/${filename}`, import.meta.url));
}

function idempotencyProfile(operation: OperationKey): { readonly definition: JsonRecord; readonly profileHash: string } {
  const requestSchemaId = `https://personal-ai-os.local/contracts/realtime/${SCHEMA_FILES[operation]}`;
  const definition = Object.freeze({
    profile_id: `https://personal-ai-os.local/contracts/realtime/idempotency/${PROFILE_SLUGS[operation]}`,
    profile_version: '1.0.0',
    hash_algorithm: 'sha256_rfc8785_jcs',
    request_schema_id: requestSchemaId,
    request_schema_version: '1.0.0',
    request_schema_sha256: sha256(readFileSync(schemaPath(SCHEMA_FILES[operation]))),
    intent_root_pointer: '',
  });
  return Object.freeze({ definition, profileHash: sha256(canonicalJson(definition)) });
}

function requestId(issuer: AppleProductionEnrollmentOwnerIssuer, purpose: string, occurredAt: string, used: Set<string>): string {
  let value: string;
  try {
    value = issuer.issueUuidV7({ purpose, occurredAt });
  } catch (error) {
    return fail('APPLE_ENROLLMENT_OWNER_UUID_ISSUER_FAILED', error);
  }
  if (!UUID_V7.test(value) || !IDEMPOTENCY_KEY.test(value) || used.has(value)) fail('APPLE_ENROLLMENT_OWNER_UUID_INVALID');
  used.add(value);
  return value;
}

function issueCredentialRef(issuer: AppleProductionEnrollmentOwnerIssuer, input: {
  readonly publicSha256: string;
  readonly publicKey: string;
  readonly audience: JsonRecord;
  readonly sessionRef: JsonRecord;
  readonly leaseRef: JsonRecord;
  readonly continuityId: string;
  readonly deviceId: string;
  readonly expiresAt: string;
  readonly occurredAt: string;
  readonly used: Set<string>;
}): JsonRecord {
  const credentialId = requestId(issuer, 'DeviceCredential', input.occurredAt, input.used);
  const payload = {
    algorithm: 'X25519',
    audience: input.audience,
    continuity_id: input.continuityId,
    deletion: null,
    device_id: input.deviceId,
    device_lease_ref: input.leaseRef,
    expires_at: input.expiresAt,
    public_key: input.publicKey,
    public_key_sha256: input.publicSha256,
    purpose: 'hpke_recipient',
    realtime_session_ref: input.sessionRef,
    revocation: { status: 'active' },
    supersession: null,
  };
  const payloadHash = sha256(canonicalJson(payload));
  let ref: unknown;
  try {
    ref = issuer.issueCanonicalObjectVersionRef({
      refType: 'DeviceCredential', refId: credentialId, objectVersion: '1', canonicalPayloadSha256: payloadHash,
    });
  } catch (error) {
    return fail('APPLE_ENROLLMENT_CVR_ISSUER_FAILED', error);
  }
  const result = cvr(ref, 'DeviceCredential', 'APPLE_ENROLLMENT_CREDENTIAL_REF_INVALID');
  if (result.ref_id !== credentialId || result.canonical_payload_sha256 !== payloadHash) fail('APPLE_ENROLLMENT_CREDENTIAL_REF_INVALID');
  return result;
}

function idempotencyContext(
  operation: OperationKey,
  requestIdValue: string,
  authority: ParsedAuthority,
  targetRef: JsonRecord,
  intent: JsonRecord,
): JsonRecord {
  const profile = idempotencyProfile(operation);
  const targetType = operation === 'media_stop' ? 'DeviceLease' : 'RealtimeSession';
  return Object.freeze({
    idempotency_scope: {
      owner_module: 'T03',
      operation_kind: operation === 'bootstrap'
        ? 'realtime_bootstrap'
        : operation === 'realtime_e2ee_key_resolve'
          ? 'realtime_e2ee_key_resolve'
          : operation === 'connected_credential_refresh'
            ? 'realtime_credential_refresh'
            : operation === 'media_stop'
              ? 'realtime_media_stop'
              : 'realtime_end_continuity',
      target_object_type: targetType,
      target_object_id: targetRef.ref_id,
      user_id: authority.userId,
    },
    idempotency_key: requestIdValue,
    idempotency_profile_id: profile.definition.profile_id,
    idempotency_profile_version: profile.definition.profile_version,
    idempotency_profile_sha256: profile.profileHash,
    idempotency_request_sha256: sha256(canonicalJson(intent)),
  });
}

function keyEnvelopeRef(current: NormalizedCurrent): JsonRecord {
  const binding = current.binding;
  const value = `e2ee-${sha256(canonicalJson({
    domain: 'paios.realtime.e2ee.content-key.v1',
    realtime_session_ref: binding.session.realtimeSessionRef,
    continuity_id: binding.session.continuityId,
    device_lease_ref: binding.lease.deviceLeaseRef,
    credential_generation: binding.lease.leaseVersion,
  }))}`;
  return Object.freeze({ alias_type: 'key_envelope', issuer: 'local_gateway', value });
}

function makeBody(
  operation: OperationKey,
  bodyWithoutContext: JsonRecord,
  authority: ParsedAuthority,
  targetRef: JsonRecord,
): JsonRecord {
  const request = cloneJson(bodyWithoutContext);
  const requestIdValue = request.request_id;
  if (typeof requestIdValue !== 'string') fail('APPLE_ENROLLMENT_REQUEST_ID_INVALID');
  request.idempotency_context = idempotencyContext(operation, requestIdValue, authority, targetRef, bodyWithoutContext);
  return request;
}

function buildBodies(
  current: NormalizedCurrent,
  authority: ParsedAuthority,
  credentialRef: JsonRecord,
  occurredAt: string,
  registry: RealtimeSchemaRegistry,
  issuer: AppleProductionEnrollmentOwnerIssuer,
): BodyResult {
  const used = new Set<string>();
  const sessionRef = cvr(current.binding.session.realtimeSessionRef, 'RealtimeSession', 'APPLE_ENROLLMENT_CURRENT_SESSION_REF_INVALID');
  const leaseRef = cvr(current.binding.lease.deviceLeaseRef, 'DeviceLease', 'APPLE_ENROLLMENT_CURRENT_LEASE_REF_INVALID');
  const governance = bodyGovernance(authority);
  const targetForSession = sessionRef;
  const targetForLease = leaseRef;
  const media = Object.fromEntries(MEDIA.map((name) => [name, authority.allowedMedia.includes(name)]));
  const modalities = MEDIA.filter((name) => authority.allowedMedia.includes(name));
  const aliases = current.aliases;
  const common = {
    realtime_session_ref: sessionRef,
    device_lease_ref: leaseRef,
    continuity_id: current.binding.session.continuityId,
    connection_epoch: current.binding.session.connectionEpoch,
    governance,
  };
  const bodies: Partial<Record<OperationKey, JsonRecord>> = {
    bootstrap: makeBody('bootstrap', {
      operation: 'bootstrap',
      bootstrap_mode: 'fully_disconnected',
      request_id: requestId(issuer, 'bootstrap', occurredAt, used),
      device_id: current.binding.session.activeDeviceId,
      continuity_id: current.binding.session.continuityId,
      transport_aliases: aliases,
      start: {
        kind: 'explicit_user_start', device_id: current.binding.session.activeDeviceId,
        modalities, started_at: occurredAt,
      },
      requested_media: media,
      governance,
    }, authority, targetForSession),
    realtime_e2ee_key_resolve: makeBody('realtime_e2ee_key_resolve', {
      operation: 'realtime_e2ee_key_resolve',
      request_id: requestId(issuer, 'realtime_e2ee_key_resolve', occurredAt, used),
      ...common,
      transport_aliases: aliases,
      key_envelope_ref: keyEnvelopeRef(current),
      key_index: 0,
      key_generation: current.binding.lease.leaseVersion,
      device_id: current.binding.session.activeDeviceId,
      recipient_device_credential_ref: credentialRef,
      participant_audience: current.participantAudience,
      governance,
    }, authority, targetForSession),
    connected_credential_refresh: makeBody('connected_credential_refresh', {
      operation: 'connected_credential_refresh',
      request_id: requestId(issuer, 'connected_credential_refresh', occurredAt, used),
      ...common,
      transport_aliases: aliases,
      refresh_reason: 'server_refresh',
      governance,
    }, authority, targetForSession),
    media_stop: makeBody('media_stop', {
      operation: 'media_stop',
      request_id: requestId(issuer, 'media_stop', occurredAt, used),
      ...common,
      transport_aliases: aliases,
      reason: 'user_stop',
      release_scope: 'media_device_lease_only',
      governance,
    }, authority, targetForLease),
    end_continuity: makeBody('end_continuity', {
      operation: 'end_continuity',
      request_id: requestId(issuer, 'end_continuity', occurredAt, used),
      realtime_session_ref: sessionRef,
      continuity_id: current.binding.session.continuityId,
      connection_epoch: current.binding.session.connectionEpoch,
      confirmation: 'explicit_user_end_continuity',
      governance,
    }, authority, targetForSession),
  };
  const entries: Partial<Record<OperationKey, BodyEntry>> = {};
  const hashes: Partial<Record<OperationKey, string>> = {};
  for (const operation of OPERATIONS) {
    const body = bodies[operation];
    if (body === undefined) fail('APPLE_ENROLLMENT_REQUEST_BODY_MISSING');
    const bodyBytes = Buffer.from(canonicalJson(body), 'utf8');
    const bodyHash = sha256(bodyBytes);
    if (!registry.validateRequest(operation as never, body)) fail('APPLE_ENROLLMENT_REQUEST_SCHEMA_INVALID');
    entries[operation] = Object.freeze({ route: ROUTES[operation], body_base64: bodyBytes.toString('base64'), body_sha256: bodyHash });
    hashes[operation] = bodyHash;
  }
  return Object.freeze({ bodies: Object.freeze(bodies), entries: Object.freeze(entries), hashes: Object.freeze(hashes) });
}

function assertBindingMatchesAuthority(authority: ParsedAuthority, current: NormalizedCurrent): void {
  const binding = current.binding;
  if (current.formalWatchBinding !== undefined && !same(current.formalWatchBinding.principalRef, authority.value.principal_ref)) fail('APPLE_ENROLLMENT_FORMAL_WATCH_AUTHORITY_MISMATCH');
  if (binding.session.userId !== authority.userId || binding.lease.userId !== authority.userId ||
      binding.session.activeDeviceId !== authority.deviceId || binding.lease.deviceId !== authority.deviceId ||
      !same(binding.lease.capabilities, authority.allowedMedia) || !same(binding.lease.policyDecisionRef, authority.policyDecisionRef)) {
    fail('APPLE_ENROLLMENT_CURRENT_AUTHORITY_MISMATCH');
  }
}

function ensureSafePath(path: string, code: string): string {
  const value = stringValue(path, code, 4096);
  if (!isAbsolute(value) || /^[Cc]:[\\/]/u.test(value)) fail(code);
  return resolve(value);
}

function assertNoReparse(path: string, code: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(code);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof AppleProductionEnrollmentOwnerError) throw error;
    fail(code, error);
  }
}

function assertOwnerProtectedRegistration(reader: ApplePublicRegistrationFileReader): void {
  try {
    reader.assertOwnerProtected(reader.path);
  } catch (error) {
    return fail('APPLE_ENROLLMENT_REGISTRATION_OWNER_PROTECTION_INVALID', error);
  }
}

function recipientPublicKeyFromCurrentRecipient(recipient: JsonRecord): AppleRecipientPublicKey {
  const publicRaw32Base64url = stringValue(recipient.public_key, 'APPLE_ENROLLMENT_PUBLIC_KEY_INVALID', 43);
  if (!B64URL_RAW32.test(publicRaw32Base64url)) fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID');
  const publicRaw32 = Buffer.from(publicRaw32Base64url, 'base64url');
  const publicSha256 = digest(recipient.public_key_sha256, 'APPLE_ENROLLMENT_PUBLIC_KEY_HASH_INVALID');
  if (publicRaw32.byteLength !== 32 || publicRaw32.toString('base64url') !== publicRaw32Base64url ||
      !sameDigest(publicSha256, sha256(publicRaw32))) fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID');
  return Object.freeze({
    publicRaw32Base64url,
    publicRaw32: new Uint8Array(publicRaw32),
    publicSha256,
  });
}

function parseDurableSuccessorBundle(bytes: Uint8Array, registry: RealtimeSchemaRegistry = createRealtimeSchemaRegistry()): JsonRecord {
  const parsed = parseJsonBytes(bytes, 'APPLE_ENROLLMENT_BUNDLE');
  const bundle = exactKeys(parsed, [
    ...(isPlainRecord(parsed) && Object.hasOwn(parsed, 'formal_watch_binding') ? ['formal_watch_binding'] : []),
    ...(isPlainRecord(parsed) && Object.hasOwn(parsed, 'formal_watch_pair_state') ? ['formal_watch_pair_state'] : []),
    'binding', 'canonical_bodies', 'credential_ref', 'expires_at', 'origin', 'schema',
  ], 'APPLE_ENROLLMENT_BUNDLE_SCHEMA_INVALID');
  if (bundle.schema !== BUNDLE_SCHEMA || bundle.origin !== configuredPublicApiOrigin()) fail('APPLE_ENROLLMENT_BUNDLE_SCHEMA_INVALID');
  validateAppleProductionEnrollmentBundle(bytes);
  cvr(bundle.credential_ref, 'DeviceCredential', 'APPLE_ENROLLMENT_BUNDLE_CREDENTIAL_INVALID');
  const binding = exactKeys(bundle.binding, [
    'connection_epoch', 'continuity_id', 'device_lease_ref', 'realtime_session_ref',
  ], 'APPLE_ENROLLMENT_BUNDLE_BINDING_INVALID');
  cvr(binding.realtime_session_ref, 'RealtimeSession', 'APPLE_ENROLLMENT_BUNDLE_SESSION_INVALID');
  cvr(binding.device_lease_ref, 'DeviceLease', 'APPLE_ENROLLMENT_BUNDLE_LEASE_INVALID');
  if (!UUID_V7.test(stringValue(binding.continuity_id, 'APPLE_ENROLLMENT_BUNDLE_BINDING_INVALID', 36)) ||
      !DECIMAL.test(stringValue(binding.connection_epoch, 'APPLE_ENROLLMENT_BUNDLE_BINDING_INVALID', 38))) {
    fail('APPLE_ENROLLMENT_BUNDLE_BINDING_INVALID');
  }
  const bodies = bundle.canonical_bodies;
  if (!isPlainRecord(bodies)) fail('APPLE_ENROLLMENT_BUNDLE_BODIES_INVALID');
  const names = Object.keys(bodies);
  const required = OPERATIONS;
  if (required.some((operation) => !names.includes(operation)) || names.some((operation) => !OPERATIONS.includes(operation as OperationKey))) {
    fail('APPLE_ENROLLMENT_BUNDLE_BODIES_INVALID');
  }
  for (const operation of names as OperationKey[]) {
    const entry = exactKeys(bodies[operation], ['body_base64', 'body_sha256', 'route'], 'APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
    const bodyBase64 = stringValue(entry.body_base64, 'APPLE_ENROLLMENT_BUNDLE_BODY_INVALID', 174_764);
    const bodyBytes = Buffer.from(bodyBase64, 'base64');
    if (bodyBytes.byteLength < 2 || bodyBytes.byteLength > 131_072 || bodyBytes.toString('base64') !== bodyBase64 ||
        entry.route !== ROUTES[operation] || !sameDigest(stringValue(entry.body_sha256, 'APPLE_ENROLLMENT_BUNDLE_BODY_INVALID', 64), sha256(bodyBytes))) {
      fail('APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
    }
    const body = parseJsonBytes(bodyBytes, 'APPLE_ENROLLMENT_BUNDLE_BODY');
    if (!isPlainRecord(body) || body.operation !== operation || !registry.validateRequest(operation, body)) {
      fail('APPLE_ENROLLMENT_BUNDLE_BODY_INVALID');
    }
  }
  return bundle;
}

function readDurableSuccessorReplay(
  authorityPath: string,
  outputPath: string,
  authority: { readonly bytes: Uint8Array; readonly parsed: ParsedAuthority; readonly hash: string },
  current: NormalizedCurrent,
  existingRecipient: JsonRecord,
  nowMs: number,
  registry: RealtimeSchemaRegistry,
): AppleProductionEnrollmentPrepared | undefined {
  const bundleBytes = readOptionalFile(outputPath);
  if (bundleBytes === undefined) return undefined;
  let bundle: JsonRecord;
  try { bundle = parseDurableSuccessorBundle(bundleBytes, registry); }
  catch (error) { return fail('APPLE_ENROLLMENT_REPLAY_BUNDLE_INVALID', error); }
  if (!same(bundle.credential_ref, existingRecipient.device_credential_ref) || !isPlainRecord(bundle.binding)) {
    fail('APPLE_ENROLLMENT_REPLAY_BUNDLE_MISMATCH');
  }
  const binding = bundle.binding;
  if (!same(binding.realtime_session_ref, current.binding.session.realtimeSessionRef) ||
      !same(binding.device_lease_ref, current.binding.lease.deviceLeaseRef) ||
      binding.continuity_id !== current.binding.session.continuityId ||
      String(binding.connection_epoch) !== String(current.binding.session.connectionEpoch)) {
    fail('APPLE_ENROLLMENT_REPLAY_BUNDLE_MISMATCH');
  }
  const expiresAt = timestamp(bundle.expires_at, 'APPLE_ENROLLMENT_BUNDLE_EXPIRY_INVALID');
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= nowMs || expiresMs > Date.parse(current.binding.lease.expiresAt) ||
      expiresMs > Date.parse(current.binding.session.continuityExpiresAt) ||
      expiresMs > Date.parse(authority.parsed.expiresAt) ||
      expiresMs > Date.parse(timestamp(existingRecipient.expires_at, 'APPLE_ENROLLMENT_RECIPIENT_EXPIRY_INVALID'))) {
    fail('APPLE_ENROLLMENT_REPLAY_BUNDLE_MISMATCH');
  }
  assertT03ValidatorReadiness(authorityPath, authority.bytes, authority.hash, nowMs);
  const hashes: Partial<Record<OperationKey, string>> = {};
  if (isPlainRecord(bundle.canonical_bodies)) {
    for (const [operation, entry] of Object.entries(bundle.canonical_bodies)) {
      if (isPlainRecord(entry) && typeof entry.body_sha256 === 'string' &&
          (OPERATIONS as readonly string[]).includes(operation)) hashes[operation as OperationKey] = entry.body_sha256;
    }
  }
  const credentialRef = cvr(existingRecipient.device_credential_ref, 'DeviceCredential', 'APPLE_ENROLLMENT_CREDENTIAL_REF_INVALID');
  return Object.freeze({
    authorityPath,
    outputPath,
    previousAuthoritySha256: authority.hash,
    nextAuthoritySha256: authority.hash,
    bundleSha256: sha256(bundleBytes),
    authorityBytes: authority.bytes,
    bundleBytes,
    snapshotFingerprint: current.fingerprint,
    credentialRef: cloneJson(credentialRef),
    expiresAt,
    canonicalBodySha256: Object.freeze(hashes),
  });
}

function readAuthorityAtPath(path: string, expectedHash: string, nowMs: number): { readonly bytes: Uint8Array; readonly parsed: ParsedAuthority; readonly hash: string } {
  let bytes: Buffer;
  try {
    assertNoReparse(path, 'APPLE_ENROLLMENT_AUTHORITY_PATH_INVALID');
    bytes = readFileSync(path);
  } catch (error) {
    return fail('APPLE_ENROLLMENT_AUTHORITY_UNAVAILABLE', error);
  }
  const observed = sha256(bytes);
  if (!sameDigest(observed, expectedHash)) fail('APPLE_ENROLLMENT_AUTHORITY_HASH_MISMATCH');
  const parsed = parseAuthority(bytes, nowMs);
  return Object.freeze({ bytes: new Uint8Array(bytes), parsed, hash: observed });
}

function makeAuthorityBytes(authority: ParsedAuthority, current: NormalizedCurrent, credentialRef: JsonRecord, registration: AppleRecipientPublicKey, issuedAt: string, expiresAt: string, leaseExpiresAt: string): Uint8Array {
  const recipient = {
    algorithm: 'X25519',
    audience: current.participantAudience,
    continuity_id: current.binding.session.continuityId,
    deletion: null,
    device_credential_ref: credentialRef,
    device_id: current.binding.session.activeDeviceId,
    device_lease_ref: current.binding.lease.deviceLeaseRef,
    expires_at: expiresAt,
    public_key: registration.publicRaw32Base64url,
    public_key_sha256: registration.publicSha256,
    purpose: 'hpke_recipient',
    realtime_session_ref: current.binding.session.realtimeSessionRef,
    revocation: { status: 'active' },
    supersession: null,
  };
  const next = {
    ...cloneJson(authority.value),
    issued_at_utc: issuedAt,
    expires_at_utc: expiresAt,
    lease_expires_at_utc: leaseExpiresAt,
    recipient_device_credential: recipient,
  };
  const text = `${canonicalJson(next)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  parseAuthorityWithRecipient(bytes, issuedAt);
  return new Uint8Array(bytes);
}

function assertT03ValidatorReadiness(path: string, bytes: Uint8Array, expectedHash: string, nowMs: number): void {
  const authority = createT03AppleCyclingLeaseAuthority({
    expectedRecordPath:path,
    record: {
      path,
      read: () => bytes,
    },
    ownerProtection: {
      assertOwnerProtected: (ownerPath) => assertNoReparse(ownerPath, 'APPLE_ENROLLMENT_AUTHORITY_OWNER_PROTECTION_INVALID'),
    },
    expectedRecordSha256: expectedHash,
    now: () => nowMs,
  });
  try {
    if (!authority.isReady()) fail('APPLE_ENROLLMENT_AUTHORITY_VALIDATOR_NOT_READY');
  } finally {
    authority.close();
  }
}

function parseAuthorityWithRecipient(bytes: Uint8Array, nowTimestamp: string): void {
  const value = exactKeys(parseJsonBytes(bytes, 'APPLE_ENROLLMENT_AUTHORITY', true), [
    'allowed_media_capabilities', 'capability_ref', 'consent', 'device_id', 'expires_at_utc', 'governance',
    'grant_id', 'issued_at_utc', 'lease_expires_at_utc', 'operation_scopes', 'principal_ref', 'purpose',
    'recipient_device_credential', 'revocable', 'schema', 'scopes', 'user_id',
  ], 'APPLE_ENROLLMENT_AUTHORITY_NEXT_SCHEMA_INVALID');
  if (value.schema !== T03_APPLE_CYCLING_AUTHORITY_SCHEMA || value.purpose !== T03_APPLE_CYCLING_PURPOSE || value.revocable !== true) {
    fail('APPLE_ENROLLMENT_AUTHORITY_NEXT_SCHEMA_INVALID');
  }
  const issuedAt = timestamp(value.issued_at_utc, 'APPLE_ENROLLMENT_AUTHORITY_NEXT_TIME_INVALID');
  const expiresAt = timestamp(value.expires_at_utc, 'APPLE_ENROLLMENT_AUTHORITY_NEXT_TIME_INVALID');
  const leaseExpiresAt = timestamp(value.lease_expires_at_utc, 'APPLE_ENROLLMENT_AUTHORITY_NEXT_TIME_INVALID');
  if (issuedAt !== nowTimestamp || Date.parse(issuedAt) >= Date.parse(expiresAt) || Date.parse(leaseExpiresAt) > Date.parse(expiresAt)) {
    fail('APPLE_ENROLLMENT_AUTHORITY_NEXT_TIME_INVALID');
  }
  const recipient = exactKeys(value.recipient_device_credential, [
    'algorithm', 'audience', 'continuity_id', 'deletion', 'device_credential_ref', 'device_id', 'device_lease_ref',
    'expires_at', 'public_key', 'public_key_sha256', 'purpose', 'realtime_session_ref', 'revocation', 'supersession',
  ], 'APPLE_ENROLLMENT_RECIPIENT_INVALID');
  if (recipient.algorithm !== 'X25519' || recipient.purpose !== 'hpke_recipient' || recipient.deletion !== null || recipient.supersession !== null ||
      !isPlainRecord(recipient.revocation) || recipient.revocation.status !== 'active') fail('APPLE_ENROLLMENT_RECIPIENT_INVALID');
  cvr(recipient.device_credential_ref, 'DeviceCredential', 'APPLE_ENROLLMENT_CREDENTIAL_REF_INVALID');
  cvr(recipient.realtime_session_ref, 'RealtimeSession', 'APPLE_ENROLLMENT_SESSION_REF_INVALID');
  cvr(recipient.device_lease_ref, 'DeviceLease', 'APPLE_ENROLLMENT_LEASE_REF_INVALID');
  uuidV7(recipient.device_id, 'APPLE_ENROLLMENT_RECIPIENT_DEVICE_INVALID');
  uuidV7(recipient.continuity_id, 'APPLE_ENROLLMENT_RECIPIENT_CONTINUITY_INVALID');
  const key = stringValue(recipient.public_key, 'APPLE_ENROLLMENT_PUBLIC_KEY_INVALID', 43);
  if (!B64URL_RAW32.test(key) || Buffer.from(key, 'base64url').byteLength !== 32 || sha256(Buffer.from(key, 'base64url')) !== recipient.public_key_sha256) {
    fail('APPLE_ENROLLMENT_PUBLIC_KEY_INVALID');
  }
  digest(recipient.public_key_sha256, 'APPLE_ENROLLMENT_PUBLIC_KEY_HASH_INVALID');
  timestamp(recipient.expires_at, 'APPLE_ENROLLMENT_RECIPIENT_EXPIRY_INVALID');
  if (Date.parse(recipient.expires_at as string) > Date.parse(leaseExpiresAt) || Date.parse(recipient.expires_at as string) <= Date.parse(issuedAt)) {
    fail('APPLE_ENROLLMENT_RECIPIENT_EXPIRY_INVALID');
  }
}

function minDate(...values: number[]): number {
  const result = Math.min(...values);
  if (!Number.isSafeInteger(result)) fail('APPLE_ENROLLMENT_EXPIRY_INVALID');
  return result;
}

function ensureBundleLifetime(nowMs: number, expiresAt: number): void {
  if (expiresAt <= nowMs + MIN_BUNDLE_LIFETIME_MS) fail('APPLE_ENROLLMENT_BUNDLE_LIFETIME_TOO_SHORT');
}

function writeOwnerOnlyAtomic(path: string, bytes: Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  assertNoReparse(directory, 'APPLE_ENROLLMENT_OUTPUT_PATH_INVALID');
  const base = `${path}.tmp-${process.pid}-${Date.now()}`;
  let temporary = base;
  let suffix = 0;
  while (existsSync(temporary)) temporary = `${base}-${++suffix}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    applyOwnerOnlyAcl(temporary);
    renameSync(temporary, path);
    applyOwnerOnlyAcl(path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    return fail('APPLE_ENROLLMENT_ATOMIC_WRITE_FAILED', error);
  }
}

function applyOwnerOnlyAcl(path: string): void {
  chmodSync(path, 0o600);
  if (process.platform !== 'win32') return;
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (username === undefined || username.length === 0) fail('APPLE_ENROLLMENT_OWNER_ACL_UNAVAILABLE');
  const principal = `${domain === undefined || domain.length === 0 ? '.' : domain}\\${username}`;
  try {
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${principal}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    return fail('APPLE_ENROLLMENT_OWNER_ACL_FAILED', error);
  }
}

function readOptionalFile(path: string): Uint8Array | undefined {
  try {
    assertNoReparse(path, 'APPLE_ENROLLMENT_OUTPUT_PATH_INVALID');
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof AppleProductionEnrollmentOwnerError) throw error;
    return fail('APPLE_ENROLLMENT_OUTPUT_UNAVAILABLE', error);
  }
}

function restoreOrDelete(path: string, previous: Uint8Array | undefined): void {
  try {
    if (previous === undefined) {
      if (existsSync(path)) rmSync(path, { force: true });
    } else {
      writeOwnerOnlyAtomic(path, previous);
    }
  } catch {
    // The original error remains the actionable failure; callers must inspect
    // the owner record before retrying if rollback cannot be completed.
  }
}

function validateOptions(options: AppleProductionEnrollmentOwnerOptions): void {
  const registrationMode = isPlainRecord(options) && isPlainRecord(options.registration) &&
    typeof options.registration.read === 'function' && typeof options.registration.assertOwnerProtected === 'function' &&
    typeof options.registration.path === 'string' && options.reuseCurrentRecipient === undefined;
  const successorMode = isPlainRecord(options) && options.registration === undefined && options.reuseCurrentRecipient === true;
  if (!isPlainRecord(options) || (!registrationMode && !successorMode) ||
      typeof options.authorityPath !== 'string' || typeof options.outputPath !== 'string' ||
      !isPlainRecord(options.currentBinding) ||
      (typeof options.currentBinding.readCurrentBindingSnapshot !== 'function' && typeof options.currentBinding.readCurrentBinding !== 'function') ||
      !isPlainRecord(options.issuer) || typeof options.issuer.issueUuidV7 !== 'function' ||
       typeof options.issuer.issueCanonicalObjectVersionRef !== 'function' || !isPlainRecord(options.clock) || typeof options.clock.now !== 'function') {
    fail('APPLE_ENROLLMENT_OPTIONS_INVALID');
  }
  if (!isPlainRecord(options.authorityHashPort) || typeof options.authorityHashPort.current !== 'function' ||
      typeof options.authorityHashPort.updateAfterCommit !== 'function') fail('APPLE_ENROLLMENT_AUTHORITY_HASH_PORT_INVALID');
  digest(options.expectedAuthoritySha256, 'APPLE_ENROLLMENT_EXPECTED_HASH_INVALID');
  ensureSafePath(options.authorityPath, 'APPLE_ENROLLMENT_AUTHORITY_PATH_INVALID');
  ensureSafePath(options.outputPath, 'APPLE_ENROLLMENT_OUTPUT_PATH_INVALID');
  if (options.schemaRegistry !== undefined && typeof options.schemaRegistry.validateRequest !== 'function') fail('APPLE_ENROLLMENT_SCHEMA_REGISTRY_INVALID');
  if (options.currentBinding.snapshotIsolation !== undefined && options.currentBinding.snapshotIsolation !== 'REPEATABLE READ') {
    fail('APPLE_ENROLLMENT_SNAPSHOT_ISOLATION_INVALID');
  }
  if (options.currentBinding.readOnly !== undefined && options.currentBinding.readOnly !== true) fail('APPLE_ENROLLMENT_SNAPSHOT_READONLY_INVALID');
}

function readCurrent(provider: AppleCurrentBindingSnapshotProvider, nowMs: number): Promise<NormalizedCurrent> {
  const reader = provider.readCurrentBindingSnapshot ?? provider.readCurrentBinding;
  if (reader === undefined) return Promise.reject(new AppleProductionEnrollmentOwnerError('APPLE_ENROLLMENT_CURRENT_PROVIDER_INVALID'));
  return reader().then((result) => normalizeCurrent(result, nowMs)).catch((error) => {
    if (error instanceof AppleProductionEnrollmentOwnerError) throw error;
    throw new AppleProductionEnrollmentOwnerError('APPLE_ENROLLMENT_CURRENT_PROVIDER_UNAVAILABLE', { cause: error });
  });
}

export function validateApplePublicRegistration(bytes: Uint8Array, now: ClockValue): ApplePublicRegistration {
  const millis = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isSafeInteger(millis)) fail('APPLE_ENROLLMENT_CLOCK_INVALID');
  return parseRegistration(bytes, millis);
}

export function createAppleProductionEnrollmentOwner(options: AppleProductionEnrollmentOwnerOptions): AppleProductionEnrollmentOwner {
  validateOptions(options);
  const authorityPath = ensureSafePath(options.authorityPath, 'APPLE_ENROLLMENT_AUTHORITY_PATH_INVALID');
  const outputPath = ensureSafePath(options.outputPath, 'APPLE_ENROLLMENT_OUTPUT_PATH_INVALID');
  const registry = options.schemaRegistry ?? createRealtimeSchemaRegistry();
  const preparedObjects = new WeakSet<object>();

  const prepare = async (): Promise<AppleProductionEnrollmentPrepared> => {
    const nowMs = clockMillis(options.clock);
    const issuedAt = new Date(nowMs).toISOString();
    const authority = readAuthorityAtPath(authorityPath, options.authorityHashPort.current(), nowMs);
    const existingRecipient = Object.hasOwn(authority.parsed.value, 'recipient_device_credential')
      ? authority.parsed.value.recipient_device_credential as JsonRecord
      : undefined;
    let registration: AppleRecipientPublicKey;
    if (options.reuseCurrentRecipient === true) {
      if (existingRecipient === undefined) fail('APPLE_ENROLLMENT_RECIPIENT_MISSING');
      registration = recipientPublicKeyFromCurrentRecipient(existingRecipient);
    } else {
      assertOwnerProtectedRegistration(options.registration);
      let registrationBytes: Uint8Array | undefined;
      try { registrationBytes = options.registration.read(); } catch (error) { return fail('APPLE_ENROLLMENT_REGISTRATION_UNAVAILABLE', error); }
      if (registrationBytes === undefined) fail('APPLE_ENROLLMENT_REGISTRATION_MISSING');
      registration = parseRegistration(registrationBytes, nowMs, existingRecipient !== undefined);
    }
    // The authority file deliberately carries no session selector.  The
    // provider therefore returns the sole active primary row from one
    // REPEATABLE READ READ ONLY snapshot and rejects zero/multiple rows.
    const current = await readCurrent(options.currentBinding, nowMs);
    assertBindingMatchesAuthority(authority.parsed, current);
    const used = new Set<string>();
    let credentialRef: JsonRecord;
    let authorityBytes: Uint8Array;
    let expiresAt: string;
    if (existingRecipient !== undefined) {
      if (existingRecipient.public_key !== registration.publicRaw32Base64url ||
          existingRecipient.public_key_sha256 !== registration.publicSha256 ||
          existingRecipient.device_id !== current.binding.session.activeDeviceId ||
          existingRecipient.continuity_id !== current.binding.session.continuityId) {
        fail('APPLE_ENROLLMENT_RECIPIENT_BINDING_MISMATCH');
      }
      const sameBinding = same(existingRecipient.realtime_session_ref, current.binding.session.realtimeSessionRef) &&
        same(existingRecipient.device_lease_ref, current.binding.lease.deviceLeaseRef) &&
        same(existingRecipient.audience, current.participantAudience);
      if (options.reuseCurrentRecipient === true && sameBinding) {
        const replay = readDurableSuccessorReplay(
          authorityPath, outputPath, authority, current, existingRecipient, nowMs, registry,
        );
        if (replay !== undefined) {
          preparedObjects.add(replay);
          return replay;
        }
      }
      if (!sameBinding) {
        const bundleExpiry = minDate(
          nowMs + 4 * 60 * 60 * 1000,
          Date.parse(authority.parsed.expiresAt),
          Date.parse(current.binding.lease.expiresAt),
          Date.parse(current.binding.session.continuityExpiresAt),
        );
        ensureBundleLifetime(nowMs, bundleExpiry);
        expiresAt = new Date(bundleExpiry).toISOString();
        credentialRef = issueCredentialRef(options.issuer, {
          publicSha256: registration.publicSha256,
          publicKey: registration.publicRaw32Base64url,
          audience: current.participantAudience,
          sessionRef: cvr(current.binding.session.realtimeSessionRef, 'RealtimeSession', 'APPLE_ENROLLMENT_SESSION_REF_INVALID'),
          leaseRef: cvr(current.binding.lease.deviceLeaseRef, 'DeviceLease', 'APPLE_ENROLLMENT_LEASE_REF_INVALID'),
          continuityId: current.binding.session.continuityId,
          deviceId: current.binding.session.activeDeviceId,
          expiresAt,
          occurredAt: issuedAt,
          used,
        });
        authorityBytes = makeAuthorityBytes(
          authority.parsed, current, credentialRef, registration, issuedAt, expiresAt, expiresAt,
        );
      } else {
      credentialRef = cvr(
        existingRecipient.device_credential_ref,
        'DeviceCredential',
        'APPLE_ENROLLMENT_CREDENTIAL_REF_INVALID',
      );
      const bundleExpiry = minDate(
        Date.parse(timestamp(existingRecipient.expires_at, 'APPLE_ENROLLMENT_RECIPIENT_EXPIRY_INVALID')),
        Date.parse(authority.parsed.expiresAt),
        Date.parse(current.binding.lease.expiresAt),
        Date.parse(current.binding.session.continuityExpiresAt),
      );
      ensureBundleLifetime(nowMs, bundleExpiry);
      expiresAt = new Date(bundleExpiry).toISOString();
      authorityBytes = authority.bytes;
      }
    } else {
      const bundleExpiry = minDate(
        nowMs + 4 * 60 * 60 * 1000,
        Date.parse(authority.parsed.expiresAt),
        Date.parse(current.binding.lease.expiresAt),
        Date.parse(current.binding.session.continuityExpiresAt),
      );
      ensureBundleLifetime(nowMs, bundleExpiry);
      expiresAt = new Date(bundleExpiry).toISOString();
      credentialRef = issueCredentialRef(options.issuer, {
        publicSha256: registration.publicSha256,
        publicKey: registration.publicRaw32Base64url,
        audience: current.participantAudience,
        sessionRef: cvr(current.binding.session.realtimeSessionRef, 'RealtimeSession', 'APPLE_ENROLLMENT_SESSION_REF_INVALID'),
        leaseRef: cvr(current.binding.lease.deviceLeaseRef, 'DeviceLease', 'APPLE_ENROLLMENT_LEASE_REF_INVALID'),
        continuityId: current.binding.session.continuityId,
        deviceId: current.binding.session.activeDeviceId,
        expiresAt,
        occurredAt: issuedAt,
        used,
      });
      authorityBytes = makeAuthorityBytes(
        authority.parsed, current, credentialRef, registration, issuedAt, expiresAt, expiresAt,
      );
    }
    const bodyResult = buildBodies(current, authority.parsed, credentialRef, issuedAt, registry, options.issuer);
    assertT03ValidatorReadiness(authorityPath, authorityBytes, sha256(authorityBytes), nowMs);
    const bundle = {
      schema: BUNDLE_SCHEMA,
      origin: configuredPublicApiOrigin(),
      credential_ref: credentialRef,
      binding: {
        realtime_session_ref: current.binding.session.realtimeSessionRef,
        device_lease_ref: current.binding.lease.deviceLeaseRef,
        continuity_id: current.binding.session.continuityId,
        connection_epoch: current.binding.session.connectionEpoch,
      },
      expires_at: expiresAt,
      canonical_bodies: bodyResult.entries,
      ...(current.formalWatchBinding === undefined ? {} : { formal_watch_binding: current.formalWatchBinding }),
      ...(current.formalWatchPairState === undefined ? {} : { formal_watch_pair_state: { pair_version: current.formalWatchPairState.pairVersion, status: current.formalWatchPairState.status, requires_rebind: current.formalWatchPairState.requiresRebind } }),
    };
    const bundleBytes = new Uint8Array(Buffer.from(canonicalJson(bundle), 'utf8'));
    const prepared: AppleProductionEnrollmentPrepared = Object.freeze({
      authorityPath, outputPath, previousAuthoritySha256: authority.hash,
      nextAuthoritySha256: sha256(authorityBytes), bundleSha256: sha256(bundleBytes),
      authorityBytes, bundleBytes, snapshotFingerprint: current.fingerprint,
      credentialRef: cloneJson(credentialRef), expiresAt, canonicalBodySha256: bodyResult.hashes,
    });
    preparedObjects.add(prepared);
    return prepared;
  };

  const commit = async (prepared: AppleProductionEnrollmentPrepared): Promise<AppleProductionEnrollmentCommitReceipt> => {
    if (!isPlainRecord(prepared) || !preparedObjects.has(prepared) || prepared.authorityPath !== authorityPath || prepared.outputPath !== outputPath) {
      fail('APPLE_ENROLLMENT_PREPARED_INVALID');
    }
    const nowMs = clockMillis(options.clock);
    let authority: { readonly bytes: Uint8Array; readonly parsed: ParsedAuthority; readonly hash: string };
    try {
      const bytes = new Uint8Array(readFileSync(authorityPath));
      const observedHash = sha256(bytes);
      authority = sameDigest(observedHash, prepared.nextAuthoritySha256)
        ? Object.freeze({ bytes, parsed: parseAuthority(bytes, nowMs), hash: observedHash })
        : readAuthorityAtPath(authorityPath, options.authorityHashPort.current(), nowMs);
    } catch (error) {
      if (error instanceof AppleProductionEnrollmentOwnerError) throw error;
      return fail('APPLE_ENROLLMENT_AUTHORITY_UNAVAILABLE', error);
    }
    const current = await readCurrent(options.currentBinding, nowMs);
    if (current.fingerprint !== prepared.snapshotFingerprint) fail('APPLE_ENROLLMENT_CURRENT_BINDING_DRIFT');
    const oldBundle = readOptionalFile(outputPath);
    const authorityIsNext = sameDigest(authority.hash, prepared.nextAuthoritySha256);
    const bundleIsNext = oldBundle !== undefined && sha256(oldBundle) === prepared.bundleSha256 &&
      oldBundle.byteLength === prepared.bundleBytes.byteLength &&
      Buffer.from(oldBundle).equals(Buffer.from(prepared.bundleBytes));
    const updateAuthorityHash = async (): Promise<void> => {
      const currentHash = options.authorityHashPort.current();
      if (sameDigest(currentHash, prepared.nextAuthoritySha256)) return;
      if (!sameDigest(currentHash, prepared.previousAuthoritySha256)) fail('APPLE_ENROLLMENT_AUTHORITY_HASH_DRIFT');
      await options.authorityHashPort.updateAfterCommit({
        previousSha256: prepared.previousAuthoritySha256,
        nextSha256: prepared.nextAuthoritySha256,
      });
    };
    if (authorityIsNext && bundleIsNext) {
      await updateAuthorityHash();
      return Object.freeze({
        status: 'replayed', authorityPath, outputPath, authoritySha256: authority.hash,
        bundleSha256: prepared.bundleSha256, canonicalBodyCount: Object.keys(prepared.canonicalBodySha256).length,
        credentialRef: cloneJson(prepared.credentialRef), expiresAt: prepared.expiresAt,
      });
    }
    if (authorityIsNext && !sameDigest(prepared.previousAuthoritySha256, prepared.nextAuthoritySha256)) {
      fail('APPLE_ENROLLMENT_REPLAY_BUNDLE_MISMATCH');
    }
    if (!authorityIsNext && !sameDigest(authority.hash, prepared.previousAuthoritySha256)) {
      fail('APPLE_ENROLLMENT_AUTHORITY_DRIFT');
    }
    try {
      if (!authorityIsNext) writeOwnerOnlyAtomic(authorityPath, prepared.authorityBytes);
      writeOwnerOnlyAtomic(outputPath, prepared.bundleBytes);
      const observedAuthority = readFileSync(authorityPath);
      const observedBundle = readFileSync(outputPath);
      if (!sameDigest(sha256(observedAuthority), prepared.nextAuthoritySha256) || !sameDigest(sha256(observedBundle), prepared.bundleSha256)) {
        throw new AppleProductionEnrollmentOwnerError('APPLE_ENROLLMENT_POSTSTATE_HASH_INVALID');
      }
      const receipt = Object.freeze({
        status: 'committed', authorityPath, outputPath, authoritySha256: prepared.nextAuthoritySha256,
        bundleSha256: prepared.bundleSha256, canonicalBodyCount: Object.keys(prepared.canonicalBodySha256).length,
        credentialRef: cloneJson(prepared.credentialRef), expiresAt: prepared.expiresAt,
      });
      await updateAuthorityHash();
      return receipt;
    } catch (error) {
      if (!authorityIsNext) restoreOrDelete(authorityPath, authority.bytes);
      restoreOrDelete(outputPath, oldBundle);
      if (error instanceof AppleProductionEnrollmentOwnerError) throw error;
      return fail('APPLE_ENROLLMENT_COMMIT_FAILED', error);
    }
  };

  return Object.freeze({
    prepare,
    commit,
    run: async (mode: 'prepare' | 'commit' = 'prepare') => {
      const prepared = await prepare();
      return mode === 'commit' ? commit(prepared) : prepared;
    },
  });
}

export function createAppleProductionSuccessorEnrollmentPort(
  options: AppleProductionEnrollmentOwnerOptions & Readonly<{ readonly reuseCurrentRecipient: true }>,
): Readonly<{
  readonly ensure: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<{
    readonly successorEnrollment: JsonRecord;
    readonly recipientDeviceCredentialRef: JsonRecord;
  }>>;
  readonly read: (input: Readonly<Record<string, unknown>>) => Promise<JsonRecord>;
  readonly close: () => Promise<void>;
}> {
  validateOptions(options);
  let closeFlight: Promise<void> | undefined;
  const ensure = async (input: Readonly<Record<string, unknown>>): Promise<Readonly<{
    readonly successorEnrollment: JsonRecord;
    readonly recipientDeviceCredentialRef: JsonRecord;
  }>> => {
    const request = isPlainRecord(input.request) ? input.request : undefined;
    const requestIdValue = typeof input.requestId === 'string'
      ? input.requestId
      : typeof request?.request_id === 'string' ? request.request_id : undefined;
    if (requestIdValue === undefined || !IDEMPOTENCY_KEY.test(requestIdValue)) fail('APPLE_ENROLLMENT_SUCCESSOR_REQUEST_INVALID');
    const start = isPlainRecord(request?.start) ? request.start : undefined;
    const occurredAtValue = typeof start?.started_at === 'string'
      ? timestamp(start.started_at, 'APPLE_ENROLLMENT_SUCCESSOR_TIME_INVALID')
      : fail('APPLE_ENROLLMENT_SUCCESSOR_TIME_INVALID');
    const fixedClock: AppleProductionEnrollmentOwnerClock = Object.freeze({ now: () => occurredAtValue });
    const fixedIssuer: AppleProductionEnrollmentOwnerIssuer = Object.freeze({
      issueUuidV7: ({ purpose, occurredAt }: { readonly purpose: string; readonly occurredAt: string }) => options.issuer.issueUuidV7({
        purpose: `${requestIdValue}.${purpose}`,
        occurredAt,
      }),
      issueCanonicalObjectVersionRef: (value: Parameters<AppleProductionEnrollmentOwnerIssuer['issueCanonicalObjectVersionRef']>[0]) =>
        options.issuer.issueCanonicalObjectVersionRef(value),
    });
    const owner = createAppleProductionEnrollmentOwner({
      ...options,
      clock: fixedClock,
      issuer: fixedIssuer,
    });
    const prepared = await owner.prepare();
    const receipt = await owner.commit(prepared);
    if (receipt.bundleSha256 !== prepared.bundleSha256) fail('APPLE_ENROLLMENT_SUCCESSOR_COMMIT_MISMATCH');
    parseDurableSuccessorBundle(prepared.bundleBytes);
    const successorEnrollment = Object.freeze({
      schema: 'paios.realtime-production-enrollment-successor.v1',
      bundle_base64: Buffer.from(prepared.bundleBytes).toString('base64'),
      bundle_sha256: receipt.bundleSha256,
      expires_at: receipt.expiresAt,
    });
    return Object.freeze({
      successorEnrollment,
      recipientDeviceCredentialRef: cloneJson(prepared.credentialRef),
    });
  };
  const read = async (input: Readonly<Record<string, unknown>>): Promise<JsonRecord> => {
    const request = isPlainRecord(input.request) ? input.request : undefined;
    const bearer = isPlainRecord(input.bearer) ? input.bearer : undefined;
    const committed = isPlainRecord(input.committed) ? input.committed : undefined;
    if (request?.operation !== 'bootstrap' || committed?.operation !== 'bootstrap' ||
        committed.status !== 'bootstrap_accepted' || committed.request_id !== request.request_id || bearer === undefined) {
      fail('APPLE_ENROLLMENT_RECOVERY_FACT_INVALID');
    }
    const nowMs = clockMillis(options.clock);
    const authorityPath = ensureSafePath(options.authorityPath, 'APPLE_ENROLLMENT_AUTHORITY_PATH_INVALID');
    const outputPath = ensureSafePath(options.outputPath, 'APPLE_ENROLLMENT_OUTPUT_PATH_INVALID');
    const authority = readAuthorityAtPath(authorityPath, options.authorityHashPort.current(), nowMs);
    const current = await readCurrent(options.currentBinding, nowMs);
    assertBindingMatchesAuthority(authority.parsed, current);
    if (bearer.deviceId !== authority.parsed.deviceId || !same(bearer.principal, authority.parsed.value.principal_ref) ||
        !same(committed.realtime_session_ref, current.binding.session.realtimeSessionRef) ||
        !same(committed.device_lease_ref, current.binding.lease.deviceLeaseRef) ||
        committed.continuity_id !== current.binding.session.continuityId ||
        String(committed.connection_epoch) !== String(current.binding.session.connectionEpoch) ||
        !Array.isArray(committed.transport_aliases) || !same(normalizeAliases(current.binding, committed.transport_aliases), current.aliases)) {
      fail('APPLE_ENROLLMENT_RECOVERY_BINDING_MISMATCH');
    }
    const recipient = authority.parsed.value.recipient_device_credential;
    if (!isPlainRecord(recipient)) fail('APPLE_ENROLLMENT_RECIPIENT_MISSING');
    const replay = readDurableSuccessorReplay(authorityPath, outputPath, authority, current, recipient, nowMs,
      options.schemaRegistry ?? createRealtimeSchemaRegistry());
    if (replay === undefined || !isPlainRecord(committed.successor_enrollment) ||
        committed.successor_enrollment.bundle_sha256 !== replay.bundleSha256 ||
        committed.successor_enrollment.bundle_base64 !== Buffer.from(replay.bundleBytes).toString('base64') ||
        committed.successor_enrollment.expires_at !== replay.expiresAt) {
      fail('APPLE_ENROLLMENT_RECOVERY_SUCCESSOR_MISMATCH');
    }
    return Object.freeze({
      successor_enrollment: cloneJson(committed.successor_enrollment),
      transport_aliases: cloneJson(committed.transport_aliases),
      e2ee_key_envelope: cloneJson(committed.e2ee_key_envelope),
    });
  };
  const close = async (): Promise<void> => {
    closeFlight ??= Promise.resolve();
    await closeFlight;
  };
  return Object.freeze({ ensure, read, close });
}

export async function prepareAppleProductionEnrollment(options: AppleProductionEnrollmentOwnerOptions): Promise<AppleProductionEnrollmentPrepared> {
  return createAppleProductionEnrollmentOwner(options).prepare();
}

export async function runAppleProductionEnrollment(
  options: AppleProductionEnrollmentOwnerOptions,
  mode: 'prepare' | 'commit' = 'prepare',
): Promise<AppleProductionEnrollmentPrepared | AppleProductionEnrollmentCommitReceipt> {
  return createAppleProductionEnrollmentOwner(options).run(mode);
}

/** The deliberately tiny command surface for the owner-only Windows runner. */
export interface AppleProductionEnrollmentCliArguments {
  readonly registrationPath: string;
  readonly expectedAuthoritySha256: string;
  readonly mode: 'prepare' | 'commit';
  readonly outputPath: string;
}

export interface AppleProductionEnrollmentRuntimeOwner {
  readonly owner: AppleProductionEnrollmentOwner;
  readonly close: () => Promise<void>;
}

export interface AppleProductionEnrollmentRuntimeOverrides {
  /** Test-only seams; production callers leave every member undefined. */
  readonly pool?: RuntimePool;
  readonly createPool?: (options: PostgresPoolOptions) => RuntimePool;
  readonly currentBinding?: AppleCurrentBindingSnapshotProvider;
  readonly issuer?: AppleProductionEnrollmentOwnerIssuer;
  readonly assertOwnerProtected?: (path: string) => void;
  readonly readPostgresPassword?: () => string;
}

export interface AppleProductionEnrollmentCliDependencies {
  readonly createRuntimeOwner?: (
    args: AppleProductionEnrollmentCliArguments,
  ) => AppleProductionEnrollmentRuntimeOwner | Promise<AppleProductionEnrollmentRuntimeOwner>;
}

const CLI_FLAGS = Object.freeze(new Set([
  '--registration-path',
  '--expected-authority-sha256',
  '--mode',
  '--output-path',
]));
const CLI_SECRET_ARGUMENT = /(?:api[_-]?(?:key|secret)|bearer|password|private[_-]?key|secret|token)/iu;
const CLI_DEFAULT_REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const CLI_POSTGRES_PASSWORD_PATH = resolve(
  CLI_DEFAULT_REPO_ROOT,
  '.runtime', 'postgresql-18.6', 'secrets', 'postgres.password',
);
const CLI_POSTGRES_OPTIONS: Readonly<Omit<PostgresPoolOptions, 'password'>> = Object.freeze({
  host: '127.0.0.1',
  port: 55432,
  database: 'personal_ai_os',
  user: 'paios_memory_app',
  max: 1,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 5_000,
  applicationName: 'paios-apple-production-enrollment',
});
const CLI_OWNER_ACL_TIMEOUT_MS = 5_000;
const CLI_OWNER_ACL_TARGET_ENV = 'PAIOS_ENROLLMENT_ACL_TARGET';
const CLI_OWNER_ACL_SCRIPT = String.raw`& {
  $ErrorActionPreference = 'Stop'
  $path = [Environment]::GetEnvironmentVariable('PAIOS_ENROLLMENT_ACL_TARGET')
  if ([string]::IsNullOrWhiteSpace($path)) { exit 10 }
  $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($acl.Owner -cne $owner -or $acl.AreAccessRulesProtected -ne $true) { exit 11 }
  $rules = @($acl.Access | Where-Object { $_.IdentityReference.Value -ceq $owner })
  if ($rules.Count -ne 1 -or @($acl.Access).Count -ne 1) { exit 12 }
  $rule = $rules[0]
  if ($rule.AccessControlType -cne 'Allow' -or $rule.FileSystemRights -cne 'FullControl' -or
      $rule.IsInherited -ne $false -or $rule.InheritanceFlags -cne 'None' -or
      $rule.PropagationFlags -cne 'None') { exit 13 }
  exit 0
}`;

function encodedPowerShell(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function windowsPowerShellEnvironment(path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (systemRoot !== undefined) environment.PSModulePath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`;
  delete environment.PSModuleAnalysisCachePath;
  environment[CLI_OWNER_ACL_TARGET_ENV] = path;
  return environment;
}

function cliFail(code: string, cause?: unknown): never {
  return fail(code, cause);
}

function cliPathUnderEnrollmentRoot(value: unknown, code: string, repoRoot: string): string {
  const candidate = ensureSafePath(value as string, code);
  const root = resolve(repoRoot, '.runtime', 'apple-production-enrollment');
  const child = relative(root, candidate);
  if (child.length === 0 || /^(?:\.\.(?:[\\/]|$))|^[\\/]/u.test(child)) cliFail(code);
  return candidate;
}

function cliExpectedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value)) {
    cliFail('APPLE_ENROLLMENT_CLI_AUTHORITY_HASH_INVALID');
  }
  return value.toLowerCase();
}

/** Parse only the four admitted flags; no positional or secret-bearing input is accepted. */
export function parseAppleProductionEnrollmentCliArgs(
  argv: readonly string[],
  repoRoot: string = CLI_DEFAULT_REPO_ROOT,
): AppleProductionEnrollmentCliArguments {
  if (!Array.isArray(argv)) cliFail('APPLE_ENROLLMENT_CLI_ARGUMENTS_INVALID');
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (typeof flag !== 'string' || CLI_SECRET_ARGUMENT.test(flag) || !CLI_FLAGS.has(flag)) {
      cliFail('APPLE_ENROLLMENT_CLI_ARGUMENT_FORBIDDEN');
    }
    if (values.has(flag)) cliFail('APPLE_ENROLLMENT_CLI_ARGUMENT_DUPLICATE');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || CLI_SECRET_ARGUMENT.test(value)) {
      cliFail('APPLE_ENROLLMENT_CLI_ARGUMENT_VALUE_INVALID');
    }
    values.set(flag, value);
    index += 1;
  }
  const registrationPath = values.get('--registration-path');
  const expectedAuthoritySha256 = values.get('--expected-authority-sha256');
  const mode = values.get('--mode');
  if (registrationPath === undefined || expectedAuthoritySha256 === undefined || mode === undefined) {
    cliFail('APPLE_ENROLLMENT_CLI_ARGUMENTS_INCOMPLETE');
  }
  if (mode !== 'prepare' && mode !== 'commit') cliFail('APPLE_ENROLLMENT_CLI_MODE_INVALID');
  const root = resolve(repoRoot);
  const outputPath = values.get('--output-path') === undefined
    ? resolve(root, '.runtime', 'apple-production-enrollment', 'apple-production-enrollment-bundle.v1.json')
    : cliPathUnderEnrollmentRoot(values.get('--output-path'), 'APPLE_ENROLLMENT_CLI_OUTPUT_PATH_INVALID', root);
  return Object.freeze({
    registrationPath: cliPathUnderEnrollmentRoot(registrationPath, 'APPLE_ENROLLMENT_CLI_REGISTRATION_PATH_INVALID', root),
    expectedAuthoritySha256: cliExpectedHash(expectedAuthoritySha256),
    mode,
    outputPath,
  });
}

function runtimeFile(path: string, code: string, expectedKind: 'file' | 'directory' = 'file'): void {
  try {
    assertNoReparse(path, code);
    const facts = lstatSync(path);
    if (expectedKind === 'file' ? !facts.isFile() : !facts.isDirectory()) cliFail(code);
  } catch (error) {
    if (error instanceof AppleProductionEnrollmentOwnerError) throw error;
    cliFail(code, error);
  }
}

export function assertAppleEnrollmentOwnerProtectedPath(
  path: string, expectedKind: 'file' | 'directory' = 'file',
): void {
  if (expectedKind !== 'file' && expectedKind !== 'directory') cliFail('APPLE_ENROLLMENT_OWNER_KIND_INVALID');
  runtimeFile(path, 'APPLE_ENROLLMENT_OWNER_FILE_INVALID', expectedKind);
  if (process.platform !== 'win32') {
    const facts = lstatSync(path);
    if ((facts.mode & 0o077) !== 0 || facts.uid !== process.getuid?.() ||
        (expectedKind === 'directory' && (facts.mode & 0o700) !== 0o700)) {
      cliFail('APPLE_ENROLLMENT_OWNER_ACL_INVALID');
    }
    return;
  }
  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(CLI_OWNER_ACL_SCRIPT),
    ], {
      stdio: 'ignore',
      timeout: CLI_OWNER_ACL_TIMEOUT_MS,
      windowsHide: true,
      env: windowsPowerShellEnvironment(path),
    });
  } catch (error) {
    const exitStatus = typeof error === 'object' && error !== null &&
      typeof (error as { readonly status?: unknown }).status === 'number'
      ? (error as { readonly status: number }).status
      : undefined;
    void exitStatus;
    cliFail('APPLE_ENROLLMENT_OWNER_ACL_INVALID', error);
  }
}

const assertRuntimeOwnerProtected = assertAppleEnrollmentOwnerProtectedPath;

function readRuntimePostgresPassword(): string {
  runtimeFile(CLI_POSTGRES_PASSWORD_PATH, 'APPLE_ENROLLMENT_POSTGRES_PASSWORD_REF_INVALID');
  let value: string;
  try {
    value = readFileSync(CLI_POSTGRES_PASSWORD_PATH, 'utf8').replace(/\r?\n$/u, '');
  } catch (error) {
    cliFail('APPLE_ENROLLMENT_POSTGRES_PASSWORD_REF_INVALID', error);
  }
  if (value.length === 0 || value.includes('\u0000') || value.includes('\r') || value.includes('\n')) {
    cliFail('APPLE_ENROLLMENT_POSTGRES_PASSWORD_REF_INVALID');
  }
  return value;
}

function runtimeJsonValue(value: unknown, code: string): unknown {
  if (value === undefined || value === null) cliFail(code);
  if (typeof value === 'string') {
    try { return cloneJson(JSON.parse(value) as unknown); }
    catch (error) { cliFail(code, error); }
  }
  try { return cloneJson(value); }
  catch (error) { cliFail(code, error); }
}

function runtimeRecordValue(value: unknown, code: string): JsonRecord {
  const result = runtimeJsonValue(value, code);
  if (!isPlainRecord(result)) cliFail(code);
  return result;
}

function runtimeTimestampValue(value: unknown, code: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) cliFail(code);
  return parsed.toISOString();
}

function runtimeCurrentProjection(row: JsonRecord): RealtimeCurrentBindingProjection {
  const sessionRef = runtimeRecordValue(row.s_realtime_session_ref, 'APPLE_ENROLLMENT_CURRENT_SESSION_REF_INVALID');
  const leaseRef = runtimeRecordValue(row.l_device_lease_ref, 'APPLE_ENROLLMENT_CURRENT_LEASE_REF_INVALID');
  const activeLeaseRef = runtimeRecordValue(row.s_active_device_lease_ref, 'APPLE_ENROLLMENT_CURRENT_LEASE_REF_INVALID');
  const leaseSessionRef = runtimeRecordValue(row.l_realtime_session_ref, 'APPLE_ENROLLMENT_CURRENT_SESSION_REF_INVALID');
  const binding = runtimeRecordValue(row.s_binding, 'APPLE_ENROLLMENT_CURRENT_BINDING_INVALID');
  const capabilitiesValue = runtimeJsonValue(row.l_capabilities, 'APPLE_ENROLLMENT_CURRENT_CAPABILITIES_INVALID');
  if (!Array.isArray(capabilitiesValue) || capabilitiesValue.some((item) => typeof item !== 'string')) {
    cliFail('APPLE_ENROLLMENT_CURRENT_CAPABILITIES_INVALID');
  }
  if (row.s_user_id === undefined || row.s_continuity_id === undefined || row.s_active_device_id === undefined ||
      row.s_connection_epoch === undefined || row.s_revision === undefined || row.l_user_id === undefined ||
      row.l_device_id === undefined || row.l_continuity_id === undefined || row.l_purpose === undefined ||
      row.l_lease_version === undefined || row.l_fencing_token === undefined || row.l_policy_decision_ref === undefined ||
      row.s_continuity_expires_at === null || row.s_continuity_expires_at === undefined ||
      row.s_last_accepted_activity_at === null || row.s_last_accepted_activity_at === undefined ||
      row.l_issued_at === null || row.l_issued_at === undefined || row.l_expires_at === null || row.l_expires_at === undefined) {
    cliFail('APPLE_ENROLLMENT_CURRENT_BINDING_INVALID');
  }
  const session = {
    realtimeSessionRef: sessionRef,
    userId: String(row.s_user_id),
    continuityId: String(row.s_continuity_id),
    state: String(row.s_state),
    continuityState: String(row.s_continuity_state),
    connectionEpoch: String(row.s_connection_epoch) as never,
    continuityExpiresAt: runtimeTimestampValue(row.s_continuity_expires_at, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID') as never,
    lastAcceptedUserActivityAt: runtimeTimestampValue(row.s_last_accepted_activity_at, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID') as never,
    activeDeviceId: String(row.s_active_device_id),
    activeDeviceLeaseRef: activeLeaseRef,
    binding: binding as never,
    revision: String(row.s_revision) as never,
  };
  const lease = {
    deviceLeaseRef: leaseRef,
    realtimeSessionRef: leaseSessionRef,
    continuityId: String(row.l_continuity_id),
    userId: String(row.l_user_id),
    deviceId: String(row.l_device_id),
    state: String(row.l_state),
    capabilities: Object.freeze([...(capabilitiesValue as string[])]),
    purpose: String(row.l_purpose),
    issuedAt: runtimeTimestampValue(row.l_issued_at, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID') as never,
    expiresAt: runtimeTimestampValue(row.l_expires_at, 'APPLE_ENROLLMENT_CURRENT_EXPIRY_INVALID') as never,
    revocable: row.l_revocable === true,
    leaseVersion: String(row.l_lease_version) as never,
    fencingToken: String(row.l_fencing_token) as never,
    policyDecisionRef: runtimeRecordValue(row.l_policy_decision_ref, 'APPLE_ENROLLMENT_CURRENT_POLICY_REF_INVALID'),
  };
  if (lease.revocable !== true) cliFail('APPLE_ENROLLMENT_CURRENT_BINDING_INVALID');
  return Object.freeze({ session, lease }) as RealtimeCurrentBindingProjection;
}

/**
 * Read the authoritative row and its optional Watch handoff target in one
 * RR/RO snapshot.  The repository remains the source of the pool and row contract;
 * this read-only query avoids the repository's lifecycle `FOR UPDATE` read.
 */
export function createRuntimeCurrentBindingProvider(
  repositoryPool: RuntimePool,
  selector: Readonly<{ readonly userId: string; readonly deviceId: string; readonly principalRef?: unknown; readonly readPrincipalRef?: () => unknown }>,
): AppleCurrentBindingSnapshotProvider {
  const companion = createApplePhysicalCanaryBindingPostgres({ pool: repositoryPool,
    identity: createProductionRealtimeIdentityPort({ clock: { now: () => assertCanonicalTimestamp(new Date().toISOString()) } }),
    canonicalDeviceIssuer: createProductionRealtimeCanonicalDeviceIdentityIssuer() });
  const readSnapshot = async (client: import('../../../services/platform-data/src/realtime-credential-fence.ts').CredentialFenceAdmissionClient): Promise<AppleCurrentBindingSnapshotEnvelope | undefined> => {
        const result = await client.query([
          'SELECT',
          's.realtime_session_ref AS s_realtime_session_ref, s.user_id AS s_user_id,',
          's.continuity_id AS s_continuity_id, s.state AS s_state, s.continuity_state AS s_continuity_state,',
          's.connection_epoch AS s_connection_epoch, s.continuity_expires_at AS s_continuity_expires_at,',
          's.last_accepted_activity_at AS s_last_accepted_activity_at, s.active_device_id AS s_active_device_id,',
          's.active_device_lease_ref AS s_active_device_lease_ref, s.binding AS s_binding, s.revision AS s_revision,',
          'l.device_lease_ref AS l_device_lease_ref, l.realtime_session_ref AS l_realtime_session_ref,',
          'l.user_id AS l_user_id, l.device_id AS l_device_id, l.continuity_id AS l_continuity_id,',
          'l.state AS l_state, l.capabilities AS l_capabilities, l.purpose AS l_purpose,',
          'l.issued_at AS l_issued_at, l.expires_at AS l_expires_at, l.revocable AS l_revocable,',
          'l.lease_version AS l_lease_version, l.fencing_token AS l_fencing_token,',
          'l.policy_decision_ref AS l_policy_decision_ref',
          'FROM realtime_sessions AS s',
          "JOIN device_leases AS l ON l.lease_ref_id::text = s.active_device_lease_ref->>'ref_id'",
          "WHERE s.user_id = $1::uuid AND s.active_device_id = $2::uuid",
          "  AND s.state = 'active' AND s.continuity_state = 'active'",
          "  AND s.binding->>'state' = 'connected' AND l.state = 'active'",
          '  AND l.device_id = $2::uuid AND l.purpose = $3',
        ].join(' '), [selector.userId, selector.deviceId, T03_APPLE_CYCLING_PURPOSE]);
        if (result.rows.length === 0) return undefined;
        if (result.rows.length !== 1) cliFail('APPLE_ENROLLMENT_CURRENT_BINDING_CONFLICT');
        const row = result.rows[0]!;
        const binding = runtimeCurrentProjection(row);
        const refs = { realtimeSessionRef: binding.session.realtimeSessionRef!, iphoneDeviceLeaseRef: binding.lease.deviceLeaseRef! };
        const formalWatchPairState = await companion.readFormalPairStateInTransaction(client, refs, selector.readPrincipalRef?.() ?? selector.principalRef);
        const formalWatchBinding = formalWatchPairState.requiresRebind ? undefined : await companion.readFormalByPrimaryInTransaction(client, refs);
        return Object.freeze({ binding, formalWatchPairState,
          ...(formalWatchBinding === undefined ? {} : { formalWatchBinding, handoffDeviceId: formalWatchBinding.watch.deviceId }),
        });
  };
  return Object.freeze({snapshotIsolation:'REPEATABLE READ' as const,readOnly:true as const,
    readCurrentBindingSnapshotInAdmission:readSnapshot,
    readCurrentBindingSnapshot:async()=>withTransaction(repositoryPool,readSnapshot,{isolation:'REPEATABLE READ',readOnly:true}),
  });
}

export function createRuntimeOwnerIssuer(
  identity: RealtimeIdentityPort,
  deviceId: string,
): AppleProductionEnrollmentOwnerIssuer {
  let sequence = 0;
  return Object.freeze({
    issueUuidV7: ({ purpose, occurredAt }: { readonly purpose: string; readonly occurredAt: string }): string => {
      if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(purpose)) cliFail('APPLE_ENROLLMENT_OWNER_UUID_INPUT_INVALID');
      timestamp(occurredAt, 'APPLE_ENROLLMENT_OWNER_UUID_TIME_INVALID');
      sequence += 1;
      try {
        return identity.createConnectionId({
          deviceId,
          requestId: `t03.apple.enrollment.${purpose}.${occurredAt}.${sequence}`,
        });
      } catch (error) {
        cliFail('APPLE_ENROLLMENT_OWNER_UUID_ISSUER_FAILED', error);
      }
    },
    issueCanonicalObjectVersionRef: (input: {
      readonly refType: 'DeviceCredential';
      readonly refId: string;
      readonly objectVersion: '1';
      readonly canonicalPayloadSha256: string;
    }): unknown => {
      try {
        const ref = createCanonicalObjectVersionRef({
          refType: input.refType,
          refId: input.refId,
          objectVersion: input.objectVersion,
          canonicalPayloadSha256: input.canonicalPayloadSha256,
        });
        return Object.freeze({
          ref_type: ref.refType,
          ref_id: ref.refId,
          object_version: ref.objectVersion,
          canonical_payload_sha256: ref.canonicalPayloadSha256,
        });
      } catch (error) {
        cliFail('APPLE_ENROLLMENT_CVR_ISSUER_FAILED', error);
      }
    },
  });
}

export function createAppleProductionEnrollmentRuntimeOwner(
  args: AppleProductionEnrollmentCliArguments,
  overrides: AppleProductionEnrollmentRuntimeOverrides = {},
): AppleProductionEnrollmentRuntimeOwner {
  const authorityPath = T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH;
  const outputPath = ensureSafePath(args.outputPath, 'APPLE_ENROLLMENT_CLI_OUTPUT_PATH_INVALID');
  const registrationPath = cliPathUnderEnrollmentRoot(
    args.registrationPath, 'APPLE_ENROLLMENT_CLI_REGISTRATION_PATH_INVALID', CLI_DEFAULT_REPO_ROOT,
  );
  const expectedAuthoritySha256 = cliExpectedHash(args.expectedAuthoritySha256);
  const now = (): string => new Date().toISOString();
  const clock: AppleProductionEnrollmentOwnerClock = Object.freeze({ now });
  const ownerProtection = overrides.assertOwnerProtected ?? assertRuntimeOwnerProtected;
  const registration: ApplePublicRegistrationFileReader = Object.freeze({
    path: registrationPath,
    read: () => {
      ownerProtection(registrationPath);
      try { return new Uint8Array(readFileSync(registrationPath)); }
      catch (error) { cliFail('APPLE_ENROLLMENT_REGISTRATION_UNAVAILABLE', error); }
    },
    assertOwnerProtected: ownerProtection,
  });
  ownerProtection(authorityPath);
  const authority = readAuthorityAtPath(authorityPath, expectedAuthoritySha256, Date.now());
  const password = overrides.readPostgresPassword?.() ?? readRuntimePostgresPassword();
  const pool = overrides.pool ?? (overrides.createPool ?? createPostgresPool)({
    ...CLI_POSTGRES_OPTIONS,
    password,
  });
  const ownsPool = overrides.pool === undefined;
  const repository = createRealtimeAuthorityRepository(pool);
  const identity = createProductionRealtimeIdentityPort({
    clock: Object.freeze({ now: () => assertCanonicalTimestamp(now()) }),
  });
  const currentBinding = overrides.currentBinding ?? createRuntimeCurrentBindingProvider(repository.pool, {
    userId: authority.parsed.userId,
    deviceId: authority.parsed.deviceId,
    principalRef: authority.parsed.value.principal_ref,
  });
  const issuer = overrides.issuer ?? createRuntimeOwnerIssuer(identity, authority.parsed.deviceId);
  let authorityHash = expectedAuthoritySha256;
  const owner = createAppleProductionEnrollmentOwner({
    registration,
    authorityPath,
    expectedAuthoritySha256,
    currentBinding,
    issuer,
    clock,
    outputPath,
    authorityHashPort: {
      current: () => authorityHash,
      updateAfterCommit: ({ previousSha256, nextSha256 }) => {
        if (authorityHash !== previousSha256) cliFail('APPLE_ENROLLMENT_AUTHORITY_HASH_DRIFT');
        authorityHash = nextSha256;
      },
    },
  });
  let closeFlight: Promise<void> | undefined;
  return Object.freeze({
    owner,
    close: async () => {
      if (!ownsPool) return;
      closeFlight ??= closePostgresPool(pool);
      await closeFlight;
    },
  });
}

function cliReceipt(
  result: AppleProductionEnrollmentPrepared | AppleProductionEnrollmentCommitReceipt,
): JsonRecord {
  if ('nextAuthoritySha256' in result) {
    return Object.freeze({
      status: 'prepared',
      authority_sha256: result.nextAuthoritySha256,
      bundle_sha256: result.bundleSha256,
      canonical_body_count: Object.keys(result.canonicalBodySha256).length,
      expires_at: result.expiresAt,
    });
  }
  return Object.freeze({
    status: result.status,
    authority_sha256: result.authoritySha256,
    bundle_sha256: result.bundleSha256,
    canonical_body_count: result.canonicalBodyCount ?? OPERATIONS.length,
    expires_at: result.expiresAt,
  });
}

export async function runAppleProductionEnrollmentCli(
  argv: readonly string[],
  dependencies: AppleProductionEnrollmentCliDependencies = {},
  repoRoot: string = CLI_DEFAULT_REPO_ROOT,
): Promise<JsonRecord> {
  const args = parseAppleProductionEnrollmentCliArgs(argv, repoRoot);
  const handle = dependencies.createRuntimeOwner === undefined
    ? createAppleProductionEnrollmentRuntimeOwner(args)
    : await dependencies.createRuntimeOwner(args);
  try {
    return cliReceipt(await handle.owner.run(args.mode));
  } finally {
    await handle.close();
  }
}

// Keep the module executable without inventing a dependency or starting a
// gateway: the CLI supplies only the persistent owner adapters above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void runAppleProductionEnrollmentCli(process.argv.slice(2)).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }).catch((error: unknown) => {
    const code = error instanceof AppleProductionEnrollmentOwnerError && /^[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : 'APPLE_ENROLLMENT_CLI_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  });
}
