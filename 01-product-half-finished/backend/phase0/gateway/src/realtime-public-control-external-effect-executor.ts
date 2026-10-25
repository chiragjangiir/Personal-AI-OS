import { createHash } from "node:crypto";

import type {
  JsonRecord,
  RealtimeExternalEffectExecutor,
  RealtimeMediaCleanupStage,
  RealtimeMediaStopIntent,
} from "../../../services/platform-data/src/realtime-external-effect-coordinator.ts";

const MEDIA_STAGES = [
  "tracks_unpublished",
  "participant_disconnected",
  "credential_revoked",
  "closure_verified",
] as const satisfies readonly RealtimeMediaCleanupStage[];

const MEDIA_STAGE_SET = new Set<RealtimeMediaCleanupStage>(MEDIA_STAGES);
const CONNECTION_EPOCH = /^[1-9][0-9]{0,38}$/;
const NONEMPTY_TEXT = /^.{1,262144}$/su;
const FENCING_TOKEN = /^[1-9][0-9]{0,37}$/u;
const ALLOWED_FENCING_TOKEN_PARENT = "result.old_device_suppression_fence";
const SECRET_KEY = /(?:token|secret|password|private[_-]?key|key[_-]?material|api[_-]?key|credential)/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SANITIZED_BYTES = 262_144;

/** The authoritative identity of the RTC resources being cleaned up. */
export interface RealtimeExternalEffectBinding {
  readonly realtimeSessionRef: unknown;
  readonly deviceLeaseRef: unknown;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly deviceId: string;
  readonly roomName: string;
  readonly participantIdentity: string;
  /** Set for a media stop: the lease generation it stops (its fence), which outlives the lease's own release. */
  readonly fenceGeneration?: string;
}

export interface RealtimeExternalEffectOperationContext {
  readonly binding: RealtimeExternalEffectBinding;
  readonly fingerprint: string;
}

export interface RealtimeExternalEffectHandoffContext extends RealtimeExternalEffectOperationContext {
  readonly operation: "handoff";
}

/**
 * This resolver is the only identity boundary in this executor. It must be
 * backed by the current T02/T11B/LiveKit owner, rather than request fields.
 */
export interface RealtimeExternalEffectBindingResolver {
  readonly environment: "production";
  readonly isReady: () => boolean;
  readonly resolveMediaStop: (input: {
    readonly intent: RealtimeMediaStopIntent;
  }) => Promise<RealtimeExternalEffectBinding>;
  readonly resolveHandoff: (input: {
    readonly request: JsonRecord;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }) => Promise<RealtimeExternalEffectBinding>;
  readonly close?: () => void | Promise<void>;
}

/**
 * A concrete owner should adapt LiveKit/device/session operations to this
 * interface. Every method is required so a production composition cannot
 * silently replace a real effect with a no-op.
 */
export interface RealtimeExternalEffectOwner {
  readonly environment: "production";
  readonly isReady: () => boolean;
  readonly unpublishTracks: (input: RealtimeExternalEffectOperationContext) => Promise<void>;
  readonly disconnectParticipant: (input: RealtimeExternalEffectOperationContext) => Promise<void>;
  readonly revokeCredential: (input: RealtimeExternalEffectOperationContext) => Promise<void>;
  readonly verifyClosed: (input: RealtimeExternalEffectOperationContext) => Promise<void>;
  readonly suppressAndClose: (input: RealtimeExternalEffectHandoffContext) => Promise<unknown>;
  readonly close?: () => void | Promise<void>;
}

export interface RealtimeExternalEffectExecutorReadiness {
  readonly ready: boolean;
  readonly closed: boolean;
  readonly owner: boolean;
  readonly binding: boolean;
}

export interface RealtimePublicControlExternalEffectExecutorOptions {
  readonly owner: RealtimeExternalEffectOwner;
  readonly binding: RealtimeExternalEffectBindingResolver;
  readonly timeoutMs?: number;
}

export interface RealtimePublicControlExternalEffectExecutor extends RealtimeExternalEffectExecutor {
  readonly executeStage: NonNullable<RealtimeExternalEffectExecutor["executeStage"]>;
  readonly executeMediaStage: NonNullable<RealtimeExternalEffectExecutor["executeMediaStage"]>;
  readonly suppressAndClose: NonNullable<RealtimeExternalEffectExecutor["suppressAndClose"]>;
  readonly executeHandoffSuppression: NonNullable<RealtimeExternalEffectExecutor["executeHandoffSuppression"]>;
  readonly close: () => Promise<void>;
  readonly readiness: () => RealtimeExternalEffectExecutorReadiness;
  readonly assertReady: () => void;
}

export class RealtimePublicControlExternalEffectExecutorError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ExternalEffectExecutorError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlExternalEffectExecutorError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertProductionPort(value: unknown, name: string): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function") ||
      (value as { readonly environment?: unknown }).environment !== "production" ||
      typeof (value as { readonly isReady?: unknown }).isReady !== "function") {
    fail(`EXTERNAL_EFFECT_${name.toUpperCase()}_PORT_INVALID`);
  }
}

function assertCallable(value: unknown, name: string): void {
  if (typeof value !== "function") fail(`EXTERNAL_EFFECT_${name.toUpperCase()}_REQUIRED`);
}

function assertClosedJson(value: unknown, seen = new WeakSet<object>(), path = "result"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EXTERNAL_EFFECT_RESULT_INVALID");
    return;
  }
  if (typeof value !== "object") fail("EXTERNAL_EFFECT_RESULT_INVALID");
  if (seen.has(value)) fail("EXTERNAL_EFFECT_RESULT_CYCLIC");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertClosedJson(value[index], seen, `${path}[${index}]`);
    }
  } else {
    if (!isRecord(value)) fail("EXTERNAL_EFFECT_RESULT_INVALID");
    for (const key of Reflect.ownKeys(value)) {
      const allowedFencingToken = path === ALLOWED_FENCING_TOKEN_PARENT && key === "fencing_token";
      if (typeof key !== "string" || (SECRET_KEY.test(key) && !allowedFencingToken)) fail("EXTERNAL_EFFECT_RESULT_UNSAFE");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) fail("EXTERNAL_EFFECT_RESULT_INVALID");
      if (allowedFencingToken && (typeof descriptor.value !== "string" || !FENCING_TOKEN.test(descriptor.value))) {
        fail("EXTERNAL_EFFECT_RESULT_FENCE_INVALID");
      }
      assertClosedJson(descriptor.value, seen, `${path}.${key}`);
    }
  }
  seen.delete(value);
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const child of value) clone.push(cloneAndFreeze(child, seen));
    return Object.freeze(clone) as T;
  }
  if (!isRecord(value)) fail("EXTERNAL_EFFECT_RESULT_INVALID");
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) clone[key] = cloneAndFreeze(value[key], seen);
  return Object.freeze(clone) as T;
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!isRecord(value) && !Array.isArray(value)) fail("EXTERNAL_EFFECT_INTENT_INVALID");
  if (seen.has(value)) fail("EXTERNAL_EFFECT_INTENT_CYCLIC");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((child) => stableJson(child, seen)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function assertBinding(value: unknown): asserts value is RealtimeExternalEffectBinding {
  if (!isRecord(value)) fail("EXTERNAL_EFFECT_BINDING_INVALID");
  const keys = Object.keys(value).sort();
  const expected = [
    "connectionEpoch",
    "continuityId",
    "deviceId",
    "deviceLeaseRef",
    ...("fenceGeneration" in value ? ["fenceGeneration"] : []),
    "participantIdentity",
    "realtimeSessionRef",
    "roomName",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("EXTERNAL_EFFECT_BINDING_INVALID");
  }
  if (value.realtimeSessionRef === null || value.realtimeSessionRef === undefined ||
      value.deviceLeaseRef === null || value.deviceLeaseRef === undefined) {
    fail("EXTERNAL_EFFECT_BINDING_INVALID");
  }
  for (const key of ["continuityId", "deviceId", "roomName", "participantIdentity"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 256) {
      fail("EXTERNAL_EFFECT_BINDING_INVALID");
    }
  }
  if (typeof value.connectionEpoch !== "string" || !CONNECTION_EPOCH.test(value.connectionEpoch)) {
    fail("EXTERNAL_EFFECT_BINDING_INVALID");
  }
  if ("fenceGeneration" in value && (typeof value.fenceGeneration !== "string" || !CONNECTION_EPOCH.test(value.fenceGeneration))) {
    fail("EXTERNAL_EFFECT_BINDING_INVALID");
  }
  assertClosedJson(value);
}

function assertIntent(intent: unknown): asserts intent is RealtimeMediaStopIntent {
  if (!isRecord(intent) || typeof intent.fingerprint !== "string" || !NONEMPTY_TEXT.test(intent.fingerprint)) {
    fail("EXTERNAL_EFFECT_INTENT_INVALID");
  }
  if (!isRecord(intent.request) || intent.request.operation !== "media_stop") {
    fail("EXTERNAL_EFFECT_INTENT_INVALID");
  }
}

function assertHandoffInput(input: unknown): asserts input is {
  readonly request: JsonRecord;
  readonly authorityResult: unknown;
} {
  if (!isRecord(input) || !isRecord(input.request)) fail("EXTERNAL_EFFECT_HANDOFF_INVALID");
}

function assertSafeResult(value: unknown): unknown {
  assertClosedJson(value);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_SANITIZED_BYTES) fail("EXTERNAL_EFFECT_RESULT_TOO_LARGE");
  return cloneAndFreeze(value);
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RealtimePublicControlExternalEffectExecutorError("EXTERNAL_EFFECT_TIMEOUT")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function invokeOwned<T>(operation: () => Promise<T>, timeoutMs: number, failureCode: string): Promise<T> {
  try {
    return await withTimeout(operation, timeoutMs);
  } catch (error) {
    if (error instanceof RealtimePublicControlExternalEffectExecutorError) throw error;
    // The wire keeps the coarse code; the operator log names the owner's identifier-shaped cause.
    const cause = (error as { code?: unknown } | undefined)?.code;
    try {
      process.stderr.write(`${JSON.stringify({ external_effect_failed: failureCode,
        cause: typeof cause === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(cause) ? cause : "unclassified" })}\n`);
    } catch { /* logging is best effort */ }
    throw new RealtimePublicControlExternalEffectExecutorError(failureCode);
  }
}

export function createRealtimePublicControlExternalEffectExecutor(
  options: RealtimePublicControlExternalEffectExecutorOptions,
): RealtimePublicControlExternalEffectExecutor {
  if (!isRecord(options)) fail("EXTERNAL_EFFECT_OPTIONS_INVALID");
  assertProductionPort(options.owner, "owner");
  assertProductionPort(options.binding, "binding");
  const owner = options.owner;
  const binding = options.binding;
  const ownerMethods = [
    ["unpublishTracks", owner.unpublishTracks],
    ["disconnectParticipant", owner.disconnectParticipant],
    ["revokeCredential", owner.revokeCredential],
    ["verifyClosed", owner.verifyClosed],
    ["suppressAndClose", owner.suppressAndClose],
  ] as const;
  for (const [name, method] of ownerMethods) assertCallable(method, name);
  assertCallable(binding.resolveMediaStop, "binding_resolve_media_stop");
  assertCallable(binding.resolveHandoff, "binding_resolve_handoff");
  if (owner.close !== undefined) assertCallable(owner.close, "owner_close");
  if (binding.close !== undefined) assertCallable(binding.close, "binding_close");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    fail("EXTERNAL_EFFECT_TIMEOUT_INVALID");
  }

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const flights = new Set<Promise<unknown>>();
  const activeStages = new Map<string, { readonly intentDigest: string; readonly promise: Promise<void> }>();
  const activeHandoffs = new Map<string, { readonly inputDigest: string; readonly promise: Promise<unknown> }>();
  // The coordinator persists completed stages and results; retain only active owner calls here.

  const assertOpen = (): void => {
    if (closed) fail("EXTERNAL_EFFECT_EXECUTOR_CLOSED");
  };

  const readiness = (): RealtimeExternalEffectExecutorReadiness => {
    if (closed) return { ready: false, closed: true, owner: false, binding: false };
    let ownerReady = false;
    let bindingReady = false;
    try { ownerReady = owner.isReady() === true; } catch { ownerReady = false; }
    try { bindingReady = binding.isReady() === true; } catch { bindingReady = false; }
    return { ready: ownerReady && bindingReady, closed: false, owner: ownerReady, binding: bindingReady };
  };

  const assertReady = (): void => {
    const state = readiness();
    if (!state.ready) fail("EXTERNAL_EFFECT_OWNER_NOT_READY");
  };

  const rememberFlight = <T>(promise: Promise<T>): Promise<T> => {
    flights.add(promise);
    void promise.finally(() => flights.delete(promise)).catch(() => undefined);
    return promise;
  };

  const executeStage = async (input: {
    readonly stage: RealtimeMediaCleanupStage;
    readonly intent: RealtimeMediaStopIntent;
  }): Promise<void> => {
    assertOpen();
    if (!isRecord(input) || !MEDIA_STAGE_SET.has(input.stage)) fail("EXTERNAL_EFFECT_STAGE_INVALID");
    assertIntent(input.intent);
    const intentDigest = digest(input.intent);
    const key = `${input.intent.fingerprint}:${input.stage}`;
    const active = activeStages.get(key);
    if (active !== undefined) {
      if (active.intentDigest !== intentDigest) fail("EXTERNAL_EFFECT_INTENT_CONFLICT");
      await active.promise;
      return;
    }
    const flight = (async (): Promise<void> => {
      assertReady();
      const authoritativeBinding = await invokeOwned(
        () => binding.resolveMediaStop({ intent: input.intent }),
        timeoutMs,
        "EXTERNAL_EFFECT_BINDING_FAILED",
      );
      assertBinding(authoritativeBinding);
      const context = Object.freeze({
        binding: cloneAndFreeze(authoritativeBinding),
        fingerprint: input.intent.fingerprint,
      });
      if (closed) fail("EXTERNAL_EFFECT_EXECUTOR_CLOSED");
      const method = input.stage === "tracks_unpublished"
        ? owner.unpublishTracks
        : input.stage === "participant_disconnected"
          ? owner.disconnectParticipant
          : input.stage === "credential_revoked"
            ? owner.revokeCredential
            : owner.verifyClosed;
      await invokeOwned(() => method.call(owner, context), timeoutMs, "EXTERNAL_EFFECT_OWNER_FAILED");
      if (closed) fail("EXTERNAL_EFFECT_EXECUTOR_CLOSED");
    })();
    const tracked = rememberFlight(flight);
    activeStages.set(key, { intentDigest, promise: tracked });
    try {
      return await tracked;
    } finally {
      if (activeStages.get(key)?.promise === tracked) activeStages.delete(key);
    }
  };

  const suppressAndClose = async (input: {
    readonly request: JsonRecord;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }): Promise<unknown> => {
    assertOpen();
    assertHandoffInput(input);
    const requestFingerprint = typeof input.request.fingerprint === "string"
      ? input.request.fingerprint
      : typeof input.request.fingerprint_sha256 === "string"
        ? input.request.fingerprint_sha256
        : typeof input.request.idempotencyKey === "string"
          ? input.request.idempotencyKey
          : typeof input.request.idempotency_key === "string"
            ? input.request.idempotency_key
            : typeof input.request.requestId === "string"
              ? input.request.requestId
              : typeof input.request.request_id === "string"
                ? input.request.request_id
                : undefined;
    if (requestFingerprint === undefined || !NONEMPTY_TEXT.test(requestFingerprint)) {
      fail("EXTERNAL_EFFECT_HANDOFF_INVALID");
    }
    const key = `handoff:${createHash("sha256").update(requestFingerprint, "utf8").digest("hex")}`;
    const inputDigest = digest({ requestFingerprint });
    const active = activeHandoffs.get(key);
    if (active !== undefined) {
      if (active.inputDigest !== inputDigest) fail("EXTERNAL_EFFECT_INTENT_CONFLICT");
      return await active.promise;
    }
    const flight = (async (): Promise<unknown> => {
      assertReady();
      const authoritativeBinding = await invokeOwned(
        () => binding.resolveHandoff({ request: input.request, authorityResult: input.authorityResult, ...(input.previousBinding === undefined ? {} : {previousBinding:input.previousBinding}) }),
        timeoutMs,
        "EXTERNAL_EFFECT_BINDING_FAILED",
      );
      assertBinding(authoritativeBinding);
      const context = Object.freeze({
        binding: cloneAndFreeze(authoritativeBinding),
        fingerprint: requestFingerprint,
        operation: "handoff" as const,
      });
      if (closed) fail("EXTERNAL_EFFECT_EXECUTOR_CLOSED");
      const result = await invokeOwned(
        () => owner.suppressAndClose.call(owner, context),
        timeoutMs,
        "EXTERNAL_EFFECT_OWNER_FAILED",
      );
      if (closed) fail("EXTERNAL_EFFECT_EXECUTOR_CLOSED");
      return assertSafeResult(result);
    })();
    const tracked = rememberFlight(flight);
    activeHandoffs.set(key, { inputDigest, promise: tracked });
    try {
      return await tracked;
    } finally {
      if (activeHandoffs.get(key)?.promise === tracked) activeHandoffs.delete(key);
    }
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closePromise = (async (): Promise<void> => {
      await Promise.allSettled([...flights]);
      const closedObjects = new Set<object>();
      for (const port of [owner, binding]) {
        if (typeof port.close !== "function" || closedObjects.has(port)) continue;
        closedObjects.add(port);
        try {
          await port.close();
        } catch {
          throw new RealtimePublicControlExternalEffectExecutorError("EXTERNAL_EFFECT_CLOSE_FAILED");
        }
      }
    })();
    return closePromise;
  };

  return Object.freeze({
    executeStage,
    executeMediaStage: executeStage,
    suppressAndClose,
    executeHandoffSuppression: suppressAndClose,
    close,
    readiness,
    assertReady,
  });
}

export const createRealtimeExternalEffectExecutor = createRealtimePublicControlExternalEffectExecutor;
