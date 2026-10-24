import type {
  CurrentBindingLookup,
  OpaqueCanonicalRef,
  RealtimeCurrentBindingProjection,
} from '../../../services/realtime-core/src/types.ts';
import type {
  RecipientCredentialPort,
  RecipientCredentialResolution,
} from './realtime-e2ee-ciphertext-resolver.ts';
import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeGovernanceDecision,
  RealtimeGovernancePort,
  RealtimeOperation,
} from './realtime-public-control-runtime.ts';
import type { T11bT03GovernancePort } from './realtime-public-control-t11b-t02-adapter.ts';
import {
  projectT03RecipientX25519PublicKey,
  T03GovernanceDeviceCredentialRuntime,
  type T03AuthoritySnapshotPort,
  type T03RecipientX25519PublicKeyProjection,
  type T03RecipientX25519PublicKeyPort,
  type T03RealtimeBindingPort,
} from './t03-governance-device-credential-runtime.ts';
import {
  projectRealtimeExternalAliases,
  RealtimeExternalAliasError,
} from './realtime-public-control-external-alias.ts';

type Close = () => void | Promise<void>;
type Clock = () => number | string | Date;
type Closable<T extends object> = T & { readonly close?: Close };
type CurrentBindingReader = ((lookup: CurrentBindingLookup) => Promise<RealtimeCurrentBindingProjection | undefined>) & {
  readonly close?: Close;
};
type AssertAuthorizedInput = Parameters<T11bT03GovernancePort['assertAuthorized']>[0];
type AdapterOperation = AssertAuthorizedInput['operation'];

export const T03_GOVERNANCE_BRIDGE_ERROR = 'T03_GOVERNANCE_BRIDGE_REJECTED' as const;

export class T03GovernanceDeviceCredentialProductionBridgeError extends Error {
  readonly code = T03_GOVERNANCE_BRIDGE_ERROR;

  constructor() {
    super(T03_GOVERNANCE_BRIDGE_ERROR);
    this.name = 'T03GovernanceDeviceCredentialProductionBridgeError';
  }
}

export interface T03GovernanceDeviceCredentialProductionAdapterOptions {
  readonly authority?: Closable<T03AuthoritySnapshotPort>;
  readonly readCurrentBinding?: CurrentBindingReader;
  readonly recipientCredential?: RecipientCredentialPort;
  readonly now?: () => number | string | Date;
  readonly clock?: () => number | string | Date;
}

export interface T03GovernanceDeviceCredentialProductionGovernance
  extends RealtimeGovernancePort,
    T11bT03GovernancePort {}

export interface T03GovernanceDeviceCredentialProductionAdapter {
  readonly runtime: T03GovernanceDeviceCredentialRuntime;
  readonly governance: T03GovernanceDeviceCredentialProductionGovernance;
  readonly binding?: T03RealtimeBindingPort;
  readonly recipient?: T03RecipientX25519PublicKeyPort;
  readonly recipientCredential?: RecipientCredentialPort;
  readonly ports: Readonly<{
    readonly binding?: T03RealtimeBindingPort;
    readonly recipient?: T03RecipientX25519PublicKeyPort;
    readonly recipientCredential?: RecipientCredentialPort;
  }>;
  readonly close: Close;
}

const SESSION_KEYS = ['realtimeSessionRef', 'realtime_session_ref', 'sessionRef', 'session_ref', 'session'] as const;
const LEASE_KEYS = ['deviceLeaseRef', 'device_lease_ref', 'leaseRef', 'lease_ref', 'lease', 'currentDeviceLeaseRef', 'current_device_lease_ref'] as const;
const CONTINUITY_KEYS = ['continuityId', 'continuity_id', 'continuity'] as const;
const DEVICE_KEYS = ['deviceId', 'device_id'] as const;
const AUDIENCE_KEYS = ['audience', 'participantAudience', 'participant_audience'] as const;
const CREDENTIAL_KEYS = [
  'deviceCredentialRef',
  'device_credential_ref',
  'recipientDeviceCredentialRef',
  'recipient_device_credential_ref',
  'credentialRef',
  'credential_ref',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function first(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(value, key) && value[key] !== undefined) return value[key];
  }
  return undefined;
}

function present(value: unknown): boolean {
  return (typeof value === 'string' && value.length > 0) || isRecord(value);
}

function sameValue(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 32 || left === null || right === null || typeof left !== typeof right) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index], depth + 1));
  }
  const leftKeys = Object.keys(left as JsonRecord).sort();
  const rightKeys = Object.keys(right as JsonRecord).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => sameValue((left as JsonRecord)[key], (right as JsonRecord)[key], depth + 1));
}

function currentBindingLookup(request: JsonRecord): CurrentBindingLookup | undefined {
  const session = first(request, SESSION_KEYS);
  if (present(session)) return { realtimeSessionRef: session as OpaqueCanonicalRef };
  const continuity = first(request, CONTINUITY_KEYS);
  if (typeof continuity === 'string' && continuity.length > 0) return { continuityId: continuity };
  return undefined;
}

function validExpiry(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function capabilityList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return Object.freeze([...value]);
}

function lifecycleLinkage(state: unknown): {
  readonly revocation: JsonRecord;
  readonly supersession: JsonRecord | null;
  readonly deletion: JsonRecord | null;
} {
  const normalized = typeof state === 'string' ? state.toLowerCase() : '';
  return {
    revocation: { status: normalized === 'revoked' ? 'revoked' : 'active' },
    supersession: normalized === 'superseded' ? { status: 'superseded' } : null,
    deletion: normalized === 'deleted' ? { status: 'deleted' } : null,
  };
}

function aliases(binding: JsonRecord): readonly unknown[] | undefined {
  try {
    return projectRealtimeExternalAliases(binding);
  } catch (error) {
    if (error instanceof RealtimeExternalAliasError) return undefined;
    throw error;
  }
}

function projectBinding(value: RealtimeCurrentBindingProjection | undefined): JsonRecord | undefined {
  if (!isRecord(value) || !isRecord(value.session) || !isRecord(value.lease)) return undefined;
  const session = value.session;
  const lease = value.lease;
  if (!isRecord(session.binding)) return undefined;
  if (session.state !== 'active' || session.continuityState !== 'active') return undefined;
  if (!present(session.realtimeSessionRef) || !present(session.continuityId) || !present(lease.deviceLeaseRef)) return undefined;
  if (!present(session.userId) || !present(lease.userId) || !sameValue(session.userId, lease.userId)) return undefined;
  if (!validExpiry(session.continuityExpiresAt) || !validExpiry(lease.expiresAt)) return undefined;
  if (typeof session.activeDeviceId !== 'string' || typeof lease.deviceId !== 'string') return undefined;
  if (!sameValue(session.realtimeSessionRef, lease.realtimeSessionRef)) return undefined;
  if (session.continuityId !== lease.continuityId) return undefined;
  if (session.activeDeviceId !== lease.deviceId) return undefined;
  if (!present(session.activeDeviceLeaseRef) || !sameValue(session.activeDeviceLeaseRef, lease.deviceLeaseRef)) return undefined;
  if (!present(session.binding.state) || !present(session.binding.deviceId)) return undefined;
  if (session.binding.deviceId !== lease.deviceId) return undefined;
  if (!sameValue(session.binding.realtimeSessionRef, session.realtimeSessionRef)) return undefined;
  if (!sameValue(session.binding.deviceLeaseRef, lease.deviceLeaseRef)) return undefined;
  if (session.binding.continuityId !== session.continuityId || session.binding.connectionEpoch !== session.connectionEpoch) return undefined;
  const transportAliases = aliases(session.binding);
  const capabilities = capabilityList(lease.capabilities);
  if (transportAliases === undefined || capabilities === undefined) return undefined;
  if (typeof lease.purpose !== 'string' || lease.purpose.length === 0 || !present(lease.policyDecisionRef)) return undefined;
  const leaseLifecycle = lifecycleLinkage(lease.state);
  const continuityLifecycle = lifecycleLinkage(session.continuityState);
  const leaseView: JsonRecord = {
    status: lease.state,
    state: lease.state,
    device_lease_ref: lease.deviceLeaseRef,
    realtime_session_ref: lease.realtimeSessionRef,
    continuity_id: lease.continuityId,
    user_id: lease.userId,
    userId: lease.userId,
    device_id: lease.deviceId,
    capabilities,
    purpose: lease.purpose,
    policy_decision_ref: lease.policyDecisionRef,
    policyDecisionRef: lease.policyDecisionRef,
    issued_at: lease.issuedAt,
    expires_at: lease.expiresAt,
    lease_expires_at: lease.expiresAt,
    ...leaseLifecycle,
  };
  const continuityView: JsonRecord = {
    status: session.continuityState,
    state: session.continuityState,
    continuity_id: session.continuityId,
    expires_at: session.continuityExpiresAt,
    continuity_expires_at: session.continuityExpiresAt,
    ...continuityLifecycle,
  };
  return {
    status: session.binding.state,
    state: session.binding.state,
    device_id: lease.deviceId,
    deviceId: lease.deviceId,
    user_id: session.userId,
    userId: session.userId,
    capabilities,
    purpose: lease.purpose,
    policy_decision_ref: lease.policyDecisionRef,
    policyDecisionRef: lease.policyDecisionRef,
    realtime_session_ref: session.realtimeSessionRef,
    device_lease_ref: lease.deviceLeaseRef,
    current_device_lease_ref: session.activeDeviceLeaseRef,
    continuity_id: session.continuityId,
    connection_epoch: session.connectionEpoch,
    transport_aliases: transportAliases,
    expires_at: session.continuityExpiresAt,
    continuity_expires_at: session.continuityExpiresAt,
    lease_expires_at: lease.expiresAt,
    ...continuityLifecycle,
    lease: leaseView,
    continuity: continuityView,
  };
}

function publicKeyValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function credentialProjection(
  input: {
    readonly request: JsonRecord;
    readonly deviceCredentialRef: unknown;
  },
  resolution: RecipientCredentialResolution,
): JsonRecord | undefined {
  const requestedRef = input.deviceCredentialRef;
  const audience = first(input.request, AUDIENCE_KEYS);
  const session = first(input.request, SESSION_KEYS);
  const lease = first(input.request, LEASE_KEYS);
  const continuity = first(input.request, CONTINUITY_KEYS);
  const device = first(input.request, DEVICE_KEYS);
  if (!isRecord(requestedRef) || !present(audience) || !present(session) || !present(lease) || !present(continuity)) return undefined;
  if (typeof device !== 'string' || device.length === 0 || resolution.deviceId !== device) return undefined;
  if (resolution.status !== 'active' || !sameValue(resolution.credentialRef, requestedRef)) return undefined;
  if (typeof resolution.expiresAt !== 'string' || resolution.expiresAt.length === 0) return undefined;
  return {
    device_credential_ref: requestedRef,
    algorithm: 'X25519',
    purpose: 'hpke_recipient',
    public_key: publicKeyValue(resolution.publicKey),
    audience,
    device_id: device,
    realtime_session_ref: session,
    device_lease_ref: lease,
    continuity_id: continuity,
    expires_at: resolution.expiresAt,
    revocation: { status: 'active' },
    supersession: null,
    deletion: null,
  };
}

function createBindingPort(reader: CurrentBindingReader | undefined): T03RealtimeBindingPort | undefined {
  if (reader === undefined || typeof reader !== 'function') return undefined;
  return Object.freeze({
    async resolve(input: Parameters<T03RealtimeBindingPort['resolve']>[0]): Promise<unknown> {
      const lookup = currentBindingLookup(input.request);
      if (lookup === undefined) return undefined;
      try {
        return projectBinding(await reader(lookup));
      } catch {
        return undefined;
      }
    },
  });
}

function createRecipientPort(credential: RecipientCredentialPort | undefined): T03RecipientX25519PublicKeyPort | undefined {
  if (credential === undefined || credential === null || typeof credential !== 'object') return undefined;
  const resolve = credential.resolve ?? credential.get;
  if (typeof resolve !== 'function') return undefined;
  return Object.freeze({
    async resolve(input: Parameters<T03RecipientX25519PublicKeyPort['resolve']>[0]): Promise<unknown> {
      if (!isRecord(input.deviceCredentialRef)) return undefined;
      const device = first(input.request, DEVICE_KEYS);
      if (typeof device !== 'string' || device.length === 0) return undefined;
      let resolution: RecipientCredentialResolution | undefined;
      try {
        resolution = await resolve({
          request: input.request,
          deviceId: device,
          credentialRef: input.deviceCredentialRef,
        });
      } catch {
        return undefined;
      }
      const candidate = resolution === undefined ? undefined : credentialProjection(input, resolution);
      if (candidate === undefined) return undefined;
      try {
        return projectT03RecipientX25519PublicKey(candidate);
      } catch {
        return undefined;
      }
    },
  });
}

function clockTimestamp(clock: Clock): string | undefined {
  let value: number | string | Date;
  try {
    value = clock();
  } catch {
    return undefined;
  }
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : typeof value === 'string' && value.length > 0
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function createRecipientCredentialView(recipient: T03RecipientX25519PublicKeyPort | undefined, clock: Clock): RecipientCredentialPort | undefined {
  if (recipient === undefined) return undefined;
  type Input = Parameters<NonNullable<RecipientCredentialPort['resolve']>>[0];
  const resolveView = async (input: Input): Promise<RecipientCredentialResolution | undefined> => {
    if (!isRecord(input.request) || !isRecord(input.credentialRef) || typeof input.deviceId !== 'string' || input.deviceId.length === 0) return undefined;
    try {
      const atSystemTime = clockTimestamp(clock);
      if (atSystemTime === undefined) return undefined;
      const value = await recipient.resolve({
        operation: 'realtime_e2ee_key_resolve',
        request: input.request,
        bearer: { principal: input.deviceId, deviceId: input.deviceId },
        atSystemTime,
        deviceCredentialRef: input.credentialRef,
      });
      const projection: T03RecipientX25519PublicKeyProjection = projectT03RecipientX25519PublicKey(value);
      if (!isRecord(projection.deviceCredentialRef) || !sameValue(projection.deviceCredentialRef, input.credentialRef) || projection.deviceId !== input.deviceId) return undefined;
      return {
        publicKey: Buffer.from(projection.publicKey, 'base64url'),
        status: 'active',
        expiresAt: projection.expiresAt,
        deviceId: input.deviceId,
        credentialRef: projection.deviceCredentialRef,
      };
    } catch {
      return undefined;
    }
  };
  return Object.freeze({ resolve: resolveView, get: resolveView });
}

function bridgeError(): never {
  throw new T03GovernanceDeviceCredentialProductionBridgeError();
}

function createGovernance(
  runtime: T03GovernanceDeviceCredentialRuntime,
): T03GovernanceDeviceCredentialProductionGovernance {
  return Object.freeze({
    evaluate(input: {
      readonly operation: RealtimeOperation;
      readonly request: JsonRecord;
      readonly bearer: RealtimeBearerContext;
    }): Promise<RealtimeGovernanceDecision> {
      return runtime.evaluate(input);
    },
    async assertAuthorized(input: AssertAuthorizedInput): Promise<JsonRecord> {
      if (!isRecord(input) || !isRecord(input.request) || !isRecord(input.governance) || !isRecord(input.bearer)) return bridgeError();
      let decision: RealtimeGovernanceDecision;
      try {
        decision = await runtime.evaluate({
          operation: input.operation as RealtimeOperation,
          request: { ...input.request, governance: input.governance },
          bearer: input.bearer,
        });
      } catch {
        return bridgeError();
      }
      if (!decision.accepted || decision.refs === undefined) return bridgeError();
      return decision.refs;
    },
  });
}

function ownerClose(value: unknown): Close | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const close = (value as { readonly close?: unknown }).close;
  return typeof close === 'function' ? close.bind(value) as Close : undefined;
}

export function createT03GovernanceDeviceCredentialProductionAdapter(
  options: T03GovernanceDeviceCredentialProductionAdapterOptions = {},
): T03GovernanceDeviceCredentialProductionAdapter {
  const authority = options.authority !== undefined && options.authority !== null && typeof options.authority.resolve === 'function' ? options.authority : undefined;
  const binding = createBindingPort(options.readCurrentBinding);
  const recipient = createRecipientPort(options.recipientCredential);
  const clock: Clock = options.clock ?? options.now ?? (() => Date.now());
  const recipientCredential = createRecipientCredentialView(recipient, clock);
  const runtime = new T03GovernanceDeviceCredentialRuntime({
    ...(authority === undefined ? {} : { authority }),
    ...(binding === undefined ? {} : { binding }),
    ...(recipient === undefined ? {} : { recipientPublicKey: recipient }),
    clock,
  });
  const governance = createGovernance(runtime);
  const ports = Object.freeze({
    ...(binding === undefined ? {} : { binding }),
    ...(recipient === undefined ? {} : { recipient }),
    ...(recipientCredential === undefined ? {} : { recipientCredential }),
  });
  const closes = [
    ownerClose(options.authority),
    ownerClose(options.readCurrentBinding),
    ownerClose(options.recipientCredential),
  ].filter((close): close is Close => close !== undefined);
  let closeFlight: Promise<void> | undefined;
  const close: Close = () => {
    if (closeFlight !== undefined) return closeFlight;
    closeFlight = Promise.all(closes.map(async (owner) => { await owner(); })).then(() => undefined);
    return closeFlight;
  };
  return Object.freeze({
    runtime,
    governance,
    ...(binding === undefined ? {} : { binding }),
    ...(recipient === undefined ? {} : { recipient }),
    ...(recipientCredential === undefined ? {} : { recipientCredential }),
    ports,
    close,
  });
}
