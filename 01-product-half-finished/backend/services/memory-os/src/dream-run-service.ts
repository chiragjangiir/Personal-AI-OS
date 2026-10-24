import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import {
  assertProductionMemoryIssuerReceipt,
  issuerReceiptMatchesCandidate,
  jcsSerialize,
  projectProductionMemoryIssuerReceipt,
  type ProductionMemoryIssuerReceipt,
  type ProductionMemoryIssuerReceiptProjection,
} from "./canonical-issuer.ts";
import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  assertUUIDv7,
  type UUIDv7,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  assertCanonicalUtcInstant,
  compareCanonicalUtcInstants,
  type AcceptedDreamDeltaCursor,
  type AcceptedDreamDeltaPage,
  type AcceptedDreamDeltaRecord,
  type AuthorityWatermark,
  type CanonicalUtcInstant,
  type CanonicalUtcWindow,
  type MemoryCommandError,
  type MemoryCommandResult,
  type MemoryCommitReceipt,
  type ReadonlyJsonValue,
} from "./domain.ts";
import {
  buildDreamCandidateBatch,
  type DreamCandidateBatch,
  type DreamDisposition,
  type DreamExtractorProposal,
} from "./dream-candidates.ts";
import type {
  AcceptedDreamDeltaReader,
  MemoryCandidateBatchCommitCommand,
  MemoryCommandRepository,
} from "./ports.ts";
import {
  assertAppendOnlyAuthorityWatermark,
} from "./ports.ts";
import type { AppendOnlyAuthorityWatermark } from "./ports.ts";
import type {
  DreamApplicationExtractor,
  DreamExtractorDelta,
  DreamExtractorInput,
} from "./dream-application-service.ts";

/** Daily-local date accepted by the source-only Dream run seam. */
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_DREAM_RUN_PAGE_LIMIT = 1_000;
const MAX_DREAM_RUN_PAGE_LIMIT = 10_000;
const DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM = 900_000;

declare const productionDreamRunIdReceiptBrand: unique symbol;
declare const productionDreamPageCheckpointEventReceiptBrand: unique symbol;

/**
 * T05's private identity for one production Dream run.  The UUID is not a
 * canonical memory object and the brand is deliberately not reconstructible
 * from JSON, a fixture, or a caller-selected string.
 */
export interface ProductionDreamRunIdReceipt {
  readonly [productionDreamRunIdReceiptBrand]: true;
  readonly kind: "t05_dream_run_id_receipt";
  readonly environment: "production";
  readonly dreamRunId: UUIDv7;
}

export interface ProductionDreamRunIdReceiptProjection {
  readonly kind: "t05_dream_run_id_receipt_projection";
  readonly environment: "production";
  readonly dreamRunId: UUIDv7;
  readonly projectionJcs: string;
  readonly projectionSha256: Sha256;
}

export interface ProductionDreamRunIdIssuerOptions {
  readonly nowMs?: () => number | bigint;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxCollisionAttempts?: number;
  readonly issuedIds?: Set<string>;
}

export interface ProductionDreamRunIdIssuer {
  readonly environment: "production";
  issue(): ProductionDreamRunIdReceipt;
  issueDreamRunId(): ProductionDreamRunIdReceipt;
}

export interface DreamPageCheckpointCursorV1 {
  readonly token: string;
  readonly authority_watermark: AuthorityWatermark;
}

/** Exact RFC-011 snake_case payload; no source-only aliases cross this seam. */
export interface DreamPageCheckpointPayloadV1 {
  readonly dream_run_id: UUIDv7;
  readonly user_id: UUIDv7;
  readonly local_date: string;
  readonly time_zone: string;
  readonly window_from: CanonicalUtcInstant;
  readonly window_to: CanonicalUtcInstant;
  readonly pinned_watermark: AuthorityWatermark;
  readonly input_cursor?: DreamPageCheckpointCursorV1;
  readonly next_cursor?: DreamPageCheckpointCursorV1;
  readonly complete: boolean;
  readonly page_idempotency_key: string;
  readonly page_fingerprint: Sha256;
  readonly command_fingerprint: Sha256;
  readonly predecessor_fingerprint: Sha256;
  readonly state_fingerprint: Sha256;
  readonly read_receipt_fingerprint: Sha256;
  readonly trusted_overlay_projection_fingerprint: Sha256;
  readonly candidate_count: string;
  readonly candidate_refs: readonly {
    readonly ref_type: "MemoryCandidate";
    readonly ref_id: UUIDv7;
    readonly object_version: string;
    readonly canonical_payload_sha256: Sha256;
  }[];
}

export interface DreamPageCheckpointEventV1 {
  readonly event_id: UUIDv7;
  readonly aggregate_type: "memory_dream_run";
  readonly aggregate_id: UUIDv7;
  readonly event_type: "memory.dream.page.checkpointed.v1";
  readonly event_version: 1;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly payload: DreamPageCheckpointPayloadV1;
  readonly payload_sha256: Sha256;
}

export interface ProductionDreamPageCheckpointEventReceipt {
  readonly [productionDreamPageCheckpointEventReceiptBrand]: true;
  readonly kind: "t05_dream_page_checkpoint_event_receipt";
  readonly event: DreamPageCheckpointEventV1;
  readonly payloadJcs: string;
  readonly payloadBytes: readonly number[];
  readonly eventJcs: string;
  readonly eventBytes: readonly number[];
  readonly eventSha256: Sha256;
}

export interface ProductionDreamPageCheckpointEventProjection {
  readonly kind: "t05_dream_page_checkpoint_event_projection";
  readonly event: DreamPageCheckpointEventV1;
  readonly payloadJcs: string;
  readonly payloadBytes: readonly number[];
  readonly eventJcs: string;
  readonly eventBytes: readonly number[];
  readonly eventSha256: Sha256;
  readonly projectionJcs: string;
  readonly projectionSha256: Sha256;
}

/** Short aliases used by adapters that omit the production prefix. */
export type ProductionDreamCheckpointEventReceipt = ProductionDreamPageCheckpointEventReceipt;
export type ProductionDreamCheckpointEventProjection = ProductionDreamPageCheckpointEventProjection;
export type DreamPageCheckpointEventReceipt = ProductionDreamPageCheckpointEventReceipt;

interface DreamRunCheckpointState {
  readonly uuidIssuer: ProductionDreamRunIdIssuer;
  readonly events: Map<string, ProductionDreamPageCheckpointEventReceipt>;
  boundContext?: DreamRunCheckpointContext;
}

interface DreamRunCheckpointContext {
  readonly userId: string;
  readonly batchId: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly windowFrom: CanonicalUtcInstant;
  readonly windowTo: CanonicalUtcInstant;
}

const PRODUCTION_DREAM_RUN_ID_RECEIPTS = new WeakSet<object>();
const PRODUCTION_DREAM_PAGE_CHECKPOINT_EVENT_RECEIPTS = new WeakSet<object>();
const DREAM_RUN_CHECKPOINT_STATES = new WeakMap<object, DreamRunCheckpointState>();

const MAX_DREAM_UUID_TIMESTAMP = 0xffffffffffffn;
const MAX_DREAM_UUID_TAIL = (1n << 74n) - 1n;

function dreamUuidTimestamp(value: number | bigint): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Dream UUIDv7 clock must be a non-negative safe integer");
  }
  const timestamp = typeof value === "bigint" ? value : BigInt(value);
  if (timestamp < 0n || timestamp > MAX_DREAM_UUID_TIMESTAMP) {
    throw new TypeError("Dream UUIDv7 clock is outside the 48-bit millisecond range");
  }
  return timestamp;
}

function dreamUuidTail(bytes: Uint8Array): bigint {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) {
    throw new TypeError("Dream UUIDv7 entropy must provide at least 10 bytes");
  }
  let value = 0n;
  for (let index = 0; index < 10; index += 1) value = (value << 8n) | BigInt(bytes[index]!);
  return value & MAX_DREAM_UUID_TAIL;
}

function dreamUuidFromParts(timestamp: bigint, tail: bigint): UUIDv7 {
  if (timestamp < 0n || timestamp > MAX_DREAM_UUID_TIMESTAMP || tail < 0n || tail > MAX_DREAM_UUID_TAIL) {
    throw new TypeError("Dream UUIDv7 parts are outside their encoded ranges");
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 6; index += 1) {
    bytes[5 - index] = Number((timestamp >> BigInt(index * 8)) & 0xffn);
  }
  const randA = Number((tail >> 62n) & 0xfffn);
  const randB = tail & ((1n << 62n) - 1n);
  bytes[6] = 0x70 | (randA >> 8);
  bytes[7] = randA & 0xff;
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  for (let index = 0; index < 7; index += 1) {
    bytes[9 + index] = Number((randB >> BigInt((6 - index) * 8)) & 0xffn);
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return assertUUIDv7(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

function dreamUuidTimestampFromId(value: UUIDv7): bigint {
  return BigInt(`0x${value.replaceAll("-", "").slice(0, 12)}`);
}

function checkedDreamMaxAttempts(value: number | undefined): number {
  const attempts = value ?? 8;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 128) {
    throw new TypeError("maxCollisionAttempts must be an integer in [1,128]");
  }
  return attempts;
}

function createDreamUuidIssuer(options: ProductionDreamRunIdIssuerOptions = {}): ProductionDreamRunIdIssuer {
  const nowMs = options.nowMs ?? (() => Date.now());
  const entropy = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const maxAttempts = checkedDreamMaxAttempts(options.maxCollisionAttempts);
  const issuedIds = options.issuedIds ?? new Set<string>();
  let lastTimestamp: bigint | undefined;
  let lastTail: bigint | undefined;
  const issue = (): ProductionDreamRunIdReceipt => {
    const observed = dreamUuidTimestamp(nowMs());
    // A clock rollback cannot safely preserve the caller's temporal binding;
    // fail closed, matching the existing T05 UUID issuer seam.
    if (lastTimestamp !== undefined && observed < lastTimestamp) {
      throw new Error("Dream UUIDv7 clock moved backwards");
    }
    const timestamp = observed;
    let tail: bigint | undefined;
    let collisionTail: bigint | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (lastTimestamp !== undefined && timestamp === lastTimestamp && lastTail !== undefined) {
        const increment = BigInt(attempt + 1);
        if (lastTail > MAX_DREAM_UUID_TAIL - increment) {
          throw new Error("Dream UUIDv7 monotonic tail exhaustion");
        }
        tail = lastTail + increment;
      } else if (collisionTail !== undefined) {
        if (collisionTail === MAX_DREAM_UUID_TAIL) throw new Error("Dream UUIDv7 monotonic tail exhaustion");
        tail = collisionTail + 1n;
      } else {
        tail = dreamUuidTail(entropy(10));
      }
      const id = dreamUuidFromParts(timestamp, tail);
      if (issuedIds.has(id)) {
        collisionTail = tail;
        continue;
      }
      issuedIds.add(id);
      lastTimestamp = timestamp;
      lastTail = tail;
      const receipt = Object.freeze({
        kind: "t05_dream_run_id_receipt" as const,
        environment: "production" as const,
        dreamRunId: id,
      }) as ProductionDreamRunIdReceipt;
      PRODUCTION_DREAM_RUN_ID_RECEIPTS.add(receipt as unknown as object);
      DREAM_RUN_CHECKPOINT_STATES.set(receipt as unknown as object, {
        // Keep event identity collision tracking separate while reserving the
        // run id itself; deterministic test entropy must never deadlock pages.
        uuidIssuer: createDreamUuidIssuer({
          nowMs,
          randomBytes: entropy,
          maxCollisionAttempts: maxAttempts,
          issuedIds: new Set([id]),
        }),
        events: new Map(),
      });
      return receipt;
    }
    throw new Error("Dream UUIDv7 entropy collision or monotonic exhaustion");
  };
  return Object.freeze({
    environment: "production" as const,
    issue,
    issueDreamRunId: issue,
  });
}

export function createProductionDreamRunIdIssuer(
  options: ProductionDreamRunIdIssuerOptions = {},
): ProductionDreamRunIdIssuer {
  return createDreamUuidIssuer(options);
}

export function createProductionDreamRunIdReceipt(
  options: ProductionDreamRunIdIssuerOptions = {},
): ProductionDreamRunIdReceipt {
  return createDreamUuidIssuer(options).issue();
}

export const issueProductionDreamRunIdReceipt = createProductionDreamRunIdReceipt;

export function assertProductionDreamRunIdReceipt(value: unknown): ProductionDreamRunIdReceipt {
  if (typeof value !== "object" || value === null || !PRODUCTION_DREAM_RUN_ID_RECEIPTS.has(value)) {
    throw new TypeError("Dream run id is not a private production receipt");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\u0000") !== ["dreamRunId", "environment", "kind"].join("\u0000") ||
      Object.getOwnPropertySymbols(record).length !== 0 ||
      record.kind !== "t05_dream_run_id_receipt" || record.environment !== "production") {
    throw new TypeError("Dream run id receipt shape is invalid");
  }
  assertUUIDv7(record.dreamRunId);
  return value as ProductionDreamRunIdReceipt;
}

export function isProductionDreamRunIdReceipt(value: unknown): value is ProductionDreamRunIdReceipt {
  try {
    assertProductionDreamRunIdReceipt(value);
    return true;
  } catch {
    return false;
  }
}

function dreamRunIdProjectionBase(receipt: ProductionDreamRunIdReceipt): Record<string, unknown> {
  return {
    kind: "t05_dream_run_id_receipt_projection",
    environment: "production",
    dreamRunId: receipt.dreamRunId,
  };
}

export function projectProductionDreamRunIdReceipt(
  value: unknown,
): ProductionDreamRunIdReceiptProjection {
  const receipt = assertProductionDreamRunIdReceipt(value);
  const base = dreamRunIdProjectionBase(receipt);
  const projectionJcs = jcsSerialize(base, "Dream run id projection");
  const projectionSha256 = assertSha256(createHash("sha256").update(projectionJcs, "utf8").digest("hex"));
  return Object.freeze({ ...base, projectionJcs, projectionSha256 } as ProductionDreamRunIdReceiptProjection);
}

export function rehydrateProductionDreamRunIdReceipt(
  value: unknown,
): ProductionDreamRunIdReceipt {
  if (!isPlainDataRecord(value)) throw new TypeError("Dream run id projection must be a plain record");
  const keys = Object.keys(value).sort();
  const expected = ["dreamRunId", "environment", "kind", "projectionJcs", "projectionSha256"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("Dream run id projection keys are not closed");
  }
  if (value.kind !== "t05_dream_run_id_receipt_projection" || value.environment !== "production") {
    throw new TypeError("Dream run id projection header is invalid");
  }
  const dreamRunId = assertUUIDv7(value.dreamRunId);
  const projectionJcs = jcsSerialize({
    kind: "t05_dream_run_id_receipt_projection",
    environment: "production",
    dreamRunId,
  }, "Dream run id projection");
  const projectionSha256 = assertSha256(createHash("sha256").update(projectionJcs, "utf8").digest("hex"));
  if (value.projectionJcs !== projectionJcs || value.projectionSha256 !== projectionSha256) {
    throw new TypeError("Dream run id projection JCS/hash drifted");
  }
  const receipt = Object.freeze({
    kind: "t05_dream_run_id_receipt" as const,
    environment: "production" as const,
    dreamRunId,
  }) as ProductionDreamRunIdReceipt;
  PRODUCTION_DREAM_RUN_ID_RECEIPTS.add(receipt as unknown as object);
  DREAM_RUN_CHECKPOINT_STATES.set(receipt as unknown as object, {
    uuidIssuer: createDreamUuidIssuer({ issuedIds: new Set([dreamRunId]) }),
    events: new Map(),
  });
  return receipt;
}

export function assertProductionDreamRunIdReceiptProjection(
  value: unknown,
): ProductionDreamRunIdReceiptProjection {
  const receipt = rehydrateProductionDreamRunIdReceipt(value);
  return projectProductionDreamRunIdReceipt(receipt);
}

export const projectDreamRunIdReceipt = projectProductionDreamRunIdReceipt;
export const rehydrateDreamRunIdReceipt = rehydrateProductionDreamRunIdReceipt;

function assertNfcJson(
  value: unknown,
  field: string,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) throw new TypeError(`${field} must be NFC`);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff) throw new TypeError(`${field} contains an unpaired surrogate`);
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new TypeError(`${field} contains an unpaired surrogate`);
      }
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${field} contains an invalid number`);
    return;
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError(`${field} contains an unsupported value`);
  if (ancestors.has(value)) throw new TypeError(`${field} contains a cycle`);
  if (Array.isArray(value)) {
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError(`${field} contains a sparse array`);
      assertNfcJson(value[index], `${field}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${field} contains a non-plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${field} contains symbol keys`);
  ancestors.add(value);
  for (const key of Object.keys(value)) {
    if (key.normalize("NFC") !== key) throw new TypeError(`${field} contains a non-NFC key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`${field} contains an accessor`);
    assertNfcJson(descriptor.value, `${field}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function checkpointPlainString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  if (value.normalize("NFC") !== value) throw new TypeError(`${field} must be NFC`);
  return value;
}

function checkpointAuthorityWatermark(value: unknown, field: string): AuthorityWatermark {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !hasOwn(value, "authority_seq") ||
      typeof value.authority_seq !== "string" || !/^[1-9][0-9]*$/.test(value.authority_seq)) {
    throw new TypeError(`${field} must be a closed positive authority watermark`);
  }
  return Object.freeze({ authority_seq: value.authority_seq });
}

function checkpointCursor(value: unknown, field: string): DreamPageCheckpointCursorV1 {
  if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !== "authority_watermark\u0000token") {
    throw new TypeError(`${field} must be a closed cursor`);
  }
  return Object.freeze({
    token: checkpointPlainString(value.token, `${field}.token`),
    authority_watermark: checkpointAuthorityWatermark(value.authority_watermark, `${field}.authority_watermark`),
  });
}

function checkpointWireRef(value: unknown, field: string): DreamPageCheckpointPayloadV1["candidate_refs"][number] {
  if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !==
      "canonical_payload_sha256\u0000object_version\u0000ref_id\u0000ref_type") {
    throw new TypeError(`${field} must be a closed MemoryCandidate reference`);
  }
  const refId = assertUUIDv7(value.ref_id);
  if (value.ref_type !== "MemoryCandidate") throw new TypeError(`${field}.ref_type must be MemoryCandidate`);
  if (typeof value.object_version !== "string" || !/^[1-9][0-9]*$/.test(value.object_version)) {
    throw new TypeError(`${field}.object_version must be a positive decimal`);
  }
  const canonicalPayloadSha256 = assertSha256(value.canonical_payload_sha256);
  return Object.freeze({
    ref_type: "MemoryCandidate" as const,
    ref_id: refId,
    object_version: value.object_version,
    canonical_payload_sha256: canonicalPayloadSha256,
  });
}

function checkpointRefIdentity(value: DreamPageCheckpointPayloadV1["candidate_refs"][number]): string {
  return `${value.ref_type}\u0000${value.ref_id}\u0000${value.object_version}`;
}

function assertCheckpointPayload(value: unknown): DreamPageCheckpointPayloadV1 {
  if (!isPlainDataRecord(value)) throw new TypeError("Dream checkpoint payload must be a plain closed record");
  const required = [
    "dream_run_id", "user_id", "local_date", "time_zone", "window_from", "window_to",
    "pinned_watermark", "complete", "page_idempotency_key", "page_fingerprint",
    "command_fingerprint", "predecessor_fingerprint", "state_fingerprint",
    "read_receipt_fingerprint", "trusted_overlay_projection_fingerprint", "candidate_count", "candidate_refs",
  ];
  const optional = ["input_cursor", "next_cursor"];
  const actual = Object.keys(value).sort();
  const expected = [...required, ...optional].sort();
  if (actual.some((key) => !expected.includes(key)) || required.some((key) => !hasOwn(value, key))) {
    throw new TypeError("Dream checkpoint payload fields are not closed");
  }
  assertNfcJson(value, "Dream checkpoint payload");
  const dreamRunId = assertUUIDv7(value.dream_run_id);
  const userId = assertUUIDv7(value.user_id);
  const localDate = validLocalDate(value.local_date);
  const timeZone = validateTimeZone(value.time_zone);
  const windowFrom = assertCanonicalUtcInstant(value.window_from, "window_from");
  const windowTo = assertCanonicalUtcInstant(value.window_to, "window_to");
  if (compareCanonicalUtcInstants(windowFrom, windowTo) >= 0) throw new TypeError("Dream checkpoint window is not ordered");
  const pinnedWatermark = checkpointAuthorityWatermark(value.pinned_watermark, "pinned_watermark");
  const inputCursor = hasOwn(value, "input_cursor") ? checkpointCursor(value.input_cursor, "input_cursor") : undefined;
  const nextCursor = hasOwn(value, "next_cursor") ? checkpointCursor(value.next_cursor, "next_cursor") : undefined;
  if (inputCursor !== undefined && !sameOpaqueValue(inputCursor.authority_watermark, pinnedWatermark)) {
    throw new TypeError("input_cursor.authority_watermark must equal pinned_watermark");
  }
  if (nextCursor !== undefined && !sameOpaqueValue(nextCursor.authority_watermark, pinnedWatermark)) {
    throw new TypeError("next_cursor.authority_watermark must equal pinned_watermark");
  }
  if (typeof value.complete !== "boolean" || value.complete !== (nextCursor === undefined)) {
    throw new TypeError("complete must be true iff next_cursor is omitted");
  }
  const pageIdempotencyKey = checkpointPlainString(value.page_idempotency_key, "page_idempotency_key");
  if (pageIdempotencyKey.length < 16 || pageIdempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(pageIdempotencyKey)) {
    throw new TypeError("page_idempotency_key is not canonical");
  }
  const fingerprint = (field: string): Sha256 => assertSha256(value[field]);
  if (typeof value.candidate_count !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.candidate_count)) {
    throw new TypeError("candidate_count is not a canonical nonnegative decimal");
  }
  if (!Array.isArray(value.candidate_refs)) throw new TypeError("candidate_refs must be an array");
  const candidateRefs = value.candidate_refs.map((item, index) => checkpointWireRef(item, `candidate_refs[${index}]`));
  const identities = new Set<string>();
  for (let index = 0; index < candidateRefs.length; index += 1) {
    const current = candidateRefs[index]!;
    const identity = checkpointRefIdentity(current);
    if (identities.has(identity)) throw new TypeError("candidate_refs contains duplicate identity");
    identities.add(identity);
    if (index > 0) {
      const previous = candidateRefs[index - 1]!;
      const left = {
        refType: previous.ref_type,
        refId: previous.ref_id,
        objectVersion: previous.object_version,
        canonicalPayloadSha256: previous.canonical_payload_sha256,
      } as CanonicalObjectVersionRef;
      const right = {
        refType: current.ref_type,
        refId: current.ref_id,
        objectVersion: current.object_version,
        canonicalPayloadSha256: current.canonical_payload_sha256,
      } as CanonicalObjectVersionRef;
      if (compareCanonicalObjectVersionRefs(left, right) >= 0) throw new TypeError("candidate_refs must be RFC-003 ordered");
    }
  }
  if (value.candidate_count !== String(candidateRefs.length)) throw new TypeError("candidate_count does not match candidate_refs");
  return Object.freeze({
    dream_run_id: dreamRunId,
    user_id: userId,
    local_date: localDate,
    time_zone: timeZone,
    window_from: windowFrom,
    window_to: windowTo,
    pinned_watermark: pinnedWatermark,
    ...(inputCursor === undefined ? {} : { input_cursor: inputCursor }),
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    complete: value.complete,
    page_idempotency_key: pageIdempotencyKey,
    page_fingerprint: fingerprint("page_fingerprint"),
    command_fingerprint: fingerprint("command_fingerprint"),
    predecessor_fingerprint: fingerprint("predecessor_fingerprint"),
    state_fingerprint: fingerprint("state_fingerprint"),
    read_receipt_fingerprint: fingerprint("read_receipt_fingerprint"),
    trusted_overlay_projection_fingerprint: fingerprint("trusted_overlay_projection_fingerprint"),
    candidate_count: value.candidate_count,
    candidate_refs: Object.freeze(candidateRefs),
  });
}

const CHECKPOINT_EVENT_KEYS = [
  "aggregate_id", "aggregate_type", "event_id", "event_type", "event_version",
  "idempotency_key", "idempotency_scope", "payload", "payload_sha256",
] as const;

function assertCheckpointEvent(value: unknown): DreamPageCheckpointEventV1 {
  if (!isPlainDataRecord(value)) throw new TypeError("Dream checkpoint event must be a plain closed record");
  const actual = Object.keys(value).sort();
  const expected = [...CHECKPOINT_EVENT_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Dream checkpoint event fields are not closed");
  }
  assertNfcJson(value, "Dream checkpoint event");
  const payload = assertCheckpointPayload(value.payload);
  const eventId = assertUUIDv7(value.event_id);
  if (value.aggregate_type !== "memory_dream_run" || value.aggregate_id !== payload.dream_run_id ||
      value.event_type !== "memory.dream.page.checkpointed.v1" || value.event_version !== 1 ||
      value.idempotency_key !== payload.page_idempotency_key ||
      typeof value.idempotency_scope !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.idempotency_scope)) {
    throw new TypeError("Dream checkpoint event identity is not bound to the payload");
  }
  const payloadSha256 = assertSha256(value.payload_sha256);
  const payloadJcs = jcsSerialize(payload, "Dream checkpoint payload");
  const expectedPayloadSha256 = assertSha256(createHash("sha256").update(payloadJcs, "utf8").digest("hex"));
  if (payloadSha256 !== expectedPayloadSha256) throw new TypeError("Dream checkpoint payload hash drifted");
  return Object.freeze({
    event_id: eventId,
    aggregate_type: "memory_dream_run" as const,
    aggregate_id: payload.dream_run_id,
    event_type: "memory.dream.page.checkpointed.v1" as const,
    event_version: 1 as const,
    idempotency_scope: value.idempotency_scope,
    idempotency_key: payload.page_idempotency_key,
    payload,
    payload_sha256: payloadSha256,
  });
}

function bytesForUtf8(value: string): readonly number[] {
  return Object.freeze([...Buffer.from(value, "utf8")]);
}

function sameNumberArray(left: unknown, right: readonly number[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function checkpointEventProjectionBase(value: ProductionDreamPageCheckpointEventReceipt): Record<string, unknown> {
  return {
    kind: "t05_dream_page_checkpoint_event_projection",
    event: value.event,
    payloadJcs: value.payloadJcs,
    payloadBytes: value.payloadBytes,
    eventJcs: value.eventJcs,
    eventBytes: value.eventBytes,
    eventSha256: value.eventSha256,
  };
}

function assertCheckpointEventReceiptBody(value: unknown): ProductionDreamPageCheckpointEventReceipt {
  if (typeof value !== "object" || value === null || !PRODUCTION_DREAM_PAGE_CHECKPOINT_EVENT_RECEIPTS.has(value)) {
    throw new TypeError("Dream checkpoint event is not a private receipt");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["event", "eventBytes", "eventJcs", "eventSha256", "kind", "payloadBytes", "payloadJcs"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      Object.getOwnPropertySymbols(record).length !== 0 || record.kind !== "t05_dream_page_checkpoint_event_receipt") {
    throw new TypeError("Dream checkpoint event receipt fields are not closed");
  }
  const event = assertCheckpointEvent(record.event);
  const payloadJcs = jcsSerialize(event.payload, "Dream checkpoint payload");
  const eventJcs = jcsSerialize(event, "Dream checkpoint event");
  const payloadBytes = bytesForUtf8(payloadJcs);
  const eventBytes = bytesForUtf8(eventJcs);
  const eventSha256 = assertSha256(createHash("sha256").update(eventJcs, "utf8").digest("hex"));
  if (record.payloadJcs !== payloadJcs || record.eventJcs !== eventJcs ||
      !sameNumberArray(record.payloadBytes, payloadBytes) || !sameNumberArray(record.eventBytes, eventBytes) ||
      record.eventSha256 !== eventSha256) {
    throw new TypeError("Dream checkpoint event receipt bytes/hash drifted");
  }
  return value as ProductionDreamPageCheckpointEventReceipt;
}

export function assertProductionDreamPageCheckpointEventReceipt(
  value: unknown,
): ProductionDreamPageCheckpointEventReceipt {
  return assertCheckpointEventReceiptBody(value);
}

export function isProductionDreamPageCheckpointEventReceipt(
  value: unknown,
): value is ProductionDreamPageCheckpointEventReceipt {
  try {
    assertCheckpointEventReceiptBody(value);
    return true;
  } catch {
    return false;
  }
}

export function createProductionDreamPageCheckpointEventReceipt(
  input: { readonly event: DreamPageCheckpointEventV1 } | DreamPageCheckpointEventV1,
): ProductionDreamPageCheckpointEventReceipt {
  const candidate = input as unknown as Record<string, unknown>;
  const event = assertCheckpointEvent(hasOwn(candidate, "event") ? candidate.event : input);
  const payloadJcs = jcsSerialize(event.payload, "Dream checkpoint payload");
  const eventJcs = jcsSerialize(event, "Dream checkpoint event");
  const receipt = Object.freeze({
    kind: "t05_dream_page_checkpoint_event_receipt" as const,
    event,
    payloadJcs,
    payloadBytes: bytesForUtf8(payloadJcs),
    eventJcs,
    eventBytes: bytesForUtf8(eventJcs),
    eventSha256: assertSha256(createHash("sha256").update(eventJcs, "utf8").digest("hex")),
  }) as ProductionDreamPageCheckpointEventReceipt;
  PRODUCTION_DREAM_PAGE_CHECKPOINT_EVENT_RECEIPTS.add(receipt as unknown as object);
  return receipt;
}

export function projectProductionDreamPageCheckpointEventReceipt(
  value: unknown,
): ProductionDreamPageCheckpointEventProjection {
  const receipt = assertCheckpointEventReceiptBody(value);
  const base = checkpointEventProjectionBase(receipt);
  const projectionJcs = jcsSerialize(base, "Dream checkpoint event projection");
  const projectionSha256 = assertSha256(createHash("sha256").update(projectionJcs, "utf8").digest("hex"));
  return Object.freeze({ ...base, projectionJcs, projectionSha256 } as ProductionDreamPageCheckpointEventProjection);
}

export function rehydrateProductionDreamPageCheckpointEventReceipt(
  value: unknown,
): ProductionDreamPageCheckpointEventReceipt {
  if (!isPlainDataRecord(value)) throw new TypeError("Dream checkpoint event projection must be a plain record");
  const keys = Object.keys(value).sort();
  const expected = [
    "event", "eventBytes", "eventJcs", "eventSha256", "kind", "payloadBytes", "payloadJcs",
    "projectionJcs", "projectionSha256",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("Dream checkpoint event projection fields are not closed");
  }
  if (value.kind !== "t05_dream_page_checkpoint_event_projection") {
    throw new TypeError("Dream checkpoint event projection kind is invalid");
  }
  const event = assertCheckpointEvent(value.event);
  const raw = createProductionDreamPageCheckpointEventReceipt({ event });
  if (value.payloadJcs !== raw.payloadJcs || value.eventJcs !== raw.eventJcs ||
      !sameNumberArray(value.payloadBytes, raw.payloadBytes) || !sameNumberArray(value.eventBytes, raw.eventBytes) ||
      value.eventSha256 !== raw.eventSha256) {
    throw new TypeError("Dream checkpoint event projection bytes/hash drifted");
  }
  const expectedProjection = projectProductionDreamPageCheckpointEventReceipt(raw);
  if (value.projectionJcs !== expectedProjection.projectionJcs || value.projectionSha256 !== expectedProjection.projectionSha256) {
    throw new TypeError("Dream checkpoint event projection JCS/hash drifted");
  }
  return raw;
}

export function assertProductionDreamPageCheckpointEventProjection(
  value: unknown,
): ProductionDreamPageCheckpointEventProjection {
  const receipt = rehydrateProductionDreamPageCheckpointEventReceipt(value);
  return projectProductionDreamPageCheckpointEventReceipt(receipt);
}

export const projectDreamPageCheckpointEvent = projectProductionDreamPageCheckpointEventReceipt;
export const rehydrateDreamPageCheckpointEvent = rehydrateProductionDreamPageCheckpointEventReceipt;
export const projectProductionDreamCheckpointEventReceipt = projectProductionDreamPageCheckpointEventReceipt;
export const rehydrateProductionDreamCheckpointEventReceipt = rehydrateProductionDreamPageCheckpointEventReceipt;

export type DreamRunEnvironment = "source" | "production";
const PRODUCTION_DREAM_RUN_TOKEN = Object.freeze({});
const STRICT_DURABLE_DREAM_RUN_TOKEN = Object.freeze({});
const LEGACY_DURABLE_DREAM_RUN_TOKEN = Object.freeze({});

export interface DreamRunWindow extends CanonicalUtcWindow {
  readonly timeZone: string;
  readonly localDate: string;
  readonly durationHours: 23 | 24 | 25;
}

/**
 * The overlay is a read-only owner projection.  It is applied before the
 * extractor sees a delta, so deleted or suppressed evidence cannot turn into
 * a candidate by model inference.
 */
export interface DreamSuppressionOverlay {
  readonly deletedRefs?: readonly CanonicalObjectVersionRef[];
  readonly suppressedRefs?: readonly CanonicalObjectVersionRef[];
  readonly blockedRefs?: readonly CanonicalObjectVersionRef[];
  readonly deleted?: readonly CanonicalObjectVersionRef[];
  readonly suppressed?: readonly CanonicalObjectVersionRef[];
  readonly isDeleted?: (
    ref: CanonicalObjectVersionRef,
  ) => boolean | Promise<boolean>;
  readonly isSuppressed?: (
    ref: CanonicalObjectVersionRef,
  ) => boolean | Promise<boolean>;
}

/**
 * Production overlay snapshot.  The explicit empty arrays are meaningful:
 * they prove the owner checked deletion/suppression at this page watermark.
 */
export interface DreamSuppressionOverlaySnapshot extends DreamSuppressionOverlay {
  readonly kind?: "dream_suppression_overlay_snapshot";
  readonly authorityWatermark: AuthorityWatermark;
}

export interface DreamSuppressionOverlayReader {
  readDreamOverlay?(input: {
    readonly userId: string;
    readonly window: CanonicalUtcWindow;
    readonly authorityWatermark: AuthorityWatermark;
  }): Promise<DreamSuppressionOverlay | undefined>;
  readOverlay?(input: {
    readonly userId: string;
    readonly window: CanonicalUtcWindow;
    readonly authorityWatermark: AuthorityWatermark;
  }): Promise<DreamSuppressionOverlay | undefined>;
  readSuppressionOverlay?(input: {
    readonly userId: string;
    readonly window: CanonicalUtcWindow;
    readonly authorityWatermark: AuthorityWatermark;
  }): Promise<DreamSuppressionOverlay | undefined>;
}

export type ProductionDreamSuppressionOverlayReader =
  | {
      readonly readDreamOverlay: (input: {
        readonly userId: string;
        readonly window: CanonicalUtcWindow;
        readonly authorityWatermark: AuthorityWatermark;
      }) => Promise<DreamSuppressionOverlaySnapshot>;
    }
  | {
      readonly readOverlay: (input: {
        readonly userId: string;
        readonly window: CanonicalUtcWindow;
        readonly authorityWatermark: AuthorityWatermark;
      }) => Promise<DreamSuppressionOverlaySnapshot>;
    }
  | {
      readonly readSuppressionOverlay: (input: {
        readonly userId: string;
        readonly window: CanonicalUtcWindow;
        readonly authorityWatermark: AuthorityWatermark;
      }) => Promise<DreamSuppressionOverlaySnapshot>;
    };

export interface DreamCandidateBatchCommitter {
  commitCandidateBatch(input: {
    readonly batchId: string;
    readonly idempotencyKey: string;
    readonly fingerprint: Sha256;
    readonly candidates: readonly import("./admission.ts").AdmittedMemoryCandidateIntent[];
    readonly productionReceipts?: readonly ProductionMemoryIssuerReceipt[];
  }): Promise<MemoryCommandResult<MemoryCommitReceipt>>;
}

/**
 * Closed T03-owner projection consumed by the durable page seam.  The three
 * arrays are deliberately mandatory, including when each is empty: this seam
 * verifies and passes through owner decisions but does not invent them.
 */
export interface DurableDreamOwnerOverlayProjection {
  readonly kind: "durable_dream_owner_overlay_projection";
  readonly authorityWatermark: AuthorityWatermark;
  readonly deletedRefs: readonly CanonicalObjectVersionRef[];
  readonly suppressedRefs: readonly CanonicalObjectVersionRef[];
  readonly blockedRefs: readonly CanonicalObjectVersionRef[];
}

export interface TrustedDreamOwnerOverlayReader {
  readOwnerOverlay(input: {
    readonly userId: string;
    readonly window: CanonicalUtcWindow;
    readonly pinnedWatermark: AuthorityWatermark;
    readonly inputCursor?: AcceptedDreamDeltaCursor;
  }): Promise<DurableDreamOwnerOverlayProjection>;
}

export interface DurableDreamPagePredecessor {
  readonly kind: "durable_dream_page_predecessor";
  readonly pinnedWatermark: AuthorityWatermark;
  readonly inputCursor?: AcceptedDreamDeltaCursor;
}

export interface DurableDreamPageState {
  readonly kind: "durable_dream_page_state";
  readonly pinnedWatermark: AuthorityWatermark;
  readonly complete: boolean;
  readonly nextCursor?: AcceptedDreamDeltaCursor;
}

export interface DurableDreamRunReadReceipt {
  readonly kind: "durable_dream_page_read_receipt";
  readonly userId: string;
  readonly timeZone: string;
  readonly localDate: string;
  readonly window: DreamRunWindow;
  readonly pinnedWatermark: AuthorityWatermark;
  readonly inputCursor?: AcceptedDreamDeltaCursor;
  readonly nextCursor?: AcceptedDreamDeltaCursor;
  readonly pageDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedEvidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly excludedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly pageRecordCount: number;
  readonly pageRecordsFingerprint: Sha256;
}

export interface DurableDreamPageCommitCommand {
  readonly kind: "durable_dream_page_commit_command";
  readonly schema: "t05.daily-dream.durable-page-command.v1";
  readonly userId: string;
  readonly timeZone: string;
  readonly localDate: string;
  readonly window: DreamRunWindow;
  readonly batchId: string;
  readonly batchIdempotencyKey: string;
  readonly pageIdempotencyKey: string;
  /** Present when the caller opts into the RFC-011 checkpoint-event seam. */
  readonly dreamRunId?: UUIDv7;
  readonly dreamRunIdReceipt?: ProductionDreamRunIdReceipt;
  readonly dreamRunIdProjection?: ProductionDreamRunIdReceiptProjection;
  readonly pinnedWatermark: AuthorityWatermark;
  readonly inputCursor?: AcceptedDreamDeltaCursor;
  readonly nextCursor?: AcceptedDreamDeltaCursor;
  readonly readReceipt: DurableDreamRunReadReceipt;
  readonly ownerProjection: DurableDreamOwnerOverlayProjection;
  readonly batch: DreamCandidateBatch;
  readonly candidates: DreamCandidateBatch["candidates"];
  readonly productionReceipts: readonly ProductionMemoryIssuerReceipt[];
  readonly productionReceiptProjections: readonly ProductionMemoryIssuerReceiptProjection[];
  readonly predecessor: DurableDreamPagePredecessor;
  readonly predecessorFingerprint: Sha256;
  readonly state: DurableDreamPageState;
  readonly stateFingerprint: Sha256;
  readonly fingerprint: Sha256;
  readonly checkpointEventReceipt?: ProductionDreamPageCheckpointEventReceipt;
  readonly checkpointEventProjection?: ProductionDreamPageCheckpointEventProjection;
  /** Compatibility alias for the projection. */
  readonly checkpointEvent?: ProductionDreamPageCheckpointEventProjection;
}

export interface DurableDreamPageCommitReceipt {
  readonly kind: "durable_dream_page_commit_receipt";
  readonly outcome: "committed" | "replayed";
  readonly pageIdempotencyKey: string;
  readonly command: DurableDreamPageCommitCommand;
  readonly fingerprint: Sha256;
  readonly predecessor: DurableDreamPagePredecessor;
  readonly predecessorFingerprint: Sha256;
  readonly state: DurableDreamPageState;
  readonly stateFingerprint: Sha256;
  readonly canonicalRefs: readonly CanonicalObjectVersionRef[];
  readonly checkpointEvent?: ProductionDreamPageCheckpointEventProjection;
  readonly checkpointEventReceipt?: ProductionDreamPageCheckpointEventReceipt;
  readonly checkpointEventProjection?: ProductionDreamPageCheckpointEventProjection;
}

export interface DurableDreamPageCommitter {
  commitDreamPage(command: DurableDreamPageCommitCommand): Promise<DurableDreamPageCommitReceipt>;
}

export interface DreamRunServiceOptions {
  readonly reader?: AcceptedDreamDeltaReader;
  readonly acceptedDeltaReader?: AcceptedDreamDeltaReader;
  readonly extractor?: DreamApplicationExtractor;
  readonly candidateExtractor?: DreamApplicationExtractor;
  /** Omitted by design for source-only, no-side-effect candidate generation. */
  readonly commandRepository?: MemoryCommandRepository;
  /** An explicit committer may atomically persist candidate rows when granted. */
  readonly committer?: DreamCandidateBatchCommitter;
  readonly environment?: DreamRunEnvironment;
  readonly production?: boolean;
  readonly overlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  readonly deletionOverlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  readonly suppressionOverlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  /** Trusted owner overlay reader used only by the production factory. */
  readonly trustedOverlayReader?: DreamSuppressionOverlayReader | ProductionDreamSuppressionOverlayReader;
  readonly ownerOverlayReader?: DreamSuppressionOverlayReader;
  readonly productionReceipt?: ProductionMemoryIssuerReceipt;
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
  readonly productionReceipts?: readonly ProductionMemoryIssuerReceipt[];
  readonly issuerReceipts?: readonly ProductionMemoryIssuerReceipt[];
}

export interface DreamRunInput {
  readonly userId: string;
  /** IANA name; fixed-offset strings are rejected. */
  readonly timeZone?: string;
  readonly ianaTimeZone?: string;
  /** Compatibility spelling accepted only when `timeZone` is absent. */
  readonly timezone?: string;
  /** Local calendar date in the selected IANA zone. */
  readonly localDate?: string;
  readonly calendarDate?: string;
  /** Compatibility spelling accepted only when `localDate` is absent. */
  readonly date?: string;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly cursor?: AcceptedDreamDeltaCursor;
  /** Caller-pinned watermark for continuation pages. */
  readonly pinnedWatermark?: AuthorityWatermark;
  readonly limit?: number;
  readonly modelConfidenceThresholdPpm?: number;
  readonly overlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  readonly deletionOverlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  readonly suppressionOverlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  readonly environment?: DreamRunEnvironment;
  readonly production?: boolean;
  /** One existing private-branded receipt for a one-candidate production run. */
  readonly productionReceipt?: ProductionMemoryIssuerReceipt;
  readonly issuerReceipt?: ProductionMemoryIssuerReceipt;
  /** Existing private-branded receipts, one per candidate, for a source-only result. */
  readonly productionReceipts?: readonly ProductionMemoryIssuerReceipt[];
  readonly issuerReceipts?: readonly ProductionMemoryIssuerReceipt[];
}

export interface DreamRunReadReceipt {
  readonly kind: "dream_run_read_receipt";
  readonly userId: string;
  readonly timeZone: string;
  readonly localDate: string;
  readonly window: DreamRunWindow;
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly excludedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
  readonly nextCursor?: AcceptedDreamDeltaCursor;
}

export interface DreamRunResult {
  readonly kind: "daily_dream_run";
  readonly outcome: "candidate_intents" | "no_candidates" | "committed" | "replayed" | "commit_rejected";
  readonly userId: string;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly timeZone: string;
  readonly localDate: string;
  readonly window: DreamRunWindow;
  readonly fingerprint: Sha256;
  readonly pinnedWatermark: AuthorityWatermark;
  readonly readReceipt: DreamRunReadReceipt;
  /** Candidate intents are review-invisible and never current/durable memories. */
  readonly candidates: DreamCandidateBatch["candidates"];
  readonly batch: DreamCandidateBatch;
  readonly productionReceipts?: readonly ProductionMemoryIssuerReceipt[];
  readonly productionReceipt?: ProductionMemoryIssuerReceipt;
  readonly commitReceipt?: MemoryCommitReceipt;
  readonly error?: MemoryCommandError;
}

export type DurableProductionDreamRunInput = Omit<
  DreamRunInput,
  "pinnedWatermark" | "overlay" | "deletionOverlay" | "suppressionOverlay" |
  "environment" | "production"
> & {
  /** Persisted first-page/retry pin; required and forwarded unchanged after normalization. */
  readonly pinnedWatermark: AuthorityWatermark;
  /** Stable page-level retry identity, separate from the batch idempotency key. */
  readonly pageIdempotencyKey: string;
  /** The same private run receipt must be carried across every page/replay. */
  readonly dreamRunIdReceipt?: ProductionDreamRunIdReceipt;
  /** Compatibility spellings retained only as aliases for the private receipt. */
  readonly runIdReceipt?: ProductionDreamRunIdReceipt;
  readonly productionDreamRunIdReceipt?: ProductionDreamRunIdReceipt;
};

export interface DurableProductionDreamRunResult {
  readonly kind: "durable_daily_dream_page";
  readonly outcome: "committed" | "replayed";
  readonly userId: string;
  readonly batchId: string;
  readonly batchIdempotencyKey: string;
  readonly pageIdempotencyKey: string;
  readonly dreamRunId?: UUIDv7;
  readonly dreamRunIdReceipt?: ProductionDreamRunIdReceipt;
  readonly dreamRunIdProjection?: ProductionDreamRunIdReceiptProjection;
  readonly timeZone: string;
  readonly localDate: string;
  readonly window: DreamRunWindow;
  readonly pinnedWatermark: AuthorityWatermark;
  readonly readReceipt: DurableDreamRunReadReceipt;
  readonly ownerProjection: DurableDreamOwnerOverlayProjection;
  readonly candidates: DreamCandidateBatch["candidates"];
  readonly batch: DreamCandidateBatch;
  readonly productionReceipts: readonly ProductionMemoryIssuerReceipt[];
  readonly fingerprint: Sha256;
  readonly command: DurableDreamPageCommitCommand;
  readonly commitReceipt: DurableDreamPageCommitReceipt;
  readonly canonicalRefs: readonly CanonicalObjectVersionRef[];
  readonly checkpointEvent?: ProductionDreamPageCheckpointEventProjection;
  readonly checkpointEventReceipt?: ProductionDreamPageCheckpointEventReceipt;
  readonly checkpointEventProjection?: ProductionDreamPageCheckpointEventProjection;
}

export interface DurableProductionDreamRunServiceOptions {
  readonly reader: AcceptedDreamDeltaReader;
  readonly extractor: DreamApplicationExtractor;
  readonly trustedOverlayReader: TrustedDreamOwnerOverlayReader;
  readonly durableCommitter: DurableDreamPageCommitter;
}

export type DreamRunErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_TIMEZONE"
  | "INVALID_LOCAL_DATE"
  | "INVALID_WINDOW"
  | "READER_FAILED"
  | "READER_CONTRACT_VIOLATION"
  | "OVERLAY_CONTRACT_VIOLATION"
  | "EXTRACTOR_FAILED"
  | "EXTRACTOR_CONTRACT_VIOLATION"
  | "FINGERPRINT_FAILED"
  | "PRODUCTION_RECEIPT_REQUIRED"
  | "PRODUCTION_RECEIPT_INVALID"
  | "PRODUCTION_ENTRY_REQUIRED"
  | "DURABLE_COMMIT_RECEIPT_INVALID"
  | "COMMIT_FAILED";

export class DreamRunError extends Error {
  readonly code: DreamRunErrorCode;
  readonly causeValue: unknown;

  constructor(code: DreamRunErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.name = "DreamRunError";
    this.code = code;
    this.causeValue = causeValue;
  }
}

interface NormalizedPage {
  readonly records: readonly AcceptedDreamDeltaRecord[];
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedEvidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly excludedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
  readonly nextCursor?: AcceptedDreamDeltaCursor;
}

interface NormalizedRunInput {
  readonly userId: string;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly window: DreamRunWindow;
  readonly cursor?: AcceptedDreamDeltaCursor;
  readonly pinnedWatermark?: AuthorityWatermark;
  readonly limit: number;
  readonly modelConfidenceThresholdPpm: number;
  readonly environment: DreamRunEnvironment;
  readonly overlay?: DreamSuppressionOverlay | DreamSuppressionOverlayReader;
  readonly productionReceipts: readonly ProductionMemoryIssuerReceipt[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stableSerialize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  if (value === undefined) return '"[undefined]"';
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite value");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("opaque value is not JSON-compatible");
  if (seen.has(value)) throw new TypeError("opaque value contains a cycle");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("opaque value must be a plain object");
  }
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    const record = value as Record<string, unknown>;
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function cloneJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): ReadonlyJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("value is not JSON-compatible");
  if (ancestors.has(value)) throw new TypeError("JSON value contains a cycle");
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    ancestors.add(value);
    const result = value.map((item) => cloneJsonValue(item, ancestors));
    ancestors.delete(value);
    return Object.freeze(result);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("JSON object must be plain");
  }
  ancestors.add(value);
  const result: Record<string, ReadonlyJsonValue> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) result[key] = cloneJsonValue(record[key], ancestors);
  ancestors.delete(value);
  return Object.freeze(result);
}

function cloneRef(value: unknown): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function stableOpaqueWatermark(value: unknown, field: string): AppendOnlyAuthorityWatermark {
  try {
    // Reuse the owner-port validator: it rejects undefined/null/empty values,
    // -0/non-finite numbers, cycles, accessors, symbols and unstable reads,
    // then returns a JSON-cloned, recursively frozen value.
    return assertAppendOnlyAuthorityWatermark(value);
  } catch (error) {
    throw new DreamRunError("READER_CONTRACT_VIOLATION", `${field} is not a pinned stable opaque watermark`, error);
  }
}

function sameOpaqueValue(left: unknown, right: unknown): boolean {
  try {
    return stableSerialize(assertAppendOnlyAuthorityWatermark(left)) ===
      stableSerialize(assertAppendOnlyAuthorityWatermark(right));
  } catch {
    return false;
  }
}

function assertCursor(value: unknown, field: string): AcceptedDreamDeltaCursor {
  if (!isRecord(value) || !isNonEmptyString(value.token)) {
    throw new DreamRunError("INVALID_REQUEST", `${field}.token must be non-empty`);
  }
  const authorityWatermark = stableOpaqueWatermark(value.authorityWatermark, `${field}.authorityWatermark`);
  return Object.freeze({ token: value.token.trim(), authorityWatermark });
}

function validLocalDate(value: unknown): string {
  if (typeof value !== "string") throw new DreamRunError("INVALID_LOCAL_DATE", "localDate must be YYYY-MM-DD");
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (match === null) throw new DreamRunError("INVALID_LOCAL_DATE", "localDate must be YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new DreamRunError("INVALID_LOCAL_DATE", "localDate is not a valid calendar date");
  }
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(0, 0, 0, 0);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new DreamRunError("INVALID_LOCAL_DATE", "localDate is not a valid calendar date");
  }
  return value;
}

function validateTimeZone(value: unknown): string {
  if (!isNonEmptyString(value) || /^[+-]\d{2}(?::?\d{2})?$/.test(value.trim())) {
    throw new DreamRunError("INVALID_TIMEZONE", "timeZone must be an IANA time zone name");
  }
  const timeZone = value.trim();
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone });
    formatter.format(0);
  } catch (error) {
    throw new DreamRunError("INVALID_TIMEZONE", "timeZone is not a supported IANA time zone", error);
  }
  return timeZone;
}

function agreedAliasValue(
  values: readonly { readonly name: string; readonly value: unknown }[],
  code: "INVALID_TIMEZONE" | "INVALID_LOCAL_DATE" | "PRODUCTION_RECEIPT_INVALID",
  label: string,
): unknown {
  const supplied = values.filter((entry) => entry.value !== undefined);
  if (supplied.length === 0) return undefined;
  const first = supplied[0]!.value;
  const normalizedFirst = typeof first === "string" ? first.trim() : first;
  for (const entry of supplied.slice(1)) {
    const normalized = typeof entry.value === "string" ? entry.value.trim() : entry.value;
    if (typeof normalizedFirst !== typeof normalized || normalizedFirst !== normalized) {
      throw new DreamRunError(code, `${label} aliases disagree (${supplied[0]!.name} vs ${entry.name})`);
    }
  }
  return normalizedFirst;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localPartsAt(formatter: Intl.DateTimeFormat, milliseconds: number): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(milliseconds)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function localMidnightUtc(localDate: string, timeZone: string): number {
  const [yearText, monthText, dayText] = localDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const nominalDate = new Date(0);
  nominalDate.setUTCFullYear(year, month - 1, day);
  nominalDate.setUTCHours(0, 0, 0, 0);
  const nominal = nominalDate.getTime();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const atNominal = localPartsAt(formatter, nominal);
  const target = { year, month, day, hour: 0, minute: 0, second: 0 };
  const partsToUtc = (parts: LocalParts): number => {
    const value = new Date(0);
    value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    value.setUTCHours(parts.hour, parts.minute, parts.second, 0);
    return value.getTime();
  };
  const targetMatch = (candidate: number): boolean => {
    const actual = localPartsAt(formatter, candidate);
    return actual.year === target.year && actual.month === target.month && actual.day === target.day &&
      actual.hour === target.hour && actual.minute === target.minute && actual.second === target.second;
  };
  const nominalLocalAsUtc = partsToUtc(atNominal);
  const estimate = nominal - (nominalLocalAsUtc - nominal);
  const matches = new Set<number>();

  // Correct a UTC estimate by the observed local-vs-UTC difference.  A few
  // additional seeds cover date-line changes while keeping this source seam
  // cheap enough for focused tests and repeated daily reads.
  for (let seedHours = -48; seedHours <= 48; seedHours += 12) {
    let candidate = estimate + seedHours * 3_600_000;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const actual = localPartsAt(formatter, candidate);
      const adjustment = nominal - partsToUtc(actual);
      candidate += adjustment;
      if (targetMatch(candidate)) {
        matches.add(candidate);
        break;
      }
      if (adjustment === 0) break;
    }
  }

  // Midnight can be ambiguous during a fall-back transition.  Search a small
  // neighbourhood around every converged result and choose the earliest UTC
  // instant, which gives a deterministic half-open window.
  const converged = [...matches];
  for (const candidate of converged) {
    for (let delta = -3 * 3_600_000; delta <= 3 * 3_600_000; delta += 60_000) {
      const nearby = candidate + delta;
      if (targetMatch(nearby)) matches.add(nearby);
    }
  }
  if (matches.size === 0) {
    throw new DreamRunError("INVALID_WINDOW", `local midnight does not exist in ${timeZone}`);
  }
  return Math.min(...matches);
}

function dailyWindow(localDate: string, timeZone: string): DreamRunWindow {
  const fromMilliseconds = localMidnightUtc(localDate, timeZone);
  const nextDate = new Date(0);
  const [yearText, monthText, dayText] = localDate.split("-");
  nextDate.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText) + 1);
  nextDate.setUTCHours(0, 0, 0, 0);
  const nextLocalDate = `${String(nextDate.getUTCFullYear()).padStart(4, "0")}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDate.getUTCDate()).padStart(2, "0")}`;
  const toMilliseconds = localMidnightUtc(nextLocalDate, timeZone);
  if (!Number.isFinite(fromMilliseconds) || !Number.isFinite(toMilliseconds) || toMilliseconds <= fromMilliseconds) {
    throw new DreamRunError("INVALID_WINDOW", "Dream local date produced an empty or reversed UTC window");
  }
  const durationHours = (toMilliseconds - fromMilliseconds) / 3_600_000;
  if (durationHours !== 23 && durationHours !== 24 && durationHours !== 25) {
    throw new DreamRunError("INVALID_WINDOW", "Dream daily window must cover 23, 24, or 25 UTC hours");
  }
  const from = assertCanonicalUtcInstant(new Date(fromMilliseconds).toISOString(), "window.from");
  const to = assertCanonicalUtcInstant(new Date(toMilliseconds).toISOString(), "window.to");
  if (compareCanonicalUtcInstants(from, to) >= 0) {
    throw new DreamRunError("INVALID_WINDOW", "Dream window must be a non-empty UTC half-open interval");
  }
  return Object.freeze({
    timeZone,
    localDate,
    from,
    to,
    durationHours: durationHours as 23 | 24 | 25,
  });
}

/** Resolve one IANA local calendar date without reading or writing any store. */
export function createDreamRunWindow(input: {
  readonly timeZone?: string;
  readonly timezone?: string;
  readonly ianaTimeZone?: string;
  readonly localDate?: string;
  readonly date?: string;
  readonly calendarDate?: string;
}): DreamRunWindow {
  const zone = agreedAliasValue([
    { name: "timeZone", value: input.timeZone },
    { name: "timezone", value: input.timezone },
    { name: "ianaTimeZone", value: input.ianaTimeZone },
  ], "INVALID_TIMEZONE", "timeZone");
  const date = agreedAliasValue([
    { name: "localDate", value: input.localDate },
    { name: "date", value: input.date },
    { name: "calendarDate", value: input.calendarDate },
  ], "INVALID_LOCAL_DATE", "localDate");
  return dailyWindow(validLocalDate(date), validateTimeZone(zone));
}

export const resolveDreamRunWindow = createDreamRunWindow;

function normalizeInput(
  input: DreamRunInput,
  options: DreamRunServiceOptions,
): NormalizedRunInput {
  if (!isRecord(input) || !isNonEmptyString(input.userId) || !isNonEmptyString(input.batchId) ||
      !isNonEmptyString(input.idempotencyKey)) {
    throw new DreamRunError("INVALID_REQUEST", "userId, batchId, and idempotencyKey are required");
  }
  const timeZoneValue = agreedAliasValue([
    { name: "timeZone", value: input.timeZone },
    { name: "timezone", value: input.timezone },
    { name: "ianaTimeZone", value: input.ianaTimeZone },
  ], "INVALID_TIMEZONE", "timeZone");
  const dateValue = agreedAliasValue([
    { name: "localDate", value: input.localDate },
    { name: "date", value: input.date },
    { name: "calendarDate", value: input.calendarDate },
  ], "INVALID_LOCAL_DATE", "localDate");
  const timeZone = validateTimeZone(timeZoneValue);
  const localDate = validLocalDate(dateValue);
  const window = dailyWindow(localDate, timeZone);
  let cursor: AcceptedDreamDeltaCursor | undefined;
  if (input.cursor !== undefined) cursor = assertCursor(input.cursor, "cursor");
  const pinnedWatermark = input.pinnedWatermark === undefined
    ? undefined
    : stableOpaqueWatermark(input.pinnedWatermark, "pinnedWatermark");
  if (cursor !== undefined && pinnedWatermark !== undefined && !sameOpaqueValue(cursor.authorityWatermark, pinnedWatermark)) {
    throw new DreamRunError("INVALID_REQUEST", "cursor watermark does not match pinnedWatermark");
  }
  const limit = input.limit ?? DEFAULT_DREAM_RUN_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DREAM_RUN_PAGE_LIMIT) {
    throw new DreamRunError("INVALID_REQUEST", `limit must be an integer in [1, ${MAX_DREAM_RUN_PAGE_LIMIT}]`);
  }
  const threshold = input.modelConfidenceThresholdPpm ?? DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1_000_000) {
    throw new DreamRunError("INVALID_REQUEST", "modelConfidenceThresholdPpm must be an integer from 0 to 1000000");
  }
  const inputReceipt = input.productionReceipt ?? input.issuerReceipt;
  const inputReceipts = input.productionReceipts ?? input.issuerReceipts;
  if (input.productionReceipt !== undefined && input.issuerReceipt !== undefined && input.productionReceipt !== input.issuerReceipt) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipt and issuerReceipt disagree");
  }
  if (input.productionReceipts !== undefined && input.issuerReceipts !== undefined && input.productionReceipts !== input.issuerReceipts) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipts and issuerReceipts disagree");
  }
  if (options.productionReceipt !== undefined && options.issuerReceipt !== undefined && options.productionReceipt !== options.issuerReceipt) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipt and issuerReceipt options disagree");
  }
  if (options.productionReceipts !== undefined && options.issuerReceipts !== undefined && options.productionReceipts !== options.issuerReceipts) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipts and issuerReceipts options disagree");
  }
  const optionReceipt = options.productionReceipt ?? options.issuerReceipt;
  const optionReceipts = options.productionReceipts ?? options.issuerReceipts;
  const receipts = inputReceipts ??
    (inputReceipt === undefined
      ? (optionReceipts ?? (optionReceipt === undefined ? [] : [optionReceipt]))
      : [inputReceipt]);
  const configuredProduction = options.environment === "production" || options.production === true;
  if (configuredProduction && (hasOwn(input, "environment") || hasOwn(input, "production"))) {
    throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production environment is fixed by the production factory");
  }
  if (!configuredProduction &&
      (input.environment === "production" || input.production === true || inputReceipt !== undefined || inputReceipts !== undefined)) {
    throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production inputs require createProductionDreamRunService");
  }
  const environment = configuredProduction
    ? "production"
    : input.environment ?? (receipts.length > 0 ? "production" : "source");
  if (environment !== "source" && environment !== "production") {
    throw new DreamRunError("INVALID_REQUEST", "environment must be source or production");
  }
  if (inputReceipt !== undefined && inputReceipts !== undefined) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipt and productionReceipts cannot both be supplied");
  }
  const callerOverlayAliases = ["overlay", "deletionOverlay", "suppressionOverlay"]
    .filter((key) => hasOwn(input, key));
  const configuredOverlay = options.trustedOverlayReader ?? options.ownerOverlayReader ??
    options.overlay ?? options.deletionOverlay ?? options.suppressionOverlay;
  if (configuredProduction) {
    if (callerOverlayAliases.length > 0) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "caller overlay aliases cannot override the trusted production overlay");
    }
    if (overlayReaderMethod(configuredOverlay) === undefined) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production requires a trusted owner overlay reader");
    }
  }
  const selectedOverlay = configuredProduction
    ? configuredOverlay
    : input.overlay ?? input.deletionOverlay ?? input.suppressionOverlay ?? configuredOverlay;
  return {
    userId: input.userId.trim(),
    batchId: input.batchId.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
    window,
    ...(cursor === undefined ? {} : { cursor }),
    ...(pinnedWatermark === undefined ? {} : { pinnedWatermark }),
    limit,
    modelConfidenceThresholdPpm: threshold,
    environment,
    ...(selectedOverlay === undefined ? {} : { overlay: selectedOverlay }),
    productionReceipts: receipts,
  };
}

function withinWindow(value: string, window: CanonicalUtcWindow): boolean {
  const instant = assertCanonicalUtcInstant(value);
  return compareCanonicalUtcInstants(instant, window.from) >= 0 &&
    compareCanonicalUtcInstants(instant, window.to) < 0;
}

function copyRefs(values: readonly CanonicalObjectVersionRef[]): readonly CanonicalObjectVersionRef[] {
  const refs = values.map(cloneRef);
  const keys = refs.map(canonicalRefKey);
  if (new Set(keys).size !== keys.length) throw new TypeError("references must be unique");
  return Object.freeze(refs.sort(compareCanonicalObjectVersionRefs));
}

function normalizePage(
  page: AcceptedDreamDeltaPage,
  input: NormalizedRunInput,
): NormalizedPage {
  if (!isRecord(page) || !Array.isArray(page.records) || !("authorityWatermark" in page)) {
    throw new DreamRunError("READER_CONTRACT_VIOLATION", "reader must return records and authorityWatermark");
  }
  const authorityWatermark = stableOpaqueWatermark(page.authorityWatermark, "authorityWatermark");
  if (input.pinnedWatermark !== undefined && !sameOpaqueValue(input.pinnedWatermark, authorityWatermark)) {
    throw new DreamRunError("READER_CONTRACT_VIOLATION", "page watermark differs from pinnedWatermark");
  }
  let nextCursor: AcceptedDreamDeltaCursor | undefined;
  if (page.nextCursor !== undefined) {
    try {
      nextCursor = assertCursor(page.nextCursor, "nextCursor");
    } catch (error) {
      if (error instanceof DreamRunError) {
        throw new DreamRunError("READER_CONTRACT_VIOLATION", error.message, error);
      }
      throw error;
    }
    if (!sameOpaqueValue(nextCursor.authorityWatermark, authorityWatermark)) {
      throw new DreamRunError("READER_CONTRACT_VIOLATION", "nextCursor is not bound to the page watermark");
    }
  }
  if (input.cursor !== undefined && !sameOpaqueValue(input.cursor.authorityWatermark, authorityWatermark)) {
    throw new DreamRunError("READER_CONTRACT_VIOLATION", "input cursor is not bound to the page watermark");
  }

  const records: AcceptedDreamDeltaRecord[] = [];
  const acceptedDeltaRefs: CanonicalObjectVersionRef[] = [];
  const acceptedEvidenceRefs: CanonicalObjectVersionRef[] = [];
  const seen = new Set<string>();
  for (const raw of page.records) {
    if (!isRecord(raw) || raw.accepted !== true || raw.userId !== input.userId) {
      throw new DreamRunError("READER_CONTRACT_VIOLATION", "reader returned an unaccepted or foreign-user delta");
    }
    let ref: CanonicalObjectVersionRef;
    let sourceRefs: readonly CanonicalObjectVersionRef[];
    let delta: ReadonlyJsonValue;
    try {
      ref = cloneRef(raw.ref);
      sourceRefs = copyRefs(raw.sourceRefs as readonly CanonicalObjectVersionRef[]);
      assertCanonicalUtcInstant(raw.acceptedAt, "acceptedAt");
      delta = cloneJsonValue(raw.delta);
      if (!withinWindow(raw.acceptedAt as string, input.window)) {
        throw new TypeError("acceptedAt is outside the half-open window");
      }
    } catch (error) {
      if (error instanceof DreamRunError) throw error;
      throw new DreamRunError("READER_CONTRACT_VIOLATION", "reader returned an invalid accepted-delta record", error);
    }
    const key = canonicalRefKey(ref);
    if (seen.has(key)) throw new DreamRunError("READER_CONTRACT_VIOLATION", "reader returned duplicate delta refs");
    seen.add(key);
    const record = Object.freeze({
      ref,
      userId: input.userId,
      accepted: true as const,
      delta,
      sourceRefs,
      acceptedAt: raw.acceptedAt as AcceptedDreamDeltaRecord["acceptedAt"],
      ...(raw.deleted === true ? { deleted: true } : {}),
      ...(raw.suppressed === true ? { suppressed: true } : {}),
    });
    records.push(record as AcceptedDreamDeltaRecord);
    acceptedDeltaRefs.push(ref);
    acceptedEvidenceRefs.push(ref, ...sourceRefs);
  }
  return {
    records: Object.freeze(records),
    acceptedDeltaRefs: Object.freeze(acceptedDeltaRefs.sort(compareCanonicalObjectVersionRefs)),
    acceptedEvidenceRefs: Object.freeze([...new Map(acceptedEvidenceRefs.map((ref) => [canonicalRefKey(ref), ref])).values()].sort(compareCanonicalObjectVersionRefs)),
    excludedDeltaRefs: Object.freeze([]),
    authorityWatermark,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function overlayRefs(value: unknown, field: string): Set<string> {
  if (value === undefined) return new Set<string>();
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", `${field} must be an array or set`);
  }
  const result = new Set<string>();
  for (const item of value as Iterable<unknown>) {
    try {
      result.add(canonicalRefKey(cloneRef(item)));
    } catch (error) {
      throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", `${field} contains an invalid reference`, error);
    }
  }
  return result;
}

function productionOverlayRefs(
  value: unknown,
  field: string,
): readonly CanonicalObjectVersionRef[] {
  if (!Array.isArray(value)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", `production overlay ${field} must be an array`);
  }
  const refs = value.map((item) => {
    try {
      return cloneRef(item);
    } catch (error) {
      throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", `${field} contains an invalid reference`, error);
    }
  });
  const keys = refs.map(canonicalRefKey);
  if (new Set(keys).size !== keys.length) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", `${field} contains duplicate canonical references`);
  }
  return Object.freeze(refs.sort(compareCanonicalObjectVersionRefs));
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) return false;
    return names.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined &&
        Object.prototype.hasOwnProperty.call(descriptor, "value") &&
        descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function normalizeProductionOverlaySnapshot(
  value: unknown,
  expectedWatermark: AuthorityWatermark,
): DreamSuppressionOverlay {
  if (!isPlainDataRecord(value)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay must be a plain data projection");
  }
  const allowedKeys = new Set([
    "kind",
    "authorityWatermark",
    "deletedRefs",
    "suppressedRefs",
    "blockedRefs",
    "deleted",
    "suppressed",
  ]);
  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !allowedKeys.has(key)) || !hasOwn(value, "authorityWatermark")) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay projection keys are not closed");
  }
  if (hasOwn(value, "kind") && value.kind !== "dream_suppression_overlay_snapshot") {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay projection kind is invalid");
  }
  const deletionFields = ["deletedRefs", "suppressedRefs", "blockedRefs", "deleted", "suppressed"] as const;
  if (!deletionFields.some((field) => hasOwn(value, field))) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay must explicitly report deletion/suppression sets");
  }
  if (hasOwn(value, "deletedRefs") && hasOwn(value, "deleted")) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay cannot mix deletedRefs and deleted aliases");
  }
  if (hasOwn(value, "suppressedRefs") && hasOwn(value, "suppressed")) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay cannot mix suppressedRefs and suppressed aliases");
  }
  const snapshotWatermark = stableOpaqueWatermark(value.authorityWatermark, "overlay.authorityWatermark");
  if (!sameOpaqueValue(snapshotWatermark, expectedWatermark)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "production overlay watermark does not match the accepted-delta page");
  }
  const normalized: Record<string, unknown> = {};
  if (hasOwn(value, "kind")) normalized.kind = value.kind;
  normalized.authorityWatermark = snapshotWatermark;
  for (const field of deletionFields) {
    if (!hasOwn(value, field)) continue;
    // Validate, sort, and clone every owner reference; an empty array is a
    // valid explicit "checked and clear" result.
    normalized[field] = productionOverlayRefs(value[field], `overlay.${field}`);
  }
  return Object.freeze(normalized as DreamSuppressionOverlay);
}

async function applyOverlay(
  page: NormalizedPage,
  overlay: DreamSuppressionOverlay | DreamSuppressionOverlayReader | undefined,
): Promise<NormalizedPage> {
  // Reader overlays are resolved by DreamRunService with the real user and
  // window before this function is called; this helper consumes only the
  // resulting read-only projection.
  const projection = overlay as DreamSuppressionOverlay | undefined;
  if (projection !== undefined && !isRecord(projection)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "overlay must be a record");
  }
  const blocked = projection === undefined
    ? new Set<string>()
    : new Set<string>([
        ...overlayRefs(projection.deletedRefs ?? projection.deleted, "deletedRefs"),
        ...overlayRefs(projection.suppressedRefs ?? projection.suppressed, "suppressedRefs"),
        ...overlayRefs(projection.blockedRefs, "blockedRefs"),
      ]);
  const isDeleted = projection !== undefined && typeof projection.isDeleted === "function" ? projection.isDeleted : undefined;
  const isSuppressed = projection !== undefined && typeof projection.isSuppressed === "function" ? projection.isSuppressed : undefined;
  const kept: AcceptedDreamDeltaRecord[] = [];
  const excluded: CanonicalObjectVersionRef[] = [...page.excludedDeltaRefs];
  for (const record of page.records) {
    let blockedRecord = blocked.has(canonicalRefKey(record.ref)) ||
      record.sourceRefs.some((ref) => blocked.has(canonicalRefKey(ref)));
    try {
      if (!blockedRecord && isDeleted !== undefined) {
        blockedRecord = await isDeleted(record.ref);
      }
      if (!blockedRecord && isSuppressed !== undefined) {
        blockedRecord = await isSuppressed(record.ref);
      }
    } catch (error) {
      throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "overlay decision failed", error);
    }
    const raw = record as unknown as Record<string, unknown>;
    if (raw.deleted === true || raw.suppressed === true) blockedRecord = true;
    if (blockedRecord) excluded.push(record.ref);
    else kept.push(record);
  }
  const acceptedDeltaRefs = kept.map((record) => record.ref).sort(compareCanonicalObjectVersionRefs);
  const acceptedEvidenceRefs = [...new Map(kept.flatMap((record) => [record.ref, ...record.sourceRefs]).map((ref) => [canonicalRefKey(ref), ref])).values()].sort(compareCanonicalObjectVersionRefs);
  return {
    ...page,
    records: Object.freeze(kept),
    acceptedDeltaRefs: Object.freeze(acceptedDeltaRefs),
    acceptedEvidenceRefs: Object.freeze(acceptedEvidenceRefs),
    excludedDeltaRefs: Object.freeze(excluded.sort(compareCanonicalObjectVersionRefs)),
  };
}

function overlayReaderMethod(
  value: DreamSuppressionOverlay | DreamSuppressionOverlayReader | ProductionDreamSuppressionOverlayReader | undefined,
): ((input: {
  readonly userId: string;
  readonly window: CanonicalUtcWindow;
  readonly authorityWatermark: AuthorityWatermark;
}) => Promise<DreamSuppressionOverlay | DreamSuppressionOverlaySnapshot | undefined>) | undefined {
  if (value === undefined) return undefined;
  const candidate = value as DreamSuppressionOverlayReader;
  if (typeof candidate.readDreamOverlay === "function") return candidate.readDreamOverlay.bind(value);
  if (typeof candidate.readOverlay === "function") return candidate.readOverlay.bind(value);
  if (typeof candidate.readSuppressionOverlay === "function") return candidate.readSuppressionOverlay.bind(value);
  return undefined;
}

function proposalInstant(proposal: DreamExtractorProposal): string | undefined {
  if (proposal.occurredAt === undefined) return proposal.validity?.observedAt;
  if (proposal.occurredAt instanceof Date) {
    return Number.isFinite(proposal.occurredAt.getTime()) ? proposal.occurredAt.toISOString() : undefined;
  }
  return proposal.occurredAt;
}

function proposalWithinWindow(proposal: DreamExtractorProposal, window: CanonicalUtcWindow): boolean {
  const observed = proposalInstant(proposal);
  if (observed !== undefined && !withinWindow(observed, window)) return false;
  const from = proposal.validity?.validFrom;
  const to = proposal.validity?.validTo;
  if (from !== undefined && (!withinWindow(from, { from: window.from, to: window.to }) && compareCanonicalUtcInstants(assertCanonicalUtcInstant(from), window.to) >= 0)) return false;
  if (to !== undefined && compareCanonicalUtcInstants(assertCanonicalUtcInstant(to), window.from) <= 0) return false;
  return true;
}

function proposalDisposition(value: unknown, reasonCode: string, reason: string): DreamDisposition {
  return {
    proposalId: isRecord(value) && typeof value.proposalId === "string" ? value.proposalId : "<invalid-proposal>",
    status: "reject",
    kind: "reject",
    reasonCode,
    reason,
  };
}

function validateProposals(
  proposals: readonly DreamExtractorProposal[],
  input: NormalizedRunInput,
): { readonly accepted: readonly DreamExtractorProposal[]; readonly rejected: readonly DreamDisposition[] } {
  const accepted: DreamExtractorProposal[] = [];
  const rejected: DreamDisposition[] = [];
  for (const proposal of proposals) {
    if (!isRecord(proposal) || proposal.userId !== input.userId) {
      rejected.push(proposalDisposition(proposal, "FOREIGN_USER_PROPOSAL", "proposal user does not match the run user"));
      continue;
    }
    try {
      if (!proposalWithinWindow(proposal, input.window)) {
        rejected.push(proposalDisposition(proposal, "OUT_OF_WINDOW", "proposal is outside the UTC half-open window"));
        continue;
      }
    } catch (error) {
      rejected.push(proposalDisposition(proposal, "INVALID_PROPOSAL_TIME", "proposal time is not a canonical UTC instant"));
      continue;
    }
    accepted.push(proposal);
  }
  return { accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) };
}

function fingerprint(input: {
  readonly normalized: NormalizedRunInput;
  readonly page: NormalizedPage;
  readonly proposals: readonly DreamExtractorProposal[];
}): Sha256 {
  try {
    const payload = {
      schema: "t05.daily-dream.run.v1",
      userId: input.normalized.userId,
      batchId: input.normalized.batchId,
      idempotencyKey: input.normalized.idempotencyKey,
      timeZone: input.normalized.window.timeZone,
      localDate: input.normalized.window.localDate,
      window: { from: input.normalized.window.from, to: input.normalized.window.to },
      authorityWatermark: input.page.authorityWatermark,
      acceptedDeltaRefs: input.page.acceptedDeltaRefs.map(canonicalRefKey),
      excludedDeltaRefs: input.page.excludedDeltaRefs.map(canonicalRefKey),
      modelConfidenceThresholdPpm: input.normalized.modelConfidenceThresholdPpm,
      proposals: input.proposals,
    };
    return assertSha256(createHash("sha256").update(stableSerialize(payload), "utf8").digest("hex"));
  } catch (error) {
    throw new DreamRunError("FINGERPRINT_FAILED", "Dream run fingerprint could not be created", error);
  }
}

function readReceipt(input: {
  readonly normalized: NormalizedRunInput;
  readonly page: NormalizedPage;
}): DreamRunReadReceipt {
  return Object.freeze({
    kind: "dream_run_read_receipt",
    userId: input.normalized.userId,
    timeZone: input.normalized.window.timeZone,
    localDate: input.normalized.window.localDate,
    window: input.normalized.window,
    acceptedDeltaRefs: Object.freeze(input.page.acceptedDeltaRefs.map(cloneRef)),
    excludedDeltaRefs: Object.freeze(input.page.excludedDeltaRefs.map(cloneRef)),
    authorityWatermark: input.page.authorityWatermark,
    ...(input.page.nextCursor === undefined ? {} : { nextCursor: input.page.nextCursor }),
  });
}

function validateProductionReceipts(
  input: NormalizedRunInput,
  candidates: DreamCandidateBatch["candidates"],
): readonly ProductionMemoryIssuerReceipt[] {
  const receipts = input.productionReceipts;
  if (input.environment !== "production") {
    if (receipts.length > 0) {
      throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "production receipts cannot be mixed into a source run");
    }
    return Object.freeze([]);
  }
  if (candidates.length === 0) {
    if (receipts.length > 0) throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "a receipt cannot be supplied without a candidate");
    return Object.freeze([]);
  }
  if (receipts.length !== candidates.length) {
    throw new DreamRunError("PRODUCTION_RECEIPT_REQUIRED", "production requires exactly one private receipt per candidate");
  }
  const validated: ProductionMemoryIssuerReceipt[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const supplied = receipts[index];
    try {
      const receipt = assertProductionMemoryIssuerReceipt(supplied);
      if (receipt.operation !== "candidate_create" || receipt.candidateRef === undefined ||
          !issuerReceiptMatchesCandidate(receipt, candidate)) {
        throw new TypeError("receipt does not bind the candidate intent");
      }
      validated.push(receipt);
    } catch (error) {
      throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "raw, fixture, forged, or mixed production receipt rejected", error);
    }
  }
  const refs = validated.map((receipt) => canonicalRefKey(receipt.candidateRef!));
  if (new Set(refs).size !== refs.length) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "production receipts must have distinct candidate identities");
  }
  return Object.freeze(validated);
}

function isMemoryCommitResult(value: unknown): value is MemoryCommandResult<MemoryCommitReceipt> {
  return isRecord(value) && (value.ok === true || value.ok === false);
}

function validateCommitResult(
  value: unknown,
  input: NormalizedRunInput,
  fingerprintValue: Sha256,
  candidates: DreamCandidateBatch["candidates"],
  productionReceipts: readonly ProductionMemoryIssuerReceipt[],
): MemoryCommandResult<MemoryCommitReceipt> {
  if (!isMemoryCommitResult(value)) {
    return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
  }
  if (value.ok === false) return value;
  try {
    const receipt = value.receipt;
    if (!isRecord(receipt) || receipt.kind !== "memory_commit_receipt" ||
        receipt.operation !== "candidate_batch" || receipt.idempotencyKey !== input.idempotencyKey ||
        receipt.outcome !== "committed" && receipt.outcome !== "replayed" ||
        assertSha256(receipt.fingerprint) !== fingerprintValue ||
        !Array.isArray(receipt.canonicalRefs) || receipt.canonicalRefs.length !== candidates.length ||
        !Array.isArray(receipt.supersededRefs) || receipt.supersededRefs.length !== 0) {
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
    const canonicalRefs = receipt.canonicalRefs.map((value) => cloneRef(value));
    if (canonicalRefs.some((ref) => ref.refType !== "MemoryCandidate") ||
        new Set(canonicalRefs.map(canonicalRefKey)).size !== canonicalRefs.length) {
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
    if (productionReceipts.length > 0 &&
        (productionReceipts.length !== 1 || canonicalRefKey(canonicalRefs[0]!) !== canonicalRefKey(productionReceipts[0]!.candidateRef!))) {
      return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
    }
    return {
      ok: true,
      receipt: Object.freeze({
        kind: "memory_commit_receipt",
        operation: "candidate_batch",
        outcome: receipt.outcome,
        idempotencyKey: input.idempotencyKey,
        fingerprint: fingerprintValue,
        canonicalRefs: Object.freeze(canonicalRefs),
        supersededRefs: Object.freeze([]),
        authorityWatermark: stableOpaqueWatermark(receipt.authorityWatermark, "commitReceipt.authorityWatermark"),
      }),
    };
  } catch {
    return { ok: false, error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true } };
  }
}

/**
 * Source-only daily Dream composition.  It reads owner-accepted deltas,
 * applies deletion/suppression overlays, and emits review-invisible candidate
 * intents.  No scheduler, runtime, current-memory query, reminder, tool, or
 * other effect is part of this seam.
 */
export class DreamRunService {
  readonly #reader: AcceptedDreamDeltaReader;
  readonly #extractor: DreamApplicationExtractor;
  readonly #commandRepository: MemoryCommandRepository | undefined;
  readonly #committer: DreamCandidateBatchCommitter | undefined;
  readonly #options: DreamRunServiceOptions;
  readonly #production: boolean;

  constructor(options: DreamRunServiceOptions, productionToken?: object) {
    const reader = options?.reader ?? options?.acceptedDeltaReader;
    const extractor = options?.extractor ?? options?.candidateExtractor;
    if (!options || typeof options !== "object" ||
        typeof reader?.readAcceptedDreamDeltas !== "function" ||
        typeof extractor?.extract !== "function") {
      throw new DreamRunError("INVALID_REQUEST", "Dream run reader and extractor are required");
    }
    const requestedProduction = options.environment === "production" || options.production === true;
    const hasConfiguredProductionReceipt = options.productionReceipt !== undefined || options.issuerReceipt !== undefined ||
      options.productionReceipts !== undefined || options.issuerReceipts !== undefined;
    if (!requestedProduction && hasConfiguredProductionReceipt) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production receipts require createProductionDreamRunService");
    }
    if (requestedProduction && productionToken !== PRODUCTION_DREAM_RUN_TOKEN) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production runs require createProductionDreamRunService");
    }
    if (productionToken === PRODUCTION_DREAM_RUN_TOKEN && !requestedProduction) {
      throw new DreamRunError("INVALID_REQUEST", "production factory configuration is incomplete");
    }
    if (options.commandRepository !== undefined && typeof options.commandRepository.withTransaction !== "function") {
      throw new DreamRunError("INVALID_REQUEST", "commandRepository is invalid");
    }
    this.#reader = reader;
    this.#extractor = extractor;
    this.#commandRepository = options.commandRepository;
    this.#committer = options.committer;
    this.#options = options;
    this.#production = requestedProduction;
  }

  async run(input: DreamRunInput): Promise<DreamRunResult> {
    const normalized = normalizeInput(input, this.#options);
    let rawPage: AcceptedDreamDeltaPage;
    try {
      rawPage = await this.#reader.readAcceptedDreamDeltas({
        userId: normalized.userId,
        window: normalized.window,
        limit: normalized.limit,
        ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
        ...(normalized.pinnedWatermark === undefined ? {} : { pinnedWatermark: normalized.pinnedWatermark }),
      });
    } catch (error) {
      if (error instanceof DreamRunError) throw error;
      throw new DreamRunError("READER_FAILED", "accepted Dream delta read failed", error);
    }
    let page = normalizePage(rawPage, normalized);
    const readOverlay = overlayReaderMethod(normalized.overlay);
    if (readOverlay !== undefined) {
      try {
        const overlay = await readOverlay({
          userId: normalized.userId,
          window: normalized.window,
          authorityWatermark: page.authorityWatermark,
        });
        page = await applyOverlay(
          page,
          normalized.environment === "production"
            ? normalizeProductionOverlaySnapshot(overlay, page.authorityWatermark)
            : overlay,
        );
      } catch (error) {
        if (error instanceof DreamRunError) throw error;
        throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "overlay reader failed", error);
      }
    } else {
      page = await applyOverlay(page, normalized.overlay);
    }

    let extracted: readonly DreamExtractorProposal[] = [];
    if (page.records.length > 0) {
      const deltas: readonly DreamExtractorDelta[] = Object.freeze(page.records.map((record) => Object.freeze({
        ref: record.ref,
        delta: record.delta,
        sourceRefs: record.sourceRefs,
        acceptedAt: record.acceptedAt,
      })));
      const extractorInput: DreamExtractorInput = {
        userId: normalized.userId,
        window: normalized.window,
        deltas,
      };
      try {
        const result = await this.#extractor.extract(extractorInput);
        if (!Array.isArray(result)) throw new DreamRunError("EXTRACTOR_CONTRACT_VIOLATION", "extractor must return an array");
        extracted = result;
      } catch (error) {
        if (error instanceof DreamRunError) throw error;
        throw new DreamRunError("EXTRACTOR_FAILED", "Dream extractor failed", error);
      }
    }

    const boundary = validateProposals(extracted, normalized);
    let batch: DreamCandidateBatch;
    try {
      const built = buildDreamCandidateBatch({
        window: normalized.window,
        batchId: normalized.batchId,
        idempotencyKey: normalized.idempotencyKey,
        acceptedDeltaRefs: page.acceptedEvidenceRefs,
        proposals: boundary.accepted,
        modelConfidenceThresholdPpm: normalized.modelConfidenceThresholdPpm,
      });
      batch = Object.freeze({
        ...built,
        rejected: Object.freeze([...built.rejected, ...boundary.rejected]),
      });
    } catch (error) {
      throw new DreamRunError("EXTRACTOR_CONTRACT_VIOLATION", "candidate intent admission failed", error);
    }
    const runFingerprint = fingerprint({ normalized, page, proposals: extracted });
    const productionReceipts = validateProductionReceipts(normalized, batch.candidates);
    const receipt = readReceipt({ normalized, page });

    let outcome: DreamRunResult["outcome"] = batch.candidates.length === 0 ? "no_candidates" : "candidate_intents";
    let commitReceipt: MemoryCommitReceipt | undefined;
    let error: MemoryCommandError | undefined;
    if (batch.candidates.length > 0 && this.#committer !== undefined) {
      try {
        const result = await this.#committer.commitCandidateBatch({
          batchId: normalized.batchId,
          idempotencyKey: normalized.idempotencyKey,
          fingerprint: runFingerprint,
          candidates: batch.candidates,
          ...(productionReceipts.length === 0 ? {} : { productionReceipts }),
        });
        const validated = validateCommitResult(result, normalized, runFingerprint, batch.candidates, productionReceipts);
        if (validated.ok) {
          outcome = validated.receipt.outcome;
          commitReceipt = validated.receipt;
        } else {
          outcome = "commit_rejected";
          error = validated.error;
        }
      } catch (commitError) {
        if (commitError instanceof DreamRunError) throw commitError;
        throw new DreamRunError("COMMIT_FAILED", "candidate commit failed", commitError);
      }
    } else if (batch.candidates.length > 0 && this.#commandRepository !== undefined) {
      if (normalized.environment === "production" && productionReceipts.length !== 1) {
        throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "the legacy batch repository cannot consume mixed receipts");
      }
      const command: MemoryCandidateBatchCommitCommand = {
        batchId: normalized.batchId,
        idempotencyKey: normalized.idempotencyKey,
        fingerprint: runFingerprint,
        candidates: batch.candidates,
        ...(productionReceipts.length === 1 ? { issuerReceipt: productionReceipts[0] } : {}),
      };
      try {
        const result = await this.#commandRepository.withTransaction((transaction) =>
          transaction.commitCandidateBatch(command));
        const validated = validateCommitResult(result, normalized, runFingerprint, batch.candidates, productionReceipts);
        if (validated.ok) {
          outcome = validated.receipt.outcome;
          commitReceipt = validated.receipt;
        } else {
          outcome = "commit_rejected";
          error = validated.error;
        }
      } catch (commitError) {
        if (commitError instanceof DreamRunError) throw commitError;
        throw new DreamRunError("COMMIT_FAILED", "candidate commit failed", commitError);
      }
    }

    const result: DreamRunResult = {
      kind: "daily_dream_run",
      outcome,
      userId: normalized.userId,
      batchId: normalized.batchId,
      idempotencyKey: normalized.idempotencyKey,
      timeZone: normalized.window.timeZone,
      localDate: normalized.window.localDate,
      window: normalized.window,
      fingerprint: runFingerprint,
      pinnedWatermark: page.authorityWatermark,
      readReceipt: receipt,
      candidates: batch.candidates,
      batch,
      ...(productionReceipts.length === 0 ? {} : { productionReceipts }),
      ...(productionReceipts.length === 1 ? { productionReceipt: productionReceipts[0] } : {}),
      ...(commitReceipt === undefined ? {} : { commitReceipt }),
      ...(error === undefined ? {} : { error }),
    };
    return Object.freeze(result);
  }

  runPage(input: DreamRunInput): Promise<DreamRunResult> {
    return this.run(input);
  }
}

export type ProductionDreamRunServiceOptions = Omit<
  DreamRunServiceOptions,
  "environment" | "production" | "overlay" | "deletionOverlay" | "suppressionOverlay" |
  "trustedOverlayReader" | "ownerOverlayReader"
> & {
  /** Owner-controlled overlay reader; caller input cannot replace it. */
  readonly trustedOverlayReader: ProductionDreamSuppressionOverlayReader;
};

/**
 * Production-only entry point. Its environment and overlay are fixed at
 * construction, and caller input cannot downgrade either boundary.
 */
export class ProductionDreamRunService {
  readonly #delegate: DreamRunService;

  constructor(options: ProductionDreamRunServiceOptions) {
    if (!options || typeof options !== "object") {
      throw new DreamRunError("INVALID_REQUEST", "production Dream run options are required");
    }
    const forbiddenOptionKeys = ["environment", "production", "overlay", "deletionOverlay", "suppressionOverlay"];
    if (forbiddenOptionKeys.some((key) => hasOwn(options, key))) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production options cannot carry caller-selectable environment or overlay aliases");
    }
    const trustedOverlayReader = options.trustedOverlayReader;
    if (overlayReaderMethod(trustedOverlayReader) === undefined) {
      throw new DreamRunError("INVALID_REQUEST", "a trusted owner overlay reader is required");
    }
    this.#delegate = new DreamRunService({
      ...options,
      environment: "production",
      production: true,
      overlay: trustedOverlayReader,
      trustedOverlayReader,
    }, PRODUCTION_DREAM_RUN_TOKEN);
  }

  async run(input: DreamRunInput): Promise<DreamRunResult> {
    if (!isRecord(input)) throw new DreamRunError("INVALID_REQUEST", "Dream run input must be an object");
    const forbiddenInputKeys = ["environment", "production", "overlay", "deletionOverlay", "suppressionOverlay"];
    if (forbiddenInputKeys.some((key) => hasOwn(input, key))) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production input cannot carry environment or overlay aliases");
    }
    const {
      environment: _environment,
      production: _production,
      overlay: _overlay,
      deletionOverlay: _deletionOverlay,
      suppressionOverlay: _suppressionOverlay,
      ...safeInput
    } = input as unknown as Record<string, unknown>;
    return this.#delegate.run(safeInput as unknown as DreamRunInput);
  }

  runPage(input: DreamRunInput): Promise<DreamRunResult> {
    return this.run(input);
  }
}

interface NormalizedDurableRunInput extends NormalizedRunInput {
  readonly pinnedWatermark: AuthorityWatermark;
  readonly pageIdempotencyKey: string;
  readonly environment: "production";
  readonly dreamRunIdReceipt?: ProductionDreamRunIdReceipt;
}

function normalizeDurableInput(
  input: DurableProductionDreamRunInput,
  requireCheckpointEvent = true,
): NormalizedDurableRunInput {
  if (!isRecord(input)) throw new DreamRunError("INVALID_REQUEST", "durable Dream input must be an object");
  const forbiddenInputKeys = ["environment", "production", "overlay", "deletionOverlay", "suppressionOverlay"];
  if (forbiddenInputKeys.some((key) => hasOwn(input, key))) {
    throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "durable production input cannot carry legacy environment or overlay aliases");
  }
  if (!isNonEmptyString(input.pageIdempotencyKey)) {
    throw new DreamRunError("INVALID_REQUEST", "pageIdempotencyKey is required");
  }
  const suppliedRunReceipts = [
    ["dreamRunIdReceipt", input.dreamRunIdReceipt],
    ["runIdReceipt", input.runIdReceipt],
    ["productionDreamRunIdReceipt", input.productionDreamRunIdReceipt],
  ] as const;
  const suppliedRunReceiptValues = suppliedRunReceipts.filter((entry) => entry[1] !== undefined);
  let dreamRunIdReceipt: ProductionDreamRunIdReceipt | undefined;
  if (suppliedRunReceiptValues.length > 0) {
    try {
      dreamRunIdReceipt = assertProductionDreamRunIdReceipt(suppliedRunReceiptValues[0]![1]);
      for (const [name, value] of suppliedRunReceiptValues.slice(1)) {
        const candidate = assertProductionDreamRunIdReceipt(value);
        if (candidate !== dreamRunIdReceipt) {
          throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", `${name} is not the same private Dream run receipt`);
        }
      }
    } catch (error) {
      if (error instanceof DreamRunError) throw error;
      throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "Dream run id receipt is raw, forged, or malformed", error);
    }
  }
  if (requireCheckpointEvent && dreamRunIdReceipt === undefined) {
    throw new DreamRunError(
      "PRODUCTION_RECEIPT_REQUIRED",
      "production durable pages require the same private Dream run id receipt on every page and replay",
    );
  }
  if (!hasOwn(input, "pinnedWatermark")) {
    throw new DreamRunError("INVALID_REQUEST", "durable production pages require a persisted pinnedWatermark");
  }
  if (input.productionReceipt !== undefined && input.issuerReceipt !== undefined &&
      input.productionReceipt !== input.issuerReceipt) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipt and issuerReceipt disagree");
  }
  if (input.productionReceipts !== undefined && input.issuerReceipts !== undefined &&
      input.productionReceipts !== input.issuerReceipts) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipts and issuerReceipts disagree");
  }
  const one = input.productionReceipt ?? input.issuerReceipt;
  const many = input.productionReceipts ?? input.issuerReceipts;
  if (one !== undefined && many !== undefined) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "singular and plural production receipts cannot be mixed");
  }
  if (many !== undefined && !Array.isArray(many)) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "productionReceipts must be an array");
  }
  const {
    productionReceipt: _productionReceipt,
    issuerReceipt: _issuerReceipt,
    productionReceipts: _productionReceipts,
    issuerReceipts: _issuerReceipts,
    ...sourceInput
  } = input;
  const normalized = normalizeInput(sourceInput as DreamRunInput, {});
  if (normalized.pinnedWatermark === undefined) {
    throw new DreamRunError("INVALID_REQUEST", "durable production pages require a valid persisted pinnedWatermark");
  }
  return Object.freeze({
    ...normalized,
    pinnedWatermark: normalized.pinnedWatermark,
    pageIdempotencyKey: input.pageIdempotencyKey.trim(),
    environment: "production" as const,
    productionReceipts: Object.freeze([...(many ?? (one === undefined ? [] : [one]))]),
    ...(dreamRunIdReceipt === undefined ? {} : { dreamRunIdReceipt }),
  });
}

function exactDataKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainDataRecord(value)) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", `${label} must be a plain closed data record`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", `${label} keys are not an exact echo`);
  }
}

function normalizeDurableOwnerProjection(
  value: unknown,
  page: NormalizedPage,
  pinnedWatermark: AuthorityWatermark,
): DurableDreamOwnerOverlayProjection {
  if (!isPlainDataRecord(value)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "durable owner overlay must be a plain closed projection");
  }
  const required = ["kind", "authorityWatermark", "deletedRefs", "suppressedRefs", "blockedRefs"] as const;
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      value.kind !== "durable_dream_owner_overlay_projection") {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "durable owner overlay fields are incomplete or contain extras");
  }
  const authorityWatermark = stableOpaqueWatermark(value.authorityWatermark, "ownerProjection.authorityWatermark");
  if (!sameOpaqueValue(authorityWatermark, pinnedWatermark) ||
      !sameOpaqueValue(authorityWatermark, page.authorityWatermark)) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "durable owner overlay watermark drifted from the persisted pin");
  }
  const deletedRefs = productionOverlayRefs(value.deletedRefs, "ownerProjection.deletedRefs");
  const suppressedRefs = productionOverlayRefs(value.suppressedRefs, "ownerProjection.suppressedRefs");
  const blockedRefs = productionOverlayRefs(value.blockedRefs, "ownerProjection.blockedRefs");
  const projectionKeys = [...deletedRefs, ...suppressedRefs, ...blockedRefs].map(canonicalRefKey);
  if (new Set(projectionKeys).size !== projectionKeys.length) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "durable owner overlay contains duplicate decisions");
  }
  const pageEvidenceKeys = new Set(page.records.flatMap((record) =>
    [record.ref, ...record.sourceRefs].map(canonicalRefKey)));
  if (projectionKeys.some((key) => !pageEvidenceKeys.has(key))) {
    throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "durable owner overlay references evidence outside this page");
  }
  return Object.freeze({
    kind: "durable_dream_owner_overlay_projection" as const,
    authorityWatermark: pinnedWatermark,
    deletedRefs,
    suppressedRefs,
    blockedRefs,
  });
}

function durableHash(value: unknown, label: string): Sha256 {
  try {
    return assertSha256(createHash("sha256").update(stableSerialize(value), "utf8").digest("hex"));
  } catch (error) {
    throw new DreamRunError("FINGERPRINT_FAILED", `${label} could not be fingerprinted`, error);
  }
}

function durableReadReceipt(input: {
  readonly normalized: NormalizedDurableRunInput;
  readonly rawPage: NormalizedPage;
  readonly page: NormalizedPage;
}): DurableDreamRunReadReceipt {
  const pageRecordsFingerprint = durableHash({
    schema: "t05.daily-dream.page-records.v1",
    records: input.rawPage.records,
  }, "durable Dream page records");
  return Object.freeze({
    kind: "durable_dream_page_read_receipt" as const,
    userId: input.normalized.userId,
    timeZone: input.normalized.window.timeZone,
    localDate: input.normalized.window.localDate,
    window: input.normalized.window,
    pinnedWatermark: input.normalized.pinnedWatermark,
    ...(input.normalized.cursor === undefined ? {} : { inputCursor: input.normalized.cursor }),
    ...(input.rawPage.nextCursor === undefined ? {} : { nextCursor: input.rawPage.nextCursor }),
    pageDeltaRefs: Object.freeze(input.rawPage.acceptedDeltaRefs.map(cloneRef)),
    acceptedDeltaRefs: Object.freeze(input.page.acceptedDeltaRefs.map(cloneRef)),
    acceptedEvidenceRefs: Object.freeze(input.page.acceptedEvidenceRefs.map(cloneRef)),
    excludedDeltaRefs: Object.freeze(input.page.excludedDeltaRefs.map(cloneRef)),
    pageRecordCount: input.rawPage.records.length,
    pageRecordsFingerprint,
  });
}

function buildDurableCommand(input: {
  readonly normalized: NormalizedDurableRunInput;
  readonly page: NormalizedPage;
  readonly readReceipt: DurableDreamRunReadReceipt;
  readonly ownerProjection: DurableDreamOwnerOverlayProjection;
  readonly batch: DreamCandidateBatch;
  readonly productionReceipts: readonly ProductionMemoryIssuerReceipt[];
}): DurableDreamPageCommitCommand {
  const predecessor = Object.freeze({
    kind: "durable_dream_page_predecessor" as const,
    pinnedWatermark: input.normalized.pinnedWatermark,
    ...(input.normalized.cursor === undefined ? {} : { inputCursor: input.normalized.cursor }),
  });
  const state = Object.freeze({
    kind: "durable_dream_page_state" as const,
    pinnedWatermark: input.normalized.pinnedWatermark,
    complete: input.page.nextCursor === undefined,
    ...(input.page.nextCursor === undefined ? {} : { nextCursor: input.page.nextCursor }),
  });
  const predecessorFingerprint = durableHash({
    schema: "t05.daily-dream.page-predecessor.v1",
    predecessor,
  }, "durable Dream predecessor");
  const stateFingerprint = durableHash({
    schema: "t05.daily-dream.page-state.v1",
    state,
  }, "durable Dream state");
  const productionReceiptProjections = Object.freeze(input.productionReceipts.map((receipt) =>
    projectProductionMemoryIssuerReceipt(receipt)));
  const dreamRunIdProjection = input.normalized.dreamRunIdReceipt === undefined
    ? undefined
    : projectProductionDreamRunIdReceipt(input.normalized.dreamRunIdReceipt);
  const preimage = {
    schema: "t05.daily-dream.durable-page-command.v1" as const,
    userId: input.normalized.userId,
    timeZone: input.normalized.window.timeZone,
    localDate: input.normalized.window.localDate,
    window: input.normalized.window,
    batchId: input.normalized.batchId,
    batchIdempotencyKey: input.normalized.idempotencyKey,
    pageIdempotencyKey: input.normalized.pageIdempotencyKey,
    ...(input.normalized.dreamRunIdReceipt === undefined ? {} : {
      dreamRunId: input.normalized.dreamRunIdReceipt.dreamRunId,
      dreamRunIdProjection: dreamRunIdProjection!,
    }),
    pinnedWatermark: input.normalized.pinnedWatermark,
    ...(input.normalized.cursor === undefined ? {} : { inputCursor: input.normalized.cursor }),
    ...(input.page.nextCursor === undefined ? {} : { nextCursor: input.page.nextCursor }),
    readReceipt: input.readReceipt,
    ownerProjection: input.ownerProjection,
    batch: input.batch,
    candidates: input.batch.candidates,
    productionReceiptProjections,
    predecessor,
    predecessorFingerprint,
    state,
    stateFingerprint,
  };
  const fingerprintValue = durableHash(preimage, "durable Dream page command");
  return Object.freeze({
    kind: "durable_dream_page_commit_command" as const,
    ...preimage,
    productionReceipts: Object.freeze([...input.productionReceipts]),
    ...(input.normalized.dreamRunIdReceipt === undefined ? {} : {
      dreamRunIdReceipt: input.normalized.dreamRunIdReceipt,
    }),
    fingerprint: fingerprintValue,
  });
}

function checkpointState(receipt: ProductionDreamRunIdReceipt): DreamRunCheckpointState {
  const asserted = assertProductionDreamRunIdReceipt(receipt);
  const existing = DREAM_RUN_CHECKPOINT_STATES.get(asserted as unknown as object);
  if (existing !== undefined) return existing;
  const created: DreamRunCheckpointState = {
    uuidIssuer: createDreamUuidIssuer({ issuedIds: new Set([asserted.dreamRunId]) }),
    events: new Map(),
  };
  DREAM_RUN_CHECKPOINT_STATES.set(asserted as unknown as object, created);
  return created;
}

function bindDreamRunContext(input: NormalizedDurableRunInput): void {
  const receipt = input.dreamRunIdReceipt;
  if (receipt === undefined) return;
  const state = checkpointState(receipt);
  const context: DreamRunCheckpointContext = Object.freeze({
    userId: input.userId,
    batchId: input.batchId,
    localDate: input.window.localDate,
    timeZone: input.window.timeZone,
    windowFrom: input.window.from,
    windowTo: input.window.to,
  });
  if (state.boundContext !== undefined && stableSerialize(state.boundContext) !== stableSerialize(context)) {
    throw new DreamRunError("PRODUCTION_RECEIPT_INVALID", "Dream run receipt was reused with a different user/date/window/batch");
  }
  state.boundContext = state.boundContext ?? context;
}

function checkpointSourceRef(value: CanonicalObjectVersionRef): DreamPageCheckpointPayloadV1["candidate_refs"][number] {
  const ref = assertCanonicalObjectVersionRef(value);
  if (ref.refType !== "MemoryCandidate") throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "checkpoint candidate ref is not MemoryCandidate");
  return Object.freeze({
    ref_type: "MemoryCandidate" as const,
    ref_id: ref.refId,
    object_version: ref.objectVersion,
    canonical_payload_sha256: ref.canonicalPayloadSha256,
  });
}

function checkpointSourceCursor(value: AcceptedDreamDeltaCursor | undefined): DreamPageCheckpointCursorV1 | undefined {
  if (value === undefined) return undefined;
  return Object.freeze({
    token: value.token,
    authority_watermark: checkpointAuthorityWatermark(value.authorityWatermark, "cursor.authorityWatermark"),
  });
}

function checkpointPageFingerprint(command: DurableDreamPageCommitCommand): Sha256 {
  return durableHash({
    schema: "t05.daily-dream.page-checkpoint.v1",
    dreamRunId: command.dreamRunId,
    pageIdempotencyKey: command.pageIdempotencyKey,
    userId: command.userId,
    batchId: command.batchId,
    readReceipt: command.readReceipt,
    ownerProjection: command.ownerProjection,
    batch: command.batch,
  }, "Dream checkpoint page");
}

function checkpointPayloadForCommand(command: DurableDreamPageCommitCommand): DreamPageCheckpointPayloadV1 {
  if (command.dreamRunId === undefined || command.dreamRunIdReceipt === undefined) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "checkpoint event requires a private Dream run receipt");
  }
  assertUUIDv7(command.userId);
  const pinnedWatermark = checkpointAuthorityWatermark(command.pinnedWatermark, "pinnedWatermark");
  const refs = command.productionReceipts.map((receipt) => checkpointSourceRef(receipt.candidateRef!));
  refs.sort((left, right) => compareCanonicalObjectVersionRefs(
    { refType: left.ref_type, refId: left.ref_id, objectVersion: left.object_version, canonicalPayloadSha256: left.canonical_payload_sha256 },
    { refType: right.ref_type, refId: right.ref_id, objectVersion: right.object_version, canonicalPayloadSha256: right.canonical_payload_sha256 },
  ));
  const inputCursor = checkpointSourceCursor(command.inputCursor);
  const nextCursor = checkpointSourceCursor(command.nextCursor);
  const payload: DreamPageCheckpointPayloadV1 = {
    dream_run_id: assertUUIDv7(command.dreamRunId),
    user_id: assertUUIDv7(command.userId),
    local_date: command.localDate,
    time_zone: command.timeZone,
    window_from: command.window.from,
    window_to: command.window.to,
    pinned_watermark: pinnedWatermark,
    ...(inputCursor === undefined ? {} : { input_cursor: inputCursor }),
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    complete: command.nextCursor === undefined,
    page_idempotency_key: command.pageIdempotencyKey,
    page_fingerprint: checkpointPageFingerprint(command),
    command_fingerprint: command.fingerprint,
    predecessor_fingerprint: command.predecessorFingerprint,
    state_fingerprint: command.stateFingerprint,
    read_receipt_fingerprint: durableHash(command.readReceipt, "Dream checkpoint read receipt"),
    trusted_overlay_projection_fingerprint: durableHash(command.ownerProjection, "Dream checkpoint owner projection"),
    candidate_count: String(refs.length),
    candidate_refs: Object.freeze(refs),
  };
  try {
    return assertCheckpointPayload(payload);
  } catch (error) {
    if (error instanceof DreamRunError) throw error;
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "Dream checkpoint payload is not RFC-011 canonical", error);
  }
}

function attachCheckpointEvent(
  command: DurableDreamPageCommitCommand,
): { readonly command: DurableDreamPageCommitCommand; readonly event: ProductionDreamPageCheckpointEventReceipt; readonly projection: ProductionDreamPageCheckpointEventProjection } {
  const runReceipt = command.dreamRunIdReceipt;
  if (runReceipt === undefined) throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "checkpoint event requires a run receipt");
  assertProductionDreamRunIdReceipt(runReceipt);
  if (command.dreamRunId !== runReceipt.dreamRunId) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "checkpoint event run id drifted from receipt");
  }
  const payload = checkpointPayloadForCommand(command);
  const state = checkpointState(runReceipt);
  const key = `${runReceipt.dreamRunId}\u0000${command.pageIdempotencyKey}`;
  const prior = state.events.get(key);
  const eventId = prior === undefined ? state.uuidIssuer.issue().dreamRunId : prior.event.event_id;
  const event = createProductionDreamPageCheckpointEventReceipt({
    event: {
      event_id: eventId,
      aggregate_type: "memory_dream_run",
      aggregate_id: payload.dream_run_id,
      event_type: "memory.dream.page.checkpointed.v1",
      event_version: 1,
      idempotency_scope: "memory.outbox",
      idempotency_key: payload.page_idempotency_key,
      payload,
      payload_sha256: assertSha256(createHash("sha256").update(jcsSerialize(payload), "utf8").digest("hex")),
    },
  });
  if (prior !== undefined && prior.eventJcs !== event.eventJcs) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "same Dream run/page identity has changed checkpoint event bytes");
  }
  state.events.set(key, event);
  const projection = projectProductionDreamPageCheckpointEventReceipt(event);
  const attached = Object.freeze({
    ...command,
    checkpointEventReceipt: event,
    checkpointEventProjection: projection,
    checkpointEvent: projection,
  });
  return { command: attached, event, projection };
}

const DURABLE_COMMAND_KEYS = [
  "kind", "schema", "userId", "timeZone", "localDate", "window", "batchId",
  "batchIdempotencyKey", "pageIdempotencyKey", "dreamRunId", "dreamRunIdReceipt",
  "dreamRunIdProjection", "pinnedWatermark", "inputCursor",
  "nextCursor", "readReceipt", "ownerProjection", "batch", "candidates",
  "productionReceipts", "productionReceiptProjections", "predecessor",
  "predecessorFingerprint", "state", "stateFingerprint", "fingerprint",
  "checkpointEventReceipt", "checkpointEventProjection", "checkpointEvent",
] as const;

function durableCommandComparable(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command is malformed");
  }
  const optional = new Set([
    "inputCursor", "nextCursor", "dreamRunId", "dreamRunIdReceipt", "dreamRunIdProjection",
    "checkpointEventReceipt", "checkpointEventProjection", "checkpointEvent",
  ]);
  const required = DURABLE_COMMAND_KEYS.filter((key) => !optional.has(key));
  const allowed = new Set(DURABLE_COMMAND_KEYS);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key as typeof DURABLE_COMMAND_KEYS[number])) ||
      required.some((key) => !hasOwn(value, key))) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command keys are not closed");
  }
  if (!Array.isArray(value.candidates) || !Array.isArray(value.productionReceipts) ||
      !Array.isArray(value.productionReceiptProjections)) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command collections are malformed");
  }
  const hasRunId = hasOwn(value, "dreamRunId") || hasOwn(value, "dreamRunIdReceipt") || hasOwn(value, "dreamRunIdProjection");
  if (hasRunId) {
    if (!hasOwn(value, "dreamRunId") || !hasOwn(value, "dreamRunIdReceipt") || !hasOwn(value, "dreamRunIdProjection")) {
      throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable command has an incomplete Dream run identity");
    }
    const runReceipt = assertProductionDreamRunIdReceipt(value.dreamRunIdReceipt);
    if (runReceipt.dreamRunId !== value.dreamRunId) {
      throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable command Dream run id drifted from its receipt");
    }
    const expectedProjection = projectProductionDreamRunIdReceipt(runReceipt);
    if (stableSerialize(expectedProjection) !== stableSerialize(value.dreamRunIdProjection)) {
      throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable command Dream run projection drifted");
    }
  }
  const hasCheckpointEvent = hasOwn(value, "checkpointEventReceipt") || hasOwn(value, "checkpointEventProjection") || hasOwn(value, "checkpointEvent");
  if (hasCheckpointEvent) {
    if (!hasOwn(value, "checkpointEventReceipt") || !hasOwn(value, "checkpointEventProjection") || !hasOwn(value, "checkpointEvent")) {
      throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable command has an incomplete checkpoint event echo");
    }
    const eventReceipt = assertProductionDreamPageCheckpointEventReceipt(value.checkpointEventReceipt);
    const expectedProjection = projectProductionDreamPageCheckpointEventReceipt(eventReceipt);
    const explicitProjection = assertProductionDreamPageCheckpointEventProjection(value.checkpointEventProjection);
    const aliasProjection = assertProductionDreamPageCheckpointEventProjection(value.checkpointEvent);
    if (stableSerialize(expectedProjection) !== stableSerialize(explicitProjection) ||
        stableSerialize(expectedProjection) !== stableSerialize(aliasProjection)) {
      throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable command checkpoint event projections drifted");
    }
  }
  const candidates = value.candidates as DreamCandidateBatch["candidates"];
  const receipts = value.productionReceipts.map((receipt, index) => {
    try {
      const asserted = assertProductionMemoryIssuerReceipt(receipt);
      if (asserted.operation !== "candidate_create" || asserted.candidateRef === undefined ||
          candidates[index] === undefined || !issuerReceiptMatchesCandidate(asserted, candidates[index]!)) {
        throw new TypeError("receipt does not bind its candidate index");
      }
      return asserted;
    } catch (error) {
      throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command contains a forged or mixed issuer receipt", error);
    }
  });
  if (receipts.length !== candidates.length) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command has incomplete indexed issuer receipts");
  }
  const refs = receipts.map((receipt) => canonicalRefKey(receipt.candidateRef!));
  if (new Set(refs).size !== refs.length) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command repeats a candidate identity");
  }
  const projections = receipts.map((receipt) => projectProductionMemoryIssuerReceipt(receipt));
  if (stableSerialize(projections) !== stableSerialize(value.productionReceiptProjections)) {
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable receipt command issuer projections drifted");
  }
  const { productionReceipts: _receipts, ...rest } = value;
  return { ...rest, productionReceipts: projections };
}

function validateDurableCommitReceipt(
  value: unknown,
  command: DurableDreamPageCommitCommand,
): DurableDreamPageCommitReceipt {
  const receiptKeys = [
    "kind", "outcome", "pageIdempotencyKey", "command", "fingerprint", "predecessor",
    "predecessorFingerprint", "state", "stateFingerprint", "canonicalRefs",
    ...(command.dreamRunIdReceipt === undefined ? [] : [
      "dreamRunId", "dreamRunIdReceipt", "checkpointEventReceipt", "checkpointEventProjection", "checkpointEvent",
    ]),
  ] as readonly string[];
  exactDataKeys(value, receiptKeys, "durable page commit receipt");
  try {
    if (value.kind !== "durable_dream_page_commit_receipt" ||
        value.outcome !== "committed" && value.outcome !== "replayed" ||
        value.pageIdempotencyKey !== command.pageIdempotencyKey ||
        assertSha256(value.fingerprint) !== command.fingerprint ||
        assertSha256(value.predecessorFingerprint) !== command.predecessorFingerprint ||
        assertSha256(value.stateFingerprint) !== command.stateFingerprint ||
        stableSerialize(value.predecessor) !== stableSerialize(command.predecessor) ||
        stableSerialize(value.state) !== stableSerialize(command.state) ||
        stableSerialize(durableCommandComparable(value.command)) !== stableSerialize(durableCommandComparable(command)) ||
        !Array.isArray(value.canonicalRefs)) {
      throw new TypeError("receipt did not exactly echo the durable command");
    }
    if (command.dreamRunIdReceipt !== undefined) {
      if (!hasOwn(value, "dreamRunId") || !hasOwn(value, "dreamRunIdReceipt") ||
          value.dreamRunId !== command.dreamRunId || value.dreamRunIdReceipt !== command.dreamRunIdReceipt ||
          !hasOwn(value, "checkpointEventReceipt") || !hasOwn(value, "checkpointEventProjection") ||
          !hasOwn(value, "checkpointEvent") || !hasOwn(command, "checkpointEventReceipt") ||
          !hasOwn(command, "checkpointEventProjection") || !hasOwn(command, "checkpointEvent")) {
        throw new TypeError("checkpoint event receipt is missing");
      }
      const echoedReceipt = assertProductionDreamPageCheckpointEventReceipt(value.checkpointEventReceipt);
      const commandReceipt = assertProductionDreamPageCheckpointEventReceipt(command.checkpointEventReceipt);
      const echoedProjection = assertProductionDreamPageCheckpointEventProjection(value.checkpointEventProjection);
      const commandProjection = assertProductionDreamPageCheckpointEventProjection(command.checkpointEventProjection);
      const echoedAlias = assertProductionDreamPageCheckpointEventProjection(value.checkpointEvent);
      const commandAlias = assertProductionDreamPageCheckpointEventProjection(command.checkpointEvent);
      if (stableSerialize(echoedReceipt) !== stableSerialize(commandReceipt) ||
          stableSerialize(echoedProjection) !== stableSerialize(commandProjection) ||
          stableSerialize(echoedAlias) !== stableSerialize(commandAlias)) {
        throw new TypeError("checkpoint event receipt does not exactly echo the command event");
      }
    }
    const canonicalRefs = value.canonicalRefs.map(cloneRef);
    const expectedRefs = command.productionReceipts.map((receipt) => cloneRef(receipt.candidateRef));
    if (canonicalRefs.length !== expectedRefs.length || canonicalRefs.some((ref, index) =>
      canonicalRefKey(ref) !== canonicalRefKey(expectedRefs[index]!))) {
      throw new TypeError("receipt refs do not exactly match indexed issuer receipts");
    }
    return Object.freeze({
      kind: "durable_dream_page_commit_receipt" as const,
      outcome: value.outcome,
      pageIdempotencyKey: command.pageIdempotencyKey,
      command,
      fingerprint: command.fingerprint,
      predecessor: command.predecessor,
      predecessorFingerprint: command.predecessorFingerprint,
      state: command.state,
      stateFingerprint: command.stateFingerprint,
      canonicalRefs: Object.freeze(canonicalRefs),
      ...(command.dreamRunIdReceipt === undefined ? {} : {
        dreamRunId: command.dreamRunId,
        dreamRunIdReceipt: command.dreamRunIdReceipt,
      }),
      ...(command.dreamRunIdReceipt === undefined ? {} : {
        checkpointEvent: command.checkpointEvent,
        checkpointEventReceipt: command.checkpointEventReceipt,
        checkpointEventProjection: command.checkpointEventProjection,
      }),
    });
  } catch (error) {
    if (error instanceof DreamRunError) throw error;
    throw new DreamRunError("DURABLE_COMMIT_RECEIPT_INVALID", "durable page commit receipt is malformed or drifted", error);
  }
}

/**
 * Durable page-checkpoint production entry.  This remains a source seam: the
 * supplied committer owns persistence and this class creates no SQL, events,
 * scheduler, current-memory, reminder, permission, or tool effect.
 */
export class DurableProductionDreamRunService {
  readonly #reader: AcceptedDreamDeltaReader;
  readonly #extractor: DreamApplicationExtractor;
  readonly #trustedOverlayReader: TrustedDreamOwnerOverlayReader;
  readonly #durableCommitter: DurableDreamPageCommitter;
  readonly #requireCheckpointEvent: boolean;

  constructor(
    options: DurableProductionDreamRunServiceOptions,
    modeToken: object = STRICT_DURABLE_DREAM_RUN_TOKEN,
  ) {
    if (!isRecord(options)) throw new DreamRunError("INVALID_REQUEST", "durable production Dream options are required");
    const forbiddenOptionKeys = [
      "acceptedDeltaReader", "candidateExtractor", "commandRepository", "committer",
      "environment", "production", "overlay", "deletionOverlay", "suppressionOverlay",
      "ownerOverlayReader", "productionReceipt", "issuerReceipt", "productionReceipts", "issuerReceipts",
    ];
    if (forbiddenOptionKeys.some((key) => hasOwn(options, key))) {
      throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "durable production factory rejects legacy option aliases");
    }
    if (typeof options.reader?.readAcceptedDreamDeltas !== "function" ||
        typeof options.extractor?.extract !== "function" ||
        typeof options.trustedOverlayReader?.readOwnerOverlay !== "function" ||
        typeof options.durableCommitter?.commitDreamPage !== "function") {
      throw new DreamRunError("INVALID_REQUEST", "durable production requires reader, extractor, trusted owner overlay, and durable committer");
    }
    this.#reader = options.reader;
    this.#extractor = options.extractor;
    this.#trustedOverlayReader = options.trustedOverlayReader;
    this.#durableCommitter = options.durableCommitter;
    this.#requireCheckpointEvent = modeToken !== LEGACY_DURABLE_DREAM_RUN_TOKEN;
  }

  async run(input: DurableProductionDreamRunInput): Promise<DurableProductionDreamRunResult> {
    const normalized = normalizeDurableInput(input, this.#requireCheckpointEvent);
    // Bind all caller-visible run context before any reader access.  A private
    // receipt cannot be moved to another user/date/window/batch after this.
    bindDreamRunContext(normalized);
    let rawPageValue: AcceptedDreamDeltaPage;
    try {
      rawPageValue = await this.#reader.readAcceptedDreamDeltas({
        userId: normalized.userId,
        window: normalized.window,
        limit: normalized.limit,
        ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
        pinnedWatermark: normalized.pinnedWatermark,
      });
    } catch (error) {
      if (error instanceof DreamRunError) throw error;
      throw new DreamRunError("READER_FAILED", "accepted Dream delta read failed", error);
    }
    const rawPage = normalizePage(rawPageValue, normalized);
    let ownerProjection: DurableDreamOwnerOverlayProjection;
    let page: NormalizedPage;
    try {
      const value = await this.#trustedOverlayReader.readOwnerOverlay({
        userId: normalized.userId,
        window: normalized.window,
        pinnedWatermark: normalized.pinnedWatermark,
        ...(normalized.cursor === undefined ? {} : { inputCursor: normalized.cursor }),
      });
      ownerProjection = normalizeDurableOwnerProjection(value, rawPage, normalized.pinnedWatermark);
      page = await applyOverlay(rawPage, ownerProjection);
    } catch (error) {
      if (error instanceof DreamRunError) throw error;
      throw new DreamRunError("OVERLAY_CONTRACT_VIOLATION", "durable owner overlay read failed", error);
    }

    let extracted: readonly DreamExtractorProposal[] = [];
    if (page.records.length > 0) {
      const deltas: readonly DreamExtractorDelta[] = Object.freeze(page.records.map((record) => Object.freeze({
        ref: record.ref,
        delta: record.delta,
        sourceRefs: record.sourceRefs,
        acceptedAt: record.acceptedAt,
      })));
      try {
        const value = await this.#extractor.extract({
          userId: normalized.userId,
          window: normalized.window,
          deltas,
        });
        if (!Array.isArray(value)) throw new DreamRunError("EXTRACTOR_CONTRACT_VIOLATION", "extractor must return an array");
        extracted = value;
      } catch (error) {
        if (error instanceof DreamRunError) throw error;
        throw new DreamRunError("EXTRACTOR_FAILED", "Dream extractor failed", error);
      }
    }
    const boundary = validateProposals(extracted, normalized);
    let batch: DreamCandidateBatch;
    try {
      const built = buildDreamCandidateBatch({
        window: normalized.window,
        batchId: normalized.batchId,
        idempotencyKey: normalized.idempotencyKey,
        acceptedDeltaRefs: page.acceptedEvidenceRefs,
        proposals: boundary.accepted,
        modelConfidenceThresholdPpm: normalized.modelConfidenceThresholdPpm,
      });
      batch = Object.freeze({
        ...built,
        rejected: Object.freeze([...built.rejected, ...boundary.rejected]),
      });
    } catch (error) {
      throw new DreamRunError("EXTRACTOR_CONTRACT_VIOLATION", "candidate intent admission failed", error);
    }
    const productionReceipts = validateProductionReceipts(normalized, batch.candidates);
    const pageReadReceipt = durableReadReceipt({ normalized, rawPage, page });
    const baseCommand = buildDurableCommand({
      normalized,
      page,
      readReceipt: pageReadReceipt,
      ownerProjection,
      batch,
      productionReceipts,
    });
    let command = baseCommand;
    let checkpointEvent: ProductionDreamPageCheckpointEventProjection | undefined;
    let checkpointEventReceipt: ProductionDreamPageCheckpointEventReceipt | undefined;
    if (this.#requireCheckpointEvent) {
      if (normalized.dreamRunIdReceipt === undefined) {
        throw new DreamRunError("PRODUCTION_RECEIPT_REQUIRED", "production durable page checkpoint requires a private run receipt");
      }
      const attached = attachCheckpointEvent(baseCommand);
      command = attached.command;
      checkpointEvent = attached.projection;
      checkpointEventReceipt = attached.event;
    }
    let untrustedReceipt: DurableDreamPageCommitReceipt;
    try {
      // Exactly one call for every valid page, including every zero-candidate case.
      untrustedReceipt = await this.#durableCommitter.commitDreamPage(command);
    } catch (error) {
      if (error instanceof DreamRunError) throw error;
      throw new DreamRunError("COMMIT_FAILED", "durable Dream page commit failed", error);
    }
    const commitReceipt = validateDurableCommitReceipt(untrustedReceipt, command);
    return Object.freeze({
      kind: "durable_daily_dream_page" as const,
      outcome: commitReceipt.outcome,
      userId: normalized.userId,
      batchId: normalized.batchId,
      batchIdempotencyKey: normalized.idempotencyKey,
      pageIdempotencyKey: normalized.pageIdempotencyKey,
      ...(normalized.dreamRunIdReceipt === undefined ? {} : {
        dreamRunId: normalized.dreamRunIdReceipt.dreamRunId,
        dreamRunIdReceipt: normalized.dreamRunIdReceipt,
        dreamRunIdProjection: projectProductionDreamRunIdReceipt(normalized.dreamRunIdReceipt),
      }),
      timeZone: normalized.window.timeZone,
      localDate: normalized.window.localDate,
      window: normalized.window,
      pinnedWatermark: normalized.pinnedWatermark,
      readReceipt: pageReadReceipt,
      ownerProjection,
      candidates: batch.candidates,
      batch,
      productionReceipts,
      fingerprint: command.fingerprint,
      command,
      commitReceipt,
      canonicalRefs: commitReceipt.canonicalRefs,
      ...(checkpointEvent === undefined ? {} : { checkpointEvent }),
      ...(checkpointEventReceipt === undefined ? {} : { checkpointEventReceipt }),
      ...(checkpointEvent === undefined ? {} : { checkpointEventProjection: checkpointEvent }),
    });
  }

  runPage(input: DurableProductionDreamRunInput): Promise<DurableProductionDreamRunResult> {
    return this.run(input);
  }
}

export function createDreamRunService(options: DreamRunServiceOptions): DreamRunService {
  if (!options || typeof options !== "object") {
    throw new DreamRunError("INVALID_REQUEST", "Dream run options are required");
  }
  if (options.environment === "production" || options.production === true ||
      options.productionReceipt !== undefined || options.issuerReceipt !== undefined ||
      options.productionReceipts !== undefined || options.issuerReceipts !== undefined) {
    throw new DreamRunError("PRODUCTION_ENTRY_REQUIRED", "production runs require createProductionDreamRunService");
  }
  return new DreamRunService(options);
}

export const createDailyDreamRunService = createDreamRunService;

export function createProductionDreamRunService(
  options: ProductionDreamRunServiceOptions,
): ProductionDreamRunService {
  return new ProductionDreamRunService(options);
}

export function createDurableProductionDreamRunService(
  options: DurableProductionDreamRunServiceOptions,
): DurableProductionDreamRunService {
  // A3 is the default production durable entry: no receipt means no reader,
  // no committer, and no candidate/reference exposure.
  return new DurableProductionDreamRunService(options, STRICT_DURABLE_DREAM_RUN_TOKEN);
}

/**
 * Explicit A/A2 source compatibility seam.  It never silently becomes the
 * A3 production entry and therefore does not claim RFC-011 checkpoint events.
 */
export function createLegacyDurableProductionDreamRunService(
  options: DurableProductionDreamRunServiceOptions,
): DurableProductionDreamRunService {
  return new DurableProductionDreamRunService(options, LEGACY_DURABLE_DREAM_RUN_TOKEN);
}

export type DreamRunRequest = DreamRunInput;
export type DailyDreamRunInput = DreamRunInput;
export type DailyDreamRunResult = DreamRunResult;
export type DailyDreamRunServiceOptions = DreamRunServiceOptions;

/** Compatibility alias for callers that name the feature Daily Dream. */
export const DailyDreamRunService = DreamRunService;
