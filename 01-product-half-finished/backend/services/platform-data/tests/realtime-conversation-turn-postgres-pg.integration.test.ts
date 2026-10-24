import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { closePostgresPool, createPostgresPool } from "../src/postgres-pool.ts";
import {
  conversationTurnIdempotencyPayloadSha256,
  createRealtimeConversationTurnPostgres,
  type RealtimeConversationTurnBinding,
  type RealtimeConversationTurnClaimInput,
} from "../src/realtime-conversation-turn-postgres.ts";

const RUN = process.env.PAIOS_RUN_DURABLE_TURN_PG === "1";

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

test("durable conversation turn commits and replays only on an explicitly supplied disposable PG18 binding", { skip: !RUN }, async () => {
  const port = Number(required("PAIOS_PG_PORT"));
  if (!Number.isSafeInteger(port) || port < 1024 || port === 5432 || port === 55432) {
    throw new Error("disposable PG port required");
  }
  const binding = JSON.parse(required("PAIOS_DURABLE_TURN_BINDING_JSON")) as RealtimeConversationTurnBinding;
  const inputWithoutHash = {
    binding,
    inputKind: "typed" as const,
    inputId: "durable-turn-pg-input-0001",
    userText: "隔离数据库持久化测试",
    userTextSha256: createHash("sha256").update("隔离数据库持久化测试").digest("hex"),
  };
  const claim: RealtimeConversationTurnClaimInput = {
    ...inputWithoutHash,
    idempotencyKey: "durable-turn-pg-input-0001",
    idempotencyPayloadSha256: conversationTurnIdempotencyPayloadSha256(inputWithoutHash),
  };
  const pool = createPostgresPool({
    host: required("PAIOS_PG_HOST"), port, database: required("PAIOS_PG_DATABASE"),
    user: required("PAIOS_PG_USER"), password: required("PAIOS_PG_PASSWORD"), max: 1,
    applicationName: "paios-durable-turn-pg-integration",
  });
  try {
    const adapter = createRealtimeConversationTurnPostgres(pool);
    assert.equal((await adapter.beginClaim(claim)).kind, "claimed");
    const receipt = await adapter.commitCompletedAfterPublish({
      claim,
      assistantText: "隔离数据库回复",
      assistantTextSha256: createHash("sha256").update("隔离数据库回复").digest("hex"),
      publishObservation: { state: "confirmed", observedAt: new Date().toISOString() },
    });
    assert.equal(receipt.delivery_state, "completed");
    assert.equal((await adapter.beginClaim(claim)).kind, "replay");
    assert.deepEqual(await adapter.readByInput(claim), { kind: "replay", retryAllowed: false, receipt });
    assert.deepEqual(await adapter.readRecentCompleted({ binding, limit: 4 }), [receipt]);
  } finally {
    await closePostgresPool(pool);
  }
});
