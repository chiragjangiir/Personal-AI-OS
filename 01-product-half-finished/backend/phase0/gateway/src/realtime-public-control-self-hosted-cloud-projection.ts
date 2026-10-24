import { createHash } from 'node:crypto';

import {
  assertCanonicalLiveKitCloudProjectUrl,
  isLiveKitOpaqueId,
  type LiveKitCloudGrantInput,
  type LiveKitMediaSource,
} from './livekit-cloud-token-signer.ts';
import type { JsonRecord } from './realtime-public-control-runtime.ts';
import type {
  T11bCloudProjectionPort,
  T11bSecretFreeCloudBootstrap,
  T11bSecretFreeCloudRefresh,
} from './realtime-public-control-t11b-t02-adapter.ts';

const CREDENTIAL_WINDOW_MS = 600_000;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const MEDIA = ['audio', 'video', 'data'] as const;
const FORBIDDEN_OUTPUT_KEYS = new Set([
  'api_key', 'api_secret', 'key_material', 'participant_token', 'password', 'plaintext', 'private_key',
  'room_options', 'roomOptions', 'token',
]);

type Media = (typeof MEDIA)[number];
type BootstrapInput = Parameters<T11bCloudProjectionPort['bootstrap']>[0];
type RefreshInput = Parameters<T11bCloudProjectionPort['connectedRefresh']>[0];

interface CredentialWindow {
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

interface ProjectionNames {
  readonly roomName: string;
  readonly terminalIdentity: string;
  readonly gatewayIdentity: string;
}

export interface RealtimePublicControlSelfHostedCloudProjectionOptions {
  readonly now?: () => number;
  readonly livekitUrl?: string;
}

export class RealtimePublicControlSelfHostedCloudProjectionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RealtimePublicControlSelfHostedCloudProjectionError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlSelfHostedCloudProjectionError(code);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 24) fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 128 || Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1) {
        fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ||
            !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
        }
        items.push(canonicalJson(descriptor.value, ancestors, depth + 1));
      }
      return `[${items.join(',')}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length || Object.keys(value).length > 128) {
      fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ||
          !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        fail('SELF_HOSTED_CLOUD_OPAQUE_VALUE_INVALID');
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors, depth + 1)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value))) as T;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalTimestamp(value: unknown, code: string): { readonly value: string; readonly milliseconds: number } {
  if (typeof value !== 'string' || value.length < 20 || value.length > 35) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return Object.freeze({ value, milliseconds });
}

function identifier(value: unknown, code: string): string {
  if (!isLiveKitOpaqueId(value)) fail(code);
  return value;
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value !== value.trim()) fail(code);
  return value;
}

function decimal(value: unknown, code: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(code);
  return value;
}

function domainIdentifier(prefix: 'paios-r-' | 'paios-t-' | 'paios-g-', domain: string, alias: unknown, epoch: string): string {
  const payload = canonicalJson(Object.freeze({ alias, connection_epoch: epoch }));
  const hexadecimal = createHash('sha256').update(domain, 'utf8').update('\0').update(payload, 'utf8').digest('hex');
  const piiSafeDigest = hexadecimal.replace(/[0-9]/gu, (digit) => 'ghijklmnop'[Number(digit)]!);
  return identifier(`${prefix}${piiSafeDigest}`, 'SELF_HOSTED_CLOUD_IDENTIFIER_INVALID');
}

function projectionNames(binding: BootstrapInput['projection']['binding']): ProjectionNames {
  if (binding.provider !== 'livekit-cloud') fail('SELF_HOSTED_CLOUD_PROVIDER_INVALID');
  const epoch = decimal(binding.connectionEpoch, 'SELF_HOSTED_CLOUD_CONNECTION_EPOCH_INVALID');
  text(binding.continuityId, 'SELF_HOSTED_CLOUD_CONTINUITY_INVALID');
  text(binding.connectionId, 'SELF_HOSTED_CLOUD_CONNECTION_ID_INVALID');
  canonicalJson(binding.realtimeSessionRef);
  canonicalJson(binding.deviceLeaseRef);
  return Object.freeze({
    roomName: domainIdentifier('paios-r-', 'paios.public.livekit.room.v1', binding.roomAlias, epoch),
    terminalIdentity: domainIdentifier('paios-t-', 'paios.public.livekit.terminal-identity.v1', binding.deviceAlias, epoch),
    gatewayIdentity: domainIdentifier('paios-g-', 'paios.public.livekit.gateway-identity.v1', binding.transportSessionAlias, epoch),
  });
}

function credentialWindow(
  projection: Pick<BootstrapInput['projection'], 'continuityExpiresAt' | 'leaseExpiresAt'>,
  now: number,
): CredentialWindow {
  if (!Number.isSafeInteger(now)) fail('SELF_HOSTED_CLOUD_CLOCK_INVALID');
  const continuity = canonicalTimestamp(projection.continuityExpiresAt, 'SELF_HOSTED_CLOUD_CONTINUITY_EXPIRY_INVALID');
  const lease = canonicalTimestamp(projection.leaseExpiresAt, 'SELF_HOSTED_CLOUD_LEASE_EXPIRY_INVALID');
  const expires = Math.min(now + CREDENTIAL_WINDOW_MS, continuity.milliseconds, lease.milliseconds);
  const ttlSeconds = Math.floor((expires - now - 1_000) / 1_000);
  if (!Number.isSafeInteger(expires) || ttlSeconds < 1 || ttlSeconds > 900) {
    fail('SELF_HOSTED_CLOUD_CREDENTIAL_WINDOW_INVALID');
  }
  return Object.freeze({ expiresAt: new Date(expires).toISOString(), ttlSeconds });
}

function exactCapabilities(request: BootstrapInput['request'], owner: BootstrapInput['owner']): readonly Media[] {
  if (!Array.isArray(request.capabilities) || !Array.isArray(owner.capabilities) ||
      request.capabilities.length !== owner.capabilities.length ||
      request.capabilities.some((value, index) => value !== owner.capabilities[index]) ||
      owner.capabilities.some((value) => typeof value !== 'string' || value.length === 0) ||
      new Set(owner.capabilities).size !== owner.capabilities.length) {
    fail('SELF_HOSTED_CLOUD_CAPABILITIES_INVALID');
  }
  const enabled = MEDIA.filter((media) => owner.capabilities.includes(media));
  if (enabled.length === 0) fail('SELF_HOSTED_CLOUD_MEDIA_REQUIRED');
  return Object.freeze(enabled);
}

function assertBootstrapOwner(input: BootstrapInput): readonly Media[] {
  if (input.request.userId !== input.owner.userId || input.request.deviceId !== input.owner.deviceId ||
      input.request.purpose !== input.owner.purpose || input.request.occurredAt !== input.owner.occurredAt ||
      !same(input.request.governance, input.governance)) {
    fail('SELF_HOSTED_CLOUD_OWNER_BINDING_INVALID');
  }
  text(input.owner.userId, 'SELF_HOSTED_CLOUD_OWNER_INVALID');
  identifier(input.owner.deviceId, 'SELF_HOSTED_CLOUD_DEVICE_INVALID');
  text(input.owner.purpose, 'SELF_HOSTED_CLOUD_PURPOSE_INVALID');
  canonicalTimestamp(input.owner.occurredAt, 'SELF_HOSTED_CLOUD_OCCURRED_AT_INVALID');
  return exactCapabilities(input.request, input.owner);
}

function assertRefreshOwner(input: RefreshInput): readonly Media[] {
  const binding = input.request.binding;
  const projected = input.projection.binding;
  if (binding.state !== 'connected' || binding.deviceId !== input.owner.deviceId ||
      input.request.occurredAt !== input.owner.occurredAt || !same(input.request.governance, input.governance) ||
      !same(binding.realtimeSessionRef, projected.realtimeSessionRef) ||
      !same(binding.deviceLeaseRef, projected.deviceLeaseRef) || binding.continuityId !== projected.continuityId ||
      binding.connectionEpoch !== projected.connectionEpoch || !same(binding.provider, projected.provider) ||
      !same(binding.transportSessionAlias, projected.transportSessionAlias) ||
      !same(binding.roomAlias, projected.roomAlias) || !same(binding.deviceAlias, projected.deviceAlias) ||
      binding.connectionId !== projected.connectionId) {
    fail('SELF_HOSTED_CLOUD_REFRESH_BINDING_INVALID');
  }
  identifier(input.owner.deviceId, 'SELF_HOSTED_CLOUD_DEVICE_INVALID');
  canonicalTimestamp(input.owner.occurredAt, 'SELF_HOSTED_CLOUD_OCCURRED_AT_INVALID');
  if (!Array.isArray(input.owner.capabilities) || new Set(input.owner.capabilities).size !== input.owner.capabilities.length ||
      input.owner.capabilities.some((value) => typeof value !== 'string' || value.length === 0)) {
    fail('SELF_HOSTED_CLOUD_CAPABILITIES_INVALID');
  }
  const enabled = MEDIA.filter((media) => input.owner.capabilities.includes(media));
  if (enabled.length === 0) fail('SELF_HOSTED_CLOUD_MEDIA_REQUIRED');
  return Object.freeze(enabled);
}

function generation(
  projection: BootstrapInput['projection'] | RefreshInput['projection'],
  request: BootstrapInput['request'] | RefreshInput['request'],
  operation: 'bootstrap' | 'connected_credential_refresh',
): string {
  const receipt = projection.receipt;
  if (receipt.kind !== 'realtime_terminal_receipt' || receipt.operation !== operation || receipt.status !== 'success' ||
      receipt.requestId !== request.requestId || receipt.idempotencyKey !== request.idempotencyKey ||
      receipt.continuityId !== projection.binding.continuityId ||
      receipt.connectionEpoch !== projection.binding.connectionEpoch ||
      !same(receipt.realtimeSessionRef, projection.binding.realtimeSessionRef) ||
      !same(receipt.deviceLeaseRef, projection.binding.deviceLeaseRef)) {
    fail('SELF_HOSTED_CLOUD_RECEIPT_BINDING_INVALID');
  }
  canonicalTimestamp(receipt.recordedAt, 'SELF_HOSTED_CLOUD_RECEIPT_TIME_INVALID');
  return decimal(receipt.leaseVersion, 'SELF_HOSTED_CLOUD_CREDENTIAL_GENERATION_INVALID');
}

function liveKitGrant(room: string, enabled: readonly Media[], gateway: boolean): LiveKitCloudGrantInput {
  // The terminal publishes its enabled capture; with audio enabled the gateway publishes one audio track: the live
  // call's assistant voice. The gateway never publishes camera.
  const sources: LiveKitMediaSource[] = [
    ...(enabled.includes('audio') ? ['microphone' as const] : []),
    ...(!gateway && enabled.includes('video') ? ['camera' as const] : []),
  ];
  return Object.freeze({
    room,
    roomJoin: true,
    canPublish: sources.length > 0,
    canSubscribe: true,
    canPublishData: enabled.includes('data'),
    canPublishSources: Object.freeze(sources),
  });
}

function mediaGrants(
  enabled: readonly Media[],
  deviceId: string,
  leaseRef: unknown,
  expiresAt: string,
): JsonRecord {
  const modalities = Object.freeze([...enabled]);
  const start = Object.freeze({ kind: 'explicit_user_start', device_id: deviceId, modalities });
  const lease = snapshot(leaseRef);
  return Object.freeze(Object.fromEntries(MEDIA.map((media) => [
    media,
    enabled.includes(media)
      ? Object.freeze({
        enabled: true,
        device_id: deviceId,
        device_lease_ref: lease,
        start_binding: start,
        expires_at: expiresAt,
      })
      : Object.freeze({ enabled: false }),
  ])));
}

function assertSecretFree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSecretFree(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) fail('SELF_HOSTED_CLOUD_SECRET_OUTPUT_FORBIDDEN');
    assertSecretFree(item);
  }
}

export function createRealtimePublicControlSelfHostedCloudProjection(
  options: RealtimePublicControlSelfHostedCloudProjectionOptions = {},
): T11bCloudProjectionPort {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'now' && key !== 'livekitUrl') ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    fail('SELF_HOSTED_CLOUD_OPTIONS_INVALID');
  }
  const now = options.now ?? Date.now;
  const livekitUrl = assertCanonicalLiveKitCloudProjectUrl(options.livekitUrl!);
  let closed = false;
  const assertOpen = (): void => { if (closed) fail('SELF_HOSTED_CLOUD_CLOSED'); };
  return Object.freeze({
    bootstrap: async (input: BootstrapInput): Promise<T11bSecretFreeCloudBootstrap> => {
      assertOpen();
      if (input.projection.operation !== 'bootstrap') fail('SELF_HOSTED_CLOUD_PROJECTION_OPERATION_INVALID');
      const enabled = assertBootstrapOwner(input);
      const names = projectionNames(input.projection.binding);
      const window = credentialWindow(input.projection, now());
      const credentialGeneration = generation(input.projection, input.request, 'bootstrap');
      const terminalGrants = liveKitGrant(names.roomName, enabled, false);
      const result: T11bSecretFreeCloudBootstrap = Object.freeze({
        serverUrl: livekitUrl,
        credentialExpiresAt: window.expiresAt as never,
        terminalRoomName: names.roomName,
        terminalIdentity: names.terminalIdentity,
        terminalGrants,
        mediaGrants: mediaGrants(enabled, input.owner.deviceId, input.projection.binding.deviceLeaseRef, window.expiresAt),
        gateway: Object.freeze({
          roomName: names.roomName,
          identity: names.gatewayIdentity,
          grants: liveKitGrant(names.roomName, enabled, true),
        }),
        credentialGeneration,
      });
      assertSecretFree(result);
      return result;
    },
    connectedRefresh: async (input: RefreshInput): Promise<T11bSecretFreeCloudRefresh> => {
      assertOpen();
      if (input.projection.operation !== 'connected_credential_refresh') {
        fail('SELF_HOSTED_CLOUD_PROJECTION_OPERATION_INVALID');
      }
      const enabled = assertRefreshOwner(input);
      const names = projectionNames(input.projection.binding);
      const window = credentialWindow(input.projection, now());
      const credentialGeneration = generation(input.projection, input.request, 'connected_credential_refresh');
      const result: T11bSecretFreeCloudRefresh = Object.freeze({
        credentialExpiresAt: window.expiresAt as never,
        credentialGeneration,
        credentialInput: Object.freeze({
          room: names.roomName,
          identity: names.terminalIdentity,
          ttlSeconds: window.ttlSeconds,
          grants: liveKitGrant(names.roomName, enabled, false),
        }),
      });
      assertSecretFree(result);
      return result;
    },
    close: () => { closed = true; },
  });
}
