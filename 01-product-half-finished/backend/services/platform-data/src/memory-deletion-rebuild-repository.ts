import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../memory-os/src/canonical-ref.ts";
import type { AuthorityWatermark, CanonicalUtcInstant } from "../../memory-os/src/domain.ts";
import type {
  MemoryDeletionMutationProjection,
  MemoryDeletionMutationWriter,
  MemoryDeletionSuccessorReceipt,
  OwnerPortResult,
} from "../../memory-os/src/ports.ts";
import type {
  DeletionRebuildLedger,
  DeletionRebuildLedgerClaim,
  DeletionRebuildLedgerCompletion,
  DeletionRebuildResult,
} from "../../memory-os/src/deletion-rebuild-service.ts";
import {
  cloneCanonicalRef,
  assertAuthorityWatermark,
  refToColumns,
  assertRefColumnEquality,
  stableJsonClone,
  stableJsonEqual,
  stableJsonHash,
  stableJsonText,
  type MemoryCanonicalReceiptCodec,
  MemoryPersistenceError,
  projectCanonicalReceipt,
  watermarkFromEpoch,
  type MemoryAuthorityWatermark,
} from "./memory-persistence-primitives.ts";
import { claimIdempotency, completeIdempotency, IdempotencyConflictError } from "./idempotency-ledger.ts";
import { enqueueOutboxEvent } from "./transactional-outbox.ts";
import { withReadOnlyTransaction, withTransaction } from "./transaction.ts";
import { appendCanonicalOnClient } from "./memory-authority-repository.ts";

export interface MemoryDeletionMutationResult {
  readonly authorityWatermark: AuthorityWatermark;
  readonly completedAt: CanonicalUtcInstant;
  readonly appliedTargets: readonly CanonicalObjectVersionRef[];
}

export interface MemoryDeletionRebuildRepositoryOptions {
  readonly derivedPurge?: (refs: readonly CanonicalObjectVersionRef[]) => Promise<number>;
  /** Required when a canonical successor receipt is supplied. */
  readonly canonicalCodec?: MemoryCanonicalReceiptCodec;
}

function deterministicUuid(key: string): string {
  const digest = createHash("sha256").update(`memory.deletion.outbox\u0000${key}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
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

function validateProjection(value: MemoryDeletionMutationProjection): void {
  assertCanonicalObjectVersionRef(value.deletionJobRef);
  if (value.deletionJobRef.refType !== "DeletionJob") throw new MemoryPersistenceError("DELETION_JOB_REF_INVALID");
  const target = assertCanonicalObjectVersionRef(value.targetRef);
  if (!(new Set(["MemoryCandidate", "SemanticFact", "EpisodicMemory", "PreferenceMemory", "OpenLoop"])).has(target.refType)) throw new MemoryPersistenceError("TARGET_REF_INVALID");
  if (!(new Set(["current", "superseded", "disputed", "suppressed", "deleted"])).has(value.targetStatus) ||
      typeof value.targetCurrent !== "boolean" || typeof value.deleted !== "boolean" || typeof value.suppressed !== "boolean" ||
      typeof value.tombstone !== "boolean" || value.nonResurrection !== true || value.authorityWatermark === undefined || value.authorityWatermark === null) {
    throw new MemoryPersistenceError("DELETION_PROJECTION_INVALID");
  }
  assertAuthorityWatermark(value.authorityWatermark);
}

function deletionRequestHash(input: {
  readonly idempotencyKey: string;
  readonly projections: readonly MemoryDeletionMutationProjection[];
  readonly successors?: readonly MemoryDeletionSuccessorReceipt[];
}): Sha256 {
  return stableJsonHash({
    schema: "memory.deletion.request.v2",
    idempotencyKey: input.idempotencyKey,
    projections: input.projections,
    successors: (input.successors ?? []).map((successor) => ({
      targetRef: successor.targetRef,
      receipt: successor.receipt.canonicalPayloadJcs,
    })),
  });
}

function rebuildRequestHash(idempotencyKey: string, fingerprint: Sha256, semanticInput?: unknown): Sha256 {
  return semanticInput === undefined
    ? stableJsonHash({ schema: "memory.deletion_rebuild.legacy-test.v2", idempotencyKey, fingerprint })
    : stableJsonHash(semanticInput);
}

function claimTokenHash(token: string): Sha256 {
  return assertSha256(createHash("sha256").update(token, "utf8").digest("hex"));
}

export class MemoryDeletionRebuildRepository implements MemoryDeletionMutationWriter, DeletionRebuildLedger {
  readonly pool: Pool;
  readonly options: MemoryDeletionRebuildRepositoryOptions;
  constructor(pool: Pool, options: MemoryDeletionRebuildRepositoryOptions = {}) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    this.pool = pool;
    this.options = options;
  }

  private requireCanonicalCodec(): MemoryCanonicalReceiptCodec {
    if (this.options.canonicalCodec === undefined) throw new MemoryPersistenceError("CANONICAL_CODEC_REQUIRED");
    return this.options.canonicalCodec;
  }

  async applyDeletionMutations(input: {
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly projections: readonly MemoryDeletionMutationProjection[];
    readonly successors?: readonly MemoryDeletionSuccessorReceipt[];
  }): Promise<OwnerPortResult<MemoryDeletionMutationResult>> {
    try {
      if (input.projections.length === 0) throw new MemoryPersistenceError("DELETION_PROJECTION_INVALID");
      input.projections.forEach(validateProjection);
      const projectionKeys = input.projections.map((projection) => canonicalRefKey(projection.targetRef));
      if (new Set(projectionKeys).size !== projectionKeys.length) throw new MemoryPersistenceError("DELETION_PROJECTION_INVALID");
      const successors = input.successors ?? [];
      const codec = successors.length === 0 ? undefined : this.requireCanonicalCodec();
      const successorByTarget = new Map<string, MemoryDeletionSuccessorReceipt>();
      for (const successor of successors) {
        const targetKey = canonicalRefKey(successor.targetRef);
        if (successorByTarget.has(targetKey)) throw new MemoryPersistenceError("DELETION_PROJECTION_INVALID");
        const receipt = projectCanonicalReceipt(successor.receipt, codec!).receipt;
        if (receipt.operation !== "memory_successor" || receipt.memoryRef === undefined || receipt.previousRef === undefined ||
            canonicalRefKey(receipt.previousRef) !== targetKey) throw new MemoryPersistenceError("DELETION_SUCCESSOR_INVALID");
        successorByTarget.set(targetKey, { ...successor, receipt });
      }
      if ([...successorByTarget.keys()].some((key) => !projectionKeys.includes(key))) {
        throw new MemoryPersistenceError("DELETION_SUCCESSOR_INVALID");
      }
      const schema = await this.pool.query("SELECT to_regclass('memory_slot_heads') AS relation");
      if (schema.rows[0]?.relation !== null && schema.rows[0]?.relation !== undefined) {
        for (const projection of input.projections) {
          if (projection.targetRef.refType === "MemoryCandidate" || successorByTarget.has(canonicalRefKey(projection.targetRef))) continue;
          const target = refToColumns(projection.targetRef);
          const row = (await this.pool.query(
            "SELECT canonical_payload_jcs FROM memory_versions WHERE memory_ref_id = $1 AND memory_object_version = $2 AND memory_payload_sha256 = $3",
            [target.ref_id, target.object_version, target.canonical_payload_sha256],
          )).rows[0];
          if (row === undefined) throw new MemoryPersistenceError("TARGET_NOT_FOUND");
          if (row.canonical_payload_jcs !== null && row.canonical_payload_jcs !== undefined) {
            throw new MemoryPersistenceError("DELETION_SUCCESSOR_REQUIRED");
          }
        }
      }
      const requestHash = deletionRequestHash(input);
      const result = await withTransaction(this.pool, async (client) => {
        const claim = await claimIdempotency(client, { scope: "memory.deletion", idempotencyKey: input.idempotencyKey, requestHash });
        if (claim.kind === "replay" || claim.kind === "terminal") {
          const stored = claim.record.response as MemoryDeletionMutationResult;
          if (!stored || !Array.isArray(stored.appliedTargets)) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
          return stored;
        }
        if (claim.kind === "in_flight") throw new MemoryPersistenceError("IDEMPOTENCY_IN_FLIGHT");
        const applied: CanonicalObjectVersionRef[] = [];
        for (const projection of input.projections) {
          const target = refToColumns(projection.targetRef);
          const job = refToColumns(projection.deletionJobRef);
          const existing = await client.query(
            "SELECT target_ref, target_ref_type, target_ref_id, target_object_version, target_payload_sha256, target_status, target_current, deleted, suppressed, tombstone, non_resurrection, authority_watermark FROM memory_deletion_mutations WHERE idempotency_key = $1 AND target_ref_id = $2 AND target_object_version = $3 AND target_payload_sha256 = $4 FOR UPDATE",
            [input.idempotencyKey, target.ref_id, target.object_version, target.canonical_payload_sha256],
          );
          if (existing.rows.length === 1) {
            const row = existing.rows[0]!;
            if (String(row.target_ref_type) !== target.ref_type || row.target_status !== projection.targetStatus || row.target_current !== projection.targetCurrent || row.deleted !== projection.deleted || row.suppressed !== projection.suppressed || row.tombstone !== projection.tombstone || row.non_resurrection !== true || !stableJsonEqual(row.authority_watermark, projection.authorityWatermark)) throw new MemoryPersistenceError("IDEMPOTENCY_CONFLICT");
            applied.push(cloneCanonicalRef(projection.targetRef));
            continue;
          }
          const mutation = await client.query(
            [
              "INSERT INTO memory_deletion_mutations (deletion_job_ref, deletion_job_ref_type, deletion_job_ref_id, deletion_job_object_version, deletion_job_payload_sha256, target_ref, target_ref_type, target_ref_id, target_object_version, target_payload_sha256, target_status, target_current, deleted, suppressed, tombstone, non_resurrection, authority_watermark, idempotency_key)",
              "VALUES ($1::jsonb, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, $16::jsonb, $17)",
              "RETURNING target_ref_id",
            ].join(" "),
            [stableJsonText(projection.deletionJobRef), job.ref_type, job.ref_id, job.object_version, job.canonical_payload_sha256, stableJsonText(projection.targetRef), target.ref_type, target.ref_id, target.object_version, target.canonical_payload_sha256, projection.targetStatus, projection.targetCurrent, projection.deleted, projection.suppressed, projection.tombstone, stableJsonText(projection.authorityWatermark), input.idempotencyKey],
          );
          if (mutation.rowCount !== 1) throw new MemoryPersistenceError("DELETION_WRITE_FAILED");
           if (projection.targetRef.refType !== "MemoryCandidate") {
             const successor = successorByTarget.get(canonicalRefKey(projection.targetRef));
             if (successor !== undefined) {
               await appendCanonicalOnClient(client, {
                 idempotencyKey: `${input.idempotencyKey}:successor:${target.ref_id}:${target.object_version}`,
                 fingerprint: stableJsonHash({ parent: input.fingerprint, target: projection.targetRef, receipt: successor.receipt.canonicalPayloadJcs }),
                 receipt: successor.receipt,
                 codec: codec!,
                 expectedHeadRef: projection.targetRef,
               });
             } else {
               const updated = await client.query(
                 "UPDATE memory_versions SET status = $4, current = $5, deleted_at = CASE WHEN $6 THEN now() ELSE deleted_at END, suppressed_at = CASE WHEN $7 THEN now() ELSE suppressed_at END, stale = TRUE, updated_at = now() WHERE memory_ref_id = $1 AND memory_object_version = $2 AND memory_payload_sha256 = $3",
                 [target.ref_id, target.object_version, target.canonical_payload_sha256, projection.targetStatus, projection.targetCurrent, projection.deleted, projection.suppressed],
               );
               if (updated.rowCount !== 1) throw new MemoryPersistenceError("TARGET_NOT_FOUND");
             }
           }
           applied.push(cloneCanonicalRef(projection.targetRef));
         }
        const watermark = await this.nextWatermark(client);
        const response: MemoryDeletionMutationResult = Object.freeze({
          authorityWatermark: watermark,
          completedAt: new Date().toISOString() as CanonicalUtcInstant,
          appliedTargets: Object.freeze(applied),
        });
        await completeIdempotency(client, { scope: "memory.deletion", idempotencyKey: input.idempotencyKey, requestHash }, response, stableJsonHash(response));
        const payload = { appliedTargets: applied, authorityWatermark: watermark };
        await enqueueOutboxEvent(client, {
          eventId: deterministicUuid(input.idempotencyKey),
          aggregateType: "memory",
          aggregateId: refToColumns(input.projections[0]!.targetRef).ref_id,
          eventType: "memory.deletion.applied",
          eventVersion: 1,
          idempotencyScope: "memory.outbox",
          idempotencyKey: input.idempotencyKey,
          payload,
          payloadHash: stableJsonHash(payload),
        });
        return response;
      });
      return { ok: true, value: result };
    } catch (error) {
      if (error instanceof IdempotencyConflictError || (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT")) return { ok: false, error: { code: "IDEMPOTENCY_CONFLICT", retryable: false } };
      if (error instanceof MemoryPersistenceError && error.code === "DELETION_SUCCESSOR_REQUIRED") {
        return { ok: false, error: { code: "DELETION_SUCCESSOR_REQUIRED", retryable: false } };
      }
      if (error instanceof MemoryPersistenceError && (error.code === "DELETION_SUCCESSOR_INVALID" || error.code === "DELETION_PROJECTION_INVALID" || error.code === "TARGET_NOT_FOUND")) {
        return { ok: false, error: { code: "DELETION_CONFLICT", retryable: false } };
      }
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
  }

  async readDeletionMutation(input: { readonly idempotencyKey: string; readonly targetRef: CanonicalObjectVersionRef }): Promise<MemoryDeletionMutationProjection | undefined> {
    const target = refToColumns(input.targetRef);
    const result = await withReadOnlyTransaction(this.pool, (client) => client.query(
      "SELECT deletion_job_ref, deletion_job_ref_type, deletion_job_ref_id, deletion_job_object_version, deletion_job_payload_sha256, target_ref, target_ref_type, target_ref_id, target_object_version, target_payload_sha256, target_status, target_current, deleted, suppressed, tombstone, non_resurrection, authority_watermark FROM memory_deletion_mutations WHERE idempotency_key = $1 AND target_ref_id = $2 AND target_object_version = $3 AND target_payload_sha256 = $4",
      [input.idempotencyKey, target.ref_id, target.object_version, target.canonical_payload_sha256],
    ));
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const deletionJobRef = assertRefColumnEquality(row.deletion_job_ref, {
      ref_type: row.deletion_job_ref_type,
      ref_id: row.deletion_job_ref_id,
      object_version: row.deletion_job_object_version,
      canonical_payload_sha256: String(row.deletion_job_payload_sha256).trim(),
    }, "DeletionJob");
    const targetRef = assertRefColumnEquality(row.target_ref, {
      ref_type: row.target_ref_type,
      ref_id: row.target_ref_id,
      object_version: row.target_object_version,
      canonical_payload_sha256: String(row.target_payload_sha256).trim(),
    });
    return {
      deletionJobRef,
      targetRef,
      targetStatus: row.target_status,
      targetCurrent: row.target_current,
      deleted: row.deleted,
      suppressed: row.suppressed,
      tombstone: row.tombstone,
      nonResurrection: row.non_resurrection,
      authorityWatermark: assertAuthorityWatermark(row.authority_watermark),
    };
  }

  async claim(input: { readonly idempotencyKey: string; readonly fingerprint: Sha256; readonly semanticInput?: unknown }): Promise<DeletionRebuildLedgerClaim> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const requestHash = rebuildRequestHash(input.idempotencyKey, input.fingerprint, input.semanticInput);
        const claim = await claimIdempotency(client, { scope: "memory.deletion_rebuild", idempotencyKey: input.idempotencyKey, requestHash });
        if (claim.kind === "replay" || claim.kind === "terminal") return { status: "replayed", result: claim.record.response as DeletionRebuildResult };
        if (claim.kind === "in_flight") return { status: "in_progress" };
        const claimToken = randomBytes(32).toString("hex");
        const tokenHash = claimTokenHash(claimToken);
        const bound = await client.query(
          "UPDATE idempotency_ledger SET claim_token_sha256 = $3, claim_owner = $4, updated_at = now() WHERE scope = $1 AND idempotency_key = $2 AND request_hash = $5 AND status = 'in_flight' AND claim_token_sha256 IS NULL",
          ["memory.deletion_rebuild", input.idempotencyKey, tokenHash, `memory-deletion-rebuild:${process.pid}`, requestHash],
        );
        if (bound.rowCount !== 1) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
        return { status: "acquired", claimToken };
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError || (error instanceof Error && error.name === "IdempotencyConflictError")) return { status: "conflict" };
      throw error;
    }
  }

  async complete(input: { readonly idempotencyKey: string; readonly fingerprint: Sha256; readonly semanticInput?: unknown; readonly claimToken: string; readonly result: DeletionRebuildResult }): Promise<DeletionRebuildLedgerCompletion> {
    return withTransaction(this.pool, async (client) => {
      const requestHash = rebuildRequestHash(input.idempotencyKey, input.fingerprint, input.semanticInput);
      const existing = await client.query("SELECT status, request_hash, response, claim_token_sha256 FROM idempotency_ledger WHERE scope = 'memory.deletion_rebuild' AND idempotency_key = $1 FOR UPDATE", [input.idempotencyKey]);
      if (existing.rows.length !== 1 || String(existing.rows[0]!.request_hash).trim() !== requestHash) return "claim_mismatch";
      if (existing.rows[0]!.status === "committed") return "already_completed";
      if (existing.rows[0]!.status !== "in_flight" || String(existing.rows[0]!.claim_token_sha256 ?? "").trim() !== claimTokenHash(input.claimToken)) return "claim_mismatch";
      await completeIdempotency(client, { scope: "memory.deletion_rebuild", idempotencyKey: input.idempotencyKey, requestHash }, input.result, stableJsonHash(input.result));
      return "completed";
    });
  }

  private async nextWatermark(client: PoolClient): Promise<MemoryAuthorityWatermark> {
    const result = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE FOR UPDATE");
    if (result.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
    const next = incrementDecimal(String(result.rows[0]!.watermark));
    await client.query("UPDATE memory_authority_clock SET watermark = $1, updated_at = now() WHERE clock_id = TRUE", [next]);
    return watermarkFromEpoch(next);
  }
}

export function createMemoryDeletionRebuildRepository(pool: Pool, options: MemoryDeletionRebuildRepositoryOptions = {}): MemoryDeletionRebuildRepository {
  return new MemoryDeletionRebuildRepository(pool, options);
}
