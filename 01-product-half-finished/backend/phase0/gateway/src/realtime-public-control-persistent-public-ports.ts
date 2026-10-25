import { GATEWAY_SECRET_ROOT } from './gateway-runtime-paths.ts';
import { resolve } from 'node:path';
import { publicApiOrigins } from './public-api-origins.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import {
  createLiveKitCloudParticipant,
  type LiveKitCloudParticipantPort,
  type LiveKitCloudRoomPort,
} from './livekit-cloud-participant.ts';
import {
  createLiveKitCloudTokenSigner,
  livekitApiOrigin,
  type LiveKitCloudTokenSignerPort,
  type SecretLease,
  type SecretReference,
  type SecretResolverPort,
} from './livekit-cloud-token-signer.ts';
import {
  isRealtimePublicControlRoute,
  type RealtimePublicControlBearerPort,
  type RealtimePublicControlEdgePort,
} from './realtime-public-control-controller.ts';
import type {
  RealtimeBearerContext,
  RealtimeOperation,
} from './realtime-public-control-runtime.ts';

const LOOPBACK_HOST = '127.0.0.1' as const;
const TRUSTED_EDGE = 'tencent-nginx-loopback-v1' as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const OPERATIONS = new Set<RealtimeOperation>([
  'bootstrap',
  'realtime_e2ee_key_resolve',
  'connected_credential_refresh',
  'media_stop',
  'end_continuity',
  'handoff',
]);


export const PERSISTENT_PUBLIC_SECRET_REFERENCES = Object.freeze({
  livekitApiKey: Object.freeze({ name: 'livekit-api-key' }),
  livekitApiSecret: Object.freeze({ name: 'livekit-api-secret' }),
  proxyAttestation: Object.freeze({ name: 'proxy-attestation' }),
  e2eeRootKey: Object.freeze({ name: 'e2ee-root-key' }),
});

export const PERSISTENT_PUBLIC_SECRET_PATHS = Object.freeze({
  livekitApiKey: resolve(GATEWAY_SECRET_ROOT, 'livekit-api-key'),
  livekitApiSecret: resolve(GATEWAY_SECRET_ROOT, 'livekit-api-secret'),
  proxyAttestation: resolve(GATEWAY_SECRET_ROOT, 'proxy-attestation'),
  e2eeRootKey: resolve(GATEWAY_SECRET_ROOT, 'e2ee-root-key'),
});

export type PersistentPublicSecretPaths = Readonly<Record<keyof typeof PERSISTENT_PUBLIC_SECRET_PATHS, string>>;

interface SecretSpec {
  readonly reference: SecretReference;
  readonly path: string;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  readonly pattern: RegExp;
}

const SECRET_SPECS: readonly SecretSpec[] = Object.freeze([
  Object.freeze({
    reference: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey,
    path: PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiKey,
    minimumBytes: 16,
    maximumBytes: 128,
    pattern: /^[A-Za-z0-9_-]+$/u,
  }),
  Object.freeze({
    reference: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    path: PERSISTENT_PUBLIC_SECRET_PATHS.livekitApiSecret,
    minimumBytes: 32,
    maximumBytes: 128,
    pattern: /^[A-Za-z0-9_-]+$/u,
  }),
  Object.freeze({
    reference: PERSISTENT_PUBLIC_SECRET_REFERENCES.proxyAttestation,
    path: PERSISTENT_PUBLIC_SECRET_PATHS.proxyAttestation,
    minimumBytes: 43,
    maximumBytes: 43,
    pattern: /^[A-Za-z0-9_-]{43}$/u,
  }),
  Object.freeze({
    reference: PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey,
    path: PERSISTENT_PUBLIC_SECRET_PATHS.e2eeRootKey,
    minimumBytes: 43,
    maximumBytes: 43,
    pattern: /^[A-Za-z0-9_-]{43}$/u,
  }),
]);

export interface PersistentPublicSecretFileFacts {
  readonly regular: boolean;
  readonly reparse: boolean;
}

export interface PersistentPublicSecretFileReader {
  inspect(path: string): PersistentPublicSecretFileFacts;
  read(path: string): Buffer;
}

export interface PersistentPublicOwnerProtectionPort {
  isOwnerProtected(path: string): boolean;
}

export interface PersistentPublicBearerAuthoritySnapshot {
  readonly tokenSha256: string;
  readonly principal: unknown;
  readonly deviceId: string;
  readonly capabilityRef?: unknown;
  readonly expiresAt: string;
  readonly scopes: readonly RealtimeOperation[];
}

export interface PersistentPublicBearerAuthorityPort {
  readonly isReady: () => boolean;
  readonly resolve: (input: Readonly<{
    tokenSha256: string;
    operation: RealtimeOperation;
  }>) => Promise<PersistentPublicBearerAuthoritySnapshot | undefined>;
  readonly close?: () => void | Promise<void>;
}

export interface PersistentPublicPortsReadinessStatus {
  readonly name: 'secret_files' | 'bearer_authority';
  readonly ready: boolean;
  readonly reason?: string;
}

export interface PersistentPublicPortsReadinessSnapshot {
  readonly ready: boolean;
  readonly statuses: readonly PersistentPublicPortsReadinessStatus[];
}

export interface PersistentRealtimePublicControlPortsOptions {
  readonly bearerAuthority: PersistentPublicBearerAuthorityPort;
  readonly secretPaths?: PersistentPublicSecretPaths;
  readonly livekitUrl?: string;
  readonly livekitApiUrl?: string;
  readonly publicApiUrl?: string;
  readonly legacyPublicApiUrls?: string;
  readonly ownerProtection: PersistentPublicOwnerProtectionPort;
  readonly secretFileReader?: PersistentPublicSecretFileReader;
  readonly room?: LiveKitCloudRoomPort;
  readonly now?: () => number;
}

export interface PersistentRealtimePublicControlPorts {
  readonly edge: RealtimePublicControlEdgePort;
  readonly bearer: RealtimePublicControlBearerPort;
  readonly secretResolver: SecretResolverPort;
  readonly tokenSigner: LiveKitCloudTokenSignerPort;
  readonly participant: LiveKitCloudParticipantPort;
  readonly participantForDevice?: (deviceId: string) => LiveKitCloudParticipantPort | undefined;
  readonly livekitUrl: string;
  readonly livekitApiUrl?: string;
  readonly livekitApiKeyRef: SecretReference;
  readonly livekitApiSecretRef: SecretReference;
  readonly e2eeRootKeyRef: SecretReference;
  readonly readiness: () => PersistentPublicPortsReadinessSnapshot;
  readonly close: () => Promise<void>;
}

export class PersistentRealtimePublicControlPortsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 503) {
    super(code);
    this.name = 'PersistentRealtimePublicControlPortsError';
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, status = 503): never {
  throw new PersistentRealtimePublicControlPortsError(code, status);
}

export function createPersistentPublicSecretFileReader(): PersistentPublicSecretFileReader {
  return Object.freeze({
    inspect(path: string): PersistentPublicSecretFileFacts {
      const facts = lstatSync(path);
      return Object.freeze({ regular: facts.isFile(), reparse: facts.isSymbolicLink() });
    },
    read: (path: string): Buffer => readFileSync(path),
  });
}

function sameReference(left: SecretReference, right: SecretReference): boolean {
  return left.name === right.name && left.version === right.version;
}

function exactReference(value: SecretReference): SecretReference {
  if (value === null || typeof value !== 'object' || !SECRET_NAME.test(value.name) || value.version !== undefined) {
    fail('PERSISTENT_PUBLIC_SECRET_REF_INVALID');
  }
  if (Object.keys(value).length !== 1 || Object.getOwnPropertySymbols(value).length !== 0) {
    fail('PERSISTENT_PUBLIC_SECRET_REF_INVALID');
  }
  return value;
}

function configuredSpecs(paths: PersistentPublicSecretPaths): readonly SecretSpec[] {
  return SECRET_SPECS.map(spec => {
    const key = Object.keys(PERSISTENT_PUBLIC_SECRET_REFERENCES).find(candidate =>
      PERSISTENT_PUBLIC_SECRET_REFERENCES[candidate as keyof typeof paths].name === spec.reference.name,
    ) as keyof typeof paths;
    return {...spec, path: paths[key]};
  });
}

function specFor(reference: SecretReference, specs: readonly SecretSpec[]): SecretSpec {
  const normalized = exactReference(reference);
  const spec = specs.find((candidate) => sameReference(candidate.reference, normalized));
  if (spec === undefined) fail('PERSISTENT_PUBLIC_SECRET_REF_UNKNOWN');
  return spec;
}

function inspectSecretSpec(
  spec: SecretSpec,
  reader: PersistentPublicSecretFileReader,
  ownerProtection: PersistentPublicOwnerProtectionPort,
): boolean {
  try {
    const facts = reader.inspect(spec.path);
    return facts.regular === true && facts.reparse === false && ownerProtection.isOwnerProtected(spec.path) === true;
  } catch {
    return false;
  }
}

function readSecret(
  spec: SecretSpec,
  reader: PersistentPublicSecretFileReader,
  ownerProtection: PersistentPublicOwnerProtectionPort,
): SecretLease {
  if (!inspectSecretSpec(spec, reader, ownerProtection)) fail('PERSISTENT_PUBLIC_SECRET_FILE_NOT_READY');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(reader.read(spec.path));
  } catch {
    fail('PERSISTENT_PUBLIC_SECRET_FILE_UNAVAILABLE');
  }
  const text = bytes.toString('utf8');
  if (
    bytes.length < spec.minimumBytes || bytes.length > spec.maximumBytes ||
    !Buffer.from(text, 'utf8').equals(bytes) || !spec.pattern.test(text)
  ) {
    bytes.fill(0);
    fail('PERSISTENT_PUBLIC_SECRET_VALUE_INVALID');
  }
  let released = false;
  let readable: string | undefined = text;
  return Object.freeze({
    read: (): string => {
      if (released || readable === undefined) fail('PERSISTENT_PUBLIC_SECRET_LEASE_RELEASED');
      return readable;
    },
    release: (): void => {
      if (released) return;
      released = true;
      readable = undefined;
      bytes.fill(0);
    },
  });
}

export function createPersistentPublicSecretResolver(
  ownerProtection: PersistentPublicOwnerProtectionPort,
  reader: PersistentPublicSecretFileReader = createPersistentPublicSecretFileReader(),
  paths: PersistentPublicSecretPaths = PERSISTENT_PUBLIC_SECRET_PATHS,
): SecretResolverPort {
  if (typeof ownerProtection?.isOwnerProtected !== 'function' ||
      typeof reader?.inspect !== 'function' || typeof reader?.read !== 'function') {
    fail('PERSISTENT_PUBLIC_SECRET_READER_REQUIRED');
  }
  return Object.freeze({
    resolve: async (reference: SecretReference): Promise<SecretLease> => (
      readSecret(specFor(reference, configuredSpecs(paths)), reader, ownerProtection)
    ),
  });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeTextEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function rawHeaderValues(rawHeaders: readonly string[], expected: string): readonly string[] {
  if (rawHeaders.length % 2 !== 0) fail('PUBLIC_EDGE_HEADERS_INVALID', 403);
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === expected) values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function exactHeader(rawHeaders: readonly string[], name: string, expected: string): void {
  const values = rawHeaderValues(rawHeaders, name);
  if (values.length !== 1 || values[0]!.includes(',') || values[0] !== expected) {
    fail('PUBLIC_EDGE_HEADERS_INVALID', 403);
  }
}

function absentHeader(rawHeaders: readonly string[], name: string): void {
  if (rawHeaderValues(rawHeaders, name).length !== 0) fail('PUBLIC_EDGE_HEADERS_INVALID', 403);
}

function createEdgePort(secretResolver: SecretResolverPort, isClosed: () => boolean, publicHosts: readonly string[]): RealtimePublicControlEdgePort {
  return Object.freeze({
    authorize: async (
      input: Parameters<RealtimePublicControlEdgePort['authorize']>[0],
    ): Promise<void> => {
      if (isClosed()) fail('PERSISTENT_PUBLIC_PORTS_CLOSED');
      if (
        !isRealtimePublicControlRoute(input.method, input.url) || input.remoteAddress !== LOOPBACK_HOST ||
        input.controlHost !== LOOPBACK_HOST
      ) fail('PUBLIC_EDGE_REQUEST_DENIED', 403);
      const hosts = rawHeaderValues(input.rawHeaders, 'host');
      if (hosts.length !== 1 || !publicHosts.includes(hosts[0]!)) fail('PUBLIC_EDGE_HEADERS_INVALID', 403);
      exactHeader(input.rawHeaders, 'x-forwarded-host', hosts[0]!);
      exactHeader(input.rawHeaders, 'x-forwarded-proto', 'https');
      exactHeader(input.rawHeaders, 'x-paios-trusted-edge', TRUSTED_EDGE);
      absentHeader(input.rawHeaders, 'forwarded');
      absentHeader(input.rawHeaders, 'x-real-ip');
      absentHeader(input.rawHeaders, 'upgrade');
      absentHeader(input.rawHeaders, 'connection');

      const forwarded = rawHeaderValues(input.rawHeaders, 'x-forwarded-for');
      const family = rawHeaderValues(input.rawHeaders, 'x-paios-trusted-source-family');
      if (
        forwarded.length !== 1 || forwarded[0]!.includes(',') || isIP(forwarded[0]!) === 0 ||
        family.length !== 1 || family[0]!.includes(',') ||
        family[0] !== (isIP(forwarded[0]!) === 4 ? 'ipv4' : 'ipv6')
      ) fail('PUBLIC_EDGE_SOURCE_INVALID', 403);

      const allowedPaios = new Set([
        'x-paios-proxy-attestation', 'x-paios-trusted-edge', 'x-paios-trusted-source-family',
      ]);
      if (input.rawHeaders.some((name: string, index: number) => index % 2 === 0 &&
          name.toLowerCase().startsWith('x-paios-') && !allowedPaios.has(name.toLowerCase()))) {
        fail('PUBLIC_EDGE_HEADERS_INVALID', 403);
      }

      const attestations = rawHeaderValues(input.rawHeaders, 'x-paios-proxy-attestation');
      if (attestations.length !== 1 || attestations[0]!.includes(',')) fail('PUBLIC_EDGE_ATTESTATION_INVALID', 403);
      const lease = await secretResolver.resolve(PERSISTENT_PUBLIC_SECRET_REFERENCES.proxyAttestation);
      try {
        if (!constantTimeTextEqual(attestations[0]!, lease.read())) fail('PUBLIC_EDGE_ATTESTATION_INVALID', 403);
      } finally {
        lease.release?.();
      }
    },
  });
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 35) fail('PUBLIC_BEARER_SNAPSHOT_INVALID', 401);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('PUBLIC_BEARER_SNAPSHOT_INVALID', 401);
  }
  return value;
}

function normalizeSnapshot(
  value: PersistentPublicBearerAuthoritySnapshot,
  expectedHash: string,
  operation: RealtimeOperation,
  now: number,
): RealtimeBearerContext {
  const optional = [
    ...(value.capabilityRef === undefined ? [] : ['capabilityRef']),
  ];
  const expectedKeys = ['deviceId', 'expiresAt', 'principal', 'scopes', 'tokenSha256', ...optional].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      Object.getOwnPropertySymbols(value).length !== 0) fail('PUBLIC_BEARER_SNAPSHOT_INVALID', 401);
  if (!SHA256.test(value.tokenSha256) || !constantTimeTextEqual(value.tokenSha256, expectedHash) ||
      value.principal === undefined || value.principal === null || !DEVICE_ID.test(value.deviceId)) {
    fail('PUBLIC_BEARER_SNAPSHOT_INVALID', 401);
  }
  const expiresAt = canonicalTimestamp(value.expiresAt);
  if (!Number.isFinite(now) || Date.parse(expiresAt) <= now || !Array.isArray(value.scopes) || value.scopes.length === 0 ||
      value.scopes.length !== new Set(value.scopes).size || value.scopes.some((scope) => !OPERATIONS.has(scope)) ||
      !value.scopes.includes(operation)) fail('PUBLIC_BEARER_NOT_AUTHORIZED', 403);
  return Object.freeze({
    principal: value.principal,
    deviceId: value.deviceId,
    ...(value.capabilityRef === undefined ? {} : { capabilityRef: value.capabilityRef }),
    expiresAt,
    scopes: Object.freeze([...value.scopes]),
  });
}

function createBearerPort(
  authority: PersistentPublicBearerAuthorityPort,
  now: () => number,
  isClosed: () => boolean,
): RealtimePublicControlBearerPort {
  return Object.freeze({
    authorize: async (
      input: Parameters<RealtimePublicControlBearerPort['authorize']>[0],
    ): Promise<RealtimeBearerContext> => {
      if (isClosed()) fail('PERSISTENT_PUBLIC_PORTS_CLOSED');
      if (!authority.isReady()) fail('PUBLIC_BEARER_AUTHORITY_NOT_READY');
      if (!OPERATIONS.has(input.operation) || typeof input.token !== 'string' ||
          input.token.length < 16 || input.token.length > 8192 || /[\u0000-\u0020\u007f,]/u.test(input.token)) {
        fail('CONTROL_CAPABILITY_INVALID', 401);
      }
      const tokenSha256 = createHash('sha256').update(input.token, 'utf8').digest('hex');
      let snapshot: PersistentPublicBearerAuthoritySnapshot | undefined;
      try {
        snapshot = await authority.resolve({ tokenSha256, operation: input.operation });
      } catch {
        fail('PUBLIC_BEARER_AUTHORITY_UNAVAILABLE');
      }
      if (snapshot === undefined) fail('CONTROL_CAPABILITY_INVALID', 401);
      return normalizeSnapshot(snapshot, tokenSha256, input.operation, now());
    },
  });
}

function secretFilesReady(
  specs: readonly SecretSpec[],
  reader: PersistentPublicSecretFileReader,
  ownerProtection: PersistentPublicOwnerProtectionPort,
): boolean {
  return specs
    .filter((spec) => !sameReference(spec.reference, PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey))
    .every((spec) => inspectSecretSpec(spec, reader, ownerProtection));
}

export function createPersistentRealtimePublicControlPorts(
  options: PersistentRealtimePublicControlPortsOptions,
): PersistentRealtimePublicControlPorts {
  if (typeof options?.bearerAuthority?.isReady !== 'function' ||
      typeof options.bearerAuthority.resolve !== 'function' ||
      typeof options?.ownerProtection?.isOwnerProtected !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    fail('PERSISTENT_PUBLIC_PORT_OPTIONS_INVALID');
  }
  if (!options.livekitUrl || !options.publicApiUrl) fail('PERSISTENT_PUBLIC_ENDPOINTS_REQUIRED');
  const reader = options.secretFileReader ?? createPersistentPublicSecretFileReader();
  if (typeof reader.inspect !== 'function' || typeof reader.read !== 'function') {
    fail('PERSISTENT_PUBLIC_SECRET_READER_REQUIRED');
  }
  const now = options.now ?? Date.now;
  const secretResolver = createPersistentPublicSecretResolver(options.ownerProtection, reader, options.secretPaths);
  let closed = false;
  const edge = createEdgePort(secretResolver, () => closed, publicApiOrigins(options.publicApiUrl, options.legacyPublicApiUrls).map(origin => new URL(origin).host));
  const bearer = createBearerPort(options.bearerAuthority, now, () => closed);
  const tokenSigner = createLiveKitCloudTokenSigner({
    projectUrl: options.livekitUrl,
    apiKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey,
    apiSecretRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    secretResolver,
  });
  const participant = createLiveKitCloudParticipant(options.room, options.livekitApiUrl);
  let closeFlight: Promise<void> | undefined;
  const readiness = (): PersistentPublicPortsReadinessSnapshot => {
    const filesReady = !closed && secretFilesReady(configuredSpecs(options.secretPaths ?? PERSISTENT_PUBLIC_SECRET_PATHS), reader, options.ownerProtection);
    let authorityReady = false;
    if (!closed) {
      try { authorityReady = options.bearerAuthority.isReady() === true; } catch { authorityReady = false; }
    }
    const statuses: readonly PersistentPublicPortsReadinessStatus[] = Object.freeze([
      Object.freeze({
        name: 'secret_files' as const,
        ready: filesReady,
        ...(filesReady ? {} : { reason: closed ? 'closed' : 'secret_files_not_ready' }),
      }),
      Object.freeze({
        name: 'bearer_authority' as const,
        ready: authorityReady,
        ...(authorityReady ? {} : { reason: closed ? 'closed' : 'bearer_authority_not_ready' }),
      }),
    ]);
    return Object.freeze({ ready: statuses.every((status) => status.ready), statuses });
  };
  const close = (): Promise<void> => {
    closeFlight ??= (async () => {
      closed = true;
      const failures: unknown[] = [];
      try { await participant.close(); } catch (error) { failures.push(error); }
      try { tokenSigner.close(); } catch (error) { failures.push(error); }
      try { await options.bearerAuthority.close?.(); } catch (error) { failures.push(error); }
      if (failures.length !== 0) fail('PERSISTENT_PUBLIC_PORT_CLOSE_FAILED');
    })();
    return closeFlight;
  };
  return Object.freeze({
    edge,
    bearer,
    secretResolver,
    tokenSigner,
    participant,
    livekitUrl: options.livekitUrl,
    livekitApiUrl: livekitApiOrigin(options.livekitUrl, options.livekitApiUrl),
    livekitApiKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey,
    livekitApiSecretRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    e2eeRootKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey,
    readiness,
    close,
  });
}
