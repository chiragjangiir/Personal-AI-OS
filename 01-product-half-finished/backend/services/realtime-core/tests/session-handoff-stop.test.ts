import assert from "node:assert/strict";
import test from "node:test";
import { applyEndContinuity, applyMediaStop } from "../src/media-stop-service.ts";
import { applySessionHandoff } from "../src/session-handoff-state-machine.ts";
import { createDeviceLease } from "../src/device-lease-state-machine.ts";
import { createTransportBinding } from "../src/transport-binding-state-machine.ts";
import {
  assertCanonicalTimestamp,
  assertDecimalCounter,
  assertDecimalConnectionEpoch,
  type HandoffRequest,
  type RealtimeSessionRecord,
  type TerminalReceipt,
} from "../src/types.ts";

const at = assertCanonicalTimestamp("2026-08-23T12:00:00.000Z");
const policy = {
  allowed: true as const,
  policyDecisionRef: "policy-1",
  capabilities: ["audio.publish"],
  purpose: "conversation",
  leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
  revocable: true as const,
};

function fixture() {
  const binding = createTransportBinding({
    realtimeSessionRef: "session-1",
    deviceLeaseRef: "lease-1",
    continuityId: "continuity-1",
    deviceId: "device-1",
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    provider: "livekit-cloud",
    transportSessionAlias: "transport-1",
    roomAlias: "room-1",
    deviceAlias: "device-1",
    connectionId: "connection-1",
  });
  const lease = createDeviceLease({
    deviceLeaseRef: "lease-1",
    realtimeSessionRef: "session-1",
    continuityId: "continuity-1",
    userId: "user-1",
    deviceId: "device-1",
    issuedAt: at,
    policy,
  });
  const session: RealtimeSessionRecord = {
    realtimeSessionRef: "session-1",
    userId: "user-1",
    continuityId: "continuity-1",
    state: "active",
    continuityState: "active",
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    continuityExpiresAt: assertCanonicalTimestamp("2026-08-24T12:00:00.000Z"),
    lastAcceptedUserActivityAt: at,
    activeDeviceId: "device-1",
    activeDeviceLeaseRef: "lease-1",
    binding,
    revision: assertDecimalCounter("1"),
  };
  return { session, lease };
}

function receipt(operation: TerminalReceipt["operation"], leaseRef = "lease-1"): TerminalReceipt {
  return {
    kind: "realtime_terminal_receipt",
    operation,
    status: "success",
    requestId: `${operation}-request`,
    idempotencyKey: `${operation}-idempotency`,
    realtimeSessionRef: "session-1",
    deviceLeaseRef: leaseRef,
    continuityId: "continuity-1",
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    outcome: operation,
    recordedAt: at,
    replayed: false,
  };
}

test("handoff is fenced by epoch and lease version and suppresses the old device", () => {
  const { session, lease } = fixture();
  const nextLease = createDeviceLease({
    deviceLeaseRef: "lease-2",
    realtimeSessionRef: "session-1",
    continuityId: "continuity-1",
    userId: "user-1",
    deviceId: "device-2",
    issuedAt: at,
    policy,
  });
  const nextBinding = createTransportBinding({
    ...session.binding,
    deviceLeaseRef: "lease-2",
    deviceId: "device-2",
    transportSessionAlias: "transport-2",
    roomAlias: "room-2",
    deviceAlias: "device-2",
    connectionId: "connection-2",
  });
  const request: HandoffRequest = {
    requestId: "handoff-1",
    idempotencyKey: "handoff-idem-1",
    realtimeSessionRef: "session-1",
    continuityId: "continuity-1",
    fromDeviceId: "device-1",
    toDeviceId: "device-2",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
    occurredAt: at,
    governance: "governance-1",
  };
  const result = applySessionHandoff({
    session,
    currentLease: lease,
    request,
    nextLease,
    nextBinding,
    sameRef: Object.is,
    now: at,
    receipt: receipt("handoff", "lease-2"),
  });
  assert.equal(result.session.activeDeviceId, "device-2");
  assert.equal(result.result.suppressedDeviceId, "device-1");
  assert.equal(result.result.activeDeviceLeaseRef, "lease-2");
  assert.throws(() => applySessionHandoff({
    session,
    currentLease: lease,
    request: { ...request, expectedLeaseVersion: assertDecimalCounter("0") },
    nextLease,
    nextBinding,
    sameRef: Object.is,
    now: at,
    receipt: receipt("handoff", "lease-2"),
  }), /STALE_ACTIVE_DEVICE_LEASE/);
});

test("media Stop releases only the lease while end-continuity is separate", () => {
  const { session, lease } = fixture();
  const stop = applyMediaStop({
    session,
    lease,
    request: {
      requestId: "stop-1",
      idempotencyKey: "stop-idem-1",
      operation: "media_stop",
      realtimeSessionRef: "session-1",
      continuityId: "continuity-1",
      deviceLeaseRef: "lease-1",
      deviceId: "device-1",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
      reason: "user_stop",
      occurredAt: at,
      governance: "governance-1",
    },
    sameRef: Object.is,
    receipt: receipt("media_stop"),
  });
  assert.equal(stop.lease.state, "released");
  assert.equal(stop.session.continuityState, "active");
  assert.equal(stop.session.binding.state, "released");
  assert.equal(stop.session.connectionEpoch, "1");
  const ended = applyEndContinuity({
    session,
    lease,
    request: {
      requestId: "end-1",
      idempotencyKey: "end-idem-1",
      operation: "end_continuity",
      realtimeSessionRef: "session-1",
      continuityId: "continuity-1",
      deviceLeaseRef: "lease-1",
      deviceId: "device-1",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
      reason: "user_stop",
      occurredAt: at,
      governance: "governance-1",
    },
    sameRef: Object.is,
    receipt: receipt("end_continuity"),
  });
  assert.equal(ended.session.continuityState, "ended");
  assert.equal(ended.session.state, "terminal");
  assert.equal(ended.session.binding.state, "released");
});
