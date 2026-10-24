import { createHash } from "node:crypto";

import type {
  ActivityAcceptancePort,
} from "../../../services/realtime-core/src/ports.ts";
import type { ProductionPortRegistration } from "../../../services/realtime-core/src/production-owner-ports.ts";
import {
  DEVICE_CLOCK_LEAD_MS,
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  snapshotOpaqueOwnerValue,
  type AcceptedUserActivity,
  type CanonicalTimestamp,
  type OpaqueCanonicalRef,
  type RealtimeCurrentBindingProjection,
} from "../../../services/realtime-core/src/types.ts";
import type {
  JsonRecord,
  RealtimeBearerContext,
  RealtimeBootstrapAuthorityResult,
} from "./realtime-public-control-runtime.ts";
import type {
  RealtimeAcceptedUserActivityOwnerEvent,
  RealtimeAcceptedUserActivityOwnerSource,
} from "./realtime-accepted-user-activity-production.ts";
import type { AcceptedActivityRecord } from "../../../services/platform-data/src/accepted-activity-stream.ts";

/** The only user action emitted by the post-connect bootstrap owner. */
export const T04_ACCEPTED_USER_ACTION = "button_submit" as const;
export const T04_EXPLICIT_VOICE_ACTION = "explicit_voice_command" as const;
export type T04AcceptedUserAction = typeof T04_ACCEPTED_USER_ACTION | typeof T04_EXPLICIT_VOICE_ACTION;
export const T04_ACCEPTED_USER_ACTIVITY_PURPOSE = "cycling_assistant" as const;
export const T04_ACCEPTED_USER_ACTIVITY_ORIGIN = "iphone" as const;

type JsonObject = Record<string, unknown>;

/**
 * T02's projection is deliberately accepted as an opaque owner input.  The
 * flat form is useful to callers that already normalized the projection; the
 * nested form is the canonical `readCurrentBinding` result.
 */
export type T04CurrentBindingInput =
  | RealtimeCurrentBindingProjection
  | Readonly<Record<string, unknown>>;

export interface T04AcceptedUserActivityEventInput {
  /** Already authenticated/validated request; action and authority fields are ignored. */
  readonly request: JsonRecord;
  /** Already verified bearer context; identity is taken from the owner binding. */
  readonly bearer: RealtimeBearerContext;
  /** T03 decision projection supplied by the runtime, never read from request. */
  readonly governance: JsonRecord;
  /** T11B/T02 result returned after a successful participant connection. */
  readonly authority: RealtimeBootstrapAuthorityResult;
  /** Fresh T02 current-binding read, not a client-provided body value. */
  readonly currentBinding: T04CurrentBindingInput;
  /** Deterministic test clock in epoch milliseconds. */
  readonly now?: number;
  readonly action?: T04AcceptedUserAction;
}

export interface T04CurrentBindingSnapshot {
  readonly userId: string;
  readonly activeDeviceId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly sessionState: "active";
  readonly continuityState: "active";
  readonly transportState: "connected";
  readonly leaseState: "active";
  readonly lastAcceptedUserActivityAt: CanonicalTimestamp;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly leaseExpiresAt: CanonicalTimestamp;
}

export interface T04ActionReceipt {
  readonly kind: "t04.accepted_user_action_receipt";
  readonly activityId: string;
  readonly action: T04AcceptedUserAction;
  readonly purpose: typeof T04_ACCEPTED_USER_ACTIVITY_PURPOSE;
  readonly origin: typeof T04_ACCEPTED_USER_ACTIVITY_ORIGIN;
  readonly committed: true;
  readonly revoked: false;
  readonly deleted: false;
  readonly stale: false;
  readonly bindingCommitted: false;
}

export interface T04AuthorityEvidence {
  readonly kind: "ContextAssertion";
  readonly evidenceRef: OpaqueCanonicalRef;
  readonly activityId: string;
  readonly userOriginated: true;
  readonly authority: true;
  readonly current: true;
  readonly deleted: false;
  readonly suppressed: false;
  readonly stale: false;
}

export interface T04AuthorityProjection {
  readonly kind: "t04.activity_authority_projection";
  readonly environment: "production";
  readonly activityId: string;
  readonly origin: "user";
  readonly userOriginated: true;
  readonly accepted: true;
  readonly current: true;
  readonly deleted: false;
  readonly suppressed: false;
  readonly stale: false;
  readonly purpose: typeof T04_ACCEPTED_USER_ACTIVITY_PURPOSE;
  readonly userId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly sessionTime: CanonicalTimestamp;
  readonly acceptanceRef: OpaqueCanonicalRef;
  readonly authorityWatermark: Readonly<{ readonly kind: "t04.authority_watermark"; readonly value: string }>;
  readonly watermarkCurrent: true;
  readonly evidence: readonly [T04AuthorityEvidence];
}

export type T04AcceptedUserActivityOwnerEvent = RealtimeAcceptedUserActivityOwnerEvent & {
  readonly activity: AcceptedUserActivity;
  readonly actionReceipt: T04ActionReceipt;
  readonly currentBinding: T04CurrentBindingSnapshot;
  readonly authorityProjection: T04AuthorityProjection;
};

export class RealtimePublicControlT04OwnerError extends Error {
  readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "RealtimePublicControlT04OwnerError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlT04OwnerError(code);
}

function plain(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail(code);
  return value as JsonObject;
}

function own(value: unknown, key: string): unknown {
  return plain(value, "T04_OWNER_VALUE_INVALID")[key];
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown, code: string): CanonicalTimestamp {
  try {
    return assertCanonicalTimestamp(value);
  } catch {
    return fail(code);
  }
}

function opaque(value: unknown, code: string): OpaqueCanonicalRef {
  try {
    return snapshotOpaqueOwnerValue(value);
  } catch {
    return fail(code);
  }
}

function exactStringField(
  object: JsonObject,
  names: readonly string[],
  code: string,
): string {
  const values = names.filter((name) => Object.hasOwn(object, name)).map((name) => object[name]);
  if (values.length === 0) fail(code);
  const result = stringValue(values[0], code);
  if (values.slice(1).some((value) => value !== result)) fail(code);
  return result;
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/** Small JCS-compatible encoder for the JSON values admitted by owner refs. */
function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("T04_OWNER_CANONICAL_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) {
    fail("T04_OWNER_CANONICAL_VALUE_INVALID");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      if (Reflect.ownKeys(value).some((key) => typeof key !== "string") || names.length !== value.length + 1) {
        fail("T04_OWNER_CANONICAL_VALUE_INVALID");
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const object = plain(value, "T04_OWNER_CANONICAL_VALUE_INVALID");
    const keys = Object.keys(object).sort();
    if (Object.getOwnPropertyNames(object).length !== keys.length) fail("T04_OWNER_CANONICAL_VALUE_INVALID");
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || descriptor.enumerable !== true || descriptor.get !== undefined ||
          descriptor.set !== undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        fail("T04_OWNER_CANONICAL_VALUE_INVALID");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidV7(at: CanonicalTimestamp, digest: string): string {
  const milliseconds = Date.parse(at);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xffffffffffff) {
    fail("T04_OWNER_TIMESTAMP_INVALID");
  }
  if (!/^[0-9a-f]{64}$/u.test(digest)) fail("T04_OWNER_DIGEST_INVALID");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  }
  let time = BigInt(milliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface NormalizedBinding {
  readonly userId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly sessionState: unknown;
  readonly continuityState: unknown;
  readonly transportState: unknown;
  readonly leaseState: unknown;
  readonly lastAcceptedUserActivityAt: CanonicalTimestamp;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly leaseExpiresAt: CanonicalTimestamp;
}

function normalizedFlatBinding(value: JsonObject): NormalizedBinding {
  const userId = stringValue(value.userId, "T04_OWNER_BINDING_INVALID");
  const deviceId = stringValue(value.activeDeviceId ?? value.deviceId, "T04_OWNER_BINDING_INVALID");
  const realtimeSessionRef = opaque(value.realtimeSessionRef, "T04_OWNER_BINDING_INVALID");
  const deviceLeaseRef = opaque(value.deviceLeaseRef, "T04_OWNER_BINDING_INVALID");
  const continuityId = stringValue(value.continuityId, "T04_OWNER_BINDING_INVALID");
  const connectionEpoch = assertDecimalConnectionEpoch(value.connectionEpoch);
  return Object.freeze({
    userId,
    deviceId,
    realtimeSessionRef,
    deviceLeaseRef,
    continuityId,
    connectionEpoch,
    sessionState: value.sessionState,
    continuityState: value.continuityState,
    transportState: value.transportState,
    leaseState: value.leaseState,
    lastAcceptedUserActivityAt: timestamp(value.lastAcceptedUserActivityAt, "T04_OWNER_BINDING_INVALID"),
    continuityExpiresAt: timestamp(value.continuityExpiresAt, "T04_OWNER_BINDING_INVALID"),
    leaseExpiresAt: timestamp(value.leaseExpiresAt, "T04_OWNER_BINDING_INVALID"),
  });
}

function normalizeBinding(value: T04CurrentBindingInput): NormalizedBinding {
  const input = plain(value, "T04_OWNER_BINDING_INVALID");
  if (Object.hasOwn(input, "session") || Object.hasOwn(input, "lease")) {
    const session = plain(input.session, "T04_OWNER_BINDING_INVALID");
    const lease = plain(input.lease, "T04_OWNER_BINDING_INVALID");
    const transport = plain(session.binding, "T04_OWNER_BINDING_INVALID");
    const sessionRef = opaque(session.realtimeSessionRef, "T04_OWNER_BINDING_INVALID");
    const leaseRef = opaque(lease.deviceLeaseRef, "T04_OWNER_BINDING_INVALID");
    const bindingSessionRef = opaque(transport.realtimeSessionRef, "T04_OWNER_BINDING_INVALID");
    const bindingLeaseRef = opaque(transport.deviceLeaseRef, "T04_OWNER_BINDING_INVALID");
    if (!same(sessionRef, bindingSessionRef) || !same(leaseRef, bindingLeaseRef)) {
      fail("T04_OWNER_BINDING_LINKAGE_INVALID");
    }
    return Object.freeze({
      userId: stringValue(session.userId, "T04_OWNER_BINDING_INVALID"),
      deviceId: stringValue(session.activeDeviceId, "T04_OWNER_BINDING_INVALID"),
      realtimeSessionRef: sessionRef,
      deviceLeaseRef: leaseRef,
      continuityId: stringValue(session.continuityId, "T04_OWNER_BINDING_INVALID"),
      connectionEpoch: assertDecimalConnectionEpoch(session.connectionEpoch),
      sessionState: session.state,
      continuityState: session.continuityState,
      transportState: transport.state,
      leaseState: lease.state,
      lastAcceptedUserActivityAt: timestamp(session.lastAcceptedUserActivityAt, "T04_OWNER_BINDING_INVALID"),
      continuityExpiresAt: timestamp(session.continuityExpiresAt, "T04_OWNER_BINDING_INVALID"),
      leaseExpiresAt: timestamp(lease.expiresAt, "T04_OWNER_BINDING_INVALID"),
    });
  }
  return normalizedFlatBinding(input);
}

function outputBinding(binding: NormalizedBinding): T04CurrentBindingSnapshot {
  return Object.freeze({
    userId: binding.userId,
    activeDeviceId: binding.deviceId,
    realtimeSessionRef: binding.realtimeSessionRef,
    continuityId: binding.continuityId,
    sessionState: "active" as const,
    continuityState: "active" as const,
    transportState: "connected" as const,
    leaseState: "active" as const,
    lastAcceptedUserActivityAt: binding.lastAcceptedUserActivityAt,
    continuityExpiresAt: binding.continuityExpiresAt,
    leaseExpiresAt: binding.leaseExpiresAt,
  });
}

function validateBinding(
  input: T04AcceptedUserActivityEventInput,
  requestOccurredAt: CanonicalTimestamp,
  sessionRef: OpaqueCanonicalRef,
  leaseRef: OpaqueCanonicalRef,
  continuityId: string,
  epoch: string,
): NormalizedBinding {
  const binding = normalizeBinding(input.currentBinding);
  if (binding.sessionState !== "active" || binding.continuityState !== "active" ||
      binding.transportState !== "connected" || binding.leaseState !== "active") {
    fail("T04_OWNER_BINDING_STATE_INVALID");
  }
  if (!same(binding.realtimeSessionRef, sessionRef) || !same(binding.deviceLeaseRef, leaseRef) ||
      binding.continuityId !== continuityId || binding.connectionEpoch !== epoch) {
    fail("T04_OWNER_BINDING_AUTHORITY_MISMATCH");
  }
  const occurredMs = Date.parse(requestOccurredAt);
  const lastAcceptedMs = Date.parse(binding.lastAcceptedUserActivityAt);
  const nowMs = input.now ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || occurredMs > nowMs + DEVICE_CLOCK_LEAD_MS || lastAcceptedMs > occurredMs) {
    fail("T04_OWNER_ACTIVITY_TIME_INVALID");
  }
  if (Date.parse(binding.continuityExpiresAt) <= nowMs || Date.parse(binding.leaseExpiresAt) <= nowMs) {
    fail("T04_OWNER_BINDING_EXPIRED");
  }
  return binding;
}

function validateAuthority(input: T04AcceptedUserActivityEventInput): {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: CanonicalTimestamp;
  readonly sessionRef: OpaqueCanonicalRef;
  readonly leaseRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly epoch: string;
  readonly continuityExpiresAt: CanonicalTimestamp;
  readonly authorityGovernance: unknown;
} {
  const request = plain(input.request, "T04_OWNER_REQUEST_INVALID");
  const authority = plain(input.authority, "T04_OWNER_AUTHORITY_INVALID");
  const { requestId, idempotencyKey, startedAt } = bootstrapActivityFields(request);
  const occurredAt = timestamp(startedAt, "T04_OWNER_ACTIVITY_TIME_INVALID");
  const sessionRef = opaque(authority.realtime_session_ref, "T04_OWNER_AUTHORITY_INVALID");
  const leaseRef = opaque(authority.device_lease_ref, "T04_OWNER_AUTHORITY_INVALID");
  const continuityId = stringValue(authority.continuity_id, "T04_OWNER_AUTHORITY_INVALID");
  const epoch = assertDecimalConnectionEpoch(authority.connection_epoch);
  const continuityExpiresAt = timestamp(authority.continuity_expires_at, "T04_OWNER_AUTHORITY_INVALID");
  timestamp(authority.credential_expires_at, "T04_OWNER_AUTHORITY_INVALID");
  const authorityGovernance = opaque(authority.governance, "T04_OWNER_AUTHORITY_INVALID");
  if (!same(authorityGovernance, opaque(input.governance, "T04_OWNER_GOVERNANCE_INVALID"))) {
    fail("T04_OWNER_GOVERNANCE_MISMATCH");
  }
  const requestedUser = request.user_id ?? request.userId;
  if (requestedUser !== undefined && requestedUser !== undefined &&
      typeof requestedUser !== "string") fail("T04_OWNER_REQUEST_IDENTITY_INVALID");
  const requestedDevice = request.device_id ?? request.deviceId;
  if (requestedDevice !== undefined && typeof requestedDevice !== "string") fail("T04_OWNER_REQUEST_IDENTITY_INVALID");
  return Object.freeze({
    requestId,
    idempotencyKey,
    occurredAt,
    sessionRef,
    leaseRef,
    continuityId,
    epoch,
    continuityExpiresAt,
    authorityGovernance,
  });
}

/**
 * Pure T04 post-connect event builder.  It consumes only the already-validated
 * request/authority and a fresh T02 binding projection; it does not persist,
 * publish, read process state, or derive authority from request action fields.
 */
export function buildT04AcceptedUserActivityEvent(
  input: T04AcceptedUserActivityEventInput,
): T04AcceptedUserActivityOwnerEvent {
  const authority = validateAuthority(input);
  const bearer = plain(input.bearer, "T04_OWNER_BEARER_INVALID");
  const binding = validateBinding(
    input,
    authority.occurredAt,
    authority.sessionRef,
    authority.leaseRef,
    authority.continuityId,
    authority.epoch,
  );
  const bearerDeviceId = stringValue(bearer.deviceId, "T04_OWNER_BEARER_INVALID");
  if (bearerDeviceId !== binding.deviceId) fail("T04_OWNER_BEARER_DEVICE_MISMATCH");
  const request = plain(input.request, "T04_OWNER_REQUEST_INVALID");
  for (const key of ["user_id", "userId"]) {
    if (Object.hasOwn(request, key) && request[key] !== binding.userId) fail("T04_OWNER_REQUEST_IDENTITY_MISMATCH");
  }
  for (const key of ["device_id", "deviceId"]) {
    if (Object.hasOwn(request, key) && request[key] !== binding.deviceId) fail("T04_OWNER_REQUEST_IDENTITY_MISMATCH");
  }
  const currentBinding = outputBinding(binding);
  const activityId = authority.idempotencyKey;
  const action = input.action ?? T04_ACCEPTED_USER_ACTION;
  if (action !== T04_ACCEPTED_USER_ACTION && action !== T04_EXPLICIT_VOICE_ACTION) {
    fail("T04_OWNER_ACTION_INVALID");
  }
  const assertionPayload = Object.freeze({
    schema: "paios.t04.context_assertion.v1",
    requestId: authority.requestId,
    idempotencyKey: authority.idempotencyKey,
    activityId,
    action,
    origin: T04_ACCEPTED_USER_ACTIVITY_ORIGIN,
    purpose: T04_ACCEPTED_USER_ACTIVITY_PURPOSE,
    occurredAt: authority.occurredAt,
    realtimeSessionRef: authority.sessionRef,
    deviceLeaseRef: authority.leaseRef,
    continuityId: authority.continuityId,
    connectionEpoch: authority.epoch,
    policyRefs: authority.authorityGovernance,
    binding: currentBinding,
  });
  const assertionPayloadHash = sha256(canonicalJson(assertionPayload));
  const acceptanceRef: OpaqueCanonicalRef = Object.freeze({
    ref_type: "ContextAssertion",
    ref_id: uuidV7(authority.occurredAt, assertionPayloadHash),
    object_version: "1",
    canonical_payload_sha256: assertionPayloadHash,
  });
  const watermarkSeed = canonicalJson({
    schema: "paios.t04.authority_watermark.v1",
    activityId,
    requestId: authority.requestId,
    realtimeSessionRef: authority.sessionRef,
    deviceLeaseRef: authority.leaseRef,
    continuityId: authority.continuityId,
    connectionEpoch: authority.epoch,
    acceptanceRef,
  });
  const authorityWatermark = Object.freeze({
    kind: "t04.authority_watermark",
    value: sha256(watermarkSeed),
  });
  const activity: AcceptedUserActivity = Object.freeze({
    activityId,
    kind: "accepted_user_activity" as const,
    userId: binding.userId,
    deviceId: binding.deviceId,
    realtimeSessionRef: authority.sessionRef,
    continuityId: authority.continuityId,
    occurredAt: authority.occurredAt,
    acceptanceRef,
    accepted: true as const,
  });
  const actionReceipt: T04ActionReceipt = Object.freeze({
    kind: "t04.accepted_user_action_receipt",
    activityId,
    action,
    purpose: T04_ACCEPTED_USER_ACTIVITY_PURPOSE,
    origin: T04_ACCEPTED_USER_ACTIVITY_ORIGIN,
    committed: true as const,
    revoked: false as const,
    deleted: false as const,
    stale: false as const,
    bindingCommitted: false as const,
  });
  const authorityProjection: T04AuthorityProjection = Object.freeze({
    kind: "t04.activity_authority_projection",
    environment: "production" as const,
    activityId,
    origin: "user" as const,
    userOriginated: true as const,
    accepted: true as const,
    current: true as const,
    deleted: false as const,
    suppressed: false as const,
    stale: false as const,
    purpose: T04_ACCEPTED_USER_ACTIVITY_PURPOSE,
    userId: binding.userId,
    deviceId: binding.deviceId,
    realtimeSessionRef: authority.sessionRef,
    continuityId: authority.continuityId,
    sessionTime: authority.occurredAt,
    acceptanceRef,
    authorityWatermark,
    watermarkCurrent: true as const,
    evidence: Object.freeze([Object.freeze({
      kind: "ContextAssertion" as const,
      evidenceRef: acceptanceRef,
      activityId,
      userOriginated: true as const,
      authority: true as const,
      current: true as const,
      deleted: false as const,
      suppressed: false as const,
      stale: false as const,
    })] as const),
  });
  return Object.freeze({ activity, actionReceipt, currentBinding, authorityProjection }) as unknown as T04AcceptedUserActivityOwnerEvent;
}

export const T04_OWNER = "T04.accepted-user-activity" as const;

export interface T04BootstrapConnectedInput {
  readonly request: JsonRecord;
  readonly bearer: RealtimeBearerContext;
  readonly governance: JsonRecord;
  readonly authority: RealtimeBootstrapAuthorityResult;
}

interface T04SavedOwnerContext {
  readonly bearer: RealtimeBearerContext;
  readonly governance: JsonRecord;
  readonly authority: Readonly<Pick<RealtimeBootstrapAuthorityResult,
    'realtime_session_ref' | 'device_lease_ref' | 'continuity_id' | 'connection_epoch' |
    'continuity_expires_at' | 'credential_expires_at' | 'governance'>>;
}

export interface T04DurableOwnerWriter {
  readonly write: (event: T04AcceptedUserActivityOwnerEvent) => Promise<unknown>;
  readonly readByIdempotency: (idempotencyKey: string) => Promise<AcceptedActivityRecord | undefined>;
  readonly bind?: () => void;
  readonly readiness?: () => Readonly<{ readonly ready: boolean; readonly reason?: string }>;
  readonly close?: () => void | Promise<void>;
}

export interface T04ProductionOwnerOptions {
  /** T04's real acceptance verifier; no local/test fallback is created. */
  readonly activityAcceptance: ActivityAcceptancePort;
  /** T02 durable accepted-activity stream source; legacy-only sources are rejected. */
  readonly source: RealtimeAcceptedUserActivityOwnerSource;
  /** T02 writer/service facade that persists the full event transactionally. */
  readonly writer: T04DurableOwnerWriter;
  /** Authoritative current-binding read, performed after participant connection. */
  readonly readCurrentBinding: (
    input: T04BootstrapConnectedInput,
  ) => T04CurrentBindingInput | undefined | Promise<T04CurrentBindingInput | undefined>;
  /** T02/T03 owner clock; wall time is used only when this is omitted. */
  readonly now?: () => number;
  /** Optional owner preflight (migration/LISTEN/issuer checks); never a readiness stub. */
  readonly preflight?: () => void | Promise<void>;
}

export interface T04ProductionOwner {
  readonly activityAcceptance: ProductionPortRegistration<ActivityAcceptancePort>;
  readonly source: RealtimeAcceptedUserActivityOwnerSource;
  readonly onBootstrapConnected: (input: T04BootstrapConnectedInput) => Promise<void>;
  readonly recordUserAction: (input: Readonly<{
    readonly action: T04AcceptedUserAction;
    readonly activityId: string;
    readonly occurredAt?: CanonicalTimestamp;
  }>) => Promise<void>;
  readonly preflight: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function durableEvent(record: AcceptedActivityRecord): T04AcceptedUserActivityOwnerEvent {
  if (record.eventType !== "realtime.t04.accepted_user_activity.v1" ||
      record.actionReceipt === undefined || record.currentBinding === undefined ||
      record.authorityProjection === undefined) {
    fail("T04_OWNER_DURABLE_EVENT_INVALID");
  }
  const activity = Object.freeze({
    activityId: record.activityId,
    kind: "accepted_user_activity" as const,
    userId: record.userId,
    deviceId: record.deviceId,
    realtimeSessionRef: record.realtimeSessionRef,
    continuityId: record.continuityId,
    occurredAt: record.occurredAt,
    acceptanceRef: record.acceptanceRef,
    accepted: true as const,
  });
  return Object.freeze({
    activity,
    actionReceipt: record.actionReceipt,
    currentBinding: record.currentBinding,
    authorityProjection: record.authorityProjection,
  }) as unknown as T04AcceptedUserActivityOwnerEvent;
}

function assertDurableEvent(value: unknown): T04AcceptedUserActivityOwnerEvent {
  const event = plain(value, "T04_OWNER_DURABLE_EVENT_INVALID");
  const activity = plain(event.activity, "T04_OWNER_DURABLE_EVENT_INVALID");
  const receipt = plain(event.actionReceipt, "T04_OWNER_DURABLE_EVENT_INVALID");
  const binding = plain(event.currentBinding, "T04_OWNER_DURABLE_EVENT_INVALID");
  const projection = plain(event.authorityProjection, "T04_OWNER_DURABLE_EVENT_INVALID");
  if (activity.kind !== "accepted_user_activity" || activity.accepted !== true ||
      receipt.kind !== "t04.accepted_user_action_receipt" ||
      receipt.action !== T04_ACCEPTED_USER_ACTION && receipt.action !== T04_EXPLICIT_VOICE_ACTION ||
      receipt.origin !== T04_ACCEPTED_USER_ACTIVITY_ORIGIN || receipt.purpose !== T04_ACCEPTED_USER_ACTIVITY_PURPOSE ||
      projection.kind !== "t04.activity_authority_projection" || projection.environment !== "production" ||
      projection.activityId !== activity.activityId || projection.acceptanceRef === undefined ||
      !Array.isArray(projection.evidence) || projection.evidence.length !== 1 ||
      plain(projection.evidence[0], "T04_OWNER_DURABLE_EVENT_INVALID").kind !== "ContextAssertion") {
    fail("T04_OWNER_DURABLE_EVENT_INVALID");
  }
  if (binding.sessionState !== "active" || binding.continuityState !== "active" ||
      binding.transportState !== "connected" || binding.leaseState !== "active") {
    fail("T04_OWNER_DURABLE_EVENT_INVALID");
  }
  return event as unknown as T04AcceptedUserActivityOwnerEvent;
}

function idempotencyKeyFromRequest(request: JsonRecord): string {
  return bootstrapActivityFields(request).idempotencyKey;
}

/**
 * Two producers: the canonical bootstrap request (realtime-bootstrap-request.v1, the user's explicit start) and
 * recordUserAction's own action request ({request_id, idempotency_key, occurred_at}).
 */
function bootstrapActivityFields(request: JsonObject): { readonly requestId: string; readonly idempotencyKey: string; readonly startedAt: unknown } {
  const requestId = exactStringField(request, ["request_id"], "T04_OWNER_REQUEST_ID_INVALID");
  if (!Object.hasOwn(request, "start")) {
    return { requestId, idempotencyKey: exactStringField(request, ["idempotency_key"], "T04_OWNER_IDEMPOTENCY_INVALID"),
      startedAt: request.occurred_at };
  }
  const context = plain(request.idempotency_context, "T04_OWNER_IDEMPOTENCY_INVALID");
  const idempotencyKey = exactStringField(context, ["idempotency_key"], "T04_OWNER_IDEMPOTENCY_INVALID");
  const start = plain(request.start, "T04_OWNER_ACTIVITY_TIME_INVALID");
  return { requestId, idempotencyKey, startedAt: start.started_at };
}

function safeReady(probe: (() => boolean) | undefined): boolean {
  if (probe === undefined) return true;
  try { return probe() === true; } catch { return false; }
}

/**
 * Create the T04 production owner around already-created T02/T03 ports.  The
 * owner has no persistence fallback: every accepted event is confirmed by a
 * durable readback from the injected writer before this method resolves.
 */
export function createRealtimePublicControlT04Owner(
  options: T04ProductionOwnerOptions,
): T04ProductionOwner {
  if (options === null || typeof options !== "object" ||
      typeof options.activityAcceptance?.verify !== "function" ||
      options.source === undefined || options.source.environment !== "production" ||
      typeof options.source.isReady !== "function" || typeof options.source.subscribe !== "function" ||
      typeof options.writer?.write !== "function" || typeof options.writer.readByIdempotency !== "function" ||
      typeof options.readCurrentBinding !== "function" ||
      (options.preflight !== undefined && typeof options.preflight !== "function")) {
    fail("T04_OWNER_OPTIONS_INVALID");
  }

  let closed = false;
  let sourceClosed = false;
  let writerBound = false;
  let preflightFlight: Promise<void> | undefined;
  let closeFlight: Promise<void> | undefined;
  let savedOwnerContext: T04SavedOwnerContext | undefined;

  const guard = (): void => {
    if (closed) fail("T04_OWNER_CLOSED");
  };

  const readiness = (): boolean => {
    if (closed || !safeReady(options.source.isReady)) return false;
    if (options.writer.readiness !== undefined && !safeReady(() => options.writer.readiness!().ready)) return false;
    return true;
  };

  const preflight = (): Promise<void> => {
    guard();
    if (preflightFlight !== undefined) return preflightFlight;
    preflightFlight = (async () => {
      guard();
      if (!readiness()) fail("T04_OWNER_NOT_READY");
      await options.preflight?.();
      guard();
      if (options.writer.bind !== undefined && !writerBound) {
        options.writer.bind();
        writerBound = true;
      }
      if (!readiness()) fail("T04_OWNER_NOT_READY");
    })();
    void preflightFlight.catch(() => { preflightFlight = undefined; });
    return preflightFlight;
  };

  const delegatedActivityAcceptance: ActivityAcceptancePort = Object.freeze({
    verify: async (activity: Parameters<ActivityAcceptancePort["verify"]>[0]) => {
      guard();
      return options.activityAcceptance.verify(activity);
    },
  });
  const activityAcceptance: ProductionPortRegistration<ActivityAcceptancePort> = Object.freeze({
    port: delegatedActivityAcceptance,
    readiness: Object.freeze({
      owner: T04_OWNER,
      environment: "production" as const,
      isReady: readiness,
      reason: "T04_OWNER_NOT_READY",
    }),
  });

  const source: RealtimeAcceptedUserActivityOwnerSource = Object.freeze({
    owner: T04_OWNER,
    environment: "production" as const,
    isReady: readiness,
    subscribe: (consumer: Parameters<RealtimeAcceptedUserActivityOwnerSource["subscribe"]>[0]) => {
      guard();
      if (!readiness()) fail("T04_OWNER_NOT_READY");
      const release = options.source.subscribe(async (event) => {
        guard();
        const durable = assertDurableEvent(event);
        await delegatedActivityAcceptance.verify(durable.activity);
        return consumer(durable);
      });
      if (typeof release !== "function") fail("T04_OWNER_SOURCE_SUBSCRIPTION_INVALID");
      return () => release();
    },
    close: async () => {
      if (sourceClosed) return;
      sourceClosed = true;
      await options.source.close?.();
    },
  });

  const saveOwnerContext = (input: T04BootstrapConnectedInput): void => {
    savedOwnerContext = Object.freeze({
      bearer: snapshotOpaqueOwnerValue(input.bearer) as unknown as RealtimeBearerContext,
      governance: snapshotOpaqueOwnerValue(input.governance) as JsonRecord,
      authority: Object.freeze({
        realtime_session_ref: snapshotOpaqueOwnerValue(input.authority.realtime_session_ref),
        device_lease_ref: snapshotOpaqueOwnerValue(input.authority.device_lease_ref),
        continuity_id: input.authority.continuity_id,
        connection_epoch: input.authority.connection_epoch,
        continuity_expires_at: input.authority.continuity_expires_at,
        credential_expires_at: input.authority.credential_expires_at,
        governance: input.authority.governance,
      }),
    });
  };

  const onBootstrapConnected = async (input: T04BootstrapConnectedInput): Promise<void> => {
    guard();
    await preflight();
    guard();
    const currentBinding = await options.readCurrentBinding(input);
    guard();
    if (currentBinding === undefined) fail("T04_OWNER_CURRENT_BINDING_MISSING");
    let now: number | undefined;
    if (options.now !== undefined) {
      try { now = options.now(); } catch { fail("T04_OWNER_CLOCK_INVALID"); }
    }
    const event = buildT04AcceptedUserActivityEvent({ ...input, currentBinding, ...(now === undefined ? {} : { now }) });
    const idempotencyKey = idempotencyKeyFromRequest(input.request);
    const previous = await options.writer.readByIdempotency(idempotencyKey);
    guard();
    if (previous !== undefined) {
      const priorEvent = durableEvent(previous);
      if (!same(priorEvent, event)) fail("T04_OWNER_REPLAY_CONFLICT");
      saveOwnerContext(input);
      return;
    }
    const verification = await delegatedActivityAcceptance.verify(event.activity);
    guard();
    if (verification.verified !== true ||
        !same(verification.acceptanceRef, event.activity.acceptanceRef) ||
        verification.acceptedAt !== event.activity.occurredAt) {
      fail("T04_OWNER_ACTIVITY_ACCEPTANCE_MISMATCH");
    }
    await options.writer.write(event);
    guard();
    const committed = await options.writer.readByIdempotency(idempotencyKey);
    if (committed === undefined) fail("T04_OWNER_DURABLE_COMMIT_UNCONFIRMED");
    if (!same(durableEvent(committed), event)) fail("T04_OWNER_REPLAY_CONFLICT");
    saveOwnerContext(input);
  };

  const recordUserAction = async (input: Readonly<{
    readonly action: T04AcceptedUserAction;
    readonly activityId: string;
    readonly occurredAt?: CanonicalTimestamp;
  }>): Promise<void> => {
    guard();
    await preflight();
    guard();
    const context = savedOwnerContext;
    if (context === undefined) fail("T04_OWNER_BOOTSTRAP_CONTEXT_MISSING");
    if (typeof input.activityId !== "string" || input.activityId.length === 0 || input.activityId.length > 128) {
      fail("T04_OWNER_ACTIVITY_ID_INVALID");
    }
    if (input.action !== T04_ACCEPTED_USER_ACTION && input.action !== T04_EXPLICIT_VOICE_ACTION) {
      fail("T04_OWNER_ACTION_INVALID");
    }
    let now: number;
    try { now = options.now?.() ?? Date.now(); } catch { fail("T04_OWNER_CLOCK_INVALID"); }
    const occurredAt = input.occurredAt === undefined
      ? assertCanonicalTimestamp(new Date(now).toISOString())
      : assertCanonicalTimestamp(input.occurredAt);
    const request: JsonRecord = Object.freeze({
      request_id: `t04_${input.action}_${input.activityId}`,
      idempotency_key: input.activityId,
      occurred_at: occurredAt,
    });
    const hookInput: T04BootstrapConnectedInput = Object.freeze({
      request,
      bearer: context.bearer,
      governance: context.governance,
      authority: context.authority as RealtimeBootstrapAuthorityResult,
    });
    const currentBinding = await options.readCurrentBinding(hookInput);
    guard();
    if (currentBinding === undefined) fail("T04_OWNER_CURRENT_BINDING_MISSING");
    const event = buildT04AcceptedUserActivityEvent({
      ...hookInput,
      currentBinding,
      action: input.action,
      now,
    });
    const previous = await options.writer.readByIdempotency(input.activityId);
    guard();
    if (previous !== undefined) {
      if (!same(durableEvent(previous), event)) fail("T04_OWNER_REPLAY_CONFLICT");
      return;
    }
    const verification = await delegatedActivityAcceptance.verify(event.activity);
    guard();
    if (verification.verified !== true || !same(verification.acceptanceRef, event.activity.acceptanceRef) ||
        verification.acceptedAt !== event.activity.occurredAt) {
      fail("T04_OWNER_ACTIVITY_ACCEPTANCE_MISMATCH");
    }
    await options.writer.write(event);
    guard();
    const committed = await options.writer.readByIdempotency(input.activityId);
    if (committed === undefined || !same(durableEvent(committed), event)) fail("T04_OWNER_DURABLE_COMMIT_UNCONFIRMED");
  };

  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    savedOwnerContext = undefined;
    closeFlight = (async () => {
      const failures: unknown[] = [];
      try { await options.writer.close?.(); } catch (error) { failures.push(error); }
      // The writer normally owns the stream.  This direct close only handles
      // a separately injected source and is idempotent at the adapter edge.
      if (options.writer.close === undefined) {
        try { await source.close?.(); } catch (error) { failures.push(error); }
      }
      if (failures.length !== 0) fail("T04_OWNER_CLOSE_FAILED");
    })();
    return closeFlight;
  };

  return Object.freeze({ activityAcceptance, source, onBootstrapConnected, recordUserAction, preflight, close });
}

export const createT04AcceptedUserActivityOwner = createRealtimePublicControlT04Owner;
