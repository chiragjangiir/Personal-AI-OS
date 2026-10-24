import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  closePostgresPool,
  createPostgresPool,
  isPostgresConfigured,
} from "../src/postgres-pool.ts";
import {
  createRealtimeE2eeDurableReplayPostgres,
  REALTIME_E2EE_DURABLE_REPLAY_SCOPE,
  RealtimeE2eeDurableReplayError,
  RealtimeE2eeDurableReplayPostgres,
  type JsonRecord,
} from "../src/realtime-e2ee-durable-replay-postgres.ts";

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE = "018f0e0e-0000-7000-8000-000000000004";
const CONTINUITY = "018f0e0e-0000-7000-8000-000000000003";
const SESSION = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: "018f0e0e-0000-7000-8000-000000000001",
  object_version: "1",
  canonical_payload_sha256: HASH,
});
const LEASE = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: "018f0e0e-0000-7000-8000-000000000002",
  object_version: "2",
  canonical_payload_sha256: HASH,
});

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("unstable test value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as JsonRecord)[key])}`).join(",")}}`;
  }
  throw new TypeError("unstable test value");
}

function request(idempotencyKey: string, requestId = idempotencyKey): JsonRecord {
  return {
    operation: "realtime_e2ee_key_resolve",
    request_id: requestId,
    idempotency_context: {
      idempotency_scope: { owner_module: "T11B", operation_kind: "realtime_e2ee_key_resolve", target_object_type: "RealtimeSession" },
      idempotency_key: idempotencyKey,
      idempotency_profile_id: "https://personal-ai-os.local/contracts/realtime/realtime-e2ee-key-resolve-request.v1.schema.json",
      idempotency_profile_version: "1.0.0",
      idempotency_profile_sha256: HASH,
      idempotency_request_sha256: HASH,
    },
    realtime_session_ref: SESSION,
    device_lease_ref: LEASE,
    continuity_id: CONTINUITY,
    connection_epoch: "7",
    transport_aliases: [{ alias_type: "room", issuer: "test", value: "room-001" }],
    key_envelope_ref: { alias_type: "key_envelope", issuer: "test", value: "envelope-001" },
    key_index: 0,
    key_generation: "1",
    device_id: DEVICE,
    recipient_device_credential_ref: {
      ref_type: "DeviceCredential",
      ref_id: "018f0e0e-0000-7000-8000-000000000006",
      object_version: "3",
      canonical_payload_sha256: HASH,
    },
    participant_audience: { alias_type: "participant", issuer: "test", value: "audience-001" },
    governance: {
      purpose_scopes: ["realtime_audio"],
      consent_record_refs: ["018f0e0e-0000-7000-8000-000000000007"],
      policy_decision_refs: ["018f0e0e-0000-7000-8000-000000000008"],
      purpose_token_refs: ["018f0e0e-0000-7000-8000-000000000009"],
      capability_grant_refs: ["018f0e0e-0000-7000-8000-00000000000a"],
    },
  };
}

function responseFor(input: JsonRecord, suffix = "ciphertext-only") : JsonRecord {
  return {
    ...input,
    status: "key_resolved",
    expires_at: "2026-09-01T12:00:00.000Z",
    cipher_suite: "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM",
    encapsulated_key: `enc-${suffix}`,
    ciphertext: `cipher-${suffix}`,
    aad_sha256: HASH,
  };
}

type LedgerRow = {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: string;
  response: unknown;
  response_hash: string | null;
  fencing_epoch: string | null;
  claim_token_sha256: string | null;
  claim_owner: string | null;
};

function cloneRow(row: LedgerRow | undefined): LedgerRow | undefined {
  return row === undefined ? undefined : { ...row, response: row.response === null ? null : JSON.parse(JSON.stringify(row.response)) };
}

class FakeClient {
  readonly statements: string[] = [];
  readonly rows = new Map<string, LedgerRow>();
  #snapshot: Map<string, LedgerRow> | undefined;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: LedgerRow[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    if (normalized === "BEGIN") {
      this.#snapshot = new Map([...this.rows].map(([key, row]) => [key, cloneRow(row)!]));
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SET TRANSACTION")) return { rows: [], rowCount: 0 };
    if (normalized === "COMMIT") {
      this.#snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      this.rows.clear();
      for (const [key, row] of this.#snapshot ?? []) this.rows.set(key, cloneRow(row)!);
      this.#snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT INTO idempotency_ledger")) {
      const scope = String(params[0]);
      const key = String(params[1]);
      const existing = this.rows.get(`${scope}\u0000${key}`);
      if (existing !== undefined) return { rows: [], rowCount: 0 };
      const row: LedgerRow = {
        scope,
        idempotency_key: key,
        request_hash: String(params[2]),
        status: "in_flight",
        response: null,
        response_hash: null,
        fencing_epoch: params[3] === null || params[3] === undefined ? null : String(params[3]),
        claim_token_sha256: null,
        claim_owner: null,
      };
      this.rows.set(`${scope}\u0000${key}`, row);
      return { rows: [row], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT scope, idempotency_key, request_hash")) {
      const row = this.rows.get(`${String(params[0])}\u0000${String(params[1])}`);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE idempotency_ledger SET claim_token_sha256")) {
      const row = this.rows.get(`${String(params[0])}\u0000${String(params[1])}`);
      if (row === undefined || row.request_hash !== String(params[4]) || row.status !== "in_flight" || row.claim_token_sha256 !== null) {
        return { rows: [], rowCount: 0 };
      }
      row.claim_token_sha256 = String(params[2]);
      row.claim_owner = String(params[3]);
      return { rows: [row], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT idempotency_key, request_hash, status, response, response_hash, claim_token_sha256")) {
      const row = [...this.rows.values()].find((candidate) => candidate.scope === String(params[0]) && candidate.claim_token_sha256 === String(params[1]));
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE idempotency_ledger SET status = 'committed'")) {
      const row = this.rows.get(`${String(params[0])}\u0000${String(params[1])}`);
      if (row === undefined || row.status !== "in_flight" || row.request_hash !== String(params[4])) return { rows: [], rowCount: 0 };
      row.status = "committed";
      row.response = JSON.parse(String(params[2]));
      row.response_hash = String(params[3]);
      return { rows: [row], rowCount: 1 };
    }
    if (normalized.startsWith("DELETE FROM idempotency_ledger")) {
      const key = `${String(params[0])}\u0000${String(params[1])}`;
      const row = this.rows.get(key);
      if (row !== undefined && row.request_hash === String(params[2]) && row.claim_token_sha256 === String(params[3]) && row.status === "in_flight") this.rows.delete(key);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  }

  release(): void {}
}

function fakePool(client: FakeClient): any {
  return { connect: async () => client };
}

function claimInput(idempotencyKey = "e2ee-replay-unit-001") {
  const body = request(idempotencyKey);
  return { request: body, idempotencyContext: body.idempotency_context as JsonRecord, fingerprint: stable(body) };
}

test("E2EE replay claims and commits a closed ciphertext envelope", async () => {
  const client = new FakeClient();
  const replay = new RealtimeE2eeDurableReplayPostgres(fakePool(client), { claimId: () => "claim-e2ee-unit-001" });
  const input = claimInput();
  const first = await replay.claim(input);
  assert.equal(first.disposition, "claimed");
  const response = responseFor(input.request);
  await replay.commit({ claimId: "claim-e2ee-unit-001", fingerprint: input.fingerprint, response });

  const row = client.rows.get(`${REALTIME_E2EE_DURABLE_REPLAY_SCOPE}\u0000e2ee-replay-unit-001`)!;
  assert.equal(row.status, "committed");
  assert.deepEqual(Object.keys(row.response as JsonRecord).sort(), Object.keys(response).sort());
  assert.equal((row.response as JsonRecord).ciphertext, "cipher-ciphertext-only");
  assert.equal((row.response as JsonRecord).plaintext, undefined);

  const replayed = await replay.claim(input);
  assert.equal(replayed.disposition, "replay");
  if (replayed.disposition === "replay") {
    assert.deepEqual(replayed.response, response);
  }
  await replay.close();
  await assert.rejects(() => replay.claim(input), (error: unknown) => error instanceof RealtimeE2eeDurableReplayError && error.code === "REALTIME_E2EE_REPLAY_CLOSED");
});

test("E2EE replay rejects a same-key fingerprint drift and allows only explicit release retry", async () => {
  const client = new FakeClient();
  const replay = createRealtimeE2eeDurableReplayPostgres(fakePool(client), { claimId: () => "claim-e2ee-unit-002" });
  const input = claimInput("e2ee-replay-unit-002");
  assert.equal((await replay.claim(input)).disposition, "claimed");

  const changed = request("e2ee-replay-unit-002", "different-request");
  const changedInput = { request: changed, idempotencyContext: changed.idempotency_context as JsonRecord, fingerprint: stable(changed) };
  assert.deepEqual(await replay.claim(changedInput), { disposition: "conflict" });
  await replay.release({ claimId: "claim-e2ee-unit-002", fingerprint: input.fingerprint });
  assert.equal((await replay.claim(input)).disposition, "claimed");
  await replay.abort({ claimId: "claim-e2ee-unit-002", fingerprint: input.fingerprint });
  assert.equal(client.rows.size, 0);
});

test("E2EE replay commit is idempotent and refuses a different committed response", async () => {
  const client = new FakeClient();
  const replay = createRealtimeE2eeDurableReplayPostgres(fakePool(client), { claimId: () => "claim-e2ee-unit-003" });
  const input = claimInput("e2ee-replay-unit-003");
  await replay.claim(input);
  const first = responseFor(input.request, "first");
  const second = responseFor(input.request, "second");
  await replay.commit({ claimId: "claim-e2ee-unit-003", fingerprint: input.fingerprint, response: first });
  await replay.commit({ claimId: "claim-e2ee-unit-003", fingerprint: input.fingerprint, response: first });
  await assert.rejects(
    () => replay.commit({ claimId: "claim-e2ee-unit-003", fingerprint: input.fingerprint, response: second }),
    (error: unknown) => error instanceof RealtimeE2eeDurableReplayError && error.code === "REALTIME_E2EE_REPLAY_RESPONSE_CONFLICT",
  );
});

test("E2EE replay validates canonical input and rejects raw key/plaintext fields", async () => {
  const client = new FakeClient();
  const replay = createRealtimeE2eeDurableReplayPostgres(fakePool(client), { claimId: () => "claim-e2ee-unit-004" });
  const input = claimInput("e2ee-replay-unit-004");
  const forbidden = { ...input.request, plaintext: "must-not-be-accepted" };
  await assert.rejects(() => replay.claim({ ...input, request: forbidden, fingerprint: stable(forbidden) }), RealtimeE2eeDurableReplayError);
  assert.equal(client.statements.includes("BEGIN"), false);
  await assert.rejects(() => replay.claim({ ...input, fingerprint: `${input.fingerprint} ` }), RealtimeE2eeDurableReplayError);
  assert.equal(client.rows.size, 0);
  await replay.claim(input);
  const response = responseFor(input.request);
  await assert.rejects(
    () => replay.commit({ claimId: "claim-e2ee-unit-004", fingerprint: input.fingerprint, response: { ...response, plaintext: "no" } }),
    (error: unknown) => error instanceof RealtimeE2eeDurableReplayError && error.code === "REALTIME_E2EE_REPLAY_INPUT_SECRET",
  );
  await replay.abort({ claimId: "claim-e2ee-unit-004", fingerprint: input.fingerprint });
});

const RUN_PG = process.env.PAIOS_RUN_PG_INTEGRATION === "1" &&
  isPostgresConfigured();
const SKIP_REASON = "set PAIOS_RUN_PG_INTEGRATION=1 with approved disposable PAIOS_PG_* credentials";

test("E2EE replay survives a fresh adapter readback on PG18 with byte-identical ciphertext", { skip: RUN_PG ? false : SKIP_REASON, concurrency: false }, async () => {
  assert.equal(process.env.PAIOS_PG_HOST, "127.0.0.1");
  const port = Number(process.env.PAIOS_PG_PORT);
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port !== 5432 && port !== 55432, "explicit disposable PostgreSQL port required");
  const pool = createPostgresPool({ port, applicationName: "paios-e2ee-replay-test" });
  const key = `e2ee-replay-pg-${randomUUID()}`;
  const claimId = `claim-pg-${randomUUID()}`;
  const input = claimInput(key);
  const response = responseFor(input.request, "pg");
  try {
    const schema = await pool.query("SELECT to_regclass('public.idempotency_ledger') AS ledger");
    assert.equal(schema.rows[0]?.ledger, "idempotency_ledger");
    const first = createRealtimeE2eeDurableReplayPostgres(pool, { claimId: () => claimId });
    assert.equal((await first.claim(input)).disposition, "claimed");
    await first.commit({ claimId, fingerprint: input.fingerprint, response });
    await first.close();

    const afterRestart = createRealtimeE2eeDurableReplayPostgres(pool, { claimId: () => `unused-${randomUUID()}` });
    const replayed = await afterRestart.claim(input);
    assert.equal(replayed.disposition, "replay");
    const row = await pool.query(
      "SELECT status, response::text AS response_text, response_hash FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2",
      [REALTIME_E2EE_DURABLE_REPLAY_SCOPE, key],
    );
    assert.equal(row.rows[0]?.status, "committed");
    assert.match(String(row.rows[0]?.response_hash), /^[0-9a-f]{64}$/u);
    assert.equal(String(row.rows[0]?.response_text).includes("cipher-pg"), true);
    assert.equal(String(row.rows[0]?.response_text).includes("plaintext"), false);
    if (replayed.disposition === "replay") assert.deepEqual(replayed.response, response);
    await afterRestart.close();
  } finally {
    await pool.query("DELETE FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2", [REALTIME_E2EE_DURABLE_REPLAY_SCOPE, key]).catch(() => undefined);
    await closePostgresPool(pool);
  }
});
