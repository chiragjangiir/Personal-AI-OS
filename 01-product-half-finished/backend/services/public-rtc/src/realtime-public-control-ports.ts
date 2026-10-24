/**
 * Internal ports for the T01 realtime successor control profile.
 *
 * These declarations are deliberately non-canonical and non-wire.  A T01
 * validator/codec must own the JSON bytes; this module only gives a trusted
 * adapter typed seams for T11B, T03, T10, the E2EE resolver, and the media
 * transport.  No schema is copied here.
 */

import type { InternalRoomOptionsReference } from './types.ts';

declare const connectionEpochBrand: unique symbol;
declare const credentialGenerationBrand: unique symbol;
declare const leaseVersionBrand: unique symbol;
declare const fencingTokenBrand: unique symbol;

export type DecimalConnectionEpoch = string & {
  readonly [connectionEpochBrand]: 'public-rtc-decimal-connection-epoch';
};

export type DecimalCredentialGeneration = string & {
  readonly [credentialGenerationBrand]: 'public-rtc-decimal-credential-generation';
};

/** Positive canonical-decimal lease versions stay strings across every seam. */
export type DecimalLeaseVersion = string & {
  readonly [leaseVersionBrand]: 'public-rtc-decimal-lease-version';
};

/** T11B fencing tokens are opaque decimal strings, never JavaScript numbers. */
export type DecimalFencingToken = string & {
  readonly [fencingTokenBrand]: 'public-rtc-decimal-fencing-token';
};

const DECIMAL_1_TO_38 = /^[1-9][0-9]{0,37}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/u;

export type RealtimeOperation =
  | 'bootstrap'
  | 'connected_credential_refresh'
  | 'media_stop'
  | 'end_continuity'
  | 'realtime_e2ee_key_resolve'
  | 'handoff';

export type BootstrapMode = 'initial' | 'fully_disconnected';
export type RealtimeMediaKind = 'audio' | 'video' | 'data';
export type RealtimePublishSource = 'microphone' | 'camera';
export type RealtimeRefreshReason = 'credential_expiring' | 'sdk_reconnect' | 'server_refresh';
export type RealtimeStopReason =
  | 'user_stop'
  | 'lease_expired'
  | 'permission_revoked'
  | 'disconnect'
  | 'provider_failure'
  | 'cancelled';
export type RealtimeTerminalStatus =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'expired'
  | 'revoked'
  | 'indeterminate';

export interface RealtimeTransportBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
> {
  readonly realtimeSessionRef: TSessionRef;
  readonly deviceLeaseRef: TLeaseRef;
  readonly continuityId: TContinuityId;
  readonly transportAliases: readonly TAlias[];
  readonly connectionEpoch: DecimalConnectionEpoch;
}

export interface RealtimeMediaIntent {
  readonly audio: boolean;
  readonly video: boolean;
  readonly data: boolean;
}

export interface RealtimeExplicitStart<TDeviceId> {
  readonly deviceId: TDeviceId;
  readonly modalities: readonly RealtimeMediaKind[];
  readonly startedAt: string;
}

export interface RealtimeMediaGrant<TDeviceId, TLeaseRef> {
  readonly enabled: boolean;
  readonly deviceId?: TDeviceId;
  readonly deviceLeaseRef?: TLeaseRef;
  readonly startModalities?: readonly RealtimeMediaKind[];
  readonly expiresAt?: string;
}

export interface RealtimeMediaGrants<TDeviceId, TLeaseRef> {
  readonly audio: RealtimeMediaGrant<TDeviceId, TLeaseRef>;
  readonly video: RealtimeMediaGrant<TDeviceId, TLeaseRef>;
  readonly data: RealtimeMediaGrant<TDeviceId, TLeaseRef>;
}

/** Derived internal policy; it is not a wire or canonical object. */
export interface RealtimeEffectiveMediaPolicy {
  readonly canPublishSources: readonly RealtimePublishSource[];
  readonly canPublishData: boolean;
}

export interface RealtimeGovernanceContext {
  readonly [key: string]: unknown;
}

export interface RealtimeE2eeEnvelope<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly envelopeRef: TEnvelopeRef;
  readonly keyIndex: number;
  readonly generation: DecimalCredentialGeneration;
  readonly expiresAt: string;
  readonly realtimeSessionRef: TSessionRef;
  readonly continuityId: TContinuityId;
  readonly deviceId: TDeviceId;
  readonly channels: readonly RealtimeMediaKind[];
  readonly governance: TGovernance;
}

export interface RealtimeLiveKitCredential<TToken> {
  readonly serverUrl: string;
  readonly participantToken: TToken;
  readonly credentialExpiresAt: string;
}

export interface RealtimeRefreshedCredential<TToken> {
  readonly credential: TToken;
  readonly expiresAt: string;
  readonly credentialGeneration: DecimalCredentialGeneration;
}

export interface RealtimeBootstrapProjection<
  TDeviceId,
  TContinuityId,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly mode: BootstrapMode;
  readonly deviceId: TDeviceId;
  readonly continuityId?: TContinuityId;
  readonly explicitStart: RealtimeExplicitStart<TDeviceId>;
  readonly requestedMedia: RealtimeMediaIntent;
  readonly governance: TGovernance;
}

export interface RealtimeRefreshProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly binding: RealtimeTransportBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias>;
  readonly refreshReason: RealtimeRefreshReason;
  readonly governance: TGovernance;
}

export interface RealtimeMediaStopProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly binding: RealtimeTransportBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias>;
  readonly reason: RealtimeStopReason;
  readonly governance: TGovernance;
}

export interface RealtimeEndContinuityProjection<
  TSessionRef,
  TContinuityId,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: TSessionRef;
  readonly continuityId: TContinuityId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly governance: TGovernance;
}

/**
 * Internal projection of T01's handoff request.  It is intentionally a
 * projection, not a second JSON schema: the canonical request decoder remains
 * owned by T01.  In particular, the current lease is not inferred from a
 * transport alias or from an in-process collection.
 */
export interface RealtimeHandoffProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly operation: 'handoff';
  readonly requestId: string;
  readonly idempotencyKey: string;
  /** The full T01 idempotency context is carried opaquely when available. */
  readonly idempotencyContext?: unknown;
  readonly realtimeSessionRef: TSessionRef;
  readonly currentDeviceLeaseRef: TLeaseRef;
  readonly continuityId: TContinuityId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly expectedLeaseVersion: DecimalLeaseVersion;
  readonly fromDeviceId: TDeviceId;
  readonly toDeviceId: TDeviceId;
  readonly governance: TGovernance;
}

/**
 * T11B's authoritative current binding snapshot.  The owner may add opaque
 * fields to its own value, but these fields are the minimum cross-port proof.
 */
export interface RealtimeHandoffCurrentBinding<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
> {
  readonly realtimeSessionRef: TSessionRef;
  readonly deviceLeaseRef: TLeaseRef;
  readonly continuityId: TContinuityId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly deviceId: TDeviceId;
  readonly leaseVersion: DecimalLeaseVersion;
  /** Omitted only for an owner that exposes active-ness through its opaque ref. */
  readonly state?: 'active' | 'released' | 'expired' | 'revoked' | 'unknown';
}

/** T11B-only current authority/read seam; no aliases or maps are authority. */
export interface RealtimeHandoffCurrentBindingPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance = RealtimeGovernanceContext,
> {
  resolve(input: {
    readonly operation: 'handoff';
    readonly request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >;
  }): Promise<RealtimeHandoffCurrentBinding<TSessionRef, TLeaseRef, TContinuityId, TDeviceId> | undefined>;
  close?(): void | Promise<void>;
}

export type RealtimeHandoffLeaseState =
  | 'released'
  | 'active'
  | 'failed'
  | 'indeterminate';

/** The two owner facts required before Public can expose a handoff success. */
export interface RealtimeHandoffLeaseTransition<TLeaseRef> {
  readonly ref: TLeaseRef;
  readonly state: RealtimeHandoffLeaseState;
  readonly version: DecimalLeaseVersion;
  readonly fencingToken?: DecimalFencingToken;
}

/**
 * T11B handoff authority result.  The adapter never derives these values from
 * request fields; they must be returned by the injected owner authority.
 */
export interface RealtimeHandoffAuthorityResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> {
  readonly status: RealtimeTerminalStatus;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: TSessionRef;
  readonly continuityId: TContinuityId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly fromDeviceId: TDeviceId;
  readonly toDeviceId: TDeviceId;
  readonly previousDeviceLease: RealtimeHandoffLeaseTransition<TLeaseRef>;
  readonly newDeviceLease: RealtimeHandoffLeaseTransition<TLeaseRef>;
  readonly operationOutcome: TOutcome;
  readonly recordedResultReference?: TResultRef;
  readonly governance?: TGovernance;
  readonly executionFacts?: RealtimeHandoffExecutionFacts;
  /** Owner-built terminal for non-success/indeterminate dispositions. */
  readonly terminal?: RealtimeHandoffTerminalProjection<
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

/** Old-device suppression closure is an independent injected owner seam. */
export interface RealtimeHandoffOutputFenceResult<TOutputFence> {
  readonly state: 'old_device_suppressed' | 'failed' | 'indeterminate';
  readonly closureStatus: 'verified_closed' | 'failed' | 'indeterminate';
  readonly fence?: TOutputFence;
  readonly evidenceRefs?: readonly unknown[];
  readonly participantCleanup?: RealtimeTerminalExecutionFacts['participantCleanup'];
  readonly trackCleanup?: RealtimeTerminalExecutionFacts['trackCleanup'];
  readonly roomCleanup?: RealtimeTerminalExecutionFacts['roomCleanup'];
}

export interface RealtimeHandoffOutputFencePort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TOutputFence,
> {
  suppressAndClose?(input: {
    readonly request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >;
    readonly currentBinding: RealtimeHandoffCurrentBinding<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId
    >;
    readonly authority: RealtimeHandoffAuthorityResult<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance,
      TOutcome,
      unknown,
      TOutputFence
    >;
  }): Promise<RealtimeHandoffOutputFenceResult<TOutputFence>>;
  suppress?(input: {
    readonly request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >;
    readonly currentBinding: RealtimeHandoffCurrentBinding<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId
    >;
    readonly authority: RealtimeHandoffAuthorityResult<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance,
      TOutcome,
      unknown,
      TOutputFence
    >;
  }): Promise<RealtimeHandoffOutputFenceResult<TOutputFence>>;
  close?(): void | Promise<void>;
}

export interface RealtimeHandoffExecutionFacts extends RealtimeTerminalExecutionFacts {
  readonly evidenceRefs?: readonly unknown[];
}

export interface RealtimeHandoffTerminalProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> {
  readonly operation: 'handoff';
  readonly status: RealtimeTerminalStatus;
  readonly requestId: string;
  readonly realtimeSessionRef: TSessionRef;
  readonly deviceLeaseRef?: TLeaseRef;
  readonly previousDeviceLeaseRef: TLeaseRef;
  readonly continuityId: TContinuityId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly fromDeviceId: TDeviceId;
  readonly toDeviceId: TDeviceId;
  readonly leaseVersion?: DecimalLeaseVersion;
  readonly fencingToken?: DecimalFencingToken;
  readonly oldDeviceSuppressionFence?: TOutputFence;
  readonly operationOutcome: TOutcome;
  readonly recordedResultReference?: TResultRef;
  readonly executionFacts: RealtimeHandoffExecutionFacts;
  readonly governance: TGovernance;
}

/**
 * This bundle is internal.  The controller/codec emits only `terminal`; the
 * fence/facts/RRR fields stay available to the durable replay owner so a
 * duplicate can be returned byte-for-byte equivalent by its canonical codec.
 */
export interface RealtimeHandoffControlResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> {
  readonly terminal: RealtimeHandoffTerminalProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >;
  readonly outputFence?: TOutputFence;
  readonly executionFacts: RealtimeHandoffExecutionFacts;
  readonly recordedResultReference?: TResultRef;
}

export type RealtimeHandoffDurableReplayClaim<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> =
  | { readonly disposition: 'claimed'; readonly claimId: string }
  | {
    readonly disposition: 'replay' | 'terminal';
    readonly result: RealtimeHandoffControlResult<
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
  | { readonly disposition: 'conflict' | 'in_flight' | 'indeterminate' };

/** T02-owned durable idempotency/replay seam for the handoff operation. */
export interface RealtimeHandoffDurableReplayPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> {
  claim(input: {
    readonly request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >;
    readonly idempotencyContext: unknown;
    readonly fingerprint: string;
  }): Promise<RealtimeHandoffDurableReplayClaim<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >>;
  commit(input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly result: RealtimeHandoffControlResult<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance,
      TOutcome,
      TResultRef,
      TOutputFence
    >;
  }): Promise<void>;
  release?(input: { readonly claimId: string; readonly fingerprint: string }): Promise<void>;
  abort?(input: { readonly claimId: string; readonly fingerprint: string }): Promise<void>;
  close?(): void | Promise<void>;
}

/** Short aliases used by Gateway composition documents. */
export type RealtimeHandoffReplayPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> = RealtimeHandoffDurableReplayPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence
>;

export type RealtimeHandoffDurablePort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> = RealtimeHandoffDurableReplayPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence
>;

/** T11B's mutation authority; it does not mint refs in this package. */
export interface RealtimeHandoffAuthorityPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
  TOutcome,
  TResultRef,
  TOutputFence = unknown,
> {
  handoff?(input: {
    readonly request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >;
    readonly currentBinding: RealtimeHandoffCurrentBinding<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId
    >;
  }): Promise<RealtimeHandoffAuthorityResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >>;
  execute?(input: {
    readonly request: RealtimeHandoffProjection<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >;
    readonly currentBinding: RealtimeHandoffCurrentBinding<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TDeviceId
    >;
  }): Promise<RealtimeHandoffAuthorityResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TDeviceId,
    TGovernance,
    TOutcome,
    TResultRef,
    TOutputFence
  >>;
  close?(): void | Promise<void>;
}

export interface RealtimeAuthorityBootstrapResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance = RealtimeGovernanceContext,
> {
  readonly binding: RealtimeTransportBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias>;
  readonly livekit: RealtimeLiveKitCredential<TToken>;
  readonly mediaGrants: RealtimeMediaGrants<TDeviceId, TLeaseRef>;
  readonly e2ee: RealtimeE2eeEnvelope<
    TEnvelopeRef,
    TSessionRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >;
  /** T11B-owned deadline; this adapter never creates a 24-hour deadline. */
  readonly continuityExpiresAt: string;
  readonly governance: TGovernance;
}

export interface RealtimeAuthorityRefreshResult<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TToken,
> {
  readonly binding: RealtimeTransportBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias>;
  readonly credential: RealtimeRefreshedCredential<TToken>;
  readonly continuityExpiresAt: string;
}

export interface RealtimeAuthorityPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
  TToken,
  TEnvelopeRef,
  TGovernance = RealtimeGovernanceContext,
> {
  bootstrap(
    request: RealtimeBootstrapProjection<TDeviceId, TContinuityId, TGovernance>,
  ): Promise<RealtimeAuthorityBootstrapResult<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TDeviceId,
    TToken,
    TEnvelopeRef,
    TGovernance
  >>;
  refreshCredential(
    request: RealtimeRefreshProjection<TSessionRef, TLeaseRef, TContinuityId, TAlias, TGovernance>,
  ): Promise<RealtimeAuthorityRefreshResult<TSessionRef, TLeaseRef, TContinuityId, TAlias, TToken>>;
}

export interface RealtimeE2eeResolverInput<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance,
> {
  readonly envelope: RealtimeE2eeEnvelope<
    TEnvelopeRef,
    TSessionRef,
    TContinuityId,
    TDeviceId,
    TGovernance
  >;
  readonly now: string;
}

export interface RealtimeE2eeResolverPort<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance = RealtimeGovernanceContext,
> {
  /**
   * The resolver owns any decryption and key bytes.  The adapter only receives
   * an opaque SDK RoomOptions reference and a release hook.
   */
  resolveRoomOptions(
    input: RealtimeE2eeResolverInput<
      TEnvelopeRef,
      TSessionRef,
      TContinuityId,
      TDeviceId,
      TGovernance
    >,
  ): Promise<{
    readonly roomOptionsReference: InternalRoomOptionsReference;
    readonly expiresAt: string;
    readonly release: () => void;
  }>;
}

/** Explicit name for the in-process RoomOptions resolver seam. */
export type RealtimeE2eeRoomOptionsResolverPort<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance = RealtimeGovernanceContext,
> = RealtimeE2eeResolverPort<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance
>;

/** Compatibility alias; this name never denotes the terminal ciphertext route. */
export type RealtimeE2eeResolverPortCompat<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance = RealtimeGovernanceContext,
> = RealtimeE2eeRoomOptionsResolverPort<
  TEnvelopeRef,
  TSessionRef,
  TContinuityId,
  TDeviceId,
  TGovernance
>;

/**
 * Separate opaque seam for T01's terminal ciphertext resolve operation.  It
 * returns encrypted envelope bytes/value only; it never returns SDK options or
 * plaintext key material.  The public HTTP route and its canonical schema are
 * owned by T01 and are not recreated here.
 */
export interface RealtimeE2eeCiphertextResolvePort<
  TValidatedResolveRequest,
  TValidatedResolveResponse,
> {
  /** The request/response are T01-validated opaque values, never RoomOptions. */
  resolveCiphertext(input: TValidatedResolveRequest): Promise<TValidatedResolveResponse>;
}

export interface RealtimeMediaTransportPort<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TToken,
  TDeviceId = unknown,
> {
  connect(input: {
    readonly serverUrl: string;
    readonly participantToken: TToken;
    readonly roomOptionsReference: InternalRoomOptionsReference;
    readonly binding: RealtimeTransportBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias>;
    readonly grants: RealtimeMediaGrants<TDeviceId, TLeaseRef>;
    readonly mediaPolicy: RealtimeEffectiveMediaPolicy;
  }): Promise<{ readonly disconnect: () => Promise<void> }>;
  refresh?(input: {
    readonly credential: TToken;
    readonly expiresAt: string;
    readonly credentialGeneration: DecimalCredentialGeneration;
    readonly binding: RealtimeTransportBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias>;
  }): Promise<void>;
}

/** Owner equality for opaque refs/aliases; default adapter behavior is Object.is. */
export interface RealtimeBindingEquality<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
> {
  sameSessionRef(left: TSessionRef, right: TSessionRef): boolean;
  sameLeaseRef(left: TLeaseRef, right: TLeaseRef): boolean;
  sameContinuityId(left: TContinuityId, right: TContinuityId): boolean;
  sameAlias(left: TAlias, right: TAlias): boolean;
  sameDeviceId(left: TDeviceId, right: TDeviceId): boolean;
}

export function createObjectIdentityBindingEquality<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TDeviceId,
>(): RealtimeBindingEquality<TSessionRef, TLeaseRef, TContinuityId, TAlias, TDeviceId> {
  return {
    sameSessionRef: Object.is,
    sameLeaseRef: Object.is,
    sameContinuityId: Object.is,
    sameAlias: Object.is,
    sameDeviceId: Object.is,
  };
}

export interface RealtimePublicControlCodecPort<
  TBootstrapWire,
  TRefreshWire,
  TStopWire,
  TEndWire,
  TResolveWire,
  TBootstrapOutput,
  TRefreshOutput,
  TTerminalOutput,
  TResolveOutput,
> {
  decodeBootstrap(input: unknown): TBootstrapWire;
  decodeCredentialRefresh(input: unknown): TRefreshWire;
  decodeMediaStop(input: unknown): TStopWire;
  decodeEndContinuity(input: unknown): TEndWire;
  decodeE2eeCiphertextResolve(input: unknown): TResolveWire;
  encodeBootstrap(output: TBootstrapOutput): unknown;
  encodeCredentialRefresh(output: TRefreshOutput): unknown;
  encodeTerminal(output: TTerminalOutput): unknown;
  encodeE2eeCiphertextResolve(output: TResolveOutput): unknown;
}

/**
 * Optional T01-owned projection validator.  It validates canonical input
 * before this internal adapter applies cross-port invariants; it does not
 * expose a second schema or change any wire bytes.
 */
export interface RealtimePublicControlProjectionValidator<
  TBootstrap,
  TRefresh,
  TStop,
  TEnd,
  TResolve,
> {
  validateBootstrap(input: TBootstrap): void;
  validateCredentialRefresh(input: TRefresh): void;
  validateMediaStop(input: TStop): void;
  validateEndContinuity(input: TEnd): void;
  validateE2eeCiphertextResolve(input: TResolve): void;
  /** Optional because older consumers predate the T01 handoff operation. */
  validateHandoff?(input: unknown): void;
}

export interface RealtimeTerminalExecutionFacts {
  readonly closureStatus: 'not_applicable' | 'verified_closed' | 'failed' | 'indeterminate';
  readonly deviceLeaseRelease?: 'not_requested' | 'released' | 'already_released' | 'failed' | 'indeterminate';
  readonly participantCleanup?: 'not_requested' | 'verified_absent' | 'failed' | 'indeterminate';
  readonly trackCleanup?: 'not_requested' | 'verified_absent' | 'failed' | 'indeterminate';
  readonly roomCleanup?: 'not_requested' | 'verified_absent' | 'failed' | 'indeterminate';
  readonly evidenceRefs?: readonly unknown[];
}

export interface RealtimeTerminalProjection<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TOutcome,
  TResultRef,
> {
  readonly operation: RealtimeOperation;
  readonly status: RealtimeTerminalStatus;
  readonly requestId: string;
  readonly realtimeSessionRef?: TSessionRef;
  readonly deviceLeaseRef?: TLeaseRef;
  readonly continuityId: TContinuityId;
  readonly connectionEpoch?: DecimalConnectionEpoch;
  readonly operationOutcome: TOutcome;
  readonly recordedResultReference?: TResultRef;
  readonly executionFacts: RealtimeTerminalExecutionFacts;
}

/** Owner projection for Stop; cleanup cannot be promoted to a terminal result locally. */
export interface RealtimeStopTerminalProjector<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TOutcome,
  TResultRef,
  TTerminalResult,
> {
  project(input: {
    readonly requestId: string;
    readonly reason: RealtimeStopReason;
    readonly realtimeSessionRef: TSessionRef;
    readonly deviceLeaseRef: TLeaseRef;
    readonly continuityId: TContinuityId;
    readonly connectionEpoch: DecimalConnectionEpoch;
    readonly operationOutcome: TOutcome;
    readonly recordedResultReference?: TResultRef;
    readonly cleanup: unknown;
    readonly ownerTerminalResult: TTerminalResult;
  }): RealtimeTerminalProjection<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TOutcome,
    TResultRef
  >;
}

export function assertConnectionEpoch(value: unknown): DecimalConnectionEpoch {
  if (typeof value !== 'string' || !DECIMAL_1_TO_38.test(value)) {
    throw new Error('INVALID_CONNECTION_EPOCH');
  }
  return value as DecimalConnectionEpoch;
}

export function assertCredentialGeneration(value: unknown): DecimalCredentialGeneration {
  if (typeof value !== 'string' || !DECIMAL_1_TO_38.test(value)) {
    throw new Error('INVALID_CREDENTIAL_GENERATION');
  }
  return value as DecimalCredentialGeneration;
}

export function assertLeaseVersion(value: unknown): DecimalLeaseVersion {
  if (typeof value !== 'string' || !DECIMAL_1_TO_38.test(value)) {
    throw new Error('INVALID_LEASE_VERSION');
  }
  return value as DecimalLeaseVersion;
}

export function assertFencingToken(value: unknown): DecimalFencingToken {
  if (typeof value !== 'string' || !DECIMAL_1_TO_38.test(value)) {
    throw new Error('INVALID_FENCING_TOKEN');
  }
  return value as DecimalFencingToken;
}

export const assertDecimalLeaseVersion = assertLeaseVersion;
export const assertDecimalFencingToken = assertFencingToken;

export function compareDecimalEpoch(
  left: DecimalConnectionEpoch | DecimalCredentialGeneration,
  right: DecimalConnectionEpoch | DecimalCredentialGeneration,
): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function assertStrictlyAdvancedEpoch(
  previous: DecimalConnectionEpoch,
  next: DecimalConnectionEpoch,
): DecimalConnectionEpoch {
  if (compareDecimalEpoch(previous, next) >= 0) throw new Error('CONNECTION_EPOCH_NOT_ADVANCED');
  return next;
}

export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new Error('INVALID_IDEMPOTENCY_KEY');
  }
  return value;
}

export function parseExpiryEpochMs(value: unknown, code = 'INVALID_EXPIRY'): number {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function assertExpiryWindow(
  nowMs: number,
  expiryMs: number,
  continuityExpiryMs: number,
  code = 'INVALID_EXPIRY_WINDOW',
): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs) || !Number.isFinite(continuityExpiryMs)) {
    throw new Error(code);
  }
  if (expiryMs <= nowMs || expiryMs > continuityExpiryMs) throw new Error(code);
  return expiryMs;
}
