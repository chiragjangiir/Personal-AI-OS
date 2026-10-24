import { createHash } from "node:crypto";

import type { ActivityAcceptancePort } from "../../realtime-core/src/ports.ts";
import {
  type AcceptedUserActivity,
  type CanonicalTimestamp,
  type OpaqueOwnerValue,
  type VerifiedActivityAcceptance,
} from "../../realtime-core/src/types.ts";

/** The only projection shape admitted by the production T04 reader seam. */
export const ACTIVITY_AUTHORITY_PROJECTION_KIND =
  "t04.activity_authority_projection" as const;

/** Closed evidence kinds that can carry authority for an accepted activity. */
export const ACTIVITY_AUTHORITY_EVIDENCE_KINDS = Object.freeze([
  "Observation",
  "ContextAssertion",
  "FinalTranscriptEvidence",
] as const);

export type ActivityAuthorityEvidenceKind =
  (typeof ACTIVITY_AUTHORITY_EVIDENCE_KINDS)[number];

/**
 * A reader is an injected Owner projection boundary.  `environment` is
 * deliberately explicit: a fake must say `non-production` and is rejected by
 * the production verifier.  There is no in-memory or local fallback reader.
 */
export interface ActivityAuthorityReader {
  readonly environment?: "production" | "non-production";
  readonly readCurrent: (
    activity: AcceptedUserActivity,
  ) => unknown | PromiseLike<unknown>;
}

export interface ActivityAcceptanceVerifierOptions {
  /** The exact purpose configured by the caller; omission fails closed. */
  readonly purpose?: string;
  /** Required production Owner projection reader; omission fails closed. */
  readonly authorityReader?: ActivityAuthorityReader;
}

export type ActivityAcceptanceRejectionCode =
  | "ACTIVITY_ACCEPTANCE_READER_REQUIRED"
  | "ACTIVITY_ACCEPTANCE_READER_ENVIRONMENT_REQUIRED"
  | "ACTIVITY_ACCEPTANCE_READER_NON_PRODUCTION"
  | "ACTIVITY_ACCEPTANCE_READER_METHOD_REQUIRED"
  | "ACTIVITY_ACCEPTANCE_READER_FAILURE"
  | "ACTIVITY_ACCEPTANCE_PURPOSE_REQUIRED"
  | "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY"
  | "ACTIVITY_ACCEPTANCE_SOURCE_KIND_REJECTED"
  | "ACTIVITY_ACCEPTANCE_NOT_ACCEPTED"
  | "ACTIVITY_ACCEPTANCE_INVALID_PROJECTION"
  | "ACTIVITY_ACCEPTANCE_PROJECTION_KIND_REJECTED"
  | "ACTIVITY_ACCEPTANCE_PROJECTION_NON_PRODUCTION"
  | "ACTIVITY_ACCEPTANCE_NON_USER_ORIGIN"
  | "ACTIVITY_ACCEPTANCE_DELETED"
  | "ACTIVITY_ACCEPTANCE_SUPPRESSED"
  | "ACTIVITY_ACCEPTANCE_STALE"
  | "ACTIVITY_ACCEPTANCE_CURRENTNESS_REJECTED"
  | "ACTIVITY_ACCEPTANCE_PURPOSE_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_BINDING_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_SESSION_TIME_INVALID"
  | "ACTIVITY_ACCEPTANCE_SESSION_TIME_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_REF_INVALID"
  | "ACTIVITY_ACCEPTANCE_REF_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_INVALID"
  | "ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_WATERMARK_INVALID"
  | "ACTIVITY_ACCEPTANCE_WATERMARK_NOT_CURRENT"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_INVALID"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_REQUIRED"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_KIND_REJECTED"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_BINDING_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_NON_USER_ORIGIN"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_DELETED"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_SUPPRESSED"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_STALE"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_CURRENTNESS_REJECTED"
  | "ACTIVITY_ACCEPTANCE_EVIDENCE_REF_INVALID"
  | "ACTIVITY_ACCEPTANCE_ATTACHMENT_AUTHORITY_FORBIDDEN"
  | "ACTIVITY_ACCEPTANCE_ATTACHMENT_BINDING_MISMATCH"
  | "ACTIVITY_ACCEPTANCE_ATTACHMENT_NOT_ACCEPTED"
  | "ACTIVITY_ACCEPTANCE_FINGERPRINT_INVALID"
  | "ACTIVITY_ACCEPTANCE_REPLAY_CONFLICT";

export class ActivityAcceptanceVerificationError extends Error {
  public readonly code: ActivityAcceptanceRejectionCode;
  public readonly reason: ActivityAcceptanceRejectionCode;

  public constructor(
    code: ActivityAcceptanceRejectionCode,
    message = code,
  ) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = "ActivityAcceptanceVerificationError";
    this.code = code;
    this.reason = code;
  }
}

const ACTIVITY_KEYS = Object.freeze([
  "activityId",
  "kind",
  "userId",
  "deviceId",
  "realtimeSessionRef",
  "continuityId",
  "occurredAt",
  "acceptanceRef",
  "accepted",
] as const);

const PROJECTION_KEYS = Object.freeze([
  "kind",
  "environment",
  "activityId",
  "origin",
  "userOriginated",
  "accepted",
  "current",
  "deleted",
  "suppressed",
  "stale",
  "purpose",
  "userId",
  "deviceId",
  "realtimeSessionRef",
  "continuityId",
  "sessionTime",
  "acceptanceRef",
  "authorityWatermark",
  "watermarkCurrent",
  "evidence",
] as const);

const AUTHORITY_EVIDENCE_KEYS = Object.freeze([
  "kind",
  "evidenceRef",
  "activityId",
  "userOriginated",
  "authority",
  "current",
  "deleted",
  "suppressed",
  "stale",
] as const);

const TOOL_ATTACHMENT_KEYS = Object.freeze([
  "kind",
  "attachmentRef",
  "attachmentActivityId",
  "explicitUserInitiated",
  "acceptedByT04",
  "authority",
] as const);

const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/u;
const CANONICAL_REF_KEYS = Object.freeze([
  "ref_type",
  "ref_id",
  "object_version",
  "canonical_payload_sha256",
] as const);
const CANONICAL_REF_TYPES = Object.freeze([
  "RealtimeSession",
  "Observation",
  "ContextAssertion",
  "FinalTranscriptEvidence",
  "ToolResultArtifact",
] as const);
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type SafeRecord = Readonly<Record<string, unknown>>;

type CanonicalRefSnapshot = Readonly<{
  readonly ref_type: string;
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}>;

type ValidatedActivity = {
  readonly activity: AcceptedUserActivity;
  readonly activityId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: CanonicalRefSnapshot;
  readonly continuityId: string;
  readonly occurredAt: CanonicalTimestamp;
  readonly acceptanceRef: CanonicalRefSnapshot;
};

type ValidatedAuthorityEvidence = Readonly<{
  readonly kind: ActivityAuthorityEvidenceKind;
  readonly evidenceRef: CanonicalRefSnapshot;
  readonly activityId: string;
  readonly userOriginated: true;
  readonly authority: true;
  readonly current: true;
  readonly deleted: false;
  readonly suppressed: false;
  readonly stale: false;
}>;

type ValidatedToolAttachment = Readonly<{
  readonly kind: "ToolResultArtifact";
  readonly attachmentRef: CanonicalRefSnapshot;
  readonly attachmentActivityId: string;
  readonly explicitUserInitiated: true;
  readonly acceptedByT04: true;
  readonly authority: false;
}>;

type ValidatedEvidence = ValidatedAuthorityEvidence | ValidatedToolAttachment;

type ValidatedProjection = Readonly<{
  readonly activityId: string;
  readonly purpose: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: CanonicalRefSnapshot;
  readonly continuityId: string;
  readonly sessionTime: CanonicalTimestamp;
  readonly acceptanceRef: CanonicalRefSnapshot;
  readonly authorityWatermark: OpaqueOwnerValue;
  readonly current: true;
  readonly watermarkCurrent: true;
  readonly evidence: readonly ValidatedEvidence[];
}>;

type ReplayEntry = Readonly<{
  readonly fingerprint: string;
  readonly result: VerifiedActivityAcceptance;
}>;

function reject(
  code: ActivityAcceptanceRejectionCode,
  message = code,
): never {
  throw new ActivityAcceptanceVerificationError(code, message);
}

function snapshotRecord(value: unknown): SafeRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const names = Object.getOwnPropertyNames(value);
    const enumerableNames = Object.keys(value);
    if (names.length !== enumerableNames.length ||
        names.some((name) => !enumerableNames.includes(name))) {
      return undefined;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || descriptor.enumerable !== true ||
          descriptor.get !== undefined || descriptor.set !== undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return undefined;
      }
      result[name] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function snapshotArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const names = Object.getOwnPropertyNames(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || lengthDescriptor.enumerable !== false ||
        lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined ||
        !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        names.length !== lengthDescriptor.value + 1 || !names.includes("length")) {
      return undefined;
    }
    const result: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const name = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || descriptor.enumerable !== true ||
          descriptor.get !== undefined || descriptor.set !== undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return undefined;
      }
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): SafeRecord | undefined {
  const record = snapshotRecord(value);
  if (record === undefined) return undefined;
  const actualKeys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length ||
      actualKeys.some((key, index) => key !== expected[index])) {
    return undefined;
  }
  return record;
}

function identifier(value: unknown, code: ActivityAcceptanceRejectionCode): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    reject(code);
  }
  return value;
}

function opaqueValue(
  value: unknown,
  code: ActivityAcceptanceRejectionCode,
): OpaqueOwnerValue {
  try {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      reject(code);
    }
    const snapshot = cloneSafeValue(value, new WeakSet<object>());
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      reject(code);
    }
    return snapshot as OpaqueOwnerValue;
  } catch {
    reject(code);
  }
}

function cloneSafeValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("UNSERIALIZABLE_NUMBER");
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error("UNSERIALIZABLE_VALUE");
  }
  if (ancestors.has(value)) throw new Error("CYCLIC_VALUE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const array = snapshotArray(value);
      if (array === undefined) throw new Error("UNSERIALIZABLE_ARRAY");
      return Object.freeze(array.map((item) => cloneSafeValue(item, ancestors)));
    }
    const record = snapshotRecord(value);
    if (record === undefined) throw new Error("UNSERIALIZABLE_RECORD");
    const result = Object.create(null) as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      result[name] = cloneSafeValue(record[name], ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Validate the closed T01 wire reference shape without publishing or issuing
 * a new canonical reference.  Numbers, aliases, and extra metadata never
 * cross the T04 authority boundary.
 */
function canonicalRefValue(
  value: unknown,
  expectedRefType: string | undefined,
  code: ActivityAcceptanceRejectionCode,
): CanonicalRefSnapshot {
  const record = exactRecord(value, CANONICAL_REF_KEYS);
  if (record === undefined || typeof record.ref_type !== "string" ||
      !(CANONICAL_REF_TYPES as readonly string[]).includes(record.ref_type) ||
      (expectedRefType !== undefined && record.ref_type !== expectedRefType) ||
      typeof record.ref_id !== "string" || !UUID_V7_PATTERN.test(record.ref_id) ||
      typeof record.object_version !== "string" ||
      !POSITIVE_DECIMAL_PATTERN.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" ||
      !SHA256_PATTERN.test(record.canonical_payload_sha256)) {
    reject(code);
  }
  return Object.freeze({
    ref_type: record.ref_type,
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

function timestamp(
  value: unknown,
  code: ActivityAcceptanceRejectionCode,
): CanonicalTimestamp {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    reject(code);
  }
  return value as CanonicalTimestamp;
}

/** Stable internal encoding; it is never published as a canonical authority ref. */
function stableEncode(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): string {
  if (value === null) return "null;";
  if (typeof value === "string") return `string:${value.length}:${value};`;
  if (typeof value === "boolean") return value ? "boolean:1;" : "boolean:0;";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("UNSERIALIZABLE_NUMBER");
    if (Object.is(value, -0)) return "number:-0;";
    return `number:${String(value)};`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error("UNSERIALIZABLE_VALUE");
  }
  if (ancestors.has(value)) throw new Error("CYCLIC_VALUE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const array = snapshotArray(value);
      if (array === undefined) throw new Error("UNSERIALIZABLE_ARRAY");
      return `array:${array.length}:[${array.map((item) => stableEncode(item, ancestors)).join("")}]`;
    }
    const record = snapshotRecord(value);
    if (record === undefined) throw new Error("UNSERIALIZABLE_RECORD");
    const fields = Object.keys(record).sort().map((name) =>
      `key:${name.length}:${name}=${stableEncode(record[name], ancestors)}`,
    );
    return `object:${fields.length}:{${fields.join("")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Internal replay key only; it is not returned or persisted as a canonical ref/hash. */
function internalFingerprint(value: unknown): string {
  return createHash("sha256").update(stableEncode(value), "utf8").digest("hex");
}

function sameOpaque(left: OpaqueOwnerValue, right: OpaqueOwnerValue): boolean {
  try {
    return stableEncode(left) === stableEncode(right);
  } catch {
    return false;
  }
}

function validateActivity(input: unknown): ValidatedActivity {
  const record = exactRecord(input, ACTIVITY_KEYS);
  if (record === undefined) reject("ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
  if (record.kind !== "accepted_user_activity") {
    reject("ACTIVITY_ACCEPTANCE_SOURCE_KIND_REJECTED");
  }
  if (record.accepted !== true) reject("ACTIVITY_ACCEPTANCE_NOT_ACCEPTED");

  const activityId = identifier(record.activityId, "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
  const userId = identifier(record.userId, "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
  const deviceId = identifier(record.deviceId, "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
  const continuityId = identifier(record.continuityId, "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
  const occurredAt = timestamp(record.occurredAt, "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
  const realtimeSessionRef = canonicalRefValue(
    record.realtimeSessionRef,
    "RealtimeSession",
    "ACTIVITY_ACCEPTANCE_REF_INVALID",
  );
  const acceptanceRef = canonicalRefValue(
    record.acceptanceRef,
    undefined,
    "ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_INVALID",
  );

  const activity = Object.freeze({
    activityId,
    kind: "accepted_user_activity" as const,
    userId,
    deviceId,
    realtimeSessionRef,
    continuityId,
    occurredAt,
    acceptanceRef,
    accepted: true as const,
  }) as AcceptedUserActivity;
  return Object.freeze({
    activity,
    activityId,
    userId,
    deviceId,
    realtimeSessionRef,
    continuityId,
    occurredAt,
    acceptanceRef,
  });
}

function validateEvidence(
  value: unknown,
  activityId: string,
): readonly ValidatedEvidence[] {
  const items = snapshotArray(value);
  if (items === undefined) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_INVALID");
  const result: ValidatedEvidence[] = [];
  let authorityCount = 0;

  for (const item of items) {
    const probe = snapshotRecord(item);
    if (probe === undefined || typeof probe.kind !== "string") {
      reject("ACTIVITY_ACCEPTANCE_EVIDENCE_INVALID");
    }
    if ((ACTIVITY_AUTHORITY_EVIDENCE_KINDS as readonly string[]).includes(probe.kind)) {
      const record = exactRecord(probe, AUTHORITY_EVIDENCE_KEYS);
      if (record === undefined) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_INVALID");
      if (record.activityId !== activityId) {
        reject("ACTIVITY_ACCEPTANCE_EVIDENCE_BINDING_MISMATCH");
      }
      if (record.userOriginated !== true) {
        reject("ACTIVITY_ACCEPTANCE_EVIDENCE_NON_USER_ORIGIN");
      }
      if (record.authority !== true) {
        reject("ACTIVITY_ACCEPTANCE_EVIDENCE_INVALID");
      }
      if (record.deleted !== false) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_DELETED");
      if (record.suppressed !== false) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_SUPPRESSED");
      if (record.stale !== false) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_STALE");
      if (record.current !== true) {
        reject("ACTIVITY_ACCEPTANCE_EVIDENCE_CURRENTNESS_REJECTED");
      }
      const evidenceRef = canonicalRefValue(
        record.evidenceRef,
        record.kind as string,
        "ACTIVITY_ACCEPTANCE_EVIDENCE_REF_INVALID",
      );
      result.push(Object.freeze({
        kind: record.kind as ActivityAuthorityEvidenceKind,
        evidenceRef,
        activityId,
        userOriginated: true as const,
        authority: true as const,
        current: true as const,
        deleted: false as const,
        suppressed: false as const,
        stale: false as const,
      }));
      authorityCount += 1;
      continue;
    }

    if (probe.kind === "ToolResultArtifact") {
      const record = exactRecord(probe, TOOL_ATTACHMENT_KEYS);
      if (record === undefined) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_INVALID");
      if (record.authority !== false) {
        reject("ACTIVITY_ACCEPTANCE_ATTACHMENT_AUTHORITY_FORBIDDEN");
      }
      if (record.attachmentActivityId !== activityId) {
        reject("ACTIVITY_ACCEPTANCE_ATTACHMENT_BINDING_MISMATCH");
      }
      if (record.explicitUserInitiated !== true || record.acceptedByT04 !== true) {
        reject("ACTIVITY_ACCEPTANCE_ATTACHMENT_NOT_ACCEPTED");
      }
      const attachmentRef = canonicalRefValue(
        record.attachmentRef,
        "ToolResultArtifact",
        "ACTIVITY_ACCEPTANCE_EVIDENCE_REF_INVALID",
      );
      result.push(Object.freeze({
        kind: "ToolResultArtifact" as const,
        attachmentRef,
        attachmentActivityId: activityId,
        explicitUserInitiated: true as const,
        acceptedByT04: true as const,
        authority: false as const,
      }));
      continue;
    }

    reject("ACTIVITY_ACCEPTANCE_EVIDENCE_KIND_REJECTED");
  }

  if (authorityCount === 0) reject("ACTIVITY_ACCEPTANCE_EVIDENCE_REQUIRED");
  return Object.freeze(result);
}

function validateProjection(
  input: unknown,
  activity: ValidatedActivity,
  expectedPurpose: string,
): ValidatedProjection {
  const record = exactRecord(input, PROJECTION_KEYS);
  if (record === undefined) reject("ACTIVITY_ACCEPTANCE_INVALID_PROJECTION");
  if (record.kind !== ACTIVITY_AUTHORITY_PROJECTION_KIND) {
    reject("ACTIVITY_ACCEPTANCE_PROJECTION_KIND_REJECTED");
  }
  if (record.environment !== "production") {
    reject("ACTIVITY_ACCEPTANCE_PROJECTION_NON_PRODUCTION");
  }
  if (record.origin !== "user" || record.userOriginated !== true) {
    reject("ACTIVITY_ACCEPTANCE_NON_USER_ORIGIN");
  }
  if (record.accepted !== true) reject("ACTIVITY_ACCEPTANCE_NOT_ACCEPTED");
  if (record.deleted !== false) reject("ACTIVITY_ACCEPTANCE_DELETED");
  if (record.suppressed !== false) reject("ACTIVITY_ACCEPTANCE_SUPPRESSED");
  if (record.stale !== false) reject("ACTIVITY_ACCEPTANCE_STALE");
  if (record.current !== true) {
    reject("ACTIVITY_ACCEPTANCE_CURRENTNESS_REJECTED");
  }
  if (typeof record.purpose !== "string" || record.purpose !== expectedPurpose) {
    reject("ACTIVITY_ACCEPTANCE_PURPOSE_MISMATCH");
  }
  if (record.activityId !== activity.activityId ||
      record.userId !== activity.userId || record.deviceId !== activity.deviceId ||
      record.continuityId !== activity.continuityId) {
    reject("ACTIVITY_ACCEPTANCE_BINDING_MISMATCH");
  }

  const realtimeSessionRef = canonicalRefValue(
    record.realtimeSessionRef,
    "RealtimeSession",
    "ACTIVITY_ACCEPTANCE_REF_INVALID",
  );
  if (!sameOpaque(realtimeSessionRef, activity.realtimeSessionRef)) {
    reject("ACTIVITY_ACCEPTANCE_REF_MISMATCH");
  }

  const sessionTime = timestamp(
    record.sessionTime,
    "ACTIVITY_ACCEPTANCE_SESSION_TIME_INVALID",
  );
  if (sessionTime !== activity.occurredAt) {
    reject("ACTIVITY_ACCEPTANCE_SESSION_TIME_MISMATCH");
  }

  const acceptanceRef = canonicalRefValue(
    record.acceptanceRef,
    undefined,
    "ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_INVALID",
  );
  if (!sameOpaque(acceptanceRef, activity.acceptanceRef)) {
    reject("ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_MISMATCH");
  }

  const authorityWatermark = opaqueValue(
    record.authorityWatermark,
    "ACTIVITY_ACCEPTANCE_WATERMARK_INVALID",
  );
  if (record.watermarkCurrent !== true) {
    reject("ACTIVITY_ACCEPTANCE_WATERMARK_NOT_CURRENT");
  }
  const evidence = validateEvidence(record.evidence, activity.activityId);
  const acceptanceEvidenceMatch = evidence.some((item) =>
    item.authority === true && sameOpaque(acceptanceRef, item.evidenceRef));
  if (!acceptanceEvidenceMatch) {
    reject("ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_MISMATCH");
  }
  return Object.freeze({
    activityId: activity.activityId,
    purpose: expectedPurpose,
    userId: activity.userId,
    deviceId: activity.deviceId,
    realtimeSessionRef,
    continuityId: activity.continuityId,
    sessionTime,
    acceptanceRef,
    authorityWatermark,
    current: true as const,
    watermarkCurrent: true as const,
    evidence,
  });
}

function fingerprint(
  activity: ValidatedActivity,
  projection: ValidatedProjection,
): string {
  try {
    const requestFingerprint = internalFingerprint({
      activity: activity.activity,
      purpose: projection.purpose,
      sessionTime: projection.sessionTime,
    });
    const evidenceKeys = projection.evidence.map((item) => stableEncode(item)).sort();
    const evidenceFingerprint = internalFingerprint(evidenceKeys);
    return internalFingerprint({
      requestFingerprint,
      evidenceFingerprint,
      authorityWatermark: projection.authorityWatermark,
      current: projection.current,
      watermarkCurrent: projection.watermarkCurrent,
    });
  } catch {
    reject("ACTIVITY_ACCEPTANCE_FINGERPRINT_INVALID");
  }
}

function asVerificationError(
  error: unknown,
  fallback: ActivityAcceptanceRejectionCode,
): ActivityAcceptanceVerificationError {
  if (error instanceof ActivityAcceptanceVerificationError) return error;
  return new ActivityAcceptanceVerificationError(fallback);
}

/**
 * T04's production-capable, storage-neutral verifier.  It consumes only an
 * injected current Owner projection and never records activity itself.
 */
export class ActivityAcceptanceVerifier implements ActivityAcceptancePort {
  private readonly configuredPurpose: unknown;
  private readonly authorityReader: unknown;
  private readonly replay = new Map<string, ReplayEntry>();

  public constructor(options: ActivityAcceptanceVerifierOptions = {}) {
    let purpose: unknown;
    let authorityReader: unknown;
    try {
      purpose = options?.purpose;
      authorityReader = options?.authorityReader;
    } catch {
      purpose = undefined;
      authorityReader = undefined;
    }
    this.configuredPurpose = purpose;
    this.authorityReader = authorityReader;
  }

  public async verify(activity: AcceptedUserActivity): Promise<VerifiedActivityAcceptance> {
    let validatedActivity: ValidatedActivity;
    try {
      validatedActivity = validateActivity(activity);
    } catch (error) {
      throw asVerificationError(error, "ACTIVITY_ACCEPTANCE_INVALID_ACTIVITY");
    }

    if (typeof this.configuredPurpose !== "string" ||
        this.configuredPurpose.trim().length === 0) {
      reject("ACTIVITY_ACCEPTANCE_PURPOSE_REQUIRED");
    }

    const reader = this.authorityReader;
    if (reader === undefined || reader === null || typeof reader !== "object") {
      reject("ACTIVITY_ACCEPTANCE_READER_REQUIRED");
    }
    let environment: unknown;
    let readCurrent: unknown;
    try {
      environment = (reader as { readonly environment?: unknown }).environment;
      readCurrent = (reader as { readonly readCurrent?: unknown }).readCurrent;
    } catch (error) {
      throw asVerificationError(error, "ACTIVITY_ACCEPTANCE_READER_FAILURE");
    }
    if (environment === undefined) {
      reject("ACTIVITY_ACCEPTANCE_READER_ENVIRONMENT_REQUIRED");
    }
    if (environment !== "production") {
      reject("ACTIVITY_ACCEPTANCE_READER_NON_PRODUCTION");
    }
    if (typeof readCurrent !== "function") {
      reject("ACTIVITY_ACCEPTANCE_READER_METHOD_REQUIRED");
    }

    let rawProjection: unknown;
    try {
      rawProjection = await Reflect.apply(
        readCurrent as (activity: AcceptedUserActivity) => unknown | PromiseLike<unknown>,
        reader,
        [validatedActivity.activity],
      );
    } catch (error) {
      throw asVerificationError(error, "ACTIVITY_ACCEPTANCE_READER_FAILURE");
    }

    let projection: ValidatedProjection;
    try {
      projection = validateProjection(
        rawProjection,
        validatedActivity,
        this.configuredPurpose,
      );
    } catch (error) {
      throw asVerificationError(error, "ACTIVITY_ACCEPTANCE_INVALID_PROJECTION");
    }

    const projectionFingerprint = fingerprint(validatedActivity, projection);
    const previous = this.replay.get(validatedActivity.activityId);
    if (previous !== undefined) {
      if (previous.fingerprint !== projectionFingerprint) {
        reject("ACTIVITY_ACCEPTANCE_REPLAY_CONFLICT");
      }
      return previous.result;
    }

    const result = Object.freeze({
      verified: true as const,
      acceptanceRef: validatedActivity.acceptanceRef,
      acceptedAt: validatedActivity.occurredAt,
      authorityWatermark: projection.authorityWatermark,
    });
    this.replay.set(validatedActivity.activityId, Object.freeze({
      fingerprint: projectionFingerprint,
      result,
    }));
    return result;
  }
}

export function createActivityAcceptanceVerifier(
  options: ActivityAcceptanceVerifierOptions = {},
): ActivityAcceptanceVerifier {
  return new ActivityAcceptanceVerifier(options);
}
