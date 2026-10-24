import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeSessionService, type RealtimeAcceptedUserActivityOwnerEvent } from "../src/realtime-session-service.ts";
import type { RealtimeAuthorityPorts, RealtimeAuthorityRepository, RealtimeAuthorityTransaction } from "../src/ports.ts";
import type { DeviceLeaseRecord, HandoffFactRecord, IdempotencyRecord, OpaqueCanonicalRef, OutboxEvent, RealtimeSessionRecord, RealtimeTransportBinding } from "../src/types.ts";
import { assertCanonicalTimestamp, assertDecimalConnectionEpoch, assertDecimalCounter } from "../src/types.ts";

class Repository implements RealtimeAuthorityRepository, RealtimeAuthorityTransaction {
  readonly sessions = new Map<string, RealtimeSessionRecord>();
  readonly leases = new Map<string, DeviceLeaseRecord>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly outbox: OutboxEvent[] = [];
  readonly outboxRefs = new Map<string, OpaqueCanonicalRef>();
  readonly handoffFacts: HandoffFactRecord[] = [];
  ownerAppendFailure = false;
  async transaction<T>(_operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
    const sessions = new Map(this.sessions);
    const leases = new Map(this.leases);
    const idempotency = new Map(this.idempotency);
    const outbox = [...this.outbox];
    const outboxRefs = new Map(this.outboxRefs);
    const handoffFacts = [...this.handoffFacts];
    try {
      return await work(this);
    } catch (error) {
      this.sessions.clear();
      for (const [key, value] of sessions) this.sessions.set(key, value);
      this.leases.clear();
      for (const [key, value] of leases) this.leases.set(key, value);
      this.idempotency.clear();
      for (const [key, value] of idempotency) this.idempotency.set(key, value);
      this.outbox.splice(0, this.outbox.length, ...outbox);
      this.outboxRefs.clear();
      for (const [key, value] of outboxRefs) this.outboxRefs.set(key, value);
      this.handoffFacts.splice(0, this.handoffFacts.length, ...handoffFacts);
      throw error;
    }
  }
  async readSession(ref: OpaqueCanonicalRef) { return this.sessions.get(String(ref)); }
  async readSessionByContinuityId(id: string) { return [...this.sessions.values()].find((value) => value.continuityId === id); }
  async readLease(ref: OpaqueCanonicalRef) { return this.leases.get(String(ref)); }
  async readActiveDeviceSessions(input: { readonly userId: string; readonly deviceId: string; readonly purpose: string }) {
    return [...this.sessions.values()]
      .filter((session) => session.userId === input.userId && session.activeDeviceId === input.deviceId && session.state === "active" && session.continuityState === "active")
      .map((session) => ({ session, lease: [...this.leases.values()].find((value) => String(value.deviceLeaseRef) === String(session.activeDeviceLeaseRef))! }))
      .filter((held) => held.lease?.purpose === input.purpose);
  }
  async readCurrentBinding(lookup: { readonly realtimeSessionRef?: OpaqueCanonicalRef; readonly continuityId?: string }) {
    const candidates = lookup.realtimeSessionRef !== undefined
      ? [...this.sessions.values()].filter((value) => String(value.realtimeSessionRef) === String(lookup.realtimeSessionRef))
      : [...this.sessions.values()].filter((value) => value.continuityId === lookup.continuityId && value.state === "active" && value.continuityState === "active");
    if (candidates.length > 1) throw new Error("REALTIME_AUTHORITY_CONFLICT");
    const session = candidates[0];
    if (session === undefined) return undefined;
    const lease = [...this.leases.values()].find((value) => String(value.deviceLeaseRef) === String(session.activeDeviceLeaseRef));
    if (lease === undefined) throw new Error("REALTIME_AUTHORITY_CONFLICT");
    return { session, lease };
  }
  async readIdempotency(operation: string, key: string) { return this.idempotency.get(`${operation}:${key}`); }
  async writeSession(input: { readonly expectedRevision?: string; readonly record: RealtimeSessionRecord }) {
    const existing = this.sessions.get(String(input.record.realtimeSessionRef));
    if (input.expectedRevision !== undefined && existing?.revision !== input.expectedRevision) throw new Error("CURRENT_VERSION_CONFLICT");
    this.sessions.set(String(input.record.realtimeSessionRef), input.record);
  }
  async writeLease(input: { readonly expectedLeaseVersion?: string; readonly record: DeviceLeaseRecord }) {
    const existing = this.leases.get(String(input.record.deviceLeaseRef));
    if (input.expectedLeaseVersion !== undefined && existing?.leaseVersion !== input.expectedLeaseVersion) throw new Error("LEASE_VERSION_CONFLICT");
    this.leases.set(String(input.record.deviceLeaseRef), input.record);
  }
  async writeBinding(_input: { readonly expectedConnectionEpoch?: string; readonly binding: RealtimeTransportBinding }) {}
  async recordHandoffFact(record: HandoffFactRecord) { this.handoffFacts.push(record); }
  async writeIdempotency(record: IdempotencyRecord) { this.idempotency.set(`${record.operation}:${record.idempotencyKey}`, record); }
  async appendOutbox(event: OutboxEvent): Promise<OpaqueCanonicalRef> {
    if (event.eventType === "realtime.t04.accepted_user_activity.v1" && this.ownerAppendFailure) {
      throw new Error("T04_OWNER_APPEND_FAILED");
    }
    const key = `${event.idempotencyKey}:${event.eventType}`;
    const existingRef = this.outboxRefs.get(key);
    if (existingRef !== undefined) {
      const existing = this.outbox.find((candidate) => candidate.idempotencyKey === event.idempotencyKey && candidate.eventType === event.eventType);
      if (existing === undefined || JSON.stringify(existing.aggregateRef) !== JSON.stringify(event.aggregateRef) ||
          JSON.stringify(existing.payload) !== JSON.stringify(event.payload) || existing.occurredAt !== event.occurredAt) {
        throw new Error("REALTIME_AUTHORITY_CONFLICT");
      }
      return existingRef;
    }
    this.outbox.push(event);
    const ref = `outbox-${this.outbox.length}`;
    this.outboxRefs.set(key, ref);
    return ref;
  }
}

function ports(repository: Repository): RealtimeAuthorityPorts {
  return {
    repository,
    policy: { async evaluate() { return { allowed: true as const, policyDecisionRef: "policy-1", capabilities: ["audio.publish"], purpose: "conversation", leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"), revocable: true as const }; } },
    activityAcceptance: { async verify(activity) { return { verified: true, acceptanceRef: activity.acceptanceRef, acceptedAt: activity.occurredAt, authorityWatermark: "watermark-1" }; } },
    transportDisconnection: { async verify(input) { return { verified: true, disconnectedAt: input.occurredAt, authorityProof: "disconnect-proof-1" }; } },
    identity: {
      createContinuityId: ({ requestId }) => `continuity-${requestId}`,
      assertRepositoryIssuedRef: () => {},
      createSessionRef: ({ requestId }) => `session-ref-${requestId}`,
      createDeviceLeaseRef: ({ deviceId, requestId }) => `lease-ref-${deviceId}-${requestId}`,
      createTransportAlias: ({ deviceId, connectionEpoch, requestId }) => `alias-${deviceId}-${connectionEpoch}-${requestId}`,
      createConnectionId: ({ deviceId, requestId }) => `connection-${deviceId}-${requestId}`,
    },
    clock: { now: () => assertCanonicalTimestamp("2026-08-23T12:45:00.000Z") },
    equality: { key: (value) => String(value), same: Object.is },
  };
}

function structuralAcceptancePorts(repository: Repository, mismatch = false): RealtimeAuthorityPorts {
  const base = ports(repository);
  const ownerKey = (value: unknown): string => typeof value === "string"
    ? `string:${value}`
    : `json:${JSON.stringify(value) ?? "undefined"}`;
  return {
    ...base,
    activityAcceptance: {
      async verify(activity) {
        const source = activity.acceptanceRef;
        const acceptanceRef = typeof source === "string"
          ? source
          : { ...source, ...(mismatch ? { version: 99 } : {}) };
        return {
          verified: true as const,
          acceptanceRef,
          acceptedAt: activity.occurredAt,
          authorityWatermark: "watermark-structural",
        };
      },
    },
    equality: {
      key: ownerKey,
      same: (left, right) => ownerKey(left) === ownerKey(right),
    },
  };
}

function objectRefPorts(repository: Repository): RealtimeAuthorityPorts {
  const base = ports(repository);
  const ownerKey = (value: unknown): string => typeof value === "string"
    ? `string:${value}`
    : `json:${JSON.stringify(value) ?? "undefined"}`;
  return {
    ...base,
    identity: {
      ...base.identity,
      createSessionRef: ({ requestId }) => ({
        kind: "RealtimeSession",
        id: `session-${requestId}`,
        object_version: "1",
        canonical_payload_sha256: "session-hash-1",
      }),
      createDeviceLeaseRef: ({ deviceId, requestId }) => ({
        kind: "DeviceLease",
        id: `lease-${deviceId}-${requestId}`,
        object_version: "1",
        canonical_payload_sha256: "lease-hash-1",
      }),
    },
    equality: {
      key: ownerKey,
      same: (left, right) => ownerKey(left) === ownerKey(right),
    },
  };
}

function ownerEvent(variant = "one"): RealtimeAcceptedUserActivityOwnerEvent {
  return {
    actionReceipt: { kind: "t04.accepted_user_action_receipt", variant },
    currentBinding: { state: "active", variant },
    authorityProjection: { kind: "t04.activity_authority_projection", variant, authorityWatermark: { kind: "t04.authority_watermark", value: variant } },
  };
}

test("authority service composes accepted activity, handoff, and Stop through one transaction port", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap({
    requestId: "start-1",
    idempotencyKey: "start-idem-1",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const renewed = await service.recordAcceptedUserActivity({
    activityId: "activity-1",
    kind: "accepted_user_activity",
    accepted: true,
    userId: "user-1",
    deviceId: "device-1",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:30:00.000Z"),
    acceptanceRef: "acceptance-1",
  });
  assert.ok(started.receipt.outboxEventRef);
  assert.equal(renewed.continuityExpiresAt, "2026-08-24T12:30:00.000Z");
  const handed = await service.handoff({
    requestId: "handoff-1",
    idempotencyKey: "handoff-idem-1",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    fromDeviceId: "device-1",
    toDeviceId: "device-2",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:31:00.000Z"),
    governance: "governance-1",
  });
  assert.equal(handed.activeDeviceId, "device-2");
  assert.ok(handed.receipt.outboxEventRef);
  assert.equal(repository.handoffFacts.length, 1);
  const handoffFact = repository.handoffFacts[0];
  assert.ok(handoffFact);
  assert.equal(handoffFact.requestId, "handoff-1");
  assert.equal(handoffFact.idempotencyKey, "handoff-idem-1");
  assert.equal(typeof handoffFact.requestFingerprint, "string");
  assert.deepEqual(handoffFact.realtimeSessionRef, started.realtimeSessionRef);
  assert.equal(handoffFact.continuityId, started.continuityId);
  assert.equal(handoffFact.fromDeviceId, "device-1");
  assert.equal(handoffFact.toDeviceId, "device-2");
  assert.equal(handoffFact.connectionEpoch, "1");
  assert.deepEqual(handoffFact.oldLeaseRef, started.deviceLeaseRef);
  assert.equal(handoffFact.expectedLeaseVersion, "1");
  assert.equal(handoffFact.releasedLeaseVersion, "2");
  assert.equal(handoffFact.releasedFencingToken, "2");
  assert.deepEqual(handoffFact.newLeaseRef, handed.activeDeviceLeaseRef);
  assert.equal(handoffFact.newLeaseVersion, handed.leaseVersion);
  assert.equal(handoffFact.newFencingToken, handed.fencingToken);
  assert.equal(handoffFact.suppressedDeviceId, "device-1");
  assert.deepEqual(handoffFact.outboxEventRef, handed.receipt.outboxEventRef);
  assert.equal(handoffFact.occurredAt, "2026-08-23T12:31:00.000Z");
  const handedReplay = await service.handoff({
    requestId: "handoff-1",
    idempotencyKey: "handoff-idem-1",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    fromDeviceId: "device-1",
    toDeviceId: "device-2",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:31:00.000Z"),
    governance: "governance-1",
  });
  assert.equal(handedReplay.receipt.replayed, true);
  assert.equal(repository.handoffFacts.length, 1);
  const stopped = await service.stop({
    requestId: "stop-1",
    idempotencyKey: "stop-idem-1",
    operation: "media_stop",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    deviceLeaseRef: handed.activeDeviceLeaseRef,
    deviceId: "device-2",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: handed.leaseVersion,
    reason: "user_stop",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:32:00.000Z"),
    governance: "governance-1",
  });
  assert.equal(stopped.status, "success");
  assert.ok(stopped.outboxEventRef);
  assert.equal(repository.outbox.length, 4);
  const stoppedSession = repository.sessions.get(String(started.realtimeSessionRef));
  assert.ok(stoppedSession);
  assert.equal(stoppedSession.binding.state, "released");
  assert.equal(stoppedSession.continuityId, started.continuityId);
  assert.equal(stoppedSession.connectionEpoch, "1");
  await assert.rejects(
    () => service.refresh({
      requestId: "refresh-after-stop",
      idempotencyKey: "refresh-after-stop-idem",
      binding: stoppedSession.binding,
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:33:00.000Z"),
      governance: "governance-1",
    }),
    /TRANSPORT_NOT_CONNECTED/,
  );
  assert.equal(repository.outbox.length, 4);
  await assert.rejects(
    () => service.stop({
      requestId: "stop-again",
      idempotencyKey: "stop-again-idem",
      operation: "media_stop",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId: started.continuityId,
      deviceLeaseRef: handed.activeDeviceLeaseRef,
      deviceId: "device-2",
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: handed.leaseVersion,
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:33:00.000Z"),
      governance: "governance-1",
    }),
    /MEDIA_LEASE_NOT_ACTIVE/,
  );
  assert.equal(repository.outbox.length, 4);
  const releasedLease = repository.leases.get(String(handed.activeDeviceLeaseRef));
  assert.ok(releasedLease);
  const ended = await service.stop({
    requestId: "end-1",
    idempotencyKey: "end-1-idem",
    operation: "end_continuity",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    deviceLeaseRef: handed.activeDeviceLeaseRef,
    deviceId: "device-2",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: releasedLease.leaseVersion,
    reason: "user_stop",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:34:00.000Z"),
    governance: "governance-1",
  });
  assert.equal(ended.status, "success");
  assert.equal(repository.outbox.length, 5);
  const endedSession = repository.sessions.get(String(started.realtimeSessionRef));
  assert.ok(endedSession);
  assert.equal(endedSession.state, "terminal");
  assert.equal(endedSession.continuityState, "ended");
  assert.equal(endedSession.binding.state, "released");
  assert.equal(repository.leases.get(String(handed.activeDeviceLeaseRef))?.state, "released");
  await assert.rejects(
    () => service.stop({
      requestId: "end-again",
      idempotencyKey: "end-again-idem",
      operation: "end_continuity",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId: started.continuityId,
      deviceLeaseRef: handed.activeDeviceLeaseRef,
      deviceId: "device-2",
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: releasedLease.leaseVersion,
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:35:00.000Z"),
      governance: "governance-1",
    }),
    /CONTINUITY_ALREADY_ENDED/,
  );
  assert.equal(repository.outbox.length, 5);
});

test("accepted activity owner event appends once, conflicts on drift, and preserves legacy calls", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap({
    requestId: "owner-event-start",
    idempotencyKey: "owner-event-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const accepted = {
    activityId: "owner-event-activity",
    kind: "accepted_user_activity" as const,
    accepted: true as const,
    userId: "user-1",
    deviceId: "device-1",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:30:00.000Z"),
    acceptanceRef: "acceptance-owner-event",
  };
  const exactEvent = ownerEvent();
  const renewed = await service.recordAcceptedUserActivity(accepted, exactEvent);
  assert.equal(repository.outbox.filter((event) => event.eventType === "realtime.t04.accepted_user_activity.v1").length, 1);
  const eventRefCount = repository.outbox.length;
  const sessionAfterRenewal = repository.sessions.get(String(started.realtimeSessionRef));
  assert.ok(sessionAfterRenewal);
  const idemAfterRenewal = repository.idempotency.get(`activity_renewal:${accepted.activityId}`);
  assert.ok(idemAfterRenewal);
  const replayed = await service.recordAcceptedUserActivity(structuredClone(accepted), structuredClone(exactEvent));
  assert.equal(replayed.revision, renewed.revision);
  assert.equal(repository.outbox.length, eventRefCount);
  await assert.rejects(
    () => service.recordAcceptedUserActivity(accepted, ownerEvent("changed")),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(repository.outbox.length, eventRefCount);
  assert.equal(repository.sessions.get(String(started.realtimeSessionRef))?.revision, sessionAfterRenewal.revision);
  assert.equal(repository.idempotency.get(`activity_renewal:${accepted.activityId}`), idemAfterRenewal);

  const rollbackActivity = {
    ...accepted,
    activityId: "owner-event-rollback",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:40:00.000Z"),
  };
  const beforeRollback = {
    outbox: repository.outbox.length,
    revision: repository.sessions.get(String(started.realtimeSessionRef))?.revision,
    idempotency: repository.idempotency.size,
  };
  repository.ownerAppendFailure = true;
  await assert.rejects(
    () => service.recordAcceptedUserActivity(rollbackActivity, ownerEvent("rollback")),
    /T04_OWNER_APPEND_FAILED/,
  );
  repository.ownerAppendFailure = false;
  assert.equal(repository.outbox.length, beforeRollback.outbox);
  assert.equal(repository.sessions.get(String(started.realtimeSessionRef))?.revision, beforeRollback.revision);
  assert.equal(repository.idempotency.size, beforeRollback.idempotency);
  await service.recordAcceptedUserActivity(rollbackActivity);
  assert.equal(repository.outbox.filter((event) => event.eventType === "realtime.t04.accepted_user_activity.v1").length, 1);
  assert.equal(repository.outbox.filter((event) => event.eventType === "realtime.continuity.renewed").length, 2);
});

test("equal last-activity time records one durable T04 event without renewal and replays without a duplicate", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap({
    requestId: "equal-start",
    idempotencyKey: "equal-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const activity = {
    activityId: "equal-activity",
    kind: "accepted_user_activity" as const,
    accepted: true as const,
    userId: "user-1",
    deviceId: "device-1",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    acceptanceRef: "equal-acceptance",
  };
  const event = ownerEvent("equal");
  const beforeRevision = repository.sessions.get(String(started.realtimeSessionRef))?.revision;
  await service.recordAcceptedUserActivity(activity, event);
  assert.equal(repository.sessions.get(String(started.realtimeSessionRef))?.revision, beforeRevision);
  assert.equal(repository.outbox.filter((item) => item.eventType === "realtime.t04.accepted_user_activity.v1").length, 1);
  assert.equal(repository.outbox.filter((item) => item.eventType === "realtime.continuity.renewed").length, 0);
  const outboxCount = repository.outbox.length;
  await service.recordAcceptedUserActivity(structuredClone(activity), structuredClone(event));
  assert.equal(repository.outbox.length, outboxCount);
});

test("a device clock a few seconds ahead of the server still starts; the lead stays bounded", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(ports(repository));
  // Server clock is 12:45:00.000Z; the phone's clock reads 2.7 s later.
  const started = await service.bootstrap({
    requestId: "lead-start",
    idempotencyKey: "lead-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:45:02.700Z"),
    governance: "governance-1",
  });
  assert.ok(started);
  assert.equal(repository.sessions.size, 1);
});

test("control commands reject future occurredAt without creating authority state", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(ports(repository));
  await assert.rejects(
    () => service.bootstrap({
      requestId: "future-start",
      idempotencyKey: "future-start-idem",
      mode: "initial",
      userId: "user-1",
      deviceId: "device-1",
      capabilities: ["audio.publish"],
      purpose: "conversation",
      occurredAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
      governance: "governance-1",
    }),
    /CONTROL_TIME_UNTRUSTED/,
  );
  assert.equal(repository.outbox.length, 0);
  assert.equal(repository.sessions.size, 0);
});

test("fresh handoff and Stop reject canonical ref drift and stale epochs without mutation", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(objectRefPorts(repository));
  const started = await service.bootstrap({
    requestId: "fresh-ref-start",
    idempotencyKey: "fresh-ref-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const sessionRefDrift = { ...started.realtimeSessionRef as Record<string, unknown>, object_version: "2" };
  await assert.rejects(
    () => service.handoff({
      requestId: "fresh-ref-handoff",
      idempotencyKey: "fresh-ref-handoff-idem",
      realtimeSessionRef: sessionRefDrift,
      continuityId: started.continuityId,
      fromDeviceId: "device-1",
      toDeviceId: "device-2",
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: assertDecimalCounter("1"),
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:01:00.000Z"),
      governance: "governance-1",
    }),
    /HANDOFF_BINDING_INVALID/,
  );
  assert.equal(repository.outbox.length, 1);
  assert.equal(repository.handoffFacts.length, 0);
  await assert.rejects(
    () => service.handoff({
      requestId: "fresh-stale-handoff",
      idempotencyKey: "fresh-stale-handoff-idem",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId: started.continuityId,
      fromDeviceId: "device-1",
      toDeviceId: "device-2",
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: assertDecimalCounter("2"),
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:01:30.000Z"),
      governance: "governance-1",
    }),
    /STALE_ACTIVE_DEVICE_LEASE/,
  );
  assert.equal(repository.outbox.length, 1);
  assert.equal(repository.handoffFacts.length, 0);
  const leaseRefDrift = { ...started.deviceLeaseRef as Record<string, unknown>, canonical_payload_sha256: "lease-hash-drift" };
  await assert.rejects(
    () => service.stop({
      requestId: "fresh-ref-stop",
      idempotencyKey: "fresh-ref-stop-idem",
      operation: "media_stop",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId: started.continuityId,
      deviceLeaseRef: leaseRefDrift,
      deviceId: "device-1",
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: assertDecimalCounter("1"),
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:02:00.000Z"),
      governance: "governance-1",
    }),
    /STOP_LEASE_BINDING_INVALID/,
  );
  assert.equal(repository.outbox.length, 1);
  await assert.rejects(
    () => service.stop({
      requestId: "fresh-epoch-stop",
      idempotencyKey: "fresh-epoch-stop-idem",
      operation: "media_stop",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId: started.continuityId,
      deviceLeaseRef: started.deviceLeaseRef,
      deviceId: "device-1",
      expectedConnectionEpoch: assertDecimalConnectionEpoch("2"),
      expectedLeaseVersion: assertDecimalCounter("1"),
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:03:00.000Z"),
      governance: "governance-1",
    }),
    /CONNECTION_EPOCH_CONFLICT/,
  );
  assert.equal(repository.outbox.length, 1);
  assert.equal(repository.sessions.get(String(started.realtimeSessionRef))?.revision, "1");
  assert.equal(repository.leases.get(String(started.deviceLeaseRef))?.state, "active");
});

test("owner equality accepts structurally identical acceptance refs from separate instances", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(structuralAcceptancePorts(repository));
  const started = await service.bootstrap({
    requestId: "structural-start",
    idempotencyKey: "structural-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const activity = {
    activityId: "structural-activity",
    kind: "accepted_user_activity",
    accepted: true,
    userId: "user-1",
    deviceId: "device-1",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:30:00.000Z"),
    acceptanceRef: { source: "t04", id: "acceptance-1", version: 1 },
  } as const;
  const renewed = await service.recordAcceptedUserActivity(activity);
  const replayed = await new RealtimeSessionService(structuralAcceptancePorts(repository))
    .recordAcceptedUserActivity(activity);
  assert.equal(renewed.continuityExpiresAt, "2026-08-24T12:30:00.000Z");
  assert.equal(replayed.continuityExpiresAt, renewed.continuityExpiresAt);
});

test("owner equality rejects structurally different acceptance refs closed", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(structuralAcceptancePorts(repository, true));
  const started = await service.bootstrap({
    requestId: "structural-mismatch-start",
    idempotencyKey: "structural-mismatch-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  await assert.rejects(
    () => service.recordAcceptedUserActivity({
      activityId: "structural-mismatch-activity",
      kind: "accepted_user_activity",
      accepted: true,
      userId: "user-1",
      deviceId: "device-1",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId: started.continuityId,
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:30:00.000Z"),
      acceptanceRef: { source: "t04", id: "acceptance-1", version: 1 },
    }),
    /ACTIVITY_ACCEPTANCE_MISMATCH/,
  );
});

test("T11B current-binding projection follows connected, released, and ended facts without reviving replay", async () => {
  const repository = new Repository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap({
    requestId: "current-binding-start",
    idempotencyKey: "current-binding-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  await assert.rejects(
    () => service.bootstrap({
      requestId: "current-binding-initial-takeover",
      idempotencyKey: "current-binding-initial-takeover-idem",
      mode: "initial",
      userId: "user-1",
      deviceId: "device-1",
      continuityId: started.continuityId,
      existingSessionRef: started.realtimeSessionRef,
      existingBinding: started.binding,
      capabilities: ["audio.publish"],
      purpose: "conversation",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
      governance: "governance-1",
    }),
    /INITIAL_CONTINUITY_TAKEOVER_FORBIDDEN/,
  );
  const currentByContinuityBeforeStop = await service.readCurrentBinding({ continuityId: started.continuityId });
  assert.ok(currentByContinuityBeforeStop);
  assert.equal(currentByContinuityBeforeStop.session.binding.state, "connected");

  const stopRequest = {
    requestId: "current-binding-stop",
    idempotencyKey: "current-binding-stop-idem",
    operation: "media_stop" as const,
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    deviceLeaseRef: started.deviceLeaseRef,
    deviceId: "device-1",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
    reason: "user_stop" as const,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:01:00.000Z"),
    governance: "governance-1",
  };
  await service.stop(stopRequest);
  const released = await service.readCurrentBinding({ realtimeSessionRef: started.realtimeSessionRef });
  assert.ok(released);
  assert.equal(released.session.binding.state, "released");
  assert.equal(released.lease.state, "released");

  await service.stop(stopRequest);
  const replayAfterStop = await service.readCurrentBinding({ realtimeSessionRef: started.realtimeSessionRef });
  assert.ok(replayAfterStop);
  assert.equal(replayAfterStop.session.binding.state, "released");
  assert.equal(replayAfterStop.lease.state, "released");

  const ended = await service.stop({
    ...stopRequest,
    requestId: "current-binding-end",
    idempotencyKey: "current-binding-end-idem",
    operation: "end_continuity",
    deviceLeaseRef: started.deviceLeaseRef,
    expectedLeaseVersion: assertDecimalCounter("2"),
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:02:00.000Z"),
  });
  assert.equal(ended.status, "success");
  const terminal = await service.readCurrentBinding({ realtimeSessionRef: started.realtimeSessionRef });
  assert.ok(terminal);
  assert.equal(terminal.session.state, "terminal");
  assert.equal(terminal.session.continuityState, "ended");
  assert.equal(terminal.session.binding.state, "released");
  assert.equal(terminal.lease.state, "released");
  assert.equal(await service.readCurrentBinding({ continuityId: started.continuityId }), undefined);
});
