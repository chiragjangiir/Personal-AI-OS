import {
  canonicalRefKey,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "./canonical-ref.ts";
import {
  EVIDENCE_SOURCE_CLASSES,
  isConfidencePpm,
  type EvidenceSourceClass,
  type MemoryCandidateProposal,
  type MemoryCandidateIntent,
  type MemoryCorrectionIntent,
  type MemoryKind,
  type ReadonlyJsonValue,
} from "./domain.ts";

/** The model-inference quarantine boundary is fixed in ppm. */
export const DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM = 900_000;

export type AdmissionStatus = "candidate" | "quarantine" | "reject";

/**
 * This is narrower than the extraction proposal. A value cannot enter the
 * gate until its evidence, source, confidence and idempotency are present.
 */
export interface MemoryAdmissionProposal extends MemoryCandidateProposal {
  readonly idempotencyKey: string;
  readonly memoryKind?: MemoryKind;
  readonly conflict?: ReadonlyJsonValue;
  readonly externalInstruction?: boolean;
  readonly identityInference?: boolean;
}

/** Structured candidate payload; it has no accepted-fact status. */
export interface AdmittedMemoryCandidateIntent extends MemoryCandidateIntent {
  readonly kind: "create" | "correct";
  readonly status: "candidate";
  readonly proposalId: string;
  readonly slot: string;
  readonly value: ReadonlyJsonValue;
  readonly evidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly sourceClass: EvidenceSourceClass;
  readonly confidencePpm: number;
  readonly idempotencyKey: string;
  readonly conflict?: ReadonlyJsonValue;
  readonly current: false;
  readonly memoryKind: MemoryKind;
  readonly userId: string;
  readonly purposeScopes: readonly string[];
  readonly sensitivity: MemoryCandidateProposal["sensitivity"];
  readonly validity: MemoryCandidateProposal["validity"];
  readonly correctionIntent?: MemoryCorrectionIntent;
}

export interface AdmissionCandidateResult {
  readonly status: "candidate";
  readonly kind: "candidate";
  readonly intent: AdmittedMemoryCandidateIntent;
}

export interface AdmissionDisposition {
  readonly status: Exclude<AdmissionStatus, "candidate">;
  readonly kind: Exclude<AdmissionStatus, "candidate">;
  readonly reasonCode: string;
  readonly reason: string;
}

export type AdmissionResult = AdmissionCandidateResult | AdmissionDisposition;

/** Ref types that can be evidence for a Phase-1 memory candidate. */
export const ADMISSIBLE_EVIDENCE_REF_TYPES = Object.freeze([
  "Observation",
  "ToolResultArtifact",
  "FinalTranscriptEvidence",
  "TextEvidence",
  "EvidenceSpan",
] as const);

/** A correction may also carry the versioned memory object it corrects. */
export const ADMISSIBLE_USER_CORRECTION_REF_TYPES = Object.freeze([
  "MemoryCandidate",
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
] as const);

type AdmissibleEvidenceRefType = (typeof ADMISSIBLE_EVIDENCE_REF_TYPES)[number];

function isAdmissibleEvidenceRef(
  value: CanonicalObjectVersionRef,
): value is CanonicalObjectVersionRef & { readonly refType: AdmissibleEvidenceRefType } {
  return (ADMISSIBLE_EVIDENCE_REF_TYPES as readonly string[]).includes(value.refType);
}

function isAdmissibleUserCorrectionRef(value: CanonicalObjectVersionRef): boolean {
  return (ADMISSIBLE_USER_CORRECTION_REF_TYPES as readonly string[]).includes(value.refType);
}

const CANONICAL_REF_KEYS = [
  "refType",
  "refId",
  "objectVersion",
  "canonicalPayloadSha256",
] as const;

const INTENT_KEYS = ["kind", "target"] as const;
const CORRECTION_INTENT_KEYS = ["kind", "target", "reason", "evidenceRefs"] as const;
const SENSITIVITY_KEYS = ["classification", "userConfirmed"] as const;
const VALIDITY_KEYS = ["validFrom", "validTo", "observedAt"] as const;

type PlainRecord = Record<string, unknown>;

function safeOwnDataKeys(value: object): readonly string[] | undefined {
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const names = Object.getOwnPropertyNames(value);
    const enumerableNames = Object.keys(value);
    if (names.length !== enumerableNames.length) return undefined;
    const enumerableSet = new Set(enumerableNames);
    for (const name of names) {
      if (!enumerableSet.has(name)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) {
        return undefined;
      }
    }
    return names;
  } catch {
    return undefined;
  }
}

function isSafePlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    safeOwnDataKeys(value) !== undefined;
}

function hasOnlyKeys(value: unknown, allowedKeys: readonly string[]): value is PlainRecord {
  if (!isSafePlainRecord(value)) return false;
  const keys = safeOwnDataKeys(value)!;
  const allowed = new Set(allowedKeys);
  return keys.every((key) => allowed.has(key));
}

function hasExactKeys(value: unknown, expectedKeys: readonly string[]): value is PlainRecord {
  if (!hasOnlyKeys(value, expectedKeys)) return false;
  const keys = safeOwnDataKeys(value)!;
  const expected = new Set(expectedKeys);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSafeArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const names = Object.getOwnPropertyNames(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        lengthDescriptor.enumerable !== false) {
      return false;
    }
    const indexNames = names.filter((name) => name !== "length");
    if (indexNames.length !== value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      const name = String(index);
      if (!hasOwn(value, name) || !indexNames.includes(name)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isReadonlyJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): value is ReadonlyJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (isSafeArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isReadonlyJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (!isSafePlainRecord(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = safeOwnDataKeys(value)!.every((key) =>
    isReadonlyJsonValue(Object.getOwnPropertyDescriptor(value, key)!.value, ancestors));
  ancestors.delete(value);
  return valid;
}

function cloneJsonValue<T extends ReadonlyJsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneJsonValue(item));
    return Object.freeze(result) as unknown as T;
  }
  const result: Record<string, ReadonlyJsonValue> = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneJsonValue(child);
  return Object.freeze(result) as T;
}

function isSafeCanonicalRef(value: unknown): value is CanonicalObjectVersionRef {
  return hasExactKeys(value, CANONICAL_REF_KEYS) && isCanonicalObjectVersionRef(value);
}

function cloneRef(ref: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  if (!isSafeCanonicalRef(ref)) throw new TypeError("invalid canonical reference");
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function cloneJsonRecord<T extends object>(value: T): T {
  return cloneJsonValue(value as unknown as ReadonlyJsonValue) as unknown as T;
}

function cloneCorrectionIntent(
  correction: MemoryCorrectionIntent,
): MemoryCorrectionIntent {
  return Object.freeze({
    kind: correction.kind,
    target: cloneRef(correction.target),
    ...(hasOwn(correction, "reason")
      ? { reason: cloneJsonValue(correction.reason!) }
      : {}),
    ...(hasOwn(correction, "evidenceRefs")
      ? { evidenceRefs: Object.freeze(correction.evidenceRefs!.map(cloneRef)) }
      : {}),
  });
}

function candidateIntent(proposal: MemoryAdmissionProposal): AdmittedMemoryCandidateIntent {
  const intent: AdmittedMemoryCandidateIntent = {
    kind: proposal.intent.kind === "correct" ? "correct" : "create",
    status: "candidate",
    proposalId: proposal.proposalId.trim(),
    current: false,
    userId: proposal.userId.trim(),
    slot: proposal.slot,
    value: cloneJsonValue(proposal.value),
    memoryKind: proposal.kind,
    evidenceRefs: Object.freeze(proposal.evidenceRefs.map(cloneRef)),
    sourceClass: proposal.sourceClass,
    confidencePpm: proposal.confidencePpm,
    idempotencyKey: proposal.idempotencyKey,
    purposeScopes: Object.freeze(proposal.purposeScopes.map((scope) => scope.trim())),
    sensitivity: cloneJsonRecord(proposal.sensitivity),
    validity: cloneJsonRecord(proposal.validity),
    ...(proposal.intent.kind === "correct"
      ? {
          target: cloneRef(
            proposal.intent.target ?? proposal.correctionIntent!.target,
          ),
        }
      : {}),
    ...(proposal.correctionIntent === undefined ? {} : {
      correctionIntent: cloneCorrectionIntent(proposal.correctionIntent),
    }),
  };
  const completed = hasOwn(proposal, "conflict")
    ? { ...intent, conflict: cloneJsonValue(proposal.conflict!) }
    : intent;
  return Object.freeze(completed);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validPurposeScopes(value: unknown): value is readonly string[] {
  return isSafeArray(value) && value.length > 0 && value.every(isNonEmptyString) &&
    new Set(value.map((scope) => scope.trim())).size === value.length;
}

function validSensitivity(value: unknown): value is MemoryCandidateProposal["sensitivity"] {
  if (!hasExactKeys(value, SENSITIVITY_KEYS)) return false;
  const record = value as Record<string, unknown>;
  return (record.classification === "normal" || record.classification === "sensitive") &&
    typeof record.userConfirmed === "boolean";
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validValidity(value: MemoryCandidateProposal["validity"]): boolean {
  if (!hasOnlyKeys(value, VALIDITY_KEYS)) return false;
  const record = value as Record<string, unknown>;
  const validShape = (!hasOwn(record, "validFrom") || validInstant(record.validFrom)) &&
    (!hasOwn(record, "validTo") || validInstant(record.validTo)) &&
    (!hasOwn(record, "observedAt") || validInstant(record.observedAt));
  if (!validShape) return false;
  return !hasOwn(record, "validFrom") || !hasOwn(record, "validTo") ||
    Date.parse(record.validFrom as string) <= Date.parse(record.validTo as string);
}

function safeCandidateIntentShape(value: unknown): value is MemoryCandidateIntent {
  if (!hasOnlyKeys(value, INTENT_KEYS) || !hasOwn(value, "kind")) return false;
  const record = value as PlainRecord;
  return !hasOwn(value, "target") || isSafeCanonicalRef(record.target);
}

function validCorrectionIntentShape(value: unknown): value is MemoryCorrectionIntent {
  if (!hasOnlyKeys(value, CORRECTION_INTENT_KEYS) ||
      !hasOwn(value, "kind") || !hasOwn(value, "target")) {
    return false;
  }
  const record = value as PlainRecord;
  if (record.kind !== "correct" || !isSafeCanonicalRef(record.target) ||
      !isAdmissibleUserCorrectionRef(record.target)) {
    return false;
  }
  if (hasOwn(value, "reason") && !isReadonlyJsonValue(record.reason)) return false;
  if (hasOwn(value, "evidenceRefs")) {
    if (!isSafeArray(record.evidenceRefs) ||
        record.evidenceRefs.some((ref) => !isSafeCanonicalRef(ref))) {
      return false;
    }
    const keys = record.evidenceRefs.map(canonicalRefKey);
    if (new Set(keys).size !== keys.length) return false;
  }
  return true;
}

function disposition(
  status: Exclude<AdmissionStatus, "candidate">,
  reasonCode: string,
  reason: string,
): AdmissionDisposition {
  return { status, kind: status, reasonCode, reason };
}

/**
 * Admit evidence into a candidate intent. The gate cannot emit `accepted`,
 * `confirmed`, or another durable-fact status.
 */
export function admitMemoryProposal(
  proposal: MemoryAdmissionProposal,
  options: { readonly modelConfidenceThresholdPpm?: number } = {},
): AdmissionResult {
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) {
    return disposition("reject", "INVALID_PROPOSAL", "proposal must be an object");
  }
  if (!isSafePlainRecord(proposal)) {
    return disposition("reject", "INVALID_PROPOSAL", "proposal must contain only enumerable data properties");
  }
  if (!isNonEmptyString(proposal.proposalId)) {
    return disposition("reject", "INVALID_PROPOSAL_ID", "proposalId must be a non-empty string");
  }
  if (!isNonEmptyString(proposal.userId)) {
    return disposition("reject", "INVALID_USER_ID", "userId must be a non-empty string");
  }
  if (typeof proposal.slot !== "string" || proposal.slot.trim().length === 0) {
    return disposition("reject", "INVALID_SLOT", "slot must be a non-empty string");
  }
  if (!isReadonlyJsonValue(proposal.value)) {
    return disposition("reject", "INVALID_VALUE", "value must be JSON-compatible");
  }
  if (!isConfidencePpm(proposal.confidencePpm)) {
    return disposition("reject", "INVALID_CONFIDENCE", "confidencePpm must be an integer from 0 to 1000000");
  }
  if (!(EVIDENCE_SOURCE_CLASSES as readonly string[]).includes(proposal.sourceClass)) {
    return disposition("reject", "INVALID_SOURCE_CLASS", "sourceClass is outside the governed precedence set");
  }
  if ((proposal.externalInstruction !== undefined && typeof proposal.externalInstruction !== "boolean") ||
      (proposal.identityInference !== undefined && typeof proposal.identityInference !== "boolean")) {
    return disposition("reject", "INVALID_PROVENANCE_FLAG", "provenance quarantine flags must be booleans");
  }
  if (typeof proposal.idempotencyKey !== "string" || proposal.idempotencyKey.trim().length === 0) {
    return disposition("reject", "MISSING_IDEMPOTENCY_KEY", "idempotencyKey is required");
  }
  if (!validPurposeScopes(proposal.purposeScopes)) {
    return disposition("reject", "INVALID_PURPOSE_SCOPE", "at least one non-empty purpose scope is required");
  }
  if (!validSensitivity(proposal.sensitivity)) {
    return disposition("reject", "INVALID_SENSITIVITY", "sensitivity requires classification and confirmation state");
  }
  if (!validValidity(proposal.validity)) {
    return disposition("reject", "INVALID_VALIDITY", "validity values must be canonical UTC instants");
  }
  if (!safeCandidateIntentShape(proposal.intent)) {
    return disposition("reject", "INVALID_INTENT", "candidate intent must be a structured object");
  }
  if (hasOwn(proposal, "conflict") && !isReadonlyJsonValue(proposal.conflict)) {
    return disposition("reject", "INVALID_CONFLICT", "conflict must be JSON-compatible");
  }
  if (hasOwn(proposal, "correctionIntent")) {
    if (!validCorrectionIntentShape(proposal.correctionIntent)) {
      return disposition("reject", "INVALID_CORRECTION_INTENT", "correction intent must contain one safe, versioned target");
    }
    if (proposal.intent.kind === "create") {
      return disposition("reject", "INVALID_CORRECTION_INTENT", "create intents cannot carry a correction intent");
    }
  }
  if (proposal.intent.kind === "correct" && !hasOwn(proposal, "correctionIntent")) {
    return disposition("reject", "MISSING_CORRECTION_TARGET", "correction candidates require an exact supersedes target");
  }
  if (!isSafeArray(proposal.evidenceRefs) || proposal.evidenceRefs.length === 0) {
    return disposition("reject", "MISSING_EVIDENCE", "at least one evidence reference is required");
  }
  if (proposal.evidenceRefs.some((ref) => !isSafeCanonicalRef(ref))) {
    return disposition("reject", "INVALID_CANONICAL_REF", "every evidence reference must be a versioned canonical object reference");
  }
  const evidenceKeys = proposal.evidenceRefs.map(canonicalRefKey);
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    return disposition("reject", "DUPLICATE_EVIDENCE_REF", "evidence references must be unique");
  }
  if (proposal.evidenceRefs.some((ref) => !isAdmissibleEvidenceRef(ref) &&
      !(proposal.sourceClass === "explicit_user_correction" && isAdmissibleUserCorrectionRef(ref)))) {
    return disposition("reject", "UNSUPPORTED_EVIDENCE_REF", "only Observation, ToolResultArtifact, FinalTranscriptEvidence, TextEvidence, or EvidenceSpan refs are admissible");
  }

  const threshold = options.modelConfidenceThresholdPpm ?? DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1_000_000) {
    return disposition("reject", "INVALID_CONFIDENCE_THRESHOLD", "model confidence threshold is outside the ppm scale");
  }
  if (proposal.externalInstruction === true) {
    return disposition("quarantine", "EXTERNAL_INSTRUCTION", "external instructions cannot become memory");
  }
  if (proposal.identityInference === true) {
    return disposition("quarantine", "IDENTITY_INFERENCE", "identity inference requires quarantine");
  }
  if (proposal.confidencePpm < threshold) {
    return disposition("quarantine", "LOW_CONFIDENCE_MODEL_INFERENCE", `${proposal.sourceClass} confidence is below ${threshold}ppm`);
  }

  if (proposal.intent.kind !== "create" && proposal.intent.kind !== "correct") {
    return disposition("reject", "DIRECT_ACCEPTED_FACT", "admission can only emit create or correct candidate intents");
  }
  if (proposal.intent.kind === "correct" &&
      proposal.sourceClass !== "explicit_user_correction") {
    return disposition("reject", "INVALID_CORRECTION_SOURCE", "correction intents require explicit user correction evidence");
  }
  if (hasOwn(proposal.intent, "target")) {
    if (!evidenceKeys.includes(canonicalRefKey(proposal.intent.target))) {
      return disposition("reject", "INTENT_TARGET_NOT_EVIDENCED", "intent target must be one of the evidence references");
    }
  }
  if (proposal.intent.kind === "correct" && hasOwn(proposal.intent, "target")) {
    if (canonicalRefKey(proposal.intent.target) !== canonicalRefKey(proposal.correctionIntent!.target)) {
      return disposition("reject", "CORRECTION_TARGET_MISMATCH", "intent and correction target must identify the same version");
    }
  }
  if (proposal.intent.kind === "correct" &&
      !evidenceKeys.includes(canonicalRefKey(proposal.correctionIntent!.target))) {
    return disposition("reject", "CORRECTION_TARGET_NOT_EVIDENCED", "correction target must be included in evidence references");
  }

  const intent = candidateIntent({ ...proposal, slot: proposal.slot.trim(), idempotencyKey: proposal.idempotencyKey.trim() });
  return { status: "candidate", kind: "candidate", intent };
}
