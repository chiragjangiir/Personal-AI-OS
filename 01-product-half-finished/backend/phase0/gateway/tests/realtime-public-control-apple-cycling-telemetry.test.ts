import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  ApplePhysicalCanaryBindingPostgresPort,
  ApplePhysicalCanaryBindingReceipt,
} from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import {
  APPLE_CYCLING_TELEMETRY_REQUIRED_CHANNELS,
  createRealtimePublicControlAppleCyclingTelemetry,
  RealtimePublicControlAppleCyclingTelemetryError,
  type AppleCyclingTelemetryProjection,
} from '../src/realtime-public-control-apple-cycling-telemetry.ts';

const NOW = '2026-08-30T10:00:10.000Z';
const BINDING_ID = '018f0000-0000-7000-8000-000000000001';
const IPHONE_DEVICE = '018f0000-0000-7000-8000-000000000002';
const IPHONE_CLIENT = '018f0000-0000-7000-8000-000000000003';
const WATCH_DEVICE = '018f0000-0000-7000-8000-000000000004';
const WATCH_CLIENT = '018f0000-0000-7000-8000-000000000005';
const SESSION_REF = Object.freeze({
  ref_type: 'RealtimeSession', ref_id: '018f0000-0000-7000-8000-000000000006',
  object_version: '1', canonical_payload_sha256: '1'.repeat(64),
});
const IPHONE_LEASE_REF = Object.freeze({
  ref_type: 'DeviceLease', ref_id: '018f0000-0000-7000-8000-000000000007',
  object_version: '1', canonical_payload_sha256: '2'.repeat(64),
});
const WATCH_LEASE_REF = Object.freeze({
  ref_type: 'DeviceLease', ref_id: '018f0000-0000-7000-8000-000000000008',
  object_version: '1', canonical_payload_sha256: '3'.repeat(64),
});

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function binding(): ApplePhysicalCanaryBindingReceipt {
  return Object.freeze({
    kind: 't02.apple.physical-canary-binding.v1',
    bindingId: BINDING_ID,
    canonicalPayloadSha256: '4'.repeat(64),
    expiresAt: '2026-08-30T10:05:00.000Z',
    idempotencyKey: 'fixture-idempotency',
    iphone: Object.freeze({ deviceId: IPHONE_DEVICE, clientInstanceId: IPHONE_CLIENT, deviceLeaseRef: IPHONE_LEASE_REF }),
    issuedAt: '2026-08-30T10:00:00.000Z',
    objectVersion: '1',
    realtimeSessionRef: SESSION_REF,
    requestFingerprintSha256: '5'.repeat(64),
    requestId: 'fixture-request',
    watch: Object.freeze({ deviceId: WATCH_DEVICE, clientInstanceId: WATCH_CLIENT, deviceLeaseRef: WATCH_LEASE_REF }),
  });
}

function projection(bytes: Uint8Array): AppleCyclingTelemetryProjection {
  return Object.freeze({
    bindingId: BINDING_ID,
    format: 'paios.apple-cycling-telemetry.v1+json',
    channels: APPLE_CYCLING_TELEMETRY_REQUIRED_CHANNELS,
    payload: bytes,
    payloadSha256: sha256(bytes),
    realtimeSessionRef: SESSION_REF,
    iphone: Object.freeze({ deviceId: IPHONE_DEVICE, clientInstanceId: IPHONE_CLIENT, observedAt: '2026-08-30T10:00:09.000Z' }),
    watch: Object.freeze({ deviceId: WATCH_DEVICE, clientInstanceId: WATCH_CLIENT, observedAt: '2026-08-30T10:00:08.000Z' }),
  });
}

function harness(overrides: Readonly<{ binding?: ApplePhysicalCanaryBindingReceipt; consumerFails?: boolean }> = {}) {
  const bytes = new TextEncoder().encode('{"opaque":"fixture"}');
  const expectedHash = sha256(bytes);
  let releases = 0;
  let reads = 0;
  let deliveries = 0;
  const bindingPort = {
    async read() { reads += 1; return overrides.binding ?? binding(); },
  } as unknown as ApplePhysicalCanaryBindingPostgresPort;
  const port = createRealtimePublicControlAppleCyclingTelemetry({
    binding: bindingPort,
    input: {
      async take() { return projection(bytes); },
      release() { releases += 1; },
    },
    consumer: {
      async deliver(input) {
        deliveries += 1;
        assert.equal(sha256(input.payload), expectedHash);
        if (overrides.consumerFails) throw new Error('CONSUMER_FAILED');
        return {
          acceptedPayloadSha256: input.payloadSha256,
          deliveredAt: NOW,
          consumerReceiptSha256: '6'.repeat(64),
        };
      },
    },
    now: () => Date.parse(NOW),
  });
  return { bytes, expectedHash, port, counts: () => ({ releases, reads, deliveries }) };
}

test('checks the current Apple binding, delivers once, then zeroizes and retains only hashed evidence', async () => {
  const h = harness();
  const receipt = await h.port.deliver(Object.freeze({ source: 'apple-owner' }));
  assert.equal(receipt.payloadSha256, h.expectedHash);
  assert.equal(receipt.bindingId, BINDING_ID);
  assert.deepEqual(receipt.realtimeSessionRef, SESSION_REF);
  assert.equal(receipt.consumerReceiptSha256, '6'.repeat(64));
  assert.match(receipt.canonicalPayloadSha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(receipt).includes('opaque'), false);
  assert.deepEqual([...h.bytes], new Array(h.bytes.length).fill(0));
  assert.deepEqual(h.counts(), { releases: 1, reads: 1, deliveries: 1 });
  await h.port.close();
  await h.port.close();
  await assert.rejects(h.port.deliver({ source: 'after-close' }), /CYCLING_COMPOSITION_CLOSED/u);
  assert.deepEqual(h.counts(), { releases: 1, reads: 1, deliveries: 1 });
});

test('binding drift fails before consumer delivery and still zeroizes/releases the transferred bytes', async () => {
  const drifted = Object.freeze({
    ...binding(),
    watch: Object.freeze({ ...binding().watch, clientInstanceId: '018f0000-0000-7000-8000-000000000009' }),
  });
  const h = harness({ binding: drifted });
  await assert.rejects(h.port.deliver({ source: 'apple-owner' }), (error: unknown) =>
    error instanceof RealtimePublicControlAppleCyclingTelemetryError &&
    error.code === 'CYCLING_CURRENT_BINDING_MISMATCH');
  assert.deepEqual([...h.bytes], new Array(h.bytes.length).fill(0));
  assert.deepEqual(h.counts(), { releases: 1, reads: 1, deliveries: 0 });
});

test('consumer failure cannot leave telemetry bytes or an unreleased Apple input', async () => {
  const h = harness({ consumerFails: true });
  await assert.rejects(h.port.deliver({ source: 'apple-owner' }), /CONSUMER_FAILED/u);
  assert.deepEqual([...h.bytes], new Array(h.bytes.length).fill(0));
  assert.deepEqual(h.counts(), { releases: 1, reads: 1, deliveries: 1 });
});

test('invalid transferred projection is zeroized and released before any binding read', async () => {
  const bytes = new TextEncoder().encode('{"opaque":"invalid-fixture"}');
  let releases = 0;
  let reads = 0;
  const port = createRealtimePublicControlAppleCyclingTelemetry({
    binding: { async read() { reads += 1; return binding(); } } as unknown as ApplePhysicalCanaryBindingPostgresPort,
    input: {
      async take() { return { ...projection(bytes), payloadSha256: '0'.repeat(64) }; },
      release() { releases += 1; },
    },
    consumer: { async deliver() { throw new Error('CONSUMER_MUST_NOT_RUN'); } },
    now: () => Date.parse(NOW),
  });
  await assert.rejects(port.deliver({ source: 'invalid' }), /CYCLING_PAYLOAD_HASH_MISMATCH/u);
  assert.deepEqual([...bytes], new Array(bytes.length).fill(0));
  assert.equal(releases, 1);
  assert.equal(reads, 0);
});
