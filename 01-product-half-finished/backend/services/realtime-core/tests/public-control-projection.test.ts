import assert from "node:assert/strict";
import test from "node:test";
import { projectBootstrap, projectRefresh } from "../src/public-control-projection.ts";
import { assertCanonicalTimestamp, assertDecimalConnectionEpoch, type BootstrapResult, type RefreshResult } from "../src/types.ts";

const binding = {
  state: "connected" as const,
  realtimeSessionRef: "session-ref-1",
  deviceLeaseRef: "lease-ref-1",
  continuityId: "continuity-1",
  deviceId: "device-1",
  connectionEpoch: assertDecimalConnectionEpoch("1"),
  provider: "livekit-cloud",
  transportSessionAlias: "transport-1",
  roomAlias: "room-1",
  deviceAlias: "device-1",
  connectionId: "connection-1",
};
const receipt = {
  kind: "realtime_terminal_receipt" as const,
  operation: "bootstrap" as const,
  status: "success" as const,
  requestId: "request-1",
  idempotencyKey: "idem-1",
  realtimeSessionRef: "session-ref-1",
  deviceLeaseRef: "lease-ref-1",
  continuityId: "continuity-1",
  connectionEpoch: assertDecimalConnectionEpoch("1"),
  outcome: "bootstrap_created",
  recordedAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
  replayed: false,
};

test("public projection exposes canonical refs, epoch, and opaque aliases", () => {
  const result: BootstrapResult = {
    operation: "bootstrap",
    realtimeSessionRef: "session-ref-1",
    continuityId: "continuity-1",
    deviceLeaseRef: "lease-ref-1",
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    binding,
    continuityExpiresAt: assertCanonicalTimestamp("2026-08-24T12:00:00.000Z"),
    leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
    receipt,
  };
  const projected = projectBootstrap(result);
  assert.equal(projected.binding.realtimeSessionRef, "session-ref-1");
  assert.equal(projected.binding.connectionEpoch, "1");
  assert.equal(projected.binding.roomAlias, "room-1");
  assert.equal(projected.receipt.status, "success");
  assert.equal(Object.isFrozen(projected), true);
});

test("refresh projection retains the owner-provided binding without synthesizing wire fields", () => {
  const result: RefreshResult = {
    operation: "connected_credential_refresh",
    binding,
    continuityExpiresAt: assertCanonicalTimestamp("2026-08-24T12:00:00.000Z"),
    leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
    receipt: { ...receipt, operation: "connected_credential_refresh" },
  };
  const projected = projectRefresh(result);
  assert.equal(projected.operation, "connected_credential_refresh");
  assert.strictEqual(projected.binding.transportSessionAlias, binding.transportSessionAlias);
});

test("public projection snapshots and freezes opaque refs and aliases", () => {
  const sessionRef = { kind: "realtime_session", id: "session-1" };
  const leaseRef = { kind: "device_lease", id: "lease-1" };
  const transportAlias = { provider: "livekit-cloud", room: { id: "room-1" } };
  const projected = projectBootstrap({
    operation: "bootstrap",
    realtimeSessionRef: sessionRef,
    continuityId: "continuity-1",
    deviceLeaseRef: leaseRef,
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    binding: {
      ...binding,
      realtimeSessionRef: sessionRef,
      deviceLeaseRef: leaseRef,
      transportSessionAlias: transportAlias,
      roomAlias: transportAlias,
      deviceAlias: { provider: "livekit-cloud", device: "device-1" },
      provider: { name: "livekit-cloud" },
    },
    continuityExpiresAt: assertCanonicalTimestamp("2026-08-24T12:00:00.000Z"),
    leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
    receipt: {
      ...receipt,
      realtimeSessionRef: sessionRef,
      deviceLeaseRef: leaseRef,
    },
  });
  sessionRef.id = "mutated-session";
  transportAlias.room.id = "mutated-room";
  assert.deepEqual(projected.binding.realtimeSessionRef, { kind: "realtime_session", id: "session-1" });
  assert.deepEqual(projected.binding.transportSessionAlias, { provider: "livekit-cloud", room: { id: "room-1" } });
  assert.equal(Object.isFrozen(projected.binding.realtimeSessionRef), true);
  assert.equal(Object.isFrozen((projected.binding.transportSessionAlias as { readonly room: object }).room), true);
  assert.equal(Object.isFrozen(projected.receipt.realtimeSessionRef), true);
});
