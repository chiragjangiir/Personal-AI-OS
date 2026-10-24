/**
 * Internal adapter for the T01 realtime successor control profile.
 *
 * The caller supplies T01-validated projections and owner ports.  This module
 * does not parse or reproduce canonical JSON, open an HTTP listener, mint
 * PostgreSQL identities, or expose E2EE key bytes.
 */

import {
  assertCanonicalLiveKitCloudProjectUrl,
} from './livekit-cloud-adapter.ts';
import {
  StopCoordinator,
  type InternalMediaStopRequest,
  type MediaClosureFacts,
} from './stop-coordinator.ts';
import type {
  DecimalConnectionEpoch,
  DecimalCredentialGeneration,
  RealtimeAuthorityBootstrapResult,
  RealtimeAuthorityPort,
  RealtimeAuthorityRefreshResult,
  RealtimeBootstrapProjection,
  RealtimeE2eeRoomOptionsResolverPort,
  RealtimeEndContinuityProjection,
  RealtimeGovernanceContext,
  RealtimeEffectiveMediaPolicy,
  RealtimeMediaGrants,
  RealtimeMediaStopProjection,
  RealtimeMediaTransportPort,
  RealtimeRefreshProjection,
  RealtimeBindingEquality,
  RealtimeStopTerminalProjector,
  RealtimeTerminalProjection,
  RealtimeTerminalStatus,
  RealtimePublicControlProjectionValidator,
  DecimalFencingToken,
  DecimalLeaseVersion,
  RealtimeHandoffAuthorityPort,
  RealtimeHandoffAuthorityResult,
  RealtimeHandoffControlResult,
  RealtimeHandoffCurrentBinding,
  RealtimeHandoffCurrentBindingPort,
  RealtimeHandoffDurableReplayClaim,
  RealtimeHandoffDurableReplayPort,
  RealtimeHandoffExecutionFacts,
  RealtimeHandoffOutputFencePort,
  RealtimeHandoffOutputFenceResult,
  RealtimeHandoffProjection,
  RealtimeHandoffTerminalProjection,
} from './realtime-public-control-ports.ts';
import {
  assertConnectionEpoch,
  assertCredentialGeneration,
  assertExpiryWindow,
  assertFencingToken,
  assertIdempotencyKey,
  assertLeaseVersion,
  createObjectIdentityBindingEquality,
  parseExpiryEpochMs,
} from './realtime-public-control-ports.ts';
import type {
  InternalRoomOptionsReference,
} from './types.ts';

export type RealtimePublicControlErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_BINDING'
  | 'INVALID_PROJECT_URL'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_EXPIRY'
  | 'INVALID_MEDIA_GRANT'
  | 'INVALID_E2EE_ENVELOPE'
  | 'AUTHORITY_FAILED'
  | 'E2EE_RESOLUTION_FAILED'
  | 'TRANSPORT_CONNECT_FAILED'
  | 'TRANSPORT_REFRESH_UNAVAILABLE'
  | 'TRANSPORT_REFRESH_FAILED'
  | 'STOP_FAILED'
  | 'END_CONTINUITY_UNAVAILABLE'
  | 'HANDOFF_UNAVAILABLE'
  | 'HANDOFF_CURRENT_BINDING_UNAVAILABLE'
  | 'HANDOFF_AUTHORITY_FAILED'
  | 'HANDOFF_REPLAY_UNAVAILABLE'
  | 'HANDOFF_IDEMPOTENCY_CONFLICT'
  | 'HANDOFF_IN_FLIGHT'
  | 'HANDOFF_INDETERMINATE'
  | 'HANDOFF_BINDING_INVALID'
  | 'HANDOFF_TRANSITION_INVALID'
  | 'HANDOFF_OUTPUT_FENCE_INVALID'
  | 'HANDOFF_TERMINAL_INVALID';

export class RealtimePublicControlError extends Error {
  readonly code: RealtimePublicControlErrorCode;

  constructor(code: RealtimePublicControlErrorCode) {
    super(code);
    this.name = 'RealtimePublicControlError';
    this.code = code;
  }
}

function fail(code: RealtimePublicControlErrorCode): never {
  throw new RealtimePublicControlError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const FORBIDDEN_HANDOFF_KEYS = new Set([
  'api_key',
  'api_secret',
  'password',
  'plaintext',
  'plaintext_key',
  'private',
  'privatekey',
  'private_key',
  'key_material',
  'keymaterial',
  'room_options',
  'roomoptions',
  'token',
  'participant_token',
  'secret',
  'secret_key',
  'secretkey',
  'content_key',
  'contentkey',
  'delivery_receipt',
  'deliveryreceipt',
]);

/** Stable local fingerprinting only; durable owner remains the replay authority. */
function stableHandoffValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('HANDOFF_FINGERPRINT_INVALID');
    return value;
  }
  if (value === undefined) throw new Error('HANDOFF_FINGERPRINT_INVALID');
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('HANDOFF_FINGERPRINT_CYCLE');
    ancestors.add(value);
    const result = value.map((item) => stableHandoffValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value !== 'object') throw new Error('HANDOFF_FINGERPRINT_INVALID');
  if (ancestors.has(value)) throw new Error('HANDOFF_FINGERPRINT_CYCLE');
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = stableHandoffValue((value as Record<string, unknown>)[key], ancestors);
  }
  ancestors.delete(value);
  return result;
}

function stableHandoffJson(value: unknown): string {
  const encoded = JSON.stringify(stableHandoffValue(value));
  if (encoded === undefined || encoded.length === 0 || encoded.length > 262_144) {
    throw new Error('HANDOFF_FINGERPRINT_INVALID');
  }
  return encoded;
}

function assertNoHandoffSecrets(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) throw new Error('HANDOFF_SECRET_OR_CYCLE');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoHandoffSecrets(item, ancestors);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_HANDOFF_KEYS.has(key.toLowerCase())) throw new Error('HANDOFF_SECRET_OR_RECEIPT');
      assertNoHandoffSecrets(item, ancestors);
    }
  }
  ancestors.delete(value);
}

function sameOpaqueValue(left: unknown, right: unknown): boolean {
  try {
    return stableHandoffJson(left) === stableHandoffJson(right);
  } catch {
    return Object.is(left, right);
  }
}

function assertRequestIdentity(requestId: unknown, idempotencyKey: unknown): string {
  try {
    const request = assertIdempotencyKey(requestId);
    const idempotency = assertIdempotencyKey(idempotencyKey);
    if (request !== idempotency) fail('INVALID_REQUEST');
    return request;
  } catch (error) {
    if (error instanceof RealtimePublicControlError) throw error;
    fail('INVALID_REQUEST');
  }
}

function assertHandoffRequestProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
>(
  request: RealtimeHandoffProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >,
): void {
  if (request.operation !== 'handoff') fail('INVALID_REQUEST');
  assertRequestIdentity(request.requestId, request.idempotencyKey);
  if (request.realtimeSessionRef === undefined
    || request.currentDeviceLeaseRef === undefined
    || request.continuityId === undefined
    || request.fromDeviceId === undefined
    || request.toDeviceId === undefined
    || request.governance === undefined) {
    fail('INVALID_REQUEST');
  }
  try {
    assertConnectionEpoch(request.connectionEpoch);
    assertLeaseVersion(request.expectedLeaseVersion);
  } catch {
    fail('INVALID_BINDING');
  }
  try {
    assertNoHandoffSecrets(request);
    stableHandoffJson(request);
  } catch {
    fail('INVALID_REQUEST');
  }
  if (sameOpaqueValue(request.fromDeviceId, request.toDeviceId)) fail('INVALID_BINDING');
  if (request.idempotencyContext !== undefined) {
    if (!isRecord(request.idempotencyContext)
      || request.idempotencyContext.idempotency_key !== request.idempotencyKey) {
      fail('INVALID_REQUEST');
    }
  }
}

function nowMs(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) fail('INVALID_EXPIRY');
  return value;
}

function assertBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
>(binding: {
  readonly realtimeSessionRef: TSessionRef;
  readonly deviceLeaseRef: TLeaseRef;
  readonly continuityId: TContinuityId;
  readonly transportAliases: readonly TAlias[];
  readonly connectionEpoch: DecimalConnectionEpoch;
}) {
  if (binding.realtimeSessionRef === undefined
    || binding.deviceLeaseRef === undefined
    || binding.continuityId === undefined
    || binding.transportAliases.length === 0) {
    fail('INVALID_BINDING');
  }
  try {
    assertConnectionEpoch(binding.connectionEpoch);
  } catch {
    fail('INVALID_BINDING');
  }
  return binding;
}

function assertExpiry(
  value: string,
  now: number,
  continuityExpiry: number,
): number {
  try {
    return assertExpiryWindow(now, parseExpiryEpochMs(value), continuityExpiry);
  } catch {
    fail('INVALID_EXPIRY');
  }
}

function assertContinuityExpiry(value: string, now: number): number {
  try {
    const expiry = parseExpiryEpochMs(value);
    if (expiry <= now) fail('INVALID_EXPIRY');
    return expiry;
  } catch (error) {
    if (error instanceof RealtimePublicControlError) throw error;
    fail('INVALID_EXPIRY');
  }
}

function assertToken(value: unknown): void {
  if (typeof value !== 'string' || value.length < 1 || /[\u0000-\u001f\u007f\s]/u.test(value)) {
    fail('INVALID_CREDENTIAL');
  }
}

function assertGrant< TDeviceId, TLeaseRef>(
  kind: 'audio' | 'video' | 'data',
  intent: { readonly audio: boolean; readonly video: boolean; readonly data: boolean },
  modalities: readonly ('audio' | 'video' | 'data')[],
  expectedDevice: TDeviceId,
  expectedLease: TLeaseRef,
  grant: {
    readonly enabled: boolean;
    readonly deviceId?: TDeviceId;
    readonly deviceLeaseRef?: TLeaseRef;
    readonly startModalities?: readonly ('audio' | 'video' | 'data')[];
    readonly expiresAt?: string;
  },
  now: number,
  continuityExpiry: number,
  equality: Pick<RealtimeBindingEquality<unknown, TLeaseRef, unknown, unknown, TDeviceId>, 'sameLeaseRef' | 'sameDeviceId'>,
): void {
  if (!grant.enabled) {
    if (grant.deviceId !== undefined
      || grant.deviceLeaseRef !== undefined
      || grant.startModalities !== undefined
      || grant.expiresAt !== undefined) {
      fail('INVALID_MEDIA_GRANT');
    }
    return;
  }
  if (!intent[kind] || !modalities.includes(kind)) fail('INVALID_MEDIA_GRANT');
  if (grant.deviceId === undefined
    || grant.deviceLeaseRef === undefined
    || !equality.sameDeviceId(grant.deviceId, expectedDevice)
    || !equality.sameLeaseRef(grant.deviceLeaseRef, expectedLease)
    || grant.expiresAt === undefined) {
    fail('INVALID_MEDIA_GRANT');
  }
  if (grant.startModalities !== undefined && !grant.startModalities.includes(kind)) {
    fail('INVALID_MEDIA_GRANT');
  }
  assertExpiry(grant.expiresAt, now, continuityExpiry);
}

function assertAllGrants<TDeviceId, TLeaseRef>(
  intent: { readonly audio: boolean; readonly video: boolean; readonly data: boolean },
  modalities: readonly ('audio' | 'video' | 'data')[],
  deviceId: TDeviceId,
  lease: TLeaseRef,
  grants: RealtimeMediaGrants<TDeviceId, TLeaseRef>,
  now: number,
  continuityExpiry: number,
  equality: Pick<RealtimeBindingEquality<unknown, TLeaseRef, unknown, unknown, TDeviceId>, 'sameLeaseRef' | 'sameDeviceId'>,
): RealtimeEffectiveMediaPolicy {
  assertGrant('audio', intent, modalities, deviceId, lease, grants.audio, now, continuityExpiry, equality);
  assertGrant('video', intent, modalities, deviceId, lease, grants.video, now, continuityExpiry, equality);
  assertGrant('data', intent, modalities, deviceId, lease, grants.data, now, continuityExpiry, equality);
  return Object.freeze({
    canPublishSources: Object.freeze([
      ...(grants.audio.enabled ? ['microphone' as const] : []),
      ...(grants.video.enabled ? ['camera' as const] : []),
    ]),
    canPublishData: grants.data.enabled,
  });
}

function assertEnvelope<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
>(
  envelope: {
    readonly envelopeRef: TEnvelopeRef;
    readonly keyIndex: number;
    readonly generation: DecimalCredentialGeneration;
    readonly expiresAt: string;
    readonly realtimeSessionRef: TSessionRef;
    readonly continuityId: TContinuityId;
    readonly deviceId: TDeviceId;
    readonly channels: readonly ('audio' | 'video' | 'data')[];
    readonly governance: TGovernance;
  },
  binding: { readonly realtimeSessionRef: TSessionRef; readonly continuityId: TContinuityId },
  deviceId: TDeviceId,
  now: number,
  continuityExpiry: number,
  equality: Pick<RealtimeBindingEquality<TSessionRef, unknown, TContinuityId, unknown, TDeviceId>, 'sameSessionRef' | 'sameContinuityId' | 'sameDeviceId'>,
): void {
  if (!equality.sameSessionRef(envelope.realtimeSessionRef, binding.realtimeSessionRef)
    || !equality.sameContinuityId(envelope.continuityId, binding.continuityId)
    || !equality.sameDeviceId(envelope.deviceId, deviceId)
    || !Number.isSafeInteger(envelope.keyIndex)
    || envelope.keyIndex < 0
    || envelope.channels.length === 0) {
    fail('INVALID_E2EE_ENVELOPE');
  }
  try {
    assertCredentialGeneration(envelope.generation);
    assertExpiryWindow(now, parseExpiryEpochMs(envelope.expiresAt), continuityExpiry);
  } catch {
    fail('INVALID_E2EE_ENVELOPE');
  }
}

function assertSameBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
>(
  expected: {
    readonly realtimeSessionRef: TSessionRef;
    readonly deviceLeaseRef: TLeaseRef;
    readonly continuityId: TContinuityId;
    readonly transportAliases: readonly TAlias[];
    readonly connectionEpoch: DecimalConnectionEpoch;
  },
  actual: typeof expected,
  equality: RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, TAlias, unknown>,
): void {
  if (!equality.sameSessionRef(expected.realtimeSessionRef, actual.realtimeSessionRef)
    || !equality.sameLeaseRef(expected.deviceLeaseRef, actual.deviceLeaseRef)
    || !equality.sameContinuityId(expected.continuityId, actual.continuityId)
    || expected.transportAliases.length !== actual.transportAliases.length
    || !expected.transportAliases.every((alias, index) => {
      const actualAlias = actual.transportAliases[index];
      return actualAlias !== undefined && equality.sameAlias(alias, actualAlias);
    })
    || expected.connectionEpoch !== actual.connectionEpoch) {
    fail('INVALID_BINDING');
  }
}

function assertHandoffCurrentBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
>(
  request: RealtimeHandoffProjection<TSessionRef, TLeaseRef, TContinuityId, TDeviceId, TGovernance>,
  current: RealtimeHandoffCurrentBinding<TSessionRef, TLeaseRef, TContinuityId, TDeviceId>,
  equality: Pick<RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, unknown, TDeviceId>, 'sameSessionRef' | 'sameLeaseRef' | 'sameContinuityId' | 'sameDeviceId'>,
): void {
  try {
    assertConnectionEpoch(current.connectionEpoch);
    assertLeaseVersion(current.leaseVersion);
  } catch {
    fail('HANDOFF_BINDING_INVALID');
  }
  if (current.state !== undefined && current.state !== 'active') fail('HANDOFF_BINDING_INVALID');
  if (!equality.sameSessionRef(request.realtimeSessionRef, current.realtimeSessionRef)
    || !equality.sameLeaseRef(request.currentDeviceLeaseRef, current.deviceLeaseRef)
    || !equality.sameContinuityId(request.continuityId, current.continuityId)
    || current.connectionEpoch !== request.connectionEpoch
    || current.leaseVersion !== request.expectedLeaseVersion
    || !equality.sameDeviceId(request.fromDeviceId, current.deviceId)) {
    fail('HANDOFF_BINDING_INVALID');
  }
}

function assertHandoffAuthorityBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence,
>(
  request: RealtimeHandoffProjection<TSessionRef, TLeaseRef, TContinuityId, TDeviceId, TGovernance>,
  authority: RealtimeHandoffAuthorityResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  equality: Pick<RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, unknown, TDeviceId>, 'sameSessionRef' | 'sameLeaseRef' | 'sameContinuityId' | 'sameDeviceId'>,
): void {
  if (authority.requestId !== request.requestId || authority.idempotencyKey !== request.idempotencyKey
    || !equality.sameSessionRef(request.realtimeSessionRef, authority.realtimeSessionRef)
    || !equality.sameContinuityId(request.continuityId, authority.continuityId)
    || authority.connectionEpoch !== request.connectionEpoch
    || !equality.sameDeviceId(request.fromDeviceId, authority.fromDeviceId)
    || !equality.sameDeviceId(request.toDeviceId, authority.toDeviceId)) {
    fail('HANDOFF_BINDING_INVALID');
  }
  if (authority.governance !== undefined && !sameOpaqueValue(authority.governance, request.governance)) {
    fail('HANDOFF_BINDING_INVALID');
  }
  const oldLease = authority.previousDeviceLease;
  const newLease = authority.newDeviceLease;
  try {
    assertLeaseVersion(oldLease.version);
    assertLeaseVersion(newLease.version);
    if (newLease.fencingToken !== undefined) assertFencingToken(newLease.fencingToken);
  } catch {
    fail('HANDOFF_TRANSITION_INVALID');
  }
  if (!equality.sameLeaseRef(request.currentDeviceLeaseRef, oldLease.ref)
    || oldLease.version !== request.expectedLeaseVersion
    || equality.sameLeaseRef(oldLease.ref, newLease.ref)) {
    fail('HANDOFF_TRANSITION_INVALID');
  }
}

function assertHandoffOutcomeStatus<TOutcome>(status: RealtimeTerminalStatus, outcome: TOutcome): void {
  if (!isRecord(outcome)) return;
  const outcomeClass = outcome.outcome_class;
  if (status === 'success' && outcomeClass !== undefined && outcomeClass !== 'committed_success') {
    fail('HANDOFF_TERMINAL_INVALID');
  }
  if (status !== 'success' && outcomeClass === 'committed_success') fail('HANDOFF_TERMINAL_INVALID');
}

function assertHandoffExecutionFacts(facts: RealtimeHandoffExecutionFacts, success: boolean): void {
  if (facts.closureStatus === undefined || (success && !Array.isArray(facts.evidenceRefs))) {
    fail('HANDOFF_TERMINAL_INVALID');
  }
  assertNoHandoffSecrets(facts);
  const evidenceRefs = facts.evidenceRefs;
  if (success && (facts.closureStatus !== 'verified_closed'
    || facts.deviceLeaseRelease !== 'released'
    || evidenceRefs === undefined
    || evidenceRefs.length === 0)) {
    fail('HANDOFF_OUTPUT_FENCE_INVALID');
  }
}

function assertHandoffTerminalBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence,
>(
  request: RealtimeHandoffProjection<TSessionRef, TLeaseRef, TContinuityId, TDeviceId, TGovernance>,
  terminal: RealtimeHandoffTerminalProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  equality: Pick<RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, unknown, TDeviceId>, 'sameSessionRef' | 'sameLeaseRef' | 'sameContinuityId' | 'sameDeviceId'>,
): void {
  if (terminal.operation !== 'handoff' || terminal.requestId !== request.requestId
    || !equality.sameSessionRef(request.realtimeSessionRef, terminal.realtimeSessionRef)
    || !equality.sameLeaseRef(request.currentDeviceLeaseRef, terminal.previousDeviceLeaseRef)
    || !equality.sameContinuityId(request.continuityId, terminal.continuityId)
    || terminal.connectionEpoch !== request.connectionEpoch
    || !equality.sameDeviceId(request.fromDeviceId, terminal.fromDeviceId)
    || !equality.sameDeviceId(request.toDeviceId, terminal.toDeviceId)
    || !sameOpaqueValue(request.governance, terminal.governance)) {
    fail('HANDOFF_TERMINAL_INVALID');
  }
  assertHandoffOutcomeStatus(terminal.status, terminal.operationOutcome);
  assertHandoffExecutionFacts(terminal.executionFacts, terminal.status === 'success');
  assertNoHandoffSecrets(terminal);
}

function handoffExecutionFacts<
  TOutcome,
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TResultRef,
  TOutputFence,
>(
  authority: RealtimeHandoffAuthorityResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  fence: RealtimeHandoffOutputFenceResult<TOutputFence>,
): RealtimeHandoffExecutionFacts {
  if (fence.state !== 'old_device_suppressed'
    || fence.closureStatus !== 'verified_closed'
    || fence.fence === undefined
    || !Array.isArray(fence.evidenceRefs)
    || fence.evidenceRefs.length === 0
    || authority.previousDeviceLease.state !== 'released'
    || authority.newDeviceLease.state !== 'active'
    || authority.newDeviceLease.fencingToken === undefined) {
    fail('HANDOFF_OUTPUT_FENCE_INVALID');
  }
  try {
    assertFencingToken(authority.newDeviceLease.fencingToken);
    assertNoHandoffSecrets(fence);
  } catch {
    fail('HANDOFF_OUTPUT_FENCE_INVALID');
  }
  const derived: RealtimeHandoffExecutionFacts = Object.freeze({
    closureStatus: fence.closureStatus,
    deviceLeaseRelease: 'released',
    participantCleanup: fence.participantCleanup ?? 'not_requested',
    trackCleanup: fence.trackCleanup ?? 'not_requested',
    roomCleanup: fence.roomCleanup ?? 'not_requested',
    evidenceRefs: Object.freeze([...fence.evidenceRefs]),
  });
  if (authority.executionFacts !== undefined) {
    assertHandoffExecutionFacts(authority.executionFacts, true);
    if (authority.executionFacts.closureStatus !== derived.closureStatus
      || authority.executionFacts.deviceLeaseRelease !== derived.deviceLeaseRelease
      || !sameOpaqueValue(authority.executionFacts.evidenceRefs, derived.evidenceRefs)) {
      fail('HANDOFF_OUTPUT_FENCE_INVALID');
    }
    return authority.executionFacts;
  }
  return derived;
}

function buildHandoffSuccessTerminal<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence,
>(
  request: RealtimeHandoffProjection<TSessionRef, TLeaseRef, TContinuityId, TDeviceId, TGovernance>,
  authority: RealtimeHandoffAuthorityResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  fence: RealtimeHandoffOutputFenceResult<TOutputFence>,
): RealtimeHandoffTerminalProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence
> {
  const facts = handoffExecutionFacts(authority, fence);
  if (authority.newDeviceLease.fencingToken === undefined) fail('HANDOFF_TRANSITION_INVALID');
  const terminal: RealtimeHandoffTerminalProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  > = Object.freeze({
    operation: 'handoff',
    status: 'success',
    requestId: request.requestId,
    realtimeSessionRef: authority.realtimeSessionRef,
    deviceLeaseRef: authority.newDeviceLease.ref,
    previousDeviceLeaseRef: authority.previousDeviceLease.ref,
    continuityId: authority.continuityId,
    connectionEpoch: authority.connectionEpoch,
    fromDeviceId: authority.fromDeviceId,
    toDeviceId: authority.toDeviceId,
    leaseVersion: authority.newDeviceLease.version,
    fencingToken: authority.newDeviceLease.fencingToken,
    ...(fence.fence === undefined ? {} : { oldDeviceSuppressionFence: fence.fence }),
    operationOutcome: authority.operationOutcome,
    ...(authority.recordedResultReference === undefined
      ? {}
      : { recordedResultReference: authority.recordedResultReference }),
    executionFacts: facts,
    governance: request.governance,
  });
  return terminal;
}

function assertHandoffControlResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence,
>(
  request: RealtimeHandoffProjection<TSessionRef, TLeaseRef, TContinuityId, TDeviceId, TGovernance>,
  result: RealtimeHandoffControlResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  equality: Pick<RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, unknown, TDeviceId>, 'sameSessionRef' | 'sameLeaseRef' | 'sameContinuityId' | 'sameDeviceId'>,
): void {
  assertHandoffTerminalBinding(request, result.terminal, equality);
  assertHandoffExecutionFacts(result.executionFacts, result.terminal.status === 'success');
  if (!sameOpaqueValue(result.executionFacts, result.terminal.executionFacts)) {
    fail('HANDOFF_TERMINAL_INVALID');
  }
  if (result.terminal.status === 'success') {
    if (result.outputFence === undefined || result.terminal.oldDeviceSuppressionFence === undefined
      || !sameOpaqueValue(result.outputFence, result.terminal.oldDeviceSuppressionFence)) {
      fail('HANDOFF_OUTPUT_FENCE_INVALID');
    }
  }
  if (result.recordedResultReference !== undefined
    && result.terminal.recordedResultReference !== undefined
    && !sameOpaqueValue(result.recordedResultReference, result.terminal.recordedResultReference)) {
    fail('HANDOFF_TERMINAL_INVALID');
  }
  assertNoHandoffSecrets(result);
}

function assertHandoffAuthorityTerminalTransition<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence,
>(
  request: RealtimeHandoffProjection<TSessionRef, TLeaseRef, TContinuityId, TDeviceId, TGovernance>,
  authority: RealtimeHandoffAuthorityResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  fence: RealtimeHandoffOutputFenceResult<TOutputFence>,
  terminal: RealtimeHandoffTerminalProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >,
  equality: Pick<RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, unknown, TDeviceId>, 'sameSessionRef' | 'sameLeaseRef' | 'sameContinuityId' | 'sameDeviceId'>,
): void {
  assertHandoffTerminalBinding(request, terminal, equality);
  if (terminal.status !== 'success'
    || terminal.deviceLeaseRef === undefined
    || terminal.leaseVersion === undefined
    || terminal.fencingToken === undefined
    || terminal.oldDeviceSuppressionFence === undefined
    || !equality.sameLeaseRef(terminal.deviceLeaseRef, authority.newDeviceLease.ref)
    || terminal.leaseVersion !== authority.newDeviceLease.version
    || terminal.fencingToken !== authority.newDeviceLease.fencingToken
    || !sameOpaqueValue(terminal.oldDeviceSuppressionFence, fence.fence)
    || (authority.recordedResultReference !== undefined
      && !sameOpaqueValue(terminal.recordedResultReference, authority.recordedResultReference))) {
    fail('HANDOFF_TERMINAL_INVALID');
  }
}

export interface RealtimeBootstrapControlResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance,
> extends RealtimeAuthorityBootstrapResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance
> {
  readonly disconnect: () => Promise<void>;
  readonly roomOptionsReference: InternalRoomOptionsReference;
  readonly mediaPolicy: RealtimeEffectiveMediaPolicy;
}

export interface RealtimeRefreshControlResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TToken,
> extends RealtimeAuthorityRefreshResult<TSessionRef, TLeaseRef, TContinuityId, TAlias, TToken> {}

export interface RealtimeStopControlResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TOutcome,
  TResultRef,
  TTerminalResult,
> {
  readonly terminal: RealtimeTerminalProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TOutcome,
    TResultRef
  >;
  readonly ownerTerminalResult: TTerminalResult;
}

export interface RealtimeEndContinuityPort<
  TSessionRef,
  TContinuityId,
  TGovernance,
  TOutcome,
  TResultRef,
> {
  endContinuity(input: RealtimeEndContinuityProjection<TSessionRef, TContinuityId, TGovernance>): Promise<{
    readonly status: RealtimeTerminalStatus;
    readonly operationOutcome: TOutcome;
    readonly recordedResultReference?: TResultRef;
  }>;
}

export interface RealtimePublicControlHandoffOptions<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> {
  readonly authority: RealtimeHandoffAuthorityPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
  readonly currentBinding: RealtimeHandoffCurrentBindingPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >;
  readonly outputFence: RealtimeHandoffOutputFencePort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TOutputFence
  >;
  readonly replay: RealtimeHandoffDurableReplayPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
}

export interface RealtimePublicControlAdapterOptions<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance = RealtimeGovernanceContext,
  TOutcome = unknown,
  TResultRef = unknown,
  TTerminalResult = unknown,
  TOutputFence = unknown,
> {
  readonly authority: RealtimeAuthorityPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance
  >;
  readonly e2eeResolver: RealtimeE2eeRoomOptionsResolverPort<
    TEnvelopeRef,
    TSessionRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >;
  readonly transport: RealtimeMediaTransportPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TToken,
    TDeviceId
  >;
  readonly stopCoordinator: StopCoordinator<
    TSessionRef,
    TLeaseRef,
    TOutcome,
    TResultRef,
    TTerminalResult,
    DecimalConnectionEpoch,
    'user_stop' | 'lease_expired' | 'permission_revoked' | 'disconnect' | 'provider_failure' | 'cancelled'
  >;
  readonly stopTerminalProjector: RealtimeStopTerminalProjector<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TOutcome,
    TResultRef,
    TTerminalResult
  >;
  readonly endContinuity?: RealtimeEndContinuityPort<
    TSessionRef,
    TContinuityId,
    TGovernance,
    TOutcome,
    TResultRef
  >;
  readonly nowMs?: () => number;
  readonly bindingEquality?: RealtimeBindingEquality<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId
  >;
  readonly validator?: RealtimePublicControlProjectionValidator<
    RealtimeBootstrapProjection<TDeviceId, TContinuityId, TGovernance>,
    RealtimeRefreshProjection<TSessionRef, TLeaseRef, TContinuityId, TAlias, TGovernance>,
    RealtimeMediaStopProjection<TSessionRef, TLeaseRef, TContinuityId, TAlias, TGovernance>,
    RealtimeEndContinuityProjection<TSessionRef, TContinuityId, TGovernance>,
    unknown
  >;
  /** Optional handoff successor seams; legacy five-operation callers omit it. */
  readonly handoff?: RealtimePublicControlHandoffOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
  /** Flat aliases keep composition ergonomic without changing the seam. */
  readonly handoffAuthority?: RealtimeHandoffAuthorityPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
  readonly handoffCurrentBinding?: RealtimeHandoffCurrentBindingPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >;
  readonly handoffOutputFence?: RealtimeHandoffOutputFencePort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TOutputFence
  >;
  readonly handoffReplay?: RealtimeHandoffDurableReplayPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
  readonly handoffDurableReplay?: RealtimeHandoffDurableReplayPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
}

export class RealtimePublicControlAdapter<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance = RealtimeGovernanceContext,
  TOutcome = unknown,
  TResultRef = unknown,
  TTerminalResult = unknown,
  TOutputFence = unknown,
> {
  readonly #authority: RealtimeAuthorityPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance
  >;
  readonly #e2eeResolver: RealtimeE2eeRoomOptionsResolverPort<
    TEnvelopeRef,
    TSessionRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >;
  readonly #transport: RealtimeMediaTransportPort<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TToken,
    TDeviceId
  >;
  readonly #stopCoordinator: RealtimePublicControlAdapterOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance,
    TOutcome,
    TResultRef,
    TTerminalResult,
    TOutputFence
  >['stopCoordinator'];
  readonly #stopTerminalProjector: RealtimePublicControlAdapterOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance,
    TOutcome,
    TResultRef,
    TTerminalResult,
    TOutputFence
  >['stopTerminalProjector'];
  readonly #endContinuity: RealtimeEndContinuityPort<
    TSessionRef,
    TContinuityId,
    TGovernance,
    TOutcome,
    TResultRef
  > | undefined;
  readonly #handoff: RealtimePublicControlHandoffOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  > | undefined;
  readonly #nowMs: () => number;
  readonly #continuityDeadlines: Array<{ readonly continuityId: TContinuityId; expiresAt: number }> = [];
  readonly #bindingEquality: RealtimeBindingEquality<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId
  >;
  readonly #validator: RealtimePublicControlAdapterOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance,
    TOutcome,
    TResultRef,
    TTerminalResult,
    TOutputFence
  >['validator'];

  constructor(options: RealtimePublicControlAdapterOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance,
    TOutcome,
    TResultRef,
    TTerminalResult,
    TOutputFence
  >) {
    this.#authority = options.authority;
    this.#e2eeResolver = options.e2eeResolver;
    this.#transport = options.transport;
    this.#stopCoordinator = options.stopCoordinator;
    this.#stopTerminalProjector = options.stopTerminalProjector;
    this.#endContinuity = options.endContinuity;
    this.#handoff = options.handoff
      ?? (options.handoffAuthority !== undefined
        && options.handoffCurrentBinding !== undefined
        && options.handoffOutputFence !== undefined
        && (options.handoffReplay !== undefined || options.handoffDurableReplay !== undefined)
        ? {
          authority: options.handoffAuthority,
          currentBinding: options.handoffCurrentBinding,
          outputFence: options.handoffOutputFence,
          replay: options.handoffReplay ?? options.handoffDurableReplay!,
        }
        : undefined);
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#validator = options.validator;
    this.#bindingEquality = options.bindingEquality
      ?? createObjectIdentityBindingEquality<TSessionRef, TLeaseRef, TContinuityId, TAlias, TDeviceId>();
  }

  async bootstrap(
    request: RealtimeBootstrapProjection<TDeviceId, TContinuityId, TGovernance>,
  ): Promise<RealtimeBootstrapControlResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance
  >> {
    this.#validator?.validateBootstrap(request);
    assertRequestIdentity(request.requestId, request.idempotencyKey);
    if (request.mode === 'initial' && request.continuityId !== undefined) fail('INVALID_REQUEST');
    if (request.mode === 'fully_disconnected' && request.continuityId === undefined) fail('INVALID_REQUEST');
    if (!this.#bindingEquality.sameDeviceId(request.deviceId, request.explicitStart.deviceId)) {
      fail('INVALID_REQUEST');
    }
    const authority = await this.#callAuthority(() => this.#authority.bootstrap(request));
    const now = nowMs(this.#nowMs);
    const continuityExpiry = assertContinuityExpiry(authority.continuityExpiresAt, now);
    assertBinding(authority.binding);
    if (request.mode === 'fully_disconnected'
      && !this.#bindingEquality.sameContinuityId(request.continuityId!, authority.binding.continuityId)) {
      fail('INVALID_BINDING');
    }
    const knownContinuityExpiry = this.#knownContinuityExpiry(authority.binding.continuityId);
    if (knownContinuityExpiry !== undefined && knownContinuityExpiry !== continuityExpiry) {
      fail('INVALID_EXPIRY');
    }
    this.#rememberContinuityExpiry(authority.binding.continuityId, continuityExpiry);
    if (request.mode === 'initial' && request.continuityId !== undefined) fail('INVALID_REQUEST');
    try {
      assertCanonicalLiveKitCloudProjectUrl(authority.livekit.serverUrl);
      assertToken(authority.livekit.participantToken);
    } catch (error) {
      if (error instanceof RealtimePublicControlError) throw error;
      fail(error instanceof Error && error.message === 'INVALID_PROJECT_URL'
        ? 'INVALID_PROJECT_URL'
        : 'INVALID_CREDENTIAL');
    }
    assertExpiry(authority.livekit.credentialExpiresAt, now, continuityExpiry);
    const mediaPolicy = assertAllGrants(
      request.requestedMedia,
      request.explicitStart.modalities,
      request.deviceId,
      authority.binding.deviceLeaseRef,
      authority.mediaGrants,
      now,
      continuityExpiry,
      this.#bindingEquality,
    );
    assertEnvelope(
      authority.e2ee,
      authority.binding,
      request.deviceId,
      now,
      continuityExpiry,
      this.#bindingEquality,
    );

    let resolved: Awaited<ReturnType<RealtimeE2eeRoomOptionsResolverPort<
      TEnvelopeRef,
      TSessionRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >['resolveRoomOptions']>>;
    let releaseResolved: (() => void) | undefined;
    try {
      resolved = await this.#e2eeResolver.resolveRoomOptions({ envelope: authority.e2ee, now: new Date(now).toISOString() });
      let released = false;
      releaseResolved = () => {
        if (released) return;
        released = true;
        try {
          resolved.release();
        } catch {
          // The owner port remains responsible for its own cleanup error
          // reporting; never execute a release callback twice or leak it into
          // a public provider error.
        }
      };
      assertExpiry(resolved.expiresAt, now, continuityExpiry);
      if (parseExpiryEpochMs(resolved.expiresAt) > parseExpiryEpochMs(authority.e2ee.expiresAt)) {
        fail('INVALID_E2EE_ENVELOPE');
      }
      if (!isRecord(resolved.roomOptionsReference)) fail('INVALID_E2EE_ENVELOPE');
    } catch (error) {
      releaseResolved?.();
      if (error instanceof RealtimePublicControlError) throw error;
      fail('E2EE_RESOLUTION_FAILED');
    }

    let connection: { readonly disconnect: () => Promise<void> };
    try {
      connection = await this.#transport.connect({
        serverUrl: authority.livekit.serverUrl,
        participantToken: authority.livekit.participantToken,
        roomOptionsReference: resolved.roomOptionsReference,
        binding: authority.binding,
        grants: authority.mediaGrants,
        mediaPolicy,
      });
    } catch {
      releaseResolved?.();
      fail('TRANSPORT_CONNECT_FAILED');
    }
    let disconnectPromise: Promise<void> | undefined;
    return Object.freeze({
      ...authority,
      disconnect: async () => {
        if (disconnectPromise === undefined) {
          disconnectPromise = (async () => {
            try {
              await connection.disconnect();
            } finally {
              releaseResolved?.();
            }
          })();
        }
        await disconnectPromise;
      },
      roomOptionsReference: resolved.roomOptionsReference,
      mediaPolicy,
    });
  }

  async refreshCredential(
    request: RealtimeRefreshProjection<TSessionRef, TLeaseRef, TContinuityId, TAlias, TGovernance>,
  ): Promise<RealtimeRefreshControlResult<TSessionRef, TLeaseRef, TContinuityId, TAlias, TToken>> {
    this.#validator?.validateCredentialRefresh(request);
    assertRequestIdentity(request.requestId, request.idempotencyKey);
    assertBinding(request.binding);
    const now = nowMs(this.#nowMs);
    if (this.#transport.refresh === undefined) fail('TRANSPORT_REFRESH_UNAVAILABLE');
    const authority = await this.#callAuthority(() => this.#authority.refreshCredential(request));
    assertSameBinding(request.binding, authority.binding, this.#bindingEquality);
    const continuityExpiry = assertContinuityExpiry(authority.continuityExpiresAt, now);
    const knownContinuityExpiry = this.#knownContinuityExpiry(request.binding.continuityId);
    if (knownContinuityExpiry !== undefined && knownContinuityExpiry !== continuityExpiry) {
      fail('INVALID_EXPIRY');
    }
    this.#rememberContinuityExpiry(request.binding.continuityId, continuityExpiry);
    assertExpiry(authority.credential.expiresAt, now, continuityExpiry);
    assertCredentialGeneration(authority.credential.credentialGeneration);
    assertToken(authority.credential.credential);
    try {
      await this.#transport.refresh({
        credential: authority.credential.credential,
        expiresAt: authority.credential.expiresAt,
        credentialGeneration: authority.credential.credentialGeneration,
        binding: authority.binding,
      });
    } catch {
      fail('TRANSPORT_REFRESH_FAILED');
    }
    return authority;
  }

  async stop(
    request: RealtimeMediaStopProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TAlias,
      TGovernance
    >,
  ): Promise<RealtimeStopControlResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TOutcome,
    TResultRef,
    TTerminalResult
  >> {
    this.#validator?.validateMediaStop(request);
    assertRequestIdentity(request.requestId, request.idempotencyKey);
    assertBinding(request.binding);
    if (!this.#stopCoordinator.requiresCompleteReplay) fail('STOP_FAILED');
    const stopRequest: InternalMediaStopRequest<
      TSessionRef,
      TLeaseRef,
      DecimalConnectionEpoch,
      typeof request.reason
    > = {
      idempotencyKey: request.idempotencyKey,
      requestId: request.requestId,
      realtimeSessionRef: request.binding.realtimeSessionRef,
      deviceLeaseRef: request.binding.deviceLeaseRef,
      connectionEpoch: request.binding.connectionEpoch,
      reason: request.reason,
    };
    let result: {
      readonly operationOutcome: TOutcome;
      readonly recordedResultReference?: TResultRef;
      readonly terminalResult?: TTerminalResult;
      readonly cleanup: MediaClosureFacts;
    };
    try {
      result = await this.#stopCoordinator.stop(stopRequest);
    } catch {
      fail('STOP_FAILED');
    }
    if (result.terminalResult === undefined) fail('STOP_FAILED');
    let terminal: RealtimeStopControlResult<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TOutcome,
      TResultRef,
      TTerminalResult
    >['terminal'];
    try {
      terminal = this.#stopTerminalProjector.project({
        requestId: request.requestId,
        reason: request.reason,
        realtimeSessionRef: request.binding.realtimeSessionRef,
        deviceLeaseRef: request.binding.deviceLeaseRef,
        continuityId: request.binding.continuityId,
        connectionEpoch: request.binding.connectionEpoch,
        operationOutcome: result.operationOutcome,
        ...(result.recordedResultReference === undefined
          ? {}
          : { recordedResultReference: result.recordedResultReference }),
        cleanup: result.cleanup,
        ownerTerminalResult: result.terminalResult,
      });
    } catch {
      fail('STOP_FAILED');
    }
    return {
      terminal,
      ownerTerminalResult: result.terminalResult,
    };
  }

  async endContinuity(
    request: RealtimeEndContinuityProjection<TSessionRef, TContinuityId, TGovernance>,
  ): Promise<RealtimeTerminalProjection<TSessionRef, never, TContinuityId, TOutcome, TResultRef>> {
    this.#validator?.validateEndContinuity(request);
    assertRequestIdentity(request.requestId, request.idempotencyKey);
    try {
      assertConnectionEpoch(request.connectionEpoch);
    } catch {
      fail('INVALID_BINDING');
    }
    if (this.#endContinuity === undefined) fail('END_CONTINUITY_UNAVAILABLE');
    let result: {
      readonly status: RealtimeTerminalStatus;
      readonly operationOutcome: TOutcome;
      readonly recordedResultReference?: TResultRef;
    };
    try {
      result = await this.#endContinuity.endContinuity(request);
    } catch {
      fail('AUTHORITY_FAILED');
    }
    return {
      operation: 'end_continuity',
      status: result.status,
      requestId: request.requestId,
      realtimeSessionRef: request.realtimeSessionRef,
      continuityId: request.continuityId,
      connectionEpoch: request.connectionEpoch,
      operationOutcome: result.operationOutcome,
      ...(result.recordedResultReference === undefined
        ? {}
        : { recordedResultReference: result.recordedResultReference }),
      executionFacts: { closureStatus: 'not_applicable' },
    };
  }

  /**
   * Handoff is an owner-orchestrated lease transition.  This adapter only
   * validates the cross-port tuple and coordinates durable claim/replay,
   * T11B authority, and the independent old-device output fence.  It never
   * mutates a local binding map or manufactures a canonical reference.
   */
  async handoff(
    request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >,
  ): Promise<RealtimeHandoffControlResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >> {
    this.#validator?.validateHandoff?.(request);
    assertHandoffRequestProjection(request);
    const handoff = this.#handoff;
    if (handoff === undefined) fail('HANDOFF_UNAVAILABLE');

    let fingerprint: string;
    try {
      fingerprint = stableHandoffJson(request);
    } catch {
      fail('HANDOFF_REPLAY_UNAVAILABLE');
    }
    const idempotencyContext = request.idempotencyContext
      ?? Object.freeze({ idempotency_key: request.idempotencyKey });

    let claim: RealtimeHandoffDurableReplayClaim<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance,
      TOutcome,
      TResultRef,
      TOutputFence
    >;
    try {
      claim = await handoff.replay.claim({ request, idempotencyContext, fingerprint });
    } catch {
      fail('HANDOFF_REPLAY_UNAVAILABLE');
    }
    if (claim.disposition === 'replay' || claim.disposition === 'terminal') {
      assertHandoffControlResult(request, claim.result, this.#bindingEquality);
      // The durable owner supplied the complete bundle.  Return it unchanged
      // so terminal/fence/facts/evidence/RRR replay cannot drift locally.
      return claim.result;
    }
    if (claim.disposition === 'conflict') fail('HANDOFF_IDEMPOTENCY_CONFLICT');
    if (claim.disposition === 'in_flight') fail('HANDOFF_IN_FLIGHT');
    if (claim.disposition !== 'claimed') fail('HANDOFF_INDETERMINATE');

    const claimId = claim.claimId;
    if (typeof claimId !== 'string' || claimId.length === 0) fail('HANDOFF_REPLAY_UNAVAILABLE');
    // A durable claim may be released only before the owner mutation authority
    // is entered.  Once the call starts, its outcome/effect/commit boundary is
    // owner-authoritative and must remain pending for reconciliation.
    let authorityStarted = false;
    try {
      const current = await handoff.currentBinding.resolve({ operation: 'handoff', request });
      if (current === undefined) fail('HANDOFF_CURRENT_BINDING_UNAVAILABLE');
      assertHandoffCurrentBinding(request, current, this.#bindingEquality);

      let authority: RealtimeHandoffAuthorityResult<
        TSessionRef,
        TLeaseRef,
        TContinuityId,
        TDeviceId,
        TGovernance,
        TOutcome,
        TResultRef,
        TOutputFence
      >;
      try {
        const execute = handoff.authority.handoff ?? handoff.authority.execute;
        if (execute === undefined) fail('HANDOFF_AUTHORITY_FAILED');
        authorityStarted = true;
        authority = await execute.call(handoff.authority, { request, currentBinding: current });
      } catch {
        fail('HANDOFF_AUTHORITY_FAILED');
      }
      assertHandoffAuthorityBinding(request, authority, this.#bindingEquality);
      assertNoHandoffSecrets(authority);

      if (authority.status !== 'success') {
        const terminal = authority.terminal;
        if (terminal === undefined || terminal.status !== authority.status) {
          fail('HANDOFF_INDETERMINATE');
        }
        const result: RealtimeHandoffControlResult<
          TSessionRef,
          TLeaseRef,
          TContinuityId,
          TDeviceId,
          TGovernance,
          TOutcome,
          TResultRef,
          TOutputFence
        > = {
          terminal,
          ...(terminal.oldDeviceSuppressionFence === undefined
            ? {}
            : { outputFence: terminal.oldDeviceSuppressionFence }),
          executionFacts: terminal.executionFacts,
          ...(terminal.recordedResultReference === undefined
            ? {}
            : { recordedResultReference: terminal.recordedResultReference }),
        };
        assertHandoffControlResult(request, result, this.#bindingEquality);
        await handoff.replay.commit({ claimId, fingerprint, result });
        return result;
      }

      assertHandoffOutcomeStatus(authority.status, authority.operationOutcome);
      const suppress = handoff.outputFence.suppressAndClose ?? handoff.outputFence.suppress;
      if (suppress === undefined) fail('HANDOFF_OUTPUT_FENCE_INVALID');
      const fence = await suppress.call(handoff.outputFence, {
        request,
        currentBinding: current,
        authority,
      });
      const terminal = authority.terminal ?? buildHandoffSuccessTerminal(request, authority, fence);
      if (authority.terminal !== undefined) {
        assertHandoffAuthorityTerminalTransition(request, authority, fence, terminal, this.#bindingEquality);
      }
      const result: RealtimeHandoffControlResult<
        TSessionRef,
        TLeaseRef,
        TContinuityId,
        TDeviceId,
        TGovernance,
        TOutcome,
        TResultRef,
        TOutputFence
      > = {
        terminal,
        ...(fence.fence === undefined ? {} : { outputFence: fence.fence }),
        executionFacts: terminal.executionFacts,
        ...(terminal.recordedResultReference === undefined
          ? {}
          : { recordedResultReference: terminal.recordedResultReference }),
      };
      assertHandoffControlResult(request, result, this.#bindingEquality);
      await handoff.replay.commit({ claimId, fingerprint, result });
      return result;
    } catch (error) {
      if (!authorityStarted) {
        const release = handoff.replay.release ?? handoff.replay.abort;
        if (release !== undefined) {
          try {
            await release.call(handoff.replay, { claimId, fingerprint });
          } catch {
            // The durable owner remains responsible for indeterminate claim
            // reconciliation; never turn a release error into local success.
          }
        }
      }
      if (error instanceof RealtimePublicControlError) throw error;
      fail('HANDOFF_INDETERMINATE');
    }
  }

  #knownContinuityExpiry(continuityId: TContinuityId): number | undefined {
    return this.#continuityDeadlines.find((entry) =>
      this.#bindingEquality.sameContinuityId(entry.continuityId, continuityId))?.expiresAt;
  }

  #rememberContinuityExpiry(continuityId: TContinuityId, expiresAt: number): void {
    const existing = this.#continuityDeadlines.find((entry) =>
      this.#bindingEquality.sameContinuityId(entry.continuityId, continuityId));
    if (existing !== undefined) {
      existing.expiresAt = expiresAt;
      return;
    }
    this.#continuityDeadlines.push({ continuityId, expiresAt });
  }

  async #callAuthority<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      fail('AUTHORITY_FAILED');
    }
  }
}

export const createRealtimePublicControlAdapter = <
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance = RealtimeGovernanceContext,
  TOutcome = unknown,
  TResultRef = unknown,
  TTerminalResult = unknown,
  TOutputFence = unknown,
>(
  options: RealtimePublicControlAdapterOptions<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance,
    TOutcome,
    TResultRef,
    TTerminalResult,
    TOutputFence
  >,
): RealtimePublicControlAdapter<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance,
  TOutcome,
  TResultRef,
  TTerminalResult,
  TOutputFence
> => new RealtimePublicControlAdapter(options);
