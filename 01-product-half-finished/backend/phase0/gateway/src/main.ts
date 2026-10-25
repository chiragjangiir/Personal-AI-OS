import { configuredPublicApiOrigin } from './public-api-origins.ts';
import {withShutdownDrain,joinShutdown,shutdownSignal,DEFAULT_SHUTDOWN_DRAIN_MS} from '../../../services/personal-aios-integration/src/main.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join, normalize, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TokenVerifier } from 'livekit-server-sdk';
import { assertFileHash, CONTRACT_SCHEMA_VERSION_V0_3, loadFrozenArtifacts } from './contract-consumer.ts';
import {
  DeviceSessionAdapter, RayneoVisualSessionAdapter, parseStrictJsonBytes,
  type GatewayConfig, type SupervisedAbsenceProofDocuments,
  type SupervisedAbsenceProofCommitter,
  type SupervisedCleanupReceipt, type SupervisedDeviceLanBinding,
} from './device-session-adapter.ts';
import { renderDashboard } from './dashboard.ts';
import { RayneoPairingRegistry } from './rayneo-pairing-registry.ts';
import {
  Phase0DemoSessionController,
} from './phase0-demo-session-controller.ts';
import {
  Phase0SharedSessionOwner,
  type Phase0OwnerAuthenticatedIphone,
  type Phase0OwnerEvent,
} from './phase0-shared-session-owner.ts';
import {
  RayneoRealtimeAudioController,
  type RayneoRealtimeAudioBinding,
  type RayneoRealtimeAudioConfig,
  type RayneoRealtimeAudioSession,
  RAYNEO_REALTIME_OWNER_ISSUANCE,
  readRayneoRealtimeOwnerIssuance,
  type RayneoRealtimeOwnerIssuanceProjection,
} from './rayneo-realtime-audio-controller.ts';
import type {
  RayneoLiveKitOwnerAliasIssuerPort,
} from './rayneo-livekit-owner-alias-issuer.ts';
import type { RayneoDemoLiveSessionOutput } from './rayneo-demo-owner-projection.ts';
import {
  type RayneoProductionComposition,
  type RayneoProductionTurn,
  type RayneoProductionTurnBinding,
} from './rayneo-production-composition.ts';
import { RayneoSessionTurnContext } from './rayneo-session-turn-context.ts';
import {
  adaptOwnerResolvedPerceptionContext,
  type WindowsAiOwnerResolvedPerceptionContext,
} from './windows-ai-perception-context-adapter.ts';
import {
  createWindowsAiInferenceOrchestrator,
  type WindowsAiInferenceEvent,
} from './windows-ai-inference-orchestrator.ts';
import type {
  WindowsAiContextCompilerInput,
  WindowsAiTokenEstimator,
} from './windows-ai-context-compiler.ts';
import {
  QWEN38_PROVIDER_ENDPOINT,
  QWEN38_PROVIDER_CONTEXT_TOKENS,
  QWEN38_PROVIDER_MODEL,
  QWEN38_LOCAL_PROVIDER_PROFILES,
  Qwen38ProviderAdapter,
  freezeQwen38LocalProviderProfile,
  selectQwen38LocalProviderProfile,
  type Qwen38LocalProviderProfile,
  type Qwen38ProviderSelectionRequirements,
  type Qwen38ChatRequest,
  type Qwen38ChatMessage,
} from './qwen38-provider-adapter.ts';
import {
  parseRealtimePublicControlFeatureFlag,
  type RealtimePublicControlController,
} from './realtime-public-control-controller.ts';
import { GATEWAY_HOST, GATEWAY_PORT } from './gateway-binding.ts';
const RAYNEO_VISUAL_MAX_MODEL_DEADLINE_MS = 300_000;
interface RayneoProviderReadiness {readonly ready: boolean; readonly validThroughMs: number}
interface RayneoVisualModelProvider {analyze(jpeg: Buffer, signal: AbortSignal, frame?: RayneoVisualModelFrame): Promise<RayneoVisualModelResult>}
import type { RayneoVisualModelFrame, RayneoVisualModelResult } from './rayneo-production-composition.ts';
import type { HandoffRequest } from './shared-session-orchestrator.ts';

const HOST = GATEWAY_HOST;
const PORT: number = GATEWAY_PORT;
const REACT_ORIGIN = 'http://127.0.0.1:3000';
const SELF_ORIGIN = `http://${HOST}:${PORT}`;
const MAX_BODY_BYTES = 16_384;
const PROXY_ATTESTATION_HEADER = 'x-paios-proxy-attestation';
const SUPERVISED_ENVIRONMENT_NAMES = Object.freeze([
  'PAIOS_T15_FIREWALL_RUN_ID', 'PAIOS_T15_ACTIVATION_ATTEMPT_ID', 'PAIOS_T15_SESSION_ID',
  'PAIOS_T15_ROOM_NAME', 'PAIOS_T15_DEVICE_ID', 'PAIOS_T15_PARTICIPANT_IDENTITY',
  'PAIOS_T15_CLIENT_INSTANCE_ID', 'PAIOS_T15_CONTROL_ROOT', 'PAIOS_T15_GATEWAY_CONTROL_NONCE',
  'PAIOS_T15_PRECONTACT_ADMISSION',
]);
const GATEWAY_PIPE_ENVIRONMENT_NAMES = Object.freeze([
  'PAIOS_T15_GATEWAY_PIPE_NAME', 'PAIOS_T15_GATEWAY_PIPE_CONFIG_PATH',
  'PAIOS_T15_GATEWAY_PIPE_CONFIG_SHA256', 'PAIOS_T15_GATEWAY_PIPE_CHALLENGE_SHA256',
  'PAIOS_T15_GATEWAY_BROKER_PID', 'PAIOS_T15_GATEWAY_BROKER_CREATION_UTC',
  'PAIOS_T15_GATEWAY_STAGE_ROOT', 'PAIOS_T15_GATEWAY_MANIFEST_SHA256',
]);
const GATEWAY_NODE_PIPE_SCHEMA = 'paos.gateway-node-pipe.v1' as const;
const GATEWAY_NODE_PIPE_CONFIG_SCHEMA = 'paos.gateway-node-pipe-config.v1' as const;
const GATEWAY_NODE_PIPE_GRANT =
  'MG-T15-P0-NO-DEVICE-PRECONTACT-NPCAP-AUTH-CLOSURE-SOURCE-003' as const;
const GATEWAY_NODE_PIPE_ROLE = 'GATEWAY_NODE_PRODUCER' as const;
const ZERO_SHA256 = '0'.repeat(64);
const REQUIRED_DEVICE_HEADERS = Object.freeze([
  'host',
  'origin',
  PROXY_ATTESTATION_HEADER,
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);
const FORBIDDEN_DEVICE_HEADERS = Object.freeze([
  'client-ip',
  'forwarded',
  'forwarded-for',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-original-host',
  'x-original-url',
  'x-paios-internal-auth',
  'x-real-ip',
  'x-rewrite-url',
  'x-sandbox-id',
]);

const GRANT_POSTIMAGES = Object.freeze({
  contractConsumer: {
    path: fileURLToPath(new URL('./contract-consumer.ts', import.meta.url)),
    hash: '285bb8cb6e0d26d94ff1f5dee09bd05cbd324f559b7a8348f9981be910aa1684',
  },
  contractConsumerTest: {
    path: fileURLToPath(new URL('../tests/contract-consumer.test.ts', import.meta.url)),
    hash: 'e98254f060d6a0ee12a7fbf21a8f6abe3da1262f3c83d9ae05b1281988405085',
  },
  fixedCanaryStt: {
    path: fileURLToPath(new URL('./fixed-canary-stt-adapter.ts', import.meta.url)),
    hash: '86936b204a14fd4cff9ef31834d1b89231efb5cfd03d4ff541c212b19440dbc3',
  },
  fixedCanarySttTest: {
    path: fileURLToPath(new URL('../tests/fixed-canary-stt-adapter.test.ts', import.meta.url)),
    hash: '496c0af739466675b1f51e87beb47696806d26e3b5c5829e2e1b3e0d08314a3c',
  },
});

export interface DeviceLanSecurityConfig {
  readonly publicOrigin: string;
  readonly publicHost: string;
  readonly hostIpv4: string;
  readonly hostIpv4Cidr: string;
  readonly subnetPrefixLength: number;
  readonly iphoneIpv4: string;
  readonly proxyAttestationSecret: string;
}

export interface GatewayRuntimeConfig {
  readonly gateway: GatewayConfig;
  readonly deviceLanSecurity: DeviceLanSecurityConfig;
  readonly supervisorControl?: { readonly nonce: string; readonly binding: SupervisedDeviceLanBinding };
  readonly precontactAdmission: 'CLOSED_PRECONTACT' | 'OPEN_NORMAL';
  readonly gatewayNodePipe?: GatewayNodePipeBootstrap;
}

export interface GatewayNodePipeConfig {
  readonly schema: typeof GATEWAY_NODE_PIPE_CONFIG_SCHEMA;
  readonly version: 1;
  readonly grant_id: typeof GATEWAY_NODE_PIPE_GRANT;
  readonly run_id: string;
  readonly activation_attempt_id: string;
  readonly pipe_name: string;
  readonly broker_pid: number;
  readonly broker_creation_time_utc: string;
  readonly broker_program: string;
  readonly broker_bytes: number;
  readonly broker_sha256: string;
  readonly broker_token_sid: string;
  readonly broker_integrity_rid: number;
  readonly challenge_sha256: string;
  readonly max_wire_bytes: number;
  readonly max_payload_bytes: number;
  readonly sqos: 'SECURITY_IDENTIFICATION';
}

export interface GatewayNodePipeBootstrap {
  readonly config: GatewayNodePipeConfig;
  readonly configBytes: Buffer;
  readonly configSha256: string;
  readonly configPath: string;
  readonly configFd: number;
  readonly stageRoot: string;
  readonly manifestSha256: string;
}

function persistentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface DeviceLanRequestMetadata {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly rawHeaders: readonly string[];
}

export type AuthorizedDeviceLanRoute =
  | { readonly kind: 'connection-details' }
  | { readonly kind: 'stop-session'; readonly roomName: string };

export type GatewayPrecontactCheckpoint = 'INITIAL' | 'E03' | 'E05' | 'E07' | 'E09' | 'STOP' | 'E14';

export interface GatewayPrecontactWitnessSnapshot {
  readonly admission: 'CLOSED_PRECONTACT';
  readonly never_opened: true;
  readonly stop_fenced: boolean;
  readonly route_attempt_count: number;
  readonly adapter_call_count: number;
  readonly adapter_call_in_flight: number;
  readonly signer_call_count: number;
  readonly signer_call_in_flight: number;
  readonly materialized_success_count: number;
  readonly response_count: number;
  readonly gateway_internal_prearm_success_count: number;
  readonly observation_generation: number;
}

export function incrementPrecontactSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new Error('PRECONTACT_WITNESS_OVERFLOW');
  }
  return value + 1;
}

export class NoDevicePrecontactWitness {
  #stopFenced = false;
  #routeAttempts = 0;
  #adapterCalls = 0;
  #adapterInFlight = 0;
  #signerCalls = 0;
  #signerInFlight = 0;
  #materializedSuccesses = 0;
  #responses = 0;
  #gatewayInternalPrearmSuccesses = 0;
  #generation = 0;

  #increment(counter: number): number {
    const next = incrementPrecontactSafeInteger(counter);
    this.#generation = incrementPrecontactSafeInteger(this.#generation);
    return next;
  }

  recordRouteAttempt(): void {
    this.#routeAttempts = this.#increment(this.#routeAttempts);
  }

  denyAtRouteBoundary(): void {
    throw new Error('DEVICE_LAN_PRECONTACT_CLOSED');
  }

  enterAdapterCall(): () => void {
    throw new Error('DEVICE_LAN_PRECONTACT_CLOSED');
  }

  signParticipantToken(token: { toJwt(): Promise<string> }): Promise<string> {
    void token;
    throw new Error('DEVICE_LAN_PRECONTACT_CLOSED');
  }

  recordResponse(): void {
    this.#responses = this.#increment(this.#responses);
  }

  recordGatewayInternalPrearmSuccess(): void {
    if (this.#gatewayInternalPrearmSuccesses !== 0) {
      throw new Error('PRECONTACT_INTERNAL_PREARM_DUPLICATE');
    }
    this.#gatewayInternalPrearmSuccesses = this.#increment(this.#gatewayInternalPrearmSuccesses);
  }

  fenceForStop(): void {
    if (!this.#stopFenced) {
      this.#stopFenced = true;
      this.#generation = incrementPrecontactSafeInteger(this.#generation);
    }
    this.assertZeroDeviceParticipantActivity();
  }

  assertZeroDeviceParticipantActivity(): void {
    const snapshot = this.snapshot();
    if (
      snapshot.route_attempt_count !== 0 ||
      snapshot.adapter_call_count !== 0 ||
      snapshot.adapter_call_in_flight !== 0 ||
      snapshot.signer_call_count !== 0 ||
      snapshot.signer_call_in_flight !== 0 ||
      snapshot.materialized_success_count !== 0 ||
      snapshot.response_count !== 0
    ) {
      throw new Error('PRECONTACT_DEVICE_PARTICIPANT_ACTIVITY');
    }
  }

  snapshot(): GatewayPrecontactWitnessSnapshot {
    if (
      !Number.isSafeInteger(this.#generation) ||
      this.#responses > this.#materializedSuccesses ||
      this.#materializedSuccesses > this.#signerCalls ||
      this.#signerCalls > this.#adapterCalls ||
      this.#adapterCalls > this.#routeAttempts ||
      this.#adapterInFlight > this.#adapterCalls ||
      this.#signerInFlight > this.#signerCalls
    ) {
      throw new Error('PRECONTACT_WITNESS_ORDER_INVALID');
    }
    return Object.freeze({
      admission: 'CLOSED_PRECONTACT',
      never_opened: true,
      stop_fenced: this.#stopFenced,
      route_attempt_count: this.#routeAttempts,
      adapter_call_count: this.#adapterCalls,
      adapter_call_in_flight: this.#adapterInFlight,
      signer_call_count: this.#signerCalls,
      signer_call_in_flight: this.#signerInFlight,
      materialized_success_count: this.#materializedSuccesses,
      response_count: this.#responses,
      gateway_internal_prearm_success_count: this.#gatewayInternalPrearmSuccesses,
      observation_generation: this.#generation,
    });
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`MISSING_PROCESS_ENV:${name}`);
  return value;
}

function requiredIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number,
): number {
  const raw = requiredEnvironment(environment, name);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`INVALID_PROCESS_ENV:${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`INVALID_PROCESS_ENV:${name}`);
  }
  return value;
}

function parseCanonicalIpv4(value: string): number | undefined {
  const octets = value.split('.');
  if (octets.length !== 4) return undefined;
  const numbers = octets.map((octet) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(octet)) return -1;
    const number = Number(octet);
    return number <= 255 ? number : -1;
  });
  if (numbers.some((number) => number < 0)) return undefined;
  return (
    numbers[0]! * 2 ** 24 +
    numbers[1]! * 2 ** 16 +
    numbers[2]! * 2 ** 8 +
    numbers[3]!
  );
}

function privateIpv4MinimumPrefix(value: number): number | undefined {
  const first = Math.floor(value / 2 ** 24);
  const second = Math.floor(value / 2 ** 16) % 256;
  if (first === 10) return 8;
  if (first === 172 && second >= 16 && second <= 31) return 12;
  if (first === 192 && second === 168) return 16;
  return undefined;
}

function parseDeviceLanSubnet(
  value: string,
): { readonly hostIpv4: string; readonly prefixLength: number; readonly network: number; readonly broadcast: number } {
  const match = /^([^/]+)\/([1-9]|[12][0-9]|30)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_HOST_IPV4_CIDR');
  }
  const hostIpv4 = match[1];
  const host = parseCanonicalIpv4(hostIpv4);
  const prefixLength = Number(match[2]);
  const minimumPrefix = host === undefined ? undefined : privateIpv4MinimumPrefix(host);
  if (host === undefined || minimumPrefix === undefined || prefixLength < minimumPrefix) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_HOST_IPV4_CIDR');
  }
  const blockSize = 2 ** (32 - prefixLength);
  const network = Math.floor(host / blockSize) * blockSize;
  const broadcast = network + blockSize - 1;
  if (host === network || host === broadcast) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_HOST_IPV4_CIDR');
  }
  return { hostIpv4, prefixLength, network, broadcast };
}

function isCanonicalProxySecret(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return (
    decoded.length === 32 && decoded.toString('base64url') === value && new Set(decoded).size >= 16
  );
}

function loadSupervisedControl(
  environment: NodeJS.ProcessEnv,
  deviceLanRunId: string,
): NonNullable<GatewayRuntimeConfig['supervisorControl']> {
  const firewallRunId = requiredEnvironment(environment, 'PAIOS_T15_FIREWALL_RUN_ID');
  const activationAttemptId = requiredEnvironment(environment, 'PAIOS_T15_ACTIVATION_ATTEMPT_ID');
  const sessionId = requiredEnvironment(environment, 'PAIOS_T15_SESSION_ID');
  const roomName = requiredEnvironment(environment, 'PAIOS_T15_ROOM_NAME');
  const deviceId = requiredEnvironment(environment, 'PAIOS_T15_DEVICE_ID');
  const participantIdentity = requiredEnvironment(environment, 'PAIOS_T15_PARTICIPANT_IDENTITY');
  const clientInstanceId = requiredEnvironment(environment, 'PAIOS_T15_CLIENT_INSTANCE_ID');
  const controlRoot = requiredEnvironment(environment, 'PAIOS_T15_CONTROL_ROOT');
  const nonce = requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_CONTROL_NONCE');
  const expectedDeviceLanRunId = `p0_${firewallRunId.replaceAll('-', '')}`;
  const expectedControlRoot = join(requiredEnvironment(environment, 'PAIOS_DATA_ROOT'), 'phase0-iphone-one-shot', 'runs', firewallRunId, activationAttemptId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(firewallRunId) ||
    !/^[0-9a-f]{32}$/.test(activationAttemptId) ||
    activationAttemptId === '0'.repeat(32) ||
    !/^phase0_session_[0-9a-f]{20}$/.test(sessionId) ||
    roomName !== sessionId ||
    !/^web_device_[0-9a-f]{20}$/.test(deviceId) ||
    participantIdentity !== deviceId ||
    !/^web_client_[0-9a-f]{20}$/.test(clientInstanceId) ||
    deviceLanRunId !== expectedDeviceLanRunId ||
    controlRoot !== expectedControlRoot ||
    normalize(controlRoot) !== controlRoot ||
    !isCanonicalProxySecret(nonce)
  ) {
    throw new Error('INVALID_PROCESS_ENV:PAIOS_T15_SUPERVISED_BINDING');
  }
  return { nonce, binding: {
    firewallRunId, activationAttemptId, sessionId, roomName, deviceId,
    participantIdentity, clientInstanceId, controlRoot,
  } };
}

function isLowerSha256(value: unknown, allowZero = false): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) &&
    (allowZero || value !== ZERO_SHA256);
}

function canonicalUtc(value: unknown, code: string): string {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      new Date(value).toISOString() !== value) {
    throw new Error(code);
  }
  return value;
}

function loadGatewayNodePipeBootstrap(
  environment: NodeJS.ProcessEnv,
  binding: SupervisedDeviceLanBinding,
): GatewayNodePipeBootstrap {
  const pipeName = requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_PIPE_NAME');
  const configPath = requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_PIPE_CONFIG_PATH');
  const configSha256 = requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_PIPE_CONFIG_SHA256');
  const challengeSha256 = requiredEnvironment(
    environment,
    'PAIOS_T15_GATEWAY_PIPE_CHALLENGE_SHA256',
  );
  const brokerPid = requiredIntegerEnvironment(
    environment,
    'PAIOS_T15_GATEWAY_BROKER_PID',
    2_147_483_647,
  );
  const brokerCreation = canonicalUtc(
    requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_BROKER_CREATION_UTC'),
    'INVALID_PROCESS_ENV:PAIOS_T15_GATEWAY_BROKER_CREATION_UTC',
  );
  const stageRoot = requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_STAGE_ROOT');
  const manifestSha256 = requiredEnvironment(environment, 'PAIOS_T15_GATEWAY_MANIFEST_SHA256');
  const privateRoot = win32.join(binding.controlRoot, 'gateway-broker-private');
  const expectedConfigPath = win32.join(privateRoot, 'gateway-node-pipe-config.json');
  if (
    !/^paos-[0-9a-f-]{36}-gateway-node-[0-9a-f]{32}$/.test(pipeName) ||
    configPath !== expectedConfigPath ||
    win32.normalize(configPath) !== configPath ||
    configPath.slice(2).includes(':') ||
    stageRoot !== win32.join(binding.controlRoot, 'gateway-stage') ||
    win32.normalize(stageRoot) !== stageRoot ||
    !isLowerSha256(configSha256) ||
    !isLowerSha256(challengeSha256) ||
    !isLowerSha256(manifestSha256)
  ) {
    throw new Error('INVALID_PROCESS_ENV:PAIOS_T15_GATEWAY_PIPE_BINDING');
  }
  for (const directory of [binding.controlRoot, privateRoot]) {
    const directoryStats = lstatSync(directory, { bigint: true });
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
        directoryStats.nlink < 1n || realpathSync.native(directory) !== directory ||
        directory.slice(2).includes(':')) {
      throw new Error('GATEWAY_PIPE_CONFIG_DIRECTORY_INVALID');
    }
  }
  const before = lstatSync(configPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      realpathSync.native(configPath) !== configPath || before.size < 2n || before.size > 16_384n) {
    throw new Error('GATEWAY_PIPE_CONFIG_LEAF_INVALID');
  }
  const configFd = openSync(configPath, fsConstants.O_RDONLY);
  try {
    const opened = fstatSync(configFd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev ||
        opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('GATEWAY_PIPE_CONFIG_LEAF_INVALID');
    }
    const configBytes = readFileSync(configFd);
    const after = fstatSync(configFd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.nlink !== 1n || createHash('sha256').update(configBytes).digest('hex') !== configSha256) {
      throw new Error('GATEWAY_PIPE_CONFIG_CHANGED_DURING_READ');
    }
    const value = parseStrictJsonBytes(configBytes, 16_384);
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('GATEWAY_PIPE_CONFIG_INVALID');
    }
    const config = value as unknown as GatewayNodePipeConfig;
    assertClosedDataKeys(config, [
      'schema', 'version', 'grant_id', 'run_id', 'activation_attempt_id', 'pipe_name',
      'broker_pid', 'broker_creation_time_utc', 'broker_program', 'broker_bytes',
      'broker_sha256', 'broker_token_sid', 'broker_integrity_rid', 'challenge_sha256',
      'max_wire_bytes', 'max_payload_bytes', 'sqos',
    ], 'GATEWAY_PIPE_CONFIG_INVALID');
    if (
      !Buffer.from(compactJsonBytes(config)).equals(configBytes) ||
      config.schema !== GATEWAY_NODE_PIPE_CONFIG_SCHEMA || config.version !== 1 ||
      config.grant_id !== GATEWAY_NODE_PIPE_GRANT || config.run_id !== binding.firewallRunId ||
      config.activation_attempt_id !== binding.activationAttemptId || config.pipe_name !== pipeName ||
      config.broker_pid !== brokerPid || config.broker_creation_time_utc !== brokerCreation ||
      typeof config.broker_program !== 'string' || !win32.isAbsolute(config.broker_program) ||
      !Number.isSafeInteger(config.broker_bytes) || config.broker_bytes < 1 ||
      !isLowerSha256(config.broker_sha256) ||
      typeof config.broker_token_sid !== 'string' ||
      !/^S-1-(?:\d+-){1,14}\d+$/.test(config.broker_token_sid) ||
      !Number.isSafeInteger(config.broker_integrity_rid) || config.broker_integrity_rid < 0 ||
      config.challenge_sha256 !== challengeSha256 || config.max_wire_bytes !== 262_144 ||
      config.max_payload_bytes !== 131_072 || config.sqos !== 'SECURITY_IDENTIFICATION'
    ) {
      throw new Error('GATEWAY_PIPE_CONFIG_INVALID');
    }
    return {
      config,
      configBytes: Buffer.from(configBytes),
      configSha256,
      configPath,
      configFd,
      stageRoot,
      manifestSha256,
    };
  } catch (error) {
    closeSync(configFd);
    throw error;
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  hostInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): GatewayRuntimeConfig {
  for (const binding of Object.values(GRANT_POSTIMAGES)) {
    assertFileHash(binding.path, binding.hash);
  }
  loadFrozenArtifacts(CONTRACT_SCHEMA_VERSION_V0_3);

  const precontactAdmissionRaw =
    environment.PAIOS_T15_PRECONTACT_ADMISSION ?? 'CLOSED_PRECONTACT';
  if (!['CLOSED_PRECONTACT', 'OPEN_NORMAL'].includes(precontactAdmissionRaw)) {
    throw new Error('INVALID_PROCESS_ENV:PAIOS_T15_PRECONTACT_ADMISSION');
  }

  const livekitUrl = requiredEnvironment(environment, 'LIVEKIT_URL');
  let parsedLivekit: URL;
  try {
    parsedLivekit = new URL(livekitUrl);
  } catch {
    throw new Error('LOOPBACK_LIVEKIT_URL_REQUIRED');
  }
  if (
    parsedLivekit.protocol !== 'ws:' ||
    parsedLivekit.hostname !== HOST ||
    parsedLivekit.port !== '7880' ||
    parsedLivekit.pathname !== '/' ||
    parsedLivekit.search !== '' ||
    parsedLivekit.hash !== ''
  ) {
    throw new Error('LOOPBACK_LIVEKIT_URL_REQUIRED');
  }
  const apiKey = requiredEnvironment(environment, 'LIVEKIT_API_KEY');
  const apiSecret = requiredEnvironment(environment, 'LIVEKIT_API_SECRET');
  if (
    apiKey.length < 16 ||
    apiSecret.length < 32 ||
    ['devkey', 'apikey'].includes(apiKey.toLowerCase()) ||
    ['secret', 'devsecret'].includes(apiSecret.toLowerCase())
  ) {
    throw new Error('PER_RUN_RANDOM_CREDENTIALS_REQUIRED');
  }
  const sttEndpointPort = requiredIntegerEnvironment(environment, 'STT_ENDPOINT_PORT', 65_535);
  const sttEndpointUrl = requiredEnvironment(environment, 'STT_ENDPOINT_URL');
  if (
    sttEndpointPort !== 8000 ||
    sttEndpointUrl !== 'http://127.0.0.1:8000/v1/audio/transcriptions'
  ) {
    throw new Error('LOOPBACK_STT_ENDPOINT_REQUIRED');
  }

  const publicOrigin = requiredEnvironment(environment, 'DEVICE_LAN_PUBLIC_ORIGIN');
  let parsedPublicOrigin: URL;
  try {
    parsedPublicOrigin = new URL(publicOrigin);
  } catch {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_PUBLIC_ORIGIN');
  }
  if (
    parsedPublicOrigin.protocol !== 'https:' ||
    parsedPublicOrigin.port !== '' ||
    parsedPublicOrigin.username !== '' ||
    parsedPublicOrigin.password !== '' ||
    parsedPublicOrigin.pathname !== '/' ||
    parsedPublicOrigin.search !== '' ||
    parsedPublicOrigin.hash !== '' ||
    parsedPublicOrigin.origin !== publicOrigin
  ) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_PUBLIC_ORIGIN');
  }
  const hostIpv4Cidr = requiredEnvironment(environment, 'DEVICE_LAN_HOST_IPV4_CIDR');
  const subnet = parseDeviceLanSubnet(hostIpv4Cidr);
  if (parsedPublicOrigin.hostname !== subnet.hostIpv4) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_PUBLIC_ORIGIN');
  }
  const exactHostInterfaces = Object.values(hostInterfaces)
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === 'IPv4' &&
        entry.internal === false &&
        entry.address === subnet.hostIpv4 &&
        entry.cidr === hostIpv4Cidr,
    );
  if (exactHostInterfaces.length !== 1) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_HOST_IPV4_CIDR');
  }
  const publicHost = requiredEnvironment(environment, 'DEVICE_LAN_PUBLIC_HOST');
  if (publicHost !== subnet.hostIpv4 || publicHost !== parsedPublicOrigin.host) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_PUBLIC_HOST');
  }
  const iphoneIpv4 = requiredEnvironment(environment, 'DEVICE_LAN_IPHONE_IPV4');
  const iphone = parseCanonicalIpv4(iphoneIpv4);
  if (
    iphone === undefined ||
    privateIpv4MinimumPrefix(iphone) === undefined ||
    iphone === subnet.network ||
    iphone === subnet.broadcast ||
    iphone === parseCanonicalIpv4(subnet.hostIpv4) ||
    iphone < subnet.network ||
    iphone > subnet.broadcast
  ) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_IPHONE_IPV4');
  }
  const proxyAttestationSecret = requiredEnvironment(
    environment,
    'DEVICE_LAN_PROXY_ATTESTATION_SECRET',
  );
  if (!isCanonicalProxySecret(proxyAttestationSecret)) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_PROXY_ATTESTATION_SECRET');
  }
  const runId = requiredEnvironment(environment, 'DEVICE_LAN_RUN_ID');
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(runId)) {
    throw new Error('INVALID_PROCESS_ENV:DEVICE_LAN_RUN_ID');
  }
  const supervisorControl = loadSupervisedControl(environment, runId);
  if (requiredEnvironment(environment, 'LIVEKIT_ROOM_AUTO_CREATE') !== 'false') {
    throw new Error('INVALID_PROCESS_ENV:LIVEKIT_ROOM_AUTO_CREATE');
  }
  const clientLivekitUrl = new URL(publicOrigin);
  clientLivekitUrl.protocol = 'wss:';

  const result: GatewayRuntimeConfig = {
    gateway: {
      livekitUrl,
      apiKey,
      apiSecret,
      directLoop: {
        sttEndpointUrl,
        sttEndpointPort,
        sttModel: requiredEnvironment(environment, 'STT_MODEL'),
        sttDeadlineMs: requiredIntegerEnvironment(environment, 'STT_DEADLINE_MS', 120_000),
        ollamaModel: requiredEnvironment(environment, 'OLLAMA_MODEL'),
      },
      sessionTtlSeconds: 120,
      tokenTtlSeconds: 120,
      deviceLan: {
        clientLivekitUrl: clientLivekitUrl.origin,
        runId,
        roomAutoCreateDisabled: true,
      supervised: supervisorControl.binding,
      },
    },
    deviceLanSecurity: {
      publicOrigin,
      publicHost,
      hostIpv4: subnet.hostIpv4,
      hostIpv4Cidr,
      subnetPrefixLength: subnet.prefixLength,
      iphoneIpv4,
      proxyAttestationSecret,
    },
    supervisorControl,
    precontactAdmission: precontactAdmissionRaw as 'CLOSED_PRECONTACT' | 'OPEN_NORMAL',
  };
  if (environment === process.env) {
    for (const name of [...SUPERVISED_ENVIRONMENT_NAMES, ...GATEWAY_PIPE_ENVIRONMENT_NAMES]) {
      delete process.env[name];
    }
  }
  return result;
}

export type GatewayPublicationCheckpoint =
  | 'INITIAL' | 'E03' | 'E05' | 'E07' | 'E09' | 'STOP'
  | 'PARTICIPANT_ABSENCE' | 'PUBLICATION_ABSENCE' | 'ABSENCE_COMMIT'
  | 'CLEANUP_COMPLETE' | 'E14';

const GATEWAY_PUBLICATION_SCHEDULE = Object.freeze([
  'INITIAL', 'E03', 'E05', 'E07', 'E09', 'STOP',
  'PARTICIPANT_ABSENCE', 'PUBLICATION_ABSENCE', 'ABSENCE_COMMIT',
  'CLEANUP_COMPLETE', 'E14',
] as const satisfies readonly GatewayPublicationCheckpoint[]);
const PRECONTACT_SEQUENCE = Object.freeze({
  INITIAL: 0, E03: 1, E05: 2, E07: 3, E09: 4, STOP: 5, E14: 6,
} as const);
const PUBLICATION_LEAF = Object.freeze({
  INITIAL: 'gateway-precontact-INITIAL.json',
  E03: 'gateway-precontact-E03.json',
  E05: 'gateway-precontact-E05.json',
  E07: 'gateway-precontact-E07.json',
  E09: 'gateway-precontact-E09.json',
  STOP: 'gateway-precontact-STOP.json',
  PARTICIPANT_ABSENCE: 'participant-absence.json',
  PUBLICATION_ABSENCE: 'publication-absence.json',
  ABSENCE_COMMIT: 'absence-commit.json',
  CLEANUP_COMPLETE: 'gateway-cleanup-complete.json',
  E14: 'gateway-precontact-E14.json',
} as const);

interface GatewayPrecontactCheckpointRequest {
  readonly schema: 'paos.precontact-checkpoint-request.v1';
  readonly run_id: string;
  readonly activation_attempt_id: string;
  readonly session_id: string;
  readonly checkpoint: Exclude<GatewayPrecontactCheckpoint, 'INITIAL'>;
  readonly sequence: number;
  readonly control_nonce_sha256: string;
  readonly firewall_leaf_name: string;
  readonly firewall_leaf_bytes: number;
  readonly firewall_leaf_sha256: string;
  readonly previous_gateway_witness_sha256: string;
  readonly requested_at_utc: string;
}
export interface GatewayPublicationPayload {
  readonly checkpoint: GatewayPublicationCheckpoint;
  readonly leafName: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}
function compactJsonBytes(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  if (text.length === 0 || text.normalize('NFC') !== text ||
      text.includes('\r') || text.includes('\u0000')) {
    throw new Error('GATEWAY_CANONICAL_JSON_INVALID');
  }
  return Buffer.from(text, 'utf8');
}
function assertClosedDataKeys(value: object, expected: readonly string[], code: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !Object.hasOwn(descriptor, 'value');
      })) throw new Error(code);
}
function parseCanonicalPipeObject(
  bytes: Uint8Array, maximum: number, expectedKeys: readonly string[], code: string,
): Record<string, unknown> {
  const raw = Buffer.from(bytes);
  const value = parseStrictJsonBytes(raw, maximum);
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(code);
  assertClosedDataKeys(value, expectedKeys, code);
  if (!Buffer.from(compactJsonBytes(value)).equals(raw)) throw new Error(code);
  return value as Record<string, unknown>;
}
function exactBase64(
  value: unknown, expectedBytes: number, expectedSha256: string, code: string,
): Buffer {
  if (typeof value !== 'string' || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      !isLowerSha256(expectedSha256, expectedBytes === 0)) throw new Error(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.byteLength !== expectedBytes ||
      createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error(code);
  return bytes;
}
function validateProofDocument(
  bytes: Buffer, expectedSha256: string, binding: SupervisedDeviceLanBinding,
  kind: 'participant' | 'publication', documents: SupervisedAbsenceProofDocuments,
): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256)
    throw new Error('SUPERVISED_PROOF_HASH_INVALID');
  const proof = parseStrictJsonBytes(bytes, 131_072);
  if (proof === null || Array.isArray(proof) || typeof proof !== 'object' ||
      !Buffer.from(compactJsonBytes(proof)).equals(bytes))
    throw new Error('SUPERVISED_PROOF_BINDING_INVALID');
  const value = proof as Record<string, unknown>;
  if (value.schema !== 'paos.' + kind + '-absence-proof.v1' ||
      value.run_id !== binding.firewallRunId ||
      value.activation_attempt_id !== binding.activationAttemptId ||
      value.session_id !== binding.sessionId || value.room_name !== binding.roomName ||
      value.device_id !== binding.deviceId ||
      value.participant_identity !== binding.participantIdentity ||
      value.provider !== 'livekit-rtc-node' ||
      (kind === 'publication' && (value.contact_observed !== documents.contactObserved ||
        value.publication_sid !== documents.publicationSid ||
        value.microphone_source !== 'microphone')))
    throw new Error('SUPERVISED_PROOF_BINDING_INVALID');
}

export interface GatewayPublicationBuffer {
  stageAbsenceProofs(documents: SupervisedAbsenceProofDocuments):
    Promise<SupervisedAbsenceProofCommitter>;
  persistCleanupReceipt(receipt: SupervisedCleanupReceipt): Promise<void>;
  payload(checkpoint: GatewayPublicationCheckpoint): GatewayPublicationPayload;
}
export function createGatewayPublicationBuffer(
  binding: SupervisedDeviceLanBinding,
): GatewayPublicationBuffer {
  let participant: GatewayPublicationPayload | undefined;
  let publication: GatewayPublicationPayload | undefined;
  let absenceCommit: GatewayPublicationPayload | undefined;
  let cleanup: GatewayPublicationPayload | undefined;
  let committedAtUtc: string | undefined;
  let committedDocuments: SupervisedAbsenceProofDocuments | undefined;
  const make = (
    checkpoint: GatewayPublicationCheckpoint, leafName: string, bytes: Uint8Array,
  ): GatewayPublicationPayload => {
    const frozen = Buffer.from(bytes);
    return Object.freeze({
      checkpoint, leafName, bytes: frozen,
      sha256: createHash('sha256').update(frozen).digest('hex'),
    });
  };
  return {
    async stageAbsenceProofs(documents) {
      if (participant || publication || absenceCommit ||
          !Number.isSafeInteger(documents.observationEpoch) || documents.observationEpoch < 0 ||
          !Number.isSafeInteger(documents.observationGeneration) ||
          documents.observationGeneration < 1)
        throw new Error('SUPERVISED_PROOF_BINDING_INVALID');
      const participantBytes = Buffer.from(documents.participantBytes);
      const publicationBytes = Buffer.from(documents.publicationBytes);
      validateProofDocument(participantBytes, documents.participantSha256, binding,
        'participant', documents);
      validateProofDocument(publicationBytes, documents.publicationSha256, binding,
        'publication', documents);
      const stagedParticipant = make('PARTICIPANT_ABSENCE',
        PUBLICATION_LEAF.PARTICIPANT_ABSENCE, participantBytes);
      const stagedPublication = make('PUBLICATION_ABSENCE',
        PUBLICATION_LEAF.PUBLICATION_ABSENCE, publicationBytes);
      let committed = false;
      return {
        async commit(atUtc) {
          if (committed) return;
          canonicalUtc(atUtc, 'SUPERVISED_ABSENCE_COMMIT_INVALID');
          const commitBytes = compactJsonBytes({
            receipt_type: 'phase0_absence_commit', version: 1,
            firewall_run_id: binding.firewallRunId,
            activation_attempt_id: binding.activationAttemptId,
            session_id: binding.sessionId, room_name: binding.roomName,
            device_id: binding.deviceId, participant_identity: binding.participantIdentity,
            provider: 'livekit-rtc-node', contact_observed: documents.contactObserved,
            publication_sid: documents.publicationSid,
            participant_staging_leaf_name: 'participant-absence.staging.json',
            participant_staging_bytes: stagedParticipant.bytes.byteLength,
            participant_staging_sha256: stagedParticipant.sha256,
            publication_staging_leaf_name: 'publication-absence.staging.json',
            publication_staging_bytes: stagedPublication.bytes.byteLength,
            publication_staging_sha256: stagedPublication.sha256,
            participant_leaf_name: stagedParticipant.leafName,
            participant_bytes: stagedParticipant.bytes.byteLength,
            participant_sha256: stagedParticipant.sha256,
            publication_leaf_name: stagedPublication.leafName,
            publication_bytes: stagedPublication.bytes.byteLength,
            publication_sha256: stagedPublication.sha256,
            observation_epoch: documents.observationEpoch,
            observation_generation: documents.observationGeneration,
            committed_at_utc: atUtc,
          });
          participant = stagedParticipant;
          publication = stagedPublication;
          absenceCommit = make('ABSENCE_COMMIT', PUBLICATION_LEAF.ABSENCE_COMMIT, commitBytes);
          committedDocuments = documents;
          committedAtUtc = atUtc;
          committed = true;
        },
      };
    },
    async persistCleanupReceipt(receipt) {
      if (!participant || !publication || !absenceCommit ||
          !committedDocuments || !committedAtUtc)
        throw new Error('SUPERVISED_CLEANUP_RECEIPT_BINDING_INVALID');
      assertClosedDataKeys(receipt, [
        'schema', 'run_id', 'activation_attempt_id', 'session_id', 'room_name', 'device_id',
        'participant_identity', 'provider', 'issuance_denied', 'contact_observed',
        'publication_sid', 'participant_absence_evidence_sha256',
        'publication_absence_evidence_sha256', 'gateway_disconnected', 'room_absent',
        'completed_at_utc',
      ], 'SUPERVISED_CLEANUP_RECEIPT_SCHEMA_INVALID');
      const completed = canonicalUtc(receipt.completed_at_utc,
        'SUPERVISED_CLEANUP_RECEIPT_BINDING_INVALID');
      if (receipt.schema !== 'paos.gateway-cleanup-complete.v1' ||
          receipt.run_id !== binding.firewallRunId ||
          receipt.activation_attempt_id !== binding.activationAttemptId ||
          receipt.session_id !== binding.sessionId || receipt.room_name !== binding.roomName ||
          receipt.device_id !== binding.deviceId ||
          receipt.participant_identity !== binding.participantIdentity ||
          receipt.provider !== 'livekit-rtc-node' || receipt.issuance_denied !== true ||
          receipt.contact_observed !== committedDocuments.contactObserved ||
          receipt.publication_sid !== committedDocuments.publicationSid ||
          receipt.participant_absence_evidence_sha256 !== participant.sha256 ||
          receipt.publication_absence_evidence_sha256 !== publication.sha256 ||
          receipt.gateway_disconnected !== true || receipt.room_absent !== true ||
          Date.parse(completed) < Date.parse(committedAtUtc) || Date.parse(completed) > Date.now())
        throw new Error('SUPERVISED_CLEANUP_RECEIPT_BINDING_INVALID');
      cleanup = make('CLEANUP_COMPLETE', PUBLICATION_LEAF.CLEANUP_COMPLETE,
        compactJsonBytes(receipt));
    },
    payload(checkpoint) {
      const selected = checkpoint === 'PARTICIPANT_ABSENCE' ? participant :
        checkpoint === 'PUBLICATION_ABSENCE' ? publication :
        checkpoint === 'ABSENCE_COMMIT' ? absenceCommit :
        checkpoint === 'CLEANUP_COMPLETE' ? cleanup : undefined;
      if (!selected) throw new Error('GATEWAY_PUBLICATION_NOT_READY');
      return Object.freeze({ ...selected, bytes: Buffer.from(selected.bytes) });
    },
  };
}

interface ParsedCheckpointRequest {
  readonly leafName: string; readonly bytes: number; readonly sha256: string;
  readonly document: GatewayPrecontactCheckpointRequest;
}
function parseCheckpointRequestBytes(
  bytes: Buffer, checkpoint: Exclude<GatewayPrecontactCheckpoint, 'INITIAL'>,
  expectedSequence: number, expectedPreviousWitnessSha256: string,
  binding: SupervisedDeviceLanBinding, controlNonceSha256: string,
): ParsedCheckpointRequest {
  const request = parseCanonicalPipeObject(bytes, 16_384, [
    'schema', 'run_id', 'activation_attempt_id', 'session_id', 'checkpoint', 'sequence',
    'control_nonce_sha256', 'firewall_leaf_name', 'firewall_leaf_bytes',
    'firewall_leaf_sha256', 'previous_gateway_witness_sha256', 'requested_at_utc',
  ], 'PRECONTACT_CHECKPOINT_REQUEST_INVALID') as unknown as GatewayPrecontactCheckpointRequest;
  const expectedFirewallLeaf = checkpoint === 'E03' ? 'E03-create-caddy.json' :
    checkpoint === 'E05' ? 'E05-create-livekit-tcp.json' :
    checkpoint === 'E07' ? 'E07-create-livekit-udp.json' :
    checkpoint === 'E09' || checkpoint === 'STOP' ? 'E09-ready-for-device-contact.json' :
    'E14-end.json';
  if (request.schema !== 'paos.precontact-checkpoint-request.v1' ||
      request.run_id !== binding.firewallRunId ||
      request.activation_attempt_id !== binding.activationAttemptId ||
      request.session_id !== binding.sessionId || request.checkpoint !== checkpoint ||
      request.sequence !== expectedSequence ||
      request.control_nonce_sha256 !== controlNonceSha256 ||
      request.firewall_leaf_name !== expectedFirewallLeaf ||
      !Number.isSafeInteger(request.firewall_leaf_bytes) || request.firewall_leaf_bytes < 2 ||
      !isLowerSha256(request.firewall_leaf_sha256) ||
      request.previous_gateway_witness_sha256 !== expectedPreviousWitnessSha256)
    throw new Error('PRECONTACT_CHECKPOINT_REQUEST_INVALID');
  canonicalUtc(request.requested_at_utc, 'PRECONTACT_CHECKPOINT_REQUEST_INVALID');
  return {
    leafName: 'precontact-request-' + checkpoint + '.json',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    document: request,
  };
}
export interface GatewayPrecontactWitnessProducer {
  produce(checkpoint: GatewayPrecontactCheckpoint, snapshot: GatewayPrecontactWitnessSnapshot,
    requestBytes: Buffer | null): GatewayPublicationPayload;
}
export function createGatewayPrecontactWitnessProducer(
  binding: SupervisedDeviceLanBinding, gatewayPid: number, controlNonceSha256: string,
): GatewayPrecontactWitnessProducer {
  if (!Number.isSafeInteger(gatewayPid) || gatewayPid < 1 || !isLowerSha256(controlNonceSha256))
    throw new Error('PRECONTACT_WITNESS_CONFIG_INVALID');
  let nextSequence = 0;
  let previousWitnessSha256: string | null = null;
  return {
    produce(checkpoint, snapshot, requestBytes) {
      const sequence = PRECONTACT_SEQUENCE[checkpoint];
      if (sequence !== nextSequence || snapshot.admission !== 'CLOSED_PRECONTACT' ||
          snapshot.never_opened !== true ||
          snapshot.gateway_internal_prearm_success_count !== 1 ||
          snapshot.route_attempt_count !== 0 || snapshot.adapter_call_count !== 0 ||
          snapshot.adapter_call_in_flight !== 0 || snapshot.signer_call_count !== 0 ||
          snapshot.signer_call_in_flight !== 0 || snapshot.materialized_success_count !== 0 ||
          snapshot.response_count !== 0 ||
          ((checkpoint === 'STOP' || checkpoint === 'E14') !== snapshot.stop_fenced))
        throw new Error('PRECONTACT_WITNESS_NOT_ZERO');
      const request = checkpoint === 'INITIAL' ? undefined :
        parseCheckpointRequestBytes(requestBytes ?? Buffer.alloc(0), checkpoint, sequence,
          previousWitnessSha256 ?? ZERO_SHA256, binding, controlNonceSha256);
      if ((checkpoint === 'INITIAL') !== (requestBytes === null))
        throw new Error('PRECONTACT_CHECKPOINT_REQUEST_INVALID');
      const bytes = Buffer.from(compactJsonBytes({
        schema: 'paos.gateway-precontact-witness.v1',
        run_id: binding.firewallRunId,
        activation_attempt_id: binding.activationAttemptId,
        session_id: binding.sessionId, room_name: binding.roomName,
        device_id: binding.deviceId, participant_identity: binding.participantIdentity,
        checkpoint, sequence, control_nonce_sha256: controlNonceSha256,
        request_leaf_name: request?.leafName ?? null,
        request_bytes: request?.bytes ?? null, request_sha256: request?.sha256 ?? null,
        firewall_leaf_name: request?.document.firewall_leaf_name ?? null,
        firewall_leaf_bytes: request?.document.firewall_leaf_bytes ?? null,
        firewall_leaf_sha256: request?.document.firewall_leaf_sha256 ?? null,
        previous_witness_sha256: previousWitnessSha256, ...snapshot,
        gateway_pid: gatewayPid, created_at_utc: new Date().toISOString(),
      }));
      const result = Object.freeze({
        checkpoint, leafName: PUBLICATION_LEAF[checkpoint], bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      previousWitnessSha256 = result.sha256;
      nextSequence += 1;
      return result;
    },
  };
}

export interface GatewayNodePipeTransport {
  readMessage(): Promise<Buffer>;
  writeMessage(bytes: Buffer): Promise<void>;
  close(): void;
}
function assertRetainedGatewayPipeConfig(bootstrap: GatewayNodePipeBootstrap): void {
  if (bootstrap.configFd < 0) return;
  const stats = fstatSync(bootstrap.configFd, { bigint: true });
  if (!stats.isFile() || stats.nlink !== 1n ||
      stats.size !== BigInt(bootstrap.configBytes.byteLength)) {
    throw new Error('GATEWAY_PIPE_CONFIG_IDENTITY_LOST');
  }
}
function gatewayProcessCreationUtc(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}
function createGatewayNamedPipeTransport(
  pipeName: string, maxWireBytes: number,
): Promise<GatewayNodePipeTransport> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({
      path: '\\\\.\\pipe\\' + pipeName, allowHalfOpen: false,
    });
    let buffer = Buffer.alloc(0);
    let closed = false;
    const waiting: Array<{ resolve(value: Buffer): void; reject(error: Error): void }> = [];
    const frames: Buffer[] = [];
    const fail = (error: Error): void => {
      closed = true;
      while (waiting.length > 0) waiting.shift()!.reject(error);
    };
    const extract = (): void => {
      while (buffer.byteLength > 0) {
        if (buffer[0] !== 0x7b) {
          fail(new Error('GATEWAY_PIPE_FRAME_INVALID')); socket.destroy(); return;
        }
        let inString = false;
        let escaped = false;
        let depth = 0;
        let end = -1;
        for (let index = 0; index < buffer.byteLength; index += 1) {
          const byte = buffer[index]!;
          if (inString) {
            if (escaped) escaped = false;
            else if (byte === 0x5c) escaped = true;
            else if (byte === 0x22) inString = false;
          } else if (byte === 0x22) inString = true;
          else if (byte === 0x7b || byte === 0x5b) depth += 1;
          else if (byte === 0x7d || byte === 0x5d) {
            depth -= 1;
            if (depth === 0) { end = index + 1; break; }
            if (depth < 0) break;
          }
        }
        if (end < 0) {
          if (buffer.byteLength > maxWireBytes) {
            fail(new Error('GATEWAY_PIPE_WIRE_LIMIT')); socket.destroy();
          }
          return;
        }
        const frame = Buffer.from(buffer.subarray(0, end));
        buffer = Buffer.from(buffer.subarray(end));
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(frame); else frames.push(frame);
      }
    };
    socket.once('connect', () => resolve({
      readMessage() {
        const frame = frames.shift();
        if (frame) return Promise.resolve(frame);
        if (closed) return Promise.reject(new Error('GATEWAY_PIPE_DISCONNECTED'));
        return new Promise<Buffer>((resolveRead, rejectRead) =>
          waiting.push({ resolve: resolveRead, reject: rejectRead }));
      },
      writeMessage(bytes) {
        if (closed || bytes.byteLength < 2 || bytes.byteLength > maxWireBytes)
          return Promise.reject(new Error('GATEWAY_PIPE_WRITE_STATE_INVALID'));
        return new Promise<void>((resolveWrite, rejectWrite) =>
          socket.write(bytes, (error) => error ? rejectWrite(error) : resolveWrite()));
      },
      close() { if (!closed) socket.end(); closed = true; },
    }));
    socket.on('data', (chunk) => {
      if (!closed) { buffer = Buffer.concat([buffer, chunk]); extract(); }
    });
    socket.once('error', (error) => {
      fail(new Error('GATEWAY_PIPE_IO:' + error.message)); reject(error);
    });
    socket.once('close', () => fail(new Error('GATEWAY_PIPE_DISCONNECTED')));
  });
}

const SERVER_HELLO_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id',
  'broker_pid','broker_creation_time_utc','broker_token_sid','broker_integrity_rid',
  'pipe_instance_id','challenge_hex','challenge_sha256','pipe_next_sequence',
  'pipe_previous_message_sha256','global_next_sequence','global_previous_message_sha256',
  'issued_at_utc',
]);
const CLIENT_HELLO_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
  'client_pid','client_creation_time_utc','broker_pid','broker_creation_time_utc',
  'pipe_instance_id','challenge_sha256','server_hello_sha256','pipe_next_sequence',
  'pipe_previous_message_sha256','global_next_sequence','global_previous_message_sha256',
]);
const HELLO_ACK_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
  'pipe_instance_id','challenge_sha256','client_hello_sha256','pipe_next_sequence',
  'pipe_previous_message_sha256','global_next_sequence','global_previous_message_sha256',
  'accepted','accepted_at_utc',
]);
const GATEWAY_REQUEST_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
  'pipe_instance_id','challenge_sha256','turn_challenge_hex','turn_challenge_sha256',
  'pipe_sequence','pipe_previous_message_sha256','checkpoint','outer_turn_bytes',
  'outer_turn_sha256','outer_turn_base64','request_leaf_name','request_bytes',
  'request_sha256','request_base64','sent_at_utc',
]);
const GATEWAY_RESPONSE_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
  'pipe_instance_id','challenge_sha256','request_sha256','turn_challenge_sha256',
  'pipe_sequence','pipe_previous_message_sha256','checkpoint','payload_bytes',
  'payload_sha256','payload_base64','sent_at_utc',
]);
const RESPONSE_ACK_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
  'pipe_instance_id','challenge_sha256','request_sha256','turn_challenge_sha256',
  'pipe_sequence','pipe_message_sha256','checkpoint','payload_bytes','payload_sha256',
  'outer_turn_sha256','outer_global_sequence','outer_global_message_sha256',
  'outer_commit_ack_sha256','committed','committed_at_utc',
]);
const FIN_KEYS = Object.freeze([
  'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
  'pipe_instance_id','challenge_sha256','publication_count','final_pipe_sequence',
  'final_pipe_message_sha256','final_global_sequence','final_global_message_sha256','sent_at_utc',
]);
const FIN_ACK_KEYS = Object.freeze([...FIN_KEYS, 'accepted', 'accepted_at_utc']);

function assertPipeCommon(
  value: Record<string, unknown>, messageType: string, config: GatewayNodePipeConfig,
): void {
  if (value.schema !== GATEWAY_NODE_PIPE_SCHEMA || value.message_type !== messageType ||
      value.version !== 1 || value.grant_id !== GATEWAY_NODE_PIPE_GRANT ||
      value.run_id !== config.run_id ||
      value.activation_attempt_id !== config.activation_attempt_id)
    throw new Error('GATEWAY_PIPE_' + messageType + '_BINDING_INVALID');
}
function parseOuterServerTurn(
  bytes: Buffer, expectedLeaf: string, minimumGlobal: number, expectedPrevious: string,
  config: GatewayNodePipeConfig,
): { readonly globalSequence: number; readonly sha256: string;
     readonly previousMessageSha256: string } {
  const turn = parseCanonicalPipeObject(bytes, 262_144, [
    'schema','message_type','version','grant_id','run_id','activation_attempt_id','client_role',
    'pipe_instance_id','challenge_sha256','turn_challenge_hex','turn_challenge_sha256',
    'pipe_sequence','pipe_previous_message_sha256','global_sequence',
    'global_previous_message_sha256','publication_class','leaf_name','issued_at_utc',
  ], 'GATEWAY_PIPE_OUTER_TURN_INVALID');
  if (typeof turn.schema !== 'string' || !/^paos\.[a-z0-9-]+\.v1$/.test(turn.schema) ||
      turn.message_type !== 'SERVER_TURN' || turn.version !== 1 ||
      turn.grant_id !== GATEWAY_NODE_PIPE_GRANT || turn.run_id !== config.run_id ||
      turn.activation_attempt_id !== config.activation_attempt_id ||
      typeof turn.turn_challenge_hex !== 'string' ||
      !/^[0-9a-f]{64}$/.test(turn.turn_challenge_hex) ||
      createHash('sha256').update(Buffer.from(turn.turn_challenge_hex, 'hex')).digest('hex') !==
        turn.turn_challenge_sha256 ||
      !Number.isSafeInteger(turn.pipe_sequence) || (turn.pipe_sequence as number) < 0 ||
      !isLowerSha256(turn.pipe_previous_message_sha256, true) ||
      !Number.isSafeInteger(turn.global_sequence) ||
      (turn.global_sequence as number) < minimumGlobal ||
      !isLowerSha256(turn.global_previous_message_sha256, true) ||
      ((turn.global_sequence as number) === minimumGlobal &&
        turn.global_previous_message_sha256 !== expectedPrevious) ||
      typeof turn.publication_class !== 'string' ||
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(turn.publication_class) ||
      turn.leaf_name !== expectedLeaf)
    throw new Error('GATEWAY_PIPE_OUTER_TURN_INVALID');
  canonicalUtc(turn.issued_at_utc, 'GATEWAY_PIPE_OUTER_TURN_INVALID');
  return {
    globalSequence: turn.global_sequence as number,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    previousMessageSha256: turn.global_previous_message_sha256 as string,
  };
}

export interface GatewayNodePipeSessionOptions {
  readonly transport: GatewayNodePipeTransport;
  readonly bootstrap: GatewayNodePipeBootstrap;
  readonly binding: SupervisedDeviceLanBinding;
  readonly witness: NoDevicePrecontactWitness;
  readonly witnessProducer: GatewayPrecontactWitnessProducer;
  readonly publications: GatewayPublicationBuffer;
  readonly gatewayPid: number;
  readonly clientCreationTimeUtc?: string;
  readonly stopSession: () => Promise<unknown>;
}
export async function runGatewayNodePipeSession(
  options: GatewayNodePipeSessionOptions,
): Promise<void> {
  const { transport, bootstrap, binding, witness, witnessProducer, publications } = options;
  const config = bootstrap.config;
  assertRetainedGatewayPipeConfig(bootstrap);
  const helloBytes = await transport.readMessage();
  const hello = parseCanonicalPipeObject(helloBytes, config.max_wire_bytes,
    SERVER_HELLO_KEYS, 'GATEWAY_PIPE_SERVER_HELLO_INVALID');
  assertPipeCommon(hello, 'SERVER_HELLO', config);
  const pipeInstanceId = hello.pipe_instance_id;
  const challengeHex = hello.challenge_hex;
  const globalNext = hello.global_next_sequence;
  const globalPrevious = hello.global_previous_message_sha256;
  if (hello.broker_pid !== config.broker_pid ||
      hello.broker_creation_time_utc !== config.broker_creation_time_utc ||
      hello.broker_token_sid !== config.broker_token_sid ||
      hello.broker_integrity_rid !== config.broker_integrity_rid ||
      typeof pipeInstanceId !== 'string' || !/^[0-9a-f]{32}$/.test(pipeInstanceId) ||
      typeof challengeHex !== 'string' || !/^[0-9a-f]{64}$/.test(challengeHex) ||
      createHash('sha256').update(Buffer.from(challengeHex, 'hex')).digest('hex') !==
        config.challenge_sha256 ||
      hello.challenge_sha256 !== config.challenge_sha256 ||
      hello.pipe_next_sequence !== 1 ||
      hello.pipe_previous_message_sha256 !== ZERO_SHA256 ||
      !Number.isSafeInteger(globalNext) || (globalNext as number) < 1 ||
      !isLowerSha256(globalPrevious, true))
    throw new Error('GATEWAY_PIPE_SERVER_HELLO_AUTHENTICATION_FAILED');
  canonicalUtc(hello.issued_at_utc, 'GATEWAY_PIPE_SERVER_HELLO_INVALID');
  const clientHello = {
    schema: GATEWAY_NODE_PIPE_SCHEMA, message_type: 'CLIENT_HELLO', version: 1,
    grant_id: GATEWAY_NODE_PIPE_GRANT, run_id: binding.firewallRunId,
    activation_attempt_id: binding.activationAttemptId, client_role: GATEWAY_NODE_PIPE_ROLE,
    client_pid: options.gatewayPid,
    client_creation_time_utc: options.clientCreationTimeUtc ?? gatewayProcessCreationUtc(),
    broker_pid: config.broker_pid, broker_creation_time_utc: config.broker_creation_time_utc,
    pipe_instance_id: pipeInstanceId, challenge_sha256: config.challenge_sha256,
    server_hello_sha256: createHash('sha256').update(helloBytes).digest('hex'),
    pipe_next_sequence: 1, pipe_previous_message_sha256: ZERO_SHA256,
    global_next_sequence: globalNext, global_previous_message_sha256: globalPrevious,
  };
  assertClosedDataKeys(clientHello, CLIENT_HELLO_KEYS, 'GATEWAY_PIPE_CLIENT_HELLO_INVALID');
  canonicalUtc(clientHello.client_creation_time_utc, 'GATEWAY_PIPE_CLIENT_HELLO_INVALID');
  const clientHelloBytes = Buffer.from(compactJsonBytes(clientHello));
  await transport.writeMessage(clientHelloBytes);
  const helloAck = parseCanonicalPipeObject(await transport.readMessage(),
    config.max_wire_bytes, HELLO_ACK_KEYS, 'GATEWAY_PIPE_HELLO_ACK_INVALID');
  assertPipeCommon(helloAck, 'HELLO_ACK', config);
  if (helloAck.client_role !== GATEWAY_NODE_PIPE_ROLE ||
      helloAck.pipe_instance_id !== pipeInstanceId ||
      helloAck.challenge_sha256 !== config.challenge_sha256 ||
      helloAck.client_hello_sha256 !==
        createHash('sha256').update(clientHelloBytes).digest('hex') ||
      helloAck.pipe_next_sequence !== 1 ||
      helloAck.pipe_previous_message_sha256 !== ZERO_SHA256 ||
      helloAck.global_next_sequence !== globalNext ||
      helloAck.global_previous_message_sha256 !== globalPrevious ||
      helloAck.accepted !== true) throw new Error('GATEWAY_PIPE_HELLO_ACK_INVALID');
  canonicalUtc(helloAck.accepted_at_utc, 'GATEWAY_PIPE_HELLO_ACK_INVALID');

  let pipeSequence = 1;
  let previousResponseSha256 = ZERO_SHA256;
  const globalFloor = globalNext as number;
  let lastGlobalSequence = globalFloor - 1;
  let lastGlobalMessageSha256 = globalPrevious as string;
  const seenChallenges = new Set<string>();
  const seenOuterPrevious = new Set<string>();
  for (const checkpoint of GATEWAY_PUBLICATION_SCHEDULE) {
    assertRetainedGatewayPipeConfig(bootstrap);
    const request = parseCanonicalPipeObject(await transport.readMessage(),
      config.max_wire_bytes, GATEWAY_REQUEST_KEYS, 'GATEWAY_PIPE_REQUEST_INVALID');
    assertPipeCommon(request, 'GATEWAY_REQUEST', config);
    const turnHex = request.turn_challenge_hex;
    const turnSha = request.turn_challenge_sha256;
    if (request.client_role !== GATEWAY_NODE_PIPE_ROLE ||
        request.pipe_instance_id !== pipeInstanceId ||
        request.challenge_sha256 !== config.challenge_sha256 ||
        typeof turnHex !== 'string' || !/^[0-9a-f]{64}$/.test(turnHex) ||
        createHash('sha256').update(Buffer.from(turnHex, 'hex')).digest('hex') !== turnSha ||
        !isLowerSha256(turnSha) || seenChallenges.has(turnSha) ||
        request.pipe_sequence !== pipeSequence ||
        request.pipe_previous_message_sha256 !== previousResponseSha256 ||
        request.checkpoint !== checkpoint || !Number.isSafeInteger(request.outer_turn_bytes) ||
        (request.outer_turn_bytes as number) < 2 || !isLowerSha256(request.outer_turn_sha256))
      throw new Error('GATEWAY_PIPE_REQUEST_INVALID');
    seenChallenges.add(turnSha);
    canonicalUtc(request.sent_at_utc, 'GATEWAY_PIPE_REQUEST_INVALID');
    const outerBytes = exactBase64(request.outer_turn_base64,
      request.outer_turn_bytes as number, request.outer_turn_sha256 as string,
      'GATEWAY_PIPE_OUTER_TURN_INVALID');
    const outer = parseOuterServerTurn(outerBytes, PUBLICATION_LEAF[checkpoint],
      Math.max(globalFloor, lastGlobalSequence + 1), lastGlobalMessageSha256, config);
    if (lastGlobalSequence >= globalFloor &&
        seenOuterPrevious.has(outer.previousMessageSha256))
      throw new Error('GATEWAY_PIPE_OUTER_GLOBAL_CHAIN_INVALID');
    seenOuterPrevious.add(outer.previousMessageSha256);

    const semantic = checkpoint !== 'INITIAL' &&
      checkpoint !== 'PARTICIPANT_ABSENCE' && checkpoint !== 'PUBLICATION_ABSENCE' &&
      checkpoint !== 'ABSENCE_COMMIT' && checkpoint !== 'CLEANUP_COMPLETE';
    let requestBytes: Buffer | null = null;
    if (semantic) {
      if (request.request_leaf_name !== 'precontact-request-' + checkpoint + '.json' ||
          !Number.isSafeInteger(request.request_bytes) ||
          (request.request_bytes as number) < 2 || !isLowerSha256(request.request_sha256))
        throw new Error('GATEWAY_PIPE_REQUEST_INVALID');
      requestBytes = exactBase64(request.request_base64, request.request_bytes as number,
        request.request_sha256 as string, 'GATEWAY_PIPE_REQUEST_INVALID');
    } else if (request.request_leaf_name !== null || request.request_bytes !== 0 ||
        request.request_sha256 !== null || request.request_base64 !== null)
      throw new Error('GATEWAY_PIPE_REQUEST_INVALID');

    if (checkpoint === 'STOP') {
      witness.fenceForStop();
      await options.stopSession();
    }
    const produced = checkpoint === 'INITIAL' || checkpoint === 'E03' ||
      checkpoint === 'E05' || checkpoint === 'E07' || checkpoint === 'E09' ||
      checkpoint === 'STOP' || checkpoint === 'E14'
      ? witnessProducer.produce(checkpoint, witness.snapshot(), requestBytes)
      : publications.payload(checkpoint);
    if (produced.checkpoint !== checkpoint ||
        produced.leafName !== PUBLICATION_LEAF[checkpoint] ||
        produced.bytes.byteLength > config.max_payload_bytes ||
        createHash('sha256').update(produced.bytes).digest('hex') !== produced.sha256)
      throw new Error('GATEWAY_PIPE_PAYLOAD_INVALID');
    const response = {
      schema: GATEWAY_NODE_PIPE_SCHEMA, message_type: 'GATEWAY_RESPONSE', version: 1,
      grant_id: GATEWAY_NODE_PIPE_GRANT, run_id: binding.firewallRunId,
      activation_attempt_id: binding.activationAttemptId, client_role: GATEWAY_NODE_PIPE_ROLE,
      pipe_instance_id: pipeInstanceId, challenge_sha256: config.challenge_sha256,
      request_sha256: request.request_sha256, turn_challenge_sha256: turnSha,
      pipe_sequence: pipeSequence, pipe_previous_message_sha256: previousResponseSha256,
      checkpoint, payload_bytes: produced.bytes.byteLength, payload_sha256: produced.sha256,
      payload_base64: produced.bytes.toString('base64'), sent_at_utc: new Date().toISOString(),
    };
    assertClosedDataKeys(response, GATEWAY_RESPONSE_KEYS, 'GATEWAY_PIPE_RESPONSE_INVALID');
    const responseBytes = Buffer.from(compactJsonBytes(response));
    await transport.writeMessage(responseBytes);
    const responseSha = createHash('sha256').update(responseBytes).digest('hex');
    const ack = parseCanonicalPipeObject(await transport.readMessage(),
      config.max_wire_bytes, RESPONSE_ACK_KEYS, 'GATEWAY_PIPE_RESPONSE_ACK_INVALID');
    assertPipeCommon(ack, 'RESPONSE_ACK', config);
    if (ack.client_role !== GATEWAY_NODE_PIPE_ROLE ||
        ack.pipe_instance_id !== pipeInstanceId ||
        ack.challenge_sha256 !== config.challenge_sha256 ||
        ack.request_sha256 !== request.request_sha256 ||
        ack.turn_challenge_sha256 !== turnSha || ack.pipe_sequence !== pipeSequence ||
        ack.pipe_message_sha256 !== responseSha || ack.checkpoint !== checkpoint ||
        ack.payload_bytes !== produced.bytes.byteLength ||
        ack.payload_sha256 !== produced.sha256 ||
        ack.outer_turn_sha256 !== outer.sha256 ||
        ack.outer_global_sequence !== outer.globalSequence ||
        !isLowerSha256(ack.outer_global_message_sha256) ||
        !isLowerSha256(ack.outer_commit_ack_sha256) || ack.committed !== true)
      throw new Error('GATEWAY_PIPE_RESPONSE_ACK_INVALID');
    canonicalUtc(ack.committed_at_utc, 'GATEWAY_PIPE_RESPONSE_ACK_INVALID');
    previousResponseSha256 = responseSha;
    pipeSequence += 1;
    lastGlobalSequence = ack.outer_global_sequence as number;
    lastGlobalMessageSha256 = ack.outer_global_message_sha256 as string;
  }
  const fin = {
    schema: GATEWAY_NODE_PIPE_SCHEMA, message_type: 'FIN', version: 1,
    grant_id: GATEWAY_NODE_PIPE_GRANT, run_id: binding.firewallRunId,
    activation_attempt_id: binding.activationAttemptId, client_role: GATEWAY_NODE_PIPE_ROLE,
    pipe_instance_id: pipeInstanceId, challenge_sha256: config.challenge_sha256,
    publication_count: 11, final_pipe_sequence: 11,
    final_pipe_message_sha256: previousResponseSha256,
    final_global_sequence: lastGlobalSequence,
    final_global_message_sha256: lastGlobalMessageSha256,
    sent_at_utc: new Date().toISOString(),
  };
  assertClosedDataKeys(fin, FIN_KEYS, 'GATEWAY_PIPE_FIN_INVALID');
  await transport.writeMessage(Buffer.from(compactJsonBytes(fin)));
  const finAck = parseCanonicalPipeObject(await transport.readMessage(),
    config.max_wire_bytes, FIN_ACK_KEYS, 'GATEWAY_PIPE_FIN_ACK_INVALID');
  assertPipeCommon(finAck, 'FIN_ACK', config);
  for (const key of FIN_KEYS.slice(6)) {
    if (finAck[key] !== (fin as Record<string, unknown>)[key])
      throw new Error('GATEWAY_PIPE_FIN_ACK_INVALID');
  }
  if (finAck.accepted !== true) throw new Error('GATEWAY_PIPE_FIN_ACK_INVALID');
  canonicalUtc(finAck.accepted_at_utc, 'GATEWAY_PIPE_FIN_ACK_INVALID');
  transport.close();
}

export function constantTimeProxyAttestationEqual(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function rawHeaderValues(rawHeaders: readonly string[], expectedName: string): readonly string[] {
  if (rawHeaders.length % 2 !== 0) throw new Error('DEVICE_LAN_REQUEST_DENIED');
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === expectedName) {
      values.push(rawHeaders[index + 1]!);
    }
  }
  return values;
}

function exactRawHeader(request: DeviceLanRequestMetadata, name: string, expected: string): void {
  const values = rawHeaderValues(request.rawHeaders, name);
  if (values.length !== 1 || values[0]!.includes(',') || values[0] !== expected) {
    throw new Error('DEVICE_LAN_REQUEST_DENIED');
  }
}

function classifyDeviceLanRoute(request: DeviceLanRequestMetadata): AuthorizedDeviceLanRoute {
  if (request.method !== 'POST') throw new Error('DEVICE_LAN_REQUEST_DENIED');
  if (request.url === '/connection-details') return { kind: 'connection-details' };
  const stop = /^\/sessions\/(phase0_session_[a-f0-9]{20})\/stop$/u.exec(request.url ?? '');
  if (stop) return { kind: 'stop-session', roomName: stop[1]! };
  throw new Error('DEVICE_LAN_REQUEST_DENIED');
}

export function authorizeDeviceLanRequest(
  request: DeviceLanRequestMetadata,
  security: DeviceLanSecurityConfig,
): AuthorizedDeviceLanRoute {
  const route = classifyDeviceLanRoute(request);
  if (request.remoteAddress !== HOST) throw new Error('DEVICE_LAN_REQUEST_DENIED');

  const rawHeaderNames = request.rawHeaders
    .filter((_, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
  if (FORBIDDEN_DEVICE_HEADERS.some((name) => rawHeaderNames.includes(name))) {
    throw new Error('DEVICE_LAN_REQUEST_DENIED');
  }
  for (const name of REQUIRED_DEVICE_HEADERS) {
    if (rawHeaderValues(request.rawHeaders, name).length !== 1) {
      throw new Error('DEVICE_LAN_REQUEST_DENIED');
    }
  }

  exactRawHeader(request, 'host', security.publicHost);
  exactRawHeader(request, 'origin', security.publicOrigin);
  exactRawHeader(request, 'x-forwarded-for', security.iphoneIpv4);
  exactRawHeader(request, 'x-forwarded-host', security.publicHost);
  exactRawHeader(request, 'x-forwarded-proto', 'https');

  const attestations = rawHeaderValues(request.rawHeaders, PROXY_ATTESTATION_HEADER);
  if (
    attestations.length !== 1 ||
    attestations[0]!.includes(',') ||
    !constantTimeProxyAttestationEqual(attestations[0]!, security.proxyAttestationSecret)
  ) {
    throw new Error('DEVICE_LAN_REQUEST_DENIED');
  }
  if (route.kind === 'connection-details') {
    exactRawHeader(request, 'content-type', 'application/json');
  } else {
    if (
      rawHeaderValues(request.rawHeaders, 'content-type').length !== 0 ||
      rawHeaderValues(request.rawHeaders, 'transfer-encoding').length !== 0
    ) {
      throw new Error('DEVICE_LAN_REQUEST_DENIED');
    }
    const contentLengths = rawHeaderValues(request.rawHeaders, 'content-length');
    if (contentLengths.length > 1 || (contentLengths.length === 1 && contentLengths[0] !== '0')) {
      throw new Error('DEVICE_LAN_REQUEST_DENIED');
    }
  }
  return route;
}

function isDeviceLanCandidate(rawTarget: string): boolean {
  return rawTarget.startsWith('/connection-details');
}

function publicStopRoom(rawTarget: string): string | undefined {
  return /^\/sessions\/(phase0_session_[a-f0-9]{20})\/stop$/u.exec(rawTarget)?.[1];
}

export function isRoamingPublicRequest(request: Pick<IncomingMessage, 'rawHeaders'>, publicHost = new URL(configuredPublicApiOrigin()).host): boolean {
  const hosts = rawHeaderValues(request.rawHeaders, 'host');
  return hosts.length === 1 && hosts[0] === publicHost;
}

/** Transport-only loopback check retained for local diagnostics and tests.
 * This check does not establish a pairing or owner identity. */
export function isGateALocalDeviceRequest(
  request: Pick<IncomingMessage, 'rawHeaders' | 'socket'>,
): boolean {
  if (request.socket.remoteAddress !== HOST) return false;
  const hosts = rawHeaderValues(request.rawHeaders, 'host');
  if (hosts.length !== 1 || hosts[0] !== `${HOST}:${PORT}`) return false;
  if (rawHeaderValues(request.rawHeaders, 'origin').length !== 0) return false;
  return !request.rawHeaders.some((value, index) => {
    if (index % 2 === 0) {
      const name = value.toLowerCase();
      return name.startsWith('x-forwarded-') || name === 'x-paios-proxy-attestation' ||
        name === 'x-paios-trusted-edge' || name === 'x-paios-trusted-source-family' ||
        name.startsWith('x-paios-iphone-') || name === 'forwarded' || name === 'x-real-ip';
    }
    return false;
  });
}

// Legacy device-LAN URL predicate; cloud endpoints come from product resources.
export function isGateALocalDeviceLiveKitUrl(value: string | undefined): boolean {
  return value === 'ws://127.0.0.1:7880' || value === requiredEnvironment(process.env, 'PAIOS_RAYNEO_LIVEKIT_URL');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
  });
  response.end(encoded);
}

function sendError(response: ServerResponse, status: number, code: string): void {
  sendJson(response, status, { error: code });
}

function requestOriginAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === REACT_ORIGIN || origin === SELF_ORIGIN;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error('DEVICE_LAN_REQUEST_DENIED');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readBoundedRayneoBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const lengths = rawHeaderValues(request.rawHeaders, 'content-length');
  if (lengths.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(lengths[0]!)) {
    throw new Error('RAYNEO_BODY_INCOMPLETE');
  }
  const expectedBytes = Number(lengths[0]);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximumBytes) {
    throw new Error('RAYNEO_BODY_LIMIT_EXCEEDED');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let aborted = request.aborted;
  const markAborted = (): void => { aborted = true; };
  request.once('aborted', markAborted);
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maximumBytes) throw new Error('RAYNEO_BODY_LIMIT_EXCEEDED');
      chunks.push(bytes);
    }
  } finally {
    request.off('aborted', markAborted);
  }
  if (aborted || length !== expectedBytes) throw new Error('RAYNEO_BODY_INCOMPLETE');
  return Buffer.concat(chunks);
}

/**
 * Non-secret metadata published only after the signed debug bootstrap has
 * completed. Owner-specific connection, epoch, lease, and alias fields are
 * deliberately not copied from the wire response.
 */
export interface RayneoDebugLocalBootstrapPublication {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly observedAt: string;
}

function ownerProducerTarget(rawTarget: string): 'events' | 'handoffs' | 'rayneo-joins' | undefined {
  if (rawTarget === '/phase0/demo/v1/events') return 'events';
  if (rawTarget === '/phase0/demo/v1/handoffs') return 'handoffs';
  if (rawTarget === '/phase0/demo/v1/rayneo-joins') return 'rayneo-joins';
  return undefined;
}

async function authorizeOwnerProducer(
  request: IncomingMessage,
  security: DeviceLanSecurityConfig,
  gateway: GatewayConfig,
  adapter: Pick<DeviceSessionAdapter, 'deviceLanIssuanceSnapshot' | 'sessionExists'>,
): Promise<Phase0OwnerAuthenticatedIphone> {
  if (request.method !== 'POST' || request.socket.remoteAddress !== HOST) throw new Error('DEVICE_ORIGIN_MISMATCH');
  const metadata: DeviceLanRequestMetadata = {
    method: request.method, url: request.url, remoteAddress: request.socket.remoteAddress, rawHeaders: request.rawHeaders,
  };
  let sessionId: string;
  let deviceId: string;
  let clientInstanceId: string;
  let credentialId: string;
  try {
    const rawHeaderNames = request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    if (FORBIDDEN_DEVICE_HEADERS.some((name) => rawHeaderNames.includes(name))) throw new Error('DEVICE_ORIGIN_MISMATCH');
    for (const name of REQUIRED_DEVICE_HEADERS) {
      if (rawHeaderValues(request.rawHeaders, name).length !== 1) throw new Error('DEVICE_ORIGIN_MISMATCH');
    }
    exactRawHeader(metadata, 'host', security.publicHost);
    exactRawHeader(metadata, 'origin', security.publicOrigin);
    exactRawHeader(metadata, 'x-forwarded-for', security.iphoneIpv4);
    exactRawHeader(metadata, 'x-forwarded-host', security.publicHost);
    exactRawHeader(metadata, 'x-forwarded-proto', 'https');
    exactRawHeader(metadata, 'content-type', 'application/json');
    const attestations = rawHeaderValues(request.rawHeaders, PROXY_ATTESTATION_HEADER);
    if (attestations.length !== 1 || attestations[0]!.includes(',') ||
      !constantTimeProxyAttestationEqual(attestations[0]!, security.proxyAttestationSecret)) {
      throw new Error('DEVICE_ORIGIN_MISMATCH');
    }
    const oneOrigin = (name: string, pattern: RegExp): string => {
      const values = rawHeaderValues(request.rawHeaders, name);
      if (values.length !== 1 || values[0]!.includes(',') || !pattern.test(values[0]!)) {
        throw new Error('DEVICE_ORIGIN_MISMATCH');
      }
      return values[0]!;
    };
    sessionId = oneOrigin('x-paios-session-id', /^[a-z][a-z0-9_-]{2,63}$/u);
    deviceId = oneOrigin('x-paios-device-id', /^[a-z][a-z0-9_-]{2,63}$/u);
    clientInstanceId = oneOrigin('x-paios-client-instance-id', /^[a-z][a-z0-9_-]{2,63}$/u);
    credentialId = oneOrigin('x-paios-credential-id', /^[a-z][a-z0-9_-]{2,63}$/u);
  } catch {
    throw new Error('DEVICE_ORIGIN_MISMATCH');
  }
  const authorizationValues = rawHeaderValues(request.rawHeaders, 'authorization');
  const authorization = authorizationValues[0];
  if (
    authorizationValues.length !== 1 || authorization === undefined || authorization.includes(',') ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(authorization) ||
    authorization.length < 87 || authorization.length > 2_055
  ) throw new Error('CAPABILITY_INVALID');
  const token = authorization.slice(7);
  let claims;
  try { claims = await new TokenVerifier(gateway.apiKey, gateway.apiSecret).verify(token, 0); }
  catch { throw new Error('CAPABILITY_INVALID'); }
  const issuance = adapter.deviceLanIssuanceSnapshot();
  if (
    !issuance || !['ISSUED', 'ACTIVE'].includes(issuance.state) ||
    typeof issuance.roomName !== 'string' || typeof issuance.deviceId !== 'string' ||
    typeof issuance.clientInstanceId !== 'string' || typeof issuance.runId !== 'string' ||
    !adapter.sessionExists(issuance.roomName)
  ) throw new Error('CAPABILITY_INVALID');
  const attributes = claims.attributes ?? {};
  const video = claims.video;
  if (
    Object.keys(attributes).sort().join(',') !== 'client_instance_id,device_class,device_id,run_id,schema_version' ||
    claims.sub !== issuance.deviceId || claims.name !== 'user' ||
    attributes.schema_version !== CONTRACT_SCHEMA_VERSION_V0_3 ||
    attributes.device_id !== issuance.deviceId || attributes.device_class !== 'web_mobile' ||
    attributes.client_instance_id !== issuance.clientInstanceId || attributes.run_id !== issuance.runId ||
    video === undefined ||
    Object.keys(video).sort().join(',') !== 'canPublish,canPublishData,canPublishSources,canSubscribe,room,roomJoin' ||
    video.room !== issuance.roomName || video.roomJoin !== true || video.canPublish !== true ||
    video.canPublishData !== false || video.canSubscribe !== true ||
    !Array.isArray(video.canPublishSources) || video.canPublishSources.length !== 1 ||
    String(video.canPublishSources[0]) !== 'microphone'
  ) throw new Error('CAPABILITY_INVALID');
  if (
    sessionId !== issuance.roomName || deviceId !== issuance.deviceId ||
    clientInstanceId !== issuance.clientInstanceId
  ) throw new Error('DEVICE_ORIGIN_MISMATCH');
  return Object.freeze({
    sessionId, deviceId, clientInstanceId,
    credentialId,
    capabilitySha256: createHash('sha256').update(token, 'ascii').digest('hex'),
    sourceIpv4: security.iphoneIpv4,
  });
}

function ownerHttpError(error: unknown): Readonly<{ status: number; code: string }> {
  const code = error instanceof Error ? error.message.split(':', 1)[0]! : 'INTERNAL_ERROR';
  if (code === 'HANDOFF_LATENCY_EXCEEDED') {
    return Object.freeze({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
  }
  if (code === 'PAIRING_REGISTRY_UNAVAILABLE' || code === 'SESSION_REPLACEMENT_UNCERTAIN') {
    return Object.freeze({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
  }
  const status = code === 'DEVICE_ORIGIN_MISMATCH' || code === 'PAIRING_REVOKED' || code === 'DEVICE_NOT_PAIRED' ? 403
    : code === 'SESSION_NOT_FOUND' || code === 'ELIGIBLE_SHARED_SESSION_NOT_FOUND' ? 404
      : code === 'SESSION_TERMINAL' ? 410
        : code === 'IDEMPOTENCY_CONFLICT' || code === 'STALE_ACTIVE_DEVICE_LEASE' ||
          code === 'ELIGIBLE_SHARED_SESSION_AMBIGUOUS' ? 409
          : code === 'CONTRACT_REJECTED' ? 422
            : 500;
  return Object.freeze({ status, code: status === 500 ? 'INTERNAL_ERROR' : code });
}

export function createGatewayServer(
  config: GatewayRuntimeConfig,
  adapter = new DeviceSessionAdapter(config.gateway),
  precontactWitness = config.precontactAdmission === 'CLOSED_PRECONTACT'
    ? new NoDevicePrecontactWitness()
    : undefined,
  rayneoVisual?: undefined,
  rayneoProduct?: undefined,
  options: Readonly<{
    persistentPublicOnly?: boolean;
    listenerHostHeader?: string;
    publicHostHeader?: string;
    /** V2-only host mode: expose only the injected successor controller. */
    v2Only?: boolean;
    localDeviceLoopback?: boolean;
    localDeviceProxyAttestationSecret?: string;
    publicRtcControl?: RealtimePublicControlController;
    /** Optional owner callback after a successful signed debug bootstrap. */
    onDebugLocalBootstrapPublished?: (publication: RayneoDebugLocalBootstrapPublication) => void | Promise<void>;
    /** Clears the owner projection after a successful Stop or server close. */
    onDebugLocalBootstrapCleared?: () => void | Promise<void>;
    localDeviceEnvironment?: Readonly<Partial<Pick<NodeJS.ProcessEnv,
      'PAIOS_DEMO_ROAMING' | 'PAIOS_GATE_A_LOCAL_DEVICE'>>>;
  }> = {},
) {
  const localDeviceLoopback = options.localDeviceLoopback === true &&
    options.localDeviceEnvironment?.PAIOS_DEMO_ROAMING === '1' &&
    options.localDeviceEnvironment?.PAIOS_GATE_A_LOCAL_DEVICE === '1';
  return createServer(async (request, response) => {
      try {
        const rawTarget = request.url ?? '/';

      if (options.publicRtcControl?.matches(request.method, rawTarget)) {
        await options.publicRtcControl.handle(request, response);
        return;
      }
      if (options.v2Only) {
        const localUrl = new URL(rawTarget, SELF_ORIGIN);
        if (request.method === 'GET' && request.headers.host === (options.listenerHostHeader ?? `${HOST}:${PORT}`) &&
            localUrl.pathname === '/healthz' && localUrl.search === '' && localUrl.hash === '') {
          sendJson(response, 200, { status: 'ok', mode: 'v2-only' });
        } else {
          sendError(response, 404, 'ROUTE_NOT_FOUND');
        }
        return;
      }
      if (isRoamingPublicRequest(request, options.publicHostHeader ?? config.deviceLanSecurity.publicHost)) {
        sendError(response, 404, 'ROUTE_NOT_FOUND');
        return;
      }
      if (options.persistentPublicOnly) {
        const localUrl = new URL(rawTarget, SELF_ORIGIN);
        if (request.method === 'GET' && request.headers.host === (options.listenerHostHeader ?? `${HOST}:${PORT}`) && localUrl.pathname === '/healthz' &&
          localUrl.search === '' && localUrl.hash === '') {
          sendJson(response, 200, { status: 'ok', activeSessions: adapter.activeSessionIds() });
        } else {
          sendError(response, 404, 'ROUTE_NOT_FOUND');
        }
        return;
      }
      const stopRoom = publicStopRoom(rawTarget);
      if (stopRoom !== undefined && request.method === 'POST') {
        const route = authorizeDeviceLanRequest(
          {
            method: request.method,
            url: request.url,
            remoteAddress: request.socket.remoteAddress,
            rawHeaders: request.rawHeaders,
          },
          config.deviceLanSecurity,
        );
        if (route.kind !== 'stop-session' || route.roomName !== stopRoom) {
          throw new Error('DEVICE_LAN_REQUEST_DENIED');
        }
        const body = await readRequestBody(request);
        if (body.byteLength !== 0) throw new Error('DEVICE_LAN_REQUEST_DENIED');
        if (config.precontactAdmission !== 'OPEN_NORMAL') {
          precontactWitness?.recordRouteAttempt();
          throw new Error('DEVICE_LAN_PRECONTACT_CLOSED');
        }

        const snapshot = adapter.deviceLanIssuanceSnapshot();
        if (snapshot === undefined || snapshot.roomName !== stopRoom) {
          sendError(response, 404, 'SESSION_NOT_FOUND');
          return;
        }
        if (snapshot.state === 'REVOKING') {
          sendError(response, 409, 'SESSION_STOP_IN_PROGRESS');
          return;
        }
        if (snapshot.state === 'REVOKED') {
          if (Number.isFinite(snapshot.roomAbsenceVerifiedAt) && !adapter.sessionExists(stopRoom)) {
            sendError(response, 410, 'SESSION_CLEANED');
          } else {
            sendError(response, 503, 'SESSION_STOP_UNAVAILABLE');
          }
          return;
        }
        if (snapshot.state !== 'ISSUED' && snapshot.state !== 'ACTIVE') {
          sendError(response, 503, 'SESSION_STOP_UNAVAILABLE');
          return;
        }
        if (!Number.isSafeInteger(snapshot.deadlineAt)) {
          sendError(response, 503, 'SESSION_STOP_UNAVAILABLE');
          return;
        }
        if (Date.now() >= snapshot.deadlineAt!) {
          sendError(response, 410, 'SESSION_STALE');
          return;
        }
        if (!adapter.sessionExists(stopRoom)) {
          sendError(response, 503, 'SESSION_STOP_UNAVAILABLE');
          return;
        }

        const cleanup = adapter.stopSession(stopRoom, 'user_stop', 'user_stop');
        await cleanup;
        const completed = adapter.deviceLanIssuanceSnapshot();
        if (
          completed?.state !== 'REVOKED' ||
          completed.roomName !== stopRoom ||
          !Number.isFinite(completed.roomAbsenceVerifiedAt) ||
          adapter.sessionExists(stopRoom)
        ) {
          throw new Error('SESSION_STOP_POSTCHECK_FAILED');
        }
        sendJson(response, 200, { status: 'cleanup_complete' });
        return;
      }
      if (isDeviceLanCandidate(rawTarget)) {
        precontactWitness?.recordRouteAttempt();
        precontactWitness?.denyAtRouteBoundary();
        const route = authorizeDeviceLanRequest(
          {
            method: request.method,
            url: request.url,
            remoteAddress: request.socket.remoteAddress,
            rawHeaders: request.rawHeaders,
          },
          config.deviceLanSecurity,
        );
        const body = await readRequestBody(request);
        if (!body.equals(Buffer.from('{}'))) {
          throw new Error('DEVICE_LAN_REQUEST_DENIED');
        }
        const abortController = new AbortController();
        const abortIssuance = (): void => abortController.abort();
        const abortOnPrematureResponseClose = (): void => {
          if (!response.writableEnded) abortController.abort();
        };
        request.once('aborted', abortIssuance);
        response.once('close', abortOnPrematureResponseClose);
        let details;
        let settleAdapterCall: (() => void) | undefined;
        try {
          settleAdapterCall = precontactWitness?.enterAdapterCall();
          details = await adapter.createConnectionDetails({}, { signal: abortController.signal });
        } finally {
          settleAdapterCall?.();
          request.off('aborted', abortIssuance);
          response.off('close', abortOnPrematureResponseClose);
        }
        precontactWitness?.recordResponse();
        sendJson(response, 200, {
          serverUrl: details.serverUrl,
          roomName: details.roomName,
          participantName: details.participantName,
          participantToken: details.participantToken,
        });
        return;
      }
      if (request.headers.host === config.deviceLanSecurity.publicHost) {
        sendError(response, 404, 'ROUTE_NOT_FOUND');
        return;
      }

      if (request.headers.host !== `${HOST}:${PORT}`) {
        sendError(response, 421, 'LOOPBACK_HOST_REQUIRED');
        return;
      }
      if (!requestOriginAllowed(request)) {
        sendError(response, 403, 'ORIGIN_REJECTED');
        return;
      }
      const url = new URL(rawTarget, SELF_ORIGIN);

      if (request.method === 'GET' && url.pathname === '/healthz') {
        const activeSessions = adapter.activeSessionIds();
        sendJson(response, 200, {
          status: 'ok',
          activeSessions,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(18).toString('base64url');
        const body = renderDashboard(nonce);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        response.end(body);
        return;
      }
      const projectedEvents = /^\/phase0\/demo\/v1\/sessions\/([a-z][a-z0-9_-]{2,63})\/events$/u.exec(url.pathname);
      if (request.method === 'GET' && (url.pathname === '/events' || projectedEvents)) {
        const sessionId = projectedEvents?.[1] ?? url.searchParams.get('session_id') ?? '';
        if (!/^[a-z][a-z0-9_-]{2,63}$/.test(sessionId) || !adapter.sessionExists(sessionId)) {
          sendError(response, 404, 'SESSION_NOT_FOUND');
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(': connected\n\n');
        const unsubscribe = adapter.subscribe(sessionId, (item) => {
          response.write(`data: ${JSON.stringify(item)}\n\n`);
        });
        request.once('close', unsubscribe);
        return;
      }
      sendError(response, 404, 'ROUTE_NOT_FOUND');
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      const code = error instanceof Error ? error.message.split(':', 1)[0]! : 'INTERNAL_ERROR';
      if (code === 'DEVICE_LAN_PRECONTACT_CLOSED') {
        sendError(response, 503, 'DEVICE_LAN_PRECONTACT_CLOSED');
        return;
      }
      if (code === 'DEVICE_LAN_REQUEST_DENIED') {
        sendError(response, 403, 'DEVICE_LAN_REQUEST_DENIED');
        return;
      }
      const safeCodes = new Set([
        'SESSION_NOT_FOUND',
        'SESSION_CLEANED',
        'SESSION_STOP_IN_PROGRESS',
        'SESSION_STALE',
        'SESSION_STOP_UNAVAILABLE',
      ]);
      const status =
        code === 'SESSION_NOT_FOUND'
          ? 404
          : code === 'SESSION_CLEANED'
            ? 410
            : code === 'SESSION_STOP_IN_PROGRESS'
              ? 409
              : code === 'SESSION_STALE'
                ? 410
                : code === 'SESSION_STOP_UNAVAILABLE'
                  ? 503
              : 500;
      sendError(response, status, safeCodes.has(code) ? code : 'INTERNAL_ERROR');
    }
  });
}

const RAYNEO_DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const RAYNEO_PROVIDER_KEEP_ALIVE = '45m';
const RAYNEO_PROVIDER_REFRESH_MS = 1_800_000;
export const RAYNEO_PRODUCT_MODEL = 'paios-qwen3.6-27b-vision:4k-v1';
const RAYNEO_PRODUCT_MODEL_DIGEST = '783fc08609c8b9093f449dcf21992b7b4f51eb76ce1358cf9bdd1bb95aab6d1f';
export const RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND = 'openai-compatible';
export const RAYNEO_DEBUG_LOCAL_PROVIDER_MODEL = QWEN38_PROVIDER_MODEL;
export const RAYNEO_DEBUG_LOCAL_PROVIDER_ENDPOINT = QWEN38_PROVIDER_ENDPOINT;
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_BACKEND = 'ollama';
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL = 'qwen3.8:27b';
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT = 'http://127.0.0.1:11435';
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_DIGEST =
  '22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643';
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_SIZE_BYTES = 17_536_070_449;
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_VRAM_BYTES = 17_536_070_449;
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_CONTEXT_LENGTH = 32_768;
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_KEEP_ALIVE = '24h';
export const RAYNEO_DEBUG_OLLAMA_PROVIDER_CAPABILITIES = Object.freeze([
  'completion', 'vision', 'tools', 'thinking',
] as const);
const RAYNEO_DEBUG_OLLAMA_PROVIDER_RESIDENCY_MS = 86_400_000;
const RAYNEO_PROVIDER_BACKEND_ENVIRONMENT = 'PAIOS_RAYNEO_PROVIDER_BACKEND';
const RAYNEO_PROVIDER_ENDPOINT_ENVIRONMENT = 'PAIOS_RAYNEO_PROVIDER_ENDPOINT';
const RAYNEO_PROVIDER_MODEL_ENVIRONMENT = 'PAIOS_RAYNEO_PROVIDER_MODEL';
const RAYNEO_MODEL_PROMPT =
  '请用简体中文描述眼前场景，输出一个10到28个可见字符的完整短句。' +
  '只返回短句，不要前缀。';
const RAYNEO_HAN_PATTERN = /\p{Script=Han}/u;
const RAYNEO_ALLOWED_OUTPUT_PATTERN =
  /^[\p{Script=Han}A-Za-z0-9\s，。！？、；：（）《》“”‘’「」『』【】—…·]+$/u;
const RAYNEO_FORBIDDEN_OUTPUT_PATTERN =
  /(?:https?:\/\/|www\.|Bearer\s|sk-[A-Za-z0-9_-]|<[^>]+>|```|\b(?:tool|function)\s*call\b)/iu;

export function loadRayneoOllamaEndpointUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment.PAIOS_RAYNEO_OLLAMA_URL ?? RAYNEO_DEFAULT_OLLAMA_URL;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (
      !Number.isSafeInteger(port) || port < 1_024 || port > 65_535 ||
      value !== `http://127.0.0.1:${port}`
    ) throw new Error('INVALID_PROCESS_ENV:PAIOS_RAYNEO_OLLAMA_URL');
    return value;
  } catch {
    throw new Error('INVALID_PROCESS_ENV:PAIOS_RAYNEO_OLLAMA_URL');
  }
}

type RayneoProviderBackend = 'ollama' | 'openai-compatible';

interface RayneoProviderConfig {
  readonly backend: RayneoProviderBackend;
  readonly model: string;
  /** Full OpenAI-compatible endpoint, including /v1; legacy Ollama is its host base. */
  readonly endpointUrl: string;
  readonly debugLocal: boolean;
  /** Runtime-provided local candidates. The selected session profile is frozen separately. */
  readonly providerProfiles?: readonly Qwen38LocalProviderProfile[];
  readonly providerSelection?: Qwen38ProviderSelectionRequirements;
}

function isRayneoDebugLocalEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return environment.PAIOS_DEMO_ROAMING === '1' && environment.PAIOS_GATE_A_LOCAL_DEVICE === '1';
}

function loadRayneoOpenAiEndpointUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
      parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/v1' ||
      parsed.search !== '' || parsed.hash !== '' || `${parsed.origin}${parsed.pathname}` !== value) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_ENDPOINT_INVALID');
    }
    return value;
  } catch {
    throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
  }
}

function rayneoRealtimeEndpointBase(endpointUrl: string): string {
  return endpointUrl.endsWith('/v1') ? endpointUrl.slice(0, -3) : endpointUrl;
}

const RAYNEO_PROVIDER_PROFILES_ENVIRONMENT = 'PAIOS_RAYNEO_PROVIDER_PROFILES';
const RAYNEO_PROVIDER_REQUIRED_CAPABILITIES_ENVIRONMENT = 'PAIOS_RAYNEO_PROVIDER_REQUIRED_CAPABILITIES';
const RAYNEO_PROVIDER_MIN_CONTEXT_ENVIRONMENT = 'PAIOS_RAYNEO_PROVIDER_MIN_CONTEXT_TOKENS';

function parseRayneoProviderSelection(environment: NodeJS.ProcessEnv): Qwen38ProviderSelectionRequirements {
  const capabilitiesRaw = environment[RAYNEO_PROVIDER_REQUIRED_CAPABILITIES_ENVIRONMENT];
  const minContextRaw = environment[RAYNEO_PROVIDER_MIN_CONTEXT_ENVIRONMENT];
  const requiredCapabilities = capabilitiesRaw === undefined
    ? undefined
    : capabilitiesRaw.split(',').map((value) => value.trim()).filter(Boolean);
  if (capabilitiesRaw !== undefined && (requiredCapabilities === undefined || requiredCapabilities.length === 0)) {
    throw new Error('RAYNEO_PROVIDER_SELECTION_INVALID');
  }
  let minContextTokens: number | undefined;
  if (minContextRaw !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(minContextRaw)) throw new Error('RAYNEO_PROVIDER_SELECTION_INVALID');
    minContextTokens = Number(minContextRaw);
    if (!Number.isSafeInteger(minContextTokens)) throw new Error('RAYNEO_PROVIDER_SELECTION_INVALID');
  }
  return Object.freeze({
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities: Object.freeze(requiredCapabilities) }),
    ...(minContextTokens === undefined ? {} : { minContextTokens }),
  });
}

function parseRayneoProviderProfiles(
  environment: NodeJS.ProcessEnv,
): Readonly<{ profiles: readonly Qwen38LocalProviderProfile[]; requirements: Qwen38ProviderSelectionRequirements }> | undefined {
  const raw = environment[RAYNEO_PROVIDER_PROFILES_ENVIRONMENT];
  if (raw === undefined) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new Error('RAYNEO_PROVIDER_PROFILES_INVALID'); }
  const list = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray((payload as { profiles?: unknown }).profiles)
      ? (payload as { profiles: unknown[] }).profiles
      : undefined;
  if (list === undefined || list.length === 0) throw new Error('RAYNEO_PROVIDER_PROFILES_INVALID');
  let profiles: readonly Qwen38LocalProviderProfile[];
  try { profiles = Object.freeze(list.map((candidate) => freezeQwen38LocalProviderProfile(candidate as Qwen38LocalProviderProfile))); }
  catch { throw new Error('RAYNEO_PROVIDER_PROFILES_INVALID'); }
  const requirements = parseRayneoProviderSelection(environment);
  return Object.freeze({ profiles, requirements });
}

function profileForRayneoOpenAiConfig(
  environment: NodeJS.ProcessEnv,
  endpoint: string,
  model: string,
): Qwen38LocalProviderProfile {
  const origin = endpoint.slice(0, -3);
  const fixture = QWEN38_LOCAL_PROVIDER_PROFILES.find((candidate) =>
    candidate.origin === origin && candidate.model === model);
  if (fixture !== undefined) return freezeQwen38LocalProviderProfile(fixture);
  const contextRaw = environment.PAIOS_RAYNEO_PROVIDER_CONTEXT_TOKENS;
  const availabilityMode = environment.PAIOS_RAYNEO_PROVIDER_AVAILABILITY_MODE ?? 'openai-models';
  if (contextRaw === undefined || !/^[1-9][0-9]*$/u.test(contextRaw) ||
    !Number.isSafeInteger(Number(contextRaw)) ||
    (availabilityMode !== 'supervisor-health' && availabilityMode !== 'openai-models')) {
    throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
  }
  const capabilitiesRaw = environment.PAIOS_RAYNEO_PROVIDER_CAPABILITIES ?? 'completion,vision';
  const capabilities = capabilitiesRaw.split(',').map((value) => value.trim()).filter(Boolean);
  if (capabilities.length === 0) throw new Error('RAYNEO_PROVIDER_PROFILE_REQUIRED');
  try {
    return freezeQwen38LocalProviderProfile({
      origin, model, contextTokens: Number(contextRaw), availabilityMode,
      capabilities: Object.freeze(capabilities),
    });
  } catch { throw new Error('RAYNEO_PROVIDER_PROFILE_REQUIRED'); }
}

function rayneoProviderConfigWithProfiles(
  base: RayneoProviderConfig,
  profiles: readonly Qwen38LocalProviderProfile[],
  requirements: Qwen38ProviderSelectionRequirements = base.providerSelection ?? {},
): RayneoProviderConfig {
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error('RAYNEO_PROVIDER_PROFILES_INVALID');
  let frozen: readonly Qwen38LocalProviderProfile[];
  try { frozen = Object.freeze(profiles.map((profile) => freezeQwen38LocalProviderProfile(profile))); }
  catch { throw new Error('RAYNEO_PROVIDER_PROFILES_INVALID'); }
  const first = frozen[0]!;
  return Object.freeze({
    ...base, backend: 'openai-compatible', model: first.model, endpointUrl: `${first.origin}/v1`, debugLocal: true,
    providerProfiles: frozen, providerSelection: requirements,
  });
}

export function loadRayneoProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: Readonly<{
    allowDemoRoamingPublicQwen?: boolean;
    /** Explicitly injected by the owner-composed debug canary only. */
    providerProfile?: Qwen38LocalProviderProfile;
  }> = {},
): RayneoProviderConfig {
  const backend = environment[RAYNEO_PROVIDER_BACKEND_ENVIRONMENT];
  const endpoint = environment[RAYNEO_PROVIDER_ENDPOINT_ENVIRONMENT];
  const configuredModel = environment[RAYNEO_PROVIDER_MODEL_ENVIRONMENT];
  const local = isRayneoDebugLocalEnvironment(environment);
  const configuredProfiles = parseRayneoProviderProfiles(environment);
  if (options.providerProfile !== undefined) {
    if (configuredProfiles !== undefined || environment.PAIOS_DEMO_ROAMING !== '1' ||
        environment.PAIOS_GATE_A_LOCAL_DEVICE !== '1' ||
        (backend !== undefined && backend !== RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND)) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
    }
    let profile: Qwen38LocalProviderProfile;
    try { profile = freezeQwen38LocalProviderProfile(options.providerProfile); }
    catch { throw new Error('RAYNEO_PROVIDER_PROFILE_REQUIRED'); }
    const endpointUrl = `${profile.origin}/v1`;
    if ((endpoint !== undefined && endpoint !== endpointUrl) ||
        (configuredModel !== undefined && configuredModel !== profile.model)) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
    }
    return Object.freeze({
      backend: 'openai-compatible', model: profile.model, endpointUrl,
      debugLocal: true, providerProfiles: Object.freeze([profile]),
      providerSelection: Object.freeze({
        requiredCapabilities: Object.freeze(['vision']), minContextTokens: profile.contextTokens,
      }),
    });
  }
  if (configuredProfiles !== undefined) {
    const first = configuredProfiles.profiles[0]!;
    if ((backend !== undefined && backend !== RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND) ||
      (endpoint !== undefined && endpoint !== `${first.origin}/v1`) ||
      (configuredModel !== undefined && configuredModel !== first.model)) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
    }
    return Object.freeze({
      backend: 'openai-compatible', model: first.model,
      endpointUrl: `${first.origin}/v1`, debugLocal: true,
      providerProfiles: configuredProfiles.profiles,
      providerSelection: configuredProfiles.requirements,
    });
  }
  if (!local) {
    if (options.allowDemoRoamingPublicQwen === true &&
      environment.PAIOS_DEMO_ROAMING === '1' &&
      backend === RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND &&
      endpoint !== undefined && configuredModel !== undefined) {
      const endpointUrl = loadRayneoOpenAiEndpointUrl(endpoint);
      const profile = profileForRayneoOpenAiConfig(environment, endpointUrl, configuredModel);
      return Object.freeze({
        backend: 'openai-compatible', model: profile.model,
        endpointUrl, debugLocal: false, providerProfiles: Object.freeze([profile]),
        providerSelection: parseRayneoProviderSelection(environment),
      });
    }
    if (backend !== undefined || endpoint !== undefined ||
      (configuredModel !== undefined && configuredModel !== RAYNEO_PRODUCT_MODEL)) {
      throw new Error('RAYNEO_ALTERNATE_PROVIDER_FORBIDDEN');
    }
    const model = requiredEnvironment(environment, 'OLLAMA_MODEL');
    if (model !== RAYNEO_PRODUCT_MODEL) throw new Error('RAYNEO_MODEL_BINDING_INVALID');
    return Object.freeze({
      backend: 'ollama', model: RAYNEO_PRODUCT_MODEL,
      endpointUrl: loadRayneoOllamaEndpointUrl(environment), debugLocal: false,
    });
  }
  if (backend === undefined) {
    if (endpoint !== undefined || (configuredModel !== undefined && configuredModel !== RAYNEO_PRODUCT_MODEL)) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
    }
    const model = requiredEnvironment(environment, 'OLLAMA_MODEL');
    if (model !== RAYNEO_PRODUCT_MODEL) throw new Error('RAYNEO_MODEL_BINDING_INVALID');
    return Object.freeze({
      backend: 'ollama', model: RAYNEO_PRODUCT_MODEL,
      endpointUrl: loadRayneoOllamaEndpointUrl(environment), debugLocal: true,
    });
  }
  if (backend === RAYNEO_DEBUG_OLLAMA_PROVIDER_BACKEND &&
    endpoint === RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT &&
    configuredModel === RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL) {
    return Object.freeze({
      backend: 'ollama', model: RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL,
      endpointUrl: loadRayneoOllamaEndpointUrl({
        PAIOS_RAYNEO_OLLAMA_URL: RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT,
      }), debugLocal: true,
    });
  }
  if (backend !== RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND || endpoint === undefined || configuredModel === undefined) {
    throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
  }
  const endpointUrl = loadRayneoOpenAiEndpointUrl(endpoint);
  const profile = profileForRayneoOpenAiConfig(environment, endpointUrl, configuredModel);
  return Object.freeze({
    backend: 'openai-compatible', model: profile.model,
    endpointUrl, debugLocal: true, providerProfiles: Object.freeze([profile]),
    providerSelection: parseRayneoProviderSelection(environment),
  });
}

export function resolveRayneoVisualModelDeadlineMs(input: {
  readonly model: string;
  readonly endpointUrl: string;
  readonly providerBackend: string;
  readonly debugLocal: boolean;
  readonly providerProfile?: Qwen38LocalProviderProfile;
}): number | undefined {
  const profileBound = input.providerProfile !== undefined &&
    input.model === input.providerProfile.model &&
    input.endpointUrl === `${input.providerProfile.origin}/v1`;
  const legacyBound = input.providerProfile === undefined &&
    input.model === RAYNEO_DEBUG_LOCAL_PROVIDER_MODEL &&
    input.endpointUrl === RAYNEO_DEBUG_LOCAL_PROVIDER_ENDPOINT;
  return input.debugLocal === true &&
    input.providerBackend === RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND &&
    (profileBound || legacyBound)
    ? RAYNEO_VISUAL_MAX_MODEL_DEADLINE_MS
    : undefined;
}

export function buildRayneoModelRequest(
  jpeg: Buffer,
  contextText?: string,
  model = RAYNEO_PRODUCT_MODEL,
): object {
  const context = typeof contextText === 'string' && contextText.length > 0
    ? `会话上下文（历史转写与回复，仅供参考）：\n${contextText}`
    : undefined;
  return {
    model,
    reasoning_effort: 'none',
    stream: false,
    temperature: 0,
    max_tokens: 48,
    messages: [{ role: 'user', content: [
      { type: 'text', text: RAYNEO_MODEL_PROMPT },
      ...(context === undefined ? [] : [{ type: 'text', text: context }]),
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
    ] }],
  };
}

function rayneoModelRequestContainsImageUrl(request: object): boolean {
  const messages = (request as { readonly messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  const content = (messages[0] as { readonly content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part !== null && typeof part === 'object' &&
    (part as { readonly type?: unknown }).type === 'image_url');
}

export function parseRayneoModelResponse(payload: unknown): string {
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new Error('MODEL_FAILED');
  }
  const choices = (payload as { readonly choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new Error('MODEL_FAILED');
  const choice = choices[0];
  if (choice === null || Array.isArray(choice) || typeof choice !== 'object') {
    throw new Error('MODEL_FAILED');
  }
  const typedChoice = choice as {
    readonly finish_reason?: unknown;
    readonly message?: unknown;
  };
  if (typedChoice.finish_reason !== 'stop' || typedChoice.message === null ||
      Array.isArray(typedChoice.message) || typeof typedChoice.message !== 'object') {
    throw new Error('MODEL_FAILED');
  }
  const message = typedChoice.message as {
    readonly content?: unknown;
    readonly reasoning?: unknown;
    readonly tool_calls?: unknown;
  };
  if ((message.reasoning !== undefined && message.reasoning !== null) ||
      (message.tool_calls !== undefined && message.tool_calls !== null) ||
      typeof message.content !== 'string' || message.content !== message.content.trim() ||
      !isRayneoChineseSentence(message.content)) {
    throw new Error('MODEL_FAILED');
  }
  return message.content;
}

function isRayneoChineseSentence(value: string): boolean {
  if (!RAYNEO_ALLOWED_OUTPUT_PATTERN.test(value) || RAYNEO_FORBIDDEN_OUTPUT_PATTERN.test(value)) return false;
  if (/[/\u0000-\u001f\u007f]/u.test(value)) return false;
  const visible = [...value].filter((character) => !/\s/u.test(character));
  if (visible.length < 10 || visible.length > 28 || !/[。！？]/u.test(visible.at(-1) ?? '')) return false;
  const body = visible.slice(0, -1);
  if (body.some((character) => /[。！？]/u.test(character))) return false;
  const han = body.filter((character) => RAYNEO_HAN_PATTERN.test(character)).length;
  const latinDigits = body.filter((character) => /[A-Za-z0-9]/u.test(character)).length;
  return han >= 4 && latinDigits <= 8;
}

export interface RayneoOwnerResolvedContextResolverInput {
  readonly binding: Readonly<{
    readonly runId: string;
    readonly sessionId: string;
    readonly deviceId: string;
    readonly clientInstanceId: string;
    readonly replyId: string;
    readonly frameId: string;
    readonly receiptIdempotencyKey: string;
    readonly openedAt: number;
    readonly expiresAt: number;
  }>;
  readonly jpeg: Buffer;
  readonly jpegSha256: string;
  readonly signal: AbortSignal;
}

export type RayneoOwnerResolvedContextResolver = (
  input: RayneoOwnerResolvedContextResolverInput,
) => Promise<WindowsAiOwnerResolvedPerceptionContext>;

const RAYNEO_OWNER_RESOLVED_IMAGE_URL =
  /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/u;

function assertCurrentOwnerResolvedVisualArtifact(
  context: WindowsAiContextCompilerInput,
  jpeg: Buffer,
  jpegSha256: string,
): void {
  for (const artifact of context.artifacts ?? []) {
    if ((artifact.mediaKind !== 'image' && artifact.mediaKind !== 'video_frame') ||
      artifact.contentSha256 !== jpegSha256 || artifact.content.kind !== 'image_url') continue;
    const match = RAYNEO_OWNER_RESOLVED_IMAGE_URL.exec(artifact.content.url);
    if (match === null || match[1] === undefined || match[1].length % 4 !== 0) continue;
    const decoded = Buffer.from(match[1], 'base64');
    if (decoded.toString('base64') === match[1] && decoded.equals(jpeg)) return;
  }
  throw new Error('MODEL_FAILED');
}

function containsCurrentOwnerResolvedJpeg(
  messages: readonly Qwen38ChatMessage[],
  jpeg: Buffer,
): boolean {
  const expectedUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  return messages.some((message) => {
    if (!Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) return false;
      const typedPart = part as { readonly type?: unknown; readonly image_url?: unknown };
      if (typedPart.type !== 'image_url' || typedPart.image_url === null ||
          typeof typedPart.image_url !== 'object' || Array.isArray(typedPart.image_url)) return false;
      return (typedPart.image_url as { readonly url?: unknown }).url === expectedUrl;
    });
  });
}

export function createRayneoModelProvider(input: {
  readonly model: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly replyId: string;
  readonly ollamaEndpointUrl: string;
  readonly providerBackend?: RayneoProviderBackend;
  /** Explicit frozen local profile for every OpenAI-compatible Qwen session. */
  readonly providerProfile?: Qwen38LocalProviderProfile;
  /** Debug-local output is deliberately identity-free; public production output remains unchanged. */
  readonly debugLocal?: boolean;
  /** Internal startup seam; never inferred from the provider tuple. */
  readonly allowDemoRoamingPublicQwen?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly turnContext?: RayneoSessionTurnContext;
  readonly onVisualJointContextApplied?: () => void;
  readonly ownerResolvedContextBinding?: RayneoOwnerResolvedContextResolverInput['binding'];
  readonly ownerResolvedContextResolver?: RayneoOwnerResolvedContextResolver;
  readonly contextTokenEstimator?: WindowsAiTokenEstimator;
}): RayneoVisualModelProvider {
  const providerBackend = input.providerBackend ?? 'ollama';
  const providerProfile = input.providerProfile === undefined ? undefined :
    freezeQwen38LocalProviderProfile(input.providerProfile);
  const exactQwen38Profile = providerProfile !== undefined &&
    input.model === providerProfile.model &&
    input.ollamaEndpointUrl === `${providerProfile.origin}/v1`;
  const allowExactQwen38Profile = providerProfile !== undefined && exactQwen38Profile &&
    (input.debugLocal === true ||
      (input.debugLocal === false && input.allowDemoRoamingPublicQwen === true));
  const endpointUrl = providerBackend === 'openai-compatible'
    ? (allowExactQwen38Profile
      ? loadRayneoOpenAiEndpointUrl(input.ollamaEndpointUrl)
      : (() => { throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID'); })())
    : (() => {
      const qwenDebugProfile = input.debugLocal === true &&
        input.model === RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL &&
        input.ollamaEndpointUrl === RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT;
      if (input.model !== RAYNEO_PRODUCT_MODEL && !qwenDebugProfile) {
        throw new Error('RAYNEO_MODEL_BINDING_INVALID');
      }
      return loadRayneoOllamaEndpointUrl({ PAIOS_RAYNEO_OLLAMA_URL: input.ollamaEndpointUrl });
    })();
  const hasOwnerResolvedResolver = input.ownerResolvedContextResolver !== undefined;
  const hasContextEstimator = input.contextTokenEstimator !== undefined;
  const hasOwnerResolvedBinding = input.ownerResolvedContextBinding !== undefined;
  const exactLocalQwen = providerBackend === RAYNEO_DEBUG_LOCAL_PROVIDER_BACKEND &&
    providerProfile !== undefined && exactQwen38Profile && allowExactQwen38Profile &&
    endpointUrl === `${providerProfile.origin}/v1`;
  if (hasOwnerResolvedResolver !== hasContextEstimator ||
    hasOwnerResolvedResolver !== hasOwnerResolvedBinding ||
    (hasOwnerResolvedResolver && !exactLocalQwen)) {
    throw new Error('RAYNEO_CONTEXT_ADAPTER_CONFIG_INVALID');
  }
  if (input.ownerResolvedContextBinding !== undefined &&
    (input.ownerResolvedContextBinding.runId !== input.runId ||
      input.ownerResolvedContextBinding.sessionId !== input.sessionId ||
      input.ownerResolvedContextBinding.replyId !== input.replyId)) {
    throw new Error('RAYNEO_CONTEXT_ADAPTER_CONFIG_INVALID');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let invocationCount = 0;
  return {
    analyze: async (jpeg, signal) => {
      invocationCount += 1;
      if (invocationCount !== 1) throw new Error('MODEL_FAILED');
      process.stderr.write(input.debugLocal
        ? 'phase0 rayneo product_model_invoked count=1 local=true\n'
        : `phase0 rayneo product_model_invoked count=1 model=${input.model} runId=${input.runId} sessionId=${input.sessionId} replyId=${input.replyId}\n`);
      const contextText = input.turnContext?.snapshot();
      let text: string;
      if (exactLocalQwen && hasOwnerResolvedResolver && hasContextEstimator) {
        const resolverJpeg = Buffer.from(jpeg);
        let provider: Qwen38ProviderAdapter | undefined;
        try {
          const jpegSha256 = persistentSha256(resolverJpeg);
          const ownerContext = await input.ownerResolvedContextResolver!({
            binding: input.ownerResolvedContextBinding!, jpeg: resolverJpeg, jpegSha256, signal,
          });
          if (signal.aborted) throw new Error('MODEL_FAILED');
          const compilerInput = adaptOwnerResolvedPerceptionContext(ownerContext, signal);
          assertCurrentOwnerResolvedVisualArtifact(compilerInput, resolverJpeg, jpegSha256);
          provider = new Qwen38ProviderAdapter(providerProfile!, { fetchImpl });
          const inputTokenLimit = compilerInput.budget.inputTokenLimit ??
            (providerProfile!.contextTokens - compilerInput.budget.reservedOutputTokens);
          let currentJpegProposalSeen = false;
          const ownerResolvedEstimator: WindowsAiTokenEstimator = (messages) => {
            const estimated = input.contextTokenEstimator!(messages);
            if (Number.isSafeInteger(estimated) && estimated >= 0 &&
                !currentJpegProposalSeen && containsCurrentOwnerResolvedJpeg(messages, resolverJpeg)) {
              currentJpegProposalSeen = true;
              if (estimated > inputTokenLimit) {
                throw new Error('WINDOWS_AI_CONTEXT_CURRENT_ARTIFACT_BUDGET_EXCEEDED');
              }
            }
            return estimated;
          };
          const guardedProvider = {
            checkAvailability: async (availabilitySignal?: AbortSignal) => {
              if (!currentJpegProposalSeen) throw new Error('MODEL_FAILED');
              return provider!.checkAvailability(availabilitySignal);
            },
            stream: (request: Qwen38ChatRequest, streamSignal?: AbortSignal) =>
              provider!.stream(request, streamSignal),
          };
          const orchestrator = createWindowsAiInferenceOrchestrator({
            provider: guardedProvider, estimator: ownerResolvedEstimator,
          });
          let finalText: string | undefined;
          let deltaCount = 0;
          const outcome = await orchestrator.run({ context: compilerInput, signal }, async (event: WindowsAiInferenceEvent) => {
            if (event.kind === 'delta') deltaCount += 1;
            else if (event.kind === 'final') finalText = event.text;
          });
          void deltaCount;
          if (outcome.terminal !== 'final' || finalText === undefined || !isRayneoChineseSentence(finalText)) {
            throw new Error('MODEL_FAILED');
          }
          text = finalText;
        } catch {
          throw new Error('MODEL_FAILED');
        } finally {
          provider?.close();
          resolverJpeg.fill(0);
        }
      } else {
      const modelRequest = buildRayneoModelRequest(jpeg, contextText, input.model);
      if (rayneoModelRequestContainsImageUrl(modelRequest) &&
        typeof contextText === 'string' && contextText.length > 0 &&
        input.turnContext?.hasRealtimeTurn() === true) {
        process.stderr.write('VISION_JOINT_CONTEXT_APPLIED\n');
        try { input.onVisualJointContextApplied?.(); } catch { /* diagnostics are best effort */ }
      }
      if (providerBackend === 'openai-compatible') {
        const request = modelRequest as {
          readonly messages: readonly Qwen38ChatMessage[];
          readonly max_tokens: number;
          readonly temperature: number;
        };
        const provider = new Qwen38ProviderAdapter(providerProfile!, { fetchImpl });
        try {
          if (providerProfile!.availabilityMode === 'openai-models') {
            const response = await provider.fetchThrough(`${providerProfile!.origin}/v1/chat/completions`, {
              method: 'POST', redirect: 'error', cache: 'no-store', signal,
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...modelRequest,
                chat_template_kwargs: { enable_thinking: false },
              }),
            });
            text = parseRayneoModelResponse(await response.json());
          } else {
            const completion = await provider.complete({
              messages: request.messages,
              maxTokens: request.max_tokens,
              temperature: request.temperature,
            }, signal);
            text = completion.text;
          }
          if (!isRayneoChineseSentence(text)) throw new Error('MODEL_FAILED');
        } catch {
          throw new Error('MODEL_FAILED');
        } finally {
          provider.close();
        }
      } else {
        const modelResponse = await fetchImpl(`${endpointUrl}/v1/chat/completions`, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(modelRequest),
        });
        if (!modelResponse.ok) throw new Error('MODEL_FAILED');
        text = parseRayneoModelResponse(await modelResponse.json());
      }
      }
      const words = text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/gu) ?? [];
      process.stderr.write(input.debugLocal
        ? `phase0 rayneo product_model_completed count=1 local=true finish=stop words=${words.length}\n`
        : `phase0 rayneo product_model_completed count=1 model=${input.model} runId=${input.runId} sessionId=${input.sessionId} replyId=${input.replyId} finish=stop words=${words.length}\n`);
      return { text, provider: 'ollama_openai_compatible', model: input.model };
    },
  };
}

function requiredCanonicalTime(environment: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredEnvironment(environment, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw)) {
    throw new Error(`INVALID_PROCESS_ENV:${name}`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new Error(`INVALID_PROCESS_ENV:${name}`);
  }
  return parsed;
}

export function inspectRayneoProviderReadiness(environment: NodeJS.ProcessEnv, requiredThroughMs: number): RayneoProviderReadiness {
  const backend = environment[RAYNEO_PROVIDER_BACKEND_ENVIRONMENT];
  if (backend !== undefined) {
    if (backend !== RAYNEO_DEBUG_OLLAMA_PROVIDER_BACKEND ||
      environment[RAYNEO_PROVIDER_ENDPOINT_ENVIRONMENT] !== RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT ||
      environment[RAYNEO_PROVIDER_MODEL_ENVIRONMENT] !== RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL ||
      environment.PAIOS_RAYNEO_PROVIDER_MODEL_DIGEST !== RAYNEO_DEBUG_OLLAMA_PROVIDER_DIGEST ||
      environment.PAIOS_RAYNEO_PROVIDER_CONTEXT_LENGTH !== String(RAYNEO_DEBUG_OLLAMA_PROVIDER_CONTEXT_LENGTH) ||
      environment.PAIOS_RAYNEO_PROVIDER_SIZE_BYTES !== String(RAYNEO_DEBUG_OLLAMA_PROVIDER_SIZE_BYTES) ||
      environment.PAIOS_RAYNEO_PROVIDER_VRAM_BYTES !== String(RAYNEO_DEBUG_OLLAMA_PROVIDER_VRAM_BYTES) ||
      environment.PAIOS_RAYNEO_PROVIDER_KEEP_ALIVE !== RAYNEO_DEBUG_OLLAMA_PROVIDER_KEEP_ALIVE ||
      environment.PAIOS_RAYNEO_PROVIDER_CAPABILITIES !== RAYNEO_DEBUG_OLLAMA_PROVIDER_CAPABILITIES.join(',')) {
      return Object.freeze({ ready: false, validThroughMs: 0 });
    }
    const preloadCount = environment.PAIOS_RAYNEO_PROVIDER_PRELOAD_COUNT;
    const psCount = environment.PAIOS_RAYNEO_PROVIDER_PS_COUNT;
    if (!preloadCount || !/^[1-9][0-9]*$/u.test(preloadCount) ||
      !psCount || !/^[1-9][0-9]*$/u.test(psCount) || preloadCount !== psCount) {
      return Object.freeze({ ready: false, validThroughMs: 0 });
    }
    try {
      const residencyExpiresAt = requiredCanonicalTime(environment, 'PAIOS_RAYNEO_MODEL_RESIDENCY_EXPIRES_AT_UTC');
      return Object.freeze({ ready: residencyExpiresAt >= requiredThroughMs, validThroughMs: residencyExpiresAt });
    } catch { return Object.freeze({ ready: false, validThroughMs: 0 }); }
  }
  const preloadCount = environment.PAIOS_RAYNEO_PROVIDER_PRELOAD_COUNT;
  const psCount = environment.PAIOS_RAYNEO_PROVIDER_PS_COUNT;
  if (
    !preloadCount || !/^[1-9][0-9]*$/u.test(preloadCount) ||
    !psCount || !/^[1-9][0-9]*$/u.test(psCount) ||
    preloadCount !== psCount ||
    environment.PAIOS_RAYNEO_PROVIDER_MODEL !== RAYNEO_PRODUCT_MODEL ||
    environment.PAIOS_RAYNEO_PROVIDER_MODEL_DIGEST !== RAYNEO_PRODUCT_MODEL_DIGEST ||
    environment.PAIOS_RAYNEO_PROVIDER_CONTEXT_LENGTH !== '4096' ||
    environment.PAIOS_RAYNEO_PROVIDER_SIZE_BYTES !== '16588598147' ||
    environment.PAIOS_RAYNEO_PROVIDER_VRAM_BYTES !== '16588598147' ||
    environment.PAIOS_RAYNEO_PROVIDER_KEEP_ALIVE !== RAYNEO_PROVIDER_KEEP_ALIVE
  ) return Object.freeze({ ready: false, validThroughMs: 0 });
  try {
    const residencyExpiresAt = requiredCanonicalTime(environment, 'PAIOS_RAYNEO_MODEL_RESIDENCY_EXPIRES_AT_UTC');
    return Object.freeze({ ready: residencyExpiresAt >= requiredThroughMs, validThroughMs: residencyExpiresAt });
  } catch { return Object.freeze({ ready: false, validThroughMs: 0 }); }
}

export interface RayneoProviderReadinessSupervisorConfig {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  readonly requestTimeoutMs?: number;
  readonly prewarmAllowed?: () => boolean;
  readonly ollamaEndpointUrl?: string;
  readonly providerBackend?: RayneoProviderBackend;
  readonly providerModel?: string;
  readonly providerProfile?: Qwen38LocalProviderProfile;
  readonly providerProfiles?: readonly Qwen38LocalProviderProfile[];
  readonly providerSelection?: Qwen38ProviderSelectionRequirements;
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function requireJsonResponse(response: Response): void {
  const contentType = response.headers.get('content-type');
  if (!response.ok || response.status !== 200 ||
    (contentType !== 'application/json' && contentType !== 'application/json; charset=utf-8')) {
    throw new Error('PROVIDER_NOT_READY');
  }
}

export function inspectRayneoProviderPs(payload: unknown, observedAtMs: number): RayneoProviderReadiness {
  if (!exactObjectKeys(payload, ['models']) || !Array.isArray(payload.models)) {
    return Object.freeze({ ready: false, validThroughMs: 0 });
  }
  const keys = ['name', 'model', 'size', 'digest', 'details', 'expires_at', 'size_vram', 'context_length'];
  const matches = payload.models.filter((candidate) => exactObjectKeys(candidate, keys) &&
    candidate.name === RAYNEO_PRODUCT_MODEL && candidate.model === RAYNEO_PRODUCT_MODEL &&
    candidate.digest === RAYNEO_PRODUCT_MODEL_DIGEST);
  if (matches.length !== 1) return Object.freeze({ ready: false, validThroughMs: 0 });
  const model = matches[0]!;
  if (model.name !== RAYNEO_PRODUCT_MODEL || model.model !== RAYNEO_PRODUCT_MODEL ||
    model.digest !== RAYNEO_PRODUCT_MODEL_DIGEST || model.size !== 16_588_598_147 ||
    model.size_vram !== 16_588_598_147 || model.context_length !== 4_096 ||
    !exactObjectKeys(model.details, ['parent_model', 'format', 'family', 'families', 'parameter_size', 'quantization_level'])) {
    return Object.freeze({ ready: false, validThroughMs: 0 });
  }
  const validThroughMs = ollamaTimeMs(model.expires_at);
  if (validThroughMs === undefined) return Object.freeze({ ready: false, validThroughMs: 0 });
  return Object.freeze({ ready: validThroughMs >= observedAtMs, validThroughMs });
}

export function inspectRayneoDebugOllamaProviderPs(
  payload: unknown,
  observedAtMs: number,
): RayneoProviderReadiness {
  if (!exactObjectKeys(payload, ['models']) || !Array.isArray(payload.models)) {
    return Object.freeze({ ready: false, validThroughMs: 0 });
  }
  const keys = ['name', 'model', 'size', 'digest', 'details', 'expires_at', 'size_vram', 'context_length'];
  const matches = payload.models.filter((candidate) => exactObjectKeys(candidate, keys) &&
    candidate.name === RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL &&
    candidate.model === RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL &&
    candidate.digest === RAYNEO_DEBUG_OLLAMA_PROVIDER_DIGEST);
  if (matches.length !== 1) return Object.freeze({ ready: false, validThroughMs: 0 });
  const model = matches[0]!;
  const details = model.details as Record<string, unknown>;
  if (model.size !== RAYNEO_DEBUG_OLLAMA_PROVIDER_SIZE_BYTES ||
    model.size_vram !== RAYNEO_DEBUG_OLLAMA_PROVIDER_VRAM_BYTES ||
    model.context_length !== RAYNEO_DEBUG_OLLAMA_PROVIDER_CONTEXT_LENGTH ||
    !exactObjectKeys(details, ['parent_model', 'format', 'family', 'families', 'parameter_size', 'quantization_level']) ||
    details.format !== 'gguf' || details.family !== 'qwen35' ||
    !Array.isArray(details.families) || details.families.length !== 1 || details.families[0] !== 'qwen35' ||
    details.parameter_size !== '27.3B' || details.quantization_level !== 'Q4_K_M') {
    return Object.freeze({ ready: false, validThroughMs: 0 });
  }
  const validThroughMs = ollamaTimeMs(model.expires_at);
  if (validThroughMs === undefined) return Object.freeze({ ready: false, validThroughMs: 0 });
  return Object.freeze({ ready: validThroughMs >= observedAtMs, validThroughMs });
}

export function assertRayneoDebugOllamaProviderShow(payload: unknown): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PROVIDER_NOT_READY');
  }
  const value = payload as Record<string, unknown>;
  const capabilities = value.capabilities;
  const details = value.details;
  const modelInfo = value.model_info;
  if (!Array.isArray(capabilities) || capabilities.length !== RAYNEO_DEBUG_OLLAMA_PROVIDER_CAPABILITIES.length ||
    capabilities.some((candidate, index) => candidate !== RAYNEO_DEBUG_OLLAMA_PROVIDER_CAPABILITIES[index]) ||
    details === null || typeof details !== 'object' || Array.isArray(details) ||
    (details as Record<string, unknown>).family !== 'qwen35' ||
    (details as Record<string, unknown>).parameter_size !== '27.3B' ||
    (details as Record<string, unknown>).quantization_level !== 'Q4_K_M' ||
    modelInfo === null || typeof modelInfo !== 'object' || Array.isArray(modelInfo) ||
    (modelInfo as Record<string, unknown>)['general.architecture'] !== 'qwen35') {
    throw new Error('PROVIDER_NOT_READY');
  }
}

function ollamaTimeMs(value: unknown): number | undefined {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function assertRayneoPrewarmResponse(payload: unknown, expectedModel = RAYNEO_PRODUCT_MODEL): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error('PROVIDER_NOT_READY');
  }
  const value = payload as Record<string, unknown>;
  const allowed = new Set([
    'model', 'created_at', 'response', 'done', 'done_reason', 'context',
    'total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration',
    'eval_count', 'eval_duration',
  ]);
  if ([...Object.keys(value)].some((key) => !allowed.has(key)) || value.model !== expectedModel ||
    value.response !== '' || value.done !== true || value.done_reason !== 'load') {
    throw new Error('PROVIDER_NOT_READY');
  }
  if (ollamaTimeMs(value.created_at) === undefined ||
    (value.context !== undefined && (!Array.isArray(value.context) ||
      value.context.some((token) => !Number.isSafeInteger(token) || Number(token) < 0)))) {
    throw new Error('PROVIDER_NOT_READY');
  }
  for (const metric of ['total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'] as const) {
    if (value[metric] !== undefined && (!Number.isSafeInteger(value[metric]) || Number(value[metric]) < 0)) {
      throw new Error('PROVIDER_NOT_READY');
    }
  }
}

export class RayneoProviderReadinessSupervisor {
  readonly #fetch: NonNullable<RayneoProviderReadinessSupervisorConfig['fetchImpl']>;
  readonly #now: () => number;
  readonly #setTimer: NonNullable<RayneoProviderReadinessSupervisorConfig['setTimer']>;
  readonly #clearTimer: NonNullable<RayneoProviderReadinessSupervisorConfig['clearTimer']>;
  readonly #requestTimeoutMs: number;
  readonly #prewarmAllowed: () => boolean;
  readonly #providerBackend: RayneoProviderBackend;
  readonly #providerModel: string;
  readonly #providerEndpointUrl: string;
  readonly #providerProfiles: readonly Qwen38LocalProviderProfile[] | undefined;
  readonly #providerSelection: Qwen38ProviderSelectionRequirements;
  #selectedProfile: Qwen38LocalProviderProfile | undefined;
  #readiness: RayneoProviderReadiness = Object.freeze({ ready: false, validThroughMs: 0 });
  #refreshFlight: Promise<RayneoProviderReadiness> | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(config: RayneoProviderReadinessSupervisorConfig = {}) {
    this.#fetch = config.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#now = config.now ?? Date.now;
    this.#setTimer = config.setTimer ?? setTimeout;
    this.#clearTimer = config.clearTimer ?? clearTimeout;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
    this.#prewarmAllowed = config.prewarmAllowed ?? (() => true);
    const suppliedProfiles = config.providerProfiles ??
      (config.providerProfile === undefined ? undefined : Object.freeze([config.providerProfile]));
    if (suppliedProfiles !== undefined && suppliedProfiles.length === 0) {
      throw new Error('RAYNEO_PROVIDER_PROFILES_INVALID');
    }
    this.#providerProfiles = suppliedProfiles === undefined ? undefined : Object.freeze(
      suppliedProfiles.map((profile) => freezeQwen38LocalProviderProfile(profile)),
    );
    this.#providerSelection = config.providerSelection ?? {};
    this.#providerBackend = this.#providerProfiles === undefined
      ? (config.providerBackend ?? 'ollama') : 'openai-compatible';
    this.#providerModel = config.providerModel ?? this.#providerProfiles?.[0]?.model ?? RAYNEO_PRODUCT_MODEL;
    this.#providerEndpointUrl = this.#providerBackend === 'openai-compatible'
      ? (this.#providerProfiles === undefined
        ? loadRayneoOpenAiEndpointUrl(config.ollamaEndpointUrl ?? '')
        : `${this.#providerProfiles[0]!.origin}/v1`)
      : loadRayneoOllamaEndpointUrl(
        config.ollamaEndpointUrl === undefined ? {} : { PAIOS_RAYNEO_OLLAMA_URL: config.ollamaEndpointUrl },
      );
    if (this.#providerBackend === 'openai-compatible' && this.#providerProfiles === undefined &&
      config.providerProfile === undefined) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_PROFILE_REQUIRED');
    }
    if (this.#providerBackend === 'ollama' && this.#providerModel !== RAYNEO_PRODUCT_MODEL &&
      !(this.#providerModel === RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL &&
        this.#providerEndpointUrl === RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT)) {
      throw new Error('RAYNEO_LOCAL_PROVIDER_CONFIG_INVALID');
    }
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1 || this.#requestTimeoutMs > 30_000) {
      throw new Error('PROVIDER_READINESS_CONFIG_INVALID');
    }
  }

  async start(): Promise<RayneoProviderReadiness> {
    if (this.#closed) throw new Error('PROVIDER_READINESS_CLOSED');
    const readiness = await this.refresh();
    if (!readiness.ready) throw new Error('PROVIDER_NOT_READY');
    this.#scheduleRefresh();
    return readiness;
  }

  refresh(): Promise<RayneoProviderReadiness> {
    if (this.#closed) return Promise.resolve(Object.freeze({ ready: false, validThroughMs: 0 }));
    this.#refreshFlight ??= this.#performRefresh().finally(() => { this.#refreshFlight = undefined; });
    return this.#refreshFlight;
  }

  inspect(requiredThroughMs: number): RayneoProviderReadiness {
    if (!Number.isSafeInteger(requiredThroughMs) || this.#closed || !this.#readiness.ready ||
      this.#readiness.validThroughMs < requiredThroughMs) {
      return Object.freeze({ ready: false, validThroughMs: this.#readiness.validThroughMs });
    }
    return this.#readiness;
  }

  get selectedProfile(): Qwen38LocalProviderProfile | undefined { return this.#selectedProfile; }

  async selectProviderProfile(
    requirements: Qwen38ProviderSelectionRequirements = this.#providerSelection,
  ): Promise<Qwen38LocalProviderProfile> {
    if (this.#closed) throw new Error('PROVIDER_READINESS_CLOSED');
    if (this.#providerProfiles === undefined) {
      if (this.#providerBackend !== 'openai-compatible' || this.#selectedProfile === undefined) {
        throw new Error('RAYNEO_LOCAL_PROVIDER_PROFILE_REQUIRED');
      }
      return this.#selectedProfile;
    }
    const selected = await this.#selectAvailableProfile(requirements);
    this.#selectedProfile = selected;
    return selected;
  }

  close(): void {
    this.#closed = true;
    if (this.#refreshTimer) this.#clearTimer(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#readiness = Object.freeze({ ready: false, validThroughMs: 0 });
  }

  async #performRefresh(): Promise<RayneoProviderReadiness> {
    if (!this.#prewarmAllowed()) return this.#readiness;
    this.#readiness = Object.freeze({ ready: false, validThroughMs: 0 });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.#requestTimeoutMs);
    timeout.unref?.();
    try {
      if (this.#providerBackend === 'openai-compatible') {
        const selected = this.#providerProfiles === undefined
          ? this.#selectedProfile
          : await this.#selectAvailableProfile(this.#providerSelection, abort.signal);
        if (selected === undefined) throw new Error('RAYNEO_LOCAL_PROVIDER_PROFILE_REQUIRED');
        this.#selectedProfile = selected;
        if (this.#providerProfiles === undefined) {
          const provider = new Qwen38ProviderAdapter(selected, { fetchImpl: this.#fetch });
          try { await provider.checkAvailability(abort.signal); }
          finally { provider.close(); }
        }
        const observedAt = this.#now();
        const readiness = Object.freeze({ ready: true, validThroughMs: observedAt + 2_700_000 });
        this.#readiness = readiness;
        return readiness;
      }
      const qwenDebugProfile = this.#providerBackend === RAYNEO_DEBUG_OLLAMA_PROVIDER_BACKEND &&
        this.#providerModel === RAYNEO_DEBUG_OLLAMA_PROVIDER_MODEL &&
        this.#providerEndpointUrl === RAYNEO_DEBUG_OLLAMA_PROVIDER_ENDPOINT;
      const keepAlive = qwenDebugProfile ? RAYNEO_DEBUG_OLLAMA_PROVIDER_KEEP_ALIVE : RAYNEO_PROVIDER_KEEP_ALIVE;
      const prewarm = await this.#fetch(`${this.#providerEndpointUrl}/api/generate`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: abort.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.#providerModel, keep_alive: keepAlive, stream: false }),
      });
      requireJsonResponse(prewarm);
      assertRayneoPrewarmResponse(await prewarm.json(), this.#providerModel);
      const ps = await this.#fetch(`${this.#providerEndpointUrl}/api/ps`, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: abort.signal,
        headers: { Accept: 'application/json' },
      });
      requireJsonResponse(ps);
      const observedAt = this.#now();
      const readiness = qwenDebugProfile
        ? inspectRayneoDebugOllamaProviderPs(await ps.json(), observedAt)
        : inspectRayneoProviderPs(await ps.json(), observedAt);
      if (qwenDebugProfile) {
        const show = await this.#fetch(`${this.#providerEndpointUrl}/api/show`, {
          method: 'POST', redirect: 'error', cache: 'no-store', signal: abort.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.#providerModel }),
        });
        requireJsonResponse(show);
        assertRayneoDebugOllamaProviderShow(await show.json());
      }
      const requiredResidencyMs = qwenDebugProfile
        ? RAYNEO_DEBUG_OLLAMA_PROVIDER_RESIDENCY_MS - 1_000
        : 2_699_000;
      if (!readiness.ready || readiness.validThroughMs < observedAt + requiredResidencyMs) {
        throw new Error('PROVIDER_NOT_READY');
      }
      this.#readiness = readiness;
      return readiness;
    } catch {
      this.#readiness = Object.freeze({ ready: false, validThroughMs: 0 });
      return this.#readiness;
    } finally { clearTimeout(timeout); }
  }

  async #selectAvailableProfile(
    requirements: Qwen38ProviderSelectionRequirements,
    signal?: AbortSignal,
  ): Promise<Qwen38LocalProviderProfile> {
    if (this.#providerProfiles === undefined) throw new Error('RAYNEO_LOCAL_PROVIDER_PROFILE_REQUIRED');
    return selectQwen38LocalProviderProfile(this.#providerProfiles, requirements, async (profile) => {
      const provider = new Qwen38ProviderAdapter(profile, { fetchImpl: this.#fetch });
      try { return await provider.checkAvailability(signal); }
      finally { provider.close(); }
    });
  }

  #scheduleRefresh(): void {
    if (this.#closed || this.#refreshTimer) return;
    this.#refreshTimer = this.#setTimer(() => {
      this.#refreshTimer = undefined;
      this.#scheduleRefresh();
      void this.refresh();
    }, RAYNEO_PROVIDER_REFRESH_MS);
    this.#refreshTimer.unref?.();
  }
}

async function createQwen38RealtimeSession(
  config: RayneoRealtimeAudioConfig,
  binding: RayneoRealtimeAudioBinding,
  providerProfile: Qwen38LocalProviderProfile,
  productionTurn?: RayneoProductionTurn,
  ownerAliasIssuer?: RayneoLiveKitOwnerAliasIssuerPort,
): Promise<RayneoRealtimeAudioSession> {
  const provider = new Qwen38ProviderAdapter(providerProfile);
  try {
    const selectedConfig = Object.freeze({
      ...config,
      ollamaModel: providerProfile.model,
      ollamaEndpointUrl: providerProfile.origin,
    });
    const session = await RayneoRealtimeAudioController.create(selectedConfig, binding, {
      fetch: provider.fetchThrough,
      ...(productionTurn === undefined ? {} : {
        finalTranscriptAuthority: productionTurn.finalTranscriptAuthority,
        afterFinalTranscript: productionTurn.afterFinalTranscript,
        generateReply: productionTurn.generateReply,
        generateMultimodalReply: productionTurn.generateRealtimeReply,
        generateVisualHeartbeatReply: productionTurn.generateVisualHeartbeatReply,
      }),
      ...(ownerAliasIssuer === undefined ? {} : { ownerAliasIssuer }),
    });
    const result = {
      livekit_url: session.livekit_url,
      livekit_token: session.livekit_token,
      livekit_token_expires_at: session.livekit_token_expires_at,
      livekit_video_publish_enabled: session.livekit_video_publish_enabled,
      cleanup: async () => {
        try { return await session.cleanup(); }
        finally { provider.close(); }
      },
    };
    const issuance = readRayneoRealtimeOwnerIssuance(session);
    if (issuance !== undefined) {
      Object.defineProperty(result, RAYNEO_REALTIME_OWNER_ISSUANCE, {
        value: issuance, enumerable: false, writable: false, configurable: false,
      });
    }
    return Object.freeze(result);
  } catch (error) {
    provider.close();
    throw error;
  }
}

function buildRayneoDebugLiveSessionProjection(
  owner: Phase0SharedSessionOwner | undefined,
  binding: RayneoRealtimeAudioBinding,
  issuance: RayneoRealtimeOwnerIssuanceProjection,
): RayneoDemoLiveSessionOutput {
  if (owner === undefined) throw new Error('RAYNEO_DEBUG_OWNER_REQUIRED');
  if (issuance.sessionId !== binding.sessionId || issuance.deviceId !== binding.deviceId ||
      issuance.clientInstanceId !== binding.clientInstanceId) {
    throw new Error('RAYNEO_DEBUG_LIVE_ISSUANCE_BINDING_DRIFT');
  }
  const eligible = owner.sessions.eligibleRayneoSessions(binding.deviceId, binding.clientInstanceId);
  if (eligible.length !== 1 || eligible[0]!.sessionId !== binding.sessionId ||
      eligible[0]!.deviceId !== binding.deviceId || eligible[0]!.clientInstanceId !== binding.clientInstanceId) {
    throw new Error(eligible.length > 1 ? 'ELIGIBLE_SHARED_SESSION_AMBIGUOUS' : 'ELIGIBLE_SHARED_SESSION_NOT_FOUND');
  }
  const selected = eligible[0]!;
  const openedAt = new Date(binding.openedAt).toISOString();
  const expiresAt = new Date(binding.expiresAt).toISOString();
  const selectedExpiresAt = new Date(selected.expiresAtMs).toISOString();
  const selectedCleanupDeadlineAt = new Date(selected.cleanupDeadlineAtMs).toISOString();
  // The shared owner session is the continuity window (currently one hour),
  // while a cordless transport credential is deliberately shorter lived
  // (currently fifteen minutes).  The owner window must contain the transport
  // window; requiring equal expiries makes every real bootstrap fail only
  // after LiveKit has connected.
  if (selected.expiresAtMs < binding.expiresAt || selected.cleanupDeadlineAtMs < selected.expiresAtMs) {
    throw new Error('RAYNEO_DEBUG_OWNER_EXPIRY_DRIFT');
  }
  if (issuance.receipt.aliases.tokenExpiresAt !== issuance.tokenExpiresAt ||
      Date.parse(issuance.tokenExpiresAt) <= Date.parse(openedAt) ||
      Date.parse(issuance.tokenExpiresAt) > Date.parse(expiresAt)) {
    throw new Error('RAYNEO_DEBUG_LIVE_TOKEN_EXPIRY_DRIFT');
  }
  return Object.freeze({
    sessionId: binding.sessionId,
    deviceId: binding.deviceId,
    clientInstanceId: binding.clientInstanceId,
    openedAt,
    expiresAt: selectedExpiresAt,
    cleanupDeadlineAt: selectedCleanupDeadlineAt,
    continuityExpiresAt: selectedExpiresAt,
    leaseExpiresAt: issuance.tokenExpiresAt,
    connectionId: selected.connectionId,
    ownerConnectionEpoch: String(selected.connectionEpoch),
    activeDeviceLeaseVersion: String(selected.activeDeviceLeaseVersion),
    livekit: issuance.receipt.aliases,
  });
}

export function isRayneoAutoApprovePairingEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.PAIOS_DEMO_ROAMING === '1' &&
    environment.PAIOS_GATE_A_LOCAL_DEVICE === '1' &&
    environment.PAIOS_RAYNEO_AUTO_APPROVE_PAIRING === '1';
}

const RAYNEO_REALTIME_REQUIRED_ENVIRONMENT = Object.freeze([
  'PAIOS_RAYNEO_LIVEKIT_URL',
  'PAIOS_RAYNEO_LIVEKIT_API_KEY',
  'PAIOS_RAYNEO_LIVEKIT_API_SECRET',
  'PAIOS_RAYNEO_STT_MODEL',
] as const);
const RAYNEO_REQUIRE_DIARIZATION_ENVIRONMENT = 'PAIOS_RAYNEO_REQUIRE_DIARIZATION';
const RAYNEO_STT_DEADLINE_ENVIRONMENT = 'PAIOS_RAYNEO_STT_DEADLINE_MS';
const RAYNEO_STT_URL_ENVIRONMENT = 'PAIOS_RAYNEO_STT_URL';

export function loadRayneoRealtimeAudioConfig(
  environment: NodeJS.ProcessEnv = process.env,
  providerConfig?: RayneoProviderConfig,
): RayneoRealtimeAudioConfig | undefined {
  const present = RAYNEO_REALTIME_REQUIRED_ENVIRONMENT.filter(
    (name) => environment[name] !== undefined,
  );
  const diarizationEndpointUrl = environment.PAIOS_RAYNEO_DIARIZATION_URL;
  const requireDiarizationRaw = environment[RAYNEO_REQUIRE_DIARIZATION_ENVIRONMENT];
  const sttDeadlineRaw = environment[RAYNEO_STT_DEADLINE_ENVIRONMENT];
  const sttEndpointUrl = environment[RAYNEO_STT_URL_ENVIRONMENT] ??
    'http://127.0.0.1:8000/v1/audio/transcriptions';
  if (requireDiarizationRaw !== undefined && requireDiarizationRaw !== '0' && requireDiarizationRaw !== '1') {
    throw new Error('RAYNEO_REQUIRE_DIARIZATION_INVALID');
  }
  if (
    present.length === 0 && diarizationEndpointUrl === undefined &&
    requireDiarizationRaw === undefined && sttDeadlineRaw === undefined &&
    environment[RAYNEO_STT_URL_ENVIRONMENT] === undefined
  ) return undefined;
  if (present.length !== RAYNEO_REALTIME_REQUIRED_ENVIRONMENT.length) {
    throw new Error('RAYNEO_REALTIME_CONFIG_PARTIAL');
  }
  if (requireDiarizationRaw === '1' && diarizationEndpointUrl === undefined) {
    throw new Error('RAYNEO_DIARIZATION_REQUIRED');
  }
  const resolvedProvider = providerConfig ?? loadRayneoProviderConfig(environment);
  if (sttDeadlineRaw !== undefined && (
    !/^[1-9][0-9]*$/u.test(sttDeadlineRaw) ||
    Number(sttDeadlineRaw) < 1_000 || Number(sttDeadlineRaw) > 30_000
  )) throw new Error('INVALID_PROCESS_ENV:PAIOS_RAYNEO_STT_DEADLINE_MS');
  try {
    const parsedStt = new URL(sttEndpointUrl);
    const port = Number(parsedStt.port);
    if (
      !Number.isSafeInteger(port) || port < 1_024 || port > 65_535 ||
      sttEndpointUrl !== `http://127.0.0.1:${port}/v1/audio/transcriptions`
    ) throw new Error('INVALID_PROCESS_ENV:PAIOS_RAYNEO_STT_URL');
  } catch {
    throw new Error('INVALID_PROCESS_ENV:PAIOS_RAYNEO_STT_URL');
  }
  return Object.freeze({
    livekitUrl: requiredEnvironment(environment, 'PAIOS_RAYNEO_LIVEKIT_URL'),
    clientLivekitUrl: requiredEnvironment(environment, 'PAIOS_RAYNEO_LIVEKIT_URL'),
    apiKey: requiredEnvironment(environment, 'PAIOS_RAYNEO_LIVEKIT_API_KEY'),
    apiSecret: requiredEnvironment(environment, 'PAIOS_RAYNEO_LIVEKIT_API_SECRET'),
    sttEndpointUrl,
    sttModel: requiredEnvironment(environment, 'PAIOS_RAYNEO_STT_MODEL'),
    sttDeadlineMs: sttDeadlineRaw === undefined ? 30_000 : Number(sttDeadlineRaw),
    ollamaModel: resolvedProvider.model,
    ollamaEndpointUrl: rayneoRealtimeEndpointBase(resolvedProvider.endpointUrl),
    windowSeconds: 4,
    ...(diarizationEndpointUrl === undefined ? {} : { diarizationEndpointUrl }),
  });
}

type RayneoPairingRegistryPort = Pick<RayneoPairingRegistry, 'read' | 'writePaired' | 'revoke'>;
type RayneoProviderReadinessPort = Pick<RayneoProviderReadinessSupervisor, 'inspect'> &
  Partial<Pick<RayneoProviderReadinessSupervisor, 'selectedProfile' | 'selectProviderProfile'>>;

export interface NativeHermesExecution {
  readonly isReady: () => boolean;
}

export type GatewayStartupMode =
  | 'demo-roaming'
  | 'visual-legacy'
  | 'persistent-roaming'
  | 'supervised-device-lan';

const DEMO_ROAMING_ALLOWED_RAYNEO_ENVIRONMENT = new Set([
  'PAIOS_RAYNEO_PROXY_ATTESTATION_SECRET',
  'PAIOS_RAYNEO_AUTO_APPROVE_PAIRING',
  ...RAYNEO_REALTIME_REQUIRED_ENVIRONMENT,
  'PAIOS_RAYNEO_DIARIZATION_URL',
  'PAIOS_RAYNEO_OLLAMA_URL',
  RAYNEO_PROVIDER_BACKEND_ENVIRONMENT,
  RAYNEO_PROVIDER_ENDPOINT_ENVIRONMENT,
  RAYNEO_PROVIDER_MODEL_ENVIRONMENT,
  'PAIOS_RAYNEO_PROVIDER_PRELOAD_COUNT',
  'PAIOS_RAYNEO_PROVIDER_PS_COUNT',
  'PAIOS_RAYNEO_PROVIDER_MODEL_DIGEST',
  'PAIOS_RAYNEO_PROVIDER_CONTEXT_LENGTH',
  'PAIOS_RAYNEO_PROVIDER_SIZE_BYTES',
  'PAIOS_RAYNEO_PROVIDER_VRAM_BYTES',
  'PAIOS_RAYNEO_PROVIDER_KEEP_ALIVE',
  'PAIOS_RAYNEO_PROVIDER_CAPABILITIES',
  'PAIOS_RAYNEO_MODEL_RESIDENCY_EXPIRES_AT_UTC',
  RAYNEO_STT_DEADLINE_ENVIRONMENT,
  RAYNEO_STT_URL_ENVIRONMENT,
  RAYNEO_REQUIRE_DIARIZATION_ENVIRONMENT,
]);

function isDemoRoamingConflict(name: string): boolean {
  return name === 'PAIOS_ROAMING_PERSISTENT_RUNTIME' ||
    name === 'PAIOS_PROXY_ATTESTATION_FILE' ||
    name === 'PAIOS_RAYNEO_VISUAL_LOOP' ||
    name === 'PAIOS_RAYNEO_CORDLESS' ||
    name.startsWith('PAIOS_T15_') ||
    name.startsWith('DEVICE_LAN_') ||
    name.startsWith('LIVEKIT_') ||
    name.startsWith('STT_') ||
    (name.startsWith('PAIOS_RAYNEO_') && !DEMO_ROAMING_ALLOWED_RAYNEO_ENVIRONMENT.has(name));
}

export function selectGatewayStartupMode(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayStartupMode {
  const demoRoaming = environment.PAIOS_DEMO_ROAMING;
  if (demoRoaming !== undefined && demoRoaming !== '1') {
    throw new Error('DEMO_ROAMING_FLAG_INVALID');
  }
  const localDevice = environment.PAIOS_GATE_A_LOCAL_DEVICE;
  if (localDevice !== undefined && localDevice !== '1') {
    throw new Error('LOCAL_DEVICE_FLAG_INVALID');
  }
  if (localDevice === '1' && demoRoaming !== '1') {
    throw new Error('LOCAL_DEVICE_REQUIRES_DEMO_ROAMING');
  }
  if (demoRoaming === '1') {
    const conflicts = Object.entries(environment)
      .filter(([name, value]) => value !== undefined && isDemoRoamingConflict(name))
      .map(([name]) => name)
      .sort();
    if (conflicts.length > 0) throw new Error(`DEMO_ROAMING_MODE_CONFLICT:${conflicts.join(',')}`);
    return 'demo-roaming';
  }
  if (environment.PAIOS_RAYNEO_VISUAL_LOOP === '1') return 'visual-legacy';
  if (environment.PAIOS_ROAMING_PERSISTENT_RUNTIME !== undefined) return 'persistent-roaming';
  return 'supervised-device-lan';
}

export interface GatewayStartupDependencies {
  readonly hermes?: NativeHermesExecution & {readonly gateway: Pick<V2GatewayLoopbackStartOptions, 'config' | 'adapter'>};
  readonly environment?: NodeJS.ProcessEnv;
  readonly listenerBinding?: {readonly host: string; readonly port: number};
  readonly installDemoSignalHandlers?: boolean;
  readonly publicRtcControl?: RealtimePublicControlController;
  readonly startPersistentGateway?: (owner?: Phase0SharedSessionOwner, publicRtcControl?: RealtimePublicControlController) => Promise<void>;
}

export interface DemoRoamingGatewayHandle {
  readonly mode: 'demo-roaming' | 'hermes-product';
  readonly host: string;
  readonly port: typeof PORT;
  readonly server: ReturnType<typeof createGatewayServer>;
  close(): Promise<void>;
}

async function closeListeningServer(server: ReturnType<typeof createGatewayServer>): Promise<void> {
  if (!server.listening) return;
  await withShutdownDrain(async()=>{
    const abort=()=>server.closeAllConnections(),signal=shutdownSignal()!;
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    try{await joinShutdown(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error===undefined?resolve():reject(error));}));}
    finally{signal.removeEventListener('abort',abort);}
  });
}

/**
 * Explicit V2-only host-loopback starter.  It binds the single fixed Gateway
 * listener and does not load a provider, read process.env, or construct the
 * legacy Phase0 product/Map runtime.  Owner readiness is asserted by the
 * composition before this seam is called.
 */
export interface V2GatewayLoopbackStartOptions {
  readonly config: GatewayRuntimeConfig;
  readonly adapter: DeviceSessionAdapter;
  readonly publicRtcControl: RealtimePublicControlController;
}

export interface V2GatewayLoopbackHandle {
  readonly mode: 'v2-only-loopback';
  readonly host: typeof HOST;
  readonly port: typeof PORT;
  readonly server: ReturnType<typeof createGatewayServer>;
  close(): Promise<void>;
}

export async function startV2GatewayLoopback(
  options: V2GatewayLoopbackStartOptions,
): Promise<V2GatewayLoopbackHandle> {
  if (options === undefined || options.config === undefined || options.adapter === undefined ||
      options.publicRtcControl === undefined) {
    throw new Error('V2_LOOPBACK_START_OPTIONS_REQUIRED');
  }
  const server = createGatewayServer(
    options.config,
    options.adapter,
    undefined,
    undefined,
    undefined,
    { persistentPublicOnly: true, v2Only: true, publicRtcControl: options.publicRtcControl },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, resolve);
    });
  } catch (error) {
    await closeListeningServer(server).catch(() => undefined);
    throw error;
  }
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeFlight ??= closeListeningServer(server);
    return closeFlight;
  };
  return Object.freeze({ mode: 'v2-only-loopback' as const, host: HOST, port: PORT, server, close });
}

export async function startDemoRoamingGateway(
  owner?: Phase0SharedSessionOwner,
  dependencies: GatewayStartupDependencies = {},
): Promise<DemoRoamingGatewayHandle> {
  const binding = dependencies.listenerBinding ?? {host: HOST, port: PORT};
  if (!['127.0.0.1', '0.0.0.0'].includes(binding.host) || !Number.isSafeInteger(binding.port) ||
      binding.port <= 1024 || binding.port >= 65536) throw new Error('GATEWAY_BINDING_INVALID');
  if (!dependencies.hermes || !dependencies.publicRtcControl) throw new Error('HERMES_EXECUTION_RESOURCES_CONFLICT');
  if (!dependencies.hermes.isReady()) throw new Error('HERMES_EXECUTION_NOT_READY');
  const server = createGatewayServer(dependencies.hermes.gateway.config, dependencies.hermes.gateway.adapter,
    undefined, undefined, undefined, {persistentPublicOnly: true, v2Only: true,
      listenerHostHeader: `127.0.0.1:${binding.port}`,
      publicHostHeader: dependencies.hermes.gateway.config.deviceLanSecurity.publicHost, publicRtcControl: dependencies.publicRtcControl});
  server.requestTimeout=DEFAULT_SHUTDOWN_DRAIN_MS;
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => closeFlight ??= withShutdownDrain(async () => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    const settled=await Promise.allSettled([joinShutdown(()=>dependencies.publicRtcControl!.close()),closeListeningServer(server)]);
    const errors=settled.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(errors.length)throw new AggregateError(errors,'GATEWAY_SHUTDOWN_FAILED');
  });
  const shutdown = (): void => {void close().then(() => process.exit(0), () => process.exit(1));};
  try {
    await new Promise<void>((resolve, reject) => {server.once('error', reject);server.listen(binding.port, binding.host, resolve);});
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  if (dependencies.installDemoSignalHandlers !== false) {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
  return Object.freeze({mode: 'hermes-product', host: binding.host, port: binding.port, server, close});
}

export async function startGateway(
  owner?: Phase0SharedSessionOwner,
  dependencies: GatewayStartupDependencies = {},
): Promise<void | DemoRoamingGatewayHandle> {
  const startupEnvironment = dependencies.environment ?? process.env;
  const publicRtcEnabled = parseRealtimePublicControlFeatureFlag(startupEnvironment);
  const mode = selectGatewayStartupMode(startupEnvironment);
  if (publicRtcEnabled && mode !== 'supervised-device-lan' && mode !== 'persistent-roaming') throw new Error('PUBLIC_RTC_MODE_UNSUPPORTED');
  if (publicRtcEnabled && dependencies.publicRtcControl === undefined) {
    throw new Error('PUBLIC_RTC_CONTROLLER_REQUIRED');
  }
  if (!publicRtcEnabled && dependencies.publicRtcControl !== undefined) {
    throw new Error('PUBLIC_RTC_CONTROLLER_DISABLED');
  }
  if (mode === 'demo-roaming') return startDemoRoamingGateway(owner, dependencies);
  if (mode === 'visual-legacy') throw new Error('LEGACY_RAYNEO_STARTUP_RETIRED');
  if (mode === 'persistent-roaming') {
    const startPersistent = dependencies.startPersistentGateway;
    if (!startPersistent) throw new Error('LEGACY_RAYNEO_STARTUP_RETIRED');
    if (publicRtcEnabled) await startPersistent(owner, dependencies.publicRtcControl);
    else await startPersistent(owner);
    return;
  }
  const config = loadConfig();
  const supervisorControl = config.supervisorControl;
  if (!supervisorControl) throw new Error('SUPERVISED_CONTROL_REQUIRED');
  let absenceCommitCount = 0;
  let cleanupReceiptCount = 0;
  const adapter = new DeviceSessionAdapter(config.gateway, {
    observeDirectLoop: (observation) => {
      process.stderr.write(`phase0 direct-loop ${JSON.stringify(observation)}\n`);
    },
    stageSupervisedAbsenceProofs: async () => {
      if (absenceCommitCount !== 0) throw new Error('ONE_SHOT_ABSENCE_ALREADY_STAGED');
      let committed = false;
      return {
        commit: async () => {
          if (committed) throw new Error('ONE_SHOT_ABSENCE_ALREADY_COMMITTED');
          committed = true;
          absenceCommitCount += 1;
        },
      };
    },
    persistSupervisedCleanupReceipt: async () => {
      if (absenceCommitCount !== 1 || cleanupReceiptCount !== 0) {
        throw new Error('ONE_SHOT_CLEANUP_RECEIPT_ORDER_INVALID');
      }
      cleanupReceiptCount += 1;
    },
  });
  const precontactWitness = config.precontactAdmission === 'CLOSED_PRECONTACT'
    ? new NoDevicePrecontactWitness()
    : undefined;
  if (config.precontactAdmission === 'OPEN_NORMAL') {
    await adapter.prearmSupervisedSession();
  }
  const server = createGatewayServer(
    config,
    adapter,
    precontactWitness,
    undefined,
    undefined,
    publicRtcEnabled ? { publicRtcControl: dependencies.publicRtcControl! } : {},
  );
  const cleanupGateway = () => adapter.close();
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    const timeout = setTimeout(() => process.exit(1), 300_000);
    timeout.unref();
    try {
      await dependencies.publicRtcControl?.close();
      await cleanupGateway();
      clearTimeout(timeout);
      process.stderr.write('gateway stopped by ' + signal + '\n');
      process.exit(0);
    } catch {
      clearTimeout(timeout);
      process.stderr.write('gateway cleanup failed during ' + signal + '\n');
      process.exit(1);
    }
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, resolve);
    });
  } catch (error) {
    await dependencies.publicRtcControl?.close().catch(() => undefined);
    await cleanupGateway().catch(() => undefined);
    throw error;
  }
  process.stderr.write(
    'phase0 gateway ' + config.precontactAdmission +
    ' listening on http://' + HOST + ':' + PORT + '\n',
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(entryPath).href === import.meta.url) {
  void startGateway().catch(() => {
    process.stderr.write('gateway startup failed\n');
    process.exitCode = 1;
  });
}
