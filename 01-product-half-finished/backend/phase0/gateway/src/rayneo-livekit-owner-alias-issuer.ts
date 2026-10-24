import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

import { assertCanonicalTimestamp, type CanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';

const ALIAS_KIND = 'paios.rayneo.livekit-owner-alias.v1' as const;
const OBJECT_VERSION = '1' as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const ALIAS = /^paios_livekit_alias_(?:provider|session|room|participant)_[A-Za-z0-9_-]{32}$/u;

type PlainRecord = Record<string, unknown>;

export interface RayneoLiveKitOwnerAliasIssueInput {
  readonly livekitServerUrl: string;
  readonly livekitClientUrl: string;
  /** The room value from the actual signed participant grant. */
  readonly grantRoom: string;
  /** The subject from the actual signed participant JWT. */
  readonly participantSubject: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly issuedAt: string;
  readonly tokenExpiresAt: string;
  /** SHA-256 of the signed participant JWT; the JWT body is never retained. */
  readonly participantTokenSha256: string;
}

export interface RayneoLiveKitOwnerAliases {
  readonly provider: string;
  readonly sessionAlias: string;
  readonly roomAlias: string;
  readonly participantAlias: string;
  readonly tokenExpiresAt: CanonicalTimestamp;
}

export interface RayneoLiveKitOwnerAliasReceipt {
  readonly kind: typeof ALIAS_KIND;
  readonly objectVersion: typeof OBJECT_VERSION;
  readonly aliases: RayneoLiveKitOwnerAliases;
  readonly canonicalPayloadSha256: string;
}

export interface RayneoLiveKitOwnerAliasIssuerPort {
  readonly issue: (input: RayneoLiveKitOwnerAliasIssueInput) => RayneoLiveKitOwnerAliasReceipt;
  readonly clear: () => void;
}

export interface RayneoLiveKitOwnerAliasIssuerOptions {
  /** Source/unit seam; production defaults to node crypto CSPRNG. */
  readonly randomBytes?: (size: number) => Buffer;
}

export class RayneoLiveKitOwnerAliasIssuerError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = 'RayneoLiveKitOwnerAliasIssuerError';
    this.code = code;
  }
}

function fail(code: string, cause?: unknown): never {
  throw new RayneoLiveKitOwnerAliasIssuerError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function closedKeys(value: unknown, expected: readonly string[], code: string): PlainRecord {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail(code);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) fail(code);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) fail(code);
  }
  return value;
}

function nonEmpty(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\u0000')) fail(code);
  return value;
}

function canonicalUrl(value: unknown, code: string): string {
  const source = nonEmpty(value, code);
  let parsed: URL;
  try { parsed = new URL(source); } catch (error) { fail(code, error); }
  if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || parsed.username !== '' ||
      parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    fail(code);
  }
  return source;
}

function timestamp(value: unknown, code: string): CanonicalTimestamp {
  try { return assertCanonicalTimestamp(value); } catch (error) { fail(code, error); }
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail('RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_CYCLE');
    ancestors.add(value);
    try { return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`; }
    finally { ancestors.delete(value); }
  }
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
    fail('RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
  }
  if (ancestors.has(value)) fail('RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_CYCLE');
  ancestors.add(value);
  try {
    return `{${Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
        fail('RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
      }
      return `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`;
    }).join(',')}}`;
  } finally { ancestors.delete(value); }
}

function normalizeInput(rawInput: RayneoLiveKitOwnerAliasIssueInput): RayneoLiveKitOwnerAliasIssueInput {
  const input = closedKeys(rawInput, [
    'clientInstanceId', 'deviceId', 'grantRoom', 'issuedAt', 'livekitClientUrl', 'livekitServerUrl',
    'participantSubject', 'participantTokenSha256', 'sessionId', 'tokenExpiresAt',
  ], 'RAYNEO_LIVEKIT_OWNER_ALIAS_INPUT_INVALID');
  const issuedAt = timestamp(input.issuedAt, 'RAYNEO_LIVEKIT_OWNER_ALIAS_TIME_INVALID');
  const tokenExpiresAt = timestamp(input.tokenExpiresAt, 'RAYNEO_LIVEKIT_OWNER_ALIAS_TIME_INVALID');
  if (Date.parse(tokenExpiresAt) <= Date.parse(issuedAt)) fail('RAYNEO_LIVEKIT_OWNER_ALIAS_TIME_INVALID');
  if (typeof input.participantTokenSha256 !== 'string' || !SHA256.test(input.participantTokenSha256)) {
    fail('RAYNEO_LIVEKIT_OWNER_ALIAS_TOKEN_HASH_INVALID');
  }
  return Object.freeze({
    livekitServerUrl: canonicalUrl(input.livekitServerUrl, 'RAYNEO_LIVEKIT_OWNER_ALIAS_PROVIDER_INVALID'),
    livekitClientUrl: canonicalUrl(input.livekitClientUrl, 'RAYNEO_LIVEKIT_OWNER_ALIAS_PROVIDER_INVALID'),
    grantRoom: nonEmpty(input.grantRoom, 'RAYNEO_LIVEKIT_OWNER_ALIAS_GRANT_INVALID'),
    participantSubject: nonEmpty(input.participantSubject, 'RAYNEO_LIVEKIT_OWNER_ALIAS_SUBJECT_INVALID'),
    sessionId: nonEmpty(input.sessionId, 'RAYNEO_LIVEKIT_OWNER_ALIAS_SESSION_INVALID'),
    deviceId: nonEmpty(input.deviceId, 'RAYNEO_LIVEKIT_OWNER_ALIAS_DEVICE_INVALID'),
    clientInstanceId: nonEmpty(input.clientInstanceId, 'RAYNEO_LIVEKIT_OWNER_ALIAS_CLIENT_INVALID'),
    issuedAt,
    tokenExpiresAt,
    participantTokenSha256: input.participantTokenSha256,
  });
}

function normalizeAliases(value: unknown): RayneoLiveKitOwnerAliases {
  const aliases = closedKeys(value, [
    'participantAlias', 'provider', 'roomAlias', 'sessionAlias', 'tokenExpiresAt',
  ], 'RAYNEO_LIVEKIT_OWNER_ALIAS_RECEIPT_INVALID');
  const provider = nonEmpty(aliases.provider, 'RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
  const sessionAlias = nonEmpty(aliases.sessionAlias, 'RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
  const roomAlias = nonEmpty(aliases.roomAlias, 'RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
  const participantAlias = nonEmpty(aliases.participantAlias, 'RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
  if (!ALIAS.test(provider) || !ALIAS.test(sessionAlias) || !ALIAS.test(roomAlias) || !ALIAS.test(participantAlias) ||
      new Set([provider, sessionAlias, roomAlias, participantAlias]).size !== 4) {
    fail('RAYNEO_LIVEKIT_OWNER_ALIAS_VALUE_INVALID');
  }
  return Object.freeze({
    provider, sessionAlias, roomAlias, participantAlias,
    tokenExpiresAt: timestamp(aliases.tokenExpiresAt, 'RAYNEO_LIVEKIT_OWNER_ALIAS_TIME_INVALID'),
  });
}

function canonicalPayloadSha256(
  input: RayneoLiveKitOwnerAliasIssueInput,
  aliases: RayneoLiveKitOwnerAliases,
): string {
  return createHash('sha256').update(canonicalJson({ input, aliases }), 'utf8').digest('hex');
}

function normalizeReceipt(value: unknown): RayneoLiveKitOwnerAliasReceipt {
  const receipt = closedKeys(value, ['aliases', 'canonicalPayloadSha256', 'kind', 'objectVersion'],
    'RAYNEO_LIVEKIT_OWNER_ALIAS_RECEIPT_INVALID');
  if (receipt.kind !== ALIAS_KIND || receipt.objectVersion !== OBJECT_VERSION ||
      typeof receipt.canonicalPayloadSha256 !== 'string' || !SHA256.test(receipt.canonicalPayloadSha256)) {
    fail('RAYNEO_LIVEKIT_OWNER_ALIAS_RECEIPT_INVALID');
  }
  return Object.freeze({
    kind: ALIAS_KIND,
    objectVersion: OBJECT_VERSION,
    aliases: normalizeAliases(receipt.aliases),
    canonicalPayloadSha256: receipt.canonicalPayloadSha256,
  });
}

export function assertRayneoLiveKitOwnerAliasReceipt(
  receipt: RayneoLiveKitOwnerAliasReceipt,
  rawInput: RayneoLiveKitOwnerAliasIssueInput,
): RayneoLiveKitOwnerAliasReceipt {
  const input = normalizeInput(rawInput);
  const normalized = normalizeReceipt(receipt);
  if (normalized.aliases.tokenExpiresAt !== input.tokenExpiresAt ||
      normalized.canonicalPayloadSha256 !== canonicalPayloadSha256(input, normalized.aliases)) {
    fail('RAYNEO_LIVEKIT_OWNER_ALIAS_RECEIPT_HASH_INVALID');
  }
  return normalized;
}

export function createProductionRayneoLiveKitOwnerAliasIssuer(
  options: RayneoLiveKitOwnerAliasIssuerOptions = {},
): RayneoLiveKitOwnerAliasIssuerPort {
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  let activeFingerprint: string | undefined;
  let activeReceipt: RayneoLiveKitOwnerAliasReceipt | undefined;
  let closed = false;

  const issue = (rawInput: RayneoLiveKitOwnerAliasIssueInput): RayneoLiveKitOwnerAliasReceipt => {
    if (closed) fail('RAYNEO_LIVEKIT_OWNER_ALIAS_ISSUER_CLOSED');
    const input = normalizeInput(rawInput);
    const fingerprint = createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
    if (activeReceipt !== undefined || activeFingerprint !== undefined) {
      if (activeFingerprint === fingerprint && activeReceipt !== undefined) return activeReceipt;
      fail('RAYNEO_LIVEKIT_OWNER_ALIAS_ISSUANCE_DRIFT');
    }
    let entropy: Buffer;
    try { entropy = randomBytes(96); } catch (error) { fail('RAYNEO_LIVEKIT_OWNER_ALIAS_ENTROPY_FAILED', error); }
    if (!Buffer.isBuffer(entropy) || entropy.byteLength !== 96) fail('RAYNEO_LIVEKIT_OWNER_ALIAS_ENTROPY_INVALID');
    const aliases: RayneoLiveKitOwnerAliases = Object.freeze({
      provider: `paios_livekit_alias_provider_${entropy.subarray(0, 24).toString('base64url')}`,
      sessionAlias: `paios_livekit_alias_session_${entropy.subarray(24, 48).toString('base64url')}`,
      roomAlias: `paios_livekit_alias_room_${entropy.subarray(48, 72).toString('base64url')}`,
      participantAlias: `paios_livekit_alias_participant_${entropy.subarray(72, 96).toString('base64url')}`,
      tokenExpiresAt: assertCanonicalTimestamp(input.tokenExpiresAt),
    });
    entropy.fill(0);
    const receipt: RayneoLiveKitOwnerAliasReceipt = Object.freeze({
      kind: ALIAS_KIND,
      objectVersion: OBJECT_VERSION,
      aliases,
      canonicalPayloadSha256: canonicalPayloadSha256(input, aliases),
    });
    activeFingerprint = fingerprint;
    activeReceipt = assertRayneoLiveKitOwnerAliasReceipt(receipt, input);
    return activeReceipt;
  };

  const clear = (): void => {
    closed = true;
    activeFingerprint = undefined;
    activeReceipt = undefined;
  };

  return Object.freeze({ issue, clear });
}
