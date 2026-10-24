import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DatabaseError } from "pg";

import {
  claimIdempotency,
  completeIdempotency,
  IdempotencyConflictError,
} from "../src/idempotency-ledger.ts";
import {
  claimOutboxBatch,
  consumeOutboxOnce,
  enqueueOutboxEvent,
  markOutboxPublished,
  OutboxConflictError,
} from "../src/transactional-outbox.ts";
import { PostgresTxError, withTransaction } from "../src/transaction.ts";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACCEPTED_RESPONSE_HASH = createHash("sha256").update('{"accepted":true}', "utf8").digest("hex");
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const AGGREGATE_ID = "22222222-2222-7222-8222-222222222222";

function ledgerRow(hash = HASH_A, status = "committed", response: unknown = { ok: true }) {
  return {
    scope: "unit",
    idempotency_key: "request-1",
    request_hash: hash,
    status,
    response,
    response_hash: HASH_A,
    fencing_epoch: "3",
  };
}

class FakeClient {
  readonly statements: string[] = [];
  ledger: Record<string, unknown> | undefined;
  event: Record<string, unknown> | undefined;
  dedupe = false;
  transactionActive = false;
  dedupePending = false;
  commitError: unknown;
  rollbackError: unknown;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    if (normalized === "BEGIN") { this.transactionActive = true; return { rows: [], rowCount: 0 }; }
    if (normalized === "COMMIT") {
      this.transactionActive = false;
      if (this.commitError !== undefined) throw this.commitError;
      this.dedupe = this.dedupe || this.dedupePending;
      this.dedupePending = false;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      this.transactionActive = false;
      if (this.rollbackError !== undefined) throw this.rollbackError;
      this.dedupePending = false;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT INTO idempotency_ledger")) {
      if (this.ledger !== undefined) return { rows: [], rowCount: 0 };
      this.ledger = ledgerRow(String(params[2]), "in_flight", null);
      this.ledger.response_hash = null;
      this.ledger.fencing_epoch = params[3] ?? null;
      this.ledger.status = "in_flight";
      return { rows: [this.ledger], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT scope, idempotency_key, request_hash")) {
      return this.ledger === undefined ? { rows: [], rowCount: 0 } : { rows: [this.ledger], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE idempotency_ledger")) {
      assert.ok(this.ledger);
      this.ledger.status = normalized.includes("'indeterminate'") ? "indeterminate" : "committed";
      this.ledger.response = JSON.parse(String(params[2]));
      this.ledger.response_hash = params[3];
      return { rows: [this.ledger], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO outbox_events")) {
      if (this.event !== undefined) return { rows: [], rowCount: 0 };
      this.event = {
        event_id: params[0],
        aggregate_type: params[1],
        aggregate_id: params[2],
        event_type: params[3],
        event_version: params[4],
        idempotency_scope: params[5],
        idempotency_key: params[6],
        payload: JSON.parse(String(params[7])),
        payload_sha256: params[8],
        status: "pending",
        attempt_count: 0,
        claimed_by: null,
      };
      return { rows: [this.event], rowCount: 1 };
    }
    if (normalized.includes("FROM outbox_events WHERE idempotency_scope")) {
      return this.event === undefined ? { rows: [], rowCount: 0 } : { rows: [this.event], rowCount: 1 };
    }
    if (normalized.startsWith("WITH candidates AS")) {
      if (this.event === undefined) return { rows: [], rowCount: 0 };
      this.event.status = "claimed";
      this.event.claimed_by = params[0];
      this.event.attempt_count = 1;
      return { rows: [this.event], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO outbox_consumer_dedupe")) {
      if (this.dedupe || this.dedupePending) return { rows: [], rowCount: 0 };
      this.dedupePending = true;
      return { rows: [{ consumer_name: params[0] }], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE outbox_events")) {
      assert.ok(this.event);
      this.event.status = "published";
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

function clientAsPoolClient(client: FakeClient): any {
  return client;
}

const input = { scope: "unit", idempotencyKey: "request-1", requestHash: HASH_A, fencingEpoch: "3" };
const eventInput = {
  eventId: EVENT_ID,
  aggregateType: "RealtimeSession",
  aggregateId: AGGREGATE_ID,
  eventType: "realtime.session.changed",
  eventVersion: 1,
  idempotencyScope: "unit",
  idempotencyKey: "request-1",
  payload: { state: "active" },
  payloadHash: HASH_A,
};

test("idempotency ledger claims once, commits, and replays the exact response", async () => {
  const fake = new FakeClient();
  const first = await claimIdempotency(clientAsPoolClient(fake), input);
  assert.equal(first.kind, "new");
  const committed = await completeIdempotency(clientAsPoolClient(fake), input, { accepted: true }, ACCEPTED_RESPONSE_HASH);
  assert.equal(committed.status, "committed");
  const replay = await claimIdempotency(clientAsPoolClient(fake), input);
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.record.response, { accepted: true });
});

test("idempotency ledger rejects a different request hash for the same key", async () => {
  const fake = new FakeClient();
  await claimIdempotency(clientAsPoolClient(fake), input);
  await assert.rejects(
    () => claimIdempotency(clientAsPoolClient(fake), { ...input, requestHash: HASH_B }),
    IdempotencyConflictError,
  );
});

test("outbox enqueue is idempotent and claims with the required lock hint", async () => {
  const fake = new FakeClient();
  const first = await enqueueOutboxEvent(clientAsPoolClient(fake), eventInput);
  const replay = await enqueueOutboxEvent(clientAsPoolClient(fake), eventInput);
  assert.equal(first.kind, "queued");
  assert.equal(replay.kind, "replayed");
  const claimed = await claimOutboxBatch(clientAsPoolClient(fake), "unit-consumer", 10);
  assert.equal(claimed.length, 1);
  assert.ok(fake.statements.some((statement) => statement.includes("FOR UPDATE SKIP LOCKED")));
  assert.equal(await markOutboxPublished(clientAsPoolClient(fake), EVENT_ID, "unit-consumer"), true);
});

test("outbox replay rejects aggregate or payload drift", async () => {
  const fake = new FakeClient();
  await enqueueOutboxEvent(clientAsPoolClient(fake), eventInput);
  await assert.rejects(
    () => enqueueOutboxEvent(clientAsPoolClient(fake), { ...eventInput, aggregateId: "33333333-3333-7333-8333-333333333333" }),
    OutboxConflictError,
  );
  await assert.rejects(
    () => enqueueOutboxEvent(clientAsPoolClient(fake), { ...eventInput, payload: { state: "terminal" } }),
    OutboxConflictError,
  );
});

test("consumer dedupe runs the handler once", async () => {
  const fake = new FakeClient();
  await enqueueOutboxEvent(clientAsPoolClient(fake), eventInput);
  const claimed = await claimOutboxBatch(clientAsPoolClient(fake), "unit-consumer", 10);
  let calls = 0;
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  assert.equal(await withTransaction(pool, (client) => consumeOutboxOnce(client, "unit-consumer", claimed[0]!, async () => { calls += 1; })), true);
  assert.equal(await withTransaction(pool, (client) => consumeOutboxOnce(client, "unit-consumer", claimed[0]!, async () => { calls += 1; })), false);
  assert.equal(calls, 1);
});

test("consumer handler failure rolls back dedupe and permits a controlled retry", async () => {
  const fake = new FakeClient();
  await enqueueOutboxEvent(clientAsPoolClient(fake), eventInput);
  const claimed = await claimOutboxBatch(clientAsPoolClient(fake), "unit-consumer", 10);
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  await assert.rejects(() => withTransaction(pool, (client) => consumeOutboxOnce(client, "unit-consumer", claimed[0]!, async () => { throw new Error("handler failure"); })));
  assert.equal(await withTransaction(pool, (client) => consumeOutboxOnce(client, "unit-consumer", claimed[0]!, async () => undefined)), true);
});

test("transaction helper commits and releases one client", async () => {
  const fake = new FakeClient();
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  const result = await withTransaction(pool, async (client) => {
    await client.query("SELECT 1");
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(fake.statements.slice(0, 2), ["BEGIN", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"]);
  assert.ok(fake.statements.includes("COMMIT"));
});

test("transaction helper rolls back on work failure", async () => {
  const fake = new FakeClient();
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  await assert.rejects(() => withTransaction(pool, async () => { throw new Error("unit failure"); }));
  assert.ok(fake.statements.includes("ROLLBACK"));
  assert.equal(fake.statements.includes("COMMIT"), false);
});

test("known SQLSTATE commit failure is deterministic and not indeterminate", async () => {
  const fake = new FakeClient();
  const knownFailure = Object.assign(new DatabaseError("serialization failure", 0, "error"), { code: "40001", severity: "ERROR" });
  fake.commitError = knownFailure;
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  await assert.rejects(
    () => withTransaction(pool, async () => "not committed"),
    (error: unknown) => error === knownFailure && !(error instanceof PostgresTxError),
  );
});

test("connection loss after COMMIT is the only uncertain commit boundary", async () => {
  const fake = new FakeClient();
  fake.commitError = Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  await assert.rejects(
    () => withTransaction(pool, async () => "unknown"),
    (error: unknown) => error instanceof PostgresTxError && error.phase === "commit" && error.outcomeUncertain,
  );
});

test("rollback failure after deterministic work failure does not become indeterminate", async () => {
  const fake = new FakeClient();
  fake.rollbackError = Object.assign(new Error("rollback connection lost"), { code: "ECONNRESET" });
  const workFailure = new Error("deterministic business rejection");
  const pool = { connect: async () => clientAsPoolClient(fake) } as any;
  await assert.rejects(
    () => withTransaction(pool, async () => { throw workFailure; }),
    (error: unknown) => error === workFailure && !(error instanceof PostgresTxError),
  );
});
