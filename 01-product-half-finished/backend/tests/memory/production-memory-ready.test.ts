import assert from "node:assert/strict";
import { test } from "node:test";

import type { FinalTranscriptEvidenceResult } from "../../services/realtime-core/src/final-transcript-evidence-service.ts";
import type { OpaqueCanonicalRef } from "../../services/realtime-core/src/types.ts";
import type { MemoryConsumerContext } from "../../services/memory-os/src/context-consumer-adapter.ts";
import type {
  ExplicitUserRememberCommand,
  ExplicitUserRememberResult,
} from "../../services/memory-os/src/explicit-user-remember-service.ts";
import type { FinalTranscriptEvidenceRecord } from "../../services/memory-os/src/final-transcript-explicit-remember-adapter.ts";
import {
  createProductionMemoryReady,
  type ProductionFinalTranscriptEvidenceCommitProjection,
  type ProductionMemoryReadyBinding,
} from "../../services/memory-os/src/production-memory-ready.ts";
import type { ProductionMemoryRuntime } from "../../services/platform-data/src/memory-runtime.ts";
import {
  assertCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "../../services/memory-os/src/canonical-ref.ts";
import { assertCanonicalTimestamp } from "../../services/realtime-core/src/types.ts";

function ref(refType: CanonicalObjectVersionRef["refType"], id: string): CanonicalObjectVersionRef {
  return assertCanonicalObjectVersionRef({
    refType,
    refId: id,
    objectVersion: "1",
    canonicalPayloadSha256: "a".repeat(64),
  });
}

const binding: ProductionMemoryReadyBinding = Object.freeze({
  userId: "user-production-1",
  sessionId: "session-production-1",
  deviceId: "rayneo-production-1",
  clientInstanceId: "client-production-1",
  realtimeSessionRef: "realtime-session-production-1" as OpaqueCanonicalRef,
  continuityId: "continuity-production-1",
  purpose: "windows.qwen.answer",
});

const evidenceRef = ref("FinalTranscriptEvidence", "019f1234-1234-7123-8123-1234567890ab");
const evidence: FinalTranscriptEvidenceRecord = Object.freeze({
  ref: evidenceRef,
  transcriptState: "final",
  userId: binding.userId,
  purpose: binding.purpose,
  text: "记住，我喜欢蓝色。",
  observedAt: assertCanonicalTimestamp("2026-08-28T00:00:00.000Z"),
});
const commit: ProductionFinalTranscriptEvidenceCommitProjection = Object.freeze({
  binding,
  evidence: Object.freeze({
    transcriptSegmentRef: ref("TranscriptSegment", "019f1234-1234-7123-8123-1234567890ac"),
    evidenceRef,
    outboxEventRef: "outbox-production-1" as OpaqueCanonicalRef,
    observedAt: evidence.observedAt,
  }) as unknown as FinalTranscriptEvidenceResult,
});
const evidenceRef2 = ref("FinalTranscriptEvidence", "019f1234-1234-7123-8123-1234567890af");
const evidence2: FinalTranscriptEvidenceRecord = Object.freeze({
  ...evidence,
  ref: evidenceRef2,
  text: "记住，我喜欢绿色。",
  observedAt: assertCanonicalTimestamp("2026-08-28T00:00:01.000Z"),
});
const commit2: ProductionFinalTranscriptEvidenceCommitProjection = Object.freeze({
  binding,
  evidence: Object.freeze({
    ...commit.evidence,
    evidenceRef: evidenceRef2,
    observedAt: evidence2.observedAt,
  }) as unknown as FinalTranscriptEvidenceResult,
});

function runtimeFixture(calls: ExplicitUserRememberCommand[]): ProductionMemoryRuntime {
  const result: ExplicitUserRememberResult = Object.freeze({
    candidateRef: ref("MemoryCandidate", "019f1234-1234-7123-8123-1234567890ad"),
    memoryRef: ref("PreferenceMemory", "019f1234-1234-7123-8123-1234567890ae"),
    authorityWatermark: "watermark-1",
  });
  const context: MemoryConsumerContext = Object.freeze({
    memories: Object.freeze([Object.freeze({
      ref: result.memoryRef,
      boundedContent: "喜欢蓝色。",
      selectionReason: "current",
    })]),
    suppressions: Object.freeze([]),
    authorityWatermark: "watermark-1",
  });
  return Object.freeze({
    userId: binding.userId,
    purposeScope: binding.purpose,
    remember: async () => result,
    rememberExplicit: async (input: ExplicitUserRememberCommand) => {
      calls.push(input);
      return result;
    },
    recallForAnswerContext: async () => context,
    close: async () => undefined,
  });
}

function createFixture(calls: ExplicitUserRememberCommand[]) {
  return createProductionMemoryReady({
    binding,
    evidenceReader: Object.freeze({
      read: async (refValue: CanonicalObjectVersionRef) => {
        assert.deepEqual(refValue, evidenceRef);
        return evidence;
      },
    }),
    memory: runtimeFixture(calls),
    sensitivity: Object.freeze({ classification: "normal", userConfirmed: true }),
  });
}

test("production memory ready admits one explicit remember and replays exactly once", async () => {
  const calls: ExplicitUserRememberCommand[] = [];
  const ready = createFixture(calls);
  const first = await ready.rememberFinalTranscript(commit);
  const second = await ready.rememberFinalTranscript(commit);
  assert.ok(first);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.boundedContent, "我喜欢蓝色。");
  const context = await ready.recallForAnswerContext({
    asOf: evidence.observedAt,
    maxItems: 8,
    maxContentBytes: 1024,
  });
  assert.equal(context.memories[0]?.boundedContent, "喜欢蓝色。");
  await ready.close();
});

test("production memory ready keeps distinct evidence in one session independent and replay-safe", async () => {
  const calls: ExplicitUserRememberCommand[] = [];
  const ready = createProductionMemoryReady({
    binding,
    evidenceReader: Object.freeze({
      read: async (refValue: CanonicalObjectVersionRef) => {
        if (refValue.refId === evidenceRef.refId) return evidence;
        if (refValue.refId === evidenceRef2.refId) return evidence2;
        return undefined;
      },
    }),
    memory: runtimeFixture(calls),
    sensitivity: Object.freeze({ classification: "normal", userConfirmed: true }),
  });
  const first = await ready.rememberFinalTranscript(commit);
  const second = await ready.rememberFinalTranscript(commit2);
  const replay = await ready.rememberFinalTranscript(commit);
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(replay, first);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.boundedContent), ["我喜欢蓝色。", "我喜欢绿色。"]);
  await ready.close();
});

test("ordinary final transcript performs zero memory writes", async () => {
  const calls: ExplicitUserRememberCommand[] = [];
  const ready = createFixture(calls);
  const ordinary = Object.freeze({
    ...commit,
    evidence: Object.freeze({ ...commit.evidence }),
  });
  const ordinaryRecord = Object.freeze({ ...evidence, text: "今天天气不错。" });
  const ordinaryReady = createProductionMemoryReady({
    binding,
    evidenceReader: Object.freeze({ read: async () => ordinaryRecord }),
    memory: runtimeFixture(calls),
    sensitivity: Object.freeze({ classification: "normal", userConfirmed: true }),
  });
  assert.equal(await ordinaryReady.rememberFinalTranscript(ordinary), undefined);
  assert.equal(calls.length, 0);
  await ready.close();
  await ordinaryReady.close();
});
