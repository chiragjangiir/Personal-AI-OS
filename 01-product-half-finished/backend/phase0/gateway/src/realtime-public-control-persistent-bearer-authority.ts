import { GATEWAY_CONFIG_ROOT } from './gateway-runtime-paths.ts';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

import type { RealtimeOperation } from './realtime-public-control-runtime.ts';
import type {
  PersistentPublicBearerAuthorityPort,
  PersistentPublicBearerAuthoritySnapshot,
  PersistentPublicOwnerProtectionPort,
  PersistentPublicSecretFileReader,
} from './realtime-public-control-persistent-public-ports.ts';

export const PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA =
  'paios.realtime_public_control_bearer_authority.v1' as const;

export const PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH =
  resolve(GATEWAY_CONFIG_ROOT, 'realtime-public-control-bearer-authority.v1.json');

const MIN_RECORD_BYTES = 2;
const MAX_RECORD_BYTES = 16_384;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const OPERATIONS = new Set<RealtimeOperation>([
  'bootstrap',
  'realtime_e2ee_key_resolve',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
]);

const REQUIRED_RECORD_KEYS = Object.freeze([
  'device_id',
  'expires_at_utc',
  'grant_id',
  'issued_at_utc',
  'issuer_ref',
  'principal_ref',
  'schema',
  'scopes',
  'token_sha256',
]);

export interface PersistentPublicBearerAuthorityRecordV1 {
  readonly schema: typeof PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA;
  readonly grant_id: string;
  readonly issued_at_utc: string;
  readonly expires_at_utc: string;
  readonly token_sha256: string;
  readonly principal_ref: unknown;
  readonly device_id: string;
  readonly capability_ref?: unknown;
  readonly scopes: readonly RealtimeOperation[];
  readonly issuer_ref: unknown;
}

export interface PersistentPublicBearerAuthorityOptions {
  readonly recordPath?: string;
  readonly fileReader: PersistentPublicSecretFileReader;
  readonly ownerProtection: PersistentPublicOwnerProtectionPort;
  readonly now?: () => number;
}

export class PersistentPublicBearerAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'PersistentPublicBearerAuthorityError';
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

interface ValidatedAuthorityRecord {
  readonly tokenSha256: string;
  readonly snapshot: PersistentPublicBearerAuthoritySnapshot;
}

function fail(code: string): never {
  throw new PersistentPublicBearerAuthorityError(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactRecordKeys(value: JsonRecord): void {
  const expected = [
    ...REQUIRED_RECORD_KEYS,
    ...(Object.hasOwn(value, 'capability_ref') ? ['capability_ref'] : []),
  ].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_KEYS_INVALID');
  }
}

function canonicalTimestamp(value: unknown): { readonly value: string; readonly milliseconds: number } {
  if (typeof value !== 'string' || value.length < 20 || value.length > 35) {
    fail('PERSISTENT_BEARER_AUTHORITY_TIMESTAMP_INVALID');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('PERSISTENT_BEARER_AUTHORITY_TIMESTAMP_INVALID');
  }
  return Object.freeze({ value, milliseconds });
}

function freezeJson(value: unknown, depth = 0): unknown {
  if (depth > 16) fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 2_048 || CONTROL.test(value)) {
      fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
    return Object.freeze(value.map((item) => freezeJson(item, depth + 1)));
  }
  if (!isRecord(value)) fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 64 || Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => key.length === 0 || key.length > 128 || CONTROL.test(key))) {
    fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
  }
  const snapshot: JsonRecord = {};
  for (const key of keys) snapshot[key] = freezeJson(value[key], depth + 1);
  return Object.freeze(snapshot);
}

function opaqueReference(value: unknown): unknown {
  if (typeof value !== 'string' && !isRecord(value)) {
    fail('PERSISTENT_BEARER_AUTHORITY_REF_INVALID');
  }
  return freezeJson(value);
}

function scopes(value: unknown): readonly RealtimeOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > OPERATIONS.size) {
    fail('PERSISTENT_BEARER_AUTHORITY_SCOPES_INVALID');
  }
  const result: RealtimeOperation[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !OPERATIONS.has(item as RealtimeOperation) ||
        result.includes(item as RealtimeOperation)) {
      fail('PERSISTENT_BEARER_AUTHORITY_SCOPES_INVALID');
    }
    result.push(item as RealtimeOperation);
  }
  return Object.freeze(result);
}

function parseRecord(bytes: Buffer, now: number): ValidatedAuthorityRecord {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_RECORD_BYTES || bytes.length > MAX_RECORD_BYTES ||
      (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_BYTES_INVALID');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_UTF8_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_JSON_INVALID');
  }
  if (!isRecord(parsed)) fail('PERSISTENT_BEARER_AUTHORITY_RECORD_INVALID');
  assertExactRecordKeys(parsed);
  if (parsed.schema !== PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA ||
      typeof parsed.grant_id !== 'string' || !OPAQUE_ID.test(parsed.grant_id) ||
      typeof parsed.token_sha256 !== 'string' || !SHA256.test(parsed.token_sha256) ||
      typeof parsed.device_id !== 'string' || !DEVICE_ID.test(parsed.device_id)) {
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_INVALID');
  }
  if (!Number.isFinite(now)) fail('PERSISTENT_BEARER_AUTHORITY_CLOCK_INVALID');
  const issued = canonicalTimestamp(parsed.issued_at_utc);
  const expires = canonicalTimestamp(parsed.expires_at_utc);
  if (issued.milliseconds > now || expires.milliseconds <= now || expires.milliseconds <= issued.milliseconds) {
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_NOT_CURRENT');
  }
  const principal = opaqueReference(parsed.principal_ref);
  opaqueReference(parsed.issuer_ref);
  const capability = Object.hasOwn(parsed, 'capability_ref')
    ? opaqueReference(parsed.capability_ref)
    : undefined;
  const authorizedScopes = scopes(parsed.scopes);
  const snapshot: PersistentPublicBearerAuthoritySnapshot = Object.freeze({
    tokenSha256: parsed.token_sha256,
    principal,
    deviceId: parsed.device_id,
    ...(capability === undefined ? {} : { capabilityRef: capability }),
    expiresAt: expires.value,
    scopes: authorizedScopes,
  });
  return Object.freeze({ tokenSha256: parsed.token_sha256, snapshot });
}

function sameSha256(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function readCurrentRecord(options: PersistentPublicBearerAuthorityOptions, now: number): ValidatedAuthorityRecord {
  try {
    const facts = options.fileReader.inspect(options.recordPath ?? PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH);
    if (facts.regular !== true || facts.reparse !== false ||
        options.ownerProtection.isOwnerProtected(options.recordPath ?? PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH) !== true) {
      fail('PERSISTENT_BEARER_AUTHORITY_RECORD_PROTECTION_INVALID');
    }
    return parseRecord(options.fileReader.read(options.recordPath ?? PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH), now);
  } catch (error) {
    if (error instanceof PersistentPublicBearerAuthorityError) throw error;
    fail('PERSISTENT_BEARER_AUTHORITY_RECORD_UNAVAILABLE');
  }
}

export function createPersistentPublicBearerAuthority(
  options: PersistentPublicBearerAuthorityOptions,
): PersistentPublicBearerAuthorityPort {
  if (typeof options?.fileReader?.inspect !== 'function' || typeof options.fileReader.read !== 'function' ||
      typeof options?.ownerProtection?.isOwnerProtected !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    fail('PERSISTENT_BEARER_AUTHORITY_OPTIONS_INVALID');
  }
  const now = options.now ?? Date.now;
  let closed = false;
  return Object.freeze({
    isReady: (): boolean => {
      if (closed) return false;
      try {
        readCurrentRecord(options, now());
        return true;
      } catch {
        return false;
      }
    },
    resolve: async (
      input: Parameters<PersistentPublicBearerAuthorityPort['resolve']>[0],
    ): Promise<PersistentPublicBearerAuthoritySnapshot | undefined> => {
      if (closed) fail('PERSISTENT_BEARER_AUTHORITY_CLOSED');
      if (input === null || typeof input !== 'object' || !SHA256.test(input.tokenSha256) ||
          !OPERATIONS.has(input.operation)) return undefined;
      const current = readCurrentRecord(options, now());
      if (!sameSha256(current.tokenSha256, input.tokenSha256) ||
          !current.snapshot.scopes.includes(input.operation)) return undefined;
      return current.snapshot;
    },
    close: () => { closed = true; },
  });
}
