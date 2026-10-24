import { createHash } from 'node:crypto';
import { createGatewayRoom } from './sdk-room.ts';
import type { LocalParticipant, Room, RoomOptions, RemoteParticipant } from '@livekit/rtc-node';
import {
  assertCanonicalLiveKitCloudProjectUrl,
  assertCanonicalLiveKitApiUrl,
  type LiveKitCloudGrantInput,
} from './livekit-cloud-token-signer.ts';
import {
  LiveKitCloudRecoveryObserver,
  type LiveKitCloudRecoveryObserverOptions,
} from './livekit-cloud-recovery-observer.ts';

export interface LiveKitCloudParticipantBinding {
  readonly realtimeSessionRef: unknown;
  readonly deviceLeaseRef: unknown;
  readonly continuityId: unknown;
  readonly transportAliases: readonly unknown[];
  readonly connectionEpoch: string;
}

export interface LiveKitCloudParticipantConnectInput {
  readonly projectUrl: string;
  readonly roomName: string;
  readonly identity: string;
  readonly token: string;
  readonly grants: LiveKitCloudGrantInput;
  readonly roomOptions: RoomOptions | object;
  readonly binding: LiveKitCloudParticipantBinding;
}

export interface LiveKitCloudParticipantSnapshot {
  /** SDK connection ownership; consumers use admission for media readiness. */
  readonly connected: boolean;
  readonly transportState: LiveKitCloudParticipantTransportState;
  readonly projectUrl?: string;
  readonly roomName?: string;
  readonly identity?: string;
  readonly connectionEpoch?: string;
}

export type LiveKitCloudParticipantTransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'reconnected'
  | 'encryption_error';

export interface LiveKitCloudRoomPort {
  connect(projectUrl: string, token: string, roomOptions?: object): Promise<void>;
  disconnect(): Promise<void>;
  /** Exposed only for owner-bound local media cleanup; it is never a wire port. */
  readonly localParticipant?: {
    readonly streamBytes?: LocalParticipant['streamBytes'];
    readonly sendText?: LocalParticipant['sendText'];
    readonly trackPublications?: ReadonlyMap<string, unknown>;
    readonly unpublishTrack?: (trackSid: string, stopOnUnpublish?: boolean) => Promise<void>;
    /** Same-room directed assistant output; the SDK uses snake_case options. */
    readonly publishData?: (
      data: Uint8Array,
      options: Readonly<{
        readonly reliable?: boolean;
        readonly destination_identities?: readonly string[];
        readonly topic?: string;
      }>,
    ) => Promise<void>;
  };
  /** Current public SDK subscriptions, needed when connect completes before source setup. */
  readonly remoteParticipants?: ReadonlyMap<string, Pick<RemoteParticipant,'identity'|'trackPublications'>>;
  readonly isConnected?: boolean;
  readonly registerByteStreamHandler?: Room['registerByteStreamHandler'];
  readonly unregisterByteStreamHandler?: Room['unregisterByteStreamHandler'];
  on?(event: string, listener: (...args: readonly unknown[]) => void): void;
  off?(event: string, listener: (...args: readonly unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): void;
  getRtcStats?(): Promise<unknown>;
  removeAllListeners?(): void;
}

export type LiveKitCloudReconnectAdmissionGuard = (
  binding: LiveKitCloudParticipantBinding,
) => Promise<void>;

export interface LiveKitCloudParticipantPort {
  connect(input: LiveKitCloudParticipantConnectInput): Promise<void>;
  disconnect(): Promise<void>;
  snapshot(): LiveKitCloudParticipantSnapshot;
  /** Same-room internal publisher; key lifetime remains owned by the bootstrap envelope. */
  withEncryptionKey?<T>(use:(key:Uint8Array)=>Promise<T>):Promise<T>;
  close(): Promise<void>;
  readonly roomPort?: LiveKitCloudRoomPort;
  /** Current SDK generation; retired generations stay closed, including work already encoding a frame. */
  readonly admission?: Readonly<{ admitted: boolean; promise: Promise<boolean> }>;
  /** Owner-bound local track cleanup; absent ports are rejected by production cleanup composition. */
  readonly unpublishAllTracks?: () => Promise<void>;
  /** Verifies the local SDK participant and its owned publications are closed. */
  readonly verifyClosed?: () => Promise<void>;
  /** Installs one owner fence checked before an SDK reconnect is admitted. */
  readonly setReconnectAdmissionGuard?: (guard: LiveKitCloudReconnectAdmissionGuard) => void;
  bindingSnapshot?(): LiveKitCloudParticipantBinding | undefined;
  registerRecoveryObserver?(cancel: () => void): () => void;
  createRecoveryObserver?(options?: LiveKitCloudRecoveryObserverOptions): LiveKitCloudRecoveryObserver;
}

// Room-only consumers borrow the participant's latch, without owning a second admission state.
const roomParticipants = new WeakMap<object, LiveKitCloudParticipant>();
export const liveKitCloudRoomAdmission = (room: object | undefined) =>
  room === undefined ? undefined : roomParticipants.get(room)?.admission;

export class LiveKitCloudParticipantError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LiveKitCloudParticipantError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new LiveKitCloudParticipantError(code);
}

function assertIdentifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail(code);
  return value;
}

function assertToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || /[\u0000-\u001f\u007f\s]/u.test(value)) {
    fail('LIVEKIT_PARTICIPANT_TOKEN_INVALID');
  }
  return value;
}

function assertBinding(value: LiveKitCloudParticipantBinding): LiveKitCloudParticipantBinding {
  if (
    value === null || typeof value !== 'object' ||
    value.realtimeSessionRef === undefined || value.deviceLeaseRef === undefined ||
    value.continuityId === undefined || !Array.isArray(value.transportAliases) ||
    value.transportAliases.length === 0 || typeof value.connectionEpoch !== 'string' ||
    !/^[1-9][0-9]{0,37}$/u.test(value.connectionEpoch)
  ) fail('LIVEKIT_PARTICIPANT_BINDING_INVALID');
  return Object.freeze({ ...value, transportAliases: Object.freeze([...value.transportAliases]) });
}

function defaultRoom(): LiveKitCloudRoomPort {
  return createGatewayRoom() as unknown as LiveKitCloudRoomPort;
}

interface ValidatedConnectInput {
  readonly projectUrl: string;
  readonly roomName: string;
  readonly identity: string;
  readonly token: string;
  readonly grants: LiveKitCloudGrantInput;
  readonly roomOptions: RoomOptions | object;
  readonly binding: LiveKitCloudParticipantBinding;
}

interface PreparedConnectInput extends ValidatedConnectInput {
  readonly fingerprint: string;
}

interface ConnectFlight {
  readonly generation: number;
  readonly prepared: PreparedConnectInput;
  readonly promise: Promise<void>;
}

type SdkListener = (...args: readonly unknown[]) => void;

interface FingerprintContext {
  readonly opaqueIdentities: WeakMap<object, number>;
  readonly symbolIdentities: Map<symbol, number>;
  nextOpaqueIdentity: number;
  nextSymbolIdentity: number;
  invalid: boolean;
}

function digestString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function opaqueIdentity(value: object, context: FingerprintContext): string {
  let identity = context.opaqueIdentities.get(value);
  if (identity === undefined) {
    identity = ++context.nextOpaqueIdentity;
    context.opaqueIdentities.set(value, identity);
  }
  return `opaque-${identity}`;
}

function symbolIdentity(value: symbol, context: FingerprintContext): string {
  let identity = context.symbolIdentities.get(value);
  if (identity === undefined) {
    identity = ++context.nextSymbolIdentity;
    context.symbolIdentities.set(value, identity);
  }
  return `symbol-${identity}`;
}

function fingerprintValue(
  value: unknown,
  context: FingerprintContext,
  seen = new Map<object, number>(),
): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `string-${digestString(value)}`;
  if (typeof value === 'boolean') return value ? 'boolean-1' : 'boolean-0';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number-nan';
    if (Object.is(value, -0)) return 'number-negative-zero';
    return `number-${digestString(String(value))}`;
  }
  if (typeof value === 'bigint') return `bigint-${digestString(value.toString())}`;
  if (typeof value === 'symbol') return symbolIdentity(value, context);
  if (typeof value === 'function') return opaqueIdentity(value, context);

  const object = value as object;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(object) as object | null;
  } catch {
    context.invalid = true;
    return 'invalid-prototype';
  }
  const isArray = Array.isArray(object);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return opaqueIdentity(object, context);
  if (isArray && prototype !== Array.prototype) return opaqueIdentity(object, context);
  const prior = seen.get(object);
  if (prior !== undefined) return `ref-${prior}`;
  const node = seen.size + 1;
  seen.set(object, node);

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(object);
  } catch {
    context.invalid = true;
    return 'invalid-descriptors';
  }
  const keys = Reflect.ownKeys(descriptors).sort((left, right) => String(left).localeCompare(String(right)));
  const parts: string[] = [];
  for (const key of keys) {
    const descriptor = descriptors[key as keyof PropertyDescriptorMap];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
      || !Object.hasOwn(descriptor, 'value')) {
      context.invalid = true;
      return 'invalid-accessor';
    }
    const keyDescriptor = typeof key === 'string' ? `key-${digestString(key)}` : symbolIdentity(key, context);
    parts.push(`${keyDescriptor}=${fingerprintValue(descriptor.value, context, seen)}`);
  }
  return `${isArray ? 'array' : 'record'}-${node}[${parts.join(',')}]`;
}

function connectFingerprint(input: ValidatedConnectInput, context: FingerprintContext): string | undefined {
  context.invalid = false;
  const fields: readonly [string, unknown][] = [
    ['projectUrl', input.projectUrl],
    ['roomName', input.roomName],
    ['identity', input.identity],
    ['token', input.token],
    ['grants', input.grants],
    ['roomOptions', input.roomOptions],
    ['binding', input.binding],
  ];
  const descriptor = fields
    .map(([name, value]) => `${digestString(name)}=${fingerprintValue(value, context)}`)
    .join('|');
  return context.invalid ? undefined : digestString(descriptor);
}

/**
 * Gateway-owned LiveKit Cloud participant. It has no listener and no public
 * transport. It represents one active T11B DeviceLease at a time; a different
 * session/lease/epoch fails closed instead of silently joining a second room.
 * The token and RoomOptions are caller-owned and are not persisted.
 */
export class LiveKitCloudParticipant implements LiveKitCloudParticipantPort {
  readonly #room: LiveKitCloudRoomPort;
  readonly #signalingUrl: string | undefined;
  #closed = false;
  #connected = false;
  #binding: LiveKitCloudParticipantBinding | undefined;
  #projectUrl: string | undefined;
  #roomName: string | undefined;
  #identity: string | undefined;
  #transportState: LiveKitCloudParticipantTransportState = 'disconnected';
  #generation = 0;
  #activeGeneration: number | undefined;
  #connectFlight: ConnectFlight | undefined;
  #connectedFingerprint: string | undefined;
  #roomOptions: object | undefined;
  #disconnectFlight: Promise<void> | undefined;
  #reconnectAdmissionGuard: LiveKitCloudReconnectAdmissionGuard | undefined;
  #reconnectAdmissionFlight: Promise<void> | undefined;
  #admission = { ...Promise.withResolvers<boolean>(), admitted: false };
  #lastBinding: LiveKitCloudParticipantBinding | undefined;
  readonly #recoveryObserverCancels = new Set<() => void>();
  readonly #sdkListeners = new Map<string, SdkListener>();
  readonly #fingerprintContext: FingerprintContext = {
    opaqueIdentities: new WeakMap<object, number>(),
    symbolIdentities: new Map<symbol, number>(),
    nextOpaqueIdentity: 0,
    nextSymbolIdentity: 0,
    invalid: false,
  };

  constructor(room: LiveKitCloudRoomPort = defaultRoom(), apiUrl?: string) {
    this.#signalingUrl = apiUrl === undefined ? undefined : assertCanonicalLiveKitApiUrl(apiUrl).replace(/^http/u, 'ws');
    if (room === null || typeof room.connect !== 'function' || typeof room.disconnect !== 'function') {
      fail('LIVEKIT_PARTICIPANT_ROOM_PORT_INVALID');
    }
    this.#room = room;
    roomParticipants.set(room, this);
    this.#addSdkListener('reconnecting', () => {
      if (!this.#sdkEventLive() || !this.#connected) return;
      this.#resetAdmission();
      this.#transportState = 'reconnecting';
    });
    this.#addSdkListener('reconnected', () => {
      if (!this.#sdkEventLive() || !this.#connected || this.#reconnectAdmissionFlight) return;
      if (this.#admission.admitted) this.#resetAdmission();
      this.#transportState = 'reconnecting';
      const guard = this.#reconnectAdmissionGuard;
      if (guard === undefined) return;
      const admission = this.#admission;
      let flight: Promise<void> | undefined;
      flight = (async (): Promise<void> => {
        try {
          await guard(this.#binding!);
          if (this.#sdkEventLive() && this.#admission === admission) {
            this.#admit();
            this.#transportState = 'reconnected';
          }
        } catch {
          if (!this.#sdkEventLive() || this.#admission !== admission) return;
          try { await this.disconnect(); } catch { /* the state fence remains closed */ }
        } finally {
          if (this.#reconnectAdmissionFlight === flight) this.#reconnectAdmissionFlight = undefined;
        }
      })();
      this.#reconnectAdmissionFlight = flight;
      void flight.catch(() => undefined);
    });
    this.#addSdkListener('disconnected', () => {
      if (this.#closed || this.#activeGeneration === undefined || this.#activeGeneration !== this.#generation) return;
      this.#generation += 1;
      this.#clearConnectionState();
    });
    this.#addSdkListener('encryptionError', () => {
      if (!this.#sdkEventLive()) return;
      this.#transportState = 'encryption_error';
    });
  }

  #addSdkListener(event: string, listener: SdkListener): void {
    try {
      this.#room.on?.(event, listener);
      this.#sdkListeners.set(event, listener);
    } catch {
      // An injected room with a broken event seam cannot affect connect state.
    }
  }

  /**
   * rtc-node's Room.disconnect() ends with removeAllListeners(), whoever calls it (this participant, or a consumer
   * leaving the room directly). This participant reuses its room for every connect, so it re-arms its own listeners
   * per connect; otherwise the next room loss goes unobserved and snapshot() keeps reporting a room that is gone.
   */
  #armSdkListeners(): void {
    for (const [event, listener] of this.#sdkListeners) {
      try {
        if (typeof this.#room.off === 'function') this.#room.off(event, listener);
        else if (typeof this.#room.removeListener === 'function') this.#room.removeListener(event, listener);
        else continue;
        this.#room.on?.(event, listener);
      } catch {
        // As in #addSdkListener: a broken event seam cannot affect connect state.
      }
    }
  }

  #removeSdkListeners(): void {
    for (const [event, listener] of this.#sdkListeners) {
      try {
        if (typeof this.#room.off === 'function') this.#room.off(event, listener);
        else this.#room.removeListener?.(event, listener);
      } catch {
        // close still fences late handlers through #closed/#activeGeneration.
      }
    }
    this.#sdkListeners.clear();
  }

  #sdkEventLive(): boolean {
    return !this.#closed && this.#activeGeneration !== undefined && this.#activeGeneration === this.#generation;
  }

  get admission(): Readonly<{ admitted: boolean; promise: Promise<boolean> }> { return this.#admission; }

  #closeAdmission(): void {
    this.#admission.admitted = false;
    this.#admission.resolve(false);
  }

  #resetAdmission(): void {
    this.#closeAdmission();
    this.#admission = { ...Promise.withResolvers<boolean>(), admitted: false };
    this.#reconnectAdmissionFlight = undefined;
  }

  #admit(): void {
    this.#admission.admitted = true;
    this.#admission.resolve(true);
  }

  /** The SDK room is an internal observation seam; it is never a wire port. */
  get roomPort(): LiveKitCloudRoomPort {
    return this.#room;
  }

  /**
   * Returns the active binding, or the last owner binding while the SDK is
   * terminally disconnected.  The latter lets a passive observer preserve
   * the session/lease/epoch association without inventing a recovery bind.
   */
  bindingSnapshot(): LiveKitCloudParticipantBinding | undefined {
    const binding = this.#binding ?? this.#lastBinding;
    if (binding === undefined) return undefined;
    return Object.freeze({ ...binding, transportAliases: Object.freeze([...binding.transportAliases]) });
  }

  /** Register a cancellation hook owned by an internal observer. */
  registerRecoveryObserver(cancel: () => void): () => void {
    if (typeof cancel !== 'function') fail('LIVEKIT_PARTICIPANT_OBSERVER_INVALID');
    if (this.#closed) {
      try { cancel(); } catch { /* observer cleanup is best effort after close */ }
      return () => {};
    }
    this.#recoveryObserverCancels.add(cancel);
    return () => { this.#recoveryObserverCancels.delete(cancel); };
  }

  /** Unpublish every currently-owned local SDK track and verify the map is empty. */
  async unpublishAllTracks(): Promise<void> {
    if (this.#closed) fail('LIVEKIT_PARTICIPANT_CLOSED');
    const local = this.#room.localParticipant;
    if (local === undefined || local.trackPublications === undefined || typeof local.unpublishTrack !== 'function') {
      fail('LIVEKIT_PARTICIPANT_LOCAL_MEDIA_UNAVAILABLE');
    }
    const trackSids = [...local.trackPublications.keys()].sort();
    for (const trackSid of trackSids) {
      if (typeof trackSid !== 'string' || trackSid.length === 0) fail('LIVEKIT_PARTICIPANT_TRACK_PUBLICATION_INVALID');
      await local.unpublishTrack(trackSid, true);
    }
    if (local.trackPublications.size !== 0) fail('LIVEKIT_PARTICIPANT_TRACKS_REMAIN');
  }

  /** Verify the local participant is closed without requiring a room deletion. */
  async verifyClosed(): Promise<void> {
    const snapshot = this.snapshot();
    if (snapshot.connected !== false || snapshot.transportState !== 'disconnected' || this.#room.isConnected === true) {
      fail('LIVEKIT_PARTICIPANT_CLOSURE_UNVERIFIED');
    }
    const local = this.#room.localParticipant;
    if (local?.trackPublications !== undefined && local.trackPublications.size !== 0) {
      fail('LIVEKIT_PARTICIPANT_TRACKS_REMAIN');
    }
  }

  setReconnectAdmissionGuard(guard: LiveKitCloudReconnectAdmissionGuard): void {
    if (this.#closed) fail('LIVEKIT_PARTICIPANT_CLOSED');
    if (typeof guard !== 'function') fail('LIVEKIT_PARTICIPANT_RECONNECT_GUARD_INVALID');
    if (this.#reconnectAdmissionGuard !== undefined && this.#reconnectAdmissionGuard !== guard) {
      fail('LIVEKIT_PARTICIPANT_RECONNECT_GUARD_ALREADY_BOUND');
    }
    this.#reconnectAdmissionGuard = guard;
  }

  createRecoveryObserver(options: LiveKitCloudRecoveryObserverOptions = {}): LiveKitCloudRecoveryObserver {
    return new LiveKitCloudRecoveryObserver(this, options);
  }

  connect(input: LiveKitCloudParticipantConnectInput): Promise<void> {
    if (this.#closed) return Promise.reject(new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_CLOSED'));
    let validated: ValidatedConnectInput;
    try {
      if (input === null || typeof input !== 'object') fail('LIVEKIT_PARTICIPANT_INPUT_INVALID');
      const projectUrl = assertCanonicalLiveKitCloudProjectUrl(input.projectUrl);
      const roomName = assertIdentifier(input.roomName, 'LIVEKIT_PARTICIPANT_ROOM_INVALID');
      const identity = assertIdentifier(input.identity, 'LIVEKIT_PARTICIPANT_IDENTITY_INVALID');
      const token = assertToken(input.token);
      const binding = assertBinding(input.binding);
      const encryptionDescriptor = input.roomOptions !== null && typeof input.roomOptions === 'object'
        ? Object.getOwnPropertyDescriptor(input.roomOptions, 'encryption')
        : undefined;
      if (
        input.roomOptions === null || typeof input.roomOptions !== 'object' ||
        Array.isArray(input.roomOptions) || encryptionDescriptor === undefined
        || encryptionDescriptor.get !== undefined || encryptionDescriptor.set !== undefined
        || encryptionDescriptor.value === null || typeof encryptionDescriptor.value !== 'object'
        || Array.isArray(encryptionDescriptor.value)
      ) fail('LIVEKIT_E2EE_OPTIONS_REQUIRED');
      if (input.grants.room !== roomName || input.grants.roomJoin !== true) {
        fail('LIVEKIT_PARTICIPANT_GRANTS_INVALID');
      }
      validated = Object.freeze({
        projectUrl,
        roomName,
        identity,
        token,
        grants: input.grants,
        roomOptions: input.roomOptions,
        binding,
      });
      const fingerprint = connectFingerprint(validated, this.#fingerprintContext);
      if (fingerprint === undefined) fail('LIVEKIT_PARTICIPANT_PROVENANCE_INVALID');
      const prepared: PreparedConnectInput = Object.freeze({ ...validated, fingerprint });

      if (this.#disconnectFlight !== undefined) {
        return Promise.reject(new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_DISCONNECT_IN_PROGRESS'));
      }
      const existingFlight = this.#connectFlight;
      if (existingFlight !== undefined) {
        if (existingFlight.prepared.fingerprint === prepared.fingerprint) return existingFlight.promise;
        return Promise.reject(new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_CONNECT_FLIGHT_CONFLICT'));
      }
      if (this.#connected) {
        if (this.#connectedFingerprint === prepared.fingerprint) return Promise.resolve();
        return Promise.reject(new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_BINDING_CONFLICT'));
      }

      const generation = ++this.#generation;
      this.#activeGeneration = generation;
      this.#resetAdmission();
      this.#armSdkListeners();
      const promise = this.#runConnect(prepared, generation);
      const flight = { generation, prepared, promise } satisfies ConnectFlight;
      this.#connectFlight = flight;
      const clear = () => {
        if (this.#connectFlight === flight) this.#connectFlight = undefined;
      };
      void promise.then(clear, clear);
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async #runConnect(prepared: PreparedConnectInput, generation: number): Promise<void> {
    this.#transportState = 'connecting';
    try {
      await this.#room.connect(this.#signalingUrl ?? prepared.projectUrl, prepared.token, prepared.roomOptions);
    } catch {
      if (this.#generation === generation && !this.#closed) this.#clearConnectionState();
      throw new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_CONNECT_FAILED');
    }
    if (this.#closed || this.#generation !== generation) {
      try { await this.#room.disconnect(); } catch { /* late-connect convergence is best effort */ }
      throw new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_CONNECT_CANCELLED');
    }
    this.#projectUrl = prepared.projectUrl;
    this.#roomName = prepared.roomName;
    this.#identity = prepared.identity;
    this.#binding = prepared.binding;
    this.#lastBinding = prepared.binding;
    this.#connectedFingerprint = prepared.fingerprint;
    this.#roomOptions = prepared.roomOptions;
    this.#connected = true;
    this.#admit();
    this.#transportState = 'connected';
  }

  async disconnect(): Promise<void> {
    if (this.#disconnectFlight !== undefined) return this.#disconnectFlight;
    const connectFlight = this.#connectFlight;
    // Invalidate an in-flight connect before any await. A late SDK success
    // must be treated as stale and converged with room.disconnect().
    this.#generation += 1;
    this.#activeGeneration = undefined;
    this.#closeAdmission();
    this.#cancelRecoveryObservers();
    if (connectFlight !== undefined) this.#clearConnectionState();
    this.#disconnectFlight = (async () => {
      if (connectFlight !== undefined) {
        try { await connectFlight.promise; } catch { /* explicit Stop absorbs stale-connect failure */ }
        this.#clearConnectionState();
        return;
      }
      if (!this.#connected) {
        this.#clearConnectionState();
        return;
      }
      // Explicit Stop/close owns the disconnect. Cancel passive observers
      // before entering the SDK so its client-initiated disconnected event
      // cannot be mistaken for a remote terminal recovery signal.
      try {
        await this.#room.disconnect();
      } catch (error) {
        throw new LiveKitCloudParticipantError('LIVEKIT_PARTICIPANT_DISCONNECT_FAILED', {cause:error});
      } finally {
        this.#clearConnectionState();
      }
    })().finally(() => {
      this.#disconnectFlight = undefined;
    });
    return this.#disconnectFlight;
  }

  async withEncryptionKey<T>(use:(key:Uint8Array)=>Promise<T>):Promise<T> {
    const key=(this.#roomOptions as {encryption?:{keyProviderOptions?:{sharedKey?:Uint8Array}}})?.encryption?.keyProviderOptions?.sharedKey;
    if(!this.#admission.admitted||!key)fail('LIVEKIT_PARTICIPANT_KEY_UNAVAILABLE');
    return use(key);
  }

  snapshot(): LiveKitCloudParticipantSnapshot {
    return Object.freeze({
      connected: this.#connected,
      transportState: this.#transportState,
      ...(this.#projectUrl === undefined ? {} : { projectUrl: this.#projectUrl }),
      ...(this.#roomName === undefined ? {} : { roomName: this.#roomName }),
      ...(this.#identity === undefined ? {} : { identity: this.#identity }),
      ...(this.#binding === undefined ? {} : { connectionEpoch: this.#binding.connectionEpoch }),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.disconnect();
    } finally {
      this.#removeSdkListeners();
      this.#room.removeAllListeners?.();
    }
  }

  #clearConnectionState(): void {
    this.#closeAdmission();
    this.#connected = false;
    this.#transportState = 'disconnected';
    this.#activeGeneration = undefined;
    this.#connectedFingerprint = undefined;
    this.#roomOptions = undefined;
    this.#binding = undefined;
    this.#projectUrl = undefined;
    this.#roomName = undefined;
    this.#identity = undefined;
  }

  #cancelRecoveryObservers(): void {
    const cancels = [...this.#recoveryObserverCancels];
    this.#recoveryObserverCancels.clear();
    for (const cancel of cancels) {
      try { cancel(); } catch { /* cleanup must not mask disconnect cleanup */ }
    }
  }
}

export const createLiveKitCloudParticipant = (
  room?: LiveKitCloudRoomPort,
  apiUrl?: string,
): LiveKitCloudParticipant => new LiveKitCloudParticipant(room, apiUrl);
