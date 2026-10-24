import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import type { TransportDisconnectionPort } from "../../realtime-core/src/ports.ts";
import {
  createRealtimeTerminalFactDisconnectionProvider,
  RealtimeTerminalFactReaderError,
} from "../src/realtime-terminal-fact-reader.ts";

const HASH = "a".repeat(64);
const SESSION_ID = "01952f00-0000-7000-8000-000000000801";
const LEASE_ID = "01952f00-0000-7000-8000-000000000802";
const USER_ID = "01952f00-0000-7000-8000-000000000803";
const DEVICE_ID = "01952f00-0000-7000-8000-000000000804";
const CONTINUITY_ID = "01952f00-0000-7000-8000-000000000805";
const OCCURRED_AT = "2026-08-28T09:00:00.123Z";
const DISCONNECTED_AT = "2026-08-28T08:59:59.123Z";
const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession", ref_id: SESSION_ID, object_version: "1", canonical_payload_sha256: HASH,
});
const LEASE_REF = Object.freeze({
  ref_type: "DeviceLease", ref_id: LEASE_ID, object_version: "1", canonical_payload_sha256: HASH,
});
const BINDING = Object.freeze({
  state: "connected",
  realtimeSessionRef: SESSION_REF,
  deviceLeaseRef: LEASE_REF,
  continuityId: CONTINUITY_ID,
  deviceId: DEVICE_ID,
  connectionEpoch: "3",
  provider: Object.freeze({ provider: "livekit", value: "provider-801" }),
  transportSessionAlias: Object.freeze({ provider: "livekit", value: "session-801" }),
  roomAlias: Object.freeze({ provider: "livekit", value: "room-801" }),
  deviceAlias: Object.freeze({ provider: "livekit", value: "participant-801" }),
  connectionId: "connection-801",
});
const GOVERNANCE = Object.freeze({ policy: "owner-verified", version: 1 });

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function queryResult(rows: readonly QueryResultRow[] = []): QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: [...rows] } as QueryResult;
}

interface Fixture {
  readonly proof: Record<string, unknown>;
  readonly fact: QueryResultRow;
  readonly aliases: QueryResultRow[];
}

function fixture(): Fixture {
  const proof = { kind: "durable-owner-proof", receipt: "receipt-801", nested: { closed: true } };
  const requestFingerprint = "terminal-fact-reader-request-801";
  const requestHash = hash(requestFingerprint);
  const fact: QueryResultRow = {
    terminal_fact_id: "01952f00-0000-7000-8000-000000000806",
    operation: "media_stop",
    status: "success",
    request_scope: "realtime.transport.disconnection",
    idempotency_key: "terminal-fact-reader-801",
    request_hash: requestHash,
    session_ref_id: SESSION_ID,
    lease_ref_id: LEASE_ID,
    continuity_id: CONTINUITY_ID,
    connection_epoch: "3",
    realtime_session_ref: SESSION_REF,
    device_lease_ref: LEASE_REF,
    created_at: DISCONNECTED_AT,
    session_authority_ref: SESSION_REF,
    session_object_version: "1",
    session_payload_sha256: HASH,
    session_user_id: USER_ID,
    session_continuity_id: CONTINUITY_ID,
    session_device_id: DEVICE_ID,
    session_binding: BINDING,
    lease_authority_ref: LEASE_REF,
    lease_object_version: "1",
    lease_payload_sha256: HASH,
    lease_session_ref: SESSION_REF,
    lease_user_id: USER_ID,
    lease_device_id: DEVICE_ID,
    lease_continuity_id: CONTINUITY_ID,
  };
  fact.operation_outcome = {
    kind: "realtime.transport.disconnection.authority.v1",
    verified: true,
    disconnectedAt: DISCONNECTED_AT,
    verifiedForOccurredAt: OCCURRED_AT,
    authorityProof: proof,
    requestScope: fact.request_scope,
    idempotencyKey: fact.idempotency_key,
    requestFingerprint,
    requestHash,
    realtimeSessionRef: SESSION_REF,
    deviceLeaseRef: LEASE_REF,
    continuityId: CONTINUITY_ID,
    connectionEpoch: "3",
    userId: USER_ID,
    deviceId: DEVICE_ID,
    governanceSha256: hash(GOVERNANCE),
  };
  fact.execution_facts = {
    kind: "realtime.transport.disconnection.execution.v1",
    transportState: "disconnected",
    authorityProofSha256: hash(proof),
    realtimeSessionRef: SESSION_REF,
    deviceLeaseRef: LEASE_REF,
    continuityId: CONTINUITY_ID,
    connectionEpoch: "3",
    userId: USER_ID,
    deviceId: DEVICE_ID,
  };
  const aliases = [
    { alias_kind: "livekit_participant", alias_value: "participant-801", active: false },
    { alias_kind: "livekit_room", alias_value: "room-801", active: true },
    { alias_kind: "livekit_session", alias_value: "session-801", active: false },
    { alias_kind: "provider_alias", alias_value: "provider-801", active: true },
  ];
  return { proof, fact, aliases };
}

class ScriptedClient {
  readonly facts: QueryResultRow[];
  readonly aliases: QueryResultRow[];
  readonly queries: string[] = [];
  released = false;

  constructor(facts: QueryResultRow[], aliases: QueryResultRow[]) {
    this.facts = facts;
    this.aliases = aliases;
  }

  async query(text: string | { readonly text?: string }): Promise<QueryResult> {
    const sql = typeof text === "string" ? text : text.text ?? "";
    this.queries.push(sql);
    if (/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/iu.test(sql)) {
      throw new Error("MUTATING_SQL_FORBIDDEN");
    }
    if (sql === "BEGIN" || sql.startsWith("SET TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") {
      return queryResult();
    }
    if (sql.includes("FROM realtime_terminal_facts")) return queryResult(this.facts);
    if (sql.includes("FROM realtime_transport_aliases")) return queryResult(this.aliases);
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  }

  release(): void { this.released = true; }
}

class BorrowedPool {
  readonly client: ScriptedClient;
  endCalls = 0;

  constructor(client: ScriptedClient) { this.client = client; }
  async connect(): Promise<PoolClient> { return this.client as unknown as PoolClient; }
  async end(): Promise<void> { this.endCalls += 1; }
}

function input(): Parameters<TransportDisconnectionPort["verify"]>[0] {
  return {
    binding: BINDING as unknown as Parameters<TransportDisconnectionPort["verify"]>[0]["binding"],
    userId: USER_ID as Parameters<TransportDisconnectionPort["verify"]>[0]["userId"],
    deviceId: DEVICE_ID as Parameters<TransportDisconnectionPort["verify"]>[0]["deviceId"],
    occurredAt: OCCURRED_AT as Parameters<TransportDisconnectionPort["verify"]>[0]["occurredAt"],
    governance: GOVERNANCE,
  };
}

async function rejection(
  mutate: (value: Fixture) => void,
  code: string,
): Promise<void> {
  const value = fixture();
  mutate(value);
  const client = new ScriptedClient([value.fact], value.aliases);
  const provider = createRealtimeTerminalFactDisconnectionProvider(new BorrowedPool(client) as unknown as Pool);
  await assert.rejects(
    provider.verify(input()),
    (error: unknown) => error instanceof RealtimeTerminalFactReaderError && error.code === code,
  );
}

test("returns the exact durable authority proof from one stable read-only snapshot", async () => {
  const value = fixture();
  const client = new ScriptedClient([value.fact], value.aliases);
  const pool = new BorrowedPool(client);
  const provider = createRealtimeTerminalFactDisconnectionProvider(pool as unknown as Pool);
  const result = await provider.verify(input());
  assert.equal(result.verified, true);
  assert.equal(result.disconnectedAt, DISCONNECTED_AT);
  assert.strictEqual(result.authorityProof, value.proof);
  assert.ok(client.queries.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.equal(client.queries.some((sql) => /FOR\s+(?:SHARE|UPDATE)/iu.test(sql)), false);
  assert.equal(client.queries.some((sql) => /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/iu.test(sql)), false);
  assert.equal(pool.endCalls, 0);
  assert.equal(client.released, true);
});

test("missing fact fails closed", async () => {
  const client = new ScriptedClient([], fixture().aliases);
  const provider = createRealtimeTerminalFactDisconnectionProvider(new BorrowedPool(client) as unknown as Pool);
  await assert.rejects(provider.verify(input()), (error: unknown) =>
    error instanceof RealtimeTerminalFactReaderError && error.code === "TERMINAL_FACT_NOT_FOUND");
});

test("duplicate facts fail closed", async () => {
  const value = fixture();
  const provider = createRealtimeTerminalFactDisconnectionProvider(
    new BorrowedPool(new ScriptedClient([value.fact, { ...value.fact }], value.aliases)) as unknown as Pool,
  );
  await assert.rejects(provider.verify(input()), (error: unknown) =>
    error instanceof RealtimeTerminalFactReaderError && error.code === "TERMINAL_FACT_DUPLICATE");
});

test("wrong operation and status fail closed", async () => {
  await rejection((value) => { value.fact.operation = "bootstrap"; }, "TERMINAL_FACT_OPERATION_STATUS_INVALID");
  await rejection((value) => { value.fact.status = "error"; }, "TERMINAL_FACT_OPERATION_STATUS_INVALID");
});

test("canonical ref, lease, continuity and epoch drift fail closed", async () => {
  await rejection((value) => { value.fact.realtime_session_ref = { ...SESSION_REF, ref_id: "01952f00-0000-7000-8000-000000000899" }; }, "TERMINAL_FACT_BINDING_DRIFT");
  await rejection((value) => { value.fact.lease_ref_id = "01952f00-0000-7000-8000-000000000899"; }, "TERMINAL_FACT_BINDING_DRIFT");
  await rejection((value) => { value.fact.continuity_id = "01952f00-0000-7000-8000-000000000899"; }, "TERMINAL_FACT_BINDING_DRIFT");
  await rejection((value) => { value.fact.connection_epoch = "4"; }, "TERMINAL_FACT_BINDING_DRIFT");
});

test("alias binding drift and malformed aliases fail closed", async () => {
  await rejection((value) => { value.aliases[0]!.alias_value = "other-participant"; }, "TERMINAL_FACT_ALIAS_BINDING_DRIFT");
  await rejection((value) => { value.aliases[0]!.active = "yes"; }, "TERMINAL_FACT_ALIAS_MALFORMED");
});

test("request scope, key and hash drift fail closed", async () => {
  await rejection((value) => { value.fact.request_scope = "other-scope"; }, "TERMINAL_FACT_OUTCOME_BINDING_DRIFT");
  await rejection((value) => { value.fact.idempotency_key = "other-key"; }, "TERMINAL_FACT_OUTCOME_BINDING_DRIFT");
  await rejection((value) => { value.fact.request_hash = "b".repeat(64); }, "TERMINAL_FACT_OUTCOME_BINDING_DRIFT");
});

test("owner and execution binding drift fail closed", async () => {
  await rejection((value) => { value.fact.session_user_id = "01952f00-0000-7000-8000-000000000899"; }, "TERMINAL_FACT_OWNER_BINDING_DRIFT");
  await rejection((value) => { (value.fact.operation_outcome as Record<string, unknown>).deviceId = "other-device"; }, "TERMINAL_FACT_OUTCOME_BINDING_DRIFT");
  await rejection((value) => { (value.fact.execution_facts as Record<string, unknown>).authorityProofSha256 = "b".repeat(64); }, "TERMINAL_FACT_EXECUTION_BINDING_DRIFT");
});

test("authority proof missing or malformed fails closed", async () => {
  await rejection((value) => { delete (value.fact.operation_outcome as Record<string, unknown>).authorityProof; }, "TERMINAL_FACT_OUTCOME_INVALID");
  await rejection((value) => {
    Object.defineProperty(value.fact.operation_outcome as object, "authorityProof", { enumerable: true, get: () => "unsafe" });
  }, "TERMINAL_FACT_OUTCOME_INVALID");
});
