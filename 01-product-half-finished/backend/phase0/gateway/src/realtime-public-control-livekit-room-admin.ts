import { createHash } from "node:crypto";

import { RoomServiceClient } from "livekit-server-sdk";

import type {
  CurrentBindingLookup,
  RealtimeCurrentBindingProjection,
  RealtimeTransportBinding,
} from "../../../services/realtime-core/src/types.ts";
import {
  assertCanonicalTimestamp,
  snapshotOpaqueOwnerValue,
} from "../../../services/realtime-core/src/types.ts";
import type {
  ProductionPortRegistration,
} from "../../../services/realtime-core/src/production-owner-ports.ts";
import type {
  TransportDisconnectionPort,
  VerifiedTransportDisconnection,
} from "../../../services/realtime-core/src/ports.ts";
import type {
  CredentialFencePort,
  CredentialFenceTuple,
} from "../../../services/platform-data/src/realtime-credential-fence.ts";
import type { RealtimeMediaStopIntent } from "../../../services/platform-data/src/realtime-external-effect-coordinator.ts";
import type {
  LiveKitCloudParticipantBinding,
  LiveKitCloudParticipantPort,
} from "./livekit-cloud-participant.ts";
import {
  assertCanonicalLiveKitCloudProjectUrl,
  livekitApiOrigin,
  type SecretReference,
  type SecretResolverPort,
} from "./livekit-cloud-token-signer.ts";
import { PERSISTENT_PUBLIC_SECRET_REFERENCES } from "./realtime-public-control-persistent-public-ports.ts";
import { projectRealtimeExternalAliases } from "./realtime-public-control-external-alias.ts";
import type {
  RealtimeExternalEffectBinding,
} from "./realtime-public-control-external-effect-executor.ts";
import type {
  RealtimeExternalEffectHandoffFence,
  RealtimeExternalEffectProductionBindingResolver,
  RealtimeExternalEffectRoomAdminPort,
} from "./realtime-public-control-external-effect-production.ts";

const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const API_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const API_SECRET = /^[A-Za-z0-9_-]{32,128}$/u;

type ReadCurrentBinding = (
  lookup: CurrentBindingLookup,
) => Promise<RealtimeCurrentBindingProjection | undefined>;

interface RoomAdminClient {
  readonly removeParticipant: (room: string, identity: string) => Promise<void>;
  readonly listParticipants: (room: string) => Promise<readonly { readonly identity?: unknown }[]>;
}

export interface RealtimePublicControlLiveKitRoomAdminOptions {
  readonly serverUrl: string;
  readonly apiUrl?: string;
  readonly apiKeyRef: SecretReference;
  readonly apiSecretRef: SecretReference;
  readonly secretResolver: SecretResolverPort;
  readonly participant: LiveKitCloudParticipantPort;
  readonly participantForDevice?: (deviceId: string) => LiveKitCloudParticipantPort | undefined;
  readonly readCurrentBinding: ReadCurrentBinding;
  readonly credentialFence: CredentialFencePort;
  /** Real T02/Public readiness. A constant test readiness is not a production admission. */
  readonly readiness: () => boolean;
  readonly createRoomService?: (input: Readonly<{
    readonly host: string;
    readonly apiKey: string;
    readonly apiSecret: string;
  }>) => RoomAdminClient;
}

export interface RealtimePublicControlLiveKitRoomAdminBundle {
  readonly roomAdmin: RealtimeExternalEffectRoomAdminPort;
  readonly binding: RealtimeExternalEffectProductionBindingResolver;
  readonly credentialFence: CredentialFencePort;
  readonly close: () => Promise<void>;
}

export class RealtimePublicControlLiveKitRoomAdminError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RealtimePublicControlLiveKitRoomAdminError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlLiveKitRoomAdminError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("LIVEKIT_ADMIN_OWNER_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) fail("LIVEKIT_ADMIN_OWNER_VALUE_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      fail("LIVEKIT_ADMIN_OWNER_VALUE_INVALID");
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function same(left: unknown, right: unknown): boolean {
  try { return canonical(left) === canonical(right); } catch { return false; }
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function decimal(value: unknown, code: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) fail(code);
  return value;
}

function exactReference(value: SecretReference, expected: SecretReference, code: string): void {
  if (value === null || typeof value !== "object" || value.name !== expected.name ||
      value.version !== expected.version || Object.keys(value).some((key) => key !== "name" && key !== "version")) {
    fail(code);
  }
}

function projectionIdentifier(
  prefix: "paios-r-" | "paios-g-",
  domain: string,
  alias: unknown,
  epoch: string,
): string {
  const payload = canonical(Object.freeze({ alias, connection_epoch: decimal(epoch, "LIVEKIT_ADMIN_EPOCH_INVALID") }));
  const digest = createHash("sha256").update(domain, "utf8").update("\0").update(payload, "utf8").digest("hex")
    .replace(/[0-9]/gu, (digit) => "ghijklmnop"[Number(digit)]!);
  return text(`${prefix}${digest}`, "LIVEKIT_ADMIN_PROJECTION_INVALID");
}

function projectionNames(binding: RealtimeCurrentBindingProjection["session"]["binding"]): {
  readonly roomName: string;
  readonly participantIdentity: string;
} {
  if (binding.provider !== "livekit-cloud") fail("LIVEKIT_ADMIN_PROVIDER_INVALID");
  return Object.freeze({
    roomName: projectionIdentifier("paios-r-", "paios.public.livekit.room.v1", binding.roomAlias, binding.connectionEpoch),
    participantIdentity: projectionIdentifier(
      "paios-g-",
      "paios.public.livekit.gateway-identity.v1",
      binding.transportSessionAlias,
      binding.connectionEpoch,
    ),
  });
}

// The participant binding carries the wire transport aliases (as returned to the device); project T02's binding the same way.
function transportAliases(binding: RealtimeCurrentBindingProjection["session"]["binding"]): readonly unknown[] {
  try { return projectRealtimeExternalAliases(binding); } catch { fail("LIVEKIT_ADMIN_CURRENT_BINDING_INVALID"); }
}

function aliasValue(aliases: readonly unknown[], aliasType: "room" | "transport_session"): string {
  const matches = aliases.filter((alias) =>
    alias !== null && typeof alias === "object" && (alias as Record<string, unknown>).alias_type === aliasType);
  const value = matches.length === 1 ? (matches[0] as Record<string, unknown>).value : undefined;
  // Opaque alias text (hashed into names below), not an identifier.
  if (typeof value !== "string" || value.length === 0) fail("LIVEKIT_ADMIN_PARTICIPANT_BINDING_INVALID");
  return value;
}

/** "connected": the live media binding (reconnect, handoff). "stop": a stop resolves its own session even once this
 * process no longer holds it (gateway restart, superseding Start) or its lease was released by the stop's first attempt. */
function assertProjection(
  value: RealtimeCurrentBindingProjection | undefined,
  mode: "connected" | "stop" = "connected",
): RealtimeCurrentBindingProjection {
  const live = mode === "connected"
    ? value?.session.binding.state === "connected" && value.lease.state === "active"
    : ["connected", "disconnected", "released"].includes(String(value?.session.binding.state)) &&
      ["active", "released"].includes(String(value?.lease.state));
  if (value === undefined || value.session.state !== "active" || value.session.continuityState !== "active" || !live ||
      !same(value.session.realtimeSessionRef, value.lease.realtimeSessionRef) ||
      !same(value.session.realtimeSessionRef, value.session.binding.realtimeSessionRef) ||
      !same(value.lease.deviceLeaseRef, value.session.binding.deviceLeaseRef) ||
      value.session.continuityId !== value.lease.continuityId ||
      value.session.continuityId !== value.session.binding.continuityId ||
      value.session.activeDeviceId !== value.lease.deviceId ||
      value.session.activeDeviceId !== value.session.binding.deviceId ||
      value.session.connectionEpoch !== value.session.binding.connectionEpoch) {
    fail("LIVEKIT_ADMIN_CURRENT_BINDING_INVALID");
  }
  projectionNames(value.session.binding);
  return value;
}

function participantBinding(value: LiveKitCloudParticipantBinding | undefined): LiveKitCloudParticipantBinding {
  if (value === undefined || value.realtimeSessionRef === undefined || value.deviceLeaseRef === undefined ||
      typeof value.continuityId !== "string" || !Array.isArray(value.transportAliases) ||
      value.transportAliases.length !== 3 || !DECIMAL.test(value.connectionEpoch)) {
    fail("LIVEKIT_ADMIN_PARTICIPANT_BINDING_INVALID");
  }
  canonical(value.transportAliases);
  return value;
}

function assertParticipantMatchesCurrent(
  participant: LiveKitCloudParticipantBinding,
  current: RealtimeCurrentBindingProjection,
): void {
  const binding = current.session.binding;
  if (!same(participant.realtimeSessionRef, binding.realtimeSessionRef) ||
      !same(participant.deviceLeaseRef, binding.deviceLeaseRef) ||
      participant.continuityId !== binding.continuityId || participant.connectionEpoch !== binding.connectionEpoch ||
      !same(participant.transportAliases, transportAliases(binding))) {
    fail("LIVEKIT_ADMIN_PARTICIPANT_BINDING_DRIFT");
  }
}

function bindingFrom(
  participant: LiveKitCloudParticipantBinding,
  deviceId: string,
): RealtimeExternalEffectBinding {
  // Names derive from the raw alias values exactly as the cloud projection derived them for this participant's epoch.
  const transportSessionAlias = aliasValue(participant.transportAliases, "transport_session");
  const roomAlias = aliasValue(participant.transportAliases, "room");
  return Object.freeze({
    realtimeSessionRef: participant.realtimeSessionRef,
    deviceLeaseRef: participant.deviceLeaseRef,
    continuityId: text(participant.continuityId, "LIVEKIT_ADMIN_CONTINUITY_INVALID"),
    connectionEpoch: decimal(participant.connectionEpoch, "LIVEKIT_ADMIN_EPOCH_INVALID"),
    deviceId: text(deviceId, "LIVEKIT_ADMIN_DEVICE_INVALID"),
    roomName: projectionIdentifier("paios-r-", "paios.public.livekit.room.v1", roomAlias, participant.connectionEpoch),
    participantIdentity: projectionIdentifier(
      "paios-g-",
      "paios.public.livekit.gateway-identity.v1",
      transportSessionAlias,
      participant.connectionEpoch,
    ),
  });
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code);
  return value;
}

function validateMediaIntent(intent: RealtimeMediaStopIntent, current: RealtimeCurrentBindingProjection): void {
  const request = object(intent.request, "LIVEKIT_ADMIN_MEDIA_INTENT_INVALID");
  const binding = current.session.binding;
  // A released lease cannot carry a newer credential, so only a live lease must still be the stopped generation.
  if (request.operation !== "media_stop" || !same(request.realtimeSessionRef, binding.realtimeSessionRef) ||
      !same(request.deviceLeaseRef, binding.deviceLeaseRef) || request.continuityId !== binding.continuityId ||
      request.deviceId !== binding.deviceId || request.expectedConnectionEpoch !== binding.connectionEpoch ||
      typeof request.credentialGeneration !== "string" ||
      (current.lease.state === "active" && request.credentialGeneration !== current.lease.leaseVersion)) {
    fail("LIVEKIT_ADMIN_MEDIA_INTENT_BINDING_INVALID");
  }
}

function validateHandoff(
  requestValue: unknown,
  resultValue: unknown,
  oldParticipant: LiveKitCloudParticipantBinding,
  current: RealtimeCurrentBindingProjection,
): string {
  const request = object(requestValue, "LIVEKIT_ADMIN_HANDOFF_REQUEST_INVALID");
  const result = object(resultValue, "LIVEKIT_ADMIN_HANDOFF_RESULT_INVALID");
  if (request.operation !== "handoff" || !same(request.realtimeSessionRef, oldParticipant.realtimeSessionRef) ||
      request.continuityId !== oldParticipant.continuityId || request.expectedConnectionEpoch !== oldParticipant.connectionEpoch ||
      result.state !== "completed" || !same(result.realtimeSessionRef, current.session.realtimeSessionRef) ||
      result.continuityId !== current.session.continuityId || result.activeDeviceId !== current.session.activeDeviceId ||
      !same(result.activeDeviceLeaseRef, current.lease.deviceLeaseRef) || result.connectionEpoch !== current.session.connectionEpoch ||
      result.leaseVersion !== current.lease.leaseVersion || result.fencingToken !== current.lease.fencingToken ||
      result.suppressedDeviceId !== request.fromDeviceId || result.suppressedDeviceId === current.session.activeDeviceId ||
      same(oldParticipant.deviceLeaseRef, current.lease.deviceLeaseRef)) {
    fail("LIVEKIT_ADMIN_HANDOFF_BINDING_INVALID");
  }
  return text(result.suppressedDeviceId, "LIVEKIT_ADMIN_HANDOFF_DEVICE_INVALID");
}

function assertExternalBinding(value: RealtimeExternalEffectBinding): void {
  text(value.continuityId, "LIVEKIT_ADMIN_BINDING_INVALID");
  text(value.deviceId, "LIVEKIT_ADMIN_BINDING_INVALID");
  text(value.roomName, "LIVEKIT_ADMIN_BINDING_INVALID");
  text(value.participantIdentity, "LIVEKIT_ADMIN_BINDING_INVALID");
  decimal(value.connectionEpoch, "LIVEKIT_ADMIN_BINDING_INVALID");
  if (value.fenceGeneration !== undefined) decimal(value.fenceGeneration, "LIVEKIT_ADMIN_BINDING_INVALID");
  canonical(value.realtimeSessionRef);
  canonical(value.deviceLeaseRef);
}

export function createRealtimePublicControlLiveKitRoomAdmin(
  options: RealtimePublicControlLiveKitRoomAdminOptions,
): RealtimePublicControlLiveKitRoomAdminBundle {
  if (!isRecord(options) || assertCanonicalLiveKitCloudProjectUrl(options.serverUrl) !== options.serverUrl ||
      typeof options.secretResolver?.resolve !== "function" || typeof options.participant?.snapshot !== "function" ||
      typeof options.participant.bindingSnapshot !== "function" || typeof options.readCurrentBinding !== "function" ||
      typeof options.credentialFence?.verify !== "function" || typeof options.readiness !== "function" ||
      (options.createRoomService !== undefined && typeof options.createRoomService !== "function")) {
    fail("LIVEKIT_ADMIN_OPTIONS_INVALID");
  }
  exactReference(options.apiKeyRef, PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey, "LIVEKIT_ADMIN_API_KEY_REF_INVALID");
  exactReference(options.apiSecretRef, PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret, "LIVEKIT_ADMIN_API_SECRET_REF_INVALID");
  const httpHost = livekitApiOrigin(options.serverUrl, options.apiUrl);
  let closed = false;
  let closeFlight: Promise<void> | undefined;
  const flights = new Set<Promise<unknown>>();
  const ready = (): boolean => {
    if (closed) return false;
    try { return options.readiness() === true; } catch { return false; }
  };
  const guard = (): void => {
    if (closed) fail("LIVEKIT_ADMIN_CLOSED");
    if (!ready()) fail("LIVEKIT_ADMIN_NOT_READY");
  };
  const track = <T>(flight: Promise<T>): Promise<T> => {
    flights.add(flight);
    void flight.finally(() => flights.delete(flight)).catch(() => undefined);
    return flight;
  };
  const client = async <T>(action: (service: RoomAdminClient) => Promise<T>): Promise<T> => {
    guard();
    let keyLease: Awaited<ReturnType<SecretResolverPort["resolve"]>> | undefined;
    let secretLease: Awaited<ReturnType<SecretResolverPort["resolve"]>> | undefined;
    try {
      keyLease = await options.secretResolver.resolve(options.apiKeyRef);
      secretLease = await options.secretResolver.resolve(options.apiSecretRef);
      const apiKey = keyLease.read();
      const apiSecret = secretLease.read();
      if (!API_KEY.test(apiKey) || !API_SECRET.test(apiSecret)) fail("LIVEKIT_ADMIN_SECRET_INVALID");
      guard();
      const service = options.createRoomService === undefined
        ? new RoomServiceClient(httpHost, apiKey, apiSecret)
        : options.createRoomService({ host: httpHost, apiKey, apiSecret });
      return await action(service);
    } catch (error) {
      if (error instanceof RealtimePublicControlLiveKitRoomAdminError) throw error;
      fail("LIVEKIT_ADMIN_SERVICE_FAILED");
    } finally {
      try { secretLease?.release?.(); } catch { /* owner release is best effort after the operation */ }
      try { keyLease?.release?.(); } catch { /* owner release is best effort after the operation */ }
    }
  };
  const current = async (sessionRef: unknown, mode: "connected" | "stop" = "connected"): Promise<RealtimeCurrentBindingProjection> => {
    guard();
    let value: RealtimeCurrentBindingProjection | undefined;
    try {
      value = await options.readCurrentBinding({ realtimeSessionRef: sessionRef } as CurrentBindingLookup);
    } catch { fail("LIVEKIT_ADMIN_CURRENT_BINDING_UNAVAILABLE"); }
    guard();
    return assertProjection(value, mode);
  };
  const participant = (deviceId: string): LiveKitCloudParticipantBinding => participantBinding(
    (options.participantForDevice === undefined ? options.participant : options.participantForDevice(deviceId))?.bindingSnapshot?.(),
  );

  const roomAdmin: RealtimeExternalEffectRoomAdminPort = Object.freeze({
    environment: "production" as const,
    isReady: ready,
    removeParticipant: (roomName: string, identity: string): Promise<void> => track(client(async (service) => {
      try {
        await service.removeParticipant(
          text(roomName, "LIVEKIT_ADMIN_ROOM_INVALID"),
          text(identity, "LIVEKIT_ADMIN_IDENTITY_INVALID"),
        );
      } catch (error) {
        // Removal is idempotent: a participant (or room) LiveKit itself reports not_found is already removed. A bare
        // 404 is not proof — the public proxy answers unrouted RoomService methods with 404 ROUTE_NOT_FOUND.
        if ((error as { code?: unknown } | undefined)?.code !== "not_found") throw error;
      }
    })),
    listParticipants: (roomName: string): Promise<readonly { readonly identity: string }[]> => track(client(async (service) => {
      const listed = await service.listParticipants(text(roomName, "LIVEKIT_ADMIN_ROOM_INVALID"));
      if (!Array.isArray(listed)) fail("LIVEKIT_ADMIN_PARTICIPANTS_INVALID");
      return Object.freeze(listed.map((entry) => Object.freeze({
        identity: text(entry.identity, "LIVEKIT_ADMIN_PARTICIPANTS_INVALID"),
      })));
    })),
    close: () => close(),
  });

  const binding: RealtimeExternalEffectProductionBindingResolver = Object.freeze({
    environment: "production" as const,
    isReady: ready,
    resolveMediaStop: (
      { intent }: Parameters<RealtimeExternalEffectProductionBindingResolver["resolveMediaStop"]>[0],
    ): Promise<RealtimeExternalEffectBinding> => track((async () => {
      // The stop's own session in T02 is the authority, never whatever this process's participant holds now.
      const request = object(intent?.request, "LIVEKIT_ADMIN_MEDIA_INTENT_INVALID");
      const projection = await current(request.realtimeSessionRef, "stop");
      validateMediaIntent(intent, projection);
      const binding = projection.session.binding;
      // Refs in their wire form (the intent's, verified equal to T02 above) — the form the stop's fence was installed with.
      const names = bindingFrom({
        realtimeSessionRef: request.realtimeSessionRef, deviceLeaseRef: request.deviceLeaseRef,
        continuityId: binding.continuityId, connectionEpoch: binding.connectionEpoch, transportAliases: transportAliases(binding),
      } as LiveKitCloudParticipantBinding, projection.session.activeDeviceId);
      return Object.freeze({ ...names, fenceGeneration: decimal(request.credentialGeneration, "LIVEKIT_ADMIN_MEDIA_INTENT_BINDING_INVALID") });
    })()),
    resolveHandoff: (
      { request, authorityResult, previousBinding }: Parameters<RealtimeExternalEffectProductionBindingResolver["resolveHandoff"]>[0],
    ): Promise<RealtimeExternalEffectBinding> => track((async () => {
      const fromDeviceId = text(request.fromDeviceId, "LIVEKIT_ADMIN_HANDOFF_DEVICE_INVALID");
      let old: LiveKitCloudParticipantBinding;
      if (previousBinding === undefined) old = participant(fromDeviceId);
      else {
        const previous = object(previousBinding, "LIVEKIT_ADMIN_HANDOFF_BINDING_INVALID") as unknown as RealtimeTransportBinding;
        if (previous.deviceId !== fromDeviceId || previous.state !== "connected") fail("LIVEKIT_ADMIN_HANDOFF_BINDING_INVALID");
        projectionNames(previous);
        old = participantBinding({realtimeSessionRef:previous.realtimeSessionRef,deviceLeaseRef:previous.deviceLeaseRef,
          continuityId:previous.continuityId,connectionEpoch:previous.connectionEpoch,transportAliases:transportAliases(previous)});
      }
      const projection = await current(old.realtimeSessionRef);
      const oldDeviceId = validateHandoff(request, authorityResult, old, projection);
      return bindingFrom(old, oldDeviceId);
    })()),
    resolveCredentialFence: (
      { binding: external, operation }: Parameters<RealtimeExternalEffectProductionBindingResolver["resolveCredentialFence"]>[0],
    ): Promise<CredentialFenceTuple> => track((async () => {
      assertExternalBinding(external);
      const stop = operation === "media_stop" && external.fenceGeneration !== undefined;
      const projection = await current(external.realtimeSessionRef, stop ? "stop" : "connected");
      if (!same(projection.lease.deviceLeaseRef, external.deviceLeaseRef) ||
          projection.session.continuityId !== external.continuityId ||
          projection.session.connectionEpoch !== external.connectionEpoch ||
          projection.session.activeDeviceId !== external.deviceId) {
        fail("LIVEKIT_ADMIN_FENCE_BINDING_INVALID");
      }
      // A stop's fence is identified by the stop's own binding; reconnect and handoff use the live T02 lease.
      const tuple: CredentialFenceTuple = Object.freeze({
        realtimeSessionRef: (stop ? external.realtimeSessionRef : projection.session.realtimeSessionRef) as CredentialFenceTuple["realtimeSessionRef"],
        deviceLeaseRef: (stop ? external.deviceLeaseRef : projection.lease.deviceLeaseRef) as CredentialFenceTuple["deviceLeaseRef"],
        continuityId: projection.session.continuityId,
        connectionEpoch: projection.session.connectionEpoch,
        // Once released the lease's version moved past the stop; the stop's own fence generation identifies it.
        credentialGeneration: stop && projection.lease.state === "released" ? external.fenceGeneration! : projection.lease.leaseVersion,
      });
      const snapshot = await options.credentialFence.verify(tuple);
      // This resolver serves both reconnect and closure. The consumer owns the
      // blocking-fence polarity; an unfenced tuple is valid for reconnect.
      // No active row has no stored generation. Active or declared generations remain exact.
      if ((snapshot.active || snapshot.credentialGeneration !== undefined) &&
          snapshot.credentialGeneration !== tuple.credentialGeneration) {
        fail("LIVEKIT_ADMIN_FENCE_GENERATION_DRIFT");
      }
      return tuple;
    })()),
    resolveHandoffFence: (
      { binding: old }: Parameters<RealtimeExternalEffectProductionBindingResolver["resolveHandoffFence"]>[0],
    ): Promise<RealtimeExternalEffectHandoffFence> => track((async () => {
      assertExternalBinding(old);
      const projection = await current(old.realtimeSessionRef);
      if (projection.session.continuityId !== old.continuityId ||
          projection.session.connectionEpoch !== old.connectionEpoch ||
          same(projection.lease.deviceLeaseRef, old.deviceLeaseRef) ||
          projection.session.activeDeviceId === old.deviceId) {
        fail("LIVEKIT_ADMIN_HANDOFF_FENCE_INVALID");
      }
      return Object.freeze({
        fromDeviceId: old.deviceId,
        previousDeviceLeaseRef: old.deviceLeaseRef,
        newDeviceLeaseRef: projection.lease.deviceLeaseRef,
        connectionEpoch: old.connectionEpoch,
        fencingToken: projection.lease.fencingToken,
        evidenceRefs: Object.freeze([
          projection.session.realtimeSessionRef,
          projection.lease.deviceLeaseRef,
        ]),
      });
    })()),
    resolveReconnectBinding: (
      { participant: owner }: Parameters<RealtimeExternalEffectProductionBindingResolver["resolveReconnectBinding"]>[0],
    ): Promise<RealtimeExternalEffectBinding> => track((async () => {
      const exact = participantBinding(owner);
      const projection = await current(exact.realtimeSessionRef);
      assertParticipantMatchesCurrent(exact, projection);
      return bindingFrom(exact, projection.session.activeDeviceId);
    })()),
    close: () => close(),
  });

  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    closeFlight = Promise.allSettled([...flights]).then(() => undefined);
    return closeFlight;
  };

  return Object.freeze({ roomAdmin, binding, credentialFence: options.credentialFence, close });
}

export const createLiveKitRoomAdmin = createRealtimePublicControlLiveKitRoomAdmin;

const TRANSPORT_DISCONNECTION_TIMEOUT_MS = 5_000;

export interface RealtimePublicControlLiveKitTransportDisconnectionOptions {
  readonly serverUrl: string;
  readonly apiUrl?: string;
  readonly apiKeyRef: SecretReference;
  readonly apiSecretRef: SecretReference;
  readonly secretResolver: SecretResolverPort;
  readonly readiness: () => boolean;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly createRoomService?: (input: Readonly<{
    readonly host: string;
    readonly apiKey: string;
    readonly apiSecret: string;
  }>) => RoomAdminClient;
}

function assertTransportBinding(
  input: Parameters<TransportDisconnectionPort["verify"]>[0],
): { readonly binding: RealtimeTransportBinding; readonly roomName: string } {
  if (input === null || typeof input !== "object") fail("LIVEKIT_DISCONNECTION_INPUT_INVALID");
  const binding = input.binding;
  if (binding === null || typeof binding !== "object" || binding.state !== "connected" ||
      binding.provider !== "livekit-cloud" || input.deviceId !== binding.deviceId) {
    fail("LIVEKIT_DISCONNECTION_BINDING_INVALID");
  }
  text(input.userId, "LIVEKIT_DISCONNECTION_USER_INVALID");
  text(binding.deviceId, "LIVEKIT_DISCONNECTION_DEVICE_INVALID");
  text(binding.continuityId, "LIVEKIT_DISCONNECTION_CONTINUITY_INVALID");
  decimal(binding.connectionEpoch, "LIVEKIT_DISCONNECTION_EPOCH_INVALID");
  assertCanonicalTimestamp(input.occurredAt);
  if (input.governance === undefined) fail("LIVEKIT_DISCONNECTION_GOVERNANCE_INVALID");
  canonical(input.governance);
  canonical(binding.realtimeSessionRef);
  canonical(binding.deviceLeaseRef);
  canonical(binding.transportSessionAlias);
  canonical(binding.roomAlias);
  canonical(binding.deviceAlias);
  text(binding.connectionId, "LIVEKIT_DISCONNECTION_CONNECTION_INVALID");
  const names = projectionNames(binding);
  return Object.freeze({ binding, roomName: names.roomName });
}

/**
 * Production room-empty proof for fully-disconnected recovery. This is
 * deliberately PG-free: T02 has already supplied the connected binding and
 * this port only proves the old LiveKit room is empty.
 */
export function createRealtimePublicControlLiveKitTransportDisconnection(
  options: RealtimePublicControlLiveKitTransportDisconnectionOptions,
): ProductionPortRegistration<TransportDisconnectionPort> {
  if (!isRecord(options) || assertCanonicalLiveKitCloudProjectUrl(options.serverUrl) !== options.serverUrl ||
      typeof options.secretResolver?.resolve !== "function" ||
      typeof options.readiness !== "function" ||
      (options.createRoomService !== undefined && typeof options.createRoomService !== "function")) {
    fail("LIVEKIT_DISCONNECTION_OPTIONS_INVALID");
  }
  exactReference(options.apiKeyRef, PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey, "LIVEKIT_DISCONNECTION_API_KEY_REF_INVALID");
  exactReference(options.apiSecretRef, PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret, "LIVEKIT_DISCONNECTION_API_SECRET_REF_INVALID");
  const now = options.now ?? Date.now;
  if (typeof now !== "function") fail("LIVEKIT_DISCONNECTION_CLOCK_INVALID");
  const timeoutMs = options.timeoutMs ?? TRANSPORT_DISCONNECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TRANSPORT_DISCONNECTION_TIMEOUT_MS) {
    fail("LIVEKIT_DISCONNECTION_TIMEOUT_INVALID");
  }
  const httpHost = livekitApiOrigin(options.serverUrl, options.apiUrl);
  let closed = false;
  let closeFlight: Promise<void> | undefined;
  const flights = new Set<Promise<unknown>>();
  const ready = (): boolean => {
    if (closed) return false;
    try { return options.readiness() === true; } catch { return false; }
  };
  const guard = (): void => {
    if (closed) fail("LIVEKIT_DISCONNECTION_CLOSED");
    if (!ready()) fail("LIVEKIT_DISCONNECTION_NOT_READY");
  };
  const track = <T>(flight: Promise<T>): Promise<T> => {
    flights.add(flight);
    void flight.finally(() => flights.delete(flight)).catch(() => undefined);
    return flight;
  };
  const listParticipantsWithTimeout = async (
    service: RoomAdminClient,
    roomName: string,
  ): Promise<readonly { readonly identity?: unknown }[]> => {
    const listFlight = Promise.resolve().then(() => service.listParticipants(roomName));
    void listFlight.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RealtimePublicControlLiveKitRoomAdminError("LIVEKIT_DISCONNECTION_TIMEOUT")), timeoutMs);
    });
    try {
      return await Promise.race([listFlight, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const verify: TransportDisconnectionPort["verify"] = (input) => track((async (): Promise<VerifiedTransportDisconnection> => {
    guard();
    const { binding, roomName } = assertTransportBinding(input);
    const occurredAt = assertCanonicalTimestamp(input.occurredAt);
    let keyLease: Awaited<ReturnType<SecretResolverPort["resolve"]>> | undefined;
    let secretLease: Awaited<ReturnType<SecretResolverPort["resolve"]>> | undefined;
    try {
      keyLease = await options.secretResolver.resolve(options.apiKeyRef);
      secretLease = await options.secretResolver.resolve(options.apiSecretRef);
      const apiKey = keyLease.read();
      const apiSecret = secretLease.read();
      if (!API_KEY.test(apiKey) || !API_SECRET.test(apiSecret)) fail("LIVEKIT_DISCONNECTION_SECRET_INVALID");
      guard();
      const service = options.createRoomService === undefined
        ? new RoomServiceClient(httpHost, apiKey, apiSecret)
        : options.createRoomService({ host: httpHost, apiKey, apiSecret });
      const listed = await listParticipantsWithTimeout(service, roomName);
      if (!Array.isArray(listed)) fail("LIVEKIT_DISCONNECTION_PARTICIPANTS_INVALID");
      if (listed.length !== 0) fail("LIVEKIT_DISCONNECTION_ROOM_NOT_EMPTY");
      guard();
      let verifiedAt: ReturnType<typeof assertCanonicalTimestamp>;
      try { verifiedAt = assertCanonicalTimestamp(new Date(now()).toISOString()); }
      catch { fail("LIVEKIT_DISCONNECTION_CLOCK_INVALID"); }
      const proof = snapshotOpaqueOwnerValue(Object.freeze({
        kind: "realtime.transport.disconnection.livekit-room-empty.v1",
        verifiedAt,
        userId: input.userId,
        deviceId: binding.deviceId,
        roomName,
        sessionRef: binding.realtimeSessionRef,
        leaseRef: binding.deviceLeaseRef,
        continuityId: binding.continuityId,
        epoch: binding.connectionEpoch,
        count: 0,
      }));
      return Object.freeze({ verified: true, disconnectedAt: occurredAt, authorityProof: proof });
    } catch (error) {
      if (error instanceof RealtimePublicControlLiveKitRoomAdminError) throw error;
      fail("LIVEKIT_DISCONNECTION_SERVICE_FAILED");
    } finally {
      try { secretLease?.release?.(); } catch { /* best effort */ }
      try { keyLease?.release?.(); } catch { /* best effort */ }
    }
  })());
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    closeFlight = Promise.allSettled([...flights]).then(() => undefined);
    return closeFlight;
  };
  const port: TransportDisconnectionPort = Object.freeze({ verify });
  const readiness = Object.freeze({
    owner: "T04.livekit-room-empty",
    environment: "production" as const,
    isReady: ready,
    reason: "LIVEKIT_DISCONNECTION_NOT_READY",
  });
  return Object.freeze({ port, readiness, close });
}

export const createRealtimePublicControlLiveKitTransportDisconnectionRegistration =
  createRealtimePublicControlLiveKitTransportDisconnection;
