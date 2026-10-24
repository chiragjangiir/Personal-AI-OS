import {
  type CanonicalLiveKitCloudProjectUrl,
  type InternalLiveKitMediaSource,
  type InternalOpaqueExternalAlias,
  type InternalOpaqueIdentifier,
  type InternalOpaqueOwnerValue,
  type InternalRoomOptionsReference,
  type InternalSignedAccessToken,
  type LiveKitCloudAdapterOptions,
  type LiveKitCloudAdapterPorts,
  type LiveKitCloudConnectInput,
  type LiveKitCloudConnection,
  type LiveKitCloudGrantPolicy,
  type LiveKitCloudMediaBinding,
  type LiveKitCloudTokenRequest,
} from './types.ts';

const PROJECT_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?\.livekit\.cloud$/u;
const OPAQUE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/u;
const OPAQUE_IDENTIFIER_PII_PATTERN = /(?:\d{7,}|(?:^|[_-])(email|phone|address|password|token)(?:$|[_-]))/iu;
const SOURCE_VALUES = new Set<InternalLiveKitMediaSource>([
  'microphone',
  'camera',
  'screen_share',
]);
const GRANT_KEYS = new Set([
  'room',
  'roomJoin',
  'canPublish',
  'canSubscribe',
  'canPublishData',
  'canPublishSources',
]);
const BINDING_KEYS = new Set([
  'realtimeSessionRef',
  'deviceLeaseRef',
  'continuityId',
  'transportAliases',
]);
const INPUT_KEYS = new Set([
  'projectUrl',
  'roomName',
  'identity',
  'binding',
  'ttlSeconds',
  'grants',
  'e2eeRoomOptionsReference',
]);

export type LiveKitCloudAdapterErrorCode =
  | 'INVALID_PROJECT_URL'
  | 'INVALID_OPAQUE_IDENTIFIER'
  | 'INVALID_TRANSPORT_ALIASES'
  | 'INVALID_MEDIA_BINDING'
  | 'INVALID_GRANTS'
  | 'INVALID_TTL'
  | 'INVALID_CLOCK'
  | 'INVALID_ROOM_OPTIONS_REFERENCE'
  | 'INVALID_PORTS'
  | 'TOKEN_SIGNING_FAILED'
  | 'TOKEN_INVALID'
  | 'ROOM_CONNECT_FAILED'
  | 'ROOM_DISCONNECT_FAILED';

/** Errors contain only stable codes so injected provider errors cannot leak. */
export class LiveKitCloudAdapterError extends Error {
  readonly code: LiveKitCloudAdapterErrorCode;

  constructor(code: LiveKitCloudAdapterErrorCode) {
    super(code);
    this.name = 'LiveKitCloudAdapterError';
    this.code = code;
  }
}

function fail(code: LiveKitCloudAdapterErrorCode): never {
  throw new LiveKitCloudAdapterError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, code: LiveKitCloudAdapterErrorCode): Record<string, unknown> {
  if (!isRecord(value)) fail(code);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: LiveKitCloudAdapterErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
}

/** Validate a room or participant transport identifier without accepting PII-shaped values. */
export function assertOpaqueIdentifier(value: unknown): InternalOpaqueIdentifier {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 64 ||
    value !== value.trim() ||
    !OPAQUE_IDENTIFIER_PATTERN.test(value) ||
    OPAQUE_IDENTIFIER_PII_PATTERN.test(value)
  ) {
    fail('INVALID_OPAQUE_IDENTIFIER');
  }
  return value as InternalOpaqueIdentifier;
}

function assertOpaqueOwnerValue(value: unknown): InternalOpaqueOwnerValue {
  if (
    (typeof value === 'string' && (value.length === 0 || value !== value.trim())) ||
    (typeof value !== 'string' && (value === null || typeof value !== 'object' || Array.isArray(value)))
  ) {
    fail('INVALID_OPAQUE_IDENTIFIER');
  }
  return value as InternalOpaqueOwnerValue;
}

/** Validate one opaque external alias supplied by the owner port without modelling its fields. */
export function assertOpaqueExternalAlias(value: unknown): InternalOpaqueExternalAlias {
  try {
    return assertOpaqueOwnerValue(value) as InternalOpaqueExternalAlias;
  } catch (error) {
    if (error instanceof LiveKitCloudAdapterError) fail('INVALID_TRANSPORT_ALIASES');
    fail('INVALID_TRANSPORT_ALIASES');
  }
}

/** Validate the exact direct-media project URL form accepted by this adapter. */
export function assertCanonicalLiveKitCloudProjectUrl(
  value: unknown,
): CanonicalLiveKitCloudProjectUrl {
  if (typeof value !== 'string' || value.length < 20 || value.length > 253 || value !== value.trim()) {
    fail('INVALID_PROJECT_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_PROJECT_URL');
  }

  if (
    parsed.protocol !== 'wss:' ||
    parsed.hostname !== parsed.hostname.toLowerCase() ||
    !PROJECT_HOST_PATTERN.test(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== `wss://${parsed.hostname}`
  ) {
    fail('INVALID_PROJECT_URL');
  }

  return value as CanonicalLiveKitCloudProjectUrl;
}

export function isCanonicalLiveKitCloudProjectUrl(value: unknown): value is CanonicalLiveKitCloudProjectUrl {
  try {
    assertCanonicalLiveKitCloudProjectUrl(value);
    return true;
  } catch {
    return false;
  }
}

function assertTransportAliases(value: unknown): readonly InternalOpaqueExternalAlias[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    fail('INVALID_TRANSPORT_ALIASES');
  }
  const aliases: InternalOpaqueExternalAlias[] = [];
  const seen = new Set<InternalOpaqueExternalAlias>();
  for (const candidate of value) {
    let alias: InternalOpaqueExternalAlias;
    try {
      alias = assertOpaqueExternalAlias(candidate);
    } catch (error) {
      if (error instanceof LiveKitCloudAdapterError) fail('INVALID_TRANSPORT_ALIASES');
      fail('INVALID_TRANSPORT_ALIASES');
    }
    if (seen.has(alias)) fail('INVALID_TRANSPORT_ALIASES');
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases;
}

/** Validate only presence/array boundaries; owner values remain opaque and are not reshaped. */
export function assertLiveKitCloudMediaBinding(value: unknown): LiveKitCloudMediaBinding {
  const record = assertRecord(value, 'INVALID_MEDIA_BINDING');
  assertExactKeys(record, BINDING_KEYS, 'INVALID_MEDIA_BINDING');

  let realtimeSessionRef: InternalOpaqueOwnerValue;
  let deviceLeaseRef: InternalOpaqueOwnerValue;
  let continuityId: InternalOpaqueOwnerValue;
  let aliases: readonly InternalOpaqueExternalAlias[];
  try {
    realtimeSessionRef = assertOpaqueOwnerValue(record.realtimeSessionRef);
    deviceLeaseRef = assertOpaqueOwnerValue(record.deviceLeaseRef);
    continuityId = assertOpaqueOwnerValue(record.continuityId);
    aliases = assertTransportAliases(record.transportAliases);
  } catch (error) {
    if (error instanceof LiveKitCloudAdapterError) fail('INVALID_MEDIA_BINDING');
    fail('INVALID_MEDIA_BINDING');
  }

  return Object.freeze({
    realtimeSessionRef,
    deviceLeaseRef,
    continuityId,
    transportAliases: Object.freeze([...aliases]),
  });
}

function assertMediaSources(value: unknown): readonly InternalLiveKitMediaSource[] {
  if (!Array.isArray(value) || value.length > 3) fail('INVALID_GRANTS');
  const sources: InternalLiveKitMediaSource[] = [];
  const seen = new Set<string>();
  for (const source of value) {
    if (typeof source !== 'string' || !SOURCE_VALUES.has(source as InternalLiveKitMediaSource)) {
      fail('INVALID_GRANTS');
    }
    if (seen.has(source)) fail('INVALID_GRANTS');
    seen.add(source);
    sources.push(source as InternalLiveKitMediaSource);
  }
  return Object.freeze(sources);
}

/** Validate grants before the injected signer is allowed to run. */
export function assertLiveKitCloudGrantPolicy(
  value: unknown,
  expectedRoom: InternalOpaqueIdentifier,
): LiveKitCloudGrantPolicy {
  const record = assertRecord(value, 'INVALID_GRANTS');
  assertExactKeys(record, GRANT_KEYS, 'INVALID_GRANTS');
  const room = assertOpaqueIdentifier(record.room);
  if (
    room !== expectedRoom ||
    record.roomJoin !== true ||
    typeof record.canPublish !== 'boolean' ||
    typeof record.canSubscribe !== 'boolean' ||
    typeof record.canPublishData !== 'boolean' ||
    !Object.hasOwn(record, 'canPublishSources')
  ) {
    fail('INVALID_GRANTS');
  }

  const canPublishSources = assertMediaSources(record.canPublishSources);
  if ((record.canPublish && canPublishSources.length === 0)
    || (!record.canPublish && canPublishSources.length !== 0)) {
    fail('INVALID_GRANTS');
  }

  const grants: LiveKitCloudGrantPolicy = {
    room,
    roomJoin: true,
    canPublish: record.canPublish,
    canSubscribe: record.canSubscribe,
    canPublishData: record.canPublishData,
    canPublishSources,
  };
  return Object.freeze(grants);
}

function assertRoomOptionsReference(value: unknown): InternalRoomOptionsReference {
  if (!isRecord(value)) fail('INVALID_ROOM_OPTIONS_REFERENCE');
  return value as InternalRoomOptionsReference;
}

function assertPorts(value: unknown): LiveKitCloudAdapterPorts {
  const record = assertRecord(value, 'INVALID_PORTS');
  const room = assertRecord(record.room, 'INVALID_PORTS');
  const tokenSigner = assertRecord(record.tokenSigner, 'INVALID_PORTS');
  if (typeof room.connect !== 'function' || typeof room.disconnect !== 'function') fail('INVALID_PORTS');
  if (typeof tokenSigner.sign !== 'function') fail('INVALID_PORTS');
  return value as LiveKitCloudAdapterPorts;
}

function assertTtl(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 900) {
    fail('INVALID_TTL');
  }
  return value;
}

function assertClockValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INVALID_CLOCK');
  return value;
}

function assertConnectInput(value: unknown): {
  readonly projectUrl: CanonicalLiveKitCloudProjectUrl;
  readonly roomName: InternalOpaqueIdentifier;
  readonly identity: InternalOpaqueIdentifier;
  readonly binding: LiveKitCloudMediaBinding;
  readonly ttlSeconds: number;
  readonly grants: LiveKitCloudGrantPolicy;
  readonly e2eeRoomOptionsReference: InternalRoomOptionsReference;
} {
  const record = assertRecord(value, 'INVALID_MEDIA_BINDING');
  assertExactKeys(record, INPUT_KEYS, 'INVALID_MEDIA_BINDING');
  const roomName = assertOpaqueIdentifier(record.roomName);
  if (!Object.hasOwn(record, 'e2eeRoomOptionsReference')) fail('INVALID_ROOM_OPTIONS_REFERENCE');
  const e2eeRoomOptionsReference = assertRoomOptionsReference(record.e2eeRoomOptionsReference);
  const result = {
    projectUrl: assertCanonicalLiveKitCloudProjectUrl(record.projectUrl),
    roomName,
    identity: assertOpaqueIdentifier(record.identity),
    binding: assertLiveKitCloudMediaBinding(record.binding),
    ttlSeconds: assertTtl(record.ttlSeconds),
    grants: assertLiveKitCloudGrantPolicy(record.grants, roomName),
    e2eeRoomOptionsReference,
  };
  return result;
}

function assertSignedToken(value: unknown): InternalSignedAccessToken {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8192 ||
    /[\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    fail('TOKEN_INVALID');
  }
  return value as InternalSignedAccessToken;
}

/**
 * Thin LiveKit Cloud direct-media adapter.  All SDK work is injected through
 * ports so unit tests remain offline and this package owns no provider credential.
 */
export class LiveKitCloudAdapter {
  readonly #ports: LiveKitCloudAdapterPorts;
  readonly #nowEpochSeconds: () => number;

  constructor(options: LiveKitCloudAdapterOptions) {
    this.#ports = assertPorts(options.ports);
    this.#nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async connect(input: LiveKitCloudConnectInput): Promise<LiveKitCloudConnection> {
    const validated = assertConnectInput(input);
    let issuedAtEpochSeconds: number;
    try {
      issuedAtEpochSeconds = assertClockValue(this.#nowEpochSeconds());
    } catch (error) {
      if (error instanceof LiveKitCloudAdapterError) throw error;
      fail('INVALID_CLOCK');
    }
    if (issuedAtEpochSeconds > Number.MAX_SAFE_INTEGER - validated.ttlSeconds) fail('INVALID_CLOCK');

    const request: LiveKitCloudTokenRequest = Object.freeze({
      room: validated.roomName,
      identity: validated.identity,
      ttlSeconds: validated.ttlSeconds,
      grants: validated.grants,
    });

    let token: InternalSignedAccessToken;
    try {
      token = assertSignedToken(await this.#ports.tokenSigner.sign(request));
    } catch (error) {
      if (error instanceof LiveKitCloudAdapterError && error.code === 'TOKEN_INVALID') throw error;
      fail('TOKEN_SIGNING_FAILED');
    }

    try {
      await this.#ports.room.connect(
        validated.projectUrl,
        token,
        validated.e2eeRoomOptionsReference,
      );
    } catch {
      fail('ROOM_CONNECT_FAILED');
    }

    let disconnected = false;
    const disconnect = async (): Promise<void> => {
      if (disconnected) return;
      try {
        await this.#ports.room.disconnect();
        disconnected = true;
      } catch {
        fail('ROOM_DISCONNECT_FAILED');
      }
    };

    return Object.freeze({
      projectUrl: validated.projectUrl,
      roomName: validated.roomName,
      identity: validated.identity,
      expiresAtEpochSeconds: issuedAtEpochSeconds + validated.ttlSeconds,
      transport: 'livekit-cloud-direct' as const,
      disconnect,
    });
  }
}

export function createLiveKitCloudAdapter(options: LiveKitCloudAdapterOptions): LiveKitCloudAdapter {
  return new LiveKitCloudAdapter(options);
}

export async function connectLiveKitCloudDirectMedia(
  ports: LiveKitCloudAdapterPorts,
  input: LiveKitCloudConnectInput,
  nowEpochSeconds?: () => number,
): Promise<LiveKitCloudConnection> {
  return new LiveKitCloudAdapter({
    ports,
    ...(nowEpochSeconds === undefined ? {} : { nowEpochSeconds }),
  }).connect(input);
}
