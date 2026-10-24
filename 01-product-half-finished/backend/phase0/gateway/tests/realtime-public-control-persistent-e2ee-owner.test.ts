import assert from 'node:assert/strict';
import test from 'node:test';

import { PERSISTENT_PUBLIC_SECRET_REFERENCES } from '../src/realtime-public-control-persistent-public-ports.ts';
import { createRealtimePublicControlPersistentE2eeOwner } from '../src/realtime-public-control-persistent-e2ee-owner.ts';

const SESSION = Object.freeze({ ref_type: 'RealtimeSession', ref_id: 'session-1' });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: 'lease-1' });
const CONTINUITY = 'continuity-1';
const DEVICE = 'iphone-owner';
const GOVERNANCE = Object.freeze({ policy_decision_refs: ['policy-1'] });
const ROOT = Buffer.alloc(32, 9).toString('base64url');
const NOW = Date.parse('2030-01-01T00:00:00.000Z');

function current(generation = '1') {
  return {
    session: {
      realtimeSessionRef: SESSION, userId: 'owner', continuityId: CONTINUITY,
      state: 'active', continuityState: 'active', connectionEpoch: '7',
      continuityExpiresAt: '2030-01-01T00:30:00.000Z', lastAcceptedUserActivityAt: '2030-01-01T00:00:00.000Z',
      activeDeviceId: DEVICE, activeDeviceLeaseRef: LEASE,
      binding: {
        state: 'connected', realtimeSessionRef: SESSION, deviceLeaseRef: LEASE,
        continuityId: CONTINUITY, deviceId: DEVICE, connectionEpoch: '7', provider: 'livekit-cloud',
        transportSessionAlias: 'transport-1', roomAlias: 'room-1', deviceAlias: 'device-1', connectionId: 'connection-1',
      },
      revision: generation,
    },
    lease: {
      deviceLeaseRef: LEASE, realtimeSessionRef: SESSION, continuityId: CONTINUITY,
      userId: 'owner', deviceId: DEVICE, state: 'active', capabilities: ['audio', 'video', 'data'],
      purpose: 'cycling_assistant', issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:20:00.000Z',
      revocable: true, leaseVersion: generation, fencingToken: generation, policyDecisionRef: { ref_type: 'PolicyDecision' },
    },
  } as const;
}

function bootstrapRequest() {
  return {
    device_id: DEVICE,
    governance: GOVERNANCE,
    requested_media: { audio: true, video: true, data: true },
    start: { kind: 'explicit_user_start', modalities: ['audio', 'video', 'data'] },
  };
}

function fixture(generation = '1') {
  let binding = current(generation);
  let fenced = false;
  let ready = true;
  let releases = 0;
  const owner = createRealtimePublicControlPersistentE2eeOwner({
    pool: { connect: async () => { throw new Error('PG_NOT_USED_BY_BOOTSTRAP_TEST'); } } as never,
    rootKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey,
    secretResolver: {
      resolve: async () => ({ read: () => ROOT, release: () => { releases += 1; } }),
    },
    recipientCredential: {
      resolve: async () => ({
        publicKey: new Uint8Array(32), status: 'active', expiresAt: '2030-01-01T00:10:00.000Z',
        deviceId: DEVICE, credentialRef: { ref_type: 'DeviceCredential' },
      }),
    },
    readCurrentBinding: async () => binding as never,
    credentialFence: {
      verify: async () => ({ active: fenced, ...(fenced ? { credentialGeneration: binding.lease.leaseVersion } : {}) }),
    } as never,
    requestValidator: { validateRequest: () => true },
    terminalValidator: { validateTerminalResult: () => true },
    readiness: () => ready,
    now: () => NOW,
  });
  return {
    owner,
    setBinding: (value: ReturnType<typeof current>) => { binding = value; },
    setFenced: (value: boolean) => { fenced = value; },
    setReady: (value: boolean) => { ready = value; },
    releases: () => releases,
  };
}

async function issue(
  f: ReturnType<typeof fixture>,
  credentialExpiresAt = '2030-01-01T00:15:00.000Z',
) {
  return f.owner.e2ee.issue({
    operation: 'bootstrap', request: bootstrapRequest(), realtimeSessionRef: SESSION,
    continuityId: CONTINUITY, governance: GOVERNANCE, credentialExpiresAt,
  });
}

function sharedKey(envelope: Awaited<ReturnType<typeof issue>>): Uint8Array {
  return ((envelope.roomOptions as any).encryption.keyProviderOptions.sharedKey) as Uint8Array;
}

test('restart derives the exact same envelope and content key for one authoritative generation', async () => {
  const first = fixture();
  const second = fixture();
  const a = await issue(first);
  const b = await issue(second);
  assert.deepEqual(a.envelope, b.envelope);
  assert.deepEqual(sharedKey(a), sharedKey(b));
  assert.equal(first.releases(), 1);
  a.release?.();
  b.release?.();
  assert.deepEqual([...sharedKey(a)], new Array(32).fill(0));
  await first.owner.close();
  await second.owner.close();
});

test('lease generation rotation changes both envelope reference and derived key', async () => {
  const f = fixture('1');
  const first = await issue(f);
  f.setBinding(current('2'));
  const second = await issue(f);
  assert.notDeepEqual(first.envelope, second.envelope);
  assert.notDeepEqual(sharedKey(first), sharedKey(second));
  first.release?.();
  second.release?.();
  await f.owner.close();
});

test('active credential fence, missing readiness, and close fail before key issuance', async () => {
  const f = fixture();
  f.setFenced(true);
  await assert.rejects(issue(f), /PERSISTENT_E2EE_CREDENTIAL_REVOKED/u);
  f.setFenced(false);
  f.setReady(false);
  await assert.rejects(issue(f), /PERSISTENT_E2EE_NOT_READY/u);
  f.setReady(true);
  await Promise.all([f.owner.close(), f.owner.close()]);
  assert.deepEqual(f.owner.readiness(), { ready: false, closed: true });
  await assert.rejects(issue(f), /PERSISTENT_E2EE_CLOSED/u);
});

test('envelope expiry never exceeds the authoritative cloud credential ceiling', async () => {
  const f = fixture();
  const result = await issue(f, '2030-01-01T00:05:00.000Z');
  assert.equal(result.envelope.expires_at, '2030-01-01T00:05:00.000Z');
  result.release?.();
  await f.owner.close();
});

test('malformed or expired authoritative credential ceilings fail closed', async () => {
  for (const credentialExpiresAt of ['not-a-timestamp', '2029-12-31T23:59:59.000Z']) {
    const f = fixture();
    await assert.rejects(
      issue(f, credentialExpiresAt),
      /PERSISTENT_E2EE_CREDENTIAL_EXPIRY_INVALID/u,
    );
    await f.owner.close();
  }
});

test('constructor rejects any non-owner root reference or missing production recipient', () => {
  const base = {
    pool: { connect: async () => undefined },
    rootKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey,
    secretResolver: { resolve: async () => ({ read: () => ROOT }) },
    recipientCredential: { resolve: async () => undefined },
    readCurrentBinding: async () => current() as never,
    credentialFence: { verify: async () => ({ active: false }) },
    requestValidator: { validateRequest: () => true },
    terminalValidator: { validateTerminalResult: () => true },
    readiness: () => true,
  };
  assert.throws(
    () => createRealtimePublicControlPersistentE2eeOwner({ ...base, rootKeyRef: { name: 'livekit-api-secret' } } as never),
    /PERSISTENT_E2EE_ROOT_REF_INVALID/u,
  );
  assert.throws(
    () => createRealtimePublicControlPersistentE2eeOwner({ ...base, recipientCredential: {} } as never),
    /PERSISTENT_E2EE_OPTIONS_INVALID/u,
  );
});
