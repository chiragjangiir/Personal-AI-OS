import { createHash, timingSafeEqual } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  assertUUIDv7,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../../services/memory-os/src/canonical-ref.ts";
import { assertCanonicalUtcInstant, type AuthorityWatermark, type MemoryCommandError } from "../../../services/memory-os/src/domain.ts";
import { jcsSerialize } from "../../../services/memory-os/src/canonical-issuer.ts";
import type { OwnerPortResult } from "../../../services/memory-os/src/ports.ts";
import type {
  ProductionMemoryLifecycleAction,
  ProductionMemoryLifecycleAuthorityPort,
  ProductionMemoryLifecycleAuthorityReceipt,
  ProductionMemoryLifecycleEnvelope,
} from "../../../services/memory-os/src/production-memory-lifecycle.ts";
import type { ExplicitUserCorrectionEvidence } from "../../../services/memory-os/src/explicit-user-correction-adapter.ts";
import type { ProductionMemoryReadyBinding } from "../../../services/memory-os/src/production-memory-ready.ts";
import { snapshotOpaqueOwnerValue, type OpaqueCanonicalRef } from "../../../services/realtime-core/src/types.ts";
import type { T04AcceptedUserActivityOwnerEvent } from "./realtime-public-control-t04-owner.ts";

export const T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH =
  "D:\\AI\\personal ai os\\.runtime\\phase0-roaming\\windows\\config\\t03-production-memory-lifecycle-authority.v1.json" as const;
export const T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_SCHEMA =
  "paios.t03.production_memory_lifecycle_authority.v1" as const;
export const T03_PRODUCTION_MEMORY_LIFECYCLE_ACTIONS = Object.freeze([
  "correct_memory",
  "recall_for_answer_context",
] as const);
export const T03_PRODUCTION_MEMORY_PAYLOAD_PAIRING_LIMITATION =
  "verify sees only envelope，cannot compare watermark with later raw correctMemory call.input payload；do not claim pairing." as const;

const MAX_RECORD_BYTES = 65_536;
const MAX_AUTHORITY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RECORD_KEYS = Object.freeze([
  "action_grants", "continuity_id", "device_id", "expires_at_utc", "grant_id", "issued_at_utc",
  "issuer_ref", "purpose", "realtime_session_ref", "schema", "scopes", "user_id",
] as const);
const ACTION_GRANT_KEYS = Object.freeze([
  "action", "capability_grant_ref", "consent_record_ref", "governance_ref", "purpose_token_ref",
  "requires_correction_pair", "t04_actions",
] as const);
const WATERMARK_KEYS = Object.freeze([
  "acceptance_ref_sha256", "action", "action_grant_refs", "activity_id", "activity_idempotency_key",
  "binding_sha256", "context_assertion_sha256", "new_value_sha256", "pair_fingerprint",
  "record_sha256", "schema", "slot_sha256"] as const);
const WATERMARK_REF_KEYS = Object.freeze([
  "capability_grant_ref", "consent_record_ref", "governance_ref", "purpose_token_ref"] as const);
const ENVELOPE_KEYS = Object.freeze([
  "authorityReceipt", "binding", "governanceRef", "idempotencyKey", "requestId", "requestedAt"] as const);
const RECEIPT_KEYS = Object.freeze([
  "action", "authorityWatermark", "authorizedAt", "binding", "governanceRef", "idempotencyKey",
  "kind", "requestId", "requestedAt"] as const);
const BINDING_KEYS = Object.freeze([
  "clientInstanceId", "continuityId", "deviceId", "purpose", "realtimeSessionRef", "sessionId", "userId"] as const);
const T04_EVENT_KEYS = Object.freeze(["activity", "actionReceipt", "authorityProjection", "currentBinding"] as const);
const T04_ACTIVITY_KEYS = Object.freeze([
  "accepted", "acceptanceRef", "activityId", "continuityId", "deviceId", "kind", "occurredAt",
  "realtimeSessionRef", "userId"] as const);
const T04_RECEIPT_KEYS = Object.freeze([
  "action", "activityId", "bindingCommitted", "committed", "deleted", "kind", "origin", "purpose", "revoked", "stale"] as const);
const T04_BINDING_KEYS = Object.freeze([
  "activeDeviceId", "continuityExpiresAt", "continuityId", "lastAcceptedUserActivityAt", "leaseExpiresAt",
  "leaseState", "realtimeSessionRef", "sessionState", "continuityState", "transportState", "userId"] as const);
const T04_PROJECTION_KEYS = Object.freeze([
  "accepted", "acceptanceRef", "activityId", "authorityWatermark", "continuityId", "current", "deleted", "deviceId",
  "environment", "evidence", "kind", "origin", "purpose", "realtimeSessionRef", "sessionTime", "stale",
  "suppressed", "userId", "userOriginated", "watermarkCurrent"] as const);
const T04_EVIDENCE_KEYS = Object.freeze([
  "activityId", "authority", "current", "deleted", "evidenceRef", "kind", "stale", "suppressed", "userOriginated"] as const);

type Action = (typeof T03_PRODUCTION_MEMORY_LIFECYCLE_ACTIONS)[number];
type T04Action = "button_submit" | "explicit_voice_command";
type ClockValue = string | number | Date;
type JsonRecord = Record<string, unknown>;
type OpaqueValue = string | Readonly<Record<string, unknown>>;

export interface T03ProductionMemoryLifecycleRecordReader {
  readonly path: typeof T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH;
  readonly expectedSha256: string;
  readonly read: () => Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

export interface T03ProductionMemoryLifecycleOwnerProtection {
  readonly assertOwnerProtected: (path: typeof T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH) => void | Promise<void>;
}

export interface T03ProductionMemoryLifecycleCurrentBindingReader {
  readonly readCurrentBinding: (input: { readonly realtimeSessionRef: OpaqueCanonicalRef }) => unknown | Promise<unknown>;
}

export interface T03ProductionMemoryLifecycleAcceptedActivityReader {
  readonly read: (input: {
    readonly activityId: string;
    readonly idempotencyKey: string;
    readonly realtimeSessionRef: OpaqueCanonicalRef;
  }) => unknown | Promise<unknown>;
}

export interface T03ProductionMemoryLifecycleClock {
  readonly now: () => ClockValue;
}

export interface T03ProductionMemoryLifecycleAuthorityOptions {
  readonly record: T03ProductionMemoryLifecycleRecordReader;
  readonly ownerProtection: T03ProductionMemoryLifecycleOwnerProtection;
  readonly currentBinding: T03ProductionMemoryLifecycleCurrentBindingReader;
  readonly acceptedActivity: T03ProductionMemoryLifecycleAcceptedActivityReader;
  readonly clock: T03ProductionMemoryLifecycleClock;
}

export interface T03ProductionMemoryLifecycleIssueInput {
  readonly serverCurrentBinding: ProductionMemoryReadyBinding;
  readonly durableAcceptedActivity: T04AcceptedUserActivityOwnerEvent;
  readonly slot: string;
  readonly newValueSha256: Sha256;
  readonly requestedAt: string;
}

export interface T03ProductionMemoryLifecycleIssueResult {
  readonly correctionEnvelope: ProductionMemoryLifecycleEnvelope;
  readonly recallEnvelope: ProductionMemoryLifecycleEnvelope;
  readonly correctionEvidence: ExplicitUserCorrectionEvidence;
}

export interface T03ProductionMemoryLifecycleAuthorityOwner {
  readonly authority: ProductionMemoryLifecycleAuthorityPort;
  readonly issueEnvelopes: (input: T03ProductionMemoryLifecycleIssueInput) => Promise<T03ProductionMemoryLifecycleIssueResult>;
  readonly readiness: () => Promise<boolean>;
  readonly isReady: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export class T03ProductionMemoryLifecycleAuthorityError extends Error {
  readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "T03ProductionMemoryLifecycleAuthorityError";
    this.code = code;
  }
}

interface ActionGrant {
  readonly action: Action;
  readonly governanceRef: CanonicalObjectVersionRef;
  readonly consentRecordRef: CanonicalObjectVersionRef;
  readonly purposeTokenRef: CanonicalObjectVersionRef;
  readonly capabilityGrantRef: CanonicalObjectVersionRef;
  readonly t04Actions: readonly T04Action[];
  readonly requiresCorrectionPair: boolean;
}

interface AuthorityRecord {
  readonly recordSha256: string;
  readonly grantId: string;
  readonly issuerRef: CanonicalObjectVersionRef;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: CanonicalObjectVersionRef;
  readonly realtimeSessionRefWire: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly purpose: string;
  readonly scopes: readonly Action[];
  readonly actionGrants: readonly ActionGrant[];
}

interface CurrentBinding {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly purpose: string;
  readonly connectionEpoch: string;
  readonly leaseVersion: string;
  readonly sessionState: string;
  readonly continuityState: string;
  readonly transportState: string;
  readonly leaseState: string;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
}

interface NormalizedT04 {
  readonly activityId: string;
  readonly action: T04Action;
  readonly occurredAt: string;
  readonly acceptanceRef: CanonicalObjectVersionRef;
  readonly acceptanceRefWire: OpaqueCanonicalRef;
  readonly contextAssertionHash: string;
  readonly acceptanceRefHash: string;
  readonly event: unknown;
}

interface ActionGrantWatermark {
  readonly governance_ref: CanonicalObjectVersionRef;
  readonly consent_record_ref: CanonicalObjectVersionRef;
  readonly purpose_token_ref: CanonicalObjectVersionRef;
  readonly capability_grant_ref: CanonicalObjectVersionRef;
}

interface PairWatermark {
  readonly schema: "paios.t03.production_memory_lifecycle_watermark.v1";
  readonly action: Action;
  readonly record_sha256: string;
  readonly binding_sha256: string;
  readonly activity_id: string;
  readonly activity_idempotency_key: string;
  readonly acceptance_ref_sha256: string;
  readonly context_assertion_sha256: string;
  readonly slot_sha256: string;
  readonly new_value_sha256: string;
  readonly pair_fingerprint: string;
  readonly action_grant_refs: ActionGrantWatermark;
}

function fail(code: string, cause?: unknown): never {
  throw new T03ProductionMemoryLifecycleAuthorityError(code, cause);
}

function plain(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail(code);
  return value as JsonRecord;
}

function own(object: JsonRecord, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")) fail(code);
  return descriptor.value;
}

function exactObject(value: unknown, keys: readonly string[], code: string): JsonRecord {
  const object = plain(value, code);
  const actual = Object.getOwnPropertyNames(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")) fail(code);
  }
  return object;
}

function bounded(value: unknown, code: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || CONTROL.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown, code: string): string {
  try {
    return assertCanonicalUtcInstant(value, code);
  } catch (error) {
    return fail(code, error);
  }
}

function timestampMs(value: string, code: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) fail(code);
  return result;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return jcsSerialize(left) === jcsSerialize(right);
  } catch {
    return false;
  }
}

function snapshot(value: unknown, code: string): OpaqueCanonicalRef {
  try {
    return snapshotOpaqueOwnerValue(value);
  } catch (error) {
    return fail(code, error);
  }
}

function clockNow(clock: T03ProductionMemoryLifecycleClock): string {
  let value: ClockValue;
  try {
    value = clock.now();
  } catch (error) {
    return fail("T03_MEMORY_AUTHORITY_CLOCK_INVALID", error);
  }
  if (typeof value === "string") return timestamp(value, "T03_MEMORY_AUTHORITY_CLOCK_INVALID");
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(milliseconds)) fail("T03_MEMORY_AUTHORITY_CLOCK_INVALID");
  return new Date(milliseconds).toISOString();
}

function internalRef(value: unknown, expectedType?: string): CanonicalObjectVersionRef {
  const wire = exactObject(value, ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"], "T03_MEMORY_AUTHORITY_REF_INVALID");
  const refType = bounded(own(wire, "ref_type", "T03_MEMORY_AUTHORITY_REF_INVALID"), "T03_MEMORY_AUTHORITY_REF_INVALID");
  if (expectedType !== undefined && refType !== expectedType) fail("T03_MEMORY_AUTHORITY_REF_TYPE_INVALID");
  try {
    return Object.freeze(assertCanonicalObjectVersionRef({
      refType,
      refId: own(wire, "ref_id", "T03_MEMORY_AUTHORITY_REF_INVALID"),
      objectVersion: own(wire, "object_version", "T03_MEMORY_AUTHORITY_REF_INVALID"),
      canonicalPayloadSha256: own(wire, "canonical_payload_sha256", "T03_MEMORY_AUTHORITY_REF_INVALID"),
    }));
  } catch (error) {
    return fail("T03_MEMORY_AUTHORITY_REF_INVALID", error);
  }
}

function refKey(value: unknown, expectedType?: string): string {
  return canonicalRefKey(internalRef(value, expectedType));
}

function normalizedRef(value: unknown, expectedType: string): CanonicalObjectVersionRef {
  try { return internalRef(value, expectedType); } catch {
    const object = exactObject(value, ["canonicalPayloadSha256", "objectVersion", "refId", "refType"], "T03_MEMORY_AUTHORITY_REF_INVALID");
    if (own(object, "refType", "T03_MEMORY_AUTHORITY_REF_INVALID") !== expectedType) fail("T03_MEMORY_AUTHORITY_REF_TYPE_INVALID");
    try { return Object.freeze(assertCanonicalObjectVersionRef(value)); } catch (error) { return fail("T03_MEMORY_AUTHORITY_REF_INVALID", error); }
  }
}

function bindingCopy(value: unknown): ProductionMemoryReadyBinding {
  const object = exactObject(value, BINDING_KEYS, "T03_MEMORY_AUTHORITY_BINDING_INVALID");
  const sessionRef = snapshot(own(object, "realtimeSessionRef", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID");
  internalRef(sessionRef, "RealtimeSession");
  return Object.freeze({
    userId: bounded(own(object, "userId", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    sessionId: bounded(own(object, "sessionId", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    deviceId: bounded(own(object, "deviceId", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    clientInstanceId: bounded(own(object, "clientInstanceId", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    realtimeSessionRef: sessionRef,
    continuityId: bounded(own(object, "continuityId", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    purpose: bounded(own(object, "purpose", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
  });
}

function normalizeRecord(value: unknown, recordSha256: string): AuthorityRecord {
  const record = exactObject(value, RECORD_KEYS, "T03_MEMORY_AUTHORITY_RECORD_INVALID");
  if (own(record, "schema", "T03_MEMORY_AUTHORITY_RECORD_INVALID") !== T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_SCHEMA) fail("T03_MEMORY_AUTHORITY_SCHEMA_INVALID");
  const scopes = own(record, "scopes", "T03_MEMORY_AUTHORITY_SCOPE_INVALID");
  if (!Array.isArray(scopes) || scopes.length !== 2 || scopes[0] !== "correct_memory" || scopes[1] !== "recall_for_answer_context") fail("T03_MEMORY_AUTHORITY_SCOPE_INVALID");
  const grantId = bounded(own(record, "grant_id", "T03_MEMORY_AUTHORITY_RECORD_INVALID"), "T03_MEMORY_AUTHORITY_GRANT_INVALID", 36);
  try { assertUUIDv7(grantId); } catch (error) { fail("T03_MEMORY_AUTHORITY_GRANT_INVALID", error); }
  const issuedAt = timestamp(own(record, "issued_at_utc", "T03_MEMORY_AUTHORITY_TIME_INVALID"), "T03_MEMORY_AUTHORITY_TIME_INVALID");
  const expiresAt = timestamp(own(record, "expires_at_utc", "T03_MEMORY_AUTHORITY_TIME_INVALID"), "T03_MEMORY_AUTHORITY_TIME_INVALID");
  const lifetime = timestampMs(expiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID") - timestampMs(issuedAt, "T03_MEMORY_AUTHORITY_TIME_INVALID");
  if (lifetime <= 0 || lifetime > MAX_AUTHORITY_LIFETIME_MS) fail("T03_MEMORY_AUTHORITY_LIFETIME_INVALID");
  const sessionRefWire = snapshot(own(record, "realtime_session_ref", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID");
  const actionGrantsRaw = own(record, "action_grants", "T03_MEMORY_AUTHORITY_GRANTS_INVALID");
  if (!Array.isArray(actionGrantsRaw) || actionGrantsRaw.length !== 2) fail("T03_MEMORY_AUTHORITY_GRANTS_INVALID");
  const actionGrants = actionGrantsRaw.map((raw): ActionGrant => {
    const grant = exactObject(raw, ACTION_GRANT_KEYS, "T03_MEMORY_AUTHORITY_GRANT_INVALID");
    const action = own(grant, "action", "T03_MEMORY_AUTHORITY_GRANT_INVALID");
    if (action !== "correct_memory" && action !== "recall_for_answer_context") fail("T03_MEMORY_AUTHORITY_GRANT_INVALID");
    const t04Actions = own(grant, "t04_actions", "T03_MEMORY_AUTHORITY_GRANT_INVALID");
    if (!Array.isArray(t04Actions) || t04Actions.length !== 2 || t04Actions[0] !== "button_submit" || t04Actions[1] !== "explicit_voice_command") fail("T03_MEMORY_AUTHORITY_T04_ACTION_INVALID");
    const requiresPair = own(grant, "requires_correction_pair", "T03_MEMORY_AUTHORITY_GRANT_INVALID");
    if (requiresPair !== (action === "recall_for_answer_context")) fail("T03_MEMORY_AUTHORITY_GRANT_FLAG_INVALID");
    return Object.freeze({
      action: action as Action,
      governanceRef: internalRef(own(grant, "governance_ref", "T03_MEMORY_AUTHORITY_GRANT_INVALID"), "PolicyDecision"),
      consentRecordRef: internalRef(own(grant, "consent_record_ref", "T03_MEMORY_AUTHORITY_GRANT_INVALID"), "ConsentRecord"),
      purposeTokenRef: internalRef(own(grant, "purpose_token_ref", "T03_MEMORY_AUTHORITY_GRANT_INVALID"), "PurposeToken"),
      capabilityGrantRef: internalRef(own(grant, "capability_grant_ref", "T03_MEMORY_AUTHORITY_GRANT_INVALID"), "CapabilityGrant"),
      t04Actions: Object.freeze(["button_submit", "explicit_voice_command"] as const),
      requiresCorrectionPair: requiresPair as boolean,
    });
  });
  if (actionGrants[0]!.action !== "correct_memory" || actionGrants[1]!.action !== "recall_for_answer_context" ||
      canonicalRefKey(actionGrants[0]!.governanceRef) === canonicalRefKey(actionGrants[1]!.governanceRef)) fail("T03_MEMORY_AUTHORITY_GRANTS_INVALID");
  return Object.freeze({
    recordSha256,
    grantId,
    issuerRef: internalRef(own(record, "issuer_ref", "T03_MEMORY_AUTHORITY_ISSUER_INVALID")),
    issuedAt,
    expiresAt,
    userId: bounded(own(record, "user_id", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    deviceId: bounded(own(record, "device_id", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    realtimeSessionRef: internalRef(sessionRefWire, "RealtimeSession"),
    realtimeSessionRefWire: sessionRefWire,
    continuityId: bounded(own(record, "continuity_id", "T03_MEMORY_AUTHORITY_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_BINDING_INVALID"),
    purpose: bounded(own(record, "purpose", "T03_MEMORY_AUTHORITY_PURPOSE_INVALID"), "T03_MEMORY_AUTHORITY_PURPOSE_INVALID"),
    scopes: Object.freeze(["correct_memory", "recall_for_answer_context"] as const),
    actionGrants: Object.freeze(actionGrants),
  });
}

function normalizeCurrentBinding(value: unknown): CurrentBinding {
  const root = plain(value, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
  let userId: unknown; let sessionId: unknown; let deviceId: unknown; let clientInstanceId: unknown;
  let sessionRef: unknown; let leaseRef: unknown; let continuityId: unknown; let purpose: unknown;
  let epoch: unknown; let leaseVersion: unknown; let sessionState: unknown; let continuityState: unknown;
  let transportState: unknown; let leaseState: unknown; let continuityExpiresAt: unknown; let leaseExpiresAt: unknown;
  if (Object.hasOwn(root, "session") || Object.hasOwn(root, "lease")) {
    const session = plain(own(root, "session", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    const lease = plain(own(root, "lease", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    const transport = plain(own(session, "binding", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    const first = (object: JsonRecord, keys: readonly string[]): unknown => {
      for (const key of keys) if (Object.hasOwn(object, key)) return own(object, key, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
      return undefined;
    };
    userId = first(session, ["userId"]); sessionId = first(session, ["sessionId"]); deviceId = first(session, ["activeDeviceId", "deviceId"]);
    clientInstanceId = first(session, ["clientInstanceId"]) ?? first(transport, ["clientInstanceId"]); sessionRef = first(session, ["realtimeSessionRef"]);
    leaseRef = first(lease, ["deviceLeaseRef"]); continuityId = first(session, ["continuityId"]); purpose = first(lease, ["purpose"]);
    epoch = first(session, ["connectionEpoch"]); leaseVersion = first(lease, ["leaseVersion"]); sessionState = first(session, ["state"]);
    continuityState = first(session, ["continuityState"]); transportState = first(transport, ["state"]); leaseState = first(lease, ["state"]);
    continuityExpiresAt = first(session, ["continuityExpiresAt"]); leaseExpiresAt = first(lease, ["expiresAt"]);
  } else {
    userId = own(root, "userId", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); sessionId = own(root, "sessionId", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    deviceId = own(root, "deviceId", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); clientInstanceId = own(root, "clientInstanceId", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    sessionRef = own(root, "realtimeSessionRef", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); leaseRef = own(root, "deviceLeaseRef", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    continuityId = own(root, "continuityId", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); purpose = own(root, "purpose", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    epoch = own(root, "connectionEpoch", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); leaseVersion = own(root, "leaseVersion", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    sessionState = own(root, "sessionState", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); continuityState = own(root, "continuityState", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    transportState = own(root, "transportState", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); leaseState = own(root, "leaseState", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
    continuityExpiresAt = own(root, "continuityExpiresAt", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"); leaseExpiresAt = own(root, "leaseExpiresAt", "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID");
  }
  const normalized: CurrentBinding = Object.freeze({
    userId: bounded(userId, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), sessionId: bounded(sessionId, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"),
    deviceId: bounded(deviceId, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), clientInstanceId: bounded(clientInstanceId, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"),
    realtimeSessionRef: snapshot(sessionRef, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), deviceLeaseRef: snapshot(leaseRef, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"),
    continuityId: bounded(continuityId, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), purpose: bounded(purpose, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"),
    connectionEpoch: bounded(epoch, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID", 38), leaseVersion: bounded(leaseVersion, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID", 38),
    sessionState: bounded(sessionState, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID", 32), continuityState: bounded(continuityState, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID", 32),
    transportState: bounded(transportState, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID", 32), leaseState: bounded(leaseState, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID", 32),
    continuityExpiresAt: timestamp(continuityExpiresAt, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"), leaseExpiresAt: timestamp(leaseExpiresAt, "T03_MEMORY_AUTHORITY_CURRENT_BINDING_INVALID"),
  });
  internalRef(normalized.realtimeSessionRef, "RealtimeSession"); internalRef(normalized.deviceLeaseRef, "DeviceLease");
  if (!DECIMAL.test(normalized.connectionEpoch) || !DECIMAL.test(normalized.leaseVersion) || normalized.sessionState !== "active" || normalized.continuityState !== "active" || normalized.transportState !== "connected" || normalized.leaseState !== "active") fail("T03_MEMORY_AUTHORITY_CURRENT_BINDING_INACTIVE");
  return normalized;
}

function assertCurrent(record: AuthorityRecord, current: CurrentBinding, serverBinding?: ProductionMemoryReadyBinding): void {
  if (current.userId !== record.userId || current.deviceId !== record.deviceId || current.continuityId !== record.continuityId || current.purpose !== record.purpose ||
      refKey(current.realtimeSessionRef, "RealtimeSession") !== canonicalRefKey(record.realtimeSessionRef)) fail("T03_MEMORY_AUTHORITY_CURRENT_BINDING_DRIFT");
  if (timestampMs(record.expiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID") > timestampMs(current.continuityExpiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID") || timestampMs(record.expiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID") > timestampMs(current.leaseExpiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID")) fail("T03_MEMORY_AUTHORITY_CURRENT_CEILING_INVALID");
  if (serverBinding !== undefined && (serverBinding.userId !== current.userId || serverBinding.sessionId !== current.sessionId || serverBinding.deviceId !== current.deviceId ||
      serverBinding.clientInstanceId !== current.clientInstanceId || serverBinding.continuityId !== current.continuityId || serverBinding.purpose !== current.purpose ||
      refKey(serverBinding.realtimeSessionRef, "RealtimeSession") !== refKey(current.realtimeSessionRef, "RealtimeSession"))) fail("T03_MEMORY_AUTHORITY_CURRENT_BINDING_DRIFT");
}

function normalizeT04(value: unknown, binding: ProductionMemoryReadyBinding, now: string): NormalizedT04 {
  const event = exactObject(value, T04_EVENT_KEYS, "T03_MEMORY_AUTHORITY_T04_INVALID");
  const activity = exactObject(own(event, "activity", "T03_MEMORY_AUTHORITY_T04_INVALID"), T04_ACTIVITY_KEYS, "T03_MEMORY_AUTHORITY_T04_INVALID");
  const receipt = exactObject(own(event, "actionReceipt", "T03_MEMORY_AUTHORITY_T04_INVALID"), T04_RECEIPT_KEYS, "T03_MEMORY_AUTHORITY_T04_INVALID");
  const eventBinding = exactObject(own(event, "currentBinding", "T03_MEMORY_AUTHORITY_T04_INVALID"), T04_BINDING_KEYS, "T03_MEMORY_AUTHORITY_T04_INVALID");
  const projection = exactObject(own(event, "authorityProjection", "T03_MEMORY_AUTHORITY_T04_INVALID"), T04_PROJECTION_KEYS, "T03_MEMORY_AUTHORITY_T04_INVALID");
  const evidenceList = own(projection, "evidence", "T03_MEMORY_AUTHORITY_T04_INVALID");
  if (!Array.isArray(evidenceList) || evidenceList.length !== 1) fail("T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID");
  const evidence = exactObject(evidenceList[0], T04_EVIDENCE_KEYS, "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID");
  const action = own(receipt, "action", "T03_MEMORY_AUTHORITY_T04_ACTION_INVALID");
  if (action !== "button_submit" && action !== "explicit_voice_command") fail("T03_MEMORY_AUTHORITY_T04_ACTION_INVALID");
  const activityId = bounded(own(activity, "activityId", "T03_MEMORY_AUTHORITY_T04_INVALID"), "T03_MEMORY_AUTHORITY_T04_INVALID");
  const occurredAt = timestamp(own(activity, "occurredAt", "T03_MEMORY_AUTHORITY_T04_INVALID"), "T03_MEMORY_AUTHORITY_T04_INVALID");
  if (timestampMs(occurredAt, "T03_MEMORY_AUTHORITY_T04_INVALID") > timestampMs(now, "T03_MEMORY_AUTHORITY_T04_INVALID") || own(activity, "kind", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "accepted_user_activity" || own(activity, "accepted", "T03_MEMORY_AUTHORITY_T04_INVALID") !== true ||
      own(receipt, "kind", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "t04.accepted_user_action_receipt" || own(receipt, "activityId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== activityId || own(receipt, "origin", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "iphone" || own(receipt, "purpose", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.purpose ||
      own(receipt, "committed", "T03_MEMORY_AUTHORITY_T04_INVALID") !== true || own(receipt, "revoked", "T03_MEMORY_AUTHORITY_T04_INVALID") !== false || own(receipt, "deleted", "T03_MEMORY_AUTHORITY_T04_INVALID") !== false || own(receipt, "stale", "T03_MEMORY_AUTHORITY_T04_INVALID") !== false ||
      own(projection, "kind", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "t04.activity_authority_projection" || own(projection, "environment", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "production" || own(projection, "origin", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "user" || own(projection, "userOriginated", "T03_MEMORY_AUTHORITY_T04_INVALID") !== true ||
      own(projection, "accepted", "T03_MEMORY_AUTHORITY_T04_INVALID") !== true || own(projection, "current", "T03_MEMORY_AUTHORITY_T04_INVALID") !== true || own(projection, "deleted", "T03_MEMORY_AUTHORITY_T04_INVALID") !== false || own(projection, "suppressed", "T03_MEMORY_AUTHORITY_T04_INVALID") !== false || own(projection, "stale", "T03_MEMORY_AUTHORITY_T04_INVALID") !== false || own(projection, "watermarkCurrent", "T03_MEMORY_AUTHORITY_T04_INVALID") !== true ||
      own(projection, "activityId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== activityId || own(projection, "userId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.userId || own(projection, "deviceId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.deviceId || own(projection, "purpose", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.purpose ||
      own(eventBinding, "userId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.userId || own(eventBinding, "activeDeviceId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.deviceId || own(eventBinding, "continuityId", "T03_MEMORY_AUTHORITY_T04_INVALID") !== binding.continuityId || own(eventBinding, "sessionState", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "active" || own(eventBinding, "continuityState", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "active" || own(eventBinding, "transportState", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "connected" || own(eventBinding, "leaseState", "T03_MEMORY_AUTHORITY_T04_INVALID") !== "active") fail("T03_MEMORY_AUTHORITY_T04_INVALID");
  const acceptanceWire = snapshot(own(activity, "acceptanceRef", "T03_MEMORY_AUTHORITY_T04_INVALID"), "T03_MEMORY_AUTHORITY_T04_INVALID");
  const acceptanceRef = internalRef(acceptanceWire, "ContextAssertion");
  const projectionAcceptance = snapshot(own(projection, "acceptanceRef", "T03_MEMORY_AUTHORITY_T04_INVALID"), "T03_MEMORY_AUTHORITY_T04_INVALID");
  const evidenceRef = snapshot(own(evidence, "evidenceRef", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID"), "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID");
  if (own(evidence, "kind", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== "ContextAssertion" || own(evidence, "activityId", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== activityId || own(evidence, "userOriginated", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== true || own(evidence, "authority", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== true || own(evidence, "current", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== true || own(evidence, "deleted", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== false || own(evidence, "suppressed", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== false || own(evidence, "stale", "T03_MEMORY_AUTHORITY_T04_EVIDENCE_INVALID") !== false || canonicalRefKey(internalRef(projectionAcceptance, "ContextAssertion")) !== canonicalRefKey(acceptanceRef) || canonicalRefKey(internalRef(evidenceRef, "ContextAssertion")) !== canonicalRefKey(acceptanceRef) || refKey(own(activity, "realtimeSessionRef", "T03_MEMORY_AUTHORITY_T04_INVALID"), "RealtimeSession") !== refKey(binding.realtimeSessionRef, "RealtimeSession") || refKey(own(projection, "realtimeSessionRef", "T03_MEMORY_AUTHORITY_T04_INVALID"), "RealtimeSession") !== refKey(binding.realtimeSessionRef, "RealtimeSession")) fail("T03_MEMORY_AUTHORITY_T04_BINDING_DRIFT");
  return Object.freeze({
    activityId,
    action: action as T04Action,
    occurredAt,
    acceptanceRef,
    acceptanceRefWire: acceptanceWire,
    contextAssertionHash: digest(jcsSerialize(evidence)),
    acceptanceRefHash: digest(jcsSerialize(acceptanceWire)),
    event: value,
  });
}

function actionGrant(record: AuthorityRecord, action: Action): ActionGrant {
  const grant = record.actionGrants.find((item) => item.action === action);
  if (grant === undefined) fail("T03_MEMORY_AUTHORITY_ACTION_NOT_GRANTED");
  return grant;
}

function actionGrantWatermark(grant: ActionGrant): ActionGrantWatermark {
  return Object.freeze({ governance_ref: grant.governanceRef, consent_record_ref: grant.consentRecordRef, purpose_token_ref: grant.purposeTokenRef, capability_grant_ref: grant.capabilityGrantRef });
}

function buildWatermark(input: { readonly action: Action; readonly record: AuthorityRecord; readonly binding: ProductionMemoryReadyBinding; readonly t04: NormalizedT04; readonly slotSha256: string; readonly newValueSha256: string; readonly grant: ActionGrant }): PairWatermark {
  const base = {
    record_sha256: input.record.recordSha256,
    binding_sha256: digest(jcsSerialize(input.binding)),
    activity_id: input.t04.activityId,
    activity_idempotency_key: input.t04.activityId,
    acceptance_ref_sha256: input.t04.acceptanceRefHash,
    context_assertion_sha256: input.t04.contextAssertionHash,
    slot_sha256: input.slotSha256,
    new_value_sha256: input.newValueSha256,
  };
  return Object.freeze({ schema: "paios.t03.production_memory_lifecycle_watermark.v1", action: input.action, ...base, pair_fingerprint: digest(jcsSerialize(base)), action_grant_refs: actionGrantWatermark(input.grant) });
}

function parseWatermark(value: unknown): PairWatermark {
  const object = exactObject(value, WATERMARK_KEYS, "T03_MEMORY_AUTHORITY_WATERMARK_INVALID");
  const action = own(object, "action", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID");
  if (action !== "correct_memory" && action !== "recall_for_answer_context") fail("T03_MEMORY_AUTHORITY_WATERMARK_INVALID");
  const refs = exactObject(own(object, "action_grant_refs", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), WATERMARK_REF_KEYS, "T03_MEMORY_AUTHORITY_WATERMARK_INVALID");
  const parsed = Object.freeze({
    schema: own(object, "schema", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), action: action as Action,
    record_sha256: own(object, "record_sha256", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), binding_sha256: own(object, "binding_sha256", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"),
    activity_id: bounded(own(object, "activity_id", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), activity_idempotency_key: bounded(own(object, "activity_idempotency_key", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"),
    acceptance_ref_sha256: own(object, "acceptance_ref_sha256", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), context_assertion_sha256: own(object, "context_assertion_sha256", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"),
    slot_sha256: own(object, "slot_sha256", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), new_value_sha256: own(object, "new_value_sha256", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), pair_fingerprint: own(object, "pair_fingerprint", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"),
    action_grant_refs: Object.freeze({
      governance_ref: normalizedRef(own(refs, "governance_ref", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), "PolicyDecision"),
      consent_record_ref: normalizedRef(own(refs, "consent_record_ref", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), "ConsentRecord"),
      purpose_token_ref: normalizedRef(own(refs, "purpose_token_ref", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), "PurposeToken"),
      capability_grant_ref: normalizedRef(own(refs, "capability_grant_ref", "T03_MEMORY_AUTHORITY_WATERMARK_INVALID"), "CapabilityGrant"),
    }),
  });
  if (parsed.schema !== "paios.t03.production_memory_lifecycle_watermark.v1" || ![parsed.record_sha256, parsed.binding_sha256, parsed.acceptance_ref_sha256, parsed.context_assertion_sha256, parsed.slot_sha256, parsed.new_value_sha256, parsed.pair_fingerprint].every((item) => typeof item === "string" && SHA256.test(item)) || parsed.activity_id !== parsed.activity_idempotency_key) fail("T03_MEMORY_AUTHORITY_WATERMARK_INVALID");
  return parsed as PairWatermark;
}

function normalizeReceipt(value: unknown): ProductionMemoryLifecycleAuthorityReceipt {
  const receipt = exactObject(value, RECEIPT_KEYS, "T03_MEMORY_AUTHORITY_RECEIPT_INVALID");
  const action = own(receipt, "action", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID");
  if (action !== "correct_memory" && action !== "recall_for_answer_context") fail("T03_MEMORY_AUTHORITY_RECEIPT_INVALID");
  const binding = bindingCopy(own(receipt, "binding", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"));
  const requestedAt = timestamp(own(receipt, "requestedAt", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"), "T03_MEMORY_AUTHORITY_RECEIPT_INVALID");
  const authorizedAt = timestamp(own(receipt, "authorizedAt", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"), "T03_MEMORY_AUTHORITY_RECEIPT_INVALID");
  let governanceRef: CanonicalObjectVersionRef;
  try { governanceRef = Object.freeze(assertCanonicalObjectVersionRef(own(receipt, "governanceRef", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"))); } catch (error) { return fail("T03_MEMORY_AUTHORITY_RECEIPT_INVALID", error); }
  return Object.freeze({
    kind: own(receipt, "kind", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID") as "production_memory_lifecycle_authority_receipt",
    action: action as ProductionMemoryLifecycleAction,
    requestId: bounded(own(receipt, "requestId", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"), "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"),
    idempotencyKey: bounded(own(receipt, "idempotencyKey", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"), "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"),
    binding,
    governanceRef,
    requestedAt,
    authorizedAt,
    authorityWatermark: snapshot(own(receipt, "authorityWatermark", "T03_MEMORY_AUTHORITY_RECEIPT_INVALID"), "T03_MEMORY_AUTHORITY_RECEIPT_INVALID") as unknown as AuthorityWatermark,
  });
}

function normalizeEnvelope(value: unknown): ProductionMemoryLifecycleEnvelope {
  const envelope = exactObject(value, ENVELOPE_KEYS, "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID");
  let governanceRef: CanonicalObjectVersionRef;
  try { governanceRef = Object.freeze(assertCanonicalObjectVersionRef(own(envelope, "governanceRef", "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"))); } catch (error) { return fail("T03_MEMORY_AUTHORITY_ENVELOPE_INVALID", error); }
  return Object.freeze({
    requestId: bounded(own(envelope, "requestId", "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"), "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"),
    idempotencyKey: bounded(own(envelope, "idempotencyKey", "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"), "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"),
    binding: bindingCopy(own(envelope, "binding", "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID")), governanceRef,
    requestedAt: timestamp(own(envelope, "requestedAt", "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"), "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID"),
    authorityReceipt: normalizeReceipt(own(envelope, "authorityReceipt", "T03_MEMORY_AUTHORITY_ENVELOPE_INVALID")),
  });
}

function buildReceipt(action: Action, requestId: string, idempotencyKey: string, binding: ProductionMemoryReadyBinding, grant: ActionGrant, requestedAt: string, watermark: PairWatermark): ProductionMemoryLifecycleAuthorityReceipt {
  return Object.freeze({ kind: "production_memory_lifecycle_authority_receipt" as const, action, requestId, idempotencyKey, binding, governanceRef: grant.governanceRef, requestedAt, authorizedAt: requestedAt, authorityWatermark: watermark as unknown as AuthorityWatermark });
}

function buildEnvelope(action: Action, binding: ProductionMemoryReadyBinding, grant: ActionGrant, requestedAt: string, watermark: PairWatermark): ProductionMemoryLifecycleEnvelope {
  const requestId = `t03_memory_${watermark.pair_fingerprint}`;
  const idempotencyKey = `t03_memory_${watermark.pair_fingerprint}:${action}`;
  return Object.freeze({ requestId, idempotencyKey, binding, governanceRef: grant.governanceRef, requestedAt, authorityReceipt: buildReceipt(action, requestId, idempotencyKey, binding, grant, requestedAt, watermark) });
}

function invalidOwnerResult(): OwnerPortResult<ProductionMemoryLifecycleAuthorityReceipt> {
  const error: MemoryCommandError = Object.freeze({ code: "OWNER_STATE_INVALID", retryable: false });
  return Object.freeze({ ok: false as const, error });
}

export function createT03ProductionMemoryLifecycleAuthority(options: T03ProductionMemoryLifecycleAuthorityOptions): T03ProductionMemoryLifecycleAuthorityOwner {
  if (options === null || typeof options !== "object" || options.record === undefined || options.record.path !== T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH || typeof options.record.read !== "function" || typeof options.record.expectedSha256 !== "string" || typeof options.ownerProtection?.assertOwnerProtected !== "function" || typeof options.currentBinding?.readCurrentBinding !== "function" || typeof options.acceptedActivity?.read !== "function" || typeof options.clock?.now !== "function") fail("T03_MEMORY_AUTHORITY_OPTIONS_INVALID");
  let closed = false;
  const readRecord = async (): Promise<AuthorityRecord> => {
    if (!SHA256.test(options.record.expectedSha256)) fail("T03_MEMORY_AUTHORITY_EXPECTED_HASH_INVALID");
    try { await options.ownerProtection.assertOwnerProtected(options.record.path); } catch (error) { fail("T03_MEMORY_AUTHORITY_OWNER_PROTECTION_FAILED", error); }
    let bytes: Uint8Array | undefined;
    try { bytes = await options.record.read(); } catch (error) { fail("T03_MEMORY_AUTHORITY_RECORD_READ_FAILED", error); }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_RECORD_BYTES) fail("T03_MEMORY_AUTHORITY_RECORD_BYTES_INVALID");
    const copy = new Uint8Array(bytes);
    if (!sameDigest(digest(copy), options.record.expectedSha256)) fail("T03_MEMORY_AUTHORITY_RECORD_HASH_INVALID");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(copy); } catch (error) { fail("T03_MEMORY_AUTHORITY_RECORD_UTF8_INVALID", error); }
    if (!text.endsWith("\n") || text.includes("\r") || text.slice(0, -1).includes("\n") || text.charCodeAt(0) === 0xfeff) fail("T03_MEMORY_AUTHORITY_RECORD_ENCODING_INVALID");
    let parsed: unknown;
    try { parsed = JSON.parse(text.slice(0, -1)) as unknown; if (`${jcsSerialize(parsed)}\n` !== text) fail("T03_MEMORY_AUTHORITY_RECORD_CANONICAL_INVALID"); } catch (error) { if (error instanceof T03ProductionMemoryLifecycleAuthorityError) throw error; fail("T03_MEMORY_AUTHORITY_RECORD_JSON_INVALID", error); }
    return normalizeRecord(parsed, options.record.expectedSha256);
  };
  const readCurrent = async (sessionRef: OpaqueCanonicalRef): Promise<CurrentBinding> => {
    let value: unknown;
    try { value = await options.currentBinding.readCurrentBinding({ realtimeSessionRef: sessionRef }); } catch (error) { fail("T03_MEMORY_AUTHORITY_CURRENT_BINDING_UNAVAILABLE", error); }
    if (value === undefined) fail("T03_MEMORY_AUTHORITY_CURRENT_BINDING_MISSING");
    return normalizeCurrentBinding(value);
  };
  const readT04 = async (activityId: string, sessionRef: OpaqueCanonicalRef): Promise<unknown> => {
    let value: unknown;
    try { value = await options.acceptedActivity.read({ activityId, idempotencyKey: activityId, realtimeSessionRef: sessionRef }); } catch (error) { fail("T03_MEMORY_AUTHORITY_T04_READ_FAILED", error); }
    if (value === undefined) fail("T03_MEMORY_AUTHORITY_T04_MISSING");
    return value;
  };
  const now = (): string => clockNow(options.clock);
  const verifyInternal = async (action: Action, rawEnvelope: ProductionMemoryLifecycleEnvelope): Promise<OwnerPortResult<ProductionMemoryLifecycleAuthorityReceipt>> => {
    if (closed) return invalidOwnerResult();
    try {
      const envelope = normalizeEnvelope(rawEnvelope);
      if (envelope.authorityReceipt.action !== action || canonicalRefKey(envelope.governanceRef) !== canonicalRefKey(envelope.authorityReceipt.governanceRef) || envelope.requestId !== envelope.authorityReceipt.requestId || envelope.idempotencyKey !== envelope.authorityReceipt.idempotencyKey || envelope.requestedAt !== envelope.authorityReceipt.requestedAt || !sameJson(envelope.binding, envelope.authorityReceipt.binding)) fail("T03_MEMORY_AUTHORITY_RECEIPT_DRIFT");
      const record = await readRecord();
      const current = await readCurrent(record.realtimeSessionRefWire);
      assertCurrent(record, current, envelope.binding);
      const currentNow = now();
      const requestedMs = timestampMs(envelope.requestedAt, "T03_MEMORY_AUTHORITY_TIME_INVALID");
      if (requestedMs < timestampMs(record.issuedAt, "T03_MEMORY_AUTHORITY_TIME_INVALID") || requestedMs >= timestampMs(record.expiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID") || timestampMs(currentNow, "T03_MEMORY_AUTHORITY_TIME_INVALID") >= timestampMs(record.expiresAt, "T03_MEMORY_AUTHORITY_TIME_INVALID")) fail("T03_MEMORY_AUTHORITY_EXPIRED");
      const watermark = parseWatermark(envelope.authorityReceipt.authorityWatermark);
      const grant = actionGrant(record, action);
      const durable = await readT04(watermark.activity_id, envelope.binding.realtimeSessionRef);
      const t04 = normalizeT04(durable, envelope.binding, currentNow);
      if (watermark.action !== action || watermark.record_sha256 !== record.recordSha256 || watermark.activity_id !== t04.activityId || watermark.activity_idempotency_key !== t04.activityId || watermark.acceptance_ref_sha256 !== t04.acceptanceRefHash || watermark.context_assertion_sha256 !== t04.contextAssertionHash || !grant.t04Actions.includes(t04.action) || !sameJson(watermark.action_grant_refs, actionGrantWatermark(grant)) || watermark.binding_sha256 !== digest(jcsSerialize(envelope.binding))) fail("T03_MEMORY_AUTHORITY_WATERMARK_DRIFT");
      const base = { record_sha256: watermark.record_sha256, binding_sha256: watermark.binding_sha256, activity_id: watermark.activity_id, activity_idempotency_key: watermark.activity_idempotency_key, acceptance_ref_sha256: watermark.acceptance_ref_sha256, context_assertion_sha256: watermark.context_assertion_sha256, slot_sha256: watermark.slot_sha256, new_value_sha256: watermark.new_value_sha256 };
      if (watermark.pair_fingerprint !== digest(jcsSerialize(base)) || envelope.requestId !== `t03_memory_${watermark.pair_fingerprint}` || envelope.idempotencyKey !== `t03_memory_${watermark.pair_fingerprint}:${action}` || canonicalRefKey(envelope.governanceRef) !== canonicalRefKey(grant.governanceRef)) fail("T03_MEMORY_AUTHORITY_WATERMARK_DRIFT");
      const expected = buildReceipt(action, envelope.requestId, envelope.idempotencyKey, envelope.binding, grant, envelope.requestedAt, watermark);
      if (!sameJson(expected, envelope.authorityReceipt)) fail("T03_MEMORY_AUTHORITY_RECEIPT_DRIFT");
      return Object.freeze({ ok: true as const, value: expected });
    } catch { return invalidOwnerResult(); }
  };
  const authority: ProductionMemoryLifecycleAuthorityPort = Object.freeze({
    verify: async (input: { readonly action: ProductionMemoryLifecycleAction; readonly envelope: ProductionMemoryLifecycleEnvelope }) => {
      if (input === null || typeof input !== "object" || (input.action !== "correct_memory" && input.action !== "recall_for_answer_context")) return invalidOwnerResult();
      return verifyInternal(input.action, input.envelope);
    },
  });
  const issueEnvelopes = async (input: T03ProductionMemoryLifecycleIssueInput): Promise<T03ProductionMemoryLifecycleIssueResult> => {
    if (closed) fail("T03_MEMORY_AUTHORITY_CLOSED");
    const request = exactObject(input, ["durableAcceptedActivity", "newValueSha256", "requestedAt", "serverCurrentBinding", "slot"], "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID");
    const serverBinding = bindingCopy(own(request, "serverCurrentBinding", "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID"));
    const record = await readRecord();
    const current = await readCurrent(serverBinding.realtimeSessionRef);
    assertCurrent(record, current, serverBinding);
    const requestedAt = timestamp(own(request, "requestedAt", "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID"), "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID");
    const currentNow = now();
    if (timestampMs(requestedAt, "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID") < timestampMs(record.issuedAt, "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID") || timestampMs(requestedAt, "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID") >= timestampMs(record.expiresAt, "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID") || timestampMs(currentNow, "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID") >= timestampMs(record.expiresAt, "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID")) fail("T03_MEMORY_AUTHORITY_EXPIRED");
    const slot = bounded(own(request, "slot", "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID"), "T03_MEMORY_AUTHORITY_SLOT_INVALID");
    const newValueSha256 = bounded(own(request, "newValueSha256", "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID"), "T03_MEMORY_AUTHORITY_VALUE_HASH_INVALID", 64);
    if (!SHA256.test(newValueSha256)) fail("T03_MEMORY_AUTHORITY_VALUE_HASH_INVALID");
    const suppliedEvent = own(request, "durableAcceptedActivity", "T03_MEMORY_AUTHORITY_ISSUE_INPUT_INVALID");
    const suppliedT04 = normalizeT04(suppliedEvent, serverBinding, currentNow);
    const durableEvent = await readT04(suppliedT04.activityId, serverBinding.realtimeSessionRef);
    if (!sameJson(durableEvent, suppliedEvent)) fail("T03_MEMORY_AUTHORITY_T04_REPLAY_DRIFT");
    const correctionGrant = actionGrant(record, "correct_memory");
    const recallGrant = actionGrant(record, "recall_for_answer_context");
    if (!correctionGrant.t04Actions.includes(suppliedT04.action) || !recallGrant.t04Actions.includes(suppliedT04.action)) fail("T03_MEMORY_AUTHORITY_T04_ACTION_INVALID");
    const slotSha256 = digest(slot);
    const correctionWatermark = buildWatermark({ action: "correct_memory", record, binding: serverBinding, t04: suppliedT04, slotSha256, newValueSha256, grant: correctionGrant });
    const recallWatermark = buildWatermark({ action: "recall_for_answer_context", record, binding: serverBinding, t04: suppliedT04, slotSha256, newValueSha256, grant: recallGrant });
    if (correctionWatermark.pair_fingerprint !== recallWatermark.pair_fingerprint) fail("T03_MEMORY_AUTHORITY_PAIR_DRIFT");
    const correctionEnvelope = buildEnvelope("correct_memory", serverBinding, correctionGrant, requestedAt, correctionWatermark);
    const recallEnvelope = buildEnvelope("recall_for_answer_context", serverBinding, recallGrant, requestedAt, recallWatermark);
    const correctionEvidence: ExplicitUserCorrectionEvidence = Object.freeze({ ref: suppliedT04.acceptanceRef, observedAt: suppliedT04.occurredAt });
    return Object.freeze({ correctionEnvelope, recallEnvelope, correctionEvidence });
  };
  const readiness = async (): Promise<boolean> => {
    if (closed) return false;
    try { const record = await readRecord(); const current = await readCurrent(record.realtimeSessionRefWire); assertCurrent(record, current); return true; } catch { return false; }
  };
  const close = async (): Promise<void> => { closed = true; };
  return Object.freeze({ authority, issueEnvelopes, readiness, isReady: readiness, close });
}
