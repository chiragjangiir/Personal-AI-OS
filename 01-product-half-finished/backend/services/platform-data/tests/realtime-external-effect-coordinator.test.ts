import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  RealtimeExternalEffectCoordinator,
  RealtimeExternalEffectError,
  type JsonRecord,
  type RealtimeMediaStopIntent,
} from "../src/realtime-external-effect-coordinator.ts";
import { createRealtimeCredentialFence, type CredentialFenceTuple } from "../src/realtime-credential-fence.ts";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION = Object.freeze({ ref_type: "RealtimeSession", ref_id: "11111111-1111-7111-8111-111111111111", object_version: "1", canonical_payload_sha256: HASH_A });
const LEASE = Object.freeze({ ref_type: "DeviceLease", ref_id: "22222222-2222-7222-8222-222222222222", object_version: "1", canonical_payload_sha256: HASH_A });

function json(value: unknown): unknown {
  return JSON.parse(String(value));
}

class FakeClient {
  readonly ledger = new Map<string, Record<string, unknown>>();
  readonly effects = new Map<string, Record<string, any>>();
  readonly outbox = new Map<string, Record<string, unknown>>();
  readonly statements: string[] = [];
  readonly stalled = new Set<string>();

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, any>[]; rowCount: number }> {
    const q = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(q);
    if (q === "BEGIN" || q.startsWith("SET TRANSACTION") || q === "COMMIT" || q === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (q.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    if (q.startsWith("INSERT INTO idempotency_ledger")) {
      const key = `${params[0]}\u0000${params[1]}`;
      if (this.ledger.has(key)) return { rows: [], rowCount: 0 };
      const row = {
        scope: params[0], idempotency_key: params[1], request_hash: params[2], status: "in_flight",
        response: null, response_hash: null, fencing_epoch: params[3] ?? null,
      };
      this.ledger.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith("SELECT scope, idempotency_key, request_hash")) {
      const row = this.ledger.get(`${params[0]}\u0000${params[1]}`);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (q.startsWith("UPDATE idempotency_ledger")) {
      const row = this.ledger.get(`${params[0]}\u0000${params[1]}`);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = "committed";
      row.response = json(params[2]);
      row.response_hash = params[3];
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith("INSERT INTO realtime_external_effects")) {
      const row = {
        effect_id: params[0], operation: params[1], request_scope: params[2], idempotency_key: params[3],
        fingerprint: params[4], fingerprint_sha256: params[5], wire_request: json(params[6]), intent: json(params[7]),
        claim_id: params[8], fencing_epoch: params[9], expected_connection_epoch: params[10], expected_lease_version: params[11],
        realtime_session_ref: params[12] === null ? null : json(params[12]),
        device_lease_ref: params[13] === null ? null : json(params[13]),
        continuity_id: params[14], connection_epoch: params[15], credential_generation: params[16],
        effect_state: "in_flight", stage_state: {}, suppression_result: null, result: null, result_sha256: null,
      };
      this.effects.set(`${params[2]}\u0000${params[3]}`, row);
      return { rows: [], rowCount: 1 };
    }
    if (q.includes("FROM public.realtime_external_effects")) {
      const row = [...this.effects.values()].find((candidate) => candidate.effect_state !== "released" &&
        JSON.stringify(candidate.realtime_session_ref) === String(params[1]) &&
        JSON.stringify(candidate.device_lease_ref) === String(params[2]) &&
        candidate.continuity_id === params[3] && candidate.connection_epoch === params[4] &&
        candidate.credential_generation === params[5]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (q.includes("FROM realtime_external_effects WHERE request_scope")) {
      const row = this.effects.get(`${params[0]}\u0000${params[1]}`);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (q.includes("FROM realtime_external_effects WHERE claim_id")) {
      const row = [...this.effects.values()].find((candidate) => candidate.claim_id === params[0]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (q.startsWith("SELECT updated_at < now()")) {
      return { rows: [{ stalled: this.stalled.has(String(params[0])) }], rowCount: 1 };
    }
    if (q.startsWith("UPDATE realtime_external_effects SET effect_state = 'in_flight', claim_id")) {
      const row = this.effects.get(`${params[0]}\u0000${params[1]}`);
      assert.ok(row);
      assert.equal(row.effect_state, params[4]);
      assert.equal(row.claim_id, params[6]);
      row.effect_state = "in_flight";
      row.claim_id = params[2];
      row.fencing_epoch = params[3];
      row.stage_state = json(params[5]);
      row.result = null;
      row.result_sha256 = null;
      return { rows: [], rowCount: 1 };
    }
    if (q.includes("SET effect_state = 'committed'")) {
      const row = this.effects.get([...this.effects.keys()].find((key) => this.effects.get(key)?.effect_id === params[0]) ?? "");
      assert.ok(row);
      row.effect_state = "committed";
      row.result = json(params[1]);
      row.result_sha256 = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (q.includes("SET effect_state = 'released'")) {
      const row = [...this.effects.values()].find((candidate) => candidate.effect_id === params[0]);
      assert.ok(row);
      row.effect_state = "released";
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE realtime_external_effects SET stage_state")) {
      const row = [...this.effects.values()].find((candidate) => candidate.effect_id === params[0]);
      assert.ok(row);
      row.stage_state = json(params[1]);
      if (q.includes("suppression_result = $3::jsonb")) row.suppression_result = json(params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("INSERT INTO outbox_events")) {
      const row = {
        event_id: params[0], aggregate_type: params[1], aggregate_id: params[2], event_type: params[3], event_version: params[4],
        idempotency_scope: params[5], idempotency_key: params[6], payload: json(params[7]), payload_sha256: params[8],
        status: "pending", attempt_count: 0, claimed_by: null,
      };
      const key = `${params[5]}\u0000${params[6]}\u0000${params[3]}`;
      if (this.outbox.has(key)) return { rows: [], rowCount: 0 };
      this.outbox.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (q.includes("FROM outbox_events WHERE idempotency_scope")) {
      const key = `${params[0]}\u0000${params[1]}\u0000${params[2]}`;
      const row = this.outbox.get(key);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    throw new Error(`UNHANDLED_FAKE_QUERY: ${q}`);
  }

  release(): void {}
}

function fixture(): {
  readonly pool: { connect: () => Promise<FakeClient> };
  readonly client: FakeClient;
  readonly coordinator: RealtimeExternalEffectCoordinator;
  readonly calls: string[];
} {
  const client = new FakeClient();
  const calls: string[] = [];
  const pool = { connect: async () => client };
  const coordinator = new RealtimeExternalEffectCoordinator(pool as never, {
    executor: {
      async executeStage({ stage }) { calls.push(stage); },
      async suppressAndClose() { calls.push("suppressed"); return { old_device_output: "suppressed" }; },
    },
    claimId: (() => { let n = 0; return () => `claim-${++n}`; })(),
    eventId: (() => { let n = 0; return () => `33333333-3333-7333-8333-33333333333${n += 1}`; })(),
  });
  return { pool, client, coordinator, calls };
}

function intent(key: string, fingerprint = `fp-${key}`): RealtimeMediaStopIntent {
  return Object.freeze({
    wireRequest: { request_id: key, operation: "media_stop", idempotency_context: { idempotency_key: key } },
    request: {
      operation: "media_stop", idempotencyKey: key, expectedConnectionEpoch: "9007199254740993",
      expectedLeaseVersion: "9007199254740994", credentialGeneration: "9007199254740995",
      continuityId: `continuity-${key}`, realtimeSessionRef: SESSION, deviceLeaseRef: LEASE,
    },
    governance: { purpose: "conversation" },
    fingerprint,
  });
}

function fenceTuple(key: string): CredentialFenceTuple {
  return Object.freeze({
    realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE,
    continuityId: `continuity-${key}`,
    connectionEpoch: "9007199254740993",
    credentialGeneration: "9007199254740995",
  });
}

function intentWithoutBinding(key: string, fingerprint = `fp-${key}`): RealtimeMediaStopIntent {
  return Object.freeze({
    wireRequest: { request_id: key, operation: "media_stop", idempotency_context: { idempotency_key: key } },
    request: { operation: "media_stop" },
    governance: { purpose: "conversation" },
    fingerprint,
  });
}

test("media Stop claim, durable stages, commit, and same-key replay", async () => {
  const { coordinator, client, pool, calls } = fixture();
  const firstIntent = intent("stop-1");
  const context = { idempotency_key: "stop-1" };
  const claim = await coordinator.claim({ idempotencyContext: context, fingerprint: firstIntent.fingerprint, intent: firstIntent });
  assert.equal(claim.disposition, "claimed");
  if (claim.disposition !== "claimed") throw new Error("claim fixture failed");
  const claimedRow = [...client.effects.values()][0];
  assert.equal(claimedRow?.fencing_epoch, "1");
  assert.equal(claimedRow?.expected_connection_epoch, "9007199254740993");
  assert.deepEqual(claimedRow?.realtime_session_ref, SESSION);
  assert.equal(claimedRow?.credential_generation, "9007199254740995");
  assert.deepEqual(await coordinator.restore({ claimId: claim.claimId }), firstIntent);
  await coordinator.executeStage({ claimId: claim.claimId, stage: "tracks_unpublished", intent: firstIntent });
  await coordinator.executeStage({ claimId: claim.claimId, stage: "tracks_unpublished", intent: firstIntent });
  assert.deepEqual(calls, ["tracks_unpublished"]);
  await coordinator.commit({ claimId: claim.claimId, fingerprint: firstIntent.fingerprint, result: { status: "success" } });
  const replay = await coordinator.claim({ idempotencyContext: context, fingerprint: firstIntent.fingerprint, intent: firstIntent });
  assert.deepEqual(replay, { disposition: "replay", result: { status: "success" } });
  const fence = createRealtimeCredentialFence(pool as never);
  assert.equal((await fence.verify(fenceTuple("stop-1"))).active, true);
  await fence.close();
  await coordinator.close();
  await coordinator.close();
});

test("optional binding values are omitted and result/hash remain paired", async () => {
  const { coordinator, client, pool } = fixture();
  const stop = intentWithoutBinding("stop-optional");
  const context = { idempotency_key: "stop-optional" };
  const claim = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  assert.equal(claim.disposition, "claimed");
  if (claim.disposition !== "claimed") throw new Error("claim fixture failed");
  const row = [...client.effects.values()][0];
  assert.equal(row?.expected_connection_epoch, null);
  assert.equal(row?.expected_lease_version, null);
  assert.equal(row?.result, null);
  assert.equal(row?.result_sha256, null);
  await coordinator.commit({ claimId: claim.claimId, fingerprint: stop.fingerprint, result: { status: "success" } });
  assert.ok(row?.result);
  assert.equal(typeof row?.result_sha256, "string");
  assert.deepEqual(
    await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop }),
    { disposition: "replay", result: { status: "success" } },
  );
});

test("legacy media-stop without an owner-issued credential generation remains unfenced", async () => {
  const { coordinator, client } = fixture();
  const current = intent("stop-legacy-generation");
  const { credentialGeneration: _ignored, ...legacyRequest } = current.request as Record<string, unknown>;
  const legacy = Object.freeze({ ...current, request: legacyRequest });
  const claim = await coordinator.claim({
    idempotencyContext: { idempotency_key: "stop-legacy-generation" },
    fingerprint: legacy.fingerprint,
    intent: legacy,
  });
  assert.equal(claim.disposition, "claimed");
  const row = [...client.effects.values()][0];
  assert.equal(row?.realtime_session_ref, null);
  assert.equal(row?.credential_generation, null);
});

test("same-key fingerprint drift is rejected before a second effect row", async () => {
  const { coordinator, client } = fixture();
  const first = intent("stop-conflict", "fp-one");
  const second = intent("stop-conflict", "fp-two");
  await coordinator.claim({ idempotencyContext: { idempotency_key: "stop-conflict" }, fingerprint: first.fingerprint, intent: first });
  await assert.rejects(
    () => coordinator.claim({ idempotencyContext: { idempotency_key: "stop-conflict" }, fingerprint: second.fingerprint, intent: second }),
    (error: unknown) => error instanceof RealtimeExternalEffectError && error.code === "EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(client.effects.size, 1);
});

test("a retried stop keeps its first claim's tuple; a second stop on an active tuple is rejected", async () => {
  const { coordinator, client } = fixture();
  const first = intent("stop-fence-conflict", "fp-fence");
  await coordinator.claim({ idempotencyContext: { idempotency_key: "stop-fence-conflict" }, fingerprint: first.fingerprint, intent: first });
  // The same wire stop retried after its own release moved the lease derives a newer generation; its first claim governs.
  const changed = Object.freeze({
    ...first,
    request: { ...(first.request as Record<string, unknown>), credentialGeneration: "9007199254740996" },
  });
  assert.deepEqual(
    await coordinator.claim({ idempotencyContext: { idempotency_key: "stop-fence-conflict" }, fingerprint: first.fingerprint, intent: changed }),
    { disposition: "in_flight" },
  );
  assert.equal([...client.effects.values()][0]?.credential_generation, "9007199254740995");
  await assert.rejects(
    () => coordinator.claim({ idempotencyContext: { idempotency_key: "stop-fence-conflict" }, fingerprint: "fp-other", intent: changed }),
    (error: unknown) => error instanceof RealtimeExternalEffectError && error.code === "EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT",
  );
  const second = Object.freeze({
    ...intent("stop-fence-conflict-2", "fp-fence-2"),
    request: {
      ...(intent("stop-fence-conflict-2", "fp-fence-2").request as Record<string, unknown>),
      continuityId: "continuity-stop-fence-conflict",
    },
  });
  await assert.rejects(
    () => coordinator.claim({ idempotencyContext: { idempotency_key: "stop-fence-conflict-2" }, fingerprint: second.fingerprint, intent: second }),
    (error: unknown) => error instanceof RealtimeExternalEffectError && error.code === "EXTERNAL_EFFECT_CREDENTIAL_FENCE_CONFLICT",
  );
  assert.equal(client.effects.size, 1);
});

test("admission holds the tuple fence and only permits after release", async () => {
  const { coordinator, client, pool } = fixture();
  const stop = intent("stop-admission");
  const fence = createRealtimeCredentialFence(pool as never);
  await coordinator.claim({ idempotencyContext: { idempotency_key: "stop-admission" }, fingerprint: stop.fingerprint, intent: stop });
  await assert.rejects(
    () => fence.withAdmission(fenceTuple("stop-admission"), async () => "never"),
    (error: unknown) => error instanceof Error && error.message === "CREDENTIAL_FENCE_ACTIVE",
  );
  const claim = [...client.effects.values()][0]?.claim_id;
  assert.ok(claim);
  await coordinator.release({ claimId: String(claim), fingerprint: stop.fingerprint });
  assert.equal(await fence.withAdmission(fenceTuple("stop-admission"), async () => "admitted"), "admitted");
  await fence.close();
});

test("an indeterminate media stage is reconciled by re-executing it (cleanup is idempotent)", async () => {
  const { coordinator, calls } = fixture();
  const stop = intent("stop-indeterminate");
  const claim = await coordinator.claim({ idempotencyContext: { idempotency_key: "stop-indeterminate" }, fingerprint: stop.fingerprint, intent: stop });
  if (claim.disposition !== "claimed") throw new Error("claim fixture failed");
  await coordinator.reconcileStage({ claimId: claim.claimId, fingerprint: stop.fingerprint, stage: "participant_disconnected", outcome: "indeterminate" });
  await coordinator.executeStage({ claimId: claim.claimId, stage: "participant_disconnected", intent: stop });
  assert.deepEqual(calls, ["participant_disconnected"]);
});

test("a failed media stage returns to pending, so the attempt releases and a retry runs only what is unfinished", async () => {
  const base = fixture();
  const calls: string[] = [];
  let failing = true;
  const coordinator = new RealtimeExternalEffectCoordinator(base.pool as never, {
    executor: {
      async executeStage({ stage }) {
        calls.push(stage);
        if (failing && stage === "participant_disconnected") throw new Error("PROVIDER_UNREACHABLE");
      },
    },
    claimId: (() => { let n = 20; return () => `claim-${++n}`; })(),
    eventId: randomUUID,
  });
  const stop = intent("stop-failed-stage");
  const context = { idempotency_key: "stop-failed-stage" };
  const first = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (first.disposition !== "claimed") throw new Error("claim fixture failed");
  await coordinator.executeStage({ claimId: first.claimId, stage: "tracks_unpublished", intent: stop });
  await assert.rejects(() => coordinator.executeStage({ claimId: first.claimId, stage: "participant_disconnected", intent: stop }),
    /PROVIDER_UNREACHABLE/);
  assert.equal([...base.client.effects.values()][0]?.stage_state.participant_disconnected.state, "pending");
  await coordinator.release({ claimId: first.claimId, fingerprint: stop.fingerprint });
  failing = false;
  const retry = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (retry.disposition !== "claimed") throw new Error("retry must re-claim the released stop");
  for (const stage of ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"] as const) {
    await coordinator.executeStage({ claimId: retry.claimId, stage, intent: stop });
  }
  assert.deepEqual(calls, ["tracks_unpublished", "participant_disconnected", "participant_disconnected", "credential_revoked", "closure_verified"]);
});

test("a stalled media stop (its process died mid-stage) is taken over and the old claim is fenced", async () => {
  const { coordinator, client, calls } = fixture();
  const stop = intent("stop-stalled");
  const context = { idempotency_key: "stop-stalled" };
  const first = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (first.disposition !== "claimed") throw new Error("claim fixture failed");
  await coordinator.executeStage({ claimId: first.claimId, stage: "tracks_unpublished", intent: stop });
  await coordinator.reconcileStage({ claimId: first.claimId, fingerprint: stop.fingerprint, stage: "participant_disconnected", outcome: "indeterminate" });
  assert.deepEqual(await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop }),
    { disposition: "in_flight" }, "a live attempt is never taken over");
  const row = [...client.effects.values()][0]!;
  client.stalled.add(String(row.effect_id));
  const takeover = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (takeover.disposition !== "claimed") throw new Error("a stalled stop must be taken over");
  assert.notEqual(takeover.claimId, first.claimId);
  assert.equal(row.fencing_epoch, "2");
  assert.deepEqual(Object.keys(row.stage_state), ["tracks_unpublished"], "only completed evidence survives");
  await assert.rejects(() => coordinator.executeStage({ claimId: first.claimId, stage: "participant_disconnected", intent: stop }),
    /EXTERNAL_EFFECT_CLAIM_NOT_FOUND/);
  for (const stage of ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"] as const) {
    await coordinator.executeStage({ claimId: takeover.claimId, stage, intent: stop });
  }
  assert.deepEqual(calls, ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"]);
});

test("release leaves a durable fence that can be rearmed with the same idempotency key", async () => {
  const { coordinator, client } = fixture();
  const stop = intent("stop-release");
  const context = { idempotency_key: "stop-release" };
  const first = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (first.disposition !== "claimed") throw new Error("claim fixture failed");
  await coordinator.release({ claimId: first.claimId, fingerprint: stop.fingerprint });
  const second = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  assert.equal(second.disposition, "claimed");
  if (second.disposition !== "claimed") throw new Error("rearm fixture failed");
  assert.notEqual(second.claimId, first.claimId);
  assert.equal([...client.effects.values()][0]?.fencing_epoch, "2");
  assert.equal(client.effects.size, 1);
});

test("reclaim preserves completed cleanup evidence and never repeats completed stages", async () => {
  const { coordinator, calls } = fixture();
  const stop = intent("stop-completed-reclaim");
  const context = { idempotency_key: "stop-completed-reclaim" };
  const first = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (first.disposition !== "claimed") throw new Error("claim fixture failed");
  for (const stage of ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"] as const) {
    await coordinator.executeStage({ claimId: first.claimId, stage, intent: stop });
  }
  await coordinator.release({ claimId: first.claimId, fingerprint: stop.fingerprint });
  const second = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (second.disposition !== "claimed") throw new Error("reclaim fixture failed");
  for (const stage of ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"] as const) {
    await coordinator.executeStage({ claimId: second.claimId, stage, intent: stop });
  }
  assert.deepEqual(calls, ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"]);
});

test("reclaim runs only pending stages after completed evidence", async () => {
  const { coordinator, calls } = fixture();
  const stop = intent("stop-mixed-reclaim");
  const context = { idempotency_key: "stop-mixed-reclaim" };
  const first = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (first.disposition !== "claimed") throw new Error("claim fixture failed");
  await coordinator.executeStage({ claimId: first.claimId, stage: "tracks_unpublished", intent: stop });
  await coordinator.release({ claimId: first.claimId, fingerprint: stop.fingerprint });
  const second = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (second.disposition !== "claimed") throw new Error("reclaim fixture failed");
  await coordinator.executeStage({ claimId: second.claimId, stage: "tracks_unpublished", intent: stop });
  await coordinator.executeStage({ claimId: second.claimId, stage: "participant_disconnected", intent: stop });
  assert.deepEqual(calls, ["tracks_unpublished", "participant_disconnected"]);
});

test("indeterminate or in-flight cleanup cannot be released and replayed", async () => {
  const { coordinator } = fixture();
  const stop = intent("stop-fenced-reclaim");
  const context = { idempotency_key: "stop-fenced-reclaim" };
  const claim = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  if (claim.disposition !== "claimed") throw new Error("claim fixture failed");
  await coordinator.reconcileStage({ claimId: claim.claimId, fingerprint: stop.fingerprint, stage: "closure_verified", outcome: "indeterminate" });
  await assert.rejects(
    () => coordinator.release({ claimId: claim.claimId, fingerprint: stop.fingerprint }),
    /EXTERNAL_EFFECT_STAGE_INDETERMINATE/,
  );
  const stillInFlight = await coordinator.claim({ idempotencyContext: context, fingerprint: stop.fingerprint, intent: stop });
  assert.deepEqual(stillInFlight, { disposition: "in_flight" });

  let started = false;
  let finish: (() => void) | undefined;
  const pendingFixture = fixture();
  const pendingCoordinator = new RealtimeExternalEffectCoordinator(pendingFixture.pool as never, {
    executor: {
      async executeStage() {
        started = true;
        await new Promise<void>((resolve) => { finish = resolve; });
      },
    },
    claimId: (() => { let n = 10; return () => `claim-${++n}`; })(),
    eventId: randomUUID,
  });
  const pendingStop = intent("stop-in-flight");
  const pendingClaim = await pendingCoordinator.claim({ idempotencyContext: { idempotency_key: "stop-in-flight" }, fingerprint: pendingStop.fingerprint, intent: pendingStop });
  if (pendingClaim.disposition !== "claimed") throw new Error("in-flight claim fixture failed");
  const execution = pendingCoordinator.executeStage({ claimId: pendingClaim.claimId, stage: "participant_disconnected", intent: pendingStop });
  while (!started) await new Promise<void>((resolve) => queueMicrotask(resolve));
  await assert.rejects(
    () => pendingCoordinator.release({ claimId: pendingClaim.claimId, fingerprint: pendingStop.fingerprint }),
    /EXTERNAL_EFFECT_STAGE_INDETERMINATE/,
  );
  assert.deepEqual(
    await pendingCoordinator.claim({ idempotencyContext: { idempotency_key: "stop-in-flight" }, fingerprint: pendingStop.fingerprint, intent: pendingStop }),
    { disposition: "in_flight" },
  );
  finish?.();
  await execution;
});

test("handoff suppression is fenced before commit and is replayable", async () => {
  const { coordinator, calls } = fixture();
  const request = Object.freeze({ operation: "handoff", idempotencyKey: "handoff-1", expectedConnectionEpoch: "17" });
  const fingerprint = "handoff-fingerprint";
  const claim = await coordinator.claim({ idempotencyContext: { idempotency_key: "handoff-1" }, fingerprint, request, wireRequest: request });
  assert.equal(claim.disposition, "claimed");
  if (claim.disposition !== "claimed") throw new Error("claim fixture failed");
  const suppression = await coordinator.suppressAndClose({ request, fingerprint, authorityResult: { lease: "changed" } });
  assert.deepEqual(suppression, { old_device_output: "suppressed" });
  assert.deepEqual(calls, ["suppressed"]);
  await coordinator.commit({ claimId: claim.claimId, fingerprint, result: { status: "success", suppression } });
  const replay = await coordinator.claim({ idempotencyContext: { idempotency_key: "handoff-1" }, fingerprint, request, wireRequest: request });
  assert.deepEqual(replay, { disposition: "replay", result: { status: "success", suppression: { old_device_output: "suppressed" } } });
});
