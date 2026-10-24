import Ajv2020Module, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Phase0DemoSessionController,
  type Phase0CleanupCounts,
  type Phase0OwnerLifecycleKind,
  type Phase0OwnerTerminalRegistration,
} from './phase0-demo-session-controller.ts';
import type { AcceptedDemoEvent } from './demo-state-projector.ts';
import type { HandoffRequest, HandoffResult } from './shared-session-orchestrator.ts';

const SESSION_DURATION_MS = 3_600_000;
const RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS = 86_400_000;
const CLEANUP_GRACE_MS = 5_000;
const TERMINAL_EVENT_TYPES = new Set([
  'paios.phase0.demo.session.ended',
  'paios.phase0.demo.session.cleanup.completed',
]);
const SCOPED = /^[a-z][a-z0-9_-]{2,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IPV4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u;

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const eventSchema = JSON.parse(readFileSync(
  new URL('../../contracts/demo_v0_4/session-event.schema.json', import.meta.url),
  'utf8',
)) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateEvent = ajv.compile(eventSchema) as ValidateFunction<Phase0OwnerEvent>;

export interface Phase0OwnerAuthenticatedIphone {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly credentialId: string;
  readonly capabilitySha256: string;
  readonly sourceIpv4: string;
}

export interface Phase0OwnerEvent extends AcceptedDemoEvent {
  readonly event_id: string;
  readonly trace_id: string;
  readonly expires_at: string;
  readonly origin: AcceptedDemoEvent['origin'] & Readonly<{
    client_instance_id: string;
    relay?: Readonly<{
      device_id: string;
      device_class: 'iphone';
      transport: 'watch_connectivity';
    }>;
  }>;
  readonly connection: Readonly<{
    id: string;
    epoch: number;
    state: 'connected' | 'reconnected' | 'disconnected';
    resumed_from_connection_id?: string;
  }>;
  readonly sequence: Readonly<{
    stream_id: string;
    number: number;
    previous_event_id?: string;
  }>;
  readonly idempotency_key: string;
}

export interface Phase0RayneoOwnerJoin {
  readonly idempotencyKey: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly keyId: string;
  readonly publicKeySpkiSha256: string;
  readonly sourceIpv4: string;
}

export interface Phase0OwnerRegistrationResult {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceClass: 'iphone' | 'apple_watch' | 'rayneo';
  readonly connectionId: string;
  readonly connectionEpoch: 0;
  readonly duplicate: boolean;
}

export type Phase0OwnerTransitionKind =
  | 'session_opened'
  | 'terminal_registered'
  | 'handoff_completed'
  | 'connection_reconnected'
  | Phase0OwnerLifecycleKind;

export interface Phase0OwnerLifecycleTransition {
  readonly revision: number;
  readonly kind: Phase0OwnerTransitionKind;
  readonly sessionId: string;
}

export interface Phase0OwnerSessionSnapshot {
  readonly sessionId: string;
  readonly state: 'live' | 'terminal';
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly cleanupDeadlineAtMs: number;
  readonly registeredDeviceClasses: readonly ('iphone' | 'apple_watch' | 'rayneo')[];
  readonly activeDeviceId?: string;
  readonly activeDeviceLeaseVersion?: number;
  readonly cleanupUncertain: boolean;
}

export interface Phase0OwnerSnapshot {
  readonly revision: number;
  readonly sessions: readonly Phase0OwnerSessionSnapshot[];
}

export interface Phase0SharedSessionOwnerConfig {
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly cleanup?: (sessionId: string) => Phase0CleanupCounts | Promise<Phase0CleanupCounts>;
  readonly setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /** RayNeo standalone only; omission preserves the shared one-hour contract. */
  readonly rayneoStandaloneSessionDurationMs?:
    typeof SESSION_DURATION_MS | typeof RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS;
  /** Deterministic in-memory seam for forcing a transition at the snapshot/subscribe boundary. */
  readonly snapshotSubscribeBoundary?: () => void;
}

interface RegisteredTerminal {
  readonly deviceId: string;
  readonly deviceClass: 'iphone' | 'apple_watch' | 'rayneo';
  readonly clientInstanceId: string;
  connectionId: string;
  connectionEpoch: number;
}

interface OwnerRecord {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly cleanupDeadlineAtMs: number;
  readonly credentialId: string;
  readonly capabilitySha256: string;
  readonly sourceIpv4: string;
  readonly terminals: Map<RegisteredTerminal['deviceClass'], RegisteredTerminal>;
  readonly idempotency: Map<string, { fingerprint: string; result: unknown }>;
  readonly events: Map<string, string>;
  state: 'live' | 'terminal';
  cleanupUncertain: boolean;
  pairingKeyId?: string;
  pairingSpkiSha256?: string;
  timer?: NodeJS.Timeout;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function utcMs(value: unknown): number {
  if (typeof value !== 'string') throw new Error('CONTRACT_REJECTED');
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || new Date(result).toISOString() !== value) throw new Error('CONTRACT_REJECTED');
  return result;
}

function freezeRegistration(result: Omit<Phase0OwnerRegistrationResult, 'duplicate'>, duplicate: boolean): Phase0OwnerRegistrationResult {
  return Object.freeze({ ...result, duplicate });
}

function assertAuth(auth: Phase0OwnerAuthenticatedIphone): void {
  if (
    !SCOPED.test(auth.sessionId) || !SCOPED.test(auth.deviceId) || !SCOPED.test(auth.clientInstanceId) ||
    !SCOPED.test(auth.credentialId) || !SHA256.test(auth.capabilitySha256) || !IPV4.test(auth.sourceIpv4)
  ) throw new Error('DEVICE_ORIGIN_MISMATCH');
}

/** Volatile, same-process owner for the one Phase-0 shared-session authority. */
export class Phase0SharedSessionOwner {
  readonly sessions: Phase0DemoSessionController;
  readonly #now: () => number;
  readonly #randomUuid: () => string;
  readonly #setTimer: NonNullable<Phase0SharedSessionOwnerConfig['setTimer']>;
  readonly #clearTimer: NonNullable<Phase0SharedSessionOwnerConfig['clearTimer']>;
  readonly #rayneoStandaloneSessionDurationMs: number;
  readonly #snapshotSubscribeBoundary: (() => void) | undefined;
  readonly #records = new Map<string, OwnerRecord>();
  readonly #globalIdempotency = new Map<string, { fingerprint: string; result: unknown; sessionId: string }>();
  readonly #consumers = new Set<(transition: Phase0OwnerLifecycleTransition) => void>();
  readonly #cleanupFlights = new Set<Promise<boolean>>();
  readonly #detachControllerObserver: () => void;
  #revision = 0;
  #closed = false;

  constructor(config: Phase0SharedSessionOwnerConfig = {}) {
    this.#now = config.now ?? Date.now;
    this.#randomUuid = config.randomUuid ?? randomUUID;
    this.#setTimer = config.setTimer ?? setTimeout;
    this.#clearTimer = config.clearTimer ?? clearTimeout;
    const rayneoStandaloneSessionDurationMs = config.rayneoStandaloneSessionDurationMs ?? SESSION_DURATION_MS;
    if (rayneoStandaloneSessionDurationMs !== SESSION_DURATION_MS &&
        rayneoStandaloneSessionDurationMs !== RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS) {
      throw new Error('RAYNEO_STANDALONE_SESSION_DURATION_INVALID');
    }
    this.#rayneoStandaloneSessionDurationMs = rayneoStandaloneSessionDurationMs;
    this.#snapshotSubscribeBoundary = config.snapshotSubscribeBoundary;
    this.sessions = new Phase0DemoSessionController({
      now: this.#now, randomUuid: this.#randomUuid,
      ...(config.cleanup === undefined ? {} : { cleanup: config.cleanup }),
    });
    this.#detachControllerObserver = this.sessions.setOwnerLifecycleObserver((kind, sessionId) => {
      const record = this.#records.get(sessionId);
      if (record && (kind === 'session_ended' || kind === 'session_expired' || kind === 'pairing_revoked')) {
        record.state = 'terminal';
        if (record.timer) this.#clearTimer(record.timer);
        delete record.timer;
      }
      if (record && kind === 'cleanup_uncertain') record.cleanupUncertain = true;
      if (record && (kind === 'cleanup_completed' || kind === 'cleanup_uncertain')) this.#purgeRecord(record);
      this.#transition(kind, sessionId);
    });
  }

  get revision(): number { return this.#revision; }

  openFromAuthenticatedIphoneSessionStarted(
    auth: Phase0OwnerAuthenticatedIphone,
    event: Phase0OwnerEvent,
  ): Phase0OwnerRegistrationResult {
    this.#assertOpen();
    assertAuth(auth);
    this.#validateEnvelope(event);
    if (event.event_type !== 'paios.phase0.demo.session.started') throw new Error('CONTRACT_REJECTED');
    const payload = event.payload as Record<string, unknown>;
    const start = utcMs(event.occurred_at);
    const expires = utcMs(payload.session_expires_at);
    const cleanupDeadline = utcMs(payload.cleanup_deadline_at);
    const lease = payload.credential_lease as Record<string, unknown>;
    if (
      auth.sessionId !== event.session_id || auth.deviceId !== event.origin.device_id ||
      auth.clientInstanceId !== event.origin.client_instance_id || event.origin.device_class !== 'iphone' ||
      event.connection.epoch !== 0 || event.connection.state !== 'connected' ||
      payload.active_device_id !== auth.deviceId || payload.active_device_lease_version !== 1 ||
      expires - start !== SESSION_DURATION_MS || cleanupDeadline !== expires + CLEANUP_GRACE_MS ||
      event.expires_at !== new Date(cleanupDeadline).toISOString() || lease?.credential_id !== auth.credentialId ||
      utcMs(lease?.expires_at) < expires || this.#now() < start || this.#now() >= expires
    ) throw new Error('DEVICE_ORIGIN_MISMATCH');
    this.#expireDue();
    if (this.sessions.isTerminal(event.session_id)) throw new Error('SESSION_TERMINAL');
    const admitted = {
      sessionId: event.session_id, deviceId: event.origin.device_id, deviceClass: 'iphone' as const,
      clientInstanceId: event.origin.client_instance_id, connectionId: event.connection.id, connectionEpoch: 0 as const,
      startedAtMs: start, expiresAtMs: expires, cleanupDeadlineAtMs: cleanupDeadline,
      authenticatedPrincipal: auth,
    };
    const fingerprint = digest({ admitted, event });
    const replay = this.#replay<Phase0OwnerRegistrationResult>(event.idempotency_key, fingerprint);
    if (replay) return freezeRegistration(replay, true);
    if (this.#records.has(event.session_id)) throw new Error('IDEMPOTENCY_CONFLICT');
    const result = freezeRegistration(admitted, false);
    const iphone: RegisteredTerminal = {
      deviceId: admitted.deviceId, deviceClass: 'iphone', clientInstanceId: admitted.clientInstanceId,
      connectionId: admitted.connectionId, connectionEpoch: 0,
    };
    const record: OwnerRecord = {
      sessionId: event.session_id, startedAtMs: start, expiresAtMs: expires, cleanupDeadlineAtMs: cleanupDeadline,
      credentialId: auth.credentialId, capabilitySha256: auth.capabilitySha256, sourceIpv4: auth.sourceIpv4,
      terminals: new Map([['iphone', iphone]]), idempotency: new Map(), events: new Map(),
      state: 'live', cleanupUncertain: false,
    };
    this.sessions.beginOwnerSessionWithEvent({
      sessionId: record.sessionId, startedAtMs: start, expiresAtMs: expires, cleanupDeadlineAtMs: cleanupDeadline,
      iphone: { deviceId: iphone.deviceId, clientInstanceId: iphone.clientInstanceId, connectionId: iphone.connectionId, connectionEpoch: 0 },
    }, event);
    record.events.set(event.event_id, digest(event));
    record.idempotency.set(event.idempotency_key, { fingerprint, result });
    this.#globalIdempotency.set(event.idempotency_key, { fingerprint, result, sessionId: record.sessionId });
    this.#records.set(record.sessionId, record);
    this.#scheduleExpiry(record);
    this.#transition('session_opened', record.sessionId);
    return result;
  }

  registerWatchBeforeFirstRelayedEvent(
    auth: Phase0OwnerAuthenticatedIphone,
    event: Phase0OwnerEvent,
  ): Phase0OwnerRegistrationResult {
    this.#assertOpen();
    assertAuth(auth);
    this.#validateEnvelope(event);
    if (event.event_type !== 'paios.phase0.demo.device.status') throw new Error('CONTRACT_REJECTED');
    this.#expireDue();
    const record = this.#liveRecord(event.session_id);
    const iphone = record.terminals.get('iphone')!;
    const relay = event.origin.relay;
    const payload = event.payload as Record<string, unknown>;
    if (
      auth.sessionId !== event.session_id || auth.deviceId !== iphone.deviceId ||
      auth.clientInstanceId !== iphone.clientInstanceId || auth.credentialId !== record.credentialId ||
      auth.capabilitySha256 !== record.capabilitySha256 || auth.sourceIpv4 !== record.sourceIpv4 ||
      event.origin.device_class !== 'apple_watch' || event.connection.epoch !== 0 || event.connection.state !== 'connected' ||
      relay?.device_id !== iphone.deviceId || relay.device_class !== 'iphone' || relay.transport !== 'watch_connectivity' ||
      payload.device_id !== event.origin.device_id || payload.transport !== 'watch_connectivity'
    ) throw new Error('DEVICE_ORIGIN_MISMATCH');
    const canonicalEventFingerprint = digest(event);
    const priorEvent = record.events.get(event.event_id);
    if (priorEvent !== undefined) {
      if (priorEvent !== canonicalEventFingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      const acceptedWatch = record.terminals.get('apple_watch');
      const acceptedRegistration = record.idempotency.get(event.idempotency_key);
      if (!acceptedWatch || !acceptedRegistration) throw new Error('IDEMPOTENCY_CONFLICT');
      return freezeRegistration(acceptedRegistration.result as Phase0OwnerRegistrationResult, true);
    }
    const admitted = {
      sessionId: record.sessionId, deviceId: event.origin.device_id, deviceClass: 'apple_watch' as const,
      clientInstanceId: event.origin.client_instance_id, connectionId: event.connection.id, connectionEpoch: 0 as const,
      relayIphoneDeviceId: iphone.deviceId, relayIphoneClientInstanceId: iphone.clientInstanceId,
      sourceIpv4: auth.sourceIpv4,
    };
    const fingerprint = digest({ admitted, event });
    const replay = this.#replay<Phase0OwnerRegistrationResult>(event.idempotency_key, fingerprint);
    if (replay) return freezeRegistration(replay, true);
    if (record.terminals.has('apple_watch') || [...record.terminals.values()].some((item) => item.deviceId === admitted.deviceId)) {
      throw new Error('CONTRACT_REJECTED');
    }
    const result = freezeRegistration(admitted, false);
    const terminal: Phase0OwnerTerminalRegistration & { deviceClass: 'apple_watch' } = { ...admitted, connectionEpoch: 0 };
    this.sessions.registerOwnerTerminalWithEvent(record.sessionId, terminal, event);
    record.terminals.set('apple_watch', terminal);
    record.events.set(event.event_id, digest(event));
    record.idempotency.set(event.idempotency_key, { fingerprint, result });
    this.#globalIdempotency.set(event.idempotency_key, { fingerprint, result, sessionId: record.sessionId });
    this.#transition('terminal_registered', record.sessionId);
    return result;
  }

  registerRayneoFromPairingV1Bootstrap(join: Phase0RayneoOwnerJoin): Phase0OwnerRegistrationResult {
    this.#assertOpen();
    this.#expireDue();
    if (
      !SCOPED.test(join.idempotencyKey) || !SCOPED.test(join.deviceId) || !SCOPED.test(join.clientInstanceId) ||
      !SHA256.test(join.keyId) || !SHA256.test(join.publicKeySpkiSha256) || join.keyId !== join.publicKeySpkiSha256 ||
      !IPV4.test(join.sourceIpv4)
    ) throw new Error('DEVICE_ORIGIN_MISMATCH');
    const priorGlobal = this.#globalIdempotency.get(join.idempotencyKey);
    if (priorGlobal) {
      const priorRecord = this.#records.get(priorGlobal.sessionId);
      if (!priorRecord || priorRecord.state !== 'live') throw new Error('SESSION_TERMINAL');
      const priorRayneo = priorRecord.terminals.get('rayneo');
      if (!priorRayneo) throw new Error('IDEMPOTENCY_CONFLICT');
      const fingerprint = this.#rayneoFingerprint(priorRecord.sessionId, join, priorRayneo.connectionId);
      if (fingerprint !== priorGlobal.fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return freezeRegistration(priorGlobal.result as Phase0OwnerRegistrationResult, true);
    }
    const joinable = [...this.#records.values()].filter((record) => {
      if (record.state !== 'live' || record.cleanupUncertain || this.#now() >= record.expiresAtMs) return false;
      if (!record.terminals.has('iphone') || !record.terminals.has('apple_watch') || record.terminals.has('rayneo')) return false;
      const snapshot = this.sessions.projectionSnapshot(record.sessionId);
      return snapshot?.activeDeviceLeaseVersion === 1;
    });
    if (joinable.length === 0) throw new Error('SHARED_SESSION_JOIN_NOT_APPLICABLE');
    if (joinable.length !== 1) throw new Error('ELIGIBLE_SHARED_SESSION_AMBIGUOUS');
    const record = joinable[0]!;
    if ([...record.terminals.values()].some((terminal) => terminal.deviceId === join.deviceId)) throw new Error('CONTRACT_REJECTED');
    const connectionId = `phase0_rayneo_connection_${createHash('sha256').update(
      `phase0-owner-rayneo-connection-v1\n${record.sessionId}\n${join.keyId}\n${join.deviceId}\n${join.clientInstanceId}`,
      'utf8',
    ).digest('hex').slice(0, 20)}`;
    const admitted = {
      sessionId: record.sessionId, deviceId: join.deviceId, deviceClass: 'rayneo' as const,
      clientInstanceId: join.clientInstanceId, connectionId, connectionEpoch: 0 as const,
    };
    const fingerprint = this.#rayneoFingerprint(record.sessionId, join, connectionId);
    const result = freezeRegistration(admitted, false);
    const terminal: Phase0OwnerTerminalRegistration & { deviceClass: 'rayneo' } = { ...admitted, connectionEpoch: 0 };
    const registration: Phase0OwnerTerminalRegistration = {
      ...terminal, connectionEpoch: 0, readinessExpiresAtMs: record.cleanupDeadlineAtMs,
    };
    this.sessions.registerOwnerTerminal(record.sessionId, registration);
    record.terminals.set('rayneo', terminal);
    record.pairingKeyId = join.keyId;
    record.pairingSpkiSha256 = join.publicKeySpkiSha256;
    record.idempotency.set(join.idempotencyKey, { fingerprint, result });
    this.#globalIdempotency.set(join.idempotencyKey, { fingerprint, result, sessionId: record.sessionId });
    this.#transition('terminal_registered', record.sessionId);
    return result;
  }

  /**
   * Opens the ordinary paired-RayNeo product path without requiring an
   * iPhone/Watch handoff session. The pairing proof is validated by the
   * cordless controller before this owner-only seam is called.
   */
  openRayneoStandaloneFromPairingV1Bootstrap(join: Phase0RayneoOwnerJoin): Phase0OwnerRegistrationResult {
    this.#assertOpen();
    this.#expireDue();
    if (
      !SCOPED.test(join.idempotencyKey) || !SCOPED.test(join.deviceId) || !SCOPED.test(join.clientInstanceId) ||
      !SHA256.test(join.keyId) || !SHA256.test(join.publicKeySpkiSha256) || join.keyId !== join.publicKeySpkiSha256 ||
      !IPV4.test(join.sourceIpv4)
    ) throw new Error('DEVICE_ORIGIN_MISMATCH');
    const identity = createHash('sha256').update(
      `phase0-owner-rayneo-standalone-v1\n${join.keyId}\n${join.deviceId}\n${join.clientInstanceId}`,
      'utf8',
    ).digest('hex');
    const sessionId = `phase0_session_${identity.slice(0, 20)}`;
    const connectionId = `phase0_rayneo_connection_${identity.slice(20, 40)}`;
    const fingerprint = this.#rayneoFingerprint(sessionId, join, connectionId);
    const replay = this.#replay<Phase0OwnerRegistrationResult>(join.idempotencyKey, fingerprint);
    if (replay) return freezeRegistration(replay, true);
    if (this.#records.has(sessionId) || this.sessions.hasSession(sessionId)) throw new Error('IDEMPOTENCY_CONFLICT');

    const startedAtMs = this.#now();
    const expiresAtMs = startedAtMs + this.#rayneoStandaloneSessionDurationMs;
    const cleanupDeadlineAtMs = expiresAtMs + CLEANUP_GRACE_MS;
    const terminal: RegisteredTerminal = {
      deviceId: join.deviceId,
      deviceClass: 'rayneo',
      clientInstanceId: join.clientInstanceId,
      connectionId,
      connectionEpoch: 0,
    };
    const result = freezeRegistration({
      sessionId,
      deviceId: terminal.deviceId,
      deviceClass: 'rayneo',
      connectionId: terminal.connectionId,
      connectionEpoch: 0,
    }, false);
    const record: OwnerRecord = {
      sessionId,
      startedAtMs,
      expiresAtMs,
      cleanupDeadlineAtMs,
      credentialId: `rayneo_standalone_${identity.slice(40, 60)}`,
      capabilitySha256: join.keyId,
      sourceIpv4: join.sourceIpv4,
      terminals: new Map([['rayneo', terminal]]),
      idempotency: new Map([[join.idempotencyKey, { fingerprint, result }]]),
      events: new Map(),
      state: 'live',
      cleanupUncertain: false,
      pairingKeyId: join.keyId,
      pairingSpkiSha256: join.publicKeySpkiSha256,
    };
    this.sessions.admitExistingSession({
      mode: 'rayneo_standalone',
      ...(this.#rayneoStandaloneSessionDurationMs === RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS ? {
        rayneoStandaloneSessionDurationMs: RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS,
      } : {}),
      sessionId,
      startedAtMs,
      expiresAtMs,
      cleanupDeadlineAtMs,
      rayneoClientInstanceId: join.clientInstanceId,
      readinessExpiresAtMs: cleanupDeadlineAtMs,
      devices: [{
        deviceId: terminal.deviceId,
        deviceClass: 'rayneo',
        connectionId: terminal.connectionId,
        connectionEpoch: 0,
      }],
    });
    this.#globalIdempotency.set(join.idempotencyKey, { fingerprint, result, sessionId });
    this.#records.set(sessionId, record);
    this.#scheduleExpiry(record);
    this.#transition('session_opened', sessionId);
    this.#transition('terminal_registered', sessionId);
    return result;
  }

  acceptEvent(auth: Phase0OwnerAuthenticatedIphone, event: Phase0OwnerEvent): Readonly<{ duplicate: boolean }> {
    this.#assertOpen();
    assertAuth(auth);
    this.#validateEnvelope(event);
    if (TERMINAL_EVENT_TYPES.has(event.event_type)) throw new Error('CONTRACT_REJECTED');
    if (event.event_type === 'paios.phase0.demo.session.started') throw new Error('CONTRACT_REJECTED');
    this.#expireDue();
    const record = this.#liveRecord(event.session_id);
    this.#assertEventPrincipal(record, auth, event);
    const fingerprint = digest(event);
    const priorIdempotency = record.idempotency.get(event.idempotency_key);
    if (priorIdempotency) {
      if (priorIdempotency.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return Object.freeze({ duplicate: true });
    }
    const priorEvent = record.events.get(event.event_id);
    if (priorEvent !== undefined) {
      if (priorEvent !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return Object.freeze({ duplicate: true });
    }
    if (event.event_type === 'paios.phase0.demo.connection.reconnected') {
      const terminal = record.terminals.get(event.origin.device_class as RegisteredTerminal['deviceClass']);
      const payload = event.payload as Record<string, unknown>;
      if (
        !terminal || event.connection.state !== 'reconnected' || event.connection.epoch !== terminal.connectionEpoch + 1 ||
        event.connection.resumed_from_connection_id !== terminal.connectionId ||
        payload.previous_connection_id !== terminal.connectionId || payload.new_connection_id !== event.connection.id
      ) throw new Error('CONTRACT_REJECTED');
      this.sessions.reconnectOwnerSessionAndAcceptEvent({
        sessionId: record.sessionId, deviceId: terminal.deviceId,
        previousConnectionId: terminal.connectionId, newConnectionId: event.connection.id,
        previousEpoch: terminal.connectionEpoch,
      }, event);
      terminal.connectionId = event.connection.id;
      terminal.connectionEpoch += 1;
    } else {
      this.sessions.acceptOwnerEvent(event);
    }
    const result = Object.freeze({ duplicate: false });
    record.events.set(event.event_id, fingerprint);
    record.idempotency.set(event.idempotency_key, { fingerprint, result });
    this.#globalIdempotency.set(event.idempotency_key, { fingerprint, result, sessionId: record.sessionId });
    if (event.event_type === 'paios.phase0.demo.connection.reconnected') this.#transition('connection_reconnected', record.sessionId);
    return result;
  }

  handoff(auth: Phase0OwnerAuthenticatedIphone, request: HandoffRequest): HandoffResult {
    this.#assertOpen();
    assertAuth(auth);
    this.#expireDue();
    const record = this.#liveRecord(request.sessionId);
    const iphone = record.terminals.get('iphone')!;
    if (
      auth.sessionId !== record.sessionId || auth.deviceId !== iphone.deviceId ||
      auth.clientInstanceId !== iphone.clientInstanceId || auth.credentialId !== record.credentialId ||
      auth.capabilitySha256 !== record.capabilitySha256 || auth.sourceIpv4 !== record.sourceIpv4
    ) throw new Error('DEVICE_ORIGIN_MISMATCH');
    if (![...record.terminals.values()].some((terminal) => terminal.deviceId === request.toDeviceId)) {
      throw new Error('CONTRACT_REJECTED');
    }
    let result: HandoffResult;
    try { result = this.sessions.handoff(request); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'HANDOFF_ORDER_INVALID' || code === 'HANDOFF_TARGET_INVALID') throw new Error('CONTRACT_REJECTED');
      throw error;
    }
    if (!result.retry) this.#transition('handoff_completed', record.sessionId);
    return result;
  }

  hasRegisteredTerminal(sessionId: string, deviceClass: RegisteredTerminal['deviceClass']): boolean {
    this.#expireDue();
    return this.#records.get(sessionId)?.state === 'live' && this.#records.get(sessionId)?.terminals.has(deviceClass) === true;
  }

  isAcceptedWatchRegistrationEvent(sessionId: string, eventId: string): boolean {
    this.#expireDue();
    const record = this.#records.get(sessionId);
    return record?.state === 'live' && record.terminals.has('apple_watch') && record.events.has(eventId);
  }

  snapshotAndSubscribeLifecycle(consumer: (transition: Phase0OwnerLifecycleTransition) => void): Readonly<{
    snapshot: Phase0OwnerSnapshot;
    revision: number;
    unsubscribe: () => void;
  }> {
    this.#assertOpen();
    this.#expireDue();
    const staged: Phase0OwnerLifecycleTransition[] = [];
    const stagingConsumer = (transition: Phase0OwnerLifecycleTransition): void => { staged.push(transition); };
    this.#consumers.add(stagingConsumer);
    let revision: number;
    let snapshot: Phase0OwnerSnapshot;
    try {
      this.#snapshotSubscribeBoundary?.();
      revision = this.#revision;
      snapshot = this.#snapshot(revision);
    } finally {
      this.#consumers.delete(stagingConsumer);
    }
    this.#consumers.add(consumer);
    for (const transition of staged) {
      if (transition.revision > revision) consumer(transition);
    }
    let subscribed = true;
    return Object.freeze({
      snapshot, revision,
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.#consumers.delete(consumer);
      },
    });
  }

  revokeRayneoPairing(deviceId: string, keyId: string): Promise<boolean> {
    this.#assertOpen();
    this.#expireDue();
    const matches = [...this.#records.values()].filter((record) =>
      record.state === 'live' && record.terminals.get('rayneo')?.deviceId === deviceId && record.pairingKeyId === keyId);
    if (matches.length === 0) return Promise.resolve(true);
    const flights = matches.map((record) => this.#terminate(record, 'error', 'pairing_revoked'));
    return Promise.all(flights).then((results) => results.every(Boolean));
  }

  async close(): Promise<boolean> {
    if (this.#closed) return (await Promise.all([...this.#cleanupFlights])).every(Boolean);
    this.#closed = true;
    for (const record of this.#records.values()) {
      if (record.timer) this.#clearTimer(record.timer);
      delete record.timer;
      if (record.state === 'live') void this.#terminate(record, 'error', 'session_ended');
    }
    const results = await Promise.all([...this.#cleanupFlights]);
    this.#consumers.clear();
    this.#detachControllerObserver();
    return results.every(Boolean);
  }

  #snapshot(revision: number): Phase0OwnerSnapshot {
    const sessions = [...this.#records.values()].map((record): Phase0OwnerSessionSnapshot => {
      const orchestration = this.sessions.orchestratorSnapshot(record.sessionId);
      return Object.freeze({
        sessionId: record.sessionId, state: record.state,
        startedAtMs: record.startedAtMs, expiresAtMs: record.expiresAtMs,
        cleanupDeadlineAtMs: record.cleanupDeadlineAtMs,
        registeredDeviceClasses: Object.freeze([...record.terminals.keys()]),
        ...(orchestration === undefined ? {} : {
          activeDeviceId: orchestration.activeDeviceId,
          activeDeviceLeaseVersion: orchestration.activeDeviceLeaseVersion,
        }),
        cleanupUncertain: record.cleanupUncertain,
      });
    });
    return Object.freeze({ revision, sessions: Object.freeze(sessions) });
  }

  #validateEnvelope(event: Phase0OwnerEvent): void {
    if (!validateEvent(event)) throw new Error('CONTRACT_REJECTED');
  }

  #assertEventPrincipal(record: OwnerRecord, auth: Phase0OwnerAuthenticatedIphone, event: Phase0OwnerEvent): void {
    const iphone = record.terminals.get('iphone')!;
    if (
      auth.sessionId !== record.sessionId || auth.deviceId !== iphone.deviceId ||
      auth.clientInstanceId !== iphone.clientInstanceId || auth.credentialId !== record.credentialId ||
      auth.capabilitySha256 !== record.capabilitySha256 || auth.sourceIpv4 !== record.sourceIpv4
    ) throw new Error('DEVICE_ORIGIN_MISMATCH');
    if (event.origin.device_class === 'iphone') {
      if (event.origin.device_id !== iphone.deviceId || event.origin.client_instance_id !== iphone.clientInstanceId) {
        throw new Error('DEVICE_ORIGIN_MISMATCH');
      }
      return;
    }
    if (event.origin.device_class === 'apple_watch') {
      const watch = record.terminals.get('apple_watch');
      if (
        !watch || event.origin.device_id !== watch.deviceId || event.origin.client_instance_id !== watch.clientInstanceId ||
        event.origin.relay?.device_id !== iphone.deviceId || event.origin.relay.device_class !== 'iphone' ||
        event.origin.relay.transport !== 'watch_connectivity'
      ) throw new Error('DEVICE_ORIGIN_MISMATCH');
      return;
    }
    throw new Error('DEVICE_ORIGIN_MISMATCH');
  }

  #liveRecord(sessionId: string): OwnerRecord {
    const record = this.#records.get(sessionId);
    if (!record) throw new Error(this.sessions.isTerminal(sessionId) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    if (record.state !== 'live' || this.#now() >= record.expiresAtMs) throw new Error('SESSION_TERMINAL');
    return record;
  }

  #replay<T>(idempotencyKey: string, fingerprint: string): T | undefined {
    const prior = this.#globalIdempotency.get(idempotencyKey);
    if (!prior) return undefined;
    const record = this.#records.get(prior.sessionId);
    if (!record || record.state !== 'live') throw new Error('SESSION_TERMINAL');
    if (prior.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
    return prior.result as T;
  }

  #rayneoFingerprint(sessionId: string, join: Phase0RayneoOwnerJoin, connectionId: string): string {
    return digest({ sessionId, deviceClass: 'rayneo', connectionId, connectionEpoch: 0, ...join });
  }

  #purgeRecord(record: OwnerRecord): void {
    record.events.clear();
    record.idempotency.clear();
    record.terminals.clear();
    for (const [idempotencyKey, reservation] of this.#globalIdempotency) {
      if (reservation.sessionId === record.sessionId) this.#globalIdempotency.delete(idempotencyKey);
    }
    this.#records.delete(record.sessionId);
  }

  #scheduleExpiry(record: OwnerRecord): void {
    record.timer = this.#setTimer(() => {
      if (record.state === 'live' && this.#now() >= record.expiresAtMs) void this.#terminate(record, 'timeout', 'session_expired');
    }, Math.max(0, record.expiresAtMs - this.#now()));
    record.timer.unref?.();
  }

  #expireDue(): void {
    const now = this.#now();
    for (const record of this.#records.values()) {
      if (record.state === 'live' && now >= record.expiresAtMs) void this.#terminate(record, 'timeout', 'session_expired');
    }
  }

  #terminate(
    record: OwnerRecord,
    reason: 'timeout' | 'error',
    lifecycle: 'session_expired' | 'pairing_revoked' | 'session_ended',
  ): Promise<boolean> {
    if (record.state !== 'live') return Promise.resolve(true);
    record.state = 'terminal';
    if (record.timer) this.#clearTimer(record.timer);
    delete record.timer;
    const flight = this.sessions.terminateOwnerSession(record.sessionId, reason, lifecycle)
      .finally(() => this.#cleanupFlights.delete(flight));
    this.#cleanupFlights.add(flight);
    return flight;
  }

  #transition(kind: Phase0OwnerTransitionKind, sessionId: string): void {
    if (this.#closed && kind !== 'session_ended' && kind !== 'cleanup_completed' && kind !== 'cleanup_uncertain') return;
    const transition = Object.freeze({ revision: ++this.#revision, kind, sessionId });
    for (const consumer of this.#consumers) consumer(transition);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('OWNER_CLOSED');
  }
}
