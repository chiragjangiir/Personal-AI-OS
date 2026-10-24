import assert from "node:assert/strict";
import test from "node:test";

import type {
  CredentialFencePort,
  CredentialFenceTuple,
} from "../../../services/platform-data/src/realtime-credential-fence.ts";
import type {
  LiveKitCloudParticipantBinding,
  LiveKitCloudParticipantPort,
} from "../src/livekit-cloud-participant.ts";
import {
  createRealtimePublicControlExternalEffectProduction,
  type RealtimeExternalEffectProductionBindingResolver,
  type RealtimeExternalEffectProductionOptions,
  type RealtimeExternalEffectRoomAdminPort,
} from "../src/realtime-public-control-external-effect-production.ts";
import type { RealtimeExternalEffectBinding } from "../src/realtime-public-control-external-effect-executor.ts";

const sessionRef = Object.freeze({
  ref_type: "RealtimeSession" as const,
  ref_id: "00000000-0000-7000-8000-000000000001",
  object_version: "1",
  canonical_payload_sha256: "1".repeat(64),
});
const leaseRef = Object.freeze({
  ref_type: "DeviceLease" as const,
  ref_id: "00000000-0000-7000-8000-000000000002",
  object_version: "1",
  canonical_payload_sha256: "2".repeat(64),
});
const nextLeaseRef = Object.freeze({
  ref_type: "DeviceLease" as const,
  ref_id: "00000000-0000-7000-8000-000000000003",
  object_version: "1",
  canonical_payload_sha256: "3".repeat(64),
});

const binding: RealtimeExternalEffectBinding = Object.freeze({
  realtimeSessionRef: sessionRef,
  deviceLeaseRef: leaseRef,
  continuityId: "continuity-owner-1",
  connectionEpoch: "7",
  deviceId: "device-owner-1",
  roomName: "room-owner-1",
  participantIdentity: "participant-owner-1",
});

const participantBinding: LiveKitCloudParticipantBinding = Object.freeze({
  realtimeSessionRef: sessionRef,
  deviceLeaseRef: leaseRef,
  continuityId: "continuity-owner-1",
  transportAliases: Object.freeze(["transport-owner-1"]),
  connectionEpoch: "7",
});

const fenceTuple: CredentialFenceTuple = Object.freeze({
  realtimeSessionRef: sessionRef,
  deviceLeaseRef: leaseRef,
  continuityId: binding.continuityId,
  connectionEpoch: binding.connectionEpoch,
  credentialGeneration: "3",
});

function code(error: unknown): string | undefined {
  return error instanceof Error && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as unknown as { readonly code: string }).code : undefined;
}

interface Harness {
  readonly options: RealtimeExternalEffectProductionOptions;
  readonly calls: {
    unpublish: number;
    disconnect: number;
    verifyClosed: number;
    remove: string[];
    list: number;
    fenceVerify: number;
    roomClose: number;
    fenceClose: number;
    bindingClose: number;
  };
  readonly setConnected: (value: boolean) => void;
  readonly setFenceActive: (value: boolean) => void;
  readonly setSurviving: (value: boolean) => void;
  readonly setOwned: (value: boolean) => void;
  readonly guard: () => ((value: LiveKitCloudParticipantBinding) => Promise<void>) | undefined;
}

function harness(): Harness {
  let connected = true;
  let fenceActive = true;
  let surviving = false;
  let owned = true;
  let guard: ((value: LiveKitCloudParticipantBinding) => Promise<void>) | undefined;
  const calls: Harness["calls"] = {
    unpublish: 0, disconnect: 0, verifyClosed: 0, remove: [], list: 0, fenceVerify: 0,
    roomClose: 0, fenceClose: 0, bindingClose: 0,
  };
  const participant: LiveKitCloudParticipantPort = {
    connect: async () => undefined,
    snapshot: () => Object.freeze({
      connected,
      transportState: connected ? "connected" as const : "disconnected" as const,
      projectUrl: "wss://ai.example.invalid",
      roomName: binding.roomName,
      identity: binding.participantIdentity,
      connectionEpoch: binding.connectionEpoch,
    }),
    bindingSnapshot: () => owned ? participantBinding : undefined,
    disconnect: async () => { calls.disconnect += 1; connected = false; },
    unpublishAllTracks: async () => { calls.unpublish += 1; },
    verifyClosed: async () => { calls.verifyClosed += 1; },
    setReconnectAdmissionGuard: (value) => { guard = value; },
    close: async () => { connected = false; },
  };
  const roomAdmin: RealtimeExternalEffectRoomAdminPort = {
    environment: "production",
    isReady: () => true,
    removeParticipant: async (_room, identity) => { calls.remove.push(identity); },
    listParticipants: async () => { calls.list += 1; return surviving ? [{ identity: binding.participantIdentity }] : []; },
    close: async () => { calls.roomClose += 1; },
  };
  const credentialFence: CredentialFencePort = {
    lock: async () => undefined,
    install: async () => undefined,
    verify: async () => { calls.fenceVerify += 1; return fenceActive ? { active: true, credentialGeneration: "3" } : { active: false }; },
    replay: async () => ({ active: false }),
    withAdmission: async (_tuple, callback) => callback(),
    close: async () => { calls.fenceClose += 1; },
  };
  const resolver: RealtimeExternalEffectProductionBindingResolver = {
    environment: "production",
    isReady: () => true,
    resolveMediaStop: async () => binding,
    resolveHandoff: async () => binding,
    resolveCredentialFence: async () => fenceTuple,
    resolveHandoffFence: async () => ({
      fromDeviceId: binding.deviceId,
      previousDeviceLeaseRef: leaseRef,
      newDeviceLeaseRef: nextLeaseRef,
      connectionEpoch: binding.connectionEpoch,
      fencingToken: "9",
      evidenceRefs: ["evidence-1"],
    }),
    resolveReconnectBinding: async () => binding,
    close: async () => { calls.bindingClose += 1; },
  };
  const options: RealtimeExternalEffectProductionOptions = {
    participant,
    roomAdmin,
    credentialFence,
    binding: resolver,
    readiness: {
      participant: () => true,
      roomAdmin: () => true,
      credentialFence: () => true,
      binding: () => true,
    },
  };
  return {
    options, calls, setConnected: (value) => { connected = value; },
    setFenceActive: (value) => { fenceActive = value; }, setSurviving: (value) => { surviving = value; },
    setOwned: (value) => { owned = value; if (!value) connected = false; }, guard: () => guard,
  };
}

test("requires every real cleanup owner and readiness seam", () => {
  const h = harness();
  assert.throws(
    () => createRealtimePublicControlExternalEffectProduction({ ...h.options, readiness: undefined } as never),
    /EXTERNAL_EFFECT_PRODUCTION_READINESS_REQUIRED/,
  );
  assert.throws(
    () => createRealtimePublicControlExternalEffectProduction({ ...h.options, participant: { snapshot: h.options.participant.snapshot } } as never),
    /EXTERNAL_EFFECT_PRODUCTION_PARTICIPANT_REQUIRED/,
  );
});

test("performs real local unpublish, disconnect, fence verification, and remote closure verification", async () => {
  const h = harness();
  const owner = createRealtimePublicControlExternalEffectProduction(h.options);
  assert.equal(owner.isReady(), true);
  await owner.unpublishTracks({ binding, fingerprint: "media-stop-1" });
  await owner.disconnectParticipant({ binding, fingerprint: "media-stop-1" });
  h.setConnected(false);
  await owner.revokeCredential({ binding, fingerprint: "media-stop-1" });
  await owner.verifyClosed({ binding, fingerprint: "media-stop-1" });
  assert.equal(h.calls.unpublish, 1);
  assert.equal(h.calls.disconnect, 1);
  assert.equal(h.calls.fenceVerify, 1);
  assert.equal(h.calls.verifyClosed, 1);
  assert.equal(h.calls.list, 1);
  await owner.close!();
});

test("a stop the process no longer holds (gateway restart, superseding Start) is cleaned up server side", async () => {
  const h = harness();
  const owner = createRealtimePublicControlExternalEffectProduction(h.options);
  h.setOwned(false);
  await owner.unpublishTracks({ binding, fingerprint: "media-stop-restart" });
  await owner.disconnectParticipant({ binding, fingerprint: "media-stop-restart" });
  await owner.revokeCredential({ binding, fingerprint: "media-stop-restart" });
  await owner.verifyClosed({ binding, fingerprint: "media-stop-restart" });
  assert.equal(h.calls.unpublish, 0, "nothing of the binding is published from this process");
  assert.equal(h.calls.disconnect, 0, "the in-process participant belongs to another session");
  assert.deepEqual(h.calls.remove, [binding.participantIdentity]);
  assert.equal(h.calls.fenceVerify, 1);
  assert.equal(h.calls.verifyClosed, 0);
  assert.equal(h.calls.list, 1);
  h.setSurviving(true);
  await assert.rejects(
    owner.verifyClosed({ binding, fingerprint: "media-stop-restart" }),
    (error: unknown) => code(error) === "EXTERNAL_EFFECT_PRODUCTION_PARTICIPANT_REMAINS",
  );
  await owner.close!();
});

test("fence binding equality ignores key order of canonical refs", async () => {
  const h = harness();
  const reordered = (ref: Record<string, unknown>) => Object.fromEntries(Object.entries(ref).reverse());
  const owner = createRealtimePublicControlExternalEffectProduction({
    ...h.options,
    binding: { ...h.options.binding, resolveCredentialFence: async () => ({
      ...fenceTuple,
      realtimeSessionRef: reordered(fenceTuple.realtimeSessionRef as Record<string, unknown>),
      deviceLeaseRef: reordered(fenceTuple.deviceLeaseRef as Record<string, unknown>),
    }) as never },
  });
  await owner.revokeCredential({ binding, fingerprint: "media-stop-order" });
  assert.equal(h.calls.fenceVerify, 1);
  await owner.close!();
});

test("fails closed on an inactive credential fence and on a surviving participant", async () => {
  const h = harness();
  const owner = createRealtimePublicControlExternalEffectProduction(h.options);
  h.setFenceActive(false);
  await assert.rejects(
    owner.revokeCredential({ binding, fingerprint: "media-stop-2" }),
    (error: unknown) => code(error) === "EXTERNAL_EFFECT_PRODUCTION_FENCE_INACTIVE",
  );
  await owner.close!();

  const h2 = harness();
  h2.setSurviving(true);
  const owner2 = createRealtimePublicControlExternalEffectProduction(h2.options);
  h2.setConnected(false);
  await assert.rejects(
    owner2.verifyClosed({ binding, fingerprint: "media-stop-3" }),
    (error: unknown) => code(error) === "EXTERNAL_EFFECT_PRODUCTION_PARTICIPANT_REMAINS",
  );
  await owner2.close!();
});

test("suppresses the old participant, verifies absence, and returns the exact T11B fence", async () => {
  const h = harness();
  const owner = createRealtimePublicControlExternalEffectProduction(h.options);
  const result = await owner.suppressAndClose({ binding, fingerprint: "handoff-1", operation: "handoff" });
  assert.deepEqual(result, {
    state: "old_device_suppressed",
    closure_status: "verified_closed",
    old_device_suppression_fence: {
      from_device_id: binding.deviceId,
      previous_device_lease_ref: leaseRef,
      new_device_lease_ref: nextLeaseRef,
      connection_epoch: binding.connectionEpoch,
      fencing_token: "9",
      state: "old_device_suppressed",
    },
    evidence_refs: ["evidence-1"],
  });
  assert.equal(h.calls.remove.length, 1);
  assert.equal(h.calls.remove[0], binding.participantIdentity);
  assert.equal(Object.isFrozen(result), true);
  await owner.close!();
});

test("reconnect admission checks the authoritative fence and close is idempotent", async () => {
  const h = harness();
  const owner = createRealtimePublicControlExternalEffectProduction(h.options);
  const reconnectGuard = h.guard();
  assert.ok(reconnectGuard);
  h.setFenceActive(false);
  await reconnectGuard(participantBinding);
  h.setFenceActive(true);
  await assert.rejects(
    reconnectGuard(participantBinding),
    (error: unknown) => code(error) === "EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED",
  );
  await owner.close!();
  await owner.close!();
  assert.equal(h.calls.roomClose, 1);
  assert.equal(h.calls.fenceClose, 1);
  assert.equal(h.calls.bindingClose, 1);
});


test("cleanup selects the stopped device participant and leaves the other terminal connected", async () => {
  const other = harness();
  const stopped = harness();
  const devices: string[] = [];
  const owner = createRealtimePublicControlExternalEffectProduction({
    ...other.options,
    participantForDevice: (deviceId) => { devices.push(deviceId); return stopped.options.participant; },
  });
  const context = { binding, fingerprint: "device-stop" };
  await owner.unpublishTracks(context);
  await owner.disconnectParticipant(context);
  await owner.verifyClosed(context);
  assert.deepEqual(devices, [binding.deviceId, binding.deviceId, binding.deviceId]);
  assert.equal(stopped.calls.unpublish, 1);
  assert.equal(stopped.calls.disconnect, 1);
  assert.equal(stopped.calls.verifyClosed, 1);
  assert.equal(other.calls.unpublish, 0);
  assert.equal(other.calls.disconnect, 0);
  assert.equal(other.options.participant.snapshot().connected, true);
  await owner.close?.();
});


test("missing local device participant still completes authoritative remote cleanup", async () => {
  const h = harness();
  const owner = createRealtimePublicControlExternalEffectProduction({...h.options,participantForDevice:()=>undefined});
  const context = {binding,fingerprint:"removed-device-stop"};
  await owner.unpublishTracks(context);
  await owner.disconnectParticipant(context);
  await owner.verifyClosed(context);
  assert.equal(h.calls.unpublish,0);
  assert.equal(h.calls.disconnect,0);
  assert.equal(h.calls.verifyClosed,0);
  assert.deepEqual(h.calls.remove,[binding.participantIdentity]);
  assert.equal(h.calls.list,1);
  assert.equal(h.options.participant.snapshot().connected,true);
  await owner.close?.();
});
