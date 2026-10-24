import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  closePostgresPool,
  createPostgresPool,
  isPostgresConfigured,
} from "../src/postgres-pool.ts";
import {
  RealtimeExternalEffectCoordinator,
  type RealtimeMediaStopIntent,
} from "../src/realtime-external-effect-coordinator.ts";
import { createRealtimeCredentialFence, type CredentialFenceTuple } from "../src/realtime-credential-fence.ts";

const RUN = process.env.PAIOS_RUN_PG_EXTERNAL_EFFECTS === "1";
const SKIP_REASON = "set PAIOS_RUN_PG_EXTERNAL_EFFECTS=1 with the approved PAIOS_PG_* environment";
const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION = Object.freeze({ ref_type: "RealtimeSession", ref_id: "61111111-1111-7111-8111-111111111111", object_version: "1", canonical_payload_sha256: HASH });
const LEASE = Object.freeze({ ref_type: "DeviceLease", ref_id: "62222222-2222-7222-8222-222222222222", object_version: "1", canonical_payload_sha256: HASH });
const PREFIX = "external-effect-pg-001";

function intent(key: string, fingerprint = `pg-fingerprint-${key}`): RealtimeMediaStopIntent {
  return Object.freeze({
    wireRequest: { request_id: key, operation: "media_stop", idempotency_context: { idempotency_key: key } },
    request: {
      operation: "media_stop", idempotencyKey: key, expectedConnectionEpoch: "9007199254740993",
      expectedLeaseVersion: "9007199254740994", credentialGeneration: "9007199254740995",
      continuityId: `continuity-${key}`, realtimeSessionRef: SESSION, deviceLeaseRef: LEASE,
    },
    governance: { purpose: "conversation" },
    fingerprint,
  });
}

function fenceTuple(key: string): CredentialFenceTuple {
  return Object.freeze({
    realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE,
    continuityId: `continuity-${key}`,
    connectionEpoch: "9007199254740993",
    credentialGeneration: "9007199254740995",
  });
}

async function applyMigrations(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  const base = await pool.query("SELECT to_regclass('public.realtime_external_effects') AS table_name");
  if (base.rows[0]?.table_name === null || base.rows[0]?.table_name === undefined) {
    for (const name of ["0001_idempotency_outbox.up.sql", "0002_realtime_authority.up.sql"]) {
      await pool.query(await readFile(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
    }
  }
  const columns = await pool.query(
    "SELECT count(*)::int AS count FROM pg_catalog.pg_attribute WHERE attrelid = 'public.realtime_external_effects'::regclass AND attname IN ('realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch', 'credential_generation') AND attnum > 0 AND NOT attisdropped",
  );
  if (columns.rows[0]?.count === 0) {
    await pool.query(await readFile(new URL("../../../migrations/0008_realtime_credential_fence.up.sql", import.meta.url), "utf8"));
  } else {
    assert.equal(columns.rows[0]?.count, 5);
  }
}

async function cleanup(pool: ReturnType<typeof createPostgresPool>): Promise<void> {
  await pool.query("DELETE FROM outbox_events WHERE idempotency_scope LIKE 'realtime.external.%' AND idempotency_key LIKE $1", [`${PREFIX}%`]);
  await pool.query("DELETE FROM realtime_external_effects WHERE idempotency_key LIKE $1", [`${PREFIX}%`]);
  await pool.query("DELETE FROM idempotency_ledger WHERE scope LIKE 'realtime.external.%' AND idempotency_key LIKE $1", [`${PREFIX}%`]);
}

test("real PostgreSQL external-effect claim/stage/commit/replay is one durable fence", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const calls: string[] = [];
  const key = `${PREFIX}-media`;
  const stop = intent(key);
  const coordinator = new RealtimeExternalEffectCoordinator(pool, {
    executor: {
      async executeStage({ stage }) { calls.push(stage); },
    },
  });
  try {
    await applyMigrations(pool);
    await cleanup(pool);
    const claim = await coordinator.claim({ idempotencyContext: { idempotency_key: key }, fingerprint: stop.fingerprint, intent: stop });
    assert.equal(claim.disposition, "claimed");
    if (claim.disposition !== "claimed") throw new Error("PG claim failed");
    await coordinator.executeStage({ claimId: claim.claimId, stage: "tracks_unpublished", intent: stop });
    await coordinator.executeStage({ claimId: claim.claimId, stage: "tracks_unpublished", intent: stop });
    await coordinator.commit({ claimId: claim.claimId, fingerprint: stop.fingerprint, result: { status: "success", evidence: "pg" } });
    const replay = await coordinator.claim({ idempotencyContext: { idempotency_key: key }, fingerprint: stop.fingerprint, intent: stop });
    assert.deepEqual(replay, { disposition: "replay", result: { evidence: "pg", status: "success" } });
    assert.deepEqual(calls, ["tracks_unpublished"]);
    const rows = await pool.query(
      "SELECT effect_state, fencing_epoch::text AS fencing_epoch, expected_connection_epoch::text AS expected_connection_epoch, credential_generation::text AS credential_generation, realtime_session_ref, device_lease_ref, continuity_id, connection_epoch::text AS connection_epoch, stage_state, result, result_sha256 FROM realtime_external_effects WHERE request_scope = $1 AND idempotency_key = $2",
      ["realtime.external.media_stop", key],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.effect_state, "committed");
    assert.equal(rows.rows[0]?.fencing_epoch, "1");
    assert.equal(rows.rows[0]?.expected_connection_epoch, "9007199254740993");
    assert.equal(rows.rows[0]?.credential_generation, "9007199254740995");
    assert.deepEqual(rows.rows[0]?.realtime_session_ref, SESSION);
    assert.deepEqual(rows.rows[0]?.device_lease_ref, LEASE);
    assert.equal(rows.rows[0]?.continuity_id, `continuity-${key}`);
    assert.equal(rows.rows[0]?.connection_epoch, "9007199254740993");
    assert.equal(rows.rows[0]?.stage_state?.tracks_unpublished?.state, "completed");
    assert.deepEqual(rows.rows[0]?.result, { evidence: "pg", status: "success" });
    const outbox = await pool.query(
      "SELECT event_type, count(*)::int AS count FROM outbox_events WHERE idempotency_scope = $1 AND idempotency_key = $2 GROUP BY event_type ORDER BY event_type",
      ["realtime.external.media_stop", key],
    );
    assert.deepEqual(outbox.rows.map((row) => [row.event_type, row.count]), [
      ["realtime.external_effect.claimed", 1],
      ["realtime.external_effect.committed", 1],
      ["realtime.external_effect.stage_completed:tracks_unpublished", 1],
    ]);
  } finally {
    await coordinator.close().catch(() => undefined);
    await cleanup(pool).catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("real PostgreSQL preserves completed stage evidence across release and reclaims only pending work", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const calls: string[] = [];
  const key = `${PREFIX}-reclaim`;
  const stop = intent(key);
  const coordinator = new RealtimeExternalEffectCoordinator(pool, {
    executor: { async executeStage({ stage }) { calls.push(stage); } },
  });
  try {
    await applyMigrations(pool);
    await cleanup(pool);
    const first = await coordinator.claim({ idempotencyContext: { idempotency_key: key }, fingerprint: stop.fingerprint, intent: stop });
    assert.equal(first.disposition, "claimed");
    if (first.disposition !== "claimed") throw new Error("PG claim failed");
    await coordinator.executeStage({ claimId: first.claimId, stage: "tracks_unpublished", intent: stop });
    await coordinator.release({ claimId: first.claimId, fingerprint: stop.fingerprint });
    const second = await coordinator.claim({ idempotencyContext: { idempotency_key: key }, fingerprint: stop.fingerprint, intent: stop });
    assert.equal(second.disposition, "claimed");
    if (second.disposition !== "claimed") throw new Error("PG reclaim failed");
    await coordinator.executeStage({ claimId: second.claimId, stage: "tracks_unpublished", intent: stop });
    await coordinator.executeStage({ claimId: second.claimId, stage: "participant_disconnected", intent: stop });
    assert.deepEqual(calls, ["tracks_unpublished", "participant_disconnected"]);
    const row = await pool.query("SELECT fencing_epoch::text AS fencing_epoch, expected_connection_epoch::text AS expected_connection_epoch, credential_generation::text AS credential_generation, continuity_id, stage_state FROM realtime_external_effects WHERE idempotency_key = $1", [key]);
    assert.equal(row.rows[0]?.fencing_epoch, "2");
    assert.equal(row.rows[0]?.expected_connection_epoch, "9007199254740993");
    assert.equal(row.rows[0]?.credential_generation, "9007199254740995");
    assert.equal(row.rows[0]?.continuity_id, `continuity-${key}`);
    assert.equal(row.rows[0]?.stage_state?.tracks_unpublished?.state, "completed");
    assert.equal(row.rows[0]?.stage_state?.participant_disconnected?.state, "completed");
  } finally {
    await coordinator.close().catch(() => undefined);
    await cleanup(pool).catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("real PostgreSQL serializes tuple admission, claim, and rollback", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const key = `${PREFIX}-lock`;
  const stop = intent(key);
  const tuple = fenceTuple(key);
  const coordinator = new RealtimeExternalEffectCoordinator(pool, {
    executor: { async executeStage() {} },
  });
  const fence = createRealtimeCredentialFence(pool);
  try {
    await applyMigrations(pool);
    await cleanup(pool);
    let entered = false;
    let releaseAdmission: (() => void) | undefined;
    const admissionHeld = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const admission = fence.withAdmission(tuple, async () => {
      entered = true;
      await admissionHeld;
      return "admitted";
    });
    while (!entered) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let claimResolved = false;
    const claimPromise = coordinator.claim({
      idempotencyContext: { idempotency_key: key },
      fingerprint: stop.fingerprint,
      intent: stop,
    }).finally(() => { claimResolved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(claimResolved, false);
    releaseAdmission?.();
    assert.equal(await admission, "admitted");
    const claim = await claimPromise;
    assert.equal(claim.disposition, "claimed");
    if (claim.disposition !== "claimed") throw new Error("PG lock claim failed");
    assert.equal((await fence.verify(tuple)).active, true);
    await coordinator.release({ claimId: claim.claimId, fingerprint: stop.fingerprint });
    await assert.rejects(
      () => fence.withAdmission(tuple, async () => { throw new Error("fixture rollback"); }),
      /fixture rollback/,
    );
    assert.equal(await fence.withAdmission(tuple, async () => "after-rollback"), "after-rollback");
  } finally {
    await coordinator.close().catch(() => undefined);
    await fence.close().catch(() => undefined);
    await cleanup(pool).catch(() => undefined);
    await closePostgresPool(pool);
  }
});
