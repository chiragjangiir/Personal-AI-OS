import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  LeasePolicyDecision,
  LeasePolicyPort,
  RealtimeIdentityPort,
} from "../../realtime-core/src/ports.ts";
import type {
  CanonicalTimestamp,
  DeviceLeaseRecord,
  OpaqueCanonicalRef,
  OpaqueGovernanceValue,
  RealtimeCurrentBindingProjection,
  RealtimeSessionRecord,
  RealtimeTransportBinding,
  TerminalReceipt,
} from "../../realtime-core/src/types.ts";
import {
  assertRealtimeCanonicalDeviceIdentityReceipt,
  type RealtimeCanonicalDeviceIdentityIssueInput,
  type RealtimeCanonicalDeviceIdentityIssuerPort,
  type RealtimeCanonicalDeviceIdentityReceipt,
} from "./realtime-canonical-device-issuer.ts";
import { createRealtimeAuthorityRepository } from "./realtime-authority-repository.ts";
import { withTransaction } from "./transaction.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]{0,37})$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REF_KEYS = ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"] as const;
const PG_NUMERIC_38_MAX = (10n ** 38n) - 1n;

type JsonRecord = Record<string, unknown>;

export interface RayneoDemoCurrentBindingInput {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly observedAt: string;
}

export interface RayneoDemoOwnerStableProjection {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly userId: string;
  readonly purpose: string;
  readonly governance: OpaqueGovernanceValue;
  readonly requestedCapabilities: readonly string[];
  readonly eligibilityObservedAt: string;
  readonly sessionExpiresAt: string;
  readonly cleanupDeadlineAt: string;
  readonly leaseExpiresAt: string;
  readonly connectionId: string;
  readonly ownerConnectionEpoch: string;
  readonly activeDeviceLeaseVersion: string;
  readonly providerAlias: string;
  readonly livekitSessionAlias: string;
  readonly livekitRoomAlias: string;
  readonly livekitParticipantAlias: string;
}

export interface RayneoDemoOwnerProjection {
  readonly stable: RayneoDemoOwnerStableProjection;
  readonly resolution: Readonly<{ observedAt: string }>;
}

export interface RayneoDemoOwnerIdentityPort {
  resolve(input: RayneoDemoCurrentBindingInput): Promise<RayneoDemoOwnerProjection | undefined>;
}

export type RayneoDemoLeasePolicyForOwner = (
  ownerProjection: RayneoDemoOwnerProjection,
) => LeasePolicyPort;

export interface RayneoDemoCurrentBindingProjection {
  readonly kind: "committed" | "replayed";
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly observedAt: string;
  readonly userId: string;
  readonly purpose: string;
  readonly canonicalDeviceId: string;
  readonly ownerConnectionEpoch: string;
  readonly persistedConnectionEpoch: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly ownerActiveDeviceLeaseVersion: string;
  readonly session: RealtimeSessionRecord;
  readonly lease: DeviceLeaseRecord;
  readonly binding: RealtimeTransportBinding;
  readonly outboxEventRef: OpaqueCanonicalRef;
}

export interface RayneoDemoCurrentBindingPort {
  resolve(input: RayneoDemoCurrentBindingInput): Promise<RayneoDemoCurrentBindingProjection | undefined>;
}

export interface RayneoDemoCurrentBindingPostgresOptions {
  readonly pool: Pool;
  readonly ownerIdentity: RayneoDemoOwnerIdentityPort;
  readonly canonicalDeviceIssuer: RealtimeCanonicalDeviceIdentityIssuerPort;
  readonly identity: RealtimeIdentityPort;
  readonly leasePolicyForOwner: RayneoDemoLeasePolicyForOwner;
}

export class RayneoDemoCurrentBindingPostgresError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "RayneoDemoCurrentBindingPostgresError";
    this.code = code;
  }
}

function fail(code: string, cause?: unknown): never {
  throw new RayneoDemoCurrentBindingPostgresError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) fail(code);
  }
  return value;
}

function exactString(value: unknown, code: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) fail(code);
  return value;
}

function canonicalTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) fail(code);
  return value;
}

function positiveDecimal(value: unknown, code: string): string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL.test(value)) fail(code);
  return value;
}

interface ConnectionEpochPair {
  readonly owner: string;
  readonly persisted: string;
}

function connectionEpochPair(value: unknown): ConnectionEpochPair {
  if (typeof value !== "string" || !NONNEGATIVE_DECIMAL.test(value)) {
    fail("RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_INVALID");
  }
  const owner = BigInt(value);
  if (owner > PG_NUMERIC_38_MAX - 1n) fail("RAYNEO_DEMO_OWNER_CONNECTION_EPOCH_OVERFLOW");
  return Object.freeze({ owner: value, persisted: (owner + 1n).toString(10) });
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
        items.push(canonicalJson(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
      fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
        fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function immutableSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
    return value;
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
        items.push(immutableSnapshot(value[index], seen));
      }
      return Object.freeze(items);
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
      fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
    }
    const snapshot: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
        fail("RAYNEO_DEMO_OPAQUE_VALUE_INVALID");
      }
      snapshot[key] = immutableSnapshot(value[key], seen);
    }
    return Object.freeze(snapshot);
  } finally {
    seen.delete(value);
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

interface SnakeRef extends Readonly<Record<string, unknown>> {
  readonly ref_type: "RealtimeSession" | "DeviceLease";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

function canonicalRef(value: unknown, expectedType: SnakeRef["ref_type"], code: string): SnakeRef {
  const record = exactRecord(value, REF_KEYS, code);
  if (record.ref_type !== expectedType || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !POSITIVE_DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256)) fail(code);
  return Object.freeze({
    ref_type: expectedType,
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

function capabilities(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value)) fail(code);
  const result = value.map((item) => exactString(item, code));
  if (new Set(result).size !== result.length) fail(code);
  return Object.freeze(result);
}

interface NormalizedOwner {
  readonly stable: RayneoDemoOwnerStableProjection;
  readonly governance: OpaqueGovernanceValue;
  readonly requestedCapabilities: readonly string[];
  readonly projection: RayneoDemoOwnerProjection;
}

function normalizeInput(value: RayneoDemoCurrentBindingInput): RayneoDemoCurrentBindingInput {
  const record = exactRecord(value, ["sessionId", "deviceId", "clientInstanceId", "observedAt"], "RAYNEO_DEMO_INPUT_INVALID");
  return Object.freeze({
    sessionId: exactString(record.sessionId, "RAYNEO_DEMO_SESSION_INVALID"),
    deviceId: exactString(record.deviceId, "RAYNEO_DEMO_DEVICE_INVALID"),
    clientInstanceId: exactString(record.clientInstanceId, "RAYNEO_DEMO_CLIENT_INVALID"),
    observedAt: canonicalTimestamp(record.observedAt, "RAYNEO_DEMO_OBSERVED_AT_INVALID"),
  });
}

function normalizeOwner(value: unknown, input: RayneoDemoCurrentBindingInput): NormalizedOwner {
  const root = exactRecord(value, ["stable", "resolution"], "RAYNEO_DEMO_OWNER_PROJECTION_INVALID");
  const stable = exactRecord(root.stable, [
    "sessionId", "deviceId", "clientInstanceId", "userId", "purpose", "governance",
    "requestedCapabilities", "eligibilityObservedAt", "sessionExpiresAt", "cleanupDeadlineAt", "leaseExpiresAt",
    "connectionId", "ownerConnectionEpoch", "activeDeviceLeaseVersion", "providerAlias", "livekitSessionAlias",
    "livekitRoomAlias", "livekitParticipantAlias",
  ], "RAYNEO_DEMO_OWNER_STABLE_INVALID");
  const resolution = exactRecord(root.resolution, ["observedAt"], "RAYNEO_DEMO_OWNER_RESOLUTION_INVALID");
  if (stable.sessionId !== input.sessionId || stable.deviceId !== input.deviceId ||
      stable.clientInstanceId !== input.clientInstanceId || resolution.observedAt !== input.observedAt) {
    fail("RAYNEO_DEMO_OWNER_ECHO_DRIFT");
  }
  const eligibilityObservedAt = canonicalTimestamp(stable.eligibilityObservedAt, "RAYNEO_DEMO_ELIGIBILITY_TIME_INVALID");
  const sessionExpiresAt = canonicalTimestamp(stable.sessionExpiresAt, "RAYNEO_DEMO_SESSION_EXPIRY_INVALID");
  const cleanupDeadlineAt = canonicalTimestamp(stable.cleanupDeadlineAt, "RAYNEO_DEMO_CLEANUP_DEADLINE_INVALID");
  const leaseExpiresAt = canonicalTimestamp(stable.leaseExpiresAt, "RAYNEO_DEMO_LEASE_EXPIRY_INVALID");
  if (Date.parse(input.observedAt) < Date.parse(eligibilityObservedAt)) fail("RAYNEO_DEMO_OBSERVED_AT_STALE");
  if (Date.parse(input.observedAt) >= Date.parse(sessionExpiresAt) ||
      Date.parse(input.observedAt) >= Date.parse(leaseExpiresAt)) fail("RAYNEO_DEMO_BINDING_EXPIRED");
  if (Date.parse(sessionExpiresAt) > Date.parse(cleanupDeadlineAt) ||
      Date.parse(eligibilityObservedAt) >= Date.parse(sessionExpiresAt) ||
      Date.parse(eligibilityObservedAt) >= Date.parse(leaseExpiresAt)) fail("RAYNEO_DEMO_EXPIRY_ORDER_INVALID");
  const userId = exactString(stable.userId, "RAYNEO_DEMO_USER_INVALID");
  if (!UUID_V7.test(userId)) fail("RAYNEO_DEMO_CANONICAL_ID_INVALID");
  const governance = immutableSnapshot(stable.governance) as OpaqueGovernanceValue;
  canonicalJson(governance);
  const requestedCapabilities = capabilities(stable.requestedCapabilities, "RAYNEO_DEMO_CAPABILITIES_INVALID");
  const normalized: RayneoDemoOwnerStableProjection = Object.freeze({
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    clientInstanceId: input.clientInstanceId,
    userId,
    purpose: exactString(stable.purpose, "RAYNEO_DEMO_PURPOSE_INVALID"),
    governance,
    requestedCapabilities,
    eligibilityObservedAt,
    sessionExpiresAt,
    cleanupDeadlineAt,
    leaseExpiresAt,
    connectionId: exactString(stable.connectionId, "RAYNEO_DEMO_CONNECTION_INVALID"),
    ownerConnectionEpoch: connectionEpochPair(stable.ownerConnectionEpoch).owner,
    activeDeviceLeaseVersion: positiveDecimal(stable.activeDeviceLeaseVersion, "RAYNEO_DEMO_OWNER_LEASE_VERSION_INVALID"),
    providerAlias: exactString(stable.providerAlias, "RAYNEO_DEMO_PROVIDER_ALIAS_INVALID"),
    livekitSessionAlias: exactString(stable.livekitSessionAlias, "RAYNEO_DEMO_SESSION_ALIAS_INVALID"),
    livekitRoomAlias: exactString(stable.livekitRoomAlias, "RAYNEO_DEMO_ROOM_ALIAS_INVALID"),
    livekitParticipantAlias: exactString(stable.livekitParticipantAlias, "RAYNEO_DEMO_PARTICIPANT_ALIAS_INVALID"),
  });
  const projection: RayneoDemoOwnerProjection = Object.freeze({
    stable: normalized,
    resolution: Object.freeze({ observedAt: input.observedAt }),
  });
  return Object.freeze({ stable: normalized, governance: normalized.governance, requestedCapabilities, projection });
}

function normalizePolicy(value: LeasePolicyDecision, owner: NormalizedOwner): LeasePolicyDecision {
  const record = exactRecord(value, ["allowed", "policyDecisionRef", "capabilities", "purpose", "leaseExpiresAt", "revocable"],
    "RAYNEO_DEMO_POLICY_INVALID");
  const policyCapabilities = capabilities(record.capabilities, "RAYNEO_DEMO_POLICY_CAPABILITIES_INVALID");
  const policyDecisionRef = immutableSnapshot(record.policyDecisionRef) as OpaqueGovernanceValue;
  canonicalJson(policyDecisionRef);
  if (record.allowed !== true || record.revocable !== true || record.purpose !== owner.stable.purpose ||
      record.leaseExpiresAt !== owner.stable.leaseExpiresAt) fail("RAYNEO_DEMO_POLICY_DRIFT");
  return Object.freeze({
    allowed: true,
    policyDecisionRef,
    capabilities: policyCapabilities,
    purpose: owner.stable.purpose,
    leaseExpiresAt: owner.stable.leaseExpiresAt as CanonicalTimestamp,
    revocable: true,
  });
}

function stableFingerprint(
  owner: NormalizedOwner,
  policy: LeasePolicyDecision,
  canonicalDeviceIdentity: RealtimeCanonicalDeviceIdentityReceipt,
  epochs: ConnectionEpochPair,
): string {
  return jsonHash({
    ...owner.stable,
    governance: owner.governance,
    requestedCapabilities: owner.requestedCapabilities,
    canonicalDeviceIdentity,
    persistedConnectionEpoch: epochs.persisted,
    policy: {
      allowed: policy.allowed,
      policyDecisionRef: policy.policyDecisionRef,
      capabilities: policy.capabilities,
      purpose: policy.purpose,
      leaseExpiresAt: policy.leaseExpiresAt,
      revocable: policy.revocable,
    },
  });
}

function requestNames(sessionId: string): Readonly<{ requestId: string; idempotencyKey: string }> {
  const digest = sha256Text(sessionId);
  return Object.freeze({
    requestId: `rayneo_demo_current_binding_request_${digest}`,
    idempotencyKey: `rayneo_demo_current_binding_${digest}`,
  });
}

function makeBinding(
  owner: NormalizedOwner,
  canonicalDeviceId: string,
  epochs: ConnectionEpochPair,
  sessionRef: SnakeRef,
  leaseRef: SnakeRef,
  continuityId: string,
): RealtimeTransportBinding {
  return Object.freeze({
    state: "connected",
    realtimeSessionRef: sessionRef,
    deviceLeaseRef: leaseRef,
    continuityId,
    deviceId: canonicalDeviceId,
    connectionEpoch: epochs.persisted as RealtimeTransportBinding["connectionEpoch"],
    provider: owner.stable.providerAlias,
    transportSessionAlias: owner.stable.livekitSessionAlias,
    roomAlias: owner.stable.livekitRoomAlias,
    deviceAlias: owner.stable.livekitParticipantAlias,
    connectionId: owner.stable.connectionId,
  });
}

interface StoredDemoProjection {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly canonicalDeviceIdentity: RealtimeCanonicalDeviceIdentityReceipt;
  readonly userId: string;
  readonly purpose: string;
  readonly ownerConnectionEpoch: string;
  readonly persistedConnectionEpoch: string;
  readonly activeDeviceLeaseVersion: string;
  readonly eligibilityObservedAt: string;
  readonly sessionExpiresAt: string;
  readonly cleanupDeadlineAt: string;
  readonly leaseExpiresAt: string;
  readonly stableFingerprint: string;
}

interface StoredBootstrapResult {
  readonly operation: "bootstrap";
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly connectionEpoch: string;
  readonly binding: RealtimeTransportBinding;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
  readonly receipt: TerminalReceipt;
  readonly rayneoDemo: StoredDemoProjection;
}

function storedDemo(
  owner: NormalizedOwner,
  canonicalDeviceIdentity: RealtimeCanonicalDeviceIdentityReceipt,
  epochs: ConnectionEpochPair,
  fingerprint: string,
): StoredDemoProjection {
  return Object.freeze({
    sessionId: owner.stable.sessionId,
    deviceId: owner.stable.deviceId,
    clientInstanceId: owner.stable.clientInstanceId,
    canonicalDeviceIdentity,
    userId: owner.stable.userId,
    purpose: owner.stable.purpose,
    ownerConnectionEpoch: epochs.owner,
    persistedConnectionEpoch: epochs.persisted,
    activeDeviceLeaseVersion: owner.stable.activeDeviceLeaseVersion,
    eligibilityObservedAt: owner.stable.eligibilityObservedAt,
    sessionExpiresAt: owner.stable.sessionExpiresAt,
    cleanupDeadlineAt: owner.stable.cleanupDeadlineAt,
    leaseExpiresAt: owner.stable.leaseExpiresAt,
    stableFingerprint: fingerprint,
  });
}

function deviceIdentityInput(
  owner: NormalizedOwner,
  names: Readonly<{ requestId: string; idempotencyKey: string }>,
): RealtimeCanonicalDeviceIdentityIssueInput {
  return Object.freeze({
    rawDeviceId: owner.stable.deviceId,
    sessionId: owner.stable.sessionId,
    clientInstanceId: owner.stable.clientInstanceId,
    eligibilityObservedAt: owner.stable.eligibilityObservedAt,
    requestId: names.requestId,
  });
}

function recoverStoredDeviceIdentity(
  value: unknown,
  owner: NormalizedOwner,
  epochs: ConnectionEpochPair,
  names: Readonly<{ requestId: string; idempotencyKey: string }>,
): RealtimeCanonicalDeviceIdentityReceipt {
  canonicalJson(value);
  const result = exactRecord(value, [
    "operation", "realtimeSessionRef", "continuityId", "deviceLeaseRef", "connectionEpoch", "binding",
    "continuityExpiresAt", "leaseExpiresAt", "receipt", "rayneoDemo",
  ], "RAYNEO_DEMO_REPLAY_INVALID");
  const demo = exactRecord(result.rayneoDemo, [
    "sessionId", "deviceId", "clientInstanceId", "canonicalDeviceIdentity", "userId", "purpose",
    "ownerConnectionEpoch", "persistedConnectionEpoch", "activeDeviceLeaseVersion", "eligibilityObservedAt",
    "sessionExpiresAt", "cleanupDeadlineAt", "leaseExpiresAt", "stableFingerprint",
  ], "RAYNEO_DEMO_REPLAY_PROJECTION_INVALID");
  if (demo.ownerConnectionEpoch !== epochs.owner || demo.persistedConnectionEpoch !== epochs.persisted) {
    fail("RAYNEO_DEMO_REPLAY_EPOCH_DRIFT");
  }
  try {
    return assertRealtimeCanonicalDeviceIdentityReceipt(demo.canonicalDeviceIdentity, deviceIdentityInput(owner, names));
  } catch (error) {
    fail("RAYNEO_DEMO_CANONICAL_DEVICE_RECEIPT_DRIFT", error);
  }
}

function validateStoredResult(
  value: unknown,
  owner: NormalizedOwner,
  canonicalDeviceIdentity: RealtimeCanonicalDeviceIdentityReceipt,
  epochs: ConnectionEpochPair,
  fingerprint: string,
  names: Readonly<{ requestId: string; idempotencyKey: string }>,
): StoredBootstrapResult {
  canonicalJson(value);
  const result = exactRecord(value, [
    "operation", "realtimeSessionRef", "continuityId", "deviceLeaseRef", "connectionEpoch", "binding",
    "continuityExpiresAt", "leaseExpiresAt", "receipt", "rayneoDemo",
  ], "RAYNEO_DEMO_REPLAY_INVALID");
  const sessionRef = canonicalRef(result.realtimeSessionRef, "RealtimeSession", "RAYNEO_DEMO_REPLAY_REF_INVALID");
  const leaseRef = canonicalRef(result.deviceLeaseRef, "DeviceLease", "RAYNEO_DEMO_REPLAY_REF_INVALID");
  const demo = exactRecord(result.rayneoDemo, [
    "sessionId", "deviceId", "clientInstanceId", "canonicalDeviceIdentity", "userId", "purpose",
    "ownerConnectionEpoch", "persistedConnectionEpoch", "activeDeviceLeaseVersion", "eligibilityObservedAt",
    "sessionExpiresAt", "cleanupDeadlineAt", "leaseExpiresAt", "stableFingerprint",
  ], "RAYNEO_DEMO_REPLAY_PROJECTION_INVALID");
  if (!sameJson(demo, storedDemo(owner, canonicalDeviceIdentity, epochs, fingerprint))) fail("RAYNEO_DEMO_REPLAY_STABLE_DRIFT");
  const binding = result.binding as RealtimeTransportBinding;
  if (result.operation !== "bootstrap" || typeof result.continuityId !== "string" || !UUID_V7.test(result.continuityId) ||
      result.connectionEpoch !== epochs.persisted || result.continuityExpiresAt !== owner.stable.sessionExpiresAt ||
      result.leaseExpiresAt !== owner.stable.leaseExpiresAt || !isPlainRecord(binding) ||
      !sameJson(binding.realtimeSessionRef, sessionRef) || !sameJson(binding.deviceLeaseRef, leaseRef) ||
      binding.continuityId !== result.continuityId || binding.deviceId !== canonicalDeviceIdentity.canonicalDeviceId ||
      binding.connectionEpoch !== epochs.persisted || binding.state !== "connected" ||
      binding.provider !== owner.stable.providerAlias || binding.transportSessionAlias !== owner.stable.livekitSessionAlias ||
      binding.roomAlias !== owner.stable.livekitRoomAlias || binding.deviceAlias !== owner.stable.livekitParticipantAlias ||
      binding.connectionId !== owner.stable.connectionId) fail("RAYNEO_DEMO_REPLAY_BINDING_DRIFT");
  const receipt = exactRecord(result.receipt, [
    "kind", "operation", "status", "requestId", "idempotencyKey", "realtimeSessionRef", "deviceLeaseRef",
    "continuityId", "connectionEpoch", "leaseVersion", "outcome", "recordedAt", "replayed", "outboxEventRef",
  ], "RAYNEO_DEMO_REPLAY_RECEIPT_INVALID");
  if (receipt.kind !== "realtime_terminal_receipt" || receipt.operation !== "bootstrap" || receipt.status !== "success" ||
      receipt.requestId !== names.requestId || receipt.idempotencyKey !== names.idempotencyKey ||
      !sameJson(receipt.realtimeSessionRef, sessionRef) || !sameJson(receipt.deviceLeaseRef, leaseRef) ||
      receipt.continuityId !== result.continuityId || receipt.connectionEpoch !== epochs.persisted ||
      receipt.leaseVersion !== "1" || receipt.outcome !== "bootstrap_created" ||
      receipt.recordedAt !== owner.stable.eligibilityObservedAt || receipt.replayed !== false ||
      typeof receipt.outboxEventRef !== "string" || !UUID.test(receipt.outboxEventRef)) {
    fail("RAYNEO_DEMO_REPLAY_RECEIPT_INVALID");
  }
  return result as unknown as StoredBootstrapResult;
}

function validateCurrentProjection(
  projection: RealtimeCurrentBindingProjection | undefined,
  stored: StoredBootstrapResult,
  owner: NormalizedOwner,
  policy: LeasePolicyDecision,
): RealtimeCurrentBindingProjection {
  if (projection === undefined) fail("RAYNEO_DEMO_CURRENT_BINDING_MISSING");
  const session = projection.session;
  const lease = projection.lease;
  const canonicalDeviceId = stored.rayneoDemo.canonicalDeviceIdentity.canonicalDeviceId;
  if (!sameJson(session.realtimeSessionRef, stored.realtimeSessionRef) ||
      !sameJson(session.activeDeviceLeaseRef, stored.deviceLeaseRef) ||
      !sameJson(session.binding, stored.binding) || !sameJson(lease.deviceLeaseRef, stored.deviceLeaseRef) ||
      !sameJson(lease.realtimeSessionRef, stored.realtimeSessionRef) || session.userId !== owner.stable.userId ||
      lease.userId !== owner.stable.userId || session.activeDeviceId !== canonicalDeviceId ||
      lease.deviceId !== canonicalDeviceId || session.continuityId !== stored.continuityId ||
      lease.continuityId !== stored.continuityId || session.state !== "active" || session.continuityState !== "active" ||
      lease.state !== "active" || session.connectionEpoch !== stored.connectionEpoch || session.revision !== "1" ||
      session.lastAcceptedUserActivityAt !== owner.stable.eligibilityObservedAt ||
      session.continuityExpiresAt !== owner.stable.sessionExpiresAt || lease.issuedAt !== owner.stable.eligibilityObservedAt ||
      lease.expiresAt !== owner.stable.leaseExpiresAt || lease.purpose !== owner.stable.purpose ||
      lease.leaseVersion !== "1" || lease.fencingToken !== "1" || lease.revocable !== true ||
      !sameJson(lease.capabilities, policy.capabilities) || !sameJson(lease.policyDecisionRef, policy.policyDecisionRef)) {
    fail("RAYNEO_DEMO_CURRENT_BINDING_DRIFT");
  }
  return projection;
}

interface VerificationReceipt {
  readonly counts: readonly number[];
}

async function verifySnapshot(
  client: PoolClient,
  stored: StoredBootstrapResult,
  owner: NormalizedOwner,
  policy: LeasePolicyDecision,
  fingerprint: string,
  names: Readonly<{ requestId: string; idempotencyKey: string }>,
): Promise<VerificationReceipt> {
  const sessionRef = canonicalRef(stored.realtimeSessionRef, "RealtimeSession", "RAYNEO_DEMO_VERIFY_REF_INVALID");
  const leaseRef = canonicalRef(stored.deviceLeaseRef, "DeviceLease", "RAYNEO_DEMO_VERIFY_REF_INVALID");
  const countsRow = (await client.query([
    "SELECT",
    "(SELECT count(*)::int FROM realtime_sessions WHERE session_ref_id=$1) AS sessions,",
    "(SELECT count(*)::int FROM device_leases WHERE lease_ref_id=$2 AND session_ref_id=$1) AS leases,",
    "(SELECT count(*)::int FROM realtime_transport_aliases WHERE session_ref_id=$1 AND lease_ref_id=$2 AND connection_epoch=$3) AS aliases,",
    "(SELECT count(*)::int FROM idempotency_ledger WHERE scope='bootstrap' AND idempotency_key=$4) AS ledger,",
    "(SELECT count(*)::int FROM outbox_events WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$4 AND event_type='realtime.session.started') AS outbox,",
    "(SELECT count(*)::int FROM realtime_terminal_facts WHERE request_scope='bootstrap' AND idempotency_key=$4 AND operation='bootstrap') AS terminal_fact,",
    "(SELECT count(*)::int FROM realtime_sessions WHERE continuity_id=$5 AND state='active' AND continuity_state='active') AS active_sessions,",
    "(SELECT count(*)::int FROM device_leases WHERE session_ref_id=$1 AND state='active') AS active_leases",
  ].join(" "), [sessionRef.ref_id, leaseRef.ref_id, stored.connectionEpoch, names.idempotencyKey, stored.continuityId])).rows[0];
  const counts = ["sessions", "leases", "aliases", "ledger", "outbox", "terminal_fact", "active_sessions", "active_leases"]
    .map((key) => Number(countsRow?.[key]));
  if (canonicalJson(counts) !== canonicalJson([1, 1, 4, 1, 1, 1, 1, 1])) fail("RAYNEO_DEMO_VERIFY_COUNTS_INVALID");
  const aliases = (await client.query([
    "SELECT alias_kind,alias_value,active,retired_at FROM realtime_transport_aliases",
    "WHERE session_ref_id=$1 AND lease_ref_id=$2 AND connection_epoch=$3 ORDER BY alias_kind",
  ].join(" "), [sessionRef.ref_id, leaseRef.ref_id, stored.connectionEpoch])).rows;
  const expectedAliases: Readonly<Record<string, string>> = Object.freeze({
    provider_alias: owner.stable.providerAlias,
    livekit_session: owner.stable.livekitSessionAlias,
    livekit_room: owner.stable.livekitRoomAlias,
    livekit_participant: owner.stable.livekitParticipantAlias,
  });
  if (aliases.length !== 4 || aliases.some((row) => row.active !== true || row.retired_at !== null ||
      expectedAliases[String(row.alias_kind)] !== row.alias_value)) fail("RAYNEO_DEMO_VERIFY_ALIAS_DRIFT");
  const ledgerRows = (await client.query(
    "SELECT request_hash,request_fingerprint,status,response,response_hash FROM idempotency_ledger WHERE scope='bootstrap' AND idempotency_key=$1",
    [names.idempotencyKey],
  )).rows;
  if (ledgerRows.length !== 1 || ledgerRows[0]!.request_fingerprint !== fingerprint ||
      String(ledgerRows[0]!.request_hash).trim() !== sha256Text(fingerprint) || ledgerRows[0]!.status !== "committed" ||
      !sameJson(ledgerRows[0]!.response, stored) || String(ledgerRows[0]!.response_hash).trim() !== jsonHash(stored)) {
    fail("RAYNEO_DEMO_VERIFY_IDEMPOTENCY_DRIFT");
  }
  const payload = Object.freeze({
    operation: "bootstrap",
    sessionRef: stored.realtimeSessionRef,
    continuityId: stored.continuityId,
    rayneoDemo: stored.rayneoDemo,
  });
  const outboxRows = (await client.query([
    "SELECT event_id::text,aggregate_type,aggregate_id::text,aggregate_ref,event_type,event_version,payload,payload_sha256",
    "FROM outbox_events WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1 AND event_type='realtime.session.started'",
  ].join(" "), [names.idempotencyKey])).rows;
  if (outboxRows.length !== 1 || outboxRows[0]!.event_id !== stored.receipt.outboxEventRef ||
      outboxRows[0]!.aggregate_type !== "realtime" || outboxRows[0]!.aggregate_id !== sessionRef.ref_id ||
      !sameJson(outboxRows[0]!.aggregate_ref, sessionRef) || outboxRows[0]!.event_version !== 1 ||
      !sameJson(outboxRows[0]!.payload, payload) || String(outboxRows[0]!.payload_sha256).trim() !== jsonHash(payload)) {
    fail("RAYNEO_DEMO_VERIFY_OUTBOX_DRIFT");
  }
  const terminalRows = (await client.query([
    "SELECT operation,status,request_scope,idempotency_key,request_hash,session_ref_id::text,lease_ref_id::text,",
    "continuity_id::text,connection_epoch::text,realtime_session_ref,device_lease_ref,operation_outcome,execution_facts,created_at",
    "FROM realtime_terminal_facts WHERE request_scope='bootstrap' AND idempotency_key=$1 AND operation='bootstrap'",
  ].join(" "), [names.idempotencyKey])).rows;
  if (terminalRows.length !== 1 || terminalRows[0]!.status !== "success" ||
      String(terminalRows[0]!.request_hash).trim() !== sha256Text(fingerprint) ||
      terminalRows[0]!.session_ref_id !== sessionRef.ref_id || terminalRows[0]!.lease_ref_id !== leaseRef.ref_id ||
      terminalRows[0]!.continuity_id !== stored.continuityId || terminalRows[0]!.connection_epoch !== stored.connectionEpoch ||
      !sameJson(terminalRows[0]!.realtime_session_ref, sessionRef) || !sameJson(terminalRows[0]!.device_lease_ref, leaseRef) ||
      terminalRows[0]!.operation_outcome !== "bootstrap_created" ||
      !sameJson(terminalRows[0]!.execution_facts, { status: "success" }) ||
      new Date(terminalRows[0]!.created_at).toISOString() !== owner.stable.eligibilityObservedAt) {
    fail("RAYNEO_DEMO_VERIFY_TERMINAL_FACT_DRIFT");
  }
  const fenceRows = (await client.query([
    "SELECT s.revision::text,s.connection_epoch::text,l.lease_version::text,l.fencing_token::text,l.purpose,",
    "l.capabilities,l.policy_decision_ref FROM realtime_sessions s JOIN device_leases l ON l.lease_ref_id=$2",
    "WHERE s.session_ref_id=$1 AND l.session_ref_id=s.session_ref_id",
  ].join(" "), [sessionRef.ref_id, leaseRef.ref_id])).rows;
  if (fenceRows.length !== 1 || fenceRows[0]!.revision !== "1" || fenceRows[0]!.connection_epoch !== stored.connectionEpoch ||
      fenceRows[0]!.lease_version !== "1" || fenceRows[0]!.fencing_token !== "1" ||
      fenceRows[0]!.purpose !== owner.stable.purpose || !sameJson(fenceRows[0]!.capabilities, policy.capabilities) ||
      !sameJson(fenceRows[0]!.policy_decision_ref, policy.policyDecisionRef)) fail("RAYNEO_DEMO_VERIFY_FENCING_DRIFT");
  return Object.freeze({ counts: Object.freeze(counts) });
}

function publicProjection(
  kind: "committed" | "replayed",
  input: RayneoDemoCurrentBindingInput,
  owner: NormalizedOwner,
  current: RealtimeCurrentBindingProjection,
  stored: StoredBootstrapResult,
): RayneoDemoCurrentBindingProjection {
  return Object.freeze({
    kind,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    clientInstanceId: input.clientInstanceId,
    observedAt: input.observedAt,
    userId: owner.stable.userId,
    purpose: owner.stable.purpose,
    canonicalDeviceId: stored.rayneoDemo.canonicalDeviceIdentity.canonicalDeviceId,
    ownerConnectionEpoch: stored.rayneoDemo.ownerConnectionEpoch,
    persistedConnectionEpoch: stored.rayneoDemo.persistedConnectionEpoch,
    realtimeSessionRef: stored.realtimeSessionRef,
    deviceLeaseRef: stored.deviceLeaseRef,
    continuityId: stored.continuityId,
    ownerActiveDeviceLeaseVersion: owner.stable.activeDeviceLeaseVersion,
    session: current.session,
    lease: current.lease,
    binding: current.session.binding,
    outboxEventRef: stored.receipt.outboxEventRef!,
  });
}

export function createRayneoDemoCurrentBindingPostgresProvider(
  options: RayneoDemoCurrentBindingPostgresOptions,
): RayneoDemoCurrentBindingPort {
  const config = exactRecord(options, ["pool", "ownerIdentity", "canonicalDeviceIssuer", "identity", "leasePolicyForOwner"],
    "RAYNEO_DEMO_OPTIONS_INVALID");
  const pool = config.pool as Pool;
  const ownerIdentity = config.ownerIdentity as unknown as RayneoDemoOwnerIdentityPort;
  const canonicalDeviceIssuer = config.canonicalDeviceIssuer as unknown as RealtimeCanonicalDeviceIdentityIssuerPort;
  const identity = config.identity as unknown as RealtimeIdentityPort;
  const leasePolicyForOwner = config.leasePolicyForOwner as unknown as RayneoDemoLeasePolicyForOwner;
  if (!pool || typeof pool.connect !== "function" || !ownerIdentity || typeof ownerIdentity.resolve !== "function" ||
      !canonicalDeviceIssuer || typeof canonicalDeviceIssuer.issue !== "function" ||
      !identity || typeof identity.createContinuityId !== "function" || typeof identity.createSessionRef !== "function" ||
      typeof identity.createDeviceLeaseRef !== "function" || typeof identity.assertRepositoryIssuedRef !== "function" ||
      typeof leasePolicyForOwner !== "function") fail("RAYNEO_DEMO_PORT_REQUIRED");
  const repository = createRealtimeAuthorityRepository(pool);
  return Object.freeze({
    resolve: async (rawInput: RayneoDemoCurrentBindingInput): Promise<RayneoDemoCurrentBindingProjection | undefined> => {
      const input = normalizeInput(rawInput);
      let ownerValue: RayneoDemoOwnerProjection | undefined;
      try {
        ownerValue = await ownerIdentity.resolve(input);
      } catch (error) {
        fail("RAYNEO_DEMO_OWNER_RESOLUTION_FAILED", error);
      }
      if (ownerValue === undefined) return undefined;
      const owner = normalizeOwner(ownerValue, input);
      let leasePolicyValue: unknown;
      try {
        leasePolicyValue = leasePolicyForOwner(owner.projection);
      } catch (error) {
        fail("RAYNEO_DEMO_LEASE_POLICY_FACTORY_FAILED", error);
      }
      const leasePolicyRecord = exactRecord(leasePolicyValue, ["evaluate"], "RAYNEO_DEMO_LEASE_POLICY_PORT_INVALID");
      if (typeof leasePolicyRecord.evaluate !== "function") fail("RAYNEO_DEMO_LEASE_POLICY_PORT_INVALID");
      const scopedLeasePolicy = leasePolicyValue as LeasePolicyPort;
      let policyValue: LeasePolicyDecision;
      try {
        policyValue = await scopedLeasePolicy.evaluate({
          userId: owner.stable.userId,
          deviceId: owner.stable.deviceId,
          capabilities: owner.requestedCapabilities,
          purpose: owner.stable.purpose,
          occurredAt: owner.stable.eligibilityObservedAt as CanonicalTimestamp,
          governance: owner.governance,
        });
      } catch (error) {
        fail("RAYNEO_DEMO_POLICY_RESOLUTION_FAILED", error);
      }
      const policy = normalizePolicy(policyValue, owner);
      const epochs = connectionEpochPair(owner.stable.ownerConnectionEpoch);
      const names = requestNames(input.sessionId);
      const issuerInput = deviceIdentityInput(owner, names);
      const transactionResult = await repository.transaction("realtime.bootstrap", async (tx) => {
        const prior = await tx.readIdempotency("bootstrap", names.idempotencyKey);
        if (prior !== undefined) {
          const canonicalDeviceIdentity = recoverStoredDeviceIdentity(prior.result, owner, epochs, names);
          const fingerprint = stableFingerprint(owner, policy, canonicalDeviceIdentity, epochs);
          if (prior.requestFingerprint !== fingerprint) fail("RAYNEO_DEMO_IDEMPOTENCY_CONFLICT");
          const stored = validateStoredResult(prior.result, owner, canonicalDeviceIdentity, epochs, fingerprint, names);
          const current = validateCurrentProjection(
            await tx.readCurrentBinding({ realtimeSessionRef: stored.realtimeSessionRef }),
            stored,
            owner,
            policy,
          );
          return Object.freeze({ kind: "replayed" as const, stored, current, policy, fingerprint });
        }
        let canonicalDeviceIdentity: RealtimeCanonicalDeviceIdentityReceipt;
        try {
          canonicalDeviceIdentity = assertRealtimeCanonicalDeviceIdentityReceipt(
            canonicalDeviceIssuer.issue(issuerInput),
            issuerInput,
          );
        } catch (error) {
          fail("RAYNEO_DEMO_CANONICAL_DEVICE_ISSUANCE_FAILED", error);
        }
        const canonicalDeviceId = canonicalDeviceIdentity.canonicalDeviceId;
        const fingerprint = stableFingerprint(owner, policy, canonicalDeviceIdentity, epochs);
        const continuityId = identity.createContinuityId({ userId: owner.stable.userId, requestId: names.requestId });
        if (typeof continuityId !== "string" || !UUID_V7.test(continuityId)) fail("RAYNEO_DEMO_CONTINUITY_ID_INVALID");
        const sessionRef = canonicalRef(identity.createSessionRef({
          userId: owner.stable.userId,
          continuityId,
          requestId: names.requestId,
        }), "RealtimeSession", "RAYNEO_DEMO_SESSION_REF_INVALID");
        const leaseRef = canonicalRef(identity.createDeviceLeaseRef({
          sessionRef,
          deviceId: canonicalDeviceId,
          requestId: names.requestId,
        }), "DeviceLease", "RAYNEO_DEMO_LEASE_REF_INVALID");
        identity.assertRepositoryIssuedRef(sessionRef, "RealtimeSession");
        identity.assertRepositoryIssuedRef(leaseRef, "DeviceLease");
        const binding = makeBinding(owner, canonicalDeviceId, epochs, sessionRef, leaseRef, continuityId);
        const session: RealtimeSessionRecord = Object.freeze({
          realtimeSessionRef: sessionRef,
          userId: owner.stable.userId,
          continuityId,
          state: "active",
          continuityState: "active",
          connectionEpoch: epochs.persisted as RealtimeSessionRecord["connectionEpoch"],
          continuityExpiresAt: owner.stable.sessionExpiresAt as CanonicalTimestamp,
          lastAcceptedUserActivityAt: owner.stable.eligibilityObservedAt as CanonicalTimestamp,
          activeDeviceId: canonicalDeviceId,
          activeDeviceLeaseRef: leaseRef,
          binding,
          revision: "1" as RealtimeSessionRecord["revision"],
        });
        const lease: DeviceLeaseRecord = Object.freeze({
          deviceLeaseRef: leaseRef,
          realtimeSessionRef: sessionRef,
          continuityId,
          userId: owner.stable.userId,
          deviceId: canonicalDeviceId,
          state: "active",
          capabilities: policy.capabilities,
          purpose: policy.purpose,
          issuedAt: owner.stable.eligibilityObservedAt as CanonicalTimestamp,
          expiresAt: owner.stable.leaseExpiresAt as CanonicalTimestamp,
          revocable: true,
          leaseVersion: "1" as DeviceLeaseRecord["leaseVersion"],
          fencingToken: "1" as DeviceLeaseRecord["fencingToken"],
          policyDecisionRef: policy.policyDecisionRef,
        });
        await tx.writeSession({ record: session });
        await tx.writeLease({ record: lease });
        await tx.writeBinding({ binding });
        const demo = storedDemo(owner, canonicalDeviceIdentity, epochs, fingerprint);
        const payload = Object.freeze({ operation: "bootstrap", sessionRef, continuityId, rayneoDemo: demo });
        const outboxEventRef = await tx.appendOutbox({
          eventType: "realtime.session.started",
          aggregateRef: sessionRef,
          idempotencyKey: names.idempotencyKey,
          occurredAt: owner.stable.eligibilityObservedAt as CanonicalTimestamp,
          payload,
        });
        if (typeof outboxEventRef !== "string" || !UUID.test(outboxEventRef)) fail("RAYNEO_DEMO_OUTBOX_REF_INVALID");
        const receipt: TerminalReceipt = Object.freeze({
          kind: "realtime_terminal_receipt",
          operation: "bootstrap",
          status: "success",
          requestId: names.requestId,
          idempotencyKey: names.idempotencyKey,
          realtimeSessionRef: sessionRef,
          deviceLeaseRef: leaseRef,
          continuityId,
          connectionEpoch: epochs.persisted as TerminalReceipt["connectionEpoch"],
          leaseVersion: "1" as NonNullable<TerminalReceipt["leaseVersion"]>,
          outcome: "bootstrap_created",
          recordedAt: owner.stable.eligibilityObservedAt as CanonicalTimestamp,
          replayed: false,
          outboxEventRef,
        });
        const stored: StoredBootstrapResult = Object.freeze({
          operation: "bootstrap",
          realtimeSessionRef: sessionRef,
          continuityId,
          deviceLeaseRef: leaseRef,
          connectionEpoch: epochs.persisted,
          binding,
          continuityExpiresAt: owner.stable.sessionExpiresAt,
          leaseExpiresAt: owner.stable.leaseExpiresAt,
          receipt,
          rayneoDemo: demo,
        });
        await tx.writeIdempotency({
          operation: "bootstrap",
          idempotencyKey: names.idempotencyKey,
          requestFingerprint: fingerprint,
          result: stored,
        });
        const current = validateCurrentProjection(
          await tx.readCurrentBinding({ realtimeSessionRef: sessionRef }),
          stored,
          owner,
          policy,
        );
        return Object.freeze({ kind: "committed" as const, stored, current, policy, fingerprint });
      });
      await withTransaction(
        pool,
        (client) => verifySnapshot(
          client,
          transactionResult.stored,
          owner,
          transactionResult.policy,
          transactionResult.fingerprint,
          names,
        ),
        { isolation: "REPEATABLE READ", readOnly: true },
      );
      return publicProjection(transactionResult.kind, input, owner, transactionResult.current, transactionResult.stored);
    },
  });
}
