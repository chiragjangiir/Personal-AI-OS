import type {
  BootstrapRequest,
  AcceptedUserActivity,
  CanonicalTimestamp,
  DeviceLeaseRecord,
  ExternalAlias,
  HandoffRequest,
  HandoffFactRecord,
  IdempotencyKey,
  IdempotencyRecord,
  OpaqueCanonicalRef,
  OpaqueGovernanceValue,
  OutboxEvent,
  CurrentBindingLookup,
  RealtimeCurrentBindingProjection,
  RealtimeSessionRecord,
  RealtimeTransportBinding,
  StopRequest,
  VerifiedActivityAcceptance,
} from "./types.ts";

/** T03 supplies the decision; T11B does not recreate governance semantics. */
export interface LeasePolicyDecision {
  readonly allowed: true;
  readonly policyDecisionRef: OpaqueGovernanceValue;
  readonly capabilities: readonly string[];
  readonly purpose: string;
  readonly leaseExpiresAt: CanonicalTimestamp;
  readonly revocable: true;
}

export interface LeasePolicyPort {
  evaluate(input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly capabilities: readonly string[];
    readonly purpose: string;
    readonly occurredAt: CanonicalTimestamp;
    readonly governance: OpaqueGovernanceValue;
  }): Promise<LeasePolicyDecision>;
}

/** T04/owner acceptance verification; T11B never infers acceptance locally. */
export interface ActivityAcceptancePort {
  verify(activity: AcceptedUserActivity): Promise<VerifiedActivityAcceptance>;
}

export interface VerifiedTransportDisconnection {
  readonly verified: true;
  readonly disconnectedAt: CanonicalTimestamp;
  readonly authorityProof: OpaqueGovernanceValue;
}

export interface TransportDisconnectionPort {
  verify(input: {
    readonly binding: RealtimeTransportBinding;
    readonly userId: string;
    readonly deviceId: string;
    readonly occurredAt: CanonicalTimestamp;
    readonly governance: OpaqueGovernanceValue;
  }): Promise<VerifiedTransportDisconnection>;
}

/** T02 owns the transaction, CAS, unique keys, outbox, and replay substrate. */
export interface RealtimeAuthorityTransaction {
  readSession(ref: OpaqueCanonicalRef): Promise<RealtimeSessionRecord | undefined>;
  readSessionByContinuityId(
    continuityId: string,
  ): Promise<RealtimeSessionRecord | undefined>;
  readLease(ref: OpaqueCanonicalRef): Promise<DeviceLeaseRecord | undefined>;
  /** T02 returns only authoritative facts from one current-binding snapshot. */
  readCurrentBinding(
    lookup: CurrentBindingLookup,
  ): Promise<RealtimeCurrentBindingProjection | undefined>;
  /** Locks this user/device/purpose session scope for the rest of the transaction (concurrent Starts serialize) and
   * returns every session still active for it, each as a validated current-binding projection. */
  readActiveDeviceSessions(input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly purpose: string;
  }): Promise<readonly RealtimeCurrentBindingProjection[]>;
  readIdempotency(
    operation: string,
    idempotencyKey: IdempotencyKey,
  ): Promise<IdempotencyRecord | undefined>;
  writeSession(input: {
    readonly expectedRevision?: string;
    readonly record: RealtimeSessionRecord;
  }): Promise<void>;
  writeLease(input: {
    readonly expectedLeaseVersion?: string;
    readonly record: DeviceLeaseRecord;
  }): Promise<void>;
  writeBinding(input: {
    readonly expectedConnectionEpoch?: string;
    readonly binding: RealtimeTransportBinding;
  }): Promise<void>;
  /** T11B internal fact seam; T02 persists it in the surrounding transaction. */
  recordHandoffFact(record: HandoffFactRecord): Promise<void>;
  writeIdempotency(record: IdempotencyRecord): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<OpaqueCanonicalRef>;
}

export interface RealtimeAuthorityRepository {
  transaction<T>(
    operation: string,
    work: (transaction: RealtimeAuthorityTransaction) => Promise<T>,
  ): Promise<T>;
}

/** T02/repository-issued identity refs and provider aliases. */
export interface RealtimeIdentityPort {
  createContinuityId(input: {
    readonly userId: string;
    readonly requestId: string;
  }): string;
  assertRepositoryIssuedRef(
    value: OpaqueCanonicalRef,
    kind: "RealtimeSession" | "DeviceLease",
  ): void;
  createSessionRef(input: {
    readonly userId: string;
    readonly continuityId: string;
    readonly requestId: string;
  }): OpaqueCanonicalRef;
  createDeviceLeaseRef(input: {
    readonly sessionRef: OpaqueCanonicalRef;
    readonly deviceId: string;
    readonly requestId: string;
  }): OpaqueCanonicalRef;
  createTransportAlias(input: {
    readonly provider: ExternalAlias;
    readonly sessionRef: OpaqueCanonicalRef;
    readonly deviceId: string;
    readonly connectionEpoch: string;
    readonly requestId: string;
  }): ExternalAlias;
  createConnectionId(input: {
    readonly deviceId: string;
    readonly requestId: string;
  }): string;
}

export interface RealtimeClockPort {
  now(): CanonicalTimestamp;
}

/** Equality for opaque refs/aliases; T11B never parses their owner fields. */
export interface OpaqueEqualityPort {
  key(value: OpaqueCanonicalRef): string;
  same(left: OpaqueCanonicalRef, right: OpaqueCanonicalRef): boolean;
}

export interface RealtimeAuthorityPorts {
  readonly repository: RealtimeAuthorityRepository;
  readonly policy: LeasePolicyPort;
  readonly activityAcceptance: ActivityAcceptancePort;
  readonly transportDisconnection: TransportDisconnectionPort;
  readonly identity: RealtimeIdentityPort;
  readonly clock: RealtimeClockPort;
  readonly equality: OpaqueEqualityPort;
}

export interface T11BBootstrapPort {
  bootstrap(request: BootstrapRequest): Promise<unknown>;
}

export interface T11BHandoffPort {
  handoff(request: HandoffRequest): Promise<unknown>;
}

export interface T11BStopPort {
  stop(request: StopRequest): Promise<unknown>;
}
