import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  MediaClosureFacts,
  MediaCleanupStage,
  MediaStopPort,
  RealtimeBearerContext,
  RealtimeBootstrapAuthorityResult,
  RealtimeRefreshAuthorityResult,
  RealtimeSessionAuthorityPort,
} from './realtime-public-control-runtime.ts';
import type {
  PublicBindingProjection,
  PublicBootstrapProjection,
  PublicControlProjectionPort,
  PublicRefreshProjection,
} from '../../../services/realtime-core/src/public-control-projection.ts';
import {
  projectRealtimeExternalAliases,
  RealtimeExternalAliasError,
} from './realtime-public-control-external-alias.ts';
import {
  assertCanonicalTimestamp,
  assertDecimalCounter,
  assertDecimalConnectionEpoch,
  compareDecimalConnectionEpoch,
  snapshotOpaqueOwnerValue,
  type BootstrapRequest,
  type CanonicalTimestamp,
  type ConnectedRefreshRequest,
  type DecimalCounter,
  type HandoffRequest,
  type OpaqueGovernanceValue,
  type RealtimeTransportBinding,
  type StopReason,
  type StopRequest,
  type TerminalReceipt,
} from '../../../services/realtime-core/src/types.ts';

type JsonRecord = Record<string, unknown>;
type AdapterOperation = 'bootstrap' | 'connected_credential_refresh' | 'media_stop' | 'end_continuity' | 'handoff';
type TerminalOperation = 'media_stop' | 'end_continuity';

const STOP_REASONS = new Set<StopReason>([
  'user_stop', 'lease_expired', 'permission_revoked', 'disconnect', 'provider_failure', 'cancelled',
]);
const MEDIA_STAGES = new Set<MediaCleanupStage>([
  'tracks_unpublished', 'participant_disconnected', 'credential_revoked', 'closure_verified',
]);
const FORBIDDEN_OUTPUT_KEYS = new Set([
  'api_key', 'api_secret', 'password', 'plaintext', 'plaintext_key', 'private_key', 'key_material',
  'room_options', 'roomOptions', 'token', 'participant_token', 'delivery_receipt', 'deliveryReceipt',
]);

/** Internal readiness only. It does not issue, parse, or mint a canonical reference. */
export interface T11bCanonicalIssuerReadinessPort {
  readonly assertReady: (input: {
    readonly operation: AdapterOperation;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }) => void | boolean | Promise<void | boolean>;
  readonly close?: () => void | Promise<void>;
}

/** Owner-resolved identity and purpose; none of these values may be derived from the bearer. */
export interface T11bOwnerContext {
  readonly userId: string;
  readonly deviceId: string;
  readonly purpose: string;
  readonly capabilities: readonly string[];
  readonly occurredAt: CanonicalTimestamp;
}

export interface T11bOwnerContextPort {
  readonly resolve: (input: {
    readonly operation: AdapterOperation;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
    /** 'established': a source admitted earlier re-reads its owner (formal source). Only a new bootstrap (admission,
     *  the default) judges the start's freshness; an established source's currentness is its live session/lease. */
    readonly phase?: 'admission' | 'established';
  }) => Promise<T11bOwnerContext>;
  readonly close?: () => void | Promise<void>;
}

/** Authoritative current T11B binding. Aliases are never used to reconstruct it. */
export interface T11bCurrentBinding {
  readonly binding: RealtimeTransportBinding;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly leaseVersion?: DecimalCounter;
}

export interface T11bCurrentBindingPort {
  readonly resolve: (input: {
    readonly operation: Exclude<AdapterOperation, 'bootstrap'> | 'fully_disconnected_refresh';
    readonly request: JsonRecord;
    readonly owner: T11bOwnerContext;
    readonly governance: JsonRecord;
  }) => Promise<T11bCurrentBinding | undefined>;
  readonly close?: () => void | Promise<void>;
}

/** T11B-owned atomic handoff authority. It owns CAS, lease refs, and state transitions. */
export interface T11bHandoffAuthorityPort {
  readonly handoff: (request: HandoffRequest) => Promise<unknown>;
  readonly close?: () => void | Promise<void>;
}

export type T11bDurableHandoffClaim =
  | { readonly disposition: 'claimed'; readonly claimId: string }
  | { readonly disposition: 'replay'; readonly result: JsonRecord }
  | { readonly disposition: 'conflict' | 'in_flight' | 'indeterminate' };

/** Opaque T02 replay/output-fence seam; no local handoff state is kept here. */
export interface T11bHandoffOutputFencePort {
  readonly claim: (input: {
    readonly idempotencyContext: JsonRecord;
    readonly fingerprint: string;
    /** Opaque canonical wire request; no current binding or minted ref is read here. */
    readonly request: JsonRecord;
    readonly wireRequest?: JsonRecord;
  }) => Promise<T11bDurableHandoffClaim>;
  readonly commit: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly result: JsonRecord;
  }) => Promise<void>;
  readonly release: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
  }) => Promise<void>;
  /** Executes and verifies the old-device output suppression/closure fence. */
  readonly suppressAndClose: (input: {
    readonly request: HandoffRequest;
    readonly fingerprint: string;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }) => Promise<unknown>;
  readonly close?: () => void | Promise<void>;
}

export type T11bHandoffPort = T11bHandoffAuthorityPort;
export type T11bDurableHandoffReplayPort = T11bHandoffOutputFencePort;
export type T11bOutputFencePort = T11bHandoffOutputFencePort;

/** Optional T01-owned codec for an internal T11B HandoffResult projection. */
export interface T11bHandoffTerminalCodecPort {
  readonly encode: (input: {
    readonly wireRequest: JsonRecord;
    readonly request: HandoffRequest;
    readonly owner: T11bOwnerContext;
    readonly governance: OpaqueGovernanceValue;
    readonly authorityResult: unknown;
    readonly suppressionResult: unknown;
  }) => Promise<JsonRecord>;
  readonly close?: () => void | Promise<void>;
}

/** T03 owns the accepted governance value; the adapter only verifies and carries it. */
export interface T11bT03GovernancePort {
  readonly assertAuthorized: (input: {
    readonly operation: AdapterOperation;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }) => Promise<OpaqueGovernanceValue>;
  readonly close?: () => void | Promise<void>;
}

export interface T11bSecretFreeCloudBootstrap {
  readonly serverUrl: string;
  readonly credentialExpiresAt: CanonicalTimestamp;
  readonly terminalRoomName: string;
  readonly terminalIdentity: string;
  readonly terminalGrants: RealtimeBootstrapAuthorityResult['terminal_grants'];
  readonly mediaGrants: JsonRecord;
  readonly gateway: Omit<RealtimeBootstrapAuthorityResult['gateway'], 'token' | 'roomOptions'>;
  readonly credentialGeneration?: string;
}

export interface T11bSecretFreeCloudRefresh {
  readonly credentialExpiresAt: CanonicalTimestamp;
  readonly credentialGeneration: string;
  readonly credentialInput: RealtimeRefreshAuthorityResult['credential_input'];
}

/** Cloud-specific aliases and grants are injected, but credentials and secret values are forbidden. */
export interface T11bCloudProjectionPort {
  readonly bootstrap: (input: {
    readonly request: BootstrapRequest;
    readonly projection: PublicBootstrapProjection;
    readonly owner: T11bOwnerContext;
    readonly governance: OpaqueGovernanceValue;
  }) => Promise<T11bSecretFreeCloudBootstrap>;
  readonly connectedRefresh: (input: {
    readonly request: ConnectedRefreshRequest;
    readonly projection: PublicRefreshProjection;
    readonly owner: T11bOwnerContext;
    readonly governance: OpaqueGovernanceValue;
  }) => Promise<T11bSecretFreeCloudRefresh>;
  readonly close?: () => void | Promise<void>;
}

export interface T11bMediaStopIntent {
  readonly wireRequest: JsonRecord;
  /** Internal request may carry the owner-resolved credential generation. */
  readonly request: StopRequest & { readonly credentialGeneration?: DecimalCounter };
  readonly governance: JsonRecord;
  readonly fingerprint: string;
}

export type T11bDurableMediaStopClaim =
  | { readonly disposition: 'claimed'; readonly claimId: string }
  | { readonly disposition: 'replay'; readonly result: JsonRecord }
  | { readonly disposition: 'conflict' | 'in_flight' | 'indeterminate' };

/** T02-owned durable claim/effect seam. Intent is restored for every stage by claimId. */
export interface T11bT02ExternalEffectCoordinatorPort {
  readonly claim: (input: {
    readonly idempotencyContext: JsonRecord;
    readonly fingerprint: string;
    readonly intent: T11bMediaStopIntent;
  }) => Promise<T11bDurableMediaStopClaim>;
  readonly restore: (input: { readonly claimId: string }) => Promise<T11bMediaStopIntent | undefined>;
  readonly executeStage: (input: {
    readonly claimId: string;
    readonly stage: MediaCleanupStage;
    readonly intent: T11bMediaStopIntent;
  }) => Promise<void>;
  readonly commit: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly result: JsonRecord;
  }) => Promise<void>;
  readonly release: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
  }) => Promise<void>;
  readonly close?: () => void | Promise<void>;
}

export interface T11bTerminalCodecPort {
  readonly encode: (input: {
    readonly operation: TerminalOperation;
    readonly wireRequest: JsonRecord;
    readonly request: StopRequest;
    readonly governance: JsonRecord;
    readonly receipt: TerminalReceipt;
    readonly executionFacts?: JsonRecord;
  }) => Promise<JsonRecord>;
  readonly close?: () => void | Promise<void>;
}

export interface RealtimePublicControlT11bT02AdapterOptions {
  readonly issuerReadiness: T11bCanonicalIssuerReadinessPort;
  readonly ownerContext: T11bOwnerContextPort;
  readonly currentBinding: T11bCurrentBindingPort;
  readonly governance: T11bT03GovernancePort;
  readonly projection: PublicControlProjectionPort;
  readonly cloud: T11bCloudProjectionPort;
  readonly externalEffects: T11bT02ExternalEffectCoordinatorPort;
  readonly terminalCodec: T11bTerminalCodecPort;
  /** Optional until the handoff successor is provisioned; required to call handoff. */
  readonly handoffAuthority?: T11bHandoffAuthorityPort;
  /** Alias accepted for callers that name the T11B seam directly. */
  readonly handoff?: T11bHandoffAuthorityPort;
  readonly handoffOutputFence?: T11bHandoffOutputFencePort;
  /** Alias for the durable replay/output-fence seam. */
  readonly handoffReplay?: T11bHandoffOutputFencePort;
  readonly handoffEffects?: T11bHandoffOutputFencePort;
  readonly outputFence?: T11bHandoffOutputFencePort;
  readonly handoffTerminalCodec?: T11bHandoffTerminalCodecPort;
  readonly handoffCodec?: T11bHandoffTerminalCodecPort;
}

export interface RealtimePublicControlT11bT02Adapter {
  readonly sessions: RealtimeSessionAuthorityPort;
  readonly mediaStop: MediaStopPort;
  readonly close: () => Promise<void>;
}

export class RealtimePublicControlT11bT02AdapterError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(code);
    this.name = 'RealtimePublicControlT11bT02AdapterError';
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, status = 503): never {
  throw new RealtimePublicControlT11bT02AdapterError(code, status);
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

function canonical(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail('T11B_ADAPTER_VALUE_CYCLE');
    ancestors.add(value);
    const output = value.map((item) => canonical(item, ancestors));
    ancestors.delete(value);
    return output;
  }
  if (typeof value !== 'object') fail('T11B_ADAPTER_VALUE_INVALID');
  if (ancestors.has(value)) fail('T11B_ADAPTER_VALUE_CYCLE');
  ancestors.add(value);
  const output: JsonRecord = {};
  for (const key of Object.keys(value).sort()) output[key] = canonical((value as JsonRecord)[key], ancestors);
  ancestors.delete(value);
  return output;
}

function stable(value: unknown): string {
  const encoded = JSON.stringify(canonical(value));
  if (encoded.length === 0 || encoded.length > 262_144) fail('T11B_ADAPTER_VALUE_INVALID');
  return encoded;
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function snapshotRecord(value: unknown, code: string): JsonRecord {
  const output = canonical(record(value, code));
  return Object.freeze(output as JsonRecord);
}

function assertNoForbiddenOutput(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenOutput(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) fail('T11B_ADAPTER_SECRET_OR_RECEIPT_OUTPUT');
    assertNoForbiddenOutput(item);
  }
}

function idempotencyContext(request: JsonRecord): JsonRecord {
  const context = snapshotRecord(request.idempotency_context, 'T11B_ADAPTER_IDEMPOTENCY_CONTEXT_REQUIRED');
  const key = stringValue(context.idempotency_key, 'T11B_ADAPTER_IDEMPOTENCY_KEY_REQUIRED');
  if (request.request_id !== key) fail('T11B_ADAPTER_REQUEST_ID_BINDING_INVALID', 409);
  return context;
}

function assertGovernanceBinding(request: JsonRecord, runtimeGovernance: JsonRecord, ownerGovernance: OpaqueGovernanceValue): void {
  if (!same(request.governance, runtimeGovernance) || !same(runtimeGovernance, ownerGovernance)) {
    fail('T11B_ADAPTER_GOVERNANCE_BINDING_INVALID', 403);
  }
}

function assertOwner(
  operation: AdapterOperation,
  request: JsonRecord,
  bearer: RealtimeBearerContext,
  owner: T11bOwnerContext,
): T11bOwnerContext {
  const userId = stringValue(owner.userId, 'T11B_ADAPTER_OWNER_USER_REQUIRED');
  const deviceId = stringValue(owner.deviceId, 'T11B_ADAPTER_OWNER_DEVICE_REQUIRED');
  const purpose = stringValue(owner.purpose, 'T11B_ADAPTER_OWNER_PURPOSE_REQUIRED');
  const occurredAt = assertCanonicalTimestamp(owner.occurredAt);
  if (!Array.isArray(owner.capabilities) || owner.capabilities.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('T11B_ADAPTER_OWNER_CAPABILITIES_INVALID');
  }
  if (bearer.deviceId !== deviceId) fail('T11B_ADAPTER_OWNER_DEVICE_BINDING_INVALID', 403);
  if (operation === 'bootstrap') {
    const start = record(request.start, 'T11B_ADAPTER_START_BINDING_INVALID');
    if (request.device_id !== deviceId || start.device_id !== deviceId) {
      fail('T11B_ADAPTER_OWNER_DEVICE_BINDING_INVALID', 403);
    }
    if (start.started_at !== occurredAt) fail('T11B_ADAPTER_OCCURRED_AT_BINDING_INVALID', 403);
  }
  return Object.freeze({ userId, deviceId, purpose, capabilities: Object.freeze([...owner.capabilities]), occurredAt });
}

function projectedAliases(binding: PublicBindingProjection): readonly unknown[] {
  try {
    return projectRealtimeExternalAliases(binding);
  } catch (error) {
    if (!(error instanceof RealtimeExternalAliasError)) throw error;
    fail('T11B_ADAPTER_ALIAS_INVALID', 409);
  }
}

function bindingProjection(binding: RealtimeTransportBinding): PublicBindingProjection {
  return Object.freeze({
    realtimeSessionRef: snapshotOpaqueOwnerValue(binding.realtimeSessionRef),
    deviceLeaseRef: snapshotOpaqueOwnerValue(binding.deviceLeaseRef),
    continuityId: stringValue(binding.continuityId, 'T11B_ADAPTER_CONTINUITY_REQUIRED'),
    connectionEpoch: assertDecimalConnectionEpoch(binding.connectionEpoch),
    transportSessionAlias: snapshotOpaqueOwnerValue(binding.transportSessionAlias),
    roomAlias: snapshotOpaqueOwnerValue(binding.roomAlias),
    deviceAlias: snapshotOpaqueOwnerValue(binding.deviceAlias),
    provider: snapshotOpaqueOwnerValue(binding.provider),
    connectionId: stringValue(binding.connectionId, 'T11B_ADAPTER_CONNECTION_ID_REQUIRED'),
  });
}

function realtimeBinding(projected: PublicBindingProjection, deviceId: string): RealtimeTransportBinding {
  return Object.freeze({
    state: 'connected',
    realtimeSessionRef: snapshotOpaqueOwnerValue(projected.realtimeSessionRef),
    deviceLeaseRef: snapshotOpaqueOwnerValue(projected.deviceLeaseRef),
    continuityId: stringValue(projected.continuityId, 'T11B_ADAPTER_CONTINUITY_REQUIRED'),
    deviceId,
    connectionEpoch: assertDecimalConnectionEpoch(projected.connectionEpoch),
    provider: snapshotOpaqueOwnerValue(projected.provider),
    transportSessionAlias: snapshotOpaqueOwnerValue(projected.transportSessionAlias),
    roomAlias: snapshotOpaqueOwnerValue(projected.roomAlias),
    deviceAlias: snapshotOpaqueOwnerValue(projected.deviceAlias),
    connectionId: stringValue(projected.connectionId, 'T11B_ADAPTER_CONNECTION_ID_REQUIRED'),
  });
}

function assertCurrentBinding(
  request: JsonRecord,
  current: T11bCurrentBinding,
  owner: T11bOwnerContext,
  profile: 'fully_disconnected_refresh' | 'connected_credential_refresh' | 'media_stop' | 'end_continuity' | 'handoff',
): T11bCurrentBinding {
  const state = current.binding.state;
  const stateAccepted = profile === 'connected_credential_refresh'
    ? state === 'connected'
    : profile === 'handoff'
      ? state === 'connected'
    : profile === 'fully_disconnected_refresh'
      ? state === 'connected' || state === 'disconnected'
      // Ending is idempotent: a stop retried after its first attempt released the lease still completes.
      : state === 'connected' || state === 'disconnected' || state === 'released';
  if (!stateAccepted || current.binding.deviceId !== owner.deviceId) {
    fail('T11B_ADAPTER_CURRENT_BINDING_INVALID', 409);
  }
  const projected = bindingProjection(current.binding);
  const aliases = projectedAliases(projected);
  const required = profile === 'fully_disconnected_refresh'
    ? [['continuity_id', projected.continuityId], ['transport_aliases', aliases]] as const
    : profile === 'connected_credential_refresh'
      ? [
        ['realtime_session_ref', projected.realtimeSessionRef], ['device_lease_ref', projected.deviceLeaseRef],
        ['continuity_id', projected.continuityId], ['connection_epoch', projected.connectionEpoch],
        ['transport_aliases', aliases],
      ] as const
      : profile === 'media_stop'
        ? [
          ['realtime_session_ref', projected.realtimeSessionRef], ['device_lease_ref', projected.deviceLeaseRef],
          ['continuity_id', projected.continuityId], ['connection_epoch', projected.connectionEpoch],
        ] as const
        : profile === 'handoff'
          ? [
            ['realtime_session_ref', projected.realtimeSessionRef], ['current_device_lease_ref', projected.deviceLeaseRef],
            ['continuity_id', projected.continuityId], ['connection_epoch', projected.connectionEpoch],
          ] as const
        : [
          ['realtime_session_ref', projected.realtimeSessionRef], ['continuity_id', projected.continuityId],
          ['connection_epoch', projected.connectionEpoch],
        ] as const;
  for (const [wire, actual] of required) {
    if (!same(request[wire], actual)) fail('T11B_ADAPTER_CURRENT_BINDING_MISMATCH', 409);
  }
  if (profile === 'media_stop' && Object.hasOwn(request, 'transport_aliases') &&
      !same(request.transport_aliases, aliases)) fail('T11B_ADAPTER_CURRENT_BINDING_MISMATCH', 409);
  assertCanonicalTimestamp(current.continuityExpiresAt);
  return current;
}

function assertSameBinding(projected: PublicBindingProjection, current: RealtimeTransportBinding): void {
  if (!same(projected, bindingProjection(current))) fail('T11B_ADAPTER_REFRESH_BINDING_CHANGED', 409);
}

function assertFullyDisconnectedTransition(
  projected: PublicBootstrapProjection,
  current: T11bCurrentBinding,
): void {
  const next = projected.binding;
  const previous = bindingProjection(current.binding);
  if (next.continuityId !== previous.continuityId || same(next.realtimeSessionRef, previous.realtimeSessionRef) ||
      same(next.deviceLeaseRef, previous.deviceLeaseRef)) fail('T11B_ADAPTER_DISCONNECTED_BINDING_INVALID', 409);
  const nextEpoch = assertDecimalConnectionEpoch(next.connectionEpoch);
  const previousEpoch = assertDecimalConnectionEpoch(previous.connectionEpoch);
  if (compareDecimalConnectionEpoch(nextEpoch, previousEpoch) <= 0) fail('T11B_ADAPTER_EPOCH_NOT_ADVANCED', 409);
  const oldAliases = projectedAliases(previous).map(stable);
  const newAliases = projectedAliases(next).map(stable);
  if (new Set(oldAliases).size !== oldAliases.length || new Set(newAliases).size !== newAliases.length ||
      newAliases.some((alias) => oldAliases.includes(alias))) fail('T11B_ADAPTER_ALIAS_NOT_ROTATED', 409);
  const previousDeadline = Date.parse(current.continuityExpiresAt);
  const nextDeadline = Date.parse(assertCanonicalTimestamp(projected.continuityExpiresAt));
  if (!Number.isSafeInteger(previousDeadline) || !Number.isSafeInteger(nextDeadline) || nextDeadline > previousDeadline) {
    fail('T11B_ADAPTER_CONTINUITY_DEADLINE_EXTENDED', 409);
  }
}

function assertCredentialExpiry(credential: unknown, continuity: unknown, lease: unknown): CanonicalTimestamp {
  const credentialAt = assertCanonicalTimestamp(credential);
  const continuityAt = assertCanonicalTimestamp(continuity);
  const leaseAt = assertCanonicalTimestamp(lease);
  const credentialMs = Date.parse(credentialAt);
  if (credentialMs > Date.parse(continuityAt) || credentialMs > Date.parse(leaseAt)) {
    fail('T11B_ADAPTER_CREDENTIAL_DEADLINE_INVALID');
  }
  return credentialAt;
}

function assertCloudBootstrap(value: T11bSecretFreeCloudBootstrap, projection: PublicBootstrapProjection): T11bSecretFreeCloudBootstrap {
  assertNoForbiddenOutput(value);
  stringValue(value.serverUrl, 'T11B_ADAPTER_CLOUD_URL_REQUIRED');
  stringValue(value.terminalRoomName, 'T11B_ADAPTER_CLOUD_ROOM_REQUIRED');
  stringValue(value.terminalIdentity, 'T11B_ADAPTER_CLOUD_IDENTITY_REQUIRED');
  assertCredentialExpiry(value.credentialExpiresAt, projection.continuityExpiresAt, projection.leaseExpiresAt);
  record(value.terminalGrants, 'T11B_ADAPTER_CLOUD_GRANTS_INVALID');
  record(value.mediaGrants, 'T11B_ADAPTER_MEDIA_GRANTS_INVALID');
  const gateway = record(value.gateway, 'T11B_ADAPTER_GATEWAY_INVALID');
  stringValue(gateway.roomName, 'T11B_ADAPTER_GATEWAY_ROOM_REQUIRED');
  stringValue(gateway.identity, 'T11B_ADAPTER_GATEWAY_IDENTITY_REQUIRED');
  record(gateway.grants, 'T11B_ADAPTER_GATEWAY_GRANTS_INVALID');
  return value;
}

function assertCloudRefresh(value: T11bSecretFreeCloudRefresh, projection: PublicRefreshProjection): T11bSecretFreeCloudRefresh {
  assertNoForbiddenOutput(value);
  assertCredentialExpiry(value.credentialExpiresAt, projection.continuityExpiresAt, projection.leaseExpiresAt);
  if (!/^[1-9][0-9]{0,37}$/u.test(value.credentialGeneration)) fail('T11B_ADAPTER_CREDENTIAL_GENERATION_INVALID');
  const input = record(value.credentialInput, 'T11B_ADAPTER_CREDENTIAL_INPUT_INVALID');
  stringValue(input.room, 'T11B_ADAPTER_CREDENTIAL_ROOM_REQUIRED');
  stringValue(input.identity, 'T11B_ADAPTER_CREDENTIAL_IDENTITY_REQUIRED');
  record(input.grants, 'T11B_ADAPTER_CREDENTIAL_GRANTS_REQUIRED');
  return value;
}

function stopReason(value: unknown): StopReason {
  if (!STOP_REASONS.has(value as StopReason)) fail('T11B_ADAPTER_STOP_REASON_INVALID', 422);
  return value as StopReason;
}

function buildStopRequest(
  wire: JsonRecord,
  operation: TerminalOperation,
  owner: T11bOwnerContext,
  current: T11bCurrentBinding,
  governance: OpaqueGovernanceValue,
): StopRequest & { readonly credentialGeneration?: DecimalCounter } {
  const context = idempotencyContext(wire);
  assertCurrentBinding(wire, current, owner, operation);
  if (operation === 'media_stop' && wire.device_lease_ref === undefined) fail('T11B_ADAPTER_MEDIA_STOP_LEASE_REQUIRED', 422);
  if (wire.expected_lease_version !== undefined && wire.expected_lease_version !== current.leaseVersion) {
    fail('T11B_ADAPTER_LEASE_VERSION_MISMATCH', 409);
  }
  const credentialGeneration = operation === 'media_stop' && current.leaseVersion !== undefined
    ? assertDecimalCounter(current.leaseVersion)
    : undefined;
  return Object.freeze({
    requestId: stringValue(wire.request_id, 'T11B_ADAPTER_REQUEST_ID_REQUIRED'),
    idempotencyKey: stringValue(context.idempotency_key, 'T11B_ADAPTER_IDEMPOTENCY_KEY_REQUIRED'),
    operation,
    realtimeSessionRef: snapshotOpaqueOwnerValue(current.binding.realtimeSessionRef),
    continuityId: current.binding.continuityId,
    deviceLeaseRef: snapshotOpaqueOwnerValue(current.binding.deviceLeaseRef),
    deviceId: owner.deviceId,
    expectedConnectionEpoch: assertDecimalConnectionEpoch(current.binding.connectionEpoch),
    ...(current.leaseVersion === undefined ? {} : { expectedLeaseVersion: current.leaseVersion }),
    ...(credentialGeneration === undefined ? {} : { credentialGeneration }),
    reason: operation === 'media_stop'
      ? stopReason(wire.reason)
      : wire.confirmation === 'explicit_user_end_continuity'
        ? 'user_stop'
        : fail('T11B_ADAPTER_END_CONFIRMATION_INVALID', 422),
    occurredAt: owner.occurredAt,
    governance,
  });
}

function buildHandoffRequest(
  wire: JsonRecord,
  owner: T11bOwnerContext,
  current: T11bCurrentBinding,
  governance: OpaqueGovernanceValue,
): HandoffRequest {
  assertCurrentBinding(wire, current, owner, 'handoff');
  const expectedLeaseVersion = current.leaseVersion;
  if (expectedLeaseVersion === undefined || wire.expected_lease_version !== expectedLeaseVersion) {
    fail('T11B_ADAPTER_HANDOFF_LEASE_VERSION_MISMATCH', 409);
  }
  if (wire.from_device_id !== owner.deviceId) fail('T11B_ADAPTER_HANDOFF_FROM_DEVICE_MISMATCH', 403);
  const toDeviceId = stringValue(wire.to_device_id, 'T11B_ADAPTER_HANDOFF_TO_DEVICE_REQUIRED');
  if (toDeviceId === owner.deviceId) fail('T11B_ADAPTER_HANDOFF_DEVICE_UNCHANGED', 409);
  const context = idempotencyContext(wire);
  return Object.freeze({
    requestId: stringValue(wire.request_id, 'T11B_ADAPTER_REQUEST_ID_REQUIRED'),
    idempotencyKey: stringValue(context.idempotency_key, 'T11B_ADAPTER_IDEMPOTENCY_KEY_REQUIRED'),
    realtimeSessionRef: snapshotOpaqueOwnerValue(current.binding.realtimeSessionRef),
    continuityId: current.binding.continuityId,
    fromDeviceId: owner.deviceId,
    toDeviceId,
    expectedConnectionEpoch: assertDecimalConnectionEpoch(current.binding.connectionEpoch),
    expectedLeaseVersion,
    occurredAt: owner.occurredAt,
    governance,
  });
}

type HandoffBindingView = Pick<
  HandoffRequest,
  'realtimeSessionRef' | 'continuityId' | 'fromDeviceId' | 'toDeviceId' | 'expectedConnectionEpoch'
>;

/** Replay validation binds only to the original wire, never to a current owner snapshot. */
function handoffBindingFromWire(wire: JsonRecord): HandoffBindingView {
  return Object.freeze({
    realtimeSessionRef: snapshotOpaqueOwnerValue(wire.realtime_session_ref),
    continuityId: stringValue(wire.continuity_id, 'T11B_ADAPTER_HANDOFF_CONTINUITY_REQUIRED'),
    fromDeviceId: stringValue(wire.from_device_id, 'T11B_ADAPTER_HANDOFF_FROM_DEVICE_REQUIRED'),
    toDeviceId: stringValue(wire.to_device_id, 'T11B_ADAPTER_HANDOFF_TO_DEVICE_REQUIRED'),
    expectedConnectionEpoch: assertDecimalConnectionEpoch(wire.connection_epoch),
  });
}

function validateReceipt(receipt: TerminalReceipt, request: StopRequest): void {
  if (receipt.kind !== 'realtime_terminal_receipt' || receipt.operation !== request.operation ||
      receipt.requestId !== request.requestId || receipt.idempotencyKey !== request.idempotencyKey ||
      !same(receipt.realtimeSessionRef, request.realtimeSessionRef) || receipt.continuityId !== request.continuityId ||
      receipt.connectionEpoch !== request.expectedConnectionEpoch ||
      (request.deviceLeaseRef !== undefined && !same(receipt.deviceLeaseRef, request.deviceLeaseRef))) {
    fail('T11B_ADAPTER_RECEIPT_BINDING_INVALID');
  }
}

const TERMINAL_RESULT_SCHEMA_BYTES = readFileSync(new URL('../../../contracts/json-schema/realtime/realtime-terminal-result.v1.schema.json', import.meta.url));
const TERMINAL_RESULT_SCHEMA = Object.freeze({
  id: String((JSON.parse(TERMINAL_RESULT_SCHEMA_BYTES.toString('utf8')) as JsonRecord).$id),
  sha256: createHash('sha256').update(TERMINAL_RESULT_SCHEMA_BYTES).digest('hex'),
});

/**
 * T02 commits stop/end as a durable terminal receipt; T11B owns the public request it answers. A successful receipt
 * becomes a committed outcome whose recorded-result reference binds the wire idempotency context to that receipt
 * (replay flag excluded, so a replay references the same record). Non-success receipts carry no derived outcome.
 */
function withCommittedOutcome(receipt: TerminalReceipt, wire: JsonRecord): TerminalReceipt & { readonly operationOutcome?: JsonRecord } {
  if (receipt.status !== 'success') return receipt;
  const { replayed: _replayed, ...recorded } = receipt;
  return Object.freeze({ ...receipt, operationOutcome: Object.freeze({
    outcome_class: 'committed_success', resolution_mode: 'direct',
    recorded_result_ref: Object.freeze({
      idempotency_context: idempotencyContext(wire), fencing_epoch: receipt.connectionEpoch, outcome_class: 'committed_success',
      result_schema_id: TERMINAL_RESULT_SCHEMA.id, result_schema_version: '1.0.0', result_schema_sha256: TERMINAL_RESULT_SCHEMA.sha256,
      result_payload_sha256: createHash('sha256').update(stable(recorded)).digest('hex'),
    }),
  }) });
}

function executionFacts(receipt: TerminalReceipt, facts: MediaClosureFacts): JsonRecord {
  const completed = new Set<MediaCleanupStage>();
  for (const stage of facts.completedStages) {
    if (!MEDIA_STAGES.has(stage) || completed.has(stage)) fail('T11B_ADAPTER_CLEANUP_FACTS_INVALID');
    completed.add(stage);
  }
  const failed = new Set<MediaCleanupStage>();
  for (const failure of facts.failedStages) {
    if (!MEDIA_STAGES.has(failure.stage) || failed.has(failure.stage) || completed.has(failure.stage) ||
        !/^[A-Z][A-Z0-9_]{0,95}$/u.test(failure.code)) fail('T11B_ADAPTER_CLEANUP_FACTS_INVALID');
    failed.add(failure.stage);
  }
  const stageFact = (stage: MediaCleanupStage): 'verified_absent' | 'failed' | 'indeterminate' =>
    completed.has(stage) ? 'verified_absent' : failed.has(stage) ? 'failed' : 'indeterminate';
  const closureVerified = completed.has('closure_verified') && failed.size === 0 &&
    ['tracks_unpublished', 'participant_disconnected', 'credential_revoked'].every((stage) => completed.has(stage as MediaCleanupStage));
  const leaseRelease = receipt.status === 'success'
    ? (receipt.outcome === 'already_released' ? 'already_released' : 'released')
    : receipt.status === 'indeterminate' ? 'indeterminate' : 'failed';
  return Object.freeze({
    closure_status: closureVerified ? 'verified_closed' : failed.size === 0 ? 'indeterminate' : 'failed',
    device_lease_release: leaseRelease,
    participant_cleanup: stageFact('participant_disconnected'),
    track_cleanup: stageFact('tracks_unpublished'),
    room_cleanup: stageFact('closure_verified'),
  });
}

function validateTerminal(result: JsonRecord, wire: JsonRecord, operation: TerminalOperation, facts?: JsonRecord): JsonRecord {
  assertNoForbiddenOutput(result);
  if (Object.hasOwn(result, 'idempotency_context') || result.operation !== operation || result.request_id !== wire.request_id ||
      !same(result.realtime_session_ref, wire.realtime_session_ref) ||
      !same(result.continuity_id, wire.continuity_id) ||
      !same(result.connection_epoch, wire.connection_epoch) || !same(result.governance, wire.governance)) {
    fail('T11B_ADAPTER_TERMINAL_BINDING_INVALID');
  }
  if (wire.device_lease_ref !== undefined && !same(result.device_lease_ref, wire.device_lease_ref)) {
    fail('T11B_ADAPTER_TERMINAL_BINDING_INVALID');
  }
  const outcome = record(result.operation_outcome, 'T11B_ADAPTER_TERMINAL_OUTCOME_INVALID');
  if (outcome.outcome_class === 'committed_success' || outcome.outcome_class === 'committed_rejection') {
    const recorded = record(outcome.recorded_result_ref, 'T11B_ADAPTER_TERMINAL_RRR_REQUIRED');
    if (!same(recorded.idempotency_context, wire.idempotency_context)) {
      fail('T11B_ADAPTER_TERMINAL_RRR_BINDING_INVALID');
    }
  } else if (Object.hasOwn(outcome, 'recorded_result_ref')) {
    fail('T11B_ADAPTER_TERMINAL_RRR_FORBIDDEN');
  }
  if (operation === 'media_stop' && result.status === 'success') {
    if (facts === undefined || facts.closure_status !== 'verified_closed' ||
        !['released', 'already_released'].includes(String(facts.device_lease_release)) ||
        facts.participant_cleanup !== 'verified_absent' || facts.track_cleanup !== 'verified_absent' ||
        facts.room_cleanup !== 'verified_absent' || !same(result.execution_facts, facts)) {
      fail('T11B_ADAPTER_FALSE_SUCCESS');
    }
  }
  return Object.freeze(result);
}

function assertHandoffResultReference(outcome: JsonRecord, wire: JsonRecord, expected: 'committed_success' | 'committed_rejection'): void {
  if (outcome.outcome_class !== expected) fail('T11B_ADAPTER_HANDOFF_OUTCOME_INVALID');
  const recorded = record(outcome.recorded_result_ref, 'T11B_ADAPTER_HANDOFF_RRR_REQUIRED');
  if (!same(recorded.idempotency_context, wire.idempotency_context) ||
      typeof recorded.fencing_epoch !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(recorded.fencing_epoch) ||
      recorded.outcome_class !== expected) fail('T11B_ADAPTER_HANDOFF_RRR_BINDING_INVALID');
  for (const key of ['result_schema_id', 'result_schema_version', 'result_schema_sha256', 'result_payload_sha256'] as const) {
    if (typeof recorded[key] !== 'string' || recorded[key].length === 0) fail('T11B_ADAPTER_HANDOFF_RRR_INVALID');
  }
}

function assertHandoffFence(result: JsonRecord, wire: JsonRecord): void {
  const fence = record(result.old_device_suppression_fence, 'T11B_ADAPTER_HANDOFF_OUTPUT_FENCE_INVALID');
  const allowed = new Set([
    'from_device_id', 'previous_device_lease_ref', 'new_device_lease_ref',
    'connection_epoch', 'fencing_token', 'state',
  ]);
  if (Object.keys(fence).some((key) => !allowed.has(key)) ||
      fence.from_device_id !== wire.from_device_id ||
      !same(fence.previous_device_lease_ref, wire.current_device_lease_ref) ||
      !same(fence.new_device_lease_ref, result.device_lease_ref) ||
      fence.connection_epoch !== wire.connection_epoch ||
      fence.fencing_token !== result.fencing_token || fence.state !== 'old_device_suppressed' ||
      typeof fence.fencing_token !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(fence.fencing_token)) {
    fail('T11B_ADAPTER_HANDOFF_OUTPUT_FENCE_INVALID');
  }
}

type HandoffSuppressionFacts = {
  readonly fence: JsonRecord;
  readonly closureStatus: 'verified_closed';
  readonly evidenceRefs: readonly unknown[];
};

function firstField(value: JsonRecord, names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(value, name)) return value[name];
  }
  return undefined;
}

/** The suppression owner returns opaque facts; only these bindings are admitted into success. */
function validateHandoffSuppression(
  value: unknown,
  wire: JsonRecord,
): HandoffSuppressionFacts {
  const suppression = record(value, 'T11B_ADAPTER_HANDOFF_SUPPRESSION_INVALID');
  const fence = record(firstField(suppression, [
    'old_device_suppression_fence', 'oldDeviceSuppressionFence', 'fence', 'output_fence',
  ]), 'T11B_ADAPTER_HANDOFF_SUPPRESSION_FENCE_INVALID');
  const state = firstField(suppression, ['state', 'suppression_state', 'suppressionState']) ?? fence.state;
  const closureStatus = firstField(suppression, ['closure_status', 'closureStatus', 'closure']);
  const evidenceRefs = firstField(suppression, ['evidence_refs', 'evidenceRefs']);
  if (state !== 'old_device_suppressed' || closureStatus !== 'verified_closed' ||
      !Array.isArray(evidenceRefs) || evidenceRefs.length === 0 ||
      fence.from_device_id !== wire.from_device_id ||
      !same(fence.previous_device_lease_ref, wire.current_device_lease_ref) ||
      fence.connection_epoch !== wire.connection_epoch ||
      fence.state !== 'old_device_suppressed' ||
      typeof fence.fencing_token !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(fence.fencing_token) ||
      fence.new_device_lease_ref === undefined) {
    fail('T11B_ADAPTER_HANDOFF_SUPPRESSION_INDETERMINATE');
  }
  return Object.freeze({
    fence: snapshotRecord(fence, 'T11B_ADAPTER_HANDOFF_SUPPRESSION_FENCE_INVALID'),
    closureStatus: 'verified_closed',
    evidenceRefs,
  });
}

/** Validates the T01 terminal bytes returned by the injected handoff owner. */
function validateHandoffTerminal(
  result: JsonRecord,
  wire: JsonRecord,
  request: HandoffBindingView,
  suppression: HandoffSuppressionFacts | undefined = undefined,
  replayed = false,
): JsonRecord {
  assertNoForbiddenOutput(result);
  if (Object.hasOwn(result, 'idempotency_context') || result.operation !== 'handoff' ||
      result.request_id !== wire.request_id || !same(result.realtime_session_ref, request.realtimeSessionRef) ||
      result.continuity_id !== request.continuityId || result.connection_epoch !== request.expectedConnectionEpoch ||
      result.from_device_id !== request.fromDeviceId || result.to_device_id !== request.toDeviceId ||
      !same(result.previous_device_lease_ref, wire.current_device_lease_ref) || !same(result.governance, wire.governance)) {
    fail('T11B_ADAPTER_HANDOFF_TERMINAL_BINDING_INVALID');
  }
  const outcome = record(result.operation_outcome, 'T11B_ADAPTER_HANDOFF_OUTCOME_INVALID');
  const facts = record(result.execution_facts, 'T11B_ADAPTER_HANDOFF_FACTS_INVALID');
  if (!['not_applicable', 'verified_closed', 'failed', 'indeterminate'].includes(String(facts.closure_status))) {
    fail('T11B_ADAPTER_HANDOFF_FACTS_INVALID');
  }
  if (result.status === 'success') {
    if (outcome.outcome_class !== 'committed_success' || facts.closure_status !== 'verified_closed' ||
        facts.device_lease_release !== 'released' || !Array.isArray(facts.evidence_refs) || facts.evidence_refs.length === 0 ||
        (facts.participant_cleanup !== undefined && facts.participant_cleanup !== 'verified_absent') ||
        (facts.track_cleanup !== undefined && facts.track_cleanup !== 'verified_absent') ||
        (facts.room_cleanup !== undefined && facts.room_cleanup !== 'verified_absent') ||
        result.device_lease_ref === undefined || same(result.device_lease_ref, wire.current_device_lease_ref) ||
        (!replayed && suppression === undefined) ||
        (suppression !== undefined && (suppression.closureStatus !== 'verified_closed' ||
          !same(result.old_device_suppression_fence, suppression.fence) ||
          !same(facts.evidence_refs, suppression.evidenceRefs)))) {
      fail('T11B_ADAPTER_HANDOFF_FALSE_SUCCESS');
    }
    if (typeof result.lease_version !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(result.lease_version) ||
        typeof result.fencing_token !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(result.fencing_token)) {
      fail('T11B_ADAPTER_HANDOFF_LEASE_FACTS_INVALID');
    }
    assertHandoffFence(result, wire);
    assertHandoffResultReference(outcome, wire, 'committed_success');
    const recorded = record(outcome.recorded_result_ref, 'T11B_ADAPTER_HANDOFF_RRR_REQUIRED');
    if (recorded.fencing_epoch !== result.fencing_token) fail('T11B_ADAPTER_HANDOFF_RRR_FENCE_INVALID');
  } else if (result.status === 'indeterminate') {
    if (outcome.outcome_class !== 'indeterminate' || outcome.recorded_result_ref !== undefined) {
      fail('T11B_ADAPTER_HANDOFF_INDETERMINATE_PROMOTION');
    }
    const error = record(outcome.error, 'T11B_ADAPTER_HANDOFF_OUTCOME_INVALID');
    if (error.retry_class !== 'never') fail('T11B_ADAPTER_HANDOFF_OUTCOME_INVALID');
    if (result.old_device_suppression_fence !== undefined && result.device_lease_ref !== undefined) {
      assertHandoffFence(result, wire);
    }
  } else {
    if (outcome.outcome_class === 'committed_success') fail('T11B_ADAPTER_HANDOFF_OUTCOME_INVALID');
    if (outcome.outcome_class === 'committed_rejection') assertHandoffResultReference(outcome, wire, 'committed_rejection');
  }
  return Object.freeze(result);
}

function requireMethod(value: unknown, method: string, code: string): void {
  if (value === null || typeof value !== 'object' || typeof (value as JsonRecord)[method] !== 'function') fail(code);
}

class Adapter implements RealtimeSessionAuthorityPort, MediaStopPort {
  readonly publicOperationEffectBoundary='v1' as const;
  readonly #options: RealtimePublicControlT11bT02AdapterOptions;
  #closed = false;
  #fence = 0;
  #closeFlight?: Promise<void>;

  constructor(options: RealtimePublicControlT11bT02AdapterOptions) {
    this.#options = options;
  }

  #begin(): number {
    if (this.#closed) fail('T11B_ADAPTER_CLOSED');
    return this.#fence;
  }

  #assertFence(fence: number): void {
    if (this.#closed || this.#fence !== fence) fail('T11B_ADAPTER_LATE_COMPLETION_FENCED');
  }

  async #preflight(
    operation: AdapterOperation,
    request: JsonRecord,
    bearer: RealtimeBearerContext,
    governance: JsonRecord,
    fence: number,
  ): Promise<{ readonly owner: T11bOwnerContext; readonly governance: OpaqueGovernanceValue }> {
    idempotencyContext(request);
    const readiness = await this.#options.issuerReadiness.assertReady({ operation, request, bearer, governance });
    this.#assertFence(fence);
    if (readiness === false) fail('T11B_ADAPTER_CANONICAL_ISSUER_NOT_READY');
    const ownerGovernance = await this.#options.governance.assertAuthorized({ operation, request, bearer, governance });
    this.#assertFence(fence);
    assertGovernanceBinding(request, governance, ownerGovernance);
    const owner = assertOwner(
      operation,
      request,
      bearer,
      await this.#options.ownerContext.resolve({ operation, request, bearer, governance }),
    );
    this.#assertFence(fence);
    return { owner, governance: snapshotOpaqueOwnerValue(ownerGovernance) };
  }

  async bootstrap(input: { readonly effectStarted?:()=>void; readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }): Promise<RealtimeBootstrapAuthorityResult> {
    const fence = this.#begin();
    const wire = snapshotRecord(input.request, 'T11B_ADAPTER_BOOTSTRAP_REQUEST_INVALID');
    const mode = wire.bootstrap_mode;
    if (mode !== 'initial' && mode !== 'fully_disconnected') fail('T11B_ADAPTER_BOOTSTRAP_MODE_INVALID', 422);
    const preflight = await this.#preflight('bootstrap', wire, input.bearer, input.governance, fence);
    const context = idempotencyContext(wire);
    let current: T11bCurrentBinding | undefined;
    if (mode === 'fully_disconnected') {
      current = await this.#options.currentBinding.resolve({
        operation: 'fully_disconnected_refresh', request: wire, owner: preflight.owner, governance: input.governance,
      });
      this.#assertFence(fence);
      if (current === undefined) fail('T11B_ADAPTER_CURRENT_BINDING_REQUIRED', 409);
      assertCurrentBinding(wire, current, preflight.owner, 'fully_disconnected_refresh');
    } else if (wire.continuity_id !== undefined || wire.realtime_session_ref !== undefined || wire.device_lease_ref !== undefined) {
      fail('T11B_ADAPTER_INITIAL_BINDING_FORBIDDEN', 422);
    }
    const command: BootstrapRequest = Object.freeze({
      requestId: stringValue(wire.request_id, 'T11B_ADAPTER_REQUEST_ID_REQUIRED'),
      idempotencyKey: stringValue(context.idempotency_key, 'T11B_ADAPTER_IDEMPOTENCY_KEY_REQUIRED'),
      mode,
      userId: preflight.owner.userId,
      deviceId: preflight.owner.deviceId,
      ...(current === undefined ? {} : {
        continuityId: current.binding.continuityId,
        existingSessionRef: snapshotOpaqueOwnerValue(current.binding.realtimeSessionRef),
        existingBinding: current.binding,
      }),
      capabilities: preflight.owner.capabilities,
      purpose: preflight.owner.purpose,
      occurredAt: preflight.owner.occurredAt,
      governance: preflight.governance,
    });
    input.effectStarted?.();
    const projected = mode === 'initial'
      ? await this.#options.projection.bootstrap(command)
      : await this.#options.projection.fullyDisconnectedRefresh(command);
    this.#assertFence(fence);
    if (current !== undefined) assertFullyDisconnectedTransition(projected, current);
    const cloud = assertCloudBootstrap(await this.#options.cloud.bootstrap({
      request: command, projection: projected, owner: preflight.owner, governance: preflight.governance,
    }), projected);
    this.#assertFence(fence);
    const aliases = projectedAliases(projected.binding);
    const result: RealtimeBootstrapAuthorityResult = {
      realtime_session_ref: snapshotOpaqueOwnerValue(projected.binding.realtimeSessionRef),
      device_lease_ref: snapshotOpaqueOwnerValue(projected.binding.deviceLeaseRef),
      continuity_id: projected.binding.continuityId,
      transport_aliases: aliases,
      connection_epoch: assertDecimalConnectionEpoch(projected.binding.connectionEpoch),
      server_url: cloud.serverUrl,
      credential_expires_at: cloud.credentialExpiresAt,
      continuity_expires_at: assertCanonicalTimestamp(projected.continuityExpiresAt),
      terminal_room_name: cloud.terminalRoomName,
      terminal_identity: cloud.terminalIdentity,
      terminal_grants: cloud.terminalGrants,
      media_grants: snapshotRecord(cloud.mediaGrants, 'T11B_ADAPTER_MEDIA_GRANTS_INVALID'),
      governance: snapshotRecord(input.governance, 'T11B_ADAPTER_GOVERNANCE_INVALID'),
      gateway: Object.freeze({ roomName: cloud.gateway.roomName, identity: cloud.gateway.identity, grants: cloud.gateway.grants }),
      ...(cloud.credentialGeneration === undefined ? {} : { credential_generation: cloud.credentialGeneration }),
      ...(current === undefined ? {} : {
        binding_transition: Object.freeze({
          atomic: true as const,
          previous_connection_epoch: current.binding.connectionEpoch,
          previous_realtime_session_ref: snapshotOpaqueOwnerValue(current.binding.realtimeSessionRef),
          previous_device_lease_ref: snapshotOpaqueOwnerValue(current.binding.deviceLeaseRef),
          previous_transport_aliases: projectedAliases(bindingProjection(current.binding)),
          previous_continuity_expires_at: assertCanonicalTimestamp(current.continuityExpiresAt),
          provider_session_reused: false as const,
        }),
      }),
    };
    assertNoForbiddenOutput(result);
    return Object.freeze(result);
  }

  async refresh(input: { readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }): Promise<RealtimeRefreshAuthorityResult> {
    const fence = this.#begin();
    const wire = snapshotRecord(input.request, 'T11B_ADAPTER_REFRESH_REQUEST_INVALID');
    const preflight = await this.#preflight('connected_credential_refresh', wire, input.bearer, input.governance, fence);
    const current = await this.#options.currentBinding.resolve({
      operation: 'connected_credential_refresh', request: wire, owner: preflight.owner, governance: input.governance,
    });
    this.#assertFence(fence);
    if (current === undefined) fail('T11B_ADAPTER_CURRENT_BINDING_REQUIRED', 409);
    assertCurrentBinding(wire, current, preflight.owner, 'connected_credential_refresh');
    const context = idempotencyContext(wire);
    const command: ConnectedRefreshRequest = Object.freeze({
      requestId: stringValue(wire.request_id, 'T11B_ADAPTER_REQUEST_ID_REQUIRED'),
      idempotencyKey: stringValue(context.idempotency_key, 'T11B_ADAPTER_IDEMPOTENCY_KEY_REQUIRED'),
      binding: current.binding,
      occurredAt: preflight.owner.occurredAt,
      governance: preflight.governance,
    });
    const projected = await this.#options.projection.connectedRefresh(command);
    this.#assertFence(fence);
    assertSameBinding(projected.binding, current.binding);
    if (projected.continuityExpiresAt !== current.continuityExpiresAt) fail('T11B_ADAPTER_CONTINUITY_DEADLINE_EXTENDED', 409);
    const cloud = assertCloudRefresh(await this.#options.cloud.connectedRefresh({
      request: command, projection: projected, owner: preflight.owner, governance: preflight.governance,
    }), projected);
    this.#assertFence(fence);
    const result: RealtimeRefreshAuthorityResult = {
      realtime_session_ref: snapshotOpaqueOwnerValue(projected.binding.realtimeSessionRef),
      device_lease_ref: snapshotOpaqueOwnerValue(projected.binding.deviceLeaseRef),
      continuity_id: projected.binding.continuityId,
      transport_aliases: projectedAliases(projected.binding),
      connection_epoch: assertDecimalConnectionEpoch(projected.binding.connectionEpoch),
      credential_expires_at: cloud.credentialExpiresAt,
      credential_generation: cloud.credentialGeneration,
      credential_input: cloud.credentialInput,
      governance: snapshotRecord(input.governance, 'T11B_ADAPTER_GOVERNANCE_INVALID'),
    };
    assertNoForbiddenOutput(result);
    return Object.freeze(result);
  }

  async claim(input: { readonly effectStarted?:()=>void; readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }): Promise<{ readonly claimId: string; readonly alreadyCompleted?: JsonRecord }> {
    const fence = this.#begin();
    const wire = snapshotRecord(input.request, 'T11B_ADAPTER_STOP_REQUEST_INVALID');
    const preflight = await this.#preflight('media_stop', wire, input.bearer, input.governance, fence);
    const current = await this.#options.currentBinding.resolve({
      operation: 'media_stop', request: wire, owner: preflight.owner, governance: input.governance,
    });
    this.#assertFence(fence);
    if (current === undefined) fail('T11B_ADAPTER_CURRENT_BINDING_REQUIRED', 409);
    const request = buildStopRequest(wire, 'media_stop', preflight.owner, current, preflight.governance);
    const fingerprint = stable(wire);
    const intent: T11bMediaStopIntent = Object.freeze({
      wireRequest: wire, request, governance: snapshotRecord(input.governance, 'T11B_ADAPTER_GOVERNANCE_INVALID'), fingerprint,
    });
    input.effectStarted?.();
    const claimed = await this.#options.externalEffects.claim({
      idempotencyContext: idempotencyContext(wire), fingerprint, intent,
    });
    this.#assertFence(fence);
    if (claimed.disposition === 'replay') {
      const replay = snapshotRecord(claimed.result, 'T11B_ADAPTER_REPLAY_TERMINAL_INVALID');
      const replayFacts = record(replay.execution_facts, 'T11B_ADAPTER_REPLAY_EXECUTION_FACTS_INVALID');
      return Object.freeze({
        claimId: 'durable-replay',
        alreadyCompleted: validateTerminal(replay, wire, 'media_stop', replayFacts),
      });
    }
    if (claimed.disposition !== 'claimed') {
      const code = claimed.disposition === 'conflict' ? 'T11B_ADAPTER_IDEMPOTENCY_CONFLICT'
        : claimed.disposition === 'in_flight' ? 'T11B_ADAPTER_IDEMPOTENCY_IN_FLIGHT'
          : 'T11B_ADAPTER_IDEMPOTENCY_INDETERMINATE';
      fail(code, claimed.disposition === 'conflict' ? 409 : 503);
    }
    return Object.freeze({ claimId: stringValue(claimed.claimId, 'T11B_ADAPTER_CLAIM_ID_INVALID') });
  }

  async #restore(claimId: string, fence: number): Promise<T11bMediaStopIntent> {
    stringValue(claimId, 'T11B_ADAPTER_CLAIM_ID_INVALID');
    const intent = await this.#options.externalEffects.restore({ claimId });
    this.#assertFence(fence);
    if (intent === undefined || intent.request.operation !== 'media_stop' || intent.fingerprint !== stable(intent.wireRequest) ||
        !same(intent.governance, intent.wireRequest.governance)) fail('T11B_ADAPTER_CLAIM_INTENT_INDETERMINATE');
    return intent;
  }

  async #stage(claimId: string, stage: MediaCleanupStage): Promise<void> {
    const fence = this.#begin();
    const intent = await this.#restore(claimId, fence);
    await this.#options.externalEffects.executeStage({ claimId, stage, intent });
    this.#assertFence(fence);
  }

  unpublishAllTracks(claimId: string): Promise<void> { return this.#stage(claimId, 'tracks_unpublished'); }
  disconnectParticipant(claimId: string): Promise<void> { return this.#stage(claimId, 'participant_disconnected'); }
  revokeCredential(claimId: string): Promise<void> { return this.#stage(claimId, 'credential_revoked'); }
  verifyMediaClosed(claimId: string): Promise<void> { return this.#stage(claimId, 'closure_verified'); }

  async complete(claimId: string, facts: MediaClosureFacts): Promise<JsonRecord> {
    const fence = this.#begin();
    const intent = await this.#restore(claimId, fence);
    let commitStarted = false;
    try {
      const receipt = await this.#options.projection.mediaStop(intent.request);
      this.#assertFence(fence);
      validateReceipt(receipt, intent.request);
      const authoritativeFacts = executionFacts(receipt, facts);
      const encoded = await this.#options.terminalCodec.encode({
        operation: 'media_stop', wireRequest: intent.wireRequest, request: intent.request,
        governance: intent.governance, receipt: withCommittedOutcome(receipt, intent.wireRequest), executionFacts: authoritativeFacts,
      });
      this.#assertFence(fence);
      const result = validateTerminal(snapshotRecord(encoded, 'T11B_ADAPTER_TERMINAL_INVALID'), intent.wireRequest, 'media_stop', authoritativeFacts);
      commitStarted = true;
      await this.#options.externalEffects.commit({ claimId, fingerprint: intent.fingerprint, result });
      this.#assertFence(fence);
      return result;
    } catch (error) {
      if (!commitStarted) {
        await this.#options.externalEffects.release({ claimId, fingerprint: intent.fingerprint });
      }
      throw error;
    }
  }

  async endContinuity(input: { readonly effectStarted?:()=>void; readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }): Promise<JsonRecord> {
    const fence = this.#begin();
    const wire = snapshotRecord(input.request, 'T11B_ADAPTER_END_REQUEST_INVALID');
    const preflight = await this.#preflight('end_continuity', wire, input.bearer, input.governance, fence);
    const current = await this.#options.currentBinding.resolve({
      operation: 'end_continuity', request: wire, owner: preflight.owner, governance: input.governance,
    });
    this.#assertFence(fence);
    if (current === undefined) fail('T11B_ADAPTER_CURRENT_BINDING_REQUIRED', 409);
    const request = buildStopRequest(wire, 'end_continuity', preflight.owner, current, preflight.governance);
    input.effectStarted?.();
    const receipt = await this.#options.projection.endContinuity(request);
    this.#assertFence(fence);
    validateReceipt(receipt, request);
    const encoded = await this.#options.terminalCodec.encode({
      operation: 'end_continuity', wireRequest: wire, request, governance: input.governance, receipt: withCommittedOutcome(receipt, wire),
    });
    this.#assertFence(fence);
    return validateTerminal(snapshotRecord(encoded, 'T11B_ADAPTER_TERMINAL_INVALID'), wire, 'end_continuity');
  }

  async handoff(input: { readonly effectStarted?:()=>void; readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }): Promise<JsonRecord> {
    const authority = this.#options.handoffAuthority ?? this.#options.handoff;
    const outputFence = this.#options.handoffOutputFence ?? this.#options.handoffReplay ?? this.#options.handoffEffects ?? this.#options.outputFence;
    const codec = this.#options.handoffTerminalCodec ?? this.#options.handoffCodec;
    if (authority === undefined) fail('T11B_ADAPTER_HANDOFF_AUTHORITY_REQUIRED');
    if (outputFence === undefined) fail('T11B_ADAPTER_HANDOFF_OUTPUT_FENCE_REQUIRED');
    if (codec === undefined) fail('T11B_ADAPTER_HANDOFF_TERMINAL_CODEC_REQUIRED');
    requireMethod(authority, 'handoff', 'T11B_ADAPTER_HANDOFF_AUTHORITY_INVALID');
    requireMethod(outputFence, 'suppressAndClose', 'T11B_ADAPTER_HANDOFF_SUPPRESSION_PORT_INVALID');
    requireMethod(codec, 'encode', 'T11B_ADAPTER_HANDOFF_TERMINAL_CODEC_INVALID');
    const fence = this.#begin();
    const wire = snapshotRecord(input.request, 'T11B_ADAPTER_HANDOFF_REQUEST_INVALID');
    const context = idempotencyContext(wire);
    const fingerprint = stable(wire);
    input.effectStarted?.();
    const claimed = await outputFence.claim({
      idempotencyContext: context, fingerprint, request: wire, wireRequest: wire,
    });
    this.#assertFence(fence);
    if (claimed.disposition === 'replay') {
      const replay = snapshotRecord(claimed.result, 'T11B_ADAPTER_HANDOFF_REPLAY_INVALID');
      return validateHandoffTerminal(replay, wire, handoffBindingFromWire(wire), undefined, true);
    }
    if (claimed.disposition !== 'claimed') {
      const code = claimed.disposition === 'conflict' ? 'T11B_ADAPTER_HANDOFF_IDEMPOTENCY_CONFLICT'
        : claimed.disposition === 'in_flight' ? 'T11B_ADAPTER_HANDOFF_IN_FLIGHT'
          : 'T11B_ADAPTER_HANDOFF_INDETERMINATE';
      fail(code, claimed.disposition === 'conflict' ? 409 : 503);
    }
    const claimId = stringValue(claimed.claimId, 'T11B_ADAPTER_HANDOFF_CLAIM_ID_INVALID');
    let authorityStarted = false;
    try {
      const preflight = await this.#preflight('handoff', wire, input.bearer, input.governance, fence);
      const current = await this.#options.currentBinding.resolve({
        operation: 'handoff', request: wire, owner: preflight.owner, governance: input.governance,
      });
      this.#assertFence(fence);
      if (current === undefined) fail('T11B_ADAPTER_CURRENT_BINDING_REQUIRED', 409);
      const request = buildHandoffRequest(wire, preflight.owner, current, preflight.governance);
      const previousBinding = snapshotOpaqueOwnerValue(current.binding);
      authorityStarted = true;
      const ownerResult = await authority.handoff(request);
      this.#assertFence(fence);
      const suppressionResult = await outputFence.suppressAndClose({
        request, fingerprint, authorityResult: ownerResult, previousBinding,
      });
      this.#assertFence(fence);
      const suppression = validateHandoffSuppression(suppressionResult, wire);
      const encoded = await codec.encode({
        wireRequest: wire, request, owner: preflight.owner,
        governance: preflight.governance, authorityResult: ownerResult, suppressionResult,
      });
      this.#assertFence(fence);
      const result = validateHandoffTerminal(snapshotRecord(encoded, 'T11B_ADAPTER_HANDOFF_TERMINAL_INVALID'), wire, request, suppression);
      await outputFence.commit({ claimId, fingerprint, result });
      this.#assertFence(fence);
      return result;
    } catch (error) {
      if (!authorityStarted) await outputFence.release({ claimId, fingerprint });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    this.#closed = true;
    this.#fence += 1;
    this.#closeFlight = (async () => {
      const failures: string[] = [];
      const ports: readonly (object | undefined)[] = [
        this.#options.externalEffects, this.#options.cloud, this.#options.currentBinding,
        this.#options.ownerContext, this.#options.governance, this.#options.issuerReadiness,
        this.#options.terminalCodec, this.#options.handoffAuthority, this.#options.handoff,
        this.#options.handoffOutputFence, this.#options.handoffReplay, this.#options.handoffEffects, this.#options.outputFence,
        this.#options.handoffTerminalCodec, this.#options.handoffCodec,
      ];
      const seen = new Set<object>();
      for (const port of ports) {
        if (port === undefined || seen.has(port)) continue;
        seen.add(port);
        if (typeof (port as { readonly close?: unknown }).close !== 'function') continue;
        try { await (port as { readonly close: () => void | Promise<void> }).close.call(port); } catch { failures.push('close'); }
      }
      if (failures.length !== 0) fail('T11B_ADAPTER_CLOSE_FAILED');
    })();
    return this.#closeFlight;
  }
}

/**
 * Internal, noncanonical and non-wire composition. Canonical refs, governance,
 * terminal encoding and durable claims remain owned by their injected ports.
 */
export function createRealtimePublicControlT11bT02Adapter(
  options: RealtimePublicControlT11bT02AdapterOptions,
): RealtimePublicControlT11bT02Adapter {
  requireMethod(options?.issuerReadiness, 'assertReady', 'T11B_ADAPTER_ISSUER_READINESS_REQUIRED');
  requireMethod(options?.ownerContext, 'resolve', 'T11B_ADAPTER_OWNER_CONTEXT_REQUIRED');
  requireMethod(options?.currentBinding, 'resolve', 'T11B_ADAPTER_CURRENT_BINDING_PORT_REQUIRED');
  requireMethod(options?.governance, 'assertAuthorized', 'T11B_ADAPTER_T03_GOVERNANCE_REQUIRED');
  for (const method of ['bootstrap', 'connectedRefresh', 'fullyDisconnectedRefresh', 'mediaStop', 'endContinuity']) {
    requireMethod(options?.projection, method, 'T11B_ADAPTER_T11B_PROJECTION_REQUIRED');
  }
  requireMethod(options?.cloud, 'bootstrap', 'T11B_ADAPTER_CLOUD_PROJECTION_REQUIRED');
  requireMethod(options?.cloud, 'connectedRefresh', 'T11B_ADAPTER_CLOUD_PROJECTION_REQUIRED');
  for (const method of ['claim', 'restore', 'executeStage', 'commit', 'release']) {
    requireMethod(options?.externalEffects, method, 'T11B_ADAPTER_T02_COORDINATOR_REQUIRED');
  }
  requireMethod(options?.terminalCodec, 'encode', 'T11B_ADAPTER_T01_TERMINAL_CODEC_REQUIRED');
  const adapter = new Adapter(options);
  return Object.freeze({ sessions: adapter, mediaStop: adapter, close: () => adapter.close() });
}
