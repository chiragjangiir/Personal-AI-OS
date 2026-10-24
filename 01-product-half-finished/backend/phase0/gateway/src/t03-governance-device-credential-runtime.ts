import { createHash } from 'node:crypto';

import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeGovernanceDecision,
  RealtimeGovernancePort,
  RealtimeOperation,
} from './realtime-public-control-runtime.ts';

const OPERATIONS = new Set<RealtimeOperation>([
  'bootstrap',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
  'realtime_e2ee_key_resolve',
]);

export const T03_GOVERNANCE_REASONS = [
  'T03_REQUEST_INVALID',
  'T03_OPERATION_UNSUPPORTED',
  'T03_GOVERNANCE_MISSING',
  'T03_GOVERNANCE_INVALID',
  'T03_CLOCK_INVALID',
  'T03_AUTHORITY_MISSING',
  'T03_AUTHORITY_UNAVAILABLE',
  'T03_AUTHORITY_DENIED',
  'T03_AUTHORITY_ABSTAINED',
  'T03_AUTHORITY_EXPIRED',
  'T03_AUTHORITY_REVOKED',
  'T03_AUTHORITY_SUPERSEDED',
  'T03_AUTHORITY_DELETED',
  'T03_AUTHORITY_INVALID',
  'T03_BINDING_MISSING',
  'T03_BINDING_UNAVAILABLE',
  'T03_BINDING_INVALID',
  'T03_BINDING_MISMATCH',
  'T03_BEARER_INVALID',
  'T03_BEARER_EXPIRED',
  'T03_BEARER_PRINCIPAL_MISMATCH',
  'T03_BEARER_DEVICE_MISMATCH',
  'T03_SUBJECT_MISMATCH',
  'T03_USER_MISMATCH',
  'T03_CAPABILITY_MISMATCH',
  'T03_AUDIENCE_MISMATCH',
  'T03_LINKAGE_MISMATCH',
  'T03_RECIPIENT_MISSING',
  'T03_RECIPIENT_UNAVAILABLE',
  'T03_RECIPIENT_INVALID',
] as const;

export type T03GovernanceReason = (typeof T03_GOVERNANCE_REASONS)[number];

export interface T03AuthoritySnapshotResolveInput {
  readonly operation: RealtimeOperation;
  readonly request: JsonRecord;
  readonly bearer: RealtimeBearerContext;
  readonly atSystemTime: string;
}

export interface T03RealtimeBindingResolveInput extends T03AuthoritySnapshotResolveInput {}

/** T02-owned current authority read seam. It has no persistence behavior here. */
export interface T03AuthoritySnapshotPort {
  resolve(input: T03AuthoritySnapshotResolveInput): Promise<unknown>;
}

/** T11B-owned current realtime binding read seam. */
export interface T03RealtimeBindingPort {
  resolve(input: T03RealtimeBindingResolveInput): Promise<unknown>;
}

export interface T03RecipientX25519PublicKeyResolveInput {
  readonly operation: 'realtime_e2ee_key_resolve';
  readonly request: JsonRecord;
  readonly bearer: RealtimeBearerContext;
  readonly atSystemTime: string;
  readonly deviceCredentialRef: unknown;
}

export interface T03RecipientX25519PublicKeyProjection {
  readonly deviceCredentialRef: unknown;
  readonly publicKeyAlgorithm: 'X25519';
  readonly publicKeyPurpose: 'hpke_recipient';
  readonly publicKeyEncoding: 'base64url-unpadded';
  readonly publicKey: string;
  readonly publicKeySha256: string;
  readonly audience: unknown;
  readonly deviceId: unknown;
  readonly realtimeSessionRef: unknown;
  readonly deviceLeaseRef: unknown;
  readonly continuityId: unknown;
  readonly expiresAt: string;
  readonly revocation: unknown;
  readonly supersession: unknown;
  readonly deletion: unknown;
  readonly algorithm?: 'X25519';
  readonly keyType?: 'X25519';
  readonly purpose?: 'hpke_recipient';
  readonly usage?: 'hpke_recipient';
  readonly encoding?: 'base64url-unpadded';
  readonly publicKeyBase64Url?: string;
  readonly fingerprintSha256?: string;
  readonly publicKeyFingerprintSha256?: string;
  readonly revocationLinkage?: unknown;
  readonly supersessionLinkage?: unknown;
  readonly deletionLinkage?: unknown;
}

/** T03 returns an opaque public-key projection; it never returns private material. */
export interface T03RecipientX25519PublicKeyPort {
  resolve(input: T03RecipientX25519PublicKeyResolveInput): Promise<unknown>;
}

export interface T03GovernanceDeviceCredentialRuntimeOptions {
  readonly authority?: T03AuthoritySnapshotPort;
  readonly authoritySnapshot?: T03AuthoritySnapshotPort;
  readonly binding?: T03RealtimeBindingPort;
  readonly realtimeBinding?: T03RealtimeBindingPort;
  readonly recipientPublicKey?: T03RecipientX25519PublicKeyPort;
  readonly recipientX25519PublicKey?: T03RecipientX25519PublicKeyPort;
  readonly now?: () => number | string | Date;
  readonly clock?: () => number | string | Date;
}

type MutableRecord = Record<string, unknown>;

const OWN_KEY_NAMES = new Set([
  'private',
  'privatekey',
  'private_key',
  'secret',
  'secretkey',
  'secret_key',
  'plaintext',
  'plaintextkey',
  'plaintext_key',
  'contentkey',
  'content_key',
  'keymaterial',
  'key_material',
  'roomoptions',
  'room_options',
  'token',
  'password',
]);

const LOOKUP_KEYS = {
  deviceCredentialRef: ['deviceCredentialRef', 'device_credential_ref', 'recipientDeviceCredentialRef', 'recipient_device_credential_ref', 'credentialRef', 'credential_ref'],
  deviceId: ['deviceId', 'device_id'],
  session: ['realtimeSessionRef', 'realtime_session_ref', 'sessionRef', 'session_ref', 'session'],
  lease: ['deviceLeaseRef', 'device_lease_ref', 'leaseRef', 'lease_ref', 'lease', 'deviceLease', 'device_lease'],
  currentLease: ['currentDeviceLeaseRef', 'current_device_lease_ref'],
  continuity: ['continuityId', 'continuity_id', 'continuityRef', 'continuity_ref', 'continuity'],
  epoch: ['connectionEpoch', 'connection_epoch', 'epoch'],
  aliases: ['transportAliases', 'transport_aliases', 'aliases'],
  audience: ['audience', 'participantAudience', 'participant_audience'],
  expiresAt: ['expiresAt', 'expires_at', 'credentialExpiresAt', 'credential_expires_at'],
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value: JsonRecord, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function first(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const found = own(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstRecord(value: unknown, keys: readonly string[]): JsonRecord | undefined {
  const found = first(value, keys);
  return isRecord(found) ? found : undefined;
}

function nestedCandidate(value: unknown, keys: readonly string[]): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = firstRecord(value, [key]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function asNonEmpty(value: unknown): unknown {
  if (typeof value === 'string') return value.length === 0 ? undefined : value;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return value;
  return undefined;
}

function equalValue(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const prior = seen.get(left as object);
  if (prior === right) return true;
  seen.set(left as object, right as object);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => equalValue(item, right[index], seen));
  }
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => equalValue(leftRecord[key], rightRecord[key], seen));
}

function cloneAndFreeze(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('T03_GOVERNANCE_MISSING');
    return value;
  }
  if (typeof value !== 'object') throw new Error('T03_GOVERNANCE_MISSING');
  const prior = seen.get(value);
  if (prior !== undefined) throw new Error('T03_GOVERNANCE_MISSING');
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneAndFreeze(item, seen));
    return Object.freeze(result);
  }
  const result: MutableRecord = {};
  seen.set(value, result);
  for (const key of Object.keys(value)) result[key] = cloneAndFreeze((value as JsonRecord)[key], seen);
  return Object.freeze(result);
}

function stableClone(value: unknown): unknown {
  return cloneAndFreeze(value);
}

function timestamp(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function atSystemTime(clock: () => number | string | Date): { readonly text: string; readonly millis: number } | undefined {
  const value = clock();
  const millis = timestamp(value);
  if (millis === undefined) return undefined;
  return { text: new Date(millis).toISOString(), millis };
}

function stateValue(value: unknown): string | undefined {
  const candidate = first(value, ['status', 'state', 'availability', 'disposition', 'decision']);
  return typeof candidate === 'string' ? candidate.toLowerCase() : undefined;
}

function bool(value: unknown, keys: readonly string[]): boolean | undefined {
  const found = first(value, keys);
  return typeof found === 'boolean' ? found : undefined;
}

function linkageState(value: unknown, key: 'revocation' | 'supersession' | 'deletion'): unknown {
  if (!isRecord(value)) return undefined;
  const direct = first(value, [key, `${key}Linkage`, `${key}_linkage`]);
  return direct === undefined ? undefined : direct;
}

function forbiddenKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/gu, '_').toLowerCase();
  return OWN_KEY_NAMES.has(normalized)
    || normalized.includes('private')
    || normalized.includes('secret')
    || normalized.includes('plaintext')
    || normalized.includes('content_key')
    || normalized.includes('key_material')
    || normalized.includes('room_options')
    || normalized === 'd';
}

function rejectSecretShape(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('T03_RECIPIENT_INVALID');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretShape(item, seen);
    seen.delete(value);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey(key)) throw new Error('T03_RECIPIENT_INVALID');
    rejectSecretShape(item, seen);
  }
  seen.delete(value);
}

function decodePublicKey(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) throw new Error('T03_RECIPIENT_INVALID');
    return new Uint8Array(value);
  }
  if (!isRecord(value)) {
    if (typeof value !== 'string') throw new Error('T03_RECIPIENT_INVALID');
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('T03_RECIPIENT_INVALID');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new Error('T03_RECIPIENT_INVALID');
    return new Uint8Array(bytes);
  }
  const data = first(value, ['data', 'bytes', 'raw', 'value']);
  return decodePublicKey(data);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function keyAlgorithm(value: unknown): string | undefined {
  const candidate = first(value, ['publicKeyAlgorithm', 'public_key_algorithm', 'algorithm', 'keyAlgorithm', 'key_algorithm', 'keyType', 'key_type']);
  return typeof candidate === 'string' ? candidate.trim().toUpperCase() : undefined;
}

function keyPurpose(value: unknown): string | undefined {
  const candidate = first(value, ['publicKeyPurpose', 'public_key_purpose', 'purpose', 'usage', 'use']);
  return typeof candidate === 'string' ? candidate.trim().toLowerCase() : undefined;
}

function rejectP256Metadata(value: unknown): void {
  if (!isRecord(value)) return;
  const candidates = [
    'publicKeyAlgorithm', 'public_key_algorithm', 'algorithm', 'keyAlgorithm', 'key_algorithm',
    'keyType', 'key_type', 'curve', 'kem',
  ];
  for (const key of candidates) {
    const candidate = own(value, key);
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toUpperCase().replace(/[_\s]/gu, '-');
    if (normalized.includes('P-256') || normalized.includes('P256') || normalized.includes('SECP256R1')) {
      throw new Error('T03_RECIPIENT_INVALID');
    }
  }
}

function isActiveLinkage(value: unknown, kind: 'revocation' | 'supersession' | 'deletion'): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value === false;
  if (!isRecord(value)) return false;
  if (bool(value, ['revoked', 'isRevoked', 'superseded', 'isSuperseded', 'deleted', 'isDeleted']) === true) return false;
  const status = stateValue(value);
  if (status === undefined) return true;
  if (kind === 'revocation') return !['revoked', 'rejected', 'invalid'].includes(status);
  if (kind === 'supersession') return !['superseded', 'replaced', 'inactive'].includes(status);
  return !['deleted', 'purged', 'removed'].includes(status);
}

function credentialRef(value: unknown): unknown {
  const found = first(value, LOOKUP_KEYS.deviceCredentialRef);
  if (found !== undefined) return found;
  return undefined;
}

function assertCredentialRef(value: unknown): unknown {
  if (!isRecord(value)) throw new Error('T03_RECIPIENT_INVALID');
  if (value.ref_type !== 'DeviceCredential') throw new Error('T03_RECIPIENT_INVALID');
  if (typeof value.ref_id !== 'string' || value.ref_id.length === 0 || value.ref_id.trim() !== value.ref_id) {
    throw new Error('T03_RECIPIENT_INVALID');
  }
  if (typeof value.object_version !== 'string' || !/^[1-9][0-9]*$/u.test(value.object_version)) {
    throw new Error('T03_RECIPIENT_INVALID');
  }
  return stableClone(value);
}

function installAliases(value: T03RecipientX25519PublicKeyProjection): T03RecipientX25519PublicKeyProjection {
  const target = value as unknown as MutableRecord;
  const aliases: Record<string, unknown> = {
    algorithm: value.publicKeyAlgorithm,
    keyType: value.publicKeyAlgorithm,
    purpose: value.publicKeyPurpose,
    usage: value.publicKeyPurpose,
    encoding: value.publicKeyEncoding,
    publicKeyBase64Url: value.publicKey,
    fingerprintSha256: value.publicKeySha256,
    publicKeyFingerprintSha256: value.publicKeySha256,
    revocationLinkage: value.revocation,
    supersessionLinkage: value.supersession,
    deletionLinkage: value.deletion,
  };
  for (const [key, item] of Object.entries(aliases)) {
    Object.defineProperty(target, key, { configurable: false, enumerable: false, value: item, writable: false });
  }
  return Object.freeze(target) as unknown as T03RecipientX25519PublicKeyProjection;
}

export function projectT03RecipientX25519PublicKey(value: unknown): T03RecipientX25519PublicKeyProjection {
  try {
    rejectSecretShape(value);
    if (!isRecord(value)) throw new Error('T03_RECIPIENT_INVALID');
    const credential = nestedCandidate(value, ['deviceCredential', 'device_credential', 'recipientDeviceCredential', 'recipient_device_credential', 'credential']);
    const keySource = credential ?? value;
    rejectP256Metadata(value);
    rejectP256Metadata(keySource);
    const publicKeyValue = first(keySource, ['publicKey', 'public_key', 'publicKeyBase64Url', 'public_key_base64url', 'rawPublicKey', 'raw_public_key', 'keyBytes', 'key_bytes']);
    const raw = decodePublicKey(publicKeyValue);
    const algorithm = keyAlgorithm(keySource);
    if (algorithm !== 'X25519') {
      throw new Error('T03_RECIPIENT_INVALID');
    }
    const purpose = keyPurpose(keySource);
    if (purpose !== 'hpke_recipient') throw new Error('T03_RECIPIENT_INVALID');
    const encoded = base64url(raw);
    const fingerprint = sha256(raw);
    const providedFingerprint = first(keySource, ['publicKeySha256', 'public_key_sha256', 'fingerprintSha256', 'fingerprint_sha256', 'sha256']);
    if (providedFingerprint !== undefined && (typeof providedFingerprint !== 'string' || providedFingerprint !== fingerprint)) {
      throw new Error('T03_RECIPIENT_INVALID');
    }
    const credentialValue = credentialRef(keySource) ?? credentialRef(value);
    const audience = asNonEmpty(first(keySource, LOOKUP_KEYS.audience) ?? first(value, LOOKUP_KEYS.audience));
    const deviceId = asNonEmpty(first(keySource, LOOKUP_KEYS.deviceId) ?? first(value, LOOKUP_KEYS.deviceId));
    const session = asNonEmpty(first(keySource, LOOKUP_KEYS.session) ?? first(value, LOOKUP_KEYS.session));
    const lease = asNonEmpty(first(keySource, LOOKUP_KEYS.lease) ?? first(value, LOOKUP_KEYS.lease));
    const continuity = asNonEmpty(first(keySource, LOOKUP_KEYS.continuity) ?? first(value, LOOKUP_KEYS.continuity));
    const expiresAt = first(keySource, LOOKUP_KEYS.expiresAt) ?? first(value, LOOKUP_KEYS.expiresAt);
    if (audience === undefined || deviceId === undefined || session === undefined || lease === undefined || continuity === undefined || typeof expiresAt !== 'string' || timestamp(expiresAt) === undefined) {
      throw new Error('T03_RECIPIENT_INVALID');
    }
    const revocation = linkageState(keySource, 'revocation') ?? linkageState(value, 'revocation');
    const supersession = linkageState(keySource, 'supersession') ?? linkageState(value, 'supersession');
    const deletion = linkageState(keySource, 'deletion') ?? linkageState(value, 'deletion');
    if (revocation === undefined || supersession === undefined || deletion === undefined) throw new Error('T03_RECIPIENT_INVALID');
    if (!isActiveLinkage(revocation, 'revocation') || !isActiveLinkage(supersession, 'supersession') || !isActiveLinkage(deletion, 'deletion')) {
      throw new Error('T03_RECIPIENT_INVALID');
    }
    return installAliases({
      deviceCredentialRef: assertCredentialRef(credentialValue),
      publicKeyAlgorithm: 'X25519',
      publicKeyPurpose: 'hpke_recipient',
      publicKeyEncoding: 'base64url-unpadded',
      publicKey: encoded,
      publicKeySha256: fingerprint,
      audience: stableClone(audience),
      deviceId: stableClone(deviceId),
      realtimeSessionRef: stableClone(session),
      deviceLeaseRef: stableClone(lease),
      continuityId: stableClone(continuity),
      expiresAt,
      revocation: stableClone(revocation),
      supersession: stableClone(supersession),
      deletion: stableClone(deletion),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'T03_RECIPIENT_INVALID') throw error;
    throw new Error('T03_RECIPIENT_INVALID');
  }
}

export const projectT03RecipientX25519PublicKeyProjection = projectT03RecipientX25519PublicKey;
export const projectRecipientX25519PublicKey = projectT03RecipientX25519PublicKey;

function classify(
  value: unknown,
  missing: T03GovernanceReason,
  unavailable: T03GovernanceReason,
  nowMs: number,
  requiredEvidence?: 'permit' | readonly string[],
  invalidReason?: T03GovernanceReason,
): T03GovernanceReason | undefined {
  if (value === undefined || value === null) return missing;
  if (!isRecord(value)) return unavailable;
  const invalid = invalidReason ?? (unavailable === 'T03_BINDING_UNAVAILABLE' ? 'T03_BINDING_INVALID' : 'T03_AUTHORITY_INVALID');
  if (Object.keys(value).length === 0) return invalid;
  const status = stateValue(value);
  if (bool(value, ['available', 'isAvailable']) === false || ['missing', 'unavailable', 'not_ready', 'error', 'offline'].includes(status ?? '')) return unavailable;
  if (status === 'deny' || status === 'denied' || status === 'rejected' || bool(value, ['accepted', 'authorized', 'permitted']) === false) return invalidReason ?? 'T03_AUTHORITY_DENIED';
  if (status === 'abstain' || status === 'abstained' || status === 'unknown') return invalidReason ?? 'T03_AUTHORITY_ABSTAINED';
  if (bool(value, ['expired', 'isExpired']) === true || status === 'expired') return 'T03_AUTHORITY_EXPIRED';
  if (bool(value, ['revoked', 'isRevoked']) === true || status === 'revoked') return 'T03_AUTHORITY_REVOKED';
  if (bool(value, ['superseded', 'isSuperseded']) === true || status === 'superseded' || status === 'replaced') return 'T03_AUTHORITY_SUPERSEDED';
  if (bool(value, ['deleted', 'isDeleted']) === true || status === 'deleted' || status === 'purged') return 'T03_AUTHORITY_DELETED';
  const expiry = first(value, LOOKUP_KEYS.expiresAt);
  if (expiry !== undefined) {
    const expiryMs = timestamp(expiry);
    if (expiryMs === undefined) return 'T03_AUTHORITY_INVALID';
    if (expiryMs <= nowMs) return 'T03_AUTHORITY_EXPIRED';
  }
  const revocation = linkageState(value, 'revocation');
  const supersession = linkageState(value, 'supersession');
  const deletion = linkageState(value, 'deletion');
  if (!isActiveLinkage(revocation, 'revocation')) return 'T03_AUTHORITY_REVOKED';
  if (!isActiveLinkage(supersession, 'supersession')) return 'T03_AUTHORITY_SUPERSEDED';
  if (!isActiveLinkage(deletion, 'deletion')) return 'T03_AUTHORITY_DELETED';
  if (requiredEvidence === 'permit') {
    const decision = first(value, ['decision', 'disposition']);
    const permit = decision === 'permit' || status === 'permit' || bool(value, ['accepted', 'authorized', 'permitted']) === true;
    if (!permit) return invalid;
  }
  if (Array.isArray(requiredEvidence)) {
    if (status === undefined || !requiredEvidence.includes(status)) return invalid;
  }
  return undefined;
}

function resolveBinding(value: unknown): JsonRecord | undefined {
  return nestedCandidate(value, ['binding', 'currentBinding', 'current_binding', 'transportBinding', 'transport_binding']) ?? (isRecord(value) ? value : undefined);
}

function resolveCredential(value: unknown): JsonRecord | undefined {
  return nestedCandidate(value, ['deviceCredential', 'device_credential', 'recipientDeviceCredential', 'recipient_device_credential', 'credential', 'currentDeviceCredential', 'current_device_credential']) ?? (isRecord(value) && first(value, ['publicKey', 'public_key', 'rawPublicKey', 'raw_public_key']) !== undefined ? value : undefined);
}

function resolveLease(authority: JsonRecord, binding: JsonRecord): JsonRecord | undefined {
  return nestedCandidate(binding, ['deviceLease', 'device_lease', 'lease', 'currentDeviceLease', 'current_device_lease', 'currentLease', 'current_lease'])
    ?? nestedCandidate(authority, ['deviceLease', 'device_lease', 'lease', 'currentDeviceLease', 'current_device_lease', 'currentLease', 'current_lease'])
    ?? firstRecord(binding, ['currentDeviceLeaseRef', 'current_device_lease_ref', 'deviceLeaseRef', 'device_lease_ref', 'leaseRef', 'lease_ref'])
    ?? firstRecord(authority, ['currentDeviceLeaseRef', 'current_device_lease_ref', 'deviceLeaseRef', 'device_lease_ref', 'leaseRef', 'lease_ref']);
}

function lifecycleFailure(value: unknown, nowMs: number): T03GovernanceReason | undefined {
  if (!isRecord(value)) return undefined;
  const status = stateValue(value);
  if (bool(value, ['expired', 'isExpired']) === true || status === 'expired') return 'T03_AUTHORITY_EXPIRED';
  if (bool(value, ['revoked', 'isRevoked']) === true || status === 'revoked') return 'T03_AUTHORITY_REVOKED';
  if (bool(value, ['superseded', 'isSuperseded']) === true || status === 'superseded' || status === 'replaced') return 'T03_AUTHORITY_SUPERSEDED';
  if (bool(value, ['deleted', 'isDeleted']) === true || status === 'deleted' || status === 'purged') return 'T03_AUTHORITY_DELETED';
  const expiry = first(value, LOOKUP_KEYS.expiresAt);
  if (expiry !== undefined) {
    const expiryMs = timestamp(expiry);
    if (expiryMs === undefined) return 'T03_AUTHORITY_INVALID';
    if (expiryMs <= nowMs) return 'T03_AUTHORITY_EXPIRED';
  }
  if (!isActiveLinkage(linkageState(value, 'revocation'), 'revocation')) return 'T03_AUTHORITY_REVOKED';
  if (!isActiveLinkage(linkageState(value, 'supersession'), 'supersession')) return 'T03_AUTHORITY_SUPERSEDED';
  if (!isActiveLinkage(linkageState(value, 'deletion'), 'deletion')) return 'T03_AUTHORITY_DELETED';
  return undefined;
}

function nestedLifecycleFailure(authority: JsonRecord, binding: JsonRecord, nowMs: number): T03GovernanceReason | undefined {
  return lifecycleFailure(resolveCredential(authority), nowMs) ?? lifecycleFailure(resolveLease(authority, binding), nowMs);
}

function readAcross(values: readonly unknown[], keys: readonly string[]): unknown {
  for (const value of values) {
    const found = first(value, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

const OWNER_IDENTITY_KEYS = {
  principal: ['principal', 'principalRef', 'principal_ref'],
  subject: ['subject', 'subjectId', 'subject_id'],
  user: ['user', 'userId', 'user_id'],
  device: LOOKUP_KEYS.deviceId,
  capabilityRef: ['capabilityRef', 'capability_ref', 'capabilityGrantRef', 'capability_grant_ref'],
  scopes: ['scopes', 'capabilityScopes', 'capability_scopes', 'authorizedScopes', 'authorized_scopes'],
} as const;

function ownerRecords(value: unknown): readonly unknown[] {
  if (!isRecord(value)) return [];
  return [value, firstRecord(value, ['owner', 'ownerContext', 'owner_context', 'identity', 'subjectContext', 'subject_context'])];
}

function ownerValue(value: unknown, keys: readonly string[]): unknown {
  return readAcross(ownerRecords(value), keys);
}

function bearerPrincipalValue(principal: unknown, keys: readonly string[]): unknown {
  if (isRecord(principal)) return first(principal, keys) ?? principal;
  return principal;
}

function compareOwnerIdentity(authority: JsonRecord, binding: JsonRecord, bearer: RealtimeBearerContext): T03GovernanceReason | undefined {
  if (asNonEmpty(bearer.principal) === undefined || typeof bearer.deviceId !== 'string' || bearer.deviceId.length === 0) return 'T03_BEARER_INVALID';
  const sources: readonly [unknown, readonly string[], T03GovernanceReason][] = [
    ['principal', OWNER_IDENTITY_KEYS.principal, 'T03_BEARER_PRINCIPAL_MISMATCH'],
    ['subject', OWNER_IDENTITY_KEYS.subject, 'T03_SUBJECT_MISMATCH'],
    ['user', OWNER_IDENTITY_KEYS.user, 'T03_USER_MISMATCH'],
    ['device', OWNER_IDENTITY_KEYS.device, 'T03_BEARER_DEVICE_MISMATCH'],
  ];
  for (const [, keys, reason] of sources) {
    const authorityValue = ownerValue(authority, keys);
    const bindingValue = ownerValue(binding, keys);
    if (authorityValue !== undefined && bindingValue !== undefined && !equalValue(authorityValue, bindingValue)) return reason;
    const current = authorityValue ?? bindingValue;
    if (current === undefined) continue;
    const bearerValue = reason === 'T03_BEARER_DEVICE_MISMATCH'
      ? bearer.deviceId
      : bearerPrincipalValue(bearer.principal, keys);
    if (!equalValue(current, bearerValue)) return reason;
  }
  const authorityCapability = ownerValue(authority, OWNER_IDENTITY_KEYS.capabilityRef);
  const bindingCapability = ownerValue(binding, OWNER_IDENTITY_KEYS.capabilityRef);
  const bearerCapability = bearer.capabilityRef;
  if (authorityCapability !== undefined && bindingCapability !== undefined && !equalValue(authorityCapability, bindingCapability)) return 'T03_CAPABILITY_MISMATCH';
  if (authorityCapability !== undefined || bindingCapability !== undefined || bearerCapability !== undefined) {
    const current = authorityCapability ?? bindingCapability;
    if (current === undefined || bearerCapability === undefined || !equalValue(current, bearerCapability)) return 'T03_CAPABILITY_MISMATCH';
  }
  const authorityScopes = ownerValue(authority, OWNER_IDENTITY_KEYS.scopes);
  const bindingScopes = ownerValue(binding, OWNER_IDENTITY_KEYS.scopes);
  const bearerScopes = bearer.scopes;
  const normalizeScopes = (value: unknown): readonly string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
    return [...new Set(value)].sort();
  };
  const normalizedAuthorityScopes = normalizeScopes(authorityScopes);
  const normalizedBindingScopes = normalizeScopes(bindingScopes);
  const normalizedBearerScopes = normalizeScopes(bearerScopes);
  if ((authorityScopes !== undefined && normalizedAuthorityScopes === undefined) || (bindingScopes !== undefined && normalizedBindingScopes === undefined) || (bearerScopes !== undefined && normalizedBearerScopes === undefined)) return 'T03_CAPABILITY_MISMATCH';
  if (normalizedAuthorityScopes !== undefined && normalizedBindingScopes !== undefined && !equalValue(normalizedAuthorityScopes, normalizedBindingScopes)) return 'T03_CAPABILITY_MISMATCH';
  if (normalizedAuthorityScopes !== undefined || normalizedBindingScopes !== undefined || normalizedBearerScopes !== undefined) {
    const current = normalizedAuthorityScopes ?? normalizedBindingScopes;
    if (current === undefined || normalizedBearerScopes === undefined || !equalValue(current, normalizedBearerScopes)) return 'T03_CAPABILITY_MISMATCH';
  }
  return undefined;
}

function bearerFailure(bearer: RealtimeBearerContext, nowMs: number): T03GovernanceReason | undefined {
  if (asNonEmpty(bearer.principal) === undefined || typeof bearer.deviceId !== 'string' || bearer.deviceId.length === 0) return 'T03_BEARER_INVALID';
  if (bearer.expiresAt !== undefined) {
    const expiry = timestamp(bearer.expiresAt);
    if (expiry === undefined) return 'T03_BEARER_INVALID';
    if (expiry <= nowMs) return 'T03_BEARER_EXPIRED';
  }
  return undefined;
}

function governanceFailure(governance: JsonRecord, operation: RealtimeOperation): T03GovernanceReason | undefined {
  const required = ['purpose_scopes', 'policy_decision_refs', 'capability_grant_refs'];
  if (operation === 'realtime_e2ee_key_resolve') required.push('consent_record_refs', 'purpose_token_refs');
  for (const key of required) {
    const value = own(governance, key);
    if (!Array.isArray(value) || value.length === 0) return 'T03_GOVERNANCE_INVALID';
  }
  return undefined;
}

function bindingAllowedStates(operation: RealtimeOperation, request: JsonRecord): readonly string[] {
  const common = ['active', 'connected', 'bound'];
  if (operation === 'bootstrap' && request.bootstrap_mode === 'fully_disconnected') return [...common, 'disconnected'];
  if (operation === 'media_stop') return [...common, 'disconnected'];
  if (operation === 'end_continuity') return [...common, 'disconnected', 'released'];
  if (operation === 'handoff') return ['connected'];
  return common;
}

function hasAny(value: JsonRecord, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(value, key));
}

function requestShapeFailure(operation: RealtimeOperation, request: JsonRecord): T03GovernanceReason | undefined {
  if (operation !== 'bootstrap') return undefined;
  if (request.bootstrap_mode !== 'initial' && request.bootstrap_mode !== 'fully_disconnected') return 'T03_REQUEST_INVALID';
  const boundKeys = [
    ...LOOKUP_KEYS.session,
    ...LOOKUP_KEYS.lease,
    ...LOOKUP_KEYS.currentLease,
    ...LOOKUP_KEYS.continuity,
    ...LOOKUP_KEYS.epoch,
    ...LOOKUP_KEYS.aliases,
  ];
  if (request.bootstrap_mode === 'initial' && hasAny(request, boundKeys)) return 'T03_BINDING_MISMATCH';
  if (request.bootstrap_mode === 'fully_disconnected') {
    const continuity = first(request, LOOKUP_KEYS.continuity);
    const aliases = first(request, LOOKUP_KEYS.aliases);
    if (continuity === undefined || aliases === undefined || !Array.isArray(aliases) || aliases.length === 0) return 'T03_BINDING_MISMATCH';
  }
  return undefined;
}

function requestDevice(request: JsonRecord, operation?: RealtimeOperation): unknown {
  if (operation === 'handoff') return first(request, ['from_device_id', 'fromDeviceId']);
  return first(request, LOOKUP_KEYS.deviceId) ?? firstRecord(request, ['start'])?.device_id;
}

function requiredRequestKeys(operation: RealtimeOperation, request: JsonRecord): readonly (keyof typeof LOOKUP_KEYS)[] {
  if (operation === 'bootstrap') return request.bootstrap_mode === 'fully_disconnected' ? ['deviceId', 'continuity', 'aliases'] : ['deviceId'];
  if (operation === 'connected_credential_refresh') return ['session', 'lease', 'continuity'];
  if (operation === 'media_stop') return ['session', 'lease', 'continuity'];
  if (operation === 'end_continuity') return ['session', 'continuity'];
  if (operation === 'handoff') return ['session', 'lease', 'continuity', 'epoch', 'deviceId'];
  return ['session', 'lease', 'continuity', 'deviceId', 'audience', 'deviceCredentialRef'];
}

function compareBinding(operation: RealtimeOperation, request: JsonRecord, bearer: RealtimeBearerContext, authority: JsonRecord, binding: JsonRecord): T03GovernanceReason | undefined {
  const credential = resolveCredential(authority);
  const leaseKeys = operation === 'handoff'
    ? [...LOOKUP_KEYS.currentLease, ...LOOKUP_KEYS.lease]
    : LOOKUP_KEYS.lease;
  const requestValues: Record<string, unknown> = {
    deviceId: requestDevice(request, operation),
    session: first(request, LOOKUP_KEYS.session),
    lease: operation === 'handoff' ? first(request, LOOKUP_KEYS.currentLease) : first(request, LOOKUP_KEYS.lease),
    continuity: first(request, LOOKUP_KEYS.continuity),
    epoch: first(request, LOOKUP_KEYS.epoch),
    aliases: first(request, LOOKUP_KEYS.aliases),
    audience: first(request, LOOKUP_KEYS.audience),
    deviceCredentialRef: first(request, LOOKUP_KEYS.deviceCredentialRef),
  };
  const bindingValues: Record<string, unknown> = {
    deviceId: readAcross([binding, authority, credential], LOOKUP_KEYS.deviceId),
    session: readAcross([binding, authority, credential], LOOKUP_KEYS.session),
    lease: readAcross([binding, authority, credential], leaseKeys),
    continuity: readAcross([binding, authority, credential], LOOKUP_KEYS.continuity),
    epoch: readAcross([binding, authority], LOOKUP_KEYS.epoch),
    aliases: readAcross([binding, authority], LOOKUP_KEYS.aliases),
    audience: readAcross([credential, authority, binding], LOOKUP_KEYS.audience),
    deviceCredentialRef: readAcross([credential, authority], LOOKUP_KEYS.deviceCredentialRef),
  };
  const credentialValues: Record<string, unknown> = {
    deviceId: readAcross([credential], LOOKUP_KEYS.deviceId),
    session: readAcross([credential], LOOKUP_KEYS.session),
    lease: readAcross([credential], LOOKUP_KEYS.lease),
    continuity: readAcross([credential], LOOKUP_KEYS.continuity),
    audience: readAcross([credential], LOOKUP_KEYS.audience),
    deviceCredentialRef: readAcross([credential], LOOKUP_KEYS.deviceCredentialRef),
  };
  const bearerDevice = bearer.deviceId;
  if (typeof bearerDevice !== 'string' || bearerDevice.length === 0) return 'T03_BEARER_INVALID';
  if (bindingValues.deviceId !== undefined && !equalValue(bearerDevice, bindingValues.deviceId)) return 'T03_BEARER_DEVICE_MISMATCH';
  if (requestValues.deviceId !== undefined && !equalValue(requestValues.deviceId, bearerDevice)) return 'T03_BEARER_DEVICE_MISMATCH';
  if (requestValues.deviceId !== undefined && bindingValues.deviceId !== undefined && !equalValue(requestValues.deviceId, bindingValues.deviceId)) return 'T03_LINKAGE_MISMATCH';
  if (operation === 'realtime_e2ee_key_resolve') {
    for (const key of ['deviceId', 'session', 'lease', 'continuity', 'audience', 'deviceCredentialRef'] as const) {
      const credentialValue = credentialValues[key];
      const bindingValue = bindingValues[key];
      if (credentialValue !== undefined && bindingValue !== undefined && !equalValue(credentialValue, bindingValue)) {
        return key === 'deviceId' ? 'T03_BEARER_DEVICE_MISMATCH' : key === 'audience' ? 'T03_AUDIENCE_MISMATCH' : 'T03_LINKAGE_MISMATCH';
      }
    }
  }
  for (const key of requiredRequestKeys(operation, request)) {
    const requestValue = requestValues[key];
    if (requestValue === undefined || requestValue === null) return key === 'audience' ? 'T03_AUDIENCE_MISMATCH' : key === 'deviceCredentialRef' ? 'T03_LINKAGE_MISMATCH' : 'T03_BINDING_MISMATCH';
    if (bindingValues[key] === undefined || bindingValues[key] === null) return key === 'audience' ? 'T03_AUDIENCE_MISMATCH' : 'T03_BINDING_MISMATCH';
    if (!equalValue(requestValue, bindingValues[key])) return key === 'audience' ? 'T03_AUDIENCE_MISMATCH' : key === 'deviceCredentialRef' ? 'T03_LINKAGE_MISMATCH' : 'T03_BINDING_MISMATCH';
  }
  if (operation === 'bootstrap' && request.bootstrap_mode === 'fully_disconnected') {
    for (const key of ['deviceId', 'session', 'lease', 'continuity', 'epoch', 'aliases'] as const) {
      if (bindingValues[key] === undefined || bindingValues[key] === null) return 'T03_BINDING_MISMATCH';
    }
  }
  for (const key of ['session', 'lease', 'continuity', 'epoch', 'aliases'] as const) {
    const requestValue = requestValues[key];
    const bindingValue = bindingValues[key];
    if (requestValue !== undefined && bindingValue !== undefined && !equalValue(requestValue, bindingValue)) return 'T03_BINDING_MISMATCH';
  }
  if (operation === 'realtime_e2ee_key_resolve') {
    const credentialRef = bindingValues.deviceCredentialRef;
    if (credentialRef === undefined || !equalValue(requestValues.deviceCredentialRef, credentialRef)) return 'T03_LINKAGE_MISMATCH';
    if (bindingValues.audience === undefined || !equalValue(requestValues.audience, bindingValues.audience)) return 'T03_AUDIENCE_MISMATCH';
  }
  return undefined;
}

function credentialLinkage(projection: T03RecipientX25519PublicKeyProjection, request: JsonRecord, binding: JsonRecord, authority: JsonRecord, nowMs: number): T03GovernanceReason | undefined {
  const expiry = timestamp(projection.expiresAt);
  if (expiry === undefined || expiry <= nowMs) return 'T03_AUTHORITY_EXPIRED';
  const credential = resolveCredential(authority);
  const currentRef = readAcross([credential, authority], LOOKUP_KEYS.deviceCredentialRef);
  if (currentRef !== undefined && !equalValue(currentRef, projection.deviceCredentialRef)) return 'T03_LINKAGE_MISMATCH';
  const pairs: readonly [unknown, unknown, T03GovernanceReason][] = [
    [projection.deviceId, readAcross([binding, authority], LOOKUP_KEYS.deviceId), 'T03_BEARER_DEVICE_MISMATCH'],
    [projection.realtimeSessionRef, readAcross([binding, authority], LOOKUP_KEYS.session), 'T03_LINKAGE_MISMATCH'],
    [projection.deviceLeaseRef, readAcross([binding, authority], LOOKUP_KEYS.lease), 'T03_LINKAGE_MISMATCH'],
    [projection.continuityId, readAcross([binding, authority], LOOKUP_KEYS.continuity), 'T03_LINKAGE_MISMATCH'],
  ];
  for (const [left, right, reason] of pairs) if (right !== undefined && !equalValue(left, right)) return reason;
  const requestDeviceValue = requestDevice(request);
  if (requestDeviceValue !== undefined && !equalValue(projection.deviceId, requestDeviceValue)) return 'T03_BEARER_DEVICE_MISMATCH';
  if (first(request, LOOKUP_KEYS.audience) !== undefined && !equalValue(projection.audience, first(request, LOOKUP_KEYS.audience))) return 'T03_AUDIENCE_MISMATCH';
  if (first(request, LOOKUP_KEYS.deviceCredentialRef) !== undefined && !equalValue(projection.deviceCredentialRef, first(request, LOOKUP_KEYS.deviceCredentialRef))) return 'T03_LINKAGE_MISMATCH';
  return undefined;
}

function rejected(reason: T03GovernanceReason): RealtimeGovernanceDecision {
  return Object.freeze({ accepted: false, reason });
}

function accepted(governance: JsonRecord): RealtimeGovernanceDecision {
  const refs = cloneAndFreeze(governance) as JsonRecord;
  return Object.freeze({ accepted: true, refs });
}

export class T03GovernanceDeviceCredentialRuntime implements RealtimeGovernancePort {
  readonly #authority: T03AuthoritySnapshotPort | undefined;
  readonly #binding: T03RealtimeBindingPort | undefined;
  readonly #recipient: T03RecipientX25519PublicKeyPort | undefined;
  readonly #clock: () => number | string | Date;

  constructor(options: T03GovernanceDeviceCredentialRuntimeOptions) {
    this.#authority = options.authority ?? options.authoritySnapshot;
    this.#binding = options.binding ?? options.realtimeBinding;
    this.#recipient = options.recipientPublicKey ?? options.recipientX25519PublicKey;
    this.#clock = options.clock ?? options.now ?? (() => Date.now());
  }

  async evaluate(input: { readonly operation: RealtimeOperation; readonly request: JsonRecord; readonly bearer: RealtimeBearerContext }): Promise<RealtimeGovernanceDecision> {
    if (!isRecord(input)) return rejected('T03_REQUEST_INVALID');
    if (!OPERATIONS.has(input.operation)) return rejected('T03_OPERATION_UNSUPPORTED');
    if (!isRecord(input?.request)) return rejected('T03_REQUEST_INVALID');
    if (!isRecord(input.bearer)) return rejected('T03_BEARER_INVALID');
    const governance = input.request.governance;
    if (!isRecord(governance)) return rejected('T03_GOVERNANCE_MISSING');
    const governanceState = governanceFailure(governance, input.operation);
    if (governanceState !== undefined) return rejected(governanceState);
    let clockValue: { readonly text: string; readonly millis: number } | undefined;
    try {
      clockValue = atSystemTime(this.#clock);
    } catch {
      return rejected('T03_CLOCK_INVALID');
    }
    if (clockValue === undefined) return rejected('T03_CLOCK_INVALID');
    const bearerState = bearerFailure(input.bearer, clockValue.millis);
    if (bearerState !== undefined) return rejected(bearerState);
    const requestState = requestShapeFailure(input.operation, input.request);
    if (requestState !== undefined) return rejected(requestState);
    if (this.#authority === undefined) return rejected('T03_AUTHORITY_MISSING');
    let authorityValue: unknown;
    try {
      authorityValue = await this.#authority.resolve({ operation: input.operation, request: input.request, bearer: input.bearer, atSystemTime: clockValue.text });
    } catch {
      return rejected('T03_AUTHORITY_UNAVAILABLE');
    }
    const authorityState = classify(authorityValue, 'T03_AUTHORITY_MISSING', 'T03_AUTHORITY_UNAVAILABLE', clockValue.millis, 'permit');
    if (authorityState !== undefined) return rejected(authorityState);
    const authority = authorityValue as JsonRecord;
    const initialBootstrap = input.operation === 'bootstrap' && input.request.bootstrap_mode === 'initial';
    let binding: JsonRecord;
    if (initialBootstrap) {
      binding = authority;
    } else {
      if (this.#binding === undefined) return rejected('T03_BINDING_MISSING');
      let bindingValue: unknown;
      try {
        bindingValue = await this.#binding.resolve({ operation: input.operation, request: input.request, bearer: input.bearer, atSystemTime: clockValue.text });
      } catch {
        return rejected('T03_BINDING_UNAVAILABLE');
      }
      const bindingEnvelopeState = classify(bindingValue, 'T03_BINDING_MISSING', 'T03_BINDING_UNAVAILABLE', clockValue.millis, undefined, 'T03_BINDING_INVALID');
      if (bindingEnvelopeState !== undefined) return rejected(bindingEnvelopeState);
      const bindingState = classify(resolveBinding(bindingValue), 'T03_BINDING_MISSING', 'T03_BINDING_UNAVAILABLE', clockValue.millis, bindingAllowedStates(input.operation, input.request), 'T03_BINDING_INVALID');
      if (bindingState !== undefined) return rejected(bindingState === 'T03_AUTHORITY_DENIED' ? 'T03_BINDING_UNAVAILABLE' : bindingState);
      const resolvedBinding = resolveBinding(bindingValue);
      if (resolvedBinding === undefined) return rejected('T03_BINDING_UNAVAILABLE');
      binding = resolvedBinding;
    }
    const nestedState = nestedLifecycleFailure(authority, binding, clockValue.millis);
    if (nestedState !== undefined) return rejected(nestedState);
    const ownerState = compareOwnerIdentity(authority, binding, input.bearer);
    if (ownerState !== undefined) return rejected(ownerState);
    const mismatch = compareBinding(input.operation, input.request, input.bearer, authority, binding);
    if (mismatch !== undefined) return rejected(mismatch);
    if (input.operation === 'realtime_e2ee_key_resolve') {
      if (this.#recipient === undefined) return rejected('T03_RECIPIENT_MISSING');
      const requestedRef = first(input.request, LOOKUP_KEYS.deviceCredentialRef);
      let recipientValue: unknown;
      try {
        recipientValue = await this.#recipient.resolve({ operation: input.operation, request: input.request, bearer: input.bearer, atSystemTime: clockValue.text, deviceCredentialRef: requestedRef });
      } catch {
        return rejected('T03_RECIPIENT_UNAVAILABLE');
      }
      if (recipientValue === undefined || recipientValue === null) return rejected('T03_RECIPIENT_MISSING');
      let projection: T03RecipientX25519PublicKeyProjection;
      try {
        projection = projectT03RecipientX25519PublicKey(recipientValue);
      } catch {
        return rejected('T03_RECIPIENT_INVALID');
      }
      const credentialFailure = credentialLinkage(projection, input.request, binding, authority, clockValue.millis);
      if (credentialFailure !== undefined) return rejected(credentialFailure);
    }
    try {
      return accepted(governance);
    } catch {
      return rejected('T03_GOVERNANCE_MISSING');
    }
  }
}

export function createT03GovernanceDeviceCredentialRuntime(options: T03GovernanceDeviceCredentialRuntimeOptions): T03GovernanceDeviceCredentialRuntime {
  return new T03GovernanceDeviceCredentialRuntime(options);
}
