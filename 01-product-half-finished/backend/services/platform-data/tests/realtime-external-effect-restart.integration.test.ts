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
import { RealtimeExternalEffectCoordinator, type RealtimeMediaStopIntent } from "../src/realtime-external-effect-coordinator.ts";

const RUN = process.env.PAIOS_RUN_PG_EXTERNAL_EFFECT_RESTART === "1";
const CHILD_PHASE = process.env.PAIOS_EXTERNAL_EFFECT_RESTART_CHILD;
const SKIP_REASON = "set PAIOS_RUN_PG_EXTERNAL_EFFECT_RESTART=1 with the approved PAIOS_PG_* environment";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DOCKER = "G:\\安装文件\\DockerDesktop\\resources\\bin\\docker.exe";
const COMPOSE = new URL("../../../infra/compose/data/postgres.compose.yaml", import.meta.url);
const PROJECT = "paios-realtime-authority-001";
const HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY = "external-effect-restart-001";
const SESSION = Object.freeze({ ref_type: "RealtimeSession", ref_id: "71111111-1111-7111-8111-111111111111", object_version: "1", canonical_payload_sha256: HASH });
const LEASE = Object.freeze({ ref_type: "DeviceLease", ref_id: "72222222-2222-7222-8222-222222222222", object_version: "1", canonical_payload_sha256: HASH });

function intent(): RealtimeMediaStopIntent {
  return Object.freeze({
    wireRequest: { request_id: KEY, operation: "media_stop", idempotency_context: { idempotency_key: KEY } },
    request: { operation: "media_stop", idempotencyKey: KEY, expectedConnectionEpoch: "9007199254740995", expectedLeaseVersion: "9007199254740996", realtimeSessionRef: SESSION, deviceLeaseRef: LEASE },
    governance: { purpose: "restart-test" },
    fingerprint: "external-effect-restart-fingerprint",
  });
}

async function migration(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  for (const name of ["0001_idempotency_outbox.up.sql", "0002_realtime_authority.up.sql"]) {
    await pool.query(await readFile(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
}

async function cleanup(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  await pool.query("DELETE FROM outbox_events WHERE idempotency_key = $1", [KEY]).catch(() => undefined);
  await pool.query("DELETE FROM realtime_external_effects WHERE idempotency_key = $1", [KEY]).catch(() => undefined);
  await pool.query("DELETE FROM idempotency_ledger WHERE idempotency_key = $1", [KEY]).catch(() => undefined);
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
  throw new Error("EXTERNAL_EFFECT_RESTART_DATABASE_TIMEOUT");
}

function compose(action: "start" | "stop"): void {
  execFileSync(DOCKER, ["compose", "-f", fileURLToPath(COMPOSE), "-p", PROJECT, action], {
    env: { ...process.env },
    stdio: "ignore",
  });
}

async function runChild(phase: "write" | "read"): Promise<void> {
  const pool = createPostgresPool();
  const coordinator = new RealtimeExternalEffectCoordinator(pool, { executor: { async executeStage() {} } });
  try {
    if (phase === "write") {
      await migration(pool);
      await cleanup(pool);
      const stop = intent();
      const claim = await coordinator.claim({ idempotencyContext: { idempotency_key: KEY }, fingerprint: stop.fingerprint, intent: stop });
      assert.equal(claim.disposition, "claimed");
      if (claim.disposition !== "claimed") throw new Error("EXTERNAL_EFFECT_RESTART_CLAIM_FAILED");
      await coordinator.executeStage({ claimId: claim.claimId, stage: "tracks_unpublished", intent: stop });
      await coordinator.commit({ claimId: claim.claimId, fingerprint: stop.fingerprint, result: { status: "success", phase: "write" } });
      return;
    }
    const stop = intent();
    const replay = await coordinator.claim({ idempotencyContext: { idempotency_key: KEY }, fingerprint: stop.fingerprint, intent: stop });
    assert.deepEqual(replay, { disposition: "replay", result: { phase: "write", status: "success" } });
    const row = await pool.query("SELECT effect_state, fencing_epoch::text AS fencing_epoch, expected_connection_epoch::text AS expected_connection_epoch, stage_state, result FROM realtime_external_effects WHERE idempotency_key = $1", [KEY]);
    assert.equal(row.rows[0]?.effect_state, "committed");
    assert.equal(row.rows[0]?.fencing_epoch, "1");
    assert.equal(row.rows[0]?.expected_connection_epoch, "9007199254740995");
    assert.equal(row.rows[0]?.stage_state?.tracks_unpublished?.state, "completed");
    assert.deepEqual(row.rows[0]?.result, { phase: "write", status: "success" });
  } finally {
    await coordinator.close().catch(() => undefined);
    await closePostgresPool(pool);
  }
}

if (CHILD_PHASE !== undefined) {
  await runChild(CHILD_PHASE === "write" ? "write" : "read");
} else {
  test("independent processes and a PostgreSQL restart preserve external-effect replay", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
    const setup = createPostgresPool();
    try {
      compose("start");
      await waitForDatabase();
      await migration(setup);
      await cleanup(setup);
      const file = fileURLToPath(import.meta.url);
      execFileSync(NODE, ["--experimental-strip-types", file], { env: { ...process.env, PAIOS_EXTERNAL_EFFECT_RESTART_CHILD: "write" }, stdio: "ignore" });
      compose("stop");
      compose("start");
      await waitForDatabase();
      execFileSync(NODE, ["--experimental-strip-types", file], { env: { ...process.env, PAIOS_EXTERNAL_EFFECT_RESTART_CHILD: "read" }, stdio: "ignore" });
    } finally {
      compose("stop");
      await cleanup(setup).catch(() => undefined);
      await closePostgresPool(setup);
    }
  });
}
