import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import type {
  FinalTranscriptEvidenceInput,
  FinalTranscriptEvidenceResult,
  FinalTranscriptEvidenceService,
  T11BCanonicalRef,
} from '../../../services/realtime-core/src/final-transcript-evidence-service.ts';
import type { CompilerQuery, MemorySensitivity } from '../../../services/memory-os/src/domain.ts';
import { assertCanonicalObjectVersionRef, type CanonicalObjectVersionRef } from '../../../services/memory-os/src/canonical-ref.ts';
import {
  type FinalTranscriptEvidenceReader,
} from '../../../services/memory-os/src/final-transcript-explicit-remember-adapter.ts';
import type {
  ExplicitUserRememberCommand,
  ExplicitUserRememberResult,
} from '../../../services/memory-os/src/explicit-user-remember-service.ts';
import type { MemoryConsumerContext } from '../../../services/memory-os/src/context-consumer-adapter.ts';
import type {
  SourceMediaAuthorityPort,
  SourceVisualIssueReceipt,
  SourceVisualIssueInput,
  SourceVisualMediaFormat,
  SourceVisualReadResult,
} from '../../../services/connector-runtime/src/index.ts';
import {
  Qwen38ProviderAdapter,
  type Qwen38ChatMessage,
  type Qwen38ChatRequest,
  type Qwen38LocalProviderProfile,
  type Qwen38StreamEvent,
} from './qwen38-provider-adapter.ts';
import {
  conversationTurnIdempotencyPayloadSha256,
  type RealtimeConversationTurnBinding,
  type RealtimeConversationTurnClaimInput,
  type ConversationTurnCanonicalRef,
  type RealtimeConversationTurnPostgres,
  type RealtimeConversationTurnReceipt,
} from '../../../services/platform-data/src/realtime-conversation-turn-postgres.ts';
import {
  createRayneoFinalTranscriptAuthority,
  type RayneoFinalTranscriptOwnerBinding,
  type RayneoFinalTranscriptOwnerBindingResolver,
  type RayneoSourceMediaAuthorityInput,
  type RayneoSourceMediaAuthorityPort,
} from './rayneo-final-transcript-authority.ts';
import type {
  RayneoFinalTranscriptAuthorityInput,
  RayneoFinalTranscriptAuthorityPort,
  RayneoRealtimeMultimodalReplyInput,
  RayneoRealtimeVisualHeartbeatInput,
  RayneoGeneratedReply,
  RayneoSpokenReply,
} from './rayneo-realtime-audio-controller.ts';
export interface RayneoVisualModelResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
}
export type RayneoVisualModelFrame = Readonly<Pick<
  import('./device-session-adapter.ts').RayneoVisualFrameMetadata,
  'frameId' | 'capturedAt' | 'width' | 'height'
>>;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UTC = /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const FRAME_ID = /^rayneo_frame_[a-f0-9]{20}$/u;
const SEGMENT_ID = /^rayneo_segment_[a-f0-9]{20}$/u;
const MAX_VISUAL_BYTES = 8_388_608;
const MAX_ACTIVE_SEGMENT_STATES = 32;
const MAX_RECALL_ITEMS = 128;
const MAX_RECALL_CONTENT_BYTES = 65_536;
const TTS_SAMPLE_RATE = 16_000;
const TTS_CHANNELS = 1;
const TTS_MAX_WAV_BYTES = 1_920_044;
const TTS_DEADLINE_MS = 15_000;

type PlainRecord = Record<string, unknown>;

type NegotiationMode = 'normal' | 'negotiation';
type NegotiationToggle = 'on' | 'off';
type NegotiationFact = Readonly<{
  readonly speakerLabel: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly gapMs: number;
  readonly diarizationStatus: 'window_local' | 'degraded';
  readonly transcript: string;
}>;

const NEGOTIATION_ON_REPLY = '已开启谈判模式；我只依据可观察语言、停顿和画面给出建议，并标注不确定性。';
const NEGOTIATION_OFF_REPLY = '已关闭谈判模式。';
const NEGOTIATION_FALLBACK = '建议：暂不调整条件；依据：结构不完整；置信度：低；未知项：真实约束；替代解释：可能需要更多信息';
const NEGOTIATION_SYSTEM_PROMPT =
  '只依据可观察的语言、停顿时长、重叠或间隔，以及画面中的表情和头部姿态变化；不得判断谎言、心理状态、动机或内心；不确定必须保留。只输出单行且不超过256字，严格使用格式：建议：…；依据：…；置信度：低|中|高；未知项：…；替代解释：…；不得输出换行、推理过程或前缀。';

function parseNegotiationToggle(value: string): NegotiationToggle | undefined {
  const normalized = value.normalize('NFC').trim().replace(/[。！？.!?]+$/u, '');
  if (normalized === '开启谈判模式') return 'on';
  if (normalized === '关闭谈判模式' || normalized === '退出谈判模式') return 'off';
  return undefined;
}

function negotiationReply(value: string): string {
  try {
    const text = rayneoReplyText(value);
    if (text.length <= 256 && !text.includes('\n') &&
        /^建议：.+；依据：.+；置信度：(低|中|高)；未知项：.+；替代解释：.+$/u.test(text)) return text;
  } catch { /* conservative fallback below */ }
  return NEGOTIATION_FALLBACK;
}

function negotiationFactText(facts: readonly NegotiationFact[]): string {
  return facts.length === 0 ? '事实窗口：暂无已完成语音事实。' : `事实窗口：${facts.map((fact) =>
    `speaker=${fact.speakerLabel},start=${fact.startMs},end=${fact.endMs},duration=${fact.durationMs},gap=${fact.gapMs},diarization=${fact.diarizationStatus},text=${fact.transcript}`).join(' | ')}`;
}

function conversationCanonicalRef(value: T11BCanonicalRef): ConversationTurnCanonicalRef {
  return Object.freeze({
    ref_type: value.refType,
    ref_id: value.refId,
    object_version: value.objectVersion,
    canonical_payload_sha256: value.canonicalPayloadSha256,
  });
}

/** T13-native image input; metadata comes only from the admitted RayNeo frame. */
export type RayneoVisualSourceMediaInput = SourceVisualIssueInput;

/**
 * T13 production source-media seam. `issue` is the existing PCM path consumed
 * by the final-transcript authority; `issueVisual` is the corresponding visual
 * path. Neither method may mint an identity locally.
 */
export interface RayneoProductionSourceMediaPort extends RayneoSourceMediaAuthorityPort {
  readonly issueVisual: SourceMediaAuthorityPort['issueVisual'];
  readonly issueVisualWithReceipt: SourceMediaAuthorityPort['issueVisualWithReceipt'];
  readonly readVisual: SourceMediaAuthorityPort['readVisual'];
}

/**
 * T05/Memory production seam. The composition never supplies user identity to
 * these methods from process environment; identity is resolved through T11B.
 */
export interface RayneoProductionMemoryPort {
  readonly rememberExplicit: (input: ExplicitUserRememberCommand) => Promise<ExplicitUserRememberResult>;
  readonly recallForAnswerContext: (
    input: Omit<CompilerQuery, 'userId' | 'purposeScope'>,
  ) => Promise<MemoryConsumerContext>;
}

/** Reusable model seam; callers may share one adapter with the typed bridge. */
export interface RayneoProductionQwenProvider {
  readonly stream: (
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
  ) => AsyncIterable<Qwen38StreamEvent>;
  readonly complete: (
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
  ) => Promise<Readonly<{ readonly text: string }>>;
  readonly close?: () => void | Promise<void>;
}

export interface RayneoProductionTurnBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly replyId: string;
  readonly frameId: string;
  readonly receiptIdempotencyKey: string;
  readonly openedAt: number;
  readonly expiresAt: number;
}

export interface RayneoProductionRecallLimits {
  readonly maxItems: number;
  readonly maxContentBytes: number;
}

export interface RayneoProductionConversationTurnPort {
  readonly postgres: RealtimeConversationTurnPostgres;
  readonly binding: () => Promise<RealtimeConversationTurnBinding>;
  readonly restored?: readonly RealtimeConversationTurnReceipt[];
}

export interface RayneoProductionCompositionOptions {
  readonly ownerBinding: RayneoFinalTranscriptOwnerBindingResolver;
  readonly sourceMedia: RayneoProductionSourceMediaPort;
  readonly finalTranscript: FinalTranscriptEvidenceService;
  readonly finalTranscriptEvidenceReader: FinalTranscriptEvidenceReader;
  readonly memory: RayneoProductionMemoryPort;
  /** Explicitly owner-bound; the composition does not infer sensitivity. */
  readonly sensitivity: MemorySensitivity;
  readonly qwenProfile: Qwen38LocalProviderProfile;
  readonly qwenProvider?: RayneoProductionQwenProvider;
  readonly recall: RayneoProductionRecallLimits;
  readonly conversationTurn?: RayneoProductionConversationTurnPort;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly synthesizeSpeech?: (text: string, signal: AbortSignal) => Promise<Readonly<{
    pcm: Int16Array; sampleRate: 16_000; channels: 1;
  }>>;
}

export interface RayneoProductionFinalTranscriptPostCommit {
  readonly input: Readonly<{
    readonly sessionId: string;
    readonly deviceId: string;
    readonly clientInstanceId: string;
    readonly segmentId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly speakerLabel: string;
    readonly diarizationStatus: 'window_local' | 'degraded';
    readonly transcript: string;
    readonly language: 'und';
    readonly observedAt: string;
  }>;
  readonly evidence: FinalTranscriptEvidenceResult;
}

export interface RayneoProductionTurn {
  readonly finalTranscriptAuthority: RayneoFinalTranscriptAuthorityPort & {
    readonly finalizeWithEvidence: (input: RayneoFinalTranscriptAuthorityInput) => Promise<FinalTranscriptEvidenceResult>;
  };
  readonly visualModelProvider: (
    jpeg: Buffer,
    signal: AbortSignal,
    frame?: RayneoVisualModelFrame,
  ) => Promise<RayneoVisualModelResult>;
  readonly generateReply: (transcript: string, speakerLabel: string, signal: AbortSignal) => Promise<RayneoGeneratedReply>;
  readonly generateSegmentReply: (
    segmentId: string,
    transcript: string,
    speakerLabel: string,
    signal: AbortSignal,
  ) => Promise<RayneoGeneratedReply>;
  readonly streamTypedReply: (
    input: Readonly<{ readonly promptId: string; readonly text: string }>,
    signal: AbortSignal,
  ) => AsyncIterable<Qwen38StreamEvent>;
  readonly generateRealtimeReply: (
    input: RayneoRealtimeMultimodalReplyInput,
    signal: AbortSignal,
  ) => Promise<RayneoGeneratedReply>;
  readonly generateVisualHeartbeatReply: (
    input: RayneoRealtimeVisualHeartbeatInput,
    signal: AbortSignal,
  ) => Promise<RayneoGeneratedReply>;
  readonly completeConversationTurn: (
    inputId: string,
    assistantText: string,
  ) => Promise<void>;
  readonly markIndeterminateConversationTurn: (
    inputId: string,
    assistantText: string,
  ) => Promise<void>;
  readonly releaseConversationTurn: (inputId: string) => Promise<void>;
  readonly afterFinalTranscript: (input: RayneoProductionFinalTranscriptPostCommit) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RayneoProductionComposition {
  readonly openTurn: (binding: RayneoProductionTurnBinding) => RayneoProductionTurn;
  /** Release the single active turn after the owning RayNeo session has stopped. */
  readonly releaseTurn: (turn: RayneoProductionTurn) => Promise<void>;
  readonly close: () => Promise<void>;
}

function failure(code: string): Error {
  return new Error(code);
}

const SAPI_SCRIPT = String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$text=[Console]::In.ReadToEnd()
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice=$s.GetInstalledVoices()|Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1
if($null -eq $voice){throw 'ZH_CN_VOICE_MISSING'}
$s.SelectVoice($voice.VoiceInfo.Name)
$format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$ms=New-Object System.IO.MemoryStream
$s.SetOutputToAudioStream($ms,$format)
$s.Speak($text)
$pcm=$ms.ToArray();$out=[Console]::OpenStandardOutput();$bw=New-Object System.IO.BinaryWriter($out)
$bw.Write([Text.Encoding]::ASCII.GetBytes('RIFF'));$bw.Write([int](36+$pcm.Length));$bw.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '));$bw.Write([int]16);$bw.Write([int16]1);$bw.Write([int16]1);$bw.Write([int]16000);$bw.Write([int]32000);$bw.Write([int16]2);$bw.Write([int16]16);$bw.Write([Text.Encoding]::ASCII.GetBytes('data'));$bw.Write([int]$pcm.Length);$bw.Write($pcm);$bw.Flush();$s.Dispose();$ms.Dispose()`;

function parseSapiWav(wav: Buffer): Readonly<{ pcm: Int16Array; sampleRate: 16_000; channels: 1 }> {
  if (wav.length < 44 || wav.length > TTS_MAX_WAV_BYTES || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE' || wav.toString('ascii', 12, 16) !== 'fmt ' ||
      wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(24) !== TTS_SAMPLE_RATE || wav.readUInt16LE(34) !== 16 ||
      wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 ||
      (wav.length - 44) % 2 !== 0) throw failure('RAYNEO_SAPI_WAV_INVALID');
  const pcm = new Int16Array((wav.length - 44) / 2);
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = wav.readInt16LE(44 + index * 2);
  return Object.freeze({ pcm, sampleRate: 16_000 as const, channels: 1 as const });
}

async function synthesizeWindowsSapi(
  text: string, signal: AbortSignal,
): Promise<Readonly<{ pcm: Int16Array; sampleRate: 16_000; channels: 1 }>> {
  if (process.platform !== 'win32' || text.length === 0 || text.length > 1_024 || signal.aborted) {
    throw failure('RAYNEO_SAPI_INPUT_INVALID');
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SAPI_SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const timer = setTimeout(() => { child.kill(); }, TTS_DEADLINE_MS);
    const abort = (): void => { child.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > TTS_MAX_WAV_BYTES) child.kill(); else chunks.push(Buffer.from(chunk));
    });
    child.on('error', () => { if (!settled) { settled = true; reject(failure('RAYNEO_SAPI_PROCESS_FAILED')); } });
    child.on('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (settled) return; settled = true;
      const wav = Buffer.concat(chunks); chunks.forEach((chunk) => chunk.fill(0));
      try {
        if (code !== 0 || signal.aborted || bytes > TTS_MAX_WAV_BYTES) throw failure('RAYNEO_SAPI_PROCESS_FAILED');
        resolve(parseSapiWav(wav));
      } catch (error) { reject(error); } finally { wav.fill(0); }
    });
    child.stdin.end(text, 'utf8');
  });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\u0000')) {
    throw failure(code);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('RAYNEO_PRODUCTION_CANONICAL_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainRecord(value)) throw failure('RAYNEO_PRODUCTION_CANONICAL_VALUE_INVALID');
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function bytesSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneBytes(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

function canonicalNow(now: (() => string) | undefined): string {
  const value = now?.() ?? new Date().toISOString();
  if (!UTC.test(value) || !Number.isFinite(Date.parse(value))) throw failure('RAYNEO_PRODUCTION_CLOCK_INVALID');
  return value;
}

function validateRef(value: unknown, allowed: readonly string[], code: string): T11BCanonicalRef {
  if (!isPlainRecord(value) || Object.keys(value).length !== 4 ||
      !allowed.includes(String(value.refType)) || typeof value.refId !== 'string' || !UUID_V7.test(value.refId) ||
      typeof value.objectVersion !== 'string' || !/^[1-9][0-9]*$/u.test(value.objectVersion) ||
      typeof value.canonicalPayloadSha256 !== 'string' || !SHA256.test(value.canonicalPayloadSha256)) {
    throw failure(code);
  }
  return Object.freeze({
    refType: value.refType as T11BCanonicalRef['refType'],
    refId: value.refId,
    objectVersion: value.objectVersion,
    canonicalPayloadSha256: value.canonicalPayloadSha256,
  });
}

function refKey(value: T11BCanonicalRef): string {
  return `${value.refType}:${value.refId}:${value.objectVersion}:${value.canonicalPayloadSha256}`;
}

function copyBinding(value: RayneoFinalTranscriptOwnerBinding): RayneoFinalTranscriptOwnerBinding {
  if (!isPlainRecord(value)) throw failure('RAYNEO_PRODUCTION_BINDING_INVALID');
  return Object.freeze({
    canonicalDeviceId: (() => {
      const canonicalDeviceId = exactString(value.canonicalDeviceId, 'RAYNEO_PRODUCTION_BINDING_INVALID');
      if (!UUID_V7.test(canonicalDeviceId)) throw failure('RAYNEO_PRODUCTION_BINDING_INVALID');
      return canonicalDeviceId;
    })(),
    userId: exactString(value.userId, 'RAYNEO_PRODUCTION_BINDING_INVALID'),
    realtimeSessionRef: value.realtimeSessionRef,
    continuityId: exactString(value.continuityId, 'RAYNEO_PRODUCTION_BINDING_INVALID'),
    purpose: exactString(value.purpose, 'RAYNEO_PRODUCTION_BINDING_INVALID'),
  });
}

function bindingMatches(
  left: RayneoFinalTranscriptOwnerBinding,
  right: RayneoFinalTranscriptOwnerBinding,
): boolean {
  return left.userId === right.userId && left.continuityId === right.continuityId &&
    left.purpose === right.purpose && left.canonicalDeviceId === right.canonicalDeviceId &&
    canonicalJson(left.realtimeSessionRef) === canonicalJson(right.realtimeSessionRef);
}

function validateSensitivity(value: MemorySensitivity): MemorySensitivity {
  if (!isPlainRecord(value) || Object.keys(value).length !== 2 ||
      (value.classification !== 'normal' && value.classification !== 'sensitive') ||
      value.userConfirmed !== true) {
    throw failure('RAYNEO_PRODUCTION_SENSITIVITY_INVALID');
  }
  return Object.freeze({ classification: value.classification, userConfirmed: true });
}

function validateLimits(value: RayneoProductionRecallLimits): RayneoProductionRecallLimits {
  if (!isPlainRecord(value) || !Number.isSafeInteger(value.maxItems) || value.maxItems < 1 ||
      value.maxItems > MAX_RECALL_ITEMS || !Number.isSafeInteger(value.maxContentBytes) ||
      value.maxContentBytes < 1 || value.maxContentBytes > MAX_RECALL_CONTENT_BYTES) {
    throw failure('RAYNEO_PRODUCTION_RECALL_LIMITS_INVALID');
  }
  return Object.freeze({ maxItems: value.maxItems, maxContentBytes: value.maxContentBytes });
}

function validateProfile(profile: Qwen38LocalProviderProfile): Qwen38LocalProviderProfile {
  if (!isPlainRecord(profile) || typeof profile.origin !== 'string' || typeof profile.model !== 'string' ||
      !Number.isSafeInteger(profile.contextTokens) || profile.contextTokens < 1 ||
      (profile.availabilityMode !== 'openai-models' && profile.availabilityMode !== 'supervisor-health')) {
    throw failure('RAYNEO_PRODUCTION_QWEN_PROFILE_INVALID');
  }
  return Object.freeze({ ...profile, capabilities: Object.freeze([...(profile.capabilities ?? [])]) });
}

function validateVisualFrame(value: RayneoVisualModelFrame | undefined): RayneoVisualModelFrame {
  if (!isPlainRecord(value) || !FRAME_ID.test(String(value.frameId)) ||
      typeof value.capturedAt !== 'string' || !UTC.test(value.capturedAt) || !Number.isFinite(Date.parse(value.capturedAt)) ||
      !Number.isSafeInteger(value.width) || Number(value.width) < 1 || Number(value.width) > 8_192 ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 1 || Number(value.height) > 8_192) {
    throw failure('RAYNEO_PRODUCTION_VISUAL_METADATA_REQUIRED');
  }
  return Object.freeze({
    frameId: value.frameId,
    capturedAt: value.capturedAt,
    width: value.width,
    height: value.height,
  });
}

function waitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(failure('RAYNEO_PRODUCTION_TURN_ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(failure('RAYNEO_PRODUCTION_TURN_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function renderedMemoryContext(context: MemoryConsumerContext): string {
  if (!isPlainRecord(context) || !Array.isArray(context.memories)) throw failure('RAYNEO_PRODUCTION_MEMORY_CONTEXT_INVALID');
  return context.memories.map((memory) => {
    const ref = memory.ref;
    return `[MEMORY ${ref.refType}:${ref.refId}:${ref.objectVersion}:${ref.canonicalPayloadSha256}]\n${memory.boundedContent}\n[/MEMORY]`;
  }).join('\n');
}

function rayneoReplyText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 256 ||
      /(?:https?:\/\/|Bearer\s|sk-[A-Za-z0-9_-]|<[^>]+>|```)/iu.test(value) ||
      /[/\u0000-\u001f\u007f]/u.test(value)) throw failure('RAYNEO_PRODUCTION_QWEN_RESPONSE_INVALID');
  return value;
}

function authorityInputFingerprint(input: RayneoFinalTranscriptAuthorityInput, canonicalDeviceId: string): string {
  return sha256({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    canonicalDeviceId,
    clientInstanceId: input.clientInstanceId,
    segmentId: input.segmentId,
    startMs: input.startMs,
    endMs: input.endMs,
    speakerLabel: input.speakerLabel,
    diarizationStatus: input.diarizationStatus,
    transcript: input.transcript,
    language: input.language,
    observedAt: input.observedAt,
    mediaFormat: input.media.format,
    sampleRate: input.media.sampleRate,
    channels: input.media.channels,
    mediaByteLength: input.media.bytes.byteLength,
    mediaSha256: bytesSha256(input.media.bytes),
    declaredMediaSha256: input.media.sha256,
  });
}

function postCommitFingerprint(
  input: RayneoProductionFinalTranscriptPostCommit['input'],
  canonicalDeviceId: string,
): string {
  return sha256({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    canonicalDeviceId,
    clientInstanceId: input.clientInstanceId,
    segmentId: input.segmentId,
    startMs: input.startMs,
    endMs: input.endMs,
    speakerLabel: input.speakerLabel,
    diarizationStatus: input.diarizationStatus,
    transcript: input.transcript,
    language: input.language,
    observedAt: input.observedAt,
  });
}

function authorityPostCommitInput(input: RayneoFinalTranscriptAuthorityInput): RayneoProductionFinalTranscriptPostCommit['input'] {
  return Object.freeze({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    clientInstanceId: input.clientInstanceId,
    segmentId: input.segmentId,
    startMs: input.startMs,
    endMs: input.endMs,
    speakerLabel: input.speakerLabel,
    diarizationStatus: input.diarizationStatus,
    transcript: input.transcript,
    language: input.language,
    observedAt: input.observedAt,
  });
}

function createTurn(
  options: Readonly<{
    readonly config: RayneoProductionCompositionOptions;
    readonly binding: RayneoProductionTurnBinding;
  }>,
): RayneoProductionTurn {
  const config = options.config;
  const binding = options.binding;
  const ownerBindingResolver = config.ownerBinding;
  const provider: RayneoProductionQwenProvider = config.qwenProvider ?? new Qwen38ProviderAdapter(config.qwenProfile,
    config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl });
  const ownsProvider = config.qwenProvider === undefined;
  const typedHistory: Qwen38ChatMessage[] = [];
  const appendHistory = (userText: string, assistantText: string): void => {
    typedHistory.push(
      Object.freeze({ role: 'user' as const, content: userText }),
      Object.freeze({ role: 'assistant' as const, content: assistantText }),
    );
    while (typedHistory.length > 8) typedHistory.shift();
  };
  let negotiationMode: NegotiationMode = 'normal';
  const negotiationFacts: NegotiationFact[] = [];
  type PendingNegotiation = {
    readonly fact?: NegotiationFact;
    readonly history?: Readonly<{ userText: string; assistantText: string }>;
  };
  const pendingNegotiation = new Map<string, PendingNegotiation>();
  const stageNegotiation = (inputId: string, value: PendingNegotiation): void => {
    const current = pendingNegotiation.get(inputId);
    const next: { fact?: NegotiationFact; history?: Readonly<{ userText: string; assistantText: string }> } = {};
    if (current?.fact !== undefined) next.fact = current.fact;
    if (current?.history !== undefined) next.history = current.history;
    if (value.fact !== undefined) next.fact = value.fact;
    if (value.history !== undefined) next.history = value.history;
    pendingNegotiation.set(inputId, Object.freeze(next));
  };
  for (const receipt of config.conversationTurn?.restored ?? []) {
    const userText = receipt.user_text ?? `视觉来源：${(receipt.source_visual_refs ?? [])
      .map((ref) => refKey(ref as unknown as T11BCanonicalRef)).join(',')}`;
    appendHistory(userText, receipt.assistant_text);
    const toggle = receipt.user_text === undefined ? undefined : parseNegotiationToggle(receipt.user_text);
    if (toggle !== undefined) negotiationMode = toggle === 'on' ? 'negotiation' : 'normal';
  }
  type ConversationDecision = Readonly<{
    readonly kind: 'claimed' | 'replay' | 'in_flight' | 'indeterminate' | 'conflict';
    readonly receipt?: RealtimeConversationTurnReceipt;
  }>;
  type ConversationClaimState = {
    readonly claim: RealtimeConversationTurnClaimInput;
    readonly decision: ConversationDecision;
    published: boolean;
  };
  const conversationClaims = new Map<string, ConversationClaimState>();
  const conversationClaim = async (input: Readonly<{
    readonly inputKind: 'typed' | 'audio' | 'visual';
    readonly inputId: string;
    readonly userText?: string;
    readonly finalTranscriptEvidenceRef?: T11BCanonicalRef;
    readonly sourceVisualRefs?: readonly T11BCanonicalRef[];
  }>): Promise<ConversationDecision> => {
    const port = config.conversationTurn;
    if (port === undefined) return Object.freeze({ kind: 'claimed' as const });
    const existing = conversationClaims.get(input.inputId);
    if (existing !== undefined) return existing.decision;
    const binding = await port.binding();
    const base = Object.freeze({
      binding,
      inputKind: input.inputKind,
      inputId: input.inputId,
      ...(input.userText === undefined ? {} : {
        userText: input.userText,
        userTextSha256: createHash('sha256').update(input.userText, 'utf8').digest('hex'),
      }),
      ...(input.finalTranscriptEvidenceRef === undefined ? {} : {
        finalTranscriptEvidenceRef: conversationCanonicalRef(input.finalTranscriptEvidenceRef),
      }),
      ...(input.sourceVisualRefs === undefined ? {} : {
        sourceVisualRefs: input.sourceVisualRefs.map(conversationCanonicalRef),
      }),
    });
    const claim: RealtimeConversationTurnClaimInput = Object.freeze({
      ...base,
      idempotencyKey: `rayneo_turn_${sha256({
        runId: binding.realtimeSessionRef.ref_id,
        inputKind: input.inputKind,
        inputId: input.inputId,
        binding,
      }).slice(0, 64)}`,
      idempotencyPayloadSha256: conversationTurnIdempotencyPayloadSha256(
        base as Omit<RealtimeConversationTurnClaimInput, 'idempotencyKey' | 'idempotencyPayloadSha256'>,
      ),
    });
    const result = await port.postgres.beginClaim(claim);
    const decision: ConversationDecision = Object.freeze({
      kind: result.kind,
      ...('receipt' in result ? { receipt: result.receipt } : {}),
    });
    conversationClaims.set(input.inputId, { claim, decision, published: false });
    return decision;
  };
  const completeConversationTurn = async (inputId: string, assistantText: string): Promise<void> => {
    const port = config.conversationTurn;
    const state = conversationClaims.get(inputId);
    if (port === undefined || state === undefined) return;
    if (state.decision.kind === 'replay') {
      applyCompletedNegotiation(inputId, assistantText, state);
      conversationClaims.delete(inputId);
      return;
    }
    state.published = true;
    try {
      await port.postgres.commitCompletedAfterPublish(Object.freeze({
        claim: state.claim,
        assistantText,
        assistantTextSha256: createHash('sha256').update(assistantText, 'utf8').digest('hex'),
        publishObservation: Object.freeze({ state: 'confirmed' as const, observedAt: canonicalNow(config.now) }),
      }));
      applyCompletedNegotiation(inputId, assistantText, state);
      conversationClaims.delete(inputId);
    } catch (error) {
      try {
        await port.postgres.markIndeterminate(Object.freeze({
          claim: state.claim,
          assistantText,
          assistantTextSha256: createHash('sha256').update(assistantText, 'utf8').digest('hex'),
          publishObservation: Object.freeze({ state: 'ambiguous' as const, observedAt: canonicalNow(config.now) }),
        }));
    pendingNegotiation.delete(inputId);
    conversationClaims.delete(inputId);
      } catch { /* leave durable in-flight when the authority is unavailable */ }
      throw error;
    }
  };
  const markIndeterminateConversationTurn = async (inputId: string, assistantText: string): Promise<void> => {
    const port = config.conversationTurn;
    const state = conversationClaims.get(inputId);
    if (port === undefined || state === undefined) return;
    if (state.decision.kind === 'replay') {
      pendingNegotiation.delete(inputId);
      conversationClaims.delete(inputId);
      return;
    }
    state.published = true;
    await port.postgres.markIndeterminate(Object.freeze({
      claim: state.claim,
      assistantText,
      assistantTextSha256: createHash('sha256').update(assistantText, 'utf8').digest('hex'),
      publishObservation: Object.freeze({ state: 'ambiguous' as const, observedAt: canonicalNow(config.now) }),
    }));
    pendingNegotiation.delete(inputId);
    conversationClaims.delete(inputId);
  };
  const releaseConversationTurn = async (inputId: string): Promise<void> => {
    const port = config.conversationTurn;
    const state = conversationClaims.get(inputId);
    if (port === undefined || state === undefined) return;
    if (state.decision.kind === 'replay') {
      pendingNegotiation.delete(inputId);
      conversationClaims.delete(inputId);
      return;
    }
    if (state.published) return;
    await port.postgres.releaseBeforePublish(state.claim);
    pendingNegotiation.delete(inputId);
    conversationClaims.delete(inputId);
  };
  const applyCompletedNegotiation = (
    inputId: string,
    assistantText: string,
    state: ConversationClaimState,
  ): void => {
    const toggle = state.claim.userText === undefined ? undefined : parseNegotiationToggle(state.claim.userText);
    if (toggle !== undefined) {
      negotiationMode = toggle === 'on' ? 'negotiation' : 'normal';
      if (state.decision.kind !== 'replay') appendHistory(state.claim.userText!, assistantText);
      return;
    }
    const staged = pendingNegotiation.get(inputId);
    const stagedHistory = staged?.history;
    if (stagedHistory !== undefined && state.decision.kind !== 'replay') {
      appendHistory(stagedHistory.userText, stagedHistory.assistantText);
    }
    const stagedFact = staged?.fact;
    if (stagedFact !== undefined && state.decision.kind !== 'replay') {
      negotiationFacts.push(stagedFact);
      while (negotiationFacts.length > 6) negotiationFacts.shift();
    }
    pendingNegotiation.delete(inputId);
  };
  const turnAbort = new AbortController();
  const synthesizeSpeech = config.synthesizeSpeech ?? synthesizeWindowsSapi;
  const withSpeech = async (text: string, signal: AbortSignal): Promise<RayneoSpokenReply> => {
    const speech = await synthesizeSpeech(text, signal);
    if (!(speech.pcm instanceof Int16Array) || speech.pcm.length === 0 ||
        speech.pcm.length > TTS_SAMPLE_RATE * 60 || speech.sampleRate !== TTS_SAMPLE_RATE ||
        speech.channels !== TTS_CHANNELS) throw failure('RAYNEO_PRODUCTION_SPEECH_INVALID');
    return Object.freeze({ text, pcm: speech.pcm, sampleRate: 16_000 as const, channels: 1 as const });
  };
  let closed = false;
  let started = false;
  let activeBinding: RayneoFinalTranscriptOwnerBinding | undefined;
  let visual: Readonly<{
    readonly bytes: Buffer;
    readonly sha256: string;
    readonly ref: T11BCanonicalRef;
  }> | undefined;
  let visualIssueFingerprint: string | undefined;
  let visualIssuePromise: Promise<T11BCanonicalRef> | undefined;
  let visualOnlyFingerprint: string | undefined;
  let visualOnlyPromise: Promise<string> | undefined;
  let spokenCompletionPromise: Promise<RayneoGeneratedReply> | undefined;
  let final: Readonly<{
    readonly input: RayneoProductionFinalTranscriptPostCommit['input'];
    readonly evidence: FinalTranscriptEvidenceResult;
    readonly memory: MemoryConsumerContext;
  }> | undefined;
  let resolveCompletion: ((value: string) => void) | undefined;
  let rejectCompletion: ((reason?: unknown) => void) | undefined;
  let finalInputFingerprint: string | undefined;
  let finalPostCommitInputFingerprint: string | undefined;
  let finalEvidence: FinalTranscriptEvidenceResult | undefined;
  let finalCommitPromise: Promise<FinalTranscriptEvidenceResult> | undefined;
  let postCommitInputFingerprint: string | undefined;
  let postCommitPromise: Promise<void> | undefined;
  type SegmentState = {
    finalInputFingerprint?: string;
    finalPostCommitInputFingerprint?: string;
    finalEvidence?: FinalTranscriptEvidenceResult;
    finalCommitPromise?: Promise<FinalTranscriptEvidenceResult>;
    postCommitInputFingerprint?: string;
    postCommitPromise?: Promise<void>;
    final?: Readonly<{
      input: RayneoProductionFinalTranscriptPostCommit['input'];
      evidence: FinalTranscriptEvidenceResult;
      memory: MemoryConsumerContext;
    }>;
    realtimeReplyFingerprint?: string;
    realtimeReplyPromise?: Promise<RayneoGeneratedReply>;
    spokenCompletionPromise: Promise<RayneoGeneratedReply> | undefined;
    visualHeartbeatFingerprint?: string;
    visualHeartbeatPromise?: Promise<RayneoGeneratedReply>;
    completed: boolean;
  };
  const segmentStates = new Map<string, SegmentState>();
  const segmentOrder: string[] = [];
  let legacySegmentId: string | undefined;

  const segmentState = (segmentId: string): SegmentState => {
    if (!SEGMENT_ID.test(segmentId)) throw failure('RAYNEO_PRODUCTION_SEGMENT_INVALID');
    let state = segmentStates.get(segmentId);
    if (state === undefined) {
      state = { completed: false, spokenCompletionPromise: undefined };
      segmentStates.set(segmentId, state);
      segmentOrder.push(segmentId);
    }
    return state;
  };

  const pruneSegments = (): void => {
    while (segmentStates.size > MAX_ACTIVE_SEGMENT_STATES) {
      const removableIndex = segmentOrder.findIndex((segmentId) =>
        segmentId !== legacySegmentId && segmentStates.get(segmentId)?.completed === true);
      if (removableIndex < 0) return;
      const [segmentId] = segmentOrder.splice(removableIndex, 1);
      if (segmentId !== undefined) segmentStates.delete(segmentId);
    }
  };
  const completion = new Promise<string>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Keep a terminal close/failure observable to consumers without producing an
  // unhandled rejection when a turn never reached its model waiters.
  void completion.catch(() => undefined);

  const assertOpen = (): void => {
    if (closed) throw failure('RAYNEO_PRODUCTION_TURN_CLOSED');
  };

  const resolveBinding = async (observedAt: string): Promise<RayneoFinalTranscriptOwnerBinding> => {
    assertOpen();
    let resolved: RayneoFinalTranscriptOwnerBinding | undefined;
    try {
      resolved = await ownerBindingResolver.resolve({
        sessionId: binding.sessionId,
        deviceId: binding.deviceId,
        clientInstanceId: binding.clientInstanceId,
        observedAt,
      });
    } catch (error) {
      throw Object.assign(failure('RAYNEO_PRODUCTION_BINDING_UNAVAILABLE'), { cause: error });
    }
    if (resolved === undefined) throw failure('RAYNEO_PRODUCTION_BINDING_UNAVAILABLE');
    const copied = copyBinding(resolved);
    if (activeBinding !== undefined && !bindingMatches(activeBinding, copied)) {
      throw failure('RAYNEO_PRODUCTION_BINDING_DRIFT');
    }
    activeBinding ??= copied;
    return activeBinding;
  };

  const maybeStart = (): void => {
    if (started || final === undefined || closed ||
        visual === undefined && visualIssuePromise !== undefined) return;
    started = true;
    const visualInput = visual;
    const finalInput = final;
    void (async () => {
      const recall = renderedMemoryContext(finalInput.memory);
      const transcriptText = `[${finalInput.input.speakerLabel}] ${finalInput.input.transcript}`;
      const contextParts: Qwen38ChatMessage['content'][] = [
        { type: 'text', text: `当前最终发言（speaker=${finalInput.input.speakerLabel}）：${transcriptText}` },
        ...(recall.length === 0 ? [] : [{ type: 'text', text: `记忆召回上下文：\n${recall}` }]),
        ...(visualInput === undefined ? [] : [
          { type: 'text' as const, text: `视觉上下文（${refKey(visualInput.ref)}）：` },
          Object.freeze({
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${visualInput.bytes.toString('base64')}` },
          }),
        ]),
      ];
      const request: Qwen38ChatRequest = Object.freeze({
        messages: Object.freeze([
          Object.freeze({
            role: 'system' as const,
            content: '只用简体中文回复眼镜用户，最多两句短句；具体、简洁；只返回回复，不要前缀。',
          }),
          Object.freeze({ role: 'user' as const, content: Object.freeze(contextParts) }),
        ]),
        maxTokens: 48,
        temperature: 0,
      });
      const result = await provider.complete(request, turnAbort.signal);
      return rayneoReplyText(result.text);
    })().then(
      (value) => resolveCompletion?.(value),
      (error: unknown) => rejectCompletion?.(error),
    );
  };

  const issueVisual = async (jpeg: Buffer, frame?: RayneoVisualModelFrame): Promise<T11BCanonicalRef> => {
    assertOpen();
    if (jpeg.byteLength === 0 || jpeg.byteLength > MAX_VISUAL_BYTES) throw failure('RAYNEO_PRODUCTION_VISUAL_BYTES_INVALID');
    const visualFrame = validateVisualFrame(frame);
    const jpegSha256 = bytesSha256(jpeg);
    const visualIdentity = sha256({
      frameId: visualFrame.frameId,
      capturedAt: visualFrame.capturedAt,
      width: visualFrame.width,
      height: visualFrame.height,
      jpegSha256,
    });
    if (visual !== undefined) {
      if (visualIssueFingerprint !== visualIdentity || visual.sha256 !== jpegSha256) {
        throw failure('RAYNEO_PRODUCTION_VISUAL_IDEMPOTENCY_CONFLICT');
      }
      return visual.ref;
    }
    if (visualIssueFingerprint !== undefined) {
      if (visualIssueFingerprint !== visualIdentity || visualIssuePromise === undefined) {
        throw failure('RAYNEO_PRODUCTION_VISUAL_IDEMPOTENCY_CONFLICT');
      }
      return visualIssuePromise;
    }
    visualIssueFingerprint = visualIdentity;
    const ownedJpeg = cloneBytes(jpeg);
    const fingerprint = sha256({
      domain: 'paios.rayneo.production.visual-source-media.v1',
      runId: binding.runId,
      sessionId: binding.sessionId,
      deviceId: binding.deviceId,
      clientInstanceId: binding.clientInstanceId,
      captureId: visualFrame.frameId,
      capturedAt: visualFrame.capturedAt,
      width: visualFrame.width,
      height: visualFrame.height,
      jpegSha256,
    });
    visualIssuePromise = (async (): Promise<T11BCanonicalRef> => {
      try {
        const owner = await resolveBinding(visualFrame.capturedAt);
        const receipt: SourceVisualIssueReceipt = await config.sourceMedia.issueVisualWithReceipt(Object.freeze({
          // canonicalDeviceId is a T02 final-evidence identity and is not part
          // of the T13 visual-source contract; keep raw device provenance below.
          userId: owner.userId,
          realtimeSessionRef: owner.realtimeSessionRef,
          continuityId: owner.continuityId,
          purpose: owner.purpose,
          sessionId: binding.sessionId,
          deviceId: binding.deviceId,
          clientInstanceId: binding.clientInstanceId,
          captureId: visualFrame.frameId,
          capturedAt: visualFrame.capturedAt,
          media: Object.freeze({
            format: 'image/jpeg' as const,
            width: visualFrame.width,
            height: visualFrame.height,
            bytes: ownedJpeg,
            sha256: jpegSha256,
          }),
          idempotencyKey: `rayneo-visual-source-media:${fingerprint}`,
          fingerprint,
        }));
        const ref = validateRef(receipt.artifactVersionRef, ['ArtifactVersion'], 'RAYNEO_PRODUCTION_VISUAL_REFERENCE_INVALID');
        const sourceRef = validateRef(receipt.sourceArtifactRef, ['SourceArtifact'], 'RAYNEO_PRODUCTION_VISUAL_SOURCE_REFERENCE_INVALID');
        if (receipt.contentSha256 !== jpegSha256 || receipt.bytes !== ownedJpeg.byteLength ||
            receipt.mediaKind !== 'visual' || receipt.captureId !== visualFrame.frameId ||
            receipt.capturedAt !== visualFrame.capturedAt || receipt.format !== 'image/jpeg' ||
            receipt.width !== visualFrame.width || receipt.height !== visualFrame.height) {
          throw failure('RAYNEO_PRODUCTION_VISUAL_RECEIPT_INVALID');
        }
        const read: SourceVisualReadResult = await config.sourceMedia.readVisual({
          ref,
          expectedContentSha256: jpegSha256,
        });
        const readRef = validateRef(read.artifactVersionRef, ['ArtifactVersion'], 'RAYNEO_PRODUCTION_VISUAL_READBACK_REFERENCE_INVALID');
        const readSourceRef = validateRef(read.sourceArtifactRef, ['SourceArtifact'], 'RAYNEO_PRODUCTION_VISUAL_READBACK_SOURCE_INVALID');
        const readBytes = Buffer.from(read.bytes);
        try {
          if (refKey(readRef) !== refKey(ref) || refKey(readSourceRef) !== refKey(sourceRef) ||
              read.contentSha256 !== jpegSha256 || readBytes.byteLength !== ownedJpeg.byteLength ||
              !readBytes.equals(ownedJpeg) || read.mediaKind !== 'visual' ||
              read.captureId !== visualFrame.frameId || read.capturedAt !== visualFrame.capturedAt ||
              read.format !== 'image/jpeg' || read.width !== visualFrame.width || read.height !== visualFrame.height) {
            throw failure('RAYNEO_PRODUCTION_VISUAL_READBACK_INVALID');
          }
        } finally {
          readBytes.fill(0);
        }
        visual = Object.freeze({ bytes: cloneBytes(ownedJpeg), sha256: jpegSha256, ref });
        maybeStart();
        return ref;
      } finally {
        ownedJpeg.fill(0);
        if (visual === undefined) maybeStart();
      }
    })();
    return visualIssuePromise;
  };

  const finalTranscriptAuthority = (() => {
    const finalizeWithEvidence = async (
      input: RayneoFinalTranscriptAuthorityInput,
    ): Promise<FinalTranscriptEvidenceResult> => {
      assertOpen();
      const state = segmentState(input.segmentId);
      const resolvedBinding = await resolveBinding(input.observedAt);
      const fingerprint = authorityInputFingerprint(input, resolvedBinding.canonicalDeviceId);
      if (state.finalInputFingerprint !== undefined) {
        if (state.finalInputFingerprint !== fingerprint || state.finalCommitPromise === undefined) {
          throw failure('RAYNEO_PRODUCTION_FINAL_IDEMPOTENCY_CONFLICT');
        }
        return state.finalCommitPromise;
      }
      state.finalInputFingerprint = fingerprint;
      state.finalPostCommitInputFingerprint = postCommitFingerprint(
        authorityPostCommitInput(input), resolvedBinding.canonicalDeviceId,
      );
      legacySegmentId ??= input.segmentId;
      state.finalCommitPromise = (async (): Promise<FinalTranscriptEvidenceResult> => {
        let captured: FinalTranscriptEvidenceResult | undefined;
        const capturingService: FinalTranscriptEvidenceService = Object.freeze({
          finalize: async (evidenceInput: FinalTranscriptEvidenceInput) => {
            const result = await config.finalTranscript.finalize(evidenceInput);
            captured = result;
            return result;
          },
        });
        const authority = createRayneoFinalTranscriptAuthority({
          ownerBinding: { resolve: async () => resolvedBinding },
          sourceMedia: config.sourceMedia,
          finalTranscript: capturingService,
        });
        await authority.finalize(input);
        if (captured === undefined) throw failure('RAYNEO_PRODUCTION_FINAL_EVIDENCE_MISSING');
        state.finalEvidence = captured;
        if (input.segmentId === legacySegmentId) {
          finalInputFingerprint = state.finalInputFingerprint;
          finalPostCommitInputFingerprint = state.finalPostCommitInputFingerprint;
          finalCommitPromise = state.finalCommitPromise;
          finalEvidence = captured;
        }
        return captured;
      })();
      return state.finalCommitPromise;
    };
    return Object.freeze({
      finalize: async (input: RayneoFinalTranscriptAuthorityInput) => {
        await finalizeWithEvidence(input);
      },
      finalizeWithEvidence,
    });
  })();

  const afterFinalTranscript = async (post: RayneoProductionFinalTranscriptPostCommit): Promise<void> => {
    assertOpen();
    const state = segmentState(post.input.segmentId);
    const evidenceRef: CanonicalObjectVersionRef = assertCanonicalObjectVersionRef(post.evidence.evidenceRef);
    if (evidenceRef.refType !== 'FinalTranscriptEvidence' || state.finalEvidence === undefined ||
        state.finalEvidence.evidenceRef.refType !== 'FinalTranscriptEvidence' ||
        refKey(evidenceRef as unknown as T11BCanonicalRef) !== refKey(state.finalEvidence.evidenceRef)) {
      throw failure('RAYNEO_PRODUCTION_FINAL_EVIDENCE_REFERENCE_INVALID');
    }
    const owner = await resolveBinding(post.input.observedAt);
    const fingerprint = postCommitFingerprint(post.input, owner.canonicalDeviceId);
    if (state.finalInputFingerprint === undefined || state.finalCommitPromise === undefined ||
        state.finalPostCommitInputFingerprint !== fingerprint) {
      throw failure('RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH');
    }
    if (state.postCommitInputFingerprint !== undefined) {
      if (state.postCommitInputFingerprint !== fingerprint || state.postCommitPromise === undefined) {
        throw failure('RAYNEO_PRODUCTION_POST_COMMIT_CONFLICT');
      }
      return state.postCommitPromise;
    }
    state.postCommitInputFingerprint = fingerprint;
    state.postCommitPromise = (async (): Promise<void> => {
      // A finalized device transcript is evidence, not an authenticated memory command.
      // Explicit L3 writes belong to the Hermes tool path and its authorization service.
      const memory = await config.memory.recallForAnswerContext(Object.freeze({
        asOf: post.input.observedAt,
        maxItems: config.recall.maxItems,
        maxContentBytes: config.recall.maxContentBytes,
      }));
        state.final = Object.freeze({ input: post.input, evidence: post.evidence, memory });
        if (post.input.segmentId === legacySegmentId) {
        postCommitInputFingerprint = state.postCommitInputFingerprint;
          postCommitPromise = state.postCommitPromise;
          final = state.final;
        }
    })();
    return state.postCommitPromise;
  };

  const awaitCompletion = (signal: AbortSignal): Promise<string> => {
    assertOpen();
    maybeStart();
    return waitWithAbort(completion, signal);
  };

  const generateVisualOnlyReply = (capturedAt: string, signal: AbortSignal): Promise<string> => {
    assertOpen();
    const visualInput = visual;
    if (visualInput === undefined || visualIssueFingerprint === undefined) {
      throw failure('RAYNEO_PRODUCTION_VISUAL_NOT_READY');
    }
    const fingerprint = sha256({
      domain: 'paios.rayneo.production.visual-only-reply.v1',
      visualIssueFingerprint,
      capturedAt,
      visualRef: refKey(visualInput.ref),
    });
    if (visualOnlyFingerprint !== undefined) {
      if (visualOnlyFingerprint !== fingerprint || visualOnlyPromise === undefined) {
        throw failure('RAYNEO_PRODUCTION_VISUAL_ONLY_CONFLICT');
      }
      return waitWithAbort(visualOnlyPromise, signal);
    }
    visualOnlyFingerprint = fingerprint;
    visualOnlyPromise = (async (): Promise<string> => {
      const memory = await config.memory.recallForAnswerContext(Object.freeze({
        asOf: capturedAt,
        maxItems: config.recall.maxItems,
        maxContentBytes: config.recall.maxContentBytes,
      }));
      const recall = renderedMemoryContext(memory);
      const result = await provider.complete(Object.freeze({
        messages: Object.freeze([
          Object.freeze({
            role: 'system' as const,
            content: '你是眼镜上的实时私人助理。只用简体中文最多两句描述可观察画面；不要推理过程，不要读心，不要前缀。',
          }),
          Object.freeze({
            role: 'user' as const,
            content: Object.freeze([
              { type: 'text' as const, text: '当前窗口没有可靠语音。请根据画面说明正在发生什么，并明确不确定项。' },
              { type: 'text' as const, text: `视觉来源：${refKey(visualInput.ref)}` },
              ...(recall.length === 0 ? [] : [{ type: 'text' as const, text: `记忆召回上下文：\n${recall}` }]),
              Object.freeze({
                type: 'image_url' as const,
                image_url: Object.freeze({
                  url: `data:image/jpeg;base64,${visualInput.bytes.toString('base64')}`,
                }),
              }),
            ]),
          }),
        ]),
        maxTokens: 96,
        temperature: 0,
      }), signal);
      return rayneoReplyText(result.text);
    })();
    return waitWithAbort(visualOnlyPromise, signal);
  };

  const visualModelProvider = async (
    jpeg: Buffer,
    signal: AbortSignal,
    frame?: RayneoVisualModelFrame,
  ): Promise<RayneoVisualModelResult> => {
    const visualFrame = validateVisualFrame(frame);
    await issueVisual(jpeg, visualFrame);
    const text = final === undefined
      ? await generateVisualOnlyReply(visualFrame.capturedAt, signal)
      : await awaitCompletion(signal);
    return Object.freeze({ text, provider: 'ollama_openai_compatible', model: config.qwenProfile.model });
  };

  const generateSegmentReply: RayneoProductionTurn['generateSegmentReply'] = async (
    segmentId: string,
    transcript: string,
    speakerLabel: string,
    signal: AbortSignal,
  ): Promise<RayneoGeneratedReply> => {
    assertOpen();
    const state = segmentState(segmentId);
    if (state.final === undefined || state.final.input.transcript !== transcript ||
        state.final.input.speakerLabel !== speakerLabel) {
      throw failure('RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH');
    }
    const decision = await conversationClaim({
      inputKind: 'audio',
      inputId: segmentId,
      userText: transcript,
      finalTranscriptEvidenceRef: state.final.evidence.evidenceRef as unknown as T11BCanonicalRef,
    });
    if (decision.kind === 'replay') {
      if (decision.receipt === undefined) throw failure('RAYNEO_PRODUCTION_CONVERSATION_RECEIPT_INVALID');
      return await withSpeech(decision.receipt.assistant_text, signal);
    }
    if (decision.kind !== 'claimed') throw failure(`RAYNEO_PRODUCTION_CONVERSATION_${decision.kind.toUpperCase()}`);
    const toggle = parseNegotiationToggle(transcript);
    if (toggle !== undefined) {
      return await withSpeech(toggle === 'on' ? NEGOTIATION_ON_REPLY : NEGOTIATION_OFF_REPLY, signal);
    }
    const negotiationAtStart = negotiationMode === 'negotiation';
    if (negotiationAtStart) {
      const previous = negotiationFacts.at(-1);
      stageNegotiation(segmentId, { fact: Object.freeze({
        speakerLabel,
        startMs: state.final.input.startMs,
        endMs: state.final.input.endMs,
        durationMs: state.final.input.endMs - state.final.input.startMs,
        gapMs: previous === undefined ? state.final.input.startMs : state.final.input.startMs - previous.endMs,
        diarizationStatus: state.final.input.diarizationStatus,
        transcript,
      }) });
    }
    if (state.spokenCompletionPromise === undefined) {
      const promise = (async () => {
        try {
          const recall = renderedMemoryContext(state.final!.memory);
           const content: Qwen38ChatMessage['content'][] = [
             ...typedHistory.map((message) => message.content),
             { type: 'text', text: `当前最终发言（speaker=${speakerLabel}）：[${speakerLabel}] ${transcript}` },
            ...(negotiationAtStart ? [{ type: 'text' as const, text: negotiationFactText([
              ...negotiationFacts,
              ...(pendingNegotiation.get(segmentId)?.fact === undefined ? [] : [pendingNegotiation.get(segmentId)!.fact!]),
            ].slice(-6)) }] : []),
            ...(recall.length === 0 ? [] : [{ type: 'text', text: `记忆召回上下文：\n${recall}` }]),
          ];
           const result = await provider.complete(Object.freeze({
            messages: Object.freeze([
              Object.freeze({
                role: 'system' as const,
                content: negotiationAtStart ? NEGOTIATION_SYSTEM_PROMPT : '只用简体中文回复眼镜用户，最多两句短句；具体、简洁；只返回回复，不要前缀。',
              }),
              Object.freeze({ role: 'user' as const, content: Object.freeze(content) }),
            ]),
            maxTokens: 48,
            temperature: 0,
          }), signal);
           const replyText = negotiationAtStart ? negotiationReply(result.text) : rayneoReplyText(result.text);
           const spoken = await withSpeech(replyText, signal);
           if (negotiationAtStart) stageNegotiation(segmentId, { history: { userText: transcript, assistantText: replyText } });
           else appendHistory(transcript, replyText);
           return spoken;
        } catch (error) {
          await releaseConversationTurn(segmentId).catch(() => undefined);
          throw error;
        } finally {
          state.completed = true;
          pruneSegments();
        }
      })();
      state.spokenCompletionPromise = promise;
      void promise.catch(() => {
        if (state.spokenCompletionPromise === promise) state.spokenCompletionPromise = undefined;
      });
    }
    return await waitWithAbort(state.spokenCompletionPromise, signal);
  };

  const streamTypedReply: RayneoProductionTurn['streamTypedReply'] = async function* (input, signal) {
    assertOpen();
    const decision = await conversationClaim({ inputKind: 'typed', inputId: input.promptId, userText: input.text });
    if (decision.kind === 'replay') {
      if (decision.receipt === undefined) throw failure('RAYNEO_PRODUCTION_CONVERSATION_RECEIPT_INVALID');
      yield { kind: 'final', text: decision.receipt.assistant_text, finishReason: 'stop' };
      return;
    }
    if (decision.kind !== 'claimed') throw failure(`RAYNEO_PRODUCTION_CONVERSATION_${decision.kind.toUpperCase()}`);
    const toggle = parseNegotiationToggle(input.text);
    if (toggle !== undefined) {
      yield { kind: 'final', text: toggle === 'on' ? NEGOTIATION_ON_REPLY : NEGOTIATION_OFF_REPLY, finishReason: 'stop' };
      return;
    }
    const negotiationAtStart = negotiationMode === 'negotiation';
    const messages = Object.freeze([
      Object.freeze({
        role: 'system' as const,
        content: negotiationAtStart ? NEGOTIATION_SYSTEM_PROMPT : '只用简体中文回复眼镜用户，最多两句短句；具体、简洁；只返回回复，不要前缀。',
      }),
      ...typedHistory,
      Object.freeze({ role: 'user' as const, content: input.text }),
    ]);
    let accumulated = '';
    let terminal = false;
    for await (const event of provider.stream(Object.freeze({ messages, maxTokens: 512 }), signal)) {
      if (signal.aborted || closed) throw failure('RAYNEO_PRODUCTION_TURN_ABORTED');
      if (event.kind === 'delta' || event.kind === 'final') {
        if (typeof event.text !== 'string' || event.text.length === 0) throw failure('RAYNEO_PRODUCTION_TYPED_REPLY_INVALID');
          accumulated = event.kind === 'final'
            ? (negotiationAtStart ? negotiationReply(event.text) : event.text)
            : accumulated + event.text;
        if (event.kind === 'final') {
          terminal = true;
          if (negotiationAtStart) stageNegotiation(input.promptId, { history: { userText: input.text, assistantText: accumulated } });
          else appendHistory(input.text, accumulated);
        }
      }
      yield event;
    }
    if (!terminal || accumulated.length === 0) throw failure('RAYNEO_PRODUCTION_TYPED_REPLY_INCOMPLETE');
  };

  const generateReply: RayneoProductionTurn['generateReply'] = async (
    transcript: string,
    speakerLabel: string,
    signal: AbortSignal,
  ): Promise<RayneoGeneratedReply> => {
    assertOpen();
    if (legacySegmentId === undefined || final === undefined ||
        final.input.transcript !== transcript || final.input.speakerLabel !== speakerLabel) {
      throw failure('RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH');
    }
    maybeStart();
    spokenCompletionPromise ??= (async () => await withSpeech(await completion, turnAbort.signal))();
    return await waitWithAbort(spokenCompletionPromise, signal);
  };

  const issueRealtimeVisual = async (
    segmentId: string,
    sample: RayneoRealtimeMultimodalReplyInput['videoSamples'][number],
    index: number,
  ): Promise<Readonly<{
    bytes: Buffer;
    ref: T11BCanonicalRef;
    captureId: string;
    capturedAt: string;
    format: SourceVisualMediaFormat;
    width: number;
    height: number;
  }>> => {
    const format: SourceVisualMediaFormat = sample.mimeType;
    const capturedAt = new Date(sample.observedAtMs).toISOString();
    const contentSha256 = bytesSha256(sample.bytes);
    const captureId = `rayneo_frame_${sha256({
      domain: 'paios.rayneo.production.realtime-visual-capture.v1',
      segmentId, index, observedAtMs: sample.observedAtMs, contentSha256,
    }).slice(0, 20)}`;
    const owner = await resolveBinding(capturedAt);
    const fingerprint = sha256({
      domain: 'paios.rayneo.production.realtime-visual-source-media.v1',
      runId: binding.runId,
      sessionId: binding.sessionId,
      deviceId: binding.deviceId,
      clientInstanceId: binding.clientInstanceId,
      segmentId,
      captureId,
      capturedAt,
      width: sample.width,
      height: sample.height,
      format,
      contentSha256,
    });
    const owned = Buffer.from(sample.bytes);
    try {
      const receipt = await config.sourceMedia.issueVisualWithReceipt(Object.freeze({
        userId: owner.userId,
        realtimeSessionRef: owner.realtimeSessionRef,
        continuityId: owner.continuityId,
        purpose: owner.purpose,
        sessionId: binding.sessionId,
        deviceId: binding.deviceId,
        clientInstanceId: binding.clientInstanceId,
        captureId,
        capturedAt,
        media: Object.freeze({
          format,
          width: sample.width,
          height: sample.height,
          bytes: owned,
          sha256: contentSha256,
        }),
        idempotencyKey: `rayneo-realtime-visual-source-media:${fingerprint}`,
        fingerprint,
      }));
      const ref = validateRef(
        receipt.artifactVersionRef, ['ArtifactVersion'], 'RAYNEO_PRODUCTION_VISUAL_REFERENCE_INVALID',
      );
      const sourceRef = validateRef(
        receipt.sourceArtifactRef, ['SourceArtifact'], 'RAYNEO_PRODUCTION_VISUAL_SOURCE_REFERENCE_INVALID',
      );
      if (receipt.contentSha256 !== contentSha256 || receipt.bytes !== owned.byteLength ||
          receipt.mediaKind !== 'visual' || receipt.captureId !== captureId ||
          receipt.capturedAt !== capturedAt || receipt.format !== format ||
          receipt.width !== sample.width || receipt.height !== sample.height) {
        throw failure('RAYNEO_PRODUCTION_VISUAL_RECEIPT_INVALID');
      }
      const read = await config.sourceMedia.readVisual({ ref, expectedContentSha256: contentSha256 });
      const readRef = validateRef(
        read.artifactVersionRef, ['ArtifactVersion'], 'RAYNEO_PRODUCTION_VISUAL_READBACK_REFERENCE_INVALID',
      );
      const readSourceRef = validateRef(
        read.sourceArtifactRef, ['SourceArtifact'], 'RAYNEO_PRODUCTION_VISUAL_READBACK_SOURCE_INVALID',
      );
      const readBytes = Buffer.from(read.bytes);
      try {
        if (refKey(readRef) !== refKey(ref) || refKey(readSourceRef) !== refKey(sourceRef) ||
            read.contentSha256 !== contentSha256 || !readBytes.equals(owned) ||
            read.mediaKind !== 'visual' || read.captureId !== captureId ||
            read.capturedAt !== capturedAt || read.format !== format ||
            read.width !== sample.width || read.height !== sample.height) {
          throw failure('RAYNEO_PRODUCTION_VISUAL_READBACK_INVALID');
        }
      } finally {
        readBytes.fill(0);
      }
      return Object.freeze({
        bytes: Buffer.from(owned), ref, captureId, capturedAt, format,
        width: sample.width, height: sample.height,
      });
    } finally {
      owned.fill(0);
    }
  };

  const generateRealtimeReply = async (
    input: RayneoRealtimeMultimodalReplyInput,
    signal: AbortSignal,
  ): Promise<RayneoGeneratedReply> => {
    assertOpen();
    if (!isPlainRecord(input) ||
        Object.keys(input).sort().join(',') !== 'endMs,segmentId,speakerLabel,startMs,transcript,videoSamples' ||
        !SEGMENT_ID.test(String(input.segmentId)) || !Number.isSafeInteger(input.startMs) ||
        !Number.isSafeInteger(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs ||
        typeof input.speakerLabel !== 'string' || typeof input.transcript !== 'string' ||
        !Array.isArray(input.videoSamples) || input.videoSamples.length < 1 || input.videoSamples.length > 2) {
      throw failure('RAYNEO_PRODUCTION_REALTIME_REPLY_INVALID');
    }
    const state = segmentStates.get(input.segmentId);
    if (state?.final === undefined || state.final.input.segmentId !== input.segmentId ||
        state.final.input.startMs !== input.startMs || state.final.input.endMs !== input.endMs ||
        state.final.input.speakerLabel !== input.speakerLabel || state.final.input.transcript !== input.transcript) {
      throw failure('RAYNEO_PRODUCTION_FINAL_TURN_MISMATCH');
    }
    const finalState = state.final;
    const negotiationAtStart = negotiationMode === 'negotiation';
    let previousObservedAt = -1;
    const sampleFingerprints: Array<Readonly<Record<string, unknown>>> = [];
    for (const rawSample of input.videoSamples) {
      if (!isPlainRecord(rawSample) ||
          Object.keys(rawSample).sort().join(',') !== 'bytes,height,mimeType,observedAtMs,width') {
        throw failure('RAYNEO_PRODUCTION_REALTIME_VISUAL_INVALID');
      }
      const sample = rawSample as unknown as RayneoRealtimeMultimodalReplyInput['videoSamples'][number];
      if (
          sample.mimeType !== 'image/png' || !(sample.bytes instanceof Uint8Array) ||
          sample.bytes.byteLength < 1 || sample.bytes.byteLength > MAX_VISUAL_BYTES ||
          !Number.isSafeInteger(sample.width) || !Number.isSafeInteger(sample.height) ||
          sample.width < 1 || sample.height < 1 || sample.width > 640 || sample.height > 640 ||
          !Number.isSafeInteger(sample.observedAtMs) || sample.observedAtMs <= previousObservedAt ||
          sample.observedAtMs < binding.openedAt + input.startMs - 2_000 ||
          sample.observedAtMs > binding.openedAt + input.endMs + 2_000 ||
          sample.observedAtMs < binding.openedAt || sample.observedAtMs >= binding.expiresAt) {
        throw failure('RAYNEO_PRODUCTION_REALTIME_VISUAL_INVALID');
      }
      previousObservedAt = sample.observedAtMs;
      sampleFingerprints.push(Object.freeze({
        observedAtMs: sample.observedAtMs,
        width: sample.width,
        height: sample.height,
        mimeType: sample.mimeType,
        sha256: bytesSha256(sample.bytes),
      }));
    }
    const fingerprint = sha256({
      domain: 'paios.rayneo.production.realtime-reply.v1',
      segmentId: input.segmentId,
      startMs: input.startMs,
      endMs: input.endMs,
      speakerLabel: input.speakerLabel,
      transcript: input.transcript,
      samples: sampleFingerprints,
    });
    if (state.realtimeReplyFingerprint !== undefined) {
      if (state.realtimeReplyFingerprint !== fingerprint || state.realtimeReplyPromise === undefined) {
        throw failure('RAYNEO_PRODUCTION_REALTIME_REPLY_CONFLICT');
      }
      return waitWithAbort(state.realtimeReplyPromise, signal);
    }
    state.realtimeReplyFingerprint = fingerprint;
    state.realtimeReplyPromise = (async (): Promise<RayneoGeneratedReply> => {
      try {
        if (input.segmentId === legacySegmentId && visual !== undefined) {
          const decision = await conversationClaim({
            inputKind: 'audio',
            inputId: input.segmentId,
            userText: input.transcript,
            finalTranscriptEvidenceRef: finalState.evidence.evidenceRef as unknown as T11BCanonicalRef,
            sourceVisualRefs: [visual.ref],
          });
          if (decision.kind === 'replay') {
            if (decision.receipt === undefined) throw failure('RAYNEO_PRODUCTION_CONVERSATION_RECEIPT_INVALID');
            return await withSpeech(decision.receipt.assistant_text, signal);
          }
          if (decision.kind !== 'claimed') throw failure(`RAYNEO_PRODUCTION_CONVERSATION_${decision.kind.toUpperCase()}`);
          return await withSpeech(await completion, signal);
        }
        const issued: Array<Awaited<ReturnType<typeof issueRealtimeVisual>>> = [];
        try {
          for (let index = 0; index < input.videoSamples.length; index += 1) {
            issued.push(await issueRealtimeVisual(input.segmentId, input.videoSamples[index]!, index));
          }
          const decision = await conversationClaim({
            inputKind: 'audio',
            inputId: input.segmentId,
            userText: input.transcript,
            finalTranscriptEvidenceRef: finalState.evidence.evidenceRef as unknown as T11BCanonicalRef,
            sourceVisualRefs: issued.map((item) => item.ref),
          });
          if (decision.kind === 'replay') {
            if (decision.receipt === undefined) throw failure('RAYNEO_PRODUCTION_CONVERSATION_RECEIPT_INVALID');
            return await withSpeech(decision.receipt.assistant_text, signal);
          }
          if (decision.kind !== 'claimed') throw failure(`RAYNEO_PRODUCTION_CONVERSATION_${decision.kind.toUpperCase()}`);
          const recall = renderedMemoryContext(state.final!.memory);
          const content: Qwen38ChatMessage['content'][] = [
            { type: 'text', text: `当前最终发言（speaker=${input.speakerLabel}）：[${input.speakerLabel}] ${input.transcript}` },
            ...(negotiationAtStart ? [{ type: 'text' as const, text: negotiationFactText(negotiationFacts) }] : []),
            { type: 'text', text: `同窗视觉来源：${issued.map((item) => refKey(item.ref)).join(',')}` },
            ...(recall.length === 0 ? [] : [{ type: 'text', text: `记忆召回上下文：\n${recall}` }]),
            ...issued.map((item) => Object.freeze({
              type: 'image_url' as const,
              image_url: Object.freeze({ url: `data:${item.format};base64,${item.bytes.toString('base64')}` }),
            })),
          ];
          const result = await provider.complete(Object.freeze({
            messages: Object.freeze([
              Object.freeze({
                role: 'system' as const,
                content: negotiationAtStart ? NEGOTIATION_SYSTEM_PROMPT : '你是眼镜上的实时私人助理。只用简体中文最多两句：说明看到、听到及其对应；不要推理过程，不要读心，不要前缀。',
              }),
              Object.freeze({ role: 'user' as const, content: Object.freeze(content) }),
            ]),
            maxTokens: 96,
            temperature: 0,
          }), signal);
          const replyText = negotiationAtStart ? negotiationReply(result.text) : rayneoReplyText(result.text);
          const spoken = await withSpeech(replyText, signal);
          if (negotiationAtStart) stageNegotiation(input.segmentId, { history: {
            userText: `视觉来源：${issued.map((item) => refKey(item.ref)).join(',')}`,
            assistantText: replyText,
          } });
          else appendHistory(`视觉来源：${issued.map((item) => refKey(item.ref)).join(',')}`, replyText);
          return spoken;
        } finally {
          for (const item of issued) item.bytes.fill(0);
        }
      } finally {
        state.completed = true;
        pruneSegments();
      }
    })();
    return waitWithAbort(state.realtimeReplyPromise, signal);
  };

  const generateVisualHeartbeatReply = async (
    input: RayneoRealtimeVisualHeartbeatInput,
    signal: AbortSignal,
  ): Promise<RayneoGeneratedReply> => {
    assertOpen();
    const negotiationAtStart = negotiationMode === 'negotiation';
    if (!isPlainRecord(input) ||
        Object.keys(input).sort().join(',') !== 'endMs,segmentId,startMs,videoSamples' ||
        !SEGMENT_ID.test(String(input.segmentId)) || !Number.isSafeInteger(input.startMs) ||
        !Number.isSafeInteger(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs ||
        !Array.isArray(input.videoSamples) || input.videoSamples.length < 1 || input.videoSamples.length > 2) {
      throw failure('RAYNEO_PRODUCTION_VISUAL_HEARTBEAT_INVALID');
    }
    const state = segmentState(input.segmentId);
    let previousObservedAt = -1;
    const sampleFingerprints: Array<Readonly<Record<string, unknown>>> = [];
    for (const rawSample of input.videoSamples) {
      if (!isPlainRecord(rawSample) ||
          Object.keys(rawSample).sort().join(',') !== 'bytes,height,mimeType,observedAtMs,width') {
        throw failure('RAYNEO_PRODUCTION_REALTIME_VISUAL_INVALID');
      }
      const sample = rawSample as unknown as RayneoRealtimeVisualHeartbeatInput['videoSamples'][number];
      if (sample.mimeType !== 'image/png' || !(sample.bytes instanceof Uint8Array) ||
          sample.bytes.byteLength < 1 || sample.bytes.byteLength > MAX_VISUAL_BYTES ||
          !Number.isSafeInteger(sample.width) || !Number.isSafeInteger(sample.height) ||
          sample.width < 1 || sample.height < 1 || sample.width > 640 || sample.height > 640 ||
          !Number.isSafeInteger(sample.observedAtMs) || sample.observedAtMs <= previousObservedAt ||
          sample.observedAtMs < binding.openedAt + input.startMs - 2_000 ||
          sample.observedAtMs > binding.openedAt + input.endMs + 2_000 ||
          sample.observedAtMs < binding.openedAt || sample.observedAtMs >= binding.expiresAt) {
        throw failure('RAYNEO_PRODUCTION_REALTIME_VISUAL_INVALID');
      }
      previousObservedAt = sample.observedAtMs;
      sampleFingerprints.push(Object.freeze({
        observedAtMs: sample.observedAtMs,
        width: sample.width,
        height: sample.height,
        mimeType: sample.mimeType,
        sha256: bytesSha256(sample.bytes),
      }));
    }
    const fingerprint = sha256({
      domain: 'paios.rayneo.production.visual-heartbeat.v1',
      segmentId: input.segmentId,
      startMs: input.startMs,
      endMs: input.endMs,
      samples: sampleFingerprints,
    });
    if (state.visualHeartbeatFingerprint !== undefined) {
      if (state.visualHeartbeatFingerprint !== fingerprint || state.visualHeartbeatPromise === undefined) {
        throw failure('RAYNEO_PRODUCTION_VISUAL_HEARTBEAT_CONFLICT');
      }
      return waitWithAbort(state.visualHeartbeatPromise, signal);
    }
    state.visualHeartbeatFingerprint = fingerprint;
    state.visualHeartbeatPromise = (async (): Promise<RayneoGeneratedReply> => {
      const issued: Array<Awaited<ReturnType<typeof issueRealtimeVisual>>> = [];
      try {
        for (let index = 0; index < input.videoSamples.length; index += 1) {
          issued.push(await issueRealtimeVisual(input.segmentId, input.videoSamples[index]!, index));
        }
        const decision = await conversationClaim({
          inputKind: 'visual',
          inputId: input.segmentId,
          sourceVisualRefs: issued.map((item) => item.ref),
        });
        if (decision.kind === 'replay') {
          if (decision.receipt === undefined) throw failure('RAYNEO_PRODUCTION_CONVERSATION_RECEIPT_INVALID');
          return await withSpeech(decision.receipt.assistant_text, signal);
        }
        if (decision.kind !== 'claimed') throw failure(`RAYNEO_PRODUCTION_CONVERSATION_${decision.kind.toUpperCase()}`);
        const asOf = new Date(input.videoSamples.at(-1)!.observedAtMs).toISOString();
        const memory = await config.memory.recallForAnswerContext(Object.freeze({
          asOf,
          maxItems: config.recall.maxItems,
          maxContentBytes: config.recall.maxContentBytes,
        }));
        const recall = renderedMemoryContext(memory);
        const content: Qwen38ChatMessage['content'][] = [
          { type: 'text', text: '当前窗口没有可靠语音。请根据连续画面说明正在发生什么，并明确不确定项。' },
          ...(negotiationAtStart ? [{ type: 'text' as const, text: negotiationFactText(negotiationFacts) }] : []),
          { type: 'text', text: `视觉来源：${issued.map((item) => refKey(item.ref)).join(',')}` },
          ...(recall.length === 0 ? [] : [{ type: 'text', text: `记忆召回上下文：\n${recall}` }]),
          ...issued.map((item) => Object.freeze({
            type: 'image_url' as const,
            image_url: Object.freeze({ url: `data:${item.format};base64,${item.bytes.toString('base64')}` }),
          })),
        ];
        const result = await provider.complete(Object.freeze({
          messages: Object.freeze([
            Object.freeze({
              role: 'system' as const,
              content: negotiationAtStart ? NEGOTIATION_SYSTEM_PROMPT : '你是眼镜上的实时私人助理。只用简体中文最多两句描述可观察画面；不要推理过程，不要读心，不要前缀。',
            }),
            Object.freeze({ role: 'user' as const, content: Object.freeze(content) }),
          ]),
          maxTokens: 96,
          temperature: 0,
        }), signal);
        const replyText = negotiationAtStart ? negotiationReply(result.text) : rayneoReplyText(result.text);
        const spoken = await withSpeech(replyText, signal);
        if (negotiationAtStart) stageNegotiation(input.segmentId, { history: {
          userText: `视觉窗口：${issued.map((item) => refKey(item.ref)).join(',')}`,
          assistantText: replyText,
        } });
        else appendHistory(`视觉窗口：${issued.map((item) => refKey(item.ref)).join(',')}`, replyText);
        return spoken;
      } finally {
        for (const item of issued) item.bytes.fill(0);
        state.completed = true;
        pruneSegments();
      }
    })();
    return waitWithAbort(state.visualHeartbeatPromise, signal);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    turnAbort.abort();
    rejectCompletion?.(failure('RAYNEO_PRODUCTION_TURN_CLOSED'));
    visual?.bytes.fill(0);
    visual = undefined;
    for (const [inputId, state] of conversationClaims) {
      if (!state.published && config.conversationTurn !== undefined && state.decision.kind === 'claimed') {
        await config.conversationTurn.postgres.releaseBeforePublish(state.claim).catch(() => undefined);
      }
      conversationClaims.delete(inputId);
    }
    pendingNegotiation.clear();
    negotiationFacts.length = 0;
    segmentStates.clear();
    segmentOrder.length = 0;
    if (ownsProvider) await provider.close?.();
  };

  return Object.freeze({
    finalTranscriptAuthority,
    visualModelProvider,
    generateReply,
    generateSegmentReply,
    streamTypedReply,
    generateRealtimeReply,
    generateVisualHeartbeatReply,
    completeConversationTurn,
    markIndeterminateConversationTurn,
    releaseConversationTurn,
    afterFinalTranscript,
    close,
  });
}

function assertBindingShape(binding: RayneoProductionTurnBinding): RayneoProductionTurnBinding {
  if (!isPlainRecord(binding) || Object.keys(binding).length !== 9 ||
      !exactString(binding.runId, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !exactString(binding.sessionId, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !exactString(binding.deviceId, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !exactString(binding.clientInstanceId, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !exactString(binding.replyId, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !exactString(binding.frameId, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !exactString(binding.receiptIdempotencyKey, 'RAYNEO_PRODUCTION_TURN_BINDING_INVALID') ||
      !Number.isSafeInteger(binding.openedAt) || !Number.isSafeInteger(binding.expiresAt) ||
      binding.expiresAt <= binding.openedAt) {
    throw failure('RAYNEO_PRODUCTION_TURN_BINDING_INVALID');
  }
  return Object.freeze({ ...binding });
}

function assertConfiguration(options: RayneoProductionCompositionOptions): Readonly<RayneoProductionCompositionOptions> {
  if (!isPlainRecord(options) || !isPlainRecord(options.ownerBinding) ||
      typeof options.ownerBinding.resolve !== 'function' || !isPlainRecord(options.sourceMedia) ||
      typeof options.sourceMedia.issue !== 'function' || typeof options.sourceMedia.issueVisual !== 'function' ||
      typeof options.sourceMedia.issueVisualWithReceipt !== 'function' || typeof options.sourceMedia.readVisual !== 'function' ||
      !isPlainRecord(options.finalTranscript) || typeof options.finalTranscript.finalize !== 'function' ||
      !isPlainRecord(options.finalTranscriptEvidenceReader) ||
      typeof options.finalTranscriptEvidenceReader.read !== 'function' || !isPlainRecord(options.memory) ||
      typeof options.memory.rememberExplicit !== 'function' || typeof options.memory.recallForAnswerContext !== 'function' ||
      options.conversationTurn !== undefined &&
      (typeof options.conversationTurn !== 'object' || options.conversationTurn === null ||
       typeof options.conversationTurn.binding !== 'function' ||
       typeof options.conversationTurn.postgres?.beginClaim !== 'function' ||
       typeof options.conversationTurn.postgres.commitCompletedAfterPublish !== 'function' ||
       typeof options.conversationTurn.postgres.markIndeterminate !== 'function' ||
       typeof options.conversationTurn.postgres.releaseBeforePublish !== 'function' ||
       options.conversationTurn.restored !== undefined &&
       (!Array.isArray(options.conversationTurn.restored) || options.conversationTurn.restored.length > 4))) {
    throw failure('RAYNEO_PRODUCTION_COMPOSITION_INVALID');
  }
  const sensitivity = validateSensitivity(options.sensitivity);
  const qwenProfile = validateProfile(options.qwenProfile);
  const recall = validateLimits(options.recall);
  return Object.freeze({ ...options, sensitivity, qwenProfile, recall });
}

export function createRayneoProductionComposition(
  input: RayneoProductionCompositionOptions,
): RayneoProductionComposition {
  const config = assertConfiguration(input);
  let closed = false;
  let active: Readonly<{ readonly binding: RayneoProductionTurnBinding; readonly turn: RayneoProductionTurn }> | undefined;
  const openTurn = (rawBinding: RayneoProductionTurnBinding): RayneoProductionTurn => {
    if (closed) throw failure('RAYNEO_PRODUCTION_COMPOSITION_CLOSED');
    const binding = assertBindingShape(rawBinding);
    if (active !== undefined) {
      if (canonicalJson(active.binding) !== canonicalJson(binding)) throw failure('RAYNEO_PRODUCTION_TURN_ALREADY_ACTIVE');
      return active.turn;
    }
    const turn = createTurn({ config, binding });
    active = Object.freeze({ binding, turn });
    return turn;
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const current = active;
    active = undefined;
    await current?.turn.close();
  };
  const releaseTurn = async (turn: RayneoProductionTurn): Promise<void> => {
    if (active === undefined || active.turn !== turn) return;
    active = undefined;
    await turn.close();
  };
  return Object.freeze({ openTurn, releaseTurn, close });
}
