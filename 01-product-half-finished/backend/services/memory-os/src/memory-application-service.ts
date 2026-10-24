import { createHash } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  EVIDENCE_SOURCE_CLASSES,
  isCanonicalUtcInstant,
  MEMORY_KINDS,
  MEMORY_COMMAND_ERROR_CODES,
  type CompilerQuery,
  type MemoryCandidateIntent,
  type MemoryCommandError,
  type MemoryCommandResult,
  type MemoryCommitReceipt,
  type ReadonlyJsonValue,
} from "./domain.ts";
import {
  ADMISSIBLE_EVIDENCE_REF_TYPES,
  ADMISSIBLE_USER_CORRECTION_REF_TYPES,
  type AdmittedMemoryCandidateIntent,
} from "./admission.ts";
import {
  compileMemoryContext,
  type CompiledMemoryContext,
} from "./context-compiler.ts";
import type {
  MemoryCanonicalIdentityProvider,
  MemoryCandidateBatchCommitCommand,
  MemoryCandidateIdentityProjection,
  MemoryCommandRepository,
  MemoryCorrectionIdentityProjection,
  MemoryCorrectionCommitCommand,
  MemoryRepository,
} from "./ports.ts";
import {
  assertProductionMemoryIssuerReceipt,
  issuerReceiptMatchesCandidate,
  type ProductionMemoryIssuerReceipt,
} from "./canonical-issuer.ts";

/** Input for one ordinary, already-admitted candidate commit. */
export interface CommitCandidateInput {
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly candidate: AdmittedMemoryCandidateIntent;
  /** Optional owner projection; production adapters must inject one. */
  readonly canonicalIdentity?: MemoryCandidateIdentityProjection;
  /** Complete T05 receipt; accepted only on the production wrapper path. */
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/** Input for one already-admitted correction with an optimistic CAS target. */
export interface CommitCorrectionInput {
  readonly idempotencyKey: string;
  readonly expectedCurrentRef: CanonicalObjectVersionRef;
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly resolvedContent?: string;
  /** Optional owner projection; production adapters must inject one. */
  readonly canonicalIdentity?: MemoryCorrectionIdentityProjection;
  /** Complete composite T05 receipt for candidate + durable successor. */
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
}

/**
 * Production command inputs deliberately have no canonicalIdentity field.
 * The only identity accepted here is a private-branded T05 issuer receipt.
 */
export interface ProductionCommitCandidateInput {
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly issuerReceipt: ProductionMemoryIssuerReceipt;
}

export interface ProductionCommitCorrectionInput {
  readonly idempotencyKey: string;
  readonly expectedCurrentRef: CanonicalObjectVersionRef;
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly resolvedContent?: string;
  readonly issuerReceipt: ProductionMemoryIssuerReceipt;
}

const MEMORY_REF_TYPES = new Set([
  "MemoryCandidate",
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
]);

const REQUIRED_CANDIDATE_KEYS = new Set([
  "kind",
  "status",
  "proposalId",
  "slot",
  "value",
  "evidenceRefs",
  "sourceClass",
  "confidencePpm",
  "idempotencyKey",
  "current",
  "memoryKind",
  "userId",
  "purposeScopes",
  "sensitivity",
  "validity",
]);

const OPTIONAL_CANDIDATE_KEYS = new Set([
  "target",
  "correctionIntent",
  "reason",
  "conflict",
]);

const REQUIRED_CORRECTION_KEYS = new Set(["kind", "target"]);
const OPTIONAL_CORRECTION_KEYS = new Set(["reason", "evidenceRefs"]);

const ALLOWED_EVIDENCE_TYPES = new Set<string>([
  ...ADMISSIBLE_EVIDENCE_REF_TYPES,
  ...ADMISSIBLE_USER_CORRECTION_REF_TYPES,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): boolean {
  const keys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const allowed = new Set([...required, ...optional]);
  return [...required].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): value is ReadonlyJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (!isPlainRecord(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function cloneJson<T extends ReadonlyJsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as unknown as T;
  }
  const result: Record<string, ReadonlyJsonValue> = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
  return result as T;
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

function refsAreUnique(refs: readonly CanonicalObjectVersionRef[]): boolean {
  const keys = refs.map((ref) => canonicalRefKey(ref));
  return new Set(keys).size === keys.length;
}

function validateRefs(
  value: unknown,
  options: { readonly requireNonEmpty: boolean; readonly allowMemoryRefs: boolean },
): value is readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(value)) return false;
  if (options.requireNonEmpty && value.length === 0) return false;
  try {
    const refs = value.map((ref) => assertCanonicalObjectVersionRef(ref));
    if (!refsAreUnique(refs)) return false;
    return refs.every((ref) => options.allowMemoryRefs
      ? ALLOWED_EVIDENCE_TYPES.has(ref.refType)
      : (ADMISSIBLE_EVIDENCE_REF_TYPES as readonly string[]).includes(ref.refType));
  } catch {
    return false;
  }
}

function validateValidity(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["validFrom", "validTo", "observedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !isCanonicalUtcInstant(value[key])) {
      return false;
    }
  }
  if (value.validFrom !== undefined && value.validTo !== undefined) {
    if (Date.parse(value.validFrom as string) > Date.parse(value.validTo as string)) return false;
  }
  return true;
}

function validateCorrectionIntent(value: unknown): value is NonNullable<AdmittedMemoryCandidateIntent["correctionIntent"]> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, REQUIRED_CORRECTION_KEYS, OPTIONAL_CORRECTION_KEYS)) {
    return false;
  }
  if (value.kind !== "correct" || !isCanonicalObjectVersionRef(value.target)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "reason") && !isJsonValue(value.reason)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "evidenceRefs") &&
      !validateRefs(value.evidenceRefs, { requireNonEmpty: true, allowMemoryRefs: true })) {
    return false;
  }
  return true;
}

function validateCandidateShape(candidate: unknown): candidate is AdmittedMemoryCandidateIntent {
  if (!isPlainRecord(candidate) || !hasOnlyKeys(candidate, REQUIRED_CANDIDATE_KEYS, OPTIONAL_CANDIDATE_KEYS)) {
    return false;
  }
  if (candidate.status !== "candidate" || candidate.current !== false) return false;
  if (candidate.kind !== "create" && candidate.kind !== "correct") return false;
  if (!MEMORY_KINDS.includes(candidate.memoryKind as (typeof MEMORY_KINDS)[number])) return false;
  if (!isNonEmptyString(candidate.proposalId) || !isNonEmptyString(candidate.userId) ||
      !isNonEmptyString(candidate.slot) || !isNonEmptyString(candidate.idempotencyKey)) return false;
  if (!(EVIDENCE_SOURCE_CLASSES as readonly string[]).includes(candidate.sourceClass as string)) return false;
  if (!Number.isInteger(candidate.confidencePpm) ||
      (candidate.confidencePpm as number) < 0 || (candidate.confidencePpm as number) > 1_000_000) return false;
  if (!isJsonValue(candidate.value)) return false;
  if (!validateRefs(candidate.evidenceRefs, { requireNonEmpty: true, allowMemoryRefs: candidate.kind === "correct" })) return false;
  if (!Array.isArray(candidate.purposeScopes) || candidate.purposeScopes.length === 0 ||
      !candidate.purposeScopes.every(isNonEmptyString)) return false;
  const purposeKeys = candidate.purposeScopes.map((scope) => scope.trim());
  if (new Set(purposeKeys).size !== purposeKeys.length) return false;
  if (!isPlainRecord(candidate.sensitivity) ||
      !hasOnlyKeys(candidate.sensitivity, new Set(["classification", "userConfirmed"]), new Set()) ||
      (candidate.sensitivity.classification !== "normal" && candidate.sensitivity.classification !== "sensitive") ||
      typeof candidate.sensitivity.userConfirmed !== "boolean") return false;
  if (!validateValidity(candidate.validity)) return false;
  if (Object.prototype.hasOwnProperty.call(candidate, "reason") && !isJsonValue(candidate.reason)) return false;
  if (Object.prototype.hasOwnProperty.call(candidate, "conflict") && !isJsonValue(candidate.conflict)) return false;

  if (Object.prototype.hasOwnProperty.call(candidate, "target")) {
    if (!isCanonicalObjectVersionRef(candidate.target) ||
        !candidate.evidenceRefs.some((ref) => canonicalRefKey(ref) === canonicalRefKey(candidate.target))) return false;
  }

  if (candidate.kind === "correct") {
    const correction = candidate.correctionIntent;
    if (candidate.sourceClass !== "explicit_user_correction" ||
        !validateCorrectionIntent(correction) ||
        !Object.prototype.hasOwnProperty.call(candidate, "target") ||
        canonicalRefKey(candidate.target) !== canonicalRefKey(correction.target) ||
        !candidate.evidenceRefs.some((ref) => canonicalRefKey(ref) === canonicalRefKey(correction.target))) {
      return false;
    }
  } else if (Object.prototype.hasOwnProperty.call(candidate, "correctionIntent")) {
    return false;
  }
  return true;
}

function normalizedJson(value: ReadonlyJsonValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalizedJson(item));
  const result: Record<string, unknown> = {};
  const record = value as { readonly [key: string]: ReadonlyJsonValue };
  for (const key of Object.keys(record).sort()) result[key] = normalizedJson(record[key]!);
  return result;
}

function normalizedRefs(refs: readonly CanonicalObjectVersionRef[]): readonly string[] {
  return refs.map((ref) => canonicalRefKey(ref)).sort();
}

function normalizedOptionalJson(value: unknown): unknown {
  return value === undefined ? undefined : normalizedJson(value as ReadonlyJsonValue);
}

/**
 * Stable application fingerprint.  It is only a request identity; it is not
 * a canonical payload hash and never becomes an object reference.
 */
export function fingerprintAdmittedCandidate(
  candidate: AdmittedMemoryCandidateIntent,
): Sha256 {
  if (!validateCandidateShape(candidate)) throw new TypeError("candidate is not an admitted memory intent");
  const correction = candidate.correctionIntent;
  const payload: Record<string, unknown> = {
    kind: candidate.kind,
    memoryKind: candidate.memoryKind,
    userId: candidate.userId,
    slot: candidate.slot,
    value: normalizedJson(candidate.value),
    sourceClass: candidate.sourceClass,
    evidenceRefs: normalizedRefs(candidate.evidenceRefs),
    purposeScopes: candidate.purposeScopes.map((scope) => scope.trim()).sort(),
    confidencePpm: candidate.confidencePpm,
    sensitivity: {
      classification: candidate.sensitivity.classification,
      userConfirmed: candidate.sensitivity.userConfirmed,
    },
    validity: normalizedJson(candidate.validity as unknown as ReadonlyJsonValue),
    proposalId: candidate.proposalId,
    ...(candidate.target === undefined ? {} : { target: canonicalRefKey(candidate.target) }),
    ...(candidate.reason === undefined ? {} : { reason: normalizedOptionalJson(candidate.reason) }),
    ...(candidate.conflict === undefined ? {} : { conflict: normalizedOptionalJson(candidate.conflict) }),
    ...(correction === undefined ? {} : {
      correctionIntent: {
        kind: correction.kind,
        target: canonicalRefKey(correction.target),
        ...(correction.reason === undefined ? {} : { reason: normalizedOptionalJson(correction.reason) }),
        ...(correction.evidenceRefs === undefined ? {} : { evidenceRefs: normalizedRefs(correction.evidenceRefs) }),
      },
    }),
  };
  return assertSha256(createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"));
}

function fingerprintCommandPayload(payload: Readonly<Record<string, unknown>>): Sha256 {
  return assertSha256(createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"));
}

/** Fingerprint of the complete candidate-batch command, including its scope. */
function fingerprintCandidateCommand(
  batchId: string,
  candidate: AdmittedMemoryCandidateIntent,
  issuerReceipt?: ProductionMemoryIssuerReceipt,
): Sha256 {
  return fingerprintCommandPayload({
    operation: "candidate_batch",
    batchId,
    candidateFingerprint: fingerprintAdmittedCandidate(candidate),
    issuerReceipt: issuerReceiptFingerprint(issuerReceipt),
  });
}

/** Fingerprint of all correction command semantics, including CAS and content. */
function fingerprintCorrectionCommand(
  expectedCurrentRef: CanonicalObjectVersionRef,
  candidate: AdmittedMemoryCandidateIntent,
  resolvedContent: string | undefined,
  issuerReceipt?: ProductionMemoryIssuerReceipt,
): Sha256 {
  return fingerprintCommandPayload({
    operation: "correction",
    candidateFingerprint: fingerprintAdmittedCandidate(candidate),
    expectedCurrentRef: canonicalRefKey(expectedCurrentRef),
    resolvedContent: resolvedContent === undefined
      ? { present: false }
      : { present: true, value: resolvedContent },
    issuerReceipt: issuerReceiptFingerprint(issuerReceipt),
  });
}

function issuerReceiptFingerprint(
  receipt: ProductionMemoryIssuerReceipt | undefined,
): Readonly<Record<string, unknown>> {
  if (receipt === undefined) return { present: false };
  const value = assertProductionMemoryIssuerReceipt(receipt);
  const candidateReceipt = value.candidateReceipt;
  return {
    present: true,
    operation: value.operation,
    candidateRef: value.candidateRef === undefined ? { present: false } : canonicalRefKey(value.candidateRef),
    memoryRef: value.memoryRef === undefined ? { present: false } : canonicalRefKey(value.memoryRef),
    previousRef: value.previousRef === undefined ? { present: false } : canonicalRefKey(value.previousRef),
    candidateBindingSha256: value.candidateBindingSha256,
    canonicalPayloadSha256: value.canonicalPayloadSha256,
    candidateReceipt: candidateReceipt === undefined ? { present: false } : {
      operation: candidateReceipt.operation,
      candidateRef: candidateReceipt.candidateRef === undefined ? { present: false } : canonicalRefKey(candidateReceipt.candidateRef),
      previousRef: candidateReceipt.previousRef === undefined ? { present: false } : canonicalRefKey(candidateReceipt.previousRef),
      canonicalPayloadSha256: candidateReceipt.canonicalPayloadSha256,
    },
  };
}

function invalidCommand(): MemoryCommandResult<MemoryCommitReceipt> {
  return {
    ok: false,
    error: { code: "INVALID_COMMAND", retryable: false },
  };
}

function abortedCommand(): MemoryCommandResult<MemoryCommitReceipt> {
  return {
    ok: false,
    error: { code: "TRANSACTION_ABORTED", retryable: true },
  };
}

function ownerStateUnavailable(): MemoryCommandResult<MemoryCommitReceipt> {
  return {
    ok: false,
    error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true },
  };
}

function isMemoryCommandError(value: unknown): value is MemoryCommandError {
  return isRecord(value) && typeof value.code === "string" && typeof value.retryable === "boolean";
}

function sanitizedCommandError(value: unknown): MemoryCommandError | undefined {
  if (!isMemoryCommandError(value) ||
      !(MEMORY_COMMAND_ERROR_CODES as readonly string[]).includes(value.code)) return undefined;
  const error = {
    code: value.code as MemoryCommandError["code"],
    retryable: value.retryable,
    ...(validWatermark(value.authorityWatermark)
      ? { authorityWatermark: value.authorityWatermark }
      : {}),
  };
  return error;
}

function commandFailure(value: unknown): MemoryCommandResult<MemoryCommitReceipt> {
  if (isRecord(value) && value.ok === false) {
    const error = sanitizedCommandError(value.error);
    if (error !== undefined) return { ok: false, error };
  }
  return abortedCommand();
}

function validWatermark(value: unknown): boolean {
  return value !== undefined && value !== null &&
    (typeof value !== "string" || value.trim().length > 0);
}

function validateReceiptRefs(value: unknown): value is readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(value)) return false;
  try {
    const refs = value.map((item) => assertCanonicalObjectVersionRef(item));
    return new Set(refs.map((ref) => canonicalRefKey(ref))).size === refs.length;
  } catch {
    return false;
  }
}

function receiptKeysValid(receipt: Record<string, unknown>): boolean {
  return hasOnlyKeys(
    receipt,
    new Set([
      "kind",
      "operation",
      "outcome",
      "idempotencyKey",
      "fingerprint",
      "canonicalRefs",
      "supersededRefs",
      "authorityWatermark",
    ]),
    new Set(),
  );
}

function validateRepositoryReceipt(
  value: unknown,
  expected: {
    readonly operation: "candidate_batch" | "correction";
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly candidate?: AdmittedMemoryCandidateIntent;
    readonly expectedCurrentRef?: CanonicalObjectVersionRef;
    readonly expectedCanonicalRef?: CanonicalObjectVersionRef;
  },
): MemoryCommitReceipt | undefined {
  if (!isPlainRecord(value) || !receiptKeysValid(value) ||
      value.kind !== "memory_commit_receipt" || value.operation !== expected.operation ||
      value.idempotencyKey !== expected.idempotencyKey || value.fingerprint !== expected.fingerprint ||
      (value.outcome !== "committed" && value.outcome !== "replayed") ||
      !validWatermark(value.authorityWatermark) ||
      !validateReceiptRefs(value.canonicalRefs) || !validateReceiptRefs(value.supersededRefs)) {
    return undefined;
  }

  const canonicalRefs = value.canonicalRefs as readonly CanonicalObjectVersionRef[];
  const supersededRefs = value.supersededRefs as readonly CanonicalObjectVersionRef[];
  if (expected.operation === "candidate_batch") {
    if (canonicalRefs.length !== 1 || canonicalRefs[0]?.refType !== "MemoryCandidate" || supersededRefs.length !== 0) {
      return undefined;
    }
    if (expected.expectedCanonicalRef !== undefined &&
        canonicalRefKey(canonicalRefs[0]!) !== canonicalRefKey(expected.expectedCanonicalRef)) return undefined;
  } else {
    const expectedCurrentRef = expected.expectedCurrentRef;
    const candidate = expected.candidate;
    if (expectedCurrentRef === undefined || candidate === undefined ||
        canonicalRefs.length !== 1 || supersededRefs.length !== 1 ||
        canonicalRefKey(canonicalRefs[0]!) === canonicalRefKey(expectedCurrentRef) ||
        canonicalRefKey(supersededRefs[0]!) !== canonicalRefKey(expectedCurrentRef)) {
      return undefined;
    }
    const memoryRefTypeByKind: Readonly<Record<string, string>> = {
      semantic_fact: "SemanticFact",
      episodic_memory: "EpisodicMemory",
      preference_memory: "PreferenceMemory",
      open_loop: "OpenLoop",
    };
    if (canonicalRefs[0]!.refType !== memoryRefTypeByKind[candidate.memoryKind]) return undefined;
    if (expected.expectedCanonicalRef !== undefined &&
        canonicalRefKey(canonicalRefs[0]!) !== canonicalRefKey(expected.expectedCanonicalRef)) return undefined;
  }

  return Object.freeze({
    kind: "memory_commit_receipt",
    operation: expected.operation,
    outcome: value.outcome,
    idempotencyKey: expected.idempotencyKey,
    fingerprint: expected.fingerprint,
    canonicalRefs: Object.freeze(canonicalRefs.map(cloneRef)),
    supersededRefs: Object.freeze(supersededRefs.map(cloneRef)),
    authorityWatermark: value.authorityWatermark,
  });
}

function validateCommandResult(
  value: unknown,
  expected: {
    readonly operation: "candidate_batch" | "correction";
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly candidate?: AdmittedMemoryCandidateIntent;
    readonly expectedCurrentRef?: CanonicalObjectVersionRef;
    readonly expectedCanonicalRef?: CanonicalObjectVersionRef;
  },
): MemoryCommandResult<MemoryCommitReceipt> {
  if (isRecord(value) && value.ok === false) {
    const error = sanitizedCommandError(value.error);
    if (error !== undefined) return { ok: false, error };
    return ownerStateUnavailable();
  }
  if (!isRecord(value) || value.ok !== true) return ownerStateUnavailable();
  const receipt = validateRepositoryReceipt(value.receipt, expected);
  return receipt === undefined ? ownerStateUnavailable() : { ok: true, receipt };
}

function validateInputKeys(value: unknown, required: readonly string[], optional: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  return hasOnlyKeys(value, new Set(required), new Set(optional));
}

/**
 * T05 application seam.  It accepts only admitted candidate intents, delegates
 * all canonical identity and watermark creation to the repository receipt, and
 * uses the compiler for read-only context queries.
 */
export class MemoryApplicationService {
  private readonly memoryRepository: MemoryRepository;
  private readonly commandRepository: MemoryCommandRepository;
  private readonly canonicalIdentity: MemoryCanonicalIdentityProvider | undefined;

  public constructor(
    memoryRepository: MemoryRepository,
    commandRepository: MemoryCommandRepository,
    canonicalIdentity?: MemoryCanonicalIdentityProvider,
  ) {
    this.memoryRepository = memoryRepository;
    this.commandRepository = commandRepository;
    this.canonicalIdentity = canonicalIdentity;
  }

  public async commitCandidate(
    input: CommitCandidateInput,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    try {
      if (!validateInputKeys(input, ["batchId", "idempotencyKey", "candidate"], ["canonicalIdentity", "issuerReceipt"]) ||
          !isNonEmptyString(input.batchId) || !isNonEmptyString(input.idempotencyKey) ||
          !validateCandidateShape(input.candidate) ||
          input.idempotencyKey !== input.candidate.idempotencyKey || input.candidate.kind !== "create" ||
          (input.canonicalIdentity !== undefined &&
            !isCanonicalObjectVersionRef(input.canonicalIdentity.candidateRef)) ||
          (input.issuerReceipt !== undefined &&
            (!issuerReceiptMatchesCandidate(input.issuerReceipt, input.candidate) ||
             input.issuerReceipt.operation !== "candidate_create"))) {
        return invalidCommand();
      }
      const fingerprint = fingerprintCandidateCommand(input.batchId, input.candidate, input.issuerReceipt);
      let canonicalIdentity = input.canonicalIdentity;
      if (canonicalIdentity === undefined && this.canonicalIdentity !== undefined) {
        const candidateRef = await this.canonicalIdentity.candidateRefFor({
          batchId: input.batchId,
          idempotencyKey: input.idempotencyKey,
          candidateIndex: 0,
          candidate: input.candidate,
        });
        canonicalIdentity = { candidateRef: assertCanonicalObjectVersionRef(candidateRef) };
      }
      const command: MemoryCandidateBatchCommitCommand = {
        batchId: input.batchId,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        candidates: [input.candidate],
        ...(canonicalIdentity === undefined ? {} : { candidateIdentities: [canonicalIdentity] }),
        ...(input.issuerReceipt === undefined ? {} : { issuerReceipt: input.issuerReceipt }),
      };
      const result = await this.commandRepository.withTransaction(async (transaction) =>
        transaction.commitCandidateBatch(command));
      return validateCommandResult(result, {
        operation: "candidate_batch",
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
        ...(canonicalIdentity === undefined ? {} : { expectedCanonicalRef: canonicalIdentity.candidateRef }),
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  public async commitCorrection(
    input: CommitCorrectionInput,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    try {
      if (!validateInputKeys(input, ["idempotencyKey", "expectedCurrentRef", "candidate"], ["resolvedContent", "canonicalIdentity", "issuerReceipt"]) ||
          !isNonEmptyString(input.idempotencyKey) ||
          !isCanonicalObjectVersionRef(input.expectedCurrentRef) ||
          !validateCandidateShape(input.candidate) ||
          input.idempotencyKey !== input.candidate.idempotencyKey || input.candidate.kind !== "correct" ||
          (input.resolvedContent !== undefined && typeof input.resolvedContent !== "string") ||
           (input.canonicalIdentity !== undefined &&
            (!isCanonicalObjectVersionRef(input.canonicalIdentity.candidateRef) ||
             !isCanonicalObjectVersionRef(input.canonicalIdentity.memoryRef))) ||
           (input.issuerReceipt !== undefined &&
            (!issuerReceiptMatchesCandidate(input.issuerReceipt, input.candidate) ||
             input.issuerReceipt.operation !== "memory_successor" ||
             input.issuerReceipt.previousRef === undefined ||
             canonicalRefKey(input.issuerReceipt.previousRef) !== canonicalRefKey(input.expectedCurrentRef)))) {
        return invalidCommand();
      }
      const expectedCurrentRef = cloneRef(input.expectedCurrentRef);
      if (candidateHasForbiddenCorrectionTarget(input.candidate, expectedCurrentRef)) return invalidCommand();
      const fingerprint = fingerprintCorrectionCommand(
        expectedCurrentRef,
        input.candidate,
        input.resolvedContent,
        input.issuerReceipt,
      );
      const command: MemoryCorrectionCommitCommand = {
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        expectedCurrentRef,
        replacement: input.candidate,
        ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
        ...(input.canonicalIdentity === undefined ? {} : { identity: input.canonicalIdentity }),
        ...(input.issuerReceipt === undefined ? {} : { issuerReceipt: input.issuerReceipt }),
      };
      const result = await this.commandRepository.withTransaction(async (transaction) =>
        transaction.commitCorrection(command));
      return validateCommandResult(result, {
        operation: "correction",
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
        candidate: input.candidate,
        expectedCurrentRef,
        ...(input.canonicalIdentity === undefined ? {} : { expectedCanonicalRef: input.canonicalIdentity.memoryRef }),
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  /** Read-only bounded query; no resolver, vector, graph, or cache access. */
  public queryContext(query: CompilerQuery): Promise<CompiledMemoryContext> {
    return compileMemoryContext(this.memoryRepository, query);
  }
}

/**
 * Production-only wrapper. The storage-neutral service remains available for
 * volatile unit fixtures, while this entry point rejects raw refs, forged
 * brands, non-production fixtures, mixed candidate/receipt bindings, and
 * correction predecessor drift before entering the repository transaction.
 */
export class ProductionMemoryApplicationService {
  readonly #delegate: MemoryApplicationService;

  constructor(delegate: MemoryApplicationService) {
    this.#delegate = delegate;
  }

  public async commitCandidate(
    input: ProductionCommitCandidateInput,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    try {
      if (!validateInputKeys(input, ["batchId", "idempotencyKey", "candidate", "issuerReceipt"], []) ||
          !isNonEmptyString(input.batchId) || !isNonEmptyString(input.idempotencyKey) ||
          !validateCandidateShape(input.candidate) || input.candidate.kind !== "create" ||
          input.idempotencyKey !== input.candidate.idempotencyKey ||
          !issuerReceiptMatchesCandidate(input.issuerReceipt, input.candidate)) {
        return invalidCommand();
      }
      const receipt = assertProductionMemoryIssuerReceipt(input.issuerReceipt);
      if (receipt.operation !== "candidate_create" || receipt.candidateRef === undefined) return invalidCommand();
      return this.#delegate.commitCandidate({
        batchId: input.batchId,
        idempotencyKey: input.idempotencyKey,
        candidate: input.candidate,
        canonicalIdentity: { candidateRef: cloneRef(receipt.candidateRef) },
        issuerReceipt: receipt,
      });
    } catch {
      return invalidCommand();
    }
  }

  public async commitCorrection(
    input: ProductionCommitCorrectionInput,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    try {
      if (!validateInputKeys(input, ["idempotencyKey", "expectedCurrentRef", "candidate", "issuerReceipt"], ["resolvedContent"]) ||
          !isNonEmptyString(input.idempotencyKey) || !isCanonicalObjectVersionRef(input.expectedCurrentRef) ||
          !validateCandidateShape(input.candidate) || input.candidate.kind !== "correct" ||
          input.idempotencyKey !== input.candidate.idempotencyKey ||
          !issuerReceiptMatchesCandidate(input.issuerReceipt, input.candidate)) {
        return invalidCommand();
      }
      const receipt = assertProductionMemoryIssuerReceipt(input.issuerReceipt);
      if (receipt.operation !== "memory_successor" || receipt.memoryRef === undefined || receipt.previousRef === undefined ||
          canonicalRefKey(receipt.previousRef) !== canonicalRefKey(input.expectedCurrentRef)) {
        return invalidCommand();
      }
      return this.#delegate.commitCorrection({
        idempotencyKey: input.idempotencyKey,
        expectedCurrentRef: cloneRef(input.expectedCurrentRef),
        candidate: input.candidate,
        ...(input.resolvedContent === undefined ? {} : { resolvedContent: input.resolvedContent }),
        canonicalIdentity: {
          candidateRef: cloneRef(receipt.candidateRef ?? receipt.previousRef),
          memoryRef: cloneRef(receipt.memoryRef),
        },
        issuerReceipt: receipt,
      });
    } catch {
      return invalidCommand();
    }
  }

  public queryContext(query: CompilerQuery): Promise<CompiledMemoryContext> {
    return this.#delegate.queryContext(query);
  }
}

function candidateHasForbiddenCorrectionTarget(
  candidate: AdmittedMemoryCandidateIntent,
  expectedCurrentRef: CanonicalObjectVersionRef,
): boolean {
  if (!MEMORY_REF_TYPES.has(expectedCurrentRef.refType)) return true;
  if (candidate.target === undefined || candidate.correctionIntent === undefined) return true;
  return canonicalRefKey(candidate.target) !== canonicalRefKey(expectedCurrentRef) ||
    canonicalRefKey(candidate.correctionIntent.target) !== canonicalRefKey(expectedCurrentRef);
}

export function createMemoryApplicationService(
  memoryRepository: MemoryRepository,
  commandRepository: MemoryCommandRepository,
): MemoryApplicationService {
  return new MemoryApplicationService(memoryRepository, commandRepository);
}

export function createProductionMemoryApplicationService(
  memoryRepository: MemoryRepository,
  commandRepository: MemoryCommandRepository,
): ProductionMemoryApplicationService {
  return new ProductionMemoryApplicationService(
    new MemoryApplicationService(memoryRepository, commandRepository),
  );
}
