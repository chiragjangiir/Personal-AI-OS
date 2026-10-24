import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import type {
  JsonRecord,
  RealtimeMediaStopIntent,
} from "../../../services/platform-data/src/realtime-external-effect-coordinator.ts";
import {
  createRealtimePublicControlExternalEffectExecutor,
  type RealtimeExternalEffectBinding,
  type RealtimeExternalEffectBindingResolver,
  type RealtimeExternalEffectHandoffContext,
  type RealtimeExternalEffectOperationContext,
  type RealtimeExternalEffectOwner,
} from "../src/realtime-public-control-external-effect-executor.ts";

const binding: RealtimeExternalEffectBinding = Object.freeze({
  realtimeSessionRef: "realtime-session-owner-1",
  deviceLeaseRef: "device-lease-owner-1",
  continuityId: "continuity-owner-1",
  connectionEpoch: "7",
  deviceId: "device-owner-1",
  roomName: "room-owner-1",
  participantIdentity: "participant-owner-1",
});

function intent(fingerprint = "stop-fingerprint-1"): RealtimeMediaStopIntent {
  return {
    wireRequest: { operation: "media_stop" },
    request: { operation: "media_stop", request_id: "stop-request-1" },
    governance: { purpose: "explicit_user_stop" },
    fingerprint,
  };
}

interface Harness {
  readonly owner: RealtimeExternalEffectOwner;
  readonly resolver: RealtimeExternalEffectBindingResolver;
  readonly calls: {
    readonly unpublish: RealtimeExternalEffectOperationContext[];
    readonly disconnect: RealtimeExternalEffectOperationContext[];
    readonly revoke: RealtimeExternalEffectOperationContext[];
    readonly verify: RealtimeExternalEffectOperationContext[];
    readonly handoff: RealtimeExternalEffectHandoffContext[];
    ownerClose: number;
    bindingClose: number;
  };
}

interface Overrides {
  readonly unpublishTracks?: RealtimeExternalEffectOwner["unpublishTracks"];
  readonly disconnectParticipant?: RealtimeExternalEffectOwner["disconnectParticipant"];
  readonly revokeCredential?: RealtimeExternalEffectOwner["revokeCredential"];
  readonly verifyClosed?: RealtimeExternalEffectOwner["verifyClosed"];
  readonly suppressAndClose?: RealtimeExternalEffectOwner["suppressAndClose"];
  readonly ownerReady?: () => boolean;
  readonly bindingReady?: () => boolean;
}

function harness(overrides: Overrides = {}): Harness {
  const calls: Harness["calls"] = {
    unpublish: [],
    disconnect: [],
    revoke: [],
    verify: [],
    handoff: [],
    ownerClose: 0,
    bindingClose: 0,
  } satisfies Harness["calls"];
  const owner: RealtimeExternalEffectOwner = {
    environment: "production",
    isReady: overrides.ownerReady ?? (() => true),
    unpublishTracks: overrides.unpublishTracks ?? (async (input) => { calls.unpublish.push(input); }),
    disconnectParticipant: overrides.disconnectParticipant ?? (async (input) => { calls.disconnect.push(input); }),
    revokeCredential: overrides.revokeCredential ?? (async (input) => { calls.revoke.push(input); }),
    verifyClosed: overrides.verifyClosed ?? (async (input) => { calls.verify.push(input); }),
    suppressAndClose: overrides.suppressAndClose ?? (async (input) => {
      calls.handoff.push(input);
      return { status: "suppressed_and_closed", room: "verified_absent" };
    }),
    close: async () => { calls.ownerClose += 1; },
  };
  const resolver: RealtimeExternalEffectBindingResolver = {
    environment: "production",
    isReady: overrides.bindingReady ?? (() => true),
    resolveMediaStop: async () => binding,
    resolveHandoff: async () => binding,
    close: async () => { calls.bindingClose += 1; },
  };
  return { owner, resolver, calls };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as unknown as { readonly code: string }).code
    : undefined;
}

test("requires real production owner methods and a binding resolver", () => {
  const valid = harness();
  assert.throws(
    () => createRealtimePublicControlExternalEffectExecutor({
      owner: { environment: "production", isReady: () => true } as never,
      binding: valid.resolver,
    }),
    /EXTERNAL_EFFECT_UNPUBLISHTRACKS_REQUIRED/,
  );
  assert.throws(
    () => createRealtimePublicControlExternalEffectExecutor({
      owner: valid.owner,
      binding: { environment: "production", isReady: () => true } as never,
    }),
    /EXTERNAL_EFFECT_BINDING_RESOLVE_MEDIA_STOP_REQUIRED/,
  );
});

test("executes each media stage against an authoritative binding", async () => {
  const h = harness();
  const executor = createRealtimePublicControlExternalEffectExecutor({ owner: h.owner, binding: h.resolver });
  assert.deepEqual(executor.readiness(), { ready: true, closed: false, owner: true, binding: true });
  for (const stage of ["tracks_unpublished", "participant_disconnected", "credential_revoked", "closure_verified"] as const) {
    await executor.executeStage({ stage, intent: intent() });
  }
  assert.equal(h.calls.unpublish.length, 1);
  assert.equal(h.calls.disconnect.length, 1);
  assert.equal(h.calls.revoke.length, 1);
  assert.equal(h.calls.verify.length, 1);
  for (const context of [h.calls.unpublish[0], h.calls.disconnect[0], h.calls.revoke[0], h.calls.verify[0]]) {
    assert.deepEqual(context?.binding, binding);
    assert.equal(context?.fingerprint, "stop-fingerprint-1");
    assert.equal("intent" in (context ?? {}), false);
    assert.equal(Object.isFrozen(context?.binding), true);
  }
  await executor.close();
});

test("deduplicates concurrent and completed stage replay, but permits a failed retry", async () => {
  let release!: () => void;
  let calls = 0;
  const h = harness({
    unpublishTracks: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    },
  });
  const executor = createRealtimePublicControlExternalEffectExecutor({ owner: h.owner, binding: h.resolver });
  const first = executor.executeStage({ stage: "tracks_unpublished", intent: intent() });
  const second = executor.executeStage({ stage: "tracks_unpublished", intent: intent() });
  await setImmediate();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await executor.executeStage({ stage: "tracks_unpublished", intent: intent() });
  assert.equal(calls, 1);
  await executor.close();

  let failOnce = true;
  let retryCalls = 0;
  const retryHarness = harness({
    revokeCredential: async () => {
      retryCalls += 1;
      if (failOnce) {
        failOnce = false;
        throw new Error("raw bearer=must-not-leak");
      }
    },
  });
  const retryExecutor = createRealtimePublicControlExternalEffectExecutor({ owner: retryHarness.owner, binding: retryHarness.resolver });
  await assert.rejects(
    retryExecutor.executeStage({ stage: "credential_revoked", intent: intent("retry-fingerprint") }),
    (error: unknown) => errorCode(error) === "EXTERNAL_EFFECT_OWNER_FAILED" && !(error instanceof Error && error.message.includes("bearer")),
  );
  await retryExecutor.executeStage({ stage: "credential_revoked", intent: intent("retry-fingerprint") });
  assert.equal(retryCalls, 2);
  await retryExecutor.close();
});

test("times out an owner operation without claiming completion", async () => {
  const h = harness({ unpublishTracks: async () => await new Promise<void>(() => undefined) });
  const executor = createRealtimePublicControlExternalEffectExecutor({ owner: h.owner, binding: h.resolver, timeoutMs: 5 });
  await assert.rejects(
    executor.executeStage({ stage: "tracks_unpublished", intent: intent("timeout-fingerprint") }),
    (error: unknown) => errorCode(error) === "EXTERNAL_EFFECT_TIMEOUT",
  );
  await executor.close();
});

test("suppresses the old handoff participant, sanitizes output, and replays once", async () => {
  const h = harness();
  const executor = createRealtimePublicControlExternalEffectExecutor({ owner: h.owner, binding: h.resolver });
  const request: JsonRecord = { request_id: "handoff-request-1" };
  const first = await executor.suppressAndClose({ request, authorityResult: { accepted: true } });
  const second = await executor.suppressAndClose({ request, authorityResult: { accepted: true } });
  assert.equal(h.calls.handoff.length, 1);
  assert.deepEqual(first, second);
  assert.equal((first as { readonly status: string }).status, "suppressed_and_closed");
  assert.equal(Object.isFrozen(first), true);
  await executor.close();

  const fenced = harness({ suppressAndClose: async () => ({
    state: "old_device_suppressed",
    old_device_suppression_fence: { fencing_token: "9" },
  }) });
  const fencedExecutor = createRealtimePublicControlExternalEffectExecutor({ owner: fenced.owner, binding: fenced.resolver });
  const fencedResult = await fencedExecutor.suppressAndClose({ request, authorityResult: {} });
  assert.equal((fencedResult as { readonly old_device_suppression_fence: { readonly fencing_token: string } }).old_device_suppression_fence.fencing_token, "9");
  await fencedExecutor.close();

  const unsafe = harness({ suppressAndClose: async () => ({ token: "raw-secret" }) });
  const unsafeExecutor = createRealtimePublicControlExternalEffectExecutor({ owner: unsafe.owner, binding: unsafe.resolver });
  await assert.rejects(
    unsafeExecutor.suppressAndClose({ request, authorityResult: {} }),
    (error: unknown) => errorCode(error) === "EXTERNAL_EFFECT_RESULT_UNSAFE",
  );
  await unsafeExecutor.close();

  const misplaced = harness({ suppressAndClose: async () => ({ fencing_token: "9" }) });
  const misplacedExecutor = createRealtimePublicControlExternalEffectExecutor({ owner: misplaced.owner, binding: misplaced.resolver });
  await assert.rejects(
    misplacedExecutor.suppressAndClose({ request, authorityResult: {} }),
    (error: unknown) => errorCode(error) === "EXTERNAL_EFFECT_RESULT_UNSAFE",
  );
  await misplacedExecutor.close();

  const malformedFence = harness({ suppressAndClose: async () => ({
    old_device_suppression_fence: { fencing_token: "0" },
  }) });
  const malformedFenceExecutor = createRealtimePublicControlExternalEffectExecutor({ owner: malformedFence.owner, binding: malformedFence.resolver });
  await assert.rejects(
    malformedFenceExecutor.suppressAndClose({ request, authorityResult: {} }),
    (error: unknown) => errorCode(error) === "EXTERNAL_EFFECT_RESULT_FENCE_INVALID",
  );
  await malformedFenceExecutor.close();
});

test("fails closed when an owner is not ready and closes exactly once", async () => {
  const h = harness({ ownerReady: () => false });
  const executor = createRealtimePublicControlExternalEffectExecutor({ owner: h.owner, binding: h.resolver });
  assert.deepEqual(executor.readiness(), { ready: false, closed: false, owner: false, binding: true });
  await assert.rejects(
    executor.executeStage({ stage: "closure_verified", intent: intent("not-ready") }),
    (error: unknown) => errorCode(error) === "EXTERNAL_EFFECT_OWNER_NOT_READY",
  );
  await executor.close();
  await executor.close();
  assert.equal(h.calls.ownerClose, 1);
  assert.equal(h.calls.bindingClose, 1);
  assert.deepEqual(executor.readiness(), { ready: false, closed: true, owner: false, binding: false });
  assert.throws(() => executor.assertReady(), /EXTERNAL_EFFECT_OWNER_NOT_READY/);
});
