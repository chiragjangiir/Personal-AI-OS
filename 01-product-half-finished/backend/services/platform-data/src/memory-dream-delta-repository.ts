import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../memory-os/src/canonical-ref.ts";
import {
  assertCanonicalUtcInstant,
  type AcceptedDreamDeltaCursor,
  type AcceptedDreamDeltaPage,
  type AcceptedDreamDeltaQuery,
  type AcceptedDreamDeltaRecord,
  type AuthorityWatermark,
  type ReadonlyJsonValue,
} from "../../memory-os/src/domain.ts";
import type { AcceptedDreamDeltaReader } from "../../memory-os/src/ports.ts";
import { claimIdempotency, completeIdempotency } from "./idempotency-ledger.ts";
import { enqueueOutboxEvent } from "./transactional-outbox.ts";
import {
  cloneCanonicalRef,
  dateToCanonical,
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

export interface AcceptedDreamDeltaOwnerProjection {
  readonly ref: CanonicalObjectVersionRef;
  readonly userId: string;
  readonly accepted: true;
  readonly delta: ReadonlyJsonValue;
  readonly sourceRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedAt: string;
  readonly authorityWatermark: AuthorityWatermark;
}

export interface AcceptedDreamDeltaWriteInput extends AcceptedDreamDeltaOwnerProjection {
  readonly idempotencyKey: string;
  readonly fingerprint: Sha256;
}

const DELTA_COLUMNS = [
  "delta_ref, delta_ref_type, delta_ref_id, delta_object_version, delta_payload_sha256, user_id, accepted, delta, source_refs, accepted_at, authority_watermark, created_at",
].join(" ");

function deterministicUuid(key: string): string {
  const digest = createHash("sha256").update(`memory.dream.outbox\u0000${key}`, "utf8").digest("hex");
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

function copyRefs(values: readonly CanonicalObjectVersionRef[]): readonly CanonicalObjectVersionRef[] {
  const refs = values.map(cloneCanonicalRef);
  if (new Set(refs.map(canonicalRefKey)).size !== refs.length) throw new MemoryPersistenceError("DUPLICATE_REF");
  return Object.freeze(refs);
}

function parseDeltaRow(row: Record<string, unknown>): AcceptedDreamDeltaRecord {
  const ref = assertCanonicalObjectVersionRef(row.delta_ref);
  const columns = refToColumns({
    refType: row.delta_ref_type,
    refId: row.delta_ref_id,
    objectVersion: row.delta_object_version,
    canonicalPayloadSha256: String(row.delta_payload_sha256).trim(),
  });
  if (columns.ref_type !== ref.refType || columns.ref_id !== ref.refId || columns.object_version !== ref.objectVersion || columns.canonical_payload_sha256 !== ref.canonicalPayloadSha256) {
    throw new MemoryPersistenceError("REF_COLUMN_DRIFT");
  }
  if (row.accepted !== true) throw new MemoryPersistenceError("UNACCEPTED_DELTA");
  assertAuthorityWatermark(row.authority_watermark);
  return Object.freeze({
    ref,
    userId: String(row.user_id),
    accepted: true,
    delta: stableJsonClone(row.delta) as ReadonlyJsonValue,
    sourceRefs: copyRefs(stableJsonClone(row.source_refs) as readonly CanonicalObjectVersionRef[]),
    acceptedAt: assertCanonicalUtcInstant(dateToCanonical(row.accepted_at, "accepted_at")),
  });
}

function parseCursor(value: AcceptedDreamDeltaCursor | undefined): { readonly acceptedAt: string; readonly refKey: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value.token !== "string" || !value.token.startsWith("dream:")) throw new MemoryPersistenceError("INVALID_CURSOR");
  const body = value.token.slice("dream:".length);
  const split = body.indexOf("|");
  if (split <= 0) throw new MemoryPersistenceError("INVALID_CURSOR");
  const acceptedAt = assertCanonicalUtcInstant(body.slice(0, split));
  const refKey = body.slice(split + 1);
  if (refKey.length === 0) throw new MemoryPersistenceError("INVALID_CURSOR");
  return { acceptedAt, refKey };
}

export class MemoryDreamDeltaRepository implements AcceptedDreamDeltaReader {
  readonly pool: Pool;
  constructor(pool: Pool) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    this.pool = pool;
  }

  async readAcceptedDreamDeltas(query: AcceptedDreamDeltaQuery): Promise<AcceptedDreamDeltaPage> {
    const cursor = parseCursor(query.cursor);
    const snapshot = await withReadOnlyTransaction(this.pool, async (client) => {
      const params: unknown[] = [query.userId, query.window.from, query.window.to, query.limit];
      const predicates = ["user_id = $1", "accepted = TRUE", "accepted_at >= $2::timestamptz", "accepted_at < $3::timestamptz"];
      if (cursor !== undefined) {
        params.push(cursor.acceptedAt, cursor.refKey);
        predicates.push(`(accepted_at, delta_ref_id::text, delta_object_version, delta_payload_sha256) > ($${params.length - 1}::timestamptz, split_part($${params.length}::text, ':', 2), split_part($${params.length}::text, ':', 3), split_part($${params.length}::text, ':', 4))`);
      }
      const result = await client.query(
        `SELECT ${DELTA_COLUMNS} FROM memory_dream_deltas WHERE ${predicates.join(" AND ")} ORDER BY accepted_at, delta_ref_id, delta_object_version, delta_payload_sha256 LIMIT $4`,
        params,
      );
      const rows = result.rows.map((row) => parseDeltaRow(row as Record<string, unknown>));
      const clock = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE");
      if (clock.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
      return { rows, authorityWatermark: watermarkFromEpoch(clock.rows[0]!.watermark) };
    });
    const { rows, authorityWatermark } = snapshot;
    const next = rows.length >= query.limit ? rows[rows.length - 1] : undefined;
    return Object.freeze({
      records: Object.freeze(rows),
      authorityWatermark,
      ...(next === undefined ? {} : {
        nextCursor: Object.freeze({
          token: `dream:${next.acceptedAt}|${canonicalRefKey(next.ref)}`,
          authorityWatermark,
        }),
      }),
    });
  }

  async writeAcceptedDreamDelta(input: AcceptedDreamDeltaWriteInput): Promise<AcceptedDreamDeltaRecord> {
    const ref = cloneCanonicalRef(input.ref);
    if (input.accepted !== true || typeof input.userId !== "string" || input.userId.length === 0) {
      throw new MemoryPersistenceError("OWNER_STATE_INVALID", "only owner-accepted deltas may be written");
    }
    const sourceRefs = copyRefs(input.sourceRefs);
    const acceptedAt = assertCanonicalUtcInstant(input.acceptedAt);
    const ownerWatermark = assertAuthorityWatermark(input.authorityWatermark);
    const requestHash = stableJsonHash({
      schema: "memory.dream_delta.request.v2",
      idempotencyKey: input.idempotencyKey,
      ref,
      userId: input.userId,
      accepted: true,
      delta: input.delta,
      sourceRefs,
      acceptedAt,
      authorityWatermark: ownerWatermark,
    });
    return withTransaction(this.pool, async (client) => {
      const claim = await claimIdempotency(client, {
        scope: "memory.dream_delta",
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (claim.kind === "replay" || claim.kind === "terminal") {
        const response = claim.record.response as Record<string, unknown>;
        if (!response || stableJsonHash(response) !== claim.record.responseHash || typeof response.record !== "object" || response.record === null) throw new MemoryPersistenceError("IDEMPOTENCY_STATE_INVALID");
        return stableJsonClone(response.record) as AcceptedDreamDeltaRecord;
      }
      if (claim.kind === "in_flight") throw new MemoryPersistenceError("IDEMPOTENCY_IN_FLIGHT");
      const columns = refToColumns(ref);
      const existing = await client.query(
        `SELECT ${DELTA_COLUMNS} FROM memory_dream_deltas WHERE delta_ref_id = $1 AND delta_object_version = $2 AND delta_payload_sha256 = $3 FOR UPDATE`,
        [columns.ref_id, columns.object_version, columns.canonical_payload_sha256],
      );
      let row = existing.rows[0];
      if (row === undefined) {
        const authorityWatermark = await this.nextWatermark(client);
        const inserted = await client.query(
          [
            "INSERT INTO memory_dream_deltas (delta_ref, delta_ref_type, delta_ref_id, delta_object_version, delta_payload_sha256, user_id, accepted, delta, source_refs, accepted_at, authority_watermark)",
            "VALUES ($1::jsonb, $2, $3, $4, $5, $6, TRUE, $7::jsonb, $8::jsonb, $9::timestamptz, $10::jsonb)",
            "ON CONFLICT (delta_ref_id, delta_object_version, delta_payload_sha256) DO NOTHING RETURNING " + DELTA_COLUMNS,
          ].join(" "),
          [stableJsonText(ref), columns.ref_type, columns.ref_id, columns.object_version, columns.canonical_payload_sha256, input.userId, stableJsonText(input.delta), stableJsonText(sourceRefs), acceptedAt, stableJsonText(authorityWatermark)],
        );
        row = inserted.rows[0] ?? (await client.query(
          `SELECT ${DELTA_COLUMNS} FROM memory_dream_deltas WHERE delta_ref_id = $1 AND delta_object_version = $2 AND delta_payload_sha256 = $3 FOR UPDATE`,
          [columns.ref_id, columns.object_version, columns.canonical_payload_sha256],
        )).rows[0];
      }
      if (row === undefined) throw new MemoryPersistenceError("DELTA_NOT_FOUND");
      const stored = parseDeltaRow(row as Record<string, unknown>);
      if (stored.userId !== input.userId || !stableJsonEqual(stored.delta, input.delta) || !stableJsonEqual(stored.sourceRefs, sourceRefs) || stored.acceptedAt !== acceptedAt) {
        throw new MemoryPersistenceError("IDEMPOTENCY_CONFLICT");
      }
      const authorityWatermark = assertAuthorityWatermark((row as Record<string, unknown>).authority_watermark);
      const response = Object.freeze({ record: stored, authorityWatermark });
      await completeIdempotency(client, { scope: "memory.dream_delta", idempotencyKey: input.idempotencyKey, requestHash }, response, stableJsonHash(response));
      await enqueueOutboxEvent(client, {
        eventId: deterministicUuid(input.idempotencyKey),
        aggregateType: "memory_dream_delta",
        aggregateId: columns.ref_id,
        eventType: "memory.dream_delta.accepted",
        eventVersion: 1,
        idempotencyScope: "memory.outbox",
        idempotencyKey: input.idempotencyKey,
        payload: { ref, authorityWatermark },
        payloadHash: stableJsonHash({ ref, authorityWatermark }),
      });
      return stored;
    });
  }

  appendAcceptedDreamDelta(input: AcceptedDreamDeltaWriteInput): Promise<AcceptedDreamDeltaRecord> {
    return this.writeAcceptedDreamDelta(input);
  }

  private async nextWatermark(client: PoolClient): Promise<MemoryAuthorityWatermark> {
    const result = await client.query("SELECT watermark FROM memory_authority_clock WHERE clock_id = TRUE FOR UPDATE");
    if (result.rows.length !== 1) throw new MemoryPersistenceError("AUTHORITY_CLOCK_MISSING");
    const next = incrementDecimal(String(result.rows[0]!.watermark));
    await client.query("UPDATE memory_authority_clock SET watermark = $1, updated_at = now() WHERE clock_id = TRUE", [next]);
    return watermarkFromEpoch(next);
  }
}

export function createMemoryDreamDeltaRepository(pool: Pool): MemoryDreamDeltaRepository {
  return new MemoryDreamDeltaRepository(pool);
}
