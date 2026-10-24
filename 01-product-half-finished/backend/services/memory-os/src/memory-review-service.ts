import { createHash } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  EVIDENCE_SOURCE_CLASSES,
  MEMORY_CANDIDATE_STATUSES,
  MEMORY_COMMAND_ERROR_CODES,
  MEMORY_KINDS,
  MEMORY_REVIEW_AUTHORIZATION_MODES,
  MEMORY_REVIEW_DECISIONS,
  MEMORY_REVIEW_RESOLUTIONS,
  stableSerializeMemoryReviewCommandIdentity,
  isCanonicalUtcInstant,
  type AuthorityWatermark,
  type MemoryCandidateRecord,
  type MemoryCandidateStatus,
  type MemoryCommandError,
  type MemoryCommandResult,
  type MemoryConflictBinding,
  type MemoryReviewAuthorization,
  type MemoryReviewDecision,
  type MemoryReviewCommandIdentity,
  type MemoryReviewReceipt,
  type MemoryReviewReplayRecord,
  type MemoryReviewResult,
  type MemoryReviewResolution,
  type MemoryReviewStateSnapshot,
  type MemoryVersionRecord,
  type ReadonlyJsonValue,
} from "./domain.ts";
import {
  ADMISSIBLE_EVIDENCE_REF_TYPES,
  ADMISSIBLE_USER_CORRECTION_REF_TYPES,
} from "./admission.ts";
import {
  resolveMemoryConflict,
  type MemoryConflictCandidate,
} from "./conflict-resolution.ts";
import type {
  MemoryCandidateReader,
  MemoryCommandRepository,
  MemoryCommandTransaction,
  MemoryReviewStateReader,
  MemoryReviewReceiptReader,
  MemoryCandidateReviewCommand,
  MemoryCanonicalIdentityProvider,
} from "./ports.ts";
import {
  assertProductionMemoryIssuerReceipt,
  candidateBindingSha256,
  issuerReceiptMatchesCandidate,
  type ProductionMemoryIssuerReceipt,
} from "./canonical-issuer.ts";
import type { AdmittedMemoryCandidateIntent } from "./admission.ts";

/** Input for one candidate review decision. Resolution is selected by T05. */
export interface MemoryReviewInput {
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly expectedCandidateStatus: MemoryCandidateStatus;
  readonly expectedUserId: string;
  readonly expectedSlot: string;
  readonly decision: MemoryReviewDecision;
  readonly idempotencyKey: string;
  readonly authorization: MemoryReviewAuthorization;
  /** Optional model-safe content to persist when a memory is accepted. */
  readonly resolvedContent?: string;
  /** Optional caller CAS expectation; the review-state reader remains authoritative. */
  readonly expectedCurrentRef?: CanonicalObjectVersionRef;
  /** Optional complete T05 receipt; production callers must provide it. */
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/** Production review input carries only a private-branded issuer receipt for
 * resolutions that create a durable version. Raw memory refs are forbidden. */
export interface ProductionMemoryReviewInput extends MemoryReviewInput {
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/** Naming aliases for callers that treat review as a command seam. */
export type ReviewCandidateInput = MemoryReviewInput;
export type MemoryReviewCommandInput = MemoryReviewInput;

type ReviewPlan = {
  readonly resolution: MemoryReviewResolution;
  readonly selectionBasis: Readonly<Record<string, unknown>>;
  readonly expectedCurrentRef?: CanonicalObjectVersionRef;
  readonly conflictBindingBasis?: {
    readonly currentRefs: readonly CanonicalObjectVersionRef[];
    readonly reasonCode: string;
    readonly authorityWatermark: AuthorityWatermark;
  };
  readonly current?: MemoryVersionRecord;
};

const MEMORY_REF_TYPE_BY_KIND: Readonly<Record<string, CanonicalObjectVersionRef["refType"]>> = {
  semantic_fact: "SemanticFact",
  episodic_memory: "EpisodicMemory",
  preference_memory: "PreferenceMemory",
  open_loop: "OpenLoop",
};

const MEMORY_REF_TYPES = new Set([
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
]);

const ALLOWED_CANDIDATE_KEYS = new Set([
  "candidateRef",
  "kind",
  "status",
  "proposalId",
  "slot",
  "value",
  "evidenceRefs",
  "sourceClass",
  "confidencePpm",
  "idempotencyKey",
  "current",
  "memoryKind",
  "userId",
  "purposeScopes",
  "sensitivity",
  "validity",
  "target",
  "correctionIntent",
  "reason",
  "conflict",
  "requiresReview",
  "conflictBinding",
  "linkedMemoryRef",
  "reviewedAt",
]);

const ALLOWED_RECORD_KEYS = new Set([
  "ref",
  "userId",
  "kind",
  "slot",
  "value",
  "resolvedContent",
  "status",
  "current",
  "sourceClass",
  "evidenceRefs",
  "confidencePpm",
  "allowedPurposeScopes",
  "sensitivity",
  "validity",
  "supersedes",
  "correctionIntent",
  "dreamAcceptedDelta",
  "deletedAt",
  "suppressedAt",
  "stale",
  "derivedRankScore",
  "createdAt",
  "updatedAt",
]);

const ALLOWED_RECEIPT_KEYS = new Set([
  "kind",
  "outcome",
  "idempotencyKey",
  "fingerprint",
  "candidateRef",
  "candidateStatus",
  "decision",
  "resolution",
  "createdMemoryRefs",
  "linkedMemoryRefs",
  "currentMemoryRefs",
  "supersededRefs",
  "conflictBinding",
  "authorityWatermark",
]);

const REQUIRED_COMMAND_IDENTITY_KEYS = new Set([
  "operation",
  "candidateRef",
  "candidatePayloadSha256",
  "expectedCandidateStatus",
  "expectedUserId",
  "expectedSlot",
  "decision",
  "resolution",
  "idempotencyKey",
  "requestFingerprint",
  "authorization",
  "selectionBasis",
]);
const OPTIONAL_COMMAND_IDENTITY_KEYS = new Set([
  "callerExpectedCurrentRef",
  "expectedCurrentRef",
  "reviewStateAuthorityWatermark",
  "conflictBinding",
  "resolvedContent",
  "canonicalMemoryRef",
]);

const OWNER_STATE_INVALID: MemoryCommandError["code"] = "OWNER_STATE_INVALID";
const INVALID_OWNER_RECEIPT = Symbol("invalid-owner-receipt");
const KNOWN_ERROR_CODES = new Set<string>([
  ...MEMORY_COMMAND_ERROR_CODES,
  OWNER_STATE_INVALID,
]);

const REVIEW_INPUT_REQUIRED_KEYS = [
  "candidateRef",
  "expectedCandidateStatus",
  "expectedUserId",
  "expectedSlot",
  "decision",
  "idempotencyKey",
  "authorization",
] as const;
const REVIEW_INPUT_OPTIONAL_KEYS = ["resolvedContent", "expectedCurrentRef", "issuerReceipt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(
  value: unknown,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  const allowed = new Set([...required, ...optional]);
  return [...required].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Stable JSON used for command identity; undefined, non-finite, and cycles fail. */
function stableSerialize(value: unknown, ancestors: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite values are not stable");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("undefined and non-JSON values are not stable");
  }
  if (ancestors.has(value)) throw new TypeError("cyclic values are not stable");
  if (Array.isArray(value)) {
    ancestors.add(value);
    const result = `[${value.map((item) => stableSerialize(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("only plain JSON objects are stable");
  }
  ancestors.add(value);
  const result = `{${Object.getOwnPropertyNames(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], ancestors)}`)
    .join(",")}}`;
  ancestors.delete(value);
  return result;
}

function stableValue(value: unknown): boolean {
  try {
    stableSerialize(value);
    return true;
  } catch {
    return false;
  }
}

/** Deeply clones and freezes an already-validated JSON-compatible value. */
function stableClone<T>(value: T, ancestors: WeakSet<object> = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("unstable value");
    }
    return value;
  }
  if (ancestors.has(value as object)) throw new TypeError("cyclic value");
  ancestors.add(value as object);
  let cloned: unknown;
  if (Array.isArray(value)) {
    cloned = Object.freeze(value.map((item) => stableClone(item, ancestors)));
  } else if (isPlainRecord(value)) {
    const object: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      object[key] = stableClone(value[key], ancestors);
    }
    cloned = Object.freeze(object);
  } else {
    throw new TypeError("only plain JSON values can be cloned");
  }
  ancestors.delete(value as object);
  return cloned as T;
}

function stableWatermark(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (!stableValue(value)) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function stableEqual(left: unknown, right: unknown): boolean {
  try {
    return stableSerialize(left) === stableSerialize(right);
  } catch {
    return false;
  }
}

function exactRef(value: unknown, expectedType?: CanonicalObjectVersionRef["refType"]): value is CanonicalObjectVersionRef {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value).sort();
  if (keys.join("|") !== "canonicalPayloadSha256|objectVersion|refId|refType") return false;
  try {
    const ref = assertCanonicalObjectVersionRef(value);
    return expectedType === undefined || ref.refType === expectedType;
  } catch {
    return false;
  }
}

function cloneRef(value: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function cloneRefs(values: readonly CanonicalObjectVersionRef[]): readonly CanonicalObjectVersionRef[] {
  return Object.freeze(values.map(cloneRef));
}

function uniqueRefs(value: unknown, options: { readonly nonEmpty: boolean; readonly expectedType?: CanonicalObjectVersionRef["refType"] } = { nonEmpty: false }): value is readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)) return false;
  try {
    const refs = value.map((item) => {
      if (!exactRef(item, options.expectedType)) throw new TypeError("invalid ref");
      return item;
    });
    const keys = refs.map(canonicalRefKey);
    return new Set(keys).size === keys.length;
  } catch {
    return false;
  }
}

function refsContain(refs: readonly CanonicalObjectVersionRef[], target: CanonicalObjectVersionRef): boolean {
  const key = canonicalRefKey(target);
  return refs.some((ref) => canonicalRefKey(ref) === key);
}

function memoryRef(value: unknown, kind?: string): value is CanonicalObjectVersionRef {
  if (!exactRef(value) || !MEMORY_REF_TYPES.has(value.refType)) return false;
  return kind === undefined || value.refType === MEMORY_REF_TYPE_BY_KIND[kind];
}

function validateSensitivity(value: unknown): boolean {
  return hasExactKeys(value, new Set(["classification", "userConfirmed"])) &&
    (value.classification === "normal" || value.classification === "sensitive") &&
    typeof value.userConfirmed === "boolean";
}

function validateValidity(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.getOwnPropertyNames(value);
  if (keys.some((key) => !["validFrom", "validTo", "observedAt"].includes(key))) return false;
  for (const key of keys) {
    if (!isCanonicalUtcInstant(value[key])) return false;
  }
  if (value.validFrom !== undefined && value.validTo !== undefined &&
      Date.parse(value.validFrom as string) > Date.parse(value.validTo as string)) return false;
  return true;
}

function validateCorrectionIntent(value: unknown): boolean {
  if (!hasExactKeys(value, new Set(["kind", "target"]), new Set(["reason", "evidenceRefs"]))) return false;
  if (value.kind !== "correct" || !memoryRef(value.target)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "reason") && !stableValue(value.reason)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "evidenceRefs") &&
      !uniqueRefs(value.evidenceRefs, { nonEmpty: true })) return false;
  return true;
}

function validateConflictBinding(value: unknown): value is MemoryConflictBinding {
  if (!hasExactKeys(
    value,
    new Set(["conflictId", "candidateRefs", "currentRefs", "reasonCode", "authorityWatermark"]),
  )) return false;
  return isNonEmptyString(value.conflictId) &&
    isNonEmptyString(value.reasonCode) &&
    stableWatermark(value.authorityWatermark) &&
    uniqueRefs(value.candidateRefs, { nonEmpty: true, expectedType: "MemoryCandidate" }) &&
    uniqueRefs(value.currentRefs, { nonEmpty: false }) &&
    value.currentRefs.every((ref) => memoryRef(ref));
}

function validateCandidateRecord(
  value: unknown,
  expectedRef: CanonicalObjectVersionRef,
  enforceRequiresReview: boolean,
): value is MemoryCandidateRecord {
  if (!hasExactKeys(value, new Set([
    "candidateRef", "kind", "status", "proposalId", "slot", "value", "evidenceRefs",
    "sourceClass", "confidencePpm", "idempotencyKey", "current", "memoryKind", "userId",
    "purposeScopes", "sensitivity", "validity", "requiresReview",
  ]), new Set([
    "target", "correctionIntent", "reason", "conflict", "conflictBinding", "linkedMemoryRef", "reviewedAt",
  ]))) return false;
  if (!exactRef(value.candidateRef, "MemoryCandidate") || canonicalRefKey(value.candidateRef) !== canonicalRefKey(expectedRef)) return false;
  if (value.kind !== "create" && value.kind !== "correct") return false;
  if (!(MEMORY_CANDIDATE_STATUSES as readonly string[]).includes(value.status as string)) return false;
  if (!isNonEmptyString(value.proposalId) || !isNonEmptyString(value.slot) || !isNonEmptyString(value.userId) ||
      !isNonEmptyString(value.idempotencyKey) || value.current !== false || typeof value.requiresReview !== "boolean") return false;
  const requiresReview = value.status === "candidate" || value.status === "quarantined";
  if (enforceRequiresReview && value.requiresReview !== requiresReview) return false;
  if (!(MEMORY_KINDS as readonly string[]).includes(value.memoryKind as string) ||
      !(EVIDENCE_SOURCE_CLASSES as readonly string[]).includes(value.sourceClass as string) ||
      !Number.isInteger(value.confidencePpm) || (value.confidencePpm as number) < 0 || (value.confidencePpm as number) > 1_000_000 ||
      !stableValue(value.value)) return false;
  if (!uniqueRefs(value.evidenceRefs, { nonEmpty: true })) return false;
  const evidence = value.evidenceRefs as readonly CanonicalObjectVersionRef[];
  const admissible = new Set<string>([
    ...ADMISSIBLE_EVIDENCE_REF_TYPES,
    ...(value.sourceClass === "explicit_user_correction" ? ADMISSIBLE_USER_CORRECTION_REF_TYPES : []),
  ]);
  if (evidence.some((ref) => !admissible.has(ref.refType))) return false;
  if (!Array.isArray(value.purposeScopes) || value.purposeScopes.length === 0 ||
      !value.purposeScopes.every(isNonEmptyString) ||
      new Set(value.purposeScopes.map((scope) => (scope as string).trim())).size !== value.purposeScopes.length) return false;
  if (!validateSensitivity(value.sensitivity) || !validateValidity(value.validity)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "target") && !memoryRef(value.target)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "target") &&
      !refsContain(evidence, value.target as CanonicalObjectVersionRef)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "reason") && !stableValue(value.reason)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "conflict") && !stableValue(value.conflict)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "linkedMemoryRef") && !memoryRef(value.linkedMemoryRef, value.memoryKind as string)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "reviewedAt") && !isCanonicalUtcInstant(value.reviewedAt)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "conflictBinding")) {
    if (!validateConflictBinding(value.conflictBinding) ||
        !refsContain(value.conflictBinding.candidateRefs, value.candidateRef)) return false;
  }
  if (value.kind === "correct") {
    const correction = value.correctionIntent;
    if (value.sourceClass !== "explicit_user_correction" ||
        !Object.prototype.hasOwnProperty.call(value, "target") ||
        !validateCorrectionIntent(correction) ||
        !isRecord(correction) ||
        !exactRef(correction.target) ||
        canonicalRefKey(value.target) !== canonicalRefKey(correction.target) ||
        !refsContain(evidence, correction.target)) return false;
  } else if (Object.prototype.hasOwnProperty.call(value, "correctionIntent")) {
    return false;
  }
  return true;
}

function validateMemoryRecord(value: unknown): value is MemoryVersionRecord {
  if (!hasExactKeys(value, new Set([
    "ref", "userId", "kind", "slot", "value", "resolvedContent", "status", "current",
    "sourceClass", "evidenceRefs", "confidencePpm", "allowedPurposeScopes", "sensitivity", "validity",
  ]), new Set([
    "supersedes", "correctionIntent", "dreamAcceptedDelta", "deletedAt", "suppressedAt", "stale",
    "derivedRankScore", "createdAt", "updatedAt",
  ]))) return false;
  if (!memoryRef(value.ref, value.kind as string) || !isNonEmptyString(value.userId) || !isNonEmptyString(value.slot) ||
      !isNonEmptyString(value.resolvedContent) || !stableValue(value.value) ||
      !(MEMORY_KINDS as readonly string[]).includes(value.kind as string) ||
      !["current", "superseded", "disputed", "suppressed", "deleted"].includes(value.status as string) ||
      typeof value.current !== "boolean" || !(EVIDENCE_SOURCE_CLASSES as readonly string[]).includes(value.sourceClass as string) ||
      !Number.isInteger(value.confidencePpm) || (value.confidencePpm as number) < 0 || (value.confidencePpm as number) > 1_000_000 ||
      !uniqueRefs(value.evidenceRefs, { nonEmpty: true }) || !Array.isArray(value.allowedPurposeScopes) ||
      value.allowedPurposeScopes.length === 0 || !value.allowedPurposeScopes.every(isNonEmptyString) ||
      new Set(value.allowedPurposeScopes.map((scope) => (scope as string).trim())).size !== value.allowedPurposeScopes.length ||
      !validateSensitivity(value.sensitivity) || !validateValidity(value.validity)) return false;
  for (const key of ["deletedAt", "suppressedAt", "createdAt", "updatedAt"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !isCanonicalUtcInstant(value[key])) return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, "stale") && typeof value.stale !== "boolean") return false;
  if (Object.prototype.hasOwnProperty.call(value, "derivedRankScore") &&
      (typeof value.derivedRankScore !== "number" || !Number.isFinite(value.derivedRankScore))) return false;
  if (Object.prototype.hasOwnProperty.call(value, "supersedes") && !memoryRef(value.supersedes)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "correctionIntent") && !validateCorrectionIntent(value.correctionIntent)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "dreamAcceptedDelta") && !stableValue(value.dreamAcceptedDelta)) return false;
  return true;
}

function validateAuthorization(value: unknown): value is MemoryReviewAuthorization {
  if (!hasExactKeys(value, new Set(["mode", "evidenceRefs", "authorityWatermark"]))) return false;
  return (MEMORY_REVIEW_AUTHORIZATION_MODES as readonly string[]).includes(value.mode as string) &&
    uniqueRefs(value.evidenceRefs, { nonEmpty: true }) && stableWatermark(value.authorityWatermark);
}

function validateInput(value: unknown): value is MemoryReviewInput {
  if (!hasExactKeys(value, new Set(REVIEW_INPUT_REQUIRED_KEYS), new Set(REVIEW_INPUT_OPTIONAL_KEYS))) return false;
  return exactRef(value.candidateRef, "MemoryCandidate") &&
    value.expectedCandidateStatus === "candidate" &&
    isNonEmptyString(value.expectedUserId) && isNonEmptyString(value.expectedSlot) &&
    (MEMORY_REVIEW_DECISIONS as readonly string[]).includes(value.decision as string) &&
    isNonEmptyString(value.idempotencyKey) && validateAuthorization(value.authorization) &&
    (!Object.prototype.hasOwnProperty.call(value, "resolvedContent") || typeof value.resolvedContent === "string") &&
    (!Object.prototype.hasOwnProperty.call(value, "expectedCurrentRef") || exactRef(value.expectedCurrentRef)) &&
    (!Object.prototype.hasOwnProperty.call(value, "issuerReceipt") ||
      (isRecord(value.issuerReceipt) && "kind" in value.issuerReceipt));
}

function cloneReviewInput(input: MemoryReviewInput): MemoryReviewInput {
  return Object.freeze({
    candidateRef: cloneRef(input.candidateRef),
    expectedCandidateStatus: input.expectedCandidateStatus,
    expectedUserId: input.expectedUserId,
    expectedSlot: input.expectedSlot,
    decision: input.decision,
    idempotencyKey: input.idempotencyKey,
    authorization: Object.freeze({
      mode: input.authorization.mode,
      evidenceRefs: cloneRefs(input.authorization.evidenceRefs),
      authorityWatermark: stableClone(input.authorization.authorityWatermark),
    }),
    ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
    ...(input.expectedCurrentRef === undefined ? {} : { expectedCurrentRef: cloneRef(input.expectedCurrentRef) }),
    ...(input.issuerReceipt === undefined ? {} : { issuerReceipt: input.issuerReceipt }),
  });
}

function cloneCandidateRecord(value: MemoryCandidateRecord): MemoryCandidateRecord {
  return stableClone(value);
}

function cloneReviewStateSnapshot(value: MemoryReviewStateSnapshot): MemoryReviewStateSnapshot {
  return stableClone(value);
}

function immutableCandidatePayload(candidate: MemoryCandidateRecord): Readonly<Record<string, unknown>> {
  return {
    candidateRef: canonicalRefKey(candidate.candidateRef),
    kind: candidate.kind,
    proposalId: candidate.proposalId,
    slot: candidate.slot,
    value: candidate.value,
    evidenceRefs: candidate.evidenceRefs.map(canonicalRefKey),
    sourceClass: candidate.sourceClass,
    confidencePpm: candidate.confidencePpm,
    idempotencyKey: candidate.idempotencyKey,
    memoryKind: candidate.memoryKind,
    userId: candidate.userId,
    purposeScopes: candidate.purposeScopes,
    sensitivity: candidate.sensitivity,
    validity: candidate.validity,
    ...(candidate.target === undefined ? {} : { target: canonicalRefKey(candidate.target) }),
    ...(candidate.correctionIntent === undefined ? {} : {
      correctionIntent: {
        kind: candidate.correctionIntent.kind,
        target: canonicalRefKey(candidate.correctionIntent.target),
        ...(candidate.correctionIntent.reason === undefined ? {} : { reason: candidate.correctionIntent.reason }),
        ...(candidate.correctionIntent.evidenceRefs === undefined ? {} : {
          evidenceRefs: candidate.correctionIntent.evidenceRefs.map(canonicalRefKey),
        }),
      },
    }),
    ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    ...(candidate.conflict === undefined ? {} : { conflict: candidate.conflict }),
  };
}

function currentPayload(record: MemoryVersionRecord | undefined): unknown {
  if (record === undefined) return { present: false };
  return {
    present: true,
    ref: canonicalRefKey(record.ref),
    userId: record.userId,
    kind: record.kind,
    slot: record.slot,
    value: record.value,
    resolvedContent: record.resolvedContent,
    status: record.status,
    current: record.current,
    sourceClass: record.sourceClass,
    evidenceRefs: record.evidenceRefs.map(canonicalRefKey),
    confidencePpm: record.confidencePpm,
    allowedPurposeScopes: record.allowedPurposeScopes,
    sensitivity: record.sensitivity,
    validity: record.validity,
    ...(record.supersedes === undefined ? {} : { supersedes: canonicalRefKey(record.supersedes) }),
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    ...(record.suppressedAt === undefined ? {} : { suppressedAt: record.suppressedAt }),
    ...(record.stale === undefined ? {} : { stale: record.stale }),
  };
}

function digestStable(value: unknown): Sha256 {
  return assertSha256(createHash("sha256").update(stableSerialize(value), "utf8").digest("hex"));
}

function digestSerialized(value: string): Sha256 {
  return assertSha256(createHash("sha256").update(value, "utf8").digest("hex"));
}

function requestFingerprint(input: MemoryReviewInput, candidate: MemoryCandidateRecord): Sha256 {
  return digestStable({
    operation: "memory_review",
    candidate: immutableCandidatePayload(candidate),
    expectedCandidateStatus: input.expectedCandidateStatus,
    expectedUserId: input.expectedUserId,
    expectedSlot: input.expectedSlot,
    decision: input.decision,
    idempotencyKey: input.idempotencyKey,
    authorization: {
      mode: input.authorization.mode,
      evidenceRefs: input.authorization.evidenceRefs.map(canonicalRefKey),
      authorityWatermark: input.authorization.authorityWatermark,
    },
    expectedCurrentRef: input.expectedCurrentRef === undefined ? { present: false } : {
      present: true,
      ref: canonicalRefKey(input.expectedCurrentRef),
    },
    resolvedContent: input.resolvedContent === undefined
      ? { present: false }
      : { present: true, value: input.resolvedContent },
    issuerReceipt: input.issuerReceipt === undefined
      ? { present: false }
      : receiptBindingFingerprint(input.issuerReceipt),
  });
}

function receiptBindingFingerprint(receipt: ProductionMemoryIssuerReceipt): Readonly<Record<string, unknown>> {
  const value = assertProductionMemoryIssuerReceipt(receipt);
  const candidateReceipt = value.candidateReceipt;
  return {
    present: true,
    operation: value.operation,
    candidateRef: value.candidateRef === undefined ? { present: false } : canonicalRefKey(value.candidateRef),
    memoryRef: value.memoryRef === undefined ? { present: false } : canonicalRefKey(value.memoryRef),
    previousRef: value.previousRef === undefined ? { present: false } : canonicalRefKey(value.previousRef),
    candidateBindingSha256: value.candidateBindingSha256,
    canonicalPayloadSha256: value.canonicalPayloadSha256,
    candidateReceipt: candidateReceipt === undefined ? { present: false } : {
      operation: candidateReceipt.operation,
      candidateRef: candidateReceipt.candidateRef === undefined ? { present: false } : canonicalRefKey(candidateReceipt.candidateRef),
      previousRef: candidateReceipt.previousRef === undefined ? { present: false } : canonicalRefKey(candidateReceipt.previousRef),
      canonicalPayloadSha256: candidateReceipt.canonicalPayloadSha256,
    },
  };
}

function receiptMatchesReviewPlan(
  receipt: ProductionMemoryIssuerReceipt,
  candidate: MemoryCandidateRecord,
  resolution: MemoryReviewResolution,
  expectedCurrentRef: CanonicalObjectVersionRef | undefined,
): boolean {
  let value: ProductionMemoryIssuerReceipt;
  try {
    value = assertProductionMemoryIssuerReceipt(receipt);
  } catch {
    return false;
  }
  const directTerminalSuccessor =
    (resolution === "reject" || resolution === "quarantine") && value.operation === "candidate_successor";
  const candidateReceipt = directTerminalSuccessor ? value : value.candidateReceipt;
  if (candidateReceipt === undefined || candidateReceipt.operation !== "candidate_successor" ||
      candidateReceipt.previousRef === undefined ||
      canonicalRefKey(candidateReceipt.previousRef) !== canonicalRefKey(candidate.candidateRef) ||
      value.candidateRef === undefined || value.candidateRef.refId !== candidate.candidateRef.refId ||
      value.candidateBindingSha256 !== candidateBindingForRecord(candidate)) {
    return false;
  }
  const candidateStatus = candidateReceipt.payload.status;
  if (candidateReceipt.payload.requires_review !==
      (candidateStatus === "candidate" || candidateStatus === "quarantined")) return false;
  if (resolution === "reject" && (value.operation !== "candidate_successor" || candidateStatus !== "rejected")) return false;
  if (resolution === "quarantine" && (value.operation !== "candidate_successor" || candidateStatus !== "quarantined")) return false;
  if (resolution === "requires_review" && (value.operation !== "candidate_successor" || candidateStatus !== "candidate")) return false;
  if (resolution === "accept_existing" && (value.operation !== "candidate_successor" || candidateStatus !== "accepted")) return false;
  if (resolution === "accept_new" && (value.operation !== "memory_create" || value.memoryRef === undefined || candidateStatus !== "accepted")) return false;
  if (resolution === "accept_superseding" &&
      (value.operation !== "memory_successor" || value.memoryRef === undefined || value.previousRef === undefined ||
       expectedCurrentRef === undefined || canonicalRefKey(value.previousRef) !== canonicalRefKey(expectedCurrentRef) ||
       candidateStatus !== "accepted")) return false;
  return true;
}

/**
 * The general issuer helper deliberately excludes candidate-successor
 * receipts. Review rejection/quarantine is the one closed production seam
 * that must consume that receipt: the successor is the authoritative terminal
 * candidate state and never creates a durable memory. The complete plan check
 * below remains responsible for exact operation/status/previous-ref binding.
 */
function reviewIssuerReceiptMatchesCandidate(
  receipt: ProductionMemoryIssuerReceipt,
  candidate: MemoryCandidateRecord,
  decision: MemoryReviewDecision,
): boolean {
  if (issuerReceiptMatchesCandidate(receipt, candidate as unknown as AdmittedMemoryCandidateIntent)) return true;
  if (decision !== "reject" && decision !== "quarantine") return false;
  try {
    const value = assertProductionMemoryIssuerReceipt(receipt);
    return value.operation === "candidate_successor" && value.candidateRef !== undefined &&
      value.previousRef !== undefined && value.candidateReceipt === undefined &&
      value.candidateRef.refId === candidate.candidateRef.refId &&
      canonicalRefKey(value.previousRef) === canonicalRefKey(candidate.candidateRef) &&
      value.candidateBindingSha256 === candidateBindingForRecord(candidate) &&
      value.payload.status === (decision === "reject" ? "rejected" : "quarantined");
  } catch {
    return false;
  }
}

function candidateBindingForRecord(candidate: MemoryCandidateRecord): Sha256 {
  return candidateBindingSha256(candidate as unknown as AdmittedMemoryCandidateIntent);
}

function createReviewCommandIdentity(
  input: MemoryReviewInput,
  candidate: MemoryCandidateRecord,
  plan: ReviewPlan,
  reviewStateWatermark: AuthorityWatermark | undefined,
  conflictBinding: MemoryConflictBinding | undefined,
  requestFingerprintValue: Sha256,
): MemoryReviewCommandIdentity {
  const identity: MemoryReviewCommandIdentity = {
    operation: "memory_review",
    candidateRef: cloneRef(candidate.candidateRef),
    candidatePayloadSha256: digestStable(immutableCandidatePayload(candidate)),
    expectedCandidateStatus: input.expectedCandidateStatus,
    expectedUserId: input.expectedUserId,
    expectedSlot: input.expectedSlot,
    decision: input.decision,
    resolution: plan.resolution,
    requestFingerprint: requestFingerprintValue,
    idempotencyKey: input.idempotencyKey,
    authorization: {
      mode: input.authorization.mode,
      evidenceRefs: cloneRefs(input.authorization.evidenceRefs),
      authorityWatermark: stableClone(input.authorization.authorityWatermark),
    },
    ...(input.expectedCurrentRef === undefined ? {} : { callerExpectedCurrentRef: cloneRef(input.expectedCurrentRef) }),
    ...(plan.expectedCurrentRef === undefined ? {} : { expectedCurrentRef: cloneRef(plan.expectedCurrentRef) }),
    ...(reviewStateWatermark === undefined ? {} : { reviewStateAuthorityWatermark: stableClone(reviewStateWatermark) }),
    selectionBasis: stableClone(plan.selectionBasis) as ReadonlyJsonValue,
    ...(conflictBinding === undefined ? {} : { conflictBinding: cloneConflictBinding(conflictBinding) }),
    ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
  };
  return Object.freeze(identity);
}

function fingerprintReviewCommandIdentity(identity: MemoryReviewCommandIdentity): Sha256 {
  return digestSerialized(stableSerializeMemoryReviewCommandIdentity(identity));
}

/** Repository replay may bind the owner-issued memory ref in storage; the
 * public receipt fingerprint remains T05's command-identity fingerprint. */
function fingerprintReviewReceiptIdentity(
  identity: MemoryReviewCommandIdentity & { readonly canonicalMemoryRef?: CanonicalObjectVersionRef },
): Sha256 {
  const { canonicalMemoryRef: _canonicalMemoryRef, ...receiptIdentity } = identity;
  return fingerprintReviewCommandIdentity(receiptIdentity as MemoryReviewCommandIdentity);
}

function memoryKindRefType(kind: string): CanonicalObjectVersionRef["refType"] | undefined {
  return MEMORY_REF_TYPE_BY_KIND[kind];
}

function isSha256Digest(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function toConflictCandidate(candidate: MemoryCandidateRecord): MemoryConflictCandidate {
  return {
    kind: candidate.kind,
    ...(candidate.target === undefined ? {} : { target: candidate.target }),
    ...(candidate.correctionIntent === undefined ? {} : { correctionIntent: candidate.correctionIntent }),
    ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    proposalId: candidate.proposalId,
    status: "candidate",
    current: false,
    userId: candidate.userId,
    slot: candidate.slot,
    value: candidate.value,
    memoryKind: candidate.memoryKind,
    evidenceRefs: candidate.evidenceRefs,
    sourceClass: candidate.sourceClass,
    confidencePpm: candidate.confidencePpm,
    idempotencyKey: candidate.idempotencyKey,
    purposeScopes: candidate.purposeScopes,
    sensitivity: candidate.sensitivity,
    validity: candidate.validity,
  };
}

function toCurrentConflictCandidate(record: MemoryVersionRecord): MemoryConflictCandidate {
  return {
    kind: "create",
    proposalId: canonicalRefKey(record.ref),
    status: "current",
    current: true,
    userId: record.userId,
    slot: record.slot,
    value: record.value,
    memoryKind: record.kind,
    evidenceRefs: record.evidenceRefs,
    sourceClass: record.sourceClass,
    confidencePpm: record.confidencePpm,
    idempotencyKey: canonicalRefKey(record.ref),
    purposeScopes: record.allowedPurposeScopes,
    sensitivity: record.sensitivity,
    validity: record.validity,
    memoryRef: record.ref,
  };
}

function sameRef(left: CanonicalObjectVersionRef | undefined, right: CanonicalObjectVersionRef | undefined): boolean {
  return left !== undefined && right !== undefined && canonicalRefKey(left) === canonicalRefKey(right);
}

function buildError(code: MemoryCommandError["code"], retryable: boolean, watermark?: AuthorityWatermark): MemoryCommandResult<MemoryReviewReceipt> {
  return {
    ok: false,
    error: {
      code,
      retryable,
      ...(stableWatermark(watermark) ? { authorityWatermark: stableClone(watermark) } : {}),
    },
  };
}

function ownerInvalid(): MemoryReviewResult {
  return buildError(OWNER_STATE_INVALID, false);
}

function ownerUnavailable(): MemoryReviewResult {
  return buildError("OWNER_STATE_UNAVAILABLE", true);
}

function sanitizeOwnerError(value: unknown): MemoryReviewResult {
  if (!hasExactKeys(value, new Set(["code", "retryable"]), new Set(["authorityWatermark"]))) return ownerInvalid();
  if (typeof value.code !== "string" || !KNOWN_ERROR_CODES.has(value.code) || typeof value.retryable !== "boolean") return ownerInvalid();
  if (Object.prototype.hasOwnProperty.call(value, "authorityWatermark") &&
      !stableWatermark(value.authorityWatermark)) return ownerInvalid();
  return buildError(value.code as MemoryCommandError["code"], value.retryable, value.authorityWatermark);
}

function cloneConflictBinding(value: MemoryConflictBinding): MemoryConflictBinding {
  return Object.freeze({
    conflictId: value.conflictId,
    candidateRefs: cloneRefs(value.candidateRefs),
    currentRefs: cloneRefs(value.currentRefs),
    reasonCode: value.reasonCode,
    authorityWatermark: stableClone(value.authorityWatermark),
  });
}

function cloneReceipt(value: MemoryReviewReceipt, outcome: "committed" | "replayed" = value.outcome): MemoryReviewReceipt {
  return Object.freeze({
    ...value,
    outcome,
    candidateRef: cloneRef(value.candidateRef),
    createdMemoryRefs: cloneRefs(value.createdMemoryRefs),
    linkedMemoryRefs: cloneRefs(value.linkedMemoryRefs),
    currentMemoryRefs: cloneRefs(value.currentMemoryRefs),
    supersededRefs: cloneRefs(value.supersededRefs),
    ...(value.conflictBinding === undefined ? {} : { conflictBinding: cloneConflictBinding(value.conflictBinding) }),
    authorityWatermark: stableClone(value.authorityWatermark),
  });
}

function validateStateSnapshot(value: unknown, input: MemoryReviewInput): value is MemoryReviewStateSnapshot {
  if (!hasExactKeys(value, new Set(["query", "currentRecords", "conflict", "authorityWatermark"]))) return false;
  if (!hasExactKeys(value.query, new Set(["userId", "slot"])) ||
      value.query.userId !== input.expectedUserId || value.query.slot !== input.expectedSlot ||
      !Array.isArray(value.currentRecords) || typeof value.conflict !== "boolean" ||
      !stableWatermark(value.authorityWatermark)) return false;
  return value.currentRecords.every((record) => validateMemoryRecord(record));
}

function validateReceipt(
  value: unknown,
  expected: {
    readonly input: MemoryReviewInput;
    readonly candidate: MemoryCandidateRecord;
    readonly fingerprint: Sha256;
    readonly identity: MemoryReviewCommandIdentity;
    readonly plan: ReviewPlan;
    readonly conflictBinding?: MemoryConflictBinding;
  },
): MemoryReviewReceipt | undefined {
  let identityFingerprint: Sha256;
  try {
    identityFingerprint = fingerprintReviewReceiptIdentity(expected.identity);
  } catch {
    return undefined;
  }
  if (!hasExactKeys(value, new Set([
    "kind", "outcome", "idempotencyKey", "fingerprint", "candidateRef", "candidateStatus",
    "decision", "resolution", "createdMemoryRefs", "linkedMemoryRefs", "currentMemoryRefs", "supersededRefs",
    "authorityWatermark",
  ]), new Set(["conflictBinding"]))) return undefined;
  if (value.kind !== "memory_review_receipt" ||
      (value.outcome !== "committed" && value.outcome !== "replayed") ||
      value.idempotencyKey !== expected.input.idempotencyKey || value.fingerprint !== expected.fingerprint ||
      value.fingerprint !== identityFingerprint ||
      !isSha256Digest(value.fingerprint) ||
      !exactRef(value.candidateRef, "MemoryCandidate") ||
      canonicalRefKey(value.candidateRef) !== canonicalRefKey(expected.candidate.candidateRef) ||
      value.decision !== expected.input.decision || value.resolution !== expected.plan.resolution ||
      !stableWatermark(value.authorityWatermark) ||
      !uniqueRefs(value.createdMemoryRefs) || !uniqueRefs(value.linkedMemoryRefs) ||
      !uniqueRefs(value.currentMemoryRefs) || !uniqueRefs(value.supersededRefs)) return undefined;

  const expectedStatus: MemoryCandidateStatus = expected.plan.resolution === "accept_new" ||
    expected.plan.resolution === "accept_existing" || expected.plan.resolution === "accept_superseding"
    ? "accepted"
    : expected.plan.resolution === "reject" ? "rejected"
    : expected.plan.resolution === "quarantine" ? "quarantined"
    : "candidate";
  if (value.candidateStatus !== expectedStatus) return undefined;
  if (expected.plan.resolution === "accept_new" && expected.candidate.kind !== "create") return undefined;
  if (expected.plan.resolution === "accept_existing" && expected.candidate.kind !== "create") return undefined;

  const created = value.createdMemoryRefs as readonly CanonicalObjectVersionRef[];
  const linked = value.linkedMemoryRefs as readonly CanonicalObjectVersionRef[];
  const current = value.currentMemoryRefs as readonly CanonicalObjectVersionRef[];
  const superseded = value.supersededRefs as readonly CanonicalObjectVersionRef[];
  const expectedType = memoryKindRefType(expected.candidate.memoryKind);
  if (expectedType === undefined ||
      created.some((ref) => ref.refType !== expectedType) ||
      linked.some((ref) => ref.refType !== expectedType) ||
      current.some((ref) => ref.refType !== expectedType) ||
       superseded.some((ref) => ref.refType !== expectedType)) return undefined;
  const hasCanonicalMemoryRef = Object.prototype.hasOwnProperty.call(expected.identity, "canonicalMemoryRef");
  if (hasCanonicalMemoryRef) {
    const canonicalMemoryRef = (expected.identity as MemoryReviewCommandIdentity & { readonly canonicalMemoryRef?: unknown }).canonicalMemoryRef;
    if ((expected.plan.resolution !== "accept_new" && expected.plan.resolution !== "accept_superseding") ||
        !exactRef(canonicalMemoryRef, expectedType) || created.length !== 1 ||
        canonicalRefKey(canonicalMemoryRef) !== canonicalRefKey(created[0]!)) return undefined;
  }

  switch (expected.plan.resolution) {
    case "accept_new":
      if (created.length !== 1 || linked.length !== 0 || current.length !== 1 || superseded.length !== 0 ||
          canonicalRefKey(created[0]!) !== canonicalRefKey(current[0]!) ||
           Object.prototype.hasOwnProperty.call(value, "conflictBinding")) return undefined;
      break;
    case "accept_existing":
      if (created.length !== 0 || linked.length !== 1 || current.length !== 1 || superseded.length !== 0 ||
          expected.plan.expectedCurrentRef === undefined ||
          canonicalRefKey(linked[0]!) !== canonicalRefKey(expected.plan.expectedCurrentRef) ||
          canonicalRefKey(current[0]!) !== canonicalRefKey(expected.plan.expectedCurrentRef) ||
          Object.prototype.hasOwnProperty.call(value, "conflictBinding")) return undefined;
      break;
    case "accept_superseding":
      if (created.length !== 1 || linked.length !== 0 || current.length !== 1 || superseded.length !== 1 ||
          expected.plan.expectedCurrentRef === undefined ||
          canonicalRefKey(created[0]!) !== canonicalRefKey(current[0]!) ||
          canonicalRefKey(superseded[0]!) !== canonicalRefKey(expected.plan.expectedCurrentRef) ||
           canonicalRefKey(created[0]!) === canonicalRefKey(expected.plan.expectedCurrentRef) ||
           Object.prototype.hasOwnProperty.call(value, "conflictBinding")) return undefined;
      break;
    case "reject":
    case "quarantine":
      if (created.length !== 0 || linked.length !== 0 || current.length !== 0 || superseded.length !== 0 ||
          Object.prototype.hasOwnProperty.call(value, "conflictBinding")) return undefined;
      break;
    case "requires_review": {
      if (created.length !== 0 || linked.length !== 0 || superseded.length !== 0 ||
          !Object.prototype.hasOwnProperty.call(value, "conflictBinding") ||
          !validateConflictBinding(value.conflictBinding) || expected.conflictBinding === undefined ||
          stableSerialize(value.conflictBinding) !== stableSerialize(expected.conflictBinding) ||
          current.length !== expected.conflictBinding.currentRefs.length ||
          !current.every((ref) => refsContain(expected.conflictBinding!.currentRefs, ref))) return undefined;
      break;
    }
  }

  return cloneReceipt(value as unknown as MemoryReviewReceipt);
}

/** Binds a durable receipt to the candidate row written by the same command. */
function validateCandidateLifecycle(
  candidate: MemoryCandidateRecord,
  receipt: MemoryReviewReceipt,
): boolean {
  if (canonicalRefKey(candidate.candidateRef) !== canonicalRefKey(receipt.candidateRef) ||
      candidate.status !== receipt.candidateStatus) return false;
  const hasLinked = Object.prototype.hasOwnProperty.call(candidate, "linkedMemoryRef");
  const hasConflict = Object.prototype.hasOwnProperty.call(candidate, "conflictBinding");
  const linkedMemoryRef = candidate.linkedMemoryRef;
  switch (receipt.resolution) {
    case "accept_new":
    case "accept_existing":
    case "accept_superseding": {
      if (candidate.status !== "accepted" || candidate.requiresReview !== false || !hasLinked || hasConflict ||
          linkedMemoryRef === undefined) return false;
      const expectedLinked = receipt.resolution === "accept_existing"
        ? receipt.linkedMemoryRefs[0]
        : receipt.createdMemoryRefs[0];
      return expectedLinked !== undefined && canonicalRefKey(linkedMemoryRef) === canonicalRefKey(expectedLinked);
    }
    case "reject":
      return candidate.status === "rejected" && candidate.requiresReview === false && !hasLinked && !hasConflict;
    case "quarantine":
      return candidate.status === "quarantined" && candidate.requiresReview === true && !hasLinked && !hasConflict;
    case "requires_review":
      return candidate.status === "candidate" && candidate.requiresReview === true && !hasLinked && hasConflict &&
        receipt.conflictBinding !== undefined &&
        stableSerialize(candidate.conflictBinding) === stableSerialize(receipt.conflictBinding);
  }
}

function optionalRefMatches(
  value: unknown,
  key: string,
  expected: CanonicalObjectVersionRef | undefined,
): boolean {
  if (!isRecord(value)) return false;
  const present = Object.prototype.hasOwnProperty.call(value, key);
  if (!present) return expected === undefined;
  return expected !== undefined && exactRef(value[key]) && sameRef(value[key], expected);
}

function validateSelectionBasis(
  identity: MemoryReviewCommandIdentity,
  candidate: MemoryCandidateRecord,
): boolean {
  if (!stableValue(identity.selectionBasis) || !isPlainRecord(identity.selectionBasis)) return false;
  const basis = identity.selectionBasis as unknown as Record<string, unknown>;
  if (identity.resolution === "reject" || identity.resolution === "quarantine") {
    return Object.keys(basis).length === 2 && basis.mode === "terminal_decision" && basis.stateRead === false;
  }
  if (basis.mode !== "accept" || typeof basis.current !== "string") return false;
  if (identity.resolution === "accept_new") {
    return Object.keys(basis).length === 3 && basis.current === "absent" && basis.candidateKind === candidate.kind;
  }
  if (identity.resolution === "accept_existing") {
    return Object.keys(basis).length === 2 && basis.current === "same_value";
  }
  if (typeof basis.reasonCode !== "string" || basis.reasonCode.trim().length === 0) return false;
  if (identity.resolution === "accept_superseding") {
    return Object.keys(basis).length === 3 && basis.current === "incoming_higher_precedence";
  }
  return Object.keys(basis).length === 3 &&
    (basis.current === "current_higher_precedence" ||
      basis.current === "same_precedence_or_unresolved" ||
      basis.current === "same_value_correction_requires_review");
}

function validateCommandIdentity(
  value: unknown,
  input: MemoryReviewInput,
  candidate: MemoryCandidateRecord,
  requestFingerprintValue: Sha256,
): value is MemoryReviewCommandIdentity {
  if (!hasExactKeys(value, REQUIRED_COMMAND_IDENTITY_KEYS, OPTIONAL_COMMAND_IDENTITY_KEYS)) return false;
  if (value.operation !== "memory_review" ||
      !exactRef(value.candidateRef, "MemoryCandidate") ||
      canonicalRefKey(value.candidateRef) !== canonicalRefKey(candidate.candidateRef) ||
      !isSha256Digest(value.candidatePayloadSha256) ||
      value.candidatePayloadSha256 !== digestStable(immutableCandidatePayload(candidate)) ||
      value.expectedCandidateStatus !== input.expectedCandidateStatus ||
      value.expectedUserId !== input.expectedUserId ||
      value.expectedSlot !== input.expectedSlot ||
      value.decision !== input.decision ||
      !MEMORY_REVIEW_RESOLUTIONS.includes(value.resolution as (typeof MEMORY_REVIEW_RESOLUTIONS)[number]) ||
      !MEMORY_REVIEW_DECISIONS.includes(value.decision as (typeof MEMORY_REVIEW_DECISIONS)[number]) ||
      value.idempotencyKey !== input.idempotencyKey ||
      value.requestFingerprint !== requestFingerprintValue ||
      !validateAuthorization(value.authorization) ||
      stableSerialize(value.authorization) !== stableSerialize(input.authorization) ||
      !optionalRefMatches(value, "callerExpectedCurrentRef", input.expectedCurrentRef) ||
      (Object.prototype.hasOwnProperty.call(value, "reviewStateAuthorityWatermark") !==
        !(value.resolution === "reject" || value.resolution === "quarantine")) ||
      (Object.prototype.hasOwnProperty.call(value, "reviewStateAuthorityWatermark") &&
        !stableWatermark(value.reviewStateAuthorityWatermark)) ||
      !validateSelectionBasis(value as unknown as MemoryReviewCommandIdentity, candidate)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "expectedCurrentRef") && !exactRef(value.expectedCurrentRef)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "conflictBinding") && !validateConflictBinding(value.conflictBinding)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "resolvedContent") && typeof value.resolvedContent !== "string") return false;
  if (input.resolvedContent === undefined) {
    if (Object.prototype.hasOwnProperty.call(value, "resolvedContent")) return false;
  } else if (value.resolvedContent !== input.resolvedContent) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, "canonicalMemoryRef")) {
    const expectedType = memoryKindRefType(candidate.memoryKind);
    if ((value.resolution !== "accept_new" && value.resolution !== "accept_superseding") ||
        !exactRef(value.canonicalMemoryRef, expectedType)) return false;
  }
  return true;
}

/** Validates a repository replay record before returning any stored refs. */
function validateReplayRecord(
  value: unknown,
  input: MemoryReviewInput,
  candidate: MemoryCandidateRecord,
  requestFingerprintValue: Sha256,
): MemoryReviewReceipt | "IDEMPOTENCY_CONFLICT" | undefined {
  if (!hasExactKeys(value, new Set(["requestFingerprint", "commandIdentity", "receipt"]))) return undefined;
  if (!isSha256Digest(value.requestFingerprint)) return undefined;
  if (value.requestFingerprint !== requestFingerprintValue) return "IDEMPOTENCY_CONFLICT";
  if (!validateCommandIdentity(value.commandIdentity, input, candidate, requestFingerprintValue)) return undefined;
  if (!isPlainRecord(value.receipt)) return undefined;
  const identity = value.commandIdentity;
  const receiptValue = value.receipt;
  const resolution = identity.resolution;
  let expectedCurrentRef: CanonicalObjectVersionRef | undefined;
  let conflictBinding: MemoryConflictBinding | undefined;
  if (resolution === "accept_existing") {
    if (!Array.isArray(receiptValue.currentMemoryRefs) || receiptValue.currentMemoryRefs.length !== 1 ||
        !exactRef(receiptValue.currentMemoryRefs[0])) return undefined;
    expectedCurrentRef = receiptValue.currentMemoryRefs[0];
  } else if (resolution === "accept_superseding") {
    if (!Array.isArray(receiptValue.supersededRefs) || receiptValue.supersededRefs.length !== 1 ||
        !exactRef(receiptValue.supersededRefs[0])) return undefined;
    expectedCurrentRef = receiptValue.supersededRefs[0];
  } else if (resolution === "requires_review") {
    if (!validateConflictBinding(receiptValue.conflictBinding)) return undefined;
    conflictBinding = receiptValue.conflictBinding;
    if (conflictBinding.currentRefs.length !== 1) return undefined;
    expectedCurrentRef = conflictBinding.currentRefs[0];
  }
  if (!optionalRefMatches(identity, "expectedCurrentRef", expectedCurrentRef)) return undefined;
  const identityConflict = Object.prototype.hasOwnProperty.call(identity, "conflictBinding")
    ? identity.conflictBinding
    : undefined;
  if (resolution === "requires_review") {
    if (identityConflict === undefined || conflictBinding === undefined ||
        stableSerialize(identityConflict) !== stableSerialize(conflictBinding) ||
        !Object.prototype.hasOwnProperty.call(identity, "reviewStateAuthorityWatermark") ||
        stableSerialize(identity.reviewStateAuthorityWatermark) !== stableSerialize(conflictBinding.authorityWatermark)) {
      return undefined;
    }
  } else if (identityConflict !== undefined) {
    return undefined;
  }
  const plan: ReviewPlan = {
    resolution,
    selectionBasis: { mode: "replay", resolution },
    ...(expectedCurrentRef === undefined ? {} : { expectedCurrentRef }),
    ...(conflictBinding === undefined ? {} : {
      conflictBindingBasis: {
        currentRefs: conflictBinding.currentRefs,
        reasonCode: conflictBinding.reasonCode,
        authorityWatermark: conflictBinding.authorityWatermark,
      },
    }),
  };
  let fingerprint: Sha256;
  try {
    fingerprint = fingerprintReviewReceiptIdentity(identity);
  } catch {
    return undefined;
  }
  const receipt = validateReceipt(receiptValue, {
    input,
    candidate,
    fingerprint,
    identity,
    plan,
    ...(conflictBinding === undefined ? {} : { conflictBinding }),
  });
  if (receipt === undefined || !validateCandidateLifecycle(candidate, receipt)) return undefined;
  return cloneReceipt(receipt, "replayed");
}

/** Storage-neutral review application service. */
export class MemoryReviewService {
  private readonly candidateReader: MemoryCandidateReader;
  private readonly reviewStateReader: MemoryReviewStateReader;
  private readonly receiptReader: MemoryReviewReceiptReader;
  private readonly commandRepository: MemoryCommandRepository;
  private readonly canonicalIdentity: MemoryCanonicalIdentityProvider | undefined;

  public constructor(
    candidateReader: MemoryCandidateReader,
    reviewStateReader: MemoryReviewStateReader,
    receiptReader: MemoryReviewReceiptReader,
    commandRepository: MemoryCommandRepository,
    canonicalIdentity?: MemoryCanonicalIdentityProvider,
  ) {
    this.candidateReader = candidateReader;
    this.reviewStateReader = reviewStateReader;
    this.receiptReader = receiptReader;
    this.commandRepository = commandRepository;
    this.canonicalIdentity = canonicalIdentity;
  }

  public async review(input: MemoryReviewInput): Promise<MemoryReviewResult> {
    try {
      if (!validateInput(input)) return buildError("INVALID_COMMAND", false);
      const safeInput = cloneReviewInput(input);
      if ((safeInput.decision === "reject" || safeInput.decision === "quarantine") &&
          safeInput.expectedCurrentRef !== undefined) {
        return buildError("INVALID_COMMAND", false);
      }

      let candidateValue: MemoryCandidateRecord | undefined;
      try {
      candidateValue = await this.candidateReader.findCandidateByRef(safeInput.candidateRef);
      } catch {
        return ownerUnavailable();
      }
      if (candidateValue === undefined) return buildError("CANDIDATE_NOT_FOUND", false);
      const enforceRequiresReview = this.canonicalIdentity?.environment === "production" ||
        safeInput.issuerReceipt !== undefined;
      if (!validateCandidateRecord(candidateValue, safeInput.candidateRef, enforceRequiresReview)) return ownerInvalid();
      const candidate = cloneCandidateRecord(candidateValue);
      if (candidate.userId !== safeInput.expectedUserId || candidate.slot !== safeInput.expectedSlot) {
        return buildError("CANDIDATE_STATE_CONFLICT", false);
      }

      if (safeInput.issuerReceipt !== undefined) {
        try {
          const ownerReceipt = assertProductionMemoryIssuerReceipt(safeInput.issuerReceipt);
          if (!reviewIssuerReceiptMatchesCandidate(ownerReceipt, candidate, safeInput.decision)) return ownerInvalid();
        } catch {
          return ownerInvalid();
        }
      }

      const requestFingerprintValue = requestFingerprint(safeInput, candidate);
      let replayRecord: MemoryReviewReplayRecord | undefined;
      try {
        replayRecord = await this.receiptReader.findReviewReceiptByIdempotencyKey({
          idempotencyKey: safeInput.idempotencyKey,
        });
      } catch {
        return ownerUnavailable();
      }
      if (replayRecord !== undefined) {
        const replayReceipt = validateReplayRecord(replayRecord, safeInput, candidate, requestFingerprintValue);
        if (replayReceipt === "IDEMPOTENCY_CONFLICT") return buildError("IDEMPOTENCY_CONFLICT", false);
        if (replayReceipt === undefined) return ownerInvalid();
        return { ok: true, receipt: replayReceipt };
      }
      if (candidate.status !== safeInput.expectedCandidateStatus) return buildError("CANDIDATE_STATE_CONFLICT", false);

      let plan: ReviewPlan;
      let stateWatermark: AuthorityWatermark | undefined;
      if (safeInput.decision === "reject" || safeInput.decision === "quarantine") {
        plan = {
          resolution: safeInput.decision,
          selectionBasis: { mode: "terminal_decision", stateRead: false },
        };
      } else {
        let state: MemoryReviewStateSnapshot;
        try {
          state = await this.reviewStateReader.findAuthoritativeCurrentBySlot({
            userId: safeInput.expectedUserId,
            slot: safeInput.expectedSlot,
          });
        } catch {
          return ownerUnavailable();
        }
        if (!validateStateSnapshot(state, safeInput)) return ownerInvalid();
        state = cloneReviewStateSnapshot(state);
        stateWatermark = state.authorityWatermark;
        if (state.conflict || state.currentRecords.length > 1) {
          return buildError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
        }
        const current = state.currentRecords[0];
        if (current === undefined) {
          if (safeInput.expectedCurrentRef !== undefined || candidate.kind !== "create") {
            return buildError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
          }
          plan = {
            resolution: "accept_new",
            selectionBasis: { mode: "accept", current: "absent", candidateKind: candidate.kind },
          };
        } else {
          if (current.status !== "current" || current.current !== true || current.stale === true ||
              current.deletedAt !== undefined || current.suppressedAt !== undefined ||
              current.userId !== candidate.userId || current.slot !== candidate.slot ||
              current.kind !== candidate.memoryKind) {
            return buildError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
          }
          if (safeInput.expectedCurrentRef !== undefined && !sameRef(safeInput.expectedCurrentRef, current.ref)) {
            return buildError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
          }
          if (candidate.kind === "correct" &&
              (candidate.target === undefined || !sameRef(candidate.target, current.ref))) {
            return buildError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
          }
          if (candidate.kind === "correct" && stableEqual(candidate.value, current.value)) {
            plan = {
              resolution: "requires_review",
              selectionBasis: {
                mode: "accept",
                current: "same_value_correction_requires_review",
                reasonCode: "CORRECTION_REQUIRES_SUPERSEDING",
              },
              expectedCurrentRef: current.ref,
              conflictBindingBasis: {
                currentRefs: [current.ref],
                reasonCode: "CORRECTION_REQUIRES_SUPERSEDING",
                authorityWatermark: state.authorityWatermark,
              },
              current,
            };
          } else if (stableEqual(candidate.value, current.value)) {
            plan = {
              resolution: "accept_existing",
              selectionBasis: { mode: "accept", current: "same_value" },
              expectedCurrentRef: current.ref,
              current,
            };
          } else {
            const resolution = resolveMemoryConflict([
              toConflictCandidate(candidate),
              toCurrentConflictCandidate(current),
            ]);
            const winnerRef = resolution.winner?.memoryRef;
            const currentWins = winnerRef !== undefined && sameRef(winnerRef, current.ref);
            if (resolution.status === "resolved" && resolution.resolution === "correction" && !currentWins) {
              plan = {
                resolution: "accept_superseding",
                selectionBasis: {
                  mode: "accept",
                  current: "incoming_higher_precedence",
                  reasonCode: resolution.reasonCode ?? "INCOMING_PRECEDENCE_WINS",
                },
                expectedCurrentRef: current.ref,
                current,
              };
            } else {
              plan = {
                resolution: "requires_review",
                selectionBasis: {
                  mode: "accept",
                  current: currentWins ? "current_higher_precedence" : "same_precedence_or_unresolved",
                  reasonCode: resolution.reasonCode ?? (currentWins ? "CURRENT_PRECEDENCE_WINS" : "CONFLICT_REQUIRES_REVIEW"),
                },
                expectedCurrentRef: current.ref,
                conflictBindingBasis: {
                  currentRefs: [current.ref],
                  reasonCode: resolution.reasonCode ?? (currentWins ? "CURRENT_PRECEDENCE_WINS" : "CONFLICT_REQUIRES_REVIEW"),
                  authorityWatermark: state.authorityWatermark,
                },
                current,
              };
            }
          }
        }
      }

      let conflictBinding: MemoryConflictBinding | undefined;
      const provisionalIdentity = createReviewCommandIdentity(
        safeInput,
        candidate,
        plan,
        stateWatermark,
        undefined,
        requestFingerprintValue,
      );
      const provisionalFingerprint = fingerprintReviewCommandIdentity(provisionalIdentity);
      if (plan.conflictBindingBasis !== undefined) {
        conflictBinding = Object.freeze({
          conflictId: `t05-review-${provisionalFingerprint}`,
          candidateRefs: Object.freeze([cloneRef(candidate.candidateRef)]),
          currentRefs: cloneRefs(plan.conflictBindingBasis.currentRefs),
          reasonCode: plan.conflictBindingBasis.reasonCode,
          authorityWatermark: plan.conflictBindingBasis.authorityWatermark,
        });
      }
      const identity = createReviewCommandIdentity(
        safeInput,
        candidate,
        plan,
        stateWatermark,
        conflictBinding,
        requestFingerprintValue,
      );
      const fingerprint = fingerprintReviewCommandIdentity(identity);
      if (safeInput.issuerReceipt !== undefined &&
          !receiptMatchesReviewPlan(safeInput.issuerReceipt, candidate, plan.resolution, plan.expectedCurrentRef)) {
        return ownerInvalid();
      }
      // The conflict binding deliberately derives from the command identity. The
      // binding fields (except that derived local id) are already in selectionBasis.
      let canonicalMemoryRef: CanonicalObjectVersionRef | undefined;
      if ((identity.resolution === "accept_new" || identity.resolution === "accept_superseding") &&
          safeInput.issuerReceipt !== undefined) {
        try {
          const ownerReceipt = assertProductionMemoryIssuerReceipt(safeInput.issuerReceipt);
          if (ownerReceipt.memoryRef === undefined) return ownerInvalid();
          canonicalMemoryRef = cloneRef(ownerReceipt.memoryRef);
        } catch {
          return ownerInvalid();
        }
      } else if ((identity.resolution === "accept_new" || identity.resolution === "accept_superseding") &&
          this.canonicalIdentity !== undefined) {
        try {
          canonicalMemoryRef = assertCanonicalObjectVersionRef(await this.canonicalIdentity.memoryRefFor({
            candidateRef: candidate.candidateRef,
            memoryKind: candidate.memoryKind,
            operation: identity.resolution,
            ...(plan.expectedCurrentRef === undefined ? {} : { expectedCurrentRef: plan.expectedCurrentRef }),
            candidate,
          }));
        } catch {
          return ownerUnavailable();
        }
      }
      const command: MemoryCandidateReviewCommand = Object.freeze({
        ...(canonicalMemoryRef === undefined ? identity : { ...identity, canonicalMemoryRef }),
        ...(safeInput.issuerReceipt === undefined ? {} : { issuerReceipt: safeInput.issuerReceipt }),
        fingerprint,
      });

      const committedIdentity = canonicalMemoryRef === undefined
        ? identity
        : Object.freeze({ ...identity, canonicalMemoryRef });

      const receiptExpectation = {
        input: safeInput,
        candidate,
        fingerprint,
        identity: committedIdentity,
        plan,
        ...(conflictBinding === undefined ? {} : { conflictBinding }),
      };
      let result: unknown;
      try {
        result = await this.commandRepository.withTransaction(async (transaction: MemoryCommandTransaction) => {
          if (typeof transaction.reviewCandidate !== "function") return ownerUnavailable();
          const ownerResult = await transaction.reviewCandidate(command);
          if (!isRecord(ownerResult) || typeof ownerResult.ok !== "boolean") {
            throw INVALID_OWNER_RECEIPT;
          }
          if (ownerResult.ok === true) {
            if (!isRecord(ownerResult.receipt)) throw INVALID_OWNER_RECEIPT;
            const ownerReceipt = ownerResult.receipt as MemoryReviewReceipt;
            if (ownerReceipt.outcome !== "replayed" &&
                validateReceipt(ownerResult.receipt, receiptExpectation) === undefined) {
              throw INVALID_OWNER_RECEIPT;
            }
          } else {
            const normalizedError = sanitizeOwnerError(ownerResult.error);
            if (normalizedError.ok || normalizedError.error.code === OWNER_STATE_INVALID) {
              throw INVALID_OWNER_RECEIPT;
            }
          }
          return ownerResult;
        });
      } catch (error) {
        if (error === INVALID_OWNER_RECEIPT) return ownerInvalid();
        return ownerUnavailable();
      }
      if (!isRecord(result) || typeof result.ok !== "boolean") return ownerInvalid();
      if (result.ok === false) return sanitizeOwnerError(result.error);
      if (isRecord(result.receipt) && result.receipt.outcome === "replayed") {
        let postReplay: MemoryReviewReplayRecord | undefined;
        try {
          postReplay = await this.receiptReader.findReviewReceiptByIdempotencyKey({
            idempotencyKey: safeInput.idempotencyKey,
          });
        } catch {
          return ownerUnavailable();
        }
        if (postReplay === undefined) return ownerUnavailable();
        let postCandidateValue: MemoryCandidateRecord | undefined;
        try {
          postCandidateValue = await this.candidateReader.findCandidateByRef(safeInput.candidateRef);
        } catch {
          return ownerUnavailable();
        }
        const enforceRequiresReview = this.canonicalIdentity?.environment === "production" ||
          safeInput.issuerReceipt !== undefined;
        if (postCandidateValue === undefined ||
            !validateCandidateRecord(postCandidateValue, safeInput.candidateRef, enforceRequiresReview)) {
          return postCandidateValue === undefined ? ownerUnavailable() : ownerInvalid();
        }
        const replayReceipt = validateReplayRecord(
          postReplay,
          safeInput,
          cloneCandidateRecord(postCandidateValue),
          requestFingerprintValue,
        );
        if (replayReceipt === "IDEMPOTENCY_CONFLICT") return buildError("IDEMPOTENCY_CONFLICT", false);
        if (replayReceipt === undefined) return ownerInvalid();
        return { ok: true, receipt: replayReceipt };
      }
      const receipt = validateReceipt(result.receipt, receiptExpectation);
      if (receipt === undefined) return ownerInvalid();
      return { ok: true, receipt };
    } catch {
      return ownerUnavailable();
    }
  }

  /** Alias kept explicit for callers that name the command after its port. */
  public reviewCandidate(input: MemoryReviewInput): Promise<MemoryReviewResult> {
    return this.review(input);
  }
}

/**
 * Production-only review wrapper. The existing class remains the
 * storage-neutral seam used by volatile unit fixtures. This wrapper validates
 * the issuer receipt before constructing the internal provider adapter.
 */
export class ProductionMemoryReviewService {
  readonly #candidateReader: MemoryCandidateReader;
  readonly #reviewStateReader: MemoryReviewStateReader;
  readonly #receiptReader: MemoryReviewReceiptReader;
  readonly #commandRepository: MemoryCommandRepository;

  constructor(
    candidateReader: MemoryCandidateReader,
    reviewStateReader: MemoryReviewStateReader,
    receiptReader: MemoryReviewReceiptReader,
    commandRepository: MemoryCommandRepository,
  ) {
    this.#candidateReader = candidateReader;
    this.#reviewStateReader = reviewStateReader;
    this.#receiptReader = receiptReader;
    this.#commandRepository = commandRepository;
  }

  public async review(input: ProductionMemoryReviewInput): Promise<MemoryReviewResult> {
    const raw = input as unknown as Record<string, unknown>;
    const allowed = new Set([
      ...REVIEW_INPUT_REQUIRED_KEYS,
      ...REVIEW_INPUT_OPTIONAL_KEYS,
      "issuerReceipt",
    ]);
    if (!isPlainRecord(raw) || Object.keys(raw).some((key) => !allowed.has(key)) ||
        !Object.prototype.hasOwnProperty.call(raw, "candidateRef")) {
      return buildError("INVALID_COMMAND", false);
    }
    const base: MemoryReviewInput = {
      candidateRef: input.candidateRef,
      expectedCandidateStatus: input.expectedCandidateStatus,
      expectedUserId: input.expectedUserId,
      expectedSlot: input.expectedSlot,
      decision: input.decision,
      idempotencyKey: input.idempotencyKey,
      authorization: input.authorization,
      ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
      ...(input.expectedCurrentRef === undefined ? {} : { expectedCurrentRef: input.expectedCurrentRef }),
      ...(input.issuerReceipt === undefined ? {} : { issuerReceipt: input.issuerReceipt }),
    };
    if (input.decision === "reject" || input.decision === "quarantine") {
      if (input.issuerReceipt === undefined) return ownerUnavailable();
      return new MemoryReviewService(
        this.#candidateReader,
        this.#reviewStateReader,
        this.#receiptReader,
        this.#commandRepository,
      ).review(base);
    }
    if (input.issuerReceipt === undefined) return ownerUnavailable();
    let receipt: ProductionMemoryIssuerReceipt;
    try {
      receipt = assertProductionMemoryIssuerReceipt(input.issuerReceipt);
    } catch {
      return ownerInvalid();
    }
    if (receipt.candidateRef === undefined || receipt.candidateRef.refId !== input.candidateRef.refId) {
      return ownerInvalid();
    }
    const identity: MemoryCanonicalIdentityProvider = {
      environment: "production",
      candidateRefFor: () => receipt.candidateRef!,
      memoryRefFor: () => receipt.memoryRef!,
    };
    return new MemoryReviewService(
      this.#candidateReader,
      this.#reviewStateReader,
      this.#receiptReader,
      this.#commandRepository,
      identity,
    ).review(base);
  }

  public reviewCandidate(input: ProductionMemoryReviewInput): Promise<MemoryReviewResult> {
    return this.review(input);
  }
}

export function createMemoryReviewService(
  candidateReader: MemoryCandidateReader,
  reviewStateReader: MemoryReviewStateReader,
  receiptReader: MemoryReviewReceiptReader,
  commandRepository: MemoryCommandRepository,
): MemoryReviewService {
  return new MemoryReviewService(candidateReader, reviewStateReader, receiptReader, commandRepository);
}

export function createProductionMemoryReviewService(
  candidateReader: MemoryCandidateReader,
  reviewStateReader: MemoryReviewStateReader,
  receiptReader: MemoryReviewReceiptReader,
  commandRepository: MemoryCommandRepository,
): ProductionMemoryReviewService {
  return new ProductionMemoryReviewService(
    candidateReader,
    reviewStateReader,
    receiptReader,
    commandRepository,
  );
}
