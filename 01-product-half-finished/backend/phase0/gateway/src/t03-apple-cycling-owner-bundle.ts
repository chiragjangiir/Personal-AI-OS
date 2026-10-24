import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  TransportDisconnectionPort,
  VerifiedTransportDisconnection,
} from '../../../services/realtime-core/src/ports.ts';
import type { ProductionAuthorityFactoryResult } from '../../../services/realtime-core/src/production-authority-factory.ts';
import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
  snapshotOpaqueOwnerValue,
  type AcceptedUserActivity,
  type CanonicalTimestamp,
  type CurrentBindingLookup,
  type DeviceLeaseRecord,
  type OpaqueCanonicalRef,
  type OpaqueGovernanceValue,
  type RealtimeCurrentBindingProjection,
  type RealtimeSessionRecord,
  type RealtimeTransportBinding,
  type VerifiedActivityAcceptance,
} from '../../../services/realtime-core/src/types.ts';
import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeGovernanceDecision,
  RealtimeGovernancePort,
  RealtimeOperation,
} from './realtime-public-control-runtime.ts';
import type { RecipientCredentialPort } from './realtime-e2ee-ciphertext-resolver.ts';
import type {
  T11bOwnerContext,
  T11bOwnerContextPort,
  T11bT03GovernancePort,
} from './realtime-public-control-t11b-t02-adapter.ts';
import {
  createT03GovernanceDeviceCredentialProductionAdapter,
  type T03GovernanceDeviceCredentialProductionGovernance,
} from './t03-governance-device-credential-production-adapter.ts';
import {
  createT03AppleCyclingLeaseAuthority,
  T03AppleCyclingLeaseAuthorityError,
  type T03AppleCyclingAuthorityRecordReader,
  type T03AppleCyclingCurrentAuthorityProjection,
  type T03AppleCyclingExpectedRecordSha256Port,
  type T03AppleCyclingLeaseAuthority,
  type T03AppleCyclingOwnerProtectionPort,
  wireGovernance,
} from './t03-apple-cycling-lease-authority.ts';

type Clock = () => number | string | Date;
type CurrentBindingReader = ProductionAuthorityFactoryResult['readCurrentBinding'];
type JsonObject = Record<string, unknown>;

const OWNER = 'T03.apple-cycling-governance' as const;
const PURPOSE = 'cycling_assistant' as const;
const OPERATIONS = new Set<RealtimeOperation>([
  'bootstrap',
  'realtime_e2ee_key_resolve',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
]);

interface T03AppleCyclingOwnerBundleOptionsBase {
  readonly record: T03AppleCyclingAuthorityRecordReader;
  readonly expectedRecordPath?: string;
  readonly ownerProtection: T03AppleCyclingOwnerProtectionPort;
  readonly now?: () => number;
  readonly clock?: Clock;
}

export type T03AppleCyclingOwnerBundleOptions = T03AppleCyclingOwnerBundleOptionsBase & (
  | {
      readonly expectedRecordSha256: string;
      readonly expectedRecordSha256Port?: never;
    }
  | {
      readonly expectedRecordSha256?: never;
      readonly expectedRecordSha256Port: T03AppleCyclingExpectedRecordSha256Port;
    }
);

export interface T03AppleCyclingOwnerBundleReadinessSnapshot {
  readonly ready: boolean;
  readonly bound: boolean;
  readonly authorityReady: boolean;
  readonly closed: boolean;
}

export interface T03AppleCyclingOwnerBundleReadiness {
  readonly owner: typeof OWNER;
  readonly environment: 'production';
  readonly isReady: () => boolean;
  readonly current: () => T03AppleCyclingOwnerBundleReadinessSnapshot;
  readonly assertReady: () => void;
  readonly reason: string;
}

export interface T03AppleCyclingOwnerBundle {
  readonly readCurrentAuthority?: ReturnType<typeof createT03AppleCyclingLeaseAuthority>["readCurrentAuthority"];
  readonly formalWatchPrimaryAuthority: ReturnType<typeof createT03AppleCyclingLeaseAuthority>["formalWatchPrimaryAuthority"];
  readonly policy: Readonly<{
    readonly port: LeasePolicyPort;
    readonly readiness: T03AppleCyclingOwnerBundleReadiness;
  }>;
  readonly activityAcceptance: Readonly<{
    readonly port: ActivityAcceptancePort;
    readonly readiness: T03AppleCyclingOwnerBundleReadiness;
  }>;
  readonly transportDisconnection: Readonly<{
    readonly port: TransportDisconnectionPort;
    readonly readiness: T03AppleCyclingOwnerBundleReadiness;
  }>;
  readonly recipientCredential: Readonly<{
    readonly port: RecipientCredentialPort;
    readonly readiness: T03AppleCyclingOwnerBundleReadiness;
  }>;
  readonly governance: T03GovernanceDeviceCredentialProductionGovernance;
  readonly ownerContext: T11bOwnerContextPort;
  readonly bindCurrentBinding: (reader: CurrentBindingReader) => void;
  readonly readiness: T03AppleCyclingOwnerBundleReadiness;
  readonly close: () => Promise<void>;
}

export class T03AppleCyclingOwnerBundleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'T03AppleCyclingOwnerBundleError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new T03AppleCyclingOwnerBundleError(code);
}

function isPlainRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value: unknown, key: string): unknown {
  return isPlainRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function first(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    const found = own(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) fail(code);
  return value;
}

function timestampValue(value: unknown, code: string): CanonicalTimestamp {
  try {
    return assertCanonicalTimestamp(value);
  } catch {
    return fail(code);
  }
}

function opaqueValue(value: unknown, code: string): OpaqueCanonicalRef {
  try {
    return snapshotOpaqueOwnerValue(value) as OpaqueCanonicalRef;
  } catch {
    return fail(code);
  }
}

function structuralKey(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === undefined) return 'undefined;';
  if (value === null) return 'null;';
  if (typeof value === 'string') return `string:${value.length}:${value};`;
  if (typeof value === 'boolean') return value ? 'boolean:1;' : 'boolean:0;';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('VALUE_INVALID');
    return `number:${String(value)};`;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('VALUE_INVALID');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string') || Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new Error('VALUE_INVALID');
      }
      return `array:${value.length}:[${value.map((item) => structuralKey(item, ancestors)).join('')}]`;
    }
    if (!isPlainRecord(value)) throw new Error('VALUE_INVALID');
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string') || Object.getOwnPropertyNames(value).length !== keys.length) {
      throw new Error('VALUE_INVALID');
    }
    return `object:${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined ||
          descriptor.set !== undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('VALUE_INVALID');
      }
      return `${key.length}:${key}=${structuralKey(descriptor.value, ancestors)}`;
    }).join('|')}`;
  } finally {
    ancestors.delete(value);
  }
}

function same(left: unknown, right: unknown): boolean {
  try {
    return structuralKey(left) === structuralKey(right);
  } catch {
    return false;
  }
}

function clockMillis(clock: Clock): number {
  let value: number | string | Date;
  try {
    value = clock();
  } catch {
    return fail('T03_APPLE_CYCLING_CLOCK_INVALID');
  }
  const millis = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(millis)) fail('T03_APPLE_CYCLING_CLOCK_INVALID');
  return millis;
}

function clockTimestamp(clock: Clock): CanonicalTimestamp {
  try {
    return assertCanonicalTimestamp(new Date(clockMillis(clock)).toISOString());
  } catch {
    return fail('T03_APPLE_CYCLING_CLOCK_INVALID');
  }
}

function currentLookup(request: unknown): CurrentBindingLookup {
  const session = first(request, ['realtime_session_ref', 'realtimeSessionRef', 'session_ref', 'sessionRef']);
  const continuity = first(request, ['continuity_id', 'continuityId']);
  if (session !== undefined && continuity !== undefined) fail('T03_APPLE_CYCLING_LOOKUP_INVALID');
  if (session !== undefined) return { realtimeSessionRef: opaqueValue(session, 'T03_APPLE_CYCLING_LOOKUP_INVALID') };
  if (typeof continuity === 'string' && continuity.length !== 0) return { continuityId: continuity };
  const binding = first(request, ['binding', 'current_binding', 'currentBinding']);
  const nestedSession = first(binding, ['realtimeSessionRef', 'realtime_session_ref', 'sessionRef', 'session_ref']);
  const nestedContinuity = first(binding, ['continuityId', 'continuity_id']);
  if (nestedSession !== undefined && nestedContinuity !== undefined) fail('T03_APPLE_CYCLING_LOOKUP_INVALID');
  if (nestedSession !== undefined) return { realtimeSessionRef: opaqueValue(nestedSession, 'T03_APPLE_CYCLING_LOOKUP_INVALID') };
  if (typeof nestedContinuity === 'string' && nestedContinuity.length !== 0) return { continuityId: nestedContinuity };
  return fail('T03_APPLE_CYCLING_LOOKUP_REQUIRED');
}

function ownerContextValue(
  authority: T03AppleCyclingCurrentAuthorityProjection,
  occurredAt: CanonicalTimestamp,
): T11bOwnerContext {
  return Object.freeze({
    userId: authority.userId,
    deviceId: authority.deviceId,
    purpose: PURPOSE,
    capabilities: Object.freeze([...authority.allowedMediaCapabilities]),
    occurredAt,
  });
}

function bootstrapOccurredAt(
  authority: T03AppleCyclingCurrentAuthorityProjection,
  request: JsonObject,
  observedAt: CanonicalTimestamp,
): CanonicalTimestamp {
  const start = first(request, ['start']);
  const occurredAt = timestampValue(first(start, ['started_at']), 'T03_APPLE_CYCLING_START_TIME_INVALID');
  const occurredMs = Date.parse(occurredAt);
  const issuedMs = Date.parse(authority.issuedAt);
  const leaseExpiresMs = Date.parse(authority.leaseExpiresAt);
  const authorityExpiresMs = Date.parse(authority.expiresAt);
  const observedMs = Date.parse(observedAt);
  if (![occurredMs, issuedMs, leaseExpiresMs, authorityExpiresMs, observedMs].every(Number.isSafeInteger) ||
      occurredMs < issuedMs || occurredMs >= Math.min(leaseExpiresMs, authorityExpiresMs) || occurredMs > observedMs) {
    fail('T03_APPLE_CYCLING_START_TIME_INVALID');
  }
  return occurredAt;
}

function normalizeBinding(value: unknown): RealtimeCurrentBindingProjection {
  if (!isPlainRecord(value) || !isPlainRecord(value.session) || !isPlainRecord(value.lease)) {
    fail('T03_APPLE_CYCLING_PG_BINDING_INVALID');
  }
  const rawSession = value.session;
  const rawLease = value.lease;
  if (!isPlainRecord(rawSession.binding)) fail('T03_APPLE_CYCLING_PG_BINDING_INVALID');
  const rawBinding = rawSession.binding;
  const sessionRef = opaqueValue(rawSession.realtimeSessionRef, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const leaseRef = opaqueValue(rawLease.deviceLeaseRef, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const leaseSessionRef = opaqueValue(rawLease.realtimeSessionRef, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const bindingSessionRef = opaqueValue(rawBinding.realtimeSessionRef, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const bindingLeaseRef = opaqueValue(rawBinding.deviceLeaseRef, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const activeLeaseRef = opaqueValue(rawSession.activeDeviceLeaseRef, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const sessionUser = stringValue(rawSession.userId, 'T03_APPLE_CYCLING_PG_IDENTITY_INVALID');
  const leaseUser = stringValue(rawLease.userId, 'T03_APPLE_CYCLING_PG_IDENTITY_INVALID');
  const sessionDevice = stringValue(rawSession.activeDeviceId, 'T03_APPLE_CYCLING_PG_IDENTITY_INVALID');
  const leaseDevice = stringValue(rawLease.deviceId, 'T03_APPLE_CYCLING_PG_IDENTITY_INVALID');
  const sessionContinuity = stringValue(rawSession.continuityId, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const leaseContinuity = stringValue(rawLease.continuityId, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const bindingContinuity = stringValue(rawBinding.continuityId, 'T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  const bindingDevice = stringValue(rawBinding.deviceId, 'T03_APPLE_CYCLING_PG_IDENTITY_INVALID');
  const sessionEpoch = assertDecimalConnectionEpoch(rawSession.connectionEpoch);
  const bindingEpoch = assertDecimalConnectionEpoch(rawBinding.connectionEpoch);
  const sessionState = rawSession.state;
  const continuityState = rawSession.continuityState;
  const leaseState = rawLease.state;
  const bindingState = rawBinding.state;
  if (sessionState !== 'active' || continuityState !== 'active' || leaseState !== 'active' ||
      (bindingState !== 'connected' && bindingState !== 'disconnected')) {
    fail('T03_APPLE_CYCLING_PG_STATE_INVALID');
  }
  if (!same(sessionRef, leaseSessionRef) || !same(sessionRef, bindingSessionRef) ||
      !same(activeLeaseRef, leaseRef) || !same(leaseRef, bindingLeaseRef) ||
      sessionUser !== leaseUser || sessionContinuity !== leaseContinuity ||
      sessionContinuity !== bindingContinuity || sessionDevice !== leaseDevice || bindingDevice !== leaseDevice ||
      sessionEpoch !== bindingEpoch) {
    fail('T03_APPLE_CYCLING_PG_LINKAGE_INVALID');
  }
  const capabilities = own(rawLease, 'capabilities');
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('T03_APPLE_CYCLING_PG_CAPABILITIES_INVALID');
  }
  const session: RealtimeSessionRecord = Object.freeze({
    realtimeSessionRef: sessionRef,
    userId: sessionUser,
    continuityId: sessionContinuity,
    state: 'active',
    continuityState: 'active',
    connectionEpoch: sessionEpoch,
    continuityExpiresAt: timestampValue(rawSession.continuityExpiresAt, 'T03_APPLE_CYCLING_PG_EXPIRY_INVALID'),
    lastAcceptedUserActivityAt: timestampValue(rawSession.lastAcceptedUserActivityAt, 'T03_APPLE_CYCLING_PG_EXPIRY_INVALID'),
    activeDeviceId: sessionDevice,
    activeDeviceLeaseRef: leaseRef,
    binding: Object.freeze({
      state: bindingState as 'connected' | 'disconnected',
      realtimeSessionRef: bindingSessionRef,
      deviceLeaseRef: bindingLeaseRef,
      continuityId: bindingContinuity,
      deviceId: bindingDevice,
      connectionEpoch: bindingEpoch,
      provider: opaqueValue(rawBinding.provider, 'T03_APPLE_CYCLING_PG_BINDING_INVALID'),
      transportSessionAlias: opaqueValue(rawBinding.transportSessionAlias, 'T03_APPLE_CYCLING_PG_BINDING_INVALID'),
      roomAlias: opaqueValue(rawBinding.roomAlias, 'T03_APPLE_CYCLING_PG_BINDING_INVALID'),
      deviceAlias: opaqueValue(rawBinding.deviceAlias, 'T03_APPLE_CYCLING_PG_BINDING_INVALID'),
      connectionId: stringValue(rawBinding.connectionId, 'T03_APPLE_CYCLING_PG_BINDING_INVALID'),
    }) as RealtimeTransportBinding,
    revision: assertDecimalCounter(rawSession.revision),
  });
  const lease: DeviceLeaseRecord = Object.freeze({
    deviceLeaseRef: leaseRef,
    realtimeSessionRef: leaseSessionRef,
    continuityId: leaseContinuity,
    userId: leaseUser,
    deviceId: leaseDevice,
    state: 'active',
    capabilities: Object.freeze([...capabilities]),
    purpose: stringValue(rawLease.purpose, 'T03_APPLE_CYCLING_PG_PURPOSE_INVALID'),
    issuedAt: timestampValue(rawLease.issuedAt, 'T03_APPLE_CYCLING_PG_EXPIRY_INVALID'),
    expiresAt: timestampValue(rawLease.expiresAt, 'T03_APPLE_CYCLING_PG_EXPIRY_INVALID'),
    revocable: true,
    leaseVersion: assertDecimalCounter(rawLease.leaseVersion),
    fencingToken: assertDecimalCounter(rawLease.fencingToken),
    policyDecisionRef: opaqueValue(rawLease.policyDecisionRef, 'T03_APPLE_CYCLING_PG_POLICY_REF_INVALID') as OpaqueGovernanceValue,
  });
  return Object.freeze({ session, lease });
}

function assertBindingMatchesAuthority(
  authority: T03AppleCyclingCurrentAuthorityProjection,
  binding: RealtimeCurrentBindingProjection,
  lookup: CurrentBindingLookup,
  atSystemTime: CanonicalTimestamp,
): void {
  const session = binding.session;
  const lease = binding.lease;
  const transport = session.binding;
  if (lookup.realtimeSessionRef !== undefined && !same(lookup.realtimeSessionRef, session.realtimeSessionRef)) {
    fail('T03_APPLE_CYCLING_PG_LOOKUP_MISMATCH');
  }
  if (lookup.continuityId !== undefined && lookup.continuityId !== session.continuityId) {
    fail('T03_APPLE_CYCLING_PG_LOOKUP_MISMATCH');
  }
  if (session.userId !== authority.userId || lease.userId !== authority.userId) fail('T03_APPLE_CYCLING_PG_USER_MISMATCH');
  if (session.activeDeviceId !== authority.deviceId || lease.deviceId !== authority.deviceId || transport.deviceId !== authority.deviceId) {
    fail('T03_APPLE_CYCLING_PG_DEVICE_MISMATCH');
  }
  if (lease.purpose !== PURPOSE) fail('T03_APPLE_CYCLING_PG_PURPOSE_MISMATCH');
  if (!same(lease.capabilities, authority.allowedMediaCapabilities)) fail('T03_APPLE_CYCLING_PG_CAPABILITY_MISMATCH');
  if (!same(lease.policyDecisionRef, authority.policyDecisionRef)) fail('T03_APPLE_CYCLING_PG_POLICY_REF_MISMATCH');
  const now = Date.parse(atSystemTime);
  const continuityExpires = Date.parse(session.continuityExpiresAt);
  const leaseIssued = Date.parse(lease.issuedAt);
  const leaseExpires = Date.parse(lease.expiresAt);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(continuityExpires) || !Number.isSafeInteger(leaseIssued) ||
      !Number.isSafeInteger(leaseExpires) || now < leaseIssued || now >= continuityExpires || now >= leaseExpires ||
      lease.expiresAt !== authority.leaseExpiresAt || lease.expiresAt > authority.expiresAt) {
    fail('T03_APPLE_CYCLING_PG_EXPIRY_INVALID');
  }
}

function assertRequestRevalidated(
  request: JsonRecord,
  authority: T03AppleCyclingCurrentAuthorityProjection,
  binding: RealtimeCurrentBindingProjection,
): void {
  const requestedUser = first(request, ['user_id', 'userId']);
  const requestedDevice = first(request, ['device_id', 'deviceId']) ?? first(first(request, ['start']), ['device_id', 'deviceId']);
  const requestedPurpose = first(request, ['purpose']);
  const requestedCapabilities = first(request, ['capabilities']);
  const requestedPolicy = first(request, ['policy_decision_ref', 'policyDecisionRef']);
  if (requestedUser !== undefined && requestedUser !== authority.userId) fail('T03_APPLE_CYCLING_REQUEST_USER_MISMATCH');
  if (requestedDevice !== undefined && requestedDevice !== authority.deviceId) fail('T03_APPLE_CYCLING_REQUEST_DEVICE_MISMATCH');
  if (requestedPurpose !== undefined && requestedPurpose !== PURPOSE) fail('T03_APPLE_CYCLING_REQUEST_PURPOSE_MISMATCH');
  if (requestedCapabilities !== undefined && !same(requestedCapabilities, binding.lease.capabilities)) fail('T03_APPLE_CYCLING_REQUEST_CAPABILITY_MISMATCH');
  if (requestedPolicy !== undefined && !same(requestedPolicy, authority.policyDecisionRef)) fail('T03_APPLE_CYCLING_REQUEST_POLICY_MISMATCH');
  const requestGovernance = own(request, 'governance');
  if (requestGovernance !== undefined && !same(requestGovernance, authority.governance)) fail('T03_APPLE_CYCLING_REQUEST_GOVERNANCE_MISMATCH');
}

export function createT03AppleCyclingOwnerBundle(
  options: T03AppleCyclingOwnerBundleOptions,
): T03AppleCyclingOwnerBundle {
  if (!isPlainRecord(options) || typeof options.record?.read !== 'function' ||
      typeof options.ownerProtection?.assertOwnerProtected !== 'function') {
    fail('T03_APPLE_CYCLING_BUNDLE_OPTIONS_INVALID');
  }
  const hasExpectedSha256 = Object.hasOwn(options, 'expectedRecordSha256');
  const hasExpectedSha256Port = Object.hasOwn(options, 'expectedRecordSha256Port');
  if (hasExpectedSha256 === hasExpectedSha256Port) fail('T03_APPLE_CYCLING_BUNDLE_OPTIONS_INVALID');
  const clock: Clock = options.clock ?? options.now ?? (() => Date.now());
  const authority = createT03AppleCyclingLeaseAuthority({
    record: options.record,
    ...(options.expectedRecordPath ? {expectedRecordPath:options.expectedRecordPath} : {}),
    ownerProtection: options.ownerProtection,
    ...(hasExpectedSha256
      ? { expectedRecordSha256: options.expectedRecordSha256! }
      : { expectedRecordSha256Port: options.expectedRecordSha256Port! }),
    now: () => clockMillis(clock),
  });
  let closed = false;
  let bindingBound = false;
  let currentBindingReader: CurrentBindingReader | undefined;
  let fence = 0;
  let closeFlight: Promise<void> | undefined;

  const begin = (): number => {
    if (closed) fail('T03_APPLE_CYCLING_BUNDLE_CLOSED');
    if (!bindingBound || currentBindingReader === undefined) fail('T03_APPLE_CYCLING_BUNDLE_NOT_READY');
    return fence;
  };
  const assertFence = (observed: number): void => {
    if (closed || observed !== fence) fail('T03_APPLE_CYCLING_BUNDLE_CLOSED');
  };
  const readAuthority = (atSystemTime: CanonicalTimestamp): T03AppleCyclingCurrentAuthorityProjection => {
    try {
      return authority.readCurrentAuthority(atSystemTime);
    } catch (error) {
      if (error instanceof T03AppleCyclingLeaseAuthorityError) throw error;
      return fail('T03_APPLE_CYCLING_BUNDLE_AUTHORITY_UNAVAILABLE');
    }
  };
  const readBinding = async (
    lookup: CurrentBindingLookup,
    atSystemTime: CanonicalTimestamp,
    initialAuthority: T03AppleCyclingCurrentAuthorityProjection,
    observedFence: number,
  ): Promise<{ readonly authority: T03AppleCyclingCurrentAuthorityProjection; readonly binding: RealtimeCurrentBindingProjection }> => {
    const reader = currentBindingReader;
    if (reader === undefined) fail('T03_APPLE_CYCLING_BUNDLE_NOT_READY');
    let raw: RealtimeCurrentBindingProjection | undefined;
    try {
      raw = await reader(lookup);
    } catch {
      fail('T03_APPLE_CYCLING_PG_BINDING_UNAVAILABLE');
    }
    assertFence(observedFence);
    if (raw === undefined) fail('T03_APPLE_CYCLING_PG_BINDING_MISSING');
    let binding: RealtimeCurrentBindingProjection;
    try {
      binding = normalizeBinding(raw);
    } catch (error) {
      if (error instanceof T03AppleCyclingOwnerBundleError) throw error;
      fail('T03_APPLE_CYCLING_PG_BINDING_INVALID');
    }
    const currentAuthority = readAuthority(atSystemTime);
    if (!same(initialAuthority, currentAuthority)) fail('T03_APPLE_CYCLING_AUTHORITY_DRIFT');
    assertBindingMatchesAuthority(currentAuthority, binding, lookup, atSystemTime);
    return Object.freeze({ authority: currentAuthority, binding });
  };

  const isReady = (): boolean => {
    if (closed || !bindingBound || currentBindingReader === undefined) return false;
    try {
      return authority.isReady();
    } catch {
      return false;
    }
  };
  const readiness: T03AppleCyclingOwnerBundleReadiness = Object.freeze({
    owner: OWNER,
    environment: 'production',
    isReady,
    current: () => {
      const authorityReady = !closed && (() => {
        try { return authority.isReady(); } catch { return false; }
      })();
      return Object.freeze({
        ready: !closed && bindingBound && currentBindingReader !== undefined && authorityReady,
        bound: bindingBound && currentBindingReader !== undefined,
        authorityReady,
        closed,
      });
    },
    assertReady: () => {
      if (!isReady()) fail('T03_APPLE_CYCLING_BUNDLE_NOT_READY');
    },
    reason: 'T03_APPLE_CYCLING_BUNDLE_NOT_READY',
  });

  const policyPort: LeasePolicyPort = Object.freeze({
    evaluate: async (input: Parameters<LeasePolicyPort['evaluate']>[0]) => {
      const observedFence = begin();
      const result = await authority.policy.port.evaluate(input);
      assertFence(observedFence);
      return result;
    },
  });
  const policy = Object.freeze({
    port: policyPort,
    readiness,
  });

  const lazyCurrentBinding = async (lookup: CurrentBindingLookup): Promise<RealtimeCurrentBindingProjection | undefined> => {
    if (closed || !bindingBound || currentBindingReader === undefined) return undefined;
    const observedFence = fence;
    try {
      const atSystemTime = clockTimestamp(clock);
      const currentAuthority = readAuthority(atSystemTime);
      const result = await readBinding(lookup, atSystemTime, currentAuthority, observedFence);
      assertFence(observedFence);
      return result.binding;
    } catch {
      return undefined;
    }
  };

  const recipientCredentialPort: RecipientCredentialPort = Object.freeze({
    resolve: async (input: Parameters<NonNullable<RecipientCredentialPort['resolve']>>[0]) => {
      const observedFence = begin();
      if (!isPlainRecord(input.request) || !isPlainRecord(input.credentialRef) ||
          typeof input.deviceId !== 'string' || input.deviceId.length === 0) return undefined;
      const atSystemTime = clockTimestamp(clock);
      const currentAuthority = readAuthority(atSystemTime);
      const credential = currentAuthority.recipientCredential;
      if (credential === undefined || input.deviceId !== credential.deviceId ||
          !same(input.credentialRef, credential.deviceCredentialRef) ||
          Date.parse(credential.expiresAt) <= Date.parse(atSystemTime)) return undefined;
      const result = await readBinding(
        { realtimeSessionRef: credential.realtimeSessionRef as OpaqueCanonicalRef },
        atSystemTime,
        currentAuthority,
        observedFence,
      );
      if (!same(result.binding.session.realtimeSessionRef, credential.realtimeSessionRef) ||
          !same(result.binding.lease.deviceLeaseRef, credential.deviceLeaseRef) ||
          result.binding.session.continuityId !== credential.continuityId ||
          result.binding.session.activeDeviceId !== credential.deviceId) return undefined;
      assertFence(observedFence);
      return Object.freeze({
        publicKey: Buffer.from(credential.publicKey, 'base64url'),
        status: 'active' as const,
        expiresAt: credential.expiresAt,
        deviceId: credential.deviceId,
        credentialRef: snapshotOpaqueOwnerValue(credential.deviceCredentialRef) as JsonRecord,
      });
    },
  });

  const adapter = createT03GovernanceDeviceCredentialProductionAdapter({
    authority: authority.authoritySnapshot,
    readCurrentBinding: lazyCurrentBinding,
    recipientCredential: recipientCredentialPort,
    clock,
  });

  const governance: T03GovernanceDeviceCredentialProductionGovernance = Object.freeze({
    evaluate: async (
      input: Parameters<RealtimeGovernancePort['evaluate']>[0],
    ): Promise<RealtimeGovernanceDecision> => {
      const observedFence = begin();
      const result = await adapter.governance.evaluate(input);
      assertFence(observedFence);
      return result;
    },
    assertAuthorized: async (
      input: Parameters<T11bT03GovernancePort['assertAuthorized']>[0],
    ): Promise<OpaqueGovernanceValue> => {
      const observedFence = begin();
      const result = await adapter.governance.assertAuthorized(input);
      assertFence(observedFence);
      return result;
    },
  });

  const ownerContext: T11bOwnerContextPort = Object.freeze({
    resolve: async (input: Parameters<T11bOwnerContextPort['resolve']>[0]): Promise<T11bOwnerContext> => {
      const observedFence = begin();
      const atSystemTime = clockTimestamp(clock);
      const authorityAtStart = readAuthority(atSystemTime);
      if (input.operation === 'bootstrap') {
        assertFence(observedFence);
        return ownerContextValue(authorityAtStart, bootstrapOccurredAt(authorityAtStart, input.request, atSystemTime));
      }
      const lookup = currentLookup(input.request);
      const result = await readBinding(lookup, atSystemTime, authorityAtStart, observedFence);
      assertRequestRevalidated(input.request, result.authority, result.binding);
      assertFence(observedFence);
      return ownerContextValue(result.authority, atSystemTime);
    },
  });

  const activityPort: ActivityAcceptancePort = Object.freeze({
    verify: async (activity: AcceptedUserActivity): Promise<Awaited<ReturnType<ActivityAcceptancePort['verify']>>> => {
      const observedFence = begin();
      const atSystemTime = clockTimestamp(clock);
      const authorityAtStart = readAuthority(atSystemTime);
      if (!isPlainRecord(activity) || activity.kind !== 'accepted_user_activity' || activity.accepted !== true) {
        fail('T03_APPLE_CYCLING_ACTIVITY_INVALID');
      }
      stringValue(activity.activityId, 'T03_APPLE_CYCLING_ACTIVITY_INVALID');
      if (activity.userId !== authorityAtStart.userId) fail('T03_APPLE_CYCLING_ACTIVITY_USER_MISMATCH');
      if (activity.deviceId !== authorityAtStart.deviceId) fail('T03_APPLE_CYCLING_ACTIVITY_DEVICE_MISMATCH');
      const occurredAt = timestampValue(activity.occurredAt, 'T03_APPLE_CYCLING_ACTIVITY_TIME_INVALID');
      if (Date.parse(occurredAt) > Date.parse(atSystemTime)) fail('T03_APPLE_CYCLING_ACTIVITY_TIME_INVALID');
      const acceptanceRef = opaqueValue(activity.acceptanceRef, 'T03_APPLE_CYCLING_ACTIVITY_ACCEPTANCE_INVALID');
      if (!same(acceptanceRef, authorityAtStart.policyDecisionRef)) fail('T03_APPLE_CYCLING_ACTIVITY_ACCEPTANCE_MISMATCH');
      const lookup: CurrentBindingLookup = { realtimeSessionRef: opaqueValue(activity.realtimeSessionRef, 'T03_APPLE_CYCLING_ACTIVITY_BINDING_INVALID') };
      const result = await readBinding(lookup, atSystemTime, authorityAtStart, observedFence);
      if (result.binding.session.binding.state !== 'connected' ||
          result.binding.session.continuityId !== activity.continuityId ||
          !same(result.binding.session.realtimeSessionRef, activity.realtimeSessionRef)) {
        fail('T03_APPLE_CYCLING_ACTIVITY_BINDING_MISMATCH');
      }
      assertFence(observedFence);
      const verification: VerifiedActivityAcceptance = Object.freeze({
        verified: true,
        acceptanceRef: snapshotOpaqueOwnerValue(acceptanceRef),
        acceptedAt: occurredAt,
        authorityWatermark: snapshotOpaqueOwnerValue(result.authority.policyDecisionRef),
      });
      return verification;
    },
  });

  const transportPort: TransportDisconnectionPort = Object.freeze({
    verify: async (input: Parameters<TransportDisconnectionPort['verify']>[0]): Promise<VerifiedTransportDisconnection> => {
      const observedFence = begin();
      const atSystemTime = clockTimestamp(clock);
      const authorityAtStart = readAuthority(atSystemTime);
      if (!isPlainRecord(input) || !isPlainRecord(input.binding)) fail('T03_APPLE_CYCLING_DISCONNECTION_INVALID');
      if (input.userId !== authorityAtStart.userId) fail('T03_APPLE_CYCLING_DISCONNECTION_USER_MISMATCH');
      if (input.deviceId !== authorityAtStart.deviceId) fail('T03_APPLE_CYCLING_DISCONNECTION_DEVICE_MISMATCH');
      const occurredAt = timestampValue(input.occurredAt, 'T03_APPLE_CYCLING_DISCONNECTION_TIME_INVALID');
      if (Date.parse(occurredAt) > Date.parse(atSystemTime)) fail('T03_APPLE_CYCLING_DISCONNECTION_TIME_INVALID');
      if (!same(input.governance, wireGovernance(authorityAtStart.governance))) fail('T03_APPLE_CYCLING_DISCONNECTION_GOVERNANCE_MISMATCH');
      const inputBinding = input.binding as unknown as RealtimeTransportBinding;
      const lookup: CurrentBindingLookup = { realtimeSessionRef: opaqueValue(inputBinding.realtimeSessionRef, 'T03_APPLE_CYCLING_DISCONNECTION_BINDING_INVALID') };
      const result = await readBinding(lookup, atSystemTime, authorityAtStart, observedFence);
      if (!same(inputBinding, result.binding.session.binding)) fail('T03_APPLE_CYCLING_DISCONNECTION_BINDING_MISMATCH');
      if (inputBinding.state === 'connected') fail('T03_APPLE_CYCLING_DISCONNECTION_PROOF_REQUIRED');
      assertFence(observedFence);
      fail('T03_APPLE_CYCLING_DISCONNECTION_PROOF_REQUIRED');
    },
  });

  const activityAcceptance = Object.freeze({ port: activityPort, readiness });
  const transportDisconnection = Object.freeze({ port: transportPort, readiness });
  const recipientReadiness: T03AppleCyclingOwnerBundleReadiness = Object.freeze({
    ...readiness,
    isReady: () => {
      if (!isReady()) return false;
      try { return authority.readCurrentAuthority(clockTimestamp(clock)).recipientCredential !== undefined; }
      catch { return false; }
    },
    current: () => {
      const base = readiness.current();
      const credentialReady = base.ready && (() => {
        try { return authority.readCurrentAuthority(clockTimestamp(clock)).recipientCredential !== undefined; }
        catch { return false; }
      })();
      return Object.freeze({ ...base, ready: credentialReady, authorityReady: credentialReady });
    },
    assertReady: () => {
      if (!recipientReadiness.isReady()) fail('T03_APPLE_CYCLING_RECIPIENT_NOT_READY');
    },
    reason: 'T03_APPLE_CYCLING_RECIPIENT_NOT_READY',
  });
  const recipientCredential = Object.freeze({
    port: adapter.recipientCredential ?? recipientCredentialPort,
    readiness: recipientReadiness,
  });

  const bindCurrentBinding = (reader: CurrentBindingReader): void => {
    if (closed) fail('T03_APPLE_CYCLING_BUNDLE_CLOSED');
    if (bindingBound) fail('T03_APPLE_CYCLING_BINDING_ALREADY_BOUND');
    if (typeof reader !== 'function') fail('T03_APPLE_CYCLING_BINDING_READER_INVALID');
    bindingBound = true;
    currentBindingReader = reader;
  };

  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    fence += 1;
    closeFlight = (async () => {
      let failed = false;
      try { await adapter.close(); } catch { failed = true; }
      try { authority.close(); } catch { failed = true; }
      if (failed) fail('T03_APPLE_CYCLING_BUNDLE_CLOSE_FAILED');
    })();
    return closeFlight;
  };

  return Object.freeze({
    readCurrentAuthority: authority.readCurrentAuthority,
    formalWatchPrimaryAuthority: authority.formalWatchPrimaryAuthority,
    policy,
    activityAcceptance,
    transportDisconnection,
    recipientCredential,
    governance,
    ownerContext,
    bindCurrentBinding,
    readiness,
    close,
  });
}

export type T03AppleCyclingOwnerBundleGovernance = T03GovernanceDeviceCredentialProductionGovernance;
export type T03AppleCyclingOwnerBundleOperation = RealtimeOperation;
export const T03_APPLE_CYCLING_OWNER_BUNDLE_OPERATIONS = Object.freeze([...OPERATIONS]);
