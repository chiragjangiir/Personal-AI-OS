import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import process from "node:process";
import type { T11BCanonicalRef } from "../../../services/realtime-core/src/final-transcript-evidence-service.ts";
import {
  CAS_NAMESPACE,
  PRODUCTION_HELPER_EXECUTABLE,
  PRODUCTION_ROOT,
  ColdCasError,
  createProductionColdCas,
  type FaultHook,
} from "./cold-cas.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.(?:[0-9]{3}|[0-9]{6})Z$/u;
const SOURCE_REF_KEYS = Object.freeze([
  "canonicalPayloadSha256",
  "objectVersion",
  "refId",
  "refType",
] as const);
const CATALOG_SCHEMA = "paios.t13.source-media-catalog.v1";
const SOURCE_ARTIFACT_SCHEMA = "paios.t13.source-artifact.v1";
const ARTIFACT_VERSION_SCHEMA = "paios.t13.artifact-version.v1";
const SOURCE_VISUAL_ARTIFACT_SCHEMA = "paios.t13.source-visual-artifact.v1";
const VISUAL_ARTIFACT_VERSION_SCHEMA = "paios.t13.visual-artifact-version.v1";

export const SOURCE_MEDIA_RUNTIME_ROOT = PRODUCTION_ROOT;
export const SOURCE_MEDIA_CAS_ROOT = join(PRODUCTION_ROOT, CAS_NAMESPACE);
export const SOURCE_MEDIA_METADATA_ROOT = join(PRODUCTION_ROOT, "meta");
export const SOURCE_MEDIA_CATALOG_PATH = join(SOURCE_MEDIA_METADATA_ROOT, "catalog.json");
export const SOURCE_MEDIA_PROCESS_ARG = "--mode=stdio";
export const SOURCE_MEDIA_PCM_BYTES = 288_000;
export const SOURCE_MEDIA_PCM_SHA256 =
  "74a7d518a51201e9d045411ded734a36882ea00b3cc2a9eb828aebcc869516c";

type JsonRecord = Record<string, unknown>;

export class SourceMediaAuthorityError extends Error {
  public readonly code: string;

  public constructor(code: string, message = code) {
    super(message);
    this.name = "SourceMediaAuthorityError";
    this.code = code;
  }
}

export type SourceMediaFormat =
  | "pcm_s16le"
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/bmp";

export type SourceVisualMediaFormat = Exclude<SourceMediaFormat, "pcm_s16le">;

export interface SourceMediaInput {
  readonly format: SourceMediaFormat;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface SourceMediaIssueInput {
  readonly userId: string;
  readonly realtimeSessionRef: unknown;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly diarizationStatus: "window_local" | "degraded";
  readonly observedAt: string;
  readonly media: SourceMediaInput;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export interface SourceVisualMediaInput {
  readonly format: SourceVisualMediaFormat;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface SourceVisualIssueInput {
  readonly userId: string;
  readonly realtimeSessionRef: unknown;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly media: SourceVisualMediaInput;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export interface SourceMediaIssueReceipt {
  readonly sourceArtifactRef: T11BCanonicalRef;
  readonly artifactVersionRef: T11BCanonicalRef;
  readonly contentSha256: string;
  readonly bytes: number;
}

export interface SourceVisualIssueReceipt extends SourceMediaIssueReceipt {
  readonly mediaKind: "visual";
  readonly captureId: string;
  readonly capturedAt: string;
  readonly format: SourceVisualMediaFormat;
  readonly width: number;
  readonly height: number;
}

export interface SourceMediaReadRequest {
  readonly ref: T11BCanonicalRef;
  readonly expectedContentSha256?: string;
}

export interface SourceVisualReadRequest extends SourceMediaReadRequest {}

export interface SourceMediaReadResult {
  readonly sourceArtifactRef: T11BCanonicalRef;
  readonly artifactVersionRef: T11BCanonicalRef;
  readonly contentSha256: string;
  readonly bytes: Uint8Array;
}

export interface SourceVisualReadResult extends SourceMediaReadResult {
  readonly mediaKind: "visual";
  readonly captureId: string;
  readonly capturedAt: string;
  readonly format: SourceVisualMediaFormat;
  readonly width: number;
  readonly height: number;
}

export interface SourceMediaRuntimeFacts {
  readonly runtimeRoot: string;
  readonly casRoot: string;
  readonly metadataRoot: string;
  readonly catalogPath: string;
  readonly helperExecutable: string;
  readonly runtimeRootExists: boolean;
  readonly casRootExists: boolean;
  readonly metadataRootExists: boolean;
  readonly catalogExists: boolean;
  readonly runtimeRootNonReparse: boolean;
  readonly casRootNonReparse: boolean;
  readonly metadataRootNonReparse: boolean;
  readonly catalogNonReparse: boolean;
}

export interface SourceMediaAuthorityPort {
  issue(input: SourceMediaIssueInput): Promise<T11BCanonicalRef>;
  issueWithReceipt(input: SourceMediaIssueInput): Promise<SourceMediaIssueReceipt>;
  issueVisual(input: SourceVisualIssueInput): Promise<T11BCanonicalRef>;
  issueVisualWithReceipt(input: SourceVisualIssueInput): Promise<SourceVisualIssueReceipt>;
  read(request: SourceMediaReadRequest): Promise<SourceMediaReadResult>;
  readVisual(request: SourceVisualReadRequest): Promise<SourceVisualReadResult>;
  inspectRuntime(): Promise<SourceMediaRuntimeFacts>;
  close(): Promise<void>;
}

interface SourceArtifactRecord extends JsonRecord {
  readonly schema: typeof SOURCE_ARTIFACT_SCHEMA;
  readonly refType: "SourceArtifact";
  readonly refId: string;
  readonly objectVersion: "1";
  readonly canonicalPayloadSha256: string;
  readonly userId: string;
  readonly realtimeSessionRef: unknown;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly diarizationStatus: "window_local" | "degraded";
  readonly observedAt: string;
  readonly mediaFormat: SourceMediaFormat;
  readonly sampleRate: number;
  readonly channels: number;
  readonly contentSha256: string;
  readonly byteLength: number;
}

interface ArtifactVersionRecord extends JsonRecord {
  readonly schema: typeof ARTIFACT_VERSION_SCHEMA;
  readonly refType: "ArtifactVersion";
  readonly refId: string;
  readonly objectVersion: "1";
  readonly canonicalPayloadSha256: string;
  readonly sourceArtifactRef: T11BCanonicalRef;
  readonly userId: string;
  readonly realtimeSessionRef: unknown;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string;
  readonly diarizationStatus: "window_local" | "degraded";
  readonly observedAt: string;
  readonly mediaFormat: SourceMediaFormat;
  readonly sampleRate: number;
  readonly channels: number;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly casNamespace: typeof CAS_NAMESPACE;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface SourceVisualArtifactRecord extends JsonRecord {
  readonly schema: typeof SOURCE_VISUAL_ARTIFACT_SCHEMA;
  readonly mediaKind: "visual";
  readonly refType: "SourceArtifact";
  readonly refId: string;
  readonly objectVersion: "1";
  readonly canonicalPayloadSha256: string;
  readonly userId: string;
  readonly realtimeSessionRef: unknown;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly mediaFormat: SourceVisualMediaFormat;
  readonly width: number;
  readonly height: number;
  readonly contentSha256: string;
  readonly byteLength: number;
}

interface VisualArtifactVersionRecord extends JsonRecord {
  readonly schema: typeof VISUAL_ARTIFACT_VERSION_SCHEMA;
  readonly mediaKind: "visual";
  readonly refType: "ArtifactVersion";
  readonly refId: string;
  readonly objectVersion: "1";
  readonly canonicalPayloadSha256: string;
  readonly sourceArtifactRef: T11BCanonicalRef;
  readonly userId: string;
  readonly realtimeSessionRef: unknown;
  readonly continuityId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly mediaFormat: SourceVisualMediaFormat;
  readonly width: number;
  readonly height: number;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly casNamespace: typeof CAS_NAMESPACE;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface SourceMediaCatalog {
  readonly schema: typeof CATALOG_SCHEMA;
  readonly version: 1;
  readonly sourceArtifacts: SourceArtifactRecord[];
  readonly artifactVersions: ArtifactVersionRecord[];
  readonly visualArtifacts: SourceVisualArtifactRecord[];
  readonly visualVersions: VisualArtifactVersionRecord[];
}

function fail(code: string, message = code): never {
  throw new SourceMediaAuthorityError(code, message);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("SOURCE_MEDIA_METADATA_INVALID", "non-finite number is not canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (!isPlainRecord(value)) {
    fail("SOURCE_MEDIA_METADATA_INVALID", "metadata contains a non-canonical value");
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

function exactSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(code);
  }
  return value;
}

function snapshotCanonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("SOURCE_MEDIA_BINDING_INVALID");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => snapshotCanonical(item));
  }
  if (!isPlainRecord(value)) {
    fail("SOURCE_MEDIA_BINDING_INVALID");
  }
  const copy: JsonRecord = {};
  for (const key of Object.keys(value).sort()) {
    copy[key] = snapshotCanonical(value[key]);
  }
  return copy;
}

function snapshotOpaqueRef(value: unknown): unknown {
  if (typeof value !== "string" && !isPlainRecord(value)) {
    fail("SOURCE_MEDIA_BINDING_INVALID");
  }
  const copy = snapshotCanonical(value);
  canonicalJson(copy);
  return copy;
}

function canonicalRef(
  refType: "SourceArtifact" | "ArtifactVersion",
  refId: string,
  canonicalPayloadSha256: string,
): T11BCanonicalRef {
  return Object.freeze({
    canonicalPayloadSha256,
    objectVersion: "1",
    refId,
    refType,
  }) as T11BCanonicalRef;
}

function validateCanonicalRef(value: unknown): T11BCanonicalRef {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, SOURCE_REF_KEYS) ||
    (value.refType !== "SourceArtifact" && value.refType !== "ArtifactVersion") ||
    typeof value.refId !== "string" ||
    !UUID_V7.test(value.refId) ||
    value.objectVersion !== "1" ||
    typeof value.canonicalPayloadSha256 !== "string" ||
    !SHA256.test(value.canonicalPayloadSha256)
  ) {
    fail("SOURCE_MEDIA_REFERENCE_INVALID");
  }
  return canonicalRef(
    value.refType,
    value.refId,
    value.canonicalPayloadSha256,
  );
}

function deterministicUuidV7(observedAt: string, domain: string, seed: string): string {
  const timestamp = BigInt(Date.parse(observedAt));
  const entropy = Buffer.from(sha256(domain + "\n" + seed), "hex");
  const bytes = Buffer.alloc(16);
  for (let index = 0; index < 6; index += 1) {
    const shift = BigInt((5 - index) * 8);
    bytes[index] = Number((timestamp >> shift) & 0xffn);
  }
  bytes[6] = 0x70 | ((entropy[0] ?? 0) & 0x0f);
  bytes[7] = entropy[1] ?? 0;
  bytes[8] = 0x80 | ((entropy[2] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index += 1) {
    bytes[index] = entropy[index - 6] ?? 0;
  }
  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

function normalizeIssueInput(value: unknown): SourceMediaIssueInput {
  const inputKeys = [
    "clientInstanceId",
    "continuityId",
    "deviceId",
    "diarizationStatus",
    "endMs",
    "fingerprint",
    "idempotencyKey",
    "media",
    "observedAt",
    "purpose",
    "realtimeSessionRef",
    "segmentId",
    "sessionId",
    "speakerLabel",
    "startMs",
    "userId",
  ] as const;
  if (!isPlainRecord(value) || !exactKeys(value, inputKeys)) {
    fail("SOURCE_MEDIA_INPUT_INVALID");
  }
  if (
    !exactString(value.userId) ||
    !exactString(value.continuityId) ||
    !exactString(value.purpose) ||
    !exactString(value.sessionId) ||
    !exactString(value.deviceId) ||
    !exactString(value.clientInstanceId) ||
    !exactString(value.segmentId) ||
    !exactString(value.speakerLabel) ||
    !exactString(value.idempotencyKey) ||
    !exactString(value.fingerprint) ||
    !SHA256.test(value.fingerprint) ||
    (value.diarizationStatus !== "window_local" && value.diarizationStatus !== "degraded") ||
    !Number.isSafeInteger(value.startMs) ||
    !Number.isSafeInteger(value.endMs) ||
    (value.startMs as number) < 0 ||
    (value.endMs as number) <= (value.startMs as number) ||
    (value.endMs as number) - (value.startMs as number) > 10_000 ||
    typeof value.observedAt !== "string" ||
    !CANONICAL_TIMESTAMP.test(value.observedAt) ||
    !Number.isFinite(Date.parse(value.observedAt))
  ) {
    fail("SOURCE_MEDIA_INPUT_INVALID");
  }
  const media = value.media;
  const mediaKeys = ["bytes", "channels", "format", "sampleRate", "sha256"] as const;
  if (
    !isPlainRecord(media) ||
    !exactKeys(media, mediaKeys) ||
    !(media.bytes instanceof Uint8Array) ||
    media.bytes.byteLength === 0 ||
    !exactString(media.format) ||
    (media.format !== "pcm_s16le" &&
      media.format !== "image/png" &&
      media.format !== "image/jpeg" &&
      media.format !== "image/webp" &&
      media.format !== "image/gif" &&
      media.format !== "image/bmp") ||
    !Number.isSafeInteger(media.sampleRate) ||
    !Number.isSafeInteger(media.channels) ||
    (media.format === "pcm_s16le" &&
      (media.sampleRate !== 16_000 || media.channels !== 1 || media.bytes.byteLength % 2 !== 0)) ||
    (media.format !== "pcm_s16le" && (media.sampleRate !== 0 || media.channels !== 0)) ||
    typeof media.sha256 !== "string" ||
    !SHA256.test(media.sha256)
  ) {
    fail("SOURCE_MEDIA_INPUT_INVALID");
  }
  const bytes = new Uint8Array(media.bytes.byteLength);
  bytes.set(media.bytes);
  if (sha256(bytes) !== media.sha256) {
    fail("SOURCE_MEDIA_MEDIA_HASH_MISMATCH");
  }
  return {
    userId: value.userId,
    realtimeSessionRef: snapshotOpaqueRef(value.realtimeSessionRef),
    continuityId: value.continuityId,
    purpose: value.purpose,
    sessionId: value.sessionId,
    deviceId: value.deviceId,
    clientInstanceId: value.clientInstanceId,
    segmentId: value.segmentId,
    startMs: value.startMs as number,
    endMs: value.endMs as number,
    speakerLabel: value.speakerLabel,
    diarizationStatus: value.diarizationStatus,
    observedAt: value.observedAt,
    media: {
      format: media.format,
      sampleRate: media.sampleRate as number,
      channels: media.channels as number,
      sha256: media.sha256,
      bytes,
    },
    idempotencyKey: value.idempotencyKey,
    fingerprint: value.fingerprint,
  };
}

function isVisualMediaFormat(value: unknown): value is SourceVisualMediaFormat {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif" ||
    value === "image/bmp"
  );
}

function normalizeVisualIssueInput(value: unknown): SourceVisualIssueInput {
  const inputKeys = [
    "captureId",
    "capturedAt",
    "clientInstanceId",
    "continuityId",
    "deviceId",
    "fingerprint",
    "idempotencyKey",
    "media",
    "purpose",
    "realtimeSessionRef",
    "sessionId",
    "userId",
  ] as const;
  if (!isPlainRecord(value) || !exactKeys(value, inputKeys)) {
    fail("SOURCE_MEDIA_VISUAL_INPUT_INVALID");
  }
  if (
    !exactString(value.userId) ||
    !exactString(value.continuityId) ||
    !exactString(value.purpose) ||
    !exactString(value.sessionId) ||
    !exactString(value.deviceId) ||
    !exactString(value.clientInstanceId) ||
    !exactString(value.captureId) ||
    !exactString(value.idempotencyKey) ||
    !exactString(value.fingerprint) ||
    !SHA256.test(value.fingerprint) ||
    typeof value.capturedAt !== "string" ||
    !CANONICAL_TIMESTAMP.test(value.capturedAt) ||
    !Number.isFinite(Date.parse(value.capturedAt))
  ) {
    fail("SOURCE_MEDIA_VISUAL_INPUT_INVALID");
  }
  const media = value.media;
  const mediaKeys = ["bytes", "format", "height", "sha256", "width"] as const;
  if (
    !isPlainRecord(media) ||
    !exactKeys(media, mediaKeys) ||
    !isVisualMediaFormat(media.format) ||
    !(media.bytes instanceof Uint8Array) ||
    media.bytes.byteLength === 0 ||
    !Number.isSafeInteger(media.width) ||
    !Number.isSafeInteger(media.height) ||
    (media.width as number) <= 0 ||
    (media.height as number) <= 0 ||
    typeof media.sha256 !== "string" ||
    !SHA256.test(media.sha256)
  ) {
    fail("SOURCE_MEDIA_VISUAL_INPUT_INVALID");
  }
  const bytes = new Uint8Array(media.bytes.byteLength);
  bytes.set(media.bytes);
  if (sha256(bytes) !== media.sha256) {
    fail("SOURCE_MEDIA_VISUAL_MEDIA_HASH_MISMATCH");
  }
  return {
    userId: value.userId,
    realtimeSessionRef: snapshotOpaqueRef(value.realtimeSessionRef),
    continuityId: value.continuityId,
    purpose: value.purpose,
    sessionId: value.sessionId,
    deviceId: value.deviceId,
    clientInstanceId: value.clientInstanceId,
    captureId: value.captureId,
    capturedAt: value.capturedAt,
    media: {
      format: media.format,
      width: media.width as number,
      height: media.height as number,
      sha256: media.sha256,
      bytes,
    },
    idempotencyKey: value.idempotencyKey,
    fingerprint: value.fingerprint,
  };
}

function sourcePayload(input: SourceMediaIssueInput, refId: string): JsonRecord {
  return {
    schema: SOURCE_ARTIFACT_SCHEMA,
    refType: "SourceArtifact",
    refId,
    objectVersion: "1",
    userId: input.userId,
    realtimeSessionRef: input.realtimeSessionRef,
    continuityId: input.continuityId,
    purpose: input.purpose,
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
    contentSha256: input.media.sha256,
    byteLength: input.media.bytes.byteLength,
  };
}

function artifactVersionPayload(
  input: SourceMediaIssueInput,
  refId: string,
  sourceArtifactRef: T11BCanonicalRef,
): JsonRecord {
  return {
    schema: ARTIFACT_VERSION_SCHEMA,
    refType: "ArtifactVersion",
    refId,
    objectVersion: "1",
    sourceArtifactRef,
    userId: input.userId,
    realtimeSessionRef: input.realtimeSessionRef,
    continuityId: input.continuityId,
    purpose: input.purpose,
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
    contentSha256: input.media.sha256,
    byteLength: input.media.bytes.byteLength,
    casNamespace: CAS_NAMESPACE,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
  };
}

function visualSourcePayload(input: SourceVisualIssueInput, refId: string): JsonRecord {
  return {
    schema: SOURCE_VISUAL_ARTIFACT_SCHEMA,
    mediaKind: "visual",
    refType: "SourceArtifact",
    refId,
    objectVersion: "1",
    userId: input.userId,
    realtimeSessionRef: input.realtimeSessionRef,
    continuityId: input.continuityId,
    purpose: input.purpose,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    clientInstanceId: input.clientInstanceId,
    captureId: input.captureId,
    capturedAt: input.capturedAt,
    mediaFormat: input.media.format,
    width: input.media.width,
    height: input.media.height,
    contentSha256: input.media.sha256,
    byteLength: input.media.bytes.byteLength,
  };
}

function visualVersionPayload(
  input: SourceVisualIssueInput,
  refId: string,
  sourceArtifactRef: T11BCanonicalRef,
): JsonRecord {
  return {
    schema: VISUAL_ARTIFACT_VERSION_SCHEMA,
    mediaKind: "visual",
    refType: "ArtifactVersion",
    refId,
    objectVersion: "1",
    sourceArtifactRef,
    userId: input.userId,
    realtimeSessionRef: input.realtimeSessionRef,
    continuityId: input.continuityId,
    purpose: input.purpose,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    clientInstanceId: input.clientInstanceId,
    captureId: input.captureId,
    capturedAt: input.capturedAt,
    mediaFormat: input.media.format,
    width: input.media.width,
    height: input.media.height,
    contentSha256: input.media.sha256,
    byteLength: input.media.bytes.byteLength,
    casNamespace: CAS_NAMESPACE,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
  };
}

function withCanonicalHash<T extends JsonRecord>(payload: T): T & { readonly canonicalPayloadSha256: string } {
  const canonicalPayloadSha256 = sha256(canonicalJson(payload));
  return { ...payload, canonicalPayloadSha256 };
}

function withoutCanonicalHash(value: JsonRecord): JsonRecord {
  const payload: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "canonicalPayloadSha256") {
      payload[key] = item;
    }
  }
  return payload;
}

function validateRecordHash(value: JsonRecord): void {
  const hash = exactSha256(value.canonicalPayloadSha256, "SOURCE_MEDIA_METADATA_INVALID");
  if (sha256(canonicalJson(withoutCanonicalHash(value))) !== hash) {
    fail("SOURCE_MEDIA_METADATA_HASH_MISMATCH");
  }
}

function validateSourceArtifactRecord(value: unknown): SourceArtifactRecord {
  const keys = [
    "byteLength",
    "canonicalPayloadSha256",
    "channels",
    "clientInstanceId",
    "contentSha256",
    "continuityId",
    "deviceId",
    "diarizationStatus",
    "endMs",
    "mediaFormat",
    "objectVersion",
    "observedAt",
    "purpose",
    "realtimeSessionRef",
    "refId",
    "refType",
    "sampleRate",
    "schema",
    "segmentId",
    "sessionId",
    "speakerLabel",
    "startMs",
    "userId",
  ] as const;
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, keys) ||
    value.schema !== SOURCE_ARTIFACT_SCHEMA ||
    value.refType !== "SourceArtifact" ||
    typeof value.refId !== "string" ||
    !UUID_V7.test(value.refId) ||
    value.objectVersion !== "1" ||
    typeof value.contentSha256 !== "string" ||
    !SHA256.test(value.contentSha256) ||
    typeof value.mediaFormat !== "string" ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    !Number.isSafeInteger(value.sampleRate) ||
    !Number.isSafeInteger(value.channels) ||
    !exactString(value.userId) ||
    !exactString(value.continuityId) ||
    !exactString(value.purpose) ||
    !exactString(value.sessionId) ||
    !exactString(value.deviceId) ||
    !exactString(value.clientInstanceId) ||
    !exactString(value.segmentId) ||
    !exactString(value.speakerLabel) ||
    !exactString(value.observedAt) ||
    (value.diarizationStatus !== "window_local" && value.diarizationStatus !== "degraded") ||
    !Number.isSafeInteger(value.startMs) ||
    !Number.isSafeInteger(value.endMs) ||
    !isPlainRecord(value.realtimeSessionRef) && typeof value.realtimeSessionRef !== "string"
  ) {
    fail("SOURCE_MEDIA_METADATA_INVALID");
  }
  validateRecordHash(value);
  return value as SourceArtifactRecord;
}

function validateArtifactVersionRecord(value: unknown): ArtifactVersionRecord {
  const keys = [
    "byteLength",
    "canonicalPayloadSha256",
    "casNamespace",
    "channels",
    "clientInstanceId",
    "contentSha256",
    "continuityId",
    "deviceId",
    "diarizationStatus",
    "endMs",
    "fingerprint",
    "idempotencyKey",
    "mediaFormat",
    "objectVersion",
    "observedAt",
    "purpose",
    "realtimeSessionRef",
    "refId",
    "refType",
    "sampleRate",
    "schema",
    "segmentId",
    "sessionId",
    "sourceArtifactRef",
    "speakerLabel",
    "startMs",
    "userId",
  ] as const;
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, keys) ||
    value.schema !== ARTIFACT_VERSION_SCHEMA ||
    value.refType !== "ArtifactVersion" ||
    typeof value.refId !== "string" ||
    !UUID_V7.test(value.refId) ||
    value.objectVersion !== "1" ||
    value.casNamespace !== CAS_NAMESPACE ||
    typeof value.contentSha256 !== "string" ||
    !SHA256.test(value.contentSha256) ||
    typeof value.fingerprint !== "string" ||
    !SHA256.test(value.fingerprint) ||
    !exactString(value.idempotencyKey) ||
    typeof value.mediaFormat !== "string" ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    !Number.isSafeInteger(value.sampleRate) ||
    !Number.isSafeInteger(value.channels) ||
    !exactString(value.userId) ||
    !exactString(value.continuityId) ||
    !exactString(value.purpose) ||
    !exactString(value.sessionId) ||
    !exactString(value.deviceId) ||
    !exactString(value.clientInstanceId) ||
    !exactString(value.segmentId) ||
    !exactString(value.speakerLabel) ||
    !exactString(value.observedAt) ||
    (value.diarizationStatus !== "window_local" && value.diarizationStatus !== "degraded") ||
    !Number.isSafeInteger(value.startMs) ||
    !Number.isSafeInteger(value.endMs) ||
    (!isPlainRecord(value.realtimeSessionRef) && typeof value.realtimeSessionRef !== "string")
  ) {
    fail("SOURCE_MEDIA_METADATA_INVALID");
  }
  const sourceArtifactRef = validateCanonicalRef(value.sourceArtifactRef);
  if (sourceArtifactRef.refType !== "SourceArtifact") {
    fail("SOURCE_MEDIA_METADATA_INVALID");
  }
  validateRecordHash(value);
  return { ...value, sourceArtifactRef } as ArtifactVersionRecord;
}

function validateSourceVisualArtifactRecord(value: unknown): SourceVisualArtifactRecord {
  const keys = [
    "byteLength",
    "canonicalPayloadSha256",
    "captureId",
    "capturedAt",
    "clientInstanceId",
    "contentSha256",
    "continuityId",
    "deviceId",
    "height",
    "mediaFormat",
    "mediaKind",
    "objectVersion",
    "purpose",
    "realtimeSessionRef",
    "refId",
    "refType",
    "schema",
    "sessionId",
    "userId",
    "width",
  ] as const;
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, keys) ||
    value.schema !== SOURCE_VISUAL_ARTIFACT_SCHEMA ||
    value.mediaKind !== "visual" ||
    value.refType !== "SourceArtifact" ||
    typeof value.refId !== "string" ||
    !UUID_V7.test(value.refId) ||
    value.objectVersion !== "1" ||
    !exactString(value.userId) ||
    !exactString(value.continuityId) ||
    !exactString(value.purpose) ||
    !exactString(value.sessionId) ||
    !exactString(value.deviceId) ||
    !exactString(value.clientInstanceId) ||
    !exactString(value.captureId) ||
    typeof value.capturedAt !== "string" ||
    !CANONICAL_TIMESTAMP.test(value.capturedAt) ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    !isVisualMediaFormat(value.mediaFormat) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    (value.width as number) <= 0 ||
    (value.height as number) <= 0 ||
    typeof value.contentSha256 !== "string" ||
    !SHA256.test(value.contentSha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    (!isPlainRecord(value.realtimeSessionRef) && typeof value.realtimeSessionRef !== "string")
  ) {
    fail("SOURCE_MEDIA_VISUAL_METADATA_INVALID");
  }
  validateRecordHash(value);
  return value as SourceVisualArtifactRecord;
}

function validateVisualArtifactVersionRecord(value: unknown): VisualArtifactVersionRecord {
  const keys = [
    "byteLength",
    "canonicalPayloadSha256",
    "captureId",
    "capturedAt",
    "casNamespace",
    "clientInstanceId",
    "contentSha256",
    "continuityId",
    "deviceId",
    "fingerprint",
    "height",
    "idempotencyKey",
    "mediaFormat",
    "mediaKind",
    "objectVersion",
    "purpose",
    "realtimeSessionRef",
    "refId",
    "refType",
    "schema",
    "sessionId",
    "sourceArtifactRef",
    "userId",
    "width",
  ] as const;
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, keys) ||
    value.schema !== VISUAL_ARTIFACT_VERSION_SCHEMA ||
    value.mediaKind !== "visual" ||
    value.refType !== "ArtifactVersion" ||
    typeof value.refId !== "string" ||
    !UUID_V7.test(value.refId) ||
    value.objectVersion !== "1" ||
    value.casNamespace !== CAS_NAMESPACE ||
    !exactString(value.userId) ||
    !exactString(value.continuityId) ||
    !exactString(value.purpose) ||
    !exactString(value.sessionId) ||
    !exactString(value.deviceId) ||
    !exactString(value.clientInstanceId) ||
    !exactString(value.captureId) ||
    typeof value.capturedAt !== "string" ||
    !CANONICAL_TIMESTAMP.test(value.capturedAt) ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    !isVisualMediaFormat(value.mediaFormat) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    (value.width as number) <= 0 ||
    (value.height as number) <= 0 ||
    typeof value.contentSha256 !== "string" ||
    !SHA256.test(value.contentSha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    !exactString(value.idempotencyKey) ||
    typeof value.fingerprint !== "string" ||
    !SHA256.test(value.fingerprint) ||
    (!isPlainRecord(value.realtimeSessionRef) && typeof value.realtimeSessionRef !== "string")
  ) {
    fail("SOURCE_MEDIA_VISUAL_METADATA_INVALID");
  }
  const sourceArtifactRef = validateCanonicalRef(value.sourceArtifactRef);
  if (sourceArtifactRef.refType !== "SourceArtifact") {
    fail("SOURCE_MEDIA_VISUAL_METADATA_INVALID");
  }
  validateRecordHash(value);
  return { ...value, sourceArtifactRef } as VisualArtifactVersionRecord;
}

function emptyCatalog(): SourceMediaCatalog {
  return {
    schema: CATALOG_SCHEMA,
    version: 1,
    sourceArtifacts: [],
    artifactVersions: [],
    visualArtifacts: [],
    visualVersions: [],
  };
}

function validateCatalog(value: unknown): SourceMediaCatalog {
  const baseKeys = ["artifactVersions", "schema", "sourceArtifacts", "version"] as const;
  const visualKeys = ["visualArtifacts", "visualVersions"] as const;
  const hasVisualFields =
    isPlainRecord(value) &&
    (value.visualArtifacts !== undefined || value.visualVersions !== undefined);
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, hasVisualFields ? [...baseKeys, ...visualKeys] : baseKeys) ||
    value.schema !== CATALOG_SCHEMA ||
    value.version !== 1 ||
    !Array.isArray(value.sourceArtifacts) ||
    !Array.isArray(value.artifactVersions) ||
    (hasVisualFields && !Array.isArray(value.visualArtifacts)) ||
    (hasVisualFields && !Array.isArray(value.visualVersions))
  ) {
    fail("SOURCE_MEDIA_METADATA_INVALID");
  }
  const sourceArtifacts = value.sourceArtifacts.map(validateSourceArtifactRecord);
  const artifactVersions = value.artifactVersions.map(validateArtifactVersionRecord);
  const visualArtifacts =
    hasVisualFields && Array.isArray(value.visualArtifacts)
      ? value.visualArtifacts.map(validateSourceVisualArtifactRecord)
      : [];
  const visualVersions =
    hasVisualFields && Array.isArray(value.visualVersions)
      ? value.visualVersions.map(validateVisualArtifactVersionRecord)
      : [];
  const sourceIds = new Set<string>();
  for (const source of sourceArtifacts) {
    if (sourceIds.has(source.refId)) {
      fail("SOURCE_MEDIA_METADATA_DUPLICATE");
    }
    sourceIds.add(source.refId);
  }
  for (const source of visualArtifacts) {
    if (sourceIds.has(source.refId)) {
      fail("SOURCE_MEDIA_METADATA_DUPLICATE");
    }
    sourceIds.add(source.refId);
  }
  const versionIds = new Set<string>();
  for (const version of artifactVersions) {
    if (versionIds.has(version.refId)) {
      fail("SOURCE_MEDIA_METADATA_DUPLICATE");
    }
    versionIds.add(version.refId);
    if (!sourceIds.has(version.sourceArtifactRef.refId)) {
      fail("SOURCE_MEDIA_METADATA_ORPHAN");
    }
  }
  for (const version of visualVersions) {
    if (versionIds.has(version.refId)) {
      fail("SOURCE_MEDIA_METADATA_DUPLICATE");
    }
    versionIds.add(version.refId);
    if (!sourceIds.has(version.sourceArtifactRef.refId)) {
      fail("SOURCE_MEDIA_METADATA_ORPHAN");
    }
  }
  return {
    schema: CATALOG_SCHEMA,
    version: 1,
    sourceArtifacts,
    artifactVersions,
    visualArtifacts,
    visualVersions,
  };
}

async function existsAsDirectory(path: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail("SOURCE_MEDIA_RUNTIME_REPARSE", path + " is not a regular directory");
    }
    const actual = await fs.realpath(path);
    if (resolve(actual).toLowerCase() !== resolve(path).toLowerCase()) {
      fail("SOURCE_MEDIA_RUNTIME_REPARSE", path + " does not resolve to itself");
    }
    return true;
  } catch (error) {
    if (error instanceof SourceMediaAuthorityError) {
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw new SourceMediaAuthorityError("SOURCE_MEDIA_RUNTIME_UNAVAILABLE");
  }
}

async function ensureDirectory(path: string): Promise<void> {
  if (!(await existsAsDirectory(path))) {
    try {
      await fs.mkdir(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new SourceMediaAuthorityError("SOURCE_MEDIA_RUNTIME_CREATE_FAILED");
      }
    }
    if (!(await existsAsDirectory(path))) {
      fail("SOURCE_MEDIA_RUNTIME_CREATE_FAILED");
    }
  }
}

async function regularFile(path: string): Promise<{ exists: boolean; nonReparse: boolean }> {
  try {
    const stats = await fs.lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail("SOURCE_MEDIA_RUNTIME_REPARSE", path + " is not a regular non-reparse file");
    }
    const actual = await fs.realpath(path);
    if (resolve(actual).toLowerCase() !== resolve(path).toLowerCase()) {
      fail("SOURCE_MEDIA_RUNTIME_REPARSE", path + " does not resolve to itself");
    }
    return { exists: true, nonReparse: true };
  } catch (error) {
    if (error instanceof SourceMediaAuthorityError) {
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, nonReparse: false };
    }
    throw new SourceMediaAuthorityError("SOURCE_MEDIA_RUNTIME_UNAVAILABLE");
  }
}

async function ensureMetadataLayout(): Promise<void> {
  const parent = join(PRODUCTION_ROOT, "..");
  if (!(await existsAsDirectory(parent))) {
    fail("SOURCE_MEDIA_RUNTIME_UNAVAILABLE", "the fixed production parent is unavailable");
  }
  await ensureDirectory(PRODUCTION_ROOT);
  await ensureDirectory(SOURCE_MEDIA_METADATA_ROOT);
}

async function metadataResidueCheck(): Promise<void> {
  await ensureMetadataLayout();
  let entries;
  try {
    entries = await fs.readdir(SOURCE_MEDIA_METADATA_ROOT, { withFileTypes: true });
  } catch {
    fail("SOURCE_MEDIA_METADATA_UNAVAILABLE");
  }
  for (const entry of entries) {
    if (entry.name !== "catalog.json") {
      fail("SOURCE_MEDIA_METADATA_RESIDUE", "unknown metadata residue is present");
    }
    if (entry.isSymbolicLink()) {
      fail("SOURCE_MEDIA_METADATA_RESIDUE", "catalog path is a reparse entry");
    }
  }
}

async function loadCatalog(): Promise<SourceMediaCatalog> {
  await metadataResidueCheck();
  try {
    const contents = await fs.readFile(SOURCE_MEDIA_CATALOG_PATH, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      fail("SOURCE_MEDIA_METADATA_INVALID");
    }
    return validateCatalog(parsed);
  } catch (error) {
    if (error instanceof SourceMediaAuthorityError) {
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyCatalog();
    }
    throw new SourceMediaAuthorityError("SOURCE_MEDIA_METADATA_UNAVAILABLE");
  }
}

async function commitCatalog(catalog: SourceMediaCatalog): Promise<void> {
  await metadataResidueCheck();
  const bytes = Buffer.from(canonicalJson(catalog), "utf8");
  const token = randomBytes(16).toString("hex");
  const tempPath = SOURCE_MEDIA_CATALOG_PATH + ".tmp-" + token;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let renamed = false;
  try {
    handle = await fs.open(tempPath, "wx");
    const stats = await handle.stat();
    if (!Number.isSafeInteger(stats.dev) || !Number.isSafeInteger(stats.ino)) {
      throw new SourceMediaAuthorityError("SOURCE_MEDIA_METADATA_COMMIT_FAILED");
    }
    tempIdentity = { dev: stats.dev, ino: stats.ino };
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, SOURCE_MEDIA_CATALOG_PATH);
    renamed = true;
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (!renamed) {
      try {
        const current = await fs.lstat(tempPath);
        if (
          tempIdentity !== undefined &&
          current.dev === tempIdentity.dev &&
          current.ino === tempIdentity.ino &&
          !current.isSymbolicLink()
        ) {
          await fs.unlink(tempPath);
        }
      } catch {
        // An unknown or replaced residue is deliberately left in place so
        // the next authority start fails closed instead of deleting it.
      }
    }
    throw new SourceMediaAuthorityError("SOURCE_MEDIA_METADATA_COMMIT_FAILED");
  }
  const persisted = await fs.readFile(SOURCE_MEDIA_CATALOG_PATH, "utf8");
  validateCatalog(JSON.parse(persisted) as unknown);
}

function sameArtifactBinding(record: ArtifactVersionRecord, input: SourceMediaIssueInput): boolean {
  return (
    record.userId === input.userId &&
    canonicalJson(record.realtimeSessionRef) === canonicalJson(input.realtimeSessionRef) &&
    record.continuityId === input.continuityId &&
    record.purpose === input.purpose &&
    record.sessionId === input.sessionId &&
    record.deviceId === input.deviceId &&
    record.clientInstanceId === input.clientInstanceId &&
    record.segmentId === input.segmentId &&
    record.startMs === input.startMs &&
    record.endMs === input.endMs &&
    record.speakerLabel === input.speakerLabel &&
    record.diarizationStatus === input.diarizationStatus &&
    record.observedAt === input.observedAt &&
    record.mediaFormat === input.media.format &&
    record.sampleRate === input.media.sampleRate &&
    record.channels === input.media.channels &&
    record.contentSha256 === input.media.sha256 &&
    record.byteLength === input.media.bytes.byteLength &&
    record.fingerprint === input.fingerprint
  );
}

function sameVisualBinding(record: VisualArtifactVersionRecord, input: SourceVisualIssueInput): boolean {
  return (
    record.userId === input.userId &&
    canonicalJson(record.realtimeSessionRef) === canonicalJson(input.realtimeSessionRef) &&
    record.continuityId === input.continuityId &&
    record.purpose === input.purpose &&
    record.sessionId === input.sessionId &&
    record.deviceId === input.deviceId &&
    record.clientInstanceId === input.clientInstanceId &&
    record.captureId === input.captureId &&
    record.capturedAt === input.capturedAt &&
    record.mediaFormat === input.media.format &&
    record.width === input.media.width &&
    record.height === input.media.height &&
    record.contentSha256 === input.media.sha256 &&
    record.byteLength === input.media.bytes.byteLength &&
    record.fingerprint === input.fingerprint
  );
}

function receiptFromRecords(
  source: SourceArtifactRecord,
  version: ArtifactVersionRecord,
): SourceMediaIssueReceipt {
  return {
    sourceArtifactRef: canonicalRef("SourceArtifact", source.refId, source.canonicalPayloadSha256),
    artifactVersionRef: canonicalRef("ArtifactVersion", version.refId, version.canonicalPayloadSha256),
    contentSha256: version.contentSha256,
    bytes: version.byteLength,
  };
}

function visualReceiptFromRecords(
  source: SourceVisualArtifactRecord,
  version: VisualArtifactVersionRecord,
): SourceVisualIssueReceipt {
  return {
    sourceArtifactRef: canonicalRef("SourceArtifact", source.refId, source.canonicalPayloadSha256),
    artifactVersionRef: canonicalRef("ArtifactVersion", version.refId, version.canonicalPayloadSha256),
    contentSha256: version.contentSha256,
    bytes: version.byteLength,
    mediaKind: "visual",
    captureId: version.captureId,
    capturedAt: version.capturedAt,
    format: version.mediaFormat,
    width: version.width,
    height: version.height,
  };
}

export class SourceMediaAuthority implements SourceMediaAuthorityPort {
  private readonly cas: ReturnType<typeof createProductionColdCas>;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(fault?: FaultHook) {
    this.cas =
      fault === undefined
        ? createProductionColdCas()
        : createProductionColdCas({ fault });
  }

  public issue(input: SourceMediaIssueInput): Promise<T11BCanonicalRef> {
    return this.enqueue(async () => {
      const receipt = await this.issueInternal(input);
      return receipt.artifactVersionRef;
    });
  }

  public issueWithReceipt(input: SourceMediaIssueInput): Promise<SourceMediaIssueReceipt> {
    return this.enqueue(() => this.issueInternal(input));
  }

  public issueVisual(input: SourceVisualIssueInput): Promise<T11BCanonicalRef> {
    return this.enqueue(async () => {
      const receipt = await this.issueVisualInternal(input);
      return receipt.artifactVersionRef;
    });
  }

  public issueVisualWithReceipt(input: SourceVisualIssueInput): Promise<SourceVisualIssueReceipt> {
    return this.enqueue(() => this.issueVisualInternal(input));
  }

  public read(request: SourceMediaReadRequest): Promise<SourceMediaReadResult> {
    return this.enqueue(() => this.readInternal(request));
  }

  public readVisual(request: SourceVisualReadRequest): Promise<SourceVisualReadResult> {
    return this.enqueue(() => this.readVisualInternal(request));
  }

  public inspectRuntime(): Promise<SourceMediaRuntimeFacts> {
    return this.enqueue(async () => {
      const runtimeRootExists = await existsAsDirectory(SOURCE_MEDIA_RUNTIME_ROOT);
      const casRootExists = await existsAsDirectory(SOURCE_MEDIA_CAS_ROOT);
      const metadataRootExists = await existsAsDirectory(SOURCE_MEDIA_METADATA_ROOT);
      const catalog = await regularFile(SOURCE_MEDIA_CATALOG_PATH);
      return {
        runtimeRoot: SOURCE_MEDIA_RUNTIME_ROOT,
        casRoot: SOURCE_MEDIA_CAS_ROOT,
        metadataRoot: SOURCE_MEDIA_METADATA_ROOT,
        catalogPath: SOURCE_MEDIA_CATALOG_PATH,
        helperExecutable: PRODUCTION_HELPER_EXECUTABLE,
        runtimeRootExists,
        casRootExists,
        metadataRootExists,
        catalogExists: catalog.exists,
        runtimeRootNonReparse: runtimeRootExists,
        casRootNonReparse: casRootExists,
        metadataRootNonReparse: metadataRootExists,
        catalogNonReparse: catalog.nonReparse,
      };
    });
  }

  public async close(): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.closed) {
        this.closed = true;
        await this.cas.close();
      }
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.closed) {
        fail("SOURCE_MEDIA_AUTHORITY_CLOSED");
      }
      return operation();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async issueInternal(rawInput: SourceMediaIssueInput): Promise<SourceMediaIssueReceipt> {
    const input = normalizeIssueInput(rawInput);
    const catalog = await loadCatalog();
    const replay = catalog.artifactVersions.find(
      (version) => version.idempotencyKey === input.idempotencyKey,
    );
    if (replay !== undefined) {
      if (!sameArtifactBinding(replay, input)) {
        fail("SOURCE_MEDIA_IDEMPOTENCY_CONFLICT");
      }
      const source = catalog.sourceArtifacts.find(
        (candidate) => candidate.refId === replay.sourceArtifactRef.refId,
      );
      if (source === undefined || source.canonicalPayloadSha256 !== replay.sourceArtifactRef.canonicalPayloadSha256) {
        fail("SOURCE_MEDIA_METADATA_ORPHAN");
      }
      const bytes = await this.cas.read(replay.contentSha256);
      if (bytes.byteLength !== replay.byteLength || sha256(bytes) !== replay.contentSha256) {
        fail("SOURCE_MEDIA_CAS_READBACK_MISMATCH");
      }
      return receiptFromRecords(source, replay);
    }

    const sourceSeed = sha256(
      canonicalJson({
        domain: SOURCE_ARTIFACT_SCHEMA,
        userId: input.userId,
        realtimeSessionRef: input.realtimeSessionRef,
        continuityId: input.continuityId,
        purpose: input.purpose,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        clientInstanceId: input.clientInstanceId,
        segmentId: input.segmentId,
        startMs: input.startMs,
        endMs: input.endMs,
        mediaSha256: input.media.sha256,
      }),
    );
    const sourceRefId = deterministicUuidV7(input.observedAt, SOURCE_ARTIFACT_SCHEMA, sourceSeed);
    const sourcePayloadValue = sourcePayload(input, sourceRefId);
    const sourceRecord = withCanonicalHash(sourcePayloadValue) as SourceArtifactRecord;
    const sourceRef = canonicalRef("SourceArtifact", sourceRefId, sourceRecord.canonicalPayloadSha256);
    const versionSeed = sha256(
      canonicalJson({
        domain: ARTIFACT_VERSION_SCHEMA,
        sourceArtifactRef: sourceRef,
        fingerprint: input.fingerprint,
        idempotencyKey: input.idempotencyKey,
        mediaSha256: input.media.sha256,
      }),
    );
    const versionRefId = deterministicUuidV7(input.observedAt, ARTIFACT_VERSION_SCHEMA, versionSeed);
    const versionPayloadValue = artifactVersionPayload(input, versionRefId, sourceRef);
    const versionRecord = withCanonicalHash(versionPayloadValue) as ArtifactVersionRecord;

    if (catalog.sourceArtifacts.some((candidate) => candidate.refId === sourceRecord.refId)) {
      fail("SOURCE_MEDIA_METADATA_COLLISION");
    }
    if (catalog.artifactVersions.some((candidate) => candidate.refId === versionRecord.refId)) {
      fail("SOURCE_MEDIA_METADATA_COLLISION");
    }

    const published = await this.cas.publish({
      hash: input.media.sha256,
      source: input.media.bytes,
    });
    if (published.status === "corrupt_existing" || published.status === "failed_cleanup_pending") {
      fail("SOURCE_MEDIA_CAS_PUBLISH_FAILED");
    }
    const readback = await this.cas.read(input.media.sha256);
    if (readback.byteLength !== input.media.bytes.byteLength || sha256(readback) !== input.media.sha256) {
      fail("SOURCE_MEDIA_CAS_READBACK_MISMATCH");
    }
    const nextCatalog: SourceMediaCatalog = {
      schema: CATALOG_SCHEMA,
      version: 1,
      sourceArtifacts: [...catalog.sourceArtifacts, sourceRecord],
      artifactVersions: [...catalog.artifactVersions, versionRecord],
      visualArtifacts: catalog.visualArtifacts,
      visualVersions: catalog.visualVersions,
    };
    await commitCatalog(nextCatalog);
    return receiptFromRecords(sourceRecord, versionRecord);
  }

  private async issueVisualInternal(rawInput: SourceVisualIssueInput): Promise<SourceVisualIssueReceipt> {
    const input = normalizeVisualIssueInput(rawInput);
    const catalog = await loadCatalog();
    const replay = catalog.visualVersions.find(
      (version) => version.idempotencyKey === input.idempotencyKey,
    );
    if (replay !== undefined) {
      if (!sameVisualBinding(replay, input)) {
        fail("SOURCE_MEDIA_VISUAL_IDEMPOTENCY_CONFLICT");
      }
      const source = catalog.visualArtifacts.find(
        (candidate) => candidate.refId === replay.sourceArtifactRef.refId,
      );
      if (
        source === undefined ||
        source.canonicalPayloadSha256 !== replay.sourceArtifactRef.canonicalPayloadSha256
      ) {
        fail("SOURCE_MEDIA_VISUAL_METADATA_ORPHAN");
      }
      const bytes = await this.cas.read(replay.contentSha256);
      if (bytes.byteLength !== replay.byteLength || sha256(bytes) !== replay.contentSha256) {
        fail("SOURCE_MEDIA_VISUAL_CAS_READBACK_MISMATCH");
      }
      return visualReceiptFromRecords(source, replay);
    }

    const sourceSeed = sha256(
      canonicalJson({
        domain: SOURCE_VISUAL_ARTIFACT_SCHEMA,
        mediaKind: "visual",
        userId: input.userId,
        realtimeSessionRef: input.realtimeSessionRef,
        continuityId: input.continuityId,
        purpose: input.purpose,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        clientInstanceId: input.clientInstanceId,
        captureId: input.captureId,
        capturedAt: input.capturedAt,
        mediaFormat: input.media.format,
        width: input.media.width,
        height: input.media.height,
        mediaSha256: input.media.sha256,
      }),
    );
    const sourceRefId = deterministicUuidV7(input.capturedAt, SOURCE_VISUAL_ARTIFACT_SCHEMA, sourceSeed);
    const sourcePayloadValue = visualSourcePayload(input, sourceRefId);
    const sourceRecord = withCanonicalHash(sourcePayloadValue) as SourceVisualArtifactRecord;
    const sourceRef = canonicalRef("SourceArtifact", sourceRefId, sourceRecord.canonicalPayloadSha256);
    const versionSeed = sha256(
      canonicalJson({
        domain: VISUAL_ARTIFACT_VERSION_SCHEMA,
        mediaKind: "visual",
        sourceArtifactRef: sourceRef,
        captureId: input.captureId,
        fingerprint: input.fingerprint,
        idempotencyKey: input.idempotencyKey,
        mediaSha256: input.media.sha256,
      }),
    );
    const versionRefId = deterministicUuidV7(input.capturedAt, VISUAL_ARTIFACT_VERSION_SCHEMA, versionSeed);
    const versionPayloadValue = visualVersionPayload(input, versionRefId, sourceRef);
    const versionRecord = withCanonicalHash(versionPayloadValue) as VisualArtifactVersionRecord;

    if (
      catalog.sourceArtifacts.some((candidate) => candidate.refId === sourceRecord.refId) ||
      catalog.visualArtifacts.some((candidate) => candidate.refId === sourceRecord.refId)
    ) {
      fail("SOURCE_MEDIA_VISUAL_METADATA_COLLISION");
    }
    if (
      catalog.artifactVersions.some((candidate) => candidate.refId === versionRecord.refId) ||
      catalog.visualVersions.some((candidate) => candidate.refId === versionRecord.refId)
    ) {
      fail("SOURCE_MEDIA_VISUAL_METADATA_COLLISION");
    }

    const published = await this.cas.publish({
      hash: input.media.sha256,
      source: input.media.bytes,
    });
    if (published.status === "corrupt_existing" || published.status === "failed_cleanup_pending") {
      fail("SOURCE_MEDIA_VISUAL_CAS_PUBLISH_FAILED");
    }
    const readback = await this.cas.read(input.media.sha256);
    if (readback.byteLength !== input.media.bytes.byteLength || sha256(readback) !== input.media.sha256) {
      fail("SOURCE_MEDIA_VISUAL_CAS_READBACK_MISMATCH");
    }
    const nextCatalog: SourceMediaCatalog = {
      schema: CATALOG_SCHEMA,
      version: 1,
      sourceArtifacts: catalog.sourceArtifacts,
      artifactVersions: catalog.artifactVersions,
      visualArtifacts: [...catalog.visualArtifacts, sourceRecord],
      visualVersions: [...catalog.visualVersions, versionRecord],
    };
    await commitCatalog(nextCatalog);
    return visualReceiptFromRecords(sourceRecord, versionRecord);
  }

  private async readInternal(request: SourceMediaReadRequest): Promise<SourceMediaReadResult> {
    const requestedRef = validateCanonicalRef(request.ref);
    const expectedContentSha256 =
      request.expectedContentSha256 === undefined
        ? undefined
        : exactSha256(request.expectedContentSha256, "SOURCE_MEDIA_READ_HASH_INVALID");
    const catalog = await loadCatalog();
    const version =
      requestedRef.refType === "ArtifactVersion"
        ? catalog.artifactVersions.find(
            (candidate) =>
              candidate.refId === requestedRef.refId &&
              candidate.canonicalPayloadSha256 === requestedRef.canonicalPayloadSha256,
          )
        : undefined;
    let selectedVersion = version;
    if (requestedRef.refType === "SourceArtifact") {
      const candidates = catalog.artifactVersions.filter(
        (candidate) =>
          candidate.sourceArtifactRef.refId === requestedRef.refId &&
          candidate.sourceArtifactRef.canonicalPayloadSha256 === requestedRef.canonicalPayloadSha256,
      );
      if (expectedContentSha256 !== undefined) {
        selectedVersion = candidates.find((candidate) => candidate.contentSha256 === expectedContentSha256);
      } else if (candidates.length === 1) {
        selectedVersion = candidates[0];
      } else if (candidates.length > 1) {
        fail("SOURCE_MEDIA_SOURCE_REF_AMBIGUOUS");
      }
    }
    if (selectedVersion === undefined) {
      fail("SOURCE_MEDIA_REFERENCE_NOT_FOUND");
    }
    if (expectedContentSha256 !== undefined && selectedVersion.contentSha256 !== expectedContentSha256) {
      fail("SOURCE_MEDIA_READ_HASH_MISMATCH");
    }
    const source = catalog.sourceArtifacts.find(
      (candidate) =>
        candidate.refId === selectedVersion.sourceArtifactRef.refId &&
        candidate.canonicalPayloadSha256 === selectedVersion.sourceArtifactRef.canonicalPayloadSha256,
    );
    if (source === undefined) {
      fail("SOURCE_MEDIA_METADATA_ORPHAN");
    }
    const bytes = await this.cas.read(selectedVersion.contentSha256);
    if (bytes.byteLength !== selectedVersion.byteLength || sha256(bytes) !== selectedVersion.contentSha256) {
      fail("SOURCE_MEDIA_CAS_READBACK_MISMATCH");
    }
    return {
      sourceArtifactRef: canonicalRef("SourceArtifact", source.refId, source.canonicalPayloadSha256),
      artifactVersionRef: canonicalRef(
        "ArtifactVersion",
        selectedVersion.refId,
        selectedVersion.canonicalPayloadSha256,
      ),
      contentSha256: selectedVersion.contentSha256,
      bytes,
    };
  }

  private async readVisualInternal(request: SourceVisualReadRequest): Promise<SourceVisualReadResult> {
    const requestedRef = validateCanonicalRef(request.ref);
    const expectedContentSha256 =
      request.expectedContentSha256 === undefined
        ? undefined
        : exactSha256(request.expectedContentSha256, "SOURCE_MEDIA_VISUAL_READ_HASH_INVALID");
    const catalog = await loadCatalog();
    const version =
      requestedRef.refType === "ArtifactVersion"
        ? catalog.visualVersions.find(
            (candidate) =>
              candidate.refId === requestedRef.refId &&
              candidate.canonicalPayloadSha256 === requestedRef.canonicalPayloadSha256,
          )
        : undefined;
    let selectedVersion = version;
    let sourceCandidates: VisualArtifactVersionRecord[] = [];
    if (requestedRef.refType === "SourceArtifact") {
      sourceCandidates = catalog.visualVersions.filter(
        (candidate) =>
          candidate.sourceArtifactRef.refId === requestedRef.refId &&
          candidate.sourceArtifactRef.canonicalPayloadSha256 === requestedRef.canonicalPayloadSha256,
      );
      if (expectedContentSha256 !== undefined) {
        selectedVersion = sourceCandidates.find(
          (candidate) => candidate.contentSha256 === expectedContentSha256,
        );
        if (selectedVersion === undefined && sourceCandidates.length > 0) {
          fail("SOURCE_MEDIA_VISUAL_READ_HASH_MISMATCH");
        }
      } else if (sourceCandidates.length === 1) {
        selectedVersion = sourceCandidates[0];
      } else if (sourceCandidates.length > 1) {
        fail("SOURCE_MEDIA_VISUAL_SOURCE_REF_AMBIGUOUS");
      }
    }
    if (selectedVersion === undefined) {
      fail("SOURCE_MEDIA_VISUAL_REFERENCE_NOT_FOUND");
    }
    if (
      expectedContentSha256 !== undefined &&
      selectedVersion.contentSha256 !== expectedContentSha256
    ) {
      fail("SOURCE_MEDIA_VISUAL_READ_HASH_MISMATCH");
    }
    const source = catalog.visualArtifacts.find(
      (candidate) =>
        candidate.refId === selectedVersion.sourceArtifactRef.refId &&
        candidate.canonicalPayloadSha256 === selectedVersion.sourceArtifactRef.canonicalPayloadSha256,
    );
    if (source === undefined) {
      fail("SOURCE_MEDIA_VISUAL_METADATA_ORPHAN");
    }
    const bytes = await this.cas.read(selectedVersion.contentSha256);
    if (bytes.byteLength !== selectedVersion.byteLength || sha256(bytes) !== selectedVersion.contentSha256) {
      fail("SOURCE_MEDIA_VISUAL_CAS_READBACK_MISMATCH");
    }
    return {
      sourceArtifactRef: canonicalRef("SourceArtifact", source.refId, source.canonicalPayloadSha256),
      artifactVersionRef: canonicalRef(
        "ArtifactVersion",
        selectedVersion.refId,
        selectedVersion.canonicalPayloadSha256,
      ),
      contentSha256: selectedVersion.contentSha256,
      bytes,
      mediaKind: "visual",
      captureId: selectedVersion.captureId,
      capturedAt: selectedVersion.capturedAt,
      format: selectedVersion.mediaFormat,
      width: selectedVersion.width,
      height: selectedVersion.height,
    };
  }
}

export function createSourceMediaAuthority(options: { readonly fault?: FaultHook } = {}): SourceMediaAuthorityPort {
  return new SourceMediaAuthority(options.fault);
}

interface ProcessIssueRequest extends JsonRecord {
  readonly operation: "issue";
  readonly user_id: string;
  readonly realtime_session_ref: unknown;
  readonly continuity_id: string;
  readonly purpose: string;
  readonly session_id: string;
  readonly device_id: string;
  readonly client_instance_id: string;
  readonly segment_id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly speaker_label: string;
  readonly diarization_status: "window_local" | "degraded";
  readonly observed_at: string;
  readonly media: JsonRecord;
  readonly idempotency_key: string;
  readonly fingerprint: string;
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    fail("SOURCE_MEDIA_PROTOCOL_INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    fail("SOURCE_MEDIA_PROTOCOL_INVALID");
  }
  return new Uint8Array(bytes);
}

function protocolIssue(value: JsonRecord): SourceMediaIssueInput {
  const keys = [
    "client_instance_id",
    "continuity_id",
    "device_id",
    "diarization_status",
    "end_ms",
    "fingerprint",
    "idempotency_key",
    "media",
    "observed_at",
    "operation",
    "purpose",
    "realtime_session_ref",
    "segment_id",
    "session_id",
    "speaker_label",
    "start_ms",
    "user_id",
  ] as const;
  if (!exactKeys(value, keys) || value.operation !== "issue" || !isPlainRecord(value.media)) {
    fail("SOURCE_MEDIA_PROTOCOL_INVALID");
  }
  const mediaKeys = ["bytes_base64", "channels", "format", "sample_rate", "sha256"] as const;
  if (!exactKeys(value.media, mediaKeys)) {
    fail("SOURCE_MEDIA_PROTOCOL_INVALID");
  }
  return {
    userId: value.user_id as string,
    realtimeSessionRef: value.realtime_session_ref,
    continuityId: value.continuity_id as string,
    purpose: value.purpose as string,
    sessionId: value.session_id as string,
    deviceId: value.device_id as string,
    clientInstanceId: value.client_instance_id as string,
    segmentId: value.segment_id as string,
    startMs: value.start_ms as number,
    endMs: value.end_ms as number,
    speakerLabel: value.speaker_label as string,
    diarizationStatus: value.diarization_status as "window_local" | "degraded",
    observedAt: value.observed_at as string,
    media: {
      format: value.media.format as SourceMediaFormat,
      sampleRate: value.media.sample_rate as number,
      channels: value.media.channels as number,
      sha256: value.media.sha256 as string,
      bytes: decodeBase64(value.media.bytes_base64),
    },
    idempotencyKey: value.idempotency_key as string,
    fingerprint: value.fingerprint as string,
  };
}

function protocolVisualIssue(value: JsonRecord): SourceVisualIssueInput {
  const keys = [
    "capture_id",
    "captured_at",
    "client_instance_id",
    "continuity_id",
    "device_id",
    "fingerprint",
    "idempotency_key",
    "media",
    "operation",
    "purpose",
    "realtime_session_ref",
    "session_id",
    "user_id",
  ] as const;
  if (
    !exactKeys(value, keys) ||
    value.operation !== "issue_visual" ||
    !isPlainRecord(value.media)
  ) {
    fail("SOURCE_MEDIA_VISUAL_PROTOCOL_INVALID");
  }
  const mediaKeys = ["bytes_base64", "format", "height", "sha256", "width"] as const;
  if (!exactKeys(value.media, mediaKeys)) {
    fail("SOURCE_MEDIA_VISUAL_PROTOCOL_INVALID");
  }
  return {
    userId: value.user_id as string,
    realtimeSessionRef: value.realtime_session_ref,
    continuityId: value.continuity_id as string,
    purpose: value.purpose as string,
    sessionId: value.session_id as string,
    deviceId: value.device_id as string,
    clientInstanceId: value.client_instance_id as string,
    captureId: value.capture_id as string,
    capturedAt: value.captured_at as string,
    media: {
      format: value.media.format as SourceVisualMediaFormat,
      width: value.media.width as number,
      height: value.media.height as number,
      sha256: value.media.sha256 as string,
      bytes: decodeBase64(value.media.bytes_base64),
    },
    idempotencyKey: value.idempotency_key as string,
    fingerprint: value.fingerprint as string,
  };
}

function protocolRef(value: unknown): T11BCanonicalRef {
  return validateCanonicalRef(value);
}

async function processRequest(
  value: unknown,
  authority: SourceMediaAuthorityPort,
): Promise<{ readonly response: JsonRecord; readonly close: boolean }> {
  if (!isPlainRecord(value) || typeof value.operation !== "string") {
    fail("SOURCE_MEDIA_PROTOCOL_INVALID");
  }
  if (value.operation === "issue") {
    const receipt = await authority.issueWithReceipt(protocolIssue(value));
    return {
      response: {
        ok: true,
        source_artifact_ref: receipt.sourceArtifactRef,
        artifact_version_ref: receipt.artifactVersionRef,
        content_sha256: receipt.contentSha256,
        bytes: receipt.bytes,
      },
      close: false,
    };
  }
  if (value.operation === "issue_visual") {
    const receipt = await authority.issueVisualWithReceipt(protocolVisualIssue(value));
    return {
      response: {
        ok: true,
        source_artifact_ref: receipt.sourceArtifactRef,
        artifact_version_ref: receipt.artifactVersionRef,
        content_sha256: receipt.contentSha256,
        bytes: receipt.bytes,
        media_kind: receipt.mediaKind,
        capture_id: receipt.captureId,
        captured_at: receipt.capturedAt,
        format: receipt.format,
        width: receipt.width,
        height: receipt.height,
      },
      close: false,
    };
  }
  if (value.operation === "read") {
    if (
      !exactKeys(value, ["content_sha256", "operation", "ref"]) ||
      typeof value.content_sha256 !== "string"
    ) {
      fail("SOURCE_MEDIA_PROTOCOL_INVALID");
    }
    const result = await authority.read({
      ref: protocolRef(value.ref),
      expectedContentSha256: value.content_sha256,
    });
    return {
      response: {
        ok: true,
        source_artifact_ref: result.sourceArtifactRef,
        artifact_version_ref: result.artifactVersionRef,
        content_sha256: result.contentSha256,
        bytes_base64: Buffer.from(result.bytes).toString("base64"),
      },
      close: false,
    };
  }
  if (value.operation === "read_visual") {
    if (
      !exactKeys(value, ["content_sha256", "operation", "ref"]) ||
      typeof value.content_sha256 !== "string"
    ) {
      fail("SOURCE_MEDIA_VISUAL_PROTOCOL_INVALID");
    }
    const result = await authority.readVisual({
      ref: protocolRef(value.ref),
      expectedContentSha256: value.content_sha256,
    });
    return {
      response: {
        ok: true,
        source_artifact_ref: result.sourceArtifactRef,
        artifact_version_ref: result.artifactVersionRef,
        content_sha256: result.contentSha256,
        bytes_base64: Buffer.from(result.bytes).toString("base64"),
        media_kind: result.mediaKind,
        capture_id: result.captureId,
        captured_at: result.capturedAt,
        format: result.format,
        width: result.width,
        height: result.height,
      },
      close: false,
    };
  }
  if (value.operation === "close") {
    if (!exactKeys(value, ["operation"])) {
      fail("SOURCE_MEDIA_PROTOCOL_INVALID");
    }
    return { response: { ok: true, closed: true }, close: true };
  }
  fail("SOURCE_MEDIA_PROTOCOL_INVALID");
}

function processError(error: unknown): JsonRecord {
  if (error instanceof SourceMediaAuthorityError) {
    return { ok: false, code: error.code };
  }
  if (error instanceof ColdCasError) {
    return { ok: false, code: "CAS_" + error.code };
  }
  return { ok: false, code: "SOURCE_MEDIA_AUTHORITY_FAILED" };
}

export async function runSourceMediaAuthorityStdio(): Promise<void> {
  const authority = createSourceMediaAuthority();
  let closing = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line.trim().length === 0) {
        process.stdout.write(JSON.stringify({ ok: false, code: "SOURCE_MEDIA_PROTOCOL_INVALID" }) + "\n");
        continue;
      }
      let request: unknown;
      try {
        request = JSON.parse(line) as unknown;
      } catch {
        process.stdout.write(JSON.stringify({ ok: false, code: "SOURCE_MEDIA_PROTOCOL_INVALID" }) + "\n");
        continue;
      }
      try {
        const result = await processRequest(request, authority);
        process.stdout.write(JSON.stringify(result.response) + "\n");
        if (result.close) {
          closing = true;
          break;
        }
      } catch (error) {
        process.stdout.write(JSON.stringify(processError(error)) + "\n");
      }
    }
  } finally {
    input.close();
    await authority.close().catch(() => undefined);
    if (!closing) {
      process.exitCode = 0;
    }
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
) {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== SOURCE_MEDIA_PROCESS_ARG) {
    process.exitCode = 64;
  } else {
    await runSourceMediaAuthorityStdio();
  }
}
