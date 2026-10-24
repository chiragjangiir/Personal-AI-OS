import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import type {
  AuthorityWatermark,
  CompilerQuery,
  MemoryQuerySnapshot,
  MemoryVersionRecord,
  ReadonlyJsonValue,
} from "./domain.ts";
import {
  compileMemoryContext,
  type CompiledMemoryContext,
} from "./context-compiler.ts";
import type { MemoryRepository } from "./ports.ts";
import {
  DERIVED_MEMORY_REF_TYPES,
  derivedCloneStableJson,
  type DerivedProjectionKind,
  derivedStableSerialize,
  derivedWatermarksEqual,
} from "./derived-projection-service.ts";
import { REBUILD_PROJECTION_KINDS } from "./rebuild-manifest.ts";

export type DerivedQueryErrorCode =
  | "INVALID_QUERY"
  | "AUTHORITY_SNAPSHOT_INVALID"
  | "DERIVED_INDEX_UNAVAILABLE"
  | "DERIVED_INDEX_STALE"
  | "DERIVED_CONFIG_MISMATCH"
  | "DERIVED_REF_NOT_AUTHORITATIVE"
  | "DERIVED_DUPLICATE_REF"
  | "DERIVED_WATERMARK_INVALID"
  | "DERIVED_RESULT_MALFORMED";

export interface DerivedQueryError {
  readonly code: DerivedQueryErrorCode;
  readonly retryable: boolean;
  readonly message?: string;
}

export type DerivedQueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DerivedQueryError };

/** Provider output is a ref and ranking signal only; payload is never context content. */
export interface DerivedQueryCandidate {
  readonly canonicalRef: CanonicalObjectVersionRef;
  readonly projectionKind: DerivedProjectionKind;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly authorityWatermark: AuthorityWatermark;
  readonly score: number;
  readonly providerPayload?: ReadonlyJsonValue;
}

export interface DerivedQueryProviderQuery {
  readonly query: CompilerQuery;
  readonly authorityWatermark: AuthorityWatermark;
}

export interface DerivedQueryProvider {
  readonly projectionKind: DerivedProjectionKind;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  search(input: DerivedQueryProviderQuery): Promise<readonly DerivedQueryCandidate[]>;
}

export interface DerivedRetrievalSuppression {
  readonly canonicalRef?: CanonicalObjectVersionRef;
  readonly projectionKind?: DerivedProjectionKind;
  readonly reason: string;
}

export interface DerivedProviderAudit {
  readonly projectionKind: DerivedProjectionKind;
  readonly outcome: "used" | "fallback" | "unavailable" | "stale" | "malformed";
  readonly acceptedCount: number;
  readonly rejectedCount: number;
}

export interface DerivedRetrievalAudit {
  readonly authorityWatermarkPresent: boolean;
  readonly fallbackUsed: boolean;
  readonly providers: readonly DerivedProviderAudit[];
  readonly suppressions: readonly DerivedRetrievalSuppression[];
}

export interface DerivedQueryMergeInput {
  readonly snapshot: MemoryQuerySnapshot;
  readonly query: CompilerQuery;
  readonly providers: readonly DerivedQueryProvider[];
}

export interface DerivedQueryMergeOutput {
  /** Final text and selected refs originate from the authority/compiler only. */
  readonly context: CompiledMemoryContext;
  readonly audit: DerivedRetrievalAudit;
}

const MEMORY_REF_TYPE_SET = new Set<string>(DERIVED_MEMORY_REF_TYPES);
const MEMORY_REF_TYPE_BY_KIND: Readonly<Record<MemoryVersionRecord["kind"], CanonicalObjectVersionRef["refType"]>> = {
  semantic_fact: "SemanticFact",
  episodic_memory: "EpisodicMemory",
  preference_memory: "PreferenceMemory",
  open_loop: "OpenLoop",
};

function fail(
  code: DerivedQueryErrorCode,
  retryable = false,
  message?: string,
): DerivedQueryResult<never> {
  return { ok: false, error: { code, retryable, ...(message === undefined ? {} : { message }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function isMemoryRef(value: unknown): value is CanonicalObjectVersionRef {
  try {
    return MEMORY_REF_TYPE_SET.has(assertCanonicalObjectVersionRef(value).refType);
  } catch {
    return false;
  }
}

function isMemoryRecordRef(record: MemoryVersionRecord): boolean {
  return isMemoryRef(record.ref) && record.ref.refType === MEMORY_REF_TYPE_BY_KIND[record.kind];
}

function sameQuery(left: CompilerQuery, right: CompilerQuery): boolean {
  try {
    return derivedStableSerialize(left) === derivedStableSerialize(right);
  } catch {
    return false;
  }
}

function queryValid(query: CompilerQuery): boolean {
  return isRecord(query) && nonEmpty(query.userId) && nonEmpty(query.purposeScope) &&
    nonEmpty(query.asOf) && Number.isSafeInteger(query.maxItems) && query.maxItems >= 0 &&
    Number.isSafeInteger(query.maxContentBytes) && query.maxContentBytes >= 0;
}

function recordAllowed(record: MemoryVersionRecord, query: CompilerQuery): string | undefined {
  if (record.status !== "current" || record.current !== true) return "non_current";
  if (record.deletedAt !== undefined) return "deleted";
  if (record.suppressedAt !== undefined) return "suppressed";
  if (record.stale === true) return "stale";
  if (record.userId !== query.userId) return "user_mismatch";
  if (!Array.isArray(record.allowedPurposeScopes)) return "invalid_purpose";
  if (!record.allowedPurposeScopes.includes("*") && !record.allowedPurposeScopes.includes(query.purposeScope)) {
    return "purpose_not_allowed";
  }
  if (!isRecord(record.sensitivity) ||
      (record.sensitivity.classification !== "normal" && record.sensitivity.classification !== "sensitive") ||
      typeof record.sensitivity.userConfirmed !== "boolean") return "invalid_sensitivity";
  if (record.sensitivity.classification === "sensitive" && !record.sensitivity.userConfirmed) {
    return "sensitive_unconfirmed";
  }
  return undefined;
}

function cloneRankedSnapshot(
  snapshot: MemoryQuerySnapshot,
  scores: ReadonlyMap<string, number>,
): MemoryQuerySnapshot {
  const records = snapshot.records.map((record) => Object.freeze({
    ...record,
    // A provider score is a disposable ranking input.  It is never authority.
    derivedRankScore: scores.get(canonicalRefKey(record.ref)) ?? 0,
  }));
  return Object.freeze({
    query: snapshot.query,
    records: Object.freeze(records),
    authorityWatermark: snapshot.authorityWatermark,
  });
}

function cloneCompilerQuery(query: CompilerQuery): CompilerQuery {
  return derivedCloneStableJson(query) as CompilerQuery;
}

function cloneMemorySnapshot(snapshot: MemoryQuerySnapshot): MemoryQuerySnapshot {
  return Object.freeze({
    query: cloneCompilerQuery(snapshot.query),
    records: Object.freeze(derivedCloneStableJson(snapshot.records) as readonly MemoryVersionRecord[]),
    authorityWatermark: snapshot.authorityWatermark === undefined
      ? undefined
      : derivedCloneStableJson(snapshot.authorityWatermark),
  });
}

function snapshotRepository(snapshot: MemoryQuerySnapshot): MemoryRepository {
  return {
    loadCompilerSnapshot: async () => snapshot,
    // compileMemoryContext does not call this method; keep the seam explicit.
    findCurrentBySlot: async () => undefined,
  };
}

function validateSnapshot(snapshot: MemoryQuerySnapshot, query: CompilerQuery): DerivedQueryError | undefined {
  if (!isRecord(snapshot) || !queryValid(query) || !sameQuery(snapshot.query, query)) {
    return { code: "AUTHORITY_SNAPSHOT_INVALID", retryable: false, message: "authority snapshot does not match query" };
  }
  if (!Array.isArray(snapshot.records)) {
    return { code: "AUTHORITY_SNAPSHOT_INVALID", retryable: false, message: "authority records must be an array" };
  }
  const seen = new Set<string>();
  try {
    for (const record of snapshot.records) {
      const key = canonicalRefKey(record.ref);
      if (!isMemoryRecordRef(record) || seen.has(key)) {
        return { code: "AUTHORITY_SNAPSHOT_INVALID", retryable: false, message: "authority snapshot has invalid or duplicate refs" };
      }
      seen.add(key);
    }
  } catch {
    return { code: "AUTHORITY_SNAPSHOT_INVALID", retryable: false, message: "authority snapshot has invalid refs" };
  }
  return undefined;
}

function appendSuppression(
  suppressions: DerivedRetrievalSuppression[],
  input: DerivedRetrievalSuppression,
): void {
  suppressions.push(Object.freeze({
    ...(input.canonicalRef === undefined ? {} : { canonicalRef: cloneRef(input.canonicalRef) }),
    ...(input.projectionKind === undefined ? {} : { projectionKind: input.projectionKind }),
    reason: input.reason,
  }));
}

/**
 * Merge replaceable provider recalls with an authority snapshot, then reuse
 * the existing Context Compiler for final filtering, content, and budgets.
 */
export async function mergeDerivedQuery(
  input: DerivedQueryMergeInput,
): Promise<DerivedQueryResult<DerivedQueryMergeOutput>> {
  let snapshot: MemoryQuerySnapshot;
  let query: CompilerQuery;
  try {
    snapshot = cloneMemorySnapshot(input.snapshot);
    query = cloneCompilerQuery(input.query);
  } catch {
    return fail("AUTHORITY_SNAPSHOT_INVALID", false, "authority query snapshot is malformed");
  }
  const snapshotError = validateSnapshot(snapshot, query);
  if (snapshotError !== undefined) return { ok: false, error: snapshotError };
  if (!Array.isArray(input.providers)) return fail("INVALID_QUERY", false, "providers must be an array");

  const suppressions: DerivedRetrievalSuppression[] = [];
  const providerAudits: DerivedProviderAudit[] = [];
  const authorityWatermarkPresent = snapshot.authorityWatermark !== undefined &&
    snapshot.authorityWatermark !== null;
  const scores = new Map<string, number>();
  const recordsByRef = new Map<string, MemoryVersionRecord>();
  for (const record of snapshot.records) recordsByRef.set(canonicalRefKey(record.ref), record);

  if (authorityWatermarkPresent) {
    try {
      derivedStableSerialize(snapshot.authorityWatermark);
    } catch {
      return fail("DERIVED_WATERMARK_INVALID", false, "authority watermark is not stable");
    }
  }

  for (const provider of input.providers) {
    const rawProvider: unknown = provider;
    const rawKind = isRecord(rawProvider) ? rawProvider.projectionKind : undefined;
    if (!isRecord(rawProvider) || !isProjectionKind(rawProvider.projectionKind) ||
        !nonEmpty(rawProvider.implementationVersion) || typeof rawProvider.search !== "function") {
      providerAudits.push(Object.freeze({
        projectionKind: isProjectionKind(rawKind) ? rawKind : "fts",
        outcome: "malformed",
        acceptedCount: 0,
        rejectedCount: 0,
      }));
      continue;
    }
    const normalizedProvider = provider as DerivedQueryProvider;
    let candidates: readonly DerivedQueryCandidate[];
    if (!authorityWatermarkPresent) {
      providerAudits.push(Object.freeze({
        projectionKind: normalizedProvider.projectionKind,
        outcome: "fallback",
        acceptedCount: 0,
        rejectedCount: 0,
      }));
      continue;
    }
    try {
      candidates = await normalizedProvider.search({
        query,
        authorityWatermark: snapshot.authorityWatermark,
      });
    } catch {
      providerAudits.push(Object.freeze({
        projectionKind: normalizedProvider.projectionKind,
        outcome: "unavailable",
        acceptedCount: 0,
        rejectedCount: 0,
      }));
      appendSuppression(suppressions, {
        projectionKind: normalizedProvider.projectionKind,
        reason: "provider_unavailable",
      });
      continue;
    }
    if (!Array.isArray(candidates)) {
      providerAudits.push(Object.freeze({
        projectionKind: normalizedProvider.projectionKind,
        outcome: "malformed",
        acceptedCount: 0,
        rejectedCount: 0,
      }));
      appendSuppression(suppressions, { projectionKind: normalizedProvider.projectionKind, reason: "provider_result_malformed" });
      continue;
    }
    const providerSeen = new Set<string>();
    let acceptedCount = 0;
    let rejectedCount = 0;
    let stale = false;
    for (const candidate of candidates) {
      let ref: CanonicalObjectVersionRef;
      try {
        ref = cloneRef(candidate.canonicalRef);
      } catch {
        rejectedCount += 1;
        appendSuppression(suppressions, { projectionKind: provider.projectionKind, reason: "invalid_canonical_ref" });
        continue;
      }
      const key = canonicalRefKey(ref);
      if (providerSeen.has(key)) {
        rejectedCount += 1;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: provider.projectionKind, reason: "duplicate_provider_ref" });
        continue;
      }
      providerSeen.add(key);
      if (candidate.projectionKind !== normalizedProvider.projectionKind ||
          candidate.implementationVersion !== normalizedProvider.implementationVersion ||
          candidate.configurationSha256 !== normalizedProvider.configurationSha256) {
        rejectedCount += 1;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: normalizedProvider.projectionKind, reason: "config_mismatch" });
        continue;
      }
      try {
        assertSha256(candidate.configurationSha256);
      } catch {
        rejectedCount += 1;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: normalizedProvider.projectionKind, reason: "config_mismatch" });
        continue;
      }
      // Compare against the pre-provider, deep-cloned authority watermark.
      // The caller's snapshot may be mutable and a provider may retain a
      // reference to it while awaiting; that object must never redefine the
      // authority boundary after the provider call begins.
      if (!derivedWatermarksEqual(candidate.authorityWatermark, snapshot.authorityWatermark)) {
        rejectedCount += 1;
        stale = true;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: normalizedProvider.projectionKind, reason: "watermark_mismatch" });
        continue;
      }
      if (typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
        rejectedCount += 1;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: normalizedProvider.projectionKind, reason: "invalid_score" });
        continue;
      }
      const record = recordsByRef.get(key);
      if (record === undefined) {
        rejectedCount += 1;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: normalizedProvider.projectionKind, reason: "ref_not_authoritative" });
        continue;
      }
      const recordReason = recordAllowed(record, query);
      if (recordReason !== undefined) {
        rejectedCount += 1;
        appendSuppression(suppressions, { canonicalRef: ref, projectionKind: normalizedProvider.projectionKind, reason: recordReason });
        continue;
      }
      acceptedCount += 1;
      const previous = scores.get(key);
      // Provider scores are incomparable across implementations; max is a
      // deterministic rank signal and never becomes authority.
      scores.set(key, previous === undefined ? candidate.score : Math.max(previous, candidate.score));
    }
    providerAudits.push(Object.freeze({
      projectionKind: normalizedProvider.projectionKind,
      outcome: stale && acceptedCount === 0 ? "stale" : acceptedCount > 0 ? "used" : "fallback",
      acceptedCount,
      rejectedCount,
    }));
  }

  const fallbackUsed = scores.size === 0;
  const rankedSnapshot = cloneRankedSnapshot(snapshot, scores);
  let context: CompiledMemoryContext;
  try {
    context = await compileMemoryContext(snapshotRepository(rankedSnapshot), query);
  } catch {
    return fail("AUTHORITY_SNAPSHOT_INVALID", false, "context compilation failed");
  }
  return {
    ok: true,
    value: Object.freeze({
      context,
      audit: Object.freeze({
        authorityWatermarkPresent,
        fallbackUsed,
        providers: Object.freeze(providerAudits),
        suppressions: Object.freeze(suppressions),
      }),
    }),
  };
}

function isProjectionKind(value: unknown): value is DerivedProjectionKind {
  return typeof value === "string" && REBUILD_PROJECTION_KINDS.includes(value as DerivedProjectionKind);
}

/** Convenience factory for callers that prefer an object service seam. */
export function createDerivedQueryMergeService(): {
  merge(input: DerivedQueryMergeInput): Promise<DerivedQueryResult<DerivedQueryMergeOutput>>;
} {
  return { merge: mergeDerivedQuery };
}
