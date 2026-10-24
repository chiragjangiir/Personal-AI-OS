import {
  AudioStream,
  ConnectionState,
  DataPacketKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackSource,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import {
  AccessToken,
  RoomServiceClient,
  TrackSource as ServerTrackSource,
  type VideoGrant,
} from 'livekit-server-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import {
  CONTRACT_SCHEMA_VERSION_V0_3 as CONTRACT_SCHEMA_VERSION,
  ContractConsumer,
  RELIABLE_EVENT_TOPIC,
  type ConsumeResult,
  type EventEnvelope,
  type JsonObject,
} from './contract-consumer.ts';
import { createGatewayRoom } from './sdk-room.ts';
import { assertCanonicalLiveKitApiUrl } from './livekit-cloud-token-signer.ts';
import { DirectLoopController, type DirectLoopConfig } from './direct-loop-controller.ts';
import type { FixedCanaryAudioFrame } from './fixed-canary-stt-adapter.ts';

export interface GatewayConfig {
  readonly livekitUrl: string;
  readonly livekitApiUrl?: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly agentName?: string;
  readonly directLoop?: DirectLoopConfig;
  readonly sessionTtlSeconds: number;
  readonly tokenTtlSeconds: number;
  readonly deviceLan?: {
    readonly clientLivekitUrl: string;
    readonly runId: string;
    readonly roomAutoCreateDisabled: true;
    readonly supervised?: SupervisedDeviceLanBinding;
  };
}

export interface SupervisedDeviceLanBinding {
  readonly firewallRunId: string; readonly activationAttemptId: string;
  readonly sessionId: string; readonly roomName: string;
  readonly deviceId: string; readonly participantIdentity: string;
  readonly clientInstanceId: string; readonly controlRoot: string;
}

export interface SupervisedPrearmReport {
  readonly schema: 'paos.gateway-prearm-ready.v1'; readonly run_id: string;
  readonly activation_attempt_id: string; readonly session_id: string;
  readonly room_name: string; readonly device_id: string;
  readonly participant_identity: string; readonly client_instance_id: string;
  readonly gateway_identity: 'windows_gateway_01'; readonly room_service_stable: true;
  readonly rtc_stable: true; readonly observation_epoch: number;
}

export interface SupervisedAbsenceProofDocuments {
  readonly participantBytes: Uint8Array; readonly publicationBytes: Uint8Array;
  readonly participantSha256: string; readonly publicationSha256: string;
  readonly contactObserved: boolean; readonly participantSid: string | null;
  readonly publicationSid: string | null; readonly observationEpoch: number;
  readonly observationGeneration: number;
}

export interface SupervisedAbsenceProofCommitter {
  commit(committedAtUtc: string): Promise<void>;
}

export interface SupervisedRtcLiveMapSnapshot {
  readonly participantProviderBytesBase64: string;
  readonly publicationProviderBytesBase64: string;
  readonly participantProviderSha256: string;
  readonly publicationProviderSha256: string;
  readonly contactParticipantSidBindingSha256: string;
}

export interface SupervisedCleanupReceipt {
  readonly schema: 'paos.gateway-cleanup-complete.v1'; readonly run_id: string;
  readonly activation_attempt_id: string; readonly session_id: string;
  readonly room_name: string; readonly device_id: string; readonly participant_identity: string;
  readonly provider: 'livekit-rtc-node'; readonly issuance_denied: true;
  readonly contact_observed: boolean; readonly publication_sid: string | null;
  readonly participant_absence_evidence_sha256: string;
  readonly publication_absence_evidence_sha256: string; readonly gateway_disconnected: true;
  readonly room_absent: true; readonly completed_at_utc: string;
}

export interface ConnectionDetails {
  readonly serverUrl: string;
  readonly roomName: string;
  readonly participantName: string;
  readonly participantToken: string;
}

export interface TimelineItem {
  readonly kind: 'accepted' | 'rejected' | 'lifecycle';
  readonly sessionId: string;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly occurredAt: string;
  readonly originDeviceId?: string;
  readonly retry?: boolean;
  readonly errors?: readonly string[];
  readonly displayText?: string;
  readonly references?: readonly string[];
  readonly verifiedCleanup?: boolean;
}

interface SessionRuntime {
  readonly id: string;
  readonly traceId: string;
  readonly userDeviceId: string;
  readonly userClientInstanceId: string;
  readonly userIdentity: string;
  readonly credentialId: string;
  readonly gatewayConnectionId: string;
  readonly userConnectionId: string;
  readonly consumer: ContractConsumer;
  readonly subscribers: Set<(item: TimelineItem) => void>;
  expiresAt: number;
  sessionDeadlineEpochSeconds: number;
  room?: Room;
  rtcConnected: boolean; userSessionStarted: boolean;
  observationQueue: Promise<void>; observationEpoch: number; observationGeneration: number;
  observationPoison?: string;
  contactParticipant?: RemoteParticipant; contactParticipantSid?: string;
  contactPublication?: RemoteTrackPublication; contactPublicationSid?: string;
  contactPublicationActive: boolean;
  contactState: 'NONE' | 'CONNECTED' | 'PUBLISHED' | 'UNPUBLISHED' | 'DISCONNECTED' | 'POISONED';
  contactConnectCount: number; contactPublishCount: number;
  contactUnpublishCount: number; contactDisconnectCount: number;
  supervisedAbsence?: {
    readonly documents: SupervisedAbsenceProofDocuments;
    readonly committer: SupervisedAbsenceProofCommitter;
    readonly observationEpoch: number; readonly observationGeneration: number;
    readonly committedAtUtc: string;
    disconnected: boolean; committed: boolean;
  };
  physicalParticipant?: RemoteParticipant;
  roomCreationSettled?: Promise<void>;
  joinTimer?: NodeJS.Timeout;
  joinPromise?: Promise<void>;
  expiryTimer?: ScheduledHandle;
  gatewaySequence: number;
  gatewayPreviousEventId?: string;
  userSequence: number;
  userPreviousEventId?: string;
  readonly primitiveState: OfficialPrimitiveState;
  readonly ephemeralObjects: Map<string, EphemeralResourceBinding>;
  readonly pendingLiveKitMediaKeys: Set<string>;
  readonly observedLiveKitPublicationKeys: Set<string>;
  readonly contractPublicationObservationKeys: Set<string>;
  readonly liveKitMediaResourceKeys: Set<string>;
  readonly directTrackAttempts: WeakMap<object, number>;
  readonly directTrackTokens: Map<string, object>;
  nextTrackAttempt: number;
  readonly modelCache: ModelCorrelationCache;
  readonly gatewayOutboundOwnership: GatewayOutboundOwnership;
  verifiedMediaRemovalCount: number;
  cleanupDeadlineAt?: number;
  cleanupReason?: 'user_stop' | 'timeout' | 'gate_complete' | 'error';
  cleanupRetryTimer?: ScheduledHandle;
  cleanupPromise?: Promise<EventEnvelope>;
  deviceLanRevocationReason?: DeviceLanRevocationReason;
  ended: boolean;
  stopping: boolean;
}

interface Tombstone {
  readonly cleanedAt: number;
  readonly expiresAt: number;
  readonly cleanupFingerprint: string;
  readonly acceptedEffectCount: number;
}

interface TerminalFailure {
  readonly code: 'CLEANUP_SLA_MISSED';
  readonly terminalAt: number;
  readonly expiresAt: number;
}

const GATEWAY_DEVICE_ID = 'windows_gateway_01';
const GATEWAY_CLIENT_ID = 'gateway_client_01';
const LEGACY_GATEWAY_IDENTITY_ALIASES = new Set(['windows-gateway', 'windows_gateway']);
const MAX_JOIN_WAIT_MS = 30_000;
const SUPERVISED_OPERATIONAL_LEASE_SECONDS = 1_200, SUPERVISED_FENCE_TIMEOUT_MS = 30_000;
const SUPERVISED_FENCE_POLL_MS = 50;

export function gatewayPublisherIdentityBinding(): {
  readonly identity: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly origin: Readonly<JsonObject>;
} {
  return {
    identity: GATEWAY_DEVICE_ID,
    attributes: {
      schema_version: CONTRACT_SCHEMA_VERSION,
      device_id: GATEWAY_DEVICE_ID,
      device_class: 'windows_gateway',
      client_instance_id: GATEWAY_CLIENT_ID,
    },
    origin: {
      device_id: GATEWAY_DEVICE_ID,
      device_class: 'windows_gateway',
      client_instance_id: GATEWAY_CLIENT_ID,
    },
  };
}

export interface RtcEventTransportBinding {
  readonly topic: typeof RELIABLE_EVENT_TOPIC;
  readonly kind: DataPacketKind;
  readonly reliable: boolean;
}

export function rtcEventTransportBinding(eventType: unknown): RtcEventTransportBinding {
  const reliable = eventType !== 'paios.phase0.demo.device.telemetry';
  return {
    topic: RELIABLE_EVENT_TOPIC,
    kind: reliable ? DataPacketKind.KIND_RELIABLE : DataPacketKind.KIND_LOSSY,
    reliable,
  };
}

export function isGatewayOwnedOutboundEnvelope(candidate: unknown): candidate is EventEnvelope {
  if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') return false;
  const event = candidate as EventEnvelope;
  const binding = gatewayPublisherIdentityBinding();
  return (
    event.schema_version === CONTRACT_SCHEMA_VERSION &&
    event.origin?.device_id === binding.origin.device_id &&
    event.origin?.device_class === binding.origin.device_class &&
    event.origin?.client_instance_id === binding.origin.client_instance_id
  );
}

export class GatewayOutboundOwnership {
  readonly #fingerprints = new Map<string, string>();

  record(event: EventEnvelope): void {
    if (!isGatewayOwnedOutboundEnvelope(event) || typeof event.event_id !== 'string') {
      throw new Error('LOCAL_GATEWAY_ENVELOPE_REQUIRED');
    }
    const fingerprint = stableJson(event);
    const prior = this.#fingerprints.get(event.event_id);
    if (prior !== undefined && prior !== fingerprint) {
      throw new Error('LOCAL_GATEWAY_EVENT_ID_CONFLICT');
    }
    this.#fingerprints.set(event.event_id, fingerprint);
  }

  owns(event: EventEnvelope): boolean {
    return (
      isGatewayOwnedOutboundEnvelope(event) &&
      typeof event.event_id === 'string' &&
      this.#fingerprints.get(event.event_id) === stableJson(event)
    );
  }

  clear(): void {
    this.#fingerprints.clear();
  }

  isEmpty(): boolean {
    return this.#fingerprints.size === 0;
  }
}

function scoped(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function primitiveScopedId(prefix: string, primitiveId: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix) || primitiveId.length === 0) {
    throw new Error('OFFICIAL_PRIMITIVE_ID_INVALID');
  }
  const digest = createHash('sha256')
    .update(prefix)
    .update('\u0000')
    .update(primitiveId)
    .digest('hex');
  const digestLength = 64 - prefix.length - 1;
  if (digestLength < 16) throw new Error('OFFICIAL_PRIMITIVE_PREFIX_TOO_LONG');
  return `${prefix}_${digest.slice(0, digestLength)}`;
}

export class OfficialPrimitiveState {
  readonly #seenPrompts = new Set<string>();
  readonly #seenFinals = new Map<string, string>();
  #agentIdentity: string | undefined;
  #pending: { requestEventId: string; requestedAt: number } | undefined;

  inspectPrompt(primitiveId: string): 'duplicate' | 'new' {
    if (this.#seenPrompts.has(primitiveId)) return 'duplicate';
    if (!this.#agentIdentity) throw new Error('AGENT_GREETING_NOT_OBSERVED');
    if (this.#pending) throw new Error('MODEL_REQUEST_ALREADY_IN_FLIGHT');
    return 'new';
  }

  commitPrompt(primitiveId: string, requestEventId: string, requestedAt: number): void {
    if (this.inspectPrompt(primitiveId) !== 'new') return;
    this.#seenPrompts.add(primitiveId);
    if (this.#pending) throw new Error('MODEL_REQUEST_ALREADY_IN_FLIGHT');
    this.#pending = { requestEventId, requestedAt };
  }

  inspectFinal(
    primitiveId: string,
    agentIdentity: string,
  ):
    | { kind: 'duplicate' }
    | { kind: 'greeting' }
    | {
        kind: 'result';
        pending: { requestEventId: string; requestedAt: number };
      } {
    if (this.#agentIdentity && this.#agentIdentity !== agentIdentity) {
      throw new Error('OFFICIAL_AGENT_IDENTITY_DRIFT');
    }
    const seenAgent = this.#seenFinals.get(primitiveId);
    if (seenAgent) {
      if (seenAgent !== agentIdentity) throw new Error('OFFICIAL_AGENT_IDENTITY_DRIFT');
      return { kind: 'duplicate' };
    }
    if (!this.#agentIdentity) return { kind: 'greeting' };
    if (!this.#pending) throw new Error('UNSOLICITED_AGENT_FINAL');
    return { kind: 'result', pending: this.#pending };
  }

  commitGreeting(primitiveId: string, agentIdentity: string): void {
    if (this.inspectFinal(primitiveId, agentIdentity).kind !== 'greeting') return;
    this.#agentIdentity = agentIdentity;
    this.#seenFinals.set(primitiveId, agentIdentity);
  }

  commitResult(primitiveId: string, agentIdentity: string, requestEventId: string): void {
    const observation = this.inspectFinal(primitiveId, agentIdentity);
    if (observation.kind !== 'result' || observation.pending.requestEventId !== requestEventId) {
      throw new Error('MODEL_RESULT_CORRELATION_MISMATCH');
    }
    if (this.#pending?.requestEventId !== requestEventId) {
      throw new Error('MODEL_RESULT_CORRELATION_MISMATCH');
    }
    this.#seenFinals.set(primitiveId, agentIdentity);
    this.#pending = undefined;
  }

  clear(): void {
    this.#seenPrompts.clear();
    this.#seenFinals.clear();
    this.#agentIdentity = undefined;
    this.#pending = undefined;
  }

  isEmpty(): boolean {
    return (
      this.#seenPrompts.size === 0 &&
      this.#seenFinals.size === 0 &&
      this.#agentIdentity === undefined &&
      this.#pending === undefined
    );
  }
}

export interface ModelCorrelationEntry {
  readonly requestEventId: string;
  resultEventId?: string;
}

export class ModelCorrelationCache {
  readonly #entries = new Map<string, ModelCorrelationEntry>();

  get size(): number {
    return this.#entries.size;
  }

  recordRequest(requestEventId: string): ModelCorrelationEntry {
    if (this.#entries.has(requestEventId)) throw new Error('MODEL_CACHE_REQUEST_DUPLICATE');
    const entry: ModelCorrelationEntry = { requestEventId };
    this.#entries.set(requestEventId, entry);
    return entry;
  }

  recordResult(requestEventId: string, resultEventId: string): ModelCorrelationEntry {
    const entry = this.#entries.get(requestEventId);
    if (!entry) throw new Error('MODEL_CACHE_REQUEST_NOT_FOUND');
    if (entry.resultEventId !== undefined && entry.resultEventId !== resultEventId) {
      throw new Error('MODEL_CACHE_RESULT_ALREADY_RECORDED');
    }
    entry.resultEventId = resultEventId;
    return entry;
  }

  clone(): ModelCorrelationCache {
    const clone = new ModelCorrelationCache();
    for (const [requestEventId, entry] of this.#entries) {
      const clonedEntry = clone.recordRequest(requestEventId);
      if (entry.resultEventId !== undefined) clonedEntry.resultEventId = entry.resultEventId;
    }
    return clone;
  }

  replaceWith(source: ModelCorrelationCache): void {
    this.clear();
    for (const [requestEventId, entry] of source.#entries) {
      const copiedEntry = this.recordRequest(requestEventId);
      if (entry.resultEventId !== undefined) copiedEntry.resultEventId = entry.resultEventId;
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  isEmpty(): boolean {
    return this.#entries.size === 0;
  }
}

export interface ScheduledHandle {
  unref?(): void;
}

export type CleanupRetryScheduler = (
  callback: () => Promise<EventEnvelope | undefined>,
  delayMs: number,
) => ScheduledHandle;

export type SessionExpiryScheduler = (callback: () => void, delayMs: number) => ScheduledHandle;

function iso(time = Date.now()): string {
  return new Date(time).toISOString();
}

function httpLiveKitUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return parsed.toString().replace(/\/$/, '');
}

type DeviceLanIssuanceState =
  | 'ARMED'
  | 'ISSUING'
  | 'ISSUED'
  | 'ACTIVE'
  | 'REVOKING'
  | 'REVOKED'
  | 'FAILED_CLOSED';

export type DeviceLanRevocationReason =
  | 'user_stop'
  | 'timeout'
  | 'gate_complete'
  | 'error'
  | 'participant_disconnect'
  | 'duplicate_identity'
  | 'reconnect_replay'
  | 'aborted_issuance'
  | 'deadline_expired';

export interface DeviceLanIssuanceSnapshot {
  readonly state: DeviceLanIssuanceState;
  readonly runId: string;
  readonly roomName?: string;
  readonly participantName?: string;
  readonly deviceId?: string;
  readonly clientInstanceId?: string;
  readonly deadlineAt?: number;
  readonly revocationReason?: DeviceLanRevocationReason;
  readonly roomAbsenceVerifiedAt?: number;
}

interface DeviceLanIssuanceGate {
  state: DeviceLanIssuanceState;
  readonly runId: string;
  binding?: Pick<
    DeviceLanIssuanceSnapshot,
    'roomName' | 'participantName' | 'deviceId' | 'clientInstanceId' | 'deadlineAt'
  >;
  revocationReason?: DeviceLanRevocationReason;
  roomAbsenceVerifiedAt?: number;
}

function setLiveKitIssuedAt(token: AccessToken, issuedAtSeconds: number): void {
  // AccessToken 2.13.3 signs its internal registered-claim map but omits iat.
  // Keep signing in the pinned official SDK while supplying the required registered claim.
  const sdkToken = token as unknown as { grants?: Record<string, unknown> };
  if (
    sdkToken.grants === undefined ||
    !Number.isSafeInteger(issuedAtSeconds) ||
    issuedAtSeconds <= 0
  ) {
    throw new Error('LIVEKIT_TOKEN_IAT_BINDING_FAILED');
  }
  sdkToken.grants.iat = issuedAtSeconds;
}

export interface RoomDeletionClient {
  deleteRoom(room: string): Promise<void>;
  listRooms(names?: string[]): Promise<Array<{ name: string }>>;
}

export interface RoomServicePort extends RoomDeletionClient {
  createRoom(options: Parameters<RoomServiceClient['createRoom']>[0]): Promise<unknown>;
  listParticipants(
    room: string,
  ): Promise<Array<{ identity: string; tracks?: readonly unknown[] }>>;
}

export type EphemeralObjectHandle = object;

interface EphemeralResourceBinding {
  readonly handle: EphemeralObjectHandle;
  readonly mediaRefDigest: string;
}

export interface BoundEphemeralObject {
  readonly resourceKey: string;
  readonly handle: EphemeralObjectHandle;
}

export interface EphemeralObjectOwner {
  bind(sessionId: string, mediaRef: Readonly<JsonObject>): BoundEphemeralObject | undefined;
  deleteObject(handle: EphemeralObjectHandle): Promise<void>;
  objectIsAbsent(handle: EphemeralObjectHandle): Promise<boolean>;
}

export interface DeviceSessionAdapterDependencies {
  readonly roomService?: RoomServicePort;
  readonly now?: () => number;
  readonly scheduleCleanupRetry?: CleanupRetryScheduler;
  readonly cancelCleanupRetry?: (handle: ScheduledHandle) => void;
  readonly scheduleSessionExpiry?: SessionExpiryScheduler;
  readonly cancelSessionExpiry?: (handle: ScheduledHandle) => void;
  readonly enableGatewayJoin?: boolean;
  readonly ephemeralObjectOwner?: EphemeralObjectOwner;
  readonly bindLiveKitObservationTestSeam?: (
    observe: (
      sessionId: string,
      participant: RemoteParticipant,
      publication: RemoteTrackPublication,
    ) => void,
  ) => void;
  readonly roomFactory?: () => Room;
  readonly audioStreamFactory?: (track: RemoteTrack) => AsyncIterable<FixedCanaryAudioFrame>;
  readonly directLoopController?: DirectLoopController;
  readonly observeDirectLoop?: (observation: DirectLoopObservation) => void;
  readonly retryStateProbe?: (
    state: readonly Readonly<{ resourceKey: string; mediaRefDigest: string }>[],
  ) => void;
  readonly signParticipantToken?: (token: AccessToken) => Promise<string>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly supervisedFenceTimeoutMs?: number;
  readonly stageSupervisedAbsenceProofs?: (
    documents: SupervisedAbsenceProofDocuments,
  ) => Promise<SupervisedAbsenceProofCommitter>;
  readonly persistSupervisedCleanupReceipt?: (receipt: SupervisedCleanupReceipt) => Promise<void>;
  /** Read-only copy of each newly accepted event; observer failure never changes admission. */
  readonly observeAcceptedEventProjection?: (event: Readonly<EventEnvelope>) => void;
}

export type DirectLoopObservationStage =
  | 'STT_CAPTURE'
  | 'STT_RESULT'
  | 'MODEL_REQUEST'
  | 'MODEL_RESULT'
  | 'DIRECTED_CHAT_SUCCESS'
  | 'TERMINAL_ERROR';

export interface DirectLoopObservation {
  readonly stage: DirectLoopObservationStage;
  readonly session_id: string;
  readonly publication_sid: string;
  readonly track_attempt: number;
  readonly error_code?: string;
}

function directLoopErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message.split(':', 1)[0]! : '';
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate) ? candidate : 'DIRECT_LOOP_FAILED';
}

function isRoomNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & { status?: number; code?: string | number };
  return (
    detail.status === 404 ||
    detail.code === 404 ||
    detail.code === 'not_found' ||
    /(?:room\s+not\s+found|not_found)/i.test(detail.message)
  );
}

export async function deleteAndVerifyRoom(
  roomService: RoomDeletionClient,
  sessionId: string,
): Promise<void> {
  try {
    await roomService.deleteRoom(sessionId);
  } catch (error) {
    if (!isRoomNotFound(error)) throw error;
  }
  const survivors = await roomService.listRooms([sessionId]);
  let verifiedPlainEmptyArray = false;
  try {
    const ownKeys = Array.isArray(survivors) ? Reflect.ownKeys(survivors) : [];
    let prototypeHasIndexedProperty = false;
    for (
      let prototype: object | null = Array.prototype;
      prototype !== null;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      if (
        Reflect.ownKeys(prototype).some(
          (key) => typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/.test(key),
        )
      ) {
        prototypeHasIndexedProperty = true;
        break;
      }
    }
    const lengthDescriptor = Array.isArray(survivors)
      ? Object.getOwnPropertyDescriptor(survivors, 'length')
      : undefined;
    verifiedPlainEmptyArray =
      Array.isArray(survivors) &&
      !nodeUtilTypes.isProxy(survivors) &&
      Object.getPrototypeOf(survivors) === Array.prototype &&
      !prototypeHasIndexedProperty &&
      survivors.length === 0 &&
      ownKeys.length === 1 &&
      ownKeys[0] === 'length' &&
      lengthDescriptor?.value === 0 &&
      lengthDescriptor.enumerable === false &&
      lengthDescriptor.configurable === false;
  } catch {
    verifiedPlainEmptyArray = false;
  }
  if (!verifiedPlainEmptyArray) {
    throw new Error('ROOM_DELETE_NOT_VERIFIED');
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function assertSupervisedBinding(
  binding: SupervisedDeviceLanBinding,
  deviceLanRunId: string,
): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      binding.firewallRunId,
    ) ||
    !/^[0-9a-f]{32}$/.test(binding.activationAttemptId) ||
    binding.activationAttemptId === '0'.repeat(32) ||
    !/^phase0_session_[0-9a-f]{20}$/.test(binding.sessionId) ||
    binding.roomName !== binding.sessionId ||
    !/^web_device_[0-9a-f]{20}$/.test(binding.deviceId) ||
    binding.participantIdentity !== binding.deviceId ||
    !/^web_client_[0-9a-f]{20}$/.test(binding.clientInstanceId) ||
    deviceLanRunId !== `p0_${binding.firewallRunId.replaceAll('-', '')}` ||
    !/^[A-Za-z]:\\[^:\u0000-\u001f]+$/.test(binding.controlRoot)
  ) {
    throw new Error('SUPERVISED_BINDING_INVALID');
  }
}

function assertPlainArray(value: unknown, code: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(code);
  }
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index)).concat(
    'length',
  );
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => typeof key !== 'string' || key !== expectedKeys[index])
  ) {
    throw new Error(code);
  }
  return value;
}

function assertPlainDataObject(value: unknown, code: string): Record<string, unknown> {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(code);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function ownDataProperty(
  value: Record<string, unknown>,
  name: string,
  code: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(code);
  return descriptor.value;
}

interface SupervisedRoomServiceSnapshot {
  readonly room_name: string;
  readonly participant_identity: typeof GATEWAY_DEVICE_ID;
  readonly track_count: 0;
}

export function assertSupervisedRoomServiceSnapshot(
  roomsValue: unknown,
  participantsValue: unknown,
  roomName: string,
): SupervisedRoomServiceSnapshot {
  const rooms = assertPlainArray(roomsValue, 'SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  if (rooms.length !== 1) throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  const roomValue = rooms[0];
  if (
    roomValue === null ||
    typeof roomValue !== 'object' ||
    Array.isArray(roomValue) ||
    nodeUtilTypes.isProxy(roomValue)
  ) {
    throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  }
  const room = {
    name: ownDataProperty(
      roomValue as Record<string, unknown>,
      'name',
      'SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID',
    ),
  };
  if (room.name !== roomName) {
    throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  }
  const participants = assertPlainArray(
    participantsValue,
    'SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID',
  );
  if (participants.length !== 1) {
    throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  }
  const participantValue = participants[0];
  if (
    participantValue === null ||
    typeof participantValue !== 'object' ||
    Array.isArray(participantValue) ||
    nodeUtilTypes.isProxy(participantValue)
  ) {
    throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  }
  const participant = {
    identity: ownDataProperty(
      participantValue as Record<string, unknown>,
      'identity',
      'SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID',
    ),
    tracks: ownDataProperty(
      participantValue as Record<string, unknown>,
      'tracks',
      'SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID',
    ),
  };
  if (participant.identity !== GATEWAY_DEVICE_ID) {
    throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  }
  const tracks = assertPlainArray(
    participant.tracks,
    'SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID',
  );
  if (tracks.length !== 0) throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_INVALID');
  return {
    room_name: roomName,
    participant_identity: GATEWAY_DEVICE_ID,
    track_count: 0,
  };
}

function compactNfcJsonBytes(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  if (
    text.length === 0 ||
    text.includes('\r') ||
    text.includes('\u0000') ||
    text.normalize('NFC') !== text
  ) {
    throw new Error('SUPERVISED_PROOF_ENCODING_INVALID');
  }
  return Buffer.from(text, 'utf8');
}

function bytesSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface CapturedSupervisedRtcSnapshot {
  readonly bindingFingerprint: string;
  readonly contactObserved: boolean;
  readonly participantSid: string | null;
  readonly publicationSid: string | null;
  readonly observationEpoch: number;
  readonly observationGeneration: number;
  readonly participantBytes: Buffer;
  readonly publicationBytes: Buffer;
}

const CAPTURED_SUPERVISED_RTC_SNAPSHOTS =
  new WeakMap<SupervisedRtcLiveMapSnapshot, CapturedSupervisedRtcSnapshot>();
const MAP_SIZE_GETTER = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const MAP_ENTRIES = Map.prototype.entries;

function ordinaryMapEntries(value: unknown, code: string): readonly (readonly [unknown, unknown])[] {
  try {
    if (
      !(value instanceof Map) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Map.prototype ||
      Reflect.ownKeys(value).length !== 0
    ) {
      throw new Error(code);
    }
    const entries = [
      ...(Reflect.apply(MAP_ENTRIES, value, []) as IterableIterator<[unknown, unknown]>),
    ].map(([key, entry]) => Object.freeze([key, entry] as const));
    const size = Reflect.apply(MAP_SIZE_GETTER, value, []) as number;
    if (!Number.isSafeInteger(size) || size !== entries.length) throw new Error(code);
    return Object.freeze(entries);
  } catch {
    throw new Error(code);
  }
}

function supervisedContactClaim(
  participantSid: string | null,
  contactObserved: boolean,
  publicationSid: string | null,
): void {
  if (
    (contactObserved &&
      (participantSid === null ||
        !/^PA_[A-Za-z0-9_-]{3,64}$/.test(participantSid) ||
        publicationSid === null ||
        !/^TR_[A-Za-z0-9_-]{3,64}$/.test(publicationSid))) ||
    (!contactObserved && (participantSid !== null || publicationSid !== null))
  ) {
    throw new Error('SUPERVISED_CONTACT_LEDGER_INVALID');
  }
}

interface SupervisedObservationWitness {
  readonly participantSid: string | null;
  readonly observationEpoch: number;
  readonly observationGeneration: number;
}

const SUPERVISED_OBSERVATION_MAGIC = 'paos-observation-v1';
const SUPERVISED_OBSERVATION_PAYLOAD_MAX_BYTES = 121;
const SUPERVISED_OBSERVATION_PREFIX_MAX_BYTES = 970;

function assertSupervisedObservationTuple(
  participantSid: string | null,
  observationEpoch: number,
  observationGeneration: number,
): void {
  if (
    (participantSid !== null && !/^PA_[A-Za-z0-9_-]{3,64}$/.test(participantSid)) ||
    !Number.isSafeInteger(observationEpoch) ||
    observationEpoch < 0 ||
    !Number.isSafeInteger(observationGeneration) ||
    observationGeneration < 1
  ) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
}

function incrementSupervisedObservationCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('SUPERVISED_OBSERVATION_COUNTER_OVERFLOW');
  }
  return value + 1;
}

function observationWitnessPayload(
  participantSid: string | null,
  observationEpoch: number,
  observationGeneration: number,
): Buffer {
  assertSupervisedObservationTuple(participantSid, observationEpoch, observationGeneration);
  const payload = Buffer.from(
    `${SUPERVISED_OBSERVATION_MAGIC}|${participantSid ?? '-'}|${observationEpoch}|${observationGeneration}`,
    'ascii',
  );
  if (payload.byteLength > SUPERVISED_OBSERVATION_PAYLOAD_MAX_BYTES) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  return payload;
}

function observationWitnessPrefix(
  participantSid: string | null,
  observationEpoch: number,
  observationGeneration: number,
): Buffer {
  const claim = observationWitnessPayload(
    participantSid,
    observationEpoch,
    observationGeneration,
  );
  let encoded = '\n';
  for (const byte of claim) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      encoded += (byte & (1 << bit)) === 0 ? ' ' : '\t';
    }
  }
  const prefix = Buffer.from(`${encoded}\n`, 'ascii');
  if (prefix.byteLength > SUPERVISED_OBSERVATION_PREFIX_MAX_BYTES) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  return prefix;
}

function providerSnapshotBytes(
  value: unknown,
  participantSid: string | null,
  observationEpoch: number,
  observationGeneration: number,
): Buffer {
  return Buffer.concat([
    observationWitnessPrefix(participantSid, observationEpoch, observationGeneration),
    Buffer.from(compactNfcJsonBytes(value)),
  ]);
}

function observationWitnessFromProviderSnapshotBytes(
  bytes: Buffer,
): SupervisedObservationWitness {
  const end = bytes.indexOf(10, 1);
  if (
    bytes[0] !== 10 ||
    end < 1 ||
    end + 1 >= bytes.byteLength ||
    bytes[end + 1] !== 123 ||
    end + 1 > SUPERVISED_OBSERVATION_PREFIX_MAX_BYTES ||
    (end - 1) % 8 !== 0 ||
    (end - 1) / 8 > SUPERVISED_OBSERVATION_PAYLOAD_MAX_BYTES
  ) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  const claim = Buffer.alloc((end - 1) / 8);
  for (let index = 0; index < claim.length; index += 1) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const token = bytes[1 + index * 8 + bit];
      if (token !== 32 && token !== 9) throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
      byte = (byte << 1) | (token === 9 ? 1 : 0);
    }
    claim[index] = byte;
  }
  const payload = claim.toString('ascii');
  if (Buffer.from(payload, 'ascii').compare(claim) !== 0) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  const fields = payload.split('|');
  if (fields.length !== 4 || fields[0] !== SUPERVISED_OBSERVATION_MAGIC) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  const participantSid =
    fields[1] === '-'
      ? null
      : /^PA_[A-Za-z0-9_-]{3,64}$/.test(fields[1]!)
        ? fields[1]!
        : undefined;
  if (
    participantSid === undefined ||
    !/^(?:0|[1-9][0-9]*)$/.test(fields[2]!) ||
    !/^[1-9][0-9]*$/.test(fields[3]!)
  ) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  const observationEpoch = Number(fields[2]);
  const observationGeneration = Number(fields[3]);
  assertSupervisedObservationTuple(participantSid, observationEpoch, observationGeneration);
  const expected = observationWitnessPrefix(
    participantSid,
    observationEpoch,
    observationGeneration,
  );
  if (!expected.equals(bytes.subarray(0, end + 1))) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  return { participantSid, observationEpoch, observationGeneration };
}

function captureSupervisedRtcLiveMapSnapshot(
  binding: SupervisedDeviceLanBinding,
  localIdentity: unknown,
  localTrackPublications: unknown,
  remoteParticipants: unknown,
  participantSid: string | null,
  contactObserved: boolean,
  publicationSid: string | null,
  observationEpoch: number,
  observationGeneration: number,
): SupervisedRtcLiveMapSnapshot {
  supervisedContactClaim(participantSid, contactObserved, publicationSid);
  assertSupervisedObservationTuple(participantSid, observationEpoch, observationGeneration);
  if (localIdentity !== GATEWAY_DEVICE_ID) {
    throw new Error('SUPERVISED_RTC_LOCAL_IDENTITY_DRIFT');
  }
  const localPublicationEntries = ordinaryMapEntries(
    localTrackPublications,
    'SUPERVISED_RTC_LOCAL_PUBLICATION_PRESENT',
  );
  const participantEntries = ordinaryMapEntries(
    remoteParticipants,
    'SUPERVISED_RTC_REMOTE_STATE_PRESENT',
  );
  if (localPublicationEntries.length !== 0) {
    throw new Error('SUPERVISED_RTC_LOCAL_PUBLICATION_PRESENT');
  }
  if (participantEntries.length !== 0) {
    throw new Error('SUPERVISED_RTC_REMOTE_STATE_PRESENT');
  }
  const common = {
    run_id: binding.firewallRunId,
    activation_attempt_id: binding.activationAttemptId,
    session_id: binding.sessionId,
    room_name: binding.roomName,
    device_id: binding.deviceId,
    participant_identity: binding.participantIdentity,
    provider: 'livekit-rtc-node' as const,
  };
  const participantRows = participantEntries.map(([identity, participant]) => ({
    identity, sid: (participant as { readonly sid?: unknown } | null)?.sid, state: 'PRESENT',
  }));
  const publicationRows = localPublicationEntries.map(([, publication]) => ({
    publisher_identity: GATEWAY_DEVICE_ID,
    publication_sid: (publication as { readonly sid?: unknown } | null)?.sid,
    source: 'microphone',
    kind: 'audio',
    state: 'PUBLISHED',
  }));
  const participantProvider = {
    schema: 'paos.livekit-participant-snapshot.v1',
    ...common,
    rows: participantRows,
  };
  const publicationProvider = {
    schema: 'paos.livekit-publication-snapshot.v1',
    ...common,
    rows: publicationRows,
    microphone_source: 'microphone',
    contact_observed: contactObserved,
    publication_sid: publicationSid,
  };
  const participantProviderBytes = providerSnapshotBytes(
    participantProvider,
    participantSid,
    observationEpoch,
    observationGeneration,
  );
  const publicationProviderBytes = providerSnapshotBytes(
    publicationProvider,
    participantSid,
    observationEpoch,
    observationGeneration,
  );
  const snapshot = Object.freeze({
    participantProviderBytesBase64: Buffer.from(participantProviderBytes).toString('base64'),
    publicationProviderBytesBase64: Buffer.from(publicationProviderBytes).toString('base64'),
    participantProviderSha256: bytesSha256(participantProviderBytes),
    publicationProviderSha256: bytesSha256(publicationProviderBytes),
    contactParticipantSidBindingSha256: bytesSha256(compactNfcJsonBytes({
      binding: stableJson(common), participant_sid: participantSid,
    })),
  });
  CAPTURED_SUPERVISED_RTC_SNAPSHOTS.set(snapshot, Object.freeze({
    bindingFingerprint: stableJson(common),
    contactObserved,
    participantSid,
    publicationSid,
    observationEpoch,
    observationGeneration,
    participantBytes: Buffer.from(participantProviderBytes),
    publicationBytes: Buffer.from(publicationProviderBytes),
  }));
  return snapshot;
}

function createSupervisedAbsenceProofDocuments(
  binding: SupervisedDeviceLanBinding,
  snapshot: SupervisedRtcLiveMapSnapshot,
  participantSid: string | null,
  contactObserved: boolean,
  publicationSid: string | null,
): SupervisedAbsenceProofDocuments {
  supervisedContactClaim(participantSid, contactObserved, publicationSid);
  const captured = CAPTURED_SUPERVISED_RTC_SNAPSHOTS.get(snapshot);
  const bindingFingerprint = stableJson({
    run_id: binding.firewallRunId,
    activation_attempt_id: binding.activationAttemptId,
    session_id: binding.sessionId,
    room_name: binding.roomName,
    device_id: binding.deviceId,
    participant_identity: binding.participantIdentity,
    provider: 'livekit-rtc-node',
  });
  if (
    !captured ||
    captured.bindingFingerprint !== bindingFingerprint ||
    captured.contactObserved !== contactObserved ||
    captured.participantSid !== participantSid ||
    captured.publicationSid !== publicationSid ||
    snapshot.participantProviderBytesBase64 !== captured.participantBytes.toString('base64') ||
    snapshot.publicationProviderBytesBase64 !== captured.publicationBytes.toString('base64') ||
    snapshot.participantProviderSha256 !== bytesSha256(captured.participantBytes) ||
    snapshot.publicationProviderSha256 !== bytesSha256(captured.publicationBytes) ||
    observationWitnessFromProviderSnapshotBytes(captured.participantBytes).participantSid !== participantSid ||
    observationWitnessFromProviderSnapshotBytes(captured.participantBytes).observationEpoch !==
      captured.observationEpoch ||
    observationWitnessFromProviderSnapshotBytes(captured.participantBytes).observationGeneration !==
      captured.observationGeneration ||
    observationWitnessFromProviderSnapshotBytes(captured.publicationBytes).participantSid !== participantSid ||
    observationWitnessFromProviderSnapshotBytes(captured.publicationBytes).observationEpoch !==
      captured.observationEpoch ||
    observationWitnessFromProviderSnapshotBytes(captured.publicationBytes).observationGeneration !==
      captured.observationGeneration ||
    snapshot.contactParticipantSidBindingSha256 !== bytesSha256(compactNfcJsonBytes({
      binding: bindingFingerprint, participant_sid: participantSid,
    }))
  ) {
    throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
  }
  const common = {
    run_id: binding.firewallRunId,
    activation_attempt_id: binding.activationAttemptId,
    session_id: binding.sessionId,
    room_name: binding.roomName,
    device_id: binding.deviceId,
    participant_identity: binding.participantIdentity,
    provider: 'livekit-rtc-node' as const,
  };
  const participantProviderBytes = Buffer.from(captured.participantBytes);
  const publicationProviderBytes = Buffer.from(captured.publicationBytes);
  const participantWrapper = {
    schema: 'paos.participant-absence-proof.v1',
    ...common,
    provider_snapshot_sha256: bytesSha256(participantProviderBytes),
    provider_snapshot_bytes: participantProviderBytes.byteLength,
    provider_snapshot_bytes_base64: Buffer.from(participantProviderBytes).toString('base64'),
  };
  const publicationWrapper = {
    schema: 'paos.publication-absence-proof.v1',
    ...common,
    provider_snapshot_sha256: bytesSha256(publicationProviderBytes),
    provider_snapshot_bytes: publicationProviderBytes.byteLength,
    provider_snapshot_bytes_base64: Buffer.from(publicationProviderBytes).toString('base64'),
    microphone_source: 'microphone',
    contact_observed: contactObserved,
    publication_sid: publicationSid,
  };
  const participantBytes = compactNfcJsonBytes(participantWrapper);
  const publicationBytes = compactNfcJsonBytes(publicationWrapper);
  if (participantBytes.byteLength > 131_072 || publicationBytes.byteLength > 131_072) {
    throw new Error('SUPERVISED_PROOF_SIZE_INVALID');
  }
  return Object.freeze({
    participantBytes,
    publicationBytes,
    participantSha256: bytesSha256(participantBytes),
    publicationSha256: bytesSha256(publicationBytes),
    contactObserved,
    participantSid,
    publicationSid,
    observationEpoch: captured.observationEpoch,
    observationGeneration: captured.observationGeneration,
  });
}

export function assertEmptyOrdinaryMap(value: unknown, code: string): void {
  if (ordinaryMapEntries(value, code).length !== 0) throw new Error(code);
}

const STRICT_JSON_MAX_DEPTH = 32;
const JWT_HEADER_MAX_ENCODED_LENGTH = 256;
const JWT_PAYLOAD_MAX_ENCODED_LENGTH = 6_144;
const RTC_EVENT_JSON_MAX_BYTES = 16_384;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class StrictJsonParser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) this.#reject();
    return value;
  }

  #parseValue(depth: number): unknown {
    const character = this.#text[this.#index];
    if (character === '{') {
      if (depth >= STRICT_JSON_MAX_DEPTH) this.#reject();
      return this.#parseObject(depth);
    }
    if (character === '[') {
      if (depth >= STRICT_JSON_MAX_DEPTH) this.#reject();
      return this.#parseArray(depth);
    }
    if (character === '"') return this.#parseString(false).value;
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      return this.#parseNumber();
    }
    if (this.#text.startsWith('true', this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.#text.startsWith('false', this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.#text.startsWith('null', this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#reject();
  }

  #parseObject(depth: number): Record<string, unknown> {
    this.#index += 1;
    const object = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#text[this.#index] === '}') {
      this.#index += 1;
      return object;
    }
    while (this.#index < this.#text.length) {
      if (this.#text[this.#index] !== '"') this.#reject();
      const key = this.#parseString(true);
      if (keys.has(key.value)) this.#reject();
      keys.add(key.value);
      if (key.hadEscape || FORBIDDEN_JSON_KEYS.has(key.value)) this.#reject();
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ':') this.#reject();
      this.#index += 1;
      this.#skipWhitespace();
      object[key.value] = this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.#text[this.#index];
      if (delimiter === '}') {
        this.#index += 1;
        return object;
      }
      if (delimiter !== ',') this.#reject();
      this.#index += 1;
      this.#skipWhitespace();
    }
    return this.#reject();
  }

  #parseArray(depth: number): unknown[] {
    this.#index += 1;
    const array: unknown[] = [];
    this.#skipWhitespace();
    if (this.#text[this.#index] === ']') {
      this.#index += 1;
      return array;
    }
    while (this.#index < this.#text.length) {
      array.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      const delimiter = this.#text[this.#index];
      if (delimiter === ']') {
        this.#index += 1;
        return array;
      }
      if (delimiter !== ',') this.#reject();
      this.#index += 1;
      this.#skipWhitespace();
    }
    return this.#reject();
  }

  #parseString(isKey: boolean): { readonly value: string; readonly hadEscape: boolean } {
    this.#index += 1;
    let value = '';
    let hadEscape = false;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        this.#index += 1;
        return { value, hadEscape };
      }
      if (character === '\\') {
        hadEscape = true;
        this.#index += 1;
        const escaped = this.#text[this.#index];
        if (escaped === undefined) this.#reject();
        this.#index += 1;
        switch (escaped) {
          case '"':
          case '\\':
          case '/':
            value += escaped;
            break;
          case 'b':
            value += '\b';
            break;
          case 'f':
            value += '\f';
            break;
          case 'n':
            value += '\n';
            break;
          case 'r':
            value += '\r';
            break;
          case 't':
            value += '\t';
            break;
          case 'u':
            value += this.#parseUnicodeEscape();
            break;
          default:
            this.#reject();
        }
        continue;
      }
      if (code < 0x20 || code === 0xfeff) this.#reject();
      if (code >= 0xd800 && code <= 0xdbff) {
        const nextCode = this.#text.charCodeAt(this.#index + 1);
        if (nextCode < 0xdc00 || nextCode > 0xdfff) this.#reject();
        value += character + this.#text[this.#index + 1]!;
        this.#index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) this.#reject();
      value += character;
      this.#index += 1;
    }
    if (isKey) this.#reject();
    return this.#reject();
  }

  #parseUnicodeEscape(): string {
    const first = this.#parseHexQuad();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.#text[this.#index] !== '\\' || this.#text[this.#index + 1] !== 'u') {
        this.#reject();
      }
      this.#index += 2;
      const second = this.#parseHexQuad();
      if (second < 0xdc00 || second > 0xdfff) this.#reject();
      return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
    }
    if (first >= 0xdc00 && first <= 0xdfff) this.#reject();
    return String.fromCharCode(first);
  }

  #parseHexQuad(): number {
    const raw = this.#text.slice(this.#index, this.#index + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(raw)) this.#reject();
    this.#index += 4;
    return Number.parseInt(raw, 16);
  }

  #parseNumber(): number {
    const start = this.#index;
    if (this.#text[this.#index] === '-') this.#index += 1;
    if (this.#text[this.#index] === '0') {
      this.#index += 1;
      const next = this.#text[this.#index];
      if (next !== undefined && next >= '0' && next <= '9') this.#reject();
    } else {
      const first = this.#text[this.#index];
      if (first === undefined || first < '1' || first > '9') this.#reject();
      do {
        this.#index += 1;
      } while (
        this.#text[this.#index] !== undefined &&
        this.#text[this.#index]! >= '0' &&
        this.#text[this.#index]! <= '9'
      );
    }
    if (this.#text[this.#index] === '.') {
      this.#index += 1;
      const firstFraction = this.#text[this.#index];
      if (
        firstFraction === undefined ||
        firstFraction < '0' ||
        firstFraction > '9'
      ) {
        this.#reject();
      }
      do {
        this.#index += 1;
      } while (
        this.#text[this.#index] !== undefined &&
        this.#text[this.#index]! >= '0' &&
        this.#text[this.#index]! <= '9'
      );
    }
    if (this.#text[this.#index] === 'e' || this.#text[this.#index] === 'E') {
      this.#index += 1;
      if (this.#text[this.#index] === '+' || this.#text[this.#index] === '-') {
        this.#index += 1;
      }
      const firstExponent = this.#text[this.#index];
      if (
        firstExponent === undefined ||
        firstExponent < '0' ||
        firstExponent > '9'
      ) {
        this.#reject();
      }
      do {
        this.#index += 1;
      } while (
        this.#text[this.#index] !== undefined &&
        this.#text[this.#index]! >= '0' &&
        this.#text[this.#index]! <= '9'
      );
    }
    const parsed = Number(this.#text.slice(start, this.#index));
    if (!Number.isFinite(parsed)) this.#reject();
    return parsed;
  }

  #skipWhitespace(): void {
    while (
      this.#text[this.#index] === ' ' ||
      this.#text[this.#index] === '\t' ||
      this.#text[this.#index] === '\n' ||
      this.#text[this.#index] === '\r'
    ) {
      this.#index += 1;
    }
  }

  #reject(): never {
    throw new Error('STRICT_JSON_REJECTED');
  }
}

export function parseStrictJsonBytes(input: Uint8Array, maximumBytes: number): unknown {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    input.byteLength < 1 ||
    input.byteLength > maximumBytes ||
    (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf)
  ) {
    throw new Error('STRICT_JSON_REJECTED');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    throw new Error('STRICT_JSON_REJECTED');
  }
  return new StrictJsonParser(text).parse();
}

function decodeJwtObject(
  segment: string,
  maximumEncodedLength: number,
  errorCode: string,
): Record<string, unknown> {
  try {
    if (
      segment.length < 1 ||
      segment.length > maximumEncodedLength ||
      segment.length % 4 === 1 ||
      !/^[A-Za-z0-9_-]+$/.test(segment)
    ) {
      throw new Error(errorCode);
    }
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) throw new Error(errorCode);
    const decoded = parseStrictJsonBytes(bytes, Math.ceil((maximumEncodedLength * 3) / 4));
    if (decoded === null || Array.isArray(decoded) || typeof decoded !== 'object') {
      throw new Error(errorCode);
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error(errorCode);
  }
}

function assertClosedObject(
  actual: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
  errorCode: string,
): void {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(errorCode);
}

function assertDeviceLanParticipantToken(
  jwt: string,
  binding: {
    readonly apiKey: string;
    readonly roomName: string;
    readonly participantIdentity: string;
    readonly participantName: string;
    readonly deviceId: string;
    readonly clientInstanceId: string;
    readonly runId: string;
    readonly issuedAtEpochSeconds: number;
    readonly currentEpochSeconds: number;
    readonly deadlineEpochSeconds: number;
  },
): number {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('LIVEKIT_TOKEN_CLOSED_BINDING_FAILED');
  }
  const header = decodeJwtObject(
    parts[0]!,
    JWT_HEADER_MAX_ENCODED_LENGTH,
    'LIVEKIT_TOKEN_CLOSED_BINDING_FAILED',
  );
  const claims = decodeJwtObject(
    parts[1]!,
    JWT_PAYLOAD_MAX_ENCODED_LENGTH,
    'LIVEKIT_TOKEN_CLOSED_BINDING_FAILED',
  );
  assertClosedObject(header, { alg: 'HS256' }, 'LIVEKIT_TOKEN_CLOSED_BINDING_FAILED');
  const expectedAttributes = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    device_id: binding.deviceId,
    device_class: 'web_mobile',
    client_instance_id: binding.clientInstanceId,
    run_id: binding.runId,
  };
  const expectedVideo = {
    room: binding.roomName,
    roomJoin: true,
    canPublish: true,
    canPublishSources: ['microphone'],
    canPublishData: false,
    canSubscribe: true,
  };
  const expiration = claims.exp;
  if (
    !Number.isSafeInteger(expiration) ||
    (expiration as number) <= binding.currentEpochSeconds ||
    (expiration as number) > binding.deadlineEpochSeconds ||
    (expiration as number) - binding.currentEpochSeconds > 120 ||
    (expiration as number) - binding.issuedAtEpochSeconds > 120
  ) {
    throw new Error('LIVEKIT_TOKEN_DEADLINE_BINDING_FAILED');
  }
  assertClosedObject(
    claims,
    {
      name: binding.participantName,
      attributes: expectedAttributes,
      video: expectedVideo,
      iat: binding.issuedAtEpochSeconds,
      iss: binding.apiKey,
      exp: expiration,
      nbf: 0,
      sub: binding.participantIdentity,
    },
    'LIVEKIT_TOKEN_CLOSED_BINDING_FAILED',
  );
  return expiration as number;
}

function assertDeviceLanGatewayToken(
  jwt: string,
  binding: {
    readonly apiKey: string;
    readonly roomName: string;
    readonly identity: string;
    readonly attributes: Readonly<Record<string, string>>;
    readonly issuedAtEpochSeconds: number;
    readonly currentEpochSeconds: number;
    readonly deadlineEpochSeconds: number;
    readonly maximumTtlSeconds?: number;
  },
): void {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('LIVEKIT_GATEWAY_TOKEN_CLOSED_BINDING_FAILED');
  }
  const header = decodeJwtObject(
    parts[0]!,
    JWT_HEADER_MAX_ENCODED_LENGTH,
    'LIVEKIT_GATEWAY_TOKEN_CLOSED_BINDING_FAILED',
  );
  const claims = decodeJwtObject(
    parts[1]!,
    JWT_PAYLOAD_MAX_ENCODED_LENGTH,
    'LIVEKIT_GATEWAY_TOKEN_CLOSED_BINDING_FAILED',
  );
  assertClosedObject(header, { alg: 'HS256' }, 'LIVEKIT_GATEWAY_TOKEN_CLOSED_BINDING_FAILED');
  const expiration = claims.exp;
  const maximumTtlSeconds = binding.maximumTtlSeconds ?? 120;
  if (
    !Number.isSafeInteger(expiration) ||
    (expiration as number) <= binding.currentEpochSeconds ||
    (expiration as number) > binding.deadlineEpochSeconds ||
    (expiration as number) - binding.currentEpochSeconds > maximumTtlSeconds ||
    (expiration as number) - binding.issuedAtEpochSeconds > maximumTtlSeconds
  ) {
    throw new Error('LIVEKIT_GATEWAY_TOKEN_DEADLINE_BINDING_FAILED');
  }
  assertClosedObject(
    claims,
    {
      name: 'Windows Demo Gateway',
      attributes: binding.attributes,
      video: {
        room: binding.roomName,
        roomJoin: true,
        canPublish: false,
        canPublishData: true,
        canSubscribe: true,
      },
      iat: binding.issuedAtEpochSeconds,
      iss: binding.apiKey,
      exp: expiration,
      nbf: 0,
      sub: binding.identity,
    },
    'LIVEKIT_GATEWAY_TOKEN_CLOSED_BINDING_FAILED',
  );
}

function displayText(event: EventEnvelope): string | undefined {
  if (event.event_type === 'paios.phase0.demo.transcript.final') {
    return typeof event.payload.text === 'string' ? event.payload.text : undefined;
  }
  if (event.event_type !== 'paios.phase0.demo.model.result') return undefined;
  const textOutput = (event.payload.outputs ?? []).find(
    (output: JsonObject) => output.modality === 'text',
  );
  return typeof textOutput?.text === 'string' ? textOutput.text : undefined;
}

interface TemporaryMediaReference {
  readonly transport: 'livekit_track' | 'ephemeral_object';
  readonly locator: string;
  readonly mediaRef: JsonObject;
}

type TemporaryResourceAdmission =
  | {
      readonly accepted: true;
      readonly ephemeralObjects: ReadonlyMap<string, EphemeralResourceBinding>;
      readonly pendingLiveKitMediaKeys: ReadonlySet<string>;
      readonly liveKitResourceKeys: ReadonlySet<string>;
      readonly modelCache: ModelCorrelationCache;
    }
  | {
      readonly accepted: false;
      readonly error: string;
    };

function collectTemporaryMedia(
  value: unknown,
  output: TemporaryMediaReference[] = [],
): TemporaryMediaReference[] {
  if (Array.isArray(value)) {
    for (const child of value) collectTemporaryMedia(child, output);
  } else if (value !== null && typeof value === 'object') {
    const object = value as JsonObject;
    if (
      ['media_id', 'kind', 'transport', 'locator', 'expires_at'].every(
        (field) => field in object,
      ) &&
      (object.transport === 'livekit_track' || object.transport === 'ephemeral_object') &&
      typeof object.locator === 'string'
    ) {
      output.push({
        transport: object.transport,
        locator: object.locator,
        mediaRef: object,
      });
    }
    for (const child of Object.values(object)) collectTemporaryMedia(child, output);
  }
  return output;
}

export function assertDispatchRequest(body: JsonObject, _ignoredLegacyAgentName?: string): void {
  if (Object.keys(body).length !== 0) throw new Error('CONNECTION_REQUEST_CLOSED_MAP');
}

export function assertRtcPublisherBinding(
  runtime: SessionRuntime,
  candidate: unknown,
  participant: RemoteParticipant | undefined,
  kind: DataPacketKind | undefined,
  topic: string | undefined,
): asserts candidate is EventEnvelope {
  if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') {
    throw new Error('RTC_EVENT_OBJECT_REQUIRED');
  }
  const event = candidate as EventEnvelope;
  if (event.schema_version !== CONTRACT_SCHEMA_VERSION)
    throw new Error('RTC_SCHEMA_VERSION_MISMATCH');
  if (event.session_id !== runtime.id) throw new Error('RTC_SESSION_BINDING_MISMATCH');
  const binding = rtcEventTransportBinding(event.event_type);
  if (topic !== binding.topic) throw new Error('RTC_TOPIC_MAPPING_VIOLATION');
  if (kind !== binding.kind) throw new Error('RTC_RELIABILITY_MAPPING_VIOLATION');
  if (!participant) throw new Error('RTC_PUBLISHER_REQUIRED');
  const origin = event.origin as JsonObject | undefined;
  if (!origin) throw new Error('RTC_PUBLISHER_MAPPING_VIOLATION');
  const attributes = participant.attributes;
  if (
    LEGACY_GATEWAY_IDENTITY_ALIASES.has(participant.identity) ||
    LEGACY_GATEWAY_IDENTITY_ALIASES.has(String(attributes.device_id))
  ) {
    throw new Error('GATEWAY_PUBLISHER_BINDING_MISMATCH');
  }
  if (
    LEGACY_GATEWAY_IDENTITY_ALIASES.has(String(origin.device_id)) ||
    LEGACY_GATEWAY_IDENTITY_ALIASES.has(String(origin.relay?.relay_device_id))
  ) {
    throw new Error('GATEWAY_FOREIGN_ORIGIN_RELAY_FORBIDDEN');
  }
  if (origin.device_class === 'apple_watch') {
    const relay = origin.relay as JsonObject | undefined;
    if (
      !relay ||
      relay.transport !== 'watch_connectivity' ||
      relay.relay_device_class !== 'iphone' ||
      participant.identity !== relay.relay_device_id ||
      attributes.device_id !== relay.relay_device_id ||
      attributes.device_class !== relay.relay_device_class ||
      attributes.schema_version !== event.schema_version ||
      participant.identity === GATEWAY_DEVICE_ID
    ) {
      throw new Error('RTC_WATCH_RELAY_MAPPING_VIOLATION');
    }
    return;
  }
  if (origin.relay !== undefined) throw new Error('RTC_GENERIC_RELAY_FORBIDDEN');
  const gatewayPublisherClaim =
    participant.identity === GATEWAY_DEVICE_ID ||
    attributes.device_id === GATEWAY_DEVICE_ID ||
    attributes.device_class === 'windows_gateway';
  const gatewayOriginClaim =
    origin.device_class === 'windows_gateway' || origin.device_id === GATEWAY_DEVICE_ID;
  if (
    (gatewayPublisherClaim || gatewayOriginClaim) &&
    (participant.identity !== GATEWAY_DEVICE_ID ||
      attributes.device_id !== GATEWAY_DEVICE_ID ||
      attributes.device_class !== 'windows_gateway' ||
      attributes.client_instance_id !== GATEWAY_CLIENT_ID ||
      attributes.schema_version !== CONTRACT_SCHEMA_VERSION)
  ) {
    throw new Error('GATEWAY_PUBLISHER_BINDING_MISMATCH');
  }
  if (
    gatewayPublisherClaim &&
    (origin.device_id !== GATEWAY_DEVICE_ID ||
      origin.device_class !== 'windows_gateway' ||
      origin.client_instance_id !== GATEWAY_CLIENT_ID)
  ) {
    throw new Error('GATEWAY_FOREIGN_ORIGIN_RELAY_FORBIDDEN');
  }
  if (
    participant.identity !== origin.device_id ||
    attributes.device_id !== origin.device_id ||
    attributes.device_class !== origin.device_class ||
    attributes.client_instance_id !== origin.client_instance_id ||
    attributes.schema_version !== event.schema_version
  ) {
    throw new Error('RTC_PUBLISHER_MAPPING_VIOLATION');
  }
}

export class DeviceSessionAdapter {
  readonly #config: GatewayConfig;
  readonly #roomService: RoomServicePort;
  readonly #now: () => number;
  readonly #scheduleCleanupRetry: CleanupRetryScheduler;
  readonly #cancelCleanupRetry: (handle: ScheduledHandle) => void;
  readonly #scheduleSessionExpiry: SessionExpiryScheduler;
  readonly #cancelSessionExpiry: (handle: ScheduledHandle) => void;
  readonly #enableGatewayJoin: boolean;
  readonly #ephemeralObjectOwner: EphemeralObjectOwner | undefined;
  readonly #retryStateProbe: DeviceSessionAdapterDependencies['retryStateProbe'];
  readonly #roomFactory: () => Room;
  readonly #audioStreamFactory: (track: RemoteTrack) => AsyncIterable<FixedCanaryAudioFrame>;
  readonly #directLoop: DirectLoopController | undefined;
  readonly #observeDirectLoop: NonNullable<DeviceSessionAdapterDependencies['observeDirectLoop']>;
  readonly #deviceLanIssuance: DeviceLanIssuanceGate | undefined;
  readonly #signParticipantToken: (token: AccessToken) => Promise<string>;
  readonly #sleep: (milliseconds: number) => Promise<void>; readonly #supervisedFenceTimeoutMs: number;
  readonly #stageSupervisedAbsenceProofs:
    ((documents: SupervisedAbsenceProofDocuments) => Promise<SupervisedAbsenceProofCommitter>) | undefined;
  readonly #persistSupervisedCleanupReceipt:
    ((receipt: SupervisedCleanupReceipt) => Promise<void>) | undefined;
  readonly #observeAcceptedEventProjection:
    ((event: Readonly<EventEnvelope>) => void) | undefined;
  readonly #deviceLanRoomNames = new Set<string>();
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #tombstones = new Map<string, Tombstone>();
  readonly #terminalFailures = new Map<string, TerminalFailure>();
  readonly #ephemeralResourceBindings = new Map<
    string,
    { readonly sessionId: string; readonly mediaRefDigest: string }
  >();

  constructor(config: GatewayConfig, dependencies: DeviceSessionAdapterDependencies = {}) {
    this.#config = config;
    if (config.deviceLan !== undefined) {
      let clientLivekitUrl: URL;
      try {
        clientLivekitUrl = new URL(config.deviceLan.clientLivekitUrl);
      } catch {
        throw new Error('DEVICE_LAN_CONFIG_INVALID');
      }
      if (
        config.sessionTtlSeconds !== 120 ||
        config.tokenTtlSeconds !== 120 ||
        clientLivekitUrl.protocol !== 'wss:' ||
        clientLivekitUrl.pathname !== '/' ||
        clientLivekitUrl.search !== '' ||
        clientLivekitUrl.hash !== '' ||
        clientLivekitUrl.username !== '' ||
        clientLivekitUrl.password !== '' ||
        !/^[a-z][a-z0-9_-]{2,63}$/.test(config.deviceLan.runId) ||
        config.deviceLan.roomAutoCreateDisabled !== true
      ) {
        throw new Error('DEVICE_LAN_CONFIG_INVALID');
      }
      if (config.deviceLan.supervised !== undefined) {
        assertSupervisedBinding(config.deviceLan.supervised, config.deviceLan.runId);
        if (dependencies.enableGatewayJoin === false) {
          throw new Error('SUPERVISED_GATEWAY_JOIN_REQUIRED');
        }
        this.#deviceLanRoomNames.add(config.deviceLan.supervised.sessionId);
      }
      this.#deviceLanIssuance = {
        state: 'ARMED',
        runId: config.deviceLan.runId,
      };
    } else {
      this.#deviceLanIssuance = undefined;
    }
    this.#roomService =
      dependencies.roomService ??
      new RoomServiceClient(config.livekitApiUrl === undefined ? httpLiveKitUrl(config.livekitUrl) :
        assertCanonicalLiveKitApiUrl(config.livekitApiUrl), config.apiKey, config.apiSecret);
    this.#now = dependencies.now ?? Date.now;
    this.#scheduleCleanupRetry =
      dependencies.scheduleCleanupRetry ??
      ((callback, delayMs) => {
        const timer = setTimeout(() => void callback(), delayMs);
        timer.unref();
        return timer;
      });
    this.#cancelCleanupRetry =
      dependencies.cancelCleanupRetry ??
      ((handle) => {
        clearTimeout(handle as NodeJS.Timeout);
      });
    this.#scheduleSessionExpiry =
      dependencies.scheduleSessionExpiry ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer;
      });
    this.#cancelSessionExpiry =
      dependencies.cancelSessionExpiry ??
      ((handle) => {
        clearTimeout(handle as NodeJS.Timeout);
      });
    this.#enableGatewayJoin = dependencies.enableGatewayJoin ?? true;
    this.#ephemeralObjectOwner = dependencies.ephemeralObjectOwner;
    this.#retryStateProbe = dependencies.retryStateProbe;
    this.#roomFactory = dependencies.roomFactory ?? createGatewayRoom;
    this.#audioStreamFactory =
      dependencies.audioStreamFactory ??
      ((track) => new AudioStream(track, { sampleRate: 24_000, numChannels: 1 }));
    this.#directLoop =
      dependencies.directLoopController ??
      (config.directLoop === undefined ? undefined : new DirectLoopController(config.directLoop));
    this.#observeDirectLoop = dependencies.observeDirectLoop ?? (() => {});
    this.#signParticipantToken =
      dependencies.signParticipantToken ?? ((token) => token.toJwt());
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#supervisedFenceTimeoutMs =
      dependencies.supervisedFenceTimeoutMs ?? SUPERVISED_FENCE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#supervisedFenceTimeoutMs) ||
      this.#supervisedFenceTimeoutMs < 1 ||
      this.#supervisedFenceTimeoutMs > SUPERVISED_FENCE_TIMEOUT_MS
    ) {
      throw new Error('SUPERVISED_FENCE_TIMEOUT_INVALID');
    }
    this.#stageSupervisedAbsenceProofs = dependencies.stageSupervisedAbsenceProofs;
    this.#persistSupervisedCleanupReceipt = dependencies.persistSupervisedCleanupReceipt;
    this.#observeAcceptedEventProjection = dependencies.observeAcceptedEventProjection;
    if (this.#enableGatewayJoin && !this.#directLoop) {
      throw new Error('DIRECT_LOOP_CONFIG_REQUIRED');
    }
    if (
      config.deviceLan?.supervised !== undefined &&
      (!this.#stageSupervisedAbsenceProofs || !this.#persistSupervisedCleanupReceipt)
    ) {
      throw new Error('SUPERVISED_EVIDENCE_SINK_REQUIRED');
    }
    dependencies.bindLiveKitObservationTestSeam?.((sessionId, participant, publication) => {
      const runtime = this.#sessions.get(sessionId);
      if (runtime) this.#observeLiveKitPublication(runtime, participant, publication);
    });
  }

  #createRuntime(
    sessionId: string,
    userDeviceId: string,
    userClientInstanceId: string,
    now: number,
    userSessionStarted: boolean,
  ): SessionRuntime {
    const expiresAt =
      now +
      (userSessionStarted
        ? this.#config.sessionTtlSeconds
        : SUPERVISED_OPERATIONAL_LEASE_SECONDS) *
        1_000;
    return {
      id: sessionId,
      traceId: randomUUID(),
      userDeviceId,
      userClientInstanceId,
      userIdentity: userDeviceId,
      credentialId: scoped('credential'),
      gatewayConnectionId: scoped('gateway_conn'),
      userConnectionId: scoped('web_conn'),
      consumer: new ContractConsumer(CONTRACT_SCHEMA_VERSION),
      subscribers: new Set(),
      expiresAt,
      sessionDeadlineEpochSeconds: Math.floor(expiresAt / 1_000),
      rtcConnected: false,
      userSessionStarted,
      observationQueue: Promise.resolve(),
      observationEpoch: 0,
      observationGeneration: 0,
      contactPublicationActive: false,
      contactState: 'NONE',
      contactConnectCount: 0,
      contactPublishCount: 0,
      contactUnpublishCount: 0,
      contactDisconnectCount: 0,
      gatewaySequence: 0,
      userSequence: 0,
      primitiveState: new OfficialPrimitiveState(),
      ephemeralObjects: new Map(),
      pendingLiveKitMediaKeys: new Set(),
      observedLiveKitPublicationKeys: new Set(),
      contractPublicationObservationKeys: new Set(),
      liveKitMediaResourceKeys: new Set(),
      directTrackAttempts: new WeakMap(),
      directTrackTokens: new Map(),
      nextTrackAttempt: 0,
      modelCache: new ModelCorrelationCache(),
      gatewayOutboundOwnership: new GatewayOutboundOwnership(),
      verifiedMediaRemovalCount: 0,
      ended: false,
      stopping: false,
    };
  }

  async prearmSupervisedSession(): Promise<SupervisedPrearmReport> {
    const binding = this.#config.deviceLan?.supervised;
    const issuance = this.#deviceLanIssuance;
    if (!binding || !issuance || issuance.state !== 'ARMED' || this.#sessions.size !== 0) {
      throw new Error('SUPERVISED_PREARM_NOT_ALLOWED');
    }
    const now = this.#now();
    const runtime = this.#createRuntime(
      binding.sessionId,
      binding.deviceId,
      binding.clientInstanceId,
      now,
      false,
    );
    this.#sessions.set(binding.sessionId, runtime);
    issuance.binding = {
      roomName: binding.roomName,
      participantName: 'user',
      deviceId: binding.deviceId,
      clientInstanceId: binding.clientInstanceId,
    };
    let roomCreated = false;
    try {
      const createRoomPromise = this.#roomService.createRoom({
        name: binding.roomName,
        emptyTimeout: SUPERVISED_OPERATIONAL_LEASE_SECONDS,
        departureTimeout: 60,
        maxParticipants: 2,
        metadata: JSON.stringify({
          schema_version: CONTRACT_SCHEMA_VERSION,
          session_id: binding.sessionId,
          active_device_id: binding.deviceId,
          active_device_lease_version: 1,
        }),
      });
      runtime.roomCreationSettled = createRoomPromise.then(
        () => undefined,
        () => undefined,
      );
      await createRoomPromise;
      roomCreated = true;

      const gatewayBinding = gatewayPublisherIdentityBinding();
      const issuedAtEpochSeconds = Math.floor(this.#now() / 1_000);
      const gatewayDeadline =
        issuedAtEpochSeconds + SUPERVISED_OPERATIONAL_LEASE_SECONDS;
      const gatewayToken = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
        identity: gatewayBinding.identity,
        name: 'Windows Demo Gateway',
        ttl: SUPERVISED_OPERATIONAL_LEASE_SECONDS,
        attributes: gatewayBinding.attributes,
      });
      const grant: VideoGrant = {
        room: binding.roomName,
        roomJoin: true,
        canPublish: false,
        canPublishData: true,
        canSubscribe: true,
      };
      gatewayToken.addGrant(grant);
      setLiveKitIssuedAt(gatewayToken, issuedAtEpochSeconds);
      const gatewayJwt = await gatewayToken.toJwt();
      assertDeviceLanGatewayToken(gatewayJwt, {
        apiKey: this.#config.apiKey,
        roomName: binding.roomName,
        identity: gatewayBinding.identity,
        attributes: gatewayBinding.attributes,
        issuedAtEpochSeconds,
        currentEpochSeconds: Math.floor(this.#now() / 1_000),
        deadlineEpochSeconds: gatewayDeadline,
        maximumTtlSeconds: SUPERVISED_OPERATIONAL_LEASE_SECONDS,
      });
      await this.#connectGatewayRoom(runtime, gatewayJwt);
      await this.#waitForStableSupervisedFence(runtime, 'prearm');
      return {
        schema: 'paos.gateway-prearm-ready.v1',
        run_id: binding.firewallRunId,
        activation_attempt_id: binding.activationAttemptId,
        session_id: binding.sessionId,
        room_name: binding.roomName,
        device_id: binding.deviceId,
        participant_identity: binding.participantIdentity,
        client_instance_id: binding.clientInstanceId,
        gateway_identity: GATEWAY_DEVICE_ID,
        room_service_stable: true,
        rtc_stable: true,
        observation_epoch: runtime.observationEpoch,
      };
    } catch (error) {
      issuance.state = 'FAILED_CLOSED';
      runtime.stopping = true;
      if (runtime.room) {
        await runtime.room.disconnect().catch(() => undefined);
        runtime.rtcConnected = false;
        delete runtime.room;
      }
      if (roomCreated) await this.#deleteAndVerifyRoom(binding.roomName);
      this.#sessions.delete(binding.sessionId);
      throw error;
    }
  }

  async #createSupervisedConnectionDetails(
    deviceLanIssuance: DeviceLanIssuanceGate,
    binding: SupervisedDeviceLanBinding,
    options: { readonly signal?: AbortSignal },
  ): Promise<ConnectionDetails> {
    const runtime = this.#sessions.get(binding.sessionId);
    if (
      !runtime ||
      runtime.userSessionStarted ||
      runtime.stopping ||
      !runtime.rtcConnected ||
      runtime.room === undefined ||
      runtime.observationPoison !== undefined
    ) {
      throw new Error('SUPERVISED_PREARM_REQUIRED');
    }
    const now = this.#now();
    runtime.expiresAt = now + this.#config.sessionTtlSeconds * 1_000;
    runtime.sessionDeadlineEpochSeconds = Math.floor(runtime.expiresAt / 1_000);
    deviceLanIssuance.binding = {
      roomName: binding.roomName,
      participantName: 'user',
      deviceId: binding.deviceId,
      clientInstanceId: binding.clientInstanceId,
      deadlineAt: runtime.expiresAt,
    };
    const expiryDelayMs = Math.max(0, runtime.expiresAt - this.#now());
    runtime.expiryTimer = this.#scheduleSessionExpiry(() => {
      void this.stopSession(runtime.id, 'timeout', 'deadline_expired').catch((error: unknown) => {
        this.#broadcast(runtime, {
          kind: 'rejected',
          sessionId: runtime.id,
          occurredAt: iso(this.#now()),
          errors: [error instanceof Error ? error.message : 'CLEANUP_FAILED'],
        });
      });
    }, expiryDelayMs);
    runtime.expiryTimer.unref?.();
    const abortIssuance = (): void => {
      if (this.#enterDeviceLanRevoking(runtime.id, 'aborted_issuance')) {
        this.#directLoop?.stopSession(runtime.id);
      }
    };
    options.signal?.addEventListener('abort', abortIssuance, { once: true });
    if (options.signal?.aborted) abortIssuance();
    try {
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      const issuedAtEpochSeconds = Math.floor(this.#now() / 1_000);
      const tokenTtlSeconds = runtime.sessionDeadlineEpochSeconds - issuedAtEpochSeconds - 1;
      if (tokenTtlSeconds < 1 || tokenTtlSeconds > this.#config.tokenTtlSeconds) {
        throw new Error('LIVEKIT_TOKEN_DEADLINE_BINDING_FAILED');
      }
      const token = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
        identity: binding.participantIdentity,
        name: 'user',
        ttl: tokenTtlSeconds,
        attributes: {
          schema_version: CONTRACT_SCHEMA_VERSION,
          device_id: binding.deviceId,
          device_class: 'web_mobile',
          client_instance_id: binding.clientInstanceId,
          run_id: deviceLanIssuance.runId,
        },
      });
      token.addGrant({
        room: binding.roomName,
        roomJoin: true,
        canPublish: true,
        canPublishSources: [ServerTrackSource.MICROPHONE],
        canPublishData: false,
        canSubscribe: true,
      });
      setLiveKitIssuedAt(token, issuedAtEpochSeconds);
      const participantToken = await this.#signParticipantToken(token);
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      const tokenExpirationEpochSeconds = assertDeviceLanParticipantToken(participantToken, {
        apiKey: this.#config.apiKey,
        roomName: binding.roomName,
        participantIdentity: binding.participantIdentity,
        participantName: 'user',
        deviceId: binding.deviceId,
        clientInstanceId: binding.clientInstanceId,
        runId: deviceLanIssuance.runId,
        issuedAtEpochSeconds,
        currentEpochSeconds: Math.floor(this.#now() / 1_000),
        deadlineEpochSeconds: runtime.sessionDeadlineEpochSeconds,
      });
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      this.#acceptGenerated(
        runtime,
        this.#gatewayEvent(runtime, 'session.started', now, {
          active_device_id: binding.deviceId,
          active_device_lease_version: 1,
          session_expires_at: iso(runtime.expiresAt),
          cleanup_deadline_at: iso(runtime.expiresAt + 300_000),
          credential_lease: {
            credential_id: runtime.credentialId,
            expires_at: iso(Math.min(runtime.expiresAt, tokenExpirationEpochSeconds * 1_000)),
            scopes: ['room_join', 'publish_audio'],
          },
        }),
      );
      runtime.userSessionStarted = true;
      deviceLanIssuance.state = 'ISSUED';
      return {
        serverUrl: this.#config.deviceLan!.clientLivekitUrl,
        roomName: binding.roomName,
        participantName: 'user',
        participantToken,
      };
    } catch (error) {
      this.#enterDeviceLanRevoking(
        runtime.id,
        options.signal?.aborted ? 'aborted_issuance' : 'error',
      );
      this.#directLoop?.stopSession(runtime.id);
      try {
        await this.stopSession(runtime.id, 'error');
      } catch (cleanupError) {
        if (deviceLanIssuance.state !== 'REVOKED') deviceLanIssuance.state = 'FAILED_CLOSED';
        throw new AggregateError([error, cleanupError], 'CREATE_COMPENSATION_FAILED');
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abortIssuance);
    }
  }

  async createConnectionDetails(
    body: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ConnectionDetails> {
    assertDispatchRequest(body);
    const deviceLanIssuance = this.#beginDeviceLanIssuance();
    const supervised = this.#config.deviceLan?.supervised;
    if (supervised !== undefined) {
      if (deviceLanIssuance === undefined) throw new Error('SUPERVISED_PREARM_REQUIRED');
      return this.#createSupervisedConnectionDetails(deviceLanIssuance, supervised, options);
    }
    const now = this.#now();
    const sessionId = this.#allocateSessionId();
    const userDeviceId = scoped('web_device');
    const userClientInstanceId = scoped('web_client');
    const userIdentity = userDeviceId;
    const runtime = this.#createRuntime(
      sessionId,
      userDeviceId,
      userClientInstanceId,
      now,
      true,
    );
    this.#sessions.set(sessionId, runtime);
    if (deviceLanIssuance) {
      deviceLanIssuance.binding = {
        roomName: sessionId,
        participantName: 'user',
        deviceId: userDeviceId,
        clientInstanceId: userClientInstanceId,
        deadlineAt: runtime.expiresAt,
      };
    }
    const expiryDelayMs = Math.max(0, runtime.expiresAt - this.#now());
    runtime.expiryTimer = this.#scheduleSessionExpiry(() => {
      void this.stopSession(sessionId, 'timeout', 'deadline_expired').catch((error: unknown) => {
        this.#broadcast(runtime, {
          kind: 'rejected',
          sessionId,
          occurredAt: iso(this.#now()),
          errors: [error instanceof Error ? error.message : 'CLEANUP_FAILED'],
        });
      });
    }, expiryDelayMs);
    runtime.expiryTimer.unref?.();
    const abortIssuance = (): void => {
      if (this.#enterDeviceLanRevoking(sessionId, 'aborted_issuance')) {
        this.#directLoop?.stopSession(sessionId);
      }
    };
    options.signal?.addEventListener('abort', abortIssuance, { once: true });
    if (options.signal?.aborted) abortIssuance();

    let roomCreated = false;
    try {
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      const createRoomPromise = this.#roomService.createRoom({
        name: sessionId,
        emptyTimeout: 60,
        departureTimeout: 60,
        maxParticipants: deviceLanIssuance ? 2 : 4,
        metadata: JSON.stringify({
          schema_version: CONTRACT_SCHEMA_VERSION,
          session_id: sessionId,
          expires_at: iso(runtime.expiresAt),
          active_device_id: userDeviceId,
          active_device_lease_version: 1,
        }),
      });
      runtime.roomCreationSettled = createRoomPromise.then(
        () => undefined,
        () => undefined,
      );
      await createRoomPromise;
      roomCreated = true;
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      const issuedAtEpochSeconds = Math.floor(this.#now() / 1_000);
      const tokenTtlSeconds = deviceLanIssuance
        ? runtime.sessionDeadlineEpochSeconds - issuedAtEpochSeconds - 1
        : this.#config.tokenTtlSeconds;
      if (tokenTtlSeconds < 1 || tokenTtlSeconds > this.#config.tokenTtlSeconds) {
        throw new Error('LIVEKIT_TOKEN_DEADLINE_BINDING_FAILED');
      }
      const token = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
        identity: userIdentity,
        name: 'user',
        ttl: tokenTtlSeconds,
        attributes: {
          schema_version: CONTRACT_SCHEMA_VERSION,
          device_id: userDeviceId,
          device_class: 'web_mobile',
          client_instance_id: userClientInstanceId,
          ...(deviceLanIssuance ? { run_id: deviceLanIssuance.runId } : {}),
        },
      });
      token.addGrant({
        room: sessionId,
        roomJoin: true,
        canPublish: true,
        canPublishSources: [ServerTrackSource.MICROPHONE],
        canPublishData: false,
        canSubscribe: true,
      });
      if (deviceLanIssuance) setLiveKitIssuedAt(token, issuedAtEpochSeconds);
      const participantToken = await this.#signParticipantToken(token);
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      const tokenExpirationEpochSeconds = deviceLanIssuance
        ? assertDeviceLanParticipantToken(participantToken, {
            apiKey: this.#config.apiKey,
            roomName: sessionId,
            participantIdentity: userIdentity,
            participantName: 'user',
            deviceId: userDeviceId,
            clientInstanceId: userClientInstanceId,
            runId: deviceLanIssuance.runId,
            issuedAtEpochSeconds,
            currentEpochSeconds: Math.floor(this.#now() / 1_000),
            deadlineEpochSeconds: runtime.sessionDeadlineEpochSeconds,
          })
        : issuedAtEpochSeconds + this.#config.tokenTtlSeconds;
      this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
      this.#acceptGenerated(
        runtime,
        this.#gatewayEvent(runtime, 'session.started', now, {
          active_device_id: userDeviceId,
          active_device_lease_version: 1,
          session_expires_at: iso(runtime.expiresAt),
          cleanup_deadline_at: iso(runtime.expiresAt + 300_000),
          credential_lease: {
            credential_id: runtime.credentialId,
            expires_at: iso(
              deviceLanIssuance
                ? Math.min(runtime.expiresAt, tokenExpirationEpochSeconds * 1_000)
                : now + this.#config.tokenTtlSeconds * 1_000,
            ),
            scopes: ['room_join', 'publish_audio'],
          },
        }),
      );
      if (this.#enableGatewayJoin) {
        runtime.joinTimer = setTimeout(() => {
          delete runtime.joinTimer;
          if (runtime.stopping || runtime.ended || !this.#sessions.has(runtime.id)) return;
          runtime.joinPromise = this.#joinGatewayAfterUser(runtime)
            .catch((error: unknown) => {
              this.#broadcast(runtime, {
                kind: 'rejected',
                sessionId,
                occurredAt: iso(),
                errors: [error instanceof Error ? error.message : 'GATEWAY_JOIN_FAILED'],
              });
              if (this.#config.deviceLan) {
                this.#triggerDeadlineOrSecurityStop(runtime, 'error');
              }
            })
            .finally(() => {
              delete runtime.joinPromise;
            });
        }, 250);
        runtime.joinTimer.unref();
      }

      if (deviceLanIssuance) {
        this.#assertDeviceLanIssuanceContinuing(deviceLanIssuance, runtime);
        deviceLanIssuance.state = 'ISSUED';
      }
      return {
        serverUrl: this.#config.deviceLan?.clientLivekitUrl ?? this.#config.livekitUrl,
        roomName: sessionId,
        participantName: 'user',
        participantToken,
      };
    } catch (error) {
      if (deviceLanIssuance) {
        this.#enterDeviceLanRevoking(
          sessionId,
          options.signal?.aborted ? 'aborted_issuance' : 'error',
        );
        this.#directLoop?.stopSession(sessionId);
      }
      if (runtime.cleanupPromise) {
        try {
          await runtime.cleanupPromise;
        } catch (cleanupError) {
          try {
            await this.#compensateFailedIssuance(runtime, roomCreated);
            this.#completeDeviceLanRevocation(sessionId);
          } catch (compensationError) {
            if (deviceLanIssuance) deviceLanIssuance.state = 'FAILED_CLOSED';
            throw new AggregateError(
              [error, cleanupError, compensationError],
              'CREATE_COMPENSATION_FAILED',
            );
          }
        }
      } else {
        try {
          await this.#compensateFailedIssuance(runtime, roomCreated);
        } catch (compensationError) {
          if (deviceLanIssuance) deviceLanIssuance.state = 'FAILED_CLOSED';
          throw new AggregateError([error, compensationError], 'CREATE_COMPENSATION_FAILED');
        }
      }
      if (
        deviceLanIssuance &&
        deviceLanIssuance.state !== 'REVOKED'
      ) {
        deviceLanIssuance.state = 'FAILED_CLOSED';
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abortIssuance);
    }
  }

  subscribe(sessionId: string, callback: (item: TimelineItem) => void): () => void {
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) throw new Error(this.#missingSessionError(sessionId));
    if (!this.#runtimeMayAct(runtime)) {
      this.#triggerDeadlineOrSecurityStop(runtime, 'deadline_expired');
      throw new Error('DEVICE_LAN_SESSION_NOT_ADMISSIBLE');
    }
    runtime.subscribers.add(callback);
    const replaySubscriber = new Set([callback]);
    for (const event of runtime.consumer.acceptedEvents()) {
      this.#deliverSubscribers(runtime, replaySubscriber, this.#timelineAccepted(event, false));
      if (!replaySubscriber.has(callback)) break;
    }
    return () => runtime.subscribers.delete(callback);
  }

  sessionExists(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  activeSessionIds(): readonly string[] {
    return [...this.#sessions.values()]
      .filter((runtime) => runtime.userSessionStarted && !runtime.stopping)
      .map((runtime) => runtime.id);
  }

  deviceLanIssuanceSnapshot(): DeviceLanIssuanceSnapshot | undefined {
    const issuance = this.#deviceLanIssuance;
    if (!issuance) return undefined;
    return {
      state: issuance.state,
      runId: issuance.runId,
      ...issuance.binding,
      ...(issuance.revocationReason === undefined
        ? {}
        : { revocationReason: issuance.revocationReason }),
      ...(issuance.roomAbsenceVerifiedAt === undefined
        ? {}
        : { roomAbsenceVerifiedAt: issuance.roomAbsenceVerifiedAt }),
    };
  }

  terminalFailureCode(sessionId: string): 'CLEANUP_SLA_MISSED' | undefined {
    return this.#activeTerminalFailure(sessionId)?.code;
  }

  ingest(sessionId: string, candidate: unknown, rtcPublisherIdentity?: string): ConsumeResult {
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) {
      const terminalFailure = this.#activeTerminalFailure(sessionId);
      if (terminalFailure) throw new Error(`CLEANUP_TERMINAL_FAILURE:${terminalFailure.code}`);
      const tombstone = this.#activeTombstone(sessionId);
      if (tombstone) {
        if (stableJson(candidate) === tombstone.cleanupFingerprint) {
          return {
            accepted: true,
            retry: true,
            errors: [],
            schemaErrors: [],
            acceptedEffectCount: tombstone.acceptedEffectCount,
          };
        }
        throw new Error('EVENT_AFTER_CLEANUP');
      }
      throw new Error('SESSION_NOT_FOUND');
    }
    if (!this.#runtimeMayAct(runtime)) {
      this.#triggerDeadlineOrSecurityStop(runtime, 'deadline_expired');
      throw new Error('DEVICE_LAN_SESSION_NOT_ADMISSIBLE');
    }
    if (
      candidate !== null &&
      !Array.isArray(candidate) &&
      typeof candidate === 'object' &&
      (candidate as { event_type?: unknown }).event_type ===
        'paios.phase0.demo.session.cleanup.completed'
    ) {
      const errors = ['CLEANUP_RECEIPT_INTERNAL_ONLY'];
      this.#broadcastRejection(runtime, errors);
      return {
        accepted: false,
        retry: false,
        errors,
        schemaErrors: [],
        acceptedEffectCount: runtime.consumer.acceptedEvents().length,
      };
    }
    const preview = runtime.consumer.validateBatch([candidate]);
    if (!preview.accepted) {
      this.#broadcastRejection(runtime, preview.errors);
      return preview;
    }
    if (preview.retry) return runtime.consumer.consume(candidate);
    const admission = this.#prepareTemporaryResourceAdmission(
      runtime,
      [candidate as EventEnvelope],
      rtcPublisherIdentity,
    );
    if (!admission.accepted) {
      const result: ConsumeResult = {
        accepted: false,
        retry: false,
        errors: [admission.error],
        schemaErrors: [],
        acceptedEffectCount: runtime.consumer.acceptedEvents().length,
      };
      this.#broadcastRejection(runtime, result.errors);
      return result;
    }
    const result = runtime.consumer.consume(candidate);
    if (result.accepted && !result.retry) {
      this.#commitTemporaryOwnership(runtime, admission);
      this.#observeProjection(candidate as EventEnvelope);
      this.#broadcast(runtime, this.#timelineAccepted(candidate as EventEnvelope, false));
    } else if (!result.accepted) {
      this.#broadcastRejection(runtime, result.errors);
    }
    return result;
  }

  stopSession(
    sessionId: string,
    reason: 'user_stop' | 'timeout' | 'gate_complete' | 'error' = 'user_stop',
    deviceLanReason: DeviceLanRevocationReason = reason,
  ): Promise<EventEnvelope> {
    if (!this.#enterDeviceLanRevoking(sessionId, deviceLanReason)) {
      return Promise.reject(new Error('DEVICE_LAN_REQUEST_DENIED'));
    }
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) return Promise.reject(new Error(this.#missingSessionError(sessionId)));
    if (runtime.cleanupPromise) return runtime.cleanupPromise;
    const cleanupPromise = this.#stopSessionOnce(runtime, reason);
    runtime.cleanupPromise = cleanupPromise;
    void cleanupPromise
      .finally(() => {
        if (runtime.cleanupPromise === cleanupPromise) delete runtime.cleanupPromise;
      })
      .catch(() => undefined);
    return cleanupPromise;
  }

  async #stopSessionOnce(
    runtime: SessionRuntime,
    reason: 'user_stop' | 'timeout' | 'gate_complete' | 'error',
  ): Promise<EventEnvelope> {
    const sessionId = runtime.id;
    runtime.stopping = true;
    this.#directLoop?.stopSession(sessionId);
    runtime.cleanupReason ??= reason;
    try {
      if (runtime.cleanupRetryTimer) {
        this.#cancelCleanupRetry(runtime.cleanupRetryTimer);
        delete runtime.cleanupRetryTimer;
      }
      if (runtime.joinTimer) {
        clearTimeout(runtime.joinTimer);
        delete runtime.joinTimer;
      }
      if (runtime.expiryTimer) {
        this.#cancelSessionExpiry(runtime.expiryTimer);
        delete runtime.expiryTimer;
      }
      if (runtime.roomCreationSettled) await runtime.roomCreationSettled;
      const cleanupWasAlreadyLate = this.#cleanupSlaMissed(runtime);
      if (cleanupWasAlreadyLate) this.#scrubLatePersonalState(runtime);
      if (runtime.userSessionStarted && !runtime.ended && !cleanupWasAlreadyLate) {
        const endedAt = this.#now();
        const cleanupDeadlineAt = endedAt + 300_000;
        this.#acceptGenerated(
          runtime,
          this.#gatewayEvent(runtime, 'session.ended', endedAt, {
            reason,
            ended_at: iso(endedAt),
            cleanup_deadline_at: iso(cleanupDeadlineAt),
          }),
        );
        runtime.ended = true;
        runtime.cleanupDeadlineAt = cleanupDeadlineAt;
        runtime.cleanupReason = reason;
      }

      if (runtime.joinPromise) await runtime.joinPromise;
      const supervisedProofs =
        this.#config.deviceLan?.supervised === undefined
          ? undefined
          : await this.#sealSupervisedAbsence(runtime);
      if (runtime.room) {
        await runtime.room.disconnect();
        runtime.rtcConnected = false;
        delete runtime.room;
      }
      const verifiedMediaRemovals = await this.#deleteAndVerifyExternalResources(runtime);

      if (this.#cleanupSlaMissed(runtime)) {
        this.#finishTerminalCleanup(runtime);
      }

      const beforeCleanup = runtime.consumer.acceptedEvents();
      const removed = {
        events: beforeCleanup.length,
        media_objects: verifiedMediaRemovals,
        session_rows: 1,
        model_cache_entries: runtime.modelCache.size,
      };
      const minimumRemovedEvents = runtime.userSessionStarted
        ? this.#config.deviceLan
          ? 1
          : 2
        : 0;
      if (removed.events < minimumRemovedEvents || removed.session_rows !== 1) {
        throw new Error('CLEANUP_REMOVAL_COUNT_INVALID');
      }
      const completedAt = this.#now();
      if (this.#cleanupSlaMissed(runtime, completedAt)) {
        this.#finishTerminalCleanup(runtime);
      }
      const receipt = this.#gatewayEvent(
        runtime,
        'session.cleanup.completed',
        completedAt,
        {
          status: 'complete',
          completed_at: iso(completedAt),
          removed,
        },
        completedAt + 3_600_000,
      );
      let acceptedEffectCount = 0;
      if (runtime.userSessionStarted) {
        const receiptPreview = runtime.consumer.validateBatch([receipt]);
        if (!receiptPreview.accepted || receiptPreview.retry) {
          throw new Error(`GENERATED_EVENT_REJECTED:${receiptPreview.errors.join(',')}`);
        }
        acceptedEffectCount = receiptPreview.acceptedEffectCount;
      }
      const subscribers = new Set(runtime.subscribers);
      this.#clearAndVerifyTemporaryState(runtime);
      this.#directLoop?.clearAfterVerifiedCleanup(sessionId);
      this.#sessions.delete(sessionId);
      if (this.#sessions.has(sessionId)) throw new Error('SESSION_ROW_DELETE_NOT_VERIFIED');
      runtime.subscribers.clear();
      this.#tombstones.set(sessionId, {
        cleanedAt: completedAt,
        expiresAt: completedAt + 3_600_000,
        cleanupFingerprint: stableJson(receipt),
        acceptedEffectCount,
      });
      setTimeout(() => this.#tombstones.delete(sessionId), 3_600_000).unref();
      this.#deliverSubscribers(runtime, subscribers, this.#timelineAccepted(receipt, false, true));
      this.#deliverSubscribers(runtime, subscribers, {
        kind: 'lifecycle',
        sessionId,
        occurredAt: iso(),
        displayText: 'cleanup complete',
      });
      if (supervisedProofs) {
        if (this.#cleanupSlaMissed(runtime)) this.#finishTerminalCleanup(runtime);
        const binding = this.#config.deviceLan!.supervised!;
        await this.#persistSupervisedCleanupReceipt!({
          schema: 'paos.gateway-cleanup-complete.v1',
          run_id: binding.firewallRunId,
          activation_attempt_id: binding.activationAttemptId,
          session_id: binding.sessionId,
          room_name: binding.roomName,
          device_id: binding.deviceId,
          participant_identity: binding.participantIdentity,
          provider: 'livekit-rtc-node',
          issuance_denied: true,
          contact_observed: supervisedProofs.contactObserved,
          publication_sid: supervisedProofs.publicationSid,
          participant_absence_evidence_sha256: supervisedProofs.participantSha256,
          publication_absence_evidence_sha256: supervisedProofs.publicationSha256,
          gateway_disconnected: true,
          room_absent: true,
          completed_at_utc: iso(this.#now()),
        });
      }
      return receipt;
    } catch (error) {
      runtime.stopping = false;
      this.#scheduleBoundedCleanupRetry(runtime);
      this.#reportRetryState(runtime);
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.stopSession(id, 'error')));
  }

  #missingSessionError(sessionId: string): string {
    const terminalFailure = this.#activeTerminalFailure(sessionId);
    if (terminalFailure) return `CLEANUP_TERMINAL_FAILURE:${terminalFailure.code}`;
    return this.#activeTombstone(sessionId) ? 'SESSION_CLEANED' : 'SESSION_NOT_FOUND';
  }

  #allocateSessionId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const sessionId = scoped('phase0_session');
      if (!this.#config.deviceLan || !this.#deviceLanRoomNames.has(sessionId)) {
        if (this.#config.deviceLan) this.#deviceLanRoomNames.add(sessionId);
        return sessionId;
      }
    }
    throw new Error('DEVICE_LAN_ROOM_NAME_ALLOCATION_FAILED');
  }

  #beginDeviceLanIssuance(): DeviceLanIssuanceGate | undefined {
    const issuance = this.#deviceLanIssuance;
    if (!issuance) return undefined;
    if (issuance.state !== 'ARMED') throw new Error('DEVICE_LAN_REQUEST_DENIED');
    issuance.state = 'ISSUING';
    return issuance;
  }

  #assertDeviceLanIssuanceContinuing(
    issuance: DeviceLanIssuanceGate | undefined,
    runtime: SessionRuntime,
  ): void {
    if (issuance !== undefined && this.#now() >= runtime.expiresAt) {
      this.#enterDeviceLanRevoking(runtime.id, 'deadline_expired');
      this.#directLoop?.stopSession(runtime.id);
      throw new Error('LIVEKIT_TOKEN_DEADLINE_BINDING_FAILED');
    }
    if (
      issuance !== undefined &&
      (issuance.state !== 'ISSUING' ||
        runtime.stopping ||
        runtime.ended ||
        !this.#sessions.has(runtime.id))
    ) {
      throw new Error('DEVICE_LAN_REQUEST_DENIED');
    }
  }

  #enterDeviceLanRevoking(
    sessionId: string,
    reason: DeviceLanRevocationReason,
  ): boolean {
    const issuance = this.#deviceLanIssuance;
    if (!issuance) return true;
    if (
      issuance.binding?.roomName !== sessionId ||
      issuance.state === 'FAILED_CLOSED' ||
      (issuance.state === 'ARMED' && this.#config.deviceLan?.supervised === undefined)
    ) {
      return false;
    }
    if (issuance.state === 'REVOKED') return this.#sessions.has(sessionId);
    if (issuance.state !== 'REVOKING') issuance.state = 'REVOKING';
    issuance.revocationReason ??= reason;
    const runtime = this.#sessions.get(sessionId);
    if (runtime) runtime.deviceLanRevocationReason ??= reason;
    return true;
  }

  #completeDeviceLanRevocation(sessionId: string): void {
    const issuance = this.#deviceLanIssuance;
    if (
      issuance?.binding?.roomName === sessionId &&
      issuance.state === 'REVOKING'
    ) {
      issuance.state = 'REVOKED';
      issuance.roomAbsenceVerifiedAt = this.#now();
    }
  }

  #markDeviceLanActive(sessionId: string): void {
    const issuance = this.#deviceLanIssuance;
    const runtime = this.#sessions.get(sessionId);
    if (
      issuance?.binding?.roomName === sessionId &&
      issuance.state === 'ISSUED' &&
      runtime !== undefined &&
      this.#now() < runtime.expiresAt
    ) {
      issuance.state = 'ACTIVE';
    }
  }

  #runtimeMayAct(runtime: SessionRuntime): boolean {
    if (
      this.#sessions.get(runtime.id) !== runtime ||
      runtime.stopping ||
      runtime.ended ||
      this.#now() >= runtime.expiresAt
    ) {
      return false;
    }
    const issuance = this.#deviceLanIssuance;
    return (
      issuance === undefined ||
      (issuance.binding?.roomName === runtime.id &&
        (issuance.state === 'ISSUED' || issuance.state === 'ACTIVE'))
    );
  }

  #triggerDeadlineOrSecurityStop(
    runtime: SessionRuntime,
    reason: DeviceLanRevocationReason,
  ): void {
    if (this.#config.deviceLan) {
      if (!this.#enterDeviceLanRevoking(runtime.id, reason)) return;
      this.#directLoop?.stopSession(runtime.id);
      void this.stopSession(runtime.id, reason === 'deadline_expired' ? 'timeout' : 'error', reason)
        .catch(() => undefined);
      return;
    }
    this.#directLoop?.stopSession(runtime.id);
    void this.stopSession(runtime.id, 'timeout').catch(() => undefined);
  }

  async #deleteAndVerifyRoom(sessionId: string): Promise<void> {
    await deleteAndVerifyRoom(this.#roomService, sessionId);
  }

  async #compensateFailedIssuance(
    runtime: SessionRuntime,
    roomCreated: boolean,
  ): Promise<void> {
    if (runtime.joinTimer) {
      clearTimeout(runtime.joinTimer);
      delete runtime.joinTimer;
    }
    if (runtime.expiryTimer) {
      this.#cancelSessionExpiry(runtime.expiryTimer);
      delete runtime.expiryTimer;
    }
    if (runtime.room) {
      await runtime.room.disconnect();
      delete runtime.room;
    }
    if (roomCreated || this.#config.deviceLan) {
      await this.#deleteAndVerifyRoom(runtime.id);
    }
    this.#clearAndVerifyTemporaryState(runtime);
    this.#directLoop?.clearAfterVerifiedCleanup(runtime.id);
    this.#sessions.delete(runtime.id);
    if (this.#sessions.has(runtime.id)) {
      throw new Error('SESSION_ROW_DELETE_NOT_VERIFIED');
    }
  }

  async #deleteAndVerifyExternalResources(runtime: SessionRuntime): Promise<number> {
    if (this.#config.deviceLan) {
      await this.#deleteAndVerifyRoom(runtime.id);
      this.#completeDeviceLanRevocation(runtime.id);
    }
    for (const [resourceKey, binding] of [...runtime.ephemeralObjects]) {
      const owner = this.#ephemeralObjectOwner;
      if (!owner) throw new Error('EPHEMERAL_RESOURCE_OWNER_REQUIRED');
      if (!(await owner.objectIsAbsent(binding.handle))) await owner.deleteObject(binding.handle);
      if (!(await owner.objectIsAbsent(binding.handle)))
        throw new Error('EPHEMERAL_DELETE_NOT_VERIFIED');
      runtime.ephemeralObjects.delete(resourceKey);
      const globalBinding = this.#ephemeralResourceBindings.get(resourceKey);
      if (
        globalBinding?.sessionId === runtime.id &&
        globalBinding.mediaRefDigest === binding.mediaRefDigest
      )
        this.#ephemeralResourceBindings.delete(resourceKey);
      runtime.verifiedMediaRemovalCount += 1;
    }
    if (!this.#config.deviceLan) await this.#deleteAndVerifyRoom(runtime.id);
    runtime.verifiedMediaRemovalCount += runtime.liveKitMediaResourceKeys.size;
    runtime.liveKitMediaResourceKeys.clear();
    return runtime.verifiedMediaRemovalCount;
  }

  #clearAndVerifyTemporaryState(runtime: SessionRuntime): void {
    runtime.modelCache.clear();
    runtime.gatewayOutboundOwnership.clear();
    runtime.ephemeralObjects.clear();
    runtime.pendingLiveKitMediaKeys.clear();
    runtime.observedLiveKitPublicationKeys.clear();
    runtime.contractPublicationObservationKeys.clear();
    runtime.liveKitMediaResourceKeys.clear();
    runtime.directTrackTokens.clear();
    runtime.primitiveState.clear();
    runtime.consumer.clearTemporaryState();
    if (
      !runtime.modelCache.isEmpty() ||
      !runtime.gatewayOutboundOwnership.isEmpty() ||
      runtime.ephemeralObjects.size !== 0 ||
      runtime.pendingLiveKitMediaKeys.size !== 0 ||
      runtime.observedLiveKitPublicationKeys.size !== 0 ||
      runtime.contractPublicationObservationKeys.size !== 0 ||
      runtime.liveKitMediaResourceKeys.size !== 0 ||
      runtime.directTrackTokens.size !== 0 ||
      !runtime.primitiveState.isEmpty() ||
      runtime.consumer.acceptedEvents().length !== 0
    ) {
      throw new Error('TEMPORARY_STATE_DELETE_NOT_VERIFIED');
    }
    this.#reportRetryState(runtime);
  }

  #reportRetryState(runtime: SessionRuntime): void {
    this.#retryStateProbe?.(
      Object.freeze(
        [...runtime.ephemeralObjects].map(([resourceKey, binding]) =>
          Object.freeze({
            resourceKey,
            mediaRefDigest: binding.mediaRefDigest,
          }),
        ),
      ),
    );
  }

  #scrubLatePersonalState(runtime: SessionRuntime): void {
    runtime.modelCache.clear();
    runtime.gatewayOutboundOwnership.clear();
    runtime.pendingLiveKitMediaKeys.clear();
    runtime.observedLiveKitPublicationKeys.clear();
    runtime.contractPublicationObservationKeys.clear();
    runtime.liveKitMediaResourceKeys.clear();
    runtime.directTrackTokens.clear();
    runtime.primitiveState.clear();
    runtime.consumer.clearTemporaryState();
    if (
      !runtime.modelCache.isEmpty() ||
      !runtime.gatewayOutboundOwnership.isEmpty() ||
      runtime.pendingLiveKitMediaKeys.size !== 0 ||
      runtime.observedLiveKitPublicationKeys.size !== 0 ||
      runtime.contractPublicationObservationKeys.size !== 0 ||
      runtime.liveKitMediaResourceKeys.size !== 0 ||
      runtime.directTrackTokens.size !== 0 ||
      !runtime.primitiveState.isEmpty() ||
      runtime.consumer.acceptedEvents().length !== 0
    ) {
      throw new Error('LATE_TEMPORARY_STATE_DELETE_NOT_VERIFIED');
    }
  }

  #finishTerminalCleanup(runtime: SessionRuntime): never {
    const subscribers = new Set(runtime.subscribers);
    this.#clearAndVerifyTemporaryState(runtime);
    this.#directLoop?.clearAfterVerifiedCleanup(runtime.id);
    this.#sessions.delete(runtime.id);
    if (this.#sessions.has(runtime.id)) throw new Error('SESSION_ROW_DELETE_NOT_VERIFIED');
    runtime.subscribers.clear();
    const terminalAt = this.#now();
    this.#terminalFailures.set(runtime.id, {
      code: 'CLEANUP_SLA_MISSED',
      terminalAt,
      expiresAt: terminalAt + 3_600_000,
    });
    this.#deliverSubscribers(runtime, subscribers, {
      kind: 'rejected',
      sessionId: runtime.id,
      occurredAt: iso(this.#now()),
      errors: ['CLEANUP_SLA_MISSED'],
    });
    throw new Error('CLEANUP_TERMINAL_FAILURE:CLEANUP_SLA_MISSED');
  }

  #cleanupSlaMissed(runtime: SessionRuntime, at = this.#now()): boolean {
    if (runtime.cleanupDeadlineAt !== undefined) return at >= runtime.cleanupDeadlineAt;
    return at >= runtime.expiresAt + 300_000;
  }

  #activeTombstone(sessionId: string): Tombstone | undefined {
    const tombstone = this.#tombstones.get(sessionId);
    if (!tombstone) return undefined;
    if (this.#now() < tombstone.expiresAt) return tombstone;
    this.#tombstones.delete(sessionId);
    return undefined;
  }

  #activeTerminalFailure(sessionId: string): TerminalFailure | undefined {
    const failure = this.#terminalFailures.get(sessionId);
    if (!failure) return undefined;
    if (this.#now() < failure.expiresAt) return failure;
    this.#terminalFailures.delete(sessionId);
    return undefined;
  }

  #scheduleBoundedCleanupRetry(runtime: SessionRuntime): void {
    if (runtime.cleanupRetryTimer || !runtime.cleanupReason || !this.#sessions.has(runtime.id))
      return;
    const late = this.#cleanupSlaMissed(runtime);
    const remainingMs = (runtime.cleanupDeadlineAt ?? runtime.expiresAt + 300_000) - this.#now();
    const delayMs = late ? 1_000 : Math.min(1_000, remainingMs);
    runtime.cleanupRetryTimer = this.#scheduleCleanupRetry(async () => {
      delete runtime.cleanupRetryTimer;
      try {
        return await this.stopSession(runtime.id, runtime.cleanupReason);
      } catch (error) {
        this.#broadcast(runtime, {
          kind: 'rejected',
          sessionId: runtime.id,
          occurredAt: iso(),
          errors: [error instanceof Error ? error.message : 'CLEANUP_RETRY_FAILED'],
        });
        return undefined;
      }
    }, delayMs);
    runtime.cleanupRetryTimer.unref?.();
  }

  #gatewayEvent(
    runtime: SessionRuntime,
    suffix: string,
    occurredAt: number,
    payload: JsonObject,
    expiresAt = Math.min(runtime.expiresAt + 300_000, occurredAt + 86_400_000),
  ): EventEnvelope {
    const nextSequence = runtime.gatewaySequence + 1;
    const eventId = randomUUID();
    const sequence: JsonObject = {
      stream_id: 'gateway_control',
      number: nextSequence,
    };
    if (runtime.gatewayPreviousEventId) sequence.previous_event_id = runtime.gatewayPreviousEventId;
    const gatewayBinding = gatewayPublisherIdentityBinding();
    return {
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_type: `paios.phase0.demo.${suffix}`,
      event_id: eventId,
      session_id: runtime.id,
      trace_id: runtime.traceId,
      occurred_at: iso(occurredAt),
      expires_at: iso(expiresAt),
      origin: gatewayBinding.origin,
      connection: {
        id: runtime.gatewayConnectionId,
        epoch: 0,
        state: 'connected',
      },
      sequence,
      idempotency_key: `${suffix.replaceAll('.', '-')}-${eventId}`,
      payload,
    };
  }

  #userEvent(
    runtime: SessionRuntime,
    suffix: string,
    occurredAt: number,
    payload: JsonObject,
    streamId = 'web_text_input',
  ): EventEnvelope {
    const nextSequence = runtime.userSequence + 1;
    const eventId = randomUUID();
    const sequence: JsonObject = {
      stream_id: streamId,
      number: nextSequence,
    };
    if (runtime.userPreviousEventId) sequence.previous_event_id = runtime.userPreviousEventId;
    return {
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_type: `paios.phase0.demo.${suffix}`,
      event_id: eventId,
      session_id: runtime.id,
      trace_id: runtime.traceId,
      occurred_at: iso(occurredAt),
      expires_at: iso(Math.min(runtime.expiresAt + 300_000, occurredAt + 86_400_000)),
      origin: {
        device_id: runtime.userDeviceId,
        device_class: 'web_mobile',
        client_instance_id: runtime.userClientInstanceId,
      },
      connection: {
        id: runtime.userConnectionId,
        epoch: 0,
        state: 'connected',
      },
      sequence,
      idempotency_key: `${suffix.replaceAll('.', '-')}-${eventId}`,
      payload,
    };
  }

  #assertDirectUserParticipant(runtime: SessionRuntime, participant: Participant): void {
    if (
      participant.identity !== runtime.userIdentity ||
      participant.attributes.device_id !== runtime.userDeviceId ||
      participant.attributes.device_class !== 'web_mobile' ||
      participant.attributes.client_instance_id !== runtime.userClientInstanceId ||
      participant.attributes.schema_version !== CONTRACT_SCHEMA_VERSION
    ) {
      throw new Error('OFFICIAL_CHAT_PUBLISHER_MISMATCH');
    }
  }

  #acceptGenerated(
    runtime: SessionRuntime,
    event: EventEnvelope,
    rtcPublisherIdentity = GATEWAY_DEVICE_ID,
    publishRtcEnvelope = true,
  ): void {
    const preview = runtime.consumer.validateBatch([event]);
    if (!preview.accepted || preview.retry) {
      throw new Error(`GENERATED_EVENT_REJECTED:${preview.errors.join(',')}`);
    }
    const admission = this.#prepareTemporaryResourceAdmission(
      runtime,
      [event],
      rtcPublisherIdentity,
    );
    if (!admission.accepted) throw new Error(admission.error);
    const result = runtime.consumer.consume(event);
    if (!result.accepted || result.retry) {
      throw new Error(`GENERATED_EVENT_REJECTED:${result.errors.join(',')}`);
    }
    this.#commitGeneratedSequence(runtime, event);
    this.#commitTemporaryOwnership(runtime, admission);
    if (publishRtcEnvelope) this.#recordLocallyOwnedGatewayEnvelope(runtime, event);
    this.#observeProjection(event);
    this.#broadcast(runtime, this.#timelineAccepted(event, false));
    if (publishRtcEnvelope) this.#publishGeneratedGatewayEnvelope(runtime, event);
  }

  #acceptGeneratedBatch(runtime: SessionRuntime, events: readonly EventEnvelope[]): void {
    const preview = runtime.consumer.validateBatch(events);
    if (!preview.accepted || preview.retry) {
      throw new Error(`GENERATED_EVENT_REJECTED:${preview.errors.join(',')}`);
    }
    const admission = this.#prepareTemporaryResourceAdmission(runtime, events, GATEWAY_DEVICE_ID);
    if (!admission.accepted) throw new Error(admission.error);
    const result = runtime.consumer.consumeBatch(events);
    if (!result.accepted || result.retry) {
      throw new Error(`GENERATED_EVENT_REJECTED:${result.errors.join(',')}`);
    }
    for (const event of events) this.#commitGeneratedSequence(runtime, event);
    this.#commitTemporaryOwnership(runtime, admission);
    for (const event of events) this.#recordLocallyOwnedGatewayEnvelope(runtime, event);
    for (const event of events) {
      this.#observeProjection(event);
      this.#broadcast(runtime, this.#timelineAccepted(event, false));
      this.#publishGeneratedGatewayEnvelope(runtime, event);
    }
  }

  #prepareDirectMicrophoneSource(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
  ): void {
    const publicationSid = publication.sid;
    if (typeof publicationSid !== 'string') throw new Error('PUBLICATION_SID_REQUIRED');
    const observedAt = this.#now();
    this.#acceptGenerated(
      runtime,
      this.#userEvent(
        runtime,
        'capture.status',
        observedAt,
        {
          device_id: runtime.userDeviceId,
          capture_kind: 'audio',
          status: 'started',
          explicit_user_action: true,
          indicator_visible: true,
          observed_at: iso(observedAt),
        },
        'web_audio_input',
      ),
      participant.identity,
      false,
    );
    const tupleKey = `${runtime.id}\u0000${participant.identity}\u0000${publicationSid}`;
    if (!runtime.contractPublicationObservationKeys.has(tupleKey)) {
      runtime.consumer.recordPublicationObservation({
        session_id: runtime.id,
        room_name: runtime.id,
        rtc_publisher_identity: participant.identity,
        publication_sid: publicationSid,
      });
      runtime.contractPublicationObservationKeys.add(tupleKey);
    }
    this.#observeLiveKitPublication(runtime, participant, publication, false);
    this.#acceptGenerated(
      runtime,
      this.#userEvent(
        runtime,
        'media.referenced',
        this.#now(),
        {
          media_ref: {
            media_id: publicationSid,
            transport: 'livekit_track',
            locator: `livekit://${runtime.id}/${participant.identity}/${publicationSid}`,
            kind: 'audio',
            mime_type: 'audio/opus',
            capture_mode: 'microphone',
            expires_at: iso(Math.min(runtime.expiresAt, observedAt + 3_600_000)),
          },
          explicit_capture: true,
        },
        'web_audio_input',
      ),
      participant.identity,
      false,
    );
  }

  #acceptDirectTranscriptAndRequest(
    runtime: SessionRuntime,
    publicationSid: string,
    text: string,
    observedAt: number,
  ): { readonly requestEventId: string } {
    if (text.length === 0 || text.length > 8_192) {
      throw new Error('DIRECT_TRANSCRIPT_TEXT_INVALID');
    }
    const transcript = this.#userEvent(
      runtime,
      'transcript.final',
      observedAt,
      {
        text,
        language: 'und',
        is_final: true,
        source_media_id: publicationSid,
      },
      'web_audio_input',
    );
    const transcriptResult = runtime.consumer.consumeMicrophoneTranscript(transcript);
    if (!transcriptResult.accepted || transcriptResult.retry) {
      throw new Error(`GENERATED_EVENT_REJECTED:${transcriptResult.errors.join(',')}`);
    }
    this.#commitGeneratedSequence(runtime, transcript);
    this.#broadcast(runtime, this.#timelineAccepted(transcript, false));
    const request = this.#gatewayEvent(runtime, 'model.requested', this.#now(), {
      input_event_ids: [transcript.event_id],
      requested_outputs: ['text'],
    });
    this.#acceptGenerated(runtime, request, GATEWAY_DEVICE_ID, false);
    return { requestEventId: request.event_id };
  }

  #acceptDirectModelResult(
    runtime: SessionRuntime,
    input: {
      readonly requestEventId: string;
      readonly text: string;
      readonly model: string;
      readonly latencyMs: number;
      readonly observedAt: number;
    },
  ): { readonly resultEventId: string } {
    const result = this.#gatewayEvent(runtime, 'model.result', input.observedAt, {
      request_event_id: input.requestEventId,
      result_id: scoped('model_result'),
      status: 'success',
      provider: 'local',
      model: input.model,
      latency_ms: input.latencyMs,
      non_authoritative: true,
      outputs: [{ modality: 'text', text: input.text, language: 'und' }],
    });
    this.#acceptGenerated(runtime, result, GATEWAY_DEVICE_ID, false);
    return { resultEventId: result.event_id };
  }

  #directTupleIsCurrent(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
    track: RemoteTrack,
  ): boolean {
    const room = runtime.room;
    const sid = publication.sid;
    if (
      !room ||
      !this.#runtimeMayAct(runtime) ||
      typeof sid !== 'string' ||
      room.remoteParticipants.get(participant.identity) !== participant ||
      participant.identity !== runtime.userIdentity ||
      publication.kind !== TrackKind.KIND_AUDIO ||
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      publication.subscribed !== true ||
      publication.track !== track
    ) {
      return false;
    }
    try {
      this.#assertDirectUserParticipant(runtime, participant);
    } catch {
      return false;
    }
    const tupleKey = `${participant.identity}\u0000${sid}`;
    return runtime.directTrackTokens.get(tupleKey) === track;
  }

  #startDirectMicrophone(
    runtime: SessionRuntime,
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    reportError: (error: unknown) => void,
  ): void {
    const directLoop = this.#directLoop;
    const sid = publication.sid;
    if (
      !directLoop ||
      typeof sid !== 'string' ||
      !this.#directTupleIsCurrentCandidate(runtime, participant, publication, track)
    ) {
      return;
    }
    let trackAttempt = runtime.directTrackAttempts.get(track);
    if (trackAttempt === undefined) {
      trackAttempt = ++runtime.nextTrackAttempt;
      runtime.directTrackAttempts.set(track, trackAttempt);
    }
    const tupleKey = `${participant.identity}\u0000${sid}`;
    runtime.directTrackTokens.set(tupleKey, track);
    const observe = (
      stage: DirectLoopObservationStage,
      errorCode?: string,
    ): void => {
      try {
        this.#observeDirectLoop(Object.freeze({
          stage,
          session_id: runtime.id,
          publication_sid: sid,
          track_attempt: trackAttempt,
          ...(errorCode === undefined ? {} : { error_code: errorCode }),
        }));
      } catch {
        // Observability must never alter the direct-loop outcome.
      }
    };
    void directLoop
      .execute({
        key: {
          contract_profile: CONTRACT_SCHEMA_VERSION,
          session_id: runtime.id,
          publisher_identity: participant.identity,
          publication_sid: sid,
          track_attempt: trackAttempt,
        },
        token: track,
        originatingParticipantIdentity: participant.identity,
        createStream: () => this.#audioStreamFactory(track),
        isValid: (token) =>
          token === track && this.#directTupleIsCurrent(runtime, participant, publication, track),
        prepareSource: () => {
          if (!this.#directTupleIsCurrent(runtime, participant, publication, track)) {
            throw new Error('DIRECT_LOOP_ATTEMPT_INVALIDATED');
          }
          this.#prepareDirectMicrophoneSource(runtime, participant, publication);
          observe('STT_CAPTURE');
        },
        acceptTranscriptAndModelRequested: (transcript, observedAt) => {
          if (!this.#directTupleIsCurrent(runtime, participant, publication, track)) {
            throw new Error('DIRECT_LOOP_ATTEMPT_INVALIDATED');
          }
          observe('STT_RESULT');
          const accepted = this.#acceptDirectTranscriptAndRequest(
            runtime,
            sid,
            transcript.text,
            observedAt,
          );
          observe('MODEL_REQUEST');
          return accepted;
        },
        acceptModelResult: (input) => {
          if (!this.#directTupleIsCurrent(runtime, participant, publication, track)) {
            throw new Error('DIRECT_LOOP_ATTEMPT_INVALIDATED');
          }
          const accepted = this.#acceptDirectModelResult(runtime, input);
          observe('MODEL_RESULT');
          return accepted;
        },
        sendDirectedChat: async (text, destinationIdentity) => {
          if (
            destinationIdentity !== participant.identity ||
            !this.#directTupleIsCurrent(runtime, participant, publication, track)
          ) {
            throw new Error('DIRECT_LOOP_ATTEMPT_INVALIDATED');
          }
          const room = runtime.room;
          const localParticipant = room?.localParticipant;
          if (!localParticipant) throw new Error('DIRECT_LOOP_ROOM_UNAVAILABLE');
          await localParticipant.sendChatMessage(text, [destinationIdentity]);
          observe('DIRECTED_CHAT_SUCCESS');
        },
      })
      .catch((error: unknown) => {
        observe('TERMINAL_ERROR', directLoopErrorCode(error));
        reportError(error);
      });
  }

  #directTupleIsCurrentCandidate(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
    track: RemoteTrack,
  ): boolean {
    const room = runtime.room;
    if (
      !room ||
      !this.#runtimeMayAct(runtime) ||
      room.remoteParticipants.get(participant.identity) !== participant ||
      participant.identity !== runtime.userIdentity ||
      publication.kind !== TrackKind.KIND_AUDIO ||
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      publication.subscribed !== true ||
      publication.track !== track
    ) {
      return false;
    }
    try {
      this.#assertDirectUserParticipant(runtime, participant);
      return true;
    } catch {
      return false;
    }
  }

  #invalidateDirectTrack(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
    track?: RemoteTrack,
  ): void {
    const sid = publication.sid;
    if (typeof sid !== 'string') return;
    const token = track ?? runtime.directTrackTokens.get(`${participant.identity}\u0000${sid}`);
    if (token) this.#directLoop?.invalidate(runtime.id, token);
  }

  #prepareTemporaryResourceAdmission(
    runtime: SessionRuntime,
    events: readonly EventEnvelope[],
    rtcPublisherIdentity?: string,
  ): TemporaryResourceAdmission {
    const modelCache = runtime.modelCache.clone();
    try {
      for (const event of events) {
        if (event.event_type === 'paios.phase0.demo.model.requested') {
          modelCache.recordRequest(event.event_id);
        } else if (event.event_type === 'paios.phase0.demo.model.result') {
          const requestEventId = event.payload.request_event_id;
          if (typeof requestEventId !== 'string') {
            return { accepted: false, error: 'MODEL_CACHE_REQUEST_NOT_FOUND' };
          }
          modelCache.recordResult(requestEventId, event.event_id);
        }
      }
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : 'MODEL_CACHE_CORRELATION_INVALID',
      };
    }
    const ephemeralObjects = new Map<string, EphemeralResourceBinding>();
    const pendingLiveKitMediaKeys = new Set<string>();
    const liveKitResourceKeys = new Set<string>();
    for (const event of events) {
      for (const media of collectTemporaryMedia(event.payload)) {
        if (media.transport === 'livekit_track') {
          const mediaId = media.mediaRef.media_id;
          if (typeof rtcPublisherIdentity !== 'string' || rtcPublisherIdentity.length === 0) {
            return {
              accepted: false,
              error: 'LIVEKIT_MEDIA_PUBLISHER_CONTEXT_REQUIRED',
            };
          }
          if (
            typeof mediaId !== 'string' ||
            media.locator !== `livekit://${runtime.id}/${rtcPublisherIdentity}/${mediaId}`
          ) {
            return {
              accepted: false,
              error: 'LIVEKIT_MEDIA_ROOM_BINDING_MISMATCH',
            };
          }
          const tupleKey = `${runtime.id}\u0000${rtcPublisherIdentity}\u0000${mediaId}`;
          pendingLiveKitMediaKeys.add(tupleKey);
          if (runtime.observedLiveKitPublicationKeys.has(tupleKey)) {
            liveKitResourceKeys.add(tupleKey);
          }
          continue;
        }
        const owner = this.#ephemeralObjectOwner;
        if (!owner)
          return {
            accepted: false,
            error: 'EPHEMERAL_RESOURCE_OWNER_REQUIRED',
          };
        try {
          const immutableMediaRef = Object.freeze(structuredClone(media.mediaRef));
          const binding = owner.bind(runtime.id, immutableMediaRef);
          if (!binding || !/^[A-Za-z0-9._:-]{8,160}$/.test(binding.resourceKey)) {
            return { accepted: false, error: 'EPHEMERAL_RESOURCE_NOT_OWNED' };
          }
          const mediaRefDigest = createHash('sha256')
            .update(stableJson(immutableMediaRef), 'utf8')
            .digest('hex');
          const globalBinding = this.#ephemeralResourceBindings.get(binding.resourceKey);
          if (globalBinding && globalBinding.sessionId !== runtime.id) {
            return {
              accepted: false,
              error: 'EPHEMERAL_RESOURCE_CROSS_SESSION',
            };
          }
          if (globalBinding && globalBinding.mediaRefDigest !== mediaRefDigest) {
            return {
              accepted: false,
              error: 'EPHEMERAL_RESOURCE_BINDING_DRIFT',
            };
          }
          const admittedBinding = ephemeralObjects.get(binding.resourceKey);
          if (admittedBinding && admittedBinding.mediaRefDigest !== mediaRefDigest) {
            return {
              accepted: false,
              error: 'EPHEMERAL_RESOURCE_BINDING_DRIFT',
            };
          }
          if (!admittedBinding) {
            ephemeralObjects.set(
              binding.resourceKey,
              runtime.ephemeralObjects.get(binding.resourceKey) ?? {
                handle: binding.handle,
                mediaRefDigest,
              },
            );
          }
        } catch {
          return { accepted: false, error: 'EPHEMERAL_RESOURCE_NOT_OWNED' };
        }
      }
    }
    return {
      accepted: true,
      ephemeralObjects,
      pendingLiveKitMediaKeys,
      liveKitResourceKeys,
      modelCache,
    };
  }

  #commitTemporaryOwnership(
    runtime: SessionRuntime,
    admission: Extract<TemporaryResourceAdmission, { accepted: true }>,
  ): void {
    for (const [resourceKey, binding] of admission.ephemeralObjects) {
      if (!runtime.ephemeralObjects.has(resourceKey)) {
        runtime.ephemeralObjects.set(resourceKey, binding);
      }
      this.#ephemeralResourceBindings.set(resourceKey, {
        sessionId: runtime.id,
        mediaRefDigest: binding.mediaRefDigest,
      });
    }
    for (const key of admission.pendingLiveKitMediaKeys) runtime.pendingLiveKitMediaKeys.add(key);
    for (const key of admission.liveKitResourceKeys) runtime.liveKitMediaResourceKeys.add(key);
    runtime.modelCache.replaceWith(admission.modelCache);
  }

  #commitGeneratedSequence(runtime: SessionRuntime, event: EventEnvelope): void {
    if (event.origin.device_id === GATEWAY_DEVICE_ID) {
      runtime.gatewaySequence = event.sequence.number;
      runtime.gatewayPreviousEventId = event.event_id;
      return;
    }
    if (event.origin.device_id === runtime.userDeviceId) {
      runtime.userSequence = event.sequence.number;
      runtime.userPreviousEventId = event.event_id;
      return;
    }
    throw new Error('GENERATED_EVENT_ORIGIN_INVALID');
  }

  #recordLocallyOwnedGatewayEnvelope(runtime: SessionRuntime, event: EventEnvelope): void {
    if (isGatewayOwnedOutboundEnvelope(event)) runtime.gatewayOutboundOwnership.record(event);
  }

  #publishGeneratedGatewayEnvelope(runtime: SessionRuntime, event: EventEnvelope): void {
    if (!runtime.gatewayOutboundOwnership.owns(event)) return;
    void this.#publishLocallyOwnedGatewayEnvelope(runtime, event).catch((error: unknown) => {
      this.#broadcast(runtime, {
        kind: 'rejected',
        sessionId: runtime.id,
        occurredAt: iso(this.#now()),
        errors: [error instanceof Error ? error.message : 'GATEWAY_EVENT_PUBLISH_FAILED'],
      });
    });
  }

  async #publishLocallyOwnedGatewayEnvelope(
    runtime: SessionRuntime,
    event: EventEnvelope,
  ): Promise<void> {
    if (!runtime.gatewayOutboundOwnership.owns(event)) {
      throw new Error('FOREIGN_OR_UNOWNED_GATEWAY_OUTBOUND_REJECTED');
    }
    const participant = runtime.room?.localParticipant;
    if (!participant) return;
    if (this.#config.deviceLan && !this.#runtimeMayAct(runtime)) return;
    const binding = rtcEventTransportBinding(event.event_type);
    assertRtcPublisherBinding(
      runtime,
      event,
      participant as unknown as RemoteParticipant,
      binding.kind,
      binding.topic,
    );
    await participant.publishData(new TextEncoder().encode(JSON.stringify(event)), {
      reliable: binding.reliable,
      topic: binding.topic,
    });
  }

  async #publishLocallyOwnedReplay(runtime: SessionRuntime): Promise<void> {
    for (const event of runtime.consumer.acceptedEvents()) {
      if (!runtime.gatewayOutboundOwnership.owns(event)) continue;
      await this.#publishLocallyOwnedGatewayEnvelope(runtime, event);
    }
  }

  #timelineAccepted(event: EventEnvelope, retry: boolean, verifiedCleanup = false): TimelineItem {
    const text = displayText(event);
    const references =
      event.event_type === 'paios.phase0.demo.model.requested'
        ? (event.payload.input_event_ids as string[])
        : event.event_type === 'paios.phase0.demo.model.result'
          ? [event.payload.request_event_id as string]
          : undefined;
    return {
      kind: 'accepted',
      sessionId: event.session_id,
      eventId: event.event_id,
      eventType: event.event_type,
      occurredAt: event.occurred_at,
      originDeviceId: event.origin.device_id,
      retry,
      ...(verifiedCleanup ? { verifiedCleanup: true } : {}),
      ...(text === undefined ? {} : { displayText: text }),
      ...(references === undefined ? {} : { references }),
    };
  }

  #observeProjection(event: EventEnvelope): void {
    if (!this.#observeAcceptedEventProjection) return;
    try {
      this.#observeAcceptedEventProjection(structuredClone(event));
    } catch {
      // A display-only observer cannot change accepted runtime semantics.
    }
  }

  #broadcast(runtime: SessionRuntime, item: TimelineItem): void {
    this.#deliverSubscribers(runtime, runtime.subscribers, item);
  }

  #broadcastRejection(runtime: SessionRuntime, errors: readonly string[]): void {
    this.#broadcast(runtime, {
      kind: 'rejected',
      sessionId: runtime.id,
      occurredAt: iso(this.#now()),
      errors,
    });
  }

  #deliverSubscribers(
    runtime: SessionRuntime,
    subscribers: Set<(item: TimelineItem) => void>,
    item: TimelineItem,
  ): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(item);
      } catch {
        subscribers.delete(subscriber);
        runtime.subscribers.delete(subscriber);
      }
    }
  }

  #poisonSupervisedRuntime(runtime: SessionRuntime, code: string): void {
    if (this.#config.deviceLan?.supervised === undefined) return;
    runtime.observationPoison ??= code;
    runtime.contactState = 'POISONED';
    this.#directLoop?.stopSession(runtime.id);
    if (runtime.userSessionStarted && !runtime.stopping) {
      void this.stopSession(runtime.id, 'error', 'duplicate_identity').catch(() => undefined);
    }
  }

  #queueRtcObservation(runtime: SessionRuntime, action: () => void): void {
    if (this.#config.deviceLan?.supervised === undefined) {
      action();
      return;
    }
    runtime.observationQueue = runtime.observationQueue.then(() => {
      try {
        runtime.observationEpoch = incrementSupervisedObservationCounter(
          runtime.observationEpoch,
        );
        action();
      } catch {
        this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_RTC_EVENT_INVALID');
      }
    });
  }

  #recordSupervisedParticipant(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
  ): void {
    if (this.#config.deviceLan?.supervised === undefined) return;
    if (!runtime.userSessionStarted) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PRECONTACT_REMOTE_EVENT');
      return;
    }
    const sid = (participant as unknown as { readonly sid?: unknown }).sid;
    if (
      participant.identity !== runtime.userIdentity ||
      typeof sid !== 'string' ||
      !/^PA_[A-Za-z0-9_-]{3,64}$/.test(sid)
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PARTICIPANT_INVALID');
      return;
    }
    try {
      this.#assertDirectUserParticipant(runtime, participant);
      const remoteEntries = ordinaryMapEntries(
        runtime.room?.remoteParticipants,
        'SUPERVISED_PARTICIPANT_INVALID',
      );
      const publicationEntries = ordinaryMapEntries(
        participant.trackPublications,
        'SUPERVISED_PARTICIPANT_INVALID',
      );
      if (
        remoteEntries.length !== 1 ||
        remoteEntries[0]![0] !== participant.identity ||
        remoteEntries[0]![1] !== participant ||
        publicationEntries.length !== 0
      ) {
        throw new Error('SUPERVISED_PARTICIPANT_INVALID');
      }
    } catch {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PARTICIPANT_INVALID');
      return;
    }
    if (
      runtime.contactState !== 'NONE' ||
      runtime.contactConnectCount !== 0 ||
      runtime.contactParticipant !== undefined ||
      runtime.contactParticipantSid !== undefined
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PARTICIPANT_RECONNECT');
      return;
    }
    runtime.contactParticipant = participant;
    runtime.contactParticipantSid = sid;
    runtime.contactConnectCount = 1;
    runtime.contactState = 'CONNECTED';
  }

  #recordSupervisedPublication(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
  ): void {
    if (this.#config.deviceLan?.supervised === undefined) return;
    const sid = publication.sid;
    if (
      runtime.contactState !== 'CONNECTED' ||
      runtime.contactPublishCount !== 0 ||
      runtime.contactParticipant !== participant ||
      runtime.contactParticipantSid === undefined ||
      participant.identity !== runtime.userIdentity ||
      typeof sid !== 'string' ||
      !/^TR_[A-Za-z0-9_-]{3,64}$/.test(sid) ||
      publication.kind !== TrackKind.KIND_AUDIO ||
      publication.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PUBLICATION_INVALID');
      return;
    }
    try {
      const remoteEntries = ordinaryMapEntries(
        runtime.room?.remoteParticipants,
        'SUPERVISED_PUBLICATION_INVALID',
      );
      const publicationEntries = ordinaryMapEntries(
        participant.trackPublications,
        'SUPERVISED_PUBLICATION_INVALID',
      );
      if (
        remoteEntries.length !== 1 ||
        remoteEntries[0]![0] !== participant.identity ||
        remoteEntries[0]![1] !== participant ||
        publicationEntries.length !== 1 ||
        publicationEntries[0]![0] !== sid ||
        publicationEntries[0]![1] !== publication
      ) {
        throw new Error('SUPERVISED_PUBLICATION_INVALID');
      }
    } catch {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PUBLICATION_INVALID');
      return;
    }
    if (
      runtime.contactPublication !== undefined ||
      runtime.contactPublicationSid !== undefined
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PUBLICATION_REPLACED');
      return;
    }
    runtime.contactPublication = publication;
    runtime.contactPublicationSid = sid;
    runtime.contactPublicationActive = true;
    runtime.contactPublishCount = 1;
    runtime.contactState = 'PUBLISHED';
  }

  #recordSupervisedUnpublication(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
  ): void {
    if (this.#config.deviceLan?.supervised === undefined) return;
    if (
      runtime.contactState !== 'PUBLISHED' ||
      runtime.contactUnpublishCount !== 0 ||
      runtime.contactParticipant !== participant ||
      runtime.contactPublication !== publication ||
      runtime.contactPublicationSid !== publication.sid
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_UNPUBLICATION_AMBIGUOUS');
      return;
    }
    try {
      if (ordinaryMapEntries(
        participant.trackPublications,
        'SUPERVISED_UNPUBLICATION_AMBIGUOUS',
      ).length !== 0) {
        throw new Error('SUPERVISED_UNPUBLICATION_AMBIGUOUS');
      }
    } catch {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_UNPUBLICATION_AMBIGUOUS');
      return;
    }
    runtime.contactPublicationActive = false;
    runtime.contactUnpublishCount = 1;
    runtime.contactState = 'UNPUBLISHED';
  }

  #recordSupervisedDisconnect(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
  ): void {
    if (this.#config.deviceLan?.supervised === undefined) return;
    const sid = (participant as unknown as { readonly sid?: unknown }).sid;
    if (
      runtime.contactState !== 'UNPUBLISHED' ||
      runtime.contactDisconnectCount !== 0 ||
      runtime.contactParticipant !== participant ||
      runtime.contactParticipantSid !== sid ||
      runtime.contactPublicationActive
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_DISCONNECT_AMBIGUOUS');
      return;
    }
    try {
      if (ordinaryMapEntries(
        runtime.room?.remoteParticipants,
        'SUPERVISED_DISCONNECT_AMBIGUOUS',
      ).length !== 0) {
        throw new Error('SUPERVISED_DISCONNECT_AMBIGUOUS');
      }
    } catch {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_DISCONNECT_AMBIGUOUS');
      return;
    }
    runtime.contactDisconnectCount = 1;
    runtime.contactState = 'DISCONNECTED';
  }

  #terminalSupervisedContact(
    runtime: SessionRuntime,
  ): {
    readonly contactObserved: boolean;
    readonly participantSid: string | null;
    readonly publicationSid: string | null;
  } {
    const noContact =
      runtime.contactState === 'NONE' &&
      runtime.contactConnectCount === 0 &&
      runtime.contactPublishCount === 0 &&
      runtime.contactUnpublishCount === 0 &&
      runtime.contactDisconnectCount === 0 &&
      runtime.contactParticipant === undefined &&
      runtime.contactParticipantSid === undefined &&
      runtime.contactPublication === undefined &&
      runtime.contactPublicationSid === undefined &&
      runtime.contactPublicationActive === false;
    if (noContact) {
      return { contactObserved: false, participantSid: null, publicationSid: null };
    }
    const completeContact =
      runtime.contactState === 'DISCONNECTED' &&
      runtime.contactConnectCount === 1 &&
      runtime.contactPublishCount === 1 &&
      runtime.contactUnpublishCount === 1 &&
      runtime.contactDisconnectCount === 1 &&
      runtime.contactParticipant !== undefined &&
      runtime.contactPublication !== undefined &&
      runtime.contactPublicationActive === false &&
      typeof runtime.contactParticipantSid === 'string' &&
      /^PA_[A-Za-z0-9_-]{3,64}$/.test(runtime.contactParticipantSid) &&
      typeof runtime.contactPublicationSid === 'string' &&
      /^TR_[A-Za-z0-9_-]{3,64}$/.test(runtime.contactPublicationSid);
    if (!completeContact) throw new Error('SUPERVISED_CONTACT_LEDGER_INVALID');
    return {
      contactObserved: true,
      participantSid: runtime.contactParticipantSid!,
      publicationSid: runtime.contactPublicationSid!,
    };
  }

  #snapshotSupervisedRtcEmpty(
    runtime: SessionRuntime,
    observationEpoch: number,
    observationGeneration: number,
  ): SupervisedRtcLiveMapSnapshot {
    const room = runtime.room;
    if (
      !room ||
      nodeUtilTypes.isProxy(room) ||
      !runtime.rtcConnected ||
      room.isConnected !== true ||
      room.connectionState !== ConnectionState.CONN_CONNECTED
    ) {
      throw new Error('SUPERVISED_RTC_NOT_CONNECTED');
    }
    const local = room.localParticipant as unknown as {
      readonly identity?: unknown;
      readonly trackPublications?: unknown;
    };
    if (local.identity !== GATEWAY_DEVICE_ID) {
      throw new Error('SUPERVISED_RTC_LOCAL_IDENTITY_DRIFT');
    }
    const contact = this.#terminalSupervisedContact(runtime);
    return captureSupervisedRtcLiveMapSnapshot(
      this.#config.deviceLan!.supervised!,
      local.identity,
      local.trackPublications,
      room.remoteParticipants,
      contact.participantSid,
      contact.contactObserved,
      contact.publicationSid,
      observationEpoch,
      observationGeneration,
    );
  }

  async #captureSupervisedRoomService(
    runtime: SessionRuntime,
  ): Promise<SupervisedRoomServiceSnapshot> {
    let rooms: unknown;
    let participants: unknown;
    try {
      rooms = await this.#roomService.listRooms([runtime.id]);
      participants = await this.#roomService.listParticipants(runtime.id);
    } catch {
      throw new Error('SUPERVISED_ROOM_SERVICE_SNAPSHOT_FAILED');
    }
    return assertSupervisedRoomServiceSnapshot(rooms, participants, runtime.id);
  }

  async #waitForStableSupervisedFence(
    runtime: SessionRuntime,
    phase: 'prearm' | 'absence',
  ): Promise<{
    readonly snapshot: SupervisedRtcLiveMapSnapshot;
    readonly observationEpoch: number;
    readonly observationGeneration: number;
  }> {
    const attempts = Math.max(
      2,
      Math.ceil(this.#supervisedFenceTimeoutMs / SUPERVISED_FENCE_POLL_MS),
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (runtime.observationPoison !== undefined) {
        throw new Error('SUPERVISED_OBSERVATION_POISONED');
      }
      try {
        await runtime.observationQueue;
        const epoch = runtime.observationEpoch;
        const generation = runtime.observationGeneration;
        assertSupervisedObservationTuple(
          this.#terminalSupervisedContact(runtime).participantSid,
          epoch,
          generation,
        );
        const serviceA = await this.#captureSupervisedRoomService(runtime);
        const rtcS1 = this.#snapshotSupervisedRtcEmpty(runtime, epoch, generation);
        await runtime.observationQueue;
        const rtcS2 = this.#snapshotSupervisedRtcEmpty(runtime, epoch, generation);
        const serviceB = await this.#captureSupervisedRoomService(runtime);
        await runtime.observationQueue;
        if (
          runtime.observationPoison === undefined &&
          runtime.observationEpoch === epoch &&
          runtime.observationGeneration === generation &&
          stableJson(rtcS1) === stableJson(rtcS2) &&
          stableJson(serviceA) === stableJson(serviceB)
        ) {
          return {
            snapshot: rtcS2,
            observationEpoch: epoch,
            observationGeneration: generation,
          };
        }
      } catch (error) {
        if (
          error instanceof Error &&
          [
            'SUPERVISED_OBSERVATION_POISONED',
            'SUPERVISED_OBSERVATION_COUNTER_OVERFLOW',
            'SUPERVISED_RTC_NOT_CONNECTED',
            'SUPERVISED_RTC_LOCAL_IDENTITY_DRIFT',
            'SUPERVISED_RTC_LOCAL_PUBLICATION_PRESENT',
            'SUPERVISED_RTC_WITNESS_INVALID',
          ].includes(error.message)
        ) {
          throw error;
        }
      }
      if (attempt + 1 < attempts) await this.#sleep(SUPERVISED_FENCE_POLL_MS);
    }
    throw new Error(
      phase === 'prearm'
        ? 'SUPERVISED_PREARM_FENCE_TIMEOUT'
        : 'SUPERVISED_ABSENCE_FENCE_TIMEOUT',
    );
  }

  async #sealSupervisedAbsence(
    runtime: SessionRuntime,
  ): Promise<SupervisedAbsenceProofDocuments> {
    const prior = runtime.supervisedAbsence;
    if (prior?.disconnected) {
      if (!prior.committed) {
        await prior.committer.commit(prior.committedAtUtc);
        prior.committed = true;
      }
      return prior.documents;
    }
    const fence = await this.#waitForStableSupervisedFence(runtime, 'absence');
    const contact = this.#terminalSupervisedContact(runtime);
    const documents = createSupervisedAbsenceProofDocuments(
      this.#config.deviceLan!.supervised!,
      fence.snapshot,
      contact.participantSid,
      contact.contactObserved,
      contact.publicationSid,
    );
    if (
      documents.observationEpoch !== fence.observationEpoch ||
      documents.observationGeneration !== fence.observationGeneration
    ) {
      throw new Error('SUPERVISED_RTC_WITNESS_INVALID');
    }
    const committer = await this.#stageSupervisedAbsenceProofs!(documents);
    const recheck = await this.#waitForStableSupervisedFence(runtime, 'absence');
    if (
      runtime.observationPoison !== undefined ||
      recheck.observationEpoch !== fence.observationEpoch ||
      recheck.observationGeneration !== fence.observationGeneration ||
      stableJson(recheck.snapshot) !== stableJson(fence.snapshot)
    ) {
      throw new Error('SUPERVISED_PROOF_INVALIDATED');
    }
    const committedAtUtc = iso(this.#now());
    const state = {
      documents,
      committer,
      observationEpoch: fence.observationEpoch,
      observationGeneration: fence.observationGeneration,
      committedAtUtc,
      disconnected: false,
      committed: false,
    };
    runtime.supervisedAbsence = state;
    const room = runtime.room!;
    await room.disconnect();
    if (
      room.isConnected !== false ||
      room.connectionState !== ConnectionState.CONN_DISCONNECTED
    ) {
      throw new Error('SUPERVISED_RTC_DISCONNECT_NOT_VERIFIED');
    }
    runtime.rtcConnected = false;
    delete runtime.room;
    state.disconnected = true;
    await committer.commit(
      state.committedAtUtc,
    );
    state.committed = true;
    return documents;
  }

  #gatewayConnectionAllowed(runtime: SessionRuntime): boolean {
    if (this.#config.deviceLan?.supervised === undefined) return this.#runtimeMayAct(runtime);
    return (
      this.#sessions.get(runtime.id) === runtime &&
      !runtime.stopping &&
      !runtime.ended &&
      runtime.observationPoison === undefined
    );
  }

  async #connectGatewayRoom(runtime: SessionRuntime, gatewayJwt: string): Promise<void> {
    if (!this.#gatewayConnectionAllowed(runtime)) return;
    const room = this.#roomFactory();
    runtime.room = room;
    const reportPrimitiveError = (error: unknown): void => {
      if (this.#config.deviceLan?.supervised !== undefined) {
        this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_PRIMITIVE_FAILURE');
      }
      this.#broadcast(runtime, {
        kind: 'rejected',
        sessionId: runtime.id,
        occurredAt: iso(),
        errors: [error instanceof Error ? error.message : 'OFFICIAL_PRIMITIVE_ADAPTER_FAILED'],
      });
    };
    room.on(
      RoomEvent.DataReceived,
      (
        payload: Uint8Array,
        participant: RemoteParticipant | undefined,
        kind: DataPacketKind | undefined,
        topic: string | undefined,
      ) =>
        this.#queueRtcObservation(runtime, () => {
          if (this.#config.deviceLan?.supervised !== undefined) {
            this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_REMOTE_DATA_FORBIDDEN');
            return;
          }
          if (topic !== RELIABLE_EVENT_TOPIC) return;
          try {
            let candidate: unknown;
            try {
              candidate = parseStrictJsonBytes(payload, RTC_EVENT_JSON_MAX_BYTES);
            } catch {
              throw new Error('MALFORMED_EVENT_JSON');
            }
            assertRtcPublisherBinding(runtime, candidate, participant, kind, topic);
            this.ingest(runtime.id, candidate, participant?.identity);
          } catch (error) {
            this.#broadcast(runtime, {
              kind: 'rejected',
              sessionId: runtime.id,
              occurredAt: iso(),
              errors: [error instanceof Error ? error.message : 'MALFORMED_EVENT_JSON'],
            });
          }
        }),
    );
    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) =>
      this.#queueRtcObservation(runtime, () => this.#observeParticipant(runtime, participant)),
    );
    room.on(
      RoomEvent.TrackPublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) =>
        this.#queueRtcObservation(runtime, () =>
          this.#observeLiveKitPublication(runtime, participant, publication),
        ),
    );
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) =>
        this.#queueRtcObservation(runtime, () => {
          this.#observeLiveKitPublication(runtime, participant, publication, false);
          this.#startDirectMicrophone(runtime, track, publication, participant, reportPrimitiveError);
        }),
    );
    room.on(
      RoomEvent.TrackUnsubscribed,
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) =>
        this.#queueRtcObservation(runtime, () =>
          this.#invalidateDirectTrack(runtime, participant, publication, track),
        ),
    );
    room.on(
      RoomEvent.TrackUnpublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) =>
        this.#queueRtcObservation(runtime, () => {
          this.#recordSupervisedUnpublication(runtime, participant, publication);
          this.#invalidateDirectTrack(runtime, participant, publication);
        }),
    );
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) =>
      this.#queueRtcObservation(runtime, () => {
        this.#recordSupervisedDisconnect(runtime, participant);
        for (const publication of participant.trackPublications.values()) {
          this.#invalidateDirectTrack(runtime, participant, publication as RemoteTrackPublication);
        }
        const originDeviceId = participant.attributes.device_id;
        this.#broadcast(runtime, {
          kind: 'lifecycle',
          sessionId: runtime.id,
          occurredAt: iso(),
          ...(originDeviceId === undefined ? {} : { originDeviceId }),
          displayText: 'participant disconnected',
        });
        if (
          this.#config.deviceLan &&
          !runtime.stopping &&
          (participant === runtime.physicalParticipant ||
            participant.identity === runtime.userIdentity)
        ) {
          this.#triggerDeadlineOrSecurityStop(runtime, 'participant_disconnect');
        }
      }),
    );
    room.on(RoomEvent.Reconnecting, () =>
      this.#queueRtcObservation(runtime, () => {
        runtime.observationGeneration = incrementSupervisedObservationCounter(
          runtime.observationGeneration,
        );
        if (this.#config.deviceLan) {
          this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_GATEWAY_RECONNECT');
          this.#triggerDeadlineOrSecurityStop(runtime, 'reconnect_replay');
          return;
        }
        this.#broadcast(runtime, {
          kind: 'lifecycle',
          sessionId: runtime.id,
          occurredAt: iso(),
          displayText: 'gateway reconnecting',
        });
      }),
    );
    room.on(RoomEvent.Reconnected, () =>
      this.#queueRtcObservation(runtime, () => {
        runtime.observationGeneration = incrementSupervisedObservationCounter(
          runtime.observationGeneration,
        );
        if (this.#config.deviceLan) {
          this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_GATEWAY_RECONNECT');
          this.#triggerDeadlineOrSecurityStop(runtime, 'reconnect_replay');
          return;
        }
        this.#broadcast(runtime, {
          kind: 'lifecycle',
          sessionId: runtime.id,
          occurredAt: iso(),
          displayText: 'gateway reconnected; producer must emit frozen reconnect envelope',
        });
        void this.#publishLocallyOwnedReplay(runtime).catch(reportPrimitiveError);
      }),
    );
    await room.connect(this.#config.livekitUrl, gatewayJwt);
    runtime.rtcConnected = true;
    runtime.observationGeneration = incrementSupervisedObservationCounter(
      runtime.observationGeneration,
    );
    if (!this.#gatewayConnectionAllowed(runtime)) {
      await room.disconnect();
      runtime.rtcConnected = false;
      delete runtime.room;
      return;
    }
    for (const participant of room.remoteParticipants.values()) {
      this.#queueRtcObservation(runtime, () => this.#observeParticipant(runtime, participant));
    }
    await runtime.observationQueue;
    if (runtime.userSessionStarted) await this.#publishLocallyOwnedReplay(runtime);
  }

  async #joinGatewayAfterUser(runtime: SessionRuntime): Promise<void> {
    if (!this.#runtimeMayAct(runtime)) return;
    const started = this.#now();
    while (
      this.#runtimeMayAct(runtime) &&
      this.#now() - started < MAX_JOIN_WAIT_MS
    ) {
      try {
        const participants = await this.#roomService.listParticipants(runtime.id);
        if (
          participants.some(
            (participant: { identity: string }) => participant.identity === runtime.userIdentity,
          )
        )
          break;
      } catch {
        // The bounded poll remains local and stops at the fixed deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!this.#runtimeMayAct(runtime)) {
      if (this.#now() >= runtime.expiresAt) {
        this.#triggerDeadlineOrSecurityStop(runtime, 'deadline_expired');
      }
      return;
    }
    if (this.#now() - started >= MAX_JOIN_WAIT_MS) {
      this.#broadcast(runtime, {
        kind: 'rejected',
        sessionId: runtime.id,
        occurredAt: iso(),
        errors: ['USER_PARTICIPANT_JOIN_TIMEOUT'],
      });
      return;
    }
    this.#markDeviceLanActive(runtime.id);
    if (!this.#runtimeMayAct(runtime)) return;

    const gatewayBinding = gatewayPublisherIdentityBinding();
    const gatewayIssuedAtEpochSeconds = Math.floor(this.#now() / 1_000);
    const gatewayTokenTtlSeconds = this.#config.deviceLan
      ? runtime.sessionDeadlineEpochSeconds - gatewayIssuedAtEpochSeconds - 1
      : this.#config.tokenTtlSeconds;
    if (gatewayTokenTtlSeconds < 1 || gatewayTokenTtlSeconds > this.#config.tokenTtlSeconds) {
      this.#triggerDeadlineOrSecurityStop(runtime, 'deadline_expired');
      return;
    }
    const gatewayToken = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
      identity: gatewayBinding.identity,
      name: 'Windows Demo Gateway',
      ttl: gatewayTokenTtlSeconds,
      attributes: gatewayBinding.attributes,
    });
    const grant: VideoGrant = {
      room: runtime.id,
      roomJoin: true,
      canPublish: false,
      canPublishData: true,
      canSubscribe: true,
    };
    gatewayToken.addGrant(grant);
    if (this.#config.deviceLan) setLiveKitIssuedAt(gatewayToken, gatewayIssuedAtEpochSeconds);
    const gatewayJwt = await gatewayToken.toJwt();
    if (this.#config.deviceLan) {
      assertDeviceLanGatewayToken(gatewayJwt, {
        apiKey: this.#config.apiKey,
        roomName: runtime.id,
        identity: gatewayBinding.identity,
        attributes: gatewayBinding.attributes,
        issuedAtEpochSeconds: gatewayIssuedAtEpochSeconds,
        currentEpochSeconds: Math.floor(this.#now() / 1_000),
        deadlineEpochSeconds: runtime.sessionDeadlineEpochSeconds,
      });
    }
    if (!this.#runtimeMayAct(runtime)) return;
    await this.#connectGatewayRoom(runtime, gatewayJwt);
  }

  #observeParticipant(runtime: SessionRuntime, participant: RemoteParticipant): void {
    this.#recordSupervisedParticipant(runtime, participant);
    if (runtime.observationPoison !== undefined) return;
    if (this.#config.deviceLan) {
      if (
        participant.identity !== runtime.userIdentity ||
        (runtime.physicalParticipant !== undefined &&
          runtime.physicalParticipant !== participant)
      ) {
        this.#triggerDeadlineOrSecurityStop(runtime, 'duplicate_identity');
        return;
      }
      try {
        this.#assertDirectUserParticipant(runtime, participant);
      } catch {
        this.#triggerDeadlineOrSecurityStop(runtime, 'duplicate_identity');
        return;
      }
      runtime.physicalParticipant ??= participant;
      this.#markDeviceLanActive(runtime.id);
    }
    if (!this.#runtimeMayAct(runtime)) return;
    for (const publication of participant.trackPublications.values()) {
      const remotePublication = publication as RemoteTrackPublication;
      this.#observeLiveKitPublication(runtime, participant, remotePublication);
      if (remotePublication.subscribed && remotePublication.track) {
        this.#startDirectMicrophone(
          runtime,
          remotePublication.track as RemoteTrack,
          remotePublication,
          participant,
          (error) =>
            this.#broadcast(runtime, {
              kind: 'rejected',
              sessionId: runtime.id,
              occurredAt: iso(),
              errors: [error instanceof Error ? error.message : 'DIRECT_LOOP_FAILED'],
            }),
        );
      }
    }
    const originDeviceId = participant.attributes.device_id;
    this.#broadcast(runtime, {
      kind: 'lifecycle',
      sessionId: runtime.id,
      occurredAt: iso(),
      ...(originDeviceId === undefined ? {} : { originDeviceId }),
      displayText: `participant online: ${participant.identity}`,
    });
  }

  #observeLiveKitPublication(
    runtime: SessionRuntime,
    participant: RemoteParticipant,
    publication: RemoteTrackPublication,
    recordPublishedEvent = true,
  ): void {
    if (recordPublishedEvent) {
      this.#recordSupervisedPublication(runtime, participant, publication);
    } else if (
      this.#config.deviceLan?.supervised !== undefined &&
      (runtime.contactState !== 'PUBLISHED' ||
        runtime.contactParticipant !== participant ||
        runtime.contactPublication !== publication ||
        runtime.contactPublicationSid !== publication.sid)
    ) {
      this.#poisonSupervisedRuntime(runtime, 'SUPERVISED_SUBSCRIPTION_AMBIGUOUS');
    }
    if (runtime.observationPoison !== undefined) return;
    if (!this.#runtimeMayAct(runtime)) return;
    const publicationSid = publication.sid;
    if (typeof publicationSid !== 'string' || publicationSid.length === 0) return;
    const tupleKey = `${runtime.id}\u0000${participant.identity}\u0000${publicationSid}`;
    if (!runtime.contractPublicationObservationKeys.has(tupleKey)) {
      runtime.consumer.recordPublicationObservation({
        session_id: runtime.id,
        room_name: runtime.id,
        rtc_publisher_identity: participant.identity,
        publication_sid: publicationSid,
      });
      runtime.contractPublicationObservationKeys.add(tupleKey);
    }
    runtime.observedLiveKitPublicationKeys.add(tupleKey);
    if (runtime.pendingLiveKitMediaKeys.has(tupleKey)) {
      runtime.liveKitMediaResourceKeys.add(tupleKey);
    }
  }
}

export interface RayneoVisualSessionBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly credentialId: string;
  readonly capabilitySha256: string;
  readonly openedAt: number;
  readonly expiresAt: number;
}

export interface RayneoVisualFrameMetadata {
  readonly frameId: string;
  readonly cameraId: string;
  readonly capturedAt: string;
  readonly sensorTimestampNs: string;
  readonly width: number;
  readonly height: number;
  readonly jpegBytes: number;
  readonly jpegSha256: string;
}

export interface RayneoVisualModelBinding {
  readonly requestEventId: string;
  readonly resultEventId: string;
  readonly deliveryEventId: string;
}

export interface RayneoVisualAdapterSnapshot {
  readonly active: boolean;
  readonly cleaned: boolean;
  readonly rawImageBytes: number;
  readonly eventCount: number;
  readonly modelCacheEntries: number;
  readonly frameId?: string;
  readonly replyId?: string;
}

export interface RayneoVisualFrameTimingSnapshot {
  readonly capturedAt: string;
  readonly mediaOccurredAt: string;
  readonly mediaExpiresAt: string;
}

interface RayneoVisualRuntime {
  readonly binding: RayneoVisualSessionBinding;
  readonly traceId: string;
  readonly gatewayConnectionId: string;
  readonly deviceConnectionId: string;
  readonly consumer: ContractConsumer;
  readonly events: EventEnvelope[];
  readonly streamState: Map<string, { number: number; eventId: string }>;
  rawImage?: Buffer;
  frame?: RayneoVisualFrameMetadata;
  mediaEventId?: string;
  requestEventId?: string;
  resultEventId?: string;
  deliveryEventId?: string;
  replyId?: string;
  modelCacheEntries: number;
  receiptAccepted: boolean;
}

export interface RayneoVisualSessionAdapterDependencies {
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

/**
 * Isolated one-frame RayNeo adapter. It deliberately does not enter the
 * LiveKit/device-LAN state machine used by the iPhone path above.
 */
export class RayneoVisualSessionAdapter {
  readonly #now: () => number;
  readonly #randomUuid: () => string;
  #runtime: RayneoVisualRuntime | undefined;
  #cleaned = false;
  #stopInProgress = false;

  constructor(
    binding: RayneoVisualSessionBinding,
    dependencies: RayneoVisualSessionAdapterDependencies = {},
  ) {
    this.#now = dependencies.now ?? Date.now;
    this.#randomUuid = dependencies.randomUuid ?? randomUUID;
    this.#assertBinding(binding);
    const runtime: RayneoVisualRuntime = {
      binding: Object.freeze({ ...binding }),
      traceId: this.#randomUuid(),
      gatewayConnectionId: `rayneo_gateway_conn_${binding.runId.slice(-20)}`,
      deviceConnectionId: `rayneo_device_conn_${binding.runId.slice(-20)}`,
      consumer: new ContractConsumer(CONTRACT_SCHEMA_VERSION),
      events: [],
      streamState: new Map(),
      modelCacheEntries: 0,
      receiptAccepted: false,
    };
    this.#runtime = runtime;
    this.#accept(runtime, this.#event(runtime, {
      suffix: 'session.started',
      origin: 'gateway',
      streamId: 'rayneo_gateway_control',
      occurredAt: binding.openedAt,
      payload: {
        active_device_id: binding.deviceId,
        active_device_lease_version: 1,
        session_expires_at: iso(binding.expiresAt),
        cleanup_deadline_at: iso(binding.expiresAt + 5_000),
        credential_lease: {
          credential_id: binding.credentialId,
          expires_at: iso(binding.expiresAt),
          scopes: ['publish_video', 'subscribe'],
        },
      },
    }));
  }

  binding(): RayneoVisualSessionBinding {
    return this.#requiredRuntime().binding;
  }

  snapshot(): RayneoVisualAdapterSnapshot {
    const runtime = this.#runtime;
    if (!runtime) {
      return { active: false, cleaned: this.#cleaned, rawImageBytes: 0, eventCount: 0, modelCacheEntries: 0 };
    }
    return {
      active: true,
      cleaned: false,
      rawImageBytes: runtime.rawImage?.byteLength ?? 0,
      eventCount: runtime.events.length,
      modelCacheEntries: runtime.modelCacheEntries,
      ...(runtime.frame === undefined ? {} : { frameId: runtime.frame.frameId }),
      ...(runtime.replyId === undefined ? {} : { replyId: runtime.replyId }),
    };
  }

  eventTypes(): readonly string[] {
    return this.#requiredRuntime().events.map((event) => String(event.event_type));
  }

  frameTimingSnapshot(): RayneoVisualFrameTimingSnapshot {
    const runtime = this.#requiredRuntime();
    if (!runtime.frame || !runtime.mediaEventId) throw new Error('FRAME_NOT_ACCEPTED');
    const media = runtime.events.find((event) => event.event_id === runtime.mediaEventId);
    if (!media) throw new Error('MEDIA_EVENT_NOT_FOUND');
    return {
      capturedAt: runtime.frame.capturedAt,
      mediaOccurredAt: String(media.occurred_at),
      mediaExpiresAt: String(media.payload.media_ref.expires_at),
    };
  }

  acceptFrame(metadata: RayneoVisualFrameMetadata, jpeg: Buffer): { readonly mediaEventId: string } {
    const runtime = this.#requiredAvailableRuntime();
    if (runtime.frame) throw new Error('FRAME_ALREADY_ACCEPTED');
    if (jpeg.byteLength !== metadata.jpegBytes || bytesSha256(jpeg) !== metadata.jpegSha256) {
      throw new Error('FRAME_INTEGRITY_MISMATCH');
    }
    const capturedAtMs = Date.parse(metadata.capturedAt);
    if (!Number.isSafeInteger(capturedAtMs)) throw new Error('FRAME_CAPTURE_TIME_INVALID');
    const captureStart = this.#event(runtime, {
      suffix: 'capture.status', origin: 'device', streamId: 'rayneo_camera_capture',
      occurredAt: capturedAtMs,
      payload: {
        device_id: runtime.binding.deviceId, capture_kind: 'camera', status: 'started',
        explicit_user_action: true, indicator_visible: true, observed_at: metadata.capturedAt,
      },
    });
    this.#accept(runtime, captureStart);
    const media = this.#event(runtime, {
      suffix: 'media.referenced', origin: 'device', streamId: 'rayneo_camera_capture',
      occurredAt: capturedAtMs,
      payload: {
        media_ref: {
          media_id: metadata.frameId,
          kind: 'image',
          transport: 'ephemeral_object',
          locator: `ephemeral://session/${runtime.binding.sessionId}/rayneo-frame/${metadata.frameId}`,
          mime_type: 'image/jpeg',
          byte_length: metadata.jpegBytes,
          sha256: metadata.jpegSha256,
          capture_mode: 'user_triggered_frame',
          expires_at: iso(Math.min(runtime.binding.expiresAt, capturedAtMs + 300_000)),
        },
        explicit_capture: true,
      },
    });
    this.#accept(runtime, media);
    this.#accept(runtime, this.#event(runtime, {
      suffix: 'capture.status', origin: 'device', streamId: 'rayneo_camera_capture',
      occurredAt: this.#now(),
      payload: {
        device_id: runtime.binding.deviceId, capture_kind: 'camera', status: 'stopped',
        explicit_user_action: true, indicator_visible: true, observed_at: iso(this.#now()),
      },
    }));
    runtime.frame = Object.freeze({ ...metadata });
    runtime.mediaEventId = String(media.event_id);
    runtime.rawImage = Buffer.from(jpeg);
    return { mediaEventId: runtime.mediaEventId };
  }

  copyRawImageForModel(): Buffer {
    const raw = this.#requiredAvailableRuntime().rawImage;
    if (!raw) throw new Error('RAW_IMAGE_UNAVAILABLE');
    return Buffer.from(raw);
  }

  recordModelRequested(mediaEventId: string): string {
    const runtime = this.#requiredAvailableRuntime();
    if (runtime.mediaEventId !== mediaEventId || runtime.requestEventId) {
      throw new Error('MODEL_REQUEST_BINDING_INVALID');
    }
    const event = this.#event(runtime, {
      suffix: 'model.requested', origin: 'gateway', streamId: 'rayneo_gateway_control',
      occurredAt: this.#now(), payload: { input_event_ids: [mediaEventId], requested_outputs: ['text'] },
    });
    this.#accept(runtime, event);
    runtime.requestEventId = String(event.event_id);
    runtime.modelCacheEntries = 1;
    return runtime.requestEventId;
  }

  recordModelSuccess(input: {
    readonly requestEventId: string; readonly replyId: string; readonly text: string;
    readonly provider: string; readonly model: string; readonly latencyMs: number;
  }): RayneoVisualModelBinding {
    const runtime = this.#requiredAvailableRuntime();
    if (runtime.requestEventId !== input.requestEventId || runtime.resultEventId) {
      throw new Error('MODEL_RESULT_BINDING_INVALID');
    }
    const result = this.#event(runtime, {
      suffix: 'model.result', origin: 'gateway', streamId: 'rayneo_gateway_control',
      occurredAt: this.#now(),
      payload: {
        request_event_id: input.requestEventId,
        result_id: `rayneo_result_${runtime.binding.runId.slice(-20)}`,
        status: 'success', provider: input.provider, model: input.model,
        latency_ms: input.latencyMs, non_authoritative: true,
        outputs: [{ modality: 'text', text: input.text, language: 'und' }],
      },
    });
    this.#accept(runtime, result);
    const delivery = this.#event(runtime, {
      suffix: 'delivery.requested', origin: 'gateway', streamId: 'rayneo_gateway_control',
      occurredAt: this.#now(),
      payload: {
        result_event_id: result.event_id, target_device_id: runtime.binding.deviceId,
        channel: 'text', active_device_lease_version: 1, suppress_other_devices: true,
      },
    });
    this.#accept(runtime, delivery);
    runtime.resultEventId = String(result.event_id);
    runtime.deliveryEventId = String(delivery.event_id);
    runtime.replyId = input.replyId;
    return {
      requestEventId: input.requestEventId,
      resultEventId: runtime.resultEventId,
      deliveryEventId: runtime.deliveryEventId,
    };
  }

  recordDisplayReceipt(input: {
    readonly replyId: string; readonly renderedAt: string; readonly textSha256: string;
  }): void {
    const runtime = this.#requiredAvailableRuntime();
    if (
      runtime.replyId !== input.replyId || !runtime.deliveryEventId || runtime.receiptAccepted ||
      !/^[a-f0-9]{64}$/.test(input.textSha256)
    ) throw new Error('REPLY_NOT_ACTIVE');
    this.#accept(runtime, this.#event(runtime, {
      suffix: 'delivery.acknowledged', origin: 'device', streamId: 'rayneo_display_receipt',
      occurredAt: Date.parse(input.renderedAt),
      payload: {
        delivery_event_id: runtime.deliveryEventId,
        target_device_id: runtime.binding.deviceId,
        active_device_lease_version: 1,
        disposition: 'rendered',
        acknowledged_at: input.renderedAt,
      },
    }));
    runtime.receiptAccepted = true;
    this.#wipeRaw(runtime);
  }

  stop(reason: 'user_stop' | 'timeout' | 'gate_complete' | 'error'): EventEnvelope {
    if (this.#stopInProgress) throw new Error('SESSION_STOP_IN_PROGRESS');
    if (!this.#runtime) {
      if (this.#cleaned) throw new Error('SESSION_CLEANED');
      throw new Error('SESSION_NOT_FOUND');
    }
    this.#stopInProgress = true;
    try {
      const runtime = this.#runtime;
      const endedAt = this.#now();
      this.#accept(runtime, this.#event(runtime, {
        suffix: 'session.ended', origin: 'gateway', streamId: 'rayneo_gateway_control',
        occurredAt: endedAt,
        payload: {
          reason, ended_at: iso(endedAt),
          cleanup_deadline_at: iso(Math.min(runtime.binding.expiresAt + 5_000, endedAt + 5_000)),
        },
      }));
      const removed = {
        events: runtime.events.length,
        media_objects: runtime.frame ? 1 : 0,
        session_rows: 1,
        model_cache_entries: runtime.modelCacheEntries,
      };
      this.#wipeRaw(runtime);
      runtime.modelCacheEntries = 0;
      const receipt = this.#event(runtime, {
        suffix: 'session.cleanup.completed', origin: 'gateway', streamId: 'rayneo_cleanup_receipt',
        occurredAt: this.#now(),
        payload: { status: 'complete', completed_at: iso(this.#now()), removed },
      });
      this.#accept(runtime, receipt);
      this.#runtime = undefined;
      this.#cleaned = true;
      return receipt;
    } finally {
      this.#stopInProgress = false;
    }
  }

  #requiredRuntime(): RayneoVisualRuntime {
    if (!this.#runtime) throw new Error(this.#cleaned ? 'SESSION_CLEANED' : 'SESSION_NOT_FOUND');
    return this.#runtime;
  }

  #requiredAvailableRuntime(): RayneoVisualRuntime {
    const runtime = this.#requiredRuntime();
    if (this.#now() > runtime.binding.expiresAt) throw new Error('SESSION_STALE');
    return runtime;
  }

  #accept(runtime: RayneoVisualRuntime, event: EventEnvelope): void {
    const result = runtime.consumer.consume(event);
    if (!result.accepted || result.retry) {
      throw new Error(`GENERATED_EVENT_REJECTED:${result.errors.join(',')}`);
    }
    runtime.events.push(event);
    const stream = event.sequence as JsonObject;
    runtime.streamState.set(String(stream.stream_id), {
      number: Number(stream.number), eventId: String(event.event_id),
    });
  }

  #event(runtime: RayneoVisualRuntime, input: {
    readonly suffix: string; readonly origin: 'gateway' | 'device'; readonly streamId: string;
    readonly occurredAt: number; readonly payload: JsonObject;
  }): EventEnvelope {
    const prior = runtime.streamState.get(input.streamId);
    const eventId = this.#randomUuid();
    const sequence: JsonObject = { stream_id: input.streamId, number: (prior?.number ?? 0) + 1 };
    if (prior) sequence.previous_event_id = prior.eventId;
    const gateway = input.origin === 'gateway';
    return {
      schema_version: CONTRACT_SCHEMA_VERSION,
      event_type: `paios.phase0.demo.${input.suffix}`,
      event_id: eventId,
      session_id: runtime.binding.sessionId,
      trace_id: runtime.traceId,
      occurred_at: iso(input.occurredAt),
      expires_at: iso(Math.max(runtime.binding.expiresAt + 5_000, input.occurredAt + 1_000)),
      origin: gateway
        ? { device_id: GATEWAY_DEVICE_ID, device_class: 'windows_gateway', client_instance_id: GATEWAY_CLIENT_ID }
        : { device_id: runtime.binding.deviceId, device_class: 'rayneo', client_instance_id: runtime.binding.clientInstanceId },
      connection: {
        id: gateway ? runtime.gatewayConnectionId : runtime.deviceConnectionId,
        epoch: 0,
        state: 'connected',
      },
      sequence,
      idempotency_key: `rayneo-${input.suffix.replaceAll('.', '-')}-${eventId}`,
      payload: input.payload,
    };
  }

  #wipeRaw(runtime: RayneoVisualRuntime): void {
    runtime.rawImage?.fill(0);
    delete runtime.rawImage;
  }

  #assertBinding(binding: RayneoVisualSessionBinding): void {
    if (!/^rayneo_run_[a-f0-9]{20}$/.test(binding.runId)) throw new Error('RAYNEO_RUN_ID_INVALID');
    if (!/^phase0_session_[a-f0-9]{20}$/.test(binding.sessionId)) throw new Error('RAYNEO_SESSION_ID_INVALID');
    if (!/^rayneo_device_[a-f0-9]{20}$/.test(binding.deviceId)) throw new Error('RAYNEO_DEVICE_ID_INVALID');
    if (!/^rayneo_client_[a-f0-9]{20}$/.test(binding.clientInstanceId)) throw new Error('RAYNEO_CLIENT_ID_INVALID');
    if (!/^rayneo_capability_[a-f0-9]{20}$/.test(binding.credentialId)) throw new Error('RAYNEO_CREDENTIAL_ID_INVALID');
    if (!/^[a-f0-9]{64}$/.test(binding.capabilitySha256)) throw new Error('RAYNEO_CAPABILITY_HASH_INVALID');
    if (
      !Number.isSafeInteger(binding.openedAt) || !Number.isSafeInteger(binding.expiresAt) ||
      binding.expiresAt <= binding.openedAt || binding.expiresAt - binding.openedAt > 900_000
    ) throw new Error('RAYNEO_SESSION_TTL_INVALID');
  }
}
