/**
 * Internal, non-canonical, non-wire media intent reconciliation.
 *
 * LiveKit's SDK owns reconnect auto-republish.  This module therefore plans
 * only missing, explicitly-started microphone/camera/data publications after
 * intersecting the explicit Start, current authority, and response grants.
 * It never starts a device capture, publishes a track, or widens grants.
 */

import {
  assertConnectionEpoch,
  compareDecimalEpoch,
  type DecimalConnectionEpoch,
  type RealtimeExplicitStart,
  type RealtimeMediaGrant,
  type RealtimeMediaGrants,
} from './realtime-public-control-ports.ts';

export type ReconcileMediaSource = 'microphone' | 'camera' | 'data';
export type ReconcileMediaModality = 'audio' | 'video' | 'data';

export type MediaIntentRejectionReason =
  | 'MISSING_EXPLICIT_START'
  | 'INVALID_EXPLICIT_START'
  | 'SCREEN_SHARE_NOT_SUPPORTED'
  | 'INVALID_MODALITY'
  | 'AUTHORITY_NOT_GRANTED'
  | 'RESPONSE_GRANT_NOT_GRANTED'
  | 'DEVICE_MISMATCH'
  | 'LEASE_MISMATCH'
  | 'GRANT_MODALITY_NOT_GRANTED'
  | 'GRANT_EXPIRED'
  | 'INVALID_GRANT'
  | 'MISSING_CURRENT_BINDING'
  | 'INVALID_AUTHORITY'
  | 'AUTHORITY_EXPIRED'
  | 'RESPONSE_EXPIRED'
  | 'EPOCH_MISMATCH'
  | 'MISSING_PROVENANCE'
  | 'OWNER_COMPARATOR_FAILED'
  | 'SDK_STATE_REQUIRED'
  | 'SDK_DISCONNECTED'
  | 'INVALID_CLOCK'
  | 'STOPPED';

export interface MediaIntentOwnerComparator<TDeviceId = unknown, TLeaseRef = unknown> {
  sameDeviceId(left: TDeviceId, right: TDeviceId): boolean;
  sameLeaseRef(left: TLeaseRef, right: TLeaseRef): boolean;
}

export type MediaIntentBindingEquality<TDeviceId = unknown, TLeaseRef = unknown> =
  MediaIntentOwnerComparator<TDeviceId, TLeaseRef>;

export interface MediaIntentReconcileInput<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly explicitStart?: RealtimeExplicitStart<TDeviceId> | {
    readonly deviceId: TDeviceId;
    readonly modalities: readonly unknown[];
    readonly startedAt?: string;
    readonly started_at?: string;
  };
  readonly explicit_start?: MediaIntentReconcileInput<TDeviceId, TLeaseRef>['explicitStart'];
  /** Current owner/T11B authority snapshot; fields remain opaque to this seam. */
  readonly currentAuthority?: unknown;
  readonly current_authority?: unknown;
  readonly currentBinding?: unknown;
  readonly current_binding?: unknown;
  /** The grants returned by the current bootstrap/refresh response. */
  readonly responseGrants?: unknown;
  readonly response_grants?: unknown;
  readonly responseBinding?: unknown;
  readonly response_binding?: unknown;
  /** SDK-confirmed auto-republished track sources. `true` covers microphone/camera only. */
  readonly sdkAutoRepublished?: unknown;
  readonly sdk_auto_republished?: unknown;
  readonly sdkState?: 'connected' | 'reconnecting' | 'reconnected' | 'disconnected' | 'Connected' | 'Reconnecting' | 'Reconnected' | 'Disconnected';
  readonly sdk_state?: MediaIntentReconcileInput<TDeviceId, TLeaseRef>['sdkState'];
  readonly currentPublished?: unknown;
  readonly current_published?: unknown;
  readonly stopped?: boolean;
  readonly stop?: boolean | 'stopped';
  readonly nowMs?: number;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly deviceLeaseRef?: TLeaseRef;
  readonly device_lease_ref?: TLeaseRef;
  readonly connectionEpoch?: DecimalConnectionEpoch;
  readonly connection_epoch?: unknown;
}

export interface MediaReconcileAction<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly kind: 'publish';
  readonly action: 'publish';
  readonly operation: 'publish';
  readonly source: ReconcileMediaSource;
  readonly modality: ReconcileMediaModality;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly reason: 'missing_after_sdk_auto_republish';
  readonly expiresAt: string | number;
  readonly authorityExpiresAt: string | number;
  readonly responseExpiresAt: string | number;
  readonly deviceId?: TDeviceId;
  readonly deviceLeaseRef?: TLeaseRef;
  readonly connectionEpoch?: DecimalConnectionEpoch;
  readonly connection_epoch?: DecimalConnectionEpoch;
}

export interface MediaIntentRejection {
  readonly modality: string;
  readonly reason: MediaIntentRejectionReason;
}

export type MediaReconcileStatus = 'actions' | 'noop' | 'rejected' | 'stopped';

export interface MediaIntentReconcileResult<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly status: MediaReconcileStatus;
  readonly actions: readonly MediaReconcileAction<TDeviceId, TLeaseRef>[];
  /** Explicit alias for callers that call the output a reconcile action list. */
  readonly reconcileActions: readonly MediaReconcileAction<TDeviceId, TLeaseRef>[];
  readonly missing: readonly ReconcileMediaSource[];
  readonly ignored: readonly {
    readonly source: ReconcileMediaSource;
    readonly reason: 'sdk_auto_republish';
  }[];
  readonly rejected: readonly MediaIntentRejection[];
  readonly sdkAutoRepublishTrusted: true;
}

export interface MediaIntentReconcilerOptions<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly nowMs?: () => number;
  readonly clock?: () => number;
  readonly stopped?: boolean;
  readonly bindingEquality?: MediaIntentOwnerComparator<TDeviceId, TLeaseRef>;
  readonly ownerComparator?: MediaIntentOwnerComparator<TDeviceId, TLeaseRef>;
  readonly ownerEquality?: MediaIntentOwnerComparator<TDeviceId, TLeaseRef>;
  readonly comparator?: MediaIntentOwnerComparator<TDeviceId, TLeaseRef>;
}

interface RecordLike {
  readonly [key: string]: unknown;
}

interface GrantObservation<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly present: boolean;
  readonly enabled: boolean;
  readonly bindingComplete: boolean;
  readonly deviceId?: TDeviceId;
  readonly deviceLeaseRef?: TLeaseRef;
  readonly startModalities?: readonly unknown[];
  readonly expiresAt?: unknown;
}

interface GrantCheck<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly allowed: boolean;
  readonly reason: MediaIntentRejectionReason;
  readonly grant: GrantObservation<TDeviceId, TLeaseRef>;
}

interface BindingMetadata<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly hasCurrent: boolean;
  readonly current: boolean;
  readonly hasAllowed: boolean;
  readonly allowed: boolean;
  readonly hasDeviceId: boolean;
  readonly deviceId?: TDeviceId;
  readonly hasLeaseRef: boolean;
  readonly leaseRef?: TLeaseRef;
  readonly hasEpoch: boolean;
  readonly epoch?: DecimalConnectionEpoch;
  readonly hasExpiry: boolean;
  readonly expiresAt?: unknown;
}

interface BindingMetadataCheck<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly valid: boolean;
  readonly reason: MediaIntentRejectionReason;
  readonly metadata: BindingMetadata<TDeviceId, TLeaseRef>;
}

const SOURCE_BY_MODALITY: Readonly<Record<string, ReconcileMediaSource>> = Object.freeze({
  audio: 'microphone',
  microphone: 'microphone',
  video: 'camera',
  camera: 'camera',
  data: 'data',
});

const MODALITY_BY_SOURCE: Readonly<Record<ReconcileMediaSource, ReconcileMediaModality>> =
  Object.freeze({ microphone: 'audio', camera: 'video', data: 'data' });

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): RecordLike | undefined {
  return isRecord(value) ? value : undefined;
}

function firstValue(record: RecordLike, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function snapshotRecords(value: unknown): readonly RecordLike[] {
  const outer = asRecord(value);
  if (outer === undefined) return [];
  const records: RecordLike[] = [outer];
  for (const key of ['binding', 'currentBinding', 'current_binding', 'authorityBinding', 'authority_binding']) {
    const nested = asRecord(outer[key]);
    if (nested !== undefined) records.push(nested);
  }
  for (const key of ['mediaGrants', 'media_grants', 'grants', 'authority']) {
    const nested = asRecord(outer[key]);
    if (nested !== undefined) records.push(nested);
  }
  return records;
}

function firstSnapshotValue(snapshot: unknown, ...keys: readonly string[]): unknown {
  for (const record of snapshotRecords(snapshot)) {
    const value = firstValue(record, ...keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

interface OwnerCompare {
  readonly equal: boolean;
  readonly failed: boolean;
}

function ownerCompare<T>(
  left: T,
  right: T,
  comparator: ((left: T, right: T) => boolean) | undefined,
): OwnerCompare {
  if (comparator === undefined) return { equal: Object.is(left, right), failed: false };
  try {
    const result = comparator(left, right);
    return typeof result === 'boolean'
      ? { equal: result, failed: false }
      : { equal: false, failed: true };
  } catch {
    return { equal: false, failed: true };
  }
}

function normalizeSource(value: unknown): ReconcileMediaSource | undefined {
  if (typeof value !== 'string') return undefined;
  return SOURCE_BY_MODALITY[value.toLowerCase()];
}

function normalizeModality(value: unknown): ReconcileMediaModality | 'screen_share' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'screen_share' || normalized === 'screenshare' || normalized === 'screen-share') {
    return 'screen_share';
  }
  const source = normalizeSource(normalized);
  return source === undefined ? undefined : MODALITY_BY_SOURCE[source];
}

function getExplicitStart<TDeviceId, TLeaseRef>(
  input: MediaIntentReconcileInput<TDeviceId, TLeaseRef>,
): MediaIntentReconcileInput<TDeviceId, TLeaseRef>['explicitStart'] | undefined {
  return input.explicitStart ?? input.explicit_start;
}

function snapshotPayload(value: unknown): unknown {
  let current = value;
  const record = asRecord(current);
  if (record !== undefined) {
    const nested = firstValue(record, 'mediaGrants', 'media_grants', 'grants', 'authority');
    if (nested !== undefined && nested !== current) current = nested;
  }
  return current;
}

function grantFromValue<TDeviceId, TLeaseRef>(value: unknown): GrantObservation<TDeviceId, TLeaseRef> {
  if (typeof value === 'boolean') return { present: true, enabled: value, bindingComplete: false };
  const record = asRecord(value);
  if (record === undefined) return { present: false, enabled: false, bindingComplete: false };
  const enabled = firstValue(record, 'enabled', 'allowed', 'canPublish');
  const startModalities = firstValue(record, 'startModalities', 'start_modalities');
  const deviceId = firstValue(record, 'deviceId', 'device_id');
  const deviceLeaseRef = firstValue(record, 'deviceLeaseRef', 'device_lease_ref');
  const expiresAt = firstValue(record, 'expiresAt', 'expires_at');
  return {
    present: true,
    enabled: enabled === true,
    bindingComplete: deviceId !== undefined && deviceLeaseRef !== undefined && expiresAt !== undefined,
    ...(deviceId === undefined
      ? {}
      : { deviceId: deviceId as TDeviceId }),
    ...(deviceLeaseRef === undefined
      ? {}
      : { deviceLeaseRef: deviceLeaseRef as TLeaseRef }),
    ...(Array.isArray(startModalities) ? { startModalities } : {}),
    ...(expiresAt === undefined
      ? {}
      : { expiresAt }),
  };
}

function hasSource(value: unknown, source: ReconcileMediaSource): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((candidate) => normalizeSource(candidate) === source);
}

function sourceGrantFromPolicy<TDeviceId, TLeaseRef>(
  record: RecordLike,
  source: ReconcileMediaSource,
): GrantObservation<TDeviceId, TLeaseRef> | undefined {
  const sources = firstValue(record, 'canPublishSources', 'can_publish_sources');
  const canPublishData = firstValue(record, 'canPublishData', 'can_publish_data');
  const canPublish = firstValue(record, 'canPublish', 'can_publish');
  if (sources === undefined && canPublishData === undefined) return undefined;
  const enabled = source === 'data'
    ? canPublishData === true
    : canPublish !== false && hasSource(sources, source);
  // Policy grants intentionally carry source permissions separately; their
  // device/lease/expiry/epoch binding is retained and checked from the outer
  // authority/response metadata before this helper is called.
  return { present: true, enabled, bindingComplete: true };
}

function locateGrant<TDeviceId, TLeaseRef>(
  snapshot: unknown,
  source: ReconcileMediaSource,
): GrantObservation<TDeviceId, TLeaseRef> {
  const payload = snapshotPayload(snapshot);
  if (Array.isArray(payload)) {
    return {
      present: true,
      enabled: payload.some((entry) => normalizeSource(entry) === source),
      bindingComplete: false,
    };
  }
  const record = asRecord(payload);
  if (record === undefined) return { present: false, enabled: false, bindingComplete: false };

  const policyGrant = sourceGrantFromPolicy<TDeviceId, TLeaseRef>(record, source);
  if (policyGrant !== undefined) return policyGrant;

  const modality = MODALITY_BY_SOURCE[source];
  const candidate = firstValue(record, modality, source);
  if (candidate !== undefined) return grantFromValue<TDeviceId, TLeaseRef>(candidate);

  // A response may expose a single grant object for the selected modality.
  if (Object.hasOwn(record, 'enabled') || Object.hasOwn(record, 'allowed')) {
    return grantFromValue<TDeviceId, TLeaseRef>(record);
  }
  return { present: false, enabled: false, bindingComplete: false };
}

function currentDeviceId<TDeviceId>(snapshot: unknown): TDeviceId | undefined {
  const outer = asRecord(snapshot);
  const nested = asRecord(snapshotPayload(snapshot));
  const value = outer === undefined
    ? nested === undefined ? undefined : firstValue(nested, 'deviceId', 'device_id')
    : firstValue(outer, 'deviceId', 'device_id')
      ?? (nested === undefined ? undefined : firstValue(nested, 'deviceId', 'device_id'));
  return value === undefined ? undefined : value as TDeviceId;
}

function nowMsFrom(
  input: MediaIntentReconcileInput,
  options: MediaIntentReconcilerOptions,
): number | undefined {
  try {
    const value = input.nowMs ?? options.nowMs?.() ?? options.clock?.();
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizedSdkState(
  value: MediaIntentReconcileInput['sdkState'],
): 'connected' | 'reconnecting' | 'reconnected' | 'disconnected' | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'connected' || normalized === 'reconnecting'
    || normalized === 'reconnected' || normalized === 'disconnected') {
    return normalized;
  }
  return undefined;
}

function expiryIsValid(value: unknown, nowMs: number): boolean {
  if (value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value) && value > nowMs;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > nowMs;
  }
  return false;
}

function bindingMetadata<TDeviceId, TLeaseRef>(
  snapshot: unknown,
): BindingMetadata<TDeviceId, TLeaseRef> {
  const currentValue = firstSnapshotValue(snapshot, 'current', 'isCurrent', 'is_current');
  const status = firstSnapshotValue(snapshot, 'status');
  const allowedValue = firstSnapshotValue(snapshot, 'allowed', 'isAllowed', 'is_allowed');
  const deviceId = firstSnapshotValue(snapshot, 'deviceId', 'device_id');
  const leaseRef = firstSnapshotValue(snapshot, 'deviceLeaseRef', 'device_lease_ref');
  const epochValue = firstSnapshotValue(snapshot, 'connectionEpoch', 'connection_epoch', 'epoch');
  const expiresAt = firstSnapshotValue(
    snapshot,
    'expiresAt',
    'expires_at',
    'validUntil',
    'valid_until',
  );
  let epoch: DecimalConnectionEpoch | undefined;
  if (epochValue !== undefined) {
    try {
      epoch = assertConnectionEpoch(epochValue);
    } catch {
      epoch = undefined;
    }
  }
  return {
    hasCurrent: typeof currentValue === 'boolean' || status === 'current',
    current: currentValue === true || status === 'current',
    hasAllowed: typeof allowedValue === 'boolean',
    allowed: allowedValue === true,
    hasDeviceId: deviceId !== undefined && deviceId !== null,
    ...(deviceId === undefined || deviceId === null ? {} : { deviceId: deviceId as TDeviceId }),
    hasLeaseRef: leaseRef !== undefined && leaseRef !== null,
    ...(leaseRef === undefined || leaseRef === null ? {} : { leaseRef: leaseRef as TLeaseRef }),
    hasEpoch: epochValue !== undefined && epoch !== undefined,
    ...(epoch === undefined ? {} : { epoch }),
    hasExpiry: expiresAt !== undefined,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function checkBindingMetadata<TDeviceId, TLeaseRef>(
  snapshot: unknown,
  nowMs: number,
  notGrantedReason: 'INVALID_AUTHORITY' | 'RESPONSE_GRANT_NOT_GRANTED',
  expiredReason: 'AUTHORITY_EXPIRED' | 'RESPONSE_EXPIRED',
): BindingMetadataCheck<TDeviceId, TLeaseRef> {
  const metadata = bindingMetadata<TDeviceId, TLeaseRef>(snapshot);
  if (!metadata.hasCurrent || !metadata.hasAllowed || !metadata.hasDeviceId
    || !metadata.hasLeaseRef || !metadata.hasEpoch || !metadata.hasExpiry) {
    return { valid: false, reason: 'MISSING_CURRENT_BINDING', metadata };
  }
  if (!metadata.current || !metadata.allowed) {
    return { valid: false, reason: notGrantedReason, metadata };
  }
  if (!expiryIsValid(metadata.expiresAt, nowMs)) {
    return { valid: false, reason: expiredReason, metadata };
  }
  return { valid: true, reason: notGrantedReason, metadata };
}

function modalitiesAllow(grant: GrantObservation, modality: ReconcileMediaModality): boolean {
  if (grant.startModalities === undefined) return true;
  if (grant.startModalities.length === 0) return false;
  return grant.startModalities.some((value) => normalizeModality(value) === modality);
}

function checkGrant<TDeviceId, TLeaseRef>(
  snapshot: unknown,
  source: ReconcileMediaSource,
  modality: ReconcileMediaModality,
  explicitDeviceId: TDeviceId,
  expectedLease: TLeaseRef | undefined,
  nowMs: number,
  comparator: MediaIntentOwnerComparator<TDeviceId, TLeaseRef>,
  notGrantedReason: 'AUTHORITY_NOT_GRANTED' | 'RESPONSE_GRANT_NOT_GRANTED',
): GrantCheck<TDeviceId, TLeaseRef> {
  const grant = locateGrant<TDeviceId, TLeaseRef>(snapshot, source);
  if (!grant.present || !grant.enabled) {
    return { allowed: false, reason: notGrantedReason, grant };
  }
  if (!modalitiesAllow(grant, modality)) {
    return { allowed: false, reason: 'GRANT_MODALITY_NOT_GRANTED', grant };
  }
  if (!expiryIsValid(grant.expiresAt, nowMs)) {
    return { allowed: false, reason: 'GRANT_EXPIRED', grant };
  }
  if (grant.deviceId !== undefined) {
    const deviceComparison = ownerCompare(
      grant.deviceId,
      explicitDeviceId,
      (left, right) => comparator.sameDeviceId(left, right),
    );
    if (deviceComparison.failed) return { allowed: false, reason: 'OWNER_COMPARATOR_FAILED', grant };
    if (!deviceComparison.equal) return { allowed: false, reason: 'DEVICE_MISMATCH', grant };
  }
  if (expectedLease === undefined) {
    return { allowed: false, reason: 'LEASE_MISMATCH', grant };
  }
  if (grant.deviceLeaseRef !== undefined) {
    const leaseComparison = ownerCompare(
      grant.deviceLeaseRef,
      expectedLease,
      (left, right) => comparator.sameLeaseRef(left, right),
    );
    if (leaseComparison.failed) return { allowed: false, reason: 'OWNER_COMPARATOR_FAILED', grant };
    if (!leaseComparison.equal) return { allowed: false, reason: 'LEASE_MISMATCH', grant };
  }
  return { allowed: true, reason: notGrantedReason, grant };
}

function republishedSources(value: unknown): ReadonlySet<ReconcileMediaSource> {
  const sources = new Set<ReconcileMediaSource>();
  const add = (candidate: unknown): void => {
    const source = normalizeSource(candidate);
    if (source !== undefined) sources.add(source);
  };
  if (value === true) {
    sources.add('microphone');
    sources.add('camera');
  } else if (Array.isArray(value)) {
    value.forEach(add);
  } else {
    const record = asRecord(value);
    if (record !== undefined) {
      const nested = firstValue(record, 'sources', 'publishedSources', 'published_sources', 'republishedSources');
      if (nested !== undefined) {
        if (nested === true) {
          sources.add('microphone');
          sources.add('camera');
        } else if (Array.isArray(nested)) nested.forEach(add);
      }
      for (const source of ['microphone', 'camera', 'data', 'audio', 'video'] as const) {
        if (record[source] === true) add(source);
      }
    }
  }
  return sources;
}

function frozenResult<TDeviceId, TLeaseRef>(
  status: MediaReconcileStatus,
  actions: readonly MediaReconcileAction<TDeviceId, TLeaseRef>[],
  missing: readonly ReconcileMediaSource[],
  ignored: readonly { readonly source: ReconcileMediaSource; readonly reason: 'sdk_auto_republish' }[],
  rejected: readonly MediaIntentRejection[],
): MediaIntentReconcileResult<TDeviceId, TLeaseRef> {
  const frozenActions = Object.freeze([...actions]);
  const frozenMissing = Object.freeze([...missing]);
  const frozenIgnored = Object.freeze([...ignored]);
  const frozenRejected = Object.freeze([...rejected]);
  return Object.freeze({
    status,
    actions: frozenActions,
    reconcileActions: frozenActions,
    missing: frozenMissing,
    ignored: frozenIgnored,
    rejected: frozenRejected,
    sdkAutoRepublishTrusted: true as const,
  });
}

function defaultOwnerComparator<TDeviceId, TLeaseRef>(): MediaIntentOwnerComparator<TDeviceId, TLeaseRef> {
  return {
    sameDeviceId: Object.is,
    sameLeaseRef: Object.is,
  };
}

export const createDefaultMediaIntentOwnerComparator = <TDeviceId = unknown, TLeaseRef = unknown>():
  MediaIntentOwnerComparator<TDeviceId, TLeaseRef> => defaultOwnerComparator<TDeviceId, TLeaseRef>();

export class MediaIntentReconciler<TDeviceId = unknown, TLeaseRef = unknown> {
  readonly #options: MediaIntentReconcilerOptions<TDeviceId, TLeaseRef>;
  readonly #ownerComparator: MediaIntentOwnerComparator<TDeviceId, TLeaseRef>;
  #stopped: boolean;

  constructor(options: MediaIntentReconcilerOptions<TDeviceId, TLeaseRef> = {}) {
    this.#options = Object.freeze({ ...options });
    this.#ownerComparator = options.bindingEquality
      ?? options.ownerComparator
      ?? options.ownerEquality
      ?? options.comparator
      ?? defaultOwnerComparator<TDeviceId, TLeaseRef>();
    this.#stopped = options.stopped === true;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** One-way local Stop fence. Durable lease/consent Stop remains owner-owned. */
  stop(): void {
    this.#stopped = true;
  }

  markStopped(): void {
    this.stop();
  }

  reconcile(
    input: MediaIntentReconcileInput<TDeviceId, TLeaseRef>,
  ): MediaIntentReconcileResult<TDeviceId, TLeaseRef> {
    const stopped = this.#stopped || input.stopped === true || input.stop === true || input.stop === 'stopped';
    if (stopped) return frozenResult('stopped', [], [], [], []);
    const sdkState = normalizedSdkState(input.sdkState ?? input.sdk_state);
    if (sdkState === undefined) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'SDK_STATE_REQUIRED' }]);
    }
    if (sdkState === 'reconnecting') {
      return frozenResult('noop', [], [], [], []);
    }
    if (sdkState === 'disconnected') {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'SDK_DISCONNECTED' }]);
    }

    let connectionEpoch: DecimalConnectionEpoch | undefined;
    if (input.connectionEpoch !== undefined && input.connection_epoch !== undefined) {
      const camelEpoch = assertConnectionEpoch(input.connectionEpoch);
      const snakeEpoch = assertConnectionEpoch(input.connection_epoch);
      if (!Object.is(camelEpoch, snakeEpoch)) throw new Error('INVALID_CONNECTION_EPOCH');
      connectionEpoch = camelEpoch;
    } else {
      const epochValue = input.connectionEpoch ?? input.connection_epoch;
      connectionEpoch = epochValue === undefined ? undefined : assertConnectionEpoch(epochValue);
    }
    const explicitStart = getExplicitStart(input);
    if (explicitStart === undefined) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'MISSING_EXPLICIT_START' }]);
    }
    if (!Array.isArray(explicitStart.modalities)
      || explicitStart.deviceId === undefined
      || explicitStart.deviceId === null) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'INVALID_EXPLICIT_START' }]);
    }

    const nowMs = nowMsFrom(input, this.#options);
    if (nowMs === undefined) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'INVALID_CLOCK' }]);
    }
    const currentAuthority = input.currentAuthority
      ?? input.current_authority
      ?? input.currentBinding
      ?? input.current_binding;
    const responseGrants = input.responseGrants
      ?? input.response_grants
      ?? input.responseBinding
      ?? input.response_binding;
    const expectedLease = input.deviceLeaseRef ?? input.device_lease_ref;
    if (connectionEpoch === undefined || expectedLease === undefined || expectedLease === null
      || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0
      || typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'MISSING_PROVENANCE' }]);
    }
    const currentBinding = checkBindingMetadata<TDeviceId, TLeaseRef>(
      currentAuthority,
      nowMs,
      'INVALID_AUTHORITY',
      'AUTHORITY_EXPIRED',
    );
    if (!currentBinding.valid) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: currentBinding.reason }]);
    }
    const responseBinding = checkBindingMetadata<TDeviceId, TLeaseRef>(
      responseGrants,
      nowMs,
      'RESPONSE_GRANT_NOT_GRANTED',
      'RESPONSE_EXPIRED',
    );
    if (!responseBinding.valid) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: responseBinding.reason }]);
    }
    const currentDeviceId = currentBinding.metadata.deviceId as TDeviceId;
    const responseDeviceId = responseBinding.metadata.deviceId as TDeviceId;
    const currentLeaseRef = currentBinding.metadata.leaseRef as TLeaseRef;
    const responseLeaseRef = responseBinding.metadata.leaseRef as TLeaseRef;
    const currentDeviceComparison = ownerCompare(
      currentDeviceId,
      explicitStart.deviceId,
      (left, right) => this.#ownerComparator.sameDeviceId(left, right),
    );
    const responseDeviceComparison = ownerCompare(
      responseDeviceId,
      explicitStart.deviceId,
      (left, right) => this.#ownerComparator.sameDeviceId(left, right),
    );
    const crossDeviceComparison = ownerCompare(
      currentDeviceId,
      responseDeviceId,
      (left, right) => this.#ownerComparator.sameDeviceId(left, right),
    );
    if (currentDeviceComparison.failed || responseDeviceComparison.failed || crossDeviceComparison.failed) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'OWNER_COMPARATOR_FAILED' }]);
    }
    if (!currentDeviceComparison.equal || !responseDeviceComparison.equal || !crossDeviceComparison.equal) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'DEVICE_MISMATCH' }]);
    }
    const currentLeaseComparison = ownerCompare(
      currentLeaseRef,
      expectedLease,
      (left, right) => this.#ownerComparator.sameLeaseRef(left, right),
    );
    const responseLeaseComparison = ownerCompare(
      responseLeaseRef,
      expectedLease,
      (left, right) => this.#ownerComparator.sameLeaseRef(left, right),
    );
    const crossLeaseComparison = ownerCompare(
      currentLeaseRef,
      responseLeaseRef,
      (left, right) => this.#ownerComparator.sameLeaseRef(left, right),
    );
    if (currentLeaseComparison.failed || responseLeaseComparison.failed || crossLeaseComparison.failed) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'OWNER_COMPARATOR_FAILED' }]);
    }
    if (!currentLeaseComparison.equal || !responseLeaseComparison.equal || !crossLeaseComparison.equal) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'LEASE_MISMATCH' }]);
    }
    if (currentBinding.metadata.epoch === undefined || responseBinding.metadata.epoch === undefined
      || compareDecimalEpoch(currentBinding.metadata.epoch, responseBinding.metadata.epoch) !== 0
      || compareDecimalEpoch(currentBinding.metadata.epoch, connectionEpoch) !== 0) {
      return frozenResult('rejected', [], [], [], [{ modality: '*', reason: 'EPOCH_MISMATCH' }]);
    }
    const republished = new Set<ReconcileMediaSource>([
      ...republishedSources(input.sdkAutoRepublished ?? input.sdk_auto_republished),
      ...republishedSources(input.currentPublished ?? input.current_published),
    ]);
    const actions: MediaReconcileAction<TDeviceId, TLeaseRef>[] = [];
    const missing: ReconcileMediaSource[] = [];
    const ignored: { source: ReconcileMediaSource; reason: 'sdk_auto_republish' }[] = [];
    const rejected: MediaIntentRejection[] = [];
    const seenSources = new Set<ReconcileMediaSource>();

    for (const rawModality of explicitStart.modalities) {
      const normalized = normalizeModality(rawModality);
      if (normalized === 'screen_share') {
        rejected.push({ modality: 'screen_share', reason: 'SCREEN_SHARE_NOT_SUPPORTED' });
        continue;
      }
      if (normalized === undefined) {
        rejected.push({ modality: String(rawModality), reason: 'INVALID_MODALITY' });
        continue;
      }
      const source = normalizeSource(normalized);
      if (source === undefined) {
        rejected.push({ modality: normalized, reason: 'INVALID_MODALITY' });
        continue;
      }
      if (seenSources.has(source)) continue;
      seenSources.add(source);
      if (republished.has(source)) {
        ignored.push({ source, reason: 'sdk_auto_republish' });
        continue;
      }
      const currentCheck = checkGrant(
        currentAuthority,
        source,
        normalized,
        explicitStart.deviceId,
        expectedLease,
        nowMs,
        this.#ownerComparator,
        'AUTHORITY_NOT_GRANTED',
      );
      if (!currentCheck.allowed) {
        rejected.push({ modality: normalized, reason: currentCheck.reason });
        continue;
      }
      const responseCheck = checkGrant(
        responseGrants,
        source,
        normalized,
        explicitStart.deviceId,
        expectedLease,
        nowMs,
        this.#ownerComparator,
        'RESPONSE_GRANT_NOT_GRANTED',
      );
      if (!responseCheck.allowed) {
        rejected.push({ modality: normalized, reason: responseCheck.reason });
        continue;
      }
      if (currentCheck.grant.deviceLeaseRef !== undefined
        && responseCheck.grant.deviceLeaseRef !== undefined) {
        const leaseComparison = ownerCompare(
          currentCheck.grant.deviceLeaseRef,
          responseCheck.grant.deviceLeaseRef,
          (left, right) => this.#ownerComparator.sameLeaseRef(left, right),
        );
        if (leaseComparison.failed) {
          rejected.push({ modality: normalized, reason: 'OWNER_COMPARATOR_FAILED' });
          continue;
        }
        if (!leaseComparison.equal) {
          rejected.push({ modality: normalized, reason: 'LEASE_MISMATCH' });
          continue;
        }
      }
      missing.push(source);
      const action: MediaReconcileAction<TDeviceId, TLeaseRef> = {
        kind: 'publish',
        action: 'publish',
        operation: 'publish',
        source,
        modality: normalized,
        idempotencyKey: `${input.idempotencyKey}:${source}`,
        requestId: input.requestId,
        reason: 'missing_after_sdk_auto_republish',
        expiresAt: currentBinding.metadata.expiresAt as string | number,
        authorityExpiresAt: currentBinding.metadata.expiresAt as string | number,
        responseExpiresAt: responseBinding.metadata.expiresAt as string | number,
        ...(explicitStart.deviceId === undefined ? {} : { deviceId: explicitStart.deviceId }),
        deviceLeaseRef: expectedLease,
        ...(connectionEpoch === undefined ? {} : { connectionEpoch }),
        ...(connectionEpoch === undefined ? {} : { connection_epoch: connectionEpoch }),
      };
      actions.push(Object.freeze(action));
    }
    const status: MediaReconcileStatus = actions.length > 0
      ? 'actions'
      : rejected.length > 0
        ? 'rejected'
        : 'noop';
    return frozenResult(status, actions, missing, ignored, rejected);
  }

  plan(input: MediaIntentReconcileInput<TDeviceId, TLeaseRef>): MediaIntentReconcileResult<TDeviceId, TLeaseRef> {
    return this.reconcile(input);
  }
}

export function reconcileMediaIntent<TDeviceId = unknown, TLeaseRef = unknown>(
  input: MediaIntentReconcileInput<TDeviceId, TLeaseRef>,
  options: MediaIntentReconcilerOptions<TDeviceId, TLeaseRef> = {},
): MediaIntentReconcileResult<TDeviceId, TLeaseRef> {
  return new MediaIntentReconciler<TDeviceId, TLeaseRef>(options).reconcile(input);
}

export const createMediaIntentReconciler = <TDeviceId = unknown, TLeaseRef = unknown>(
  options: MediaIntentReconcilerOptions<TDeviceId, TLeaseRef> = {},
): MediaIntentReconciler<TDeviceId, TLeaseRef> => new MediaIntentReconciler(options);

export const reconcileMediaIntents = reconcileMediaIntent;
export const planMediaIntentReconciliation = reconcileMediaIntent;
export type MediaIntentReconciliation = MediaIntentReconcileResult;

/** Type-only convenience for callers that already hold the port grant shape. */
export type MediaGrantInput<TDeviceId, TLeaseRef> =
  | RealtimeMediaGrant<TDeviceId, TLeaseRef>
  | RealtimeMediaGrants<TDeviceId, TLeaseRef>;
