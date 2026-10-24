import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import type { LeasePolicyDecision, RealtimeIdentityPort } from "../../realtime-core/src/ports.ts";
import type { OpaqueCanonicalRef } from "../../realtime-core/src/types.ts";
import { createProductionRealtimeCanonicalDeviceIdentityIssuer } from "../src/realtime-canonical-device-issuer.ts";
import {
  createRayneoDemoCurrentBindingPostgresProvider,
  RayneoDemoCurrentBindingPostgresError,
  type RayneoDemoCurrentBindingInput,
  type RayneoDemoLeasePolicyForOwner,
  type RayneoDemoOwnerProjection,
} from "../src/rayneo-demo-current-binding-postgres.ts";

const EXTERNAL_SESSION = "phase0_session_aaaaaaaaaaaaaaaaaaaa";
const EXTERNAL_DEVICE = "rayneo_device_bbbbbbbbbbbbbbbbbbbb";
const EXTERNAL_CLIENT = "rayneo_client_cccccccccccccccccccc";
const USER_ID = "01952f00-0000-7000-8000-000000000901";
const CONTINUITY_ID = "01952f00-0000-7000-8000-000000000903";
const SESSION_ID = "01952f00-0000-7000-8000-000000000904";
const LEASE_ID = "01952f00-0000-7000-8000-000000000905";
const SESSION_HASH = "a".repeat(64);
const LEASE_HASH = "b".repeat(64);
const ELIGIBILITY_AT = "2026-08-28T10:00:00.000Z";
const OBSERVED_AT = "2026-08-28T10:01:00.000Z";
const LATER_AT = "2026-08-28T10:02:00.000Z";
const SESSION_EXPIRES = "2026-08-28T11:00:00.000Z";
const CLEANUP_DEADLINE = "2026-08-28T11:00:05.000Z";
const LEASE_EXPIRES = "2026-08-28T10:55:00.000Z";
const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession", ref_id: SESSION_ID, object_version: "1", canonical_payload_sha256: SESSION_HASH,
});
const LEASE_REF = Object.freeze({
  ref_type: "DeviceLease", ref_id: LEASE_ID, object_version: "1", canonical_payload_sha256: LEASE_HASH,
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value: unknown): string {
  return hashText(canonical(value));
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function result(rows: readonly QueryResultRow[] = [], command = "SELECT", rowCount = rows.length): QueryResult {
  return { command, rowCount, oid: 0, fields: [], rows: [...rows] } as QueryResult;
}

interface DatabaseState {
  session?: QueryResultRow;
  lease?: QueryResultRow;
  readonly aliases: Record<string, QueryResultRow>;
  ledger?: QueryResultRow;
  outbox?: QueryResultRow;
  terminal?: QueryResultRow;
  activeSessionCount: number;
  activeLeaseCount: number;
}

class ScriptedClient {
  readonly queries: string[] = [];
  readonly state: DatabaseState = { aliases: {}, activeSessionCount: 0, activeLeaseCount: 0 };
  released = 0;
  writeStatements = 0;

  private currentBindingRow(): QueryResultRow {
    const session = this.state.session!;
    const lease = this.state.lease!;
    return {
      s_session_ref_id: session.session_ref_id,
      s_realtime_session_ref: session.realtime_session_ref,
      s_session_object_version: session.session_object_version,
      s_session_payload_sha256: session.session_payload_sha256,
      s_continuity_ref: null,
      s_user_id: session.user_id,
      s_continuity_id: session.continuity_id,
      s_state: session.state,
      s_continuity_state: session.continuity_state,
      s_connection_epoch: session.connection_epoch,
      s_continuity_expires_at: session.continuity_expires_at,
      s_last_accepted_activity_at: session.last_accepted_activity_at,
      s_active_device_id: session.active_device_id,
      s_active_device_lease_ref: session.active_device_lease_ref,
      s_binding: session.binding,
      s_revision: session.revision,
      s_updated_at: session.updated_at,
      l_lease_ref_id: lease.lease_ref_id,
      l_device_lease_ref: lease.device_lease_ref,
      l_lease_object_version: lease.lease_object_version,
      l_lease_payload_sha256: lease.lease_payload_sha256,
      l_realtime_session_ref: lease.realtime_session_ref,
      l_continuity_ref: null,
      l_session_ref_id: lease.session_ref_id,
      l_continuity_id: lease.continuity_id,
      l_user_id: lease.user_id,
      l_device_id: lease.device_id,
      l_state: lease.state,
      l_capabilities: lease.capabilities,
      l_purpose: lease.purpose,
      l_issued_at: lease.issued_at,
      l_expires_at: lease.expires_at,
      l_revocable: lease.revocable,
      l_lease_version: lease.lease_version,
      l_fencing_token: lease.fencing_token,
      l_policy_decision_ref: lease.policy_decision_ref,
    };
  }

  async query(query: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const sql = query.replace(/\s+/gu, " ").trim();
    this.queries.push(sql);
    if (sql === "BEGIN" || sql.startsWith("SET TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") {
      return result([], sql.split(" ")[0]);
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return result([{ pg_advisory_xact_lock: null }]);
    if (/^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/u.test(sql)) this.writeStatements += 1;
    if (sql.includes("FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2 FOR UPDATE")) {
      return result(this.state.ledger === undefined ? [] : [{
        request_hash: this.state.ledger.request_hash,
        request_fingerprint: this.state.ledger.request_fingerprint,
        response: this.state.ledger.response,
        response_hash: this.state.ledger.response_hash,
        status: this.state.ledger.status,
      }]);
    }
    if (sql.startsWith("SELECT revision, connection_epoch, realtime_session_ref")) {
      return result(this.state.session === undefined ? [] : [{
        revision: this.state.session.revision,
        connection_epoch: this.state.session.connection_epoch,
        realtime_session_ref: this.state.session.realtime_session_ref,
        session_object_version: this.state.session.session_object_version,
        session_payload_sha256: this.state.session.session_payload_sha256,
      }]);
    }
    if (sql.startsWith("INSERT INTO realtime_sessions")) {
      this.state.session = {
        session_ref_id: values[0], realtime_session_ref: parseJson(values[1]), session_object_version: values[2],
        session_payload_sha256: values[3], user_id: values[4], continuity_id: values[5], continuity_state: values[7],
        active_device_lease_ref: parseJson(values[8]), active_device_id: values[9], binding: parseJson(values[10]),
        state: values[11], connection_epoch: values[12], last_accepted_activity_at: values[13],
        continuity_expires_at: values[14], revision: values[17], updated_at: ELIGIBILITY_AT,
      };
      this.state.activeSessionCount = 1;
      return result([], "INSERT", 1);
    }
    if (sql.startsWith("SELECT user_id, continuity_id, realtime_session_ref")) {
      const session = this.state.session;
      return result(session === undefined ? [] : [{
        user_id: session.user_id, continuity_id: session.continuity_id, realtime_session_ref: session.realtime_session_ref,
        session_object_version: session.session_object_version, session_payload_sha256: session.session_payload_sha256,
      }]);
    }
    if (sql.startsWith("SELECT session_ref_id, user_id, device_id, continuity_id, lease_version")) {
      const lease = this.state.lease;
      return result(lease === undefined ? [] : [{ ...lease }]);
    }
    if (sql.startsWith("INSERT INTO device_leases")) {
      this.state.lease = {
        lease_ref_id: values[0], device_lease_ref: parseJson(values[1]), lease_object_version: values[2],
        lease_payload_sha256: values[3], session_ref_id: values[4], realtime_session_ref: parseJson(values[5]),
        user_id: values[7], device_id: values[8], continuity_id: values[9], capabilities: parseJson(values[10]),
        purpose: values[11], policy_decision_ref: parseJson(values[12]), revocable: values[13], state: values[14],
        lease_version: values[15], fencing_token: values[16], issued_at: values[17], acquired_at: values[18],
        expires_at: values[19], updated_at: ELIGIBILITY_AT,
      };
      this.state.activeLeaseCount = 1;
      return result([], "INSERT", 1);
    }
    if (sql.startsWith("SELECT connection_epoch, realtime_session_ref") && sql.includes("FROM realtime_sessions")) {
      const session = this.state.session;
      return result(session === undefined ? [] : [{
        connection_epoch: session.connection_epoch, realtime_session_ref: session.realtime_session_ref,
        session_object_version: session.session_object_version, session_payload_sha256: session.session_payload_sha256,
        continuity_id: session.continuity_id, user_id: session.user_id, active_device_id: session.active_device_id,
        active_device_lease_ref: session.active_device_lease_ref, state: session.state,
        continuity_state: session.continuity_state,
      }]);
    }
    if (sql.startsWith("SELECT session_ref_id, user_id, device_id, continuity_id, state, device_lease_ref")) {
      return result(this.state.lease === undefined ? [] : [{ ...this.state.lease }]);
    }
    if (sql.startsWith("UPDATE realtime_sessions SET binding")) {
      this.state.session!.binding = parseJson(values[1]);
      this.state.session!.connection_epoch = values[2];
      this.state.session!.active_device_id = values[3];
      this.state.session!.active_device_lease_ref = parseJson(values[4]);
      return result([], "UPDATE", 1);
    }
    if (sql.startsWith("UPDATE realtime_transport_aliases")) return result([], "UPDATE", 0);
    if (sql.startsWith("INSERT INTO realtime_transport_aliases")) {
      const kind = String(values[3]);
      this.state.aliases[kind] = { alias_kind: kind, alias_value: values[4], active: true, retired_at: null };
      return result([], "INSERT", 1);
    }
    if (sql.startsWith("INSERT INTO outbox_events")) {
      this.state.outbox = {
        event_id: values[0], aggregate_type: values[1], aggregate_id: values[2], aggregate_ref: parseJson(values[3]),
        event_type: values[4], event_version: 1, idempotency_scope: "realtime.outbox", idempotency_key: values[5],
        payload: parseJson(values[6]), payload_sha256: values[7], status: "pending",
      };
      return result([{ event_id: values[0] }], "INSERT", 1);
    }
    if (sql.startsWith("SELECT event_id, aggregate_type") && sql.includes("FROM outbox_events")) {
      return result(this.state.outbox === undefined ? [] : [{ ...this.state.outbox }]);
    }
    if (sql.startsWith("INSERT INTO idempotency_ledger")) {
      this.state.ledger = {
        scope: values[0], idempotency_key: values[1], request_hash: values[2], request_fingerprint: values[3],
        status: "committed", response: parseJson(values[4]), response_hash: values[5],
      };
      return result([], "INSERT", 1);
    }
    if (sql.startsWith("SELECT request_fingerprint FROM idempotency_ledger")) {
      return result(this.state.ledger === undefined ? [] : [{ request_fingerprint: this.state.ledger.request_fingerprint }]);
    }
    if (sql.startsWith("INSERT INTO realtime_terminal_facts")) {
      this.state.terminal = {
        terminal_fact_id: values[0], operation: values[1], status: values[2], request_scope: values[3],
        idempotency_key: values[4], request_hash: values[5], session_ref_id: values[6], lease_ref_id: values[7],
        continuity_id: values[8], connection_epoch: values[9], realtime_session_ref: parseJson(values[10]),
        device_lease_ref: parseJson(values[11]), operation_outcome: parseJson(values[13]),
        execution_facts: parseJson(values[14]), created_at: values[15],
      };
      return result([{ terminal_fact_id: values[0] }], "INSERT", 1);
    }
    if (sql === "SELECT s.session_ref_id FROM realtime_sessions AS s WHERE s.session_ref_id = $1 FOR UPDATE") {
      const session = this.state.session;
      return result(session === undefined || session.session_ref_id !== values[0] ? [] : [{session_ref_id:session.session_ref_id}]);
    }
    if (sql.includes("FROM realtime_sessions AS s") && sql.includes("LEFT JOIN device_leases AS l")) {
      return result(this.state.session === undefined || this.state.lease === undefined ? [] : [this.currentBindingRow()]);
    }
    if (sql.includes("AS terminal_fact") && sql.includes("AS active_leases")) {
      return result([{
        sessions: this.state.session === undefined ? 0 : 1,
        leases: this.state.lease === undefined ? 0 : 1,
        aliases: Object.keys(this.state.aliases).length,
        ledger: this.state.ledger === undefined ? 0 : 1,
        outbox: this.state.outbox === undefined ? 0 : 1,
        terminal_fact: this.state.terminal === undefined ? 0 : 1,
        active_sessions: this.state.activeSessionCount,
        active_leases: this.state.activeLeaseCount,
      }]);
    }
    if (sql.startsWith("SELECT alias_kind,alias_value,active,retired_at")) {
      return result(Object.values(this.state.aliases).sort((a, b) => String(a.alias_kind).localeCompare(String(b.alias_kind))));
    }
    if (sql.startsWith("SELECT request_hash,request_fingerprint,status,response,response_hash")) {
      return result(this.state.ledger === undefined ? [] : [{ ...this.state.ledger }]);
    }
    if (sql.startsWith("SELECT event_id::text,aggregate_type")) {
      return result(this.state.outbox === undefined ? [] : [{ ...this.state.outbox }]);
    }
    if (sql.startsWith("SELECT operation,status,request_scope")) {
      return result(this.state.terminal === undefined ? [] : [{ ...this.state.terminal }]);
    }
    if (sql.startsWith("SELECT s.revision::text")) {
      return result(this.state.session === undefined || this.state.lease === undefined ? [] : [{
        revision: String(this.state.session.revision), connection_epoch: String(this.state.session.connection_epoch),
        lease_version: String(this.state.lease.lease_version), fencing_token: String(this.state.lease.fencing_token),
        purpose: this.state.lease.purpose, capabilities: this.state.lease.capabilities,
        policy_decision_ref: this.state.lease.policy_decision_ref,
      }]);
    }
    throw new Error(`UNSCRIPTED_SQL:${sql}`);
  }

  release(): void { this.released += 1; }
}

class BorrowedPool {
  readonly client = new ScriptedClient();
  connects = 0;
  endCalled = false;

  async connect(): Promise<PoolClient> {
    this.connects += 1;
    return this.client as unknown as PoolClient;
  }

  async end(): Promise<void> { this.endCalled = true; }
}

interface Harness {
  readonly pool: BorrowedPool;
  readonly identityCalls: { device: number; continuity: number; session: number; lease: number; asserts: number };
  readonly policyCalls: { count: number };
  readonly policyFactoryCalls: { count: number };
  readonly policyProjections: RayneoDemoOwnerProjection[];
  ownerFactory: (input: RayneoDemoCurrentBindingInput) => RayneoDemoOwnerProjection | undefined;
  policyFactory: () => LeasePolicyDecision;
  leasePolicyFactory: RayneoDemoLeasePolicyForOwner;
  provider(): ReturnType<typeof createRayneoDemoCurrentBindingPostgresProvider>;
}

function ownerProjection(input: RayneoDemoCurrentBindingInput, overrides: Record<string, unknown> = {}): RayneoDemoOwnerProjection {
  return {
    stable: {
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      clientInstanceId: input.clientInstanceId,
      userId: USER_ID,
      purpose: "rayneo-demo",
      governance: { owner: "production" },
      requestedCapabilities: ["realtime.audio"],
      eligibilityObservedAt: ELIGIBILITY_AT,
      sessionExpiresAt: SESSION_EXPIRES,
      cleanupDeadlineAt: CLEANUP_DEADLINE,
      leaseExpiresAt: LEASE_EXPIRES,
      connectionId: "livekit-connection-901",
      ownerConnectionEpoch: "0",
      activeDeviceLeaseVersion: "3",
      providerAlias: "livekit",
      livekitSessionAlias: "livekit-session-901",
      livekitRoomAlias: "livekit-room-901",
      livekitParticipantAlias: "livekit-participant-901",
      ...overrides,
    },
    resolution: { observedAt: input.observedAt },
  } as RayneoDemoOwnerProjection;
}

function harness(): Harness {
  const pool = new BorrowedPool();
  const identityCalls = { device: 0, continuity: 0, session: 0, lease: 0, asserts: 0 };
  const policyCalls = { count: 0 };
  const policyFactoryCalls = { count: 0 };
  const policyProjections: RayneoDemoOwnerProjection[] = [];
  const deviceIssuer = createProductionRealtimeCanonicalDeviceIdentityIssuer();
  const value: Harness = {
    pool,
    identityCalls,
    policyCalls,
    policyFactoryCalls,
    policyProjections,
    ownerFactory: (input) => ownerProjection(input),
    policyFactory: () => ({
      allowed: true,
      policyDecisionRef: { ref: "policy-901" },
      capabilities: ["realtime.audio"],
      purpose: "rayneo-demo",
      leaseExpiresAt: LEASE_EXPIRES as LeasePolicyDecision["leaseExpiresAt"],
      revocable: true,
    }),
    leasePolicyFactory(projection) {
      policyFactoryCalls.count += 1;
      policyProjections.push(projection);
      return Object.freeze({ async evaluate() { policyCalls.count += 1; return value.policyFactory(); } });
    },
    provider() {
      const identity: RealtimeIdentityPort = {
        createContinuityId() { identityCalls.continuity += 1; return CONTINUITY_ID; },
        assertRepositoryIssuedRef(value, kind) {
          identityCalls.asserts += 1;
          assert.equal((value as Record<string, unknown>).ref_type, kind);
        },
        createSessionRef() { identityCalls.session += 1; return SESSION_REF; },
        createDeviceLeaseRef() { identityCalls.lease += 1; return LEASE_REF; },
        createTransportAlias() { throw new Error("ALIAS_GUESS_FORBIDDEN"); },
        createConnectionId() { throw new Error("CONNECTION_GUESS_FORBIDDEN"); },
      };
      return createRayneoDemoCurrentBindingPostgresProvider({
        pool: pool as unknown as Pool,
        ownerIdentity: { async resolve(input) { return value.ownerFactory(input); } },
        canonicalDeviceIssuer: {
          issue(input) { identityCalls.device += 1; return deviceIssuer.issue(input); },
        },
        identity,
        leasePolicyForOwner: (projection) => value.leasePolicyFactory(projection),
      });
    },
  };
  return value;
}

const initialInput = (): RayneoDemoCurrentBindingInput => ({
  sessionId: EXTERNAL_SESSION,
  deviceId: EXTERNAL_DEVICE,
  clientInstanceId: EXTERNAL_CLIENT,
  observedAt: OBSERVED_AT,
});

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof RayneoDemoCurrentBindingPostgresError && error.code === code);
}

test("initial commit and later-observedAt same-process and fresh-provider replay remain exactly once", async () => {
  const h = harness();
  const first = await h.provider().resolve(initialInput());
  assert.equal(first?.kind, "committed");
  assert.match(first!.canonicalDeviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(first?.ownerConnectionEpoch, "0");
  assert.equal(first?.persistedConnectionEpoch, "1");
  assert.deepEqual(h.identityCalls, { device: 1, continuity: 1, session: 1, lease: 1, asserts: 2 });
  assert.deepEqual([
    h.pool.client.state.session === undefined ? 0 : 1,
    h.pool.client.state.lease === undefined ? 0 : 1,
    Object.keys(h.pool.client.state.aliases).length,
    h.pool.client.state.ledger === undefined ? 0 : 1,
    h.pool.client.state.outbox === undefined ? 0 : 1,
    h.pool.client.state.terminal === undefined ? 0 : 1,
  ], [1, 1, 4, 1, 1, 1]);
  const writes = h.pool.client.writeStatements;
  const identity = { ...h.identityCalls };
  const second = await h.provider().resolve({ ...initialInput(), observedAt: LATER_AT });
  assert.equal(second?.kind, "replayed");
  assert.equal(second?.observedAt, LATER_AT);
  assert.deepEqual(second?.binding, first?.binding);
  assert.equal(h.pool.client.writeStatements, writes);
  assert.deepEqual(h.identityCalls, identity);
  assert.equal(h.policyCalls.count, 2);
  assert.equal(h.policyFactoryCalls.count, 2);
  assert.equal(h.policyProjections.length, 2);
  for (const projection of h.policyProjections) {
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.stable), true);
    assert.equal(Object.isFrozen(projection.resolution), true);
    assert.equal(Object.isFrozen(projection.stable.governance as object), true);
    assert.equal(Object.isFrozen(projection.stable.requestedCapabilities), true);
  }
  assert.equal(h.pool.endCalled, false);
  const rr = h.pool.client.queries.lastIndexOf("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(rr >= 0);
  const verification = h.pool.client.queries.slice(rr, h.pool.client.queries.indexOf("COMMIT", rr) + 1).join(" ");
  assert.doesNotMatch(verification, /FOR SHARE|FOR UPDATE/u);
  assert.doesNotMatch(verification, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/u);
});

test("owner projection is lazy and missing owner touches no Pool, identity or policy", async () => {
  const h = harness();
  h.ownerFactory = () => undefined;
  const provider = h.provider();
  assert.equal(h.pool.connects, 0);
  assert.equal(await provider.resolve(initialInput()), undefined);
  assert.equal(h.pool.connects, 0);
  assert.deepEqual(h.identityCalls, { device: 0, continuity: 0, session: 0, lease: 0, asserts: 0 });
  assert.equal(h.policyCalls.count, 0);
  assert.equal(h.policyFactoryCalls.count, 0);
});

test("scoped policy factory receives one deep-frozen snapshot and failures precede Pool and identity", async () => {
  for (const [factory, code] of [
    [(() => { throw new Error("factory failed"); }) as RayneoDemoLeasePolicyForOwner,
      "RAYNEO_DEMO_LEASE_POLICY_FACTORY_FAILED"],
    [(() => ({})) as unknown as RayneoDemoLeasePolicyForOwner,
      "RAYNEO_DEMO_LEASE_POLICY_PORT_INVALID"],
    [(() => Promise.resolve({ async evaluate() { throw new Error("unused"); } })) as unknown as RayneoDemoLeasePolicyForOwner,
      "RAYNEO_DEMO_LEASE_POLICY_PORT_INVALID"],
    [(() => Object.freeze({ async evaluate() { throw new Error("policy failed"); } })) as RayneoDemoLeasePolicyForOwner,
      "RAYNEO_DEMO_POLICY_RESOLUTION_FAILED"],
  ] as const) {
    const h = harness();
    h.leasePolicyFactory = factory;
    await rejectsCode(h.provider().resolve(initialInput()), code);
    assert.equal(h.pool.connects, 0);
    assert.deepEqual(h.identityCalls, { device: 0, continuity: 0, session: 0, lease: 0, asserts: 0 });
  }

  const mutation = harness();
  let mutationBlocked = false;
  let received: RayneoDemoOwnerProjection | undefined;
  mutation.leasePolicyFactory = (projection) => {
    received = projection;
    const attempted = Promise.resolve().then(() => {
      try {
        (projection.stable.governance as Record<string, unknown>).owner = "mutated";
      } catch {
        mutationBlocked = true;
      }
    });
    return Object.freeze({
      async evaluate() {
        await attempted;
        mutation.policyCalls.count += 1;
        return mutation.policyFactory();
      },
    });
  };
  await mutation.provider().resolve(initialInput());
  assert.equal(mutationBlocked, true);
  assert.equal(received?.stable.governance && (received.stable.governance as Record<string, unknown>).owner, "production");
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received?.stable.governance as object), true);
});

test("concurrent different owner projections receive isolated scoped policy ports", async () => {
  const first = harness();
  const second = harness();
  const secondInput = { ...initialInput(), sessionId: "phase0_session_dddddddddddddddddddd" };
  second.ownerFactory = (input) => ownerProjection(input, {
    purpose: "rayneo-demo-secondary",
    leaseExpiresAt: "2026-08-28T10:54:00.000Z",
  });
  const received: RayneoDemoOwnerProjection[] = [];
  const scoped: RayneoDemoLeasePolicyForOwner = (projection) => {
    received.push(projection);
    const purpose = projection.stable.purpose;
    const leaseExpiresAt = projection.stable.leaseExpiresAt;
    const scope = projection.stable.sessionId;
    return Object.freeze({
      async evaluate() {
        await Promise.resolve();
        return {
          allowed: true as const,
          policyDecisionRef: { scope },
          capabilities: ["realtime.audio"] as const,
          purpose,
          leaseExpiresAt: leaseExpiresAt as LeasePolicyDecision["leaseExpiresAt"],
          revocable: true as const,
        };
      },
    });
  };
  first.leasePolicyFactory = scoped;
  second.leasePolicyFactory = scoped;
  const [left, right] = await Promise.all([
    first.provider().resolve(initialInput()),
    second.provider().resolve(secondInput),
  ]);
  assert.equal(left?.purpose, "rayneo-demo");
  assert.equal(right?.purpose, "rayneo-demo-secondary");
  assert.equal(received.length, 2);
  assert.notStrictEqual(received[0], received[1]);
  assert.notEqual(received[0]!.stable.sessionId, received[1]!.stable.sessionId);
  assert.notDeepEqual(left?.lease.policyDecisionRef, right?.lease.policyDecisionRef);
});

test("per-call observedAt is excluded while stable owner, alias and eligible-version drift conflict", async () => {
  const h = harness();
  const provider = h.provider();
  await provider.resolve(initialInput());
  const fingerprint = h.pool.client.state.ledger!.request_fingerprint;
  await provider.resolve({ ...initialInput(), observedAt: LATER_AT });
  assert.equal(h.pool.client.state.ledger!.request_fingerprint, fingerprint);
  for (const [overrides, code] of [
    [{ purpose: "different-purpose" }, "RAYNEO_DEMO_POLICY_DRIFT"],
    [{ livekitRoomAlias: "different-room" }, "RAYNEO_DEMO_IDEMPOTENCY_CONFLICT"],
    [{ activeDeviceLeaseVersion: "4" }, "RAYNEO_DEMO_IDEMPOTENCY_CONFLICT"],
    [{ ownerConnectionEpoch: "1" }, "RAYNEO_DEMO_REPLAY_EPOCH_DRIFT"],
    [{ eligibilityObservedAt: "2026-08-28T10:00:01.000Z" }, "RAYNEO_DEMO_CANONICAL_DEVICE_RECEIPT_DRIFT"],
  ] as const) {
    h.ownerFactory = (input) => ownerProjection(input, overrides);
    await rejectsCode(provider.resolve({ ...initialInput(), observedAt: LATER_AT }), code);
  }
});

test("time, echo, version and alias invalidity fail before PG writes", async () => {
  for (const [overrides, input, code] of [
    [{ activeDeviceLeaseVersion: "0" }, initialInput(), "RAYNEO_DEMO_OWNER_LEASE_VERSION_INVALID"],
    [{ ownerConnectionEpoch: "-1" }, initialInput(), "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
    [{ livekitRoomAlias: "" }, initialInput(), "RAYNEO_DEMO_ROOM_ALIAS_INVALID"],
    [{}, { ...initialInput(), observedAt: "2026-08-28T09:59:59.000Z" }, "RAYNEO_DEMO_OBSERVED_AT_STALE"],
    [{}, { ...initialInput(), observedAt: SESSION_EXPIRES }, "RAYNEO_DEMO_BINDING_EXPIRED"],
    [{ cleanupDeadlineAt: "2026-08-28T10:59:59.000Z" }, initialInput(), "RAYNEO_DEMO_EXPIRY_ORDER_INVALID"],
  ] as const) {
    const h = harness();
    h.ownerFactory = (value) => ownerProjection(value, overrides);
    await rejectsCode(h.provider().resolve(input), code);
    assert.equal(h.pool.client.writeStatements, 0);
  }
  const echo = harness();
  echo.ownerFactory = (input) => ({ ...ownerProjection(input), resolution: { observedAt: LATER_AT } });
  await rejectsCode(echo.provider().resolve(initialInput()), "RAYNEO_DEMO_OWNER_ECHO_DRIFT");
  assert.equal(echo.pool.connects, 0);
});

test("multiple positive owner lease versions are accepted without changing PG fencing counters", async () => {
  const h = harness();
  h.ownerFactory = (input) => ownerProjection(input, { activeDeviceLeaseVersion: "27" });
  const resolved = await h.provider().resolve(initialInput());
  assert.equal(resolved?.ownerActiveDeviceLeaseVersion, "27");
  assert.equal(h.pool.client.state.lease?.lease_version, "1");
  assert.equal(h.pool.client.state.lease?.fencing_token, "1");
});

test("zero-based owner epoch maps exactly through BigInt NUMERIC(38,0) boundaries", async () => {
  for (const [raw, persisted] of [
    ["0", "1"],
    ["9007199254740992", "9007199254740993"],
    ["99999999999999999999999999999999999998", "99999999999999999999999999999999999999"],
  ] as const) {
    const h = harness();
    h.ownerFactory = (input) => ownerProjection(input, { ownerConnectionEpoch: raw });
    const projection = await h.provider().resolve(initialInput());
    assert.equal(projection?.ownerConnectionEpoch, raw);
    assert.equal(projection?.persistedConnectionEpoch, persisted);
    assert.equal(projection?.binding.connectionEpoch, persisted);
  }
  for (const [raw, code] of [
    ["99999999999999999999999999999999999999", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_OVERFLOW"],
    ["100000000000000000000000000000000000000", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
    ["01", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
    ["1.0", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
    ["1e2", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
    ["+1", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
    [" 1", "RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID"],
  ] as const) {
    const h = harness();
    h.ownerFactory = (input) => ownerProjection(input, { ownerConnectionEpoch: raw });
    await rejectsCode(h.provider().resolve(initialInput()), code);
    assert.equal(h.pool.connects, 0);
  }
});

test("policy and identity validation remain fail closed", async () => {
  const policy = harness();
  const validPolicy = policy.policyFactory();
  policy.policyFactory = () => ({ ...validPolicy, leaseExpiresAt: SESSION_EXPIRES as LeasePolicyDecision["leaseExpiresAt"] });
  await rejectsCode(policy.provider().resolve(initialInput()), "RAYNEO_DEMO_POLICY_DRIFT");
  assert.equal(policy.pool.client.writeStatements, 0);

  const ref = harness();
  const provider = ref.provider();
  await provider.resolve(initialInput());
  (ref.pool.client.state.session!.realtime_session_ref as Record<string, unknown>).canonical_payload_sha256 = "c".repeat(64);
  await assert.rejects(provider.resolve({ ...initialInput(), observedAt: LATER_AT }));
});

test("idempotency, outbox, fencing and duplicate authority drift fail closed", async () => {
  for (const mutate of [
    (h: Harness) => { h.pool.client.state.ledger!.request_fingerprint = "d".repeat(64); },
    (h: Harness) => {
      const response = h.pool.client.state.ledger!.response as Record<string, unknown>;
      const demo = response.rayneoDemo as Record<string, unknown>;
      const identity = demo.canonicalDeviceIdentity as Record<string, unknown>;
      identity.canonicalPayloadSha256 = "d".repeat(64);
    },
    (h: Harness) => {
      const response = h.pool.client.state.ledger!.response as Record<string, unknown>;
      (response.rayneoDemo as Record<string, unknown>).persistedConnectionEpoch = "2";
    },
    (h: Harness) => { h.pool.client.state.outbox!.payload_sha256 = "d".repeat(64); },
    (h: Harness) => { h.pool.client.state.session!.connection_epoch = "2"; },
    (h: Harness) => { h.pool.client.state.terminal!.connection_epoch = "2"; },
    (h: Harness) => { h.pool.client.state.lease!.fencing_token = "2"; },
    (h: Harness) => { h.pool.client.state.activeLeaseCount = 2; },
  ]) {
    const h = harness();
    const provider = h.provider();
    await provider.resolve(initialInput());
    mutate(h);
    await assert.rejects(provider.resolve({ ...initialInput(), observedAt: LATER_AT }));
  }
});

test("closed nonplain and accessor inputs fail closed without Pool access", async () => {
  const h = harness();
  const extra = { ...initialInput(), extra: true };
  await rejectsCode(h.provider().resolve(extra as unknown as RayneoDemoCurrentBindingInput), "RAYNEO_DEMO_INPUT_INVALID");
  const accessor = { ...initialInput() } as Record<string, unknown>;
  Object.defineProperty(accessor, "sessionId", { enumerable: true, get: () => EXTERNAL_SESSION });
  await rejectsCode(h.provider().resolve(accessor as unknown as RayneoDemoCurrentBindingInput), "RAYNEO_DEMO_INPUT_INVALID");
  assert.equal(h.pool.connects, 0);
});
