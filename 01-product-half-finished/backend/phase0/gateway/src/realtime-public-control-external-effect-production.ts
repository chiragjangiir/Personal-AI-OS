import type {
  CredentialFencePort,
  CredentialFenceSnapshot,
  CredentialFenceTuple,
} from "../../../services/platform-data/src/realtime-credential-fence.ts";
import { normalizeCredentialFenceTuple } from "../../../services/platform-data/src/realtime-credential-fence.ts";
import type {
  RealtimeExternalEffectBinding,
  RealtimeExternalEffectBindingResolver,
  RealtimeExternalEffectHandoffContext,
  RealtimeExternalEffectOperationContext,
  RealtimeExternalEffectOwner,
} from "./realtime-public-control-external-effect-executor.ts";
import type {
  LiveKitCloudParticipantBinding,
  LiveKitCloudParticipantPort,
} from "./livekit-cloud-participant.ts";

const DECIMAL = /^[1-9][0-9]{0,38}$/u;
const FENCING_TOKEN = /^[1-9][0-9]{0,37}$/u;
const TEXT = /^.{1,256}$/su;
const SECRET_KEY = /(?:bearer|token|secret|password|private[_-]?key|key[_-]?material|api[_-]?key|credential)/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export interface RealtimeExternalEffectRoomParticipant {
  readonly identity: string;
}

/** The smallest production RoomService seam needed for cleanup. */
export interface RealtimeExternalEffectRoomAdminPort {
  readonly environment: "production";
  readonly isReady: () => boolean;
  readonly removeParticipant: (roomName: string, identity: string) => Promise<void>;
  readonly listParticipants: (roomName: string) => Promise<readonly RealtimeExternalEffectRoomParticipant[]>;
  readonly close?: () => void | Promise<void>;
}

export interface RealtimeExternalEffectHandoffFence {
  readonly fromDeviceId: string;
  readonly previousDeviceLeaseRef: unknown;
  readonly newDeviceLeaseRef: unknown;
  readonly connectionEpoch: string;
  readonly fencingToken: string;
  readonly evidenceRefs: readonly unknown[];
}

export interface RealtimeExternalEffectProductionBindingResolver extends RealtimeExternalEffectBindingResolver {
  readonly resolveCredentialFence: (input: {
    readonly binding: RealtimeExternalEffectBinding;
    readonly operation: "media_stop" | "handoff";
  }) => Promise<CredentialFenceTuple>;
  readonly resolveHandoffFence: (input: {
    readonly binding: RealtimeExternalEffectBinding;
    readonly fingerprint: string;
    readonly authorityResult: unknown;
  }) => Promise<RealtimeExternalEffectHandoffFence>;
  readonly resolveReconnectBinding: (input: {
    readonly participant: LiveKitCloudParticipantBinding;
  }) => Promise<RealtimeExternalEffectBinding>;
}

export interface RealtimeExternalEffectProductionReadiness {
  readonly ready: boolean;
  readonly closed: boolean;
  readonly participant: boolean;
  readonly roomAdmin: boolean;
  readonly credentialFence: boolean;
  readonly binding: boolean;
}

export interface RealtimeExternalEffectProductionOptions {
  readonly participant: LiveKitCloudParticipantPort;
  readonly participantForDevice?: (deviceId: string) => LiveKitCloudParticipantPort | undefined;
  readonly roomAdmin: RealtimeExternalEffectRoomAdminPort;
  readonly credentialFence: CredentialFencePort;
  readonly binding: RealtimeExternalEffectProductionBindingResolver;
  readonly readiness: {
    readonly participant: () => boolean;
    readonly roomAdmin: () => boolean;
    readonly credentialFence: () => boolean;
    readonly binding: () => boolean;
  };
  readonly timeoutMs?: number;
  /** Runtime normally owns the participant lifecycle; opt in only when this owner owns it. */
  readonly ownsParticipantClose?: boolean;
}

export interface RealtimeExternalEffectProductionOwner extends RealtimeExternalEffectOwner {
  readonly readiness: () => RealtimeExternalEffectProductionReadiness;
  readonly assertReady: () => void;
}

export class RealtimeExternalEffectProductionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RealtimeExternalEffectProductionError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimeExternalEffectProductionError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function safeClone(value: unknown, path = "value", seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EXTERNAL_EFFECT_PRODUCTION_VALUE_INVALID");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    fail(typeof value === "object" ? "EXTERNAL_EFFECT_PRODUCTION_VALUE_CYCLIC" : "EXTERNAL_EFFECT_PRODUCTION_VALUE_INVALID");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) => safeClone(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (!isRecord(value)) fail("EXTERNAL_EFFECT_PRODUCTION_VALUE_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || SECRET_KEY.test(key)) fail("EXTERNAL_EFFECT_PRODUCTION_VALUE_UNSAFE");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail("EXTERNAL_EFFECT_PRODUCTION_VALUE_INVALID");
    }
    result[key] = safeClone(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

// Canonical JSON (sorted keys): value equality must not depend on the order a producer built its object in.
function stable(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted((item as Record<string, unknown>)[key])]))
      : item;
  return JSON.stringify(sorted(safeClone(value)));
}

function same(left: unknown, right: unknown): boolean {
  try { return stable(left) === stable(right); } catch { return false; }
}

function assertBinding(value: unknown): asserts value is RealtimeExternalEffectBinding {
  if (!isRecord(value)) fail("EXTERNAL_EFFECT_PRODUCTION_BINDING_INVALID");
  const expected = [
    "connectionEpoch", "continuityId", "deviceId", "deviceLeaseRef", ...("fenceGeneration" in value ? ["fenceGeneration"] : []),
    "participantIdentity", "realtimeSessionRef", "roomName",
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("EXTERNAL_EFFECT_PRODUCTION_BINDING_INVALID");
  }
  for (const key of ["continuityId", "deviceId", "participantIdentity", "roomName"] as const) {
    if (typeof value[key] !== "string" || !TEXT.test(value[key])) fail("EXTERNAL_EFFECT_PRODUCTION_BINDING_INVALID");
  }
  if (!DECIMAL.test(String(value.connectionEpoch)) || value.realtimeSessionRef === undefined || value.deviceLeaseRef === undefined ||
      ("fenceGeneration" in value && !DECIMAL.test(String(value.fenceGeneration)))) {
    fail("EXTERNAL_EFFECT_PRODUCTION_BINDING_INVALID");
  }
  safeClone(value.realtimeSessionRef, "realtimeSessionRef");
  safeClone(value.deviceLeaseRef, "deviceLeaseRef");
}

function assertContext(input: unknown): asserts input is RealtimeExternalEffectOperationContext {
  // The intent fingerprint is the coordinator's opaque request identity (canonical wire JSON), not a bounded identifier.
  if (!isRecord(input) || !isRecord(input.binding) || typeof input.fingerprint !== "string" || input.fingerprint.length === 0) {
    fail("EXTERNAL_EFFECT_PRODUCTION_CONTEXT_INVALID");
  }
  assertBinding(input.binding);
}

function assertHandoffContext(input: unknown): asserts input is RealtimeExternalEffectHandoffContext {
  if (!isRecord(input) || input.operation !== "handoff") fail("EXTERNAL_EFFECT_PRODUCTION_HANDOFF_INVALID");
  assertContext(input);
}

/** Whether this process's participant still owns the stopped binding (connected or reconnecting to it). After a
 * gateway restart or a superseding Start it does not; that participant is then reachable only server side. */
function ownsBinding(participant: LiveKitCloudParticipantPort, binding: RealtimeExternalEffectBinding): boolean {
  const current = participant.bindingSnapshot?.();
  return current !== undefined && current.connectionEpoch === binding.connectionEpoch &&
    same(current.realtimeSessionRef, binding.realtimeSessionRef) &&
    same(current.deviceLeaseRef, binding.deviceLeaseRef) &&
    same(current.continuityId, binding.continuityId);
}

function connectedTo(participant: LiveKitCloudParticipantPort, binding: RealtimeExternalEffectBinding): boolean {
  const snapshot = participant.snapshot();
  return ownsBinding(participant, binding) && snapshot.connected === true && snapshot.roomName === binding.roomName &&
    snapshot.identity === binding.participantIdentity && snapshot.connectionEpoch === binding.connectionEpoch;
}

function assertFenceBinding(tupleInput: unknown, binding: RealtimeExternalEffectBinding): CredentialFenceTuple {
  let tuple: CredentialFenceTuple;
  try { tuple = normalizeCredentialFenceTuple(tupleInput); } catch { fail("EXTERNAL_EFFECT_PRODUCTION_FENCE_INVALID"); }
  if (!same(tuple.realtimeSessionRef, binding.realtimeSessionRef) ||
      !same(tuple.deviceLeaseRef, binding.deviceLeaseRef) ||
      tuple.continuityId !== binding.continuityId || tuple.connectionEpoch !== binding.connectionEpoch) {
    fail("EXTERNAL_EFFECT_PRODUCTION_FENCE_BINDING_INVALID");
  }
  return tuple;
}

function assertSnapshot(value: CredentialFenceSnapshot): CredentialFenceSnapshot {
  if (value === null || typeof value !== "object" || value.active !== true && value.active !== false) {
    fail("EXTERNAL_EFFECT_PRODUCTION_FENCE_SNAPSHOT_INVALID");
  }
  if (value.credentialGeneration !== undefined && !DECIMAL.test(value.credentialGeneration)) {
    fail("EXTERNAL_EFFECT_PRODUCTION_FENCE_SNAPSHOT_INVALID");
  }
  return value;
}

function assertParticipants(value: unknown): readonly RealtimeExternalEffectRoomParticipant[] {
  if (!Array.isArray(value)) fail("EXTERNAL_EFFECT_PRODUCTION_PARTICIPANTS_INVALID");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.identity !== "string" || !TEXT.test(entry.identity)) {
      fail("EXTERNAL_EFFECT_PRODUCTION_PARTICIPANTS_INVALID");
    }
    return Object.freeze({ identity: entry.identity });
  });
}

function assertHandoffFence(value: unknown, binding: RealtimeExternalEffectBinding): RealtimeExternalEffectHandoffFence {
  if (!isRecord(value) || typeof value.fromDeviceId !== "string" || !TEXT.test(value.fromDeviceId) ||
      typeof value.connectionEpoch !== "string" || !DECIMAL.test(value.connectionEpoch) ||
      typeof value.fencingToken !== "string" || !FENCING_TOKEN.test(value.fencingToken) ||
      value.previousDeviceLeaseRef === undefined || value.newDeviceLeaseRef === undefined ||
      !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 ||
      value.fromDeviceId !== binding.deviceId || value.connectionEpoch !== binding.connectionEpoch ||
      same(value.previousDeviceLeaseRef, binding.deviceLeaseRef) === false) {
    fail("EXTERNAL_EFFECT_PRODUCTION_HANDOFF_FENCE_INVALID");
  }
  safeClone(value.previousDeviceLeaseRef, "previousDeviceLeaseRef");
  safeClone(value.newDeviceLeaseRef, "newDeviceLeaseRef");
  const evidenceRefs = value.evidenceRefs.map((entry) => safeClone(entry, "evidenceRefs"));
  if (same(value.newDeviceLeaseRef, value.previousDeviceLeaseRef)) fail("EXTERNAL_EFFECT_PRODUCTION_HANDOFF_FENCE_INVALID");
  return Object.freeze({
    fromDeviceId: value.fromDeviceId,
    previousDeviceLeaseRef: safeClone(value.previousDeviceLeaseRef),
    newDeviceLeaseRef: safeClone(value.newDeviceLeaseRef),
    connectionEpoch: value.connectionEpoch,
    fencingToken: value.fencingToken,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RealtimeExternalEffectProductionError("EXTERNAL_EFFECT_PRODUCTION_TIMEOUT")), timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export function createRealtimePublicControlExternalEffectProduction(
  options: RealtimeExternalEffectProductionOptions,
): RealtimeExternalEffectProductionOwner {
  if (!isRecord(options)) fail("EXTERNAL_EFFECT_PRODUCTION_OPTIONS_INVALID");
  const participant = options.participant;
  const roomAdmin = options.roomAdmin;
  const credentialFence = options.credentialFence;
  const binding = options.binding;
  const readiness = options.readiness;
  if (participant === null || typeof participant !== "object" || typeof participant.snapshot !== "function" ||
      typeof participant.disconnect !== "function" || typeof participant.bindingSnapshot !== "function" ||
      typeof participant.unpublishAllTracks !== "function" || typeof participant.verifyClosed !== "function" ||
      typeof participant.setReconnectAdmissionGuard !== "function") {
    fail("EXTERNAL_EFFECT_PRODUCTION_PARTICIPANT_REQUIRED");
  }
  if (roomAdmin === null || typeof roomAdmin !== "object" || roomAdmin.environment !== "production" ||
      typeof roomAdmin.isReady !== "function" || typeof roomAdmin.removeParticipant !== "function" ||
      typeof roomAdmin.listParticipants !== "function") {
    fail("EXTERNAL_EFFECT_PRODUCTION_ROOM_ADMIN_REQUIRED");
  }
  if (credentialFence === null || typeof credentialFence !== "object" || typeof credentialFence.verify !== "function" ||
      typeof credentialFence.close !== "function") fail("EXTERNAL_EFFECT_PRODUCTION_CREDENTIAL_FENCE_REQUIRED");
  if (binding === null || typeof binding !== "object" || binding.environment !== "production" ||
      typeof binding.isReady !== "function" || typeof binding.resolveCredentialFence !== "function" ||
      typeof binding.resolveHandoffFence !== "function" || typeof binding.resolveReconnectBinding !== "function") {
    fail("EXTERNAL_EFFECT_PRODUCTION_BINDING_REQUIRED");
  }
  if (readiness === null || typeof readiness !== "object" ||
      typeof readiness.participant !== "function" || typeof readiness.roomAdmin !== "function" ||
      typeof readiness.credentialFence !== "function" || typeof readiness.binding !== "function") {
    fail("EXTERNAL_EFFECT_PRODUCTION_READINESS_REQUIRED");
  }
  if (roomAdmin.close !== undefined && typeof roomAdmin.close !== "function") fail("EXTERNAL_EFFECT_PRODUCTION_ROOM_CLOSE_INVALID");
  if (binding.close !== undefined && typeof binding.close !== "function") fail("EXTERNAL_EFFECT_PRODUCTION_BINDING_CLOSE_INVALID");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail("EXTERNAL_EFFECT_PRODUCTION_TIMEOUT_INVALID");

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const flights = new Set<Promise<unknown>>();

  const state = (): RealtimeExternalEffectProductionReadiness => {
    if (closed) return { ready: false, closed: true, participant: false, roomAdmin: false, credentialFence: false, binding: false };
    const check = (fn: () => boolean): boolean => { try { return fn() === true; } catch { return false; } };
    const participantReady = check(readiness.participant);
    const roomReady = check(readiness.roomAdmin) && check(roomAdmin.isReady);
    const fenceReady = check(readiness.credentialFence);
    const bindingReady = check(readiness.binding) && check(binding.isReady);
    return { ready: participantReady && roomReady && fenceReady && bindingReady, closed: false,
      participant: participantReady, roomAdmin: roomReady, credentialFence: fenceReady, binding: bindingReady };
  };
  const assertOpen = (): void => { if (closed) fail("EXTERNAL_EFFECT_PRODUCTION_CLOSED"); };
  const assertReady = (): void => { if (!state().ready) fail("EXTERNAL_EFFECT_PRODUCTION_NOT_READY"); };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    flights.add(promise);
    void promise.finally(() => flights.delete(promise)).catch(() => undefined);
    return promise;
  };
  const invoke = async <T>(operation: () => Promise<T>, code: string): Promise<T> => {
    try { return await withTimeout(operation, timeoutMs); }
    catch (error) {
      if (error instanceof RealtimeExternalEffectProductionError) throw error;
      fail(code);
    }
  };
  const authoritativeFence = async (current: RealtimeExternalEffectBinding, operation: "media_stop" | "handoff"): Promise<CredentialFenceTuple> => {
    const raw = await invoke(() => binding.resolveCredentialFence.call(binding, { binding: current, operation }), "EXTERNAL_EFFECT_PRODUCTION_FENCE_RESOLVE_FAILED");
    return assertFenceBinding(raw, current);
  };
  const verifyActiveFence = async (current: RealtimeExternalEffectBinding, operation: "media_stop" | "handoff"): Promise<void> => {
    const tuple = await authoritativeFence(current, operation);
    const raw = await invoke(() => credentialFence.verify(tuple), "EXTERNAL_EFFECT_PRODUCTION_FENCE_VERIFY_FAILED");
    const snapshot = assertSnapshot(raw);
    if (snapshot.active !== true) fail("EXTERNAL_EFFECT_PRODUCTION_FENCE_INACTIVE");
    if (snapshot.credentialGeneration !== undefined && snapshot.credentialGeneration !== tuple.credentialGeneration) {
      fail("EXTERNAL_EFFECT_PRODUCTION_FENCE_GENERATION_DRIFT");
    }
  };
  // The binding is T02's authoritative resolution of the stopped session. Every stage is idempotent: it acts on
  // the in-process participant only while that participant owns the binding, and otherwise on the server side.
  const currentBinding = async (context: RealtimeExternalEffectOperationContext): Promise<RealtimeExternalEffectBinding> => {
    assertContext(context);
    assertOpen();
    assertReady();
    return context.binding;
  };
  const unpublishTracks = (context: RealtimeExternalEffectOperationContext): Promise<void> => track((async () => {
    const current = await currentBinding(context);
    const participant = options.participantForDevice === undefined ? options.participant : options.participantForDevice(current.deviceId);
    if (participant === undefined || !connectedTo(participant, current)) return; // nothing of this binding is published from this process
    try { await participant.unpublishAllTracks!.call(participant); }
    catch { fail("EXTERNAL_EFFECT_PRODUCTION_UNPUBLISH_FAILED"); }
    if (closed) fail("EXTERNAL_EFFECT_PRODUCTION_CLOSED");
  })());
  const disconnectParticipant = (context: RealtimeExternalEffectOperationContext): Promise<void> => track((async () => {
    const current = await currentBinding(context);
    const participant = options.participantForDevice === undefined ? options.participant : options.participantForDevice(current.deviceId);
    if (participant !== undefined && ownsBinding(participant, current)) {
      try { await participant.disconnect.call(participant); }
      catch { fail("EXTERNAL_EFFECT_PRODUCTION_DISCONNECT_FAILED"); }
      return;
    }
    await invoke(() => roomAdmin.removeParticipant.call(roomAdmin, current.roomName, current.participantIdentity),
      "EXTERNAL_EFFECT_PRODUCTION_REMOVE_FAILED");
  })());
  const revokeCredential = (context: RealtimeExternalEffectOperationContext): Promise<void> => track((async () => {
    await verifyActiveFence(await currentBinding(context), "media_stop");
  })());
  const verifyClosed = (context: RealtimeExternalEffectOperationContext): Promise<void> => track((async () => {
    const current = await currentBinding(context);
    const participant = options.participantForDevice === undefined ? options.participant : options.participantForDevice(current.deviceId);
    if (participant !== undefined && ownsBinding(participant, current)) {
      try { await participant.verifyClosed!.call(participant); }
      catch { fail("EXTERNAL_EFFECT_PRODUCTION_CLOSURE_UNVERIFIED"); }
    }
    const participants = assertParticipants(await invoke(
      () => roomAdmin.listParticipants.call(roomAdmin, context.binding.roomName),
      "EXTERNAL_EFFECT_PRODUCTION_LIST_FAILED",
    ));
    if (participants.some((entry) => entry.identity === context.binding.participantIdentity)) {
      fail("EXTERNAL_EFFECT_PRODUCTION_PARTICIPANT_REMAINS");
    }
  })());
  const suppressAndClose = (context: RealtimeExternalEffectHandoffContext): Promise<unknown> => track((async () => {
    assertHandoffContext(context);
    assertOpen();
    assertReady();
    assertBinding(context.binding);
    const fence = assertHandoffFence(await invoke(
      () => binding.resolveHandoffFence.call(binding, {
        binding: context.binding, fingerprint: context.fingerprint, authorityResult: undefined,
      }),
      "EXTERNAL_EFFECT_PRODUCTION_HANDOFF_FENCE_RESOLVE_FAILED",
    ), context.binding);
    try {
      await roomAdmin.removeParticipant.call(roomAdmin, context.binding.roomName, context.binding.participantIdentity);
    } catch { fail("EXTERNAL_EFFECT_PRODUCTION_REMOVE_FAILED"); }
    const participants = assertParticipants(await invoke(
      () => roomAdmin.listParticipants.call(roomAdmin, context.binding.roomName),
      "EXTERNAL_EFFECT_PRODUCTION_LIST_FAILED",
    ));
    if (participants.some((entry) => entry.identity === context.binding.participantIdentity)) {
      fail("EXTERNAL_EFFECT_PRODUCTION_PARTICIPANT_REMAINS");
    }
    return Object.freeze({
      state: "old_device_suppressed",
      closure_status: "verified_closed",
      old_device_suppression_fence: Object.freeze({
        from_device_id: fence.fromDeviceId,
        previous_device_lease_ref: fence.previousDeviceLeaseRef,
        new_device_lease_ref: fence.newDeviceLeaseRef,
        connection_epoch: fence.connectionEpoch,
        fencing_token: fence.fencingToken,
        state: "old_device_suppressed",
      }),
      evidence_refs: fence.evidenceRefs,
    });
  })());

  const reconnectGuard = (participantBinding: LiveKitCloudParticipantBinding): Promise<void> => track((async () => {
    try {
      assertOpen();
      assertReady();
      const current = await invoke(
        () => binding.resolveReconnectBinding.call(binding, { participant: participantBinding }),
        "EXTERNAL_EFFECT_PRODUCTION_RECONNECT_BINDING_FAILED",
      );
      assertBinding(current);
      const tuple = await authoritativeFence(current, "media_stop");
      const snapshot = assertSnapshot(await invoke(() => credentialFence.verify(tuple), "EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCE_FAILED"));
      if (snapshot.active === true) fail("EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED");
    } catch (error) {
      if (error instanceof RealtimeExternalEffectProductionError) throw error;
      fail("EXTERNAL_EFFECT_PRODUCTION_RECONNECT_UNAVAILABLE");
    }
  })());
  participant.setReconnectAdmissionGuard.call(participant, reconnectGuard);

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closePromise = (async () => {
      await Promise.allSettled([...flights]);
      let failed = false;
      const seen = new Set<object>();
      const ports: readonly (object & { readonly close?: () => void | Promise<void> })[] = [
        ...(options.ownsParticipantClose ? [participant] : []), roomAdmin, credentialFence, binding,
      ];
      for (const port of ports) {
        if (seen.has(port) || typeof port.close !== "function") continue;
        seen.add(port);
        try { await port.close.call(port); } catch { failed = true; }
      }
      if (failed) fail("EXTERNAL_EFFECT_PRODUCTION_CLOSE_FAILED");
    })();
    return closePromise;
  };

  return Object.freeze({
    environment: "production" as const,
    isReady: () => state().ready,
    readiness: state,
    assertReady,
    unpublishTracks,
    disconnectParticipant,
    revokeCredential,
    verifyClosed,
    suppressAndClose,
    close,
  });
}

export const createRealtimeExternalEffectProduction = createRealtimePublicControlExternalEffectProduction;
