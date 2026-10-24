import type { CanonicalObjectVersionRef, Sha256 } from "./canonical-ref.ts";

declare const canonicalUtcInstantBrand: unique symbol;

/** A strict UTC instant accepted by the T05 application seams. */
export type CanonicalUtcInstant = string & {
  readonly [canonicalUtcInstantBrand]: true;
};

const CANONICAL_UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}|\d{6}))?Z$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Rejects offsets, impossible calendar dates, and non-canonical fractions. */
export function isCanonicalUtcInstant(value: unknown): value is CanonicalUtcInstant {
  if (typeof value !== "string") return false;
  const match = CANONICAL_UTC_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth(year, month) &&
    hour >= 0 && hour <= 23 &&
    minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 59 &&
    Number.isFinite(Date.parse(value));
}

export function assertCanonicalUtcInstant(value: unknown, field = "instant"): CanonicalUtcInstant {
  if (!isCanonicalUtcInstant(value)) {
    throw new TypeError(`${field} must be a strict canonical UTC instant`);
  }
  return value;
}

function comparableUtcInstant(value: CanonicalUtcInstant): string {
  return value.replace(/\.(\d{3})Z$/, ".$1000Z");
}

export function compareCanonicalUtcInstants(
  left: CanonicalUtcInstant,
  right: CanonicalUtcInstant,
): number {
  const a = comparableUtcInstant(left);
  const b = comparableUtcInstant(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface CanonicalUtcWindow {
  readonly from: CanonicalUtcInstant;
  readonly to: CanonicalUtcInstant;
}

export function createCanonicalUtcWindow(input: {
  readonly from: unknown;
  readonly to: unknown;
}): CanonicalUtcWindow {
  const from = assertCanonicalUtcInstant(input.from, "window.from");
  const to = assertCanonicalUtcInstant(input.to, "window.to");
  if (compareCanonicalUtcInstants(from, to) > 0) {
    throw new TypeError("window.from must not be after window.to");
  }
  return Object.freeze({ from, to });
}

export type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

export const MEMORY_KINDS = [
  "semantic_fact",
  "episodic_memory",
  "preference_memory",
  "open_loop",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const EVIDENCE_SOURCE_CLASSES = [
  "explicit_user_correction",
  "explicit_user_preference",
  "repeated_behavior",
  "model_inference",
] as const;

export type EvidenceSourceClass = (typeof EVIDENCE_SOURCE_CLASSES)[number];

/** Fixed precedence: correction > preference > repeated behavior > inference. */
export const SOURCE_PRECEDENCE = Object.freeze({
  explicit_user_correction: 4,
  explicit_user_preference: 3,
  repeated_behavior: 2,
  model_inference: 1,
} as const);

export function evidenceSourcePrecedence(
  sourceClass: EvidenceSourceClass,
): number {
  return SOURCE_PRECEDENCE[sourceClass];
}

/** Durable states covered by this grant. */
export const MEMORY_STATUSES = [
  "current",
  "superseded",
  "disputed",
  "suppressed",
  "deleted",
] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Admission dispositions are separate from durable version status. */
export const MEMORY_CANDIDATE_STATUSES = [
  "candidate",
  "accepted",
  "quarantined",
  "rejected",
] as const;

export type MemoryCandidateStatus = (typeof MEMORY_CANDIDATE_STATUSES)[number];

export const MEMORY_CANDIDATE_INTENTS = [
  "create",
  "accept",
  "update",
  "supersede",
  "correct",
  "dispute",
  "suppress",
  "delete",
] as const;

export type MemoryCandidateIntentKind =
  (typeof MEMORY_CANDIDATE_INTENTS)[number];

export interface MemoryValidity {
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly observedAt?: string;
}

export interface MemorySensitivity {
  readonly classification: "normal" | "sensitive";
  /** Sensitive content is compiler-visible only after explicit confirmation. */
  readonly userConfirmed: boolean;
}

export type MemoryCorrectionIntentKind =
  | "none"
  | "correct"
  | "supersede"
  | "dispute"
  | "suppress"
  | "delete";

/** Correction is a proposal intent and never grants write authority. */
export interface MemoryCorrectionIntent {
  readonly kind: MemoryCorrectionIntentKind;
  readonly target: CanonicalObjectVersionRef;
  readonly reason?: ReadonlyJsonValue;
  readonly evidenceRefs?: readonly CanonicalObjectVersionRef[];
}

/** Structured candidate intent owned by T05. */
export interface MemoryCandidateIntent {
  readonly kind: MemoryCandidateIntentKind;
  readonly target?: CanonicalObjectVersionRef;
  readonly correctionIntent?: MemoryCorrectionIntent;
  readonly reason?: ReadonlyJsonValue;
}

/** Dream may retain only an accepted, evidence-bound delta. */
export interface DreamAcceptedDelta {
  readonly accepted: boolean;
  readonly delta: ReadonlyJsonValue;
  readonly sourceRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedAt?: string;
}

/** Repository-owned accepted delta row used by the Dream application seam. */
export interface AcceptedDreamDeltaRecord {
  readonly ref: CanonicalObjectVersionRef;
  readonly userId: string;
  readonly accepted: true;
  readonly delta: ReadonlyJsonValue;
  readonly sourceRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedAt: CanonicalUtcInstant;
}

/** Opaque cursor; T04/T02 own its encoding and watermark semantics. */
export interface AcceptedDreamDeltaCursor {
  readonly token: string;
  readonly authorityWatermark: AuthorityWatermark;
}

export interface AcceptedDreamDeltaQuery {
  readonly userId: string;
  readonly window: CanonicalUtcWindow;
  readonly limit: number;
  readonly cursor?: AcceptedDreamDeltaCursor;
  /** Optional persisted pin used by durable page readers; encoding remains owner-opaque. */
  readonly pinnedWatermark?: AuthorityWatermark;
}

export interface AcceptedDreamDeltaPage {
  readonly records: readonly AcceptedDreamDeltaRecord[];
  readonly nextCursor?: AcceptedDreamDeltaCursor;
  readonly authorityWatermark: AuthorityWatermark;
}

/** Evidence-backed candidate before durable admission. */
export interface MemoryCandidateProposal {
  readonly proposalId: string;
  readonly intent: MemoryCandidateIntent;
  readonly userId: string;
  readonly kind: MemoryKind;
  readonly slot: string;
  readonly value: ReadonlyJsonValue;
  readonly sourceClass: EvidenceSourceClass;
  readonly evidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly confidencePpm: number;
  readonly purposeScopes: readonly string[];
  readonly sensitivity: MemorySensitivity;
  readonly validity: MemoryValidity;
  readonly correctionIntent?: MemoryCorrectionIntent;
  readonly dreamAcceptedDelta?: DreamAcceptedDelta;
  readonly status?: MemoryCandidateStatus;
}

/**
 * Repository-owned candidate row.  This is deliberately a flat copy of the
 * admitted candidate fields so a review worker can read a complete candidate
 * without re-running admission or depending on a mutable proposal object.
 * `candidateRef` is always issued by the repository and is never a command
 * input that can be chosen by a caller.
 */
export interface MemoryCandidateRecord {
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly kind: "create" | "correct";
  readonly status: MemoryCandidateStatus;
  readonly proposalId: string;
  readonly slot: string;
  readonly value: ReadonlyJsonValue;
  readonly evidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly sourceClass: EvidenceSourceClass;
  readonly confidencePpm: number;
  readonly idempotencyKey: string;
  readonly current: false;
  readonly memoryKind: MemoryKind;
  readonly userId: string;
  readonly purposeScopes: readonly string[];
  readonly sensitivity: MemorySensitivity;
  readonly validity: MemoryValidity;
  readonly target?: CanonicalObjectVersionRef;
  readonly correctionIntent?: MemoryCorrectionIntent;
  readonly reason?: ReadonlyJsonValue;
  readonly conflict?: ReadonlyJsonValue;
  readonly requiresReview: boolean;
  readonly conflictBinding?: MemoryConflictBinding;
  readonly linkedMemoryRef?: CanonicalObjectVersionRef;
  readonly reviewedAt?: CanonicalUtcInstant;
}

/** Internal T05 binding for an unresolved precedence/value conflict. */
export interface MemoryConflictBinding {
  readonly conflictId: string;
  readonly candidateRefs: readonly CanonicalObjectVersionRef[];
  readonly currentRefs: readonly CanonicalObjectVersionRef[];
  readonly reasonCode: string;
  readonly authorityWatermark: AuthorityWatermark;
}

export const MEMORY_REVIEW_AUTHORIZATION_MODES = [
  "explicit_user_confirmation",
  "governed_rule_projection",
] as const;
export type MemoryReviewAuthorizationMode = (typeof MEMORY_REVIEW_AUTHORIZATION_MODES)[number];

/** T03/T04-projected review authority; T05 does not define policy semantics. */
export interface MemoryReviewAuthorization {
  readonly mode: MemoryReviewAuthorizationMode;
  readonly evidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
}

export const MEMORY_REVIEW_DECISIONS = ["accept", "reject", "quarantine"] as const;
export type MemoryReviewDecision = (typeof MEMORY_REVIEW_DECISIONS)[number];

export const MEMORY_REVIEW_RESOLUTIONS = [
  "accept_new",
  "accept_existing",
  "accept_superseding",
  "reject",
  "quarantine",
  "requires_review",
] as const;
export type MemoryReviewResolution = (typeof MEMORY_REVIEW_RESOLUTIONS)[number];

/**
 * Receipt returned by a repository review transaction.  Every canonical ref,
 * current/superseded transition, and watermark is repository output.
 */
export interface MemoryReviewReceipt {
  readonly kind: "memory_review_receipt";
  readonly outcome: MemoryCommitOutcome;
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly candidateStatus: MemoryCandidateStatus;
  readonly decision: MemoryReviewDecision;
  readonly resolution: MemoryReviewResolution;
  readonly createdMemoryRefs: readonly CanonicalObjectVersionRef[];
  readonly linkedMemoryRefs: readonly CanonicalObjectVersionRef[];
  readonly currentMemoryRefs: readonly CanonicalObjectVersionRef[];
  readonly supersededRefs: readonly CanonicalObjectVersionRef[];
  readonly conflictBinding?: MemoryConflictBinding;
  readonly authorityWatermark: AuthorityWatermark;
}

/**
 * Complete immutable identity of one review attempt.  This is an internal
 * storage/replay seam, not a T01 wire contract.  The two expected-current
 * refs are deliberately distinct: caller intent and repository plan must
 * agree when both are present.
 */
export interface MemoryReviewCommandIdentity {
  readonly operation: "memory_review";
  readonly candidateRef: CanonicalObjectVersionRef;
  /** T05 digest of the immutable candidate payload; never a canonical ref hash. */
  readonly candidatePayloadSha256: Sha256;
  readonly expectedCandidateStatus: MemoryCandidateStatus;
  readonly expectedUserId: string;
  readonly expectedSlot: string;
  readonly decision: MemoryReviewDecision;
  readonly resolution: MemoryReviewResolution;
  readonly idempotencyKey: string;
  readonly requestFingerprint: Sha256;
  readonly authorization: MemoryReviewAuthorization;
  readonly callerExpectedCurrentRef?: CanonicalObjectVersionRef;
  /** Repository plan expected-current CAS target. */
  readonly expectedCurrentRef?: CanonicalObjectVersionRef;
  readonly reviewStateAuthorityWatermark?: AuthorityWatermark;
  readonly selectionBasis: ReadonlyJsonValue;
  readonly conflictBinding?: MemoryConflictBinding;
  readonly resolvedContent?: string;
}

/** Stable sorted-key serialization used by T05 review command identity. */
export function stableSerializeMemoryReviewCommandIdentity(
  value: MemoryReviewCommandIdentity,
): string {
  return stableSerializeReviewIdentityValue(value);
}

function stableSerializeReviewIdentityValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("review identity contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("review identity contains an unsupported value");
  }
  if (seen.has(value)) throw new TypeError("review identity contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableSerializeReviewIdentityValue(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("review identity contains a non-plain object");
  }
  const serialized = `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerializeReviewIdentityValue((value as Record<string, unknown>)[key], seen)}`,
  ).join(",")}}`;
  seen.delete(value);
  return serialized;
}

/** Read-only repository replay record; no wire/schema semantics are implied. */
export interface MemoryReviewReplayRecord {
  readonly requestFingerprint: Sha256;
  readonly commandIdentity: MemoryReviewCommandIdentity;
  readonly receipt: MemoryReviewReceipt;
}

/** Candidate queue read is intentionally separate from the memory snapshot. */
export interface MemoryCandidateQuery {
  readonly userId: string;
  readonly maxItems: number;
  readonly statuses?: readonly MemoryCandidateStatus[];
  readonly slot?: string;
}

export interface MemoryCandidateSnapshot {
  readonly query: MemoryCandidateQuery;
  readonly records: readonly MemoryCandidateRecord[];
  readonly authorityWatermark: AuthorityWatermark;
}

/**
 * Unfiltered review-authority read.  Unlike CompilerQuery, this seam does not
 * apply purpose, sensitivity, content-budget, deletion, or stale filtering.
 * It exposes every current-flag authority row, including stale/deleted/
 * suppressed rows. `conflict` is explicit when more than one such row exists;
 * review services must fail closed instead of selecting one silently.
 */
export interface MemoryReviewStateQuery {
  readonly userId: string;
  readonly slot: string;
}

export interface MemoryReviewStateSnapshot {
  readonly query: MemoryReviewStateQuery;
  readonly currentRecords: readonly MemoryVersionRecord[];
  readonly conflict: boolean;
  readonly authorityWatermark: AuthorityWatermark;
}

/** Versioned memory authority record exposed to compiler/repository ports. */
export interface MemoryVersionRecord {
  readonly ref: CanonicalObjectVersionRef;
  readonly userId: string;
  readonly kind: MemoryKind;
  readonly slot: string;
  readonly value: ReadonlyJsonValue;
  /** Owner-resolved, model-safe content; compiler never resolves storage refs. */
  readonly resolvedContent: string;
  readonly status: MemoryStatus;
  readonly current: boolean;
  readonly sourceClass: EvidenceSourceClass;
  readonly evidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly confidencePpm: number;
  readonly allowedPurposeScopes: readonly string[];
  readonly sensitivity: MemorySensitivity;
  readonly validity: MemoryValidity;
  readonly supersedes?: CanonicalObjectVersionRef;
  readonly correctionIntent?: MemoryCorrectionIntent;
  readonly dreamAcceptedDelta?: DreamAcceptedDelta;
  readonly deletedAt?: string;
  readonly suppressedAt?: string;
  readonly stale?: boolean;
  /** Replaceable ranking input. It cannot become authority or output identity. */
  readonly derivedRankScore?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** Required scope and hard budgets for one compiler read. */
export interface CompilerQuery {
  readonly userId: string;
  readonly purposeScope: string;
  readonly asOf: string;
  readonly maxItems: number;
  readonly maxContentBytes: number;
  readonly slot?: string;
  readonly slots?: readonly string[];
  readonly kind?: MemoryKind;
  readonly kinds?: readonly MemoryKind[];
}

/** Point-in-time compiler view plus the authority watermark used to build it. */
export interface MemoryQuerySnapshot {
  readonly query: CompilerQuery;
  readonly records: readonly MemoryVersionRecord[];
  readonly authorityWatermark: unknown;
}

export const MEMORY_COMMIT_OUTCOMES = ["committed", "replayed"] as const;
export type MemoryCommitOutcome = (typeof MEMORY_COMMIT_OUTCOMES)[number];

export const MEMORY_COMMAND_ERROR_CODES = [
  "IDEMPOTENCY_CONFLICT",
  "CURRENT_VERSION_CONFLICT",
  "DELETION_SUCCESSOR_REQUIRED",
  "DELETION_CONFLICT",
  "CANDIDATE_NOT_FOUND",
  "CANDIDATE_STATE_CONFLICT",
  "REVIEW_AUTHORIZATION_INVALID",
  "REVIEW_RESOLUTION_INVALID",
  "OWNER_STATE_INVALID",
  "OWNER_STATE_UNAVAILABLE",
  "INVALID_COMMAND",
  "TRANSACTION_ABORTED",
] as const;
export type MemoryCommandErrorCode = (typeof MEMORY_COMMAND_ERROR_CODES)[number];

export interface MemoryCommandError {
  readonly code: MemoryCommandErrorCode;
  readonly retryable: boolean;
  readonly authorityWatermark?: AuthorityWatermark;
}

export interface MemoryCommitReceipt {
  readonly kind: "memory_commit_receipt";
  readonly operation: "candidate_batch" | "correction";
  readonly outcome: MemoryCommitOutcome;
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
  /** Newly-created refs are exposed only through this receipt. */
  readonly canonicalRefs: readonly CanonicalObjectVersionRef[];
  readonly supersededRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
}

export type MemoryCommandResult<T> =
  | { readonly ok: true; readonly receipt: T }
  | { readonly ok: false; readonly error: MemoryCommandError };

export type MemoryReviewResult = MemoryCommandResult<MemoryReviewReceipt>;

/** T03-owned deletion scope projected into the T05 internal seam. */
export interface DeletionJobScope {
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly scopeManifestSha256: Sha256;
  readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
}

export type AuthorityWatermark = unknown;

export function isConfidencePpm(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

export function assertConfidencePpm(value: unknown): number {
  if (!isConfidencePpm(value)) {
    throw new TypeError("confidencePpm must be an integer between 0 and 1000000");
  }
  return value;
}

export const CONFIDENCE_PPM_SCALE = 1_000_000 as const;
