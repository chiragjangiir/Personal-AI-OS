import { createHash } from "node:crypto";

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
  MemoryKind,
  MemoryVersionRecord,
  ReadonlyJsonValue,
} from "./domain.ts";
import {
  createMemoryRebuildRequestManifest,
  createMemoryRebuildResultManifest,
  type DerivedProjectionConfig,
  type MemoryRebuildRequestManifest,
  type MemoryRebuildResultManifest,
  type RebuiltProjectionResult,
  REBUILD_PROJECTION_KINDS,
  type RebuildProjectionKind,
} from "./rebuild-manifest.ts";

/**
 * T05's derived projection seam.  Providers may keep only this ref, their
 * provider payload, configuration identity, and an opaque authority
 * watermark.  They never create canonical memory identity or memory status.
 */
export type DerivedProjectionKind = RebuildProjectionKind;

export const DERIVED_MEMORY_REF_TYPES = Object.freeze([
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
] as const);

const DERIVED_MEMORY_REF_TYPE_SET = new Set<string>(DERIVED_MEMORY_REF_TYPES);
const DERIVED_PROJECTION_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type DerivedProjectionErrorCode =
  | "INVALID_REQUEST"
  | "AUTHORITY_SNAPSHOT_INVALID"
  | "DERIVED_DUPLICATE_REF"
  | "DERIVED_REF_NOT_AUTHORITATIVE"
  | "DERIVED_DELETION_OVERLAY_MISSING"
  | "DERIVED_DELETION_CONFLICT"
  | "DERIVED_WATERMARK_INVALID"
  | "DERIVED_RESULT_MALFORMED"
  | "DERIVED_INDEX_UNAVAILABLE"
  | "DERIVED_IDEMPOTENCY_CONFLICT"
  | "DERIVED_REBUILD_IN_PROGRESS";

export interface DerivedProjectionError {
  readonly code: DerivedProjectionErrorCode;
  readonly retryable: boolean;
  readonly message?: string;
}

export type DerivedProjectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DerivedProjectionError };

export type DerivedProjectionOutcome = "committed" | "replayed";

/** The only row shape a derived provider is allowed to persist. */
export interface DerivedProjectionWriteRow {
  readonly canonicalRef: CanonicalObjectVersionRef;
  readonly providerPayload: ReadonlyJsonValue;
}

export interface DerivedProjectionCommandIdentity {
  readonly operation: "derived_projection";
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly projectionKind: DerivedProjectionKind;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly authorityWatermark: AuthorityWatermark;
  readonly rows: readonly DerivedProjectionWriteRow[];
  readonly deletionOverlay: DerivedDeletionOverlay;
}

export interface DerivedProjectionWriteRequest extends DerivedProjectionCommandIdentity {
  readonly requestFingerprint: Sha256;
}

export interface DerivedProjectionWriteReceipt {
  readonly kind: "derived_projection_receipt";
  readonly outcome: DerivedProjectionOutcome;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: Sha256;
  readonly projectionKind: DerivedProjectionKind;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly authorityWatermark: AuthorityWatermark;
  readonly canonicalRefs: readonly CanonicalObjectVersionRef[];
  readonly projectionSha256: Sha256;
  readonly recordCount: number;
}

/** T03/T02 deletion projection; T05 only consumes this opaque overlay. */
export interface DerivedDeletionOverlay {
  readonly deletedRefs: readonly CanonicalObjectVersionRef[];
  readonly appliedDeletionJobRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
}

export interface DerivedRebuildCommandIdentity {
  readonly operation: "derived_rebuild";
  readonly request: MemoryRebuildRequestManifest;
  readonly sourceArtifactRefs: readonly CanonicalObjectVersionRef[];
  readonly deletionOverlay: DerivedDeletionOverlay;
}

export interface DerivedProjectionRebuildPortRequest extends DerivedRebuildCommandIdentity {
  readonly requestFingerprint: Sha256;
}

export interface DerivedProjectionRebuildPortResult {
  readonly completedAt: string;
  readonly authorityWatermark: AuthorityWatermark;
  readonly consumedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly skippedDeletedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly appliedDeletionJobRefs: readonly CanonicalObjectVersionRef[];
  readonly projections: readonly RebuiltProjectionResult[];
}

export interface DerivedProjectionRebuildPortReceipt {
  readonly outcome: DerivedProjectionOutcome;
  readonly result: DerivedProjectionRebuildPortResult;
}

/**
 * Storage-neutral provider port. T02/runtime adapters implement durability;
 * the unit fake is deliberately volatile. Each method is one atomic operation:
 * an error must leave generation, rows, and replay ledger unchanged. T05
 * validates the returned receipt, but cannot roll back a malicious adapter.
 */
export interface DerivedProjectionStore {
  writeProjection(
    input: DerivedProjectionWriteRequest,
  ): Promise<DerivedProjectionResult<DerivedProjectionWriteReceipt>>;

  rebuildProjection(
    input: DerivedProjectionRebuildPortRequest,
  ): Promise<DerivedProjectionResult<DerivedProjectionRebuildPortReceipt>>;
}

export interface DerivedProjectionBuildInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: Sha256;
  readonly projectionKind: DerivedProjectionKind;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly authorityWatermark: AuthorityWatermark;
  /** Authority rows are used for validation only; their content is not returned by a provider. */
  readonly authorityRecords: readonly MemoryVersionRecord[];
  readonly materials: readonly DerivedProjectionWriteRow[];
  /** Required even when empty, so a missing deletion view fails closed. */
  readonly deletionOverlay?: DerivedDeletionOverlay;
}

export interface DerivedRebuildInput {
  readonly request: MemoryRebuildRequestManifest;
  readonly requestFingerprint: Sha256;
  readonly sourceArtifactRefs: readonly CanonicalObjectVersionRef[];
  readonly deletionOverlay?: DerivedDeletionOverlay;
}

export interface DerivedRebuildReceipt {
  readonly kind: "derived_rebuild_receipt";
  readonly outcome: DerivedProjectionOutcome;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: Sha256;
  readonly result: MemoryRebuildResultManifest;
}

export interface DerivedProjectionApplicationService {
  project(input: DerivedProjectionBuildInput): Promise<DerivedProjectionResult<DerivedProjectionWriteReceipt>>;
  rebuild(input: DerivedRebuildInput): Promise<DerivedProjectionResult<DerivedRebuildReceipt>>;
}

const MEMORY_REF_TYPE_BY_KIND: Readonly<Record<MemoryKind, CanonicalObjectVersionRef["refType"]>> = {
  semantic_fact: "SemanticFact",
  episodic_memory: "EpisodicMemory",
  preference_memory: "PreferenceMemory",
  open_loop: "OpenLoop",
};

function fail(
  code: DerivedProjectionErrorCode,
  retryable = false,
  message?: string,
): DerivedProjectionResult<never> {
  return { ok: false, error: { code, retryable, ...(message === undefined ? {} : { message }) } };
}

/**
 * Store adapters are an untrusted boundary.  Only these T05-owned error
 * identities and their fixed retryability are allowed to cross it.  In
 * particular, an adapter cannot smuggle a message or invent a retry policy.
 */
const STORE_ERROR_RETRYABILITY: Readonly<Record<DerivedProjectionErrorCode, boolean>> = Object.freeze({
  INVALID_REQUEST: false,
  AUTHORITY_SNAPSHOT_INVALID: false,
  DERIVED_DUPLICATE_REF: false,
  DERIVED_REF_NOT_AUTHORITATIVE: false,
  DERIVED_DELETION_OVERLAY_MISSING: false,
  DERIVED_DELETION_CONFLICT: false,
  DERIVED_WATERMARK_INVALID: false,
  DERIVED_RESULT_MALFORMED: false,
  DERIVED_INDEX_UNAVAILABLE: true,
  DERIVED_IDEMPOTENCY_CONFLICT: false,
  DERIVED_REBUILD_IN_PROGRESS: true,
});

function normalizeStoreError(value: unknown): DerivedProjectionError {
  if (!isRecord(value) || typeof value.code !== "string" ||
      !Object.prototype.hasOwnProperty.call(STORE_ERROR_RETRYABILITY, value.code) ||
      typeof value.retryable !== "boolean") {
    return { code: "DERIVED_RESULT_MALFORMED", retryable: false };
  }
  const code = value.code as DerivedProjectionErrorCode;
  const retryable = STORE_ERROR_RETRYABILITY[code];
  if (value.retryable !== retryable) {
    return { code: "DERIVED_RESULT_MALFORMED", retryable: false };
  }
  return { code, retryable };
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

function cloneJson(value: ReadonlyJsonValue): ReadonlyJsonValue {
  return derivedCloneStableJson(value) as ReadonlyJsonValue;
}

function cloneRows(rows: readonly DerivedProjectionWriteRow[]): readonly DerivedProjectionWriteRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    canonicalRef: cloneRef(row.canonicalRef),
    providerPayload: cloneJson(row.providerPayload),
  })));
}

function cloneStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite value is not stable");
    return value;
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("value is not stable JSON");
  if (seen.has(value)) throw new TypeError("cyclic value is not stable");
  seen.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const enumerableNames = new Set(Object.keys(value));
    for (const name of names) {
      if (name === "length") continue;
      const index = Number(name);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name ||
          index >= value.length || !enumerableNames.has(name)) {
        throw new TypeError("array contains a sparse, extra, or non-enumerable property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw new TypeError("array contains an accessor");
      }
    }
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("array contains a hole");
      copy.push(cloneStableJson(value[index], seen));
    }
    seen.delete(value);
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non-plain object is not stable");
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    throw new TypeError("object contains a symbol property");
  }
  const names = Object.getOwnPropertyNames(value);
  const enumerableNames = new Set(Object.keys(value));
  if (names.some((name) => !enumerableNames.has(name))) {
    throw new TypeError("object contains a non-enumerable property");
  }
  const copy: Record<string, unknown> = {};
  for (const name of [...enumerableNames].sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw new TypeError("object contains an accessor");
    }
    Object.defineProperty(copy, name, {
      configurable: true,
      enumerable: true,
      value: cloneStableJson((value as Record<string, unknown>)[name], seen),
      writable: true,
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function stableSerialize(value: unknown): string {
  const frozen = cloneStableJson(value);
  return serializeFrozenJson(frozen);
}

function serializeFrozenJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serializeFrozenJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${serializeFrozenJson(record[key])}`,
  ).join(",")}}`;
}

function digestStable(value: unknown): Sha256 {
  return assertSha256(createHash("sha256").update(stableSerialize(value), "utf8").digest("hex"));
}

function isOpaqueWatermark(value: unknown): boolean {
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) return false;
  try {
    stableSerialize(value);
    return true;
  } catch {
    return false;
  }
}

function sameOpaqueValue(left: unknown, right: unknown): boolean {
  try {
    return stableSerialize(left) === stableSerialize(right);
  } catch {
    return false;
  }
}

/** Strict JSON clone/freeze helper used by watermark, command and provider seams. */
export function derivedCloneStableJson<T>(value: T): T {
  return cloneStableJson(value) as T;
}

/** Stable digest of the complete normalized projection command identity. */
export function fingerprintDerivedProjectionCommand(
  identity: DerivedProjectionCommandIdentity,
): Sha256 {
  return digestStable(identity);
}

/** Stable digest of the complete normalized rebuild command identity. */
export function fingerprintDerivedRebuildCommand(
  identity: DerivedRebuildCommandIdentity,
): Sha256 {
  return digestStable(identity);
}

function validMemoryRef(value: unknown): value is CanonicalObjectVersionRef {
  try {
    const ref = assertCanonicalObjectVersionRef(value);
    return DERIVED_MEMORY_REF_TYPE_SET.has(ref.refType);
  } catch {
    return false;
  }
}

function validSourceRef(value: unknown): value is CanonicalObjectVersionRef {
  try {
    const ref = assertCanonicalObjectVersionRef(value);
    return ref.refType === "SourceArtifact" || ref.refType === "ArtifactVersion";
  } catch {
    return false;
  }
}

function validDeletionJobRef(value: unknown): value is CanonicalObjectVersionRef {
  try {
    return assertCanonicalObjectVersionRef(value).refType === "DeletionJob";
  } catch {
    return false;
  }
}

function exactRefSet(
  left: readonly CanonicalObjectVersionRef[],
  right: readonly CanonicalObjectVersionRef[],
): boolean {
  const leftKeys = left.map(canonicalRefKey);
  const rightKeys = right.map(canonicalRefKey);
  if (leftKeys.length !== rightKeys.length) return false;
  const leftSet = new Set(leftKeys);
  const rightSet = new Set(rightKeys);
  if (leftSet.size !== leftKeys.length || rightSet.size !== rightKeys.length) return false;
  return [...leftSet].every((key) => rightSet.has(key));
}

function normalizeRefs(
  values: readonly CanonicalObjectVersionRef[],
  validator: (value: unknown) => boolean,
  field: string,
): readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  const refs = values.map((value) => {
    const ref = assertCanonicalObjectVersionRef(value);
    if (!validator(ref)) throw new TypeError(`${field} contains a disallowed ref`);
    return cloneRef(ref);
  });
  const keys = refs.map(canonicalRefKey);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${field} contains duplicate refs`);
  return Object.freeze(refs.sort(compareCanonicalObjectVersionRefs));
}

function normalizeOverlay(
  input: DerivedDeletionOverlay,
  deletedRefValidator: (value: unknown) => boolean,
): DerivedDeletionOverlay {
  if (!isRecord(input) || !isOpaqueWatermark(input.authorityWatermark)) {
    throw new TypeError("deletion overlay watermark is missing or invalid");
  }
  const deletedRefs = normalizeRefs(input.deletedRefs, deletedRefValidator, "deletionOverlay.deletedRefs");
  const appliedDeletionJobRefs = normalizeRefs(
    input.appliedDeletionJobRefs,
    validDeletionJobRef,
    "deletionOverlay.appliedDeletionJobRefs",
  );
  if (deletedRefs.length > 0 && appliedDeletionJobRefs.length === 0) {
    throw new TypeError("deleted refs require an applied DeletionJob ref");
  }
  return Object.freeze({
    deletedRefs,
    appliedDeletionJobRefs,
    authorityWatermark: derivedCloneStableJson(input.authorityWatermark),
  });
}

function normalizeMaterials(
  materials: readonly DerivedProjectionWriteRow[],
): readonly DerivedProjectionWriteRow[] {
  if (!Array.isArray(materials)) throw new TypeError("materials must be an array");
  const normalized = materials.map((row) => {
    if (!isRecord(row) || !validMemoryRef(row.canonicalRef)) {
      throw new TypeError("projection material must contain a memory canonical ref");
    }
    const providerPayload = row.providerPayload as ReadonlyJsonValue;
    stableSerialize(providerPayload);
    return Object.freeze({
      canonicalRef: cloneRef(row.canonicalRef),
      providerPayload: cloneJson(providerPayload),
    });
  });
  const keys = normalized.map((row) => canonicalRefKey(row.canonicalRef));
  if (new Set(keys).size !== keys.length) throw new TypeError("projection materials contain duplicate refs");
  return Object.freeze(normalized.sort((left, right) =>
    compareCanonicalObjectVersionRefs(left.canonicalRef, right.canonicalRef)));
}

function validateAuthorityRows(
  records: readonly MemoryVersionRecord[],
  materials: readonly DerivedProjectionWriteRow[],
  overlay: DerivedDeletionOverlay,
): void {
  if (!Array.isArray(records)) throw new TypeError("authorityRecords must be an array");
  const byRef = new Map<string, MemoryVersionRecord>();
  for (const record of records) {
    const ref = assertCanonicalObjectVersionRef(record.ref);
    if (!validMemoryRef(ref)) throw new TypeError("authority record is not a memory ref");
    const key = canonicalRefKey(ref);
    if (byRef.has(key)) throw new TypeError("authority snapshot contains duplicate refs");
    byRef.set(key, record);
  }
  const deleted = new Set(overlay.deletedRefs.map(canonicalRefKey));
  for (const material of materials) {
    const key = canonicalRefKey(material.canonicalRef);
    if (deleted.has(key)) throw new Error("projection material is covered by deletion overlay");
    const record = byRef.get(key);
    if (record === undefined || canonicalRefKey(record.ref) !== key ||
        record.status !== "current" || record.current !== true || record.stale === true ||
        record.deletedAt !== undefined || record.suppressedAt !== undefined ||
        record.ref.refType !== MEMORY_REF_TYPE_BY_KIND[record.kind]) {
      throw new Error("projection material is not an active authoritative memory");
    }
  }
}

function normalizeBuildInput(input: DerivedProjectionBuildInput): DerivedProjectionWriteRequest {
  if (!isRecord(input) || !nonEmpty(input.requestId) || !nonEmpty(input.idempotencyKey) ||
      !REBUILD_PROJECTION_KINDS.includes(input.projectionKind) ||
      !DERIVED_PROJECTION_VERSION.test(input.implementationVersion)) {
    throw new TypeError("projection request identity is invalid");
  }
  const requestFingerprint = assertSha256(input.requestFingerprint);
  const configurationSha256 = assertSha256(input.configurationSha256);
  if (!isOpaqueWatermark(input.authorityWatermark)) throw new TypeError("authority watermark is invalid");
  const overlay = input.deletionOverlay === undefined
    ? undefined
    : normalizeOverlay(input.deletionOverlay, validMemoryRef);
  if (overlay === undefined) throw new Error("deletion overlay is required");
  if (!sameOpaqueValue(overlay.authorityWatermark, input.authorityWatermark)) {
    throw new Error("deletion overlay watermark does not match authority watermark");
  }
  const materials = normalizeMaterials(input.materials);
  validateAuthorityRows(input.authorityRecords, materials, overlay);
  const normalizedRequestId = input.requestId.trim();
  const normalizedIdempotencyKey = input.idempotencyKey.trim();
  const authorityWatermark = derivedCloneStableJson(input.authorityWatermark);
  const identity: DerivedProjectionCommandIdentity = Object.freeze({
    operation: "derived_projection",
    requestId: normalizedRequestId,
    idempotencyKey: normalizedIdempotencyKey,
    projectionKind: input.projectionKind,
    implementationVersion: input.implementationVersion,
    configurationSha256,
    authorityWatermark,
    rows: cloneRows(materials),
    deletionOverlay: overlay,
  });
  if (fingerprintDerivedProjectionCommand(identity) !== requestFingerprint) {
    throw new Error("projection request fingerprint does not match command identity");
  }
  return Object.freeze({
    ...identity,
    requestFingerprint,
  });
}

function cloneReceipt(value: DerivedProjectionWriteReceipt): DerivedProjectionWriteReceipt {
  return Object.freeze({
    kind: "derived_projection_receipt",
    outcome: value.outcome,
    requestId: value.requestId,
    idempotencyKey: value.idempotencyKey,
    requestFingerprint: assertSha256(value.requestFingerprint),
    projectionKind: value.projectionKind,
    implementationVersion: value.implementationVersion,
    configurationSha256: assertSha256(value.configurationSha256),
    authorityWatermark: derivedCloneStableJson(value.authorityWatermark),
    canonicalRefs: Object.freeze(value.canonicalRefs.map(cloneRef)),
    projectionSha256: assertSha256(value.projectionSha256),
    recordCount: value.recordCount,
  });
}

function validateWriteReceipt(
  value: unknown,
  input: DerivedProjectionWriteRequest,
): DerivedProjectionWriteReceipt | undefined {
  if (!isRecord(value) || value.kind !== "derived_projection_receipt" ||
      (value.outcome !== "committed" && value.outcome !== "replayed") ||
      value.requestId !== input.requestId || value.idempotencyKey !== input.idempotencyKey ||
      value.requestFingerprint !== input.requestFingerprint || value.projectionKind !== input.projectionKind ||
      value.implementationVersion !== input.implementationVersion ||
      value.configurationSha256 !== input.configurationSha256 ||
      !isOpaqueWatermark(value.authorityWatermark) ||
      !sameOpaqueValue(value.authorityWatermark, input.authorityWatermark) ||
      !Array.isArray(value.canonicalRefs) || value.canonicalRefs.length !== input.rows.length ||
      !Number.isSafeInteger(value.recordCount) || value.recordCount !== input.rows.length) {
    return undefined;
  }
  let refs: readonly CanonicalObjectVersionRef[];
  try {
    refs = normalizeRefs(value.canonicalRefs as readonly CanonicalObjectVersionRef[], validMemoryRef, "receipt.canonicalRefs");
    if (!exactRefSet(refs, input.rows.map((row) => row.canonicalRef))) return undefined;
    const projectionSha256 = assertSha256(value.projectionSha256);
    return cloneReceipt({
      kind: "derived_projection_receipt",
      outcome: value.outcome,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      projectionKind: input.projectionKind,
      implementationVersion: input.implementationVersion,
      configurationSha256: input.configurationSha256,
      authorityWatermark: input.authorityWatermark,
      canonicalRefs: refs,
      projectionSha256,
      recordCount: input.rows.length,
    });
  } catch {
    return undefined;
  }
}

function normalizeRebuildInput(input: DerivedRebuildInput): DerivedProjectionRebuildPortRequest {
  if (!isRecord(input) || !isRecord(input.request)) throw new TypeError("rebuild request is invalid");
  const rawRequest = createMemoryRebuildRequestManifest(input.request);
  const request = createMemoryRebuildRequestManifest({
    ...rawRequest,
    authorityWatermark: derivedCloneStableJson(rawRequest.authorityWatermark),
  });
  const requestFingerprint = assertSha256(input.requestFingerprint);
  const sourceArtifactRefs = normalizeRefs(input.sourceArtifactRefs, validSourceRef, "sourceArtifactRefs");
  if (!exactRefSet(sourceArtifactRefs, request.sourceArtifactRefs)) {
    throw new Error("source refs do not exactly cover the rebuild request");
  }
  if (input.deletionOverlay === undefined) throw new Error("deletion overlay is required");
  const deletionOverlay = normalizeOverlay(input.deletionOverlay, validSourceRef);
  if (!sameOpaqueValue(deletionOverlay.authorityWatermark, request.authorityWatermark)) {
    throw new Error("deletion overlay watermark does not match rebuild request");
  }
  const deletedSourceRefs = normalizeRefs(deletionOverlay.deletedRefs, validSourceRef, "deletionOverlay.deletedRefs");
  if (!deletedSourceRefs.every((ref) => request.sourceArtifactRefs.some((candidate) => canonicalRefKey(candidate) === canonicalRefKey(ref)))) {
    throw new Error("deletion overlay ref is outside the rebuild request");
  }
  const identity: DerivedRebuildCommandIdentity = Object.freeze({
    operation: "derived_rebuild",
    request,
    sourceArtifactRefs,
    deletionOverlay: Object.freeze({ ...deletionOverlay, deletedRefs: deletedSourceRefs }),
  });
  if (fingerprintDerivedRebuildCommand(identity) !== requestFingerprint) {
    throw new Error("rebuild request fingerprint does not match command identity");
  }
  return Object.freeze({ ...identity, requestFingerprint });
}

function cloneRebuildPortResult(value: DerivedProjectionRebuildPortResult): DerivedProjectionRebuildPortResult {
  return Object.freeze({
    completedAt: value.completedAt,
    authorityWatermark: derivedCloneStableJson(value.authorityWatermark),
    consumedSourceRefs: Object.freeze(value.consumedSourceRefs.map(cloneRef)),
    skippedDeletedSourceRefs: Object.freeze(value.skippedDeletedSourceRefs.map(cloneRef)),
    appliedDeletionJobRefs: Object.freeze(value.appliedDeletionJobRefs.map(cloneRef)),
    projections: Object.freeze(value.projections.map((projection) => Object.freeze({
      kind: projection.kind,
      configurationSha256: assertSha256(projection.configurationSha256),
      projectionSha256: assertSha256(projection.projectionSha256),
      recordCount: projection.recordCount,
    }))),
  });
}

function validateRebuildPortReceipt(
  value: unknown,
  input: DerivedProjectionRebuildPortRequest,
): DerivedRebuildReceipt | undefined {
  if (!isRecord(value) || (value.outcome !== "committed" && value.outcome !== "replayed") ||
      !isRecord(value.result)) return undefined;
  try {
    const raw = value.result as unknown as DerivedProjectionRebuildPortResult;
    const normalized = cloneRebuildPortResult(raw);
    const result = createMemoryRebuildResultManifest({
      request: input.request,
      completedAt: normalized.completedAt,
      authorityWatermark: normalized.authorityWatermark,
      consumedSourceRefs: normalized.consumedSourceRefs,
      skippedDeletedSourceRefs: normalized.skippedDeletedSourceRefs,
      appliedDeletionJobRefs: normalized.appliedDeletionJobRefs,
      projections: normalized.projections,
    });
    if (!sameOpaqueValue(result.authorityWatermark, input.request.authorityWatermark) ||
        !exactRefSet(result.skippedDeletedSourceRefs, input.deletionOverlay.deletedRefs) ||
        !exactRefSet(result.appliedDeletionJobRefs, input.deletionOverlay.appliedDeletionJobRefs)) {
      return undefined;
    }
    return Object.freeze({
      kind: "derived_rebuild_receipt",
      outcome: value.outcome,
      requestId: input.request.requestId,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      result,
    });
  } catch {
    return undefined;
  }
}

export function createDerivedProjectionApplicationService(
  store: DerivedProjectionStore,
): DerivedProjectionApplicationService {
  if (!store || typeof store.writeProjection !== "function" || typeof store.rebuildProjection !== "function") {
    throw new TypeError("derived projection store is required");
  }
  return {
    project: async (input) => {
      let request: DerivedProjectionWriteRequest;
      try {
        request = normalizeBuildInput(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "projection request is invalid";
        const code: DerivedProjectionErrorCode = message.includes("covered by deletion")
          ? "DERIVED_DELETION_CONFLICT"
          : message.includes("deletion overlay")
            ? "DERIVED_DELETION_OVERLAY_MISSING"
            : message.includes("active authoritative")
              ? "DERIVED_REF_NOT_AUTHORITATIVE"
            : message.includes("watermark")
              ? "DERIVED_WATERMARK_INVALID"
              : message.includes("duplicate")
                ? "DERIVED_DUPLICATE_REF"
                : "INVALID_REQUEST";
        return fail(code, false, message);
      }
      let result: DerivedProjectionResult<DerivedProjectionWriteReceipt>;
      try {
        result = await store.writeProjection(request);
      } catch {
        return fail("DERIVED_INDEX_UNAVAILABLE", true, "projection store unavailable");
      }
      if (!result.ok) return { ok: false, error: normalizeStoreError(result.error) };
      const receipt = validateWriteReceipt(result.value, request);
      return receipt === undefined
        ? fail("DERIVED_RESULT_MALFORMED", false, "projection provider receipt is invalid")
        : { ok: true, value: receipt };
    },
    rebuild: async (input) => {
      let request: DerivedProjectionRebuildPortRequest;
      try {
        request = normalizeRebuildInput(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "rebuild request is invalid";
        const code: DerivedProjectionErrorCode = message.includes("deletion overlay")
          ? "DERIVED_DELETION_OVERLAY_MISSING"
          : message.includes("watermark")
            ? "DERIVED_WATERMARK_INVALID"
            : message.includes("duplicate")
              ? "DERIVED_DUPLICATE_REF"
              : "INVALID_REQUEST";
        return fail(code, false, message);
      }
      let result: DerivedProjectionResult<DerivedProjectionRebuildPortReceipt>;
      try {
        result = await store.rebuildProjection(request);
      } catch {
        return fail("DERIVED_INDEX_UNAVAILABLE", true, "rebuild store unavailable");
      }
      if (!result.ok) return { ok: false, error: normalizeStoreError(result.error) };
      const receipt = validateRebuildPortReceipt(result.value, request);
      return receipt === undefined
        ? fail("DERIVED_RESULT_MALFORMED", false, "rebuild provider result is invalid")
        : { ok: true, value: receipt };
    },
  };
}

/** Exposed for unit fakes and tests; it is not a wire serializer. */
export function derivedStableSerialize(value: unknown): string {
  return stableSerialize(value);
}

/** Exposed for provider adapters that need opaque watermark equality only. */
export function derivedWatermarksEqual(left: unknown, right: unknown): boolean {
  return sameOpaqueValue(left, right);
}

/** Normalize a T05 projection config without creating any canonical identity. */
export function normalizeDerivedProjectionConfig(
  config: DerivedProjectionConfig,
): DerivedProjectionConfig {
  if (!isRecord(config) || !DERIVED_PROJECTION_VERSION.test(config.implementationVersion)) {
    throw new TypeError("projection implementationVersion is invalid");
  }
  if (!REBUILD_PROJECTION_KINDS.includes(config.kind)) {
    throw new TypeError("projection kind is invalid");
  }
  return Object.freeze({
    kind: config.kind,
    implementationVersion: config.implementationVersion,
    configurationSha256: assertSha256(config.configurationSha256),
    ...(config.artifactRef === undefined ? {} : { artifactRef: cloneRef(config.artifactRef) }),
  });
}
