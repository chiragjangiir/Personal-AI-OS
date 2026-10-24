import type { OpaqueEqualityPort } from '../../../services/realtime-core/src/ports.ts';
import type {
  AcceptedUserActivity,
  CanonicalTimestamp,
  OpaqueOwnerValue,
  RealtimeSessionRecord,
} from '../../../services/realtime-core/src/types.ts';
import { DEVICE_CLOCK_LEAD_MS } from '../../../services/realtime-core/src/types.ts';

export const REALTIME_ACCEPTED_USER_ACTIONS = Object.freeze([
  'explicit_voice_command',
  'button_submit',
  'cycling_start',
  'cycling_pause',
  'cycling_resume',
  'cycling_lap',
  'navigation_enable',
  'navigation_disable',
  'explicit_handoff',
] as const);

export type RealtimeAcceptedUserAction = (typeof REALTIME_ACCEPTED_USER_ACTIONS)[number];
export type RealtimeAcceptedUserActivityResult = RealtimeSessionRecord;

export interface RealtimeAcceptedUserActivityOwnerSource {
  readonly owner: string;
  readonly environment: 'production' | 'non-production';
  readonly isReady: () => boolean;
  readonly subscribe: (
    consumer: (event: RealtimeAcceptedUserActivityOwnerEvent) => Promise<RealtimeAcceptedUserActivityResult>,
  ) => (() => void | Promise<void>);
  readonly close?: () => void | Promise<void>;
}

export interface RealtimeAcceptedUserActivityOwnerEvent {
  readonly activity: AcceptedUserActivity;
  readonly actionReceipt: Readonly<Record<string, unknown>>;
  readonly currentBinding: Readonly<Record<string, unknown>>;
  readonly authorityProjection: Readonly<Record<string, unknown>>;
}

export interface RealtimeAcceptedUserActivitySink {
  readonly recordAcceptedUserActivity: (
    activity: AcceptedUserActivity,
  ) => Promise<RealtimeAcceptedUserActivityResult>;
}

export interface RealtimeAcceptedUserActivityProductionOptions {
  readonly source: RealtimeAcceptedUserActivityOwnerSource;
  readonly sink: RealtimeAcceptedUserActivitySink;
  readonly equality: Pick<OpaqueEqualityPort, 'same'>;
  readonly purpose: string;
  readonly now?: () => number;
}

export interface RealtimeAcceptedUserActivityProductionReadiness {
  readonly owner: string;
  readonly environment: 'production';
  readonly ready: boolean;
  readonly reason?: string;
}

export interface RealtimeAcceptedUserActivityProduction {
  readonly readiness: () => RealtimeAcceptedUserActivityProductionReadiness;
  readonly bind: () => void;
  readonly close: () => Promise<void>;
}

export class RealtimeAcceptedUserActivityProductionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RealtimeAcceptedUserActivityProductionError';
    this.code = code;
  }
}

const ACTIVITY_KEYS = Object.freeze([
  'activityId', 'kind', 'userId', 'deviceId', 'realtimeSessionRef',
  'continuityId', 'occurredAt', 'acceptanceRef', 'accepted',
]);
const RECEIPT_KEYS = Object.freeze([
  'kind', 'activityId', 'action', 'purpose', 'origin', 'committed', 'revoked',
  'deleted', 'stale', 'bindingCommitted',
]);
const WATCH_RECEIPT_KEYS = Object.freeze([...RECEIPT_KEYS, 'watchAuthorityEvidenceRef']);
const BINDING_KEYS = Object.freeze([
  'userId', 'activeDeviceId', 'realtimeSessionRef', 'continuityId', 'sessionState',
  'continuityState', 'transportState', 'leaseState', 'lastAcceptedUserActivityAt',
  'continuityExpiresAt', 'leaseExpiresAt',
]);
const PROJECTION_KEYS = Object.freeze([
  'kind', 'environment', 'activityId', 'origin', 'userOriginated', 'accepted', 'current',
  'deleted', 'suppressed', 'stale', 'purpose', 'userId', 'deviceId', 'realtimeSessionRef',
  'continuityId', 'sessionTime', 'acceptanceRef', 'authorityWatermark', 'watermarkCurrent', 'evidence',
]);
const AUTHORITY_EVIDENCE_KEYS = Object.freeze([
  'kind', 'evidenceRef', 'activityId', 'userOriginated', 'authority', 'current',
  'deleted', 'suppressed', 'stale',
]);
const TOOL_EVIDENCE_KEYS = Object.freeze([
  'kind', 'attachmentRef', 'attachmentActivityId', 'explicitUserInitiated', 'acceptedByT04', 'authority',
]);
const AUTHORITY_EVIDENCE_KINDS = new Set(['Observation', 'ContextAssertion', 'FinalTranscriptEvidence']);
const ACTIONS = new Set<string>(REALTIME_ACCEPTED_USER_ACTIONS);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/u;

function fail(code: string): never {
  throw new RealtimeAcceptedUserActivityProductionError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return value;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown, code: string): CanonicalTimestamp {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) fail(code);
  return value as CanonicalTimestamp;
}

function same(equality: Pick<OpaqueEqualityPort, 'same'>, left: unknown, right: unknown): boolean {
  try {
    return equality.same(
      left as Parameters<OpaqueEqualityPort['same']>[0],
      right as Parameters<OpaqueEqualityPort['same']>[1],
    ) === true;
  } catch {
    return false;
  }
}

function stable(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null;';
  if (typeof value === 'string') return `s:${value.length}:${value};`;
  if (typeof value === 'boolean') return value ? 'b:1;' : 'b:0;';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('ACCEPTED_ACTIVITY_FINGERPRINT_INVALID');
    return `n:${String(value)};`;
  }
  if (typeof value !== 'object' || value === undefined || ancestors.has(value)) {
    fail('ACCEPTED_ACTIVITY_FINGERPRINT_INVALID');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
          Object.getOwnPropertyNames(value).length !== value.length + 1) {
        fail('ACCEPTED_ACTIVITY_FINGERPRINT_INVALID');
      }
      return `a:${value.length}:[${value.map((item) => stable(item, ancestors)).join('')}]`;
    }
    if (!isPlainRecord(value)) fail('ACCEPTED_ACTIVITY_FINGERPRINT_INVALID');
    const fields = Object.keys(value).sort().map((key) => `${key.length}:${key}=${stable(value[key], ancestors)}`);
    return `o:${fields.length}:{${fields.join('')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function validateActivity(value: unknown): AcceptedUserActivity {
  const activity = exactRecord(value, ACTIVITY_KEYS, 'ACCEPTED_ACTIVITY_ENVELOPE_INVALID');
  if (activity.kind !== 'accepted_user_activity' || activity.accepted !== true) {
    fail('ACCEPTED_ACTIVITY_ENVELOPE_INVALID');
  }
  identifier(activity.activityId, 'ACCEPTED_ACTIVITY_ID_INVALID');
  identifier(activity.userId, 'ACCEPTED_ACTIVITY_BINDING_INVALID');
  identifier(activity.deviceId, 'ACCEPTED_ACTIVITY_BINDING_INVALID');
  identifier(activity.continuityId, 'ACCEPTED_ACTIVITY_BINDING_INVALID');
  timestamp(activity.occurredAt, 'ACCEPTED_ACTIVITY_TIME_INVALID');
  if (activity.realtimeSessionRef === undefined || activity.acceptanceRef === undefined) {
    fail('ACCEPTED_ACTIVITY_BINDING_INVALID');
  }
  return Object.freeze({ ...activity }) as unknown as AcceptedUserActivity;
}

function validateEvent(
  input: unknown,
  purpose: string,
  equality: Pick<OpaqueEqualityPort, 'same'>,
  now: number,
): AcceptedUserActivity {
  const event = exactRecord(
    input,
    ['activity', 'actionReceipt', 'currentBinding', 'authorityProjection'],
    'ACCEPTED_ACTIVITY_EVENT_INVALID',
  );
  const activity = validateActivity(event.activity);
  const receiptProbe = exactRecord(
    event.actionReceipt,
    isPlainRecord(event.actionReceipt) && event.actionReceipt.origin === 'watch_via_active_iphone'
      ? WATCH_RECEIPT_KEYS
      : RECEIPT_KEYS,
    'ACCEPTED_ACTIVITY_RECEIPT_INVALID',
  );
  const action = identifier(receiptProbe.action, 'ACCEPTED_ACTIVITY_ACTION_INVALID');
  if (!ACTIONS.has(action) || receiptProbe.kind !== 't04.accepted_user_action_receipt' ||
      receiptProbe.committed !== true || receiptProbe.revoked !== false || receiptProbe.deleted !== false ||
      receiptProbe.stale !== false || receiptProbe.purpose !== purpose || receiptProbe.activityId !== activity.activityId) {
    fail('ACCEPTED_ACTIVITY_RECEIPT_INVALID');
  }
  if ((action === 'explicit_handoff') !== (receiptProbe.bindingCommitted === true)) {
    fail('ACCEPTED_ACTIVITY_HANDOFF_RECEIPT_INVALID');
  }
  if (receiptProbe.origin !== 'iphone' && receiptProbe.origin !== 'watch_via_active_iphone') {
    fail('ACCEPTED_ACTIVITY_ORIGIN_INVALID');
  }

  const binding = exactRecord(event.currentBinding, BINDING_KEYS, 'ACCEPTED_ACTIVITY_CURRENT_BINDING_INVALID');
  const lastAccepted = timestamp(binding.lastAcceptedUserActivityAt, 'ACCEPTED_ACTIVITY_CURRENT_BINDING_INVALID');
  const continuityExpires = timestamp(binding.continuityExpiresAt, 'ACCEPTED_ACTIVITY_CURRENT_BINDING_INVALID');
  const leaseExpires = timestamp(binding.leaseExpiresAt, 'ACCEPTED_ACTIVITY_CURRENT_BINDING_INVALID');
  if (binding.sessionState !== 'active' || binding.continuityState !== 'active' ||
      binding.transportState !== 'connected' || binding.leaseState !== 'active') {
    fail('ACCEPTED_ACTIVITY_CURRENT_BINDING_INVALID');
  }
  if (binding.userId !== activity.userId || binding.activeDeviceId !== activity.deviceId ||
      binding.continuityId !== activity.continuityId ||
      !same(equality, binding.realtimeSessionRef, activity.realtimeSessionRef)) {
    fail('ACCEPTED_ACTIVITY_BINDING_INVALID');
  }
  const occurredMs = Date.parse(activity.occurredAt);
  // The activity instant is the device's clock (its start). The T04 owner and the paired-device policy already allow
  // DEVICE_CLOCK_LEAD_MS; without the same allowance a device running ~1 s fast never connects.
  if (occurredMs > now + DEVICE_CLOCK_LEAD_MS) fail('ACCEPTED_ACTIVITY_FUTURE');
  // Same ordering rule as the T02 owner: older is out of order; the start instant itself reaches T02, which records it
  // without renewing (continuity-renewal.ts).
  if (occurredMs < Date.parse(lastAccepted)) fail('ACCEPTED_ACTIVITY_OUT_OF_ORDER');
  if (now >= Date.parse(continuityExpires) || now >= Date.parse(leaseExpires)) {
    fail('ACCEPTED_ACTIVITY_CURRENT_BINDING_EXPIRED');
  }

  const projection = exactRecord(
    event.authorityProjection,
    PROJECTION_KEYS,
    'ACCEPTED_ACTIVITY_AUTHORITY_INVALID',
  );
  if (projection.kind !== 't04.activity_authority_projection' || projection.environment !== 'production' ||
      projection.origin !== 'user' || projection.userOriginated !== true || projection.accepted !== true ||
      projection.current !== true || projection.deleted !== false || projection.suppressed !== false ||
      projection.stale !== false || projection.watermarkCurrent !== true || projection.purpose !== purpose ||
      projection.activityId !== activity.activityId || projection.userId !== activity.userId ||
      projection.deviceId !== activity.deviceId || projection.continuityId !== activity.continuityId ||
      projection.sessionTime !== activity.occurredAt ||
      !same(equality, projection.realtimeSessionRef, activity.realtimeSessionRef) ||
      !same(equality, projection.acceptanceRef, activity.acceptanceRef) ||
      projection.authorityWatermark === undefined || projection.authorityWatermark === null) {
    fail('ACCEPTED_ACTIVITY_AUTHORITY_INVALID');
  }
  if (!Array.isArray(projection.evidence)) fail('ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_INVALID');
  let authorityCount = 0;
  let acceptanceMatch = false;
  let watchMatch = false;
  for (const item of projection.evidence) {
    if (!isPlainRecord(item) || typeof item.kind !== 'string') fail('ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_INVALID');
    if (AUTHORITY_EVIDENCE_KINDS.has(item.kind)) {
      const evidence = exactRecord(item, AUTHORITY_EVIDENCE_KEYS, 'ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_INVALID');
      if (evidence.activityId !== activity.activityId || evidence.userOriginated !== true ||
          evidence.authority !== true || evidence.current !== true || evidence.deleted !== false ||
          evidence.suppressed !== false || evidence.stale !== false || evidence.evidenceRef === undefined) {
        fail('ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_INVALID');
      }
      authorityCount += 1;
      acceptanceMatch ||= same(equality, evidence.evidenceRef, activity.acceptanceRef);
      if (receiptProbe.origin === 'watch_via_active_iphone') {
        watchMatch ||= same(equality, evidence.evidenceRef, receiptProbe.watchAuthorityEvidenceRef);
      }
      continue;
    }
    if (item.kind === 'ToolResultArtifact') {
      const attachment = exactRecord(item, TOOL_EVIDENCE_KEYS, 'ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_INVALID');
      if (attachment.attachmentActivityId !== activity.activityId || attachment.explicitUserInitiated !== true ||
          attachment.acceptedByT04 !== true || attachment.authority !== false) {
        fail('ACCEPTED_ACTIVITY_TOOL_ATTACHMENT_INVALID');
      }
      continue;
    }
    fail('ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_INVALID');
  }
  if (authorityCount < 1 || !acceptanceMatch) fail('ACCEPTED_ACTIVITY_AUTHORITY_EVIDENCE_REQUIRED');
  if (receiptProbe.origin === 'watch_via_active_iphone') {
    if (receiptProbe.watchAuthorityEvidenceRef === undefined || !watchMatch ||
        binding.activeDeviceId !== activity.deviceId) {
      fail('ACCEPTED_ACTIVITY_WATCH_RELAY_INVALID');
    }
  } else if (Object.hasOwn(receiptProbe, 'watchAuthorityEvidenceRef')) {
    fail('ACCEPTED_ACTIVITY_WATCH_RELAY_INVALID');
  }
  return activity;
}

export function createRealtimeAcceptedUserActivityProduction(
  options: RealtimeAcceptedUserActivityProductionOptions,
): RealtimeAcceptedUserActivityProduction {
  if (!isPlainRecord(options) || !isPlainRecord(options.source) ||
      typeof options.source.owner !== 'string' || options.source.owner.trim().length === 0 ||
      typeof options.source.isReady !== 'function' || typeof options.source.subscribe !== 'function' ||
      !isPlainRecord(options.sink) || typeof options.sink.recordAcceptedUserActivity !== 'function' ||
      !isPlainRecord(options.equality) || typeof options.equality.same !== 'function' ||
      typeof options.purpose !== 'string' || options.purpose.length === 0 || options.purpose !== options.purpose.trim() ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    fail('ACCEPTED_ACTIVITY_OPTIONS_INVALID');
  }
  const now = options.now ?? Date.now;
  let closed = false;
  let bound = false;
  let unsubscribe: (() => void | Promise<void>) | undefined;
  let tail = Promise.resolve();
  let closeFlight: Promise<void> | undefined;
  const replay = new Map<string, Readonly<{
    fingerprint: string;
    result: Promise<RealtimeAcceptedUserActivityResult>;
  }>>();

  const readiness = (): RealtimeAcceptedUserActivityProductionReadiness => {
    let ownerReady = false;
    if (!closed && options.source.environment === 'production') {
      try { ownerReady = options.source.isReady() === true; } catch { ownerReady = false; }
    }
    return Object.freeze({
      owner: options.source.owner,
      environment: 'production' as const,
      ready: ownerReady,
      ...(ownerReady ? {} : { reason: closed ? 'closed' : 'owner_source_not_ready' }),
    });
  };

  const consume = (event: RealtimeAcceptedUserActivityOwnerEvent): Promise<RealtimeAcceptedUserActivityResult> => {
    if (closed) return Promise.reject(new RealtimeAcceptedUserActivityProductionError('ACCEPTED_ACTIVITY_BRIDGE_CLOSED'));
    const operation = tail.then(async () => {
      if (closed) fail('ACCEPTED_ACTIVITY_BRIDGE_CLOSED');
      const activity = validateEvent(event, options.purpose, options.equality, now());
      const fingerprint = stable(event);
      const previous = replay.get(activity.activityId);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) fail('ACCEPTED_ACTIVITY_REPLAY_CONFLICT');
        return previous.result;
      }
      const result = Promise.resolve(options.sink.recordAcceptedUserActivity(activity));
      replay.set(activity.activityId, Object.freeze({ fingerprint, result }));
      try { return await result; }
      catch (error) { replay.delete(activity.activityId); throw error; }
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const bind = (): void => {
    if (closed) fail('ACCEPTED_ACTIVITY_BRIDGE_CLOSED');
    if (bound) return;
    if (options.source.environment !== 'production') fail('ACCEPTED_ACTIVITY_SOURCE_NON_PRODUCTION');
    if (!readiness().ready) fail('ACCEPTED_ACTIVITY_SOURCE_NOT_READY');
    const release = options.source.subscribe(consume);
    if (typeof release !== 'function') fail('ACCEPTED_ACTIVITY_SOURCE_SUBSCRIPTION_INVALID');
    unsubscribe = release;
    bound = true;
  };

  const close = (): Promise<void> => {
    closeFlight ??= (async () => {
      closed = true;
      const failures: unknown[] = [];
      try { await unsubscribe?.(); } catch (error) { failures.push(error); }
      try { await tail; } catch (error) { failures.push(error); }
      try { await options.source.close?.(); } catch (error) { failures.push(error); }
      replay.clear();
      if (failures.length !== 0) fail('ACCEPTED_ACTIVITY_CLOSE_FAILED');
    })();
    return closeFlight;
  };
  return Object.freeze({ readiness, bind, close });
}
