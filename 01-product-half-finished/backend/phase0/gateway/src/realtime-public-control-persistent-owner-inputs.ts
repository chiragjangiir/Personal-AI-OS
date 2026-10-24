import {
  createRealtimeCredentialFence,
  type CredentialFencePort,
} from '../../../services/platform-data/src/realtime-credential-fence.ts';
import {
  createRealtimeExternalEffectCoordinator,
  type RealtimeExternalEffectCoordinatorPort,
} from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';
import {
  createRealtimePublicControlT04OwnerWriter,
} from '../../../services/platform-data/src/realtime-public-control-t04-owner-writer.ts';
import type {
  RealtimePublicControlT02OwnerBundle,
} from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import {
  createRealtimePublicControlExternalEffectExecutor,
  type RealtimeExternalEffectBindingResolver,
  type RealtimeExternalEffectOperationContext,
  type RealtimeExternalEffectHandoffContext,
  type RealtimeExternalEffectOwner,
  type RealtimePublicControlExternalEffectExecutor,
} from './realtime-public-control-external-effect-executor.ts';
import {
  createRealtimePublicControlExternalEffectProduction,
  type RealtimeExternalEffectProductionOwner,
  type RealtimeExternalEffectProductionBindingResolver,
} from './realtime-public-control-external-effect-production.ts';
import {
  createRealtimePublicControlLiveKitRoomAdmin,
  type RealtimePublicControlLiveKitRoomAdminBundle,
} from './realtime-public-control-livekit-room-admin.ts';
import {
  createRealtimePublicControlPersistentE2eeOwner,
  type RealtimePublicControlPersistentE2eeOwner,
} from './realtime-public-control-persistent-e2ee-owner.ts';
import type {
  RealtimeAcceptedUserActivityOwnerSource,
} from './realtime-accepted-user-activity-production.ts';
import type { ActivityAcceptancePort } from '../../../services/realtime-core/src/ports.ts';
import {
  createRealtimePublicControlT04Owner,
  type T04DurableOwnerWriter,
  type T04ProductionOwner,
} from './realtime-public-control-t04-owner.ts';
import type {
  RealtimePublicControlPgCompositionOptions,
  V2CompositionReadinessInput,
} from './realtime-public-control-pg-composition.ts';
import type {
  CurrentBindingLookup,
  RealtimeCurrentBindingProjection,
} from '../../../services/realtime-core/src/types.ts';
import type {
  PersistentRealtimePublicControlPorts,
} from './realtime-public-control-persistent-public-ports.ts';
import type {
  RealtimeE2eeRequestValidatorPort,
  RealtimeE2eeTerminalValidatorPort,
  RecipientCredentialPort,
} from './realtime-e2ee-ciphertext-resolver.ts';
import type {
  RealtimeE2eeCiphertextResolverPort,
  RealtimeKeyResolverPort,
} from './realtime-public-control-runtime.ts';
import type {
  ApplePhysicalCanaryBindingPostgresPort,
} from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import {
  createApplePhysicalCanaryBindingPostgres,
} from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import { createProductionRealtimeCanonicalDeviceIdentityIssuer } from '../../../services/platform-data/src/realtime-canonical-device-issuer.ts';

type JsonRecord = Record<string, unknown>;
type Pool = Parameters<typeof createRealtimeCredentialFence>[0];

export interface PersistentRayneoPublicControlOwnerInputs {
  /** Authoritative T02 handles installed by attachT02; no local replacement. */
  readonly readCurrentBinding: RealtimePublicControlT02OwnerBundle['readCurrentBinding'];
  readonly service: RealtimePublicControlT02OwnerBundle['service'];
  readonly equality: RealtimePublicControlT02OwnerBundle['dataPorts']['equality'];
  readonly finalTranscriptReadiness: V2CompositionReadinessInput;
  readonly externalEffectCoordinator: RealtimeExternalEffectCoordinatorPort;
  readonly externalEffectsReadiness: V2CompositionReadinessInput;
  readonly acceptedUserActivity: NonNullable<RealtimePublicControlPgCompositionOptions['acceptedUserActivity']>;
  readonly t04Owner?: T04ProductionOwner;
  readonly e2ee: RealtimeKeyResolverPort;
  readonly e2eeReadiness: V2CompositionReadinessInput;
  readonly e2eeCiphertext: RealtimeE2eeCiphertextResolverPort;
  readonly e2eeCiphertextReadiness: V2CompositionReadinessInput;
  readonly appleBindingReadiness: Readonly<{
    readonly owner: string;
    readonly isReady: () => boolean;
  }>;
  readonly applePhysicalBinding: ApplePhysicalCanaryBindingPostgresPort;
  readonly watchBinding?: NonNullable<RealtimePublicControlPgCompositionOptions['watchBinding']>;
  readonly watchCredentials?: import('../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts').AppleCompanionBindingPostgresPort;
}

export interface PersistentOwnerInputsT04Options {
  readonly source: RealtimeAcceptedUserActivityOwnerSource;
  readonly writer?: T04DurableOwnerWriter;
  readonly readCurrentBinding?: (input: unknown) => Promise<unknown> | unknown;
  readonly preflight?: () => void | Promise<void>;
  readonly now?: () => number;
}

export interface PersistentOwnerInputsE2eeOptions {
  readonly requestValidator: RealtimeE2eeRequestValidatorPort;
  readonly terminalValidator: RealtimeE2eeTerminalValidatorPort;
  readonly recipientCredential?: RecipientCredentialPort;
  readonly rootKeyRef?: PersistentRealtimePublicControlPorts['e2eeRootKeyRef'];
  readonly readiness?: () => boolean;
}

export interface PersistentOwnerInputsPrepareOptions {
  readonly pool: Pool;
  readonly publicPorts: PersistentRealtimePublicControlPorts;
  readonly t03: {
    readonly formalWatchPrimaryAuthority?: NonNullable<Parameters<typeof createApplePhysicalCanaryBindingPostgres>[0]["formalPrimaryAuthority"]>;
    readonly activityAcceptance: { readonly port: ActivityAcceptancePort };
    readonly recipientCredential: { readonly port: RecipientCredentialPort };
    readonly readiness: { readonly isReady: () => boolean };
  };
  readonly finalTranscriptReadiness?: V2CompositionReadinessInput;
  readonly inputReadiness?: V2CompositionReadinessInput;
  readonly t04: PersistentOwnerInputsT04Options;
  readonly e2ee: PersistentOwnerInputsE2eeOptions;
  readonly applePhysicalBinding?: ApplePhysicalCanaryBindingPostgresPort;
  readonly credentialFence?: CredentialFencePort;
  readonly roomAdmin?: Readonly<{
    readonly createRoomService?: Parameters<typeof createRealtimePublicControlLiveKitRoomAdmin>[0]['createRoomService'];
    readonly readiness?: () => boolean;
  }>;
  readonly currentBindingLookup?: CurrentBindingLookup;
  readonly now?: () => number;
}

export interface PersistentOwnerInputsT02Attachment {
  readonly t02: RealtimePublicControlT02OwnerBundle;
  readonly currentBindingLookup?: CurrentBindingLookup;
  readonly currentBinding?: RealtimeCurrentBindingProjection;
}

export interface PersistentOwnerInputsReadiness {
  readonly ready: boolean;
  readonly phase: 'pre_attach' | 'attached' | 'closed' | 'failed';
  readonly reason?: string;
}

export interface PersistentOwnerInputsPrepared {
  readonly externalEffectCoordinator: RealtimeExternalEffectCoordinatorPort;
  readonly bindingResolver: RealtimeExternalEffectBindingResolver;
  readonly readiness: () => PersistentOwnerInputsReadiness;
  readonly assertReady: () => void;
  readonly attachT02: (input: PersistentOwnerInputsT02Attachment) => Promise<PersistentRayneoPublicControlOwnerInputs>;
  readonly close: () => Promise<void>;
}

class PersistentOwnerInputsError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'PersistentOwnerInputsError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new PersistentOwnerInputsError(code);
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function callable(value: unknown, name: string, code: string): void {
  if (value === null || typeof value !== 'object' || typeof (value as JsonRecord)[name] !== 'function') fail(code);
}

function readiness(value: unknown, code: string): V2CompositionReadinessInput {
  const candidate = record(value, code);
  if (typeof candidate.owner !== 'string' || candidate.owner.trim().length === 0 ||
      typeof candidate.isReady !== 'function') fail(code);
  return value as V2CompositionReadinessInput;
}

function bindingIsUsable(value: RealtimeCurrentBindingProjection | undefined): RealtimeCurrentBindingProjection {
  if (value === undefined || value.session.state !== 'active' || value.session.continuityState !== 'active' ||
      value.session.binding.state !== 'connected' || value.lease.state !== 'active' ||
      value.session.realtimeSessionRef === undefined || value.lease.deviceLeaseRef === undefined) {
    fail('PERSISTENT_OWNER_INPUTS_CURRENT_BINDING_INVALID');
  }
  return value;
}

function bindingMatchesT02(
  value: RealtimeCurrentBindingProjection,
  equality: { readonly same: (left: never, right: never) => boolean },
): void {
  const binding = value.session.binding;
  const same = (left: unknown, right: unknown): boolean => {
    try { return equality.same(left as never, right as never) === true; } catch { return false; }
  };
  if (!same(value.session.realtimeSessionRef, value.lease.realtimeSessionRef) ||
      !same(value.session.realtimeSessionRef, binding.realtimeSessionRef) ||
      !same(value.lease.deviceLeaseRef, binding.deviceLeaseRef) ||
      value.session.continuityId !== value.lease.continuityId ||
      value.session.continuityId !== binding.continuityId ||
      value.session.activeDeviceId !== value.lease.deviceId ||
      value.session.activeDeviceId !== binding.deviceId ||
      value.session.connectionEpoch !== binding.connectionEpoch ||
      !same(value.session.activeDeviceLeaseRef, value.lease.deviceLeaseRef)) {
    fail('PERSISTENT_OWNER_INPUTS_CURRENT_BINDING_INVALID');
  }
}

function safeReady(probe: (() => boolean) | undefined): boolean {
  if (probe === undefined) return true;
  try { return probe() === true; } catch { return false; }
}

function t02Bundle(value: unknown): RealtimePublicControlT02OwnerBundle {
  const bundle = record(value, 'PERSISTENT_OWNER_INPUTS_T02_REQUIRED') as unknown as RealtimePublicControlT02OwnerBundle;
  callable(bundle, 'readCurrentBinding', 'PERSISTENT_OWNER_INPUTS_T02_INVALID');
  callable(bundle, 'close', 'PERSISTENT_OWNER_INPUTS_T02_INVALID');
  callable(bundle, 'assertReady', 'PERSISTENT_OWNER_INPUTS_T02_INVALID');
  callable(bundle.service, 'recordAcceptedUserActivity', 'PERSISTENT_OWNER_INPUTS_T02_SERVICE_INVALID');
  callable(bundle.dataPorts?.equality, 'same', 'PERSISTENT_OWNER_INPUTS_T02_EQUALITY_INVALID');
  return bundle;
}

function t04Source(value: unknown): RealtimeAcceptedUserActivityOwnerSource {
  const source = record(value, 'PERSISTENT_OWNER_INPUTS_T04_SOURCE_REQUIRED') as unknown as RealtimeAcceptedUserActivityOwnerSource;
  if (source.environment !== 'production' || typeof source.owner !== 'string' || source.owner.trim().length === 0 ||
      typeof source.isReady !== 'function' || typeof source.subscribe !== 'function') {
    fail('PERSISTENT_OWNER_INPUTS_T04_SOURCE_INVALID');
  }
  return source;
}

function publicPortsReady(ports: PersistentRealtimePublicControlPorts): boolean {
  try { return ports.readiness().ready === true; } catch { return false; }
}

function lazyBinding(): {
  readonly port: RealtimeExternalEffectBindingResolver;
  set(value: RealtimeExternalEffectProductionBindingResolver): void;
  clear(): void;
} {
  let target: RealtimeExternalEffectProductionBindingResolver | undefined;
  const unavailable = async (): Promise<never> => fail('PERSISTENT_OWNER_INPUTS_T02_NOT_ATTACHED');
  const port: RealtimeExternalEffectBindingResolver = Object.freeze({
    environment: 'production' as const,
    isReady: () => target !== undefined && safeReady(target.isReady),
    resolveMediaStop: (input: Parameters<RealtimeExternalEffectBindingResolver['resolveMediaStop']>[0]) => target === undefined
      ? unavailable()
      : target.resolveMediaStop(input),
    resolveHandoff: (input: Parameters<RealtimeExternalEffectBindingResolver['resolveHandoff']>[0]) => target === undefined
      ? unavailable()
      : target.resolveHandoff(input),
    close: async () => { await target?.close?.(); },
  });
  return {
    port,
    set: (value) => { if (target !== undefined) fail('PERSISTENT_OWNER_INPUTS_T02_ALREADY_ATTACHED'); target = value; },
    clear: () => { target = undefined; },
  };
}

function lazyOwner(): {
  readonly port: RealtimeExternalEffectOwner;
  set(value: RealtimeExternalEffectProductionOwner): void;
  clear(): void;
} {
  let target: RealtimeExternalEffectProductionOwner | undefined;
  const unavailable = async (): Promise<never> => fail('PERSISTENT_OWNER_INPUTS_T02_NOT_ATTACHED');
  const port: RealtimeExternalEffectOwner = Object.freeze({
    environment: 'production' as const,
    isReady: () => target !== undefined && safeReady(target.isReady),
    unpublishTracks: (input: RealtimeExternalEffectOperationContext) => target === undefined ? unavailable() : target.unpublishTracks(input),
    disconnectParticipant: (input: RealtimeExternalEffectOperationContext) => target === undefined ? unavailable() : target.disconnectParticipant(input),
    revokeCredential: (input: RealtimeExternalEffectOperationContext) => target === undefined ? unavailable() : target.revokeCredential(input),
    verifyClosed: (input: RealtimeExternalEffectOperationContext) => target === undefined ? unavailable() : target.verifyClosed(input),
    suppressAndClose: (input: RealtimeExternalEffectHandoffContext) => target === undefined ? unavailable() : target.suppressAndClose(input),
    close: async () => { await target?.close?.(); },
  });
  return {
    port,
    set: (value) => { if (target !== undefined) fail('PERSISTENT_OWNER_INPUTS_T02_ALREADY_ATTACHED'); target = value; },
    clear: () => { target = undefined; },
  };
}

function fixedReadiness(owner: string, probe: () => boolean): V2CompositionReadinessInput {
  return Object.freeze({ owner, isReady: () => safeReady(probe) });
}

export function prepareRealtimePublicControlPersistentOwnerInputs(
  options: PersistentOwnerInputsPrepareOptions,
): PersistentOwnerInputsPrepared {
  if (options === null || typeof options !== 'object') fail('PERSISTENT_OWNER_INPUTS_PREPARE_OPTIONS_INVALID');
  callable(options.pool, 'connect', 'PERSISTENT_OWNER_INPUTS_POOL_REQUIRED');
  record(options.publicPorts, 'PERSISTENT_OWNER_INPUTS_PUBLIC_PORTS_REQUIRED');
  callable(options.publicPorts, 'readiness', 'PERSISTENT_OWNER_INPUTS_PUBLIC_PORTS_INVALID');
  callable(options.publicPorts.participant, 'snapshot', 'PERSISTENT_OWNER_INPUTS_PARTICIPANT_INVALID');
  callable(options.publicPorts.participant, 'connect', 'PERSISTENT_OWNER_INPUTS_PARTICIPANT_INVALID');
  callable(options.publicPorts.participant, 'close', 'PERSISTENT_OWNER_INPUTS_PARTICIPANT_INVALID');
  record(options.t03, 'PERSISTENT_OWNER_INPUTS_T03_REQUIRED');
  callable(options.t03.activityAcceptance?.port, 'verify', 'PERSISTENT_OWNER_INPUTS_T03_ACTIVITY_INVALID');
  callable(options.t03.recipientCredential?.port, 'resolve', 'PERSISTENT_OWNER_INPUTS_T03_RECIPIENT_REQUIRED');
  callable(options.t03.readiness, 'isReady', 'PERSISTENT_OWNER_INPUTS_T03_READINESS_INVALID');
  const finalTranscriptReadiness = readiness(options.inputReadiness ?? options.finalTranscriptReadiness, 'PERSISTENT_OWNER_INPUTS_INPUT_OWNER_REQUIRED');
  const source = t04Source(options.t04?.source);
  if (options.t04.readCurrentBinding !== undefined && typeof options.t04.readCurrentBinding !== 'function') {
    fail('PERSISTENT_OWNER_INPUTS_T04_BINDING_READER_INVALID');
  }
  record(options.e2ee, 'PERSISTENT_OWNER_INPUTS_E2EE_REQUIRED');
  if ((typeof options.e2ee.requestValidator?.validateRequest !== 'function') &&
      (typeof options.e2ee.requestValidator?.validate !== 'function')) {
    fail('PERSISTENT_OWNER_INPUTS_E2EE_REQUEST_VALIDATOR_REQUIRED');
  }
  if ((typeof options.e2ee.terminalValidator?.validateTerminalResult !== 'function') &&
      (typeof options.e2ee.terminalValidator?.validate !== 'function')) {
    fail('PERSISTENT_OWNER_INPUTS_E2EE_TERMINAL_VALIDATOR_REQUIRED');
  }
  if (options.e2ee.rootKeyRef === undefined && options.publicPorts.e2eeRootKeyRef === undefined) {
    fail('PERSISTENT_OWNER_INPUTS_E2EE_ROOT_REQUIRED');
  }
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') fail('PERSISTENT_OWNER_INPUTS_CLOCK_INVALID');

  const fence = options.credentialFence ?? createRealtimeCredentialFence(options.pool);
  const binding = lazyBinding();
  const owner = lazyOwner();
  const effectExecutor: RealtimePublicControlExternalEffectExecutor = createRealtimePublicControlExternalEffectExecutor({
    owner: owner.port,
    binding: binding.port,
  });
  const externalEffectCoordinator = createRealtimeExternalEffectCoordinator({
    pool: options.pool,
    executor: effectExecutor,
    credentialFence: fence,
  });

  let closed = false;
  let attachAttempted = false;
  let attached = false;
  let failed = false;
  let attachFlight: Promise<PersistentRayneoPublicControlOwnerInputs> | undefined;
  let closeFlight: Promise<void> | undefined;
  let roomAdminBundle: RealtimePublicControlLiveKitRoomAdminBundle | undefined;
  let e2eeOwner: RealtimePublicControlPersistentE2eeOwner | undefined;
  let t04Owner: T04ProductionOwner | undefined;
  let appleBindingReady = false;

  const readinessSnapshot = (): PersistentOwnerInputsReadiness => {
    if (closed) return Object.freeze({ ready: false, phase: 'closed' as const, reason: 'PERSISTENT_OWNER_INPUTS_CLOSED' });
    if (failed) return Object.freeze({ ready: false, phase: 'failed' as const, reason: 'PERSISTENT_OWNER_INPUTS_ATTACH_FAILED' });
    if (!attached) return Object.freeze({ ready: false, phase: 'pre_attach' as const, reason: 'PERSISTENT_OWNER_INPUTS_T02_NOT_ATTACHED' });
    const readyNow = safeReady(finalTranscriptReadiness.isReady) && safeReady(options.t03.readiness.isReady) &&
      publicPortsReady(options.publicPorts) &&
      safeReady(owner.port.isReady) && safeReady(binding.port.isReady);
    return Object.freeze({
      ready: readyNow,
      phase: 'attached' as const,
      ...(readyNow ? {} : { reason: 'PERSISTENT_OWNER_INPUTS_COMPONENT_NOT_READY' }),
    });
  };
  const assertReady = (): void => {
    const state = readinessSnapshot();
    if (!state.ready) fail(state.reason ?? 'PERSISTENT_OWNER_INPUTS_NOT_READY');
  };

  const attachT02 = (input: PersistentOwnerInputsT02Attachment): Promise<PersistentRayneoPublicControlOwnerInputs> => {
    if (closed) return Promise.reject(new PersistentOwnerInputsError('PERSISTENT_OWNER_INPUTS_CLOSED'));
    if (attachAttempted) return Promise.reject(new PersistentOwnerInputsError('PERSISTENT_OWNER_INPUTS_T02_ALREADY_ATTACHED'));
    attachAttempted = true;
    attachFlight = (async () => {
      if (input === null || typeof input !== 'object') fail('PERSISTENT_OWNER_INPUTS_T02_REQUIRED');
      const t02 = t02Bundle(input?.t02);
      // Paired devices create their session at bootstrap, so an empty store is a valid start; a supplied binding
      // (single-device owners) is still verified before any owner is attached.
      const lookup = input.currentBindingLookup ?? options.currentBindingLookup;
      let current = input.currentBinding;
      if (current === undefined && lookup !== undefined) {
        try { current = await t02.readCurrentBinding(lookup); }
        catch { fail('PERSISTENT_OWNER_INPUTS_CURRENT_BINDING_UNAVAILABLE'); }
      }
      if (current !== undefined || lookup !== undefined) bindingMatchesT02(bindingIsUsable(current), t02.dataPorts.equality);
      if (closed) fail('PERSISTENT_OWNER_INPUTS_CLOSED');
      let applePhysicalBinding = options.applePhysicalBinding;
      let watchBinding: PersistentRayneoPublicControlOwnerInputs['watchBinding'];
      let watchCredentials: PersistentRayneoPublicControlOwnerInputs['watchCredentials'];
      if (applePhysicalBinding === undefined) {
        const binding = createApplePhysicalCanaryBindingPostgres({
          pool: options.pool,
          identity: t02.dataPorts.identity,
          canonicalDeviceIssuer: createProductionRealtimeCanonicalDeviceIdentityIssuer(),
          ...(options.t03.formalWatchPrimaryAuthority === undefined ? {} : { formalPrimaryAuthority: options.t03.formalWatchPrimaryAuthority }),
        });
        applePhysicalBinding = binding;
        if (options.t03.formalWatchPrimaryAuthority !== undefined) {watchBinding = binding;watchCredentials=binding;}
      }
      if (closed) fail('PERSISTENT_OWNER_INPUTS_CLOSED');

      roomAdminBundle = createRealtimePublicControlLiveKitRoomAdmin({
        serverUrl: options.publicPorts.livekitUrl,
        ...(options.publicPorts.livekitApiUrl ? {apiUrl: options.publicPorts.livekitApiUrl} : {}),
        apiKeyRef: options.publicPorts.livekitApiKeyRef,
        apiSecretRef: options.publicPorts.livekitApiSecretRef,
        secretResolver: options.publicPorts.secretResolver,
        participant: options.publicPorts.participant,
        ...(options.publicPorts.participantForDevice === undefined ? {} : { participantForDevice: options.publicPorts.participantForDevice }),
        readCurrentBinding: t02.readCurrentBinding,
        credentialFence: fence,
        readiness: () => attached && safeReady(options.roomAdmin?.readiness) && publicPortsReady(options.publicPorts),
        ...(options.roomAdmin?.createRoomService === undefined ? {} : {
          createRoomService: options.roomAdmin.createRoomService,
        }),
      });
      const productionEffects = createRealtimePublicControlExternalEffectProduction({
        participant: options.publicPorts.participant,
        ...(options.publicPorts.participantForDevice === undefined ? {} : { participantForDevice: options.publicPorts.participantForDevice }),
        roomAdmin: roomAdminBundle.roomAdmin,
        credentialFence: fence,
        binding: roomAdminBundle.binding,
        readiness: {
          participant: () => attached && publicPortsReady(options.publicPorts),
          roomAdmin: () => attached && roomAdminBundle!.roomAdmin.isReady(),
          credentialFence: () => attached && !closed,
          binding: () => attached && roomAdminBundle!.binding.isReady(),
        },
      });

      const writer: T04DurableOwnerWriter = options.t04.writer ?? createRealtimePublicControlT04OwnerWriter({
        pool: options.pool as Parameters<typeof createRealtimePublicControlT04OwnerWriter>[0]['pool'],
        service: t02.service,
        source,
        equality: t02.dataPorts.equality,
        now,
      });
      const t04BindingReader = options.t04.readCurrentBinding ?? (async (input: {
        readonly authority?: { readonly realtime_session_ref?: unknown };
      }) => {
        const realtimeSessionRef = input.authority?.realtime_session_ref;
        if (realtimeSessionRef === undefined) return undefined;
        return t02.readCurrentBinding({ realtimeSessionRef: realtimeSessionRef as never });
      });
      t04Owner = createRealtimePublicControlT04Owner({
        activityAcceptance: options.t03.activityAcceptance.port,
        source,
        writer,
        readCurrentBinding: t04BindingReader as never,
        ...(options.t04.preflight === undefined ? {} : { preflight: options.t04.preflight }),
        ...(options.t04.now === undefined ? { now } : { now: options.t04.now }),
      });
      await t04Owner.preflight();

      const e2eeReady = (): boolean => !closed && attached && safeReady(options.e2ee.readiness) &&
        safeReady(options.t03.readiness.isReady);
      e2eeOwner = createRealtimePublicControlPersistentE2eeOwner({
        pool: options.pool,
        rootKeyRef: options.e2ee.rootKeyRef ?? options.publicPorts.e2eeRootKeyRef,
        secretResolver: options.publicPorts.secretResolver,
        recipientCredential: options.e2ee.recipientCredential ?? options.t03.recipientCredential.port,
        readCurrentBinding: t02.readCurrentBinding,
        credentialFence: fence,
        requestValidator: options.e2ee.requestValidator,
        terminalValidator: options.e2ee.terminalValidator,
        readiness: e2eeReady,
        now,
      });

      binding.set(roomAdminBundle.binding);
      owner.set(productionEffects);
      attached = true;
      if (!safeReady(finalTranscriptReadiness.isReady) || !safeReady(options.t03.readiness.isReady) ||
          !publicPortsReady(options.publicPorts) || !safeReady(productionEffects.isReady) ||
          !e2eeOwner.readiness().ready || !safeReady(t04Owner.preflight === undefined ? undefined : () => true)) {
        fail('PERSISTENT_OWNER_INPUTS_COMPONENT_NOT_READY');
      }
      const externalEffectsReadiness = fixedReadiness('T02.external-effects', productionEffects.isReady);
      const e2eeReadiness = fixedReadiness('T03.e2ee', () => e2eeOwner!.readiness().ready);
      const appleBindingReadiness = Object.freeze({
        owner: 'T02.apple-primary-binding',
        isReady: () => !closed && appleBindingReady,
      });
      appleBindingReady = true;
      const output: PersistentRayneoPublicControlOwnerInputs = Object.freeze({
        readCurrentBinding: t02.readCurrentBinding,
        service: t02.service,
        equality: t02.dataPorts.equality,
        finalTranscriptReadiness,
        externalEffectCoordinator,
        externalEffectsReadiness,
        acceptedUserActivity: Object.freeze({ source: t04Owner.source, purpose: 'cycling_assistant', now }),
        t04Owner,
        e2ee: e2eeOwner.e2ee,
        e2eeReadiness,
        e2eeCiphertext: e2eeOwner.e2eeCiphertext,
        e2eeCiphertextReadiness: e2eeReadiness,
        appleBindingReadiness,
        applePhysicalBinding,
        ...(watchBinding === undefined ? {} : {watchBinding}),
        ...(watchCredentials === undefined ? {} : {watchCredentials}),
      });
      return output;
    })();
    void attachFlight.catch(() => { failed = true; });
    return attachFlight;
  };

  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    closeFlight = (async () => {
      const failures: unknown[] = [];
      for (const operation of [
        () => e2eeOwner?.close(),
        () => t04Owner?.close(),
        () => externalEffectCoordinator.close(),
        () => roomAdminBundle?.close(),
        () => fence.close(),
      ]) {
        try { await operation(); } catch (error) { failures.push(error); }
      }
      binding.clear();
      owner.clear();
      if (failures.length !== 0) fail('PERSISTENT_OWNER_INPUTS_CLOSE_FAILED');
    })();
    return closeFlight;
  };

  return Object.freeze({
    externalEffectCoordinator,
    bindingResolver: binding.port,
    readiness: readinessSnapshot,
    assertReady,
    attachT02,
    close,
  });
}

export const createPersistentOwnerInputs = prepareRealtimePublicControlPersistentOwnerInputs;
export const preparePersistentOwnerInputs = prepareRealtimePublicControlPersistentOwnerInputs;
export const createRayneoPersistentPublicControlOwnerInputs = prepareRealtimePublicControlPersistentOwnerInputs;
export const createPersistentPublicControlOwnerInputsFactory = prepareRealtimePublicControlPersistentOwnerInputs;
