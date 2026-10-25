import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptedUserActivity, RealtimeSessionRecord } from "../../../services/realtime-core/src/types.ts";
import {
  createRealtimePublicControlT04OwnerWriter,
  type RealtimePublicControlT04OwnerEvent,
  type RealtimePublicControlT04OwnerService,
} from "../src/realtime-public-control-t04-owner-writer.ts";
import type { AcceptedActivityStreamPool } from "../src/accepted-activity-stream.ts";

const SESSION = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: "018f0000-0000-7000-8000-000000000001",
  object_version: "1",
  canonical_payload_sha256: "a".repeat(64),
});
const ACCEPTANCE = Object.freeze({
  ref_type: "ContextAssertion",
  ref_id: "018f0000-0000-7000-8000-000000000002",
  object_version: "1",
  canonical_payload_sha256: "b".repeat(64),
});

function eventFor(activityId = "owner-action-receipt-0001", action = "cycling_start"): RealtimePublicControlT04OwnerEvent {
  const activity = {
    activityId,
    kind: "accepted_user_activity" as const,
    userId: "user-1",
    deviceId: "iphone-canonical-1",
    realtimeSessionRef: SESSION,
    continuityId: "continuity-1",
    occurredAt: "2026-08-30T11:59:30.000Z",
    acceptanceRef: ACCEPTANCE,
    accepted: true as const,
  } as unknown as AcceptedUserActivity;
  return {
    activity,
    actionReceipt: {
      kind: "t04.accepted_user_action_receipt",
      activityId,
      action,
      purpose: "cycling_assistant",
      origin: "iphone",
      committed: true,
      revoked: false,
      deleted: false,
      stale: false,
      bindingCommitted: action === "explicit_handoff",
    },
    currentBinding: {
      userId: activity.userId,
      activeDeviceId: activity.deviceId,
      realtimeSessionRef: SESSION,
      continuityId: activity.continuityId,
      sessionState: "active",
      continuityState: "active",
      transportState: "connected",
      leaseState: "active",
      lastAcceptedUserActivityAt: "2026-08-30T11:59:00.000Z",
      continuityExpiresAt: "2026-08-30T12:10:00.000Z",
      leaseExpiresAt: "2026-08-30T12:05:00.000Z",
    },
    authorityProjection: {
      kind: "t04.activity_authority_projection",
      environment: "production",
      activityId,
      origin: "user",
      userOriginated: true,
      accepted: true,
      current: true,
      deleted: false,
      suppressed: false,
      stale: false,
      purpose: "cycling_assistant",
      userId: activity.userId,
      deviceId: activity.deviceId,
      realtimeSessionRef: SESSION,
      continuityId: activity.continuityId,
      sessionTime: activity.occurredAt,
      acceptanceRef: ACCEPTANCE,
      authorityWatermark: { owner: "T04", sequence: "17" },
      watermarkCurrent: true,
      evidence: [{
        kind: "ContextAssertion",
        evidenceRef: ACCEPTANCE,
        activityId,
        userOriginated: true,
        authority: true,
        current: true,
        deleted: false,
        suppressed: false,
        stale: false,
      }],
    },
  };
}

const pool: AcceptedActivityStreamPool = { connect: async () => { throw new Error("NOT_USED"); } };
const result = Object.freeze({ state: "active" }) as unknown as RealtimeSessionRecord;

function durableService() {
  const calls: Array<{ activity: AcceptedUserActivity; ownerEvent: unknown }> = [];
  const records = new Map<string, string>();
  const service: RealtimePublicControlT04OwnerService = {
    recordAcceptedUserActivity: async (activity, ownerEvent) => {
      calls.push({ activity, ownerEvent });
      const fingerprint = JSON.stringify({ activity, ownerEvent });
      const previous = records.get(activity.activityId);
      if (previous !== undefined && previous !== fingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      records.set(activity.activityId, fingerprint);
      return result;
    },
  };
  return {service, calls};
}

test("T04 writer validates, forwards the full owner event, and replays through the durable service", async () => {
  const {service, calls} = durableService();
  const writer = createRealtimePublicControlT04OwnerWriter({
    pool,
    service,
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
  });
  assert.deepEqual(writer.readiness(), {
    owner: "T04.accepted-user-activity",
    environment: "production",
    ready: true,
  });
  const event = eventFor();
  assert.equal(await writer.write(event), result);
  assert.equal(await writer.write(structuredClone(event)), result);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.ownerEvent, {
    actionReceipt: event.actionReceipt,
    currentBinding: event.currentBinding,
    authorityProjection: event.authorityProjection,
  });
  assert.deepEqual(calls[1], calls[0]);
  await assert.rejects(writer.write(eventFor(event.activity.activityId, "cycling_pause")), /IDEMPOTENCY_CONFLICT/u);
  await writer.close();
  assert.equal(writer.readiness().ready, false);
});

test("concurrent activity ids retain each event's own receipt until durable admission", async () => {
  const {service, calls} = durableService();
  const writer = createRealtimePublicControlT04OwnerWriter({pool, service, now: () => Date.parse("2026-08-30T12:00:00.000Z")});
  const first = eventFor("concurrent-owner-event"), second = eventFor("concurrent-owner-event", "cycling_pause");
  try {
    const settled = await Promise.allSettled([writer.write(first), writer.write(second)]);
    assert.equal(settled[0]!.status, "fulfilled");
    assert.equal(settled[1]!.status, "rejected");
    if (settled[1]!.status === "rejected") assert.match(String(settled[1]!.reason), /IDEMPOTENCY_CONFLICT/u);
    assert.deepEqual(calls.map(call => (call.ownerEvent as {actionReceipt: unknown}).actionReceipt), [first.actionReceipt, second.actionReceipt]);
  } finally { await writer.close(); }
});

test("T04 writer removes a failed attempt so the durable transaction can retry", async () => {
  let calls = 0;
  let failOnce = true;
  const service: RealtimePublicControlT04OwnerService = {
    recordAcceptedUserActivity: async () => {
      calls += 1;
      if (failOnce) {
        failOnce = false;
        throw new Error("ROLLBACK");
      }
      return result;
    },
  };
  const writer = createRealtimePublicControlT04OwnerWriter({
    pool,
    service,
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
  });
  const event = eventFor("owner-action-receipt-0002");
  await assert.rejects(writer.write(event), /ROLLBACK/u);
  assert.equal(await writer.write(event), result);
  assert.equal(calls, 2);
  await writer.close();
});
