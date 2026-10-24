import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QWEN38_PROVIDER_CONTEXT_TOKENS,
  QWEN38_PROVIDER_ENDPOINT,
  QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS,
  QWEN38_PROVIDER_MODEL,
  QWEN38_PROVIDER_ORIGIN,
  QWEN38_LOCAL_PROVIDER_PROFILES,
  QWEN38_NVFP4_PROFILE,
  QWEN38_ORCAROUTER_CANARY_PROFILE,
  QWEN38_ORCAROUTER_SUPERVISED_PROFILE,
  QWEN38_ORCAROUTER_PROFILE,
  Qwen38ProviderAdapter,
  Qwen38ProviderError,
  createQwen38ProviderConcurrencyGate,
  freezeQwen38LocalProviderProfile,
  selectQwen38LocalProviderProfile,
} from '../src/qwen38-provider-adapter.ts';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function healthPayload(overrides: Readonly<Record<string, unknown>> = {}): object {
  return {
    status: 'ok',
    service: 'qwen-model-supervisor',
    active_requests: 0,
    owned_process: false,
    last_error: '',
    loaded_model: null,
    loading_model: null,
    backend_port: null,
    ...overrides,
  };
}

function sseText(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function sseResponse(text: string): Response {
  return new Response(sseText(text), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

function fragmentedSseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(sseText(text));
  const cuts = [7, 23, 61, bytes.length - 3, bytes.length];
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const cut of cuts) {
        controller.enqueue(bytes.slice(offset, cut));
        offset = cut;
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function assertCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof Qwen38ProviderError && error.code === expected;
}

test('availability probes exact Supervisor routes without loading the model', async () => {
  const calls: Array<Readonly<{ url: string; method: string | undefined }>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(Object.freeze({ url, method: init?.method }));
    if (url === `${QWEN38_PROVIDER_ENDPOINT}/models`) {
      return jsonResponse({
        object: 'list',
        data: [{ id: QWEN38_PROVIDER_MODEL, context_window: QWEN38_PROVIDER_CONTEXT_TOKENS }],
      });
    }
    assert.equal(url, `${QWEN38_PROVIDER_ORIGIN}/health`);
    return jsonResponse(healthPayload());
  };
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl });
  assert.deepEqual(await adapter.checkAvailability(), {
    ready: true,
    loaded: false,
    activeRequests: 0,
  });
  assert.deepEqual(calls, [
    { url: `${QWEN38_PROVIDER_ENDPOINT}/models`, method: 'GET' },
    { url: `${QWEN38_PROVIDER_ORIGIN}/health`, method: 'GET' },
  ]);
  assert.equal(calls.some((call) => call.method === 'POST'), false);
  adapter.close();
});

test('11601 openai-models profile probes models only and projects its exact model', async () => {
  const calls: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(Object.freeze({ url: String(input), init }));
    if (String(input).endsWith('/models')) {
      return jsonResponse({ data: [{ id: QWEN38_ORCAROUTER_PROFILE.model, context_window: 262_144 }] });
    }
    return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '实际模型回复。' } }] });
  };
  const adapter = new Qwen38ProviderAdapter(QWEN38_ORCAROUTER_PROFILE, { fetchImpl });
  assert.deepEqual(await adapter.checkAvailability(), { ready: true, loaded: false, activeRequests: 0 });
  const response = await adapter.fetchThrough(`${QWEN38_ORCAROUTER_PROFILE.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN38_ORCAROUTER_PROFILE.model, reasoning_effort: 'none', stream: false,
      max_tokens: 48, messages: [{ role: 'user', content: '你好' }],
    }),
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls.map((call) => call.url), [
    `${QWEN38_ORCAROUTER_PROFILE.origin}/v1/models`,
    `${QWEN38_ORCAROUTER_PROFILE.origin}/v1/chat/completions`,
  ]);
  assert.equal(calls.some((call) => call.url.endsWith('/health')), false);
  assert.equal(JSON.parse(String(calls[1]!.init?.body)).model, QWEN38_ORCAROUTER_PROFILE.model);
  await assert.rejects(adapter.fetchThrough(`${QWEN38_ORCAROUTER_PROFILE.origin}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: QWEN38_NVFP4_PROFILE.model, stream: false }),
  }), assertCode('QWEN38_PROVIDER_REQUEST_INVALID'));
  await assert.rejects(adapter.fetchThrough('http://127.0.0.1:11482/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: QWEN38_ORCAROUTER_PROFILE.model, stream: false }),
  }), assertCode('QWEN38_PROVIDER_ROUTE_INVALID'));
  adapter.close();
});

test('16001 ORCA canary profile is exact, frozen, and excluded from global selection', () => {
  assert.equal(QWEN38_ORCAROUTER_CANARY_PROFILE.origin, 'http://127.0.0.1:16001');
  assert.equal(QWEN38_ORCAROUTER_CANARY_PROFILE.model, QWEN38_ORCAROUTER_PROFILE.model);
  assert.equal(QWEN38_ORCAROUTER_CANARY_PROFILE.contextTokens, QWEN38_ORCAROUTER_PROFILE.contextTokens);
  assert.deepEqual(QWEN38_ORCAROUTER_CANARY_PROFILE.capabilities, QWEN38_ORCAROUTER_PROFILE.capabilities);
  assert.equal(QWEN38_ORCAROUTER_CANARY_PROFILE.availabilityMode, QWEN38_ORCAROUTER_PROFILE.availabilityMode);
  assert.equal(QWEN38_ORCAROUTER_CANARY_PROFILE.priority, QWEN38_ORCAROUTER_PROFILE.priority);
  assert.equal(Object.isFrozen(QWEN38_ORCAROUTER_CANARY_PROFILE), true);
  assert.equal(QWEN38_LOCAL_PROVIDER_PROFILES.includes(QWEN38_ORCAROUTER_CANARY_PROFILE), false);
});

test('persistent ORCA profile uses the supervisor health contract and fixed backend binding', () => {
  assert.equal(QWEN38_ORCAROUTER_SUPERVISED_PROFILE.origin, 'http://127.0.0.1:16001');
  assert.equal(QWEN38_ORCAROUTER_SUPERVISED_PROFILE.model, QWEN38_ORCAROUTER_PROFILE.model);
  assert.equal(QWEN38_ORCAROUTER_SUPERVISED_PROFILE.contextTokens, 262_144);
  assert.equal(QWEN38_ORCAROUTER_SUPERVISED_PROFILE.availabilityMode, 'supervisor-health');
  assert.equal(QWEN38_ORCAROUTER_SUPERVISED_PROFILE.supervisorBackendPort, 15_811);
  assert.equal(QWEN38_LOCAL_PROVIDER_PROFILES.includes(QWEN38_ORCAROUTER_SUPERVISED_PROFILE), false);
});

test('models admission requires exactly one selected model', async () => {
  for (const data of [
    [],
    [{ id: QWEN38_ORCAROUTER_PROFILE.model }, { id: QWEN38_ORCAROUTER_PROFILE.model }],
    [{ id: QWEN38_NVFP4_PROFILE.model }],
  ]) {
    const adapter = new Qwen38ProviderAdapter(QWEN38_ORCAROUTER_PROFILE, {
      fetchImpl: async () => jsonResponse({ data }),
    });
    await assert.rejects(adapter.checkAvailability(), assertCode('QWEN38_PROVIDER_MODEL_UNAVAILABLE'));
    adapter.close();
  }
});

test('profile validation rejects remote/credentialed/pathful origins and captures mutations', async () => {
  for (const origin of [
    'https://127.0.0.1:11601', 'http://localhost:11601', 'http://127.0.0.1:11601/v1',
    'http://user:pass@127.0.0.1:11601', 'http://127.0.0.1:11601?x=1',
    'http://10.0.0.1:11601',
  ]) {
    assert.throws(() => freezeQwen38LocalProviderProfile({
      ...QWEN38_ORCAROUTER_PROFILE, origin,
    }), assertCode('QWEN38_PROVIDER_PROFILE_INVALID'));
  }
  const mutable = { ...QWEN38_ORCAROUTER_PROFILE };
  const seen: string[] = [];
  const adapter = new Qwen38ProviderAdapter(mutable, {
    fetchImpl: async (input) => {
      seen.push(String(input));
      return jsonResponse({ data: [{ id: QWEN38_ORCAROUTER_PROFILE.model, context_window: 262_144 }] });
    },
  });
  mutable.origin = 'http://127.0.0.1:9999';
  mutable.model = 'drifted';
  await adapter.checkAvailability();
  assert.deepEqual(seen, [`${QWEN38_ORCAROUTER_PROFILE.origin}/v1/models`]);
  adapter.close();
});

test('selector skips unavailable/insufficient candidates, freezes sessions, and fails ties', async () => {
  const legacy = { ...QWEN38_NVFP4_PROFILE, priority: 10 };
  const orca = { ...QWEN38_ORCAROUTER_PROFILE, priority: 20 };
  const selected = await selectQwen38LocalProviderProfile(
    [legacy, orca], { requiredCapabilities: ['vision'], minContextTokens: 262_144 },
    async (profile) => profile.model === orca.model,
  );
  assert.equal(selected.model, orca.model);
  assert.equal(Object.isFrozen(selected), true);
  const next = await selectQwen38LocalProviderProfile(
    [legacy, orca], { requiredCapabilities: ['vision'] },
    async (profile) => profile.model === legacy.model,
  );
  assert.equal(next.model, legacy.model);
  await assert.rejects(
    selectQwen38LocalProviderProfile([
      { ...legacy, priority: 1 }, { ...orca, priority: 1 },
    ], {}, () => true),
    assertCode('QWEN38_PROVIDER_SELECTION_AMBIGUOUS'),
  );
  await assert.rejects(
    selectQwen38LocalProviderProfile([], {}, () => true),
    assertCode('QWEN38_PROVIDER_SELECTION_EMPTY'),
  );
});

test('first real inference uses exact model and streams fragmented deltas to final', async () => {
  const calls: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(Object.freeze({ url: String(input), init }));
    return fragmentedSseResponse('桌边两人正在专注交流。');
  };
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl });
  const deltas: string[] = [];
  assert.deepEqual(await adapter.complete({
    messages: [{ role: 'user', content: [{ type: 'text', text: '描述图片' }] }],
    maxTokens: 48,
    temperature: 0,
  }, undefined, (delta) => { deltas.push(delta); }), {
    text: '桌边两人正在专注交流。',
    finishReason: 'stop',
  });
  assert.deepEqual(deltas, ['桌边两人正在专注交流。']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${QWEN38_PROVIDER_ENDPOINT}/chat/completions`);
  assert.equal(calls[0]!.init?.method, 'POST');
  const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, QWEN38_PROVIDER_MODEL);
  assert.equal(body.stream, true);
  assert.equal(body.reasoning_effort, 'none');
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(Object.keys(body).sort(), [
    'chat_template_kwargs', 'max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'temperature',
  ]);
  assert.equal(Object.hasOwn(body, 'keep_alive'), false);
  adapter.close();
});

test('shared lifecycle gate admits at most three concurrent inference requests', async () => {
  const gate = createQwen38ProviderConcurrencyGate();
  const resolvers: Array<(response: Response) => void> = [];
  const fetchImpl: typeof fetch = async () => new Promise<Response>((resolve) => { resolvers.push(resolve); });
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl, concurrencyGate: gate });
  const request = { messages: [{ role: 'user' as const, content: '你好' }], maxTokens: 16 };
  const admitted = Array.from({ length: QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS }, () => adapter.complete(request));
  await Promise.resolve();
  assert.equal(gate.active, QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS);
  await assert.rejects(adapter.complete(request), assertCode('QWEN38_PROVIDER_BUSY'));
  for (const resolve of resolvers) resolve(sseResponse('并发请求已经完成。'));
  assert.equal((await Promise.all(admitted)).every((value) => value.text === '并发请求已经完成。'), true);
  assert.equal(gate.active, 0);
  adapter.close();
});

test('Abort cancels the in-flight HTTP request and releases concurrency', async () => {
  const gate = createQwen38ProviderConcurrencyGate();
  let observedSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    observedSignal = init?.signal ?? undefined;
    observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl, concurrencyGate: gate });
  const abort = new AbortController();
  const completion = adapter.complete({ messages: [{ role: 'user', content: '停止' }], maxTokens: 8 }, abort.signal);
  await Promise.resolve();
  assert.equal(gate.active, 1);
  abort.abort();
  await assert.rejects(completion, assertCode('QWEN38_PROVIDER_ABORTED'));
  assert.equal(observedSignal?.aborted, true);
  assert.equal(gate.active, 0);
  adapter.close();
});

test('close fences new work, aborts active work, and never calls a model lifecycle route', async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => new Promise<Response>((_resolve, reject) => {
    urls.push(String(input));
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl });
  const completion = adapter.complete({ messages: [{ role: 'user', content: '清理' }], maxTokens: 8 });
  await Promise.resolve();
  adapter.close();
  await assert.rejects(completion, assertCode('QWEN38_PROVIDER_ABORTED'));
  await assert.rejects(adapter.complete({ messages: [{ role: 'user', content: '重试' }], maxTokens: 8 }),
    assertCode('QWEN38_PROVIDER_CLOSED'));
  assert.deepEqual(urls, [`${QWEN38_PROVIDER_ENDPOINT}/chat/completions`]);
  assert.equal(urls.some((url) => /(?:start|stop|shutdown|unload|keepalive)/iu.test(url)), false);
});

test('legacy realtime fetch is fenced to Supervisor chat while unrelated local STT is delegated', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '回复。' } }] });
  };
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl });
  const providerResponse = await adapter.fetchThrough(`${QWEN38_PROVIDER_ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN38_PROVIDER_MODEL,
      stream: false,
      messages: [{ role: 'user', content: '你好' }],
    }),
  });
  assert.equal(providerResponse.ok, true);
  assert.deepEqual(await providerResponse.json(), {
    choices: [{ finish_reason: 'stop', message: { content: '回复。' } }],
  });
  const stt = await adapter.fetchThrough('http://127.0.0.1:8000/v1/audio/transcriptions', { method: 'POST' });
  assert.equal(stt.ok, true);
  await assert.rejects(adapter.fetchThrough('http://127.0.0.1:11436/v1/chat/completions', {
    method: 'POST', body: '{}',
  }), assertCode('QWEN38_PROVIDER_ROUTE_INVALID'));
  await assert.rejects(adapter.fetchThrough('http://127.0.0.1:11582/v1/chat/completions', {
    method: 'POST', body: '{}',
  }), assertCode('QWEN38_PROVIDER_ROUTE_INVALID'));
  await assert.rejects(adapter.fetchThrough(`${QWEN38_PROVIDER_ENDPOINT}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model: QWEN38_PROVIDER_MODEL, stream: false, keep_alive: '24h' }),
  }), assertCode('QWEN38_PROVIDER_REQUEST_INVALID'));
  assert.deepEqual(calls, [
    `${QWEN38_PROVIDER_ENDPOINT}/chat/completions`,
    'http://127.0.0.1:8000/v1/audio/transcriptions',
  ]);
  adapter.close();
});

test('health rejects a loaded target whose observed backend port drifts', async () => {
  const fetchImpl: typeof fetch = async (input) => String(input).endsWith('/models')
    ? jsonResponse({ data: [{ id: QWEN38_PROVIDER_MODEL, context_window: QWEN38_PROVIDER_CONTEXT_TOKENS }] })
    : jsonResponse(healthPayload({ loaded_model: QWEN38_PROVIDER_MODEL, owned_process: true, backend_port: 11482 }));
  const adapter = new Qwen38ProviderAdapter(QWEN38_NVFP4_PROFILE, { fetchImpl });
  await assert.rejects(adapter.checkAvailability(), assertCode('QWEN38_PROVIDER_BACKEND_BINDING_INVALID'));
  adapter.close();
});
