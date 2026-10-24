/**
 * Internal, non-canonical, non-wire reconnect backoff policy.
 *
 * The policy only returns a bounded delay.  It never owns a timer, starts a
 * connection, republishes a track, or renews continuity.  The caller supplies
 * the stop/deadline fence and owns the LiveKit SDK operation.
 */

export type ReconnectRejectReason =
  | 'STOPPED'
  | 'MAX_ATTEMPTS'
  | 'MAX_ELAPSED'
  | 'DEADLINE_EXPIRED'
  | 'DEADLINE_FENCE'
  | 'INVALID_ATTEMPT'
  | 'INVALID_CLOCK'
  | 'INVALID_ENTROPY'
  | 'INVALID_POLICY';

export interface ReconnectPolicyClock {
  readonly nowMs: () => number;
}

export interface ReconnectPolicyOptions {
  /** Initial exponential window. Attempt zero uses this value. */
  readonly baseDelayMs?: number;
  readonly base_delay_ms?: number;
  /** Inclusive upper bound of the exponential window. */
  readonly capDelayMs?: number;
  readonly cap_delay_ms?: number;
  /** Number of attempts admitted, with attempt zero as the first attempt. */
  readonly maxAttempts?: number;
  readonly max_attempts?: number;
  /** Optional elapsed-time fence measured from `startedAtMs`. */
  readonly maxElapsedMs?: number;
  readonly max_elapsed_ms?: number;
  /** Injected monotonic-ish observation clock. */
  readonly nowMs?: () => number;
  /** Explicit alias accepted for callers that call the dependency a clock. */
  readonly clock?: () => number;
  /** Injected entropy in [0, 1). Math.random is never used by this module. */
  readonly entropy?: () => number;
  /** Explicit alias accepted for callers that call the dependency a random source. */
  readonly random?: () => number;
}

export interface ReconnectScheduleInput {
  readonly attempt: number;
  readonly atMs?: number;
  readonly at_ms?: number;
  readonly nowMs?: number;
  readonly now_ms?: number;
  readonly startedAtMs?: number;
  readonly started_at_ms?: number;
  readonly stopped?: boolean;
  readonly stop?: boolean;
  readonly stopAtMs?: number;
  readonly stop_at_ms?: number;
  readonly credentialExpiresAtMs?: number;
  readonly credential_expires_at_ms?: number;
  readonly credentialDeadlineMs?: number;
  readonly credential_deadline_ms?: number;
  readonly continuityExpiresAtMs?: number;
  readonly continuity_expires_at_ms?: number;
  readonly continuityDeadlineMs?: number;
  readonly continuity_deadline_ms?: number;
  /** Optional deterministic entropy sample for one stateless decision. */
  readonly entropy?: number;
}

export interface ReconnectSchedule {
  readonly accepted: boolean;
  readonly attempt: number;
  readonly delayMs: number;
  readonly nowMs: number;
  readonly nextAtMs?: number;
  readonly deadlineMs?: number;
  readonly reason?: ReconnectRejectReason;
}

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_CAP_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;

function reject(
  input: ReconnectScheduleInput,
  nowMs: number,
  reason: ReconnectRejectReason,
  deadlineMs?: number,
): ReconnectSchedule {
  return Object.freeze({
    accepted: false,
    attempt: input.attempt,
    delayMs: 0,
    nowMs,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    reason,
  });
}

function finiteNonNegative(value: number, reason: ReconnectRejectReason): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(reason);
  return value;
}

function positiveInteger(value: number, reason: ReconnectRejectReason): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(reason);
  return value;
}

function validateEntropy(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error('INVALID_ENTROPY');
  }
  return value;
}

function exponentialWindow(attempt: number, baseDelayMs: number, capDelayMs: number): number {
  // The cap is applied during multiplication, so very large attempts cannot
  // overflow and cannot create an unbounded timer request.
  let window = baseDelayMs;
  for (let index = 0; index < attempt && window < capDelayMs; index += 1) {
    window = Math.min(capDelayMs, window * 2);
  }
  return Math.min(capDelayMs, window);
}

/** Return a full-jitter delay for one attempt using injected entropy. */
export function fullJitterDelay(
  attempt: number,
  options: {
    readonly baseDelayMs?: number;
    readonly base_delay_ms?: number;
    readonly capDelayMs?: number;
    readonly cap_delay_ms?: number;
    readonly entropy: number;
  },
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('INVALID_ATTEMPT');
  const base = options.baseDelayMs ?? options.base_delay_ms ?? DEFAULT_BASE_DELAY_MS;
  const cap = options.capDelayMs ?? options.cap_delay_ms ?? DEFAULT_CAP_DELAY_MS;
  if (!Number.isFinite(base) || !Number.isFinite(cap) || base < 1 || cap < base) {
    throw new Error('INVALID_POLICY');
  }
  const entropy = validateEntropy(options.entropy);
  return Math.max(1, Math.floor(exponentialWindow(attempt, base, cap) * entropy));
}

/** Stateless helper for callers that do not need a policy object. */
export function computeReconnectDelay(
  input: ReconnectScheduleInput,
  options: ReconnectPolicyOptions = {},
): ReconnectSchedule {
  if (input.stopped === true || input.stop === true) return reject(input, 0, 'STOPPED');
  const hasExplicitNow = input.nowMs !== undefined
    || input.now_ms !== undefined
    || input.atMs !== undefined
    || input.at_ms !== undefined;
  const hasInjectedClock = options.nowMs !== undefined || options.clock !== undefined;
  if (!hasExplicitNow && !hasInjectedClock) {
    return reject(input, 0, 'INVALID_CLOCK');
  }
  let nowMs: number;
  try {
    nowMs = input.nowMs
      ?? input.now_ms
      ?? input.atMs
      ?? input.at_ms
      ?? options.nowMs?.()
      ?? options.clock?.()
      ?? Number.NaN;
  } catch {
    return reject(input, 0, 'INVALID_CLOCK');
  }
  try {
    finiteNonNegative(nowMs, 'INVALID_CLOCK');
  } catch {
    return reject(input, 0, 'INVALID_CLOCK');
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    return reject(input, nowMs, 'INVALID_ATTEMPT');
  }
  const base = options.baseDelayMs ?? options.base_delay_ms ?? DEFAULT_BASE_DELAY_MS;
  const cap = options.capDelayMs ?? options.cap_delay_ms ?? DEFAULT_CAP_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? options.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxElapsed = options.maxElapsedMs ?? options.max_elapsed_ms;
  try {
    if (!Number.isFinite(base) || !Number.isFinite(cap) || base < 1 || cap < base) {
      throw new Error('INVALID_POLICY');
    }
    positiveInteger(maxAttempts, 'INVALID_POLICY');
    if (maxElapsed !== undefined) finiteNonNegative(maxElapsed, 'INVALID_POLICY');
    if (input.attempt >= maxAttempts) return reject(input, nowMs, 'MAX_ATTEMPTS');
  } catch (error) {
    const reason = error instanceof Error && error.message === 'INVALID_POLICY'
      ? 'INVALID_POLICY'
      : 'INVALID_POLICY';
    return reject(input, nowMs, reason);
  }

  let elapsedRemaining: number | undefined;
  if (maxElapsed !== undefined) {
    const startedAtMs = input.startedAtMs ?? input.started_at_ms;
    if (startedAtMs === undefined) return reject(input, nowMs, 'MAX_ELAPSED');
    try {
      const startedAt = finiteNonNegative(startedAtMs, 'INVALID_CLOCK');
      const elapsed = nowMs - startedAt;
      if (elapsed < 0) return reject(input, nowMs, 'INVALID_CLOCK');
      elapsedRemaining = maxElapsed - elapsed;
      if (elapsedRemaining <= 0) return reject(input, nowMs, 'MAX_ELAPSED');
    } catch {
      return reject(input, nowMs, 'INVALID_CLOCK');
    }
  }

  const deadlines = [
    input.stopAtMs ?? input.stop_at_ms,
    input.credentialExpiresAtMs
      ?? input.credential_expires_at_ms
      ?? input.credentialDeadlineMs
      ?? input.credential_deadline_ms,
    input.continuityExpiresAtMs
      ?? input.continuity_expires_at_ms
      ?? input.continuityDeadlineMs
      ?? input.continuity_deadline_ms,
  ].filter((value): value is number => value !== undefined);
  try {
    deadlines.forEach((deadline) => finiteNonNegative(deadline, 'INVALID_CLOCK'));
  } catch {
    return reject(input, nowMs, 'INVALID_CLOCK');
  }
  const deadlineMs = deadlines.length === 0 ? undefined : Math.min(...deadlines);
  if (deadlineMs !== undefined && nowMs >= deadlineMs) {
    return reject(input, nowMs, 'DEADLINE_EXPIRED', deadlineMs);
  }

  let entropy: number;
  try {
    const entropyValue = input.entropy
      ?? options.entropy?.()
      ?? options.random?.();
    if (entropyValue === undefined) throw new Error('INVALID_ENTROPY');
    entropy = validateEntropy(entropyValue);
  } catch {
    return reject(input, nowMs, 'INVALID_ENTROPY', deadlineMs);
  }
  const delayMs = fullJitterDelay(input.attempt, { baseDelayMs: base, capDelayMs: cap, entropy });
  const fences = [
    ...(deadlineMs === undefined ? [] : [deadlineMs - nowMs]),
    ...(elapsedRemaining === undefined ? [] : [elapsedRemaining]),
  ];
  const remainingFence = fences.length === 0 ? undefined : Math.min(...fences);
  if (remainingFence !== undefined && delayMs >= remainingFence) {
    return reject(input, nowMs, 'DEADLINE_FENCE', deadlineMs);
  }
  const nextAtMs = nowMs + delayMs;
  return Object.freeze({
    accepted: true,
    attempt: input.attempt,
    delayMs,
    nowMs,
    nextAtMs,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
}

/**
 * Stateful facade around the pure policy. `stop()` is a one-way local fence;
 * the durable Stop/lease authority remains outside this package.
 */
export class ReconnectPolicy {
  readonly #options: ReconnectPolicyOptions;
  #stopped = false;

  constructor(options: ReconnectPolicyOptions = {}) {
    this.#options = Object.freeze({ ...options });
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
  }

  schedule(input: ReconnectScheduleInput): ReconnectSchedule {
    return computeReconnectDelay(
      { ...input, stopped: this.#stopped || input.stopped === true },
      this.#options,
    );
  }

  next(input: ReconnectScheduleInput): ReconnectSchedule {
    return this.schedule(input);
  }
}

export const CappedExponentialFullJitterPolicy = ReconnectPolicy;
export const ReconnectionPolicy = ReconnectPolicy;
export const createReconnectPolicy = (options: ReconnectPolicyOptions = {}): ReconnectPolicy =>
  new ReconnectPolicy(options);
export const nextReconnectDelay = computeReconnectDelay;
export const calculateReconnectDelay = computeReconnectDelay;
export const planReconnect = computeReconnectDelay;
export type ReconnectDecision = ReconnectSchedule;
