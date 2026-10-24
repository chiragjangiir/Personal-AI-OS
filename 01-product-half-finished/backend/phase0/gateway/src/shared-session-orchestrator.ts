import { createHash } from 'node:crypto';

export type TerminalDeviceClass = 'iphone' | 'apple_watch' | 'rayneo';
export type SharedSessionMode = 'shared_handoff' | 'rayneo_standalone';
export type SharedSessionState = 'live' | 'terminal';
export type SharedSessionTerminalReason = 'user_stop' | 'timeout' | 'error';

export interface SharedTerminalRegistration {
  readonly deviceId: string;
  readonly deviceClass: TerminalDeviceClass;
  readonly connectionId: string;
  readonly connectionEpoch?: number;
}

export interface SharedSessionInput {
  readonly mode?: SharedSessionMode;
  /** Exact RayNeo standalone override; all other sessions retain the one-hour contract. */
  readonly rayneoStandaloneSessionDurationMs?: number;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly cleanupDeadlineAtMs: number;
  readonly devices: readonly SharedTerminalRegistration[];
}

export interface HandoffRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly fromDeviceId: string;
  readonly toDeviceId: string;
  readonly expectedLeaseVersion: number;
  readonly occurredAt: string;
}

export interface HandoffResult {
  readonly requestId: string;
  readonly sessionId: string;
  readonly activeDeviceId: string;
  readonly activeDeviceLeaseVersion: number;
  readonly suppressedDeviceId: string;
  readonly oldDeviceOutputSuppressed: true;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly retry: boolean;
}

export interface ReconnectRequest {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly previousConnectionId: string;
  readonly newConnectionId: string;
  readonly previousEpoch: number;
}

export interface PublicStopRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly initiatingDeviceId: string;
  readonly expectedActiveDeviceLeaseVersion: number;
  readonly reason: 'user_stop';
  readonly occurredAt: string;
}

export interface SharedSessionSnapshot {
  readonly sessionId: string;
  readonly state: SharedSessionState;
  readonly activeDeviceId: string;
  readonly activeDeviceLeaseVersion: number;
  readonly suppressedDeviceIds: readonly string[];
  readonly publicStopEffectCount: number;
  readonly expiresAtMs: number;
  readonly cleanupDeadlineAtMs: number;
  readonly devices: readonly Readonly<{
    deviceId: string;
    deviceClass: TerminalDeviceClass;
    connectionId: string;
    connectionEpoch: number;
    locallyTornDown: boolean;
  }>[];
}

interface MutableDevice {
  readonly deviceId: string;
  readonly deviceClass: TerminalDeviceClass;
  connectionId: string;
  connectionEpoch: number;
  readonly usedConnectionIds: Set<string>;
  locallyTornDown: boolean;
}

const SESSION_DURATION_MS = 3_600_000;
const RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS = 86_400_000;
const CLEANUP_GRACE_MS = 5_000;
const MAX_HANDOFF_LATENCY_MS = 9_999;

function assertScopedId(value: string, code: string): void {
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(value)) throw new Error(code);
}

function validSessionDuration(input: SharedSessionInput): boolean {
  const duration = input.expiresAtMs - input.startedAtMs;
  const explicit = input.rayneoStandaloneSessionDurationMs;
  if (explicit === undefined) return duration === SESSION_DURATION_MS;
  return input.mode === 'rayneo_standalone' && Number.isSafeInteger(explicit) &&
    explicit === RAYNEO_STANDALONE_EXTENDED_SESSION_DURATION_MS && duration === explicit;
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

function asUtcMs(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return parsed;
}

/**
 * Temporary in-memory Phase-0 session state. The class deliberately owns no
 * route, listener, durable store, credential, media, or device side effect.
 */
export class SharedSessionOrchestrator {
  readonly #sessionId: string;
  readonly #startedAtMs: number;
  readonly #expiresAtMs: number;
  readonly #cleanupDeadlineAtMs: number;
  readonly #devices = new Map<string, MutableDevice>();
  readonly #devicesByClass = new Map<TerminalDeviceClass, MutableDevice>();
  readonly #handoffRetries = new Map<string, { fingerprint: string; result: HandoffResult }>();
  readonly #suppressed = new Set<string>();
  readonly #now: () => number;
  #state: SharedSessionState = 'live';
  #activeDeviceId: string;
  #activeDeviceLeaseVersion = 1;
  #publicStopEffectCount = 0;

  constructor(input: SharedSessionInput, now: () => number = Date.now) {
    assertScopedId(input.sessionId, 'SESSION_ID_INVALID');
    if (
      !Number.isSafeInteger(input.startedAtMs) ||
      !Number.isSafeInteger(input.expiresAtMs) ||
      !Number.isSafeInteger(input.cleanupDeadlineAtMs) ||
      !validSessionDuration(input) ||
      input.cleanupDeadlineAtMs !== input.expiresAtMs + CLEANUP_GRACE_MS
    ) throw new Error('SESSION_TTL_INVALID');
    const mode = input.mode ?? 'shared_handoff';
    if (
      (mode === 'shared_handoff' && input.devices.length !== 3) ||
      (mode === 'rayneo_standalone' && input.devices.length !== 1)
    ) throw new Error('TERMINAL_SET_INVALID');
    for (const registration of input.devices) {
      assertScopedId(registration.deviceId, 'DEVICE_ID_INVALID');
      assertScopedId(registration.connectionId, 'CONNECTION_ID_INVALID');
      if (this.#devices.has(registration.deviceId) || this.#devicesByClass.has(registration.deviceClass)) {
        throw new Error('TERMINAL_SET_INVALID');
      }
      const epoch = registration.connectionEpoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('CONNECTION_EPOCH_INVALID');
      const device: MutableDevice = {
        deviceId: registration.deviceId,
        deviceClass: registration.deviceClass,
        connectionId: registration.connectionId,
        connectionEpoch: epoch,
        usedConnectionIds: new Set([registration.connectionId]),
        locallyTornDown: false,
      };
      this.#devices.set(device.deviceId, device);
      this.#devicesByClass.set(device.deviceClass, device);
    }
    const iphone = this.#devicesByClass.get('iphone');
    const rayneo = this.#devicesByClass.get('rayneo');
    if (mode === 'shared_handoff') {
      if (!iphone || !this.#devicesByClass.has('apple_watch') || !rayneo) throw new Error('TERMINAL_SET_INVALID');
    } else if (!rayneo || iphone || this.#devicesByClass.has('apple_watch')) {
      throw new Error('TERMINAL_SET_INVALID');
    }
    this.#sessionId = input.sessionId;
    this.#startedAtMs = input.startedAtMs;
    this.#expiresAtMs = input.expiresAtMs;
    this.#cleanupDeadlineAtMs = input.cleanupDeadlineAtMs;
    this.#activeDeviceId = mode === 'shared_handoff' ? iphone!.deviceId : rayneo!.deviceId;
    // Low-rate and signed Stop use lease generation 3 as the RayNeo-active
    // fencing token. A standalone session starts at that generation without
    // inventing iPhone/Watch terminals or synthetic handoff events.
    if (mode === 'rayneo_standalone') this.#activeDeviceLeaseVersion = 3;
    this.#now = now;
  }

  snapshot(): SharedSessionSnapshot {
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      activeDeviceId: this.#activeDeviceId,
      activeDeviceLeaseVersion: this.#activeDeviceLeaseVersion,
      suppressedDeviceIds: [...this.#suppressed],
      publicStopEffectCount: this.#publicStopEffectCount,
      expiresAtMs: this.#expiresAtMs,
      cleanupDeadlineAtMs: this.#cleanupDeadlineAtMs,
      devices: [...this.#devices.values()].map((device) => ({
        deviceId: device.deviceId,
        deviceClass: device.deviceClass,
        connectionId: device.connectionId,
        connectionEpoch: device.connectionEpoch,
        locallyTornDown: device.locallyTornDown,
      })),
    };
  }

  handoff(request: HandoffRequest): HandoffResult {
    this.#assertLive();
    this.#assertSameSession(request.sessionId);
    assertScopedId(request.requestId, 'HANDOFF_REQUEST_ID_INVALID');
    const fingerprint = digest(request);
    const prior = this.#handoffRetries.get(request.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return { ...prior.result, retry: true };
    }
    const occurredAtMs = asUtcMs(request.occurredAt, 'HANDOFF_TIME_INVALID');
    const completedAtMs = this.#now();
    if (occurredAtMs < this.#startedAtMs || occurredAtMs >= this.#expiresAtMs || completedAtMs >= this.#expiresAtMs) {
      throw new Error('SESSION_TERMINAL');
    }
    const latencyMs = completedAtMs - occurredAtMs;
    if (latencyMs < 0 || latencyMs > MAX_HANDOFF_LATENCY_MS) throw new Error('HANDOFF_LATENCY_EXCEEDED');
    if (
      request.fromDeviceId !== this.#activeDeviceId ||
      request.expectedLeaseVersion !== this.#activeDeviceLeaseVersion
    ) throw new Error('STALE_ACTIVE_DEVICE_LEASE');
    if (request.fromDeviceId === request.toDeviceId || !this.#devices.has(request.toDeviceId)) {
      throw new Error('HANDOFF_TARGET_INVALID');
    }
    const expectedTarget = this.#activeDeviceLeaseVersion === 1
      ? this.#devicesByClass.get('apple_watch')
      : this.#activeDeviceLeaseVersion === 2
        ? this.#devicesByClass.get('rayneo')
        : undefined;
    if (!expectedTarget || request.toDeviceId !== expectedTarget.deviceId) throw new Error('HANDOFF_ORDER_INVALID');

    this.#suppressed.add(request.fromDeviceId);
    this.#suppressed.delete(request.toDeviceId);
    this.#activeDeviceId = request.toDeviceId;
    this.#activeDeviceLeaseVersion += 1;
    const result: HandoffResult = Object.freeze({
      requestId: request.requestId,
      sessionId: this.#sessionId,
      activeDeviceId: this.#activeDeviceId,
      activeDeviceLeaseVersion: this.#activeDeviceLeaseVersion,
      suppressedDeviceId: request.fromDeviceId,
      oldDeviceOutputSuppressed: true,
      completedAt: new Date(completedAtMs).toISOString(),
      latencyMs,
      retry: false,
    });
    this.#handoffRetries.set(request.requestId, { fingerprint, result });
    return result;
  }

  deliveryDisposition(targetDeviceId: string, leaseVersion: number): 'render' | 'ignored_stale_lease' {
    this.#assertLive();
    if (
      targetDeviceId !== this.#activeDeviceId ||
      leaseVersion !== this.#activeDeviceLeaseVersion ||
      this.#suppressed.has(targetDeviceId)
    ) return 'ignored_stale_lease';
    return 'render';
  }

  reconnect(request: ReconnectRequest): Readonly<{ deviceId: string; connectionId: string; connectionEpoch: number }> {
    this.#assertLive();
    this.#assertSameSession(request.sessionId);
    const device = this.#devices.get(request.deviceId);
    if (!device) throw new Error('DEVICE_NOT_ADMITTED');
    assertScopedId(request.newConnectionId, 'CONNECTION_ID_INVALID');
    if (
      request.previousConnectionId !== device.connectionId ||
      request.previousEpoch !== device.connectionEpoch ||
      device.usedConnectionIds.has(request.newConnectionId)
    ) throw new Error('RECONNECT_BINDING_INVALID');
    device.connectionId = request.newConnectionId;
    device.connectionEpoch += 1;
    device.usedConnectionIds.add(request.newConnectionId);
    return Object.freeze({
      deviceId: device.deviceId,
      connectionId: device.connectionId,
      connectionEpoch: device.connectionEpoch,
    });
  }

  publicStop(request: PublicStopRequest): Readonly<{
    status: 'stop_accepted';
    publicStopEffectCount: 1;
    cleanupDeadlineAt: string;
  }> {
    this.#assertLive();
    this.#assertSameSession(request.sessionId);
    assertScopedId(request.requestId, 'STOP_REQUEST_ID_INVALID');
    const occurredAtMs = asUtcMs(request.occurredAt, 'STOP_TIME_INVALID');
    const rayneo = this.#devicesByClass.get('rayneo');
    if (
      !rayneo ||
      request.initiatingDeviceId !== rayneo.deviceId ||
      request.initiatingDeviceId !== this.#activeDeviceId ||
      request.expectedActiveDeviceLeaseVersion !== 3 ||
      this.#activeDeviceLeaseVersion !== 3 ||
      occurredAtMs < this.#startedAtMs ||
      occurredAtMs >= this.#expiresAtMs ||
      occurredAtMs > this.#now() + 5_000
    ) throw new Error('STOP_AUTHORITY_INVALID');
    this.#publicStopEffectCount = 1;
    this.#state = 'terminal';
    const cleanupDeadline = Math.min(this.#cleanupDeadlineAtMs, occurredAtMs + CLEANUP_GRACE_MS);
    return Object.freeze({
      status: 'stop_accepted',
      publicStopEffectCount: 1,
      cleanupDeadlineAt: new Date(cleanupDeadline).toISOString(),
    });
  }

  /** Owner-only terminal fence for TTL, pairing revoke, or an owner error. */
  terminate(reason: Exclude<SharedSessionTerminalReason, 'user_stop'>): Readonly<{
    reason: typeof reason;
    cleanupDeadlineAt: string;
  }> {
    if (this.#state !== 'live' || this.#now() < this.#startedAtMs) throw new Error('SESSION_TERMINAL');
    this.#state = 'terminal';
    return Object.freeze({
      reason,
      cleanupDeadlineAt: new Date(Math.min(this.#cleanupDeadlineAtMs, this.#now() + CLEANUP_GRACE_MS)).toISOString(),
    });
  }

  localTeardown(deviceId: string): void {
    if (this.#state !== 'terminal') throw new Error('SESSION_NOT_TERMINAL');
    const device = this.#devices.get(deviceId);
    if (!device) throw new Error('DEVICE_NOT_ADMITTED');
    if (device.deviceClass === 'rayneo') throw new Error('PUBLIC_STOP_INITIATOR_NOT_LOCAL_ONLY');
    device.locallyTornDown = true;
  }

  #assertLive(): void {
    const now = this.#now();
    if (this.#state !== 'live' || now < this.#startedAtMs || now >= this.#expiresAtMs) {
      throw new Error('SESSION_TERMINAL');
    }
  }

  #assertSameSession(sessionId: string): void {
    if (sessionId !== this.#sessionId) throw new Error('SESSION_NOT_FOUND');
  }
}
