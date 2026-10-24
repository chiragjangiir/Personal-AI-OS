import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  AdmittedMemoryCandidateIntent,
} from "../../memory-os/src/admission.ts";
import {
  MEMORY_KINDS,
  type AuthorityWatermark,
  type CompilerQuery,
  type MemoryCandidateQuery,
  type MemoryCandidateRecord,
  type MemoryCandidateSnapshot,
  type MemoryCommandError,
  type MemoryCommandResult,
  type MemoryCommitReceipt,
  type MemoryReviewCommandIdentity,
  type MemoryReviewReceipt,
  type MemoryReviewReplayRecord,
  type MemoryReviewStateQuery,
  type MemoryReviewStateSnapshot,
  type MemoryVersionRecord,
} from "../../memory-os/src/domain.ts";
import type {
  CanonicalMemoryPayload,
  ProductionMemoryIssuerReceipt,
} from "../../memory-os/src/canonical-issuer.ts";
import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../memory-os/src/canonical-ref.ts";
import type {
  AcceptedDreamDeltaReader,
  MemoryCanonicalIdentityProvider,
  MemoryCandidateBatchCommitCommand,
  MemoryCandidateIdentityProjection,
  MemoryCandidateReader,
  MemoryCommandRepository,
  MemoryCommandTransaction,
  MemoryCorrectionCommitCommand,
  MemoryRepository,
  MemoryReviewReceiptReader,
  MemoryReviewStateReader,
  MemoryReviewTransaction,
  MemoryCanonicalAppendWriter,
  MemoryCanonicalVersionReader,
  MemoryCanonicalVersionRead,
  MemoryAppendOnlyAuthorityWatermark,
  OwnerPortResult,
} from "../../memory-os/src/ports.ts";
import {
  claimIdempotency,
  completeIdempotency,
  IdempotencyConflictError,
  type IdempotencyRecord,
} from "./idempotency-ledger.ts";
import {
  enqueueOutboxEvent,
  type OutboxEventInput,
} from "./transactional-outbox.ts";
import {
  asCandidateRecord,
  asMemoryVersionRecord,
  assertMemoryKind,
  assertAuthorityWatermark,
  assertOwnerIdentityProvider,
  assertRefColumnEquality,
  cloneCanonicalRef,
  dateToCanonical,
  memoryKindRefMatches,
  memoryKindRefTypeForKind,
  refToColumns,
  stableJsonClone,
  stableJsonEqual,
  stableJsonHash,
  stableJsonText,
  type MemoryAuthorityWatermark,
  type MemoryCanonicalReceiptCodec,
  type MemoryPersistenceValue,
  MemoryPersistenceError,
  projectCanonicalReceipt,
  rehydrateCanonicalReceipt,
  watermarkFromEpoch,
  canonicalWireRefToInternal,
  canonicalWireRefsToInternal,
  canonicalWireSensitivityToInternal,
  canonicalWireValidityToInternal,
  canonicalWireCorrectionToInternal,
} from "./memory-persistence-primitives.ts";
import { withReadOnlyTransaction, withTransaction } from "./transaction.ts";

export interface MemoryAuthorityRepositoryOptions {
  /** Required for every production side effect; never generated here. */
  readonly canonicalIdentity?: MemoryCanonicalIdentityProvider;
  /** Required before any canonical append or exact canonical read. */
  readonly canonicalCodec?: MemoryCanonicalReceiptCodec;
  /** Explicit test marker. It does not waive the identity requirement. */
  readonly environment?: "production" | "non-production";
  readonly applicationName?: string;
}

export class MemoryCommandFailure extends Error {
  readonly commandError: MemoryCommandError;
  constructor(commandError: MemoryCommandError, cause?: unknown) {
    super(commandError.code, cause === undefined ? undefined : { cause });
    this.name = "MemoryCommandFailure";
    this.commandError = commandError;
  }
}

const CANDIDATE_COLUMNS = [
  "candidate_ref, candidate_ref_type, candidate_ref_id, candidate_object_version, candidate_payload_sha256,",
  "kind, status, proposal_id, slot, value, evidence_refs, source_class, confidence_ppm, idempotency_key, current, memory_kind, user_id,",
  "purpose_scopes, sensitivity, validity, target_ref, target_ref_type, target_ref_id, target_object_version, target_payload_sha256,",
  "correction_intent, reason, conflict, requires_review, conflict_binding, linked_memory_ref, linked_memory_ref_type, linked_memory_ref_id,",
  "linked_memory_object_version, linked_memory_payload_sha256, reviewed_at, created_at, updated_at",
].join(" ");

const MEMORY_COLUMNS = [
  "memory_ref, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, user_id, kind, slot, value, resolved_content,",
  "status, current, source_class, evidence_refs, confidence_ppm, allowed_purpose_scopes, sensitivity, validity, supersedes_ref,",
  "supersedes_ref_type, supersedes_ref_id, supersedes_object_version, supersedes_payload_sha256, correction_intent, dream_accepted_delta,",
  "deleted_at, suppressed_at, stale, derived_rank_score, created_at, updated_at",
].join(" ");

const QUALIFIED_MEMORY_COLUMNS = MEMORY_COLUMNS.split(",").map((column) => `v.${column.trim()}`).join(", ");
const QUALIFIED_CANDIDATE_COLUMNS = CANDIDATE_COLUMNS.split(",").map((column) => `v.${column.trim()}`).join(", ");

const MEMORY_REF_TYPES = new Set(["SemanticFact", "EpisodicMemory", "PreferenceMemory", "OpenLoop"]);

function commandError(code: MemoryCommandError["code"], retryable: boolean, authorityWatermark?: AuthorityWatermark): MemoryCommandFailure {
  return new MemoryCommandFailure({
    code,
    retryable,
    ...(authorityWatermark === undefined ? {} : { authorityWatermark }),
  });
}

function sqlCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function normalizeCommandError(error: unknown): MemoryCommandError | undefined {
  if (error instanceof MemoryCommandFailure) return error.commandError;
  if (error instanceof IdempotencyConflictError || (error instanceof Error && error.name === "IdempotencyConflictError")) {
    return { code: "IDEMPOTENCY_CONFLICT", retryable: false };
  }
  const code = sqlCode(error);
  if (code === "23505") return { code: "CURRENT_VERSION_CONFLICT", retryable: false };
  if (code === "40001" || code === "40P01") return { code: "TRANSACTION_ABORTED", retryable: true };
  return undefined;
}

function cloneReceipt(value: MemoryCommitReceipt, outcome: "committed" | "replayed" = value.outcome): MemoryCommitReceipt {
  return Object.freeze({
    kind: "memory_commit_receipt",
    operation: value.operation,
    outcome,
    idempotencyKey: value.idempotencyKey,
    fingerprint: value.fingerprint,
    canonicalRefs: Object.freeze(value.canonicalRefs.map(cloneCanonicalRef)),
    supersededRefs: Object.freeze(value.supersededRefs.map(cloneCanonicalRef)),
    authorityWatermark: stableJsonClone(value.authorityWatermark),
  });
}

function cloneReviewReceipt(value: MemoryReviewReceipt, outcome: "committed" | "replayed" = value.outcome): MemoryReviewReceipt {
  return Object.freeze({
    ...value,
    outcome,
    candidateRef: cloneCanonicalRef(value.candidateRef),
    createdMemoryRefs: Object.freeze(value.createdMemoryRefs.map(cloneCanonicalRef)),
    linkedMemoryRefs: Object.freeze(value.linkedMemoryRefs.map(cloneCanonicalRef)),
    currentMemoryRefs: Object.freeze(value.currentMemoryRefs.map(cloneCanonicalRef)),
    supersededRefs: Object.freeze(value.supersededRefs.map(cloneCanonicalRef)),
    ...(value.conflictBinding === undefined ? {} : { conflictBinding: stableJsonClone(value.conflictBinding) }),
    authorityWatermark: stableJsonClone(value.authorityWatermark),
  });
}

function memoryRefType(kind: MemoryVersionRecord["kind"]): CanonicalObjectVersionRef["refType"] {
  return memoryKindRefTypeForKind(kind);
}

function hasCanonicalCodecShape(value: unknown): value is MemoryCanonicalReceiptCodec {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    for (const key of ["assertReceipt", "projectReceipt", "rehydrateReceipt"] as const) {
      let current: object | null = value;
      let descriptor: PropertyDescriptor | undefined;
      while (current !== null) {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor !== undefined) break;
        current = Object.getPrototypeOf(current);
      }
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ||
          typeof descriptor.value !== "function") return false;
    }
    return true;
  } catch {
    return false;
  }
}

function incrementDecimal(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new MemoryPersistenceError("INVALID_WATERMARK");
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const next = Number(digits[index]) + 1;
    digits[index] = String(next % 10);
    carry = next >= 10 ? 1 : 0;
  }
  if (carry === 1) digits.unshift("1");
  return digits.join("");
}

function deterministicUuid(scope: string, key: string, eventType: string): string {
  const digest = createHash("sha256").update(`${scope}\u0000${key}\u0000${eventType}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function freezeRefs(values: readonly CanonicalObjectVersionRef[]): readonly CanonicalObjectVersionRef[] {
  return Object.freeze(values.map(cloneCanonicalRef));
}

function refKeySet(values: readonly CanonicalObjectVersionRef[]): Set<string> {
  return new Set(values.map(canonicalRefKey));
}

function exactStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MemoryPersistenceError("INVALID_ARRAY");
  }
  return Object.freeze(value.map((item) => String(item)));
}

function candidateRecordFromIntent(
  candidateRef: CanonicalObjectVersionRef,
  candidate: AdmittedMemoryCandidateIntent,
  overrides: Partial<MemoryCandidateRecord> = {},
): MemoryCandidateRecord {
  return Object.freeze({
    candidateRef: cloneCanonicalRef(candidateRef),
    kind: candidate.kind,
    status: "candidate",
    proposalId: candidate.proposalId,
    slot: candidate.slot,
    value: stableJsonClone(candidate.value),
    evidenceRefs: freezeRefs(candidate.evidenceRefs),
    sourceClass: candidate.sourceClass,
    confidencePpm: candidate.confidencePpm,
    idempotencyKey: candidate.idempotencyKey,
    current: false,
    memoryKind: candidate.memoryKind,
    userId: candidate.userId,
    purposeScopes: exactStringArray(candidate.purposeScopes),
    sensitivity: stableJsonClone(candidate.sensitivity),
    validity: stableJsonClone(candidate.validity),
    ...(candidate.target === undefined ? {} : { target: cloneCanonicalRef(candidate.target) }),
    ...(candidate.correctionIntent === undefined ? {} : { correctionIntent: stableJsonClone(candidate.correctionIntent) }),
    ...(candidate.reason === undefined ? {} : { reason: stableJsonClone(candidate.reason) }),
    ...(candidate.conflict === undefined ? {} : { conflict: stableJsonClone(candidate.conflict) }),
    requiresReview: true,
    ...overrides,
  });
}

function candidateSemanticsEqual(left: MemoryCandidateRecord, right: MemoryCandidateRecord): boolean {
  const optionalEqual = (a: unknown, b: unknown): boolean =>
    a === undefined || b === undefined ? a === b : stableJsonEqual(a, b);
  return left.kind === right.kind && left.status === right.status && left.proposalId === right.proposalId &&
    left.slot === right.slot && stableJsonEqual(left.value, right.value) &&
    stableJsonEqual(left.evidenceRefs, right.evidenceRefs) && left.sourceClass === right.sourceClass &&
    left.confidencePpm === right.confidencePpm && left.idempotencyKey === right.idempotencyKey &&
    left.current === false && left.memoryKind === right.memoryKind && left.userId === right.userId &&
    stableJsonEqual(left.purposeScopes, right.purposeScopes) && stableJsonEqual(left.sensitivity, right.sensitivity) &&
    stableJsonEqual(left.validity, right.validity) && optionalEqual(left.target, right.target) &&
    optionalEqual(left.correctionIntent, right.correctionIntent) &&
    optionalEqual(left.reason, right.reason) && optionalEqual(left.conflict, right.conflict) &&
    left.requiresReview === right.requiresReview && optionalEqual(left.conflictBinding, right.conflictBinding) &&
    optionalEqual(left.linkedMemoryRef, right.linkedMemoryRef) && optionalEqual(left.reviewedAt, right.reviewedAt);
}

function candidateBatchRequestHash(
  command: MemoryCandidateBatchCommitCommand,
  refs: readonly CanonicalObjectVersionRef[],
): Sha256 {
  return stableJsonHash({
    schema: "memory.candidate_batch.request.v2",
    batchId: command.batchId,
    idempotencyKey: command.idempotencyKey,
    candidates: command.candidates,
    candidateRefs: refs,
  });
}

function correctionRequestHash(
  command: MemoryCorrectionCommitCommand,
  candidateRef: CanonicalObjectVersionRef,
  memoryRef: CanonicalObjectVersionRef,
): Sha256 {
  return stableJsonHash({
    schema: "memory.correction.request.v2",
    idempotencyKey: command.idempotencyKey,
    expectedCurrentRef: command.expectedCurrentRef,
    replacement: command.replacement,
    ...(command.resolvedContent === undefined ? {} : { resolvedContent: command.resolvedContent }),
    identity: { candidateRef, memoryRef },
  });
}

function reviewRequestHash(
  command: MemoryReviewCommandIdentity & { readonly fingerprint: Sha256; readonly canonicalMemoryRef?: CanonicalObjectVersionRef },
): Sha256 {
  const { fingerprint: _fingerprint, ...semantic } = command;
  return stableJsonHash({ schema: "memory.review.request.v2", ...semantic });
}

function receiptFromStored(value: unknown): MemoryCommitReceipt | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== "memory_commit_receipt" ||
      (row.operation !== "candidate_batch" && row.operation !== "correction") ||
      (row.outcome !== "committed" && row.outcome !== "replayed") ||
      typeof row.idempotencyKey !== "string" || typeof row.fingerprint !== "string" ||
      !Array.isArray(row.canonicalRefs) || !Array.isArray(row.supersededRefs)) return undefined;
  try {
    const receipt = row as unknown as MemoryCommitReceipt;
    return cloneReceipt(receipt, row.outcome as "committed" | "replayed");
  } catch { return undefined; }
}

function reviewReplayFromStored(value: unknown): MemoryReviewReplayRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.requestFingerprint !== "string" || typeof row.commandIdentity !== "object" ||
      row.commandIdentity === null || typeof row.receipt !== "object" || row.receipt === null) return undefined;
  try {
    const receipt = cloneReviewReceipt(row.receipt as MemoryReviewReceipt, (row.receipt as MemoryReviewReceipt).outcome);
    return Object.freeze({
      requestFingerprint: row.requestFingerprint as Sha256,
      commandIdentity: stableJsonClone(row.commandIdentity) as MemoryReviewCommandIdentity,
      receipt,
    });
  } catch { return undefined; }
}

export class MemoryAuthorityRepository implements MemoryRepository, MemoryCandidateReader, MemoryReviewStateReader, MemoryReviewReceiptReader, MemoryCommandRepository, MemoryCanonicalVersionReader, MemoryCanonicalAppendWriter {
  readonly pool: Pool;
  readonly canonicalIdentity?: MemoryCanonicalIdentityProvider;
  readonly canonicalCodec?: MemoryCanonicalReceiptCodec;
  readonly environment: "production" | "non-production";

  constructor(pool: Pool, options: MemoryAuthorityRepositoryOptions = {}) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    this.pool = pool;
    if (options.canonicalIdentity !== undefined) this.canonicalIdentity = options.canonicalIdentity;
    if (options.canonicalCodec !== undefined) this.canonicalCodec = options.canonicalCodec;
    this.environment = options.environment ?? options.canonicalIdentity?.environment ?? "production";
    if (this.canonicalIdentity !== undefined) assertOwnerIdentityProvider(this.canonicalIdentity);
    if (this.canonicalIdentity !== undefined && this.canonicalIdentity.environment !== this.environment) {
      throw new MemoryPersistenceError("CANONICAL_IDENTITY_ENVIRONMENT_MISMATCH");
    }
  }

  /** Run arbitrary T02 work through the shared transaction seam. */
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work);
  }

  async withTransaction<T>(run: (transaction: MemoryCommandTransaction) => Promise<T>): Promise<T> {
    return run(this.transactionAdapter());
  }

  private transactionAdapter(): MemoryReviewTransaction {
    return {
      commitCandidateBatch: (command) => this.commitCandidateBatch(command),
      commitCorrection: (command) => this.commitCorrection(command),
      reviewCandidate: (command) => this.reviewCandidate(command),
    };
  }

  async loadCompilerSnapshot(query: CompilerQuery) {
    const snapshot = await withReadOnlyTransaction(this.pool, async (client) => {
      if (!(await appendOnlySchemaAvailable(client))) {
        const params: unknown[] = [query.userId, query.purposeScope, query.asOf];
        const predicates = [
          "user_id = $1", "current = TRUE", "status = 'current'", "stale = FALSE",
          "deleted_at IS NULL", "suppressed_at IS NULL", "($2 = ANY (SELECT jsonb_array_elements_text(allowed_purpose_scopes)))",
          "updated_at <= $3::timestamptz",
        ];
        if (query.slot !== undefined) { params.push(query.slot); predicates.push(`slot = $${params.length}`); }
        if (query.slots !== undefined) { params.push(query.slots); predicates.push(`slot = ANY($${params.length}::text[])`); }
        if (query.kind !== undefined) { params.push(query.kind); predicates.push(`kind = $${params.length}`); }
        if (query.kinds !== undefined) { params.push(query.kinds); predicates.push(`kind = ANY($${params.length}::text[])`); }
        const result = await client.query(`SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE ${predicates.join(" AND ")} ORDER BY updated_at DESC, memory_ref_id`, params);
        const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
        if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
        return { records: result.rows.map(asMemoryVersionRecord).slice(0, query.maxItems), watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
      }
      await assertCanonicalHeadIntegrity(client, query.userId);
      const canonicalParams: unknown[] = [query.userId, query.purposeScope, query.asOf];
      const canonicalPredicates = compilerPredicates("v", query, canonicalParams);
      const canonical = await client.query(
        `SELECT ${QUALIFIED_MEMORY_COLUMNS} FROM memory_versions v JOIN memory_slot_heads h ON h.user_id = v.user_id AND h.slot = v.slot AND h.memory_ref_type = v.memory_ref_type AND h.memory_ref_id = v.memory_ref_id AND h.memory_object_version = v.memory_object_version AND h.memory_payload_sha256 = v.memory_payload_sha256 WHERE ${canonicalPredicates.join(" AND ")} AND v.canonical_payload_jcs IS NOT NULL`,
        canonicalParams,
      );
      const legacyParams: unknown[] = [query.userId, query.purposeScope, query.asOf];
      const legacyPredicates = compilerPredicates("", query, legacyParams);
      const legacy = await client.query(
        `SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE ${legacyPredicates.join(" AND ")} AND canonical_payload_jcs IS NULL`,
        legacyParams,
      );
      const records = [...canonical.rows.map(asMemoryVersionRecord), ...legacy.rows.map(asMemoryVersionRecord)]
        .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) || left.ref.refId.localeCompare(right.ref.refId))
        .slice(0, query.maxItems);
      const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
      if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
      return { records, watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
    });
    const grouped = new Set<string>();
    for (const record of snapshot.records) {
      const key = `${record.userId}\u0000${record.slot}`;
      if (grouped.has(key)) throw commandError("CURRENT_VERSION_CONFLICT", false, snapshot.watermark);
      grouped.add(key);
    }
    return Object.freeze({ query, records: Object.freeze(snapshot.records), authorityWatermark: snapshot.watermark });
  }

  async findCurrentBySlot(slot: string, query: CompilerQuery): Promise<MemoryVersionRecord | undefined> {
    const state = await this.findAuthoritativeCurrentBySlot({ userId: query.userId, slot });
    if (state.conflict) throw commandError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
    const visible = state.currentRecords.filter((record) => record.status === "current" && record.deletedAt === undefined &&
      record.suppressedAt === undefined && record.allowedPurposeScopes.includes(query.purposeScope));
    if (visible.length > 1) throw commandError("CURRENT_VERSION_CONFLICT", false, state.authorityWatermark);
    return visible[0];
  }

  async loadCandidateSnapshot(query: MemoryCandidateQuery): Promise<MemoryCandidateSnapshot> {
    const snapshot = await withReadOnlyTransaction(this.pool, async (client) => {
      if (!(await appendOnlySchemaAvailable(client))) {
        const params: unknown[] = [query.userId, query.maxItems];
        const predicates = ["user_id = $1"];
        if (query.statuses !== undefined) { params.push(query.statuses); predicates.push(`status = ANY($${params.length}::text[])`); }
        if (query.slot !== undefined) { params.push(query.slot); predicates.push(`slot = $${params.length}`); }
        const result = await client.query(`SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates WHERE ${predicates.join(" AND ")} ORDER BY created_at, candidate_ref_id LIMIT $2`, params);
        const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
        if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
        return { records: result.rows.map(asCandidateRecord), watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
      }
      await assertCandidateHeadIntegrity(client, query.userId);
      const canonicalParams: unknown[] = [query.userId, query.maxItems];
      const canonicalPredicates = candidatePredicates("v", query, canonicalParams);
      const canonical = await client.query(
        `SELECT ${QUALIFIED_CANDIDATE_COLUMNS} FROM memory_candidates v JOIN memory_candidate_heads h ON h.candidate_ref_id = v.candidate_ref_id AND h.candidate_object_version = v.candidate_object_version AND h.candidate_payload_sha256 = v.candidate_payload_sha256 WHERE ${canonicalPredicates.join(" AND ")} AND v.canonical_payload_jcs IS NOT NULL ORDER BY v.created_at, v.candidate_ref_id LIMIT $2`,
        canonicalParams,
      );
      const legacyParams: unknown[] = [query.userId, query.maxItems];
      const legacyPredicates = candidatePredicates("", query, legacyParams);
      const legacy = await client.query(
        `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates WHERE ${legacyPredicates.join(" AND ")} AND canonical_payload_jcs IS NULL ORDER BY created_at, candidate_ref_id LIMIT $2`,
        legacyParams,
      );
      const records = [...canonical.rows.map(asCandidateRecord), ...legacy.rows.map(asCandidateRecord)].slice(0, query.maxItems);
      const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
      if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
      return { records, watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
    });
    return Object.freeze({ query, records: Object.freeze(snapshot.records), authorityWatermark: snapshot.watermark });
  }

  async findCandidateByRef(candidateRef: CanonicalObjectVersionRef): Promise<MemoryCandidateRecord | undefined> {
    const ref = assertCanonicalObjectVersionRef(candidateRef);
    if (ref.refType !== "MemoryCandidate") throw new MemoryPersistenceError("REF_TYPE_MISMATCH");
    const columns = refToColumns(ref);
    const result = await this.pool.query(
      `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates WHERE candidate_ref_id = $1 AND candidate_object_version = $2 AND candidate_payload_sha256 = $3 FOR UPDATE`,
      [columns.ref_id, columns.object_version, columns.canonical_payload_sha256],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw commandError("CANDIDATE_STATE_CONFLICT", false);
    return asCandidateRecord(result.rows[0]!);
  }

  async findAuthoritativeCurrentBySlot(query: MemoryReviewStateQuery): Promise<MemoryReviewStateSnapshot> {
    const snapshot = await withReadOnlyTransaction(this.pool, async (client) => {
      if (!(await appendOnlySchemaAvailable(client))) {
        const result = await client.query(
          `SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE user_id = $1 AND slot = $2 AND current = TRUE ORDER BY updated_at DESC, memory_ref_id`,
          [query.userId, query.slot],
        );
        const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
        if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
        return { records: result.rows.map(asMemoryVersionRecord), watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
      }
      await assertCanonicalHeadIntegrity(client, query.userId, query.slot);
      const head = await client.query(
        `SELECT ${QUALIFIED_MEMORY_COLUMNS} FROM memory_versions v JOIN memory_slot_heads h ON h.user_id = v.user_id AND h.slot = v.slot AND h.memory_ref_type = v.memory_ref_type AND h.memory_ref_id = v.memory_ref_id AND h.memory_object_version = v.memory_object_version AND h.memory_payload_sha256 = v.memory_payload_sha256 WHERE h.user_id = $1 AND h.slot = $2`,
        [query.userId, query.slot],
      );
      const canonicalCount = await client.query(
        "SELECT count(*)::text AS count FROM memory_versions WHERE user_id = $1 AND slot = $2 AND canonical_payload_jcs IS NOT NULL",
        [query.userId, query.slot],
      );
      const result = Number(canonicalCount.rows[0]?.count ?? "0") > 0
        ? head
        : await client.query(
          `SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE user_id = $1 AND slot = $2 AND current = TRUE ORDER BY updated_at DESC, memory_ref_id`,
          [query.userId, query.slot],
        );
      const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
      if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
      return { records: result.rows.map(asMemoryVersionRecord), watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
    });
    const currentRecords = Object.freeze(snapshot.records);
    return Object.freeze({
      query,
      currentRecords,
      conflict: currentRecords.length > 1,
      authorityWatermark: snapshot.watermark,
    });
  }

  async findReviewReceiptByIdempotencyKey(input: { readonly idempotencyKey: string }): Promise<MemoryReviewReplayRecord | undefined> {
    const result = await this.pool.query(
      "SELECT response FROM idempotency_ledger WHERE scope = 'memory.review' AND idempotency_key = $1 FOR UPDATE",
      [input.idempotencyKey],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
    return reviewReplayFromStored(result.rows[0]!.response);
  }

  /** Append a complete T05 receipt without deriving any canonical bytes. */
  async appendCanonical(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly receipt: ProductionMemoryIssuerReceipt;
    readonly expectedHeadRef?: CanonicalObjectVersionRef;
  }): Promise<OwnerPortResult<{
    readonly appendedRef: CanonicalObjectVersionRef;
    readonly headRef: CanonicalObjectVersionRef;
    readonly authorityWatermark: MemoryAppendOnlyAuthorityWatermark;
  }>> {
    try {
      const codec = this.requireCanonicalCodec();
      const validated = projectCanonicalReceipt(input.receipt, codec);
      const value = await withTransaction(this.pool, (client) => appendCanonicalOnClient(client, {
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        receipt: validated.receipt,
        codec,
        ...(input.expectedHeadRef === undefined ? {} : { expectedHeadRef: input.expectedHeadRef }),
      }));
      return { ok: true, value };
    } catch (error) {
      const normalized = normalizeCommandError(error);
      if (normalized !== undefined) return { ok: false, error: normalized };
      if (error instanceof MemoryPersistenceError && error.code === "CANONICAL_RECEIPT_DRIFT") {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
  }

  /**
   * Read one exact canonical version. Durable projection JSONB is rehydrated
   * through the T05 codec; T02 never reconstructs a receipt from a raw ref.
   */
  async readVersionByRef(input: { readonly ref: CanonicalObjectVersionRef }): Promise<OwnerPortResult<MemoryCanonicalVersionRead>> {
    try {
      const codec = this.requireCanonicalCodec();
      const ref = cloneCanonicalRef(input.ref);
      if (!MEMORY_REF_TYPES.has(ref.refType) && ref.refType !== "MemoryCandidate") {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      const columns = refToColumns(ref);
      const table = ref.refType === "MemoryCandidate" ? "memory_candidates" : "memory_versions";
      const prefix = ref.refType === "MemoryCandidate" ? "candidate" : "memory";
      const snapshot = await withReadOnlyTransaction(this.pool, async (client) => {
        const result = await client.query(
          `SELECT ${prefix}_ref, ${prefix}_ref_type, ${prefix}_ref_id, ${prefix}_object_version, ${prefix}_payload_sha256, canonical_payload_jcs, canonical_payload, canonical_receipt_projection, canonical_receipt_projection_jcs, canonical_receipt_projection_sha256 FROM ${table} WHERE ${prefix}_ref_id = $1 AND ${prefix}_object_version = $2 AND ${prefix}_payload_sha256 = $3 AND canonical_payload_jcs IS NOT NULL`,
          [columns.ref_id, columns.object_version, columns.canonical_payload_sha256],
        );
        const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
        if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
        return { result, watermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
      });
      if (snapshot.result.rows.length !== 1) {
        return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
      }
      const row = snapshot.result.rows[0]!;
      const storedRef = assertRefColumnEquality(row[`${prefix}_ref`], {
        ref_type: row[`${prefix}_ref_type`],
        ref_id: row[`${prefix}_ref_id`],
        object_version: row[`${prefix}_object_version`],
        canonical_payload_sha256: String(row[`${prefix}_payload_sha256`]).trim(),
      }, ref.refType);
      if (canonicalRefKey(storedRef) !== canonicalRefKey(ref) || typeof row.canonical_payload_jcs !== "string" ||
          row.canonical_payload === null || row.canonical_payload === undefined ||
          row.canonical_receipt_projection === null || row.canonical_receipt_projection === undefined ||
          typeof row.canonical_receipt_projection_jcs !== "string" || row.canonical_receipt_projection_sha256 === null ||
          row.canonical_receipt_projection_sha256 === undefined) {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      const receipt = rehydrateCanonicalReceipt(row.canonical_receipt_projection, codec);
      const payload = receipt.payload as CanonicalMemoryPayload;
      const projection = codec.projectReceipt(receipt);
      if (row.canonical_payload_jcs !== receipt.canonicalPayloadJcs ||
          String(row[`${prefix}_payload_sha256`]).trim() !== receipt.canonicalPayloadSha256 ||
          !stableJsonEqual(row.canonical_payload, receipt.payload) ||
          canonicalRefKey(receipt.memoryRef ?? receipt.candidateRef) !== canonicalRefKey(ref) ||
          projection.projectionJcs !== row.canonical_receipt_projection_jcs ||
          projection.projectionSha256 !== String(row.canonical_receipt_projection_sha256).trim()) {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      return {
        ok: true,
        value: Object.freeze({ receipt, payload, authorityWatermark: appendOnlyWatermark(snapshot.watermark) }),
      };
    } catch (error) {
      const normalized = normalizeCommandError(error);
      if (normalized !== undefined) return { ok: false, error: normalized };
      if (error instanceof MemoryPersistenceError && (error.code === "REF_COLUMN_DRIFT" || error.code === "CANONICAL_RECEIPT_DRIFT")) {
        return { ok: false, error: { code: "OWNER_STATE_INVALID", retryable: false } };
      }
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
  }

  /** Rebuild only the non-authoritative head projections from immutable rows. */
  async rebuildAppendOnlyHeads(): Promise<void> {
    this.requireCanonicalCodec();
    await withTransaction(this.pool, async (client) => {
      const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE FOR UPDATE");
      if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
      const watermark = watermarkFromEpoch(clock.rows[0]!.watermark);
      await client.query("DELETE FROM memory_candidate_heads");
      await client.query([
        "INSERT INTO memory_candidate_heads (candidate_ref_id, candidate_object_version, candidate_payload_sha256, authority_watermark)",
        "SELECT DISTINCT ON (candidate_ref_id) candidate_ref_id, candidate_object_version, candidate_payload_sha256, $1::jsonb",
        "FROM memory_candidates WHERE canonical_payload_jcs IS NOT NULL",
        "ORDER BY candidate_ref_id, length(candidate_object_version) DESC, candidate_object_version DESC",
      ].join(" "), [stableJsonText(watermark)]);
      await client.query("DELETE FROM memory_slot_heads");
      await client.query([
        "INSERT INTO memory_slot_heads (user_id, slot, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, authority_watermark)",
        "SELECT DISTINCT ON (user_id, slot) user_id, slot, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, $1::jsonb",
        "FROM memory_versions WHERE canonical_payload_jcs IS NOT NULL",
        "ORDER BY user_id, slot, length(memory_object_version) DESC, memory_object_version DESC",
      ].join(" "), [stableJsonText(watermark)]);
    });
  }

  private async readWatermark(): Promise<MemoryAuthorityWatermark> {
    const result = await this.pool.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
    if (result.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
    return watermarkFromEpoch(result.rows[0]!.watermark);
  }

  private async nextWatermark(client: PoolClient): Promise<MemoryAuthorityWatermark> {
    const result = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE FOR UPDATE");
    if (result.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
    const next = incrementDecimal(String(result.rows[0]!.watermark));
    await client.query("UPDATE memory_authority_clock SET watermark = $1, updated_at = now() WHERE clock_id = TRUE", [next]);
    return watermarkFromEpoch(next);
  }

  private requireProvider(): MemoryCanonicalIdentityProvider {
    if (this.canonicalIdentity === undefined) throw commandError("OWNER_STATE_UNAVAILABLE", true);
    return this.canonicalIdentity;
  }

  private requireCanonicalCodec(): MemoryCanonicalReceiptCodec {
    const codec = this.canonicalCodec;
    if (codec === undefined) throw commandError("OWNER_STATE_UNAVAILABLE", true);
    if (!hasCanonicalCodecShape(codec)) throw commandError("OWNER_STATE_INVALID", false);
    return codec;
  }

  private async resolveCandidateRef(
    command: MemoryCandidateBatchCommitCommand,
    index: number,
    candidate: AdmittedMemoryCandidateIntent,
  ): Promise<CanonicalObjectVersionRef> {
    const supplied = command.candidateIdentities?.[index]?.candidateRef;
    const candidateRef = supplied ?? await this.requireProvider().candidateRefFor({
      batchId: command.batchId,
      idempotencyKey: command.idempotencyKey,
      candidateIndex: index,
      candidate,
    });
    const ref = cloneCanonicalRef(candidateRef);
    if (ref.refType !== "MemoryCandidate") throw commandError("OWNER_STATE_INVALID", false);
    return ref;
  }

  private async resolveCorrectionIdentity(
    command: MemoryCorrectionCommitCommand,
    candidateRef: CanonicalObjectVersionRef,
    candidateRecord: MemoryCandidateRecord,
  ): Promise<CanonicalObjectVersionRef> {
    const supplied = command.identity?.memoryRef;
    const ref = cloneCanonicalRef(supplied ?? await this.requireProvider().memoryRefFor({
      candidateRef,
      memoryKind: candidateRecord.memoryKind,
      operation: "correction",
      expectedCurrentRef: command.expectedCurrentRef,
      candidate: candidateRecord,
    }));
    if (!memoryKindRefMatches(candidateRecord.memoryKind, ref)) throw commandError("OWNER_STATE_INVALID", false);
    return ref;
  }

  private async resolveReviewMemoryRef(
    command: MemoryReviewCommandIdentity & { readonly canonicalMemoryRef?: CanonicalObjectVersionRef },
    candidate: MemoryCandidateRecord,
    operation: "accept_new" | "accept_superseding",
    expectedCurrentRef?: CanonicalObjectVersionRef,
  ): Promise<CanonicalObjectVersionRef> {
    const ref = cloneCanonicalRef(command.canonicalMemoryRef ?? await this.requireProvider().memoryRefFor({
      candidateRef: candidate.candidateRef,
      memoryKind: candidate.memoryKind,
      operation,
      ...(expectedCurrentRef === undefined ? {} : { expectedCurrentRef }),
      candidate,
    }));
    if (!memoryKindRefMatches(candidate.memoryKind, ref)) throw commandError("OWNER_STATE_INVALID", false);
    if (expectedCurrentRef !== undefined && canonicalRefKey(ref) === canonicalRefKey(expectedCurrentRef)) {
      throw commandError("CURRENT_VERSION_CONFLICT", false);
    }
    return ref;
  }

  private async claim(client: PoolClient, scope: string, key: string, requestHash: Sha256): Promise<IdempotencyRecord | MemoryCommitReceipt | MemoryReviewReplayRecord> {
    const claim = await claimIdempotency(client, { scope, idempotencyKey: key, requestHash });
    if (claim.kind === "replay" || claim.kind === "terminal") {
      if (scope === "memory.review") {
        const replay = reviewReplayFromStored(claim.record.response);
        if (replay === undefined) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
        return replay;
      }
      const receipt = receiptFromStored(claim.record.response);
      if (receipt === undefined) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
      return receipt;
    }
    if (claim.kind === "in_flight") throw commandError("OWNER_STATE_UNAVAILABLE", true);
    return claim.record;
  }

  private async complete(
    client: PoolClient,
    scope: string,
    key: string,
    requestHash: Sha256,
    response: unknown,
  ): Promise<void> {
    await completeIdempotency(
      client,
      { scope, idempotencyKey: key, requestHash },
      response,
      stableJsonHash(response),
    );
  }

  private async enqueue(
    client: PoolClient,
    input: { readonly idempotencyKey: string; readonly aggregateRef: CanonicalObjectVersionRef; readonly eventType: string; readonly payload: unknown },
  ): Promise<void> {
    const event: OutboxEventInput = {
      eventId: deterministicUuid("memory.outbox", input.idempotencyKey, input.eventType),
      aggregateType: "memory",
      aggregateId: refToColumns(input.aggregateRef).ref_id,
      eventType: input.eventType,
      eventVersion: 1,
      idempotencyScope: "memory.outbox",
      idempotencyKey: input.idempotencyKey,
      payload: stableJsonClone(input.payload),
      payloadHash: stableJsonHash(input.payload),
    };
    await enqueueOutboxEvent(client, event);
  }

  private async insertCandidate(
    client: PoolClient,
    candidateRef: CanonicalObjectVersionRef,
    candidate: AdmittedMemoryCandidateIntent,
    overrides: {
      readonly status?: MemoryCandidateRecord["status"];
      readonly requiresReview?: boolean;
      readonly linkedMemoryRef?: CanonicalObjectVersionRef;
      readonly conflictBinding?: unknown;
    } = {},
  ): Promise<MemoryCandidateRecord> {
    const candidateColumns = refToColumns(candidateRef);
    const target = candidate.target === undefined ? undefined : refToColumns(candidate.target);
    const linked = overrides.linkedMemoryRef === undefined ? undefined : refToColumns(overrides.linkedMemoryRef);
    const values: unknown[] = [
      stableJsonText(candidateRef), candidateRef.refType, candidateColumns.ref_id, candidateColumns.object_version, candidateColumns.canonical_payload_sha256,
      candidate.kind, overrides.status ?? "candidate", candidate.proposalId, candidate.slot, stableJsonText(candidate.value), stableJsonText(candidate.evidenceRefs),
      candidate.sourceClass, candidate.confidencePpm, candidate.idempotencyKey, false, candidate.memoryKind, candidate.userId, stableJsonText(candidate.purposeScopes),
      stableJsonText(candidate.sensitivity), stableJsonText(candidate.validity),
      target === undefined ? null : stableJsonText(candidate.target), target?.ref_type ?? null, target?.ref_id ?? null, target?.object_version ?? null, target?.canonical_payload_sha256 ?? null,
      candidate.correctionIntent === undefined ? null : stableJsonText(candidate.correctionIntent), candidate.reason === undefined ? null : stableJsonText(candidate.reason), candidate.conflict === undefined ? null : stableJsonText(candidate.conflict),
      overrides.requiresReview ?? true, overrides.conflictBinding === undefined ? null : stableJsonText(overrides.conflictBinding),
      linked === undefined ? null : stableJsonText(overrides.linkedMemoryRef), linked?.ref_type ?? null, linked?.ref_id ?? null, linked?.object_version ?? null, linked?.canonical_payload_sha256 ?? null,
    ];
    const insert = await client.query(
      [
        "INSERT INTO memory_candidates (candidate_ref, candidate_ref_type, candidate_ref_id, candidate_object_version, candidate_payload_sha256, kind, status, proposal_id, slot, value, evidence_refs, source_class, confidence_ppm, idempotency_key, current, memory_kind, user_id, purpose_scopes, sensitivity, validity, target_ref, target_ref_type, target_ref_id, target_object_version, target_payload_sha256, correction_intent, reason, conflict, requires_review, conflict_binding, linked_memory_ref, linked_memory_ref_type, linked_memory_ref_id, linked_memory_object_version, linked_memory_payload_sha256)",
        "VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24, $25, $26::jsonb, $27::jsonb, $28::jsonb, $29, $30::jsonb, $31::jsonb, $32, $33, $34, $35)",
        "ON CONFLICT (candidate_ref_id, candidate_object_version, candidate_payload_sha256) DO NOTHING",
        "RETURNING " + CANDIDATE_COLUMNS,
      ].join(" "),
      values,
    );
    const row = insert.rows[0] ?? (await client.query(
      `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates WHERE candidate_ref_id = $1 AND candidate_object_version = $2 AND candidate_payload_sha256 = $3 FOR UPDATE`,
      [candidateColumns.ref_id, candidateColumns.object_version, candidateColumns.canonical_payload_sha256],
    )).rows[0];
    if (row === undefined) throw new MemoryPersistenceError("CANDIDATE_NOT_FOUND");
    const stored = asCandidateRecord(row);
    const expectedOverrides: {
      status: MemoryCandidateRecord["status"];
      requiresReview: MemoryCandidateRecord["requiresReview"];
      linkedMemoryRef?: NonNullable<MemoryCandidateRecord["linkedMemoryRef"]>;
      conflictBinding?: NonNullable<MemoryCandidateRecord["conflictBinding"]>;
    } = {
      status: overrides.status ?? "candidate",
      requiresReview: overrides.requiresReview ?? true,
    };
    if (overrides.linkedMemoryRef !== undefined) expectedOverrides.linkedMemoryRef = overrides.linkedMemoryRef;
    if (overrides.conflictBinding !== undefined) {
      expectedOverrides.conflictBinding = overrides.conflictBinding as NonNullable<MemoryCandidateRecord["conflictBinding"]>;
    }
    const expected = candidateRecordFromIntent(candidateRef, candidate, expectedOverrides);
    if (!candidateSemanticsEqual(stored, expected) || stored.current !== false) {
      throw commandError("IDEMPOTENCY_CONFLICT", false);
    }
    return stored;
  }

  private async selectCurrent(client: PoolClient, userId: string, slot: string): Promise<readonly MemoryVersionRecord[]> {
    if (!(await appendOnlySchemaAvailable(client))) {
      const result = await client.query(
        `SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE user_id = $1 AND slot = $2 AND current = TRUE FOR UPDATE`,
        [userId, slot],
      );
      return Object.freeze(result.rows.map(asMemoryVersionRecord));
    }
    await assertCanonicalHeadIntegrity(client, userId, slot);
    const head = await client.query(
      `SELECT ${QUALIFIED_MEMORY_COLUMNS} FROM memory_versions v JOIN memory_slot_heads h ON h.user_id = v.user_id AND h.slot = v.slot AND h.memory_ref_type = v.memory_ref_type AND h.memory_ref_id = v.memory_ref_id AND h.memory_object_version = v.memory_object_version AND h.memory_payload_sha256 = v.memory_payload_sha256 WHERE h.user_id = $1 AND h.slot = $2 FOR UPDATE`,
      [userId, slot],
    );
    const canonicalCount = await client.query(
      "SELECT count(*)::text AS count FROM memory_versions WHERE user_id = $1 AND slot = $2 AND canonical_payload_jcs IS NOT NULL",
      [userId, slot],
    );
    const result = Number(canonicalCount.rows[0]?.count ?? "0") > 0
      ? head
      : await client.query(
        `SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE user_id = $1 AND slot = $2 AND current = TRUE FOR UPDATE`,
        [userId, slot],
      );
    return Object.freeze(result.rows.map(asMemoryVersionRecord));
  }

  private async insertMemory(
    client: PoolClient,
    input: {
      readonly ref: CanonicalObjectVersionRef;
      readonly candidate: MemoryCandidateRecord;
      readonly status: "current";
      readonly current: true;
      readonly resolvedContent?: string;
      readonly supersedes?: CanonicalObjectVersionRef;
    },
  ): Promise<MemoryVersionRecord> {
    const ref = refToColumns(input.ref);
    const supersedes = input.supersedes === undefined ? undefined : refToColumns(input.supersedes);
    const values: unknown[] = [
      stableJsonText(input.ref), ref.ref_type, ref.ref_id, ref.object_version, ref.canonical_payload_sha256,
      input.candidate.userId, input.candidate.memoryKind, input.candidate.slot, stableJsonText(input.candidate.value), input.resolvedContent ?? "",
      input.status, input.current, input.candidate.sourceClass, stableJsonText(input.candidate.evidenceRefs), input.candidate.confidencePpm,
      stableJsonText(input.candidate.purposeScopes), stableJsonText(input.candidate.sensitivity), stableJsonText(input.candidate.validity),
      input.supersedes === undefined ? null : stableJsonText(input.supersedes), supersedes?.ref_type ?? null, supersedes?.ref_id ?? null, supersedes?.object_version ?? null, supersedes?.canonical_payload_sha256 ?? null,
      input.candidate.correctionIntent === undefined ? null : stableJsonText(input.candidate.correctionIntent), null, null, null, false, null,
    ];
    const result = await client.query(
      [
        "INSERT INTO memory_versions (memory_ref, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, user_id, kind, slot, value, resolved_content, status, current, source_class, evidence_refs, confidence_ppm, allowed_purpose_scopes, sensitivity, validity, supersedes_ref, supersedes_ref_type, supersedes_ref_id, supersedes_object_version, supersedes_payload_sha256, correction_intent, dream_accepted_delta, deleted_at, suppressed_at, stale, derived_rank_score)",
        "VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26::timestamptz, $27::timestamptz, $28, $29)",
        "ON CONFLICT (memory_ref_id, memory_object_version, memory_payload_sha256) DO NOTHING RETURNING " + MEMORY_COLUMNS,
      ].join(" "),
      values,
    );
    const row = result.rows[0] ?? (await client.query(
      `SELECT ${MEMORY_COLUMNS} FROM memory_versions WHERE memory_ref_id = $1 AND memory_object_version = $2 AND memory_payload_sha256 = $3 FOR UPDATE`,
      [ref.ref_id, ref.object_version, ref.canonical_payload_sha256],
    )).rows[0];
    if (row === undefined) throw new MemoryPersistenceError("MEMORY_NOT_FOUND");
    const stored = asMemoryVersionRecord(row);
    if (canonicalRefKey(stored.ref) !== canonicalRefKey(input.ref) || stored.current !== true || stored.status !== "current") {
      throw commandError("IDEMPOTENCY_CONFLICT", false);
    }
    return stored;
  }

  private async updateCandidate(
    client: PoolClient,
    candidateRef: CanonicalObjectVersionRef,
    values: { readonly status: string; readonly requiresReview: boolean; readonly linkedMemoryRef?: CanonicalObjectVersionRef; readonly conflictBinding?: unknown },
  ): Promise<void> {
    const ref = refToColumns(candidateRef);
    const linked = values.linkedMemoryRef === undefined ? undefined : refToColumns(values.linkedMemoryRef);
    const result = await client.query(
      [
        "UPDATE memory_candidates SET status = $4, requires_review = $5, linked_memory_ref = $6::jsonb, linked_memory_ref_type = $7, linked_memory_ref_id = $8, linked_memory_object_version = $9, linked_memory_payload_sha256 = $10, conflict_binding = $11::jsonb, reviewed_at = now(), updated_at = now()",
        "WHERE candidate_ref_id = $1 AND candidate_object_version = $2 AND candidate_payload_sha256 = $3 AND current = FALSE",
      ].join(" "),
      [ref.ref_id, ref.object_version, ref.canonical_payload_sha256, values.status, values.requiresReview,
        linked === undefined ? null : stableJsonText(values.linkedMemoryRef), linked?.ref_type ?? null, linked?.ref_id ?? null, linked?.object_version ?? null, linked?.canonical_payload_sha256 ?? null,
        values.conflictBinding === undefined ? null : stableJsonText(values.conflictBinding)],
    );
    if (result.rowCount !== 1) throw commandError("CANDIDATE_STATE_CONFLICT", false);
  }

  private async supersedeCurrent(client: PoolClient, expected: CanonicalObjectVersionRef, userId: string, slot: string): Promise<void> {
    const ref = refToColumns(expected);
    const result = await client.query(
      [
        "UPDATE memory_versions SET status = 'superseded', current = FALSE, updated_at = now()",
        "WHERE memory_ref_id = $1 AND memory_object_version = $2 AND memory_payload_sha256 = $3 AND user_id = $4 AND slot = $5 AND current = TRUE AND status = 'current'",
      ].join(" "),
      [ref.ref_id, ref.object_version, ref.canonical_payload_sha256, userId, slot],
    );
    if (result.rowCount !== 1) throw commandError("CURRENT_VERSION_CONFLICT", false);
  }

  async commitCandidateBatch(command: MemoryCandidateBatchCommitCommand): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    try {
      if (command.candidates.length === 0 || command.candidates.length !== (command.candidateIdentities?.length ?? command.candidates.length)) {
        throw commandError("INVALID_COMMAND", false);
      }
      if (command.candidateIdentities === undefined && this.canonicalIdentity === undefined) {
        throw commandError("OWNER_STATE_UNAVAILABLE", true);
      }
      const refs: CanonicalObjectVersionRef[] = [];
      for (let index = 0; index < command.candidates.length; index += 1) {
        refs.push(await this.resolveCandidateRef(command, index, command.candidates[index]!));
      }
      const requestHash = candidateBatchRequestHash(command, refs);
      const effectiveCommand: MemoryCandidateBatchCommitCommand = Object.freeze({
        ...command,
        candidateIdentities: Object.freeze(refs.map((candidateRef) => ({ candidateRef: cloneCanonicalRef(candidateRef) }))),
      });
      return await withTransaction(this.pool, async (client) => {
        const claimed = await this.claim(client, "memory.candidate_batch", command.idempotencyKey, requestHash);
        if (!(claimed instanceof Object) || !("scope" in claimed)) {
          const replay = claimed as MemoryCommitReceipt;
          return { ok: true, receipt: cloneReceipt(replay, "replayed") };
        }
        for (let index = 0; index < effectiveCommand.candidates.length; index += 1) {
          const candidate = effectiveCommand.candidates[index]!;
          const candidateRef = refs[index]!;
          await this.insertCandidate(client, candidateRef, candidate);
        }
        const watermark = await this.nextWatermark(client);
        const receipt: MemoryCommitReceipt = Object.freeze({
          kind: "memory_commit_receipt",
          operation: "candidate_batch",
          outcome: "committed",
          idempotencyKey: command.idempotencyKey,
          fingerprint: command.fingerprint,
          canonicalRefs: freezeRefs(refs),
          supersededRefs: Object.freeze([]),
          authorityWatermark: watermark,
        });
        await this.complete(client, "memory.candidate_batch", command.idempotencyKey, requestHash, receipt);
        await this.enqueue(client, { idempotencyKey: command.idempotencyKey, aggregateRef: refs[0]!, eventType: "memory.candidate.created", payload: { refs, watermark } });
        return { ok: true, receipt };
      });
    } catch (error) {
      const normalized = normalizeCommandError(error);
      if (normalized !== undefined) return { ok: false, error: normalized };
      throw error;
    }
  }

  async commitCorrection(command: MemoryCorrectionCommitCommand): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    try {
      if (command.identity === undefined && this.canonicalIdentity === undefined) {
        throw commandError("OWNER_STATE_UNAVAILABLE", true);
      }
      const candidateRef = command.identity?.candidateRef ?? await this.requireProvider().candidateRefFor({
        batchId: "correction",
        idempotencyKey: command.idempotencyKey,
        candidateIndex: 0,
        candidate: command.replacement,
      });
      const projectedCandidate = candidateRecordFromIntent(candidateRef, command.replacement);
      const memoryRef = cloneCanonicalRef(command.identity?.memoryRef ?? await this.requireProvider().memoryRefFor({
        candidateRef,
        memoryKind: projectedCandidate.memoryKind,
        operation: "correction",
        expectedCurrentRef: command.expectedCurrentRef,
        candidate: projectedCandidate,
      }));
      if (!memoryKindRefMatches(projectedCandidate.memoryKind, memoryRef)) throw commandError("OWNER_STATE_INVALID", false);
      const requestHash = correctionRequestHash(command, candidateRef, memoryRef);
      const effectiveCommand: MemoryCorrectionCommitCommand = Object.freeze({
        ...command,
        identity: Object.freeze({ candidateRef: cloneCanonicalRef(candidateRef), memoryRef: cloneCanonicalRef(memoryRef) }),
      });
      return await withTransaction(this.pool, async (client) => {
        const claimed = await this.claim(client, "memory.correction", command.idempotencyKey, requestHash);
        if (!("scope" in (claimed as object))) return { ok: true, receipt: cloneReceipt(claimed as MemoryCommitReceipt, "replayed") };
        const expected = cloneCanonicalRef(effectiveCommand.expectedCurrentRef);
        const currentRows = await this.selectCurrent(client, effectiveCommand.replacement.userId, effectiveCommand.replacement.slot);
        if (currentRows.length !== 1 || canonicalRefKey(currentRows[0]!.ref) !== canonicalRefKey(expected)) {
          throw commandError("CURRENT_VERSION_CONFLICT", false, await this.currentWatermark(client));
        }
        const candidate = await this.insertCandidate(client, candidateRef, effectiveCommand.replacement);
        await this.supersedeCurrent(client, expected, candidate.userId, candidate.slot);
        const replacement = await this.insertMemory(client, {
          ref: memoryRef,
          candidate,
          status: "current",
          current: true,
          ...(effectiveCommand.resolvedContent === undefined ? {} : { resolvedContent: effectiveCommand.resolvedContent }),
          supersedes: expected,
        });
        await this.updateCandidate(client, candidateRef, { status: "accepted", requiresReview: false, linkedMemoryRef: memoryRef });
        const watermark = await this.nextWatermark(client);
        const receipt: MemoryCommitReceipt = Object.freeze({
          kind: "memory_commit_receipt",
          operation: "correction",
          outcome: "committed",
          idempotencyKey: command.idempotencyKey,
          fingerprint: command.fingerprint,
          canonicalRefs: Object.freeze([cloneCanonicalRef(replacement.ref)]),
          supersededRefs: Object.freeze([expected]),
          authorityWatermark: watermark,
        });
        await this.complete(client, "memory.correction", command.idempotencyKey, requestHash, receipt);
        await this.enqueue(client, { idempotencyKey: command.idempotencyKey, aggregateRef: replacement.ref, eventType: "memory.correction.committed", payload: { candidateRef, memoryRef, supersededRef: expected, watermark } });
        return { ok: true, receipt };
      });
    } catch (error) {
      const normalized = normalizeCommandError(error);
      if (normalized !== undefined) return { ok: false, error: normalized };
      throw error;
    }
  }

  async reviewCandidate(command: MemoryReviewCommandIdentity & { readonly fingerprint: Sha256; readonly canonicalMemoryRef?: CanonicalObjectVersionRef }): Promise<MemoryCommandResult<MemoryReviewReceipt>> {
    try {
      if ((command.resolution === "accept_new" || command.resolution === "accept_superseding") &&
          command.canonicalMemoryRef === undefined && this.canonicalIdentity === undefined) {
        throw commandError("OWNER_STATE_UNAVAILABLE", true);
      }
      return await withTransaction(this.pool, async (client) => {
        const candidateRef = refToColumns(command.candidateRef);
        const result = await client.query(
          `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates WHERE candidate_ref_id = $1 AND candidate_object_version = $2 AND candidate_payload_sha256 = $3 FOR UPDATE`,
          [candidateRef.ref_id, candidateRef.object_version, candidateRef.canonical_payload_sha256],
        );
        if (result.rows.length !== 1) throw commandError("CANDIDATE_NOT_FOUND", false);
        const candidate = asCandidateRecord(result.rows[0]!);
        if (candidate.status !== command.expectedCandidateStatus || candidate.userId !== command.expectedUserId || candidate.slot !== command.expectedSlot) {
          throw commandError("CANDIDATE_STATE_CONFLICT", false);
        }
        assertAuthorityWatermark(command.authorization.authorityWatermark);
        const current = command.resolution === "reject" || command.resolution === "quarantine"
          ? Object.freeze([])
          : await this.selectCurrent(client, candidate.userId, candidate.slot);
        if (current.length > 1) throw commandError("CURRENT_VERSION_CONFLICT", false, await this.currentWatermark(client));
        const currentRef = current[0]?.ref;
        const expectedCurrent = command.expectedCurrentRef;
        if (command.resolution !== "accept_new" && command.resolution !== "reject" && command.resolution !== "quarantine" &&
             (currentRef === undefined || expectedCurrent === undefined || canonicalRefKey(currentRef) !== canonicalRefKey(expectedCurrent))) {
          throw commandError("CURRENT_VERSION_CONFLICT", false);
        }
        let effectiveCommand: MemoryReviewCommandIdentity & { readonly fingerprint: Sha256; readonly canonicalMemoryRef?: CanonicalObjectVersionRef } = command;
        if (command.resolution === "accept_new" || command.resolution === "accept_superseding") {
          const memoryRef = await this.resolveReviewMemoryRef(command, candidate, command.resolution, currentRef);
          effectiveCommand = Object.freeze({ ...command, canonicalMemoryRef: memoryRef });
        }
        const requestHash = reviewRequestHash(effectiveCommand);
        const claimed = await this.claim(client, "memory.review", command.idempotencyKey, requestHash);
        if (!("scope" in (claimed as object))) return { ok: true, receipt: cloneReviewReceipt((claimed as MemoryReviewReplayRecord).receipt, "replayed") };
        let createdMemoryRefs: readonly CanonicalObjectVersionRef[] = [];
        let linkedMemoryRefs: readonly CanonicalObjectVersionRef[] = [];
        let currentMemoryRefs: readonly CanonicalObjectVersionRef[] = [];
        let supersededRefs: readonly CanonicalObjectVersionRef[] = [];
        let candidateStatus: MemoryReviewReceipt["candidateStatus"] = "candidate";
        if (command.resolution === "reject" || command.resolution === "quarantine") {
          candidateStatus = command.resolution === "reject" ? "rejected" : "quarantined";
          await this.updateCandidate(client, candidate.candidateRef, { status: candidateStatus, requiresReview: command.resolution === "quarantine" });
        } else if (command.resolution === "accept_existing") {
          if (currentRef === undefined) throw commandError("CURRENT_VERSION_CONFLICT", false);
          candidateStatus = "accepted";
          linkedMemoryRefs = Object.freeze([cloneCanonicalRef(currentRef)]);
          currentMemoryRefs = linkedMemoryRefs;
          await this.updateCandidate(client, candidate.candidateRef, { status: "accepted", requiresReview: false, linkedMemoryRef: currentRef });
        } else if (command.resolution === "requires_review") {
          await this.updateCandidate(client, candidate.candidateRef, { status: "candidate", requiresReview: true, conflictBinding: command.conflictBinding });
          currentMemoryRefs = freezeRefs(current.map((record) => record.ref));
        } else {
          const operation = command.resolution === "accept_new" ? "accept_new" : "accept_superseding";
           if (operation === "accept_new" && current.length !== 0) throw commandError("CURRENT_VERSION_CONFLICT", false);
           if (operation === "accept_superseding" && currentRef === undefined) throw commandError("CURRENT_VERSION_CONFLICT", false);
           const memoryRef = effectiveCommand.canonicalMemoryRef ?? await this.resolveReviewMemoryRef(effectiveCommand, candidate, operation, currentRef);
           if (currentRef !== undefined) {
             await this.supersedeCurrent(client, currentRef, candidate.userId, candidate.slot);
             supersededRefs = Object.freeze([cloneCanonicalRef(currentRef)]);
           }
           const memory = await this.insertMemory(client, {
            ref: memoryRef,
            candidate,
            status: "current",
            current: true,
             ...(effectiveCommand.resolvedContent === undefined ? {} : { resolvedContent: effectiveCommand.resolvedContent }),
            ...(currentRef === undefined ? {} : { supersedes: currentRef }),
          });
          await this.updateCandidate(client, candidate.candidateRef, { status: "accepted", requiresReview: false, linkedMemoryRef: memory.ref });
          candidateStatus = "accepted";
          createdMemoryRefs = Object.freeze([cloneCanonicalRef(memory.ref)]);
          currentMemoryRefs = createdMemoryRefs;
        }
        const watermark = await this.nextWatermark(client);
        const receipt: MemoryReviewReceipt = Object.freeze({
          kind: "memory_review_receipt",
          outcome: "committed",
          idempotencyKey: command.idempotencyKey,
          fingerprint: command.fingerprint,
          candidateRef: cloneCanonicalRef(candidate.candidateRef),
          candidateStatus,
          decision: command.decision,
          resolution: command.resolution,
          createdMemoryRefs,
          linkedMemoryRefs,
          currentMemoryRefs,
          supersededRefs,
          ...(command.conflictBinding === undefined ? {} : { conflictBinding: stableJsonClone(command.conflictBinding) }),
          authorityWatermark: watermark,
        });
        const { fingerprint: _fingerprint, ...identityWithoutTransport } = effectiveCommand;
        const replay: MemoryReviewReplayRecord = Object.freeze({
          requestFingerprint: command.requestFingerprint,
          commandIdentity: stableJsonClone(identityWithoutTransport) as MemoryReviewCommandIdentity,
          receipt,
        });
        await this.complete(client, "memory.review", command.idempotencyKey, requestHash, replay);
         await this.enqueue(client, { idempotencyKey: command.idempotencyKey, aggregateRef: candidate.candidateRef, eventType: "memory.review.committed", payload: { candidateRef: candidate.candidateRef, resolution: command.resolution, watermark } });
         return { ok: true, receipt };
       });
     } catch (error) {
       const normalized = normalizeCommandError(error);
      if (normalized !== undefined) return { ok: false, error: normalized };
      throw error;
    }
  }

  private async currentWatermark(client: PoolClient): Promise<MemoryAuthorityWatermark> {
    const result = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE FOR UPDATE");
    if (result.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
    return watermarkFromEpoch(result.rows[0]!.watermark);
  }
}

interface CanonicalAppendInput {
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
  readonly receipt: ProductionMemoryIssuerReceipt;
  readonly codec: MemoryCanonicalReceiptCodec;
  readonly expectedHeadRef?: CanonicalObjectVersionRef;
}

interface CanonicalAppendResult {
  readonly kind: "memory_canonical_append_receipt";
  readonly appendedRef: CanonicalObjectVersionRef;
  readonly headRef: CanonicalObjectVersionRef;
  readonly authorityWatermark: MemoryAppendOnlyAuthorityWatermark;
}

interface PendingCanonicalHead {
  readonly kind: "candidate" | "memory";
  readonly ref: CanonicalObjectVersionRef;
  readonly userId?: string;
  readonly slot?: string;
}

/** Shared transaction primitive used by the deletion successor path. */
export async function appendCanonicalOnClient(
  client: PoolClient,
  input: CanonicalAppendInput,
): Promise<CanonicalAppendResult> {
  const validated = projectCanonicalReceipt(input.receipt, input.codec);
  const receipt = validated.receipt;
  const claim = await claimIdempotency(client, {
    scope: "memory.canonical_append",
    idempotencyKey: input.idempotencyKey,
    requestHash: input.fingerprint,
  });
  if (claim.kind === "replay" || claim.kind === "terminal") {
    const replay = canonicalAppendResultFromStored(claim.record.response);
    if (replay === undefined) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
    return replay;
  }
  if (claim.kind === "in_flight") throw commandError("OWNER_STATE_UNAVAILABLE", true);

  const pendingHeads: PendingCanonicalHead[] = [];
  if (receipt.operation === "candidate_create" || receipt.operation === "candidate_successor") {
    const candidateRef = receipt.candidateRef;
    if (candidateRef === undefined) throw commandError("OWNER_STATE_INVALID", false);
    await assertCandidateHeadForAppend(client, candidateRef, receipt.previousRef, input.expectedHeadRef);
    await insertCanonicalCandidate(client, receipt, input.codec);
    pendingHeads.push({ kind: "candidate", ref: cloneCanonicalRef(candidateRef) });
  } else {
    const candidateReceipt = receipt.candidateReceipt;
    const memoryRef = receipt.memoryRef;
    if (candidateReceipt === undefined || memoryRef === undefined) throw commandError("OWNER_STATE_INVALID", false);
    const candidateRef = candidateReceipt.candidateRef;
    if (candidateRef === undefined) throw commandError("OWNER_STATE_INVALID", false);
    await assertCandidateHeadForAppend(client, candidateRef, candidateReceipt.previousRef);
    await insertCanonicalCandidate(client, candidateReceipt, input.codec);
    const payload = canonicalPayloadRecord(receipt.payload);
    const userId = nonEmptyText(payload.user_id, "canonical durable user_id");
    const slot = nonEmptyText(payload.slot, "canonical durable slot");
    await assertMemoryHeadForAppend(client, userId, slot, memoryRef, receipt.previousRef, input.expectedHeadRef);
    await insertCanonicalMemory(client, receipt, input.codec);
    pendingHeads.push({ kind: "candidate", ref: cloneCanonicalRef(candidateRef) });
    pendingHeads.push({ kind: "memory", ref: cloneCanonicalRef(memoryRef), userId, slot });
  }

  const watermark = await advanceAppendWatermark(client);
  for (const head of pendingHeads) {
    if (head.kind === "candidate") {
      await client.query(
        [
          "INSERT INTO memory_candidate_heads (candidate_ref_id, candidate_object_version, candidate_payload_sha256, authority_watermark)",
          "VALUES ($1, $2, $3, $4::jsonb)",
          "ON CONFLICT (candidate_ref_id) DO UPDATE SET candidate_object_version = EXCLUDED.candidate_object_version, candidate_payload_sha256 = EXCLUDED.candidate_payload_sha256, authority_watermark = EXCLUDED.authority_watermark, updated_at = now()",
        ].join(" "),
        [head.ref.refId, head.ref.objectVersion, head.ref.canonicalPayloadSha256, stableJsonText(watermark)],
      );
    } else {
      await client.query(
        [
          "INSERT INTO memory_slot_heads (user_id, slot, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, authority_watermark)",
          "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
          "ON CONFLICT (user_id, slot) DO UPDATE SET memory_ref_type = EXCLUDED.memory_ref_type, memory_ref_id = EXCLUDED.memory_ref_id, memory_object_version = EXCLUDED.memory_object_version, memory_payload_sha256 = EXCLUDED.memory_payload_sha256, authority_watermark = EXCLUDED.authority_watermark, updated_at = now()",
        ].join(" "),
        [head.userId, head.slot, head.ref.refType, head.ref.refId, head.ref.objectVersion, head.ref.canonicalPayloadSha256, stableJsonText(watermark)],
      );
    }
  }

  const appendedRef = cloneCanonicalRef(receipt.memoryRef ?? receipt.candidateRef!);
  const result: CanonicalAppendResult = Object.freeze({
    kind: "memory_canonical_append_receipt",
    appendedRef,
    headRef: cloneCanonicalRef(appendedRef),
    authorityWatermark: watermark,
  });
  await completeIdempotency(client, {
    scope: "memory.canonical_append",
    idempotencyKey: input.idempotencyKey,
    requestHash: input.fingerprint,
  }, result, stableJsonHash(result));
  await enqueueOutboxEvent(client, {
    eventId: deterministicUuid("memory.canonical_append", input.idempotencyKey, receipt.operation),
    aggregateType: "memory",
    aggregateId: appendedRef.refId,
    eventType: "memory.canonical.appended",
    eventVersion: 1,
    idempotencyScope: "memory.outbox",
    idempotencyKey: input.idempotencyKey,
    payload: { appendedRef, operation: receipt.operation, authorityWatermark: watermark },
    payloadHash: stableJsonHash({ appendedRef, operation: receipt.operation, authorityWatermark: watermark }),
  });
  return result;
}

async function insertCanonicalCandidate(client: PoolClient, receipt: ProductionMemoryIssuerReceipt, codec: MemoryCanonicalReceiptCodec): Promise<void> {
  const candidateRef = receipt.candidateRef;
  if (candidateRef === undefined) throw commandError("OWNER_STATE_INVALID", false);
  const payload = canonicalPayloadRecord(receipt.payload);
  const validated = projectCanonicalReceipt(receipt, codec);
  const projection = validated.projection;
  const target = payload.target === undefined ? undefined : canonicalWireRefToInternal(payload.target);
  const correction = payload.correction_intent === undefined ? undefined : canonicalWireCorrectionToInternal(payload.correction_intent);
  const values: unknown[] = [
    stableJsonText(candidateRef), candidateRef.refType, candidateRef.refId, candidateRef.objectVersion, candidateRef.canonicalPayloadSha256,
    payload.kind, payload.status, nonEmptyText(payload.proposal_id, "proposal_id"), nonEmptyText(payload.slot, "slot"),
    stableJsonText(payload.value), stableJsonText(canonicalWireRefsToInternal(payload.evidence_refs)), nonEmptyText(payload.source_class, "source_class"),
    integerValue(payload.confidence_ppm, "confidence_ppm"), nonEmptyText(payload.idempotency_key, "idempotency_key"), false,
    nonEmptyText(payload.memory_kind, "memory_kind"), nonEmptyText(payload.user_id, "user_id"), stableJsonText(payload.purpose_scopes),
    stableJsonText(canonicalWireSensitivityToInternal(payload.sensitivity)), stableJsonText(canonicalWireValidityToInternal(payload.validity)),
    target === undefined ? null : stableJsonText(target), target?.refType ?? null, target?.refId ?? null, target?.objectVersion ?? null, target?.canonicalPayloadSha256 ?? null,
    correction === undefined ? null : stableJsonText(correction), payload.reason === undefined ? null : stableJsonText(payload.reason),
    payload.conflict === undefined ? null : stableJsonText(payload.conflict), payload.requires_review === true, null, null, null, null, null, null,
     receipt.canonicalPayloadJcs, stableJsonText(receipt.payload), stableJsonText(projection), projection.projectionJcs, projection.projectionSha256,
  ];
  await client.query(
    [
      "INSERT INTO memory_candidates (candidate_ref, candidate_ref_type, candidate_ref_id, candidate_object_version, candidate_payload_sha256, kind, status, proposal_id, slot, value, evidence_refs, source_class, confidence_ppm, idempotency_key, current, memory_kind, user_id, purpose_scopes, sensitivity, validity, target_ref, target_ref_type, target_ref_id, target_object_version, target_payload_sha256, correction_intent, reason, conflict, requires_review, conflict_binding, linked_memory_ref, linked_memory_ref_type, linked_memory_ref_id, linked_memory_object_version, linked_memory_payload_sha256, canonical_payload_jcs, canonical_payload, canonical_receipt_projection, canonical_receipt_projection_jcs, canonical_receipt_projection_sha256)",
      "VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24, $25, $26::jsonb, $27::jsonb, $28::jsonb, $29, $30::jsonb, $31::jsonb, $32, $33, $34, $35, $36, $37::jsonb, $38::jsonb, $39, $40)",
      "ON CONFLICT (candidate_ref_id, candidate_object_version, candidate_payload_sha256) DO NOTHING",
    ].join(" "),
    values,
  );
  const row = (await client.query(
    "SELECT candidate_ref, candidate_ref_type, candidate_ref_id, candidate_object_version, candidate_payload_sha256, canonical_payload_jcs, canonical_payload, canonical_receipt_projection, canonical_receipt_projection_jcs, canonical_receipt_projection_sha256 FROM memory_candidates WHERE candidate_ref_id = $1 AND candidate_object_version = $2 AND candidate_payload_sha256 = $3 FOR UPDATE",
    [candidateRef.refId, candidateRef.objectVersion, candidateRef.canonicalPayloadSha256],
  )).rows[0];
  if (row === undefined || row.canonical_payload_jcs !== receipt.canonicalPayloadJcs ||
      row.canonical_receipt_projection_jcs !== projection.projectionJcs ||
      String(row.canonical_receipt_projection_sha256).trim() !== projection.projectionSha256 ||
      !stableJsonEqual(row.canonical_payload, receipt.payload) ||
      rehydrateCanonicalReceipt(row.canonical_receipt_projection, codec).canonicalPayloadJcs !== receipt.canonicalPayloadJcs) {
    throw commandError("IDEMPOTENCY_CONFLICT", false);
  }
}

async function insertCanonicalMemory(client: PoolClient, receipt: ProductionMemoryIssuerReceipt, codec: MemoryCanonicalReceiptCodec): Promise<void> {
  const memoryRef = receipt.memoryRef;
  if (memoryRef === undefined) throw commandError("OWNER_STATE_INVALID", false);
  const payload = canonicalPayloadRecord(receipt.payload);
  const validated = projectCanonicalReceipt(receipt, codec);
  const projection = validated.projection;
  const supersedes = payload.supersedes === undefined ? undefined : canonicalWireRefToInternal(payload.supersedes);
  const values: unknown[] = [
    stableJsonText(memoryRef), memoryRef.refType, memoryRef.refId, memoryRef.objectVersion, memoryRef.canonicalPayloadSha256,
    nonEmptyText(payload.user_id, "user_id"), nonEmptyText(payload.kind, "kind"), nonEmptyText(payload.slot, "slot"), stableJsonText(payload.value),
    typeof payload.resolved_content === "string" ? payload.resolved_content : "", nonEmptyText(payload.status, "status"), payload.current === true,
    nonEmptyText(payload.source_class, "source_class"), stableJsonText(canonicalWireRefsToInternal(payload.evidence_refs)), integerValue(payload.confidence_ppm, "confidence_ppm"),
    stableJsonText(payload.allowed_purpose_scopes), stableJsonText(canonicalWireSensitivityToInternal(payload.sensitivity)), stableJsonText(canonicalWireValidityToInternal(payload.validity)),
    supersedes === undefined ? null : stableJsonText(supersedes), supersedes?.refType ?? null, supersedes?.refId ?? null, supersedes?.objectVersion ?? null, supersedes?.canonicalPayloadSha256 ?? null,
    payload.correction_intent === undefined ? null : stableJsonText(canonicalWireCorrectionToInternal(payload.correction_intent)), null, null, null, payload.status === "deleted" ? true : false,
     null, receipt.canonicalPayloadJcs, stableJsonText(receipt.payload), stableJsonText(projection), projection.projectionJcs, projection.projectionSha256,
  ];
  await client.query(
    [
      "INSERT INTO memory_versions (memory_ref, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, user_id, kind, slot, value, resolved_content, status, current, source_class, evidence_refs, confidence_ppm, allowed_purpose_scopes, sensitivity, validity, supersedes_ref, supersedes_ref_type, supersedes_ref_id, supersedes_object_version, supersedes_payload_sha256, correction_intent, dream_accepted_delta, deleted_at, suppressed_at, stale, derived_rank_score, canonical_payload_jcs, canonical_payload, canonical_receipt_projection, canonical_receipt_projection_jcs, canonical_receipt_projection_sha256)",
      "VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26::timestamptz, $27::timestamptz, $28, $29, $30, $31::jsonb, $32, $33, $34)",
      "ON CONFLICT (memory_ref_id, memory_object_version, memory_payload_sha256) DO NOTHING",
    ].join(" "),
    values,
  );
  const row = (await client.query(
    "SELECT memory_ref, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256, canonical_payload_jcs, canonical_payload, canonical_receipt_projection, canonical_receipt_projection_jcs, canonical_receipt_projection_sha256 FROM memory_versions WHERE memory_ref_id = $1 AND memory_object_version = $2 AND memory_payload_sha256 = $3 FOR UPDATE",
    [memoryRef.refId, memoryRef.objectVersion, memoryRef.canonicalPayloadSha256],
  )).rows[0];
  if (row === undefined || row.canonical_payload_jcs !== receipt.canonicalPayloadJcs ||
      row.canonical_receipt_projection_jcs !== projection.projectionJcs ||
      String(row.canonical_receipt_projection_sha256).trim() !== projection.projectionSha256 ||
      !stableJsonEqual(row.canonical_payload, receipt.payload) ||
      rehydrateCanonicalReceipt(row.canonical_receipt_projection, codec).canonicalPayloadJcs !== receipt.canonicalPayloadJcs) {
    throw commandError("IDEMPOTENCY_CONFLICT", false);
  }
}

async function assertCandidateHeadForAppend(
  client: PoolClient,
  ref: CanonicalObjectVersionRef,
  previousRef?: CanonicalObjectVersionRef,
  expectedHeadRef?: CanonicalObjectVersionRef,
): Promise<void> {
  const row = (await client.query(
    "SELECT candidate_ref_id, candidate_object_version, candidate_payload_sha256 FROM memory_candidate_heads WHERE candidate_ref_id = $1 FOR UPDATE",
    [ref.refId],
  )).rows[0];
  const current = row === undefined ? undefined : refFromHeadRow(row, "MemoryCandidate");
  if (expectedHeadRef !== undefined && (current === undefined || canonicalRefKey(current) !== canonicalRefKey(expectedHeadRef))) {
    throw commandError("CURRENT_VERSION_CONFLICT", false);
  }
  if (current !== undefined && canonicalRefKey(current) === canonicalRefKey(ref)) {
    /* Exact candidate already applied is a transaction-local no-op. The
     * insert verifier below still rejects projection/payload drift. */
    return;
  }
  if (previousRef !== undefined) {
    if (current === undefined || canonicalRefKey(current) !== canonicalRefKey(previousRef) || compareDecimal(ref.objectVersion, current.objectVersion) <= 0) {
      throw commandError("CURRENT_VERSION_CONFLICT", false);
    }
  } else if (current !== undefined) {
    throw commandError(
      canonicalRefKey(current) === canonicalRefKey(ref) ? "IDEMPOTENCY_CONFLICT" : "CURRENT_VERSION_CONFLICT",
      false,
    );
  }
}

async function assertMemoryHeadForAppend(
  client: PoolClient,
  userId: string,
  slot: string,
  ref: CanonicalObjectVersionRef,
  previousRef?: CanonicalObjectVersionRef,
  expectedHeadRef?: CanonicalObjectVersionRef,
): Promise<void> {
  const row = (await client.query(
    "SELECT memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256 FROM memory_slot_heads WHERE user_id = $1 AND slot = $2 FOR UPDATE",
    [userId, slot],
  )).rows[0];
  const current = row === undefined ? undefined : refFromHeadRow(row, ref.refType);
  if (expectedHeadRef !== undefined && (current === undefined || canonicalRefKey(current) !== canonicalRefKey(expectedHeadRef))) {
    throw commandError("CURRENT_VERSION_CONFLICT", false);
  }
  if (previousRef !== undefined) {
    if (current === undefined || canonicalRefKey(current) !== canonicalRefKey(previousRef) || compareDecimal(ref.objectVersion, current.objectVersion) <= 0) {
      throw commandError("CURRENT_VERSION_CONFLICT", false);
    }
  } else if (current !== undefined) {
    throw commandError(
      canonicalRefKey(current) === canonicalRefKey(ref) ? "IDEMPOTENCY_CONFLICT" : "CURRENT_VERSION_CONFLICT",
      false,
    );
  }
}

function refFromHeadRow(row: Record<string, unknown>, expectedType: CanonicalObjectVersionRef["refType"]): CanonicalObjectVersionRef {
  return cloneCanonicalRef({
    refType: expectedType,
    refId: row.candidate_ref_id ?? row.memory_ref_id,
    objectVersion: row.candidate_object_version ?? row.memory_object_version,
    canonicalPayloadSha256: row.candidate_payload_sha256 ?? row.memory_payload_sha256,
  });
}

function compareDecimal(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/u, "");
  const b = right.replace(/^0+(?=\d)/u, "");
  return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
}

async function advanceAppendWatermark(client: PoolClient): Promise<MemoryAppendOnlyAuthorityWatermark> {
  const result = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE FOR UPDATE");
  if (result.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
  const next = incrementDecimal(String(result.rows[0]!.watermark));
  await client.query("UPDATE memory_authority_clock SET watermark = $1, updated_at = now() WHERE clock_id = TRUE", [next]);
  return appendOnlyWatermark(watermarkFromEpoch(next));
}

function canonicalPayloadRecord(value: CanonicalMemoryPayload): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw commandError("OWNER_STATE_INVALID", false);
  return value as Record<string, unknown>;
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new MemoryPersistenceError("INVALID_CANONICAL_PAYLOAD", `${field} is required`);
  return value;
}

function integerValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) throw new MemoryPersistenceError("INVALID_CANONICAL_PAYLOAD", `${field} is invalid`);
  return value as number;
}

function canonicalAppendResultFromStored(value: unknown): CanonicalAppendResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== "memory_canonical_append_receipt") return undefined;
  try {
    return Object.freeze({
      kind: "memory_canonical_append_receipt",
      appendedRef: cloneCanonicalRef(row.appendedRef),
      headRef: cloneCanonicalRef(row.headRef),
      authorityWatermark: stableJsonClone(row.authorityWatermark) as MemoryAppendOnlyAuthorityWatermark,
    });
  } catch { return undefined; }
}

function compilerPredicates(alias: string, query: CompilerQuery, params: unknown[]): string[] {
  const prefix = alias.length === 0 ? "" : `${alias}.`;
  const predicates = [
    `${prefix}user_id = $1`, ...(alias.length === 0 ? [`${prefix}current = TRUE`] : []), `${prefix}status = 'current'`, `${prefix}stale = FALSE`,
    `${prefix}deleted_at IS NULL`, `${prefix}suppressed_at IS NULL`,
    `($2 = ANY (SELECT jsonb_array_elements_text(${prefix}allowed_purpose_scopes)))`,
    `${prefix}updated_at <= $3::timestamptz`,
  ];
  if (query.slot !== undefined) { params.push(query.slot); predicates.push(`${prefix}slot = $${params.length}`); }
  if (query.slots !== undefined) { params.push(query.slots); predicates.push(`${prefix}slot = ANY($${params.length}::text[])`); }
  if (query.kind !== undefined) { params.push(query.kind); predicates.push(`${prefix}kind = $${params.length}`); }
  if (query.kinds !== undefined) { params.push(query.kinds); predicates.push(`${prefix}kind = ANY($${params.length}::text[])`); }
  return predicates;
}

async function appendOnlySchemaAvailable(client: PoolClient): Promise<boolean> {
  const result = await client.query("SELECT to_regclass('memory_slot_heads') AS relation");
  return result.rows.length === 1 && result.rows[0]!.relation !== null && result.rows[0]!.relation !== undefined;
}

function candidatePredicates(alias: string, query: MemoryCandidateQuery, params: unknown[]): string[] {
  const prefix = alias.length === 0 ? "" : `${alias}.`;
  const predicates = [`${prefix}user_id = $1`];
  if (query.statuses !== undefined) { params.push(query.statuses); predicates.push(`${prefix}status = ANY($${params.length}::text[])`); }
  if (query.slot !== undefined) { params.push(query.slot); predicates.push(`${prefix}slot = $${params.length}`); }
  return predicates;
}

async function assertCanonicalHeadIntegrity(client: PoolClient, userId: string, slot?: string): Promise<void> {
  const params: unknown[] = [userId];
  const rowsSuffix = slot === undefined ? "" : " AND slot = $2";
  const headsSuffix = slot === undefined ? "" : " AND h.slot = $2";
  if (slot !== undefined) params.push(slot);
  const rows = await client.query(
    `SELECT user_id, slot, memory_ref_type, memory_ref_id, memory_object_version, memory_payload_sha256 FROM memory_versions WHERE user_id = $1${rowsSuffix} AND canonical_payload_jcs IS NOT NULL`,
    params,
  );
  const heads = await client.query(
    `SELECT h.user_id, h.slot, h.memory_ref_type, h.memory_ref_id, h.memory_object_version, h.memory_payload_sha256, v.canonical_payload_jcs FROM memory_slot_heads h LEFT JOIN memory_versions v ON v.memory_ref_type = h.memory_ref_type AND v.memory_ref_id = h.memory_ref_id AND v.memory_object_version = h.memory_object_version AND v.memory_payload_sha256 = h.memory_payload_sha256 WHERE h.user_id = $1${headsSuffix}`,
    params,
  );
  const expected = new Map<string, Record<string, unknown>>();
  for (const row of rows.rows) {
    const key = `${row.user_id}\u0000${row.slot}`;
    const previous = expected.get(key);
    if (previous === undefined || compareDecimal(String(row.memory_object_version), String(previous.memory_object_version)) > 0) expected.set(key, row);
  }
  if (heads.rows.length !== expected.size) throw new MemoryPersistenceError("APPEND_HEAD_INVALID");
  for (const head of heads.rows) {
    const key = `${head.user_id}\u0000${head.slot}`;
    const winner = expected.get(key);
    if (winner === undefined || head.canonical_payload_jcs === null ||
        String(head.memory_ref_type) !== String(winner.memory_ref_type) ||
        String(head.memory_ref_id) !== String(winner.memory_ref_id) ||
        String(head.memory_object_version) !== String(winner.memory_object_version) ||
        String(head.memory_payload_sha256).trim() !== String(winner.memory_payload_sha256).trim()) {
      throw new MemoryPersistenceError("APPEND_HEAD_INVALID");
    }
  }
}

async function assertCandidateHeadIntegrity(client: PoolClient, userId: string): Promise<void> {
  const rows = await client.query(
    "SELECT candidate_ref_id, candidate_object_version, candidate_payload_sha256 FROM memory_candidates WHERE user_id = $1 AND canonical_payload_jcs IS NOT NULL",
    [userId],
  );
  const heads = await client.query(
    "SELECT h.candidate_ref_id, h.candidate_object_version, h.candidate_payload_sha256, v.canonical_payload_jcs FROM memory_candidate_heads h LEFT JOIN memory_candidates v ON v.candidate_ref_id = h.candidate_ref_id AND v.candidate_object_version = h.candidate_object_version AND v.candidate_payload_sha256 = h.candidate_payload_sha256 WHERE v.user_id = $1 OR (v.candidate_ref_id IS NULL AND h.candidate_ref_id IN (SELECT candidate_ref_id FROM memory_candidates WHERE user_id = $1 AND canonical_payload_jcs IS NOT NULL))",
    [userId],
  );
  const expected = new Map<string, Record<string, unknown>>();
  for (const row of rows.rows) {
    const key = String(row.candidate_ref_id);
    const previous = expected.get(key);
    if (previous === undefined || compareDecimal(String(row.candidate_object_version), String(previous.candidate_object_version)) > 0) expected.set(key, row);
  }
  if (heads.rows.length !== expected.size) throw new MemoryPersistenceError("APPEND_HEAD_INVALID");
  for (const head of heads.rows) {
    const winner = expected.get(String(head.candidate_ref_id));
    if (winner === undefined || head.canonical_payload_jcs === null ||
        String(head.candidate_object_version) !== String(winner.candidate_object_version) ||
        String(head.candidate_payload_sha256).trim() !== String(winner.candidate_payload_sha256).trim()) {
      throw new MemoryPersistenceError("APPEND_HEAD_INVALID");
    }
  }
}

function appendOnlyWatermark(value: MemoryAuthorityWatermark): MemoryAppendOnlyAuthorityWatermark {
  return value as unknown as MemoryAppendOnlyAuthorityWatermark;
}

export function createMemoryAuthorityRepository(
  pool: Pool,
  options: MemoryAuthorityRepositoryOptions = {},
): MemoryAuthorityRepository {
  return new MemoryAuthorityRepository(pool, options);
}

/** A fixture adapter must receive all refs up front and declare its environment. */
export function createNonProductionMemoryIdentityProvider(input: {
  readonly candidateRefs: readonly CanonicalObjectVersionRef[];
  readonly memoryRefs: readonly CanonicalObjectVersionRef[];
}): MemoryCanonicalIdentityProvider {
  const candidates = input.candidateRefs.map(cloneCanonicalRef);
  const memories = input.memoryRefs.map(cloneCanonicalRef);
  let candidateIndex = 0;
  let memoryIndex = 0;
  return Object.freeze({
    environment: "non-production" as const,
    candidateRefFor() {
      const ref = candidates[candidateIndex++];
      if (ref === undefined) throw new MemoryPersistenceError("CANONICAL_IDENTITY_EXHAUSTED");
      if (ref.refType !== "MemoryCandidate") throw new MemoryPersistenceError("OWNER_STATE_INVALID");
      return ref;
    },
    memoryRefFor({ memoryKind }: { readonly memoryKind: MemoryVersionRecord["kind"] }) {
      const ref = memories[memoryIndex++];
      if (ref === undefined || ref.refType !== memoryKindRefTypeForKind(memoryKind)) throw new MemoryPersistenceError("CANONICAL_IDENTITY_EXHAUSTED");
      return ref;
    },
  });
}
