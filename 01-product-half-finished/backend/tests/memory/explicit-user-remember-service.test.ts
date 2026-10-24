import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "../../services/memory-os/src/canonical-ref.ts";
import {
  createProductionExplicitUserRememberService,
  ExplicitUserRememberError,
  type ExplicitUserRememberCommand,
  type ExplicitUserRememberPersistenceInput,
  type ExplicitUserRememberPersistencePort,
} from "../../services/memory-os/src/explicit-user-remember-service.ts";
import type { MemoryKind } from "../../services/memory-os/src/domain.ts";

const NOW = "2026-08-26T01:02:03.123456Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceRef(
  refType: "TextEvidence" | "FinalTranscriptEvidence" = "TextEvidence",
  seed = "evidence-a",
): CanonicalObjectVersionRef {
  return createCanonicalObjectVersionRef({
    refType,
    refId: seed === "evidence-a"
      ? "01952f00-0000-7000-8000-000000000301"
      : "01952f00-0000-7000-8000-000000000302",
    objectVersion: "1",
    canonicalPayloadSha256: digest(seed),
  });
}

function command(overrides: Partial<ExplicitUserRememberCommand> = {}): ExplicitUserRememberCommand {
  return {
    action: "remember",
    userConfirmed: true,
    userId: "user-memory-source-028",
    purposeScopes: ["conversation", "memory"],
    memoryKind: "preference_memory",
    slot: "preference.inspection_word",
    value: { text: "巡检测试词" },
    boundedContent: "巡检测试词",
    evidenceRef: evidenceRef(),
    evidenceObservedAt: "2026-08-26T01:00:00.000Z",
    sensitivity: { classification: "normal", userConfirmed: true },
    validity: { observedAt: "2026-08-26T01:00:00.000Z" },
    idempotencyKey: "explicit-remember-source-028",
    ...overrides,
  };
}

interface FakePort extends ExplicitUserRememberPersistencePort {
  readonly calls: ExplicitUserRememberPersistenceInput[];
}

function successfulPort(
  mutate?: (
    input: ExplicitUserRememberPersistenceInput,
    result: Record<string, unknown>,
  ) => Record<string, unknown>,
): FakePort {
  const calls: ExplicitUserRememberPersistenceInput[] = [];
  return {
    calls,
    async remember(input) {
      calls.push(input);
      assert.ok(input.candidateReceipt.candidateRef);
      assert.ok(input.memoryReceipt.memoryRef);
      const result: Record<string, unknown> = {
        candidateRef: input.candidateReceipt.candidateRef,
        memoryRef: input.memoryReceipt.memoryRef,
        authorityWatermark: { epoch: "1" },
      };
      return (mutate?.(input, result) ?? result) as never;
    },
  };
}

function service(port: ExplicitUserRememberPersistencePort) {
  return createProductionExplicitUserRememberService({
    persistence: port,
    now: () => NOW,
  });
}

function assertCode(code: string) {
  return (error: unknown): boolean => error instanceof ExplicitUserRememberError && error.code === code;
}

test("issues and persists exactly one explicit accepted memory for every T05 memory kind", async (t) => {
  const kinds: readonly MemoryKind[] = [
    "semantic_fact",
    "episodic_memory",
    "preference_memory",
    "open_loop",
  ];
  const expectedRefTypes = ["SemanticFact", "EpisodicMemory", "PreferenceMemory", "OpenLoop"];
  for (const [index, kind] of kinds.entries()) {
    await t.test(kind, async () => {
      const port = successfulPort();
      const output = await service(port).remember(command({
        memoryKind: kind,
        idempotencyKey: `explicit-remember-source-028-${kind}`,
      }));
      assert.equal(port.calls.length, 1);
      const call = port.calls[0]!;
      assert.equal(call.candidate.sourceClass, "explicit_user_preference");
      assert.equal(call.candidate.confidencePpm, 1_000_000);
      assert.equal(call.candidate.sensitivity.userConfirmed, true);
      assert.equal(call.candidateReceipt.operation, "candidate_create");
      assert.equal(call.memoryReceipt.operation, "memory_create");
      assert.equal(call.memoryReceipt.candidateReceipt?.operation, "candidate_successor");
      assert.equal(call.memoryReceipt.candidateReceipt?.payload.status, "accepted");
      assert.equal(output.candidateRef.refType, "MemoryCandidate");
      assert.equal(output.memoryRef.refType, expectedRefTypes[index]);
      assert.deepEqual(Object.keys(output).sort(), ["authorityWatermark", "candidateRef", "memoryRef"]);
    });
  }
});

test("accepts only exact TextEvidence or FinalTranscriptEvidence and explicit confirmation", async () => {
  const textPort = successfulPort();
  await service(textPort).remember(command());
  assert.equal(textPort.calls.length, 1);

  const transcriptPort = successfulPort();
  await service(transcriptPort).remember(command({
    evidenceRef: evidenceRef("FinalTranscriptEvidence"),
    idempotencyKey: "explicit-remember-source-028-transcript",
  }));
  assert.equal(transcriptPort.calls.length, 1);

  for (const bad of [
    command({ evidenceRef: createCanonicalObjectVersionRef({
      refType: "Observation",
      refId: "01952f00-0000-7000-8000-000000000303",
      objectVersion: "1",
      canonicalPayloadSha256: digest("observation"),
    }) }),
    { ...command(), action: "observe" } as unknown as ExplicitUserRememberCommand,
    { ...command(), userConfirmed: false } as unknown as ExplicitUserRememberCommand,
    { ...command(), sensitivity: { classification: "normal", userConfirmed: false } } as unknown as ExplicitUserRememberCommand,
  ]) {
    const port = successfulPort();
    await assert.rejects(service(port).remember(bad), (error: unknown) =>
      error instanceof ExplicitUserRememberError);
    assert.equal(port.calls.length, 0);
  }
});

test("binds observed time, closed input, plain JSON and content bounds before persistence", async () => {
  const cases: ExplicitUserRememberCommand[] = [
    command({ evidenceObservedAt: "2026-08-26T01:00:01.000Z" }),
    { ...command(), provider: "forbidden" } as unknown as ExplicitUserRememberCommand,
    command({ boundedContent: "x".repeat(16_385) }),
    command({ value: Number.NaN as never }),
  ];
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  cases.push(command({ value: cycle as never }));
  const accessor = command() as ExplicitUserRememberCommand & { provider?: string };
  Object.defineProperty(accessor, "boundedContent", { enumerable: true, get: () => "hidden" });
  cases.push(accessor);

  for (const input of cases) {
    const port = successfulPort();
    await assert.rejects(service(port).remember(input), (error: unknown) =>
      error instanceof ExplicitUserRememberError);
    assert.equal(port.calls.length, 0);
  }
});

test("exact replay is idempotent and all same-key drift conflicts before another write", async () => {
  const port = successfulPort();
  const remember = service(port);
  const first = await remember.remember(command());
  const replay = await remember.remember(command());
  assert.deepEqual(replay, first);
  assert.equal(port.calls.length, 1);

  const drifts: ExplicitUserRememberCommand[] = [
    command({ userId: "other-user" }),
    command({ value: { text: "different" } }),
    command({ boundedContent: "different" }),
    command({ evidenceRef: evidenceRef("TextEvidence", "evidence-b") }),
    command({ purposeScopes: ["memory"] }),
    command({ memoryKind: "semantic_fact" }),
  ];
  for (const drift of drifts) {
    await assert.rejects(
      remember.remember(drift),
      assertCode("EXPLICIT_REMEMBER_IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(port.calls.length, 1);
  }
});

test("append keys and fingerprints are stable, domain-separated and input-bound", async () => {
  const leftPort = successfulPort();
  const rightPort = successfulPort();
  await service(leftPort).remember(command());
  await service(rightPort).remember(command());
  const left = leftPort.calls[0]!;
  const right = rightPort.calls[0]!;
  assert.equal(left.candidateAppendIdempotencyKey, right.candidateAppendIdempotencyKey);
  assert.equal(left.memoryAppendIdempotencyKey, right.memoryAppendIdempotencyKey);
  assert.equal(left.candidateAppendFingerprint, right.candidateAppendFingerprint);
  assert.equal(left.memoryAppendFingerprint, right.memoryAppendFingerprint);
  assert.notEqual(left.candidateAppendIdempotencyKey, left.memoryAppendIdempotencyKey);
  assert.notEqual(left.candidateAppendFingerprint, left.memoryAppendFingerprint);
  assert.match(left.candidateAppendFingerprint, /^[0-9a-f]{64}$/u);
  assert.match(left.memoryAppendFingerprint, /^[0-9a-f]{64}$/u);
});

test("malicious persistence refs and watermark fail closed", async () => {
  for (const mutate of [
    (_input: ExplicitUserRememberPersistenceInput, result: Record<string, unknown>) => ({
      ...result,
      candidateRef: evidenceRef(),
    }),
    (_input: ExplicitUserRememberPersistenceInput, result: Record<string, unknown>) => ({
      ...result,
      authorityWatermark: { epoch: Number.POSITIVE_INFINITY },
    }),
    (_input: ExplicitUserRememberPersistenceInput, result: Record<string, unknown>) => ({
      ...result,
      secret: "forbidden",
    }),
  ]) {
    const port = successfulPort(mutate);
    await assert.rejects(
      service(port).remember(command()),
      assertCode("EXPLICIT_REMEMBER_PERSISTENCE_RECEIPT_INVALID"),
    );
    assert.equal(port.calls.length, 1);
  }
});

test("persistence failure is closed and does not poison a later exact retry", async () => {
  let attempts = 0;
  const port: ExplicitUserRememberPersistencePort = {
    async remember(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("database unavailable");
      assert.ok(input.candidateReceipt.candidateRef);
      assert.ok(input.memoryReceipt.memoryRef);
      return {
        candidateRef: input.candidateReceipt.candidateRef,
        memoryRef: input.memoryReceipt.memoryRef,
        authorityWatermark: { epoch: "2" },
      };
    },
  };
  const remember = service(port);
  await assert.rejects(
    remember.remember(command()),
    assertCode("EXPLICIT_REMEMBER_PERSISTENCE_FAILED"),
  );
  const output = await remember.remember(command());
  assert.equal(attempts, 2);
  assert.equal(output.memoryRef.refType, "PreferenceMemory");
});
