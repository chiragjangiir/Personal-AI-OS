import { assertEpochMatches } from "./connection-epoch.ts";
import {
  assertDecimalCounter,
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  incrementDecimalCounter,
  type DeviceLeaseRecord,
  type HandoffRequest,
  type HandoffResult,
  type RealtimeSessionRecord,
  type RealtimeTransportBinding,
} from "./types.ts";
import { assertLeaseUsable } from "./device-lease-state-machine.ts";

export function applySessionHandoff(input: {
  readonly session: RealtimeSessionRecord;
  readonly currentLease: DeviceLeaseRecord;
  readonly request: HandoffRequest;
  readonly nextLease: DeviceLeaseRecord;
  readonly nextBinding: RealtimeTransportBinding;
  readonly sameRef: (left: DeviceLeaseRecord["deviceLeaseRef"], right: DeviceLeaseRecord["deviceLeaseRef"]) => boolean;
  readonly now: string;
  readonly receipt: HandoffResult["receipt"];
}): {
  readonly session: RealtimeSessionRecord;
  readonly currentLease: DeviceLeaseRecord;
  readonly nextLease: DeviceLeaseRecord;
  readonly result: HandoffResult;
} {
  const { session, currentLease, request, nextLease, nextBinding } = input;
  if (session.state !== "active" || session.continuityState !== "active") {
    throw new Error("SESSION_TERMINAL");
  }
  if (!input.sameRef(request.realtimeSessionRef, session.realtimeSessionRef) ||
      session.continuityId !== request.continuityId ||
      session.activeDeviceId !== request.fromDeviceId ||
      nextBinding.deviceId !== request.toDeviceId) {
    throw new Error("HANDOFF_BINDING_INVALID");
  }
  assertEpochMatches(session.connectionEpoch, request.expectedConnectionEpoch);
  if (currentLease.leaseVersion !== assertDecimalCounter(request.expectedLeaseVersion)) {
    throw new Error("STALE_ACTIVE_DEVICE_LEASE");
  }
  if (!input.sameRef(currentLease.deviceLeaseRef, session.activeDeviceLeaseRef)) {
    throw new Error("HANDOFF_LEASE_INVALID");
  }
  if (currentLease.userId !== session.userId || currentLease.continuityId !== session.continuityId) {
    throw new Error("HANDOFF_LEASE_INVALID");
  }
  if (nextBinding.connectionEpoch !== session.connectionEpoch) {
    throw new Error("HANDOFF_EPOCH_INVALID");
  }
  const now = assertCanonicalTimestamp(input.now);
  assertLeaseUsable({
    lease: currentLease,
    now,
    expectedLeaseVersion: request.expectedLeaseVersion,
    expectedDeviceId: request.fromDeviceId,
    expectedSessionRef: session.realtimeSessionRef,
    sameRef: input.sameRef,
  });
  assertLeaseUsable({
    lease: nextLease,
    now,
    expectedLeaseVersion: nextLease.leaseVersion,
    expectedDeviceId: request.toDeviceId,
    expectedSessionRef: session.realtimeSessionRef,
    sameRef: input.sameRef,
  });
  if (nextLease.continuityId !== session.continuityId || nextLease.userId !== session.userId ||
      !input.sameRef(nextLease.deviceLeaseRef, nextBinding.deviceLeaseRef) ||
      !input.sameRef(nextLease.realtimeSessionRef, session.realtimeSessionRef) ||
      nextBinding.continuityId !== session.continuityId ||
      !input.sameRef(nextBinding.realtimeSessionRef, session.realtimeSessionRef) ||
      nextBinding.state !== "connected") {
    throw new Error("HANDOFF_NEXT_BINDING_INVALID");
  }
  if (input.receipt.operation !== "handoff" || input.receipt.realtimeSessionRef === undefined ||
      !input.sameRef(input.receipt.realtimeSessionRef, session.realtimeSessionRef) ||
      input.receipt.deviceLeaseRef === undefined ||
      !input.sameRef(input.receipt.deviceLeaseRef, nextLease.deviceLeaseRef) ||
      input.receipt.connectionEpoch !== session.connectionEpoch) {
    throw new Error("HANDOFF_RECEIPT_INVALID");
  }
  const nextSession: RealtimeSessionRecord = {
    ...session,
    activeDeviceId: request.toDeviceId,
    activeDeviceLeaseRef: nextLease.deviceLeaseRef,
    binding: nextBinding,
    revision: incrementDecimalCounter(session.revision),
  };
  return {
    session: nextSession,
    currentLease,
    nextLease,
    result: {
      state: "completed",
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      realtimeSessionRef: session.realtimeSessionRef,
      continuityId: session.continuityId,
      activeDeviceId: request.toDeviceId,
      activeDeviceLeaseRef: nextLease.deviceLeaseRef,
      connectionEpoch: session.connectionEpoch,
      leaseVersion: nextLease.leaseVersion,
      fencingToken: nextLease.fencingToken,
      suppressedDeviceId: request.fromDeviceId,
      receipt: input.receipt,
    },
  };
}
