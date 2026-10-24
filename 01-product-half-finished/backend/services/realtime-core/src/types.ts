/**
 * T11B's storage-neutral realtime authority types.
 *
 * Canonical wire objects, governance decisions, and provider aliases remain
 * opaque at this seam.  T02 owns persistence mechanics; this package owns
 * the lifecycle rules expressed by these records and commands.
 */

declare const decimalEpochBrand: unique symbol;
declare const decimalCounterBrand: unique symbol;
declare const canonicalTimestampBrand: unique symbol;

/** Non-zero decimal string for PostgreSQL NUMERIC(38,0); never use JS Number. */
export type DecimalConnectionEpoch = string & {
  readonly [decimalEpochBrand]: "t11b-decimal-connection-epoch";
};

/** Internal CAS/version counters may start at zero; they are not connection epochs. */
export type DecimalCounter = string & {
  readonly [decimalCounterBrand]: "t11b-decimal-counter";
};

export type CanonicalTimestamp = string & {
  readonly [canonicalTimestampBrand]: "t11b-canonical-timestamp";
};

/** T01/T03/T04/T10-owned values are opaque and are not re-schematized here. */
export type OpaqueOwnerValue = string | Readonly<Record<string, unknown>>;
export type OpaqueCanonicalRef = OpaqueOwnerValue;
export type ExternalAlias = OpaqueOwnerValue;
export type OpaqueGovernanceValue = OpaqueOwnerValue;

/** How far a device-reported time (start, activity) may lead the server clock. Independent clocks always disagree
 *  by seconds (host and device clocks can differ by several seconds); the look-back windows
 *  stay as strict as before. */
export const DEVICE_CLOCK_LEAD_MS = 2 * 60 * 1000;

/** Snapshot opaque owner values without interpreting their owner-defined fields. */
export function snapshotOpaqueOwnerValue(value: unknown): OpaqueOwnerValue {
  const snapshot = snapshotValue(value, new WeakSet<object>());
  if (typeof snapshot !== "string" && (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot))) {
    throw new Error("INVALID_OPAQUE_OWNER_VALUE");
  }
  return snapshot as OpaqueOwnerValue;
}

function snapshotValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("INVALID_OPAQUE_OWNER_VALUE");
    return value;
  }
  if (typeof value !== "object") throw new Error("INVALID_OPAQUE_OWNER_VALUE");
  if (ancestors.has(value)) throw new Error("OPAQUE_OWNER_VALUE_CYCLE");
  ancestors.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string") || names.length !== value.length + 1) {
      throw new Error("INVALID_OPAQUE_OWNER_VALUE");
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) throw new Error("INVALID_OPAQUE_OWNER_VALUE");
      result.push(snapshotValue(descriptor.value, ancestors));
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("INVALID_OPAQUE_OWNER_VALUE");
  const names = Object.getOwnPropertyNames(value);
  const enumerableNames = Object.keys(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string") || names.length !== enumerableNames.length) {
    throw new Error("INVALID_OPAQUE_OWNER_VALUE");
  }
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true) throw new Error("INVALID_OPAQUE_OWNER_VALUE");
    result[name] = snapshotValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

export type UserId = string;
export type DeviceId = string;
export type ContinuityId = string;
export type RequestId = string;
export type IdempotencyKey = string;

export type RealtimeSessionState = "active" | "terminal";
export type ContinuityState = "active" | "ended";
export type DeviceLeaseState = "active" | "released" | "revoked" | "expired";
export type TransportBindingState = "connected" | "disconnected" | "released";
export type HandoffState = "completed" | "replayed" | "rejected";

export type RealtimeActivityKind =
  | "accepted_user_activity"
  | "heartbeat"
  | "reconnect"
  | "media"
  | "model"
  | "sdk";

export type RealtimeOperation =
  | "bootstrap"
  | "connected_credential_refresh"
  | "handoff"
  | "activity_renewal"
  | "device_lease_renewal"
  | "media_stop"
  | "end_continuity";

/** Internal transaction scope; RFC-008 does not expose this as a terminal operation. */
export type RealtimeIdempotencyOperation = RealtimeOperation |
  "fully_disconnected_refresh" |
  "final_transcript_evidence";

export type StopReason =
  | "user_stop"
  | "lease_expired"
  | "permission_revoked"
  | "disconnect"
  | "provider_failure"
  | "cancelled";

export type TerminalReceiptStatus =
  | "success"
  | "error"
  | "cancelled"
  | "expired"
  | "revoked"
  | "indeterminate";

const DECIMAL_EPOCH_PATTERN = /^[1-9][0-9]{0,37}$/u;
const DECIMAL_COUNTER_PATTERN = /^(0|[1-9][0-9]{0,37})$/u;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/u;

export function assertDecimalConnectionEpoch(value: unknown): DecimalConnectionEpoch {
  if (typeof value !== "string" || !DECIMAL_EPOCH_PATTERN.test(value)) {
    throw new Error("INVALID_CONNECTION_EPOCH");
  }
  return value as DecimalConnectionEpoch;
}

export function isDecimalConnectionEpoch(value: unknown): value is DecimalConnectionEpoch {
  try {
    assertDecimalConnectionEpoch(value);
    return true;
  } catch {
    return false;
  }
}

export function assertDecimalCounter(value: unknown): DecimalCounter {
  if (typeof value !== "string" || !DECIMAL_COUNTER_PATTERN.test(value)) {
    throw new Error("INVALID_DECIMAL_COUNTER");
  }
  return value as DecimalCounter;
}

export function incrementDecimalCounter(value: DecimalCounter): DecimalCounter {
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const next = digits[index]!.charCodeAt(0) - 48 + carry;
    if (next === 10) digits[index] = "0";
    else {
      digits[index] = String(next);
      carry = 0;
    }
  }
  return assertDecimalCounter(carry === 1 ? `1${digits.join("")}` : digits.join(""));
}

export function compareDecimalConnectionEpoch(
  left: DecimalConnectionEpoch,
  right: DecimalConnectionEpoch,
): -1 | 0 | 1 {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Increment a decimal epoch without converting it to Number. */
export function incrementDecimalConnectionEpoch(
  value: DecimalConnectionEpoch,
): DecimalConnectionEpoch {
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const next = digits[index]!.charCodeAt(0) - 48 + carry;
    if (next === 10) {
      digits[index] = "0";
    } else {
      digits[index] = String(next);
      carry = 0;
    }
  }
  const result = carry === 1 ? `1${digits.join("")}` : digits.join("");
  return assertDecimalConnectionEpoch(result);
}

export function assertCanonicalTimestamp(value: unknown): CanonicalTimestamp {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error("INVALID_TIMESTAMP");
  }
  return value as CanonicalTimestamp;
}

export function assertIdentifier(value: unknown, code = "INVALID_IDENTIFIER"): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new Error(code);
  }
  return value;
}

export interface RealtimeTransportBinding {
  readonly state: TransportBindingState;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly deviceId: DeviceId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly provider: ExternalAlias;
  readonly transportSessionAlias: ExternalAlias;
  readonly roomAlias: ExternalAlias;
  readonly deviceAlias: ExternalAlias;
  readonly connectionId: string;
}

export interface RealtimeSessionRecord {
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly userId: UserId;
  readonly continuityId: ContinuityId;
  readonly state: RealtimeSessionState;
  readonly continuityState: ContinuityState;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly lastAcceptedUserActivityAt: CanonicalTimestamp;
  readonly terminalAt?: CanonicalTimestamp;
  readonly terminalReason?: string;
  readonly activeDeviceId: DeviceId;
  readonly activeDeviceLeaseRef: OpaqueCanonicalRef;
  readonly binding: RealtimeTransportBinding;
  readonly revision: DecimalCounter;
}

export interface DeviceLeaseRecord {
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly state: DeviceLeaseState;
  readonly capabilities: readonly string[];
  readonly purpose: string;
  readonly issuedAt: CanonicalTimestamp;
  readonly expiresAt: CanonicalTimestamp;
  readonly revocable: true;
  readonly leaseVersion: DecimalCounter;
  readonly fencingToken: DecimalCounter;
  readonly policyDecisionRef: OpaqueGovernanceValue;
}

/**
 * Closed lookup for the authoritative current-binding read.  A lookup is
 * either an exact canonical session reference or a continuity identifier;
 * callers may not provide both and T02 never resolves a ref from an alias or
 * an in-process collection.
 */
export type CurrentBindingLookup =
  | {
      readonly realtimeSessionRef: OpaqueCanonicalRef;
      readonly continuityId?: never;
    }
  | {
      readonly continuityId: ContinuityId;
      readonly realtimeSessionRef?: never;
    };

export type RealtimeCurrentBindingLookup = CurrentBindingLookup;

/**
 * T02's storage projection for T11B.  It contains only authoritative facts
 * from the same PostgreSQL snapshot; operation-specific admissibility remains
 * a T11B decision.
 */
export interface RealtimeCurrentBindingProjection {
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
}

export type CurrentBindingProjection = RealtimeCurrentBindingProjection;
export type RealtimeCurrentBindingSnapshot = RealtimeCurrentBindingProjection;

export interface AcceptedUserActivity {
  readonly activityId: string;
  readonly kind: "accepted_user_activity";
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly occurredAt: CanonicalTimestamp;
  /** Opaque T04/owner acceptance proof; `accepted:true` alone is never authority. */
  readonly acceptanceRef: OpaqueOwnerValue;
  readonly accepted: true;
}

export interface RealtimeActivity extends Omit<AcceptedUserActivity, "kind" | "accepted"> {
  readonly kind: RealtimeActivityKind;
  readonly accepted?: boolean;
}

export interface ActivityRenewalResult {
  readonly renewed: boolean;
  readonly reason: "accepted_user_activity" | "non_renewing_activity" | "already_ended";
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly lastAcceptedUserActivityAt: CanonicalTimestamp;
}

export interface VerifiedActivityAcceptance {
  readonly verified: true;
  readonly acceptanceRef: OpaqueOwnerValue;
  readonly acceptedAt: CanonicalTimestamp;
  readonly authorityWatermark: OpaqueOwnerValue;
}

export interface HandoffRequest {
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly fromDeviceId: DeviceId;
  readonly toDeviceId: DeviceId;
  readonly expectedConnectionEpoch: DecimalConnectionEpoch;
  readonly expectedLeaseVersion: DecimalCounter;
  readonly occurredAt: CanonicalTimestamp;
  readonly governance: OpaqueGovernanceValue;
}

export interface HandoffResult {
  readonly state: HandoffState;
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly activeDeviceId: DeviceId;
  readonly activeDeviceLeaseRef: OpaqueCanonicalRef;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly leaseVersion: DecimalCounter;
  readonly fencingToken: DecimalCounter;
  readonly suppressedDeviceId?: DeviceId;
  readonly receipt: TerminalReceipt;
}

/**
 * Internal T11B durable handoff fact.  This is deliberately not a T01 wire
 * object: owner-defined refs and the outbox ref remain opaque at this seam.
 * The old lease transition and the new lease issuance are recorded together
 * so a committed handoff can be audited without reconstructing it from a
 * mutable session snapshot.
 */
export interface HandoffFactRecord {
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestFingerprint: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly fromDeviceId: DeviceId;
  readonly toDeviceId: DeviceId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly oldLeaseRef: OpaqueCanonicalRef;
  readonly expectedLeaseVersion: DecimalCounter;
  readonly releasedLeaseVersion: DecimalCounter;
  readonly releasedFencingToken: DecimalCounter;
  readonly newLeaseRef: OpaqueCanonicalRef;
  readonly newLeaseVersion: DecimalCounter;
  readonly newFencingToken: DecimalCounter;
  readonly suppressedDeviceId: DeviceId;
  readonly outboxEventRef: OpaqueOwnerValue;
  readonly occurredAt: CanonicalTimestamp;
}

export interface StopRequest {
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly operation: "media_stop" | "end_continuity";
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly deviceLeaseRef?: OpaqueCanonicalRef;
  readonly deviceId: DeviceId;
  readonly expectedConnectionEpoch: DecimalConnectionEpoch;
  readonly expectedLeaseVersion?: DecimalCounter;
  readonly reason: StopReason;
  readonly occurredAt: CanonicalTimestamp;
  readonly governance: OpaqueGovernanceValue;
}

export interface TerminalReceipt {
  readonly kind: "realtime_terminal_receipt";
  readonly operation: RealtimeOperation;
  readonly status: TerminalReceiptStatus;
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly realtimeSessionRef?: OpaqueCanonicalRef;
  readonly deviceLeaseRef?: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly leaseVersion?: DecimalCounter;
  readonly outcome: string;
  readonly errorCode?: string;
  readonly recordedAt: CanonicalTimestamp;
  readonly replayed: boolean;
  readonly outboxEventRef?: OpaqueCanonicalRef;
}

export interface BootstrapRequest {
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly mode: "initial" | "fully_disconnected";
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly continuityId?: ContinuityId;
  readonly existingSessionRef?: OpaqueCanonicalRef;
  readonly existingBinding?: RealtimeTransportBinding;
  readonly capabilities: readonly string[];
  readonly purpose: string;
  readonly occurredAt: CanonicalTimestamp;
  readonly governance: OpaqueGovernanceValue;
}

export interface BootstrapResult {
  readonly operation: "bootstrap";
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: ContinuityId;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly binding: RealtimeTransportBinding;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly leaseExpiresAt: CanonicalTimestamp;
  readonly receipt: TerminalReceipt;
}

export interface ConnectedRefreshRequest {
  readonly requestId: RequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly binding: RealtimeTransportBinding;
  readonly occurredAt: CanonicalTimestamp;
  readonly governance: OpaqueGovernanceValue;
}

export interface RefreshResult {
  readonly operation: "connected_credential_refresh";
  readonly binding: RealtimeTransportBinding;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly leaseExpiresAt: CanonicalTimestamp;
  readonly receipt: TerminalReceipt;
}

export interface OutboxEvent {
  readonly eventType: string;
  readonly aggregateRef: OpaqueCanonicalRef;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: CanonicalTimestamp;
  readonly payload: OpaqueOwnerValue;
}

export interface IdempotencyRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly requestFingerprint: string;
  readonly operation: RealtimeIdempotencyOperation;
  readonly result: unknown;
}
