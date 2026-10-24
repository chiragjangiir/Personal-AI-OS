import {
  assertConnectionEpoch,
  compareDecimalEpoch,
  type DecimalConnectionEpoch,
} from './realtime-public-control-ports.ts';
import {
  ReconnectPolicy,
  type ReconnectPolicyOptions,
  type ReconnectSchedule,
  type ReconnectScheduleInput,
} from './reconnect-policy.ts';

/**
 * Internal, non-canonical, non-wire recovery state machine.
 *
 * T11B owns the authoritative session/lease fence and supplies opaque refs.
 * This module only models the decisions around those refs.  It has no network
 * calls and no timer: the caller supplies observation times explicitly.
 */

export type RecoveryStatus = 'connected' | 'disconnected';

/** LiveKit SDK observations accepted by the internal recovery seam. */
export type RecoverySdkState =
  | 'connected'
  | 'reconnecting'
  | 'reconnected'
  | 'disconnected'
  | 'Connected'
  | 'Reconnecting'
  | 'Reconnected'
  | 'Disconnected';

export type RecoveryPassiveEvent = 'heartbeat' | 'reconnect' | 'media' | 'model';

export type RecoveryTransitionKind =
  | 'connected_credential_refresh'
  | 'disconnected_marked'
  | 'fully_disconnected_bootstrap'
  | 'passive_observation'
  | 'rejected';

export type RecoveryRejectReason =
  | 'CONTINUITY_EXPIRED'
  | 'REQUIRES_CONNECTED_SESSION'
  | 'REQUIRES_FULL_DISCONNECT'
  | 'MISSING_CREDENTIAL'
  | 'CREDENTIAL_NOT_ROTATED'
  | 'CREDENTIAL_EXPIRED'
  | 'MISSING_T11B_TRANSPORT_BINDING'
  | 'TRANSPORT_BINDING_NOT_ROTATED'
  | 'CONNECTION_EPOCH_NOT_ADVANCED'
  | 'CREDENTIAL_EXCEEDS_CONTINUITY'
  | 'OWNER_BOOTSTRAP_NOT_ALLOWED'
  | 'STOPPED'
  | 'OWNER_COMPARATOR_FAILED'
  | 'INVALID_RECOVERY_CLOCK'
  | 'INVALID_RECOVERY_EPOCH';

export interface RecoveryEpochCodec<TEpoch> {
  validate(value: unknown): TEpoch;
  compare(left: TEpoch, right: TEpoch): -1 | 0 | 1;
}

export interface TransportRecoveryOwnerComparator<
  TSessionRef = unknown,
  TLeaseRef = unknown,
  TContinuityId = unknown,
  TAlias = unknown,
  TCredentialRef = unknown,
> {
  sameSessionRef?(left: TSessionRef, right: TSessionRef): boolean;
  sameLeaseRef?(left: TLeaseRef, right: TLeaseRef): boolean;
  sameContinuityId?(left: TContinuityId, right: TContinuityId): boolean;
  sameAlias?(left: TAlias, right: TAlias): boolean;
  sameCredentialRef?(left: TCredentialRef, right: TCredentialRef): boolean;
}

interface OwnerComparison {
  readonly equal: boolean;
  readonly failed: boolean;
}

function compareOwner<T>(
  left: T,
  right: T,
  comparator: (left: T, right: T) => boolean,
  comparatorInjected = true,
): OwnerComparison {
  if (!comparatorInjected && !Object.is(left, right)
    && ((typeof left === 'object' && left !== null)
      || (typeof right === 'object' && right !== null))) {
    return { equal: false, failed: true };
  }
  try {
    const result = comparator(left, right);
    return typeof result === 'boolean'
      ? { equal: result, failed: false }
      : { equal: false, failed: true };
  } catch {
    return { equal: false, failed: true };
  }
}

function defaultOwnerComparator<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TCredentialRef,
>(): TransportRecoveryOwnerComparator<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TCredentialRef
> {
  return {
    sameSessionRef: Object.is,
    sameLeaseRef: Object.is,
    sameContinuityId: Object.is,
    sameAlias: Object.is,
    sameCredentialRef: Object.is,
  };
}

const numericEpochCodec: RecoveryEpochCodec<number> = Object.freeze({
  validate(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error('INVALID_RECOVERY_EPOCH');
    }
    return value as number;
  },
  compare(left: number, right: number): -1 | 0 | 1 {
    return left === right ? 0 : left < right ? -1 : 1;
  },
});

export const decimalEpochCodec: RecoveryEpochCodec<DecimalConnectionEpoch> = Object.freeze({
  validate(value: unknown): DecimalConnectionEpoch {
    try {
      return assertConnectionEpoch(value);
    } catch {
      throw new Error('INVALID_RECOVERY_EPOCH');
    }
  },
  compare(left: DecimalConnectionEpoch, right: DecimalConnectionEpoch): -1 | 0 | 1 {
    return compareDecimalEpoch(left, right);
  },
});

export interface TransportRecoveryBinding<
  TSessionRef = string,
  TLeaseRef = string,
  TContinuityId = string,
  TAlias = string,
  TEpoch = number,
> {
  readonly realtime_session_ref: TSessionRef;
  readonly device_lease_ref: TLeaseRef;
  readonly continuity_id: TContinuityId;
  readonly transport_aliases: readonly TAlias[];
  readonly epoch: TEpoch;
}

export type TransportRecoveryStart<
  TSessionRef = string,
  TLeaseRef = string,
  TContinuityId = string,
  TAlias = string,
  TCredentialRef = string,
  TEpoch = number,
> = TransportRecoveryBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias, TEpoch> & {
  readonly credential_ref: TCredentialRef;
  readonly credential_expires_at_ms: number;
  /** T11B-owned deadline derived from accepted user activity. */
  readonly continuity_expires_at_ms: number;
  readonly now_ms?: number;
};

export interface TransportRecoveryState<
  TSessionRef = string,
  TLeaseRef = string,
  TContinuityId = string,
  TAlias = string,
  TCredentialRef = string,
  TEpoch = number,
> extends TransportRecoveryBinding<TSessionRef, TLeaseRef, TContinuityId, TAlias, TEpoch> {
  readonly status: RecoveryStatus;
  readonly credential_ref: TCredentialRef;
  readonly credential_expires_at_ms: number;
  readonly continuity_expires_at_ms: number;
  readonly disconnected_at_ms: number | undefined;
}

export interface TransportRecoveryOptions<
  TEpoch = number,
  TSessionRef = unknown,
  TLeaseRef = unknown,
  TContinuityId = unknown,
  TAlias = unknown,
  TCredentialRef = unknown,
> {
  readonly nowMs?: () => number;
  readonly epochCodec?: RecoveryEpochCodec<TEpoch>;
  readonly reconnectPolicy?: ReconnectPolicyOptions;
  readonly ownerComparator?: TransportRecoveryOwnerComparator<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef
  >;
  readonly bindingEquality?: TransportRecoveryOwnerComparator<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef
  >;
}

export interface CredentialRefreshInput<TCredentialRef = string> {
  readonly credential_ref: TCredentialRef;
  readonly credential_expires_at_ms: number;
  readonly at_ms?: number;
}

export interface T11bTransportBootstrap<
  TSessionRef = string,
  TLeaseRef = string,
  TAlias = string,
  TCredentialRef = string,
  TEpoch = number,
> {
  readonly realtime_session_ref?: TSessionRef;
  readonly device_lease_ref?: TLeaseRef;
  readonly transport_aliases?: readonly TAlias[];
  readonly epoch?: TEpoch;
  readonly credential_ref?: TCredentialRef;
  readonly credential_expires_at_ms?: number;
  /** Explicit owner gate; it is never inferred from SDK reconnect events. */
  readonly owner_allows_bootstrap?: boolean;
  readonly ownerAllowsBootstrap?: boolean;
  readonly owner_allowed?: boolean;
  readonly ownerAllowed?: boolean;
  readonly allow_bootstrap?: boolean;
}

export interface DisconnectedBootstrapInput<
  TSessionRef = string,
  TLeaseRef = string,
  TAlias = string,
  TCredentialRef = string,
  TEpoch = number,
> extends T11bTransportBootstrap<TSessionRef, TLeaseRef, TAlias, TCredentialRef, TEpoch> {
  /** Explicit owner-port spelling; `t11b` is accepted for a nested port. */
  readonly t11b?: T11bTransportBootstrap<
    TSessionRef,
    TLeaseRef,
    TAlias,
    TCredentialRef,
    TEpoch
  >;
  readonly at_ms?: number;
  readonly owner_allows_bootstrap?: boolean;
  readonly ownerAllowsBootstrap?: boolean;
  readonly owner_allowed?: boolean;
  readonly ownerAllowed?: boolean;
  readonly t11b_allow_bootstrap?: boolean;
  readonly t11bAllowBootstrap?: boolean;
  readonly stopped?: boolean;
  readonly stop?: boolean;
  readonly clientStopped?: boolean;
  readonly client_stop?: boolean;
}

export interface RecoverySdkObservationInput {
  readonly state: RecoverySdkState;
  readonly at_ms?: number;
  readonly atMs?: number;
  /** T11B/owner authorization is required only for terminal bootstrap. */
  readonly owner_allows_bootstrap?: boolean;
  readonly ownerAllowsBootstrap?: boolean;
  readonly owner_allowed?: boolean;
  readonly ownerAllowed?: boolean;
  readonly t11b_allow_bootstrap?: boolean;
  readonly t11bAllowBootstrap?: boolean;
  readonly stopped?: boolean;
  readonly stop?: boolean;
  readonly clientStopped?: boolean;
  readonly client_stop?: boolean;
}

export type RecoverySdkStateInput = RecoverySdkObservationInput | RecoverySdkState;

export interface RecoveryTransition<TState> {
  readonly accepted: boolean;
  readonly kind: RecoveryTransitionKind;
  readonly state: TState;
  readonly reason?: RecoveryRejectReason;
}

export interface RecoverySdkDecision<TState> extends RecoveryTransition<TState> {
  readonly sdkState: RecoverySdkState;
  readonly action: 'observe' | 'bootstrap';
  readonly shouldConnect: false;
  readonly shouldRepublish: false;
  readonly shouldBootstrap: boolean;
}

function finiteTime(value: number, code: RecoveryRejectReason): number {
  if (!Number.isFinite(value)) throw new Error(code);
  return value;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function aliasesValid<TAlias>(aliases: readonly TAlias[] | undefined): aliases is readonly TAlias[] {
  return aliases !== undefined && aliases.length > 0 && aliases.every((alias) => hasValue(alias));
}

function aliasesCompare<TAlias>(
  left: readonly TAlias[],
  right: readonly TAlias[],
  comparator: (left: TAlias, right: TAlias) => boolean,
  comparatorInjected = true,
): OwnerComparison {
  if (left.length !== right.length) return { equal: false, failed: false };
  for (let index = 0; index < left.length; index += 1) {
    const rightAlias = right[index];
    if (rightAlias === undefined) return { equal: false, failed: false };
    const comparison = compareOwner(left[index]!, rightAlias, comparator, comparatorInjected);
    if (comparison.failed || !comparison.equal) return comparison;
  }
  return { equal: true, failed: false };
}

function freezeState<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TCredentialRef,
  TEpoch,
>(state: TransportRecoveryState<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TCredentialRef,
  TEpoch
>): TransportRecoveryState<TSessionRef, TLeaseRef, TContinuityId, TAlias, TCredentialRef, TEpoch> {
  return Object.freeze({
    ...state,
    transport_aliases: Object.freeze([...state.transport_aliases]),
  });
}

function accepted<TState>(
  kind: Exclude<RecoveryTransitionKind, 'rejected'>,
  state: TState,
): RecoveryTransition<TState> {
  return Object.freeze({ accepted: true, kind, state });
}

function rejected<TState>(
  state: TState,
  reason: RecoveryRejectReason,
): RecoveryTransition<TState> {
  return Object.freeze({ accepted: false, kind: 'rejected', state, reason });
}

function sdkDecision<TState>(
  sdkState: RecoverySdkState,
  state: TState,
  kind: RecoveryTransitionKind,
  shouldBootstrap: boolean,
): RecoverySdkDecision<TState> {
  return Object.freeze({
    accepted: true,
    kind,
    state,
    sdkState,
    action: shouldBootstrap ? 'bootstrap' : 'observe',
    shouldConnect: false,
    shouldRepublish: false,
    shouldBootstrap,
  });
}

function normalizeSdkState(value: RecoverySdkState): Exclude<RecoverySdkState, 'Connected' | 'Reconnecting' | 'Reconnected' | 'Disconnected'> {
  switch (value) {
    case 'Connected': return 'connected';
    case 'Reconnecting': return 'reconnecting';
    case 'Reconnected': return 'reconnected';
    case 'Disconnected': return 'disconnected';
    case 'connected':
    case 'reconnecting':
    case 'reconnected':
    case 'disconnected':
      return value;
    default:
      throw new Error('INVALID_SDK_STATE');
  }
}

/**
 * Models credential refresh and full-disconnect bootstrap without extending
 * continuity from activity.  All state transitions are synchronous and pure
 * with respect to external systems.
 */
export class TransportRecoveryStateMachine<
  TSessionRef = string,
  TLeaseRef = string,
  TContinuityId = string,
  TAlias = string,
  TCredentialRef = string,
  TEpoch = number,
> {
  readonly #nowMs: () => number;
  readonly #epochCodec: RecoveryEpochCodec<TEpoch>;
  readonly #reconnectPolicy: ReconnectPolicy;
  readonly #ownerComparator: Required<TransportRecoveryOwnerComparator<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef
  >>;
  readonly #ownerComparatorInjected: {
    readonly session: boolean;
    readonly lease: boolean;
    readonly alias: boolean;
    readonly credential: boolean;
  };
  #terminalDisconnected = false;
  #bootstrapAuthorized = false;
  #stopped = false;
  #state: TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >;

  constructor(
    start: TransportRecoveryStart<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TAlias,
      TCredentialRef,
      TEpoch
    >,
    options: TransportRecoveryOptions<
      TEpoch,
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TAlias,
      TCredentialRef
    > = {},
  ) {
    if (!hasValue(start.realtime_session_ref) || !hasValue(start.device_lease_ref)) {
      throw new Error('MISSING_T11B_TRANSPORT_BINDING');
    }
    if (!hasValue(start.continuity_id) || !aliasesValid(start.transport_aliases)) {
      throw new Error('MISSING_T11B_TRANSPORT_BINDING');
    }
    this.#epochCodec = options.epochCodec
      ?? (typeof start.epoch === 'string'
        ? (decimalEpochCodec as unknown as RecoveryEpochCodec<TEpoch>)
        : (numericEpochCodec as unknown as RecoveryEpochCodec<TEpoch>));
    this.#reconnectPolicy = new ReconnectPolicy(options.reconnectPolicy);
    const suppliedComparator = options.ownerComparator ?? options.bindingEquality;
    const defaultComparator = defaultOwnerComparator<
      TSessionRef,
      TLeaseRef,
      TContinuityId,
      TAlias,
      TCredentialRef
    >();
    this.#ownerComparator = {
      sameSessionRef: suppliedComparator?.sameSessionRef ?? defaultComparator.sameSessionRef!,
      sameLeaseRef: suppliedComparator?.sameLeaseRef ?? defaultComparator.sameLeaseRef!,
      sameContinuityId: suppliedComparator?.sameContinuityId ?? defaultComparator.sameContinuityId!,
      sameAlias: suppliedComparator?.sameAlias ?? defaultComparator.sameAlias!,
      sameCredentialRef: suppliedComparator?.sameCredentialRef ?? defaultComparator.sameCredentialRef!,
    };
    this.#ownerComparatorInjected = {
      session: suppliedComparator?.sameSessionRef !== undefined,
      lease: suppliedComparator?.sameLeaseRef !== undefined,
      alias: suppliedComparator?.sameAlias !== undefined,
      credential: suppliedComparator?.sameCredentialRef !== undefined,
    };
    let initialEpoch: TEpoch;
    try {
      initialEpoch = this.#epochCodec.validate(start.epoch);
    } catch {
      throw new Error('INVALID_RECOVERY_EPOCH');
    }
    const initialNow = finiteTime(
      start.now_ms ?? options.nowMs?.() ?? Date.now(),
      'INVALID_RECOVERY_CLOCK',
    );
    const continuityExpiry = finiteTime(
      start.continuity_expires_at_ms,
      'INVALID_RECOVERY_CLOCK',
    );
    if (continuityExpiry <= initialNow) throw new Error('CONTINUITY_EXPIRED');
    if (!hasValue(start.credential_ref)) throw new Error('MISSING_CREDENTIAL');
    if (!Number.isFinite(start.credential_expires_at_ms)
      || start.credential_expires_at_ms <= initialNow) {
      throw new Error('CREDENTIAL_EXPIRED');
    }
    if (start.credential_expires_at_ms > continuityExpiry) {
      throw new Error('CREDENTIAL_EXCEEDS_CONTINUITY');
    }
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#state = freezeState({
      realtime_session_ref: start.realtime_session_ref,
      device_lease_ref: start.device_lease_ref,
      continuity_id: start.continuity_id,
      transport_aliases: start.transport_aliases,
      epoch: initialEpoch,
      status: 'connected',
      credential_ref: start.credential_ref,
      credential_expires_at_ms: start.credential_expires_at_ms,
      continuity_expires_at_ms: continuityExpiry,
      disconnected_at_ms: undefined,
    });
  }

  get state(): TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  > {
    return this.#state;
  }

  snapshot(): TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  > {
    return this.#state;
  }

  continuityExpired(atMs = this.#nowMs()): boolean {
    return finiteTime(atMs, 'INVALID_RECOVERY_CLOCK') >= this.#state.continuity_expires_at_ms;
  }

  continuityRemainingMs(atMs = this.#nowMs()): number {
    const remaining = this.#state.continuity_expires_at_ms
      - finiteTime(atMs, 'INVALID_RECOVERY_CLOCK');
    return Math.max(0, remaining);
  }

  /** Mark the transport disconnected without touching continuity expiry. */
  markDisconnected(atMs = this.#nowMs()): RecoveryTransition<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    const now = finiteTime(atMs, 'INVALID_RECOVERY_CLOCK');
    this.#terminalDisconnected = true;
    this.#bootstrapAuthorized = false;
    if (this.#state.status === 'disconnected') {
      return accepted('disconnected_marked', this.#state);
    }
    this.#state = freezeState({ ...this.#state, status: 'disconnected', disconnected_at_ms: now });
    return accepted('disconnected_marked', this.#state);
  }

  /**
   * Connected credential refresh keeps session, lease, epoch, aliases, and
   * continuity_id unchanged.  Only the opaque credential ref and its expiry
   * are replaced.
   */
  refreshCredential(
    input: CredentialRefreshInput<TCredentialRef>,
  ): RecoveryTransition<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    if (this.#stopped) return rejected(this.#state, 'STOPPED');
    const now = finiteTime(input.at_ms ?? this.#nowMs(), 'INVALID_RECOVERY_CLOCK');
    if (this.#state.status !== 'connected') {
      return rejected(this.#state, 'REQUIRES_CONNECTED_SESSION');
    }
    if (now >= this.#state.continuity_expires_at_ms) {
      return rejected(this.#state, 'CONTINUITY_EXPIRED');
    }
    if (!hasValue(input.credential_ref)) return rejected(this.#state, 'MISSING_CREDENTIAL');
    const credentialComparison = compareOwner(
      input.credential_ref,
      this.#state.credential_ref,
      (left, right) => this.#ownerComparator.sameCredentialRef(left, right),
      this.#ownerComparatorInjected.credential,
    );
    if (credentialComparison.failed) return rejected(this.#state, 'OWNER_COMPARATOR_FAILED');
    if (credentialComparison.equal) {
      return rejected(this.#state, 'CREDENTIAL_NOT_ROTATED');
    }
    if (!Number.isFinite(input.credential_expires_at_ms)
      || input.credential_expires_at_ms <= now) {
      return rejected(this.#state, 'CREDENTIAL_EXPIRED');
    }
    if (input.credential_expires_at_ms > this.#state.continuity_expires_at_ms) {
      return rejected(this.#state, 'CREDENTIAL_EXCEEDS_CONTINUITY');
    }
    this.#state = freezeState({
      ...this.#state,
      credential_ref: input.credential_ref,
      credential_expires_at_ms: input.credential_expires_at_ms,
    });
    return accepted('connected_credential_refresh', this.#state);
  }

  tryRefreshCredential(
    input: CredentialRefreshInput<TCredentialRef>,
  ): RecoveryTransition<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    return this.refreshCredential(input);
  }

  /**
   * Full-disconnect bootstrap requires a complete owner-provided T11B binding
   * and a strictly advanced epoch. continuity_id and its owner-supplied
   * deadline are carried forward; activity never changes either value.
   */
  bootstrapDisconnected(
    input: DisconnectedBootstrapInput<TSessionRef, TLeaseRef, TAlias, TCredentialRef, TEpoch>,
  ): RecoveryTransition<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    const nested = input.t11b;
    const aliases = input.transport_aliases ?? nested?.transport_aliases;
    const nextEpoch = input.epoch ?? nested?.epoch;
    const nextSession = input.realtime_session_ref ?? nested?.realtime_session_ref;
    const nextLease = input.device_lease_ref ?? nested?.device_lease_ref;
    const nextCredential = input.credential_ref ?? nested?.credential_ref;
    const nextCredentialExpiry = input.credential_expires_at_ms
      ?? nested?.credential_expires_at_ms;
    const now = finiteTime(input.at_ms ?? this.#nowMs(), 'INVALID_RECOVERY_CLOCK');
    const explicitOwnerGate = input.owner_allows_bootstrap
      ?? input.ownerAllowsBootstrap
      ?? input.owner_allowed
      ?? input.ownerAllowed
      ?? input.t11b_allow_bootstrap
      ?? input.t11bAllowBootstrap
      ?? nested?.owner_allows_bootstrap
      ?? nested?.ownerAllowsBootstrap
      ?? nested?.owner_allowed
      ?? nested?.ownerAllowed
      ?? nested?.allow_bootstrap;
    if (input.stopped === true || input.stop === true
      || input.clientStopped === true || input.client_stop === true) this.#stopped = true;
    if (explicitOwnerGate === false) this.#bootstrapAuthorized = false;

    if (this.#stopped) return rejected(this.#state, 'STOPPED');
    if (this.#state.status !== 'disconnected') {
      return rejected(this.#state, 'REQUIRES_FULL_DISCONNECT');
    }
    if (now >= this.#state.continuity_expires_at_ms) {
      return rejected(this.#state, 'CONTINUITY_EXPIRED');
    }
    // A terminal SDK event is not owner authority. The caller must carry an
    // explicit owner/T11B allow, or use a decision that was armed by one.
    if (explicitOwnerGate === false
      || (explicitOwnerGate !== true && !this.#bootstrapAuthorized)) {
      return rejected(this.#state, 'OWNER_BOOTSTRAP_NOT_ALLOWED');
    }
    if (explicitOwnerGate === true) this.#bootstrapAuthorized = true;
    if (!aliasesValid(aliases)
      || nextEpoch === undefined
      || !hasValue(nextSession)
      || !hasValue(nextLease)) {
      return rejected(this.#state, 'MISSING_T11B_TRANSPORT_BINDING');
    }
    let advancedEpoch: TEpoch;
    try {
      advancedEpoch = this.#epochCodec.validate(nextEpoch);
    } catch {
      return rejected(this.#state, 'INVALID_RECOVERY_EPOCH');
    }
    if (this.#epochCodec.compare(advancedEpoch, this.#state.epoch) <= 0) {
      return rejected(this.#state, 'CONNECTION_EPOCH_NOT_ADVANCED');
    }
    const sessionComparison = compareOwner(
      nextSession as TSessionRef,
      this.#state.realtime_session_ref,
      (left, right) => this.#ownerComparator.sameSessionRef(left, right),
      this.#ownerComparatorInjected.session,
    );
    const leaseComparison = compareOwner(
      nextLease as TLeaseRef,
      this.#state.device_lease_ref,
      (left, right) => this.#ownerComparator.sameLeaseRef(left, right),
      this.#ownerComparatorInjected.lease,
    );
    const aliasComparison = aliasesCompare(
      aliases,
      this.#state.transport_aliases,
      (left, right) => this.#ownerComparator.sameAlias(left, right),
      this.#ownerComparatorInjected.alias,
    );
    if (sessionComparison.failed || leaseComparison.failed || aliasComparison.failed) {
      return rejected(this.#state, 'OWNER_COMPARATOR_FAILED');
    }
    if (sessionComparison.equal || leaseComparison.equal || aliasComparison.equal) {
      return rejected(this.#state, 'TRANSPORT_BINDING_NOT_ROTATED');
    }
    if (!hasValue(nextCredential)) return rejected(this.#state, 'MISSING_CREDENTIAL');
    const credential = nextCredential as TCredentialRef;
    const credentialComparison = compareOwner(
      credential,
      this.#state.credential_ref,
      (left, right) => this.#ownerComparator.sameCredentialRef(left, right),
      this.#ownerComparatorInjected.credential,
    );
    if (credentialComparison.failed) return rejected(this.#state, 'OWNER_COMPARATOR_FAILED');
    if (credentialComparison.equal) {
      return rejected(this.#state, 'CREDENTIAL_NOT_ROTATED');
    }
    if (nextCredentialExpiry === undefined
      || !Number.isFinite(nextCredentialExpiry)
      || nextCredentialExpiry <= now) {
      return rejected(this.#state, 'CREDENTIAL_EXPIRED');
    }
    if (nextCredentialExpiry > this.#state.continuity_expires_at_ms) {
      return rejected(this.#state, 'CREDENTIAL_EXCEEDS_CONTINUITY');
    }
    const credentialExpiry = nextCredentialExpiry;
    this.#state = freezeState({
      ...this.#state,
      realtime_session_ref: nextSession as TSessionRef,
      device_lease_ref: nextLease as TLeaseRef,
      transport_aliases: aliases,
      epoch: advancedEpoch,
      status: 'connected',
      credential_ref: credential,
      credential_expires_at_ms: credentialExpiry,
      disconnected_at_ms: undefined,
    });
    this.#terminalDisconnected = false;
    this.#bootstrapAuthorized = false;
    return accepted('fully_disconnected_bootstrap', this.#state);
  }

  bootstrap(
    input: DisconnectedBootstrapInput<TSessionRef, TLeaseRef, TAlias, TCredentialRef, TEpoch>,
  ): RecoveryTransition<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    return this.bootstrapDisconnected(input);
  }

  /** Passive events are observations only and never extend continuity. */
  observe(event: RecoveryPassiveEvent, atMs = this.#nowMs()): RecoveryTransition<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    if (!['heartbeat', 'reconnect', 'media', 'model'].includes(event)) {
      throw new Error('INVALID_RECOVERY_EVENT');
    }
    finiteTime(atMs, 'INVALID_RECOVERY_CLOCK');
    return accepted('passive_observation', this.#state);
  }

  heartbeat(atMs = this.#nowMs()) {
    return this.observe('heartbeat', atMs);
  }

  reconnect(atMs = this.#nowMs()) {
    return this.observe('reconnect', atMs);
  }

  mediaActivity(atMs = this.#nowMs()) {
    return this.observe('media', atMs);
  }

  modelActivity(atMs = this.#nowMs()) {
    return this.observe('model', atMs);
  }

  /**
   * Observe LiveKit SDK state without taking over SDK reconnect behavior.
   * Reconnecting/Reconnected are passive observations: no connect or
   * republish action is ever returned. Only terminal Disconnected plus an
   * explicit owner/T11B allow produces a bootstrap decision.
   */
  observeSdkState(input: RecoverySdkStateInput, stateOptions: Omit<RecoverySdkObservationInput, 'state'> = {}): RecoverySdkDecision<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    const observation: RecoverySdkObservationInput = typeof input === 'string'
      ? { ...stateOptions, state: input }
      : input;
    if (observation.stopped === true || observation.stop === true
      || observation.clientStopped === true || observation.client_stop === true) this.#stopped = true;
    const sdkState = normalizeSdkState(observation.state);
    const atMs = finiteTime(observation.at_ms ?? observation.atMs ?? this.#nowMs(), 'INVALID_RECOVERY_CLOCK');
    const ownerAllowsBootstrap = observation.owner_allows_bootstrap
      ?? observation.ownerAllowsBootstrap
      ?? observation.owner_allowed
      ?? observation.ownerAllowed
      ?? observation.t11b_allow_bootstrap
      ?? observation.t11bAllowBootstrap
      ?? false;
    if (sdkState === 'reconnecting') {
      this.observe('reconnect', atMs);
      return sdkDecision('reconnecting', this.#state, 'passive_observation', false);
    }
    if (sdkState === 'reconnected') {
      this.observe('reconnect', atMs);
      // A late SDK success event cannot resurrect a terminal Disconnected
      // binding. The owner/T11B bootstrap must rotate the binding and advance
      // the epoch before this state may become connected again.
      if (this.#state.status === 'disconnected' && !this.#terminalDisconnected) {
        this.#state = freezeState({ ...this.#state, status: 'connected', disconnected_at_ms: undefined });
        this.#terminalDisconnected = false;
        this.#bootstrapAuthorized = false;
      }
      return sdkDecision('reconnected', this.#state, 'passive_observation', false);
    }
    if (sdkState === 'connected') {
      this.observe('reconnect', atMs);
      return sdkDecision('connected', this.#state, 'passive_observation', false);
    }

    const marked = this.markDisconnected(atMs);
    this.#bootstrapAuthorized = ownerAllowsBootstrap;
    if (ownerAllowsBootstrap && !this.#stopped) {
      this.#bootstrapAuthorized = true;
      return sdkDecision('disconnected', marked.state, 'fully_disconnected_bootstrap', true);
    }
    return sdkDecision('disconnected', marked.state, 'disconnected_marked', false);
  }

  observeLiveKitState(input: RecoverySdkStateInput, stateOptions: Omit<RecoverySdkObservationInput, 'state'> = {}): RecoverySdkDecision<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    return this.observeSdkState(input, stateOptions);
  }

  onSdkState(input: RecoverySdkStateInput, stateOptions: Omit<RecoverySdkObservationInput, 'state'> = {}): RecoverySdkDecision<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    return this.observeSdkState(input, stateOptions);
  }

  handleSdkState(input: RecoverySdkStateInput, stateOptions: Omit<RecoverySdkObservationInput, 'state'> = {}): RecoverySdkDecision<TransportRecoveryState<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >> {
    return this.observeSdkState(input, stateOptions);
  }

  /** Return a bounded retry delay fenced by Stop, attempt/time, and owner deadlines. */
  scheduleReconnect(input: ReconnectScheduleInput): ReconnectSchedule {
    return this.#reconnectPolicy.schedule({
      ...input,
      credentialExpiresAtMs: input.credentialExpiresAtMs ?? this.#state.credential_expires_at_ms,
      continuityExpiresAtMs: input.continuityExpiresAtMs ?? this.#state.continuity_expires_at_ms,
    });
  }

  nextReconnect(input: ReconnectScheduleInput): ReconnectSchedule {
    return this.scheduleReconnect(input);
  }

  stopReconnect(): void {
    this.#stopped = true;
    this.#reconnectPolicy.stop();
  }

  stop(): void {
    this.#stopped = true;
    this.#reconnectPolicy.stop();
  }

  stopRecovery(): void {
    this.stop();
  }

  get stopped(): boolean {
    return this.#stopped;
  }
}

export const RecoveryStateMachine = TransportRecoveryStateMachine;
export const createTransportRecoveryStateMachine = <
  TSessionRef = string,
  TLeaseRef = string,
  TContinuityId = string,
  TAlias = string,
  TCredentialRef = string,
  TEpoch = number,
>(
  start: TransportRecoveryStart<
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef,
    TEpoch
  >,
  options: TransportRecoveryOptions<
    TEpoch,
    TSessionRef,
    TLeaseRef,
    TContinuityId,
    TAlias,
    TCredentialRef
  > = {},
): TransportRecoveryStateMachine<
  TSessionRef,
  TLeaseRef,
  TContinuityId,
  TAlias,
  TCredentialRef,
  TEpoch
> => new TransportRecoveryStateMachine(start, options);
