import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "../../services/memory-os/src/canonical-ref.ts";
import type {
  ExplicitUserRememberCommand,
  ExplicitUserRememberResult,
} from "../../services/memory-os/src/explicit-user-remember-service.ts";
import {
  createFinalTranscriptExplicitRememberAdapter,
  FinalTranscriptExplicitRememberError,
  type FinalTranscriptEvidenceReader,
  type FinalTranscriptEvidenceRecord,
  type FinalTranscriptExplicitRememberInput,
  type ExplicitUserRememberPort,
} from "../../services/memory-os/src/final-transcript-explicit-remember-adapter.ts";

const USER = "user-memory-adapter-001";
const PURPOSE = "conversation";
const OBSERVED_AT = "2026-08-26T01:02:03.123456Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ref(
  refType: CanonicalObjectVersionRef["refType"] = "FinalTranscriptEvidence",
  seed = "final-evidence-001",
): CanonicalObjectVersionRef {
  return createCanonicalObjectVersionRef({
    refType,
    refId: "01952f00-0000-7000-8000-000000000401",
    objectVersion: "1",
    canonicalPayloadSha256: digest(seed),
  });
}

const EVIDENCE_REF = ref();

function evidence(
  overrides: Partial<FinalTranscriptEvidenceRecord> = {},
): FinalTranscriptEvidenceRecord {
  return {
    ref: EVIDENCE_REF,
    transcriptState: "final",
    userId: USER,
    purpose: PURPOSE,
    text: "记住：我喜欢绿茶",
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function input(
  overrides: Partial<FinalTranscriptExplicitRememberInput> = {},
): FinalTranscriptExplicitRememberInput {
  return {
    userId: USER,
    purposeScopes: [PURPOSE, "memory"],
    originalUtterance: "记住：我喜欢绿茶",
    evidenceRef: EVIDENCE_REF,
    sensitivity: { classification: "normal", userConfirmed: true },
    ...overrides,
  };
}

function result(): ExplicitUserRememberResult {
  return {
    candidateRef: ref("MemoryCandidate", "candidate-001"),
    memoryRef: ref("PreferenceMemory", "memory-001"),
    authorityWatermark: { authority_seq: "1" },
  };
}

function harness(
  resolved: FinalTranscriptEvidenceRecord = evidence(),
): {
  readonly reader: FinalTranscriptEvidenceReader;
  readonly readerCalls: { count: number };
  readonly port: ExplicitUserRememberPort;
  readonly commands: ExplicitUserRememberCommand[];
} {
  const readerCalls = { count: 0 };
  const commands: ExplicitUserRememberCommand[] = [];
  const reader: FinalTranscriptEvidenceReader = {
    async read(readRef) {
      readerCalls.count += 1;
      assert.equal(readRef.refType, "FinalTranscriptEvidence");
      return resolved;
    },
  };
  const port: ExplicitUserRememberPort = {
    async rememberExplicit(command) {
      commands.push(command);
      return result();
    },
  };
  return { reader, readerCalls, port, commands };
}

function adapter(h: ReturnType<typeof harness>) {
  return createFinalTranscriptExplicitRememberAdapter({
    evidenceReader: h.reader,
    remember: h.port,
  });
}

function code(expected: string) {
  return (error: unknown): boolean =>
    error instanceof FinalTranscriptExplicitRememberError && error.code === expected;
}

test("maps one final explicit remember utterance to the existing rememberExplicit port", async () => {
  const h = harness();
  const output = await adapter(h).remember(input());

  assert.deepEqual(output, result());
  assert.equal(h.readerCalls.count, 1);
  assert.equal(h.commands.length, 1);
  const command = h.commands[0]!;
  assert.equal(command.action, "remember");
  assert.equal(command.userConfirmed, true);
  assert.equal(command.userId, USER);
  assert.deepEqual(command.purposeScopes, [PURPOSE, "memory"]);
  assert.equal(command.memoryKind, "preference_memory");
  assert.equal(command.boundedContent, "我喜欢绿茶");
  assert.deepEqual(command.value, { text: "我喜欢绿茶" });
  assert.equal(command.evidenceRef.refType, "FinalTranscriptEvidence");
  assert.deepEqual(command.evidenceRef, EVIDENCE_REF);
  assert.equal(command.evidenceObservedAt, OBSERVED_AT);
  assert.deepEqual(command.validity, { observedAt: OBSERVED_AT });
  assert.deepEqual(command.sensitivity, { classification: "normal", userConfirmed: true });
  assert.match(command.slot, /^preference\.explicit_transcript\.[0-9a-f]{64}$/u);
  assert.match(
    command.idempotencyKey,
    /^paios\.memory\.final-transcript-explicit-remember\.adapter\.v1:idempotency:[0-9a-f]{64}$/u,
  );
});

test("ordinary chat and malformed command content are no-ops before the owner read or remember port", async () => {
  const ordinary = harness();
  assert.equal(await adapter(ordinary).remember(input({ originalUtterance: "今天过得怎么样" })), undefined);
  assert.equal(ordinary.readerCalls.count, 0);
  assert.equal(ordinary.commands.length, 0);

  for (const utterance of [
    "记住",
    "记住：",
    `记住：${"x".repeat(16_385)}`,
  ]) {
    const h = harness();
    await assert.rejects(
      adapter(h).remember(input({ originalUtterance: utterance })),
      (error: unknown) =>
        error instanceof FinalTranscriptExplicitRememberError &&
        error.code === "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CONTENT_INVALID",
    );
    assert.equal(h.readerCalls.count, 0);
    assert.equal(h.commands.length, 0);
  }
});

test("rejects wrong ref type, non-final evidence, and every user/purpose/evidence drift before remember", async () => {
  const wrongType = harness();
  await assert.rejects(
    adapter(wrongType).remember(input({ evidenceRef: ref("TextEvidence", "text-evidence-001") })),
    code("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TYPE_INVALID"),
  );
  assert.equal(wrongType.readerCalls.count, 0);
  assert.equal(wrongType.commands.length, 0);

  for (const [record, expectedCode] of [
    [evidence({ transcriptState: "partial" as never }), "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_FINAL_REQUIRED"],
    [evidence({ userId: "other-user" }), "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_USER_DRIFT"],
    [evidence({ purpose: "other-purpose" }), "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_PURPOSE_DRIFT"],
    [evidence({ text: "记住：另一段原话" }), "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TEXT_DRIFT"],
  ] as const) {
    const h = harness(record);
    await assert.rejects(adapter(h).remember(input()), code(expectedCode));
    assert.equal(h.commands.length, 0);
  }
});

test("rejects extra, accessor, cyclic, and unconfirmed sensitivity input with zero remember calls", async () => {
  const extra = { ...input(), extra: true } as unknown as FinalTranscriptExplicitRememberInput;
  const extraHarness = harness();
  await assert.rejects(
    adapter(extraHarness).remember(extra),
    code("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_INPUT_INVALID"),
  );

  const accessorSensitivity = {} as Record<string, unknown>;
  Object.defineProperty(accessorSensitivity, "classification", {
    enumerable: true,
    get: () => "normal",
  });
  Object.defineProperty(accessorSensitivity, "userConfirmed", {
    enumerable: true,
    value: true,
  });
  const accessorHarness = harness();
  await assert.rejects(
    adapter(accessorHarness).remember(input({ sensitivity: accessorSensitivity as never })),
    code("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_INPUT_INVALID"),
  );

  const cyclicScopes: unknown[] = ["conversation"];
  cyclicScopes.push(cyclicScopes);
  const cyclicHarness = harness();
  await assert.rejects(
    adapter(cyclicHarness).remember(input({ purposeScopes: cyclicScopes as never })),
    code("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_PURPOSE_INVALID"),
  );

  const unconfirmedHarness = harness();
  await assert.rejects(
    adapter(unconfirmedHarness).remember(input({
      sensitivity: { classification: "normal", userConfirmed: false },
    })),
    code("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CONFIRMATION_REQUIRED"),
  );

  assert.equal(extraHarness.commands.length, 0);
  assert.equal(accessorHarness.commands.length, 0);
  assert.equal(cyclicHarness.commands.length, 0);
  assert.equal(unconfirmedHarness.commands.length, 0);
});

test("replays exact input, rejects same-key drift, and keeps command identity deterministic across adapters", async () => {
  const firstHarness = harness();
  const firstAdapter = adapter(firstHarness);
  const first = await firstAdapter.remember(input());
  const replay = await firstAdapter.remember(input());
  assert.deepEqual(replay, first);
  assert.equal(firstHarness.commands.length, 1);

  await assert.rejects(
    firstAdapter.remember(input({
      sensitivity: { classification: "sensitive", userConfirmed: true },
    })),
    code("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(firstHarness.commands.length, 1);

  const secondHarness = harness();
  await adapter(secondHarness).remember(input());
  assert.equal(secondHarness.commands.length, 1);
  assert.equal(
    firstHarness.commands[0]!.idempotencyKey,
    secondHarness.commands[0]!.idempotencyKey,
  );
  assert.equal(firstHarness.commands[0]!.slot, secondHarness.commands[0]!.slot);
  assert.deepEqual(firstHarness.commands[0], secondHarness.commands[0]);
});

