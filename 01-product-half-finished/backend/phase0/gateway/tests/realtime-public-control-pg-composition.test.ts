import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  RealtimeExternalEffectCoordinatorPort,
  RealtimeExternalEffectExecutor,
  RealtimeMediaStopIntent,
} from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';
import type { RealtimePublicControlT02OwnerBundle } from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import {
  createProductionAuthorityFactory,
  type ProductionAuthorityFactoryResult,
} from '../../../services/realtime-core/src/production-authority-factory.ts';
import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
  type RealtimeTransportBinding,
  type StopRequest,
} from '../../../services/realtime-core/src/types.ts';
import {
  createProductionStructuralEquality,
} from '../../../services/realtime-core/src/production-owner-ports.ts';
import type { ProductionPortRegistration } from '../../../services/realtime-core/src/production-owner-ports.ts';
import type { ActivityAcceptancePort, LeasePolicyPort, RealtimeClockPort, RealtimeIdentityPort, TransportDisconnectionPort } from '../../../services/realtime-core/src/ports.ts';
import type { GatewayRuntimeConfig, V2GatewayLoopbackHandle, V2GatewayLoopbackStartOptions } from '../src/main.ts';
import type {
  T11bCanonicalIssuerReadinessPort,
  T11bHandoffOutputFencePort,
  T11bMediaStopIntent,
} from '../src/realtime-public-control-t11b-t02-adapter.ts';
import type { T04ProductionOwner } from '../src/realtime-public-control-t04-owner.ts';
import type { RealtimeDeviceCredentialPort } from '../src/realtime-public-control-runtime.ts';
import {
  createT11bT02ExternalEffectCoordinatorPort,
  createRealtimePublicControlPgComposition,
  type RealtimePublicControlPgInternalOwnedOptions,
  type RealtimePublicControlPgPrebuiltBorrowedOptions,
  type RealtimePublicControlPgCompositionOptions,
  type V2CompositionReadinessInput,
  type V2T11bOwnerPorts,
} from '../src/realtime-public-control-pg-composition.ts';

const errorAsync = async (): Promise<never> => { throw new Error('TEST_PORT_NOT_CALLED'); };
const borrowedAdmission = { withAdmission: async <T>(_tuple: unknown, callback: () => Promise<T>) => callback(), verifyReconnect: async () => undefined, ownsClose: false };
const COMPOSITION_SOURCE = new URL('../src/realtime-public-control-pg-composition.ts', import.meta.url);
const HANDOFF_FIXTURE = JSON.parse(readFileSync(
  new URL('../../../tests/contracts/fixtures/realtime-public-control/handoff.valid.json', import.meta.url),
  'utf8',
)) as Readonly<{ readonly request: Record<string, unknown>; readonly terminal_result: Record<string, unknown> }>;

function deviceCredential(close: () => void | Promise<void> = async () => undefined): RealtimeDeviceCredentialPort {
  return Object.freeze({ resolve: errorAsync as RealtimeDeviceCredentialPort['resolve'], close });
}

function registration<T extends object>(
  port: T,
  close?: () => void | Promise<void>,
): ProductionPortRegistration<T> {
  return Object.freeze({
    port,
    readiness: Object.freeze({ owner: 'test-owner', environment: 'production' as const, isReady: () => true }),
    ...(close === undefined ? {} : { close }),
  });
}

function ready(owner: string, isReady = true): V2CompositionReadinessInput {
  return Object.freeze({ owner, isReady: () => isReady });
}

function ownerPorts(): V2T11bOwnerPorts {
  const policy: LeasePolicyPort = { evaluate: errorAsync as LeasePolicyPort['evaluate'] };
  const activityAcceptance: ActivityAcceptancePort = { verify: errorAsync as ActivityAcceptancePort['verify'] };
  const transportDisconnection: TransportDisconnectionPort = { verify: errorAsync as TransportDisconnectionPort['verify'] };
  const identity: RealtimeIdentityPort = {
    createContinuityId: () => { throw new Error('TEST_PORT_NOT_CALLED'); },
    assertRepositoryIssuedRef: () => { throw new Error('TEST_PORT_NOT_CALLED'); },
    createSessionRef: () => { throw new Error('TEST_PORT_NOT_CALLED'); },
    createDeviceLeaseRef: () => { throw new Error('TEST_PORT_NOT_CALLED'); },
    createTransportAlias: () => { throw new Error('TEST_PORT_NOT_CALLED'); },
    createConnectionId: () => { throw new Error('TEST_PORT_NOT_CALLED'); },
  };
  const clock: RealtimeClockPort = {
    now: () => '2026-08-23T00:00:00.000Z' as ReturnType<RealtimeClockPort['now']>,
  };
  return {
    policy: registration(policy),
    activityAcceptance: registration(activityAcceptance),
    transportDisconnection: registration(transportDisconnection),
    identity: registration(identity),
    clock: registration(clock),
    equality: registration(createProductionStructuralEquality()),
  } as unknown as V2T11bOwnerPorts;
}

function gateway(close: () => void | Promise<void> = async () => undefined): Readonly<RealtimePublicControlPgCompositionOptions['gateway']> {
  return {
    config: {
      gateway: {},
      deviceLanSecurity: {},
      precontactAdmission: 'OPEN_NORMAL',
    } as unknown as GatewayRuntimeConfig,
    adapter: { close } as never,
  };
}

function makeOptions(
  finalTranscriptReady = true,
  startGateway?: (options: V2GatewayLoopbackStartOptions) => Promise<V2GatewayLoopbackHandle>,
  gatewayAdapterClose: () => void | Promise<void> = async () => undefined,
  externalEffectExecutorClose: () => void | Promise<void> = async () => undefined,
): RealtimePublicControlPgInternalOwnedOptions {
  const governance = {
    evaluate: async () => ({ accepted: true }),
    assertAuthorized: async () => Object.freeze({}),
  } as unknown as RealtimePublicControlPgCompositionOptions['governance'];
  const cloud = {
    bootstrap: errorAsync,
    connectedRefresh: errorAsync,
    secretResolver: { resolve: errorAsync },
  } as unknown as RealtimePublicControlPgCompositionOptions['cloud'];
  const externalEffectExecutor: RealtimeExternalEffectExecutor = {
    executeStage: errorAsync,
    close: externalEffectExecutorClose,
  };
  const handoffOutputFence: T11bHandoffOutputFencePort = {
    claim: errorAsync, commit: errorAsync, release: errorAsync, suppressAndClose: errorAsync,
  };
  const e2ee = { issue: errorAsync } as unknown as RealtimePublicControlPgCompositionOptions['e2ee'];
  const e2eeCiphertext = { resolve: errorAsync } as unknown as RealtimePublicControlPgCompositionOptions['e2eeCiphertext'];
  const tokenSigner = {
    assertProjectUrl: () => undefined,
    sign: errorAsync,
    close: () => undefined,
  } as unknown as RealtimePublicControlPgCompositionOptions['tokenSigner'];
  const participant = {
    connect: errorAsync, disconnect: errorAsync, snapshot: () => ({}), close: async () => undefined,
  } as unknown as RealtimePublicControlPgCompositionOptions['participant'];
  const ownerContext = {
    resolve: async () => ({
      userId: 'user', deviceId: 'device', purpose: 'test', capabilities: [], occurredAt: '2026-08-23T00:00:00.000Z',
    }),
  } as unknown as RealtimePublicControlPgCompositionOptions['ownerContext'];
  const issuerReadiness = { assertReady: () => true } as T11bCanonicalIssuerReadinessPort;
  const readiness = {
    postgres: ready('T02'),
    canonicalIssuer: ready('T01'),
    ownerContext: ready('T04'),
    finalTranscript: ready('T04', finalTranscriptReady),
    governance: ready('T03'),
    edge: ready('Public'),
    bearer: ready('Public'),
    cloud: ready('Cloud'),
    externalEffects: ready('T02'),
    terminalCodec: ready('T01'),
    handoffTerminalCodec: ready('T01'),
    e2ee: ready('T03'),
    e2eeCiphertext: ready('T03'),
    secretResolver: ready('Cloud'),
    tokenSigner: ready('Cloud'),
    participant: ready('Cloud'),
  };
  return {
    enabled: true,
    controlHost: '127.0.0.1',
    t02AuthorityMode: 'internal-owned',
    postgres: { host: '127.0.0.1', port: 55432, database: 'test_db', user: 'test_user', password: 'test_password' },
    ownerPorts: ownerPorts(),
    readiness,
    issuerReadiness,
    ownerContext,
    governance,
    edge: { authorize: errorAsync },
    bearer: { authorize: errorAsync },
    cloud,
    externalEffectExecutor,
    handoffOutputFence,
    e2ee,
    e2eeCiphertext,
    tokenSigner,
    participant,
    deviceCredential: deviceCredential(),
    gateway: gateway(gatewayAdapterClose),
    ...(startGateway === undefined ? {} : { startGateway }),
  };
}

function t04OwnerFixture(): {
  readonly owner: T04ProductionOwner;
  readonly counts: () => Readonly<{ preflight: number; hook: number; sourceSubscribe: number; sourceClose: number; ownerClose: number }>;
} {
  let preflight = 0;
  let hook = 0;
  let sourceSubscribe = 0;
  let sourceClose = 0;
  let ownerClose = 0;
  const source = {
    owner: 'T04.durable-test-source',
    environment: 'production' as const,
    isReady: () => true,
    subscribe: () => {
      sourceSubscribe += 1;
      return () => undefined;
    },
    close: () => { sourceClose += 1; },
  };
  const activityAcceptance = registration({ verify: errorAsync as ActivityAcceptancePort['verify'] });
  const owner = {
    activityAcceptance,
    source,
    onBootstrapConnected: async () => { hook += 1; },
    preflight: async () => { preflight += 1; },
    close: async () => { ownerClose += 1; },
  } as unknown as T04ProductionOwner;
  return {
    owner,
    counts: () => ({ preflight, hook, sourceSubscribe, sourceClose, ownerClose }),
  };
}

function makePrebuiltOptions(events: string[] = []): {
  readonly options: RealtimePublicControlPgPrebuiltBorrowedOptions;
  readonly poolCalls: () => Readonly<{ connect: number; query: number; end: number }>;
  readonly bundleCloseCalls: () => number;
} {
  let connectCalls = 0;
  let queryCalls = 0;
  let endCalls = 0;
  let bundleCloseCalls = 0;
  const repository = Object.freeze({ transaction: errorAsync }) as never;
  let coordinatorClosed = false;
  const coordinator = Object.freeze({
    claim: errorAsync,
    restore: errorAsync,
    executeStage: errorAsync,
    suppressAndClose: errorAsync,
    commit: errorAsync,
    release: errorAsync,
    reconcileStage: errorAsync,
    close: async () => {
      if (!coordinatorClosed) {
        coordinatorClosed = true;
        events.push('coordinator');
      }
    },
  }) as unknown as RealtimeExternalEffectCoordinatorPort;
  const authority = createProductionAuthorityFactory({
    repository: registration(repository, () => { bundleCloseCalls += 1; events.push('bundle'); }),
    ...ownerPorts(),
  });
  const postgresReadiness = Object.freeze({
    owner: 'T02.borrowed-pg', environment: 'production' as const, isReady: () => true,
  });
  const issuerReadiness = Object.freeze({
    owner: 'T02.issuer', environment: 'production' as const, isReady: () => true,
  });
  const bundle: RealtimePublicControlT02OwnerBundle = Object.freeze({
    authority,
    service: authority.service,
    projection: authority.projection,
    readCurrentBinding: authority.readCurrentBinding,
    dataPorts: Object.freeze({
      repository,
      identity: authority.ports.identity,
      clock: authority.ports.clock,
      equality: authority.ports.equality,
    }),
    issuerReadiness,
    externalEffectCoordinator: coordinator,
    handoffOutputFence: Object.freeze({
      claim: coordinator.claim,
      suppressAndClose: coordinator.suppressAndClose,
      commit: coordinator.commit,
      release: coordinator.release,
      close: coordinator.close,
    }),
    readiness: authority.readiness,
    assertReady: authority.assertReady,
    close: authority.close,
  });
  const pool = Object.freeze({
    connect: async () => { connectCalls += 1; throw new Error('BORROWED_POOL_CONNECT_NOT_EXPECTED'); },
    query: async () => { queryCalls += 1; throw new Error('BORROWED_POOL_QUERY_NOT_EXPECTED'); },
    end: async () => { endCalls += 1; },
  }) as unknown as RealtimePublicControlPgPrebuiltBorrowedOptions['pool'];
  const internal = makeOptions(
    true,
    undefined,
    async () => { events.push('gateway-adapter'); },
    async () => { events.push('coordinator'); },
  );
  const {
    postgres: _postgres,
    ownerPorts: _ownerPorts,
    issuerReadiness: _issuerReadiness,
    t02AuthorityMode: _mode,
    externalEffectExecutor: _externalEffectExecutor,
    handoffOutputFence: _handoffOutputFence,
    ...common
  } = internal;
  void _postgres;
  void _ownerPorts;
  void _issuerReadiness;
  void _mode;
  void _externalEffectExecutor;
  void _handoffOutputFence;
  const options: RealtimePublicControlPgPrebuiltBorrowedOptions = {
    ...common,
    t02AuthorityMode: 'prebuilt-borrowed',
    pool,
    postgresReadiness,
    prebuiltT02Bundle: bundle,
    credentialFenceAdmission: borrowedAdmission,
    readiness: Object.freeze({
      ...common.readiness,
      postgres: postgresReadiness,
      canonicalIssuer: issuerReadiness,
    }),
  };
  return Object.freeze({
    options,
    poolCalls: () => Object.freeze({ connect: connectCalls, query: queryCalls, end: endCalls }),
    bundleCloseCalls: () => bundleCloseCalls,
  });
}

test('fails before listener bind when a required owner readiness probe is false', async () => {
  let starterCalls = 0;
  const composition = createRealtimePublicControlPgComposition(makeOptions(false, async () => {
    starterCalls += 1;
    throw new Error('STARTER_MUST_NOT_RUN');
  }));
  const snapshot = composition.readiness();
  assert.equal(typeof composition.applePhysicalBinding.issue, 'function');
  assert.equal(typeof composition.applePhysicalBinding.read, 'function');
  assert.equal(composition.appleCyclingTelemetry, undefined);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.statuses.find((status) => status.name === 'finalTranscript')?.ready, false);
  await assert.rejects(composition.start(), /V2_GATEWAY_OWNER_READINESS_FAILED/);
  assert.equal(starterCalls, 0);
  await composition.close();
  await composition.close();
});

test('rejects a missing production port before creating the PG-backed composition', () => {
  const invalid = { ...makeOptions(), edge: undefined } as unknown as RealtimePublicControlPgCompositionOptions;
  assert.throws(() => createRealtimePublicControlPgComposition(invalid), /V2_EDGE_REQUIRED/);
});

test('requires a device credential port before creating PG or a listener', () => {
  const missing = { ...makeOptions() } as Record<string, unknown>;
  delete missing.deviceCredential;
  assert.throws(
    () => createRealtimePublicControlPgComposition(missing as unknown as RealtimePublicControlPgCompositionOptions),
    /V2_DEVICE_CREDENTIAL_REQUIRED/u,
  );
  const malformed = {
    ...makeOptions(),
    deviceCredential: { resolve: 'not-a-function' },
  } as unknown as RealtimePublicControlPgCompositionOptions;
  assert.throws(
    () => createRealtimePublicControlPgComposition(malformed),
    /V2_DEVICE_CREDENTIAL_REQUIRED/u,
  );
});

test('requires one explicit T02 authority mode before constructing any resource', () => {
  const events: string[] = [];
  const base = makeOptions(
    true,
    undefined,
    async () => { events.push('gateway-close'); },
    async () => { events.push('executor-close'); },
  );
  const missing = { ...base } as Record<string, unknown>;
  delete missing.t02AuthorityMode;
  assert.throws(
    () => createRealtimePublicControlPgComposition(missing as unknown as RealtimePublicControlPgCompositionOptions),
    /V2_T02_AUTHORITY_MODE_REQUIRED/u,
  );
  assert.throws(
    () => createRealtimePublicControlPgComposition({
      ...base, t02AuthorityMode: 'unknown',
    } as unknown as RealtimePublicControlPgCompositionOptions),
    /V2_T02_AUTHORITY_MODE_REQUIRED/u,
  );
  assert.deepEqual(events, []);
});

test('uses one prebuilt T02 authority with a borrowed pool and leaves bundle close to its owner', async () => {
  const events: string[] = [];
  const fixture = makePrebuiltOptions(events);
  assert.equal(Object.hasOwn(fixture.options.prebuiltT02Bundle, 'kind'), false);
  assert.equal(Object.hasOwn(fixture.options.prebuiltT02Bundle, 'borrowedPool'), false);
  const composition = createRealtimePublicControlPgComposition(fixture.options);
  assert.equal(composition.readiness().ready, true);
  await Promise.all([composition.close(), composition.close()]);
  assert.deepEqual(fixture.poolCalls(), { connect: 0, query: 0, end: 0 });
  assert.equal(fixture.bundleCloseCalls(), 0);
  await fixture.options.prebuiltT02Bundle.close();
  assert.equal(fixture.bundleCloseCalls(), 1);
});

test('borrowed production composition rejects a missing stop-fence admission before using owner resources', () => {
  const fixture = makePrebuiltOptions();
  const { credentialFenceAdmission: _admission, ...missing } = fixture.options;
  assert.throws(() => createRealtimePublicControlPgComposition(missing), /V2_CREDENTIAL_FENCE_ADMISSION_REQUIRED/);
  assert.deepEqual(fixture.poolCalls(), { connect: 0, query: 0, end: 0 });
  assert.equal(fixture.bundleCloseCalls(), 0);
});

test('rejects mixed prebuilt/internal authority fields before touching the borrowed pool or bundle', () => {
  const fixture = makePrebuiltOptions();
  const invalid = {
    ...fixture.options,
    postgres: {
      host: '127.0.0.1', port: 55432, database: 'mixed', user: 'mixed', password: 'mixed',
    },
  } as unknown as RealtimePublicControlPgCompositionOptions;
  assert.throws(
    () => createRealtimePublicControlPgComposition(invalid),
    /V2_T02_AUTHORITY_MODE_MIXED/u,
  );
  assert.deepEqual(fixture.poolCalls(), { connect: 0, query: 0, end: 0 });
  assert.equal(fixture.bundleCloseCalls(), 0);
});

test('optionally composes the zero-retention Apple cycling delivery seam over the same binding port', async () => {
  const options = makeOptions();
  const composition = createRealtimePublicControlPgComposition({
    ...options,
    appleCycling: {
      input: {
        take: errorAsync,
        release: async () => undefined,
      },
      consumer: { deliver: errorAsync },
    },
  });
  assert.equal(typeof composition.applePhysicalBinding.issue, 'function');
  assert.equal(typeof composition.appleCyclingTelemetry?.deliver, 'function');
  await composition.close();
});

test('binds one accepted-user source to the authoritative service and closes it before runtime owners', async () => {
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let sourceCloseCalls = 0;
  const events: string[] = [];
  const options = makeOptions();
  const composition = createRealtimePublicControlPgComposition({
    ...options,
    acceptedUserActivity: {
      source: {
        owner: 'T04.accepted-user-activity',
        environment: 'production',
        isReady: () => true,
        subscribe: () => {
          subscribeCalls += 1;
          return () => { unsubscribeCalls += 1; events.push('activity-unsubscribe'); };
        },
        close: () => { sourceCloseCalls += 1; events.push('activity-source'); },
      },
      purpose: 'cycling_assistant',
      now: () => Date.parse('2026-08-30T12:00:00.000Z'),
    },
  });
  const activityStatus = composition.readiness().statuses.find((status) => status.name === 'acceptedUserActivity');
  assert.deepEqual(activityStatus, {
    name: 'acceptedUserActivity', owner: 'T04.accepted-user-activity', ready: true,
  });
  assert.equal(typeof composition.bindAcceptedUserActivitySource, 'function');
  composition.bindAcceptedUserActivitySource?.();
  composition.bindAcceptedUserActivitySource?.();
  assert.equal(subscribeCalls, 1);
  await Promise.all([composition.close(), composition.close()]);
  assert.equal(unsubscribeCalls, 1);
  assert.equal(sourceCloseCalls, 1);
  assert.deepEqual(events.slice(0, 2), ['activity-unsubscribe', 'activity-source']);
});

test('accepted-user source readiness failure prevents listener start and subscription', async () => {
  let starterCalls = 0;
  let subscribeCalls = 0;
  const options = makeOptions(true, async () => {
    starterCalls += 1;
    throw new Error('STARTER_MUST_NOT_RUN');
  });
  const composition = createRealtimePublicControlPgComposition({
    ...options,
    acceptedUserActivity: {
      source: {
        owner: 'T04.accepted-user-activity',
        environment: 'production',
        isReady: () => false,
        subscribe: () => { subscribeCalls += 1; return () => undefined; },
      },
      purpose: 'cycling_assistant',
    },
  });
  assert.equal(composition.readiness().ready, false);
  assert.throws(
    () => composition.bindAcceptedUserActivitySource?.(),
    /V2_GATEWAY_OWNER_READINESS_FAILED/u,
  );
  await assert.rejects(composition.start(), /V2_GATEWAY_OWNER_READINESS_FAILED/u);
  assert.equal(subscribeCalls, 0);
  assert.equal(starterCalls, 0);
  await composition.close();
});

test('accepted-user source is hard-wired to the same authority service, never a substitute sink', () => {
  const source = readFileSync(COMPOSITION_SOURCE, 'utf8');
  assert.match(source, /recordAcceptedUserActivity:\s*\(activity:[\s\S]{0,120}boundAuthority\.service\.recordAcceptedUserActivity\(activity\)/u);
  assert.doesNotMatch(source, /acceptedUserActivity[\s\S]{0,120}(?:sinkProvider|fallbackSink|new RealtimeSessionService)/u);
});

test('composition without formal Watch authority does not expose its mutation route',async()=>{
  const {options}=makePrebuiltOptions();
  const composition=createRealtimePublicControlPgComposition(options);
  try{
    assert.equal(composition.controller.matches('POST','/v1/realtime/watch-binding'),false);
    assert.equal(await composition.controller.handle({method:'POST',url:'/v1/realtime/watch-binding'} as never,{} as never),false);
  }finally{await composition.close();await options.prebuiltT02Bundle.close();}
});

test('uses one injected Apple binding authority instead of constructing a duplicate', async () => {
  const binding = Object.freeze({
    issue: async () => { throw new Error('NOT_USED'); },
    read: async () => undefined,
    readActiveByPrimary: async () => undefined,
    refreshActiveByPrimary: async () => undefined,
    revoke: async () => undefined,
  });
  const composition = createRealtimePublicControlPgComposition({
    ...makeOptions(),
    applePhysicalBinding: binding,
  });
  assert.equal(composition.applePhysicalBinding, binding);
  await composition.close();
});

test('a T04 owner is the single persistent source and hook, and is preflighted before start', async () => {
  const fixture = t04OwnerFixture();
  let starterCalls = 0;
  const handle = Object.freeze({
    mode: 'v2-only-loopback' as const,
    host: '127.0.0.1' as const,
    port: 8787 as const,
    server: {} as never,
    close: async () => undefined,
  });
  const options = makeOptions(true, async (startOptions) => {
    starterCalls += 1;
    assert.equal(startOptions.publicRtcControl, composition.controller);
    return handle;
  });
  let composition: ReturnType<typeof createRealtimePublicControlPgComposition>;
  composition = createRealtimePublicControlPgComposition({ ...options, t04Owner: fixture.owner });
  const before = composition.readiness();
  assert.equal(before.ready, false);
  assert.equal(before.statuses.find((status) => status.name === 't04Owner')?.reason, 'T04_OWNER_PREFLIGHT_REQUIRED');
  await Promise.all([composition.preflight(), composition.preflight()]);
  assert.equal(starterCalls, 0);
  assert.deepEqual(fixture.counts(), { preflight: 1, hook: 0, sourceSubscribe: 1, sourceClose: 0, ownerClose: 0 });
  await composition.start();
  assert.equal(starterCalls, 1);
  assert.deepEqual(fixture.counts(), { preflight: 1, hook: 0, sourceSubscribe: 1, sourceClose: 0, ownerClose: 0 });
  await Promise.all([composition.close(), composition.close()]);
  assert.deepEqual(fixture.counts(), { preflight: 1, hook: 0, sourceSubscribe: 1, sourceClose: 1, ownerClose: 1 });
});

test('persistent T04 owner conflicts with the older independently injected activity source', () => {
  const fixture = t04OwnerFixture();
  assert.throws(
    () => createRealtimePublicControlPgComposition({
      ...makeOptions(),
      t04Owner: fixture.owner,
      acceptedUserActivity: {
        source: {
          owner: 'T04.other-source',
          environment: 'production',
          isReady: () => true,
          subscribe: () => () => undefined,
        },
        purpose: 'cycling_assistant',
      },
    }),
    /V2_ACCEPTED_USER_ACTIVITY_SOURCES_CONFLICT/u,
  );
});

test('composition source wiring passes T04 source to the existing validator and non-owned runtime hook', () => {
  const source = readFileSync(COMPOSITION_SOURCE, 'utf8');
  assert.match(source, /source:\s*t04Owner\.source/u);
  assert.match(source, /bootstrapConnected:\s*createProductionBootstrapConnectedOwner\(t04Owner,options\.assistantBridge\)/u);
  assert.match(source, /t04Owner\.preflight\(\)/u);
});

test('uses one explicit starter flight and closes the listener before owner resources', async () => {
  let starterCalls = 0;
  let listenerCloseCalls = 0;
  const handle = Object.freeze({
    mode: 'v2-only-loopback' as const,
    host: '127.0.0.1' as const,
    port: 8787 as const,
    server: {} as never,
    close: async () => { listenerCloseCalls += 1; },
  });
  let composition: ReturnType<typeof createRealtimePublicControlPgComposition>;
  composition = createRealtimePublicControlPgComposition(makeOptions(true, async (input) => {
    starterCalls += 1;
    assert.equal(input.publicRtcControl, composition.controller);
    return handle;
  }));
  const first = await composition.start();
  const second = await composition.start();
  assert.equal(first, handle);
  assert.equal(second, handle);
  assert.equal(starterCalls, 1);
  await composition.close();
  await composition.close();
  assert.equal(listenerCloseCalls, 1);
});

function canonical(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    return value;
  }
  if (typeof value !== 'object' || value === null) throw new Error('TEST_VALUE_INVALID');
  assert.equal(ancestors.has(value), false);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => canonical(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  const record = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key], ancestors)]));
  ancestors.delete(value);
  return result;
}

function stable(value: unknown): string {
  const encoded = JSON.stringify(canonical(value));
  if (encoded === undefined) throw new Error('TEST_STABLE_INVALID');
  return encoded;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

const TEST_SESSION_REF = Object.freeze({
  ref_type: 'RealtimeSession',
  ref_id: '11111111-1111-7111-8111-111111111111',
  object_version: '1',
});
const TEST_LEASE_REF = Object.freeze({
  ref_type: 'DeviceLease',
  ref_id: '22222222-2222-7222-8222-222222222222',
  object_version: '1',
});

function validIntent(): T11bMediaStopIntent {
  const governance = Object.freeze({ purpose: 'conversation' });
  const wireRequest = Object.freeze({
    request_id: 'stop-1',
    operation: 'media_stop',
    idempotency_context: Object.freeze({ idempotency_key: 'stop-1' }),
    realtime_session_ref: TEST_SESSION_REF,
    device_lease_ref: TEST_LEASE_REF,
    continuity_id: 'continuity-1',
    device_id: 'device-1',
    connection_epoch: '17',
    expected_lease_version: '2',
    reason: 'user_stop',
    governance,
  });
  const request: StopRequest = Object.freeze({
    requestId: 'stop-1',
    idempotencyKey: 'stop-1',
    operation: 'media_stop',
    realtimeSessionRef: TEST_SESSION_REF,
    continuityId: 'continuity-1',
    deviceLeaseRef: TEST_LEASE_REF,
    deviceId: 'device-1',
    expectedConnectionEpoch: assertDecimalConnectionEpoch('17'),
    expectedLeaseVersion: assertDecimalCounter('2'),
    reason: 'user_stop',
    occurredAt: assertCanonicalTimestamp('2026-08-23T00:00:00.000Z'),
    governance,
  });
  return Object.freeze({ wireRequest, request, governance, fingerprint: stable(wireRequest) });
}

const HANDOFF_BINDING = Object.freeze({
  state: 'connected',
  realtimeSessionRef: HANDOFF_FIXTURE.request.realtime_session_ref,
  deviceLeaseRef: HANDOFF_FIXTURE.request.current_device_lease_ref,
  continuityId: HANDOFF_FIXTURE.request.continuity_id,
  deviceId: HANDOFF_FIXTURE.request.from_device_id,
  connectionEpoch: HANDOFF_FIXTURE.request.connection_epoch,
  provider: Object.freeze({ alias_type: 'provider', issuer: 'test', value: 'provider-1' }),
  transportSessionAlias: Object.freeze({ alias_type: 'transport_session', issuer: 'test', value: 'transport-1' }),
  roomAlias: Object.freeze({ alias_type: 'room', issuer: 'test', value: 'room-1' }),
  deviceAlias: Object.freeze({ alias_type: 'device', issuer: 'test', value: 'device-1' }),
  connectionId: 'connection-17',
}) as unknown as RealtimeTransportBinding;

function handoffWire(key = 'handoff-1'): Record<string, unknown> {
  if (key === 'handoff-1') return normalize(HANDOFF_FIXTURE.request) as Record<string, unknown>;
  const request = normalize(HANDOFF_FIXTURE.request) as Record<string, unknown>;
  const context = request.idempotency_context as Record<string, unknown>;
  return Object.freeze({ ...request, request_id: key, idempotency_context: Object.freeze({ ...context, idempotency_key: key }) });
}

function handoffTerminalResult(_wire: Record<string, unknown>): Record<string, unknown> {
  return normalize(HANDOFF_FIXTURE.terminal_result) as Record<string, unknown>;
}

function handoffSuppressionResult(terminal: Record<string, unknown>): Record<string, unknown> {
  return Object.freeze({
    state: 'old_device_suppressed',
    closure_status: 'verified_closed',
    evidence_refs: (terminal.execution_facts as Record<string, unknown>).evidence_refs,
    old_device_suppression_fence: terminal.old_device_suppression_fence,
  });
}

function handoffPrebuiltFixture(options: Readonly<{ readonly beforeAuthorityFailure?: boolean }> = {}): {
  readonly options: RealtimePublicControlPgPrebuiltBorrowedOptions;
  readonly serviceCalls: () => number;
  readonly fenceClaims: () => number;
  readonly releaseCalls: () => number;
  readonly suppressionCalls: () => number;
  readonly coordinatorCloseCalls: () => number;
  readonly bundleCloseCalls: () => number;
  readonly controller: () => V2GatewayLoopbackStartOptions['publicRtcControl'] | undefined;
  readonly startCalls: () => number;
} {
  const base = makeOptions();
  const {
    postgres: _postgres,
    ownerPorts: _ownerPorts,
    issuerReadiness: _issuerReadiness,
    t02AuthorityMode: _mode,
    externalEffectExecutor: _externalEffectExecutor,
    handoffOutputFence: _internalFence,
    ...common
  } = base;
  void _postgres; void _ownerPorts; void _issuerReadiness; void _mode; void _externalEffectExecutor; void _internalFence;
  // Controlled PG protocol fixture. Actual persistence/restart is exercised by runtime PG tests.
  const operationRows = new Map<string, Record<string, unknown>>();
  const client = {
    release() {},
    async query(sql: string, values: readonly unknown[] = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/u.test(sql)) return { rows: [] };
      const key = `${values[0]}:${values[1]}`;
      const prior = operationRows.get(key);
      if (sql.startsWith('SELECT')) return { rows: prior === undefined ? [] : [prior] };
      if (sql.startsWith('INSERT INTO idempotency_ledger')) {
        if (prior !== undefined) return { rows: [] };
        const row = { scope: values[0], idempotency_key: values[1], request_hash: values[2], status: 'in_flight', response: null, response_hash: null };
        operationRows.set(key, row);
        return { rows: [row] };
      }
      if (sql.startsWith('UPDATE idempotency_ledger') && prior !== undefined) {
        Object.assign(prior, { status: 'committed', response: JSON.parse(String(values[2])), response_hash: values[3] });
        return { rows: [prior] };
      }
      throw new Error('HANDOFF_POOL_SQL_NOT_EXPECTED');
    },
  };
  const pool = Object.freeze({ connect: async () => client, query: client.query, end: async () => undefined }) as unknown as RealtimePublicControlPgPrebuiltBorrowedOptions['pool'];
  const postgresReadiness = Object.freeze({ owner: 'T02', environment: 'production' as const, isReady: () => true });
  const issuerReadiness = Object.freeze({ owner: 'T02.issuer', environment: 'production' as const, isReady: () => true });
  let serviceCallCount = 0;
  let releaseCallCount = 0;
  let suppressionCallCount = 0;
  let coordinatorCloseCount = 0;
  let coordinatorClosed = false;
  let bundleCloseCount = 0;
  let fenceClaimCount = 0;
  let committed: Record<string, unknown> | undefined;
  let capturedController: V2GatewayLoopbackStartOptions['publicRtcControl'] | undefined;
  let startCount = 0;
  let closeCoordinator: () => Promise<void> = async () => undefined;
  const projection = Object.freeze({
    bootstrap: errorAsync,
    connectedRefresh: errorAsync,
    fullyDisconnectedRefresh: errorAsync,
    mediaStop: errorAsync,
    endContinuity: errorAsync,
  });
  const readCurrentBinding = async () => {
    if (options.beforeAuthorityFailure === true) throw new Error('HANDOFF_CURRENT_BINDING_FAILED');
    return Object.freeze({
      session: Object.freeze({ continuityId: HANDOFF_FIXTURE.request.continuity_id, binding: HANDOFF_BINDING, continuityExpiresAt: '2026-08-23T00:30:00.000Z' }),
      lease: Object.freeze({ deviceId: HANDOFF_FIXTURE.request.from_device_id, leaseVersion: HANDOFF_FIXTURE.request.expected_lease_version }),
    });
  };
  const service = Object.freeze({
    readCurrentBinding,
    handoff: async (request: unknown) => {
      serviceCallCount += 1;
      const value = request as Record<string, unknown>;
      return handoffTerminalResult({
        request_id: value.requestId,
        realtime_session_ref: value.realtimeSessionRef,
        current_device_lease_ref: HANDOFF_FIXTURE.request.current_device_lease_ref,
        continuity_id: value.continuityId,
        connection_epoch: value.expectedConnectionEpoch,
        from_device_id: value.fromDeviceId,
        to_device_id: value.toDeviceId,
        governance: value.governance,
        idempotency_context: { idempotency_key: value.idempotencyKey },
      });
    },
  });
  const readiness = Object.freeze({ current: () => Object.freeze({ ready: true, ports: [] }), assertReady: () => undefined });
  const identity = Object.freeze({
    createContinuityId: errorAsync,
    assertRepositoryIssuedRef: () => undefined,
    createSessionRef: errorAsync,
    createDeviceLeaseRef: errorAsync,
    createTransportAlias: errorAsync,
    createConnectionId: errorAsync,
  });
  const equality = createProductionStructuralEquality();
  const authority = Object.freeze({
    service,
    projection,
    controller: projection,
    readCurrentBinding,
    ports: Object.freeze({ identity, equality }),
    ownerPorts: Object.freeze({ identity, equality }),
    readiness,
    assertReady: () => undefined,
    close: async () => { bundleCloseCount += 1; await closeCoordinator(); },
  }) as unknown as ProductionAuthorityFactoryResult;
  const coordinator = Object.freeze({
    claim: async (_input: Parameters<RealtimeExternalEffectCoordinatorPort['claim']>[0]) => {
      fenceClaimCount += 1;
      if (fenceClaimCount > 1 && committed !== undefined) return { disposition: 'replay', result: committed };
      return { disposition: 'claimed', claimId: 'handoff-claim-1' };
    },
    restore: errorAsync,
    executeStage: errorAsync,
    suppressAndClose: async (input: Parameters<RealtimeExternalEffectCoordinatorPort['suppressAndClose']>[0]) => {
      suppressionCallCount += 1;
      return handoffSuppressionResult(input.authorityResult as Record<string, unknown>);
    },
    commit: async (input: Parameters<RealtimeExternalEffectCoordinatorPort['commit']>[0]) => { committed = input.result; },
    release: async () => { releaseCallCount += 1; },
    reconcileStage: errorAsync,
    close: async () => {
      if (!coordinatorClosed) {
        coordinatorClosed = true;
        coordinatorCloseCount += 1;
      }
    },
  }) as unknown as RealtimeExternalEffectCoordinatorPort;
  closeCoordinator = coordinator.close;
  const bundle = Object.freeze({
    authority,
    service,
    projection,
    readCurrentBinding,
    dataPorts: Object.freeze({ repository: Object.freeze({ transaction: errorAsync }), identity, clock: { now: () => '2026-08-23T00:00:00.000Z' }, equality }),
    issuerReadiness,
    externalEffectCoordinator: coordinator,
    handoffOutputFence: Object.freeze({
      claim: coordinator.claim,
      suppressAndClose: coordinator.suppressAndClose,
      commit: coordinator.commit,
      release: coordinator.release,
      close: coordinator.close,
    }),
    readiness,
    assertReady: authority.assertReady,
    close: authority.close,
  }) as unknown as RealtimePublicControlT02OwnerBundle;
  const startGateway = async (input: V2GatewayLoopbackStartOptions) => {
    startCount += 1;
    capturedController = input.publicRtcControl;
    return Object.freeze({
    mode: 'v2-only-loopback' as const, host: '127.0.0.1' as const, port: 8787 as const,
    server: {} as never,
    close: async () => undefined,
    });
  };
  const optionsForComposition: RealtimePublicControlPgPrebuiltBorrowedOptions = {
    ...common,
    governance: {
      evaluate: async () => Object.freeze({ accepted: true, refs: normalize(HANDOFF_FIXTURE.request.governance) }),
      assertAuthorized: async () => normalize(HANDOFF_FIXTURE.request.governance),
    } as unknown as RealtimePublicControlPgCompositionOptions['governance'],
    edge: { authorize: async () => undefined },
    bearer: {
      authorize: async () => Object.freeze({
        principal: Object.freeze({ user_id: 'user' }),
        deviceId: String(HANDOFF_FIXTURE.request.from_device_id),
        capabilityRef: Object.freeze({ ref_id: 'capability-1' }),
      }),
    },
    ownerContext: {
      resolve: async () => Object.freeze({
        userId: '018f0000-0000-7000-8000-000000000001', deviceId: String(HANDOFF_FIXTURE.request.from_device_id), purpose: 'realtime_assistant', capabilities: ['audio'],
        occurredAt: '2026-08-23T00:00:00.000Z',
      }),
    } as unknown as RealtimePublicControlPgCompositionOptions['ownerContext'],
    readiness: Object.freeze({ ...common.readiness, postgres: postgresReadiness, canonicalIssuer: issuerReadiness }),
    t02AuthorityMode: 'prebuilt-borrowed',
    pool,
    postgresReadiness,
    prebuiltT02Bundle: bundle,
    credentialFenceAdmission: borrowedAdmission,
    startGateway,
  };
  return Object.freeze({
    options: optionsForComposition,
    serviceCalls: () => serviceCallCount,
    fenceClaims: () => fenceClaimCount,
    releaseCalls: () => releaseCallCount,
    suppressionCalls: () => suppressionCallCount,
    coordinatorCloseCalls: () => coordinatorCloseCount,
    bundleCloseCalls: () => bundleCloseCount,
    controller: () => capturedController,
    startCalls: () => startCount,
  });
}

function handoffHttpRequest(wire: Record<string, unknown>): object {
  const body = Buffer.from(JSON.stringify(wire), 'utf8');
  return {
    method: 'POST',
    url: '/v1/realtime/handoff',
    rawHeaders: [
      'content-type', 'application/json',
      'content-length', String(body.length),
      'authorization', `Bearer ${'a'.repeat(16)}`,
    ],
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield body; },
  };
}

function handoffHttpResponse(): {
  readonly response: object;
  readonly status: () => number | undefined;
  readonly body: () => string | undefined;
} {
  let statusCode: number | undefined;
  let responseBody: string | undefined;
  let headersSent = false;
  let writableEnded = false;
  const response = {
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    writeHead(status: number) { statusCode = status; headersSent = true; },
    end(value?: string) { responseBody = value; writableEnded = true; },
  };
  return Object.freeze({ response, status: () => statusCode, body: () => responseBody });
}

test('production composition leaves retired public handoff unmounted', async () => {
  const fixture = handoffPrebuiltFixture();
  const composition = createRealtimePublicControlPgComposition({
    ...fixture.options,
    readiness: { ...fixture.options.readiness, handoffTerminalCodec: ready('retired-handoff', false) },
  });
  await composition.start();
  const controller = fixture.controller();
  assert.ok(controller);
  const response = handoffHttpResponse();
  assert.equal(await controller.handle(handoffHttpRequest(handoffWire()) as never, response.response as never), false);
  assert.equal(fixture.fenceClaims(), 0);
  assert.equal(fixture.serviceCalls(), 0);
  assert.equal(fixture.suppressionCalls(), 0);
  assert.equal(fixture.releaseCalls(), 0);
  await composition.close();
  assert.equal(fixture.bundleCloseCalls(), 0);
  await fixture.options.prebuiltT02Bundle.close();
  assert.equal(fixture.bundleCloseCalls(), 1);
});

test('composition rejects caller-supplied authority/codecs and has one production factory/coordinator plus canonical codecs', () => {
  const invalid = { ...makeOptions(), handoffAuthority: { handoff: errorAsync } } as unknown as RealtimePublicControlPgCompositionOptions;
  assert.throws(() => createRealtimePublicControlPgComposition(invalid), /V2_HANDOFF_AUTHORITY_INJECTION_FORBIDDEN/u);
  assert.throws(
    () => createRealtimePublicControlPgComposition({ ...makeOptions(), terminalCodec: { encode: errorAsync } } as unknown as RealtimePublicControlPgCompositionOptions),
    /V2_TERMINAL_CODEC_INJECTION_FORBIDDEN/u,
  );
  assert.throws(
    () => createRealtimePublicControlPgComposition({ ...makeOptions(), handoffTerminalCodec: { encode: errorAsync } } as unknown as RealtimePublicControlPgCompositionOptions),
    /V2_HANDOFF_TERMINAL_CODEC_INJECTION_FORBIDDEN/u,
  );
  const source = readFileSync(COMPOSITION_SOURCE, 'utf8');
  assert.doesNotMatch(source, /handoffAuthority:\s*boundAuthority\.service/u);
  assert.match(source, /t02Plan\.bundle\.externalEffectCoordinator/u);
  assert.doesNotMatch(source, /t02Plan\.bundle\.handoffOutputFence/u);
  assert.match(source, /const terminalCodec = createRealtimePublicControlTerminalCodec\(\)/u);
  assert.doesNotMatch(source, /createRealtimePublicControlHandoffTerminalCodec/u);
  assert.match(source, /createRealtimeCredentialFence\(pool\)/u);
  assert.match(source, /createRuntimeCredentialFenceAdmission\(credentialFence\)/u);
  assert.match(source, /requireCredentialGeneration: true/u);
  assert.equal(source.split('createProductionAuthorityFactory(').length - 1, 1);
  assert.equal(source.split('createRealtimeExternalEffectCoordinator(').length - 1, 1);
});

function coordinatorFixture(restored: unknown = validIntent(), claimResult: unknown = { disposition: 'claimed', claimId: 'claim-1' }): {
  readonly coordinator: RealtimeExternalEffectCoordinatorPort;
  readonly calls: string[];
  readonly closeCalls: () => number;
} {
  const calls: string[] = [];
  let closeCount = 0;
  const coordinator: RealtimeExternalEffectCoordinatorPort = {
    claim: async () => { calls.push('claim'); return claimResult as never; },
    restore: async () => restored as RealtimeMediaStopIntent | undefined,
    executeStage: async ({ stage }) => { calls.push(`stage:${stage}`); },
    commit: async () => { calls.push('commit'); },
    release: async () => { calls.push('release'); },
    suppressAndClose: async () => undefined,
    reconcileStage: async () => undefined,
    close: async () => { closeCount += 1; },
  };
  return { coordinator, calls, closeCalls: () => closeCount };
}

test('narrows a durable T02 claim, restores a fresh cross-instance projection, stages, commits, and releases', async () => {
  const fixture = coordinatorFixture();
  const first = createT11bT02ExternalEffectCoordinatorPort(fixture.coordinator);
  const second = createT11bT02ExternalEffectCoordinatorPort(fixture.coordinator);
  const intent = validIntent();
  const claim = await first.claim({
    idempotencyContext: { idempotency_key: 'stop-1' },
    fingerprint: intent.fingerprint,
    intent,
  });
  assert.deepEqual(claim, { disposition: 'claimed', claimId: 'claim-1' });
  const restoredA = await first.restore({ claimId: 'claim-1' });
  const restoredB = await second.restore({ claimId: 'claim-1' });
  assert.deepEqual(normalize(restoredA), normalize(intent));
  assert.deepEqual(normalize(restoredB), normalize(intent));
  assert.notEqual(restoredA, restoredB);
  if (restoredA === undefined) throw new Error('TEST_RESTORE_MISSING');
  await first.executeStage({ claimId: 'claim-1', stage: 'tracks_unpublished', intent: restoredA });
  await first.commit({ claimId: 'claim-1', fingerprint: intent.fingerprint, result: { status: 'success' } });
  await first.release({ claimId: 'claim-1', fingerprint: intent.fingerprint });
  assert.deepEqual(fixture.calls, ['claim', 'stage:tracks_unpublished', 'commit', 'release']);
  const close = first.close;
  if (close === undefined) throw new Error('TEST_CLOSE_MISSING');
  await close();
  await close();
  assert.equal(fixture.closeCalls(), 1);
});

test('persistent external-effect bridge rejects legacy intents without an owner credential generation', async () => {
  const fixture = coordinatorFixture();
  const port = createT11bT02ExternalEffectCoordinatorPort(fixture.coordinator, { requireCredentialGeneration: true });
  const intent = validIntent();
  await assert.rejects(
    port.claim({ idempotencyContext: { idempotency_key: 'stop-1' }, fingerprint: intent.fingerprint, intent }),
    /V2_EXTERNAL_EFFECT_CREDENTIAL_GENERATION_REQUIRED/u,
  );
});

test('rejects malformed or binding-drifted unknown restore values before any external stage', async () => {
  const intent = validIntent();
  const malformed: readonly unknown[] = [
    { ...intent, request: { ...intent.request, operation: 'end_continuity' } },
    { ...intent, governance: { purpose: 'other' } },
    { ...intent, request: { ...intent.request, realtimeSessionRef: { ref_type: 'Other' } } },
    { ...intent, request: { ...intent.request, expectedConnectionEpoch: '0' } },
    { ...intent, request: { ...intent.request, extra: true } },
    { ...intent, wireRequest: { ...intent.wireRequest, idempotency_context: [] } },
    { ...intent, wireRequest: { ...intent.wireRequest, governance: { purpose: 'other' } } },
  ];
  for (const candidate of malformed) {
    const fixture = coordinatorFixture(candidate);
    const port = createT11bT02ExternalEffectCoordinatorPort(fixture.coordinator);
    await assert.rejects(() => port.restore({ claimId: 'claim-1' }), /V2_EXTERNAL_EFFECT_/);
    assert.deepEqual(fixture.calls, []);
  }
});

test('preserves indeterminate and in-flight dispositions without staging', async () => {
  for (const disposition of ['indeterminate', 'in_flight'] as const) {
    const fixture = coordinatorFixture(validIntent(), { disposition });
    const port = createT11bT02ExternalEffectCoordinatorPort(fixture.coordinator);
    const intent = validIntent();
    const result = await port.claim({
      idempotencyContext: { idempotency_key: 'stop-1' },
      fingerprint: intent.fingerprint,
      intent,
    });
    assert.deepEqual(result, { disposition });
    assert.deepEqual(fixture.calls, ['claim']);
  }
});

test('closes listener, controller-owned T02 resources, and separate gateway adapter exactly once', async () => {
  const events: string[] = [];
  let listenerCloseCalls = 0;
  const handle = Object.freeze({
    mode: 'v2-only-loopback' as const,
    host: '127.0.0.1' as const,
    port: 8787 as const,
    server: {} as never,
    close: async () => { listenerCloseCalls += 1; events.push('listener'); },
  });
  let gatewayCloseCalls = 0;
  let executorCloseCalls = 0;
  let credentialCloseCalls = 0;
  const base = makeOptions(
    true,
    async () => handle,
    async () => {
      gatewayCloseCalls += 1;
      events.push('gateway-adapter');
      if (gatewayCloseCalls > 1) throw new Error('GATEWAY_ADAPTER_DOUBLE_CLOSE');
    },
    async () => {
      executorCloseCalls += 1;
      events.push('t02-executor');
      if (executorCloseCalls > 1) throw new Error('T02_EXECUTOR_DOUBLE_CLOSE');
    },
  );
  const composition = createRealtimePublicControlPgComposition({
    ...base,
    deviceCredential: deviceCredential(async () => { credentialCloseCalls += 1; }),
    acceptedUserActivity: {
      source: {
        owner: 'T04.accepted-user-activity',
        environment: 'production',
        isReady: () => true,
        subscribe: () => () => { events.push('activity-unsubscribe'); },
        close: () => { events.push('activity-source'); },
      },
      purpose: 'cycling_assistant',
    },
  });
  composition.bindAcceptedUserActivitySource?.();
  await composition.start();
  await Promise.all([composition.close(), composition.close()]);
  assert.equal(listenerCloseCalls, 1);
  assert.equal(gatewayCloseCalls, 1);
  assert.equal(executorCloseCalls, 1);
  assert.equal(credentialCloseCalls, 1);
  assert.ok(events.indexOf('activity-source') < events.indexOf('listener'));
  assert.ok(events.indexOf('listener') < events.indexOf('t02-executor'));
  assert.ok(events.indexOf('t02-executor') < events.indexOf('gateway-adapter'));
});

test('readiness failure still closes partial composition resources once', async () => {
  let gatewayCloseCalls = 0;
  let executorCloseCalls = 0;
  const composition = createRealtimePublicControlPgComposition(makeOptions(
    false,
    async () => { throw new Error('STARTER_MUST_NOT_RUN'); },
    async () => { gatewayCloseCalls += 1; },
    async () => { executorCloseCalls += 1; },
  ));
  await assert.rejects(composition.start(), /V2_GATEWAY_OWNER_READINESS_FAILED/);
  await composition.close();
  await composition.close();
  assert.equal(gatewayCloseCalls, 1);
  assert.equal(executorCloseCalls, 1);
});
