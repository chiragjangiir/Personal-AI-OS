import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { DataPacketKind, RoomEvent, TrackKind, TrackSource } from '@livekit/rtc-node';

import {
  createRealtimePublicControlAssistantBridge,
  REALTIME_ASSISTANT_PROMPT_TOPIC,
  REALTIME_ASSISTANT_RESULT_TOPIC,
  type RealtimePublicControlAssistantAudioFactory,
  type RealtimePublicControlAssistantSession,
  type RealtimePublicControlAssistantBridgeOptions,
} from '../src/realtime-public-control-assistant-bridge.ts';
import type {
  Qwen38ChatRequest,
  Qwen38ChatMessage,
  Qwen38StreamEvent,
} from '../src/qwen38-provider-adapter.ts';
import type {
  LiveKitCloudParticipantPort,
  LiveKitCloudRoomPort,
} from '../src/livekit-cloud-participant.ts';
import { RayneoRealtimeAudioController, type RayneoRealtimeAudioConfig } from '../src/rayneo-realtime-audio-controller.ts';

type Listener = (...args: readonly unknown[]) => void;

const binding = (epoch = '1', identity = 'iphone-identity') => ({
  realtimeSessionRef: { ref_type: 'RealtimeSession', ref_id: `session-${epoch}` },
  deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: `lease-${epoch}` },
  continuityId: 'continuity-1',
  connectionEpoch: epoch,
  credentialRoom: 'same-room',
  credentialIdentity: identity,
});

const AUDIO_CONFIG: RayneoRealtimeAudioConfig = Object.freeze({
  livekitUrl: 'wss://ai.example.test',
  clientLivekitUrl: 'wss://ai.example.test',
  apiKey: '0123456789abcdef',
  apiSecret: '0123456789abcdef0123456789abcdef',
  sttEndpointUrl: 'http://127.0.0.1:8001/v1/audio/transcriptions',
  sttModel: 'faster-whisper-large-v3-turbo-ct2',
  sttDeadlineMs: 8_000,
  ollamaModel: 'qwen3:8b',
  ollamaEndpointUrl: 'http://127.0.0.1:16001',
  windowSeconds: 2,
});

function bootstrap(
  epoch = '1',
  identity = 'iphone-identity',
  enabledMedia = { audio: false, video: false, data: true },
) {
  return {
    request: {}, bearer: {}, governance: {}, authority: {},
    currentBinding: binding(epoch, identity),
    enabledMedia,
  } as never;
}

async function* events(events: readonly Qwen38StreamEvent[]): AsyncGenerator<Qwen38StreamEvent> {
  for (const event of events) yield event;
}

function response(body: unknown): Response {
  return { status: 200, redirected: false, json: async () => body } as Response;
}

function harness(
  streams: readonly AsyncIterable<Qwen38StreamEvent>[],
  audioCreateOverride?: RealtimePublicControlAssistantAudioFactory['create'],
  recordUserActionOverride?: RealtimePublicControlAssistantBridgeOptions['recordUserAction'],
) {
  const listeners = new Map<string, Set<Listener>>();
  const published: Array<{ readonly value: Record<string, unknown>; readonly options: Record<string, unknown> }> = [];
  const calls: Qwen38ChatRequest[] = [];
  const completeCalls: Qwen38ChatRequest[] = [];
  let audioAttachCount = 0;
  let sessionCreateCount = 0;
  let sessionCleanupCount = 0;
  let audioCleanupCount = 0;
  let audioProvider: unknown;
  let providerCloseCount = 0;
  let connected = true;
  let disconnectCount = 0;
  const emit = (event: string, ...args: readonly unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  const room: LiveKitCloudRoomPort = {
    get isConnected() { return connected; },
    async connect() { connected = true; },
    async disconnect() { disconnectCount += 1; connected = false; emit(RoomEvent.Disconnected); },
    localParticipant: {
      async publishData(data, options) {
        published.push({
          value: JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>,
          options: options as Record<string, unknown>,
        });
      },
    },
    on(event, listener) {
      let bucket = listeners.get(event);
      if (bucket === undefined) { bucket = new Set(); listeners.set(event, bucket); }
      bucket.add(listener);
    },
    off(event, listener) { listeners.get(event)?.delete(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  let streamIndex = 0;
  const provider = {
    stream(input: Qwen38ChatRequest, _signal?: AbortSignal): AsyncIterable<Qwen38StreamEvent> {
      calls.push(input);
      const stream = streams[streamIndex++];
      if (stream === undefined) throw new Error('STREAM_FIXTURE_EXHAUSTED');
      return stream;
    },
    async complete(input: Qwen38ChatRequest, _signal?: AbortSignal): Promise<Readonly<{ readonly text: string }>> {
      completeCalls.push(input);
      return Object.freeze({ text: `音频回复${completeCalls.length}。` });
    },
    close: async () => { providerCloseCount += 1; },
  };
  const participant = { roomPort: room } as LiveKitCloudParticipantPort;
  const createSession: RealtimePublicControlAssistantAudioFactory['create'] = audioCreateOverride ?? (async (input, _room, provider): Promise<RealtimePublicControlAssistantSession> => {
    sessionCreateCount += 1;
    const history: Qwen38ChatMessage[] = [];
    const audioEnabled = input.enabledMedia.audio === true;
    if (audioEnabled) { audioAttachCount += 1; audioProvider = provider; }
    const audioSession = audioEnabled ? Object.freeze({
      livekit_url: '', livekit_token: '', livekit_token_expires_at: '',
      livekit_video_publish_enabled: true as const,
      cleanup: async () => { audioCleanupCount += 1; return true; },
    }) : undefined;
    return Object.freeze({
      streamTypedReply: async function* (
        typedInput: Readonly<{ readonly promptId: string; readonly text: string }>,
        signal: AbortSignal,
      ) {
        const messages = Object.freeze([
          ...history,
          Object.freeze({ role: 'user' as const, content: typedInput.text }),
        ]);
        let assistantText = '';
        let final = false;
        for await (const event of provider.stream({ messages, maxTokens: 512 }, signal)) {
          if (event.kind === 'delta' || event.kind === 'final') assistantText = event.text;
          if (event.kind === 'final') {
            final = true;
            history.push(Object.freeze({ role: 'user' as const, content: typedInput.text }), Object.freeze({ role: 'assistant' as const, content: assistantText }));
            while (history.length > 4) history.shift();
          }
          yield event;
        }
      },
      ...(audioSession === undefined ? {} : { audioSession }),
      cleanup: async () => { sessionCleanupCount += 1; await audioSession?.cleanup(); },
    });
  });
  const bridge = createRealtimePublicControlAssistantBridge({
    participant,
    provider,
    audio: {
      create: createSession,
    },
    ...(recordUserActionOverride === undefined ? {} : { recordUserAction: recordUserActionOverride }),
  });
  const prompt = (promptId: string, text: string): void => {
    emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(JSON.stringify({ prompt_id: promptId, text })),
      { identity: 'iphone-identity' },
      DataPacketKind.KIND_RELIABLE,
      REALTIME_ASSISTANT_PROMPT_TOPIC,
    );
  };
  return {
    bridge, room, emit, prompt, published, calls, completeCalls, provider,
    get sessionCreateCount() { return sessionCreateCount; },
    get sessionCleanupCount() { return sessionCleanupCount; },
    get audioProvider() { return audioProvider; },
    get audioAttachCount() { return audioAttachCount; },
    get audioCleanupCount() { return audioCleanupCount; },
    get providerCloseCount() { return providerCloseCount; },
    get disconnectCount() { return disconnectCount; },
  };
}

async function settle(): Promise<void> {
  await setImmediate();
  await setImmediate();
  await setImmediate();
}

test('authorized prompt uses one Qwen stream and directed cumulative result packets', async () => {
  const h = harness([events([
    { kind: 'delta', text: '12' },
    { kind: 'final', text: '126', finishReason: 'stop' },
  ])]);
  await h.bridge.onBootstrapConnected(bootstrap());
  h.prompt('11111111-1111-4111-8111-111111111111', '18乘以7是多少？请只回答数字。');
  await settle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]?.messages, [{ role: 'user', content: '18乘以7是多少？请只回答数字。' }]);
  assert.deepEqual(h.published.map((entry) => entry.value), [
    { stream_id: '11111111-1111-4111-8111-111111111111', sequence: 1, text: '12', is_final: false },
    { stream_id: '11111111-1111-4111-8111-111111111111', sequence: 2, text: '126', is_final: true },
  ]);
  for (const entry of h.published) {
    assert.deepEqual(entry.options, {
      reliable: true,
      destination_identities: ['iphone-identity'],
      topic: REALTIME_ASSISTANT_RESULT_TOPIC,
    });
  }
});

test('typed durable lifecycle commits only after final publish and marks partial streams indeterminate', async () => {
  async function* partial(): AsyncGenerator<Qwen38StreamEvent> {
    yield { kind: 'delta', text: 'partial' };
    throw new Error('MODEL_PARTIAL');
  }
  const lifecycle: string[] = [];
  const h = harness([
    events([{ kind: 'final', text: 'complete', finishReason: 'stop' }]),
    partial(),
  ], async (_input, _room, provider): Promise<RealtimePublicControlAssistantSession> => Object.freeze({
    streamTypedReply: (
      typedInput: Readonly<{ readonly promptId: string; readonly text: string }>,
      signal: AbortSignal,
    ) => provider.stream({
      messages: [{ role: 'user', content: typedInput.text }], maxTokens: 512,
    }, signal),
    completeConversationTurn: async (inputId: string) => { lifecycle.push(`complete:${inputId}`); },
    markIndeterminateConversationTurn: async (inputId: string) => { lifecycle.push(`indeterminate:${inputId}`); },
    releaseConversationTurn: async (inputId: string) => { lifecycle.push(`release:${inputId}`); },
    cleanup: async () => undefined,
  }));
  await h.bridge.onBootstrapConnected(bootstrap());
  h.prompt('abababab-abab-4aba-8aba-abababababab', 'first');
  await settle();
  h.prompt('cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd', 'second');
  await settle();
  assert.deepEqual(lifecycle, [
    'complete:abababab-abab-4aba-8aba-abababababab',
    'indeterminate:cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
  ]);
  assert.equal(h.calls.length, 2);
  await h.bridge.close();
});

test('second prompt reuses only the bounded completed user and assistant context', async () => {
  const h = harness([
    events([{ kind: 'final', text: '126', finishReason: 'stop' }]),
    events([{ kind: 'final', text: '135', finishReason: 'stop' }]),
  ]);
  await h.bridge.onBootstrapConnected(bootstrap());
  h.prompt('22222222-2222-4222-8222-222222222222', '18乘以7是多少？请只回答数字。');
  await settle();
  h.prompt('33333333-3333-4333-8333-333333333333', '把你上一条结果加9，只回答数字。');
  await settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1]?.messages, [
    { role: 'user', content: '18乘以7是多少？请只回答数字。' },
    { role: 'assistant', content: '126' },
    { role: 'user', content: '把你上一条结果加9，只回答数字。' },
  ]);
  assert.equal(h.published.at(-1)?.value.text, '135');
});

test('Public media capabilities attach independently: audio-only has no prompt listener and none detaches', async () => {
  const h = harness([]);
  await h.bridge.onBootstrapConnected(bootstrap('1', 'iphone-identity', { audio: false, video: false, data: true }));
  assert.equal(h.audioAttachCount, 0);
  await h.bridge.onBootstrapConnected(bootstrap('1', 'iphone-identity', { audio: true, video: false, data: false }));
  assert.equal(h.audioAttachCount, 1);
  assert.equal(h.audioProvider, h.provider);
  h.prompt('99999999-9999-4999-8999-999999999999', 'data must be ignored');
  await settle();
  assert.equal(h.calls.length, 0);
  await h.bridge.onBootstrapConnected(bootstrap('1', 'iphone-identity', { audio: false, video: false, data: false }));
  assert.equal(h.audioCleanupCount, 1);
  await h.bridge.close();
});

test('Public video-only capability creates the shared session without a prompt listener or audio session', async () => {
  const h = harness([]);
  await h.bridge.onBootstrapConnected(bootstrap('1', 'iphone-identity', { audio: false, video: true, data: false }));
  assert.equal(h.sessionCreateCount, 1);
  assert.equal(h.audioAttachCount, 0);
  h.prompt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'video-only must not invoke typed data');
  await settle();
  assert.equal(h.calls.length, 0);
  await h.bridge.onBootstrapConnected(bootstrap('1', 'iphone-identity', { audio: false, video: false, data: false }));
  assert.equal(h.sessionCleanupCount, 1);
  await h.bridge.close();
  assert.equal(h.providerCloseCount, 1);
});

test('same-room production factory shares provider with typed text and two distinct audio finals', async () => {
  const finals = ['普通第一段。', '普通第二段。'];
  let sttIndex = 0;
  const lifecycle: string[] = [];
  const memoryWrites: string[] = [];
  const h = harness([events([{ kind: 'final', text: 'typed reply', finishReason: 'stop' }])], async (input, room, provider): Promise<RealtimePublicControlAssistantSession> => {
    assert.equal(input.currentBinding.credentialRoom, 'paios-r-test');
    assert.equal((input.currentBinding.realtimeSessionRef as Record<string, unknown>).ref_id,
      '01a00000-0000-7000-8000-000000000001');
    assert.equal(room, h.room);
    assert.equal(provider, h.provider);
    const identity = input.currentBinding.credentialIdentity as string;
    const controller = await RayneoRealtimeAudioController.attachExistingRoom(AUDIO_CONFIG, {
      sessionId: 'paios-r-test',
      deviceId: input.bearer.deviceId,
      clientInstanceId: identity,
      openedAt: Date.now(),
      expiresAt: Date.now() + 900_000,
    }, room, {
      roomProfile: Object.freeze({ kind: 'public-assistant', participantIdentity: identity }),
      audioStreamFactory: () => (async function* () {
        yield { data: new Int16Array(32_000).fill(1_000), sampleRate: 16_000, channels: 1, samplesPerChannel: 32_000 };
      })(),
      fetch: async (url) => {
        assert.match(String(url), /audio\/transcriptions/u);
        lifecycle.push('stt');
        return response({ text: finals[sttIndex++] });
      },
      finalTranscriptAuthority: {
        finalize: async () => undefined,
        finalizeWithEvidence: async () => ({ evidenceRef: `evidence-${sttIndex}` } as never),
      },
      afterFinalTranscript: async ({ input: finalInput }) => {
        lifecycle.push('evidence');
        assert.match(finalInput.transcript, /^普通/u);
      },
      generateSegmentReply: async (_segmentId, transcript, _speakerLabel, signal) => {
        lifecycle.push('qwen');
        if (transcript.startsWith('记住')) memoryWrites.push(transcript);
        const result = await provider.complete!({
          messages: [{ role: 'user', content: transcript }], maxTokens: 48,
        }, signal);
        return result.text;
      },
    });
    return Object.freeze({
      streamTypedReply: (typedInput: Readonly<{ readonly promptId: string; readonly text: string }>, signal: AbortSignal) => provider.stream({
        messages: [{ role: 'user', content: typedInput.text }], maxTokens: 512,
      }, signal),
      audioSession: controller,
      cleanup: async () => { await controller.cleanup(); },
    });
  });
  await h.bridge.onBootstrapConnected({
    request: {}, bearer: { deviceId: '01a00000-0000-7000-8000-000000000002' }, governance: {}, authority: {},
    currentBinding: {
      ...binding('1', 'iphone-identity'),
      realtimeSessionRef: {
        ref_type: 'RealtimeSession', ref_id: '01a00000-0000-7000-8000-000000000001',
        object_version: '1', canonical_payload_sha256: 'a'.repeat(64),
      },
      credentialRoom: 'paios-r-test',
    },
    enabledMedia: { audio: true, video: false, data: true },
  } as never);
  h.prompt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'typed text');
  await settle();
  const participant = { identity: 'iphone-identity', attributes: {} };
  const publication = (track: object) => ({ kind: TrackKind.KIND_AUDIO, source: TrackSource.SOURCE_MICROPHONE, track });
  h.emit(RoomEvent.TrackSubscribed, {}, publication({}), participant);
  for (let index = 0; index < 20 && h.completeCalls.length < 1; index += 1) await settle();
  h.emit(RoomEvent.TrackSubscribed, {}, publication({}), participant);
  for (let index = 0; index < 20 && h.completeCalls.length < 2; index += 1) await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.completeCalls.length, 2);
  assert.equal(memoryWrites.length, 0);
  assert.deepEqual(lifecycle, ['stt', 'evidence', 'qwen', 'stt', 'evidence', 'qwen']);
  assert.equal(h.disconnectCount, 0);
  await h.bridge.close();
  assert.equal(h.providerCloseCount, 1);
});

test('wrong identity, duplicate id, and oversized payload never invoke the provider', async () => {
  const h = harness([events([{ kind: 'final', text: '126', finishReason: 'stop' }])]);
  await h.bridge.onBootstrapConnected(bootstrap());
  const id = '44444444-4444-4444-8444-444444444444';
  h.emit(
    RoomEvent.DataReceived,
    new TextEncoder().encode(JSON.stringify({ prompt_id: id, text: 'wrong sender' })),
    { identity: 'other-identity' }, DataPacketKind.KIND_RELIABLE, REALTIME_ASSISTANT_PROMPT_TOPIC,
  );
  h.prompt(id, '18乘以7是多少？请只回答数字。');
  await settle();
  h.prompt(id, '重复，不应再次调用。');
  h.emit(
    RoomEvent.DataReceived,
    new Uint8Array(12_289),
    { identity: 'iphone-identity' }, DataPacketKind.KIND_RELIABLE, REALTIME_ASSISTANT_PROMPT_TOPIC,
  );
  await settle();
  assert.equal(h.calls.length, 1);
});

test('a second in-flight prompt gets BUSY and an oversized model result gets a final error envelope', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  async function* delayed(): AsyncGenerator<Qwen38StreamEvent> {
    await gate;
    yield { kind: 'final', text: '126', finishReason: 'stop' };
  }
  const busy = harness([delayed()]);
  await busy.bridge.onBootstrapConnected(bootstrap());
  busy.prompt('66666666-6666-4666-8666-666666666666', '第一轮');
  await setImmediate();
  busy.prompt('77777777-7777-4777-8777-777777777777', '并发第二轮');
  await settle();
  assert.deepEqual(busy.published[0]?.value, {
    stream_id: '77777777-7777-4777-8777-777777777777', sequence: 1, text: '', is_final: true, error_code: 'BUSY',
  });
  release();
  await settle();

  const oversized = harness([events([{ kind: 'delta', text: 'x'.repeat(12_280) }])]);
  await oversized.bridge.onBootstrapConnected(bootstrap());
  oversized.prompt('88888888-8888-4888-8888-888888888888', '超长结果');
  await settle();
  assert.deepEqual(oversized.published, [{
    value: {
      stream_id: '88888888-8888-4888-8888-888888888888', sequence: 1, text: '', is_final: true, error_code: 'MODEL_FAILED',
    },
    options: {
      reliable: true,
      destination_identities: ['iphone-identity'],
      topic: REALTIME_ASSISTANT_RESULT_TOPIC,
    },
  }]);
});

test('room disconnect aborts the in-flight generation and drops the late model result', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observedAbort = false;
  async function* delayed(_input: Qwen38ChatRequest, signal?: AbortSignal): AsyncGenerator<Qwen38StreamEvent> {
    await Promise.race([
      gate,
      new Promise<void>((resolve) => signal?.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true })),
    ]);
    if (signal?.aborted) return;
    yield { kind: 'final', text: 'old result', finishReason: 'stop' };
  }
  const delayedHarness = harness([]);
  const bridge = createRealtimePublicControlAssistantBridge({
    participant: { roomPort: delayedHarness.room } as LiveKitCloudParticipantPort,
    provider: { stream: delayed },
    audio: {
      create: async (_input, _room, provider) => Object.freeze({
        streamTypedReply: (typedInput: Readonly<{ readonly promptId: string; readonly text: string }>, signal: AbortSignal) => provider.stream({
          messages: [{ role: 'user', content: typedInput.text }], maxTokens: 512,
        }, signal),
        cleanup: async () => undefined,
      }),
    },
  });
  await bridge.onBootstrapConnected(bootstrap());
  delayedHarness.prompt('55555555-5555-4555-8555-555555555555', '第一轮');
  await setImmediate();
  await delayedHarness.room.disconnect();
  release();
  await settle();
  assert.equal(observedAbort, true);
  assert.equal(delayedHarness.published.length, 0);
  await bridge.close();
});

test('typed activity failure emits one bounded terminal error without invoking the provider or replaying activity', async () => {
  let activityCalls = 0;
  const failed = harness(
    [events([{ kind: 'final', text: 'provider must not run', finishReason: 'stop' }])],
    undefined,
    async () => { activityCalls += 1; throw new Error('T04_ACTION_FAILED'); },
  );
  await failed.bridge.onBootstrapConnected(bootstrap());
  const promptId = '99999999-9999-4999-8999-999999999999';
  failed.prompt(promptId, 'typed action');
  await settle();
  failed.prompt(promptId, 'typed action replay');
  await settle();
  assert.equal(activityCalls, 1);
  assert.equal(failed.calls.length, 0);
  assert.deepEqual(failed.published.at(-1)?.value, {
    stream_id: promptId, sequence: 1, text: '', is_final: true, error_code: 'MODEL_FAILED',
  });
  await failed.bridge.close();
  failed.prompt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'late');
  await settle();
  assert.equal(activityCalls, 1);
});
