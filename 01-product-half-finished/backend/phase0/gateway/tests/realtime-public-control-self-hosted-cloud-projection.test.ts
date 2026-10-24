import assert from 'node:assert/strict';
import test from 'node:test';

const PAIOS_SELF_HOSTED_LIVEKIT_URL = 'wss://ai.example.invalid';
import {
  RealtimePublicControlSelfHostedCloudProjectionError,
  createRealtimePublicControlSelfHostedCloudProjection,
} from '../src/realtime-public-control-self-hosted-cloud-projection.ts';
import type { T11bCloudProjectionPort, T11bOwnerContext } from '../src/realtime-public-control-t11b-t02-adapter.ts';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const OCCURRED = '2030-01-01T00:00:00.000Z';
const CONTINUITY_EXPIRES = '2030-01-01T00:30:00.000Z';
const LEASE_EXPIRES = '2030-01-01T00:20:00.000Z';
const CREDENTIAL_EXPIRES = '2030-01-01T00:10:00.000Z';
const USER = 'cycling-owner';
const DEVICE = 'iphone-cycling-owner';
const PURPOSE = 'cycling_assistant';
const SESSION = Object.freeze({ ref_type: 'RealtimeSession', ref_id: 'session-opaque' });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: 'lease-opaque' });
const GOVERNANCE = Object.freeze({ policy_decision_ref: { ref_type: 'PolicyDecision', ref_id: 'policy-opaque' } });
const TRANSPORT_ALIAS = `t02.realtime.transport-alias.v1:${'1'.repeat(64)}:${'2'.repeat(64)}:7:${'3'.repeat(64)}`;
const ROOM_ALIAS = `t02.realtime.transport-alias.v1:${'4'.repeat(64)}:${'5'.repeat(64)}:7:${'6'.repeat(64)}`;
const DEVICE_ALIAS = `t02.realtime.transport-alias.v1:${'7'.repeat(64)}:${'8'.repeat(64)}:7:${'9'.repeat(64)}`;
const IDENTIFIER = /^paios-[rtg]-[a-p]{64}$/u;
const FORBIDDEN = new Set([
  'api_key', 'api_secret', 'key_material', 'participant_token', 'password', 'plaintext', 'private_key',
  'room_options', 'roomOptions', 'token',
]);

type BootstrapInput = Parameters<T11bCloudProjectionPort['bootstrap']>[0];
type RefreshInput = Parameters<T11bCloudProjectionPort['connectedRefresh']>[0];
type JsonRecord = Record<string, unknown>;

function receipt(operation: 'bootstrap' | 'connected_credential_refresh', overrides: JsonRecord = {}): JsonRecord {
  return {
    kind: 'realtime_terminal_receipt',
    operation,
    status: 'success',
    requestId: operation === 'bootstrap' ? 'bootstrap-request-1' : 'refresh-request-1',
    idempotencyKey: operation === 'bootstrap' ? 'bootstrap-idempotency-1' : 'refresh-idempotency-1',
    realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE,
    continuityId: 'continuity-1',
    connectionEpoch: '7',
    leaseVersion: operation === 'bootstrap' ? '9' : '10',
    outcome: 'accepted',
    recordedAt: OCCURRED,
    replayed: false,
    ...overrides,
  };
}

function projectedBinding(overrides: JsonRecord = {}): JsonRecord {
  return {
    realtimeSessionRef: SESSION,
    deviceLeaseRef: LEASE,
    continuityId: 'continuity-1',
    connectionEpoch: '7',
    transportSessionAlias: TRANSPORT_ALIAS,
    roomAlias: ROOM_ALIAS,
    deviceAlias: DEVICE_ALIAS,
    provider: 'livekit-cloud',
    connectionId: 'connection-opaque',
    ...overrides,
  };
}

function owner(capabilities: readonly string[] = ['audio', 'video', 'data'], overrides: Partial<T11bOwnerContext> = {}): T11bOwnerContext {
  return {
    userId: USER,
    deviceId: DEVICE,
    purpose: PURPOSE,
    capabilities,
    occurredAt: OCCURRED as never,
    ...overrides,
  };
}

function bootstrapInput(options: {
  capabilities?: readonly string[];
  binding?: JsonRecord;
  receipt?: JsonRecord;
  request?: JsonRecord;
  owner?: T11bOwnerContext;
  projection?: JsonRecord;
  governance?: unknown;
} = {}): BootstrapInput {
  const capabilities = options.capabilities ?? ['audio', 'video', 'data'];
  const binding = options.binding ?? projectedBinding();
  const request = {
    requestId: 'bootstrap-request-1',
    idempotencyKey: 'bootstrap-idempotency-1',
    mode: 'initial',
    userId: USER,
    deviceId: DEVICE,
    capabilities,
    purpose: PURPOSE,
    occurredAt: OCCURRED,
    governance: GOVERNANCE,
    ...options.request,
  };
  const projection = {
    operation: 'bootstrap',
    binding,
    continuityExpiresAt: CONTINUITY_EXPIRES,
    leaseExpiresAt: LEASE_EXPIRES,
    receipt: options.receipt ?? receipt('bootstrap'),
    ...options.projection,
  };
  return {
    request: request as never,
    projection: projection as never,
    owner: options.owner ?? owner(capabilities),
    governance: (options.governance ?? GOVERNANCE) as never,
  };
}

function refreshInput(options: {
  capabilities?: readonly string[];
  binding?: JsonRecord;
  receipt?: JsonRecord;
  requestBinding?: JsonRecord;
  request?: JsonRecord;
  owner?: T11bOwnerContext;
  projection?: JsonRecord;
  governance?: unknown;
} = {}): RefreshInput {
  const capabilities = options.capabilities ?? ['audio', 'video', 'data'];
  const binding = options.binding ?? projectedBinding();
  const requestBinding = options.requestBinding ?? {
    state: 'connected',
    ...binding,
    deviceId: DEVICE,
  };
  const request = {
    requestId: 'refresh-request-1',
    idempotencyKey: 'refresh-idempotency-1',
    binding: requestBinding,
    occurredAt: OCCURRED,
    governance: GOVERNANCE,
    ...options.request,
  };
  const projection = {
    operation: 'connected_credential_refresh',
    binding,
    continuityExpiresAt: CONTINUITY_EXPIRES,
    leaseExpiresAt: LEASE_EXPIRES,
    receipt: options.receipt ?? receipt('connected_credential_refresh'),
    ...options.projection,
  };
  return {
    request: request as never,
    projection: projection as never,
    owner: options.owner ?? owner(capabilities),
    governance: (options.governance ?? GOVERNANCE) as never,
  };
}

function projection() {
  return createRealtimePublicControlSelfHostedCloudProjection({ livekitUrl:'wss://ai.example.invalid', now: () => NOW });
}

function assertSecretFree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSecretFree(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.equal(FORBIDDEN.has(key), false, `forbidden key ${key}`);
    assertSecretFree(item);
  }
}

test('bootstrap maps one authoritative binding to one self-hosted room with least-privilege grants', async () => {
  const result = await projection().bootstrap(bootstrapInput());
  assert.equal(result.serverUrl, PAIOS_SELF_HOSTED_LIVEKIT_URL);
  assert.equal(result.credentialExpiresAt, CREDENTIAL_EXPIRES);
  assert.equal(result.credentialGeneration, '9');
  assert.match(result.terminalRoomName, IDENTIFIER);
  assert.match(result.terminalIdentity, IDENTIFIER);
  assert.match(result.gateway.identity, IDENTIFIER);
  assert.equal(result.gateway.roomName, result.terminalRoomName);
  assert.deepEqual(result.terminalGrants, {
    room: result.terminalRoomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: ['microphone', 'camera'],
  });
  // Least privilege for the gateway: the live call's assistant voice only (microphone source), never camera.
  assert.deepEqual(result.gateway.grants, {
    room: result.terminalRoomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: ['microphone'],
  });
  const start = { kind: 'explicit_user_start', device_id: DEVICE, modalities: ['audio', 'video', 'data'] };
  assert.deepEqual(result.mediaGrants, {
    audio: { enabled: true, device_id: DEVICE, device_lease_ref: LEASE, start_binding: start, expires_at: CREDENTIAL_EXPIRES },
    video: { enabled: true, device_id: DEVICE, device_lease_ref: LEASE, start_binding: start, expires_at: CREDENTIAL_EXPIRES },
    data: { enabled: true, device_id: DEVICE, device_lease_ref: LEASE, start_binding: start, expires_at: CREDENTIAL_EXPIRES },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.gateway), true);
  assert.equal(Object.isFrozen(result.mediaGrants), true);
  assertSecretFree(result);
});

test('data-only cycling profile cannot publish microphone or camera', async () => {
  const result = await projection().bootstrap(bootstrapInput({ capabilities: ['data'] }));
  assert.deepEqual(result.terminalGrants.canPublishSources, []);
  assert.equal(result.terminalGrants.canPublish, false);
  assert.equal(result.terminalGrants.canPublishData, true);
  assert.equal(result.gateway.grants.canPublish, false);
  assert.equal(result.gateway.grants.canPublishData, true);
  assert.deepEqual(result.mediaGrants.audio, { enabled: false });
  assert.deepEqual(result.mediaGrants.video, { enabled: false });
  assert.deepEqual(result.mediaGrants.data, {
    enabled: true,
    device_id: DEVICE,
    device_lease_ref: LEASE,
    start_binding: { kind: 'explicit_user_start', device_id: DEVICE, modalities: ['data'] },
    expires_at: CREDENTIAL_EXPIRES,
  });
});

test('provider-local identifiers are deterministic and rotate only with their alias or epoch', async () => {
  const port = projection();
  const base = await port.bootstrap(bootstrapInput());
  assert.deepEqual(await port.bootstrap(bootstrapInput()), base);

  const room = await port.bootstrap(bootstrapInput({ binding: projectedBinding({ roomAlias: `${ROOM_ALIAS}:next` }) }));
  assert.notEqual(room.terminalRoomName, base.terminalRoomName);
  assert.equal(room.terminalIdentity, base.terminalIdentity);
  assert.equal(room.gateway.identity, base.gateway.identity);

  const device = await port.bootstrap(bootstrapInput({ binding: projectedBinding({ deviceAlias: `${DEVICE_ALIAS}:next` }) }));
  assert.equal(device.terminalRoomName, base.terminalRoomName);
  assert.notEqual(device.terminalIdentity, base.terminalIdentity);
  assert.equal(device.gateway.identity, base.gateway.identity);

  const gateway = await port.bootstrap(bootstrapInput({ binding: projectedBinding({ transportSessionAlias: `${TRANSPORT_ALIAS}:next` }) }));
  assert.equal(gateway.terminalRoomName, base.terminalRoomName);
  assert.equal(gateway.terminalIdentity, base.terminalIdentity);
  assert.notEqual(gateway.gateway.identity, base.gateway.identity);

  const epochBinding = projectedBinding({ connectionEpoch: '8' });
  const epochReceipt = receipt('bootstrap', { connectionEpoch: '8' });
  const epoch = await port.bootstrap(bootstrapInput({ binding: epochBinding, receipt: epochReceipt }));
  assert.notEqual(epoch.terminalRoomName, base.terminalRoomName);
  assert.notEqual(epoch.terminalIdentity, base.terminalIdentity);
  assert.notEqual(epoch.gateway.identity, base.gateway.identity);
});

test('connected refresh preserves the authoritative room and terminal identity with exact generation and ttl', async () => {
  const port = projection();
  const initial = await port.bootstrap(bootstrapInput());
  const refreshed = await port.connectedRefresh(refreshInput());
  assert.equal(refreshed.credentialExpiresAt, CREDENTIAL_EXPIRES);
  assert.equal(refreshed.credentialGeneration, '10');
  assert.equal(refreshed.credentialInput.room, initial.terminalRoomName);
  assert.equal(refreshed.credentialInput.identity, initial.terminalIdentity);
  assert.equal(refreshed.credentialInput.ttlSeconds, 599);
  assert.deepEqual(refreshed.credentialInput.grants, initial.terminalGrants);
  assert.equal(Object.isFrozen(refreshed.credentialInput), true);
  assertSecretFree(refreshed);
});

test('owner, binding, receipt, deadline, and opaque alias drift fail closed', async (context) => {
  const accessorAlias: JsonRecord = {};
  Object.defineProperty(accessorAlias, 'value', { enumerable: true, get: () => ROOM_ALIAS });
  const cycle: JsonRecord = {};
  cycle.self = cycle;
  const symbolAlias = { value: ROOM_ALIAS, [Symbol('drift')]: true };
  const cases: readonly [string, () => BootstrapInput][] = [
    ['provider', () => bootstrapInput({ binding: projectedBinding({ provider: 'other' }) })],
    ['owner device', () => bootstrapInput({ owner: owner(undefined, { deviceId: 'other-device' }) })],
    ['request capabilities', () => bootstrapInput({ request: { capabilities: ['audio'] } })],
    ['receipt status', () => bootstrapInput({ receipt: receipt('bootstrap', { status: 'failed' }) })],
    ['receipt generation', () => bootstrapInput({ receipt: receipt('bootstrap', { leaseVersion: undefined }) })],
    ['receipt lease', () => bootstrapInput({ receipt: receipt('bootstrap', { deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: 'other' } }) })],
    ['expired deadline', () => bootstrapInput({ projection: { leaseExpiresAt: '2030-01-01T00:00:01.000Z' } })],
    ['noncanonical deadline', () => bootstrapInput({ projection: { leaseExpiresAt: '2030-01-01T00:20:00Z' } })],
    ['accessor alias', () => bootstrapInput({ binding: projectedBinding({ roomAlias: accessorAlias }) })],
    ['symbol alias', () => bootstrapInput({ binding: projectedBinding({ roomAlias: symbolAlias }) })],
    ['cyclic alias', () => bootstrapInput({ binding: projectedBinding({ roomAlias: cycle }) })],
  ];
  for (const [name, makeInput] of cases) {
    await context.test(name, async () => {
      await assert.rejects(projection().bootstrap(makeInput()), RealtimePublicControlSelfHostedCloudProjectionError);
    });
  }

  await context.test('refresh binding drift', async () => {
    await assert.rejects(
      projection().connectedRefresh(refreshInput({ requestBinding: { state: 'connected', ...projectedBinding(), deviceId: 'other-device' } })),
      /SELF_HOSTED_CLOUD_REFRESH_BINDING_INVALID/u,
    );
  });
});

test('close is idempotent and fences bootstrap and refresh without effects', async () => {
  const port = projection();
  await port.close?.();
  await port.close?.();
  await assert.rejects(port.bootstrap(bootstrapInput()), /SELF_HOSTED_CLOUD_CLOSED/u);
  await assert.rejects(port.connectedRefresh(refreshInput()), /SELF_HOSTED_CLOUD_CLOSED/u);
});

test('options are closed and invalid clocks fail before any output', async () => {
  assert.throws(
    () => createRealtimePublicControlSelfHostedCloudProjection({ livekitUrl:'wss://ai.example.invalid', extra: true } as never),
    /SELF_HOSTED_CLOUD_OPTIONS_INVALID/u,
  );
  await assert.rejects(
    createRealtimePublicControlSelfHostedCloudProjection({ livekitUrl:'wss://ai.example.invalid', now: () => Number.NaN }).bootstrap(bootstrapInput()),
    /SELF_HOSTED_CLOUD_CLOCK_INVALID/u,
  );
});
