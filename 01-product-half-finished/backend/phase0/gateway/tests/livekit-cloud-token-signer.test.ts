import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveKitCloudTokenSigner,
  LiveKitCloudTokenSignerError,
  assertCanonicalLiveKitCloudProjectUrl,
  assertCanonicalLiveKitApiUrl,
  isLiveKitOpaqueId,
  mapLiveKitGrantToServerGrant,
  type SecretResolverPort,
} from '../src/livekit-cloud-token-signer.ts';
import { TrackSource } from 'livekit-server-sdk';

function resolver(state: { resolved: string[]; released: number }): SecretResolverPort {
  return {
    async resolve(reference) {
      state.resolved.push(reference.name);
      return { read: () => `secret-${reference.name}`, release: () => { state.released += 1; } };
    },
  };
}

function signer(state: { resolved: string[]; released: number }, seen: { input?: unknown }): LiveKitCloudTokenSigner {
  return new LiveKitCloudTokenSigner({
    projectUrl: 'wss://project.livekit.cloud',
    apiKeyRef: { name: 'livekit/api-key', version: '1' },
    apiSecretRef: { name: 'livekit/api-secret', version: '1' },
    secretResolver: resolver(state),
    signJwt: async (input) => {
      seen.input = input;
      return 'opaque-signed-jwt';
    },
  });
}

const grants = {
  room: 'room-opaque', roomJoin: true as const, canPublish: true,
  canSubscribe: true, canPublishData: true, canPublishSources: ['microphone', 'camera'] as const,
};

test('URL validator accepts canonical TLS Cloud and self-hosted origins', () => {
  assert.equal(assertCanonicalLiveKitCloudProjectUrl('wss://project.livekit.cloud'), 'wss://project.livekit.cloud');
  assert.equal(
    assertCanonicalLiveKitCloudProjectUrl('wss://ai.example.invalid'),
    'wss://ai.example.invalid',
  );
  assert.throws(() => assertCanonicalLiveKitCloudProjectUrl('https://project.livekit.cloud'), /INVALID_LIVEKIT_CLOUD_URL/);
  assert.throws(() => assertCanonicalLiveKitCloudProjectUrl('wss://project.livekit.cloud/room'), /INVALID_LIVEKIT_CLOUD_URL/);
  assert.throws(() => assertCanonicalLiveKitCloudProjectUrl('wss://ai.example.invalid/rtc'), /INVALID_LIVEKIT_CLOUD_URL/);
  assert.throws(() => assertCanonicalLiveKitCloudProjectUrl('wss://ai.example.invalid?protocol=17'), /INVALID_LIVEKIT_CLOUD_URL/);
  assert.throws(() => assertCanonicalLiveKitCloudProjectUrl('wss://ai.example.invalid:443'), /INVALID_LIVEKIT_CLOUD_URL/);
  assert.equal(assertCanonicalLiveKitCloudProjectUrl('wss://other.example:9443'), 'wss://other.example:9443');
  assert.equal(assertCanonicalLiveKitCloudProjectUrl('wss://127.0.0.1:11482'), 'wss://127.0.0.1:11482');
  assert.throws(() => assertCanonicalLiveKitCloudProjectUrl('wss://user:secret@other.example:9443'), /INVALID_LIVEKIT_CLOUD_URL/);
});

test('signer binds the exact PAIOS self-hosted origin without weakening project binding', () => {
  const state = { resolved: [] as string[], released: 0 };
  const instance = new LiveKitCloudTokenSigner({
    projectUrl: 'wss://ai.example.invalid',
    apiKeyRef: { name: 'livekit/api-key' },
    apiSecretRef: { name: 'livekit/api-secret' },
    secretResolver: resolver(state),
    signJwt: async () => 'opaque-signed-jwt',
  });
  assert.doesNotThrow(() => instance.assertProjectUrl('wss://ai.example.invalid'));
  assert.throws(() => instance.assertProjectUrl('wss://project.livekit.cloud'), /LIVEKIT_PROJECT_BINDING_MISMATCH/u);
});

test('signer enforces the configured Cloud project profile before signing', () => {
  const state = { resolved: [] as string[], released: 0 };
  const instance = signer(state, {});
  assert.doesNotThrow(() => instance.assertProjectUrl('wss://project.livekit.cloud'));
  assert.throws(() => instance.assertProjectUrl('wss://other.livekit.cloud'), /LIVEKIT_PROJECT_BINDING_MISMATCH/);
});

test('signer maps explicit grants and releases secret leases without exposing refs', async () => {
  const state = { resolved: [] as string[], released: 0 };
  const seen: { input?: any } = {};
  const instance = signer(state, seen);
  const token = await instance.sign({ room: 'room-opaque', identity: 'device-opaque', ttlSeconds: 120, grants });
  assert.equal(token, 'opaque-signed-jwt');
  assert.deepEqual(state.resolved, ['livekit/api-key', 'livekit/api-secret']);
  assert.equal(state.released, 2);
  assert.deepEqual(seen.input.request.grants.canPublishSources, ['microphone', 'camera']);
  assert.equal(seen.input.apiKey, 'secret-livekit/api-key');
  assert.equal(seen.input.apiSecret, 'secret-livekit/api-secret');
});

test('signer rejects TTL and grant escalation before signing', async () => {
  const state = { resolved: [] as string[], released: 0 };
  const seen: { input?: unknown } = {};
  const instance = signer(state, seen);
  await assert.rejects(
    instance.sign({ room: 'room-opaque', identity: 'device-opaque', ttlSeconds: 901, grants }),
    (error: unknown) => error instanceof LiveKitCloudTokenSignerError && error.code === 'INVALID_LIVEKIT_TOKEN_TTL',
  );
  await assert.rejects(
    instance.sign({ room: 'room-opaque', identity: 'device-opaque', ttlSeconds: 120, grants: { ...grants, canPublish: false, canPublishSources: ['camera'] } }),
    (error: unknown) => error instanceof LiveKitCloudTokenSignerError && error.code === 'INVALID_LIVEKIT_GRANTS',
  );
  const unsupported = ['screen_' + 'share'];
  await assert.rejects(
    instance.sign({ room: 'room-opaque', identity: 'device-opaque', ttlSeconds: 120, grants: { ...grants, canPublishSources: unsupported as never } }),
    (error: unknown) => error instanceof LiveKitCloudTokenSignerError && error.code === 'INVALID_LIVEKIT_GRANTS',
  );
  assert.equal(seen.input, undefined);
  assert.equal(state.resolved.length, 0);
});

test('SDK grant mapping uses typed TrackSource enums for microphone and camera', () => {
  const mapped = mapLiveKitGrantToServerGrant(grants);
  assert.deepEqual(mapped.canPublishSources, [TrackSource.MICROPHONE, TrackSource.CAMERA]);
  assert.equal(mapped.room, 'room-opaque');
});

test('signer rejects closed state and plaintext endpoints', async () => {
  const state = { resolved: [] as string[], released: 0 };
  const seen: { input?: unknown } = {};
  const instance = signer(state, seen);
  instance.close();
  await assert.rejects(instance.sign({ room: 'room-opaque', identity: 'device-opaque', ttlSeconds: 120, grants }), /TOKEN_SIGNER_CLOSED/);
  assert.throws(() => new LiveKitCloudTokenSigner({
    projectUrl: 'ws://127.0.0.1:11482', apiKeyRef: { name: 'key' }, apiSecretRef: { name: 'secret' }, secretResolver: resolver(state),
  }), /INVALID_LIVEKIT_CLOUD_URL/);
});

test('system-minted ids with long digit runs stay valid; PII-named segments do not', () => {
  // A real device UUIDv7 and transport alias from Mac provisioning: random hex holds 7+ digit runs.
  assert.equal(isLiveKitOpaqueId('01a111a1-c81d-752b-88e1-e78536003e00'), true);
  assert.equal(isLiveKitOpaqueId('t02.realtime.transport-alias.v1:1132829b957c9689f51634be31b66ff6'), true);
  for (const value of ['user_phone_1', 'email-alias', 'x_token', '', ' leading', 'a/b']) assert.equal(isLiveKitOpaqueId(value), false, value);
});

test('RoomService origin accepts TLS or exact loopback HTTP and rejects remote plaintext or URL credentials', () => {
 for(const url of ['http://127.0.0.1:7880','http://[::1]:7880','https://rtc.example:9443']) assert.equal(assertCanonicalLiveKitApiUrl(url),url);
 for(const url of ['http://192.0.2.1:7880','http://localhost:7880','https://u:p@rtc.example','https://rtc.example/twirp','https://rtc.example?token=x']) assert.throws(()=>assertCanonicalLiveKitApiUrl(url),/INVALID_LIVEKIT_API_URL/);
});
