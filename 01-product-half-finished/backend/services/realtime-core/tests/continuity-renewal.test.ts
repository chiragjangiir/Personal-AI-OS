import assert from "node:assert/strict";
import test from "node:test";
import { acceptedActivityDeadline, applyAcceptedUserActivityRenewal } from "../src/continuity-renewal.ts";
import {
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
  assertCanonicalTimestamp,
  type RealtimeActivity,
  type RealtimeSessionRecord,
} from "../src/types.ts";

const ref = (value: string) => value;
const sameOwnerRef = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const session = (): RealtimeSessionRecord => ({
  realtimeSessionRef: ref("session-1"),
  userId: "user-1",
  continuityId: "continuity-1",
  state: "active",
  continuityState: "active",
  connectionEpoch: assertDecimalConnectionEpoch("1"),
  continuityExpiresAt: assertCanonicalTimestamp("2026-08-24T12:00:00.000Z"),
  lastAcceptedUserActivityAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
  activeDeviceId: "device-1",
  activeDeviceLeaseRef: ref("lease-1"),
  binding: {
    state: "connected",
    realtimeSessionRef: ref("session-1"),
    deviceLeaseRef: ref("lease-1"),
    continuityId: "continuity-1",
    deviceId: "device-1",
    connectionEpoch: assertDecimalConnectionEpoch("1"),
    provider: "livekit-cloud",
    transportSessionAlias: "room-1",
    roomAlias: "room-1",
    deviceAlias: "device-1",
    connectionId: "connection-1",
  },
  revision: assertDecimalCounter("1"),
});

test("accepted user activity renews at least 24 hours from the accepted event", () => {
  const input = session();
  const occurredAt = assertCanonicalTimestamp("2026-08-23T18:00:00.000Z");
  const result = applyAcceptedUserActivityRenewal(input, {
    activityId: "activity-1",
    kind: "accepted_user_activity",
    accepted: true,
    userId: "user-1",
    deviceId: "device-1",
    realtimeSessionRef: "session-1",
    continuityId: "continuity-1",
    occurredAt,
    acceptanceRef: "acceptance-1",
  }, { verified: true, acceptanceRef: "acceptance-1", acceptedAt: occurredAt, authorityWatermark: "watermark-1" }, sameOwnerRef);
  assert.equal(result.result.renewed, true);
  assert.equal(result.session.continuityExpiresAt, acceptedActivityDeadline(occurredAt));
  assert.equal(result.session.lastAcceptedUserActivityAt, occurredAt);
});

const nonRenewingKinds = ["heartbeat", "reconnect", "media", "model", "sdk"] as const;
const acceptedFlags: readonly (boolean | undefined)[] = [true, false, undefined];
const changedActivityTimes = [
  "2026-08-23T20:00:00.000Z",
  "2026-08-24T12:00:00.000Z",
  "2026-08-22T00:00:00.000Z",
] as const;

const nonRenewingCases = nonRenewingKinds.flatMap((kind, kindIndex) =>
  acceptedFlags.map((accepted, flagIndex) => ({
    kind,
    accepted,
    occurredAt: changedActivityTimes[(kindIndex + flagIndex) % changedActivityTimes.length],
  }))
);

test("heartbeat, reconnect, media, model, and sdk activity never renews continuity", () => {
  for (const [index, scenario] of nonRenewingCases.entries()) {
    const input = session();
    const activity: RealtimeActivity = {
      activityId: `${scenario.kind}-${index}`,
      kind: scenario.kind,
      userId: "user-1",
      deviceId: "device-1",
      realtimeSessionRef: "session-1",
      continuityId: "continuity-1",
      occurredAt: assertCanonicalTimestamp(scenario.occurredAt),
      acceptanceRef: "acceptance-1",
      ...(scenario.accepted === undefined ? {} : { accepted: scenario.accepted }),
    };
    const result = applyAcceptedUserActivityRenewal(
      input,
      activity,
      {
        verified: true,
        acceptanceRef: "acceptance-1",
        acceptedAt: assertCanonicalTimestamp("2026-08-23T20:00:00.000Z"),
        authorityWatermark: "watermark-1",
      },
      sameOwnerRef,
    );
    const label = `${scenario.kind} accepted=${String(scenario.accepted)} occurredAt=${scenario.occurredAt}`;

    assert.strictEqual(result.session, input, `${label}: non-renewing activity must not mutate the session`);
    assert.equal(result.result.renewed, false, label);
    assert.equal(result.result.reason, "non_renewing_activity", label);
    assert.equal(result.result.continuityExpiresAt, input.continuityExpiresAt, label);
    assert.equal(result.result.lastAcceptedUserActivityAt, input.lastAcceptedUserActivityAt, label);
    assert.equal(result.session.continuityExpiresAt, "2026-08-24T12:00:00.000Z", label);
    assert.equal(result.session.lastAcceptedUserActivityAt, "2026-08-23T12:00:00.000Z", label);
    assert.equal(result.session.revision, "1", label);
  }
});
