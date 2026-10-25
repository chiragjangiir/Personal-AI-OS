import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  RealtimeClockPort,
  RealtimeIdentityPort,
  TransportDisconnectionPort,
} from '../../../services/realtime-core/src/ports.ts';
import type { RealtimeExternalEffectCoordinatorPort } from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';
import type { RealtimePublicControlT02OwnerBundle } from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import { createProductionAuthorityFactory } from '../../../services/realtime-core/src/production-authority-factory.ts';
import {
  createProductionStructuralEquality,
  type ProductionPortRegistration,
} from '../../../services/realtime-core/src/production-owner-ports.ts';
import type {
  RealtimePublicControlPgCompositionOptions,
  RealtimePublicControlPgPrebuiltBorrowedOptions,
  V2CompositionReadinessInput,
  V2T11bOwnerPorts,
} from '../src/realtime-public-control-pg-composition.ts';
import { PERSISTENT_PUBLIC_SECRET_PATHS } from '../src/realtime-public-control-persistent-public-ports.ts';
import {
  PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH,
  PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA,
} from '../src/realtime-public-control-persistent-bearer-authority.ts';
import {
  PERSISTENT_PROVIDER_READINESS_HORIZON_MS,
  createPersistentT03AuthorityRecordReader,
  passiveProviderReadiness,
  runPersistentAudioFinalization,
  startRayneoPersistentProduction,
  type RayneoPersistentPublicControlOwnerHandoff,
} from '../src/rayneo-persistent-production-entrypoint.ts';
import { T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH } from '../src/t03-apple-cycling-lease-authority.ts';


const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const PUBLIC_PATHS = Object.freeze([
  '/v1/realtime/bootstrap', '/v1/realtime/e2ee/key/resolve',
  '/v1/realtime/credentials/refresh', '/v1/realtime/media/stop',
  '/v1/realtime/end-continuity',
]);
const errorAsync = async (): Promise<never> => { throw new Error('OWNER_PORT_NOT_CALLED'); };

function registration<T extends object>(port: T, close?: () => void | Promise<void>): ProductionPortRegistration<T> {
  return Object.freeze({
    port,
    readiness: Object.freeze({ owner: 'owner-fixture', environment: 'production' as const, isReady: () => true }),
    ...(close === undefined ? {} : { close }),
  });
}

function ready(owner: string, current = true): V2CompositionReadinessInput {
  return Object.freeze({ owner, isReady: () => current });
}

function ownerPorts(): V2T11bOwnerPorts {
  const policy: LeasePolicyPort = { evaluate: errorAsync as LeasePolicyPort['evaluate'] };
  const activityAcceptance: ActivityAcceptancePort = { verify: errorAsync as ActivityAcceptancePort['verify'] };
  const transportDisconnection: TransportDisconnectionPort = {
    verify: errorAsync as TransportDisconnectionPort['verify'],
  };
  const identity: RealtimeIdentityPort = {
    createContinuityId: () => { throw new Error('OWNER_PORT_NOT_CALLED'); },
    assertRepositoryIssuedRef: () => { throw new Error('OWNER_PORT_NOT_CALLED'); },
    createSessionRef: () => { throw new Error('OWNER_PORT_NOT_CALLED'); },
    createDeviceLeaseRef: () => { throw new Error('OWNER_PORT_NOT_CALLED'); },
    createTransportAlias: () => { throw new Error('OWNER_PORT_NOT_CALLED'); },
    createConnectionId: () => { throw new Error('OWNER_PORT_NOT_CALLED'); },
  };
  const clock: RealtimeClockPort = {
    now: () => '2030-01-01T00:00:00.000Z' as ReturnType<RealtimeClockPort['now']>,
  };
  return {
    policy: registration(policy), activityAcceptance: registration(activityAcceptance),
    transportDisconnection: registration(transportDisconnection), identity: registration(identity),
    clock: registration(clock), equality: registration(createProductionStructuralEquality()),
  } as unknown as V2T11bOwnerPorts;
}

function authorityRecord(): Buffer {
  return Buffer.from(JSON.stringify({
    schema: PERSISTENT_PUBLIC_BEARER_AUTHORITY_SCHEMA,
    grant_id: 'grant:apple-cycling:fixture',
    issued_at_utc: '2029-12-31T23:00:00.000Z',
    expires_at_utc: '2030-01-01T01:00:00.000Z',
    token_sha256: createHash('sha256').update('owner-issued-bearer', 'utf8').digest('hex'),
    principal_ref: { ref_type: 'User', ref_id: 'owner-issued-principal' },
    device_id: 'iphone-cycling-canonical',
    capability_ref: { ref_type: 'CapabilityGrant', ref_id: 'owner-issued-capability' },
    scopes: ['bootstrap', 'realtime_e2ee_key_resolve', 'connected_credential_refresh',
      'media_stop', 'end_continuity', 'handoff'],
    issuer_ref: { ref_type: 'AuthorityIssuer', ref_id: 't03-owner' },
  }), 'utf8');
}

export function makePublicControl(options: {
  authorityReady?: boolean;
  appleBindingReady?: boolean;
  compositionReady?: boolean;
  activitySource?: 'ready' | 'missing' | 'non-production' | 'not-ready';
} = {}): {
  readonly handoff: RayneoPersistentPublicControlOwnerHandoff;
  readonly gatewayClose: () => number;
  readonly bundleClose: () => number;
  readonly lifecycle: () => readonly string[];
  readonly activityCounts: () => Readonly<{ subscribe: number; unsubscribe: number; close: number }>;
} {
  let gatewayCloseCount = 0;
  let bundleCloseCount = 0;
  const lifecycle: string[] = [];
  let activitySubscribeCount = 0;
  let activityUnsubscribeCount = 0;
  let activityCloseCount = 0;
  const record = authorityRecord();
  const fileReader = Object.freeze({
    inspect: (path: string) => Object.freeze({
      regular: !(path === PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH && options.authorityReady === false),
      reparse: false,
    }),
    read: (path: string): Buffer => {
      if (path === PERSISTENT_PUBLIC_BEARER_AUTHORITY_RECORD_PATH) {
        if (options.authorityReady === false) throw new Error('OWNER_RECORD_ABSENT');
        return Buffer.from(record);
      }
      if (path === PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiKey) return Buffer.from('k'.repeat(16));
      if (path === PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiSecret) return Buffer.from('s'.repeat(32));
      if (path === PERSISTENT_PUBLIC_SECRET_PATHS.proxyAttestation) return Buffer.from('p'.repeat(43));
      throw new Error('SECRET_PATH_NOT_ADMITTED');
    },
  });
  const postgresReadiness = Object.freeze({
    owner: 'T02.borrowed-pg', environment: 'production' as const, isReady: () => true,
  });
  const issuerReadiness = Object.freeze({
    owner: 'T02.issuer', environment: 'production' as const, isReady: () => true,
  });
  const readiness = {
    postgres: postgresReadiness, canonicalIssuer: issuerReadiness, ownerContext: ready('T11B'),
    finalTranscript: ready('T04', options.compositionReady !== false), governance: ready('T03'),
    edge: ready('Public'), bearer: ready('Public'), cloud: ready('Cloud'),
    externalEffects: ready('T02'), terminalCodec: ready('T01'), handoffTerminalCodec: ready('T01'), e2ee: ready('T03'),
    e2eeCiphertext: ready('T03'), secretResolver: ready('OwnerSecrets'), tokenSigner: ready('LiveKit'),
    participant: ready('LiveKit'),
  };
  const t04Owner = options.activitySource === 'missing' ? undefined : {
    activityAcceptance: registration({ verify: errorAsync as ActivityAcceptancePort['verify'] }),
    source: {
      owner: 'T04.accepted-user-activity',
      environment: options.activitySource === 'non-production' ? 'non-production' as const : 'production' as const,
      isReady: () => options.activitySource !== 'not-ready',
      subscribe: () => {
        activitySubscribeCount += 1;
        return () => { activityUnsubscribeCount += 1; };
      },
      close: () => { activityCloseCount += 1; },
    },
    onBootstrapConnected: async () => undefined,
    preflight: async () => undefined,
    close: async () => { lifecycle.push('t04-owner-close'); },
  } as const;
  const repository = Object.freeze({ transaction: errorAsync }) as never;
  let coordinatorClosed = false;
  const coordinator: RealtimeExternalEffectCoordinatorPort = Object.freeze({
    claim: errorAsync,
    restore: async () => undefined,
    executeStage: async () => undefined,
    commit: async () => undefined,
    release: async () => undefined,
    suppressAndClose: async () => Object.freeze({ suppressed: true }),
    reconcileStage: async () => undefined,
    close: async () => {
      if (!coordinatorClosed) {
        coordinatorClosed = true;
        lifecycle.push('coordinator');
      }
    },
  });
  const authority = createProductionAuthorityFactory({
    repository: registration(repository, () => { bundleCloseCount += 1; lifecycle.push('bundle'); }),
    ...ownerPorts(),
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
    connect: async () => { throw new Error('BORROWED_POOL_CONNECT_NOT_EXPECTED'); },
    query: async () => { throw new Error('BORROWED_POOL_QUERY_NOT_EXPECTED'); },
  }) as unknown as RealtimePublicControlPgPrebuiltBorrowedOptions['pool'];
  const composition = {
    readiness,
    ownerContext: { resolve: errorAsync },
    governance: { evaluate: errorAsync, assertAuthorized: errorAsync },
    e2ee: { issue: errorAsync },
    e2eeCiphertext: { resolve: errorAsync }, now: () => NOW,
    deviceCredential: { resolve: errorAsync, close: async () => { lifecycle.push('device-credential-close'); } },
    // Borrowed mode requires the owner credential fence (B5a G9); this fixture admits every tuple.
    credentialFenceAdmission: { withAdmission: async (_tuple: unknown, run: () => Promise<unknown>) => run(), verifyReconnect: async () => undefined, ownsClose: false },
    ...(t04Owner === undefined ? {} : { t04Owner }),
  } as unknown as RayneoPersistentPublicControlOwnerHandoff['composition'];
  const gateway: RealtimePublicControlPgCompositionOptions['gateway'] = {
    config: { precontactAdmission: 'OPEN_NORMAL',
      gateway: {livekitUrl:'wss://ai.example.invalid'},
      deviceLanSecurity: {publicOrigin:'https://ai.example.invalid'} } as never,
    adapter: { close: async () => { gatewayCloseCount += 1; lifecycle.push('composition'); } } as never,
  };
  const handoff = Object.freeze({
    ownerProtection: Object.freeze({ isOwnerProtected: () => true, assertOwnerProtected: () => undefined }),
    secretFileReader: fileReader, composition,
    t02: Object.freeze({
      publicControl: Object.freeze({ pool, postgresReadiness, prebuiltT02Bundle: bundle }),
    }),
    gateway,
    postgresCredential: Object.freeze({
      reference: Object.freeze({ name: 'pg18-owner-ref' }),
      resolvePassword: () => 'owner-held-test-password',
    }),
    appleBindingReadiness: Object.freeze({
      owner: 'T11B.apple-current-binding', isReady: () => options.appleBindingReady !== false,
    }),
    room: Object.freeze({ connect: errorAsync, disconnect: async () => undefined, removeAllListeners: () => undefined }),
  });
  return {
    handoff,
    gatewayClose: () => gatewayCloseCount,
    bundleClose: () => bundleCloseCount,
    lifecycle: () => Object.freeze([...lifecycle]),
    activityCounts: () => Object.freeze({
      subscribe: activitySubscribeCount,
      unsubscribe: activityUnsubscribeCount,
      close: activityCloseCount,
    }),
  };
}

