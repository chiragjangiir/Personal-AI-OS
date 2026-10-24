import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { RealtimeClockPort, RealtimeIdentityPort } from "../../realtime-core/src/ports.ts";
import type { CanonicalTimestamp, OpaqueCanonicalRef } from "../../realtime-core/src/types.ts";
import {
  createProductionRealtimeIdentityPort,
  ProductionRealtimeIdentityError,
  type ProductionRealtimeIdentityPortOptions,
} from "../src/realtime-identity-issuer.ts";

const TIME = "2026-08-29T01:02:03.004Z" as CanonicalTimestamp;
const NEXT_TIME = "2026-08-29T01:02:03.005Z" as CanonicalTimestamp;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;

function clock(...values: CanonicalTimestamp[]): RealtimeClockPort {
  let index = 0;
  return Object.freeze({
    now(): CanonicalTimestamp {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      if (value === undefined) throw new Error("TEST_CLOCK_EMPTY");
      return value;
    },
  });
}

function issuer(...values: CanonicalTimestamp[]): RealtimeIdentityPort {
  return createProductionRealtimeIdentityPort({ clock: clock(...values) });
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectedRefHash(refType: "RealtimeSession" | "DeviceLease", refId: string, version: string): string {
  const payload = JSON.stringify({ object_version: version, ref_id: refId, ref_type: refType });
  return hash(`paios.t02.${refType}.repository-ref.v1\n${payload}`);
}

function stripUuid(value: string): string {
  return value.replaceAll("-", "");
}

function asRecord(value: OpaqueCanonicalRef): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Readonly<Record<string, unknown>>;
}

function sessionRef(port: RealtimeIdentityPort, requestId = "request-session-001"): OpaqueCanonicalRef {
  const continuityId = port.createContinuityId({ userId: "user-001", requestId: "request-continuity-001" });
  return port.createSessionRef({ userId: "user-001", continuityId, requestId });
}

function assertCode(work: () => unknown, code: string): void {
  assert.throws(work, (error: unknown) =>
    error instanceof ProductionRealtimeIdentityError && error.code === code);
}

test("production port implements all six identity methods with exact refs", () => {
  const port = issuer(TIME);
  const continuityId = port.createContinuityId({ userId: "user-001", requestId: "request-001" });
  const realtimeSessionRef = port.createSessionRef({
    userId: "user-001",
    continuityId,
    requestId: "request-001",
  });
  const deviceLeaseRef = port.createDeviceLeaseRef({
    sessionRef: realtimeSessionRef,
    deviceId: "device-001",
    requestId: "request-001",
  });
  const alias = port.createTransportAlias({
    provider: Object.freeze({ kind: "livekit", region: "local" }),
    sessionRef: realtimeSessionRef,
    deviceId: "device-001",
    connectionEpoch: "1",
    requestId: "request-001",
  });
  const connectionId = port.createConnectionId({ deviceId: "device-001", requestId: "request-001" });

  assert.match(continuityId, UUID_V7);
  assert.match(connectionId, UUID_V7);
  const session = asRecord(realtimeSessionRef);
  const lease = asRecord(deviceLeaseRef);
  assert.deepEqual(Object.keys(session).sort(), ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"]);
  assert.deepEqual(Object.keys(lease).sort(), ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"]);
  assert.equal(session.ref_type, "RealtimeSession");
  assert.equal(lease.ref_type, "DeviceLease");
  assert.equal(session.object_version, "1");
  assert.equal(lease.object_version, "1");
  assert.match(session.ref_id as string, UUID_V7);
  assert.match(lease.ref_id as string, UUID_V7);
  assert.equal(session.canonical_payload_sha256,
    expectedRefHash("RealtimeSession", session.ref_id as string, "1"));
  assert.equal(lease.canonical_payload_sha256,
    expectedRefHash("DeviceLease", lease.ref_id as string, "1"));
  assert.match(session.canonical_payload_sha256 as string, HASH);
  assert.match(lease.canonical_payload_sha256 as string, HASH);
  port.assertRepositoryIssuedRef(realtimeSessionRef, "RealtimeSession");
  port.assertRepositoryIssuedRef(deviceLeaseRef, "DeviceLease");
  assert.equal(typeof alias, "string");
  assert.match(alias as string, /^t02\.realtime\.transport-alias\.v1:/u);
  assert.ok((alias as string).length < 512);
});

test("UUIDv7 issuance is monotonic at the same millisecond and across increasing time", () => {
  const same = issuer(TIME);
  const continuityId = same.createContinuityId({ userId: "user-001", requestId: "request-001" });
  const session = asRecord(same.createSessionRef({ userId: "user-001", continuityId, requestId: "request-001" }));
  const lease = asRecord(same.createDeviceLeaseRef({
    sessionRef: session,
    deviceId: "device-001",
    requestId: "request-001",
  }));
  const connectionId = same.createConnectionId({ deviceId: "device-001", requestId: "request-001" });
  const ordered = [continuityId, session.ref_id as string, lease.ref_id as string, connectionId].map(stripUuid);
  assert.deepEqual([...ordered].sort(), ordered);
  assert.equal(new Set(ordered).size, ordered.length);

  const increasing = issuer(TIME, NEXT_TIME);
  const first = increasing.createContinuityId({ userId: "user-001", requestId: "request-001" });
  const second = increasing.createConnectionId({ deviceId: "device-001", requestId: "request-002" });
  assert.ok(stripUuid(second) > stripUuid(first));
  assert.equal(BigInt(`0x${stripUuid(first).slice(0, 12)}`), BigInt(Date.parse(TIME)));
  assert.equal(BigInt(`0x${stripUuid(second).slice(0, 12)}`), BigInt(Date.parse(NEXT_TIME)));
});

test("clock failures, invalid time, range, rollback and tail exhaustion guard fail closed", () => {
  assertCode(
    () => createProductionRealtimeIdentityPort({
      clock: Object.freeze({ now() { throw new Error("clock unavailable"); } }),
    }).createConnectionId({ deviceId: "device-001", requestId: "request-001" }),
    "REALTIME_IDENTITY_CLOCK_FAILED",
  );
  assertCode(
    () => issuer("2026-02-30T01:02:03.004Z" as CanonicalTimestamp)
      .createConnectionId({ deviceId: "device-001", requestId: "request-001" }),
    "REALTIME_IDENTITY_TIME_INVALID",
  );
  assertCode(
    () => issuer("0001-01-01T00:00:00.000Z" as CanonicalTimestamp)
      .createConnectionId({ deviceId: "device-001", requestId: "request-001" }),
    "REALTIME_IDENTITY_TIME_RANGE_INVALID",
  );
  const rollback = issuer(NEXT_TIME, TIME);
  rollback.createContinuityId({ userId: "user-001", requestId: "request-001" });
  assertCode(
    () => rollback.createConnectionId({ deviceId: "device-001", requestId: "request-002" }),
    "REALTIME_IDENTITY_CLOCK_ROLLBACK",
  );
  const source = readFileSync(new URL("../src/realtime-identity-issuer.ts", import.meta.url), "utf8");
  assert.match(source, /lastTail === UUID_TAIL_MAX/u);
  assert.match(source, /REALTIME_IDENTITY_UUID_TAIL_EXHAUSTED/u);
});

test("fresh factories structurally validate domain-separated refs without issuance state", () => {
  const issuedBy = issuer(TIME);
  const session = sessionRef(issuedBy);
  const lease = issuedBy.createDeviceLeaseRef({
    sessionRef: session,
    deviceId: "device-001",
    requestId: "request-lease-001",
  });
  const fresh = issuer(NEXT_TIME);
  fresh.assertRepositoryIssuedRef(session, "RealtimeSession");
  fresh.assertRepositoryIssuedRef(lease, "DeviceLease");

  const sessionRecord = asRecord(session);
  for (const drift of [
    { ...sessionRecord, canonical_payload_sha256: "b".repeat(64) },
    { ...sessionRecord, ref_type: "DeviceLease" },
    { ...sessionRecord, ref_id: "00000000-0000-7000-8000-000000000000" },
    { ...sessionRecord, object_version: "0" },
    { ...sessionRecord, extra: true },
  ]) {
    assertCode(() => fresh.assertRepositoryIssuedRef(drift, "RealtimeSession"), "REALTIME_IDENTITY_REF_INVALID");
  }
  assertCode(() => fresh.assertRepositoryIssuedRef(session, "DeviceLease"), "REALTIME_IDENTITY_REF_INVALID");
  assertCode(
    () => fresh.assertRepositoryIssuedRef(session, "Wrong" as "RealtimeSession"),
    "REALTIME_IDENTITY_REF_KIND_INVALID",
  );

  const accessor = { ...sessionRecord };
  Object.defineProperty(accessor, "ref_id", { enumerable: true, get: () => sessionRecord.ref_id });
  assertCode(() => fresh.assertRepositoryIssuedRef(accessor, "RealtimeSession"), "REALTIME_IDENTITY_REF_INVALID");
  const symbol = { ...sessionRecord, [Symbol("drift")]: true };
  assertCode(() => fresh.assertRepositoryIssuedRef(symbol, "RealtimeSession"), "REALTIME_IDENTITY_REF_INVALID");
  const nonPlain = Object.assign(new Date(), sessionRecord);
  assertCode(() => fresh.assertRepositoryIssuedRef(nonPlain, "RealtimeSession"), "REALTIME_IDENTITY_REF_INVALID");
});

test("transport aliases bind provider, session, device, epoch and request", () => {
  const port = issuer(TIME);
  const firstSession = sessionRef(port, "request-session-001");
  const secondSession = port.createSessionRef({
    userId: "user-001",
    continuityId: port.createContinuityId({ userId: "user-001", requestId: "request-continuity-002" }),
    requestId: "request-session-002",
  });
  const base = {
    provider: Object.freeze({ region: "local", transport: "livekit" }),
    sessionRef: firstSession,
    deviceId: "device-001",
    connectionEpoch: "1",
    requestId: "request-alias-001",
  } as const;
  const alias = port.createTransportAlias(base);
  assert.equal(alias, port.createTransportAlias({
    ...base,
    provider: Object.freeze({ transport: "livekit", region: "local" }),
  }));
  for (const drift of [
    { provider: { region: "remote", transport: "livekit" } },
    { sessionRef: secondSession },
    { deviceId: "device-002" },
    { connectionEpoch: "2" },
    { requestId: "request-alias-002" },
  ]) {
    assert.notEqual(alias, port.createTransportAlias({ ...base, ...drift }));
  }
  assert.ok((alias as string).length < 512);
  assertCode(() => port.createTransportAlias({ ...base, connectionEpoch: "0" }), "REALTIME_IDENTITY_EPOCH_INVALID");
  assertCode(() => port.createTransportAlias({ ...base, connectionEpoch: "1".repeat(39) }),
    "REALTIME_IDENTITY_EPOCH_INVALID");
  assertCode(() => port.createTransportAlias({ ...base, requestId: "x".repeat(513) }),
    "REALTIME_IDENTITY_REQUEST_INVALID");
  assertCode(() => port.createTransportAlias({ ...base, deviceId: "" }), "REALTIME_IDENTITY_DEVICE_INVALID");
  assertCode(() => port.createTransportAlias({ ...base, provider: "" }), "REALTIME_IDENTITY_PROVIDER_INVALID");
  assertCode(() => port.createTransportAlias({ ...base, provider: new Date() as unknown as Record<string, unknown> }),
    "REALTIME_IDENTITY_PROVIDER_INVALID");
  const providerAccessor: Record<string, unknown> = {};
  Object.defineProperty(providerAccessor, "kind", { enumerable: true, get: () => "livekit" });
  assertCode(() => port.createTransportAlias({ ...base, provider: providerAccessor }),
    "REALTIME_IDENTITY_PROVIDER_INVALID");
  assertCode(() => port.createTransportAlias({ ...base, provider: { kind: "livekit", [Symbol("drift")]: true } }),
    "REALTIME_IDENTITY_PROVIDER_INVALID");
});

test("method inputs reject extra, accessor, symbol and nonplain shapes before issuance", () => {
  const port = issuer(TIME);
  assertCode(
    () => port.createContinuityId({ userId: "user-001", requestId: "request-001", extra: true } as never),
    "REALTIME_IDENTITY_CONTINUITY_INPUT_INVALID",
  );
  const accessor: Record<string, unknown> = { requestId: "request-001" };
  Object.defineProperty(accessor, "userId", { enumerable: true, get: () => "user-001" });
  assertCode(() => port.createContinuityId(accessor as never), "REALTIME_IDENTITY_CONTINUITY_INPUT_INVALID");
  assertCode(
    () => port.createConnectionId({ deviceId: "device-001", requestId: "request-001", [Symbol("drift")]: true } as never),
    "REALTIME_IDENTITY_CONNECTION_INPUT_INVALID",
  );
  assertCode(
    () => port.createConnectionId(Object.assign(new Date(), { deviceId: "device-001", requestId: "request-001" }) as never),
    "REALTIME_IDENTITY_CONNECTION_INPUT_INVALID",
  );
});

test("factory requires one explicit clock and production source has no forbidden escape hatch", () => {
  assertCode(
    () => createProductionRealtimeIdentityPort({} as ProductionRealtimeIdentityPortOptions),
    "REALTIME_IDENTITY_OPTIONS_INVALID",
  );
  assertCode(
    () => createProductionRealtimeIdentityPort({ clock: {} as RealtimeClockPort }),
    "REALTIME_IDENTITY_CLOCK_INVALID",
  );
  const source = readFileSync(new URL("../src/realtime-identity-issuer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /randomUUID|process\.env|\bMap\b|\bcache\b|\bregistry\b|\bdefault\b/u);
  assert.match(source, /randomBytes\(10\)/u);
  assert.match(source, /MAX_UUID_TIMESTAMP/u);
  assert.match(source, /UUID_TAIL_MAX/u);
});
