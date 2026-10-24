import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptOwnerResolvedPerceptionContext,
  WINDOWS_AI_PERCEPTION_MAX_MEDIA_BYTES,
  WindowsAiPerceptionContextAdapterError,
  type WindowsAiOwnerResolvedPerceptionContext,
} from '../src/windows-ai-perception-context-adapter.ts';
import {
  WindowsAiContextCompilerError,
  compileWindowsAiContext,
  type OwnerCanonicalObjectVersionRef,
  type WindowsAiContextCompilerInput,
} from '../src/windows-ai-context-compiler.ts';
import {
  createWindowsAiInferenceOrchestrator,
  type WindowsAiInferenceProviderPort,
} from '../src/windows-ai-inference-orchestrator.ts';
import {
  QWEN38_PROVIDER_CONTEXT_TOKENS,
  type Qwen38ChatRequest,
  type Qwen38ProviderAvailability,
  type Qwen38StreamEvent,
} from '../src/qwen38-provider-adapter.ts';

function ref(refType: string, suffix: number, version = '1'): OwnerCanonicalObjectVersionRef {
  return Object.freeze({
    ref_type: refType,
    ref_id: `018f0d7a-1b2c-7d4e-8a6b-${suffix.toString(16).padStart(12, '0')}`,
    object_version: version,
    canonical_payload_sha256: (suffix % 16).toString(16).repeat(64),
  });
}

const ROUTE = ref('ProviderRoute', 1);
const MODEL = ref('ModelDefinition', 2);
const FINAL = ref('FinalTranscriptEvidence', 3);
const PARTIAL = ref('TranscriptSegment', 4);
const SPEAKER_A = ref('TranscriptSegment', 5);
const SPEAKER_B = ref('TranscriptSegment', 6);
const ARTIFACT_JPEG = ref('ArtifactVersion', 7);
const ARTIFACT_PNG = ref('ArtifactVersion', 8);
const ARTIFACT_WEBP = ref('ArtifactVersion', 9);
const ARTIFACT_OCR = ref('ArtifactVersion', 10);
const HEALTH = ref('Observation', 11);
const LOCATION = ref('Observation', 12);
const HISTORY = ref('RealtimeSession', 13);
const MEMORY = ref('EpisodicMemory', 14);

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value).digest('hex');
}

function imageHash(value: Uint8Array): string {
  return sha256(value);
}

function baseContext(overrides: Partial<WindowsAiOwnerResolvedPerceptionContext> = {}): WindowsAiOwnerResolvedPerceptionContext {
  return {
    providerRouteRef: ROUTE,
    modelDefinitionRef: MODEL,
    instruction: '请根据全部已解析证据给出简洁建议。',
    budget: { reservedOutputTokens: 32_768, inputTokenLimit: 90_000 },
    ...overrides,
  };
}

function fullContext(): WindowsAiOwnerResolvedPerceptionContext {
  return baseContext({
    transcripts: [
      { ref: FINAL, status: 'final', text: '最终确认的用户发言。', startMs: 10, endMs: 30 },
    ],
    speakerTimeline: [
      { ref: SPEAKER_B, startMs: 20, endMs: 29, speakerLabel: 'counterparty-A', diarizationStatus: 'degraded' },
      { ref: SPEAKER_A, startMs: 10, endMs: 19, speakerLabel: 'speaker_0', diarizationStatus: 'window_local' },
    ],
    artifacts: [
      {
        ref: ARTIFACT_WEBP,
        mediaKind: 'image',
        observedAtMs: 30,
        mimeType: 'image/webp',
        bytes: WEBP_BYTES,
        contentSha256: imageHash(WEBP_BYTES),
      },
      {
        ref: ARTIFACT_OCR,
        mediaKind: 'ocr_text',
        observedAtMs: 20,
        text: 'OCR exact text。',
        contentSha256: sha256('OCR exact text。'),
      },
      {
        ref: ARTIFACT_PNG,
        mediaKind: 'video_frame',
        observedAtMs: 10,
        mimeType: 'image/png',
        bytes: PNG_BYTES,
        contentSha256: imageHash(PNG_BYTES),
      },
      {
        ref: ARTIFACT_JPEG,
        mediaKind: 'image',
        observedAtMs: 5,
        mimeType: 'image/jpeg',
        bytes: JPEG_BYTES,
        contentSha256: imageHash(JPEG_BYTES),
      },
    ],
    observations: [
      { ref: LOCATION, kind: 'location_summary', observedAtMs: 12, resolvedContent: '位置摘要。' },
      { ref: HEALTH, kind: 'health_summary', observedAtMs: 11, resolvedContent: '健康摘要。' },
    ],
    sessionHistory: [{ ref: HISTORY, occurredAtMs: 2, resolvedContent: '历史上下文。' }],
    memories: [{ ref: MEMORY, boundedContent: '有界记忆内容。', selectionReason: '与当前意图相关。' }],
  });
}

function assertAdapterCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WindowsAiPerceptionContextAdapterError && error.code === code;
}

function assertCompilerCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WindowsAiContextCompilerError && error.code === code;
}

function compileWithConstantEstimator(input: WindowsAiContextCompilerInput): ReturnType<typeof compileWindowsAiContext> {
  return compileWindowsAiContext(input, () => 10);
}

class FakeProvider implements WindowsAiInferenceProviderPort {
  readinessCalls = 0;
  streamCalls = 0;
  readonly requests: Qwen38ChatRequest[] = [];

  async checkAvailability(): Promise<Qwen38ProviderAvailability> {
    this.readinessCalls += 1;
    return Object.freeze({ ready: true, loaded: false, activeRequests: 0 });
  }

  async *stream(input: Qwen38ChatRequest, _signal?: AbortSignal): AsyncGenerator<Qwen38StreamEvent> {
    this.streamCalls += 1;
    this.requests.push(input);
    yield Object.freeze({ kind: 'delta', text: '中间建议。' });
    yield Object.freeze({ kind: 'final', text: '最终建议。', finishReason: 'stop' });
  }
}

test('all Owner-resolved modalities adapt into one compiler input and bind every ref/hash', () => {
  const adapted = adaptOwnerResolvedPerceptionContext(fullContext());
  assert.equal(adapted.transcripts?.length, 1);
  assert.equal(adapted.transcripts?.[0]?.status, 'final');
  assert.deepEqual(adapted.speakerTimeline?.map((value) => value.diarizationStatus), ['matched', 'degraded']);
  assert.deepEqual(adapted.artifacts?.map((value) => value.mediaKind), ['image', 'video_frame', 'ocr_text', 'image']);

  const compiled = compileWithConstantEstimator(adapted);
  const refs = new Set(compiled.replayManifest.map((entry) => entry.ref.ref_id));
  for (const expected of [ROUTE, MODEL, FINAL, SPEAKER_A, SPEAKER_B, ARTIFACT_JPEG, ARTIFACT_PNG,
    ARTIFACT_WEBP, ARTIFACT_OCR, HEALTH, LOCATION, HISTORY, MEMORY]) {
    assert.equal(refs.has(expected.ref_id), true, `missing ref ${expected.ref_id}`);
  }
  for (const artifact of adapted.artifacts ?? []) {
    assert.equal(
      compiled.replayManifest.find((entry) => entry.ref.ref_id === artifact.ref.ref_id)?.contentSha256,
      artifact.contentSha256,
    );
  }
});

test('adapted multimodal context traverses the existing orchestrator with one stream and one final', async () => {
  const provider = new FakeProvider();
  const events: string[] = [];
  const outcome = await createWindowsAiInferenceOrchestrator({
    provider,
    estimator: () => 10,
  }).run({ context: adaptOwnerResolvedPerceptionContext(fullContext()) }, async (event) => {
    events.push(event.kind);
  });

  assert.equal(outcome.terminal, 'final');
  assert.equal(provider.readinessCalls, 1);
  assert.equal(provider.streamCalls, 1);
  assert.deepEqual(events, ['delta', 'final']);
  const requestText = JSON.stringify(provider.requests[0]?.messages);
  assert.match(requestText, /最终确认的用户发言/u);
  assert.match(requestText, /speaker_0/u);
  assert.match(requestText, /counterparty-A/u);
  assert.match(requestText, /data:image\/jpeg;base64,/u);
  assert.match(requestText, /data:image\/png;base64,/u);
  assert.match(requestText, /data:image\/webp;base64,/u);
  assert.match(requestText, /OCR exact text/u);
  assert.match(requestText, /健康摘要/u);
  assert.match(requestText, /位置摘要/u);
  assert.match(requestText, /历史上下文/u);
  assert.match(requestText, /有界记忆内容/u);
  assert.doesNotMatch(requestText, /未最终确认|partial|interim/u);
  for (const artifact of [ARTIFACT_JPEG, ARTIFACT_PNG, ARTIFACT_WEBP]) {
    assert.equal(
      outcome.manifest.replayManifest.find((entry) => entry.ref.ref_id === artifact.ref_id)?.contentSha256,
      artifact === ARTIFACT_JPEG ? imageHash(JPEG_BYTES) : artifact === ARTIFACT_PNG ? imageHash(PNG_BYTES) : imageHash(WEBP_BYTES),
    );
  }
});

test('final-only transcript mapping and stable ordering preserve exact Owner speaker labels and mapped states', () => {
  const adapted = adaptOwnerResolvedPerceptionContext(fullContext());
  assert.deepEqual(adapted.transcripts?.map((value) => value.ref.ref_id), [FINAL.ref_id]);
  assert.deepEqual(adapted.speakerTimeline?.map((value) => value.speakerLabel), ['speaker_0', 'counterparty-A']);
  assert.deepEqual(adapted.speakerTimeline?.map((value) => value.diarizationStatus), ['matched', 'degraded']);
  assert.equal(adapted.speakerTimeline?.[1]?.speakerLabel, 'counterparty-A');
  assert.deepEqual(adapted.artifacts?.map((value) => value.observedAtMs), [5, 10, 20, 30]);
  assert.deepEqual(adapted.observations?.map((value) => value.kind), ['health_summary', 'location_summary']);
  assert.deepEqual(adapted.sessionHistory?.map((value) => value.occurredAtMs), [2]);
  assert.deepEqual(adapted.memories?.map((value) => value.ref.ref_id), [MEMORY.ref_id]);
});

test('runtime partial and interim transcripts are rejected, never silently discarded or sent onward', () => {
  for (const status of ['partial', 'interim'] as const) {
    let adapted: WindowsAiContextCompilerInput | undefined;
    let estimatorCalls = 0;
    const provider = new FakeProvider();
    assert.throws(() => {
      adapted = adaptOwnerResolvedPerceptionContext(baseContext({
        transcripts: [{
          ref: PARTIAL,
          status: status as never,
          text: '未最终确认。',
          startMs: 1,
          endMs: 2,
        }],
      }));
      // This branch must remain unreachable when the adapter rejects the input.
      compileWithConstantEstimator(adapted!);
      void createWindowsAiInferenceOrchestrator({
        provider,
        estimator: () => { estimatorCalls += 1; return 10; },
      }).run({ context: adapted! }, async () => undefined);
    }, assertAdapterCode('WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID'));
    assert.equal(adapted, undefined);
    assert.equal(estimatorCalls, 0);
    assert.equal(provider.readinessCalls, 0);
    assert.equal(provider.streamCalls, 0);
  }
});

test('duplicates remain for the compiler to deduplicate or fail closed on conflict', () => {
  const duplicate = {
    ref: ARTIFACT_JPEG,
    mediaKind: 'image' as const,
    observedAtMs: 5,
    mimeType: 'image/jpeg' as const,
    bytes: JPEG_BYTES,
    contentSha256: imageHash(JPEG_BYTES),
  };
  const adapted = adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [duplicate, duplicate] }));
  assert.equal(adapted.artifacts?.length, 2);
  assert.doesNotThrow(() => compileWithConstantEstimator(adapted));

  const conflict = { ...duplicate, bytes: PNG_BYTES, mimeType: 'image/png' as const, contentSha256: imageHash(PNG_BYTES) };
  const conflicting = adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [duplicate, conflict] }));
  assert.throws(() => compileWithConstantEstimator(conflicting), assertCompilerCode('WINDOWS_AI_CONTEXT_REF_CONFLICT'));
});

test('media validation enforces nonempty Uint8Array, size bound, canonical copying and exact formats', () => {
  const original = Uint8Array.from(JPEG_BYTES);
  const adapted = adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [{
    ref: ARTIFACT_JPEG,
    mediaKind: 'image',
    observedAtMs: 1,
    mimeType: 'image/jpeg',
    bytes: original,
    contentSha256: imageHash(original),
  }] }));
  original[0] = 0;
  const copiedContent = adapted.artifacts?.[0]?.content;
  assert.equal(copiedContent?.kind, 'image_url');
  if (copiedContent?.kind === 'image_url') {
    assert.equal(copiedContent.url, `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString('base64')}`);
  }

  const invalids: unknown[] = [
    { ref: ARTIFACT_JPEG, mediaKind: 'image', observedAtMs: 1, mimeType: 'image/jpeg', bytes: new Uint8Array(), contentSha256: imageHash(JPEG_BYTES) },
    { ref: ARTIFACT_JPEG, mediaKind: 'image', observedAtMs: 1, mimeType: 'image/gif', bytes: JPEG_BYTES, contentSha256: imageHash(JPEG_BYTES) },
    { ref: ARTIFACT_JPEG, mediaKind: 'image', observedAtMs: 1, mimeType: 'jpeg', bytes: [1, 2, 3], contentSha256: imageHash(JPEG_BYTES) },
    { ref: ARTIFACT_JPEG, mediaKind: 'image', observedAtMs: 1, mimeType: 'image/jpeg', bytes: new Uint8Array(WINDOWS_AI_PERCEPTION_MAX_MEDIA_BYTES + 1), contentSha256: imageHash(JPEG_BYTES) },
  ];
  for (const artifact of invalids) {
    assert.throws(() => adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [artifact as never] })),
      /WINDOWS_AI_PERCEPTION_ARTIFACT/u);
  }
});

test('invalid Owner refs, hashes and phase-style identifiers fail before estimator or Provider', async () => {
  assert.throws(() => adaptOwnerResolvedPerceptionContext(baseContext({
    providerRouteRef: { ...ROUTE, ref_id: 'phase0_session_00000000000000000000' },
  })), assertAdapterCode('WINDOWS_AI_PERCEPTION_OWNER_REF_INVALID'));
  assert.throws(() => adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [{
    ref: ARTIFACT_JPEG,
    mediaKind: 'image',
    observedAtMs: 1,
    mimeType: 'image/jpeg',
    bytes: JPEG_BYTES,
    contentSha256: 'A'.repeat(64),
  }] })), assertAdapterCode('WINDOWS_AI_PERCEPTION_OWNER_HASH_INVALID'));

  let estimatorCalls = 0;
  const provider = new FakeProvider();
  const wrongHash = adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [{
    ref: ARTIFACT_JPEG,
    mediaKind: 'image',
    observedAtMs: 1,
    mimeType: 'image/jpeg',
    bytes: JPEG_BYTES,
    contentSha256: '0'.repeat(64),
  }] }));
  const outcome = await createWindowsAiInferenceOrchestrator({
    provider,
    estimator: () => { estimatorCalls += 1; return 10; },
  }).run({ context: wrongHash }, async () => undefined);
  assert.equal(outcome.terminal, 'error');
  assert.equal(estimatorCalls, 0);
  assert.equal(provider.streamCalls, 0);
});

test('missing modalities remain compiler degraded rather than fabricated by the adapter', () => {
  const adapted = adaptOwnerResolvedPerceptionContext(baseContext());
  assert.equal(adapted.transcripts, undefined);
  assert.equal(adapted.artifacts, undefined);
  const compiled = compileWithConstantEstimator(adapted);
  assert.deepEqual(compiled.degradedReasons, [
    'ARTIFACT_MISSING',
    'FINAL_TRANSCRIPT_MISSING',
    'HEALTH_SUMMARY_MISSING',
    'LOCATION_SUMMARY_MISSING',
    'MEMORY_CONTEXT_MISSING',
    'SESSION_HISTORY_MISSING',
    'SPEAKER_TIMELINE_MISSING',
  ]);
});

test('Abort before, around encoding boundaries and before return produces no adapted result', () => {
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => adaptOwnerResolvedPerceptionContext(fullContext(), abort.signal),
    assertAdapterCode('WINDOWS_AI_PERCEPTION_CONTEXT_ABORTED'));

  const midAbort = new AbortController();
  const abortingBytes = Uint8Array.from(JPEG_BYTES);
  Object.defineProperty(abortingBytes, 'byteLength', {
    configurable: true,
    get: () => { midAbort.abort(); return JPEG_BYTES.byteLength; },
  });
  assert.throws(() => adaptOwnerResolvedPerceptionContext(baseContext({ artifacts: [{
    ref: ARTIFACT_JPEG,
    mediaKind: 'image',
    observedAtMs: 1,
    mimeType: 'image/jpeg',
    bytes: abortingBytes,
    contentSha256: imageHash(JPEG_BYTES),
  }] }), midAbort.signal),
    assertAdapterCode('WINDOWS_AI_PERCEPTION_CONTEXT_ABORTED'));
});

test('adapter output is deterministic, frozen and contains no shared wire fields', () => {
  const first = adaptOwnerResolvedPerceptionContext(fullContext());
  const second = adaptOwnerResolvedPerceptionContext({
    ...fullContext(),
    transcripts: [...(fullContext().transcripts ?? [])].reverse(),
    speakerTimeline: [...(fullContext().speakerTimeline ?? [])].reverse(),
    artifacts: [...(fullContext().artifacts ?? [])].reverse(),
  });
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.artifacts), true);
  assert.equal(Object.isFrozen(first.artifacts?.[0]), true);
  const source = readFileSync(new URL('../src/windows-ai-perception-context-adapter.ts', import.meta.url), 'utf8');
  for (const token of ['request_id', 'session_id', 'continuity_id', 'receipt', 'DeliveryReceipt', 'sequence', 'cursor', 'phase0_', 'rawSpeakerId', 'raw_speaker_id']) {
    assert.equal(source.includes(token), false, `forbidden shared token: ${token}`);
  }
  assert.equal(/(?:node:(?:fs|crypto)|process\.env|randomUUID|createHash|setTimeout|fetch\s*\(|WebSocket|https?:\/\/|from\s+['"][^'"]*(?:controller|contract|main)\.ts)/iu.test(source), false);
});

assert.equal(QWEN38_PROVIDER_CONTEXT_TOKENS, 131_072);
