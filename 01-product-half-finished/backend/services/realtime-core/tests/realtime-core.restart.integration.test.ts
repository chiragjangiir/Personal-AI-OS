import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeSessionService } from "../src/realtime-session-service.ts";
import type { RealtimeAuthorityPorts, RealtimeAuthorityRepository, RealtimeAuthorityTransaction } from "../src/ports.ts";
import type { DeviceLeaseRecord, HandoffFactRecord, IdempotencyRecord, OpaqueCanonicalRef, OutboxEvent, RealtimeSessionRecord, RealtimeTransportBinding } from "../src/types.ts";
import { assertCanonicalTimestamp, assertDecimalConnectionEpoch } from "../src/types.ts";

class RestartRepository implements RealtimeAuthorityRepository, RealtimeAuthorityTransaction {
  readonly sessions = new Map<string, RealtimeSessionRecord>();
  readonly leases = new Map<string, DeviceLeaseRecord>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly outbox: OutboxEvent[] = [];
  readonly handoffFacts: HandoffFactRecord[] = [];
  async transaction<T>(_operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> { return work(this); }
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
  async writeSession(input: { readonly expectedRevision?: string; readonly record: RealtimeSessionRecord }) { this.sessions.set(String(input.record.realtimeSessionRef), input.record); }
  async writeLease(input: { readonly expectedLeaseVersion?: string; readonly record: DeviceLeaseRecord }) { this.leases.set(String(input.record.deviceLeaseRef), input.record); }
  async writeBinding(_input: { readonly expectedConnectionEpoch?: string; readonly binding: RealtimeTransportBinding }) {}
  async recordHandoffFact(record: HandoffFactRecord) { this.handoffFacts.push(record); }
  async writeIdempotency(record: IdempotencyRecord) { this.idempotency.set(`${record.operation}:${record.idempotencyKey}`, record); }
  async appendOutbox(event: OutboxEvent): Promise<OpaqueCanonicalRef> { this.outbox.push(event); return `outbox-${this.outbox.length}`; }
}

function ports(repository: RestartRepository): RealtimeAuthorityPorts {
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
    clock: { now: () => assertCanonicalTimestamp("2026-08-23T12:30:00.000Z") },
    equality: { key: (value) => String(value), same: Object.is },
  };
}

test("a fresh service instance resumes durable continuity through a new transport epoch", async () => {
  const repository = new RestartRepository();
  const firstService = new RealtimeSessionService(ports(repository));
  const first = await firstService.bootstrap({
    requestId: "restart-start",
    idempotencyKey: "restart-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const request = {
    requestId: "restart-refresh",
    idempotencyKey: "restart-refresh-idem",
    mode: "fully_disconnected" as const,
    userId: "user-1",
    deviceId: "device-2",
    continuityId: first.continuityId,
    existingSessionRef: first.realtimeSessionRef,
    existingBinding: first.binding,
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:10:00.000Z"),
    governance: "governance-1",
  };
  const secondService = new RealtimeSessionService(ports(repository));
  const resumed = await secondService.bootstrap(request);
  assert.equal(resumed.continuityId, first.continuityId);
  assert.equal(resumed.connectionEpoch, "2");
  assert.equal(resumed.receipt.operation, "bootstrap");
  assert.notEqual(resumed.realtimeSessionRef, first.realtimeSessionRef);
  assert.ok(resumed.receipt.outboxEventRef);
  assert.equal(repository.sessions.get(String(first.realtimeSessionRef))?.state, "terminal");
  assert.equal(repository.sessions.get(String(first.realtimeSessionRef))?.binding.state, "disconnected");
  const replay = await new RealtimeSessionService(ports(repository)).bootstrap(request);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(replay.connectionEpoch, "2");
  assert.equal(replay.receipt.operation, "bootstrap");
});

test("fully disconnected refresh fails closed when the disconnect proof is forged", async () => {
  const repository = new RestartRepository();
  const firstService = new RealtimeSessionService(ports(repository));
  const first = await firstService.bootstrap({
    requestId: "forged-start",
    idempotencyKey: "forged-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const forgedPorts: RealtimeAuthorityPorts = {
    ...ports(repository),
    transportDisconnection: {
      async verify() {
        throw new Error("FORGED_DISCONNECT_PROOF");
      },
    },
  };
  await assert.rejects(
    () => new RealtimeSessionService(forgedPorts).bootstrap({
      requestId: "forged-refresh",
      idempotencyKey: "forged-refresh-idem",
      mode: "fully_disconnected",
      userId: "user-1",
      deviceId: "device-2",
      continuityId: first.continuityId,
      existingSessionRef: first.realtimeSessionRef,
      existingBinding: first.binding,
      capabilities: ["audio.publish"],
      purpose: "conversation",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:10:00.000Z"),
      governance: "governance-1",
    }),
    /FORGED_DISCONNECT_PROOF/,
  );
  assert.equal(repository.sessions.get(String(first.realtimeSessionRef))?.state, "active");
  assert.equal(repository.sessions.get(String(first.realtimeSessionRef))?.binding.state, "connected");
});

test("current-binding projection survives a service restart and never selects the terminal predecessor", async () => {
  const repository = new RestartRepository();
  const firstService = new RealtimeSessionService(ports(repository));
  const first = await firstService.bootstrap({
    requestId: "projection-restart-start",
    idempotencyKey: "projection-restart-start-idem",
    mode: "initial",
    userId: "user-1",
    deviceId: "device-1",
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:00:00.000Z"),
    governance: "governance-1",
  });
  const disconnected = await new RealtimeSessionService(ports(repository)).bootstrap({
    requestId: "projection-restart-rebind",
    idempotencyKey: "projection-restart-rebind-idem",
    mode: "fully_disconnected",
    userId: "user-1",
    deviceId: "device-2",
    continuityId: first.continuityId,
    existingSessionRef: first.realtimeSessionRef,
    existingBinding: first.binding,
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: assertCanonicalTimestamp("2026-08-23T12:10:00.000Z"),
    governance: "governance-1",
  });
  const restarted = new RealtimeSessionService(ports(repository));
  const current = await restarted.readCurrentBinding({ continuityId: first.continuityId });
  assert.ok(current);
  assert.equal(current.session.realtimeSessionRef, disconnected.realtimeSessionRef);
  assert.equal(current.session.binding.state, "connected");
  assert.equal(current.lease.state, "active");
  const predecessor = await restarted.readCurrentBinding({ realtimeSessionRef: first.realtimeSessionRef });
  assert.ok(predecessor);
  assert.equal(predecessor.session.state, "terminal");
  assert.equal(predecessor.session.binding.state, "disconnected");
  assert.equal(predecessor.lease.state, "released");
});
