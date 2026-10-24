import type { IdempotencyRecord } from '../../../services/platform-data/src/idempotency-ledger.ts';
import { ApplePhysicalCanaryBindingPostgresError, assertAppleFormalWatchBindingReceipt, type AppleCompanionBindingPostgresPort } from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import {
  type LiveKitCloudGrantInput,
  type LiveKitCloudTokenInput,
  type LiveKitCloudTokenSignerPort,
} from './livekit-cloud-token-signer.ts';
import {
  type LiveKitCloudParticipantBinding,
  type LiveKitCloudParticipantConnectInput,
  type LiveKitCloudParticipantPort,
} from './livekit-cloud-participant.ts';
import { createHash } from 'node:crypto';
import { validateAppleProductionEnrollmentBundle } from './apple-production-enrollment-bundle.ts';
import {settleWithSignal,withinRealtimeReadiness} from './realtime-readiness.ts';

export type JsonRecord = Record<string, unknown>;
export type RealtimeOperation =
  | 'place_upload'
  | 'bootstrap'
  | 'realtime_e2ee_key_resolve'
  | 'connected_credential_refresh'
  | 'media_stop'
  | 'end_continuity'
  | 'handoff';

export interface RealtimeBearerContext {
  readonly principal: unknown;
  readonly deviceId: string;
  readonly capabilityRef?: unknown;
  readonly expiresAt?: string;
  readonly scopes?: readonly string[];
}

export interface RealtimeGovernanceDecision {
  readonly accepted: boolean;
  readonly refs?: JsonRecord;
  readonly reason?: string;
}

export interface RealtimeGovernancePort {
  evaluate(input: {
    readonly operation: RealtimeOperation;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
  }): Promise<RealtimeGovernanceDecision>;
}

export interface RealtimeE2eeEnvelope {
  readonly envelope: JsonRecord;
  readonly roomOptions: object;
  readonly release?: () => void;
}

export interface RealtimeKeyResolverPort {
  issue(input: {
    readonly operation: RealtimeOperation;
    readonly request: JsonRecord;
    readonly realtimeSessionRef: unknown;
    readonly continuityId: string;
    readonly governance: JsonRecord;
    /** The already-authoritative LiveKit credential ceiling for this bootstrap. */
    readonly credentialExpiresAt: string;
  }): Promise<RealtimeE2eeEnvelope>;
  close?(): void | Promise<void>;
}

/**
 * Public E2EE delivery is deliberately separate from the internal RoomOptions
 * seam above. This port returns only the recipient-bound ciphertext response;
 * it never returns SDK room options or plaintext key material.
 */
export interface RealtimeE2eeCiphertextResolverPort {
  resolve(input: {
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<JsonRecord>;
  close?(): void | Promise<void>;
}

export interface RealtimeGatewayBinding {
  readonly roomName: string;
  readonly identity: string;
  readonly grants: LiveKitCloudGrantInput;
  readonly token?: string;
  readonly roomOptions?: object;
}

export interface RealtimeBootstrapAuthorityResult {
  readonly realtime_session_ref: unknown;
  readonly device_lease_ref: unknown;
  readonly continuity_id: string;
  readonly transport_aliases: readonly unknown[];
  readonly connection_epoch: string;
  readonly server_url: string;
  readonly credential_expires_at: string;
  readonly continuity_expires_at: string;
  readonly terminal_room_name: string;
  readonly terminal_identity: string;
  readonly terminal_grants: LiveKitCloudGrantInput;
  readonly media_grants: JsonRecord;
  readonly governance: JsonRecord;
  readonly gateway: RealtimeGatewayBinding;
  readonly credential_generation?: string;
  /** Internal T11B CAS proof for a fully-disconnected transport transition. */
  readonly binding_transition?: {
    readonly atomic: true;
    readonly previous_connection_epoch: string;
    readonly previous_realtime_session_ref?: unknown;
    readonly previous_device_lease_ref?: unknown;
    readonly previous_transport_aliases?: readonly unknown[];
    readonly previous_continuity_expires_at?: string;
    readonly provider_session_reused: false;
  };
}

export interface RealtimeRefreshAuthorityResult {
  readonly realtime_session_ref: unknown;
  readonly device_lease_ref: unknown;
  readonly continuity_id: string;
  readonly transport_aliases: readonly unknown[];
  readonly connection_epoch: string;
  readonly credential_expires_at: string;
  readonly credential_generation: string;
  readonly credential_input: LiveKitCloudTokenInput;
  readonly governance: JsonRecord;
  readonly requested_media?: RealtimeRequestedMedia;
}

/**
 * Structural owner seam for credential admission.  The runtime deliberately
 * does not import the platform-data fence implementation: only an
 * authoritative binding tuple crosses this boundary.
 */
export interface RealtimeCredentialFenceTuple {
  readonly sessionRef: unknown;
  readonly leaseRef: unknown;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly credentialGeneration: string;
}

export interface RealtimeCredentialFenceAdmissionPort {
  /** Holds the owner admission boundary across token signing and connect. */
  readonly withAdmission: <T>(
    tuple: RealtimeCredentialFenceTuple,
    callback: () => Promise<T>,
  ) => Promise<T>;
  /** Fails closed when a current SDK reconnect is fenced or unavailable. */
  readonly verifyReconnect: (tuple: RealtimeCredentialFenceTuple) => Promise<void>;
  readonly close?: () => void | Promise<void>;
  /** Composition-owned seams set this false to avoid duplicate close. */
  readonly ownsClose?: boolean;
}

export interface RealtimeRequestedMedia {
  readonly audio: boolean;
  readonly video: boolean;
  readonly data: boolean;
}

export interface RealtimeSessionAuthorityPort {
  /** Host-only synchronous boundary, not a wire assertion. */
  readonly publicOperationEffectBoundary?: 'v1';
  bootstrap(input: {
    readonly effectStarted?: () => void;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<RealtimeBootstrapAuthorityResult>;
  refresh(input: {
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<RealtimeRefreshAuthorityResult>;
  endContinuity(input: {
    readonly effectStarted?: () => void;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<JsonRecord>;
  /** T11B-owned atomic handoff authority. The runtime never implements this locally. */
  handoff?(input: {
    readonly effectStarted?: () => void;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<JsonRecord>;
  close?(): void | Promise<void>;
}

/** Optional direct alias for the injected T11B handoff authority. */
export interface RealtimeHandoffAuthorityPort {
  /** Host-only synchronous boundary, not a wire assertion. */
  readonly publicOperationEffectBoundary?: 'v1' | undefined;
  handoff(input: {
    readonly effectStarted?: () => void;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<JsonRecord>;
  close?(): void | Promise<void>;
}

export type MediaCleanupStage =
  | 'tracks_unpublished'
  | 'participant_disconnected'
  | 'credential_revoked'
  | 'closure_verified';

export interface MediaClosureFacts {
  readonly completedStages: readonly MediaCleanupStage[];
  readonly failedStages: readonly { readonly stage: MediaCleanupStage; readonly code: string }[];
}

export interface MediaStopClaim {
  readonly claimId: string;
  readonly alreadyCompleted?: JsonRecord;
}

export interface MediaStopPort {
  /** Host-only synchronous boundary, not a wire assertion. */
  readonly publicOperationEffectBoundary?: 'v1';
  claim(input: {
    readonly effectStarted?: () => void;
    readonly request: JsonRecord;
    readonly bearer: RealtimeBearerContext;
    readonly governance: JsonRecord;
  }): Promise<MediaStopClaim>;
  unpublishAllTracks(claimId: string): Promise<void>;
  disconnectParticipant(claimId: string): Promise<void>;
  revokeCredential?(claimId: string): Promise<void>;
  verifyMediaClosed?(claimId: string): Promise<void>;
  complete(claimId: string, facts: MediaClosureFacts): Promise<JsonRecord>;
  close?(): void | Promise<void>;
}

/**
 * Owner hook invoked only after a successful participant connection and after
 * the runtime has installed its binding maps.  The hook receives validated
 * runtime values; it must obtain any durable owner projections itself.
 */
export interface RealtimeBootstrapConnectedInput {
  /** One gateway-owned refresh budget, shared by source setup and its ready handshake. */
  readonly readinessSignal?: AbortSignal;
  readonly request: JsonRecord;
  readonly bearer: RealtimeBearerContext;
  readonly governance: JsonRecord;
  readonly authority: RealtimeBootstrapAuthorityResult;
  readonly currentBinding: JsonRecord;
  readonly enabledMedia: RealtimeRequestedMedia;
}

export interface RealtimeCentralTextTransportDescriptor {
  readonly inputTopic: 'paios.central.text.v1';
  readonly outputTopic: 'paios.central.sealed-text.v1';
  readonly maxPacketBytes: number;
  readonly voiceTransport?: 'wav_byte_stream_v1';
  readonly callRejoinWindowS?: number;
}

export interface RealtimeBootstrapConnectedPort {
  /** Source execution owner rejects unsupported media before operation/session state changes. */
  readonly assertBootstrapRequest?: (request: JsonRecord) => void;
  readonly centralTextTransport?: RealtimeCentralTextTransportDescriptor;
  readonly centralTextTransportForDevice?: (deviceId: string) => RealtimeCentralTextTransportDescriptor | undefined;
  readonly callRejoinForDevice?: (deviceId: string) => {call_id:string;rejoin_deadline:string}|undefined;
  readonly onBootstrapConnected?: (
    input: RealtimeBootstrapConnectedInput,
  ) => void | Promise<void>;
  /** Structural alias for owners that name the callback after the port. */
  readonly bootstrapConnected?: (
    input: RealtimeBootstrapConnectedInput,
  ) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
  /** Composition-owned hooks set this false to avoid duplicate close. */
  readonly ownsClose?: boolean;
}

/** Device authority seam: the paired device's E2EE recipient credential ref, bound into every key resolve. */
export interface RealtimeDeviceCredentialPort {
  readonly resolve: (input: Readonly<{ readonly bearer: RealtimeBearerContext }>) => Promise<JsonRecord>;
  readonly close?: () => void | Promise<void>;
}

export interface RealtimePublicOperationReceiptPort {
  execute(input: { readonly request: JsonRecord; readonly bearer: RealtimeBearerContext }, fresh: (effectStarted: () => void) => Promise<JsonRecord>, authorize?: () => Promise<void>, boundary?: 'v1', retry?: 'not_executed_v1' | 'idempotent_effect_v1'): Promise<JsonRecord>;
  read?(input: { readonly request: JsonRecord; readonly bearer: RealtimeBearerContext }): Promise<IdempotencyRecord | undefined>;
}

export interface RealtimePublicControlRuntimeOptions {
  readonly watchBinding?: Pick<AppleCompanionBindingPostgresPort, "mutateFormal" | "readFormal">;
  readonly operationReceipts?: RealtimePublicOperationReceiptPort;
  readonly governance: RealtimeGovernancePort;
  readonly sessions: RealtimeSessionAuthorityPort;
  readonly mediaStop: MediaStopPort;
  readonly e2ee: RealtimeKeyResolverPort;
  readonly e2eeCiphertext: RealtimeE2eeCiphertextResolverPort;
  readonly tokenSigner: LiveKitCloudTokenSignerPort;
  readonly participant: LiveKitCloudParticipantPort;
  readonly participantForDevice?: (deviceId: string) => LiveKitCloudParticipantPort | undefined;
  readonly handoff?: RealtimeHandoffAuthorityPort;
  readonly bootstrapConnected?: RealtimeBootstrapConnectedPort;
  readonly deviceCredential?: RealtimeDeviceCredentialPort;
  readonly credentialFenceAdmission?: RealtimeCredentialFenceAdmissionPort;
  readonly now?: () => number;
}

export class RealtimePublicControlRuntimeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly terminalResult?: JsonRecord;

  constructor(code: string, status = 503, terminalResult?: JsonRecord) {
    super(code);
    this.name = 'RealtimePublicControlRuntimeError';
    this.code = code;
    this.status = status;
    if (terminalResult !== undefined) this.terminalResult = terminalResult;
  }
}

function fail(code: string, status = 503): never {
  throw new RealtimePublicControlRuntimeError(code, status);
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, 500);
  return value as JsonRecord;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code, 500);
  return value;
}

function parseOperation(request: unknown): RealtimeOperation {
  const value = record(request, 'REALTIME_REQUEST_INVALID');
  if (
    value.operation !== 'bootstrap' && value.operation !== 'connected_credential_refresh' &&
    value.operation !== 'media_stop' && value.operation !== 'end_continuity' &&
    value.operation !== 'realtime_e2ee_key_resolve' && value.operation !== 'handoff'
  ) fail('REALTIME_OPERATION_INVALID', 422);
  return value.operation;
}

function requestId(request: JsonRecord): string {
  return requiredString(request.request_id, 'REALTIME_REQUEST_ID_MISSING');
}

function continuityId(request: JsonRecord): string {
  return requiredString(request.continuity_id, 'REALTIME_CONTINUITY_ID_MISSING');
}

function ttlSeconds(nowMs: number, expiresAt: string, continuityExpiresAt: string): number {
  const credentialMs = Date.parse(expiresAt);
  const continuityMs = Date.parse(continuityExpiresAt);
  if (!Number.isSafeInteger(credentialMs) || !Number.isSafeInteger(continuityMs)) fail('REALTIME_EXPIRY_INVALID', 422);
  const remainingMs = Math.min(credentialMs, continuityMs) - nowMs - 1_000;
  const seconds = Math.floor(remainingMs / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900) fail('REALTIME_CREDENTIAL_WINDOW_INVALID', 422);
  return seconds;
}

function assertCredentialWindow(nowMs: number, credentialExpiresAt: string, continuityExpiresAt: string, providedTtlSeconds?: unknown): number {
  if (typeof credentialExpiresAt !== 'string' || typeof continuityExpiresAt !== 'string') fail('REALTIME_CREDENTIAL_EXPIRY_INVALID', 422);
  const credentialMs = Date.parse(credentialExpiresAt);
  const continuityMs = Date.parse(continuityExpiresAt);
  if (!Number.isSafeInteger(credentialMs) || !Number.isSafeInteger(continuityMs) || credentialMs <= nowMs || credentialMs > continuityMs) {
    fail('REALTIME_CREDENTIAL_EXPIRY_INVALID', 422);
  }
  const expected = ttlSeconds(nowMs, credentialExpiresAt, continuityExpiresAt);
  if (providedTtlSeconds !== undefined && providedTtlSeconds !== expected) fail('REALTIME_CREDENTIAL_TTL_MISMATCH', 422);
  return expected;
}

type RuntimePreviousBinding = {
  readonly realtimeSessionRef: unknown;
  readonly deviceLeaseRef: unknown;
  readonly connectionEpoch: string;
  readonly transportAliases: readonly unknown[];
  readonly continuityExpiresAt: string;
};

function transitionPreviousBinding(
  transition: RealtimeBootstrapAuthorityResult['binding_transition'] | undefined,
): RuntimePreviousBinding {
  if (
    transition?.atomic !== true ||
    transition.provider_session_reused !== false ||
    transition.previous_realtime_session_ref === undefined ||
    transition.previous_device_lease_ref === undefined ||
    !Array.isArray(transition.previous_transport_aliases) ||
    transition.previous_transport_aliases.length === 0 ||
    typeof transition.previous_continuity_expires_at !== 'string'
  ) {
    fail('REALTIME_BINDING_TRANSITION_INVALID', 503);
  }
  const previousConnectionEpoch = decimal(transition.previous_connection_epoch, 'REALTIME_PREVIOUS_EPOCH_INVALID');
  const previousContinuityMs = Date.parse(transition.previous_continuity_expires_at);
  if (!Number.isSafeInteger(previousContinuityMs)) fail('REALTIME_BINDING_TRANSITION_INVALID', 503);
  return Object.freeze({
    realtimeSessionRef: transition.previous_realtime_session_ref,
    deviceLeaseRef: transition.previous_device_lease_ref,
    connectionEpoch: previousConnectionEpoch,
    transportAliases: Object.freeze([...transition.previous_transport_aliases]),
    continuityExpiresAt: transition.previous_continuity_expires_at,
  });
}

function sameRuntimePreviousBinding(left: RuntimePreviousBinding, right: RuntimePreviousBinding): boolean {
  return left.connectionEpoch === right.connectionEpoch &&
    left.continuityExpiresAt === right.continuityExpiresAt &&
    equalValue(left.realtimeSessionRef, right.realtimeSessionRef) &&
    equalValue(left.deviceLeaseRef, right.deviceLeaseRef) &&
    equalValue(left.transportAliases, right.transportAliases);
}

function governanceOrFail(decision: RealtimeGovernanceDecision): JsonRecord {
  if (!decision.accepted) fail(decision.reason ?? 'GOVERNANCE_DENIED', 403);
  return decision.refs ?? {};
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message)) return error.message;
  return 'MEDIA_CLEANUP_FAILED';
}

const MEDIA_KEYS = ['audio', 'video', 'data'] as const;
type MediaKey = (typeof MEDIA_KEYS)[number];
const FORBIDDEN_SECRET_KEYS = new Set([
  'plaintext', 'plaintext_key', 'private', 'private_key', 'key_material', 'room_options', 'roomOptions',
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function equalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function decimal(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(value)) fail(code, 503);
  return value;
}

function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const a = left.replace(/^0+(?=\d)/u, '');
  const b = right.replace(/^0+(?=\d)/u, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function bindingKey(session: unknown, lease: unknown, epoch: unknown): string {
  if (session === null || typeof session !== 'object' || Array.isArray(session) || lease === null || typeof lease !== 'object' || Array.isArray(lease)) fail('REALTIME_BINDING_KEY_INVALID', 503);
  const normalizedEpoch = decimal(epoch, 'REALTIME_CONNECTION_EPOCH_INVALID');
  try {
    const key = canonicalJson({ session, lease, epoch: normalizedEpoch });
    if (typeof key !== 'string' || key.length === 0 || key.length > 16_384) fail('REALTIME_BINDING_KEY_INVALID', 503);
    return key;
  } catch (error) {
    if (error instanceof RealtimePublicControlRuntimeError) throw error;
    fail('REALTIME_BINDING_KEY_INVALID', 503);
  }
}

function credentialFenceTuple(
  sessionRef: unknown,
  leaseRef: unknown,
  continuity: unknown,
  epoch: unknown,
  generation: unknown,
  required: boolean,
): RealtimeCredentialFenceTuple | undefined {
  if (!required) return undefined;
  if (sessionRef === null || typeof sessionRef !== 'object' || Array.isArray(sessionRef) ||
      leaseRef === null || typeof leaseRef !== 'object' || Array.isArray(leaseRef)) {
    fail('REALTIME_CREDENTIAL_FENCE_TUPLE_INVALID', 503);
  }
  const continuityId = requiredString(continuity, 'REALTIME_CREDENTIAL_FENCE_TUPLE_INVALID');
  const connectionEpoch = decimal(epoch, 'REALTIME_CREDENTIAL_FENCE_TUPLE_INVALID');
  const credentialGeneration = decimal(generation, 'REALTIME_CREDENTIAL_GENERATION_INVALID');
  return Object.freeze({ sessionRef, leaseRef, continuityId, connectionEpoch, credentialGeneration });
}

function requestMedia(request: JsonRecord): RealtimeRequestedMedia {
  const requested = record(request.requested_media, 'REALTIME_REQUESTED_MEDIA_INVALID');
  const result = {} as Record<MediaKey, boolean>;
  for (const key of MEDIA_KEYS) {
    if (typeof requested[key] !== 'boolean') fail('REALTIME_REQUESTED_MEDIA_INVALID', 422);
    result[key] = requested[key] as boolean;
  }
  return Object.freeze(result);
}

function assertRequestedMedia(value: unknown, code: string): RealtimeRequestedMedia {
  const recordValue = record(value, code);
  const result = {} as Record<MediaKey, boolean>;
  for (const key of MEDIA_KEYS) {
    if (typeof recordValue[key] !== 'boolean') fail(code, 503);
    result[key] = recordValue[key] as boolean;
  }
  return Object.freeze(result);
}

function explicitStart(request: JsonRecord, requested: RealtimeRequestedMedia): ReadonlySet<MediaKey> {
  const start = record(request.start, 'REALTIME_START_BINDING_INVALID');
  if (start.kind !== 'explicit_user_start' || start.device_id !== request.device_id || !Array.isArray(start.modalities)) {
    fail('REALTIME_START_BINDING_INVALID', 422);
  }
  const modalities = new Set<MediaKey>();
  for (const modality of start.modalities) {
    if (!MEDIA_KEYS.includes(modality as MediaKey) || modalities.has(modality as MediaKey)) {
      fail('REALTIME_START_BINDING_INVALID', 422);
    }
    modalities.add(modality as MediaKey);
  }
  for (const key of MEDIA_KEYS) {
    if (requested[key] !== modalities.has(key)) fail('REALTIME_MEDIA_START_INTERSECTION_INVALID', 403);
  }
  return modalities;
}

function assertCloudGrantContainment(
  grant: LiveKitCloudGrantInput,
  requested: RealtimeRequestedMedia,
  enabledByAuthority: RealtimeRequestedMedia,
  code: string,
): void {
  if (
    grant === null || typeof grant !== 'object' || grant.roomJoin !== true ||
    typeof grant.room !== 'string' || typeof grant.canPublish !== 'boolean' ||
    typeof grant.canSubscribe !== 'boolean' || typeof grant.canPublishData !== 'boolean' ||
    !Array.isArray(grant.canPublishSources)
  ) fail(code, 503);
  const allowedKeys = new Set(['room', 'roomJoin', 'canPublish', 'canSubscribe', 'canPublishData', 'canPublishSources']);
  if (Object.keys(grant).some((key) => !allowedKeys.has(key))) fail(code, 503);
  const seen = new Set<string>();
  let hasPublishSource = false;
  for (const source of grant.canPublishSources) {
    if (source !== 'microphone' && source !== 'camera') fail(code, 503);
    if (seen.has(source)) fail(code, 503);
    seen.add(source);
    const modality = source === 'microphone' ? 'audio' : 'video';
    if (!requested[modality] || !enabledByAuthority[modality]) fail(code, 403);
    hasPublishSource = true;
  }
  if (grant.canPublish !== hasPublishSource) fail(code, 503);
  if (grant.canPublishData && (!requested.data || !enabledByAuthority.data)) fail(code, 403);
}

function assertMediaAuthorization(request: JsonRecord, authority: RealtimeBootstrapAuthorityResult, nowMs: number, credentialExpiresAt: string, continuityExpiresAt: string): RealtimeRequestedMedia {
  const requested = requestMedia(request);
  const modalities = explicitStart(request, requested);
  const media = record(authority.media_grants, 'REALTIME_MEDIA_GRANTS_INVALID');
  if (Object.keys(media).some((key) => !MEDIA_KEYS.includes(key as MediaKey))) fail('REALTIME_MEDIA_GRANTS_INVALID', 503);
  const enabledByAuthority = {} as Record<MediaKey, boolean>;
  for (const key of MEDIA_KEYS) {
    const grant = record(media[key], 'REALTIME_MEDIA_GRANTS_INVALID');
    if (typeof grant.enabled !== 'boolean') fail('REALTIME_MEDIA_GRANTS_INVALID', 503);
    enabledByAuthority[key] = grant.enabled;
    if (!grant.enabled) {
      if (Object.keys(grant).length !== 1) fail('REALTIME_MEDIA_GRANTS_INVALID', 503);
      continue;
    }
    if (!requested[key] || !modalities.has(key) || grant.device_id !== request.device_id) {
      fail('REALTIME_MEDIA_GRANT_EXPANSION', 403);
    }
    if (!equalValue(grant.device_lease_ref, authority.device_lease_ref)) fail('REALTIME_MEDIA_GRANT_LEASE_INVALID', 403);
    const start = record(grant.start_binding, 'REALTIME_MEDIA_GRANT_START_INVALID');
    if (start.kind !== 'explicit_user_start' || start.device_id !== request.device_id || !Array.isArray(start.modalities) || new Set(start.modalities).size !== start.modalities.length || !start.modalities.includes(key) || start.modalities.some((modality) => !modalities.has(modality as MediaKey))) {
      fail('REALTIME_MEDIA_GRANT_START_INVALID', 403);
    }
    if (typeof grant.expires_at !== 'string' || !Number.isFinite(Date.parse(grant.expires_at))) fail('REALTIME_MEDIA_GRANT_EXPIRY_INVALID', 503);
    const grantExpiresMs = Date.parse(grant.expires_at);
    const credentialExpiresMs = Date.parse(credentialExpiresAt);
    const continuityExpiresMs = Date.parse(continuityExpiresAt);
    if (!Number.isSafeInteger(grantExpiresMs) || grantExpiresMs <= nowMs || grantExpiresMs > credentialExpiresMs || grantExpiresMs > continuityExpiresMs) {
      fail('REALTIME_MEDIA_GRANT_EXPIRY_INVALID', 503);
    }
  }
  assertCloudGrantContainment(authority.terminal_grants, requested, enabledByAuthority, 'REALTIME_TERMINAL_GRANTS_INVALID');
  assertCloudGrantContainment(authority.gateway.grants, requested, enabledByAuthority, 'REALTIME_GATEWAY_GRANTS_INVALID');
  return Object.freeze({ ...enabledByAuthority });
}

function assertBootstrapEnvelope(
  envelope: RealtimeE2eeEnvelope,
  request: JsonRecord,
  authority: RealtimeBootstrapAuthorityResult,
  governance: JsonRecord,
  enabledMedia: RealtimeRequestedMedia,
  nowMs: number,
  credentialExpiresAt: string,
  continuityExpiresAt: string,
): void {
  if (typeof envelope?.release !== 'function') fail('REALTIME_E2EE_RELEASE_REQUIRED', 503);
  const payload = record(envelope.envelope, 'REALTIME_E2EE_ENVELOPE_INVALID');
  assertNoSecretKeys(payload);
  if (Object.keys(payload).some((key) => ['ciphertext', 'encapsulated_key', 'aad_sha256'].includes(key))) fail('REALTIME_E2EE_ENVELOPE_SECRET', 503);
  if (!equalValue(payload.realtime_session_ref, authority.realtime_session_ref) || payload.continuity_id !== authority.continuity_id || !equalValue(payload.governance, authority.governance) || !equalValue(authority.governance, governance) || !equalValue(authority.governance, request.governance)) {
    fail('REALTIME_E2EE_ENVELOPE_BINDING_INVALID', 503);
  }
  if (payload.key_envelope_ref === undefined) fail('REALTIME_E2EE_ENVELOPE_KEY_INVALID', 503);
  const scope = record(payload.scope, 'REALTIME_E2EE_ENVELOPE_SCOPE_INVALID');
  if (scope.device_id !== request.device_id || scope.distribution_mode !== 'application_controlled_envelope' || !Array.isArray(scope.channels)) fail('REALTIME_E2EE_ENVELOPE_SCOPE_INVALID', 503);
  const expectedChannels = MEDIA_KEYS.filter((key) => enabledMedia[key]);
  const actualChannels = scope.channels;
  if (expectedChannels.length === 0 || new Set(actualChannels).size !== actualChannels.length || actualChannels.some((channel) => !MEDIA_KEYS.includes(channel as MediaKey)) || actualChannels.length !== expectedChannels.length || expectedChannels.some((channel) => !actualChannels.includes(channel))) {
    fail('REALTIME_E2EE_ENVELOPE_SCOPE_INVALID', 503);
  }
  if (!Number.isSafeInteger(payload.key_index) || (payload.key_index as number) < 0) fail('REALTIME_E2EE_ENVELOPE_KEY_INVALID', 503);
  decimal(payload.key_generation, 'REALTIME_E2EE_ENVELOPE_KEY_INVALID');
  if (typeof payload.expires_at !== 'string' || !Number.isFinite(Date.parse(payload.expires_at))) fail('REALTIME_E2EE_ENVELOPE_EXPIRY_INVALID', 503);
  const expiresMs = Date.parse(payload.expires_at);
  const credentialMs = Date.parse(credentialExpiresAt);
  const continuityMs = Date.parse(continuityExpiresAt);
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= nowMs || expiresMs > credentialMs || expiresMs > continuityMs) fail('REALTIME_E2EE_ENVELOPE_EXPIRY_INVALID', 503);
  if (envelope.roomOptions === null || typeof envelope.roomOptions !== 'object' || Array.isArray(envelope.roomOptions)) fail('REALTIME_E2EE_ROOM_OPTIONS_INVALID', 503);
  const roomOptions = envelope.roomOptions as Record<string, unknown>;
  if (!Object.hasOwn(roomOptions, 'encryption') || roomOptions.encryption === null || typeof roomOptions.encryption !== 'object' || Array.isArray(roomOptions.encryption)) fail('REALTIME_E2EE_ROOM_OPTIONS_INVALID', 503);
}

function assertNoSecretKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretKeys(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key)) fail('REALTIME_E2EE_KEY_RESULT_SECRET', 503);
    assertNoSecretKeys(item);
  }
}

function asTerminalResult(value: JsonRecord, operation: RealtimeOperation, request: JsonRecord): JsonRecord {
  if (value.operation !== operation || value.request_id !== request.request_id) {
    fail('REALTIME_OWNER_RESULT_BINDING_INVALID', 503);
  }
  return value;
}

function assertTupleBinding(value: JsonRecord, request: JsonRecord, requireTransportAliases = false): void {
  const fields = ['realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch'] as const;
  for (const field of fields) {
    if (!equalValue(value[field], request[field])) fail('REALTIME_OWNER_RESULT_BINDING_INVALID', 503);
  }
  if (requireTransportAliases || value.transport_aliases !== undefined) {
    if (!equalValue(value.transport_aliases, request.transport_aliases)) fail('REALTIME_OWNER_RESULT_BINDING_INVALID', 503);
  }
}

function assertE2eeBinding(value: JsonRecord, request: JsonRecord): void {
  asTerminalResult(value, 'realtime_e2ee_key_resolve', request);
  for (const field of [
    'idempotency_context', 'realtime_session_ref', 'device_lease_ref', 'continuity_id',
    'connection_epoch', 'transport_aliases', 'key_envelope_ref', 'key_index', 'key_generation',
    'device_id', 'recipient_device_credential_ref', 'participant_audience', 'governance',
  ]) {
    if (!equalValue(value[field], request[field])) fail('REALTIME_E2EE_KEY_BINDING_INVALID', 503);
  }
  assertNoSecretKeys(value);
}

function assertOperationTerminalBinding(value: JsonRecord, operation: RealtimeOperation, request: JsonRecord): void {
  asTerminalResult(value, operation, request);
  if (Object.keys(value).some((key) => /^delivery[_-]?receipt$/iu.test(key))) fail('REALTIME_DELIVERY_RECEIPT_NOT_OPERATION_RESULT', 503);
  for (const field of ['realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch', 'governance']) {
    if (value[field] !== undefined && !equalValue(value[field], request[field])) fail('REALTIME_OWNER_RESULT_BINDING_INVALID', 503);
  }
  assertNoSecretKeys(value);
}

function assertStopTerminalResult(value: JsonRecord, request: JsonRecord): JsonRecord {
  asTerminalResult(value, 'media_stop', request);
  assertTupleBinding(value, request, false);
  if (Object.keys(value).some((key) => /^delivery[_-]?receipt$/iu.test(key))) fail('REALTIME_DELIVERY_RECEIPT_NOT_OPERATION_RESULT', 503);
  if (!equalValue(value.governance, request.governance)) fail('REALTIME_OWNER_RESULT_BINDING_INVALID', 503);
  const facts = record(value.execution_facts, 'REALTIME_STOP_EXECUTION_FACTS_INVALID');
  const factFields = ['closure_status', 'device_lease_release', 'participant_cleanup', 'track_cleanup', 'room_cleanup'] as const;
  for (const field of factFields) {
    if (typeof facts[field] !== 'string') fail('REALTIME_STOP_EXECUTION_FACTS_INVALID', 503);
  }
  if (!['not_applicable', 'verified_closed', 'failed', 'indeterminate'].includes(String(facts.closure_status))) fail('REALTIME_STOP_EXECUTION_FACTS_INVALID', 503);
  if (!['not_requested', 'released', 'already_released', 'failed', 'indeterminate'].includes(String(facts.device_lease_release))) fail('REALTIME_STOP_EXECUTION_FACTS_INVALID', 503);
  for (const field of ['participant_cleanup', 'track_cleanup', 'room_cleanup'] as const) {
    if (!['not_requested', 'verified_absent', 'failed', 'indeterminate'].includes(String(facts[field]))) fail('REALTIME_STOP_EXECUTION_FACTS_INVALID', 503);
  }
  const outcome = record(value.operation_outcome, 'REALTIME_STOP_OUTCOME_INVALID');
  const status = value.status;
  if (status === 'success') {
    if (facts.closure_status !== 'verified_closed' || facts.device_lease_release !== 'released' && facts.device_lease_release !== 'already_released' || facts.participant_cleanup !== 'verified_absent' || facts.track_cleanup !== 'verified_absent' || facts.room_cleanup !== 'verified_absent') {
      fail('REALTIME_STOP_SUCCESS_FACTS_INVALID', 503);
    }
    if (outcome.outcome_class !== 'committed_success') fail('REALTIME_STOP_OUTCOME_INVALID', 503);
  } else if (status === 'indeterminate') {
    if (outcome.outcome_class !== 'indeterminate') fail('REALTIME_STOP_OUTCOME_INVALID', 503);
    const error = record(outcome.error, 'REALTIME_STOP_OUTCOME_INVALID');
    if (error.retry_class !== 'never') fail('REALTIME_STOP_OUTCOME_INVALID', 503);
  }
  if (status !== 'success' && outcome.outcome_class === 'committed_success') fail('REALTIME_STOP_OUTCOME_INVALID', 503);
  if (status === 'success' && outcome.outcome_class !== 'committed_success') fail('REALTIME_STOP_OUTCOME_INVALID', 503);
  if (outcome.outcome_class === 'committed_success' || outcome.outcome_class === 'committed_rejection') {
    const recorded = record(outcome.recorded_result_ref, 'REALTIME_STOP_RRR_INVALID');
    if (!equalValue(recorded.idempotency_context, request.idempotency_context)) fail('REALTIME_STOP_RRR_BINDING_INVALID', 503);
    if (typeof recorded.fencing_epoch !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(recorded.fencing_epoch) || recorded.outcome_class !== outcome.outcome_class) fail('REALTIME_STOP_RRR_INVALID', 503);
    for (const field of ['result_schema_id', 'result_schema_version', 'result_schema_sha256', 'result_payload_sha256'] as const) {
      if (typeof recorded[field] !== 'string' || recorded[field].length === 0) fail('REALTIME_STOP_RRR_INVALID', 503);
    }
  } else if (status === 'success') {
    fail('REALTIME_STOP_RRR_INVALID', 503);
  }
  return value;
}

function assertNoDeliveryReceipt(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoDeliveryReceipt(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^delivery[_-]?receipt$/iu.test(key)) fail('REALTIME_DELIVERY_RECEIPT_NOT_OPERATION_RESULT', 503);
    assertNoDeliveryReceipt(item);
  }
}

function assertHandoffRecordedResultReference(
  outcome: JsonRecord,
  request: JsonRecord,
  expectedClass: 'committed_success' | 'committed_rejection',
): void {
  if (outcome.outcome_class !== expectedClass) fail('REALTIME_HANDOFF_OUTCOME_INVALID', 503);
  const recorded = record(outcome.recorded_result_ref, 'REALTIME_HANDOFF_RRR_INVALID');
  if (!equalValue(recorded.idempotency_context, request.idempotency_context) ||
      typeof recorded.fencing_epoch !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(recorded.fencing_epoch) ||
      recorded.outcome_class !== expectedClass) {
    fail('REALTIME_HANDOFF_RRR_BINDING_INVALID', 503);
  }
  for (const field of ['result_schema_id', 'result_schema_version', 'result_schema_sha256', 'result_payload_sha256'] as const) {
    if (typeof recorded[field] !== 'string' || recorded[field].length === 0) fail('REALTIME_HANDOFF_RRR_INVALID', 503);
  }
}

function assertHandoffSuppressionFence(value: unknown, result: JsonRecord, request: JsonRecord): void {
  const fence = record(value, 'REALTIME_HANDOFF_SUPPRESSION_FENCE_INVALID');
  const allowed = new Set([
    'from_device_id', 'previous_device_lease_ref', 'new_device_lease_ref',
    'connection_epoch', 'fencing_token', 'state',
  ]);
  if (Object.keys(fence).some((key) => !allowed.has(key)) ||
      fence.from_device_id !== request.from_device_id ||
      !equalValue(fence.previous_device_lease_ref, request.current_device_lease_ref) ||
      !equalValue(fence.new_device_lease_ref, result.device_lease_ref) ||
      fence.connection_epoch !== request.connection_epoch ||
      fence.fencing_token !== result.fencing_token ||
      fence.state !== 'old_device_suppressed') {
    fail('REALTIME_HANDOFF_SUPPRESSION_FENCE_INVALID', 503);
  }
  if (typeof fence.fencing_token !== 'string' || !/^[1-9][0-9]{0,37}$/u.test(fence.fencing_token)) {
    fail('REALTIME_HANDOFF_SUPPRESSION_FENCE_INVALID', 503);
  }
}

/**
 * Handoff has a stricter terminal contract than the legacy terminal paths:
 * the old lease release, new active lease, old-device output fence, and
 * owner evidence must all be present before committed_success is admitted.
 * This is validation only; the T11B authority and durable replay seam own the
 * transition and its canonical references.
 */
function assertHandoffTerminalResult(value: JsonRecord, request: JsonRecord): JsonRecord {
  assertNoSecretKeys(value);
  assertNoDeliveryReceipt(value);
  if (Object.hasOwn(value, 'idempotency_context') || value.operation !== 'handoff' ||
      value.request_id !== request.request_id ||
      !equalValue(value.realtime_session_ref, request.realtime_session_ref) ||
      value.continuity_id !== request.continuity_id ||
      value.connection_epoch !== request.connection_epoch ||
      value.from_device_id !== request.from_device_id || value.to_device_id !== request.to_device_id ||
      !equalValue(value.previous_device_lease_ref, request.current_device_lease_ref) ||
      !equalValue(value.governance, request.governance)) {
    fail('REALTIME_HANDOFF_TERMINAL_BINDING_INVALID', 503);
  }
  decimal(value.connection_epoch, 'REALTIME_HANDOFF_CONNECTION_EPOCH_INVALID');
  const outcome = record(value.operation_outcome, 'REALTIME_HANDOFF_OUTCOME_INVALID');
  const facts = record(value.execution_facts, 'REALTIME_HANDOFF_EXECUTION_FACTS_INVALID');
  const closureStatus = facts.closure_status;
  if (!['not_applicable', 'verified_closed', 'failed', 'indeterminate'].includes(String(closureStatus))) {
    fail('REALTIME_HANDOFF_EXECUTION_FACTS_INVALID', 503);
  }
  if (facts.device_lease_release !== undefined &&
      !['not_requested', 'released', 'already_released', 'failed', 'indeterminate'].includes(String(facts.device_lease_release))) {
    fail('REALTIME_HANDOFF_EXECUTION_FACTS_INVALID', 503);
  }
  const status = value.status;
  if (status === 'success') {
    if (outcome.outcome_class !== 'committed_success' || closureStatus !== 'verified_closed' ||
        facts.device_lease_release !== 'released' || !Array.isArray(facts.evidence_refs) || facts.evidence_refs.length === 0 ||
        (facts.participant_cleanup !== undefined && facts.participant_cleanup !== 'verified_absent') ||
        (facts.track_cleanup !== undefined && facts.track_cleanup !== 'verified_absent') ||
        (facts.room_cleanup !== undefined && facts.room_cleanup !== 'verified_absent')) {
      fail('REALTIME_HANDOFF_SUCCESS_FACTS_INVALID', 503);
    }
    if (value.device_lease_ref === undefined || equalValue(value.device_lease_ref, request.current_device_lease_ref)) {
      fail('REALTIME_HANDOFF_NEW_LEASE_INVALID', 503);
    }
    decimal(value.lease_version, 'REALTIME_HANDOFF_LEASE_VERSION_INVALID');
    decimal(value.fencing_token, 'REALTIME_HANDOFF_FENCING_TOKEN_INVALID');
    assertHandoffSuppressionFence(value.old_device_suppression_fence, value, request);
    assertHandoffRecordedResultReference(outcome, request, 'committed_success');
    const recorded = record(outcome.recorded_result_ref, 'REALTIME_HANDOFF_RRR_INVALID');
    if (recorded.fencing_epoch !== value.fencing_token) fail('REALTIME_HANDOFF_RRR_FENCE_INVALID', 503);
  } else if (status === 'indeterminate') {
    if (outcome.outcome_class !== 'indeterminate') fail('REALTIME_HANDOFF_OUTCOME_INVALID', 503);
    const error = record(outcome.error, 'REALTIME_HANDOFF_OUTCOME_INVALID');
    if (error.retry_class !== 'never') fail('REALTIME_HANDOFF_OUTCOME_INVALID', 503);
    if (outcome.recorded_result_ref !== undefined) fail('REALTIME_HANDOFF_INDETERMINATE_PROMOTION', 503);
    if (value.old_device_suppression_fence !== undefined && value.device_lease_ref !== undefined) {
      assertHandoffSuppressionFence(value.old_device_suppression_fence, value, request);
    }
  } else {
    if (outcome.outcome_class === 'committed_success') fail('REALTIME_HANDOFF_OUTCOME_INVALID', 503);
    if (outcome.outcome_class === 'committed_rejection') assertHandoffRecordedResultReference(outcome, request, 'committed_rejection');
  }
  if (status !== 'success' && outcome.outcome_class === 'committed_success') fail('REALTIME_HANDOFF_OUTCOME_INVALID', 503);
  return value;
}

/**
 * Runtime seam for the five T01 successor operations. It owns no canonical
 * objects or persistence; T11B/T03/T10 ports remain authoritative.
 */
export class RealtimePublicControlRuntime {
  readonly #watchBinding?: Pick<AppleCompanionBindingPostgresPort, "mutateFormal" | "readFormal">;
  readonly #governance: RealtimeGovernancePort;
  readonly #sessions: RealtimeSessionAuthorityPort;
  readonly #mediaStop: MediaStopPort;
  readonly #e2ee: RealtimeKeyResolverPort;
  readonly #e2eeCiphertext: RealtimeE2eeCiphertextResolverPort;
  readonly #tokenSigner: LiveKitCloudTokenSignerPort;
  readonly #participant: LiveKitCloudParticipantPort;
  readonly #participantForDevice: ((deviceId: string) => LiveKitCloudParticipantPort | undefined) | undefined;
  readonly #participants = new Set<LiveKitCloudParticipantPort>();
  readonly #bootstrapGenerations = new WeakMap<LiveKitCloudParticipantPort, symbol>();
  readonly #participantGenerations = new WeakMap<LiveKitCloudParticipantPort, symbol>();
  readonly #handoff?: RealtimeHandoffAuthorityPort;
  readonly #operationReceipts?: RealtimePublicOperationReceiptPort;
  readonly #bootstrapConnected?: RealtimeBootstrapConnectedPort;
  readonly #deviceCredential?: RealtimeDeviceCredentialPort;
  readonly #credentialFenceAdmission?: RealtimeCredentialFenceAdmissionPort;
  readonly #now: () => number;
  readonly #e2eeReleases = new Map<string, Set<() => void>>();
  readonly #bindings = new Map<string, {
    readonly participant: LiveKitCloudParticipantPort;
    readonly bootstrapGeneration: symbol;
    readonly attachment: RealtimeBootstrapConnectedInput;
    readonly roomOptions: object;
    readonly realtimeSessionRef: unknown;
    readonly deviceLeaseRef: unknown;
    readonly continuityId: string;
    readonly connectionEpoch: string;
    readonly transportAliases: readonly unknown[];
    readonly credentialRoom: string;
    readonly credentialIdentity: string;
    readonly continuityExpiresAt: string;
    readonly requestedMedia: RealtimeRequestedMedia;
    readonly enabledMedia: RealtimeRequestedMedia;
    readonly credentialGeneration?: string;
    readonly recipientDeviceCredentialRef?: unknown;
  }>();
  readonly #latestByContinuity = new Map<string, RuntimePreviousBinding>();
  #closed = false;
  #closeFlight: Promise<void> | undefined;

  constructor(options: RealtimePublicControlRuntimeOptions) {
    if (
      typeof options.governance?.evaluate !== 'function' ||
      typeof options.sessions?.bootstrap !== 'function' ||
      typeof options.sessions?.refresh !== 'function' ||
      typeof options.sessions?.endContinuity !== 'function' ||
      typeof options.mediaStop?.claim !== 'function' ||
      typeof options.mediaStop?.complete !== 'function' ||
      typeof options.e2ee?.issue !== 'function' ||
      typeof options.e2eeCiphertext?.resolve !== 'function' ||
      typeof options.tokenSigner?.assertProjectUrl !== 'function' ||
      typeof options.tokenSigner?.sign !== 'function' ||
      typeof options.participant?.connect !== 'function' ||
      typeof options.participant?.disconnect !== 'function' ||
      (options.bootstrapConnected !== undefined &&
       typeof options.bootstrapConnected !== 'object' && typeof options.bootstrapConnected !== 'function')
    ) fail('REALTIME_RUNTIME_PORTS_INVALID', 500);
    if (options.operationReceipts !== undefined) this.#operationReceipts = options.operationReceipts;
    if (options.watchBinding !== undefined) this.#watchBinding = options.watchBinding;
    this.#governance = options.governance;
    this.#sessions = options.sessions;
    this.#mediaStop = options.mediaStop;
    this.#e2ee = options.e2ee;
    this.#e2eeCiphertext = options.e2eeCiphertext;
    this.#tokenSigner = options.tokenSigner;
    this.#participant = options.participant;
    this.#participantForDevice = options.participantForDevice;
    this.#participants.add(options.participant);
    if (options.handoff !== undefined) this.#handoff = options.handoff;
    if (options.bootstrapConnected !== undefined) {
      const hook = options.bootstrapConnected;
      if (typeof hook.onBootstrapConnected !== 'function' && typeof hook.bootstrapConnected !== 'function') {
        fail('REALTIME_BOOTSTRAP_CONNECTED_HOOK_INVALID', 500);
      }
      if (hook.close !== undefined && typeof hook.close !== 'function') {
        fail('REALTIME_BOOTSTRAP_CONNECTED_HOOK_INVALID', 500);
      }
      this.#bootstrapConnected = hook;
    }
    if (options.deviceCredential !== undefined) {
      if (typeof options.deviceCredential !== 'object' || options.deviceCredential === null ||
          typeof options.deviceCredential.resolve !== 'function' ||
          (options.deviceCredential.close !== undefined && typeof options.deviceCredential.close !== 'function')) {
        fail('REALTIME_DEVICE_CREDENTIAL_PORT_INVALID', 500);
      }
      this.#deviceCredential = options.deviceCredential;
    }
    if (options.credentialFenceAdmission !== undefined) {
      const admission = options.credentialFenceAdmission;
      if (typeof admission !== 'object' || admission === null ||
          typeof admission.withAdmission !== 'function' || typeof admission.verifyReconnect !== 'function') {
        fail('REALTIME_CREDENTIAL_FENCE_ADMISSION_INVALID', 500);
      }
      if (admission.close !== undefined && typeof admission.close !== 'function') {
        fail('REALTIME_CREDENTIAL_FENCE_ADMISSION_INVALID', 500);
      }
      this.#credentialFenceAdmission = admission;
    }
    this.#now = options.now ?? (() => Date.now());
    // Guard only participants this runtime bootstraps; per-device participants bind at first bootstrap, and a
    // borrowed owner keeps the guard it already bound on its default participant.
    if (this.#credentialFenceAdmission !== undefined && this.#participantForDevice === undefined &&
        typeof this.#participant.setReconnectAdmissionGuard === 'function') {
      try {
        this.#participant.setReconnectAdmissionGuard((participantBinding) =>
          this.verifyCredentialFenceReconnect(participantBinding));
      } catch {
        fail('REALTIME_CREDENTIAL_FENCE_ADMISSION_INVALID', 500);
      }
    }
  }

  /**
   * Structural reconnect callback for participants that expose the optional
   * SDK admission seam.  The credential generation is read only from the
   * runtime's authoritative binding map; it is never inferred from a client
   * lease or fencing field.
   */
  async verifyCredentialFenceReconnect(participantBinding: LiveKitCloudParticipantBinding): Promise<void> {
    this.#assertOpen();
    const admission = this.#credentialFenceAdmission;
    if (admission === undefined) fail('REALTIME_CREDENTIAL_FENCE_ADMISSION_UNAVAILABLE', 503);
    const key = bindingKey(participantBinding.realtimeSessionRef, participantBinding.deviceLeaseRef, participantBinding.connectionEpoch);
    const current = this.#bindings.get(key);
    if (current === undefined || current.continuityId !== participantBinding.continuityId) {
      fail('REALTIME_RECONNECT_BINDING_UNKNOWN', 409);
    }
    const tuple = credentialFenceTuple(
      current.realtimeSessionRef,
      current.deviceLeaseRef,
      current.continuityId,
      current.connectionEpoch,
      current.credentialGeneration,
      true,
    );
    if (tuple === undefined) fail('REALTIME_CREDENTIAL_GENERATION_REQUIRED', 503);
    await admission.verifyReconnect(tuple);
  }

  async #executeReceipted(request: JsonRecord, bearer: RealtimeBearerContext, fresh: (approved?: JsonRecord, effectStarted?: () => void) => Promise<JsonRecord>, preflight?: () => void,
    retry: 'not_executed_v1' | 'idempotent_effect_v1' = 'not_executed_v1'): Promise<JsonRecord> {
    if (this.#operationReceipts === undefined) { preflight?.(); return fresh(); }
    let approved: JsonRecord | undefined;
    try {
      return await this.#operationReceipts.execute({ request, bearer }, effectStarted => fresh(approved,effectStarted), async () => {
        preflight?.();
        approved = governanceOrFail(await this.#governance.evaluate({ operation: parseOperation(request), request, bearer }));
      }, 'v1', retry);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'IDEMPOTENCY_CONFLICT' || code === 'PUBLIC_OPERATION_RECEIPT_IN_FLIGHT') fail(code, 409);
      throw error;
    }
  }

  get watchBindingAvailable(): boolean { return !this.#closed && this.#watchBinding !== undefined; }

  async watchBinding(request: unknown, bearer: RealtimeBearerContext, read = false): Promise<JsonRecord> {
    if (this.#closed) fail('REALTIME_RUNTIME_CLOSED', 503);
    if (this.#watchBinding === undefined) fail('REALTIME_WATCH_BINDING_UNAVAILABLE', 503);
    const value = record(request, 'REALTIME_WATCH_BINDING_REQUEST_INVALID');
    if (value.operation !== 'watch_binding') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    const action = value.action as 'register' | 'replace' | 'revoke';
    const keys = ['operation', 'realtime_session_ref', 'iphone_device_lease_ref', ...(read ? [] : ['action', 'request_id', 'idempotency_key', 'expected_pair_version', ...(action === 'revoke' ? [] : ['installation_id', 'ttl_seconds'])])].sort();
    if (Object.keys(value).sort().join(',') !== keys.join(',')) fail('REALTIME_WATCH_BINDING_REQUEST_INVALID', 422);
    let binding;
    try {
      if (read) {
        const { pairState, binding } = await this.#watchBinding.readFormal({
          realtimeSessionRef: value.realtime_session_ref as never, iphoneDeviceLeaseRef: value.iphone_device_lease_ref as never,
        }, bearer);
        return { operation: 'watch_binding', pair_state: { pair_version: pairState.pairVersion, status: pairState.status, requires_rebind: pairState.requiresRebind },
          binding: binding === undefined ? null : assertAppleFormalWatchBindingReceipt(binding) };
      }
      binding = await this.#watchBinding.mutateFormal({ action,
      requestId: value.request_id as string, idempotencyKey: value.idempotency_key as string,
      realtimeSessionRef: value.realtime_session_ref as never, iphoneDeviceLeaseRef: value.iphone_device_lease_ref as never,
      expectedPairVersion: value.expected_pair_version as string,
      ...(action === 'revoke' ? {} : { installationId: value.installation_id as string, ttlSeconds: value.ttl_seconds as number }),
    }, bearer);
    } catch (error) {
      if (error instanceof ApplePhysicalCanaryBindingPostgresError) {
        const status = /AUTHORITY_(?:MISMATCH|POLICY_MISMATCH)/u.test(error.code) ? 403
          : /CONFLICT|IN_FLIGHT/u.test(error.code) ? 409 : /INVALID/u.test(error.code) ? 422 : 503;
        fail(error.code, status);
      }
      throw error;
    }
    return { operation: 'watch_binding', binding: assertAppleFormalWatchBindingReceipt(binding) as unknown as JsonRecord };
  }

  async readBootstrapFact(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_REQUEST_INVALID');
    if (parseOperation(value) !== 'bootstrap') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    if (this.#operationReceipts?.read === undefined) fail('PUBLIC_OPERATION_READ_UNAVAILABLE', 503);
    let saved: IdempotencyRecord | undefined;
    try { saved = await this.#operationReceipts.read({ request: value, bearer }); }
    catch (error) {
      if ((error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT') fail('IDEMPOTENCY_CONFLICT', 409);
      throw error;
    }
    const fact: JsonRecord = { operation: 'bootstrap', kind: 'paios.public-operation.read.v1', status: saved?.status ?? 'missing' };
    if (saved?.status !== 'committed') {
      const failure = saved?.response;
      if (failure !== null && typeof failure === 'object' && !Array.isArray(failure)) {
        const value = failure as JsonRecord;
        if (value.schema === 'paios.public-operation.failure.v1' && ['unknown', 'not_executed'].includes(String(value.outcome))) fact.outcome = value.outcome;
      }
      return Object.freeze(fact);
    }
    const stored = record(saved.response, 'PUBLIC_OPERATION_RECEIPT_INVALID');
    const committed = stored.schema === 'paios.public-operation.result.v2'
      ? record(stored.result, 'PUBLIC_OPERATION_RECEIPT_INVALID') : stored;
    // The committed fact carries the binding the device needs to stop what this bootstrap started.
    return Object.freeze({
      realtime_session_ref: record(committed.realtime_session_ref, 'PUBLIC_OPERATION_RECEIPT_INVALID'),
      device_lease_ref: record(committed.device_lease_ref, 'PUBLIC_OPERATION_RECEIPT_INVALID'),
      continuity_id: requiredString(committed.continuity_id, 'PUBLIC_OPERATION_RECEIPT_INVALID'),
      connection_epoch: requiredString(committed.connection_epoch, 'PUBLIC_OPERATION_RECEIPT_INVALID'),
      recipient_device_credential_ref: record(committed.recipient_device_credential_ref, 'PUBLIC_OPERATION_RECEIPT_INVALID'),
      transport_aliases: committed.transport_aliases,
      e2ee_key_envelope: record(committed.e2ee_key_envelope, 'PUBLIC_OPERATION_RECEIPT_INVALID'),
      ...fact,
    });
  }

  async bootstrap(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_REQUEST_INVALID');
    if (parseOperation(value) !== 'bootstrap') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    return this.#executeReceipted(value, bearer, (approved,effectStarted) => this.#bootstrapFresh(value, bearer, approved,effectStarted),
      () => this.#bootstrapConnected?.assertBootstrapRequest?.(value));
  }

  async #bootstrapFresh(request: unknown, bearer: RealtimeBearerContext, approved?: JsonRecord, effectStarted?: () => void): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_BOOTSTRAP_REQUEST_INVALID');
    if (parseOperation(value) !== 'bootstrap') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    const governance = approved ?? governanceOrFail(await this.#governance.evaluate({ operation: 'bootstrap', request: value, bearer }));
    const participant = this.#participantForDevice === undefined ? this.#participant : this.#participantForDevice(bearer.deviceId);
    if (participant === undefined) fail('REALTIME_PARTICIPANT_DEVICE_REQUIRED', 403);
    if (!this.#participants.has(participant)) {
      this.#participants.add(participant);
      if (this.#credentialFenceAdmission !== undefined && participant.setReconnectAdmissionGuard !== undefined) {
        participant.setReconnectAdmissionGuard((binding) => this.verifyCredentialFenceReconnect(binding));
      }
    }
    const generation = Symbol();
    this.#bootstrapGenerations.set(participant, generation);
    const assertCurrent = (): void => {
      this.#assertOpen();
      if (this.#bootstrapGenerations.get(participant) !== generation) fail('REALTIME_BOOTSTRAP_SUPERSEDED', 409);
    };
    if(this.#sessions.publicOperationEffectBoundary!=='v1')effectStarted?.();
    const authority = await this.#sessions.bootstrap({ request: value, bearer, governance, ...(effectStarted===undefined?{}:{effectStarted}) });
    assertCurrent();
    const nowMs = this.#now();
    const credentialTtlSeconds = assertCredentialWindow(nowMs, authority.credential_expires_at, authority.continuity_expires_at);
    const requested = requestMedia(value);
    const enabledMedia = assertMediaAuthorization(value, authority, nowMs, authority.credential_expires_at, authority.continuity_expires_at);
    const authorityContinuity = requiredString(authority.continuity_id, 'REALTIME_CONTINUITY_ID_INVALID');
    const authorityEpoch = decimal(authority.connection_epoch, 'REALTIME_CONNECTION_EPOCH_INVALID');
    if (!equalValue(authority.governance, governance) || !equalValue(authority.governance, value.governance)) fail('REALTIME_GOVERNANCE_BINDING_INVALID', 403);
    const localPrevious = this.#latestByContinuity.get(authorityContinuity);
    const transitionPrevious = value.bootstrap_mode === 'fully_disconnected'
      ? transitionPreviousBinding(authority.binding_transition)
      : undefined;
    if (localPrevious !== undefined && transitionPrevious !== undefined && !sameRuntimePreviousBinding(localPrevious, transitionPrevious)) {
      fail('REALTIME_BINDING_TRANSITION_CAS_INVALID', 409);
    }
    const previous = localPrevious ?? transitionPrevious;
    if (value.bootstrap_mode === 'fully_disconnected') {
      if (value.continuity_id !== authorityContinuity) fail('REALTIME_CONTINUITY_BINDING_INVALID', 403);
      if (previous === undefined) fail('REALTIME_PREVIOUS_BINDING_UNKNOWN', 409);
      if (!Array.isArray(value.transport_aliases) || !equalValue(value.transport_aliases, previous.transportAliases)) fail('REALTIME_PREVIOUS_TRANSPORT_ALIASES_INVALID', 409);
      const transition = authority.binding_transition;
      if (transition?.atomic !== true || transition.provider_session_reused !== false) fail('REALTIME_BINDING_TRANSITION_INVALID', 503);
      const previousEpoch = decimal(transition.previous_connection_epoch, 'REALTIME_PREVIOUS_EPOCH_INVALID');
      if (previous.connectionEpoch !== previousEpoch || equalValue(previous.realtimeSessionRef, authority.realtime_session_ref) || equalValue(previous.deviceLeaseRef, authority.device_lease_ref)) {
        fail('REALTIME_BINDING_TRANSITION_CAS_INVALID', 409);
      }
      if (compareDecimal(authorityEpoch, previousEpoch) <= 0) fail('REALTIME_CONNECTION_EPOCH_NOT_INCREASING', 409);
      const previousContinuityMs = Date.parse(previous.continuityExpiresAt);
      const authorityContinuityMs = Date.parse(authority.continuity_expires_at);
      if (!Number.isSafeInteger(previousContinuityMs) || !Number.isSafeInteger(authorityContinuityMs) || authorityContinuityMs > previousContinuityMs) {
        fail('REALTIME_CONTINUITY_EXPIRY_EXTENDED', 409);
      }
      const oldAliases = previous.transportAliases;
      if (oldAliases.length === 0 || !Array.isArray(authority.transport_aliases) || authority.transport_aliases.length === 0 || equalValue(oldAliases, authority.transport_aliases)) {
        fail('REALTIME_TRANSPORT_ALIASES_NOT_ROTATED', 409);
      }
      const oldSet = new Set(oldAliases.map((alias) => canonicalJson(alias)));
      if (authority.transport_aliases.some((alias) => oldSet.has(canonicalJson(alias)))) fail('REALTIME_TRANSPORT_ALIAS_REUSED', 409);
    } else if (value.continuity_id !== undefined) {
      fail('REALTIME_INITIAL_CONTINUITY_INVALID', 422);
    }
    if (previous !== undefined && value.bootstrap_mode === 'initial') {
      fail('REALTIME_INITIAL_CONTINUITY_REUSE', 409);
    }
    const bindingKeyValue = bindingKey(authority.realtime_session_ref, authority.device_lease_ref, authority.connection_epoch);
    for (const [key, retired] of this.#bindings) {
      if (retired.participant === participant && key !== bindingKeyValue) this.#releaseBinding({
        realtime_session_ref: retired.realtimeSessionRef, device_lease_ref: retired.deviceLeaseRef, connection_epoch: retired.connectionEpoch,
      });
    }
    this.#tokenSigner.assertProjectUrl(authority.server_url);
    const admissionTuple = credentialFenceTuple(
      authority.realtime_session_ref,
      authority.device_lease_ref,
      authority.continuity_id,
      authority.connection_epoch,
      authority.credential_generation,
      this.#credentialFenceAdmission !== undefined,
    );
    const recipientDeviceCredentialRef = this.#deviceCredential === undefined
      ? fail('REALTIME_DEVICE_CREDENTIAL_UNAVAILABLE', 503)
      : record(await this.#deviceCredential.resolve(Object.freeze({ bearer })), 'REALTIME_DEVICE_CREDENTIAL_INVALID');
    const envelope = await this.#e2ee.issue({
      operation: 'bootstrap', request: value,
      realtimeSessionRef: authority.realtime_session_ref,
      continuityId: authority.continuity_id,
      governance: authority.governance,
      credentialExpiresAt: authority.credential_expires_at,
    });
    try {
      assertBootstrapEnvelope(envelope, value, authority, governance, enabledMedia, nowMs, authority.credential_expires_at, authority.continuity_expires_at);
    } catch (error) {
      if (typeof envelope?.release === 'function') {
        try { envelope.release(); } catch { /* resolver cleanup remains best effort */ }
      }
      throw error;
    }
    const envelopeRelease = envelope.release;
    if (typeof envelopeRelease !== 'function') fail('REALTIME_E2EE_RELEASE_REQUIRED', 503);
    let retainedEnvelope = false;
    let releaseRegistered = false;
    let connected = false;
    try {
      const signAndConnect = async (): Promise<{ readonly terminalToken: string }> => {
        assertCurrent();
        const terminalToken = await this.#tokenSigner.sign({
          room: authority.terminal_room_name,
          identity: authority.terminal_identity,
          name: authority.terminal_identity,
          ttlSeconds: credentialTtlSeconds,
          grants: authority.terminal_grants,
        });
        const gatewayToken = authority.gateway.token ?? await this.#tokenSigner.sign({
          room: authority.gateway.roomName,
          identity: authority.gateway.identity,
          name: authority.gateway.identity,
          ttlSeconds: credentialTtlSeconds,
          grants: authority.gateway.grants,
        });
        const participantInput: LiveKitCloudParticipantConnectInput = {
          projectUrl: authority.server_url,
          roomName: authority.gateway.roomName,
          identity: authority.gateway.identity,
          token: gatewayToken,
          grants: authority.gateway.grants,
          binding: {
            realtimeSessionRef: authority.realtime_session_ref,
            deviceLeaseRef: authority.device_lease_ref,
            continuityId: authority.continuity_id,
            transportAliases: authority.transport_aliases,
            connectionEpoch: authority.connection_epoch,
          },
          roomOptions: envelope.roomOptions,
        };
        // One paired device, one live session: an explicit new Start supersedes the session the gateway participant
        // still serves (an app killed mid-session never sent its stop) instead of refusing with a binding conflict.
        assertCurrent();
        const held = participant.snapshot().connected ? participant.bindingSnapshot?.() : undefined;
        if (value.bootstrap_mode === 'initial' && held !== undefined && !equalValue(held, participantInput.binding)) {
          await participant.disconnect();
          this.#releaseBinding({ realtime_session_ref: held.realtimeSessionRef, device_lease_ref: held.deviceLeaseRef,
            connection_epoch: held.connectionEpoch } as JsonRecord);
        }
        assertCurrent();
        this.#participantGenerations.set(participant, generation);
        await participant.connect(participantInput);
        connected = true;
        return { terminalToken };
      };
      const signed = admissionTuple === undefined
        ? await signAndConnect()
        : await this.#credentialFenceAdmission!.withAdmission(admissionTuple, signAndConnect);
      assertCurrent();
      const terminalToken = signed.terminalToken;
      const releases = this.#e2eeReleases.get(bindingKeyValue) ?? new Set<() => void>();
      releases.add(envelopeRelease);
      this.#e2eeReleases.set(bindingKeyValue, releases);
      releaseRegistered = true;
      const attachment:RealtimeBootstrapConnectedInput = {
          request: value,
          bearer,
          governance,
          authority,
          currentBinding: Object.freeze({
            realtimeSessionRef: authority.realtime_session_ref,
            deviceLeaseRef: authority.device_lease_ref,
            continuityId: authorityContinuity,
            connectionEpoch: authorityEpoch,
            transportAliases: Object.freeze([...authority.transport_aliases]),
            credentialRoom: authority.terminal_room_name,
            credentialIdentity: authority.terminal_identity,
            continuityExpiresAt: authority.continuity_expires_at,
            requestedMedia: Object.freeze({ ...requested }),
            enabledMedia: Object.freeze({ ...enabledMedia }),
          }),
          enabledMedia: Object.freeze({ ...enabledMedia }),
        };
      const binding = {
        attachment,roomOptions:envelope.roomOptions,
        participant,
        bootstrapGeneration: generation,
        realtimeSessionRef: authority.realtime_session_ref,
        deviceLeaseRef: authority.device_lease_ref,
        continuityId: authorityContinuity,
        connectionEpoch: authorityEpoch,
        transportAliases: Object.freeze([...authority.transport_aliases]),
        credentialRoom: authority.terminal_room_name,
        credentialIdentity: authority.terminal_identity,
        continuityExpiresAt: authority.continuity_expires_at,
        requestedMedia: requested,
        enabledMedia,
        ...(authority.credential_generation === undefined ? {} : { credentialGeneration: authority.credential_generation }),
        recipientDeviceCredentialRef,
      };
      this.#bindings.set(bindingKeyValue, binding);
      this.#latestByContinuity.set(authorityContinuity, {
        realtimeSessionRef: authority.realtime_session_ref,
        deviceLeaseRef: authority.device_lease_ref,
        connectionEpoch: authorityEpoch,
        transportAliases: binding.transportAliases,
        continuityExpiresAt: authority.continuity_expires_at,
      });
      const bootstrapConnected = this.#bootstrapConnected;
      const descriptor = bootstrapConnected?.centralTextTransportForDevice === undefined
        ? bootstrapConnected?.centralTextTransport : bootstrapConnected.centralTextTransportForDevice(bearer.deviceId);
      if (descriptor !== undefined && (
        descriptor.inputTopic !== 'paios.central.text.v1' ||
        descriptor.outputTopic !== 'paios.central.sealed-text.v1' ||
        !Number.isSafeInteger(descriptor.maxPacketBytes) ||
        descriptor.maxPacketBytes <= 0 || descriptor.maxPacketBytes > 12_288 ||
        descriptor.voiceTransport !== undefined && descriptor.voiceTransport !== 'wav_byte_stream_v1' ||
        descriptor.callRejoinWindowS !== undefined && (!Number.isSafeInteger(descriptor.callRejoinWindowS)||descriptor.callRejoinWindowS<1||descriptor.callRejoinWindowS>2147483)
      )) fail('REALTIME_CENTRAL_TEXT_DESCRIPTOR_INVALID', 503);
      const hook = bootstrapConnected?.onBootstrapConnected ?? bootstrapConnected?.bootstrapConnected;
      if (hook !== undefined) {
        await hook.call(bootstrapConnected, attachment);
      }
      assertCurrent();
      if (this.#bindings.get(bindingKeyValue)?.bootstrapGeneration !== generation) fail('REALTIME_BOOTSTRAP_SUPERSEDED', 409);
      retainedEnvelope = true;
      return Object.freeze({
        operation: 'bootstrap',
        bootstrap_mode: value.bootstrap_mode,
        status: 'bootstrap_accepted',
        request_id: requestId(value),
        realtime_session_ref: authority.realtime_session_ref,
        device_lease_ref: authority.device_lease_ref,
        continuity_id: authority.continuity_id,
        transport_aliases: authority.transport_aliases,
        connection_epoch: authority.connection_epoch,
        livekit: {
          server_url: authority.server_url,
          participant_token: terminalToken,
          credential_expires_at: authority.credential_expires_at,
        },
        media_grants: authority.media_grants,
        e2ee_key_envelope: envelope.envelope,
        governance: authority.governance,
        recipient_device_credential_ref: recipientDeviceCredentialRef,
        ...(descriptor === undefined || hook === undefined ? {} : {
          central_text_transport: {
            schema: 'paios.central.text-transport.v1',
            execution_owner: 'hermes_text',
            expected_gateway_identity: authority.gateway.identity,
            input_topic: descriptor.inputTopic,
            output_topic: descriptor.outputTopic,
            max_packet_bytes: descriptor.maxPacketBytes,
            ...(descriptor.callRejoinWindowS===undefined?{}:{call_rejoin_window_s:descriptor.callRejoinWindowS}),
            ...(descriptor.voiceTransport ? {voice_transport:descriptor.voiceTransport} : {}),
          },
        }),
      });
    } catch (error) {
      if (this.#bindings.get(bindingKeyValue)?.bootstrapGeneration === generation) {
        this.#releaseBinding({ realtime_session_ref: authority.realtime_session_ref, device_lease_ref: authority.device_lease_ref, connection_epoch: authority.connection_epoch });
      }
      if (connected && this.#participantGenerations.get(participant) === generation) await participant.disconnect().catch(() => undefined);
      throw error;
    } finally {
      if (!retainedEnvelope) {
        const releases = this.#e2eeReleases.get(bindingKeyValue);
        if (!releaseRegistered || releases?.delete(envelopeRelease)) {
          try { envelopeRelease(); } catch { /* resolver cleanup remains best effort */ }
        }
        if (releases?.size === 0) this.#e2eeReleases.delete(bindingKeyValue);
      }
    }
  }

  async resolveE2eeKey(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_E2EE_KEY_RESOLVE_REQUEST_INVALID');
    if (parseOperation(value) !== 'realtime_e2ee_key_resolve') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    const governance = governanceOrFail(await this.#governance.evaluate({ operation: 'realtime_e2ee_key_resolve', request: value, bearer }));
    try {
      const binding = this.#bindings.get(bindingKey(value.realtime_session_ref, value.device_lease_ref, value.connection_epoch));
      if (binding?.recipientDeviceCredentialRef !== undefined &&
          !equalValue(binding.recipientDeviceCredentialRef, value.recipient_device_credential_ref)) {
        fail('REALTIME_E2EE_SUCCESSOR_CREDENTIAL_MISMATCH', 409);
      }
      const result = await this.#e2eeCiphertext.resolve({ request: value, bearer, governance });
      const bound = record(result, 'REALTIME_E2EE_KEY_RESULT_INVALID');
      if (bound.status !== 'key_resolved') {
        assertOperationTerminalBinding(bound, 'realtime_e2ee_key_resolve', value);
        const status = bound.status === 'expired' ? 410 : bound.status === 'revoked' ? 403 : 503;
        throw new RealtimePublicControlRuntimeError('REALTIME_E2EE_KEY_RESOLVE_TERMINAL', status, bound);
      }
      assertE2eeBinding(bound, value);
      return bound;
    } catch (error) {
      const terminal = error instanceof RealtimePublicControlRuntimeError ? error.terminalResult : undefined;
      if (terminal !== undefined) {
        const result = record(terminal, 'REALTIME_E2EE_KEY_TERMINAL_INVALID');
        assertOperationTerminalBinding(result, 'realtime_e2ee_key_resolve', value);
        throw error;
      }
      if (error instanceof RealtimePublicControlRuntimeError) throw error;
      const candidate = (error as { readonly terminalResult?: unknown } | undefined)?.terminalResult;
      if (candidate !== undefined) {
        const result = record(candidate, 'REALTIME_E2EE_KEY_TERMINAL_INVALID');
        assertOperationTerminalBinding(result, 'realtime_e2ee_key_resolve', value);
        const status = result.status === 'expired' ? 410 : result.status === 'revoked' ? 403 : 503;
        throw new RealtimePublicControlRuntimeError('REALTIME_E2EE_KEY_RESOLVE_FAILED', status, result);
      }
      throw new RealtimePublicControlRuntimeError('REALTIME_E2EE_KEY_RESOLVE_FAILED', 503);
    }
  }

  async refresh(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    try {return await withinRealtimeReadiness(signal=>this.#refresh(request,bearer,signal));}
    catch(error){
      if((error as {code?:unknown})?.code==='REALTIME_READINESS_DEADLINE')fail('REALTIME_REFRESH_DEADLINE',503);
      throw error;
    }
  }

  async #refresh(request: unknown, bearer: RealtimeBearerContext, signal:AbortSignal): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_REFRESH_REQUEST_INVALID');
    if (parseOperation(value) !== 'connected_credential_refresh') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    if (!Array.isArray(value.transport_aliases) || value.transport_aliases.length === 0) fail('REALTIME_REFRESH_BINDING_MISSING', 422);
    const governance = governanceOrFail(await this.#governance.evaluate({ operation: 'connected_credential_refresh', request: value, bearer }));
    signal.throwIfAborted();
    const authority = await this.#sessions.refresh({ request: value, bearer, governance });
    signal.throwIfAborted();
    if (!equalValue(authority.governance, governance) || !equalValue(authority.governance, value.governance)) fail('REALTIME_GOVERNANCE_BINDING_INVALID', 403);
    assertTupleBinding({
      realtime_session_ref: authority.realtime_session_ref,
      device_lease_ref: authority.device_lease_ref,
      continuity_id: authority.continuity_id,
      connection_epoch: authority.connection_epoch,
      transport_aliases: authority.transport_aliases,
    }, value, true);
    const refreshKey = bindingKey(authority.realtime_session_ref, authority.device_lease_ref, authority.connection_epoch);
    const binding = this.#bindings.get(refreshKey);
    if (binding === undefined) fail('REALTIME_REFRESH_BINDING_UNKNOWN', 409);
    const requestedMedia = binding.requestedMedia;
    const enabledByAuthority = binding.enabledMedia;
    if (authority.credential_input.room !== binding.credentialRoom || authority.credential_input.identity !== binding.credentialIdentity) {
      fail('REALTIME_REFRESH_TRANSPORT_BINDING_INVALID', 409);
    }
    assertCloudGrantContainment(authority.credential_input.grants, requestedMedia, enabledByAuthority, 'REALTIME_REFRESH_GRANTS_INVALID');
    decimal(authority.credential_generation, 'REALTIME_CREDENTIAL_GENERATION_INVALID');
    // As in bootstrap, the runtime owns the signed TTL: it is computed once, here, from the authority's window.
    const credentialInput = { ...authority.credential_input,
      ttlSeconds: assertCredentialWindow(this.#now(), authority.credential_expires_at, binding.continuityExpiresAt) };
    const refreshTuple = credentialFenceTuple(
      binding.realtimeSessionRef,
      binding.deviceLeaseRef,
      binding.continuityId,
      binding.connectionEpoch,
      authority.credential_generation,
      this.#credentialFenceAdmission !== undefined,
    );
    const signCredential = async (): Promise<string> => {
      const credential=await this.#tokenSigner.sign(credentialInput);
      signal.throwIfAborted();
      if(this.#bindings.get(refreshKey)?.bootstrapGeneration!==binding.bootstrapGeneration)fail('REALTIME_REFRESH_BINDING_CHANGED',409);
      if(!binding.participant.snapshot().connected){
        const original=binding.attachment.authority,gateway=original.gateway;
        const token=await this.#tokenSigner.sign({room:gateway.roomName,identity:gateway.identity,name:gateway.identity,
          grants:gateway.grants,ttlSeconds:credentialInput.ttlSeconds});
        signal.throwIfAborted();
        if(this.#bindings.get(refreshKey)?.bootstrapGeneration!==binding.bootstrapGeneration)fail('REALTIME_REFRESH_BINDING_CHANGED',409);
        const cancelConnect=()=>{if(this.#bindings.get(refreshKey)?.bootstrapGeneration===binding.bootstrapGeneration&&this.#bootstrapGenerations.get(binding.participant)===binding.bootstrapGeneration)
          void binding.participant.disconnect().catch(()=>{process.stderr.write('{"refresh_cleanup":"disconnect_failed"}\n');});};
        signal.addEventListener('abort',cancelConnect,{once:true});
        try {await binding.participant.connect({projectUrl:original.server_url,roomName:gateway.roomName,identity:gateway.identity,token,
          grants:gateway.grants,binding:{realtimeSessionRef:binding.realtimeSessionRef,deviceLeaseRef:binding.deviceLeaseRef,
            continuityId:binding.continuityId,connectionEpoch:binding.connectionEpoch,transportAliases:binding.transportAliases},
          roomOptions:binding.roomOptions});}finally{signal.removeEventListener('abort',cancelConnect);}
        signal.throwIfAborted();
      }
      return credential;
    };
    const credential = refreshTuple === undefined
      ? await signCredential()
      : await this.#credentialFenceAdmission!.withAdmission(refreshTuple,()=>settleWithSignal(signCredential,signal));
    signal.throwIfAborted();
    if (this.#bindings.get(refreshKey)?.bootstrapGeneration !== binding.bootstrapGeneration) fail('REALTIME_REFRESH_BINDING_CHANGED', 409);
    this.#bindings.set(refreshKey, Object.freeze({ ...binding, credentialGeneration: authority.credential_generation }));
    // Reattach the accepted source on this binding; a refreshed token alone cannot restore formal ingress.
    const hook=this.#bootstrapConnected?.onBootstrapConnected??this.#bootstrapConnected?.bootstrapConnected;
    if(hook)await hook.call(this.#bootstrapConnected,{...binding.attachment,readinessSignal:signal,authority:{...binding.attachment.authority,
      credential_expires_at:authority.credential_expires_at,credential_generation:authority.credential_generation}});
    signal.throwIfAborted();
    if(this.#bindings.get(refreshKey)?.bootstrapGeneration!==binding.bootstrapGeneration)fail('REALTIME_REFRESH_BINDING_CHANGED',409);
    const callRejoin=this.#bootstrapConnected?.callRejoinForDevice?.(bearer.deviceId);
    const output = {
      operation: 'connected_credential_refresh',
      status: 'credential_refreshed',
      request_id: requestId(value),
      realtime_session_ref: authority.realtime_session_ref,
      device_lease_ref: authority.device_lease_ref,
      continuity_id: authority.continuity_id,
      transport_aliases: authority.transport_aliases,
      connection_epoch: authority.connection_epoch,
      ...(callRejoin?{call_rejoin:callRejoin}:{}),
      transport_credential: {
        credential,
        expires_at: authority.credential_expires_at,
        credential_generation: authority.credential_generation,
      },
      governance: authority.governance,
    };
    return Object.freeze(output);
  }

  async stop(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_REQUEST_INVALID');
    if (parseOperation(value) !== 'media_stop') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    // Stop is idempotent under the external-effect coordinator, which alone decides whether a retry re-executes.
    return this.#executeReceipted(value, bearer, (approved,effectStarted) => this.#stopFresh(value, bearer, approved,effectStarted),
      undefined, 'idempotent_effect_v1');
  }

  async #stopFresh(request: unknown, bearer: RealtimeBearerContext, approved?: JsonRecord, effectStarted?: () => void): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_STOP_REQUEST_INVALID');
    if (parseOperation(value) !== 'media_stop') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    const governance = approved ?? governanceOrFail(await this.#governance.evaluate({ operation: 'media_stop', request: value, bearer }));
    if(this.#mediaStop.publicOperationEffectBoundary!=='v1')effectStarted?.();
    const claim = await this.#mediaStop.claim({ request: value, bearer, governance, ...(effectStarted===undefined?{}:{effectStarted}) });
    if (claim.alreadyCompleted !== undefined) {
      const terminal = assertStopTerminalResult(claim.alreadyCompleted, value);
      this.#releaseBinding(value);
      return terminal;
    }

    const completedStages: MediaCleanupStage[] = [];
    const failedStages: { stage: MediaCleanupStage; code: string }[] = [];
    const operations: readonly { readonly stage: MediaCleanupStage; readonly run?: () => Promise<void> }[] = [
      { stage: 'tracks_unpublished', run: () => this.#mediaStop.unpublishAllTracks(claim.claimId) },
      { stage: 'participant_disconnected', run: () => this.#mediaStop.disconnectParticipant(claim.claimId) },
      {
        stage: 'credential_revoked',
        ...(this.#mediaStop.revokeCredential === undefined ? {} : {
          run: () => this.#mediaStop.revokeCredential!(claim.claimId),
        }),
      },
      {
        stage: 'closure_verified',
        ...(this.#mediaStop.verifyMediaClosed === undefined ? {} : {
          run: () => this.#mediaStop.verifyMediaClosed!(claim.claimId),
        }),
      },
    ];
    for (const operation of operations) {
      if (operation.run === undefined) continue;
      try {
        await operation.run();
        completedStages.push(operation.stage);
      } catch (error) {
        failedStages.push({ stage: operation.stage, code: failureCode(error) });
        try { process.stderr.write(`${JSON.stringify({ media_stop_stage_failed: operation.stage, safeErrorCode: failureCode(error) })}\n`); } catch {}
      }
    }
    try {
      const result = await this.#mediaStop.complete(claim.claimId, { completedStages, failedStages });
      return assertStopTerminalResult(result, value);
    } finally {
      this.#releaseBinding(value);
    }
  }

  async endContinuity(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_END_CONTINUITY_REQUEST_INVALID');
    if (parseOperation(value) !== 'end_continuity') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    // Ending is a terminal operation: its complete receipt replays the durable terminal for the same request and
    // identity (a lost response), where re-running the owner preflight would refuse the already-ended continuity.
    return this.#executeReceipted(value, bearer, (approved, effectStarted) => this.#endContinuityFresh(value, bearer, approved, effectStarted));
  }

  async #endContinuityFresh(value: JsonRecord, bearer: RealtimeBearerContext, approved?: JsonRecord, effectStarted?: () => void): Promise<JsonRecord> {
    this.#assertOpen();
    const governance = approved ?? governanceOrFail(await this.#governance.evaluate({ operation: 'end_continuity', request: value, bearer }));
    if (this.#sessions.publicOperationEffectBoundary !== 'v1') effectStarted?.();
    const result = await this.#sessions.endContinuity({ request: value, bearer, governance, ...(effectStarted === undefined ? {} : { effectStarted }) });
    assertOperationTerminalBinding(result, 'end_continuity', value);
    if (result.status === 'success') this.#releaseBinding(value);
    return result;
  }

  async handoff(request: unknown, bearer: RealtimeBearerContext): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_REQUEST_INVALID');
    if (parseOperation(value) !== 'handoff') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    return this.#executeReceipted(value, bearer, (approved,effectStarted) => this.#handoffFresh(value, bearer, approved,effectStarted));
  }

  async #handoffFresh(request: unknown, bearer: RealtimeBearerContext, approved?: JsonRecord, effectStarted?: () => void): Promise<JsonRecord> {
    this.#assertOpen();
    const value = record(request, 'REALTIME_HANDOFF_REQUEST_INVALID');
    if (parseOperation(value) !== 'handoff') fail('REALTIME_OPERATION_ROUTE_MISMATCH', 422);
    const governance = approved ?? governanceOrFail(await this.#governance.evaluate({ operation: 'handoff', request: value, bearer }));
    const directHandoff = this.#handoff;
    const sessionHandoff = this.#sessions.handoff;
    if (directHandoff === undefined && typeof sessionHandoff !== 'function') fail('REALTIME_HANDOFF_UNAVAILABLE', 503);
    if((directHandoff??this.#sessions).publicOperationEffectBoundary!=='v1')effectStarted?.();
    try {
      const ownerResult = directHandoff === undefined
        ? await sessionHandoff!({ request: value, bearer, governance, ...(effectStarted===undefined?{}:{effectStarted}) })
        : await directHandoff.handoff({ request: value, bearer, governance, ...(effectStarted===undefined?{}:{effectStarted}) });
      const result = record(ownerResult, 'REALTIME_HANDOFF_TERMINAL_INVALID');
      assertHandoffTerminalResult(result, value);
      if (result.status === 'success') this.#releaseBinding({ ...value, device_lease_ref: value.current_device_lease_ref });
      return result;
    } catch (error) {
      const terminal = (error as { readonly terminalResult?: unknown } | undefined)?.terminalResult;
      if (terminal !== undefined) {
        const result = record(terminal, 'REALTIME_HANDOFF_TERMINAL_INVALID');
        assertHandoffTerminalResult(result, value);
        throw error;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    this.#closed = true;
    this.#closeFlight = (async () => {
      const failures: Error[] = [];
      const attempt = async (name: string, action: () => void | Promise<void>): Promise<void> => {
        try { await action(); } catch (error) { failures.push(new Error(name,{cause:error})); }
      };
      for (const participant of this.#participants) await attempt('participant', () => participant.close());
      this.#releaseBinding();
      this.#participants.clear();
      await attempt('e2ee', () => this.#e2ee.close?.());
      await attempt('media_stop', () => this.#mediaStop.close?.());
      await attempt('sessions', () => this.#sessions.close?.());
      if (this.#handoff !== undefined && this.#handoff !== this.#sessions) {
        await attempt('handoff', () => this.#handoff?.close?.());
      }
      await attempt('e2ee_ciphertext', () => this.#e2eeCiphertext.close?.());
      await attempt('token_signer', () => this.#tokenSigner.close());
      if (this.#bootstrapConnected?.ownsClose !== false) {
        await attempt('bootstrap_connected', () => this.#bootstrapConnected?.close?.());
      }
      await attempt('device_credential', () => this.#deviceCredential?.close?.());
      if (this.#credentialFenceAdmission?.ownsClose !== false) {
        await attempt('credential_fence_admission', () => this.#credentialFenceAdmission?.close?.());
      }
      if (failures.length !== 0) throw new AggregateError(failures,'REALTIME_RUNTIME_CLOSE_FAILED');
    })();
    return this.#closeFlight;
  }

  #assertOpen(): void {
    if (this.#closed) fail('REALTIME_RUNTIME_CLOSED', 503);
  }

  #releaseBinding(binding?: JsonRecord): void {
    const keys = binding === undefined
      ? [...new Set([...this.#e2eeReleases.keys(), ...this.#bindings.keys()])]
      : binding.device_lease_ref === undefined
        ? [...this.#bindings].filter(([, current]) => equalValue(current.realtimeSessionRef, binding.realtime_session_ref) && current.connectionEpoch === binding.connection_epoch).map(([key]) => key)
        : [bindingKey(binding.realtime_session_ref, binding.device_lease_ref, binding.connection_epoch)];
    for (const key of keys) {
      const current = this.#bindings.get(key);
      if (current !== undefined) {
        this.#bindings.delete(key);
        const latest = this.#latestByContinuity.get(current.continuityId);
        if (latest !== undefined && bindingKey(latest.realtimeSessionRef, latest.deviceLeaseRef, latest.connectionEpoch) === key) this.#latestByContinuity.delete(current.continuityId);
      }
      const releases = this.#e2eeReleases.get(key);
      if (releases === undefined) continue;
      for (const release of releases) {
        try { release(); } catch { /* owner cleanup remains authoritative */ }
      }
      this.#e2eeReleases.delete(key);
    }
  }
}

export const createRealtimePublicControlRuntime = (
  options: RealtimePublicControlRuntimeOptions,
): RealtimePublicControlRuntime => new RealtimePublicControlRuntime(options);
