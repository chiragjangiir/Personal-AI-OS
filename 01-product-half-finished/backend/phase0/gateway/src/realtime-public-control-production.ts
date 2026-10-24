import {
  assertCanonicalLiveKitCloudProjectUrl,
  createLiveKitCloudTokenSigner,
  type LiveKitCloudTokenSignerOptions,
  type LiveKitCloudTokenSignerPort,
  type SecretReference,
  type SecretResolverPort,
} from './livekit-cloud-token-signer.ts';
import {
  createLiveKitCloudParticipant,
  type LiveKitCloudParticipantPort,
} from './livekit-cloud-participant.ts';
import {
  createRealtimeE2eeCiphertextResolver,
  type RealtimeE2eeCiphertextResolverOptions,
} from './realtime-e2ee-ciphertext-resolver.ts';
import {
  createRealtimePublicControlController,
  createRealtimeSchemaRegistry,
  type RealtimePublicControlBearerPort,
  type RealtimePublicControlController,
  type RealtimePublicControlControllerOptions,
  type RealtimePublicControlEdgePort,
  type RealtimeSchemaRegistry,
} from './realtime-public-control-controller.ts';
import {
  createRealtimePublicControlRuntime,
  type MediaStopPort,
  type RealtimeE2eeCiphertextResolverPort,
  type RealtimeGovernancePort,
  type RealtimeKeyResolverPort,
  type RealtimePublicControlRuntime,
  type RealtimeSessionAuthorityPort,
} from './realtime-public-control-runtime.ts';

/** The only Cloud profile currently admitted by the production composition. */
export const REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE = 'livekit-cloud' as const;

/** The local listener is owned by main.ts; this module never binds it. */
export const REALTIME_PUBLIC_CONTROL_GATEWAY_HOST = '127.0.0.1' as const;
export const REALTIME_PUBLIC_CONTROL_GATEWAY_PORT = 8787 as const;

const SECRET_REFERENCE_KEYS = new Set(['name', 'version']);
const SECRET_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CLOUD_CONFIG_KEYS = new Set([
  'profile', 'projectUrl', 'apiKeyRef', 'apiSecretRef', 'secretResolver',
  'tokenSigner', 'participant', 'createTokenSigner', 'createParticipant',
]);
const PRODUCTION_OPTIONS_KEYS = new Set([
  'enabled', 'controlHost', 'cloud', 'ports', 'createE2eeCiphertextResolver',
  'e2eeCiphertextResolverOptions', 'schemaRegistry', 'maxBodyBytes', 'now',
]);
const PRODUCTION_PORT_KEYS = new Set([
  'governance', 'sessions', 'mediaStop', 'e2ee', 'e2eeCiphertext',
  'e2eeCiphertextResolver', 'edge', 'bearer', 'tokenSigner', 'participant',
  'currentBinding', 'handoffOutputFence', 'handoffEffects', 'outputFence', 'handoffTerminalCodec', 'handoffCodec',
]);

/** The public seam is Omit<RealtimeE2eeCiphertextResolverOptions, both canonical validators>. */
type RealtimeE2eeCiphertextResolverOptionsWithoutSchemaValidators = Omit<
  RealtimeE2eeCiphertextResolverOptions,
  'requestValidator' | 'terminalValidator'
>;
type BoundRealtimeE2eeCiphertextResolverOptions =
  RealtimeE2eeCiphertextResolverOptions & {
    readonly requestValidator: {
      readonly validateRequest: (operation: 'realtime_e2ee_key_resolve', value: unknown) => boolean;
    };
    readonly terminalValidator: {
      readonly validateTerminalResult: (
        operation: 'realtime_e2ee_key_resolve',
        value: Record<string, unknown>,
        status?: 'expired' | 'revoked' | 'indeterminate',
      ) => boolean;
    };
  };

export interface RealtimePublicControlCloudConfig {
  readonly profile: typeof REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE;
  readonly projectUrl: string;
  readonly apiKeyRef: SecretReference;
  readonly apiSecretRef: SecretReference;
  /** Resolves references only; the composition never accepts secret values. */
  readonly secretResolver: SecretResolverPort;
  /** Optional already-bound owner implementation. */
  readonly tokenSigner?: LiveKitCloudTokenSignerPort;
  /** Optional already-bound owner implementation. */
  readonly participant?: LiveKitCloudParticipantPort;
  /** Test/host adapter for constructing the signer from the frozen refs. */
  readonly createTokenSigner?: (options: LiveKitCloudTokenSignerOptions) => LiveKitCloudTokenSignerPort;
  /** Test/host adapter for constructing a participant without making a network call. */
  readonly createParticipant?: (input: Readonly<{ projectUrl: string }>) => LiveKitCloudParticipantPort;
}

/**
 * These are deliberately ports, not implementations. T02/T03/T11B and the
 * edge/bearer owners remain authoritative for their respective operations.
 */
export interface RealtimePublicControlProductionPorts {
  readonly governance: RealtimeGovernancePort;
  readonly sessions: RealtimeSessionAuthorityPort;
  readonly mediaStop: MediaStopPort;
  readonly e2ee: RealtimeKeyResolverPort;
  readonly e2eeCiphertext?: RealtimeE2eeCiphertextResolverPort;
  /** Alias retained for the resolver worker's descriptive name. */
  readonly e2eeCiphertextResolver?: RealtimeE2eeCiphertextResolverPort;
  readonly edge: RealtimePublicControlEdgePort;
  readonly bearer: RealtimePublicControlBearerPort;
  /** Optional injected Cloud implementations; otherwise cloud factories are used. */
  readonly tokenSigner?: LiveKitCloudTokenSignerPort;
  readonly participant?: LiveKitCloudParticipantPort;
  /** T11B current-binding read seam required by the handoff successor. */
  readonly currentBinding?: { readonly resolve: (input: unknown) => Promise<unknown>; readonly close?: () => void | Promise<void> };
  /** T02 durable replay/output-fence seam required by the handoff successor. */
  readonly handoffOutputFence?: {
    readonly claim: (input: unknown) => Promise<unknown>;
    readonly commit: (input: unknown) => Promise<void>;
    readonly release: (input: unknown) => Promise<void>;
    readonly suppressAndClose: (input: unknown) => Promise<unknown>;
    readonly close?: () => void | Promise<void>;
  };
  readonly handoffEffects?: RealtimePublicControlProductionPorts['handoffOutputFence'];
  /** Alias retained for callers that call the seam simply outputFence. */
  readonly outputFence?: RealtimePublicControlProductionPorts['handoffOutputFence'];
  /** T01-owned canonical terminal codec; required before any handoff effect. */
  readonly handoffTerminalCodec?: { readonly encode: (input: unknown) => Promise<Record<string, unknown>>; readonly close?: () => void | Promise<void> };
  readonly handoffCodec?: RealtimePublicControlProductionPorts['handoffTerminalCodec'];
}

export interface RealtimePublicControlProductionOptions {
  /** Must be explicit so a disabled feature cannot be enabled accidentally. */
  readonly enabled: boolean;
  readonly controlHost: string;
  readonly cloud: RealtimePublicControlCloudConfig;
  /** Required when enabled; absent is a pre-listener configuration failure. */
  readonly ports?: RealtimePublicControlProductionPorts;
  /** Optional resolver-worker seam; the resolver implementation stays outside this composition. */
  readonly createE2eeCiphertextResolver?: () => RealtimeE2eeCiphertextResolverPort;
  /** Direct owner ports for the admitted RFC-009 resolver factory. */
  readonly e2eeCiphertextResolverOptions?: RealtimeE2eeCiphertextResolverOptionsWithoutSchemaValidators;
  readonly schemaRegistry?: RealtimeSchemaRegistry;
  readonly maxBodyBytes?: number;
  readonly now?: () => number;
}

export interface RealtimePublicControlProduction {
  readonly enabled: boolean;
  readonly cloud: Readonly<{
    readonly profile: typeof REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE;
    readonly projectUrl: string;
    readonly apiKeyRef: SecretReference;
    readonly apiSecretRef: SecretReference;
  }>;
  /** Undefined when the feature is explicitly OFF. */
  readonly controller?: RealtimePublicControlController;
  /** Undefined when the feature is explicitly OFF. */
  readonly runtime?: RealtimePublicControlRuntime;
  close(): Promise<void>;
}

export class RealtimePublicControlProductionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RealtimePublicControlProductionError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlProductionError(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function assertClosedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
}

function freezeSecretReference(value: unknown, code: string): SecretReference {
  const recordValue = record(value, code);
  for (const key of Object.keys(recordValue)) {
    if (!SECRET_REFERENCE_KEYS.has(key)) fail(code);
  }
  const name = recordValue.name;
  if (typeof name !== 'string' || !SECRET_REFERENCE_PATTERN.test(name)) fail(code);
  const version = recordValue.version;
  if (version !== undefined && (typeof version !== 'string' || !SECRET_REFERENCE_PATTERN.test(version))) {
    fail(code);
  }
  return Object.freeze(version === undefined ? { name } : { name, version });
}

function sameSecretReference(left: SecretReference, right: SecretReference): boolean {
  return left.name === right.name && left.version === right.version;
}

function requireMethod<T extends object>(value: unknown, name: string, methods: readonly string[]): T {
  if (value === null || typeof value !== 'object') fail(`${name}_PORT_REQUIRED`);
  for (const method of methods) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function') fail(`${name}_PORT_INVALID`);
  }
  return value as T;
}

function normalizeCloud(value: RealtimePublicControlCloudConfig): RealtimePublicControlCloudConfig & {
  readonly projectUrl: string;
  readonly apiKeyRef: SecretReference;
  readonly apiSecretRef: SecretReference;
} {
  const cloud = record(value, 'PUBLIC_RTC_CLOUD_CONFIG_REQUIRED');
  assertClosedKeys(cloud, CLOUD_CONFIG_KEYS, 'PUBLIC_RTC_CLOUD_CONFIG_UNKNOWN_KEY');
  const config = value as RealtimePublicControlCloudConfig;
  if (config.profile !== REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE) fail('PUBLIC_RTC_CLOUD_PROFILE_INVALID');
  const projectUrl = assertCanonicalLiveKitCloudProjectUrl(config.projectUrl);
  const apiKeyRef = freezeSecretReference(config.apiKeyRef, 'PUBLIC_RTC_API_KEY_REF_INVALID');
  const apiSecretRef = freezeSecretReference(config.apiSecretRef, 'PUBLIC_RTC_API_SECRET_REF_INVALID');
  if (sameSecretReference(apiKeyRef, apiSecretRef)) fail('PUBLIC_RTC_SECRET_REFS_MUST_DIFFER');
  const secretResolver = requireMethod<SecretResolverPort>(
    config.secretResolver,
    'PUBLIC_RTC_SECRET_RESOLVER',
    ['resolve'],
  );
  if (config.tokenSigner !== undefined) {
    requireMethod<LiveKitCloudTokenSignerPort>(config.tokenSigner, 'PUBLIC_RTC_TOKEN_SIGNER', [
      'assertProjectUrl', 'sign', 'close',
    ]);
  }
  if (config.participant !== undefined) {
    requireMethod<LiveKitCloudParticipantPort>(config.participant, 'PUBLIC_RTC_PARTICIPANT', [
      'connect', 'disconnect', 'snapshot', 'close',
    ]);
  }
  if (config.createTokenSigner !== undefined && typeof config.createTokenSigner !== 'function') {
    fail('PUBLIC_RTC_TOKEN_SIGNER_FACTORY_INVALID');
  }
  if (config.createParticipant !== undefined && typeof config.createParticipant !== 'function') {
    fail('PUBLIC_RTC_PARTICIPANT_FACTORY_INVALID');
  }
  return Object.freeze({
    profile: REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE,
    projectUrl,
    apiKeyRef,
    apiSecretRef,
    secretResolver,
    ...(config.tokenSigner === undefined ? {} : { tokenSigner: config.tokenSigner }),
    ...(config.participant === undefined ? {} : { participant: config.participant }),
    ...(config.createTokenSigner === undefined ? {} : { createTokenSigner: config.createTokenSigner }),
    ...(config.createParticipant === undefined ? {} : { createParticipant: config.createParticipant }),
  });
}

function requirePorts(
  value: RealtimePublicControlProductionPorts | undefined,
): RealtimePublicControlProductionPorts & {
  readonly e2eeCiphertext: RealtimeE2eeCiphertextResolverPort;
} {
  const ports = record(value, 'PUBLIC_RTC_OWNER_PORTS_REQUIRED');
  assertClosedKeys(ports, PRODUCTION_PORT_KEYS, 'PUBLIC_RTC_OWNER_PORTS_UNKNOWN_KEY');
  const governance = requireMethod<RealtimeGovernancePort>(ports.governance, 'PUBLIC_RTC_GOVERNANCE', ['evaluate']);
  const sessions = requireMethod<RealtimeSessionAuthorityPort>(ports.sessions, 'PUBLIC_RTC_SESSIONS', [
    'bootstrap', 'refresh', 'endContinuity', 'handoff',
  ]);
  const mediaStop = requireMethod<MediaStopPort>(ports.mediaStop, 'PUBLIC_RTC_MEDIA_STOP', [
    'claim', 'unpublishAllTracks', 'disconnectParticipant', 'complete',
  ]);
  const e2ee = requireMethod<RealtimeKeyResolverPort>(ports.e2ee, 'PUBLIC_RTC_E2EE', ['issue']);
  const e2eeCiphertext = ports.e2eeCiphertext ?? ports.e2eeCiphertextResolver;
  const checkedE2eeCiphertext = requireMethod<RealtimeE2eeCiphertextResolverPort>(
    e2eeCiphertext,
    'PUBLIC_RTC_E2EE_CIPHERTEXT',
    ['resolve'],
  );
  const edge = requireMethod<RealtimePublicControlEdgePort>(ports.edge, 'PUBLIC_RTC_EDGE', ['authorize']);
  const bearer = requireMethod<RealtimePublicControlBearerPort>(ports.bearer, 'PUBLIC_RTC_BEARER', ['authorize']);
  const currentBinding = requireMethod<NonNullable<RealtimePublicControlProductionPorts['currentBinding']>>(
    ports.currentBinding,
    'PUBLIC_RTC_CURRENT_BINDING',
    ['resolve'],
  );
  const handoffOutputFence = ports.handoffOutputFence ?? ports.handoffEffects ?? ports.outputFence;
  const checkedHandoffOutputFence = requireMethod<NonNullable<RealtimePublicControlProductionPorts['handoffOutputFence']>>(
    handoffOutputFence,
    'PUBLIC_RTC_HANDOFF_OUTPUT_FENCE',
    ['claim', 'commit', 'release', 'suppressAndClose'],
  );
  const handoffTerminalCodec = ports.handoffTerminalCodec ?? ports.handoffCodec;
  const checkedHandoffTerminalCodec = requireMethod<NonNullable<RealtimePublicControlProductionPorts['handoffTerminalCodec']>>(
    handoffTerminalCodec,
    'PUBLIC_RTC_HANDOFF_TERMINAL_CODEC',
    ['encode'],
  );
  if (ports.tokenSigner !== undefined) {
    requireMethod<LiveKitCloudTokenSignerPort>(ports.tokenSigner, 'PUBLIC_RTC_TOKEN_SIGNER', [
      'assertProjectUrl', 'sign', 'close',
    ]);
  }
  if (ports.participant !== undefined) {
    requireMethod<LiveKitCloudParticipantPort>(ports.participant, 'PUBLIC_RTC_PARTICIPANT', [
      'connect', 'disconnect', 'snapshot', 'close',
    ]);
  }
  return Object.freeze({
    ...ports,
    governance,
    sessions,
    mediaStop,
    e2ee,
    e2eeCiphertext: checkedE2eeCiphertext,
    edge,
    bearer,
    currentBinding,
    handoffOutputFence: checkedHandoffOutputFence,
    handoffTerminalCodec: checkedHandoffTerminalCodec,
  });
}

function resolveSchemaRegistry(value: RealtimeSchemaRegistry | undefined): RealtimeSchemaRegistry {
  if (value === undefined) return createRealtimeSchemaRegistry();
  const registry = record(value, 'PUBLIC_RTC_SCHEMA_REGISTRY_REQUIRED');
  if (typeof registry.validateRequest !== 'function') {
    fail('PUBLIC_RTC_SCHEMA_REGISTRY_REQUEST_INVALID');
  }
  if (typeof registry.validateResponse !== 'function') {
    fail('PUBLIC_RTC_SCHEMA_REGISTRY_RESPONSE_INVALID');
  }
  if (typeof registry.validateTerminal !== 'function') {
    fail('PUBLIC_RTC_SCHEMA_REGISTRY_TERMINAL_INVALID');
  }
  return value;
}

function closeCreated(
  participant: LiveKitCloudParticipantPort | undefined,
  tokenSigner: LiveKitCloudTokenSignerPort | undefined,
  ciphertextResolver: RealtimeE2eeCiphertextResolverPort | undefined,
): void {
  // Construction is synchronous. Invoke both owned close hooks before
  // rethrowing, while allowing an async participant close to finish on its
  // own without replacing the original configuration error.
  try {
    const result = participant?.close();
    if (result !== undefined) void result.catch(() => undefined);
  } catch { /* preserve the construction error */ }
  try { tokenSigner?.close(); } catch { /* preserve the construction error */ }
  try {
    const result = ciphertextResolver?.close?.();
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch { /* preserve the construction error */ }
}

/**
 * Compose the successor control plane without starting a listener. All owner
 * authority enters through ports and all Cloud credentials remain references.
 */
export function createRealtimePublicControlProduction(
  options: RealtimePublicControlProductionOptions,
): RealtimePublicControlProduction {
  const optionsRecord = record(options, 'PUBLIC_RTC_PRODUCTION_OPTIONS_REQUIRED');
  assertClosedKeys(optionsRecord, PRODUCTION_OPTIONS_KEYS, 'PUBLIC_RTC_PRODUCTION_OPTIONS_UNKNOWN_KEY');
  const cloud = normalizeCloud(options.cloud);
  if (typeof options.enabled !== 'boolean') fail('PUBLIC_RTC_FEATURE_FLAG_REQUIRED');
  if (
    typeof options.controlHost !== 'string' ||
    options.controlHost.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(options.controlHost)
  ) {
    fail('PUBLIC_RTC_CONTROL_HOST_REQUIRED');
  }

  const publicCloud = Object.freeze({
    profile: cloud.profile,
    projectUrl: cloud.projectUrl,
    apiKeyRef: cloud.apiKeyRef,
    apiSecretRef: cloud.apiSecretRef,
  });
  if (!options.enabled) {
    return Object.freeze({
      enabled: false,
      cloud: publicCloud,
      close: async (): Promise<void> => undefined,
    });
  }

  let tokenSigner: LiveKitCloudTokenSignerPort | undefined;
  let participant: LiveKitCloudParticipantPort | undefined;
  let ciphertextResolver: RealtimeE2eeCiphertextResolverPort | undefined;
  let ownsTokenSigner = false;
  let ownsParticipant = false;
  let ownsCiphertextResolver = false;
  try {
    const schemaRegistry = resolveSchemaRegistry(options.schemaRegistry);
    const suppliedCiphertextResolver = options.ports?.e2eeCiphertext ?? options.ports?.e2eeCiphertextResolver;
    ciphertextResolver = suppliedCiphertextResolver;
    if (ciphertextResolver === undefined && options.createE2eeCiphertextResolver !== undefined) {
      ciphertextResolver = options.createE2eeCiphertextResolver();
      ownsCiphertextResolver = true;
    }
    if (ciphertextResolver === undefined && options.e2eeCiphertextResolverOptions !== undefined) {
      const resolverOptions: BoundRealtimeE2eeCiphertextResolverOptions = {
        ...options.e2eeCiphertextResolverOptions,
        requestValidator: {
          validateRequest: (operation: 'realtime_e2ee_key_resolve', value: unknown): boolean => (
            operation === 'realtime_e2ee_key_resolve' &&
            schemaRegistry.validateRequest('realtime_e2ee_key_resolve', value)
          ),
        },
        terminalValidator: {
          validateTerminalResult: (
            operation: 'realtime_e2ee_key_resolve',
            value: Record<string, unknown>,
          ): boolean => (
            operation === 'realtime_e2ee_key_resolve' && schemaRegistry.validateTerminal(value)
          ),
        },
      };
      ciphertextResolver = createRealtimeE2eeCiphertextResolver(resolverOptions);
      ownsCiphertextResolver = true;
    }
    const portsInput = options.ports === undefined || ciphertextResolver === undefined
      ? options.ports
      : { ...options.ports, e2eeCiphertext: ciphertextResolver };
    const ports = requirePorts(portsInput);
    ciphertextResolver = ports.e2eeCiphertext;

    tokenSigner = ports.tokenSigner ?? cloud.tokenSigner;
    if (tokenSigner === undefined) {
      const signerFactory = cloud.createTokenSigner ?? createLiveKitCloudTokenSigner;
      tokenSigner = signerFactory({
        projectUrl: cloud.projectUrl,
        apiKeyRef: cloud.apiKeyRef,
        apiSecretRef: cloud.apiSecretRef,
        secretResolver: cloud.secretResolver,
      });
      ownsTokenSigner = true;
    }
    requireMethod<LiveKitCloudTokenSignerPort>(tokenSigner, 'PUBLIC_RTC_TOKEN_SIGNER', [
      'assertProjectUrl', 'sign', 'close',
    ]).assertProjectUrl(cloud.projectUrl);

    participant = ports.participant ?? cloud.participant;
    if (participant === undefined) {
      participant = cloud.createParticipant === undefined
        ? createLiveKitCloudParticipant()
        : cloud.createParticipant({ projectUrl: cloud.projectUrl });
      ownsParticipant = true;
    }
    requireMethod<LiveKitCloudParticipantPort>(participant, 'PUBLIC_RTC_PARTICIPANT', [
      'connect', 'disconnect', 'snapshot', 'close',
    ]);

    const runtime = createRealtimePublicControlRuntime({
      governance: ports.governance,
      sessions: ports.sessions,
      mediaStop: ports.mediaStop,
      e2ee: ports.e2ee,
      e2eeCiphertext: ciphertextResolver,
      tokenSigner,
      participant,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const controllerOptions: RealtimePublicControlControllerOptions = {
      enabled: true,
      controlHost: options.controlHost,
      edge: ports.edge,
      bearer: ports.bearer,
      runtime,
      schemaRegistry,
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    };
    const controller = createRealtimePublicControlController(controllerOptions);
    let closeFlight: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closeFlight ??= controller.close();
      return closeFlight;
    };
    return Object.freeze({
      enabled: true,
      cloud: publicCloud,
      controller,
      runtime,
      close,
    });
  } catch (error) {
    if (ownsParticipant || ownsTokenSigner || ownsCiphertextResolver) {
      closeCreated(
        ownsParticipant ? participant : undefined,
        ownsTokenSigner ? tokenSigner : undefined,
        ownsCiphertextResolver ? ciphertextResolver : undefined,
      );
    }
    throw error;
  }
}

export const createPublicRtcProduction = createRealtimePublicControlProduction;
