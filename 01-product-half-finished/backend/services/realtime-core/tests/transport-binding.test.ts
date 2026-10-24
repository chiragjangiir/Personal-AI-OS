import assert from "node:assert/strict";
import test from "node:test";
import { assertDecimalConnectionEpoch } from "../src/types.ts";
import {
  assertConnectedRefreshBinding,
  createFullyDisconnectedBinding,
  createTransportBinding,
} from "../src/transport-binding-state-machine.ts";

const equality = { same: Object.is };
function binding(epoch = "1") {
  return createTransportBinding({
    realtimeSessionRef: "session-1",
    deviceLeaseRef: "lease-1",
    continuityId: "continuity-1",
    deviceId: "device-1",
    connectionEpoch: assertDecimalConnectionEpoch(epoch),
    provider: "livekit-cloud",
    transportSessionAlias: "transport-1",
    roomAlias: "room-1",
    deviceAlias: "device-1",
    connectionId: "connection-1",
  });
}

test("connected refresh requires the exact canonical and external binding", () => {
  const current = binding();
  assert.strictEqual(assertConnectedRefreshBinding(current, current, equality), current);
  assert.throws(() => assertConnectedRefreshBinding(current, { ...current, connectionEpoch: assertDecimalConnectionEpoch("2") }, equality), /TRANSPORT_BINDING_CONFLICT/);
});

test("fully disconnected rebind preserves continuity and advances epoch", () => {
  const previous = binding();
  const next = createFullyDisconnectedBinding({
    previous,
    realtimeSessionRef: "session-2",
    deviceLeaseRef: "lease-2",
    deviceId: "device-2",
    connectionEpoch: assertDecimalConnectionEpoch("2"),
    transportSessionAlias: "transport-2",
    roomAlias: "room-2",
    deviceAlias: "device-2",
    connectionId: "connection-2",
  });
  assert.equal(next.continuityId, previous.continuityId);
  assert.equal(next.deviceId, "device-2");
  assert.equal(next.connectionEpoch, "2");
  assert.equal(next.transportSessionAlias, "transport-2");
  assert.throws(() => createFullyDisconnectedBinding({
    previous,
    realtimeSessionRef: "session-3",
    deviceLeaseRef: "lease-3",
    deviceId: "device-3",
    connectionEpoch: assertDecimalConnectionEpoch("3"),
    transportSessionAlias: "transport-3",
    roomAlias: "room-3",
    deviceAlias: "device-3",
    connectionId: "connection-3",
  }), /CONNECTION_EPOCH_NOT_ADVANCED/);
});
