import {
  assertConnectionEpoch,
  compareDecimalEpoch,
  type DecimalConnectionEpoch,
} from './realtime-public-control-ports.ts';
import type { InternalOpaqueOwnerValue } from './types.ts';

/**
 * Internal application-layer replay state only.
 *
 * This module is deliberately not a wire type and does not implement a
 * transport or an offline-delivery promise.  It admits metadata for an
 * already-authorized topic and keeps enough identity to deduplicate that
 * admission while it remains inside the configured bounded window.  Payload
 * bytes (and any secret that might have produced a fingerprint) never enter
 * this module.
 */

export type ReplayReliability = 'reliable' | 'unreliable';

export type ReplayOwnerField = 'sessionRef' | 'publisher';

/**
 * Optional owner equality seam. A two-argument function is used for both
 * owner fields; the object form permits field-specific equality. Either form
 * is only consulted for distinct structural objects.
 */
export type ReplayOwnerEqualityComparator =
  | ((left: InternalOpaqueOwnerValue, right: InternalOpaqueOwnerValue) => boolean)
  | ((field: ReplayOwnerField, left: InternalOpaqueOwnerValue, right: InternalOpaqueOwnerValue) => boolean)
  | {
    readonly sameSessionRef: (left: InternalOpaqueOwnerValue, right: InternalOpaqueOwnerValue) => boolean;
    readonly samePublisher: (left: InternalOpaqueOwnerValue, right: InternalOpaqueOwnerValue) => boolean;
  };

export interface DataReplayWindowOptions {
  readonly allowedTopics: readonly string[];
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  /** Required deterministic clock; this module never reads wall-clock time. */
  readonly nowMs: () => number;
  readonly ownerEquality?: ReplayOwnerEqualityComparator;
}

/**
 * Closed application input.  `sessionRef` and `publisher` are opaque owner
 * values: this module compares them for identity and never interprets them.
 */
export interface DataReplayInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly sessionRef: InternalOpaqueOwnerValue;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly publisher: InternalOpaqueOwnerValue;
  readonly topic: string;
  readonly payloadFingerprint: string;
  readonly payloadLength: number;
  readonly reliability: ReplayReliability;
}

/** Metadata retained for one admitted item; no payload is present. */
export interface DataReplayEntryMetadata {
  readonly entryId: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly topic: string;
  readonly payloadFingerprint: string;
  readonly payloadLength: number;
  readonly reliability: ReplayReliability;
  readonly admittedAtMs: number;
}

/** The stable result returned for the first admission and every exact replay. */
export interface DataReplayResult extends DataReplayEntryMetadata {
  readonly accepted: true;
}

export interface DataReplayAckResult {
  readonly acknowledged: true;
  readonly entryId: number;
}

export interface DataReplayWindowSnapshot {
  readonly stopped: boolean;
  readonly disconnected: boolean;
  readonly count: number;
  readonly bytes: number;
  readonly entries: readonly DataReplayEntryMetadata[];
}

export interface DataReplayFenceResult {
  readonly fenced: true;
  readonly flushedCount: number;
  readonly flushedBytes: number;
}

export type DataReplayAckInput = DataReplayInput;

export const DATA_REPLAY_ERROR_CODES = Object.freeze({
  INVALID_OPTIONS_SHAPE: 'INVALID_REPLAY_WINDOW_OPTIONS_SHAPE',
  INVALID_INPUT_SHAPE: 'INVALID_REPLAY_INPUT_SHAPE',
  INVALID_IDENTIFIER: 'INVALID_REPLAY_IDENTIFIER',
  INVALID_OPAQUE_VALUE: 'INVALID_REPLAY_OPAQUE_VALUE',
  INVALID_OWNER_EQUALITY: 'INVALID_REPLAY_OWNER_EQUALITY',
  INVALID_TOPIC: 'INVALID_REPLAY_TOPIC',
  TOPIC_NOT_ADMITTED: 'REPLAY_TOPIC_NOT_ADMITTED',
  INVALID_FINGERPRINT: 'INVALID_REPLAY_FINGERPRINT',
  INVALID_LENGTH: 'INVALID_REPLAY_PAYLOAD_LENGTH',
  INVALID_RELIABILITY: 'INVALID_REPLAY_RELIABILITY',
  INVALID_EPOCH: 'INVALID_CONNECTION_EPOCH',
  INVALID_CLOCK: 'INVALID_REPLAY_CLOCK',
  INVALID_BOUND: 'INVALID_REPLAY_WINDOW_BOUND',
  ENTRY_TOO_LARGE: 'REPLAY_ENTRY_TOO_LARGE',
  STOPPED: 'REPLAY_WINDOW_STOPPED',
  NOT_FOUND: 'REPLAY_ENTRY_NOT_FOUND',
  REQUEST_DRIFT: 'REPLAY_REQUEST_DRIFT',
  SESSION_DRIFT: 'REPLAY_SESSION_DRIFT',
  EPOCH_DRIFT: 'REPLAY_CONNECTION_EPOCH_DRIFT',
  PUBLISHER_DRIFT: 'REPLAY_PUBLISHER_DRIFT',
  TOPIC_DRIFT: 'REPLAY_TOPIC_DRIFT',
  IDEMPOTENCY_CONFLICT: 'REPLAY_IDEMPOTENCY_CONFLICT',
  PAYLOAD_METADATA_CONFLICT: 'REPLAY_PAYLOAD_METADATA_CONFLICT',
  DELIVERY_METADATA_CONFLICT: 'REPLAY_DELIVERY_METADATA_CONFLICT',
  OWNER_EQUALITY_REQUIRED: 'REPLAY_OWNER_EQUALITY_REQUIRED',
  OWNER_COMPARATOR_FAILED: 'REPLAY_OWNER_COMPARATOR_FAILED',
} as const);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u;
const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

const INPUT_KEYS = Object.freeze([
  'requestId',
  'idempotencyKey',
  'sessionRef',
  'connectionEpoch',
  'publisher',
  'topic',
  'payloadFingerprint',
  'payloadLength',
  'reliability',
] as const);

const OPTION_KEYS = Object.freeze([
  'allowedTopics',
  'maxCount',
  'maxBytes',
  'maxAgeMs',
  'nowMs',
  'ownerEquality',
] as const);

interface StoredEntry {
  readonly input: DataReplayInput;
  readonly result: DataReplayResult;
}

function fail(code: string): never {
  // Error messages are stable codes only: never include caller values.
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertClosedShape(
  value: unknown,
  expected: readonly string[],
  code: string,
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(code);
  const keys = Reflect.ownKeys(value);
  const required = expected.filter((key) => !optional.includes(key));
  if (keys.length < required.length
    || keys.length > expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    fail(code);
  }
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) fail(code);
  }
  for (const key of optional) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) fail(code);
  }
}

type NormalizedOwnerEquality = (
  field: ReplayOwnerField,
  left: InternalOpaqueOwnerValue,
  right: InternalOpaqueOwnerValue,
) => boolean;

function normalizeOwnerEquality(value: unknown): NormalizedOwnerEquality | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'function') {
    const comparator = value as (...args: unknown[]) => unknown;
    return (field, left, right) => {
      const result = comparator.length >= 3
        ? comparator(field, left, right)
        : comparator(left, right);
      if (typeof result !== 'boolean') fail(DATA_REPLAY_ERROR_CODES.OWNER_COMPARATOR_FAILED);
      return result;
    };
  }
  if (!isRecord(value)) fail(DATA_REPLAY_ERROR_CODES.INVALID_OWNER_EQUALITY);
  const keys = Reflect.ownKeys(value);
  const expected: readonly string[] = ['sameSessionRef', 'samePublisher'];
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_OWNER_EQUALITY);
  }
  const sessionDescriptor = Object.getOwnPropertyDescriptor(value, 'sameSessionRef');
  const publisherDescriptor = Object.getOwnPropertyDescriptor(value, 'samePublisher');
  if (sessionDescriptor === undefined || !('value' in sessionDescriptor)
    || publisherDescriptor === undefined || !('value' in publisherDescriptor)
    || typeof sessionDescriptor.value !== 'function'
    || typeof publisherDescriptor.value !== 'function') {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_OWNER_EQUALITY);
  }
  const sessionComparator = sessionDescriptor.value as (
    left: InternalOpaqueOwnerValue,
    right: InternalOpaqueOwnerValue,
  ) => unknown;
  const publisherComparator = publisherDescriptor.value as (
    left: InternalOpaqueOwnerValue,
    right: InternalOpaqueOwnerValue,
  ) => unknown;
  return (field, left, right) => {
    const result = field === 'sessionRef'
      ? sessionComparator(left, right)
      : publisherComparator(left, right);
    if (typeof result !== 'boolean') fail(DATA_REPLAY_ERROR_CODES.OWNER_COMPARATOR_FAILED);
    return result;
  };
}

function sameOwner(
  field: ReplayOwnerField,
  left: InternalOpaqueOwnerValue,
  right: InternalOpaqueOwnerValue,
  ownerEquality: NormalizedOwnerEquality | undefined,
): boolean {
  if (Object.is(left, right)) return true;
  const leftIsObject = typeof left === 'object';
  const rightIsObject = typeof right === 'object';
  if (!leftIsObject || !rightIsObject) return false;
  if (ownerEquality === undefined) fail(DATA_REPLAY_ERROR_CODES.OWNER_EQUALITY_REQUIRED);
  try {
    return ownerEquality(field, left, right);
  } catch {
    fail(DATA_REPLAY_ERROR_CODES.OWNER_COMPARATOR_FAILED);
  }
}

function assertIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_IDENTIFIER);
  }
  return value;
}

function assertTopic(value: unknown): string {
  if (typeof value !== 'string' || !TOPIC.test(value)) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_TOPIC);
  }
  return value;
}

function assertFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_FINGERPRINT);
  }
  return value;
}

function assertOpaque(value: unknown): InternalOpaqueOwnerValue {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
      fail(DATA_REPLAY_ERROR_CODES.INVALID_OPAQUE_VALUE);
    }
    return value;
  }
  if (typeof value === 'object' && value !== null) return value;
  fail(DATA_REPLAY_ERROR_CODES.INVALID_OPAQUE_VALUE);
}

function assertEpoch(value: unknown): DecimalConnectionEpoch {
  try {
    return assertConnectionEpoch(value);
  } catch {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_EPOCH);
  }
}

function assertLength(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_LENGTH);
  }
  return value as number;
}

function assertReliability(value: unknown): ReplayReliability {
  if (value !== 'reliable' && value !== 'unreliable') {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_RELIABILITY);
  }
  return value;
}

function assertClock(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_CLOCK);
  }
  return value;
}

function assertPositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_BOUND);
  }
  return value as number;
}

function copyInput(value: unknown, allowedTopics: ReadonlySet<string>): DataReplayInput {
  assertClosedShape(value, INPUT_KEYS, DATA_REPLAY_ERROR_CODES.INVALID_INPUT_SHAPE);

  const topic = assertTopic(value.topic);
  if (!allowedTopics.has(topic)) fail(DATA_REPLAY_ERROR_CODES.TOPIC_NOT_ADMITTED);

  const input: DataReplayInput = {
    requestId: assertIdentifier(value.requestId),
    idempotencyKey: assertIdentifier(value.idempotencyKey),
    sessionRef: assertOpaque(value.sessionRef),
    connectionEpoch: assertEpoch(value.connectionEpoch),
    publisher: assertOpaque(value.publisher),
    topic,
    payloadFingerprint: assertFingerprint(value.payloadFingerprint),
    payloadLength: assertLength(value.payloadLength),
    reliability: assertReliability(value.reliability),
  };

  return Object.freeze(input);
}

function copyOptions(value: unknown): {
  readonly allowedTopics: readonly string[];
  readonly allowedTopicSet: ReadonlySet<string>;
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  readonly nowMs: () => number;
  readonly ownerEquality: NormalizedOwnerEquality | undefined;
} {
  assertClosedShape(value, OPTION_KEYS, DATA_REPLAY_ERROR_CODES.INVALID_OPTIONS_SHAPE, ['ownerEquality']);
  if (!Array.isArray(value.allowedTopics) || value.allowedTopics.length === 0) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_OPTIONS_SHAPE);
  }
  const allowedTopics = value.allowedTopics.map(assertTopic);
  if (new Set(allowedTopics).size !== allowedTopics.length) {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_OPTIONS_SHAPE);
  }
  const maxCount = assertPositiveSafeInteger(value.maxCount);
  const maxBytes = assertPositiveSafeInteger(value.maxBytes);
  const maxAgeMs = assertPositiveSafeInteger(value.maxAgeMs);
  if (typeof value.nowMs !== 'function') {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_OPTIONS_SHAPE);
  }

  const nowMs = value.nowMs as () => number;
  // Validate the injected clock at construction so a bad clock cannot mutate
  // state before returning a stable error.
  try {
    assertClock(nowMs());
  } catch {
    fail(DATA_REPLAY_ERROR_CODES.INVALID_CLOCK);
  }
  const ownerEquality = normalizeOwnerEquality(value.ownerEquality);

  return {
    allowedTopics: Object.freeze([...allowedTopics]),
    allowedTopicSet: new Set(allowedTopics),
    maxCount,
    maxBytes,
    maxAgeMs,
    nowMs,
    ownerEquality,
  };
}

function metadata(input: DataReplayInput, entryId: number, admittedAtMs: number): DataReplayEntryMetadata {
  return Object.freeze({
    entryId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    connectionEpoch: input.connectionEpoch,
    topic: input.topic,
    payloadFingerprint: input.payloadFingerprint,
    payloadLength: input.payloadLength,
    reliability: input.reliability,
    admittedAtMs,
  });
}

function assertInputAgainstStored(
  input: DataReplayInput,
  stored: DataReplayInput,
  ownerEquality: NormalizedOwnerEquality | undefined,
): void {
  if (input.requestId !== stored.requestId) fail(DATA_REPLAY_ERROR_CODES.REQUEST_DRIFT);
  if (!sameOwner('sessionRef', input.sessionRef, stored.sessionRef, ownerEquality)) {
    fail(DATA_REPLAY_ERROR_CODES.SESSION_DRIFT);
  }
  if (compareDecimalEpoch(input.connectionEpoch, stored.connectionEpoch) !== 0) {
    fail(DATA_REPLAY_ERROR_CODES.EPOCH_DRIFT);
  }
  if (!sameOwner('publisher', input.publisher, stored.publisher, ownerEquality)) {
    fail(DATA_REPLAY_ERROR_CODES.PUBLISHER_DRIFT);
  }
  if (input.topic !== stored.topic) fail(DATA_REPLAY_ERROR_CODES.TOPIC_DRIFT);
  if (input.payloadFingerprint !== stored.payloadFingerprint) {
    fail(DATA_REPLAY_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  }
  if (input.payloadLength !== stored.payloadLength) {
    fail(DATA_REPLAY_ERROR_CODES.PAYLOAD_METADATA_CONFLICT);
  }
  if (input.reliability !== stored.reliability) {
    fail(DATA_REPLAY_ERROR_CODES.DELIVERY_METADATA_CONFLICT);
  }
}

/**
 * A bounded, synchronous application-layer replay/dedupe window.
 *
 * There are no timers, listeners, network calls, payload buffers, or
 * continuity deadlines here.  A caller may mark a disconnect, but retention
 * remains subject to the same count/byte/age budgets and does not renew any
 * owner continuity.
 */
export class DataReplayWindow {
  readonly #allowedTopics: readonly string[];
  readonly #allowedTopicSet: ReadonlySet<string>;
  readonly #maxCount: number;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #nowMs: () => number;
  readonly #ownerEquality: NormalizedOwnerEquality | undefined;
  readonly #entries = new Map<number, StoredEntry>();
  readonly #byIdempotency = new Map<string, StoredEntry>();
  #nextEntryId = 1;
  #bytes = 0;
  #stopped = false;
  #disconnected = false;
  #fenceResult: DataReplayFenceResult | undefined;

  constructor(options: DataReplayWindowOptions) {
    const copied = copyOptions(options);
    this.#allowedTopics = copied.allowedTopics;
    this.#allowedTopicSet = copied.allowedTopicSet;
    this.#maxCount = copied.maxCount;
    this.#maxBytes = copied.maxBytes;
    this.#maxAgeMs = copied.maxAgeMs;
    this.#nowMs = copied.nowMs;
    this.#ownerEquality = copied.ownerEquality;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get disconnected(): boolean {
    return this.#disconnected;
  }

  get allowedTopics(): readonly string[] {
    return this.#allowedTopics;
  }

  enqueue(value: DataReplayInput): DataReplayResult {
    this.#assertActive();
    const input = copyInput(value, this.#allowedTopicSet);
    const now = this.#observeNow();
    this.#evictExpired(now);

    const existing = this.#byIdempotency.get(input.idempotencyKey);
    if (existing !== undefined) {
      assertInputAgainstStored(input, existing.input, this.#ownerEquality);
      return existing.result;
    }

    if (input.payloadLength > this.#maxBytes) {
      fail(DATA_REPLAY_ERROR_CODES.ENTRY_TOO_LARGE);
    }

    const entryId = this.#nextEntryId++;
    const result: DataReplayResult = Object.freeze({
      accepted: true,
      ...metadata(input, entryId, now),
    });
    const stored: StoredEntry = Object.freeze({ input, result });
    this.#entries.set(entryId, stored);
    this.#byIdempotency.set(input.idempotencyKey, stored);
    this.#bytes += input.payloadLength;
    this.#evictToBudget();
    return result;
  }

  /** Return the same immutable result for one exact retained admission. */
  replay(value: DataReplayInput): DataReplayResult {
    this.#assertActive();
    const input = copyInput(value, this.#allowedTopicSet);
    const now = this.#observeNow();
    this.#evictExpired(now);
    const existing = this.#byIdempotency.get(input.idempotencyKey);
    if (existing === undefined) fail(DATA_REPLAY_ERROR_CODES.NOT_FOUND);
    assertInputAgainstStored(input, existing.input, this.#ownerEquality);
    return existing.result;
  }

  /** Acknowledges/removes only the exact bound item represented by `value`. */
  ack(value: DataReplayAckInput): DataReplayAckResult {
    this.#assertActive();
    const input = copyInput(value, this.#allowedTopicSet);
    const now = this.#observeNow();
    this.#evictExpired(now);
    const existing = this.#byIdempotency.get(input.idempotencyKey);
    if (existing === undefined) fail(DATA_REPLAY_ERROR_CODES.NOT_FOUND);
    assertInputAgainstStored(input, existing.input, this.#ownerEquality);
    const current = this.#entries.get(existing.result.entryId);
    if (current !== existing) fail(DATA_REPLAY_ERROR_CODES.NOT_FOUND);
    this.#entries.delete(existing.result.entryId);
    this.#byIdempotency.delete(input.idempotencyKey);
    this.#bytes -= existing.input.payloadLength;
    return Object.freeze({ acknowledged: true, entryId: existing.result.entryId });
  }

  acknowledge(value: DataReplayAckInput): DataReplayAckResult {
    return this.ack(value);
  }

  /** Mark transport disconnection; age/count/byte bounds remain authoritative. */
  markDisconnected(): DataReplayWindowSnapshot {
    this.#assertActive();
    this.#disconnected = true;
    return this.snapshot();
  }

  disconnect(): DataReplayWindowSnapshot {
    return this.markDisconnected();
  }

  markConnected(): DataReplayWindowSnapshot {
    this.#assertActive();
    this.#disconnected = false;
    return this.snapshot();
  }

  reconnect(): DataReplayWindowSnapshot {
    return this.markConnected();
  }

  /**
   * Install a terminal stop fence and clear the retained metadata.  Repeated
   * calls (including concurrent Promise.all callers) return the same result.
   */
  stop(): DataReplayFenceResult {
    if (this.#fenceResult !== undefined) return this.#fenceResult;
    const result: DataReplayFenceResult = Object.freeze({
      fenced: true,
      flushedCount: this.#entries.size,
      flushedBytes: this.#bytes,
    });
    this.#entries.clear();
    this.#byIdempotency.clear();
    this.#bytes = 0;
    this.#stopped = true;
    this.#fenceResult = result;
    return result;
  }

  /** Flush is terminal: it also installs the same stop fence. */
  flush(): DataReplayFenceResult {
    return this.stop();
  }

  snapshot(): DataReplayWindowSnapshot {
    if (!this.#stopped) this.#evictExpired(this.#observeNow());
    const entries = Object.freeze([...this.#entries.values()].map(({ input, result }) => (
      metadata(input, result.entryId, result.admittedAtMs)
    )));
    return Object.freeze({
      stopped: this.#stopped,
      disconnected: this.#disconnected,
      count: entries.length,
      bytes: this.#bytes,
      entries,
    });
  }

  stats(): DataReplayWindowSnapshot {
    return this.snapshot();
  }

  #assertActive(): void {
    if (this.#stopped) fail(DATA_REPLAY_ERROR_CODES.STOPPED);
  }

  #observeNow(): number {
    try {
      return assertClock(this.#nowMs());
    } catch {
      fail(DATA_REPLAY_ERROR_CODES.INVALID_CLOCK);
    }
  }

  #evictExpired(now: number): void {
    for (const [entryId, stored] of this.#entries) {
      if (now - stored.result.admittedAtMs >= this.#maxAgeMs) {
        this.#remove(entryId, stored);
      }
    }
  }

  #evictToBudget(): void {
    while (this.#entries.size > this.#maxCount || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.entries().next().value as [number, StoredEntry] | undefined;
      if (oldest === undefined) break;
      this.#remove(oldest[0], oldest[1]);
    }
  }

  #remove(entryId: number, stored: StoredEntry): void {
    if (this.#entries.get(entryId) !== stored) return;
    this.#entries.delete(entryId);
    if (this.#byIdempotency.get(stored.input.idempotencyKey) === stored) {
      this.#byIdempotency.delete(stored.input.idempotencyKey);
    }
    this.#bytes -= stored.input.payloadLength;
  }
}

/** Descriptive aliases keep the seam usable without introducing wire names. */
export { DataReplayWindow as AdmittedTopicReplayWindow, DataReplayWindow as ReplayWindow };
export type ReplayWindowOptions = DataReplayWindowOptions;
export type ReplayInput = DataReplayInput;

export type AdmittedTopicReplayInput = DataReplayInput;

export function createDataReplayWindow(options: DataReplayWindowOptions): DataReplayWindow {
  return new DataReplayWindow(options);
}
