import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { RealtimeAuthorityRepository as T11BRealtimeAuthorityRepository } from "../../realtime-core/src/ports.ts";
import type { HandoffFactRecord } from "../../realtime-core/src/types.ts";

import {
  createRealtimeAuthorityRepository,
  FencingConflictError,
  IndeterminateOperationError,
  RealtimeAuthorityConflictError,
  type CanonicalAuthorityRef,
} from "../src/realtime-authority-repository.ts";
import { PostgresTxError } from "../src/transaction.ts";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACCEPTED_RESPONSE_HASH = createHash("sha256").update('{"accepted":true}', "utf8").digest("hex");
const HANDOFF_FINGERPRINT = '{"requestId":"handoff-request-1","idempotencyKey":"handoff-key-1"}';
const HANDOFF_REQUEST_HASH = createHash("sha256").update(HANDOFF_FINGERPRINT, "utf8").digest("hex");
const HANDOFF_DRIFT_FINGERPRINT = '{"requestId":"handoff-request-drift","idempotencyKey":"handoff-key-1"}';
const HANDOFF_DRIFT_REQUEST_HASH = createHash("sha256").update(HANDOFF_DRIFT_FINGERPRINT, "utf8").digest("hex");
const SESSION_ID = "11111111-1111-7111-8111-111111111111";
const LEASE_ID = "22222222-2222-7222-8222-222222222222";
const USER_ID = "33333333-3333-7333-8333-333333333333";
const DEVICE_ID = "44444444-4444-7444-8444-444444444444";
const CONTINUITY_ID = "55555555-5555-7555-8555-555555555555";
const FACT_ID = "66666666-6666-4666-8666-666666666666";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";
const NEW_LEASE_ID = "88888888-8888-7888-8888-888888888888";
const TO_DEVICE_ID = "99999999-9999-7999-8999-999999999999";

const sessionRef: CanonicalAuthorityRef = {
  refType: "RealtimeSession",
  refId: SESSION_ID,
  objectVersion: "1",
  canonicalPayloadSha256: HASH_A,
};
const leaseRef: CanonicalAuthorityRef = {
  refType: "DeviceLease",
  refId: LEASE_ID,
  objectVersion: "1",
  canonicalPayloadSha256: HASH_A,
};
const t11bSessionRef = Object.freeze({ ref_type: "RealtimeSession", ref_id: SESSION_ID, object_version: "1", canonical_payload_sha256: HASH_A });
const t11bLeaseRef = Object.freeze({ ref_type: "DeviceLease", ref_id: LEASE_ID, object_version: "1", canonical_payload_sha256: HASH_A });
const t11bNewLeaseRef = Object.freeze({ ref_type: "DeviceLease", ref_id: NEW_LEASE_ID, object_version: "1", canonical_payload_sha256: HASH_A });
const refreshRecord = {
  operation: "connected_credential_refresh" as const,
  idempotencyKey: "refresh-A",
  requestFingerprint: '{"requestId":"refresh-A"}',
  result: { accepted: true },
};

class FakeClient {
  readonly statements: string[] = [];
  readonly parameters: (readonly unknown[])[] = [];
  readonly sessionEpochs = new Map<string, string>();
  readonly leaseVersions = new Map<string, string>();
  ledger: any;
  terminalInserted = false;
  outboxInserted = false;
  handoffInserted = false;
  handoffRows: any[] = [];
  handoffRequestHashes: string[] = [];
  private transactionSnapshot: { inserted: boolean; rows: any[]; ledger: any; terminalInserted: boolean } | undefined;
  commitReplyLoss: "before" | "after" | undefined;
  bindingReadError: Error | undefined;
  bindingLeaseState: "active" | "released" = "active";
  currentBindingRows: any[] = [];
  currentBindingLockRows: { session_ref_id: string }[] | undefined;

  async query(sql: string, params: readonly unknown[] = []): Promise<any> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    this.parameters.push(params);
    if (normalized === "BEGIN") {
      this.transactionSnapshot = { inserted: this.handoffInserted, rows: this.handoffRows.slice(),
        ledger: structuredClone(this.ledger), terminalInserted: this.terminalInserted };
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "COMMIT") {
      const loss = this.commitReplyLoss;
      this.commitReplyLoss = undefined;
      if (loss !== "before") this.transactionSnapshot = undefined;
      if (loss !== undefined) throw Object.assign(new Error("lost COMMIT reply"), { code: "EPIPE" });
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      if (this.transactionSnapshot !== undefined) {
        this.handoffInserted = this.transactionSnapshot.inserted;
        this.handoffRows = this.transactionSnapshot.rows;
        this.ledger = this.transactionSnapshot.ledger;
        this.terminalInserted = this.transactionSnapshot.terminalInserted;
      }
      this.transactionSnapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT INTO idempotency_ledger")) {
      if (this.ledger !== undefined) return { rows: [], rowCount: 0 };
      if (normalized.includes("request_fingerprint")) {
        this.ledger = {
          scope: params[0], idempotency_key: params[1], request_hash: params[2], request_fingerprint: params[3],
          status: normalized.includes("'indeterminate'") ? "indeterminate" : "committed",
          response: JSON.parse(String(params[4])), response_hash: params[5],
        };
        return { rows: [this.ledger], rowCount: 1 };
      }
      this.ledger = {
        scope: params[0],
        idempotency_key: params[1],
        request_hash: params[2],
        status: "in_flight",
        response: null,
        response_hash: null,
        fencing_epoch: params[3],
      };
      return { rows: [this.ledger], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT scope, idempotency_key, request_hash")) {
      return this.ledger === undefined ? { rows: [], rowCount: 0 } : { rows: [this.ledger], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT request_hash, request_fingerprint") ||
        normalized.startsWith("SELECT request_fingerprint FROM idempotency_ledger")) {
      return this.ledger?.scope === params[0] && this.ledger?.idempotency_key === params[1]
        ? { rows: [this.ledger], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("UPDATE idempotency_ledger")) {
      this.ledger.status = "committed";
      this.ledger.response = JSON.parse(String(params[2]));
      this.ledger.response_hash = params[3];
      return { rows: [this.ledger], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT connection_epoch, realtime_session_ref")) {
      const value = this.sessionEpochs.get(String(params[0]));
      return value === undefined ? { rows: [], rowCount: 0 } : {
        rows: [{
          connection_epoch: value,
          realtime_session_ref: t11bSessionRef,
          session_object_version: "1",
          session_payload_sha256: HASH_A,
          continuity_id: CONTINUITY_ID,
          user_id: USER_ID,
          active_device_id: DEVICE_ID,
          active_device_lease_ref: t11bLeaseRef,
          state: "active",
          continuity_state: "active",
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("SELECT s.session_ref_id FROM realtime_sessions AS s")) {
      const rows = this.currentBindingLockRows ?? this.currentBindingRows.map(row => ({session_ref_id: row.s_session_ref_id}));
      return {rows, rowCount: rows.length};
    }
    if (normalized.startsWith("SELECT s.session_ref_id AS s_session_ref_id")) {
      if (this.bindingReadError !== undefined) throw this.bindingReadError;
      return { rows: this.currentBindingRows, rowCount: this.currentBindingRows.length };
    }
    if (normalized.startsWith("SELECT connection_epoch FROM realtime_sessions")) {
      const value = this.sessionEpochs.get(String(params[0]));
      return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ connection_epoch: value }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT session_ref_id, realtime_session_ref, session_object_version")) {
      return {
        rows: [{
          session_ref_id: SESSION_ID,
          realtime_session_ref: t11bSessionRef,
          session_object_version: "1",
          session_payload_sha256: HASH_A,
          continuity_ref: null,
          user_id: USER_ID,
          continuity_id: CONTINUITY_ID,
          state: "active",
          continuity_state: "active",
          connection_epoch: "1",
          continuity_expires_at: "2026-08-24T00:00:00.000Z",
          last_accepted_activity_at: "2026-08-23T00:00:00.000Z",
          active_device_id: DEVICE_ID,
          active_device_lease_ref: t11bLeaseRef,
          binding: {
            state: "connected",
            realtimeSessionRef: t11bSessionRef,
            deviceLeaseRef: t11bLeaseRef,
            continuityId: CONTINUITY_ID,
            deviceId: DEVICE_ID,
            connectionEpoch: "1",
            provider: "livekit",
            transportSessionAlias: "transport",
            roomAlias: "room",
            deviceAlias: "device",
            connectionId: "connection",
          },
          revision: "1",
          updated_at: "2026-08-23T00:00:00.000Z",
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("SELECT lease_ref_id, device_lease_ref, lease_object_version")) {
      return {
        rows: [{
          lease_ref_id: LEASE_ID,
          device_lease_ref: t11bLeaseRef,
          lease_object_version: "1",
          lease_payload_sha256: HASH_A,
          realtime_session_ref: t11bSessionRef,
          continuity_ref: null,
          session_ref_id: SESSION_ID,
          continuity_id: CONTINUITY_ID,
          user_id: USER_ID,
          device_id: DEVICE_ID,
          state: "active",
          capabilities: ["audio"],
          purpose: "realtime",
          issued_at: "2026-08-23T00:00:00.000Z",
          expires_at: "2026-08-24T00:00:00.000Z",
          revocable: true,
          lease_version: "1",
          fencing_token: "1",
          policy_decision_ref: { policy: "unit" },
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("SELECT session_ref_id, user_id, device_id, continuity_id, state, device_lease_ref")) {
      return {
        rows: [{
          session_ref_id: SESSION_ID,
          user_id: USER_ID,
          device_id: DEVICE_ID,
          continuity_id: CONTINUITY_ID,
          state: this.bindingLeaseState,
          device_lease_ref: t11bLeaseRef,
          lease_object_version: "1",
          lease_payload_sha256: HASH_A,
          realtime_session_ref: t11bSessionRef,
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("INSERT INTO realtime_sessions")) {
      this.sessionEpochs.set(String(params[0]), String(params[6]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE realtime_sessions")) {
      this.sessionEpochs.set(String(params[0]), String(params[6]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT lease_version FROM device_leases")) {
      const value = this.leaseVersions.get(String(params[0]));
      return value === undefined ? { rows: [], rowCount: 0 } : { rows: [{ lease_version: value }], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO device_leases")) {
      this.leaseVersions.set(String(params[0]), String(params[7]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE device_leases")) {
      this.leaseVersions.set(String(params[0]), String(params[7]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO realtime_transport_aliases")) {
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO realtime_terminal_facts")) {
      if (this.terminalInserted) return { rows: [], rowCount: 0 };
      this.terminalInserted = true;
      return { rows: [{ terminal_fact_id: params[0] }], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO realtime_handoff_facts")) {
      this.handoffRequestHashes.push(String(params[10]));
      if (this.handoffInserted) return { rows: [], rowCount: 0 };
      this.handoffInserted = true;
      this.handoffRows.push({
        handoff_ref_id: params[0],
        session_ref_id: params[1],
        continuity_id: params[2],
        from_device_id: params[3],
        to_device_id: params[4],
        expected_lease_version: params[5],
        resulting_lease_version: params[6],
        connection_epoch: params[7],
        request_scope: params[8],
        idempotency_key: params[9],
        request_hash: params[10],
        outcome: JSON.parse(String(params[11])),
        occurred_at: params[12],
      });
      return { rows: [{ handoff_ref_id: params[0] }], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT handoff_ref_id, session_ref_id, continuity_id")) {
      return this.handoffRows.length === 0 ? { rows: [], rowCount: 0 } : { rows: [this.handoffRows[0]], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT terminal_fact_id")) {
      return {
        rows: [{
          terminal_fact_id: FACT_ID,
          operation: "media_stop",
          status: "success",
          request_scope: "unit",
          idempotency_key: "request-1",
          request_hash: HASH_A,
          session_ref_id: SESSION_ID,
          lease_ref_id: LEASE_ID,
          continuity_id: CONTINUITY_ID,
          connection_epoch: "1",
          operation_outcome: { class: "committed" },
          execution_facts: { closure: "verified_closed" },
          created_at: "2026-08-23T00:00:00.000Z",
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith("INSERT INTO outbox_events")) {
      if (this.outboxInserted) return { rows: [], rowCount: 0 };
      this.outboxInserted = true;
      return {
        rows: [{
          event_id: EVENT_ID,
          aggregate_type: "RealtimeSession",
          aggregate_id: SESSION_ID,
          event_type: "realtime.session.changed",
          event_version: 1,
          idempotency_scope: "unit",
          idempotency_key: "request-1",
          payload: { state: "active" },
          payload_sha256: HASH_A,
          status: "pending",
          attempt_count: 0,
          claimed_by: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

function poolFor(client: FakeClient): any {
  return { connect: async () => client };
}

const sessionInput = {
  sessionRef,
  userId: USER_ID,
  continuityId: CONTINUITY_ID,
  state: "active" as const,
  connectionEpoch: "1",
  continuityExpiresAt: "2026-08-24T00:00:00.000Z",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

const leaseInput = {
  leaseRef,
  sessionRefId: SESSION_ID,
  userId: USER_ID,
  deviceId: DEVICE_ID,
  continuityId: CONTINUITY_ID,
  leaseVersion: "1",
  state: "active" as const,
  capabilityScope: { media: ["audio"] },
  purposeScope: { purpose: "realtime" },
  policyBinding: { policy: "unit" },
  acquiredAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-23T01:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

function currentBindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    s_session_ref_id: SESSION_ID,
    s_realtime_session_ref: t11bSessionRef,
    s_session_object_version: "1",
    s_session_payload_sha256: HASH_A,
    s_continuity_ref: null,
    s_user_id: USER_ID,
    s_continuity_id: CONTINUITY_ID,
    s_state: "active",
    s_continuity_state: "active",
    s_connection_epoch: "1",
    s_continuity_expires_at: "2026-08-24T00:00:00.000Z",
    s_last_accepted_activity_at: "2026-08-23T00:00:00.000Z",
    s_active_device_id: DEVICE_ID,
    s_active_device_lease_ref: t11bLeaseRef,
    s_binding: {
      state: "connected",
      realtimeSessionRef: t11bSessionRef,
      deviceLeaseRef: t11bLeaseRef,
      continuityId: CONTINUITY_ID,
      deviceId: DEVICE_ID,
      connectionEpoch: "1",
      provider: "livekit",
      transportSessionAlias: "transport",
      roomAlias: "room",
      deviceAlias: "device",
      connectionId: "connection",
    },
    s_revision: "1",
    s_updated_at: "2026-08-23T00:00:00.000Z",
    l_lease_ref_id: LEASE_ID,
    l_device_lease_ref: t11bLeaseRef,
    l_lease_object_version: "1",
    l_lease_payload_sha256: HASH_A,
    l_realtime_session_ref: t11bSessionRef,
    l_continuity_ref: null,
    l_session_ref_id: SESSION_ID,
    l_continuity_id: CONTINUITY_ID,
    l_user_id: USER_ID,
    l_device_id: DEVICE_ID,
    l_state: "active",
    l_capabilities: ["audio"],
    l_purpose: "realtime",
    l_issued_at: "2026-08-23T00:00:00.000Z",
    l_expires_at: "2026-08-24T00:00:00.000Z",
    l_revocable: true,
    l_lease_version: "1",
    l_fencing_token: "1",
    l_policy_decision_ref: { policy: "unit" },
    ...overrides,
  };
}

const handoffRecord: HandoffFactRecord = Object.freeze({
  requestId: "handoff-request-1",
  idempotencyKey: "handoff-key-1",
  requestFingerprint: HANDOFF_FINGERPRINT,
  realtimeSessionRef: t11bSessionRef,
  continuityId: CONTINUITY_ID,
  fromDeviceId: DEVICE_ID,
  toDeviceId: TO_DEVICE_ID,
  connectionEpoch: "9007199254740998" as HandoffFactRecord["connectionEpoch"],
  oldLeaseRef: t11bLeaseRef,
  expectedLeaseVersion: "9007199254740993" as HandoffFactRecord["expectedLeaseVersion"],
  releasedLeaseVersion: "9007199254740994" as HandoffFactRecord["releasedLeaseVersion"],
  releasedFencingToken: "9007199254740995" as HandoffFactRecord["releasedFencingToken"],
  newLeaseRef: t11bNewLeaseRef,
  newLeaseVersion: "9007199254740996" as HandoffFactRecord["newLeaseVersion"],
  newFencingToken: "9007199254740997" as HandoffFactRecord["newFencingToken"],
  suppressedDeviceId: DEVICE_ID,
  outboxEventRef: Object.freeze({ event_id: EVENT_ID }),
  occurredAt: "2026-08-23T00:03:00.000Z" as HandoffFactRecord["occurredAt"],
});

test("realtime repository persists session and lease with row-lock reads and decimal epochs", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  await repository.persistSession(client as any, sessionInput);
  await repository.persistDeviceLease(client as any, leaseInput);
  assert.ok(client.statements.some((statement) => statement.includes("FOR UPDATE")));
  assert.equal(client.sessionEpochs.get(SESSION_ID), "1");
  assert.equal(client.leaseVersions.get(LEASE_ID), "1");
});

test("realtime repository rejects stale epoch or lease version before mutation", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  await repository.persistSession(client as any, sessionInput);
  await assert.rejects(
    () => repository.persistSession(client as any, {
      ...sessionInput,
      connectionEpoch: "2",
      expectedConnectionEpoch: "9",
    }),
    FencingConflictError,
  );
  await repository.persistDeviceLease(client as any, leaseInput);
  await assert.rejects(
    () => repository.persistDeviceLease(client as any, {
      ...leaseInput,
      leaseVersion: "2",
      expectedLeaseVersion: "9",
    }),
    FencingConflictError,
  );
});

test("one atomic operation commits ledger, terminal fact, and outbox together", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  const result = await repository.runAtomic(
    { scope: "unit", idempotencyKey: "request-1", requestHash: HASH_A, fencingEpoch: "1" },
    async () => ({
      response: { accepted: true },
      responseHash: ACCEPTED_RESPONSE_HASH,
      terminalFact: {
        terminalFactId: FACT_ID,
        operation: "media_stop" as const,
        status: "success" as const,
        requestScope: "unit",
        idempotencyKey: "request-1",
        requestHash: HASH_A,
        sessionRefId: SESSION_ID,
        leaseRefId: LEASE_ID,
        continuityId: CONTINUITY_ID,
        connectionEpoch: "1",
        operationOutcome: { class: "committed" },
        executionFacts: { closure: "verified_closed" },
        createdAt: "2026-08-23T00:00:00.000Z",
      },
      outboxEvents: [{
        eventId: EVENT_ID,
        aggregateType: "RealtimeSession",
        aggregateId: SESSION_ID,
        eventType: "realtime.session.changed",
        eventVersion: 1,
        idempotencyScope: "unit",
        idempotencyKey: "request-1",
        payload: { state: "active" },
        payloadHash: HASH_A,
      }],
    }),
  );
  assert.equal(result.kind, "committed");
  assert.equal(client.terminalInserted, true);
  assert.equal(client.outboxInserted, true);
  assert.equal(client.ledger.status, "committed");
});

test("T11B production repository port is directly constructible from the T02 adapter", () => {
  const repository: T11BRealtimeAuthorityRepository = createRealtimeAuthorityRepository(poolFor(new FakeClient()));
  assert.equal(typeof repository.transaction, "function");
});

for (const committed of [false, true]) {
  test(`T11B read-only uncertain COMMIT cannot mark a ${committed ? "committed" : "rolled-back"} refresh on a reused client`, async () => {
    const client = new FakeClient();
    client.currentBindingRows = [currentBindingRow()];
    const repository = createRealtimeAuthorityRepository(poolFor(client));
    const failure = Object.assign(new Error("binding SQL failure"), { code: "40001" });
    const refresh = () => repository.transaction("realtime.refresh", async (tx) => {
      assert.equal(await tx.readIdempotency(refreshRecord.operation, refreshRecord.idempotencyKey), undefined);
      await tx.readCurrentBinding({ realtimeSessionRef: t11bSessionRef });
      await tx.writeIdempotency(refreshRecord);
    });
    if (committed) await refresh();
    else {
      client.bindingReadError = failure;
      await assert.rejects(refresh, (error) => error === failure);
      client.bindingReadError = undefined;
    }
    client.commitReplyLoss = "after";
    await assert.rejects(() => repository.transaction("realtime.current_binding.read", async (tx) => {
      const binding = await tx.readCurrentBinding({ realtimeSessionRef: t11bSessionRef });
      assert.deepEqual(binding?.session.realtimeSessionRef, t11bSessionRef);
    }), PostgresTxError);
    if (!committed) await refresh();
    assert.equal(client.statements.some((sql) => sql.includes("'indeterminate'")), false,
      "read-only transaction must not write an indeterminate receipt");
    assert.deepEqual(await repository.transaction("realtime.refresh", (tx) =>
      tx.readIdempotency(refreshRecord.operation, refreshRecord.idempotencyKey)), refreshRecord);
  });
}

for (const loss of ["before", "after"] as const) {
  test(`T11B uncertain refresh COMMIT ${loss} applying writes preserves the correct retry outcome`, async () => {
    const client = new FakeClient();
    client.commitReplyLoss = loss;
    const repository = createRealtimeAuthorityRepository(poolFor(client));
    await assert.rejects(() => repository.transaction("realtime.refresh", async (tx) => {
      await tx.readIdempotency(refreshRecord.operation, refreshRecord.idempotencyKey);
      await tx.writeIdempotency(refreshRecord);
    }), PostgresTxError);
    const replay = () => repository.transaction("realtime.refresh", (tx) =>
      tx.readIdempotency(refreshRecord.operation, refreshRecord.idempotencyKey));
    if (loss === "before") await assert.rejects(replay, IndeterminateOperationError);
    else assert.deepEqual(await replay(), refreshRecord);
  });
}

test("T11B handoff fact seam forwards, maps the complete frozen record, replays exactly, and rejects drift", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  const recordHandoffFact = async (record: HandoffFactRecord): Promise<void> => {
    await repository.transaction("unit.handoff", async (transaction) => {
      const method = transaction.recordHandoffFact;
      if (method === undefined) throw new Error("HANDOFF_FACT_RECORD_UNSUPPORTED");
      await method(record);
    });
  };

  await recordHandoffFact(handoffRecord);
  assert.equal(client.handoffRows.length, 1);
  const row = client.handoffRows[0]!;
  assert.match(String(row.handoff_ref_id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.notEqual(row.handoff_ref_id, SESSION_ID);
  assert.equal(row.session_ref_id, SESSION_ID);
  assert.equal(row.continuity_id, CONTINUITY_ID);
  assert.equal(row.from_device_id, DEVICE_ID);
  assert.equal(row.to_device_id, TO_DEVICE_ID);
  assert.equal(row.expected_lease_version, "9007199254740993");
  assert.equal(row.resulting_lease_version, "9007199254740996");
  assert.equal(row.connection_epoch, "9007199254740998");
  assert.equal(row.request_scope, "realtime.handoff");
  assert.equal(row.idempotency_key, handoffRecord.idempotencyKey);
  assert.equal(row.request_hash, HANDOFF_REQUEST_HASH);
  assert.deepEqual(row.outcome, handoffRecord);
  assert.equal(row.occurred_at, handoffRecord.occurredAt);
  assert.equal(client.handoffRequestHashes[0], HANDOFF_REQUEST_HASH);

  await recordHandoffFact(handoffRecord);
  assert.equal(client.handoffRows.length, 1);
  assert.equal(client.handoffRequestHashes[1], HANDOFF_REQUEST_HASH);
  assert.notEqual(HANDOFF_DRIFT_REQUEST_HASH, HANDOFF_REQUEST_HASH);
  await assert.rejects(
    () => recordHandoffFact({ ...handoffRecord, requestFingerprint: HANDOFF_DRIFT_FINGERPRINT }),
    RealtimeAuthorityConflictError,
  );
  assert.equal(client.handoffRequestHashes[2], HANDOFF_DRIFT_REQUEST_HASH);
  assert.equal(client.handoffRows.length, 1);
  await assert.rejects(
    () => recordHandoffFact({ ...handoffRecord, requestFingerprint: "   " }),
    /invalid T11B handoff fact fields/,
  );
  assert.equal(client.handoffRows.length, 1);
});

test("T11B handoff fact persistence rolls back with the managed transaction", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  await assert.rejects(
    () => repository.transaction("unit.handoff.rollback", async (transaction) => {
      const method = transaction.recordHandoffFact;
      if (method === undefined) throw new Error("HANDOFF_FACT_RECORD_UNSUPPORTED");
      await method(handoffRecord);
      throw new Error("force rollback after handoff fact");
    }),
    /force rollback after handoff fact/,
  );
  assert.equal(client.handoffRows.length, 0);
  assert.equal(client.handoffInserted, false);
});

test("T11B reads reject same-ID requested ref version or hash drift", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  const byContinuity = await repository.transaction("unit.read.session.continuity", (transaction) => transaction.readSessionByContinuityId(CONTINUITY_ID));
  assert.ok(byContinuity);
  assert.deepEqual(byContinuity.realtimeSessionRef, t11bSessionRef);
  await assert.rejects(
    () => repository.transaction("unit.read.session.version-drift", (transaction) => transaction.readSession({
      ...t11bSessionRef,
      object_version: "2",
    } as any)),
    RealtimeAuthorityConflictError,
  );
  await assert.rejects(
    () => repository.transaction("unit.read.session.hash-drift", (transaction) => transaction.readSession({
      ...t11bSessionRef,
      canonical_payload_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    } as any)),
    RealtimeAuthorityConflictError,
  );
  await assert.rejects(
    () => repository.transaction("unit.read.lease.version-drift", (transaction) => transaction.readLease({
      ...t11bLeaseRef,
      object_version: "2",
    } as any)),
    RealtimeAuthorityConflictError,
  );
  await assert.rejects(
    () => repository.transaction("unit.read.lease.hash-drift", (transaction) => transaction.readLease({
      ...t11bLeaseRef,
      canonical_payload_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    } as any)),
    RealtimeAuthorityConflictError,
  );
});

test("T11B current-binding read returns one session plus its exact active lease from one SQL snapshot", async () => {
  const client = new FakeClient();
  client.currentBindingRows = [currentBindingRow()];
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  const projection = await repository.transaction("realtime.current_binding.read", (transaction) =>
    transaction.readCurrentBinding({ realtimeSessionRef: t11bSessionRef }));
  assert.ok(projection);
  assert.deepEqual(projection.session.realtimeSessionRef, t11bSessionRef);
  assert.deepEqual(projection.session.activeDeviceLeaseRef, t11bLeaseRef);
  assert.deepEqual(projection.lease.deviceLeaseRef, t11bLeaseRef);
  assert.deepEqual(projection.lease.realtimeSessionRef, t11bSessionRef);
  assert.equal(projection.session.binding.state, "connected");
  assert.equal(projection.lease.state, "active");
  const statement = client.statements.find((value) => value.startsWith("SELECT s.session_ref_id AS s_session_ref_id"));
  assert.ok(statement);
  assert.match(statement, /FOR UPDATE OF s$/u);
  assert.doesNotMatch(statement, /ORDER BY|LIMIT\s+1/iu);
  await assert.rejects(
    () => repository.transaction("realtime.current_binding.ref-drift", (transaction) =>
      transaction.readCurrentBinding({
        realtimeSessionRef: { ...t11bSessionRef, object_version: "2" },
      } as any)),
    RealtimeAuthorityConflictError,
  );
  client.currentBindingRows = [];
  assert.equal(await repository.transaction("realtime.current_binding.not-found", (transaction) =>
    transaction.readCurrentBinding({ realtimeSessionRef: t11bSessionRef })), undefined);
  // A session appearing after the empty lock lookup must not be selected without its own lock.
  client.currentBindingRows = [currentBindingRow()];client.currentBindingLockRows = [];
  const joins = client.statements.filter(sql => sql.startsWith("SELECT s.session_ref_id AS s_session_ref_id")).length;
  assert.equal(await repository.transaction("realtime.current_binding.empty-lock", transaction =>
    transaction.readCurrentBinding({ realtimeSessionRef: t11bSessionRef })), undefined);
  assert.equal(client.statements.filter(sql => sql.startsWith("SELECT s.session_ref_id AS s_session_ref_id")).length, joins);
});

test("T11B continuity-only current-binding read is database-current and fails on multiplicity or contradictions", async () => {
  const client = new FakeClient();
  client.currentBindingRows = [currentBindingRow()];
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  const byContinuity = await repository.transaction("realtime.current_binding.continuity", (transaction) =>
    transaction.readCurrentBinding({ continuityId: CONTINUITY_ID }));
  assert.ok(byContinuity);
  const lock = client.statements.findIndex(sql => sql.startsWith("SELECT s.session_ref_id FROM realtime_sessions AS s"));
  assert.match(client.statements[lock]!, /WHERE s.continuity_id = \$1 AND s.state = 'active' AND s.continuity_state = 'active' FOR UPDATE$/u);
  assert.deepEqual(client.parameters[lock], [CONTINUITY_ID]);
  const join = client.statements.findIndex(sql => sql.startsWith("SELECT s.session_ref_id AS s_session_ref_id"));
  assert.match(client.statements[join]!, /WHERE s.session_ref_id = \$1 FOR UPDATE OF s$/u);
  assert.deepEqual(client.parameters[join], [SESSION_ID]);

  client.currentBindingRows = [currentBindingRow(), currentBindingRow({ s_session_ref_id: "11111111-1111-7111-8111-111111111112" })];
  await assert.rejects(
    () => repository.transaction("realtime.current_binding.multiple", (transaction) =>
      transaction.readCurrentBinding({ continuityId: CONTINUITY_ID })),
    RealtimeAuthorityConflictError,
  );

  assert.equal(client.statements.filter(sql => sql.startsWith("SELECT s.session_ref_id AS s_session_ref_id")).length, 1,
    "an ambiguous lock lookup rejects before reading any joined projection");

  client.currentBindingRows = [currentBindingRow({
    s_binding: {
      ...currentBindingRow().s_binding as Record<string, unknown>,
      connectionEpoch: "2",
    },
  })];
  await assert.rejects(
    () => repository.transaction("realtime.current_binding.epoch-conflict", (transaction) =>
      transaction.readCurrentBinding({ realtimeSessionRef: t11bSessionRef })),
    RealtimeAuthorityConflictError,
  );
});

test("T11B connected binding rejects a released lease", async () => {
  const client = new FakeClient();
  client.sessionEpochs.set(SESSION_ID, "1");
  client.bindingLeaseState = "released";
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  await assert.rejects(
    () => repository.transaction("unit.binding.released-lease", (transaction) => transaction.writeBinding({
      expectedConnectionEpoch: "1",
      binding: {
        state: "connected",
        realtimeSessionRef: t11bSessionRef,
        deviceLeaseRef: t11bLeaseRef,
        continuityId: CONTINUITY_ID,
        deviceId: DEVICE_ID,
        connectionEpoch: "1" as any,
        provider: "livekit",
        transportSessionAlias: "transport",
        roomAlias: "room",
        deviceAlias: "device",
        connectionId: "connection",
      },
    })),
    RealtimeAuthorityConflictError,
  );
});

test("T11B adapter fails closed for zero or stale connection epochs", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  await assert.rejects(
    () => repository.persistSession(client as any, { ...sessionInput, connectionEpoch: "0" }),
    /invalid decimal epoch/,
  );
  client.sessionEpochs.set(SESSION_ID, "2");
  await assert.rejects(
    () => repository.transaction("unit.binding", async (transaction) => transaction.writeBinding({
      expectedConnectionEpoch: "2",
      binding: {
        state: "connected",
        realtimeSessionRef: t11bSessionRef,
        deviceLeaseRef: t11bLeaseRef,
        continuityId: CONTINUITY_ID,
        deviceId: DEVICE_ID,
        connectionEpoch: "1" as any,
        provider: "livekit",
        transportSessionAlias: "transport",
        roomAlias: "room",
        deviceAlias: "device",
        connectionId: "connection",
      },
    })),
    /FENCING_CONFLICT/,
  );
  await assert.rejects(
    () => repository.transaction("unit.binding.wrong-version", async (transaction) => transaction.writeBinding({
      expectedConnectionEpoch: "2",
      binding: {
        state: "connected",
        realtimeSessionRef: { ...t11bSessionRef, object_version: "2" } as any,
        deviceLeaseRef: t11bLeaseRef,
        continuityId: CONTINUITY_ID,
        deviceId: DEVICE_ID,
        connectionEpoch: "1" as any,
        provider: "livekit",
        transportSessionAlias: "transport",
        roomAlias: "room",
        deviceAlias: "device",
        connectionId: "connection",
      },
    })),
    /REALTIME_AUTHORITY_CONFLICT/,
  );
  await assert.rejects(
    () => repository.transaction("unit.binding.wrong-hash", async (transaction) => transaction.writeBinding({
      expectedConnectionEpoch: "2",
      binding: {
        state: "connected",
        realtimeSessionRef: { ...t11bSessionRef, canonical_payload_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } as any,
        deviceLeaseRef: t11bLeaseRef,
        continuityId: CONTINUITY_ID,
        deviceId: DEVICE_ID,
        connectionEpoch: "1" as any,
        provider: "livekit",
        transportSessionAlias: "transport",
        roomAlias: "room",
        deviceAlias: "device",
        connectionId: "connection",
      },
    })),
    /REALTIME_AUTHORITY_CONFLICT/,
  );
});

test("canonical identity accepts UUIDv7 and rejects an internal UUIDv4 wire ref", async () => {
  const client = new FakeClient();
  const repository = createRealtimeAuthorityRepository(poolFor(client));
  await repository.persistSession(client as any, sessionInput);
  await assert.rejects(
    () => repository.persistSession(client as any, {
      ...sessionInput,
      sessionRef: { ...sessionRef, refId: "11111111-1111-4111-8111-111111111111" },
    }),
    /canonical UUIDv7/,
  );
});
