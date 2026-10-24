import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionAuthorityFactory,
  type ProductionAuthorityFactoryOptions,
} from "../src/production-authority-factory.ts";
import { PublicControlProjection } from "../src/public-control-projection.ts";
import { RealtimeSessionService } from "../src/realtime-session-service.ts";
import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  OpaqueEqualityPort,
  RealtimeAuthorityRepository,
  RealtimeClockPort,
  RealtimeIdentityPort,
  TransportDisconnectionPort,
} from "../src/ports.ts";
import { assertCanonicalTimestamp } from "../src/types.ts";
import { type ProductionPortRegistration } from "../src/production-owner-ports.ts";

const NOW = assertCanonicalTimestamp("2026-08-23T12:00:00.000Z");

function canonical(value: unknown): string {
  if (value === null) return "null;";
  if (typeof value === "string") return `string:${value.length}:${value};`;
  if (typeof value === "boolean") return value ? "boolean:1;" : "boolean:0;";
  if (typeof value === "number") return `number:${String(value)};`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new TypeError("unsupported probe value");
  return `{${Object.keys(value).sort().map((key) => `key:${key.length}:${key}=${canonical((value as Record<string, unknown>)[key])}`).join("")}}`;
}

function register<T extends object>(port: T, owner: string, ready: () => boolean): ProductionPortRegistration<T> {
  return { port, readiness: { owner, environment: "production", isReady: ready } };
}

function makeOptions(ready: () => boolean): ProductionAuthorityFactoryOptions {
  const repository: RealtimeAuthorityRepository = {
    async transaction<T>(_operation: string, _work: never): Promise<T> {
      throw new Error("TEST_REPOSITORY_NOT_CALLED");
    },
  };
  const policy: LeasePolicyPort = {
    async evaluate(_input) { throw new Error("TEST_POLICY_NOT_CALLED"); },
  };
  const activityAcceptance: ActivityAcceptancePort = {
    async verify(_input) { throw new Error("TEST_ACTIVITY_NOT_CALLED"); },
  };
  const transportDisconnection: TransportDisconnectionPort = {
    async verify(_input) { throw new Error("TEST_DISCONNECT_NOT_CALLED"); },
  };
  const identity: RealtimeIdentityPort = {
    createContinuityId: ({ requestId }) => `continuity-${requestId}`,
    assertRepositoryIssuedRef: () => undefined,
    createSessionRef: ({ requestId }) => `session-${requestId}`,
    createDeviceLeaseRef: ({ deviceId }) => `lease-${deviceId}`,
    createTransportAlias: ({ requestId }) => `alias-${requestId}`,
    createConnectionId: ({ requestId }) => `connection-${requestId}`,
  };
  const clock: RealtimeClockPort = { now: () => NOW };
  const equality: OpaqueEqualityPort = {
    key: canonical,
    same: (left, right) => canonical(left) === canonical(right),
  };
  return {
    repository: register(repository, "T02", ready),
    policy: register(policy, "T03", ready),
    activityAcceptance: register(activityAcceptance, "T04", ready),
    transportDisconnection: register(transportDisconnection, "transport", ready),
    identity: register(identity, "T01/T11B", ready),
    clock: register(clock, "T11B", ready),
    equality: register(equality, "T11B", ready),
  };
}

test("factory exposes the same T11B service, public projection, and current-binding seam", () => {
  const authority = createProductionAuthorityFactory(makeOptions(() => true));
  assert.ok(authority.service instanceof RealtimeSessionService);
  assert.ok(authority.projection instanceof PublicControlProjection);
  assert.strictEqual(authority.controller, authority.projection);
  assert.strictEqual(authority.ports, authority.ownerPorts);
  assert.equal(authority.readiness.current().ready, true);
});

test("identity issuer pending keeps the factory constructed but fences reads and operations", async () => {
  let identityReady = false;
  const authority = createProductionAuthorityFactory(makeOptions(() => identityReady));
  const binding = {
    state: "connected" as const,
    realtimeSessionRef: "session-ref",
    deviceLeaseRef: "lease-ref",
    continuityId: "continuity-id",
    deviceId: "device-id",
    connectionEpoch: "1" as never,
    provider: "livekit-cloud",
    transportSessionAlias: "transport",
    roomAlias: "room",
    deviceAlias: "device",
    connectionId: "connection",
  };
  const occurredAt = NOW;
  assert.equal(authority.readiness.current().ready, false);
  assert.throws(() => authority.assertReady(), /REALTIME_PRODUCTION_PORTS_NOT_READY/);
  assert.throws(
    () => authority.readCurrentBinding({ continuityId: "continuity-pending" }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );
  await assert.rejects(
    () => authority.service.bootstrap({
      requestId: "pending-bootstrap",
      idempotencyKey: "pending-bootstrap-idem",
      mode: "initial",
      userId: "user-id",
      deviceId: "device-id",
      capabilities: ["realtime.media"],
      purpose: "realtime",
      occurredAt,
      governance: "governance",
    }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );
  await assert.rejects(
    () => authority.service.refresh({
      requestId: "pending-refresh",
      idempotencyKey: "pending-refresh-idem",
      binding,
      occurredAt,
      governance: "governance",
    }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );
  await assert.rejects(
    () => authority.service.recordAcceptedUserActivity({
      activityId: "pending-activity",
      kind: "accepted_user_activity",
      userId: "user-id",
      deviceId: "device-id",
      realtimeSessionRef: "session-ref",
      continuityId: "continuity-id",
      occurredAt,
      acceptanceRef: "acceptance",
      accepted: true,
    }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );
  await assert.rejects(
    () => authority.service.handoff({
      requestId: "pending-handoff",
      idempotencyKey: "pending-handoff-idem",
      realtimeSessionRef: "session-ref",
      continuityId: "continuity-id",
      fromDeviceId: "device-id",
      toDeviceId: "other-device",
      expectedConnectionEpoch: "1" as never,
      expectedLeaseVersion: "1" as never,
      occurredAt,
      governance: "governance",
    }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );
  await assert.rejects(
    () => authority.service.stop({
      requestId: "pending-stop",
      idempotencyKey: "pending-stop-idem",
      operation: "media_stop",
      realtimeSessionRef: "session-ref",
      continuityId: "continuity-id",
      deviceLeaseRef: "lease-ref",
      deviceId: "device-id",
      expectedConnectionEpoch: "1" as never,
      expectedLeaseVersion: "1" as never,
      reason: "user_stop",
      occurredAt,
      governance: "governance",
    }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );
  await assert.rejects(
    () => authority.projection.mediaStop({
      requestId: "pending-projection-stop",
      idempotencyKey: "pending-projection-stop-idem",
      operation: "media_stop",
      realtimeSessionRef: "session-ref",
      continuityId: "continuity-id",
      deviceLeaseRef: "lease-ref",
      deviceId: "device-id",
      expectedConnectionEpoch: "1" as never,
      expectedLeaseVersion: "1" as never,
      reason: "user_stop",
      occurredAt,
      governance: "governance",
    }),
    /REALTIME_PRODUCTION_PORTS_NOT_READY/,
  );

  identityReady = true;
  assert.equal(authority.readiness.current().ready, true);
  await assert.rejects(
    () => authority.readCurrentBinding({ continuityId: "continuity-ready" }),
    /TEST_REPOSITORY_NOT_CALLED/,
  );
  await authority.close();
});

test("factory close is idempotent and no operation is available after close", async () => {
  const authority = createProductionAuthorityFactory(makeOptions(() => true));
  const first = authority.close();
  const second = authority.close();
  assert.strictEqual(first, second);
  await first;
  assert.throws(() => authority.assertReady(), /REALTIME_PRODUCTION_PORTS_NOT_READY/);
});
