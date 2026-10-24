import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionStructuralEquality,
} from "../../services/realtime-core/src/production-owner-ports.ts";
import type {
  AcceptedUserActivity,
  RealtimeCurrentBindingProjection,
} from "../../services/realtime-core/src/types.ts";
import {
  ActivityAuthorityReaderError,
  createActivityAuthorityReader,
} from "../../services/context-engine/src/activity-authority-reader.ts";

const NOW = "2026-08-28T12:00:00.000Z" as AcceptedUserActivity["occurredAt"];
const SESSION = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: "0190a000-0000-7000-8000-000000000001",
  object_version: "1",
  canonical_payload_sha256: "a".repeat(64),
});
const LEASE = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: "0190a000-0000-7000-8000-000000000002",
  object_version: "1",
  canonical_payload_sha256: "b".repeat(64),
});

function currentBinding(overrides: Record<string, unknown> = {}): RealtimeCurrentBindingProjection {
  const session = {
    realtimeSessionRef: SESSION,
    userId: "user-1",
    continuityId: "continuity-1",
    state: "active",
    continuityState: "active",
    connectionEpoch: "1",
    continuityExpiresAt: "2026-08-29T12:00:00.000Z",
    lastAcceptedUserActivityAt: NOW,
    activeDeviceId: "device-1",
    activeDeviceLeaseRef: LEASE,
    binding: {
      state: "connected",
      realtimeSessionRef: SESSION,
      deviceLeaseRef: LEASE,
      continuityId: "continuity-1",
      deviceId: "device-1",
      connectionEpoch: "1",
      provider: "livekit-cloud",
      transportSessionAlias: "transport-1",
      roomAlias: "room-1",
      deviceAlias: "device-1",
      connectionId: "connection-1",
    },
    revision: "1",
  };
  const lease = {
    deviceLeaseRef: LEASE,
    realtimeSessionRef: SESSION,
    continuityId: "continuity-1",
    userId: "user-1",
    deviceId: "device-1",
    state: "active",
    capabilities: ["realtime.media"],
    purpose: "rayneo.production.canary",
    issuedAt: NOW,
    expiresAt: "2026-08-29T12:00:00.000Z",
    revocable: true,
    leaseVersion: "1",
    fencingToken: "1",
    policyDecisionRef: "policy-1",
  };
  return {
    session: { ...session, ...(overrides.session as Record<string, unknown> | undefined) },
    lease: { ...lease, ...(overrides.lease as Record<string, unknown> | undefined) },
  } as unknown as RealtimeCurrentBindingProjection;
}

function activity(overrides: Record<string, unknown> = {}): AcceptedUserActivity {
  return {
    activityId: "activity-1",
    kind: "accepted_user_activity",
    userId: "user-1",
    deviceId: "device-1",
    realtimeSessionRef: SESSION,
    continuityId: "continuity-1",
    occurredAt: NOW,
    acceptanceRef: Object.freeze({
      ref_type: "Observation",
      ref_id: "0190a000-0000-7000-8000-000000000003",
      object_version: "1",
      canonical_payload_sha256: "c".repeat(64),
    }),
    accepted: true,
    ...overrides,
  } as AcceptedUserActivity;
}

function makeReader(
  binding: RealtimeCurrentBindingProjection = currentBinding(),
  projection: unknown = Object.freeze({ owner: "T04", accepted: true }),
) {
  const lookups: unknown[] = [];
  const projectionInputs: unknown[] = [];
  const reader = createActivityAuthorityReader({
    readCurrentBinding: async (lookup) => {
      lookups.push(lookup);
      return binding;
    },
    readAuthorityProjection: async (input) => {
      projectionInputs.push(input);
      return projection;
    },
    equality: createProductionStructuralEquality(),
  });
  return { reader, lookups, projectionInputs, binding };
}

test("reads only the exact canonical session ref and delegates the owner projection", async () => {
  const harness = makeReader();
  const input = activity();
  const result = await harness.reader.readCurrent(input);
  assert.deepEqual(result, { owner: "T04", accepted: true });
  assert.deepEqual(harness.lookups, [{ realtimeSessionRef: SESSION }]);
  assert.equal(harness.projectionInputs.length, 1);
  assert.equal((harness.projectionInputs[0] as { activity: AcceptedUserActivity }).activity, input);
  assert.deepEqual(
    (harness.projectionInputs[0] as { currentBinding: RealtimeCurrentBindingProjection }).currentBinding,
    harness.binding,
  );
});

test("rejects inactive or mismatched current authority before calling T04", async () => {
  const inactive = makeReader(currentBinding({ session: { state: "terminal" } }));
  await assert.rejects(
    async () => inactive.reader.readCurrent(activity()),
    (error: unknown) => error instanceof ActivityAuthorityReaderError &&
      error.code === "ACTIVITY_AUTHORITY_CURRENT_BINDING_INVALID",
  );
  assert.equal(inactive.projectionInputs.length, 0);

  const mismatch = makeReader(currentBinding({ lease: { deviceId: "other-device" } }));
  await assert.rejects(
    async () => mismatch.reader.readCurrent(activity()),
    (error: unknown) => error instanceof ActivityAuthorityReaderError &&
      error.code === "ACTIVITY_AUTHORITY_CURRENT_BINDING_MISMATCH",
  );
  assert.equal(mismatch.projectionInputs.length, 0);
});

test("does not cache authority and fails closed when the owner projection is absent", async () => {
  let reads = 0;
  const reader = createActivityAuthorityReader({
    readCurrentBinding: async () => {
      reads += 1;
      return currentBinding();
    },
    readAuthorityProjection: async () => undefined,
    equality: createProductionStructuralEquality(),
  });
  await assert.rejects(async () => reader.readCurrent(activity()), /ACTIVITY_AUTHORITY_PROJECTION_UNAVAILABLE/u);
  await assert.rejects(async () => reader.readCurrent(activity({ activityId: "activity-2" })), /ACTIVITY_AUTHORITY_PROJECTION_UNAVAILABLE/u);
  assert.equal(reads, 2);
});
