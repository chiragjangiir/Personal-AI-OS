import { createHash } from 'node:crypto';

import type {
  RayneoFinalTranscriptAuthorityInput,
  RayneoFinalTranscriptAuthorityPort,
} from './rayneo-realtime-audio-controller.ts';
import type {
  FinalTranscriptEvidenceService,
  T11BCanonicalRef,
} from '../../../services/realtime-core/src/final-transcript-evidence-service.ts';
import type {
  CanonicalTimestamp,
  OpaqueCanonicalRef,
} from '../../../services/realtime-core/src/types.ts';

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_VERSION = /^[1-9][0-9]*$/u;
const CANONICAL_TIMESTAMP =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.(?:[0-9]{3}|[0-9]{6})Z$/u;
const AUTHORITY_KEYS = Object.freeze([
  'clientInstanceId', 'deviceId', 'diarizationStatus', 'endMs', 'language', 'media',
  'observedAt', 'segmentId', 'sessionId', 'speakerLabel', 'startMs', 'transcript',
] as const);
const MEDIA_KEYS = Object.freeze(['bytes', 'channels', 'format', 'sampleRate', 'sha256'] as const);
const BINDING_KEYS = Object.freeze([
  'canonicalDeviceId', 'continuityId', 'purpose', 'realtimeSessionRef', 'userId',
] as const);
const SOURCE_REF_KEYS = Object.freeze([
  'canonicalPayloadSha256', 'objectVersion', 'refId', 'refType',
] as const);

export class RayneoFinalTranscriptAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = 'RayneoFinalTranscriptAuthorityError';
    this.code = code;
  }
}

export interface RayneoFinalTranscriptOwnerBinding {
  /** T02 canonical device identity; transport identity remains the raw input. */
  readonly canonicalDeviceId: string;
  readonly userId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly purpose: string;
}

export interface RayneoFinalTranscriptOwnerBindingResolver {
  resolve(input: Readonly<{
    sessionId: string;
    deviceId: string;
    clientInstanceId: string;
    observedAt: string;
  }>): Promise<RayneoFinalTranscriptOwnerBinding | undefined>;
}

export interface RayneoSourceMediaAuthorityInput {
  readonly userId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly diarizationStatus: 'window_local' | 'degraded';
  readonly observedAt: string;
  readonly media: RayneoFinalTranscriptAuthorityInput['media'];
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** T13-owned immutable-media issuer. */
export interface RayneoSourceMediaAuthorityPort {
  issue(input: RayneoSourceMediaAuthorityInput): Promise<T11BCanonicalRef>;
}

export interface RayneoFinalTranscriptAuthorityOptions {
  readonly ownerBinding: RayneoFinalTranscriptOwnerBindingResolver;
  readonly sourceMedia: RayneoSourceMediaAuthorityPort;
  readonly finalTranscript: FinalTranscriptEvidenceService;
}

function fail(code: string, cause?: unknown): never {
  throw new RayneoFinalTranscriptAuthorityError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('RAYNEO_FINAL_TRANSCRIPT_BINDING_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainRecord(value)) fail('RAYNEO_FINAL_TRANSCRIPT_BINDING_INVALID');
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`;
}

function exactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !value.includes('\u0000');
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function opaqueRef(value: unknown): OpaqueCanonicalRef {
  if (typeof value !== 'string' && !isPlainRecord(value)) {
    fail('RAYNEO_FINAL_TRANSCRIPT_BINDING_INVALID');
  }
  canonicalJson(value);
  return value as OpaqueCanonicalRef;
}

function canonicalTimestamp(value: unknown): CanonicalTimestamp {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('RAYNEO_FINAL_TRANSCRIPT_INPUT_INVALID');
  }
  return value as CanonicalTimestamp;
}

function validateSourceMediaRef(value: unknown): T11BCanonicalRef {
  if (!isPlainRecord(value) || !exactKeys(value, SOURCE_REF_KEYS) ||
      (value.refType !== 'SourceArtifact' && value.refType !== 'ArtifactVersion') ||
      typeof value.refId !== 'string' || !UUID_V7.test(value.refId) ||
      typeof value.objectVersion !== 'string' || !POSITIVE_VERSION.test(value.objectVersion) ||
      typeof value.canonicalPayloadSha256 !== 'string' || !SHA256.test(value.canonicalPayloadSha256)) {
    fail('RAYNEO_SOURCE_MEDIA_REFERENCE_INVALID');
  }
  return Object.freeze({
    refType: value.refType,
    refId: value.refId,
    objectVersion: value.objectVersion,
    canonicalPayloadSha256: value.canonicalPayloadSha256,
  }) as T11BCanonicalRef;
}

function normalizeInput(value: unknown): RayneoFinalTranscriptAuthorityInput {
  if (!isPlainRecord(value) || !exactKeys(value, AUTHORITY_KEYS)) {
    fail('RAYNEO_FINAL_TRANSCRIPT_INPUT_INVALID');
  }
  const startMsValue = value.startMs;
  const endMsValue = value.endMs;
  if (!exactString(value.sessionId) || !exactString(value.deviceId) ||
      !exactString(value.clientInstanceId) || !exactString(value.segmentId) ||
      !exactString(value.speakerLabel) || !exactString(value.transcript) ||
      Buffer.byteLength(value.transcript, 'utf8') > 16_384 || value.language !== 'und' ||
      (value.diarizationStatus !== 'window_local' && value.diarizationStatus !== 'degraded') ||
      !Number.isSafeInteger(startMsValue) || !Number.isSafeInteger(endMsValue) ||
      (startMsValue as number) < 0 || (endMsValue as number) <= (startMsValue as number) ||
      (endMsValue as number) - (startMsValue as number) > 10_000) {
    fail('RAYNEO_FINAL_TRANSCRIPT_INPUT_INVALID');
  }
  const startMs = startMsValue as number;
  const endMs = endMsValue as number;
  const media = value.media;
  if (!isPlainRecord(media) || !exactKeys(media, MEDIA_KEYS) || media.format !== 'pcm_s16le' ||
      media.sampleRate !== 16_000 || media.channels !== 1 || !(media.bytes instanceof Uint8Array) ||
      media.bytes.byteLength === 0 || media.bytes.byteLength % 2 !== 0 ||
      typeof media.sha256 !== 'string' || !SHA256.test(media.sha256) ||
      createHash('sha256').update(media.bytes).digest('hex') !== media.sha256) {
    fail('RAYNEO_FINAL_TRANSCRIPT_INPUT_INVALID');
  }
  const observedAt = canonicalTimestamp(value.observedAt);
  return Object.freeze({
    sessionId: value.sessionId,
    deviceId: value.deviceId,
    clientInstanceId: value.clientInstanceId,
    segmentId: value.segmentId,
    startMs,
    endMs,
    speakerLabel: value.speakerLabel,
    diarizationStatus: value.diarizationStatus,
    transcript: value.transcript,
    language: 'und',
    observedAt,
    media: Object.freeze({
      format: 'pcm_s16le' as const,
      sampleRate: 16_000 as const,
      channels: 1 as const,
      sha256: media.sha256,
      bytes: media.bytes,
    }),
  });
}

function normalizeBinding(value: unknown): RayneoFinalTranscriptOwnerBinding {
  if (!isPlainRecord(value) || !exactKeys(value, BINDING_KEYS) ||
      !exactString(value.canonicalDeviceId) || !UUID_V7.test(value.canonicalDeviceId) ||
      !exactString(value.userId) || !exactString(value.continuityId) || !exactString(value.purpose)) {
    fail('RAYNEO_FINAL_TRANSCRIPT_BINDING_INVALID');
  }
  const realtimeSessionRef = opaqueRef(value.realtimeSessionRef);
  return Object.freeze({
    canonicalDeviceId: value.canonicalDeviceId,
    userId: value.userId,
    realtimeSessionRef,
    continuityId: value.continuityId,
    purpose: value.purpose,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createRayneoFinalTranscriptAuthority(
  options: RayneoFinalTranscriptAuthorityOptions,
): RayneoFinalTranscriptAuthorityPort {
  if (!isPlainRecord(options) || !exactKeys(options, ['finalTranscript', 'ownerBinding', 'sourceMedia']) ||
      typeof options.ownerBinding?.resolve !== 'function' ||
      typeof options.sourceMedia?.issue !== 'function' ||
      typeof options.finalTranscript?.finalize !== 'function') {
    fail('RAYNEO_FINAL_TRANSCRIPT_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    async finalize(rawInput: RayneoFinalTranscriptAuthorityInput): Promise<void> {
      const input = normalizeInput(rawInput);
      let resolved: RayneoFinalTranscriptOwnerBinding | undefined;
      try {
        resolved = await options.ownerBinding.resolve(Object.freeze({
          sessionId: input.sessionId,
          deviceId: input.deviceId,
          clientInstanceId: input.clientInstanceId,
          observedAt: input.observedAt,
        }));
      } catch (error) {
        fail('RAYNEO_FINAL_TRANSCRIPT_BINDING_UNAVAILABLE', error);
      }
      if (resolved === undefined) fail('RAYNEO_FINAL_TRANSCRIPT_BINDING_UNAVAILABLE');
      const binding = normalizeBinding(resolved);
      const operationHash = sha256(canonicalJson({
        domain: 'paios.rayneo.final-transcript.operation.v1',
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        canonicalDeviceId: binding.canonicalDeviceId,
        clientInstanceId: input.clientInstanceId,
        segmentId: input.segmentId,
      }));
      const mediaFingerprint = sha256(canonicalJson({
        domain: 'paios.rayneo.final-transcript.source-media.v1',
        userId: binding.userId,
        realtimeSessionRef: binding.realtimeSessionRef,
        continuityId: binding.continuityId,
        purpose: binding.purpose,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        clientInstanceId: input.clientInstanceId,
        segmentId: input.segmentId,
        startMs: input.startMs,
        endMs: input.endMs,
        speakerLabel: input.speakerLabel,
        diarizationStatus: input.diarizationStatus,
        observedAt: input.observedAt,
        mediaFormat: input.media.format,
        sampleRate: input.media.sampleRate,
        channels: input.media.channels,
        mediaSha256: input.media.sha256,
      }));
      let sourceMediaRef: T11BCanonicalRef;
      try {
        sourceMediaRef = validateSourceMediaRef(await options.sourceMedia.issue(Object.freeze({
          userId: binding.userId,
          realtimeSessionRef: binding.realtimeSessionRef,
          continuityId: binding.continuityId,
          purpose: binding.purpose,
          sessionId: input.sessionId,
          deviceId: input.deviceId,
          clientInstanceId: input.clientInstanceId,
          segmentId: input.segmentId,
          startMs: input.startMs,
          endMs: input.endMs,
          speakerLabel: input.speakerLabel,
          diarizationStatus: input.diarizationStatus,
          observedAt: input.observedAt,
          media: input.media,
          idempotencyKey: `rayneo-source-media:${operationHash}`,
          fingerprint: mediaFingerprint,
        })));
      } catch (error) {
        if (error instanceof RayneoFinalTranscriptAuthorityError &&
            error.code === 'RAYNEO_SOURCE_MEDIA_REFERENCE_INVALID') throw error;
        fail('RAYNEO_SOURCE_MEDIA_AUTHORITY_FAILED', error);
      }
      try {
        await options.finalTranscript.finalize(Object.freeze({
          transcriptState: 'final',
          userId: binding.userId,
          deviceId: binding.canonicalDeviceId,
          realtimeSessionRef: binding.realtimeSessionRef,
          continuityId: binding.continuityId,
          purpose: binding.purpose,
          text: input.transcript,
          language: input.language,
          sourceMediaRef,
          observedAt: input.observedAt as CanonicalTimestamp,
          idempotencyKey: `rayneo-final-transcript:${operationHash}`,
        }));
      } catch (error) {
        fail('RAYNEO_FINAL_TRANSCRIPT_AUTHORITY_FAILED', error);
      }
    },
  });
}
