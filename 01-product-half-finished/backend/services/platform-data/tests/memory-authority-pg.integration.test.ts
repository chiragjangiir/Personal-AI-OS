import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCanonicalObjectVersionRef, assertSha256 } from "../../memory-os/src/canonical-ref.ts";
import { MemoryApplicationService } from "../../memory-os/src/memory-application-service.ts";
import { MemoryReviewService } from "../../memory-os/src/memory-review-service.ts";
import { createCanonicalUtcWindow } from "../../memory-os/src/domain.ts";
import { closePostgresPool, createPostgresPool, isPostgresConfigured } from "../src/postgres-pool.ts";
import { createMemoryAuthorityRepository } from "../src/memory-authority-repository.ts";
import { createMemoryDreamDeltaRepository } from "../src/memory-dream-delta-repository.ts";
import { createMemoryDerivedRepository } from "../src/memory-derived-repository.ts";
import { createMemoryDeletionRebuildRepository } from "../src/memory-deletion-rebuild-repository.ts";

const RUN = process.env.PAIOS_RUN_PG_INTEGRATION === "1";
const SKIP_REASON = "set PAIOS_PG_DATABASE, PAIOS_PG_USER, PAIOS_PG_PASSWORD and PAIOS_RUN_PG_INTEGRATION=1";
const HASH = "a".repeat(64);
const USER = "memory-pg-authority-user-20260823";

function ref(type: "MemoryCandidate" | "PreferenceMemory" | "Observation" | "FinalTranscriptEvidence", id: number, version = "1", hash = HASH) {
  return createCanonicalObjectVersionRef({ refType: type, refId: `01900000-0000-7000-8000-${String(id).padStart(12, "0")}`, objectVersion: version, canonicalPayloadSha256: hash });
}

test("Memory authority persists owner refs, candidate false-current, review CAS, correction supersession, and replay in real PostgreSQL", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-authority-pg-integration" });
  let candidateCalls = 0;
  const repository = createMemoryAuthorityRepository(pool, {
    environment: "non-production",
    canonicalIdentity: {
      environment: "non-production",
      candidateRefFor({ idempotencyKey }) {
        candidateCalls += 1;
        return ref("MemoryCandidate", idempotencyKey === "memory-pg-authority-candidate" ? 1901 : 1903, "90071992547409931234567890");
      },
      memoryRefFor({ operation }) {
        return operation === "accept_new" ? ref("PreferenceMemory", 1902, "90071992547409931234567891") : ref("PreferenceMemory", 1904, "90071992547409931234567892");
      },
    },
  });
  const candidateRef = ref("MemoryCandidate", 1901, "90071992547409931234567890");
  const memoryRef = ref("PreferenceMemory", 1902, "90071992547409931234567891");
  const correctionCandidateRef = ref("MemoryCandidate", 1903, "90071992547409931234567890");
  const correctionMemoryRef = ref("PreferenceMemory", 1904, "90071992547409931234567892");
  const evidence = ref("Observation", 1905);
  const correctionEvidence = ref("FinalTranscriptEvidence", 1906);
  const candidate = {
    kind: "create" as const,
    status: "candidate" as const,
    proposalId: "memory-pg-authority-proposal",
    slot: "preference.drink",
    value: { text: "tea" },
    evidenceRefs: [evidence],
    sourceClass: "explicit_user_preference" as const,
    confidencePpm: 950_000,
    idempotencyKey: "memory-pg-authority-candidate",
    current: false as const,
    memoryKind: "preference_memory" as const,
    userId: USER,
    purposeScopes: ["conversation"],
    sensitivity: { classification: "normal" as const, userConfirmed: true },
    validity: { observedAt: "2026-08-23T00:00:00.000Z" },
  };
  try {
    await pool.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    await pool.query("DELETE FROM memory_versions WHERE user_id = $1", [USER]);
    await pool.query("DELETE FROM memory_candidates WHERE user_id = $1", [USER]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope LIKE 'memory.%' AND idempotency_key LIKE 'memory-pg-authority-%'");
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key LIKE 'memory-pg-authority-%'");

    const application = new MemoryApplicationService(repository, repository);
    const committed = await application.commitCandidate({ batchId: "memory-pg-authority-batch", idempotencyKey: candidate.idempotencyKey, candidate });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    assert.deepEqual(committed.receipt.canonicalRefs, [candidateRef]);
    const candidateRow = await pool.query("SELECT candidate_ref, candidate_ref_type, candidate_ref_id, candidate_object_version, candidate_payload_sha256, current FROM memory_candidates WHERE user_id = $1", [USER]);
    assert.equal(candidateRow.rows.length, 1);
    assert.equal(candidateRow.rows[0]?.current, false);
    assert.equal(candidateRow.rows[0]?.candidate_object_version, candidateRef.objectVersion);
    assert.equal(candidateRow.rows[0]?.candidate_payload_sha256, HASH);

    const review = new MemoryReviewService(repository, repository, repository, repository);
    const reviewed = await review.review({
      candidateRef,
      expectedCandidateStatus: "candidate",
      expectedUserId: USER,
      expectedSlot: candidate.slot,
      decision: "accept",
      idempotencyKey: "memory-pg-authority-review",
authorization: { mode: "explicit_user_confirmation", evidenceRefs: [evidence], authorityWatermark: { authority_seq: "1" } },
      resolvedContent: "likes tea",
    });
    assert.equal(reviewed.ok, true);
    if (!reviewed.ok) return;
    assert.deepEqual(reviewed.receipt.createdMemoryRefs, [memoryRef]);
    const current = await repository.findAuthoritativeCurrentBySlot({ userId: USER, slot: candidate.slot });
    assert.equal(current.conflict, false);
    assert.deepEqual(current.currentRecords[0]?.ref, memoryRef);
    const reviewedReplay = await review.review({
      candidateRef,
      expectedCandidateStatus: "candidate",
      expectedUserId: USER,
      expectedSlot: candidate.slot,
      decision: "accept",
      idempotencyKey: "memory-pg-authority-review",
      authorization: { mode: "explicit_user_confirmation", evidenceRefs: [evidence], authorityWatermark: { authority_seq: "1" } },
      resolvedContent: "likes tea",
    });
    assert.equal(reviewedReplay.ok, true);
    if (reviewedReplay.ok) assert.equal(reviewedReplay.receipt.outcome, "replayed");

    const correction = {
      kind: "correct" as const,
      status: "candidate" as const,
      proposalId: "memory-pg-authority-correction",
      slot: candidate.slot,
      value: { text: "coffee" },
      evidenceRefs: [correctionEvidence, memoryRef],
      sourceClass: "explicit_user_correction" as const,
      confidencePpm: 1_000_000,
      idempotencyKey: "memory-pg-authority-correction",
      current: false as const,
      memoryKind: "preference_memory" as const,
      userId: USER,
      purposeScopes: ["conversation"],
      sensitivity: { classification: "normal" as const, userConfirmed: true },
      validity: { observedAt: "2026-08-23T00:01:00.000Z" },
      target: memoryRef,
      correctionIntent: { kind: "correct" as const, target: memoryRef, evidenceRefs: [correctionEvidence, memoryRef] },
    };
    const corrected = await application.commitCorrection({ idempotencyKey: correction.idempotencyKey, expectedCurrentRef: memoryRef, candidate: correction, resolvedContent: "likes coffee" });
    assert.equal(corrected.ok, true);
    if (!corrected.ok) return;
    assert.deepEqual(corrected.receipt.canonicalRefs, [correctionMemoryRef]);
    assert.deepEqual(corrected.receipt.supersededRefs, [memoryRef]);
    const versions = await pool.query("SELECT memory_ref_id, memory_object_version, memory_payload_sha256, status, current FROM memory_versions WHERE user_id = $1 ORDER BY memory_object_version", [USER]);
    assert.equal(versions.rows.length, 2);
    assert.deepEqual(versions.rows.map((row) => [row.memory_object_version, row.status, row.current]), [[memoryRef.objectVersion, "superseded", false], [correctionMemoryRef.objectVersion, "current", true]]);

    const replay = await application.commitCandidate({ batchId: "memory-pg-authority-batch", idempotencyKey: candidate.idempotencyKey, candidate });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.receipt.outcome, "replayed");
    const drifted = await application.commitCandidate({ batchId: "memory-pg-authority-batch", idempotencyKey: candidate.idempotencyKey, candidate: { ...candidate, value: { text: "coffee" } } });
    assert.equal(drifted.ok, false);
    if (!drifted.ok) assert.equal(drifted.error.code, "IDEMPOTENCY_CONFLICT");
    const ledger = await pool.query("SELECT status, request_hash FROM idempotency_ledger WHERE scope = 'memory.candidate_batch' AND idempotency_key = $1", [candidate.idempotencyKey]);
    assert.equal(ledger.rows[0]?.status, "committed");
    assert.match(String(ledger.rows[0]?.request_hash).trim(), /^[0-9a-f]{64}$/u);
  } finally {
    await pool.query("DELETE FROM memory_versions WHERE user_id = $1", [USER]).catch(() => undefined);
    await pool.query("DELETE FROM memory_candidates WHERE user_id = $1", [USER]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope LIKE 'memory.%' AND idempotency_key LIKE 'memory-pg-authority-%'").catch(() => undefined);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key LIKE 'memory-pg-authority-%'").catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("accepted Dream deltas persist and page from the owner projection in real PostgreSQL", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-dream-pg-integration" });
  const repository = createMemoryDreamDeltaRepository(pool);
  const deltaRef = ref("Observation", 1911);
  const sourceRef = ref("FinalTranscriptEvidence", 1912);
  try {
    await pool.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    await pool.query("DELETE FROM memory_dream_deltas WHERE delta_ref_id = $1", [deltaRef.refId]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.dream_delta' AND idempotency_key = 'memory-dream-pg-key'");
const record = await repository.writeAcceptedDreamDelta({ ref: deltaRef, userId: "memory-dream-pg-user", accepted: true, delta: { preference: "tea" }, sourceRefs: [sourceRef], acceptedAt: "2026-08-23T02:00:00.000Z", authorityWatermark: { authority_seq: "1" }, idempotencyKey: "memory-dream-pg-key", fingerprint: assertSha256(createHash("sha256").update("memory-dream-pg").digest("hex")) });
    assert.equal(record.accepted, true);
    const page = await repository.readAcceptedDreamDeltas({ userId: "memory-dream-pg-user", window: createCanonicalUtcWindow({ from: "2026-08-23T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" }), limit: 10 });
    assert.deepEqual(page.records.map((item) => item.ref), [deltaRef]);
    const pageWatermark = page.authorityWatermark as { readonly authority_seq: string };
    assert.match(pageWatermark.authority_seq, /^[1-9][0-9]*$/u);
    const persistedWatermark = await pool.query("SELECT authority_watermark FROM memory_dream_deltas WHERE delta_ref_id = $1", [deltaRef.refId]);
    assert.deepEqual(persistedWatermark.rows[0]?.authority_watermark, pageWatermark);
  } finally {
    await pool.query("DELETE FROM memory_dream_deltas WHERE delta_ref_id = $1", [deltaRef.refId]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.dream_delta' AND idempotency_key = 'memory-dream-pg-key'").catch(() => undefined);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = 'memory-dream-pg-key'").catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("0003 rerun upgrades a legacy allow-zero clock/default without lowering a positive watermark", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-legacy-clock-upgrade-pg-integration" });
  const client = await pool.connect();
  try {
    await client.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    const up = await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8");
    const upBody = up.replace(/^\s*BEGIN;\s*/iu, "").replace(/\s*COMMIT;\s*$/iu, "");
    await client.query("BEGIN");
    await client.query("ALTER TABLE memory_authority_clock DROP CONSTRAINT IF EXISTS memory_authority_clock_watermark_ck");
    await client.query("ALTER TABLE memory_authority_clock DROP CONSTRAINT IF EXISTS memory_authority_clock_watermark_check");
    await client.query("ALTER TABLE memory_authority_clock ALTER COLUMN watermark SET DEFAULT '0'");
    await client.query("ALTER TABLE memory_authority_clock ADD CONSTRAINT memory_authority_clock_watermark_check CHECK (watermark ~ '^(0|[1-9][0-9]*)$')");
    await client.query("UPDATE memory_authority_clock SET watermark = '0' WHERE clock_id = TRUE");
    await client.query(upBody);
    const legacyUpgrade = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
    const upgradedCatalog = await client.query("SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'memory_authority_clock' AND column_name = 'watermark'");
    const upgradedConstraints = await client.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'memory_authority_clock'::regclass AND conname IN ('memory_authority_clock_watermark_ck', 'memory_authority_clock_watermark_check')");
    assert.equal(legacyUpgrade.rows[0]?.watermark, "1");
    assert.equal(upgradedCatalog.rows[0]?.column_default, "'1'::text");
    assert.deepEqual(upgradedConstraints.rows, [{ conname: "memory_authority_clock_watermark_ck", definition: "CHECK ((watermark ~ '^[1-9][0-9]*$'::text))" }]);
    await client.query("UPDATE memory_authority_clock SET watermark = '987654321987654321' WHERE clock_id = TRUE");
    await client.query(upBody);
    const repeat = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
    assert.equal(repeat.rows[0]?.watermark, "987654321987654321");
    await client.query("ROLLBACK");
  } finally {
    await client.release();
    await closePostgresPool(pool);
  }
});

test("PostgreSQL current-slot barrier rejects concurrent accept_new, accept_superseding, and correction splits", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-current-concurrency-pg-integration" });
  const userId = "memory-current-concurrency-user-20260823";
  const slot = "concurrency.preference";
  const candidateRefs = new Map<string, ReturnType<typeof ref>>();
  const memoryRefs = new Map<string, ReturnType<typeof ref>>();
  const identity = {
    environment: "non-production" as const,
    candidateRefFor({ idempotencyKey }: { readonly idempotencyKey: string }) {
      const value = candidateRefs.get(idempotencyKey);
      if (value === undefined) throw new Error("missing fixture candidate ref");
      return value;
    },
    memoryRefFor({ candidateRef }: { readonly candidateRef: ReturnType<typeof ref> }) {
      const value = memoryRefs.get(candidateRef.refId);
      if (value === undefined) throw new Error("missing fixture memory ref");
      return value;
    },
  };
  const repository = createMemoryAuthorityRepository(pool, { environment: "non-production", canonicalIdentity: identity });
  const application = new MemoryApplicationService(repository, repository);
  const review = new MemoryReviewService(repository, repository, repository, repository);
  const candidateFor = (key: string, candidateRefId: number, memoryRefId: number, sourceClass: "repeated_behavior" | "explicit_user_preference", value: string) => {
    const candidateRef = ref("MemoryCandidate", candidateRefId);
    const memoryRef = ref("PreferenceMemory", memoryRefId);
    candidateRefs.set(key, candidateRef);
    memoryRefs.set(candidateRef.refId, memoryRef);
    return {
      kind: "create" as const,
      status: "candidate" as const,
      proposalId: key,
      slot,
      value: { text: value },
      evidenceRefs: [ref("Observation", candidateRefId + 100)],
      sourceClass,
      confidencePpm: 900_000,
      idempotencyKey: key,
      current: false as const,
      memoryKind: "preference_memory" as const,
      userId,
      purposeScopes: ["conversation"],
      sensitivity: { classification: "normal" as const, userConfirmed: true },
      validity: { observedAt: "2026-08-23T00:00:00.000Z" },
    };
  };
  let authorizationCounter = 0;
  const authorize = (_key: string) => ({
    mode: "explicit_user_confirmation" as const,
    evidenceRefs: [ref("Observation", 2300 + authorizationCounter++)],
    authorityWatermark: { authority_seq: "1" },
  });
  try {
    await pool.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    await pool.query("DELETE FROM memory_versions WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM memory_candidates WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope LIKE 'memory.%' AND idempotency_key LIKE 'memory-concurrency-%'");
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key LIKE 'memory-concurrency-%'");

    const acceptNew = [candidateFor("memory-concurrency-new-a", 1951, 1961, "repeated_behavior", "tea"), candidateFor("memory-concurrency-new-b", 1952, 1962, "repeated_behavior", "coffee")];
    for (const candidate of acceptNew) assert.equal((await application.commitCandidate({ batchId: candidate.idempotencyKey, idempotencyKey: candidate.idempotencyKey, candidate })).ok, true);
    const acceptNewResults = await Promise.all(acceptNew.map((candidate) => review.review({ candidateRef: candidateRefs.get(candidate.idempotencyKey)!, expectedCandidateStatus: "candidate", expectedUserId: userId, expectedSlot: slot, decision: "accept", idempotencyKey: `memory-concurrency-review-${candidate.idempotencyKey.slice(-1)}`, authorization: authorize(candidate.idempotencyKey), resolvedContent: candidate.value.text })));
    assert.equal(acceptNewResults.filter((result) => result.ok && result.receipt.createdMemoryRefs.length === 1).length, 1);
    assert.equal(acceptNewResults.filter((result) => result.ok && result.receipt.createdMemoryRefs.length === 0).length + acceptNewResults.filter((result) => !result.ok && result.error.code === "CURRENT_VERSION_CONFLICT").length, 1);
    const firstCurrent = await repository.findAuthoritativeCurrentBySlot({ userId, slot });
    assert.equal(firstCurrent.conflict, false);
    assert.equal(firstCurrent.currentRecords.length, 1);
    const firstRef = firstCurrent.currentRecords[0]!.ref;

    const acceptSuperseding = [candidateFor("memory-concurrency-super-a", 1953, 1963, "explicit_user_preference", "water"), candidateFor("memory-concurrency-super-b", 1954, 1964, "explicit_user_preference", "juice")];
    for (const candidate of acceptSuperseding) assert.equal((await application.commitCandidate({ batchId: candidate.idempotencyKey, idempotencyKey: candidate.idempotencyKey, candidate })).ok, true);
    const supersedingResults = await Promise.all(acceptSuperseding.map((candidate) => review.review({ candidateRef: candidateRefs.get(candidate.idempotencyKey)!, expectedCandidateStatus: "candidate", expectedUserId: userId, expectedSlot: slot, decision: "accept", idempotencyKey: `memory-concurrency-super-review-${candidate.idempotencyKey.slice(-1)}`, authorization: authorize(candidate.idempotencyKey), expectedCurrentRef: firstRef, resolvedContent: candidate.value.text })));
    assert.equal(supersedingResults.filter((result) => result.ok).length, 1);
    assert.equal(supersedingResults.filter((result) => !result.ok && result.error.code === "CURRENT_VERSION_CONFLICT").length, 1);
    const secondCurrent = await repository.findAuthoritativeCurrentBySlot({ userId, slot });
    assert.equal(secondCurrent.conflict, false);
    assert.equal(secondCurrent.currentRecords.length, 1);
    const secondRef = secondCurrent.currentRecords[0]!.ref;

    const corrections = [1955, 1956].map((id, index) => {
      const key = `memory-concurrency-correction-${index === 0 ? "a" : "b"}`;
      const candidateRef = ref("MemoryCandidate", id);
      const memoryRef = ref("PreferenceMemory", 1965 + index);
      candidateRefs.set(key, candidateRef);
      memoryRefs.set(candidateRef.refId, memoryRef);
      return {
        kind: "correct" as const,
        status: "candidate" as const,
        proposalId: key,
        slot,
        value: { text: index === 0 ? "espresso" : "matcha" },
        evidenceRefs: [ref("FinalTranscriptEvidence", id + 100), secondRef],
        sourceClass: "explicit_user_correction" as const,
        confidencePpm: 1_000_000,
        idempotencyKey: key,
        current: false as const,
        memoryKind: "preference_memory" as const,
        userId,
        purposeScopes: ["conversation"],
        sensitivity: { classification: "normal" as const, userConfirmed: true },
        validity: { observedAt: "2026-08-23T00:02:00.000Z" },
        target: secondRef,
        correctionIntent: { kind: "correct" as const, target: secondRef, evidenceRefs: [ref("FinalTranscriptEvidence", id + 100), secondRef] },
      };
    });
    const correctionResults = await Promise.all(corrections.map((candidate) => application.commitCorrection({ idempotencyKey: candidate.idempotencyKey, expectedCurrentRef: secondRef, candidate, resolvedContent: candidate.value.text })));
    assert.equal(correctionResults.filter((result) => result.ok).length, 1);
    assert.equal(correctionResults.filter((result) => !result.ok && result.error.code === "CURRENT_VERSION_CONFLICT").length, 1);
    const finalCurrent = await repository.findAuthoritativeCurrentBySlot({ userId, slot });
    assert.equal(finalCurrent.conflict, false);
    assert.equal(finalCurrent.currentRecords.length, 1);
  } finally {
    await pool.query("DELETE FROM memory_versions WHERE user_id = $1", [userId]).catch(() => undefined);
    await pool.query("DELETE FROM memory_candidates WHERE user_id = $1", [userId]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope LIKE 'memory.%' AND idempotency_key LIKE 'memory-concurrency-%'").catch(() => undefined);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key LIKE 'memory-concurrency-%'").catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("derived metadata replays by authority ref/config and purges without content authority", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-derived-pg-integration" });
  const repository = createMemoryDerivedRepository(pool);
  const authorityRef = ref("PreferenceMemory", 1921);
  const hash = (value: string) => assertSha256(createHash("sha256").update(value).digest("hex"));
const input = { projectionKind: "fts" as const, authorityRef, authorityWatermark: { authority_seq: "1" }, implementationVersion: "pg-test-v1", configurationSha256: hash("memory-derived-config"), projectionSha256: hash("memory-derived-projection"), recordCount: 1, idempotencyKey: "memory-derived-pg-key", fingerprint: hash("memory-derived-request") };
  try {
    await pool.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    await repository.purgeAuthorityRefs([authorityRef]);
    const first = await repository.writeProjection(input);
    const replay = await repository.writeProjection(input);
    assert.deepEqual(replay.authorityRef, first.authorityRef);
    assert.equal((await repository.listByAuthority(authorityRef)).length, 1);
    assert.equal(await repository.purgeAuthorityRefs([authorityRef]), 1);
    assert.equal((await repository.listByAuthority(authorityRef)).length, 0);
  } finally {
    await repository.purgeAuthorityRefs([authorityRef]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.derived' AND idempotency_key = 'memory-derived-pg-key'").catch(() => undefined);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = 'memory-derived-pg-key'").catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("deletion projection mechanically sets tombstone/non-resurrection state in real PostgreSQL", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-deletion-pg-integration" });
  const repository = createMemoryDeletionRebuildRepository(pool);
  const targetRef = ref("PreferenceMemory", 1931);
  const jobRef = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000001932", objectVersion: "1", canonicalPayloadSha256: HASH });
  const evidence = ref("Observation", 1933);
  try {
    await pool.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    await pool.query("DELETE FROM memory_versions WHERE memory_ref_id = $1", [targetRef.refId]);
    await pool.query("DELETE FROM memory_deletion_mutations WHERE idempotency_key = 'memory-deletion-pg-key'");
    await pool.query("INSERT INTO memory_versions (memory_ref, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, user_id, kind, slot, value, resolved_content, status, current, source_class, evidence_refs, confidence_ppm, allowed_purpose_scopes, sensitivity, validity) VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'current', TRUE, 'explicit_user_preference', $11::jsonb, 950000, $12::jsonb, $13::jsonb, $14::jsonb)", [JSON.stringify(targetRef), targetRef.refType, targetRef.refId, targetRef.objectVersion, HASH, "memory-deletion-pg-user", "preference_memory", "deletion.slot", JSON.stringify({ text: "secret" }), "secret", JSON.stringify([evidence]), JSON.stringify(["conversation"]), JSON.stringify({ classification: "normal", userConfirmed: true }), JSON.stringify({ observedAt: "2026-08-23T00:00:00.000Z" })]);
const outcome = await repository.applyDeletionMutations({ idempotencyKey: "memory-deletion-pg-key", fingerprint: assertSha256(createHash("sha256").update("memory-deletion-pg").digest("hex")), projections: [{ deletionJobRef: jobRef, targetRef, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }] });
    assert.equal(outcome.ok, true);
    const row = await pool.query("SELECT status, current, deleted_at, suppressed_at, stale FROM memory_versions WHERE memory_ref_id = $1", [targetRef.refId]);
    assert.deepEqual(row.rows.map((item) => [item.status, item.current, item.deleted_at !== null, item.suppressed_at !== null, item.stale]), [["deleted", false, true, true, true]]);
  } finally {
    await pool.query("DELETE FROM memory_versions WHERE memory_ref_id = $1", [targetRef.refId]).catch(() => undefined);
    await pool.query("DELETE FROM memory_deletion_mutations WHERE idempotency_key = 'memory-deletion-pg-key'").catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.deletion' AND idempotency_key = 'memory-deletion-pg-key'").catch(() => undefined);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'memory.outbox' AND idempotency_key = 'memory-deletion-pg-key'").catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("deletion rebuild claim token is random, hash-bound, and survives an independent repository instance", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool({ applicationName: "memory-deletion-claim-pg-integration" });
  const repository = createMemoryDeletionRebuildRepository(pool);
  const key = "memory-deletion-claim-pg-key";
  const fingerprint = assertSha256(createHash("sha256").update("memory-deletion-claim-external").digest("hex"));
  const semanticInput = {
    schema: "memory.deletion_rebuild.request.v2",
    requestId: "memory-deletion-claim-request",
    idempotencyKey: key,
    deletionJobRef: createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000001941", objectVersion: "1", canonicalPayloadSha256: HASH }),
    targetMemoryRefs: [ref("PreferenceMemory", 1942)],
    authorityWatermark: { authority_seq: "1" },
    projectedMutations: [{ targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true }],
  };
  const result = { status: "completed", stage: "attestation", fingerprint } as never;
  try {
    await pool.query(await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8"));
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.deletion_rebuild' AND idempotency_key = $1", [key]);
    const claimed = await repository.claim({ idempotencyKey: key, fingerprint, semanticInput });
    assert.equal(claimed.status, "acquired");
    if (claimed.status !== "acquired") return;
    assert.equal(claimed.claimToken.includes(key), false);
    assert.equal(claimed.claimToken.includes(fingerprint), false);
    const ledger = await pool.query("SELECT status, request_hash, claim_token_sha256, claim_owner FROM idempotency_ledger WHERE scope = 'memory.deletion_rebuild' AND idempotency_key = $1", [key]);
    assert.equal(ledger.rows[0]?.status, "in_flight");
    assert.match(String(ledger.rows[0]?.request_hash).trim(), /^[0-9a-f]{64}$/u);
    assert.match(String(ledger.rows[0]?.claim_token_sha256).trim(), /^[0-9a-f]{64}$/u);
    assert.match(String(ledger.rows[0]?.claim_owner), /^memory-deletion-rebuild:/u);
    const independent = createMemoryDeletionRebuildRepository(pool);
    assert.equal(await independent.complete({ idempotencyKey: key, fingerprint, semanticInput, claimToken: "wrong-token", result }), "claim_mismatch");
    assert.equal((await pool.query("SELECT status FROM idempotency_ledger WHERE scope = 'memory.deletion_rebuild' AND idempotency_key = $1", [key])).rows[0]?.status, "in_flight");
    assert.equal(await independent.complete({ idempotencyKey: key, fingerprint, semanticInput, claimToken: claimed.claimToken, result }), "completed");
    assert.equal(await independent.complete({ idempotencyKey: key, fingerprint, semanticInput, claimToken: claimed.claimToken, result }), "already_completed");
    const replay = await independent.claim({ idempotencyKey: key, fingerprint, semanticInput });
    assert.equal(replay.status, "replayed");
  } finally {
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'memory.deletion_rebuild' AND idempotency_key = $1", [key]).catch(() => undefined);
    await closePostgresPool(pool);
  }
});
