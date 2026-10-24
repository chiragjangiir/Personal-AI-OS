import { createHash } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  assertCanonicalUtcInstant,
  type AuthorityWatermark,
  type CanonicalUtcInstant,
  type DeletionJobScope,
} from "./domain.ts";
import {
  assertProductionMemoryIssuerReceipt,
  canonicalPayloadHash,
} from "./canonical-issuer.ts";
import {
  createT05DeletionWorkPlan,
  createT05DomainDeletionAttestationIntent,
  T05_DELETION_STAGES,
  T05_DELETION_SURFACES,
  type T05DeletionSurfaceResult,
  type T05DeletionWorkPlan,
  type T05DomainDeletionAttestationIntent,
  type T03DeletionMutationProjection,
} from "./deletion-attestation-adapter.ts";
import {
  createMemoryRebuildRequestManifest,
  createMemoryRebuildResultManifest,
  REBUILD_PROJECTION_KINDS,
  type DerivedProjectionConfig,
  type MemoryRebuildRequestManifest,
  type MemoryRebuildResultManifest,
  type RebuiltProjectionResult,
} from "./rebuild-manifest.ts";
import type {
  DeletionJobReader,
  DerivedPurgeResult,
  AuthoritativeSuppressionResult,
  OwnerPortResult,
  MemoryCanonicalDeletionLifecycle,
  MemoryDeletionSuccessorReceipt,
  MemoryCanonicalVersionRead,
  T05DeletionRuntime,
  T13SourceReferenceReader,
} from "./ports.ts";
import { assertMemoryCanonicalVersionRead } from "./ports.ts";

export type DeletionRebuildStatus =
  | "completed"
  | "replayed"
  | "conflict"
  | "rejected"
  | "failed";

export type DeletionRebuildStage =
  | "request"
  | "scope"
  | "suppression"
  | "purge"
  | "enumerate"
  | "manifest"
  | "rebuild"
  | "attestation"
  | "replayed";

export const DELETION_REBUILD_ERROR_CODES = [
  "INVALID_REQUEST",
  "JOB_REF_MISMATCH",
  "SCOPE_HASH_MISMATCH",
  "SCOPE_TARGET_INVALID",
  "SCOPE_WATERMARK_MISSING",
  "SCOPE_WATERMARK_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "LEDGER_IN_PROGRESS",
  "LEDGER_UNAVAILABLE",
  "OWNER_STATE_UNAVAILABLE",
  "SUPPRESSION_FAILED",
  "PURGE_FAILED",
  "SURFACE_RESIDUAL",
  "SOURCE_ENUMERATION_FAILED",
  "SOURCE_REF_INVALID",
  "DELETED_SOURCE_CONSUMED",
  "DELETED_SOURCE_NOT_SKIPPED",
  "PARTITION_INCOMPLETE",
  "REBUILD_MANIFEST_INVALID",
  "REBUILD_FAILED",
  "REBUILD_RESULT_INVALID",
  "ATTESTATION_INVALID",
] as const;
export type DeletionRebuildErrorCode = (typeof DELETION_REBUILD_ERROR_CODES)[number];

export interface DeletionRebuildRequest {
  readonly requestId: string;
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly expectedScopeManifestSha256: Sha256;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly projections: readonly DerivedProjectionConfig[];
}

/** The runner adds the source partition absent from the generic rebuild port. */
export interface DeletionRebuildProjectionResult {
  readonly completedAt: CanonicalUtcInstant;
  readonly authorityWatermark: AuthorityWatermark;
  readonly projectionResults: readonly RebuiltProjectionResult[];
  readonly consumedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly skippedDeletedSourceRefs: readonly CanonicalObjectVersionRef[];
  /** T03/T13 overlay refs used only to prevent deleted-source resurrection. */
  readonly deletedSourceRefs: readonly CanonicalObjectVersionRef[];
}

/** Non-wire T05 adapter around the generic projection rebuilder. */
export interface DeletionRebuildProjectionRunner {
  rebuild(input: {
    readonly request: MemoryRebuildRequestManifest;
    readonly sourceArtifactRefs: readonly CanonicalObjectVersionRef[];
  }): Promise<OwnerPortResult<DeletionRebuildProjectionResult>>;
}

export interface DeletionRebuildLedgerEntry {
  readonly fingerprint: Sha256;
  readonly result: DeletionRebuildResult;
}

export type DeletionRebuildLedgerClaim =
  | { readonly status: "acquired"; readonly claimToken: string }
  | { readonly status: "replayed"; readonly result: DeletionRebuildResult }
  | { readonly status: "conflict" }
  | { readonly status: "in_progress" };

export type DeletionRebuildLedgerCompletion = "completed" | "already_completed" | "claim_mismatch";

/**
 * Atomic idempotency seam; production durability/locking belongs to T02.
 * `claim` must establish ownership before any destructive stage. A failed
 * `complete` must leave the claim in progress so a retry cannot re-run work.
 */
export interface DeletionRebuildLedger {
  claim(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    /** Complete validated deletion semantics; T02 hashes this internally. */
    readonly semanticInput?: unknown;
  }): Promise<DeletionRebuildLedgerClaim>;
  complete(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    /** Same complete validated deletion semantics supplied at claim time. */
    readonly semanticInput?: unknown;
    readonly claimToken: string;
    readonly result: DeletionRebuildResult;
  }): Promise<DeletionRebuildLedgerCompletion>;
}

export interface DeletionRebuildServiceDependencies {
  readonly deletionJobs: DeletionJobReader;
  readonly deletionRuntime: T05DeletionRuntime;
  readonly sourceReferences: T13SourceReferenceReader;
  readonly projectionRunner: DeletionRebuildProjectionRunner;
  readonly ledger: DeletionRebuildLedger;
  /** Optional successor path; when present, T03 intent is appended through T05 receipts. */
  readonly canonicalLifecycle?: MemoryCanonicalDeletionLifecycle;
}

export interface DeletionRebuildResult {
  readonly status: DeletionRebuildStatus;
  readonly stage: DeletionRebuildStage;
  readonly fingerprint?: Sha256;
  readonly errorCode?: DeletionRebuildErrorCode;
  readonly plan?: T05DeletionWorkPlan;
  readonly rebuildRequest?: MemoryRebuildRequestManifest;
  readonly rebuildResult?: MemoryRebuildResultManifest;
  readonly attestationIntent?: T05DomainDeletionAttestationIntent;
}

export interface DeletionRebuildApplicationService {
  execute(input: DeletionRebuildRequest): Promise<DeletionRebuildResult>;
}

const MEMORY_REF_TYPES = new Set([
  "MemoryCandidate",
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
]);
const SOURCE_REF_TYPES = new Set(["SourceArtifact", "ArtifactVersion"]);

export function createDeletionRebuildService(
  dependencies: DeletionRebuildServiceDependencies,
): DeletionRebuildApplicationService {
  return {
    execute: async (input) => executeDeletionRebuild(dependencies, input),
  };
}

async function applyCanonicalDeletionLifecycle(
  lifecycle: MemoryCanonicalDeletionLifecycle,
  plan: T05DeletionWorkPlan,
  fingerprint: Sha256,
): Promise<OwnerPortResult<AuthoritativeSuppressionResult>> {
  const successors: MemoryDeletionSuccessorReceipt[] = [];
  for (const projection of plan.projectedMutations) {
    if (projection.targetRef.refType === "MemoryCandidate") continue;
    let target: Awaited<ReturnType<MemoryCanonicalDeletionLifecycle["reader"]["readVersionByRef"]>>;
    try {
      target = await lifecycle.reader.readVersionByRef({ ref: projection.targetRef });
    } catch {
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
    if (!target.ok) return target;
    let targetRead: MemoryCanonicalVersionRead;
    try {
      // Validate the complete target read before invoking T05.  A ref-only,
      // malformed, accessor-backed, or receipt-drifted result must never reach
      // the issuer or the append seam.
      targetRead = assertMemoryCanonicalVersionRead(target.value);
      const targetReceipt = assertProductionMemoryIssuerReceipt(targetRead.receipt);
      const targetMemoryRef = targetReceipt.memoryRef;
      if (targetMemoryRef === undefined ||
          canonicalRefKey(targetMemoryRef) !== canonicalRefKey(projection.targetRef) ||
          canonicalPayloadHash(targetRead.payload).sha256 !== targetReceipt.canonicalPayloadSha256 ||
          canonicalPayloadHash(targetRead.payload).jcs !== targetReceipt.canonicalPayloadJcs) {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      const successor = assertProductionMemoryIssuerReceipt(lifecycle.issueSuccessor({ target: targetRead, projection }));
      if (successor.operation !== "memory_successor" || successor.memoryRef === undefined ||
          successor.previousRef === undefined ||
           successor.previousRef.refId !== projection.targetRef.refId ||
          successor.memoryRef.refId !== projection.targetRef.refId ||
          canonicalRefKey(successor.previousRef) !== canonicalRefKey(projection.targetRef) ||
          canonicalRefKey(successor.previousRef) !== canonicalRefKey(targetMemoryRef) ||
          canonicalPayloadHash(successor.payload).sha256 !== successor.canonicalPayloadSha256 ||
          canonicalPayloadHash(successor.payload).jcs !== successor.canonicalPayloadJcs) {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      const desiredStatus = projection.deleted ? "deleted" : projection.suppressed ? "suppressed" : projection.targetStatus;
      if (successor.payload.status !== desiredStatus ||
          canonicalPayloadHash(successor.payload).sha256 !== successor.canonicalPayloadSha256) {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      successors.push({ targetRef: projection.targetRef, receipt: successor });
    } catch {
      return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
    }
  }
  try {
    const result = await lifecycle.append({
      idempotencyKey: plan.idempotencyKey,
      fingerprint,
      projections: plan.projectedMutations,
      successors,
    });
    if (!result.ok) return result;
    return { ok: true, value: result.value };
  } catch {
    return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
  }
}

async function executeDeletionRebuild(
  dependencies: DeletionRebuildServiceDependencies,
  input: DeletionRebuildRequest,
): Promise<DeletionRebuildResult> {
  const normalized = normalizeRequest(input);
  if (normalized === undefined) return failure("request", "INVALID_REQUEST");

  let jobRef: CanonicalObjectVersionRef;
  try {
    jobRef = copyTypedRef(normalized.deletionJobRef, new Set(["DeletionJob"]));
  } catch {
    return failure("request", "INVALID_REQUEST");
  }

  let scopeResult: OwnerPortResult<DeletionJobScope>;
  try {
    scopeResult = await dependencies.deletionJobs.readDeletionJob({ deletionJobRef: jobRef });
  } catch {
    return failure("scope", "OWNER_STATE_UNAVAILABLE");
  }
  if (!scopeResult.ok) return failure("scope", "OWNER_STATE_UNAVAILABLE");

  const scope = validateScope(scopeResult.value, jobRef, normalized.expectedScopeManifestSha256);
  if (!scope.ok) return failure("scope", scope.errorCode);

  const fingerprint = requestFingerprint(normalized, scope);
  if (fingerprint === undefined) return failure("scope", "SCOPE_WATERMARK_INVALID");

  let plan: T05DeletionWorkPlan;
  try {
    plan = createT05DeletionWorkPlan({
      deletionJobRef: jobRef,
      scopeManifestSha256: normalized.expectedScopeManifestSha256,
      targetMemoryRefs: scope.targetMemoryRefs,
      authorityWatermark: scope.authorityWatermark,
      idempotencyKey: normalized.idempotencyKey,
      ...(scope.projectedMutations === undefined ? {} : { projectedMutations: scope.projectedMutations }),
    });
  } catch {
    return failure("scope", "SCOPE_TARGET_INVALID", fingerprint);
  }

  const semanticInput = Object.freeze({
    schema: "memory.deletion_rebuild.request.v2",
    requestId: normalized.requestId,
    idempotencyKey: normalized.idempotencyKey,
    deletionJobRef: jobRef,
    expectedScopeManifestSha256: normalized.expectedScopeManifestSha256,
    requestedAt: normalized.requestedAt,
    projections: normalized.projections,
    targetMemoryRefs: scope.targetMemoryRefs,
    authorityWatermark: scope.authorityWatermark,
    projectedMutations: scope.projectedMutations ?? [],
  });

  let claim: DeletionRebuildLedgerClaim;
  try {
    const rawClaim: unknown = await dependencies.ledger.claim({
      idempotencyKey: normalized.idempotencyKey,
      fingerprint,
      semanticInput,
    });
    const validatedClaim = validateLedgerClaim(rawClaim, {
      fingerprint,
      input: normalized,
      scope,
      plan,
    });
    if (validatedClaim === undefined) {
      return failure("scope", "LEDGER_UNAVAILABLE", fingerprint);
    }
    claim = validatedClaim;
  } catch {
    return failure("scope", "LEDGER_UNAVAILABLE", fingerprint);
  }
  if (claim.status === "conflict") {
    return failure("scope", "IDEMPOTENCY_CONFLICT", fingerprint);
  }
  if (claim.status === "in_progress") {
    return failure("scope", "LEDGER_IN_PROGRESS", fingerprint);
  }
  if (claim.status === "replayed") return replayedResult(claim.result);
  const finish = (result: DeletionRebuildResult): Promise<DeletionRebuildResult> =>
    completeClaim(dependencies, normalized, fingerprint, semanticInput, claim.claimToken, result);

  let suppression: AuthoritativeSuppressionValue;
  try {
    const result = dependencies.canonicalLifecycle === undefined
      ? await dependencies.deletionRuntime.applyAuthoritativeSuppression(plan)
      : await applyCanonicalDeletionLifecycle(dependencies.canonicalLifecycle, plan, fingerprint);
    if (!result.ok) return finish(failure("suppression", "SUPPRESSION_FAILED", fingerprint, plan));
    const validatedSuppression = validateSuppression(result.value);
    if (validatedSuppression === undefined) {
      return finish(failure("suppression", "SUPPRESSION_FAILED", fingerprint, plan));
    }
    suppression = validatedSuppression;
  } catch {
    return finish(failure("suppression", "SUPPRESSION_FAILED", fingerprint, plan));
  }

  let purge: DerivedPurgeValue;
  try {
    const result = await dependencies.deletionRuntime.purgeDerivedSurfaces(plan);
    if (!result.ok) return finish(failure("purge", "PURGE_FAILED", fingerprint, plan));
    const validatedPurge = validatePurge(result.value);
    if (validatedPurge === undefined) {
      return finish(failure("purge", "PURGE_FAILED", fingerprint, plan));
    }
    purge = validatedPurge;
    if (purge.surfaceResults.some((item) => item.remainingQueryableCount !== 0)) {
      return finish(failure("purge", "SURFACE_RESIDUAL", fingerprint, plan));
    }
  } catch {
    return finish(failure("purge", "PURGE_FAILED", fingerprint, plan));
  }

  let sourceArtifactRefs: readonly CanonicalObjectVersionRef[];
  let enumeratedSourceRefs: readonly CanonicalObjectVersionRef[];
  try {
    const result = await dependencies.sourceReferences.enumerateSourceReferences({
      deletionJobRef: jobRef,
      targetMemoryRefs: plan.targetMemoryRefs,
      authorityWatermark: suppression.authorityWatermark,
    });
    if (!result.ok) return finish(failure("enumerate", "SOURCE_ENUMERATION_FAILED", fingerprint, plan));
    enumeratedSourceRefs = result.value;
  } catch {
    return finish(failure("enumerate", "SOURCE_ENUMERATION_FAILED", fingerprint, plan));
  }
  try {
    sourceArtifactRefs = normalizeRefs(enumeratedSourceRefs, SOURCE_REF_TYPES);
    if (sourceArtifactRefs.length === 0) {
      return finish(failure("enumerate", "SOURCE_REF_INVALID", fingerprint, plan));
    }
  } catch {
    return finish(failure("enumerate", "SOURCE_REF_INVALID", fingerprint, plan));
  }

  let rebuildRequest: MemoryRebuildRequestManifest;
  try {
    rebuildRequest = createMemoryRebuildRequestManifest({
      requestId: normalized.requestId,
      idempotencyKey: normalized.idempotencyKey,
      requestedAt: normalized.requestedAt,
      authorityWatermark: suppression.authorityWatermark,
      sourceArtifactRefs,
      projections: normalized.projections,
    });
  } catch {
    return finish(failure("manifest", "REBUILD_MANIFEST_INVALID", fingerprint, plan));
  }

  let rebuild: ValidatedProjectionResult;
  try {
    const result = await dependencies.projectionRunner.rebuild({
      request: rebuildRequest,
      sourceArtifactRefs,
    });
    if (!result.ok) return finish(failure("rebuild", "REBUILD_FAILED", fingerprint, plan, rebuildRequest));
    rebuild = validateProjectionResult(result.value, sourceArtifactRefs);
    if (rebuild.errorCode !== undefined) {
      return finish(failure("rebuild", rebuild.errorCode, fingerprint, plan, rebuildRequest));
    }
  } catch {
    return finish(failure("rebuild", "REBUILD_FAILED", fingerprint, plan, rebuildRequest));
  }

  let rebuildResult: MemoryRebuildResultManifest;
  try {
    const deletedKeys = new Set(rebuild.deletedSourceRefs.map(canonicalRefKey));
    const skippedKeys = new Set(rebuild.skippedDeletedSourceRefs.map(canonicalRefKey));
    const consumedKeys = new Set(rebuild.consumedSourceRefs.map(canonicalRefKey));
    for (const key of deletedKeys) {
      if (consumedKeys.has(key)) {
        return finish(failure("rebuild", "DELETED_SOURCE_CONSUMED", fingerprint, plan, rebuildRequest));
      }
      if (!skippedKeys.has(key)) {
        return finish(failure("rebuild", "DELETED_SOURCE_NOT_SKIPPED", fingerprint, plan, rebuildRequest));
      }
    }
    for (const key of skippedKeys) {
      if (!deletedKeys.has(key)) {
        return finish(failure("rebuild", "DELETED_SOURCE_NOT_SKIPPED", fingerprint, plan, rebuildRequest));
      }
    }
    if (!isCompletePartition(
      sourceArtifactRefs,
      rebuild.consumedSourceRefs,
      rebuild.skippedDeletedSourceRefs,
    )) {
      return finish(failure("rebuild", "PARTITION_INCOMPLETE", fingerprint, plan, rebuildRequest));
    }
    rebuildResult = createMemoryRebuildResultManifest({
      request: rebuildRequest,
      completedAt: rebuild.completedAt,
      authorityWatermark: rebuild.authorityWatermark,
      consumedSourceRefs: rebuild.consumedSourceRefs,
      skippedDeletedSourceRefs: rebuild.skippedDeletedSourceRefs,
      appliedDeletionJobRefs: rebuild.skippedDeletedSourceRefs.length > 0 ? [jobRef] : [],
      projections: rebuild.projectionResults,
    });
  } catch {
    return finish(failure("rebuild", "REBUILD_RESULT_INVALID", fingerprint, plan, rebuildRequest));
  }

  let attestationIntent: T05DomainDeletionAttestationIntent;
  try {
    attestationIntent = createT05DomainDeletionAttestationIntent({
      plan,
      completedAt: rebuild.completedAt,
      authorityWatermark: rebuild.authorityWatermark,
      completedStages: T05_DELETION_STAGES,
      surfaceResults: purge.surfaceResults,
    });
    assertAttestationBinding(attestationIntent, plan);
  } catch {
    return finish(failure("attestation", "ATTESTATION_INVALID", fingerprint, plan, rebuildRequest, rebuildResult));
  }

  const completed: DeletionRebuildResult = Object.freeze({
    status: "completed",
    stage: "attestation",
    fingerprint,
    plan,
    rebuildRequest,
    rebuildResult,
    attestationIntent,
  });
  return finish(completed);
}

interface NormalizedRequest extends DeletionRebuildRequest {
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly expectedScopeManifestSha256: Sha256;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly requestedAt: string;
}

function normalizeRequest(input: DeletionRebuildRequest): NormalizedRequest | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if (typeof input.requestId !== "string" || input.requestId.trim().length === 0) return undefined;
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) return undefined;
  if (typeof input.requestedAt !== "string") return undefined;
  try {
    const requestedAt = assertCanonicalUtcInstant(input.requestedAt, "requestedAt");
    const expectedScopeManifestSha256 = assertSha256(input.expectedScopeManifestSha256);
    const projections = normalizeProjectionConfigs(input.projections);
    if (projections === undefined) return undefined;
    return Object.freeze({
      ...input,
      requestId: input.requestId.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      requestedAt,
      expectedScopeManifestSha256,
      projections,
    });
  } catch {
    return undefined;
  }
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function normalizeProjectionConfigs(
  values: unknown,
): readonly DerivedProjectionConfig[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const seen = new Set<string>();
  const normalized: DerivedProjectionConfig[] = [];
  try {
    for (const value of values) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      const projection = value as Record<string, unknown>;
      if (typeof projection.kind !== "string" ||
          !REBUILD_PROJECTION_KINDS.includes(projection.kind as typeof REBUILD_PROJECTION_KINDS[number]) ||
          seen.has(projection.kind)) return undefined;
      if (typeof projection.implementationVersion !== "string" ||
          !SEMVER_PATTERN.test(projection.implementationVersion)) return undefined;
      const configurationSha256 = assertSha256(projection.configurationSha256);
      const artifactRefValue = projection.artifactRef;
      const artifactRef = artifactRefValue === undefined
        ? undefined
        : copyTypedRef(artifactRefValue as CanonicalObjectVersionRef, SOURCE_REF_TYPES);
      seen.add(projection.kind);
      normalized.push(Object.freeze({
        kind: projection.kind as typeof REBUILD_PROJECTION_KINDS[number],
        implementationVersion: projection.implementationVersion,
        configurationSha256,
        ...(artifactRef === undefined ? {} : { artifactRef }),
      }));
    }
    return Object.freeze(normalized.sort((left, right) => left.kind.localeCompare(right.kind)));
  } catch {
    return undefined;
  }
}

type ScopeValidation =
  | {
      readonly ok: true;
      readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
      readonly authorityWatermark: AuthorityWatermark;
      readonly projectedMutations?: readonly T03DeletionMutationProjection[];
    }
  | { readonly ok: false; readonly errorCode: DeletionRebuildErrorCode };

function validateScope(
  scope: DeletionJobScope & { readonly projectedMutations?: readonly T03DeletionMutationProjection[] },
  expectedJobRef: CanonicalObjectVersionRef,
  expectedHash: Sha256,
): ScopeValidation {
  try {
    const scopeJobRef = copyTypedRef(scope.deletionJobRef, new Set(["DeletionJob"]));
    if (canonicalRefKey(scopeJobRef) !== canonicalRefKey(expectedJobRef)) {
      return { ok: false, errorCode: "JOB_REF_MISMATCH" };
    }
    if (assertSha256(scope.scopeManifestSha256) !== expectedHash) {
      return { ok: false, errorCode: "SCOPE_HASH_MISMATCH" };
    }
    if (scope.authorityWatermark === undefined || scope.authorityWatermark === null) {
      return { ok: false, errorCode: "SCOPE_WATERMARK_MISSING" };
    }
    if (!isValidOpaqueWatermark(scope.authorityWatermark)) {
      return { ok: false, errorCode: "SCOPE_WATERMARK_INVALID" };
    }
    const targetMemoryRefs = normalizeRefs(scope.targetMemoryRefs, MEMORY_REF_TYPES);
    if (targetMemoryRefs.length === 0) return { ok: false, errorCode: "SCOPE_TARGET_INVALID" };
    return {
      ok: true,
      targetMemoryRefs,
      authorityWatermark: scope.authorityWatermark,
      ...(scope.projectedMutations === undefined ? {} : { projectedMutations: scope.projectedMutations }),
    };
  } catch {
    return { ok: false, errorCode: "SCOPE_TARGET_INVALID" };
  }
}

interface AuthoritativeSuppressionValue {
  readonly completedAt: CanonicalUtcInstant;
  readonly authorityWatermark: AuthorityWatermark;
}

function validateSuppression(value: {
  readonly completedAt: string;
  readonly authorityWatermark: AuthorityWatermark;
}): AuthoritativeSuppressionValue | undefined {
  try {
    if (!isValidOpaqueWatermark(value.authorityWatermark)) return undefined;
    return {
      completedAt: assertCanonicalUtcInstant(value.completedAt, "suppression.completedAt"),
      authorityWatermark: value.authorityWatermark,
    };
  } catch {
    return undefined;
  }
}

interface DerivedPurgeValue {
  readonly completedAt: CanonicalUtcInstant;
  readonly authorityWatermark: AuthorityWatermark;
  readonly surfaceResults: readonly T05DeletionSurfaceResult[];
}

function validatePurge(value: DerivedPurgeResult): DerivedPurgeValue | undefined {
  try {
    if (!isValidOpaqueWatermark(value.authorityWatermark)) return undefined;
    const bySurface = new Map<string, T05DeletionSurfaceResult>();
    for (const item of value.surfaceResults) {
      if (!T05_DELETION_SURFACES.includes(item.surface) || bySurface.has(item.surface) ||
          !Number.isSafeInteger(item.remainingQueryableCount) || item.remainingQueryableCount < 0) {
        return undefined;
      }
      bySurface.set(item.surface, Object.freeze({
        surface: item.surface,
        remainingQueryableCount: item.remainingQueryableCount,
      }));
    }
    if (bySurface.size !== T05_DELETION_SURFACES.length ||
        T05_DELETION_SURFACES.some((surface) => !bySurface.has(surface))) return undefined;
    return {
      completedAt: assertCanonicalUtcInstant(value.completedAt, "purge.completedAt"),
      authorityWatermark: value.authorityWatermark,
      surfaceResults: Object.freeze(T05_DELETION_SURFACES.map((surface) => bySurface.get(surface)!)),
    };
  } catch {
    return undefined;
  }
}

interface ValidatedProjectionResult extends DeletionRebuildProjectionResult {
  readonly errorCode?: DeletionRebuildErrorCode;
}

function validateProjectionResult(
  value: DeletionRebuildProjectionResult,
  expectedSourceRefs: readonly CanonicalObjectVersionRef[],
): ValidatedProjectionResult {
  try {
    if (!isValidOpaqueWatermark(value.authorityWatermark)) {
      return { ...value, errorCode: "REBUILD_RESULT_INVALID" };
    }
    const completedAt = assertCanonicalUtcInstant(value.completedAt, "rebuild.completedAt");
    const consumedSourceRefs = normalizeRefs(value.consumedSourceRefs, SOURCE_REF_TYPES);
    const skippedDeletedSourceRefs = normalizeRefs(value.skippedDeletedSourceRefs, SOURCE_REF_TYPES);
    const deletedSourceRefs = normalizeRefs(value.deletedSourceRefs, SOURCE_REF_TYPES);
    const expected = new Set(expectedSourceRefs.map(canonicalRefKey));
    for (const ref of [...consumedSourceRefs, ...skippedDeletedSourceRefs, ...deletedSourceRefs]) {
      if (!expected.has(canonicalRefKey(ref))) return { ...value, errorCode: "PARTITION_INCOMPLETE" };
    }
    return {
      ...value,
      completedAt,
      consumedSourceRefs,
      skippedDeletedSourceRefs,
      deletedSourceRefs,
    };
  } catch {
    return { ...value, errorCode: "PARTITION_INCOMPLETE" };
  }
}

function assertAttestationBinding(
  intent: T05DomainDeletionAttestationIntent,
  plan: T05DeletionWorkPlan,
): void {
  if (canonicalRefKey(intent.deletionJobRef) !== canonicalRefKey(plan.deletionJobRef) ||
      intent.scopeManifestSha256 !== plan.scopeManifestSha256 ||
      !sameRefSet(intent.targetMemoryRefs, plan.targetMemoryRefs) ||
      intent.completedStages.length !== T05_DELETION_STAGES.length) {
    throw new TypeError("attestation is not bound to the exact deletion plan");
  }
}

function normalizeRefs(
  values: readonly CanonicalObjectVersionRef[],
  allowedTypes: ReadonlySet<string>,
): readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(values)) throw new TypeError("canonical ref list is required");
  const refs = new Map<string, CanonicalObjectVersionRef>();
  for (const value of values) {
    const ref = copyTypedRef(value, allowedTypes);
    const key = canonicalRefKey(ref);
    if (refs.has(key)) throw new TypeError("duplicate canonical ref");
    refs.set(key, ref);
  }
  return Object.freeze([...refs.values()].sort(compareCanonicalObjectVersionRefs));
}

function copyTypedRef(
  value: CanonicalObjectVersionRef,
  allowedTypes: ReadonlySet<string>,
): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  if (!allowedTypes.has(ref.refType)) throw new TypeError("disallowed canonical ref type");
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function sameRefSet(
  left: readonly CanonicalObjectVersionRef[],
  right: readonly CanonicalObjectVersionRef[],
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  try {
    const leftKeys = left.map(canonicalRefKey);
    const rightKeys = right.map(canonicalRefKey);
    const leftSet = new Set(leftKeys);
    const rightSet = new Set(rightKeys);
    if (leftSet.size !== leftKeys.length || rightSet.size !== rightKeys.length) return false;
    return [...leftSet].every((key) => rightSet.has(key));
  } catch {
    return false;
  }
}

function replayedResult(result: DeletionRebuildResult): DeletionRebuildResult {
  return Object.freeze({ ...result, status: "replayed", stage: "replayed" });
}

interface ReplayValidationContext {
  readonly fingerprint: Sha256;
  readonly input: NormalizedRequest;
  readonly scope: {
    readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
    readonly authorityWatermark: AuthorityWatermark;
  };
  readonly plan: T05DeletionWorkPlan;
}

function validateLedgerClaim(
  value: unknown,
  context: ReplayValidationContext,
): DeletionRebuildLedgerClaim | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  switch (value.status) {
    case "acquired":
      return typeof value.claimToken === "string" && value.claimToken.trim().length > 0
        ? { status: "acquired", claimToken: value.claimToken }
        : undefined;
    case "conflict":
      return { status: "conflict" };
    case "in_progress":
      return { status: "in_progress" };
    case "replayed": {
      if (!isRecord(value.result) || value.result.fingerprint !== context.fingerprint) return undefined;
      return isStoredTerminalResult(value.result, context)
        ? { status: "replayed", result: value.result as unknown as DeletionRebuildResult }
        : undefined;
    }
    default:
      return undefined;
  }
}

function isStoredTerminalResult(
  value: Record<string, unknown>,
  context: ReplayValidationContext,
): boolean {
  if (value.fingerprint !== context.fingerprint) return false;
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "rejected") {
    return false;
  }
  const stages: readonly string[] = [
    "request", "scope", "suppression", "purge", "enumerate", "manifest", "rebuild", "attestation",
  ];
  if (typeof value.stage !== "string" || !stages.includes(value.stage)) return false;
  if (!validateStoredPlan(value.plan, context)) return false;
  if (value.status === "completed") {
    if (value.stage !== "attestation" || value.errorCode !== undefined ||
        !isRecord(value.rebuildRequest) || !isRecord(value.rebuildResult) ||
        !isRecord(value.attestationIntent)) return false;
    const rebuildRequest = validateStoredRebuildRequest(value.rebuildRequest, context);
    if (rebuildRequest === undefined) return false;
    const rebuildResult = validateStoredRebuildResult(value.rebuildResult, rebuildRequest, context);
    if (rebuildResult === undefined) return false;
    return validateStoredAttestation(value.attestationIntent, context.plan, rebuildResult);
  }
  if (typeof value.errorCode !== "string" ||
      !(DELETION_REBUILD_ERROR_CODES as readonly string[]).includes(value.errorCode) ||
      value.attestationIntent !== undefined) {
    return false;
  }
  {
    if (value.rebuildResult !== undefined && !isRecord(value.rebuildResult)) return false;
    if (value.rebuildRequest !== undefined && !isRecord(value.rebuildRequest)) return false;
    if (value.rebuildResult !== undefined && value.rebuildRequest === undefined) return false;
    if (value.rebuildRequest !== undefined) {
      const rebuildRequest = validateStoredRebuildRequest(value.rebuildRequest, context);
      if (rebuildRequest === undefined) return false;
      if (value.rebuildResult !== undefined &&
          validateStoredRebuildResult(value.rebuildResult, rebuildRequest, context) === undefined) return false;
    }
    return true;
  }
  return false;
}

function validateStoredPlan(
  value: unknown,
  context: ReplayValidationContext,
): value is T05DeletionWorkPlan {
  if (!isRecord(value) || value.kind !== "t05_deletion_work_plan") return false;
  try {
    const deletionJobRef = copyTypedRef(value.deletionJobRef as CanonicalObjectVersionRef, new Set(["DeletionJob"]));
    if (canonicalRefKey(deletionJobRef) !== canonicalRefKey(context.plan.deletionJobRef)) return false;
    if (assertSha256(value.scopeManifestSha256) !== context.plan.scopeManifestSha256) return false;
    if (value.idempotencyKey !== context.input.idempotencyKey) return false;
    if (!sameRefSet(value.targetMemoryRefs as readonly CanonicalObjectVersionRef[], context.scope.targetMemoryRefs)) return false;
    if (!sameOpaqueWatermark(value.authorityWatermark, context.scope.authorityWatermark)) return false;
    if (!sameOrderedStrings(value.stages, T05_DELETION_STAGES) ||
        !sameOrderedStrings(value.surfaces, T05_DELETION_SURFACES)) return false;
    return true;
  } catch {
    return false;
  }
}

function validateStoredRebuildRequest(
  value: Record<string, unknown>,
  context: ReplayValidationContext,
): MemoryRebuildRequestManifest | undefined {
  try {
    if (value.kind !== "memory_rebuild_request" ||
        value.requestId !== context.input.requestId ||
        value.idempotencyKey !== context.input.idempotencyKey ||
         value.requestedAt !== context.input.requestedAt ||
         !isValidOpaqueWatermark(value.authorityWatermark)) return undefined;
    const projections = normalizeProjectionConfigs(value.projections);
    if (projections === undefined || !sameProjectionConfigs(projections, context.input.projections)) return undefined;
    const sourceArtifactRefs = normalizeRefs(value.sourceArtifactRefs as readonly CanonicalObjectVersionRef[], SOURCE_REF_TYPES);
    if (sourceArtifactRefs.length === 0) return undefined;
    return createMemoryRebuildRequestManifest({
      requestId: context.input.requestId,
      idempotencyKey: context.input.idempotencyKey,
      requestedAt: context.input.requestedAt,
      authorityWatermark: value.authorityWatermark,
      sourceArtifactRefs,
      projections,
    });
  } catch {
    return undefined;
  }
}

function validateStoredRebuildResult(
  value: Record<string, unknown>,
  request: MemoryRebuildRequestManifest,
  context: ReplayValidationContext,
): MemoryRebuildResultManifest | undefined {
  try {
    if (value.kind !== "memory_rebuild_result" || value.requestId !== request.requestId ||
        !isCanonicalInstantValue(value.completedAt) ||
        !isValidOpaqueWatermark(value.authorityWatermark)) return undefined;
    const consumedSourceRefs = normalizeRefs(value.consumedSourceRefs as readonly CanonicalObjectVersionRef[], SOURCE_REF_TYPES);
    const skippedDeletedSourceRefs = normalizeRefs(value.skippedDeletedSourceRefs as readonly CanonicalObjectVersionRef[], SOURCE_REF_TYPES);
    if (!isCompletePartition(request.sourceArtifactRefs, consumedSourceRefs, skippedDeletedSourceRefs)) return undefined;
    const appliedDeletionJobRefs = normalizeRefs(value.appliedDeletionJobRefs as readonly CanonicalObjectVersionRef[], new Set(["DeletionJob"]));
    const expectedApplied = skippedDeletedSourceRefs.length > 0 ? [context.plan.deletionJobRef] : [];
    if (!sameRefSet(appliedDeletionJobRefs, expectedApplied)) return undefined;
    return createMemoryRebuildResultManifest({
      request,
      completedAt: value.completedAt as CanonicalUtcInstant,
      authorityWatermark: value.authorityWatermark,
      consumedSourceRefs,
      skippedDeletedSourceRefs,
      appliedDeletionJobRefs,
      projections: value.projections as readonly RebuiltProjectionResult[],
    });
  } catch {
    return undefined;
  }
}

function validateStoredAttestation(
  value: Record<string, unknown>,
  plan: T05DeletionWorkPlan,
  rebuildResult: MemoryRebuildResultManifest,
): boolean {
  try {
    if (value.kind !== "domain_deletion_attestation_intent" || value.ownerModule !== "T05" ||
        Object.prototype.hasOwnProperty.call(value, "deletionProof") ||
        !isCanonicalInstantValue(value.completedAt) ||
        !isValidOpaqueWatermark(value.authorityWatermark) ||
        !sameOpaqueWatermark(value.authorityWatermark, rebuildResult.authorityWatermark) ||
        value.completedAt !== rebuildResult.completedAt ||
        canonicalRefKey(value.deletionJobRef as CanonicalObjectVersionRef) !== canonicalRefKey(plan.deletionJobRef) ||
        assertSha256(value.scopeManifestSha256) !== plan.scopeManifestSha256 ||
        !sameRefSet(value.targetMemoryRefs as readonly CanonicalObjectVersionRef[], plan.targetMemoryRefs) ||
        !sameOrderedStrings(value.completedStages, T05_DELETION_STAGES)) return false;
    const purge = validatePurge({
      completedAt: value.completedAt as CanonicalUtcInstant,
      authorityWatermark: value.authorityWatermark,
      surfaceResults: value.surfaceResults as readonly T05DeletionSurfaceResult[],
    });
    return purge !== undefined && purge.surfaceResults.every((item) => item.remainingQueryableCount === 0);
  } catch {
    return false;
  }
}

function isCanonicalInstantValue(value: unknown): value is CanonicalUtcInstant {
  try {
    assertCanonicalUtcInstant(value);
    return true;
  } catch {
    return false;
  }
}

function sameOpaqueWatermark(left: unknown, right: unknown): boolean {
  const leftSerialized = stableSerialize(left);
  const rightSerialized = stableSerialize(right);
  return leftSerialized !== undefined && rightSerialized !== undefined && leftSerialized === rightSerialized;
}

function isValidOpaqueWatermark(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim().length === 0) return false;
  return stableSerialize(value) !== undefined;
}

function sameOrderedStrings(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameProjectionConfigs(
  left: readonly DerivedProjectionConfig[],
  right: readonly DerivedProjectionConfig[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const expected = right[index];
    return expected !== undefined && item.kind === expected.kind &&
      item.implementationVersion === expected.implementationVersion &&
      item.configurationSha256 === expected.configurationSha256 &&
      (item.artifactRef === undefined
        ? expected.artifactRef === undefined
        : expected.artifactRef !== undefined && canonicalRefKey(item.artifactRef) === canonicalRefKey(expected.artifactRef));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function completeClaim(
  dependencies: DeletionRebuildServiceDependencies,
  input: NormalizedRequest,
  fingerprint: Sha256,
  semanticInput: unknown,
  claimToken: string,
  result: DeletionRebuildResult,
): Promise<DeletionRebuildResult> {
  try {
    const completion = await dependencies.ledger.complete({
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      semanticInput,
      claimToken,
      result,
    });
    if (completion === "completed" || completion === "already_completed") return result;
  } catch {
    // The ledger contract retains the claim on failure; retry must return in-progress.
  }
  return failure(
    result.stage,
    "LEDGER_UNAVAILABLE",
    fingerprint,
    result.plan,
    result.rebuildRequest,
    result.rebuildResult,
  );
}

function isCompletePartition(
  expected: readonly CanonicalObjectVersionRef[],
  consumed: readonly CanonicalObjectVersionRef[],
  skipped: readonly CanonicalObjectVersionRef[],
): boolean {
  const expectedKeys = new Set(expected.map(canonicalRefKey));
  const consumedKeys = new Set(consumed.map(canonicalRefKey));
  const skippedKeys = new Set(skipped.map(canonicalRefKey));
  if (consumedKeys.size + skippedKeys.size !== expectedKeys.size) return false;
  for (const key of consumedKeys) {
    if (!expectedKeys.has(key) || skippedKeys.has(key)) return false;
  }
  for (const key of skippedKeys) {
    if (!expectedKeys.has(key)) return false;
  }
  return true;
}

function requestFingerprint(
  input: NormalizedRequest,
  scope: {
    readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
    readonly authorityWatermark: AuthorityWatermark;
    readonly projectedMutations?: readonly T03DeletionMutationProjection[];
  },
): Sha256 | undefined {
  const projectionIdentity = input.projections.slice().sort((left, right) =>
    left.kind.localeCompare(right.kind)).map((projection) => ({
      kind: projection.kind,
      implementationVersion: projection.implementationVersion,
      configurationSha256: projection.configurationSha256,
      ...(projection.artifactRef === undefined
        ? {}
        : { artifactRef: canonicalRefKey(projection.artifactRef) }),
    }));
  try {
    const payload = stableSerialize({
      requestId: input.requestId,
      deletionJobRef: canonicalRefKey(input.deletionJobRef),
      expectedScopeManifestSha256: input.expectedScopeManifestSha256,
      requestedAt: input.requestedAt,
      projections: projectionIdentity,
      targetMemoryRefs: scope.targetMemoryRefs.map(canonicalRefKey),
      authorityWatermark: scope.authorityWatermark,
      projectedMutations: (scope.projectedMutations ?? []).map((mutation) => ({
        deletionJobRef: canonicalRefKey(mutation.deletionJobRef),
        targetRef: canonicalRefKey(mutation.targetRef),
        targetStatus: mutation.targetStatus,
        targetCurrent: mutation.targetCurrent,
        deleted: mutation.deleted,
        suppressed: mutation.suppressed,
        tombstone: mutation.tombstone,
        nonResurrection: mutation.nonResurrection,
        authorityWatermark: mutation.authorityWatermark,
      })),
    });
    return payload === undefined
      ? undefined
      : assertSha256(createHash("sha256").update(payload, "utf8").digest("hex"));
  } catch {
    return undefined;
  }
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return undefined;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const serialized = stableSerialize(item, seen);
      if (serialized === undefined) {
        seen.delete(value);
        return undefined;
      }
      items.push(serialized);
    }
    const result = `[${items.join(",")}]`;
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const serialized = stableSerialize(record[key], seen);
    if (serialized === undefined) {
      seen.delete(value);
      return undefined;
    }
    parts.push(`${JSON.stringify(key)}:${serialized}`);
  }
  const result = `{${parts.join(",")}}`;
  seen.delete(value);
  return result;
}

function failure(
  stage: DeletionRebuildStage,
  errorCode: DeletionRebuildErrorCode,
  fingerprint?: Sha256,
  plan?: T05DeletionWorkPlan,
  rebuildRequest?: MemoryRebuildRequestManifest,
  rebuildResult?: MemoryRebuildResultManifest,
): DeletionRebuildResult {
  const rejectedCodes = new Set<DeletionRebuildErrorCode>([
    "INVALID_REQUEST",
    "JOB_REF_MISMATCH",
    "SCOPE_HASH_MISMATCH",
    "SCOPE_TARGET_INVALID",
    "SCOPE_WATERMARK_MISSING",
    "SCOPE_WATERMARK_INVALID",
  ]);
  return Object.freeze({
    status: errorCode === "IDEMPOTENCY_CONFLICT"
      ? "conflict"
      : rejectedCodes.has(errorCode) ? "rejected" : "failed",
    stage,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    errorCode,
    ...(plan === undefined ? {} : { plan }),
    ...(rebuildRequest === undefined ? {} : { rebuildRequest }),
    ...(rebuildResult === undefined ? {} : { rebuildResult }),
  });
}
