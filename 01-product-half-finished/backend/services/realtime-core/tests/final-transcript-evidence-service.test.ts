import assert from "node:assert/strict";
import test from "node:test";

import {
  createFinalTranscriptEvidenceService,
  FinalTranscriptEvidenceError,
  type FinalTranscriptEvidenceInput,
  type T11BCanonicalRef,
} from "../src/final-transcript-evidence-service.ts";
import type {
  RealtimeAuthorityRepository,
  RealtimeAuthorityTransaction,
} from "../src/ports.ts";
import type {
  CanonicalTimestamp,
  DeviceLeaseRecord,
  IdempotencyRecord,
  OpaqueCanonicalRef,
  RealtimeSessionRecord,
} from "../src/types.ts";

const SESSION_REF = Object.freeze({ kind: "RealtimeSession", id: "session-final-transcript" });
const LEASE_REF = Object.freeze({ kind: "DeviceLease", id: "lease-final-transcript" });
const OUTBOX_REF = Object.freeze({ kind: "OutboxEvent", id: "outbox-final-transcript" });
const OBSERVED_AT = "2026-08-27T01:02:03.123Z" as CanonicalTimestamp;
const SESSION_EXPIRES = "2026-08-27T02:02:03.123Z" as CanonicalTimestamp;
const HASH = "a".repeat(64);

function ref(
  refType: T11BCanonicalRef["refType"],
  refId: string,
  hash = HASH,
): T11BCanonicalRef {
  return Object.freeze({
    refType,
    refId,
    objectVersion: "1",
    canonicalPayloadSha256: hash,
  });
}

function input(overrides: Partial<FinalTranscriptEvidenceInput> = {}): FinalTranscriptEvidenceInput {
  return {
    transcriptState: "final",
    userId: "user-final-transcript-001",
    deviceId: "rayneo-final-transcript-001",
    realtimeSessionRef: SESSION_REF,
    continuityId: "01952f00-0000-7000-8000-000000000101",
    purpose: "conversation",
    text: "请记住巡检测试词。",
    language: "zh-CN",
    sourceMediaRef: ref("SourceArtifact", "01952f00-0000-7000-8000-000000000201"),
    observedAt: OBSERVED_AT,
    idempotencyKey: "final-transcript-evidence-001" as FinalTranscriptEvidenceInput["idempotencyKey"],
    ...overrides,
  };
}

function session(overrides: Partial<RealtimeSessionRecord> = {}): RealtimeSessionRecord {
  return {
    realtimeSessionRef: SESSION_REF,
    userId: "user-final-transcript-001" as RealtimeSessionRecord["userId"],
    continuityId: "01952f00-0000-7000-8000-000000000101" as RealtimeSessionRecord["continuityId"],
    state: "active",
    continuityState: "active",
    connectionEpoch: "1" as RealtimeSessionRecord["connectionEpoch"],
    continuityExpiresAt: SESSION_EXPIRES,
    lastAcceptedUserActivityAt: OBSERVED_AT,
    activeDeviceId: "rayneo-final-transcript-001" as RealtimeSessionRecord["activeDeviceId"],
    activeDeviceLeaseRef: LEASE_REF,
    binding: {
      state: "connected",
      realtimeSessionRef: SESSION_REF,
      deviceLeaseRef: LEASE_REF,
      continuityId: "01952f00-0000-7000-8000-000000000101" as RealtimeSessionRecord["continuityId"],
      deviceId: "rayneo-final-transcript-001" as RealtimeSessionRecord["activeDeviceId"],
      connectionEpoch: "1" as RealtimeSessionRecord["connectionEpoch"],
      provider: { provider: "livekit", value: "provider-final-transcript" },
      transportSessionAlias: { provider: "livekit", value: "transport-final-transcript" },
      roomAlias: { provider: "livekit", value: "room-final-transcript" },
      deviceAlias: { provider: "livekit", value: "device-final-transcript" },
      connectionId: "connection-final-transcript",
    },
    revision: "1" as RealtimeSessionRecord["revision"],
    ...overrides,
  };
}

function lease(overrides: Partial<DeviceLeaseRecord> = {}): DeviceLeaseRecord {
  return {
    deviceLeaseRef: LEASE_REF,
    realtimeSessionRef: SESSION_REF,
    continuityId: "01952f00-0000-7000-8000-000000000101" as DeviceLeaseRecord["continuityId"],
    userId: "user-final-transcript-001" as DeviceLeaseRecord["userId"],
    deviceId: "rayneo-final-transcript-001" as DeviceLeaseRecord["deviceId"],
    state: "active",
    capabilities: ["microphone"],
    purpose: "conversation",
    issuedAt: "2026-08-27T00:02:03.123Z" as CanonicalTimestamp,
    expiresAt: SESSION_EXPIRES,
    revocable: true,
    leaseVersion: "1" as DeviceLeaseRecord["leaseVersion"],
    fencingToken: "1" as DeviceLeaseRecord["fencingToken"],
    policyDecisionRef: { kind: "PolicyDecision", id: "policy-final-transcript" },
    ...overrides,
  };
}

class Repository implements RealtimeAuthorityRepository {
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly committedOutbox: Array<Readonly<Record<string, unknown>>> = [];
  appendAttempts = 0;
  writeAttempts = 0;
  currentSession: RealtimeSessionRecord | undefined = session();
  currentLease: DeviceLeaseRecord | undefined = lease();
  failWrite = false;

  async transaction<T>(
    _operation: string,
    work: (transaction: RealtimeAuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    const stagedOutbox: Array<Readonly<Record<string, unknown>>> = [];
    const stagedIdempotency = new Map(this.idempotency);
    const transaction = {
      readSession: async () => this.currentSession,
      readSessionByContinuityId: async () => this.currentSession,
      readLease: async () => this.currentLease,
      readCurrentBinding: async () => undefined,
      readActiveDeviceSessions: async () => [],
      readIdempotency: async (operation: string, key: string) =>
        stagedIdempotency.get(`${operation}:${key}`),
      writeSession: async () => undefined,
      writeLease: async () => undefined,
      writeBinding: async () => undefined,
      recordHandoffFact: async () => undefined,
      writeIdempotency: async (record: IdempotencyRecord) => {
        this.writeAttempts += 1;
        if (this.failWrite) throw new Error("simulated write failure");
        stagedIdempotency.set(`${record.operation}:${record.idempotencyKey}`, record);
      },
      appendOutbox: async (event: Readonly<Record<string, unknown>>) => {
        this.appendAttempts += 1;
        stagedOutbox.push(event);
        return OUTBOX_REF as OpaqueCanonicalRef;
      },
    } as unknown as RealtimeAuthorityTransaction;
    const result = await work(transaction);
    this.idempotency.clear();
    for (const [key, value] of stagedIdempotency) this.idempotency.set(key, value);
    this.committedOutbox.push(...stagedOutbox);
    return result;
  }
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof FinalTranscriptEvidenceError && error.code === expected;
}

test("final segment writes one deterministic evidence result and exact replay writes zero", async () => {
  const repository = new Repository();
  const firstService = createFinalTranscriptEvidenceService(repository);
  const first = await firstService.finalize(input());
  assert.equal(first.transcriptSegmentRef.refType, "TranscriptSegment");
  assert.equal(first.evidenceRef.refType, "FinalTranscriptEvidence");
  assert.match(first.transcriptSegmentRef.refId, /^[0-9a-f-]{36}$/u);
  assert.match(first.evidenceRef.refId, /^[0-9a-f-]{36}$/u);
  assert.notEqual(first.transcriptSegmentRef.refId, first.evidenceRef.refId);
  assert.equal(repository.committedOutbox.length, 1);
  assert.equal(repository.writeAttempts, 1);

  const restartedService = createFinalTranscriptEvidenceService(repository);
  const replay = await restartedService.finalize(input());
  assert.deepEqual(replay, first);
  assert.equal(repository.committedOutbox.length, 1);
  assert.equal(repository.appendAttempts, 1);
  assert.equal(repository.writeAttempts, 1);
});

test("same-key drift conflicts before another outbox or idempotency write", async () => {
  const repository = new Repository();
  const service = createFinalTranscriptEvidenceService(repository);
  await service.finalize(input());
  await assert.rejects(
    service.finalize(input({ text: "请记住另一个词。" })),
    code("FINAL_TRANSCRIPT_IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(repository.committedOutbox.length, 1);
  assert.equal(repository.writeAttempts, 1);
});

test("partial, interim, malformed and extra input are rejected with zero writes", async () => {
  const cases: unknown[] = [
    { ...input(), transcriptState: "partial" },
    { ...input(), transcriptState: "interim" },
    { ...input(), text: "" },
    { ...input(), observedAt: "2026-08-27T01:02:03Z" },
    { ...input(), providerToken: "forbidden" },
  ];
  for (const item of cases) {
    const repository = new Repository();
    await assert.rejects(
      createFinalTranscriptEvidenceService(repository).finalize(item as FinalTranscriptEvidenceInput),
      (error: unknown) => error instanceof FinalTranscriptEvidenceError,
    );
    assert.equal(repository.appendAttempts, 0);
    assert.equal(repository.writeAttempts, 0);
  }
});

test("session, identity, lease purpose and expiry drift fail closed before persistence", async () => {
  const repositories = [
    Object.assign(new Repository(), { currentSession: undefined }),
    Object.assign(new Repository(), { currentSession: session({ activeDeviceId: "other-device" as RealtimeSessionRecord["activeDeviceId"] }) }),
    Object.assign(new Repository(), { currentLease: lease({ purpose: "other-purpose" }) }),
    Object.assign(new Repository(), { currentLease: lease({ state: "released" }) }),
  ];
  for (const repository of repositories) {
    await assert.rejects(
      createFinalTranscriptEvidenceService(repository).finalize(input()),
      (error: unknown) => error instanceof FinalTranscriptEvidenceError,
    );
    assert.equal(repository.appendAttempts, 0);
    assert.equal(repository.writeAttempts, 0);
  }
});

test("correction emits a new immutable evidence ref with complete supersession lineage", async () => {
  const repository = new Repository();
  const original = await createFinalTranscriptEvidenceService(repository).finalize(input());
  const corrected = await createFinalTranscriptEvidenceService(repository).finalize(input({
    text: "请记住巡检校正词。",
    idempotencyKey: "final-transcript-evidence-002" as FinalTranscriptEvidenceInput["idempotencyKey"],
    correction: {
      previousTranscriptSegmentRef: original.transcriptSegmentRef,
      previousFinalEvidenceRef: original.evidenceRef,
      correctionReason: "user correction",
    },
  }));
  assert.notEqual(corrected.transcriptSegmentRef.refId, original.transcriptSegmentRef.refId);
  assert.notEqual(corrected.evidenceRef.refId, original.evidenceRef.refId);
  const payload = repository.committedOutbox[1]?.payload as {
    readonly evidence?: { readonly supersedes?: Record<string, unknown> };
  };
  assert.deepEqual(payload.evidence?.supersedes, {
    previousTranscriptSegmentRef: original.transcriptSegmentRef,
    previousFinalEvidenceRef: original.evidenceRef,
    correctionReason: "user correction",
  });
});

test("transaction failure leaves no committed outbox or replay record", async () => {
  const repository = new Repository();
  repository.failWrite = true;
  await assert.rejects(
    createFinalTranscriptEvidenceService(repository).finalize(input()),
    /simulated write failure/u,
  );
  assert.equal(repository.committedOutbox.length, 0);
  assert.equal(repository.idempotency.size, 0);
});
