import assert from "node:assert/strict";
import test from "node:test";

import { createProductionStructuralEquality } from "../../services/realtime-core/src/production-owner-ports.ts";
import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  type RealtimeTransportBinding,
} from "../../services/realtime-core/src/types.ts";
import {
  createTransportDisconnectionPort,
  type Runtime028RecoveryState,
} from "../../services/public-rtc/src/transport-disconnection-port.ts";

const OCCURRED_AT = assertCanonicalTimestamp("2026-08-28T12:00:00.000Z");
const SESSION = Object.freeze({ ref_type: "RealtimeSession", ref_id: "session-1" });
const LEASE = Object.freeze({ ref_type: "DeviceLease", ref_id: "lease-1" });
const ALIASES = Object.freeze(["transport-1", "room-1", "device-1"]);

function binding(overrides: Partial<RealtimeTransportBinding> = {}): RealtimeTransportBinding {
  return Object.freeze({
    state: "connected" as const,
    realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE,
    continuityId: "continuity-1",
    deviceId: "device-1",
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    provider: "livekit-cloud",
    transportSessionAlias: ALIASES[0],
    roomAlias: ALIASES[1],
    deviceAlias: ALIASES[2],
    connectionId: "connection-1",
    ...overrides,
  }) as RealtimeTransportBinding;
}

function recovery(overrides: Partial<Runtime028RecoveryState> = {}): Runtime028RecoveryState {
  return Object.freeze({
    realtime_session_ref: { ...SESSION },
    device_lease_ref: { ...LEASE },
    continuity_id: "continuity-1",
    transport_aliases: Object.freeze([...ALIASES]),
    epoch: "1",
    status: "disconnected" as const,
    credential_ref: "credential-1",
    credential_expires_at_ms: Date.parse("2026-08-28T12:30:00.000Z"),
    continuity_expires_at_ms: Date.parse("2026-08-29T12:00:00.000Z"),
    disconnected_at_ms: Date.parse("2026-08-28T11:59:00.000Z"),
    ...overrides,
  });
}

function makePort(
  state: Runtime028RecoveryState = recovery(),
  proof: unknown = Object.freeze({ ref: "transport-disconnect-proof-1" }),
) {
  let snapshots = 0;
  let proofInputs: unknown[] = [];
  const port = createTransportDisconnectionPort({
    recovery: {
      snapshot: () => {
        snapshots += 1;
        return state;
      },
    },
    authorityProof: async (input) => {
      proofInputs.push(input);
      return proof as never;
    },
    equality: createProductionStructuralEquality(),
  });
  return { port, get snapshots() { return snapshots; }, proofInputs };
}

test("accepts a terminal recovery snapshot with exact binding and owner proof", async () => {
  const harness = makePort();
  const result = await harness.port.verify({
    binding: binding(),
    userId: "user-1",
    deviceId: "device-1",
    occurredAt: OCCURRED_AT,
    governance: "governance-1",
  });
  assert.equal(result.verified, true);
  assert.equal(result.disconnectedAt, "2026-08-28T11:59:00.000Z");
  assert.deepEqual(result.authorityProof, { ref: "transport-disconnect-proof-1" });
  assert.equal(harness.snapshots, 1);
  assert.equal(harness.proofInputs.length, 1);
});

test("rejects state, reference, epoch, continuity, and alias drift without proof", async () => {
  const cases: Array<[string, Runtime028RecoveryState]> = [
    ["state", recovery({ status: "connected" })],
    ["session", recovery({ realtime_session_ref: "other-session" })],
    ["lease", recovery({ device_lease_ref: "other-lease" })],
    ["continuity", recovery({ continuity_id: "other-continuity" })],
    ["epoch", recovery({ epoch: "2" })],
    ["alias", recovery({ transport_aliases: ["transport-1", "other-room", "device-1"] })],
  ];
  for (const [name, state] of cases) {
    const harness = makePort(state);
    await assert.rejects(
      harness.port.verify({
        binding: binding(),
        userId: "user-1",
        deviceId: "device-1",
        occurredAt: OCCURRED_AT,
        governance: "governance-1",
      }),
      new RegExp(name === "state" ? "TRANSPORT_DISCONNECTION_STATE_INVALID" : "TRANSPORT_DISCONNECTION_BINDING_MISMATCH", "u"),
    );
    assert.equal(harness.proofInputs.length, 0);
  }
});

test("requires an external proof and never mutates recovery state", async () => {
  const state = recovery();
  const before = JSON.stringify(state);
  const harness = makePort(state, null);
  await assert.rejects(
    harness.port.verify({
      binding: binding(),
      userId: "user-1",
      deviceId: "device-1",
      occurredAt: OCCURRED_AT,
      governance: "governance-1",
    }),
    /TRANSPORT_DISCONNECTION_PROOF_MISSING/u,
  );
  assert.equal(JSON.stringify(state), before);
  assert.equal(harness.snapshots, 1);
  assert.equal(harness.proofInputs.length, 1);
});
