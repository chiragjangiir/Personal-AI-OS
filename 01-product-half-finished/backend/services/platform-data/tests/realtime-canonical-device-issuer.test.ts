import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertRealtimeCanonicalDeviceIdentityReceipt,
  createProductionRealtimeCanonicalDeviceIdentityIssuer,
  RealtimeCanonicalDeviceIdentityIssuerError,
  type RealtimeCanonicalDeviceIdentityIssueInput,
} from "../src/realtime-canonical-device-issuer.ts";

const INPUT: RealtimeCanonicalDeviceIdentityIssueInput = Object.freeze({
  rawDeviceId: "rayneo_device_aaaaaaaaaaaaaaaaaaaa",
  sessionId: "phase0_session_bbbbbbbbbbbbbbbbbbbb",
  clientInstanceId: "rayneo_client_cccccccccccccccccccc",
  eligibilityObservedAt: "2026-08-29T01:02:03.004Z",
  requestId: "rayneo_demo_current_binding_request_fixture",
});

function uuidTimestamp(value: string): bigint {
  return BigInt(`0x${value.replaceAll("-", "").slice(0, 12)}`);
}

async function rejectsCode(work: () => unknown, code: string): Promise<void> {
  assert.throws(work, (error: unknown) =>
    error instanceof RealtimeCanonicalDeviceIdentityIssuerError && error.code === code);
}

test("production issuer creates bound UUIDv7 receipts without deterministic string-derived identity", () => {
  const issuer = createProductionRealtimeCanonicalDeviceIdentityIssuer();
  const first = issuer.issue(INPUT);
  const second = issuer.issue(INPUT);
  assert.match(first.canonicalDeviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first.canonicalDeviceId, second.canonicalDeviceId);
  assert.equal(uuidTimestamp(first.canonicalDeviceId), BigInt(Date.parse(INPUT.eligibilityObservedAt)));
  assert.equal(first.objectVersion, "1");
  assert.match(first.canonicalPayloadSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(assertRealtimeCanonicalDeviceIdentityReceipt(first, INPUT), first);
});

test("receipt is bound to raw device, session, client, eligibility time and request", () => {
  const receipt = createProductionRealtimeCanonicalDeviceIdentityIssuer().issue(INPUT);
  for (const drift of [
    { rawDeviceId: "rayneo_device_dddddddddddddddddddd" },
    { sessionId: "phase0_session_dddddddddddddddddddd" },
    { clientInstanceId: "rayneo_client_dddddddddddddddddddd" },
    { eligibilityObservedAt: "2026-08-29T01:02:03.005Z" },
    { requestId: "rayneo_demo_current_binding_request_drift" },
  ]) {
    assert.throws(
      () => assertRealtimeCanonicalDeviceIdentityReceipt(receipt, { ...INPUT, ...drift }),
      (error: unknown) => error instanceof RealtimeCanonicalDeviceIdentityIssuerError &&
        error.code === "REALTIME_CANONICAL_DEVICE_RECEIPT_INVALID",
    );
  }
});

test("malformed receipt, input and accessors fail closed", async () => {
  const receipt = createProductionRealtimeCanonicalDeviceIdentityIssuer().issue(INPUT);
  await rejectsCode(
    () => assertRealtimeCanonicalDeviceIdentityReceipt({ ...receipt, objectVersion: "2" }, INPUT),
    "REALTIME_CANONICAL_DEVICE_RECEIPT_INVALID",
  );
  await rejectsCode(
    () => assertRealtimeCanonicalDeviceIdentityReceipt({ ...receipt, canonicalPayloadSha256: "b".repeat(64) }, INPUT),
    "REALTIME_CANONICAL_DEVICE_RECEIPT_INVALID",
  );
  const accessor = { ...INPUT } as Record<string, unknown>;
  Object.defineProperty(accessor, "rawDeviceId", { enumerable: true, get: () => INPUT.rawDeviceId });
  await rejectsCode(
    () => createProductionRealtimeCanonicalDeviceIdentityIssuer().issue(accessor as unknown as RealtimeCanonicalDeviceIdentityIssueInput),
    "REALTIME_CANONICAL_DEVICE_INPUT_INVALID",
  );
});

test("production source has no UUIDv4, environment, cache or string-derived UUID escape hatch", () => {
  const source = readFileSync(new URL("../src/realtime-canonical-device-issuer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /randomUUID|process\.env|new Map|createHash\([^)]*rawDeviceId/u);
  assert.match(source, /randomBytes\(10\)/u);
});
