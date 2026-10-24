import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import type { Pool, PoolClient, QueryResult } from "pg";

import type { RealtimeIdentityPort } from "../../realtime-core/src/ports.ts";
import type { OpaqueCanonicalRef } from "../../realtime-core/src/types.ts";
import {
  createProductionRealtimeCanonicalDeviceIdentityIssuer,
  type RealtimeCanonicalDeviceIdentityIssueInput,
  type RealtimeCanonicalDeviceIdentityIssuerPort,
  type RealtimeCanonicalDeviceIdentityReceipt,
} from "../src/realtime-canonical-device-issuer.ts";
import {
  ApplePhysicalCanaryBindingPostgresError,
  createApplePhysicalCanaryBindingPostgres,
  type ApplePhysicalCanaryBindingIssueInput,
  type ApplePhysicalCanaryBindingReceipt,
  type ApplePhysicalCanaryBindingRefreshInput,
  type AppleFormalWatchBindingReceipt,
} from "../src/apple-physical-canary-binding-postgres.ts";

const SESSION_ID = "019b0000-0000-7000-8000-000000000101";
const IPHONE_LEASE_ID = "019b0000-0000-7000-8000-000000000102";
const WATCH_LEASE_ID = "019b0000-0000-7000-8000-000000000103";
const IPHONE_DEVICE_ID = "01a0521c-9500-7000-8000-000000000104";
const USER_ID = "019b0000-0000-7000-8000-000000000106";
const CONTINUITY_ID = "019b0000-0000-7000-8000-000000000107";
const NOW = "2026-08-30T10:00:00.000Z";
const AUTHORITY_EXPIRES = "2026-08-30T11:00:00.000Z";
const HASH = "a".repeat(64);
const RAW_IPHONE_DEVICE = "11111111-1111-4111-8111-111111111111";
const RAW_IPHONE_CLIENT = "22222222-2222-4222-8222-222222222222";
const RAW_WATCH_DEVICE = "33333333-3333-4333-8333-333333333333";
const RAW_WATCH_CLIENT = "44444444-4444-4444-8444-444444444444";

const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: SESSION_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
}) as unknown as OpaqueCanonicalRef;
const IPHONE_LEASE_REF = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: IPHONE_LEASE_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
}) as unknown as OpaqueCanonicalRef;
const WATCH_LEASE_REF = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: WATCH_LEASE_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
}) as unknown as OpaqueCanonicalRef;

function input(overrides: Partial<ApplePhysicalCanaryBindingIssueInput> = {}): ApplePhysicalCanaryBindingIssueInput {
  return {
    requestId: "apple-physical-canary-request-141",
    idempotencyKey: "apple-physical-canary-idempotency-141",
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
    iphoneCoreDeviceId: RAW_IPHONE_DEVICE,
    iphoneLocalClientInstanceId: RAW_IPHONE_CLIENT,
    watchCoreDeviceId: RAW_WATCH_DEVICE,
    watchLocalClientInstanceId: RAW_WATCH_CLIENT,
    ttlSeconds: 300,
    ...overrides,
  };
}

function refreshInput(overrides: Partial<ApplePhysicalCanaryBindingRefreshInput> = {}): ApplePhysicalCanaryBindingRefreshInput {
  return {
    requestId: "apple-physical-canary-refresh-request-141",
    idempotencyKey: "apple-physical-canary-refresh-idempotency-141",
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
    ttlSeconds: 600,
    expectedLeaseVersion: "1",
    expectedFencingToken: "1",
    ...overrides,
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

function receiptHash(receipt: ApplePhysicalCanaryBindingReceipt): string {
  const { canonicalPayloadSha256: _ignored, ...body } = receipt;
  return createHash("sha256")
    .update(`paios.t02.apple-physical-canary-binding.receipt.v1\n${stable(body)}`)
    .digest("hex");
}

function result(rows: readonly Record<string, unknown>[] = [], command = "SELECT", rowCount = rows.length): QueryResult {
  return { command, rowCount, oid: 0, fields: [], rows: [...rows] } as QueryResult;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

class FakeIdentity implements RealtimeIdentityPort {
  calls = 0;
  asserts = 0;
  leaseCalls = 0;
  collide = false;

  createContinuityId(): string { throw new Error("UNEXPECTED_CONTINUITY_ISSUE"); }
  createSessionRef(): OpaqueCanonicalRef { throw new Error("UNEXPECTED_SESSION_ISSUE"); }
  createDeviceLeaseRef(): OpaqueCanonicalRef {
    this.leaseCalls += 1;
    return WATCH_LEASE_REF;
  }
  createTransportAlias(): string { throw new Error("UNEXPECTED_ALIAS_ISSUE"); }

  assertRepositoryIssuedRef(value: OpaqueCanonicalRef, kind: "RealtimeSession" | "DeviceLease"): void {
    this.asserts += 1;
    assert.equal((value as Record<string, unknown>).ref_type, kind);
  }

  createConnectionId(): string {
    this.calls += 1;
    if (this.collide) return IPHONE_DEVICE_ID;
    return `019b0000-0000-7000-9000-${String(200 + this.calls).padStart(12, "0")}`;
  }
}

class FakeCanonicalDeviceIssuer implements RealtimeCanonicalDeviceIdentityIssuerPort {
  readonly production = createProductionRealtimeCanonicalDeviceIdentityIssuer();
  calls = 0;
  collide = false;
  throwRaw = false;

  issue(input: RealtimeCanonicalDeviceIdentityIssueInput): RealtimeCanonicalDeviceIdentityReceipt {
    this.calls += 1;
    if (this.throwRaw) throw new Error(`${RAW_WATCH_DEVICE}:${RAW_WATCH_CLIENT}`);
    const receipt = this.production.issue(input);
    return this.collide ? Object.freeze({ ...receipt, canonicalDeviceId: IPHONE_DEVICE_ID }) : receipt;
  }
}

interface FakePoolOptions {
  readonly wrongSession?: boolean;
  readonly wrongLease?: boolean;
  readonly authorityExpiresAt?: string;
  readonly insertReturnDrift?: boolean;
  readonly multipleActive?: boolean;
}

class FakePool {
  row: Record<string, unknown> | undefined;
  readonly watchLeases = new Map<string, Record<string, unknown>>();
  readonly ledger = new Map<string, Record<string, unknown>>();
  readonly outbox = new Map<string, Record<string, unknown>>();
  now = NOW;
  readonly options: FakePoolOptions;
  readonly statements: string[] = [];
  readonly values: unknown[][] = [];
  writes = 0;
  connects = 0;
  endCalled = false;
  readonly ledgerCommitWaiters = new Map<string, Array<() => void>>();

  constructor(options: FakePoolOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<PoolClient> {
    this.connects += 1;
    return new FakeClient(this) as unknown as PoolClient;
  }

  async waitForLedgerCommit(key: string): Promise<void> {
    const row = this.ledger.get(key);
    if (row === undefined || row.status !== "in_flight") return;
    await new Promise<void>((resolve) => {
      const waiters = this.ledgerCommitWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.ledgerCommitWaiters.set(key, waiters);
    });
  }

  signalLedgerCommit(key: string): void {
    const waiters = this.ledgerCommitWaiters.get(key) ?? [];
    this.ledgerCommitWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
}

class FakeClient {
  readonly pool: FakePool;
  insertedBindingId: string | undefined;
  readonly insertedWatchLeaseIds: string[] = [];
  refreshLedgerKey: string | undefined;
  refreshOutboxKey: string | undefined;
  bindingBeforeUpdate: Record<string, unknown> | undefined;
  watchBeforeUpdate: Record<string, unknown> | undefined;

  constructor(pool: FakePool) {
    this.pool = pool;
  }

  async query(text: string | { readonly text?: string }, values: readonly unknown[] = []): Promise<QueryResult> {
    const sql = typeof text === "string" ? text : text.text ?? "";
    this.pool.statements.push(sql);
    this.pool.values.push([...values]);
    if (sql === "BEGIN") return result();
    if (sql.startsWith("SET TRANSACTION") || sql === "COMMIT") return result();
    if (sql === "ROLLBACK") {
      if (this.insertedBindingId !== undefined && this.pool.row?.binding_id === this.insertedBindingId) {
        this.pool.row = undefined;
      }
      for (const leaseId of this.insertedWatchLeaseIds) this.pool.watchLeases.delete(leaseId);
      if (this.bindingBeforeUpdate !== undefined) this.pool.row = clone(this.bindingBeforeUpdate);
      if (this.watchBeforeUpdate !== undefined) {
        this.pool.watchLeases.set(String(this.watchBeforeUpdate.lease_ref_id), clone(this.watchBeforeUpdate));
      }
      if (this.refreshLedgerKey !== undefined) this.pool.ledger.delete(this.refreshLedgerKey);
      if (this.refreshOutboxKey !== undefined) this.pool.outbox.delete(this.refreshOutboxKey);
      return result();
    }
    if (sql.startsWith("INSERT INTO idempotency_ledger")) {
      const key = `${String(values[0])}\u0000${String(values[1])}`;
      if (this.pool.ledger.has(key)) return result();
      const row: Record<string, unknown> = {
        scope: values[0], idempotency_key: values[1], request_hash: values[2],
        request_fingerprint: null, status: "in_flight", response: null, response_hash: null,
        fencing_epoch: values[3] ?? null, claim_token_sha256: null, claim_owner: null,
      };
      this.pool.ledger.set(key, row);
      this.refreshLedgerKey = key;
      this.pool.writes += 1;
      return result([clone(row)], "INSERT", 1);
    }
    if (sql.startsWith("SELECT scope, idempotency_key, request_hash, status, response, response_hash, fencing_epoch FROM idempotency_ledger")) {
      const key = `${String(values[0])}\u0000${String(values[1])}`;
      await this.pool.waitForLedgerCommit(key);
      const row = this.pool.ledger.get(key);
      return result(row === undefined ? [] : [clone(row)]);
    }
    if (sql.startsWith("SELECT scope, idempotency_key, request_hash, response, response_hash, fencing_epoch FROM idempotency_ledger")) {
      const row = this.pool.ledger.get(`${String(values[0])}\u0000${String(values[1])}`);
      return result(row === undefined ? [] : [clone(row)]);
    }
    if (sql.startsWith("UPDATE idempotency_ledger SET status = 'committed'")) {
      const key = `${String(values[0])}\u0000${String(values[1])}`;
      const row = this.pool.ledger.get(key);
      if (row === undefined || row.status !== "in_flight" || row.request_hash !== values[4]) return result([], "UPDATE", 0);
      row.status = "committed";
      row.response = JSON.parse(String(values[2]));
      row.response_hash = values[3];
      this.pool.signalLedgerCommit(key);
      return result([clone(row)], "UPDATE", 1);
    }
    if (sql.startsWith("INSERT INTO outbox_events")) {
      const key = `${String(values[5])}\u0000${String(values[6])}\u0000${String(values[3])}`;
      if (this.pool.outbox.has(key)) return result();
      const row: Record<string, unknown> = {
        event_id: values[0], aggregate_type: values[1], aggregate_id: values[2],
        event_type: values[3], event_version: values[4], idempotency_scope: values[5],
        idempotency_key: values[6], payload: JSON.parse(String(values[7])), payload_sha256: values[8],
        status: "pending", attempt_count: 0, claimed_by: null,
      };
      this.pool.outbox.set(key, row);
      this.refreshOutboxKey = key;
      this.pool.writes += 1;
      return result([clone(row)], "INSERT", 1);
    }
    if (sql.startsWith("SELECT event_id, aggregate_type, aggregate_id, event_type, event_version,")) {
      const key = `${String(values[0])}\u0000${String(values[1])}\u0000${String(values[2])}`;
      const row = this.pool.outbox.get(key);
      return result(row === undefined ? [] : [clone(row)]);
    }
    if (sql.includes("WHERE request_id = $1 OR idempotency_key = $2")) {
      const row = this.pool.row;
      return result(row !== undefined && (row.request_id === values[0] || row.idempotency_key === values[1])
        ? [clone(row)] : []);
    }
    if (sql.includes("WHERE session_ref_id = $1 AND iphone_lease_ref_id = $2 AND state = 'active'")) {
      const row = this.pool.row;
      if (row === undefined || row.state !== "active") return result();
      return result(this.pool.options.multipleActive ? [clone(row), clone(row)] : [clone(row)]);
    }
    if (sql.includes("WHERE session_ref_id = $1 AND iphone_lease_ref_id = $2")) {
      const row = this.pool.row;
      if (row === undefined) return result();
      return result(this.pool.options.multipleActive ? [clone(row), clone(row)] : [clone(row)]);
    }
    if (sql.startsWith("SELECT s.user_id, il.device_id")) {
      return result([{ user_id: USER_ID, device_id: IPHONE_DEVICE_ID,
        realtime_session_ref: SESSION_REF, device_lease_ref: IPHONE_LEASE_REF, observed_at: this.pool.now }]);
    }
    if (sql.includes("FROM apple_physical_canary_bindings WHERE user_id=$1")) {
      return result(this.pool.row === undefined ? [] : [clone(this.pool.row)]);
    }
    if (sql.includes("FROM realtime_sessions AS s")) {
      if (this.pool.options.wrongSession) return result();
      const sessionRef = clone(SESSION_REF as unknown as Record<string, unknown>);
      const iphoneLeaseRef = clone(IPHONE_LEASE_REF as unknown as Record<string, unknown>);
      const continuityRef = { ref: "continuity-apple-141" };
      return result([{
        observed_at: this.pool.now,
        realtime_session_ref: sessionRef,
        session_object_version: "1",
        session_payload_sha256: HASH,
        session_state: "active",
        continuity_state: "active",
        continuity_expires_at: this.pool.options.authorityExpiresAt ?? AUTHORITY_EXPIRES,
        active_device_lease_ref: iphoneLeaseRef,
        active_device_id: IPHONE_DEVICE_ID,
        session_user_id: USER_ID,
        session_continuity_id: CONTINUITY_ID,
        session_continuity_ref: continuityRef,
        iphone_device_lease_ref: iphoneLeaseRef,
        iphone_lease_object_version: "1",
        iphone_lease_payload_sha256: HASH,
        iphone_session_ref: sessionRef,
        iphone_session_ref_id: this.pool.options.wrongLease ? WATCH_LEASE_ID : SESSION_ID,
        iphone_device_id: IPHONE_DEVICE_ID,
        iphone_state: "active",
        iphone_user_id: USER_ID,
        iphone_continuity_id: CONTINUITY_ID,
        iphone_continuity_ref: continuityRef,
        iphone_expires_at: this.pool.options.authorityExpiresAt ?? AUTHORITY_EXPIRES,
        iphone_lease_version: "1",
        iphone_fencing_token: "1",
        iphone_revocable: true,
        capabilities: ["apple_companion"],
        purpose: "apple-physical-canary",
        policy_decision_ref: { ref: "policy-apple-141" },
        capability_scope: { capabilities: ["apple_companion"] },
        purpose_scope: { purpose: "apple-physical-canary" },
        policy_binding: { source: "iphone-primary-lease" },
      }]);
    }
    if (sql.startsWith("INSERT INTO device_leases")) {
      const leaseId = String(values[0]);
      if (this.pool.watchLeases.has(leaseId)) {
        for (let index = 0; index < 20 && this.pool.row === undefined; index += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const error = new Error("UNIQUE_COMPANION_LEASE") as Error & { code: string };
        error.code = "23505";
        throw error;
      }
      const row: Record<string, unknown> = {
        lease_ref_id: values[0], device_lease_ref: JSON.parse(String(values[1])),
        lease_object_version: values[2], lease_payload_sha256: values[3], session_ref_id: values[4],
        realtime_session_ref: JSON.parse(String(values[5])), continuity_ref: JSON.parse(String(values[6])),
        user_id: values[7], device_id: values[8], continuity_id: values[9],
        capabilities: JSON.parse(String(values[10])), purpose: values[11],
        policy_decision_ref: JSON.parse(String(values[12])), capability_scope: JSON.parse(String(values[13])),
        purpose_scope: JSON.parse(String(values[14])), policy_binding: JSON.parse(String(values[15])),
        revocable: true, state: "active", lease_version: "1", fencing_token: "1",
        issued_at: values[16], acquired_at: values[16], expires_at: values[17],
        released_at: null, revoked_at: null, updated_at: values[16],
      };
      this.pool.writes += 1;
      this.insertedWatchLeaseIds.push(leaseId);
      this.pool.watchLeases.set(leaseId, clone(row));
      return result([clone(row)], "INSERT", 1);
    }
    if (sql.startsWith("UPDATE device_leases SET state = 'active', expires_at")) {
      const leaseId = String(values[0]);
      const row = this.pool.watchLeases.get(leaseId);
      if (row === undefined || row.state !== "active" || row.session_ref_id !== values[4] ||
          row.device_id !== values[5] || String(row.lease_version) !== String(values[6]) ||
          String(row.fencing_token) !== String(values[7]) || row.released_at !== null || row.revoked_at !== null) {
        return result([], "UPDATE", 0);
      }
      this.pool.writes += 1;
      this.watchBeforeUpdate = clone(row);
      row.expires_at = values[1];
      row.lease_version = values[2];
      row.fencing_token = values[3];
      row.released_at = null;
      row.revoked_at = null;
      row.updated_at = this.pool.now;
      return result([], "UPDATE", 1);
    }
    if (sql.includes("FROM device_leases AS wl WHERE lease_ref_id = $1")) {
      const row = this.pool.watchLeases.get(String(values[0]));
      return result(row === undefined ? [] : [clone(row)]);
    }
    if (sql.includes("FROM device_leases WHERE lease_ref_id = $1 FOR UPDATE")) {
      const row = this.pool.watchLeases.get(String(values[0]));
      return result(row === undefined ? [] : [clone(row)]);
    }
    if (sql.startsWith("INSERT INTO apple_physical_canary_bindings")) {
      if (this.pool.row !== undefined) {
        const error = new Error("UNIQUE_CONFLICT") as Error & { code: string };
        error.code = "23505";
        throw error;
      }
      this.pool.writes += 1;
      const row: Record<string, unknown> = {
        binding_id: values[0], request_id: values[1], idempotency_key: values[2],
        request_fingerprint_sha256: values[3], realtime_session_ref: JSON.parse(String(values[4])),
        session_ref_id: values[5], session_object_version: values[6], session_payload_sha256: values[7],
        iphone_device_lease_ref: JSON.parse(String(values[8])), iphone_lease_ref_id: values[9],
        iphone_lease_object_version: values[10], iphone_lease_payload_sha256: values[11],
        iphone_device_id: values[12], iphone_client_instance_id: values[13],
        watch_device_lease_ref: JSON.parse(String(values[14])), watch_lease_ref_id: values[15],
        watch_lease_object_version: values[16], watch_lease_payload_sha256: values[17],
        watch_device_id: values[18], watch_client_instance_id: values[19], issued_at: values[20],
        expires_at: values[21], object_version: values[22], receipt_jcs: values[23],
        canonical_payload_sha256: values[24], state: "active", revoked_at: null,
        companion_role: "watch", companion_source: "apple_physical_canary_binding_v1",
        created_at: this.pool.now, updated_at: this.pool.now,
      };
      this.insertedBindingId = String(values[0]);
      this.pool.row = clone(row);
      const returned = clone(row);
      if (this.pool.options.insertReturnDrift) returned.canonical_payload_sha256 = "b".repeat(64);
      return result([returned], "INSERT", 1);
    }
    if (sql.includes("WHERE binding_id = $1 FOR UPDATE")) {
      const row = this.pool.row;
      if (row === undefined || row.binding_id !== values[0]) return result();
      return result([clone(row)]);
    }
    if (sql === "SELECT * FROM apple_physical_canary_bindings WHERE binding_id = $1") {
      const row = this.pool.row;
      if (row === undefined || row.binding_id !== values[0]) return result();
      return result([clone(row)]);
    }
    if (sql.startsWith("UPDATE apple_physical_canary_bindings SET expires_at")) {
      const row = this.pool.row;
      if (row === undefined || row.binding_id !== values[0] || row.state !== "active" ||
          row.canonical_payload_sha256 !== values[4]) return result([], "UPDATE", 0);
      this.pool.writes += 1;
      this.bindingBeforeUpdate = clone(row);
      row.expires_at = values[1];
      row.receipt_jcs = String(values[2]);
      row.canonical_payload_sha256 = values[3];
      row.updated_at = this.pool.now;
      return result([], "UPDATE", 1);
    }
    if (sql.startsWith("UPDATE apple_physical_canary_bindings")) {
      const row = this.pool.row;
      if (row === undefined || row.binding_id !== values[0] || row.state !== "active" ||
          row.canonical_payload_sha256 !== values[1]) return result([], "UPDATE", 0);
      this.pool.writes += 1;
      this.bindingBeforeUpdate = clone(row);
      row.state = "revoked";
      row.revoked_at = this.pool.now;
      row.updated_at = this.pool.now;
      return result([], "UPDATE", 1);
    }
    if (sql.startsWith("UPDATE device_leases")) {
      const leaseId = String(values[0]);
      const row = this.pool.watchLeases.get(leaseId);
      if (row === undefined || row.state !== "active" || row.session_ref_id !== values[1] ||
          row.device_id !== values[2] || row.lease_payload_sha256 !== values[3]) return result([], "UPDATE", 0);
      this.pool.writes += 1;
      this.watchBeforeUpdate = clone(row);
      row.state = "released";
      row.released_at = this.pool.now;
      row.updated_at = this.pool.now;
      return result([], "UPDATE", 1);
    }
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  }

  release(): void {}
}

function harness(options: FakePoolOptions = {}): Readonly<{
  pool: FakePool;
  identity: FakeIdentity;
  canonicalDeviceIssuer: FakeCanonicalDeviceIssuer;
  port: ReturnType<typeof createApplePhysicalCanaryBindingPostgres>;
}> {
  const pool = new FakePool(options);
  const identity = new FakeIdentity();
  const canonicalDeviceIssuer = new FakeCanonicalDeviceIssuer();
  const port = createApplePhysicalCanaryBindingPostgres({
    pool: pool as unknown as Pool,
    identity,
    canonicalDeviceIssuer,
  });
  return { pool, identity, canonicalDeviceIssuer, port };
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof ApplePhysicalCanaryBindingPostgresError && error.code === code);
}

test("issues two exact server-authoritative endpoint identities and byte-identical zero-write replay", async () => {
  const h = harness();
  assert.equal(h.pool.watchLeases.size, 0);
  const first = await h.port.issue(input());
  assert.equal(first.kind, "t02.apple.physical-canary-binding.v1");
  assert.equal(first.realtimeSessionRef, first.realtimeSessionRef);
  assert.deepEqual(first.realtimeSessionRef, SESSION_REF);
  assert.deepEqual(first.iphone.deviceLeaseRef, IPHONE_LEASE_REF);
  assert.deepEqual(first.watch.deviceLeaseRef, WATCH_LEASE_REF);
  assert.equal(first.iphone.deviceId, IPHONE_DEVICE_ID);
  assert.match(first.watch.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(new Set([
    first.iphone.deviceId, first.iphone.clientInstanceId,
    first.watch.deviceId, first.watch.clientInstanceId,
  ]).size, 4);
  assert.equal(first.objectVersion, "1");
  assert.equal(first.issuedAt, NOW);
  assert.equal(first.expiresAt, "2026-08-30T10:05:00.000Z");
  assert.equal(first.canonicalPayloadSha256, receiptHash(first));
  assert.match(first.requestFingerprintSha256, /^[0-9a-f]{64}$/u);
  assert.equal(stable(first).includes(RAW_IPHONE_DEVICE), false);
  assert.equal(stable(first).includes(RAW_WATCH_CLIENT), false);
  const writes = h.pool.writes;
  const identityCalls = h.identity.calls;
  const replay = await h.port.issue(input());
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(h.pool.writes, writes);
  assert.equal(h.identity.calls, identityCalls);
  assert.equal(h.identity.leaseCalls, 1);
  assert.equal(h.canonicalDeviceIssuer.calls, 1);
  assert.equal(h.pool.watchLeases.size, 1);
  assert.equal(h.pool.statements.some((sql) => /UPDATE realtime_sessions/u.test(sql)), false);
  assert.equal(h.pool.endCalled, false);
  const databaseValues = stable(h.pool.values);
  for (const raw of [RAW_IPHONE_DEVICE, RAW_IPHONE_CLIENT, RAW_WATCH_DEVICE, RAW_WATCH_CLIENT]) {
    assert.equal(databaseValues.includes(raw), false);
  }
});

test("same request with conflicting complete input or split request keys fails closed", async () => {
  const h = harness();
  await h.port.issue(input());
  const writes = h.pool.writes;
  await rejectsCode(h.port.issue(input({
    watchLocalClientInstanceId: "55555555-5555-4555-8555-555555555555",
  })), "APPLE_PHYSICAL_CANARY_IDEMPOTENCY_CONFLICT");
  await rejectsCode(h.port.issue(input({ idempotencyKey: "apple-physical-canary-idempotency-conflict" })),
    "APPLE_PHYSICAL_CANARY_IDEMPOTENCY_CONFLICT");
  assert.equal(h.pool.writes, writes);
});

test("expiration, authority TTL, wrong session and wrong lease all fail closed", async () => {
  const expired = harness();
  const receipt = await expired.port.issue(input());
  expired.pool.now = receipt.expiresAt;
  await rejectsCode(expired.port.read(receipt.bindingId), "APPLE_PHYSICAL_CANARY_BINDING_EXPIRED");

  for (const [options, code] of [
    [{ authorityExpiresAt: "2026-08-30T10:04:59.999Z" }, "APPLE_PHYSICAL_CANARY_TTL_EXCEEDS_AUTHORITY"],
    [{ wrongSession: true }, "APPLE_PHYSICAL_CANARY_AUTHORITY_MISSING"],
    [{ wrongLease: true }, "APPLE_PHYSICAL_CANARY_AUTHORITY_BINDING_DRIFT"],
  ] as const) {
    const h = harness(options);
    await rejectsCode(h.port.issue(input()), code);
    assert.equal(h.pool.writes, 0);
  }
});

test("Watch and iPhone raw, server-device or issued-client collisions fail closed", async () => {
  const raw = harness();
  await rejectsCode(raw.port.issue(input({ watchCoreDeviceId: RAW_IPHONE_DEVICE })),
    "APPLE_PHYSICAL_CANARY_ENDPOINT_IDENTITY_COLLISION");
  assert.equal(raw.pool.connects, 0);

  const server = harness();
  server.canonicalDeviceIssuer.collide = true;
  await rejectsCode(server.port.issue(input()), "APPLE_PHYSICAL_CANARY_ENDPOINT_IDENTITY_COLLISION");
  assert.equal(server.pool.writes, 0);

  const issued = harness();
  issued.identity.collide = true;
  await rejectsCode(issued.port.issue(input()), "APPLE_PHYSICAL_CANARY_ENDPOINT_IDENTITY_COLLISION");
  assert.equal(issued.pool.writes, 0);
});

test("read fully verifies authority; exact revoke is idempotent and never rewrites identity", async () => {
  const h = harness();
  const receipt = await h.port.issue(input());
  const storedReceipt = h.pool.row!.receipt_jcs;
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.state, "active");
  const read = await h.port.read(receipt.bindingId);
  assert.equal(JSON.stringify(read), JSON.stringify(receipt));
  const readOnly = h.pool.statements.indexOf("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(readOnly >= 0);
  const readTransaction = h.pool.statements.slice(readOnly, h.pool.statements.indexOf("COMMIT", readOnly) + 1).join(" ");
  assert.doesNotMatch(readTransaction, /FOR UPDATE|\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/u);

  const revoke = {
    bindingId: receipt.bindingId,
    requestId: receipt.requestId,
    idempotencyKey: receipt.idempotencyKey,
    canonicalPayloadSha256: receipt.canonicalPayloadSha256,
  };
  await h.port.revoke(revoke);
  const writes = h.pool.writes;
  await h.port.revoke(revoke);
  assert.equal(h.pool.writes, writes);
  assert.equal(h.pool.row!.receipt_jcs, storedReceipt);
  assert.equal(h.pool.row!.iphone_device_id, receipt.iphone.deviceId);
  assert.equal(h.pool.row!.watch_client_instance_id, receipt.watch.clientInstanceId);
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.state, "released");
  assert.equal(h.pool.statements.some((sql) => /UPDATE realtime_sessions/u.test(sql)), false);
  await rejectsCode(h.port.read(receipt.bindingId), "APPLE_PHYSICAL_CANARY_BINDING_REVOKED");
  await rejectsCode(h.port.revoke({ ...revoke, canonicalPayloadSha256: "b".repeat(64) }),
    "APPLE_PHYSICAL_CANARY_REVOKE_BINDING_MISMATCH");
});

test("readActiveByPrimary resolves one live iPhone/Watch binding in a read-only transaction", async () => {
  const empty = harness();
  assert.equal(await empty.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
  }), undefined);

  const h = harness();
  const receipt = await h.port.issue(input());
  const writes = h.pool.writes;
  const read = await h.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
    now: NOW,
  });
  assert.equal(JSON.stringify(read), JSON.stringify(receipt));
  assert.equal(h.pool.writes, writes);
  const readOnly = h.pool.statements.lastIndexOf("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(readOnly >= 0);
  const readTransaction = h.pool.statements.slice(readOnly, h.pool.statements.indexOf("COMMIT", readOnly) + 1).join(" ");
  assert.doesNotMatch(readTransaction, /FOR UPDATE|\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/u);

  await rejectsCode(h.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
    now: receipt.expiresAt,
  }), "APPLE_PHYSICAL_CANARY_BINDING_EXPIRED");
});

test("readActiveByPrimary returns no revoked binding and rejects primary/duplicate drift", async () => {
  const revoked = harness();
  const revokedReceipt = await revoked.port.issue(input());
  revoked.pool.row!.state = "revoked";
  revoked.pool.row!.revoked_at = NOW;
  assert.equal(await revoked.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
  }), undefined);
  assert.equal(revoked.pool.writes, 2);

  const wrongPrimary = harness();
  await wrongPrimary.port.issue(input());
  const alternateSession = Object.freeze({
    ref_type: "RealtimeSession",
    ref_id: "019b0000-0000-7000-8000-000000000199",
    object_version: "1",
    canonical_payload_sha256: HASH,
  }) as unknown as OpaqueCanonicalRef;
  await rejectsCode(wrongPrimary.port.readActiveByPrimary({
    realtimeSessionRef: alternateSession,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
  }), "APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_DRIFT");

  const duplicate = harness({ multipleActive: true });
  await duplicate.port.issue(input());
  await rejectsCode(duplicate.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
  }), "APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_CONFLICT");

  const leaseDrift = harness();
  await leaseDrift.port.issue(input());
  (leaseDrift.pool.options as { wrongLease?: boolean }).wrongLease = true;
  await rejectsCode(leaseDrift.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
  }), "APPLE_PHYSICAL_CANARY_AUTHORITY_BINDING_DRIFT");
  assert.equal(revokedReceipt.watch.deviceId !== revokedReceipt.iphone.deviceId, true);
});

test("refreshActiveByPrimary renews only the Watch companion and replays without writes", async () => {
  const h = harness();
  const issued = await h.port.issue(input());
  const refresh = refreshInput();
  const first = await h.port.refreshActiveByPrimary(refresh);
  assert.ok(first !== undefined);
  assert.equal(first.binding.bindingId, issued.bindingId);
  assert.equal(first.binding.realtimeSessionRef, first.binding.realtimeSessionRef);
  assert.equal(first.binding.expiresAt, "2026-08-30T10:10:00.000Z");
  assert.equal(first.leaseVersion, "2");
  assert.equal(first.fencingToken, "2");
  assert.equal(first.refreshedAt, NOW);
  assert.equal(h.pool.row!.binding_id, issued.bindingId);
  assert.equal(h.pool.row!.iphone_lease_ref_id, IPHONE_LEASE_ID);
  assert.equal(h.pool.row!.watch_lease_ref_id, WATCH_LEASE_ID);
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.lease_version, "2");
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.fencing_token, "2");
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.expires_at, first.binding.expiresAt);
  assert.equal(h.pool.outbox.size, 1);
  assert.equal(h.pool.ledger.size, 1);
  const writes = h.pool.writes;
  const replayPort = createApplePhysicalCanaryBindingPostgres({
    pool: h.pool as unknown as Pool,
    identity: h.identity,
    canonicalDeviceIssuer: h.canonicalDeviceIssuer,
  });
  const replay = await replayPort.refreshActiveByPrimary(refresh);
  assert.deepEqual(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(h.pool.writes, writes);
  assert.equal(h.pool.outbox.size, 1);
  assert.equal(h.pool.ledger.size, 1);
  assert.equal(h.pool.statements.some((sql) => /UPDATE realtime_sessions/u.test(sql)), false);
  const read = await h.port.readActiveByPrimary({
    realtimeSessionRef: SESSION_REF,
    iphoneDeviceLeaseRef: IPHONE_LEASE_REF,
  });
  assert.equal(JSON.stringify(read), JSON.stringify(first.binding));
});

test("refreshActiveByPrimary caps Watch at the primary/session ceiling and never shortens it", async () => {
  const h = harness({ authorityExpiresAt: "2026-08-30T10:15:00.000Z" });
  const issued = await h.port.issue(input({ ttlSeconds: 300 }));
  const first = await h.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-capped",
    idempotencyKey: "apple-physical-canary-refresh-capped",
    ttlSeconds: 3_600,
  }));
  assert.ok(first !== undefined);
  assert.equal(issued.expiresAt, "2026-08-30T10:05:00.000Z");
  assert.equal(first.binding.expiresAt, "2026-08-30T10:15:00.000Z");
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.expires_at, first.binding.expiresAt);
  assert.equal(h.pool.row!.iphone_lease_ref_id, IPHONE_LEASE_ID);
  assert.equal(h.pool.statements.some((sql) => /UPDATE realtime_sessions/u.test(sql)), false);

  (h.pool.options as { authorityExpiresAt?: string }).authorityExpiresAt = "2026-08-30T10:10:00.000Z";
  const writes = h.pool.writes;
  await rejectsCode(h.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-shortening",
    idempotencyKey: "apple-physical-canary-refresh-shortening",
    ttlSeconds: 3_600,
  })), "APPLE_PHYSICAL_CANARY_REFRESH_NOT_EXTENDING");
  assert.equal(h.pool.writes, writes + 1);
  assert.equal(h.pool.ledger.size, 1);
  assert.equal(h.pool.row!.expires_at, first.binding.expiresAt);
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.expires_at, first.binding.expiresAt);
});

test("refreshActiveByPrimary accepts an expired companion window, rejects primary/binding drift, and rolls back", async () => {
  const expiredCompanion = harness();
  const issued = await expiredCompanion.port.issue(input());
  expiredCompanion.pool.now = issued.expiresAt;
  const refreshed = await expiredCompanion.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-expired-companion",
    idempotencyKey: "apple-physical-canary-refresh-expired-companion",
    ttlSeconds: 300,
  }));
  assert.ok(refreshed !== undefined);
  assert.equal(refreshed.leaseVersion, "2");
  assert.equal(refreshed.fencingToken, "2");
  assert.equal(refreshed.binding.expiresAt, "2026-08-30T10:10:00.000Z");

  const primaryExpired = harness();
  await primaryExpired.port.issue(input());
  (primaryExpired.pool.options as { authorityExpiresAt?: string }).authorityExpiresAt = NOW;
  const beforeExpired = primaryExpired.pool.writes;
  await rejectsCode(primaryExpired.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-primary-expired",
    idempotencyKey: "apple-physical-canary-refresh-primary-expired",
  })), "APPLE_PHYSICAL_CANARY_PRIMARY_SESSION_EXPIRED");
  assert.equal(primaryExpired.pool.row!.expires_at, issued.expiresAt);
  assert.equal(primaryExpired.pool.writes, beforeExpired + 1);
  assert.equal(primaryExpired.pool.ledger.size, 0);

  const revoked = harness();
  await revoked.port.issue(input());
  revoked.pool.row!.state = "revoked";
  revoked.pool.row!.revoked_at = NOW;
  await rejectsCode(revoked.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-revoked",
    idempotencyKey: "apple-physical-canary-refresh-revoked",
  })), "APPLE_PHYSICAL_CANARY_BINDING_REVOKED");
  assert.equal(revoked.pool.ledger.size, 0);

  const drift = harness();
  await drift.port.issue(input());
  drift.pool.watchLeases.get(WATCH_LEASE_ID)!.fencing_token = "bad";
  await rejectsCode(drift.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-watch-drift",
    idempotencyKey: "apple-physical-canary-refresh-watch-drift",
  })), "APPLE_PHYSICAL_CANARY_WATCH_LEASE_DRIFT");
  assert.equal(drift.pool.ledger.size, 0);

  const primaryFence = harness();
  await primaryFence.port.issue(input());
  await rejectsCode(primaryFence.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-primary-fence",
    idempotencyKey: "apple-physical-canary-refresh-primary-fence",
    expectedFencingToken: "9",
  })), "APPLE_PHYSICAL_CANARY_PRIMARY_FENCE_CONFLICT");
  assert.equal(primaryFence.pool.ledger.size, 0);

  const conflict = harness();
  await conflict.port.issue(input());
  await conflict.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-conflict",
    idempotencyKey: "apple-physical-canary-refresh-conflict",
  }));
  await rejectsCode(conflict.port.refreshActiveByPrimary(refreshInput({
    requestId: "apple-physical-canary-refresh-conflict-drift",
    idempotencyKey: "apple-physical-canary-refresh-conflict",
    ttlSeconds: 601,
  })), "APPLE_PHYSICAL_CANARY_REFRESH_IDEMPOTENCY_CONFLICT");
});

test("concurrent duplicate refreshes converge on one replayed refresh result", async () => {
  const h = harness();
  await h.port.issue(input());
  const refresh = refreshInput({
    requestId: "apple-physical-canary-refresh-concurrent",
    idempotencyKey: "apple-physical-canary-refresh-concurrent",
  });
  const [left, right] = await Promise.all([
    h.port.refreshActiveByPrimary(refresh),
    h.port.refreshActiveByPrimary(refresh),
  ]);
  assert.ok(left !== undefined && right !== undefined);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.lease_version, "2");
  assert.equal(h.pool.watchLeases.get(WATCH_LEASE_ID)!.fencing_token, "2");
  assert.equal(h.pool.outbox.size, 1);
});

test("concurrent duplicate issuance converges on one byte-identical row", async () => {
  const h = harness();
  const [left, right] = await Promise.all([h.port.issue(input()), h.port.issue(input())]);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.equal(h.pool.writes, 2);
  assert.ok(h.pool.row !== undefined);
  assert.equal(h.pool.watchLeases.size, 1);
});

test("post-insert verification drift rolls back the complete transaction", async () => {
  const h = harness({ insertReturnDrift: true });
  await rejectsCode(h.port.issue(input()), "APPLE_PHYSICAL_CANARY_STORED_BINDING_DRIFT");
  assert.equal(h.pool.row, undefined);
  assert.equal(h.pool.watchLeases.size, 0);
  assert.ok(h.pool.statements.includes("ROLLBACK"));
  assert.equal(h.pool.endCalled, false);
});

test("raw identifiers remain absent from receipt, DB arguments and log-visible errors", async () => {
  const h = harness({ wrongLease: true });
  let captured: unknown;
  try {
    await h.port.issue(input());
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof ApplePhysicalCanaryBindingPostgresError);
  const visible = `${(captured as Error).name}:${(captured as Error).message}:${String(captured)}`;
  const databaseValues = stable(h.pool.values);
  for (const raw of [RAW_IPHONE_DEVICE, RAW_IPHONE_CLIENT, RAW_WATCH_DEVICE, RAW_WATCH_CLIENT]) {
    assert.equal(visible.includes(raw), false);
    assert.equal(databaseValues.includes(raw), false);
  }

  const issuerFailure = harness();
  issuerFailure.canonicalDeviceIssuer.throwRaw = true;
  let issuerError: unknown;
  try {
    await issuerFailure.port.issue(input());
  } catch (error) {
    issuerError = error;
  }
  assert.ok(issuerError instanceof ApplePhysicalCanaryBindingPostgresError);
  assert.equal((issuerError as Error & { cause?: unknown }).cause, undefined);
  assert.equal(String(issuerError).includes(RAW_WATCH_DEVICE), false);
});

test("0005 migration is ordered, symmetric, exact-scope and statically fail closed", async () => {
  const root = new URL("../../../", import.meta.url);
  const up = await readFile(new URL("migrations/0005_apple_physical_canary_binding.up.sql", root), "utf8");
  const down = await readFile(new URL("migrations/0005_apple_physical_canary_binding.down.sql", root), "utf8");
  const source = await readFile(new URL("services/platform-data/src/apple-physical-canary-binding-postgres.ts", root), "utf8");
  const migrations = (await readdir(new URL("migrations/", root)))
    .filter((name) => /^\d{4}_.+\.(?:up|down)\.sql$/u.test(name)).sort();
  // Ordered inventory: up migrations are numbered 0001..N without gaps; later migrations may follow 0005.
  const ups = migrations.filter((name) => name.endsWith(".up.sql")).map((name) => name.slice(0, 4));
  assert.ok(ups.length >= 5);
  assert.deepEqual(ups, ups.map((_, index) => String(index + 1).padStart(4, "0")));
  assert.match(up, /^BEGIN;/u);
  assert.match(up, /CREATE TABLE IF NOT EXISTS apple_physical_canary_bindings/u);
  assert.match(up, /PAIOS_MIGRATION_0005_PREIMAGE_TABLE_SET_MISMATCH/u);
  assert.match(up, /PAIOS_MIGRATION_0005_EXACT_19_TABLE_SET_MISMATCH/u);
  assert.match(up, /apple_physical_canary_bindings_identity_distinct_ck/u);
  assert.match(up, /apple_physical_canary_bindings_companion_role_ck/u);
  assert.match(up, /companion_source = 'apple_physical_canary_binding_v1'/u);
  assert.match(up, /REFERENCES realtime_sessions \(session_ref_id\)/u);
  assert.match(up, /REFERENCES device_leases \(lease_ref_id\)/u);
  assert.doesNotMatch(up, /\bALTER\s+TABLE\b|\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/u);
  assert.match(down, /^BEGIN;/u);
  assert.match(down, /DROP TABLE IF EXISTS apple_physical_canary_bindings;/u);
  assert.match(down, /PAIOS_MIGRATION_0005_DOWN_TABLE_SHAPE_MISMATCH/u);
  assert.doesNotMatch(down, /\bCASCADE\b|DROP TABLE IF EXISTS (?!apple_physical_canary_bindings)/u);
  for (const rawField of ["iphoneCoreDeviceId", "iphoneLocalClientInstanceId", "watchCoreDeviceId", "watchLocalClientInstanceId"]) {
    assert.doesNotMatch(up + down, new RegExp(rawField, "u"));
  }
  assert.doesNotMatch(source, /\.end\s*\(|createPostgresPool|console\.|LiveKit|E2EE|token mint|startService/iu);
  const writeTargets = [...source.matchAll(/(?:INSERT INTO|UPDATE) ([a-z_]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(writeTargets)].sort(), ["apple_physical_canary_bindings", "device_leases"]);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE) realtime_sessions/u);
});

test("0005 treats PG18 NOT NULL catalog rows separately and preserves exact nullability", async () => {
  const up = await readFile(
    new URL("../../../migrations/0005_apple_physical_canary_binding.up.sql", import.meta.url),
    "utf8",
  );
  const constraintQuery = up.match(
    /SELECT array_agg\(c\.conname ORDER BY c\.conname\) INTO actual_constraints[\s\S]*?;/u,
  )?.[0];
  assert.ok(constraintQuery !== undefined);
  assert.match(constraintQuery, /AND c\.contype <> 'n'/u);

  const expectedConstraintBlock = up.match(
    /expected_constraints TEXT\[\] := ARRAY\[([\s\S]*?)\];/u,
  )?.[1];
  assert.ok(expectedConstraintBlock !== undefined);
  const expectedConstraints = [...expectedConstraintBlock.matchAll(/'([^']+)'/gu)]
    .map((match) => match[1]!).sort();
  assert.equal(expectedConstraints.length, 25);
  const businessRows = expectedConstraints.map((name) => ({ name, contype: "c" }));
  const pg18NotNullRows = Array.from({ length: 31 }, (_, index) => ({
    name: `pg18_truncated_not_null_${index}`,
    contype: "n",
  }));
  const namedBusinessProjection = (rows: readonly Readonly<{ name: string; contype: string }>[]): string[] =>
    rows.filter((row) => row.contype !== "n").map((row) => row.name).sort();
  assert.deepEqual(namedBusinessProjection([...businessRows, ...pg18NotNullRows]), expectedConstraints);
  assert.notDeepEqual(namedBusinessProjection([
    ...businessRows,
    ...pg18NotNullRows,
    { name: "unexpected_non_not_null_constraint", contype: "c" },
  ]), expectedConstraints);
  assert.notDeepEqual(namedBusinessProjection([...businessRows.slice(1), ...pg18NotNullRows]), expectedConstraints);

  assert.match(up, /INTO actual_not_null_columns[\s\S]*?AND a\.attnotnull;/u);
  assert.match(up, /INTO actual_nullable_columns[\s\S]*?AND NOT a\.attnotnull;/u);
  assert.match(up, /PAIOS_MIGRATION_0005_NOT_NULL_SET_MISMATCH/u);
  assert.match(up, /PAIOS_MIGRATION_0005_NULLABLE_SET_MISMATCH/u);
  const expectedNotNullBlock = up.match(
    /expected_not_null_columns TEXT\[\] := ARRAY\[([\s\S]*?)\];/u,
  )?.[1];
  assert.ok(expectedNotNullBlock !== undefined);
  const expectedNotNull = [...expectedNotNullBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
  const tableBody = up.match(
    /CREATE TABLE IF NOT EXISTS apple_physical_canary_bindings \(\r?\n([\s\S]*?)\r?\n\);/u,
  )?.[1];
  assert.ok(tableBody !== undefined);
  const columnSection = tableBody.split(/\r?\n\s*CONSTRAINT /u)[0]!;
  const ddlColumns = [...columnSection.matchAll(
    /^  ([a-z][a-z0-9_]*)\s+(?:UUID|TEXT|JSONB|TIMESTAMPTZ)([^\r\n]*),\r?$/gmu,
  )].map((match) => ({ name: match[1]!, notNull: /\bNOT NULL\b/u.test(match[2]!) }));
  assert.equal(ddlColumns.length, 31);
  assert.deepEqual(ddlColumns.filter((column) => column.notNull).map((column) => column.name), expectedNotNull);
  assert.deepEqual(ddlColumns.filter((column) => !column.notNull).map((column) => column.name), ["revoked_at"]);
  assert.notDeepEqual([...expectedNotNull, "revoked_at"], expectedNotNull);
});

test("0005 down separates PG18 NOT NULL rows and rejects business or nullability drift", async () => {
  const down = await readFile(
    new URL("../../../migrations/0005_apple_physical_canary_binding.down.sql", import.meta.url),
    "utf8",
  );
  const constraintQuery = down.match(
    /SELECT array_agg\(c\.conname ORDER BY c\.conname\) INTO actual_constraints[\s\S]*?;/u,
  )?.[0];
  assert.ok(constraintQuery !== undefined);
  assert.match(constraintQuery, /AND c\.contype <> 'n'/u);

  const expectedConstraintBlock = down.match(
    /expected_constraints TEXT\[\] := ARRAY\[([\s\S]*?)\];/u,
  )?.[1];
  assert.ok(expectedConstraintBlock !== undefined);
  const expectedConstraints = [...expectedConstraintBlock.matchAll(/'([^']+)'/gu)]
    .map((match) => match[1]!).sort();
  assert.equal(expectedConstraints.length, 25);
  const businessRows = expectedConstraints.map((name) => ({ name, contype: "c" }));
  const pg18NotNullRows = Array.from({ length: 31 }, (_, index) => ({
    name: `pg18_down_truncated_not_null_${index}`,
    contype: "n",
  }));
  const namedBusinessProjection = (rows: readonly Readonly<{ name: string; contype: string }>[]): string[] =>
    rows.filter((row) => row.contype !== "n").map((row) => row.name).sort();
  assert.deepEqual(namedBusinessProjection([...businessRows, ...pg18NotNullRows]), expectedConstraints);
  assert.notDeepEqual(namedBusinessProjection([
    ...businessRows,
    ...pg18NotNullRows,
    { name: "unexpected_down_business_constraint", contype: "f" },
  ]), expectedConstraints);
  assert.notDeepEqual(namedBusinessProjection([...businessRows.slice(1), ...pg18NotNullRows]), expectedConstraints);

  assert.match(down, /INTO actual_not_null_columns[\s\S]*?AND a\.attnotnull;/u);
  assert.match(down, /INTO actual_nullable_columns[\s\S]*?AND NOT a\.attnotnull;/u);
  assert.match(down, /PAIOS_MIGRATION_0005_DOWN_NOT_NULL_SET_MISMATCH/u);
  assert.match(down, /PAIOS_MIGRATION_0005_DOWN_NULLABLE_SET_MISMATCH/u);
  const expectedNotNullBlock = down.match(
    /expected_not_null_columns TEXT\[\] := ARRAY\[([\s\S]*?)\];/u,
  )?.[1];
  assert.ok(expectedNotNullBlock !== undefined);
  const expectedNotNull = [...expectedNotNullBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
  const exactColumnBlock = down.match(
    /IF actual_columns IS DISTINCT FROM ARRAY\[([\s\S]*?)\] THEN/u,
  )?.[1];
  assert.ok(exactColumnBlock !== undefined);
  const exactColumns = [...exactColumnBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
  assert.equal(exactColumns.length, 31);
  assert.equal(expectedNotNull.length, 30);
  assert.deepEqual(exactColumns.filter((column) => column !== "revoked_at"), expectedNotNull);
  assert.deepEqual(exactColumns.filter((column) => !expectedNotNull.includes(column)), ["revoked_at"]);
  assert.notDeepEqual(exactColumns, expectedNotNull);
  assert.notDeepEqual(expectedNotNull.slice(1), expectedNotNull);
  const expectedNullableBlock = down.match(
    /actual_nullable_columns IS DISTINCT FROM ARRAY\[([^\]]+)\]/u,
  )?.[1];
  assert.ok(expectedNullableBlock !== undefined);
  const expectedNullable = [...expectedNullableBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
  assert.deepEqual(expectedNullable, ["revoked_at"]);
  assert.notDeepEqual([], expectedNullable);
  assert.notDeepEqual(["revoked_at", "state"], expectedNullable);
});

// The fixture starts with the same issued lease, then supplies the formal receipt discriminator.
async function formalHarness(options: FakePoolOptions = {}) {
  const h = harness(options);
  const legacy = await h.port.issue(input({ ttlSeconds: 600 }));
  const body = { ...legacy, kind: "t02.apple.watch-binding.v1" as const, pairVersion: "1",
    installationId: RAW_WATCH_CLIENT, userId: USER_ID, principalRef: "phone-principal", status: "active" as const };
  const { canonicalPayloadSha256: _old, ...clean } = body;
  const receipt: AppleFormalWatchBindingReceipt = { ...clean, canonicalPayloadSha256: createHash("sha256")
    .update(`paios.t02.apple-watch-binding.receipt.v1\n${stable(clean)}`).digest("hex") };
  Object.assign(h.pool.row!, { companion_source: "apple_watch_binding_v1", pair_version: "1", user_id: USER_ID,
    principal_ref: receipt.principalRef, watch_installation_id: receipt.installationId,
    canonical_payload_sha256: receipt.canonicalPayloadSha256, receipt_jcs: stable(receipt) });
  const auth = { userId: USER_ID, deviceId: IPHONE_DEVICE_ID, principalRef: receipt.principalRef,
    expiresAt: AUTHORITY_EXPIRES, purpose: "apple-physical-canary", policyDecisionRef: { ref: "policy-apple-141" },
    capabilities: ["apple_companion"] };
  const port = createApplePhysicalCanaryBindingPostgres({ pool: h.pool as unknown as Pool,
    identity: h.identity, canonicalDeviceIssuer: h.canonicalDeviceIssuer,
    formalPrimaryAuthority: { resolve: async bearer => { assert.equal(bearer, auth); return auth; } } });
  return { ...h, port, auth, receipt, read: () => port.readFormal({ realtimeSessionRef: SESSION_REF, iphoneDeviceLeaseRef: IPHONE_LEASE_REF }, auth) };
}

test("authenticated formal read renews the same Watch after 600 seconds and caps its lease at the live parent", async () => {
  const h = await formalHarness();
  h.pool.now = "2026-08-30T10:10:01.000Z";
  const renewed = await h.read();
  assert.deepEqual(renewed.pairState, { pairVersion: "1", status: "active", requiresRebind: false });
  assert.equal(renewed.binding?.expiresAt, "2026-08-30T10:20:01.000Z");
  assert.deepEqual({ ...renewed.binding, expiresAt: h.receipt.expiresAt,
    canonicalPayloadSha256: h.receipt.canonicalPayloadSha256 }, h.receipt);
  const child = h.pool.watchLeases.get(WATCH_LEASE_ID)!;
  assert.equal(child.expires_at, renewed.binding?.expiresAt);
  assert.equal(child.lease_version, "2"); assert.equal(child.fencing_token, "2");
  const writes = h.pool.writes;
  assert.deepEqual(await h.read(), renewed);
  assert.equal(h.pool.writes, writes, "repeated reads outside the renewal window do not mutate leases");
  h.pool.now = "2026-08-30T10:59:00.000Z";
  assert.equal((await h.read()).binding?.expiresAt, AUTHORITY_EXPIRES);
  h.pool.now = AUTHORITY_EXPIRES;
  await assert.rejects(h.read(), /AUTHORITY_MISMATCH|PRIMARY_.*EXPIRED/);
});

test("formal renewal cannot revive revoked identity or follow parent rotation", async () => {
  for (const failure of ["revoked", "principal", "parent", "lease", "released"] as const) {
    const h = await formalHarness();
    h.pool.now = "2026-08-30T10:10:01.000Z";
    if (failure === "principal") h.auth.principalRef = "different-principal";
    if (failure === "parent" || failure === "lease") {
      const receipt = failure === "parent"
        ? { ...h.receipt, realtimeSessionRef: { ...SESSION_REF, ref_id: WATCH_LEASE_ID } }
        : { ...h.receipt, iphone: { ...h.receipt.iphone, deviceLeaseRef: { ...IPHONE_LEASE_REF, ref_id: "019b0000-0000-7000-8000-000000000199" } } };
      const { canonicalPayloadSha256: _old, ...clean } = receipt;
      receipt.canonicalPayloadSha256 = createHash("sha256").update(`paios.t02.apple-watch-binding.receipt.v1\n${stable(clean)}`).digest("hex");
      Object.assign(h.pool.row!, { realtime_session_ref: receipt.realtimeSessionRef,
        session_ref_id: (receipt.realtimeSessionRef as any).ref_id, iphone_device_lease_ref: receipt.iphone.deviceLeaseRef,
        iphone_lease_ref_id: (receipt.iphone.deviceLeaseRef as any).ref_id,
        canonical_payload_sha256: receipt.canonicalPayloadSha256, receipt_jcs: stable(receipt) });
    }
    if (failure === "revoked") {
      const receipt = { ...h.receipt, status: "revoked" as const };
      const { canonicalPayloadSha256: _old, ...clean } = receipt;
      receipt.canonicalPayloadSha256 = createHash("sha256").update(`paios.t02.apple-watch-binding.receipt.v1\n${stable(clean)}`).digest("hex");
      Object.assign(h.pool.row!, { state: "revoked", revoked_at: h.pool.now,
        canonical_payload_sha256: receipt.canonicalPayloadSha256, receipt_jcs: stable(receipt) });
    }
    if (failure === "released") h.pool.watchLeases.get(WATCH_LEASE_ID)!.state = "released";
    const before = h.pool.writes;
    {
      const result = await h.read();
      assert.equal(result.pairState.requiresRebind, true, failure);
      assert.equal(result.binding, undefined);
    }
    assert.equal(h.pool.writes, before, failure + " must not renew");
  }
});


test("formal renewal needs live authenticated owner and live parent authority", async () => {
  for (const failure of ["owner", "bearer", "parent"] as const) {
    const h = await formalHarness(failure === "parent" ? { authorityExpiresAt: "2026-08-30T10:10:00.000Z" } : {});
    h.pool.now = "2026-08-30T10:10:01.000Z";
    if (failure === "owner") h.auth.userId = CONTINUITY_ID;
    if (failure === "bearer") h.auth.expiresAt = h.pool.now;
    const before = h.pool.writes;
    await assert.rejects(h.read(), /AUTHORITY_MISMATCH|PRIMARY_.*EXPIRED/);
    assert.equal(h.pool.writes, before);
  }
});

test("formal renewal starts before expiry on the existing credential refresh schedule", async () => {
  const h = await formalHarness();
  h.pool.now = "2026-08-30T10:09:00.000Z";
  const result = await h.read();
  assert.equal(result.binding?.expiresAt, "2026-08-30T10:19:00.000Z");
  assert.equal(result.binding?.pairVersion, "1");
  assert.equal(result.binding?.installationId, h.receipt.installationId);
  assert.equal(result.pairState.requiresRebind, false);
});
