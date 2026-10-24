import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceLease } from '../../../services/realtime-core/src/device-lease-state-machine.ts';
import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import { createSourceMediaPermission, type SourceMediaCaptureBinding } from '../src/source-media-permission.ts';
import { createRealtimePublicControlSelfHostedCloudProjection } from '../src/realtime-public-control-self-hosted-cloud-projection.ts';

const SESSION = { ref_type: 'RealtimeSession', ref_id: '01900000-0000-7000-8000-000000000001',
  object_version: '1', canonical_payload_sha256: 'a'.repeat(64) } as const;
const LEASE = { ...SESSION, ref_type: 'DeviceLease', ref_id: '01900000-0000-7000-8000-000000000002' } as const;
const at = (minute: number) => new Date(Date.parse('2030-01-01T00:00:00.000Z') + minute * 60_000).toISOString();
const capture: SourceMediaCaptureBinding = { realtimeSessionRef: SESSION, deviceLeaseRef: LEASE,
  continuityId: 'continuity-1', connectionEpoch: '1', userId: 'owner', deviceId: 'iphone-owner', purpose: 'assistant' };

function fixture() {
  let now = at(0);
  let blocked = false;
  let mutateDuringAdmission: (() => void) | undefined;
  const lease = createDeviceLease({ deviceLeaseRef: LEASE, realtimeSessionRef: SESSION,
    continuityId: capture.continuityId, userId: capture.userId, deviceId: capture.deviceId,
    issuedAt: at(0) as never, policy: { allowed: true, capabilities: ['audio', 'video'],
      purpose: capture.purpose, leaseExpiresAt: at(30) as never, revocable: true, policyDecisionRef: 'policy-1' } });
  let current = { lease, session: { realtimeSessionRef: SESSION, userId: capture.userId,
    continuityId: capture.continuityId, state: 'active', continuityState: 'active', connectionEpoch: '1',
    continuityExpiresAt: at(30), lastAcceptedUserActivityAt: at(0), activeDeviceId: capture.deviceId,
    activeDeviceLeaseRef: LEASE, revision: '1', binding: { ...capture, state: 'connected',
      provider: 'livekit-cloud', transportSessionAlias: 'transport-alias', roomAlias: 'room-alias',
      deviceAlias: 'device-alias', connectionId: 'connection-1' } } } as unknown as RealtimeCurrentBindingProjection;
  const permission = createSourceMediaPermission({ readCurrentBinding: async () => current,
    equality: createProductionStructuralEquality(), now: () => now,
    credentialFence: { verify: async () => ({ active: blocked }), withAdmission: async (_tuple, consume) => {
      if (blocked) throw new Error('CREDENTIAL_FENCE_BLOCKED');
      mutateDuringAdmission?.();
      return consume();
    } } });
  return { permission, get current() { return current; }, set current(value) { current = value; },
    setNow: (value: string) => { now = value; }, block: () => { blocked = true; },
    mutate: (fn: () => void) => { mutateDuringAdmission = fn; }, now: () => Date.parse(now) };
}

test('real cloud token producer + current media consumer cross first token expiry without new logical session', async () => {
  const f = fixture();
  const cloud = createRealtimePublicControlSelfHostedCloudProjection({ livekitUrl:'wss://ai.example.invalid', now: f.now });
  const binding = f.current.session.binding;
  const owner = { userId: capture.userId, deviceId: capture.deviceId, purpose: capture.purpose,
    capabilities: ['audio', 'video'], occurredAt: at(0) };
  const receipt = (operation: string, requestId: string) => ({ kind: 'realtime_terminal_receipt',
    operation, status: 'success', requestId, idempotencyKey: requestId, realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE, continuityId: capture.continuityId, connectionEpoch: '1', leaseVersion: '1', recordedAt: at(0) });
  const first = await cloud.bootstrap({ owner, governance: 'policy-1', request: { ...owner,
    governance: 'policy-1', requestId: 'start', idempotencyKey: 'start' }, projection: {
      operation: 'bootstrap', binding, continuityExpiresAt: at(30), leaseExpiresAt: at(30),
      receipt: receipt('bootstrap', 'start') } } as never);
  assert.equal(first.credentialExpiresAt, at(10));
  const archived: { logicalSession: string; end: string }[] = [];
  const consume = async () => f.permission.withPermission(capture, 'audio', async (grant) => {
    archived.push({ logicalSession: 'hermes-session-retained', end: grant.authorizedMediaUntil });
    return grant;
  });
  await consume();
  f.setNow(at(9));
  const refreshed = await cloud.connectedRefresh({ owner: { ...owner, occurredAt: at(9) },
    governance: 'policy-1', request: { binding, occurredAt: at(9), governance: 'policy-1',
      requestId: 'refresh', idempotencyKey: 'refresh' }, projection: {
      operation: 'connected_credential_refresh', binding, continuityExpiresAt: at(30), leaseExpiresAt: at(30),
      receipt: receipt('connected_credential_refresh', 'refresh') } } as never);
  assert.equal(refreshed.credentialExpiresAt, at(19));
  f.setNow(at(11));
  const current = await consume();
  assert.equal(current.authorizedMediaUntil, at(30));
  assert.equal(archived.length, 2);
  assert.equal(new Set(archived.map((row) => row.logicalSession)).size, 1);
  assert.deepEqual(current.modalities, ['audio', 'video']);
  f.block();
  await assert.rejects(consume(), /CREDENTIAL_FENCE_BLOCKED/);
  assert.equal(archived.length, 2);
});

test('current expiry, stale epoch, ungranted modality, lease revoke and authority drift reject before consumer', async () => {
  const f = fixture();
  let calls = 0;
  const consume = async () => { calls += 1; };
  await assert.rejects(f.permission.withPermission({ ...capture, connectionEpoch: '2' }, 'audio', consume), /MEDIA_CURRENT_BINDING_MISMATCH/);
  await assert.rejects(f.permission.withPermission(capture, 'data', consume), /MEDIA_MODALITY_NOT_AUTHORIZED/);
  f.setNow(at(30));
  await assert.rejects(f.permission.withPermission(capture, 'audio', consume), /LEASE_EXPIRED/);
  f.setNow(at(1));
  f.current = { ...f.current, lease: { ...f.current.lease, state: 'revoked' } };
  await assert.rejects(f.permission.withPermission(capture, 'audio', consume), /LEASE_REVOKED/);
  assert.equal(calls, 0);
});

test('recheck under fence lock rejects generation drift; read snapshots are immutable and fresh', async () => {
  const f = fixture();
  const previous = await f.permission.read(capture);
  f.current = { ...f.current, lease: { ...f.current.lease, expiresAt: at(40) as never },
    session: { ...f.current.session, continuityExpiresAt: at(40) as never, revision: '2' as never } };
  assert.equal((await f.permission.read(capture)).authorizedMediaUntil, at(40));
  assert.equal(previous.authorizedMediaUntil, at(30));
  assert.equal(Object.isFrozen(previous.binding), true);
  f.mutate(() => { f.current = { ...f.current, lease: { ...f.current.lease, leaseVersion: '2' as never } }; });
  await assert.rejects(f.permission.withPermission(capture, 'video', async () => 'bad'), /MEDIA_PERMISSION_CHANGED/);
  f.block();
  await assert.rejects(f.permission.read(capture), /MEDIA_CREDENTIAL_REVOKED/);
});
