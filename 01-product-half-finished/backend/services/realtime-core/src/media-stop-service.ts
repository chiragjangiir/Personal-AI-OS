import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  incrementDecimalCounter,
  type DeviceLeaseRecord,
  type RealtimeSessionRecord,
  type StopRequest,
  type TerminalReceipt,
} from "./types.ts";
import { releaseDeviceLease } from "./device-lease-state-machine.ts";
import { releaseTransportBinding } from "./transport-binding-state-machine.ts";

/** Default Stop releases the current media lease and retains continuity/session. */
export function applyMediaStop(input: {
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
  readonly request: StopRequest;
  readonly sameRef: (left: DeviceLeaseRecord["deviceLeaseRef"], right: DeviceLeaseRecord["deviceLeaseRef"]) => boolean;
  readonly receipt: TerminalReceipt;
}): {
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
  readonly receipt: TerminalReceipt;
} {
  if (input.request.operation !== "media_stop") throw new Error("STOP_OPERATION_INVALID");
  if (input.session.state !== "active" || input.session.continuityState !== "active") {
    throw new Error("SESSION_TERMINAL");
  }
  if (input.session.connectionEpoch !== assertDecimalConnectionEpoch(input.request.expectedConnectionEpoch)) {
    throw new Error("CONNECTION_EPOCH_CONFLICT");
  }
  if (input.session.binding.state !== "connected") {
    throw new Error("STOP_AUTHORITY_INVALID");
  }
  if (!input.sameRef(input.lease.deviceLeaseRef, input.session.activeDeviceLeaseRef) ||
      input.lease.deviceId !== input.request.deviceId) {
    throw new Error("STOP_AUTHORITY_INVALID");
  }
  if (input.request.expectedLeaseVersion === undefined) throw new Error("MISSING_LEASE_VERSION");
  const lease = releaseDeviceLease(input.lease, input.request.expectedLeaseVersion);
  const session: RealtimeSessionRecord = {
    ...input.session,
    binding: releaseTransportBinding(input.session.binding),
    revision: incrementDecimalCounter(input.session.revision),
  };
  return { session, lease, receipt: input.receipt };
}

/** A new explicit Start on the same device supersedes the session it still holds (its app was killed or lost the
 * Stop): the old continuity ends and its media lease is released in the Start's own transaction. */
export function applySupersede(input: {
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
  readonly occurredAt: string;
}): { readonly session: RealtimeSessionRecord; readonly lease: DeviceLeaseRecord } {
  if (input.session.state !== "active" || input.session.continuityState !== "active") throw new Error("SUPERSEDE_SESSION_TERMINAL");
  const occurredAt = assertCanonicalTimestamp(input.occurredAt);
  const session: RealtimeSessionRecord = {
    ...input.session,
    state: "terminal",
    continuityState: "ended",
    binding: { ...input.session.binding, state: "released" },
    revision: incrementDecimalCounter(input.session.revision),
    continuityExpiresAt: occurredAt,
    terminalAt: occurredAt,
    terminalReason: "superseded_by_new_start",
  };
  const lease = input.lease.state === "active" ? releaseDeviceLease(input.lease, input.lease.leaseVersion) : input.lease;
  return { session, lease };
}

/** End-continuity is explicit and distinct from media Stop. */
export function applyEndContinuity(input: {
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
  readonly request: StopRequest;
  readonly sameRef: (left: DeviceLeaseRecord["deviceLeaseRef"], right: DeviceLeaseRecord["deviceLeaseRef"]) => boolean;
  readonly receipt: TerminalReceipt;
}): {
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
  readonly receipt: TerminalReceipt;
} {
  if (input.request.operation !== "end_continuity") throw new Error("END_CONTINUITY_OPERATION_INVALID");
  if (input.session.connectionEpoch !== assertDecimalConnectionEpoch(input.request.expectedConnectionEpoch)) {
    throw new Error("CONNECTION_EPOCH_CONFLICT");
  }
  if (input.request.continuityId !== input.session.continuityId ||
      input.request.deviceId !== input.session.activeDeviceId ||
      !input.sameRef(input.lease.realtimeSessionRef, input.session.realtimeSessionRef) ||
      input.lease.continuityId !== input.session.continuityId ||
      input.lease.userId !== input.session.userId ||
      input.lease.deviceId !== input.request.deviceId ||
      !input.sameRef(input.lease.deviceLeaseRef, input.session.activeDeviceLeaseRef)) {
    throw new Error("END_CONTINUITY_AUTHORITY_INVALID");
  }
  if (input.lease.state === "active" && input.request.expectedLeaseVersion === undefined) {
    throw new Error("MISSING_LEASE_VERSION");
  }
  if (input.session.continuityState === "ended") return input;
  const occurredAt = assertCanonicalTimestamp(input.request.occurredAt);
  const session: RealtimeSessionRecord = {
    ...input.session,
    state: "terminal",
    continuityState: "ended",
    binding: { ...input.session.binding, state: "released" },
    revision: incrementDecimalCounter(input.session.revision),
    continuityExpiresAt: occurredAt,
    lastAcceptedUserActivityAt: input.session.lastAcceptedUserActivityAt,
    terminalAt: occurredAt,
    terminalReason: "end_continuity",
  };
  const lease = input.lease.state === "active"
    ? releaseDeviceLease(input.lease, input.request.expectedLeaseVersion ?? input.lease.leaseVersion)
    : input.lease;
  return { session, lease, receipt: input.receipt };
}
