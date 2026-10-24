import Ajv2020Module, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type JsonObject = Record<string, any>;
export type EventEnvelope = JsonObject;

export interface FrozenArtifacts {
  readonly profile: ContractProfile;
  readonly root: string;
  readonly schema: JsonObject;
  readonly mappingText: string;
  readonly validFixture: JsonObject;
  readonly invalidFixture: JsonObject;
  readonly hashes: Readonly<Record<string, string>>;
}

export interface ConsumeResult {
  readonly accepted: boolean;
  readonly retry: boolean;
  readonly errors: readonly string[];
  readonly schemaErrors: readonly ErrorObject[];
  readonly acceptedEffectCount: number;
}

export type FrozenArtifactByteReader = (path: string, relativePath: string) => Uint8Array;

export const CONTRACT_SCHEMA_VERSION = 'phase0-demo/0.2';
export const CONTRACT_SCHEMA_VERSION_V0_3 = 'phase0-demo/0.3';
export type ContractProfile = typeof CONTRACT_SCHEMA_VERSION | typeof CONTRACT_SCHEMA_VERSION_V0_3;
export const RELIABLE_EVENT_TOPIC = 'paios.phase0.demo.event';

const EXPECTED_NAMESPACE = 'paios.phase0.demo.';
const CLEANUP_TYPE = `${EXPECTED_NAMESPACE}session.cleanup.completed`;
const START_TYPE = `${EXPECTED_NAMESPACE}session.started`;
const END_TYPE = `${EXPECTED_NAMESPACE}session.ended`;
const FORBIDDEN_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'api_key',
  'secret',
  'password',
  'signed_url',
]);
const MAX_CREDENTIAL_SCAN_LENGTH = 16_384;
const CREDENTIAL_VALUE_PATTERN = /(?:authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,}|api[_ -]?key\s*[:=]|(?:access[_ -]?)?token\s*[:=]|password\s*[:=]|secret\s*[:=]|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b)/i;
const JWT_CANDIDATE_PATTERN = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{6,})(?![A-Za-z0-9_-])/g;
const URL_CANDIDATE_PATTERN = /(?:https?|livekit|ephemeral):\/\/[^\s"'<>]+/gi;
const SIGNED_URL_COMPONENT_PATTERN = /(?:[/?#&;])(?:x-amz-signature|x-amz-credential|awsaccesskeyid|signature|sig|signed|token|access_token)(?:=|\/)[^\s/?#&;]+/i;
const PERCENT_ESCAPE_PATTERN = /%[0-9A-Fa-f]{2}/;
const LIVEKIT_LOCATOR_PATTERN =
  /^livekit:\/\/(?<session_id>[a-z][a-z0-9_-]{2,63})\/(?<publisher_identity>[a-z][a-z0-9_-]{2,63})\/(?<publication_sid>TR_[A-Za-z0-9_-]{3,64})$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
const PUBLICATION_SID_PATTERN = /^TR_[A-Za-z0-9_-]{3,64}$/;
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const PROFILE_CONFIGS = Object.freeze({
  [CONTRACT_SCHEMA_VERSION]: Object.freeze({
    directory: 'demo_v0_2',
    hashes: Object.freeze({
      'PHASE0_DEMO_CONTRACT.md': '89750f3b83fbfa165fd0776f65ea21e415608491d4849fd05f22dcda51ce362c',
      'session-event.schema.json': 'f0db8c31a2244535e410c8afeb6f00d156934f3961377363b24999dc22b006cf',
      'rtc-mapping.yaml': 'a1692d11693676c55d58e9c1f0af264ecf7cc1309c7585179b57d6c6159863f0',
      'examples/valid-events.json': 'd307b7d17a4ce0bc93e10c4fed7a5d27478e43a2bb0d43623bf54c4a86cc831f',
      'examples/invalid-events.json': '42e20fd3f537bc6caa49f4d24aa0b1581da123815b8968f17a84c468f2269707',
      'tests/test_contract_compatibility.py': '3700a12a2904b44e95cba3c2e8530d5a29b10df00583eadd05d23733d319b912',
    }),
  }),
  [CONTRACT_SCHEMA_VERSION_V0_3]: Object.freeze({
    directory: 'demo_v0_3',
    hashes: Object.freeze({
      'PHASE0_DEMO_CONTRACT.md': '022239aba6fa230ea767718dd52e1d208b8aedb28663f3bce96b290ac78ab72c',
      'session-event.schema.json': '68253cd4c53776d777528ff43da1022815c1327a9b29f30c4aaa30da6f5bc2c8',
      'rtc-mapping.yaml': 'e38414b14489f23b166753c1688da3e70ca918c1c1fce732dce5f6b1be9d7c79',
      'examples/valid-events.json': '5e60ff05db5b2a186d35486fc248bb9d2bfbd5a87435ec53660332e3c9b7749f',
      'examples/invalid-events.json': '2767a8aaafdf2fb7f09410bc772ae972ebd8b9f60cb359082529afd26a42e391',
      'tests/test_contract_compatibility.py': '882f4f65482af79c7aa35cade16f83407b123c1bc402351cace72a109d987fb6',
    }),
  }),
});

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function assertFileHash(path: string, expected: string): string {
  const actual = sha256(readFileSync(path));
  if (actual !== expected) {
    throw new Error(`FROZEN_POSTIMAGE_DRIFT:${path}:${actual}`);
  }
  return actual;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

class VerifiedFrozenArtifacts implements FrozenArtifacts {
  readonly profile: ContractProfile; readonly root: string; readonly schema: JsonObject;
  readonly mappingText: string; readonly validFixture: JsonObject; readonly invalidFixture: JsonObject; readonly hashes: Readonly<Record<string, string>>;
  constructor(
    profile: ContractProfile, root: string, schema: JsonObject, mappingText: string,
    validFixture: JsonObject, invalidFixture: JsonObject,
    hashes: Readonly<Record<string, string>>,
  ) {
    this.profile = profile; this.root = root; this.schema = schema; this.mappingText = mappingText;
    this.validFixture = validFixture; this.invalidFixture = invalidFixture;
    this.hashes = hashes;
    deepFreeze(this);
  }
}

export function loadFrozenArtifacts(profile: ContractProfile, byteReader?: FrozenArtifactByteReader): FrozenArtifacts;
export function loadFrozenArtifacts(byteReader?: FrozenArtifactByteReader): FrozenArtifacts;
export function loadFrozenArtifacts(
  profileOrReader: ContractProfile | FrozenArtifactByteReader = CONTRACT_SCHEMA_VERSION,
  suppliedReader?: FrozenArtifactByteReader,
): FrozenArtifacts {
  const profile =
    typeof profileOrReader === 'function' ? CONTRACT_SCHEMA_VERSION : profileOrReader;
  const byteReader =
    typeof profileOrReader === 'function'
      ? profileOrReader
      : suppliedReader ?? ((path: string) => readFileSync(path));
  const config = PROFILE_CONFIGS[profile];
  if (!config) throw new Error(`UNSUPPORTED_CONTRACT_PROFILE:${String(profile)}`);
  const root = fileURLToPath(new URL(`../../contracts/${config.directory}/`, import.meta.url));
  const hashes: Record<string, string> = {};
  const snapshots = new Map<string, Buffer>();
  for (const [relativePath, expected] of Object.entries(config.hashes)) {
    const path = join(root, relativePath);
    const snapshot = Buffer.from(byteReader(path, relativePath));
    const actual = sha256(snapshot);
    if (actual !== expected) throw new Error(`FROZEN_POSTIMAGE_DRIFT:${path}:${actual}`);
    hashes[relativePath] = actual;
    snapshots.set(relativePath, snapshot);
  }
  const readJson = (relativePath: string): JsonObject =>
    deepFreeze(JSON.parse(snapshots.get(relativePath)!.toString('utf8')) as JsonObject);
  return new VerifiedFrozenArtifacts(
    profile,
    root,
    readJson('session-event.schema.json'),
    snapshots.get('rtc-mapping.yaml')!.toString('utf8'),
    readJson('examples/valid-events.json'),
    readJson('examples/invalid-events.json'),
    deepFreeze(hashes),
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function parseTime(value: string): number {
  return Date.parse(value);
}

function walkKeys(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) walkKeys(child, output);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      walkKeys(child, output);
    }
  }
  return output;
}

function walkStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const child of value) walkStrings(child, output);
  else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) walkStrings(child, output);
  }
  return output;
}

function walkMediaRefs(value: unknown, output: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(value)) for (const child of value) walkMediaRefs(child, output);
  else if (value !== null && typeof value === 'object') {
    const object = value as JsonObject;
    if (['media_id', 'kind', 'transport', 'locator', 'expires_at'].every((key) => key in object)) {
      output.push(object);
    }
    for (const child of Object.values(object)) walkMediaRefs(child, output);
  }
  return output;
}

function decodePercentOnce(value: string): { variants: string[]; invalid: boolean } {
  const variants = [value];
  if (value.length > MAX_CREDENTIAL_SCAN_LENGTH) return { variants, invalid: true };
  if (!value.includes('%')) return { variants, invalid: false };
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    if (index + 2 >= value.length || !/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      return { variants, invalid: true };
    }
    index += 2;
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length > MAX_CREDENTIAL_SCAN_LENGTH) return { variants, invalid: true };
    variants.push(decoded);
    return { variants, invalid: PERCENT_ESCAPE_PATTERN.test(decoded) };
  } catch {
    return { variants, invalid: true };
  }
}

function containsJwt(value: string): boolean {
  JWT_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(JWT_CANDIDATE_PATTERN)) {
    const header = match[2];
    if (!header) continue;
    try {
      const decoded = Buffer.from(header, 'base64url').toString('utf8');
      const parsed: unknown = JSON.parse(decoded);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return true;
    } catch {
      // A dotted ordinary value is not a JWT unless its header is a JSON object.
    }
  }
  return false;
}

function containsSignedUrl(value: string): boolean {
  URL_CANDIDATE_PATTERN.lastIndex = 0;
  return [...value.matchAll(URL_CANDIDATE_PATTERN)].some((match) =>
    SIGNED_URL_COMPONENT_PATTERN.test(match[0]),
  );
}

function credentialFindings(value: string): { found: boolean; invalid: boolean } {
  const { variants, invalid } = decodePercentOnce(value);
  const found = variants.some(
    (variant) =>
      CREDENTIAL_VALUE_PATTERN.test(variant) || containsJwt(variant) || containsSignedUrl(variant),
  );
  return { found: found || invalid, invalid };
}

function rtcPublisherDeviceId(origin: JsonObject): string {
  return origin.relay?.relay_device_id ?? origin.device_id;
}

function key(...parts: Array<string | number>): string {
  return parts.join('\u0000');
}

export interface LiveKitPublicationObservation {
  readonly session_id: string; readonly room_name: string;
  readonly rtc_publisher_identity: string; readonly publication_sid: string;
  readonly available_after_accepted_event_ordinal: number;
}

export interface SemanticOptions {
  readonly profile: ContractProfile; readonly publicationObservations?: readonly LiveKitPublicationObservation[];
  readonly microphoneTranscriptEventIds?: readonly string[];
}

function acceptedEventSequence(
  events: readonly EventEnvelope[],
): Array<{ readonly ordinal: number; readonly event: EventEnvelope }> {
  const fingerprints = new Map<string, string>();
  const idempotency = new Map<string, string>();
  const sessionOrdinals = new Map<string, number>();
  const accepted: Array<{ ordinal: number; event: EventEnvelope }> = [];
  for (const event of events) {
    const fingerprint = stableJson(event);
    const eventId = String(event.event_id);
    const sessionId = String(event.session_id);
    const idemKey = key(sessionId, event.idempotency_key);
    if (fingerprints.get(eventId) === fingerprint && idempotency.get(idemKey) === fingerprint) {
      continue;
    }
    if (fingerprints.has(eventId) || idempotency.has(idemKey)) continue;
    fingerprints.set(eventId, fingerprint);
    idempotency.set(idemKey, fingerprint);
    const ordinal = (sessionOrdinals.get(sessionId) ?? 0) + 1;
    sessionOrdinals.set(sessionId, ordinal);
    accepted.push({ ordinal, event });
  }
  return accepted;
}

export function semanticErrors(
  events: readonly EventEnvelope[],
  options: SemanticOptions = { profile: CONTRACT_SCHEMA_VERSION },
): string[] {
  const errors: string[] = [];
  const observationOrdinals = new Map(
    (options.publicationObservations ?? []).map((observation) => [
      key(observation.session_id, observation.rtc_publisher_identity, observation.publication_sid),
      observation.available_after_accepted_event_ordinal,
    ]),
  );
  const microphoneTranscriptEventIds = new Set(options.microphoneTranscriptEventIds ?? []);
  const allMedia = acceptedEventSequence(events)
    .filter(({ event }) => event.event_type === `${EXPECTED_NAMESPACE}media.referenced`)
    .map(({ ordinal, event }) => ({ ordinal, event, media: event.payload.media_ref as JsonObject }));
  const priorMedia: Array<{
    readonly ordinal: number; readonly event: EventEnvelope; readonly media: JsonObject;
    readonly captureStatus: string | undefined;
  }> = [];
  const fingerprints = new Map<string, string>();
  const eventById = new Map<string, EventEnvelope>();
  const idempotency = new Map<string, string>();
  const streamState = new Map<string, [number, string]>();
  const handoffRequests = new Map<string, EventEnvelope>();
  const handoffLeaseSlots = new Map<string, string>();
  const consumedHandoffs = new Set<string>();
  const deliveryRequests = new Map<string, EventEnvelope>();
  const activeDevice = new Map<string, [string, number]>();
  const started = new Set<string>();
  const ended = new Map<string, number>();
  const cleaned = new Set<string>();
  const cleanupDeadlines = new Map<string, number>();
  const connections = new Map<string, [string, number]>();
  const connectionIds = new Map<string, Set<string>>();
  const captureState = new Map<string, [string, string]>();
  const sessionSchemaVersions = new Map<string, string>();
  const sessionOrdinals = new Map<string, number>();
  const mediaExpiries: Array<[string, number]> = [];
  const activity = new Map<string, { events: number; media: number; model: number }>();

  for (const event of events) {
    const eventId = String(event.event_id);
    const eventType = String(event.event_type);
    const sessionId = String(event.session_id);
    const occurredAt = parseTime(event.occurred_at);
    const expiresAt = parseTime(event.expires_at);
    const schemaVersion = String(event.schema_version);
    const priorSchemaVersion = sessionSchemaVersions.get(sessionId);
    if (priorSchemaVersion === undefined) sessionSchemaVersions.set(sessionId, schemaVersion);
    else if (priorSchemaVersion !== schemaVersion) errors.push('SESSION_SCHEMA_VERSION_MIXED');
    if (schemaVersion !== options.profile) errors.push('SCHEMA_VERSION_UNSUPPORTED');
    const fingerprint = stableJson(event);
    const idemKey = key(sessionId, event.idempotency_key);
    const exactRetry =
      fingerprints.get(eventId) === fingerprint && idempotency.get(idemKey) === fingerprint;
    const cleanupRetry = exactRetry && eventType === CLEANUP_TYPE;

    if (cleaned.has(sessionId) && !cleanupRetry) errors.push('EVENT_AFTER_CLEANUP');
    if (exactRetry) continue;
    let conflict = false;
    if (fingerprints.has(eventId)) {
      errors.push('EVENT_ID_CONFLICT');
      conflict = true;
    }
    if (idempotency.has(idemKey)) {
      errors.push('IDEMPOTENCY_CONFLICT');
      conflict = true;
    }
    if (conflict) continue;
    fingerprints.set(eventId, fingerprint);
    idempotency.set(idemKey, fingerprint);
    eventById.set(eventId, event);
    const acceptedOrdinal = (sessionOrdinals.get(sessionId) ?? 0) + 1;
    sessionOrdinals.set(sessionId, acceptedOrdinal);

    const counts = activity.get(sessionId) ?? { events: 0, media: 0, model: 0 };
    activity.set(sessionId, counts);
    if (eventType !== CLEANUP_TYPE) counts.events += 1;

    if (!eventType.startsWith(EXPECTED_NAMESPACE)) errors.push('EVENT_NAMESPACE_INVALID');
    if (expiresAt <= occurredAt) errors.push('EVENT_EXPIRY_NOT_AFTER_OCCURRENCE');
    if (expiresAt - occurredAt > 86_400_000) errors.push('EVENT_TTL_EXCEEDED');
    if (walkKeys(event).some((candidate) => FORBIDDEN_KEYS.has(candidate.toLowerCase()))) {
      errors.push('CREDENTIAL_KEY_EMBEDDED');
    }
    const credentialResults = walkStrings(event).map(credentialFindings);
    if (credentialResults.some((result) => result.found)) errors.push('CREDENTIAL_VALUE_EMBEDDED');
    if (credentialResults.some((result) => result.invalid)) {
      errors.push('CREDENTIAL_VALUE_ENCODING_INVALID');
    }
    if (ended.has(sessionId) && !cleaned.has(sessionId) && eventType !== CLEANUP_TYPE) {
      errors.push('EVENT_AFTER_SESSION_END');
    }
    if (eventType !== START_TYPE && !started.has(sessionId)) errors.push('SESSION_NOT_STARTED');

    const origin = event.origin as JsonObject;
    const payload = event.payload as JsonObject;
    const sequence = event.sequence as JsonObject;
    const connection = event.connection as JsonObject;
    if (
      origin.device_class === 'windows_gateway' &&
      origin.device_id !== 'windows_gateway_01'
    ) {
      errors.push('GATEWAY_FOREIGN_ORIGIN_RELAY_FORBIDDEN');
    }
    if (origin.device_class === 'apple_watch' && origin.relay?.relay_device_id === origin.device_id) {
      errors.push('WATCH_RELAY_SELF_REFERENCE');
    }
    if ('device_id' in payload && payload.device_id !== origin.device_id) {
      errors.push('ORIGIN_PAYLOAD_DEVICE_MISMATCH');
    }

    for (const media of walkMediaRefs(payload)) {
      counts.media += 1;
      const mediaExpiry = parseTime(media.expires_at);
      mediaExpiries.push([sessionId, mediaExpiry]);
      if (mediaExpiry > expiresAt) errors.push('MEDIA_EXPIRES_AFTER_EVENT');
      if (String(media.locator).includes('?') || String(media.locator).includes('#')) {
        errors.push('MEDIA_LOCATOR_CONTAINS_CREDENTIAL_CHANNEL');
      }
      if (
        media.transport === 'ephemeral_object' &&
        (!Number.isInteger(media.byte_length) || media.byte_length <= 0 || !/^[a-f0-9]{64}$/.test(media.sha256 ?? ''))
      ) {
        errors.push('EPHEMERAL_MEDIA_INTEGRITY_MISSING');
      }
      if (!String(media.mime_type).startsWith(`${media.kind}/`)) errors.push('MEDIA_KIND_MIME_MISMATCH');
      if (options.profile === CONTRACT_SCHEMA_VERSION_V0_3 && media.transport === 'livekit_track') {
        const match = LIVEKIT_LOCATOR_PATTERN.exec(String(media.locator));
        if (!match?.groups) errors.push('LIVEKIT_LOCATOR_INVALID');
        else {
          const { session_id, publisher_identity, publication_sid } = match.groups;
          if (session_id !== sessionId) errors.push('LIVEKIT_SESSION_MISMATCH');
          if (publisher_identity !== rtcPublisherDeviceId(origin)) errors.push('LIVEKIT_PUBLISHER_MISMATCH');
          if (publication_sid !== media.media_id) errors.push('LIVEKIT_MEDIA_ID_MISMATCH');
          const observationOrdinal = observationOrdinals.get(
            key(session_id!, publisher_identity!, publication_sid!),
          );
          if (observationOrdinal === undefined || observationOrdinal >= acceptedOrdinal) {
            errors.push('LIVEKIT_PUBLICATION_NOT_OBSERVED');
          }
        }
      }
      const captureKind =
        media.capture_mode === 'microphone'
          ? 'audio'
          : ['user_triggered_frame', 'periodic_frame', 'low_fps_visual_stream'].includes(media.capture_mode)
            ? 'camera'
            : undefined;
      const capture = captureKind
        ? captureState.get(key(sessionId, origin.device_id, captureKind))
        : undefined;
      if (capture?.[0] === 'stopped') errors.push('CAPTURE_OUTPUT_AFTER_STOP');
    }

    const streamKey = key(sessionId, origin.device_id, sequence.stream_id);
    const previous = streamState.get(streamKey);
    if (!previous) {
      if (sequence.number !== 1) errors.push('SEQUENCE_START_NOT_ONE');
    } else {
      if (sequence.number <= previous[0]) errors.push('SEQUENCE_NOT_INCREASING');
      else if (sequence.number !== previous[0] + 1) errors.push('SEQUENCE_GAP');
      if (sequence.previous_event_id !== previous[1]) errors.push('PREVIOUS_EVENT_MISMATCH');
    }
    streamState.set(streamKey, [sequence.number, eventId]);

    const publisherKey = key(sessionId, rtcPublisherDeviceId(origin));
    const priorConnection = connections.get(publisherKey);
    const seenIds = connectionIds.get(publisherKey) ?? new Set<string>();
    connectionIds.set(publisherKey, seenIds);
    if (eventType === `${EXPECTED_NAMESPACE}connection.reconnected`) {
      let validIdentity = true;
      if (!priorConnection) {
        errors.push('RECONNECT_PREVIOUS_CONNECTION_NOT_FOUND');
        validIdentity = false;
      } else {
        if (connection.epoch !== priorConnection[1] + 1) {
          errors.push('RECONNECT_EPOCH_NOT_INCREMENTED');
          validIdentity = false;
        }
        if (connection.resumed_from_connection_id !== priorConnection[0]) {
          errors.push('RECONNECT_PREVIOUS_CONNECTION_MISMATCH');
          validIdentity = false;
        }
        if (connection.id === priorConnection[0] || seenIds.has(connection.id)) {
          errors.push('RECONNECT_IDENTITY_REUSE');
          validIdentity = false;
        }
      }
      if (validIdentity) {
        connections.set(publisherKey, [connection.id, connection.epoch]);
        seenIds.add(connection.id);
      }
    } else if (!priorConnection) {
      connections.set(publisherKey, [connection.id, connection.epoch]);
      seenIds.add(connection.id);
    } else if (connection.id !== priorConnection[0] || connection.epoch !== priorConnection[1]) {
      errors.push('CONNECTION_IDENTITY_DRIFT');
    }

    if (eventType === START_TYPE) {
      if (started.has(sessionId)) {
        errors.push('DUPLICATE_SESSION_START');
        continue;
      }
      const credentialExpiry = parseTime(payload.credential_lease.expires_at);
      if (credentialExpiry <= occurredAt || credentialExpiry - occurredAt > 900_000) {
        errors.push('CREDENTIAL_TTL_EXCEEDED');
      }
      const sessionExpiry = parseTime(payload.session_expires_at);
      if (sessionExpiry <= occurredAt || sessionExpiry - occurredAt > 14_400_000) {
        errors.push('SESSION_TTL_EXCEEDED');
      }
      const startCleanupDelay = parseTime(payload.cleanup_deadline_at) - sessionExpiry;
      if (startCleanupDelay < 0 || startCleanupDelay > 300_000) errors.push('SESSION_CLEANUP_SLA_INVALID');
      activeDevice.set(sessionId, [payload.active_device_id, payload.active_device_lease_version]);
      started.add(sessionId);
    } else if (eventType === `${EXPECTED_NAMESPACE}capture.status`) {
      const captureKey = key(sessionId, payload.device_id, payload.capture_kind);
      const priorCapture = captureState.get(captureKey);
      if (payload.status === 'started' && priorCapture?.[0] === 'stopped') {
        if (sequence.stream_id === priorCapture[1]) errors.push('CAPTURE_STREAM_RESTART_AFTER_STOP');
        else captureState.set(captureKey, ['started', sequence.stream_id]);
      } else if (priorCapture && sequence.stream_id !== priorCapture[1]) {
        errors.push('CAPTURE_STREAM_ID_MISMATCH');
      } else captureState.set(captureKey, [payload.status, sequence.stream_id]);
    } else if (
      options.profile === CONTRACT_SCHEMA_VERSION_V0_3 &&
      eventType === `${EXPECTED_NAMESPACE}media.referenced`
    ) {
      const media = payload.media_ref as JsonObject;
      priorMedia.push({
        ordinal: acceptedOrdinal,
        event,
        media,
        captureStatus:
          media.capture_mode === 'microphone'
            ? captureState.get(key(sessionId, origin.device_id, 'audio'))?.[0]
            : undefined,
      });
    } else if (eventType === `${EXPECTED_NAMESPACE}transcript.final`) {
      if (options.profile === CONTRACT_SCHEMA_VERSION_V0_3) {
        const sourceMediaId = String(payload.source_media_id);
        if (sourceMediaId.startsWith('TR_')) {
          const bindsSource = (item: { media: JsonObject }): boolean => {
            const match = LIVEKIT_LOCATOR_PATTERN.exec(String(item.media.locator));
            return item.media.media_id === sourceMediaId || match?.groups?.publication_sid === sourceMediaId;
          };
          const candidates = priorMedia.filter(
            (item) => item.event.session_id === sessionId && bindsSource(item),
          );
          const anyMatches = allMedia.filter(bindsSource);
          if (candidates.length === 0) {
            if (anyMatches.some((item) => item.event.session_id === sessionId && item.ordinal >= acceptedOrdinal)) {
              errors.push('TRANSCRIPT_SOURCE_MEDIA_NOT_PRIOR');
            } else if (anyMatches.some((item) => item.event.session_id !== sessionId)) {
              errors.push('TRANSCRIPT_SOURCE_SESSION_MISMATCH');
            } else errors.push('TRANSCRIPT_SOURCE_MEDIA_NOT_FOUND');
          } else if (candidates.length !== 1) {
            errors.push('TRANSCRIPT_SOURCE_MEDIA_AMBIGUOUS');
          } else {
            const { ordinal: mediaOrdinal, event: mediaEvent, media, captureStatus } = candidates[0]!;
            if (stableJson(mediaEvent.origin) !== stableJson(origin)) {
              errors.push('TRANSCRIPT_SOURCE_ORIGIN_MISMATCH');
            }
            if (media.kind !== 'audio') errors.push('TRANSCRIPT_SOURCE_NOT_AUDIO');
            if (media.capture_mode !== 'microphone') errors.push('TRANSCRIPT_SOURCE_NOT_MICROPHONE');
            if (captureStatus !== 'started') errors.push('TRANSCRIPT_CAPTURE_NOT_STARTED');
            const match = LIVEKIT_LOCATOR_PATTERN.exec(String(media.locator));
            if (!match?.groups) errors.push('LIVEKIT_LOCATOR_INVALID');
            else {
              const { session_id, publisher_identity, publication_sid } = match.groups;
              if (media.media_id !== sourceMediaId) errors.push('TRANSCRIPT_SOURCE_MEDIA_ID_MISMATCH');
              if (publication_sid !== media.media_id) errors.push('LIVEKIT_MEDIA_ID_MISMATCH');
              if (session_id !== sessionId) errors.push('LIVEKIT_SESSION_MISMATCH');
              if (publisher_identity !== rtcPublisherDeviceId(origin)) {
                errors.push('LIVEKIT_PUBLISHER_MISMATCH');
              }
              const observationOrdinal = observationOrdinals.get(
                key(session_id!, publisher_identity!, publication_sid!),
              );
              if (observationOrdinal === undefined || observationOrdinal >= acceptedOrdinal) {
                errors.push('LIVEKIT_PUBLICATION_NOT_OBSERVED');
              }
            }
            if (mediaOrdinal >= acceptedOrdinal) errors.push('TRANSCRIPT_SOURCE_MEDIA_NOT_PRIOR');
          }
        } else {
          if (microphoneTranscriptEventIds.has(eventId)) {
            errors.push('TRANSCRIPT_SOURCE_KIND_MISREPRESENTED');
          }
          if (allMedia.some(
            (item) => item.event.session_id === sessionId && item.media.media_id === sourceMediaId,
          )) {
            errors.push('TYPED_TRANSCRIPT_MEDIA_COLLISION');
          }
        }
      }
      if (captureState.get(key(sessionId, origin.device_id, 'audio'))?.[0] === 'stopped') {
        errors.push('CAPTURE_OUTPUT_AFTER_STOP');
      }
    } else if (eventType === `${EXPECTED_NAMESPACE}confirmation.requested`) {
      const confirmationExpiry = parseTime(payload.expires_at);
      if (confirmationExpiry <= occurredAt || confirmationExpiry - occurredAt > 300_000) {
        errors.push('CONFIRMATION_TTL_EXCEEDED');
      }
    } else if (eventType === `${EXPECTED_NAMESPACE}confirmation.responded`) {
      const request = eventById.get(payload.request_event_id);
      if (!request || request.event_type !== `${EXPECTED_NAMESPACE}confirmation.requested`) {
        errors.push('CONFIRMATION_REQUEST_NOT_FOUND');
      } else {
        if (request.session_id !== sessionId) errors.push('CONFIRMATION_REQUEST_SESSION_MISMATCH');
        if (payload.confirmation_id !== request.payload.confirmation_id) errors.push('CONFIRMATION_ID_MISMATCH');
        if (origin.device_id !== request.payload.target_device_id) errors.push('CONFIRMATION_WRONG_RESPONDER');
        if (!request.payload.choices.includes(payload.choice)) errors.push('CONFIRMATION_CHOICE_INVALID');
      }
    } else if (eventType === `${EXPECTED_NAMESPACE}model.requested`) {
      if (payload.input_event_ids.some((id: string) => !eventById.has(id))) {
        errors.push('MODEL_INPUT_EVENT_NOT_FOUND');
      }
      if (payload.input_event_ids.some((id: string) => eventById.get(id)?.session_id !== sessionId)) {
        errors.push('MODEL_INPUT_CROSS_SESSION_REFERENCE');
      }
      counts.model += 1;
    } else if (eventType === `${EXPECTED_NAMESPACE}model.result`) {
      const request = eventById.get(payload.request_event_id);
      if (!request || request.event_type !== `${EXPECTED_NAMESPACE}model.requested`) {
        errors.push('MODEL_REQUEST_NOT_FOUND');
      } else if (request.session_id !== sessionId) errors.push('MODEL_RESULT_CROSS_SESSION_REFERENCE');
      else {
        const requested = new Set<string>(request.payload.requested_outputs);
        if ((payload.outputs ?? []).some((output: JsonObject) => !requested.has(output.modality))) {
          errors.push('MODEL_UNREQUESTED_OUTPUT_MODALITIES');
        }
      }
      if (
        (payload.outputs ?? []).some(
          (output: JsonObject) => output.modality === 'audio' && output.media_ref.kind !== 'audio',
        )
      ) {
        errors.push('MODEL_AUDIO_OUTPUT_KIND_INVALID');
      }
      counts.model += 1;
    } else if (eventType === `${EXPECTED_NAMESPACE}handoff.requested`) {
      handoffRequests.set(eventId, event);
      if (payload.from_device_id === payload.to_device_id) errors.push('HANDOFF_FROM_EQUALS_TO');
      const leaseSlot = key(sessionId, payload.expected_active_device_lease_version);
      if (handoffLeaseSlots.has(leaseSlot)) errors.push('DUAL_HANDOFF_SAME_EXPECTED_LEASE');
      else handoffLeaseSlots.set(leaseSlot, eventId);
      const current = activeDevice.get(sessionId);
      if (
        current &&
        (payload.from_device_id !== current[0] || payload.expected_active_device_lease_version !== current[1])
      ) {
        errors.push('HANDOFF_EXPECTATION_STALE');
      }
    } else if (eventType === `${EXPECTED_NAMESPACE}handoff.completed`) {
      const request = handoffRequests.get(payload.request_event_id);
      if (!request || request.payload.handoff_id !== payload.handoff_id) {
        errors.push('HANDOFF_REQUEST_NOT_FOUND');
      } else {
        let valid = true;
        const requestPayload = request.payload as JsonObject;
        if (consumedHandoffs.has(payload.request_event_id)) {
          errors.push('HANDOFF_REQUEST_ALREADY_CONSUMED');
          valid = false;
        }
        if (request.session_id !== sessionId) {
          errors.push('HANDOFF_REQUEST_SESSION_MISMATCH');
          valid = false;
        }
        if (payload.from_device_id !== requestPayload.from_device_id || payload.to_device_id !== requestPayload.to_device_id) {
          errors.push('HANDOFF_ENDPOINT_MISMATCH');
          valid = false;
        }
        if (payload.active_device_id !== payload.to_device_id) {
          errors.push('HANDOFF_ACTIVE_DEVICE_MISMATCH');
          valid = false;
        }
        if (payload.active_device_lease_version !== requestPayload.expected_active_device_lease_version + 1) {
          errors.push('HANDOFF_LEASE_NOT_INCREMENTED');
          valid = false;
        }
        const current = activeDevice.get(sessionId);
        if (!current || current[0] !== requestPayload.from_device_id || current[1] !== requestPayload.expected_active_device_lease_version) {
          errors.push('HANDOFF_COMPLETION_CAS_ROLLBACK');
          valid = false;
        }
        if (current && payload.active_device_lease_version !== current[1] + 1) {
          errors.push('HANDOFF_LEASE_NOT_MONOTONIC');
          valid = false;
        }
        if (valid) {
          consumedHandoffs.add(payload.request_event_id);
          activeDevice.set(sessionId, [payload.active_device_id, payload.active_device_lease_version]);
        }
      }
    } else if (eventType === `${EXPECTED_NAMESPACE}delivery.requested`) {
      deliveryRequests.set(eventId, event);
      const current = activeDevice.get(sessionId);
      if (!current || payload.target_device_id !== current[0] || payload.active_device_lease_version !== current[1]) {
        errors.push('DELIVERY_NOT_ON_ACTIVE_LEASE');
      }
      const result = eventById.get(payload.result_event_id);
      if (!result || result.event_type !== `${EXPECTED_NAMESPACE}model.result`) {
        errors.push('DELIVERY_RESULT_NOT_FOUND');
      } else if (result.session_id !== sessionId) errors.push('DELIVERY_RESULT_SESSION_MISMATCH');
    } else if (eventType === `${EXPECTED_NAMESPACE}delivery.acknowledged`) {
      const request = deliveryRequests.get(payload.delivery_event_id);
      if (!request) errors.push('DELIVERY_REQUEST_NOT_FOUND');
      else if (
        payload.target_device_id !== request.payload.target_device_id ||
        payload.active_device_lease_version !== request.payload.active_device_lease_version
      ) {
        errors.push('DELIVERY_ACK_MISMATCH');
      } else if (request.session_id !== sessionId) errors.push('DELIVERY_REQUEST_SESSION_MISMATCH');
      const current = activeDevice.get(sessionId);
      const stale = !current || payload.target_device_id !== current[0] || payload.active_device_lease_version !== current[1];
      if (origin.device_id !== payload.target_device_id) errors.push('DELIVERY_ACK_ORIGIN_MISMATCH');
      if (stale && payload.disposition !== 'ignored_stale_lease') errors.push('STALE_OLD_DEVICE_ACK_RENDERED');
      if (!stale && payload.disposition === 'ignored_stale_lease') errors.push('CURRENT_LEASE_ACK_MARKED_STALE');
    } else if (eventType === `${EXPECTED_NAMESPACE}connection.reconnected`) {
      if (
        payload.new_connection_id !== connection.id ||
        payload.previous_connection_id !== connection.resumed_from_connection_id
      ) {
        errors.push('RECONNECT_CONNECTION_MISMATCH');
      }
      if (payload.resume_stream_id !== sequence.stream_id) errors.push('RECONNECT_STREAM_MISMATCH');
      if (payload.replay_from_sequence !== payload.last_acked_sequence + 1) {
        errors.push('RECONNECT_REPLAY_RANGE_INVALID');
      }
      if (!previous || payload.last_acked_sequence !== previous[0] || payload.replay_from_sequence !== sequence.number) {
        errors.push('RECONNECT_ACK_SEQUENCE_FABRICATION');
      }
    } else if (eventType === END_TYPE) {
      const endedAt = parseTime(payload.ended_at);
      const deadline = parseTime(payload.cleanup_deadline_at);
      if (deadline < endedAt || deadline - endedAt > 300_000) errors.push('SESSION_END_CLEANUP_SLA_INVALID');
      ended.set(sessionId, endedAt);
      cleanupDeadlines.set(sessionId, deadline);
    } else if (eventType === CLEANUP_TYPE) {
      const completedAt = parseTime(payload.completed_at);
      const deadline = cleanupDeadlines.get(sessionId);
      if (deadline === undefined || completedAt > deadline) errors.push('CLEANUP_DEADLINE_MISSED');
      if (ended.has(sessionId) && completedAt < ended.get(sessionId)!) {
        errors.push('CLEANUP_COMPLETED_BEFORE_SESSION_END');
      }
      if (expiresAt - completedAt > 3_600_000) errors.push('CLEANUP_RECEIPT_TTL_EXCEEDED');
      const prior = activity.get(sessionId)!;
      const removed = payload.removed as JsonObject;
      if (
        (prior.events > 0 && removed.events === 0) ||
        (started.has(sessionId) && removed.session_rows === 0) ||
        (prior.media > 0 && removed.media_objects === 0) ||
        (prior.model > 0 && removed.model_cache_entries === 0)
      ) {
        errors.push('FALSE_ZERO_CLEANUP_RECEIPT');
      }
      cleaned.add(sessionId);
    }
  }

  for (const [sessionId, mediaExpiry] of mediaExpiries) {
    const endedAt = ended.get(sessionId);
    if (endedAt !== undefined && mediaExpiry > endedAt + 3_600_000) {
      errors.push('MEDIA_OVER_60M_AFTER_SESSION_END');
    }
  }
  return [...new Set(errors)];
}

export class ContractConsumer {
  readonly artifacts: FrozenArtifacts;
  readonly #validate: ValidateFunction;
  readonly #events: EventEnvelope[] = [];
  readonly #publicationObservations = new Map<string, LiveKitPublicationObservation>();
  readonly #microphoneTranscriptEventIds = new Set<string>();
  readonly #rejectedProvenance = new Set<string>();
  #acceptedEffects = 0;

  constructor(selection: ContractProfile | FrozenArtifacts = CONTRACT_SCHEMA_VERSION) {
    const artifacts =
      typeof selection === 'string' ? loadFrozenArtifacts(selection) : selection;
    if (!(artifacts instanceof VerifiedFrozenArtifacts)) {
      throw new Error('UNVERIFIED_CONTRACT_ARTIFACT_SET');
    }
    this.artifacts = artifacts;
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictTypes: false,
      strictRequired: false,
    });
    addFormats(ajv);
    this.#validate = ajv.compile(artifacts.schema);
  }

  get profile(): ContractProfile {
    return this.artifacts.profile;
  }

  consume(candidate: unknown): ConsumeResult {
    return this.consumeBatch([candidate]);
  }

  consumeMicrophoneTranscript(candidate: unknown): ConsumeResult {
    if (this.profile !== CONTRACT_SCHEMA_VERSION_V0_3) {
      throw new Error('MICROPHONE_TRANSCRIPT_PROFILE_UNSUPPORTED');
    }
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      (candidate as JsonObject).event_type !== `${EXPECTED_NAMESPACE}transcript.final`
    ) {
      throw new Error('MICROPHONE_TRANSCRIPT_EVENT_REQUIRED');
    }
    this.#microphoneTranscriptEventIds.add(String((candidate as JsonObject).event_id));
    return this.consume(candidate);
  }

  recordPublicationObservation(
    observation: Omit<LiveKitPublicationObservation, 'available_after_accepted_event_ordinal'>,
  ): void {
    if (this.profile !== CONTRACT_SCHEMA_VERSION_V0_3) {
      throw new Error('PUBLICATION_OBSERVATION_PROFILE_UNSUPPORTED');
    }
    if (
      observation.room_name !== observation.session_id ||
      !IDENTIFIER_PATTERN.test(observation.session_id) ||
      !IDENTIFIER_PATTERN.test(observation.rtc_publisher_identity) ||
      !PUBLICATION_SID_PATTERN.test(observation.publication_sid)
    ) {
      throw new Error('PUBLICATION_OBSERVATION_INVALID');
    }
    const observationKey = key(
      observation.session_id,
      observation.rtc_publisher_identity,
      observation.publication_sid,
    );
    if (this.#publicationObservations.has(observationKey)) {
      throw new Error('PUBLICATION_OBSERVATION_DUPLICATE');
    }
    const ordinal = this.#events.filter(
      (event) => event.session_id === observation.session_id,
    ).length;
    this.#publicationObservations.set(observationKey, deepFreeze({
      ...observation,
      available_after_accepted_event_ordinal: ordinal,
    }));
  }

  validateBatch(candidates: readonly unknown[]): ConsumeResult {
    if (
      this.profile === CONTRACT_SCHEMA_VERSION_V0_3 &&
      candidates.some(
        (candidate) =>
          candidate !== null &&
          typeof candidate === 'object' &&
          this.#rejectedProvenance.has(stableJson(candidate)),
      )
    ) {
      return {
        accepted: false,
        retry: false,
        errors: ['LATE_EVIDENCE_RATIFICATION_FORBIDDEN'],
        schemaErrors: [],
        acceptedEffectCount: this.#acceptedEffects,
      };
    }
    const events: EventEnvelope[] = [];
    for (const candidate of candidates) {
      const schemaValid = this.#validate(candidate);
      if (!schemaValid) {
        return {
          accepted: false,
          retry: false,
          errors: ['SCHEMA_INVALID'],
          schemaErrors: [...(this.#validate.errors ?? [])],
          acceptedEffectCount: this.#acceptedEffects,
        };
      }
      events.push(structuredClone(candidate) as EventEnvelope);
    }
    const priorFingerprints = new Set(this.#events.map(stableJson));
    const newFingerprints = new Set<string>();
    for (const event of events) {
      const fingerprint = stableJson(event);
      if (!priorFingerprints.has(fingerprint)) newFingerprints.add(fingerprint);
    }
    const errors = semanticErrors([...this.#events, ...events], {
      profile: this.profile,
      publicationObservations: [...this.#publicationObservations.values()],
      microphoneTranscriptEventIds: [...this.#microphoneTranscriptEventIds],
    });
    if (errors.length > 0) {
      return {
        accepted: false,
        retry: false,
        errors,
        schemaErrors: [],
        acceptedEffectCount: this.#acceptedEffects,
      };
    }
    return {
      accepted: true,
      retry: newFingerprints.size === 0,
      errors: [],
      schemaErrors: [],
      acceptedEffectCount: this.#acceptedEffects + newFingerprints.size,
    };
  }

  consumeBatch(candidates: readonly unknown[]): ConsumeResult {
    const preview = this.validateBatch(candidates);
    if (!preview.accepted) {
      if (
        this.profile === CONTRACT_SCHEMA_VERSION_V0_3 &&
        preview.errors.some((error) =>
          error.startsWith('TRANSCRIPT_') ||
          error === 'LIVEKIT_PUBLICATION_NOT_OBSERVED' ||
          error === 'CAPTURE_OUTPUT_AFTER_STOP' ||
          error === 'TYPED_TRANSCRIPT_MEDIA_COLLISION'
        )
      ) {
        for (const candidate of candidates) {
          if (
            candidate !== null &&
            typeof candidate === 'object' &&
            (candidate as JsonObject).event_type === `${EXPECTED_NAMESPACE}transcript.final`
          ) {
            this.#rejectedProvenance.add(stableJson(candidate));
          }
        }
      }
      return preview;
    }
    const priorFingerprints = new Set(this.#events.map(stableJson));
    for (const candidate of candidates) {
      const event = structuredClone(candidate) as EventEnvelope;
      const fingerprint = stableJson(event);
      if (priorFingerprints.has(fingerprint)) continue;
      priorFingerprints.add(fingerprint);
      this.#events.push(event);
      this.#acceptedEffects += 1;
    }
    return {
      ...preview,
      acceptedEffectCount: this.#acceptedEffects,
    };
  }

  acceptedEvents(): readonly EventEnvelope[] {
    return structuredClone(this.#events);
  }

  clearTemporaryState(): void {
    this.#events.length = 0;
    this.#publicationObservations.clear();
    this.#microphoneTranscriptEventIds.clear();
    this.#rejectedProvenance.clear();
    this.#acceptedEffects = 0;
  }
}
