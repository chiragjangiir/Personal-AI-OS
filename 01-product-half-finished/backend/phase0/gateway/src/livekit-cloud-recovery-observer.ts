import type {
  LiveKitCloudParticipantBinding,
  LiveKitCloudParticipantPort,
  LiveKitCloudParticipantSnapshot,
  LiveKitCloudRoomPort,
  LiveKitCloudParticipantTransportState,
} from './livekit-cloud-participant.ts';

/**
 * Internal/non-wire observation of the LiveKit Cloud SDK.  This module never
 * calls connect, publishTrack, unpublishTrack, or a recovery/bootstrap owner
 * port.  It only consumes the SDK event stream and produces a redacted local
 * record for a caller that already owns the participant binding.
 */

export type LiveKitCloudRecoveryEventName =
  | 'connected'
  | 'reconnecting'
  | 'reconnected'
  | 'disconnected'
  | 'connectionQualityChanged'
  | 'connectionStateChanged'
  | 'localTrackPublished'
  | 'localTrackUnpublished'
  | 'localTrackRepublished'
  | 'localTrackSubscribed'
  | 'trackSubscribed'
  | 'trackUnsubscribed'
  | 'encryptionError';

export type LiveKitCloudRecoveryObservationKind =
  | 'connected'
  | 'reconnecting'
  | 'reconnected'
  | 'client-disconnected'
  | 'owner-bootstrap-required'
  | 'connection-quality-changed'
  | 'connection-state-changed'
  | 'local-track-published'
  | 'local-track-unpublished'
  | 'local-track-republished'
  | 'local-track-subscribed'
  | 'track-subscribed'
  | 'track-unsubscribed'
  | 'encryption-error'
  | 'stats-sampled'
  | 'stats-sample-failed';

export type LiveKitCloudDisconnectReasonClass =
  | 'client-initiated'
  | 'duplicate-identity'
  | 'server-shutdown'
  | 'participant-removed'
  | 'network'
  | 'state-mismatch'
  | 'unknown';

export interface LiveKitCloudDisconnectReasonSummary {
  readonly classification: LiveKitCloudDisconnectReasonClass;
}

export type LiveKitCloudRecoveryTrackKind = 'audio' | 'video' | 'unknown';
export type LiveKitCloudRecoveryTrackSource =
  | 'camera'
  | 'microphone'
  | 'screen-share'
  | 'screen-share-audio'
  | 'unknown';

export interface LiveKitCloudRecoveryTrackIntent {
  readonly direction: 'local-publish' | 'local-subscribe' | 'remote-subscribe' | 'remote-unsubscribe';
  readonly kind: LiveKitCloudRecoveryTrackKind;
  readonly source: LiveKitCloudRecoveryTrackSource;
}

export interface LiveKitCloudRecoveryTrackCounters {
  readonly localPublished: number;
  readonly localUnpublished: number;
  readonly localRepublished: number;
  readonly localSubscribed: number;
  readonly remoteSubscribed: number;
  readonly remoteUnsubscribed: number;
}

export interface LiveKitCloudRecoveryBindingSummary {
  readonly bound: boolean;
  readonly connectionEpoch?: string;
  readonly sessionRefPresent: boolean;
  readonly deviceLeaseRefPresent: boolean;
  readonly continuityIdPresent: boolean;
  readonly transportAliasCount: number;
  readonly consistent: boolean;
}

export type LiveKitCloudRecoveryProtocol = 'udp' | 'tcp' | 'tls' | 'unknown';
export type LiveKitCloudRecoveryCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface LiveKitCloudRedactedStatsSummary {
  readonly sampled: true;
  readonly publisherRecordCount: number;
  readonly subscriberRecordCount: number;
  readonly statsRecordCount: number;
  readonly candidateRecordCount: number;
  readonly candidatePairRecordCount: number;
  readonly transportRecordCount: number;
  readonly protocolCounts: Readonly<Record<LiveKitCloudRecoveryProtocol, number>>;
  readonly candidateTypeCounts: Readonly<Record<LiveKitCloudRecoveryCandidateType, number>>;
  readonly packetCounters: Readonly<{
    packetsSent: number;
    packetsReceived: number;
    bytesSent: number;
    bytesReceived: number;
  }>;
  /** Explicitly prevents consumers from treating this as a pair proof. */
  readonly candidatePairClaim: 'not-claimed';
}

export interface LiveKitCloudRecoveryObservation {
  readonly sequence: number;
  readonly observedAtMs: number;
  readonly event: LiveKitCloudRecoveryEventName | 'stats';
  readonly kind: LiveKitCloudRecoveryObservationKind;
  readonly duplicate: boolean;
  readonly passive: true;
  readonly connected: boolean;
  readonly transportState: LiveKitCloudParticipantTransportState;
  readonly connectionEpoch?: string;
  readonly binding: LiveKitCloudRecoveryBindingSummary;
  readonly recoveryCycle?: number;
  readonly recoveryElapsedMs?: number;
  readonly disconnectReason?: LiveKitCloudDisconnectReasonSummary;
  /** A terminal non-client event requires T11B/owner authority review. */
  readonly ownerAuthorityCheckRequired?: true;
  /** Observation never authorizes a bootstrap. */
  readonly bootstrapAuthorized?: false;
  /** Legacy disposition label; it is a request for owner review, not permission. */
  readonly ownerBootstrapRequired?: true;
  readonly connectionQuality?: 'poor' | 'good' | 'excellent' | 'lost' | 'unknown';
  readonly connectionState?: 'disconnected' | 'connected' | 'reconnecting' | 'unknown';
  readonly trackIntent?: LiveKitCloudRecoveryTrackIntent;
  readonly trackCounters?: LiveKitCloudRecoveryTrackCounters;
  readonly trackIntentDifference?: number;
  readonly stats?: LiveKitCloudRedactedStatsSummary;
  readonly statsError?: 'unavailable' | 'invalid';
}

export interface LiveKitCloudRecoveryStatsPort {
  getRtcStats(): Promise<unknown>;
}

export interface LiveKitCloudRecoveryObserverOptions {
  readonly room?: LiveKitCloudRoomPort;
  readonly statsPort?: LiveKitCloudRecoveryStatsPort | (() => Promise<unknown>);
  readonly nowMs?: () => number;
  readonly autoStart?: boolean;
  readonly onObservation?: (observation: LiveKitCloudRecoveryObservation) => void;
  readonly expectedTrackIntent?: Partial<LiveKitCloudRecoveryTrackCounters>;
}

export interface LiveKitCloudRecoveryObserverSnapshot {
  readonly active: boolean;
  readonly closed: boolean;
  readonly terminal: boolean;
  readonly status: 'idle' | 'observing' | 'reconnecting' | 'reconnected' | 'terminal-disconnected' | 'closed';
  readonly sequence: number;
  readonly observations: readonly LiveKitCloudRecoveryObservation[];
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly trackCounters: LiveKitCloudRecoveryTrackCounters;
  readonly recoveryCycle: number;
  readonly binding: LiveKitCloudRecoveryBindingSummary;
}

type AnyRecord = Record<string, unknown>;
type TrackCounterName = keyof LiveKitCloudRecoveryTrackCounters;
type Listener = (...args: readonly unknown[]) => void;

const EVENT_NAMES: readonly LiveKitCloudRecoveryEventName[] = Object.freeze([
  'connected',
  'reconnecting',
  'reconnected',
  'disconnected',
  'connectionQualityChanged',
  'connectionStateChanged',
  'localTrackPublished',
  'localTrackUnpublished',
  'localTrackRepublished',
  'localTrackSubscribed',
  'trackSubscribed',
  'trackUnsubscribed',
  'encryptionError',
]);

const INITIAL_TRACK_COUNTERS: LiveKitCloudRecoveryTrackCounters = Object.freeze({
  localPublished: 0,
  localUnpublished: 0,
  localRepublished: 0,
  localSubscribed: 0,
  remoteSubscribed: 0,
  remoteUnsubscribed: 0,
});

const PROTOCOLS: readonly LiveKitCloudRecoveryProtocol[] = Object.freeze(['udp', 'tcp', 'tls', 'unknown']);
const CANDIDATE_TYPES: readonly LiveKitCloudRecoveryCandidateType[] = Object.freeze([
  'host',
  'srflx',
  'prflx',
  'relay',
  'unknown',
]);

function asRecord(value: unknown): AnyRecord | undefined {
  return value !== null && typeof value === 'object' ? value as AnyRecord : undefined;
}

function read(value: unknown, key: string): unknown {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function finiteNow(now: (() => number) | undefined): number {
  try {
    const value = now?.() ?? Date.now();
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : Date.now();
  } catch {
    return Date.now();
  }
}

function boundedCount(value: unknown): number {
  try {
    if (typeof value === 'bigint') {
      if (value <= 0n) return 0;
      return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
    }
  } catch {
    // Hostile stats are treated as absent, never reflected in output.
  }
  return 0;
}

function safeArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value.slice(0, 4096);
  const values = read(value, 'values');
  if (typeof values !== 'function') return [];
  const output: unknown[] = [];
  try {
    const iterator = (values as () => unknown).call(value);
    if (iterator === null || typeof iterator !== 'object' || typeof read(iterator, 'next') !== 'function') return [];
    for (let index = 0; index < 4096; index += 1) {
      const next = read(iterator, 'next');
      if (typeof next !== 'function') break;
      const result = asRecord((next as () => unknown).call(iterator));
      if (result === undefined || read(result, 'done') === true) break;
      output.push(read(result, 'value'));
    }
  } catch {
    // A broken iterator cannot make the observer fail or expose its error.
  }
  return output;
}

function safeLowerEnum(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') return value.toLowerCase().replaceAll('_', '-');
  } catch {
    return undefined;
  }
  return undefined;
}

function protocol(value: unknown): LiveKitCloudRecoveryProtocol {
  if (typeof value === 'number') {
    if (value === 0) return 'udp';
    if (value === 1) return 'tcp';
    if (value === 2) return 'tls';
    return 'unknown';
  }
  const lower = safeLowerEnum(value);
  if (lower === 'udp' || lower === 'transport-udp') return 'udp';
  if (lower === 'tcp' || lower === 'transport-tcp') return 'tcp';
  if (lower === 'tls' || lower === 'ssl' || lower === 'transport-tls') return 'tls';
  return 'unknown';
}

function candidateType(value: unknown): LiveKitCloudRecoveryCandidateType {
  if (typeof value === 'number') {
    if (value === 0) return 'host';
    if (value === 1) return 'srflx';
    if (value === 2) return 'prflx';
    if (value === 3) return 'relay';
    return 'unknown';
  }
  const lower = safeLowerEnum(value);
  if (lower === 'host') return 'host';
  if (lower === 'srflx' || lower === 'server-reflexive') return 'srflx';
  if (lower === 'prflx' || lower === 'peer-reflexive') return 'prflx';
  if (lower === 'relay') return 'relay';
  return 'unknown';
}

function trackKind(value: unknown): LiveKitCloudRecoveryTrackKind {
  if (typeof value === 'number') {
    if (value === 1) return 'audio';
    if (value === 2) return 'video';
    return 'unknown';
  }
  const lower = safeLowerEnum(value);
  if (lower === 'audio' || lower === 'kind-audio') return 'audio';
  if (lower === 'video' || lower === 'kind-video') return 'video';
  return 'unknown';
}

function trackSource(value: unknown): LiveKitCloudRecoveryTrackSource {
  if (typeof value === 'number') {
    if (value === 1) return 'camera';
    if (value === 2) return 'microphone';
    if (value === 3) return 'screen-share';
    if (value === 4) return 'screen-share-audio';
    return 'unknown';
  }
  const lower = safeLowerEnum(value);
  if (lower === 'camera' || lower === 'source-camera') return 'camera';
  if (lower === 'microphone' || lower === 'source-microphone') return 'microphone';
  if (lower === 'screenshare' || lower === 'screen-share' || lower === 'source-screenshare') return 'screen-share';
  if (lower === 'screenshare-audio' || lower === 'screen-share-audio') return 'screen-share-audio';
  return 'unknown';
}

function quality(value: unknown): NonNullable<LiveKitCloudRecoveryObservation['connectionQuality']> {
  if (typeof value === 'number') {
    if (value === 0) return 'poor';
    if (value === 1) return 'good';
    if (value === 2) return 'excellent';
    if (value === 3) return 'lost';
    return 'unknown';
  }
  const lower = safeLowerEnum(value);
  if (lower?.includes('poor')) return 'poor';
  if (lower?.includes('good')) return 'good';
  if (lower?.includes('excellent')) return 'excellent';
  if (lower?.includes('lost')) return 'lost';
  return 'unknown';
}

function connectionState(value: unknown): NonNullable<LiveKitCloudRecoveryObservation['connectionState']> {
  if (typeof value === 'number') {
    if (value === 0) return 'disconnected';
    if (value === 1) return 'connected';
    if (value === 2) return 'reconnecting';
    return 'unknown';
  }
  const lower = safeLowerEnum(value);
  if (lower?.includes('disconnect')) return 'disconnected';
  if (lower?.includes('reconnect')) return 'reconnecting';
  if (lower === 'connected' || lower === 'conn-connected') return 'connected';
  return 'unknown';
}

function disconnectReason(value: unknown): LiveKitCloudDisconnectReasonSummary {
  if (value !== null && typeof value === 'object') {
    const nested = read(value, 'reason') ?? read(value, 'code') ?? read(value, 'classification');
    if (nested !== undefined && nested !== value) return disconnectReason(nested);
  }
  if (typeof value === 'number') {
    if (value === 1) return Object.freeze({ classification: 'client-initiated' });
    if (value === 2) return Object.freeze({ classification: 'duplicate-identity' });
    if (value === 3) return Object.freeze({ classification: 'server-shutdown' });
    if (value === 4) return Object.freeze({ classification: 'participant-removed' });
    return Object.freeze({ classification: 'unknown' });
  }
  const lower = safeLowerEnum(value);
  if (lower?.includes('client')) return Object.freeze({ classification: 'client-initiated' });
  if (lower?.includes('duplicate') || lower?.includes('identity')) {
    return Object.freeze({ classification: 'duplicate-identity' });
  }
  if (lower?.includes('server') || lower?.includes('shutdown')) {
    return Object.freeze({ classification: 'server-shutdown' });
  }
  if (lower?.includes('removed') || lower?.includes('participant')) {
    return Object.freeze({ classification: 'participant-removed' });
  }
  if (lower?.includes('state') && lower.includes('mismatch')) {
    return Object.freeze({ classification: 'state-mismatch' });
  }
  if (lower?.includes('network') || lower?.includes('timeout') || lower?.includes('transport')
    || lower?.includes('signal') || lower?.includes('ice') || lower?.includes('connection')) {
    return Object.freeze({ classification: 'network' });
  }
  return Object.freeze({ classification: 'unknown' });
}

function initialProtocolCounts(): Record<LiveKitCloudRecoveryProtocol, number> {
  return { udp: 0, tcp: 0, tls: 0, unknown: 0 };
}

function initialCandidateCounts(): Record<LiveKitCloudRecoveryCandidateType, number> {
  return { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
}

function bindingSummary(
  binding: LiveKitCloudParticipantBinding | undefined,
  consistent: boolean,
): LiveKitCloudRecoveryBindingSummary {
  if (binding === undefined) return Object.freeze({
    bound: false,
    sessionRefPresent: false,
    deviceLeaseRefPresent: false,
    continuityIdPresent: false,
    transportAliasCount: 0,
    consistent,
  });
  return Object.freeze({
    bound: true,
    ...(typeof binding.connectionEpoch === 'string' ? { connectionEpoch: binding.connectionEpoch } : {}),
    sessionRefPresent: binding.realtimeSessionRef !== undefined,
    deviceLeaseRefPresent: binding.deviceLeaseRef !== undefined,
    continuityIdPresent: binding.continuityId !== undefined,
    transportAliasCount: Array.isArray(binding.transportAliases) ? Math.min(binding.transportAliases.length, 4096) : 0,
    consistent,
  });
}

function aliasesSame(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function bindingsSame(left: LiveKitCloudParticipantBinding | undefined, right: LiveKitCloudParticipantBinding | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Object.is(left.realtimeSessionRef, right.realtimeSessionRef)
    && Object.is(left.deviceLeaseRef, right.deviceLeaseRef)
    && Object.is(left.continuityId, right.continuityId)
    && left.connectionEpoch === right.connectionEpoch
    && aliasesSame(left.transportAliases, right.transportAliases);
}

function trackFromArgs(args: readonly unknown[], event: LiveKitCloudRecoveryEventName): {
  readonly kind: LiveKitCloudRecoveryTrackKind;
  readonly source: LiveKitCloudRecoveryTrackSource;
} {
  const publication = trackTarget(args, event);
  return Object.freeze({
    kind: trackKind(read(publication, 'kind') ?? read(args[0], 'kind')),
    source: trackSource(read(publication, 'source') ?? read(args[0], 'source')),
  });
}

function trackTarget(args: readonly unknown[], event: LiveKitCloudRecoveryEventName): unknown {
  return event === 'trackSubscribed' || event === 'trackUnsubscribed' ? args[1] : args[0];
}

function statsSummary(raw: unknown): LiveKitCloudRedactedStatsSummary {
  const protocolCounts = initialProtocolCounts();
  const candidateTypeCounts = initialCandidateCounts();
  const packetCounters = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0 };
  const publisher = safeArray(read(raw, 'publisherStats') ?? read(raw, 'publisher_stats'));
  const subscriber = safeArray(read(raw, 'subscriberStats') ?? read(raw, 'subscriber_stats'));
  const fallback = publisher.length === 0 && subscriber.length === 0 ? safeArray(raw) : [];
  const publishers = publisher.length > 0 || subscriber.length > 0 ? publisher : fallback;
  const subscribers = publisher.length > 0 || subscriber.length > 0 ? subscriber : [];
  let statsRecordCount = 0;
  let candidateRecordCount = 0;
  let candidatePairRecordCount = 0;
  let transportRecordCount = 0;

  const addProtocol = (value: unknown): void => {
    const item = protocol(value);
    protocolCounts[item] = Math.min(Number.MAX_SAFE_INTEGER, protocolCounts[item] + 1);
  };
  const addCandidate = (value: unknown, candidate: unknown): void => {
    candidateRecordCount = Math.min(Number.MAX_SAFE_INTEGER, candidateRecordCount + 1);
    const item = candidateType(value);
    candidateTypeCounts[item] = Math.min(Number.MAX_SAFE_INTEGER, candidateTypeCounts[item] + 1);
    addProtocol(read(candidate, 'protocol') ?? read(candidate, 'relayProtocol') ?? read(candidate, 'relay_protocol'));
  };
  const addPackets = (value: unknown): void => {
    packetCounters.packetsSent = Math.min(Number.MAX_SAFE_INTEGER, packetCounters.packetsSent + boundedCount(read(value, 'packetsSent') ?? read(value, 'packets_sent')));
    packetCounters.packetsReceived = Math.min(Number.MAX_SAFE_INTEGER, packetCounters.packetsReceived + boundedCount(read(value, 'packetsReceived') ?? read(value, 'packets_received')));
    packetCounters.bytesSent = Math.min(Number.MAX_SAFE_INTEGER, packetCounters.bytesSent + boundedCount(read(value, 'bytesSent') ?? read(value, 'bytes_sent')));
    packetCounters.bytesReceived = Math.min(Number.MAX_SAFE_INTEGER, packetCounters.bytesReceived + boundedCount(read(value, 'bytesReceived') ?? read(value, 'bytes_received')));
  };

  const inspect = (item: unknown): void => {
    statsRecordCount = Math.min(Number.MAX_SAFE_INTEGER, statsRecordCount + 1);
    const union = asRecord(read(item, 'stats'));
    const unionCase = safeLowerEnum(read(union, 'case'));
    const payload = read(union, 'value') ?? item;
    if (unionCase === 'transport') {
      transportRecordCount = Math.min(Number.MAX_SAFE_INTEGER, transportRecordCount + 1);
      const transport = read(payload, 'transport') ?? payload;
      addProtocol(read(transport, 'protocol') ?? read(transport, 'iceProtocol') ?? read(transport, 'ice_protocol'));
      addPackets(transport);
      return;
    }
    if (unionCase === 'candidate-pair' || unionCase === 'candidatepair') {
      candidatePairRecordCount = Math.min(Number.MAX_SAFE_INTEGER, candidatePairRecordCount + 1);
      addPackets(read(payload, 'candidatePair') ?? read(payload, 'candidate_pair') ?? payload);
      return;
    }
    if (unionCase === 'local-candidate' || unionCase === 'localcandidate' || unionCase === 'remote-candidate' || unionCase === 'remotecandidate') {
      const candidate = read(payload, 'candidate') ?? payload;
      addCandidate(read(candidate, 'candidateType') ?? read(candidate, 'candidate_type'), candidate);
      return;
    }

    const type = safeLowerEnum(read(item, 'type') ?? read(item, 'kind'));
    if (type === 'transport' || type === 'transport-stats') {
      transportRecordCount = Math.min(Number.MAX_SAFE_INTEGER, transportRecordCount + 1);
      addProtocol(read(item, 'protocol') ?? read(item, 'iceProtocol') ?? read(item, 'ice-protocol'));
      addPackets(item);
    } else if (type === 'candidate-pair' || type === 'candidatepair') {
      candidatePairRecordCount = Math.min(Number.MAX_SAFE_INTEGER, candidatePairRecordCount + 1);
      addPackets(item);
    } else if (type === 'local-candidate' || type === 'remote-candidate' || type === 'candidate') {
      addCandidate(read(item, 'candidateType') ?? read(item, 'candidate-type'), item);
    }
  };

  for (const item of publishers) inspect(item);
  for (const item of subscribers) inspect(item);
  return Object.freeze({
    sampled: true,
    publisherRecordCount: publishers.length,
    subscriberRecordCount: subscribers.length,
    statsRecordCount,
    candidateRecordCount,
    candidatePairRecordCount,
    transportRecordCount,
    protocolCounts: Object.freeze({ ...protocolCounts }),
    candidateTypeCounts: Object.freeze({ ...candidateTypeCounts }),
    packetCounters: Object.freeze({ ...packetCounters }),
    candidatePairClaim: 'not-claimed',
  });
}

function isRoomPort(value: unknown): value is LiveKitCloudRoomPort {
  const record = asRecord(value);
  return record !== undefined && typeof read(record, 'on') === 'function';
}

function statsGetter(value: LiveKitCloudRecoveryStatsPort | (() => Promise<unknown>) | unknown): (() => Promise<unknown>) | undefined {
  if (typeof value === 'function') return value as () => Promise<unknown>;
  const getter = read(value, 'getRtcStats');
  if (typeof getter === 'function') return () => (getter as () => Promise<unknown>).call(value);
  return undefined;
}

/**
 * Passive observer for the SDK's reconnect/disconnect/media event stream.
 * It is deliberately not a recovery controller: a terminal disconnect only
 * emits an owner-bootstrap-required owner-review observation and detaches this
 * observer. It never authorizes bootstrap; explicit Stop cancels it first.
 */
export class LiveKitCloudRecoveryObserver {
  readonly #participant: LiveKitCloudParticipantPort;
  readonly #room: LiveKitCloudRoomPort;
  readonly #nowMs: (() => number) | undefined;
  readonly #onObservation: ((observation: LiveKitCloudRecoveryObservation) => void) | undefined;
  readonly #statsGetter: (() => Promise<unknown>) | undefined;
  readonly #expectedTrackIntent: Partial<LiveKitCloudRecoveryTrackCounters>;
  readonly #listeners = new Map<LiveKitCloudRecoveryEventName, Listener>();
  readonly #seenKeys = new Set<string>();
  readonly #trackIdentity = new WeakMap<object, number>();
  #nextTrackIdentity = 0;
  readonly #observations: LiveKitCloudRecoveryObservation[] = [];
  readonly #eventCounts = new Map<string, number>();
  #trackCounters: LiveKitCloudRecoveryTrackCounters = INITIAL_TRACK_COUNTERS;
  #bindingAnchor: LiveKitCloudParticipantBinding | undefined;
  #bindingConsistent = true;
  #sequence = 0;
  #reconnectStartedAtMs: number | undefined;
  #recoveryCycle = 0;
  #activeRecoveryCycle: number | undefined;
  #active = false;
  #closed = false;
  #terminal = false;
  #status: LiveKitCloudRecoveryObserverSnapshot['status'] = 'idle';
  #participantUnregister: (() => void) | undefined;

  constructor(
    participant: LiveKitCloudParticipantPort,
    roomOrOptions?: LiveKitCloudRoomPort | LiveKitCloudRecoveryObserverOptions | LiveKitCloudRecoveryStatsPort,
    maybeOptions: LiveKitCloudRecoveryObserverOptions = {},
  ) {
    if (participant === null || typeof participant.snapshot !== 'function') {
      throw new Error('LIVEKIT_RECOVERY_OBSERVER_PARTICIPANT_INVALID');
    }
    const directStatsPort = !isRoomPort(roomOrOptions)
      && roomOrOptions !== undefined
      && typeof read(roomOrOptions, 'getRtcStats') === 'function'
      ? roomOrOptions as LiveKitCloudRecoveryStatsPort
      : undefined;
    const options: LiveKitCloudRecoveryObserverOptions = isRoomPort(roomOrOptions)
      ? maybeOptions
      : (directStatsPort === undefined
        ? ((roomOrOptions as LiveKitCloudRecoveryObserverOptions | undefined) ?? maybeOptions)
        : { ...maybeOptions, statsPort: directStatsPort });
    const room = isRoomPort(roomOrOptions)
      ? roomOrOptions
      : options.room ?? participant.roomPort;
    if (!isRoomPort(room)) throw new Error('LIVEKIT_RECOVERY_OBSERVER_ROOM_PORT_INVALID');
    this.#participant = participant;
    this.#room = room;
    this.#nowMs = options.nowMs;
    this.#onObservation = options.onObservation;
    this.#expectedTrackIntent = Object.freeze({ ...(options.expectedTrackIntent ?? {}) });
    this.#statsGetter = statsGetter(options.statsPort) ?? statsGetter(room);
    this.#bindingAnchor = this.#readBinding();
    if (options.autoStart !== false) this.start();
  }

  get active(): boolean {
    return this.#active;
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  start(): void {
    if (this.#closed) throw new Error('LIVEKIT_RECOVERY_OBSERVER_CLOSED');
    if (this.#active) return;
    if (this.#terminal) return;
    this.#active = true;
    this.#status = 'observing';
    for (const event of EVENT_NAMES) {
      const listener: Listener = (...args) => {
        try { this.#consume(event, args); } catch { /* observation cannot poison the SDK event loop */ }
      };
      this.#listeners.set(event, listener);
      try {
        this.#room.on?.(event, listener);
      } catch {
        this.#listeners.delete(event);
      }
    }
    if (this.#participant.registerRecoveryObserver !== undefined) {
      try {
        this.#participantUnregister = this.#participant.registerRecoveryObserver(() => this.close());
      } catch {
        this.#participantUnregister = undefined;
      }
    }
  }

  stop(): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#active = false;
    if (!this.#terminal) this.#status = 'closed';
    const unregister = this.#participantUnregister;
    this.#participantUnregister = undefined;
    try { unregister?.(); } catch { /* cleanup is idempotent and best effort */ }
    this.#detachListeners();
  }

  dispose(): void {
    this.close();
  }

  observations(): readonly LiveKitCloudRecoveryObservation[] {
    return Object.freeze([...this.#observations]);
  }

  snapshot(): LiveKitCloudRecoveryObserverSnapshot {
    const binding = bindingSummary(this.#readBinding(), this.#bindingConsistent);
    return Object.freeze({
      active: this.#active,
      closed: this.#closed,
      terminal: this.#terminal,
      status: this.#status,
      sequence: this.#sequence,
      observations: Object.freeze([...this.#observations]),
      eventCounts: Object.freeze(Object.fromEntries(this.#eventCounts.entries())),
      trackCounters: this.#trackCounters,
      recoveryCycle: this.#recoveryCycle,
      binding,
    });
  }

  /** Sample SDK getRtcStats through an injected port and redact immediately. */
  async sampleStats(): Promise<LiveKitCloudRecoveryObservation | undefined> {
    if (!this.#active || this.#statsGetter === undefined) return undefined;
    const observedAtMs = finiteNow(this.#nowMs);
    let raw: unknown;
    try {
      raw = await this.#statsGetter();
    } catch {
      if (!this.#active) return undefined;
      return this.#record('stats', 'stats-sample-failed', false, observedAtMs, { statsError: 'unavailable' });
    }
    if (!this.#active) return undefined;
    try {
      const stats = statsSummary(raw);
      return this.#record('stats', 'stats-sampled', false, observedAtMs, { stats });
    } catch {
      return this.#record('stats', 'stats-sample-failed', false, observedAtMs, { statsError: 'invalid' });
    }
  }

  sample(): Promise<LiveKitCloudRecoveryObservation | undefined> {
    return this.sampleStats();
  }

  #consume(event: LiveKitCloudRecoveryEventName, args: readonly unknown[]): void {
    if (!this.#active) return;
    const observedAtMs = finiteNow(this.#nowMs);
    switch (event) {
      case 'connected':
        this.#record(event, 'connected', this.#duplicate(event), observedAtMs);
        return;
      case 'reconnecting': {
        const duplicate = this.#activeRecoveryCycle !== undefined;
        if (!duplicate) {
          this.#recoveryCycle += 1;
          this.#activeRecoveryCycle = this.#recoveryCycle;
          this.#reconnectStartedAtMs = observedAtMs;
          this.#status = 'reconnecting';
        }
        this.#record(event, 'reconnecting', duplicate, observedAtMs, { recoveryCycle: this.#activeRecoveryCycle ?? this.#recoveryCycle });
        return;
      }
      case 'reconnected': {
        const duplicate = this.#activeRecoveryCycle === undefined;
        const recoveryCycle = this.#activeRecoveryCycle ?? this.#recoveryCycle;
        let recoveryElapsedMs: number | undefined;
        if (!duplicate) {
          this.#status = 'reconnected';
          if (this.#reconnectStartedAtMs !== undefined) {
            recoveryElapsedMs = Math.max(0, observedAtMs - this.#reconnectStartedAtMs);
          }
          this.#reconnectStartedAtMs = undefined;
          this.#activeRecoveryCycle = undefined;
        }
        this.#record(event, 'reconnected', duplicate, observedAtMs, {
          recoveryCycle,
          ...(recoveryElapsedMs === undefined ? {} : { recoveryElapsedMs }),
        });
        return;
      }
      case 'disconnected': {
        const duplicate = this.#duplicate(event);
        if (duplicate) return;
        this.#terminal = true;
        this.#status = 'terminal-disconnected';
        const reason = disconnectReason(args[0]);
        if (reason.classification === 'client-initiated') {
          this.#record(event, 'client-disconnected', false, observedAtMs, { disconnectReason: reason });
        } else {
          this.#record(event, 'owner-bootstrap-required', false, observedAtMs, {
            disconnectReason: reason,
            ownerAuthorityCheckRequired: true,
            bootstrapAuthorized: false,
            ownerBootstrapRequired: true,
          });
        }
        this.#active = false;
        this.#detachAndUnregister();
        return;
      }
      case 'connectionQualityChanged':
        this.#record(event, 'connection-quality-changed', this.#duplicate(event, quality(args[0])), observedAtMs, {
          connectionQuality: quality(args[0]),
        });
        return;
      case 'connectionStateChanged':
        this.#record(event, 'connection-state-changed', this.#duplicate(event, connectionState(args[0])), observedAtMs, {
          connectionState: connectionState(args[0]),
        });
        return;
      case 'encryptionError':
        this.#record(event, 'encryption-error', this.#duplicate(event), observedAtMs);
        return;
      case 'localTrackPublished':
        this.#track(event, 'local-track-published', 'local-publish', 'localPublished', args, observedAtMs);
        return;
      case 'localTrackUnpublished':
        this.#track(event, 'local-track-unpublished', 'local-publish', 'localUnpublished', args, observedAtMs);
        return;
      case 'localTrackRepublished':
        this.#track(event, 'local-track-republished', 'local-publish', 'localRepublished', args, observedAtMs);
        return;
      case 'localTrackSubscribed':
        this.#track(event, 'local-track-subscribed', 'local-subscribe', 'localSubscribed', args, observedAtMs);
        return;
      case 'trackSubscribed':
        this.#track(event, 'track-subscribed', 'remote-subscribe', 'remoteSubscribed', args, observedAtMs);
        return;
      case 'trackUnsubscribed':
        this.#track(event, 'track-unsubscribed', 'remote-unsubscribe', 'remoteUnsubscribed', args, observedAtMs);
        return;
    }
  }

  #track(
    event: LiveKitCloudRecoveryEventName,
    kind: LiveKitCloudRecoveryObservationKind,
    direction: LiveKitCloudRecoveryTrackIntent['direction'],
    counter: TrackCounterName | undefined,
    args: readonly unknown[],
    observedAtMs: number,
  ): void {
    const intentBase = trackFromArgs(args, event);
    const intent = Object.freeze({ ...intentBase, direction });
    const target = trackTarget(args, event);
    let identity: string | undefined;
    if ((typeof target === 'object' && target !== null) || typeof target === 'function') {
      const object = target as object;
      let id = this.#trackIdentity.get(object);
      if (id === undefined) {
        id = ++this.#nextTrackIdentity;
        this.#trackIdentity.set(object, id);
      }
      identity = `track-${id}`;
    }
    const key = identity === undefined
      ? undefined
      : `${event}:${identity}:cycle-${this.#activeRecoveryCycle ?? this.#recoveryCycle}`;
    const duplicate = key === undefined ? false : this.#seenKeys.has(key);
    if (!duplicate && identity !== undefined) {
      const cycle = this.#activeRecoveryCycle ?? this.#recoveryCycle;
      if (event === 'localTrackUnpublished') this.#seenKeys.delete(`localTrackPublished:${identity}:cycle-${cycle}`);
      if (event === 'trackUnsubscribed') this.#seenKeys.delete(`trackSubscribed:${identity}:cycle-${cycle}`);
      this.#seenKeys.add(key!);
    }
    if (!duplicate && counter !== undefined) {
      this.#trackCounters = Object.freeze({
        ...this.#trackCounters,
        [counter]: this.#trackCounters[counter] + 1,
      });
    }
    const expected = counter === undefined ? undefined : this.#expectedTrackIntent[counter];
    const current = counter === undefined ? undefined : this.#trackCounters[counter];
    const trackIntentDifference = expected === undefined
      ? undefined
      : (current ?? 0) - expected;
    this.#record(event, kind, duplicate, observedAtMs, {
      trackIntent: intent,
      trackCounters: this.#trackCounters,
      ...(trackIntentDifference === undefined ? {} : { trackIntentDifference }),
    });
  }

  #record(
    event: LiveKitCloudRecoveryObservation['event'],
    kind: LiveKitCloudRecoveryObservationKind,
    duplicate: boolean,
    observedAtMs: number,
    extra: Partial<LiveKitCloudRecoveryObservation> = {},
  ): LiveKitCloudRecoveryObservation {
    const snapshot = this.#safeParticipantSnapshot();
    const binding = this.#readBinding();
    if (this.#bindingAnchor === undefined && binding !== undefined) this.#bindingAnchor = binding;
    this.#bindingConsistent = this.#bindingConsistent && bindingsSame(this.#bindingAnchor, binding);
    const summary = bindingSummary(binding, this.#bindingConsistent);
    const base: LiveKitCloudRecoveryObservation = {
      sequence: ++this.#sequence,
      observedAtMs,
      event,
      kind,
      duplicate,
      passive: true,
      connected: snapshot.connected,
      transportState: snapshot.transportState,
      ...(snapshot.connectionEpoch === undefined ? {} : { connectionEpoch: snapshot.connectionEpoch }),
      binding: summary,
      ...extra,
    };
    const observation = Object.freeze(base);
    this.#observations.push(observation);
    const countKey = kind;
    this.#eventCounts.set(countKey, (this.#eventCounts.get(countKey) ?? 0) + 1);
    try { this.#onObservation?.(observation); } catch { /* observer callback cannot alter participant state */ }
    return observation;
  }

  #duplicate(event: string, suffix = ''): boolean {
    return this.#duplicateKey(`${event}:${suffix}`);
  }

  #duplicateKey(key: string): boolean {
    if (this.#seenKeys.has(key)) return true;
    this.#seenKeys.add(key);
    return false;
  }

  #safeParticipantSnapshot(): LiveKitCloudParticipantSnapshot {
    try {
      return this.#participant.snapshot();
    } catch {
      return Object.freeze({ connected: false, transportState: 'disconnected' });
    }
  }

  #readBinding(): LiveKitCloudParticipantBinding | undefined {
    try {
      return this.#participant.bindingSnapshot?.();
    } catch {
      return undefined;
    }
  }

  #detachAndUnregister(): void {
    const unregister = this.#participantUnregister;
    this.#participantUnregister = undefined;
    try { unregister?.(); } catch { /* best effort */ }
    this.#detachListeners();
  }

  #detachListeners(): void {
    for (const [event, listener] of this.#listeners) {
      try {
        if (typeof this.#room.off === 'function') this.#room.off(event, listener);
        else this.#room.removeListener?.(event, listener);
      } catch {
        // Some injected ports expose only on/removeAllListeners; inactive
        // guards still prevent stale callbacks from changing state.
      }
    }
    this.#listeners.clear();
  }
}

export const createLiveKitCloudRecoveryObserver = (
  participant: LiveKitCloudParticipantPort,
  roomOrOptions?: LiveKitCloudRoomPort | LiveKitCloudRecoveryObserverOptions | LiveKitCloudRecoveryStatsPort,
  options?: LiveKitCloudRecoveryObserverOptions,
): LiveKitCloudRecoveryObserver => new LiveKitCloudRecoveryObserver(participant, roomOrOptions, options);

export const LiveKitCloudSdkRecoveryObserver = LiveKitCloudRecoveryObserver;
