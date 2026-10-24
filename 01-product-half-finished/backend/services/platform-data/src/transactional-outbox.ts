import type { PoolClient, QueryResultRow } from "pg";
import { isManagedTransactionClient } from "./transaction.ts";

export interface OutboxEventInput {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly availableAt?: Date;
}

export interface OutboxEventRecord {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly status: "pending" | "claimed" | "published" | "failed";
  readonly attemptCount: number;
  readonly claimedBy?: string;
}

export type OutboxEnqueueResult =
  | { readonly kind: "queued"; readonly event: OutboxEventRecord }
  | { readonly kind: "replayed"; readonly event: OutboxEventRecord };

export class OutboxConflictError extends Error {
  readonly code = "OUTBOX_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("OUTBOX_IDEMPOTENCY_CONFLICT");
    this.name = "OutboxConflictError";
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function cloneStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("unstable JSON value");
    return value;
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("unstable JSON value");
  if (seen.has(value)) throw new TypeError("cyclic JSON value");
  seen.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const enumerable = new Set(Object.keys(value));
    for (const name of names) {
      if (name === "length") continue;
      const index = Number(name);
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name ||
          index >= value.length || !enumerable.has(name) || descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw new TypeError("unsafe JSON array");
      }
    }
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("sparse JSON array");
      copy.push(cloneStableJson(value[index], seen));
    }
    seen.delete(value);
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non-plain JSON object");
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) throw new TypeError("symbol JSON key");
  const names = Object.getOwnPropertyNames(value);
  const enumerable = new Set(Object.keys(value));
  if (names.some((name) => !enumerable.has(name))) throw new TypeError("non-enumerable JSON key");
  const copy: Record<string, unknown> = {};
  for (const name of [...enumerable].sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) throw new TypeError("accessor JSON key");
    Object.defineProperty(copy, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneStableJson((value as Record<string, unknown>)[name], seen),
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function jsonText(value: unknown): string {
  return JSON.stringify(cloneStableJson(value));
}

function validate(input: OutboxEventInput): void {
  if (!input || !UUID.test(input.eventId) || !UUID.test(input.aggregateId)) {
    throw new TypeError("invalid outbox identity");
  }
  if (typeof input.aggregateType !== "string" || input.aggregateType.length === 0 ||
      typeof input.eventType !== "string" || input.eventType.length === 0) {
    throw new TypeError("invalid outbox type");
  }
  if (!Number.isSafeInteger(input.eventVersion) || input.eventVersion < 1) {
    throw new TypeError("invalid outbox version");
  }
  if (typeof input.idempotencyScope !== "string" || input.idempotencyScope.length === 0 ||
      typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0 ||
      !HASH.test(input.payloadHash)) {
    throw new TypeError("invalid outbox idempotency");
  }
}

function fromRow(row: QueryResultRow): OutboxEventRecord {
  if (typeof row.event_id !== "string" || !UUID.test(row.event_id) ||
      typeof row.aggregate_id !== "string" || !UUID.test(row.aggregate_id) ||
      typeof row.aggregate_type !== "string" || row.aggregate_type.length === 0 ||
      typeof row.event_type !== "string" || row.event_type.length === 0 ||
      typeof row.idempotency_scope !== "string" || row.idempotency_scope.length === 0 ||
      typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0 ||
      typeof row.payload_sha256 !== "string" || !HASH.test(row.payload_sha256.trim())) {
    throw new TypeError("malformed outbox row");
  }
  const status = row.status;
  if (status !== "pending" && status !== "claimed" && status !== "published" && status !== "failed") {
    throw new TypeError("invalid outbox state");
  }
  const eventVersion = Number(row.event_version);
  const attemptCount = Number(row.attempt_count);
  if (!Number.isSafeInteger(eventVersion) || eventVersion < 1 ||
      !Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    throw new TypeError("malformed outbox row");
  }
  return Object.freeze({
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    payload: cloneStableJson(row.payload),
    payloadHash: String(row.payload_sha256).trim(),
    status,
    attemptCount,
    ...(row.claimed_by === null || row.claimed_by === undefined ? {} : { claimedBy: String(row.claimed_by) }),
  });
}

const EVENT_COLUMNS = [
  "event_id, aggregate_type, aggregate_id, event_type, event_version,",
  "idempotency_scope, idempotency_key, payload, payload_sha256, status,",
  "attempt_count, claimed_by",
].join(" ");

export async function enqueueOutboxEvent(
  client: PoolClient,
  input: OutboxEventInput,
): Promise<OutboxEnqueueResult> {
  validate(input);
  const inserted = await client.query(
    [
      "INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, event_type, event_version,",
      "idempotency_scope, idempotency_key, payload, payload_sha256, available_at, created_at, updated_at)",
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, COALESCE($10, now()), now(), now())",
      "ON CONFLICT (idempotency_scope, idempotency_key, event_type) DO NOTHING",
      "RETURNING " + EVENT_COLUMNS,
    ].join(" "),
    [
      input.eventId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.eventVersion,
      input.idempotencyScope,
      input.idempotencyKey,
      jsonText(input.payload),
      input.payloadHash,
      input.availableAt ?? null,
    ],
  );
  if (inserted.rows.length === 1) return { kind: "queued", event: fromRow(inserted.rows[0]!) };
  const existing = await client.query(
    [
      "SELECT " + EVENT_COLUMNS,
      "FROM outbox_events WHERE idempotency_scope = $1 AND idempotency_key = $2 AND event_type = $3",
      "FOR UPDATE",
    ].join(" "),
    [input.idempotencyScope, input.idempotencyKey, input.eventType],
  );
  if (existing.rows.length !== 1) throw new OutboxConflictError();
  const event = fromRow(existing.rows[0]!);
  if (event.payloadHash !== input.payloadHash || event.eventVersion !== input.eventVersion ||
      event.eventId !== input.eventId || event.aggregateType !== input.aggregateType ||
      event.aggregateId !== input.aggregateId || jsonText(event.payload) !== jsonText(input.payload)) {
    throw new OutboxConflictError();
  }
  return { kind: "replayed", event };
}

export async function claimOutboxBatch(
  client: PoolClient,
  consumerName: string,
  limit: number,
): Promise<readonly OutboxEventRecord[]> {
  if (typeof consumerName !== "string" || consumerName.length === 0 || consumerName.length > 256) {
    throw new TypeError("invalid outbox consumer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("invalid outbox limit");
  const result = await client.query(
    [
      "WITH candidates AS (",
      "SELECT event_id FROM outbox_events",
      "WHERE available_at <= now() AND (status = 'pending' OR status = 'failed'",
      "OR (status = 'claimed' AND claimed_at < now() - interval '5 minutes'))",
      "ORDER BY created_at, event_id FOR UPDATE SKIP LOCKED LIMIT $2",
      ")",
      "UPDATE outbox_events AS event",
      "SET status = 'claimed', claimed_by = $1, claimed_at = now(),",
      "attempt_count = event.attempt_count + 1, updated_at = now()",
      "FROM candidates WHERE event.event_id = candidates.event_id",
      "RETURNING " + EVENT_COLUMNS,
    ].join(" "),
    [consumerName, limit],
  );
  return Object.freeze(result.rows.map(fromRow));
}

export async function markOutboxPublished(
  client: PoolClient,
  eventId: string,
  consumerName: string,
): Promise<boolean> {
  if (!UUID.test(eventId) || typeof consumerName !== "string" || consumerName.length === 0) {
    throw new TypeError("invalid outbox claim");
  }
  const result = await client.query(
    [
      "UPDATE outbox_events SET status = 'published', published_at = now(),",
      "updated_at = now() WHERE event_id = $1 AND status = 'claimed' AND claimed_by = $2",
    ].join(" "),
    [eventId, consumerName],
  );
  return result.rowCount === 1;
}

export async function markOutboxFailed(
  client: PoolClient,
  eventId: string,
  consumerName: string,
  errorCode: string,
  availableAt: Date,
): Promise<boolean> {
  if (!UUID.test(eventId) || typeof consumerName !== "string" || consumerName.length === 0 ||
      typeof errorCode !== "string" || errorCode.length === 0 || !(availableAt instanceof Date)) {
    throw new TypeError("invalid outbox failure");
  }
  const result = await client.query(
    [
      "UPDATE outbox_events SET status = 'failed', claimed_by = NULL, claimed_at = NULL,",
      "last_error_code = $3, available_at = $4, updated_at = now()",
      "WHERE event_id = $1 AND status = 'claimed' AND claimed_by = $2",
    ].join(" "),
    [eventId, consumerName, errorCode, availableAt],
  );
  return result.rowCount === 1;
}

export async function consumeOutboxOnce(
  client: PoolClient,
  consumerName: string,
  event: OutboxEventRecord,
  handler: (event: OutboxEventRecord) => Promise<void>,
): Promise<boolean> {
  if (typeof consumerName !== "string" || consumerName.length === 0 ||
      !event || typeof handler !== "function") throw new TypeError("invalid outbox consumer input");
  if (!UUID.test(event.eventId) || !UUID.test(event.aggregateId) ||
      typeof event.aggregateType !== "string" || event.aggregateType.length === 0 ||
      typeof event.eventType !== "string" || event.eventType.length === 0 ||
      !Number.isSafeInteger(event.eventVersion) || event.eventVersion < 1 ||
      typeof event.idempotencyScope !== "string" || event.idempotencyScope.length === 0 ||
      typeof event.idempotencyKey !== "string" || event.idempotencyKey.length === 0 ||
      !HASH.test(event.payloadHash)) {
    throw new TypeError("malformed outbox event");
  }
  if (event.status !== "pending" && event.status !== "claimed" && event.status !== "published" && event.status !== "failed") {
    throw new TypeError("malformed outbox event");
  }
  if (!isManagedTransactionClient(client)) throw new TypeError("outbox consumer requires managed transaction");
  const safeEvent = Object.freeze({
    ...event,
    payload: cloneStableJson(event.payload),
  }) as OutboxEventRecord;
  const claimed = await client.query(
    [
      "INSERT INTO outbox_consumer_dedupe (consumer_name, event_id, payload_hash, processed_at)",
      "VALUES ($1, $2, $3, now()) ON CONFLICT (consumer_name, event_id) DO NOTHING",
      "RETURNING consumer_name",
    ].join(" "),
    [consumerName, event.eventId, event.payloadHash],
  );
  if (claimed.rows.length === 0) return false;
  await handler(safeEvent);
  return true;
}
