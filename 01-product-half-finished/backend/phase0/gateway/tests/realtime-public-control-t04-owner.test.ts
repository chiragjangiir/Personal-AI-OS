import assert from "node:assert/strict";
import test from "node:test";

import {
  buildT04AcceptedUserActivityEvent,
  createRealtimePublicControlT04Owner,
  type T04AcceptedUserActivityOwnerEvent,
  type T04AcceptedUserActivityEventInput,
  type T04DurableOwnerWriter,
} from "../src/realtime-public-control-t04-owner.ts";
import type { AcceptedActivityRecord } from "../../../services/platform-data/src/accepted-activity-stream.ts";
import { createRealtimePublicControlT04OwnerWriter } from "../../../services/platform-data/src/realtime-public-control-t04-owner-writer.ts";
import { applyAcceptedUserActivityRenewal } from "../../../services/realtime-core/src/continuity-renewal.ts";
import { assertDecimalConnectionEpoch, type RealtimeSessionRecord } from "../../../services/realtime-core/src/types.ts";

const NOW = Date.parse("2026-09-01T08:00:00.000Z");
const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: "01900000-0000-7000-8000-000000000001",
  object_version: "1",
  canonical_payload_sha256: "a".repeat(64),
});
const LEASE_REF = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: "01900000-0000-7000-8000-000000000002",
  object_version: "1",
  canonical_payload_sha256: "b".repeat(64),
});

function input(
  changes: Readonly<{
    readonly idempotencyKey?: string;
    readonly authoritySessionRef?: unknown;
    readonly leaseState?: string;
    readonly requestAction?: string;
  }> = {},
): T04AcceptedUserActivityEventInput {
  const governance = { policyDecisionRef: "policy-1", capabilityRef: "capability-1" };
  const binding = {
    session: {
      realtimeSessionRef: SESSION_REF,
      userId: "user-1",
      continuityId: "continuity-1",
      state: "active",
      continuityState: "active",
      connectionEpoch: "1",
      continuityExpiresAt: "2026-09-01T08:10:00.000Z",
      lastAcceptedUserActivityAt: "2026-09-01T07:59:00.000Z",
      activeDeviceId: "iphone-1",
      activeDeviceLeaseRef: LEASE_REF,
      revision: "1",
      binding: {
        state: "connected",
        realtimeSessionRef: SESSION_REF,
        deviceLeaseRef: LEASE_REF,
        continuityId: "continuity-1",
        deviceId: "iphone-1",
        connectionEpoch: "1",
        provider: "livekit-cloud",
        transportSessionAlias: "opaque-session-alias",
        roomAlias: "opaque-room-alias",
        deviceAlias: "opaque-device-alias",
        connectionId: "connection-1",
      },
    },
    lease: {
      deviceLeaseRef: LEASE_REF,
      realtimeSessionRef: SESSION_REF,
      continuityId: "continuity-1",
      userId: "user-1",
      deviceId: "iphone-1",
      state: changes.leaseState ?? "active",
      capabilities: ["audio", "video", "data"],
      purpose: "cycling_assistant",
      issuedAt: "2026-09-01T07:50:00.000Z",
      expiresAt: "2026-09-01T08:10:00.000Z",
      revocable: true,
      leaseVersion: "1",
      fencingToken: "1",
      policyDecisionRef: "policy-1",
    },
  };
  const request = {
    request_id: "request-1",
    idempotency_context: { idempotency_key: changes.idempotencyKey ?? "activity-1" },
    user_id: "user-1",
    device_id: "iphone-1",
    start: { kind: "explicit_user_start", device_id: "iphone-1", started_at: "2026-09-01T07:59:30.000Z" },
    action: changes.requestAction ?? "client_must_not_control_action",
    origin: "client_must_not_control_origin",
    authority: { forged: true },
  };
  const authority = {
    realtime_session_ref: changes.authoritySessionRef ?? SESSION_REF,
    device_lease_ref: LEASE_REF,
    continuity_id: "continuity-1",
    connection_epoch: "1",
    credential_expires_at: "2026-09-01T08:05:00.000Z",
    continuity_expires_at: "2026-09-01T08:10:00.000Z",
    governance,
    gateway: {},
    terminal_room_name: "unused-by-builder",
    terminal_identity: "unused-by-builder",
    terminal_grants: {},
    media_grants: {},
    transport_aliases: [],
  };
  return {
    request,
    bearer: { principal: "owner-principal", deviceId: "iphone-1", scopes: ["bootstrap"] },
    governance,
    authority,
    currentBinding: binding,
    now: NOW,
  } as unknown as T04AcceptedUserActivityEventInput;
}

test("builds a deterministic, closed T04 event with one ContextAssertion", () => {
  const first = buildT04AcceptedUserActivityEvent(input());
  const second = buildT04AcceptedUserActivityEvent(input());

  assert.deepEqual(first, second);
  assert.equal(first.activity.activityId, "activity-1");
  assert.equal(first.actionReceipt.action, "button_submit");
  assert.equal(first.actionReceipt.origin, "iphone");
  assert.equal(first.actionReceipt.purpose, "cycling_assistant");
  assert.equal(first.authorityProjection.evidence.length, 1);
  assert.equal(first.authorityProjection.evidence[0]!.kind, "ContextAssertion");
  assert.equal(first.authorityProjection.evidence[0]!.evidenceRef, first.activity.acceptanceRef);
  const ref = first.activity.acceptanceRef as Record<string, unknown>;
  assert.equal(ref.ref_type, "ContextAssertion");
  assert.equal(ref.object_version, "1");
  assert.match(String(ref.ref_id), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(String(ref.canonical_payload_sha256), /^[0-9a-f]{64}$/u);
});

test("does not allow client action, origin, or authority fields to control the event", () => {
  const event = buildT04AcceptedUserActivityEvent(input({
    requestAction: "explicit_handoff",
  }));
  assert.equal(event.actionReceipt.action, "button_submit");
  assert.equal(event.actionReceipt.origin, "iphone");
  assert.equal(event.actionReceipt.bindingCommitted, false);
  assert.equal(event.authorityProjection.origin, "user");
});

test("requires the owner binding to match T11B refs, state, epoch, and expiry", () => {
  assert.throws(
    () => buildT04AcceptedUserActivityEvent(input({ authoritySessionRef: { forged: true } })),
    /T04_OWNER_BINDING_AUTHORITY_MISMATCH/u,
  );
  assert.throws(
    () => buildT04AcceptedUserActivityEvent(input({ leaseState: "released" })),
    /T04_OWNER_BINDING_STATE_INVALID/u,
  );
});

test("changes to the validated idempotency seed produce a different assertion", () => {
  const first = buildT04AcceptedUserActivityEvent(input());
  const second = buildT04AcceptedUserActivityEvent(input({ idempotencyKey: "activity-2" }));
  assert.notDeepEqual(first.activity.acceptanceRef, second.activity.acceptanceRef);
  assert.notDeepEqual(first.authorityProjection.authorityWatermark, second.authorityProjection.authorityWatermark);
});

test("returns frozen owner values and rejects future or non-new activity times", () => {
  const event = buildT04AcceptedUserActivityEvent(input());
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.activity), true);
  assert.equal(Object.isFrozen(event.currentBinding), true);
  assert.equal(Object.isFrozen(event.authorityProjection.evidence), true);
  const base = input();
  const startedAt = (value: string) => ({ ...base, request: { ...base.request, start: { ...(base.request.start as object), started_at: value } } });
  // A device clock a second ahead of the host is normal; beyond the bounded lead (2 min) it is refused.
  assert.doesNotThrow(() => buildT04AcceptedUserActivityEvent(startedAt("2026-09-01T08:00:01.000Z")));
  assert.throws(() => buildT04AcceptedUserActivityEvent(startedAt("2026-09-01T08:02:01.000Z")), /T04_OWNER_ACTIVITY_TIME_INVALID/u);
});

function durableRecord(event: T04AcceptedUserActivityOwnerEvent): AcceptedActivityRecord {
  return {
    cursor: "1",
    eventId: "01900000-0000-7000-8000-000000000010",
    eventType: "realtime.t04.accepted_user_activity.v1",
    eventVersion: 1,
    activityId: event.activity.activityId,
    userId: event.activity.userId,
    deviceId: event.activity.deviceId,
    continuityId: event.activity.continuityId,
    realtimeSessionRef: event.activity.realtimeSessionRef,
    sessionObjectVersion: "1",
    sessionPayloadSha256: "c".repeat(64),
    deviceLeaseRef: LEASE_REF,
    leaseObjectVersion: "1",
    leasePayloadSha256: "d".repeat(64),
    requestScope: "activity_renewal",
    idempotencyKey: event.activity.activityId,
    requestFingerprint: "e".repeat(64),
    occurredAt: event.activity.occurredAt,
    acceptedAt: event.activity.occurredAt,
    acceptanceRef: event.activity.acceptanceRef,
    authorityWatermark: event.authorityProjection.authorityWatermark,
    connectionEpoch: "1",
    sessionRevision: "1",
    outboxPayload: {
      activityId: event.activity.activityId,
      continuityId: event.activity.continuityId,
      acceptanceRef: event.activity.acceptanceRef,
      authorityWatermark: event.authorityProjection.authorityWatermark,
      actionReceipt: event.actionReceipt,
      currentBinding: event.currentBinding,
      authorityProjection: event.authorityProjection,
    },
    outboxPayloadSha256: "f".repeat(64),
    actionReceipt: event.actionReceipt,
    currentBinding: event.currentBinding,
    authorityProjection: event.authorityProjection,
  };
}

function ownerHarness() {
  let stored: AcceptedActivityRecord | undefined;
  let writes = 0;
  let binds = 0;
  let writerClosed = 0;
  let sourceClosed = 0;
  let sourceConsumer: ((event: T04AcceptedUserActivityOwnerEvent) => Promise<unknown>) | undefined;
  const source = {
    owner: "T02.accepted-activity-stream",
    environment: "production" as const,
    isReady: () => true,
    subscribe: (consumer: (event: T04AcceptedUserActivityOwnerEvent) => Promise<unknown>) => {
      sourceConsumer = consumer;
      return () => undefined;
    },
    close: () => { sourceClosed += 1; },
  };
  const writer: T04DurableOwnerWriter = {
    bind: () => { binds += 1; },
    readiness: () => ({ ready: true }),
    write: async (event) => {
      writes += 1;
      stored = durableRecord(event);
      return { state: "active" };
    },
    readByIdempotency: async () => stored,
    close: () => { writerClosed += 1; },
  };
  const owner = createRealtimePublicControlT04Owner({
    activityAcceptance: {
      verify: async (activity) => ({
        verified: true as const,
        acceptanceRef: activity.acceptanceRef,
        acceptedAt: activity.occurredAt,
        authorityWatermark: "owner-watermark",
      }),
    },
    source,
    writer,
    readCurrentBinding: async () => input().currentBinding,
    now: () => NOW,
  });
  return { owner, source, writer, getSourceConsumer: () => sourceConsumer, counts: () => ({ writes, binds, writerClosed, sourceClosed }) };
}

test("production owner persists one event and confirms only the durable record", async () => {
  const h = ownerHarness();
  await h.owner.preflight();
  await h.owner.onBootstrapConnected({
    request: input().request,
    bearer: input().bearer,
    governance: input().governance,
    authority: input().authority,
  } as T04AcceptedUserActivityEventInput);
  assert.deepEqual(h.owner.activityAcceptance.readiness, {
    owner: "T04.accepted-user-activity",
    environment: "production",
    isReady: h.owner.activityAcceptance.readiness.isReady,
    reason: "T04_OWNER_NOT_READY",
  });
  assert.equal(h.counts().binds, 1);
  assert.equal(h.counts().writes, 1);
  await h.owner.onBootstrapConnected({
    request: input().request,
    bearer: input().bearer,
    governance: input().governance,
    authority: input().authority,
  });
  assert.equal(h.counts().writes, 1);
});

test("recordUserAction writes typed and audio actions from fresh owner context and replays without duplicates", async () => {
  const records = new Map<string, AcceptedActivityRecord>();
  const reads: unknown[] = [];
  let writes = 0;
  const owner = createRealtimePublicControlT04Owner({
    activityAcceptance: {
      verify: async (activity) => ({
        verified: true as const,
        acceptanceRef: activity.acceptanceRef,
        acceptedAt: activity.occurredAt,
        authorityWatermark: "owner-watermark",
      }),
    },
    source: {
      owner: "T02.accepted-activity-stream", environment: "production" as const, isReady: () => true,
      subscribe: () => () => undefined,
    },
    writer: {
      bind: () => undefined,
      readiness: () => ({ ready: true }),
      write: async (event) => { writes += 1; records.set(event.activity.activityId, durableRecord(event)); },
      readByIdempotency: async (idempotencyKey) => records.get(idempotencyKey),
      close: async () => undefined,
    },
    readCurrentBinding: async (hookInput) => {
      reads.push(hookInput.authority.realtime_session_ref);
      return input().currentBinding;
    },
    now: () => NOW,
  });
  const start = input();
  await owner.onBootstrapConnected({ request: start.request, bearer: start.bearer, governance: start.governance, authority: start.authority });
  await owner.recordUserAction({ action: "button_submit", activityId: "typed-action-1" });
  await owner.recordUserAction({ action: "explicit_voice_command", activityId: "rayneo_segment_audio-1", occurredAt: "2026-09-01T07:59:40.000Z" as never });
  assert.equal(writes, 3);
  assert.equal(records.get("typed-action-1")?.actionReceipt?.action, "button_submit");
  assert.equal(records.get("rayneo_segment_audio-1")?.actionReceipt?.action, "explicit_voice_command");
  await owner.recordUserAction({ action: "button_submit", activityId: "typed-action-1" });
  await owner.recordUserAction({ action: "explicit_voice_command", activityId: "rayneo_segment_audio-1", occurredAt: "2026-09-01T07:59:40.000Z" as never });
  assert.equal(writes, 3);
  assert.equal(reads.length, 5);
  await owner.close();
  await assert.rejects(owner.recordUserAction({ action: "button_submit", activityId: "late-action" }), /T04_OWNER_CLOSED/u);
});

test("source is production-only durable replay and close fences all methods", async () => {
  const h = ownerHarness();
  await h.owner.preflight();
  let delivered = 0;
  const release = h.owner.source.subscribe(async () => { delivered += 1; return {} as never; });
  const event = buildT04AcceptedUserActivityEvent(input());
  await h.getSourceConsumer()?.(event);
  assert.equal(delivered, 1);
  release();
  await Promise.all([h.owner.close(), h.owner.close()]);
  assert.equal(h.counts().writerClosed, 1);
  assert.equal(h.counts().sourceClosed, 0);
  assert.equal(h.owner.activityAcceptance.readiness.isReady(), false);
  assert.throws(() => h.owner.preflight(), /T04_OWNER_CLOSED/u);
  await assert.rejects(h.owner.onBootstrapConnected({
    request: input().request,
    bearer: input().bearer,
    governance: input().governance,
    authority: input().authority,
  }), /T04_OWNER_CLOSED/u);
});

test("durable replay drift and unconfirmed commit fail closed", async () => {
  const h = ownerHarness();
  await h.owner.onBootstrapConnected({
    request: input().request,
    bearer: input().bearer,
    governance: input().governance,
    authority: input().authority,
  });
  const driftBase = input();
  await assert.rejects(h.owner.onBootstrapConnected({
    request: { ...driftBase.request, request_id: "request-2" },
    bearer: driftBase.bearer,
    governance: driftBase.governance,
    authority: driftBase.authority,
  }), /T04_OWNER_REPLAY_CONFLICT/u);
});

// Persistence is an in-memory seam; writer, activity bridge, and renewal are real.
test("renewed authoritative deadline admits the next action while stale identity and expiry remain fenced", async () => {
  const start = input();
  const initial = start.currentBinding as { session: RealtimeSessionRecord; lease: Record<string, unknown> };
  let session = initial.session;
  let clock = NOW;
  const records = new Map<string, AcceptedActivityRecord>();
  const writer = createRealtimePublicControlT04OwnerWriter({
    pool: { connect: async () => { throw new Error("unexpected database access"); } },
    stream: { readByIdempotency: async (key: string) => records.get(key) } as never,
    now: () => clock,
    service: {
      recordAcceptedUserActivity: async (activity, evidence) => {
        const renewed = applyAcceptedUserActivityRenewal(session, activity, {
          verified: true, acceptanceRef: activity.acceptanceRef, acceptedAt: activity.occurredAt, authorityWatermark: "test-watermark",
        }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
        session = renewed.session;
        records.set(activity.activityId, durableRecord({ activity, ...evidence! } as T04AcceptedUserActivityOwnerEvent));
        return session;
      },
    },
  });
  const owner = createRealtimePublicControlT04Owner({
    writer, now: () => clock,
    source: { owner: "T02.accepted-activity-stream", environment: "production", isReady: () => true, subscribe: () => () => undefined },
    activityAcceptance: { verify: async (activity) => ({ verified: true, acceptanceRef: activity.acceptanceRef, acceptedAt: activity.occurredAt, authorityWatermark: "test-watermark" }) },
    readCurrentBinding: async () => ({ session, lease: initial.lease }),
  });
  await owner.onBootstrapConnected(start);
  assert.ok(Date.parse(session.continuityExpiresAt) > Date.parse(start.authority.continuity_expires_at));
  await owner.recordUserAction({ action: "button_submit", activityId: "second-activity" });
  clock += 1_000;
  await owner.recordUserAction({ action: "explicit_voice_command", activityId: "third-activity" });
  assert.equal(records.size, 3);
  session = { ...session, connectionEpoch: assertDecimalConnectionEpoch("2"), binding: { ...session.binding!, connectionEpoch: assertDecimalConnectionEpoch("2") } };
  await assert.rejects(owner.recordUserAction({ action: "button_submit", activityId: "stale-epoch" }), /T04_OWNER_BINDING_AUTHORITY_MISMATCH/u);
  session = { ...session, connectionEpoch: assertDecimalConnectionEpoch("1"), binding: { ...session.binding!, connectionEpoch: assertDecimalConnectionEpoch("1") } };
  clock = Date.parse(String(initial.lease.expiresAt));
  await assert.rejects(owner.recordUserAction({ action: "button_submit", activityId: "expired-lease" }), /T04_OWNER_BINDING_EXPIRED/u);
  await owner.close();
});
