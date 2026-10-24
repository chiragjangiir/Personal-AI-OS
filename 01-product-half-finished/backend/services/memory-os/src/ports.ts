import type {
  AuthorityWatermark,
  AcceptedDreamDeltaPage,
  AcceptedDreamDeltaQuery,
  CanonicalUtcInstant,
  CompilerQuery,
  DeletionJobScope,
  MemoryCandidateQuery,
  MemoryCandidateRecord,
  MemoryCandidateSnapshot,
  MemoryCandidateIntent,
  MemoryCommandError,
  MemoryCommandResult,
  MemoryCommitReceipt,
  MemoryQuerySnapshot,
  MemoryReviewCommandIdentity,
  MemoryReviewReplayRecord,
  MemoryReviewReceipt,
  MemoryReviewStateQuery,
  MemoryReviewStateSnapshot,
  MemoryVersionRecord,
} from "./domain.ts";
import type { AdmittedMemoryCandidateIntent } from "./admission.ts";
import type {
  T05DeletionSurfaceResult,
  T05DeletionWorkPlan,
  T05DeletionWorkResult,
  T03DeletionMutationProjection,
} from "./deletion-attestation-adapter.ts";
import type {
  MemoryRebuildRequestManifest,
  RebuiltProjectionResult,
} from "./rebuild-manifest.ts";
import type { CanonicalObjectVersionRef, Sha256 } from "./canonical-ref.ts";
import type {
  CandidateIssueInput,
  CandidateSuccessorIssueInput,
  MemoryIssueInput,
  MemorySuccessorIssueInput,
  CanonicalMemoryPayload,
  ProductionMemoryIssuerReceipt,
} from "./canonical-issuer.ts";
import {
  assertProductionMemoryIssuerReceipt,
  canonicalPayloadHash,
} from "./canonical-issuer.ts";

/**
 * Append-only authority keeps its watermark opaque to T05.  This closed
 * recursive value type is deliberately separate from domain.AuthorityWatermark
 * (which remains the global owner seam and is still unknown).
 */
export type AppendOnlyAuthorityWatermark =
  | boolean
  | number
  | string
  | readonly AppendOnlyAuthorityWatermark[]
  | { readonly [key: string]: AppendOnlyAuthorityWatermark };

/** Compatibility spelling for callers that name the seam by memory. */
export type MemoryAppendOnlyAuthorityWatermark = AppendOnlyAuthorityWatermark;

/**
 * Return a stable, closed, non-empty opaque watermark.  The validator rejects
 * values whose JSON representation could be ambiguous or change while being
 * inspected: null/undefined, empty strings/containers, non-finite numbers,
 * cycles, accessors, symbols, proxies that do not expose stable data, and
 * non-plain objects are not accepted.
 */
export function assertAppendOnlyAuthorityWatermark(
  value: unknown,
): AppendOnlyAuthorityWatermark {
  const first = stableAppendOnlyValue(value, new WeakSet<object>());
  if (first === undefined || first.length === 0) {
    throw new TypeError("append-only authority watermark is not stable or non-empty");
  }
  const second = stableAppendOnlyValue(value, new WeakSet<object>());
  if (second === undefined || first !== second) {
    throw new TypeError("append-only authority watermark is unstable");
  }
  return freezeAppendOnlyValue(JSON.parse(first) as AppendOnlyAuthorityWatermark);
}

export function isAppendOnlyAuthorityWatermark(
  value: unknown,
): value is AppendOnlyAuthorityWatermark {
  try {
    assertAppendOnlyAuthorityWatermark(value);
    return true;
  } catch {
    return false;
  }
}

function stableAppendOnlyValue(
  value: unknown,
  seen: WeakSet<object>,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    return value.trim().length === 0 ? undefined : JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return undefined;
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    if (Array.isArray(value)) {
      if (value.length === 0) return undefined;
      const ownNames = Object.getOwnPropertyNames(value);
      const expectedNames = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (ownNames.length !== expectedNames.size || ownNames.some((name) => !expectedNames.has(name))) {
        return undefined;
      }
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            descriptor.enumerable !== true) return undefined;
        const repeatedDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (repeatedDescriptor === undefined ||
            repeatedDescriptor.value !== descriptor.value ||
            repeatedDescriptor.enumerable !== descriptor.enumerable ||
            repeatedDescriptor.configurable !== descriptor.configurable ||
            repeatedDescriptor.writable !== descriptor.writable) return undefined;
        const serialized = stableAppendOnlyValue(descriptor.value, seen);
        if (serialized === undefined) return undefined;
        parts.push(serialized);
      }
      for (const key of Object.keys(value)) {
        if (!/^0$|^[1-9][0-9]*$/.test(key) || Number(key) >= value.length) return undefined;
      }
      return `[${parts.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return undefined;
    const ownNames = Object.getOwnPropertyNames(value).sort();
    if (ownNames.length !== keys.length || ownNames.some((key, index) => key !== keys[index])) return undefined;
    const parts: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) return undefined;
      const repeatedDescriptor = Object.getOwnPropertyDescriptor(value, key);
      if (repeatedDescriptor === undefined ||
          repeatedDescriptor.value !== descriptor.value ||
          repeatedDescriptor.enumerable !== descriptor.enumerable ||
          repeatedDescriptor.configurable !== descriptor.configurable ||
          repeatedDescriptor.writable !== descriptor.writable) return undefined;
      const serialized = stableAppendOnlyValue(descriptor.value, seen);
      if (serialized === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${parts.join(",")}}`;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function freezeAppendOnlyValue(
  value: AppendOnlyAuthorityWatermark,
): AppendOnlyAuthorityWatermark {
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      for (const item of value) freezeAppendOnlyValue(item);
    } else {
      for (const item of Object.values(value)) freezeAppendOnlyValue(item);
    }
    Object.freeze(value);
  }
  return value;
}

function assertClosedPlainRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} cannot contain symbol properties`);
  }
  const expected = new Set(keys);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} has unexpected or missing properties`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true) {
      throw new TypeError(`${label}.${key} must be a stable data property`);
    }
  }
  return value as Record<string, unknown>;
}

/**
 * Canonical identity is an owner projection, never a repository-generated
 * value.  The environment marker makes non-production test fixtures
 * explicit; a production adapter must provide the same seam from T01/T05.
 */
export type MemoryIdentityEnvironment = "production" | "non-production";

export interface MemoryCanonicalIdentityProvider {
  readonly environment: MemoryIdentityEnvironment;
  candidateRefFor(input: {
    readonly batchId: string;
    readonly idempotencyKey: string;
    readonly candidateIndex: number;
    readonly candidate: AdmittedMemoryCandidateIntent;
  }): CanonicalObjectVersionRef | Promise<CanonicalObjectVersionRef>;
  memoryRefFor(input: {
    readonly candidateRef: CanonicalObjectVersionRef;
    readonly memoryKind: MemoryVersionRecord["kind"];
    readonly operation: "accept_new" | "accept_superseding" | "correction";
    readonly expectedCurrentRef?: CanonicalObjectVersionRef;
    readonly candidate: MemoryCandidateRecord;
  }): CanonicalObjectVersionRef | Promise<CanonicalObjectVersionRef>;
}

/** Naming aliases used by T01/T05 owner adapters. */
export type MemoryCanonicalIdentityIssuer = MemoryCanonicalIdentityProvider;

/**
 * Production identity seam. Unlike the legacy provider above, this port never
 * returns a bare caller-selected ref: every result is a private-branded
 * issuer receipt containing the complete canonical payload/JCS/hash binding.
 */
export interface ProductionMemoryCanonicalIssuerPort {
  readonly environment: "production";
  issueCandidate(input: CandidateIssueInput): ProductionMemoryIssuerReceipt;
  issueCandidateSuccessor(input: CandidateSuccessorIssueInput): ProductionMemoryIssuerReceipt;
  issueMemory(input: MemoryIssueInput): ProductionMemoryIssuerReceipt;
  issueMemorySuccessor(input: MemorySuccessorIssueInput): ProductionMemoryIssuerReceipt;
}

/** Explicit name for the receipt accepted by production application seams. */
export type ProductionMemoryIdentityReceipt = ProductionMemoryIssuerReceipt;

/**
 * Exact canonical bytes returned by a T02 target reader.  The reader is
 * deliberately independent from current/purpose filtering so T05 can build a
 * successor from the complete predecessor rather than from a ref alone.
 */
export interface MemoryCanonicalVersionRead {
  readonly receipt: ProductionMemoryIssuerReceipt;
  readonly payload: CanonicalMemoryPayload;
  readonly authorityWatermark: AppendOnlyAuthorityWatermark;
}

/**
 * Validate the complete T02 read result before T05 may issue a successor.
 * This is independent of purpose/current filtering and binds the returned
 * payload bytes and hash to the private T05 receipt.
 */
export function assertMemoryCanonicalVersionRead(
  value: unknown,
): MemoryCanonicalVersionRead {
  const record = assertClosedPlainRecord(
    value,
    ["authorityWatermark", "payload", "receipt"],
    "memory canonical version read",
  );
  const receipt = assertProductionMemoryIssuerReceipt(record.receipt);
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    throw new TypeError("memory canonical version read payload is invalid");
  }
  const payload = record.payload as CanonicalMemoryPayload;
  const canonical = canonicalPayloadHash(payload);
  if (canonical.jcs !== receipt.canonicalPayloadJcs ||
      canonical.sha256 !== receipt.canonicalPayloadSha256) {
    throw new TypeError("memory canonical version read payload drifted from receipt");
  }
  const authorityWatermark = assertAppendOnlyAuthorityWatermark(record.authorityWatermark);
  return Object.freeze({ receipt, payload, authorityWatermark });
}

export interface MemoryCanonicalVersionReader {
  readVersionByRef(input: {
    readonly ref: CanonicalObjectVersionRef;
  }): Promise<OwnerPortResult<MemoryCanonicalVersionRead>>;
}

/** T05 supplies the receipt; T02 later appends it and advances a head by CAS. */
export interface MemoryCanonicalAppendReceipt {
  readonly receipt: ProductionMemoryIssuerReceipt;
  readonly expectedHeadRef?: CanonicalObjectVersionRef;
}

export interface MemoryCanonicalAppendWriter {
  appendCanonical(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly receipt: ProductionMemoryIssuerReceipt;
    readonly expectedHeadRef?: CanonicalObjectVersionRef;
  }): Promise<OwnerPortResult<{
    readonly appendedRef: CanonicalObjectVersionRef;
    readonly headRef: CanonicalObjectVersionRef;
    readonly authorityWatermark: AppendOnlyAuthorityWatermark;
  }>>;
}

/**
 * The deletion seam remains T03 intent-only.  A successor receipt is the
 * complete T05-issued canonical object that T02 may append atomically.
 */
export interface MemoryDeletionSuccessorReceipt {
  readonly targetRef: CanonicalObjectVersionRef;
  readonly receipt: ProductionMemoryIssuerReceipt;
}

export interface MemoryCanonicalDeletionLifecycle {
  readonly reader: MemoryCanonicalVersionReader;
  /** T05 adapter calls the accepted canonical issuer and returns a composite receipt. */
  readonly issueSuccessor: (input: {
    readonly target: MemoryCanonicalVersionRead;
    readonly projection: T03DeletionMutationProjection;
  }) => ProductionMemoryIssuerReceipt;
  readonly append: (input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly projections: readonly MemoryDeletionMutationProjection[];
    readonly successors: readonly MemoryDeletionSuccessorReceipt[];
  }) => Promise<OwnerPortResult<{
    readonly authorityWatermark: AppendOnlyAuthorityWatermark;
    readonly completedAt: CanonicalUtcInstant;
  }>>;
}

/** Explicit non-production fixture projection; it never mints missing refs. */
export interface NonProductionMemoryIdentityFixture {
  readonly environment: "non-production";
  readonly candidateRefs: readonly CanonicalObjectVersionRef[];
  readonly memoryRefs: readonly CanonicalObjectVersionRef[];
}

export interface MemoryCandidateIdentityProjection {
  readonly candidateRef: CanonicalObjectVersionRef;
}

export interface MemoryCorrectionIdentityProjection {
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly memoryRef: CanonicalObjectVersionRef;
}

/**
 * Async storage-neutral T05 boundary. PostgreSQL, SQL, vector indexes, and
 * caches are deliberately outside this port.
 */
export interface MemoryRepository {
  /** Load one purpose-scoped snapshot for Context Compiler. */
  loadCompilerSnapshot(query: CompilerQuery): Promise<MemoryQuerySnapshot>;

  /** Find the visible current record for one logical memory slot. */
  findCurrentBySlot(
    slot: string,
    query: CompilerQuery,
  ): Promise<MemoryVersionRecord | undefined>;
}

/** Independent candidate queue read seam; it is not a compiler authority read. */
export interface MemoryCandidateReader {
  loadCandidateSnapshot(
    query: MemoryCandidateQuery,
  ): Promise<MemoryCandidateSnapshot>;

  findCandidateByRef(
    candidateRef: CanonicalObjectVersionRef,
  ): Promise<MemoryCandidateRecord | undefined>;
}

/**
 * Unfiltered current-state read for review/CAS authority. It must not route
 * through the purpose-scoped Context Compiler query; every current-flag row,
 * including stale/deleted/suppressed rows, is surfaced and multiple rows are
 * reported as `conflict` for fail-closed application handling.
 */
export interface MemoryReviewStateReader {
  findAuthoritativeCurrentBySlot(
    query: MemoryReviewStateQuery,
  ): Promise<MemoryReviewStateSnapshot>;
}

/** Repository-backed review replay lookup; T02 supplies durable mechanics. */
export interface MemoryReviewReceiptReader {
  findReviewReceiptByIdempotencyKey(input: {
    readonly idempotencyKey: string;
  }): Promise<MemoryReviewReplayRecord | undefined>;
}

/** Candidate batch command; the repository creates all new canonical refs. */
export interface MemoryCandidateBatchCommitCommand {
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
  readonly candidates: readonly AdmittedMemoryCandidateIntent[];
  /** Owner-supplied refs; absence is only tolerated by an injected provider. */
  readonly candidateIdentities?: readonly MemoryCandidateIdentityProjection[];
  /** Complete T05 issuer receipt; raw refs remain a fixture-only seam. */
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/** Correction command with an exact expected-current CAS target. */
export interface MemoryCorrectionCommitCommand {
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
  readonly expectedCurrentRef: CanonicalObjectVersionRef;
  readonly replacement: AdmittedMemoryCandidateIntent;
  /** Optional model-safe text persisted with the new current version. */
  readonly resolvedContent?: string;
  /** Owner-supplied candidate and replacement memory refs. */
  readonly identity?: MemoryCorrectionIdentityProjection;
  /** Complete composite T05 receipt (candidate + durable successor). */
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/**
 * Atomic candidate review command.  Resolution is selected by the T05
 * application service; the repository only validates the expected row/current
 * state and executes the requested CAS transition.
 */
export interface MemoryCandidateReviewCommand extends MemoryReviewCommandIdentity {
  /** Hash of the complete command identity, including current state projection. */
  readonly fingerprint: Sha256;
  /** Optional owner-provided replacement identity; repository may use its injected seam. */
  readonly canonicalMemoryRef?: CanonicalObjectVersionRef;
  /** Candidate-only or composite T05 receipt, depending on resolution. */
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/** One repository transaction may execute one atomic command. */
export interface MemoryCommandTransaction {
  commitCandidateBatch(
    command: MemoryCandidateBatchCommitCommand,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>>;

  commitCorrection(
    command: MemoryCorrectionCommitCommand,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>>;

  /** Optional keeps legacy unit doubles source-compatible; review-capable
   * repositories must expose this method and review services fail closed when
   * it is absent. */
  reviewCandidate?(
    command: MemoryCandidateReviewCommand,
  ): Promise<MemoryCommandResult<MemoryReviewReceipt>>;
}

/** Review-capable refinement used after an application service capability check. */
export type MemoryReviewTransaction = MemoryCommandTransaction & {
  readonly reviewCandidate: (
    command: MemoryCandidateReviewCommand,
  ) => Promise<MemoryCommandResult<MemoryReviewReceipt>>;
};

/** PostgreSQL will implement this seam; the unit repository is only a fake. */
export interface MemoryCommandRepository {
  withTransaction<T>(
    run: (transaction: MemoryCommandTransaction) => Promise<T>,
  ): Promise<T>;
}

/** T03 supplies this complete projected mutation; T02 executes it mechanically. */
export type MemoryDeletionMutationProjection = T03DeletionMutationProjection;

/** Durable deletion mechanics exposed by the platform adapter. */
export interface MemoryDeletionMutationWriter {
  applyDeletionMutations(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly projections: readonly MemoryDeletionMutationProjection[];
    /** T05-issued full successors; T02 must reject targetRef-only synthesis. */
    readonly successors?: readonly MemoryDeletionSuccessorReceipt[];
  }): Promise<OwnerPortResult<{
    readonly authorityWatermark: AuthorityWatermark;
    readonly completedAt: CanonicalUtcInstant;
  }>>;
}

/** Owner state results deliberately carry no T01/T02/T03 wire envelope. */
export type OwnerPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MemoryCommandError };

/** T04/T05 accepted-delta reader; callers cannot provide the accepted set. */
export interface AcceptedDreamDeltaReader {
  readAcceptedDreamDeltas(
    query: AcceptedDreamDeltaQuery,
  ): Promise<AcceptedDreamDeltaPage>;
}

/** T03 owns deletion-job policy and supplies only a scoped projection. */
export interface DeletionJobReader {
  readDeletionJob(input: {
    readonly deletionJobRef: CanonicalObjectVersionRef;
  }): Promise<OwnerPortResult<DeletionJobScope & {
    readonly projectedMutations?: readonly MemoryDeletionMutationProjection[];
  }>>;
}

export interface AuthoritativeSuppressionResult {
  readonly completedAt: CanonicalUtcInstant;
  readonly authorityWatermark: AuthorityWatermark;
}

export interface DerivedPurgeResult {
  readonly completedAt: CanonicalUtcInstant;
  readonly authorityWatermark: AuthorityWatermark;
  readonly surfaceResults: readonly T05DeletionSurfaceResult[];
}

/** T05 orchestrates these calls; T02 supplies durable mechanics. */
export interface T05DeletionRuntime {
  applyAuthoritativeSuppression(
    plan: T05DeletionWorkPlan,
  ): Promise<OwnerPortResult<AuthoritativeSuppressionResult>>;

  purgeDerivedSurfaces(
    plan: T05DeletionWorkPlan,
  ): Promise<OwnerPortResult<DerivedPurgeResult>>;
}

/** T13 exposes only immutable canonical lineage refs, never raw metadata/bytes. */
export interface T13SourceReferenceReader {
  enumerateSourceReferences(input: {
    readonly deletionJobRef: CanonicalObjectVersionRef;
    readonly targetMemoryRefs: readonly CanonicalObjectVersionRef[];
    readonly authorityWatermark: AuthorityWatermark;
  }): Promise<OwnerPortResult<readonly CanonicalObjectVersionRef[]>>;
}

/** Derived FTS/vector/graph implementations are replaceable and non-authoritative. */
export interface DerivedProjectionRebuilder {
  rebuild(input: {
    readonly request: MemoryRebuildRequestManifest;
    readonly sourceArtifactRefs: readonly CanonicalObjectVersionRef[];
  }): Promise<OwnerPortResult<readonly RebuiltProjectionResult[]>>;
}

/** Convenience type for a T05 adapter that emits the completed work shape. */
export type T05CompletedDeletionWork = OwnerPortResult<T05DeletionWorkResult>;

/** Kept as a type-only compatibility seam for future application services. */
export type MemoryCandidateCommandInput = MemoryCandidateIntent;
