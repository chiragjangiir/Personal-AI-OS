import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionMemoryIssuerReceipt,
  createProductionMemoryCanonicalIssuer,
  projectProductionMemoryIssuerReceipt,
  rehydrateProductionMemoryIssuerReceipt,
} from "../../memory-os/src/canonical-issuer.ts";
import { createCanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import { createNonProductionMemoryIdentityProvider, MemoryAuthorityRepository } from "../src/memory-authority-repository.ts";
import {
  assertAuthorityWatermark,
  assertPositiveDecimalText,
  assertRefColumnEquality,
  projectCanonicalReceipt,
  refToColumns,
  rehydrateCanonicalReceipt,
  type MemoryCanonicalReceiptCodec,
  watermarkFromEpoch,
} from "../src/memory-persistence-primitives.ts";

const HASH = "a".repeat(64);
const ref = (refType: "MemoryCandidate" | "PreferenceMemory" | "DeletionJob" | "Observation", id: string, objectVersion = "1") =>
  createCanonicalObjectVersionRef({
    refType,
    refId: `01900000-0000-7000-8000-${id.padStart(12, "0")}`,
    objectVersion,
    canonicalPayloadSha256: HASH,
  });

const t05Codec: MemoryCanonicalReceiptCodec = Object.freeze({
  assertReceipt: assertProductionMemoryIssuerReceipt,
  projectReceipt: projectProductionMemoryIssuerReceipt,
  rehydrateReceipt: rehydrateProductionMemoryIssuerReceipt,
});

function issuerReceipt() {
  const issuer = createProductionMemoryCanonicalIssuer({ nowMs: () => 1_700_000_000_000n });
  return issuer.issueCandidate({
    candidate: {
      kind: "create",
      status: "candidate",
      proposalId: "codec-proposal",
      slot: "preference.drink",
      value: { text: "tea" },
      evidenceRefs: [ref("Observation", "1504")],
      sourceClass: "explicit_user_preference",
      confidencePpm: 950_000,
      idempotencyKey: "codec-candidate",
      current: false,
      memoryKind: "preference_memory",
      userId: "01900000-0000-7000-8000-000000000001",
      purposeScopes: ["conversation", "memory"],
      sensitivity: { classification: "normal", userConfirmed: true },
      validity: { observedAt: "2026-08-23T11:59:00.000Z" },
    },
    context: { systemTime: "2026-08-23T12:00:00.000000Z" },
  });
}

test("canonical memory identity requires an injected owner projection and never defaults to a generated ref", () => {
  const candidate = ref("MemoryCandidate", "1501");
  const memory = ref("PreferenceMemory", "1502", "90071992547409931234567890");
  const provider = createNonProductionMemoryIdentityProvider({ candidateRefs: [candidate], memoryRefs: [memory] });
  assert.equal(provider.environment, "non-production");
  assert.deepEqual(provider.candidateRefFor({ batchId: "fixture", idempotencyKey: "fixture", candidateIndex: 0, candidate: {} as never }), candidate);
  assert.deepEqual(provider.memoryRefFor({ candidateRef: candidate, memoryKind: "preference_memory", operation: "accept_new", candidate: {} as never }), memory);
  assert.equal(refToColumns(memory).object_version, "90071992547409931234567890");
  assert.throws(() => assertPositiveDecimalText(9007199254740993), /positive decimal string/);
});

test("opaque ref and denormalized columns must be equal in both directions", () => {
  const value = ref("PreferenceMemory", "1503", "7");
  const columns = refToColumns(value);
  assert.deepEqual(assertRefColumnEquality(value, columns, "PreferenceMemory"), value);
  assert.throws(() => assertRefColumnEquality(value, { ...columns, object_version: "8" }, "PreferenceMemory"), /REF_COLUMN_DRIFT|opaque reference/);
});

test("production repository construction is allowed only with a production-marked owner seam", () => {
  const pool = { connect() { throw new Error("not called"); } } as never;
  const repository = new MemoryAuthorityRepository(pool);
  assert.equal(repository.environment, "production");
  assert.equal(repository.canonicalIdentity, undefined);
});

test("T02 canonical seam accepts the real T05 codec and round-trips the private brand", () => {
  const receipt = issuerReceipt();
  const projected = projectCanonicalReceipt(receipt, t05Codec);
  const restored = rehydrateCanonicalReceipt(projected.projection, t05Codec);
  assert.equal(restored.canonicalPayloadJcs, receipt.canonicalPayloadJcs);
  assert.equal(restored.candidateRef?.refId, receipt.candidateRef?.refId);
  assert.deepEqual(projectProductionMemoryIssuerReceipt(restored), projected.projection);
});

test("T02 canonical seam rejects missing, forged, and mutating codec receipts before SQL", async () => {
  const receipt = issuerReceipt();
  const pool = {
    connect() { throw new Error("SQL must not be reached"); },
  } as never;
  const missing = new MemoryAuthorityRepository(pool);
  const noCodec = await missing.appendCanonical({ idempotencyKey: "codec-missing", fingerprint: HASH as never, receipt });
  assert.equal(noCodec.ok, false);
  if (!noCodec.ok) assert.equal(noCodec.error.code, "OWNER_STATE_UNAVAILABLE");
  assert.throws(() => t05Codec.assertReceipt({ ...receipt }), /private production receipt/i);
  const mutating: MemoryCanonicalReceiptCodec = {
    ...t05Codec,
    projectReceipt(value) {
      return { ...projectProductionMemoryIssuerReceipt(value), canonicalPayloadJcs: "mutated" } as never;
    },
  };
  assert.throws(() => projectCanonicalReceipt(receipt, mutating), /canonical receipt codec rejected|DRIFT/i);
  const drifted = await new MemoryAuthorityRepository(pool, { canonicalCodec: mutating }).appendCanonical({
    idempotencyKey: "codec-mutating",
    fingerprint: HASH as never,
    receipt,
  });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.error.code, "OWNER_STATE_INVALID");
});

test("append-only head rebuild requires a callable codec interface before pool.connect", async () => {
  let connectCalls = 0;
  const sql: string[] = [];
  const fakeClient = {
    async query(statement: string) {
      sql.push(statement);
      return statement.startsWith("SELECT watermark") ? { rows: [{ watermark: "1" }] } : { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      connectCalls += 1;
      return fakeClient;
    },
  } as never;

  const assertCommand = (code: "OWNER_STATE_INVALID" | "OWNER_STATE_UNAVAILABLE", retryable: boolean) => (error: unknown): boolean => {
    const command = (error as { readonly commandError?: { readonly code?: string; readonly retryable?: boolean } }).commandError;
    assert.equal(command?.code, code);
    assert.equal(command?.retryable, retryable);
    return true;
  };
  const rejected: readonly [string, MemoryCanonicalReceiptCodec | undefined, "OWNER_STATE_INVALID" | "OWNER_STATE_UNAVAILABLE", boolean][] = [
    ["absent", undefined, "OWNER_STATE_UNAVAILABLE", true],
    ["malformed-nonfunction", { assertReceipt: () => undefined, projectReceipt: "not-a-function", rehydrateReceipt: () => undefined } as never, "OWNER_STATE_INVALID", false],
    ["malformed-accessor", Object.defineProperty({ ...t05Codec }, "projectReceipt", { get() { throw new Error("accessor must not run"); } }) as never, "OWNER_STATE_INVALID", false],
    ["mismatched", Object.freeze({ assertReceipt: t05Codec.assertReceipt, projectReceipt: t05Codec.projectReceipt }) as never, "OWNER_STATE_INVALID", false],
  ];
  for (const [label, codec, code, retryable] of rejected) {
    const repository = new MemoryAuthorityRepository(pool, codec === undefined ? {} : { canonicalCodec: codec });
    await assert.rejects(() => repository.rebuildAppendOnlyHeads(), assertCommand(code, retryable), label);
  }
  assert.equal(connectCalls, 0);
  assert.deepEqual(sql, []);

  const valid = new MemoryAuthorityRepository(pool, { canonicalCodec: t05Codec });
  await valid.rebuildAppendOnlyHeads();
  assert.equal(connectCalls, 1);
  assert.ok(sql.join("\n").includes("DELETE FROM memory_candidate_heads"));
  assert.ok(sql.join("\n").includes("DELETE FROM memory_slot_heads"));
});

test("RFC-010 authority watermark is exact positive decimal text", () => {
  assert.deepEqual(assertAuthorityWatermark({ authority_seq: "1" }), { authority_seq: "1" });
  assert.deepEqual(watermarkFromEpoch("90071992547409931234567890"), { authority_seq: "90071992547409931234567890" });
  for (const value of [0, "0", 1, { kind: "memory_authority_watermark", epoch: "1" }, { authority_seq: "1", extra: true }]) {
    assert.throws(() => assertAuthorityWatermark(value), /watermark|authority_seq/i);
  }
});
