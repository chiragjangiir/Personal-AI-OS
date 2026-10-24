import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  RoomEvent,
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import {
  RayneoRealtimeAudioController,
  RAYNEO_REALTIME_AUDIO_DIAGNOSTIC_STAGES,
  RAYNEO_REALTIME_OWNER_ISSUANCE,
  readRayneoRealtimeOwnerIssuance,
  replyText,
  type RayneoRealtimeAudioConfig,
  type RayneoRealtimeAudioDiagnosticStage,
  type RayneoRealtimeAudioObservation,
  type RayneoFinalTranscriptAuthorityInput,
  type RayneoRealtimeMultimodalReplyInput,
  type RayneoRealtimeVisualHeartbeatInput,
  type RayneoSpeakerDiarizationPort,
} from '../src/rayneo-realtime-audio-controller.ts';
import { createProductionRayneoLiveKitOwnerAliasIssuer } from '../src/rayneo-livekit-owner-alias-issuer.ts';
import { RayneoSessionTurnContext } from '../src/rayneo-session-turn-context.ts';

const NOW = Math.floor(Date.now() / 1_000) * 1_000;
const SESSION = 'phase0_session_aaaaaaaaaaaaaaaaaaaa';
const DEVICE = 'rayneo_device_bbbbbbbbbbbbbbbbbbbb';
const CLIENT = 'rayneo_client_cccccccccccccccccccc';
const CHINESE_REPLY = '请查看画面中的主要内容。';
const CONFIG: RayneoRealtimeAudioConfig = Object.freeze({
  livekitUrl: 'wss://ai.example.test',
  clientLivekitUrl: 'wss://ai.example.test',
  apiKey: '0123456789abcdef',
  apiSecret: '0123456789abcdef0123456789abcdef',
  sttEndpointUrl: 'http://127.0.0.1:8001/v1/audio/transcriptions',
  sttModel: 'faster-whisper-large-v3-turbo-ct2',
  sttDeadlineMs: 8_000,
  ollamaModel: 'qwen3:8b',
  ollamaEndpointUrl: 'http://127.0.0.1:11571',
  windowSeconds: 2,
});

class FakeRoom {
  readonly handlers = new Map<string, (...args: never[]) => void>();
  readonly textStreamHandlers = new Map<string, (
    reader: { readAll(): Promise<string> },
    participant: { identity: string },
  ) => void>();
  readonly connectCalls: Array<readonly [string, string]> = [];
  readonly data: Array<readonly [string, Record<string, unknown>]> = [];
  disconnectCount = 0;
  localParticipant = {
    sendText: async (text: string, options: Record<string, unknown> = {}) => {
      this.data.push([text, options]);
      return {};
    },
  };
  on(event: string, handler: (...args: never[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  off(event: string, handler: (...args: never[]) => void): this {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
    return this;
  }
  registerTextStreamHandler(
    topic: string,
    handler: (reader: { readAll(): Promise<string> }, participant: { identity: string }) => void,
  ): void {
    if (this.textStreamHandlers.has(topic)) throw new Error('DUPLICATE_TEXT_HANDLER');
    this.textStreamHandlers.set(topic, handler);
  }
  unregisterTextStreamHandler(topic: string): void {
    this.textStreamHandlers.delete(topic);
  }
  async connect(url: string, token: string): Promise<void> {
    this.connectCalls.push([url, token]);
  }
  async disconnect(): Promise<void> { this.disconnectCount += 1; }

  async emitSyntheticPcm(text: string, identity = DEVICE): Promise<void> {
    const handler = this.textStreamHandlers.get('paios.rayneo.synthetic.remember.pcm.v1');
    assert.ok(handler);
    handler({ readAll: async () => text }, { identity });
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function payload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function response(body: unknown, status = 200): Response {
  return {
    status,
    redirected: false,
    type: 'basic',
    json: async () => body,
  } as Response;
}

function audioFrame(samples = 32_000, amplitude = 10) {
  return {
    data: new Int16Array(samples).fill(amplitude),
    sampleRate: 16_000,
    channels: 1,
    samplesPerChannel: samples,
  };
}

function participant(): RemoteParticipant {
  return {
    identity: DEVICE,
    attributes: {
      device_id: DEVICE,
      device_class: 'rayneo',
      client_instance_id: CLIENT,
      session_id: SESSION,
    },
  } as unknown as RemoteParticipant;
}

function microphone(): {
  readonly track: RemoteTrack;
  readonly publication: RemoteTrackPublication;
} {
  const track = {} as RemoteTrack;
  return {
    track,
    publication: {
      kind: TrackKind.KIND_AUDIO,
      source: TrackSource.SOURCE_MICROPHONE,
      sid: 'TR_RayNeoMic01',
      track,
    } as RemoteTrackPublication,
  };
}

async function waitUntil(predicate: () => boolean, turns = 100): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('bounded wait expired');
}

const SYNTHETIC_PCM_ASSET = new URL(
  '../../../../rayneo-android/app/src/debug/assets/rayneo_debug_local_audio.pcm.gz.b64',
  import.meta.url,
);

function syntheticPcmEnvelope(overrides: Record<string, unknown> = {}): string {
  const encoded = readFileSync(SYNTHETIC_PCM_ASSET, 'utf8').replace(/\s+/gu, '');
  const raw = gunzipSync(Buffer.from(encoded, 'base64'));
  assert.equal(raw.length, 288_000);
  assert.equal(createHash('sha256').update(raw).digest('hex').toUpperCase(),
    '942B1FF2A6E394F85AD653725055409043CC287D7441D6BEFFF2A76549079D79');
  raw.fill(0);
  return JSON.stringify({
    schema: 'paios.rayneo.synthetic.remember.pcm.v1',
    session_id: SESSION,
    device_id: DEVICE,
    client_instance_id: CLIENT,
    encoding: 'gzip+base64',
    format: 'pcm_s16le',
    sample_rate: 16_000,
    channels: 1,
    raw_bytes: 288_000,
    raw_sha256: '942B1FF2A6E394F85AD653725055409043CC287D7441D6BEFFF2A76549079D79',
    pcm_gzip_b64: encoded,
    ...overrides,
  });
}

test('token is session/device-bound microphone+camera with data receive-only and bootstrap values are strict', async () => {
  const room = new FakeRoom();
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, { roomFactory: () => room, now: () => NOW });
  assert.equal(controller.livekit_url, 'wss://ai.example.test');
  const claims = payload(controller.livekit_token);
  assert.equal(controller.livekit_token_expires_at, new Date(Number(claims.exp) * 1_000).toISOString());
  assert.equal(Number(claims.exp) - Number(claims.iat), 120);
  assert.equal((NOW + 900_000) - Number(claims.exp) * 1_000, 780_000);
  assert.equal(controller.livekit_video_publish_enabled, true);
  assert.equal(claims.sub, DEVICE);
  assert.deepEqual(claims.attributes, {
    device_id: DEVICE,
    device_class: 'rayneo',
    client_instance_id: CLIENT,
    session_id: SESSION,
  });
  assert.deepEqual(claims.video, {
    room: SESSION,
    roomJoin: true,
    canPublish: true,
    canPublishSources: ['microphone', 'camera'],
    canPublishData: false,
    canSubscribe: true,
  });
  assert.equal(JSON.stringify(claims).includes('screen_share'), false);
  assert.equal(room.connectCalls.length, 1);
  assert.equal(room.connectCalls[0]![0], 'wss://ai.example.test');
  assert.notEqual(room.connectCalls[0]![1], controller.livekit_token);
  const agentClaims = payload(room.connectCalls[0]![1]);
  assert.equal(agentClaims.iat, claims.iat);
  assert.equal(agentClaims.exp, claims.exp);
  await controller.cleanup();
});

test('a 24-hour logical media binding keeps short initial tokens and rejects any longer binding', async () => {
  const room = new FakeRoom();
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 86_400_000,
  }, { roomFactory: () => room, now: () => NOW });
  const participantClaims = payload(controller.livekit_token);
  const agentClaims = payload(room.connectCalls[0]![1]);
  assert.equal(Number(participantClaims.exp) - Number(participantClaims.iat), 120);
  assert.equal(Number(agentClaims.exp) - Number(agentClaims.iat), 120);
  assert.equal((NOW + 86_400_000) - Number(participantClaims.exp) * 1_000, 86_280_000);
  await controller.cleanup();

  await assert.rejects(
    RayneoRealtimeAudioController.create(CONFIG, {
      sessionId: SESSION,
      deviceId: DEVICE,
      clientInstanceId: CLIENT,
      openedAt: NOW,
      expiresAt: NOW + 86_400_001,
    }, { roomFactory: () => new FakeRoom(), now: () => NOW }),
    /RAYNEO_REALTIME_BINDING_INVALID/u,
  );
});

test('owner alias issuance is internal, signed-token-bound, and absent from the public session shape', async () => {
  const room = new FakeRoom();
  const ownerAliasIssuer = createProductionRayneoLiveKitOwnerAliasIssuer({
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, { roomFactory: () => room, now: () => NOW, ownerAliasIssuer });
  const issuance = readRayneoRealtimeOwnerIssuance(controller);
  assert.ok(issuance);
  assert.equal(issuance.sessionId, SESSION);
  assert.equal(issuance.deviceId, DEVICE);
  assert.equal(issuance.clientInstanceId, CLIENT);
  assert.equal(issuance.receipt.aliases.tokenExpiresAt, controller.livekit_token_expires_at);
  assert.match(issuance.receipt.aliases.provider, /^paios_livekit_alias_provider_/u);
  assert.equal(Object.getOwnPropertyDescriptor(controller, RAYNEO_REALTIME_OWNER_ISSUANCE)?.enumerable, false);
  assert.equal(Object.keys(controller).some((key) => key.includes('alias')), false);
  assert.equal(JSON.stringify(issuance).includes(controller.livekit_token), false);
  await controller.cleanup();
  ownerAliasIssuer.clear();
});

test('participant and agent tokens stay within binding across asynchronous cross-second signing', async () => {
  const room = new FakeRoom();
  const boundaryNow = Math.floor(Date.now() / 1_000) * 1_000;
  let signed = 0;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: boundaryNow,
    expiresAt: boundaryNow + 900_000,
  }, {
    roomFactory: () => room,
    now: () => boundaryNow,
    signToken: async (token) => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      signed += 1;
      return token.toJwt();
    },
  });
  assert.equal(signed, 2);
  const participantClaims = payload(controller.livekit_token);
  const agentClaims = payload(room.connectCalls[0]![1]);
  for (const claims of [participantClaims, agentClaims]) {
    assert.equal(claims.iat, Math.floor(boundaryNow / 1_000));
    assert.equal(Number(claims.exp) - Number(claims.iat), 120);
    assert.equal((boundaryNow + 900_000) - Number(claims.exp) * 1_000, 780_000);
  }
  assert.equal(participantClaims.sub, DEVICE);
  assert.deepEqual(agentClaims.attributes, {
    device_id: agentClaims.sub,
    device_class: 'windows_gateway',
    session_id: SESSION,
  });
  assert.deepEqual(agentClaims.video, {
    room: SESSION,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });
  await controller.cleanup();
});

test('initial token TTL uses the short-session remainder minus safety and fails closed without one second', async () => {
  const shortRoom = new FakeRoom();
  const short = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 30_000,
  }, { roomFactory: () => shortRoom, now: () => NOW });
  const participantClaims = payload(short.livekit_token);
  const agentClaims = payload(shortRoom.connectCalls[0]![1]);
  assert.equal(Number(participantClaims.exp) - Number(participantClaims.iat), 25);
  assert.equal(agentClaims.iat, participantClaims.iat);
  assert.equal(agentClaims.exp, participantClaims.exp);
  assert.equal(Number(participantClaims.exp) * 1_000, NOW + 25_000);
  await short.cleanup();

  const expiredRoom = new FakeRoom();
  await assert.rejects(
    RayneoRealtimeAudioController.create(CONFIG, {
      sessionId: SESSION,
      deviceId: DEVICE,
      clientInstanceId: CLIENT,
      openedAt: NOW,
      expiresAt: NOW + 5_000,
    }, { roomFactory: () => expiredRoom, now: () => NOW }),
    /RAYNEO_LIVEKIT_TOKEN_INVALID/,
  );
  assert.equal(expiredRoom.connectCalls.length, 0);
  assert.equal(expiredRoom.disconnectCount, 0);
});

test('Windows agent retains its reply grant while ordinary RayNeo receives only mic+camera media', async () => {
  const source = readFileSync(
    new URL('../src/rayneo-realtime-audio-controller.ts', import.meta.url), 'utf8',
  );
  assert.match(source, /canPublishSources:\s*\[ServerTrackSource\.MICROPHONE,\s*ServerTrackSource\.CAMERA\]/u);
  assert.match(source, /canPublishData:\s*syntheticPcmEnabled/u);
  assert.match(source, /canPublishData:\s*true/u);
  const ordinaryRoom = new FakeRoom();
  const ordinary = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, { roomFactory: () => ordinaryRoom, now: () => NOW });
  assert.equal(ordinaryRoom.textStreamHandlers.size, 0);
  assert.equal((payload(ordinary.livekit_token).video as Record<string, unknown>).canPublishData, false);
  await ordinary.cleanup();
  const debugRoom = new FakeRoom();
  const issuer = createProductionRayneoLiveKitOwnerAliasIssuer({ randomBytes: (size) => Buffer.alloc(size, 3) });
  const debug = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, { roomFactory: () => debugRoom, now: () => NOW, ownerAliasIssuer: issuer });
  assert.equal(debugRoom.textStreamHandlers.size, 1);
  assert.equal((payload(debug.livekit_token).video as Record<string, unknown>).canPublishData, true);
  await debug.cleanup();
  issuer.clear();
  const bridge = readFileSync(
    new URL('../src/rayneo-realtime-video-bridge.ts', import.meta.url), 'utf8',
  );
  assert.match(bridge, /LocalVideoTrack\.createVideoTrack/u);
  assert.match(bridge, /VideoSource/u);
  assert.match(bridge, /VideoStream/u);
  assert.match(bridge, /TrackSource\.SOURCE_CAMERA/u);
});

test('existing Public room attaches one public-assistant audio handler without reconnect or room disconnect', async () => {
  const room = new FakeRoom();
  const controller = await RayneoRealtimeAudioController.attachExistingRoom(CONFIG, {
    sessionId: 'public-room-session',
    deviceId: 'terminal-identity',
    clientInstanceId: 'public-client-instance',
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, room as never, {
    roomProfile: Object.freeze({ kind: 'public-assistant', participantIdentity: 'terminal-identity' }),
    now: () => NOW,
    audioStreamFactory: () => (async function* () { yield audioFrame(32_000, 1_000); })(),
    fetch: async (input) => String(input).includes('/audio/transcriptions')
      ? response({ text: '公开房间语音。' })
      : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] }),
  });
  assert.equal(room.connectCalls.length, 0);
  const track = {} as RemoteTrack;
  const publication = {
    kind: TrackKind.KIND_AUDIO,
    source: TrackSource.SOURCE_MICROPHONE,
    sid: 'TR_PublicMic01',
    track,
  } as RemoteTrackPublication;
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    track as never,
    publication as never,
    { identity: 'terminal-identity', attributes: {} } as never,
  );
  for (let index = 0; index < 20 && room.data.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(room.data.length, 1);
  const reply = JSON.parse(room.data[0]![0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reply).sort(), ['is_final', 'sequence', 'stream_id', 'text']);
  assert.equal(reply.is_final, true);
  assert.equal(room.data[0]![1]?.topic, 'paios.assistant.result.local.v1');
  assert.deepEqual(room.data[0]![1]?.destinationIdentities, ['terminal-identity']);
  await controller.cleanup();
  assert.equal(room.disconnectCount, 0);
  assert.equal(room.handlers.has(RoomEvent.TrackSubscribed), false);
  assert.equal(room.handlers.has(RoomEvent.Disconnected), false);
});

test('existing Public room runs two distinct finals through STT, evidence, and one Qwen reply each', async () => {
  const room = new FakeRoom();
  const events: string[] = [];
  const transcripts = ['第一段语音。', '第二段语音。'];
  let streamIndex = 0;
  const evidenceRefs: string[] = [];
  const qwenInputs: string[] = [];
  const controller = await RayneoRealtimeAudioController.attachExistingRoom(CONFIG, {
    sessionId: 'public-room-session',
    deviceId: 'terminal-identity',
    clientInstanceId: 'public-client-instance',
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, room as never, {
    roomProfile: Object.freeze({ kind: 'public-assistant', participantIdentity: 'terminal-identity' }),
    now: () => NOW,
    audioStreamFactory: () => (async function* () {
      yield audioFrame(32_000, 1_000);
    })(),
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) {
        events.push('stt');
        return response({ text: transcripts[streamIndex++] });
      }
      throw new Error('UNEXPECTED_DIRECT_QWEN');
    },
    finalTranscriptAuthority: {
      finalize: async () => { events.push('evidence'); },
      finalizeWithEvidence: async () => {
        const ref = `evidence-${evidenceRefs.length + 1}`;
        evidenceRefs.push(ref);
        return { evidenceRef: ref } as never;
      },
    },
    afterFinalTranscript: async ({ evidence }) => {
      events.push('after-evidence');
      assert.equal(evidence.evidenceRef, evidenceRefs.at(-1));
    },
    generateReply: async (transcript) => {
      events.push('qwen');
      qwenInputs.push(transcript);
      return `回复${qwenInputs.length}`;
    },
  });
  const participantValue = { identity: 'terminal-identity', attributes: {} } as never;
  const first = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    first.track as never, first.publication as never, participantValue,
  );
  for (let index = 0; index < 20 && room.data.length < 1; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const second = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    second.track as never, second.publication as never, participantValue,
  );
  for (let index = 0; index < 20 && room.data.length < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(room.connectCalls.length, 0);
  assert.deepEqual(evidenceRefs, ['evidence-1', 'evidence-2']);
  assert.deepEqual(qwenInputs, transcripts);
  assert.deepEqual(events, [
    'stt', 'after-evidence', 'qwen',
    'stt', 'after-evidence', 'qwen',
  ]);
  assert.equal(room.data.length, 2);
  await controller.cleanup();
});

test('existing Public room video-only observes distinct camera samples through the same reply path without STT', async () => {
  const room = new FakeRoom();
  const visualInputs: RayneoRealtimeVisualHeartbeatInput[] = [];
  const lifecycle: string[] = [];
  let sampleHandler: ((sample: {
    readonly observedAtMs: number;
    readonly mimeType: 'image/png';
    readonly width: number;
    readonly height: number;
    readonly bytes: Uint8Array;
  }) => void | Promise<void>) | undefined;
  let videoStopped = 0;
  let sttCalls = 0;
  const controller = await RayneoRealtimeAudioController.attachExistingRoom(
    Object.freeze({ ...CONFIG, visualHeartbeatSeconds: 4 }),
    {
      sessionId: 'public-room-session',
      deviceId: 'bearer-device',
      clientInstanceId: 'terminal-identity',
      openedAt: NOW,
      expiresAt: NOW + 900_000,
    },
    room as never,
    {
      roomProfile: Object.freeze({
        kind: 'public-assistant', participantIdentity: 'terminal-identity',
        dataEnabled: true, audioEnabled: false, videoEnabled: true,
      }),
      now: () => NOW,
      fetch: async () => { sttCalls += 1; throw new Error('VIDEO_ONLY_MUST_NOT_CALL_STT'); },
      videoBridgeFactory: async (_room, _binding, _observe, onSample) => {
        sampleHandler = onSample;
        return {
          readSamples: () => Object.freeze([]),
          stop: async () => { videoStopped += 1; },
        };
      },
      generateVisualHeartbeatReply: async (input) => {
        visualInputs.push(input);
        return CHINESE_REPLY;
      },
      completeConversationTurn: async (inputId) => { lifecycle.push(`complete:${inputId}`); },
      markIndeterminateConversationTurn: async (inputId) => { lifecycle.push(`indeterminate:${inputId}`); },
      releaseConversationTurn: async (inputId) => { lifecycle.push(`release:${inputId}`); },
    },
  );
  assert.ok(sampleHandler);
  const sample = (observedAtMs: number, marker: number) => ({
    observedAtMs,
    mimeType: 'image/png' as const,
    width: 1,
    height: 1,
    bytes: Uint8Array.of(137, 80, 78, 71, marker),
  });
  await sampleHandler!(sample(NOW + 500, 1));
  await waitUntil(() => room.data.length === 1, 300);
  await sampleHandler!(sample(NOW + 5_000, 2));
  await waitUntil(() => room.data.length === 2, 300);
  assert.equal(sttCalls, 0);
  assert.equal(visualInputs.length, 2);
  assert.deepEqual(lifecycle, [
    `complete:${visualInputs[0]!.segmentId}`,
    `complete:${visualInputs[1]!.segmentId}`,
  ]);
  assert.notEqual(visualInputs[0]!.segmentId, visualInputs[1]!.segmentId);
  assert.deepEqual(room.data.map(([text]) => (JSON.parse(text) as Record<string, unknown>).stream_id), [
    visualInputs[0]!.segmentId, visualInputs[1]!.segmentId,
  ]);
  await controller.cleanup();
  assert.equal(videoStopped, 1);
  assert.equal(room.disconnectCount, 0);
  await sampleHandler!(sample(NOW + 9_000, 3));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(room.data.length, 2);
});

test('video bridge failure degrades only video and leaves the realtime session cleanable', async () => {
  const room = new FakeRoom();
  const stages: string[] = [];
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    videoBridgeFactory: async () => { throw new Error('synthetic video failure'); },
    observeVideoFixedStage: (stage) => stages.push(stage),
  });
  assert.deepEqual(stages, ['VIDEO_BRIDGE_FAILED']);
  assert.equal(room.connectCalls.length, 1);
  assert.equal(await controller.cleanup(), true);
  assert.equal(room.disconnectCount, 1);
});

test('fixed realtime diagnostics are an allowlisted enum with no sensitive payload fields', () => {
  assert.deepEqual([...RAYNEO_REALTIME_AUDIO_DIAGNOSTIC_STAGES], [
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_CLOSED',
    'REMOTE_MIC_TRACK_REJECTED_DUPLICATE',
    'REMOTE_MIC_TRACK_REJECTED_IDENTITY',
    'REMOTE_MIC_TRACK_REJECTED_ATTRIBUTES',
    'REMOTE_MIC_TRACK_REJECTED_KIND',
    'REMOTE_MIC_TRACK_REJECTED_SOURCE',
    'REMOTE_MIC_TRACK_SUBSCRIBED',
    'AUDIO_FRAME_OBSERVED',
    'AUDIO_SIGNAL_OBSERVED',
    'WINDOW_READY',
    'STT_REQUESTED',
    'STT_ACCEPTED',
    'FINAL_TRANSCRIPT_COMMITTED',
    'STT_EMPTY',
    'STT_FAILED',
    'TEXT_STREAM_ACCEPTED',
    'DIARIZATION_WINDOW_LOCAL',
    'DIARIZATION_DEGRADED',
    'JOINT_CONTEXT_APPLIED',
    'VIDEO_CONTEXT_APPLIED',
    'VISUAL_HEARTBEAT_SENT',
    'REPLY_SENT',
  ]);
  const source = readFileSync(
    new URL('../src/rayneo-realtime-audio-controller.ts', import.meta.url), 'utf8',
  );
  const diagnosticSource = source.slice(
    source.indexOf('RAYNEO_REALTIME_AUDIO_DIAGNOSTIC_STAGES'),
    source.indexOf('export interface RayneoRealtimeAudioConfig'),
  );
  assert.match(diagnosticSource, /rayneo_realtime_stage=\$\{stage\}/u);
  assert.doesNotMatch(
    diagnosticSource,
    /sessionId|deviceId|clientInstanceId|speaker|transcript|token|pcm|audioBytes|sampleRate/u,
  );
});

test('remote microphone admission emits one value-free callback and one exact rejection reason in order', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { /* empty accepted track */ })(),
  });
  const onTrack = room.handlers.get(RoomEvent.TrackSubscribed);
  assert.ok(onTrack);

  const wrongIdentity = participant() as unknown as { identity: string; attributes: Record<string, string> };
  wrongIdentity.identity = `${DEVICE}_other`;
  const identityMic = microphone();
  onTrack(identityMic.track as never, identityMic.publication as never, wrongIdentity as never);

  const wrongAttributes = participant() as unknown as { identity: string; attributes: Record<string, string> };
  wrongAttributes.attributes = { ...wrongAttributes.attributes, session_id: `${SESSION}_other` };
  const attributesMic = microphone();
  onTrack(attributesMic.track as never, attributesMic.publication as never, wrongAttributes as never);

  const kindMic = microphone();
  const wrongKind = {
    ...kindMic.publication,
    kind: TrackKind.KIND_VIDEO,
  } as RemoteTrackPublication;
  onTrack(kindMic.track as never, wrongKind as never, participant() as never);

  const sourceMic = microphone();
  const wrongSource = {
    ...sourceMic.publication,
    source: TrackSource.SOURCE_CAMERA,
  } as RemoteTrackPublication;
  onTrack(sourceMic.track as never, wrongSource as never, participant() as never);

  const accepted = microphone();
  onTrack(accepted.track as never, accepted.publication as never, participant() as never);
  onTrack(accepted.track as never, accepted.publication as never, participant() as never);
  await controller.cleanup();

  const closedMic = microphone();
  onTrack(closedMic.track as never, closedMic.publication as never, participant() as never);
  assert.deepEqual(diagnostics, [
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_IDENTITY',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_ATTRIBUTES',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_KIND',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_SOURCE',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_SUBSCRIBED',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_DUPLICATE',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_CLOSED',
  ]);
  for (const stage of diagnostics) assert.match(stage, /^[A-Z_]+$/u);
});

test('realtime reply requires bounded Chinese text and rejects unsafe or English-only output', () => {
  assert.equal(replyText({ choices: [{ message: { content: CHINESE_REPLY } }] }), CHINESE_REPLY);
  const mixed = '请查看Qwen3模型的主要结果。';
  assert.equal(replyText({ choices: [{ message: { content: mixed } }] }), mixed);
  for (const content of [
    'Please inspect the scene.',
    `${'画'.repeat(81)}。`,
    '请查看画面。\n稍后回复。',
    '请打开https://example.com查看结果。',
    '请使用Bearer sk-secret查看结果。',
  ]) {
    assert.throws(() => replyText({ choices: [{ message: { content } }] }), /RAYNEO_OLLAMA_RESPONSE_INVALID/u);
  }
});

test('default realtime reply fuses two time-aligned camera samples into one no-thinking model request', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const firstBytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3);
  const secondBytes = Uint8Array.of(137, 80, 78, 71, 4, 5, 6);
  const reads: Array<readonly [number, number, number | undefined]> = [];
  let modelRequest: Record<string, unknown> | undefined;
  let videoStopped = 0;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    videoBridgeFactory: async () => ({
      readSamples: (start, end, max) => {
        reads.push([start, end, max]);
        return Object.freeze([
          Object.freeze({ observedAtMs: NOW + 500, mimeType: 'image/png' as const, width: 2, height: 1, bytes: firstBytes }),
          Object.freeze({ observedAtMs: NOW + 1_500, mimeType: 'image/png' as const, width: 2, height: 1, bytes: secondBytes }),
        ]);
      },
      stop: async () => { videoStopped += 1; },
    }),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    diarizer: { diarize: async () => ({ status: 'degraded' }) },
    fetch: async (input, init) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: '请说明眼前正在发生什么。' });
      if (String(input).includes('/chat/completions')) {
        modelRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ choices: [{ message: { content: CHINESE_REPLY } }] });
      }
      throw new Error('UNEXPECTED_FETCH');
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1, 300);
  assert.deepEqual(reads, [[NOW, NOW + 2_000, 2]]);
  assert.ok(modelRequest);
  assert.equal(modelRequest.reasoning_effort, 'none');
  assert.equal(modelRequest.max_tokens, 96);
  const messages = modelRequest.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 2);
  const content = messages[1]!.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 3);
  assert.equal(content[0]!.type, 'text');
  assert.equal((content[1]!.image_url as { url: string }).url,
    'data:image/png;base64,iVBORwECAw==');
  assert.equal((content[2]!.image_url as { url: string }).url,
    'data:image/png;base64,iVBORwQFBg==');
  assert.equal(diagnostics.filter((stage) => stage === 'VIDEO_CONTEXT_APPLIED').length, 1);
  assert.equal(firstBytes.every((value) => value === 0), true);
  assert.equal(secondBytes.every((value) => value === 0), true);
  assert.equal(JSON.parse(room.data[0]![0]).reply, CHINESE_REPLY);
  await controller.cleanup();
  assert.equal(videoStopped, 1);
});

test('production multimodal override receives the exact segment window before transcript-only fallback', async () => {
  const room = new FakeRoom();
  const bytes = Uint8Array.of(137, 80, 78, 71, 9);
  let transcriptOnlyCalls = 0;
  let captured: RayneoRealtimeMultimodalReplyInput | undefined;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    videoBridgeFactory: async () => ({
      readSamples: () => Object.freeze([
        Object.freeze({ observedAtMs: NOW + 500, mimeType: 'image/png' as const, width: 1, height: 1, bytes }),
      ]),
      stop: async () => undefined,
    }),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    diarizer: { diarize: async () => ({ status: 'degraded' }) },
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: '请结合画面回答。' });
      throw new Error('UNEXPECTED_FETCH');
    },
    generateReply: async () => { transcriptOnlyCalls += 1; return CHINESE_REPLY; },
    generateMultimodalReply: async (input) => { captured = input; return CHINESE_REPLY; },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1, 300);
  assert.equal(transcriptOnlyCalls, 0);
  assert.ok(captured);
  assert.match(captured.segmentId, /^rayneo_segment_[a-f0-9]{20}$/u);
  assert.equal(captured.startMs, 0);
  assert.equal(captured.endMs, 2_000);
  assert.equal(captured.transcript, '请结合画面回答。');
  assert.equal(captured.videoSamples.length, 1);
  assert.equal(bytes.every((value) => value === 0), true);
  await controller.cleanup();
});

test('silent active session emits a bounded visual heartbeat on cadence through the existing reply topic', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const inputs: RayneoRealtimeVisualHeartbeatInput[] = [];
  const issuedBytes: Uint8Array[] = [];
  const controller = await RayneoRealtimeAudioController.create(Object.freeze({
    ...CONFIG,
    visualHeartbeatSeconds: 4,
  }), {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    videoBridgeFactory: async () => ({
      readSamples: (start, end) => {
        const bytes = Uint8Array.of(137, 80, 78, 71, issuedBytes.length + 1);
        issuedBytes.push(bytes);
        return Object.freeze([
          Object.freeze({ observedAtMs: Math.round((start + end) / 2), mimeType: 'image/png' as const, width: 1, height: 1, bytes }),
        ]);
      },
      stop: async () => undefined,
    }),
    audioStreamFactory: () => (async function* () {
      yield audioFrame();
      yield audioFrame();
      yield audioFrame();
    })(),
    diarizer: { diarize: async () => ({ status: 'degraded' }) },
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: '' });
      throw new Error('UNEXPECTED_FETCH');
    },
    generateVisualHeartbeatReply: async (input) => { inputs.push(input); return CHINESE_REPLY; },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 2, 400);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((input) => [input.startMs, input.endMs]), [[0, 2_000], [4_000, 6_000]]);
  const payloads = room.data.map(([text, options]) => ({
    body: JSON.parse(text) as Record<string, unknown>, options,
  }));
  assert.deepEqual(payloads.map(({ body }) => body.sequence), [1, 2]);
  assert.deepEqual(payloads.map(({ body }) => body.transcript), ['', '']);
  assert.deepEqual(payloads.map(({ body }) => body.speaker_label), ['speaker_unknown', 'speaker_unknown']);
  assert.equal(payloads.every(({ body }) => body.type === 'paios.rayneo.realtime.reply.v1'), true);
  assert.equal(payloads.every(({ options }) => options.topic === 'paios.rayneo.realtime.reply.v1'), true);
  assert.equal(diagnostics.filter((stage) => stage === 'VISUAL_HEARTBEAT_SENT').length, 2);
  assert.equal(diagnostics.filter((stage) => stage === 'REPLY_SENT').length, 2);
  assert.equal(issuedBytes.every((bytes) => bytes.every((value) => value === 0)), true);
  await controller.cleanup();
});

test('delayed media origin selects current camera samples without mixing later wall-clock drift', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const inputs: RayneoRealtimeVisualHeartbeatInput[] = [];
  const reads: Array<readonly [number, number, number | undefined]> = [];
  const stale = Uint8Array.of(137, 80, 78, 71, 1);
  const firstCurrent = Uint8Array.of(137, 80, 78, 71, 2);
  const secondCurrent = Uint8Array.of(137, 80, 78, 71, 3);
  const future = Uint8Array.of(137, 80, 78, 71, 4);
  let currentNow = NOW;
  let readCount = 0;
  const controller = await RayneoRealtimeAudioController.create(Object.freeze({
    ...CONFIG,
    visualHeartbeatSeconds: 4,
  }), {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => currentNow,
    observeFixedStage: (stage) => diagnostics.push(stage),
    videoBridgeFactory: async () => ({
      readSamples: (start, end, max) => {
        reads.push([start, end, max]);
        readCount += 1;
        return readCount === 1
          ? Object.freeze([
            Object.freeze({ observedAtMs: NOW + 20_000, mimeType: 'image/png' as const, width: 1, height: 1, bytes: stale }),
            Object.freeze({ observedAtMs: NOW + 30_000, mimeType: 'image/png' as const, width: 1, height: 1, bytes: firstCurrent }),
          ])
          : Object.freeze([
            Object.freeze({ observedAtMs: NOW + 34_000, mimeType: 'image/png' as const, width: 1, height: 1, bytes: secondCurrent }),
            Object.freeze({ observedAtMs: NOW + 40_000, mimeType: 'image/png' as const, width: 1, height: 1, bytes: future }),
          ]);
      },
      stop: async () => undefined,
    }),
    audioStreamFactory: () => (async function* () {
      yield audioFrame();
      currentNow = NOW + 120_000;
      yield audioFrame();
      yield audioFrame();
    })(),
    diarizer: { diarize: async () => ({ status: 'degraded' }) },
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: '' });
      throw new Error('UNEXPECTED_FETCH');
    },
    generateVisualHeartbeatReply: async (input) => { inputs.push(input); return CHINESE_REPLY; },
  });
  currentNow = NOW + 29_000;
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 2, 400);
  assert.deepEqual(reads, [
    [NOW + 29_000, NOW + 31_000, 2],
    [NOW + 33_000, NOW + 35_000, 2],
  ]);
  assert.deepEqual(inputs.map((input) => [
    input.startMs,
    input.endMs,
    input.videoSamples.map((sample) => sample.observedAtMs),
  ]), [
    [29_000, 31_000, [NOW + 30_000]],
    [33_000, 35_000, [NOW + 34_000]],
  ]);
  assert.equal(diagnostics.filter((stage) => stage === 'VIDEO_CONTEXT_APPLIED').length, 2);
  assert.equal(diagnostics.filter((stage) => stage === 'VISUAL_HEARTBEAT_SENT').length, 2);
  assert.equal([stale, firstCurrent, secondCurrent, future].every(
    (bytes) => bytes.every((value) => value === 0),
  ), true);
  await controller.cleanup();
});

test('debug text stream accepts one exact PCM envelope and reuses the normal STT/final/reply pipeline', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const observations: RayneoRealtimeAudioObservation[] = [];
  const calls: string[] = [];
  let committedBytes: Uint8Array | undefined;
  const issuer = createProductionRayneoLiveKitOwnerAliasIssuer({ randomBytes: (size) => Buffer.alloc(size, 4) });
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    ownerAliasIssuer: issuer,
    observe: (item) => observations.push(item),
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () {
      yield audioFrame(1, 0);
      await new Promise<void>(() => undefined);
    })(),
    finalTranscriptAuthority: {
      finalize: async () => { throw new Error('UNEXPECTED_FINALIZE'); },
      finalizeWithEvidence: async (input) => {
        calls.push('finalize');
        committedBytes = input.media.bytes;
        return {} as never;
      },
    },
    afterFinalTranscript: async () => { calls.push('afterFinal'); },
    generateReply: async (transcript) => {
      calls.push(`reply:${transcript}`);
      return CHINESE_REPLY;
    },
    diarizer: { diarize: async () => ({ status: 'degraded' }) },
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) {
        calls.push('stt');
        return response({ text: '请记住这句话。' });
      }
      throw new Error('UNEXPECTED_OLLAMA');
    },
  });
  assert.equal(room.textStreamHandlers.size, 1);
  const { track, publication } = microphone();
  const who = participant();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, who as never);
  await room.emitSyntheticPcm(syntheticPcmEnvelope());
  await waitUntil(() => room.data.length === 1, 300);
  assert.deepEqual(calls, ['stt', 'finalize', 'afterFinal', 'reply:请记住这句话。']);
  assert.equal(committedBytes?.every((value) => value === 0), true);
  assert.equal(diagnostics.filter((stage) => stage === 'TEXT_STREAM_ACCEPTED').length, 1);
  assert.equal(diagnostics.filter((stage) => stage === 'AUDIO_SIGNAL_OBSERVED').length, 1);
  assert.equal(diagnostics.filter((stage) => stage === 'WINDOW_READY').length, 1);
  assert.equal(diagnostics.filter((stage) => stage === 'STT_REQUESTED').length, 1);
  assert.equal(diagnostics.filter((stage) => stage === 'STT_ACCEPTED').length, 1);
  assert.equal(diagnostics.filter((stage) => stage === 'FINAL_TRANSCRIPT_COMMITTED').length, 1);
  assert.equal(diagnostics.filter((stage) => stage === 'REPLY_SENT').length, 1);
  assert.equal(observations.filter((item) => item.stage === 'FINAL_TRANSCRIPT_COMMITTED').length, 1);
  await controller.cleanup();
  assert.equal(room.textStreamHandlers.size, 0);
  issuer.clear();
});

test('debug text stream rejects binding, shape, encoding, hash, read, duplicate, and closed failures', async () => {
  const room = new FakeRoom();
  const errors: string[] = [];
  const issuer = createProductionRayneoLiveKitOwnerAliasIssuer({ randomBytes: (size) => Buffer.alloc(size, 5) });
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    ownerAliasIssuer: issuer,
    observe: (item) => { if (item.errorCode) errors.push(item.errorCode); },
  });
  const handler = room.textStreamHandlers.get('paios.rayneo.synthetic.remember.pcm.v1');
  assert.ok(handler);
  await room.emitSyntheticPcm(syntheticPcmEnvelope({ extra: true }));
  await room.emitSyntheticPcm(syntheticPcmEnvelope({ session_id: 'phase0_session_ffffffffffffffffffff' }));
  await room.emitSyntheticPcm(syntheticPcmEnvelope({ encoding: 'pcm' }));
  await room.emitSyntheticPcm(syntheticPcmEnvelope({ raw_sha256: '0000000000000000000000000000000000000000000000000000000000000000' }));
  await room.emitSyntheticPcm(syntheticPcmEnvelope(), 'rayneo_device_ffffffffffffffffffff');
  handler({ readAll: async () => { throw new Error('READ_FAILURE'); } }, { identity: DEVICE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.includes('RAYNEO_SYNTHETIC_PCM_PAYLOAD_INVALID'), true);
  assert.equal(errors.includes('RAYNEO_SYNTHETIC_PCM_BINDING_INVALID'), true);
  assert.equal(errors.includes('RAYNEO_SYNTHETIC_PCM_SENDER_INVALID'), true);
  assert.equal(errors.includes('RAYNEO_SYNTHETIC_PCM_STREAM_READ_FAILED'), true);

  // The first valid stream claims the one-shot even if no mic track is ready;
  // a second valid stream is a replay and cannot replace it.
  await room.emitSyntheticPcm(syntheticPcmEnvelope());
  await room.emitSyntheticPcm(syntheticPcmEnvelope());
  assert.equal(errors.includes('RAYNEO_SYNTHETIC_PCM_DUPLICATE'), true);
  await controller.cleanup();
  assert.equal(room.textStreamHandlers.size, 0);
  issuer.clear();
});

test('one rolling window executes STT, matched speaker, Ollama, and one reliable directed reply', async () => {
  const room = new FakeRoom();
  const observations: RayneoRealtimeAudioObservation[] = [];
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const calls: string[] = [];
  let committed: RayneoFinalTranscriptAuthorityInput | undefined;
  let committedBytes: Uint8Array | undefined;
  const diarizer: RayneoSpeakerDiarizationPort = {
    diarize: async ({ pcm, sampleRate }) => {
      calls.push(`diarize:${sampleRate}:${pcm.length}`);
      return {
        status: 'matched',
        segments: [{ startSeconds: 0, endSeconds: 2, rawSpeakerId: 'cluster-a', confidence: 0.9 }],
      };
    },
  };
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    diarizer,
    finalTranscriptAuthority: {
      finalize: async (input) => {
        calls.push('finalize');
        committed = input;
        committedBytes = input.media.bytes;
        assert.equal(input.media.bytes.some((value) => value !== 0), true);
      },
    },
    observe: (item) => observations.push(item),
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes('/audio/transcriptions')) {
        calls.push('stt');
        assert.equal(url, 'http://127.0.0.1:8001/v1/audio/transcriptions');
        assert.equal(url.includes(':8000/'), false);
        assert.ok(init?.body instanceof FormData);
        return response({ text: 'What price can you offer?' });
      }
      calls.push('ollama');
      assert.equal(url, 'http://127.0.0.1:11571/v1/chat/completions');
      assert.equal(url.includes(':11434'), false);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: 'qwen3:8b',
        reasoning_effort: 'none',
        temperature: 0,
        max_tokens: 48,
        messages: [
          {
            role: 'system',
            content: '只用简体中文回复眼镜用户，最多两句短句；具体、简洁；只返回回复，不要前缀。',
          },
          { role: 'user', content: '[speaker_0] What price can you offer?' },
        ],
        stream: false,
      });
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1);
  assert.deepEqual(calls, ['diarize:16000:32000', 'stt', 'finalize', 'ollama']);
  assert.ok(committed);
  assert.match(committed.segmentId, /^rayneo_segment_[a-f0-9]{20}$/u);
  assert.deepEqual({ ...committed, media: undefined }, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    segmentId: committed.segmentId,
    startMs: 0,
    endMs: 2000,
    speakerLabel: 'speaker_0',
    diarizationStatus: 'window_local',
    transcript: 'What price can you offer?',
    language: 'und',
    observedAt: new Date(NOW + 2_000).toISOString(),
    media: undefined,
  });
  assert.equal(committed.media.format, 'pcm_s16le');
  assert.equal(committed.media.sampleRate, 16_000);
  assert.equal(committed.media.channels, 1);
  assert.equal(committed.media.bytes.length, 64_000);
  const expectedPcm = Buffer.alloc(64_000);
  for (let offset = 0; offset < expectedPcm.length; offset += 2) expectedPcm.writeInt16LE(10, offset);
  assert.equal(committed.media.sha256, createHash('sha256').update(expectedPcm).digest('hex'));
  expectedPcm.fill(0);
  assert.equal(committedBytes?.every((value) => value === 0), true);
  assert.equal(room.data.length, 1);
  const [text, options] = room.data[0]!;
  assert.deepEqual(options, {
    destinationIdentities: [DEVICE],
    topic: 'paios.rayneo.realtime.reply.v1',
  });
  const message = JSON.parse(text) as Record<string, unknown>;
  assert.match(String(message.segment_id), /^rayneo_segment_[a-f0-9]{20}$/u);
  delete message.segment_id;
  assert.deepEqual(message, {
    type: 'paios.rayneo.realtime.reply.v1',
    session_id: SESSION,
    sequence: 1,
    start_ms: 0,
    end_ms: 2000,
    speaker_label: 'speaker_0',
    diarization_status: 'window_local',
    transcript: 'What price can you offer?',
    reply: CHINESE_REPLY,
    final: true,
  });
  assert.equal(observations.filter((item) => item.stage === 'AUDIO_BATCH').length, 1);
  assert.equal(observations.filter((item) => item.stage === 'REPLY_SENT').length, 1);
  assert.deepEqual(diagnostics, [
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_SUBSCRIBED',
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_REJECTED_DUPLICATE',
    'AUDIO_FRAME_OBSERVED',
    'WINDOW_READY',
    'DIARIZATION_WINDOW_LOCAL',
    'STT_REQUESTED',
    'STT_ACCEPTED',
    'FINAL_TRANSCRIPT_COMMITTED',
    'REPLY_SENT',
  ]);
  await controller.cleanup();
});

test('spoken production reply binds exact text, publishes voice once, and zeroes owned PCM', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const owned = Int16Array.of(11, -11, 22, -22);
  let voiceCalls = 0;
  let voiceSequence = 0;
  let voiceText = '';
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room, now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input) => String(input).includes('/audio/transcriptions')
      ? response({ text: '请回答。' }) : (() => { throw new Error('UNEXPECTED_FETCH'); })(),
    generateReply: async () => Object.freeze({
      text: CHINESE_REPLY, pcm: owned, sampleRate: 16_000 as const, channels: 1 as const,
    }),
    publishReplyVoice: async ({ reply, sequence }) => {
      voiceCalls += 1; voiceSequence = sequence; voiceText = reply.text;
      assert.deepEqual(Array.from(reply.pcm), [11, -11, 22, -22]);
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1);
  assert.equal(voiceCalls, 1);
  assert.equal(voiceSequence, 1);
  assert.equal(voiceText, CHINESE_REPLY);
  assert.equal((JSON.parse(room.data[0]![0]) as { reply: string }).reply, voiceText);
  assert.equal(owned.every((value) => value === 0), true);
  assert.equal(diagnostics.filter((stage) => stage === 'REPLY_SENT').length, 1);
  await controller.cleanup();
});

test('voice publication failure never reports dual-modal REPLY_SENT', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room, now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async () => response({ text: '请回答。' }),
    generateReply: async () => Object.freeze({
      text: CHINESE_REPLY, pcm: Int16Array.of(1, 2), sampleRate: 16_000 as const, channels: 1 as const,
    }),
    publishReplyVoice: async () => { throw new Error('VOICE_FAILED'); },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => diagnostics.some((stage) => stage === 'STT_ACCEPTED'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics.includes('REPLY_SENT'), false);
  await controller.cleanup();
});

test('configured final transcript authority fails closed before model and clears media bytes', async () => {
  const room = new FakeRoom();
  const observations: RayneoRealtimeAudioObservation[] = [];
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  let modelCalls = 0;
  let authorityBytes: Uint8Array | undefined;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observe: (item) => observations.push(item),
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    finalTranscriptAuthority: {
      finalize: async (input) => {
        authorityBytes = input.media.bytes;
        throw new Error('FINAL_TRANSCRIPT_AUTHORITY_UNAVAILABLE');
      },
    },
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: 'remember this' });
      modelCalls += 1;
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    track as never, publication as never, participant() as never,
  );
  await waitUntil(() => observations.some(
    (item) => item.stage === 'TRACK_ERROR' &&
      item.errorCode === 'FINAL_TRANSCRIPT_AUTHORITY_UNAVAILABLE',
  ));
  assert.equal(modelCalls, 0);
  assert.equal(room.data.length, 0);
  assert.equal(diagnostics.includes('FINAL_TRANSCRIPT_COMMITTED'), false);
  assert.equal(diagnostics.includes('REPLY_SENT'), false);
  assert.equal(authorityBytes?.every((value) => value === 0), true);
  await controller.cleanup();
});

test('audio signal marker ignores silence and low noise and fires once for clear signal', async () => {
  for (const [amplitude, expectedSignals] of [[0, 0], [32, 0], [1_000, 1]] as const) {
    const room = new FakeRoom();
    const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
    const controller = await RayneoRealtimeAudioController.create(CONFIG, {
      sessionId: SESSION,
      deviceId: DEVICE,
      clientInstanceId: CLIENT,
      openedAt: NOW,
      expiresAt: NOW + 900_000,
    }, {
      roomFactory: () => room,
      now: () => NOW,
      observeFixedStage: (stage) => diagnostics.push(stage),
      audioStreamFactory: () => (async function* () {
        yield audioFrame(32_000, amplitude);
        yield audioFrame(32_000, amplitude);
      })(),
      fetch: async (input) => String(input).includes('/audio/transcriptions')
        ? response({ text: 'speech' })
        : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] }),
    });
    const { track, publication } = microphone();
    room.handlers.get(RoomEvent.TrackSubscribed)?.(
      track as never, publication as never, participant() as never,
    );
    await waitUntil(() => room.data.length === 2);
    assert.equal(
      diagnostics.filter((stage) => stage === 'AUDIO_SIGNAL_OBSERVED').length,
      expectedSignals,
    );
    await controller.cleanup();
  }
});

test('audio signal marker resets for a replacement track after active stop', async () => {
  const room = new FakeRoom();
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () {
      yield audioFrame(32_000, 1_000);
      yield audioFrame(32_000, 1_000);
    })(),
    fetch: async (input) => String(input).includes('/audio/transcriptions')
      ? response({ text: 'speech' })
      : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] }),
  });
  const who = participant();
  const first = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    first.track as never, first.publication as never, who as never,
  );
  await waitUntil(() => room.data.length === 2);
  room.handlers.get(RoomEvent.ParticipantDisconnected)?.(who as never);
  const second = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    second.track as never, second.publication as never, who as never,
  );
  await waitUntil(() => room.data.length === 4);
  assert.equal(diagnostics.filter((stage) => stage === 'AUDIO_SIGNAL_OBSERVED').length, 2);
  await controller.cleanup();
});

test('realtime snapshots the shared session context and appends only after the final reply send', async () => {
  const room = new FakeRoom();
  const context = new RayneoSessionTurnContext();
  assert.equal(context.appendVisual('frame-before-audio', '图片上下文回复。'), true);
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  let ollamaBody: Record<string, unknown> | undefined;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
    turnContext: context,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input, init) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: '同一会话的语音转写。' });
      ollamaBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1);
  const messages = ollamaBody?.messages as Array<Record<string, unknown>> | undefined;
  assert.ok(messages);
  assert.match(String(messages[1]?.content), /图片上下文回复。/u);
  assert.match(context.snapshot(), /同一会话的语音转写。/u);
  assert.match(context.snapshot(), new RegExp(CHINESE_REPLY, 'u'));
  assert.deepEqual(diagnostics, [
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_SUBSCRIBED',
    'AUDIO_FRAME_OBSERVED',
    'WINDOW_READY',
    'DIARIZATION_DEGRADED',
    'STT_REQUESTED',
    'STT_ACCEPTED',
    'JOINT_CONTEXT_APPLIED',
    'REPLY_SENT',
  ]);
  await controller.cleanup();
  assert.equal(context.closed, true);
});

test('missing diarization degrades to speaker_unknown without blocking transcript/reply', async () => {
  const room = new FakeRoom();
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input) => String(input).includes('/audio/transcriptions')
      ? response({ text: 'hello' })
      : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] }),
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1);
  const reply = JSON.parse(room.data[0]![0]) as Record<string, unknown>;
  assert.equal(reply.speaker_label, 'speaker_unknown');
  assert.equal(reply.diarization_status, 'degraded');
  await controller.cleanup();
});

test('replacement cleanup closes local media state even when LiveKit disconnect never settles', async () => {
  class HangingDisconnectRoom extends FakeRoom {
    override async disconnect(): Promise<void> {
      this.disconnectCount += 1;
      return new Promise<void>(() => undefined);
    }
  }
  const room = new HangingDisconnectRoom();
  const context = new RayneoSessionTurnContext();
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
    turnContext: context,
  }, {
    roomFactory: () => room,
    now: () => NOW,
  });
  const startedAt = Date.now();
  assert.equal(await controller.cleanupForReplacement(), true);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(context.closed, true);
  assert.equal(room.disconnectCount, 1);
});

test('Stop aborts an in-flight window, publishes nothing, and cleanup is idempotent', async () => {
  const room = new FakeRoom();
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input) => String(input).includes('/audio/transcriptions')
      ? pending
      : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] }),
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await controller.cleanup(), true);
  assert.equal(await controller.cleanup(), true);
  release(response({ text: 'too late' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(room.data.length, 0);
  assert.equal(room.disconnectCount, 1);
});

test('new microphone after disconnect is a new attempt but replay of same track never duplicates', async () => {
  const room = new FakeRoom();
  let modelCalls = 0;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    openedAt: NOW,
    expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: 'next' });
      modelCalls += 1;
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const first = microphone();
  const who = participant();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(first.track as never, first.publication as never, who as never);
  room.handlers.get(RoomEvent.TrackSubscribed)?.(first.track as never, first.publication as never, who as never);
  await waitUntil(() => room.data.length === 1);
  room.handlers.get(RoomEvent.ParticipantDisconnected)?.(who as never);
  const second = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(second.track as never, second.publication as never, who as never);
  await waitUntil(() => room.data.length === 2);
  assert.equal(modelCalls, 2);
  const replies = room.data.map(([text]) => JSON.parse(text) as Record<string, unknown>);
  assert.deepEqual(replies.map((reply) => reply.sequence), [1, 2]);
  assert.deepEqual(replies.map((reply) => [reply.start_ms, reply.end_ms]), [[0, 2000], [2000, 4000]]);
  await controller.cleanup();
});

test('alternating diarization segments are cut into independent speaker turns', async () => {
  const room = new FakeRoom();
  let sttCalls = 0;
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    diarizer: {
      diarize: async () => ({
        status: 'matched',
        segments: [
          { startSeconds: 0, endSeconds: 1, rawSpeakerId: 'alice', confidence: 0.92 },
          { startSeconds: 1, endSeconds: 2, rawSpeakerId: 'bob', confidence: 0.88 },
        ],
      }),
    },
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) {
        sttCalls += 1;
        return response({ text: sttCalls === 1 ? 'turn one' : 'turn two' });
      }
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 2);
  const turns = room.data.map(([text]) => JSON.parse(text) as Record<string, unknown>);
  assert.deepEqual(turns.map((turn) => [turn.speaker_label, turn.start_ms, turn.end_ms]), [
    ['speaker_0', 0, 1000],
    ['speaker_1', 1000, 2000],
  ]);
  assert.equal(new Set(turns.map((turn) => turn.segment_id)).size, 2);
  for (const turn of turns) assert.match(String(turn.segment_id), /^rayneo_segment_[a-f0-9]{20}$/u);
  assert.equal(sttCalls, 2);
  await controller.cleanup();
});

test('overlapping speakers are emitted as independent ambiguous turns with speaker_unknown', async () => {
  const room = new FakeRoom();
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    diarizer: {
      diarize: async () => ({
        status: 'matched',
        segments: [
          { startSeconds: 0, endSeconds: 1.2, rawSpeakerId: 'alice', confidence: 0.9 },
          { startSeconds: 0.8, endSeconds: 2, rawSpeakerId: 'bob', confidence: 0.9 },
        ],
      }),
    },
    audioStreamFactory: () => (async function* () { yield audioFrame(); })(),
    fetch: async (input) => String(input).includes('/audio/transcriptions')
      ? response({ text: 'overlap' })
      : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] }),
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 2);
  const turns = room.data.map(([text]) => JSON.parse(text) as Record<string, unknown>);
  assert.deepEqual(turns.map((turn) => turn.speaker_label), ['speaker_unknown', 'speaker_unknown']);
  assert.deepEqual(turns.map((turn) => turn.diarization_status), ['degraded', 'degraded']);
  await controller.cleanup();
});

test('a natural no-speech window emits nothing and the following speech window still completes', async () => {
  const room = new FakeRoom();
  let sttCalls = 0;
  let modelCalls = 0;
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const controller = await RayneoRealtimeAudioController.create(CONFIG, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(64_000); })(),
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) {
        sttCalls += 1;
        return response({ text: sttCalls === 1 ? '   ' : 'speech after silence' });
      }
      modelCalls += 1;
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await waitUntil(() => room.data.length === 1);
  assert.equal(sttCalls, 2);
  assert.equal(modelCalls, 1);
  assert.equal((JSON.parse(room.data[0]![0]) as Record<string, unknown>).transcript, 'speech after silence');
  assert.deepEqual(diagnostics, [
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_SUBSCRIBED',
    'AUDIO_FRAME_OBSERVED',
    'WINDOW_READY',
    'DIARIZATION_DEGRADED',
    'STT_REQUESTED',
    'STT_EMPTY',
    'WINDOW_READY',
    'DIARIZATION_DEGRADED',
    'STT_REQUESTED',
    'STT_ACCEPTED',
    'REPLY_SENT',
  ]);
  await controller.cleanup();
});

test('diarization and Ollama deadlines do not wedge the serial consumer; next window recovers', async () => {
  const room = new FakeRoom();
  let diarizationCalls = 0;
  let modelCalls = 0;
  const neverDiarization = new Promise<never>(() => undefined);
  const neverModel = new Promise<Response>(() => undefined);
  const controller = await RayneoRealtimeAudioController.create({
    ...CONFIG,
    diarizationDeadlineMs: 100,
    ollamaDeadlineMs: 100,
  }, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    diarizer: {
      diarize: async () => {
        diarizationCalls += 1;
        return diarizationCalls === 1
          ? neverDiarization
          : { status: 'degraded' };
      },
    },
    audioStreamFactory: () => (async function* () { yield audioFrame(64_000); })(),
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) return response({ text: 'speech' });
      modelCalls += 1;
      return modelCalls === 1
        ? neverModel
        : response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(track as never, publication as never, participant() as never);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(room.data.length, 1);
  assert.equal(diarizationCalls, 2);
  assert.equal(modelCalls, 2);
  assert.equal((JSON.parse(room.data[0]![0]) as Record<string, unknown>).reply, CHINESE_REPLY);
  await controller.cleanup();
});

test('STT deadline skips only the timed-out turn and the next window still completes', async () => {
  const room = new FakeRoom();
  let sttCalls = 0;
  let modelCalls = 0;
  const diagnostics: RayneoRealtimeAudioDiagnosticStage[] = [];
  const neverStt = new Promise<Response>(() => undefined);
  const controller = await RayneoRealtimeAudioController.create({
    ...CONFIG,
    sttDeadlineMs: 1_000,
  }, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => room,
    now: () => NOW,
    observeFixedStage: (stage) => diagnostics.push(stage),
    audioStreamFactory: () => (async function* () { yield audioFrame(64_000); })(),
    fetch: async (input) => {
      if (String(input).includes('/audio/transcriptions')) {
        sttCalls += 1;
        return sttCalls === 1 ? neverStt : response({ text: 'speech after STT timeout' });
      }
      modelCalls += 1;
      return response({ choices: [{ message: { role: 'assistant', content: CHINESE_REPLY } }] });
    },
  });
  const { track, publication } = microphone();
  room.handlers.get(RoomEvent.TrackSubscribed)?.(
    track as never, publication as never, participant() as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(sttCalls, 2);
  assert.equal(modelCalls, 1);
  assert.equal(room.data.length, 1);
  const reply = JSON.parse(room.data[0]![0]) as Record<string, unknown>;
  assert.equal(reply.transcript, 'speech after STT timeout');
  assert.deepEqual([reply.start_ms, reply.end_ms], [2000, 4000]);
  assert.deepEqual(diagnostics, [
    'REMOTE_MIC_TRACK_CALLBACK',
    'REMOTE_MIC_TRACK_SUBSCRIBED',
    'AUDIO_FRAME_OBSERVED',
    'WINDOW_READY',
    'DIARIZATION_DEGRADED',
    'STT_REQUESTED',
    'STT_FAILED',
    'WINDOW_READY',
    'DIARIZATION_DEGRADED',
    'STT_REQUESTED',
    'STT_ACCEPTED',
    'REPLY_SENT',
  ]);
  await controller.cleanup();
});

test('Gate A realtime admits an eight-second audio window and rejects larger windows', async () => {
  const accepted = await RayneoRealtimeAudioController.create({
    ...CONFIG,
    windowSeconds: 8,
  }, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => new FakeRoom(),
    now: () => NOW,
  });
  await accepted.cleanup();
  await assert.rejects(RayneoRealtimeAudioController.create({
    ...CONFIG,
    windowSeconds: 9,
  }, {
    sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
    openedAt: NOW, expiresAt: NOW + 900_000,
  }, {
    roomFactory: () => new FakeRoom(),
    now: () => NOW,
  }), /RAYNEO_REALTIME_CONFIG_INVALID/);
  for (const visualHeartbeatSeconds of [3, 61, 5.5]) {
    await assert.rejects(RayneoRealtimeAudioController.create({
      ...CONFIG,
      visualHeartbeatSeconds,
    }, {
      sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
      openedAt: NOW, expiresAt: NOW + 900_000,
    }, {
      roomFactory: () => new FakeRoom(),
      now: () => NOW,
    }), /RAYNEO_REALTIME_CONFIG_INVALID/);
  }
});

test('Gate A realtime accepts only an exact high-port IPv4 loopback Ollama base URL', async () => {
  for (const ollamaEndpointUrl of [
    'http://localhost:11571',
    'http://127.0.0.1:11571/api/chat',
    'http://127.0.0.1:11571?x=1',
    'https://127.0.0.1:11571',
    'http://127.0.0.1:1023',
  ]) {
    await assert.rejects(RayneoRealtimeAudioController.create({
      ...CONFIG,
      ollamaEndpointUrl,
    }, {
      sessionId: SESSION, deviceId: DEVICE, clientInstanceId: CLIENT,
      openedAt: NOW, expiresAt: NOW + 900_000,
    }, {
      roomFactory: () => new FakeRoom(),
      now: () => NOW,
    }), /RAYNEO_REALTIME_CONFIG_INVALID/);
  }
});
