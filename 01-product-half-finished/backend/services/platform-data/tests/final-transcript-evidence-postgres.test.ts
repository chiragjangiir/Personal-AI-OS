import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient, QueryResult } from "pg";

import {
  createFinalTranscriptEvidenceService,
  type FinalTranscriptEvidenceInput,
  type T11BCanonicalRef,
} from "../../realtime-core/src/final-transcript-evidence-service.ts";
import type {
  RealtimeAuthorityRepository,
  RealtimeAuthorityTransaction,
} from "../../realtime-core/src/ports.ts";
import type {
  CanonicalTimestamp,
  DeviceLeaseRecord,
  IdempotencyRecord,
  OpaqueCanonicalRef,
  OutboxEvent,
  RealtimeSessionRecord,
} from "../../realtime-core/src/types.ts";
import type { CanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import {
  createFinalTranscriptEvidencePostgresReader,
  createFinalTranscriptEvidenceRepositoryBridge,
  createPostgresSchemaReadinessReader,
  FinalTranscriptEvidencePostgresError,
} from "../src/final-transcript-evidence-postgres.ts";

const HASH = "a".repeat(64);
const SESSION_ID = "01952f00-0000-7000-8000-000000000101";
const LEASE_ID = "01952f00-0000-7000-8000-000000000102";
const USER_ID = "01952f00-0000-7000-8000-000000000103";
const DEVICE_ID = "01952f00-0000-7000-8000-000000000104";
const CONTINUITY_ID = "01952f00-0000-7000-8000-000000000105";
const EVENT_ID = "01952f00-0000-4000-8000-000000000106";
const OBSERVED_AT = "2026-08-27T01:02:03.123Z" as CanonicalTimestamp;
const EXPIRES_AT = "2026-08-27T02:02:03.123Z" as CanonicalTimestamp;

const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: SESSION_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
}) as unknown as OpaqueCanonicalRef;
const LEASE_REF = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: LEASE_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
}) as unknown as OpaqueCanonicalRef;

function sourceRef(): T11BCanonicalRef {
  return Object.freeze({
    refType: "SourceArtifact",
    refId: "01952f00-0000-7000-8000-000000000201",
    objectVersion: "1",
    canonicalPayloadSha256: HASH,
  });
}

function input(overrides: Partial<FinalTranscriptEvidenceInput> = {}): FinalTranscriptEvidenceInput {
  return {
    transcriptState: "final",
    userId: USER_ID,
    deviceId: DEVICE_ID,
    realtimeSessionRef: SESSION_REF,
    continuityId: CONTINUITY_ID,
    purpose: "conversation",
    text: "请记住桥接测试词。",
    language: "zh-CN",
    sourceMediaRef: sourceRef(),
    observedAt: OBSERVED_AT,
    idempotencyKey: "final-transcript-postgres-unit-001" as FinalTranscriptEvidenceInput["idempotencyKey"],
    ...overrides,
  };
}

function session(): RealtimeSessionRecord {
  return {
    realtimeSessionRef: SESSION_REF,
    userId: USER_ID as RealtimeSessionRecord["userId"],
    continuityId: CONTINUITY_ID as RealtimeSessionRecord["continuityId"],
    state: "active",
    continuityState: "active",
    connectionEpoch: "1" as RealtimeSessionRecord["connectionEpoch"],
    continuityExpiresAt: EXPIRES_AT,
    lastAcceptedUserActivityAt: OBSERVED_AT,
    activeDeviceId: DEVICE_ID as RealtimeSessionRecord["activeDeviceId"],
    activeDeviceLeaseRef: LEASE_REF,
    binding: {
      state: "connected",
      realtimeSessionRef: SESSION_REF,
      deviceLeaseRef: LEASE_REF,
      continuityId: CONTINUITY_ID as RealtimeSessionRecord["continuityId"],
      deviceId: DEVICE_ID as RealtimeSessionRecord["activeDeviceId"],
      connectionEpoch: "1" as RealtimeSessionRecord["connectionEpoch"],
      provider: { provider: "livekit", value: "provider-final" },
      transportSessionAlias: { provider: "livekit", value: "transport-final" },
      roomAlias: { provider: "livekit", value: "room-final" },
      deviceAlias: { provider: "livekit", value: "device-final" },
      connectionId: "connection-final",
    },
    revision: "1" as RealtimeSessionRecord["revision"],
  };
}

function lease(): DeviceLeaseRecord {
  return {
    deviceLeaseRef: LEASE_REF,
    realtimeSessionRef: SESSION_REF,
    continuityId: CONTINUITY_ID as DeviceLeaseRecord["continuityId"],
    userId: USER_ID as DeviceLeaseRecord["userId"],
    deviceId: DEVICE_ID as DeviceLeaseRecord["deviceId"],
    state: "active",
    capabilities: ["microphone"],
    purpose: "conversation",
    issuedAt: "2026-08-27T00:02:03.123Z" as CanonicalTimestamp,
    expiresAt: EXPIRES_AT,
    revocable: true,
    leaseVersion: "1" as DeviceLeaseRecord["leaseVersion"],
    fencingToken: "1" as DeviceLeaseRecord["fencingToken"],
    policyDecisionRef: { kind: "PolicyDecision", id: "policy-final" },
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

class Repository implements RealtimeAuthorityRepository {
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly outbox: OutboxEvent[] = [];

  async transaction<T>(_operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
    const tx: RealtimeAuthorityTransaction = {
      readSession: async () => session(),
      readSessionByContinuityId: async () => session(),
      readLease: async () => lease(),
      readCurrentBinding: async () => undefined,
      readActiveDeviceSessions: async () => [],
      readIdempotency: async (operation, key) => this.idempotency.get(`${operation}:${key}`),
      writeSession: async () => undefined,
      writeLease: async () => undefined,
      writeBinding: async () => undefined,
      recordHandoffFact: async () => undefined,
      writeIdempotency: async (record) => { this.idempotency.set(`${record.operation}:${record.idempotencyKey}`, record); },
      appendOutbox: async (event) => {
        this.outbox.push(event);
        return EVENT_ID as unknown as OpaqueCanonicalRef;
      },
    };
    return work(tx);
  }
}

function result(rows: readonly Record<string, unknown>[] = []): QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: [...rows] } as QueryResult;
}

class ReaderClient {
  readonly payload: Record<string, unknown>;
  readonly response: Record<string, unknown>;
  readonly duplicate: boolean;
  readonly payloadSha256: string | undefined;
  readonly queries: string[] = [];

  constructor(
    payload: Record<string, unknown>,
    response: Record<string, unknown>,
    duplicate = false,
    payloadSha256?: string,
  ) {
    this.payload = payload;
    this.response = response;
    this.duplicate = duplicate;
    this.payloadSha256 = payloadSha256;
  }

  async query(text: string | { readonly text?: string }, values?: readonly unknown[]): Promise<QueryResult> {
    const sql = typeof text === "string" ? text : text.text ?? "";
    this.queries.push(sql);
    if (sql.startsWith("BEGIN") || sql.startsWith("SET TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") return result();
    if (sql.includes("FROM outbox_events")) {
      const evidenceRef = this.payload.evidenceRef as Record<string, unknown>;
      assert.equal(values?.[0], evidenceRef.refId);
      const row = {
        event_id: EVENT_ID,
        aggregate_type: "realtime",
        aggregate_id: SESSION_ID,
        aggregate_ref: SESSION_REF,
        event_type: "realtime.transcript_segment.finalized.v1",
        event_version: 1,
        idempotency_scope: "realtime.outbox",
        idempotency_key: input().idempotencyKey,
        payload: this.payload,
        payload_sha256: this.payloadSha256 ?? hash(this.payload),
      };
      return result(this.duplicate ? [row, { ...row, event_id: "01952f00-0000-4000-8000-000000000107" }] : [row]);
    }
    if (sql.includes("FROM realtime_sessions")) {
      return result([{ realtime_session_ref: SESSION_REF, user_id: USER_ID, continuity_id: CONTINUITY_ID }]);
    }
    if (sql.includes("FROM idempotency_ledger")) {
      const fingerprint = "unit-request-fingerprint";
      return result([{
        request_fingerprint: fingerprint,
        request_hash: createHash("sha256").update(fingerprint).digest("hex"),
        status: "committed",
        response: this.response,
        response_hash: hash(this.response),
      }]);
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  release(): void {}
}

class HostReadinessClient {
  readonly host: string;

  constructor(host: string) {
    this.host = host;
  }

  async query(text: string | { readonly text?: string }): Promise<QueryResult> {
    const sql = typeof text === "string" ? text : text.text ?? "";
    if (sql.startsWith("BEGIN") || sql.startsWith("SET TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") return result();
    if (sql.includes("current_database() AS database")) {
      assert.match(sql, /host\(inet_server_addr\(\)\) AS host/u);
      return result([{
        host: this.host,
        port: 55433,
        database: "personal_ai_os_t02_final_transcript",
        user: "paios_t02_final_transcript_app",
        server_version: "18.6",
        server_version_num: "180006",
        read_only: "on",
      }]);
    }
    throw new Error("CANONICAL_HOST_ACCEPTED");
  }

  release(): void {}
}

function poolFor(client: ReaderClient | HostReadinessClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

function readinessArtifact(): Readonly<{ absolutePath: string; sha256: string }> {
  const absolutePath = fileURLToPath(import.meta.url);
  return Object.freeze({ absolutePath, sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex") });
}

test("bridge stores the exact authoritative RealtimeSession aggregate and replays once", async () => {
  const base = new Repository();
  const service = createFinalTranscriptEvidenceService(createFinalTranscriptEvidenceRepositoryBridge(base));
  const first = await service.finalize(input());
  const replay = await service.finalize(input());
  assert.deepEqual(replay, first);
  assert.equal(base.outbox.length, 1);
  assert.deepEqual(base.outbox[0]?.aggregateRef, SESSION_REF);
  const payload = base.outbox[0]?.payload as Record<string, unknown>;
  assert.deepEqual(payload.evidenceRef, first.evidenceRef);
  assert.equal(base.idempotency.size, 1);
});

test("reader proves the outbox, session and idempotency projection", async () => {
  const base = new Repository();
  const service = createFinalTranscriptEvidenceService(createFinalTranscriptEvidenceRepositoryBridge(base));
  const committed = await service.finalize(input());
  const payload = base.outbox[0]!.payload as Record<string, unknown>;
  const client = new ReaderClient(payload, {
    transcriptSegmentRef: committed.transcriptSegmentRef,
    evidenceRef: committed.evidenceRef,
    outboxEventRef: EVENT_ID,
    observedAt: committed.observedAt,
  });
  const reader = createFinalTranscriptEvidencePostgresReader(poolFor(client));
  const record = await reader.read(committed.evidenceRef as unknown as CanonicalObjectVersionRef);
  assert.equal(record?.ref.refType, "FinalTranscriptEvidence");
  assert.equal(record?.userId, USER_ID);
  assert.equal(record?.purpose, "conversation");
  assert.equal(record?.text, input().text);
  assert.ok(client.queries.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.equal(client.queries.some((sql) => /FOR\s+(?:SHARE|UPDATE)/iu.test(sql)), false);
});

test("reader fails closed on a duplicate evidence projection", async () => {
  const base = new Repository();
  const committed = await createFinalTranscriptEvidenceService(
    createFinalTranscriptEvidenceRepositoryBridge(base),
  ).finalize(input());
  const payload = base.outbox[0]!.payload as Record<string, unknown>;
  const reader = createFinalTranscriptEvidencePostgresReader(poolFor(new ReaderClient(payload, {}, true)));
  await assert.rejects(
    reader.read(committed.evidenceRef as unknown as CanonicalObjectVersionRef),
    (error: unknown) => error instanceof FinalTranscriptEvidencePostgresError && error.code === "FINAL_TRANSCRIPT_DUPLICATE",
  );
});

test("reader remains fail closed on a stored payload hash drift", async () => {
  const base = new Repository();
  const committed = await createFinalTranscriptEvidenceService(
    createFinalTranscriptEvidenceRepositoryBridge(base),
  ).finalize(input());
  const payload = base.outbox[0]!.payload as Record<string, unknown>;
  const reader = createFinalTranscriptEvidencePostgresReader(
    poolFor(new ReaderClient(payload, {}, false, "b".repeat(64))),
  );
  await assert.rejects(
    reader.read(committed.evidenceRef as unknown as CanonicalObjectVersionRef),
    (error: unknown) => error instanceof FinalTranscriptEvidencePostgresError && error.code === "FINAL_TRANSCRIPT_OUTBOX_DRIFT",
  );
});

test("readiness options reject an unbound catalog definition", () => {
  assert.throws(
    () => createPostgresSchemaReadinessReader({
      pool: poolFor(new ReaderClient({}, {})),
      expected: {
        host: "127.0.0.1", port: 55432, database: "personal_ai_os", user: "paios_memory_app",
        serverVersion: "18.6", catalogDefinitionSha256: "not-a-hash",
      },
      readinessArtifact: { absolutePath: "D:\\invalid", sha256: HASH },
    }),
    (error: unknown) => error instanceof FinalTranscriptEvidencePostgresError && error.code === "PG_READINESS_OPTIONS_INVALID",
  );
});

test("readiness asks PostgreSQL for canonical host text and accepts plain loopback", async () => {
  const reader = createPostgresSchemaReadinessReader({
    pool: poolFor(new HostReadinessClient("127.0.0.1")),
    expected: {
      host: "127.0.0.1", port: 55433, database: "personal_ai_os_t02_final_transcript",
      user: "paios_t02_final_transcript_app", serverVersion: "18.6", catalogDefinitionSha256: HASH,
    },
    readinessArtifact: readinessArtifact(),
  });
  await assert.rejects(reader.read(), /CANONICAL_HOST_ACCEPTED/u);
});

test("readiness rejects a wrong literal expected host", async () => {
  const reader = createPostgresSchemaReadinessReader({
    pool: poolFor(new HostReadinessClient("127.0.0.1")),
    expected: {
      host: "127.0.0.2", port: 55433, database: "personal_ai_os_t02_final_transcript",
      user: "paios_t02_final_transcript_app", serverVersion: "18.6", catalogDefinitionSha256: HASH,
    },
    readinessArtifact: readinessArtifact(),
  });
  await assert.rejects(
    reader.read(),
    (error: unknown) => error instanceof FinalTranscriptEvidencePostgresError && error.code === "PG_READINESS_IDENTITY_MISMATCH",
  );
});
