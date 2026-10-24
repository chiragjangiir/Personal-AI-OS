import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";

export const T05_DELETION_SURFACES = Object.freeze([
  "authoritative_memory",
  "fts",
  "pgvector",
  "graph",
  "cache",
  "compiled_context",
] as const);
export type T05DeletionSurface = (typeof T05_DELETION_SURFACES)[number];

export const T05_DELETION_STAGES = Object.freeze([
  "suppress_authoritative_memory",
  "purge_derived_surfaces",
  "rebuild_current_projection",
] as const);
export type T05DeletionStage = (typeof T05_DELETION_STAGES)[number];

export interface T05DeletionWorkRequest {
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly scopeManifestSha256: Sha256;
  readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: unknown;
  readonly idempotencyKey: string;
  /** Complete T03 policy projection; T02 must execute these fields verbatim. */
  readonly projectedMutations?: readonly T03DeletionMutationProjection[];
}

export interface T05DeletionWorkPlan extends T05DeletionWorkRequest {
  readonly kind: "t05_deletion_work_plan";
  readonly stages: readonly T05DeletionStage[];
  readonly surfaces: readonly T05DeletionSurface[];
  readonly projectedMutations: readonly T03DeletionMutationProjection[];
}

/**
 * T03-owned deletion decision.  T05/T02 may validate shape and persist the
 * projection, but must not infer policy, sign a proof, or alter any field.
 */
export interface T03DeletionMutationProjection {
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly targetRef: CanonicalObjectVersionRef;
  readonly targetStatus: "current" | "superseded" | "disputed" | "suppressed" | "deleted";
  readonly targetCurrent: boolean;
  readonly deleted: boolean;
  readonly suppressed: boolean;
  readonly tombstone: boolean;
  readonly nonResurrection: boolean;
  readonly authorityWatermark: unknown;
}

export interface T05DeletionSurfaceResult {
  readonly surface: T05DeletionSurface;
  readonly remainingQueryableCount: number;
}

export interface T05DeletionWorkResult {
  readonly plan: T05DeletionWorkPlan;
  readonly completedAt: string;
  readonly authorityWatermark: unknown;
  readonly completedStages: readonly T05DeletionStage[];
  readonly surfaceResults: readonly T05DeletionSurfaceResult[];
}

export interface T05DomainDeletionAttestationIntent {
  readonly kind: "domain_deletion_attestation_intent";
  readonly ownerModule: "T05";
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly scopeManifestSha256: Sha256;
  readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
  readonly completedAt: string;
  readonly authorityWatermark: unknown;
  readonly completedStages: readonly T05DeletionStage[];
  readonly surfaceResults: readonly T05DeletionSurfaceResult[];
}

const MEMORY_REF_TYPES = new Set([
  "MemoryCandidate",
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
]);

export function createT05DeletionWorkPlan(
  request: T05DeletionWorkRequest,
): T05DeletionWorkPlan {
  const deletionJobRef = copyTypedRef(request.deletionJobRef, new Set(["DeletionJob"]));
  const targetMemoryRefs = normalizeMemoryRefs(request.targetMemoryRefs);
  if (targetMemoryRefs.length === 0) throw new TypeError("targetMemoryRefs must be nonempty");
  if (request.idempotencyKey.trim().length === 0) {
    throw new TypeError("idempotencyKey must be nonempty");
  }
  const projectedMutations = normalizeProjectedMutations(request.projectedMutations, deletionJobRef, targetMemoryRefs);
  return Object.freeze({
    kind: "t05_deletion_work_plan",
    deletionJobRef,
    scopeManifestSha256: assertSha256(request.scopeManifestSha256),
    targetMemoryRefs,
    authorityWatermark: request.authorityWatermark,
    idempotencyKey: request.idempotencyKey,
    projectedMutations,
    stages: T05_DELETION_STAGES,
    surfaces: T05_DELETION_SURFACES,
  });
}

function normalizeProjectedMutations(
  values: readonly T03DeletionMutationProjection[] | undefined,
  deletionJobRef: CanonicalObjectVersionRef,
  targetRefs: readonly CanonicalObjectVersionRef[],
): readonly T03DeletionMutationProjection[] {
  if (values === undefined) return Object.freeze([]);
  const targets = new Set(targetRefs.map(canonicalRefKey));
  const seen = new Set<string>();
  const normalized = values.map((value) => {
    if (canonicalRefKey(value.deletionJobRef) !== canonicalRefKey(deletionJobRef) ||
        !targets.has(canonicalRefKey(value.targetRef)) ||
        typeof value.targetCurrent !== "boolean" || typeof value.deleted !== "boolean" ||
        typeof value.suppressed !== "boolean" || typeof value.tombstone !== "boolean" ||
        value.nonResurrection !== true ||
        (value.targetStatus === "deleted" && value.deleted !== true) ||
        (value.targetStatus === "suppressed" && value.suppressed !== true) ||
        value.authorityWatermark === undefined || value.authorityWatermark === null) {
      throw new TypeError("invalid T03 deletion mutation projection");
    }
    const key = canonicalRefKey(value.targetRef);
    if (seen.has(key)) throw new TypeError("duplicate T03 deletion mutation projection");
    seen.add(key);
    return Object.freeze({
      deletionJobRef: copyTypedRef(value.deletionJobRef, new Set(["DeletionJob"])),
      targetRef: copyTypedRef(value.targetRef, MEMORY_REF_TYPES),
      targetStatus: value.targetStatus,
      targetCurrent: value.targetCurrent,
      deleted: value.deleted,
      suppressed: value.suppressed,
      tombstone: value.tombstone,
      nonResurrection: value.nonResurrection,
      authorityWatermark: value.authorityWatermark,
    });
  });
  return Object.freeze(normalized);
}

export function createT05DomainDeletionAttestationIntent(
  result: T05DeletionWorkResult,
): T05DomainDeletionAttestationIntent {
  if (typeof result !== "object" || result === null) {
    throw new TypeError("result must be a T05 deletion work result");
  }
  const plan = normalizeWorkPlan(result.plan);
  assertCanonicalInstant(result.completedAt);
  assertExactSet(result.completedStages, T05_DELETION_STAGES, "completedStages");
  const surfaceResults = normalizeSurfaceResults(result.surfaceResults);
  for (const item of surfaceResults) {
    if (item.remainingQueryableCount !== 0) {
      throw new TypeError(`surface ${item.surface} still has queryable residuals`);
    }
  }
  return Object.freeze({
    kind: "domain_deletion_attestation_intent",
    ownerModule: "T05",
    deletionJobRef: plan.deletionJobRef,
    scopeManifestSha256: plan.scopeManifestSha256,
    targetMemoryRefs: plan.targetMemoryRefs,
    completedAt: result.completedAt,
    authorityWatermark: result.authorityWatermark,
    completedStages: T05_DELETION_STAGES,
    surfaceResults,
  });
}

/** Re-validate a supplied plan before it can produce a deletion attestation. */
function normalizeWorkPlan(plan: T05DeletionWorkPlan): T05DeletionWorkPlan {
  if (typeof plan !== "object" || plan === null || plan.kind !== "t05_deletion_work_plan") {
    throw new TypeError("result must reference a T05 deletion work plan");
  }
  assertExactSet(plan.stages, T05_DELETION_STAGES, "plan.stages");
  assertExactSet(plan.surfaces, T05_DELETION_SURFACES, "plan.surfaces");
  return createT05DeletionWorkPlan({
    deletionJobRef: plan.deletionJobRef,
    scopeManifestSha256: plan.scopeManifestSha256,
    targetMemoryRefs: plan.targetMemoryRefs,
      authorityWatermark: plan.authorityWatermark,
      idempotencyKey: plan.idempotencyKey,
      projectedMutations: plan.projectedMutations,
    });
}

function normalizeMemoryRefs(
  values: readonly CanonicalObjectVersionRef[],
): readonly CanonicalObjectVersionRef[] {
  const refs = new Map<string, CanonicalObjectVersionRef>();
  for (const value of values) {
    const ref = copyTypedRef(value, MEMORY_REF_TYPES);
    const key = canonicalRefKey(ref);
    if (refs.has(key)) throw new TypeError(`duplicate target memory ref: ${key}`);
    refs.set(key, ref);
  }
  return Object.freeze([...refs.values()].sort(compareCanonicalObjectVersionRefs));
}

function normalizeSurfaceResults(
  values: readonly T05DeletionSurfaceResult[],
): readonly T05DeletionSurfaceResult[] {
  const results = new Map<T05DeletionSurface, T05DeletionSurfaceResult>();
  for (const value of values) {
    if (!T05_DELETION_SURFACES.includes(value.surface)) {
      throw new TypeError(`unknown T05 deletion surface: ${String(value.surface)}`);
    }
    if (results.has(value.surface)) throw new TypeError(`duplicate surface result: ${value.surface}`);
    if (!Number.isSafeInteger(value.remainingQueryableCount) || value.remainingQueryableCount < 0) {
      throw new TypeError(`invalid residual count for ${value.surface}`);
    }
    results.set(value.surface, Object.freeze({
      surface: value.surface,
      remainingQueryableCount: value.remainingQueryableCount,
    }));
  }
  assertExactSet([...results.keys()], T05_DELETION_SURFACES, "surfaceResults");
  return Object.freeze(T05_DELETION_SURFACES.map((surface) => results.get(surface)!));
}

function assertExactSet<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
  field: string,
): void {
  if (actual.length !== new Set(actual).size) throw new TypeError(`${field} contains duplicates`);
  const actualSet = new Set(actual);
  if (actualSet.size !== expected.length || expected.some((item) => !actualSet.has(item))) {
    throw new TypeError(`${field} does not cover the exact required set`);
  }
}

function copyTypedRef(
  value: CanonicalObjectVersionRef,
  allowedTypes: ReadonlySet<string>,
): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  if (!allowedTypes.has(ref.refType)) throw new TypeError(`disallowed ref type: ${ref.refType}`);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function assertCanonicalInstant(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}|\d{6}))?Z$/.exec(value);
  if (match === null) {
    throw new TypeError("completedAt must be a canonical UTC instant");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new TypeError("completedAt must be a canonical UTC instant");
  }
}
