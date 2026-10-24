import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../memory-os/src/canonical-ref.ts";
import {
  MEMORY_KINDS,
  type MemoryCandidateRecord,
  type MemoryKind,
  type MemoryVersionRecord,
  type ReadonlyJsonValue,
} from "../../memory-os/src/domain.ts";
import type {
  ProductionMemoryIssuerReceipt,
  ProductionMemoryIssuerReceiptProjection,
} from "../../memory-os/src/canonical-issuer.ts";

export const POSITIVE_DECIMAL_TEXT = /^[1-9][0-9]*$/u;
export const UUID_V7_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const SHA256_TEXT = /^[0-9a-f]{64}$/u;

export type MemoryPersistenceValue = ReadonlyJsonValue;

export interface MemoryRefColumns {
  readonly ref_type: CanonicalObjectVersionRef["refType"];
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: Sha256;
}

export interface MemoryAuthorityWatermark {
  /** RFC-010 authoritative PostgreSQL sequence, never coerced to Number. */
  readonly authority_seq: string;
}

/**
 * T02's storage seam for the T05 private receipt brand.
 *
 * T02 may validate, persist, and compare the projection, but it must not
 * import the T05 issuer implementation or reconstruct a receipt from raw
 * database columns.  The production composition injects these operations;
 * tests may inject the real T05 adapter explicitly.
 */
export interface MemoryCanonicalReceiptCodec {
  readonly assertReceipt: (value: unknown) => ProductionMemoryIssuerReceipt;
  readonly projectReceipt: (value: ProductionMemoryIssuerReceipt) => ProductionMemoryIssuerReceiptProjection;
  readonly rehydrateReceipt: (value: unknown) => ProductionMemoryIssuerReceipt;
}

export class MemoryPersistenceError extends Error {
  readonly code: string;
  constructor(code: string, message = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryPersistenceError";
    this.code = code;
  }
}

export function assertPositiveDecimalText(value: unknown, field = "object_version"): string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_TEXT.test(value)) {
    throw new MemoryPersistenceError("INVALID_DECIMAL_TEXT", `${field} must be a positive decimal string`);
  }
  return value;
}

export function assertSha256Text(value: unknown, field = "sha256"): Sha256 {
  if (typeof value !== "string" || !SHA256_TEXT.test(value)) {
    throw new MemoryPersistenceError("INVALID_SHA256", `${field} must be lowercase SHA-256`);
  }
  return assertSha256(value);
}

export function assertUuidV7Text(value: unknown, field = "ref_id"): string {
  if (typeof value !== "string" || !UUID_V7_TEXT.test(value)) {
    throw new MemoryPersistenceError("INVALID_UUID_V7", `${field} must be UUIDv7`);
  }
  return value;
}

export function cloneCanonicalRef(value: unknown): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: assertPositiveDecimalText(ref.objectVersion, "objectVersion") as CanonicalObjectVersionRef["objectVersion"],
    canonicalPayloadSha256: assertSha256Text(ref.canonicalPayloadSha256, "canonicalPayloadSha256"),
  });
}

export function refToColumns(value: unknown): MemoryRefColumns {
  const ref = cloneCanonicalRef(value);
  return Object.freeze({
    ref_type: ref.refType,
    ref_id: assertUuidV7Text(ref.refId),
    object_version: assertPositiveDecimalText(ref.objectVersion),
    canonical_payload_sha256: assertSha256Text(ref.canonicalPayloadSha256),
  });
}

export function refFromColumns(value: unknown, expectedType?: CanonicalObjectVersionRef["refType"]): CanonicalObjectVersionRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryPersistenceError("INVALID_REF_COLUMNS", "reference columns must be an object");
  }
  const row = value as Record<string, unknown>;
  const refType = row.ref_type;
  if (expectedType !== undefined && refType !== expectedType) {
    throw new MemoryPersistenceError("REF_TYPE_MISMATCH", "reference type mismatch");
  }
  const ref = {
    refType,
    refId: row.ref_id,
    objectVersion: row.object_version,
    canonicalPayloadSha256: row.canonical_payload_sha256,
  };
  return cloneCanonicalRef(ref);
}

/** Verify opaque JSON ref and its denormalized columns in both directions. */
export function assertRefColumnEquality(
  opaqueRef: unknown,
  columns: unknown,
  expectedType?: CanonicalObjectVersionRef["refType"],
): CanonicalObjectVersionRef {
  const ref = cloneCanonicalRef(opaqueRef);
  const normalizedColumns = refToColumns(ref);
  const rowColumns = refToColumns(refFromColumns(columns, expectedType));
  if (normalizedColumns.ref_type !== rowColumns.ref_type ||
      normalizedColumns.ref_id !== rowColumns.ref_id ||
      normalizedColumns.object_version !== rowColumns.object_version ||
      normalizedColumns.canonical_payload_sha256 !== rowColumns.canonical_payload_sha256) {
    throw new MemoryPersistenceError("REF_COLUMN_DRIFT", "opaque reference and columns differ");
  }
  return ref;
}

export function sameCanonicalRef(left: unknown, right: unknown): boolean {
  try {
    const a = refToColumns(left);
    const b = refToColumns(right);
    return a.ref_type === b.ref_type && a.ref_id === b.ref_id &&
      a.object_version === b.object_version &&
      a.canonical_payload_sha256 === b.canonical_payload_sha256;
  } catch {
    return false;
  }
}

/** Convert T05 snake_case canonical refs into the internal camelCase seam. */
export function canonicalWireRefToInternal(
  value: unknown,
  expectedType?: CanonicalObjectVersionRef["refType"],
): CanonicalObjectVersionRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryPersistenceError("INVALID_CANONICAL_REF", "canonical wire ref must be an object");
  }
  const row = value as Record<string, unknown>;
  if (expectedType !== undefined && row.ref_type !== expectedType) {
    throw new MemoryPersistenceError("REF_TYPE_MISMATCH", "canonical wire ref type mismatch");
  }
  return cloneCanonicalRef({
    refType: row.ref_type,
    refId: row.ref_id,
    objectVersion: row.object_version,
    canonicalPayloadSha256: row.canonical_payload_sha256,
  });
}

export function canonicalWireRefsToInternal(value: unknown): readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(value)) throw new MemoryPersistenceError("INVALID_CANONICAL_REF_ARRAY");
  const refs = value.map((item) => canonicalWireRefToInternal(item));
  const keys = refs.map((item) => `${item.refType}:${item.refId}:${item.objectVersion}:${item.canonicalPayloadSha256}`);
  if (new Set(keys).size !== keys.length) throw new MemoryPersistenceError("DUPLICATE_CANONICAL_REF");
  return Object.freeze(refs);
}

export function canonicalWireSensitivityToInternal(value: unknown): ReadonlyJsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryPersistenceError("INVALID_SENSITIVITY");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.classification !== "string" || typeof row.user_confirmed !== "boolean") {
    throw new MemoryPersistenceError("INVALID_SENSITIVITY");
  }
  return stableJsonClone({ classification: row.classification, userConfirmed: row.user_confirmed }) as ReadonlyJsonValue;
}

export function canonicalWireValidityToInternal(value: unknown): ReadonlyJsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryPersistenceError("INVALID_VALIDITY");
  }
  const row = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (row.observed_at !== undefined) result.observedAt = row.observed_at;
  if (row.starts_at !== undefined) result.validFrom = row.starts_at;
  if (row.ends_at !== undefined) result.validTo = row.ends_at;
  if (Object.keys(result).length === 0) throw new MemoryPersistenceError("INVALID_VALIDITY");
  return stableJsonClone(result) as ReadonlyJsonValue;
}

export function canonicalWireCorrectionToInternal(value: unknown): ReadonlyJsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryPersistenceError("INVALID_CORRECTION_INTENT");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== "string") throw new MemoryPersistenceError("INVALID_CORRECTION_INTENT");
  const result: Record<string, unknown> = { kind: row.kind };
  if (row.target_ref !== undefined) result.target = canonicalWireRefToInternal(row.target_ref);
  if (row.reason !== undefined) result.reason = stableJsonClone(row.reason);
  if (row.evidence_refs !== undefined) result.evidenceRefs = canonicalWireRefsToInternal(row.evidence_refs);
  return stableJsonClone(result) as ReadonlyJsonValue;
}

/** Verify that persisted canonical bytes/body still bind to the T05 receipt. */
function validateCanonicalReceipt(
  value: unknown,
  codec: MemoryCanonicalReceiptCodec,
): { readonly receipt: ProductionMemoryIssuerReceipt; readonly projection: ProductionMemoryIssuerReceiptProjection } {
  try {
    const receipt = codec.assertReceipt(value);
    const projection = codec.projectReceipt(receipt);
    const rehydrated = codec.rehydrateReceipt(projection);
    const roundTrip = codec.projectReceipt(rehydrated);
    if (projection.projectionJcs !== roundTrip.projectionJcs ||
        projection.projectionSha256 !== roundTrip.projectionSha256 ||
        projection.canonicalPayloadJcs !== roundTrip.canonicalPayloadJcs ||
        projection.canonicalPayloadSha256 !== roundTrip.canonicalPayloadSha256 ||
        !stableJsonEqual(projection, roundTrip)) {
      throw new MemoryPersistenceError("CANONICAL_RECEIPT_DRIFT");
    }
    return Object.freeze({ receipt, projection });
  } catch (error) {
    if (error instanceof MemoryPersistenceError && error.code === "CANONICAL_RECEIPT_DRIFT") throw error;
    throw new MemoryPersistenceError("CANONICAL_RECEIPT_DRIFT", "canonical receipt codec rejected the receipt", { cause: error });
  }
}

export function assertCanonicalReceiptPayload(
  value: unknown,
  codec: MemoryCanonicalReceiptCodec,
): ProductionMemoryIssuerReceipt {
  return validateCanonicalReceipt(value, codec).receipt;
}

/** Validate and retain one exact projection for a single transaction. */
export function projectCanonicalReceipt(
  value: unknown,
  codec: MemoryCanonicalReceiptCodec,
): { readonly receipt: ProductionMemoryIssuerReceipt; readonly projection: ProductionMemoryIssuerReceiptProjection } {
  return validateCanonicalReceipt(value, codec);
}

/** Rehydrate only through the injected T05 codec and reject projection drift. */
export function rehydrateCanonicalReceipt(
  value: unknown,
  codec: MemoryCanonicalReceiptCodec,
): ProductionMemoryIssuerReceipt {
  try {
    const receipt = codec.rehydrateReceipt(value);
    const projection = codec.projectReceipt(receipt);
    if (!stableJsonEqual(projection, value)) throw new MemoryPersistenceError("CANONICAL_RECEIPT_DRIFT");
    return receipt;
  } catch (error) {
    if (error instanceof MemoryPersistenceError && error.code === "CANONICAL_RECEIPT_DRIFT") throw error;
    throw new MemoryPersistenceError("CANONICAL_RECEIPT_DRIFT", "canonical receipt projection rejected", { cause: error });
  }
}

export function memoryRefTypeForKind(kind: unknown): CanonicalObjectVersionRef["refType"] {
  switch (kind) {
    case "semantic_fact": return "SemanticFact";
    case "episodic_memory": return "EpisodicMemory";
    case "preference_memory": return "PreferenceMemory";
    case "open_loop": return "OpenLoop";
    default: throw new MemoryPersistenceError("INVALID_MEMORY_KIND", "unknown memory kind");
  }
}

export const memoryKindRefTypeForKind = memoryRefTypeForKind;

export function assertMemoryKind(value: unknown): MemoryKind {
  if (!(MEMORY_KINDS as readonly unknown[]).includes(value)) {
    throw new MemoryPersistenceError("INVALID_MEMORY_KIND", "unknown memory kind");
  }
  return value as MemoryKind;
}

function cloneStable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MemoryPersistenceError("INVALID_JSON", "non-finite JSON number");
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new MemoryPersistenceError("INVALID_JSON", "value is not JSON-compatible");
  }
  if (seen.has(value)) throw new MemoryPersistenceError("INVALID_JSON", "cyclic JSON value");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneStable(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MemoryPersistenceError("INVALID_JSON", "JSON object must be plain");
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = cloneStable((value as Record<string, unknown>)[key], seen);
  seen.delete(value);
  return Object.freeze(result);
}

export function stableJsonClone<T>(value: T): T {
  return cloneStable(value) as T;
}

export function stableJsonText(value: unknown): string {
  return JSON.stringify(cloneStable(value));
}

export function stableJsonHash(value: unknown): Sha256 {
  return assertSha256(createHash("sha256").update(stableJsonText(value), "utf8").digest("hex"));
}

export function stableJsonEqual(left: unknown, right: unknown): boolean {
  try { return stableJsonText(left) === stableJsonText(right); } catch { return false; }
}

export function parseJsonValue(value: unknown, field: string): ReadonlyJsonValue {
  return stableJsonClone(value) as ReadonlyJsonValue;
}

export function dateToCanonical(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new MemoryPersistenceError("INVALID_TIMESTAMP", `${field} is invalid`);
  return date.toISOString();
}

export function optionalDateToCanonical(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return dateToCanonical(value, field);
}

export function watermarkFromEpoch(value: unknown): MemoryAuthorityWatermark {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_TEXT.test(value)) {
    throw new MemoryPersistenceError("INVALID_WATERMARK", "authority_seq must be a positive decimal string");
  }
  return Object.freeze({ authority_seq: value });
}

/** RFC-010 exact shape used at every durable owner boundary. */
export function assertAuthorityWatermark(value: unknown): MemoryAuthorityWatermark {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryPersistenceError("INVALID_WATERMARK", "authority watermark must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new MemoryPersistenceError("INVALID_WATERMARK", "authority watermark must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "authority_seq") {
    throw new MemoryPersistenceError("INVALID_WATERMARK", "authority watermark must be RFC-010 authority_seq only");
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, "authority_seq");
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
    throw new MemoryPersistenceError("INVALID_WATERMARK", "authority_seq must be a data property");
  }
  return watermarkFromEpoch(record.authority_seq);
}

export function watermarkFromRow(row: QueryResultRow): MemoryAuthorityWatermark {
  return watermarkFromEpoch(row.watermark);
}

export function memoryKindRefMatches(kind: MemoryKind, ref: CanonicalObjectVersionRef): boolean {
  return ref.refType === memoryRefTypeForKind(kind);
}

export function asCandidateRecord(row: QueryResultRow): MemoryCandidateRecord {
  const candidateRef = assertRefColumnEquality(row.candidate_ref, {
    ref_type: row.candidate_ref_type,
    ref_id: row.candidate_ref_id,
    object_version: row.candidate_object_version,
    canonical_payload_sha256: String(row.candidate_payload_sha256).trim(),
  }, "MemoryCandidate");
  const status = row.status;
  if (status !== "candidate" && status !== "accepted" && status !== "quarantined" && status !== "rejected") {
    throw new MemoryPersistenceError("INVALID_CANDIDATE_STATUS");
  }
  const kind = row.kind;
  if (kind !== "create" && kind !== "correct") throw new MemoryPersistenceError("INVALID_CANDIDATE_KIND");
  const memoryKind = assertMemoryKind(row.memory_kind);
  const current = row.current === true;
  if (current) throw new MemoryPersistenceError("CANDIDATE_CURRENT_FORBIDDEN");
  const record: MemoryCandidateRecord = {
    candidateRef,
    kind,
    status,
    proposalId: String(row.proposal_id),
    slot: String(row.slot),
    value: parseJsonValue(row.value, "value"),
    evidenceRefs: parseRefArray(row.evidence_refs, "evidence_refs"),
    sourceClass: row.source_class,
    confidencePpm: Number(row.confidence_ppm),
    idempotencyKey: String(row.idempotency_key),
    current: false,
    memoryKind,
    userId: String(row.user_id),
    purposeScopes: parseStringArray(row.purpose_scopes, "purpose_scopes"),
    sensitivity: parseJsonValue(row.sensitivity, "sensitivity") as unknown as MemoryCandidateRecord["sensitivity"],
    validity: parseJsonValue(row.validity, "validity") as MemoryCandidateRecord["validity"],
    requiresReview: row.requires_review === true,
    ...(row.target_ref === null || row.target_ref === undefined ? {} : {
      target: assertRefColumnEquality(row.target_ref, {
        ref_type: row.target_ref_type,
        ref_id: row.target_ref_id,
        object_version: row.target_object_version,
        canonical_payload_sha256: String(row.target_payload_sha256).trim(),
      }),
    }),
    ...(row.correction_intent === null || row.correction_intent === undefined ? {} : {
      correctionIntent: parseJsonValue(row.correction_intent, "correction_intent") as unknown as NonNullable<MemoryCandidateRecord["correctionIntent"]>,
    }),
    ...(row.reason === null || row.reason === undefined ? {} : { reason: parseJsonValue(row.reason, "reason") }),
    ...(row.conflict === null || row.conflict === undefined ? {} : { conflict: parseJsonValue(row.conflict, "conflict") }),
    ...(row.conflict_binding === null || row.conflict_binding === undefined ? {} : {
      conflictBinding: parseJsonValue(row.conflict_binding, "conflict_binding") as unknown as NonNullable<MemoryCandidateRecord["conflictBinding"]>,
    }),
    ...(row.linked_memory_ref === null || row.linked_memory_ref === undefined ? {} : {
      linkedMemoryRef: assertRefColumnEquality(row.linked_memory_ref, {
        ref_type: row.linked_memory_ref_type,
        ref_id: row.linked_memory_ref_id,
        object_version: row.linked_memory_object_version,
        canonical_payload_sha256: String(row.linked_memory_payload_sha256).trim(),
      }, memoryKindRefTypeForKind(memoryKind)),
    }),
    ...(row.reviewed_at === null || row.reviewed_at === undefined ? {} : { reviewedAt: dateToCanonical(row.reviewed_at, "reviewed_at") as NonNullable<MemoryCandidateRecord["reviewedAt"]> }),
  };
  return Object.freeze(record);
}

export function asMemoryVersionRecord(row: QueryResultRow): MemoryVersionRecord {
  const ref = assertRefColumnEquality(row.memory_ref, {
    ref_type: row.memory_ref_type,
    ref_id: row.memory_ref_id,
    object_version: row.memory_object_version,
    canonical_payload_sha256: String(row.memory_payload_sha256).trim(),
  });
  const kind = assertMemoryKind(row.kind);
  if (!memoryKindRefMatches(kind, ref)) throw new MemoryPersistenceError("MEMORY_REF_KIND_MISMATCH");
  const status = row.status;
  if (status !== "current" && status !== "superseded" && status !== "disputed" && status !== "suppressed" && status !== "deleted") {
    throw new MemoryPersistenceError("INVALID_MEMORY_STATUS");
  }
  const record: MemoryVersionRecord = {
    ref,
    userId: String(row.user_id),
    kind,
    slot: String(row.slot),
    value: parseJsonValue(row.value, "value"),
    resolvedContent: String(row.resolved_content ?? ""),
    status,
    current: row.current === true,
    sourceClass: row.source_class,
    evidenceRefs: parseRefArray(row.evidence_refs, "evidence_refs"),
    confidencePpm: Number(row.confidence_ppm),
    allowedPurposeScopes: parseStringArray(row.allowed_purpose_scopes, "allowed_purpose_scopes"),
    sensitivity: parseJsonValue(row.sensitivity, "sensitivity") as unknown as MemoryVersionRecord["sensitivity"],
    validity: parseJsonValue(row.validity, "validity") as MemoryVersionRecord["validity"],
    ...(row.supersedes_ref === null || row.supersedes_ref === undefined ? {} : {
      supersedes: assertRefColumnEquality(row.supersedes_ref, {
        ref_type: row.supersedes_ref_type,
        ref_id: row.supersedes_ref_id,
        object_version: row.supersedes_object_version,
        canonical_payload_sha256: String(row.supersedes_payload_sha256).trim(),
      }),
    }),
    ...(row.correction_intent === null || row.correction_intent === undefined ? {} : {
      correctionIntent: parseJsonValue(row.correction_intent, "correction_intent") as unknown as NonNullable<MemoryVersionRecord["correctionIntent"]>,
    }),
    ...(row.dream_accepted_delta === null || row.dream_accepted_delta === undefined ? {} : {
      dreamAcceptedDelta: parseJsonValue(row.dream_accepted_delta, "dream_accepted_delta") as unknown as NonNullable<MemoryVersionRecord["dreamAcceptedDelta"]>,
    }),
    ...(row.deleted_at === null || row.deleted_at === undefined ? {} : { deletedAt: dateToCanonical(row.deleted_at, "deleted_at") }),
    ...(row.suppressed_at === null || row.suppressed_at === undefined ? {} : { suppressedAt: dateToCanonical(row.suppressed_at, "suppressed_at") }),
    ...(row.stale === true ? { stale: true } : {}),
    ...(row.derived_rank_score === null || row.derived_rank_score === undefined ? {} : { derivedRankScore: Number(row.derived_rank_score) }),
    ...(row.created_at === null || row.created_at === undefined ? {} : { createdAt: dateToCanonical(row.created_at, "created_at") }),
    ...(row.updated_at === null || row.updated_at === undefined ? {} : { updatedAt: dateToCanonical(row.updated_at, "updated_at") }),
  };
  return Object.freeze(record);
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MemoryPersistenceError("INVALID_ARRAY", `${field} must be a string array`);
  }
  return Object.freeze(value.map((item) => String(item)));
}

function parseRefArray(value: unknown, field: string): readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(value)) throw new MemoryPersistenceError("INVALID_REF_ARRAY", `${field} must be an array`);
  const refs = value.map((item) => cloneCanonicalRef(item));
  const keys = refs.map((ref) => `${ref.refType}:${ref.refId}:${ref.objectVersion}:${ref.canonicalPayloadSha256}`);
  if (new Set(keys).size !== keys.length) throw new MemoryPersistenceError("DUPLICATE_REF", `${field} contains duplicate refs`);
  return Object.freeze(refs);
}

export function assertOwnerIdentityProvider(value: unknown): asserts value is { readonly environment: string } {
  if (typeof value !== "object" || value === null ||
      (value as { readonly environment?: unknown }).environment !== "production" &&
      (value as { readonly environment?: unknown }).environment !== "non-production") {
    throw new MemoryPersistenceError("CANONICAL_IDENTITY_REQUIRED", "canonical identity provider is required");
  }
}

export function isCanonicalRef(value: unknown): value is CanonicalObjectVersionRef {
  return isCanonicalObjectVersionRef(value);
}
