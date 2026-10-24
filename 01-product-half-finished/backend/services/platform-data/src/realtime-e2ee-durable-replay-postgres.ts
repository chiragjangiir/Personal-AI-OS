import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  claimIdempotency,
  completeIdempotency,
  IdempotencyConflictError,
  IdempotencyStateError,
} from "./idempotency-ledger.ts";
import { isPostgresTxOutcomeUncertain, withTransaction } from "./transaction.ts";

/** Internal structural copy of the Gateway replay seam. */
export type JsonPrimitive = null | string | boolean | number;
export type JsonRecord = Record<string, unknown>;

export const REALTIME_E2EE_DURABLE_REPLAY_SCOPE = "realtime.e2ee.ciphertext.v1" as const;

export type DurableReplayClaim =
  | { readonly disposition: "claimed"; readonly claimId: string }
  | { readonly disposition: "replay"; readonly response: JsonRecord }
  | { readonly disposition: "terminal"; readonly response: JsonRecord }
  | { readonly disposition: "conflict" };

export interface RealtimeE2eeDurableReplayPort {
  readonly claim: (input: {
    readonly request: JsonRecord;
    readonly idempotencyContext: JsonRecord;
    readonly fingerprint: string;
  }) => Promise<DurableReplayClaim>;
  readonly commit: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly response: JsonRecord;
  }) => Promise<void>;
  readonly release: (input: { readonly claimId: string; readonly fingerprint: string }) => Promise<void>;
  readonly abort: (input: { readonly claimId: string; readonly fingerprint: string }) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RealtimeE2eeDurableReplayPostgresOptions {
  readonly claimId?: () => string;
}

export class RealtimeE2eeDurableReplayError extends Error {
  readonly code: string;
  readonly outcomeUncertain: boolean;

  constructor(code: string, outcomeUncertain = false) {
    super(code);
    this.name = "RealtimeE2eeDurableReplayError";
    this.code = code;
    this.outcomeUncertain = outcomeUncertain;
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const CLAIM_ID = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;
const IDEMPOTENCY_KEY = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;
const MAX_CANONICAL_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 131_072;
const CLAIM_OWNER = "platform-data.realtime-e2ee-durable-replay";
const REQUEST_FORBIDDEN_KEYS = new Set([
  "privateKey", "private_key", "recipientPrivateKey", "recipient_private_key",
  "secret", "secretKey", "secret_key", "contentKey", "content_key", "keyMaterial",
  "key_material", "plaintext", "ciphertext", "encapsulated_key", "roomOptions", "room_options",
  "token", "bearer", "apiToken", "api_token", "participant_token", "credential_secret",
]);
const RESPONSE_FORBIDDEN_KEYS = new Set([
  "privateKey", "private_key", "recipientPrivateKey", "recipient_private_key",
  "secret", "secretKey", "secret_key", "contentKey", "content_key", "keyMaterial",
  "key_material", "plaintext", "roomOptions", "room_options", "token", "bearer",
  "apiToken", "api_token", "participant_token", "credential_secret",
]);
const SUCCESS_RESPONSE_KEYS = [
  "aad_sha256", "cipher_suite", "ciphertext", "connection_epoch", "continuity_id",
  "device_id", "device_lease_ref", "encapsulated_key", "governance", "idempotency_context",
  "key_envelope_ref", "key_generation", "key_index", "operation", "participant_audience",
  "recipient_device_credential_ref", "realtime_session_ref", "request_id", "status",
  "transport_aliases", "expires_at",
] as const;
const TERMINAL_RESPONSE_KEYS = [
  "connection_epoch", "continuity_id", "device_lease_ref", "execution_facts", "governance",
  "operation", "operation_outcome", "realtime_session_ref", "request_id", "status",
] as const;
const RESPONSE_BINDING_KEYS = [
  "idempotency_context", "realtime_session_ref", "device_lease_ref", "continuity_id",
  "connection_epoch", "transport_aliases", "key_envelope_ref", "key_index", "key_generation",
  "device_id", "recipient_device_credential_ref", "participant_audience", "governance",
] as const;
const TERMINAL_BINDING_KEYS = [
  "realtime_session_ref", "device_lease_ref", "continuity_id", "connection_epoch", "governance",
] as const;

function fail(code: string): never {
  throw new RealtimeE2eeDurableReplayError(code);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function canonicalClone(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
    return value;
  }
  if (typeof value !== "object" || value === undefined || typeof value === "function") {
    fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
  }
  if (seen.has(value)) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      const enumerable = new Set(Object.keys(value));
      for (const name of names) {
        if (name === "length") continue;
        const index = Number(name);
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name ||
            index >= value.length || !enumerable.has(name) || descriptor?.get !== undefined || descriptor?.set !== undefined) {
          fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
        }
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
        result.push(canonicalClone(value[index], seen));
      }
      return result;
    }
    if (!isPlainRecord(value)) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
    const names = Object.getOwnPropertyNames(value);
    const enumerable = new Set(Object.keys(value));
    if (names.some((name) => !enumerable.has(name))) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
    const result: JsonRecord = {};
    for (const name of [...enumerable].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
      result[name] = canonicalClone(value[name], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown, maxBytes = MAX_CANONICAL_BYTES): string {
  const result = JSON.stringify(canonicalClone(value));
  if (result === undefined || Buffer.byteLength(result, "utf8") > maxBytes) {
    fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
  }
  return result;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringValue(value: unknown, code: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern !== undefined && !pattern.test(value))) fail(code);
  return value;
}

function ownRecord(value: unknown, code: string): JsonRecord {
  if (!isPlainRecord(value)) fail(code);
  return value;
}

function assertNoForbiddenKeys(
  value: unknown,
  forbiddenKeys: ReadonlySet<string> = REQUEST_FORBIDDEN_KEYS,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail("REALTIME_E2EE_REPLAY_JSON_INVALID");
  seen.add(value);
  try {
    for (const key of Object.keys(value)) {
      if (forbiddenKeys.has(key)) fail("REALTIME_E2EE_REPLAY_INPUT_SECRET");
      assertNoForbiddenKeys((value as JsonRecord)[key], forbiddenKeys, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function normalizedFingerprint(value: unknown): { readonly text: string; readonly hash: string; readonly value: JsonRecord } {
  const fingerprint = stringValue(value, "REALTIME_E2EE_REPLAY_FINGERPRINT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint) as unknown;
  } catch {
    fail("REALTIME_E2EE_REPLAY_FINGERPRINT_INVALID");
  }
  if (!isPlainRecord(parsed)) fail("REALTIME_E2EE_REPLAY_FINGERPRINT_INVALID");
  const canonical = canonicalJson(parsed);
  if (canonical !== fingerprint) fail("REALTIME_E2EE_REPLAY_FINGERPRINT_INVALID");
  assertNoForbiddenKeys(parsed, REQUEST_FORBIDDEN_KEYS);
  return { text: canonical, hash: sha256Text(canonical), value: parsed };
}

function normalizeClaimInput(input: {
  readonly request: JsonRecord;
  readonly idempotencyContext: JsonRecord;
  readonly fingerprint: string;
}): { readonly request: JsonRecord; readonly key: string; readonly requestHash: string } {
  const request = ownRecord(input?.request, "REALTIME_E2EE_REPLAY_REQUEST_INVALID");
  const context = ownRecord(input?.idempotencyContext, "REALTIME_E2EE_REPLAY_IDEMPOTENCY_INVALID");
  const fingerprint = normalizedFingerprint(input?.fingerprint);
  if (canonicalJson(request) !== fingerprint.text) fail("REALTIME_E2EE_REPLAY_FINGERPRINT_INVALID");
  const key = stringValue(context.idempotency_key, "REALTIME_E2EE_REPLAY_IDEMPOTENCY_INVALID", IDEMPOTENCY_KEY);
  assertNoForbiddenKeys(context, REQUEST_FORBIDDEN_KEYS);
  return { request, key, requestHash: fingerprint.hash };
}

function responseKeys(value: JsonRecord): string[] {
  return Object.keys(value).sort();
}

function sameKeys(actual: JsonRecord, expected: readonly string[]): boolean {
  const keys = responseKeys(actual);
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function assertResponseBinding(response: JsonRecord, request: JsonRecord, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(request, key) || canonicalJson(response[key]) !== canonicalJson(request[key])) {
      fail("REALTIME_E2EE_REPLAY_RESPONSE_BINDING_INVALID");
    }
  }
}

function normalizeResponse(value: unknown, request: JsonRecord): { readonly value: JsonRecord; readonly hash: string } {
  const candidate = ownRecord(value, "REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
  assertNoForbiddenKeys(candidate, RESPONSE_FORBIDDEN_KEYS);
  const status = candidate.status;
  if (candidate.operation !== "realtime_e2ee_key_resolve" || typeof status !== "string") {
    fail("REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
  }
  if (status === "key_resolved") {
    if (!sameKeys(candidate, SUCCESS_RESPONSE_KEYS)) fail("REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
    assertResponseBinding(candidate, request, RESPONSE_BINDING_KEYS);
    if (typeof candidate.expires_at !== "string" || typeof candidate.cipher_suite !== "string" ||
        typeof candidate.encapsulated_key !== "string" || typeof candidate.ciphertext !== "string" ||
        typeof candidate.aad_sha256 !== "string" || candidate.encapsulated_key.length === 0 ||
        candidate.ciphertext.length === 0 || !HASH.test(candidate.aad_sha256)) {
      fail("REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
    }
  } else if (status === "expired" || status === "revoked" || status === "indeterminate") {
    if (!sameKeys(candidate, TERMINAL_RESPONSE_KEYS)) fail("REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
    assertResponseBinding(candidate, request, TERMINAL_BINDING_KEYS);
    if (!isPlainRecord(candidate.operation_outcome) || !isPlainRecord(candidate.execution_facts) ||
        typeof candidate.operation_outcome.outcome_class !== "string" ||
        typeof candidate.execution_facts.closure_status !== "string") {
      fail("REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
    }
  } else {
    fail("REALTIME_E2EE_REPLAY_RESPONSE_INVALID");
  }
  const text = canonicalJson(candidate, MAX_RESPONSE_BYTES);
  return { value: JSON.parse(text) as JsonRecord, hash: sha256Text(text) };
}

function normalizeCommitInput(input: {
  readonly claimId: string;
  readonly fingerprint: string;
  readonly response: JsonRecord;
}): { readonly claimId: string; readonly request: JsonRecord; readonly requestHash: string; readonly response: JsonRecord; readonly responseHash: string } {
  const claimId = stringValue(input?.claimId, "REALTIME_E2EE_REPLAY_CLAIM_ID_INVALID", CLAIM_ID);
  const fingerprint = normalizedFingerprint(input?.fingerprint);
  const normalized = normalizeResponse(input?.response, fingerprint.value);
  return { claimId, request: fingerprint.value, requestHash: fingerprint.hash, response: normalized.value, responseHash: normalized.hash };
}

function terminalResponse(request: JsonRecord): JsonRecord {
  const operation = request.operation;
  const requestId = stringValue(request.request_id, "REALTIME_E2EE_REPLAY_REQUEST_INVALID");
  const continuityId = request.continuity_id;
  const session = request.realtime_session_ref;
  const lease = request.device_lease_ref;
  const epoch = request.connection_epoch;
  const governance = request.governance;
  if (operation !== "realtime_e2ee_key_resolve" || continuityId === undefined || session === undefined ||
      lease === undefined || epoch === undefined || governance === undefined) {
    fail("REALTIME_E2EE_REPLAY_REQUEST_INVALID");
  }
  return Object.freeze({
    operation: "realtime_e2ee_key_resolve",
    status: "indeterminate",
    request_id: requestId,
    realtime_session_ref: JSON.parse(canonicalJson(session)) as JsonRecord,
    device_lease_ref: JSON.parse(canonicalJson(lease)) as JsonRecord,
    continuity_id: JSON.parse(canonicalJson(continuityId)) as string,
    connection_epoch: JSON.parse(canonicalJson(epoch)) as string,
    operation_outcome: Object.freeze({ outcome_class: "indeterminate" }),
    execution_facts: Object.freeze({ closure_status: "indeterminate" }),
    governance: JSON.parse(canonicalJson(governance)) as JsonRecord,
  });
}

function mapDatabaseError(error: unknown, defaultCode: string): never {
  if (error instanceof RealtimeE2eeDurableReplayError) throw error;
  if (error instanceof IdempotencyStateError) throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_STATE_INVALID");
  if (isPostgresTxOutcomeUncertain(error)) {
    throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_COMMIT_INDETERMINATE", true);
  }
  throw new RealtimeE2eeDurableReplayError(defaultCode);
}

export class RealtimeE2eeDurableReplayPostgres implements RealtimeE2eeDurableReplayPort {
  readonly #pool: Pool;
  readonly #claimId: () => string;
  #closed = false;

  constructor(pool: Pool, options: RealtimeE2eeDurableReplayPostgresOptions = {}) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    this.#pool = pool;
    this.#claimId = options.claimId ?? randomUUID;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_CLOSED");
  }

  async claim(input: {
    readonly request: JsonRecord;
    readonly idempotencyContext: JsonRecord;
    readonly fingerprint: string;
  }): Promise<DurableReplayClaim> {
    this.#assertOpen();
    const values = normalizeClaimInput(input);
    try {
      return await withTransaction(this.#pool, async (client) => {
        const claimed = await claimIdempotency(client, {
          scope: REALTIME_E2EE_DURABLE_REPLAY_SCOPE,
          idempotencyKey: values.key,
          requestHash: values.requestHash,
        });
        if (claimed.kind === "new") {
          const claimId = stringValue(this.#claimId(), "REALTIME_E2EE_REPLAY_CLAIM_ID_INVALID", CLAIM_ID);
          const claimTokenSha256 = sha256Text(claimId);
          const assigned = await client.query(
            [
              "UPDATE idempotency_ledger SET claim_token_sha256 = $3, claim_owner = $4,",
              "claimed_at = now(), updated_at = now()",
              "WHERE scope = $1 AND idempotency_key = $2 AND request_hash = $5",
              "AND status = 'in_flight' AND claim_token_sha256 IS NULL",
              "RETURNING idempotency_key",
            ].join(" "),
            [REALTIME_E2EE_DURABLE_REPLAY_SCOPE, values.key, claimTokenSha256, CLAIM_OWNER, values.requestHash],
          );
          if (assigned.rows.length !== 1) throw new IdempotencyStateError();
          return Object.freeze({ disposition: "claimed" as const, claimId });
        }

        if (claimed.kind === "replay" || claimed.kind === "terminal") {
          const normalized = normalizeResponse(claimed.record.response, values.request);
          if (claimed.record.responseHash !== normalized.hash) {
            throw new IdempotencyStateError();
          }
          return Object.freeze({
            disposition: (claimed.kind === "replay" ? "replay" : "terminal") as "replay" | "terminal",
            response: normalized.value,
          });
        }

        // A live claim cannot be taken over.  Return an indeterminate terminal
        // result; only the original owner may release it and make a retry legal.
        return Object.freeze({ disposition: "terminal" as const, response: terminalResponse(values.request) });
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return { disposition: "conflict" };
      return mapDatabaseError(error, "REALTIME_E2EE_REPLAY_UNAVAILABLE");
    }
  }

  async commit(input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly response: JsonRecord;
  }): Promise<void> {
    this.#assertOpen();
    const values = normalizeCommitInput(input);
    const claimTokenSha256 = sha256Text(values.claimId);
    try {
      await withTransaction(this.#pool, async (client) => {
        const row = await this.#rowByClaim(client, claimTokenSha256);
        if (row === undefined) throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_CLAIM_NOT_FOUND");
        if (row.status === "committed") {
          const oldResponse = normalizeResponse(row.response, values.request);
          if (row.responseHash !== oldResponse.hash || oldResponse.hash !== values.responseHash) {
            throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_RESPONSE_CONFLICT");
          }
          return;
        }
        if (row.status !== "in_flight" || row.requestHash !== values.requestHash) {
          throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_CLAIM_INVALID");
        }
        await completeIdempotency(
          client,
          {
            scope: REALTIME_E2EE_DURABLE_REPLAY_SCOPE,
            idempotencyKey: row.idempotencyKey,
            requestHash: values.requestHash,
          },
          values.response,
          values.responseHash,
        );
      });
    } catch (error) {
      return mapDatabaseError(error, "REALTIME_E2EE_REPLAY_COMMIT_FAILED");
    }
  }

  async release(input: { readonly claimId: string; readonly fingerprint: string }): Promise<void> {
    await this.#release(input);
  }

  async abort(input: { readonly claimId: string; readonly fingerprint: string }): Promise<void> {
    await this.#release(input);
  }

  async #release(input: { readonly claimId: string; readonly fingerprint: string }): Promise<void> {
    this.#assertOpen();
    const claimId = stringValue(input?.claimId, "REALTIME_E2EE_REPLAY_CLAIM_ID_INVALID", CLAIM_ID);
    const requestHash = normalizedFingerprint(input?.fingerprint).hash;
    const claimTokenSha256 = sha256Text(claimId);
    try {
      await withTransaction(this.#pool, async (client) => {
        const row = await this.#rowByClaim(client, claimTokenSha256);
        if (row === undefined || row.status === "committed") return;
        if (row.status !== "in_flight" || row.requestHash !== requestHash) {
          throw new RealtimeE2eeDurableReplayError("REALTIME_E2EE_REPLAY_CLAIM_INVALID");
        }
        await client.query(
          [
            "DELETE FROM idempotency_ledger",
            "WHERE scope = $1 AND idempotency_key = $2 AND request_hash = $3",
            "AND claim_token_sha256 = $4 AND status = 'in_flight'",
          ].join(" "),
          [REALTIME_E2EE_DURABLE_REPLAY_SCOPE, row.idempotencyKey, requestHash, claimTokenSha256],
        );
      });
    } catch (error) {
      return mapDatabaseError(error, "REALTIME_E2EE_REPLAY_RELEASE_FAILED");
    }
  }

  async #rowByClaim(client: PoolClient, claimTokenSha256: string): Promise<{
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly status: string;
    readonly response: unknown;
    readonly responseHash: string | null;
  } | undefined> {
    const result = await client.query(
      [
        "SELECT idempotency_key, request_hash, status, response, response_hash, claim_token_sha256",
        "FROM idempotency_ledger WHERE scope = $1 AND claim_token_sha256 = $2 FOR UPDATE",
      ].join(" "),
      [REALTIME_E2EE_DURABLE_REPLAY_SCOPE, claimTokenSha256],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new IdempotencyStateError();
    const row = result.rows[0]!;
    if (typeof row.idempotency_key !== "string" || typeof row.request_hash !== "string" ||
        !HASH.test(row.request_hash) || typeof row.status !== "string" ||
        (row.claim_token_sha256 !== null && row.claim_token_sha256 !== claimTokenSha256) ||
        (row.response_hash !== null && (typeof row.response_hash !== "string" || !HASH.test(row.response_hash)))) {
      throw new IdempotencyStateError();
    }
    return {
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      status: row.status,
      response: row.response,
      responseHash: row.response_hash === null ? null : row.response_hash,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export function createRealtimeE2eeDurableReplayPostgres(
  pool: Pool,
  options: RealtimeE2eeDurableReplayPostgresOptions = {},
): RealtimeE2eeDurableReplayPostgres {
  return new RealtimeE2eeDurableReplayPostgres(pool, options);
}
