import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

export type IdempotencyStatus =
  | "in_flight"
  | "committed"
  | "failed"
  | "indeterminate";

export interface IdempotencyKeyInput {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly fencingEpoch?: string;
}

export interface IdempotencyRecord {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: IdempotencyStatus;
  readonly response: unknown;
  readonly responseHash?: string;
  readonly fencingEpoch?: string;
}

export type IdempotencyClaim =
  | { readonly kind: "new"; readonly record: IdempotencyRecord }
  | { readonly kind: "replay"; readonly record: IdempotencyRecord }
  | { readonly kind: "in_flight"; readonly record: IdempotencyRecord }
  | { readonly kind: "terminal"; readonly record: IdempotencyRecord };

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() {
    super("IDEMPOTENCY_CONFLICT");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyStateError extends Error {
  readonly code = "IDEMPOTENCY_STATE_INVALID";
  constructor() {
    super("IDEMPOTENCY_STATE_INVALID");
    this.name = "IdempotencyStateError";
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;

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

export function jsonText(value: unknown): string {
  return JSON.stringify(cloneStableJson(value));
}

export function jsonHash(value: unknown): string {
  return createHash("sha256").update(jsonText(value), "utf8").digest("hex");
}

function validateInput(input: IdempotencyKeyInput): void {
  if (!input || typeof input.scope !== "string" || input.scope.length === 0 || input.scope.length > 256) {
    throw new TypeError("invalid idempotency scope");
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256) {
    throw new TypeError("invalid idempotency key");
  }
  if (typeof input.requestHash !== "string" || !HASH.test(input.requestHash)) {
    throw new TypeError("invalid request hash");
  }
  if (input.fencingEpoch !== undefined && !DECIMAL.test(input.fencingEpoch)) {
    throw new TypeError("invalid fencing epoch");
  }
}

function textHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value.trim())) {
    throw new IdempotencyStateError();
  }
  return value.trim();
}

function recordFromRow(row: QueryResultRow): IdempotencyRecord {
  if (typeof row.scope !== "string" || row.scope.length === 0 || row.scope.length > 256 ||
      typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0 || row.idempotency_key.length > 256) {
    throw new IdempotencyStateError();
  }
  const status = row.status;
  if (status !== "in_flight" && status !== "committed" && status !== "failed" && status !== "indeterminate") {
    throw new IdempotencyStateError();
  }
  const responsePresent = row.response !== null && row.response !== undefined;
  const responseHash = row.response_hash === null || row.response_hash === undefined
    ? undefined
    : textHash(row.response_hash);
  const fencingEpoch = row.fencing_epoch === null || row.fencing_epoch === undefined
    ? undefined
    : String(row.fencing_epoch);
  if (fencingEpoch !== undefined && !DECIMAL.test(fencingEpoch)) throw new IdempotencyStateError();
  if (status !== "in_flight" && !responsePresent) throw new IdempotencyStateError();
  if (responsePresent !== (responseHash !== undefined)) throw new IdempotencyStateError();
  if (responsePresent && jsonHash(row.response) !== responseHash) throw new IdempotencyStateError();
  return Object.freeze({
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    requestHash: textHash(row.request_hash),
    status,
    response: row.response === undefined || row.response === null ? undefined : cloneStableJson(row.response),
    ...(responseHash === undefined ? {} : { responseHash }),
    ...(fencingEpoch === undefined ? {} : { fencingEpoch }),
  });
}

/** The live attempt that holds an in-flight claim: its token (stored as a hash) fences every terminal write, so a
 * recovered claim's straggler cannot overwrite the recoverer's result. */
export interface IdempotencyClaimOwner {
  readonly tokenSha256: string;
  readonly owner: string;
}

function validateOwner(claim: IdempotencyClaimOwner | undefined): void {
  if (claim === undefined) return;
  if (!HASH.test(claim.tokenSha256) || typeof claim.owner !== "string" || claim.owner.length === 0 || claim.owner.length > 256) {
    throw new TypeError("invalid idempotency claim owner");
  }
}

export async function claimIdempotency(
  client: PoolClient,
  input: IdempotencyKeyInput,
  claim?: IdempotencyClaimOwner,
): Promise<IdempotencyClaim> {
  validateInput(input);
  validateOwner(claim);
  const inserted = await client.query(
    [
      "INSERT INTO idempotency_ledger (",
      "scope, idempotency_key, request_hash, status, fencing_epoch,",
      "claim_token_sha256, claim_owner, claimed_at, created_at, updated_at",
      ") VALUES ($1, $2, $3, 'in_flight', $4, $5, $6, now(), now(), now())",
      "ON CONFLICT (scope, idempotency_key) DO NOTHING",
      "RETURNING scope, idempotency_key, request_hash, status, response,",
      "response_hash, fencing_epoch",
    ].join(" "),
    [input.scope, input.idempotencyKey, input.requestHash, input.fencingEpoch ?? null, claim?.tokenSha256 ?? null, claim?.owner ?? null],
  );
  if (inserted.rows.length === 1) {
    return {
      kind: "new",
      record: recordFromRow(inserted.rows[0]!),
    };
  }
  const existing = await client.query(
    [
      "SELECT scope, idempotency_key, request_hash, status, response,",
      "response_hash, fencing_epoch FROM idempotency_ledger",
      "WHERE scope = $1 AND idempotency_key = $2 FOR UPDATE",
    ].join(" "),
    [input.scope, input.idempotencyKey],
  );
  if (existing.rows.length !== 1) throw new IdempotencyStateError();
  const record = recordFromRow(existing.rows[0]!);
  if (record.requestHash !== input.requestHash) throw new IdempotencyConflictError();
  if (record.status === "committed") return { kind: "replay", record };
  if (record.status === "in_flight") return { kind: "in_flight", record };
  return { kind: "terminal", record };
}

/** All terminal states share the original hash, identity and first-claim checks. */
async function completeTerminal(
  client: PoolClient, input: IdempotencyKeyInput, response: unknown,
  responseHash: string, status: "committed" | "failed" | "indeterminate", claimTokenSha256?: string,
): Promise<IdempotencyRecord> {
  validateInput(input);
  if (!HASH.test(responseHash) || jsonHash(response) !== responseHash) throw new TypeError("invalid response hash");
  if (claimTokenSha256 !== undefined && !HASH.test(claimTokenSha256)) throw new TypeError("invalid claim token hash");
  const result = await client.query(
    [
      "UPDATE idempotency_ledger SET status = '" + status + "',",
      "response = $3::jsonb, response_hash = $4, completed_at = now(), updated_at = now()",
      "WHERE scope = $1 AND idempotency_key = $2 AND request_hash = $5 AND status = 'in_flight'",
      "AND ($6::text IS NULL OR claim_token_sha256 = $6)",
      "RETURNING scope, idempotency_key, request_hash, status, response, response_hash, fencing_epoch",
    ].join(" "),
    [input.scope, input.idempotencyKey, jsonText(response), responseHash, input.requestHash, claimTokenSha256 ?? null],
  );
  if (result.rows.length !== 1) throw new IdempotencyStateError();
  return recordFromRow(result.rows[0]!);
}
export function completeIdempotency(client:PoolClient,input:IdempotencyKeyInput,response:unknown,responseHash:string,claimTokenSha256?:string) {
  return completeTerminal(client,input,response,responseHash,"committed",claimTokenSha256);
}
export function completeIndeterminate(client:PoolClient,input:IdempotencyKeyInput,response:unknown,responseHash:string,claimTokenSha256?:string) {
  return completeTerminal(client,input,response,responseHash,"indeterminate",claimTokenSha256);
}
export function completeFailed(client:PoolClient,input:IdempotencyKeyInput,response:unknown,responseHash:string,claimTokenSha256?:string) {
  return completeTerminal(client,input,response,responseHash,"failed",claimTokenSha256);
}

/** Recovers an in-flight claim whose attempt is gone: the caller's own (it knows none of its attempts still runs it)
 * or one untouched for longer than any live attempt takes (e.g. its process died). The new token fences the old
 * attempt; the row keeps its key, request hash and any retained receipt. False when a live attempt still holds it. */
export async function takeOverInFlightClaim(client:PoolClient,input:IdempotencyKeyInput,claim:IdempotencyClaimOwner,staleSeconds:number):Promise<boolean> {
  validateInput(input);
  validateOwner(claim);
  if(!Number.isSafeInteger(staleSeconds)||staleSeconds<1)throw new TypeError('invalid stale claim window');
  const result=await client.query(
    "UPDATE idempotency_ledger SET claim_token_sha256=$4, claim_owner=$5, claimed_at=now(), updated_at=now() WHERE scope=$1 AND idempotency_key=$2 AND request_hash=$3 AND status='in_flight' AND (claim_owner=$5 OR claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $6)) RETURNING scope",
    [input.scope,input.idempotencyKey,input.requestHash,claim.tokenSha256,claim.owner,staleSeconds]);
  return result.rows.length===1;
}

/** Historical receipts are read without claiming or updating an operation. */
export async function readIdempotency(client: PoolClient, input: IdempotencyKeyInput): Promise<IdempotencyRecord | undefined> {
  validateInput(input);
  const found = await client.query("SELECT scope, idempotency_key, request_hash, status, response, response_hash, fencing_epoch FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2", [input.scope, input.idempotencyKey]);
  if (found.rows.length === 0) return undefined;
  const record = recordFromRow(found.rows[0]!);
  if (record.requestHash !== input.requestHash) throw new IdempotencyConflictError();
  return record;
}

/** Retry only the exact failed terminal approved by its business owner; retains its receipt while in flight. */
export async function restartFailedIdempotency(client:PoolClient,input:IdempotencyKeyInput,expectedResponseHash:string,from:'failed'|'indeterminate'='failed',claim?:IdempotencyClaimOwner):Promise<boolean> {
  validateInput(input);
  validateOwner(claim);
  if(!HASH.test(expectedResponseHash))throw new TypeError('invalid terminal response hash');
  if(from!=='failed'&&from!=='indeterminate')throw new TypeError('invalid restart status');
  const result=await client.query(
    "UPDATE idempotency_ledger SET status='in_flight', claim_token_sha256=$6, claim_owner=$7, claimed_at=now(), completed_at=NULL, updated_at=now() WHERE scope=$1 AND idempotency_key=$2 AND request_hash=$3 AND status=$5 AND response_hash=$4 RETURNING scope",
    [input.scope,input.idempotencyKey,input.requestHash,expectedResponseHash,from,claim?.tokenSha256??null,claim?.owner??null]);
  return result.rows.length===1;
}
