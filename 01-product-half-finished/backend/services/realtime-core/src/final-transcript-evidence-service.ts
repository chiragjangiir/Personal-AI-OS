import { createHash } from "node:crypto";

import type { RealtimeAuthorityRepository } from "./ports.ts";
import type {
  CanonicalTimestamp,
  IdempotencyKey,
  OpaqueCanonicalRef,
  RealtimeSessionRecord,
} from "./types.ts";

const OPERATION = "final_transcript_evidence" as const;
const EVENT_TYPE = "realtime.transcript_segment.finalized.v1" as const;
const MAX_TRANSCRIPT_BYTES = 16_384;
const REF_KEYS = Object.freeze([
  "refType",
  "refId",
  "objectVersion",
  "canonicalPayloadSha256",
] as const);
const INPUT_KEYS = Object.freeze([
  "transcriptState",
  "userId",
  "deviceId",
  "realtimeSessionRef",
  "continuityId",
  "purpose",
  "text",
  "language",
  "sourceMediaRef",
  "observedAt",
  "idempotencyKey",
  "correction",
] as const);
const CORRECTION_KEYS = Object.freeze([
  "previousTranscriptSegmentRef",
  "previousFinalEvidenceRef",
  "correctionReason",
] as const);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_VERSION = /^[1-9][0-9]*$/u;
const CANONICAL_TIMESTAMP =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.(?:[0-9]{3}|[0-9]{6})Z$/u;

type PlainRecord = Record<string, unknown>;

export class FinalTranscriptEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "FinalTranscriptEvidenceError";
    this.code = code;
  }
}

export interface T11BCanonicalRef {
  readonly refType: "TranscriptSegment" | "FinalTranscriptEvidence" | "SourceArtifact" | "ArtifactVersion";
  readonly refId: string;
  readonly objectVersion: string;
  readonly canonicalPayloadSha256: string;
}

export interface FinalTranscriptCorrection {
  readonly previousTranscriptSegmentRef: T11BCanonicalRef;
  readonly previousFinalEvidenceRef: T11BCanonicalRef;
  readonly correctionReason: string;
}

export interface FinalTranscriptEvidenceInput {
  readonly transcriptState: "final";
  readonly userId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly purpose: string;
  readonly text: string;
  readonly language: string;
  readonly sourceMediaRef: T11BCanonicalRef;
  readonly observedAt: CanonicalTimestamp;
  readonly idempotencyKey: IdempotencyKey;
  readonly correction?: FinalTranscriptCorrection;
}

export interface FinalTranscriptEvidenceResult {
  readonly transcriptSegmentRef: T11BCanonicalRef;
  readonly evidenceRef: T11BCanonicalRef;
  readonly outboxEventRef: OpaqueCanonicalRef;
  readonly observedAt: CanonicalTimestamp;
}

export interface FinalTranscriptEvidenceService {
  finalize(input: FinalTranscriptEvidenceInput): Promise<FinalTranscriptEvidenceResult>;
}

function fail(code: string, cause?: unknown): never {
  throw new FinalTranscriptEvidenceError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    fail("FINAL_TRANSCRIPT_INPUT_INVALID");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      keys.some((key) => !allowed.has(key))) {
    fail("FINAL_TRANSCRIPT_INPUT_INVALID");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail("FINAL_TRANSCRIPT_INPUT_INVALID");
    }
  }
  return value;
}

function exactString(value: unknown, code = "FINAL_TRANSCRIPT_INPUT_INVALID"): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.includes("\u0000")) fail(code);
  return value;
}

function canonicalTime(value: unknown): CanonicalTimestamp {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value) ||
      !Number.isFinite(Date.parse(value))) fail("FINAL_TRANSCRIPT_TIME_INVALID");
  return value as CanonicalTimestamp;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) throw new TypeError("non-JSON value");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function stableKey(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    fail("FINAL_TRANSCRIPT_REFERENCE_INVALID", error);
  }
}

function canonicalRef(
  value: unknown,
  allowedTypes: readonly T11BCanonicalRef["refType"][],
): T11BCanonicalRef {
  const record = exactRecord(value, REF_KEYS);
  if (typeof record.refType !== "string" || !allowedTypes.includes(record.refType as never) ||
      typeof record.refId !== "string" || !UUID_V7.test(record.refId) ||
      typeof record.objectVersion !== "string" || !POSITIVE_VERSION.test(record.objectVersion) ||
      typeof record.canonicalPayloadSha256 !== "string" ||
      !SHA256.test(record.canonicalPayloadSha256)) {
    fail("FINAL_TRANSCRIPT_REFERENCE_INVALID");
  }
  return Object.freeze({
    refType: record.refType as T11BCanonicalRef["refType"],
    refId: record.refId,
    objectVersion: record.objectVersion,
    canonicalPayloadSha256: record.canonicalPayloadSha256,
  });
}

function deterministicUuidV7(observedAt: CanonicalTimestamp, domain: string, fingerprint: string): string {
  const millis = Date.parse(observedAt);
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 0xffffffffffff) {
    fail("FINAL_TRANSCRIPT_TIME_INVALID");
  }
  const bytes = Buffer.alloc(16);
  let remaining = BigInt(millis);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const entropy = createHash("sha256").update(`${domain}\n${fingerprint}`, "utf8").digest();
  bytes[6] = 0x70 | (entropy[0]! & 0x0f);
  bytes[7] = entropy[1]!;
  bytes[8] = 0x80 | (entropy[2]! & 0x3f);
  entropy.copy(bytes, 9, 3, 10);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeRef(
  refType: "TranscriptSegment" | "FinalTranscriptEvidence",
  observedAt: CanonicalTimestamp,
  fingerprint: string,
  payload: unknown,
): T11BCanonicalRef {
  return Object.freeze({
    refType,
    refId: deterministicUuidV7(observedAt, refType, fingerprint),
    objectVersion: "1",
    canonicalPayloadSha256: sha256(payload),
  });
}

function normalizeInput(value: FinalTranscriptEvidenceInput | unknown): FinalTranscriptEvidenceInput {
  const record = exactRecord(value, INPUT_KEYS.slice(0, -1), ["correction"]);
  if (record.transcriptState !== "final") fail("FINAL_TRANSCRIPT_STATE_REQUIRED");
  const text = exactString(record.text, "FINAL_TRANSCRIPT_TEXT_INVALID");
  if (Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES) {
    fail("FINAL_TRANSCRIPT_TEXT_INVALID");
  }
  const language = exactString(record.language);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) {
    fail("FINAL_TRANSCRIPT_LANGUAGE_INVALID");
  }
  const sourceMediaRef = canonicalRef(record.sourceMediaRef, ["SourceArtifact", "ArtifactVersion"]);
  let correction: FinalTranscriptCorrection | undefined;
  if (record.correction !== undefined) {
    const item = exactRecord(record.correction, CORRECTION_KEYS);
    correction = Object.freeze({
      previousTranscriptSegmentRef: canonicalRef(item.previousTranscriptSegmentRef, ["TranscriptSegment"]),
      previousFinalEvidenceRef: canonicalRef(item.previousFinalEvidenceRef, ["FinalTranscriptEvidence"]),
      correctionReason: exactString(item.correctionReason, "FINAL_TRANSCRIPT_CORRECTION_INVALID"),
    });
  }
  const normalized = {
    transcriptState: "final" as const,
    userId: exactString(record.userId),
    deviceId: exactString(record.deviceId),
    realtimeSessionRef: cloneJson(record.realtimeSessionRef) as OpaqueCanonicalRef,
    continuityId: exactString(record.continuityId),
    purpose: exactString(record.purpose),
    text,
    language,
    sourceMediaRef,
    observedAt: canonicalTime(record.observedAt),
    idempotencyKey: exactString(record.idempotencyKey) as IdempotencyKey,
    ...(correction === undefined ? {} : { correction }),
  };
  stableKey(normalized.realtimeSessionRef);
  return Object.freeze(normalized);
}

function sessionMatches(
  session: RealtimeSessionRecord,
  input: FinalTranscriptEvidenceInput,
): boolean {
  return session.state === "active" && session.continuityState === "active" &&
    session.userId === input.userId && session.activeDeviceId === input.deviceId &&
    session.continuityId === input.continuityId &&
    stableKey(session.realtimeSessionRef) === stableKey(input.realtimeSessionRef) &&
    Date.parse(input.observedAt) <= Date.parse(session.continuityExpiresAt);
}

function replayResult(value: unknown): FinalTranscriptEvidenceResult {
  const record = exactRecord(value, [
    "transcriptSegmentRef",
    "evidenceRef",
    "outboxEventRef",
    "observedAt",
  ]);
  const result = {
    transcriptSegmentRef: canonicalRef(record.transcriptSegmentRef, ["TranscriptSegment"]),
    evidenceRef: canonicalRef(record.evidenceRef, ["FinalTranscriptEvidence"]),
    outboxEventRef: cloneJson(record.outboxEventRef) as OpaqueCanonicalRef,
    observedAt: canonicalTime(record.observedAt),
  };
  stableKey(result.outboxEventRef);
  return Object.freeze(result);
}

export function createFinalTranscriptEvidenceService(
  repository: RealtimeAuthorityRepository,
): FinalTranscriptEvidenceService {
  if (typeof repository !== "object" || repository === null ||
      typeof repository.transaction !== "function") {
    fail("FINAL_TRANSCRIPT_CONFIGURATION_INVALID");
  }
  return Object.freeze({
    async finalize(rawInput: FinalTranscriptEvidenceInput): Promise<FinalTranscriptEvidenceResult> {
      const input = normalizeInput(rawInput);
      const fingerprintPayload = Object.freeze({
        domain: "paios.realtime.final-transcript-evidence.request.v1",
        ...input,
      });
      const fingerprint = canonicalJson(fingerprintPayload);
      return repository.transaction(OPERATION, async (transaction) => {
        const prior = await transaction.readIdempotency(OPERATION, input.idempotencyKey);
        if (prior !== undefined) {
          if (prior.requestFingerprint !== fingerprint) fail("FINAL_TRANSCRIPT_IDEMPOTENCY_CONFLICT");
          return replayResult(prior.result);
        }
        const session = await transaction.readSession(input.realtimeSessionRef);
        if (session === undefined || !sessionMatches(session, input)) {
          fail("FINAL_TRANSCRIPT_SESSION_BINDING_INVALID");
        }
        const lease = await transaction.readLease(session.activeDeviceLeaseRef);
        if (lease === undefined || lease.state !== "active" || lease.userId !== input.userId ||
            lease.deviceId !== input.deviceId || lease.continuityId !== input.continuityId ||
            lease.purpose !== input.purpose || Date.parse(input.observedAt) > Date.parse(lease.expiresAt)) {
          fail("FINAL_TRANSCRIPT_LEASE_BINDING_INVALID");
        }

        const segmentPayload = Object.freeze({
          schema: "paios.realtime.transcript-segment.v1",
          transcriptState: "final",
          userId: input.userId,
          deviceId: input.deviceId,
          realtimeSessionRef: input.realtimeSessionRef,
          continuityId: input.continuityId,
          purpose: input.purpose,
          text: input.text,
          language: input.language,
          sourceMediaRef: input.sourceMediaRef,
          observedAt: input.observedAt,
          ...(input.correction === undefined ? {} : {
            correction: Object.freeze({
              previousTranscriptSegmentRef: input.correction.previousTranscriptSegmentRef,
              correctionReason: input.correction.correctionReason,
            }),
          }),
        });
        const transcriptSegmentRef = makeRef(
          "TranscriptSegment",
          input.observedAt,
          fingerprint,
          segmentPayload,
        );
        const evidencePayload = Object.freeze({
          schema: "paios.realtime.final-transcript-evidence.v1",
          transcriptSegmentRef,
          userId: input.userId,
          deviceId: input.deviceId,
          realtimeSessionRef: input.realtimeSessionRef,
          continuityId: input.continuityId,
          purpose: input.purpose,
          sourceMediaRef: input.sourceMediaRef,
          observedAt: input.observedAt,
          ...(input.correction === undefined ? {} : {
            supersedes: Object.freeze({
              previousTranscriptSegmentRef: input.correction.previousTranscriptSegmentRef,
              previousFinalEvidenceRef: input.correction.previousFinalEvidenceRef,
              correctionReason: input.correction.correctionReason,
            }),
          }),
        });
        const evidenceRef = makeRef(
          "FinalTranscriptEvidence",
          input.observedAt,
          fingerprint,
          evidencePayload,
        );
        const outboxEventRef = await transaction.appendOutbox({
          eventType: EVENT_TYPE,
          aggregateRef: evidenceRef as unknown as OpaqueCanonicalRef,
          idempotencyKey: input.idempotencyKey,
          occurredAt: input.observedAt,
          payload: Object.freeze({ segment: segmentPayload, evidence: evidencePayload, evidenceRef }),
        });
        const result = Object.freeze({
          transcriptSegmentRef,
          evidenceRef,
          outboxEventRef: cloneJson(outboxEventRef) as OpaqueCanonicalRef,
          observedAt: input.observedAt,
        });
        await transaction.writeIdempotency({
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          operation: OPERATION,
          result,
        });
        return result;
      });
    },
  });
}
