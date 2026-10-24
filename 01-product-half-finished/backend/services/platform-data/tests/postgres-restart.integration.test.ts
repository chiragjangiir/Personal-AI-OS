import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  closePostgresPool,
  createPostgresPool,
  isPostgresConfigured,
} from "../src/postgres-pool.ts";
import { createRealtimeAuthorityRepository } from "../src/realtime-authority-repository.ts";
import { RealtimeSessionService } from "../../realtime-core/src/realtime-session-service.ts";
import type { RealtimeAuthorityPorts } from "../../realtime-core/src/ports.ts";
import { assertCanonicalTimestamp } from "../../realtime-core/src/types.ts";

const RUN = process.env.PAIOS_RUN_PG_RESTART === "1";
const CHILD_PHASE = process.env.PAIOS_RESTART_CHILD;
const SKIP_REASON = "set PAIOS_PG_DATABASE, PAIOS_PG_USER, PAIOS_PG_PASSWORD and PAIOS_RUN_PG_RESTART=1";
const DOCKER = "G:\\安装文件\\DockerDesktop\\resources\\bin\\docker.exe";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const PROJECT = "paios-realtime-authority-001";
const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_ID = "91111111-1111-7111-8111-111111111111";
const DEVICE_ID = "92222222-2222-7222-8222-222222222222";
const CONTINUITY_ID = "93333333-3333-7333-8333-333333333333";
const SESSION_REF_ID = "94444444-4444-7444-8444-444444444444";
const LEASE_REF_ID = "95555555-5555-7555-8555-555555555555";
const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: SESSION_REF_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
});
const LEASE_REF = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: LEASE_REF_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
});
const AT = assertCanonicalTimestamp("2026-08-23T12:00:00.000Z");
const IDEMPOTENCY_KEY = "restart-bootstrap-key";

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("unstable restart fixture");
}

function createService(repository: ReturnType<typeof createRealtimeAuthorityRepository>): RealtimeSessionService {
  const ports: RealtimeAuthorityPorts = {
    repository,
    policy: {
      async evaluate() {
        return {
          allowed: true as const,
          policyDecisionRef: "restart-policy",
          capabilities: ["audio.publish"],
          purpose: "conversation",
          leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
          revocable: true as const,
        };
      },
    },
    activityAcceptance: {
      async verify(activity) {
        return {
          verified: true as const,
          acceptanceRef: activity.acceptanceRef,
          acceptedAt: activity.occurredAt,
          authorityWatermark: "restart-watermark",
        };
      },
    },
    transportDisconnection: {
      async verify(input) {
        return {
          verified: true as const,
          disconnectedAt: input.occurredAt,
          authorityProof: "restart-disconnect-proof",
        };
      },
    },
    identity: {
      createContinuityId: () => CONTINUITY_ID,
      assertRepositoryIssuedRef(value: unknown, kind: "RealtimeSession" | "DeviceLease") {
        const expected = kind === "RealtimeSession" ? SESSION_REF : LEASE_REF;
        if (stable(value) !== stable(expected)) throw new Error("RESTART_REF_INVALID");
      },
      createSessionRef: () => SESSION_REF,
      createDeviceLeaseRef: () => LEASE_REF,
      createTransportAlias: ({ requestId, deviceId }: { requestId: string; deviceId: string }) => `restart-alias-${deviceId}-${requestId}`,
      createConnectionId: ({ requestId }: { requestId: string }) => `restart-connection-${requestId}`,
    },
    clock: { now: () => AT },
    equality: { key: stable, same: (left, right) => stable(left) === stable(right) },
  };
  return new RealtimeSessionService(ports);
}

function restartRequest() {
  return {
    requestId: "restart-bootstrap",
    idempotencyKey: IDEMPOTENCY_KEY,
    mode: "initial" as const,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: AT,
    governance: "restart-governance",
  };
}

async function runRestartChild(phase: string): Promise<void> {
  const pool = createPostgresPool();
  const migrations = await Promise.all([
    readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"),
  ]);
  const repository = createRealtimeAuthorityRepository(pool);
  try {
    if (phase === "write") {
      for (const migration of migrations) await pool.query(migration);
      const result = await createService(repository).bootstrap(restartRequest());
      assert.equal(result.receipt.status, "success");
      assert.deepEqual(result.realtimeSessionRef, SESSION_REF);
      assert.deepEqual(result.deviceLeaseRef, LEASE_REF);
      return;
    }
    if (phase !== "read") throw new Error("RESTART_CHILD_PHASE_INVALID");
    const session = await repository.transaction("restart.child.read.session", (tx) => tx.readSession(SESSION_REF));
    const lease = await repository.transaction("restart.child.read.lease", (tx) => tx.readLease(LEASE_REF));
    assert.ok(session);
    assert.ok(lease);
    assert.deepEqual(session.realtimeSessionRef, SESSION_REF);
    assert.deepEqual(session.activeDeviceLeaseRef, LEASE_REF);
    assert.equal(session.connectionEpoch, "1");
    assert.deepEqual(lease.deviceLeaseRef, LEASE_REF);
    assert.deepEqual(lease.realtimeSessionRef, SESSION_REF);
    const replay = await createService(repository).bootstrap(restartRequest());
    assert.equal(replay.receipt.replayed, true);
    assert.deepEqual(replay.realtimeSessionRef, SESSION_REF);
    assert.deepEqual(replay.deviceLeaseRef, LEASE_REF);
    const ledger = await pool.query(
      "SELECT status, response FROM idempotency_ledger WHERE scope = 'bootstrap' AND idempotency_key = $1",
      [IDEMPOTENCY_KEY],
    );
    const outbox = await pool.query(
      "SELECT status, aggregate_ref, payload FROM outbox_events WHERE idempotency_scope = 'realtime.outbox' AND idempotency_key = $1",
      [IDEMPOTENCY_KEY],
    );
    assert.equal(ledger.rows[0]?.status, "committed");
    assert.deepEqual(outbox.rows[0]?.aggregate_ref, SESSION_REF);
    assert.equal(outbox.rows[0]?.status, "pending");
    return;
  } finally {
    await closePostgresPool(pool);
  }
}

function runCompose(action: "start" | "stop"): void {
  const composeFile = new URL("../../../infra/compose/data/postgres.compose.yaml", import.meta.url);
  execFileSync(DOCKER, ["compose", "-f", fileURLToPath(composeFile), "-p", PROJECT, action], {
    env: { ...process.env },
    stdio: "ignore",
  });
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pool = createPostgresPool();
    try {
      await pool.query("SELECT 1");
      await closePostgresPool(pool);
      return;
    } catch {
      await closePostgresPool(pool).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("POSTGRES_RESTART_TIMEOUT");
}

function runChild(phase: "write" | "read"): void {
  const file = fileURLToPath(import.meta.url);
  execFileSync(NODE, ["--experimental-strip-types", file], {
    env: { ...process.env, PAIOS_RESTART_CHILD: phase },
    stdio: "ignore",
  });
}

if (CHILD_PHASE !== undefined) {
  await runRestartChild(CHILD_PHASE);
} else {
  test("independent child processes preserve PostgreSQL authority across a real restart", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false }, async () => {
    runCompose("start");
    await waitForDatabase();
    const migrations = await Promise.all([
      readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"),
      readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"),
    ]);
    const setupPool = createPostgresPool();
    let before: string;
    try {
      for (const migration of migrations) await setupPool.query(migration);
      await setupPool.query("DELETE FROM outbox_events WHERE idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
      await setupPool.query("DELETE FROM realtime_terminal_facts WHERE idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
      await setupPool.query("DELETE FROM idempotency_ledger WHERE idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
      await setupPool.query("DELETE FROM realtime_transport_aliases WHERE session_ref_id = $1", [SESSION_REF_ID]).catch(() => undefined);
      await setupPool.query("DELETE FROM device_leases WHERE lease_ref_id = $1", [LEASE_REF_ID]).catch(() => undefined);
      await setupPool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [SESSION_REF_ID]).catch(() => undefined);
      before = String((await setupPool.query("SELECT pg_postmaster_start_time()::text AS started_at")).rows[0]?.started_at);
    } finally {
      await closePostgresPool(setupPool);
    }
    try {
      runChild("write");
      runCompose("stop");
      runCompose("start");
      await waitForDatabase();
      const afterPool = createPostgresPool();
      try {
        const after = String((await afterPool.query("SELECT pg_postmaster_start_time()::text AS started_at")).rows[0]?.started_at);
        assert.notEqual(after, before);
      } finally {
        await closePostgresPool(afterPool);
      }
      runChild("read");
    } finally {
      const cleanupPool = createPostgresPool();
      try {
        await cleanupPool.query("DELETE FROM outbox_events WHERE idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
        await cleanupPool.query("DELETE FROM realtime_terminal_facts WHERE idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
        await cleanupPool.query("DELETE FROM idempotency_ledger WHERE idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
        await cleanupPool.query("DELETE FROM realtime_transport_aliases WHERE session_ref_id = $1", [SESSION_REF_ID]).catch(() => undefined);
        await cleanupPool.query("DELETE FROM device_leases WHERE lease_ref_id = $1", [LEASE_REF_ID]).catch(() => undefined);
        await cleanupPool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [SESSION_REF_ID]).catch(() => undefined);
      } finally {
        await closePostgresPool(cleanupPool);
      }
      runCompose("stop");
    }
  });
}
