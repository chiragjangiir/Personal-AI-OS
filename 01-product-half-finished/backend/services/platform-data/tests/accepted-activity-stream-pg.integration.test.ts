import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import test from "node:test";
import type { Pool, PoolClient, QueryConfigValues } from "pg";

import {
  ACCEPTED_ACTIVITY_EVENT_TYPE,
  ACCEPTED_ACTIVITY_STREAM_CHANNEL,
  AcceptedActivityStreamError,
  createAcceptedActivityStream,
  type AcceptedActivityRecord,
  type AcceptedActivityStreamClient,
  type AcceptedActivityWakeup,
} from "../src/accepted-activity-stream.ts";
import { closePostgresPool, createPostgresPool } from "../src/postgres-pool.ts";
import { createRealtimeAuthorityRepository } from "../src/realtime-authority-repository.ts";
import { RealtimeSessionService } from "../../realtime-core/src/realtime-session-service.ts";
import type { RealtimeAuthorityPorts } from "../../realtime-core/src/ports.ts";
import {
  assertCanonicalTimestamp,
  type AcceptedUserActivity,
  type CanonicalTimestamp,
  type OpaqueCanonicalRef,
} from "../../realtime-core/src/types.ts";

const RUN = process.env.PAIOS_ACCEPTED_ACTIVITY_PG_INTEGRATION === "1";
const PHASE = process.env.PAIOS_ACCEPTED_ACTIVITY_PG_PHASE ?? "write";
const PORT = Number(process.env.PAIOS_PG_PORT ?? "0");
const HOST = process.env.PAIOS_PG_HOST ?? "";
const DATABASE = process.env.PAIOS_PG_DATABASE ?? "";
const USER = process.env.PAIOS_PG_USER ?? "";
const RUNTIME_ROOT = process.env.PAIOS_ACCEPTED_ACTIVITY_PG_RUNTIME_ROOT;
const EVIDENCE_FILE = process.env.PAIOS_ACCEPTED_ACTIVITY_PG_EVIDENCE_FILE;
const HASH = "a".repeat(64);
const NOW = assertCanonicalTimestamp("2026-08-27T12:00:00.000Z");
const INITIAL_ACTIVITY_AT = assertCanonicalTimestamp("2026-08-27T00:00:00.000Z");
const INITIAL_EXPIRES_AT = assertCanonicalTimestamp("2026-08-29T00:00:00.000Z");
const ISSUED_AT = assertCanonicalTimestamp("2026-08-27T00:00:00.000Z");
const LEASE_EXPIRES_AT = assertCanonicalTimestamp("2026-08-29T00:00:00.000Z");
const OTHER_DEVICE_ID = "01952f00-0000-7000-8000-000000000799";

const AUTHORITY_A = Object.freeze({
  sessionId: "01952f00-0000-7000-8000-000000000701",
  leaseId: "01952f00-0000-7000-8000-000000000702",
  userId: "01952f00-0000-7000-8000-000000000703",
  deviceId: "01952f00-0000-7000-8000-000000000704",
  continuityId: "01952f00-0000-7000-8000-000000000705",
});
const AUTHORITY_B = Object.freeze({
  sessionId: "01952f00-0000-7000-8000-000000000711",
  leaseId: "01952f00-0000-7000-8000-000000000712",
  userId: "01952f00-0000-7000-8000-000000000713",
  deviceId: "01952f00-0000-7000-8000-000000000714",
  continuityId: "01952f00-0000-7000-8000-000000000715",
});

type AuthorityFixture = Readonly<{
  readonly sessionId: string;
  readonly leaseId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly continuityId: string;
}>;

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("NONFINITE_JSON_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new TypeError("UNSUPPORTED_JSON_VALUE");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function ownerRef(refType: "RealtimeSession" | "DeviceLease", refId: string): Readonly<Record<string, string>> {
  return Object.freeze({
    ref_type: refType,
    ref_id: refId,
    object_version: "1",
    canonical_payload_sha256: HASH,
  });
}

function refs(fixture: AuthorityFixture): {
  readonly sessionRef: Readonly<Record<string, string>>;
  readonly leaseRef: Readonly<Record<string, string>>;
} {
  return Object.freeze({
    sessionRef: ownerRef("RealtimeSession", fixture.sessionId),
    leaseRef: ownerRef("DeviceLease", fixture.leaseId),
  });
}

function binding(fixture: AuthorityFixture): Record<string, unknown> {
  const { sessionRef, leaseRef } = refs(fixture);
  return {
    state: "connected",
    realtimeSessionRef: sessionRef,
    deviceLeaseRef: leaseRef,
    continuityId: fixture.continuityId,
    deviceId: fixture.deviceId,
    connectionEpoch: "1",
    provider: { provider: "pg18-test", value: "provider" },
    transportSessionAlias: { provider: "pg18-test", value: `transport-${fixture.sessionId}` },
    roomAlias: { provider: "pg18-test", value: `room-${fixture.sessionId}` },
    deviceAlias: { provider: "pg18-test", value: `device-${fixture.deviceId}` },
    connectionId: `connection-${fixture.sessionId}`,
  };
}

async function seedAuthority(pool: Pool, fixture: AuthorityFixture): Promise<void> {
  const { sessionRef, leaseRef } = refs(fixture);
  await pool.query(
    [
      "INSERT INTO realtime_sessions (session_ref_id, realtime_session_ref, session_object_version, session_payload_sha256,",
      "continuity_ref, user_id, continuity_id, continuity_state, active_device_lease_ref, active_device_id, binding,",
      "state, connection_epoch, last_accepted_activity_at, continuity_expires_at, terminal_at, terminal_reason,",
      "created_at, updated_at, revision)",
      "VALUES ($1,$2::jsonb,'1',$3,NULL,$4,$5,'active',$6::jsonb,$7,$8::jsonb,'active',1,",
      "$9::timestamptz,$10::timestamptz,NULL,NULL,$11::timestamptz,$11::timestamptz,1)",
    ].join(" "),
    [
      fixture.sessionId,
      JSON.stringify(sessionRef),
      HASH,
      fixture.userId,
      fixture.continuityId,
      JSON.stringify(leaseRef),
      fixture.deviceId,
      JSON.stringify(binding(fixture)),
      INITIAL_ACTIVITY_AT,
      INITIAL_EXPIRES_AT,
      ISSUED_AT,
    ],
  );
  await pool.query(
    [
      "INSERT INTO device_leases (lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256,",
      "session_ref_id, realtime_session_ref, continuity_ref, user_id, device_id, continuity_id, capabilities, purpose,",
      "policy_decision_ref, capability_scope, purpose_scope, policy_binding, revocable, state, lease_version, fencing_token,",
      "issued_at, acquired_at, expires_at, released_at, revoked_at, updated_at)",
      "VALUES ($1,$2::jsonb,'1',$3,$4,$5::jsonb,NULL,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,",
      "TRUE,'active',1,1,$15::timestamptz,$15::timestamptz,$16::timestamptz,NULL,NULL,$15::timestamptz)",
    ].join(" "),
    [
      fixture.leaseId,
      JSON.stringify(leaseRef),
      HASH,
      fixture.sessionId,
      JSON.stringify(sessionRef),
      fixture.userId,
      fixture.deviceId,
      fixture.continuityId,
      JSON.stringify(["audio.publish"]),
      "conversation",
      JSON.stringify({ kind: "PolicyDecision", id: "pg18-accepted-activity" }),
      JSON.stringify(["audio.publish"]),
      JSON.stringify(["conversation"]),
      JSON.stringify({ permitted: true }),
      ISSUED_AT,
      LEASE_EXPIRES_AT,
    ],
  );
}

function createActivityService(pool: Pool): RealtimeSessionService {
  const repository = createRealtimeAuthorityRepository(pool);
  const identity = {
    createContinuityId: () => AUTHORITY_A.continuityId,
    assertRepositoryIssuedRef(value: OpaqueCanonicalRef, kind: "RealtimeSession" | "DeviceLease") {
      const expected = kind === "RealtimeSession"
        ? ownerRef("RealtimeSession", AUTHORITY_A.sessionId)
        : ownerRef("DeviceLease", AUTHORITY_A.leaseId);
      assert.equal(canonicalJson(value), canonicalJson(expected));
    },
    createSessionRef: () => ownerRef("RealtimeSession", AUTHORITY_A.sessionId),
    createDeviceLeaseRef: () => ownerRef("DeviceLease", AUTHORITY_A.leaseId),
    createTransportAlias: ({ requestId, deviceId }: { requestId: string; deviceId: string }) => ({
      provider: "pg18-test",
      value: `generated-${deviceId}-${requestId}`,
    }),
    createConnectionId: ({ requestId, deviceId }: { requestId: string; deviceId: string }) =>
      `generated-connection-${deviceId}-${requestId}`,
  };
  const ports: RealtimeAuthorityPorts = {
    repository,
    policy: {
      async evaluate() {
        return {
          allowed: true as const,
          policyDecisionRef: { kind: "PolicyDecision", id: "pg18-accepted-activity" },
          capabilities: ["audio.publish"],
          purpose: "conversation",
          leaseExpiresAt: LEASE_EXPIRES_AT,
          revocable: true as const,
        };
      },
    },
    activityAcceptance: {
      async verify(activity) {
        const acceptedAt = assertCanonicalTimestamp(
          new Date(Date.parse(activity.occurredAt) + 1_000).toISOString(),
        );
        return {
          verified: true as const,
          acceptanceRef: activity.acceptanceRef,
          acceptedAt,
          authorityWatermark: { kind: "ActivityAuthority", activityId: activity.activityId },
        };
      },
    },
    transportDisconnection: {
      async verify(input) {
        return {
          verified: true as const,
          disconnectedAt: input.occurredAt,
          authorityProof: { kind: "DisconnectAuthority", activity: "pg18" },
        };
      },
    },
    identity,
    clock: { now: () => NOW },
    equality: {
      key: (value) => canonicalJson(value),
      same: (left, right) => canonicalJson(left) === canonicalJson(right),
    },
  };
  return new RealtimeSessionService(ports);
}

function activity(
  fixture: AuthorityFixture,
  ordinal: string,
  occurredAt: CanonicalTimestamp,
): AcceptedUserActivity {
  const { sessionRef } = refs(fixture);
  return {
    activityId: `accepted-activity-pg18-${ordinal}`,
    kind: "accepted_user_activity",
    userId: fixture.userId,
    deviceId: fixture.deviceId,
    realtimeSessionRef: sessionRef,
    continuityId: fixture.continuityId,
    occurredAt,
    acceptanceRef: { kind: "ContextAssertion", ref: `acceptance-${ordinal}` },
    accepted: true,
  };
}

function createPool(): Pool {
  return createPostgresPool({
    host: required(HOST, "PAIOS_PG_HOST"),
    port: PORT,
    database: required(DATABASE, "PAIOS_PG_DATABASE"),
    user: required(USER, "PAIOS_PG_USER"),
    password: process.env.PAIOS_PG_PASSWORD ?? "",
    max: 12,
    connectionTimeoutMillis: 5_000,
    applicationName: `paios-accepted-activity-pg18-${PHASE}`,
  });
}

type StreamClient = AcceptedActivityStreamClient & {
  emit(event: "error", error: Error): boolean;
};

function adaptPoolClient(client: PoolClient): StreamClient {
  type Listener = (...args: readonly unknown[]) => void;
  const removers = new Map<string, Map<Listener, () => void>>();
  const remember = (event: string, listener: Listener, remove: () => void): void => {
    let entries = removers.get(event);
    if (entries === undefined) {
      entries = new Map();
      removers.set(event, entries);
    }
    entries.set(listener, remove);
  };
  const remove = (event: string, listener: Listener): void => {
    const entries = removers.get(event);
    const disposer = entries?.get(listener);
    if (disposer === undefined) return;
    disposer();
    entries!.delete(listener);
  };
  const adapted: StreamClient = {
    query(text, values) {
      const queryValues: QueryConfigValues<unknown[]> | undefined = values === undefined
        ? undefined
        : Array.from(values);
      return queryValues === undefined ? client.query(text) : client.query(text, queryValues);
    },
    on(event, listener) {
      if (event === "notification") {
        const native = (message: unknown): void => { listener(message); };
        client.on("notification", native);
        remember(event, listener, () => { client.off("notification", native); });
        return client;
      }
      if (event === "error") {
        const native = (error: Error): void => { listener(error); };
        client.on("error", native);
        remember(event, listener, () => { client.off("error", native); });
        return client;
      }
      if (event === "end") {
        const native = (): void => { listener(); };
        client.on("end", native);
        remember(event, listener, () => { client.off("end", native); });
        return client;
      }
      return client;
    },
    off(event, listener) {
      remove(event, listener);
      return client;
    },
    removeListener(event, listener) {
      remove(event, listener);
      return client;
    },
    release(error?: unknown) {
      if (error === undefined) {
        client.release();
      } else if (typeof error === "boolean" || error instanceof Error) {
        client.release(error);
      } else {
        client.release(new Error(String(error)));
      }
    },
    emit(event, error) {
      return client.emit(event, error);
    },
  };
  return adapted;
}

type StreamPool = {
  connect(): Promise<StreamClient>;
};

function createStreamPool(pool: Pool): StreamPool {
  return {
    async connect(): Promise<StreamClient> {
      return adaptPoolClient(await pool.connect());
    },
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label}_TIMEOUT`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function writeEvidence(value: Record<string, unknown>): Promise<void> {
  const root = resolve(required(RUNTIME_ROOT, "PAIOS_ACCEPTED_ACTIVITY_PG_RUNTIME_ROOT"));
  const target = resolve(required(EVIDENCE_FILE, "PAIOS_ACCEPTED_ACTIVITY_PG_EVIDENCE_FILE"));
  if (!target.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) {
    throw new Error("EVIDENCE_PATH_OUTSIDE_RUNTIME_ROOT");
  }
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`ACCEPTED_ACTIVITY_PG_EVIDENCE ${JSON.stringify(value)}\n`);
}

async function catalogSnapshot(pool: Pool): Promise<Record<string, unknown>> {
  const result = await pool.query(
    [
      "SELECT current_setting('server_version') AS server_version, host(inet_server_addr()) AS server_address,",
      "inet_server_port()::int AS server_port,",
      "(SELECT count(*)::int FROM pg_attribute WHERE attrelid='public.outbox_events'::regclass AND attname='accepted_activity_cursor' AND attnum > 0 AND NOT attisdropped) AS cursor_columns,",
      "(SELECT count(*)::int FROM pg_constraint WHERE conrelid='public.outbox_events'::regclass AND conname IN (",
      "'outbox_events_accepted_activity_cursor_ck','outbox_events_accepted_activity_profile_ck',",
      "'outbox_events_accepted_activity_canonical_hashes_ck') AND contype='c' AND convalidated) AS accepted_constraints,",
      "(SELECT count(*)::int FROM pg_trigger WHERE tgrelid='public.outbox_events'::regclass AND tgname LIKE 'outbox_events_accepted_activity_%' AND NOT tgisinternal) AS accepted_triggers,",
      "to_regclass('public.outbox_events_accepted_activity_cursor_seq')::text AS cursor_sequence,",
      "to_regclass('public.outbox_events_accepted_activity_cursor_uq')::text AS cursor_unique_index,",
      "to_regclass('public.outbox_events_accepted_activity_read_after_idx')::text AS read_after_index",
    ].join(" "),
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.match(String(row.server_version), /^18\./);
  assert.equal(row.server_address, "127.0.0.1");
  assert.equal(Number(row.server_port), PORT);
  assert.equal(Number(row.cursor_columns), 1);
  assert.equal(Number(row.accepted_constraints), 3);
  assert.equal(Number(row.accepted_triggers), 3);
  assert.equal(row.cursor_sequence, "outbox_events_accepted_activity_cursor_seq");
  assert.equal(row.cursor_unique_index, "outbox_events_accepted_activity_cursor_uq");
  assert.equal(row.read_after_index, "outbox_events_accepted_activity_read_after_idx");
  return row;
}

async function outboxIdentity(pool: Pool, idempotencyKey: string): Promise<{
  readonly eventId: string;
  readonly cursor: string;
  readonly acceptedAt: string;
}> {
  const result = await pool.query(
    [
      "SELECT o.event_id::text AS event_id, o.accepted_activity_cursor::text AS cursor,",
      "l.response->>'lastAcceptedUserActivityAt' AS accepted_at",
      "FROM outbox_events AS o JOIN idempotency_ledger AS l",
      "ON l.scope='activity_renewal' AND l.idempotency_key=o.idempotency_key",
      "WHERE o.idempotency_scope='realtime.outbox' AND o.idempotency_key=$1 AND o.event_type=$2",
    ].join(" "),
    [idempotencyKey, ACCEPTED_ACTIVITY_EVENT_TYPE],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  return { eventId: String(row.event_id), cursor: String(row.cursor), acceptedAt: String(row.accepted_at) };
}

async function assertSqlRejected(pool: Pool, text: string, values: QueryConfigValues<unknown[]>, marker: string): Promise<void> {
  await assert.rejects(
    pool.query(text, values),
    (error: unknown) => {
      const message = error !== null && typeof error === "object" && "message" in error
        ? String((error as { readonly message?: unknown }).message)
        : String(error);
      return message.includes(marker);
    },
  );
}

async function runWritePhase(): Promise<void> {
  const pool = createPool();
  const streamPool = createStreamPool(pool);
  let stream: ReturnType<typeof createAcceptedActivityStream> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    const catalog = await catalogSnapshot(pool);
    await seedAuthority(pool, AUTHORITY_A);
    await seedAuthority(pool, AUTHORITY_B);
    const service = createActivityService(pool);
    const event1 = activity(AUTHORITY_A, "001", assertCanonicalTimestamp("2026-08-27T01:00:00.000Z"));
    const event2 = activity(AUTHORITY_A, "002", assertCanonicalTimestamp("2026-08-27T02:00:00.000Z"));
    const event3 = activity(AUTHORITY_A, "003", assertCanonicalTimestamp("2026-08-27T03:00:00.000Z"));
    const event4 = activity(AUTHORITY_B, "004", assertCanonicalTimestamp("2026-08-27T01:00:00.000Z"));
    const event5 = activity(AUTHORITY_B, "005", assertCanonicalTimestamp("2026-08-27T02:00:00.000Z"));
    const observedWakes: Array<AcceptedActivityWakeup | undefined> = [];
    const observedItems: AcceptedActivityRecord[] = [];
    let observedCursor = "0";
    let firstListener: StreamClient | undefined;
    let reconnectListener: StreamClient | undefined;
    let factoryCalls = 0;
    let resolveReconnectFactory: (() => void) | undefined;
    const reconnectFactoryStarted = new Promise<void>((resolvePromise) => { resolveReconnectFactory = resolvePromise; });
    let releaseReconnect: (() => void) | undefined;
    const reconnectGate = new Promise<void>((resolvePromise) => { releaseReconnect = resolvePromise; });
    const streamErrors: unknown[] = [];

    stream = createAcceptedActivityStream({
      pool: streamPool,
      listenerClientFactory: async () => {
        const client = await streamPool.connect();
        factoryCalls += 1;
        if (factoryCalls === 1) {
          firstListener = client;
          return client;
        }
        if (factoryCalls === 2) {
          reconnectListener = client;
          resolveReconnectFactory!();
          await reconnectGate;
        }
        return client;
      },
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 50,
      onError: (error) => { streamErrors.push(error); },
    });
    unsubscribe = await stream.subscribeWakeups(async (wakeup) => {
      observedWakes.push(wakeup);
      if (wakeup !== undefined) {
        assert.deepEqual(Object.keys(wakeup).sort(), ["cursor", "eventId"]);
        const notificationRow = await pool.query(
          "SELECT event_id::text AS event_id FROM outbox_events WHERE accepted_activity_cursor=$1::bigint",
          [wakeup.cursor],
        );
        assert.equal(notificationRow.rows.length, 1);
        assert.equal(notificationRow.rows[0]!.event_id, wakeup.eventId);
      }
      const page = await stream!.readAfter(observedCursor, 100);
      for (const item of page.items) {
        if (!observedItems.some((existing) => existing.eventId === item.eventId)) observedItems.push(item);
      }
      observedCursor = page.nextCursor;
    });
    assert.equal(observedWakes.length, 1);
    assert.equal(observedWakes[0], undefined);
    assert.equal(observedItems.length, 0);

    await service.recordAcceptedUserActivity(event1);
    await waitFor(() => observedItems.length >= 1, "FIRST_NOTIFICATION");
    const firstIdentity = await outboxIdentity(pool, event1.activityId);
    const firstRecord = observedItems.find((item) => item.activityId === event1.activityId);
    assert.ok(firstRecord);
    assert.equal(firstRecord.acceptedAt, firstIdentity.acceptedAt);
    assert.notEqual(firstRecord.acceptedAt, event1.occurredAt);
    assert.equal(firstRecord.cursor, firstIdentity.cursor);
    assert.ok(observedWakes.some((wakeup) => wakeup?.eventId === firstIdentity.eventId));

    await service.recordAcceptedUserActivity(event2);
    await waitFor(() => observedItems.length >= 2, "SECOND_NOTIFICATION");
    const secondIdentity = await outboxIdentity(pool, event2.activityId);
    const replayBefore = await outboxIdentity(pool, event1.activityId);
    await service.recordAcceptedUserActivity(event1);
    const replayAfter = await outboxIdentity(pool, event1.activityId);
    assert.deepEqual(replayAfter, replayBefore);
    const replayCount = await pool.query(
      "SELECT count(*)::int AS count FROM outbox_events WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1 AND event_type=$2",
      [event1.activityId, ACCEPTED_ACTIVITY_EVENT_TYPE],
    );
    assert.equal(Number(replayCount.rows[0]!.count), 1);

    const retryBefore = await pool.query(
      "SELECT accepted_activity_cursor::text AS cursor FROM outbox_events WHERE event_id=$1",
      [firstIdentity.eventId],
    );
    await pool.query(
      "UPDATE outbox_events SET available_at=$2::timestamptz, status='failed', attempt_count=attempt_count+1, last_error_code='PG18_RETRY', updated_at=now() WHERE event_id=$1",
      [firstIdentity.eventId, "2036-08-27T01:02:04.123Z"],
    );
    const retryPage = await stream.readAfter("0", 1);
    assert.equal(retryPage.items.length, 1);
    assert.equal(retryPage.items[0]!.eventId, firstIdentity.eventId);
    assert.equal(retryPage.items[0]!.acceptedAt, firstRecord.acceptedAt);
    assert.equal(retryPage.items[0]!.cursor, String(retryBefore.rows[0]!.cursor));
    const retryAfter = await pool.query(
      "SELECT accepted_activity_cursor::text AS cursor, status, attempt_count::int AS attempt_count FROM outbox_events WHERE event_id=$1",
      [firstIdentity.eventId],
    );
    assert.equal(String(retryAfter.rows[0]!.cursor), firstIdentity.cursor);
    assert.equal(retryAfter.rows[0]!.status, "failed");
    assert.equal(Number(retryAfter.rows[0]!.attempt_count), 1);

    await Promise.all([
      service.recordAcceptedUserActivity(event3),
      service.recordAcceptedUserActivity(event4),
    ]);
    await waitFor(() => observedItems.length >= 4, "CONCURRENT_NOTIFICATIONS");
    const concurrentIds = new Set([event3.activityId, event4.activityId]);
    assert.deepEqual(
      new Set(observedItems.filter((item) => concurrentIds.has(item.activityId)).map((item) => item.activityId)),
      concurrentIds,
    );
    const preDisconnectCursor = observedCursor;

    firstListener!.emit("error", new Error("PG18_SIMULATED_LISTENER_DISCONNECT"));
    await reconnectFactoryStarted;
    assert.equal(factoryCalls, 2);
    assert.ok(reconnectListener);
    await service.recordAcceptedUserActivity(event5);
    const fifthIdentity = await outboxIdentity(pool, event5.activityId);
    assert.ok(Number(fifthIdentity.cursor) > Number(preDisconnectCursor));
    releaseReconnect!();
    await waitFor(() => observedItems.length >= 5, "RECONNECT_CATCHUP");
    assert.equal(streamErrors.length, 0);
    const catchupRecord = observedItems.find((item) => item.activityId === event5.activityId);
    assert.ok(catchupRecord);
    assert.equal(catchupRecord.eventId, fifthIdentity.eventId);
    assert.equal(catchupRecord.cursor, fifthIdentity.cursor);
    assert.ok(observedWakes.slice(1).includes(undefined));

    const cursorRows = await pool.query(
      "SELECT accepted_activity_cursor::text AS cursor FROM outbox_events WHERE event_type=$1 ORDER BY accepted_activity_cursor",
      [ACCEPTED_ACTIVITY_EVENT_TYPE],
    );
    assert.equal(cursorRows.rows.length, 5);
    const cursors = cursorRows.rows.map((row) => String(row.cursor));
    for (let index = 1; index < cursors.length; index += 1) {
      assert.ok(BigInt(cursors[index]!) > BigInt(cursors[index - 1]!));
    }
    assert.equal(new Set(cursors).size, cursors.length);

    await assertSqlRejected(
      pool,
      "UPDATE outbox_events SET event_type=$2 WHERE event_id=$1",
      [firstIdentity.eventId, "realtime.continuity.renewed.corrupt"],
      "PAIOS_ACCEPTED_ACTIVITY_AUTHORITY_FIELDS_ARE_IMMUTABLE",
    );
    const originalLedger = await pool.query(
      "SELECT response, response_hash FROM idempotency_ledger WHERE scope='activity_renewal' AND idempotency_key=$1",
      [event1.activityId],
    );
    assert.equal(originalLedger.rows.length, 1);
    const originalResponse = originalLedger.rows[0]!.response;
    const originalResponseHash = String(originalLedger.rows[0]!.response_hash);
    await pool.query(
      "UPDATE idempotency_ledger SET response_hash=$2 WHERE scope='activity_renewal' AND idempotency_key=$1",
      [event1.activityId, "b".repeat(64)],
    );
    await assert.rejects(
      stream.readAfter("0", 1),
      (error: unknown) => error instanceof AcceptedActivityStreamError && error.code === "ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT",
    );
    await pool.query(
      "UPDATE idempotency_ledger SET response_hash=$2 WHERE scope='activity_renewal' AND idempotency_key=$1",
      [event1.activityId, originalResponseHash],
    );
    const badBindingResponse = JSON.parse(JSON.stringify(originalResponse)) as Record<string, unknown>;
    badBindingResponse.activeDeviceId = OTHER_DEVICE_ID;
    const badBindingHash = jsonHash(badBindingResponse);
    await pool.query(
      "UPDATE idempotency_ledger SET response=$2::jsonb, response_hash=$3 WHERE scope='activity_renewal' AND idempotency_key=$1",
      [event1.activityId, JSON.stringify(badBindingResponse), badBindingHash],
    );
    await assert.rejects(
      stream.readAfter("0", 1),
      (error: unknown) => error instanceof AcceptedActivityStreamError && error.code === "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT",
    );
    await pool.query(
      "UPDATE idempotency_ledger SET response=$2::jsonb, response_hash=$3 WHERE scope='activity_renewal' AND idempotency_key=$1",
      [event1.activityId, JSON.stringify(originalResponse), originalResponseHash],
    );
    const restored = await stream.readAfter("0", 1);
    assert.equal(restored.items[0]!.acceptedAt, firstRecord.acceptedAt);

    const finalPage = await stream.readAfter("0", 100);
    assert.equal(finalPage.items.length, 5);
    assert.equal(finalPage.items[0]!.activityId, event1.activityId);
    assert.equal(finalPage.items[1]!.activityId, event2.activityId);
    assert.equal(finalPage.items.some((item) => item.activityId === event3.activityId), true);
    assert.equal(finalPage.items.some((item) => item.activityId === event4.activityId), true);
    assert.equal(finalPage.items[4]!.activityId, event5.activityId);
    assert.equal(finalPage.nextCursor, fifthIdentity.cursor);
    assert.equal(finalPage.hasMore, false);
    await writeEvidence({
      status: "PASS",
      phase: "write",
      server: catalog,
      event_count: finalPage.items.length,
      event_ids: finalPage.items.map((item) => item.eventId),
      activity_ids: finalPage.items.map((item) => item.activityId),
      cursors: finalPage.items.map((item) => item.cursor),
      accepted_at: finalPage.items.map((item) => item.acceptedAt),
      retry_cursor: firstIdentity.cursor,
      retry_accepted_at: firstRecord.acceptedAt,
      resume_cursor: preDisconnectCursor,
      resume_activity_id: event5.activityId,
      resume_event_id: fifthIdentity.eventId,
      resume_event_cursor: fifthIdentity.cursor,
      wake_count: observedWakes.length,
      reconnect_factory_calls: factoryCalls,
      read_after_projection_count: finalPage.items.length,
    });
  } finally {
    if (unsubscribe !== undefined) await unsubscribe().catch(() => undefined);
    if (stream !== undefined) await stream.close().catch(() => undefined);
    await closePostgresPool(pool);
  }
}

async function runReadbackPhase(): Promise<void> {
  const evidencePath = resolve(required(EVIDENCE_FILE, "PAIOS_ACCEPTED_ACTIVITY_PG_EVIDENCE_FILE"));
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
  const resumeCursor = String(evidence.resume_cursor);
  const resumeActivityId = String(evidence.resume_activity_id);
  const resumeEventId = String(evidence.resume_event_id);
  const resumeEventCursor = String(evidence.resume_event_cursor);
  const pool = createPool();
  const stream = createAcceptedActivityStream(createStreamPool(pool));
  const t04Stream = createAcceptedActivityStream(createStreamPool(pool), { source: "t04" });
  try {
    const catalog = await catalogSnapshot(pool);
    const t04Empty = await t04Stream.readAfter("0", 10);
    assert.equal(t04Empty.items.length, 0);
    assert.equal(t04Empty.hasMore, false);
    const resumed = await stream.readAfter(resumeCursor, 10);
    assert.equal(resumed.items.length, 1);
    assert.equal(resumed.items[0]!.activityId, resumeActivityId);
    assert.equal(resumed.items[0]!.eventId, resumeEventId);
    assert.equal(resumed.items[0]!.cursor, resumeEventCursor);
    assert.equal(resumed.nextCursor, resumeEventCursor);
    assert.equal(resumed.hasMore, false);
    const exhausted = await stream.readAfter(resumed.nextCursor, 10);
    assert.equal(exhausted.items.length, 0);
    assert.equal(exhausted.nextCursor, resumed.nextCursor);
    const persisted = await pool.query(
      "SELECT count(*)::int AS accepted_count, max(accepted_activity_cursor)::text AS max_cursor, pg_postmaster_start_time()::text AS postmaster_started_at FROM outbox_events WHERE event_type=$1",
      [ACCEPTED_ACTIVITY_EVENT_TYPE],
    );
    assert.equal(Number(persisted.rows[0]!.accepted_count), Number(evidence.event_count));
    assert.equal(String(persisted.rows[0]!.max_cursor), String(evidence.cursors instanceof Array ? evidence.cursors[evidence.cursors.length - 1] : resumeEventCursor));
    await writeEvidence({
      ...evidence,
      status: "PASS",
      phase: "readback",
      restart: {
        server: catalog,
        resumed_count: resumed.items.length,
        resumed_cursor: resumed.items[0]!.cursor,
        exhausted_count: exhausted.items.length,
        accepted_count: Number(persisted.rows[0]!.accepted_count),
        postmaster_started_at: String(persisted.rows[0]!.postmaster_started_at),
      },
    });
  } finally {
    await stream.close().catch(() => undefined);
    await t04Stream.close().catch(() => undefined);
    await closePostgresPool(pool);
  }
}

test(
  "PG18 accepted-activity stream persists, wakes, catches up, and reads after restart",
  { skip: !RUN ? "set PAIOS_ACCEPTED_ACTIVITY_PG_INTEGRATION=1" : false, concurrency: false },
  async () => {
    if (HOST !== "127.0.0.1" || !Number.isSafeInteger(PORT) || PORT < 1024 || PORT === 5432 || PORT === 55432) {
      throw new Error("PAIOS_ACCEPTED_ACTIVITY_PG_DISPOSABLE_BINDING_REQUIRED");
    }
    if (PHASE === "write") {
      await runWritePhase();
      return;
    }
    if (PHASE === "readback") {
      await runReadbackPhase();
      return;
    }
    throw new Error("PAIOS_ACCEPTED_ACTIVITY_PG_PHASE_INVALID");
  },
);
