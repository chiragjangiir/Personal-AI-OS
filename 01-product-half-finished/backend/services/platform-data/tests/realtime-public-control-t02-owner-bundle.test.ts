import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Pool } from "pg";

import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  RealtimeClockPort,
  TransportDisconnectionPort,
} from "../../realtime-core/src/ports.ts";
import type {
  ProductionPortRegistration,
  ProductionReadinessDescriptor,
} from "../../realtime-core/src/production-owner-ports.ts";
import type { CanonicalTimestamp } from "../../realtime-core/src/types.ts";
import {
  createRealtimePublicControlT02OwnerBundle,
  type RealtimePublicControlT02OwnerBundleInput,
} from "../src/realtime-public-control-t02-owner-bundle.ts";
import { RealtimeAuthorityConflictError } from "../src/realtime-authority-repository.ts";
import type {
  RealtimeExternalEffectClaim,
  RealtimeExternalEffectCoordinatorPort,
} from "../src/realtime-external-effect-coordinator.ts";

const NOW = "2026-08-31T01:02:03.004Z" as CanonicalTimestamp;
const CONTINUITY_ID = "11111111-1111-7111-8111-111111111111";
const SOURCE = new URL("../src/realtime-public-control-t02-owner-bundle.ts", import.meta.url);

type CloseCounters = {
  readonly pool: { value: number };
  readonly policy: { value: number };
  readonly activity: { value: number };
  readonly transport: { value: number };
  readonly clock: { value: number };
  readonly coordinator: { value: number };
};

type PoolMode = "reject" | "missing" | "conflict";

function descriptor(owner: string, isReady: () => boolean): ProductionReadinessDescriptor {
  return Object.freeze({ owner, environment: "production", isReady });
}

function registration<T extends object>(
  port: T,
  owner: string,
  isReady: () => boolean,
  close?: () => void,
): ProductionPortRegistration<T> {
  return Object.freeze({
    port,
    readiness: descriptor(owner, isReady),
    ...(close === undefined ? {} : { close }),
  });
}

function pool(mode: PoolMode, counters: CloseCounters): Pool {
  const client = {
    async query(sql: string): Promise<{ readonly rows: readonly unknown[]; readonly rowCount: number }> {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ||
          normalized.startsWith("SET TRANSACTION")) {
        return { rows: [], rowCount: 0 };
      }
      if (!normalized.startsWith("SELECT")) throw new Error("UNEXPECTED_SCRIPTED_QUERY");
      if (mode === "missing") return { rows: [], rowCount: 0 };
      if (mode === "conflict") return { rows: [{}, {}], rowCount: 2 };
      throw new Error("POOL_CONNECT_MUST_NOT_RUN");
    },
    release(): void {},
  };
  return {
    connect: async () => client,
    end: async () => { counters.pool.value += 1; },
  } as unknown as Pool;
}

function ports(counters: CloseCounters, allReady: () => boolean): {
  readonly clock: ProductionPortRegistration<RealtimeClockPort>;
  readonly policy: ProductionPortRegistration<LeasePolicyPort>;
  readonly activityAcceptance: ProductionPortRegistration<ActivityAcceptancePort>;
  readonly transportDisconnection: ProductionPortRegistration<TransportDisconnectionPort>;
} {
  const clockPort: RealtimeClockPort = Object.freeze({ now: () => NOW });
  const policy: LeasePolicyPort = {
    async evaluate(): Promise<never> { throw new Error("POLICY_MUST_NOT_RUN"); },
  };
  const activityAcceptance: ActivityAcceptancePort = {
    async verify(): Promise<never> { throw new Error("ACTIVITY_MUST_NOT_RUN"); },
  };
  const transportDisconnection: TransportDisconnectionPort = {
    async verify(): Promise<never> { throw new Error("TRANSPORT_MUST_NOT_RUN"); },
  };
  return {
    clock: registration(clockPort, "T11B", allReady, () => { counters.clock.value += 1; }),
    policy: registration(policy, "T03", allReady, () => { counters.policy.value += 1; }),
    activityAcceptance: registration(activityAcceptance, "T04", allReady, () => { counters.activity.value += 1; }),
    transportDisconnection: registration(transportDisconnection, "transport", allReady, () => {
      counters.transport.value += 1;
    }),
  };
}

function coordinator(
  counters: CloseCounters,
  overrides: Partial<RealtimeExternalEffectCoordinatorPort> = {},
): RealtimeExternalEffectCoordinatorPort {
  let closeFlight: Promise<void> | undefined;
  return {
    claim: async (): Promise<RealtimeExternalEffectClaim> => ({ disposition: "claimed", claimId: "claim-1" }),
    restore: async () => undefined,
    executeStage: async () => undefined,
    suppressAndClose: async () => ({ suppressed: true }),
    commit: async () => undefined,
    release: async () => undefined,
    reconcileStage: async () => undefined,
    close: () => {
      if (closeFlight === undefined) {
        counters.coordinator.value += 1;
        closeFlight = Promise.resolve();
      }
      return closeFlight;
    },
    ...overrides,
  };
}

function input(options: {
  readonly poolMode?: PoolMode;
  readonly allReady?: () => boolean;
  readonly postgresReady?: () => boolean;
  readonly bind?: RealtimePublicControlT02OwnerBundleInput["t03"]["bindCurrentBinding"];
  readonly counters?: CloseCounters;
  readonly externalEffectCoordinator?: RealtimeExternalEffectCoordinatorPort;
} = {}): RealtimePublicControlT02OwnerBundleInput {
  const counters = options.counters ?? {
    pool: { value: 0 },
    policy: { value: 0 },
    activity: { value: 0 },
    transport: { value: 0 },
    clock: { value: 0 },
    coordinator: { value: 0 },
  };
  const allReady = options.allReady ?? (() => true);
  const ownerPorts = ports(counters, allReady);
  return {
    pool: pool(options.poolMode ?? "reject", counters),
    postgresReadiness: descriptor("T02", options.postgresReady ?? (() => true)),
    clock: ownerPorts.clock,
    t03: {
      policy: ownerPorts.policy,
      bindCurrentBinding: options.bind ?? (() => undefined),
    },
    activityAcceptance: ownerPorts.activityAcceptance,
    transportDisconnection: ownerPorts.transportDisconnection,
    externalEffectCoordinator: options.externalEffectCoordinator ?? coordinator(counters),
  };
}

test("accepts the closed input and rejects a caller-supplied identity", async () => {
  const composed = await createRealtimePublicControlT02OwnerBundle(input());
  await composed.close();

  const withIdentity = {
    ...input(),
    identity: Object.freeze({}),
  } as unknown as RealtimePublicControlT02OwnerBundleInput;
  await assert.rejects(
    createRealtimePublicControlT02OwnerBundle(withIdentity),
    /REALTIME_PUBLIC_CONTROL_T02_OWNER_BUNDLE_INPUT_INVALID/,
  );
});

test("exposes exact concrete aliases from one composed authority", async () => {
  const options = input();
  const composed = await createRealtimePublicControlT02OwnerBundle(options);
  assert.strictEqual(composed.service, composed.authority.service);
  assert.strictEqual(composed.projection, composed.authority.projection);
  assert.strictEqual(composed.readCurrentBinding, composed.authority.readCurrentBinding);
  assert.strictEqual(composed.readiness, composed.authority.readiness);
  assert.strictEqual(composed.assertReady, composed.authority.assertReady);
  assert.strictEqual(composed.dataPorts.repository.pool, options.pool);
  assert.strictEqual(composed.dataPorts.clock, options.clock.port);
  assert.notStrictEqual(composed.dataPorts.identity, composed.authority.ports.identity);
  assert.notStrictEqual(composed.dataPorts.equality, composed.authority.ports.equality);
  assert.equal(composed.issuerReadiness.environment, "production");
  await composed.close();
});

test("binds after construction exactly once with the authoritative reader", async () => {
  let calls = 0;
  let received: unknown;
  const composed = await createRealtimePublicControlT02OwnerBundle(input({
    bind: (reader) => {
      calls += 1;
      received = reader;
    },
  }));
  assert.equal(calls, 1);
  assert.strictEqual(received, composed.authority.readCurrentBinding);
  await composed.close();
});

test("allows construction before T03 readiness and observes delayed readiness", async () => {
  let t03Ready = false;
  let postgresReady = false;
  const composed = await createRealtimePublicControlT02OwnerBundle(input({
    allReady: () => t03Ready,
    postgresReady: () => postgresReady,
  }));
  assert.equal(composed.issuerReadiness.isReady(), false);
  assert.equal(composed.readiness.current().ready, false);
  assert.throws(composed.assertReady, /REALTIME_PRODUCTION_PORTS_NOT_READY/);

  t03Ready = true;
  postgresReady = true;
  assert.equal(composed.issuerReadiness.isReady(), true);
  assert.equal(composed.readiness.current().ready, true);
  await composed.close();
});

test("returns undefined for a missing current binding and rejects a contradictory snapshot", async () => {
  const missing = await createRealtimePublicControlT02OwnerBundle(input({ poolMode: "missing" }));
  assert.equal(await missing.readCurrentBinding({ continuityId: CONTINUITY_ID }), undefined);
  await missing.close();

  const conflict = await createRealtimePublicControlT02OwnerBundle(input({ poolMode: "conflict" }));
  await assert.rejects(
    conflict.readCurrentBinding({ continuityId: CONTINUITY_ID }),
    (error: unknown) => error instanceof RealtimeAuthorityConflictError,
  );
  await conflict.close();
});

test("issuer readiness probes only supplied PG and clock readiness without issuing identity", async () => {
  let postgresProbes = 0;
  let clockProbes = 0;
  let clockCalls = 0;
  const counters = {
    pool: { value: 0 }, policy: { value: 0 }, activity: { value: 0 }, transport: { value: 0 }, clock: { value: 0 }, coordinator: { value: 0 },
  };
  const composed = await createRealtimePublicControlT02OwnerBundle({
    ...input({ counters }),
    postgresReadiness: descriptor("T02", () => { postgresProbes += 1; return true; }),
    clock: registration(Object.freeze({ now: () => { clockCalls += 1; return NOW; } }), "T11B", () => {
      clockProbes += 1;
      return true;
    }),
  });
  assert.equal(clockCalls, 0);
  assert.equal(composed.issuerReadiness.isReady(), true);
  assert.equal(postgresProbes, 1);
  assert.equal(clockProbes, 1);
  assert.equal(clockCalls, 0);
  await composed.close();
});

test("binder failure closes the constructed authority and preserves the binder error", async () => {
  const counters = {
    pool: { value: 0 }, policy: { value: 0 }, activity: { value: 0 }, transport: { value: 0 }, clock: { value: 0 }, coordinator: { value: 0 },
  };
  await assert.rejects(
    createRealtimePublicControlT02OwnerBundle(input({
      counters,
      bind: async () => { throw new Error("BINDER_FAILED"); },
    })),
    /BINDER_FAILED/,
  );
  assert.equal(counters.policy.value, 1);
  assert.equal(counters.activity.value, 1);
  assert.equal(counters.transport.value, 1);
  assert.equal(counters.clock.value, 1);
  assert.equal(counters.coordinator.value, 1);
  assert.equal(counters.pool.value, 0);
});

test("close is idempotent and never closes the borrowed pool", async () => {
  const counters = {
    pool: { value: 0 }, policy: { value: 0 }, activity: { value: 0 }, transport: { value: 0 }, clock: { value: 0 }, coordinator: { value: 0 },
  };
  const composed = await createRealtimePublicControlT02OwnerBundle(input({ counters }));
  const first = composed.close();
  const second = composed.close();
  assert.strictEqual(first, second);
  await first;
  assert.equal(counters.pool.value, 0);
  assert.equal(counters.policy.value, 1);
  assert.equal(counters.activity.value, 1);
  assert.equal(counters.transport.value, 1);
  assert.equal(counters.clock.value, 1);
  assert.equal(counters.coordinator.value, 1);
});

test("handoff fence delegates claim, replay, suppression, commit and precommit release to one coordinator", async () => {
  const counters = {
    pool: { value: 0 }, policy: { value: 0 }, activity: { value: 0 }, transport: { value: 0 }, clock: { value: 0 }, coordinator: { value: 0 },
  };
  const calls: string[] = [];
  let claimCall = 0;
  const shared = coordinator(counters, {
    claim: async () => {
      calls.push("claim");
      claimCall += 1;
      return claimCall === 1
        ? { disposition: "claimed", claimId: "claim-1" }
        : { disposition: "replay", result: { status: "ok" } };
    },
    suppressAndClose: async () => { calls.push("suppress"); return { suppressed: true }; },
    commit: async () => { calls.push("commit"); },
    release: async () => { calls.push("release"); },
  });
  const composed = await createRealtimePublicControlT02OwnerBundle(input({ counters, externalEffectCoordinator: shared }));
  assert.strictEqual(composed.externalEffectCoordinator, shared);

  const claimInput = {
    idempotencyContext: { operation: "handoff" }, fingerprint: "fingerprint", request: { operation: "handoff" },
  };
  assert.deepEqual(await composed.handoffOutputFence.claim(claimInput), { disposition: "claimed", claimId: "claim-1" });
  await composed.handoffOutputFence.suppressAndClose({
    request: { operation: "handoff" }, fingerprint: "fingerprint", authorityResult: { accepted: true },
  });
  await composed.handoffOutputFence.commit({ claimId: "claim-1", fingerprint: "fingerprint", result: { status: "ok" } });
  assert.deepEqual(await composed.handoffOutputFence.claim(claimInput), {
    disposition: "replay", result: { status: "ok" },
  });
  await composed.handoffOutputFence.release({ claimId: "claim-2", fingerprint: "other" });
  assert.deepEqual(calls, ["claim", "suppress", "commit", "claim", "release"]);
  await composed.close();
  await composed.handoffOutputFence.close();
  assert.equal(counters.coordinator.value, 1);
});

test("source has exactly one concrete constructor for each composed dependency and no fallback markers", () => {
  const source = readFileSync(SOURCE, "utf8");
  for (const [name, count] of [
    ["createRealtimeAuthorityRepository(", 1],
    ["createProductionRealtimeIdentityPort(", 1],
    ["createProductionStructuralEquality(", 1],
    ["createProductionAuthorityFactory(", 1],
    ["createRealtimeExternalEffectCoordinator(", 0],
  ] as const) {
    assert.equal(source.split(name).length - 1, count, name);
  }
  assert.doesNotMatch(source, /\b(?:alias|bearer|apple|coredevice|uuid|cache|fixture|default)\b/iu);
  assert.doesNotMatch(source, /process\.env|new\s+Map\b|manual\s+row|test\s+port/iu);
});
