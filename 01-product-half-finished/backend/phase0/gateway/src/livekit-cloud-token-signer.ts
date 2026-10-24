import { AccessToken, TrackSource, type VideoGrant } from 'livekit-server-sdk';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PII_NAMED_ID = /(?:^|[_-])(email|phone|address|password|token|secret)(?:$|[_-])/iu;
/** The one LiveKit identifier rule. Identities, rooms and aliases are system-minted (UUIDv7, digests), and random
 * hex routinely contains long digit runs, so only the shape and PII-named segments are rejected. */
export function isLiveKitOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !PII_NAMED_ID.test(value);
}
const SOURCE_VALUES = new Set(['microphone', 'camera'] as const);

export type LiveKitMediaSource = 'microphone' | 'camera';

export interface SecretReference {
  readonly name: string;
  readonly version?: string;
}

export interface SecretLease {
  readonly read: () => string;
  readonly release?: () => void;
}

export interface SecretResolverPort {
  resolve(reference: SecretReference): Promise<SecretLease>;
}

export interface LiveKitCloudGrantInput {
  readonly room: string;
  readonly roomJoin: true;
  readonly canPublish: boolean;
  readonly canSubscribe: boolean;
  readonly canPublishData: boolean;
  readonly canPublishSources: readonly LiveKitMediaSource[];
}

export interface LiveKitCloudTokenInput {
  readonly room: string;
  readonly identity: string;
  readonly name?: string;
  readonly ttlSeconds: number;
  readonly grants: LiveKitCloudGrantInput;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface LiveKitCloudTokenSignerPort {
  /** Internal non-wire project binding; prevents cross-Cloud-project signing. */
  assertProjectUrl(projectUrl: string): void;
  sign(input: LiveKitCloudTokenInput): Promise<string>;
  close(): void;
}

export interface LiveKitCloudTokenSignerOptions {
  readonly projectUrl: string;
  readonly apiKeyRef: SecretReference;
  readonly apiSecretRef: SecretReference;
  readonly secretResolver: SecretResolverPort;
  readonly signJwt?: (input: {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly request: LiveKitCloudTokenInput;
  }) => Promise<string>;
}

export class LiveKitCloudTokenSignerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LiveKitCloudTokenSignerError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new LiveKitCloudTokenSignerError(code);
}

function assertOpaque(value: unknown, code: string): string {
  if (!isLiveKitOpaqueId(value)) fail(code);
  return value;
}

export function assertCanonicalLiveKitCloudProjectUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 7 || value.length > 253 || value !== value.trim()) {
    fail('INVALID_LIVEKIT_CLOUD_URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_LIVEKIT_CLOUD_URL');
  }
  if (
    parsed.protocol !== 'wss:' ||
    parsed.hostname !== parsed.hostname.toLowerCase() ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== `wss://${parsed.host}`
  ) fail('INVALID_LIVEKIT_CLOUD_URL');
  return value;
}

/** Owner-supplied RoomService origin. Plain HTTP is limited to the shared loopback namespace. */
export function assertCanonicalLiveKitApiUrl(value: unknown): string {
  if (typeof value !== 'string' || !URL.canParse(value)) fail('INVALID_LIVEKIT_API_URL');
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) fail('INVALID_LIVEKIT_API_URL');
  return value;
}

export function livekitApiOrigin(projectUrl: string, apiUrl?: string): string {
  return apiUrl === undefined ? `https://${new URL(assertCanonicalLiveKitCloudProjectUrl(projectUrl)).host}`
    : assertCanonicalLiveKitApiUrl(apiUrl);
}

function assertGrant(value: LiveKitCloudGrantInput, expectedRoom: string): LiveKitCloudGrantInput {
  if (
    value === null || typeof value !== 'object' ||
    value.room !== expectedRoom || value.roomJoin !== true ||
    typeof value.canPublish !== 'boolean' || typeof value.canSubscribe !== 'boolean' ||
    typeof value.canPublishData !== 'boolean' || !Array.isArray(value.canPublishSources)
  ) fail('INVALID_LIVEKIT_GRANTS');
  const allowedKeys = new Set(['room', 'roomJoin', 'canPublish', 'canSubscribe', 'canPublishData', 'canPublishSources']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) fail('INVALID_LIVEKIT_GRANTS');
  const sources: LiveKitMediaSource[] = [];
  const seen = new Set<LiveKitMediaSource>();
  for (const source of value.canPublishSources) {
    if (typeof source !== 'string' || !SOURCE_VALUES.has(source as LiveKitMediaSource)) {
      fail('INVALID_LIVEKIT_GRANTS');
    }
    const typed = source as LiveKitMediaSource;
    if (seen.has(typed)) fail('INVALID_LIVEKIT_GRANTS');
    seen.add(typed);
    sources.push(typed);
  }
  if (value.canPublish !== (sources.length > 0)) fail('INVALID_LIVEKIT_GRANTS');
  return Object.freeze({ ...value, canPublishSources: Object.freeze(sources) });
}

/**
 * Convert the internal, non-wire grant vocabulary to the SDK's typed enum.
 * The successor contract intentionally exposes no screen-share capability.
 */
export function mapLiveKitGrantToServerGrant(input: LiveKitCloudGrantInput): VideoGrant {
  const grant = assertGrant(input, input.room);
  const canPublishSources = grant.canPublishSources.map((source) => (
    source === 'microphone' ? TrackSource.MICROPHONE : TrackSource.CAMERA
  ));
  return {
    room: grant.room,
    roomJoin: grant.roomJoin,
    canPublish: grant.canPublish,
    canSubscribe: grant.canSubscribe,
    canPublishData: grant.canPublishData,
    canPublishSources,
  };
}

function assertInput(value: LiveKitCloudTokenInput): LiveKitCloudTokenInput {
  if (value === null || typeof value !== 'object') fail('INVALID_LIVEKIT_TOKEN_INPUT');
  const room = assertOpaque(value.room, 'INVALID_LIVEKIT_ROOM');
  const identity = assertOpaque(value.identity, 'INVALID_LIVEKIT_IDENTITY');
  if (!Number.isSafeInteger(value.ttlSeconds) || value.ttlSeconds < 1 || value.ttlSeconds > 900) {
    fail('INVALID_LIVEKIT_TOKEN_TTL');
  }
  const grants = assertGrant(value.grants, room);
  return Object.freeze({
    ...value,
    room,
    identity,
    grants,
    ...(value.name === undefined ? {} : { name: assertOpaque(value.name, 'INVALID_LIVEKIT_NAME') }),
    ...(value.attributes === undefined ? {} : { attributes: Object.freeze({ ...value.attributes }) }),
  });
}

export class LiveKitCloudTokenSigner implements LiveKitCloudTokenSignerPort {
  readonly #projectUrl: string;
  readonly #apiKeyRef: SecretReference;
  readonly #apiSecretRef: SecretReference;
  readonly #secretResolver: SecretResolverPort;
  readonly #signJwt: LiveKitCloudTokenSignerOptions['signJwt'];
  #closed = false;

  constructor(options: LiveKitCloudTokenSignerOptions) {
    this.#projectUrl = assertCanonicalLiveKitCloudProjectUrl(options.projectUrl);
    if (!options.apiKeyRef || typeof options.apiKeyRef.name !== 'string' || options.apiKeyRef.name.length === 0) {
      fail('INVALID_LIVEKIT_API_KEY_REF');
    }
    if (!options.apiSecretRef || typeof options.apiSecretRef.name !== 'string' || options.apiSecretRef.name.length === 0) {
      fail('INVALID_LIVEKIT_API_SECRET_REF');
    }
    if (typeof options.secretResolver?.resolve !== 'function') fail('SECRET_RESOLVER_REQUIRED');
    this.#apiKeyRef = Object.freeze({ ...options.apiKeyRef });
    this.#apiSecretRef = Object.freeze({ ...options.apiSecretRef });
    this.#secretResolver = options.secretResolver;
    this.#signJwt = options.signJwt;
  }

  get projectUrl(): string {
    return this.#projectUrl;
  }

  assertProjectUrl(projectUrl: string): void {
    if (assertCanonicalLiveKitCloudProjectUrl(projectUrl) !== this.#projectUrl) fail('LIVEKIT_PROJECT_BINDING_MISMATCH');
  }

  async sign(input: LiveKitCloudTokenInput): Promise<string> {
    if (this.#closed) fail('TOKEN_SIGNER_CLOSED');
    const request = assertInput(input);
    let apiKeyLease: SecretLease | undefined;
    let apiSecretLease: SecretLease | undefined;
    try {
      apiKeyLease = await this.#secretResolver.resolve(this.#apiKeyRef);
      apiSecretLease = await this.#secretResolver.resolve(this.#apiSecretRef);
      const apiKey = apiKeyLease.read();
      const apiSecret = apiSecretLease.read();
      if (typeof apiKey !== 'string' || apiKey.length === 0 || typeof apiSecret !== 'string' || apiSecret.length === 0) {
        fail('LIVEKIT_CREDENTIAL_UNAVAILABLE');
      }
      const jwt = this.#signJwt === undefined
        ? await this.#signWithSdk(apiKey, apiSecret, request)
        : await this.#signJwt({ apiKey, apiSecret, request });
      if (typeof jwt !== 'string' || jwt.length < 1 || jwt.length > 8192 || /[\u0000-\u001f\u007f\s]/u.test(jwt)) {
        fail('LIVEKIT_TOKEN_INVALID');
      }
      return jwt;
    } catch (error) {
      if (error instanceof LiveKitCloudTokenSignerError) throw error;
      throw new LiveKitCloudTokenSignerError('LIVEKIT_TOKEN_SIGNING_FAILED');
    } finally {
      try { apiKeyLease?.release?.(); } catch { /* secret lease cleanup is best effort */ }
      try { apiSecretLease?.release?.(); } catch { /* secret lease cleanup is best effort */ }
    }
  }

  close(): void {
    this.#closed = true;
  }

  async #signWithSdk(apiKey: string, apiSecret: string, request: LiveKitCloudTokenInput): Promise<string> {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: request.identity,
      name: request.name ?? request.identity,
      ttl: request.ttlSeconds,
      ...(request.attributes === undefined ? {} : { attributes: { ...request.attributes } }),
    });
    token.addGrant(mapLiveKitGrantToServerGrant(request.grants));
    return token.toJwt();
  }
}

export const createLiveKitCloudTokenSigner = (
  options: LiveKitCloudTokenSignerOptions,
): LiveKitCloudTokenSigner => new LiveKitCloudTokenSigner(options);
