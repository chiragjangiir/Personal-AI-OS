import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../memory-os/src/canonical-ref.ts";
import type { AuthorityWatermark } from "../../memory-os/src/domain.ts";
import type { OwnerPortResult } from "../../memory-os/src/ports.ts";
import type { DerivedProjectionConfig, RebuiltProjectionResult } from "../../memory-os/src/rebuild-manifest.ts";
import {
  cloneCanonicalRef,
  assertAuthorityWatermark,
  refToColumns,
  stableJsonClone,
  stableJsonEqual,
  stableJsonHash,
  stableJsonText,
  MemoryPersistenceError,
  watermarkFromEpoch,
  type MemoryAuthorityWatermark,
} from "./memory-persistence-primitives.ts";
import { withReadOnlyTransaction, withTransaction } from "./transaction.ts";
import { claimIdempotency, completeIdempotency, IdempotencyConflictError } from "./idempotency-ledger.ts";
import { enqueueOutboxEvent } from "./transactional-outbox.ts";

export interface DerivedProjectionWriteInput {
  readonly projectionKind: "fts" | "pgvector" | "graph";
  readonly authorityRef: CanonicalObjectVersionRef;
  readonly authorityWatermark: AuthorityWatermark;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly projectionSha256: Sha256;
  readonly recordCount: number;
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
}

export interface DerivedProjectionRecord {
  readonly projectionKind: DerivedProjectionWriteInput["projectionKind"];
  readonly authorityRef: CanonicalObjectVersionRef;
  readonly authorityWatermark: AuthorityWatermark;
  readonly implementationVersion: string;
  readonly configurationSha256: Sha256;
  readonly projectionSha256: Sha256;
  readonly recordCount: number;
}

const COLUMNS = [
  "projection_kind, authority_ref, authority_ref_type, authority_ref_id, authority_object_version, authority_payload_sha256,",
  "authority_watermark, implementation_version, configuration_sha256, projection_sha256, record_count, created_at, updated_at",
].join(" ");

function deterministicUuid(key: string): string {
  const digest = createHash("sha256").update(`memory.derived.outbox\u0000${key}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function parseRow(row: QueryResultRow): DerivedProjectionRecord {
  const ref = cloneCanonicalRef({
    refType: row.authority_ref_type,
    refId: row.authority_ref_id,
    objectVersion: row.authority_object_version,
    canonicalPayloadSha256: String(row.authority_payload_sha256).trim(),
  });
  if (stableJsonText(row.authority_ref) !== stableJsonText(ref)) throw new MemoryPersistenceError("REF_COLUMN_DRIFT");
  if (row.projection_kind !== "fts" && row.projection_kind !== "pgvector" && row.projection_kind !== "graph") throw new MemoryPersistenceError("INVALID_PROJECTION_KIND");
  const config = String(row.configuration_sha256).trim();
  const projection = String(row.projection_sha256).trim();
  const authorityWatermark = assertAuthorityWatermark(row.authority_watermark) as AuthorityWatermark;
  if (typeof row.implementation_version !== "string" || row.implementation_version.length === 0 || !/^[0-9a-f]{64}$/u.test(config) || !/^[0-9a-f]{64}$/u.test(projection)) throw new MemoryPersistenceError("INVALID_PROJECTION_ROW");
  const recordCount = Number(row.record_count);
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) throw new MemoryPersistenceError("INVALID_PROJECTION_ROW");
  return Object.freeze({
    projectionKind: row.projection_kind,
    authorityRef: ref,
    authorityWatermark,
    implementationVersion: row.implementation_version,
    configurationSha256: config as Sha256,
    projectionSha256: projection as Sha256,
    recordCount,
  });
}

function validateInput(input: DerivedProjectionWriteInput): void {
  if (input.projectionKind !== "fts" && input.projectionKind !== "pgvector" && input.projectionKind !== "graph") throw new TypeError("invalid projection kind");
  assertCanonicalObjectVersionRef(input.authorityRef);
  assertAuthorityWatermark(input.authorityWatermark);
  if (typeof input.implementationVersion !== "string" || input.implementationVersion.length === 0 ||
      typeof input.recordCount !== "number" || !Number.isSafeInteger(input.recordCount) || input.recordCount < 0) throw new TypeError("invalid projection input");
}

export class MemoryDerivedRepository {
  readonly pool: Pool;
  constructor(pool: Pool) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    this.pool = pool;
  }

  async writeProjection(input: DerivedProjectionWriteInput): Promise<DerivedProjectionRecord> {
    validateInput(input);
    const authority = refToColumns(input.authorityRef);
    const authorityWatermark = assertAuthorityWatermark(input.authorityWatermark);
    const requestHash = stableJsonHash({
      schema: "memory.derived.request.v2",
      idempotencyKey: input.idempotencyKey,
      projectionKind: input.projectionKind,
      authorityRef: input.authorityRef,
      authorityWatermark,
      implementationVersion: input.implementationVersion,
      configurationSha256: input.configurationSha256,
      projectionSha256: input.projectionSha256,
      recordCount: input.recordCount,
    });
    return withTransaction(this.pool, async (client) => {
      const claim = await claimIdempotency(client, {
        scope: "memory.derived",
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (claim.kind === "replay" || claim.kind === "terminal") {
        const response = claim.record.response as DerivedProjectionRecord;
        if (response === undefined || response.authorityRef === undefined) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
        return Object.freeze({
          ...response,
          authorityRef: cloneCanonicalRef(response.authorityRef),
          authorityWatermark: stableJsonClone(response.authorityWatermark),
        });
      }
      if (claim.kind === "in_flight") throw new MemoryPersistenceError("IDEMPOTENCY_IN_FLIGHT");
      const existing = await client.query(
        `SELECT ${COLUMNS} FROM memory_derived_projections WHERE projection_kind = $1 AND authority_ref_id = $2 AND authority_object_version = $3 AND authority_payload_sha256 = $4 AND configuration_sha256 = $5 FOR UPDATE`,
        [input.projectionKind, authority.ref_id, authority.object_version, authority.canonical_payload_sha256, input.configurationSha256],
      );
      if (existing.rows.length === 1) {
        const stored = parseRow(existing.rows[0]!);
        if (!this.sameInput(stored, input)) throw new MemoryPersistenceError("IDEMPOTENCY_CONFLICT");
        await completeIdempotency(client, { scope: "memory.derived", idempotencyKey: input.idempotencyKey, requestHash }, stored, stableJsonHash(stored));
        return stored;
      }
      const result = await client.query(
        [
          "INSERT INTO memory_derived_projections (projection_kind, authority_ref, authority_ref_type, authority_ref_id, authority_object_version, authority_payload_sha256, authority_watermark, implementation_version, configuration_sha256, projection_sha256, record_count)",
          "VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)",
          "RETURNING " + COLUMNS,
        ].join(" "),
        [input.projectionKind, stableJsonText(input.authorityRef), authority.ref_type, authority.ref_id, authority.object_version, authority.canonical_payload_sha256,
          stableJsonText(authorityWatermark), input.implementationVersion, input.configurationSha256, input.projectionSha256, input.recordCount],
      );
      const stored = parseRow(result.rows[0]!);
      await this.enqueue(client, input, stored);
      await completeIdempotency(client, { scope: "memory.derived", idempotencyKey: input.idempotencyKey, requestHash }, stored, stableJsonHash(stored));
      return stored;
    });
  }

  async upsertProjection(input: DerivedProjectionWriteInput): Promise<DerivedProjectionRecord> {
    return this.writeProjection(input);
  }

  async findProjection(input: { readonly projectionKind: DerivedProjectionWriteInput["projectionKind"]; readonly authorityRef: CanonicalObjectVersionRef; readonly configurationSha256: Sha256 }): Promise<DerivedProjectionRecord | undefined> {
    const ref = refToColumns(input.authorityRef);
    const result = await withReadOnlyTransaction(this.pool, (client) => client.query(
      `SELECT ${COLUMNS} FROM memory_derived_projections WHERE projection_kind = $1 AND authority_ref_id = $2 AND authority_object_version = $3 AND authority_payload_sha256 = $4 AND configuration_sha256 = $5`,
      [input.projectionKind, ref.ref_id, ref.object_version, ref.canonical_payload_sha256, input.configurationSha256],
    ));
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new MemoryPersistenceError("PROJECTION_CONFLICT");
    const stored = parseRow(result.rows[0]!);
    if (!stableJsonEqual(stored.authorityRef, input.authorityRef)) throw new MemoryPersistenceError("REF_COLUMN_DRIFT");
    return stored;
  }

  async listByAuthority(authorityRef: CanonicalObjectVersionRef): Promise<readonly DerivedProjectionRecord[]> {
    const ref = refToColumns(authorityRef);
    const result = await withReadOnlyTransaction(this.pool, (client) => client.query(
      `SELECT ${COLUMNS} FROM memory_derived_projections WHERE authority_ref_id = $1 AND authority_object_version = $2 AND authority_payload_sha256 = $3 ORDER BY projection_kind, configuration_sha256`,
      [ref.ref_id, ref.object_version, ref.canonical_payload_sha256],
    ));
    return Object.freeze(result.rows.map(parseRow));
  }

  /** Delete only projections whose authority ref exactly matches the T03 target. */
  async purgeAuthorityRefs(refs: readonly CanonicalObjectVersionRef[]): Promise<number> {
    let count = 0;
    await withTransaction(this.pool, async (client) => {
      for (const value of refs) {
        const ref = refToColumns(value);
        const result = await client.query(
          "DELETE FROM memory_derived_projections WHERE authority_ref_id = $1 AND authority_object_version = $2 AND authority_payload_sha256 = $3",
          [ref.ref_id, ref.object_version, ref.canonical_payload_sha256],
        );
        count += result.rowCount ?? 0;
      }
    });
    return count;
  }

  /** Adapter for the storage-neutral rebuild service; body remains owner-side. */
  async recordRebuiltProjection(input: DerivedProjectionWriteInput): Promise<OwnerPortResult<readonly RebuiltProjectionResult[]>> {
    try {
      const stored = await this.writeProjection(input);
      return {
        ok: true,
        value: Object.freeze([{
          kind: stored.projectionKind,
          configurationSha256: stored.configurationSha256,
          projectionSha256: stored.projectionSha256,
          recordCount: stored.recordCount,
        }]),
      };
    } catch {
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
  }

  private sameInput(stored: DerivedProjectionRecord, input: DerivedProjectionWriteInput): boolean {
    return stored.projectionKind === input.projectionKind && stableJsonEqual(stored.authorityRef, input.authorityRef) &&
      stableJsonEqual(stored.authorityWatermark, input.authorityWatermark) && stored.implementationVersion === input.implementationVersion &&
      stored.configurationSha256 === input.configurationSha256 && stored.projectionSha256 === input.projectionSha256 && stored.recordCount === input.recordCount;
  }

  private async enqueue(client: PoolClient, input: DerivedProjectionWriteInput, stored: DerivedProjectionRecord): Promise<void> {
    const payload = { authorityRef: stored.authorityRef, projectionKind: stored.projectionKind, authorityWatermark: stored.authorityWatermark };
    await enqueueOutboxEvent(client, {
      eventId: deterministicUuid(input.idempotencyKey),
      aggregateType: "memory_derived_projection",
      aggregateId: refToColumns(stored.authorityRef).ref_id,
      eventType: "memory.derived.updated",
      eventVersion: 1,
      idempotencyScope: "memory.outbox",
      idempotencyKey: input.idempotencyKey,
      payload,
      payloadHash: stableJsonHash(payload),
    });
  }
}

export function createMemoryDerivedRepository(pool: Pool): MemoryDerivedRepository {
  return new MemoryDerivedRepository(pool);
}
