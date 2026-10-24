import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeSessionService, type AppleCyclingRenewalRequest } from "../src/realtime-session-service.ts";
import type {
  RealtimeAuthorityRepository,
  RealtimeAuthorityTransaction,
  RealtimeAuthorityPorts,
} from "../src/ports.ts";
import type {
  DeviceLeaseRecord,
  HandoffFactRecord,
  IdempotencyRecord,
  OpaqueCanonicalRef,
  OutboxEvent,
  RealtimeSessionRecord,
  RealtimeTransportBinding,
} from "../src/types.ts";
import { assertCanonicalTimestamp, assertDecimalConnectionEpoch, assertDecimalCounter } from "../src/types.ts";

class FakeRepository implements RealtimeAuthorityRepository, RealtimeAuthorityTransaction {
  readonly sessions = new Map<string, RealtimeSessionRecord>();
  readonly leases = new Map<string, DeviceLeaseRecord>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly outbox: OutboxEvent[] = [];
  readonly handoffFacts: HandoffFactRecord[] = [];

  public async transaction<T>(_operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
    return work(this);
  }
  public async readSession(ref: OpaqueCanonicalRef): Promise<RealtimeSessionRecord | undefined> { return this.sessions.get(String(ref)); }
  public async readSessionByContinuityId(id: string): Promise<RealtimeSessionRecord | undefined> {
    return [...this.sessions.values()].find((value) => value.continuityId === id);
  }
  public async readLease(ref: OpaqueCanonicalRef): Promise<DeviceLeaseRecord | undefined> { return this.leases.get(String(ref)); }
  public async readActiveDeviceSessions(input: { readonly userId: string; readonly deviceId: string; readonly purpose: string }) {
    return [...this.sessions.values()]
      .filter((session) => session.userId === input.userId && session.activeDeviceId === input.deviceId && session.state === "active" && session.continuityState === "active")
      .map((session) => ({ session, lease: [...this.leases.values()].find((value) => String(value.deviceLeaseRef) === String(session.activeDeviceLeaseRef))! }))
      .filter((held) => held.lease?.purpose === input.purpose);
  }
  public async readCurrentBinding(lookup: { readonly realtimeSessionRef?: OpaqueCanonicalRef; readonly continuityId?: string }) {
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
  public async readIdempotency(operation: string, key: string): Promise<IdempotencyRecord | undefined> {
    return this.idempotency.get(`${operation}:${key}`);
  }
  public async writeSession(input: { readonly expectedRevision?: string; readonly record: RealtimeSessionRecord }): Promise<void> {
    if (input.expectedRevision !== undefined) {
      const existing = this.sessions.get(String(input.record.realtimeSessionRef));
      if (existing?.revision !== input.expectedRevision) throw new Error("CURRENT_VERSION_CONFLICT");
    }
    this.sessions.set(String(input.record.realtimeSessionRef), input.record);
  }
  public async writeLease(input: { readonly expectedLeaseVersion?: string; readonly record: DeviceLeaseRecord }): Promise<void> {
    if (input.expectedLeaseVersion !== undefined) {
      const existing = this.leases.get(String(input.record.deviceLeaseRef));
      if (existing?.leaseVersion !== input.expectedLeaseVersion) throw new Error("LEASE_VERSION_CONFLICT");
    }
    this.leases.set(String(input.record.deviceLeaseRef), input.record);
  }
  public async writeBinding(_input: { readonly expectedConnectionEpoch?: string; readonly binding: RealtimeTransportBinding }): Promise<void> {}
  public async recordHandoffFact(record: HandoffFactRecord): Promise<void> { this.handoffFacts.push(record); }
  public async writeIdempotency(record: IdempotencyRecord): Promise<void> { this.idempotency.set(`${record.operation}:${record.idempotencyKey}`, record); }
  public async appendOutbox(event: OutboxEvent): Promise<OpaqueCanonicalRef> { this.outbox.push(event); return `outbox-${this.outbox.length}`; }
}

function ports(repository: FakeRepository): RealtimeAuthorityPorts {
  const at = assertCanonicalTimestamp("2026-08-23T12:00:00.000Z");
  return {
    repository,
    policy: { async evaluate() { return { allowed: true, policyDecisionRef: "policy-1", capabilities: ["audio.publish"], purpose: "conversation", leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"), revocable: true }; } },
    activityAcceptance: { async verify(activity) { return { verified: true, acceptanceRef: activity.acceptanceRef, acceptedAt: activity.occurredAt, authorityWatermark: "watermark-1" }; } },
    transportDisconnection: { async verify(input) { return { verified: true, disconnectedAt: input.occurredAt, authorityProof: "disconnect-proof-1" }; } },
    identity: {
      createContinuityId: ({ requestId }) => `continuity-${requestId}`,
      assertRepositoryIssuedRef: () => {},
      createSessionRef: ({ requestId }) => `session-ref-${requestId}`,
      createDeviceLeaseRef: ({ deviceId }) => `lease-ref-${deviceId}-${Math.random()}`,
      createTransportAlias: ({ deviceId, connectionEpoch, requestId }) => `alias-${deviceId}-${connectionEpoch}-${requestId}`,
      createConnectionId: ({ deviceId, requestId }) => `connection-${deviceId}-${requestId}`,
    },
    clock: { now: () => at },
    equality: { key: (value) => String(value), same: Object.is },
  };
}

function request(idempotencyKey = "bootstrap-idem-1") {
  return {
    requestId: "bootstrap-request-1",
    idempotencyKey,
    mode: "initial" as const,
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  };
}

function renewalPorts(
  repository: FakeRepository,
  policyExpiresAt: string,
  nowAt = "2026-08-23T12:30:00.000Z",
): RealtimeAuthorityPorts {
  const base = ports(repository);
  return {
    ...base,
    clock: { now: () => assertCanonicalTimestamp(nowAt) },
    policy: {
      async evaluate(input) {
        const decision = await base.policy.evaluate(input);
        return { ...decision, leaseExpiresAt: assertCanonicalTimestamp(policyExpiresAt) };
      },
    },
  };
}

function renewalRequest(
  started: Awaited<ReturnType<RealtimeSessionService["bootstrap"]>>,
  overrides: Partial<AppleCyclingRenewalRequest> = {},
): AppleCyclingRenewalRequest {
  return {
    requestId: "apple-cycling-renewal-request-1",
    idempotencyKey: "apple-cycling-renewal-idempotency-1",
    realtimeSessionRef: started.realtimeSessionRef,
    deviceLeaseRef: started.deviceLeaseRef,
    continuityId: started.continuityId,
    deviceId: "device-1",
    expectedConnectionEpoch: "1",
    expectedLeaseVersion: "1",
    expectedFencingToken: "1",
    ttlSeconds: 86_400,
    governance: "governance-1",
    ...overrides,
  };
}

test("same idempotency key replays the stored authority result", async () => {
  const repository = new FakeRepository();
  const first = await new RealtimeSessionService(ports(repository)).bootstrap(request());
  const replay = await new RealtimeSessionService(ports(repository)).bootstrap(request());
  assert.equal(first.receipt.replayed, false);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(replay.realtimeSessionRef, first.realtimeSessionRef);
  assert.equal(repository.outbox.length, 1);
  await assert.rejects(() => new RealtimeSessionService(ports(repository)).bootstrap({ ...request(), requestId: "different-request" }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(assertDecimalConnectionEpoch(first.connectionEpoch), "1");
});

test("replay rejects an outer result whose binding disagrees with its receipt", async () => {
  const repository = new FakeRepository();
  const first = await new RealtimeSessionService(ports(repository)).bootstrap(request("tamper-idem-1"));
  const key = "bootstrap:tamper-idem-1";
  const stored = repository.idempotency.get(key);
  assert.ok(stored);
  const storedResult = stored.result as Record<string, unknown>;
  const storedBinding = storedResult.binding as Record<string, unknown>;
  repository.idempotency.set(key, {
    ...stored,
    result: {
      ...storedResult,
      binding: { ...storedBinding, connectionEpoch: "2" },
    },
  });
  assert.equal(first.receipt.connectionEpoch, "1");
  await assert.rejects(
    () => new RealtimeSessionService(ports(repository)).bootstrap(request("tamper-idem-1")),
    /MALFORMED_REPLAY_RECORD/,
  );
});

test("connected refresh replay cross-checks the binding and terminal receipt", async () => {
  const repository = new FakeRepository();
  const service = new RealtimeSessionService(ports(repository));
  const first = await service.bootstrap(request("refresh-bootstrap-idem"));
  const refreshRequest = {
    requestId: "refresh-request-1",
    idempotencyKey: "refresh-idem-1",
    binding: first.binding,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  };
  const refreshed = await service.refresh(refreshRequest);
  const replay = await new RealtimeSessionService(ports(repository)).refresh(refreshRequest);
  assert.equal(refreshed.receipt.status, "success");
  assert.ok(refreshed.receipt.outboxEventRef);
  assert.equal(replay.receipt.replayed, true);
});

// The gateway stamps a refresh with its own receive time (the wire carries none). A same-key retry, such as the
// iPhone's alternate-origin resend of a 503, is the same request and must replay, not answer IDEMPOTENCY_CONFLICT.
test("a connected refresh retried with the same key later replays instead of conflicting", async () => {
  const repository = new FakeRepository();
  const service = new RealtimeSessionService(ports(repository));
  const first = await service.bootstrap(request("refresh-retry-bootstrap-idem"));
  const refreshRequest = {
    requestId: "refresh-retry-request", idempotencyKey: "refresh-retry-idem", binding: first.binding,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"), governance: "governance-1",
  };
  const refreshed = await service.refresh(refreshRequest);
  const retry = await service.refresh({ ...refreshRequest, occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:01.400Z") });
  assert.equal(retry.receipt.replayed, true);
  assert.deepEqual(retry.receipt.outboxEventRef, refreshed.receipt.outboxEventRef);
  await assert.rejects(service.refresh({ ...refreshRequest, governance: "governance-2" }), /IDEMPOTENCY_CONFLICT/);
});

test("lease renewal uses exact T03 issuance, preserves 24h continuity and exact-replays", async () => {
  const repository = new FakeRepository();
  const started = await new RealtimeSessionService(ports(repository)).bootstrap(request("lease-bootstrap"));
  const before = repository.sessions.get(String(started.realtimeSessionRef));
  const service = new RealtimeSessionService(renewalPorts(repository, "2026-08-23T14:00:00.000Z"));
  const renewal = renewalRequest(started, { ttlSeconds: 7200 });
  const result = await service.renewAppleCycling(renewal);
  assert.equal(result.leaseExpiresAt, "2026-08-23T14:00:00.000Z");
  assert.equal(result.continuityExpiresAt, started.continuityExpiresAt);
  assert.equal(repository.sessions.get(String(started.realtimeSessionRef)), before);
  assert.equal(result.operation, "device_lease_renewal");
  assert.equal(result.receipt.operation, "device_lease_renewal");
  assert.equal(result.leaseVersion, "2"); assert.equal(result.fencingToken, "2");
  assert.deepEqual(result.binding, started.binding);
  assert.equal(repository.outbox[1]?.eventType, "realtime.device_lease.renewed.v1");
  assert.equal(repository.idempotency.has("activity_renewal:" + renewal.idempotencyKey), false);
  const replay = await new RealtimeSessionService(renewalPorts(repository, "2026-08-23T15:00:00.000Z")).renewAppleCycling(renewal);
  assert.equal(replay.receipt.replayed, true); assert.equal(replay.leaseExpiresAt, result.leaseExpiresAt);
  assert.equal(repository.outbox.length, 2);
  await assert.rejects(service.renewAppleCycling({ ...renewal, ttlSeconds: 2 }), /IDEMPOTENCY_CONFLICT/);
});

test("lease renewal rejects unchanged grant, logical expiry, identity and fence drift", async () => {
  const repository = new FakeRepository();
  const started = await new RealtimeSessionService(ports(repository)).bootstrap(request("lease-denials"));
  await assert.rejects(new RealtimeSessionService(renewalPorts(repository, "2026-08-23T13:00:00.000Z")).renewAppleCycling(renewalRequest(started)), /NOT_EXTENDING/);
  const valid = new RealtimeSessionService(renewalPorts(repository, "2026-08-23T14:00:00.000Z"));
  await assert.rejects(valid.renewAppleCycling(renewalRequest(started, { ttlSeconds: 1 })), /REQUESTED_WINDOW_BELOW_ISSUED_LEASE/);
  await assert.rejects(valid.renewAppleCycling(renewalRequest(started, { deviceId: "device-2" })), /SESSION_BINDING_INVALID/);
  await assert.rejects(valid.renewAppleCycling(renewalRequest(started, { expectedFencingToken: "9" })), /FENCE_CONFLICT/);
  await assert.rejects(new RealtimeSessionService(renewalPorts(repository, "2026-08-25T00:00:00.000Z", "2026-08-24T12:30:00.000Z"))
    .renewAppleCycling(renewalRequest(started)), /CONTINUITY_EXPIRED/);
  assert.equal(repository.outbox.length, 1);
});

test("expired lease can recover under fresh governance while continuity stays active", async () => {
  const repository = new FakeRepository();
  const started = await new RealtimeSessionService(ports(repository)).bootstrap(request("lease-expired"));
  const service = new RealtimeSessionService(renewalPorts(repository, "2026-08-23T15:00:00.000Z", "2026-08-23T14:00:00.000Z"));
  const { governance: omitted, ...withoutGovernance } = renewalRequest(started);
  await assert.rejects(service.renewAppleCycling(withoutGovernance), /AUTHORITY_REQUIRED/);
  const renewed = await service.renewAppleCycling(renewalRequest(started));
  assert.equal(renewed.continuityExpiresAt, started.continuityExpiresAt);
  assert.equal(renewed.leaseExpiresAt, "2026-08-23T15:00:00.000Z");
});

test("legacy renewal receipts remain read-only and retain historical semantics", async () => {
  const repository = new FakeRepository();
  const started = await new RealtimeSessionService(ports(repository)).bootstrap(request("lease-legacy"));
  const service = new RealtimeSessionService(renewalPorts(repository, "2026-08-23T14:00:00.000Z"));
  const renewal = renewalRequest(started); const first = await service.renewAppleCycling(renewal);
  const key = "device_lease_renewal:" + renewal.idempotencyKey; const saved = repository.idempotency.get(key)!;
  const legacy = { ...saved, operation: "activity_renewal" as const, result: { ...first, operation: "activity_renewal", receipt: { ...first.receipt, operation: "connected_credential_refresh" } } };
  repository.idempotency.delete(key); repository.idempotency.set("activity_renewal:" + renewal.idempotencyKey, legacy);
  const replay = await service.renewAppleCycling(renewal);
  assert.equal(replay.operation, "activity_renewal"); assert.equal(replay.receipt.operation, "connected_credential_refresh");
  assert.equal(replay.receipt.replayed, true); assert.equal(repository.outbox.length, 2);
  assert.equal(repository.idempotency.get("activity_renewal:" + renewal.idempotencyKey), legacy);
  assert.equal(repository.idempotency.has(key), false);
});

test("concurrent lease renewals are fenced by the current lease CAS", async () => {
  const repository = new FakeRepository();
  const started = await new RealtimeSessionService(ports(repository)).bootstrap(request("lease-concurrent"));
  const service = new RealtimeSessionService(renewalPorts(repository, "2026-08-23T14:00:00.000Z"));
  const results = await Promise.allSettled(["left", "right"].map(id => service.renewAppleCycling(renewalRequest(started, { requestId: id, idempotencyKey: id }))));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.filter(value => value.status === "rejected").length, 1);
  assert.equal(repository.sessions.get(String(started.realtimeSessionRef))?.revision, "1");
  assert.equal(repository.leases.get(String(started.deviceLeaseRef))?.leaseVersion, "2");
  assert.equal(repository.outbox.length, 2);
});

test("Stop replay rejects a receipt bound to the wrong request session", async () => {
  const repository = new FakeRepository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap(request("stop-bootstrap-idem"));
  const stopRequest = {
    requestId: "stop-request-1",
    idempotencyKey: "stop-replay-idem",
    operation: "media_stop" as const,
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    deviceLeaseRef: started.deviceLeaseRef,
    deviceId: "device-1",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
    reason: "user_stop" as const,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  };
  await service.stop(stopRequest);
  const key = "media_stop:stop-replay-idem";
  const stored = repository.idempotency.get(key);
  assert.ok(stored);
  const storedReceipt = stored.result as Record<string, unknown>;
  repository.idempotency.set(key, { ...stored, result: { ...storedReceipt, realtimeSessionRef: "wrong-session" } });
  await assert.rejects(
    () => new RealtimeSessionService(ports(repository)).stop(stopRequest),
    /MALFORMED_REPLAY_RECORD/,
  );
  assert.equal(repository.outbox.length, 2);
});

test("refresh replay rejects a binding whose device differs from the request", async () => {
  const repository = new FakeRepository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap(request("refresh-binding-bootstrap-idem"));
  const refreshRequest = {
    requestId: "refresh-binding-request",
    idempotencyKey: "refresh-binding-idem",
    binding: started.binding,
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  };
  await service.refresh(refreshRequest);
  const key = "connected_credential_refresh:refresh-binding-idem";
  const stored = repository.idempotency.get(key);
  assert.ok(stored);
  const storedResult = stored.result as Record<string, unknown>;
  const storedBinding = storedResult.binding as Record<string, unknown>;
  repository.idempotency.set(key, {
    ...stored,
    result: { ...storedResult, binding: { ...storedBinding, deviceId: "wrong-device" } },
  });
  await assert.rejects(
    () => new RealtimeSessionService(ports(repository)).refresh(refreshRequest),
    /TRANSPORT_BINDING_CONFLICT/,
  );
  assert.equal(repository.outbox.length, 2);
});

test("handoff replay rejects a result whose active device differs from the request", async () => {
  const repository = new FakeRepository();
  const service = new RealtimeSessionService(ports(repository));
  const started = await service.bootstrap(request("handoff-binding-bootstrap-idem"));
  const handoffRequest = {
    requestId: "handoff-binding-request",
    idempotencyKey: "handoff-binding-idem",
    realtimeSessionRef: started.realtimeSessionRef,
    continuityId: started.continuityId,
    fromDeviceId: "device-1",
    toDeviceId: "device-2",
    expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
    expectedLeaseVersion: assertDecimalCounter("1"),
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  };
  await service.handoff(handoffRequest);
  assert.equal(repository.handoffFacts.length, 1);
  const freshReplay = await new RealtimeSessionService(ports(repository)).handoff(handoffRequest);
  assert.equal(freshReplay.receipt.replayed, true);
  assert.equal(repository.handoffFacts.length, 1);
  assert.equal(repository.handoffFacts[0]?.idempotencyKey, "handoff-binding-idem");
  await assert.rejects(
    () => new RealtimeSessionService(ports(repository)).handoff({ ...handoffRequest, requestId: "handoff-binding-drift" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(repository.handoffFacts.length, 1);
  const key = "handoff:handoff-binding-idem";
  const stored = repository.idempotency.get(key);
  assert.ok(stored);
  const storedResult = stored.result as Record<string, unknown>;
  repository.idempotency.set(key, { ...stored, result: { ...storedResult, activeDeviceId: "wrong-device" } });
  await assert.rejects(
    () => new RealtimeSessionService(ports(repository)).handoff(handoffRequest),
    /MALFORMED_REPLAY_RECORD/,
  );
  assert.equal(repository.outbox.length, 2);
});
