import {
  assertCanonicalTimestamp,
  assertIdentifier,
  assertDecimalCounter,
  assertDecimalConnectionEpoch,
  incrementDecimalCounter,
  snapshotOpaqueOwnerValue,
  type AcceptedUserActivity,
  type BootstrapRequest,
  type BootstrapResult,
  type CanonicalTimestamp,
  type ConnectedRefreshRequest,
  type CurrentBindingLookup,
  type OpaqueGovernanceValue,
  type DeviceLeaseRecord,
  type HandoffRequest,
  type HandoffFactRecord,
  type HandoffResult,
  type IdempotencyRecord,
  type OpaqueCanonicalRef,
  type OpaqueOwnerValue,
  type RealtimeSessionRecord,
  type RealtimeCurrentBindingProjection,
  type RealtimeTransportBinding,
  type RefreshResult,
  type StopRequest,
  type TerminalReceipt,
  type VerifiedActivityAcceptance,
  DEVICE_CLOCK_LEAD_MS,
} from "./types.ts";
import {
  type RealtimeAuthorityPorts,
  type RealtimeAuthorityTransaction,
} from "./ports.ts";
import { nextConnectionEpoch } from "./connection-epoch.ts";
import { acceptedActivityDeadline, applyAcceptedUserActivityRenewal } from "./continuity-renewal.ts";
import { assertLeaseUsable, createDeviceLease, releaseDeviceLease } from "./device-lease-state-machine.ts";
import {
  assertConnectedRefreshBinding,
  assertBindingExactlyMatches,
  createFullyDisconnectedBinding,
  createTransportBinding,
  markBindingDisconnected,
} from "./transport-binding-state-machine.ts";
import { applyEndContinuity, applyMediaStop, applySupersede } from "./media-stop-service.ts";
import { applySessionHandoff } from "./session-handoff-state-machine.ts";

const INITIAL_EPOCH = assertDecimalConnectionEpoch("1");

/** T04's full owner event is carried opaquely through the T02 transaction. */
export const REALTIME_T04_ACCEPTED_USER_ACTIVITY_EVENT_TYPE =
  "realtime.t04.accepted_user_activity.v1" as const;

export interface RealtimeAcceptedUserActivityOwnerEvent {
  readonly actionReceipt: Readonly<Record<string, unknown>>;
  readonly currentBinding: Readonly<Record<string, unknown>>;
  readonly authorityProjection: Readonly<Record<string, unknown>>;
}

/** T02-local Apple cycling renewal command; shared contracts remain unchanged. */
export interface AppleCyclingRenewalRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  /** Canonical primary lease ref. `primaryDeviceLeaseRef` is accepted as an alias. */
  readonly deviceLeaseRef?: OpaqueCanonicalRef;
  readonly primaryDeviceLeaseRef?: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly deviceId: string;
  readonly expectedConnectionEpoch: string;
  readonly expectedLeaseVersion: string;
  readonly expectedFencingToken?: string;
  /** Caller upper bound; T03 issuance must fit without truncating its exact deadline. */
  readonly ttlSeconds: number;
  readonly occurredAt?: CanonicalTimestamp;
  readonly governance?: OpaqueGovernanceValue;
}

export interface AppleCyclingRenewalResult {
  /** Historical activity_renewal receipts are returned unchanged on exact replay only. */
  readonly operation: "device_lease_renewal" | "activity_renewal";
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly activeDeviceLeaseRef: OpaqueCanonicalRef;
  readonly activeDeviceId: string;
  readonly connectionEpoch: string;
  readonly leaseVersion: string;
  readonly fencingToken: string;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly leaseExpiresAt: CanonicalTimestamp;
  readonly binding: RealtimeTransportBinding;
  readonly receipt: TerminalReceipt;
}

function assertOccurredAtNotFuture(
  occurredAt: CanonicalTimestamp,
  now: CanonicalTimestamp,
): void {
  if (Date.parse(assertCanonicalTimestamp(occurredAt)) > Date.parse(assertCanonicalTimestamp(now)) + DEVICE_CLOCK_LEAD_MS) {
    throw new Error("CONTROL_TIME_UNTRUSTED");
  }
}

function assertActivityVerification(
  activity: AcceptedUserActivity,
  verification: VerifiedActivityAcceptance,
  now: CanonicalTimestamp,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): CanonicalTimestamp {
  if (verification?.verified !== true) throw new Error("ACTIVITY_ACCEPTANCE_INVALID");
  const acceptedAt = assertCanonicalTimestamp(verification.acceptedAt);
  if (Date.parse(acceptedAt) > Date.parse(assertCanonicalTimestamp(now)) + DEVICE_CLOCK_LEAD_MS ||
      Date.parse(activity.occurredAt) > Date.parse(acceptedAt) + DEVICE_CLOCK_LEAD_MS) {
    throw new Error("ACTIVITY_TIME_UNTRUSTED");
  }
  if (!sameRef(verification.acceptanceRef, activity.acceptanceRef)) {
    throw new Error("ACTIVITY_ACCEPTANCE_MISMATCH");
  }
  snapshotOpaqueOwnerValue(verification.authorityWatermark);
  return acceptedAt;
}

function fingerprint(value: unknown): string {
  return stableSerialize(value);
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("INVALID_FINGERPRINT_VALUE");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error("INVALID_FINGERPRINT_VALUE");
  }
  if (seen.has(value)) throw new Error("FINGERPRINT_CYCLE");
  seen.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string") || names.length !== value.length + 1) {
      throw new Error("INVALID_FINGERPRINT_VALUE");
    }
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) throw new Error("INVALID_FINGERPRINT_VALUE");
      items.push(stableSerialize(descriptor.value, seen));
    }
    const result = `[${items.join(",")}]`;
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  const names = Object.getOwnPropertyNames(value);
  if ((prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      names.length !== Object.keys(value).length) {
    throw new Error("INVALID_FINGERPRINT_VALUE");
  }
  const result = `{${names.sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true) throw new Error("INVALID_FINGERPRINT_VALUE");
    return `${JSON.stringify(key)}:${stableSerialize(descriptor.value, seen)}`;
  }).join(",")}}`;
  seen.delete(value);
  return result;
}

function replayResult<T extends { readonly receipt: TerminalReceipt }>(
  value: unknown,
  operation: TerminalReceipt["operation"],
  idempotencyKey: string,
  resultOperation: TerminalReceipt["operation"] = operation,
): T {
  const snapshot = snapshotOpaqueOwnerValue(value);
  if (typeof snapshot === "string") throw new Error("MALFORMED_REPLAY_RECORD");
  const record = snapshot as Record<string, unknown>;
  const receipt = assertReplayReceipt(record.receipt, operation, idempotencyKey);
  assertReplayResultRecord(record, receipt, operation, resultOperation);
  return Object.freeze({
    ...record,
    receipt: Object.freeze({ ...receipt, replayed: true }),
  }) as T;
}

function replayReceipt(
  value: unknown,
  operation: TerminalReceipt["operation"],
  idempotencyKey: string,
): TerminalReceipt {
  const receipt = assertReplayReceipt(value, operation, idempotencyKey);
  return Object.freeze({ ...receipt, replayed: true });
}

function assertReplayReceipt(
  value: unknown,
  operation: TerminalReceipt["operation"],
  idempotencyKey: string,
): TerminalReceipt {
  const snapshot = snapshotOpaqueOwnerValue(value);
  if (typeof snapshot === "string") throw new Error("MALFORMED_REPLAY_RECORD");
  const record = snapshot as Record<string, unknown>;
  const statuses = new Set(["success", "error", "cancelled", "expired", "revoked", "indeterminate"]);
  if (record.kind !== "realtime_terminal_receipt" || record.operation !== operation ||
      record.idempotencyKey !== idempotencyKey || typeof record.requestId !== "string" ||
      typeof record.status !== "string" || !statuses.has(record.status) ||
      typeof record.outcome !== "string" || record.outcome.length === 0 ||
      typeof record.replayed !== "boolean") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  assertIdentifier(record.requestId, "MALFORMED_REPLAY_RECORD");
  assertDecimalConnectionEpoch(record.connectionEpoch);
  assertCanonicalTimestamp(record.recordedAt);
  if (typeof record.continuityId !== "string" || record.continuityId.length === 0) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (record.realtimeSessionRef !== undefined) snapshotOpaqueOwnerValue(record.realtimeSessionRef);
  if (record.deviceLeaseRef !== undefined) snapshotOpaqueOwnerValue(record.deviceLeaseRef);
  if (record.leaseVersion !== undefined) assertDecimalCounter(record.leaseVersion);
  if (record.outboxEventRef !== undefined) snapshotOutboxRef(record.outboxEventRef);
  if (record.status === "success" && record.outboxEventRef === undefined) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  return record as unknown as TerminalReceipt;
}

function sameOpaqueValue(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function snapshotOutboxRef(value: unknown): OpaqueOwnerValue {
  const snapshot = snapshotOpaqueOwnerValue(value);
  if (typeof snapshot === "string") {
    if (snapshot.trim().length === 0) throw new Error("OUTBOX_REF_INVALID");
    return snapshot;
  }
  if (Object.keys(snapshot).length === 0) throw new Error("OUTBOX_REF_INVALID");
  return snapshot;
}

function assertReplayBinding(value: unknown): Record<string, unknown> {
  const snapshot = snapshotOpaqueOwnerValue(value);
  if (typeof snapshot === "string" || Array.isArray(snapshot)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  const binding = snapshot as Record<string, unknown>;
  if (binding.state !== "connected" && binding.state !== "disconnected" && binding.state !== "released") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (typeof binding.continuityId !== "string" || binding.continuityId.length === 0 ||
      typeof binding.deviceId !== "string" || binding.deviceId.length === 0 ||
      typeof binding.connectionId !== "string" || binding.connectionId.length === 0) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  assertDecimalConnectionEpoch(binding.connectionEpoch);
  snapshotOpaqueOwnerValue(binding.realtimeSessionRef);
  snapshotOpaqueOwnerValue(binding.deviceLeaseRef);
  snapshotOpaqueOwnerValue(binding.provider);
  snapshotOpaqueOwnerValue(binding.transportSessionAlias);
  snapshotOpaqueOwnerValue(binding.roomAlias);
  snapshotOpaqueOwnerValue(binding.deviceAlias);
  return binding;
}

function assertReplayResultRecord(
  record: Record<string, unknown>,
  receipt: TerminalReceipt,
  operation: TerminalReceipt["operation"],
  resultOperation: TerminalReceipt["operation"] = operation,
): void {
  if (receipt.status !== "success") throw new Error("MALFORMED_REPLAY_RECORD");
  const expectedResultOperation = resultOperation;
  const operationMismatch = resultOperation === "handoff"
    ? record.operation !== undefined && record.operation !== "handoff"
    : record.operation !== expectedResultOperation;
  const requiresTopLevelContinuity = resultOperation !== "connected_credential_refresh";
  const topLevelContinuityMismatch = record.continuityId !== undefined &&
    (typeof record.continuityId !== "string" || record.continuityId !== receipt.continuityId);
  const topLevelEpochMismatch = record.connectionEpoch !== undefined &&
    record.connectionEpoch !== receipt.connectionEpoch;
  if (operationMismatch ||
      (requiresTopLevelContinuity &&
        (typeof record.continuityId !== "string" || record.continuityId !== receipt.continuityId ||
         record.connectionEpoch !== receipt.connectionEpoch)) ||
      topLevelContinuityMismatch || topLevelEpochMismatch) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  const requiresTopLevelSessionRef = resultOperation !== "connected_credential_refresh";
  if (receipt.realtimeSessionRef === undefined || receipt.deviceLeaseRef === undefined ||
      (requiresTopLevelSessionRef && record.realtimeSessionRef === undefined)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (record.realtimeSessionRef !== undefined &&
      !sameOpaqueValue(record.realtimeSessionRef, receipt.realtimeSessionRef)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (record.deviceLeaseRef !== undefined && !sameOpaqueValue(record.deviceLeaseRef, receipt.deviceLeaseRef)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (record.activeDeviceLeaseRef !== undefined &&
      !sameOpaqueValue(record.activeDeviceLeaseRef, receipt.deviceLeaseRef)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (record.leaseVersion !== undefined &&
      (receipt.leaseVersion === undefined || record.leaseVersion !== receipt.leaseVersion)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (record.binding !== undefined) {
    const binding = assertReplayBinding(record.binding);
    if (binding.continuityId !== receipt.continuityId || binding.connectionEpoch !== receipt.connectionEpoch ||
        !sameOpaqueValue(binding.realtimeSessionRef, receipt.realtimeSessionRef) ||
        !sameOpaqueValue(binding.deviceLeaseRef, receipt.deviceLeaseRef) ||
        (record.activeDeviceId !== undefined && record.activeDeviceId !== binding.deviceId)) {
      throw new Error("MALFORMED_REPLAY_RECORD");
    }
  } else if (resultOperation !== "handoff") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  } else if (record.activeDeviceId !== undefined && typeof record.activeDeviceId !== "string") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
}

function assertRefreshReplayRequest(
  result: RefreshResult,
  request: ConnectedRefreshRequest,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): void {
  assertConnectedRefreshBinding(result.binding, request.binding, { same: sameRef });
  const receipt = result.receipt;
  if (receipt.realtimeSessionRef === undefined || receipt.deviceLeaseRef === undefined ||
      !sameRef(receipt.realtimeSessionRef, request.binding.realtimeSessionRef) ||
      !sameRef(receipt.deviceLeaseRef, request.binding.deviceLeaseRef) ||
      receipt.continuityId !== request.binding.continuityId ||
      receipt.connectionEpoch !== request.binding.connectionEpoch) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
}

function primaryLeaseRef(request: AppleCyclingRenewalRequest): OpaqueCanonicalRef {
  if (request.deviceLeaseRef === undefined && request.primaryDeviceLeaseRef === undefined) {
    throw new Error("APPLE_CYCLING_RENEWAL_LEASE_REF_REQUIRED");
  }
  if (request.deviceLeaseRef !== undefined && request.primaryDeviceLeaseRef !== undefined &&
      !sameOpaqueValue(request.deviceLeaseRef, request.primaryDeviceLeaseRef)) {
    throw new Error("APPLE_CYCLING_RENEWAL_LEASE_REF_CONFLICT");
  }
  return request.deviceLeaseRef ?? request.primaryDeviceLeaseRef!;
}

function assertAppleCyclingRenewalReplayRequest(
  result: AppleCyclingRenewalResult,
  request: AppleCyclingRenewalRequest,
  expectedLeaseRef: OpaqueCanonicalRef,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): void {
  if ((result.operation !== "device_lease_renewal" && result.operation !== "activity_renewal") ||
      !sameRef(result.realtimeSessionRef, request.realtimeSessionRef) ||
      !sameRef(result.deviceLeaseRef, expectedLeaseRef) ||
      !sameRef(result.activeDeviceLeaseRef, expectedLeaseRef) ||
      result.continuityId !== request.continuityId ||
      result.activeDeviceId !== request.deviceId ||
      result.connectionEpoch !== request.expectedConnectionEpoch ||
      !sameRef(result.binding.realtimeSessionRef, request.realtimeSessionRef) ||
      !sameRef(result.binding.deviceLeaseRef, expectedLeaseRef) ||
      result.binding.continuityId !== request.continuityId ||
      result.binding.deviceId !== request.deviceId ||
      result.binding.connectionEpoch !== request.expectedConnectionEpoch ||
      result.receipt.operation !== (result.operation === "activity_renewal" ? "connected_credential_refresh" : "device_lease_renewal") ||
      result.receipt.realtimeSessionRef === undefined ||
      !sameRef(result.receipt.realtimeSessionRef, request.realtimeSessionRef) ||
      result.receipt.deviceLeaseRef === undefined ||
      !sameRef(result.receipt.deviceLeaseRef, expectedLeaseRef) ||
      result.receipt.continuityId !== request.continuityId ||
      result.receipt.connectionEpoch !== request.expectedConnectionEpoch) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
}

function renewalExpiry(
  now: CanonicalTimestamp,
  ttlSeconds: number,
  leaseExpiresAt: CanonicalTimestamp,
  policyExpiresAt: CanonicalTimestamp,
): CanonicalTimestamp {
  const nowAt = Date.parse(now);
  const leaseAt = Date.parse(leaseExpiresAt);
  const policyAt = Date.parse(policyExpiresAt);
  if (![nowAt, leaseAt, policyAt].every(Number.isSafeInteger)) {
    throw new Error("APPLE_CYCLING_RENEWAL_TIME_INVALID");
  }
  if (policyAt <= nowAt) throw new Error("APPLE_CYCLING_RENEWAL_POLICY_EXPIRED");
  if (policyAt <= leaseAt) throw new Error("APPLE_CYCLING_RENEWAL_NOT_EXTENDING");
  if (policyAt > nowAt + ttlSeconds * 1_000) {
    throw new Error("REQUESTED_WINDOW_BELOW_ISSUED_LEASE");
  }
  // T03 returns an exact issuance deadline, not a ceiling for a locally minted TTL.
  return policyExpiresAt;
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertHandoffReplayRequest(
  result: HandoffResult,
  request: HandoffRequest,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): void {
  const receipt = result.receipt;
  if (!sameRef(result.realtimeSessionRef, request.realtimeSessionRef) ||
      result.continuityId !== request.continuityId ||
      result.activeDeviceId !== request.toDeviceId ||
      result.suppressedDeviceId !== request.fromDeviceId ||
      result.connectionEpoch !== request.expectedConnectionEpoch ||
      receipt.realtimeSessionRef === undefined ||
      !sameRef(receipt.realtimeSessionRef, request.realtimeSessionRef) ||
      receipt.continuityId !== request.continuityId ||
      receipt.connectionEpoch !== request.expectedConnectionEpoch ||
      receipt.deviceLeaseRef === undefined ||
      !sameRef(receipt.deviceLeaseRef, result.activeDeviceLeaseRef)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
}

function assertStopReplayRequest(
  receipt: TerminalReceipt,
  request: StopRequest,
  session: RealtimeSessionRecord,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): void {
  if (receipt.realtimeSessionRef === undefined || receipt.deviceLeaseRef === undefined ||
      !sameRef(receipt.realtimeSessionRef, request.realtimeSessionRef) ||
      !sameRef(receipt.realtimeSessionRef, session.realtimeSessionRef) ||
      receipt.continuityId !== request.continuityId ||
      receipt.continuityId !== session.continuityId ||
      receipt.connectionEpoch !== request.expectedConnectionEpoch ||
      receipt.connectionEpoch !== session.connectionEpoch ||
      request.deviceId !== session.activeDeviceId ||
      !sameRef(receipt.deviceLeaseRef, session.activeDeviceLeaseRef) ||
      (request.deviceLeaseRef !== undefined &&
        !sameRef(receipt.deviceLeaseRef, request.deviceLeaseRef))) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
}

function assertBootstrapReplayRequest(
  result: BootstrapResult,
  request: BootstrapRequest,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): void {
  if (result.binding.deviceId !== request.deviceId ||
      result.continuityId !== request.continuityId && request.continuityId !== undefined ||
      !sameRef(result.realtimeSessionRef, result.binding.realtimeSessionRef) ||
      !sameRef(result.deviceLeaseRef, result.binding.deviceLeaseRef) ||
      result.receipt.realtimeSessionRef === undefined ||
      !sameRef(result.receipt.realtimeSessionRef, result.realtimeSessionRef) ||
      result.receipt.deviceLeaseRef === undefined ||
      !sameRef(result.receipt.deviceLeaseRef, result.deviceLeaseRef) ||
      result.receipt.continuityId !== result.continuityId ||
      result.receipt.connectionEpoch !== result.connectionEpoch) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
}

function assertActivityReplayRequest(
  session: RealtimeSessionRecord,
  activity: AcceptedUserActivity,
  verification: VerifiedActivityAcceptance,
  now: CanonicalTimestamp,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): CanonicalTimestamp {
  if (session.userId !== activity.userId || session.activeDeviceId !== activity.deviceId ||
      session.continuityId !== activity.continuityId ||
      !sameRef(session.realtimeSessionRef, activity.realtimeSessionRef)) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  return assertActivityVerification(activity, verification, now, sameRef);
}

function ownerEventSnapshot(
  value: RealtimeAcceptedUserActivityOwnerEvent | undefined,
): RealtimeAcceptedUserActivityOwnerEvent | undefined {
  if (value === undefined) return undefined;
  const snapshot = snapshotOpaqueOwnerValue(value);
  if (typeof snapshot === "string") throw new Error("ACCEPTED_ACTIVITY_OWNER_EVENT_INVALID");
  const keys = Object.keys(snapshot).sort();
  if (keys.length !== 3 || keys[0] !== "actionReceipt" || keys[1] !== "authorityProjection" ||
      keys[2] !== "currentBinding") {
    throw new Error("ACCEPTED_ACTIVITY_OWNER_EVENT_INVALID");
  }
  for (const key of keys) {
    const nested = snapshot[key];
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error("ACCEPTED_ACTIVITY_OWNER_EVENT_INVALID");
    }
  }
  return snapshot as unknown as RealtimeAcceptedUserActivityOwnerEvent;
}

function acceptedUserActivityOwnerPayload(
  activity: AcceptedUserActivity,
  acceptanceRef: OpaqueOwnerValue,
  ownerEvent: RealtimeAcceptedUserActivityOwnerEvent,
): OpaqueOwnerValue {
  return snapshotOpaqueOwnerValue({
    activityId: activity.activityId,
    continuityId: activity.continuityId,
    acceptanceRef: snapshotOpaqueOwnerValue(acceptanceRef),
    // The owner event is T04's statement; its watermark is the one the accepted-activity stream binds to.
    authorityWatermark: snapshotOpaqueOwnerValue(ownerEvent.authorityProjection.authorityWatermark as OpaqueOwnerValue),
    actionReceipt: snapshotOpaqueOwnerValue(ownerEvent.actionReceipt),
    currentBinding: snapshotOpaqueOwnerValue(ownerEvent.currentBinding),
    authorityProjection: snapshotOpaqueOwnerValue(ownerEvent.authorityProjection),
  });
}

async function appendAcceptedUserActivityOwnerEvent(
  transaction: RealtimeAuthorityTransaction,
  activity: AcceptedUserActivity,
  acceptedAt: CanonicalTimestamp,
  acceptanceRef: OpaqueOwnerValue,
  ownerEvent: RealtimeAcceptedUserActivityOwnerEvent | undefined,
): Promise<void> {
  if (ownerEvent === undefined) return;
  await transaction.appendOutbox({
    eventType: REALTIME_T04_ACCEPTED_USER_ACTIVITY_EVENT_TYPE,
    aggregateRef: activity.realtimeSessionRef,
    idempotencyKey: activity.activityId,
    occurredAt: acceptedAt,
    payload: acceptedUserActivityOwnerPayload(
      activity,
      acceptanceRef,
      ownerEvent,
    ),
  });
}

function replaySession(
  value: unknown,
  expectedRef: OpaqueCanonicalRef,
  sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean,
): RealtimeSessionRecord {
  const snapshot = snapshotOpaqueOwnerValue(value);
  if (typeof snapshot === "string") throw new Error("MALFORMED_REPLAY_RECORD");
  const session = snapshot as unknown as RealtimeSessionRecord;
  assertDecimalConnectionEpoch(session.connectionEpoch);
  assertCanonicalTimestamp(session.continuityExpiresAt);
  assertCanonicalTimestamp(session.lastAcceptedUserActivityAt);
  if (session.realtimeSessionRef === undefined ||
      session.binding === undefined || session.revision === undefined) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (typeof session.userId !== "string" || typeof session.continuityId !== "string") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (!sameRef(session.realtimeSessionRef, expectedRef)) throw new Error("MALFORMED_REPLAY_RECORD");
  if (session.state !== "active" && session.state !== "terminal") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  if (session.continuityState !== "active" && session.continuityState !== "ended") {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  assertDecimalCounter(session.revision);
  const binding = assertReplayBinding(session.binding);
  if (binding.continuityId !== session.continuityId ||
      binding.connectionEpoch !== session.connectionEpoch ||
      !sameOpaqueValue(binding.realtimeSessionRef, session.realtimeSessionRef) ||
      !sameOpaqueValue(binding.deviceLeaseRef, session.activeDeviceLeaseRef) ||
      binding.deviceId !== session.activeDeviceId) {
    throw new Error("MALFORMED_REPLAY_RECORD");
  }
  return session;
}

function successReceipt(input: {
  readonly operation: TerminalReceipt["operation"];
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef?: OpaqueCanonicalRef;
  readonly deviceLeaseRef?: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly leaseVersion?: string;
  readonly occurredAt: CanonicalTimestamp;
  readonly outcome: string;
}): TerminalReceipt {
  return {
    kind: "realtime_terminal_receipt",
    operation: input.operation,
    status: "success",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    ...(input.realtimeSessionRef === undefined ? {} : { realtimeSessionRef: snapshotOpaqueOwnerValue(input.realtimeSessionRef) }),
    ...(input.deviceLeaseRef === undefined ? {} : { deviceLeaseRef: snapshotOpaqueOwnerValue(input.deviceLeaseRef) }),
    continuityId: input.continuityId,
    connectionEpoch: assertDecimalConnectionEpoch(input.connectionEpoch),
    ...(input.leaseVersion === undefined ? {} : { leaseVersion: assertDecimalCounter(input.leaseVersion) }),
    outcome: input.outcome,
    recordedAt: assertCanonicalTimestamp(input.occurredAt),
    replayed: false,
  };
}

function idempotencyRecord(
  operation: IdempotencyRecord["operation"],
  key: string,
  requestFingerprint: string,
  result: unknown,
): IdempotencyRecord {
  return {
    operation,
    idempotencyKey: key,
    requestFingerprint,
    result: snapshotOpaqueOwnerValue(result),
  };
}

export class RealtimeSessionService {
  private readonly ports: RealtimeAuthorityPorts;

  public constructor(ports: RealtimeAuthorityPorts) {
    this.ports = ports;
  }

  /**
   * Read-only T11B seam.  T02 supplies the authoritative facts; this method
   * deliberately does not apply an operation-specific state policy.
   */
  public async readCurrentBinding(
    lookup: CurrentBindingLookup,
  ): Promise<RealtimeCurrentBindingProjection | undefined> {
    const value = lookup as unknown as Record<string, unknown>;
    const hasSessionRef = value.realtimeSessionRef !== undefined;
    const hasContinuityId = value.continuityId !== undefined;
    if (hasSessionRef === hasContinuityId) throw new Error("CURRENT_BINDING_LOOKUP_INVALID");
    return this.ports.repository.transaction(
      "realtime.current_binding.read",
      (tx) => tx.readCurrentBinding(lookup),
    );
  }

  public async bootstrap(request: BootstrapRequest): Promise<BootstrapResult> {
    const requestId = assertIdentifier(request.requestId, "INVALID_REQUEST_ID");
    const idempotencyKey = assertIdentifier(request.idempotencyKey, "INVALID_IDEMPOTENCY_KEY");
    assertIdentifier(request.userId, "INVALID_USER_ID");
    assertIdentifier(request.deviceId, "INVALID_DEVICE_ID");
    assertOccurredAtNotFuture(request.occurredAt, this.ports.clock.now());
    const requestFingerprint = fingerprint(request);
    const policy = await this.ports.policy.evaluate({
      userId: request.userId,
      deviceId: request.deviceId,
      capabilities: request.capabilities,
      purpose: request.purpose,
      occurredAt: request.occurredAt,
      governance: request.governance,
    });
    return this.ports.repository.transaction("realtime.bootstrap", async (tx) => {
      const operation = request.mode === "fully_disconnected" ? "fully_disconnected_refresh" : "bootstrap";
      // An initial Start locks its device scope first, so concurrent Starts serialize: the later one sees and
      // supersedes the earlier, and a same-key retry sees the committed replay.
      const held = request.mode === "initial"
        ? await tx.readActiveDeviceSessions({ userId: request.userId, deviceId: request.deviceId, purpose: policy.purpose })
        : undefined;
      const prior = await tx.readIdempotency(operation, idempotencyKey);
      if (prior !== undefined) {
        if (prior.requestFingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        const replayed = replayResult<BootstrapResult>(prior.result, "bootstrap", idempotencyKey);
        assertBootstrapReplayRequest(replayed, request, (left, right) => this.ports.equality.same(left, right));
        // A replay hands out the same session to (re)connect, so it must still be live; one stopped, ended or
        // superseded since is never resurrected as connection material.
        const live = await tx.readCurrentBinding({ realtimeSessionRef: replayed.realtimeSessionRef });
        if (live === undefined || live.session.state !== "active" || live.session.continuityState !== "active" ||
            live.session.binding.state !== "connected" || live.lease.state !== "active" ||
            live.session.connectionEpoch !== replayed.connectionEpoch) {
          throw new Error("BOOTSTRAP_REPLAY_SESSION_ENDED");
        }
        return replayed;
      }
      if (request.mode === "fully_disconnected") {
        return this.bootstrapFullyDisconnected(tx, request, requestId, idempotencyKey, requestFingerprint, policy);
      }
      if (request.continuityId !== undefined || request.existingSessionRef !== undefined || request.existingBinding !== undefined) {
        throw new Error("INITIAL_CONTINUITY_TAKEOVER_FORBIDDEN");
      }
      const continuityId = this.ports.identity.createContinuityId({
        userId: request.userId,
        requestId,
      });
      const sessionRef = this.ports.identity.createSessionRef({
        userId: request.userId,
        continuityId,
        requestId,
      });
      const leaseRef = this.ports.identity.createDeviceLeaseRef({
        sessionRef,
        deviceId: request.deviceId,
        requestId,
      });
      this.ports.identity.assertRepositoryIssuedRef(sessionRef, "RealtimeSession");
      this.ports.identity.assertRepositoryIssuedRef(leaseRef, "DeviceLease");
      const binding = this.newBinding({
        sessionRef,
        leaseRef,
        continuityId,
        deviceId: request.deviceId,
        epoch: INITIAL_EPOCH,
        requestId,
      });
      const lease = createDeviceLease({
        deviceLeaseRef: leaseRef,
        realtimeSessionRef: sessionRef,
        continuityId,
        userId: request.userId,
        deviceId: request.deviceId,
        issuedAt: request.occurredAt,
        policy,
      });
      const session = this.newSession({
        realtimeSessionRef: sessionRef,
        continuityId,
        userId: request.userId,
        deviceId: request.deviceId,
        binding,
        lease,
        occurredAt: request.occurredAt,
        continuityExpiresAt: acceptedActivityDeadline(request.occurredAt),
      });
      // One device, one current session per purpose: whatever it still holds ends here, atomically with the new one.
      const superseded: OpaqueCanonicalRef[] = [];
      for (const prior of held ?? []) {
        const next = applySupersede({ session: prior.session, lease: prior.lease, occurredAt: request.occurredAt });
        await tx.writeSession({ expectedRevision: prior.session.revision, record: next.session });
        if (next.lease !== prior.lease) await tx.writeLease({ expectedLeaseVersion: prior.lease.leaseVersion, record: next.lease });
        await tx.writeBinding({ expectedConnectionEpoch: prior.session.connectionEpoch, binding: next.session.binding });
        superseded.push(prior.session.realtimeSessionRef);
      }
      if (superseded.length > 0) {
        await tx.appendOutbox({
          eventType: "realtime.session.superseded",
          aggregateRef: sessionRef,
          idempotencyKey,
          occurredAt: request.occurredAt,
          payload: { supersededSessionRefs: superseded, continuityId },
        });
      }
      await tx.writeSession({ record: session });
      await tx.writeLease({ record: lease });
      await tx.writeBinding({ binding });
      const outboxRef = await tx.appendOutbox({
        eventType: "realtime.session.started",
        aggregateRef: sessionRef,
        idempotencyKey,
        occurredAt: request.occurredAt,
        payload: { operation: "bootstrap", sessionRef, continuityId },
      });
      const receipt = successReceipt({
        operation: "bootstrap",
        requestId,
        idempotencyKey,
        realtimeSessionRef: sessionRef,
        deviceLeaseRef: leaseRef,
        continuityId,
        connectionEpoch: INITIAL_EPOCH,
        leaseVersion: lease.leaseVersion,
        occurredAt: request.occurredAt,
        outcome: "bootstrap_created",
      });
      const result: BootstrapResult = {
        operation: "bootstrap",
        realtimeSessionRef: sessionRef,
        continuityId,
        deviceLeaseRef: leaseRef,
        connectionEpoch: INITIAL_EPOCH,
        binding,
        continuityExpiresAt: session.continuityExpiresAt,
        leaseExpiresAt: lease.expiresAt,
        receipt: Object.freeze({ ...receipt, outboxEventRef: snapshotOutboxRef(outboxRef) }),
      };
      await tx.writeIdempotency(idempotencyRecord("bootstrap", idempotencyKey, requestFingerprint, result));
      return result;
    });
  }

  public async refresh(request: ConnectedRefreshRequest): Promise<RefreshResult> {
    const requestId = assertIdentifier(request.requestId, "INVALID_REQUEST_ID");
    const idempotencyKey = assertIdentifier(request.idempotencyKey, "INVALID_IDEMPOTENCY_KEY");
    assertOccurredAtNotFuture(request.occurredAt, this.ports.clock.now());
    // occurredAt is the gateway's receive time, not request content: a same-key retry is the same refresh and replays.
    const { occurredAt: _receivedAt, ...identity } = request;
    const requestFingerprint = fingerprint(identity);
    return this.ports.repository.transaction("realtime.refresh", async (tx) => {
      const prior = await tx.readIdempotency("connected_credential_refresh", idempotencyKey);
      if (prior !== undefined) {
        if (prior.requestFingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        const replayed = replayResult<RefreshResult>(prior.result, "connected_credential_refresh", idempotencyKey);
        assertRefreshReplayRequest(replayed, request, (left, right) => this.ports.equality.same(left, right));
        return replayed;
      }
      const currentProjection = await tx.readCurrentBinding({
        realtimeSessionRef: request.binding.realtimeSessionRef,
      });
      if (currentProjection === undefined) throw new Error("SESSION_NOT_FOUND");
      const current = currentProjection.session;
      const lease = currentProjection.lease;
      if (current.continuityState !== "active") throw new Error("CONTINUITY_ENDED");
      assertConnectedRefreshBinding(current.binding, request.binding, this.ports.equality);
      if (!this.ports.equality.same(lease.realtimeSessionRef, current.realtimeSessionRef) ||
          lease.continuityId !== current.continuityId ||
          lease.userId !== current.userId ||
          lease.deviceId !== current.activeDeviceId ||
          !this.ports.equality.same(lease.deviceLeaseRef, current.activeDeviceLeaseRef)) {
        throw new Error("LEASE_BINDING_INVALID");
      }
      assertLeaseUsable({
        lease,
        now: this.ports.clock.now(),
        expectedLeaseVersion: lease.leaseVersion,
        expectedDeviceId: current.activeDeviceId,
        expectedSessionRef: current.realtimeSessionRef,
        sameRef: (left, right) => this.ports.equality.same(left, right),
      });
      if (Date.parse(this.ports.clock.now()) >= Date.parse(current.continuityExpiresAt)) {
        throw new Error("CONTINUITY_EXPIRED");
      }
      const outboxRef = await tx.appendOutbox({
        eventType: "realtime.session.connected_credential_refresh",
        aggregateRef: current.realtimeSessionRef,
        idempotencyKey,
        occurredAt: request.occurredAt,
        payload: { continuityId: current.continuityId, connectionEpoch: current.connectionEpoch },
      });
      const receipt = successReceipt({
        operation: "connected_credential_refresh",
        requestId,
        idempotencyKey,
        realtimeSessionRef: current.realtimeSessionRef,
        deviceLeaseRef: lease.deviceLeaseRef,
        continuityId: current.continuityId,
        connectionEpoch: current.connectionEpoch,
        leaseVersion: lease.leaseVersion,
        occurredAt: request.occurredAt,
        outcome: "connected_binding_preserved",
      });
      const result: RefreshResult = {
        operation: "connected_credential_refresh",
        binding: current.binding,
        continuityExpiresAt: current.continuityExpiresAt,
        leaseExpiresAt: lease.expiresAt,
        receipt: Object.freeze({ ...receipt, outboxEventRef: snapshotOutboxRef(outboxRef) }),
      };
      await tx.writeIdempotency(idempotencyRecord("connected_credential_refresh", idempotencyKey, requestFingerprint, result));
      return result;
    });
  }

  /** Update the current Apple lease from a fresh T03 issuance; continuity is activity-owned. */
  public async renewAppleCycling(
    request: AppleCyclingRenewalRequest,
  ): Promise<AppleCyclingRenewalResult> {
    const requestId = assertIdentifier(request.requestId, "INVALID_REQUEST_ID");
    const idempotencyKey = assertIdentifier(request.idempotencyKey, "INVALID_IDEMPOTENCY_KEY");
    const continuityId = assertIdentifier(request.continuityId, "INVALID_CONTINUITY_ID");
    const deviceId = assertIdentifier(request.deviceId, "INVALID_DEVICE_ID");
    const primaryRef = primaryLeaseRef(request);
    this.ports.identity.assertRepositoryIssuedRef(request.realtimeSessionRef, "RealtimeSession");
    this.ports.identity.assertRepositoryIssuedRef(primaryRef, "DeviceLease");
    const expectedConnectionEpoch = assertDecimalConnectionEpoch(request.expectedConnectionEpoch);
    const expectedLeaseVersion = assertDecimalCounter(request.expectedLeaseVersion);
    const expectedFencingToken = request.expectedFencingToken === undefined
      ? undefined
      : assertDecimalCounter(request.expectedFencingToken);
    if (!Number.isSafeInteger(request.ttlSeconds) || request.ttlSeconds < 1 || request.ttlSeconds > 86_400) {
      throw new Error("APPLE_CYCLING_RENEWAL_TTL_INVALID");
    }
    const now = assertCanonicalTimestamp(this.ports.clock.now());
    const occurredAt = request.occurredAt === undefined
      ? now
      : assertCanonicalTimestamp(request.occurredAt);
    assertOccurredAtNotFuture(occurredAt, now);
    const fingerprintInput = {
      requestId,
      idempotencyKey,
      realtimeSessionRef: snapshotOpaqueOwnerValue(request.realtimeSessionRef),
      deviceLeaseRef: snapshotOpaqueOwnerValue(primaryRef),
      continuityId,
      deviceId,
      expectedConnectionEpoch,
      expectedLeaseVersion,
      ttlSeconds: request.ttlSeconds,
      ...(expectedFencingToken === undefined ? {} : { expectedFencingToken }),
      ...(request.occurredAt === undefined ? {} : { occurredAt }),
      ...(request.governance === undefined ? {} : {
        governance: snapshotOpaqueOwnerValue(request.governance),
      }),
    };
    const requestFingerprint = fingerprint(fingerprintInput);
    return this.ports.repository.transaction("realtime.apple_cycling.renew", async (tx) => {
      const legacyReceipt = await tx.readIdempotency("activity_renewal", idempotencyKey);
      const currentReceipt = await tx.readIdempotency("device_lease_renewal", idempotencyKey);
      if (currentReceipt !== undefined && legacyReceipt !== undefined) throw new Error("IDEMPOTENCY_CONFLICT");
      const prior = currentReceipt ?? legacyReceipt;
      if (prior !== undefined) {
        if (prior.requestFingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        const replayed = replayResult<AppleCyclingRenewalResult>(
          prior.result,
          legacyReceipt === undefined ? "device_lease_renewal" : "connected_credential_refresh",
          idempotencyKey,
          legacyReceipt === undefined ? "device_lease_renewal" : "activity_renewal",
        );
        assertAppleCyclingRenewalReplayRequest(
          replayed,
          { ...request, continuityId, deviceId },
          primaryRef,
          (left, right) => this.ports.equality.same(left, right),
        );
        return replayed;
      }

      const currentProjection = await tx.readCurrentBinding({
        realtimeSessionRef: request.realtimeSessionRef,
      });
      if (currentProjection === undefined) throw new Error("SESSION_NOT_FOUND");
      const session = currentProjection.session;
      const lease = currentProjection.lease;
      const sameRef = (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) =>
        this.ports.equality.same(left, right);
      if (!sameRef(session.realtimeSessionRef, request.realtimeSessionRef) ||
          session.continuityId !== continuityId || session.activeDeviceId !== deviceId ||
          session.state !== "active" || session.continuityState !== "active" ||
          session.binding.state !== "connected" ||
          session.connectionEpoch !== expectedConnectionEpoch ||
          !sameRef(session.activeDeviceLeaseRef, primaryRef) ||
          !sameRef(session.binding.realtimeSessionRef, session.realtimeSessionRef) ||
          !sameRef(session.binding.deviceLeaseRef, primaryRef) ||
          session.binding.continuityId !== session.continuityId ||
          session.binding.deviceId !== session.activeDeviceId ||
          session.binding.connectionEpoch !== session.connectionEpoch) {
        throw new Error("APPLE_CYCLING_RENEWAL_SESSION_BINDING_INVALID");
      }
      if (!sameRef(lease.deviceLeaseRef, primaryRef) ||
          !sameRef(lease.realtimeSessionRef, session.realtimeSessionRef) ||
          lease.continuityId !== session.continuityId || lease.userId !== session.userId ||
          lease.deviceId !== session.activeDeviceId || lease.state !== "active" ||
          lease.revocable !== true) {
        throw new Error("APPLE_CYCLING_RENEWAL_LEASE_BINDING_INVALID");
      }
      if (expectedFencingToken !== undefined && lease.fencingToken !== expectedFencingToken) {
        throw new Error("APPLE_CYCLING_RENEWAL_FENCE_CONFLICT");
      }
      if (lease.leaseVersion !== expectedLeaseVersion) throw new Error("LEASE_VERSION_CONFLICT");
      assertDecimalCounter(lease.leaseVersion);
      assertDecimalCounter(lease.fencingToken);
      const sessionExpiresAt = assertCanonicalTimestamp(session.continuityExpiresAt);
      const leaseExpiresAt = assertCanonicalTimestamp(lease.expiresAt);
      const nowAt = Date.parse(now);
      const sessionExpired = nowAt >= Date.parse(sessionExpiresAt);
      const leaseExpired = nowAt >= Date.parse(leaseExpiresAt);
      if (sessionExpired) throw new Error("CONTINUITY_EXPIRED");
      if (leaseExpired && request.governance === undefined) {
        throw new Error("APPLE_CYCLING_RENEWAL_AUTHORITY_REQUIRED");
      }

      const governance = request.governance === undefined
        ? lease.policyDecisionRef
        : snapshotOpaqueOwnerValue(request.governance);
      const policy = await this.ports.policy.evaluate({
        userId: session.userId,
        deviceId: session.activeDeviceId,
        capabilities: lease.capabilities,
        purpose: lease.purpose,
        occurredAt,
        governance,
      });
      if (policy.allowed !== true || policy.revocable !== true || policy.purpose !== lease.purpose ||
          !sameCapabilities(policy.capabilities, lease.capabilities)) {
        throw new Error("APPLE_CYCLING_RENEWAL_POLICY_INVALID");
      }
      const policyExpiresAt = assertCanonicalTimestamp(policy.leaseExpiresAt);
      if (Date.parse(policyExpiresAt) <= nowAt) {
        throw new Error("APPLE_CYCLING_RENEWAL_POLICY_EXPIRED");
      }
      const expiresAt = renewalExpiry(
        now,
        request.ttlSeconds,
        leaseExpiresAt,
        policyExpiresAt,
      );
      const renewedSession = session;
      const renewedLease: DeviceLeaseRecord = Object.freeze({
        ...lease,
        expiresAt,
        leaseVersion: incrementDecimalCounter(lease.leaseVersion),
        fencingToken: incrementDecimalCounter(lease.fencingToken),
        policyDecisionRef: snapshotOpaqueOwnerValue(policy.policyDecisionRef),
      });
      await tx.writeLease({ expectedLeaseVersion: lease.leaseVersion, record: renewedLease });
      const outboxRef = await tx.appendOutbox({
        eventType: "realtime.device_lease.renewed.v1",
        aggregateRef: session.realtimeSessionRef,
        idempotencyKey,
        occurredAt,
        payload: snapshotOpaqueOwnerValue({
          requestId,
          renewalKind: "device_lease",
          continuityId: session.continuityId,
          deviceId: session.activeDeviceId,
          primaryDeviceLeaseRef: snapshotOpaqueOwnerValue(lease.deviceLeaseRef),
          previousContinuityExpiresAt: session.continuityExpiresAt,
          continuityExpiresAt: session.continuityExpiresAt,
          previousLeaseExpiresAt: lease.expiresAt,
          leaseExpiresAt: expiresAt,
          previousLeaseVersion: lease.leaseVersion,
          leaseVersion: renewedLease.leaseVersion,
          previousFencingToken: lease.fencingToken,
          fencingToken: renewedLease.fencingToken,
        }),
      });
      const receipt = successReceipt({
        operation: "device_lease_renewal",
        requestId,
        idempotencyKey,
        realtimeSessionRef: session.realtimeSessionRef,
        deviceLeaseRef: renewedLease.deviceLeaseRef,
        continuityId: session.continuityId,
        connectionEpoch: session.connectionEpoch,
        leaseVersion: renewedLease.leaseVersion,
        occurredAt,
        outcome: "device_lease_renewed",
      });
      const result: AppleCyclingRenewalResult = Object.freeze({
        operation: "device_lease_renewal",
        realtimeSessionRef: snapshotOpaqueOwnerValue(renewedSession.realtimeSessionRef),
        continuityId: renewedSession.continuityId,
        deviceLeaseRef: snapshotOpaqueOwnerValue(renewedLease.deviceLeaseRef),
        activeDeviceLeaseRef: snapshotOpaqueOwnerValue(renewedSession.activeDeviceLeaseRef),
        activeDeviceId: renewedSession.activeDeviceId,
        connectionEpoch: renewedSession.connectionEpoch,
        leaseVersion: renewedLease.leaseVersion,
        fencingToken: renewedLease.fencingToken,
        continuityExpiresAt: renewedSession.continuityExpiresAt,
        leaseExpiresAt: renewedLease.expiresAt,
        binding: renewedSession.binding,
        receipt: Object.freeze({ ...receipt, outboxEventRef: snapshotOutboxRef(outboxRef) }),
      });
      await tx.writeIdempotency(idempotencyRecord("device_lease_renewal", idempotencyKey, requestFingerprint, result));
      return result;
    });
  }

  public async recordAcceptedUserActivity(
    activity: AcceptedUserActivity,
    ownerEvent?: RealtimeAcceptedUserActivityOwnerEvent,
  ): Promise<RealtimeSessionRecord> {
    const ownerEventValue = ownerEventSnapshot(ownerEvent);
    const activityFingerprint = ownerEventValue === undefined
      ? fingerprint(activity)
      : fingerprint({ activity, ownerEvent: ownerEventValue });
    return this.ports.repository.transaction("realtime.activity.accept", async (tx) => {
      const prior = await tx.readIdempotency("activity_renewal", activity.activityId);
      if (prior !== undefined) {
        if (prior.requestFingerprint !== activityFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        const replayed = replaySession(prior.result, activity.realtimeSessionRef, (left, right) => this.ports.equality.same(left, right));
        const verification = await this.ports.activityAcceptance.verify(activity);
        assertActivityReplayRequest(
          replayed,
          activity,
          verification,
          assertCanonicalTimestamp(this.ports.clock.now()),
          (left, right) => this.ports.equality.same(left, right),
        );
        return replayed;
      }
      const session = await tx.readSession(activity.realtimeSessionRef);
      if (session === undefined) throw new Error("SESSION_NOT_FOUND");
      if (!this.ports.equality.same(activity.realtimeSessionRef, session.realtimeSessionRef)) {
        throw new Error("ACTIVITY_BINDING_INVALID");
      }
      const now = assertCanonicalTimestamp(this.ports.clock.now());
      if (Date.parse(now) >= Date.parse(session.continuityExpiresAt)) {
        throw new Error("CONTINUITY_EXPIRED");
      }
      const verification = await this.ports.activityAcceptance.verify(activity);
      const acceptedAt = assertActivityVerification(
        activity,
        verification,
        now,
        (left, right) => this.ports.equality.same(left, right),
      );
      const acceptanceRef = snapshotOpaqueOwnerValue(verification.acceptanceRef);
      const authorityWatermark = snapshotOpaqueOwnerValue(verification.authorityWatermark);
      const authoritativeActivity: AcceptedUserActivity = { ...activity, occurredAt: acceptedAt, acceptanceRef };
      const authoritativeVerification = { ...verification, acceptanceRef, authorityWatermark };
      const renewed = applyAcceptedUserActivityRenewal(
        session,
        authoritativeActivity,
        authoritativeVerification,
        (left, right) => this.ports.equality.same(left, right),
      );
      await tx.writeIdempotency(idempotencyRecord("activity_renewal", activity.activityId, activityFingerprint, renewed.session));
      if (!renewed.result.renewed) {
        await appendAcceptedUserActivityOwnerEvent(
          tx,
          authoritativeActivity,
          acceptedAt,
          acceptanceRef,
          ownerEventValue,
        );
        return renewed.session;
      }
      await tx.writeSession({ expectedRevision: session.revision, record: renewed.session });
      await tx.appendOutbox({
        eventType: "realtime.continuity.renewed",
        aggregateRef: session.realtimeSessionRef,
        idempotencyKey: activity.activityId,
        occurredAt: acceptedAt,
        payload: {
          activityId: activity.activityId,
          continuityId: activity.continuityId,
          acceptanceRef,
          authorityWatermark,
        },
      });
      await appendAcceptedUserActivityOwnerEvent(
        tx,
        authoritativeActivity,
        acceptedAt,
        acceptanceRef,
        ownerEventValue,
      );
      return renewed.session;
    });
  }

  public async handoff(request: HandoffRequest): Promise<HandoffResult> {
    const requestId = assertIdentifier(request.requestId, "INVALID_REQUEST_ID");
    const idempotencyKey = assertIdentifier(request.idempotencyKey, "INVALID_IDEMPOTENCY_KEY");
    assertOccurredAtNotFuture(request.occurredAt, this.ports.clock.now());
    const requestFingerprint = fingerprint(request);
    return this.ports.repository.transaction("realtime.handoff", async (tx) => {
      const prior = await tx.readIdempotency("handoff", idempotencyKey);
      if (prior !== undefined) {
        if (prior.requestFingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        const replayed = replayResult<HandoffResult>(prior.result, "handoff", idempotencyKey);
        assertHandoffReplayRequest(replayed, request, (left, right) => this.ports.equality.same(left, right));
        return replayed;
      }
      const currentProjection = await tx.readCurrentBinding({
        realtimeSessionRef: request.realtimeSessionRef,
      });
      if (currentProjection === undefined) throw new Error("SESSION_NOT_FOUND");
      const session = currentProjection.session;
      const lease = currentProjection.lease;
      if (!this.ports.equality.same(request.realtimeSessionRef, session.realtimeSessionRef)) {
        throw new Error("HANDOFF_BINDING_INVALID");
      }
      if (session.state !== "active" || session.continuityState !== "active" ||
          session.binding.state !== "connected" || lease.state !== "active") {
        throw new Error("HANDOFF_BINDING_INVALID");
      }
      const policy = await this.ports.policy.evaluate({
        userId: session.userId,
        deviceId: request.toDeviceId,
        capabilities: ["realtime.media"],
        purpose: "realtime.handoff",
        occurredAt: request.occurredAt,
        governance: request.governance,
      });
      const nextLeaseRef = this.ports.identity.createDeviceLeaseRef({
        sessionRef: session.realtimeSessionRef,
        deviceId: request.toDeviceId,
        requestId,
      });
      this.ports.identity.assertRepositoryIssuedRef(nextLeaseRef, "DeviceLease");
      const nextLease = createDeviceLease({
        deviceLeaseRef: nextLeaseRef,
        realtimeSessionRef: session.realtimeSessionRef,
        continuityId: session.continuityId,
        userId: session.userId,
        deviceId: request.toDeviceId,
        issuedAt: request.occurredAt,
        policy,
      });
      const nextBinding = this.newBinding({
        sessionRef: session.realtimeSessionRef,
        leaseRef: nextLeaseRef,
        continuityId: session.continuityId,
        deviceId: request.toDeviceId,
        epoch: session.connectionEpoch,
        requestId,
      });
      const receipt = successReceipt({
        operation: "handoff",
        requestId,
        idempotencyKey,
        realtimeSessionRef: session.realtimeSessionRef,
        deviceLeaseRef: nextLeaseRef,
        continuityId: session.continuityId,
        connectionEpoch: session.connectionEpoch,
        leaseVersion: nextLease.leaseVersion,
        occurredAt: request.occurredAt,
        outcome: "handoff_completed",
      });
      const transition = applySessionHandoff({
        session,
        currentLease: lease,
        request,
        nextLease,
        nextBinding,
        sameRef: (left, right) => this.ports.equality.same(left, right),
        now: this.ports.clock.now(),
        receipt,
      });
      const oldLease = releaseDeviceLease(lease, request.expectedLeaseVersion);
      await tx.writeSession({ expectedRevision: session.revision, record: transition.session });
      await tx.writeLease({ expectedLeaseVersion: lease.leaseVersion, record: oldLease });
      await tx.writeLease({ record: nextLease });
      await tx.writeBinding({ expectedConnectionEpoch: session.connectionEpoch, binding: nextBinding });
      const outboxRef = await tx.appendOutbox({
        eventType: "realtime.session.handoff.completed",
        aggregateRef: session.realtimeSessionRef,
        idempotencyKey,
        occurredAt: request.occurredAt,
        payload: { fromDeviceId: request.fromDeviceId, toDeviceId: request.toDeviceId },
      });
      const result: HandoffResult = {
        ...transition.result,
        receipt: Object.freeze({
          ...transition.result.receipt,
          outboxEventRef: snapshotOutboxRef(outboxRef),
        }),
      };
      const handoffFact: HandoffFactRecord = Object.freeze({
        requestId,
        idempotencyKey,
        requestFingerprint,
        realtimeSessionRef: snapshotOpaqueOwnerValue(session.realtimeSessionRef),
        continuityId: session.continuityId,
        fromDeviceId: request.fromDeviceId,
        toDeviceId: request.toDeviceId,
        connectionEpoch: session.connectionEpoch,
        oldLeaseRef: snapshotOpaqueOwnerValue(lease.deviceLeaseRef),
        expectedLeaseVersion: request.expectedLeaseVersion,
        releasedLeaseVersion: oldLease.leaseVersion,
        releasedFencingToken: oldLease.fencingToken,
        newLeaseRef: snapshotOpaqueOwnerValue(nextLease.deviceLeaseRef),
        newLeaseVersion: nextLease.leaseVersion,
        newFencingToken: nextLease.fencingToken,
        suppressedDeviceId: transition.result.suppressedDeviceId ?? request.fromDeviceId,
        outboxEventRef: snapshotOutboxRef(outboxRef),
        occurredAt: request.occurredAt,
      });
      await tx.recordHandoffFact(handoffFact);
      await tx.writeIdempotency(idempotencyRecord("handoff", idempotencyKey, requestFingerprint, result));
      return result;
    });
  }

  public async stop(request: StopRequest): Promise<TerminalReceipt> {
    const requestId = assertIdentifier(request.requestId, "INVALID_REQUEST_ID");
    const idempotencyKey = assertIdentifier(request.idempotencyKey, "INVALID_IDEMPOTENCY_KEY");
    assertOccurredAtNotFuture(request.occurredAt, this.ports.clock.now());
    const requestFingerprint = fingerprint(request);
    return this.ports.repository.transaction("realtime.stop", async (tx) => {
      const prior = await tx.readIdempotency(request.operation, idempotencyKey);
      const currentProjection = await tx.readCurrentBinding({
        realtimeSessionRef: request.realtimeSessionRef,
      });
      const session = currentProjection?.session;
      if (session !== undefined &&
          !this.ports.equality.same(request.realtimeSessionRef, session.realtimeSessionRef)) {
        throw new Error("STOP_CONTINUITY_BINDING_INVALID");
      }
      if (prior !== undefined) {
        if (prior.requestFingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
        if (session === undefined) throw new Error("SESSION_NOT_FOUND");
        const replayed = replayReceipt(prior.result, request.operation, idempotencyKey);
        assertStopReplayRequest(replayed, request, session, (left, right) => this.ports.equality.same(left, right));
        return replayed;
      }
      if (session === undefined) throw new Error("SESSION_NOT_FOUND");
      if (session.continuityId !== request.continuityId) throw new Error("STOP_CONTINUITY_BINDING_INVALID");
      if (request.deviceId !== session.activeDeviceId) throw new Error("STOP_DEVICE_BINDING_INVALID");
      const lease = currentProjection!.lease;
      if (request.deviceLeaseRef !== undefined &&
          !this.ports.equality.same(request.deviceLeaseRef, lease.deviceLeaseRef)) {
        throw new Error("STOP_LEASE_BINDING_INVALID");
      }
      if (!this.ports.equality.same(lease.realtimeSessionRef, session.realtimeSessionRef) ||
          lease.continuityId !== session.continuityId || lease.userId !== session.userId ||
          lease.deviceId !== request.deviceId ||
          !this.ports.equality.same(lease.deviceLeaseRef, session.activeDeviceLeaseRef)) {
        throw new Error("STOP_LEASE_BINDING_INVALID");
      }
      if (request.operation === "media_stop" && lease.state !== "active") {
        throw new Error("MEDIA_LEASE_NOT_ACTIVE");
      }
      if (request.operation === "end_continuity" && session.continuityState !== "active") {
        throw new Error("CONTINUITY_ALREADY_ENDED");
      }
      if (request.operation === "end_continuity" &&
          session.binding.state !== "connected" && session.binding.state !== "released") {
        throw new Error("END_CONTINUITY_BINDING_INVALID");
      }
      const receipt = successReceipt({
        operation: request.operation,
        requestId,
        idempotencyKey,
        realtimeSessionRef: session.realtimeSessionRef,
        deviceLeaseRef: lease.deviceLeaseRef,
        continuityId: session.continuityId,
        connectionEpoch: session.connectionEpoch,
        leaseVersion: lease.leaseVersion,
        occurredAt: request.occurredAt,
        outcome: request.operation === "media_stop" ? "media_lease_released" : "continuity_ended",
      });
      const transition = request.operation === "media_stop"
        ? applyMediaStop({
            session,
            lease,
            request,
            sameRef: (left, right) => this.ports.equality.same(left, right),
            receipt,
          })
        : applyEndContinuity({
            session,
            lease,
            request,
            sameRef: (left, right) => this.ports.equality.same(left, right),
            receipt,
      });
      if (request.operation === "media_stop") {
        await tx.writeSession({ expectedRevision: session.revision, record: transition.session });
        await tx.writeLease({ expectedLeaseVersion: lease.leaseVersion, record: transition.lease });
      } else {
        await tx.writeSession({ expectedRevision: session.revision, record: transition.session });
        if (transition.lease !== lease) {
          await tx.writeLease({ expectedLeaseVersion: lease.leaseVersion, record: transition.lease });
        }
      }
      await tx.writeBinding({ expectedConnectionEpoch: session.connectionEpoch, binding: transition.session.binding });
      const outboxRef = await tx.appendOutbox({
        eventType: request.operation === "media_stop"
          ? "realtime.media.lease.released"
          : "realtime.continuity.ended",
        aggregateRef: session.realtimeSessionRef,
        idempotencyKey,
        occurredAt: request.occurredAt,
        payload: { requestId, continuityId: session.continuityId },
      });
      const finalReceipt: TerminalReceipt = Object.freeze({
        ...transition.receipt,
        outboxEventRef: snapshotOutboxRef(outboxRef),
      });
      await tx.writeIdempotency(idempotencyRecord(request.operation, idempotencyKey, requestFingerprint, finalReceipt));
      return finalReceipt;
    });
  }

  private newBinding(input: {
    readonly sessionRef: OpaqueCanonicalRef;
    readonly leaseRef: OpaqueCanonicalRef;
    readonly continuityId: string;
    readonly deviceId: string;
    readonly epoch: string;
    readonly requestId: string;
  }): RealtimeTransportBinding {
    const provider = "livekit-cloud";
    return createTransportBinding({
      realtimeSessionRef: input.sessionRef,
      deviceLeaseRef: input.leaseRef,
      continuityId: input.continuityId,
      deviceId: input.deviceId,
      connectionEpoch: assertDecimalConnectionEpoch(input.epoch),
      provider,
      transportSessionAlias: this.ports.identity.createTransportAlias({
        provider,
        sessionRef: input.sessionRef,
        deviceId: input.deviceId,
        connectionEpoch: input.epoch,
        requestId: input.requestId,
      }),
      roomAlias: this.ports.identity.createTransportAlias({
        provider,
        sessionRef: input.sessionRef,
        deviceId: input.deviceId,
        connectionEpoch: input.epoch,
        requestId: `${input.requestId}:room`,
      }),
      deviceAlias: this.ports.identity.createTransportAlias({
        provider,
        sessionRef: input.sessionRef,
        deviceId: input.deviceId,
        connectionEpoch: input.epoch,
        requestId: `${input.requestId}:device`,
      }),
      connectionId: this.ports.identity.createConnectionId({
        deviceId: input.deviceId,
        requestId: input.requestId,
      }),
    });
  }

  private newSession(input: {
    readonly realtimeSessionRef: OpaqueCanonicalRef;
    readonly continuityId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly binding: RealtimeTransportBinding;
    readonly lease: DeviceLeaseRecord;
    readonly occurredAt: CanonicalTimestamp;
    readonly continuityExpiresAt: CanonicalTimestamp;
  }): RealtimeSessionRecord {
    return {
      realtimeSessionRef: input.realtimeSessionRef,
      userId: input.userId,
      continuityId: input.continuityId,
      state: "active",
      continuityState: "active",
      connectionEpoch: input.binding.connectionEpoch,
      continuityExpiresAt: assertCanonicalTimestamp(input.continuityExpiresAt),
      lastAcceptedUserActivityAt: assertCanonicalTimestamp(input.occurredAt),
      activeDeviceId: input.deviceId,
      activeDeviceLeaseRef: input.lease.deviceLeaseRef,
      binding: input.binding,
      revision: assertDecimalCounter("1"),
    };
  }

  private async bootstrapFullyDisconnected(
    tx: RealtimeAuthorityTransaction,
    request: BootstrapRequest,
    requestId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    policy: Awaited<ReturnType<RealtimeAuthorityPorts["policy"]["evaluate"]>>,
  ): Promise<BootstrapResult> {
    if (request.existingSessionRef === undefined || request.existingBinding === undefined ||
        request.continuityId === undefined) {
      throw new Error("FULLY_DISCONNECTED_BINDING_REQUIRED");
    }
    const previousProjection = await tx.readCurrentBinding({
      realtimeSessionRef: request.existingSessionRef,
    });
    let previous = previousProjection?.session;
    if (previous === undefined) throw new Error("SESSION_NOT_FOUND");
    const previousLease = previousProjection!.lease;
    if (previous.continuityState !== "active" || previous.userId !== request.userId ||
        previous.continuityId !== request.continuityId ||
        !this.ports.equality.same(previous.realtimeSessionRef, request.existingSessionRef) ||
        !this.ports.equality.same(previous.realtimeSessionRef, request.existingBinding.realtimeSessionRef) ||
        previous.connectionEpoch !== request.existingBinding.connectionEpoch) {
      throw new Error("CONTINUITY_BINDING_INVALID");
    }
    assertBindingExactlyMatches(previous.binding, request.existingBinding, this.ports.equality);
    if (previousLease.state === "released") {
      throw new Error("LEASE_BINDING_INVALID");
    }
    if (previous.binding.state === "connected") {
      const verification = await this.ports.transportDisconnection.verify({
        binding: previous.binding,
        userId: request.userId,
        deviceId: previous.binding.deviceId,
        occurredAt: request.occurredAt,
        governance: request.governance,
      });
      if (verification.verified !== true) throw new Error("TRANSPORT_DISCONNECT_UNVERIFIED");
      const disconnectedAt = assertCanonicalTimestamp(verification.disconnectedAt);
      const authorityProof = snapshotOpaqueOwnerValue(verification.authorityProof);
      const disconnected: RealtimeSessionRecord = {
        ...previous,
        binding: markBindingDisconnected(previous.binding),
        revision: incrementDecimalCounter(previous.revision),
      };
      await tx.writeSession({ expectedRevision: previous.revision, record: disconnected });
      await tx.writeBinding({ expectedConnectionEpoch: previous.connectionEpoch, binding: disconnected.binding });
      await tx.appendOutbox({
        eventType: "realtime.transport.disconnected",
        aggregateRef: previous.realtimeSessionRef,
        idempotencyKey: `${idempotencyKey}:transport-disconnect`,
        occurredAt: disconnectedAt,
        payload: { authorityProof, continuityId: previous.continuityId },
      });
      previous = disconnected;
    }
    if (previous.binding.state !== "disconnected" || request.existingBinding.state === "released") {
      throw new Error("TRANSPORT_NOT_DISCONNECTED");
    }
    assertBindingExactlyMatches(previous.binding, markBindingDisconnected(request.existingBinding), this.ports.equality);
    if (!this.ports.equality.same(previousLease.realtimeSessionRef, previous.realtimeSessionRef) ||
        previousLease.continuityId !== previous.continuityId ||
        previousLease.userId !== previous.userId ||
        previousLease.deviceId !== previous.binding.deviceId ||
        !this.ports.equality.same(previousLease.deviceLeaseRef, previous.activeDeviceLeaseRef)) {
      throw new Error("LEASE_BINDING_INVALID");
    }
    const epoch = nextConnectionEpoch(previous.connectionEpoch);
    const sessionRef = this.ports.identity.createSessionRef({
      userId: request.userId,
      continuityId: request.continuityId,
      requestId,
    });
    const leaseRef = this.ports.identity.createDeviceLeaseRef({
      sessionRef,
      deviceId: request.deviceId,
      requestId,
    });
    this.ports.identity.assertRepositoryIssuedRef(sessionRef, "RealtimeSession");
    this.ports.identity.assertRepositoryIssuedRef(leaseRef, "DeviceLease");
    const provider = request.existingBinding.provider;
    const transportSessionAlias = this.ports.identity.createTransportAlias({
      provider,
      sessionRef,
      deviceId: request.deviceId,
      connectionEpoch: epoch,
      requestId,
    });
    const roomAlias = this.ports.identity.createTransportAlias({
      provider,
      sessionRef,
      deviceId: request.deviceId,
      connectionEpoch: epoch,
      requestId: `${requestId}:room`,
    });
    const deviceAlias = this.ports.identity.createTransportAlias({
      provider,
      sessionRef,
      deviceId: request.deviceId,
      connectionEpoch: epoch,
      requestId: `${requestId}:device`,
    });
    const binding = createFullyDisconnectedBinding({
      previous: request.existingBinding,
      realtimeSessionRef: sessionRef,
      deviceLeaseRef: leaseRef,
      deviceId: request.deviceId,
      connectionEpoch: epoch,
      transportSessionAlias,
      roomAlias,
      deviceAlias,
      connectionId: this.ports.identity.createConnectionId({ deviceId: request.deviceId, requestId }),
    });
    const lease = createDeviceLease({
      deviceLeaseRef: leaseRef,
      realtimeSessionRef: sessionRef,
      continuityId: previous.continuityId,
      userId: request.userId,
      deviceId: request.deviceId,
      issuedAt: request.occurredAt,
      policy,
    });
    const session = this.newSession({
      realtimeSessionRef: sessionRef,
      continuityId: previous.continuityId,
      userId: request.userId,
      deviceId: request.deviceId,
      binding,
      lease,
      occurredAt: previous.lastAcceptedUserActivityAt,
      continuityExpiresAt: previous.continuityExpiresAt,
    });
    const receipt = successReceipt({
      operation: "bootstrap",
      requestId,
      idempotencyKey,
      realtimeSessionRef: sessionRef,
      deviceLeaseRef: leaseRef,
      continuityId: previous.continuityId,
      connectionEpoch: epoch,
      leaseVersion: lease.leaseVersion,
      occurredAt: request.occurredAt,
      outcome: "new_transport_binding_created",
    });
    const oldLease = previousLease;
    const oldSession: RealtimeSessionRecord = {
      ...previous,
      state: "terminal",
      binding: { ...previous.binding, state: "disconnected" },
      revision: incrementDecimalCounter(previous.revision),
      terminalAt: assertCanonicalTimestamp(request.occurredAt),
      terminalReason: "fully_disconnected_rebind",
    };
    await tx.writeSession({ expectedRevision: previous.revision, record: oldSession });
    if (oldLease !== undefined && oldLease.state === "active") {
      await tx.writeLease({ expectedLeaseVersion: oldLease.leaseVersion, record: releaseDeviceLease(oldLease, oldLease.leaseVersion) });
    }
    await tx.writeSession({ record: session });
    await tx.writeLease({ record: lease });
    await tx.writeBinding({ binding });
    const outboxRef = await tx.appendOutbox({
      eventType: "realtime.session.transport.rebound",
      aggregateRef: sessionRef,
      idempotencyKey,
      occurredAt: request.occurredAt,
      payload: { previousSessionRef: previous.realtimeSessionRef, continuityId: previous.continuityId },
    });
    const result: BootstrapResult = {
      operation: "bootstrap",
      realtimeSessionRef: sessionRef,
      continuityId: previous.continuityId,
      deviceLeaseRef: leaseRef,
      connectionEpoch: epoch,
      binding,
      continuityExpiresAt: session.continuityExpiresAt,
      leaseExpiresAt: lease.expiresAt,
      receipt: Object.freeze({ ...receipt, outboxEventRef: snapshotOutboxRef(outboxRef) }),
    };
    await tx.writeIdempotency(idempotencyRecord("fully_disconnected_refresh", idempotencyKey, requestFingerprint, result));
    return result;
  }
}
