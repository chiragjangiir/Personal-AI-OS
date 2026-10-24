import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { RealtimeIdentityPort } from "../../realtime-core/src/ports.ts";
import type { OpaqueCanonicalRef } from "../../realtime-core/src/types.ts";
import {
  assertRealtimeCanonicalDeviceIdentityReceipt,
  type RealtimeCanonicalDeviceIdentityIssuerPort,
} from "./realtime-canonical-device-issuer.ts";
import { claimIdempotency, completeIdempotency, IdempotencyConflictError } from "./idempotency-ledger.ts";
import { enqueueOutboxEvent } from "./transactional-outbox.ts";
import { isManagedTransactionClient, withTransaction } from "./transaction.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REF_KEYS = ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"] as const;
const MAX_TTL_SECONDS = 86_400;
const OBJECT_VERSION = "1";
const RECEIPT_KIND = "t02.apple.physical-canary-binding.v1";
const FORMAL_KIND = "t02.apple.watch-binding.v1";
const FORMAL_SCOPE = "apple.watch.binding.mutate";
const REFRESH_SCOPE = "apple_physical_canary_binding.refresh";
const REFRESH_EVENT_TYPE = "apple.physical.canary.binding.refreshed";

type JsonRecord = Record<string, unknown>;

interface SnakeRef extends Readonly<Record<string, unknown>> {
  readonly ref_type: "RealtimeSession" | "DeviceLease";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

export interface ApplePhysicalCanaryBindingIssueInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly iphoneDeviceLeaseRef: OpaqueCanonicalRef;
  readonly iphoneCoreDeviceId: string;
  readonly iphoneLocalClientInstanceId: string;
  readonly watchCoreDeviceId: string;
  readonly watchLocalClientInstanceId: string;
  readonly ttlSeconds: number;
}

export interface ApplePhysicalCanaryEndpointIdentity {
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
}

export interface ApplePhysicalCanaryBindingReceipt {
  readonly bindingId: string;
  readonly canonicalPayloadSha256: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly iphone: ApplePhysicalCanaryEndpointIdentity;
  readonly issuedAt: string;
  readonly kind: typeof RECEIPT_KIND | typeof FORMAL_KIND;
  /** Present exclusively for the formal discriminator. Never inferred for legacy rows. */
  readonly pairVersion?: string;
  readonly installationId?: string;
  readonly userId?: string;
  readonly principalRef?: unknown;
  readonly status?: "active" | "revoked";
  readonly objectVersion: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly requestFingerprintSha256: string;
  readonly requestId: string;
  readonly watch: ApplePhysicalCanaryEndpointIdentity;
}

export interface AppleFormalWatchBindingReceipt extends ApplePhysicalCanaryBindingReceipt {
  readonly kind: typeof FORMAL_KIND;
  readonly pairVersion: string;
  readonly installationId: string;
  readonly userId: string;
  readonly principalRef: unknown;
  readonly status: "active" | "revoked";
}

/** Context emitted by the authenticated T03 owner, separate from registration input. */
export interface AppleFormalWatchPrimaryAuthority {
  readonly purpose: string;
  readonly policyDecisionRef: unknown;
  readonly capabilities: unknown;
  readonly principalRef: unknown;
  readonly userId: string;
  readonly deviceId: string;
  readonly expiresAt: string;
}

export interface AppleFormalWatchPairState {
  readonly pairVersion: string;
  readonly status: "absent" | "active" | "revoked";
  readonly requiresRebind: boolean;
}

export interface AppleFormalWatchMutationInput {
  readonly action: "register" | "replace" | "revoke";
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly iphoneDeviceLeaseRef: OpaqueCanonicalRef;
  readonly expectedPairVersion: string;
  readonly installationId?: string;
  readonly ttlSeconds?: number;
}

export interface ApplePhysicalCanaryBindingRevokeInput {
  readonly bindingId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly canonicalPayloadSha256: string;
}

export interface ApplePhysicalCanaryBindingActiveReadInput {
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly iphoneDeviceLeaseRef: OpaqueCanonicalRef;
  readonly now?: string | Date;
}

export interface ApplePhysicalCanaryBindingRefreshInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly iphoneDeviceLeaseRef: OpaqueCanonicalRef;
  readonly ttlSeconds: number;
  readonly expectedLeaseVersion?: string;
  readonly expectedFencingToken?: string;
}

export interface ApplePhysicalCanaryBindingRefreshResult {
  readonly binding: ApplePhysicalCanaryBindingReceipt;
  readonly fencingToken: string;
  readonly leaseVersion: string;
  readonly refreshedAt: string;
}

export interface ApplePhysicalCanaryBindingPostgresPort {
  issue(input: ApplePhysicalCanaryBindingIssueInput): Promise<ApplePhysicalCanaryBindingReceipt>;
  read(bindingId: string): Promise<ApplePhysicalCanaryBindingReceipt | undefined>;
  readActiveByPrimary(input: ApplePhysicalCanaryBindingActiveReadInput): Promise<ApplePhysicalCanaryBindingReceipt | undefined>;
  refreshActiveByPrimary(input: ApplePhysicalCanaryBindingRefreshInput): Promise<ApplePhysicalCanaryBindingRefreshResult | undefined>;
  revoke(input: ApplePhysicalCanaryBindingRevokeInput): Promise<void>;
}

export interface AppleWatchCredentialInput {
  readonly action: "issue" | "refresh" | "revoke";
  readonly requestId: string;
  readonly watchDeviceId: string;
  readonly installationId: string;
  readonly expectedPairVersion: string;
}
export interface AppleWatchCredentialResolution {
  readonly binding: AppleFormalWatchBindingReceipt;
  readonly governance: Record<string, unknown>;
  readonly expiresAt: string;
  readonly continuityId: string;
}
export class AppleWatchCredentialError extends Error {
  readonly reason: string;
  readonly status: number;
  constructor(reason: string, status: number) { super(reason);this.reason=reason;this.status=status; }
}
export interface AppleCompanionBindingPostgresPort extends ApplePhysicalCanaryBindingPostgresPort {
  credential(input: AppleWatchCredentialInput, authenticatedBearer: unknown): Promise<Record<string, unknown>>;
  withWatchAdmission<T>(userId: string, parentDeviceId: string, watchDeviceId: string, consume: (binding: AppleFormalWatchBindingReceipt) => Promise<T>): Promise<T>;
  readWatchInAdmission(client: PoolClient, userId: string, parentDeviceId: string, watchDeviceId: string): Promise<AppleFormalWatchBindingReceipt>;
  resolveCredential(token: string, client?: PoolClient): Promise<AppleWatchCredentialResolution>;
  withCredentialAdmission<T>(token: string, consume: (resolved: AppleWatchCredentialResolution, client: PoolClient) => Promise<T>): Promise<T>;
  mutateFormal(input: AppleFormalWatchMutationInput, authenticatedBearer: unknown): Promise<AppleFormalWatchBindingReceipt>;
  readFormal(input: ApplePhysicalCanaryBindingActiveReadInput, authenticatedBearer: unknown): Promise<{ pairState: AppleFormalWatchPairState; binding: AppleFormalWatchBindingReceipt | undefined }>;
  readFormalPairStateInTransaction(client: PoolClient, input: ApplePhysicalCanaryBindingActiveReadInput, expectedPrincipalRef?: unknown): Promise<AppleFormalWatchPairState>;
  readFormalByPrimaryInTransaction(client: PoolClient, input: ApplePhysicalCanaryBindingActiveReadInput): Promise<AppleFormalWatchBindingReceipt | undefined>;
}

export interface ApplePhysicalCanaryBindingPostgresOptions {
  /** Borrowed Pool. This adapter never closes it. */
  readonly pool: Pool;
  readonly identity: RealtimeIdentityPort;
  readonly canonicalDeviceIssuer: RealtimeCanonicalDeviceIdentityIssuerPort;
  /** Resolved by the T03 record owner after authenticating the bearer; never request-body context. */
  readonly formalPrimaryAuthority?: { readonly resolve: (authenticatedBearer: unknown, client?: PoolClient) => Promise<AppleFormalWatchPrimaryAuthority> };
}

export class ApplePhysicalCanaryBindingPostgresError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "ApplePhysicalCanaryBindingPostgresError";
    this.code = code;
  }
}

function fail(code: string, cause?: unknown): never {
  throw cause === undefined
    ? new ApplePhysicalCanaryBindingPostgresError(code)
    : new ApplePhysicalCanaryBindingPostgresError(code, { cause });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true) fail(code);
  }
  return value;
}

function boundedText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value ||
      /\s/u.test(value)) fail(code);
  return value;
}

function rawUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(code);
  return value;
}

function uuidV7(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) fail(code);
  return value;
}

function hash(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown, code: string): string {
  let normalized: string | undefined;
  try {
    normalized = value instanceof Date ? value.toISOString() : typeof value === "string"
      ? new Date(value).toISOString()
      : undefined;
  } catch {
    fail(code);
  }
  if (normalized === undefined || !UTC.test(normalized) || !Number.isFinite(Date.parse(normalized))) fail(code);
  return normalized;
}

function ttlSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_SECONDS) {
    fail("APPLE_PHYSICAL_CANARY_TTL_INVALID");
  }
  return value;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("APPLE_PHYSICAL_CANARY_CANONICAL_JSON_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) fail("APPLE_PHYSICAL_CANARY_CANONICAL_JSON_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1) {
        fail("APPLE_PHYSICAL_CANARY_CANONICAL_JSON_INVALID");
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      fail("APPLE_PHYSICAL_CANARY_CANONICAL_JSON_INVALID");
    }
    return `{${Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) fail("APPLE_PHYSICAL_CANARY_CANONICAL_JSON_INVALID");
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Domain(domain: string, canonicalPayload: string): string {
  return createHash("sha256").update(`${domain}\n${canonicalPayload}`, "utf8").digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(canonicalJson(value)) as unknown;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalRef(
  value: unknown,
  expectedType: "RealtimeSession" | "DeviceLease",
  identity: RealtimeIdentityPort,
  code: string,
): SnakeRef {
  const record = exactRecord(value, REF_KEYS, code);
  if (record.ref_type !== expectedType || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !POSITIVE_DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256)) fail(code);
  try {
    identity.assertRepositoryIssuedRef(record as unknown as OpaqueCanonicalRef, expectedType);
  } catch (error) {
    fail(code, error);
  }
  return deepFreeze({
    ref_type: expectedType,
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

interface NormalizedIssueInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: SnakeRef;
  readonly iphoneDeviceLeaseRef: SnakeRef;
  readonly iphoneCoreDeviceId: string;
  readonly iphoneLocalClientInstanceId: string;
  readonly watchCoreDeviceId: string;
  readonly watchLocalClientInstanceId: string;
  readonly ttlSeconds: number;
}

function normalizeIssueInput(value: ApplePhysicalCanaryBindingIssueInput, identity: RealtimeIdentityPort): NormalizedIssueInput {
  const record = exactRecord(value, [
    "requestId", "idempotencyKey", "realtimeSessionRef", "iphoneDeviceLeaseRef",
    "iphoneCoreDeviceId", "iphoneLocalClientInstanceId", "watchCoreDeviceId",
    "watchLocalClientInstanceId", "ttlSeconds",
  ], "APPLE_PHYSICAL_CANARY_INPUT_INVALID");
  const normalized = deepFreeze({
    requestId: boundedText(record.requestId, "APPLE_PHYSICAL_CANARY_REQUEST_INVALID"),
    idempotencyKey: boundedText(record.idempotencyKey, "APPLE_PHYSICAL_CANARY_IDEMPOTENCY_INVALID"),
    realtimeSessionRef: canonicalRef(record.realtimeSessionRef, "RealtimeSession", identity,
      "APPLE_PHYSICAL_CANARY_SESSION_REF_INVALID"),
    iphoneDeviceLeaseRef: canonicalRef(record.iphoneDeviceLeaseRef, "DeviceLease", identity,
      "APPLE_PHYSICAL_CANARY_IPHONE_LEASE_REF_INVALID"),
    iphoneCoreDeviceId: rawUuid(record.iphoneCoreDeviceId, "APPLE_PHYSICAL_CANARY_RAW_ID_INVALID"),
    iphoneLocalClientInstanceId: rawUuid(record.iphoneLocalClientInstanceId,
      "APPLE_PHYSICAL_CANARY_RAW_ID_INVALID"),
    watchCoreDeviceId: rawUuid(record.watchCoreDeviceId, "APPLE_PHYSICAL_CANARY_RAW_ID_INVALID"),
    watchLocalClientInstanceId: rawUuid(record.watchLocalClientInstanceId,
      "APPLE_PHYSICAL_CANARY_RAW_ID_INVALID"),
    ttlSeconds: ttlSeconds(record.ttlSeconds),
  });
  if (new Set([
        normalized.iphoneCoreDeviceId, normalized.iphoneLocalClientInstanceId,
        normalized.watchCoreDeviceId, normalized.watchLocalClientInstanceId,
      ]).size !== 4) fail("APPLE_PHYSICAL_CANARY_ENDPOINT_IDENTITY_COLLISION");
  return normalized;
}

function requestFingerprintSha256(input: NormalizedIssueInput): string {
  const canonical = canonicalJson({
    idempotencyKey: input.idempotencyKey,
    iphoneCoreDeviceId: input.iphoneCoreDeviceId,
    iphoneDeviceLeaseRef: input.iphoneDeviceLeaseRef,
    iphoneLocalClientInstanceId: input.iphoneLocalClientInstanceId,
    kind: RECEIPT_KIND,
    realtimeSessionRef: input.realtimeSessionRef,
    requestId: input.requestId,
    ttlSeconds: input.ttlSeconds,
    watchCoreDeviceId: input.watchCoreDeviceId,
    watchLocalClientInstanceId: input.watchLocalClientInstanceId,
  });
  return sha256Domain("paios.t02.apple-physical-canary-binding.request.v1", canonical);
}

function receiptBody(receipt: Omit<ApplePhysicalCanaryBindingReceipt, "canonicalPayloadSha256">): JsonRecord {
  return {
    bindingId: receipt.bindingId,
    expiresAt: receipt.expiresAt,
    idempotencyKey: receipt.idempotencyKey,
    iphone: receipt.iphone,
    issuedAt: receipt.issuedAt,
    kind: receipt.kind,
    objectVersion: receipt.objectVersion,
    realtimeSessionRef: receipt.realtimeSessionRef,
    requestFingerprintSha256: receipt.requestFingerprintSha256,
    requestId: receipt.requestId,
    watch: receipt.watch,
    ...(receipt.kind === FORMAL_KIND ? {
      pairVersion: receipt.pairVersion, installationId: receipt.installationId,
      userId: receipt.userId, principalRef: receipt.principalRef, status: receipt.status,
    } : {}),
  };
}

function makeReceipt(
  input: NormalizedIssueInput,
  fingerprint: string,
  bindingId: string,
  iphoneDeviceId: string,
  iphoneClientInstanceId: string,
  watchDeviceId: string,
  watchClientInstanceId: string,
  watchDeviceLeaseRef: SnakeRef,
  issuedAt: string,
  expiresAt: string,
): ApplePhysicalCanaryBindingReceipt {
  const body: Omit<ApplePhysicalCanaryBindingReceipt, "canonicalPayloadSha256"> = deepFreeze({
    bindingId,
    expiresAt,
    idempotencyKey: input.idempotencyKey,
    iphone: deepFreeze({
      clientInstanceId: iphoneClientInstanceId,
      deviceId: iphoneDeviceId,
      deviceLeaseRef: input.iphoneDeviceLeaseRef as unknown as OpaqueCanonicalRef,
    }),
    issuedAt,
    kind: RECEIPT_KIND,
    objectVersion: OBJECT_VERSION,
    realtimeSessionRef: input.realtimeSessionRef as unknown as OpaqueCanonicalRef,
    requestFingerprintSha256: fingerprint,
    requestId: input.requestId,
    watch: deepFreeze({
      clientInstanceId: watchClientInstanceId,
      deviceId: watchDeviceId,
      deviceLeaseRef: watchDeviceLeaseRef as unknown as OpaqueCanonicalRef,
    }),
  });
  const canonicalPayloadSha256 = sha256Domain(
    "paios.t02.apple-physical-canary-binding.receipt.v1",
    canonicalJson(receiptBody(body)),
  );
  const canonicalReceipt = canonicalJson({ ...body, canonicalPayloadSha256 });
  return validateReceipt(JSON.parse(canonicalReceipt));
}

function refreshedReceipt(
  receipt: ApplePhysicalCanaryBindingReceipt,
  expiresAt: string,
): ApplePhysicalCanaryBindingReceipt {
  const { canonicalPayloadSha256: _ignored, ...body } = receipt;
  const refreshedBody = { ...body, expiresAt };
  const canonicalPayloadSha256 = sha256Domain(
    "paios.t02.apple-physical-canary-binding.receipt.v1",
    canonicalJson(refreshedBody),
  );
  return validateReceipt(JSON.parse(canonicalJson({ ...refreshedBody, canonicalPayloadSha256 })));
}

function refreshResult(value: unknown): ApplePhysicalCanaryBindingRefreshResult {
  const record = exactRecord(value, ["binding", "fencingToken", "leaseVersion", "refreshedAt"],
    "APPLE_PHYSICAL_CANARY_REFRESH_RESULT_INVALID");
  const binding = validateReceipt(record.binding);
  const leaseVersion = boundedText(record.leaseVersion, "APPLE_PHYSICAL_CANARY_REFRESH_RESULT_INVALID");
  const fencingToken = boundedText(record.fencingToken, "APPLE_PHYSICAL_CANARY_REFRESH_RESULT_INVALID");
  if (!POSITIVE_DECIMAL.test(leaseVersion) || !POSITIVE_DECIMAL.test(fencingToken)) {
    fail("APPLE_PHYSICAL_CANARY_REFRESH_RESULT_INVALID");
  }
  return deepFreeze({
    binding,
    fencingToken,
    leaseVersion,
    refreshedAt: timestamp(record.refreshedAt, "APPLE_PHYSICAL_CANARY_REFRESH_RESULT_INVALID"),
  });
}

function endpoint(value: unknown, expectedLeaseType: "DeviceLease"): ApplePhysicalCanaryEndpointIdentity {
  const record = exactRecord(value, ["clientInstanceId", "deviceId", "deviceLeaseRef"],
    "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  const refRecord = exactRecord(record.deviceLeaseRef, REF_KEYS, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  if (refRecord.ref_type !== expectedLeaseType || typeof refRecord.ref_id !== "string" || !UUID_V7.test(refRecord.ref_id) ||
      typeof refRecord.object_version !== "string" || !POSITIVE_DECIMAL.test(refRecord.object_version) ||
      typeof refRecord.canonical_payload_sha256 !== "string" || !SHA256.test(refRecord.canonical_payload_sha256)) {
    fail("APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  }
  return deepFreeze({
    clientInstanceId: uuidV7(record.clientInstanceId, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    deviceId: uuidV7(record.deviceId, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    deviceLeaseRef: deepFreeze({ ...refRecord }) as unknown as OpaqueCanonicalRef,
  });
}

function validateReceipt(value: unknown): ApplePhysicalCanaryBindingReceipt {
  const formal = isPlainRecord(value) && value.kind === FORMAL_KIND;
  const record = exactRecord(value, [
    ...(formal ? ["pairVersion", "installationId", "userId", "principalRef", "status"] : []),
    "bindingId", "canonicalPayloadSha256", "expiresAt", "idempotencyKey", "iphone", "issuedAt", "kind",
    "objectVersion", "realtimeSessionRef", "requestFingerprintSha256", "requestId", "watch",
  ], "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  const sessionRef = exactRecord(record.realtimeSessionRef, REF_KEYS, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  if (sessionRef.ref_type !== "RealtimeSession" || typeof sessionRef.ref_id !== "string" || !UUID_V7.test(sessionRef.ref_id) ||
      typeof sessionRef.object_version !== "string" || !POSITIVE_DECIMAL.test(sessionRef.object_version) ||
      typeof sessionRef.canonical_payload_sha256 !== "string" || !SHA256.test(sessionRef.canonical_payload_sha256)) {
    fail("APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  }
  const iphone = endpoint(record.iphone, "DeviceLease");
  const watch = endpoint(record.watch, "DeviceLease");
  const issuedAt = timestamp(record.issuedAt, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  const expiresAt = timestamp(record.expiresAt, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  if ((record.kind !== RECEIPT_KIND && record.kind !== FORMAL_KIND) || typeof record.objectVersion !== "string" ||
      !POSITIVE_DECIMAL.test(record.objectVersion)) fail("APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  const receipt: ApplePhysicalCanaryBindingReceipt = deepFreeze({
    bindingId: uuidV7(record.bindingId, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    canonicalPayloadSha256: hash(record.canonicalPayloadSha256, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    expiresAt,
    idempotencyKey: boundedText(record.idempotencyKey, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    iphone,
    issuedAt,
    kind: record.kind as typeof RECEIPT_KIND | typeof FORMAL_KIND,
    objectVersion: record.objectVersion,
    realtimeSessionRef: deepFreeze({ ...sessionRef }) as unknown as OpaqueCanonicalRef,
    ...(formal ? {
      pairVersion: boundedText(record.pairVersion, "APPLE_FORMAL_WATCH_RECEIPT_INVALID"),
      installationId: rawUuid(record.installationId, "APPLE_FORMAL_WATCH_RECEIPT_INVALID"),
      principalRef: cloneJson(record.principalRef),
      userId: uuidV7(record.userId, "APPLE_FORMAL_WATCH_RECEIPT_INVALID"),
      status: record.status as "active" | "revoked",
    } : {}),
    requestFingerprintSha256: hash(record.requestFingerprintSha256, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    requestId: boundedText(record.requestId, "APPLE_PHYSICAL_CANARY_RECEIPT_INVALID"),
    watch,
  });
  if (formal && (receipt.principalRef === null || receipt.principalRef === undefined || !POSITIVE_DECIMAL.test(receipt.pairVersion!) ||
      (receipt.status !== "active" && receipt.status !== "revoked"))) fail("APPLE_FORMAL_WATCH_RECEIPT_INVALID");
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt) ||
      new Set([
        receipt.iphone.deviceId, receipt.iphone.clientInstanceId,
        receipt.watch.deviceId, receipt.watch.clientInstanceId,
      ]).size !== 4 || sameJson(receipt.iphone.deviceLeaseRef, receipt.watch.deviceLeaseRef)) {
    fail("APPLE_PHYSICAL_CANARY_RECEIPT_INVALID");
  }
  const expectedHash = sha256Domain(
    receipt.kind === FORMAL_KIND ? "paios.t02.apple-watch-binding.receipt.v1" : "paios.t02.apple-physical-canary-binding.receipt.v1",
    canonicalJson(receiptBody(receipt)),
  );
  if (receipt.canonicalPayloadSha256 !== expectedHash) fail("APPLE_PHYSICAL_CANARY_RECEIPT_HASH_DRIFT");
  return receipt;
}

export function assertAppleFormalWatchBindingReceipt(value: unknown): AppleFormalWatchBindingReceipt {
  const receipt = validateReceipt(value);
  if (receipt.kind !== FORMAL_KIND) fail("APPLE_FORMAL_WATCH_SOURCE_INVALID");
  return receipt as AppleFormalWatchBindingReceipt;
}

function rowTimestamp(row: QueryResultRow, key: string): string {
  return timestamp(row[key], "APPLE_PHYSICAL_CANARY_STORED_TIME_DRIFT");
}

function rowReceipt(row: QueryResultRow): ApplePhysicalCanaryBindingReceipt {
  if (typeof row.receipt_jcs !== "string") fail("APPLE_PHYSICAL_CANARY_STORED_RECEIPT_DRIFT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_jcs);
  } catch (error) {
    fail("APPLE_PHYSICAL_CANARY_STORED_RECEIPT_DRIFT", error);
  }
  if (canonicalJson(parsed) !== row.receipt_jcs) fail("APPLE_PHYSICAL_CANARY_STORED_RECEIPT_DRIFT");
  const receipt = validateReceipt(parsed);
  const iphoneLease = receipt.iphone.deviceLeaseRef as unknown as SnakeRef;
  const watchLease = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  const sessionRef = receipt.realtimeSessionRef as unknown as SnakeRef;
  if (String(row.binding_id) !== receipt.bindingId || String(row.request_id) !== receipt.requestId ||
      String(row.idempotency_key) !== receipt.idempotencyKey ||
      String(row.request_fingerprint_sha256).trim() !== receipt.requestFingerprintSha256 ||
      String(row.canonical_payload_sha256).trim() !== receipt.canonicalPayloadSha256 ||
      String(row.object_version) !== receipt.objectVersion || rowTimestamp(row, "issued_at") !== receipt.issuedAt ||
      rowTimestamp(row, "expires_at") !== receipt.expiresAt || !sameJson(row.realtime_session_ref, sessionRef) ||
      String(row.session_ref_id) !== sessionRef.ref_id || String(row.session_object_version) !== sessionRef.object_version ||
      String(row.session_payload_sha256).trim() !== sessionRef.canonical_payload_sha256 ||
      !sameJson(row.iphone_device_lease_ref, iphoneLease) || String(row.iphone_lease_ref_id) !== iphoneLease.ref_id ||
      String(row.iphone_lease_object_version) !== iphoneLease.object_version ||
      String(row.iphone_lease_payload_sha256).trim() !== iphoneLease.canonical_payload_sha256 ||
      String(row.iphone_device_id) !== receipt.iphone.deviceId ||
      String(row.iphone_client_instance_id) !== receipt.iphone.clientInstanceId ||
      !sameJson(row.watch_device_lease_ref, watchLease) || String(row.watch_lease_ref_id) !== watchLease.ref_id ||
      String(row.watch_lease_object_version) !== watchLease.object_version ||
      String(row.watch_lease_payload_sha256).trim() !== watchLease.canonical_payload_sha256 ||
      String(row.watch_device_id) !== receipt.watch.deviceId ||
      String(row.watch_client_instance_id) !== receipt.watch.clientInstanceId ||
      row.companion_role !== "watch" || row.companion_source !==
        (receipt.kind === FORMAL_KIND ? "apple_watch_binding_v1" : "apple_physical_canary_binding_v1") ||
      (receipt.kind === FORMAL_KIND && (String(row.pair_version) !== receipt.pairVersion ||
        !sameJson(row.principal_ref, receipt.principalRef) || String(row.user_id) !== receipt.userId || String(row.watch_installation_id) !== receipt.installationId ||
        row.state !== receipt.status))) {
    fail("APPLE_PHYSICAL_CANARY_STORED_BINDING_DRIFT");
  }
  const state = String(row.state);
  if ((state !== "active" && state !== "revoked") ||
      (state === "active" && row.revoked_at !== null && row.revoked_at !== undefined) ||
      (state === "revoked" && (row.revoked_at === null || row.revoked_at === undefined))) {
    fail("APPLE_PHYSICAL_CANARY_STORED_STATE_DRIFT");
  }
  return receipt;
}

interface AuthoritySnapshot {
  readonly observedAt: string;
  readonly sessionExpiresAt: string;
  readonly iphoneLeaseExpiresAt: string;
  readonly iphoneLeaseVersion: string;
  readonly iphoneFencingToken: string;
  readonly iphoneDeviceId: string;
  readonly userId: string;
  readonly continuityId: string;
  readonly continuityRef: unknown;
  readonly capabilities: unknown;
  readonly purpose: unknown;
  readonly policyDecisionRef: unknown;
  readonly capabilityScope: unknown;
  readonly purposeScope: unknown;
  readonly policyBinding: unknown;
}

async function primaryAuthoritySnapshot(
  client: PoolClient,
  sessionRef: SnakeRef,
  iphoneLeaseRef: SnakeRef,
  lock: boolean,
): Promise<AuthoritySnapshot> {
  const rows = (await client.query([
    "SELECT transaction_timestamp() AS observed_at,",
    "s.realtime_session_ref, s.session_object_version, s.session_payload_sha256, s.state AS session_state,",
    "s.continuity_state, s.continuity_expires_at, s.active_device_lease_ref, s.active_device_id,",
    "s.user_id AS session_user_id, s.continuity_id AS session_continuity_id, s.continuity_ref AS session_continuity_ref,",
    "il.device_lease_ref AS iphone_device_lease_ref, il.lease_object_version AS iphone_lease_object_version,",
    "il.lease_payload_sha256 AS iphone_lease_payload_sha256, il.realtime_session_ref AS iphone_session_ref,",
    "il.session_ref_id AS iphone_session_ref_id, il.device_id AS iphone_device_id, il.state AS iphone_state,",
    "il.user_id AS iphone_user_id, il.continuity_id AS iphone_continuity_id, il.continuity_ref AS iphone_continuity_ref,",
    "il.expires_at AS iphone_expires_at, il.revocable AS iphone_revocable, il.capabilities, il.purpose,",
    "il.lease_version AS iphone_lease_version, il.fencing_token AS iphone_fencing_token,",
    "il.policy_decision_ref, il.capability_scope, il.purpose_scope, il.policy_binding",
    "FROM realtime_sessions AS s",
    "JOIN device_leases AS il ON il.lease_ref_id = $2",
    "WHERE s.session_ref_id = $1",
    lock ? "FOR UPDATE OF s, il" : "",
  ].filter((line) => line.length > 0).join(" "), [sessionRef.ref_id, iphoneLeaseRef.ref_id])).rows;
  if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_AUTHORITY_MISSING");
  const row = rows[0]!;
  if (!sameJson(row.realtime_session_ref, sessionRef) ||
      String(row.session_object_version) !== sessionRef.object_version ||
      String(row.session_payload_sha256).trim() !== sessionRef.canonical_payload_sha256 ||
      row.session_state !== "active" || row.continuity_state !== "active" ||
      !sameJson(row.iphone_device_lease_ref, iphoneLeaseRef) ||
      String(row.iphone_lease_object_version) !== iphoneLeaseRef.object_version ||
      String(row.iphone_lease_payload_sha256).trim() !== iphoneLeaseRef.canonical_payload_sha256 ||
      !sameJson(row.iphone_session_ref, sessionRef) || String(row.iphone_session_ref_id) !== sessionRef.ref_id ||
      row.iphone_state !== "active" || row.iphone_revocable !== true ||
      !sameJson(row.active_device_lease_ref, iphoneLeaseRef) ||
      String(row.active_device_id) !== String(row.iphone_device_id) ||
      String(row.session_user_id) !== String(row.iphone_user_id) ||
      String(row.session_continuity_id) !== String(row.iphone_continuity_id) ||
      !sameJson(row.session_continuity_ref, row.iphone_continuity_ref) ||
       row.capability_scope === null || row.capability_scope === undefined ||
       row.purpose_scope === null || row.purpose_scope === undefined ||
       row.policy_binding === null || row.policy_binding === undefined) {
    fail("APPLE_PHYSICAL_CANARY_AUTHORITY_BINDING_DRIFT");
  }
  const iphoneLeaseVersion = String(row.iphone_lease_version);
  const iphoneFencingToken = String(row.iphone_fencing_token);
  if (!POSITIVE_DECIMAL.test(iphoneLeaseVersion) || !POSITIVE_DECIMAL.test(iphoneFencingToken)) {
    fail("APPLE_PHYSICAL_CANARY_AUTHORITY_FENCE_DRIFT");
  }
  return Object.freeze({
    observedAt: rowTimestamp(row, "observed_at"),
    sessionExpiresAt: rowTimestamp(row, "continuity_expires_at"),
    iphoneLeaseExpiresAt: rowTimestamp(row, "iphone_expires_at"),
    iphoneLeaseVersion,
    iphoneFencingToken,
    iphoneDeviceId: uuidV7(String(row.iphone_device_id), "APPLE_PHYSICAL_CANARY_DEVICE_ID_INVALID"),
    userId: String(row.session_user_id),
    continuityId: String(row.session_continuity_id),
    continuityRef: cloneJson(row.session_continuity_ref),
    capabilities: cloneJson(row.capabilities),
    purpose: row.purpose,
    policyDecisionRef: cloneJson(row.policy_decision_ref),
    capabilityScope: cloneJson(row.capability_scope),
    purposeScope: cloneJson(row.purpose_scope),
    policyBinding: cloneJson(row.policy_binding),
  });
}

function assertAuthorityLifetime(snapshot: AuthoritySnapshot, expiresAt: string): void {
  const expiry = Date.parse(expiresAt);
  if (Date.parse(snapshot.observedAt) >= expiry) fail("APPLE_PHYSICAL_CANARY_BINDING_EXPIRED");
  if (Date.parse(snapshot.sessionExpiresAt) < expiry || Date.parse(snapshot.iphoneLeaseExpiresAt) < expiry) {
    fail("APPLE_PHYSICAL_CANARY_TTL_EXCEEDS_AUTHORITY");
  }
}

function assertPrimaryUsable(snapshot: AuthoritySnapshot): void {
  if (Date.parse(snapshot.observedAt) >= Date.parse(snapshot.sessionExpiresAt)) {
    fail("APPLE_PHYSICAL_CANARY_PRIMARY_SESSION_EXPIRED");
  }
  if (Date.parse(snapshot.observedAt) >= Date.parse(snapshot.iphoneLeaseExpiresAt)) {
    fail("APPLE_PHYSICAL_CANARY_PRIMARY_LEASE_EXPIRED");
  }
}

function verifyWatchLeaseRow(
  row: QueryResultRow,
  receipt: ApplePhysicalCanaryBindingReceipt,
  authority: AuthoritySnapshot,
  expectedLeaseVersion?: string,
  expectedFencingToken?: string,
): void {
  const sessionRef = receipt.realtimeSessionRef as unknown as SnakeRef;
  const watchLeaseRef = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  if (!sameJson(row.device_lease_ref, watchLeaseRef) || String(row.lease_ref_id) !== watchLeaseRef.ref_id ||
      String(row.lease_object_version) !== watchLeaseRef.object_version ||
      String(row.lease_payload_sha256).trim() !== watchLeaseRef.canonical_payload_sha256 ||
      String(row.session_ref_id) !== sessionRef.ref_id || !sameJson(row.realtime_session_ref, sessionRef) ||
      String(row.user_id) !== authority.userId || String(row.continuity_id) !== authority.continuityId ||
      !sameJson(row.continuity_ref, authority.continuityRef) || String(row.device_id) !== receipt.watch.deviceId ||
      row.state !== "active" || row.revocable !== true ||
      !POSITIVE_DECIMAL.test(String(row.lease_version)) ||
      !POSITIVE_DECIMAL.test(String(row.fencing_token)) ||
      (expectedLeaseVersion !== undefined && String(row.lease_version) !== expectedLeaseVersion) ||
      (expectedFencingToken !== undefined && String(row.fencing_token) !== expectedFencingToken) ||
      rowTimestamp(row, "issued_at") !== receipt.issuedAt ||
      rowTimestamp(row, "acquired_at") !== receipt.issuedAt || rowTimestamp(row, "expires_at") !== receipt.expiresAt ||
      row.released_at !== null || row.revoked_at !== null || !sameJson(row.capabilities, authority.capabilities) ||
      row.purpose !== authority.purpose || !sameJson(row.policy_decision_ref, authority.policyDecisionRef) ||
      !sameJson(row.capability_scope, authority.capabilityScope) ||
      !sameJson(row.purpose_scope, authority.purposeScope) || !sameJson(row.policy_binding, authority.policyBinding)) {
    fail("APPLE_PHYSICAL_CANARY_WATCH_LEASE_DRIFT");
  }
}

async function readWatchLease(
  client: PoolClient,
  receipt: ApplePhysicalCanaryBindingReceipt,
  authority: AuthoritySnapshot,
  lock: boolean,
): Promise<QueryResultRow> {
  const watchLeaseRef = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  const rows = (await client.query([
    "SELECT lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256, session_ref_id,",
    "realtime_session_ref, continuity_ref, user_id, device_id, continuity_id, capabilities, purpose,",
    "policy_decision_ref, capability_scope, purpose_scope, policy_binding, revocable, state, lease_version,",
    "fencing_token, issued_at, acquired_at, expires_at, released_at, revoked_at",
    "FROM device_leases AS wl WHERE lease_ref_id = $1",
    lock ? "FOR UPDATE" : "",
  ].filter((line) => line.length > 0).join(" "), [watchLeaseRef.ref_id])).rows;
  if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_WATCH_LEASE_MISSING");
  verifyWatchLeaseRow(rows[0]!, receipt, authority);
  return rows[0]!;
}

async function selectByPrimary(
  client: PoolClient,
  realtimeSessionRef: SnakeRef,
  iphoneDeviceLeaseRef: SnakeRef,
  lock: boolean,
): Promise<QueryResultRow | undefined> {
  const rows = (await client.query([
    "SELECT * FROM apple_physical_canary_bindings",
    "WHERE session_ref_id = $1 AND iphone_lease_ref_id = $2 AND companion_source = 'apple_physical_canary_binding_v1'",
    lock ? "FOR UPDATE" : "",
  ].filter((line) => line.length > 0).join(" "), [
    realtimeSessionRef.ref_id,
    iphoneDeviceLeaseRef.ref_id,
  ])).rows;
  if (rows.length > 1) fail("APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_CONFLICT");
  return rows[0];
}

function refreshExpiresAt(snapshot: AuthoritySnapshot, ttl: number): string {
  const now = Date.parse(snapshot.observedAt);
  const requested = now + ttl * 1_000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(requested)) {
    fail("APPLE_PHYSICAL_CANARY_REFRESH_TIME_INVALID");
  }
  const sessionExpiry = Date.parse(snapshot.sessionExpiresAt);
  const iphoneLeaseExpiry = Date.parse(snapshot.iphoneLeaseExpiresAt);
  if (!Number.isSafeInteger(sessionExpiry) || !Number.isSafeInteger(iphoneLeaseExpiry) ||
      now >= sessionExpiry || now >= iphoneLeaseExpiry) {
    fail("APPLE_PHYSICAL_CANARY_PRIMARY_LEASE_EXPIRED");
  }
  const expiry = Math.min(requested, sessionExpiry, iphoneLeaseExpiry);
  if (!Number.isSafeInteger(expiry) || expiry <= now) fail("APPLE_PHYSICAL_CANARY_REFRESH_TIME_INVALID");
  return new Date(expiry).toISOString();
}

function refreshEventPayload(
  binding: ApplePhysicalCanaryBindingReceipt,
  leaseVersion: string,
  fencingToken: string,
): JsonRecord {
  return deepFreeze({
    bindingId: binding.bindingId,
    expiresAt: binding.expiresAt,
    fencingToken,
    leaseVersion,
  });
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function updateRefreshedBinding(
  client: PoolClient,
  previous: QueryResultRow,
  receipt: ApplePhysicalCanaryBindingReceipt,
): Promise<QueryResultRow> {
  const result = await client.query([
    "UPDATE apple_physical_canary_bindings SET expires_at = $2::timestamptz,",
    "receipt_jcs = $3, canonical_payload_sha256 = $4, updated_at = transaction_timestamp()",
    "WHERE binding_id = $1 AND state = 'active' AND canonical_payload_sha256 = $5",
  ].join(" "), [
    receipt.bindingId,
    receipt.expiresAt,
    canonicalJson(receipt),
    receipt.canonicalPayloadSha256,
    String(previous.canonical_payload_sha256).trim(),
  ]);
  if (result.rowCount !== 1) fail("APPLE_PHYSICAL_CANARY_REFRESH_BINDING_CONFLICT");
  const rows = (await client.query(
    "SELECT * FROM apple_physical_canary_bindings WHERE binding_id = $1 FOR UPDATE",
    [receipt.bindingId],
  )).rows;
  if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_REFRESH_BINDING_CONFLICT");
  return rows[0]!;
}

async function updateRefreshedWatchLease(
  client: PoolClient,
  previous: QueryResultRow,
  receipt: ApplePhysicalCanaryBindingReceipt,
  authority: AuthoritySnapshot,
  expiresAt: string,
): Promise<{ readonly leaseVersion: string; readonly fencingToken: string; readonly row: QueryResultRow }> {
  const currentLeaseVersion = incrementDecimal(previous.lease_version,
    "APPLE_PHYSICAL_CANARY_REFRESH_LEASE_VERSION_DRIFT");
  const currentFencingToken = incrementDecimal(previous.fencing_token,
    "APPLE_PHYSICAL_CANARY_REFRESH_FENCING_TOKEN_DRIFT");
  const watchLeaseRef = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  const result = await client.query([
    "UPDATE device_leases SET state = 'active', expires_at = $2::timestamptz,",
    "lease_version = $3, fencing_token = $4, released_at = NULL, revoked_at = NULL,",
    "updated_at = transaction_timestamp() WHERE lease_ref_id = $1 AND session_ref_id = $5",
    "AND device_id = $6 AND state = 'active' AND lease_version = $7 AND fencing_token = $8",
    "AND released_at IS NULL AND revoked_at IS NULL",
  ].join(" "), [
    watchLeaseRef.ref_id,
    expiresAt,
    currentLeaseVersion,
    currentFencingToken,
    (receipt.realtimeSessionRef as unknown as SnakeRef).ref_id,
    receipt.watch.deviceId,
    String(previous.lease_version),
    String(previous.fencing_token),
  ]);
  if (result.rowCount !== 1) fail("APPLE_PHYSICAL_CANARY_REFRESH_LEASE_CONFLICT");
  const row = await readWatchLease(client, receipt, authority, true);
  verifyWatchLeaseRow(row, receipt, authority, currentLeaseVersion, currentFencingToken);
  return { leaseVersion: currentLeaseVersion, fencingToken: currentFencingToken, row };
}

async function insertWatchLease(
  client: PoolClient,
  receipt: ApplePhysicalCanaryBindingReceipt,
  authority: AuthoritySnapshot,
): Promise<void> {
  const sessionRef = receipt.realtimeSessionRef as unknown as SnakeRef;
  const watchLeaseRef = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  const values: unknown[] = [
    watchLeaseRef.ref_id, JSON.stringify(watchLeaseRef), watchLeaseRef.object_version,
    watchLeaseRef.canonical_payload_sha256, sessionRef.ref_id, JSON.stringify(sessionRef),
    JSON.stringify(authority.continuityRef), authority.userId, receipt.watch.deviceId, authority.continuityId,
    JSON.stringify(authority.capabilities), authority.purpose, JSON.stringify(authority.policyDecisionRef),
    JSON.stringify(authority.capabilityScope), JSON.stringify(authority.purposeScope),
    JSON.stringify(authority.policyBinding), receipt.issuedAt, receipt.expiresAt,
  ];
  const result = await client.query([
    "INSERT INTO device_leases (lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256,",
    "session_ref_id, realtime_session_ref, continuity_ref, user_id, device_id, continuity_id, capabilities,",
    "purpose, policy_decision_ref, capability_scope, purpose_scope, policy_binding, revocable, state,",
    "lease_version, fencing_token, issued_at, acquired_at, expires_at, updated_at) VALUES (",
    "$1,$2::jsonb,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14::jsonb,",
    "$15::jsonb,$16::jsonb,TRUE,'active',1,1,$17::timestamptz,$17::timestamptz,$18::timestamptz,",
    "$17::timestamptz) RETURNING lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256,",
    "session_ref_id, realtime_session_ref, continuity_ref, user_id, device_id, continuity_id, capabilities,",
    "purpose, policy_decision_ref, capability_scope, purpose_scope, policy_binding, revocable, state,",
    "lease_version, fencing_token, issued_at, acquired_at, expires_at, released_at, revoked_at",
  ].join(" "), values);
  if (result.rows.length !== 1 || result.rowCount !== 1) fail("APPLE_PHYSICAL_CANARY_WATCH_LEASE_INSERT_INVALID");
  verifyWatchLeaseRow(result.rows[0]!, receipt, authority, "1", "1");
}

async function releaseWatchCompanionLease(
  client: PoolClient,
  receipt: ApplePhysicalCanaryBindingReceipt,
  bindingState: "active" | "revoked",
): Promise<void> {
  const sessionRef = receipt.realtimeSessionRef as unknown as SnakeRef;
  const watchLeaseRef = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  const rows = (await client.query([
    "SELECT lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256, session_ref_id,",
    "realtime_session_ref, device_id, state, released_at, revoked_at FROM device_leases",
    "WHERE lease_ref_id = $1 FOR UPDATE",
  ].join(" "), [watchLeaseRef.ref_id])).rows;
  if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_WATCH_LEASE_MISSING");
  const row = rows[0]!;
  if (String(row.lease_ref_id) !== watchLeaseRef.ref_id || !sameJson(row.device_lease_ref, watchLeaseRef) ||
      String(row.lease_object_version) !== watchLeaseRef.object_version ||
      String(row.lease_payload_sha256).trim() !== watchLeaseRef.canonical_payload_sha256 ||
      String(row.session_ref_id) !== sessionRef.ref_id || !sameJson(row.realtime_session_ref, sessionRef) ||
      String(row.device_id) !== receipt.watch.deviceId || row.revoked_at !== null) {
    fail("APPLE_PHYSICAL_CANARY_WATCH_LEASE_DRIFT");
  }
  if (bindingState === "revoked") {
    if (row.state !== "released" || row.released_at === null || row.released_at === undefined) {
      fail("APPLE_PHYSICAL_CANARY_REVOKE_STATE_DRIFT");
    }
    return;
  }
  if (row.state !== "active" || row.released_at !== null) fail("APPLE_PHYSICAL_CANARY_REVOKE_STATE_DRIFT");
  const result = await client.query([
    "UPDATE device_leases SET state = 'released', released_at = transaction_timestamp(),",
    "updated_at = transaction_timestamp() WHERE lease_ref_id = $1 AND state = 'active'",
    "AND session_ref_id = $2 AND device_id = $3 AND lease_payload_sha256 = $4",
  ].join(" "), [watchLeaseRef.ref_id, sessionRef.ref_id, receipt.watch.deviceId,
    watchLeaseRef.canonical_payload_sha256]);
  if (result.rowCount !== 1) fail("APPLE_PHYSICAL_CANARY_REVOKE_CONFLICT");
}

async function selectByRequest(
  client: PoolClient,
  requestId: string,
  idempotencyKey: string,
): Promise<QueryResultRow | undefined> {
  const rows = (await client.query(
    "SELECT * FROM apple_physical_canary_bindings WHERE request_id = $1 OR idempotency_key = $2 FOR UPDATE",
    [requestId, idempotencyKey],
  )).rows;
  if (rows.length > 1) fail("APPLE_PHYSICAL_CANARY_IDEMPOTENCY_CONFLICT");
  return rows[0];
}

async function verifyActiveStoredRow(
  client: PoolClient,
  row: QueryResultRow,
  expectedFingerprint?: string,
  expectedNow?: string,
): Promise<ApplePhysicalCanaryBindingReceipt> {
  const receipt = rowReceipt(row);
  if (row.state !== "active") fail("APPLE_PHYSICAL_CANARY_BINDING_REVOKED");
  if (expectedFingerprint !== undefined && receipt.requestFingerprintSha256 !== expectedFingerprint) {
    fail("APPLE_PHYSICAL_CANARY_IDEMPOTENCY_CONFLICT");
  }
  if (expectedNow !== undefined && Date.parse(expectedNow) >= Date.parse(receipt.expiresAt)) {
    fail("APPLE_PHYSICAL_CANARY_BINDING_EXPIRED");
  }
  const snapshot = await primaryAuthoritySnapshot(
    client,
    receipt.realtimeSessionRef as unknown as SnakeRef,
    receipt.iphone.deviceLeaseRef as unknown as SnakeRef,
    false,
  );
  assertAuthorityLifetime(snapshot, receipt.expiresAt);
  if (snapshot.iphoneDeviceId !== receipt.iphone.deviceId || receipt.watch.deviceId === receipt.iphone.deviceId) {
    fail("APPLE_PHYSICAL_CANARY_STORED_BINDING_DRIFT");
  }
  await readWatchLease(client, receipt, snapshot, false);
  return receipt;
}

function identityValue(
  identity: RealtimeIdentityPort,
  deviceId: string,
  requestId: string,
): string {
  try {
    return uuidV7(identity.createConnectionId({ deviceId, requestId }),
      "APPLE_PHYSICAL_CANARY_IDENTITY_ISSUER_INVALID");
  } catch (error) {
    if (error instanceof ApplePhysicalCanaryBindingPostgresError) throw error;
    fail("APPLE_PHYSICAL_CANARY_IDENTITY_ISSUER_FAILED", error);
  }
}

function watchLeaseRefValue(
  identity: RealtimeIdentityPort,
  sessionRef: SnakeRef,
  watchDeviceId: string,
  requestId: string,
): SnakeRef {
  try {
    const value = identity.createDeviceLeaseRef({
      sessionRef: sessionRef as unknown as OpaqueCanonicalRef,
      deviceId: watchDeviceId,
      requestId,
    });
    return canonicalRef(value, "DeviceLease", identity, "APPLE_PHYSICAL_CANARY_WATCH_LEASE_ISSUER_INVALID");
  } catch (error) {
    if (error instanceof ApplePhysicalCanaryBindingPostgresError) throw error;
    fail("APPLE_PHYSICAL_CANARY_WATCH_LEASE_ISSUER_FAILED", error);
  }
}

function canonicalWatchDeviceId(
  issuer: RealtimeCanonicalDeviceIdentityIssuerPort,
  input: NormalizedIssueInput,
  authority: AuthoritySnapshot,
  fingerprint: string,
): string {
  const issueInput = Object.freeze({
    rawDeviceId: input.watchCoreDeviceId,
    sessionId: input.realtimeSessionRef.ref_id,
    clientInstanceId: input.watchLocalClientInstanceId,
    eligibilityObservedAt: authority.observedAt,
    requestId: `apple-physical-canary-watch-device:${fingerprint}`,
  });
  try {
    const receipt = assertRealtimeCanonicalDeviceIdentityReceipt(issuer.issue(issueInput), issueInput);
    return uuidV7(receipt.canonicalDeviceId, "APPLE_PHYSICAL_CANARY_CANONICAL_DEVICE_ISSUER_INVALID");
  } catch {
    fail("APPLE_PHYSICAL_CANARY_CANONICAL_DEVICE_ISSUER_FAILED");
  }
}

function insertValues(receipt: ApplePhysicalCanaryBindingReceipt): unknown[] {
  const session = receipt.realtimeSessionRef as unknown as SnakeRef;
  const iphoneLease = receipt.iphone.deviceLeaseRef as unknown as SnakeRef;
  const watchLease = receipt.watch.deviceLeaseRef as unknown as SnakeRef;
  return [
    receipt.bindingId, receipt.requestId, receipt.idempotencyKey, receipt.requestFingerprintSha256,
    JSON.stringify(session), session.ref_id, session.object_version, session.canonical_payload_sha256,
    JSON.stringify(iphoneLease), iphoneLease.ref_id, iphoneLease.object_version, iphoneLease.canonical_payload_sha256,
    receipt.iphone.deviceId, receipt.iphone.clientInstanceId,
    JSON.stringify(watchLease), watchLease.ref_id, watchLease.object_version, watchLease.canonical_payload_sha256,
    receipt.watch.deviceId, receipt.watch.clientInstanceId, receipt.issuedAt, receipt.expiresAt,
    receipt.objectVersion, canonicalJson(receipt), receipt.canonicalPayloadSha256,
  ];
}

async function insertReceipt(client: PoolClient, receipt: ApplePhysicalCanaryBindingReceipt): Promise<QueryResultRow> {
  const result = await client.query([
    "INSERT INTO apple_physical_canary_bindings (",
    "binding_id, request_id, idempotency_key, request_fingerprint_sha256, realtime_session_ref, session_ref_id,",
    "session_object_version, session_payload_sha256, iphone_device_lease_ref, iphone_lease_ref_id,",
    "iphone_lease_object_version, iphone_lease_payload_sha256, iphone_device_id, iphone_client_instance_id,",
    "watch_device_lease_ref, watch_lease_ref_id, watch_lease_object_version, watch_lease_payload_sha256,",
    "watch_device_id, watch_client_instance_id, issued_at, expires_at, object_version, receipt_jcs,",
    "canonical_payload_sha256, state, companion_source, user_id, watch_installation_id, pair_version, principal_ref) VALUES (",
    "$1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,",
    "$21::timestamptz,$22::timestamptz,$23,$24,$25,'active',$26,$27,$28,$29,$30::jsonb) RETURNING *",
   ].join(" "), [...insertValues(receipt),
    receipt.kind === FORMAL_KIND ? "apple_watch_binding_v1" : "apple_physical_canary_binding_v1",
    receipt.userId ?? null, receipt.installationId ?? null, receipt.pairVersion ?? null,
    receipt.principalRef === undefined ? null : JSON.stringify(receipt.principalRef)]);
  if (result.rows.length !== 1 || result.rowCount !== 1) fail("APPLE_PHYSICAL_CANARY_INSERT_INVALID");
  return result.rows[0]!;
}

function isConcurrentInsertConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "23505" || code === "40001";
}

function normalizeRevokeInput(value: ApplePhysicalCanaryBindingRevokeInput): ApplePhysicalCanaryBindingRevokeInput {
  const record = exactRecord(value, ["bindingId", "requestId", "idempotencyKey", "canonicalPayloadSha256"],
    "APPLE_PHYSICAL_CANARY_REVOKE_INPUT_INVALID");
  return deepFreeze({
    bindingId: uuidV7(record.bindingId, "APPLE_PHYSICAL_CANARY_REVOKE_INPUT_INVALID"),
    requestId: boundedText(record.requestId, "APPLE_PHYSICAL_CANARY_REVOKE_INPUT_INVALID"),
    idempotencyKey: boundedText(record.idempotencyKey, "APPLE_PHYSICAL_CANARY_REVOKE_INPUT_INVALID"),
    canonicalPayloadSha256: hash(record.canonicalPayloadSha256, "APPLE_PHYSICAL_CANARY_REVOKE_INPUT_INVALID"),
  });
}

interface NormalizedActiveReadInput {
  readonly realtimeSessionRef: SnakeRef;
  readonly iphoneDeviceLeaseRef: SnakeRef;
  readonly now?: string;
}

interface NormalizedRefreshInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly realtimeSessionRef: SnakeRef;
  readonly iphoneDeviceLeaseRef: SnakeRef;
  readonly ttlSeconds: number;
  readonly expectedLeaseVersion?: string;
  readonly expectedFencingToken?: string;
}

function normalizeActiveReadInput(
  value: ApplePhysicalCanaryBindingActiveReadInput,
  identity: RealtimeIdentityPort,
): NormalizedActiveReadInput {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
    fail("APPLE_PHYSICAL_CANARY_ACTIVE_READ_INPUT_INVALID");
  }
  const actual = Object.keys(value).sort();
  const required = ["iphoneDeviceLeaseRef", "realtimeSessionRef"];
  const withNow = [...required, "now"].sort();
  if ((actual.length !== required.length && actual.length !== withNow.length) ||
      !actual.every((key, index) => key === (actual.length === required.length ? required : withNow).sort()[index])) {
    fail("APPLE_PHYSICAL_CANARY_ACTIVE_READ_INPUT_INVALID");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) {
      fail("APPLE_PHYSICAL_CANARY_ACTIVE_READ_INPUT_INVALID");
    }
  }
  const record = value as unknown as Record<string, unknown>;
  return deepFreeze({
    realtimeSessionRef: canonicalRef(record.realtimeSessionRef, "RealtimeSession", identity,
      "APPLE_PHYSICAL_CANARY_ACTIVE_SESSION_REF_INVALID"),
    iphoneDeviceLeaseRef: canonicalRef(record.iphoneDeviceLeaseRef, "DeviceLease", identity,
      "APPLE_PHYSICAL_CANARY_ACTIVE_IPHONE_LEASE_REF_INVALID"),
    ...(Object.hasOwn(record, "now")
      ? { now: timestamp(record.now, "APPLE_PHYSICAL_CANARY_ACTIVE_READ_TIME_INVALID") }
      : {}),
  });
}

function normalizeRefreshInput(
  value: ApplePhysicalCanaryBindingRefreshInput,
  identity: RealtimeIdentityPort,
): NormalizedRefreshInput {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
    fail("APPLE_PHYSICAL_CANARY_REFRESH_INPUT_INVALID");
  }
  const actual = Object.keys(value).sort();
  const required = ["idempotencyKey", "iphoneDeviceLeaseRef", "requestId", "realtimeSessionRef", "ttlSeconds"];
  const optional = ["expectedFencingToken", "expectedLeaseVersion"];
  if (required.some((key) => !actual.includes(key)) ||
      actual.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail("APPLE_PHYSICAL_CANARY_REFRESH_INPUT_INVALID");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) {
      fail("APPLE_PHYSICAL_CANARY_REFRESH_INPUT_INVALID");
    }
  }
  const record = value as unknown as Record<string, unknown>;
  const expectedLeaseVersion = Object.hasOwn(record, "expectedLeaseVersion")
    ? boundedText(record.expectedLeaseVersion, "APPLE_PHYSICAL_CANARY_REFRESH_EXPECTED_FENCE_INVALID")
    : undefined;
  const expectedFencingToken = Object.hasOwn(record, "expectedFencingToken")
    ? boundedText(record.expectedFencingToken, "APPLE_PHYSICAL_CANARY_REFRESH_EXPECTED_FENCE_INVALID")
    : undefined;
  if ((expectedLeaseVersion !== undefined && !POSITIVE_DECIMAL.test(expectedLeaseVersion)) ||
      (expectedFencingToken !== undefined && !POSITIVE_DECIMAL.test(expectedFencingToken))) {
    fail("APPLE_PHYSICAL_CANARY_REFRESH_EXPECTED_FENCE_INVALID");
  }
  return deepFreeze({
    requestId: boundedText(record.requestId, "APPLE_PHYSICAL_CANARY_REFRESH_REQUEST_INVALID"),
    idempotencyKey: boundedText(record.idempotencyKey, "APPLE_PHYSICAL_CANARY_REFRESH_IDEMPOTENCY_INVALID"),
    realtimeSessionRef: canonicalRef(record.realtimeSessionRef, "RealtimeSession", identity,
      "APPLE_PHYSICAL_CANARY_REFRESH_SESSION_REF_INVALID"),
    iphoneDeviceLeaseRef: canonicalRef(record.iphoneDeviceLeaseRef, "DeviceLease", identity,
      "APPLE_PHYSICAL_CANARY_REFRESH_IPHONE_LEASE_REF_INVALID"),
    ttlSeconds: ttlSeconds(record.ttlSeconds),
    ...(expectedLeaseVersion === undefined ? {} : { expectedLeaseVersion }),
    ...(expectedFencingToken === undefined ? {} : { expectedFencingToken }),
  });
}

function incrementDecimal(value: unknown, code: string): string {
  const text = typeof value === "string" ? value : String(value);
  if (!POSITIVE_DECIMAL.test(text)) fail(code);
  const digits = text.split("").map((digit) => Number(digit));
  let carry = 1;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const next = digits[index]! + carry;
    digits[index] = next % 10;
    carry = next >= 10 ? 1 : 0;
    if (carry === 0) break;
  }
  if (carry !== 0) digits.unshift(carry);
  const result = digits.join("");
  if (!POSITIVE_DECIMAL.test(result)) fail(code);
  return result;
}

function refreshRequestFingerprint(input: NormalizedRefreshInput): string {
  return sha256Domain("paios.t02.apple-physical-canary-binding.refresh.request.v1", canonicalJson({
    idempotencyKey: input.idempotencyKey,
    iphoneDeviceLeaseRef: input.iphoneDeviceLeaseRef,
    realtimeSessionRef: input.realtimeSessionRef,
    requestId: input.requestId,
    ttlSeconds: input.ttlSeconds,
    ...(input.expectedLeaseVersion === undefined ? {} : { expectedLeaseVersion: input.expectedLeaseVersion }),
    ...(input.expectedFencingToken === undefined ? {} : { expectedFencingToken: input.expectedFencingToken }),
  }));
}

function normalizeFormalInput(value: AppleFormalWatchMutationInput, identity: RealtimeIdentityPort) {
  const action = value.action;
  if (action !== "register" && action !== "replace" && action !== "revoke") fail("APPLE_FORMAL_WATCH_ACTION_INVALID");
  const record = exactRecord(value, ["action", "requestId", "idempotencyKey", "realtimeSessionRef", "iphoneDeviceLeaseRef", "expectedPairVersion",
    ...(action === "revoke" ? [] : ["installationId", "ttlSeconds"])], "APPLE_FORMAL_WATCH_INPUT_INVALID");
  const version = boundedText(record.expectedPairVersion, "APPLE_FORMAL_WATCH_PAIR_VERSION_INVALID");
  if (version !== "0" && !POSITIVE_DECIMAL.test(version)) fail("APPLE_FORMAL_WATCH_PAIR_VERSION_INVALID");
  return deepFreeze({ action, requestId: boundedText(record.requestId, "APPLE_FORMAL_WATCH_INPUT_INVALID"),
    idempotencyKey: boundedText(record.idempotencyKey, "APPLE_FORMAL_WATCH_INPUT_INVALID"), expectedPairVersion: version,
    realtimeSessionRef: canonicalRef(record.realtimeSessionRef, "RealtimeSession", identity, "APPLE_FORMAL_WATCH_SESSION_INVALID"),
    iphoneDeviceLeaseRef: canonicalRef(record.iphoneDeviceLeaseRef, "DeviceLease", identity, "APPLE_FORMAL_WATCH_LEASE_INVALID"),
    ...(action === "revoke" ? {} : { installationId: rawUuid(record.installationId, "APPLE_FORMAL_WATCH_INSTALLATION_INVALID"), ttlSeconds: ttlSeconds(record.ttlSeconds) }),
  });
}

function makeFormalReceipt(body: Omit<AppleFormalWatchBindingReceipt, "canonicalPayloadSha256">): AppleFormalWatchBindingReceipt {
  const { canonicalPayloadSha256: _previous, ...clean } = body as AppleFormalWatchBindingReceipt;
  const canonicalPayloadSha256 = sha256Domain("paios.t02.apple-watch-binding.receipt.v1", canonicalJson(clean));
  return validateReceipt({ ...clean, canonicalPayloadSha256 }) as AppleFormalWatchBindingReceipt;
}

function validateFactoryOptions(value: ApplePhysicalCanaryBindingPostgresOptions): ApplePhysicalCanaryBindingPostgresOptions {
  const record = exactRecord(value, ["pool", "identity", "canonicalDeviceIssuer", ...(Object.hasOwn(value, "formalPrimaryAuthority") ? ["formalPrimaryAuthority"] : [])],
    "APPLE_PHYSICAL_CANARY_OPTIONS_INVALID");
  if (typeof record.pool !== "object" || record.pool === null ||
      typeof (record.pool as { readonly connect?: unknown }).connect !== "function" ||
      typeof record.identity !== "object" || record.identity === null ||
      typeof record.canonicalDeviceIssuer !== "object" || record.canonicalDeviceIssuer === null ||
      typeof (record.canonicalDeviceIssuer as { readonly issue?: unknown }).issue !== "function") {
    fail("APPLE_PHYSICAL_CANARY_OPTIONS_INVALID");
  }
  const identity = record.identity as Partial<RealtimeIdentityPort>;
  if (typeof identity.assertRepositoryIssuedRef !== "function" || typeof identity.createConnectionId !== "function" ||
      typeof identity.createDeviceLeaseRef !== "function") {
    fail("APPLE_PHYSICAL_CANARY_OPTIONS_INVALID");
  }
  if (record.formalPrimaryAuthority !== undefined && (!isPlainRecord(record.formalPrimaryAuthority) ||
      typeof record.formalPrimaryAuthority.resolve !== "function")) fail("APPLE_FORMAL_WATCH_AUTHORITY_PORT_INVALID");
  return {
    ...(record.formalPrimaryAuthority === undefined ? {} : { formalPrimaryAuthority: record.formalPrimaryAuthority as NonNullable<ApplePhysicalCanaryBindingPostgresOptions["formalPrimaryAuthority"]> }),
    pool: record.pool as Pool,
    identity: record.identity as RealtimeIdentityPort,
    canonicalDeviceIssuer: record.canonicalDeviceIssuer as RealtimeCanonicalDeviceIdentityIssuerPort,
  };
}

export function createApplePhysicalCanaryBindingPostgres(
  rawOptions: ApplePhysicalCanaryBindingPostgresOptions,
): AppleCompanionBindingPostgresPort {
  const { pool, identity, canonicalDeviceIssuer, formalPrimaryAuthority } = validateFactoryOptions(rawOptions);

  async function formalAuthority(authenticatedBearer: unknown, client?: PoolClient) {
    if (formalPrimaryAuthority === undefined) fail("APPLE_FORMAL_WATCH_AUTHORITY_PORT_REQUIRED");
    const authenticated = await formalPrimaryAuthority.resolve(authenticatedBearer,client);
    const auth = exactRecord(authenticated, ["userId", "deviceId", "principalRef", "expiresAt", "purpose", "policyDecisionRef", "capabilities"], "APPLE_FORMAL_WATCH_AUTHORITY_INVALID");
    const userId = uuidV7(auth.userId, "APPLE_FORMAL_WATCH_AUTHORITY_INVALID");
    const deviceId = uuidV7(auth.deviceId, "APPLE_FORMAL_WATCH_AUTHORITY_INVALID");
    const authExpiresAt = timestamp(auth.expiresAt, "APPLE_FORMAL_WATCH_AUTHORITY_INVALID");
    const principalRef = cloneJson(auth.principalRef);
    if (principalRef === null || principalRef === undefined) fail("APPLE_FORMAL_WATCH_AUTHORITY_INVALID");
    return { auth, userId, deviceId, authExpiresAt, principalRef };
  }

  async function assertFormalOwner(client: PoolClient, input: NormalizedActiveReadInput, authority: Awaited<ReturnType<typeof formalAuthority>>, lock: boolean) {
    const { userId, deviceId, authExpiresAt } = authority;
    const ownerRows = (await client.query("SELECT s.user_id, il.device_id, il.realtime_session_ref, il.device_lease_ref, transaction_timestamp() AS observed_at FROM realtime_sessions s JOIN device_leases il ON il.lease_ref_id = $2 WHERE s.session_ref_id = $1 AND il.session_ref_id = s.session_ref_id" + (lock ? " FOR UPDATE OF s, il" : ""),
      [input.realtimeSessionRef.ref_id, input.iphoneDeviceLeaseRef.ref_id])).rows;
    if (ownerRows.length !== 1 || String(ownerRows[0]!.user_id) !== userId || String(ownerRows[0]!.device_id) !== deviceId ||
        !sameJson(ownerRows[0]!.realtime_session_ref, input.realtimeSessionRef) || !sameJson(ownerRows[0]!.device_lease_ref, input.iphoneDeviceLeaseRef) ||
        Date.parse(authExpiresAt) <= Date.parse(rowTimestamp(ownerRows[0]!, "observed_at"))) fail("APPLE_FORMAL_WATCH_AUTHORITY_MISMATCH");
  }

  function assertFormalPolicy(authority: AuthoritySnapshot, auth: JsonRecord) {
    if (authority.purpose !== auth.purpose || !sameJson(authority.policyDecisionRef, auth.policyDecisionRef) ||
        !sameJson(authority.capabilities, auth.capabilities)) fail("APPLE_FORMAL_WATCH_AUTHORITY_POLICY_MISMATCH");
  }

  function assertRefreshResultBinding(
    result: ApplePhysicalCanaryBindingRefreshResult,
    input: NormalizedRefreshInput,
  ): void {
    if (!sameJson(result.binding.realtimeSessionRef, input.realtimeSessionRef) ||
        !sameJson(result.binding.iphone.deviceLeaseRef, input.iphoneDeviceLeaseRef)) {
      fail("APPLE_PHYSICAL_CANARY_REFRESH_IDEMPOTENCY_CONFLICT");
    }
  }

  async function replayAfterUnique(
    input: NormalizedIssueInput,
    fingerprint: string,
  ): Promise<ApplePhysicalCanaryBindingReceipt> {
    return withTransaction(pool, async (client) => {
      const row = await selectByRequest(client, input.requestId, input.idempotencyKey);
      if (row === undefined || String(row.request_id) !== input.requestId ||
          String(row.idempotency_key) !== input.idempotencyKey) fail("APPLE_PHYSICAL_CANARY_IDEMPOTENCY_CONFLICT");
      return verifyActiveStoredRow(client, row, fingerprint);
    }, { isolation: "SERIALIZABLE" });
  }

  const credentialFail = (reason: string, status: number): never => { throw new AppleWatchCredentialError(reason, status); };
  async function credentialParent(client: PoolClient, binding: AppleFormalWatchBindingReceipt) {
    const parent = (await client.query("SELECT governance, media FROM paired_devices WHERE device_id=$1 AND user_id=$2 AND device_class='iphone' AND status='active' FOR SHARE", [binding.iphone.deviceId, binding.userId])).rows[0];
    if (!parent || !parent.media.includes('audio') || !parent.media.includes('data')) credentialFail('watch_scope_denied',403);
    try {
      const primary=await primaryAuthoritySnapshot(client,binding.realtimeSessionRef as SnakeRef,binding.iphone.deviceLeaseRef as SnakeRef,false);
      if(!sameJson(parent.governance.policy_decision_refs?.[0],primary.policyDecisionRef))credentialFail('watch_scope_denied',403);
      return {...parent,continuityId:primary.continuityId};
    } catch(error){if(error instanceof ApplePhysicalCanaryBindingPostgresError)credentialFail('watch_unregistered',403);throw error;}
  }
  async function resolveCredential(token: string, client: PoolClient): Promise<AppleWatchCredentialResolution> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) credentialFail('credential_invalid',401);
    const rows=(await client.query("SELECT * FROM apple_physical_canary_bindings WHERE watch_token_sha256=$1 AND companion_source='apple_watch_binding_v1' FOR SHARE",[createHash('sha256').update(token).digest('hex')])).rows;
    const row=rows[0];
    if (!row) credentialFail('credential_invalid',401);
    if (row.state!=='active'||row.watch_token_revoked) credentialFail('credential_revoked',403);
    if (Date.parse(rowTimestamp(row,'watch_token_expires_at'))<=Date.now()) credentialFail('credential_expired',401);
    const binding=rowReceipt(row) as AppleFormalWatchBindingReceipt;
    const parent=await credentialParent(client,binding);
    try { await verifyActiveStoredRow(client,row); }
    catch(error) { if(error instanceof ApplePhysicalCanaryBindingPostgresError) credentialFail('watch_unregistered',403);throw error; }
    return {binding,governance:cloneJson(parent.governance) as Record<string,unknown>,expiresAt:rowTimestamp(row,'watch_token_expires_at'),continuityId:parent.continuityId};
  }

  return Object.freeze({
    async readWatchInAdmission(client:PoolClient,userId:string,parentDeviceId:string,watchDeviceId:string){
      if(!isManagedTransactionClient(client))credentialFail('service_unavailable',503);
      const rows=(await client.query("SELECT * FROM apple_physical_canary_bindings WHERE user_id=$1 AND iphone_device_id=$2 AND watch_device_id=$3 AND companion_source='apple_watch_binding_v1' AND state='active' FOR SHARE",[userId,parentDeviceId,watchDeviceId])).rows;
      if(rows.length!==1)credentialFail('watch_unregistered',403);
      const binding=await verifyActiveStoredRow(client,rows[0]) as AppleFormalWatchBindingReceipt;
      await credentialParent(client,binding);return binding;
    },
    withWatchAdmission<T>(userId:string,parentDeviceId:string,watchDeviceId:string,consume:(binding:AppleFormalWatchBindingReceipt)=>Promise<T>){
      return withTransaction(pool,async client=>consume(await this.readWatchInAdmission(client,userId,parentDeviceId,watchDeviceId)));
    },
    resolveCredential: (token: string, client?: PoolClient) => client ? resolveCredential(token,client) : withTransaction(pool,c=>resolveCredential(token,c)),
    withCredentialAdmission: <T>(token:string,consume:(resolved:AppleWatchCredentialResolution,client:PoolClient)=>Promise<T>) =>
      withTransaction(pool,async client=>consume(await resolveCredential(token,client),client)),
    async credential(input: AppleWatchCredentialInput, bearer: unknown) {
      if (!input || Object.keys(input).sort().join(',')!=='action,expectedPairVersion,installationId,requestId,watchDeviceId' ||
          !['issue','refresh','revoke'].includes(input.action) || !UUID.test(input.requestId) || !UUID.test(input.watchDeviceId) ||
          !UUID.test(input.installationId) || typeof input.expectedPairVersion!=='string' || !POSITIVE_DECIMAL.test(input.expectedPairVersion)) credentialFail('invalid_request',400);
      const authenticated=await formalAuthority(bearer);
      const hash=sha256Canonical({...input,userId:authenticated.userId,deviceId:authenticated.deviceId,principalRef:authenticated.principalRef});
      return withTransaction(pool,async client=>{
        const current=await formalAuthority(bearer,client);
        const authorityFacts=(value:typeof current)=>[value.userId,value.deviceId,value.principalRef,value.auth.purpose,value.auth.policyDecisionRef,value.auth.capabilities];
        if(!sameJson(authorityFacts(current),authorityFacts(authenticated)))credentialFail('watch_scope_denied',403);
        const rows=(await client.query("SELECT * FROM apple_physical_canary_bindings WHERE user_id=$1 AND iphone_device_id=$2 AND companion_source='apple_watch_binding_v1' ORDER BY pair_version::numeric DESC FOR UPDATE",[authenticated.userId,authenticated.deviceId])).rows;
        if (!rows[0]) credentialFail('watch_unregistered',403);
        const binding=rowReceipt(rows[0]) as AppleFormalWatchBindingReceipt;
        await credentialParent(client,binding);
        const key={scope:'apple.watch.credential',idempotencyKey:authenticated.userId+':'+input.requestId,requestHash:hash};
        let claim;
        try {claim=await claimIdempotency(client,key);} catch(error){if(error instanceof IdempotencyConflictError)credentialFail('request_conflict',409);throw error;}
        const replay=claim.kind==='replay'||claim.kind==='terminal'?claim.record.response as Record<string,unknown>:undefined;
        if(replay&&(input.action==='revoke'||replay.status!=='credential'))return replay;
        if(!replay&&claim.kind!=='new')credentialFail('request_conflict',409);
        let failure=binding.pairVersion!==input.expectedPairVersion?'pair_version_conflict':binding.status!=='active'?'watch_unregistered':
          !sameJson(binding.principalRef,authenticated.principalRef)||binding.watch.deviceId!==input.watchDeviceId||binding.installationId!==input.installationId?'watch_scope_denied':undefined;
        if(!failure){try {await verifyActiveStoredRow(client,rows[0]);} catch(error){if(error instanceof ApplePhysicalCanaryBindingPostgresError)failure='watch_unregistered';else throw error;}}
        if(failure){
          const response={status:'failed',reason:failure};
          if(!replay)await completeIdempotency(client,key,response,sha256Canonical(response));return response;
        }
        const base={watch_device_id:binding.watch.deviceId,installation_id:binding.installationId,pair_version:binding.pairVersion};
        const token=input.action==='revoke'?null:randomBytes(32).toString('base64url');
        const expiresAt=replay?String(replay.expires_at):new Date(Math.min(Date.now()+7*86400000,Date.parse(binding.expiresAt))).toISOString();
        const outcome=token ? {status:'credential',...base,expires_at:expiresAt} : {status:'revoked',...base};
        await client.query("UPDATE apple_physical_canary_bindings SET watch_token_sha256=CASE WHEN $4 THEN watch_token_sha256 ELSE $2 END,watch_token_expires_at=CASE WHEN $4 THEN watch_token_expires_at ELSE $3 END,watch_token_revoked=$4 WHERE binding_id=$1",[binding.bindingId,token?createHash('sha256').update(token).digest('hex'):null,token?expiresAt:null,input.action==='revoke']);
        if(!replay)await completeIdempotency(client,key,outcome,sha256Canonical(outcome));
        return token?{...outcome,token}:outcome;
      });
    },
    async readFormalPairStateInTransaction(client: PoolClient, rawInput: ApplePhysicalCanaryBindingActiveReadInput, expectedPrincipalRef?: unknown): Promise<AppleFormalWatchPairState> {
      if (!isManagedTransactionClient(client)) fail("APPLE_FORMAL_WATCH_TRANSACTION_REQUIRED");
      const input = normalizeActiveReadInput(rawInput, identity);
      const authority = await primaryAuthoritySnapshot(client, input.realtimeSessionRef, input.iphoneDeviceLeaseRef, false);
      assertPrimaryUsable(authority);
      const rows = (await client.query("SELECT * FROM apple_physical_canary_bindings WHERE user_id=$1 AND iphone_device_id=$2 AND companion_source='apple_watch_binding_v1' ORDER BY pair_version::numeric DESC LIMIT 1", [authority.userId, authority.iphoneDeviceId])).rows;
      if (rows.length === 0) return Object.freeze({ pairVersion: "0", status: "absent", requiresRebind: false });
      const receipt = rowReceipt(rows[0]!) as AppleFormalWatchBindingReceipt;
      let requiresRebind = receipt.status !== "active" || !sameJson(receipt.realtimeSessionRef, input.realtimeSessionRef) ||
        !sameJson(receipt.iphone.deviceLeaseRef, input.iphoneDeviceLeaseRef) || Date.parse(receipt.expiresAt) <= Date.parse(authority.observedAt) ||
        (expectedPrincipalRef !== undefined && !sameJson(receipt.principalRef, expectedPrincipalRef));
      if (!requiresRebind) {
        try { await readWatchLease(client, receipt, authority, false); }
        catch (error) {
          if (!(error instanceof ApplePhysicalCanaryBindingPostgresError) ||
              !["APPLE_PHYSICAL_CANARY_WATCH_LEASE_DRIFT", "APPLE_PHYSICAL_CANARY_WATCH_LEASE_MISSING"].includes(error.code)) throw error;
          requiresRebind = true;
        }
      }
      return Object.freeze({ pairVersion: receipt.pairVersion, status: receipt.status, requiresRebind });
    },

    async readFormalByPrimaryInTransaction(client: PoolClient, rawInput: ApplePhysicalCanaryBindingActiveReadInput) {
      if (!isManagedTransactionClient(client)) fail("APPLE_FORMAL_WATCH_TRANSACTION_REQUIRED");
      const input = normalizeActiveReadInput(rawInput, identity);
      const rows = (await client.query(
        "SELECT * FROM apple_physical_canary_bindings WHERE session_ref_id = $1 AND iphone_lease_ref_id = $2 AND companion_source = 'apple_watch_binding_v1' AND state = 'active' AND expires_at > transaction_timestamp()",
        [input.realtimeSessionRef.ref_id, input.iphoneDeviceLeaseRef.ref_id],
      )).rows;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) fail("APPLE_FORMAL_WATCH_ACTIVE_CONFLICT");
      return await verifyActiveStoredRow(client, rows[0]!, undefined, input.now) as AppleFormalWatchBindingReceipt;
    },

    async readFormal(rawInput: ApplePhysicalCanaryBindingActiveReadInput, authenticatedBearer: unknown) {
      const input = normalizeActiveReadInput(rawInput, identity);
      return withTransaction(pool, async client => {
        const authenticated = await formalAuthority(authenticatedBearer, client);
        // Match mutation/admission lock order: the binding precedes its parent session.
        const rows = (await client.query("SELECT * FROM apple_physical_canary_bindings WHERE user_id=$1 AND iphone_device_id=$2 AND companion_source='apple_watch_binding_v1' ORDER BY pair_version::numeric DESC FOR UPDATE",
          [authenticated.userId, authenticated.deviceId])).rows;
        await assertFormalOwner(client, input, authenticated, true);
        const authority = await primaryAuthoritySnapshot(client, input.realtimeSessionRef, input.iphoneDeviceLeaseRef, true);
        assertPrimaryUsable(authority);
        assertFormalPolicy(authority, authenticated.auth);
        const current = rows[0] === undefined ? undefined : rowReceipt(rows[0]) as AppleFormalWatchBindingReceipt;
        // The authenticated phone may renew the same pairing, including after a background gap.
        // An expired receipt by itself grants no authority and cannot select a new parent or identity.
        if (current?.status === "active" && sameJson(current.principalRef, authenticated.principalRef) &&
            sameJson(current.realtimeSessionRef, input.realtimeSessionRef) &&
            sameJson(current.iphone.deviceLeaseRef, input.iphoneDeviceLeaseRef) &&
            Date.parse(current.expiresAt) - Date.parse(authority.observedAt) <= 120_000) {
          const expiresAt = new Date(Math.min(Date.parse(refreshExpiresAt(authority, 600)),
            Date.parse(authenticated.authExpiresAt))).toISOString();
          if (Date.parse(expiresAt) > Date.parse(current.expiresAt)) {
            let watchLease: QueryResultRow | undefined;
            try { watchLease = await readWatchLease(client, current, authority, true); }
            catch (error) {
              if (!(error instanceof ApplePhysicalCanaryBindingPostgresError) ||
                  !["APPLE_PHYSICAL_CANARY_WATCH_LEASE_DRIFT", "APPLE_PHYSICAL_CANARY_WATCH_LEASE_MISSING"].includes(error.code)) throw error;
            }
            if (watchLease !== undefined) {
              const renewed = makeFormalReceipt({ ...current, expiresAt });
              await updateRefreshedWatchLease(client, watchLease, renewed, authority, expiresAt);
              await updateRefreshedBinding(client, rows[0]!, renewed);
            }
          }
        }
        const pairState = await this.readFormalPairStateInTransaction(client, input, authenticated.principalRef);
        const binding = pairState.requiresRebind ? undefined : await this.readFormalByPrimaryInTransaction(client, input);
        return { pairState, binding };
      });
    },

    async mutateFormal(rawInput: AppleFormalWatchMutationInput, authenticatedBearer: unknown) {
      const input = normalizeFormalInput(rawInput, identity);
      const authenticated = await formalAuthority(authenticatedBearer);
      const { auth, userId, deviceId, authExpiresAt, principalRef } = authenticated;
      const requestHash = sha256Canonical({ operation: "watch_binding", ...input, userId, deviceId, principalRef });
      return withTransaction(pool, async (client) => {
        // Binding first: HTTPS admission holds this row while its existing admission owner may lock the session.
        // Revoke/replace must not hold that session while waiting for an admitted Watch request.
        await client.query("SELECT binding_id FROM apple_physical_canary_bindings WHERE user_id=$1 AND iphone_device_id=$2 AND companion_source='apple_watch_binding_v1' FOR UPDATE",[userId,deviceId]);
        // Historical receipt reads retain original ownership even after the primary lease rotates.
        await assertFormalOwner(client, input, authenticated, true);
        const claimed = await claimIdempotency(client, { scope: FORMAL_SCOPE, idempotencyKey: input.idempotencyKey, requestHash });
        if (claimed.kind === "replay" || claimed.kind === "terminal") {
          const result = validateReceipt(claimed.record.response);
          if (result.kind !== FORMAL_KIND || claimed.record.responseHash !== sha256Canonical(result)) {
            fail("APPLE_FORMAL_WATCH_REPLAY_DRIFT");
          }
          return result as AppleFormalWatchBindingReceipt;
        }
        if (claimed.kind !== "new") fail("APPLE_FORMAL_WATCH_IN_FLIGHT");
        const authority = await primaryAuthoritySnapshot(client, input.realtimeSessionRef, input.iphoneDeviceLeaseRef, true);
        assertPrimaryUsable(authority);
        assertFormalPolicy(authority, auth);
        const rows = (await client.query(
          "SELECT * FROM apple_physical_canary_bindings WHERE user_id = $1 AND iphone_device_id = $2 AND companion_source = 'apple_watch_binding_v1' ORDER BY pair_version::numeric DESC FOR UPDATE",
          [userId, deviceId],
        )).rows;
        const latest = rows[0];
        const current = latest === undefined ? undefined : rowReceipt(latest) as AppleFormalWatchBindingReceipt;
        if (current !== undefined && !sameJson(current.principalRef, principalRef)) fail("APPLE_FORMAL_WATCH_AUTHORITY_MISMATCH");
        if ((current?.pairVersion ?? "0") !== input.expectedPairVersion) fail("APPLE_FORMAL_WATCH_PAIR_VERSION_CONFLICT");
        if (input.action === "register" ? current?.status === "active" : current?.status !== "active") {
          fail("APPLE_FORMAL_WATCH_STATE_CONFLICT");
        }
        const nextVersion = current === undefined ? "1" : incrementDecimal(current.pairVersion, "APPLE_FORMAL_WATCH_PAIR_VERSION_INVALID");
        if (current !== undefined && current.status === "active") {
          await releaseWatchCompanionLease(client, current, "active");
          const retired = makeFormalReceipt({ ...current, status: "revoked" });
          await client.query("UPDATE apple_physical_canary_bindings SET state = 'revoked', revoked_at = transaction_timestamp(), receipt_jcs = $2, canonical_payload_sha256 = $3, updated_at = transaction_timestamp() WHERE binding_id = $1", [current.bindingId, canonicalJson(retired), retired.canonicalPayloadSha256]);
        }
        let result: AppleFormalWatchBindingReceipt;
        if (input.action === "revoke") {
          result = makeFormalReceipt({ ...current!, pairVersion: nextVersion, status: "revoked", requestId: input.requestId, idempotencyKey: input.idempotencyKey, requestFingerprintSha256: requestHash });
          await client.query("UPDATE apple_physical_canary_bindings SET pair_version = $2, receipt_jcs = $3, canonical_payload_sha256 = $4, request_id = $5, idempotency_key = $6, request_fingerprint_sha256 = $7 WHERE binding_id = $1",
            [result.bindingId, nextVersion, canonicalJson(result), result.canonicalPayloadSha256, result.requestId, result.idempotencyKey, requestHash]);
        } else {
          const expiresAt = refreshExpiresAt(authority, input.ttlSeconds!);
          if (Date.parse(expiresAt) > Date.parse(authExpiresAt)) fail("APPLE_FORMAL_WATCH_TTL_EXCEEDS_AUTHORITY");
          const watchClientInstanceId = identityValue(identity, deviceId, `apple-watch-client:${requestHash}`);
          const deviceInput = { rawDeviceId: input.installationId!, sessionId: input.realtimeSessionRef.ref_id,
            clientInstanceId: watchClientInstanceId, eligibilityObservedAt: authority.observedAt, requestId: `apple-watch-device:${requestHash}` };
          const issuedDevice = assertRealtimeCanonicalDeviceIdentityReceipt(canonicalDeviceIssuer.issue(deviceInput), deviceInput);
          const watchDeviceId = issuedDevice.canonicalDeviceId;
          const bindingId = identityValue(identity, deviceId, `apple-watch-binding:${requestHash}`);
          const iphoneClientInstanceId = identityValue(identity, deviceId, `apple-watch-primary-client:${requestHash}`);
          const watchLease = watchLeaseRefValue(identity, input.realtimeSessionRef, watchDeviceId, `apple-watch-lease:${requestHash}`);
          result = makeFormalReceipt({ bindingId, expiresAt, idempotencyKey: input.idempotencyKey,
            iphone: { deviceId, clientInstanceId: iphoneClientInstanceId, deviceLeaseRef: input.iphoneDeviceLeaseRef },
            watch: { deviceId: watchDeviceId, clientInstanceId: watchClientInstanceId, deviceLeaseRef: watchLease },
            issuedAt: authority.observedAt, kind: FORMAL_KIND, objectVersion: "1", realtimeSessionRef: input.realtimeSessionRef,
            requestFingerprintSha256: requestHash, requestId: input.requestId, pairVersion: nextVersion,
            userId, principalRef, installationId: input.installationId!, status: "active" } as Omit<AppleFormalWatchBindingReceipt, "canonicalPayloadSha256">);
          await insertWatchLease(client, result, authority);
          await insertReceipt(client, result);
        }
        await enqueueOutboxEvent(client, { eventId: randomUUID(), aggregateType: "AppleWatchBinding", aggregateId: result.bindingId,
          eventType: `apple.watch.binding.${input.action}`, eventVersion: 1, idempotencyScope: FORMAL_SCOPE,
          idempotencyKey: input.idempotencyKey, payload: { operation: "watch_binding", action: input.action, binding: result },
          payloadHash: sha256Canonical({ operation: "watch_binding", action: input.action, binding: result }) });
        await completeIdempotency(client, { scope: FORMAL_SCOPE, idempotencyKey: input.idempotencyKey, requestHash }, result, sha256Canonical(result));
        return result;
      }, { isolation: "READ COMMITTED" });
    },

    async issue(rawInput: ApplePhysicalCanaryBindingIssueInput): Promise<ApplePhysicalCanaryBindingReceipt> {
      const input = normalizeIssueInput(rawInput, identity);
      const fingerprint = requestFingerprintSha256(input);
      try {
        return await withTransaction(pool, async (client) => {
          const existing = await selectByRequest(client, input.requestId, input.idempotencyKey);
          if (existing !== undefined) {
            if (String(existing.request_id) !== input.requestId ||
                String(existing.idempotency_key) !== input.idempotencyKey) {
              fail("APPLE_PHYSICAL_CANARY_IDEMPOTENCY_CONFLICT");
            }
            return verifyActiveStoredRow(client, existing, fingerprint);
          }

          const authority = await primaryAuthoritySnapshot(
            client, input.realtimeSessionRef, input.iphoneDeviceLeaseRef, true,
          );
          const issuedAt = authority.observedAt;
          const expiresAt = new Date(Date.parse(issuedAt) + input.ttlSeconds * 1_000).toISOString();
          assertAuthorityLifetime(authority, expiresAt);
          const watchDeviceId = canonicalWatchDeviceId(canonicalDeviceIssuer, input, authority, fingerprint);
          if (watchDeviceId === authority.iphoneDeviceId) {
            fail("APPLE_PHYSICAL_CANARY_ENDPOINT_IDENTITY_COLLISION");
          }
          const bindingId = identityValue(identity, authority.iphoneDeviceId,
            `apple-physical-canary-binding:${fingerprint}`);
          const iphoneClientInstanceId = identityValue(identity, authority.iphoneDeviceId,
            `apple-physical-canary-iphone-client:${fingerprint}`);
          const watchClientInstanceId = identityValue(identity, watchDeviceId,
            `apple-physical-canary-watch-client:${fingerprint}`);
          const watchLeaseRef = watchLeaseRefValue(
            identity, input.realtimeSessionRef, watchDeviceId,
            `apple-physical-canary-watch-lease:${fingerprint}`,
          );
          if (new Set([
            bindingId, authority.iphoneDeviceId, iphoneClientInstanceId,
            watchDeviceId, watchClientInstanceId,
          ]).size !== 5) fail("APPLE_PHYSICAL_CANARY_ENDPOINT_IDENTITY_COLLISION");
          const receipt = makeReceipt(
            input, fingerprint, bindingId, authority.iphoneDeviceId, iphoneClientInstanceId,
            watchDeviceId, watchClientInstanceId, watchLeaseRef, issuedAt, expiresAt,
          );
          await insertWatchLease(client, receipt, authority);
          const inserted = await insertReceipt(client, receipt);
          const verified = rowReceipt(inserted);
          if (!sameJson(verified, receipt)) fail("APPLE_PHYSICAL_CANARY_INSERT_DRIFT");
          await verifyActiveStoredRow(client, inserted, fingerprint);
          return receipt;
        }, { isolation: "SERIALIZABLE" });
      } catch (error) {
        if (isConcurrentInsertConflict(error)) return replayAfterUnique(input, fingerprint);
        throw error;
      }
    },

    async read(rawBindingId: string): Promise<ApplePhysicalCanaryBindingReceipt | undefined> {
      const bindingId = uuidV7(rawBindingId, "APPLE_PHYSICAL_CANARY_BINDING_ID_INVALID");
      return withTransaction(pool, async (client) => {
        const rows = (await client.query(
          "SELECT * FROM apple_physical_canary_bindings WHERE binding_id = $1",
          [bindingId],
        )).rows;
        if (rows.length === 0) return undefined;
        if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_DUPLICATE_BINDING");
        return verifyActiveStoredRow(client, rows[0]!);
      }, { isolation: "REPEATABLE READ", readOnly: true });
    },

    async readActiveByPrimary(
      rawInput: ApplePhysicalCanaryBindingActiveReadInput,
    ): Promise<ApplePhysicalCanaryBindingReceipt | undefined> {
      const input = normalizeActiveReadInput(rawInput, identity);
      return withTransaction(pool, async (client) => {
        const rows = (await client.query(
          [
            "SELECT * FROM apple_physical_canary_bindings",
            "WHERE session_ref_id = $1 AND iphone_lease_ref_id = $2 AND state = 'active' AND companion_source = 'apple_physical_canary_binding_v1'",
          ].join(" "),
          [input.realtimeSessionRef.ref_id, input.iphoneDeviceLeaseRef.ref_id],
        )).rows;
        if (rows.length === 0) return undefined;
        if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_CONFLICT");
        const row = rows[0]!;
        const receipt = rowReceipt(row);
        if (!sameJson(receipt.realtimeSessionRef, input.realtimeSessionRef) ||
            !sameJson(receipt.iphone.deviceLeaseRef, input.iphoneDeviceLeaseRef)) {
          fail("APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_DRIFT");
        }
        return verifyActiveStoredRow(client, row, undefined, input.now);
      }, { isolation: "REPEATABLE READ", readOnly: true });
    },

    async refreshActiveByPrimary(
      rawInput: ApplePhysicalCanaryBindingRefreshInput,
    ): Promise<ApplePhysicalCanaryBindingRefreshResult | undefined> {
      const input = normalizeRefreshInput(rawInput, identity);
      const requestHash = refreshRequestFingerprint(input);
      try {
        return await withTransaction(pool, async (client) => {
          const claimed = await claimIdempotency(client, {
            scope: REFRESH_SCOPE,
            idempotencyKey: input.idempotencyKey,
            requestHash,
          });
          if (claimed.kind === "replay" || claimed.kind === "terminal") {
            const replayed = refreshResult(claimed.record.response);
            assertRefreshResultBinding(replayed, input);
            if (claimed.record.responseHash === undefined ||
                claimed.record.responseHash !== sha256Canonical(replayed)) {
              fail("APPLE_PHYSICAL_CANARY_REFRESH_IDEMPOTENCY_DRIFT");
            }
            return replayed;
          }
          if (claimed.kind === "in_flight") fail("APPLE_PHYSICAL_CANARY_REFRESH_IN_FLIGHT");

          const currentRow = await selectByPrimary(
            client, input.realtimeSessionRef, input.iphoneDeviceLeaseRef, true,
          );
          if (currentRow === undefined) fail("APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_MISSING");
          const currentReceipt = rowReceipt(currentRow);
          if (currentRow.state !== "active") fail("APPLE_PHYSICAL_CANARY_BINDING_REVOKED");
          if (!sameJson(currentReceipt.realtimeSessionRef, input.realtimeSessionRef) ||
              !sameJson(currentReceipt.iphone.deviceLeaseRef, input.iphoneDeviceLeaseRef)) {
            fail("APPLE_PHYSICAL_CANARY_REFRESH_BINDING_DRIFT");
          }

          const authority = await primaryAuthoritySnapshot(
            client, input.realtimeSessionRef, input.iphoneDeviceLeaseRef, true,
          );
          assertPrimaryUsable(authority);
          if (input.expectedLeaseVersion !== undefined &&
              authority.iphoneLeaseVersion !== input.expectedLeaseVersion) {
            fail("APPLE_PHYSICAL_CANARY_PRIMARY_LEASE_VERSION_CONFLICT");
          }
          if (input.expectedFencingToken !== undefined &&
              authority.iphoneFencingToken !== input.expectedFencingToken) {
            fail("APPLE_PHYSICAL_CANARY_PRIMARY_FENCE_CONFLICT");
          }
          const currentWatchRow = await readWatchLease(client, currentReceipt, authority, true);
          const expiresAt = refreshExpiresAt(authority, input.ttlSeconds);
          if (Date.parse(expiresAt) <= Date.parse(currentReceipt.expiresAt)) {
            fail("APPLE_PHYSICAL_CANARY_REFRESH_NOT_EXTENDING");
          }
          const nextReceipt = refreshedReceipt(currentReceipt, expiresAt);
          const nextWatch = await updateRefreshedWatchLease(
            client, currentWatchRow, nextReceipt, authority, expiresAt,
          );
          const updatedBindingRow = await updateRefreshedBinding(client, currentRow, nextReceipt);
          const updatedReceipt = rowReceipt(updatedBindingRow);
          if (!sameJson(updatedReceipt, nextReceipt)) fail("APPLE_PHYSICAL_CANARY_REFRESH_BINDING_DRIFT");
          const result: ApplePhysicalCanaryBindingRefreshResult = deepFreeze({
            binding: updatedReceipt,
            fencingToken: nextWatch.fencingToken,
            leaseVersion: nextWatch.leaseVersion,
            refreshedAt: authority.observedAt,
          });
          const eventPayload = refreshEventPayload(
            result.binding, result.leaseVersion, result.fencingToken,
          );
          await enqueueOutboxEvent(client, {
            eventId: randomUUID(),
            aggregateType: "ApplePhysicalCanaryBinding",
            aggregateId: result.binding.bindingId,
            eventType: REFRESH_EVENT_TYPE,
            eventVersion: 1,
            idempotencyScope: REFRESH_SCOPE,
            idempotencyKey: input.idempotencyKey,
            payload: eventPayload,
            payloadHash: sha256Canonical(eventPayload),
          });
          await completeIdempotency(
            client,
            { scope: REFRESH_SCOPE, idempotencyKey: input.idempotencyKey, requestHash },
            result,
            sha256Canonical(result),
          );
          return result;
        }, { isolation: "SERIALIZABLE" });
      } catch (error) {
        if (error instanceof ApplePhysicalCanaryBindingPostgresError &&
            error.code === "APPLE_PHYSICAL_CANARY_ACTIVE_BINDING_MISSING") return undefined;
        if (error instanceof IdempotencyConflictError) {
          fail("APPLE_PHYSICAL_CANARY_REFRESH_IDEMPOTENCY_CONFLICT");
        }
        throw error;
      }
    },

    async revoke(rawInput: ApplePhysicalCanaryBindingRevokeInput): Promise<void> {
      const input = normalizeRevokeInput(rawInput);
      await withTransaction(pool, async (client) => {
        const rows = (await client.query(
          "SELECT * FROM apple_physical_canary_bindings WHERE binding_id = $1 FOR UPDATE",
          [input.bindingId],
        )).rows;
        if (rows.length !== 1) fail("APPLE_PHYSICAL_CANARY_BINDING_NOT_FOUND");
        const row = rows[0]!;
        const receipt = rowReceipt(row);
        if (receipt.requestId !== input.requestId || receipt.idempotencyKey !== input.idempotencyKey ||
            receipt.canonicalPayloadSha256 !== input.canonicalPayloadSha256) {
          fail("APPLE_PHYSICAL_CANARY_REVOKE_BINDING_MISMATCH");
        }
        if (receipt.kind !== RECEIPT_KIND) fail("APPLE_FORMAL_WATCH_AUTHORITY_REQUIRED");
        const bindingState = row.state === "revoked" ? "revoked" : row.state === "active" ? "active" : undefined;
        if (bindingState === undefined) fail("APPLE_PHYSICAL_CANARY_STORED_STATE_DRIFT");
        await releaseWatchCompanionLease(client, receipt, bindingState);
        if (bindingState === "revoked") return;
        const result = await client.query([
          "UPDATE apple_physical_canary_bindings SET state = 'revoked', revoked_at = transaction_timestamp(),",
          "updated_at = transaction_timestamp() WHERE binding_id = $1 AND state = 'active'",
          "AND canonical_payload_sha256 = $2",
        ].join(" "), [input.bindingId, input.canonicalPayloadSha256]);
        if (result.rowCount !== 1) fail("APPLE_PHYSICAL_CANARY_REVOKE_CONFLICT");
      }, { isolation: "SERIALIZABLE" });
    },
  });
}
