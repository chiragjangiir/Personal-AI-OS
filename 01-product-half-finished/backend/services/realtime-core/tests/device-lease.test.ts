import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanonicalTimestamp,
  assertDecimalCounter,
} from "../src/types.ts";
import {
  assertLeaseUsable,
  createDeviceLease,
  expireDeviceLease,
  releaseDeviceLease,
  revokeDeviceLease,
} from "../src/device-lease-state-machine.ts";
import type { LeasePolicyDecision } from "../src/ports.ts";

const policy: LeasePolicyDecision = {
  allowed: true,
  policyDecisionRef: "policy-1",
  capabilities: ["audio.publish"],
  purpose: "conversation",
  leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
  revocable: true,
};

function lease() {
  return createDeviceLease({
    deviceLeaseRef: "lease-1",
    realtimeSessionRef: "session-1",
    continuityId: "continuity-1",
    userId: "user-1",
    deviceId: "device-1",
    issuedAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    policy,
  });
}

test("lease is capability/purpose scoped and releases with a fencing increment", () => {
  const active = lease();
  assert.deepEqual(active.capabilities, ["audio.publish"]);
  assert.equal(active.purpose, "conversation");
  const released = releaseDeviceLease(active, "1");
  assert.equal(released.state, "released");
  assert.equal(released.leaseVersion, "2");
  assert.equal(released.fencingToken, "2");
  assert.throws(() => releaseDeviceLease(active, "0"), /LEASE_VERSION_CONFLICT/);
});

test("revocation and expiry are terminal and unusable", () => {
  const revoked = revokeDeviceLease(lease(), "1");
  assert.equal(revoked.state, "revoked");
  assert.throws(() => assertLeaseUsable({
    lease: revoked,
    now: assertCanonicalTimestamp("2026-08-23T12:30:00.000Z"),
    expectedLeaseVersion: revoked.leaseVersion,
    expectedDeviceId: "device-1",
    expectedSessionRef: "session-1",
    sameRef: Object.is,
  }), /LEASE_REVOKED/);
  const expired = expireDeviceLease(lease(), assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"));
  assert.equal(expired.state, "expired");
  assert.equal(expired.leaseVersion, "2");
  assert.equal(assertDecimalCounter(expired.fencingToken), "2");
});

test("malformed runtime policy decisions fail closed before lease creation", () => {
  const base = {
    deviceLeaseRef: "lease-policy-invalid",
    realtimeSessionRef: "session-policy-invalid",
    continuityId: "continuity-1",
    userId: "user-1",
    deviceId: "device-1",
    issuedAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
  };
  const malformed: readonly unknown[] = [
    { ...policy, allowed: false },
    { ...policy, policyDecisionRef: undefined },
    { ...policy, capabilities: undefined },
    { ...policy, purpose: undefined },
    { ...policy, leaseExpiresAt: undefined },
    { ...policy, revocable: false },
  ];
  for (const candidate of malformed) {
    assert.throws(
      () => createDeviceLease({ ...base, policy: candidate as LeasePolicyDecision }),
      /POLICY_DECISION_INVALID|INVALID_OPAQUE_OWNER_VALUE|INVALID_TIMESTAMP/,
    );
  }
});
