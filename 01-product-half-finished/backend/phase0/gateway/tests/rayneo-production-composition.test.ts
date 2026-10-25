import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type {
  FinalTranscriptEvidenceInput,
  FinalTranscriptEvidenceResult,
  FinalTranscriptEvidenceService,
  T11BCanonicalRef,
} from '../../../services/realtime-core/src/final-transcript-evidence-service.ts';
import type { CanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import {
  createCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from '../../../services/memory-os/src/canonical-ref.ts';
import type {
  ExplicitUserRememberCommand,
  ExplicitUserRememberResult,
} from '../../../services/memory-os/src/explicit-user-remember-service.ts';
import type { FinalTranscriptEvidenceRecord } from '../../../services/memory-os/src/final-transcript-explicit-remember-adapter.ts';
import type { MemoryConsumerContext } from '../../../services/memory-os/src/context-consumer-adapter.ts';
import type {
  SourceVisualIssueReceipt,
  SourceVisualReadResult,
} from '../../../services/connector-runtime/src/index.ts';
import type {
  RayneoFinalTranscriptOwnerBinding,
  RayneoSourceMediaAuthorityInput,
} from '../src/rayneo-final-transcript-authority.ts';
import {
  QWEN38_ORCAROUTER_PROFILE,
} from '../src/qwen38-provider-adapter.ts';
import {
  createRayneoProductionComposition,
  type RayneoProductionCompositionOptions,
  type RayneoProductionFinalTranscriptPostCommit,
  type RayneoVisualSourceMediaInput,
} from '../src/rayneo-production-composition.ts';
import type {
  RayneoFinalTranscriptAuthorityInput,
  RayneoRealtimeMultimodalReplyInput,
  RayneoRealtimeVisualHeartbeatInput,
} from '../src/rayneo-realtime-audio-controller.ts';

const OBSERVED_AT = '2026-08-28T01:02:03.123Z' as CanonicalTimestamp;
const NEGOTIATION_ON_REPLY = '已开启谈判模式；我只依据可观察语言、停顿和画面给出建议，并标注不确定性。';
const NEGOTIATION_OFF_REPLY = '已关闭谈判模式。';
const NEGOTIATION_FALLBACK = '建议：暂不调整条件；依据：结构不完整；置信度：低；未知项：真实约束；替代解释：可能需要更多信息';
const SESSION = 'phase0_session_aaaaaaaaaaaaaaaaaaaa';
const DEVICE = 'rayneo_device_bbbbbbbbbbbbbbbbbbbb';
const CLIENT = 'rayneo_client_cccccccccccccccccccc';
const CANONICAL_DEVICE_ID = '01952f00-0000-7000-8000-000000000102';
const BINDING = Object.freeze({
  runId: 'rayneo_run_dddddddddddddddddddd',
  sessionId: SESSION,
  deviceId: DEVICE,
  clientInstanceId: CLIENT,
  replyId: 'rayneo_reply_eeeeeeeeeeeeeeeeeeee',
  frameId: 'rayneo_frame_ffffffffffffffffffff',
  receiptIdempotencyKey: 'rayneo_display_11111111111111111111',
  openedAt: Date.parse(OBSERVED_AT),
  expiresAt: Date.parse(OBSERVED_AT) + 900_000,
});
const VISUAL_FRAME = Object.freeze({
  frameId: BINDING.frameId,
  capturedAt: OBSERVED_AT,
  width: 64,
  height: 64,
});
const SESSION_REF = Object.freeze({ kind: 'RealtimeSession', id: 'session-rayneo-production' });
const SOURCE_REF = ref('SourceArtifact', '01952f00-0000-7000-8000-000000000201');
const VISUAL_REF = ref('ArtifactVersion', '01952f00-0000-7000-8000-000000000202');
const SEGMENT_REF = ref('TranscriptSegment', '01952f00-0000-7000-8000-000000000301');
const EVIDENCE_REF = ref('FinalTranscriptEvidence', '01952f00-0000-7000-8000-000000000401');
const CANDIDATE_REF = memoryRef('SemanticFact', '01952f00-0000-7000-8000-000000000501');
const MEMORY_REF = memoryRef('PreferenceMemory', '01952f00-0000-7000-8000-000000000502');
const DURABLE_BINDING = Object.freeze({
  realtimeSessionRef: Object.freeze({
    ref_type: 'RealtimeSession', ref_id: '01952f00-0000-7000-8000-000000000601',
    object_version: '1', canonical_payload_sha256: 'c'.repeat(64),
  }),
  deviceLeaseRef: Object.freeze({
    ref_type: 'DeviceLease', ref_id: '01952f00-0000-7000-8000-000000000602',
    object_version: '1', canonical_payload_sha256: 'd'.repeat(64),
  }),
  continuityId: '01952f00-0000-7000-8000-000000000603',
  connectionEpoch: '1',
  leaseVersion: '1',
});

function ref(refType: T11BCanonicalRef['refType'], refId: string): T11BCanonicalRef {
  return Object.freeze({
    refType,
    refId,
    objectVersion: '1',
    canonicalPayloadSha256: 'a'.repeat(64),
  });
}

function memoryRef(refType: string, refId: string): CanonicalObjectVersionRef {
  return createCanonicalObjectVersionRef({
    refType,
    refId,
    objectVersion: '1',
    canonicalPayloadSha256: 'b'.repeat(64),
  });
}

function input(transcript: string, bytes = Uint8Array.of(10, 0, 246, 255)): RayneoFinalTranscriptAuthorityInput {
  return Object.freeze({
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    segmentId: 'rayneo_segment_aaaaaaaaaaaaaaaaaaaa',
    startMs: 0,
    endMs: 1_000,
    speakerLabel: 'speaker_0',
    diarizationStatus: 'window_local',
    transcript,
    language: 'und',
    observedAt: OBSERVED_AT,
    media: Object.freeze({
      format: 'pcm_s16le',
      sampleRate: 16_000,
      channels: 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    }),
  });
}

function postCommit(
  finalInput: RayneoFinalTranscriptAuthorityInput,
  evidence: FinalTranscriptEvidenceResult,
): RayneoProductionFinalTranscriptPostCommit {
  return Object.freeze({
    input: Object.freeze({
      sessionId: finalInput.sessionId,
      deviceId: finalInput.deviceId,
      clientInstanceId: finalInput.clientInstanceId,
      segmentId: finalInput.segmentId,
      startMs: finalInput.startMs,
      endMs: finalInput.endMs,
      speakerLabel: finalInput.speakerLabel,
      diarizationStatus: finalInput.diarizationStatus,
      transcript: finalInput.transcript,
      language: finalInput.language,
      observedAt: finalInput.observedAt,
    }),
    evidence,
  });
}

function continuousInput(
  segment: 'a' | 'b',
  startMs: number,
  transcript = '请说明当前画面。',
): RayneoFinalTranscriptAuthorityInput {
  const bytes = segment === 'a' ? Uint8Array.of(1, 2, 3, 4) : Uint8Array.of(5, 6, 7, 8);
  return Object.freeze({
    ...input(transcript, bytes),
    segmentId: `rayneo_segment_${segment.repeat(20)}`,
    startMs,
    endMs: startMs + 1_000,
    observedAt: new Date(BINDING.openedAt + startMs + 1_000).toISOString(),
  });
}

function realtimeReplyInput(
  finalInput: RayneoFinalTranscriptAuthorityInput,
  byte: number,
): RayneoRealtimeMultimodalReplyInput {
  return Object.freeze({
    segmentId: finalInput.segmentId,
    startMs: finalInput.startMs,
    endMs: finalInput.endMs,
    speakerLabel: finalInput.speakerLabel,
    transcript: finalInput.transcript,
    videoSamples: Object.freeze([
      Object.freeze({
        observedAtMs: BINDING.openedAt + finalInput.startMs + 250,
        mimeType: 'image/png' as const,
        width: 2,
        height: 1,
        bytes: Uint8Array.of(137, 80, 78, 71, byte),
      }),
      Object.freeze({
        observedAtMs: BINDING.openedAt + finalInput.startMs + 750,
        mimeType: 'image/png' as const,
        width: 2,
        height: 1,
        bytes: Uint8Array.of(137, 80, 78, 71, byte + 1),
      }),
    ]),
  });
}

function visualHeartbeatInput(byte: number): RayneoRealtimeVisualHeartbeatInput {
  return Object.freeze({
    segmentId: 'rayneo_segment_cccccccccccccccccccc',
    startMs: 0,
    endMs: 1_000,
    videoSamples: Object.freeze([
      Object.freeze({
        observedAtMs: BINDING.openedAt + 250,
        mimeType: 'image/png' as const,
        width: 2,
        height: 1,
        bytes: Uint8Array.of(137, 80, 78, 71, byte),
      }),
      Object.freeze({
        observedAtMs: BINDING.openedAt + 750,
        mimeType: 'image/png' as const,
        width: 2,
        height: 1,
        bytes: Uint8Array.of(137, 80, 78, 71, byte + 1),
      }),
    ]),
  });
}

function generatedText(value: unknown): string {
  return typeof value === 'string' ? value : (value as { text: string }).text;
}

function makeHarness(
  transcript: string,
  qwenResponses: readonly string[] = ['这是同一请求的回复。'],
  conversationTurn?: RayneoProductionCompositionOptions['conversationTurn'],
): {
  readonly composition: ReturnType<typeof createRayneoProductionComposition>;
  readonly turn: ReturnType<ReturnType<typeof createRayneoProductionComposition>['openTurn']>;
  readonly sourceInputs: Array<RayneoSourceMediaAuthorityInput | RayneoVisualSourceMediaInput>;
  readonly evidenceInputs: FinalTranscriptEvidenceInput[];
  readonly rememberInputs: ExplicitUserRememberCommand[];
  readonly recallInputs: Array<Readonly<Record<string, unknown>>>;
  readonly qwenBodies: Record<string, unknown>[];
  readonly speechTexts: string[];
  readonly events: string[];
  readonly setOwnerBinding: (binding: RayneoFinalTranscriptOwnerBinding) => void;
  readonly setVisualReceipt: (receipt: SourceVisualIssueReceipt | undefined) => void;
  readonly setVisualReadResult: (result: SourceVisualReadResult | undefined) => void;
} {
  const sourceInputs: Array<RayneoSourceMediaAuthorityInput | RayneoVisualSourceMediaInput> = [];
  const evidenceInputs: FinalTranscriptEvidenceInput[] = [];
  const rememberInputs: ExplicitUserRememberCommand[] = [];
  const recallInputs: Array<Readonly<Record<string, unknown>>> = [];
  const qwenBodies: Record<string, unknown>[] = [];
  const speechTexts: string[] = [];
  const events: string[] = [];
  let visualReceiptOverride: SourceVisualIssueReceipt | undefined;
  let visualReadOverride: SourceVisualReadResult | undefined;
  let defaultVisualRead: SourceVisualReadResult | undefined;
  let ownerBinding: RayneoFinalTranscriptOwnerBinding = Object.freeze({
    canonicalDeviceId: CANONICAL_DEVICE_ID,
    userId: 'user-rayneo-production',
    realtimeSessionRef: SESSION_REF,
    continuityId: 'continuity-rayneo-production',
    purpose: 'conversation',
  });
  const evidenceRecord: FinalTranscriptEvidenceRecord = Object.freeze({
    ref: createCanonicalObjectVersionRef(EVIDENCE_REF),
    transcriptState: 'final',
    userId: 'user-rayneo-production',
    purpose: 'conversation',
    text: transcript,
    observedAt: OBSERVED_AT,
  });
  const evidence: FinalTranscriptEvidenceResult = Object.freeze({
    transcriptSegmentRef: SEGMENT_REF,
    evidenceRef: EVIDENCE_REF,
    outboxEventRef: Object.freeze({ kind: 'OutboxEvent', id: 'outbox-rayneo-production' }),
    observedAt: OBSERVED_AT,
  });
  const options: RayneoProductionCompositionOptions = {
    ownerBinding: {
      resolve: async () => { events.push('owner-binding'); return ownerBinding; },
    },
    sourceMedia: {
      issue: async (sourceInput) => {
        events.push('audio-source');
        sourceInputs.push(sourceInput);
        return SOURCE_REF;
      },
      issueVisual: async (sourceInput) => {
        events.push('visual-source');
        sourceInputs.push(sourceInput);
        return VISUAL_REF;
      },
      issueVisualWithReceipt: async (sourceInput): Promise<SourceVisualIssueReceipt> => {
        events.push('visual-source');
        sourceInputs.push(sourceInput);
        const receipt: SourceVisualIssueReceipt = Object.freeze({
          sourceArtifactRef: SOURCE_REF,
          artifactVersionRef: VISUAL_REF,
          contentSha256: sourceInput.media.sha256,
          bytes: sourceInput.media.bytes.byteLength,
          mediaKind: 'visual',
          captureId: sourceInput.captureId,
          capturedAt: sourceInput.capturedAt,
          format: sourceInput.media.format,
          width: sourceInput.media.width,
          height: sourceInput.media.height,
        });
        defaultVisualRead = Object.freeze({
          sourceArtifactRef: receipt.sourceArtifactRef,
          artifactVersionRef: receipt.artifactVersionRef,
          contentSha256: receipt.contentSha256,
          bytes: Uint8Array.from(sourceInput.media.bytes),
          mediaKind: 'visual' as const,
          captureId: receipt.captureId,
          capturedAt: receipt.capturedAt,
          format: receipt.format,
          width: receipt.width,
          height: receipt.height,
        });
        return visualReceiptOverride ?? receipt;
      },
      readVisual: async (): Promise<SourceVisualReadResult> => {
        if (visualReadOverride !== undefined) return visualReadOverride;
        if (defaultVisualRead === undefined) throw new Error('VISUAL_READ_BEFORE_ISSUE');
        return defaultVisualRead;
      },
    },
    finalTranscript: {
      finalize: async (evidenceInput) => {
        events.push('final-evidence');
        evidenceInputs.push(evidenceInput);
        return evidence;
      },
    } satisfies FinalTranscriptEvidenceService,
    finalTranscriptEvidenceReader: {
      read: async (evidenceRef) => evidenceRef.refId === EVIDENCE_REF.refId ? evidenceRecord : undefined,
    },
    memory: {
      rememberExplicit: async (rememberInput): Promise<ExplicitUserRememberResult> => {
        events.push('remember');
        rememberInputs.push(rememberInput);
        return Object.freeze({
          candidateRef: CANDIDATE_REF,
          memoryRef: MEMORY_REF,
          authorityWatermark: { phase: 'test' },
        });
      },
      recallForAnswerContext: async (recallInput) => {
        events.push('recall');
        recallInputs.push(recallInput);
        return Object.freeze({
          memories: Object.freeze([Object.freeze({
            ref: MEMORY_REF,
            boundedContent: '用户偏好：使用简体中文。',
            selectionReason: 'same-user preference',
          })]),
          suppressions: Object.freeze([]),
          authorityWatermark: { phase: 'test' },
        }) as MemoryConsumerContext;
      },
    },
    sensitivity: Object.freeze({ classification: 'normal', userConfirmed: true }),
    qwenProfile: QWEN38_ORCAROUTER_PROFILE,
    recall: Object.freeze({ maxItems: 8, maxContentBytes: 4_096 }),
    synthesizeSpeech: async (text) => {
      speechTexts.push(text);
      return Object.freeze({ pcm: Int16Array.of(1, -1, 2, -2), sampleRate: 16_000 as const, channels: 1 as const });
    },
    now: () => OBSERVED_AT,
    ...(conversationTurn === undefined ? {} : { conversationTurn }),
    fetchImpl: async (_request, init) => {
      events.push('qwen');
      assert.equal(init?.method, 'POST');
      assert.equal(typeof init?.body, 'string');
      qwenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
       const responseText = qwenResponses[Math.min(qwenBodies.length - 1, qwenResponses.length - 1)] ?? '这是同一请求的回复。';
       const body = [
         `data: {"choices":[{"delta":{"content":"${responseText}"},"finish_reason":null}]}`,
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  };
  const composition = createRayneoProductionComposition(options);
  const turn = composition.openTurn(BINDING);
  return {
    composition, turn, sourceInputs, evidenceInputs, rememberInputs, recallInputs, qwenBodies, speechTexts, events,
    setOwnerBinding: (binding) => { ownerBinding = binding; },
    setVisualReceipt: (receipt) => { visualReceiptOverride = receipt; },
    setVisualReadResult: (result) => { visualReadOverride = result; },
  };
}

function durableTestPort(restored: readonly Record<string, unknown>[] = []) {
  const claims: string[] = [];
  const completions: string[] = [];
  const port = {
    binding: async () => DURABLE_BINDING as never,
    restored: restored as never,
    postgres: {
      beginClaim: async (input: { readonly inputKind: string; readonly inputId: string }) => {
        claims.push(`${input.inputKind}:${input.inputId}`);
        return { kind: 'claimed', retryAllowed: false };
      },
      commitCompletedAfterPublish: async (input: { readonly claim: { readonly inputId: string } }) => {
        completions.push(input.claim.inputId);
        return {};
      },
      markIndeterminate: async () => ({}),
      releaseBeforePublish: async () => true,
      readByInput: async () => undefined,
      readRecentCompleted: async () => restored,
    },
  } as unknown as RayneoProductionCompositionOptions['conversationTurn'];
  return { port, claims, completions };
}

test('one production turn shares typed history with a later audio segment reply', async () => {
  const fixture = makeHarness('audio B。', ['typed A。', 'audio B reply。']);
  const typedEvents: string[] = [];
  for await (const event of fixture.turn.streamTypedReply(
    { promptId: '11111111-1111-4111-8111-111111111111', text: 'typed A' },
    new AbortController().signal,
  )) {
    if (event.kind === 'final') typedEvents.push(event.text);
  }
  assert.deepEqual(typedEvents, ['typed A。']);
  const audioInput = continuousInput('b', 2_000, 'audio B。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(audioInput);
  await fixture.turn.afterFinalTranscript(postCommit(audioInput, evidence));
  await fixture.turn.generateSegmentReply(audioInput.segmentId, audioInput.transcript, audioInput.speakerLabel, new AbortController().signal);
  assert.equal(fixture.qwenBodies.length, 2);
  const secondMessages = JSON.stringify(fixture.qwenBodies[1]?.messages);
  assert.match(secondMessages, /typed A/);
  assert.match(secondMessages, /audio B/);
  assert.notEqual(audioInput.segmentId, 'rayneo_segment_aaaaaaaaaaaaaaaaaaaa');
  await fixture.composition.close();
});

test('durable conversation claims precede typed visual audio Qwen and publish completion is explicit', async () => {
  const claims: string[] = [];
  const completions: string[] = [];
  const port = {
    binding: async () => DURABLE_BINDING as never,
    postgres: {
      beginClaim: async (claim: { readonly inputKind: string; readonly inputId: string }) => {
        claims.push(`${claim.inputKind}:${claim.inputId}`);
        return { kind: 'claimed', retryAllowed: false };
      },
      commitCompletedAfterPublish: async (input: { readonly claim: { readonly inputId: string } }) => {
        completions.push(input.claim.inputId);
        return {};
      },
      markIndeterminate: async () => ({}),
      releaseBeforePublish: async () => true,
      readByInput: async () => undefined,
      readRecentCompleted: async () => [],
    },
  } as unknown as RayneoProductionCompositionOptions['conversationTurn'];
  const fixture = makeHarness('audio C。', ['typed A。', 'visual B。', 'audio C reply。'], port);
  const durableVisualInput = Object.freeze({
    segmentId: 'rayneo_segment_cccccccccccccccccccc',
    startMs: 0,
    endMs: 1_000,
    videoSamples: Object.freeze([Object.freeze({
      observedAtMs: BINDING.openedAt + 250,
      mimeType: 'image/png' as const,
      width: 2,
      height: 1,
      bytes: Uint8Array.of(137, 80, 78, 71, 31),
    })]),
  });
  for await (const _event of fixture.turn.streamTypedReply(
    { promptId: '34343434-3434-4343-8434-343434343434', text: 'typed A' },
    new AbortController().signal,
  )) { /* consume */ }
  await fixture.turn.completeConversationTurn('34343434-3434-4343-8434-343434343434', 'typed A。');
  const visual = await fixture.turn.generateVisualHeartbeatReply(durableVisualInput, new AbortController().signal);
  await fixture.turn.completeConversationTurn(durableVisualInput.segmentId, generatedText(visual));
  const audioInput = continuousInput('b', 8_000, 'audio C。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(audioInput);
  await fixture.turn.afterFinalTranscript(postCommit(audioInput, evidence));
  const audio = await fixture.turn.generateSegmentReply(
    audioInput.segmentId, audioInput.transcript, audioInput.speakerLabel, new AbortController().signal,
  );
  await fixture.turn.completeConversationTurn(audioInput.segmentId, generatedText(audio));
  assert.deepEqual(claims, [
    'typed:34343434-3434-4343-8434-343434343434',
    `visual:${durableVisualInput.segmentId}`,
    `audio:${audioInput.segmentId}`,
  ]);
  assert.equal(completions.length, 3);
  assert.equal(fixture.qwenBodies.length, 3);
  await fixture.composition.close();
});

test('durable restart history restores four bounded pairs and visual labels without base64', async () => {
  const claims: string[] = [];
  const restored = Array.from({ length: 4 }, (_, index) => ({
    schema: 'realtime.conversation.turn.completed.v1',
    user_text: index === 3 ? undefined : `old user ${index}`,
    source_visual_refs: index === 3 ? [VISUAL_REF] : undefined,
    assistant_text: `old reply ${index}`,
  })) as never;
  const port = {
    binding: async () => DURABLE_BINDING as never,
    restored,
    postgres: {
      beginClaim: async (claim: { readonly inputKind: string; readonly inputId: string }) => {
        claims.push(`${claim.inputKind}:${claim.inputId}`);
        return { kind: 'claimed', retryAllowed: false };
      },
      commitCompletedAfterPublish: async () => ({}), markIndeterminate: async () => ({}),
      releaseBeforePublish: async () => true, readByInput: async () => undefined,
      readRecentCompleted: async () => restored,
    },
  } as unknown as RayneoProductionCompositionOptions['conversationTurn'];
  const fixture = makeHarness('new reply。', ['new reply。'], port);
  for await (const _event of fixture.turn.streamTypedReply(
    { promptId: '45454545-4545-4454-8454-454545454545', text: 'new user' },
    new AbortController().signal,
  )) { /* consume */ }
  const messages = JSON.stringify(fixture.qwenBodies[0]?.messages);
  assert.match(messages, /old user 0/u);
  assert.match(messages, /old reply 3/u);
  assert.match(messages, /视觉来源/u);
  assert.doesNotMatch(messages, /data:image\//u);
  assert.equal(claims.length, 1);
  await fixture.composition.close();
});

test('completed durable replay emits the stored assistant text without a provider call', async () => {
  const port = {
    binding: async () => DURABLE_BINDING as never,
    postgres: {
      beginClaim: async () => ({
        kind: 'replay', retryAllowed: false,
        receipt: { assistant_text: 'stored durable reply。' },
      }),
      commitCompletedAfterPublish: async () => { throw new Error('REPLAY_MUST_NOT_COMMIT'); },
      markIndeterminate: async () => { throw new Error('REPLAY_MUST_NOT_MARK'); },
      releaseBeforePublish: async () => { throw new Error('REPLAY_MUST_NOT_RELEASE'); },
      readByInput: async () => undefined,
      readRecentCompleted: async () => [],
    },
  } as unknown as RayneoProductionCompositionOptions['conversationTurn'];
  const fixture = makeHarness('unused', [], port);
  const events: string[] = [];
  for await (const event of fixture.turn.streamTypedReply(
    { promptId: '56565656-5656-4565-8565-565656565656', text: 'replay me' },
    new AbortController().signal,
  )) {
    if (event.kind === 'final') events.push(event.text);
  }
  await fixture.turn.completeConversationTurn('56565656-5656-4565-8565-565656565656', 'stored durable reply。');
  assert.deepEqual(events, ['stored durable reply。']);
  assert.equal(fixture.qwenBodies.length, 0);
  await fixture.composition.close();
});

test('negotiation toggles are exact, staged until durable completion, and provider-free', async () => {
  const durable = durableTestPort();
  const fixture = makeHarness('unused', [
    '建议：保持原条件；依据：停顿和表述可观察；置信度：低；未知项：真实约束；替代解释：可能只是表达习惯。',
    '普通回复。',
  ], durable.port);
  const signal = new AbortController().signal;
  const onEvents: string[] = [];
  for await (const event of fixture.turn.streamTypedReply(
    { promptId: '67676767-6767-4676-8676-676767676767', text: '开启谈判模式!!!' }, signal,
  )) if (event.kind === 'final') onEvents.push(event.text);
  assert.deepEqual(onEvents, [NEGOTIATION_ON_REPLY]);
  assert.equal(fixture.qwenBodies.length, 0);
  await fixture.turn.completeConversationTurn('67676767-6767-4676-8676-676767676767', NEGOTIATION_ON_REPLY);
  for await (const _event of fixture.turn.streamTypedReply(
    { promptId: '68686868-6868-4686-8686-686868686868', text: '请给建议' }, signal,
  )) { /* consume */ }
  assert.equal(fixture.qwenBodies.length, 1);
  assert.match(JSON.stringify(fixture.qwenBodies[0]?.messages), /不得判断谎言/u);
  await fixture.turn.completeConversationTurn('68686868-6868-4686-8686-686868686868',
    '建议：保持原条件；依据：停顿和表述可观察；置信度：低；未知项：真实约束；替代解释：可能只是表达习惯。');
  for await (const event of fixture.turn.streamTypedReply(
    { promptId: '69696969-6969-4696-8696-696969696969', text: '退出谈判模式？！' }, signal,
  )) if (event.kind === 'final') assert.equal(event.text, NEGOTIATION_OFF_REPLY);
  assert.equal(fixture.qwenBodies.length, 1);
  await fixture.turn.completeConversationTurn('69696969-6969-4696-8696-696969696969', NEGOTIATION_OFF_REPLY);
  await fixture.composition.close();
});

test('negotiation audio emits bounded facts and invalid model output uses one fallback without retry', async () => {
  const durable = durableTestPort();
  const valid = '建议：保持原条件；依据：speaker_0发言持续1000毫秒，停顿间隔1000毫秒；置信度：低；未知项：真实约束；替代解释：可能只是表达习惯。';
  const fixture = makeHarness('unused', [valid], durable.port);
  const signal = new AbortController().signal;
  const toggle = continuousInput('a', 0, '开启谈判模式。');
  const toggleEvidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(toggle);
  await fixture.turn.afterFinalTranscript(postCommit(toggle, toggleEvidence));
  const toggleReply = await fixture.turn.generateSegmentReply(toggle.segmentId, toggle.transcript, toggle.speakerLabel, signal);
  await fixture.turn.completeConversationTurn(toggle.segmentId, generatedText(toggleReply));
  const audio = continuousInput('b', 2_000, '请给建议。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(audio);
  await fixture.turn.afterFinalTranscript(postCommit(audio, evidence));
  const reply = await fixture.turn.generateSegmentReply(audio.segmentId, audio.transcript, audio.speakerLabel, signal);
  assert.equal(generatedText(reply), valid);
  assert.equal(fixture.qwenBodies.length, 1);
  assert.match(JSON.stringify(fixture.qwenBodies[0]?.messages), /事实窗口/u);
  await fixture.turn.completeConversationTurn(audio.segmentId, valid);
  await fixture.composition.close();

  const fallbackDurable = durableTestPort();
  const fallbackFixture = makeHarness('unused', ['not a negotiation answer'], fallbackDurable.port);
  const fallbackToggle = continuousInput('a', 0, '开启谈判模式');
  const fallbackEvidence = await fallbackFixture.turn.finalTranscriptAuthority.finalizeWithEvidence(fallbackToggle);
  await fallbackFixture.turn.afterFinalTranscript(postCommit(fallbackToggle, fallbackEvidence));
  const toggleText = generatedText(await fallbackFixture.turn.generateSegmentReply(
    fallbackToggle.segmentId, fallbackToggle.transcript, fallbackToggle.speakerLabel, signal,
  ));
  await fallbackFixture.turn.completeConversationTurn(fallbackToggle.segmentId, toggleText);
  const fallbackInput = continuousInput('b', 2_000, '分析一下');
  const fallbackInputEvidence = await fallbackFixture.turn.finalTranscriptAuthority.finalizeWithEvidence(fallbackInput);
  await fallbackFixture.turn.afterFinalTranscript(postCommit(fallbackInput, fallbackInputEvidence));
  const fallback = generatedText(await fallbackFixture.turn.generateSegmentReply(
    fallbackInput.segmentId, fallbackInput.transcript, fallbackInput.speakerLabel, signal,
  ));
  assert.equal(fallback, NEGOTIATION_FALLBACK);
  assert.equal(fallbackFixture.qwenBodies.length, 1);
  await fallbackFixture.composition.close();
});

test('one production turn carries completed typed and visual summaries into a later audio reply without image history', async () => {
  const fixture = makeHarness('audio C reply。', ['typed A。', 'visual B。', 'audio C reply。']);
  const signal = new AbortController().signal;
  for await (const _event of fixture.turn.streamTypedReply(
    { promptId: '12121212-1212-4121-8121-121212121212', text: 'typed A' }, signal,
  )) { /* consume */ }
  const visual = await fixture.turn.generateVisualHeartbeatReply(visualHeartbeatInput(30), signal);
  assert.equal(generatedText(visual), 'visual B。');
  const audioInput = continuousInput('a', 8_000, 'audio C。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(audioInput);
  await fixture.turn.afterFinalTranscript(postCommit(audioInput, evidence));
  await fixture.turn.generateSegmentReply(audioInput.segmentId, audioInput.transcript, audioInput.speakerLabel, signal);
  assert.equal(fixture.qwenBodies.length, 3);
  const audioMessages = JSON.stringify(fixture.qwenBodies[2]?.messages);
  assert.match(audioMessages, /typed A/u);
  assert.match(audioMessages, /visual B/u);
  assert.match(audioMessages, /audio C/u);
  assert.doesNotMatch(audioMessages, /data:image\//u);
  await fixture.composition.close();
});

test('device transcript retains evidence and recall without automatically confirming a memory', async () => {
  const fixture = makeHarness('记住：用户喜欢简体中文。');
  const finalInput = input('记住：用户喜欢简体中文。');
  const abort = new AbortController();
  const visualBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
  await fixture.turn.afterFinalTranscript(postCommit(finalInput, evidence));
  const visualPending = fixture.turn.visualModelProvider(visualBytes, abort.signal, VISUAL_FRAME);
  const replyPending = fixture.turn.generateReply(finalInput.transcript, finalInput.speakerLabel, abort.signal);
  const [visual, reply] = await Promise.all([visualPending, replyPending]);

  assert.deepEqual(
    fixture.events.filter((event) => event !== 'owner-binding'),
    ['audio-source', 'final-evidence', 'recall', 'visual-source', 'qwen'],
  );
  assert.equal(fixture.sourceInputs.length, 2);
  const audioSource = fixture.sourceInputs.find((source) => source.media.format === 'pcm_s16le');
  const visualSource = fixture.sourceInputs.find((source) => source.media.format === 'image/jpeg') as
    RayneoVisualSourceMediaInput | undefined;
  assert.ok(audioSource);
  assert.ok(visualSource);
  assert.equal(audioSource.media.format, 'pcm_s16le');
  assert.equal(audioSource.deviceId, DEVICE);
  assert.equal(fixture.evidenceInputs[0]?.deviceId, CANONICAL_DEVICE_ID);
  assert.equal(audioSource.media.sampleRate, 16_000);
  assert.equal(visualSource.media.format, 'image/jpeg');
  assert.equal(visualSource.captureId, BINDING.frameId);
  assert.equal(visualSource.capturedAt, OBSERVED_AT);
  assert.equal(visualSource.media.width, 64);
  assert.equal(visualSource.media.height, 64);
  assert.equal(fixture.evidenceInputs.length, 1);
  assert.equal(fixture.evidenceInputs[0]?.sourceMediaRef.refType, 'SourceArtifact');
  assert.equal(fixture.rememberInputs.length, 0);
  assert.equal(fixture.recallInputs.length, 1);
  assert.equal(fixture.qwenBodies.length, 1);
  const messages = fixture.qwenBodies[0]?.messages as Array<Record<string, unknown>>;
  const userContent = messages?.[1]?.content as Array<Record<string, unknown>>;
  const flattened = JSON.stringify(userContent);
  assert.deepEqual(fixture.qwenBodies[0]?.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(Object.keys(fixture.qwenBodies[0] ?? {}).sort(), [
    'chat_template_kwargs', 'max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'temperature',
  ]);
  assert.match(flattened, /记住：用户喜欢简体中文/u);
  assert.match(flattened, /speaker_0/u);
  assert.match(flattened, /用户偏好：使用简体中文/u);
  assert.match(flattened, /ArtifactVersion:01952f00-0000-7000-8000-000000000202/u);
  assert.equal(generatedText(reply), visual.text);
  assert.equal(fixture.speechTexts.at(-1), visual.text);
  assert.equal(evidence.evidenceRef.refType, 'FinalTranscriptEvidence');
  await fixture.composition.close();
});

test('visual-only frame returns without waiting for a transcript and later audio still fuses once', async () => {
  const fixture = makeHarness('现在请说明画面。');
  const abort = new AbortController();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const visual = await fixture.turn.visualModelProvider(jpeg, abort.signal, VISUAL_FRAME);
  assert.equal(visual.text, '这是同一请求的回复。');
  assert.equal(fixture.evidenceInputs.length, 0);
  assert.equal(fixture.rememberInputs.length, 0);
  assert.equal(fixture.recallInputs.length, 1);
  assert.equal(fixture.qwenBodies.length, 1);
  const visualMessages = fixture.qwenBodies[0]!.messages as Array<{ content: unknown }>;
  const visualContent = JSON.stringify(visualMessages[1]!.content);
  assert.match(visualContent, /当前窗口没有可靠语音/u);
  assert.doesNotMatch(visualContent, /当前最终发言/u);
  assert.deepEqual(fixture.qwenBodies[0]!.chat_template_kwargs, { enable_thinking: false });

  const finalInput = input('现在请说明画面。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
  await fixture.turn.afterFinalTranscript(postCommit(finalInput, evidence));
  const fused = await fixture.turn.generateReply(finalInput.transcript, finalInput.speakerLabel, abort.signal);
  assert.equal(generatedText(fused), visual.text);
  assert.equal(fixture.qwenBodies.length, 2);
  assert.equal(fixture.recallInputs.length, 2);
  const fusedMessages = fixture.qwenBodies[1]!.messages as Array<{ content: unknown }>;
  assert.match(JSON.stringify(fusedMessages[1]!.content), /当前最终发言/u);
  await fixture.composition.close();
});

test('ordinary final speech never writes Memory and repeated consumers reuse the one request', async () => {
  const fixture = makeHarness('今天天气不错。');
  const finalInput = input('今天天气不错。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
  await fixture.turn.afterFinalTranscript(postCommit(finalInput, evidence));
  const abort = new AbortController();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const firstVisual = fixture.turn.visualModelProvider(jpeg, abort.signal, VISUAL_FRAME);
  const secondVisual = fixture.turn.visualModelProvider(jpeg, abort.signal, VISUAL_FRAME);
  const firstReply = fixture.turn.generateReply(finalInput.transcript, finalInput.speakerLabel, abort.signal);
  const secondReply = fixture.turn.generateReply(finalInput.transcript, finalInput.speakerLabel, abort.signal);
  const [visualA, visualB, replyA, replyB] = await Promise.all([firstVisual, secondVisual, firstReply, secondReply]);

  assert.equal(fixture.rememberInputs.length, 0);
  assert.equal(fixture.recallInputs.length, 1);
  assert.equal(fixture.qwenBodies.length, 1);
  assert.equal(visualA.text, visualB.text);
  assert.equal(replyA, replyB);
  await fixture.composition.close();
});

test('segment-scoped audio replies do not reuse the prior segment completion', async () => {
  const fixture = makeHarness('普通语音。', ['第一段回复。', '第二段回复。']);
  const abort = new AbortController();
  const first = continuousInput('a', 0);
  const second = continuousInput('b', 1_000, '第二段不同。');
  const firstEvidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(first);
  await fixture.turn.afterFinalTranscript(postCommit(first, firstEvidence));
  const firstReply = await fixture.turn.generateSegmentReply(
    first.segmentId, first.transcript, first.speakerLabel, abort.signal,
  );
  const firstReplay = await fixture.turn.generateSegmentReply(
    first.segmentId, first.transcript, first.speakerLabel, abort.signal,
  );
  const secondEvidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(second);
  await fixture.turn.afterFinalTranscript(postCommit(second, secondEvidence));
  const secondReply = await fixture.turn.generateSegmentReply(
    second.segmentId, second.transcript, second.speakerLabel, abort.signal,
  );
  assert.equal(generatedText(firstReply), '第一段回复。');
  assert.equal(generatedText(firstReplay), '第一段回复。');
  assert.equal(generatedText(secondReply), '第二段回复。');
  assert.equal(fixture.qwenBodies.length, 2);
  await assert.rejects(
    fixture.turn.generateSegmentReply(first.segmentId, second.transcript, first.speakerLabel, abort.signal),
    /RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH/u,
  );
  await fixture.composition.close();
});

test('segment-scoped audio completion remains bounded beyond the in-memory segment window', async () => {
  const fixture = makeHarness('普通语音。');
  const abort = new AbortController();
  for (let index = 0; index < 40; index += 1) {
    const finalInput = Object.freeze({
      ...input(`第${index}段语音。`),
      segmentId: `rayneo_segment_${index.toString(16).padStart(20, '0')}`,
      startMs: index * 1_000,
      endMs: index * 1_000 + 1_000,
      observedAt: new Date(BINDING.openedAt + index * 1_000 + 1_000).toISOString(),
    });
    const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
    await fixture.turn.afterFinalTranscript(postCommit(finalInput, evidence));
    const reply = await fixture.turn.generateSegmentReply(
      finalInput.segmentId, finalInput.transcript, finalInput.speakerLabel, abort.signal,
    );
    assert.equal(generatedText(reply), '这是同一请求的回复。');
  }
  assert.equal(fixture.qwenBodies.length, 40);
  await fixture.composition.close();
});

test('one production session accepts consecutive segment-scoped PNG fusion turns with replay and drift fencing', async () => {
  const fixture = makeHarness('请说明当前画面。');
  const abort = new AbortController();
  const first = continuousInput('a', 0);
  const second = continuousInput('b', 1_000);
  const firstEvidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(first);
  await fixture.turn.afterFinalTranscript(postCommit(first, firstEvidence));
  const firstReplyInput = realtimeReplyInput(first, 1);
  const firstReply = await fixture.turn.generateRealtimeReply(firstReplyInput, abort.signal);
  const replay = await fixture.turn.generateRealtimeReply(firstReplyInput, abort.signal);
  assert.equal(generatedText(firstReply), '这是同一请求的回复。');
  assert.equal(replay, firstReply);

  const secondEvidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(second);
  await fixture.turn.afterFinalTranscript(postCommit(second, secondEvidence));
  const secondReply = await fixture.turn.generateRealtimeReply(realtimeReplyInput(second, 3), abort.signal);
  assert.equal(generatedText(secondReply), generatedText(firstReply));

  assert.equal(fixture.evidenceInputs.length, 2);
  assert.equal(fixture.recallInputs.length, 2);
  assert.equal(fixture.rememberInputs.length, 0);
  assert.equal(fixture.qwenBodies.length, 2);
  assert.equal(fixture.sourceInputs.filter((item) => item.media.format === 'pcm_s16le').length, 2);
  const visuals = fixture.sourceInputs.filter((item) => item.media.format === 'image/png') as
    RayneoVisualSourceMediaInput[];
  assert.equal(visuals.length, 4);
  assert.deepEqual(visuals.map((item) => item.media.format), ['image/png', 'image/png', 'image/png', 'image/png']);
  assert.equal(new Set(visuals.map((item) => item.captureId)).size, 4);
  for (const body of fixture.qwenBodies) {
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    const messages = body.messages as Array<{ content: unknown }>;
    const content = messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.equal(content.filter((item) => item.type === 'image_url').length, 2);
    assert.equal(content.filter((item) => item.type === 'image_url')
      .every((item) => item.image_url?.url.startsWith('data:image/png;base64,') === true), true);
  }

  const drift = realtimeReplyInput(first, 9);
  await assert.rejects(
    fixture.turn.generateRealtimeReply(drift, abort.signal),
    /RAYNEO_PRODUCTION_REALTIME_REPLY_CONFLICT/u,
  );
  await assert.rejects(
    fixture.turn.generateRealtimeReply(Object.freeze({
      ...realtimeReplyInput(second, 3),
      startMs: 0,
      endMs: 1_000,
    }), abort.signal),
    /RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH/u,
  );
  assert.equal(fixture.qwenBodies.length, 2);
  await fixture.composition.releaseTurn(fixture.turn);
  await fixture.composition.close();
});

test('continuous production session processes more than the bounded in-memory segment window without stopping', async () => {
  const fixture = makeHarness('请说明当前画面。');
  const abort = new AbortController();
  for (let index = 0; index < 40; index += 1) {
    const segmentId = `rayneo_segment_${index.toString(16).padStart(20, '0')}`;
    const startMs = index * 1_000;
    const finalInput = Object.freeze({
      ...input('请说明当前画面。', Uint8Array.of(index & 0xff, 1, 2, 3)),
      segmentId,
      startMs,
      endMs: startMs + 1_000,
      observedAt: new Date(BINDING.openedAt + startMs + 1_000).toISOString(),
    });
    const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
    await fixture.turn.afterFinalTranscript(postCommit(finalInput, evidence));
    const reply = await fixture.turn.generateRealtimeReply(realtimeReplyInput(finalInput, (index % 200) + 1), abort.signal);
    assert.equal(generatedText(reply), '这是同一请求的回复。');
  }
  assert.equal(fixture.evidenceInputs.length, 40);
  assert.equal(fixture.recallInputs.length, 40);
  assert.equal(fixture.qwenBodies.length, 40);
  assert.equal(fixture.sourceInputs.filter((item) => item.media.format === 'image/png').length, 80);
  await fixture.composition.releaseTurn(fixture.turn);
  await fixture.composition.close();
});

test('production visual heartbeat uses T13 PNG readback and memory without fabricating a transcript', async () => {
  const fixture = makeHarness('请说明当前画面。');
  const abort = new AbortController();
  const input = visualHeartbeatInput(30);
  const reply = await fixture.turn.generateVisualHeartbeatReply(input, abort.signal);
  const replay = await fixture.turn.generateVisualHeartbeatReply(input, abort.signal);
  assert.equal(generatedText(reply), '这是同一请求的回复。');
  assert.equal(replay, reply);
  assert.equal(fixture.evidenceInputs.length, 0);
  assert.equal(fixture.rememberInputs.length, 0);
  assert.equal(fixture.recallInputs.length, 1);
  assert.equal(fixture.qwenBodies.length, 1);
  const visuals = fixture.sourceInputs as RayneoVisualSourceMediaInput[];
  assert.equal(visuals.length, 2);
  assert.equal(visuals.every((item) => item.media.format === 'image/png'), true);
  const messages = fixture.qwenBodies[0]!.messages as Array<{ content: unknown }>;
  const content = messages[1]!.content as Array<{ type: string; text?: string }>;
  assert.equal(content.some((item) => item.type === 'text' && item.text?.includes('没有可靠语音') === true), true);
  assert.equal(content.filter((item) => item.type === 'image_url').length, 2);
  await assert.rejects(
    fixture.turn.generateVisualHeartbeatReply(visualHeartbeatInput(40), abort.signal),
    /RAYNEO_PRODUCTION_VISUAL_HEARTBEAT_CONFLICT/u,
  );
  assert.equal(fixture.qwenBodies.length, 1);
  await fixture.composition.releaseTurn(fixture.turn);
  await fixture.composition.close();
});

test('turn-local replay coordinates final, post-commit, visual, and reply exactly once and rejects conflicts', async () => {
  const fixture = makeHarness('记住：用户喜欢简体中文。');
  const finalInput = input('记住：用户喜欢简体中文。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
  const post = postCommit(finalInput, evidence);
  await fixture.turn.afterFinalTranscript(post);
  const abort = new AbortController();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await Promise.all([
    fixture.turn.visualModelProvider(jpeg, abort.signal, VISUAL_FRAME),
    fixture.turn.generateReply(finalInput.transcript, finalInput.speakerLabel, abort.signal),
  ]);
  const before = {
    source: fixture.sourceInputs.length,
    evidence: fixture.evidenceInputs.length,
    remember: fixture.rememberInputs.length,
    recall: fixture.recallInputs.length,
    qwen: fixture.qwenBodies.length,
  };

  await Promise.all([
    fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput),
    fixture.turn.afterFinalTranscript(post),
    fixture.turn.visualModelProvider(jpeg, abort.signal, VISUAL_FRAME),
    fixture.turn.generateReply(finalInput.transcript, finalInput.speakerLabel, abort.signal),
  ]);
  assert.deepEqual({
    source: fixture.sourceInputs.length,
    evidence: fixture.evidenceInputs.length,
    remember: fixture.rememberInputs.length,
    recall: fixture.recallInputs.length,
    qwen: fixture.qwenBodies.length,
  }, before);

  await assert.rejects(
    fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(input('记住：不同内容。')),
    /RAYNEO_PRODUCTION_FINAL_IDEMPOTENCY_CONFLICT/u,
  );
  await assert.rejects(
    fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(input(finalInput.transcript, Uint8Array.of(11, 0, 246, 255))),
    /RAYNEO_PRODUCTION_FINAL_IDEMPOTENCY_CONFLICT/u,
  );
  await assert.rejects(
    fixture.turn.generateReply('漂移后的最终转写。', finalInput.speakerLabel, abort.signal),
    /RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH/u,
  );
  await fixture.composition.close();
});

test('owner binding drift fails closed before Memory or Qwen', async () => {
  const fixture = makeHarness('记住：用户喜欢简体中文。');
  const finalInput = input('记住：用户喜欢简体中文。');
  const evidence = await fixture.turn.finalTranscriptAuthority.finalizeWithEvidence(finalInput);
  fixture.setOwnerBinding(Object.freeze({
    canonicalDeviceId: '01952f00-0000-7000-8000-000000000103',
    userId: 'user-drifted',
    realtimeSessionRef: Object.freeze({ kind: 'RealtimeSession', id: 'session-drifted' }),
    continuityId: 'continuity-drifted',
    purpose: 'different-purpose',
  }));
  await assert.rejects(
    fixture.turn.afterFinalTranscript(postCommit(finalInput, evidence)),
    /RAYNEO_PRODUCTION_BINDING_DRIFT/u,
  );
  assert.equal(fixture.rememberInputs.length, 0);
  assert.equal(fixture.recallInputs.length, 0);
  assert.equal(fixture.qwenBodies.length, 0);
  await fixture.composition.close();
});

test('missing production source visual seam fails closed at composition creation', () => {
  const invalid = {
    ownerBinding: { resolve: async () => undefined },
    sourceMedia: { issue: async () => SOURCE_REF },
    finalTranscript: { finalize: async () => ({}) as FinalTranscriptEvidenceResult },
    finalTranscriptEvidenceReader: { read: async () => undefined },
    memory: { rememberExplicit: async () => ({}) as ExplicitUserRememberResult, recallForAnswerContext: async () => ({}) as MemoryConsumerContext },
    sensitivity: { classification: 'normal', userConfirmed: true },
    qwenProfile: QWEN38_ORCAROUTER_PROFILE,
    recall: { maxItems: 1, maxContentBytes: 1 },
  } as unknown as RayneoProductionCompositionOptions;
  assert.throws(() => createRayneoProductionComposition(invalid), /RAYNEO_PRODUCTION_COMPOSITION_INVALID/u);
});

test('production composition has no process-environment identity fallback', () => {
  const source = readFileSync(new URL('../src/rayneo-production-composition.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env/u);
});
