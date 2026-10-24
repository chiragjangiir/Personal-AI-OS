import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import {
  AccessToken,
  TrackSource as ServerTrackSource,
} from 'livekit-server-sdk';
import { createHash } from 'node:crypto';
import { createGatewayRoom } from './sdk-room.ts';
import { gunzipSync } from 'node:zlib';
import type { FinalTranscriptEvidenceResult } from '../../../services/realtime-core/src/final-transcript-evidence-service.ts';
import {
  assertRayneoLiveKitOwnerAliasReceipt,
  type RayneoLiveKitOwnerAliasIssuerPort,
  type RayneoLiveKitOwnerAliasReceipt,
} from './rayneo-livekit-owner-alias-issuer.ts';
import { RayneoSessionTurnContext } from './rayneo-session-turn-context.ts';
import {
  createRayneoRealtimeVideoBridge,
  type RayneoRealtimeVideoBinding,
  type RayneoRealtimeVideoBridge,
  type RayneoRealtimeVideoDiagnosticStage,
  type RayneoRealtimeVideoRoom,
  type RayneoRealtimeVideoSample,
} from './rayneo-realtime-video-bridge.ts';

const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_CHANNELS = 1;
// 256 mean-absolute PCM16 units is approximately -42 dBFS: above a conservative noise floor,
// while remaining well below ordinary speech amplitude. The value is never emitted or persisted.
const AUDIO_SIGNAL_MEAN_ABS_THRESHOLD = 256;
const DEFAULT_WINDOW_SECONDS = 4;
const VIDEO_SAMPLE_WINDOW_TOLERANCE_MS = 2_000;
const REPLY_TOPIC = 'paios.rayneo.realtime.reply.v1';
const REPLY_TYPE = 'paios.rayneo.realtime.reply.v1';
const ASSISTANT_RESULT_TOPIC = 'paios.assistant.result.local.v1';
const SYNTHETIC_PCM_TOPIC = 'paios.rayneo.synthetic.remember.pcm.v1';
const SYNTHETIC_PCM_SCHEMA = 'paios.rayneo.synthetic.remember.pcm.v1';
const SYNTHETIC_PCM_ENCODING = 'gzip+base64';
const SYNTHETIC_PCM_FORMAT = 'pcm_s16le';
const SYNTHETIC_PCM_RAW_BYTES = 288_000;
const SYNTHETIC_PCM_RAW_SHA256 =
  '942B1FF2A6E394F85AD653725055409043CC287D7441D6BEFFF2A76549079D79';
const SYNTHETIC_PCM_MAX_TEXT_BYTES = 1_500_000;
const SYNTHETIC_PCM_MAX_BASE64_BYTES = 1_400_000;
const STT_PATH = '/v1/audio/transcriptions';
const TOKEN_CLOCK_SAFETY_SECONDS = 5;
const INITIAL_TOKEN_TTL_CEILING_SECONDS = 120;
const MAX_CONTINUOUS_SESSION_TTL_MS = 86_400_000;
const REPLACEMENT_DETACH_GRACE_MS = 500;
const REPLY_VOICE_MAX_SAMPLES = AUDIO_SAMPLE_RATE * 60;
const REPLY_VOICE_FRAME_SAMPLES = AUDIO_SAMPLE_RATE / 100;
const SESSION_ID = /^phase0_session_[a-f0-9]{20}$/u;
const DEVICE_ID = /^rayneo_device_[a-f0-9]{20}$/u;
const CLIENT_ID = /^rayneo_client_[a-f0-9]{20}$/u;
const RAYNEO_HAN_PATTERN = /\p{Script=Han}/u;
const RAYNEO_FORBIDDEN_OUTPUT_PATTERN =
  /(?:https?:\/\/|www\.|Bearer\s|sk-[A-Za-z0-9_-]|<[^>]+>|```|\b(?:tool|function)\s*call\b)/iu;

export const RAYNEO_REALTIME_AUDIO_DIAGNOSTIC_STAGES = Object.freeze([
  'REMOTE_MIC_TRACK_CALLBACK',
  'REMOTE_MIC_TRACK_REJECTED_CLOSED',
  'REMOTE_MIC_TRACK_REJECTED_DUPLICATE',
  'REMOTE_MIC_TRACK_REJECTED_IDENTITY',
  'REMOTE_MIC_TRACK_REJECTED_ATTRIBUTES',
  'REMOTE_MIC_TRACK_REJECTED_KIND',
  'REMOTE_MIC_TRACK_REJECTED_SOURCE',
  'REMOTE_MIC_TRACK_SUBSCRIBED',
  'AUDIO_FRAME_OBSERVED',
  'AUDIO_SIGNAL_OBSERVED',
  'WINDOW_READY',
  'STT_REQUESTED',
  'STT_ACCEPTED',
  'FINAL_TRANSCRIPT_COMMITTED',
  'STT_EMPTY',
  'STT_FAILED',
  'TEXT_STREAM_ACCEPTED',
  'DIARIZATION_WINDOW_LOCAL',
  'DIARIZATION_DEGRADED',
  'JOINT_CONTEXT_APPLIED',
  'VIDEO_CONTEXT_APPLIED',
  'VISUAL_HEARTBEAT_SENT',
  'REPLY_SENT',
] as const);

export type RayneoRealtimeAudioDiagnosticStage =
  typeof RAYNEO_REALTIME_AUDIO_DIAGNOSTIC_STAGES[number];

function defaultObserveFixedStage(stage: RayneoRealtimeAudioDiagnosticStage): void {
  console.info(`rayneo_realtime_stage=${stage}`);
}

function hasConservativeAudioSignal(samples: Int16Array): boolean {
  if (samples.length === 0) return false;
  let absoluteSum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    absoluteSum += Math.abs(samples[index]!);
  }
  return absoluteSum / samples.length >= AUDIO_SIGNAL_MEAN_ABS_THRESHOLD;
}

export interface RayneoRealtimeAudioConfig {
  readonly livekitUrl: string;
  readonly clientLivekitUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly sttEndpointUrl: string;
  readonly sttModel: string;
  readonly sttDeadlineMs: number;
  readonly ollamaModel: string;
  readonly ollamaEndpointUrl: string;
  readonly windowSeconds?: number;
  readonly diarizationEndpointUrl?: string;
  readonly diarizationDeadlineMs?: number;
  readonly ollamaDeadlineMs?: number;
  /** Active-session-only visual explanation cadence. Defaults to ten seconds. */
  readonly visualHeartbeatSeconds?: number;
}

export interface RayneoRealtimeAudioBinding {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly turnContext?: RayneoSessionTurnContext;
}

export interface RayneoRealtimeAudioSession {
  readonly livekit_url: string;
  readonly livekit_token: string;
  readonly livekit_token_expires_at: string;
  readonly livekit_video_publish_enabled: true;
  cleanup(): Promise<boolean>;
}

/**
 * Admission/reply profile for an already connected room.  The legacy RayNeo
 * profile keeps the attribute fence and wire shape below; the public assistant
 * profile is bound to the credential identity supplied by the bootstrap owner
 * and deliberately does not pretend that the participant is a RayNeo device.
 */
export type RayneoRealtimeAudioRoomProfile = Readonly<
  | { readonly kind: 'rayneo' }
  | {
    readonly kind: 'public-assistant';
    readonly participantIdentity: string;
    readonly dataEnabled?: boolean;
    readonly audioEnabled?: boolean;
    readonly videoEnabled?: boolean;
  }
>;

/** Internal-only issuance facts. Never spread into the Cordless wire object. */
export const RAYNEO_REALTIME_OWNER_ISSUANCE: unique symbol = Symbol('paios.rayneo.realtime.owner-issuance.v1');

export interface RayneoRealtimeOwnerIssuanceProjection {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly tokenIssuedAt: string;
  readonly tokenExpiresAt: string;
  readonly receipt: RayneoLiveKitOwnerAliasReceipt;
}

/** Reads only the non-enumerable internal issuance envelope. */
export function readRayneoRealtimeOwnerIssuance(
  value: unknown,
): RayneoRealtimeOwnerIssuanceProjection | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, RAYNEO_REALTIME_OWNER_ISSUANCE);
  if (descriptor?.enumerable !== false) return undefined;
  return descriptor.value as RayneoRealtimeOwnerIssuanceProjection | undefined;
}

export interface RayneoDiarizationInput {
  readonly sessionId: string;
  readonly pcm: Int16Array;
  readonly sampleRate: typeof AUDIO_SAMPLE_RATE;
}

export interface RayneoDiarizationResult {
  readonly status: 'matched' | 'degraded';
  readonly segments?: readonly RayneoDiarizationSegment[];
}

export interface RayneoDiarizationSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly rawSpeakerId: string;
  readonly confidence?: number;
}

export interface RayneoSpeakerDiarizationPort {
  diarize(input: RayneoDiarizationInput, signal: AbortSignal): Promise<RayneoDiarizationResult>;
}

export interface RayneoRealtimeAudioObservation {
  readonly stage:
    | 'TRACK_STARTED'
    | 'AUDIO_BATCH'
    | 'STT_FINAL'
    | 'FINAL_TRANSCRIPT_COMMITTED'
    | 'DIARIZATION_MATCHED'
    | 'DIARIZATION_DEGRADED'
    | 'REPLY_SENT'
    | 'TRACK_STOPPED'
    | 'TRACK_ERROR';
  readonly sessionId: string;
  readonly sequence?: number;
  readonly errorCode?: string;
}

export interface RayneoFinalTranscriptAuthorityInput {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly diarizationStatus: 'window_local' | 'degraded';
  readonly transcript: string;
  /** BCP-47; `und` is used until the STT provider returns an authoritative language. */
  readonly language: 'und';
  readonly observedAt: string;
  readonly media: Readonly<{
    readonly format: 'pcm_s16le';
    readonly sampleRate: typeof AUDIO_SAMPLE_RATE;
    readonly channels: typeof AUDIO_CHANNELS;
    readonly sha256: string;
    /** Valid only for the duration of finalize(); the controller zeroes it on settlement. */
    readonly bytes: Uint8Array;
  }>;
}

/**
 * T13/T11B production adapter seam.  The implementation must durably issue the
 * source-media reference and final-transcript evidence before this call settles.
 */
export interface RayneoFinalTranscriptAuthorityPort {
  finalize(input: RayneoFinalTranscriptAuthorityInput): Promise<void>;
}

/** Optional production result seam used to bind Memory to the exact T11B ref. */
export interface RayneoFinalTranscriptAuthorityWithEvidence extends RayneoFinalTranscriptAuthorityPort {
  finalizeWithEvidence?(input: RayneoFinalTranscriptAuthorityInput): Promise<FinalTranscriptEvidenceResult>;
}

/** Post-commit hook input deliberately excludes the transient PCM bytes. */
export interface RayneoFinalTranscriptPostCommitInput {
  readonly input: Readonly<Omit<RayneoFinalTranscriptAuthorityInput, 'media'>>;
  readonly evidence: FinalTranscriptEvidenceResult;
}

export interface RayneoRealtimeMultimodalReplyInput {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly transcript: string;
  readonly videoSamples: readonly RayneoRealtimeVideoSample[];
}

export interface RayneoRealtimeVisualHeartbeatInput {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly videoSamples: readonly RayneoRealtimeVideoSample[];
}

export interface RayneoSpokenReply {
  readonly text: string;
  readonly pcm: Int16Array;
  readonly sampleRate: 16_000;
  readonly channels: 1;
}

export type RayneoGeneratedReply = string | RayneoSpokenReply;

interface ReplyVoicePublishInput {
  readonly room: RoomPort;
  readonly reply: RayneoSpokenReply;
  readonly sequence: number;
  readonly signal: AbortSignal;
}

interface AudioFrameLike {
  readonly data: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerChannel: number;
}

interface RoomPort {
  readonly localParticipant: {
    sendText?(
      text: string,
      options?: {
        readonly topic?: string;
        readonly destinationIdentities?: string[];
      },
    ): Promise<unknown>;
    publishData?(
      data: Uint8Array,
      options?: {
        readonly reliable?: boolean;
        readonly destination_identities?: readonly string[];
        readonly topic?: string;
      },
    ): Promise<unknown>;
    publishTrack?(track: unknown, options: unknown): Promise<{ readonly sid?: string }>;
    unpublishTrack?(trackSid: string, stopOnUnpublish?: boolean): Promise<void>;
  };
  on(event: string, handler: (...args: never[]) => void): this;
  registerTextStreamHandler?(
    topic: string,
    handler: (reader: TextStreamReaderPort, participant: TextStreamParticipant) => void,
  ): void;
  unregisterTextStreamHandler?(topic: string): void;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  off?(event: string, handler: (...args: never[]) => void): this;
  removeListener?(event: string, handler: (...args: never[]) => void): this;
}

/** Structural port accepted by attachExistingRoom; the Public participant owns its lifetime. */
export type RayneoRealtimeAudioRoomPort = RoomPort;

/** Structural view accepted from LiveKitCloudParticipantPort.roomPort. */
export interface RayneoRealtimeAudioExistingRoomPort {
  readonly localParticipant?: RoomPort['localParticipant'];
  readonly on?: (event: string, handler: (...args: readonly unknown[]) => void) => unknown;
  readonly off?: (event: string, handler: (...args: readonly unknown[]) => void) => unknown;
  readonly removeListener?: (event: string, handler: (...args: readonly unknown[]) => void) => unknown;
  readonly disconnect: () => Promise<void>;
}

interface TextStreamReaderPort {
  readAll(): Promise<string>;
}

interface TextStreamParticipant {
  readonly identity: string;
}

export interface RayneoRealtimeAudioDependencies {
  readonly roomFactory?: () => RoomPort;
  readonly audioStreamFactory?: (track: RemoteTrack) => AsyncIterable<AudioFrameLike>;
  readonly videoBridgeFactory?: (
    room: RayneoRealtimeVideoRoom,
    binding: RayneoRealtimeVideoBinding,
    observeFixedStage: (stage: RayneoRealtimeVideoDiagnosticStage) => void,
    onSample?: (sample: RayneoRealtimeVideoSample) => void | Promise<void>,
  ) => Promise<RayneoRealtimeVideoBridge>;
  readonly fetch?: typeof fetch;
  readonly diarizer?: RayneoSpeakerDiarizationPort;
  readonly finalTranscriptAuthority?: RayneoFinalTranscriptAuthorityWithEvidence;
  readonly afterFinalTranscript?: (input: RayneoFinalTranscriptPostCommitInput) => Promise<void>;
  readonly generateReply?: (transcript: string, speakerLabel: string, signal: AbortSignal) => Promise<RayneoGeneratedReply>;
  readonly generateSegmentReply?: (
    segmentId: string,
    transcript: string,
    speakerLabel: string,
    signal: AbortSignal,
  ) => Promise<RayneoGeneratedReply>;
  readonly generateMultimodalReply?: (
    input: RayneoRealtimeMultimodalReplyInput,
    signal: AbortSignal,
  ) => Promise<RayneoGeneratedReply>;
  readonly generateVisualHeartbeatReply?: (
    input: RayneoRealtimeVisualHeartbeatInput,
    signal: AbortSignal,
  ) => Promise<RayneoGeneratedReply>;
  readonly completeConversationTurn?: (inputId: string, assistantText: string) => Promise<void>;
  readonly markIndeterminateConversationTurn?: (inputId: string, assistantText: string) => Promise<void>;
  readonly releaseConversationTurn?: (inputId: string) => Promise<void>;
  readonly publishReplyVoice?: (input: ReplyVoicePublishInput) => Promise<void>;
  readonly signToken?: (token: AccessToken) => Promise<string>;
  /** Debug-canary-only owner alias authority, called after actual LiveKit connect. */
  readonly ownerAliasIssuer?: RayneoLiveKitOwnerAliasIssuerPort;
  readonly now?: () => number;
  readonly observe?: (observation: RayneoRealtimeAudioObservation) => void;
  readonly observeFixedStage?: (stage: RayneoRealtimeAudioDiagnosticStage) => void;
  readonly observeVideoFixedStage?: (stage: RayneoRealtimeVideoDiagnosticStage) => void;
  /** Optional profile used only when attaching to an existing Public room. */
  readonly roomProfile?: RayneoRealtimeAudioRoomProfile;
}

interface ActiveTrack {
  readonly track: RemoteTrack;
  readonly abort: AbortController;
  frameObserved: boolean;
  signalObserved: boolean;
  iterator?: AsyncIterator<AudioFrameLike>;
  completion?: Promise<void>;
}

function failure(code: string): Error {
  return new Error(code);
}

function assertRoomProfile(value: RayneoRealtimeAudioRoomProfile): RayneoRealtimeAudioRoomProfile {
  if (value.kind === 'rayneo') return value;
  if (value.kind === 'public-assistant' && typeof value.participantIdentity === 'string' &&
      value.participantIdentity.length > 0 && value.participantIdentity === value.participantIdentity.trim() &&
      !value.participantIdentity.includes('\u0000') &&
      (value.dataEnabled === undefined || typeof value.dataEnabled === 'boolean') &&
      (value.audioEnabled === undefined || typeof value.audioEnabled === 'boolean') &&
      (value.videoEnabled === undefined || typeof value.videoEnabled === 'boolean')) return value;
  throw failure('RAYNEO_REALTIME_ROOM_PROFILE_INVALID');
}

function spokenReply(value: RayneoGeneratedReply): RayneoSpokenReply | undefined {
  if (typeof value === 'string') return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'channels,pcm,sampleRate,text' ||
      typeof value.text !== 'string' || !(value.pcm instanceof Int16Array) ||
      value.sampleRate !== AUDIO_SAMPLE_RATE || value.channels !== AUDIO_CHANNELS ||
      value.pcm.length === 0 || value.pcm.length > REPLY_VOICE_MAX_SAMPLES) {
    throw failure('RAYNEO_REPLY_VOICE_INVALID');
  }
  return value;
}

async function publishReplyVoice(input: ReplyVoicePublishInput): Promise<void> {
  const participant = input.room.localParticipant;
  if (participant.publishTrack === undefined || participant.unpublishTrack === undefined) {
    throw failure('RAYNEO_REPLY_VOICE_ROOM_UNAVAILABLE');
  }
  if (input.signal.aborted) throw failure('RAYNEO_REPLY_VOICE_ABORTED');
  const source = new AudioSource(AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, 200);
  const track = LocalAudioTrack.createAudioTrack(`rayneo-reply-voice-${input.sequence}`, source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  let publicationSid: string | undefined;
  try {
    const publication = await participant.publishTrack(track, options);
    publicationSid = publication.sid ?? track.sid;
    if (publicationSid === undefined) throw failure('RAYNEO_REPLY_VOICE_PUBLICATION_INVALID');
    for (let offset = 0; offset < input.reply.pcm.length; offset += REPLY_VOICE_FRAME_SAMPLES) {
      if (input.signal.aborted) throw failure('RAYNEO_REPLY_VOICE_ABORTED');
      const end = Math.min(input.reply.pcm.length, offset + REPLY_VOICE_FRAME_SAMPLES);
      const owned = new Int16Array(end - offset);
      owned.set(input.reply.pcm.subarray(offset, end));
      try {
        await source.captureFrame(new AudioFrame(
          owned, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, owned.length,
        ));
      } finally {
        owned.fill(0);
      }
    }
    await source.waitForPlayout();
  } finally {
    if (publicationSid !== undefined) {
      await participant.unpublishTrack(publicationSid, true).catch(() => undefined);
    }
    await track.close(true).catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function publishReplyText(
  room: RoomPort,
  payload: Readonly<Record<string, unknown>>,
  topic: string,
  destinationIdentity: string,
): Promise<void> {
  const text = JSON.stringify(payload);
  const local = room.localParticipant;
  if (typeof local.sendText === 'function') {
    await local.sendText(text, {
      destinationIdentities: [destinationIdentity],
      topic,
    });
    return;
  }
  if (typeof local.publishData === 'function') {
    await local.publishData(new TextEncoder().encode(text), {
      reliable: true,
      destination_identities: [destinationIdentity],
      topic,
    });
    return;
  }
  throw failure('RAYNEO_REPLY_TEXT_ROOM_UNAVAILABLE');
}

function canonicalUrl(value: string, mode: 'server' | 'client' | 'diarization'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  }
  if (mode === 'server') {
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.port !== '7880' ||
      url.href !== 'ws://127.0.0.1:7880/'
    ) throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  } else if (mode === 'client') {
    const loopbackTest = url.href === 'ws://127.0.0.1:7880/';
    if (!loopbackTest && (url.protocol !== 'wss:' || url.port !== '')) {
      throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
    }
  } else if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.pathname !== '/'
  ) {
    throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  }
  return url;
}

function assertConfig(config: RayneoRealtimeAudioConfig): number {
  const agentUrl = canonicalUrl(config.livekitUrl, 'client');
  const clientUrl = canonicalUrl(config.clientLivekitUrl, 'client');
  if (agentUrl.href !== clientUrl.href) throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  if (
    config.apiKey.length < 16 ||
    config.apiSecret.length < 32 ||
    !isExactLoopbackSttUrl(config.sttEndpointUrl) ||
    config.sttModel.length < 1 ||
    config.sttModel.length > 512 ||
    config.sttModel.trim() !== config.sttModel ||
    !Number.isSafeInteger(config.sttDeadlineMs) ||
    config.sttDeadlineMs < 1_000 ||
    config.sttDeadlineMs > 30_000 ||
    config.ollamaModel.length < 1 ||
    config.ollamaModel.length > 128 ||
    config.ollamaModel.trim() !== config.ollamaModel ||
    !isExactLoopbackOllamaUrl(config.ollamaEndpointUrl)
  ) throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  if (config.diarizationEndpointUrl !== undefined) {
    const url = new URL(config.diarizationEndpointUrl);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.port === '' ||
      url.pathname !== '/v1/diarize' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  }
  const windowSeconds = config.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 2 || windowSeconds > 8) {
    throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  }
  const diarizationDeadlineMs = config.diarizationDeadlineMs ?? 8_000;
  const ollamaDeadlineMs = config.ollamaDeadlineMs ?? 10_000;
  const visualHeartbeatSeconds = config.visualHeartbeatSeconds ?? 10;
  if (
    !Number.isSafeInteger(diarizationDeadlineMs) ||
    diarizationDeadlineMs < 100 || diarizationDeadlineMs > 8_000 ||
    !Number.isSafeInteger(ollamaDeadlineMs) ||
    ollamaDeadlineMs < 100 || ollamaDeadlineMs > 10_000 ||
    !Number.isSafeInteger(visualHeartbeatSeconds) ||
    visualHeartbeatSeconds < 4 || visualHeartbeatSeconds > 60
  ) throw failure('RAYNEO_REALTIME_CONFIG_INVALID');
  return windowSeconds;
}

function isExactLoopbackOllamaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535 &&
      value === `http://127.0.0.1:${port}`;
  } catch {
    return false;
  }
}

function isExactLoopbackSttUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535 &&
      value === `http://127.0.0.1:${port}${STT_PATH}`;
  } catch {
    return false;
  }
}

function assertBinding(binding: RayneoRealtimeAudioBinding, now: number, allowPublicIdentity = false): void {
  if (
    (allowPublicIdentity
      ? [binding.sessionId, binding.deviceId, binding.clientInstanceId].some((value) =>
        typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\u0000'))
      : !SESSION_ID.test(binding.sessionId) || !DEVICE_ID.test(binding.deviceId) || !CLIENT_ID.test(binding.clientInstanceId)) ||
    !Number.isSafeInteger(binding.openedAt) ||
    !Number.isSafeInteger(binding.expiresAt) ||
    binding.openedAt > now ||
    binding.expiresAt <= now ||
    binding.expiresAt - now > MAX_CONTINUOUS_SESSION_TTL_MS
  ) throw failure('RAYNEO_REALTIME_BINDING_INVALID');
}

function setRegisteredTokenWindow(
  token: AccessToken,
  issuedAtSeconds: number,
  expiresAtSeconds: number,
): void {
  const sdkToken = token as unknown as { grants?: Record<string, unknown> };
  if (
    !sdkToken.grants ||
    !Number.isSafeInteger(issuedAtSeconds) ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= issuedAtSeconds
  ) {
    throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
  }
  sdkToken.grants.iat = issuedAtSeconds;
  token.ttl = expiresAtSeconds;
}

function assertAgentToken(
  jwt: string,
  config: RayneoRealtimeAudioConfig,
  binding: RayneoRealtimeAudioBinding,
  identity: string,
  issuedAtSeconds: number,
): void {
  const payload = decodeJwtPayload(jwt);
  const video = payload.video as Record<string, unknown> | undefined;
  const attributes = payload.attributes as Record<string, unknown> | undefined;
  const expiration = payload.exp;
  if (
    payload.iss !== config.apiKey ||
    payload.sub !== identity ||
    payload.name !== 'RayNeo Realtime Agent' ||
    payload.iat !== issuedAtSeconds ||
    !Number.isSafeInteger(expiration) ||
    Number(expiration) <= issuedAtSeconds ||
    Number(expiration) * 1_000 > binding.expiresAt ||
    attributes?.device_id !== identity ||
    attributes.device_class !== 'windows_gateway' ||
    attributes.session_id !== binding.sessionId ||
    video?.room !== binding.sessionId ||
    video.roomJoin !== true ||
    video.canPublish !== true ||
    video.canPublishData !== true ||
    video.canSubscribe !== true ||
    video.canPublishSources !== undefined
  ) throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
      throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
    }
    return payload as Record<string, unknown>;
  } catch {
    throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
  }
}

const SYNTHETIC_PCM_KEYS = Object.freeze([
  'channels', 'client_instance_id', 'device_id', 'encoding', 'format', 'pcm_gzip_b64',
  'raw_bytes', 'raw_sha256', 'sample_rate', 'schema', 'session_id',
] as const);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeSyntheticPcmEnvelope(
  text: string,
  binding: RayneoRealtimeAudioBinding,
): Int16Array {
  if (Buffer.byteLength(text, 'utf8') > SYNTHETIC_PCM_MAX_TEXT_BYTES) {
    throw failure('RAYNEO_SYNTHETIC_PCM_TEXT_TOO_LARGE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failure('RAYNEO_SYNTHETIC_PCM_JSON_INVALID');
  }
  if (!isPlainRecord(parsed)) throw failure('RAYNEO_SYNTHETIC_PCM_PAYLOAD_INVALID');
  const keys = Object.keys(parsed).sort();
  const expectedKeys = [...SYNTHETIC_PCM_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw failure('RAYNEO_SYNTHETIC_PCM_PAYLOAD_INVALID');
  }
  if (
    parsed.schema !== SYNTHETIC_PCM_SCHEMA ||
    parsed.session_id !== binding.sessionId ||
    parsed.device_id !== binding.deviceId ||
    parsed.client_instance_id !== binding.clientInstanceId ||
    parsed.encoding !== SYNTHETIC_PCM_ENCODING ||
    parsed.format !== SYNTHETIC_PCM_FORMAT ||
    parsed.sample_rate !== AUDIO_SAMPLE_RATE ||
    parsed.channels !== AUDIO_CHANNELS ||
    parsed.raw_bytes !== SYNTHETIC_PCM_RAW_BYTES ||
    parsed.raw_sha256 !== SYNTHETIC_PCM_RAW_SHA256
  ) throw failure('RAYNEO_SYNTHETIC_PCM_BINDING_INVALID');
  const encoded = parsed.pcm_gzip_b64;
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > SYNTHETIC_PCM_MAX_BASE64_BYTES ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) throw failure('RAYNEO_SYNTHETIC_PCM_BASE64_INVALID');
  let compressed: Buffer;
  try {
    compressed = Buffer.from(encoded, 'base64');
  } catch {
    throw failure('RAYNEO_SYNTHETIC_PCM_BASE64_INVALID');
  }
  if (compressed.length === 0 || compressed.length > SYNTHETIC_PCM_RAW_BYTES) {
    compressed.fill(0);
    throw failure('RAYNEO_SYNTHETIC_PCM_COMPRESSED_INVALID');
  }
  let raw: Buffer | undefined;
  try {
    try {
      raw = gunzipSync(compressed, { maxOutputLength: SYNTHETIC_PCM_RAW_BYTES });
    } catch {
      throw failure('RAYNEO_SYNTHETIC_PCM_DECODE_INVALID');
    }
    if (
      raw.length !== SYNTHETIC_PCM_RAW_BYTES ||
      createHash('sha256').update(raw).digest('hex').toUpperCase() !== SYNTHETIC_PCM_RAW_SHA256
    ) throw failure('RAYNEO_SYNTHETIC_PCM_HASH_INVALID');
    const pcm = new Int16Array(SYNTHETIC_PCM_RAW_BYTES / 2);
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = raw.readInt16LE(index * 2);
    return pcm;
  } finally {
    raw?.fill(0);
    compressed.fill(0);
  }
}

function assertParticipantToken(
  jwt: string,
  config: RayneoRealtimeAudioConfig,
  binding: RayneoRealtimeAudioBinding,
  issuedAtSeconds: number,
  canPublishData: boolean,
): number {
  const payload = decodeJwtPayload(jwt);
  const video = payload.video as Record<string, unknown> | undefined;
  const attributes = payload.attributes as Record<string, unknown> | undefined;
  const expiration = payload.exp;
  if (
    payload.iss !== config.apiKey ||
    payload.sub !== binding.deviceId ||
    payload.name !== 'RayNeo X3 Pro' ||
    payload.iat !== issuedAtSeconds ||
    !Number.isSafeInteger(expiration) ||
    Number(expiration) <= issuedAtSeconds ||
    Number(expiration) * 1_000 > binding.expiresAt ||
    attributes?.device_id !== binding.deviceId ||
    attributes.device_class !== 'rayneo' ||
    attributes.client_instance_id !== binding.clientInstanceId ||
    attributes.session_id !== binding.sessionId ||
    video?.room !== binding.sessionId ||
    video.roomJoin !== true ||
    video.canPublish !== true ||
    video.canPublishData !== canPublishData ||
    video.canSubscribe !== true ||
    JSON.stringify(video.canPublishSources) !== '["microphone","camera"]'
  ) throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
  return Number(expiration);
}

function buildWav(pcm: Int16Array): Buffer {
  const headerBytes = 44;
  const wav = Buffer.alloc(headerBytes + pcm.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(AUDIO_CHANNELS, 22);
  wav.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  wav.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.byteLength, 40);
  for (let index = 0; index < pcm.length; index += 1) {
    wav.writeInt16LE(pcm[index]!, headerBytes + index * 2);
  }
  return wav;
}

function transcriptText(payload: unknown): string | undefined {
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw failure('RAYNEO_STT_RESPONSE_INVALID');
  }
  const text = (payload as Record<string, unknown>).text;
  if (typeof text !== 'string' || text.length > 16_384) {
    throw failure('RAYNEO_STT_RESPONSE_INVALID');
  }
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function replyText(payload: unknown): string {
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw failure('RAYNEO_OLLAMA_RESPONSE_INVALID');
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw failure('RAYNEO_OLLAMA_RESPONSE_INVALID');
  }
  const choice = choices[0];
  const message = choice !== null && !Array.isArray(choice) && typeof choice === 'object'
    ? (choice as Record<string, unknown>).message
    : undefined;
  const content = message !== null && !Array.isArray(message) && typeof message === 'object'
    ? (message as Record<string, unknown>).content
    : undefined;
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > 4_096) {
    throw failure('RAYNEO_OLLAMA_RESPONSE_INVALID');
  }
  const trimmed = content.trim();
  const visible = [...trimmed].filter((character) => !/\s/u.test(character));
  const han = visible.filter((character) => RAYNEO_HAN_PATTERN.test(character)).length;
  if (/[\u0000-\u001f\u007f]/u.test(content) ||
      RAYNEO_FORBIDDEN_OUTPUT_PATTERN.test(content) || visible.length > 80 || han < 4) {
    throw failure('RAYNEO_OLLAMA_RESPONSE_INVALID');
  }
  return trimmed;
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{1,127}$/u.test(value) ? value : 'RAYNEO_REALTIME_FAILED';
}

async function boundedOperation<T>(
  parentSignal: AbortSignal,
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutCode: string,
): Promise<T> {
  if (parentSignal.aborted) throw failure('RAYNEO_REALTIME_STOPPED');
  const controller = new AbortController();
  let rejectBoundary!: (error: Error) => void;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  const onStop = () => {
    controller.abort();
    rejectBoundary(failure('RAYNEO_REALTIME_STOPPED'));
  };
  parentSignal.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectBoundary(failure(timeoutCode));
  }, deadlineMs);
  timer.unref?.();
  try {
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onStop);
  }
}

class DegradedSpeakerDiarization implements RayneoSpeakerDiarizationPort {
  async diarize(): Promise<RayneoDiarizationResult> {
    return Object.freeze({ status: 'degraded' });
  }
}

export class SherpaOnnxSidecarDiarization implements RayneoSpeakerDiarizationPort {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = globalThis.fetch) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' ||
      url.pathname !== '/v1/diarize' || url.search !== '' || url.hash !== ''
    ) throw failure('RAYNEO_DIARIZATION_CONFIG_INVALID');
    this.#endpoint = endpoint;
    this.#fetch = fetchImplementation;
  }

  async diarize(input: RayneoDiarizationInput, signal: AbortSignal): Promise<RayneoDiarizationResult> {
    const wav = buildWav(input.pcm);
    try {
      const form = new FormData();
      form.append('file', new File([wav], 'rayneo-window.wav', { type: 'audio/wav' }));
      form.append('session_id', input.sessionId);
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST', body: form, signal, redirect: 'error', cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (response.status < 200 || response.status >= 300 || response.redirected) {
        return Object.freeze({ status: 'degraded' });
      }
      const payload = await response.json() as unknown;
      if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
        return Object.freeze({ status: 'degraded' });
      }
      const segments = (payload as Record<string, unknown>).segments;
      if (!Array.isArray(segments) || segments.length === 0) {
        return Object.freeze({ status: 'degraded' });
      }
      const parsedSegments: RayneoDiarizationSegment[] = [];
      for (const segment of segments) {
        if (segment === null || Array.isArray(segment) || typeof segment !== 'object') continue;
        const item = segment as Record<string, unknown>;
        const speaker = typeof item.speaker === 'string' || Number.isSafeInteger(item.speaker)
          ? String(item.speaker)
          : undefined;
        const start = Number(item.start);
        const end = Number(item.end);
        const confidence = item.confidence === undefined ? undefined : Number(item.confidence);
        if (!speaker || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
          continue;
        }
        parsedSegments.push(Object.freeze({
          startSeconds: start,
          endSeconds: end,
          rawSpeakerId: speaker,
          ...(confidence === undefined ? {} : { confidence }),
        }));
      }
      parsedSegments.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
      return parsedSegments.length > 0
        ? Object.freeze({ status: 'matched', segments: Object.freeze(parsedSegments) })
        : Object.freeze({ status: 'degraded' });
    } catch {
      return Object.freeze({ status: 'degraded' });
    } finally {
      wav.fill(0);
    }
  }
}

export class RayneoRealtimeAudioController implements RayneoRealtimeAudioSession {
  readonly livekit_url: string;
  readonly livekit_token: string;
  readonly livekit_token_expires_at: string;
  readonly livekit_video_publish_enabled = true as const;
  readonly #config: RayneoRealtimeAudioConfig;
  readonly #binding: RayneoRealtimeAudioBinding;
  readonly #room: RoomPort;
  readonly #audioStreamFactory: (track: RemoteTrack) => AsyncIterable<AudioFrameLike>;
  readonly #fetch: typeof fetch;
  readonly #diarizer: RayneoSpeakerDiarizationPort;
  readonly #finalTranscriptAuthority: RayneoFinalTranscriptAuthorityWithEvidence | undefined;
  readonly #afterFinalTranscript: RayneoRealtimeAudioDependencies['afterFinalTranscript'];
  readonly #generateReplyOverride: RayneoRealtimeAudioDependencies['generateReply'];
  readonly #generateSegmentReplyOverride: RayneoRealtimeAudioDependencies['generateSegmentReply'];
  readonly #generateMultimodalReplyOverride: RayneoRealtimeAudioDependencies['generateMultimodalReply'];
  readonly #generateVisualHeartbeatReplyOverride: RayneoRealtimeAudioDependencies['generateVisualHeartbeatReply'];
  readonly #completeConversationTurn: RayneoRealtimeAudioDependencies['completeConversationTurn'];
  readonly #markIndeterminateConversationTurn: RayneoRealtimeAudioDependencies['markIndeterminateConversationTurn'];
  readonly #releaseConversationTurn: RayneoRealtimeAudioDependencies['releaseConversationTurn'];
  readonly #publishReplyVoice: NonNullable<RayneoRealtimeAudioDependencies['publishReplyVoice']>;
  readonly #observe: NonNullable<RayneoRealtimeAudioDependencies['observe']>;
  readonly #observeFixedStage: NonNullable<RayneoRealtimeAudioDependencies['observeFixedStage']>;
  readonly #observeVideoFixedStage: NonNullable<RayneoRealtimeAudioDependencies['observeVideoFixedStage']>;
  readonly #now: () => number;
  readonly #turnContext: RayneoSessionTurnContext | undefined;
  readonly #roomProfile: RayneoRealtimeAudioRoomProfile;
  readonly #ownsRoomConnection: boolean;
  readonly #windowSamples: number;
  readonly #visualHeartbeatMs: number;
  readonly #seenTracks = new WeakSet<object>();
  readonly #speakerLabels = new Map<string, string>();
  readonly #syntheticPcmEnabled: boolean;
  #syntheticPcmHandlerRegistered = false;
  #syntheticPcmClaimed = false;
  #syntheticPcmPending: Int16Array | undefined;
  #activeTrack: ActiveTrack | undefined;
  #videoBridge: RayneoRealtimeVideoBridge | undefined;
  readonly #sessionAbort = new AbortController();
  #videoVisualFlight: Promise<void> | undefined;
  #videoVisualAbort: AbortController | undefined;
  #lastVideoVisualAtMs = -1;
  #mediaTimelineOriginMs: number | undefined;
  #windowSequence = 0;
  #sequence = 0;
  #lastVisualHeartbeatEndMs = -1;
  #closed = false;
  #roomDisconnected = false;
  #roomListenersBound = false;
  #trackSubscribedListener: ((...args: never[]) => void) | undefined;
  #trackUnsubscribedListener: ((...args: never[]) => void) | undefined;
  #participantDisconnectedListener: ((...args: never[]) => void) | undefined;
  #roomDisconnectedListener: ((...args: never[]) => void) | undefined;
  #cleanupCompletion: Promise<boolean> | undefined;

  private constructor(input: {
    readonly config: RayneoRealtimeAudioConfig;
    readonly binding: RayneoRealtimeAudioBinding;
    readonly room: RoomPort;
    readonly audioStreamFactory: (track: RemoteTrack) => AsyncIterable<AudioFrameLike>;
    readonly fetch: typeof fetch;
    readonly diarizer: RayneoSpeakerDiarizationPort;
    readonly finalTranscriptAuthority: RayneoFinalTranscriptAuthorityWithEvidence | undefined;
    readonly afterFinalTranscript: RayneoRealtimeAudioDependencies['afterFinalTranscript'];
     readonly generateReply: RayneoRealtimeAudioDependencies['generateReply'];
     readonly generateSegmentReply: RayneoRealtimeAudioDependencies['generateSegmentReply'];
    readonly generateMultimodalReply: RayneoRealtimeAudioDependencies['generateMultimodalReply'];
    readonly generateVisualHeartbeatReply: RayneoRealtimeAudioDependencies['generateVisualHeartbeatReply'];
    readonly completeConversationTurn: RayneoRealtimeAudioDependencies['completeConversationTurn'];
    readonly markIndeterminateConversationTurn: RayneoRealtimeAudioDependencies['markIndeterminateConversationTurn'];
    readonly releaseConversationTurn: RayneoRealtimeAudioDependencies['releaseConversationTurn'];
    readonly publishReplyVoice: NonNullable<RayneoRealtimeAudioDependencies['publishReplyVoice']>;
    readonly observe: NonNullable<RayneoRealtimeAudioDependencies['observe']>;
    readonly observeFixedStage: NonNullable<RayneoRealtimeAudioDependencies['observeFixedStage']>;
    readonly observeVideoFixedStage: NonNullable<RayneoRealtimeAudioDependencies['observeVideoFixedStage']>;
     readonly now: () => number;
     readonly windowSamples: number;
     readonly participantToken: string;
     readonly participantTokenExpiresAt: number;
     readonly syntheticPcmEnabled: boolean;
     readonly roomProfile: RayneoRealtimeAudioRoomProfile;
     readonly ownsRoomConnection: boolean;
  }) {
    this.#config = input.config;
    this.#binding = input.binding;
    this.#room = input.room;
    this.#audioStreamFactory = input.audioStreamFactory;
    this.#fetch = input.fetch;
    this.#diarizer = input.diarizer;
    this.#finalTranscriptAuthority = input.finalTranscriptAuthority;
    this.#afterFinalTranscript = input.afterFinalTranscript;
    this.#generateReplyOverride = input.generateReply;
    this.#generateSegmentReplyOverride = input.generateSegmentReply;
    this.#generateMultimodalReplyOverride = input.generateMultimodalReply;
    this.#generateVisualHeartbeatReplyOverride = input.generateVisualHeartbeatReply;
    this.#completeConversationTurn = input.completeConversationTurn;
    this.#markIndeterminateConversationTurn = input.markIndeterminateConversationTurn;
    this.#releaseConversationTurn = input.releaseConversationTurn;
    this.#publishReplyVoice = input.publishReplyVoice;
    this.#observe = input.observe;
    this.#observeFixedStage = input.observeFixedStage;
    this.#observeVideoFixedStage = input.observeVideoFixedStage;
    this.#now = input.now;
    this.#turnContext = input.binding.turnContext;
    this.#roomProfile = assertRoomProfile(input.roomProfile);
    this.#ownsRoomConnection = input.ownsRoomConnection;
    this.#windowSamples = input.windowSamples;
    this.#visualHeartbeatMs = (input.config.visualHeartbeatSeconds ?? 10) * 1_000;
    this.#syntheticPcmEnabled = input.syntheticPcmEnabled;
    this.livekit_url = input.config.clientLivekitUrl.replace(/\/$/u, '');
    this.livekit_token = input.participantToken;
    this.livekit_token_expires_at = new Date(input.participantTokenExpiresAt * 1_000).toISOString();
  }

  static async create(
    config: RayneoRealtimeAudioConfig,
    binding: RayneoRealtimeAudioBinding,
    dependencies: RayneoRealtimeAudioDependencies = {},
  ): Promise<RayneoRealtimeAudioController> {
    const windowSeconds = assertConfig(config);
    const clock = dependencies.now ?? Date.now;
    const now = clock();
    assertBinding(binding, now);
    const syntheticPcmEnabled = dependencies.ownerAliasIssuer !== undefined;
    const issuedAtSeconds = Math.floor(now / 1_000);
    const remainingSeconds = Math.floor(binding.expiresAt / 1_000) - issuedAtSeconds;
    const tokenTtlSeconds = Math.min(
      INITIAL_TOKEN_TTL_CEILING_SECONDS,
      remainingSeconds - TOKEN_CLOCK_SAFETY_SECONDS,
    );
    if (tokenTtlSeconds < 1 || tokenTtlSeconds > INITIAL_TOKEN_TTL_CEILING_SECONDS) {
      throw failure('RAYNEO_LIVEKIT_TOKEN_INVALID');
    }
    const tokenExpiresAtSeconds = issuedAtSeconds + tokenTtlSeconds;
    const participantToken = new AccessToken(config.apiKey, config.apiSecret, {
      identity: binding.deviceId,
      name: 'RayNeo X3 Pro',
      ttl: tokenTtlSeconds,
      attributes: {
        device_id: binding.deviceId,
        device_class: 'rayneo',
        client_instance_id: binding.clientInstanceId,
        session_id: binding.sessionId,
      },
    });
    participantToken.addGrant({
      room: binding.sessionId,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [ServerTrackSource.MICROPHONE, ServerTrackSource.CAMERA],
      canPublishData: syntheticPcmEnabled,
      canSubscribe: true,
    });
    setRegisteredTokenWindow(participantToken, issuedAtSeconds, tokenExpiresAtSeconds);
    const sign = dependencies.signToken ?? ((token: AccessToken) => token.toJwt());
    const participantJwt = await sign(participantToken);
    const participantTokenExpiresAt = assertParticipantToken(
      participantJwt, config, binding, issuedAtSeconds, syntheticPcmEnabled,
    );

    const agentIdentity = `rayneo_agent_${createHash('sha256').update(binding.sessionId).digest('hex').slice(0, 20)}`;
    const agentToken = new AccessToken(config.apiKey, config.apiSecret, {
      identity: agentIdentity,
      name: 'RayNeo Realtime Agent',
      ttl: tokenTtlSeconds,
      attributes: {
        device_id: agentIdentity,
        device_class: 'windows_gateway',
        session_id: binding.sessionId,
      },
    });
    agentToken.addGrant({
      room: binding.sessionId,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    });
    setRegisteredTokenWindow(agentToken, issuedAtSeconds, tokenExpiresAtSeconds);
    const agentJwt = await sign(agentToken);
    assertAgentToken(agentJwt, config, binding, agentIdentity, issuedAtSeconds);
    const room = dependencies.roomFactory?.() ?? createGatewayRoom() as unknown as RoomPort;
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    const diarizer = dependencies.diarizer ?? (
      config.diarizationEndpointUrl === undefined
        ? new DegradedSpeakerDiarization()
        : new SherpaOnnxSidecarDiarization(config.diarizationEndpointUrl, fetchImplementation)
    );
    const controller = new RayneoRealtimeAudioController({
      config, binding, room,
      audioStreamFactory: dependencies.audioStreamFactory ??
        ((track) => new AudioStream(track, { sampleRate: AUDIO_SAMPLE_RATE, numChannels: 1 })),
      fetch: fetchImplementation,
      diarizer,
      finalTranscriptAuthority: dependencies.finalTranscriptAuthority,
      afterFinalTranscript: dependencies.afterFinalTranscript,
      generateReply: dependencies.generateReply,
      generateSegmentReply: dependencies.generateSegmentReply,
      generateMultimodalReply: dependencies.generateMultimodalReply,
      generateVisualHeartbeatReply: dependencies.generateVisualHeartbeatReply,
      completeConversationTurn: dependencies.completeConversationTurn,
      markIndeterminateConversationTurn: dependencies.markIndeterminateConversationTurn,
      releaseConversationTurn: dependencies.releaseConversationTurn,
      publishReplyVoice: dependencies.publishReplyVoice ?? publishReplyVoice,
      observe: dependencies.observe ?? (() => undefined),
      observeFixedStage: dependencies.observeFixedStage ?? defaultObserveFixedStage,
      observeVideoFixedStage: dependencies.observeVideoFixedStage ??
        ((stage) => console.info(`rayneo_realtime_video_stage=${stage}`)),
      now: clock,
      windowSamples: AUDIO_SAMPLE_RATE * windowSeconds,
      participantToken: participantJwt,
      participantTokenExpiresAt,
      syntheticPcmEnabled,
      roomProfile: dependencies.roomProfile ?? Object.freeze({ kind: 'rayneo' as const }),
      ownsRoomConnection: true,
    });
    controller.#bindRoomEvents();
    try {
      await room.connect(config.livekitUrl, agentJwt);
      const videoBridgeFactory = dependencies.videoBridgeFactory ?? (
        room instanceof Room
          ? (roomPort: RayneoRealtimeVideoRoom, videoBinding: RayneoRealtimeVideoBinding,
            observeVideoStage: (stage: RayneoRealtimeVideoDiagnosticStage) => void) =>
            createRayneoRealtimeVideoBridge(roomPort, videoBinding, observeVideoStage)
          : undefined
      );
      if (videoBridgeFactory !== undefined) {
        try {
          controller.#videoBridge = await videoBridgeFactory(
            room as unknown as RayneoRealtimeVideoRoom,
            {
              sessionId: binding.sessionId,
              deviceId: binding.deviceId,
              clientInstanceId: binding.clientInstanceId,
            },
            controller.#observeVideoFixedStage,
          );
        } catch {
          try { controller.#observeVideoFixedStage('VIDEO_BRIDGE_FAILED'); } catch { /* diagnostics */ }
        }
      }
      if (dependencies.ownerAliasIssuer !== undefined) {
        const participantClaims = decodeJwtPayload(participantJwt);
        const participantGrant = participantClaims.video;
        const grantRoom = participantGrant !== null && typeof participantGrant === 'object' &&
          !Array.isArray(participantGrant) ? (participantGrant as Record<string, unknown>).room : undefined;
        const participantSubject = participantClaims.sub;
        if (typeof grantRoom !== 'string' || typeof participantSubject !== 'string') {
          throw failure('RAYNEO_LIVEKIT_OWNER_ALIAS_INPUT_INVALID');
        }
        const tokenIssuedAt = new Date(issuedAtSeconds * 1_000).toISOString();
        const tokenExpiresAt = new Date(participantTokenExpiresAt * 1_000).toISOString();
        const issueInput = {
          livekitServerUrl: config.livekitUrl,
          livekitClientUrl: config.clientLivekitUrl,
          grantRoom,
          participantSubject,
          sessionId: binding.sessionId,
          deviceId: binding.deviceId,
          clientInstanceId: binding.clientInstanceId,
          issuedAt: tokenIssuedAt,
          tokenExpiresAt,
          participantTokenSha256: createHash('sha256').update(participantJwt, 'utf8').digest('hex'),
        };
        const receipt = assertRayneoLiveKitOwnerAliasReceipt(
          dependencies.ownerAliasIssuer.issue(issueInput), issueInput,
        );
        const ownerIssuance: RayneoRealtimeOwnerIssuanceProjection = Object.freeze({
          sessionId: binding.sessionId,
          deviceId: binding.deviceId,
          clientInstanceId: binding.clientInstanceId,
          tokenIssuedAt,
          tokenExpiresAt,
          receipt,
        });
        Object.defineProperty(controller, RAYNEO_REALTIME_OWNER_ISSUANCE, {
          value: ownerIssuance, enumerable: false, writable: false, configurable: false,
        });
      }
      return controller;
    } catch (error) {
      await room.disconnect().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Bind the production audio handler to a room owned by Public Control.  This
   * deliberately does not issue a token, call connect, or take ownership of
   * room disconnect; the existing participant remains the sole transport owner.
   */
  static async attachExistingRoom(
    config: RayneoRealtimeAudioConfig,
    binding: RayneoRealtimeAudioBinding,
    room: RayneoRealtimeAudioExistingRoomPort,
    dependencies: RayneoRealtimeAudioDependencies = {},
  ): Promise<RayneoRealtimeAudioController> {
    const windowSeconds = assertConfig(config);
    const clock = dependencies.now ?? Date.now;
    const profile = assertRoomProfile(dependencies.roomProfile ?? Object.freeze({
      kind: 'public-assistant' as const,
      participantIdentity: binding.deviceId,
    }));
    assertBinding(binding, clock(), profile.kind === 'public-assistant');
    if (room === null || typeof room !== 'object' || typeof room.on !== 'function' ||
        room.localParticipant === undefined || typeof room.disconnect !== 'function') {
      throw failure('RAYNEO_REALTIME_ROOM_PORT_INVALID');
    }
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    const diarizer = dependencies.diarizer ?? (
      config.diarizationEndpointUrl === undefined
        ? new DegradedSpeakerDiarization()
        : new SherpaOnnxSidecarDiarization(config.diarizationEndpointUrl, fetchImplementation)
    );
    const controller = new RayneoRealtimeAudioController({
      config,
      binding,
      room: room as RayneoRealtimeAudioRoomPort,
      audioStreamFactory: dependencies.audioStreamFactory ??
        ((track) => new AudioStream(track, { sampleRate: AUDIO_SAMPLE_RATE, numChannels: 1 })),
      fetch: fetchImplementation,
      diarizer,
      finalTranscriptAuthority: dependencies.finalTranscriptAuthority,
      afterFinalTranscript: dependencies.afterFinalTranscript,
      generateReply: dependencies.generateReply,
      generateSegmentReply: dependencies.generateSegmentReply,
      generateMultimodalReply: dependencies.generateMultimodalReply,
      generateVisualHeartbeatReply: dependencies.generateVisualHeartbeatReply,
      completeConversationTurn: dependencies.completeConversationTurn,
      markIndeterminateConversationTurn: dependencies.markIndeterminateConversationTurn,
      releaseConversationTurn: dependencies.releaseConversationTurn,
      publishReplyVoice: dependencies.publishReplyVoice ?? publishReplyVoice,
      observe: dependencies.observe ?? (() => undefined),
      observeFixedStage: dependencies.observeFixedStage ?? defaultObserveFixedStage,
      observeVideoFixedStage: dependencies.observeVideoFixedStage ??
        ((stage) => console.info(`rayneo_realtime_video_stage=${stage}`)),
      now: clock,
      windowSamples: AUDIO_SAMPLE_RATE * windowSeconds,
      participantToken: '',
      participantTokenExpiresAt: Math.floor(binding.expiresAt / 1_000),
      syntheticPcmEnabled: false,
      roomProfile: profile,
      ownsRoomConnection: false,
    });
    controller.#bindRoomEvents();
    if (profile.kind === 'public-assistant' && profile.videoEnabled === true) {
      const videoBridgeFactory = dependencies.videoBridgeFactory ?? (
        (roomPort: RayneoRealtimeVideoRoom, videoBinding: RayneoRealtimeVideoBinding,
          observeVideoStage: (stage: RayneoRealtimeVideoDiagnosticStage) => void,
          onSample?: (sample: RayneoRealtimeVideoSample) => void | Promise<void>) =>
          createRayneoRealtimeVideoBridge(
            roomPort,
            { ...videoBinding, mode: 'public-assistant', participantIdentity: profile.participantIdentity },
            observeVideoStage,
            undefined,
            clock,
            onSample,
          )
      );
      try {
        controller.#videoBridge = await videoBridgeFactory(
          room as unknown as RayneoRealtimeVideoRoom,
          {
            sessionId: binding.sessionId,
            deviceId: binding.deviceId,
            clientInstanceId: binding.clientInstanceId,
            mode: 'public-assistant',
            participantIdentity: profile.participantIdentity,
          },
          controller.#observeVideoFixedStage,
          (sample) => controller.#handleVideoSample(sample),
        );
      } catch {
        try { controller.#observeVideoFixedStage('VIDEO_BRIDGE_FAILED'); } catch { /* diagnostics */ }
      }
    }
    return controller;
  }

  #bindRoomEvents(): void {
    if (this.#roomListenersBound) return;
    this.#trackSubscribedListener = ((
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => this.#onTrackSubscribed(track, publication, participant)) as never;
    this.#trackUnsubscribedListener = ((
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (this.#participantMatches(participant) && this.#activeTrack?.track === track) {
        this.#stopActiveTrack();
      }
    }) as never;
    this.#participantDisconnectedListener = ((participant: RemoteParticipant) => {
      if (this.#participantMatches(participant)) this.#stopActiveTrack();
    }) as never;
    this.#roomDisconnectedListener = (() => {
      this.#roomDisconnected = true;
      this.#closed = true;
      this.#sessionAbort.abort();
      this.#videoVisualAbort?.abort();
      this.#stopActiveTrack();
    }) as never;
    this.#room.on(RoomEvent.TrackSubscribed, this.#trackSubscribedListener);
    this.#room.on(RoomEvent.TrackUnsubscribed, this.#trackUnsubscribedListener);
    this.#room.on(RoomEvent.ParticipantDisconnected, this.#participantDisconnectedListener);
    this.#room.on(RoomEvent.Disconnected, this.#roomDisconnectedListener);
    this.#roomListenersBound = true;
    if (this.#syntheticPcmEnabled) {
      if (typeof this.#room.registerTextStreamHandler !== 'function') {
        throw failure('RAYNEO_REALTIME_ROOM_TEXT_STREAM_UNAVAILABLE');
      }
      this.#room.registerTextStreamHandler(SYNTHETIC_PCM_TOPIC, (reader, participant) => {
        void this.#handleSyntheticPcmStream(reader, participant.identity);
      });
      this.#syntheticPcmHandlerRegistered = true;
    }
  }

  #unbindRoomEvents(): void {
    if (!this.#roomListenersBound) return;
    const listeners: readonly (readonly [string, ((...args: never[]) => void) | undefined])[] = [
      [RoomEvent.TrackSubscribed, this.#trackSubscribedListener],
      [RoomEvent.TrackUnsubscribed, this.#trackUnsubscribedListener],
      [RoomEvent.ParticipantDisconnected, this.#participantDisconnectedListener],
      [RoomEvent.Disconnected, this.#roomDisconnectedListener],
    ];
    for (const [event, listener] of listeners) {
      if (listener === undefined) continue;
      try {
        if (typeof this.#room.off === 'function') this.#room.off(event, listener);
        else this.#room.removeListener?.(event, listener);
      } catch { /* generation/closed fences late callbacks */ }
    }
    this.#trackSubscribedListener = undefined;
    this.#trackUnsubscribedListener = undefined;
    this.#participantDisconnectedListener = undefined;
    this.#roomDisconnectedListener = undefined;
    this.#roomListenersBound = false;
  }

  #participantMatches(participant: RemoteParticipant): boolean {
    if (this.#roomProfile.kind === 'public-assistant') {
      return participant.identity === this.#roomProfile.participantIdentity;
    }
    return participant.identity === this.#binding.deviceId;
  }

  #onTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    this.#emitFixedStage('REMOTE_MIC_TRACK_CALLBACK');
    if (this.#closed) {
      this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_CLOSED');
      return;
    }
    if (this.#seenTracks.has(track as object)) {
      this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_DUPLICATE');
      return;
    }
    if (!this.#participantMatches(participant)) {
      this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_IDENTITY');
      return;
    }
    if (this.#roomProfile.kind === 'rayneo') {
      if (participant.attributes.device_id !== this.#binding.deviceId ||
        participant.attributes.device_class !== 'rayneo' ||
        participant.attributes.client_instance_id !== this.#binding.clientInstanceId ||
        participant.attributes.session_id !== this.#binding.sessionId) {
        this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_ATTRIBUTES');
        return;
      }
    }
    if (this.#roomProfile.kind === 'public-assistant' &&
        this.#roomProfile.audioEnabled === false && publication.kind === TrackKind.KIND_AUDIO) {
      this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_KIND');
      return;
    }
    if (publication.kind !== TrackKind.KIND_AUDIO) {
      this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_KIND');
      return;
    }
    if (publication.source !== TrackSource.SOURCE_MICROPHONE) {
      this.#emitFixedStage('REMOTE_MIC_TRACK_REJECTED_SOURCE');
      return;
    }
    this.#seenTracks.add(track as object);
    this.#emitFixedStage('REMOTE_MIC_TRACK_SUBSCRIBED');
    this.#stopActiveTrack();
    const active: ActiveTrack = {
      track,
      abort: new AbortController(),
      frameObserved: false,
      signalObserved: false,
    };
    this.#activeTrack = active;
    this.#observe({ stage: 'TRACK_STARTED', sessionId: this.#binding.sessionId });
    active.completion = this.#consumeTrack(active).catch((error: unknown) => {
      if (!active.abort.signal.aborted && !this.#closed) {
        this.#observe({
          stage: 'TRACK_ERROR', sessionId: this.#binding.sessionId, errorCode: errorCode(error),
        });
      }
    }).finally(() => {
      if (this.#activeTrack === active) this.#activeTrack = undefined;
      this.#observe({ stage: 'TRACK_STOPPED', sessionId: this.#binding.sessionId });
    });
    const pending = this.#syntheticPcmPending;
    this.#syntheticPcmPending = undefined;
    if (pending !== undefined) {
      void this.#runSyntheticPcm(pending, active);
    }
  }

  async #handleSyntheticPcmStream(
    reader: TextStreamReaderPort,
    senderIdentity: string,
  ): Promise<void> {
    if (!this.#syntheticPcmEnabled || this.#closed) {
      this.#observeSyntheticPcmError('RAYNEO_SYNTHETIC_PCM_STREAM_CLOSED');
      return;
    }
    if (senderIdentity !== this.#binding.deviceId) {
      this.#observeSyntheticPcmError('RAYNEO_SYNTHETIC_PCM_SENDER_INVALID');
      return;
    }
    let text: string;
    try {
      text = await reader.readAll();
    } catch {
      this.#observeSyntheticPcmError('RAYNEO_SYNTHETIC_PCM_STREAM_READ_FAILED');
      return;
    }
    if (this.#closed) {
      this.#observeSyntheticPcmError('RAYNEO_SYNTHETIC_PCM_STREAM_CLOSED');
      return;
    }
    let pcm: Int16Array;
    try {
      pcm = decodeSyntheticPcmEnvelope(text, this.#binding);
    } catch (error) {
      this.#observeSyntheticPcmError(errorCode(error));
      return;
    }
    if (this.#syntheticPcmClaimed) {
      pcm.fill(0);
      this.#observeSyntheticPcmError('RAYNEO_SYNTHETIC_PCM_DUPLICATE');
      return;
    }
    this.#syntheticPcmClaimed = true;
    this.#emitFixedStage('TEXT_STREAM_ACCEPTED');
    const active = this.#activeTrack;
    if (active === undefined) {
      if (this.#syntheticPcmPending !== undefined) this.#syntheticPcmPending.fill(0);
      this.#syntheticPcmPending = pcm;
      return;
    }
    await this.#runSyntheticPcm(pcm, active);
  }

  #observeSyntheticPcmError(code: string): void {
    this.#observe({
      stage: 'TRACK_ERROR',
      sessionId: this.#binding.sessionId,
      errorCode: code,
    });
  }

  async #runSyntheticPcm(pcm: Int16Array, active: ActiveTrack): Promise<void> {
    if (this.#closed || this.#activeTrack !== active) {
      pcm.fill(0);
      this.#observeSyntheticPcmError('RAYNEO_SYNTHETIC_PCM_TRACK_NOT_READY');
      return;
    }
    this.#stopActiveTrack();
    await active.completion?.catch(() => undefined);
    if (this.#closed) {
      pcm.fill(0);
      return;
    }
    const syntheticActive: ActiveTrack = {
      track: active.track,
      abort: new AbortController(),
      frameObserved: active.frameObserved,
      signalObserved: active.signalObserved,
    };
    this.#activeTrack = syntheticActive;
    const completion = (async () => {
      try {
        this.#ensureMediaTimelineOrigin();
        if (!syntheticActive.frameObserved) {
          syntheticActive.frameObserved = true;
          this.#emitFixedStage('AUDIO_FRAME_OBSERVED');
        }
        if (!syntheticActive.signalObserved && hasConservativeAudioSignal(pcm)) {
          syntheticActive.signalObserved = true;
          this.#emitFixedStage('AUDIO_SIGNAL_OBSERVED');
        }
        await this.#processBatch(pcm, syntheticActive);
      } finally {
        pcm.fill(0);
        syntheticActive.abort.abort();
        if (this.#activeTrack === syntheticActive) this.#activeTrack = undefined;
      }
    })();
    syntheticActive.completion = completion;
    await completion;
  }

  #stopActiveTrack(): void {
    const active = this.#activeTrack;
    if (!active) return;
    active.abort.abort();
    const iterator = active.iterator;
    if (iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* best effort */ }
    }
    this.#activeTrack = undefined;
  }

  #emitFixedStage(stage: RayneoRealtimeAudioDiagnosticStage): void {
    try {
      this.#observeFixedStage(stage);
    } catch {
      // Fixed diagnostics must never alter media, model, or cleanup semantics.
    }
  }

  async #consumeTrack(active: ActiveTrack): Promise<void> {
    const stream = this.#audioStreamFactory(active.track);
    const iterator = stream[Symbol.asyncIterator]();
    active.iterator = iterator;
    let window = new Int16Array(this.#windowSamples);
    let written = 0;
    try {
      while (!active.abort.signal.aborted && !this.#closed) {
        const item = await iterator.next();
        if (item.done) break;
        const frame = item.value;
        if (
          !(frame.data instanceof Int16Array) ||
          frame.sampleRate !== AUDIO_SAMPLE_RATE ||
          frame.channels !== AUDIO_CHANNELS ||
          frame.samplesPerChannel !== frame.data.length ||
          frame.samplesPerChannel < 1
        ) throw failure('RAYNEO_AUDIO_FRAME_INVALID');
        this.#ensureMediaTimelineOrigin();
        if (!active.frameObserved) {
          active.frameObserved = true;
          this.#emitFixedStage('AUDIO_FRAME_OBSERVED');
        }
        if (!active.signalObserved && hasConservativeAudioSignal(frame.data)) {
          active.signalObserved = true;
          this.#emitFixedStage('AUDIO_SIGNAL_OBSERVED');
        }
        let offset = 0;
        while (offset < frame.data.length && !active.abort.signal.aborted && !this.#closed) {
          const count = Math.min(window.length - written, frame.data.length - offset);
          window.set(frame.data.subarray(offset, offset + count), written);
          written += count;
          offset += count;
          if (written === window.length) {
            const batch = window;
            window = new Int16Array(this.#windowSamples);
            written = 0;
            await this.#processBatch(batch, active);
            batch.fill(0);
          }
        }
      }
    } finally {
      window.fill(0);
      delete active.iterator;
      if (iterator.return) {
        try { await iterator.return(); } catch { /* terminal cleanup */ }
      }
    }
  }

  #ensureMediaTimelineOrigin(): number {
    if (this.#mediaTimelineOriginMs !== undefined) return this.#mediaTimelineOriginMs;
    const origin = this.#now();
    if (!Number.isSafeInteger(origin) || origin < this.#binding.openedAt || origin >= this.#binding.expiresAt) {
      throw failure('RAYNEO_MEDIA_TIMELINE_ORIGIN_INVALID');
    }
    this.#mediaTimelineOriginMs = origin;
    return origin;
  }

  #mediaWindow(windowSequence: number): Readonly<{
    startMs: number;
    endMs: number;
    absoluteStartMs: number;
    absoluteEndMs: number;
  }> {
    if (!Number.isSafeInteger(windowSequence) || windowSequence < 1) {
      throw failure('RAYNEO_MEDIA_TIMELINE_INVALID');
    }
    const origin = this.#mediaTimelineOriginMs;
    if (origin === undefined) throw failure('RAYNEO_MEDIA_TIMELINE_INVALID');
    const durationMs = Math.round(this.#windowSamples * 1_000 / AUDIO_SAMPLE_RATE);
    const absoluteStartMs = origin + (windowSequence - 1) * durationMs;
    const absoluteEndMs = absoluteStartMs + durationMs;
    const startMs = absoluteStartMs - this.#binding.openedAt;
    const endMs = absoluteEndMs - this.#binding.openedAt;
    if (![absoluteStartMs, absoluteEndMs, startMs, endMs].every(Number.isSafeInteger) ||
        startMs < 0 || endMs <= startMs) {
      throw failure('RAYNEO_MEDIA_TIMELINE_INVALID');
    }
    return Object.freeze({ startMs, endMs, absoluteStartMs, absoluteEndMs });
  }

  #readVideoSamples(
    startMs: number,
    endMs: number,
    maxSamples: number,
  ): readonly RayneoRealtimeVideoSample[] {
    const bridge = this.#videoBridge;
    const origin = this.#mediaTimelineOriginMs;
    if (bridge === undefined || origin === undefined || !Number.isSafeInteger(startMs) ||
        !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs ||
        !Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 2) {
      return Object.freeze([]);
    }
    const absoluteStartMs = this.#binding.openedAt + startMs;
    const absoluteEndMs = this.#binding.openedAt + endMs;
    if (!Number.isSafeInteger(absoluteStartMs) || !Number.isSafeInteger(absoluteEndMs) ||
        absoluteStartMs < origin || absoluteEndMs <= absoluteStartMs ||
        absoluteEndMs > this.#binding.expiresAt) {
      return Object.freeze([]);
    }
    const selected: RayneoRealtimeVideoSample[] = [];
    let previousObservedAt = -1;
    for (const sample of bridge.readSamples(absoluteStartMs, absoluteEndMs, maxSamples)) {
      const accepted = Number.isSafeInteger(sample.observedAtMs) &&
        sample.observedAtMs >= origin &&
        sample.observedAtMs >= absoluteStartMs - VIDEO_SAMPLE_WINDOW_TOLERANCE_MS &&
        sample.observedAtMs <= absoluteEndMs + VIDEO_SAMPLE_WINDOW_TOLERANCE_MS &&
        sample.observedAtMs < this.#binding.expiresAt &&
        sample.observedAtMs > previousObservedAt &&
        selected.length < maxSamples;
      if (!accepted) {
        sample.bytes.fill(0);
        continue;
      }
      previousObservedAt = sample.observedAtMs;
      selected.push(sample);
    }
    return Object.freeze(selected);
  }

  #replyDestinationIdentity(): string {
    return this.#roomProfile.kind === 'public-assistant'
      ? this.#roomProfile.participantIdentity
      : this.#binding.deviceId;
  }

  #replyDataEnabled(): boolean {
    return this.#roomProfile.kind !== 'public-assistant' || this.#roomProfile.dataEnabled !== false;
  }

  #replyTopic(): string {
    return this.#roomProfile.kind === 'public-assistant' ? ASSISTANT_RESULT_TOPIC : REPLY_TOPIC;
  }

  #replyPayload(input: Readonly<{
    readonly segmentId: string;
    readonly sequence: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly speakerLabel: string;
    readonly diarizationStatus: 'window_local' | 'degraded';
    readonly transcript: string;
    readonly reply: string;
  }>): Readonly<Record<string, unknown>> {
    if (this.#roomProfile.kind === 'public-assistant') {
      return Object.freeze({
        stream_id: input.segmentId,
        sequence: input.sequence,
        text: input.reply,
        is_final: true,
      });
    }
    return Object.freeze({
      type: REPLY_TYPE,
      session_id: this.#binding.sessionId,
      segment_id: input.segmentId,
      sequence: input.sequence,
      start_ms: input.startMs,
      end_ms: input.endMs,
      speaker_label: input.speakerLabel,
      diarization_status: input.diarizationStatus,
      transcript: input.transcript,
      reply: input.reply,
      final: true,
    });
  }

  async #processBatch(pcm: Int16Array, active: ActiveTrack): Promise<void> {
    this.#assertActive(active);
    this.#emitFixedStage('WINDOW_READY');
    const windowSequence = ++this.#windowSequence;
    this.#speakerLabels.clear();
    this.#observe({ stage: 'AUDIO_BATCH', sessionId: this.#binding.sessionId, sequence: windowSequence });
    const diarization = await boundedOperation(
      active.abort.signal,
      this.#config.diarizationDeadlineMs ?? 8_000,
      (signal) => this.#diarizer.diarize({
        sessionId: this.#binding.sessionId, pcm, sampleRate: AUDIO_SAMPLE_RATE,
      }, signal),
      'RAYNEO_DIARIZATION_DEADLINE_EXCEEDED',
    ).catch(() => Object.freeze({ status: 'degraded' as const }));
    this.#assertActive(active);
    const turns = this.#turns(pcm, diarization);
    let acceptedTranscript = false;
    this.#emitFixedStage(turns.some((turn) => turn.diarizationStatus === 'window_local')
      ? 'DIARIZATION_WINDOW_LOCAL'
      : 'DIARIZATION_DEGRADED');
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      this.#assertActive(active);
      const turn = turns[turnIndex]!;
      const turnPcm = pcm.slice(turn.startSample, turn.endSample);
      try {
        let transcript: string | undefined;
        this.#emitFixedStage('STT_REQUESTED');
        try {
          transcript = await this.#transcribe(turnPcm, active.abort.signal);
        } catch (error) {
          this.#emitFixedStage('STT_FAILED');
          this.#observe({
            stage: 'TRACK_ERROR', sessionId: this.#binding.sessionId, errorCode: errorCode(error),
          });
          continue;
        }
        this.#assertActive(active);
        if (transcript === undefined) {
          this.#emitFixedStage('STT_EMPTY');
          continue;
        }
        this.#emitFixedStage('STT_ACCEPTED');
        acceptedTranscript = true;
        const sequence = this.#sequence + 1;
        this.#observe({ stage: 'STT_FINAL', sessionId: this.#binding.sessionId, sequence });
        this.#observe({
          stage: turn.diarizationStatus === 'window_local' ? 'DIARIZATION_MATCHED' : 'DIARIZATION_DEGRADED',
          sessionId: this.#binding.sessionId,
          sequence,
        });
        const window = this.#mediaWindow(windowSequence);
        const startMs = window.startMs + Math.round(turn.startSample * 1_000 / AUDIO_SAMPLE_RATE);
        const endMs = window.startMs + Math.round(turn.endSample * 1_000 / AUDIO_SAMPLE_RATE);
        if (
          startMs < 0 || endMs <= startMs || endMs - startMs > 10_000 ||
          endMs > this.#binding.expiresAt - this.#binding.openedAt
        ) continue;
        const segmentId = `rayneo_segment_${createHash('sha256').update([
          this.#binding.sessionId, String(windowSequence), String(turnIndex),
          String(startMs), String(endMs),
        ].join('\u0000')).digest('hex').slice(0, 20)}`;
        if (this.#finalTranscriptAuthority !== undefined) {
          const mediaBytes = new Uint8Array(turnPcm.length * 2);
          const view = new DataView(mediaBytes.buffer, mediaBytes.byteOffset, mediaBytes.byteLength);
          for (let sample = 0; sample < turnPcm.length; sample += 1) {
            view.setInt16(sample * 2, turnPcm[sample]!, true);
          }
          const authorityInput: RayneoFinalTranscriptAuthorityInput = Object.freeze({
            sessionId: this.#binding.sessionId,
            deviceId: this.#binding.deviceId,
            clientInstanceId: this.#binding.clientInstanceId,
            segmentId,
            startMs,
            endMs,
            speakerLabel: turn.speakerLabel,
            diarizationStatus: turn.diarizationStatus,
            transcript,
            language: 'und',
            observedAt: new Date(this.#binding.openedAt + endMs).toISOString(),
            media: Object.freeze({
              format: 'pcm_s16le' as const,
              sampleRate: AUDIO_SAMPLE_RATE,
              channels: AUDIO_CHANNELS,
              sha256: createHash('sha256').update(mediaBytes).digest('hex'),
              bytes: mediaBytes,
            }),
          });
          try {
            const committedEvidence = this.#finalTranscriptAuthority.finalizeWithEvidence === undefined
              ? undefined
              : await this.#finalTranscriptAuthority.finalizeWithEvidence(authorityInput);
            if (this.#finalTranscriptAuthority.finalizeWithEvidence === undefined) {
              await this.#finalTranscriptAuthority.finalize(authorityInput);
            }
            if (this.#afterFinalTranscript !== undefined) {
              if (committedEvidence === undefined) throw failure('RAYNEO_FINAL_TRANSCRIPT_EVIDENCE_RESULT_REQUIRED');
              await this.#afterFinalTranscript(Object.freeze({
                input: Object.freeze({
                  sessionId: authorityInput.sessionId,
                  deviceId: authorityInput.deviceId,
                  clientInstanceId: authorityInput.clientInstanceId,
                  segmentId: authorityInput.segmentId,
                  startMs: authorityInput.startMs,
                  endMs: authorityInput.endMs,
                  speakerLabel: authorityInput.speakerLabel,
                  diarizationStatus: authorityInput.diarizationStatus,
                  transcript: authorityInput.transcript,
                  language: authorityInput.language,
                  observedAt: authorityInput.observedAt,
                }),
                evidence: committedEvidence,
              }));
            }
          } catch (error) {
            this.#observe({
              stage: 'TRACK_ERROR', sessionId: this.#binding.sessionId, errorCode: errorCode(error),
            });
            continue;
          } finally {
            mediaBytes.fill(0);
          }
          this.#assertActive(active);
          this.#emitFixedStage('FINAL_TRANSCRIPT_COMMITTED');
          this.#observe({ stage: 'FINAL_TRANSCRIPT_COMMITTED', sessionId: this.#binding.sessionId, sequence });
        }
        let generatedReply: RayneoGeneratedReply;
        try {
         const segmentReply = this.#generateSegmentReplyOverride;
         generatedReply = segmentReply === undefined
           ? await this.#generateReply(segmentId, transcript, turn.speakerLabel, startMs, endMs, active.abort.signal)
           : await segmentReply(segmentId, transcript, turn.speakerLabel, active.abort.signal);
        } catch (error) {
          await this.#releaseConversationTurn?.(segmentId).catch(() => undefined);
          this.#observe({
            stage: 'TRACK_ERROR', sessionId: this.#binding.sessionId, errorCode: errorCode(error),
          });
          continue;
        }
        const voice = spokenReply(generatedReply);
        const reply = typeof generatedReply === 'string' ? generatedReply : generatedReply.text;
        this.#assertActive(active);
         const payload = this.#replyPayload({
           segmentId, sequence, startMs, endMs, speakerLabel: turn.speakerLabel,
           diarizationStatus: turn.diarizationStatus, transcript, reply,
         });
        let textSend: Promise<void> = Promise.resolve();
        let publishAttempted = false;
        try {
          publishAttempted = true;
          textSend = this.#replyDataEnabled()
            ? publishReplyText(this.#room, payload, this.#replyTopic(), this.#replyDestinationIdentity())
            : Promise.resolve();
          if (voice === undefined) await textSend;
          else await Promise.all([textSend, this.#publishReplyVoice(Object.freeze({
            room: this.#room, reply: voice, sequence, signal: active.abort.signal,
          }))]);
        } catch (error) {
          if (publishAttempted) {
            await this.#markIndeterminateConversationTurn?.(segmentId, reply).catch(() => undefined);
          } else {
            await this.#releaseConversationTurn?.(segmentId).catch(() => undefined);
          }
          throw error;
        } finally {
          voice?.pcm.fill(0);
        }
        await this.#completeConversationTurn?.(segmentId, reply);
        this.#assertActive(active);
        this.#emitFixedStage('REPLY_SENT');
        this.#turnContext?.appendRealtime(segmentId, turn.speakerLabel, transcript, reply);
        this.#sequence = sequence;
        this.#observe({ stage: 'REPLY_SENT', sessionId: this.#binding.sessionId, sequence });
      } finally {
        turnPcm.fill(0);
      }
    }
    if (!acceptedTranscript) {
      try {
        await this.#sendVisualHeartbeat(windowSequence, active);
      } catch (error) {
        this.#observe({
          stage: 'TRACK_ERROR', sessionId: this.#binding.sessionId, errorCode: errorCode(error),
        });
      }
    }
  }

  async #generateVisualHeartbeatReply(
    input: RayneoRealtimeVisualHeartbeatInput,
    signal: AbortSignal,
  ): Promise<RayneoGeneratedReply> {
    this.#emitFixedStage('VIDEO_CONTEXT_APPLIED');
    if (this.#generateVisualHeartbeatReplyOverride !== undefined) {
      return await boundedOperation(
        signal,
        this.#config.ollamaDeadlineMs ?? 10_000,
        (requestSignal) => this.#generateVisualHeartbeatReplyOverride!(input, requestSignal),
        'RAYNEO_OLLAMA_DEADLINE_EXCEEDED',
      );
    }
    return await boundedOperation(
      signal,
      this.#config.ollamaDeadlineMs ?? 10_000,
      async (requestSignal) => {
        const context = this.#turnContext?.snapshot();
        const content = [
          {
            type: 'text' as const,
            text: `${context === undefined || context.length === 0 ? '' : `会话上下文：\n${context}\n`}当前窗口没有可靠语音。请仅根据按时间排列的画面，简短说明正在发生什么及不确定项。`,
          },
          ...input.videoSamples.map((sample) => Object.freeze({
            type: 'image_url' as const,
            image_url: Object.freeze({
              url: `data:${sample.mimeType};base64,${Buffer.from(sample.bytes).toString('base64')}`,
            }),
          })),
        ];
        const response = await this.#fetch(`${this.#config.ollamaEndpointUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.#config.ollamaModel,
            reasoning_effort: 'none',
            temperature: 0,
            max_tokens: 96,
            messages: [
              {
                role: 'system',
                content: '你是眼镜上的实时私人助理。只用简体中文最多两句描述可观察画面；不要推理过程，不要读心，不要前缀。',
              },
              { role: 'user', content },
            ],
            stream: false,
          }),
          signal: requestSignal,
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (response.status < 200 || response.status >= 300 || response.redirected) {
          throw failure('RAYNEO_OLLAMA_HTTP_REJECTED');
        }
        return replyText(await response.json());
      },
      'RAYNEO_OLLAMA_DEADLINE_EXCEEDED',
    );
  }

  async #sendVisualHeartbeat(windowSequence: number, active: ActiveTrack): Promise<void> {
    this.#assertActive(active);
    const { startMs, endMs } = this.#mediaWindow(windowSequence);
    if (endMs > this.#binding.expiresAt - this.#binding.openedAt ||
        this.#lastVisualHeartbeatEndMs >= 0 &&
        endMs - this.#lastVisualHeartbeatEndMs < this.#visualHeartbeatMs) return;
    const videoSamples = this.#readVideoSamples(startMs, endMs, 2);
    if (videoSamples.length === 0) return;
    const segmentId = `rayneo_segment_${createHash('sha256').update([
      'visual-heartbeat', this.#binding.sessionId, String(windowSequence), String(startMs), String(endMs),
    ].join('\u0000')).digest('hex').slice(0, 20)}`;
    const heartbeatInput: RayneoRealtimeVisualHeartbeatInput = Object.freeze({
      segmentId, startMs, endMs, videoSamples: Object.freeze(videoSamples),
    });
    let generatedReply: RayneoGeneratedReply;
    let durableReply = '模型输出未完成。';
    let publishAttempted = false;
    try {
      generatedReply = await this.#generateVisualHeartbeatReply(heartbeatInput, active.abort.signal);
      const voice = spokenReply(generatedReply);
      const reply = typeof generatedReply === 'string' ? generatedReply : generatedReply.text;
      durableReply = reply;
      this.#assertActive(active);
      const sequence = this.#sequence + 1;
       const textSend = this.#replyDataEnabled()
         ? publishReplyText(
           this.#room,
           this.#replyPayload({
             segmentId, sequence, startMs, endMs, speakerLabel: 'speaker_unknown',
             diarizationStatus: 'degraded', transcript: '', reply,
           }),
           this.#replyTopic(),
           this.#replyDestinationIdentity(),
         )
         : Promise.resolve();
      try {
        publishAttempted = true;
        if (voice === undefined) await textSend;
        else await Promise.all([textSend, this.#publishReplyVoice(Object.freeze({
          room: this.#room, reply: voice, sequence, signal: active.abort.signal,
        }))]);
      } finally {
        voice?.pcm.fill(0);
      }
      await this.#completeConversationTurn?.(segmentId, reply);
      this.#assertActive(active);
      this.#sequence = sequence;
      this.#lastVisualHeartbeatEndMs = endMs;
      this.#emitFixedStage('VISUAL_HEARTBEAT_SENT');
      this.#emitFixedStage('REPLY_SENT');
      this.#observe({ stage: 'REPLY_SENT', sessionId: this.#binding.sessionId, sequence });
    } catch (error) {
      if (publishAttempted) await this.#markIndeterminateConversationTurn?.(segmentId, durableReply).catch(() => undefined);
      else await this.#releaseConversationTurn?.(segmentId).catch(() => undefined);
      throw error;
    } finally {
      for (const sample of videoSamples) sample.bytes.fill(0);
    }
  }

  async #handleVideoSample(sample: RayneoRealtimeVideoSample): Promise<void> {
    try {
      if (this.#closed || this.#sessionAbort.signal.aborted || this.#roomProfile.kind !== 'public-assistant' ||
          this.#roomProfile.videoEnabled !== true ||
          !Number.isSafeInteger(sample.observedAtMs) || sample.observedAtMs < this.#binding.openedAt ||
          sample.observedAtMs >= this.#binding.expiresAt || sample.bytes.byteLength === 0 ||
          sample.bytes.byteLength > 2_000_000) return;
      if (this.#videoVisualFlight !== undefined ||
          this.#lastVideoVisualAtMs >= 0 && sample.observedAtMs - this.#lastVideoVisualAtMs < this.#visualHeartbeatMs) return;
      const startMs = sample.observedAtMs - this.#binding.openedAt;
      const endMs = Math.min(startMs + 2_000, this.#binding.expiresAt - this.#binding.openedAt);
      if (startMs < 0 || endMs <= startMs) return;
      this.#lastVideoVisualAtMs = sample.observedAtMs;
      const ownedBytes = sample.bytes.slice();
      const contentSha256 = createHash('sha256').update(ownedBytes).digest('hex');
      const segmentId = `rayneo_segment_${createHash('sha256').update([
        'public-video', this.#binding.sessionId, String(sample.observedAtMs), contentSha256,
      ].join('\u0000')).digest('hex').slice(0, 20)}`;
      const input: RayneoRealtimeVisualHeartbeatInput = Object.freeze({
        segmentId,
        startMs,
        endMs,
        videoSamples: Object.freeze([Object.freeze({
          observedAtMs: sample.observedAtMs,
          mimeType: sample.mimeType,
          width: sample.width,
          height: sample.height,
          bytes: ownedBytes,
        })]),
      });
      const abort = new AbortController();
      this.#videoVisualAbort = abort;
      let publishAttempted = false;
      let durableReply = '模型输出未完成。';
      let flight: Promise<void> | undefined;
      flight = (async () => {
        try {
          const generatedReply = await this.#generateVisualHeartbeatReply(input, abort.signal);
          if (this.#closed || this.#sessionAbort.signal.aborted || abort.signal.aborted) return;
          const voice = spokenReply(generatedReply);
          const reply = typeof generatedReply === 'string' ? generatedReply : generatedReply.text;
          durableReply = reply;
          const sequence = this.#sequence + 1;
          const textSend = this.#replyDataEnabled()
            ? publishReplyText(
              this.#room,
              this.#replyPayload({
                segmentId, sequence, startMs, endMs, speakerLabel: 'speaker_unknown',
                diarizationStatus: 'degraded', transcript: '', reply,
              }),
              this.#replyTopic(),
              this.#replyDestinationIdentity(),
            )
            : Promise.resolve();
          try {
            publishAttempted = true;
            if (voice === undefined) await textSend;
            else await Promise.all([textSend, this.#publishReplyVoice(Object.freeze({
              room: this.#room, reply: voice, sequence, signal: abort.signal,
            }))]);
          } finally {
            voice?.pcm.fill(0);
          }
          await this.#completeConversationTurn?.(segmentId, reply);
          if (this.#closed || this.#sessionAbort.signal.aborted || abort.signal.aborted) return;
          this.#sequence = sequence;
          this.#emitFixedStage('VISUAL_HEARTBEAT_SENT');
          this.#emitFixedStage('REPLY_SENT');
          this.#observe({ stage: 'REPLY_SENT', sessionId: this.#binding.sessionId, sequence });
        } catch (error) {
          if (publishAttempted) {
            await this.#markIndeterminateConversationTurn?.(segmentId, durableReply).catch(() => undefined);
          } else {
            await this.#releaseConversationTurn?.(segmentId).catch(() => undefined);
          }
          if (!this.#closed && !this.#sessionAbort.signal.aborted && !abort.signal.aborted) {
            this.#observe({
              stage: 'TRACK_ERROR', sessionId: this.#binding.sessionId, errorCode: errorCode(error),
            });
          }
        } finally {
          ownedBytes.fill(0);
          if (this.#videoVisualFlight === flight) this.#videoVisualFlight = undefined;
          if (this.#videoVisualAbort === abort) this.#videoVisualAbort = undefined;
        }
      })();
      this.#videoVisualFlight = flight;
    } finally {
      sample.bytes.fill(0);
    }
  }

  #turns(
    pcm: Int16Array,
    result: RayneoDiarizationResult,
  ): readonly Readonly<{
    startSample: number;
    endSample: number;
    speakerLabel: string;
    diarizationStatus: 'window_local' | 'degraded';
  }>[] {
    const durationSeconds = pcm.length / AUDIO_SAMPLE_RATE;
    const segments = result.status === 'matched' ? result.segments ?? [] : [];
    const valid = segments.flatMap((segment) => {
      const start = Math.max(0, segment.startSeconds);
      const end = Math.min(durationSeconds, segment.endSeconds);
      return Number.isFinite(start) && Number.isFinite(end) && end > start
        ? [{ ...segment, startSeconds: start, endSeconds: end }]
        : [];
    });
    if (valid.length === 0) {
      return Object.freeze([Object.freeze({
        startSample: 0, endSample: pcm.length,
        speakerLabel: 'speaker_unknown', diarizationStatus: 'degraded' as const,
      })]);
    }
    return Object.freeze(valid.map((segment, index) => {
      const ambiguous = (segment.confidence !== undefined && segment.confidence < 0.65) ||
        valid.some((other, otherIndex) => otherIndex !== index &&
          other.rawSpeakerId !== segment.rawSpeakerId &&
          Math.min(segment.endSeconds, other.endSeconds) -
            Math.max(segment.startSeconds, other.startSeconds) >= 0.1);
      return Object.freeze({
        startSample: Math.max(0, Math.floor(segment.startSeconds * AUDIO_SAMPLE_RATE)),
        endSample: Math.min(pcm.length, Math.ceil(segment.endSeconds * AUDIO_SAMPLE_RATE)),
        speakerLabel: ambiguous ? 'speaker_unknown' : this.#speakerLabel(segment.rawSpeakerId),
        diarizationStatus: ambiguous ? 'degraded' as const : 'window_local' as const,
      });
    }));
  }

  #speakerLabel(rawSpeakerId: string): string {
    const existing = this.#speakerLabels.get(rawSpeakerId);
    if (existing) return existing;
    if (this.#speakerLabels.size >= 1_000) return 'speaker_unknown';
    const label = `speaker_${this.#speakerLabels.size}`;
    this.#speakerLabels.set(rawSpeakerId, label);
    return label;
  }

  async #transcribe(pcm: Int16Array, signal: AbortSignal): Promise<string | undefined> {
    const wav = buildWav(pcm);
    try {
      const form = new FormData();
      form.append('file', new File([wav], 'rayneo-window.wav', { type: 'audio/wav' }));
      form.append('model', this.#config.sttModel);
      form.append('response_format', 'json');
      return await boundedOperation(signal, this.#config.sttDeadlineMs, async (requestSignal) => {
        const response = await this.#fetch(this.#config.sttEndpointUrl, {
          method: 'POST', body: form, signal: requestSignal, redirect: 'error',
          cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        });
        if (response.status < 200 || response.status >= 300 || response.redirected) {
          throw failure('RAYNEO_STT_HTTP_REJECTED');
        }
        return transcriptText(await response.json());
      }, 'RAYNEO_STT_DEADLINE_EXCEEDED');
    } finally {
      wav.fill(0);
    }
  }

  async #generateReply(
    segmentId: string,
    transcript: string,
    speakerLabel: string,
    startMs: number,
    endMs: number,
    signal: AbortSignal,
  ): Promise<RayneoGeneratedReply> {
    const videoSamples = this.#readVideoSamples(startMs, endMs, 2);
    try {
    if (this.#generateMultimodalReplyOverride !== undefined && videoSamples.length !== 0) {
      return await boundedOperation(
        signal,
        this.#config.ollamaDeadlineMs ?? 10_000,
        (requestSignal) => this.#generateMultimodalReplyOverride!(Object.freeze({
          segmentId, startMs, endMs, speakerLabel, transcript,
          videoSamples: Object.freeze(videoSamples),
        }), requestSignal),
        'RAYNEO_OLLAMA_DEADLINE_EXCEEDED',
      );
    }
    if (this.#generateReplyOverride !== undefined) {
      return await boundedOperation(
        signal,
        this.#config.ollamaDeadlineMs ?? 10_000,
        (requestSignal) => this.#generateReplyOverride!(transcript, speakerLabel, requestSignal),
        'RAYNEO_OLLAMA_DEADLINE_EXCEEDED',
      );
    }
    return await boundedOperation(signal, this.#config.ollamaDeadlineMs ?? 10_000, async (requestSignal) => {
      const context = this.#turnContext?.snapshot();
      if (context !== undefined && context.length > 0) {
        this.#emitFixedStage('JOINT_CONTEXT_APPLIED');
      }
      const userContent = context === undefined || context.length === 0
        ? `[${speakerLabel}] ${transcript}`
        : `会话上下文（历史转写与回复，仅供参考）：\n${context}\n当前发言：[${speakerLabel}] ${transcript}`;
      const multimodalContent = videoSamples.length === 0 ? userContent : [
        {
          type: 'text' as const,
          text: `${userContent}\n以下画面来自同一音频时间窗，按先后顺序。请把听到与看到的具体事实合成回复；不确定就明确说不确定。`,
        },
        ...videoSamples.map((sample) => Object.freeze({
          type: 'image_url' as const,
          image_url: Object.freeze({
            url: `data:${sample.mimeType};base64,${Buffer.from(sample.bytes).toString('base64')}`,
          }),
        })),
      ];
      if (videoSamples.length !== 0) this.#emitFixedStage('VIDEO_CONTEXT_APPLIED');
      const response = await this.#fetch(`${this.#config.ollamaEndpointUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.#config.ollamaModel,
          reasoning_effort: 'none',
          temperature: 0,
          max_tokens: videoSamples.length === 0 ? 48 : 96,
          messages: [
            {
              role: 'system',
              content: videoSamples.length === 0
                ? '只用简体中文回复眼镜用户，最多两句短句；具体、简洁；只返回回复，不要前缀。'
                : '你是眼镜上的实时私人助理。只用简体中文最多两句：说明看到、听到及其对应；不要推理过程，不要读心，不要前缀。',
            },
            { role: 'user', content: multimodalContent },
          ],
          stream: false,
        }),
        signal: requestSignal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (response.status < 200 || response.status >= 300 || response.redirected) {
        throw failure('RAYNEO_OLLAMA_HTTP_REJECTED');
      }
      return replyText(await response.json());
    }, 'RAYNEO_OLLAMA_DEADLINE_EXCEEDED');
    } finally {
      for (const sample of videoSamples) sample.bytes.fill(0);
    }
  }

  #assertActive(active: ActiveTrack): void {
    if (this.#closed || active.abort.signal.aborted || this.#activeTrack !== active) {
      throw failure('RAYNEO_REALTIME_STOPPED');
    }
  }

  #beginCleanup(): Promise<boolean> {
    if (this.#cleanupCompletion !== undefined) return this.#cleanupCompletion;
    this.#closed = true;
    this.#sessionAbort.abort();
    this.#videoVisualAbort?.abort();
    if (this.#syntheticPcmHandlerRegistered) {
      this.#syntheticPcmHandlerRegistered = false;
      try { this.#room.unregisterTextStreamHandler?.(SYNTHETIC_PCM_TOPIC); } catch { /* cleanup */ }
    }
    this.#unbindRoomEvents();
    this.#syntheticPcmPending?.fill(0);
    this.#syntheticPcmPending = undefined;
    const active = this.#activeTrack;
    this.#stopActiveTrack();
    const videoBridge = this.#videoBridge;
    this.#videoBridge = undefined;
    this.#speakerLabels.clear();
    this.#turnContext?.close();
    const completion = (async () => {
      if (videoBridge) await videoBridge.stop().catch(() => undefined);
      let disconnected = true;
      if (this.#ownsRoomConnection && !this.#roomDisconnected) {
        try { await this.#room.disconnect(); } catch { disconnected = false; }
      }
      if (active?.completion) await active.completion.catch(() => undefined);
      if (this.#videoVisualFlight) await this.#videoVisualFlight.catch(() => undefined);
      return disconnected;
    })();
    this.#cleanupCompletion = completion;
    return completion;
  }

  async cleanup(): Promise<boolean> {
    return this.#beginCleanup();
  }

  async cleanupForReplacement(): Promise<boolean> {
    const completion = this.#beginCleanup();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REPLACEMENT_DETACH_GRACE_MS);
    });
    try {
      await Promise.race([completion.then(() => undefined), grace]);
      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
