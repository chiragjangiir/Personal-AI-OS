import {
  assertDecimalConnectionEpoch,
  incrementDecimalConnectionEpoch,
  snapshotOpaqueOwnerValue,
  type DecimalConnectionEpoch,
  type ExternalAlias,
  type OpaqueCanonicalRef,
  type RealtimeTransportBinding,
} from "./types.ts";

export interface BindingEquality {
  readonly same: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean;
}

export function createTransportBinding(input: {
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly deviceId: string;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly provider: ExternalAlias;
  readonly transportSessionAlias: ExternalAlias;
  readonly roomAlias: ExternalAlias;
  readonly deviceAlias: ExternalAlias;
  readonly connectionId: string;
}): RealtimeTransportBinding {
  return Object.freeze({
    state: "connected",
    realtimeSessionRef: snapshotOpaqueOwnerValue(input.realtimeSessionRef),
    deviceLeaseRef: snapshotOpaqueOwnerValue(input.deviceLeaseRef),
    continuityId: input.continuityId,
    deviceId: input.deviceId,
    connectionEpoch: assertDecimalConnectionEpoch(input.connectionEpoch),
    provider: snapshotOpaqueOwnerValue(input.provider),
    transportSessionAlias: snapshotOpaqueOwnerValue(input.transportSessionAlias),
    roomAlias: snapshotOpaqueOwnerValue(input.roomAlias),
    deviceAlias: snapshotOpaqueOwnerValue(input.deviceAlias),
    connectionId: input.connectionId,
  });
}

export function assertConnectedRefreshBinding(
  current: RealtimeTransportBinding,
  requested: RealtimeTransportBinding,
  equality: BindingEquality,
): RealtimeTransportBinding {
  if (current.state !== "connected" || requested.state !== "connected") {
    throw new Error("TRANSPORT_NOT_CONNECTED");
  }
  assertBindingExactlyMatches(current, requested, equality);
  return current;
}

export function assertBindingExactlyMatches(
  current: RealtimeTransportBinding,
  requested: RealtimeTransportBinding,
  equality: BindingEquality,
): RealtimeTransportBinding {
  if (current.state !== requested.state ||
      !equality.same(current.realtimeSessionRef, requested.realtimeSessionRef) ||
      !equality.same(current.deviceLeaseRef, requested.deviceLeaseRef) ||
      current.continuityId !== requested.continuityId ||
      current.deviceId !== requested.deviceId ||
      current.connectionEpoch !== requested.connectionEpoch ||
      !equality.same(current.provider, requested.provider) ||
      !equality.same(current.transportSessionAlias, requested.transportSessionAlias) ||
      !equality.same(current.roomAlias, requested.roomAlias) ||
      !equality.same(current.deviceAlias, requested.deviceAlias) ||
      current.connectionId !== requested.connectionId) {
    throw new Error("TRANSPORT_BINDING_CONFLICT");
  }
  return current;
}

export function createFullyDisconnectedBinding(input: {
  readonly previous: RealtimeTransportBinding;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly deviceId: string;
  readonly connectionEpoch: DecimalConnectionEpoch;
  readonly transportSessionAlias: ExternalAlias;
  readonly roomAlias: ExternalAlias;
  readonly deviceAlias: ExternalAlias;
  readonly connectionId: string;
}): RealtimeTransportBinding {
  if (input.previous.state === "released") throw new Error("TRANSPORT_RELEASED");
  const epoch = assertDecimalConnectionEpoch(input.connectionEpoch);
  const previousEpoch = assertDecimalConnectionEpoch(input.previous.connectionEpoch);
  if (epoch !== incrementDecimalConnectionEpoch(previousEpoch)) {
    throw new Error("CONNECTION_EPOCH_NOT_ADVANCED");
  }
  return createTransportBinding({
    realtimeSessionRef: snapshotOpaqueOwnerValue(input.realtimeSessionRef),
    deviceLeaseRef: snapshotOpaqueOwnerValue(input.deviceLeaseRef),
    continuityId: input.previous.continuityId,
    deviceId: input.deviceId,
    connectionEpoch: epoch,
    provider: snapshotOpaqueOwnerValue(input.previous.provider),
    transportSessionAlias: snapshotOpaqueOwnerValue(input.transportSessionAlias),
    roomAlias: snapshotOpaqueOwnerValue(input.roomAlias),
    deviceAlias: snapshotOpaqueOwnerValue(input.deviceAlias),
    connectionId: input.connectionId,
  });
}

export function markBindingDisconnected(
  binding: RealtimeTransportBinding,
): RealtimeTransportBinding {
  if (binding.state === "released") return binding;
  return Object.freeze({ ...binding, state: "disconnected" as const });
}

export function releaseTransportBinding(
  binding: RealtimeTransportBinding,
): RealtimeTransportBinding {
  return Object.freeze({ ...binding, state: "released" as const });
}
