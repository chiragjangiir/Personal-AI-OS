import { GATEWAY_DATA_ROOT } from './gateway-runtime-paths.ts';
import { resolve } from 'node:path';
/**
 * Gateway-owned adapter for the Runtime029 demo owner.
 *
 * This module does not mint a realtime identity, persist a session, derive a
 * LiveKit alias, or derive identity from process state. It combines the protected, stable local
 * policy with the exact live bootstrap projection supplied by the signed
 * RayNeo/LiveKit owner. T02 then receives the resulting owner projection and
 * is the only authority that issues canonical realtime references.
 */

import {
  assertCanonicalTimestamp,
  snapshotOpaqueOwnerValue,
  type OpaqueGovernanceValue,
  type OpaqueOwnerValue,
} from '../../../services/realtime-core/src/types.ts';
import type {
  RayneoDemoCurrentBindingInput as T02RayneoDemoCurrentBindingInput,
  RayneoDemoOwnerProjection as T02RayneoDemoOwnerProjection,
  RayneoDemoOwnerStableProjection as T02RayneoDemoOwnerStableProjection,
  RayneoDemoOwnerIdentityPort as T02RayneoDemoOwnerIdentityPort,
  RayneoDemoLeasePolicyForOwner as T02RayneoDemoLeasePolicyForOwner,
} from '../../../services/platform-data/src/rayneo-demo-current-binding-postgres.ts';
import type { LeasePolicyDecision, LeasePolicyPort } from '../../../services/realtime-core/src/ports.ts';
import type { Phase0EligibleSession } from './phase0-demo-session-controller.ts';
import { Phase0SharedSessionOwner } from './phase0-shared-session-owner.ts';

export const RAYNEO_LOCAL_OWNER_POLICY_PATH =
  resolve(GATEWAY_DATA_ROOT, 'resources/local-owner.v1.json');

const POLICY_SCHEMA = 'paios.windows.local-owner.v1' as const;
const POLICY_PURPOSE = 'public_product_canary' as const;
const OWNER_FORBIDDEN_PATTERN = /(^|[-_.])test($|[-_.])/iu;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]{0,37})$/u;
const OWNER_GOVERNANCE_KEYS = Object.freeze([
  'purpose_scopes', 'policy_decision_refs', 'capability_grant_refs',
] as const);

type PlainRecord = Record<string, unknown>;

/** The exact T02 request shape, re-exported for Gateway callers. */
export type RayneoDemoCurrentBindingInput = T02RayneoDemoCurrentBindingInput;
/** The exact owner projection accepted by T02's current-binding provider. */
export type RayneoDemoOwnerStableProjection = T02RayneoDemoOwnerStableProjection;
export type RayneoDemoOwnerProjection = T02RayneoDemoOwnerProjection;
export type RayneoDemoOwnerIdentityPort = T02RayneoDemoOwnerIdentityPort;
export type RayneoDemoLeasePolicyForOwner = T02RayneoDemoLeasePolicyForOwner;

export interface RayneoLocalOwnerPolicy {
  readonly schema: typeof POLICY_SCHEMA;
  readonly userId: string;
  readonly purpose: typeof POLICY_PURPOSE;
  readonly policyDecisionRef: OpaqueGovernanceValue;
  readonly governance: OpaqueGovernanceValue;
  readonly requestedCapabilities: readonly string[];
  readonly revocable: true;
}

/** Existing product policy contract; legacy installations need not use canonical store encoding. */
export function parseConfiguredOwnerPolicy(value: unknown): RayneoLocalOwnerPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('PERSISTENT_OWNER_POLICY_INVALID');
  const policy = value as Partial<RayneoLocalOwnerPolicy>;
  if (policy.schema !== POLICY_SCHEMA || policy.purpose !== POLICY_PURPOSE ||
      policy.revocable !== true || typeof policy.userId !== 'string' || policy.userId.length === 0) {
    fail('PERSISTENT_OWNER_POLICY_INVALID');
  }
  return Object.freeze(value as RayneoLocalOwnerPolicy);
}

/** Read-only production policy surface used by the owner identity adapter. */
export interface RayneoLocalOwnerPolicyReader {
  readonly path: typeof RAYNEO_LOCAL_OWNER_POLICY_PATH;
  readonly owner: string;
  readonly environment: 'production';
  readonly isReady: () => boolean;
  readonly read: () => RayneoLocalOwnerPolicy | undefined;
}

/**
 * The concrete Windows implementation owns ACL, regular-file, reparse,
 * flush, and atomic CREATE_NEW details. The source adapter only accepts this
 * narrow port and never writes a second path.
 */
export interface RayneoLocalOwnerPolicyFilePort {
  readonly path: typeof RAYNEO_LOCAL_OWNER_POLICY_PATH;
  readonly exists: () => boolean;
  readonly read: () => Buffer;
  readonly verifyProtectedAcl: () => void;
  readonly createNewFlushedProtected: (bytes: Buffer) => void;
}

export interface RayneoLocalOwnerPolicyStore extends RayneoLocalOwnerPolicyReader {
  /** Create once; an existing policy is read back and is never overwritten. */
  readonly createOnce: (policy: RayneoLocalOwnerPolicy) => RayneoLocalOwnerPolicy;
}

/** Closed lookup passed from the signed debug-public owner. */
export type RayneoDemoBindingLookup = RayneoDemoCurrentBindingInput;

export interface RayneoDemoLiveKitAliases {
  readonly provider: OpaqueOwnerValue;
  readonly sessionAlias: OpaqueOwnerValue;
  readonly roomAlias: OpaqueOwnerValue;
  readonly participantAlias: OpaqueOwnerValue;
  readonly tokenExpiresAt: string;
}

/**
 * Exact live bootstrap output. The Phase-0 transport `deviceId` remains raw;
 * T02 issues the canonical device identity inside its bootstrap transaction.
 * The nested aliases are owner-issued values; no room/session/participant
 * synthesis is permitted here.
 */
export interface RayneoDemoLiveSessionOutput {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly cleanupDeadlineAt: string;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
  readonly connectionId: string;
  readonly ownerConnectionEpoch: string;
  readonly activeDeviceLeaseVersion: string | number;
  readonly livekit: RayneoDemoLiveKitAliases;
}

/** Existing signed owner/controller seam; it returns the actual live output. */
export interface RayneoDemoLiveSessionPort {
  readonly owner: string;
  readonly environment: 'production';
  readonly isReady: () => boolean;
  readonly resolve: (input: RayneoDemoBindingLookup) => Promise<RayneoDemoLiveSessionOutput | undefined>;
}

/** A convenient type for a T02 owner identity resolver. */
export interface RayneoDemoOwnerProjectionResolver extends RayneoDemoOwnerIdentityPort {}

export class RayneoDemoOwnerProjectionError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = 'RayneoDemoOwnerProjectionError';
    this.code = code;
  }
}

function fail(code: string, cause?: unknown): never {
  throw new RayneoDemoOwnerProjectionError(code, cause === undefined ? {} : { cause });
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
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) fail(code);
  }
  return value;
}

function nonEmpty(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\u0000')) fail(code);
  return value;
}

function ownerName(value: unknown, code: string): string {
  const owner = nonEmpty(value, code);
  if (OWNER_FORBIDDEN_PATTERN.test(owner)) fail('RAYNEO_DEMO_OWNER_FORBIDDEN');
  return owner;
}

function positiveDecimal(value: unknown, code: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') fail(code);
  const text = String(value);
  if (!POSITIVE_DECIMAL.test(text)) fail(code);
  return text;
}

function nonnegativeDecimal(value: unknown, code: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') fail(code);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(code);
  const text = String(value);
  if (!NONNEGATIVE_DECIMAL.test(text)) fail(code);
  return text;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('RAYNEO_DEMO_OPAQUE_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (!isPlainRecord(value) && !Array.isArray(value)) fail('RAYNEO_DEMO_OPAQUE_VALUE_INVALID');
  if (ancestors.has(value)) fail('RAYNEO_DEMO_OPAQUE_VALUE_CYCLE');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function opaque(value: unknown, code: string): OpaqueOwnerValue {
  try {
    const snapshot = snapshotOpaqueOwnerValue(value);
    canonicalJson(snapshot);
    return snapshot;
  } catch (error) {
    fail(code, error);
  }
}

function timestamp(value: unknown, code: string): string {
  try {
    return assertCanonicalTimestamp(value);
  } catch (error) {
    fail(code, error);
  }
}

function timestampOrder(start: string, end: string, code: string): void {
  if (Date.parse(end) <= Date.parse(start)) fail(code);
}

function stringList(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => typeof item !== 'string' || item.length === 0 || item !== item.trim() || item.includes('\u0000'))) {
    fail(code);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) fail(code);
  return Object.freeze([...result]);
}

function normalizePolicy(value: unknown): RayneoLocalOwnerPolicy {
  const policy = closedKeys(value, [
    'governance', 'policyDecisionRef', 'purpose', 'requestedCapabilities', 'revocable', 'schema', 'userId',
  ], 'RAYNEO_LOCAL_OWNER_POLICY_INVALID');
  if (policy.schema !== POLICY_SCHEMA || policy.purpose !== POLICY_PURPOSE || policy.revocable !== true) {
    fail('RAYNEO_LOCAL_OWNER_POLICY_INVALID');
  }
  const userId = nonEmpty(policy.userId, 'RAYNEO_LOCAL_OWNER_POLICY_USER_INVALID');
  if (!UUID_V7.test(userId)) fail('RAYNEO_LOCAL_OWNER_POLICY_USER_INVALID');
  return Object.freeze({
    schema: POLICY_SCHEMA,
    userId,
    purpose: POLICY_PURPOSE,
    policyDecisionRef: opaque(policy.policyDecisionRef, 'RAYNEO_LOCAL_OWNER_POLICY_REF_INVALID') as OpaqueGovernanceValue,
    governance: opaque(policy.governance, 'RAYNEO_LOCAL_OWNER_POLICY_GOVERNANCE_INVALID') as OpaqueGovernanceValue,
    requestedCapabilities: stringList(policy.requestedCapabilities, 'RAYNEO_LOCAL_OWNER_POLICY_CAPABILITIES_INVALID'),
    revocable: true,
  });
}

function policyBytes(policy: RayneoLocalOwnerPolicy): Buffer {
  return Buffer.from(`${canonicalJson(policy)}\n`, 'utf8');
}

function parsePolicyBytes(bytes: Buffer): RayneoLocalOwnerPolicy {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > 65_536 ||
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('RAYNEO_LOCAL_OWNER_POLICY_ENCODING_INVALID');
  }
  const text = bytes.toString('utf8');
  if (text.includes('\u0000') || text.includes('\r') || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    fail('RAYNEO_LOCAL_OWNER_POLICY_ENCODING_INVALID');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1)) as unknown;
  } catch (error) {
    fail('RAYNEO_LOCAL_OWNER_POLICY_JSON_INVALID', error);
  }
  const policy = normalizePolicy(parsed);
  if (text !== `${canonicalJson(policy)}\n`) fail('RAYNEO_LOCAL_OWNER_POLICY_CANONICAL_INVALID');
  return policy;
}

function assertPolicyReader(value: unknown): asserts value is RayneoLocalOwnerPolicyReader {
  const hasCreateOnce = isPlainRecord(value) && Object.hasOwn(value, 'createOnce');
  const reader = closedKeys(value, ['environment', 'isReady', 'owner', 'path', 'read', ...(hasCreateOnce ? ['createOnce'] : [])],
    'RAYNEO_LOCAL_OWNER_POLICY_READER_INVALID');
  ownerName(reader.owner, 'RAYNEO_LOCAL_OWNER_POLICY_OWNER_INVALID');
  if (reader.path !== RAYNEO_LOCAL_OWNER_POLICY_PATH || reader.environment !== 'production' ||
      typeof reader.isReady !== 'function' || typeof reader.read !== 'function' ||
      (hasCreateOnce && typeof reader.createOnce !== 'function')) {
    fail('RAYNEO_LOCAL_OWNER_POLICY_READER_INVALID');
  }
}

function assertFilePort(value: unknown): asserts value is RayneoLocalOwnerPolicyFilePort {
  const file = closedKeys(value, ['createNewFlushedProtected', 'exists', 'path', 'read', 'verifyProtectedAcl'],
    'RAYNEO_LOCAL_OWNER_POLICY_FILE_PORT_INVALID');
  if (file.path !== RAYNEO_LOCAL_OWNER_POLICY_PATH || typeof file.exists !== 'function' ||
      typeof file.read !== 'function' || typeof file.verifyProtectedAcl !== 'function' ||
      typeof file.createNewFlushedProtected !== 'function') {
    fail('RAYNEO_LOCAL_OWNER_POLICY_FILE_PORT_INVALID');
  }
}

export function createRayneoLocalOwnerPolicyStore(
  filePort: RayneoLocalOwnerPolicyFilePort,
  owner: string,
): RayneoLocalOwnerPolicyStore {
  assertFilePort(filePort);
  const stableOwner = ownerName(owner, 'RAYNEO_LOCAL_OWNER_POLICY_OWNER_INVALID');

  const read = (): RayneoLocalOwnerPolicy | undefined => {
    let exists = false;
    try {
      exists = filePort.exists();
    } catch (error) {
      fail('RAYNEO_LOCAL_OWNER_POLICY_FILE_UNAVAILABLE', error);
    }
    if (!exists) return undefined;
    try {
      filePort.verifyProtectedAcl();
    } catch (error) {
      fail('RAYNEO_LOCAL_OWNER_POLICY_ACL_INVALID', error);
    }
    let bytes: Buffer;
    try {
      bytes = filePort.read();
    } catch (error) {
      fail('RAYNEO_LOCAL_OWNER_POLICY_FILE_UNAVAILABLE', error);
    }
    return parsePolicyBytes(bytes);
  };

  const isReady = (): boolean => {
    try {
      return read() !== undefined;
    } catch {
      return false;
    }
  };

  const createOnce = (rawPolicy: RayneoLocalOwnerPolicy): RayneoLocalOwnerPolicy => {
    const policy = normalizePolicy(rawPolicy);
    const existing = read();
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(policy)) fail('RAYNEO_LOCAL_OWNER_POLICY_COLLISION');
      return existing;
    }
    try {
      filePort.createNewFlushedProtected(policyBytes(policy));
    } catch (error) {
      const afterRace = read();
      if (afterRace !== undefined && canonicalJson(afterRace) === canonicalJson(policy)) return afterRace;
      fail('RAYNEO_LOCAL_OWNER_POLICY_CREATE_FAILED', error);
    }
    const readback = read();
    if (readback === undefined || canonicalJson(readback) !== canonicalJson(policy)) {
      fail('RAYNEO_LOCAL_OWNER_POLICY_READBACK_DRIFT');
    }
    return readback;
  };

  return Object.freeze({
    path: RAYNEO_LOCAL_OWNER_POLICY_PATH,
    owner: stableOwner,
    environment: 'production' as const,
    isReady,
    read,
    createOnce,
  });
}

function normalizeLookup(value: unknown): RayneoDemoCurrentBindingInput {
  const lookup = closedKeys(value, ['clientInstanceId', 'deviceId', 'observedAt', 'sessionId'],
    'RAYNEO_DEMO_BINDING_LOOKUP_INVALID');
  return Object.freeze({
    sessionId: nonEmpty(lookup.sessionId, 'RAYNEO_DEMO_BINDING_LOOKUP_INVALID'),
    deviceId: nonEmpty(lookup.deviceId, 'RAYNEO_DEMO_BINDING_LOOKUP_INVALID'),
    clientInstanceId: nonEmpty(lookup.clientInstanceId, 'RAYNEO_DEMO_BINDING_LOOKUP_INVALID'),
    observedAt: timestamp(lookup.observedAt, 'RAYNEO_DEMO_BINDING_LOOKUP_INVALID'),
  });
}

function normalizeAliases(value: unknown): RayneoDemoLiveKitAliases {
  const aliases = closedKeys(value, ['participantAlias', 'provider', 'roomAlias', 'sessionAlias', 'tokenExpiresAt'],
    'RAYNEO_DEMO_LIVEKIT_ALIASES_INVALID');
  const tokenExpiresAt = timestamp(aliases.tokenExpiresAt, 'RAYNEO_DEMO_LIVEKIT_EXPIRY_INVALID');
  return Object.freeze({
    provider: opaque(aliases.provider, 'RAYNEO_DEMO_LIVEKIT_PROVIDER_INVALID'),
    sessionAlias: opaque(aliases.sessionAlias, 'RAYNEO_DEMO_LIVEKIT_SESSION_ALIAS_INVALID'),
    roomAlias: opaque(aliases.roomAlias, 'RAYNEO_DEMO_LIVEKIT_ROOM_ALIAS_INVALID'),
    participantAlias: opaque(aliases.participantAlias, 'RAYNEO_DEMO_LIVEKIT_PARTICIPANT_ALIAS_INVALID'),
    tokenExpiresAt,
  });
}

interface NormalizedLive {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly eligibilityObservedAt: string;
  readonly sessionExpiresAt: string;
  readonly cleanupDeadlineAt: string;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
  readonly connectionId: string;
  readonly ownerConnectionEpoch: string;
  readonly activeDeviceLeaseVersion: string;
  readonly livekit: RayneoDemoLiveKitAliases;
}

function normalizeLive(value: unknown): NormalizedLive {
  const live = closedKeys(value, [
    'activeDeviceLeaseVersion', 'cleanupDeadlineAt', 'clientInstanceId', 'connectionId', 'continuityExpiresAt',
    'deviceId', 'expiresAt', 'leaseExpiresAt', 'livekit', 'openedAt', 'ownerConnectionEpoch', 'sessionId',
  ], 'RAYNEO_DEMO_LIVE_OUTPUT_INVALID');
  const openedAt = timestamp(live.openedAt, 'RAYNEO_DEMO_LIVE_TIME_INVALID');
  const expiresAt = timestamp(live.expiresAt, 'RAYNEO_DEMO_LIVE_TIME_INVALID');
  const cleanupDeadlineAt = timestamp(live.cleanupDeadlineAt, 'RAYNEO_DEMO_LIVE_TIME_INVALID');
  const continuityExpiresAt = timestamp(live.continuityExpiresAt, 'RAYNEO_DEMO_LIVE_TIME_INVALID');
  const leaseExpiresAt = timestamp(live.leaseExpiresAt, 'RAYNEO_DEMO_LIVE_TIME_INVALID');
  timestampOrder(openedAt, expiresAt, 'RAYNEO_DEMO_LIVE_EXPIRY_INVALID');
  timestampOrder(expiresAt, cleanupDeadlineAt, 'RAYNEO_DEMO_LIVE_CLEANUP_EXPIRY_INVALID');
  if (continuityExpiresAt !== expiresAt) fail('RAYNEO_DEMO_LIVE_CONTINUITY_EXPIRY_DRIFT');
  if (Date.parse(leaseExpiresAt) <= Date.parse(openedAt)) fail('RAYNEO_DEMO_LIVE_LEASE_EXPIRY_INVALID');
  const livekit = normalizeAliases(live.livekit);
  timestampOrder(openedAt, livekit.tokenExpiresAt, 'RAYNEO_DEMO_LIVE_TOKEN_EXPIRY_INVALID');
  return Object.freeze({
    sessionId: nonEmpty(live.sessionId, 'RAYNEO_DEMO_LIVE_SESSION_INVALID'),
    deviceId: nonEmpty(live.deviceId, 'RAYNEO_DEMO_LIVE_DEVICE_INVALID'),
    clientInstanceId: nonEmpty(live.clientInstanceId, 'RAYNEO_DEMO_LIVE_CLIENT_INVALID'),
    eligibilityObservedAt: openedAt,
    sessionExpiresAt: expiresAt,
    cleanupDeadlineAt,
    continuityExpiresAt,
    leaseExpiresAt,
    connectionId: nonEmpty(live.connectionId, 'RAYNEO_DEMO_LIVE_CONNECTION_INVALID'),
    ownerConnectionEpoch: nonnegativeDecimal(live.ownerConnectionEpoch, 'RAYNEO_DEMO_LIVE_EPOCH_INVALID'),
    activeDeviceLeaseVersion: positiveDecimal(live.activeDeviceLeaseVersion, 'RAYNEO_DEMO_LIVE_LEASE_VERSION_INVALID'),
    livekit,
  });
}

function assertPolicy(value: RayneoLocalOwnerPolicy): RayneoLocalOwnerPolicy {
  return normalizePolicy(value);
}

function assertReady(value: unknown, code: string): void {
  try {
    if (!isPlainRecord(value) || typeof value.isReady !== 'function' || value.isReady() !== true) fail(code);
  } catch (error) {
    if (error instanceof RayneoDemoOwnerProjectionError) throw error;
    fail(code, error);
  }
}

function assertLivePort(value: unknown): asserts value is RayneoDemoLiveSessionPort {
  const port = closedKeys(value, ['environment', 'isReady', 'owner', 'resolve'], 'RAYNEO_DEMO_LIVE_SESSION_PORT_INVALID');
  ownerName(port.owner, 'RAYNEO_DEMO_LIVE_SESSION_OWNER_INVALID');
  if (port.environment !== 'production' || typeof port.isReady !== 'function' || typeof port.resolve !== 'function') {
    fail('RAYNEO_DEMO_LIVE_SESSION_PORT_INVALID');
  }
}

function assertOwner(value: unknown): asserts value is Phase0SharedSessionOwner {
  if (!(value instanceof Phase0SharedSessionOwner) || typeof value.sessions?.eligibleRayneoSessions !== 'function') {
    fail('RAYNEO_DEMO_OWNER_INVALID');
  }
}

function readEligible(
  owner: Phase0SharedSessionOwner,
  lookup: RayneoDemoCurrentBindingInput,
): Phase0EligibleSession | undefined {
  let values: readonly Phase0EligibleSession[];
  try {
    values = owner.sessions.eligibleRayneoSessions(lookup.deviceId, lookup.clientInstanceId);
  } catch (error) {
    fail('RAYNEO_DEMO_OWNER_ELIGIBILITY_FAILED', error);
  }
  if (!Array.isArray(values)) fail('RAYNEO_DEMO_OWNER_ELIGIBILITY_INVALID');
  if (values.length > 1) fail('RAYNEO_DEMO_OWNER_ELIGIBILITY_AMBIGUOUS');
  const selected = values[0];
  if (selected === undefined || selected.sessionId !== lookup.sessionId || selected.deviceId !== lookup.deviceId ||
      selected.clientInstanceId !== lookup.clientInstanceId) return undefined;
  const ownerEpoch = nonnegativeDecimal(selected.connectionEpoch, 'RAYNEO_DEMO_OWNER_EPOCH_INVALID');
  const ownerLeaseVersion = positiveDecimal(selected.activeDeviceLeaseVersion, 'RAYNEO_DEMO_OWNER_LEASE_VERSION_INVALID');
  void ownerEpoch;
  void ownerLeaseVersion;
  return selected;
}

function assertLiveEligibility(selected: Phase0EligibleSession, live: NormalizedLive): void {
  if (selected.sessionId !== live.sessionId || selected.deviceId !== live.deviceId ||
      selected.clientInstanceId !== live.clientInstanceId) fail('RAYNEO_DEMO_OWNER_LIVE_ID_DRIFT');
  if (nonnegativeDecimal(selected.connectionEpoch, 'RAYNEO_DEMO_OWNER_EPOCH_INVALID') !== live.ownerConnectionEpoch) {
    fail('RAYNEO_DEMO_OWNER_EPOCH_DRIFT');
  }
  if (positiveDecimal(selected.activeDeviceLeaseVersion, 'RAYNEO_DEMO_OWNER_LEASE_VERSION_INVALID') !== live.activeDeviceLeaseVersion) {
    fail('RAYNEO_DEMO_OWNER_LEASE_VERSION_DRIFT');
  }
  const expiresAt = new Date(selected.expiresAtMs).toISOString();
  const cleanupDeadlineAt = new Date(selected.cleanupDeadlineAtMs).toISOString();
  if (expiresAt !== live.sessionExpiresAt || cleanupDeadlineAt !== live.cleanupDeadlineAt) {
    fail('RAYNEO_DEMO_OWNER_EXPIRY_DRIFT');
  }
  if (selected.connectionId !== live.connectionId) fail('RAYNEO_DEMO_OWNER_CONNECTION_DRIFT');
}

function stableProjection(
  policy: RayneoLocalOwnerPolicy,
  live: NormalizedLive,
  ownerLeaseVersion: string,
  observedAt: string,
): RayneoDemoOwnerProjection {
  const stable: RayneoDemoOwnerStableProjection = Object.freeze({
    sessionId: live.sessionId,
    deviceId: live.deviceId,
    clientInstanceId: live.clientInstanceId,
    userId: policy.userId,
    purpose: policy.purpose,
    governance: policy.governance,
    requestedCapabilities: policy.requestedCapabilities,
    eligibilityObservedAt: live.eligibilityObservedAt,
    sessionExpiresAt: live.sessionExpiresAt,
    cleanupDeadlineAt: live.cleanupDeadlineAt,
    leaseExpiresAt: live.leaseExpiresAt,
    connectionId: live.connectionId,
    ownerConnectionEpoch: live.ownerConnectionEpoch,
    activeDeviceLeaseVersion: ownerLeaseVersion,
    providerAlias: nonEmpty(live.livekit.provider, 'RAYNEO_DEMO_LIVEKIT_PROVIDER_INVALID'),
    livekitSessionAlias: nonEmpty(live.livekit.sessionAlias, 'RAYNEO_DEMO_LIVEKIT_SESSION_ALIAS_INVALID'),
    livekitRoomAlias: nonEmpty(live.livekit.roomAlias, 'RAYNEO_DEMO_LIVEKIT_ROOM_ALIAS_INVALID'),
    livekitParticipantAlias: nonEmpty(live.livekit.participantAlias, 'RAYNEO_DEMO_LIVEKIT_PARTICIPANT_ALIAS_INVALID'),
  });
  return Object.freeze({
    stable,
    resolution: Object.freeze({ observedAt }),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function lookupEqual(left: RayneoDemoCurrentBindingInput, right: RayneoDemoCurrentBindingInput): boolean {
  return left.sessionId === right.sessionId && left.deviceId === right.deviceId &&
    left.clientInstanceId === right.clientInstanceId;
}

function assertProjectionStable(
  projection: RayneoDemoOwnerProjection,
  policy: RayneoLocalOwnerPolicy,
  live: NormalizedLive,
  lookup: RayneoDemoCurrentBindingInput,
): RayneoDemoOwnerProjection {
  const root = closedKeys(projection, ['resolution', 'stable'], 'RAYNEO_DEMO_OWNER_PROJECTION_INVALID');
  const stable = closedKeys(root.stable, [
    'activeDeviceLeaseVersion', 'cleanupDeadlineAt', 'clientInstanceId', 'connectionId', 'deviceId',
    'eligibilityObservedAt', 'governance', 'leaseExpiresAt', 'livekitParticipantAlias',
    'livekitRoomAlias', 'livekitSessionAlias', 'ownerConnectionEpoch', 'providerAlias', 'purpose', 'requestedCapabilities',
    'sessionExpiresAt', 'sessionId', 'userId',
  ], 'RAYNEO_DEMO_OWNER_STABLE_INVALID');
  const resolution = closedKeys(root.resolution, ['observedAt'], 'RAYNEO_DEMO_OWNER_RESOLUTION_INVALID');
  timestamp(resolution.observedAt, 'RAYNEO_DEMO_OWNER_ECHO_INVALID');
  const expected = stableProjection(policy, live, live.activeDeviceLeaseVersion, lookup.observedAt);
  if (!sameJson(stable, expected.stable)) fail('RAYNEO_DEMO_OWNER_PROJECTION_DRIFT');
  return Object.freeze({ stable: expected.stable, resolution: Object.freeze({ observedAt: lookup.observedAt }) });
}

interface NormalizedLeaseOwner {
  readonly projection: RayneoDemoOwnerProjection;
  readonly governance: OpaqueGovernanceValue;
  readonly requestedCapabilities: readonly string[];
}

function opaqueList(value: unknown, code: string): readonly OpaqueOwnerValue[] {
  if (!Array.isArray(value) || value.length === 0) fail(code);
  const result = value.map((item) => opaque(item, code));
  const fingerprints = result.map((item) => canonicalJson(item));
  if (new Set(fingerprints).size !== fingerprints.length) fail(code);
  return Object.freeze(result);
}

function requiredKeys(value: unknown, expected: readonly string[], code: string): PlainRecord {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail(code);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) fail(code);
  }
  return value;
}

function assertLeaseGovernance(governanceValue: unknown): OpaqueGovernanceValue {
  const governance = opaque(governanceValue, 'RAYNEO_DEMO_OWNER_LEASE_GOVERNANCE_INVALID');
  const record = requiredKeys(governance, OWNER_GOVERNANCE_KEYS, 'RAYNEO_DEMO_OWNER_LEASE_GOVERNANCE_INVALID');
  stringList(record.purpose_scopes, 'RAYNEO_DEMO_OWNER_LEASE_PURPOSE_SCOPES_INVALID');
  opaqueList(record.policy_decision_refs, 'RAYNEO_DEMO_OWNER_LEASE_POLICY_REFS_INVALID');
  opaqueList(record.capability_grant_refs, 'RAYNEO_DEMO_OWNER_LEASE_CAPABILITY_REFS_INVALID');
  return governance;
}

function normalizeLeaseOwner(value: unknown): NormalizedLeaseOwner {
  const root = closedKeys(value, ['resolution', 'stable'], 'RAYNEO_DEMO_OWNER_LEASE_OWNER_INVALID');
  const stable = closedKeys(root.stable, [
    'activeDeviceLeaseVersion', 'cleanupDeadlineAt', 'clientInstanceId', 'connectionId', 'deviceId',
    'eligibilityObservedAt', 'governance', 'leaseExpiresAt', 'livekitParticipantAlias', 'livekitRoomAlias',
    'livekitSessionAlias', 'ownerConnectionEpoch', 'providerAlias', 'purpose', 'requestedCapabilities',
    'sessionExpiresAt', 'sessionId', 'userId',
  ], 'RAYNEO_DEMO_OWNER_LEASE_OWNER_INVALID');
  const resolution = closedKeys(root.resolution, ['observedAt'], 'RAYNEO_DEMO_OWNER_LEASE_OWNER_INVALID');
  const sessionId = nonEmpty(stable.sessionId, 'RAYNEO_DEMO_OWNER_LEASE_SESSION_INVALID');
  const deviceId = nonEmpty(stable.deviceId, 'RAYNEO_DEMO_OWNER_LEASE_DEVICE_INVALID');
  const clientInstanceId = nonEmpty(stable.clientInstanceId, 'RAYNEO_DEMO_OWNER_LEASE_CLIENT_INVALID');
  const userId = nonEmpty(stable.userId, 'RAYNEO_DEMO_OWNER_LEASE_USER_INVALID');
  if (!UUID_V7.test(userId)) fail('RAYNEO_DEMO_OWNER_LEASE_USER_INVALID');
  const purpose = nonEmpty(stable.purpose, 'RAYNEO_DEMO_OWNER_LEASE_PURPOSE_INVALID');
  const requestedCapabilities = stringList(
    stable.requestedCapabilities,
    'RAYNEO_DEMO_OWNER_LEASE_CAPABILITIES_INVALID',
  );
  const eligibilityObservedAt = timestamp(stable.eligibilityObservedAt, 'RAYNEO_DEMO_OWNER_LEASE_TIME_INVALID');
  const sessionExpiresAt = timestamp(stable.sessionExpiresAt, 'RAYNEO_DEMO_OWNER_LEASE_TIME_INVALID');
  const cleanupDeadlineAt = timestamp(stable.cleanupDeadlineAt, 'RAYNEO_DEMO_OWNER_LEASE_TIME_INVALID');
  const leaseExpiresAt = timestamp(stable.leaseExpiresAt, 'RAYNEO_DEMO_OWNER_LEASE_TIME_INVALID');
  const observedAt = timestamp(resolution.observedAt, 'RAYNEO_DEMO_OWNER_LEASE_TIME_INVALID');
  if (Date.parse(eligibilityObservedAt) >= Date.parse(sessionExpiresAt) ||
      Date.parse(eligibilityObservedAt) >= Date.parse(leaseExpiresAt) ||
      Date.parse(sessionExpiresAt) > Date.parse(cleanupDeadlineAt) ||
      Date.parse(observedAt) < Date.parse(eligibilityObservedAt) ||
      Date.parse(observedAt) >= Date.parse(sessionExpiresAt) ||
      Date.parse(observedAt) >= Date.parse(leaseExpiresAt)) {
    fail('RAYNEO_DEMO_OWNER_LEASE_TIME_INVALID');
  }
  const governance = opaque(stable.governance, 'RAYNEO_DEMO_OWNER_LEASE_GOVERNANCE_INVALID') as OpaqueGovernanceValue;
  const projection: RayneoDemoOwnerProjection = Object.freeze({
    stable: Object.freeze({
      sessionId,
      deviceId,
      clientInstanceId,
      userId,
      purpose,
      governance,
      requestedCapabilities,
      eligibilityObservedAt,
      sessionExpiresAt,
      cleanupDeadlineAt,
      leaseExpiresAt,
      connectionId: nonEmpty(stable.connectionId, 'RAYNEO_DEMO_OWNER_LEASE_CONNECTION_INVALID'),
      ownerConnectionEpoch: nonnegativeDecimal(stable.ownerConnectionEpoch, 'RAYNEO_DEMO_OWNER_LEASE_EPOCH_INVALID'),
      activeDeviceLeaseVersion: positiveDecimal(stable.activeDeviceLeaseVersion, 'RAYNEO_DEMO_OWNER_LEASE_VERSION_INVALID'),
      providerAlias: nonEmpty(stable.providerAlias, 'RAYNEO_DEMO_OWNER_LEASE_PROVIDER_INVALID'),
      livekitSessionAlias: nonEmpty(stable.livekitSessionAlias, 'RAYNEO_DEMO_OWNER_LEASE_SESSION_ALIAS_INVALID'),
      livekitRoomAlias: nonEmpty(stable.livekitRoomAlias, 'RAYNEO_DEMO_OWNER_LEASE_ROOM_ALIAS_INVALID'),
      livekitParticipantAlias: nonEmpty(stable.livekitParticipantAlias, 'RAYNEO_DEMO_OWNER_LEASE_PARTICIPANT_ALIAS_INVALID'),
    }),
    resolution: Object.freeze({ observedAt }),
  });
  return Object.freeze({ projection, governance, requestedCapabilities });
}

function readLeasePolicy(policyReader: RayneoLocalOwnerPolicyReader): RayneoLocalOwnerPolicy {
  let value: RayneoLocalOwnerPolicy | undefined;
  try { value = policyReader.read(); }
  catch (error) { fail('RAYNEO_DEMO_OWNER_LEASE_POLICY_READ_FAILED', error); }
  if (value === undefined) fail('RAYNEO_DEMO_OWNER_LEASE_POLICY_MISSING');
  return assertPolicy(value);
}

function assertLeasePolicyScope(
  policy: RayneoLocalOwnerPolicy,
  owner: NormalizedLeaseOwner,
): void {
  if (policy.userId !== owner.projection.stable.userId || policy.purpose !== owner.projection.stable.purpose ||
      !sameJson(policy.requestedCapabilities, owner.requestedCapabilities) ||
      !sameJson(policy.governance, owner.governance)) {
    fail('RAYNEO_DEMO_OWNER_LEASE_POLICY_DRIFT');
  }
  assertLeaseGovernance(policy.governance);
}

export function createRayneoDemoOwnerLeasePolicy(input: Readonly<{
  readonly policy: RayneoLocalOwnerPolicyReader;
  readonly verifiedOwner: RayneoDemoOwnerProjection;
}>): LeasePolicyPort {
  closedKeys(input, ['policy', 'verifiedOwner'], 'RAYNEO_DEMO_OWNER_LEASE_POLICY_INPUT_INVALID');
  assertPolicyReader(input.policy);
  const owner = normalizeLeaseOwner(input.verifiedOwner);
  const initialPolicy = readLeasePolicy(input.policy);
  assertLeasePolicyScope(initialPolicy, owner);
  const initialPolicyJson = canonicalJson(initialPolicy);

  const evaluate = async (rawInput: Parameters<LeasePolicyPort['evaluate']>[0]): Promise<LeasePolicyDecision> => {
    const request = closedKeys(rawInput, [
      'capabilities', 'deviceId', 'governance', 'occurredAt', 'purpose', 'userId',
    ], 'RAYNEO_DEMO_OWNER_LEASE_POLICY_INPUT_INVALID');
    const userId = nonEmpty(request.userId, 'RAYNEO_DEMO_OWNER_LEASE_POLICY_USER_INVALID');
    const deviceId = nonEmpty(request.deviceId, 'RAYNEO_DEMO_OWNER_LEASE_POLICY_DEVICE_INVALID');
    const purpose = nonEmpty(request.purpose, 'RAYNEO_DEMO_OWNER_LEASE_POLICY_PURPOSE_INVALID');
    const occurredAt = timestamp(request.occurredAt, 'RAYNEO_DEMO_OWNER_LEASE_POLICY_TIME_INVALID');
    const capabilitiesValue = stringList(request.capabilities, 'RAYNEO_DEMO_OWNER_LEASE_POLICY_CAPABILITIES_INVALID');
    if (userId !== owner.projection.stable.userId || purpose !== owner.projection.stable.purpose ||
        !sameJson(capabilitiesValue, owner.requestedCapabilities) ||
        occurredAt !== owner.projection.stable.eligibilityObservedAt || deviceId.length === 0 ||
        !sameJson(request.governance, owner.governance)) {
      fail('RAYNEO_DEMO_OWNER_LEASE_POLICY_INPUT_DRIFT');
    }
    const currentPolicy = readLeasePolicy(input.policy);
    if (canonicalJson(currentPolicy) !== initialPolicyJson) fail('RAYNEO_DEMO_OWNER_LEASE_POLICY_DRIFT');
    assertLeasePolicyScope(currentPolicy, owner);
    return Object.freeze({
      allowed: true,
      policyDecisionRef: currentPolicy.policyDecisionRef,
      capabilities: Object.freeze([...owner.requestedCapabilities]),
      purpose: owner.projection.stable.purpose,
      leaseExpiresAt: owner.projection.stable.leaseExpiresAt as LeasePolicyDecision['leaseExpiresAt'],
      revocable: true,
    });
  };

  return Object.freeze({ evaluate });
}

/** Create the synchronous, projection-scoped callback consumed by T02 068. */
export function createRayneoDemoLeasePolicyForOwner(
  policy: RayneoLocalOwnerPolicyReader,
): RayneoDemoLeasePolicyForOwner {
  assertPolicyReader(policy);
  return Object.freeze((verifiedOwner: RayneoDemoOwnerProjection): LeasePolicyPort =>
    createRayneoDemoOwnerLeasePolicy({ policy, verifiedOwner }));
}

export function createRayneoDemoOwnerProjectionResolver(input: Readonly<{
  readonly owner: Phase0SharedSessionOwner;
  readonly policy: RayneoLocalOwnerPolicyReader;
  readonly liveSession: RayneoDemoLiveSessionPort;
}>): RayneoDemoOwnerProjectionResolver {
  closedKeys(input, ['liveSession', 'owner', 'policy'], 'RAYNEO_DEMO_OWNER_INPUT_INVALID');
  assertOwner(input.owner);
  assertPolicyReader(input.policy);
  assertLivePort(input.liveSession);

  let bound: RayneoDemoOwnerProjection | undefined;
  let boundLookup: RayneoDemoCurrentBindingInput | undefined;

  return Object.freeze({
    resolve: async (rawInput: RayneoDemoCurrentBindingInput): Promise<RayneoDemoOwnerProjection | undefined> => {
      const lookup = normalizeLookup(rawInput);
      assertReady(input.policy, 'RAYNEO_LOCAL_OWNER_POLICY_NOT_READY');
      assertReady(input.liveSession, 'RAYNEO_DEMO_LIVE_SESSION_NOT_READY');
      const selected = readEligible(input.owner, lookup);
      if (selected === undefined) {
        if (bound !== undefined) fail('RAYNEO_DEMO_OWNER_SESSION_DRIFT');
        return undefined;
      }

      let liveRaw: RayneoDemoLiveSessionOutput | undefined;
      try {
        liveRaw = await input.liveSession.resolve(lookup);
      } catch (error) {
        fail('RAYNEO_DEMO_LIVE_SESSION_RESOLUTION_FAILED', error);
      }
      if (liveRaw === undefined) {
        if (bound !== undefined) fail('RAYNEO_DEMO_LIVE_SESSION_DRIFT');
        return undefined;
      }
      const live = normalizeLive(liveRaw);
      if (live.sessionId !== lookup.sessionId || live.deviceId !== lookup.deviceId || live.clientInstanceId !== lookup.clientInstanceId) {
        fail('RAYNEO_DEMO_LIVE_LOOKUP_MISMATCH');
      }
      assertLiveEligibility(selected, live);
      if (Date.parse(lookup.observedAt) < Date.parse(live.eligibilityObservedAt)) fail('RAYNEO_DEMO_OBSERVED_AT_STALE');
      if (Date.parse(lookup.observedAt) >= Date.parse(live.sessionExpiresAt) ||
          Date.parse(lookup.observedAt) >= Date.parse(live.leaseExpiresAt)) fail('RAYNEO_DEMO_BINDING_EXPIRED');

      const policyRaw = input.policy.read();
      if (policyRaw === undefined) fail('RAYNEO_LOCAL_OWNER_POLICY_MISSING');
      const policy = assertPolicy(policyRaw);
      const next = stableProjection(policy, live, String(selected.activeDeviceLeaseVersion), lookup.observedAt);
      if (bound !== undefined) {
        if (boundLookup === undefined || !lookupEqual(boundLookup, lookup)) fail('RAYNEO_DEMO_BINDING_DRIFT');
        if (!sameJson(bound.stable, next.stable)) fail('RAYNEO_DEMO_OWNER_PROJECTION_DRIFT');
        return assertProjectionStable(bound, policy, live, lookup);
      }
      boundLookup = lookup;
      bound = next;
      return bound;
    },
  });
}

/** Explicitly named aliases for callers using T02's owner-identity term. */
export const createRayneoDemoOwnerIdentityPort = createRayneoDemoOwnerProjectionResolver;
export const createRayneoDemoOwnerIdentityResolver = createRayneoDemoOwnerProjectionResolver;

export function createRayneoDemoOwnerProjection(input: Readonly<{
  readonly owner: Phase0SharedSessionOwner;
  readonly policy: RayneoLocalOwnerPolicyReader;
  readonly liveSession: RayneoDemoLiveSessionPort;
  readonly lookup: RayneoDemoCurrentBindingInput;
}>): Promise<RayneoDemoOwnerProjection | undefined> {
  return createRayneoDemoOwnerProjectionResolver(input).resolve(input.lookup);
}
