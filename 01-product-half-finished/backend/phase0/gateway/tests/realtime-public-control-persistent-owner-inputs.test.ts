import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { ActivityAcceptancePort } from '../../../services/realtime-core/src/ports.ts';
import type { T04AcceptedUserActivityOwnerEvent } from '../src/realtime-public-control-t04-owner.ts';
import type { RealtimePublicControlT02OwnerBundle } from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import {
  prepareRealtimePublicControlPersistentOwnerInputs,
  type PersistentOwnerInputsPrepareOptions,
} from '../src/realtime-public-control-persistent-owner-inputs.ts';
const PAIOS_SELF_HOSTED_LIVEKIT_URL = 'wss://ai.example.invalid';

const REF = Object.freeze({ ref_type: 'RealtimeSession', ref_id: 'session-owner-inputs', object_version: '1', canonical_payload_sha256: 'a'.repeat(64) });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: 'lease-owner-inputs', object_version: '1', canonical_payload_sha256: 'b'.repeat(64) });
const CURRENT = Object.freeze({
  session: Object.freeze({
    state: 'active', continuityState: 'active', realtimeSessionRef: REF, continuityId: 'continuity-owner-inputs',
    activeDeviceId: 'iphone-owner-inputs', activeDeviceLeaseRef: LEASE, connectionEpoch: '1',
    binding: Object.freeze({
      state: 'connected', realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: 'continuity-owner-inputs',
      deviceId: 'iphone-owner-inputs', connectionEpoch: '1', roomAlias: 'room-owner-inputs',
      deviceAlias: 'device-owner-inputs', transportSessionAlias: 'transport-owner-inputs',
    }),
  }),
  lease: Object.freeze({
    state: 'active', realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: 'continuity-owner-inputs',
    deviceId: 'iphone-owner-inputs', connectionEpoch: '1', leaseVersion: '1', fencingToken: '1',
    expiresAt: '2030-01-01T01:00:00.000Z', capabilities: Object.freeze({ audio: true, video: true, data: true }),
  }),
});

function fakePublicPorts(): PersistentOwnerInputsPrepareOptions['publicPorts'] {
  const participant = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    snapshot: () => Object.freeze({ connected: false, transportState: 'disconnected' as const }),
    close: async () => undefined,
    unpublishAllTracks: async () => undefined,
    verifyClosed: async () => undefined,
    setReconnectAdmissionGuard: () => undefined,
    bindingSnapshot: () => undefined,
  };
  const secretResolver = { resolve: async () => ({ read: () => 'x'.repeat(43), release: () => undefined }) };
  return {
    edge: {} as never,
    bearer: {} as never,
    secretResolver,
    tokenSigner: { assertProjectUrl: () => undefined, sign: async () => 'signed', close: () => undefined },
    participant,
    livekitUrl: PAIOS_SELF_HOSTED_LIVEKIT_URL,
    livekitApiKeyRef: Object.freeze({ name: 'livekit-api-key' }),
    livekitApiSecretRef: Object.freeze({ name: 'livekit-api-secret' }),
    e2eeRootKeyRef: Object.freeze({ name: 'e2ee-root-key' }),
    readiness: () => Object.freeze({ ready: true, statuses: Object.freeze([]) }),
    close: async () => undefined,
  } as unknown as PersistentOwnerInputsPrepareOptions['publicPorts'];
}

function fakeT02(): RealtimePublicControlT02OwnerBundle {
  const activityAcceptance: ActivityAcceptancePort = { verify: async () => Object.freeze({ verified: true, acceptanceRef: {}, acceptedAt: '2030-01-01T00:00:00.000Z', authorityWatermark: {} }) as never };
  const service = { recordAcceptedUserActivity: async () => Object.freeze({}) };
  const same = (left: unknown, right: unknown): boolean => left === right;
  return {
    authority: {} as never,
    service: service as never,
    projection: {} as never,
    readCurrentBinding: async () => CURRENT as never,
    dataPorts: { repository: {} as never, identity: {} as never, clock: {} as never, equality: { same } } as never,
    issuerReadiness: { owner: 'T02', environment: 'production', isReady: () => true },
    externalEffectCoordinator: {} as never,
    handoffOutputFence: {} as never,
    readiness: {} as never,
    assertReady: () => undefined,
    close: async () => undefined,
  };
}

function fakeOptions(overrides: Partial<PersistentOwnerInputsPrepareOptions> = {}): PersistentOwnerInputsPrepareOptions {
  const source = {
    owner: 'T04.fixture', environment: 'production' as const, isReady: () => true,
    subscribe: () => () => undefined,
  };
  const activityAcceptance: ActivityAcceptancePort = { verify: async () => Object.freeze({ verified: true, acceptanceRef: {}, acceptedAt: '2030-01-01T00:00:00.000Z', authorityWatermark: {} }) as never };
  const base: PersistentOwnerInputsPrepareOptions = {
    pool: { connect: async () => { throw new Error('not called'); } } as never,
    publicPorts: fakePublicPorts(),
    t03: {
      activityAcceptance: { port: activityAcceptance },
      recipientCredential: { port: { resolve: async () => undefined } },
      readiness: { isReady: () => true },
    },
    finalTranscriptReadiness: { owner: 'T04', isReady: () => true },
    t04: {
      source,
      writer: {
        readiness: () => Object.freeze({ owner: 'T04.accepted-user-activity', environment: 'production' as const, ready: true }),
        bind: () => undefined,
        write: async () => Object.freeze({}), readByIdempotency: async () => undefined, close: async () => undefined,
      },
    },
    e2ee: {
      requestValidator: { validateRequest: () => undefined },
      terminalValidator: { validateTerminalResult: () => undefined },
    },
    applePhysicalBinding: {
      issue: async () => { throw new Error('not called'); }, read: async () => undefined,
      readActiveByPrimary: async () => Object.freeze({}) as never, refreshActiveByPrimary: async () => undefined,
      revoke: async () => undefined,
    },
    currentBindingLookup: { realtimeSessionRef: REF },
    now: () => Date.parse('2030-01-01T00:00:00.000Z'),
  };
  return { ...base, ...overrides };
}

test('prepared owner inputs fail closed before T02 attach and close idempotently', async () => {
  const prepared = prepareRealtimePublicControlPersistentOwnerInputs(fakeOptions());
  assert.deepEqual(prepared.readiness(), {
    ready: false, phase: 'pre_attach', reason: 'PERSISTENT_OWNER_INPUTS_T02_NOT_ATTACHED',
  });
  await assert.rejects(
    prepared.bindingResolver.resolveMediaStop({ intent: {} } as never),
    /PERSISTENT_OWNER_INPUTS_T02_NOT_ATTACHED/u,
  );
  await Promise.all([prepared.close(), prepared.close()]);
  assert.equal(prepared.readiness().phase, 'closed');
  await assert.rejects(prepared.attachT02({ t02: fakeT02(), currentBinding: CURRENT as never }), /PERSISTENT_OWNER_INPUTS_CLOSED/u);
});

test('T02 attach installs the authoritative binding and constructs production owners exactly once', async () => {
  const prepared = prepareRealtimePublicControlPersistentOwnerInputs(fakeOptions());
  const inputs = await prepared.attachT02({ t02: fakeT02(), currentBinding: CURRENT as never });
  assert.equal(Object.isFrozen(inputs), true);
  assert.equal(prepared.readiness().phase, 'attached');
  assert.equal(inputs.appleBindingReadiness.isReady(), true);
  assert.equal(inputs.externalEffectsReadiness.isReady(), true);
  assert.equal(inputs.e2eeReadiness.isReady(), true);
  await assert.rejects(
    prepared.attachT02({ t02: fakeT02(), currentBinding: CURRENT as never }),
    /PERSISTENT_OWNER_INPUTS_T02_ALREADY_ATTACHED/u,
  );
  await prepared.close();
});

test('attach verifies a selected binding, allows an empty paired store and does not require a Watch companion', async (context) => {
  await context.test('binding', async () => {
    // Paired devices create their session at bootstrap: no selector means nothing to verify at startup.
    const { currentBindingLookup: _ignored, ...withoutLookup } = fakeOptions();
    const empty = prepareRealtimePublicControlPersistentOwnerInputs(withoutLookup as PersistentOwnerInputsPrepareOptions);
    await empty.attachT02({ t02: fakeT02() } as never);
    await empty.close();
    // A selected binding that the authority cannot produce still fails closed before any owner is attached.
    const prepared = prepareRealtimePublicControlPersistentOwnerInputs(fakeOptions());
    await assert.rejects(
      prepared.attachT02({ t02: { ...fakeT02(), readCurrentBinding: async () => undefined } } as never),
      /PERSISTENT_OWNER_INPUTS_CURRENT_BINDING_INVALID/u,
    );
    await prepared.close();
  });
  await context.test('watch is a later operation', async () => {
    let activeWatchReads = 0;
    let companionIssues = 0;
    const options = fakeOptions({
      applePhysicalBinding: {
        issue: async () => { companionIssues += 1; throw new Error('not called'); }, read: async () => undefined,
        readActiveByPrimary: async () => { activeWatchReads += 1; return undefined; }, refreshActiveByPrimary: async () => undefined,
        revoke: async () => undefined,
      },
    });
    const prepared = prepareRealtimePublicControlPersistentOwnerInputs(options);
    const inputs = await prepared.attachT02({ t02: fakeT02(), currentBinding: CURRENT as never });
    assert.equal(inputs.appleBindingReadiness.isReady(), true);
    assert.equal(activeWatchReads, 0);
    assert.equal(companionIssues, 0);
    await prepared.close();
  });
});

test('default T04 binding reader uses the fresh bootstrap authority ref, not the startup projection', async () => {
  const nextRef = Object.freeze({ ...REF, ref_id: 'session-owner-inputs-next' });
  const nextLease = Object.freeze({ ...LEASE, ref_id: 'lease-owner-inputs-next' });
  const next = Object.freeze({
    session: Object.freeze({
      state: 'active', continuityState: 'active', realtimeSessionRef: nextRef, continuityId: 'continuity-owner-inputs',
      userId: 'user-owner-inputs', activeDeviceId: 'iphone-owner-inputs', activeDeviceLeaseRef: nextLease, connectionEpoch: '2',
      lastAcceptedUserActivityAt: '2029-12-31T23:00:00.000Z', continuityExpiresAt: '2030-01-01T02:00:00.000Z',
      binding: Object.freeze({
        state: 'connected', realtimeSessionRef: nextRef, deviceLeaseRef: nextLease, continuityId: 'continuity-owner-inputs',
        deviceId: 'iphone-owner-inputs', connectionEpoch: '2', roomAlias: 'room-next',
        deviceAlias: 'device-next', transportSessionAlias: 'transport-next',
      }),
    }),
    lease: Object.freeze({
      state: 'active', realtimeSessionRef: nextRef, deviceLeaseRef: nextLease, continuityId: 'continuity-owner-inputs',
      userId: 'user-owner-inputs', deviceId: 'iphone-owner-inputs', expiresAt: '2030-01-01T01:30:00.000Z', capabilities: Object.freeze({ audio: true, video: true, data: true }),
    }),
  });
  const lookups: unknown[] = [];
  const t02 = {
    ...fakeT02(),
    readCurrentBinding: async (lookup: unknown) => { lookups.push(lookup); return next as never; },
  } as unknown as RealtimePublicControlT02OwnerBundle;
  let writes = 0;
  let durable: Record<string, unknown> | undefined;
  const options = fakeOptions({
    t03: {
      ...fakeOptions().t03,
      activityAcceptance: {
        port: {
          verify: async (activity: Parameters<ActivityAcceptancePort['verify']>[0]) => ({
            verified: true as const,
            acceptanceRef: activity.acceptanceRef,
            acceptedAt: activity.occurredAt,
            authorityWatermark: {},
          }),
        },
      },
    },
    t04: {
      ...fakeOptions().t04,
      writer: {
        readiness: () => Object.freeze({ owner: 'T04.accepted-user-activity', environment: 'production' as const, ready: true }),
        bind: () => undefined,
        write: async (event: T04AcceptedUserActivityOwnerEvent) => {
          writes += 1;
          const activity = event.activity;
          durable = {
            eventType: 'realtime.t04.accepted_user_activity.v1',
            activityId: activity.activityId,
            userId: activity.userId,
            deviceId: activity.deviceId,
            realtimeSessionRef: activity.realtimeSessionRef,
            continuityId: activity.continuityId,
            occurredAt: activity.occurredAt,
            acceptanceRef: activity.acceptanceRef,
            actionReceipt: event.actionReceipt,
            currentBinding: event.currentBinding,
            authorityProjection: event.authorityProjection,
          };
          return {} as never;
        },
        readByIdempotency: async () => durable as never,
        close: async () => undefined,
      },
    },
  });
  const prepared = prepareRealtimePublicControlPersistentOwnerInputs(options);
  const inputs = await prepared.attachT02({ t02, currentBinding: CURRENT as never });
  const authority = {
    realtime_session_ref: nextRef,
    device_lease_ref: nextLease,
    continuity_id: 'continuity-owner-inputs',
    connection_epoch: '2',
    continuity_expires_at: '2030-01-01T02:00:00.000Z',
    credential_expires_at: '2030-01-01T01:30:00.000Z',
    governance: {},
  };
  const hookInput = {
    request: {
      request_id: 't04-next-request', idempotency_context: { idempotency_key: 't04-next-idem' },
      start: { started_at: '2030-01-01T00:00:00.000Z' }, user_id: 'user-owner-inputs', device_id: 'iphone-owner-inputs',
    },
    bearer: { deviceId: 'iphone-owner-inputs' },
    governance: {},
    authority,
  };
  await inputs.t04Owner!.onBootstrapConnected(hookInput as never);
  await inputs.t04Owner!.onBootstrapConnected(hookInput as never);
  assert.deepEqual(lookups, [{ realtimeSessionRef: nextRef }, { realtimeSessionRef: nextRef }]);
  assert.equal(writes, 1);
  await prepared.close();
});
