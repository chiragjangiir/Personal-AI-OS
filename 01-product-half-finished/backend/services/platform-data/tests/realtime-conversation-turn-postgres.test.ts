import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resetPostgresConversations } from "../src/conversation-reset.ts";

import {
  conversationTurnIdempotencyPayloadSha256,
  createRealtimeConversationTurnPostgres,
  REALTIME_CONVERSATION_TURN_EVENT,
  REALTIME_CONVERSATION_TURN_SCOPE,
  type ConversationTurnCanonicalRef,
  type RealtimeConversationTurnBinding,
  type RealtimeConversationTurnClaimInput,
} from "../src/realtime-conversation-turn-postgres.ts";

const HASH = "a".repeat(64);
const SESSION_ID = "01970000-0000-7000-8000-000000000001";
const LEASE_ID = "01970000-0000-7000-8000-000000000002";
const CONTINUITY_ID = "01970000-0000-7000-8000-000000000003";
const SESSION_REF = ref("RealtimeSession", SESSION_ID);
const LEASE_REF = ref("DeviceLease", LEASE_ID);
const BINDING: RealtimeConversationTurnBinding = Object.freeze({
  realtimeSessionRef: SESSION_REF,
  deviceLeaseRef: LEASE_REF,
  continuityId: CONTINUITY_ID,
  connectionEpoch: "2",
  leaseVersion: "3",
});

function ref(type: string, id: string, hash = HASH): ConversationTurnCanonicalRef {
  return Object.freeze({ ref_type: type, ref_id: id, object_version: "1", canonical_payload_sha256: hash });
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function claim(
  key: string,
  input: Omit<RealtimeConversationTurnClaimInput, "idempotencyKey" | "idempotencyPayloadSha256">,
): RealtimeConversationTurnClaimInput {
  return Object.freeze({
    ...input,
    idempotencyKey: key,
    idempotencyPayloadSha256: conversationTurnIdempotencyPayloadSha256(input),
  });
}

function typed(key = "typed-prompt-0001", userText = "你好"): RealtimeConversationTurnClaimInput {
  return claim(key, {
    binding: BINDING,
    inputKind: "typed",
    inputId: key,
    userText,
    userTextSha256: sha(userText),
  });
}

function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    s_ref: SESSION_REF,
    s_continuity_id: CONTINUITY_ID,
    s_state: "active",
    s_continuity_state: "active",
    s_epoch: "2",
    s_current: true,
    s_active_lease_ref: LEASE_REF,
    s_binding: {
      state: "connected",
      realtimeSessionRef: SESSION_REF,
      deviceLeaseRef: LEASE_REF,
      continuityId: CONTINUITY_ID,
      connectionEpoch: "2",
    },
    l_ref: LEASE_REF,
    l_session_ref: SESSION_REF,
    l_continuity_id: CONTINUITY_ID,
    l_state: "active",
    l_version: "3",
    l_current: true,
    ...overrides,
  };
}

interface LedgerRow {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: string;
  response: unknown;
  response_hash: string | null;
  fencing_epoch: string;
}

interface OutboxRow {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  idempotency_scope: string;
  idempotency_key: string;
  payload: unknown;
  payload_sha256: string;
  status: string;
  attempt_count: number;
  claimed_by: null;
}

class FakeClient {
  readonly statements: string[] = [];
  readonly ledger = new Map<string, LedgerRow>();
  readonly outbox = new Map<string, OutboxRow>();
  current = bindingRow();
  duplicateBinding = false;
  duplicateOutbox = false;
  readonly historicalBindings = new Map<string, Record<string, unknown>>();
  nowIndex = 0;
  private snapshot?: { ledger: Map<string, LedgerRow>; outbox: Map<string, OutboxRow> };

  async query(sql: string, params: readonly unknown[] = []): Promise<any> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    if (normalized === "BEGIN") {
      this.snapshot = { ledger: structuredClone(this.ledger), outbox: structuredClone(this.outbox) };
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SET TRANSACTION")) return { rows: [], rowCount: 0 };
    if (normalized === "COMMIT") { this.snapshot = undefined; return { rows: [], rowCount: 0 }; }
    if (normalized === "ROLLBACK") {
      if (this.snapshot !== undefined) {
        this.ledger.clear(); for (const [key, value] of this.snapshot.ledger) this.ledger.set(key, value);
        this.outbox.clear(); for (const [key, value] of this.snapshot.outbox) this.outbox.set(key, value);
      }
      this.snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SELECT s.realtime_session_ref AS s_ref")) {
      const currentLease = (this.current.l_ref as ConversationTurnCanonicalRef).ref_id;
      const selected = String(params[1]) === currentLease
        ? this.current
        : this.historicalBindings.get(String(params[1]));
      const rows = selected === undefined ? [] : [structuredClone(selected)];
      return { rows: this.duplicateBinding ? [...rows, structuredClone(this.current)] : rows, rowCount: this.duplicateBinding ? 2 : 1 };
    }
    if (normalized.startsWith("INSERT INTO idempotency_ledger")) {
      const key = String(params[1]);
      if (this.ledger.has(key)) return { rows: [], rowCount: 0 };
      const row: LedgerRow = {
        scope: String(params[0]), idempotency_key: key, request_hash: String(params[2]), status: "in_flight",
        response: null, response_hash: null, fencing_epoch: String(params[3]),
      };
      this.ledger.set(key, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (normalized.includes("FROM idempotency_ledger") && normalized.includes("FOR UPDATE")) {
      const row = this.ledger.get(String(params[1]));
      return { rows: row === undefined ? [] : [structuredClone(row)], rowCount: row === undefined ? 0 : 1 };
    }
    if (normalized === "SELECT transaction_timestamp() AS transaction_time") {
      const time = new Date(Date.parse("2026-09-07T00:00:00.000Z") + this.nowIndex++ * 1000);
      return { rows: [{ transaction_time: time }], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO outbox_events")) {
      const key = String(params[6]);
      if (this.outbox.has(key)) return { rows: [], rowCount: 0 };
      const row: OutboxRow = {
        event_id: String(params[0]), aggregate_type: String(params[1]), aggregate_id: String(params[2]),
        event_type: String(params[3]), event_version: Number(params[4]), idempotency_scope: String(params[5]),
        idempotency_key: key, payload: JSON.parse(String(params[7])), payload_sha256: String(params[8]),
        status: "pending", attempt_count: 0, claimed_by: null,
      };
      this.outbox.set(key, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE idempotency_ledger SET status = 'committed'") ||
        normalized.startsWith("UPDATE idempotency_ledger SET status = 'indeterminate'")) {
      const key = String(params[1]);
      const row = this.ledger.get(key);
      if (row === undefined || row.status !== "in_flight" || row.request_hash !== params[4]) return { rows: [], rowCount: 0 };
      row.status = normalized.includes("'committed'") ? "committed" : "indeterminate";
      row.response = JSON.parse(String(params[2]));
      row.response_hash = String(params[3]);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT event_id::text") && normalized.includes("FROM outbox_events")) {
      const row = this.outbox.get(String(params[1]));
      if (row === undefined) return { rows: [], rowCount: 0 };
      return { rows: this.duplicateOutbox ? [structuredClone(row), structuredClone(row)] : [structuredClone(row)], rowCount: this.duplicateOutbox ? 2 : 1 };
    }
    if (normalized.startsWith("SELECT scope, idempotency_key") && normalized.includes("FROM idempotency_ledger")) {
      const row = this.ledger.get(String(params[1]));
      return { rows: row === undefined ? [] : [structuredClone(row)], rowCount: row === undefined ? 0 : 1 };
    }
    if (normalized.startsWith("DELETE FROM idempotency_ledger")) {
      const key = String(params[1]); const row = this.ledger.get(key);
      if (row?.status === "in_flight" && row.request_hash === params[2] && !this.outbox.has(key)) {
        this.ledger.delete(key); return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("SELECT l.scope") && normalized.includes("JOIN outbox_events")) {
      const rows = [...this.outbox.values()].map((event) => {
        const ledger = this.ledger.get(event.idempotency_key)!;
        return { ...structuredClone(event), ...structuredClone(ledger), payload: structuredClone(event.payload), outbox_status: event.status };
      }).filter((row) => row.status === "committed" &&
        (row.payload as Record<string, unknown>).continuity_id === params[2]);
      rows.sort((left, right) => String(right.event_id).localeCompare(String(left.event_id)));
      return { rows: rows.slice(0, Number(params[3])), rowCount: rows.length };
    }
    throw new Error(`UNEXPECTED_SQL:${normalized}`);
  }

  release(): void {}
}

function pool(client: FakeClient): any {
  return { connect: async () => client };
}

test("conversation reset removes old content from native history and input replay readers", async () => {
  const client = new FakeClient();
  const adapter = createRealtimeConversationTurnPostgres(pool(client));
  const input = typed("conversation-reset-0001");
  await adapter.beginClaim(input);
  await adapter.commitCompletedAfterPublish({ claim: input, assistantText: "旧回复", assistantTextSha256: sha("旧回复"),
    publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:00.000Z" } });
  assert.equal((await adapter.readRecentCompleted({ binding: BINDING, limit: 4 })).length, 1);
  assert.equal((await adapter.readByInput(input))?.kind, "replay");
  const payment = { ...structuredClone(client.ledger.get(input.idempotencyKey)!), scope: "payment", idempotency_key: "preserved-payment" };
  client.ledger.set(payment.idempotency_key, payment);
  const original = client.query.bind(client);
  client.query = async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM pg_class")) return { rows: ["idempotency_ledger", "outbox_events", "outbox_consumer_dedupe"].map(table => ({ schema: "public", table })) };
    if (sql.startsWith("LOCK TABLE")) return { rows: [], rowCount: 0 };
    const table = sql.startsWith("SELECT count(*) FILTER") ? /FROM "public"\."(\w+)"/u.exec(sql)?.[1]
      : sql.startsWith("DELETE FROM public.") ? /DELETE FROM public\.(\w+)/u.exec(sql)?.[1] : undefined;
    if (table) {
      const map = table === "idempotency_ledger" ? client.ledger : table === "outbox_events" ? client.outbox : new Map();
      const selected = [...map.entries()].filter(([, row]) => table !== "idempotency_ledger" || (row as LedgerRow).scope === REALTIME_CONVERSATION_TURN_SCOPE);
      if (sql.startsWith("DELETE")) {
        for (const [key] of selected) map.delete(key);
        return { rows: [], rowCount: selected.length };
      }
      return { rows: [{ delete_rows: selected.length, delete_bytes: selected.length * 10,
        keep_rows: map.size - selected.length, keep_bytes: (map.size - selected.length) * 10 }] };
    }
    return original(sql, params);
  };
  const cutoff = "2026-10-18T10:14:00Z";
  const preview = await resetPostgresConversations(pool(client), { cutoff });
  assert.equal(preview.executed, false);
  assert.equal((await adapter.readByInput(input))?.kind, "replay");
  await resetPostgresConversations(pool(client), { cutoff, execute: true });
  assert.equal(await adapter.readByInput(input), undefined);
  assert.deepEqual(await adapter.readRecentCompleted({ binding: BINDING, limit: 4 }), []);
  assert.deepEqual(client.ledger.get(payment.idempotency_key), payment);
  const again = await resetPostgresConversations(pool(client), { cutoff, execute: true });
  assert(again.tables.every(table => table.delete_rows === 0));
});

test("typed completed turn commits after confirmed publish and replays byte-identically", async () => {
  const client = new FakeClient();
  const adapter = createRealtimeConversationTurnPostgres(pool(client));
  const input = typed();
  assert.deepEqual(await adapter.beginClaim(input), { kind: "claimed", retryAllowed: false });
  await assert.rejects(() => adapter.commitCompletedAfterPublish({
    claim: input,
    assistantText: "尚未确认",
    assistantTextSha256: sha("尚未确认"),
    publishObservation: { state: "ambiguous", observedAt: "2026-09-07T00:00:00.000Z" },
  }), /CONVERSATION_TURN_PUBLISH_OBSERVATION_INVALID/);
  const completed = await adapter.commitCompletedAfterPublish({
    claim: input,
    assistantText: "你好，我在。",
    assistantTextSha256: sha("你好，我在。"),
    publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:00.000Z" },
  });
  assert.equal(completed.delivery_state, "completed");
  assert.equal(client.ledger.size, 1);
  assert.equal(client.outbox.size, 1);
  const replay = await adapter.beginClaim(input);
  assert.equal(replay.kind, "replay");
  if (replay.kind !== "replay") assert.fail("expected replay");
  assert.deepEqual(replay.receipt, completed);
  assert.equal((await adapter.readRecentCompleted({ binding: BINDING, limit: 4 })).length, 1);
});

test("audio indeterminate and visual completed preserve their exact branches", async () => {
  const audioClient = new FakeClient();
  const audio = createRealtimeConversationTurnPostgres(pool(audioClient));
  const evidence = ref("FinalTranscriptEvidence", "01970000-0000-7000-8000-000000000004");
  const visualRef = ref("ArtifactVersion", "01970000-0000-7000-8000-000000000005");
  const audioInput = claim("audio-input-00001", {
    binding: BINDING, inputKind: "audio", inputId: "rayneo_segment_aaaaaaaaaaaaaaaaaaaa",
    userText: "音频问题", userTextSha256: sha("音频问题"), finalTranscriptEvidenceRef: evidence,
    sourceVisualRefs: [visualRef],
  });
  await audio.beginClaim(audioInput);
  await assert.rejects(() => audio.markIndeterminate({
    claim: audioInput, assistantText: "错误确认状态", assistantTextSha256: sha("错误确认状态"),
    publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:01.000Z" },
  }), /CONVERSATION_TURN_PUBLISH_OBSERVATION_INVALID/);
  const indeterminate = await audio.markIndeterminate({
    claim: audioInput, assistantText: "可能已经发送", assistantTextSha256: sha("可能已经发送"),
    publishObservation: { state: "ambiguous", observedAt: "2026-09-07T00:00:01.000Z" },
  });
  assert.equal(indeterminate.delivery_state, "indeterminate");
  assert.equal(audioClient.outbox.size, 0);
  assert.equal((await audio.readByInput(audioInput))?.kind, "indeterminate");

  const visualClient = new FakeClient();
  const visual = createRealtimeConversationTurnPostgres(pool(visualClient));
  const visualInput = claim("visual-input-0001", {
    binding: BINDING, inputKind: "visual", inputId: "rayneo_segment_bbbbbbbbbbbbbbbbbbbb",
    sourceVisualRefs: [visualRef],
  });
  await visual.beginClaim(visualInput);
  const completed = await visual.commitCompletedAfterPublish({
    claim: visualInput, assistantText: "画面中有一辆车。", assistantTextSha256: sha("画面中有一辆车。"),
    publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:02.000Z" },
  });
  assert.equal(completed.user_text, undefined);
  assert.equal(completed.source_visual_refs?.length, 1);
});

test("claim conflict, in-flight and explicit pre-publish release never authorize retry implicitly", async () => {
  const client = new FakeClient();
  const adapter = createRealtimeConversationTurnPostgres(pool(client));
  const first = typed("typed-prompt-0002", "A");
  assert.equal((await adapter.beginClaim(first)).kind, "claimed");
  assert.equal((await adapter.beginClaim(first)).kind, "in_flight");
  const drift = typed("typed-prompt-0002", "B");
  assert.equal((await adapter.beginClaim(drift)).kind, "conflict");
  assert.equal(await adapter.releaseBeforePublish(first), true);
  assert.equal(client.ledger.size, 0);
  assert.equal((await adapter.beginClaim(first)).kind, "claimed");
});

test("Stop race blocks completed receipt and permits only indeterminate terminalization", async () => {
  const client = new FakeClient();
  const adapter = createRealtimeConversationTurnPostgres(pool(client));
  const input = typed("typed-prompt-0003");
  await adapter.beginClaim(input);
  client.current = bindingRow({ s_state: "terminal", s_continuity_state: "ended", l_state: "released", s_current: false, l_current: false });
  await assert.rejects(() => adapter.commitCompletedAfterPublish({
    claim: input, assistantText: "不应完成", assistantTextSha256: sha("不应完成"),
    publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:03.000Z" },
  }), /CONVERSATION_TURN_CURRENT_BINDING_INVALID/);
  assert.equal(client.outbox.size, 0);
  const receipt = await adapter.markIndeterminate({
    claim: input, assistantText: "发布结果不确定", assistantTextSha256: sha("发布结果不确定"),
    publishObservation: { state: "ambiguous", observedAt: "2026-09-07T00:00:04.000Z" },
  });
  assert.equal(receipt.delivery_state, "indeterminate");
});

test("closed input, hashes, duplicate refs, current and stored drift fail closed", async () => {
  assert.throws(() => typed("typed-prompt-0004", "e\u0301"), /CONVERSATION_TURN_USER_TEXT_INVALID/);
  const visualRef = ref("SourceArtifact", "01970000-0000-7000-8000-000000000006");
  assert.throws(() => claim("visual-input-0002", {
    binding: BINDING, inputKind: "visual", inputId: "rayneo_segment_cccccccccccccccccccc",
    sourceVisualRefs: [visualRef, visualRef],
  }), /CONVERSATION_TURN_VISUAL_REFS_INVALID/);
  await assert.rejects(() => createRealtimeConversationTurnPostgres(pool(new FakeClient())).beginClaim({
    ...typed("typed-prompt-0005"), idempotencyPayloadSha256: "b".repeat(64),
  }), /CONVERSATION_TURN_IDEMPOTENCY_HASH_INVALID/);

  const client = new FakeClient();
  client.current = bindingRow({ s_epoch: "9" });
  await assert.rejects(() => createRealtimeConversationTurnPostgres(pool(client)).beginClaim(typed("typed-prompt-0006")),
    /CONVERSATION_TURN_BINDING_DRIFT/);
});

test("history is stable, bounded, detects duplicate/orphan drift and never touches Memory", async () => {
  const client = new FakeClient();
  const adapter = createRealtimeConversationTurnPostgres(pool(client));
  for (const [key, content] of [["typed-prompt-0007", "第一"], ["typed-prompt-0008", "第二"]] as const) {
    const input = typed(key, content);
    await adapter.beginClaim(input);
    await adapter.commitCompletedAfterPublish({
      claim: input, assistantText: `${content}回复`, assistantTextSha256: sha(`${content}回复`),
      publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:05.000Z" },
    });
  }
  const history = await adapter.readRecentCompleted({ binding: BINDING, limit: 2 });
  assert.equal(history.length, 2);
  assert.ok(history[0]!.committed_at <= history[1]!.committed_at);
  assert.ok(Object.isFrozen(history) && Object.isFrozen(history[0]!));
  assert.equal(client.statements.some((sql) => /memory_/iu.test(sql)), false);

  client.duplicateOutbox = true;
  await assert.rejects(() => adapter.readByInput(typed("typed-prompt-0007", "第一")),
    /CONVERSATION_TURN_COMPLETED_DRIFT/);
  client.duplicateOutbox = false;
  const storedEvent = client.outbox.get("typed-prompt-0007")!;
  const originalPayloadHash = storedEvent.payload_sha256;
  storedEvent.payload_sha256 = "b".repeat(64);
  await assert.rejects(() => adapter.readByInput(typed("typed-prompt-0007", "第一")),
    /CONVERSATION_TURN_OUTBOX_DRIFT/);
  storedEvent.payload_sha256 = originalPayloadHash;
  const orphanLease = ref("DeviceLease", "01970000-0000-7000-8000-000000000012");
  client.current = bindingRow({ l_ref: orphanLease, l_session_ref: SESSION_REF });
  await assert.rejects(() => adapter.readByInput(typed("typed-prompt-0007", "第一")),
    /CONVERSATION_TURN_BINDING_MISSING/);
  client.current = bindingRow({ l_continuity_id: "01970000-0000-7000-8000-000000000099" });
  await assert.rejects(() => adapter.readRecentCompleted({ binding: BINDING, limit: 2 }),
    /CONVERSATION_TURN_BINDING_DRIFT/);
});

test("same-continuity handoff reads immutable historical binding without rewriting its old epoch or lease version", async () => {
  const client = new FakeClient();
  const adapter = createRealtimeConversationTurnPostgres(pool(client));
  const input = typed("typed-prompt-0009", "跨设备历史");
  await adapter.beginClaim(input);
  await adapter.commitCompletedAfterPublish({
    claim: input, assistantText: "历史仍可恢复", assistantTextSha256: sha("历史仍可恢复"),
    publishObservation: { state: "confirmed", observedAt: "2026-09-07T00:00:06.000Z" },
  });
  client.historicalBindings.set(LEASE_ID, bindingRow({
    s_state: "terminal", s_continuity_state: "ended", s_epoch: "3", s_current: false,
    l_state: "released", l_version: "4", l_current: false,
  }));
  const nextSession = ref("RealtimeSession", "01970000-0000-7000-8000-000000000010");
  const nextLease = ref("DeviceLease", "01970000-0000-7000-8000-000000000011");
  const nextBinding: RealtimeConversationTurnBinding = Object.freeze({
    realtimeSessionRef: nextSession, deviceLeaseRef: nextLease, continuityId: CONTINUITY_ID,
    connectionEpoch: "5", leaseVersion: "1",
  });
  client.current = bindingRow({
    s_ref: nextSession, s_epoch: "5", s_active_lease_ref: nextLease,
    s_binding: { state: "connected", realtimeSessionRef: nextSession, deviceLeaseRef: nextLease,
      continuityId: CONTINUITY_ID, connectionEpoch: "5" },
    l_ref: nextLease, l_session_ref: nextSession, l_version: "1",
  });
  const history = await adapter.readRecentCompleted({ binding: nextBinding, limit: 4 });
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.realtime_session_ref, SESSION_REF);
  assert.equal(history[0]!.connection_epoch, "2");
  assert.equal(history[0]!.lease_version, "3");
});

test("source uses only existing ledger/outbox helpers and no migration, terminal fact, external effect or Memory", async () => {
  const source = await readFile(new URL("../src/realtime-conversation-turn-postgres.ts", import.meta.url), "utf8");
  assert.match(source, /claimIdempotency/u);
  assert.match(source, /completeIdempotency/u);
  assert.match(source, /completeIndeterminate/u);
  assert.match(source, /enqueueOutboxEvent/u);
  assert.doesNotMatch(source, /INSERT INTO (?:memory_|realtime_terminal_facts|realtime_external_effects)/iu);
  assert.equal(REALTIME_CONVERSATION_TURN_SCOPE, "realtime.conversation_turn.v1");
  assert.equal(REALTIME_CONVERSATION_TURN_EVENT, "realtime.conversation.turn.completed.v1");
});
