import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertProductionMemoryIssuerReceipt,
  createProductionMemoryCanonicalIssuer,
  projectProductionMemoryIssuerReceipt,
  rehydrateProductionMemoryIssuerReceipt,
} from "../../../services/memory-os/src/canonical-issuer.ts";
import { createCanonicalObjectVersionRef } from "../../../services/memory-os/src/canonical-ref.ts";
import {
  canonicalWireCorrectionToInternal,
  canonicalWireRefToInternal,
  canonicalWireRefsToInternal,
  canonicalWireSensitivityToInternal,
  canonicalWireValidityToInternal,
  projectCanonicalReceipt,
  rehydrateCanonicalReceipt,
  type MemoryCanonicalReceiptCodec,
} from "../src/memory-persistence-primitives.ts";

const ROOT = new URL("../../../", import.meta.url);

test("0004 is additive, preserves exact bytes, and installs only rebuildable heads", async () => {
  const up = await readFile(new URL("../../../migrations/0004_memory_append_only_lifecycle.up.sql", import.meta.url), "utf8");
  const down = await readFile(new URL("../../../migrations/0004_memory_append_only_lifecycle.down.sql", import.meta.url), "utf8");
  assert.match(up, /canonical_payload_jcs/);
  assert.match(up, /memory_candidate_heads/);
  assert.match(up, /memory_slot_heads/);
  assert.match(up, /memory_append_only_immutable_guard/);
  assert.match(up, /canonical_receipt_projection_jcs/);
  assert.match(up, /canonical_receipt_projection_sha256/);
  assert.match(up, /canonical_payload_jcs IS NULL/);
  const deleteGuard = up.slice(up.indexOf("IF TG_OP = 'DELETE'"), up.indexOf("IF TG_OP = 'UPDATE'"));
  assert.match(deleteGuard, /RETURN OLD/);
  assert.doesNotMatch(deleteGuard, /RETURN NEW/);
  assert.match(up, /IF TG_OP = 'UPDATE'/);
  assert.match(up, /canonical memory rows are immutable/);
  assert.doesNotMatch(up, /DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+memory_versions/iu);
  assert.doesNotMatch(down, /DROP\s+(TABLE|INDEX)|TRUNCATE|DELETE\s+FROM/iu);
  const authoritySource = await readFile(new URL("../src/memory-authority-repository.ts", import.meta.url), "utf8");
  const deletionSource = await readFile(new URL("../src/memory-deletion-rebuild-repository.ts", import.meta.url), "utf8");
  const primitivesSource = await readFile(new URL("../src/memory-persistence-primitives.ts", import.meta.url), "utf8");
  for (const source of [authoritySource, deletionSource, primitivesSource]) {
    assert.doesNotMatch(source, /import\s+\{[^}]*\}\s+from\s+"\.\.\/\.\.\/memory-os\/src\/canonical-issuer\.ts"/u);
    assert.doesNotMatch(source, /(?:assert|project|rehydrate)ProductionMemoryIssuerReceipt/u);
    assert.doesNotMatch(source, /canonicalPayloadHash/u);
  }
  assert.ok(ROOT.pathname.length > 0);
});

test("canonical wire conversion preserves ref identity and maps only T05 structural fields", () => {
  const wire = {
    ref_type: "PreferenceMemory",
    ref_id: "01900000-0000-7000-8000-000000000001",
    object_version: "90071992547409931234567890",
    canonical_payload_sha256: "a".repeat(64),
  };
  const internal = canonicalWireRefToInternal(wire, "PreferenceMemory");
  assert.deepEqual(internal, {
    refType: "PreferenceMemory",
    refId: wire.ref_id,
    objectVersion: wire.object_version,
    canonicalPayloadSha256: wire.canonical_payload_sha256,
  });
  assert.deepEqual(canonicalWireRefsToInternal([wire]), [internal]);
  assert.deepEqual(canonicalWireSensitivityToInternal({ classification: "normal", user_confirmed: true }), {
    classification: "normal",
    userConfirmed: true,
  });
  assert.deepEqual(canonicalWireValidityToInternal({ observed_at: "2026-08-23T00:00:00.000Z" }), {
    observedAt: "2026-08-23T00:00:00.000Z",
  });
  assert.deepEqual(canonicalWireCorrectionToInternal({ kind: "delete", target_ref: wire }), {
    kind: "delete",
    target: internal,
  });
  assert.throws(() => canonicalWireRefsToInternal([wire, wire]), /DUPLICATE/);
  assert.throws(() => canonicalWireRefToInternal({ ...wire, object_version: 1 }), /decimal|positive/i);
});

test("canonical refs never pass through Number", () => {
  const ref = createCanonicalObjectVersionRef({
    refType: "PreferenceMemory",
    refId: "01900000-0000-7000-8000-000000000002",
    objectVersion: "90071992547409931234567890",
    canonicalPayloadSha256: "b".repeat(64),
  });
  assert.equal(ref.objectVersion, "90071992547409931234567890");
});

test("T02 rehydrates a persisted T05 projection through the injected codec", () => {
  const issuer = createProductionMemoryCanonicalIssuer({ nowMs: () => 1_700_000_000_000n });
  const receipt = issuer.issueCandidate({
    candidate: {
      kind: "create",
      status: "candidate",
      proposalId: "append-codec",
      slot: "preference.drink",
      value: { text: "tea" },
      evidenceRefs: [createCanonicalObjectVersionRef({ refType: "Observation", refId: "01900000-0000-7000-8000-000000001821", objectVersion: "1", canonicalPayloadSha256: "a".repeat(64) })],
      sourceClass: "explicit_user_preference",
      confidencePpm: 950_000,
      idempotencyKey: "append-codec",
      current: false,
      memoryKind: "preference_memory",
      userId: "01900000-0000-7000-8000-000000000001",
      purposeScopes: ["conversation", "memory"],
      sensitivity: { classification: "normal", userConfirmed: true },
      validity: { observedAt: "2026-08-23T11:59:00.000Z" },
    },
    context: { systemTime: "2026-08-23T12:00:00.000000Z" },
  });
  const codec: MemoryCanonicalReceiptCodec = Object.freeze({
    assertReceipt: assertProductionMemoryIssuerReceipt,
    projectReceipt: projectProductionMemoryIssuerReceipt,
    rehydrateReceipt: rehydrateProductionMemoryIssuerReceipt,
  });
  const persisted = projectCanonicalReceipt(receipt, codec).projection;
  const afterRestart = JSON.parse(JSON.stringify(persisted)) as unknown;
  const restored = rehydrateCanonicalReceipt(afterRestart, codec);
  assert.equal(restored.canonicalPayloadJcs, receipt.canonicalPayloadJcs);
  assert.deepEqual(projectProductionMemoryIssuerReceipt(restored), persisted);
});
