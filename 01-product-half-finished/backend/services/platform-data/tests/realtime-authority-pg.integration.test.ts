import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  closePostgresPool,
  createPostgresPool,
  isPostgresConfigured,
} from "../src/postgres-pool.ts";
import {
  createRealtimeAuthorityRepository,
  type AtomicOperationCommit,
} from "../src/realtime-authority-repository.ts";
import { IdempotencyConflictError } from "../src/idempotency-ledger.ts";
import { RealtimeSessionService } from "../../realtime-core/src/realtime-session-service.ts";
import type { RealtimeAuthorityPorts } from "../../realtime-core/src/ports.ts";
import { assertCanonicalTimestamp, assertDecimalConnectionEpoch, type HandoffFactRecord } from "../../realtime-core/src/types.ts";

const RUN = process.env.PAIOS_RUN_PG_INTEGRATION === "1";
const SKIP_REASON = "set PAIOS_PG_DATABASE, PAIOS_PG_USER, PAIOS_PG_PASSWORD and PAIOS_RUN_PG_INTEGRATION=1";
const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACCEPTED_RESPONSE_HASH = createHash("sha256").update('{"accepted":true}', "utf8").digest("hex");
const HANDOFF_FINGERPRINT = '{"requestId":"pg-handoff-request","idempotencyKey":"pg-handoff-fact-key"}';
const HANDOFF_REQUEST_HASH = createHash("sha256").update(HANDOFF_FINGERPRINT, "utf8").digest("hex");
const HANDOFF_DRIFT_FINGERPRINT = '{"requestId":"pg-handoff-request-drift","idempotencyKey":"pg-handoff-fact-key"}';
const HANDOFF_DRIFT_REQUEST_HASH = createHash("sha256").update(HANDOFF_DRIFT_FINGERPRINT, "utf8").digest("hex");
const SESSION_ID = "81111111-1111-7111-8111-111111111111";
const LEASE_ID = "82222222-2222-7222-8222-222222222222";
const USER_ID = "83333333-3333-7333-8333-333333333333";
const CONTINUITY_ID = "84444444-4444-7444-8444-444444444444";
const FACT_ID = "85555555-5555-4555-8555-555555555555";
const EVENT_ID = "86666666-6666-4666-8666-666666666666";
const CONCURRENT_SESSION_A = "87711111-1111-7111-8111-111111111111";
const CONCURRENT_SESSION_B = "87722222-2222-7222-8222-222222222222";
const CONCURRENT_CONTINUITY = "87733333-3333-7333-8333-333333333333";
const HANDOFF_SESSION_ID = "87744444-4444-7444-8444-444444444444";
const HANDOFF_CONTINUITY_ID = "87755555-5555-7555-8555-555555555555";
const HANDOFF_OLD_LEASE_ID = "87766666-6666-7666-8666-666666666666";
const HANDOFF_NEW_LEASE_ID = "87777777-7777-7777-8777-777777777777";
const HANDOFF_FROM_DEVICE_ID = "87788888-8888-7888-8888-888888888888";
const HANDOFF_TO_DEVICE_ID = "87799999-9999-7999-8999-999999999999";

function ownerRef(refType: "RealtimeSession" | "DeviceLease", refId: string): Readonly<Record<string, string>> {
  return Object.freeze({
    ref_type: refType,
    ref_id: refId,
    object_version: "1",
    canonical_payload_sha256: HASH,
  });
}

function stableOwnerValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableOwnerValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableOwnerValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("unstable test value");
}

test("PostgreSQL migration and atomic replay survive a real database", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const migrations = await Promise.all([
    readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"),
  ]);
  const repository = createRealtimeAuthorityRepository(pool);
  const scope = "pg-integration-realtime-authority";
  try {
    for (const migration of migrations) await pool.query(migration);
    const row = await pool.query(
      "SELECT connection_epoch::text AS connection_epoch FROM realtime_sessions WHERE session_ref_id = $1",
      [SESSION_ID],
    );
    assert.equal(row.rows.length, 0);
    const commit: AtomicOperationCommit<{ accepted: boolean }> = {
      response: { accepted: true },
      responseHash: ACCEPTED_RESPONSE_HASH,
      terminalFact: {
        terminalFactId: FACT_ID,
        operation: "media_stop",
        status: "success",
        requestScope: scope,
        idempotencyKey: "request-1",
        requestHash: HASH,
        continuityId: CONTINUITY_ID,
        createdAt: "2026-08-23T00:00:00.000Z",
        operationOutcome: { outcome: "committed" },
        executionFacts: { closureStatus: "verified_closed" },
      },
      outboxEvents: [{
        eventId: EVENT_ID,
        aggregateType: "RealtimeSession",
        aggregateId: SESSION_ID,
        eventType: "realtime.terminal.fact",
        eventVersion: 1,
        idempotencyScope: scope,
        idempotencyKey: "request-1",
        payload: { status: "success" },
        payloadHash: HASH,
      }],
    };
    const first = await repository.runAtomic({ scope, idempotencyKey: "request-1", requestHash: HASH }, async () => commit);
    assert.equal(first.kind, "committed");
    const replay = await repository.runAtomic({ scope, idempotencyKey: "request-1", requestHash: HASH }, async () => {
      throw new Error("replay must not invoke business callback");
    });
    assert.equal(replay.kind, "replayed");
    await assert.rejects(
      () => repository.runAtomic({ scope, idempotencyKey: "request-1", requestHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, async () => commit),
      IdempotencyConflictError,
    );
    const ledger = await pool.query(
      "SELECT status, request_hash, response_hash FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2",
      [scope, "request-1"],
    );
    assert.equal(ledger.rows[0]?.status, "committed");
    assert.equal(ledger.rows[0]?.request_hash, HASH);
    assert.equal(ledger.rows[0]?.response_hash, ACCEPTED_RESPONSE_HASH);
    const outbox = await pool.query(
      "SELECT status, payload_sha256 FROM outbox_events WHERE idempotency_scope = $1 AND idempotency_key = $2",
      [scope, "request-1"],
    );
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0]?.payload_sha256, HASH);
    const terminal = await pool.query(
      "SELECT status, request_hash FROM realtime_terminal_facts WHERE request_scope = $1 AND idempotency_key = $2",
      [scope, "request-1"],
    );
    assert.equal(terminal.rows[0]?.status, "success");
    assert.equal(terminal.rows[0]?.request_hash, HASH);
    await pool.query(
      "INSERT INTO realtime_sessions (session_ref_id, session_object_version, session_payload_sha256, user_id, continuity_id, state, connection_epoch, continuity_expires_at, created_at, updated_at) VALUES ($1, 1, $2, $3, $4, 'active', $5, $6, $7, $7)",
      [SESSION_ID, HASH, USER_ID, CONTINUITY_ID, "9007199254740993", "2026-08-24T00:00:00.000Z", "2026-08-23T00:00:00.000Z"],
    );
    const epoch = await pool.query(
      "SELECT connection_epoch::text AS connection_epoch FROM realtime_sessions WHERE session_ref_id = $1",
      [SESSION_ID],
    );
    assert.equal(epoch.rows[0]?.connection_epoch, "9007199254740993");
    const concurrentSessionSql = [
      "INSERT INTO realtime_sessions (session_ref_id, session_object_version, session_payload_sha256, user_id, continuity_id, continuity_state, state, connection_epoch, continuity_expires_at, created_at, updated_at)",
      "VALUES ($1, 1, $2, $3, $4, 'active', 'active', 1, $5, $6, $6)",
    ].join(" ");
    const concurrentResults = await Promise.allSettled([
      pool.query(concurrentSessionSql, [CONCURRENT_SESSION_A, HASH, USER_ID, CONCURRENT_CONTINUITY, "2026-08-24T00:00:00.000Z", "2026-08-23T00:00:00.000Z"]),
      pool.query(concurrentSessionSql, [CONCURRENT_SESSION_B, HASH, USER_ID, CONCURRENT_CONTINUITY, "2026-08-24T00:00:00.000Z", "2026-08-23T00:00:00.000Z"]),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
    const activeContinuity = await pool.query(
      "SELECT count(*)::int AS count FROM realtime_sessions WHERE continuity_id = $1 AND state = 'active' AND continuity_state = 'active'",
      [CONCURRENT_CONTINUITY],
    );
    assert.equal(activeContinuity.rows[0]?.count, 1);
  } finally {
    await pool.query("DELETE FROM outbox_consumer_dedupe WHERE event_id = $1", [EVENT_ID]).catch(() => undefined);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = $1", [scope]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_terminal_facts WHERE request_scope = $1", [scope]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = $1", [scope]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [SESSION_ID]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id IN ($1, $2)", [CONCURRENT_SESSION_A, CONCURRENT_SESSION_B]).catch(() => undefined);
    await pool.query("DELETE FROM device_leases WHERE lease_ref_id = $1", [LEASE_ID]).catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("T02 T11B HandoffFactRecord seam persists, replays, drifts fail closed, and rolls back in PostgreSQL", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const migrations = await Promise.all([
    readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"),
  ]);
  const repository = createRealtimeAuthorityRepository(pool);
  const scope = "realtime.handoff";
  const idempotencyKey = "pg-handoff-fact-key";
  const rollbackKey = "pg-handoff-fact-rollback-key";
  const sessionRef = ownerRef("RealtimeSession", HANDOFF_SESSION_ID) as any;
  const oldLeaseRef = ownerRef("DeviceLease", HANDOFF_OLD_LEASE_ID) as any;
  const newLeaseRef = ownerRef("DeviceLease", HANDOFF_NEW_LEASE_ID) as any;
  const record = Object.freeze({
    requestId: "pg-handoff-request",
    idempotencyKey,
    requestFingerprint: HANDOFF_FINGERPRINT,
    realtimeSessionRef: sessionRef,
    continuityId: HANDOFF_CONTINUITY_ID,
    fromDeviceId: HANDOFF_FROM_DEVICE_ID,
    toDeviceId: HANDOFF_TO_DEVICE_ID,
    connectionEpoch: "9007199254740993",
    oldLeaseRef,
    expectedLeaseVersion: "9007199254740994",
    releasedLeaseVersion: "9007199254740995",
    releasedFencingToken: "9007199254740996",
    newLeaseRef,
    newLeaseVersion: "9007199254740997",
    newFencingToken: "9007199254740998",
    suppressedDeviceId: HANDOFF_FROM_DEVICE_ID,
    outboxEventRef: Object.freeze({ event_id: "877aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa" }),
    occurredAt: "2026-08-23T12:10:00.000Z",
  }) as unknown as HandoffFactRecord;
  const recordHandoffFact = async (value: HandoffFactRecord): Promise<void> => {
    await repository.transaction("realtime.handoff", async (transaction) => {
      const method = transaction.recordHandoffFact;
      if (method === undefined) throw new Error("HANDOFF_FACT_RECORD_UNSUPPORTED");
      await method(value);
    });
  };
  try {
    for (const migration of migrations) await pool.query(migration);
    await pool.query("DELETE FROM realtime_handoff_facts WHERE request_scope = $1", [scope]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [HANDOFF_SESSION_ID]).catch(() => undefined);
    await pool.query(
      "INSERT INTO realtime_sessions (session_ref_id, session_object_version, session_payload_sha256, user_id, continuity_id, state, connection_epoch, continuity_expires_at, created_at, updated_at) VALUES ($1, 1, $2, $3, $4, 'active', $5, $6, $7, $7)",
      [HANDOFF_SESSION_ID, HASH, USER_ID, HANDOFF_CONTINUITY_ID, "9007199254740993", "2026-08-24T00:00:00.000Z", "2026-08-23T00:00:00.000Z"],
    );
    await recordHandoffFact(record);
    const first = await pool.query(
      "SELECT handoff_ref_id, session_ref_id, continuity_id, from_device_id, to_device_id, expected_lease_version::text AS expected_lease_version, resulting_lease_version::text AS resulting_lease_version, connection_epoch::text AS connection_epoch, request_scope, idempotency_key, request_hash, outcome, occurred_at FROM realtime_handoff_facts WHERE request_scope = $1 AND idempotency_key = $2",
      [scope, idempotencyKey],
    );
    assert.equal(first.rows.length, 1);
    assert.match(String(first.rows[0]?.handoff_ref_id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.equal(first.rows[0]?.session_ref_id, HANDOFF_SESSION_ID);
    assert.equal(first.rows[0]?.continuity_id, HANDOFF_CONTINUITY_ID);
    assert.equal(first.rows[0]?.from_device_id, HANDOFF_FROM_DEVICE_ID);
    assert.equal(first.rows[0]?.to_device_id, HANDOFF_TO_DEVICE_ID);
    assert.equal(first.rows[0]?.expected_lease_version, "9007199254740994");
    assert.equal(first.rows[0]?.resulting_lease_version, "9007199254740997");
    assert.equal(first.rows[0]?.connection_epoch, "9007199254740993");
    assert.equal(first.rows[0]?.request_scope, scope);
    assert.equal(first.rows[0]?.idempotency_key, idempotencyKey);
    assert.equal(String(first.rows[0]?.request_hash).trim(), HANDOFF_REQUEST_HASH);
    assert.equal(first.rows[0]?.outcome?.requestFingerprint, HANDOFF_FINGERPRINT);
    assert.deepEqual(first.rows[0]?.outcome, record);
    assert.equal(new Date(first.rows[0]?.occurred_at).toISOString(), record.occurredAt);

    await recordHandoffFact(record);
    const replay = await pool.query(
      "SELECT handoff_ref_id, count(*) OVER ()::int AS fact_count FROM realtime_handoff_facts WHERE request_scope = $1 AND idempotency_key = $2",
      [scope, idempotencyKey],
    );
    assert.equal(replay.rows.length, 1);
    assert.equal(replay.rows[0]?.fact_count, 1);
    assert.equal(replay.rows[0]?.handoff_ref_id, first.rows[0]?.handoff_ref_id);

    await assert.rejects(
      () => recordHandoffFact({ ...record, requestFingerprint: HANDOFF_DRIFT_FINGERPRINT } as HandoffFactRecord),
      /REALTIME_AUTHORITY_CONFLICT/,
    );
    assert.notEqual(HANDOFF_DRIFT_REQUEST_HASH, HANDOFF_REQUEST_HASH);
    const unchanged = await pool.query(
      "SELECT count(*)::int AS fact_count, min(request_hash) AS request_hash FROM realtime_handoff_facts WHERE request_scope = $1 AND idempotency_key = $2",
      [scope, idempotencyKey],
    );
    assert.equal(unchanged.rows[0]?.fact_count, 1);
    assert.equal(String(unchanged.rows[0]?.request_hash).trim(), HANDOFF_REQUEST_HASH);

    await assert.rejects(
      () => repository.transaction("realtime.handoff", async (transaction) => {
        const method = transaction.recordHandoffFact;
        if (method === undefined) throw new Error("HANDOFF_FACT_RECORD_UNSUPPORTED");
        await method({ ...record, idempotencyKey: rollbackKey } as HandoffFactRecord);
        throw new Error("force rollback after handoff fact");
      }),
      /force rollback after handoff fact/,
    );
    const orphan = await pool.query(
      "SELECT count(*)::int AS fact_count FROM realtime_handoff_facts WHERE request_scope = $1 AND idempotency_key = $2",
      [scope, rollbackKey],
    );
    assert.equal(orphan.rows[0]?.fact_count, 0);
  } finally {
    await pool.query("DELETE FROM realtime_handoff_facts WHERE request_scope = $1", [scope]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [HANDOFF_SESSION_ID]).catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("T11B production service serializes concurrent duplicate and rejects same-key payload drift", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const migrations = await Promise.all([
    readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"),
  ]);
  const repository = createRealtimeAuthorityRepository(pool);
  const userId = "93333333-3333-7333-8333-333333333333";
  const deviceId = "94444444-4444-7444-8444-444444444444";
  const continuityId = "95555555-5555-7555-8555-555555555555";
  const sessionRefId = "96666666-6666-7666-8666-666666666666";
  const leaseRefId = "97777777-7777-7777-8777-777777777777";
  const sessionRef = ownerRef("RealtimeSession", sessionRefId);
  const leaseRef = ownerRef("DeviceLease", leaseRefId);
  const idempotencyKey = "concurrent-bootstrap-key";
  const identity = {
    createContinuityId: () => continuityId,
    assertRepositoryIssuedRef(value: unknown, kind: "RealtimeSession" | "DeviceLease") {
      if (stableOwnerValue(value) !== stableOwnerValue(kind === "RealtimeSession" ? sessionRef : leaseRef)) throw new Error("IDENTITY_REF_INVALID");
    },
    createSessionRef: () => sessionRef,
    createDeviceLeaseRef: () => leaseRef,
    createTransportAlias: ({ requestId, deviceId: aliasDeviceId }: { requestId: string; deviceId: string }) => `alias-${aliasDeviceId}-${requestId}`,
    createConnectionId: ({ requestId }: { requestId: string }) => `connection-${requestId}`,
  };
  const at = assertCanonicalTimestamp("2026-08-23T12:00:00.000Z");
  const ports: RealtimeAuthorityPorts = {
    repository,
    policy: {
      async evaluate() {
        return {
          allowed: true as const,
          policyDecisionRef: "policy-concurrent",
          capabilities: ["audio.publish"],
          purpose: "conversation",
          leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
          revocable: true as const,
        };
      },
    },
    activityAcceptance: {
      async verify(activity) {
        return { verified: true as const, acceptanceRef: activity.acceptanceRef, acceptedAt: activity.occurredAt, authorityWatermark: "concurrent-watermark" };
      },
    },
    transportDisconnection: {
      async verify(input) {
        return { verified: true as const, disconnectedAt: input.occurredAt, authorityProof: "concurrent-disconnect-proof" };
      },
    },
    identity,
    clock: { now: () => at },
    equality: { key: stableOwnerValue, same: (left, right) => stableOwnerValue(left) === stableOwnerValue(right) },
  };
  const service = new RealtimeSessionService(ports);
  const request = {
    requestId: "concurrent-bootstrap",
    idempotencyKey,
    mode: "initial" as const,
    userId,
    deviceId,
    capabilities: ["audio.publish"],
    purpose: "conversation",
    occurredAt: at,
    governance: "concurrent-governance",
  };
  try {
    for (const migration of migrations) await pool.query(migration);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_key = $1", [idempotencyKey]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_terminal_facts WHERE idempotency_key = $1", [idempotencyKey]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE idempotency_key = $1", [idempotencyKey]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_transport_aliases WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await pool.query("DELETE FROM device_leases WHERE lease_ref_id = $1", [leaseRefId]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    const concurrent = await Promise.all([service.bootstrap(request), service.bootstrap({ ...request })]);
    assert.deepEqual(concurrent.map((result) => result.receipt.replayed).sort(), [false, true]);
    const authority = await pool.query("SELECT count(*)::int AS count FROM realtime_sessions WHERE session_ref_id = $1", [sessionRefId]);
    const leases = await pool.query("SELECT count(*)::int AS count FROM device_leases WHERE lease_ref_id = $1", [leaseRefId]);
    const ledger = await pool.query("SELECT count(*)::int AS count FROM idempotency_ledger WHERE scope = 'bootstrap' AND idempotency_key = $1", [idempotencyKey]);
    const outbox = await pool.query("SELECT count(*)::int AS count FROM outbox_events WHERE idempotency_scope = 'realtime.outbox' AND idempotency_key = $1", [idempotencyKey]);
    assert.equal(authority.rows[0]?.count, 1);
    assert.equal(leases.rows[0]?.count, 1);
    assert.equal(ledger.rows[0]?.count, 1);
    assert.equal(outbox.rows[0]?.count, 1);
    await assert.rejects(
      () => service.bootstrap({ ...request, requestId: "concurrent-bootstrap-drift" }),
      /IDEMPOTENCY_CONFLICT/,
    );
    const unchanged = await pool.query(
      "SELECT (SELECT count(*) FROM realtime_sessions WHERE session_ref_id = $1) AS sessions, (SELECT count(*) FROM device_leases WHERE lease_ref_id = $2) AS leases, (SELECT count(*) FROM outbox_events WHERE idempotency_scope = 'realtime.outbox' AND idempotency_key = $3) AS outbox",
      [sessionRefId, leaseRefId, idempotencyKey],
    );
    assert.equal(String(unchanged.rows[0]?.sessions), "1");
    assert.equal(String(unchanged.rows[0]?.leases), "1");
    assert.equal(String(unchanged.rows[0]?.outbox), "1");
  } finally {
    await pool.query("DELETE FROM outbox_events WHERE idempotency_key = $1", [idempotencyKey]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_terminal_facts WHERE idempotency_key = $1", [idempotencyKey]).catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE idempotency_key = $1", [idempotencyKey]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_transport_aliases WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await pool.query("DELETE FROM device_leases WHERE lease_ref_id = $1", [leaseRefId]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await closePostgresPool(pool);
  }
});

test("T11B service composes with the production T02 adapter across refresh, activity, handoff, Stop and end-continuity", { skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false, concurrency: false }, async () => {
  const pool = createPostgresPool();
  const migrations = await Promise.all([
    readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../migrations/0002_realtime_authority.up.sql", import.meta.url), "utf8"),
  ]);
  const repository = createRealtimeAuthorityRepository(pool);
  const userId = "87777777-7777-7777-8777-777777777777";
  const deviceOne = "88888888-8888-7888-8888-888888888888";
  const deviceTwo = "89999999-9999-7999-8999-999999999999";
  const continuityId = "8aaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const sessionRefId = "8bbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const leaseOneId = "8ccccccc-cccc-7ccc-8ccc-cccccccccccc";
  const leaseTwoId = "8ddddddd-dddd-7ddd-8ddd-dddddddddddd";
  const sessionRef = ownerRef("RealtimeSession", sessionRefId);
  const leaseOne = ownerRef("DeviceLease", leaseOneId);
  const leaseTwo = ownerRef("DeviceLease", leaseTwoId);
  const identity = {
    createContinuityId: () => continuityId,
    assertRepositoryIssuedRef(value: unknown, kind: "RealtimeSession" | "DeviceLease") {
      const expected = kind === "RealtimeSession"
        ? sessionRef
        : stableOwnerValue(value) === stableOwnerValue(leaseOne) ? leaseOne : leaseTwo;
      if (stableOwnerValue(value) !== stableOwnerValue(expected)) throw new Error("IDENTITY_REF_INVALID_" + kind);
    },
    createSessionRef: () => sessionRef,
    createDeviceLeaseRef: ({ deviceId }: { deviceId: string }) => deviceId === deviceOne ? leaseOne : leaseTwo,
    createTransportAlias: ({ requestId, deviceId }: { requestId: string; deviceId: string }) => "alias-" + deviceId + "-" + requestId,
    createConnectionId: ({ requestId }: { requestId: string }) => "connection-" + requestId,
  };
  const at = assertCanonicalTimestamp("2026-08-23T12:00:00.000Z");
  let now = at;
  const ports: RealtimeAuthorityPorts = {
    repository,
    policy: {
      async evaluate() {
        return {
          allowed: true as const,
          policyDecisionRef: "policy-composition",
          capabilities: ["audio.publish"],
          purpose: "conversation",
          leaseExpiresAt: assertCanonicalTimestamp("2026-08-23T13:00:00.000Z"),
          revocable: true as const,
        };
      },
    },
    activityAcceptance: {
      async verify(activity) {
        return {
          verified: true as const,
          acceptanceRef: activity.acceptanceRef,
          acceptedAt: activity.occurredAt,
          authorityWatermark: "composition-watermark",
        };
      },
    },
    transportDisconnection: {
      async verify(input) {
        return {
          verified: true as const,
          disconnectedAt: input.occurredAt,
          authorityProof: "composition-disconnect-proof",
        };
      },
    },
    identity,
    clock: { now: () => now },
    equality: { key: stableOwnerValue, same: (left, right) => stableOwnerValue(left) === stableOwnerValue(right) },
  };
  const service = new RealtimeSessionService(ports);
  const scope = "pg-t11b-composition";
  try {
    for (const migration of migrations) await pool.query(migration);
    await pool.query("DELETE FROM outbox_events WHERE idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM realtime_terminal_facts WHERE idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM realtime_transport_aliases WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await pool.query("DELETE FROM device_leases WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    const started = await service.bootstrap({
      requestId: "composition-bootstrap",
      idempotencyKey: "composition-bootstrap-key",
      mode: "initial",
      userId,
      deviceId: deviceOne,
      capabilities: ["audio.publish"],
      purpose: "conversation",
      occurredAt: at,
      governance: "composition-governance",
    });
    const currentAfterBootstrap = await repository.transaction("realtime.current_binding.bootstrap", (tx) =>
      tx.readCurrentBinding({ realtimeSessionRef: started.realtimeSessionRef }));
    assert.ok(currentAfterBootstrap);
    assert.deepEqual(currentAfterBootstrap.session.realtimeSessionRef, sessionRef);
    assert.deepEqual(currentAfterBootstrap.session.activeDeviceLeaseRef, leaseOne);
    assert.deepEqual(currentAfterBootstrap.lease.deviceLeaseRef, leaseOne);
    assert.equal(currentAfterBootstrap.session.binding.state, "connected");
    assert.equal(currentAfterBootstrap.lease.state, "active");
    const currentByContinuity = await repository.transaction("realtime.current_binding.continuity", (tx) =>
      tx.readCurrentBinding({ continuityId }));
    assert.ok(currentByContinuity);
    assert.deepEqual(currentByContinuity.session.realtimeSessionRef, sessionRef);
    now = assertCanonicalTimestamp("2026-08-23T12:01:00.000Z");
    const refreshed = await service.refresh({
      requestId: "composition-refresh",
      idempotencyKey: "composition-refresh-key",
      binding: started.binding,
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:01:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(refreshed.receipt.status, "success");
    const currentSession = await repository.transaction("negative.session.read", (tx) => tx.readSession(started.realtimeSessionRef));
    assert.ok(currentSession);
    assert.deepEqual(currentSession.realtimeSessionRef, sessionRef);
    assert.deepEqual(currentSession.activeDeviceLeaseRef, leaseOne);
    const continuitySession = await repository.transaction("negative.session.continuity-read", (tx) => tx.readSessionByContinuityId(continuityId));
    assert.ok(continuitySession);
    assert.deepEqual(continuitySession.realtimeSessionRef, sessionRef);
    await assert.rejects(
      () => repository.transaction("negative.requested.session.version", (tx) => tx.readSession({
        ...(started.realtimeSessionRef as Record<string, unknown>),
        object_version: "2",
      } as any)),
      /REALTIME_AUTHORITY_CONFLICT/,
    );
    await assert.rejects(
      () => repository.transaction("negative.requested.session.hash", (tx) => tx.readSession({
        ...(started.realtimeSessionRef as Record<string, unknown>),
        canonical_payload_sha256: HASH_B,
      } as any)),
      /REALTIME_AUTHORITY_CONFLICT/,
    );
    await pool.query("UPDATE realtime_sessions SET session_object_version = 2 WHERE session_ref_id = $1", [sessionRefId]);
    try {
      await assert.rejects(
        () => repository.transaction("negative.read.session.version", (tx) => tx.readSession(started.realtimeSessionRef)),
        /REALTIME_AUTHORITY_CONFLICT/,
      );
    } finally {
      await pool.query("UPDATE realtime_sessions SET session_object_version = 1 WHERE session_ref_id = $1", [sessionRefId]);
    }
    await pool.query("UPDATE realtime_sessions SET session_payload_sha256 = $2 WHERE session_ref_id = $1", [sessionRefId, HASH_B]);
    try {
      await assert.rejects(
        () => repository.transaction("negative.read.session.hash", (tx) => tx.readSession(started.realtimeSessionRef)),
        /REALTIME_AUTHORITY_CONFLICT/,
      );
    } finally {
      await pool.query("UPDATE realtime_sessions SET session_payload_sha256 = $2 WHERE session_ref_id = $1", [sessionRefId, HASH]);
    }
    await assert.rejects(
      () => repository.transaction("negative.session.monotonic", (tx) => tx.writeSession({ record: currentSession })),
      /FENCING_CONFLICT/,
    );
    const currentLease = await repository.transaction("negative.lease.read", (tx) => tx.readLease(started.deviceLeaseRef));
    assert.ok(currentLease);
    assert.deepEqual(currentLease.deviceLeaseRef, leaseOne);
    assert.deepEqual(currentLease.realtimeSessionRef, sessionRef);
    await assert.rejects(
      () => repository.transaction("negative.requested.lease.version", (tx) => tx.readLease({
        ...(started.deviceLeaseRef as Record<string, unknown>),
        object_version: "2",
      } as any)),
      /REALTIME_AUTHORITY_CONFLICT/,
    );
    await assert.rejects(
      () => repository.transaction("negative.requested.lease.hash", (tx) => tx.readLease({
        ...(started.deviceLeaseRef as Record<string, unknown>),
        canonical_payload_sha256: HASH_B,
      } as any)),
      /REALTIME_AUTHORITY_CONFLICT/,
    );
    await pool.query("UPDATE device_leases SET lease_object_version = 2 WHERE lease_ref_id = $1", [leaseOneId]);
    try {
      await assert.rejects(
        () => repository.transaction("negative.read.lease.version", (tx) => tx.readLease(started.deviceLeaseRef)),
        /REALTIME_AUTHORITY_CONFLICT/,
      );
    } finally {
      await pool.query("UPDATE device_leases SET lease_object_version = 1 WHERE lease_ref_id = $1", [leaseOneId]);
    }
    await pool.query("UPDATE device_leases SET lease_payload_sha256 = $2 WHERE lease_ref_id = $1", [leaseOneId, HASH_B]);
    try {
      await assert.rejects(
        () => repository.transaction("negative.read.lease.hash", (tx) => tx.readLease(started.deviceLeaseRef)),
        /REALTIME_AUTHORITY_CONFLICT/,
      );
    } finally {
      await pool.query("UPDATE device_leases SET lease_payload_sha256 = $2 WHERE lease_ref_id = $1", [leaseOneId, HASH]);
    }
    await pool.query("UPDATE device_leases SET state = 'released', released_at = now() WHERE lease_ref_id = $1", [leaseOneId]);
    try {
      await assert.rejects(
        () => repository.transaction("negative.binding.released-lease", (tx) => tx.writeBinding({
          expectedConnectionEpoch: started.connectionEpoch,
          binding: started.binding,
        })),
        /REALTIME_AUTHORITY_CONFLICT/,
      );
    } finally {
      await pool.query("UPDATE device_leases SET state = 'active', released_at = NULL WHERE lease_ref_id = $1", [leaseOneId]);
    }
    await assert.rejects(
      () => repository.transaction("negative.lease.monotonic", (tx) => tx.writeLease({ record: currentLease })),
      /FENCING_CONFLICT/,
    );
    await assert.rejects(
      () => repository.transaction("negative.binding.cross-check", (tx) => tx.writeBinding({
        expectedConnectionEpoch: started.connectionEpoch,
        binding: { ...started.binding, deviceId: deviceTwo as any },
      })),
      /REALTIME_AUTHORITY_CONFLICT/,
    );
    await assert.rejects(
      () => repository.transaction("negative.binding.epoch", (tx) => tx.writeBinding({
        expectedConnectionEpoch: "2",
        binding: started.binding,
      })),
      /FENCING_CONFLICT/,
    );
    const deterministicRejectKey = "composition-deterministic-stop-key";
    await assert.rejects(
      () => service.stop({
        requestId: "composition-deterministic-stop",
        idempotencyKey: deterministicRejectKey,
        operation: "media_stop",
        realtimeSessionRef: started.realtimeSessionRef,
        continuityId: "8eeeeeee-eeee-7eee-8eee-eeeeeeeeeeee" as any,
        deviceLeaseRef: started.deviceLeaseRef,
        deviceId: deviceOne,
        expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
        expectedLeaseVersion: "1" as any,
        reason: "user_stop",
        occurredAt: assertCanonicalTimestamp("2026-08-23T12:01:00.000Z"),
        governance: "composition-governance",
      }),
      /STOP_CONTINUITY_BINDING_INVALID/,
    );
    const deterministicFacts = await pool.query(
      "SELECT (SELECT count(*) FROM idempotency_ledger WHERE scope = 'media_stop' AND idempotency_key = $1) AS ledger, (SELECT count(*) FROM realtime_terminal_facts WHERE idempotency_key = $1) AS terminal, (SELECT count(*) FROM outbox_events WHERE idempotency_key = $1) AS outbox",
      [deterministicRejectKey],
    );
    assert.equal(String(deterministicFacts.rows[0]?.ledger), "0");
    assert.equal(String(deterministicFacts.rows[0]?.terminal), "0");
    assert.equal(String(deterministicFacts.rows[0]?.outbox), "0");
    now = assertCanonicalTimestamp("2026-08-23T12:02:00.000Z");
    const renewed = await service.recordAcceptedUserActivity({
      activityId: "composition-activity",
      kind: "accepted_user_activity",
      accepted: true,
      acceptanceRef: "composition-acceptance",
      userId,
      deviceId: deviceOne,
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:02:00.000Z"),
    });
    assert.equal(renewed.continuityId, continuityId);
    now = assertCanonicalTimestamp("2026-08-23T12:03:00.000Z");
    const handed = await service.handoff({
      requestId: "composition-handoff",
      idempotencyKey: "composition-handoff-key",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      fromDeviceId: deviceOne,
      toDeviceId: deviceTwo,
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: "1" as any,
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:03:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(handed.activeDeviceId, deviceTwo);
    const handoffFacts = await pool.query(
      "SELECT count(*) OVER ()::int AS fact_count, request_scope, request_hash, outcome FROM realtime_handoff_facts WHERE request_scope = 'realtime.handoff' AND idempotency_key = $1 LIMIT 1",
      ["composition-handoff-key"],
    );
    assert.equal(handoffFacts.rows[0]?.fact_count, 1);
    assert.equal(handoffFacts.rows[0]?.request_scope, "realtime.handoff");
    assert.match(String(handoffFacts.rows[0]?.request_hash ?? "").trim(), /^[0-9a-f]{64}$/iu);
    assert.equal(handoffFacts.rows[0]?.outcome?.continuityId, continuityId);
    assert.equal(handoffFacts.rows[0]?.outcome?.fromDeviceId, deviceOne);
    assert.equal(handoffFacts.rows[0]?.outcome?.toDeviceId, deviceTwo);
    assert.equal(handoffFacts.rows[0]?.outcome?.oldLeaseRef?.ref_id, leaseOneId);
    assert.equal(handoffFacts.rows[0]?.outcome?.newLeaseRef?.ref_id, leaseTwoId);
    assert.equal(typeof handoffFacts.rows[0]?.outcome?.outboxEventRef, "string");
    const handedReplay = await service.handoff({
      requestId: "composition-handoff",
      idempotencyKey: "composition-handoff-key",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      fromDeviceId: deviceOne,
      toDeviceId: deviceTwo,
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: "1" as any,
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:03:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(handedReplay.receipt.replayed, true);
    await assert.rejects(
      () => service.handoff({
        requestId: "composition-handoff-drift",
        idempotencyKey: "composition-handoff-key",
        realtimeSessionRef: started.realtimeSessionRef,
        continuityId,
        fromDeviceId: deviceOne,
        toDeviceId: deviceOne,
        expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
        expectedLeaseVersion: "1" as any,
        occurredAt: assertCanonicalTimestamp("2026-08-23T12:03:00.000Z"),
        governance: "composition-governance",
      }),
      /IDEMPOTENCY_CONFLICT/,
    );
    const handoffFactCountAfterReplay = await pool.query(
      "SELECT count(*)::int AS fact_count FROM realtime_handoff_facts WHERE request_scope = 'realtime.handoff' AND idempotency_key = $1",
      ["composition-handoff-key"],
    );
    assert.equal(handoffFactCountAfterReplay.rows[0]?.fact_count, 1);
    now = assertCanonicalTimestamp("2026-08-23T12:04:00.000Z");
    const stopped = await service.stop({
      requestId: "composition-stop",
      idempotencyKey: "composition-stop-key",
      operation: "media_stop",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      deviceLeaseRef: handed.activeDeviceLeaseRef,
      deviceId: deviceTwo,
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: handed.leaseVersion as any,
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:04:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(stopped.status, "success");
    const currentAfterStop = await repository.transaction("realtime.current_binding.after-stop", (tx) =>
      tx.readCurrentBinding({ realtimeSessionRef: started.realtimeSessionRef }));
    assert.ok(currentAfterStop);
    assert.equal(currentAfterStop.session.binding.state, "released");
    assert.equal(currentAfterStop.lease.state, "released");
    assert.deepEqual(currentAfterStop.lease.deviceLeaseRef, leaseTwo);
    const restartedService = new RealtimeSessionService({
      ...ports,
      repository: createRealtimeAuthorityRepository(pool),
    });
    const currentFromNewRepository = await restartedService.readCurrentBinding({
      realtimeSessionRef: started.realtimeSessionRef,
    });
    assert.ok(currentFromNewRepository);
    assert.equal(currentFromNewRepository.session.binding.state, "released");
    const stopReplayFromNewService = await restartedService.stop({
      requestId: "composition-stop",
      idempotencyKey: "composition-stop-key",
      operation: "media_stop",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      deviceLeaseRef: handed.activeDeviceLeaseRef,
      deviceId: deviceTwo,
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: handed.leaseVersion as any,
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:04:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(stopReplayFromNewService.replayed, true);
    const exactRefs = await pool.query(
      "SELECT s.realtime_session_ref AS session_ref, l.device_lease_ref AS lease_ref, l.realtime_session_ref AS lease_session_ref FROM realtime_sessions s JOIN device_leases l ON l.lease_ref_id = $2 WHERE s.session_ref_id = $1",
      [sessionRefId, leaseTwoId],
    );
    assert.deepEqual(exactRefs.rows[0]?.session_ref, sessionRef);
    assert.deepEqual(exactRefs.rows[0]?.lease_ref, leaseTwo);
    assert.deepEqual(exactRefs.rows[0]?.lease_session_ref, sessionRef);
    const exactTerminal = await pool.query(
      "SELECT realtime_session_ref, device_lease_ref FROM realtime_terminal_facts WHERE idempotency_key = $1",
      ["composition-stop-key"],
    );
    assert.deepEqual(exactTerminal.rows[0]?.realtime_session_ref, sessionRef);
    assert.deepEqual(exactTerminal.rows[0]?.device_lease_ref, leaseTwo);
    const exactOutbox = await pool.query(
      "SELECT aggregate_ref FROM outbox_events WHERE idempotency_scope = 'realtime.outbox' AND idempotency_key = $1",
      ["composition-stop-key"],
    );
    assert.deepEqual(exactOutbox.rows[0]?.aggregate_ref, sessionRef);
    now = assertCanonicalTimestamp("2026-08-23T12:05:00.000Z");
    const ended = await service.stop({
      requestId: "composition-end",
      idempotencyKey: "composition-end-key",
      operation: "end_continuity",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      deviceLeaseRef: handed.activeDeviceLeaseRef,
      deviceId: deviceTwo,
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:05:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(ended.status, "success");
    const currentAfterEnd = await repository.transaction("realtime.current_binding.after-end", (tx) =>
      tx.readCurrentBinding({ realtimeSessionRef: started.realtimeSessionRef }));
    assert.ok(currentAfterEnd);
    assert.equal(currentAfterEnd.session.state, "terminal");
    assert.equal(currentAfterEnd.session.continuityState, "ended");
    assert.equal(currentAfterEnd.session.binding.state, "released");
    assert.equal(currentAfterEnd.lease.state, "released");
    assert.equal(await repository.transaction("realtime.current_binding.ended-continuity", (tx) =>
      tx.readCurrentBinding({ continuityId })), undefined);
    const stopLedger = await pool.query(
      "SELECT scope, status, request_fingerprint, response IS NULL AS response_is_null, response_hash FROM idempotency_ledger WHERE idempotency_key = $1",
      ["composition-stop-key"],
    );
    assert.equal(stopLedger.rows[0]?.status, "committed");
    assert.equal(stopLedger.rows[0]?.response_is_null, false);
    assert.match(String(stopLedger.rows[0]?.response_hash ?? ""), /^[0-9a-f]{64}$/iu);
    const replay = await service.stop({
      requestId: "composition-stop",
      idempotencyKey: "composition-stop-key",
      operation: "media_stop",
      realtimeSessionRef: started.realtimeSessionRef,
      continuityId,
      deviceLeaseRef: handed.activeDeviceLeaseRef,
      deviceId: deviceTwo,
      expectedConnectionEpoch: assertDecimalConnectionEpoch("1"),
      expectedLeaseVersion: handed.leaseVersion as any,
      reason: "user_stop",
      occurredAt: assertCanonicalTimestamp("2026-08-23T12:04:00.000Z"),
      governance: "composition-governance",
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.realtimeSessionRef, sessionRef);
    assert.deepEqual(replay.deviceLeaseRef, leaseTwo);
    const terminal = await pool.query("SELECT count(*)::int AS count FROM realtime_terminal_facts WHERE idempotency_key LIKE 'composition-%'");
    const terminalKeys = await pool.query("SELECT idempotency_key, operation FROM realtime_terminal_facts WHERE idempotency_key LIKE 'composition-%' ORDER BY idempotency_key");
    assert.equal(terminalKeys.rows.length, 5);
    assert.ok(Number(terminal.rows[0]?.count) >= 5);
    const aliases = await pool.query("SELECT count(*)::int AS active_count FROM realtime_transport_aliases WHERE session_ref_id = $1 AND active = TRUE", [sessionRefId]);
    assert.equal(aliases.rows[0]?.active_count, 0);
  } finally {
    await pool.query("DELETE FROM outbox_events WHERE idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM realtime_terminal_facts WHERE idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM realtime_handoff_facts WHERE request_scope = 'realtime.handoff' AND idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM idempotency_ledger WHERE idempotency_key LIKE 'composition-%'").catch(() => undefined);
    await pool.query("DELETE FROM realtime_transport_aliases WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await pool.query("DELETE FROM device_leases WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [sessionRefId]).catch(() => undefined);
    await closePostgresPool(pool);
  }
});
