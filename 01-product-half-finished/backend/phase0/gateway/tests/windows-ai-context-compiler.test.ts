import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WindowsAiContextCompilerError,
  compileWindowsAiContext,
  type OwnerCanonicalObjectVersionRef,
  type WindowsAiContextCompilerInput,
  type WindowsAiTokenEstimator,
} from '../src/windows-ai-context-compiler.ts';

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
const SPEAKER_OUTSIDE = ref('TranscriptSegment', 7);
const ARTIFACT = ref('ArtifactVersion', 8);
const IMAGE = ref('ArtifactVersion', 9);
const HEALTH = ref('Observation', 10);
const LOCATION = ref('Observation', 11);
const HISTORY = ref('RealtimeSession', 12);
const MEMORY = ref('EpisodicMemory', 13);
const PNG_ARTIFACT = ref('ArtifactVersion', 14);
const WEBP_ARTIFACT = ref('ArtifactVersion', 15);

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

function imageDataUrl(kind: 'jpeg' | 'png' | 'webp', bytes: Uint8Array): string {
  return `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
}

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const IMAGE_URL = 'data:image/jpeg;base64,AA==';

function baseInput(overrides: Partial<WindowsAiContextCompilerInput> = {}): WindowsAiContextCompilerInput {
  return {
    providerRouteRef: ROUTE,
    modelDefinitionRef: MODEL,
    instruction: '请根据当前证据给出简洁建议。',
    budget: { reservedOutputTokens: 32_768, inputTokenLimit: 90_000 },
    ...overrides,
  };
}

const byteEstimator: WindowsAiTokenEstimator = (messages) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 3);

function assertCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WindowsAiContextCompilerError && error.code === code;
}

function messageText(input: ReturnType<typeof compileWindowsAiContext>): string {
  return JSON.stringify(input.messages);
}

test('same semantic input compiles deterministically with stable deduped replay manifest', () => {
  const final = Object.freeze({ ref: FINAL, status: 'final' as const, text: '用户确认今天下午出发。', startMs: 100, endMs: 900 });
  const speaker = Object.freeze({
    ref: SPEAKER_A, startMs: 100, endMs: 900, speakerLabel: 'speaker_0', diarizationStatus: 'matched' as const,
  });
  const artifact = Object.freeze({
    ref: ARTIFACT, mediaKind: 'ocr_text' as const, observedAtMs: 500,
    contentSha256: sha256Text('车票显示十五点二十分发车。'),
    content: Object.freeze({ kind: 'text' as const, text: '车票显示十五点二十分发车。' }),
  });
  const image = Object.freeze({
    ref: IMAGE, mediaKind: 'image' as const, observedAtMs: 450,
    contentSha256: sha256Bytes(Uint8Array.from([0])),
    content: Object.freeze({ kind: 'image_url' as const, url: IMAGE_URL }),
  });
  const health = Object.freeze({
    ref: HEALTH, kind: 'health_summary' as const, observedAtMs: 400, resolvedContent: '步行状态稳定。',
  });
  const location = Object.freeze({
    ref: LOCATION, kind: 'location_summary' as const, observedAtMs: 410, resolvedContent: '当前位置靠近车站。',
  });
  const history = Object.freeze({ ref: HISTORY, occurredAtMs: 50, resolvedContent: '此前计划乘坐地铁前往。' });
  const memory = Object.freeze({
    ref: MEMORY, boundedContent: '用户通常提前四十分钟到站。', selectionReason: '与当前出行意图直接相关。',
  });
  const first = compileWindowsAiContext(baseInput({
    transcripts: [final, final],
    speakerTimeline: [speaker, speaker],
    artifacts: [artifact, image, artifact],
    observations: [location, health, location],
    sessionHistory: [history, history],
    memories: [memory, memory],
  }), byteEstimator);
  const second = compileWindowsAiContext(baseInput({
    transcripts: [final],
    speakerTimeline: [speaker],
    artifacts: [image, artifact],
    observations: [health, location],
    sessionHistory: [history],
    memories: [memory],
  }), byteEstimator);
  assert.deepEqual(first, second);
  assert.equal(first.replayManifest.length, 10);
  assert.deepEqual(first.replayManifest.map((entry) => entry.ref).slice().sort((left, right) =>
    (left.ref_type < right.ref_type ? -1 : left.ref_type > right.ref_type ? 1 : 0) ||
    (left.ref_id < right.ref_id ? -1 : left.ref_id > right.ref_id ? 1 : 0)),
  first.replayManifest.map((entry) => entry.ref));
  assert.equal(first.replayManifest.every((entry) => entry.uses.length === 1), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.messages), true);
  assert.equal(Object.isFrozen(first.replayManifest), true);
  assert.equal(first.replayManifest.every((entry) =>
    entry.ref.ref_type === 'ArtifactVersion' || !Object.hasOwn(entry, 'contentSha256')), true);
  assert.equal(first.replayManifest.find((entry) => entry.ref.ref_id === IMAGE.ref_id)?.contentSha256,
    sha256Bytes(Uint8Array.from([0])));
});

test('valid JPEG, PNG, WebP and OCR artifacts bind exact rendered bytes', () => {
  const ocrText = 'OCR exact bytes。';
  const artifacts = [
    {
      ref: IMAGE, mediaKind: 'image' as const, observedAtMs: 10,
      contentSha256: sha256Bytes(JPEG_BYTES),
      content: { kind: 'image_url' as const, url: imageDataUrl('jpeg', JPEG_BYTES) },
    },
    {
      ref: PNG_ARTIFACT, mediaKind: 'video_frame' as const, observedAtMs: 20,
      contentSha256: sha256Bytes(PNG_BYTES),
      content: { kind: 'image_url' as const, url: imageDataUrl('png', PNG_BYTES) },
    },
    {
      ref: WEBP_ARTIFACT, mediaKind: 'image' as const, observedAtMs: 30,
      contentSha256: sha256Bytes(WEBP_BYTES),
      content: { kind: 'image_url' as const, url: imageDataUrl('webp', WEBP_BYTES) },
    },
    {
      ref: ARTIFACT, mediaKind: 'ocr_text' as const, observedAtMs: 40,
      contentSha256: sha256Text(ocrText),
      content: { kind: 'text' as const, text: ocrText },
    },
  ];
  const compiled = compileWindowsAiContext(baseInput({ artifacts }), () => 10);
  for (const artifact of artifacts) {
    assert.equal(
      compiled.replayManifest.find((entry) => entry.ref.ref_id === artifact.ref.ref_id)?.contentSha256,
      artifact.contentSha256,
    );
  }
  const rendered = messageText(compiled);
  assert.match(rendered, /data:image\/jpeg;base64,/u);
  assert.match(rendered, /data:image\/png;base64,/u);
  assert.match(rendered, /data:image\/webp;base64,/u);
  assert.match(rendered, /OCR exact bytes/u);
});

test('missing, malformed and uppercase content hashes fail with stable hash-invalid code', () => {
  const valid = {
    ref: IMAGE,
    mediaKind: 'image' as const,
    observedAtMs: 10,
    contentSha256: sha256Bytes(JPEG_BYTES),
    content: { kind: 'image_url' as const, url: imageDataUrl('jpeg', JPEG_BYTES) },
  };
  const { contentSha256: _missing, ...withoutHash } = valid;
  const invalids: unknown[] = [
    withoutHash,
    { ...valid, contentSha256: 'not-a-sha256' },
    { ...valid, contentSha256: valid.contentSha256.toUpperCase() },
  ];
  for (const artifact of invalids) {
    assert.throws(() => compileWindowsAiContext(baseInput({ artifacts: [artifact as never] }), () => 10),
      assertCode('WINDOWS_AI_CONTEXT_ARTIFACT_HASH_INVALID'));
  }
});

test('noncanonical or unsupported image data URLs fail with hash-invalid before estimation', () => {
  const validHash = sha256Bytes(Uint8Array.from([0]));
  const invalidUrls = [
    'data:image/jpeg;base64,AA',
    'data:image/jpeg;base64,AA=',
    'data:image/gif;base64,AA==',
    'not-an-image-data-url',
  ];
  for (const url of invalidUrls) {
    let estimatorCalls = 0;
    assert.throws(() => compileWindowsAiContext(baseInput({ artifacts: [{
      ref: IMAGE,
      mediaKind: 'image',
      observedAtMs: 10,
      contentSha256: validHash,
      content: { kind: 'image_url', url },
    }] }), () => { estimatorCalls += 1; return 10; }),
    assertCode('WINDOWS_AI_CONTEXT_ARTIFACT_HASH_INVALID'));
    assert.equal(estimatorCalls, 0);
  }
});

test('decoded image bytes and exact OCR UTF-8 bytes reject hash mismatches', () => {
  const imageMismatch = {
    ref: IMAGE,
    mediaKind: 'image' as const,
    observedAtMs: 10,
    contentSha256: '0'.repeat(64),
    content: { kind: 'image_url' as const, url: imageDataUrl('jpeg', JPEG_BYTES) },
  };
  assert.throws(() => compileWindowsAiContext(baseInput({ artifacts: [imageMismatch] }), () => 10),
    assertCode('WINDOWS_AI_CONTEXT_ARTIFACT_HASH_MISMATCH'));

  const ocrText = 'OCR exact bytes。';
  const ocrMismatch = {
    ref: ARTIFACT,
    mediaKind: 'ocr_text' as const,
    observedAtMs: 20,
    contentSha256: 'f'.repeat(64),
    content: { kind: 'text' as const, text: ocrText },
  };
  assert.throws(() => compileWindowsAiContext(baseInput({ artifacts: [ocrMismatch] }), () => 10),
    assertCode('WINDOWS_AI_CONTEXT_ARTIFACT_HASH_MISMATCH'));
});

test('same ArtifactVersion with different valid content/hash remains a ref conflict', () => {
  const jpeg = {
    ref: IMAGE, mediaKind: 'image' as const, observedAtMs: 10,
    contentSha256: sha256Bytes(JPEG_BYTES),
    content: { kind: 'image_url' as const, url: imageDataUrl('jpeg', JPEG_BYTES) },
  };
  const pngWithSameRef = {
    ref: IMAGE, mediaKind: 'image' as const, observedAtMs: 10,
    contentSha256: sha256Bytes(PNG_BYTES),
    content: { kind: 'image_url' as const, url: imageDataUrl('png', PNG_BYTES) },
  };
  assert.throws(() => compileWindowsAiContext(baseInput({ artifacts: [jpeg, pngWithSameRef] }), () => 10),
    assertCode('WINDOWS_AI_CONTEXT_REF_CONFLICT'));
});

test('budget-dropped artifacts preserve their exact content hash in replay manifest', () => {
  const artifact = {
    ref: IMAGE, mediaKind: 'image' as const, observedAtMs: 10,
    contentSha256: sha256Bytes(JPEG_BYTES),
    content: { kind: 'image_url' as const, url: imageDataUrl('jpeg', JPEG_BYTES) },
  };
  const compiled = compileWindowsAiContext(baseInput({
    budget: { reservedOutputTokens: 32_768, inputTokenLimit: 20 },
    artifacts: [artifact],
  }), (messages) => JSON.stringify(messages).includes('[ARTIFACT') ? 100 : 10);
  const entry = compiled.replayManifest.find((value) => value.ref.ref_id === IMAGE.ref_id);
  assert.equal(entry?.contentSha256, artifact.contentSha256);
  assert.deepEqual(compiled.budget.decisions.find((value) => value.ref.ref_id === IMAGE.ref_id)?.disposition,
    'dropped_budget');
  assert.doesNotMatch(messageText(compiled), /data:image\/jpeg;base64/u);
});

test('canonical ref shape, UUIDv7, lowercase hash, positive version, type and conflicts fail closed', () => {
  const invalidRefs: unknown[] = [
    { ...ROUTE, extra: true },
    { ...ROUTE, ref_id: '018f0d7a-1b2c-4d4e-8a6b-000000000001' },
    { ...ROUTE, object_version: '01' },
    { ...ROUTE, canonical_payload_sha256: 'A'.repeat(64) },
    { ...ROUTE, ref_type: 'ModelDefinition' },
  ];
  for (const invalid of invalidRefs) {
    assert.throws(() => compileWindowsAiContext(baseInput({
      providerRouteRef: invalid as OwnerCanonicalObjectVersionRef,
    }), byteEstimator), assertCode('WINDOWS_AI_CONTEXT_REF_INVALID'));
  }
  assert.throws(() => compileWindowsAiContext(baseInput({
    sessionHistory: [
      { ref: HISTORY, occurredAtMs: 1, resolvedContent: '第一份内容。' },
      { ref: HISTORY, occurredAtMs: 1, resolvedContent: '同一引用却是不同内容。' },
    ],
  }), byteEstimator), assertCode('WINDOWS_AI_CONTEXT_REF_CONFLICT'));
});

test('final transcript wins and partial or interim content never enters Qwen messages', () => {
  const compiled = compileWindowsAiContext(baseInput({
    transcripts: [
      { ref: PARTIAL, status: 'partial', text: '这是尚未最终确认的内容。', startMs: 10, endMs: 80 },
      { ref: FINAL, status: 'final', text: '这是最终确认的用户发言。', startMs: 10, endMs: 100 },
    ],
  }), byteEstimator);
  assert.match(messageText(compiled), /这是最终确认的用户发言/u);
  assert.doesNotMatch(messageText(compiled), /尚未最终确认/u);
  assert.equal(compiled.degradedReasons.includes('NON_FINAL_TRANSCRIPT_EXCLUDED'), true);
  assert.deepEqual(compiled.replayManifest.find((entry) => entry.ref.ref_id === PARTIAL.ref_id)?.uses, [
    { kind: 'non_final_transcript', disposition: 'excluded_non_final' },
  ]);

  const partialOnly = compileWindowsAiContext(baseInput({
    transcripts: [{ ref: PARTIAL, status: 'interim', text: '只有中间态。', startMs: 1, endMs: 2 }],
  }), byteEstimator);
  assert.doesNotMatch(messageText(partialOnly), /只有中间态/u);
  assert.equal(partialOnly.degradedReasons.includes('FINAL_TRANSCRIPT_MISSING'), true);
});

test('speaker timeline is aligned to the final transcript window and rendered in chronological order', () => {
  const compiled = compileWindowsAiContext(baseInput({
    transcripts: [{ ref: FINAL, status: 'final', text: '甲乙先后发言。', startMs: 100, endMs: 300 }],
    speakerTimeline: [
      { ref: SPEAKER_B, startMs: 200, endMs: 280, speakerLabel: 'speaker_b', diarizationStatus: 'degraded' },
      { ref: SPEAKER_OUTSIDE, startMs: 301, endMs: 350, speakerLabel: 'speaker_outside', diarizationStatus: 'matched' },
      { ref: SPEAKER_A, startMs: 100, endMs: 180, speakerLabel: 'speaker_a', diarizationStatus: 'matched' },
    ],
  }), byteEstimator);
  const rendered = messageText(compiled);
  assert.ok(rendered.indexOf('speaker_a') < rendered.indexOf('speaker_b'));
  assert.doesNotMatch(rendered, /speaker_outside/u);
  assert.equal(compiled.degradedReasons.includes('SPEAKER_TIMELINE_OUTSIDE_FINAL_WINDOW'), true);
  assert.deepEqual(compiled.replayManifest.find((entry) => entry.ref.ref_id === SPEAKER_OUTSIDE.ref_id)?.uses, [
    { kind: 'speaker_timeline', disposition: 'excluded_time_window' },
  ]);
});

test('injected estimator enforces final, timeline, artifact, observation, history, memory priority without truncation', () => {
  let estimatorCalls = 0;
  const estimator: WindowsAiTokenEstimator = (messages) => {
    estimatorCalls += 1;
    const rendered = JSON.stringify(messages);
    return 10 +
      (rendered.includes('[FINAL_TRANSCRIPT') ? 20 : 0) +
      (rendered.includes('[SPEAKER_TIMELINE') ? 10 : 0) +
      (rendered.includes('[ARTIFACT') ? 20 : 0) +
      (rendered.includes('[HEALTH_SUMMARY') ? 10 : 0) +
      (rendered.includes('[LOCATION_SUMMARY') ? 10 : 0) +
      (rendered.includes('[SESSION_HISTORY') ? 20 : 0) +
      (rendered.includes('[MEMORY_CONTEXT') ? 20 : 0);
  };
  const compiled = compileWindowsAiContext(baseInput({
    budget: { reservedOutputTokens: 32_768, inputTokenLimit: 80 },
    transcripts: [{ ref: FINAL, status: 'final', text: '最终转写内容。', startMs: 100, endMs: 300 }],
    speakerTimeline: [{
      ref: SPEAKER_A, startMs: 100, endMs: 300, speakerLabel: 'speaker_a', diarizationStatus: 'matched',
    }],
    artifacts: [{
      ref: ARTIFACT, mediaKind: 'ocr_text', observedAtMs: 250,
      contentSha256: sha256Text('完整的图片文字内容。'),
      content: { kind: 'text', text: '完整的图片文字内容。' },
    }],
    observations: [
      { ref: HEALTH, kind: 'health_summary', observedAtMs: 260, resolvedContent: '健康摘要完整内容。' },
      { ref: LOCATION, kind: 'location_summary', observedAtMs: 270, resolvedContent: '位置摘要完整内容。' },
    ],
    sessionHistory: [{ ref: HISTORY, occurredAtMs: 50, resolvedContent: '历史内容不得静默截断。' }],
    memories: [{ ref: MEMORY, boundedContent: '记忆内容不得静默截断。', selectionReason: '相关。' }],
  }), estimator);
  const rendered = messageText(compiled);
  assert.match(rendered, /最终转写内容/u);
  assert.match(rendered, /speaker_a/u);
  assert.match(rendered, /完整的图片文字内容/u);
  assert.match(rendered, /健康摘要完整内容/u);
  assert.match(rendered, /位置摘要完整内容/u);
  assert.doesNotMatch(rendered, /历史内容不得静默截断/u);
  assert.doesNotMatch(rendered, /记忆内容不得静默截断/u);
  assert.equal(compiled.budget.estimatedInputTokens, 80);
  assert.equal(compiled.budget.decisions.find((value) => value.kind === 'session_history')?.disposition,
    'dropped_budget');
  assert.equal(compiled.budget.decisions.find((value) => value.kind === 'memory')?.disposition,
    'dropped_budget');
  assert.equal(compiled.degradedReasons.includes('SESSION_HISTORY_BUDGET_DROPPED'), true);
  assert.equal(compiled.degradedReasons.includes('MEMORY_CONTEXT_BUDGET_DROPPED'), true);
  assert.ok(estimatorCalls >= 7);
});

test('missing modalities are explicit degraded reasons rather than fabricated empty observations', () => {
  const compiled = compileWindowsAiContext(baseInput(), () => 10);
  assert.deepEqual(compiled.degradedReasons, [
    'ARTIFACT_MISSING',
    'FINAL_TRANSCRIPT_MISSING',
    'HEALTH_SUMMARY_MISSING',
    'LOCATION_SUMMARY_MISSING',
    'MEMORY_CONTEXT_MISSING',
    'SESSION_HISTORY_MISSING',
    'SPEAKER_TIMELINE_MISSING',
  ]);
  assert.doesNotMatch(messageText(compiled), /ARTIFACT|HEALTH_SUMMARY|LOCATION_SUMMARY|MEMORY_CONTEXT|SESSION_HISTORY|SPEAKER_TIMELINE/u);
  assert.equal(compiled.replayManifest.length, 2, 'only ProviderRoute and ModelDefinition bindings remain');
});

test('pre-aborted compilation has no estimator call and compilation never mutates caller input', () => {
  const input = baseInput({
    transcripts: [{ ref: FINAL, status: 'final', text: '不可变输入。', startMs: 1, endMs: 2 }],
  });
  const before = JSON.stringify(input);
  let calls = 0;
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => compileWindowsAiContext(input, () => { calls += 1; return 1; }, abort.signal),
    assertCode('WINDOWS_AI_CONTEXT_ABORTED'));
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(input), before);
  const compiled = compileWindowsAiContext(input, byteEstimator);
  assert.equal(JSON.stringify(input), before);
  assert.match(messageText(compiled), /不可变输入/u);
});

test('required final transcript fails closed when it cannot fit the injected token budget', () => {
  assert.throws(() => compileWindowsAiContext(baseInput({
    budget: { reservedOutputTokens: 32_768, inputTokenLimit: 50 },
    transcripts: [{ ref: FINAL, status: 'final', text: '必须保留的最终内容。', startMs: 1, endMs: 2 }],
  }), () => 51), assertCode('WINDOWS_AI_CONTEXT_REQUIRED_BUDGET_EXCEEDED'));
});
