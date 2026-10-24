import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import { createMemoryDeletionRebuildRepository } from "../src/memory-deletion-rebuild-repository.ts";

test("deletion adapter requires the complete T03 projected mutation and preserves non-resurrection", async () => {
  const repo = createMemoryDeletionRebuildRepository({ connect() { throw new Error("not called"); } } as never);
  const job = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000001801", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const target = createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000001802", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const result = await repo.applyDeletionMutations({ idempotencyKey: "fixture-deletion", fingerprint: "a".repeat(64) as never, projections: [{ deletionJobRef: job, targetRef: target, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OWNER_STATE_UNAVAILABLE");
});

test("canonical deletion successor requires the injected T05 codec before any SQL", async () => {
  const repo = createMemoryDeletionRebuildRepository({ connect() { throw new Error("SQL must not be reached"); } } as never);
  const job = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000001811", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const target = createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000001812", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const result = await repo.applyDeletionMutations({
    idempotencyKey: "fixture-deletion-successor",
    fingerprint: "a".repeat(64) as never,
    projections: [{ deletionJobRef: job, targetRef: target, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
    successors: [{ targetRef: target, receipt: {} as never }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OWNER_STATE_UNAVAILABLE");
});

test("canonical deletion without a successor performs no SQL mutation and keeps legacy classification separate", async () => {
  const statements: string[] = [];
  let connectCalls = 0;
  const pool = {
    async query(statement: string) {
      statements.push(statement);
      if (statement.startsWith("SELECT to_regclass")) return { rows: [{ relation: "memory_slot_heads" }] };
      if (statement.startsWith("SELECT canonical_payload_jcs")) return { rows: [{ canonical_payload_jcs: "canonical-jcs" }] };
      throw new Error(`unexpected SQL: ${statement}`);
    },
    async connect() {
      connectCalls += 1;
      throw new Error("transaction must not start");
    },
  } as never;
  const repo = createMemoryDeletionRebuildRepository(pool);
  const job = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000001821", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const target = createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000001822", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const result = await repo.applyDeletionMutations({
    idempotencyKey: "fixture-canonical-no-successor",
    fingerprint: "a".repeat(64) as never,
    projections: [{ deletionJobRef: job, targetRef: target, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "DELETION_SUCCESSOR_REQUIRED");
  assert.equal(connectCalls, 0);
  assert.ok(statements.every((statement) => statement.startsWith("SELECT ")));
  assert.equal(statements.some((statement) => /\b(INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b/iu.test(statement)), false);
});

test("legacy target keeps the legacy mutation classification", async () => {
  const statements: string[] = [];
  let connectCalls = 0;
  const pool = {
    async query(statement: string) {
      statements.push(statement);
      if (statement.startsWith("SELECT to_regclass")) return { rows: [{ relation: "memory_slot_heads" }] };
      if (statement.startsWith("SELECT canonical_payload_jcs")) return { rows: [{ canonical_payload_jcs: null }] };
      throw new Error(`unexpected SQL: ${statement}`);
    },
    async connect() {
      connectCalls += 1;
      throw new Error("legacy transaction fixture");
    },
  } as never;
  const repo = createMemoryDeletionRebuildRepository(pool);
  const job = createCanonicalObjectVersionRef({ refType: "DeletionJob", refId: "01900000-0000-7000-8000-000000001831", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const target = createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000001832", objectVersion: "1", canonicalPayloadSha256: "f".repeat(64) });
  const result = await repo.applyDeletionMutations({
    idempotencyKey: "fixture-legacy-deletion",
    fingerprint: "a".repeat(64) as never,
    projections: [{ deletionJobRef: job, targetRef: target, targetStatus: "deleted", targetCurrent: false, deleted: true, suppressed: true, tombstone: true, nonResurrection: true, authorityWatermark: { authority_seq: "1" } }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OWNER_STATE_UNAVAILABLE");
  assert.equal(connectCalls, 1);
  assert.ok(statements.every((statement) => statement.startsWith("SELECT ")));
});
