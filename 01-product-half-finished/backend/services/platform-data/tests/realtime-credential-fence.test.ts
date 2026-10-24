import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CredentialFenceError,
  createRealtimeCredentialFence,
  normalizeCredentialFenceTuple,
  type CredentialFenceTuple,
} from "../src/realtime-credential-fence.ts";

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TUPLE: CredentialFenceTuple = Object.freeze({
  realtimeSessionRef: Object.freeze({
    ref_type: "RealtimeSession" as const,
    ref_id: "71111111-1111-7111-8111-111111111111",
    object_version: "1",
    canonical_payload_sha256: HASH,
  }),
  deviceLeaseRef: Object.freeze({
    ref_type: "DeviceLease" as const,
    ref_id: "72222222-2222-7211-8211-222222222222",
    object_version: "1",
    canonical_payload_sha256: HASH,
  }),
  continuityId: "continuity-fence-test",
  connectionEpoch: "9007199254740993",
  credentialGeneration: "9007199254740995",
});

class FakeClient {
  readonly statements: string[] = [];
  active = false;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const query = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(query);
    if (query === "BEGIN" || query.startsWith("SET TRANSACTION") || query === "COMMIT" || query === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (query.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    if (query.includes("FROM public.realtime_external_effects")) {
      if (!this.active) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          effect_state: "in_flight",
          stage_state: { participant_disconnected: { state: "completed", updatedAt: "2026-09-01T00:00:00.000Z" } },
          fencing_epoch: "1",
          credential_generation: String(params[5]),
        }],
        rowCount: 1,
      };
    }
    throw new Error(`UNHANDLED_FAKE_QUERY: ${query}`);
  }

  release(): void {}
}

function fixture(): { readonly fence: ReturnType<typeof createRealtimeCredentialFence>; readonly client: FakeClient } {
  const client = new FakeClient();
  const pool = { connect: async () => client };
  return { fence: createRealtimeCredentialFence(pool as never), client };
}

test("normalizes exact canonical tuple and rejects missing generation", () => {
  assert.deepEqual(normalizeCredentialFenceTuple(TUPLE), TUPLE);
  assert.throws(
    () => normalizeCredentialFenceTuple({ ...TUPLE, credentialGeneration: undefined }),
    (error: unknown) => error instanceof CredentialFenceError && error.code === "CREDENTIAL_FENCE_GENERATION_INVALID",
  );
});

test("verify/replay report active state and use the canonical advisory lock", async () => {
  const { fence, client } = fixture();
  client.active = true;
  const verified = await fence.verify(TUPLE);
  assert.equal(verified.active, true);
  assert.equal(verified.effectState, "in_flight");
  assert.deepEqual(await fence.replay(TUPLE), verified);
  assert.equal(client.statements.filter((sql) => sql.startsWith("SELECT pg_advisory_xact_lock")).length, 2);
  await fence.close();
});

test("install rejects an active tuple and withAdmission runs only when clear", async () => {
  const { fence, client } = fixture();
  client.active = true;
  await assert.rejects(
    () => fence.install(client as never, TUPLE),
    (error: unknown) => error instanceof CredentialFenceError && error.code === "CREDENTIAL_FENCE_ACTIVE",
  );
  client.active = false;
  const order: string[] = [];
  const admitted = await fence.withAdmission(TUPLE, async () => {
    order.push("callback");
    return "admitted";
  });
  assert.equal(admitted, "admitted");
  assert.deepEqual(order, ["callback"]);
  assert.ok(client.statements.findIndex((sql) => sql.startsWith("SELECT pg_advisory_xact_lock")) >= 0);
  assert.ok(client.statements.findIndex((sql) => sql.includes("FROM public.realtime_external_effects")) >= 0);
  await fence.close();
});
