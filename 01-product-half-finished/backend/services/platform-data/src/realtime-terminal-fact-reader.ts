import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  TransportDisconnectionPort,
  VerifiedTransportDisconnection,
} from "../../realtime-core/src/ports.ts";
import type {
  OpaqueGovernanceValue,
  RealtimeTransportBinding,
} from "../../realtime-core/src/types.ts";
import { withTransaction } from "./transaction.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const UTC = /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.(?:[0-9]{3}|[0-9]{6})Z$/u;
const OPERATIONS = new Set(["fully_disconnected_refresh", "media_stop", "end_continuity", "handoff", "lease_release"]);
const ALIAS_KINDS = Object.freeze([
  ["provider", "provider_alias"],
  ["transportSessionAlias", "livekit_session"],
  ["roomAlias", "livekit_room"],
  ["deviceAlias", "livekit_participant"],
] as const);

type PlainRecord = Record<string, unknown>;

export class RealtimeTerminalFactReaderError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "RealtimeTerminalFactReaderError";
    this.code = code;
  }
}

export interface RealtimeTerminalFactDisconnectionProvider extends TransportDisconnectionPort {}

function fail(code: string, cause?: unknown): never {
  throw new RealtimeTerminalFactReaderError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  return value;
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) fail(code);
  return value;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("TERMINAL_FACT_OPAQUE_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) fail("TERMINAL_FACT_OPAQUE_VALUE_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("TERMINAL_FACT_OPAQUE_VALUE_INVALID");
        output.push(canonicalJson(value[index], seen));
      }
      return `[${output.join(",")}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail("TERMINAL_FACT_OPAQUE_VALUE_INVALID");
    const output: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        fail("TERMINAL_FACT_OPAQUE_VALUE_INVALID");
      }
      output.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`);
    }
    return `{${output.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

interface SnakeRef {
  readonly ref_type: "RealtimeSession" | "DeviceLease";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

function canonicalRef(value: unknown, expectedType: SnakeRef["ref_type"]): SnakeRef {
  const record = exactRecord(
    value,
    ["ref_type", "ref_id", "object_version", "canonical_payload_sha256"],
    "TERMINAL_FACT_CANONICAL_REF_INVALID",
  );
  if (record.ref_type !== expectedType || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !POSITIVE_DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256)) {
    fail("TERMINAL_FACT_CANONICAL_REF_INVALID");
  }
  return Object.freeze({
    ref_type: expectedType,
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

interface AliasValue {
  readonly provider: string;
  readonly value: string;
}

function alias(value: unknown): AliasValue {
  const record = exactRecord(value, ["provider", "value"], "TERMINAL_FACT_ALIAS_INVALID");
  return Object.freeze({
    provider: exactString(record.provider, "TERMINAL_FACT_ALIAS_INVALID"),
    value: exactString(record.value, "TERMINAL_FACT_ALIAS_INVALID"),
  });
}

interface NormalizedBinding {
  readonly binding: RealtimeTransportBinding;
  readonly sessionRef: SnakeRef;
  readonly leaseRef: SnakeRef;
  readonly continuityId: string;
  readonly deviceId: string;
  readonly connectionEpoch: string;
  readonly aliases: Readonly<Record<(typeof ALIAS_KINDS)[number][1], AliasValue>>;
}

function normalizeBinding(value: RealtimeTransportBinding): NormalizedBinding {
  const record = exactRecord(value, [
    "state", "realtimeSessionRef", "deviceLeaseRef", "continuityId", "deviceId", "connectionEpoch",
    "provider", "transportSessionAlias", "roomAlias", "deviceAlias", "connectionId",
  ], "TERMINAL_FACT_BINDING_INVALID");
  if (record.state !== "connected") fail("TERMINAL_FACT_BINDING_STATE_INVALID");
  const connectionEpoch = exactString(record.connectionEpoch, "TERMINAL_FACT_EPOCH_INVALID");
  if (!POSITIVE_DECIMAL.test(connectionEpoch)) fail("TERMINAL_FACT_EPOCH_INVALID");
  const aliases = {} as Record<(typeof ALIAS_KINDS)[number][1], AliasValue>;
  for (const [field, kind] of ALIAS_KINDS) aliases[kind] = alias(record[field]);
  return Object.freeze({
    binding: value,
    sessionRef: canonicalRef(record.realtimeSessionRef, "RealtimeSession"),
    leaseRef: canonicalRef(record.deviceLeaseRef, "DeviceLease"),
    continuityId: exactString(record.continuityId, "TERMINAL_FACT_CONTINUITY_INVALID"),
    deviceId: exactString(record.deviceId, "TERMINAL_FACT_DEVICE_INVALID"),
    connectionEpoch,
    aliases: Object.freeze(aliases),
  });
}

interface VerificationInput {
  readonly binding: NormalizedBinding;
  readonly userId: string;
  readonly deviceId: string;
  readonly occurredAt: string;
  readonly governance: OpaqueGovernanceValue;
}

function normalizeInput(input: Parameters<TransportDisconnectionPort["verify"]>[0]): VerificationInput {
  const record = exactRecord(
    input,
    ["binding", "userId", "deviceId", "occurredAt", "governance"],
    "TERMINAL_FACT_INPUT_INVALID",
  );
  const binding = normalizeBinding(record.binding as RealtimeTransportBinding);
  const occurredAt = exactString(record.occurredAt, "TERMINAL_FACT_TIME_INVALID");
  if (!UTC.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) fail("TERMINAL_FACT_TIME_INVALID");
  const userId = exactString(record.userId, "TERMINAL_FACT_USER_INVALID");
  const deviceId = exactString(record.deviceId, "TERMINAL_FACT_DEVICE_INVALID");
  if (deviceId !== binding.deviceId) fail("TERMINAL_FACT_DEVICE_BINDING_DRIFT");
  canonicalJson(record.governance);
  return Object.freeze({ binding, userId, deviceId, occurredAt, governance: record.governance as OpaqueGovernanceValue });
}

function factQuery(): string {
  return [
    "SELECT tf.terminal_fact_id::text,tf.operation,tf.status,tf.request_scope,tf.idempotency_key,tf.request_hash,",
    "tf.session_ref_id::text,tf.lease_ref_id::text,tf.continuity_id::text,tf.connection_epoch::text,",
    "tf.realtime_session_ref,tf.device_lease_ref,tf.operation_outcome,tf.execution_facts,tf.created_at,",
    "s.realtime_session_ref AS session_authority_ref,s.session_object_version,s.session_payload_sha256,",
    "s.user_id::text AS session_user_id,s.continuity_id::text AS session_continuity_id,",
    "s.active_device_id::text AS session_device_id,s.binding AS session_binding,",
    "l.device_lease_ref AS lease_authority_ref,l.lease_object_version,l.lease_payload_sha256,",
    "l.realtime_session_ref AS lease_session_ref,l.user_id::text AS lease_user_id,",
    "l.device_id::text AS lease_device_id,l.continuity_id::text AS lease_continuity_id",
    "FROM realtime_terminal_facts tf",
    "JOIN realtime_sessions s ON s.session_ref_id=tf.session_ref_id",
    "JOIN device_leases l ON l.lease_ref_id=tf.lease_ref_id AND l.session_ref_id=tf.session_ref_id",
    "WHERE tf.session_ref_id=$1 AND tf.lease_ref_id=$2 AND tf.continuity_id=$3 AND tf.connection_epoch=$4",
  ].join(" ");
}

async function readAliasRows(client: PoolClient, binding: NormalizedBinding): Promise<readonly QueryResultRow[]> {
  const result = await client.query(
    [
      "SELECT alias_kind,alias_value,active FROM realtime_transport_aliases",
      "WHERE session_ref_id=$1 AND lease_ref_id=$2 AND connection_epoch=$3",
      "ORDER BY alias_kind,alias_value",
    ].join(" "),
    [binding.sessionRef.ref_id, binding.leaseRef.ref_id, binding.connectionEpoch],
  );
  return result.rows;
}

function validateAliasRows(rows: readonly QueryResultRow[], binding: NormalizedBinding): void {
  if (rows.length !== ALIAS_KINDS.length) fail("TERMINAL_FACT_ALIAS_BINDING_DRIFT");
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.alias_kind !== "string" || typeof row.alias_value !== "string" || typeof row.active !== "boolean") {
      fail("TERMINAL_FACT_ALIAS_MALFORMED");
    }
    const expected = binding.aliases[row.alias_kind as keyof typeof binding.aliases];
    if (expected === undefined || expected.value !== row.alias_value || seen.has(row.alias_kind)) {
      fail("TERMINAL_FACT_ALIAS_BINDING_DRIFT");
    }
    seen.add(row.alias_kind);
  }
}

function validateAuthorityRows(row: QueryResultRow, input: VerificationInput): void {
  const sessionRef = canonicalRef(row.session_authority_ref, "RealtimeSession");
  const leaseRef = canonicalRef(row.lease_authority_ref, "DeviceLease");
  if (!sameJson(sessionRef, input.binding.sessionRef) || !sameJson(leaseRef, input.binding.leaseRef) ||
      String(row.session_object_version) !== sessionRef.object_version ||
      String(row.session_payload_sha256).trim() !== sessionRef.canonical_payload_sha256 ||
      String(row.lease_object_version) !== leaseRef.object_version ||
      String(row.lease_payload_sha256).trim() !== leaseRef.canonical_payload_sha256 ||
      !sameJson(row.lease_session_ref, sessionRef)) fail("TERMINAL_FACT_AUTHORITY_REF_DRIFT");
  if (String(row.session_user_id) !== input.userId || String(row.lease_user_id) !== input.userId ||
      String(row.session_continuity_id) !== input.binding.continuityId ||
      String(row.lease_continuity_id) !== input.binding.continuityId ||
      String(row.session_device_id) !== input.deviceId || String(row.lease_device_id) !== input.deviceId ||
      !sameJson(row.session_binding, input.binding.binding)) fail("TERMINAL_FACT_OWNER_BINDING_DRIFT");
}

function validateProjection(row: QueryResultRow, input: VerificationInput): VerifiedTransportDisconnection {
  if (!UUID.test(String(row.terminal_fact_id)) || !OPERATIONS.has(String(row.operation)) || row.status !== "success") {
    fail("TERMINAL_FACT_OPERATION_STATUS_INVALID");
  }
  if (String(row.session_ref_id) !== input.binding.sessionRef.ref_id ||
      String(row.lease_ref_id) !== input.binding.leaseRef.ref_id ||
      String(row.continuity_id) !== input.binding.continuityId ||
      String(row.connection_epoch) !== input.binding.connectionEpoch ||
      !sameJson(row.realtime_session_ref, input.binding.sessionRef) ||
      !sameJson(row.device_lease_ref, input.binding.leaseRef)) fail("TERMINAL_FACT_BINDING_DRIFT");
  const requestScope = exactString(row.request_scope, "TERMINAL_FACT_REQUEST_INVALID");
  const idempotencyKey = exactString(row.idempotency_key, "TERMINAL_FACT_REQUEST_INVALID");
  const requestHash = String(row.request_hash).trim();
  if (!SHA256.test(requestHash)) fail("TERMINAL_FACT_REQUEST_INVALID");
  const outcome = exactRecord(row.operation_outcome, [
    "kind", "verified", "disconnectedAt", "verifiedForOccurredAt", "authorityProof", "requestScope",
    "idempotencyKey", "requestFingerprint", "requestHash", "realtimeSessionRef", "deviceLeaseRef",
    "continuityId", "connectionEpoch", "userId", "deviceId", "governanceSha256",
  ], "TERMINAL_FACT_OUTCOME_INVALID");
  if (outcome.kind !== "realtime.transport.disconnection.authority.v1" || outcome.verified !== true ||
      outcome.requestScope !== requestScope || outcome.idempotencyKey !== idempotencyKey ||
      outcome.requestHash !== requestHash || typeof outcome.requestFingerprint !== "string" ||
      sha256Text(outcome.requestFingerprint) !== requestHash || outcome.verifiedForOccurredAt !== input.occurredAt ||
      !sameJson(outcome.realtimeSessionRef, input.binding.sessionRef) ||
      !sameJson(outcome.deviceLeaseRef, input.binding.leaseRef) || outcome.continuityId !== input.binding.continuityId ||
      String(outcome.connectionEpoch) !== input.binding.connectionEpoch || outcome.userId !== input.userId ||
      outcome.deviceId !== input.deviceId || outcome.governanceSha256 !== jsonHash(input.governance)) {
    fail("TERMINAL_FACT_OUTCOME_BINDING_DRIFT");
  }
  const disconnectedAt = exactString(outcome.disconnectedAt, "TERMINAL_FACT_TIME_INVALID");
  if (!UTC.test(disconnectedAt) || !Number.isFinite(Date.parse(disconnectedAt)) ||
      new Date(row.created_at).toISOString() !== disconnectedAt) fail("TERMINAL_FACT_TIME_DRIFT");
  canonicalJson(outcome.authorityProof);
  const execution = exactRecord(row.execution_facts, [
    "kind", "transportState", "authorityProofSha256", "realtimeSessionRef", "deviceLeaseRef",
    "continuityId", "connectionEpoch", "userId", "deviceId",
  ], "TERMINAL_FACT_EXECUTION_INVALID");
  if (execution.kind !== "realtime.transport.disconnection.execution.v1" || execution.transportState !== "disconnected" ||
      execution.authorityProofSha256 !== jsonHash(outcome.authorityProof) ||
      !sameJson(execution.realtimeSessionRef, input.binding.sessionRef) ||
      !sameJson(execution.deviceLeaseRef, input.binding.leaseRef) || execution.continuityId !== input.binding.continuityId ||
      String(execution.connectionEpoch) !== input.binding.connectionEpoch || execution.userId !== input.userId ||
      execution.deviceId !== input.deviceId) fail("TERMINAL_FACT_EXECUTION_BINDING_DRIFT");
  return Object.freeze({
    verified: true,
    disconnectedAt: disconnectedAt as VerifiedTransportDisconnection["disconnectedAt"],
    authorityProof: outcome.authorityProof as OpaqueGovernanceValue,
  });
}

async function verifyDisconnection(
  client: PoolClient,
  rawInput: Parameters<TransportDisconnectionPort["verify"]>[0],
): Promise<VerifiedTransportDisconnection> {
  const input = normalizeInput(rawInput);
  const facts = await client.query(factQuery(), [
    input.binding.sessionRef.ref_id,
    input.binding.leaseRef.ref_id,
    input.binding.continuityId,
    input.binding.connectionEpoch,
  ]);
  if (facts.rows.length === 0) fail("TERMINAL_FACT_NOT_FOUND");
  if (facts.rows.length !== 1) fail("TERMINAL_FACT_DUPLICATE");
  const aliases = await readAliasRows(client, input.binding);
  validateAliasRows(aliases, input.binding);
  validateAuthorityRows(facts.rows[0]!, input);
  return validateProjection(facts.rows[0]!, input);
}

export function createRealtimeTerminalFactDisconnectionProvider(
  pool: Pool,
): RealtimeTerminalFactDisconnectionProvider {
  if (!pool || typeof pool.connect !== "function") fail("TERMINAL_FACT_POOL_REQUIRED");
  return Object.freeze({
    verify: (input: Parameters<TransportDisconnectionPort["verify"]>[0]) => withTransaction(
      pool,
      (client) => verifyDisconnection(client, input),
      { isolation: "REPEATABLE READ", readOnly: true },
    ),
  });
}
