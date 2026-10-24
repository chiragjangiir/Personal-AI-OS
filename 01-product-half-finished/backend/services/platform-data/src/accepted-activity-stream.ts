import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  CanonicalTimestamp,
  OpaqueCanonicalRef,
  OpaqueOwnerValue,
} from "../../realtime-core/src/types.ts";
import { withTransaction } from "./transaction.ts";

/** The T02-owned accepted-activity substream added by migration 0006. */
export const ACCEPTED_ACTIVITY_EVENT_TYPE = "realtime.continuity.renewed" as const;
/** The full owner event profile added by migration 0007. */
export const T04_ACCEPTED_ACTIVITY_EVENT_TYPE = "realtime.t04.accepted_user_activity.v1" as const;
export const REALTIME_T04_ACCEPTED_USER_ACTIVITY_EVENT_TYPE = T04_ACCEPTED_ACTIVITY_EVENT_TYPE;
export const ACCEPTED_ACTIVITY_STREAM_CHANNEL = "paios_accepted_activity_v1" as const;
export const ACCEPTED_ACTIVITY_LEDGER_SCOPE = "activity_renewal" as const;
export const ACCEPTED_ACTIVITY_OUTBOX_SCOPE = "realtime.outbox" as const;
export const ACCEPTED_ACTIVITY_EVENT_VERSION = 1 as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;
const CURSOR = /^(0|[1-9][0-9]*)$/u;
const MAX_BIGINT = "9223372036854775807";
const NOTIFICATION_NAME = "notification" as const;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/u;
const ACTIVITY_KEYS = Object.freeze([
  "activityId", "kind", "userId", "deviceId", "realtimeSessionRef",
  "continuityId", "occurredAt", "acceptanceRef", "accepted",
] as const);
const RENEWAL_PAYLOAD_KEYS = Object.freeze([
  "activityId", "continuityId", "acceptanceRef", "authorityWatermark",
] as const);
const T04_PAYLOAD_KEYS = Object.freeze([
  "activityId", "continuityId", "acceptanceRef", "authorityWatermark",
  "actionReceipt", "currentBinding", "authorityProjection",
] as const);
const T04_RECEIPT_KEYS = Object.freeze([
  "kind", "activityId", "action", "purpose", "origin", "committed", "revoked",
  "deleted", "stale", "bindingCommitted",
] as const);
const T04_WATCH_RECEIPT_KEYS = Object.freeze([...T04_RECEIPT_KEYS, "watchAuthorityEvidenceRef"] as const);
const T04_BINDING_KEYS = Object.freeze([
  "userId", "activeDeviceId", "realtimeSessionRef", "continuityId", "sessionState",
  "continuityState", "transportState", "leaseState", "lastAcceptedUserActivityAt",
  "continuityExpiresAt", "leaseExpiresAt",
] as const);
const T04_PROJECTION_KEYS = Object.freeze([
  "kind", "environment", "activityId", "origin", "userOriginated", "accepted", "current",
  "deleted", "suppressed", "stale", "purpose", "userId", "deviceId", "realtimeSessionRef",
  "continuityId", "sessionTime", "acceptanceRef", "authorityWatermark", "watermarkCurrent", "evidence",
] as const);
const T04_ACTIONS = new Set([
  "explicit_voice_command", "button_submit", "cycling_start", "cycling_pause",
  "cycling_resume", "cycling_lap", "navigation_enable", "navigation_disable", "explicit_handoff",
]);
const REF_KEYS = Object.freeze([
  "ref_type", "ref_id", "object_version", "canonical_payload_sha256",
] as const);

type PlainRecord = Record<string, unknown>;

export type AcceptedActivityStreamErrorCode =
  | "ACCEPTED_ACTIVITY_STREAM_POOL_REQUIRED"
  | "ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID"
  | "ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID"
  | "ACCEPTED_ACTIVITY_STREAM_LIMIT_INVALID"
  | "ACCEPTED_ACTIVITY_STREAM_CLOSED"
  | "ACCEPTED_ACTIVITY_STREAM_ALREADY_SUBSCRIBED"
  | "ACCEPTED_ACTIVITY_STREAM_REENTRANT_SUBSCRIBE_FORBIDDEN"
  | "ACCEPTED_ACTIVITY_STREAM_CLIENT_INVALID"
  | "ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID"
  | "ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_CONFLICT"
  | "ACCEPTED_ACTIVITY_STREAM_ROW_INVALID"
  | "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT"
  | "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT"
  | "ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT"
  | "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT"
  | "ACCEPTED_ACTIVITY_STREAM_RECONNECT_UNAVAILABLE";

export class AcceptedActivityStreamError extends Error {
  readonly code: AcceptedActivityStreamErrorCode;

  constructor(code: AcceptedActivityStreamErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "AcceptedActivityStreamError";
    this.code = code;
  }
}

/** Structural subset used by both pg.PoolClient and production-shaped fakes. */
export interface AcceptedActivityStreamClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly QueryResultRow[] }>;
  on(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  off?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown;
  release?: (error?: unknown) => void | PromiseLike<void>;
}

export interface AcceptedActivityStreamPool {
  connect(): Promise<AcceptedActivityStreamClient>;
}

export type AcceptedActivityStreamClientFactory =
  () => AcceptedActivityStreamClient | PromiseLike<AcceptedActivityStreamClient>;

export interface AcceptedActivityWakeup {
  readonly cursor: string;
  readonly eventId: string;
}

/** `undefined` is the mandatory initial/reconnect catch-up signal. */
export type AcceptedActivityWakeupHandler =
  (wakeup?: AcceptedActivityWakeup) => void | PromiseLike<void>;

export interface AcceptedActivityRecord {
  readonly cursor: string;
  readonly eventId: string;
  readonly eventType: typeof ACCEPTED_ACTIVITY_EVENT_TYPE | typeof T04_ACCEPTED_ACTIVITY_EVENT_TYPE;
  readonly eventVersion: typeof ACCEPTED_ACTIVITY_EVENT_VERSION;
  readonly activityId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly continuityId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly sessionObjectVersion: string;
  readonly sessionPayloadSha256: string;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly leaseObjectVersion: string;
  readonly leasePayloadSha256: string;
  readonly requestScope: typeof ACCEPTED_ACTIVITY_LEDGER_SCOPE;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly occurredAt: CanonicalTimestamp;
  readonly acceptedAt: CanonicalTimestamp;
  readonly acceptanceRef: OpaqueOwnerValue;
  readonly authorityWatermark: OpaqueOwnerValue;
  readonly connectionEpoch: string;
  readonly sessionRevision: string;
  readonly outboxPayload: Readonly<Record<string, unknown>>;
  readonly outboxPayloadSha256: string;
  /** Present only for the full T04 owner-event profile. */
  readonly actionReceipt?: Readonly<Record<string, unknown>>;
  readonly currentBinding?: Readonly<Record<string, unknown>>;
  readonly authorityProjection?: Readonly<Record<string, unknown>>;
}

export interface AcceptedActivityStreamPage {
  readonly items: readonly AcceptedActivityRecord[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface AcceptedActivityStreamOptions {
  readonly pool: AcceptedActivityStreamPool;
  /** Defaults to legacy; T04 and all are explicit so old readers stay unchanged. */
  readonly source?: AcceptedActivityStreamSource;
  /** A dedicated client for LISTEN. It is released by the stream on close. */
  readonly listenerClient?: AcceptedActivityStreamClient;
  /** Factory for a dedicated LISTEN client and reconnect clients. */
  readonly listenerClientFactory?: AcceptedActivityStreamClientFactory;
  /** Bounded exponential reconnect delay. */
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Runtime failures are reported here without exposing them to the PG event loop. */
  readonly onError?: (error: unknown) => void | PromiseLike<void>;
}

export interface AcceptedActivityStream {
  readAfter(cursor: string, limit: number): Promise<AcceptedActivityStreamPage>;
  readByIdempotency(idempotencyKey: string): Promise<AcceptedActivityRecord | undefined>;
  subscribeWakeups(handler: AcceptedActivityWakeupHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export type AcceptedActivityStreamSource = "legacy" | "t04" | "all";

type FactoryOptions = Omit<AcceptedActivityStreamOptions, "pool">;

const READ_AFTER_SQL = [
  "SELECT",
  "o.accepted_activity_cursor::text AS accepted_activity_cursor,",
  "o.event_id::text AS event_id, o.aggregate_type, o.aggregate_id::text AS aggregate_id,",
  "o.aggregate_ref, o.event_type, o.event_version,",
  "o.idempotency_scope, o.idempotency_key,",
  "o.payload AS outbox_payload, o.payload_sha256 AS outbox_payload_sha256,",
  "l.scope AS ledger_scope, l.idempotency_key AS ledger_idempotency_key,",
  "l.request_hash AS ledger_request_hash, l.request_fingerprint AS ledger_request_fingerprint,",
  "l.status AS ledger_status, l.response AS ledger_response, l.response_hash AS ledger_response_hash",
  "FROM public.outbox_events AS o",
  "LEFT JOIN public.idempotency_ledger AS l",
  "ON l.scope = 'activity_renewal' AND l.idempotency_key = o.idempotency_key",
  "WHERE o.event_type = 'realtime.continuity.renewed'",
  "AND o.idempotency_scope = 'realtime.outbox'",
  "AND o.accepted_activity_cursor IS NOT NULL",
  "AND o.accepted_activity_cursor > $1::bigint",
  "ORDER BY o.accepted_activity_cursor ASC",
  "LIMIT $2",
].join(" ");
const READ_AFTER_T04_SQL = READ_AFTER_SQL.replace(
  "o.event_type = 'realtime.continuity.renewed'",
  "o.event_type = 'realtime.t04.accepted_user_activity.v1'",
);
const READ_AFTER_ALL_SQL = READ_AFTER_SQL.replace(
  "o.event_type = 'realtime.continuity.renewed'",
  "o.event_type IN ('realtime.continuity.renewed', 'realtime.t04.accepted_user_activity.v1')",
);
const READ_BY_IDEMPOTENCY_SQL = [
  "SELECT",
  "o.accepted_activity_cursor::text AS accepted_activity_cursor,",
  "o.event_id::text AS event_id, o.aggregate_type, o.aggregate_id::text AS aggregate_id,",
  "o.aggregate_ref, o.event_type, o.event_version,",
  "o.idempotency_scope, o.idempotency_key,",
  "o.payload AS outbox_payload, o.payload_sha256 AS outbox_payload_sha256,",
  "l.scope AS ledger_scope, l.idempotency_key AS ledger_idempotency_key,",
  "l.request_hash AS ledger_request_hash, l.request_fingerprint AS ledger_request_fingerprint,",
  "l.status AS ledger_status, l.response AS ledger_response, l.response_hash AS ledger_response_hash",
  "FROM public.outbox_events AS o",
  "LEFT JOIN public.idempotency_ledger AS l",
  "ON l.scope = 'activity_renewal' AND l.idempotency_key = o.idempotency_key",
  "WHERE o.event_type = ANY($1::text[])",
  "AND o.idempotency_scope = 'realtime.outbox'",
  "AND o.accepted_activity_cursor IS NOT NULL",
  "AND o.idempotency_key = $2",
  "LIMIT 2",
].join(" ");

function fail(code: AcceptedActivityStreamErrorCode, cause?: unknown): never {
  throw new AcceptedActivityStreamError(code, cause);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
    return value;
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) {
    fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      if (Reflect.ownKeys(value).some((key) => typeof key !== "string") || names.length !== value.length + 1) {
        fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            descriptor.enumerable !== true) {
          fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
        }
        output.push(snapshotJson(descriptor.value, seen));
      }
      return Object.freeze(output);
    }
    if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== Object.keys(value).length) fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
    const output: PlainRecord = {};
    for (const name of names.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) {
        fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
      }
      Object.defineProperty(output, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotJson(descriptor.value, seen),
      });
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  const snapshot = snapshotJson(value);
  const text = JSON.stringify(snapshot);
  if (text === undefined) fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
  return text;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return snapshotJson(JSON.parse(value));
    } catch (error) {
      if (error instanceof AcceptedActivityStreamError) throw error;
      fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID", error);
    }
  }
  return snapshotJson(value);
}

function object(value: unknown, code: AcceptedActivityStreamErrorCode): PlainRecord {
  const snapshot = parseJson(value);
  if (!isPlainRecord(snapshot)) fail(code);
  return snapshot;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  code: AcceptedActivityStreamErrorCode,
): PlainRecord {
  const record = object(value, code);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return record;
}

function text(value: unknown, code: AcceptedActivityStreamErrorCode, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function hashText(value: unknown, code: AcceptedActivityStreamErrorCode): string {
  const result = text(value, code, 64);
  if (!SHA256.test(result)) fail(code);
  return result;
}

function positiveDecimal(value: unknown, code: AcceptedActivityStreamErrorCode): string {
  const result = text(value, code, 38);
  if (!POSITIVE_DECIMAL.test(result)) fail(code);
  return result;
}

function cursor(value: unknown): string {
  const result = text(value, "ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID", 19);
  if (!CURSOR.test(result) || (result.length === MAX_BIGINT.length && result > MAX_BIGINT) ||
      result.length > MAX_BIGINT.length) {
    fail("ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID");
  }
  return result;
}

function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function timestamp(value: unknown, code: AcceptedActivityStreamErrorCode): CanonicalTimestamp {
  let candidate: unknown = value;
  if (candidate instanceof Date) {
    if (!Number.isFinite(candidate.getTime())) fail(code);
    candidate = candidate.toISOString();
  }
  if (typeof candidate !== "string" || !CANONICAL_TIMESTAMP.test(candidate) ||
      !Number.isFinite(Date.parse(candidate))) fail(code);
  return candidate as CanonicalTimestamp;
}

interface CanonicalRef {
  readonly ref_type: "RealtimeSession" | "DeviceLease";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

function canonicalRef(value: unknown, expected: CanonicalRef["ref_type"], code: AcceptedActivityStreamErrorCode): CanonicalRef {
  const record = exactObject(value, REF_KEYS, code);
  if (record.ref_type !== expected || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !POSITIVE_DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256)) {
    fail(code);
  }
  return Object.freeze({
    ref_type: expected,
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

function opaque(value: unknown, code: AcceptedActivityStreamErrorCode): OpaqueOwnerValue {
  const snapshot = parseJson(value);
  if (typeof snapshot === "string") return snapshot as OpaqueOwnerValue;
  if (!isPlainRecord(snapshot)) fail(code);
  return snapshot as OpaqueOwnerValue;
}

function sameJson(left: unknown, right: unknown, code: AcceptedActivityStreamErrorCode): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch (error) {
    if (error instanceof AcceptedActivityStreamError) fail(code, error);
    throw error;
  }
}

function rowValue(row: QueryResultRow, ...names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

interface RequestActivity {
  readonly activityId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly continuityId: string;
  readonly realtimeSessionRef: CanonicalRef;
  readonly occurredAt: CanonicalTimestamp;
  readonly acceptanceRef: OpaqueOwnerValue;
}

function requestActivity(fingerprint: string, t04: boolean): RequestActivity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint);
  } catch (error) {
    fail("ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT", error);
  }
  // T02 fingerprints a T04-owned activity together with its owner event: {activity, ownerEvent}.
  const request = t04 ? exactObject(parsed, ["activity", "ownerEvent"], "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT").activity : parsed;
  const activity = exactObject(request, ACTIVITY_KEYS, "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT");
  if (activity.kind !== "accepted_user_activity" || activity.accepted !== true) {
    fail("ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT");
  }
  const activityId = text(activity.activityId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  const userId = text(activity.userId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  const deviceId = text(activity.deviceId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  const continuityId = text(activity.continuityId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  const realtimeSessionRef = canonicalRef(
    activity.realtimeSessionRef,
    "RealtimeSession",
    "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
  );
  const occurredAt = timestamp(activity.occurredAt, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  const acceptanceRef = opaque(activity.acceptanceRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  if (canonicalJson(parsed) !== fingerprint) fail("ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT");
  return Object.freeze({ activityId, userId, deviceId, continuityId, realtimeSessionRef, occurredAt, acceptanceRef });
}

function eventVersion(value: unknown): 1 {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== ACCEPTED_ACTIVITY_EVENT_VERSION) {
    fail("ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
  }
  return ACCEPTED_ACTIVITY_EVENT_VERSION;
}

function acceptedRecord(row: QueryResultRow): AcceptedActivityRecord {
  try {
    const streamCursor = cursor(rowValue(row, "accepted_activity_cursor", "cursor"));
    const eventId = text(rowValue(row, "event_id", "eventId"), "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT", 128);
    if (!UUID.test(eventId)) fail("ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
    const eventTypeValue = rowValue(row, "event_type", "eventType");
    const isT04 = eventTypeValue === T04_ACCEPTED_ACTIVITY_EVENT_TYPE;
    if (eventTypeValue !== ACCEPTED_ACTIVITY_EVENT_TYPE && !isT04) {
      fail("ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
    }
    const eventType = isT04 ? T04_ACCEPTED_ACTIVITY_EVENT_TYPE : ACCEPTED_ACTIVITY_EVENT_TYPE;
    const version = eventVersion(rowValue(row, "event_version", "eventVersion"));
    if (rowValue(row, "aggregate_type", "aggregateType") !== "realtime" ||
        rowValue(row, "idempotency_scope", "idempotencyScope") !== ACCEPTED_ACTIVITY_OUTBOX_SCOPE) {
      fail("ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
    }
    const aggregateId = text(rowValue(row, "aggregate_id", "aggregateId"), "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT", 128);
    if (!UUID.test(aggregateId)) fail("ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
    const aggregateRef = canonicalRef(
      rowValue(row, "aggregate_ref", "aggregateRef"),
      "RealtimeSession",
      "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT",
    );
    if (aggregateRef.ref_id !== aggregateId) fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");

    const payload = exactObject(
      rowValue(row, "outbox_payload", "payload"),
      isT04 ? T04_PAYLOAD_KEYS : RENEWAL_PAYLOAD_KEYS,
      "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT",
    );
    const payloadHash = hashText(
      rowValue(row, "outbox_payload_sha256", "payload_sha256", "outboxPayloadSha256"),
      "ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT",
    );
    if (jsonHash(payload) !== payloadHash) fail("ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT");

    const ledgerScope = rowValue(row, "ledger_scope", "scope");
    const ledgerKey = text(
      rowValue(row, "ledger_idempotency_key", "ledger_key", "idempotency_key"),
      "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT",
    );
    const outboxKey = text(rowValue(row, "idempotency_key", "idempotencyKey"), "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
    if (ledgerScope !== ACCEPTED_ACTIVITY_LEDGER_SCOPE || ledgerKey !== outboxKey ||
        rowValue(row, "ledger_status", "status") !== "committed") {
      fail("ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT");
    }
    const requestFingerprint = text(
      rowValue(row, "ledger_request_fingerprint", "request_fingerprint"),
      "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT",
      65_536,
    );
    const activity = requestActivity(requestFingerprint, isT04);
    if (activity.activityId !== outboxKey || String(payload.activityId) !== activity.activityId ||
        String(payload.continuityId) !== activity.continuityId ||
        !sameJson(payload.acceptanceRef, activity.acceptanceRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT")) {
      fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    }
    let actionReceipt: Readonly<Record<string, unknown>> | undefined;
    let currentBinding: Readonly<Record<string, unknown>> | undefined;
    let authorityProjection: Readonly<Record<string, unknown>> | undefined;
    if (isT04) {
      const receiptProbe = object(payload.actionReceipt, "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
      const receipt = exactObject(
        receiptProbe,
        receiptProbe.origin === "watch_via_active_iphone" ? T04_WATCH_RECEIPT_KEYS : T04_RECEIPT_KEYS,
        "ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT",
      );
      const action = text(receipt.action, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT", 64);
      if (receipt.kind !== "t04.accepted_user_action_receipt" || !T04_ACTIONS.has(action) ||
          receipt.activityId !== activity.activityId || receipt.committed !== true ||
          receipt.revoked !== false || receipt.deleted !== false || receipt.stale !== false ||
          typeof receipt.purpose !== "string" ||
          (action === "explicit_handoff") !== (receipt.bindingCommitted === true) ||
          (receipt.origin !== "iphone" && receipt.origin !== "watch_via_active_iphone")) {
        fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      }
      const binding = exactObject(
        payload.currentBinding,
        T04_BINDING_KEYS,
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      const bindingSessionRef = canonicalRef(
        binding.realtimeSessionRef,
        "RealtimeSession",
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      // T04 captures the binding before this activity; the ledger response below is post-commit.
      const bindingLastAccepted = timestamp(
        binding.lastAcceptedUserActivityAt,
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      timestamp(binding.continuityExpiresAt, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      timestamp(binding.leaseExpiresAt, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      if (binding.userId !== activity.userId || binding.activeDeviceId !== activity.deviceId ||
          binding.continuityId !== activity.continuityId || binding.sessionState !== "active" ||
          binding.continuityState !== "active" || binding.transportState !== "connected" ||
          binding.leaseState !== "active" ||
          !sameJson(bindingSessionRef, activity.realtimeSessionRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
          Date.parse(bindingLastAccepted) > Date.parse(activity.occurredAt)) {
        fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      }
      const projection = exactObject(
        payload.authorityProjection,
        T04_PROJECTION_KEYS,
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      const projectionRef = canonicalRef(
        projection.realtimeSessionRef,
        "RealtimeSession",
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      const projectionAcceptance = opaque(
        projection.acceptanceRef,
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      const projectionWatermark = opaque(
        projection.authorityWatermark,
        "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
      );
      timestamp(projection.sessionTime, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      if (projection.kind !== "t04.activity_authority_projection" || projection.environment !== "production" ||
          projection.origin !== "user" || projection.userOriginated !== true || projection.accepted !== true ||
          projection.current !== true || projection.deleted !== false || projection.suppressed !== false ||
          projection.stale !== false || projection.watermarkCurrent !== true ||
          projection.activityId !== activity.activityId || projection.userId !== activity.userId ||
          projection.deviceId !== activity.deviceId || projection.continuityId !== activity.continuityId ||
          projection.sessionTime !== activity.occurredAt ||
          !sameJson(projectionRef, activity.realtimeSessionRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
          !sameJson(projectionAcceptance, activity.acceptanceRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
          !sameJson(projectionWatermark, payload.authorityWatermark, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
          !Array.isArray(projection.evidence) || projection.evidence.length === 0) {
        fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      }
      if (receipt.origin === "watch_via_active_iphone" && !Object.hasOwn(receipt, "watchAuthorityEvidenceRef")) {
        fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
      }
      actionReceipt = Object.freeze(receipt);
      currentBinding = Object.freeze(binding);
      authorityProjection = Object.freeze(projection);
    }
    const requestHash = hashText(
      rowValue(row, "ledger_request_hash", "request_hash"),
      "ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT",
    );
    if (sha256(requestFingerprint) !== requestHash) fail("ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT");

    const response = object(
      rowValue(row, "ledger_response", "response"),
      "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT",
    );
    const responseHash = hashText(
      rowValue(row, "ledger_response_hash", "response_hash"),
      "ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT",
    );
    if (jsonHash(response) !== responseHash) fail("ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT");
    const sessionRef = canonicalRef(
      response.realtimeSessionRef,
      "RealtimeSession",
      "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
    );
    const leaseRef = canonicalRef(
      response.activeDeviceLeaseRef,
      "DeviceLease",
      "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
    );
    const binding = object(response.binding, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const bindingSessionRef = canonicalRef(
      binding.realtimeSessionRef,
      "RealtimeSession",
      "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
    );
    const bindingLeaseRef = canonicalRef(
      binding.deviceLeaseRef,
      "DeviceLease",
      "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
    );
    const responseUserId = text(response.userId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const responseDeviceId = text(response.activeDeviceId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const responseContinuityId = text(response.continuityId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const responseEpoch = positiveDecimal(response.connectionEpoch, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const responseRevision = positiveDecimal(response.revision, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const bindingDeviceId = text(binding.deviceId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const bindingContinuityId = text(binding.continuityId, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    const bindingEpoch = positiveDecimal(binding.connectionEpoch, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    if (response.state !== "active" || response.continuityState !== "active" ||
        !sameJson(sessionRef, activity.realtimeSessionRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
        !sameJson(sessionRef, aggregateRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
        !sameJson(sessionRef, bindingSessionRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
        !sameJson(leaseRef, bindingLeaseRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT") ||
        responseUserId !== activity.userId || responseDeviceId !== activity.deviceId ||
        responseContinuityId !== activity.continuityId || bindingDeviceId !== activity.deviceId ||
        bindingContinuityId !== activity.continuityId || responseEpoch !== bindingEpoch) {
      fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    }
    const acceptedAt = timestamp(
      response.lastAcceptedUserActivityAt,
      "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
    );
    if (Date.parse(activity.occurredAt) > Date.parse(acceptedAt)) {
      fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    }
    if (!sameJson(payload.authorityWatermark, opaque(payload.authorityWatermark, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT"),
      "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT")) {
      fail("ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
    }
    const baseRecord: AcceptedActivityRecord = {
      cursor: streamCursor,
      eventId,
      eventType,
      eventVersion: version,
      activityId: activity.activityId,
      userId: activity.userId,
      deviceId: activity.deviceId,
      continuityId: activity.continuityId,
      realtimeSessionRef: sessionRef as unknown as OpaqueCanonicalRef,
      sessionObjectVersion: sessionRef.object_version,
      sessionPayloadSha256: sessionRef.canonical_payload_sha256,
      deviceLeaseRef: leaseRef as unknown as OpaqueCanonicalRef,
      leaseObjectVersion: leaseRef.object_version,
      leasePayloadSha256: leaseRef.canonical_payload_sha256,
      requestScope: ACCEPTED_ACTIVITY_LEDGER_SCOPE,
      idempotencyKey: outboxKey,
      requestFingerprint,
      occurredAt: activity.occurredAt,
      acceptedAt,
      acceptanceRef: opaque(payload.acceptanceRef, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT"),
      authorityWatermark: opaque(payload.authorityWatermark, "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT"),
      connectionEpoch: responseEpoch,
      sessionRevision: responseRevision,
      outboxPayload: Object.freeze(payload),
      outboxPayloadSha256: payloadHash,
    };
    if (!isT04) return Object.freeze(baseRecord);
    if (actionReceipt === undefined || currentBinding === undefined || authorityProjection === undefined) {
      fail("ACCEPTED_ACTIVITY_STREAM_OUTBOX_DRIFT");
    }
    return Object.freeze({ ...baseRecord, actionReceipt, currentBinding, authorityProjection });
  } catch (error) {
    if (error instanceof AcceptedActivityStreamError) throw error;
    fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID", error);
  }
}

function assertPool(pool: AcceptedActivityStreamPool): void {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    fail("ACCEPTED_ACTIVITY_STREAM_POOL_REQUIRED");
  }
}

function delayValue(value: unknown, fallback: number, code: AcceptedActivityStreamErrorCode): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 60_000) fail(code);
  return value;
}

function assertListenerClient(client: unknown): asserts client is AcceptedActivityStreamClient {
  if (client === null || typeof client !== "object" || typeof (client as AcceptedActivityStreamClient).query !== "function" ||
      typeof (client as AcceptedActivityStreamClient).on !== "function") {
    fail("ACCEPTED_ACTIVITY_STREAM_CLIENT_INVALID");
  }
}

interface NotificationEnvelope {
  readonly payload: string;
}

const PLAIN_NOTIFICATION_KEYS = Object.freeze(["processId", "channel", "payload"] as const);
const PG_NOTIFICATION_KEYS = Object.freeze(["length", "processId", "channel", "payload", "name"] as const);

function notificationInvalid(cause?: unknown): never {
  fail("ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID", cause);
}

function notificationOwnKeys(value: object): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch (error) {
    notificationInvalid(error);
  }
}

function notificationDescriptor(value: object, name: string): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name);
  } catch (error) {
    notificationInvalid(error);
  }
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      Object.prototype.hasOwnProperty.call(descriptor, "get") ||
      Object.prototype.hasOwnProperty.call(descriptor, "set")) {
    notificationInvalid();
  }
  return descriptor;
}

function notificationExactKeys(keys: readonly PropertyKey[], expected: readonly string[]): boolean {
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")) return false;
  const actualSorted = keys.slice().sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((key, index) => key === expectedSorted[index]);
}

function notificationScalar(value: unknown): boolean {
  const kind = typeof value;
  return value === null || (kind !== "object" && kind !== "function");
}

function notificationDataValues(value: object, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = notificationDescriptor(value, key);
    if (!notificationScalar(descriptor.value)) notificationInvalid();
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return Object.freeze(output);
}

function notificationPrototype(value: object): object {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    notificationInvalid(error);
  }
  if (prototype === null) notificationInvalid();
  return prototype;
}

function assertNotificationClassPrototype(value: object): void {
  const prototype = notificationPrototype(value);
  let parent: object | null;
  try {
    parent = Object.getPrototypeOf(prototype);
  } catch (error) {
    notificationInvalid(error);
  }
  if (parent !== Object.prototype || !notificationExactKeys(notificationOwnKeys(prototype), ["constructor"])) {
    notificationInvalid();
  }
  const constructorDescriptor = notificationDescriptor(prototype, "constructor");
  const constructorValue = constructorDescriptor.value;
  if (typeof constructorValue !== "function") notificationInvalid();
  const nameDescriptor = notificationDescriptor(constructorValue, "name");
  if (nameDescriptor.value !== "NotificationResponseMessage") notificationInvalid();
}

function normalizeNotificationEnvelope(message: unknown): NotificationEnvelope {
  if (message === null || typeof message !== "object") notificationInvalid();
  const value = message as object;
  const keys = notificationOwnKeys(value);
  if (keys.some((key) => typeof key !== "string")) notificationInvalid();

  if (notificationExactKeys(keys, PLAIN_NOTIFICATION_KEYS)) {
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch (error) {
      notificationInvalid(error);
    }
    if (prototype !== Object.prototype && prototype !== null) notificationInvalid();
    const fields = notificationDataValues(value, PLAIN_NOTIFICATION_KEYS);
    if (typeof fields.processId !== "number" || !Number.isSafeInteger(fields.processId) || fields.processId <= 0 ||
        fields.channel !== ACCEPTED_ACTIVITY_STREAM_CHANNEL || typeof fields.payload !== "string") {
      notificationInvalid();
    }
    return Object.freeze({ payload: fields.payload });
  }

  if (notificationExactKeys(keys, PG_NOTIFICATION_KEYS)) {
    assertNotificationClassPrototype(value);
    const fields = notificationDataValues(value, PG_NOTIFICATION_KEYS);
    if (typeof fields.length !== "number" || !Number.isSafeInteger(fields.length) || fields.length <= 0 ||
        typeof fields.processId !== "number" || !Number.isSafeInteger(fields.processId) || fields.processId <= 0 ||
        fields.name !== NOTIFICATION_NAME || fields.channel !== ACCEPTED_ACTIVITY_STREAM_CHANNEL ||
        typeof fields.payload !== "string") {
      notificationInvalid();
    }
    return Object.freeze({ payload: fields.payload });
  }

  notificationInvalid();
}

function parseNotification(message: unknown): AcceptedActivityWakeup | undefined {
  const envelope = normalizeNotificationEnvelope(message);
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.payload);
  } catch (error) {
    fail("ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID", error);
  }
  const payload = exactObject(
    decoded,
    ["cursor", "event_id"],
    "ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID",
  );
  const notificationCursor = cursor(payload.cursor);
  const eventId = text(payload.event_id, "ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID", 128);
  if (!UUID.test(eventId)) fail("ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID");
  return Object.freeze({ cursor: notificationCursor, eventId });
}

function createStream(
  pool: AcceptedActivityStreamPool,
  options: FactoryOptions,
): AcceptedActivityStream {
  assertPool(pool);
  if (options === null || typeof options !== "object") fail("ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID");
  const source = options.source ?? "legacy";
  if (source !== "legacy" && source !== "t04" && source !== "all") {
    fail("ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID");
  }
  if (options.listenerClient !== undefined && options.listenerClientFactory !== undefined) {
    fail("ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID");
  }
  const initialDelay = delayValue(
    options.reconnectInitialDelayMs,
    25,
    "ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID",
  );
  const maxDelay = delayValue(
    options.reconnectMaxDelayMs,
    1_000,
    "ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID",
  );
  if (maxDelay < initialDelay || (options.onError !== undefined && typeof options.onError !== "function")) {
    fail("ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID");
  }
  const report = (error: unknown): void => {
    try {
      const result = options.onError?.(error);
      if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Error observers must never escape a pg notification callback.
    }
  };
  const injectedClient = options.listenerClient;
  const factory: AcceptedActivityStreamClientFactory = options.listenerClientFactory ??
    (() => pool.connect());
  let closed = false;
  let subscriptionActive = false;
  let staticClientUsed = false;
  let listener: { readonly client: AcceptedActivityStreamClient; readonly generation: number; readonly detach: () => void } | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let reconnectFlight: { readonly token: number; readonly promise: Promise<void> } | undefined;
  let unsubscribeFlight: Promise<void> | undefined;
  let wakeupHandler: AcceptedActivityWakeupHandler | undefined;
  let pendingCatchup = false;
  let pendingWakeup: AcceptedActivityWakeup | undefined;
  let pumpFlight: Promise<void> | undefined;
  let subscriptionToken = 0;
  let activeSubscriptionToken: number | undefined;
  let handlerInvocationDepth = 0;
  let generation = 0;

  const release = async (client: AcceptedActivityStreamClient, error?: unknown): Promise<void> => {
    if (typeof client.release !== "function") return;
    await client.release(error);
  };

  const detach = (entry: typeof listener): void => {
    if (entry === undefined) return;
    const remove = entry.client.off ?? entry.client.removeListener;
    if (remove === undefined) return;
    const noop = () => undefined;
    // The actual callbacks are retained on the client by attachClient; this
    // marker is replaced immediately below through the WeakMap.
    const callbacks = callbackMap.get(entry.client);
    if (callbacks === undefined) return;
    remove.call(entry.client, "notification", callbacks.notification);
    remove.call(entry.client, "error", callbacks.error);
    remove.call(entry.client, "end", callbacks.end);
    void noop;
  };
  const callbackMap = new WeakMap<AcceptedActivityStreamClient, {
    readonly notification: (...args: readonly unknown[]) => void;
    readonly error: (...args: readonly unknown[]) => void;
    readonly end: (...args: readonly unknown[]) => void;
  }>();

  const invoke = async (wakeup?: AcceptedActivityWakeup): Promise<void> => {
    const handler = wakeupHandler;
    if (!subscriptionActive || closed || handler === undefined) return;
    handlerInvocationDepth += 1;
    try {
      await handler(wakeup);
    } finally {
      handlerInvocationDepth -= 1;
    }
  };

  const pump = (): Promise<void> => {
    if (pumpFlight !== undefined) return pumpFlight;
    pumpFlight = (async () => {
      while (subscriptionActive && !closed && (pendingCatchup || pendingWakeup !== undefined)) {
        const catchup = pendingCatchup;
        const wakeup = pendingWakeup;
        pendingCatchup = false;
        pendingWakeup = undefined;
        try {
          await invoke(catchup ? undefined : wakeup);
        } catch (error) {
          report(error);
        }
      }
    })().finally(() => {
      pumpFlight = undefined;
      if (subscriptionActive && !closed && (pendingCatchup || pendingWakeup !== undefined)) void pump();
    });
    return pumpFlight;
  };

  const queue = (wakeup: AcceptedActivityWakeup): void => {
    if (!subscriptionActive || closed) return;
    if (pendingWakeup === undefined || compareDecimal(wakeup.cursor, pendingWakeup.cursor) > 0) {
      pendingWakeup = wakeup;
    } else if (wakeup.cursor === pendingWakeup.cursor && wakeup.eventId !== pendingWakeup.eventId) {
      report(new AcceptedActivityStreamError("ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_CONFLICT"));
    }
    void pump();
  };

  const scheduleReconnect = (expectedSubscriptionToken: number): void => {
    if (activeSubscriptionToken !== expectedSubscriptionToken || !subscriptionActive || closed ||
        reconnectTimer !== undefined || reconnectFlight?.token === expectedSubscriptionToken) return;
    const exponent = Math.min(reconnectAttempt, 30);
    const wait = Math.min(maxDelay, initialDelay * (2 ** exponent));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (activeSubscriptionToken === expectedSubscriptionToken && subscriptionActive && !closed) {
        void reconnect(expectedSubscriptionToken);
      }
    }, wait);
    const timer = reconnectTimer as unknown as { unref?: () => void };
    timer.unref?.();
  };

  const dropListener = async (entry: typeof listener, error?: unknown): Promise<void> => {
    if (entry === undefined || listener !== entry) return;
    listener = undefined;
    detach(entry);
    try {
      await release(entry.client, error);
    } catch (releaseError) {
      report(releaseError);
    }
  };

  const onClientFailure = (client: AcceptedActivityStreamClient, error: unknown): void => {
    if (!subscriptionActive || closed || listener?.client !== client) return;
    const expectedSubscriptionToken = activeSubscriptionToken;
    if (expectedSubscriptionToken === undefined) return;
    void dropListener(listener, error).finally(() => scheduleReconnect(expectedSubscriptionToken));
  };

  const discardAttachedClient = async (
    client: AcceptedActivityStreamClient,
    listening: boolean,
  ): Promise<void> => {
    const current = listener;
    if (current === undefined || current.client !== client) return;
    listener = undefined;
    detach(current);
    if (listening) {
      try { await client.query(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`); }
      catch (error) { report(error); }
    }
    try { await release(client); }
    catch (error) { report(error); }
  };

  const attachClient = (client: AcceptedActivityStreamClient): NonNullable<typeof listener> => {
    assertListenerClient(client);
    if (listener !== undefined) fail("ACCEPTED_ACTIVITY_STREAM_CLIENT_INVALID");
    const entryGeneration = ++generation;
    const callbacks = {
      notification: (...args: readonly unknown[]) => {
        if (args.length !== 1 || listener?.client !== client) return;
        try {
          const wakeup = parseNotification(args[0]);
          if (wakeup !== undefined) queue(wakeup);
        } catch (error) {
          report(error);
        }
      },
      error: (...args: readonly unknown[]) => onClientFailure(client, args[0]),
      end: (...args: readonly unknown[]) => onClientFailure(client, args[0] ?? new Error("PG_LISTENER_ENDED")),
    };
    callbackMap.set(client, callbacks);
    client.on("notification", callbacks.notification);
    client.on("error", callbacks.error);
    client.on("end", callbacks.end);
    const entry = { client, generation: entryGeneration, detach: () => detach(entry) };
    listener = entry;
    return entry;
  };

  const listenAndCatchUp = async (
    client: AcceptedActivityStreamClient,
    expectedSubscriptionToken: number,
  ): Promise<void> => {
    await client.query(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`);
    if (activeSubscriptionToken !== expectedSubscriptionToken || closed || !subscriptionActive) return;
    pendingCatchup = true;
    await pump();
  };

  const reconnect = async (reconnectToken: number): Promise<void> => {
    if (activeSubscriptionToken !== reconnectToken || !subscriptionActive || closed ||
        reconnectFlight?.token === reconnectToken) return;
    let retryRequired = false;
    let flightPromise: Promise<void>;
    flightPromise = (async () => {
      let client: AcceptedActivityStreamClient | undefined;
      let entry: typeof listener;
      try {
        client = await factory();
        if (activeSubscriptionToken !== reconnectToken || closed || !subscriptionActive) {
          const abandoned = client;
          client = undefined;
          try { await release(abandoned); }
          catch (releaseError) { report(releaseError); }
          return;
        }
        assertListenerClient(client);
        entry = attachClient(client);
        await listenAndCatchUp(client, reconnectToken);
        if (activeSubscriptionToken !== reconnectToken || closed || !subscriptionActive) {
          await discardAttachedClient(client, true);
          client = undefined;
          return;
        }
        reconnectAttempt = 0;
      } catch (error) {
        retryRequired = true;
        if (client !== undefined) {
          const current = listener;
          if (entry !== undefined && current === entry) await dropListener(entry, error);
          else if (entry === undefined) await release(client, error).catch((releaseError) => report(releaseError));
        }
        report(error);
      }
    })().finally(() => {
      if (reconnectFlight?.token !== reconnectToken || reconnectFlight.promise !== flightPromise) return;
      reconnectFlight = undefined;
      if (retryRequired && activeSubscriptionToken === reconnectToken && subscriptionActive && !closed) {
        scheduleReconnect(reconnectToken);
      }
    });
    reconnectFlight = { token: reconnectToken, promise: flightPromise };
    await flightPromise;
  };

  const subscribeWakeups = async (handler: AcceptedActivityWakeupHandler): Promise<() => Promise<void>> => {
    if (closed) fail("ACCEPTED_ACTIVITY_STREAM_CLOSED");
    if (typeof handler !== "function") fail("ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID");
    if (handlerInvocationDepth > 0) fail("ACCEPTED_ACTIVITY_STREAM_REENTRANT_SUBSCRIBE_FORBIDDEN");
    if (subscriptionActive || unsubscribeFlight !== undefined) fail("ACCEPTED_ACTIVITY_STREAM_ALREADY_SUBSCRIBED");
    const currentSubscriptionToken = ++subscriptionToken;
    activeSubscriptionToken = currentSubscriptionToken;
    wakeupHandler = handler;
    subscriptionActive = true;
    let client: AcceptedActivityStreamClient | undefined;
    let entry: typeof listener;
    try {
      if (injectedClient !== undefined && !staticClientUsed) {
        staticClientUsed = true;
        client = injectedClient;
      } else {
        client = await factory();
      }
      if (closed || !subscriptionActive) {
        const abandoned = client;
        client = undefined;
        try { await release(abandoned); }
        catch (releaseError) { report(releaseError); }
        fail("ACCEPTED_ACTIVITY_STREAM_CLOSED");
      }
      assertListenerClient(client);
      entry = attachClient(client);
      await listenAndCatchUp(client, currentSubscriptionToken);
      if (closed || !subscriptionActive) {
        await discardAttachedClient(client, true);
        client = undefined;
        fail("ACCEPTED_ACTIVITY_STREAM_CLOSED");
      }
      reconnectAttempt = 0;
      const subscribedEntry = entry;
      if (subscribedEntry === undefined) fail("ACCEPTED_ACTIVITY_STREAM_CLIENT_INVALID");
      const unsubscribe = async (): Promise<void> => {
        if (activeSubscriptionToken !== currentSubscriptionToken) return;
        if (unsubscribeFlight !== undefined) return unsubscribeFlight;
        const flight = (async () => {
          if (activeSubscriptionToken !== currentSubscriptionToken) return;
          subscriptionActive = false;
          pendingCatchup = false;
          pendingWakeup = undefined;
          if (reconnectTimer !== undefined) {
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
          }
          if (activeSubscriptionToken !== currentSubscriptionToken) return;
          const current = listener;
          listener = undefined;
          if (current !== undefined) {
            detach(current);
            try { await current.client.query(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`); }
            catch (error) { report(error); }
            try { await release(current.client); }
            catch (error) { report(error); }
          }
          wakeupHandler = undefined;
          activeSubscriptionToken = undefined;
        })();
        let trackedFlight: Promise<void>;
        trackedFlight = flight.finally(() => {
          if (unsubscribeFlight === trackedFlight) unsubscribeFlight = undefined;
        });
        unsubscribeFlight = trackedFlight;
        return trackedFlight;
      };
      return unsubscribe;
    } catch (error) {
      subscriptionActive = false;
      wakeupHandler = undefined;
      if (activeSubscriptionToken === currentSubscriptionToken) activeSubscriptionToken = undefined;
      const current = listener;
      if (entry !== undefined && current === entry && client !== undefined) {
        await dropListener(entry, error);
      } else if (entry === undefined && !closed && client !== undefined) {
        await release(client, error).catch((releaseError) => report(releaseError));
      }
      client = undefined;
      if (error instanceof AcceptedActivityStreamError) throw error;
      fail("ACCEPTED_ACTIVITY_STREAM_CLIENT_INVALID", error);
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    activeSubscriptionToken = undefined;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (subscriptionActive) {
      try {
        const releaseSubscription = await subscribeWakeups(() => undefined);
        await releaseSubscription();
      } catch {
        // The active subscription is closed below when direct teardown is possible.
      }
    }
    subscriptionActive = false;
    pendingCatchup = false;
    pendingWakeup = undefined;
    const current = listener;
    listener = undefined;
    if (current !== undefined) {
      detach(current);
      try { await current.client.query(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`); }
      catch (error) { report(error); }
      try { await release(current.client); }
      catch (error) { report(error); }
    }
    wakeupHandler = undefined;
  };

  const readAfter = async (after: string, limit: number): Promise<AcceptedActivityStreamPage> => {
    if (closed) fail("ACCEPTED_ACTIVITY_STREAM_CLOSED");
    const inputCursor = cursor(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail("ACCEPTED_ACTIVITY_STREAM_LIMIT_INVALID");
    const readSql = source === "legacy"
      ? READ_AFTER_SQL
      : source === "t04"
        ? READ_AFTER_T04_SQL
        : READ_AFTER_ALL_SQL;
    const rows = await withTransaction(pool as unknown as Pool, async (client: PoolClient) => {
      const result = await client.query(readSql, [inputCursor, limit + 1]);
      return result.rows;
    }, { isolation: "REPEATABLE READ", readOnly: true });
    const records = rows.map((row) => acceptedRecord(row));
    let previous = inputCursor;
    for (const record of records) {
      if (compareDecimal(record.cursor, previous) <= 0) fail("ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");
      previous = record.cursor;
    }
    const hasMore = records.length > limit;
    const items = Object.freeze(records.slice(0, limit));
    return Object.freeze({
      items,
      nextCursor: items.length === 0 ? inputCursor : items[items.length - 1]!.cursor,
      hasMore,
    });
  };

  const readByIdempotency = async (idempotencyKey: string): Promise<AcceptedActivityRecord | undefined> => {
    if (closed) fail("ACCEPTED_ACTIVITY_STREAM_CLOSED");
    const key = text(idempotencyKey, "ACCEPTED_ACTIVITY_STREAM_OPTIONS_INVALID", 256);
    const eventTypes = source === "legacy"
      ? [ACCEPTED_ACTIVITY_EVENT_TYPE]
      : source === "t04"
        ? [T04_ACCEPTED_ACTIVITY_EVENT_TYPE]
        : [ACCEPTED_ACTIVITY_EVENT_TYPE, T04_ACCEPTED_ACTIVITY_EVENT_TYPE];
    const rows = await withTransaction(pool as unknown as Pool, async (client: PoolClient) => {
      const result = await client.query(READ_BY_IDEMPOTENCY_SQL, [eventTypes, key]);
      return result.rows;
    }, { isolation: "REPEATABLE READ", readOnly: true });
    if (rows.length === 0) return undefined;
    if (rows.length !== 1) fail("ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_CONFLICT");
    return acceptedRecord(rows[0]!);
  };

  return Object.freeze({ readAfter, readByIdempotency, subscribeWakeups, close });
}

export function createAcceptedActivityStream(options: AcceptedActivityStreamOptions): AcceptedActivityStream;
export function createAcceptedActivityStream(
  pool: AcceptedActivityStreamPool,
  options?: FactoryOptions,
): AcceptedActivityStream;
export function createAcceptedActivityStream(
  first: AcceptedActivityStreamOptions | AcceptedActivityStreamPool,
  second: FactoryOptions = {},
): AcceptedActivityStream {
  if (first !== null && typeof first === "object" && "pool" in first) {
    const options = first as AcceptedActivityStreamOptions;
    return createStream(options.pool, options);
  }
  return createStream(first as AcceptedActivityStreamPool, second);
}

/** Alias kept for callers that name this adapter a reader rather than a stream. */
export const createAcceptedActivityStreamReader = createAcceptedActivityStream;
