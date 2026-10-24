import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";

export const REBUILD_PROJECTION_KINDS = ["fts", "pgvector", "graph"] as const;
export type RebuildProjectionKind = (typeof REBUILD_PROJECTION_KINDS)[number];

export interface DerivedProjectionConfig {
  readonly kind: RebuildProjectionKind;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly artifactRef?: CanonicalObjectVersionRef;
}

export interface MemoryRebuildRequestInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly authorityWatermark: unknown;
  readonly sourceArtifactRefs: readonly CanonicalObjectVersionRef[];
  readonly projections: readonly DerivedProjectionConfig[];
}

export interface MemoryRebuildRequestManifest extends MemoryRebuildRequestInput {
  readonly kind: "memory_rebuild_request";
}

export interface RebuiltProjectionResult {
  readonly kind: RebuildProjectionKind;
  readonly configurationSha256: Sha256;
  readonly projectionSha256: Sha256;
  readonly recordCount: number;
}

export interface MemoryRebuildResultInput {
  readonly request: MemoryRebuildRequestManifest;
  readonly completedAt: string;
  readonly authorityWatermark: unknown;
  readonly consumedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly skippedDeletedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly appliedDeletionJobRefs: readonly CanonicalObjectVersionRef[];
  readonly projections: readonly RebuiltProjectionResult[];
}

export interface MemoryRebuildResultManifest {
  readonly kind: "memory_rebuild_result";
  readonly requestId: string;
  readonly completedAt: string;
  readonly authorityWatermark: unknown;
  readonly consumedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly skippedDeletedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly appliedDeletionJobRefs: readonly CanonicalObjectVersionRef[];
  readonly projections: readonly RebuiltProjectionResult[];
}

const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function createMemoryRebuildRequestManifest(
  input: MemoryRebuildRequestInput,
): MemoryRebuildRequestManifest {
  assertNonEmpty(input.requestId, "requestId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertCanonicalInstant(input.requestedAt, "requestedAt");
  const sourceArtifactRefs = normalizeRefs(
    input.sourceArtifactRefs,
    new Set(["SourceArtifact", "ArtifactVersion"]),
    "sourceArtifactRefs",
  );
  if (sourceArtifactRefs.length === 0) {
    throw new TypeError("sourceArtifactRefs must be nonempty");
  }
  const projections = normalizeProjectionConfigs(input.projections);
  if (projections.length === 0) {
    throw new TypeError("projections must be nonempty");
  }
  return Object.freeze({
    kind: "memory_rebuild_request",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    requestedAt: input.requestedAt,
    authorityWatermark: input.authorityWatermark,
    sourceArtifactRefs,
    projections,
  });
}

export function createMemoryRebuildResultManifest(
  input: MemoryRebuildResultInput,
): MemoryRebuildResultManifest {
  if (input.request.kind !== "memory_rebuild_request") {
    throw new TypeError("request must be a memory rebuild request manifest");
  }
  assertCanonicalInstant(input.completedAt, "completedAt");
  const consumedSourceRefs = normalizeRefs(
    input.consumedSourceRefs,
    new Set(["SourceArtifact", "ArtifactVersion"]),
    "consumedSourceRefs",
  );
  const skippedDeletedSourceRefs = normalizeRefs(
    input.skippedDeletedSourceRefs,
    new Set(["SourceArtifact", "ArtifactVersion"]),
    "skippedDeletedSourceRefs",
  );
  const appliedDeletionJobRefs = normalizeRefs(
    input.appliedDeletionJobRefs,
    new Set(["DeletionJob"]),
    "appliedDeletionJobRefs",
  );
  assertCompletePartition(
    input.request.sourceArtifactRefs,
    consumedSourceRefs,
    skippedDeletedSourceRefs,
  );
  if (skippedDeletedSourceRefs.length > 0 && appliedDeletionJobRefs.length === 0) {
    throw new TypeError("deleted source skips require an applied DeletionJob reference");
  }
  const projections = normalizeProjectionResults(
    input.projections,
    input.request.projections,
  );
  return Object.freeze({
    kind: "memory_rebuild_result",
    requestId: input.request.requestId,
    completedAt: input.completedAt,
    authorityWatermark: input.authorityWatermark,
    consumedSourceRefs,
    skippedDeletedSourceRefs,
    appliedDeletionJobRefs,
    projections,
  });
}

function normalizeProjectionConfigs(
  configs: readonly DerivedProjectionConfig[],
): readonly DerivedProjectionConfig[] {
  const byKind = new Map<RebuildProjectionKind, DerivedProjectionConfig>();
  for (const config of configs) {
    if (!REBUILD_PROJECTION_KINDS.includes(config.kind)) {
      throw new TypeError(`unsupported rebuild projection: ${String(config.kind)}`);
    }
    if (byKind.has(config.kind)) throw new TypeError(`duplicate projection: ${config.kind}`);
    if (!SEMVER_PATTERN.test(config.implementationVersion)) {
      throw new TypeError(`invalid implementationVersion for ${config.kind}`);
    }
    const normalized: DerivedProjectionConfig = {
      kind: config.kind,
      implementationVersion: config.implementationVersion,
      configurationSha256: assertSha256(config.configurationSha256),
      ...(config.artifactRef === undefined
        ? {}
        : { artifactRef: copyTypedRef(config.artifactRef, new Set(["SourceArtifact", "ArtifactVersion"]), "artifactRef") }),
    };
    byKind.set(config.kind, Object.freeze(normalized));
  }
  return Object.freeze([...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind)));
}

function copyTypedRef(
  value: CanonicalObjectVersionRef,
  allowedTypes: ReadonlySet<string>,
  field: string,
): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  if (!allowedTypes.has(ref.refType)) {
    throw new TypeError(`${field} contains disallowed ref type ${ref.refType}`);
  }
  return copyRef(ref);
}

function normalizeProjectionResults(
  results: readonly RebuiltProjectionResult[],
  expected: readonly DerivedProjectionConfig[],
): readonly RebuiltProjectionResult[] {
  const expectedByKind = new Map(expected.map((item) => [item.kind, item]));
  const byKind = new Map<RebuildProjectionKind, RebuiltProjectionResult>();
  for (const result of results) {
    const config = expectedByKind.get(result.kind);
    if (config === undefined) throw new TypeError(`unexpected projection result: ${result.kind}`);
    if (byKind.has(result.kind)) throw new TypeError(`duplicate projection result: ${result.kind}`);
    if (!Number.isSafeInteger(result.recordCount) || result.recordCount < 0) {
      throw new TypeError(`recordCount must be a nonnegative safe integer for ${result.kind}`);
    }
    const configurationSha256 = assertSha256(result.configurationSha256);
    if (configurationSha256 !== config.configurationSha256) {
      throw new TypeError(`configuration hash mismatch for ${result.kind}`);
    }
    byKind.set(result.kind, Object.freeze({
      kind: result.kind,
      configurationSha256,
      projectionSha256: assertSha256(result.projectionSha256),
      recordCount: result.recordCount,
    }));
  }
  if (byKind.size !== expectedByKind.size) {
    throw new TypeError("projection results do not cover the requested projection set");
  }
  return Object.freeze([...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind)));
}

function normalizeRefs(
  values: readonly CanonicalObjectVersionRef[],
  allowedTypes: ReadonlySet<string>,
  field: string,
): readonly CanonicalObjectVersionRef[] {
  const refs = new Map<string, CanonicalObjectVersionRef>();
  for (const value of values) {
    const ref = assertCanonicalObjectVersionRef(value);
    if (!allowedTypes.has(ref.refType)) {
      throw new TypeError(`${field} contains disallowed ref type ${ref.refType}`);
    }
    const key = canonicalRefKey(ref);
    if (refs.has(key)) throw new TypeError(`${field} contains duplicate ref ${key}`);
    refs.set(key, copyRef(ref));
  }
  return Object.freeze([...refs.values()].sort(compareCanonicalObjectVersionRefs));
}

function assertCompletePartition(
  expected: readonly CanonicalObjectVersionRef[],
  consumed: readonly CanonicalObjectVersionRef[],
  skipped: readonly CanonicalObjectVersionRef[],
): void {
  const expectedKeys = new Set(expected.map(canonicalRefKey));
  const consumedKeys = new Set(consumed.map(canonicalRefKey));
  const skippedKeys = new Set(skipped.map(canonicalRefKey));
  for (const key of consumedKeys) {
    if (!expectedKeys.has(key)) throw new TypeError(`consumed ref is outside request: ${key}`);
    if (skippedKeys.has(key)) throw new TypeError(`ref cannot be consumed and skipped: ${key}`);
  }
  for (const key of skippedKeys) {
    if (!expectedKeys.has(key)) throw new TypeError(`skipped ref is outside request: ${key}`);
  }
  if (consumedKeys.size + skippedKeys.size !== expectedKeys.size) {
    throw new TypeError("every requested source ref must be consumed or skipped as deleted");
  }
}

function copyRef(ref: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must be nonempty`);
}

function assertCanonicalInstant(value: string, field: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}|\d{6}))?Z$/.exec(value);
  if (match === null) {
    throw new TypeError(`${field} must be a canonical UTC instant`);
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
    throw new TypeError(`${field} must be a canonical UTC instant`);
  }
}
