import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "./transaction.ts";

export type CredentialFenceAdmissionClient = PoolClient;

export type CredentialFenceState = "in_flight" | "indeterminate" | "committed";

export type CredentialFenceCanonicalRef = Readonly<{
  readonly ref_type: "RealtimeSession" | "DeviceLease";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}>;

export type CredentialFenceTuple = Readonly<{
  readonly realtimeSessionRef: CredentialFenceCanonicalRef;
  readonly deviceLeaseRef: CredentialFenceCanonicalRef;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly credentialGeneration: string;
}>;

export type CredentialFenceSnapshot = Readonly<{
  readonly active: boolean;
  readonly effectState?: CredentialFenceState;
  readonly stageState?: unknown;
  readonly fencingEpoch?: string;
  readonly credentialGeneration?: string;
}>;

export class CredentialFenceError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "CredentialFenceError";
    this.code = code;
    this.retryable = retryable;
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const REF_KEYS = ["ref_type", "ref_id", "object_version", "canonical_payload_sha256"] as const;
const ACTIVE_STATES = Object.freeze(["in_flight", "indeterminate", "committed"] as const);
const FENCE_SCOPE = "realtime.external.media_stop";
const FENCE_LOCK_PREFIX = "paios.realtime.credential-fence:";

type PlainRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CredentialFenceError("CREDENTIAL_FENCE_JSON_INVALID");
    return value;
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) {
    throw new CredentialFenceError("CREDENTIAL_FENCE_JSON_INVALID");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneJson(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (!isPlainObject(value)) throw new CredentialFenceError("CREDENTIAL_FENCE_JSON_INVALID");
  const result: PlainRecord = {};
  for (const key of Object.keys(value).sort()) result[key] = cloneJson(value[key], seen);
  seen.delete(value);
  return Object.freeze(result);
}

function jsonText(value: unknown): string {
  return JSON.stringify(cloneJson(value));
}

function boundedString(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /\s/u.test(value)) {
    throw new CredentialFenceError(code);
  }
  return value;
}

function decimal(value: unknown, code: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new CredentialFenceError(code);
  return value;
}

function canonicalRef(value: unknown, expected: CredentialFenceCanonicalRef["ref_type"]): CredentialFenceCanonicalRef {
  if (!isPlainObject(value) || Object.keys(value).length !== REF_KEYS.length ||
      REF_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new CredentialFenceError("CREDENTIAL_FENCE_REF_INVALID");
  }
  if (value.ref_type !== expected || typeof value.ref_id !== "string" || !UUID_V7.test(value.ref_id) ||
      typeof value.object_version !== "string" || !DECIMAL.test(value.object_version) ||
      typeof value.canonical_payload_sha256 !== "string" || !HASH.test(value.canonical_payload_sha256)) {
    throw new CredentialFenceError("CREDENTIAL_FENCE_REF_INVALID");
  }
  return Object.freeze({
    ref_type: expected,
    ref_id: value.ref_id,
    object_version: value.object_version,
    canonical_payload_sha256: value.canonical_payload_sha256,
  });
}

export function normalizeCredentialFenceTuple(value: unknown): CredentialFenceTuple {
  if (!isPlainObject(value)) throw new CredentialFenceError("CREDENTIAL_FENCE_TUPLE_INVALID");
  const allowed = new Set([
    "realtimeSessionRef", "deviceLeaseRef", "continuityId", "connectionEpoch", "credentialGeneration",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      !Object.hasOwn(value, "realtimeSessionRef") || !Object.hasOwn(value, "deviceLeaseRef") ||
      !Object.hasOwn(value, "continuityId") || !Object.hasOwn(value, "connectionEpoch") ||
      !Object.hasOwn(value, "credentialGeneration")) {
    throw new CredentialFenceError("CREDENTIAL_FENCE_TUPLE_INVALID");
  }
  return Object.freeze({
    realtimeSessionRef: canonicalRef(value.realtimeSessionRef, "RealtimeSession"),
    deviceLeaseRef: canonicalRef(value.deviceLeaseRef, "DeviceLease"),
    continuityId: boundedString(value.continuityId, "CREDENTIAL_FENCE_CONTINUITY_INVALID"),
    connectionEpoch: decimal(value.connectionEpoch, "CREDENTIAL_FENCE_CONNECTION_EPOCH_INVALID"),
    credentialGeneration: decimal(value.credentialGeneration, "CREDENTIAL_FENCE_GENERATION_INVALID"),
  });
}

export function credentialFenceTupleText(value: CredentialFenceTuple): string {
  return jsonText(normalizeCredentialFenceTuple(value));
}

export function credentialFenceLockKey(value: CredentialFenceTuple): string {
  return FENCE_LOCK_PREFIX + credentialFenceTupleText(value);
}

function jsonParameter(value: unknown): string {
  return jsonText(value);
}

function activeSnapshot(row: QueryResultRow): CredentialFenceSnapshot {
  const effectState = row.effect_state;
  if (!ACTIVE_STATES.includes(effectState)) throw new CredentialFenceError("CREDENTIAL_FENCE_ROW_INVALID");
  const generation = String(row.credential_generation);
  if (!DECIMAL.test(generation)) throw new CredentialFenceError("CREDENTIAL_FENCE_ROW_INVALID");
  return Object.freeze({
    active: true,
    effectState,
    stageState: cloneJson(row.stage_state),
    fencingEpoch: decimal(String(row.fencing_epoch), "CREDENTIAL_FENCE_ROW_INVALID"),
    credentialGeneration: generation,
  });
}

export interface CredentialFencePort {
  /** Serializes claim/install/admission work for one canonical tuple. */
  readonly lock: (client: PoolClient, tuple: CredentialFenceTuple) => Promise<void>;
  /** Takes the tuple lock and rejects another active fence in the same transaction. */
  readonly install: (client: PoolClient, tuple: CredentialFenceTuple) => Promise<void>;
  /** Serializes against claim/install and reports the active fence, if any. */
  readonly verify: (tuple: CredentialFenceTuple) => Promise<CredentialFenceSnapshot>;
  /** A read-only replay/verification seam for callers that retry admission. */
  readonly replay: (tuple: CredentialFenceTuple) => Promise<CredentialFenceSnapshot>;
  /** Holds the tuple lock through the bounded credential/participant admission callback. */
  readonly withAdmission: <T>(tuple: CredentialFenceTuple, callback: (client?: PoolClient) => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export class RealtimeCredentialFence implements CredentialFencePort {
  readonly #pool: Pool;
  #closed = false;

  constructor(pool: Pool) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    this.#pool = pool;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CredentialFenceError("CREDENTIAL_FENCE_CLOSED");
  }

  async lock(client: PoolClient, tupleInput: CredentialFenceTuple): Promise<void> {
    this.#assertOpen();
    if (!client || typeof client.query !== "function") throw new TypeError("transaction client is required");
    const tuple = normalizeCredentialFenceTuple(tupleInput);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [credentialFenceLockKey(tuple)],
    );
  }

  async #readActive(client: PoolClient, tuple: CredentialFenceTuple): Promise<CredentialFenceSnapshot> {
    const result = await client.query(
      [
        "SELECT effect_state, stage_state, fencing_epoch::text AS fencing_epoch,",
        "credential_generation::text AS credential_generation",
        "FROM public.realtime_external_effects",
        "WHERE operation = 'media_stop' AND request_scope = $1",
        "AND realtime_session_ref = $2::jsonb AND device_lease_ref = $3::jsonb",
        "AND continuity_id = $4 AND connection_epoch = $5::numeric",
        "AND credential_generation = $6::numeric",
        "AND effect_state IN ('in_flight', 'indeterminate', 'committed')",
        "LIMIT 2 FOR SHARE",
      ].join(" "),
      [
        FENCE_SCOPE,
        jsonParameter(tuple.realtimeSessionRef),
        jsonParameter(tuple.deviceLeaseRef),
        tuple.continuityId,
        tuple.connectionEpoch,
        tuple.credentialGeneration,
      ],
    );
    if (result.rows.length > 1) throw new CredentialFenceError("CREDENTIAL_FENCE_MULTIPLE_ACTIVE");
    return result.rows.length === 0
      ? Object.freeze({ active: false })
      : activeSnapshot(result.rows[0]!);
  }

  async install(client: PoolClient, tupleInput: CredentialFenceTuple): Promise<void> {
    this.#assertOpen();
    if (!client || typeof client.query !== "function") throw new TypeError("transaction client is required");
    const tuple = normalizeCredentialFenceTuple(tupleInput);
    await this.lock(client, tuple);
    const active = await this.#readActive(client, tuple);
    if (active.active) throw new CredentialFenceError("CREDENTIAL_FENCE_ACTIVE");
  }

  async verify(tupleInput: CredentialFenceTuple): Promise<CredentialFenceSnapshot> {
    this.#assertOpen();
    const tuple = normalizeCredentialFenceTuple(tupleInput);
    return withTransaction(this.#pool, async (client) => {
      await this.lock(client, tuple);
      return this.#readActive(client, tuple);
    });
  }

  async replay(tuple: CredentialFenceTuple): Promise<CredentialFenceSnapshot> {
    return this.verify(tuple);
  }

  async withAdmission<T>(tupleInput: CredentialFenceTuple, callback: (client?: PoolClient) => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (typeof callback !== "function") throw new TypeError("admission callback is required");
    const tuple = normalizeCredentialFenceTuple(tupleInput);
    return withTransaction(this.#pool, async (client) => {
      await this.lock(client, tuple);
      const active = await this.#readActive(client, tuple);
      if (active.active) throw new CredentialFenceError("CREDENTIAL_FENCE_ACTIVE");
      return callback(client);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export function createRealtimeCredentialFence(pool: Pool): RealtimeCredentialFence {
  return new RealtimeCredentialFence(pool);
}

export const REALTIME_CREDENTIAL_FENCE_SCOPE = FENCE_SCOPE;
export const REALTIME_CREDENTIAL_FENCE_ACTIVE_STATES = ACTIVE_STATES;
