import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertProductionMemoryIssuerReceipt,
  createProductionMemoryCanonicalIssuer,
  projectProductionMemoryIssuerReceipt,
  rehydrateProductionMemoryIssuerReceipt,
} from "../../../services/memory-os/src/canonical-issuer.ts";
import { assertSha256, canonicalRefKey, createCanonicalObjectVersionRef } from "../../../services/memory-os/src/canonical-ref.ts";
import { createPostgresPool, closePostgresPool, isPostgresConfigured } from "../src/postgres-pool.ts";
import { createMemoryAuthorityRepository } from "../src/memory-authority-repository.ts";
import { createMemoryDeletionRebuildRepository } from "../src/memory-deletion-rebuild-repository.ts";
import type { MemoryCanonicalReceiptCodec } from "../src/memory-persistence-primitives.ts";

const RUN_REQUESTED = process.env.PAIOS_RUN_PG_RESTART === "1" && process.env.PAIOS_RUN_PG_INTEGRATION === "1";
const RUN = RUN_REQUESTED && isPostgresConfigured();
const SKIP_REASON = "set approved PAIOS_PG_* credentials, PAIOS_PG_PORT=55440 and PAIOS_RUN_PG_RESTART=1";
const PORT = 55440;
const CONTAINER = "paios-memory-append-only-validation-003-postgres";
const RUNTIME_ROOT = "C:\\ProgramData\\PersonalAIOS\\paios-runtime-data\\memory-append-only-postgres-validation-003";
const EVIDENCE_ROOT = "C:\\ProgramData\\PersonalAIOS\\paios-runtime-evidence\\memory-append-only-postgres-validation-003";
const HASH = "a".repeat(64);
const USER = "memory-append-only-restart-003-user";
const SLOT = "memory-append-only-restart-003-slot";
const APPEND_KEY = "restart-003-memory";
const t05Codec: MemoryCanonicalReceiptCodec = Object.freeze({
  assertReceipt: assertProductionMemoryIssuerReceipt,
  projectReceipt: projectProductionMemoryIssuerReceipt,
  rehydrateReceipt: rehydrateProductionMemoryIssuerReceipt,
});

function assertRuntime003Guard(): void {
  assert.equal(process.env.PAIOS_PG_HOST, "127.0.0.1", "runtime003 requires loopback PostgreSQL");
  assert.equal(process.env.PAIOS_PG_PORT, String(PORT), "runtime003 requires explicit PAIOS_PG_PORT=55440");
  assert.equal(process.env.PAIOS_PG_DATABASE, "paios_memory_append_003", "runtime003 requires exact fixture database");
  assert.equal(process.env.PAIOS_PG_USER, "paios_memory_append_003", "runtime003 requires exact fixture user");
  assert.equal(process.env.PAIOS_RUNTIME_PROFILE, "memory-append-only-validation-003", "runtime003 requires exact profile binding");
  assert.equal(process.env.PAIOS_RUNTIME_DATA_ROOT, RUNTIME_ROOT, "runtime003 requires exact data-root binding");
  assert.equal(process.env.PAIOS_RUNTIME_EVIDENCE_ROOT, EVIDENCE_ROOT, "runtime003 requires exact evidence-root binding");
  assert.equal(process.env.PAIOS_RUNTIME_CONTAINER, CONTAINER, "runtime003 requires exact container binding");
}

function fixtureCandidate() {
  const evidenceRef = createCanonicalObjectVersionRef({ refType: "Observation", refId: "01900000-0000-7000-8000-000000004001", objectVersion: "1", canonicalPayloadSha256: assertSha256(HASH) });
  return {
    kind: "create" as const, status: "candidate" as const, proposalId: "restart-003-proposal", slot: SLOT,
    value: { text: "tea" }, evidenceRefs: [evidenceRef], sourceClass: "explicit_user_preference" as const,
    confidencePpm: 900_000, idempotencyKey: "restart-003-candidate", current: false as const,
    memoryKind: "preference_memory" as const, userId: USER, purposeScopes: ["conversation", "memory"],
    sensitivity: { classification: "normal" as const, userConfirmed: true }, validity: { observedAt: "2026-08-23T00:00:00.000Z" },
  };
}

test("independent child and PostgreSQL stop/start retain append-only heads and replay ledger", { skip: !RUN ? SKIP_REASON : false, concurrency: false }, async () => {
  assertRuntime003Guard();
  const pool = createPostgresPool({
    host: "127.0.0.1",
    port: PORT,
    database: process.env.PAIOS_PG_DATABASE!,
    user: process.env.PAIOS_PG_USER!,
    password: process.env.PAIOS_PG_PASSWORD!,
    applicationName: "memory-append-only-restart-integration",
  });
  try {
    const issuer = createProductionMemoryCanonicalIssuer({ nowMs: () => 1_700_000_080_000n });
    const item = fixtureCandidate();
    const candidateCreate = issuer.issueCandidate({ candidate: item, context: { systemTime: "2026-08-23T00:00:00.000000Z" } });
    const candidateSuccessor = issuer.issueCandidateSuccessor({ previous: candidateCreate, status: "accepted", context: { systemTime: "2026-08-23T00:00:00.000000Z", reviewedAt: "2026-08-23T00:00:01.000Z" } });
    const memoryCreate = issuer.issueMemory({ candidate: item, candidateReceipt: candidateSuccessor, resolvedContent: "User prefers tea", context: { systemTime: "2026-08-23T00:00:00.000000Z", createdAt: "2026-08-23T00:00:00.000000Z", updatedAt: "2026-08-23T00:00:01.000Z" } });
    const deletionCandidateSuccessor = issuer.issueCandidateSuccessor({ previous: candidateSuccessor, status: "accepted", context: { systemTime: "2026-08-23T00:00:00.000000Z", reviewedAt: "2026-08-23T00:00:02.000Z" } });
    const deletionMemorySuccessor = issuer.issueMemorySuccessor({ previous: memoryCreate, candidate: item, candidateReceipt: deletionCandidateSuccessor, resolvedContent: "User prefers tea", status: "deleted", context: { systemTime: "2026-08-23T00:00:00.000000Z", createdAt: "2026-08-23T00:00:00.000000Z", updatedAt: "2026-08-23T00:00:02.000Z" } });
    const repository = createMemoryAuthorityRepository(pool, { canonicalCodec: t05Codec });
    assert.equal((await repository.appendCanonical({ idempotencyKey: "restart-003-candidate", fingerprint: assertSha256(createHash("sha256").update("restart-003-candidate").digest("hex")), receipt: candidateCreate })).ok, true);
    assert.equal((await repository.appendCanonical({ idempotencyKey: APPEND_KEY, fingerprint: assertSha256(createHash("sha256").update(APPEND_KEY).digest("hex")), receipt: memoryCreate })).ok, true);
    const before = await pool.query("SELECT count(*)::text AS count FROM memory_slot_heads WHERE user_id = $1 AND slot = $2", [USER, SLOT]);
    assert.equal(before.rows[0]?.count, "1");
    const beforeFacts = await pool.query(
      "SELECT (SELECT count(*)::text FROM memory_candidates WHERE candidate_ref_id = $1 AND canonical_payload_jcs IS NOT NULL) AS candidate_rows, (SELECT count(*)::text FROM memory_versions WHERE memory_ref_id = $2 AND canonical_payload_jcs IS NOT NULL) AS version_rows, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key IN ($3, $4)) AS append_ledger_rows, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key IN ($3, $4)) AS append_outbox_rows",
      [candidateCreate.candidateRef!.refId, memoryCreate.memoryRef!.refId, "restart-003-candidate", APPEND_KEY],
    );
    assert.deepEqual(beforeFacts.rows[0], { candidate_rows: "2", version_rows: "1", append_ledger_rows: "2", append_outbox_rows: "2" });
    const childCode = `import assert from 'node:assert/strict'; import { createCanonicalObjectVersionRef, canonicalRefKey } from '../../services/memory-os/src/canonical-ref.ts'; import { assertProductionMemoryIssuerReceipt, projectProductionMemoryIssuerReceipt, rehydrateProductionMemoryIssuerReceipt } from '../../services/memory-os/src/canonical-issuer.ts'; import { createPostgresPool } from './src/postgres-pool.ts'; import { createMemoryAuthorityRepository } from './src/memory-authority-repository.ts'; const codec=Object.freeze({assertReceipt:assertProductionMemoryIssuerReceipt,projectReceipt:projectProductionMemoryIssuerReceipt,rehydrateReceipt:rehydrateProductionMemoryIssuerReceipt}); const user=process.env.PAIOS_RESTART_USER,slot=process.env.PAIOS_RESTART_SLOT; const p=createPostgresPool({host:process.env.PAIOS_PG_HOST,port:Number(process.env.PAIOS_PG_PORT),database:process.env.PAIOS_PG_DATABASE,user:process.env.PAIOS_PG_USER,password:process.env.PAIOS_PG_PASSWORD,max:1}); const r=await p.query("SELECT count(*)::text AS count FROM memory_slot_heads WHERE user_id=$1 AND slot=$2",[user,slot]); const h=(await p.query("SELECT h.memory_ref_type,h.memory_ref_id,h.memory_object_version,h.memory_payload_sha256 FROM memory_slot_heads h JOIN memory_versions v ON v.memory_ref_id=h.memory_ref_id AND v.memory_object_version=h.memory_object_version AND v.memory_payload_sha256=h.memory_payload_sha256 WHERE h.user_id=$1 AND h.slot=$2 AND v.canonical_payload_jcs IS NOT NULL",[user,slot])).rows[0]; assert.ok(h !== undefined,'CANONICAL_HEAD_MISSING'); const repo=createMemoryAuthorityRepository(p,{canonicalCodec:codec}); const read=await repo.readVersionByRef({ref:createCanonicalObjectVersionRef({refType:h.memory_ref_type,refId:h.memory_ref_id,objectVersion:h.memory_object_version,canonicalPayloadSha256:String(h.memory_payload_sha256).trim()})}); assert.ok(read.ok,'REHYDRATE_READ_FAILED'); if(!read.ok) throw new Error('REHYDRATE_READ_FAILED'); const projection=projectProductionMemoryIssuerReceipt(read.value.receipt); const restored=rehydrateProductionMemoryIssuerReceipt(projection); assert.equal(restored.canonicalPayloadJcs,read.value.receipt.canonicalPayloadJcs); assert.equal(restored.canonicalPayloadSha256,read.value.receipt.canonicalPayloadSha256); assert.equal(projection.projectionJcs,projectProductionMemoryIssuerReceipt(restored).projectionJcs); assert.equal(projection.projectionSha256,projectProductionMemoryIssuerReceipt(restored).projectionSha256); assert.deepEqual(projection.payload,read.value.receipt.payload); assert.deepEqual(restored.payload,read.value.payload); assert.deepEqual(restored.candidateRef,read.value.receipt.candidateRef); assert.deepEqual(restored.memoryRef,read.value.receipt.memoryRef); assert.deepEqual(restored.previousRef,read.value.receipt.previousRef); assert.deepEqual(restored.candidateReceipt,read.value.receipt.candidateReceipt); assert.equal(canonicalRefKey(restored.memoryRef ?? restored.candidateRef),canonicalRefKey(read.value.receipt.memoryRef ?? read.value.receipt.candidateRef)); assert.equal(r.rows[0].count,'1'); await p.end();`;
    const child = execFileSync("C:\\Program Files\\nodejs\\node.exe", ["--input-type=module", "-e", childCode], {
      cwd: "D:\\AI\\personal ai os\\services\\platform-data",
      env: { ...process.env, PAIOS_PG_HOST: "127.0.0.1", PAIOS_PG_PORT: String(PORT), PAIOS_RESTART_USER: USER, PAIOS_RESTART_SLOT: SLOT },
      encoding: "utf8",
    }).trim();
    assert.equal(child, before.rows[0]!.count);
    await closePostgresPool(pool);
    execFileSync("docker", ["stop", CONTAINER], { encoding: "utf8" });
    execFileSync("docker", ["start", CONTAINER], { encoding: "utf8" });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-U", process.env.PAIOS_PG_USER!, "-d", process.env.PAIOS_PG_DATABASE!], { stdio: "ignore" });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    assert.equal(ready, true, "PostgreSQL must become ready after the deliberate restart");
    const afterPool = createPostgresPool({
      host: "127.0.0.1",
      port: PORT,
      database: process.env.PAIOS_PG_DATABASE!,
      user: process.env.PAIOS_PG_USER!,
      password: process.env.PAIOS_PG_PASSWORD!,
      applicationName: "memory-append-only-restart-after-pg-start",
    });
    const afterRepository = createMemoryAuthorityRepository(afterPool, { canonicalCodec: t05Codec });
    const after = await afterPool.query("SELECT count(*)::text AS count FROM memory_slot_heads WHERE user_id = $1 AND slot = $2", [USER, SLOT]);
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
    const afterFacts = await afterPool.query(
      "SELECT (SELECT count(*)::text FROM memory_candidates WHERE candidate_ref_id = $1 AND canonical_payload_jcs IS NOT NULL) AS candidate_rows, (SELECT count(*)::text FROM memory_versions WHERE memory_ref_id = $2 AND canonical_payload_jcs IS NOT NULL) AS version_rows, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key IN ($3, $4)) AS append_ledger_rows, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key IN ($3, $4)) AS append_outbox_rows",
      [candidateCreate.candidateRef!.refId, memoryCreate.memoryRef!.refId, "restart-003-candidate", APPEND_KEY],
    );
    assert.deepEqual(afterFacts.rows[0], beforeFacts.rows[0]);
    assert.deepEqual(afterFacts.rows[0], { candidate_rows: "2", version_rows: "1", append_ledger_rows: "2", append_outbox_rows: "2" });
    const head = (await afterPool.query("SELECT h.memory_ref_type, h.memory_ref_id, h.memory_object_version, h.memory_payload_sha256 FROM memory_slot_heads h JOIN memory_versions v ON v.memory_ref_id = h.memory_ref_id AND v.memory_object_version = h.memory_object_version AND v.memory_payload_sha256 = h.memory_payload_sha256 WHERE h.user_id = $1 AND h.slot = $2 AND v.canonical_payload_jcs IS NOT NULL", [USER, SLOT])).rows[0];
    assert.ok(head !== undefined, "restart fixture must retain canonical head");
    const replayLedger = (await afterPool.query(
      "SELECT idempotency_key, request_hash FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND response->'headRef'->>'refId' = $1 ORDER BY idempotency_key LIMIT 1",
      [head.memory_ref_id],
    )).rows[0];
    assert.ok(replayLedger !== undefined, "restart fixture must retain canonical append ledger");
    const read = await afterRepository.readVersionByRef({
      ref: createCanonicalObjectVersionRef({
        refType: head.memory_ref_type,
        refId: head.memory_ref_id,
        objectVersion: head.memory_object_version,
        canonicalPayloadSha256: String(head.memory_payload_sha256).trim(),
      }),
    });
    assert.ok(read.ok, "restart fixture canonical head must be readable");
    if (!read.ok) throw new Error("RESTART_CANONICAL_HEAD_READ_FAILED");
    const projected = projectProductionMemoryIssuerReceipt(read.value.receipt);
    const restored = rehydrateProductionMemoryIssuerReceipt(projected);
    assert.equal(restored.canonicalPayloadJcs, read.value.receipt.canonicalPayloadJcs);
    assert.equal(restored.canonicalPayloadSha256, read.value.receipt.canonicalPayloadSha256);
    assert.deepEqual(restored.payload, read.value.payload);
    assert.deepEqual(restored.candidateRef, read.value.receipt.candidateRef);
    assert.deepEqual(restored.memoryRef, read.value.receipt.memoryRef);
    assert.deepEqual(restored.previousRef, read.value.receipt.previousRef);
    assert.deepEqual(restored.candidateReceipt, read.value.receipt.candidateReceipt);
    assert.equal(canonicalRefKey(restored.memoryRef ?? restored.candidateRef), canonicalRefKey(read.value.receipt.memoryRef ?? read.value.receipt.candidateRef));
    assert.deepEqual(projected, projectProductionMemoryIssuerReceipt(restored));
    const replay = await afterRepository.appendCanonical({
      idempotencyKey: String(replayLedger.idempotency_key),
      fingerprint: String(replayLedger.request_hash).trim() as never,
      receipt: read.value.receipt,
    });
    assert.equal(replay.ok, true);
    const differentKey = await afterRepository.appendCanonical({
      idempotencyKey: `${String(replayLedger.idempotency_key)}:restart-different`,
      fingerprint: assertSha256(createHash("sha256").update(`${String(replayLedger.request_hash).trim()}:restart-different`).digest("hex")),
      receipt: read.value.receipt,
    });
    assert.equal(differentKey.ok, false);
    if (!differentKey.ok) assert.equal(differentKey.error.code, "IDEMPOTENCY_CONFLICT");
    const replayedFacts = await afterPool.query(
      "SELECT (SELECT count(*)::text FROM memory_candidates WHERE candidate_ref_id = $1 AND canonical_payload_jcs IS NOT NULL) AS candidate_rows, (SELECT count(*)::text FROM memory_versions WHERE memory_ref_id = $2 AND canonical_payload_jcs IS NOT NULL) AS version_rows, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key IN ($3, $4)) AS append_ledger_rows, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key IN ($3, $4)) AS append_outbox_rows",
      [candidateCreate.candidateRef!.refId, memoryCreate.memoryRef!.refId, "restart-003-candidate", APPEND_KEY],
    );
    assert.deepEqual(replayedFacts.rows[0], afterFacts.rows[0]);
    assert.deepEqual(replayedFacts.rows[0], { candidate_rows: "2", version_rows: "1", append_ledger_rows: "2", append_outbox_rows: "2" });
    const persistedLedger = await afterPool.query(
      "SELECT count(*)::text AS count FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key = $1",
      [String(replayLedger.idempotency_key)],
    );
    assert.equal(persistedLedger.rows[0]?.count, "1");
    const persistedOutbox = await afterPool.query(
      "SELECT count(*)::text AS count FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1",
      [String(replayLedger.idempotency_key)],
    );
    assert.equal(persistedOutbox.rows[0]?.count, "1");
    const deletionRepository = createMemoryDeletionRebuildRepository(afterPool, { canonicalCodec: t05Codec });
    const deletionJobRef = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000004099", objectVersion: "1", canonicalPayloadSha256: assertSha256(HASH) });
    const missingKey = "restart-003-deletion-missing-successor";
    const missingBefore = await afterPool.query("SELECT (SELECT count(*)::text FROM memory_deletion_mutations WHERE idempotency_key = $1) AS mutations, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = $1) AS ledger, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1) AS outbox", [missingKey]);
    assert.deepEqual(missingBefore.rows[0], { mutations: "0", ledger: "0", outbox: "0" });
    const missing = await deletionRepository.applyDeletionMutations({
      idempotencyKey: missingKey,
      fingerprint: assertSha256(createHash("sha256").update(missingKey).digest("hex")),
      projections: [{ deletionJobRef, targetRef: memoryCreate.memoryRef!, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "DELETION_SUCCESSOR_REQUIRED");
    const missingAfter = await afterPool.query("SELECT (SELECT count(*)::text FROM memory_deletion_mutations WHERE idempotency_key = $1) AS mutations, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = $1) AS ledger, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1) AS outbox", [missingKey]);
    assert.deepEqual(missingAfter.rows[0], missingBefore.rows[0]);
    const deletionKey = "restart-003-deletion-composite";
    const deletionInput = {
      idempotencyKey: deletionKey,
      fingerprint: assertSha256(createHash("sha256").update(deletionKey).digest("hex")),
      projections: [{ deletionJobRef, targetRef: memoryCreate.memoryRef!, targetStatus: "deleted" as const, targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
      successors: [{ targetRef: memoryCreate.memoryRef!, receipt: deletionMemorySuccessor }],
    };
    const deletionBefore = await afterPool.query("SELECT (SELECT count(*)::text FROM memory_deletion_mutations WHERE idempotency_key = $1) AS mutations, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = $1) AS ledger, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1) AS outbox", [deletionKey]);
    assert.deepEqual(deletionBefore.rows[0], { mutations: "0", ledger: "0", outbox: "0" });
    const deletion = await deletionRepository.applyDeletionMutations(deletionInput);
    assert.equal(deletion.ok, true);
    const deletionCommitted = await afterPool.query("SELECT (SELECT count(*)::text FROM memory_deletion_mutations WHERE idempotency_key = $1) AS mutations, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = $1) AS ledger, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1) AS outbox", [deletionKey]);
    assert.deepEqual(deletionCommitted.rows[0], { mutations: "1", ledger: "1", outbox: "1" });
    const deletionReplay = await deletionRepository.applyDeletionMutations(deletionInput);
    assert.equal(deletionReplay.ok, true);
    const deletedHead = (await afterPool.query("SELECT h.memory_ref_type, h.memory_ref_id, h.memory_object_version, h.memory_payload_sha256 FROM memory_slot_heads h WHERE h.user_id = $1 AND h.slot = $2", [USER, SLOT])).rows[0];
    assert.ok(deletedHead !== undefined, "deletion successor must become the durable head");
    assert.equal(deletedHead.memory_ref_type, deletionMemorySuccessor.memoryRef!.refType);
    assert.equal(deletedHead.memory_ref_id, deletionMemorySuccessor.memoryRef!.refId);
    assert.equal(String(deletedHead.memory_object_version), deletionMemorySuccessor.memoryRef!.objectVersion);
    assert.equal(String(deletedHead.memory_payload_sha256).trim(), deletionMemorySuccessor.memoryRef!.canonicalPayloadSha256);
    const deletedRead = await afterRepository.readVersionByRef({ ref: deletionMemorySuccessor.memoryRef! });
    assert.ok(deletedRead.ok, "deletion successor must be readable after replay");
    if (!deletedRead.ok) throw new Error("DELETION_SUCCESSOR_READ_FAILED");
    assert.equal(deletedRead.value.receipt.canonicalPayloadJcs, deletionMemorySuccessor.canonicalPayloadJcs);
    assert.equal(deletedRead.value.receipt.canonicalPayloadSha256, deletionMemorySuccessor.canonicalPayloadSha256);
    assert.deepEqual(deletedRead.value.receipt.memoryRef, deletionMemorySuccessor.memoryRef);
    assert.deepEqual(deletedRead.value.receipt.previousRef, deletionMemorySuccessor.previousRef);
    assert.deepEqual(deletedRead.value.receipt.candidateReceipt, deletionMemorySuccessor.candidateReceipt);
    assert.equal(deletedRead.value.payload.status, "deleted");
    const deletionAfter = await afterPool.query("SELECT (SELECT count(*)::text FROM memory_deletion_mutations WHERE idempotency_key = $1) AS mutations, (SELECT count(*)::text FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = $1) AS ledger, (SELECT count(*)::text FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1) AS outbox", [deletionKey]);
    assert.deepEqual(deletionAfter.rows[0], deletionCommitted.rows[0]);
    assert.deepEqual(deletionAfter.rows[0], { mutations: "1", ledger: "1", outbox: "1" });
    await closePostgresPool(afterPool);
  } finally {
    // The pool may already be closed after the deliberate PostgreSQL restart.
    try { await closePostgresPool(pool); } catch { /* preserve restart evidence */ }
  }
});
