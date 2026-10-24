import { createHash, hkdfSync } from 'node:crypto';

import type {
  CurrentBindingLookup,
  RealtimeCurrentBindingProjection,
} from '../../../services/realtime-core/src/types.ts';
import {
  createRealtimeE2eeDurableReplayPostgres,
} from '../../../services/platform-data/src/realtime-e2ee-durable-replay-postgres.ts';
import type {
  CredentialFencePort,
  CredentialFenceTuple,
} from '../../../services/platform-data/src/realtime-credential-fence.ts';
import {
  createRealtimeE2eeCiphertextResolver,
  type ContentKeyLeasePort,
  type RealtimeE2eeRequestValidatorPort,
  type RealtimeE2eeTerminalValidatorPort,
  type RecipientCredentialPort,
} from './realtime-e2ee-ciphertext-resolver.ts';
import {
  PERSISTENT_PUBLIC_SECRET_REFERENCES,
} from './realtime-public-control-persistent-public-ports.ts';
import type {
  RealtimeE2eeCiphertextResolverPort,
  RealtimeKeyResolverPort,
} from './realtime-public-control-runtime.ts';
import type {
  SecretReference,
  SecretResolverPort,
} from './livekit-cloud-token-signer.ts';

// Frame-key derivation must match the iPhone's shared-key BaseKeyProvider, which uses the LiveKit Swift SDK defaults.
// rtc-node requires every field once keyProviderOptions is supplied (no defaults are merged in).
export const LIVEKIT_KEY_PROVIDER_DEFAULTS = Object.freeze({
  ratchetSalt: new TextEncoder().encode('LKFrameEncryptionKey'), ratchetWindowSize: 0, failureTolerance: -1, keyRingSize: 16,
  keyDerivationFunction: 0, // PBKDF2
});

const DOMAIN = 'paios.realtime.e2ee.content-key.v1';
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const ROOT_KEY = /^[A-Za-z0-9_-]{43}$/u;
const MEDIA = ['audio', 'video', 'data'] as const;

type JsonRecord = Record<string, unknown>;
type ReadCurrentBinding = (
  lookup: CurrentBindingLookup,
) => Promise<RealtimeCurrentBindingProjection | undefined>;

export interface RealtimePublicControlPersistentE2eeOwnerOptions {
  readonly pool: Parameters<typeof createRealtimeE2eeDurableReplayPostgres>[0];
  readonly rootKeyRef: SecretReference;
  readonly secretResolver: SecretResolverPort;
  readonly recipientCredential: RecipientCredentialPort;
  readonly readCurrentBinding: ReadCurrentBinding;
  readonly credentialFence: CredentialFencePort;
  readonly requestValidator: RealtimeE2eeRequestValidatorPort;
  readonly terminalValidator: RealtimeE2eeTerminalValidatorPort;
  readonly readiness: () => boolean;
  readonly now?: () => number;
}

export interface RealtimePublicControlPersistentE2eeOwnerReadiness {
  readonly ready: boolean;
  readonly closed: boolean;
}

export interface RealtimePublicControlPersistentE2eeOwner {
  readonly e2ee: RealtimeKeyResolverPort;
  readonly e2eeCiphertext: RealtimeE2eeCiphertextResolverPort;
  readonly readiness: () => RealtimePublicControlPersistentE2eeOwnerReadiness;
  readonly close: () => Promise<void>;
}

export class RealtimePublicControlPersistentE2eeOwnerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RealtimePublicControlPersistentE2eeOwnerError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlPersistentE2eeOwnerError(code);
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PERSISTENT_E2EE_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || seen.has(value)) fail('PERSISTENT_E2EE_VALUE_INVALID');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
    if (!isRecord(value)) fail('PERSISTENT_E2EE_VALUE_INVALID');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  } finally { seen.delete(value); }
}

function same(left: unknown, right: unknown): boolean {
  try { return canonical(left) === canonical(right); } catch { return false; }
}

function object(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) fail(code);
  return value;
}

function exactRootRef(value: SecretReference): void {
  const expected = PERSISTENT_PUBLIC_SECRET_REFERENCES.e2eeRootKey;
  if (value === null || typeof value !== 'object' || value.name !== expected.name || value.version !== undefined ||
      Object.keys(value).some((key) => key !== 'name' && key !== 'version')) fail('PERSISTENT_E2EE_ROOT_REF_INVALID');
}

function assertCurrent(value: RealtimeCurrentBindingProjection | undefined): RealtimeCurrentBindingProjection {
  if (value === undefined || value.session.state !== 'active' || value.session.continuityState !== 'active' ||
      value.session.binding.state !== 'connected' || value.lease.state !== 'active' ||
      !same(value.session.realtimeSessionRef, value.lease.realtimeSessionRef) ||
      !same(value.session.activeDeviceLeaseRef, value.lease.deviceLeaseRef) ||
      !same(value.session.binding.deviceLeaseRef, value.lease.deviceLeaseRef) ||
      value.session.continuityId !== value.lease.continuityId ||
      value.session.continuityId !== value.session.binding.continuityId ||
      value.session.activeDeviceId !== value.lease.deviceId ||
      value.session.connectionEpoch !== value.session.binding.connectionEpoch) {
    fail('PERSISTENT_E2EE_CURRENT_BINDING_INVALID');
  }
  return value;
}

function keyInfo(current: RealtimeCurrentBindingProjection): Buffer {
  return Buffer.from(canonical({
    domain: DOMAIN,
    realtime_session_ref: current.session.realtimeSessionRef,
    continuity_id: current.session.continuityId,
    device_lease_ref: current.lease.deviceLeaseRef,
    credential_generation: current.lease.leaseVersion,
  }), 'utf8');
}

function keyEnvelopeRef(current: RealtimeCurrentBindingProjection): Readonly<Record<string, string>> {
  const digest = createHash('sha256').update(keyInfo(current)).digest('hex');
  return Object.freeze({ alias_type: 'key_envelope', issuer: 'local_gateway', value: `e2ee-${digest}` });
}

function fenceTuple(current: RealtimeCurrentBindingProjection): CredentialFenceTuple {
  return Object.freeze({
    realtimeSessionRef: current.session.realtimeSessionRef as CredentialFenceTuple['realtimeSessionRef'],
    deviceLeaseRef: current.lease.deviceLeaseRef as CredentialFenceTuple['deviceLeaseRef'],
    continuityId: current.session.continuityId,
    connectionEpoch: current.session.connectionEpoch,
    credentialGeneration: current.lease.leaseVersion,
  });
}

function activeChannels(request: JsonRecord): readonly (typeof MEDIA)[number][] {
  const requested = object(request.requested_media, 'PERSISTENT_E2EE_MEDIA_INVALID');
  const start = object(request.start, 'PERSISTENT_E2EE_MEDIA_INVALID');
  const modalities = start.modalities;
  if (start.kind !== 'explicit_user_start' || !Array.isArray(modalities)) fail('PERSISTENT_E2EE_MEDIA_INVALID');
  const channels = MEDIA.filter((name) => requested[name] === true && modalities.includes(name));
  if (channels.length === 0) fail('PERSISTENT_E2EE_MEDIA_INVALID');
  return Object.freeze(channels);
}

function futureExpiry(value: unknown, nowMs: number, code: string): number {
  if (typeof value !== 'string') fail(code);
  const expiresMs = Date.parse(value);
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= nowMs) fail(code);
  return expiresMs;
}

function envelopeExpiryAt(
  binding: RealtimeCurrentBindingProjection,
  credentialExpiresAt: unknown,
  nowMs: number,
): string {
  const credentialMs = futureExpiry(credentialExpiresAt, nowMs, 'PERSISTENT_E2EE_CREDENTIAL_EXPIRY_INVALID');
  const leaseMs = futureExpiry(binding.lease.expiresAt, nowMs, 'PERSISTENT_E2EE_EXPIRY_INVALID');
  const continuityMs = futureExpiry(binding.session.continuityExpiresAt, nowMs, 'PERSISTENT_E2EE_EXPIRY_INVALID');
  const expiresMs = Math.min(nowMs + 600_000, credentialMs, leaseMs, continuityMs);
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= nowMs) fail('PERSISTENT_E2EE_EXPIRY_INVALID');
  return new Date(expiresMs).toISOString();
}

export function createRealtimePublicControlPersistentE2eeOwner(
  options: RealtimePublicControlPersistentE2eeOwnerOptions,
): RealtimePublicControlPersistentE2eeOwner {
  if (!isRecord(options) || typeof options.pool?.connect !== 'function' ||
      typeof options.secretResolver?.resolve !== 'function' ||
      typeof (options.recipientCredential?.resolve ?? options.recipientCredential?.get) !== 'function' ||
      typeof options.readCurrentBinding !== 'function' || typeof options.credentialFence?.verify !== 'function' ||
      typeof options.readiness !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')) fail('PERSISTENT_E2EE_OPTIONS_INVALID');
  exactRootRef(options.rootKeyRef);
  const now = options.now ?? Date.now;
  let closed = false;
  let closeFlight: Promise<void> | undefined;
  const activeKeys = new Set<Uint8Array>();
  const ready = (): boolean => {
    if (closed) return false;
    try { return options.readiness() === true; } catch { return false; }
  };
  const guard = (): void => {
    if (closed) fail('PERSISTENT_E2EE_CLOSED');
    if (!ready()) fail('PERSISTENT_E2EE_NOT_READY');
  };
  const current = async (sessionRef: unknown): Promise<RealtimeCurrentBindingProjection> => {
    guard();
    let result: RealtimeCurrentBindingProjection | undefined;
    try { result = await options.readCurrentBinding({ realtimeSessionRef: sessionRef } as CurrentBindingLookup); }
    catch { fail('PERSISTENT_E2EE_CURRENT_BINDING_UNAVAILABLE'); }
    guard();
    return assertCurrent(result);
  };
  const assertUnfenced = async (binding: RealtimeCurrentBindingProjection): Promise<void> => {
    const snapshot = await options.credentialFence.verify(fenceTuple(binding));
    if (snapshot.active === true) fail('PERSISTENT_E2EE_CREDENTIAL_REVOKED');
  };
  const derive = async (binding: RealtimeCurrentBindingProjection): Promise<Uint8Array> => {
    const lease = await options.secretResolver.resolve(options.rootKeyRef);
    let root: Buffer | undefined;
    try {
      const encoded = lease.read();
      if (!ROOT_KEY.test(encoded)) fail('PERSISTENT_E2EE_ROOT_KEY_INVALID');
      root = Buffer.from(encoded, 'base64url');
      if (root.byteLength !== 32 || root.toString('base64url') !== encoded) fail('PERSISTENT_E2EE_ROOT_KEY_INVALID');
      return new Uint8Array(hkdfSync('sha256', root, Buffer.from(DOMAIN, 'utf8'), keyInfo(binding), 32));
    } finally {
      root?.fill(0);
      try { lease.release?.(); } catch { /* release cannot change the owner result */ }
    }
  };
  const validateRequestBinding = (request: JsonRecord, binding: RealtimeCurrentBindingProjection): void => {
    if (!same(request.realtime_session_ref, binding.session.realtimeSessionRef) ||
        !same(request.device_lease_ref, binding.lease.deviceLeaseRef) ||
        request.continuity_id !== binding.session.continuityId ||
        request.connection_epoch !== binding.session.connectionEpoch ||
        request.device_id !== binding.session.activeDeviceId ||
        request.key_generation !== binding.lease.leaseVersion || request.key_index !== 0 ||
        !same(request.key_envelope_ref, keyEnvelopeRef(binding))) {
      fail('PERSISTENT_E2EE_REQUEST_BINDING_INVALID');
    }
  };

  const contentKey: ContentKeyLeasePort = Object.freeze({
    lease: async ({ request, keyIndex, keyGeneration }: Parameters<NonNullable<ContentKeyLeasePort['lease']>>[0]) => {
      guard();
      const binding = await current(request.realtime_session_ref);
      validateRequestBinding(request, binding);
      if (keyIndex !== 0 || keyGeneration !== binding.lease.leaseVersion) fail('PERSISTENT_E2EE_GENERATION_INVALID');
      await assertUnfenced(binding);
      const expiresAt = new Date(Math.min(
        now() + 600_000,
        Date.parse(binding.lease.expiresAt),
        Date.parse(binding.session.continuityExpiresAt),
      )).toISOString();
      return Object.freeze({
        status: 'active' as const,
        expiresAt,
        keyIndex: 0,
        keyGeneration: binding.lease.leaseVersion,
        binding: Object.freeze({
          realtime_session_ref: binding.session.realtimeSessionRef,
          device_lease_ref: binding.lease.deviceLeaseRef,
          continuity_id: binding.session.continuityId,
          connection_epoch: binding.session.connectionEpoch,
          key_envelope_ref: request.key_envelope_ref,
          participant_audience: request.participant_audience,
          governance: request.governance,
        }),
        withKey: async <T>(callback: (key: Uint8Array) => Promise<T> | T): Promise<T> => {
          const key = await derive(binding);
          activeKeys.add(key);
          try { return await callback(key); }
          finally { key.fill(0); activeKeys.delete(key); }
        },
      });
    },
  });
  const replay = createRealtimeE2eeDurableReplayPostgres(options.pool);
  const e2eeCiphertext = createRealtimeE2eeCiphertextResolver({
    recipientCredential: options.recipientCredential,
    contentKey,
    replay,
    requestValidator: options.requestValidator,
    terminalValidator: options.terminalValidator,
    now,
  });
  const e2ee: RealtimeKeyResolverPort = Object.freeze({
    issue: async (input: Parameters<RealtimeKeyResolverPort['issue']>[0]) => {
      guard();
      if (input.operation !== 'bootstrap') fail('PERSISTENT_E2EE_OPERATION_INVALID');
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs)) fail('PERSISTENT_E2EE_CLOCK_INVALID');
      futureExpiry(input.credentialExpiresAt, nowMs, 'PERSISTENT_E2EE_CREDENTIAL_EXPIRY_INVALID');
      const request = object(input.request, 'PERSISTENT_E2EE_REQUEST_INVALID');
      const binding = await current(input.realtimeSessionRef);
      if (input.continuityId !== binding.session.continuityId ||
          !same(input.governance, request.governance) || request.device_id !== binding.session.activeDeviceId) {
        fail('PERSISTENT_E2EE_REQUEST_BINDING_INVALID');
      }
      await assertUnfenced(binding);
      const key = await derive(binding);
      activeKeys.add(key);
      const expiresAt = envelopeExpiryAt(binding, input.credentialExpiresAt, nowMs);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        key.fill(0);
        activeKeys.delete(key);
      };
      return Object.freeze({
        envelope: Object.freeze({
          key_envelope_ref: keyEnvelopeRef(binding),
          key_index: 0,
          key_generation: binding.lease.leaseVersion,
          expires_at: expiresAt,
          scope: Object.freeze({
            device_id: binding.session.activeDeviceId,
            channels: activeChannels(request),
            distribution_mode: 'application_controlled_envelope',
          }),
          realtime_session_ref: binding.session.realtimeSessionRef,
          continuity_id: binding.session.continuityId,
          governance: input.governance,
        }),
        roomOptions: Object.freeze({
          encryption: Object.freeze({
            encryptionType: 1,
            keyProviderOptions: Object.freeze({ ...LIVEKIT_KEY_PROVIDER_DEFAULTS, sharedKey: key }),
          }),
        }),
        release,
      });
    },
  });
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    closeFlight = (async () => {
      for (const key of activeKeys) key.fill(0);
      activeKeys.clear();
      await e2eeCiphertext.close?.();
    })();
    return closeFlight;
  };
  return Object.freeze({
    e2ee,
    e2eeCiphertext,
    readiness: () => Object.freeze({ ready: ready(), closed }),
    close,
  });
}

export const createPersistentE2eeOwner = createRealtimePublicControlPersistentE2eeOwner;
