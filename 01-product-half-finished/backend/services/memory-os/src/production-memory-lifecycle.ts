import { createHash } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  assertCanonicalUtcInstant,
  type AuthorityWatermark,
  type MemoryCandidateRecord,
  type MemoryCommandResult,
  type MemoryCommitReceipt,
  type MemoryReviewResult,
} from "./domain.ts";
import {
  projectProductionMemoryIssuerReceipt,
} from "./canonical-issuer.ts";
import type {
  ProductionCommitCorrectionInput,
  ProductionMemoryApplicationService,
} from "./memory-application-service.ts";
import type {
  ProductionMemoryReviewInput,
  ProductionMemoryReviewService,
} from "./memory-review-service.ts";
import type {
  DreamRunInput,
  DreamRunResult,
  ProductionDreamRunService,
} from "./dream-run-service.ts";
import type {
  DeletionRebuildApplicationService,
  DeletionRebuildRequest,
  DeletionRebuildResult,
} from "./deletion-rebuild-service.ts";
import type {
  MemoryCandidateReader,
  OwnerPortResult,
} from "./ports.ts";
import type {
  MemoryConsumerContext,
} from "./context-consumer-adapter.ts";
import type {
  ExplicitUserRememberResult,
} from "./explicit-user-remember-service.ts";
import type {
  ProductionFinalTranscriptEvidenceCommitProjection,
  ProductionMemoryReady,
  ProductionMemoryReadyBinding,
} from "./production-memory-ready.ts";
import type {
  RecallMemoryContextInput,
} from "../../platform-data/src/memory-runtime.ts";

const GOVERNANCE_REF_TYPES = new Set([
  "PolicyDecision",
  "CapabilityGrant",
  "PurposeToken",
  "SoftwareKillSwitch",
  "ConsentRecord",
  "DeletionJob",
  "DomainDeletionAttestation",
  "DeletionProof",
  "AuditExport",
  "EmergencyDeliveryObligation",
  "DeviceCredential",
  "AuditRecord",
]);

const BINDING_KEYS = Object.freeze([
  "clientInstanceId",
  "continuityId",
  "deviceId",
  "purpose",
  "realtimeSessionRef",
  "sessionId",
  "userId",
] as const);

const ENVELOPE_KEYS = Object.freeze([
  "authorityReceipt",
  "binding",
  "governanceRef",
  "idempotencyKey",
  "requestId",
  "requestedAt",
] as const);

const AUTHORITY_RECEIPT_KEYS = Object.freeze([
  "action",
  "authorityWatermark",
  "authorizedAt",
  "binding",
  "governanceRef",
  "idempotencyKey",
  "kind",
  "requestId",
  "requestedAt",
] as const);

const COLD_CAS_RECEIPT_KEYS = Object.freeze([
  "authorityWatermark",
  "completedAt",
  "consumedSourceRefs",
  "deletionJobRef",
  "idempotencyKey",
  "kind",
  "outcome",
  "requestId",
  "skippedDeletedSourceRefs",
] as const);

type PlainRecord = Record<string, unknown>;

export const PRODUCTION_MEMORY_LIFECYCLE_ACTIONS = Object.freeze([
  "remember_final_transcript",
  "recall_for_answer_context",
  "correct_memory",
  "review_candidate",
  "run_dream_page",
  "delete_and_rebuild",
] as const);

export type ProductionMemoryLifecycleAction =
  (typeof PRODUCTION_MEMORY_LIFECYCLE_ACTIONS)[number];

export class ProductionMemoryLifecycleError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "ProductionMemoryLifecycleError";
    this.code = code;
  }
}

/**
 * App-local owner projection. It is not a T01 wire contract and this module
 * never issues it. The injected authority must return the exact same receipt.
 */
export interface ProductionMemoryLifecycleAuthorityReceipt {
  readonly kind: "production_memory_lifecycle_authority_receipt";
  readonly action: ProductionMemoryLifecycleAction;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly binding: ProductionMemoryReadyBinding;
  readonly governanceRef: CanonicalObjectVersionRef;
  readonly requestedAt: string;
  readonly authorizedAt: string;
  readonly authorityWatermark: AuthorityWatermark;
}

export interface ProductionMemoryLifecycleEnvelope {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly binding: ProductionMemoryReadyBinding;
  readonly governanceRef: CanonicalObjectVersionRef;
  readonly requestedAt: string;
  readonly authorityReceipt: ProductionMemoryLifecycleAuthorityReceipt;
}

export interface ProductionMemoryLifecycleAuthorityPort {
  verify(input: {
    readonly action: ProductionMemoryLifecycleAction;
    readonly envelope: ProductionMemoryLifecycleEnvelope;
  }): Promise<OwnerPortResult<ProductionMemoryLifecycleAuthorityReceipt>>;
}

export interface ProductionMemoryColdCasLifecycleReceipt {
  readonly kind: "production_memory_cold_cas_lifecycle_receipt";
  readonly outcome: "applied" | "replayed";
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly deletionJobRef: CanonicalObjectVersionRef;
  readonly consumedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly skippedDeletedSourceRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
  readonly completedAt: string;
}

/**
 * Cold-CAS owns retention, authorized physical deletion, and rebuild mechanics.
 * This composition passes only a completed authoritative lifecycle result and
 * never imports or calls the filesystem-backed CAS implementation.
 */
export interface MemoryColdCasLifecyclePort {
  applyAuthorizedLifecycle(input: {
    readonly envelope: ProductionMemoryLifecycleEnvelope;
    readonly deletion: DeletionRebuildResult;
  }): Promise<OwnerPortResult<ProductionMemoryColdCasLifecycleReceipt>>;
  close(): Promise<void>;
}

export interface ProductionMemoryLifecycleOptions {
  readonly binding: ProductionMemoryReadyBinding;
  readonly governanceRef: CanonicalObjectVersionRef;
  readonly authority: ProductionMemoryLifecycleAuthorityPort;
  readonly memoryReady: ProductionMemoryReady;
  readonly application: ProductionMemoryApplicationService;
  readonly review: ProductionMemoryReviewService;
  readonly candidateReader: MemoryCandidateReader;
  readonly dream: ProductionDreamRunService;
  readonly deletion: DeletionRebuildApplicationService;
  readonly coldCas: MemoryColdCasLifecyclePort;
}

export interface ProductionMemoryLifecycleCall<T> {
  readonly envelope: ProductionMemoryLifecycleEnvelope;
  readonly input: T;
}

export interface ProductionMemoryLifecycleExecution<T> {
  readonly authorityReceipt: ProductionMemoryLifecycleAuthorityReceipt;
  readonly value: T;
}

export interface ProductionMemoryDeletionLifecycleValue {
  readonly deletion: DeletionRebuildResult;
  readonly coldCas?: ProductionMemoryColdCasLifecycleReceipt;
}

export interface ProductionMemoryLifecycle {
  rememberFinalTranscript(
    call: ProductionMemoryLifecycleCall<ProductionFinalTranscriptEvidenceCommitProjection>,
  ): Promise<ProductionMemoryLifecycleExecution<ExplicitUserRememberResult | undefined>>;
  recallForAnswerContext(
    call: ProductionMemoryLifecycleCall<RecallMemoryContextInput>,
  ): Promise<ProductionMemoryLifecycleExecution<MemoryConsumerContext>>;
  correctMemory(
    call: ProductionMemoryLifecycleCall<ProductionCommitCorrectionInput>,
  ): Promise<ProductionMemoryLifecycleExecution<MemoryCommandResult<MemoryCommitReceipt>>>;
  reviewCandidate(
    call: ProductionMemoryLifecycleCall<ProductionMemoryReviewInput & {
      readonly issuerReceipt: NonNullable<ProductionMemoryReviewInput["issuerReceipt"]>;
    }>,
  ): Promise<ProductionMemoryLifecycleExecution<MemoryReviewResult>>;
  runDreamPage(
    call: ProductionMemoryLifecycleCall<DreamRunInput>,
  ): Promise<ProductionMemoryLifecycleExecution<DreamRunResult>>;
  deleteAndRebuild(
    call: ProductionMemoryLifecycleCall<DeletionRebuildRequest>,
  ): Promise<ProductionMemoryLifecycleExecution<ProductionMemoryDeletionLifecycleValue>>;
  close(): Promise<void>;
}

interface IdempotentEntry {
  readonly fingerprint: Sha256;
  readonly promise: Promise<ProductionMemoryLifecycleExecution<unknown>>;
}

function fail(code: string, cause?: unknown): never {
  throw new ProductionMemoryLifecycleError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) {
    fail(code);
  }
  return value;
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("MEMORY_LIFECYCLE_FINGERPRINT_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || ArrayBuffer.isView(value)) {
    fail("MEMORY_LIFECYCLE_FINGERPRINT_INVALID");
  }
  if (seen.has(value)) fail("MEMORY_LIFECYCLE_FINGERPRINT_INVALID");
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    fail("MEMORY_LIFECYCLE_FINGERPRINT_INVALID");
  }
  const serialized = `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return serialized;
}

function stableEqual(left: unknown, right: unknown): boolean {
  try {
    return stableSerialize(left) === stableSerialize(right);
  } catch {
    return false;
  }
}

function digest(value: unknown): Sha256 {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex") as Sha256;
}

function normalizeOpaque(value: unknown, code: string): unknown {
  stableSerialize(value);
  if (value === null || value === undefined) fail(code);
  return value;
}

function normalizeBinding(value: unknown): ProductionMemoryReadyBinding {
  if (!hasExactKeys(value, BINDING_KEYS)) fail("MEMORY_LIFECYCLE_BINDING_INVALID");
  return Object.freeze({
    userId: exactString(value.userId, "MEMORY_LIFECYCLE_BINDING_INVALID"),
    sessionId: exactString(value.sessionId, "MEMORY_LIFECYCLE_BINDING_INVALID"),
    deviceId: exactString(value.deviceId, "MEMORY_LIFECYCLE_BINDING_INVALID"),
    clientInstanceId: exactString(value.clientInstanceId, "MEMORY_LIFECYCLE_BINDING_INVALID"),
    realtimeSessionRef: normalizeOpaque(value.realtimeSessionRef, "MEMORY_LIFECYCLE_BINDING_INVALID") as ProductionMemoryReadyBinding["realtimeSessionRef"],
    continuityId: exactString(value.continuityId, "MEMORY_LIFECYCLE_BINDING_INVALID"),
    purpose: exactString(value.purpose, "MEMORY_LIFECYCLE_BINDING_INVALID"),
  });
}

function normalizeGovernanceRef(value: unknown): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  if (!GOVERNANCE_REF_TYPES.has(ref.refType)) fail("MEMORY_LIFECYCLE_GOVERNANCE_INVALID");
  return ref;
}

function normalizeAuthorityReceipt(value: unknown): ProductionMemoryLifecycleAuthorityReceipt {
  if (!hasExactKeys(value, AUTHORITY_RECEIPT_KEYS) ||
      value.kind !== "production_memory_lifecycle_authority_receipt" ||
      !(PRODUCTION_MEMORY_LIFECYCLE_ACTIONS as readonly unknown[]).includes(value.action)) {
    fail("MEMORY_LIFECYCLE_AUTHORITY_INVALID");
  }
  return Object.freeze({
    kind: "production_memory_lifecycle_authority_receipt" as const,
    action: value.action as ProductionMemoryLifecycleAction,
    requestId: exactString(value.requestId, "MEMORY_LIFECYCLE_AUTHORITY_INVALID"),
    idempotencyKey: exactString(value.idempotencyKey, "MEMORY_LIFECYCLE_AUTHORITY_INVALID"),
    binding: normalizeBinding(value.binding),
    governanceRef: normalizeGovernanceRef(value.governanceRef),
    requestedAt: assertCanonicalUtcInstant(value.requestedAt, "authority.requestedAt"),
    authorizedAt: assertCanonicalUtcInstant(value.authorizedAt, "authority.authorizedAt"),
    authorityWatermark: normalizeOpaque(value.authorityWatermark, "MEMORY_LIFECYCLE_AUTHORITY_INVALID") as AuthorityWatermark,
  });
}

function normalizeEnvelope(value: unknown): ProductionMemoryLifecycleEnvelope {
  if (!hasExactKeys(value, ENVELOPE_KEYS)) fail("MEMORY_LIFECYCLE_ENVELOPE_INVALID");
  return Object.freeze({
    requestId: exactString(value.requestId, "MEMORY_LIFECYCLE_ENVELOPE_INVALID"),
    idempotencyKey: exactString(value.idempotencyKey, "MEMORY_LIFECYCLE_ENVELOPE_INVALID"),
    binding: normalizeBinding(value.binding),
    governanceRef: normalizeGovernanceRef(value.governanceRef),
    requestedAt: assertCanonicalUtcInstant(value.requestedAt, "envelope.requestedAt"),
    authorityReceipt: normalizeAuthorityReceipt(value.authorityReceipt),
  });
}

function sameRef(left: CanonicalObjectVersionRef, right: CanonicalObjectVersionRef): boolean {
  return canonicalRefKey(left) === canonicalRefKey(right);
}

function sameRefSet(
  left: readonly CanonicalObjectVersionRef[],
  right: readonly CanonicalObjectVersionRef[],
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].map(assertCanonicalObjectVersionRef).sort(compareCanonicalObjectVersionRefs);
  const b = [...right].map(assertCanonicalObjectVersionRef).sort(compareCanonicalObjectVersionRefs);
  return a.every((ref, index) => b[index] !== undefined && sameRef(ref, b[index]!));
}

function candidateBound(candidate: MemoryCandidateRecord | ProductionCommitCorrectionInput["candidate"], binding: ProductionMemoryReadyBinding): boolean {
  return candidate.userId === binding.userId && candidate.purposeScopes.includes(binding.purpose);
}

function issuerProjection(value: unknown, code: string): ReturnType<typeof projectProductionMemoryIssuerReceipt> {
  try {
    return projectProductionMemoryIssuerReceipt(value as Parameters<typeof projectProductionMemoryIssuerReceipt>[0]);
  } catch (error) {
    fail(code, error);
  }
}

function correctionFingerprint(input: ProductionCommitCorrectionInput): unknown {
  return {
    idempotencyKey: input.idempotencyKey,
    expectedCurrentRef: input.expectedCurrentRef,
    candidate: input.candidate,
    ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
    issuerReceipt: issuerProjection(input.issuerReceipt, "MEMORY_LIFECYCLE_CORRECTION_RECEIPT_INVALID"),
  };
}

function reviewFingerprint(input: ProductionMemoryReviewInput & { readonly issuerReceipt: NonNullable<ProductionMemoryReviewInput["issuerReceipt"]> }): unknown {
  return {
    candidateRef: input.candidateRef,
    expectedCandidateStatus: input.expectedCandidateStatus,
    expectedUserId: input.expectedUserId,
    expectedSlot: input.expectedSlot,
    decision: input.decision,
    idempotencyKey: input.idempotencyKey,
    authorization: input.authorization,
    ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
    ...(input.expectedCurrentRef === undefined ? {} : { expectedCurrentRef: input.expectedCurrentRef }),
    issuerReceipt: issuerProjection(input.issuerReceipt, "MEMORY_LIFECYCLE_REVIEW_RECEIPT_INVALID"),
  };
}

function dreamFingerprint(input: DreamRunInput): unknown {
  const receipts = input.productionReceipts ?? input.issuerReceipts ??
    (input.productionReceipt === undefined && input.issuerReceipt === undefined
      ? []
      : [input.productionReceipt ?? input.issuerReceipt!]);
  const {
    productionReceipt: _productionReceipt,
    issuerReceipt: _issuerReceipt,
    productionReceipts: _productionReceipts,
    issuerReceipts: _issuerReceipts,
    ...source
  } = input;
  return {
    ...source,
    projectedReceipts: receipts.map((receipt) =>
      issuerProjection(receipt, "MEMORY_LIFECYCLE_DREAM_RECEIPT_INVALID")),
  };
}

function normalizeColdCasReceipt(
  value: unknown,
  envelope: ProductionMemoryLifecycleEnvelope,
  deletion: DeletionRebuildResult,
): ProductionMemoryColdCasLifecycleReceipt {
  if (!hasExactKeys(value, COLD_CAS_RECEIPT_KEYS) ||
      value.kind !== "production_memory_cold_cas_lifecycle_receipt" ||
      (value.outcome !== "applied" && value.outcome !== "replayed") ||
      !Array.isArray(value.consumedSourceRefs) || !Array.isArray(value.skippedDeletedSourceRefs) ||
      deletion.plan === undefined || deletion.rebuildResult === undefined) {
    fail("MEMORY_LIFECYCLE_COLD_CAS_RECEIPT_INVALID");
  }
  const receipt = Object.freeze({
    kind: "production_memory_cold_cas_lifecycle_receipt" as const,
    outcome: value.outcome as "applied" | "replayed",
    requestId: exactString(value.requestId, "MEMORY_LIFECYCLE_COLD_CAS_RECEIPT_INVALID"),
    idempotencyKey: exactString(value.idempotencyKey, "MEMORY_LIFECYCLE_COLD_CAS_RECEIPT_INVALID"),
    deletionJobRef: assertCanonicalObjectVersionRef(value.deletionJobRef),
    consumedSourceRefs: Object.freeze((value.consumedSourceRefs as readonly unknown[]).map(assertCanonicalObjectVersionRef)),
    skippedDeletedSourceRefs: Object.freeze((value.skippedDeletedSourceRefs as readonly unknown[]).map(assertCanonicalObjectVersionRef)),
    authorityWatermark: normalizeOpaque(value.authorityWatermark, "MEMORY_LIFECYCLE_COLD_CAS_RECEIPT_INVALID") as AuthorityWatermark,
    completedAt: assertCanonicalUtcInstant(value.completedAt, "coldCas.completedAt"),
  });
  if (receipt.requestId !== envelope.requestId || receipt.idempotencyKey !== envelope.idempotencyKey ||
      !sameRef(receipt.deletionJobRef, deletion.plan.deletionJobRef) ||
      !sameRefSet(receipt.consumedSourceRefs, deletion.rebuildResult.consumedSourceRefs) ||
      !sameRefSet(receipt.skippedDeletedSourceRefs, deletion.rebuildResult.skippedDeletedSourceRefs) ||
      receipt.completedAt !== deletion.rebuildResult.completedAt ||
      !stableEqual(receipt.authorityWatermark, deletion.rebuildResult.authorityWatermark)) {
    fail("MEMORY_LIFECYCLE_COLD_CAS_RECEIPT_DRIFT");
  }
  return receipt;
}

function validateCompletedDeletion(value: DeletionRebuildResult): void {
  if ((value.status !== "completed" && value.status !== "replayed") || value.plan === undefined ||
      value.rebuildRequest === undefined || value.rebuildResult === undefined || value.attestationIntent === undefined ||
      value.plan.projectedMutations.length === 0 ||
      value.plan.projectedMutations.some((projection) => projection.tombstone !== true || projection.nonResurrection !== true)) {
    fail("MEMORY_LIFECYCLE_DELETION_RESULT_INVALID");
  }
  const expected = value.rebuildRequest.sourceArtifactRefs;
  const consumed = value.rebuildResult.consumedSourceRefs;
  const skipped = value.rebuildResult.skippedDeletedSourceRefs;
  const consumedKeys = new Set(consumed.map(canonicalRefKey));
  const skippedKeys = new Set(skipped.map(canonicalRefKey));
  if (consumedKeys.size !== consumed.length || skippedKeys.size !== skipped.length ||
      [...consumedKeys].some((key) => skippedKeys.has(key)) ||
      !sameRefSet(expected, [...consumed, ...skipped]) ||
      skipped.length !== value.rebuildResult.appliedDeletionJobRefs.length ||
      (skipped.length > 0 && value.rebuildResult.appliedDeletionJobRefs.some((ref) => !sameRef(ref, value.plan!.deletionJobRef)))) {
    fail("MEMORY_LIFECYCLE_REBUILD_PARTITION_INVALID");
  }
}

function assertOptions(options: ProductionMemoryLifecycleOptions): Readonly<ProductionMemoryLifecycleOptions> {
  if (!isPlainRecord(options) || typeof options.authority?.verify !== "function" ||
      typeof options.memoryReady?.rememberFinalTranscript !== "function" ||
      typeof options.memoryReady?.recallForAnswerContext !== "function" ||
      typeof options.memoryReady?.close !== "function" ||
      typeof options.application?.commitCorrection !== "function" ||
      typeof options.review?.reviewCandidate !== "function" ||
      typeof options.candidateReader?.findCandidateByRef !== "function" ||
      typeof options.dream?.runPage !== "function" || typeof options.deletion?.execute !== "function" ||
      typeof options.coldCas?.applyAuthorizedLifecycle !== "function" || typeof options.coldCas?.close !== "function") {
    fail("MEMORY_LIFECYCLE_CONFIGURATION_INVALID");
  }
  const normalized: Readonly<ProductionMemoryLifecycleOptions> = {
    ...options,
    binding: normalizeBinding(options.binding),
    governanceRef: normalizeGovernanceRef(options.governanceRef),
  };
  return Object.freeze(normalized);
}

export function createProductionMemoryLifecycle(
  options: ProductionMemoryLifecycleOptions,
): ProductionMemoryLifecycle {
  const config = assertOptions(options);
  const ledger = new Map<string, IdempotentEntry>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const assertOpen = (): void => {
    if (closed) fail("MEMORY_LIFECYCLE_CLOSED");
  };

  const authorize = async (
    action: ProductionMemoryLifecycleAction,
    rawEnvelope: ProductionMemoryLifecycleEnvelope,
  ): Promise<ProductionMemoryLifecycleAuthorityReceipt> => {
    assertOpen();
    const envelope = normalizeEnvelope(rawEnvelope);
    if (!stableEqual(envelope.binding, config.binding) || !sameRef(envelope.governanceRef, config.governanceRef)) {
      fail("MEMORY_LIFECYCLE_BINDING_DRIFT");
    }
    const supplied = envelope.authorityReceipt;
    if (supplied.action !== action || supplied.requestId !== envelope.requestId ||
        supplied.idempotencyKey !== envelope.idempotencyKey || supplied.requestedAt !== envelope.requestedAt ||
        !stableEqual(supplied.binding, envelope.binding) || !sameRef(supplied.governanceRef, envelope.governanceRef)) {
      fail("MEMORY_LIFECYCLE_AUTHORITY_DRIFT");
    }
    let result: OwnerPortResult<ProductionMemoryLifecycleAuthorityReceipt>;
    try {
      result = await config.authority.verify({ action, envelope });
    } catch (error) {
      fail("MEMORY_LIFECYCLE_AUTHORITY_UNAVAILABLE", error);
    }
    if (!result.ok) fail("MEMORY_LIFECYCLE_AUTHORITY_REJECTED");
    const verified = normalizeAuthorityReceipt(result.value);
    if (!stableEqual(verified, supplied)) fail("MEMORY_LIFECYCLE_AUTHORITY_DRIFT");
    return verified;
  };

  const execute = <T>(
    action: ProductionMemoryLifecycleAction,
    rawEnvelope: ProductionMemoryLifecycleEnvelope,
    semantic: unknown,
    run: (envelope: ProductionMemoryLifecycleEnvelope) => Promise<T>,
    retain: (value: T) => boolean = () => true,
  ): Promise<ProductionMemoryLifecycleExecution<T>> => {
    assertOpen();
    const envelope = normalizeEnvelope(rawEnvelope);
    const fingerprint = digest({ action, envelope, semantic });
    const existing = ledger.get(envelope.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) fail("MEMORY_LIFECYCLE_IDEMPOTENCY_CONFLICT");
      return existing.promise as Promise<ProductionMemoryLifecycleExecution<T>>;
    }
    const promise = (async (): Promise<ProductionMemoryLifecycleExecution<T>> => {
      const authorityReceipt = await authorize(action, envelope);
      const value = await run(envelope);
      if (!retain(value)) ledger.delete(envelope.idempotencyKey);
      return Object.freeze({ authorityReceipt, value });
    })();
    ledger.set(envelope.idempotencyKey, {
      fingerprint,
      promise: promise as Promise<ProductionMemoryLifecycleExecution<unknown>>,
    });
    void promise.catch(() => {
      const current = ledger.get(envelope.idempotencyKey);
      if (current?.promise === promise) ledger.delete(envelope.idempotencyKey);
    });
    return promise;
  };

  const lifecycle: ProductionMemoryLifecycle = {
    rememberFinalTranscript(call) {
      const envelope = normalizeEnvelope(call.envelope);
      if (!stableEqual(call.input.binding, envelope.binding)) fail("MEMORY_LIFECYCLE_BINDING_DRIFT");
      return execute("remember_final_transcript", envelope, call.input, () =>
        config.memoryReady.rememberFinalTranscript(call.input));
    },

    recallForAnswerContext(call) {
      const envelope = normalizeEnvelope(call.envelope);
      if (!isPlainRecord(call.input) || Object.prototype.hasOwnProperty.call(call.input, "userId") ||
          Object.prototype.hasOwnProperty.call(call.input, "purposeScope")) {
        fail("MEMORY_LIFECYCLE_QUERY_SCOPE_INVALID");
      }
      return execute("recall_for_answer_context", envelope, call.input, () =>
        config.memoryReady.recallForAnswerContext(call.input));
    },

    correctMemory(call) {
      const envelope = normalizeEnvelope(call.envelope);
      const input = call.input;
      if (input.idempotencyKey !== envelope.idempotencyKey || input.candidate.kind !== "correct" ||
          input.candidate.sourceClass !== "explicit_user_correction" || !candidateBound(input.candidate, envelope.binding)) {
        fail("MEMORY_LIFECYCLE_CORRECTION_BINDING_INVALID");
      }
      return execute("correct_memory", envelope, correctionFingerprint(input), async () => {
        const result = await config.application.commitCorrection(input);
        if (result.ok && (result.receipt.operation !== "correction" ||
            result.receipt.idempotencyKey !== input.idempotencyKey || result.receipt.canonicalRefs.length === 0 ||
            !result.receipt.supersededRefs.some((ref) => sameRef(ref, input.expectedCurrentRef)))) {
          fail("MEMORY_LIFECYCLE_CORRECTION_RECEIPT_INVALID");
        }
        return result;
      }, (result) => result.ok);
    },

    reviewCandidate(call) {
      const envelope = normalizeEnvelope(call.envelope);
      const input = call.input;
      if (input.idempotencyKey !== envelope.idempotencyKey || input.expectedUserId !== envelope.binding.userId) {
        fail("MEMORY_LIFECYCLE_REVIEW_BINDING_INVALID");
      }
      return execute("review_candidate", envelope, reviewFingerprint(input), async () => {
        let candidate: MemoryCandidateRecord | undefined;
        try {
          candidate = await config.candidateReader.findCandidateByRef(input.candidateRef);
        } catch (error) {
          fail("MEMORY_LIFECYCLE_CANDIDATE_READ_FAILED", error);
        }
        if (candidate === undefined || candidate.slot !== input.expectedSlot || !candidateBound(candidate, envelope.binding)) {
          fail("MEMORY_LIFECYCLE_REVIEW_BINDING_INVALID");
        }
        const result = await config.review.reviewCandidate(input);
        if (result.ok && (result.receipt.idempotencyKey !== input.idempotencyKey ||
            !sameRef(result.receipt.candidateRef, input.candidateRef) || result.receipt.decision !== input.decision)) {
          fail("MEMORY_LIFECYCLE_REVIEW_RECEIPT_INVALID");
        }
        if (result.ok && (input.decision === "reject" || input.decision === "quarantine") &&
            (result.receipt.createdMemoryRefs.length !== 0 || result.receipt.currentMemoryRefs.length !== 0)) {
          fail("MEMORY_LIFECYCLE_REVIEW_RECEIPT_INVALID");
        }
        return result;
      }, (result) => result.ok);
    },

    runDreamPage(call) {
      const envelope = normalizeEnvelope(call.envelope);
      const input = call.input;
      if (input.userId !== envelope.binding.userId || input.idempotencyKey !== envelope.idempotencyKey) {
        fail("MEMORY_LIFECYCLE_DREAM_BINDING_INVALID");
      }
      return execute("run_dream_page", envelope, dreamFingerprint(input), async () => {
        const result = await config.dream.runPage(input);
        if (result.userId !== envelope.binding.userId || result.idempotencyKey !== input.idempotencyKey ||
            result.candidates.some((candidate) => !candidateBound(candidate, envelope.binding)) ||
            (result.candidates.length > 0 && result.outcome !== "committed" && result.outcome !== "replayed")) {
          fail("MEMORY_LIFECYCLE_DREAM_RESULT_INVALID");
        }
        if (result.candidates.length > 0 && (result.commitReceipt === undefined ||
            result.commitReceipt.canonicalRefs.length !== result.candidates.length)) {
          fail("MEMORY_LIFECYCLE_DREAM_RESULT_INVALID");
        }
        return result;
      }, (result) => result.outcome !== "commit_rejected");
    },

    deleteAndRebuild(call) {
      const envelope = normalizeEnvelope(call.envelope);
      const input = call.input;
      if (input.idempotencyKey !== envelope.idempotencyKey) {
        fail("MEMORY_LIFECYCLE_DELETION_BINDING_INVALID");
      }
      return execute("delete_and_rebuild", envelope, input, async () => {
        const deletion = await config.deletion.execute(input);
        if (deletion.status !== "completed" && deletion.status !== "replayed") {
          return Object.freeze({ deletion });
        }
        validateCompletedDeletion(deletion);
        let coldCasResult: OwnerPortResult<ProductionMemoryColdCasLifecycleReceipt>;
        try {
          coldCasResult = await config.coldCas.applyAuthorizedLifecycle({ envelope, deletion });
        } catch (error) {
          fail("MEMORY_LIFECYCLE_COLD_CAS_UNAVAILABLE", error);
        }
        if (!coldCasResult.ok) fail("MEMORY_LIFECYCLE_COLD_CAS_REJECTED");
        const coldCas = normalizeColdCasReceipt(coldCasResult.value, envelope, deletion);
        return Object.freeze({ deletion, coldCas });
      }, (result) => result.deletion.status === "completed" || result.deletion.status === "replayed");
    },

    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = Promise.allSettled([config.coldCas.close(), config.memoryReady.close()]).then((results) => {
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") fail("MEMORY_LIFECYCLE_CLOSE_FAILED", rejected.reason);
      });
      return closePromise;
    },
  };
  return Object.freeze(lifecycle);
}
