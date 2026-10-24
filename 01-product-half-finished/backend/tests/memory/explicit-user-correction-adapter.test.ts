import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  admitMemoryProposal,
  type AdmittedMemoryCandidateIntent,
} from "../../services/memory-os/src/admission.ts";
import {
  createCanonicalObjectVersionRef,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
} from "../../services/memory-os/src/canonical-ref.ts";
import {
  createProductionMemoryCanonicalIssuer,
  type CanonicalIssuerSystemContext,
  type ProductionMemoryIssuerReceipt,
} from "../../services/memory-os/src/canonical-issuer.ts";
import type {
  MemoryCommandResult,
  MemoryCommitReceipt,
  MemoryVersionRecord,
} from "../../services/memory-os/src/domain.ts";
import type { MemoryConsumerContext } from "../../services/memory-os/src/context-consumer-adapter.ts";
import {
  createExplicitUserCorrectionAdapter,
  ExplicitUserCorrectionAdapterError,
  type ExplicitUserCorrectionAdapterOptions,
  type ExplicitUserCorrectionInput,
} from "../../services/memory-os/src/explicit-user-correction-adapter.ts";
import type {
  ProductionMemoryLifecycle,
  ProductionMemoryLifecycleEnvelope,
} from "../../services/memory-os/src/production-memory-lifecycle.ts";
import type {
  MemoryCanonicalVersionReader,
  MemoryCanonicalVersionRead,
  MemoryReviewStateReader,
  OwnerPortResult,
} from "../../services/memory-os/src/ports.ts";
import type { ProductionMemoryReadyBinding } from "../../services/memory-os/src/production-memory-ready.ts";

const USER = "correction-adapter-user";
const PURPOSE = "windows.qwen.answer";
const SLOT = "preference.color";
const OLD_VALUE = "喜欢蓝色";
const NEW_VALUE = "改为绿色";
const INITIAL_TIME = "2026-09-07T00:00:00.000000Z";
const CORRECTION_TIME = "2026-09-07T00:01:00.000000Z";
const RECALL_TIME = "2026-09-07T00:02:00.000000Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ref(refType: CanonicalObjectVersionRef["refType"], suffix: string): CanonicalObjectVersionRef {
  return createCanonicalObjectVersionRef({
    refType,
    refId: `01952f00-0000-7000-8000-${suffix.padStart(12, "0")}`,
    objectVersion: "1",
    canonicalPayloadSha256: digest(`${refType}:${suffix}`),
  });
}

function binding(): ProductionMemoryReadyBinding {
  return Object.freeze({
    userId: USER,
    sessionId: "session-correction-001",
    deviceId: "device-correction-001",
    clientInstanceId: "client-correction-001",
    realtimeSessionRef: Object.freeze({ ref: "realtime-session-correction-001" }),
    continuityId: "continuity-correction-001",
    purpose: PURPOSE,
  });
}

const SYSTEM_CONTEXT: CanonicalIssuerSystemContext = Object.freeze({
  systemTime: CORRECTION_TIME,
  createdAt: INITIAL_TIME,
  updatedAt: CORRECTION_TIME,
  reviewedAt: CORRECTION_TIME,
});

function envelope(
  action: "correct_memory" | "recall_for_answer_context",
  key: string,
  ownerBinding: ProductionMemoryReadyBinding,
): ProductionMemoryLifecycleEnvelope {
  const governanceRef = ref("PolicyDecision", "900");
  const authorityReceipt = Object.freeze({
    kind: "production_memory_lifecycle_authority_receipt" as const,
    action,
    requestId: key,
    idempotencyKey: key,
    binding: ownerBinding,
    governanceRef,
    requestedAt: CORRECTION_TIME,
    authorizedAt: CORRECTION_TIME,
    authorityWatermark: Object.freeze({ authority_seq: "1" }),
  });
  return Object.freeze({
    requestId: key,
    idempotencyKey: key,
    binding: ownerBinding,
    governanceRef,
    requestedAt: CORRECTION_TIME,
    authorityReceipt,
  });
}

function initialCandidate(evidenceRef: CanonicalObjectVersionRef): AdmittedMemoryCandidateIntent {
  const result = admitMemoryProposal({
    proposalId: "initial-color",
    intent: { kind: "create" },
    userId: USER,
    kind: "preference_memory",
    slot: SLOT,
    value: { text: OLD_VALUE },
    sourceClass: "explicit_user_preference",
    evidenceRefs: [evidenceRef],
    confidencePpm: 1_000_000,
    purposeScopes: [PURPOSE],
    sensitivity: { classification: "normal", userConfirmed: true },
    validity: { observedAt: INITIAL_TIME },
    idempotencyKey: "initial-color",
  });
  assert.equal(result.status, "candidate");
  if (result.status !== "candidate") throw new Error("initial candidate admission failed");
  return result.intent;
}

interface Harness {
  readonly options: ExplicitUserCorrectionAdapterOptions;
  readonly input: ExplicitUserCorrectionInput;
  readonly oldRef: CanonicalObjectVersionRef;
  readonly current: MemoryVersionRecord;
  readonly predecessor: MemoryCanonicalVersionRead;
  readonly counts: { current: number; predecessor: number; candidate: number; successor: number; correct: number; recall: number; close: number };
}

function harness(overrides: {
  readonly currentRecords?: readonly MemoryVersionRecord[];
  readonly conflict?: boolean;
  readonly predecessor?: OwnerPortResult<MemoryCanonicalVersionRead>;
  readonly tamperPredecessorPayload?: boolean;
  readonly input?: Partial<ExplicitUserCorrectionInput>;
} = {}): Harness {
  const ownerBinding = binding();
  const evidenceRef = ref("TextEvidence", "101");
  const baseIssuer = createProductionMemoryCanonicalIssuer({ nowMs: () => 1_757_200_000_000 });
  const initial = initialCandidate(evidenceRef);
  const initialCandidateReceipt = baseIssuer.issueCandidate({ candidate: initial, context: SYSTEM_CONTEXT });
  const initialMemoryReceipt = baseIssuer.issueMemory({
    candidate: initial,
    candidateReceipt: initialCandidateReceipt,
    resolvedContent: OLD_VALUE,
    context: SYSTEM_CONTEXT,
  });
  const oldRef = initialMemoryReceipt.memoryRef!;
  const current: MemoryVersionRecord = Object.freeze({
    ref: oldRef,
    userId: USER,
    kind: "preference_memory",
    slot: SLOT,
    value: Object.freeze({ text: OLD_VALUE }),
    resolvedContent: OLD_VALUE,
    status: "current",
    current: true,
    sourceClass: "explicit_user_preference",
    evidenceRefs: Object.freeze([evidenceRef]),
    confidencePpm: 1_000_000,
    allowedPurposeScopes: Object.freeze([PURPOSE]),
    sensitivity: Object.freeze({ classification: "normal", userConfirmed: true }),
    validity: Object.freeze({ observedAt: INITIAL_TIME }),
  });
  const counts = { current: 0, predecessor: 0, candidate: 0, successor: 0, correct: 0, recall: 0, close: 0 };
  const predecessor: MemoryCanonicalVersionRead = Object.freeze({
    receipt: initialMemoryReceipt,
    payload: initialMemoryReceipt.payload,
    authorityWatermark: Object.freeze({ authority_seq: "1" }),
  });
  const predecessorPayload = overrides.tamperPredecessorPayload
    ? Object.freeze({ ...initialMemoryReceipt.payload, resolved_content: "未经授权的篡改" })
    : predecessor.payload;
  let lastSuccessor: ProductionMemoryIssuerReceipt | undefined;
  const issuer = Object.freeze({
    environment: "production" as const,
    issueCandidate(input: Parameters<typeof baseIssuer.issueCandidate>[0]) {
      counts.candidate += 1;
      return baseIssuer.issueCandidate(input);
    },
    issueCandidateSuccessor(input: Parameters<typeof baseIssuer.issueCandidateSuccessor>[0]) {
      return baseIssuer.issueCandidateSuccessor(input);
    },
    issueMemory(input: Parameters<typeof baseIssuer.issueMemory>[0]) {
      return baseIssuer.issueMemory(input);
    },
    issueMemorySuccessor(input: Parameters<typeof baseIssuer.issueMemorySuccessor>[0]) {
      counts.successor += 1;
      lastSuccessor = baseIssuer.issueMemorySuccessor(input);
      return lastSuccessor;
    },
  });
  const reviewStateReader: MemoryReviewStateReader = {
    async findAuthoritativeCurrentBySlot(query) {
      counts.current += 1;
      assert.deepEqual(query, { userId: USER, slot: SLOT });
      return Object.freeze({
        query,
        currentRecords: overrides.currentRecords ?? [current],
        conflict: overrides.conflict ?? false,
        authorityWatermark: Object.freeze({ authority_seq: "1" }),
      });
    },
  };
  const canonicalVersionReader: MemoryCanonicalVersionReader = {
    async readVersionByRef(input) {
      counts.predecessor += 1;
      assert.deepEqual(input.ref, oldRef);
      return overrides.predecessor ?? {
        ok: true,
        value: Object.freeze({
          ...predecessor,
          payload: predecessorPayload,
        }),
      };
    },
  };
  const lifecycle = {
    async correctMemory(call: Parameters<ProductionMemoryLifecycle["correctMemory"]>[0]) {
      counts.correct += 1;
      const receipt = call.input.issuerReceipt;
      lastSuccessor = receipt;
      const commitReceipt: MemoryCommitReceipt = Object.freeze({
        kind: "memory_commit_receipt",
        operation: "correction",
        outcome: "committed",
        idempotencyKey: call.input.idempotencyKey,
        fingerprint: digest("correction-commit") as MemoryCommitReceipt["fingerprint"],
        canonicalRefs: Object.freeze([receipt.memoryRef!]),
        supersededRefs: Object.freeze([call.input.expectedCurrentRef]),
        authorityWatermark: Object.freeze({ authority_seq: "2" }),
      });
      const value: MemoryCommandResult<MemoryCommitReceipt> = Object.freeze({ ok: true, receipt: commitReceipt });
      return Object.freeze({ authorityReceipt: call.envelope.authorityReceipt, value });
    },
    async recallForAnswerContext(call: Parameters<ProductionMemoryLifecycle["recallForAnswerContext"]>[0]) {
      counts.recall += 1;
      assert.equal(call.input.slot, SLOT);
      const successorRef = lastSuccessor?.memoryRef;
      if (successorRef === undefined) throw new Error("successor missing");
      const value: MemoryConsumerContext = Object.freeze({
        memories: Object.freeze([Object.freeze({
          ref: successorRef,
          boundedContent: NEW_VALUE,
          selectionReason: "eligible_current",
        })]),
        suppressions: Object.freeze([Object.freeze({
          ref: oldRef,
          suppressionReasons: Object.freeze(["non_current", "superseded"]),
        })]),
        authorityWatermark: Object.freeze({ authority_seq: "2" }),
      });
      return Object.freeze({ authorityReceipt: call.envelope.authorityReceipt, value });
    },
  } as unknown as ProductionMemoryLifecycle;
  const requestKey = "correction-adapter-001";
  const input: ExplicitUserCorrectionInput = Object.freeze({
    kind: "explicit_user_correction",
    binding: ownerBinding,
    slot: SLOT,
    newValue: NEW_VALUE,
    correctionEvidence: Object.freeze({ ref: ref("FinalTranscriptEvidence", "102"), observedAt: CORRECTION_TIME }),
    correctionEnvelope: envelope("correct_memory", requestKey, ownerBinding),
    recallEnvelope: envelope("recall_for_answer_context", "recall-adapter-001", ownerBinding),
    recallInput: Object.freeze({ asOf: RECALL_TIME, maxItems: 8, maxContentBytes: 4_096, slot: SLOT }),
    ...overrides.input,
  });
  return {
    options: { lifecycle, reviewStateReader, canonicalVersionReader, issuer, systemContext: SYSTEM_CONTEXT },
    input,
    oldRef,
    current,
    predecessor,
    counts,
  };
}

function isAdapterError(code: string) {
  return (error: unknown): boolean => error instanceof ExplicitUserCorrectionAdapterError && error.code === code;
}

test("correction switches the current version and excludes the predecessor from recall", async () => {
  const h = harness();
  const result = await createExplicitUserCorrectionAdapter(h.options).execute(h.input);
  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.notDeepEqual(result.successorRef, h.oldRef);
  assert.equal(result.successorRef.objectVersion, "2");
  assert.equal(result.recall.value.memories.length, 1);
  assert.deepEqual(result.recall.value.memories[0]!.ref, result.successorRef);
  assert.equal(result.recall.value.memories[0]!.boundedContent, NEW_VALUE);
  assert.equal(result.recall.value.memories.some((item) => canonicalRefKey(item.ref) === canonicalRefKey(h.oldRef)), false);
  assert.deepEqual(result.oldRefSuppressionReasons, ["non_current", "superseded"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.predecessorRef), true);
  assert.equal(Object.isFrozen(result.successorRef), true);
  assert.equal(Object.isFrozen(result.correction), true);
  assert.equal(Object.isFrozen(result.correction.value), true);
  assert.equal(result.correction.value.ok, true);
  if (result.correction.value.ok) assert.equal(Object.isFrozen(result.correction.value.receipt), true);
  assert.equal(Object.isFrozen(result.recall), true);
  assert.equal(Object.isFrozen(result.recall.value), true);
  assert.equal(Object.isFrozen(result.recall.value.memories), true);
  assert.equal(Object.isFrozen(result.recall.value.memories[0]!.ref), true);
  assert.equal(Object.isFrozen(result.recall.value.suppressions), true);
  assert.equal(Object.isFrozen(result.recall.value.suppressions[0]!.suppressionReasons), true);
  assert.deepEqual(h.counts, { current: 1, predecessor: 1, candidate: 1, successor: 1, correct: 1, recall: 1, close: 0 });
});

test("same-key replay returns the exact result without issuer or lifecycle calls, while payload drift conflicts", async () => {
  const h = harness();
  const adapter = createExplicitUserCorrectionAdapter(h.options);
  const first = await adapter.execute(h.input);
  const replay = await adapter.execute(h.input);
  assert.strictEqual(replay, first);
  assert.deepEqual(h.counts, { current: 1, predecessor: 1, candidate: 1, successor: 1, correct: 1, recall: 1, close: 0 });
  await assert.rejects(() => adapter.execute({ ...h.input, newValue: "改为红色" }), isAdapterError("CORRECTION_IDEMPOTENCY_CONFLICT"));
  assert.deepEqual(h.counts, { current: 1, predecessor: 1, candidate: 1, successor: 1, correct: 1, recall: 1, close: 0 });
});

test("ordinary text is not handled and performs no lifecycle work", async () => {
  const h = harness();
  const adapter = createExplicitUserCorrectionAdapter(h.options);
  assert.deepEqual(await adapter.execute("今天过得怎么样"), { handled: false, reason: "not_explicit_correction" });
  assert.deepEqual(await adapter.execute({ kind: "ordinary_text", text: "不用改" }), { handled: false, reason: "not_explicit_correction" });
  assert.deepEqual(h.counts, { current: 0, predecessor: 0, candidate: 0, successor: 0, correct: 0, recall: 0, close: 0 });
});

test("envelope or binding purpose drift rejects before the authoritative current read", async () => {
  const h = harness();
  const driftBinding = Object.freeze({ ...h.input.binding, purpose: "different-purpose" });
  const driftEnvelope = Object.freeze({
    ...h.input.correctionEnvelope,
    binding: driftBinding,
    authorityReceipt: Object.freeze({ ...h.input.correctionEnvelope.authorityReceipt, binding: driftBinding }),
  });
  await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute({
    ...h.input,
    correctionEnvelope: driftEnvelope,
  }), isAdapterError("CORRECTION_BINDING_DRIFT"));
  assert.deepEqual(h.counts, { current: 0, predecessor: 0, candidate: 0, successor: 0, correct: 0, recall: 0, close: 0 });
});

test("wrong-slot and wrong-purpose authoritative current records reject before issuer or lifecycle mutation", async () => {
  const seed = harness().current;
  for (const current of [
    Object.freeze({ ...seed, slot: "preference.other" }),
    Object.freeze({ ...seed, allowedPurposeScopes: Object.freeze(["different-purpose"]) }),
  ]) {
    const h = harness({ currentRecords: [current] });
    await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute(h.input), isAdapterError("CORRECTION_CURRENT_NOT_ELIGIBLE"));
    assert.equal(h.counts.current, 1);
    assert.equal(h.counts.predecessor, 0);
    assert.equal(h.counts.candidate, 0);
    assert.equal(h.counts.correct, 0);
  }
});

test("predecessor payload drift under an unchanged receipt and hash is rejected before issuer or lifecycle mutation", async () => {
  const h = harness({ tamperPredecessorPayload: true });
  await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute(h.input), isAdapterError("CORRECTION_PREDECESSOR_RECEIPT_INVALID"));
  assert.equal(h.counts.predecessor, 1);
  assert.equal(h.counts.candidate, 0);
  assert.equal(h.counts.correct, 0);
});

test("malformed correction evidence refs and hashes reject before owner reads", async () => {
  const h = harness();
  const malformed = Object.freeze({
    ref: Object.freeze({ ...h.input.correctionEvidence.ref, canonicalPayloadSha256: "not-a-sha256" }),
    observedAt: CORRECTION_TIME,
  });
  await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute({
    ...h.input,
    correctionEvidence: malformed,
  }), isAdapterError("CORRECTION_EVIDENCE_INVALID"));
  assert.deepEqual(h.counts, { current: 0, predecessor: 0, candidate: 0, successor: 0, correct: 0, recall: 0, close: 0 });
});

test("adapter source has no Map replay cache", async () => {
  const source = await readFile(new URL("../../services/memory-os/src/explicit-user-correction-adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:new\s+)?Map\b/u);
});

test("missing, multiple, stale, deleted, and suppressed current records reject before mutation", async () => {
  const seed = harness().current;
  for (const variant of [
    { currentRecords: [] as readonly MemoryVersionRecord[] },
    { currentRecords: [seed, seed] },
    { currentRecords: [Object.freeze({ ...seed, stale: true })] },
    { currentRecords: [Object.freeze({ ...seed, deletedAt: CORRECTION_TIME })] },
    { currentRecords: [Object.freeze({ ...seed, suppressedAt: CORRECTION_TIME })] },
  ]) {
    const h = harness(variant);
    await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute(h.input), (error: unknown) =>
      error instanceof ExplicitUserCorrectionAdapterError &&
      (error.code === "CORRECTION_CURRENT_MISSING_OR_MULTIPLE" || error.code === "CORRECTION_CURRENT_NOT_ELIGIBLE"));
    assert.equal(h.counts.predecessor, 0);
    assert.equal(h.counts.candidate, 0);
    assert.equal(h.counts.correct, 0);
  }
});

test("binding, evidence, predecessor receipt, and close fences fail closed", async () => {
  const h = harness();
  await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute({
    ...h.input,
    binding: Object.freeze({ ...h.input.binding, userId: "other-user" }),
  }), isAdapterError("CORRECTION_BINDING_DRIFT"));
  await assert.rejects(() => createExplicitUserCorrectionAdapter(h.options).execute({
    ...h.input,
    correctionEvidence: Object.freeze({ ref: ref("MemoryCandidate", "103"), observedAt: CORRECTION_TIME }),
  }), isAdapterError("CORRECTION_EVIDENCE_TYPE_INVALID"));
  const badRead = harness({ predecessor: { ok: true, value: Object.freeze({ receipt: {}, payload: {}, authorityWatermark: { authority_seq: "1" } }) as never } });
  await assert.rejects(() => createExplicitUserCorrectionAdapter(badRead.options).execute(badRead.input), isAdapterError("CORRECTION_PREDECESSOR_RECEIPT_INVALID"));
  const adapter = createExplicitUserCorrectionAdapter(h.options);
  const result = await adapter.execute(h.input);
  assert.equal(Object.isFrozen(result), true);
  await adapter.close();
  await adapter.close();
  assert.equal(h.counts.close, 0);
  await assert.rejects(() => adapter.execute(h.input), isAdapterError("CORRECTION_ADAPTER_CLOSED"));
});
