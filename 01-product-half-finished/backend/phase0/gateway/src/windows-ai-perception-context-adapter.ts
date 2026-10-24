import type {
  OwnerCanonicalObjectVersionRef,
  ResolvedArtifactInput,
  ResolvedMemoryInput,
  ResolvedObservationInput,
  ResolvedSessionHistoryInput,
  ResolvedSpeakerTimelineInput,
  ResolvedTranscriptInput,
  WindowsAiContextCompilerInput,
} from './windows-ai-context-compiler.ts';

export const WINDOWS_AI_PERCEPTION_MAX_MEDIA_BYTES = 8_388_608 as const;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REF_KEYS = Object.freeze([
  'ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256',
] as const);

export type WindowsAiPerceptionAdapterErrorCode =
  | 'WINDOWS_AI_PERCEPTION_CONTEXT_INPUT_INVALID'
  | 'WINDOWS_AI_PERCEPTION_CONTEXT_ABORTED'
  | 'WINDOWS_AI_PERCEPTION_OWNER_REF_INVALID'
  | 'WINDOWS_AI_PERCEPTION_OWNER_HASH_INVALID'
  | 'WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID'
  | 'WINDOWS_AI_PERCEPTION_SPEAKER_INVALID'
  | 'WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID'
  | 'WINDOWS_AI_PERCEPTION_ARTIFACT_TOO_LARGE'
  | 'WINDOWS_AI_PERCEPTION_OBSERVATION_INVALID'
  | 'WINDOWS_AI_PERCEPTION_HISTORY_INVALID'
  | 'WINDOWS_AI_PERCEPTION_MEMORY_INVALID'
  | 'WINDOWS_AI_PERCEPTION_BUDGET_INVALID';

export class WindowsAiPerceptionContextAdapterError extends Error {
  readonly code: WindowsAiPerceptionAdapterErrorCode;

  constructor(code: WindowsAiPerceptionAdapterErrorCode) {
    super(code);
    this.name = 'WindowsAiPerceptionContextAdapterError';
    this.code = code;
  }
}

export interface WindowsAiOwnerResolvedTranscript {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly status: 'final';
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface WindowsAiOwnerResolvedSpeakerWindow {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly diarizationStatus: 'window_local' | 'matched' | 'degraded';
}

export interface WindowsAiOwnerResolvedImageArtifact {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly mediaKind: 'image' | 'video_frame';
  readonly observedAtMs: number;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
}

export interface WindowsAiOwnerResolvedOcrArtifact {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly mediaKind: 'ocr_text';
  readonly observedAtMs: number;
  readonly text: string;
  readonly contentSha256: string;
}

export type WindowsAiOwnerResolvedArtifact =
  | WindowsAiOwnerResolvedImageArtifact
  | WindowsAiOwnerResolvedOcrArtifact;

export interface WindowsAiOwnerResolvedObservation {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly kind: 'health_summary' | 'location_summary';
  readonly observedAtMs: number;
  readonly resolvedContent: string;
}

export interface WindowsAiOwnerResolvedHistoryEntry {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly occurredAtMs: number;
  readonly resolvedContent: string;
}

export interface WindowsAiOwnerResolvedMemoryEntry {
  readonly ref: OwnerCanonicalObjectVersionRef;
  readonly boundedContent: string;
  readonly selectionReason: string;
}

export interface WindowsAiOwnerResolvedPerceptionContext {
  readonly providerRouteRef: OwnerCanonicalObjectVersionRef;
  readonly modelDefinitionRef: OwnerCanonicalObjectVersionRef;
  readonly instruction: string;
  readonly transcripts?: readonly WindowsAiOwnerResolvedTranscript[];
  readonly speakerTimeline?: readonly WindowsAiOwnerResolvedSpeakerWindow[];
  readonly artifacts?: readonly WindowsAiOwnerResolvedArtifact[];
  readonly observations?: readonly WindowsAiOwnerResolvedObservation[];
  readonly sessionHistory?: readonly WindowsAiOwnerResolvedHistoryEntry[];
  readonly memories?: readonly WindowsAiOwnerResolvedMemoryEntry[];
  readonly budget: Readonly<{
    readonly reservedOutputTokens: number;
    readonly inputTokenLimit?: number;
  }>;
}

type RefType = OwnerCanonicalObjectVersionRef['ref_type'];

function fail(code: WindowsAiPerceptionAdapterErrorCode): never {
  throw new WindowsAiPerceptionContextAdapterError(code);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail('WINDOWS_AI_PERCEPTION_CONTEXT_ABORTED');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyOwnerRef(
  value: unknown,
  allowedTypes: ReadonlySet<RefType>,
): OwnerCanonicalObjectVersionRef {
  if (!isRecord(value) || Object.keys(value).sort().join('\n') !== [...REF_KEYS].sort().join('\n')) {
    fail('WINDOWS_AI_PERCEPTION_OWNER_REF_INVALID');
  }
  if (typeof value.ref_type !== 'string' || !allowedTypes.has(value.ref_type) ||
    typeof value.ref_id !== 'string' || !UUID_V7.test(value.ref_id) ||
    typeof value.object_version !== 'string' || !/^[1-9][0-9]*$/u.test(value.object_version) ||
    typeof value.canonical_payload_sha256 !== 'string' || !SHA256.test(value.canonical_payload_sha256)) {
    fail('WINDOWS_AI_PERCEPTION_OWNER_REF_INVALID');
  }
  return Object.freeze({
    ref_type: value.ref_type,
    ref_id: value.ref_id,
    object_version: value.object_version,
    canonical_payload_sha256: value.canonical_payload_sha256,
  });
}

function copyContentHash(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('WINDOWS_AI_PERCEPTION_OWNER_HASH_INVALID');
  }
  return value;
}

function copyTime(value: unknown, code: WindowsAiPerceptionAdapterErrorCode): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code);
  return Number(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersion(left: string, right: string): number {
  return left.length - right.length || compareText(left, right);
}

function compareRefs(left: OwnerCanonicalObjectVersionRef, right: OwnerCanonicalObjectVersionRef): number {
  return compareText(left.ref_type, right.ref_type) ||
    compareText(left.ref_id, right.ref_id) ||
    compareVersion(left.object_version, right.object_version) ||
    compareText(left.canonical_payload_sha256, right.canonical_payload_sha256);
}

function compareTranscript(left: ResolvedTranscriptInput, right: ResolvedTranscriptInput): number {
  return left.startMs - right.startMs || left.endMs - right.endMs || compareRefs(left.ref, right.ref);
}

function compareSpeaker(left: ResolvedSpeakerTimelineInput, right: ResolvedSpeakerTimelineInput): number {
  return left.startMs - right.startMs || left.endMs - right.endMs ||
    compareText(left.speakerLabel, right.speakerLabel) || compareRefs(left.ref, right.ref);
}

function compareArtifact(left: ResolvedArtifactInput, right: ResolvedArtifactInput): number {
  return left.observedAtMs - right.observedAtMs || compareText(left.mediaKind, right.mediaKind) ||
    compareRefs(left.ref, right.ref) || compareText(left.contentSha256, right.contentSha256);
}

function compareObservation(left: ResolvedObservationInput, right: ResolvedObservationInput): number {
  return left.observedAtMs - right.observedAtMs || compareText(left.kind, right.kind) || compareRefs(left.ref, right.ref);
}

function compareHistory(left: ResolvedSessionHistoryInput, right: ResolvedSessionHistoryInput): number {
  return left.occurredAtMs - right.occurredAtMs || compareRefs(left.ref, right.ref);
}

function compareMemory(left: ResolvedMemoryInput, right: ResolvedMemoryInput): number {
  return compareRefs(left.ref, right.ref) || compareText(left.boundedContent, right.boundedContent) ||
    compareText(left.selectionReason, right.selectionReason);
}

function encodeImage(
  mimeType: WindowsAiOwnerResolvedImageArtifact['mimeType'],
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): string {
  assertNotAborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    fail('WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
  }
  if (bytes.byteLength > WINDOWS_AI_PERCEPTION_MAX_MEDIA_BYTES) {
    fail('WINDOWS_AI_PERCEPTION_ARTIFACT_TOO_LARGE');
  }
  const copied = new Uint8Array(bytes);
  assertNotAborted(signal);
  const encoded = Buffer.from(copied).toString('base64');
  assertNotAborted(signal);
  return `data:${mimeType};base64,${encoded}`;
}

function copyBudget(value: unknown): WindowsAiContextCompilerInput['budget'] {
  if (!isRecord(value) || !Object.hasOwn(value, 'reservedOutputTokens')) {
    fail('WINDOWS_AI_PERCEPTION_BUDGET_INVALID');
  }
  const budget: { reservedOutputTokens: unknown; inputTokenLimit?: unknown } = {
    reservedOutputTokens: value.reservedOutputTokens,
  };
  if (Object.hasOwn(value, 'inputTokenLimit')) budget.inputTokenLimit = value.inputTokenLimit;
  return Object.freeze(budget) as WindowsAiContextCompilerInput['budget'];
}

function copyTranscripts(
  values: readonly WindowsAiOwnerResolvedTranscript[] | undefined,
): readonly ResolvedTranscriptInput[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail('WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID');
  const copied: ResolvedTranscriptInput[] = [];
  for (const value of values) {
    if (!isRecord(value) || value.status !== 'final' ||
      typeof value.text !== 'string') fail('WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID');
    const ref = copyOwnerRef(value.ref, new Set(['FinalTranscriptEvidence']));
    const startMs = copyTime(value.startMs, 'WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID');
    const endMs = copyTime(value.endMs, 'WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID');
    if (endMs <= startMs) fail('WINDOWS_AI_PERCEPTION_TRANSCRIPT_INVALID');
    copied.push(Object.freeze({ ref, status: 'final' as const, text: value.text, startMs, endMs }));
  }
  return Object.freeze(copied.sort(compareTranscript));
}

function mapDiarizationStatus(
  value: WindowsAiOwnerResolvedSpeakerWindow['diarizationStatus'],
): ResolvedSpeakerTimelineInput['diarizationStatus'] {
  if (value === 'window_local' || value === 'matched') return 'matched';
  if (value === 'degraded') return 'degraded';
  fail('WINDOWS_AI_PERCEPTION_SPEAKER_INVALID');
}

function copySpeakers(
  values: readonly WindowsAiOwnerResolvedSpeakerWindow[] | undefined,
): readonly ResolvedSpeakerTimelineInput[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail('WINDOWS_AI_PERCEPTION_SPEAKER_INVALID');
  const copied: ResolvedSpeakerTimelineInput[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.speakerLabel !== 'string') fail('WINDOWS_AI_PERCEPTION_SPEAKER_INVALID');
    const ref = copyOwnerRef(value.ref, new Set(['TranscriptSegment', 'FinalTranscriptEvidence']));
    const startMs = copyTime(value.startMs, 'WINDOWS_AI_PERCEPTION_SPEAKER_INVALID');
    const endMs = copyTime(value.endMs, 'WINDOWS_AI_PERCEPTION_SPEAKER_INVALID');
    if (endMs <= startMs) fail('WINDOWS_AI_PERCEPTION_SPEAKER_INVALID');
    copied.push(Object.freeze({
      ref,
      startMs,
      endMs,
      speakerLabel: value.speakerLabel,
      diarizationStatus: mapDiarizationStatus(value.diarizationStatus as WindowsAiOwnerResolvedSpeakerWindow['diarizationStatus']),
    }));
  }
  return Object.freeze(copied.sort(compareSpeaker));
}

function copyArtifacts(
  values: readonly WindowsAiOwnerResolvedArtifact[] | undefined,
  signal: AbortSignal | undefined,
): readonly ResolvedArtifactInput[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail('WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
  const copied: ResolvedArtifactInput[] = [];
  for (const value of values) {
    assertNotAborted(signal);
    if (!isRecord(value) || typeof value.mediaKind !== 'string') {
      fail('WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
    }
    const ref = copyOwnerRef(value.ref, new Set(['ArtifactVersion']));
    const observedAtMs = copyTime(value.observedAtMs, 'WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
    const contentSha256 = copyContentHash(value.contentSha256);
    if (value.mediaKind === 'ocr_text') {
      if (typeof value.text !== 'string') fail('WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
      copied.push(Object.freeze({
        ref,
        mediaKind: 'ocr_text' as const,
        observedAtMs,
        contentSha256,
        content: Object.freeze({ kind: 'text' as const, text: value.text }),
      }));
      continue;
    }
    if ((value.mediaKind !== 'image' && value.mediaKind !== 'video_frame') ||
      (value.mimeType !== 'image/jpeg' && value.mimeType !== 'image/png' && value.mimeType !== 'image/webp')) {
      fail('WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
    }
    const bytes = value.bytes;
    if (!(bytes instanceof Uint8Array)) fail('WINDOWS_AI_PERCEPTION_ARTIFACT_INVALID');
    const url = encodeImage(value.mimeType, bytes, signal);
    assertNotAborted(signal);
    copied.push(Object.freeze({
      ref,
      mediaKind: value.mediaKind,
      observedAtMs,
      contentSha256,
      content: Object.freeze({ kind: 'image_url' as const, url }),
    }));
  }
  return Object.freeze(copied.sort(compareArtifact));
}

function copyObservations(
  values: readonly WindowsAiOwnerResolvedObservation[] | undefined,
): readonly ResolvedObservationInput[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail('WINDOWS_AI_PERCEPTION_OBSERVATION_INVALID');
  const copied: ResolvedObservationInput[] = [];
  for (const value of values) {
    if (!isRecord(value) ||
      (value.kind !== 'health_summary' && value.kind !== 'location_summary') ||
      typeof value.resolvedContent !== 'string') fail('WINDOWS_AI_PERCEPTION_OBSERVATION_INVALID');
    copied.push(Object.freeze({
      ref: copyOwnerRef(value.ref, new Set(['Observation'])),
      kind: value.kind,
      observedAtMs: copyTime(value.observedAtMs, 'WINDOWS_AI_PERCEPTION_OBSERVATION_INVALID'),
      resolvedContent: value.resolvedContent,
    }));
  }
  return Object.freeze(copied.sort(compareObservation));
}

function copyHistory(
  values: readonly WindowsAiOwnerResolvedHistoryEntry[] | undefined,
): readonly ResolvedSessionHistoryInput[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail('WINDOWS_AI_PERCEPTION_HISTORY_INVALID');
  const allowed = new Set(['ContextAssertion', 'FinalTranscriptEvidence', 'Observation', 'RealtimeSession', 'TextEvidence']);
  const copied: ResolvedSessionHistoryInput[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.resolvedContent !== 'string') fail('WINDOWS_AI_PERCEPTION_HISTORY_INVALID');
    copied.push(Object.freeze({
      ref: copyOwnerRef(value.ref, allowed),
      occurredAtMs: copyTime(value.occurredAtMs, 'WINDOWS_AI_PERCEPTION_HISTORY_INVALID'),
      resolvedContent: value.resolvedContent,
    }));
  }
  return Object.freeze(copied.sort(compareHistory));
}

function copyMemories(
  values: readonly WindowsAiOwnerResolvedMemoryEntry[] | undefined,
): readonly ResolvedMemoryInput[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail('WINDOWS_AI_PERCEPTION_MEMORY_INVALID');
  const allowed = new Set(['EpisodicMemory', 'MemoryCandidate', 'OpenLoop', 'PreferenceMemory', 'SemanticFact']);
  const copied: ResolvedMemoryInput[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.boundedContent !== 'string' ||
      typeof value.selectionReason !== 'string') fail('WINDOWS_AI_PERCEPTION_MEMORY_INVALID');
    copied.push(Object.freeze({
      ref: copyOwnerRef(value.ref, allowed),
      boundedContent: value.boundedContent,
      selectionReason: value.selectionReason,
    }));
  }
  return Object.freeze(copied.sort(compareMemory));
}

export function adaptOwnerResolvedPerceptionContext(
  input: WindowsAiOwnerResolvedPerceptionContext,
  signal?: AbortSignal,
): WindowsAiContextCompilerInput {
  assertNotAborted(signal);
  if (!isRecord(input) || typeof input.instruction !== 'string') {
    fail('WINDOWS_AI_PERCEPTION_CONTEXT_INPUT_INVALID');
  }
  const transcripts = copyTranscripts(input.transcripts);
  const speakerTimeline = copySpeakers(input.speakerTimeline);
  const artifacts = copyArtifacts(input.artifacts, signal);
  const observations = copyObservations(input.observations);
  const sessionHistory = copyHistory(input.sessionHistory);
  const memories = copyMemories(input.memories);
  assertNotAborted(signal);
  const output = Object.freeze({
    providerRouteRef: copyOwnerRef(input.providerRouteRef, new Set(['ProviderRoute'])),
    modelDefinitionRef: copyOwnerRef(input.modelDefinitionRef, new Set(['ModelDefinition'])),
    instruction: input.instruction,
    budget: copyBudget(input.budget),
    ...(transcripts === undefined ? {} : { transcripts }),
    ...(speakerTimeline === undefined ? {} : { speakerTimeline }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(observations === undefined ? {} : { observations }),
    ...(sessionHistory === undefined ? {} : { sessionHistory }),
    ...(memories === undefined ? {} : { memories }),
  }) as WindowsAiContextCompilerInput;
  assertNotAborted(signal);
  return output;
}

export const adaptWindowsAiPerceptionContext = adaptOwnerResolvedPerceptionContext;
