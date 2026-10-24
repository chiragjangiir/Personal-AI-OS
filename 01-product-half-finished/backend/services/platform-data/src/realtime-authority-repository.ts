import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  RealtimeAuthorityRepository as T11BRealtimeAuthorityRepository,
  RealtimeAuthorityTransaction as T11BRealtimeAuthorityTransaction,
} from "../../realtime-core/src/ports.ts";
import type {
  DeviceLeaseRecord,
  CurrentBindingLookup,
  HandoffFactRecord,
  IdempotencyRecord as T11BIdempotencyRecord,
  OpaqueCanonicalRef,
  OutboxEvent,
  RealtimeSessionRecord,
  RealtimeCurrentBindingProjection,
  RealtimeTransportBinding,
} from "../../realtime-core/src/types.ts";
import {
  claimIdempotency,
  completeIdempotency,
  type IdempotencyKeyInput,
  type IdempotencyRecord,
} from "./idempotency-ledger.ts";
import {
  enqueueOutboxEvent,
  type OutboxEventInput,
  type OutboxEventRecord,
} from "./transactional-outbox.ts";
import { isManagedTransactionClient, isPostgresTxOutcomeUncertain, withTransaction } from "./transaction.ts";

/** Internal-only legacy seam. It is not a T01 wire projection. */
export interface CanonicalAuthorityRef {
  readonly refType: "RealtimeSession" | "DeviceLease";
  readonly refId: string;
  readonly objectVersion: string;
  readonly canonicalPayloadSha256: string;
}

export interface RealtimeSessionRowInput {
  readonly sessionRef: CanonicalAuthorityRef;
  readonly userId: string;
  readonly continuityId: string;
  readonly state: "active" | "terminal" | "ended" | "expired" | "revoked";
  readonly connectionEpoch: string;
  readonly continuityExpiresAt: string;
  readonly lastAcceptedActivityAt?: string;
  readonly terminalAt?: string;
  readonly terminalReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expectedConnectionEpoch?: string;
}

export interface DeviceLeaseRowInput {
  readonly leaseRef: CanonicalAuthorityRef;
  readonly sessionRefId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly continuityId: string;
  readonly leaseVersion: string;
  readonly state: "active" | "released" | "expired" | "revoked";
  readonly capabilityScope: unknown;
  readonly purposeScope: unknown;
  readonly policyBinding: unknown;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly revokedAt?: string;
  readonly updatedAt: string;
  readonly expectedLeaseVersion?: string;
}

export interface TransportAliasInput {
  readonly sessionRefId: string;
  readonly leaseRefId: string;
  readonly connectionEpoch: string;
  readonly aliasKind: "livekit_room" | "livekit_session" | "livekit_participant" | "provider_alias";
  readonly aliasValue: string;
  readonly createdAt: string;
}

export interface TerminalFactInput {
  readonly terminalFactId: string;
  readonly operation:
    | "bootstrap"
    | "connected_refresh"
    | "fully_disconnected_refresh"
    | "connected_credential_refresh"
    | "device_lease_renewal"
    | "media_stop"
    | "end_continuity"
    | "handoff"
    | "reconnect"
    | "lease_release"
    | "realtime_e2ee_key_resolve";
  readonly status: "success" | "error" | "cancelled" | "expired" | "revoked" | "indeterminate";
  readonly requestScope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly sessionRefId?: string;
  readonly leaseRefId?: string;
  readonly continuityId?: string;
  readonly realtimeSessionRef?: unknown;
  readonly deviceLeaseRef?: unknown;
  readonly continuityRef?: unknown;
  readonly connectionEpoch?: string;
  readonly operationOutcome: unknown;
  readonly executionFacts: unknown;
  readonly createdAt: string;
}

export interface HandoffFactInput {
  readonly handoffRefId: string;
  readonly sessionRefId: string;
  readonly continuityId: string;
  readonly fromDeviceId: string;
  readonly toDeviceId: string;
  readonly expectedLeaseVersion: string;
  readonly resultingLeaseVersion: string;
  readonly connectionEpoch: string;
  readonly requestScope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly outcome: unknown;
  readonly occurredAt: string;
}

export interface AtomicOperationInput extends IdempotencyKeyInput {}

export interface AtomicOperationCommit<T> {
  readonly response: T;
  readonly responseHash: string;
  readonly terminalFact?: TerminalFactInput;
  readonly outboxEvents?: readonly OutboxEventInput[];
}

export type AtomicOperationResult<T> =
  | { readonly kind: "committed"; readonly response: T; readonly idempotency: IdempotencyRecord }
  | { readonly kind: "replayed"; readonly response: T; readonly idempotency: IdempotencyRecord };

export type TerminalFactResult =
  | { readonly kind: "committed"; readonly fact: TerminalFactInput }
  | { readonly kind: "replayed"; readonly fact: TerminalFactInput };

export type HandoffFactResult =
  | { readonly kind: "committed"; readonly fact: HandoffFactInput }
  | { readonly kind: "replayed"; readonly fact: HandoffFactInput };

export class FencingConflictError extends Error {
  readonly code = "FENCING_CONFLICT";
  constructor() {
    super("FENCING_CONFLICT");
    this.name = "FencingConflictError";
  }
}

export class RealtimeAuthorityConflictError extends Error {
  readonly code = "REALTIME_AUTHORITY_CONFLICT";
  constructor() {
    super("REALTIME_AUTHORITY_CONFLICT");
    this.name = "RealtimeAuthorityConflictError";
  }
}

export class IndeterminateOperationError extends Error {
  readonly code = "INDETERMINATE_OPERATION";
  constructor() {
    super("INDETERMINATE_OPERATION");
    this.name = "IndeterminateOperationError";
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_INTERNAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const T11B_HANDOFF_REQUEST_SCOPE = "realtime.handoff";
const OWNER_REF_KEYS = ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"] as const;

interface CanonicalOwnerRef {
  readonly ref_type: "RealtimeSession" | "DeviceLease";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

function assertUuid(value: string): void {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new TypeError("invalid canonical UUIDv7");
}

function assertInternalUuid(value: string): void {
  if (typeof value !== "string" || !UUID_INTERNAL.test(value)) throw new TypeError("invalid internal UUID");
}

function assertHash(value: string): void {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError("invalid SHA-256");
}

function assertDecimal(value: string): void {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new TypeError("invalid decimal epoch");
}

function dbDecimal(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("invalid database decimal");
  assertDecimal(value);
  return value;
}

function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  assertDecimal(left);
  assertDecimal(right);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function assertRef(ref: CanonicalAuthorityRef, expected: CanonicalAuthorityRef["refType"]): void {
  if (!ref || ref.refType !== expected) throw new TypeError("invalid canonical authority ref type");
  assertUuid(ref.refId);
  assertDecimal(ref.objectVersion);
  assertHash(ref.canonicalPayloadSha256);
}

function refId(value: string): string {
  assertUuid(value);
  return value;
}

function assertCanonicalOwnerRef(value: unknown, expectedType: CanonicalOwnerRef["ref_type"]): CanonicalOwnerRef {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("canonical owner ref must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== OWNER_REF_KEYS.length || keys.some((key, index) => key !== OWNER_REF_KEYS[index])) {
    throw new TypeError("canonical owner ref exact snake_case fields required");
  }
  if (Reflect.ownKeys(record).some((key) => typeof key === "symbol") ||
      OWNER_REF_KEYS.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true;
      })) {
    throw new TypeError("canonical owner ref descriptors invalid");
  }
  if (record.ref_type !== expectedType || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !HASH.test(record.canonical_payload_sha256)) {
    throw new TypeError("canonical owner ref values invalid");
  }
  return value as CanonicalOwnerRef;
}

function ownerStorageIdentifier(value: OpaqueCanonicalRef, expectedType: CanonicalOwnerRef["ref_type"]): string {
  return assertCanonicalOwnerRef(value, expectedType).ref_id;
}

function ownerRefIdOrUndefined(value: unknown, expectedType: CanonicalOwnerRef["ref_type"]): string | undefined {
  try {
    return assertCanonicalOwnerRef(value, expectedType).ref_id;
  } catch {
    return undefined;
  }
}

function cloneOpaque(value: unknown): unknown {
  return strictCloneJson(value);
}

function strictCloneJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
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
      copy.push(strictCloneJson(value[index], seen));
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
      value: strictCloneJson((value as Record<string, unknown>)[name], seen),
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(strictCloneJson(value));
}

function jsonText(value: unknown): string {
  return stableSerialize(value);
}

function aliasText(value: unknown): string {
  const text = typeof value === "string" ? value : jsonText(value);
  if (text.length === 0 || text.length > 512) throw new TypeError("invalid transport alias");
  return text;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonHash(value: unknown): string {
  return sha256Text(stableSerialize(value));
}

function sameOptionalJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return jsonText(left) === jsonText(right);
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,37})$/u.test(value)) {
    throw new TypeError("invalid revision");
  }
  return value;
}

function connectionEpoch(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,37}$/u.test(value)) {
    throw new TypeError("invalid connection epoch");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("invalid timestamp");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refHash(value: unknown): string {
  return jsonHash(value);
}

function terminalOperation(value: unknown): TerminalFactInput["operation"] {
  if (value === "device_lease_renewal") return "device_lease_renewal";
  if (value === "connected_credential_refresh") return "connected_credential_refresh";
  if (value === "connected_refresh") return "connected_refresh";
  if (value === "fully_disconnected_refresh") return "fully_disconnected_refresh";
  if (value === "bootstrap" || value === "media_stop" || value === "end_continuity" ||
      value === "handoff" || value === "reconnect" || value === "lease_release" ||
      value === "realtime_e2ee_key_resolve") return value;
  throw new TypeError("invalid terminal operation");
}

function terminalStatus(value: unknown): TerminalFactInput["status"] {
  if (value === "success" || value === "error" || value === "cancelled" ||
      value === "expired" || value === "revoked" || value === "indeterminate") return value;
  throw new TypeError("invalid terminal status");
}

function terminalFactFromRow(row: QueryResultRow): TerminalFactInput {
  const operation = terminalOperation(row.operation);
  const status = terminalStatus(row.status);
  const requestHash = String(row.request_hash).trim();
  assertHash(requestHash);
  if (typeof row.request_scope !== "string" || row.request_scope.length === 0 ||
      typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0) {
    throw new RealtimeAuthorityConflictError();
  }
  if (row.session_ref_id !== null && row.session_ref_id !== undefined) assertUuid(String(row.session_ref_id));
  if (row.lease_ref_id !== null && row.lease_ref_id !== undefined) assertUuid(String(row.lease_ref_id));
  if (row.continuity_id !== null && row.continuity_id !== undefined) assertUuid(String(row.continuity_id));
  if (row.connection_epoch !== null && row.connection_epoch !== undefined) assertDecimal(String(row.connection_epoch));
  const realtimeSessionRef = row.realtime_session_ref === null || row.realtime_session_ref === undefined
    ? undefined
    : cloneOpaque(row.realtime_session_ref);
  const deviceLeaseRef = row.device_lease_ref === null || row.device_lease_ref === undefined
    ? undefined
    : cloneOpaque(row.device_lease_ref);
  if (realtimeSessionRef !== undefined) assertCanonicalOwnerRef(realtimeSessionRef, "RealtimeSession");
  if (deviceLeaseRef !== undefined) assertCanonicalOwnerRef(deviceLeaseRef, "DeviceLease");
  return {
    terminalFactId: String(row.terminal_fact_id),
    operation,
    status,
    requestScope: row.request_scope,
    idempotencyKey: row.idempotency_key,
    requestHash,
    ...(row.session_ref_id === null ? {} : { sessionRefId: String(row.session_ref_id) }),
    ...(row.lease_ref_id === null ? {} : { leaseRefId: String(row.lease_ref_id) }),
    ...(row.continuity_id === null ? {} : { continuityId: String(row.continuity_id) }),
    ...(row.connection_epoch === null ? {} : { connectionEpoch: String(row.connection_epoch) }),
    ...(realtimeSessionRef === undefined ? {} : { realtimeSessionRef }),
    ...(deviceLeaseRef === undefined ? {} : { deviceLeaseRef }),
    ...(row.continuity_ref === null || row.continuity_ref === undefined ? {} : { continuityRef: cloneOpaque(row.continuity_ref) }),
    operationOutcome: row.operation_outcome,
    executionFacts: row.execution_facts,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function handoffFactFromRow(row: QueryResultRow): HandoffFactInput {
  if (typeof row.request_scope !== "string" || row.request_scope.length === 0 ||
      typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0) {
    throw new RealtimeAuthorityConflictError();
  }
  assertInternalUuid(String(row.handoff_ref_id));
  assertUuid(String(row.session_ref_id));
  assertUuid(String(row.continuity_id));
  assertUuid(String(row.from_device_id));
  assertUuid(String(row.to_device_id));
  assertDecimal(String(row.expected_lease_version));
  assertDecimal(String(row.resulting_lease_version));
  assertDecimal(String(row.connection_epoch));
  const requestHash = String(row.request_hash).trim();
  assertHash(requestHash);
  return {
    handoffRefId: String(row.handoff_ref_id),
    sessionRefId: String(row.session_ref_id),
    continuityId: String(row.continuity_id),
    fromDeviceId: String(row.from_device_id),
    toDeviceId: String(row.to_device_id),
    expectedLeaseVersion: String(row.expected_lease_version),
    resultingLeaseVersion: String(row.resulting_lease_version),
    connectionEpoch: String(row.connection_epoch),
    requestScope: String(row.request_scope),
    idempotencyKey: String(row.idempotency_key),
    requestHash,
    outcome: row.outcome,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

function handoffFactInputFromT11BRecord(record: HandoffFactRecord): HandoffFactInput {
  const outcome = cloneOpaque(record);
  if (!isRecord(outcome)) throw new TypeError("invalid T11B handoff fact");
  const sessionRef = assertCanonicalOwnerRef(outcome.realtimeSessionRef, "RealtimeSession");
  const oldLeaseRef = assertCanonicalOwnerRef(outcome.oldLeaseRef, "DeviceLease");
  const newLeaseRef = assertCanonicalOwnerRef(outcome.newLeaseRef, "DeviceLease");
  const requestId = outcome.requestId;
  const idempotencyKey = outcome.idempotencyKey;
  const requestFingerprint = outcome.requestFingerprint;
  const continuityId = outcome.continuityId;
  const fromDeviceId = outcome.fromDeviceId;
  const toDeviceId = outcome.toDeviceId;
  const connectionEpoch = outcome.connectionEpoch;
  const expectedLeaseVersion = outcome.expectedLeaseVersion;
  const releasedLeaseVersion = outcome.releasedLeaseVersion;
  const releasedFencingToken = outcome.releasedFencingToken;
  const newLeaseVersion = outcome.newLeaseVersion;
  const newFencingToken = outcome.newFencingToken;
  const suppressedDeviceId = outcome.suppressedDeviceId;
  const occurredAt = outcome.occurredAt;
  if (typeof requestId !== "string" || requestId.length === 0 ||
      typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
      typeof requestFingerprint !== "string" || requestFingerprint.trim().length === 0 || typeof continuityId !== "string" ||
      typeof fromDeviceId !== "string" || typeof toDeviceId !== "string" ||
      typeof connectionEpoch !== "string" || typeof expectedLeaseVersion !== "string" ||
      typeof releasedLeaseVersion !== "string" || typeof releasedFencingToken !== "string" ||
      typeof newLeaseVersion !== "string" || typeof newFencingToken !== "string" ||
      typeof suppressedDeviceId !== "string" || typeof occurredAt !== "string" || occurredAt.length === 0) {
    throw new TypeError("invalid T11B handoff fact fields");
  }
  assertUuid(continuityId);
  assertUuid(fromDeviceId);
  assertUuid(toDeviceId);
  assertDecimal(connectionEpoch);
  assertDecimal(expectedLeaseVersion);
  assertDecimal(releasedLeaseVersion);
  assertDecimal(releasedFencingToken);
  assertDecimal(newLeaseVersion);
  assertDecimal(newFencingToken);
  assertUuid(suppressedDeviceId);
  timestamp(occurredAt);
  return {
    handoffRefId: randomUUID(),
    sessionRefId: sessionRef.ref_id,
    continuityId,
    fromDeviceId,
    toDeviceId,
    expectedLeaseVersion,
    resultingLeaseVersion: newLeaseVersion,
    connectionEpoch,
    requestScope: T11B_HANDOFF_REQUEST_SCOPE,
    idempotencyKey,
    requestHash: sha256Text(requestFingerprint),
    outcome,
    occurredAt,
  };
}

export class RealtimeAuthorityRepository implements T11BRealtimeAuthorityRepository {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
  }

  async transaction<T>(
    operation: string,
    work: (transaction: T11BRealtimeAuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    if (typeof operation !== "string" || operation.length === 0 || typeof work !== "function") {
      throw new TypeError("invalid realtime transaction");
    }
    const context: { idempotency?: { operation: string; idempotencyKey: string } } = {};
    try {
      return await withTransaction(this.pool, (client) => work(this.createT11BTransaction(client, context)));
    } catch (error) {
      if (context.idempotency !== undefined && isPostgresTxOutcomeUncertain(error)) {
        await this.recordT11BIndeterminate(context.idempotency).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Uses the caller's managed transaction. Does not borrow or release a pool client. */
  async readCurrentBindingInTransaction(client: PoolClient, lookup: CurrentBindingLookup) {
    if (!isManagedTransactionClient(client)) throw new TypeError("managed transaction client is required");
    return this.readCurrentBindingForT11B(client, lookup);
  }

  private createT11BTransaction(
    client: PoolClient,
    context: { idempotency?: { operation: string; idempotencyKey: string } },
  ): T11BRealtimeAuthorityTransaction {
    return {
      readSession: (ref) => this.readSessionForT11B(client, ref),
      readSessionByContinuityId: (continuityId) => this.readSessionByContinuityForT11B(client, continuityId),
      readLease: (ref) => this.readLeaseForT11B(client, ref),
      readCurrentBinding: (lookup) => this.readCurrentBindingForT11B(client, lookup),
      readActiveDeviceSessions: (input) => this.readActiveDeviceSessionsForT11B(client, input),
      readIdempotency: (operation, idempotencyKey) => {
        context.idempotency = { operation, idempotencyKey };
        return this.readIdempotencyForT11B(client, operation, idempotencyKey);
      },
      writeSession: (input) => this.writeSessionForT11B(client, input),
      writeLease: (input) => this.writeLeaseForT11B(client, input),
      writeBinding: (input) => this.writeBindingForT11B(client, input),
      recordHandoffFact: (record) => this.recordHandoffFactForT11B(client, record),
      writeIdempotency: (record) => this.writeIdempotencyForT11B(client, record),
      appendOutbox: (event) => this.appendOutboxForT11B(client, event),
    };
  }

  /**
   * Read the current session/lease/binding as one SQL statement.  The
   * continuity branch deliberately selects only the database's unique
   * active-current row; it never chooses a row by recency.  The left join is
   * intentional: a missing active-device lease is an authority contradiction,
   * not a not-found result.
   */
  private async readCurrentBindingForT11B(
    client: PoolClient,
    lookup: CurrentBindingLookup,
  ): Promise<RealtimeCurrentBindingProjection | undefined> {
    let predicate: string;
    let parameter: string;
    if (lookup.realtimeSessionRef !== undefined) {
      parameter = ownerStorageIdentifier(lookup.realtimeSessionRef, "RealtimeSession");
      assertUuid(parameter);
      predicate = "s.session_ref_id = $1";
    } else {
      parameter = lookup.continuityId;
      assertUuid(parameter);
      predicate = "s.continuity_id = $1 AND s.state = 'active' AND s.continuity_state = 'active'";
    }
    // Lock before taking the joined snapshot: waiting inside the join can pair a
    // newly committed session with the lease version visible before that wait.
    const locked = await client.query<{ session_ref_id: string }>(
      `SELECT s.session_ref_id FROM realtime_sessions AS s WHERE ${predicate} FOR UPDATE`,
      [parameter],
    );
    if (locked.rows.length === 0) return undefined;
    if (locked.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    const result = await client.query(
      [
        "SELECT",
        "s.session_ref_id AS s_session_ref_id, s.realtime_session_ref AS s_realtime_session_ref,",
        "s.session_object_version AS s_session_object_version, s.session_payload_sha256 AS s_session_payload_sha256,",
        "s.continuity_ref AS s_continuity_ref, s.user_id AS s_user_id, s.continuity_id AS s_continuity_id,",
        "s.state AS s_state, s.continuity_state AS s_continuity_state, s.connection_epoch AS s_connection_epoch,",
        "s.continuity_expires_at AS s_continuity_expires_at, s.last_accepted_activity_at AS s_last_accepted_activity_at,",
        "s.active_device_id AS s_active_device_id, s.active_device_lease_ref AS s_active_device_lease_ref,",
        "s.binding AS s_binding, s.revision AS s_revision, s.updated_at AS s_updated_at,",
        "l.lease_ref_id AS l_lease_ref_id, l.device_lease_ref AS l_device_lease_ref,",
        "l.lease_object_version AS l_lease_object_version, l.lease_payload_sha256 AS l_lease_payload_sha256,",
        "l.realtime_session_ref AS l_realtime_session_ref, l.continuity_ref AS l_continuity_ref,",
        "l.session_ref_id AS l_session_ref_id, l.continuity_id AS l_continuity_id, l.user_id AS l_user_id,",
        "l.device_id AS l_device_id, l.state AS l_state, l.capabilities AS l_capabilities, l.purpose AS l_purpose,",
        "l.issued_at AS l_issued_at, l.expires_at AS l_expires_at, l.revocable AS l_revocable,",
        "l.lease_version AS l_lease_version, l.fencing_token AS l_fencing_token,",
        "l.policy_decision_ref AS l_policy_decision_ref",
        "FROM realtime_sessions AS s",
        "LEFT JOIN device_leases AS l ON l.lease_ref_id::text = s.active_device_lease_ref->>'ref_id'",
        "WHERE s.session_ref_id = $1",
        "FOR UPDATE OF s",
      ].join(" "),
      [locked.rows[0]!.session_ref_id],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    const row = result.rows[0]!;
    if (row.l_lease_ref_id === null || row.l_lease_ref_id === undefined) {
      throw new RealtimeAuthorityConflictError();
    }
    const session = this.sessionFromRow({
      session_ref_id: row.s_session_ref_id,
      realtime_session_ref: row.s_realtime_session_ref,
      session_object_version: row.s_session_object_version,
      session_payload_sha256: row.s_session_payload_sha256,
      continuity_ref: row.s_continuity_ref,
      user_id: row.s_user_id,
      continuity_id: row.s_continuity_id,
      state: row.s_state,
      continuity_state: row.s_continuity_state,
      connection_epoch: row.s_connection_epoch,
      continuity_expires_at: row.s_continuity_expires_at,
      last_accepted_activity_at: row.s_last_accepted_activity_at,
      active_device_id: row.s_active_device_id,
      active_device_lease_ref: row.s_active_device_lease_ref,
      binding: row.s_binding,
      revision: row.s_revision,
      updated_at: row.s_updated_at,
    });
    const lease = this.leaseFromRow({
      lease_ref_id: row.l_lease_ref_id,
      device_lease_ref: row.l_device_lease_ref,
      lease_object_version: row.l_lease_object_version,
      lease_payload_sha256: row.l_lease_payload_sha256,
      realtime_session_ref: row.l_realtime_session_ref,
      continuity_ref: row.l_continuity_ref,
      session_ref_id: row.l_session_ref_id,
      continuity_id: row.l_continuity_id,
      user_id: row.l_user_id,
      device_id: row.l_device_id,
      state: row.l_state,
      capabilities: row.l_capabilities,
      purpose: row.l_purpose,
      issued_at: row.l_issued_at,
      expires_at: row.l_expires_at,
      revocable: row.l_revocable,
      lease_version: row.l_lease_version,
      fencing_token: row.l_fencing_token,
      policy_decision_ref: row.l_policy_decision_ref,
    });
    const requestedSessionRef = lookup.realtimeSessionRef;
    const binding = session.binding;
    if ((requestedSessionRef !== undefined && !sameOptionalJson(session.realtimeSessionRef, requestedSessionRef)) ||
        !sameOptionalJson(session.activeDeviceLeaseRef, lease.deviceLeaseRef) ||
        !sameOptionalJson(session.realtimeSessionRef, lease.realtimeSessionRef) ||
        !sameOptionalJson(binding.realtimeSessionRef, session.realtimeSessionRef) ||
        !sameOptionalJson(binding.deviceLeaseRef, lease.deviceLeaseRef) ||
        session.userId !== lease.userId ||
        session.continuityId !== lease.continuityId ||
        session.activeDeviceId !== lease.deviceId ||
        binding.continuityId !== session.continuityId ||
        binding.deviceId !== session.activeDeviceId ||
        binding.connectionEpoch !== session.connectionEpoch ||
        (session.state === "active" && session.continuityState !== "active") ||
        (session.continuityState === "ended" && binding.state !== "released") ||
        (binding.state === "connected" && lease.state !== "active") ||
        (binding.state === "released" && lease.state === "active")) {
      throw new RealtimeAuthorityConflictError();
    }
    return Object.freeze({ session, lease });
  }

  /** Serializes Starts of one user/device/purpose with a transaction-scoped advisory lock, then returns each active
   * session of that scope through the same validated current-binding read (no recency guess, no LIMIT). */
  private async readActiveDeviceSessionsForT11B(
    client: PoolClient,
    input: { readonly userId: string; readonly deviceId: string; readonly purpose: string },
  ): Promise<readonly RealtimeCurrentBindingProjection[]> {
    assertUuid(input.userId);
    assertUuid(input.deviceId);
    if (typeof input.purpose !== "string" || input.purpose.length === 0 || input.purpose.length > 128) {
      throw new TypeError("invalid device session purpose");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`realtime.device-session:${input.userId}:${input.deviceId}:${input.purpose}`]);
    const result = await client.query(
      [
        "SELECT s.realtime_session_ref FROM realtime_sessions AS s",
        "JOIN device_leases AS l ON l.lease_ref_id::text = s.active_device_lease_ref->>'ref_id'",
        "WHERE s.user_id = $1::uuid AND s.active_device_id = $2::uuid AND s.state = 'active' AND s.continuity_state = 'active'",
        "AND l.device_id = $2::uuid AND l.purpose = $3 ORDER BY s.created_at, s.session_ref_id",
      ].join(" "),
      [input.userId, input.deviceId, input.purpose],
    );
    const held: RealtimeCurrentBindingProjection[] = [];
    for (const row of result.rows) {
      const projection = await this.readCurrentBindingForT11B(client, { realtimeSessionRef: cloneOpaque(row.realtime_session_ref) as OpaqueCanonicalRef });
      if (projection === undefined) throw new RealtimeAuthorityConflictError();
      held.push(projection);
    }
    return Object.freeze(held);
  }

  private async readSessionForT11B(
    client: PoolClient,
    ref: OpaqueCanonicalRef,
  ): Promise<RealtimeSessionRecord | undefined> {
    const identifier = ownerStorageIdentifier(ref, "RealtimeSession");
    assertUuid(identifier);
    const result = await client.query(
      [
        "SELECT session_ref_id, realtime_session_ref, session_object_version, session_payload_sha256, continuity_ref, user_id, continuity_id, state,",
        "continuity_state, connection_epoch, continuity_expires_at, last_accepted_activity_at,",
        "active_device_id, active_device_lease_ref, binding, revision, updated_at",
        "FROM realtime_sessions WHERE session_ref_id = $1 FOR UPDATE",
      ].join(" "),
      [identifier],
    );
    if (result.rows.length === 0) return undefined;
    const record = this.sessionFromRow(result.rows[0]!);
    if (!sameOptionalJson(record.realtimeSessionRef, ref)) {
      throw new RealtimeAuthorityConflictError();
    }
    return record;
  }

  private async readSessionByContinuityForT11B(
    client: PoolClient,
    continuityId: string,
  ): Promise<RealtimeSessionRecord | undefined> {
    assertUuid(continuityId);
    const result = await client.query(
      [
        "SELECT session_ref_id, realtime_session_ref, session_object_version, session_payload_sha256, continuity_ref, user_id, continuity_id, state,",
        "continuity_state, connection_epoch, continuity_expires_at, last_accepted_activity_at,",
        "active_device_id, active_device_lease_ref, binding, revision, updated_at",
        "FROM realtime_sessions WHERE continuity_id = $1 AND state = 'active' AND continuity_state = 'active' FOR UPDATE",
      ].join(" "),
      [continuityId],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    return this.sessionFromRow(result.rows[0]!);
  }

  private sessionFromRow(row: QueryResultRow): RealtimeSessionRecord {
    if (row.binding === null || row.binding === undefined || row.realtime_session_ref === null ||
        row.realtime_session_ref === undefined || row.active_device_lease_ref === null ||
        row.active_device_lease_ref === undefined || row.continuity_state === null ||
        row.continuity_state === undefined || row.last_accepted_activity_at === null ||
        row.last_accepted_activity_at === undefined || row.active_device_id === null ||
        row.active_device_id === undefined || row.revision === null || row.revision === undefined) {
      throw new RealtimeAuthorityConflictError();
    }
    const realtimeSessionRef = cloneOpaque(row.realtime_session_ref) as OpaqueCanonicalRef;
    const sessionOwnerRef = assertCanonicalOwnerRef(realtimeSessionRef, "RealtimeSession");
    const activeDeviceLeaseRef = cloneOpaque(row.active_device_lease_ref) as OpaqueCanonicalRef;
    const activeLeaseOwnerRef = assertCanonicalOwnerRef(activeDeviceLeaseRef, "DeviceLease");
    if (String(row.session_object_version) !== sessionOwnerRef.object_version ||
        String(row.session_payload_sha256).trim() !== sessionOwnerRef.canonical_payload_sha256) {
      throw new RealtimeAuthorityConflictError();
    }
    if (sessionOwnerRef.ref_id !== String(row.session_ref_id) ||
        activeLeaseOwnerRef.ref_id.length === 0 ||
        (row.state !== "active" && row.state !== "terminal") ||
        (row.continuity_state !== "active" && row.continuity_state !== "ended")) {
      throw new RealtimeAuthorityConflictError();
    }
    assertUuid(String(row.user_id));
    assertUuid(String(row.continuity_id));
    assertUuid(String(row.active_device_id));
    const binding = cloneOpaque(row.binding);
    if (!isRecord(binding) || !sameOptionalJson(binding.realtimeSessionRef, sessionOwnerRef) ||
        !sameOptionalJson(binding.deviceLeaseRef, activeLeaseOwnerRef) ||
        binding.continuityId !== String(row.continuity_id) || binding.deviceId !== String(row.active_device_id) ||
        String(binding.connectionEpoch) !== String(row.connection_epoch) ||
        (binding.state !== "connected" && binding.state !== "disconnected" && binding.state !== "released")) {
      throw new RealtimeAuthorityConflictError();
    }
    return {
      realtimeSessionRef,
      userId: String(row.user_id),
      continuityId: String(row.continuity_id),
      state: row.state,
      continuityState: row.continuity_state,
      connectionEpoch: dbDecimal(String(row.connection_epoch)) as RealtimeSessionRecord["connectionEpoch"],
      continuityExpiresAt: timestamp(new Date(row.continuity_expires_at).toISOString()) as RealtimeSessionRecord["continuityExpiresAt"],
      lastAcceptedUserActivityAt: timestamp(new Date(row.last_accepted_activity_at).toISOString()) as RealtimeSessionRecord["lastAcceptedUserActivityAt"],
      activeDeviceId: String(row.active_device_id),
      activeDeviceLeaseRef,
      binding: binding as unknown as RealtimeTransportBinding,
      revision: revision(String(row.revision ?? "0")) as RealtimeSessionRecord["revision"],
    };
  }

  private async readLeaseForT11B(
    client: PoolClient,
    ref: OpaqueCanonicalRef,
  ): Promise<DeviceLeaseRecord | undefined> {
    const identifier = ownerStorageIdentifier(ref, "DeviceLease");
    assertUuid(identifier);
    const result = await client.query(
      [
        "SELECT lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256, realtime_session_ref, continuity_ref, session_ref_id,",
        "continuity_id, user_id, device_id, state, capabilities, purpose, issued_at, expires_at,",
        "revocable, lease_version, fencing_token, policy_decision_ref",
        "FROM device_leases WHERE lease_ref_id = $1 FOR UPDATE",
      ].join(" "),
      [identifier],
    );
    if (result.rows.length === 0) return undefined;
    const record = this.leaseFromRow(result.rows[0]!);
    if (!sameOptionalJson(record.deviceLeaseRef, ref)) {
      throw new RealtimeAuthorityConflictError();
    }
    return record;
  }

  private leaseFromRow(row: QueryResultRow): DeviceLeaseRecord {
    if (row.device_lease_ref === null || row.device_lease_ref === undefined ||
        row.realtime_session_ref === null || row.realtime_session_ref === undefined ||
        !Array.isArray(row.capabilities) || row.purpose === null || row.purpose === undefined ||
        row.issued_at === null || row.issued_at === undefined || row.fencing_token === null ||
        row.fencing_token === undefined || row.policy_decision_ref === null || row.policy_decision_ref === undefined ||
        row.revocable !== true) {
      throw new RealtimeAuthorityConflictError();
    }
    const capabilities = cloneOpaque(row.capabilities);
    if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string")) {
      throw new RealtimeAuthorityConflictError();
    }
    assertUuid(String(row.lease_ref_id));
    assertUuid(String(row.session_ref_id));
    assertUuid(String(row.user_id));
    assertUuid(String(row.device_id));
    assertUuid(String(row.continuity_id));
    const deviceLeaseRef = cloneOpaque(row.device_lease_ref) as OpaqueCanonicalRef;
    const leaseOwnerRef = assertCanonicalOwnerRef(deviceLeaseRef, "DeviceLease");
    const realtimeSessionRef = cloneOpaque(row.realtime_session_ref) as OpaqueCanonicalRef;
    const sessionOwnerRef = assertCanonicalOwnerRef(realtimeSessionRef, "RealtimeSession");
    if (String(row.lease_object_version) !== leaseOwnerRef.object_version ||
        String(row.lease_payload_sha256).trim() !== leaseOwnerRef.canonical_payload_sha256 ||
        leaseOwnerRef.ref_id !== String(row.lease_ref_id) ||
        sessionOwnerRef.ref_id !== String(row.session_ref_id) ||
        (row.state !== "active" && row.state !== "released" && row.state !== "revoked" && row.state !== "expired")) {
      throw new RealtimeAuthorityConflictError();
    }
    return {
      deviceLeaseRef,
      realtimeSessionRef,
      continuityId: String(row.continuity_id),
      userId: String(row.user_id),
      deviceId: String(row.device_id),
      state: row.state,
      capabilities: Object.freeze(capabilities as string[]),
      purpose: String(row.purpose),
      issuedAt: timestamp(new Date(row.issued_at).toISOString()) as DeviceLeaseRecord["issuedAt"],
      expiresAt: timestamp(new Date(row.expires_at).toISOString()) as DeviceLeaseRecord["expiresAt"],
      revocable: true,
      leaseVersion: dbDecimal(String(row.lease_version)) as DeviceLeaseRecord["leaseVersion"],
      fencingToken: dbDecimal(String(row.fencing_token)) as DeviceLeaseRecord["fencingToken"],
      policyDecisionRef: cloneOpaque(row.policy_decision_ref) as DeviceLeaseRecord["policyDecisionRef"],
    };
  }

  private async readIdempotencyForT11B(
    client: PoolClient,
    operation: string,
    idempotencyKey: string,
  ): Promise<T11BIdempotencyRecord | undefined> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [operation + ":" + idempotencyKey],
    );
    const result = await client.query(
      [
        "SELECT request_hash, request_fingerprint, response, response_hash, status",
        "FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2 FOR UPDATE",
      ].join(" "),
      [operation, idempotencyKey],
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0]!;
    if (row.status !== "committed" || row.response === null || row.response === undefined ||
        typeof row.request_hash !== "string" || !HASH.test(String(row.request_hash).trim()) ||
        typeof row.request_fingerprint !== "string" || row.request_fingerprint.length === 0 ||
        typeof row.response_hash !== "string" || !HASH.test(String(row.response_hash).trim())) {
      throw new IndeterminateOperationError();
    }
    if (String(row.request_hash).trim() !== sha256Text(row.request_fingerprint)) {
      throw new IndeterminateOperationError();
    }
    const response = cloneOpaque(row.response);
    if (jsonHash(response) !== String(row.response_hash).trim()) throw new RealtimeAuthorityConflictError();
    return {
      operation: operation as T11BIdempotencyRecord["operation"],
      idempotencyKey,
      requestFingerprint: row.request_fingerprint,
      result: response,
    };
  }

  private async recordT11BIndeterminate(
    context: { readonly operation: string; readonly idempotencyKey: string },
  ): Promise<void> {
    const requestFingerprint = context.operation + ":" + context.idempotencyKey;
    const requestHash = sha256Text(requestFingerprint);
    let operation: TerminalFactInput["operation"] | undefined;
    try {
      operation = terminalOperation(context.operation);
    } catch {
      operation = undefined;
    }
    await withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        [
          "INSERT INTO idempotency_ledger (scope, idempotency_key, request_hash, request_fingerprint, status, response,",
          "response_hash, completed_at, created_at, updated_at)",
          "VALUES ($1, $2, $3, $4, 'indeterminate', $5::jsonb, $6, now(), now(), now())",
          "ON CONFLICT (scope, idempotency_key) DO NOTHING",
          "RETURNING idempotency_key",
        ].join(" "),
        [context.operation, context.idempotencyKey, requestHash, requestFingerprint,
          jsonText({ status: "indeterminate", code: "INDETERMINATE_OPERATION" }),
          jsonHash({ status: "indeterminate", code: "INDETERMINATE_OPERATION" })],
      );
      if (inserted.rows.length === 0) return;
      if (operation === undefined) return;
      await this.recordTerminalFact(client, {
        terminalFactId: randomUUID(),
        operation,
        status: "indeterminate",
        requestScope: context.operation,
        idempotencyKey: context.idempotencyKey,
        requestHash,
        operationOutcome: { status: "indeterminate" },
        executionFacts: { status: "indeterminate" },
        createdAt: new Date().toISOString(),
      });
    });
  }

  private async writeSessionForT11B(
    client: PoolClient,
    input: { readonly expectedRevision?: string; readonly record: RealtimeSessionRecord },
  ): Promise<void> {
    const record = input.record;
    const sessionOwnerRef = assertCanonicalOwnerRef(record.realtimeSessionRef, "RealtimeSession");
    const leaseOwnerRef = assertCanonicalOwnerRef(record.activeDeviceLeaseRef, "DeviceLease");
    const sessionId = sessionOwnerRef.ref_id;
    assertUuid(sessionId);
    assertUuid(record.userId);
    assertUuid(record.continuityId);
    assertUuid(record.activeDeviceId);
    const epoch = record.connectionEpoch;
    assertDecimal(epoch);
    const recordRevision = revision(record.revision);
    const binding = record.binding as unknown as Record<string, unknown>;
    if (!isRecord(binding) || !sameOptionalJson(binding.realtimeSessionRef, sessionOwnerRef) ||
        !sameOptionalJson(binding.deviceLeaseRef, leaseOwnerRef) ||
        binding.continuityId !== record.continuityId || binding.deviceId !== record.activeDeviceId ||
        String(binding.connectionEpoch) !== epoch ||
        (binding.state !== "connected" && binding.state !== "disconnected" && binding.state !== "released")) {
      throw new RealtimeAuthorityConflictError();
    }
    const current = await client.query(
      "SELECT revision, connection_epoch, realtime_session_ref, session_object_version, session_payload_sha256 FROM realtime_sessions WHERE session_ref_id = $1 FOR UPDATE",
      [sessionId],
    );
    if (current.rows.length === 0 && input.expectedRevision !== undefined) throw new FencingConflictError();
    if (input.expectedRevision !== undefined && String(current.rows[0]!.revision) !== input.expectedRevision) {
      throw new FencingConflictError();
    }
    if (current.rows.length !== 0) {
      const currentSessionRef = assertCanonicalOwnerRef(current.rows[0]!.realtime_session_ref, "RealtimeSession");
      if (!sameOptionalJson(currentSessionRef, sessionOwnerRef) ||
          String(current.rows[0]!.session_object_version) !== sessionOwnerRef.object_version ||
          String(current.rows[0]!.session_payload_sha256).trim() !== sessionOwnerRef.canonical_payload_sha256) {
        throw new RealtimeAuthorityConflictError();
      }
      const currentRevision = revision(String(current.rows[0]!.revision));
      const currentEpoch = dbDecimal(String(current.rows[0]!.connection_epoch));
      if (compareDecimal(epoch, currentEpoch) < 0 || compareDecimal(recordRevision, currentRevision) <= 0) {
        throw new FencingConflictError();
      }
    }
    const values = [
      sessionId,
      jsonText(sessionOwnerRef),
      sessionOwnerRef.object_version,
      sessionOwnerRef.canonical_payload_sha256,
      record.userId,
      record.continuityId,
      null,
      record.continuityState,
      jsonText(leaseOwnerRef),
      record.activeDeviceId,
      jsonText(record.binding),
      record.state,
      epoch,
      record.lastAcceptedUserActivityAt,
      record.continuityExpiresAt,
      record.terminalAt ?? null,
      record.terminalReason ?? null,
      recordRevision,
    ];
    if (current.rows.length === 0) {
      await client.query(
        [
          "INSERT INTO realtime_sessions (session_ref_id, realtime_session_ref, session_object_version,",
          "session_payload_sha256, user_id, continuity_id, continuity_ref, continuity_state, active_device_lease_ref,",
          "active_device_id, binding, state, connection_epoch, last_accepted_activity_at, continuity_expires_at,",
          "terminal_at, terminal_reason, created_at, updated_at, revision)",
          "VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11::jsonb, $12, $13, $14, $15, COALESCE($16::timestamptz, CASE WHEN $12 = 'active' THEN NULL ELSE now() END), $17, now(), now(), $18)",
        ].join(" "),
        values,
      );
      return;
    }
    await client.query(
      [
        "UPDATE realtime_sessions SET realtime_session_ref = $2::jsonb, session_object_version = $3,",
        "session_payload_sha256 = $4, user_id = $5, continuity_id = $6, continuity_ref = $7::jsonb,",
        "continuity_state = $8, active_device_lease_ref = $9::jsonb, active_device_id = $10, binding = $11::jsonb,",
        "state = $12, connection_epoch = $13, last_accepted_activity_at = $14, continuity_expires_at = $15,",
        "terminal_at = CASE WHEN $12 = 'active' THEN NULL ELSE COALESCE($16::timestamptz, terminal_at, now()) END,",
        "terminal_reason = CASE WHEN $12 = 'active' THEN NULL ELSE COALESCE($17, terminal_reason, 'terminal') END,",
        "updated_at = now(), revision = $18",
        "WHERE session_ref_id = $1",
      ].join(" "),
      values,
    );
  }

  private async writeLeaseForT11B(
    client: PoolClient,
    input: { readonly expectedLeaseVersion?: string; readonly record: DeviceLeaseRecord },
  ): Promise<void> {
    const record = input.record;
    const leaseOwnerRef = assertCanonicalOwnerRef(record.deviceLeaseRef, "DeviceLease");
    const sessionOwnerRef = assertCanonicalOwnerRef(record.realtimeSessionRef, "RealtimeSession");
    const leaseId = leaseOwnerRef.ref_id;
    const sessionId = sessionOwnerRef.ref_id;
    assertUuid(leaseId);
    assertUuid(sessionId);
    assertUuid(record.userId);
    assertUuid(record.deviceId);
    assertUuid(record.continuityId);
    const leaseVersion = record.leaseVersion;
    const fencingToken = record.fencingToken;
    assertDecimal(leaseVersion);
    assertDecimal(fencingToken);
    const session = await client.query(
      "SELECT user_id, continuity_id, realtime_session_ref, session_object_version, session_payload_sha256 FROM realtime_sessions WHERE session_ref_id = $1 FOR UPDATE",
      [sessionId],
    );
    if (session.rows.length !== 1 || String(session.rows[0]!.user_id) !== record.userId ||
        String(session.rows[0]!.continuity_id) !== record.continuityId ||
        !sameOptionalJson(assertCanonicalOwnerRef(session.rows[0]!.realtime_session_ref, "RealtimeSession"), sessionOwnerRef) ||
        String(session.rows[0]!.session_object_version) !== sessionOwnerRef.object_version ||
        String(session.rows[0]!.session_payload_sha256).trim() !== sessionOwnerRef.canonical_payload_sha256) {
      throw new RealtimeAuthorityConflictError();
    }
    const current = await client.query(
      "SELECT session_ref_id, user_id, device_id, continuity_id, lease_version, device_lease_ref, lease_object_version, lease_payload_sha256, realtime_session_ref FROM device_leases WHERE lease_ref_id = $1 FOR UPDATE",
      [leaseId],
    );
    if (current.rows.length === 0 && input.expectedLeaseVersion !== undefined) throw new FencingConflictError();
    if (input.expectedLeaseVersion !== undefined && String(current.rows[0]!.lease_version) !== input.expectedLeaseVersion) {
      throw new FencingConflictError();
    }
    if (current.rows.length !== 0 &&
        (String(current.rows[0]!.session_ref_id) !== sessionId || String(current.rows[0]!.user_id) !== record.userId ||
         String(current.rows[0]!.device_id) !== record.deviceId || String(current.rows[0]!.continuity_id) !== record.continuityId)) {
      throw new RealtimeAuthorityConflictError();
    }
    if (current.rows.length !== 0 &&
        (!sameOptionalJson(assertCanonicalOwnerRef(current.rows[0]!.device_lease_ref, "DeviceLease"), leaseOwnerRef) ||
         String(current.rows[0]!.lease_object_version) !== leaseOwnerRef.object_version ||
         String(current.rows[0]!.lease_payload_sha256).trim() !== leaseOwnerRef.canonical_payload_sha256 ||
         !sameOptionalJson(assertCanonicalOwnerRef(current.rows[0]!.realtime_session_ref, "RealtimeSession"), sessionOwnerRef))) {
      throw new RealtimeAuthorityConflictError();
    }
    if (current.rows.length !== 0 &&
        compareDecimal(leaseVersion, dbDecimal(String(current.rows[0]!.lease_version))) <= 0) {
      throw new FencingConflictError();
    }
    const values = [
      leaseId,
      jsonText(leaseOwnerRef),
      leaseOwnerRef.object_version,
      leaseOwnerRef.canonical_payload_sha256,
      sessionId,
      jsonText(sessionOwnerRef),
      null,
      record.userId,
      record.deviceId,
      record.continuityId,
      jsonText(record.capabilities),
      record.purpose,
      jsonText(record.policyDecisionRef),
      record.revocable,
      record.state,
      leaseVersion,
      fencingToken,
      record.issuedAt,
      record.issuedAt,
      record.expiresAt,
      null,
      null,
    ];
    if (current.rows.length === 0) {
      await client.query(
        [
          "INSERT INTO device_leases (lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256,",
          "session_ref_id, realtime_session_ref, continuity_ref, user_id, device_id, continuity_id, capabilities, purpose,",
          "policy_decision_ref, capability_scope, purpose_scope, policy_binding, revocable, state, lease_version, fencing_token, issued_at, acquired_at, expires_at, released_at,",
          "revoked_at, updated_at)",
          "VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, $12, $13::jsonb,",
          "$11::jsonb, to_jsonb($12::text), $13::jsonb, $14, $15, $16, $17, $18, $19, $20, COALESCE($21::timestamptz, CASE WHEN $15 = 'released' THEN now() ELSE NULL END),",
          "COALESCE($22::timestamptz, CASE WHEN $15 = 'revoked' THEN now() ELSE NULL END), now())",
        ].join(" "),
        values,
      );
      return;
    }
    await client.query(
      [
        "UPDATE device_leases SET device_lease_ref = $2::jsonb, lease_object_version = $3, lease_payload_sha256 = $4,",
        "session_ref_id = $5, realtime_session_ref = $6::jsonb, continuity_ref = $7::jsonb, user_id = $8,",
        "device_id = $9, continuity_id = $10, capabilities = $11::jsonb, purpose = $12, policy_decision_ref = $13::jsonb,",
        "capability_scope = $11::jsonb, purpose_scope = to_jsonb($12::text), policy_binding = $13::jsonb,",
        "revocable = $14, state = $15, lease_version = $16, fencing_token = $17, expires_at = $18,",
        "released_at = CASE WHEN $15 = 'released' THEN COALESCE(released_at, now()) ELSE NULL END,",
        "revoked_at = CASE WHEN $15 = 'revoked' THEN COALESCE(revoked_at, now()) ELSE NULL END,",
        "updated_at = now() WHERE lease_ref_id = $1",
      ].join(" "),
      [...values.slice(0, 17), record.expiresAt],
    );
    if (record.state !== "active") {
      await client.query(
        "UPDATE realtime_transport_aliases SET active = FALSE, retired_at = COALESCE(retired_at, now()) WHERE session_ref_id = $1 AND lease_ref_id = $2 AND active = TRUE",
        [sessionId, leaseId],
      );
    }
  }

  private async writeBindingForT11B(
    client: PoolClient,
    input: { readonly expectedConnectionEpoch?: string; readonly binding: RealtimeTransportBinding },
  ): Promise<void> {
    const sessionId = ownerStorageIdentifier(input.binding.realtimeSessionRef, "RealtimeSession");
    const leaseId = ownerStorageIdentifier(input.binding.deviceLeaseRef, "DeviceLease");
    assertUuid(sessionId);
    assertUuid(leaseId);
    assertUuid(input.binding.deviceId);
    const epoch = input.binding.connectionEpoch;
    assertDecimal(epoch);
    assertUuid(input.binding.continuityId);
    const current = await client.query(
      "SELECT connection_epoch, realtime_session_ref, session_object_version, session_payload_sha256, continuity_id, user_id, active_device_id, active_device_lease_ref, state, continuity_state FROM realtime_sessions WHERE session_ref_id = $1 FOR UPDATE",
      [sessionId],
    );
    if (current.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    const sessionRow = current.rows[0]!;
    const currentSessionRef = assertCanonicalOwnerRef(sessionRow.realtime_session_ref, "RealtimeSession");
    const currentActiveLeaseRef = assertCanonicalOwnerRef(sessionRow.active_device_lease_ref, "DeviceLease");
    if (!sameOptionalJson(currentSessionRef, input.binding.realtimeSessionRef) ||
        String(sessionRow.session_object_version) !== currentSessionRef.object_version ||
        String(sessionRow.session_payload_sha256).trim() !== currentSessionRef.canonical_payload_sha256 ||
        String(sessionRow.continuity_id) !== input.binding.continuityId ||
        String(sessionRow.active_device_id) !== input.binding.deviceId ||
        !sameOptionalJson(currentActiveLeaseRef, input.binding.deviceLeaseRef) ||
        currentActiveLeaseRef.ref_id !== leaseId ||
        (sessionRow.state !== "active" && sessionRow.state !== "terminal") ||
        (sessionRow.continuity_state !== "active" && sessionRow.continuity_state !== "ended")) {
      throw new RealtimeAuthorityConflictError();
    }
    if (input.expectedConnectionEpoch !== undefined &&
        String(sessionRow.connection_epoch) !== input.expectedConnectionEpoch) {
      throw new FencingConflictError();
    }
    if (epoch !== String(sessionRow.connection_epoch)) throw new FencingConflictError();
    const leaseState = await client.query(
      "SELECT session_ref_id, user_id, device_id, continuity_id, state, device_lease_ref, lease_object_version, lease_payload_sha256, realtime_session_ref FROM device_leases WHERE lease_ref_id = $1 FOR UPDATE",
      [leaseId],
    );
    const leaseRow = leaseState.rows[0];
    const currentLeaseRef = leaseRow === undefined ? undefined : assertCanonicalOwnerRef(leaseRow.device_lease_ref, "DeviceLease");
    const currentLeaseSessionRef = leaseRow === undefined ? undefined : assertCanonicalOwnerRef(leaseRow.realtime_session_ref, "RealtimeSession");
    const bindingConflict = leaseState.rows.length !== 1 || String(leaseRow?.session_ref_id) !== sessionId ||
      String(leaseRow?.user_id) !== String(sessionRow.user_id) || String(leaseRow?.device_id) !== input.binding.deviceId ||
      String(leaseRow?.continuity_id) !== input.binding.continuityId ||
      currentLeaseRef === undefined || !sameOptionalJson(currentLeaseRef, input.binding.deviceLeaseRef) ||
      String(leaseRow?.lease_object_version) !== currentLeaseRef?.object_version ||
      String(leaseRow?.lease_payload_sha256).trim() !== currentLeaseRef?.canonical_payload_sha256 ||
      currentLeaseSessionRef === undefined || !sameOptionalJson(currentLeaseSessionRef, input.binding.realtimeSessionRef) ||
       (leaseRow?.state !== "active" && leaseRow?.state !== "released" && leaseRow?.state !== "expired" && leaseRow?.state !== "revoked") ||
       (input.binding.state === "connected" &&
        (sessionRow.state !== "active" || sessionRow.continuity_state !== "active" ||
         leaseRow?.state !== "active"));
    if (bindingConflict) {
      throw new RealtimeAuthorityConflictError();
    }
    await client.query(
      [
        "UPDATE realtime_sessions SET binding = $2::jsonb, connection_epoch = $3,",
        "active_device_id = $4, active_device_lease_ref = $5::jsonb, updated_at = now()",
        "WHERE session_ref_id = $1",
      ].join(" "),
      [sessionId, jsonText(input.binding), epoch, input.binding.deviceId, jsonText(input.binding.deviceLeaseRef)],
    );
    if (input.binding.state !== "connected" || leaseRow?.state !== "active") {
      await client.query(
        "UPDATE realtime_transport_aliases SET active = FALSE, retired_at = COALESCE(retired_at, now()) WHERE session_ref_id = $1 AND lease_ref_id = $2 AND active = TRUE",
        [sessionId, leaseId],
      );
      return;
    }
    await client.query(
      "UPDATE realtime_transport_aliases SET active = FALSE, retired_at = COALESCE(retired_at, now()) WHERE session_ref_id = $1 AND lease_ref_id = $2 AND active = TRUE AND connection_epoch < $3",
      [sessionId, leaseId, epoch],
    );
    const aliases = [
      ["provider_alias", aliasText(input.binding.provider)],
      ["livekit_session", aliasText(input.binding.transportSessionAlias)],
      ["livekit_room", aliasText(input.binding.roomAlias)],
      ["livekit_participant", aliasText(input.binding.deviceAlias)],
    ] as const;
    for (const [kind, value] of aliases) {
      await client.query(
        "UPDATE realtime_transport_aliases SET active = FALSE, retired_at = COALESCE(retired_at, now()) WHERE session_ref_id = $1 AND lease_ref_id = $2 AND connection_epoch = $3 AND alias_kind = $4 AND alias_value <> $5 AND active = TRUE",
        [sessionId, leaseId, epoch, kind, value],
      );
      await client.query(
        [
          "INSERT INTO realtime_transport_aliases (session_ref_id, lease_ref_id, connection_epoch, alias_kind, alias_value, active, created_at)",
          "VALUES ($1, $2, $3, $4, $5, TRUE, now())",
          "ON CONFLICT (session_ref_id, lease_ref_id, connection_epoch, alias_kind, alias_value)",
          "DO UPDATE SET active = TRUE, retired_at = NULL",
        ].join(" "),
        [sessionId, leaseId, epoch, kind, value],
      );
    }
  }

  private async writeIdempotencyForT11B(
    client: PoolClient,
    record: T11BIdempotencyRecord,
  ): Promise<void> {
    const requestFingerprint = record.requestFingerprint;
    if (typeof requestFingerprint !== "string" || requestFingerprint.length === 0) {
      throw new TypeError("invalid T11B request fingerprint");
    }
    const scope = String(record.operation);
    const requestHash = sha256Text(requestFingerprint);
    const responseHash = jsonHash(record.result);
    const existing = await client.query(
      "SELECT request_hash, request_fingerprint, response, response_hash, status FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2 FOR UPDATE",
      [scope, record.idempotencyKey],
    );
    if (existing.rows.length === 1) {
      if (String(existing.rows[0]!.request_fingerprint ?? "") !== requestFingerprint ||
          String(existing.rows[0]!.request_hash ?? "").trim() !== requestHash) {
        throw new RealtimeAuthorityConflictError();
      }
      if (existing.rows[0]!.status !== "committed" || typeof existing.rows[0]!.response_hash !== "string" ||
          String(existing.rows[0]!.response_hash).trim() !== jsonHash(existing.rows[0]!.response) ||
          jsonText(existing.rows[0]!.response) !== jsonText(record.result)) {
        throw new RealtimeAuthorityConflictError();
      }
      return;
    }
    await client.query(
      [
        "INSERT INTO idempotency_ledger (scope, idempotency_key, request_hash, request_fingerprint, status, response,",
        "response_hash, completed_at, created_at, updated_at)",
        "VALUES ($1, $2, $3, $4, 'committed', $5::jsonb, $6, now(), now(), now())",
        "ON CONFLICT (scope, idempotency_key) DO NOTHING",
      ].join(" "),
      [scope, record.idempotencyKey, requestHash, requestFingerprint, jsonText(record.result), responseHash],
    );
    const verify = await client.query(
      "SELECT request_fingerprint FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2 FOR UPDATE",
      [scope, record.idempotencyKey],
    );
    if (verify.rows.length !== 1 || String(verify.rows[0]!.request_fingerprint) !== requestFingerprint) {
      throw new RealtimeAuthorityConflictError();
    }
    const result = isRecord(record.result) && isRecord(record.result.receipt)
      ? record.result.receipt
      : isRecord(record.result) && record.result.kind === "realtime_terminal_receipt"
        ? record.result
        : undefined;
    if (result !== undefined) {
      const receipt = result;
      const sessionRefId = ownerRefIdOrUndefined(receipt.realtimeSessionRef, "RealtimeSession");
      const leaseRefId = ownerRefIdOrUndefined(receipt.deviceLeaseRef, "DeviceLease");
      const continuityId = typeof receipt.continuityId === "string" && UUID_V7.test(receipt.continuityId)
        ? receipt.continuityId
        : undefined;
      const connectionEpoch = typeof receipt.connectionEpoch === "string" && DECIMAL.test(receipt.connectionEpoch)
        ? receipt.connectionEpoch
        : undefined;
      const terminalFact: TerminalFactInput = {
        terminalFactId: randomUUID(),
        operation: terminalOperation(receipt.operation),
        status: terminalStatus(receipt.status),
        requestScope: scope,
        idempotencyKey: record.idempotencyKey,
        requestHash,
        ...(sessionRefId === undefined ? {} : { sessionRefId }),
        ...(leaseRefId === undefined ? {} : { leaseRefId }),
        ...(continuityId === undefined ? {} : { continuityId }),
        ...(receipt.realtimeSessionRef === undefined ? {} : { realtimeSessionRef: receipt.realtimeSessionRef }),
        ...(receipt.deviceLeaseRef === undefined ? {} : { deviceLeaseRef: receipt.deviceLeaseRef }),
        ...(receipt.continuityRef === undefined ? {} : { continuityRef: receipt.continuityRef }),
        ...(connectionEpoch === undefined ? {} : { connectionEpoch }),
        operationOutcome: receipt.outcome,
        executionFacts: receipt.errorCode === undefined
          ? { status: receipt.status }
          : { status: receipt.status, errorCode: receipt.errorCode },
        createdAt: timestamp(receipt.recordedAt),
      };
      await this.recordTerminalFact(client, terminalFact);
    }
  }

  private async recordHandoffFactForT11B(
    client: PoolClient,
    record: HandoffFactRecord,
  ): Promise<void> {
    await this.recordHandoffFact(client, handoffFactInputFromT11BRecord(record));
  }

  private async appendOutboxForT11B(
    client: PoolClient,
    event: OutboxEvent,
  ): Promise<OpaqueCanonicalRef> {
    const eventId = randomUUID();
    const aggregateId = ownerRefIdOrUndefined(event.aggregateRef, "RealtimeSession");
    if (aggregateId === undefined) throw new RealtimeAuthorityConflictError();
    const payloadHash = jsonHash(event.payload);
    const inserted = await client.query(
      [
        "INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version,",
        "idempotency_scope, idempotency_key, payload, payload_sha256, available_at, created_at, updated_at)",
        "VALUES ($1, $2, $3, $4::jsonb, $5, 1, 'realtime.outbox', $6, $7::jsonb, $8, $9, now(), now())",
        "ON CONFLICT (idempotency_scope, idempotency_key, event_type) DO NOTHING RETURNING event_id",
      ].join(" "),
      [
        eventId,
        "realtime",
        aggregateId,
        jsonText(event.aggregateRef),
        event.eventType,
        event.idempotencyKey,
        jsonText(event.payload),
        payloadHash,
        event.occurredAt,
      ],
    );
    if (inserted.rows.length === 1) return String(inserted.rows[0]!.event_id);
    const existing = await client.query(
      "SELECT event_id, aggregate_type, aggregate_id, aggregate_ref, event_version, payload, payload_sha256 FROM outbox_events WHERE idempotency_scope = 'realtime.outbox' AND idempotency_key = $1 AND event_type = $2 FOR UPDATE",
      [event.idempotencyKey, event.eventType],
    );
    if (existing.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    const row = existing.rows[0]!;
    if (String(row.aggregate_type) !== "realtime" || String(row.aggregate_id) !== aggregateId ||
        Number(row.event_version) !== 1 || String(row.payload_sha256).trim() !== payloadHash ||
        jsonText(row.aggregate_ref) !== jsonText(event.aggregateRef) ||
        jsonText(row.payload) !== jsonText(event.payload)) {
      throw new RealtimeAuthorityConflictError();
    }
    return String(row.event_id);
  }

  async runAtomic<T>(
    input: AtomicOperationInput,
    work: (client: PoolClient) => Promise<AtomicOperationCommit<T>>,
  ): Promise<AtomicOperationResult<T>> {
    try {
      return await withTransaction(this.pool, async (client) => {
      const claim = await claimIdempotency(client, input);
      if (claim.kind === "replay" || claim.kind === "terminal") {
        return {
          kind: "replayed" as const,
          response: claim.record.response as T,
          idempotency: claim.record,
        };
      }
      if (claim.kind === "in_flight") throw new IndeterminateOperationError();
      const commit = await work(client);
      if (!commit || typeof commit.responseHash !== "string") {
        throw new TypeError("invalid atomic operation commit");
      }
      if (commit.terminalFact !== undefined) {
        const fact = commit.terminalFact;
        if (fact.requestScope !== input.scope || fact.idempotencyKey !== input.idempotencyKey ||
            fact.requestHash !== input.requestHash) {
          throw new RealtimeAuthorityConflictError();
        }
        await this.recordTerminalFact(client, fact);
      }
      for (const event of commit.outboxEvents ?? []) {
        await enqueueOutboxEvent(client, event);
      }
      const idempotency = await completeIdempotency(
        client,
        input,
        commit.response,
        commit.responseHash,
      );
      return { kind: "committed" as const, response: commit.response, idempotency };
      });
    } catch (error) {
      if (isPostgresTxOutcomeUncertain(error) && typeof input.scope === "string" && input.scope.length > 0 &&
          typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0 &&
          HASH.test(input.requestHash)) {
        await this.recordAtomicIndeterminate(input).catch(() => undefined);
      }
      throw error;
    }
  }

  private async recordAtomicIndeterminate(input: AtomicOperationInput): Promise<void> {
    const response = { status: "indeterminate", code: "INDETERMINATE_OPERATION" };
    const responseText = jsonText(response);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        [
          "INSERT INTO idempotency_ledger (scope, idempotency_key, request_hash, request_fingerprint, status, response,",
          "response_hash, completed_at, created_at, updated_at)",
          "VALUES ($1, $2, $3, $4, 'indeterminate', $5::jsonb, $6, now(), now(), now())",
          "ON CONFLICT (scope, idempotency_key) DO NOTHING",
        ].join(" "),
        [input.scope, input.idempotencyKey, input.requestHash, input.requestHash, responseText, sha256Text(responseText)],
      );
    });
  }

  async persistSession(client: PoolClient, input: RealtimeSessionRowInput): Promise<void> {
    assertRef(input.sessionRef, "RealtimeSession");
    assertUuid(input.userId);
    assertUuid(input.continuityId);
    assertDecimal(input.connectionEpoch);
    if (input.expectedConnectionEpoch !== undefined) assertDecimal(input.expectedConnectionEpoch);
    const current = await client.query(
      "SELECT connection_epoch FROM realtime_sessions WHERE session_ref_id = $1 FOR UPDATE",
      [input.sessionRef.refId],
    );
    if (current.rows.length === 0) {
      if (input.expectedConnectionEpoch !== undefined) throw new FencingConflictError();
      await client.query(
        [
          "INSERT INTO realtime_sessions (session_ref_id, session_object_version, session_payload_sha256,",
          "user_id, continuity_id, state, connection_epoch, last_accepted_activity_at, continuity_expires_at,",
          "terminal_at, terminal_reason, created_at, updated_at)",
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        ].join(" "),
        [
          input.sessionRef.refId,
          input.sessionRef.objectVersion,
          input.sessionRef.canonicalPayloadSha256,
          input.userId,
          input.continuityId,
          input.state,
          input.connectionEpoch,
          input.lastAcceptedActivityAt ?? null,
          input.continuityExpiresAt,
          input.terminalAt ?? null,
          input.terminalReason ?? null,
          input.createdAt,
          input.updatedAt,
        ],
      );
      return;
    }
    const currentEpoch = String(current.rows[0]!.connection_epoch);
    if (input.expectedConnectionEpoch !== undefined && currentEpoch !== input.expectedConnectionEpoch) {
      throw new FencingConflictError();
    }
    if (compareDecimal(input.connectionEpoch, currentEpoch) < 0) throw new FencingConflictError();
    await client.query(
      [
        "UPDATE realtime_sessions SET session_object_version = $2, session_payload_sha256 = $3,",
        "user_id = $4, continuity_id = $5, state = $6, connection_epoch = $7,",
        "last_accepted_activity_at = $8, continuity_expires_at = $9, terminal_at = $10,",
        "terminal_reason = $11, updated_at = $12 WHERE session_ref_id = $1",
      ].join(" "),
      [
        input.sessionRef.refId,
        input.sessionRef.objectVersion,
        input.sessionRef.canonicalPayloadSha256,
        input.userId,
        input.continuityId,
        input.state,
        input.connectionEpoch,
        input.lastAcceptedActivityAt ?? null,
        input.continuityExpiresAt,
        input.terminalAt ?? null,
        input.terminalReason ?? null,
        input.updatedAt,
      ],
    );
  }

  async persistDeviceLease(client: PoolClient, input: DeviceLeaseRowInput): Promise<void> {
    assertRef(input.leaseRef, "DeviceLease");
    assertUuid(input.sessionRefId);
    assertUuid(input.userId);
    assertUuid(input.deviceId);
    assertUuid(input.continuityId);
    assertDecimal(input.leaseVersion);
    if (input.expectedLeaseVersion !== undefined) assertDecimal(input.expectedLeaseVersion);
    const current = await client.query(
      "SELECT lease_version FROM device_leases WHERE lease_ref_id = $1 FOR UPDATE",
      [input.leaseRef.refId],
    );
    if (current.rows.length === 0) {
      if (input.expectedLeaseVersion !== undefined) throw new FencingConflictError();
      await client.query(
        [
          "INSERT INTO device_leases (lease_ref_id, lease_object_version, lease_payload_sha256, session_ref_id,",
          "user_id, device_id, continuity_id, lease_version, state, capability_scope, purpose_scope, policy_binding,",
          "acquired_at, expires_at, released_at, revoked_at, updated_at)",
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17)",
        ].join(" "),
        [
          input.leaseRef.refId,
          input.leaseRef.objectVersion,
          input.leaseRef.canonicalPayloadSha256,
          input.sessionRefId,
          input.userId,
          input.deviceId,
          input.continuityId,
          input.leaseVersion,
          input.state,
          jsonText(input.capabilityScope),
          jsonText(input.purposeScope),
          jsonText(input.policyBinding),
          input.acquiredAt,
          input.expiresAt,
          input.releasedAt ?? null,
          input.revokedAt ?? null,
          input.updatedAt,
        ],
      );
      return;
    }
    const currentVersion = String(current.rows[0]!.lease_version);
    if (input.expectedLeaseVersion !== undefined && currentVersion !== input.expectedLeaseVersion) {
      throw new FencingConflictError();
    }
    if (compareDecimal(input.leaseVersion, currentVersion) < 0) throw new FencingConflictError();
    await client.query(
      [
        "UPDATE device_leases SET lease_object_version = $2, lease_payload_sha256 = $3, session_ref_id = $4,",
        "user_id = $5, device_id = $6, continuity_id = $7, lease_version = $8, state = $9,",
        "capability_scope = $10::jsonb, purpose_scope = $11::jsonb, policy_binding = $12::jsonb,",
        "acquired_at = $13, expires_at = $14, released_at = $15, revoked_at = $16, updated_at = $17",
        "WHERE lease_ref_id = $1",
      ].join(" "),
      [
        input.leaseRef.refId,
        input.leaseRef.objectVersion,
        input.leaseRef.canonicalPayloadSha256,
        input.sessionRefId,
        input.userId,
        input.deviceId,
        input.continuityId,
        input.leaseVersion,
        input.state,
        jsonText(input.capabilityScope),
        jsonText(input.purposeScope),
        jsonText(input.policyBinding),
        input.acquiredAt,
        input.expiresAt,
        input.releasedAt ?? null,
        input.revokedAt ?? null,
        input.updatedAt,
      ],
    );
  }

  async persistTransportAlias(client: PoolClient, input: TransportAliasInput): Promise<void> {
    assertUuid(input.sessionRefId);
    assertUuid(input.leaseRefId);
    assertDecimal(input.connectionEpoch);
    if (input.aliasValue.length === 0 || input.aliasValue.length > 512) throw new TypeError("invalid transport alias");
    await client.query(
      [
        "INSERT INTO realtime_transport_aliases (session_ref_id, lease_ref_id, connection_epoch, alias_kind, alias_value,",
        "active, created_at) VALUES ($1, $2, $3, $4, $5, TRUE, $6)",
        "ON CONFLICT (session_ref_id, lease_ref_id, connection_epoch, alias_kind, alias_value)",
        "DO UPDATE SET active = TRUE, retired_at = NULL",
      ].join(" "),
      [input.sessionRefId, input.leaseRefId, input.connectionEpoch, input.aliasKind, input.aliasValue, input.createdAt],
    );
  }

  async recordTerminalFact(client: PoolClient, input: TerminalFactInput): Promise<TerminalFactResult> {
    assertInternalUuid(input.terminalFactId);
    assertHash(input.requestHash);
    if (input.sessionRefId !== undefined) assertUuid(input.sessionRefId);
    if (input.leaseRefId !== undefined) assertUuid(input.leaseRefId);
    if (input.continuityId !== undefined) assertUuid(input.continuityId);
    if (input.connectionEpoch !== undefined) assertDecimal(input.connectionEpoch);
    const realtimeSessionRef = input.realtimeSessionRef === undefined
      ? null
      : jsonText(assertCanonicalOwnerRef(input.realtimeSessionRef, "RealtimeSession"));
    const deviceLeaseRef = input.deviceLeaseRef === undefined
      ? null
      : jsonText(assertCanonicalOwnerRef(input.deviceLeaseRef, "DeviceLease"));
    const continuityRef = input.continuityRef === undefined ? null : jsonText(input.continuityRef);
    const inserted = await client.query(
      [
        "INSERT INTO realtime_terminal_facts (terminal_fact_id, operation, status, request_scope, idempotency_key,",
        "request_hash, session_ref_id, lease_ref_id, continuity_id, connection_epoch, realtime_session_ref, device_lease_ref, continuity_ref, operation_outcome,",
        "execution_facts, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16)",
        "ON CONFLICT (request_scope, idempotency_key) DO NOTHING",
        "RETURNING terminal_fact_id",
      ].join(" "),
      [
        input.terminalFactId,
        input.operation,
        input.status,
        input.requestScope,
        input.idempotencyKey,
        input.requestHash,
        input.sessionRefId ?? null,
        input.leaseRefId ?? null,
        input.continuityId ?? null,
        input.connectionEpoch ?? null,
        realtimeSessionRef,
        deviceLeaseRef,
        continuityRef,
        jsonText(input.operationOutcome),
        jsonText(input.executionFacts),
        input.createdAt,
      ],
    );
    if (inserted.rows.length === 1) return { kind: "committed", fact: input };
    const existing = await client.query(
      [
        "SELECT terminal_fact_id, operation, status, request_scope, idempotency_key, request_hash,",
        "session_ref_id, lease_ref_id, continuity_id, connection_epoch, realtime_session_ref, device_lease_ref, continuity_ref, operation_outcome, execution_facts, created_at",
        "FROM realtime_terminal_facts WHERE request_scope = $1 AND idempotency_key = $2 FOR UPDATE",
      ].join(" "),
      [input.requestScope, input.idempotencyKey],
    );
    if (existing.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    const fact = terminalFactFromRow(existing.rows[0]!);
    if (fact.requestHash !== input.requestHash || fact.operation !== input.operation || fact.status !== input.status ||
        fact.sessionRefId !== input.sessionRefId || fact.leaseRefId !== input.leaseRefId ||
        fact.continuityId !== input.continuityId || fact.connectionEpoch !== input.connectionEpoch ||
        !sameOptionalJson(fact.realtimeSessionRef, input.realtimeSessionRef) ||
        !sameOptionalJson(fact.deviceLeaseRef, input.deviceLeaseRef) ||
        !sameOptionalJson(fact.continuityRef, input.continuityRef) ||
        jsonText(fact.operationOutcome) !== jsonText(input.operationOutcome) ||
        jsonText(fact.executionFacts) !== jsonText(input.executionFacts)) {
      throw new RealtimeAuthorityConflictError();
    }
    return { kind: "replayed", fact };
  }

  async recordHandoffFact(client: PoolClient, input: HandoffFactInput): Promise<HandoffFactResult> {
    assertInternalUuid(input.handoffRefId);
    assertUuid(input.sessionRefId);
    assertUuid(input.continuityId);
    assertUuid(input.fromDeviceId);
    assertUuid(input.toDeviceId);
    assertDecimal(input.expectedLeaseVersion);
    assertDecimal(input.resultingLeaseVersion);
    assertDecimal(input.connectionEpoch);
    assertHash(input.requestHash);
    const inserted = await client.query(
      [
        "INSERT INTO realtime_handoff_facts (handoff_ref_id, session_ref_id, continuity_id, from_device_id, to_device_id,",
        "expected_lease_version, resulting_lease_version, connection_epoch, request_scope, idempotency_key, request_hash,",
        "outcome, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)",
        "ON CONFLICT (request_scope, idempotency_key) DO NOTHING RETURNING handoff_ref_id",
      ].join(" "),
      [
        input.handoffRefId,
        input.sessionRefId,
        input.continuityId,
        input.fromDeviceId,
        input.toDeviceId,
        input.expectedLeaseVersion,
        input.resultingLeaseVersion,
        input.connectionEpoch,
        input.requestScope,
        input.idempotencyKey,
        input.requestHash,
        jsonText(input.outcome),
        input.occurredAt,
      ],
    );
    if (inserted.rows.length === 1) return { kind: "committed", fact: input };
    const existing = await client.query(
      [
        "SELECT handoff_ref_id, session_ref_id, continuity_id, from_device_id, to_device_id,",
        "expected_lease_version, resulting_lease_version, connection_epoch, request_scope, idempotency_key,",
        "request_hash, outcome, occurred_at FROM realtime_handoff_facts",
        "WHERE request_scope = $1 AND idempotency_key = $2 FOR UPDATE",
      ].join(" "),
      [input.requestScope, input.idempotencyKey],
    );
    if (existing.rows.length !== 1) throw new RealtimeAuthorityConflictError();
    const fact = handoffFactFromRow(existing.rows[0]!);
    if (fact.requestHash !== input.requestHash || fact.sessionRefId !== input.sessionRefId ||
        fact.continuityId !== input.continuityId || fact.fromDeviceId !== input.fromDeviceId ||
        fact.toDeviceId !== input.toDeviceId || fact.expectedLeaseVersion !== input.expectedLeaseVersion ||
        fact.resultingLeaseVersion !== input.resultingLeaseVersion || fact.connectionEpoch !== input.connectionEpoch ||
        jsonText(fact.outcome) !== jsonText(input.outcome)) {
      throw new RealtimeAuthorityConflictError();
    }
    return { kind: "replayed", fact };
  }
}

export function createRealtimeAuthorityRepository(pool: Pool): RealtimeAuthorityRepository {
  return new RealtimeAuthorityRepository(pool);
}

export async function withRealtimeAuthorityTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, work);
}
