import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionStructuralEquality,
  createProductionOwnerPorts,
  ProductionOwnerPortsError,
  type ProductionOwnerPortsInput,
  type ProductionPortRegistration,
} from "../src/production-owner-ports.ts";
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

function structuralEquality(): OpaqueEqualityPort {
  return {
    key: canonical,
    same: (left, right) => canonical(left) === canonical(right),
  };
}

function repository(): RealtimeAuthorityRepository {
  return {
    async transaction<T>(_operation: string, _work: never): Promise<T> {
      throw new Error("TEST_REPOSITORY_NOT_CALLED");
    },
  };
}

function policy(): LeasePolicyPort {
  return {
    async evaluate(_input) {
      throw new Error("TEST_POLICY_NOT_CALLED");
    },
  };
}

function activityAcceptance(): ActivityAcceptancePort {
  return {
    async verify(_input) {
      throw new Error("TEST_ACTIVITY_NOT_CALLED");
    },
  };
}

function transportDisconnection(): TransportDisconnectionPort {
  return {
    async verify(_input) {
      throw new Error("TEST_DISCONNECT_NOT_CALLED");
    },
  };
}

function identity(): RealtimeIdentityPort {
  return {
    createContinuityId: ({ requestId }) => `continuity-${requestId}`,
    assertRepositoryIssuedRef: () => undefined,
    createSessionRef: ({ requestId }) => `session-${requestId}`,
    createDeviceLeaseRef: ({ deviceId }) => `lease-${deviceId}`,
    createTransportAlias: ({ requestId }) => `alias-${requestId}`,
    createConnectionId: ({ requestId }) => `connection-${requestId}`,
  };
}

function clock(): RealtimeClockPort {
  return { now: () => NOW };
}

function registration<T extends object>(
  port: T,
  owner: string,
  isReady: () => boolean,
  close?: () => void | Promise<void>,
): ProductionPortRegistration<T> {
  return {
    port,
    readiness: { owner, environment: "production", isReady },
    ...(close === undefined ? {} : { close }),
  };
}

function input(
  ready: () => boolean = () => true,
  overrides: Partial<ProductionOwnerPortsInput> = {},
): ProductionOwnerPortsInput {
  return {
    repository: registration(repository(), "T02", ready),
    policy: registration(policy(), "T03", ready),
    activityAcceptance: registration(activityAcceptance(), "T04", ready),
    transportDisconnection: registration(transportDisconnection(), "transport", ready),
    identity: registration(identity(), "T01/T11B", ready),
    clock: registration(clock(), "T11B", ready),
    equality: registration(structuralEquality(), "T11B", ready),
    ...overrides,
  };
}

test("requires every explicit owner port and rejects missing registrations", () => {
  const value = input();
  const { policy: _policy, ...missing } = value;
  assert.throws(
    () => createProductionOwnerPorts(missing as ProductionOwnerPortsInput),
    (error: unknown) => error instanceof ProductionOwnerPortsError && error.code === "PRODUCTION_POLICY_REGISTRATION_REQUIRED",
  );
});

test("rejects non-production registrations before any service can be composed", () => {
  const value = input();
  const nonProduction = {
    ...value.policy,
    readiness: { owner: "fixture", environment: "non-production", isReady: () => true },
  } as unknown as ProductionPortRegistration<LeasePolicyPort>;
  assert.throws(
    () => createProductionOwnerPorts({ ...value, policy: nonProduction }),
    (error: unknown) => error instanceof ProductionOwnerPortsError && error.code === "PRODUCTION_POLICY_NON_PRODUCTION",
  );
});

test("rejects identity-only equality even when all ports report ready", () => {
  const value = input();
  const identityOnly: OpaqueEqualityPort = { key: String, same: (left, right) => left === right };
  assert.throws(
    () => createProductionOwnerPorts({
      ...value,
      equality: registration(identityOnly, "T11B", () => true),
    }),
    (error: unknown) => error instanceof ProductionOwnerPortsError && error.code === "PRODUCTION_STRUCTURAL_EQUALITY_REQUIRED",
  );
});

test("concrete structural equality is clone-stable, order-aware, and fail-closed", () => {
  const equality = createProductionStructuralEquality();
  const left = {
    nested: { second: ["a", 2], first: true },
    values: ["one", "two"],
  };
  const cloneWithDifferentObjectKeyOrder = {
    values: ["one", "two"],
    nested: { first: true, second: ["a", 2] },
  };
  const changedArrayOrder = {
    nested: { first: true, second: [2, "a"] },
    values: ["one", "two"],
  };
  assert.equal(equality.same(left, cloneWithDifferentObjectKeyOrder), true);
  assert.equal(equality.key(left), equality.key(cloneWithDifferentObjectKeyOrder));
  assert.equal(equality.same(left, changedArrayOrder), false);
  assert.equal(equality.same(left, { ...left, nested: { ...left.nested, first: false } }), false);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(equality.same(cyclic, cyclic), false);
  assert.throws(() => equality.key(cyclic), /PRODUCTION_EQUALITY_CYCLE/);
  assert.equal(equality.same({ value: undefined }, { value: undefined }), false);
  assert.throws(() => equality.key({ value: undefined }), /PRODUCTION_EQUALITY_VALUE_INVALID/);
  assert.equal(equality.same(new Date(0) as never, new Date(0) as never), false);
});

test("readiness fences every wrapped operation until all owner probes are ready", async () => {
  let ready = false;
  const ports = createProductionOwnerPorts(input(() => ready));
  const snapshot = ports.readiness.current();
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.ports.find((status) => status.name === "identity")?.ready, false);
  assert.throws(() => ports.assertReady(), /REALTIME_PRODUCTION_PORTS_NOT_READY/);
  assert.throws(() => ports.clock.now(), /REALTIME_PRODUCTION_PORTS_NOT_READY/);

  ready = true;
  assert.equal(ports.readiness.current().ready, true);
  assert.equal(ports.clock.now(), NOW);
  await ports.close();
  await ports.close();
  assert.throws(() => ports.clock.now(), /REALTIME_PRODUCTION_PORTS_CLOSED/);
});

test("close hooks run once in owner-before-repository order and close is idempotent", async () => {
  const closed: string[] = [];
  const value = input(() => true, {
    policy: registration(policy(), "T03", () => true, () => { closed.push("policy"); }),
    activityAcceptance: registration(activityAcceptance(), "T04", () => true, () => { closed.push("activity"); }),
    transportDisconnection: registration(transportDisconnection(), "transport", () => true, () => { closed.push("transport"); }),
    identity: registration(identity(), "T01/T11B", () => true, () => { closed.push("identity"); }),
    clock: registration(clock(), "T11B", () => true, () => { closed.push("clock"); }),
    equality: registration(structuralEquality(), "T11B", () => true, () => { closed.push("equality"); }),
    repository: registration(repository(), "T02", () => true, () => { closed.push("repository"); }),
  });
  const ports = createProductionOwnerPorts(value);
  const first = ports.close();
  const second = ports.close();
  assert.strictEqual(first, second);
  await first;
  assert.deepEqual(closed, ["policy", "activity", "transport", "identity", "clock", "equality", "repository"]);
});
