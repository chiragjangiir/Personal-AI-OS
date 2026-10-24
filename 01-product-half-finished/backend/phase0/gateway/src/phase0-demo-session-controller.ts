import { randomUUID } from 'node:crypto';
import {
  DemoStateProjector,
  type AcceptedDemoEvent,
  type DemoDeviceProjection,
  type DemoSessionProjection,
} from './demo-state-projector.ts';
import {
  SharedSessionOrchestrator,
  type HandoffRequest,
  type HandoffResult,
  type PublicStopRequest,
  type SharedSessionInput,
  type SharedSessionSnapshot,
} from './shared-session-orchestrator.ts';

const MIN_LOW_RATE_REMAINING_MS = 2_105_000;
const SESSION_DURATION_MS = 3_600_000;
const RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS = 86_400_000;

export interface Phase0ExistingSessionInput extends SharedSessionInput {
  readonly rayneoClientInstanceId: string;
  readonly readinessExpiresAtMs: number;
}

export interface Phase0EligibleSession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly expiresAtMs: number;
  readonly cleanupDeadlineAtMs: number;
  readonly activeDeviceLeaseVersion: 3;
}

export interface Phase0TelemetryInput {
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly batteryPercent: number;
  readonly temperatureCelsius: number;
  readonly frameRate: number;
  readonly cumulativeDroppedFrames: number;
}

export interface Phase0CleanupCounts {
  readonly events: number;
  readonly media_objects: number;
  readonly session_rows: number;
  readonly model_cache_entries: number;
}

export interface Phase0DemoSessionControllerConfig {
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly cleanup?: (sessionId: string) => Phase0CleanupCounts | Promise<Phase0CleanupCounts>;
}

export type Phase0OwnerLifecycleKind =
  | 'session_ended'
  | 'session_expired'
  | 'pairing_revoked'
  | 'cleanup_completed'
  | 'cleanup_uncertain';

export interface Phase0OwnerPendingSessionInput {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly cleanupDeadlineAtMs: number;
  readonly iphone: Readonly<{
    deviceId: string;
    clientInstanceId: string;
    connectionId: string;
    connectionEpoch: 0;
  }>;
}

export interface Phase0OwnerTerminalRegistration {
  readonly deviceId: string;
  readonly deviceClass: 'apple_watch' | 'rayneo';
  readonly clientInstanceId: string;
  readonly connectionId: string;
  readonly connectionEpoch: 0;
  readonly readinessExpiresAtMs?: number;
}

export type Phase0LowRateStopCleanup = () => boolean | Promise<boolean>;

export interface Phase0TerminalSessionTombstone {
  readonly sessionId: string;
  readonly publicStopEffectCount: 0 | 1;
  readonly cleanupCompleted: boolean;
  readonly events: readonly AcceptedDemoEvent[];
  readonly cleanupCounts?: Phase0CleanupCounts;
}

export interface Phase0DemoEvent extends AcceptedDemoEvent {
  readonly trace_id: string;
  readonly expires_at: string;
  readonly origin: Readonly<{
    device_id: string;
    device_class: 'rayneo';
    client_instance_id: string;
  }>;
  readonly connection: Readonly<{
    id: string;
    epoch: number;
    state: 'connected';
  }>;
  readonly sequence: Readonly<{
    stream_id: string;
    number: number;
    previous_event_id?: string;
  }>;
  readonly idempotency_key: string;
}

interface SessionRecord {
  readonly input: Phase0ExistingSessionInput;
  readonly orchestrator: SharedSessionOrchestrator;
  readonly projector: DemoStateProjector;
  readonly events: AcceptedDemoEvent[];
  readonly eventFingerprints: Map<string, string>;
  readonly subscribers: Set<(event: AcceptedDemoEvent) => void>;
  sequence: number;
  previousEventId?: string;
  cleanupUncertain: boolean;
}

interface PendingOwnerRecord {
  readonly input: Phase0OwnerPendingSessionInput;
  readonly devices: Phase0OwnerTerminalRegistration[];
  readonly events: AcceptedDemoEvent[];
  readonly eventFingerprints: Map<string, string>;
  readonly subscribers: Set<(event: AcceptedDemoEvent) => void>;
}

function isScoped(value: string): boolean {
  return /^[a-z][a-z0-9_-]{2,63}$/u.test(value);
}

function validExistingSessionDuration(input: Phase0ExistingSessionInput): boolean {
  const duration = input.expiresAtMs - input.startedAtMs;
  const explicit = input.rayneoStandaloneSessionDurationMs;
  if (explicit === undefined) return duration === SESSION_DURATION_MS;
  return input.mode === 'rayneo_standalone' && Number.isSafeInteger(explicit) &&
    explicit === RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS && duration === explicit;
}

function canonicalUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isSafeInteger(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function assertCleanupCounts(value: Phase0CleanupCounts): void {
  for (const count of [value.events, value.media_objects, value.session_rows, value.model_cache_entries]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('CLEANUP_RECEIPT_INVALID');
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function eventFingerprint(event: AcceptedDemoEvent): string {
  return stable(event);
}

/**
 * Volatile owner-side projection of already admitted Phase-0 v0.4 sessions.
 * RayNeo product requests can only select these records; they cannot create or
 * refresh one through this controller.
 */
export class Phase0DemoSessionController {
  readonly #now: () => number;
  readonly #randomUuid: () => string;
  readonly #cleanup: NonNullable<Phase0DemoSessionControllerConfig['cleanup']>;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #pendingOwner = new Map<string, PendingOwnerRecord>();
  readonly #terminal = new Map<string, Phase0TerminalSessionTombstone>();
  #ownerLifecycleObserver: ((kind: Phase0OwnerLifecycleKind, sessionId: string) => void) | undefined;

  constructor(config: Phase0DemoSessionControllerConfig = {}) {
    this.#now = config.now ?? Date.now;
    this.#randomUuid = config.randomUuid ?? randomUUID;
    this.#cleanup = config.cleanup ?? (() => ({ events: 0, media_objects: 0, session_rows: 0, model_cache_entries: 0 }));
  }

  setOwnerLifecycleObserver(observer: (kind: Phase0OwnerLifecycleKind, sessionId: string) => void): () => void {
    if (this.#ownerLifecycleObserver !== undefined) throw new Error('OWNER_LIFECYCLE_OBSERVER_ALREADY_ATTACHED');
    this.#ownerLifecycleObserver = observer;
    return () => {
      if (this.#ownerLifecycleObserver === observer) this.#ownerLifecycleObserver = undefined;
    };
  }

  beginOwnerSession(input: Phase0OwnerPendingSessionInput): void {
    this.#pendingOwner.set(input.sessionId, this.#prepareOwnerSession(input));
  }

  beginOwnerSessionWithEvent(input: Phase0OwnerPendingSessionInput, event: AcceptedDemoEvent): Readonly<{ duplicate: false }> {
    const pending = this.#prepareOwnerSession(input);
    const admission = this.#preparePendingEvent(pending, event);
    if (admission.duplicate) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
    pending.eventFingerprints.set(event.event_id, admission.fingerprint);
    pending.events.push(Object.freeze(event));
    this.#pendingOwner.set(input.sessionId, pending);
    return Object.freeze({ duplicate: false });
  }

  #prepareOwnerSession(input: Phase0OwnerPendingSessionInput): PendingOwnerRecord {
    if (this.#sessions.has(input.sessionId) || this.#pendingOwner.has(input.sessionId) || this.#terminal.has(input.sessionId)) {
      throw new Error('SESSION_ALREADY_ADMITTED');
    }
    if (
      !isScoped(input.sessionId) || !isScoped(input.iphone.deviceId) || !isScoped(input.iphone.clientInstanceId) ||
      !isScoped(input.iphone.connectionId) || input.iphone.connectionEpoch !== 0 ||
      input.expiresAtMs - input.startedAtMs !== SESSION_DURATION_MS ||
      input.cleanupDeadlineAtMs !== input.expiresAtMs + 5_000
    ) throw new Error('SESSION_READINESS_INVALID');
    return {
      input: Object.freeze({ ...input, iphone: Object.freeze({ ...input.iphone }) }),
      devices: [], events: [], eventFingerprints: new Map(), subscribers: new Set(),
    };
  }

  registerOwnerTerminal(sessionId: string, registration: Phase0OwnerTerminalRegistration): void {
    const pending = this.#pendingOwner.get(sessionId);
    if (!pending) throw new Error(this.#terminal.has(sessionId) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    this.#assertOwnerTerminalRegistration(pending, registration);
    pending.devices.push(Object.freeze({ ...registration }));
    if (registration.deviceClass === 'rayneo') this.#materializeOwnerSession(pending, registration);
  }

  registerOwnerTerminalWithEvent(
    sessionId: string,
    registration: Phase0OwnerTerminalRegistration,
    event: AcceptedDemoEvent,
  ): Readonly<{ duplicate: false }> {
    const pending = this.#pendingOwner.get(sessionId);
    if (!pending) throw new Error(this.#terminal.has(sessionId) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    this.#assertOwnerTerminalRegistration(pending, registration);
    if (registration.deviceClass !== 'apple_watch') throw new Error('TERMINAL_SET_INVALID');
    const admission = this.#preparePendingEvent(pending, event);
    if (admission.duplicate) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
    pending.devices.push(Object.freeze({ ...registration }));
    pending.eventFingerprints.set(event.event_id, admission.fingerprint);
    pending.events.push(Object.freeze(event));
    for (const subscriber of pending.subscribers) subscriber(event);
    return Object.freeze({ duplicate: false });
  }

  #assertOwnerTerminalRegistration(
    pending: PendingOwnerRecord,
    registration: Phase0OwnerTerminalRegistration,
  ): void {
    if (
      !isScoped(registration.deviceId) || !isScoped(registration.clientInstanceId) ||
      !isScoped(registration.connectionId) || registration.connectionEpoch !== 0 ||
      pending.input.iphone.deviceId === registration.deviceId ||
      pending.devices.some((device) => device.deviceId === registration.deviceId || device.deviceClass === registration.deviceClass)
    ) throw new Error('TERMINAL_SET_INVALID');
    if (registration.deviceClass === 'apple_watch' && pending.devices.length !== 0) throw new Error('TERMINAL_SET_INVALID');
    if (registration.deviceClass === 'rayneo' && (
      pending.devices.length !== 1 || pending.devices[0]!.deviceClass !== 'apple_watch' ||
      !Number.isSafeInteger(registration.readinessExpiresAtMs)
    )) throw new Error('TERMINAL_SET_INVALID');
  }

  acceptOwnerEvent(event: AcceptedDemoEvent): Readonly<{ duplicate: boolean }> {
    const pending = this.#pendingOwner.get(event.session_id);
    if (pending) {
      const admission = this.#preparePendingEvent(pending, event);
      if (admission.duplicate) return Object.freeze({ duplicate: true });
      pending.eventFingerprints.set(event.event_id, admission.fingerprint);
      pending.events.push(Object.freeze(event));
      for (const subscriber of pending.subscribers) subscriber(event);
      return Object.freeze({ duplicate: false });
    }
    const record = this.#sessions.get(event.session_id);
    if (!record) throw new Error(this.#terminal.has(event.session_id) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    const admission = this.#prepareSessionEvent(record, event);
    if (admission.duplicate) return Object.freeze({ duplicate: true });
    const projected = record.projector.project(event);
    if (!projected.duplicate) {
      record.eventFingerprints.set(event.event_id, admission.fingerprint);
      record.events.push(event);
      for (const subscriber of record.subscribers) subscriber(event);
    }
    return Object.freeze({ duplicate: projected.duplicate });
  }

  /** Owner-side admission only. This method is never exposed as a RayNeo route. */
  admitExistingSession(input: Phase0ExistingSessionInput): void {
    if (this.#sessions.has(input.sessionId) || this.#pendingOwner.has(input.sessionId) || this.#terminal.has(input.sessionId)) throw new Error('SESSION_ALREADY_ADMITTED');
    if (!isScoped(input.rayneoClientInstanceId) || !Number.isSafeInteger(input.readinessExpiresAtMs)) {
      throw new Error('SESSION_READINESS_INVALID');
    }
    if (!validExistingSessionDuration(input) || input.readinessExpiresAtMs < input.startedAtMs) {
      throw new Error('SESSION_READINESS_INVALID');
    }
    const orchestrator = new SharedSessionOrchestrator(input, this.#now);
    const projector = new DemoStateProjector(input.sessionId, input.devices.map((item) => ({
      deviceId: item.deviceId,
      deviceClass: item.deviceClass,
    })));
    this.#sessions.set(input.sessionId, {
      input: Object.freeze({ ...input, devices: Object.freeze(input.devices.map((item) => Object.freeze({ ...item }))) }),
      orchestrator,
      projector,
      events: [],
      eventFingerprints: new Map(),
      subscribers: new Set(),
      sequence: 0,
      cleanupUncertain: false,
    });
  }

  handoff(request: HandoffRequest): HandoffResult {
    const record = this.#sessions.get(request.sessionId);
    if (!record) throw new Error('SESSION_NOT_FOUND');
    return record.orchestrator.handoff(request);
  }

  eligibleRayneoSessions(deviceId: string, clientInstanceId: string): readonly Phase0EligibleSession[] {
    const now = this.#now();
    const eligible: Phase0EligibleSession[] = [];
    for (const record of this.#sessions.values()) {
      const snapshot = record.orchestrator.snapshot();
      const rayneo = snapshot.devices.find((item) => item.deviceClass === 'rayneo');
      if (
        snapshot.state !== 'live' || record.cleanupUncertain ||
        now < record.input.startedAtMs || now >= snapshot.expiresAtMs ||
        !validExistingSessionDuration(record.input) ||
        snapshot.expiresAtMs - now < 2_100_000 || snapshot.cleanupDeadlineAtMs - now < MIN_LOW_RATE_REMAINING_MS ||
        record.input.readinessExpiresAtMs - now < MIN_LOW_RATE_REMAINING_MS ||
        !rayneo || rayneo.deviceId !== deviceId || record.input.rayneoClientInstanceId !== clientInstanceId ||
        snapshot.activeDeviceId !== rayneo.deviceId || snapshot.activeDeviceLeaseVersion !== 3
      ) continue;
      eligible.push(Object.freeze({
        sessionId: snapshot.sessionId,
        deviceId: rayneo.deviceId,
        clientInstanceId,
        connectionId: rayneo.connectionId,
        connectionEpoch: rayneo.connectionEpoch,
        expiresAtMs: snapshot.expiresAtMs,
        cleanupDeadlineAtMs: snapshot.cleanupDeadlineAtMs,
        activeDeviceLeaseVersion: 3,
      }));
    }
    return Object.freeze(eligible);
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.has(sessionId) || this.#pendingOwner.has(sessionId) || this.#terminal.has(sessionId);
  }

  isTerminal(sessionId: string): boolean { return this.#terminal.has(sessionId); }

  terminalTombstone(sessionId: string): Phase0TerminalSessionTombstone | undefined {
    return this.#terminal.get(sessionId);
  }

  activeSessionIds(): readonly string[] {
    const now = this.#now();
    return Object.freeze([
      ...[...this.#pendingOwner.values()]
        .filter((record) => now >= record.input.startedAtMs && now < record.input.expiresAtMs)
        .map((record) => record.input.sessionId),
      ...[...this.#sessions.values()]
        .filter((record) => {
          const snapshot = record.orchestrator.snapshot();
          return snapshot.state === 'live' && now >= record.input.startedAtMs && now < record.input.expiresAtMs && !record.cleanupUncertain;
        })
        .map((record) => record.input.sessionId),
    ]);
  }

  orchestratorSnapshot(sessionId: string): SharedSessionSnapshot | undefined {
    return this.#sessions.get(sessionId)?.orchestrator.snapshot();
  }

  projectionSnapshot(sessionId: string): DemoSessionProjection | undefined {
    const record = this.#sessions.get(sessionId);
    if (record) return this.#now() >= record.input.expiresAtMs ? undefined : record.projector.snapshot();
    const pending = this.#pendingOwner.get(sessionId);
    if (!pending || this.#now() >= pending.input.expiresAtMs) return undefined;
    const devices: DemoDeviceProjection[] = [
      { deviceId: pending.input.iphone.deviceId, deviceClass: 'iphone', status: 'online' },
      ...pending.devices.map((device) => ({
        deviceId: device.deviceId,
        deviceClass: device.deviceClass,
        status: 'online' as const,
      })),
    ];
    return Object.freeze({
      sessionId, state: 'live', activeDeviceId: pending.input.iphone.deviceId,
      activeDeviceLeaseVersion: 1, devices: Object.freeze(devices.map((device) => Object.freeze(device))),
      acceptedEventCount: pending.events.length,
    });
  }

  events(sessionId: string): readonly AcceptedDemoEvent[] {
    return Object.freeze([...(this.#sessions.get(sessionId)?.events ?? this.#pendingOwner.get(sessionId)?.events ?? this.#terminal.get(sessionId)?.events ?? [])]);
  }

  subscribe(sessionId: string, subscriber: (event: AcceptedDemoEvent) => void): () => void {
    const record = this.#sessions.get(sessionId) ?? this.#pendingOwner.get(sessionId);
    if (!record) {
      if (this.#terminal.has(sessionId)) return () => undefined;
      throw new Error('SESSION_NOT_FOUND');
    }
    record.subscribers.add(subscriber);
    return () => record.subscribers.delete(subscriber);
  }

  emitTelemetry(sessionId: string, input: Phase0TelemetryInput): Phase0DemoEvent {
    const record = this.#liveRayneoRecord(sessionId);
    if (!canonicalUtc(input.observedAt) || !isScoped(input.idempotencyKey)) throw new Error('TELEMETRY_EVENT_INVALID');
    const values = [input.batteryPercent, input.temperatureCelsius, input.frameRate, input.cumulativeDroppedFrames];
    if (values.some((item) => !Number.isFinite(item))) throw new Error('TELEMETRY_EVENT_INVALID');
    return this.#emit(record, 'paios.phase0.demo.device.telemetry', input.idempotencyKey, input.observedAt, {
      device_id: record.orchestrator.snapshot().activeDeviceId,
      observed_at: input.observedAt,
      metrics: [
        { name: 'battery', value: input.batteryPercent, unit: 'percent' },
        { name: 'temperature', value: input.temperatureCelsius, unit: 'celsius' },
        { name: 'frame_rate', value: input.frameRate, unit: 'fps' },
        { name: 'dropped_frames', value: input.cumulativeDroppedFrames, unit: 'count' },
      ],
    });
  }

  publicStop(sessionId: string, request: PublicStopRequest, lowRateCleanup?: Phase0LowRateStopCleanup): Promise<Readonly<{
    status: 'stop_accepted';
    publicStopEffectCount: 1;
    endedEvent: Phase0DemoEvent;
    cleanupEvent: Phase0DemoEvent;
  }>> {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error(this.#terminal.has(sessionId) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    // SharedSessionOrchestrator validates the complete Stop authority and
    // atomically applies the sole outer effect before this method returns a
    // promise or starts any cleanup work.
    const effect = record.orchestrator.publicStop(request);
    this.#ownerLifecycleObserver?.('session_ended', sessionId);
    const endedAt = new Date(this.#now()).toISOString();
    const ended = this.#emit(record, 'paios.phase0.demo.session.ended', request.requestId, endedAt, {
      reason: 'user_stop', ended_at: endedAt, cleanup_deadline_at: effect.cleanupDeadlineAt,
    });
    return this.#completePublicStop(record, request, ended, lowRateCleanup);
  }

  async #completePublicStop(
    record: SessionRecord,
    request: PublicStopRequest,
    ended: Phase0DemoEvent,
    lowRateCleanup: Phase0LowRateStopCleanup | undefined,
  ): Promise<Readonly<{
    status: 'stop_accepted';
    publicStopEffectCount: 1;
    endedEvent: Phase0DemoEvent;
    cleanupEvent: Phase0DemoEvent;
  }>> {
    if (lowRateCleanup) {
      try {
        if (!(await lowRateCleanup())) throw new Error('LOW_RATE_CLEANUP_UNCERTAIN');
      } catch {
        this.#terminalize(record, ended, undefined, false);
        this.#ownerLifecycleObserver?.('cleanup_uncertain', record.input.sessionId);
        throw new Error('CLEANUP_UNCERTAIN');
      }
    }
    let removed: Phase0CleanupCounts;
    try {
      removed = await this.#cleanup(record.input.sessionId);
      assertCleanupCounts(removed);
    } catch {
      this.#terminalize(record, ended, undefined, false);
      this.#ownerLifecycleObserver?.('cleanup_uncertain', record.input.sessionId);
      throw new Error('CLEANUP_UNCERTAIN');
    }
    const truthfulRemoved: Phase0CleanupCounts = Object.freeze({
      events: removed.events + Math.max(0, record.events.length - 1),
      media_objects: removed.media_objects,
      session_rows: removed.session_rows + 1,
      model_cache_entries: removed.model_cache_entries,
    });
    assertCleanupCounts(truthfulRemoved);
    const completedAt = new Date(this.#now()).toISOString();
    const cleanup = this.#emit(record, 'paios.phase0.demo.session.cleanup.completed', `${request.requestId}:cleanup`, completedAt, {
      status: 'complete', completed_at: completedAt, removed: truthfulRemoved,
    });
    this.#terminalize(record, ended, cleanup, true, truthfulRemoved);
    this.#ownerLifecycleObserver?.('cleanup_completed', record.input.sessionId);
    return Object.freeze({ status: 'stop_accepted', publicStopEffectCount: 1, endedEvent: ended, cleanupEvent: cleanup });
  }

  markCleanupUncertain(sessionId: string): void {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error('SESSION_NOT_FOUND');
    record.cleanupUncertain = true;
    this.#ownerLifecycleObserver?.('cleanup_uncertain', sessionId);
  }

  reconnectOwnerSession(request: Readonly<{
    sessionId: string;
    deviceId: string;
    previousConnectionId: string;
    newConnectionId: string;
    previousEpoch: number;
  }>): Readonly<{ deviceId: string; connectionId: string; connectionEpoch: number }> {
    const record = this.#sessions.get(request.sessionId);
    if (!record) throw new Error(this.#terminal.has(request.sessionId) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    return record.orchestrator.reconnect(request);
  }

  reconnectOwnerSessionAndAcceptEvent(
    request: Readonly<{
      sessionId: string;
      deviceId: string;
      previousConnectionId: string;
      newConnectionId: string;
      previousEpoch: number;
    }>,
    event: AcceptedDemoEvent,
  ): Readonly<{
    deviceId: string;
    connectionId: string;
    connectionEpoch: number;
    duplicate: false;
  }> {
    const record = this.#sessions.get(request.sessionId);
    if (!record) throw new Error(this.#terminal.has(request.sessionId) ? 'SESSION_TERMINAL' : 'SESSION_NOT_FOUND');
    const admission = this.#prepareSessionEvent(record, event);
    if (admission.duplicate) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
    const reconnected = record.orchestrator.reconnect(request);
    const projected = record.projector.project(event);
    if (projected.duplicate) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
    record.eventFingerprints.set(event.event_id, admission.fingerprint);
    record.events.push(event);
    for (const subscriber of record.subscribers) subscriber(event);
    return Object.freeze({ ...reconnected, duplicate: false });
  }

  async terminateOwnerSession(
    sessionId: string,
    reason: 'timeout' | 'error',
    lifecycle: 'session_expired' | 'pairing_revoked' | 'session_ended' = reason === 'timeout' ? 'session_expired' : 'pairing_revoked',
  ): Promise<boolean> {
    const pending = this.#pendingOwner.get(sessionId);
    if (pending) {
      this.#pendingOwner.delete(sessionId);
      this.#terminal.set(sessionId, Object.freeze({
        sessionId, publicStopEffectCount: 0, cleanupCompleted: false,
        events: Object.freeze([]),
      }));
      pending.subscribers.clear();
      this.#ownerLifecycleObserver?.(lifecycle, sessionId);
      try {
        const removed = await this.#cleanup(sessionId);
        assertCleanupCounts(removed);
        this.#terminal.set(sessionId, Object.freeze({
          sessionId, publicStopEffectCount: 0, cleanupCompleted: true,
          events: Object.freeze([]), cleanupCounts: Object.freeze({ ...removed }),
        }));
        this.#ownerLifecycleObserver?.('cleanup_completed', sessionId);
        return true;
      } catch {
        this.#ownerLifecycleObserver?.('cleanup_uncertain', sessionId);
        return false;
      }
    }
    const record = this.#sessions.get(sessionId);
    if (!record) return this.#terminal.has(sessionId);
    let terminal;
    try { terminal = record.orchestrator.terminate(reason); }
    catch (error) {
      if (error instanceof Error && error.message === 'SESSION_TERMINAL') return true;
      throw error;
    }
    const endedAt = new Date(this.#now()).toISOString();
    const ended = this.#emit(record, 'paios.phase0.demo.session.ended', `owner_${reason}_${sessionId}`, endedAt, {
      reason, ended_at: endedAt, cleanup_deadline_at: terminal.cleanupDeadlineAt,
    });
    this.#ownerLifecycleObserver?.(lifecycle, sessionId);
    let removed: Phase0CleanupCounts;
    try {
      removed = await this.#cleanup(sessionId);
      assertCleanupCounts(removed);
    } catch {
      this.#terminalize(record, ended, undefined, false, undefined, 0);
      this.#ownerLifecycleObserver?.('cleanup_uncertain', sessionId);
      return false;
    }
    const truthfulRemoved: Phase0CleanupCounts = Object.freeze({
      events: removed.events + Math.max(0, record.events.length - 1),
      media_objects: removed.media_objects,
      session_rows: removed.session_rows + 1,
      model_cache_entries: removed.model_cache_entries,
    });
    const completedAt = new Date(this.#now()).toISOString();
    const cleanup = this.#emit(record, 'paios.phase0.demo.session.cleanup.completed', `owner_${reason}_${sessionId}:cleanup`, completedAt, {
      status: 'complete', completed_at: completedAt, removed: truthfulRemoved,
    });
    this.#terminalize(record, ended, cleanup, true, truthfulRemoved, 0);
    this.#ownerLifecycleObserver?.('cleanup_completed', sessionId);
    return true;
  }

  #materializeOwnerSession(pending: PendingOwnerRecord, rayneo: Phase0OwnerTerminalRegistration): void {
    const watch = pending.devices.find((device) => device.deviceClass === 'apple_watch');
    if (!watch || rayneo.deviceClass !== 'rayneo' || rayneo.readinessExpiresAtMs === undefined) throw new Error('TERMINAL_SET_INVALID');
    const input: Phase0ExistingSessionInput = {
      sessionId: pending.input.sessionId,
      startedAtMs: pending.input.startedAtMs,
      expiresAtMs: pending.input.expiresAtMs,
      cleanupDeadlineAtMs: pending.input.cleanupDeadlineAtMs,
      rayneoClientInstanceId: rayneo.clientInstanceId,
      readinessExpiresAtMs: rayneo.readinessExpiresAtMs,
      devices: [
        { deviceId: pending.input.iphone.deviceId, deviceClass: 'iphone', connectionId: pending.input.iphone.connectionId, connectionEpoch: 0 },
        { deviceId: watch.deviceId, deviceClass: 'apple_watch', connectionId: watch.connectionId, connectionEpoch: 0 },
        { deviceId: rayneo.deviceId, deviceClass: 'rayneo', connectionId: rayneo.connectionId, connectionEpoch: 0 },
      ],
    };
    const orchestrator = new SharedSessionOrchestrator(input, this.#now);
    const projector = new DemoStateProjector(input.sessionId, input.devices.map((item) => ({
      deviceId: item.deviceId, deviceClass: item.deviceClass,
    })));
    for (const event of pending.events) projector.project(event);
    this.#pendingOwner.delete(input.sessionId);
    this.#sessions.set(input.sessionId, {
      input: Object.freeze({ ...input, devices: Object.freeze(input.devices.map((item) => Object.freeze({ ...item }))) }),
      orchestrator, projector, events: [...pending.events], subscribers: pending.subscribers,
      eventFingerprints: new Map(pending.eventFingerprints),
      sequence: 0,
      cleanupUncertain: false,
    });
  }

  #liveRayneoRecord(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record) throw new Error('SESSION_NOT_FOUND');
    const snapshot = record.orchestrator.snapshot();
    const rayneo = snapshot.devices.find((item) => item.deviceClass === 'rayneo');
    if (snapshot.state !== 'live') throw new Error('SESSION_TERMINAL');
    if (!rayneo || snapshot.activeDeviceId !== rayneo.deviceId || snapshot.activeDeviceLeaseVersion !== 3) {
      throw new Error('STALE_ACTIVE_DEVICE_LEASE');
    }
    return record;
  }

  #preparePendingEvent(
    pending: PendingOwnerRecord,
    event: AcceptedDemoEvent,
  ): Readonly<{ duplicate: boolean; fingerprint: string }> {
    if (event.schema_version !== 'phase0-demo/0.4' || event.session_id !== pending.input.sessionId) {
      throw new Error('PROJECTION_EVENT_OUT_OF_SCOPE');
    }
    const fingerprint = eventFingerprint(event);
    const prior = pending.eventFingerprints.get(event.event_id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
      return Object.freeze({ duplicate: true, fingerprint });
    }
    if (pending.eventFingerprints.size >= 512) throw new Error('PROJECTION_EVENT_LIMIT');
    return Object.freeze({ duplicate: false, fingerprint });
  }

  #prepareSessionEvent(
    record: SessionRecord,
    event: AcceptedDemoEvent,
  ): Readonly<{ duplicate: boolean; fingerprint: string }> {
    if (event.schema_version !== 'phase0-demo/0.4' || event.session_id !== record.input.sessionId) {
      throw new Error('PROJECTION_EVENT_OUT_OF_SCOPE');
    }
    const fingerprint = eventFingerprint(event);
    const prior = record.eventFingerprints.get(event.event_id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error('PROJECTION_EVENT_ID_CONFLICT');
      return Object.freeze({ duplicate: true, fingerprint });
    }
    const originClass = event.origin.device_class;
    if (originClass === 'iphone' || originClass === 'apple_watch' || originClass === 'rayneo') {
      const terminal = record.input.devices.find((candidate) => candidate.deviceId === event.origin.device_id);
      if (!terminal || terminal.deviceClass !== originClass) throw new Error('PROJECTION_DEVICE_MISMATCH');
    }
    if (record.eventFingerprints.size >= 512) throw new Error('PROJECTION_EVENT_LIMIT');
    return Object.freeze({ duplicate: false, fingerprint });
  }

  #terminalize(
    record: SessionRecord,
    endedEvent: Phase0DemoEvent,
    cleanupEvent: Phase0DemoEvent | undefined,
    cleanupCompleted: boolean,
    cleanupCounts?: Phase0CleanupCounts,
    publicStopEffectCount: 0 | 1 = 1,
  ): void {
    const sessionId = record.input.sessionId;
    const terminalEvents = Object.freeze(cleanupEvent === undefined ? [endedEvent] : [endedEvent, cleanupEvent]);
    record.subscribers.clear();
    record.events.splice(0, record.events.length);
    this.#sessions.delete(sessionId);
    this.#terminal.set(sessionId, Object.freeze({
      sessionId,
      publicStopEffectCount,
      cleanupCompleted,
      events: terminalEvents,
      ...(cleanupCounts === undefined ? {} : { cleanupCounts }),
    }));
  }

  #emit(
    record: SessionRecord,
    eventType: string,
    idempotencyKey: string,
    occurredAt: string,
    payload: Readonly<Record<string, unknown>>,
  ): Phase0DemoEvent {
    const snapshot = record.orchestrator.snapshot();
    const rayneo = snapshot.devices.find((item) => item.deviceClass === 'rayneo');
    if (!rayneo) throw new Error('TERMINAL_SET_INVALID');
    const eventId = this.#randomUuid();
    const traceId = this.#randomUuid();
    const sequence = record.sequence + 1;
    const event: Phase0DemoEvent = Object.freeze({
      schema_version: 'phase0-demo/0.4',
      event_type: eventType,
      event_id: eventId,
      session_id: snapshot.sessionId,
      trace_id: traceId,
      occurred_at: occurredAt,
      expires_at: new Date(snapshot.cleanupDeadlineAtMs).toISOString(),
      origin: Object.freeze({
        device_id: rayneo.deviceId,
        device_class: 'rayneo',
        client_instance_id: record.input.rayneoClientInstanceId,
      }),
      connection: Object.freeze({ id: rayneo.connectionId, epoch: rayneo.connectionEpoch, state: 'connected' }),
      sequence: Object.freeze({
        stream_id: `rayneo_gateway_${snapshot.sessionId.slice(-20)}`,
        number: sequence,
        ...(record.previousEventId === undefined ? {} : { previous_event_id: record.previousEventId }),
      }),
      idempotency_key: idempotencyKey,
      payload: Object.freeze(payload),
    });
    record.projector.project(event);
    record.eventFingerprints.set(event.event_id, eventFingerprint(event));
    record.sequence = sequence;
    record.previousEventId = eventId;
    record.events.push(event);
    for (const subscriber of record.subscribers) subscriber(event);
    return event;
  }
}
