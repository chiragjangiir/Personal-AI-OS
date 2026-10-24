import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
  type PositiveVersion,
} from "./canonical-ref.ts";
import {
  SOURCE_PRECEDENCE,
  type EvidenceSourceClass,
  type MemoryCandidateIntent,
  type MemoryCorrectionIntent,
  type MemoryKind,
  type MemorySensitivity,
  type MemoryValidity,
  type ReadonlyJsonValue,
} from "./domain.ts";
import {
  ADMISSIBLE_EVIDENCE_REF_TYPES,
  ADMISSIBLE_USER_CORRECTION_REF_TYPES,
  type AdmittedMemoryCandidateIntent,
} from "./admission.ts";

export type ConflictStatus = "resolved" | "requires_review" | "reject";

/** Candidate shape accepted by the conflict gate. */
export interface MemoryConflictCandidate extends MemoryCandidateIntent {
  readonly proposalId: string;
  readonly kind: "create" | "correct";
  readonly status?: "candidate" | "current" | "superseded";
  readonly current?: boolean;
  readonly userId: string;
  readonly slot: string;
  readonly value: ReadonlyJsonValue;
  readonly memoryKind?: MemoryKind;
  readonly evidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly sourceClass: EvidenceSourceClass;
  readonly confidencePpm: number;
  readonly idempotencyKey: string;
  /** Present only after the candidate has an authoritative memory object version. */
  readonly memoryRef?: CanonicalObjectVersionRef;
  readonly proposedObjectVersion?: PositiveVersion;
  readonly supersedes?: CanonicalObjectVersionRef;
  readonly supersededByProposalId?: string;
  readonly conflict?: ReadonlyJsonValue;
  readonly purposeScopes: readonly string[];
  readonly sensitivity: MemorySensitivity;
  readonly validity: MemoryValidity;
}

export interface CorrectionIntent extends MemoryConflictCandidate {
  readonly kind: "correct";
  readonly status: "candidate";
  readonly current: false;
  readonly proposedObjectVersion: PositiveVersion;
  readonly supersedes: CanonicalObjectVersionRef;
  readonly correctionIntent: MemoryCorrectionIntent;
}

export interface ConflictResolution {
  readonly status: ConflictStatus;
  readonly resolution: "resolved" | "correction" | "unresolved" | "reject";
  readonly winner?: MemoryConflictCandidate;
  readonly intent?: MemoryConflictCandidate;
  readonly current: readonly MemoryConflictCandidate[];
  readonly superseded: readonly MemoryConflictCandidate[];
  readonly candidates: readonly MemoryConflictCandidate[];
  readonly requiresReview: boolean;
  readonly averaged: false;
  readonly reasonCode?: string;
  readonly reason?: string;
}

export interface MemoryConflictSet {
  readonly current: MemoryConflictCandidate;
  readonly incoming: MemoryConflictCandidate;
}

const MEMORY_REF_TYPES = new Set([
  "MemoryCandidate",
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
]);

const MEMORY_REF_TYPE_BY_KIND: Readonly<Record<MemoryKind, string>> = {
  semantic_fact: "SemanticFact",
  episodic_memory: "EpisodicMemory",
  preference_memory: "PreferenceMemory",
  open_loop: "OpenLoop",
};

function isMemoryRef(value: unknown): value is CanonicalObjectVersionRef {
  return isCanonicalObjectVersionRef(value) && MEMORY_REF_TYPES.has(value.refType);
}

function isEvidenceRef(candidate: MemoryConflictCandidate, value: unknown): value is CanonicalObjectVersionRef {
  if (!isCanonicalObjectVersionRef(value)) return false;
  if ((ADMISSIBLE_EVIDENCE_REF_TYPES as readonly string[]).includes(value.refType)) return true;
  return candidate.sourceClass === "explicit_user_correction" &&
    (ADMISSIBLE_USER_CORRECTION_REF_TYPES as readonly string[]).includes(value.refType);
}

function memoryRefMatchesKind(candidate: MemoryConflictCandidate): boolean {
  if (candidate.memoryRef === undefined) return true;
  return candidate.memoryRef.refType === "MemoryCandidate" ||
    (candidate.memoryKind !== undefined && MEMORY_REF_TYPE_BY_KIND[candidate.memoryKind] === candidate.memoryRef.refType);
}

function lifecycleConsistent(candidate: MemoryConflictCandidate): boolean {
  if (candidate.status === "current") {
    return candidate.current === true && isMemoryRef(candidate.memoryRef);
  }
  if (candidate.status === "superseded") {
    return candidate.current === false;
  }
  if (candidate.current === true) return false;
  return candidate.status !== "candidate" || candidate.current === false || candidate.current === undefined;
}

function correctionShapeConsistent(candidate: MemoryConflictCandidate): boolean {
  if (candidate.kind !== "correct") return true;
  const correction = candidate.correctionIntent;
  return candidate.sourceClass === "explicit_user_correction" &&
    correction !== undefined &&
    correction.kind === "correct" &&
    isMemoryRef(correction.target) &&
    (candidate.supersedes === undefined ||
      (isMemoryRef(candidate.supersedes) &&
        canonicalRefKey(correction.target) === canonicalRefKey(candidate.supersedes))) &&
    candidate.evidenceRefs.some((ref) => canonicalRefKey(ref) === canonicalRefKey(correction.target));
}

function cloneJson<T extends ReadonlyJsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as unknown as T;
  const result: Record<string, ReadonlyJsonValue> = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
  return result as T;
}

function cloneRef(ref: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  return { ...ref };
}

function cloneCandidate(candidate: MemoryConflictCandidate): MemoryConflictCandidate {
  return {
    ...candidate,
    value: cloneJson(candidate.value),
    evidenceRefs: candidate.evidenceRefs.map(cloneRef),
    purposeScopes: candidate.purposeScopes.slice(),
    ...(candidate.memoryRef === undefined ? {} : { memoryRef: cloneRef(candidate.memoryRef) }),
    ...(candidate.conflict === undefined ? {} : { conflict: cloneJson(candidate.conflict) }),
    ...(candidate.supersedes === undefined ? {} : { supersedes: cloneRef(candidate.supersedes) }),
  };
}

function sameValue(left: ReadonlyJsonValue, right: ReadonlyJsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]!));
  }
  const leftRecord = left as Record<string, ReadonlyJsonValue>;
  const rightRecord = right as Record<string, ReadonlyJsonValue>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key]!, rightRecord[key]!));
}

function validCandidate(candidate: MemoryConflictCandidate): boolean {
  return candidate !== undefined && candidate !== null && typeof candidate === "object" &&
    typeof candidate.proposalId === "string" && candidate.proposalId.trim().length > 0 &&
    typeof candidate.slot === "string" && candidate.slot.trim().length > 0 &&
    Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.length > 0 &&
    candidate.evidenceRefs.every((ref) => isEvidenceRef(candidate, ref)) &&
    typeof candidate.userId === "string" && candidate.userId.trim().length > 0 &&
    typeof candidate.sourceClass === "string" &&
    Object.prototype.hasOwnProperty.call(SOURCE_PRECEDENCE, candidate.sourceClass) &&
    Number.isInteger(candidate.confidencePpm) && candidate.confidencePpm >= 0 && candidate.confidencePpm <= 1_000_000 &&
    typeof candidate.idempotencyKey === "string" && candidate.idempotencyKey.trim().length > 0 &&
    (candidate.memoryRef === undefined || isMemoryRef(candidate.memoryRef)) &&
    memoryRefMatchesKind(candidate) &&
    lifecycleConsistent(candidate) &&
    correctionShapeConsistent(candidate);
}

function nextVersion(ref: CanonicalObjectVersionRef): PositiveVersion {
  const version = String(ref.objectVersion);
  if (!/^[1-9][0-9]*$/.test(version)) throw new TypeError("invalid canonical object version");
  const digits = version.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const next = Number(digits[index]) + carry;
    digits[index] = String(next % 10);
    carry = next >= 10 ? 1 : 0;
  }
  if (carry === 1) digits.unshift("1");
  return digits.join("") as PositiveVersion;
}

function markSuperseded(candidate: MemoryConflictCandidate, byProposalId: string): MemoryConflictCandidate {
  return {
    ...cloneCandidate(candidate),
    status: "superseded",
    current: false,
    supersededByProposalId: byProposalId,
  };
}

/** Create a higher-version intent bound to the exact old reference. */
export function createCorrectionIntent(
  replacement: MemoryConflictCandidate | AdmittedMemoryCandidateIntent,
  superseded: MemoryConflictCandidate | CanonicalObjectVersionRef,
): CorrectionIntent {
  const replacementCandidate = replacement as MemoryConflictCandidate;
  const oldRef = isCanonicalObjectVersionRef(superseded)
    ? superseded
    : superseded.memoryRef;
  if (!validCandidate(replacementCandidate) || !isMemoryRef(oldRef)) {
    throw new TypeError("createCorrectionIntent requires valid candidates and a versioned supersedes reference");
  }
  if (!isCanonicalObjectVersionRef(superseded)) {
    if (replacementCandidate.userId !== superseded.userId || replacementCandidate.slot !== superseded.slot) {
      throw new TypeError("correction replacement must match the superseded user and slot");
    }
  }
  const supersedes = cloneRef(assertCanonicalObjectVersionRef(oldRef));
  const replacementSnapshot = cloneCandidate(replacementCandidate);
  const {
    memoryRef: _memoryRef,
    status: _status,
    current: _current,
    proposedObjectVersion: _proposedObjectVersion,
    supersedes: _supersedes,
    supersededByProposalId: _supersededByProposalId,
    correctionIntent: _correctionIntent,
    ...proposedBase
  } = replacementSnapshot;
  return {
    ...proposedBase,
    kind: "correct",
    status: "candidate",
    current: false,
    proposedObjectVersion: nextVersion(supersedes),
    supersedes,
    correctionIntent: {
      kind: "correct",
      target: supersedes,
      evidenceRefs: replacementCandidate.evidenceRefs.map(cloneRef),
    },
    idempotencyKey: replacementCandidate.idempotencyKey,
  };
}

function invalidResult(
  candidates: readonly MemoryConflictCandidate[],
  reasonCode: string,
  reason: string,
  status: ConflictStatus = "reject",
): ConflictResolution {
  const current = status === "requires_review" && reasonCode === "SAME_PRECEDENCE_CONFLICT"
    ? candidates
      .filter((candidate) => candidate.status === "current" && candidate.current === true && isMemoryRef(candidate.memoryRef))
      .map(cloneCandidate)
    : [];
  return {
    status,
    resolution: status === "requires_review" ? "unresolved" : "reject",
    candidates: candidates.map((candidate) => validCandidate(candidate) ? cloneCandidate(candidate) : candidate),
    current,
    superseded: [],
    requiresReview: status === "requires_review",
    averaged: false,
    reasonCode,
    reason,
  };
}

function asCandidates(
  left: readonly MemoryConflictCandidate[] | MemoryConflictCandidate | MemoryConflictSet,
  right?: MemoryConflictCandidate,
): MemoryConflictCandidate[] {
  if (Array.isArray(left)) return [...left];
  if ("current" in left && "incoming" in left) return [left.current, left.incoming];
  const single = left as MemoryConflictCandidate;
  return right === undefined ? [single] : [single, right];
}

/** Resolve candidates with exact precedence and no averaging. */
export function resolveMemoryConflict(
  left: readonly MemoryConflictCandidate[] | MemoryConflictCandidate | MemoryConflictSet,
  right?: MemoryConflictCandidate,
): ConflictResolution {
  const candidates = asCandidates(left, right);
  if (candidates.length === 0) return invalidResult(candidates, "NO_CANDIDATES", "at least one candidate is required");
  if (candidates.some((candidate) => !validCandidate(candidate))) {
    return invalidResult(candidates, "INVALID_CANDIDATE", "conflict candidates require valid canonical refs, evidence, and idempotency");
  }
  const slots = new Set(candidates.map((candidate) => candidate.slot));
  if (slots.size !== 1) return invalidResult(candidates, "SLOT_MISMATCH", "different slots cannot be resolved together", "requires_review");
  const users = new Set(candidates.map((candidate) => candidate.userId));
  if (users.size !== 1) return invalidResult(candidates, "USER_MISMATCH", "different users cannot be resolved together", "requires_review");

  const maxPrecedence = Math.max(...candidates.map((candidate) => SOURCE_PRECEDENCE[candidate.sourceClass]));
  const top = candidates.filter((candidate) => SOURCE_PRECEDENCE[candidate.sourceClass] === maxPrecedence);
  const topValues: MemoryConflictCandidate[] = [];
  for (const candidate of top) {
    if (!topValues.some((existing) => sameValue(existing.value, candidate.value))) topValues.push(candidate);
  }
  if (topValues.length > 1) {
    return invalidResult(candidates, "SAME_PRECEDENCE_CONFLICT", "same-precedence different values require review", "requires_review");
  }

  const winner = top[0]!;
  const lowerDifferent = candidates.filter((candidate) => candidate !== winner && !sameValue(candidate.value, winner.value));
  if (lowerDifferent.length === 0) {
    const resolvedWinner = cloneCandidate(winner);
    const authoritativeCurrent = candidates.find((candidate) =>
      candidate.status === "current" && candidate.current === true && isMemoryRef(candidate.memoryRef));
    const current = authoritativeCurrent === undefined ? [] : [cloneCandidate(authoritativeCurrent)];
    return {
      status: "resolved",
      resolution: "resolved",
      winner: resolvedWinner,
      intent: resolvedWinner,
      current,
      superseded: [],
      candidates: candidates.map(cloneCandidate),
      requiresReview: false,
      averaged: false,
    };
  }

  const authoritativeCurrent = candidates.filter((candidate) =>
    candidate.status === "current" && candidate.current === true && isMemoryRef(candidate.memoryRef));
  if (authoritativeCurrent.length !== 1) {
    return invalidResult(candidates, "CURRENT_VERSION_REQUIRED", "a correction requires exactly one authoritative current version", "requires_review");
  }
  if (winner === authoritativeCurrent[0]) {
    const retained = cloneCandidate(winner);
    return {
      status: "resolved",
      resolution: "resolved",
      winner: retained,
      intent: retained,
      current: [retained],
      superseded: [],
      candidates: candidates.map(cloneCandidate),
      requiresReview: false,
      averaged: false,
    };
  }
  const correction = createCorrectionIntent(winner, authoritativeCurrent[0]!);
  const superseded = [markSuperseded(authoritativeCurrent[0]!, correction.proposalId)];
  const history = [correction, ...superseded];
  return {
    status: "resolved",
    resolution: "correction",
    winner: correction,
    intent: correction,
    current: [],
    superseded,
    candidates: history,
    requiresReview: false,
    averaged: false,
  };
}

/** A read helper that never returns a superseded candidate. */
export function retrieveCurrentMemoryCandidates(
  candidates: readonly MemoryConflictCandidate[],
): readonly MemoryConflictCandidate[] {
  return candidates
    .filter((candidate) => candidate.status === "current" && candidate.current === true &&
      candidate.supersededByProposalId === undefined && isMemoryRef(candidate.memoryRef))
    .map(cloneCandidate);
}
