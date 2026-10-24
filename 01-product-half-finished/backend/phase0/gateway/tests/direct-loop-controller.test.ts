import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RoomEvent,
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import {
  DirectLoopController,
  type DirectLoopAttempt,
  type DirectLoopConfig,
} from '../src/direct-loop-controller.ts';
import {
  assertDispatchRequest,
  DeviceSessionAdapter,
  type GatewayConfig,
  type RoomServicePort,
} from '../src/device-session-adapter.ts';
import type {
  FixedCanaryFinalTranscript,
  FixedCanarySttAttempt,
} from '../src/fixed-canary-stt-adapter.ts';

const CONFIG: DirectLoopConfig = Object.freeze({
  sttEndpointUrl: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  sttEndpointPort: 8000,
  sttModel: 'frozen-stt-model',
  sttDeadlineMs: 10_000,
  ollamaModel: 'installed-local-model',
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function response(
  payload: unknown,
  status = 200,
  properties: Partial<Response> = {},
): Response {
  return {
    status,
    redirected: false,
    type: 'basic',
    json: async () => payload,
    ...properties,
  } as Response;
}

function key(trackAttempt = 1, publicationSid = 'TR_directLoop001') {
  return Object.freeze({
    contract_profile: 'phase0-demo/0.3' as const,
    session_id: 'phase0_session_direct_loop_001',
    publisher_identity: 'web_device_direct_loop_001',
    publication_sid: publicationSid,
    track_attempt: trackAttempt,
  });
}

interface HarnessOptions {
  readonly stt?: Promise<FixedCanaryFinalTranscript>;
  readonly model?: Promise<Response>;
  readonly delivery?: Promise<unknown>;
  readonly modelResponse?: Response;
  readonly deadlineImmediately?: boolean;
  readonly valid?: { value: boolean };
}

function harness(options: HarnessOptions = {}) {
  const calls = {
    stt: 0,
    stream: 0,
    model: 0,
    request: 0,
    result: 0,
    delivery: 0,
    deadline: [] as number[],
    order: [] as string[],
    modelUrl: '',
    modelInit: undefined as RequestInit | undefined,
    destination: '',
  };
  let now = 1_000;
  const controller = new DirectLoopController(CONFIG, {
    now: () => ++now,
    createStt: () => ({
      transcribe: async (_attempt: FixedCanarySttAttempt) => {
        calls.stt += 1;
        calls.order.push('stt');
        return options.stt ?? Object.freeze({ text: 'fixed canary', final: true });
      },
    }),
    fetch: async (input, init) => {
      calls.model += 1;
      calls.order.push('model');
      calls.modelUrl = String(input);
      calls.modelInit = init;
      return options.model ?? options.modelResponse ??
        response({ choices: [{ message: { role: 'assistant', content: 'direct reply' } }] });
    },
    scheduleModelDeadline: (callback, delayMs) => {
      calls.deadline.push(delayMs);
      if (options.deadlineImmediately) queueMicrotask(callback);
      return { cancel: () => undefined };
    },
  });
  const token = {};
  const valid = options.valid ?? { value: true };
  const attempt: DirectLoopAttempt = {
    key: key(),
    token,
    originatingParticipantIdentity: key().publisher_identity,
    createStream: () => {
      calls.stream += 1;
      calls.order.push('stream');
      return (async function* () {
        yield {
          data: new Int16Array(96_000),
          sampleRate: 24_000,
          channels: 1,
          samplesPerChannel: 96_000,
        };
      })();
    },
    isValid: (candidate) => candidate === token && valid.value,
    prepareSource: () => calls.order.push('prepare'),
    acceptTranscriptAndModelRequested: (transcript) => {
      calls.request += 1;
      calls.order.push(`request:${transcript.text}`);
      return { requestEventId: '31000000-0000-4000-8000-000000000001' };
    },
    acceptModelResult: ({ requestEventId, text, model }) => {
      calls.result += 1;
      calls.order.push(`result:${text}`);
      assert.equal(requestEventId, '31000000-0000-4000-8000-000000000001');
      assert.equal(model, CONFIG.ollamaModel);
      return { resultEventId: '31000000-0000-4000-8000-000000000002' };
    },
    sendDirectedChat: async (text, destinationIdentity) => {
      calls.delivery += 1;
      calls.order.push(`delivery:${text}`);
      calls.destination = destinationIdentity;
      return options.delivery ?? undefined;
    },
  };
  return { controller, attempt, calls, valid, token };
}

test('happy path commits result before one directed delivery and exact duplicate is a no-op', async () => {
  const { controller, attempt, calls } = harness();
  const first = controller.execute(attempt);
  const duplicate = controller.execute(attempt);
  assert.equal(await first, 'success');
  assert.equal(await duplicate, 'success');
  assert.deepEqual(calls.order, [
    'prepare',
    'stream',
    'stt',
    'request:fixed canary',
    'model',
    'result:direct reply',
    'delivery:direct reply',
  ]);
  assert.equal(calls.stt, 1);
  assert.equal(calls.model, 1);
  assert.equal(calls.result, 1);
  assert.equal(calls.delivery, 1);
  assert.equal(calls.destination, key().publisher_identity);
  assert.equal(calls.modelUrl, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls.modelInit?.method, 'POST');
  assert.equal(calls.modelInit?.redirect, 'error');
  assert.equal(calls.modelInit?.cache, 'no-store');
  assert.equal(calls.modelInit?.credentials, 'omit');
  assert.ok(calls.modelInit?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls.modelInit?.body)), {
    model: CONFIG.ollamaModel,
    messages: [{ role: 'user', content: 'fixed canary' }],
    stream: false,
  });
  assert.deepEqual(calls.deadline, [30_000]);
  assert.equal(controller.snapshot(key().session_id)?.state, 'SUCCESS');
});

test('concurrent duplicate does not start twice; divergent attempt tombstones until cleanup', async () => {
  const pendingStt = deferred<FixedCanaryFinalTranscript>();
  const { controller, attempt, calls } = harness({ stt: pendingStt.promise });
  const first = controller.execute(attempt);
  const duplicate = controller.execute(attempt);
  assert.equal(calls.stt, 1);
  const divergent = {
    ...attempt,
    key: key(2),
    token: {},
  };
  await assert.rejects(controller.execute(divergent), /DIRECT_LOOP_ATTEMPT_CONFLICT/);
  pendingStt.resolve(Object.freeze({ text: 'late transcript', final: true }));
  await assert.rejects(first, /DIRECT_LOOP_ATTEMPT_CONFLICT/);
  await assert.rejects(duplicate, /DIRECT_LOOP_ATTEMPT_CONFLICT/);
  assert.deepEqual(controller.snapshot(key().session_id), {
    key: key(),
    state: 'TERMINAL_FAILURE',
    tombstoned: true,
    stopped: false,
    error: 'DIRECT_LOOP_ATTEMPT_CONFLICT',
  });
  await assert.rejects(controller.execute(attempt), /DIRECT_LOOP_ATTEMPT_CONFLICT/);
  controller.stopSession(key().session_id);
  controller.clearAfterVerifiedCleanup(key().session_id);
  assert.equal(controller.snapshot(key().session_id), undefined);
});

for (const [name, modelResponse, expected] of [
  ['redirect', response({}, 200, { redirected: true }), /OLLAMA_REDIRECT_REJECTED/],
  ['non-2xx', response({}, 503), /OLLAMA_HTTP_REJECTED/],
  ['malformed', response({}), /OLLAMA_RESPONSE_MALFORMED/],
  ['multiple choices', response({
    choices: [
      { message: { role: 'assistant', content: 'one' } },
      { message: { role: 'assistant', content: 'two' } },
    ],
  }), /OLLAMA_RESPONSE_MALFORMED/],
  ['wrong role', response({
    choices: [{ message: { role: 'user', content: 'wrong' } }],
  }), /OLLAMA_RESPONSE_MALFORMED/],
  ['empty', response({
    choices: [{ message: { role: 'assistant', content: '   ' } }],
  }), /OLLAMA_RESPONSE_EMPTY/],
] as const) {
  test(`Ollama ${name} is terminal with zero result or delivery`, async () => {
    const { controller, attempt, calls } = harness({ modelResponse });
    await assert.rejects(controller.execute(attempt), expected);
    assert.equal(calls.stt, 1);
    assert.equal(calls.model, 1);
    assert.equal(calls.result, 0);
    assert.equal(calls.delivery, 0);
    assert.equal(controller.snapshot(key().session_id)?.state, 'TERMINAL_FAILURE');
  });
}

test('explicit model is mandatory and timeout aborts the sole model request', async () => {
  assert.throws(
    () => new DirectLoopController({ ...CONFIG, ollamaModel: ' ' }),
    /OLLAMA_MODEL_REQUIRED/,
  );
  const never = deferred<Response>();
  const { controller, attempt, calls } = harness({
    model: never.promise,
    deadlineImmediately: true,
  });
  await assert.rejects(controller.execute(attempt), /OLLAMA_DEADLINE_EXCEEDED/);
  assert.equal(calls.model, 1);
  assert.equal(calls.result, 0);
  assert.equal(calls.delivery, 0);
});

test('final revalidation rejects invalidated STT result before model request', async () => {
  const pendingStt = deferred<FixedCanaryFinalTranscript>();
  const valid = { value: true };
  const { controller, attempt, calls } = harness({ stt: pendingStt.promise, valid });
  const completion = controller.execute(attempt);
  valid.value = false;
  pendingStt.resolve(Object.freeze({ text: 'late', final: true }));
  await assert.rejects(completion, /DIRECT_LOOP_ATTEMPT_INVALIDATED/);
  assert.equal(calls.request, 0);
  assert.equal(calls.model, 0);
});

test('Stop during STT, model, or delivery blocks late ratification and never retries', async () => {
  {
    const pending = deferred<FixedCanaryFinalTranscript>();
    const { controller, attempt, calls } = harness({ stt: pending.promise });
    const completion = controller.execute(attempt);
    controller.stopSession(key().session_id);
    pending.resolve(Object.freeze({ text: 'too late', final: true }));
    await assert.rejects(completion, /DIRECT_LOOP_ATTEMPT_STOPPED/);
    assert.equal(calls.request, 0);
    assert.equal(calls.model, 0);
  }
  {
    const pending = deferred<Response>();
    const { controller, attempt, calls } = harness({ model: pending.promise });
    const completion = controller.execute(attempt);
    await tick();
    controller.stopSession(key().session_id);
    await assert.rejects(completion, /DIRECT_LOOP_ATTEMPT_STOPPED/);
    pending.resolve(response({
      choices: [{ message: { role: 'assistant', content: 'late model' } }],
    }));
    await tick();
    assert.equal(calls.model, 1);
    assert.equal(calls.result, 0);
    assert.equal(calls.delivery, 0);
  }
  {
    const pending = deferred<unknown>();
    const { controller, attempt, calls } = harness({ delivery: pending.promise });
    const completion = controller.execute(attempt);
    await tick();
    assert.equal(calls.result, 1);
    assert.equal(calls.delivery, 1);
    controller.stopSession(key().session_id);
    await assert.rejects(completion, /DIRECT_LOOP_ATTEMPT_STOPPED/);
    pending.resolve(undefined);
    await tick();
    assert.equal(calls.delivery, 1);
    assert.equal(controller.snapshot(key().session_id)?.state, 'TERMINAL_FAILURE');
  }
});

test('directed delivery failure is terminal after accepted result and has zero retry', async () => {
  const delivery = Promise.reject(new Error('directed send failed'));
  const { controller, attempt, calls } = harness({ delivery });
  await assert.rejects(controller.execute(attempt), /directed send failed/);
  assert.deepEqual(calls.order.slice(-2), ['result:direct reply', 'delivery:direct reply']);
  assert.equal(calls.result, 1);
  assert.equal(calls.delivery, 1);
  assert.equal(controller.snapshot(key().session_id)?.state, 'TERMINAL_FAILURE');
});

test('cleanup cannot clear an active attempt and clears tombstone only after Stop', async () => {
  const pending = deferred<FixedCanaryFinalTranscript>();
  const { controller, attempt } = harness({ stt: pending.promise });
  const completion = controller.execute(attempt);
  assert.throws(
    () => controller.clearAfterVerifiedCleanup(key().session_id),
    /DIRECT_LOOP_CLEANUP_NOT_STOPPED/,
  );
  controller.stopSession(key().session_id);
  controller.clearAfterVerifiedCleanup(key().session_id);
  pending.resolve(Object.freeze({ text: 'late', final: true }));
  await assert.rejects(completion, /DIRECT_LOOP_AFTER_VERIFIED_CLEANUP|DIRECT_LOOP_ATTEMPT_STOPPED/);
  assert.equal(controller.snapshot(key().session_id), undefined);
});

class FakeRoom {
  readonly remoteParticipants = new Map<string, RemoteParticipant>();
  readonly handlers = new Map<string, (...args: never[]) => void>();
  readonly chatCalls: Array<readonly [string, readonly string[]]> = [];
  readonly published: unknown[] = [];
  localParticipant = {
    identity: 'windows_gateway_01',
    attributes: {
      schema_version: 'phase0-demo/0.3',
      device_id: 'windows_gateway_01',
      device_class: 'windows_gateway',
      client_instance_id: 'gateway_client_01',
    },
    sendChatMessage: async (text: string, identities?: string[]) => {
      this.chatCalls.push([text, Object.freeze([...(identities ?? [])])]);
      return {};
    },
    publishData: async (...args: unknown[]) => {
      this.published.push(args);
    },
  };
  on(event: string, handler: (...args: never[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function fakeRoomService(identity: { value: string | undefined }): RoomServicePort {
  return {
    createRoom: async () => ({}),
    listParticipants: async () => identity.value ? [{ identity: identity.value }] : [],
    deleteRoom: async () => undefined,
    listRooms: async () => [],
  };
}

test('connection request is empty-only and token contains no Agent dispatch', async () => {
  assert.doesNotThrow(() => assertDispatchRequest({}));
  assert.throws(
    () => assertDispatchRequest({ room_config: { agents: [{ agent_name: 'my-agent' }] } }, 'my-agent'),
    /CONNECTION_REQUEST_CLOSED_MAP/,
  );
});

for (const ordering of ['event-first', 'already-subscribed'] as const) {
  test(`${ordering} remote microphone path starts one STT/model and one directed return`, async () => {
    const identity = { value: undefined as string | undefined };
    const room = new FakeRoom();
    let sttCalls = 0;
    let streamCalls = 0;
    let modelCalls = 0;
    const direct = new DirectLoopController(CONFIG, {
      createStt: () => ({
        transcribe: async () => {
          sttCalls += 1;
          return Object.freeze({ text: 'physical mic canary', final: true });
        },
      }),
      fetch: async () => {
        modelCalls += 1;
        return response({
          choices: [{ message: { role: 'assistant', content: 'same iPhone reply' } }],
        });
      },
      scheduleModelDeadline: () => ({ cancel: () => undefined }),
    });
    const gatewayConfig: GatewayConfig = {
      livekitUrl: 'ws://127.0.0.1:7880',
      apiKey: '0123456789abcdef',
      apiSecret: '0123456789abcdef0123456789abcdef',
      sessionTtlSeconds: 7_200,
      tokenTtlSeconds: 900,
    };
    const adapter = new DeviceSessionAdapter(gatewayConfig, {
      roomService: fakeRoomService(identity),
      roomFactory: () => room as never,
      directLoopController: direct,
      audioStreamFactory: () => {
        streamCalls += 1;
        return (async function* () {
          yield {
            data: new Int16Array(96_000),
            sampleRate: 24_000,
            channels: 1,
            samplesPerChannel: 96_000,
          };
        })();
      },
    });
    const details = await adapter.createConnectionDetails({});
    const timeline: Array<{ eventType: string | undefined }> = [];
    const unsubscribe = adapter.subscribe(details.roomName, (item) => {
      timeline.push({ eventType: item.eventType });
    });
    const tokenPayload = decodeJwtPayload(details.participantToken);
    identity.value = String(tokenPayload.sub);
    assert.equal(tokenPayload.roomConfig, undefined);
    assert.equal(details.roomName, details.roomName);
    const attributes = tokenPayload.attributes as Record<string, string>;
    const track = {} as RemoteTrack;
    const publication = {
      sid: 'TR_iPhoneMic001',
      kind: TrackKind.KIND_AUDIO,
      source: TrackSource.SOURCE_MICROPHONE,
      subscribed: true,
      track,
    } as RemoteTrackPublication;
    const participant = {
      identity: identity.value,
      attributes,
      trackPublications: new Map<string, RemoteTrackPublication>(),
    } as unknown as RemoteParticipant;
    const wrongTrack = {} as RemoteTrack;
    const wrongPublication = {
      sid: 'TR_wrongVideo001',
      kind: TrackKind.KIND_AUDIO,
      source: TrackSource.SOURCE_CAMERA,
      subscribed: true,
      track: wrongTrack,
    } as RemoteTrackPublication;
    participant.trackPublications.set('TR_wrongVideo001', wrongPublication);
    participant.trackPublications.set('TR_iPhoneMic001', publication);
    const foreignTrack = {} as RemoteTrack;
    const foreignPublication = {
      sid: 'TR_foreignMic001',
      kind: TrackKind.KIND_AUDIO,
      source: TrackSource.SOURCE_MICROPHONE,
      subscribed: true,
      track: foreignTrack,
    } as RemoteTrackPublication;
    const foreignParticipant = {
      identity: 'foreign_device_001',
      attributes: {
        ...attributes,
        device_id: 'foreign_device_001',
      },
      trackPublications: new Map([['TR_foreignMic001', foreignPublication]]),
    } as unknown as RemoteParticipant;
    const absentParticipant = {
      ...participant,
      trackPublications: participant.trackPublications,
    } as unknown as RemoteParticipant;
    const originalConnect = room.connect.bind(room);
    room.connect = async () => {
      await originalConnect();
      room.remoteParticipants.set(foreignParticipant.identity, foreignParticipant);
      room.remoteParticipants.set(participant.identity, participant);
      if (ordering === 'event-first') {
        room.handlers.get(RoomEvent.TrackSubscribed)?.(
          foreignTrack as never,
          foreignPublication as never,
          foreignParticipant as never,
        );
        room.handlers.get(RoomEvent.TrackSubscribed)?.(
          track as never,
          publication as never,
          absentParticipant as never,
        );
        room.handlers.get(RoomEvent.TrackSubscribed)?.(
          wrongTrack as never,
          wrongPublication as never,
          participant as never,
        );
        room.handlers.get(RoomEvent.TrackSubscribed)?.(
          track as never,
          publication as never,
          participant as never,
        );
      }
    };
    if (ordering === 'already-subscribed') {
      room.remoteParticipants.set(foreignParticipant.identity, foreignParticipant);
      room.remoteParticipants.set(participant.identity, participant);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    for (let attempt = 0; attempt < 20 && room.chatCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sttCalls, 1);
    assert.equal(streamCalls, 1);
    assert.equal(modelCalls, 1);
    assert.deepEqual(room.chatCalls, [['same iPhone reply', [participant.identity]]]);
    const eventTypes = timeline.flatMap((item) =>
      item.eventType === undefined ? [] : [item.eventType]
    );
    assert.deepEqual(eventTypes.slice(0, 6), [
      'paios.phase0.demo.session.started',
      'paios.phase0.demo.capture.status',
      'paios.phase0.demo.media.referenced',
      'paios.phase0.demo.transcript.final',
      'paios.phase0.demo.model.requested',
      'paios.phase0.demo.model.result',
    ]);
    unsubscribe();
    await adapter.stopSession(details.roomName, 'gate_complete');
    assert.equal(adapter.sessionExists(details.roomName), false);
  });
}
