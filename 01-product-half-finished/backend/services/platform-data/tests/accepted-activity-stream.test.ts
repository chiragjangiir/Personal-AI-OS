import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCEPTED_ACTIVITY_EVENT_TYPE,
  ACCEPTED_ACTIVITY_STREAM_CHANNEL,
  AcceptedActivityStreamError,
  createAcceptedActivityStream,
  T04_ACCEPTED_ACTIVITY_EVENT_TYPE,
  type AcceptedActivityStreamClient,
  type AcceptedActivityStreamPool,
} from "../src/accepted-activity-stream.ts";

const HASH_A = "a".repeat(64);
const SESSION_ID = "01952f00-0000-7000-8000-000000000101";
const LEASE_ID = "01952f00-0000-7000-8000-000000000102";
const USER_ID = "01952f00-0000-7000-8000-000000000103";
const DEVICE_ID = "01952f00-0000-7000-8000-000000000104";
const CONTINUITY_ID = "01952f00-0000-7000-8000-000000000105";
const EVENT_ID = "01952f00-0000-4000-8000-000000000106";
const ACCEPTED_AT = "2026-08-27T01:02:04.123Z";
const OCCURRED_AT = "2026-08-27T01:02:03.123Z";
const NOTIFICATION_PAYLOAD = JSON.stringify({ cursor: "10", event_id: EVENT_ID });

class NotificationResponseMessage {
  readonly length: number;
  readonly processId: number;
  readonly channel: typeof ACCEPTED_ACTIVITY_STREAM_CHANNEL;
  readonly payload: string;
  readonly name: "notification";

  constructor(payload: string = NOTIFICATION_PAYLOAD, processId = 1, length = 1) {
    this.length = length;
    this.processId = processId;
    this.channel = ACCEPTED_ACTIVITY_STREAM_CHANNEL;
    this.payload = payload;
    this.name = "notification";
  }
}

class ArbitraryThreeFieldNotification {
  readonly processId = 1;
  readonly channel = ACCEPTED_ACTIVITY_STREAM_CHANNEL;
  readonly payload = NOTIFICATION_PAYLOAD;
}

const VALID_NOTIFICATION_CONSTRUCTOR = class NotificationResponseMessage {};
const WRONG_NOTIFICATION_CONSTRUCTOR = class WrongNotificationResponseMessage {};

function plainNotification(payload: unknown = NOTIFICATION_PAYLOAD, processId: unknown = 1): Record<string, unknown> {
  return { processId, channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL, payload };
}

function nullPrototypeNotification(
  payload: unknown = NOTIFICATION_PAYLOAD,
  processId: unknown = 1,
): Record<string, unknown> {
  const message = Object.create(null) as Record<string, unknown>;
  message.processId = processId;
  message.channel = ACCEPTED_ACTIVITY_STREAM_CHANNEL;
  message.payload = payload;
  return message;
}

function pgNotificationWithPrototype(
  prototype: object,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    length: 1,
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: NOTIFICATION_PAYLOAD,
    name: "notification",
    ...overrides,
  };
  const message = Object.create(prototype) as Record<string, unknown>;
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(message, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return message;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function ownerRef(refType: "RealtimeSession" | "DeviceLease", refId: string, hashValue = HASH_A): Record<string, string> {
  return {
    ref_type: refType,
    ref_id: refId,
    object_version: "1",
    canonical_payload_sha256: hashValue,
  };
}

const SESSION_REF = ownerRef("RealtimeSession", SESSION_ID);
const LEASE_REF = ownerRef("DeviceLease", LEASE_ID);
const ACCEPTANCE_REF = Object.freeze({ kind: "ContextAssertion", ref: "acceptance-1" });
const WATERMARK = Object.freeze({ kind: "ActivityAuthority", watermark: "42" });

function activity(activityId: string): Record<string, unknown> {
  return {
    activityId,
    accepted: true,
    acceptanceRef: ACCEPTANCE_REF,
    continuityId: CONTINUITY_ID,
    deviceId: DEVICE_ID,
    kind: "accepted_user_activity",
    occurredAt: OCCURRED_AT,
    realtimeSessionRef: SESSION_REF,
    userId: USER_ID,
  };
}

function response(revision: string): Record<string, unknown> {
  return {
    activeDeviceId: DEVICE_ID,
    activeDeviceLeaseRef: LEASE_REF,
    binding: {
      connectionEpoch: "7",
      continuityId: CONTINUITY_ID,
      deviceId: DEVICE_ID,
      deviceLeaseRef: LEASE_REF,
      realtimeSessionRef: SESSION_REF,
      state: "connected",
    },
    connectionEpoch: "7",
    continuityId: CONTINUITY_ID,
    lastAcceptedUserActivityAt: ACCEPTED_AT,
    realtimeSessionRef: SESSION_REF,
    revision,
    state: "active",
    continuityState: "active",
    userId: USER_ID,
  };
}

function row(cursor: string, eventId = EVENT_ID, revision = "2"): Record<string, unknown> {
  const activityId = `activity-${cursor}`;
  const request = activity(activityId);
  const payload = {
    acceptanceRef: ACCEPTANCE_REF,
    activityId,
    authorityWatermark: WATERMARK,
    continuityId: CONTINUITY_ID,
  };
  const ledgerResponse = response(revision);
  return {
    accepted_activity_cursor: cursor,
    available_at: "2026-08-27T01:02:04.123Z",
    aggregate_id: SESSION_ID,
    aggregate_ref: SESSION_REF,
    aggregate_type: "realtime",
    event_id: eventId,
    event_type: ACCEPTED_ACTIVITY_EVENT_TYPE,
    event_version: 1,
    idempotency_key: activityId,
    idempotency_scope: "realtime.outbox",
    ledger_idempotency_key: activityId,
    ledger_request_fingerprint: canonicalJson(request),
    ledger_request_hash: hash(request),
    ledger_response: ledgerResponse,
    ledger_response_hash: hash(ledgerResponse),
    ledger_scope: "activity_renewal",
    ledger_status: "committed",
    outbox_payload: payload,
    outbox_payload_sha256: hash(payload),
  };
}

function t04Row(cursor: string, eventId = EVENT_ID, previousAcceptedAt = OCCURRED_AT): Record<string, unknown> {
  const base = row(cursor, eventId);
  const activityId = `activity-${cursor}`;
  const actionReceipt = {
    kind: "t04.accepted_user_action_receipt",
    activityId,
    action: "cycling_start",
    purpose: "cycling_assistant",
    origin: "iphone",
    committed: true,
    revoked: false,
    deleted: false,
    stale: false,
    bindingCommitted: false,
  };
  const currentBinding = {
    userId: USER_ID,
    activeDeviceId: DEVICE_ID,
    realtimeSessionRef: SESSION_REF,
    continuityId: CONTINUITY_ID,
    sessionState: "active",
    continuityState: "active",
    transportState: "connected",
    leaseState: "active",
    lastAcceptedUserActivityAt: previousAcceptedAt,
    continuityExpiresAt: "2026-08-27T01:12:04.123Z",
    leaseExpiresAt: "2026-08-27T01:12:04.123Z",
  };
  const authorityProjection = {
    kind: "t04.activity_authority_projection",
    environment: "production",
    activityId,
    origin: "user",
    userOriginated: true,
    accepted: true,
    current: true,
    deleted: false,
    suppressed: false,
    stale: false,
    purpose: "cycling_assistant",
    userId: USER_ID,
    deviceId: DEVICE_ID,
    realtimeSessionRef: SESSION_REF,
    continuityId: CONTINUITY_ID,
    sessionTime: OCCURRED_AT,
    acceptanceRef: ACCEPTANCE_REF,
    authorityWatermark: WATERMARK,
    watermarkCurrent: true,
    evidence: [{
      kind: "ContextAssertion",
      evidenceRef: ACCEPTANCE_REF,
      activityId,
      userOriginated: true,
      authority: true,
      current: true,
      deleted: false,
      suppressed: false,
      stale: false,
    }],
  };
  const payload = {
    acceptanceRef: ACCEPTANCE_REF,
    activityId,
    authorityProjection,
    authorityWatermark: WATERMARK,
    continuityId: CONTINUITY_ID,
    currentBinding,
    actionReceipt,
  };
  // T02 fingerprints a T04-owned activity together with its owner event.
  const ledgerRequest = { activity: activity(activityId), ownerEvent: { actionReceipt, authorityProjection, currentBinding } };
  return {
    ...base,
    event_id: eventId,
    event_type: T04_ACCEPTED_ACTIVITY_EVENT_TYPE,
    ledger_request_fingerprint: canonicalJson(ledgerRequest),
    ledger_request_hash: hash(ledgerRequest),
    outbox_payload: payload,
    outbox_payload_sha256: hash(payload),
  };
}

type Listener = (...args: readonly unknown[]) => void;

class FakeClient implements AcceptedActivityStreamClient {
  readonly queries: string[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  releaseCount = 0;
  releasedWith: unknown[] = [];
  readRows: readonly Record<string, unknown>[] = [];

  async query(text: string): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    const normalized = text.replace(/\s+/gu, " ").trim();
    this.queries.push(normalized);
    if (normalized.startsWith("SELECT")) return { rows: this.readRows };
    return { rows: [] };
  }

  on(event: string, listener: Listener): this {
    let entries = this.listeners.get(event);
    if (entries === undefined) {
      entries = new Set();
      this.listeners.set(event, entries);
    }
    entries.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  release(error?: unknown): void {
    this.releaseCount += 1;
    this.releasedWith.push(error);
  }
}

class BlockingListenClient extends FakeClient {
  private readonly listenGate: Promise<void>;
  private readonly onListenStarted: () => void;
  private readonly onListenCompleted: () => void;

  constructor(
    listenGate: Promise<void>,
    onListenStarted: () => void,
    onListenCompleted: () => void,
  ) {
    super();
    this.listenGate = listenGate;
    this.onListenStarted = onListenStarted;
    this.onListenCompleted = onListenCompleted;
  }

  async query(text: string): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    const normalized = text.replace(/\s+/gu, " ").trim();
    if (normalized === `LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`) {
      this.onListenStarted();
      await this.listenGate;
      const result = await super.query(text);
      this.onListenCompleted();
      return result;
    }
    return super.query(text);
  }
}

class FakePool implements AcceptedActivityStreamPool {
  readonly clients: FakeClient[];
  connectCount = 0;
  endCount = 0;

  constructor(...clients: FakeClient[]) {
    this.clients = clients;
  }

  async connect(): Promise<AcceptedActivityStreamClient> {
    const client = this.clients[Math.min(this.connectCount, this.clients.length - 1)];
    this.connectCount += 1;
    if (client === undefined) throw new Error("NO_MORE_CLIENTS");
    return client;
  }

  async end(): Promise<void> {
    this.endCount += 1;
  }
}

function errorCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) =>
    error instanceof AcceptedActivityStreamError && error.code === code,
  ).then(() => undefined);
}

async function within<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("TEST_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("readAfter uses a repeatable-read snapshot, skips cursor gaps, and returns an opaque next cursor", async () => {
  const client = new FakeClient();
  client.readRows = [row("2"), row("5", "01952f00-0000-4000-8000-000000000107", "3"), row("9007199254740993", "01952f00-0000-4000-8000-000000000108", "4")];
  const pool = new FakePool(client);
  const stream = createAcceptedActivityStream(pool);

  const page = await stream.readAfter("0", 2);
  assert.deepEqual(page.items.map((item) => item.cursor), ["2", "5"]);
  assert.equal(page.nextCursor, "5");
  assert.equal(page.hasMore, true);
  assert.equal(page.items[0]?.outboxPayloadSha256, hash(page.items[0]?.outboxPayload));
  assert.equal(Object.hasOwn(page.items[0]!, "ledgerResponse"), false);
  assert.equal(Object.hasOwn(page.items[0]!, "status"), false);
  assert.ok(client.queries.includes("BEGIN"));
  assert.ok(client.queries.some((query) => query.startsWith("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")));
  assert.ok(client.queries.some((query) => query.includes("LEFT JOIN public.idempotency_ledger")));
  assert.ok(client.queries.some((query) => query.includes("o.accepted_activity_cursor > $1::bigint")));
  assert.ok(client.queries.some((query) => query.includes("ORDER BY o.accepted_activity_cursor ASC")));
  assert.ok(client.queries.some((query) => query.includes("LIMIT $2")));
  assert.equal(client.releaseCount, 1);
  await stream.close();
  assert.equal(pool.endCount, 0);
});

test("delivery retry may change available_at without changing ledger-authoritative acceptedAt", async () => {
  const client = new FakeClient();
  const retried = row("2");
  retried.available_at = "2036-08-27T01:02:04.123Z";
  client.readRows = [retried];
  const stream = createAcceptedActivityStream(new FakePool(client));

  const page = await stream.readAfter("0", 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.acceptedAt, ACCEPTED_AT);
  assert.equal(client.queries.some((query) => query.includes("available_at")), false);
  await stream.close();
});

test("readAfter rejects noncanonical/overflow cursors, bad limits, gaps returned out of order, and hash drift", async () => {
  const client = new FakeClient();
  const stream = createAcceptedActivityStream(new FakePool(client));
  await errorCode(stream.readAfter("01", 1), "ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID");
  await errorCode(stream.readAfter("-1", 1), "ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID");
  await errorCode(stream.readAfter(1 as unknown as string, 1), "ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID");
  await errorCode(stream.readAfter("9223372036854775808", 1), "ACCEPTED_ACTIVITY_STREAM_CURSOR_INVALID");
  await errorCode(stream.readAfter("0", 0), "ACCEPTED_ACTIVITY_STREAM_LIMIT_INVALID");
  await errorCode(stream.readAfter("0", 501), "ACCEPTED_ACTIVITY_STREAM_LIMIT_INVALID");

  client.readRows = [row("5"), row("2", "01952f00-0000-4000-8000-000000000107")];
  await errorCode(stream.readAfter("0", 2), "ACCEPTED_ACTIVITY_STREAM_ROW_INVALID");

  const drift = row("2");
  drift.outbox_payload_sha256 = "b".repeat(64);
  client.readRows = [drift];
  await errorCode(stream.readAfter("0", 1), "ACCEPTED_ACTIVITY_STREAM_HASH_DRIFT");
  await stream.close();
});

test("readAfter rejects ledger and exact binding drift without exposing raw ledger state", async () => {
  const client = new FakeClient();
  const stream = createAcceptedActivityStream(new FakePool(client));
  const badLedger = row("1");
  badLedger.ledger_status = "in_flight";
  client.readRows = [badLedger];
  await errorCode(stream.readAfter("0", 1), "ACCEPTED_ACTIVITY_STREAM_LEDGER_DRIFT");

  const badBinding = row("2");
  const badResponse = response("2");
  badResponse.activeDeviceId = "01952f00-0000-7000-8000-000000000199";
  badBinding.ledger_response = badResponse;
  badBinding.ledger_response_hash = hash(badResponse);
  client.readRows = [badBinding];
  await errorCode(stream.readAfter("0", 1), "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  await stream.close();
});

test("subscribeWakeups serializes notifications behind the mandatory initial catch-up", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client);
  const calls: Array<unknown> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let resolveFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const stream = createAcceptedActivityStream(pool, { reconnectInitialDelayMs: 0, reconnectMaxDelayMs: 0 });
  const subscribeFlight = stream.subscribeWakeups(async (wakeup) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls.push(wakeup);
    try {
      if (calls.length === 1) {
        resolveFirstStarted!();
        await firstPending;
      }
    } finally {
      concurrent -= 1;
    }
  });
  await firstStarted;
  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined);
  assert.equal(client.queries[0], `LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`);

  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "10", event_id: EVENT_ID }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  assert.equal(calls.length, 1);
  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "11", event_id: "01952f00-0000-4000-8000-000000000107" }),
  });
  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "12", event_id: "01952f00-0000-4000-8000-000000000108" }),
  });
  assert.equal(maxConcurrent, 1);
  assert.equal(calls.length, 1);
  releaseFirst!();
  const unsubscribe = await subscribeFlight;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { cursor: "12", eventId: "01952f00-0000-4000-8000-000000000108" });
  await unsubscribe();
  assert.ok(client.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(client.releaseCount, 1);
  const callsAfterUnsubscribe = calls.length;
  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "13", event_id: "01952f00-0000-4000-8000-000000000109" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterUnsubscribe);
  await stream.close();
  await stream.close();
  assert.equal(pool.endCount, 0);
});

test("reconnect serializes notifications behind its mandatory catch-up", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  const pool = new FakePool(first, second);
  const calls: Array<unknown> = [];
  const errors: unknown[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let resolveReconnectStarted: (() => void) | undefined;
  const reconnectStarted = new Promise<void>((resolve) => { resolveReconnectStarted = resolve; });
  let releaseReconnect: (() => void) | undefined;
  const reconnectPending = new Promise<void>((resolve) => { releaseReconnect = resolve; });
  const stream = createAcceptedActivityStream({
    pool,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    onError: (error) => { errors.push(error); },
  });
  await stream.subscribeWakeups(async (wakeup) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls.push(wakeup);
    try {
      if (calls.length === 2) {
        resolveReconnectStarted!();
        await reconnectPending;
      }
    } finally {
      concurrent -= 1;
    }
  });
  assert.equal(calls.length, 1);
  first.emit("error", new Error("listener lost"));
  await reconnectStarted;
  assert.equal(pool.connectCount, 2);
  assert.equal(first.releaseCount, 1);
  assert.ok(second.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(calls.length, 2);
  assert.equal(calls[1], undefined);
  second.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "10", event_id: EVENT_ID }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  assert.equal(calls.length, 2);
  releaseReconnect!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], { cursor: "10", eventId: EVENT_ID });
  assert.equal(errors.length, 0);
  await stream.close();
  const callsAfterClose = calls.length;
  second.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "11", event_id: "01952f00-0000-4000-8000-000000000107" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterClose);
  await stream.close();
  assert.equal(second.releaseCount, 1);
  assert.equal(pool.endCount, 0);
});

test("unsubscribe owns the current reconnected listener and stale calls spare later subscriptions", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  const third = new FakeClient();
  const pool = new FakePool(first, second, third);
  const calls: Array<unknown> = [];
  let resolveReconnectStarted: (() => void) | undefined;
  const reconnectStarted = new Promise<void>((resolve) => { resolveReconnectStarted = resolve; });
  const stream = createAcceptedActivityStream({
    pool,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  const unsubscribe = await stream.subscribeWakeups((wakeup) => {
    calls.push(wakeup);
    if (calls.length === 2) resolveReconnectStarted!();
  });
  first.emit("error", new Error("listener lost"));
  await within(reconnectStarted);
  assert.equal(pool.connectCount, 2);
  assert.equal(calls.length, 2);
  await unsubscribe();
  assert.ok(second.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(second.releaseCount, 1);
  assert.equal([...second.listeners.values()].some((listeners) => listeners.size > 0), false);
  const callsAfterUnsubscribe = calls.length;
  await unsubscribe();
  second.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "10", event_id: EVENT_ID }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterUnsubscribe);
  assert.equal(pool.connectCount, 2);

  const laterCalls: Array<unknown> = [];
  const laterUnsubscribe = await stream.subscribeWakeups((wakeup) => { laterCalls.push(wakeup); });
  assert.equal(laterCalls.length, 1);
  assert.equal(laterCalls[0], undefined);
  assert.ok(third.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  await unsubscribe();
  assert.equal(laterCalls.length, 1);
  assert.equal(third.releaseCount, 0);
  await laterUnsubscribe();
  assert.ok(third.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(third.releaseCount, 1);
  await stream.close();
});

test("notification handler may await its own unsubscribe without deadlock", async () => {
  const client = new FakeClient();
  const calls: Array<unknown> = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const stream = createAcceptedActivityStream(new FakePool(client), {
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  unsubscribe = await stream.subscribeWakeups(async (wakeup) => {
    calls.push(wakeup);
    if (wakeup !== undefined) {
      await unsubscribe!();
      resolveCompleted!();
    }
  });
  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "10", event_id: EVENT_ID }),
  });
  await within(completed);
  assert.equal(calls.length, 2);
  assert.ok(client.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(client.releaseCount, 1);
  assert.equal([...client.listeners.values()].some((listeners) => listeners.size > 0), false);
  const callsAfterUnsubscribe = calls.length;
  await unsubscribe();
  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "11", event_id: "01952f00-0000-4000-8000-000000000107" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterUnsubscribe);
  assert.equal(client.releaseCount, 1);
  await stream.close();
});

test("reconnect catch-up handler may await its own unsubscribe without deadlock", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  const pool = new FakePool(first, second);
  const calls: Array<unknown> = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  let resolveCatchupStarted: (() => void) | undefined;
  const catchupStarted = new Promise<void>((resolve) => { resolveCatchupStarted = resolve; });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const stream = createAcceptedActivityStream({
    pool,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  unsubscribe = await stream.subscribeWakeups(async (wakeup) => {
    calls.push(wakeup);
    if (calls.length === 2) {
      resolveCatchupStarted!();
      await unsubscribe!();
      resolveCompleted!();
    }
  });
  first.emit("error", new Error("listener lost"));
  await within(catchupStarted);
  await within(completed);
  assert.equal(calls.length, 2);
  assert.ok(second.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(second.releaseCount, 1);
  assert.equal([...second.listeners.values()].some((listeners) => listeners.size > 0), false);
  const callsAfterUnsubscribe = calls.length;
  await unsubscribe();
  second.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "10", event_id: EVENT_ID }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, callsAfterUnsubscribe);
  assert.equal(pool.connectCount, 2);
  await stream.close();
});

test("handler resubscribe is rejected until its invocation returns", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  const pool = new FakePool(first, second);
  const calls: Array<unknown> = [];
  const laterCalls: Array<unknown> = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  let resolveAttempt: (() => void) | undefined;
  const attempt = new Promise<void>((resolve) => { resolveAttempt = resolve; });
  let reentrantError: unknown;
  const stream = createAcceptedActivityStream(pool, {
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  unsubscribe = await stream.subscribeWakeups(async (wakeup) => {
    calls.push(wakeup);
    if (wakeup !== undefined) {
      await unsubscribe!();
      try {
        await stream.subscribeWakeups(() => undefined);
      } catch (error) {
        reentrantError = error;
      } finally {
        resolveAttempt!();
      }
    }
  });
  first.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "10", event_id: EVENT_ID }),
  });
  await within(attempt);
  assert.ok(reentrantError instanceof AcceptedActivityStreamError);
  assert.equal((reentrantError as AcceptedActivityStreamError).code, "ACCEPTED_ACTIVITY_STREAM_REENTRANT_SUBSCRIBE_FORBIDDEN");
  assert.equal(calls.length, 2);
  assert.equal(first.releaseCount, 1);
  assert.equal(pool.connectCount, 1);
  assert.equal([...first.listeners.values()].some((listeners) => listeners.size > 0), false);

  const laterUnsubscribe = await stream.subscribeWakeups((wakeup) => { laterCalls.push(wakeup); });
  assert.equal(laterCalls.length, 1);
  assert.equal(laterCalls[0], undefined);
  assert.equal(pool.connectCount, 2);
  assert.ok(second.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  await unsubscribe();
  assert.equal(second.releaseCount, 0);
  await laterUnsubscribe();
  assert.equal(second.releaseCount, 1);
  assert.ok(second.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  await stream.close();
});

test("stale reconnect cannot overwrite a later subscription after its factory resolves", async () => {
  const first = new FakeClient();
  const current = new FakeClient();
  const stale = new FakeClient();
  const calls: Array<unknown> = [];
  const laterCalls: Array<unknown> = [];
  let factoryCalls = 0;
  let resolveReconnectStarted: (() => void) | undefined;
  const reconnectStarted = new Promise<void>((resolve) => { resolveReconnectStarted = resolve; });
  let resolveStale: ((client: AcceptedActivityStreamClient) => void) | undefined;
  const staleFactory = new Promise<AcceptedActivityStreamClient>((resolve) => { resolveStale = resolve; });
  const stream = createAcceptedActivityStream({
    pool: new FakePool(first, current, stale),
    listenerClientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 2) {
        resolveReconnectStarted!();
        return staleFactory;
      }
      return factoryCalls === 1 ? first : current;
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  const staleUnsubscribe = await stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });
  first.emit("error", new Error("listener lost"));
  await within(reconnectStarted);
  await staleUnsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  const laterUnsubscribe = await stream.subscribeWakeups((wakeup) => { laterCalls.push(wakeup); });
  assert.equal(laterCalls.length, 1);
  assert.equal(laterCalls[0], undefined);
  assert.ok(current.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(current.releaseCount, 0);
  resolveStale!(stale);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.releaseCount, 1);
  assert.equal(stale.queries.length, 0);
  assert.equal([...stale.listeners.values()].some((listeners) => listeners.size > 0), false);
  assert.equal(calls.length, 1);
  assert.equal(laterCalls.length, 1);
  assert.equal(current.releaseCount, 0);
  assert.equal(factoryCalls, 3);
  await staleUnsubscribe();
  assert.equal(current.releaseCount, 0);
  await laterUnsubscribe();
  assert.equal(current.releaseCount, 1);
  assert.ok(current.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  await stream.close();
});

test("new subscription recovers while a stale reconnect factory is pending", async () => {
  const first = new FakeClient();
  const current = new FakeClient();
  const retry = new FakeClient();
  const stale = new FakeClient();
  const oldCalls: Array<unknown> = [];
  const newCalls: Array<unknown> = [];
  let factoryCalls = 0;
  let resolveOldStarted: (() => void) | undefined;
  const oldStarted = new Promise<void>((resolve) => { resolveOldStarted = resolve; });
  let resolveOld: ((client: AcceptedActivityStreamClient) => void) | undefined;
  const oldFactory = new Promise<AcceptedActivityStreamClient>((resolve) => { resolveOld = resolve; });
  let resolveRetryStarted: (() => void) | undefined;
  const retryStarted = new Promise<void>((resolve) => { resolveRetryStarted = resolve; });
  let resolveRetryCompleted: (() => void) | undefined;
  const retryCompleted = new Promise<void>((resolve) => { resolveRetryCompleted = resolve; });
  let releaseRetry: (() => void) | undefined;
  const retryPending = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const stream = createAcceptedActivityStream({
    pool: new FakePool(first, current, retry, stale),
    listenerClientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) return first;
      if (factoryCalls === 2) {
        resolveOldStarted!();
        return oldFactory;
      }
      if (factoryCalls === 3) return current;
      if (factoryCalls === 4) return retry;
      throw new Error("UNEXPECTED_FACTORY_RETRY");
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  const staleUnsubscribe = await stream.subscribeWakeups((wakeup) => { oldCalls.push(wakeup); });
  first.emit("error", new Error("listener lost"));
  await within(oldStarted);
  await staleUnsubscribe();

  const currentUnsubscribe = await stream.subscribeWakeups(async (wakeup) => {
    newCalls.push(wakeup);
    if (newCalls.length === 2) {
      resolveRetryStarted!();
      await retryPending;
      resolveRetryCompleted!();
    }
  });
  assert.equal(newCalls.length, 1);
  assert.equal(newCalls[0], undefined);
  assert.ok(current.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  await staleUnsubscribe();
  assert.equal(current.releaseCount, 0);

  current.emit("error", new Error("new listener lost"));
  await within(retryStarted);
  assert.equal(factoryCalls, 4);
  assert.equal(newCalls.length, 2);
  assert.ok(retry.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(retry.releaseCount, 0);

  resolveOld!(stale);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.releaseCount, 1);
  assert.equal(stale.queries.length, 0);
  assert.equal([...stale.listeners.values()].some((listeners) => listeners.size > 0), false);
  assert.equal(oldCalls.length, 1);
  assert.equal(newCalls.length, 2);
  assert.equal(current.releaseCount, 1);
  assert.equal(retry.releaseCount, 0);
  assert.equal(factoryCalls, 4);

  releaseRetry!();
  await within(retryCompleted);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(factoryCalls, 4);
  assert.equal(retry.releaseCount, 0);
  await currentUnsubscribe();
  assert.ok(retry.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(retry.releaseCount, 1);
  await stream.close();
});

test("reconnect failure schedules one bounded retry after its flight clears", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  const calls: Array<unknown> = [];
  const errors: unknown[] = [];
  let factoryCalls = 0;
  let resolveFailedReconnect: (() => void) | undefined;
  const failedReconnect = new Promise<void>((resolve) => { resolveFailedReconnect = resolve; });
  let resolveSecondCatchupStarted: (() => void) | undefined;
  const secondCatchupStarted = new Promise<void>((resolve) => { resolveSecondCatchupStarted = resolve; });
  let resolveSecondCatchupCompleted: (() => void) | undefined;
  const secondCatchupCompleted = new Promise<void>((resolve) => { resolveSecondCatchupCompleted = resolve; });
  let releaseSecondCatchup: (() => void) | undefined;
  const secondCatchupPending = new Promise<void>((resolve) => { releaseSecondCatchup = resolve; });
  const stream = createAcceptedActivityStream(new FakePool(first, second), {
    listenerClientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 2) {
        resolveFailedReconnect!();
        throw new Error("factory reconnect failed");
      }
      return factoryCalls === 1 ? first : second;
    },
    reconnectInitialDelayMs: 5,
    reconnectMaxDelayMs: 5,
    onError: (error) => { errors.push(error); },
  });
  await stream.subscribeWakeups(async (wakeup) => {
    calls.push(wakeup);
    if (calls.length === 2) {
      resolveSecondCatchupStarted!();
      await secondCatchupPending;
      resolveSecondCatchupCompleted!();
    }
  });
  first.emit("error", new Error("listener lost"));
  await within(failedReconnect);
  assert.equal(factoryCalls, 2);
  await within(secondCatchupStarted);
  assert.equal(factoryCalls, 3);
  assert.ok(second.queries.includes(`LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 1);
  releaseSecondCatchup!();
  await within(secondCatchupCompleted);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(factoryCalls, 3);
  await stream.close();
  assert.equal(first.releaseCount, 1);
  assert.equal(second.releaseCount, 1);
  await stream.close();
});

test("close before a reconnect retry fences creation of another client", async () => {
  const first = new FakeClient();
  const errors: unknown[] = [];
  let factoryCalls = 0;
  let resolveFailedReconnect: (() => void) | undefined;
  const failedReconnect = new Promise<void>((resolve) => { resolveFailedReconnect = resolve; });
  const stream = createAcceptedActivityStream(new FakePool(first), {
    listenerClientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 2) {
        resolveFailedReconnect!();
        throw new Error("factory reconnect failed");
      }
      return first;
    },
    reconnectInitialDelayMs: 25,
    reconnectMaxDelayMs: 25,
    onError: (error) => { errors.push(error); },
  });
  await stream.subscribeWakeups(() => undefined);
  first.emit("error", new Error("listener lost"));
  await within(failedReconnect);
  assert.equal(factoryCalls, 2);
  await stream.close();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(factoryCalls, 2);
  assert.equal(errors.length, 1);
  assert.equal(first.releaseCount, 1);
  await stream.close();
});

test("close fences a reconnect factory that resolves after close", async () => {
  const first = new FakeClient();
  const late = new FakeClient();
  const calls: Array<unknown> = [];
  let factoryCalls = 0;
  let resolveFactoryStarted: (() => void) | undefined;
  const factoryStarted = new Promise<void>((resolve) => { resolveFactoryStarted = resolve; });
  let resolveLate: ((client: AcceptedActivityStreamClient) => void) | undefined;
  const factoryPending = new Promise<AcceptedActivityStreamClient>((resolve) => { resolveLate = resolve; });
  const stream = createAcceptedActivityStream(new FakePool(first, late), {
    listenerClientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 2) {
        resolveFactoryStarted!();
        return factoryPending;
      }
      return first;
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  await stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });
  first.emit("error", new Error("listener lost"));
  await within(factoryStarted);
  assert.equal(factoryCalls, 2);
  await stream.close();
  assert.equal(first.releaseCount, 1);
  resolveLate!(late);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.releaseCount, 1);
  assert.equal(late.queries.length, 0);
  assert.equal(late.listeners.size, 0);
  assert.equal(calls.length, 1);
  assert.equal(factoryCalls, 2);
  await stream.close();
});

test("close fences a reconnect while LISTEN is pending", async () => {
  const first = new FakeClient();
  let resolveListen: (() => void) | undefined;
  const listenGate = new Promise<void>((resolve) => { resolveListen = resolve; });
  let resolveListenStarted: (() => void) | undefined;
  const listenStarted = new Promise<void>((resolve) => { resolveListenStarted = resolve; });
  let resolveListenCompleted: (() => void) | undefined;
  const listenCompleted = new Promise<void>((resolve) => { resolveListenCompleted = resolve; });
  const second = new BlockingListenClient(listenGate, resolveListenStarted!, resolveListenCompleted!);
  const calls: Array<unknown> = [];
  let factoryCalls = 0;
  const stream = createAcceptedActivityStream(new FakePool(first, second), {
    listenerClientFactory: async () => {
      factoryCalls += 1;
      return factoryCalls === 1 ? first : second;
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  await stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });
  first.emit("error", new Error("listener lost"));
  await within(listenStarted);
  assert.equal(second.queries.length, 0);
  await stream.close();
  assert.equal(second.releaseCount, 1);
  assert.ok(second.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal([...second.listeners.values()].some((listeners) => listeners.size > 0), false);
  resolveListen!();
  await within(listenCompleted);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.releaseCount, 1);
  assert.equal(second.queries.filter((query) => query === `LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`).length, 1);
  assert.equal(second.queries.filter((query) => query === `UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(factoryCalls, 2);
  await stream.close();
});

test("close fences a reconnect while mandatory catch-up is pending", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  const calls: Array<unknown> = [];
  let resolveCatchupStarted: (() => void) | undefined;
  const catchupStarted = new Promise<void>((resolve) => { resolveCatchupStarted = resolve; });
  let resolveCatchupCompleted: (() => void) | undefined;
  const catchupCompleted = new Promise<void>((resolve) => { resolveCatchupCompleted = resolve; });
  let releaseCatchup: (() => void) | undefined;
  const catchupPending = new Promise<void>((resolve) => { releaseCatchup = resolve; });
  let factoryCalls = 0;
  const stream = createAcceptedActivityStream(new FakePool(first, second), {
    listenerClientFactory: async () => {
      factoryCalls += 1;
      return factoryCalls === 1 ? first : second;
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  await stream.subscribeWakeups(async (wakeup) => {
    calls.push(wakeup);
    if (calls.length === 2) {
      resolveCatchupStarted!();
      await catchupPending;
      resolveCatchupCompleted!();
    }
  });
  first.emit("error", new Error("listener lost"));
  await within(catchupStarted);
  await stream.close();
  assert.equal(second.releaseCount, 1);
  assert.ok(second.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal(calls.length, 2);
  releaseCatchup!();
  await within(catchupCompleted);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.releaseCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(factoryCalls, 2);
  await stream.close();
});

test("initial subscribe close fences a factory that resolves after close", async () => {
  const late = new FakeClient();
  const calls: Array<unknown> = [];
  let factoryCalls = 0;
  let resolveFactoryStarted: (() => void) | undefined;
  const factoryStarted = new Promise<void>((resolve) => { resolveFactoryStarted = resolve; });
  let resolveLate: ((client: AcceptedActivityStreamClient) => void) | undefined;
  const factoryPending = new Promise<AcceptedActivityStreamClient>((resolve) => { resolveLate = resolve; });
  const stream = createAcceptedActivityStream(new FakePool(late), {
    listenerClientFactory: async () => {
      factoryCalls += 1;
      resolveFactoryStarted!();
      return factoryPending;
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  const subscribeFlight = stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });
  await within(factoryStarted);
  await stream.close();
  resolveLate!(late);
  await errorCode(subscribeFlight, "ACCEPTED_ACTIVITY_STREAM_CLOSED");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.releaseCount, 1);
  assert.equal(late.queries.length, 0);
  assert.equal(late.listeners.size, 0);
  assert.equal(calls.length, 0);
  assert.equal(factoryCalls, 1);
  await stream.close();
});

test("initial subscribe close fences a pending LISTEN", async () => {
  let resolveListen: (() => void) | undefined;
  const listenGate = new Promise<void>((resolve) => { resolveListen = resolve; });
  let resolveListenStarted: (() => void) | undefined;
  const listenStarted = new Promise<void>((resolve) => { resolveListenStarted = resolve; });
  let resolveListenCompleted: (() => void) | undefined;
  const listenCompleted = new Promise<void>((resolve) => { resolveListenCompleted = resolve; });
  const client = new BlockingListenClient(listenGate, resolveListenStarted!, resolveListenCompleted!);
  const calls: Array<unknown> = [];
  const stream = createAcceptedActivityStream(new FakePool(client), {
    listenerClientFactory: async () => client,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  const subscribeFlight = stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });
  await within(listenStarted);
  assert.equal(client.queries.length, 0);
  await stream.close();
  assert.equal(client.releaseCount, 1);
  assert.ok(client.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  assert.equal([...client.listeners.values()].some((listeners) => listeners.size > 0), false);
  resolveListen!();
  await within(listenCompleted);
  await errorCode(subscribeFlight, "ACCEPTED_ACTIVITY_STREAM_CLOSED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.releaseCount, 1);
  assert.equal(client.queries.filter((query) => query === `LISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`).length, 1);
  assert.equal(client.queries.filter((query) => query === `UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`).length, 1);
  assert.equal(calls.length, 0);
  await stream.close();
});

test("initial subscribe close fences a pending mandatory catch-up", async () => {
  const client = new FakeClient();
  const calls: Array<unknown> = [];
  let resolveCatchupStarted: (() => void) | undefined;
  const catchupStarted = new Promise<void>((resolve) => { resolveCatchupStarted = resolve; });
  let resolveCatchupCompleted: (() => void) | undefined;
  const catchupCompleted = new Promise<void>((resolve) => { resolveCatchupCompleted = resolve; });
  let releaseCatchup: (() => void) | undefined;
  const catchupPending = new Promise<void>((resolve) => { releaseCatchup = resolve; });
  const stream = createAcceptedActivityStream(new FakePool(client), {
    listenerClientFactory: async () => client,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
  });
  const subscribeFlight = stream.subscribeWakeups(async (wakeup) => {
    calls.push(wakeup);
    if (calls.length === 1) {
      resolveCatchupStarted!();
      await catchupPending;
      resolveCatchupCompleted!();
    }
  });
  await within(catchupStarted);
  await stream.close();
  assert.equal(client.releaseCount, 1);
  assert.ok(client.queries.includes(`UNLISTEN ${ACCEPTED_ACTIVITY_STREAM_CHANNEL}`));
  releaseCatchup!();
  await within(catchupCompleted);
  await errorCode(subscribeFlight, "ACCEPTED_ACTIVITY_STREAM_CLOSED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.releaseCount, 1);
  assert.equal(calls.length, 1);
  assert.equal([...client.listeners.values()].some((listeners) => listeners.size > 0), false);
  await stream.close();
});

test("notification envelopes accept the plain, null-prototype, and pg-protocol profiles", async () => {
  const client = new FakeClient();
  const calls: unknown[] = [];
  const stream = createAcceptedActivityStream(new FakePool(client));
  const unsubscribe = await stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });

  client.emit("notification", plainNotification(NOTIFICATION_PAYLOAD));
  await new Promise((resolve) => setImmediate(resolve));
  client.emit("notification", nullPrototypeNotification(JSON.stringify({
    cursor: "11",
    event_id: "01952f00-0000-4000-8000-000000000107",
  })));
  await new Promise((resolve) => setImmediate(resolve));
  client.emit("notification", new NotificationResponseMessage(JSON.stringify({
    cursor: "12",
    event_id: "01952f00-0000-4000-8000-000000000108",
  }), 2, 42));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    undefined,
    { cursor: "10", eventId: EVENT_ID },
    { cursor: "11", eventId: "01952f00-0000-4000-8000-000000000107" },
    { cursor: "12", eventId: "01952f00-0000-4000-8000-000000000108" },
  ]);
  await unsubscribe();
  await stream.close();
});

test("notification envelope normalization rejects malformed descriptor and profile shapes without invoking accessors", async () => {
  const client = new FakeClient();
  const errors: unknown[] = [];
  const calls: unknown[] = [];
  const stream = createAcceptedActivityStream(new FakePool(client), {
    onError: (error) => { errors.push(error); },
  });
  const unsubscribe = await stream.subscribeWakeups((wakeup) => { calls.push(wakeup); });
  const emitInvalid = async (message: unknown, label: string): Promise<void> => {
    const before = errors.length;
    client.emit("notification", message);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, before + 1, label);
    const error = errors[errors.length - 1];
    assert.ok(error instanceof AcceptedActivityStreamError, label);
    assert.equal((error as AcceptedActivityStreamError).code, "ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID", label);
  };

  await emitInvalid(null, "null");
  await emitInvalid(undefined, "undefined");
  await emitInvalid("notification", "string");
  await emitInvalid(1, "number");
  await emitInvalid(() => undefined, "function");

  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, 0), "zero processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, -1), "negative processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, 1.5), "fractional processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, Number.NaN), "NaN processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, Number.POSITIVE_INFINITY), "infinite processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, Number.MAX_SAFE_INTEGER + 1), "unsafe processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, "1"), "string processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, {}), "object processId");
  await emitInvalid(plainNotification(NOTIFICATION_PAYLOAD, ACCEPTED_ACTIVITY_STREAM_CHANNEL), "channel-shaped processId");

  await emitInvalid({
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: NOTIFICATION_PAYLOAD,
    extra: true,
  }, "extra plain key");
  await emitInvalid({ processId: 1, channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL }, "missing plain key");
  const plainSymbol = plainNotification();
  Object.defineProperty(plainSymbol, Symbol("extra"), { value: true });
  await emitInvalid(plainSymbol, "plain symbol key");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await emitInvalid(plainNotification(cyclic), "cyclic payload");
  await emitInvalid(plainNotification(cyclic, cyclic), "cyclic processId");
  const objectChannel = plainNotification();
  objectChannel.channel = { value: ACCEPTED_ACTIVITY_STREAM_CHANNEL };
  await emitInvalid(objectChannel, "object channel");
  await emitInvalid({
    processId: 1,
    channel: "wrong",
    payload: NOTIFICATION_PAYLOAD,
  }, "wrong plain channel");

  let getterInvocations = 0;
  const accessor = plainNotification();
  Object.defineProperty(accessor, "payload", {
    configurable: true,
    enumerable: true,
    get: () => {
      getterInvocations += 1;
      return NOTIFICATION_PAYLOAD;
    },
    set: () => {
      getterInvocations += 1;
    },
  });
  await emitInvalid(accessor, "payload accessor");
  assert.equal(getterInvocations, 0);

  const arbitraryClass = new ArbitraryThreeFieldNotification();
  await emitInvalid(arbitraryClass, "arbitrary three-field class");
  await emitInvalid({
    length: 1,
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: NOTIFICATION_PAYLOAD,
    name: "notification",
  }, "plain five-field pg shape");

  const validPrototype = Object.getPrototypeOf(new NotificationResponseMessage());
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: 0 }), "zero length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: -1 }), "negative length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: 1.5 }), "fractional length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: Number.NaN }), "NaN length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: Number.POSITIVE_INFINITY }), "infinite length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: Number.MAX_SAFE_INTEGER + 1 }), "unsafe length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { length: {} }), "object length");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { processId: 0 }), "zero pg processId");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { processId: {} }), "object pg processId");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { channel: "wrong" }), "wrong pg channel");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { payload: {} }), "object pg payload");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { payload: cyclic }), "cyclic pg payload");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { name: "wrong" }), "wrong pg name");
  await emitInvalid(pgNotificationWithPrototype(validPrototype, { payload: "not-json" }), "invalid pg JSON");

  const wrongNamePrototype = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(wrongNamePrototype, "constructor", { value: WRONG_NOTIFICATION_CONSTRUCTOR });
  await emitInvalid(pgNotificationWithPrototype(wrongNamePrototype), "wrong constructor name");

  const deepParent = Object.create(Object.prototype) as object;
  const deepPrototype = Object.create(deepParent) as Record<string, unknown>;
  Object.defineProperty(deepPrototype, "constructor", { value: VALID_NOTIFICATION_CONSTRUCTOR });
  await emitInvalid(pgNotificationWithPrototype(deepPrototype), "wrong prototype depth");

  const prototypeExtra = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(prototypeExtra, "constructor", { value: VALID_NOTIFICATION_CONSTRUCTOR });
  Object.defineProperty(prototypeExtra, "extra", { value: true });
  await emitInvalid(pgNotificationWithPrototype(prototypeExtra), "prototype extra key");

  const prototypeSymbol = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(prototypeSymbol, "constructor", { value: VALID_NOTIFICATION_CONSTRUCTOR });
  Object.defineProperty(prototypeSymbol, Symbol("extra"), { value: true });
  await emitInvalid(pgNotificationWithPrototype(prototypeSymbol), "prototype symbol key");

  let prototypeGetterInvocations = 0;
  const prototypeAccessor = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(prototypeAccessor, "constructor", {
    configurable: true,
    get: () => {
      prototypeGetterInvocations += 1;
      return VALID_NOTIFICATION_CONSTRUCTOR;
    },
  });
  await emitInvalid(pgNotificationWithPrototype(prototypeAccessor), "prototype constructor accessor");
  assert.equal(prototypeGetterInvocations, 0);

  const classExtra = new NotificationResponseMessage();
  Object.defineProperty(classExtra, "extra", { value: true });
  await emitInvalid(classExtra, "class extra key");
  const classMissing = pgNotificationWithPrototype(validPrototype);
  delete classMissing.name;
  await emitInvalid(classMissing, "class missing key");
  const classSymbol = new NotificationResponseMessage();
  Object.defineProperty(classSymbol, Symbol("extra"), { value: true });
  await emitInvalid(classSymbol, "class symbol key");

  assert.equal(calls.length, 1);
  await unsubscribe();
  await stream.close();
});

test("invalid notification payload is rejected and close/unsubscribe do not close the borrowed pool", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client);
  const errors: unknown[] = [];
  const stream = createAcceptedActivityStream(pool, {
    onError: (error) => { errors.push(error); },
  });
  const unsubscribe = await stream.subscribeWakeups(() => undefined);
  client.emit("notification", {
    processId: 1,
    channel: ACCEPTED_ACTIVITY_STREAM_CHANNEL,
    payload: JSON.stringify({ cursor: "1", event_id: EVENT_ID, secret: "must-not-cross" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AcceptedActivityStreamError);
  assert.equal((errors[0] as AcceptedActivityStreamError).code, "ACCEPTED_ACTIVITY_STREAM_NOTIFICATION_INVALID");
  await unsubscribe();
  assert.equal(client.releaseCount, 1);
  await stream.close();
  assert.equal(pool.endCount, 0);
});

test("0006 uses PG18-compatible ARE grammar with explicit character bounds", () => {
  const up = readFileSync(
    new URL("../../../migrations/0006_accepted_activity_stream.up.sql", import.meta.url),
    "utf8",
  ).replace(/\r\n/gu, "\n");

  assert.equal(up.split("{1,256}").length - 1, 0);
  for (const field of ["activityId", "continuityId"] as const) {
    const expectedPredicate =
      "AND payload->>'" + field + "' ~ '^[^[:space:]]+$'\n"
      + "              AND char_length(payload->>'" + field + "') BETWEEN 1 AND 256";
    assert.equal(up.split(expectedPredicate).length - 1, 1, field + " predicate");
  }

  const acceptsBoundedNonWhitespace = (value: string): boolean => {
    const length = Array.from(value).length;
    return /^[^\s]+$/u.test(value) && length >= 1 && length <= 256;
  };

  for (const value of ["a", "a".repeat(256)]) {
    assert.equal(acceptsBoundedNonWhitespace(value), true, "accepted length " + value.length);
  }
  for (const value of ["", "a".repeat(257)]) {
    assert.equal(acceptsBoundedNonWhitespace(value), false, "rejected length " + value.length);
  }
  for (const whitespace of [" ", "\t", "\n", "\r", "\f", "\v"]) {
    for (const value of [whitespace, whitespace + "a", "a" + whitespace, "a" + whitespace + "b"]) {
      assert.equal(acceptsBoundedNonWhitespace(value), false, "whitespace must be rejected");
    }
  }
});

test("T04 source reads the full owner payload and keeps the legacy source skippable", async () => {
  const client = new FakeClient();
  client.readRows = [t04Row("12")];
  const stream = createAcceptedActivityStream(new FakePool(client), { source: "t04" });
  const page = await stream.readAfter("0", 10);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.eventType, T04_ACCEPTED_ACTIVITY_EVENT_TYPE);
  assert.equal(page.items[0]!.actionReceipt?.kind, "t04.accepted_user_action_receipt");
  assert.equal(page.items[0]!.currentBinding?.activeDeviceId, DEVICE_ID);
  assert.equal(page.items[0]!.authorityProjection?.activityId, "activity-12");
  const select = client.queries.find((query) => query.startsWith("SELECT"));
  assert.ok(select?.includes("realtime.t04.accepted_user_activity.v1"));
  assert.ok(!select?.includes("o.event_type = 'realtime.continuity.renewed'"));
  const replay = await stream.readByIdempotency("activity-12");
  assert.equal(replay?.eventType, T04_ACCEPTED_ACTIVITY_EVENT_TYPE);
  await stream.close();
});

// The owner event binds the pre-action snapshot. The ledger response is post-action.
test("T04 accepts advancing activity and rejects future pre-state or lagging post-state", async () => {
  const client = new FakeClient();
  const stream = createAcceptedActivityStream(new FakePool(client), { source: "t04" });
  for (const prior of ["2026-08-27T01:02:02.123Z", OCCURRED_AT]) {
    client.readRows = [t04Row("12", EVENT_ID, prior)];
    const page = await stream.readAfter("0", 1);
    assert.equal(page.items.length, 1);
    assert.equal((await stream.readByIdempotency("activity-12"))?.activityId, "activity-12");
  }
  client.readRows = [t04Row("12", EVENT_ID, ACCEPTED_AT)];
  await errorCode(stream.readAfter("0", 1), "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  const lagging = t04Row("12");
  const post = { ...response("2"), lastAcceptedUserActivityAt: "2026-08-27T01:02:02.123Z" };
  lagging.ledger_response = post;
  lagging.ledger_response_hash = hash(post);
  client.readRows = [lagging];
  await errorCode(stream.readAfter("0", 1), "ACCEPTED_ACTIVITY_STREAM_BINDING_DRIFT");
  await stream.close();
});
