import assert from "node:assert/strict";
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

const RUN_REQUESTED = process.env.PAIOS_RUN_PG_INTEGRATION === "1";
const RUN = RUN_REQUESTED && isPostgresConfigured();
const SKIP_REASON = "set approved disposable PAIOS_PG_* credentials and PAIOS_RUN_PG_INTEGRATION=1";
const PORT = Number(process.env.PAIOS_PG_PORT);
const USER = `memory-append-only-pg-${process.pid}-${Date.now()}`;
const HASH = "a".repeat(64);

const t05Codec: MemoryCanonicalReceiptCodec = Object.freeze({
  assertReceipt: assertProductionMemoryIssuerReceipt,
  projectReceipt: projectProductionMemoryIssuerReceipt,
  rehydrateReceipt: rehydrateProductionMemoryIssuerReceipt,
});

function assertDisposableBinding(): void {
  assert.equal(process.env.PAIOS_PG_HOST, "127.0.0.1");
  assert.ok(Number.isSafeInteger(PORT) && PORT >= 1024 && PORT !== 5432 && PORT !== 55432,
    "explicit disposable PostgreSQL port required");
}

function candidate() {
  const evidenceRef = createCanonicalObjectVersionRef({
    refType: "Observation",
    refId: "01900000-0000-7000-8000-000000000001",
    objectVersion: "1",
    canonicalPayloadSha256: assertSha256(HASH),
  });
  return {
    kind: "create" as const,
    status: "candidate" as const,
    proposalId: "append-pg-proposal",
    slot: "append.pg.slot",
    value: { text: "tea" },
    evidenceRefs: [evidenceRef],
    sourceClass: "explicit_user_preference" as const,
    confidencePpm: 900_000,
    idempotencyKey: "append-pg-candidate",
    current: false as const,
    memoryKind: "preference_memory" as const,
    userId: USER,
    purposeScopes: ["conversation", "memory"],
    sensitivity: { classification: "normal" as const, userConfirmed: true },
    validity: { observedAt: "2026-08-23T00:00:00.000Z" },
  };
}

test("real PG append-only lifecycle preserves exact bytes, head CAS, and replay", { skip: !RUN ? SKIP_REASON : false, concurrency: false }, async () => {
  assertDisposableBinding();
  const pool = createPostgresPool({
    host: "127.0.0.1",
    port: PORT,
    database: process.env.PAIOS_PG_DATABASE!,
    user: process.env.PAIOS_PG_USER!,
    password: process.env.PAIOS_PG_PASSWORD!,
    applicationName: "memory-append-only-pg-integration",
  });
  const issuer = createProductionMemoryCanonicalIssuer({ nowMs: () => 1_700_000_060_000n });
  const item = candidate();
  const candidateCreate = issuer.issueCandidate({ candidate: item, context: { systemTime: "2026-08-23T00:00:00.000000Z" } });
  const candidateSuccessor = issuer.issueCandidateSuccessor({ previous: candidateCreate, status: "accepted", context: { systemTime: "2026-08-23T00:00:00.000000Z", reviewedAt: "2026-08-23T00:00:01.000Z" } });
  const memoryCreate = issuer.issueMemory({ candidate: item, candidateReceipt: candidateSuccessor, resolvedContent: "User prefers tea", context: { systemTime: "2026-08-23T00:00:00.000000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:01.000Z" } });
  const deletionCandidateSuccessor = issuer.issueCandidateSuccessor({ previous: candidateSuccessor, status: "accepted", context: { systemTime: "2026-08-23T00:00:00.000000Z", reviewedAt: "2026-08-23T00:00:02.000Z" } });
  const deletionMemorySuccessor = issuer.issueMemorySuccessor({
    previous: memoryCreate,
    candidate: item,
    candidateReceipt: deletionCandidateSuccessor,
    resolvedContent: "User prefers tea",
    status: "deleted",
    context: { systemTime: "2026-08-23T00:00:00.000000Z", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:02.000Z", deletedAt: "2026-08-23T00:00:02.000Z" },
  });
  const legacyTargetRef = createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000009997", objectVersion: "1", canonicalPayloadSha256: assertSha256(HASH) });
  const repository = createMemoryAuthorityRepository(pool, { canonicalCodec: t05Codec });
  try {
    await pool.query("DELETE FROM memory_slot_heads WHERE user_id = $1", [USER]);
    await pool.query("DELETE FROM memory_candidate_heads WHERE candidate_ref_id = $1", [candidateCreate.candidateRef!.refId]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key LIKE $1", [`append-pg-%`]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key LIKE $1", [`append-pg-%`]);
    await pool.query("DELETE FROM memory_deletion_mutations WHERE idempotency_key LIKE $1", [`append-pg-deletion-%`]);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key LIKE $1", [`append-pg-%`]);

    const candidateResult = await repository.appendCanonical({ idempotencyKey: "append-pg-candidate", fingerprint: assertSha256(createHash("sha256").update("append-pg-candidate").digest("hex")), receipt: candidateCreate });
    assert.equal(candidateResult.ok, true);
    const memoryResult = await repository.appendCanonical({ idempotencyKey: "append-pg-memory", fingerprint: assertSha256(createHash("sha256").update("append-pg-memory").digest("hex")), receipt: memoryCreate });
    assert.equal(memoryResult.ok, true);
    if (!memoryResult.ok) return;
    const read = await repository.readVersionByRef({ ref: memoryCreate.memoryRef! });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.receipt.canonicalPayloadJcs, memoryCreate.canonicalPayloadJcs);
    assert.deepEqual(read.value.payload, memoryCreate.payload);

    const replay = await repository.appendCanonical({ idempotencyKey: "append-pg-memory", fingerprint: assertSha256(createHash("sha256").update("append-pg-memory").digest("hex")), receipt: memoryCreate });
    assert.equal(replay.ok, true);
    assert.deepEqual(replay, memoryResult);
    const sameKeyFingerprintDrift = await repository.appendCanonical({ idempotencyKey: "append-pg-memory", fingerprint: assertSha256(createHash("sha256").update("append-pg-memory-drift").digest("hex")), receipt: memoryCreate });
    assert.equal(sameKeyFingerprintDrift.ok, false);
    if (!sameKeyFingerprintDrift.ok) assert.equal(sameKeyFingerprintDrift.error.code, "IDEMPOTENCY_CONFLICT");
    const differentKeyExactDuplicate = await repository.appendCanonical({ idempotencyKey: "append-pg-memory-different-key", fingerprint: assertSha256(createHash("sha256").update("append-pg-memory-different-key").digest("hex")), receipt: memoryCreate });
    assert.equal(differentKeyExactDuplicate.ok, false);
    if (!differentKeyExactDuplicate.ok) assert.equal(differentKeyExactDuplicate.error.code, "IDEMPOTENCY_CONFLICT");
    const staleHead = await repository.appendCanonical({
      idempotencyKey: "append-pg-memory-stale-head",
      fingerprint: assertSha256(createHash("sha256").update("append-pg-memory-stale-head").digest("hex")),
      receipt: deletionMemorySuccessor,
      expectedHeadRef: createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000009999", objectVersion: "1", canonicalPayloadSha256: assertSha256(HASH) }),
    });
    assert.equal(staleHead.ok, false);
    if (!staleHead.ok) assert.equal(staleHead.error.code, "CURRENT_VERSION_CONFLICT");

    const rows = await pool.query("SELECT canonical_payload_jcs, canonical_payload, canonical_receipt_projection, canonical_receipt_projection_jcs, canonical_receipt_projection_sha256 FROM memory_versions WHERE memory_ref_id = $1 AND memory_object_version = $2", [memoryCreate.memoryRef!.refId, memoryCreate.memoryRef!.objectVersion]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.canonical_payload_jcs, memoryCreate.canonicalPayloadJcs);
    const projection = projectProductionMemoryIssuerReceipt(memoryCreate);
    assert.equal(rows.rows[0]!.canonical_receipt_projection_jcs, projection.projectionJcs);
    assert.equal(rows.rows[0]!.canonical_receipt_projection_sha256, projection.projectionSha256);
    assert.deepEqual(rows.rows[0]!.canonical_receipt_projection, projection);
    assert.equal(JSON.stringify(rows.rows[0]!.canonical_payload).includes("User prefers tea"), true);
    const heads = await pool.query("SELECT memory_ref_id, memory_object_version FROM memory_slot_heads WHERE user_id = $1 AND slot = $2", [USER, "append.pg.slot"]);
    assert.deepEqual(heads.rows.map((row) => `${row.memory_ref_id}:${row.memory_object_version}`), [`${memoryCreate.memoryRef!.refId}:${memoryCreate.memoryRef!.objectVersion}`]);
    assert.equal(canonicalRefKey(memoryCreate.memoryRef!), `${memoryCreate.memoryRef!.refType}:${memoryCreate.memoryRef!.refId}:${memoryCreate.memoryRef!.objectVersion}:${memoryCreate.memoryRef!.canonicalPayloadSha256}`);
    const memoryLedger = await pool.query("SELECT count(*)::text AS count FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key = $1", ["append-pg-memory"]);
    assert.equal(memoryLedger.rows[0]?.count, "1");
    const memoryOutbox = await pool.query("SELECT count(*)::text AS count FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1", ["append-pg-memory"]);
    assert.equal(memoryOutbox.rows[0]?.count, "1");

    const deletionRepository = createMemoryDeletionRebuildRepository(pool, { canonicalCodec: t05Codec });
    const legacyDeletionJobRef = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000009996", objectVersion: "1", canonicalPayloadSha256: assertSha256(HASH) });
    await pool.query("DELETE FROM memory_versions WHERE memory_ref_id = $1", [legacyTargetRef.refId]);
    await pool.query("INSERT INTO memory_versions (memory_ref, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, user_id, kind, slot, value, resolved_content, status, current, source_class, evidence_refs, confidence_ppm, allowed_purpose_scopes, sensitivity, validity) VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'current', TRUE, 'explicit_user_preference', $11::jsonb, 950000, $12::jsonb, $13::jsonb, $14::jsonb)", [JSON.stringify(legacyTargetRef), legacyTargetRef.refType, legacyTargetRef.refId, legacyTargetRef.objectVersion, HASH, USER, "preference_memory", "append.pg.legacy.slot", JSON.stringify({ text: "legacy" }), "legacy", JSON.stringify([]), JSON.stringify(["conversation"]), JSON.stringify({ classification: "normal", userConfirmed: true }), JSON.stringify({ observedAt: "2026-08-23T00:00:00.000Z" })]);
    const legacyDeletion = await deletionRepository.applyDeletionMutations({
      idempotencyKey: "append-pg-deletion-legacy",
      fingerprint: assertSha256(createHash("sha256").update("append-pg-deletion-legacy").digest("hex")),
      projections: [{ deletionJobRef: legacyDeletionJobRef, targetRef: legacyTargetRef, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
    });
    assert.equal(legacyDeletion.ok, true);
    const legacyRow = await pool.query("SELECT canonical_payload_jcs, status, current, stale FROM memory_versions WHERE memory_ref_id = $1", [legacyTargetRef.refId]);
    assert.equal(legacyRow.rows[0]?.canonical_payload_jcs, null);
    assert.equal(legacyRow.rows[0]?.status, "deleted");
    assert.equal(legacyRow.rows[0]?.current, false);
    assert.equal(legacyRow.rows[0]?.stale, true);
    const deletionJobRef = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000009998", objectVersion: "1", canonicalPayloadSha256: assertSha256(HASH) });
    const deletionInput = {
      idempotencyKey: "append-pg-deletion-composite",
      fingerprint: assertSha256(createHash("sha256").update("append-pg-deletion-composite").digest("hex")),
      projections: [{ deletionJobRef, targetRef: memoryCreate.memoryRef!, targetStatus: "deleted" as const, targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
      successors: [{ targetRef: memoryCreate.memoryRef!, receipt: deletionMemorySuccessor }],
    };
    const deletionResult = await deletionRepository.applyDeletionMutations(deletionInput);
    assert.equal(deletionResult.ok, true);
    const deletionReplay = await deletionRepository.applyDeletionMutations(deletionInput);
    assert.equal(deletionReplay.ok, true);
    if (deletionResult.ok && deletionReplay.ok) assert.deepEqual(deletionReplay, deletionResult);
    const deletionHead = await pool.query("SELECT memory_ref_id, memory_object_version, memory_payload_sha256 FROM memory_slot_heads WHERE user_id = $1 AND slot = $2", [USER, "append.pg.slot"]);
    assert.deepEqual(deletionHead.rows.map((row) => `${row.memory_ref_id}:${row.memory_object_version}:${row.memory_payload_sha256}`), [`${deletionMemorySuccessor.memoryRef!.refId}:${deletionMemorySuccessor.memoryRef!.objectVersion}:${deletionMemorySuccessor.memoryRef!.canonicalPayloadSha256}`]);
    const deletionLedger = await pool.query("SELECT count(*)::text AS count FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = $1", [deletionInput.idempotencyKey]);
    assert.equal(deletionLedger.rows[0]?.count, "1");
    const deletionOutbox = await pool.query("SELECT count(*)::text AS count FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = $1", [deletionInput.idempotencyKey]);
    assert.equal(deletionOutbox.rows[0]?.count, "1");
  } finally {
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key LIKE $1", [`append-pg-%`]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.canonical_append' AND idempotency_key LIKE $1", [`append-pg-%`]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key LIKE $1", [`append-pg-%`]);
    await pool.query("DELETE FROM memory_deletion_mutations WHERE idempotency_key LIKE $1", [`append-pg-deletion-%`]);
    await pool.query("DELETE FROM memory_versions WHERE memory_ref_id = $1", [legacyTargetRef.refId]);
    await pool.query("DELETE FROM memory_slot_heads WHERE user_id = $1", [USER]);
    await pool.query("DELETE FROM memory_candidate_heads WHERE candidate_ref_id = $1", [candidateCreate.candidateRef!.refId]);
    await closePostgresPool(pool);
  }
});
