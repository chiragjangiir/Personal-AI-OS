import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createWindowsAiInferenceOrchestrator,
  type WindowsAiInferenceEvent,
  type WindowsAiInferenceProviderPort,
  type WindowsAiInferenceRunInput,
} from '../src/windows-ai-inference-orchestrator.ts';
import {
  createQwen38ProviderConcurrencyGate,
  QWEN38_PROVIDER_CONTEXT_TOKENS,
  QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS,
  type Qwen38ChatRequest,
  type Qwen38ProviderAvailability,
  type Qwen38ProviderConcurrencyGate,
  type Qwen38StreamEvent,
} from '../src/qwen38-provider-adapter.ts';
import type {
  OwnerCanonicalObjectVersionRef,
  WindowsAiContextCompilerInput,
  WindowsAiTokenEstimator,
} from '../src/windows-ai-context-compiler.ts';

type StreamScript = (
  input: Qwen38ChatRequest,
  signal: AbortSignal,
) => AsyncGenerator<Qwen38StreamEvent>;

function ref(refType: string, suffix: number, version = '1'): OwnerCanonicalObjectVersionRef {
  return Object.freeze({
    ref_type: refType,
    ref_id: `018f0d7a-1b2c-7d4e-8a6b-${suffix.toString(16).padStart(12, '0')}`,
    object_version: version,
    canonical_payload_sha256: (suffix % 16).toString(16).repeat(64),
  });
}

const ROUTE = ref('ProviderRoute', 1);
const MODEL = ref('ModelDefinition', 2);
const FINAL = ref('FinalTranscriptEvidence', 3);

function baseInput(overrides: Partial<WindowsAiContextCompilerInput> = {}): WindowsAiContextCompilerInput {
  return {
    providerRouteRef: ROUTE,
    modelDefinitionRef: MODEL,
    instruction: '请根据当前证据给出简洁建议。',
    budget: { reservedOutputTokens: 32_768, inputTokenLimit: 90_000 },
    ...overrides,
  };
}

const estimator: WindowsAiTokenEstimator = () => 10;

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function availability(overrides: Partial<Qwen38ProviderAvailability> = {}): Qwen38ProviderAvailability {
  return Object.freeze({
    ready: true,
    loaded: false,
    activeRequests: 0,
    ...overrides,
  });
}

class FakeProvider implements WindowsAiInferenceProviderPort {
  readonly calls: string[] = [];
  readonly inputs: Qwen38ChatRequest[] = [];
  readonly #availability: Qwen38ProviderAvailability | Error;
  readonly #script: StreamScript;
  readonly #streamGate: Qwen38ProviderConcurrencyGate | undefined;
  readonly #onStreamFinally: (() => void) | undefined;

  constructor(
    script: StreamScript,
    providerAvailability: Qwen38ProviderAvailability | Error = availability(),
    streamGate?: Qwen38ProviderConcurrencyGate,
    onStreamFinally?: () => void,
  ) {
    this.#script = script;
    this.#availability = providerAvailability;
    this.#streamGate = streamGate;
    this.#onStreamFinally = onStreamFinally;
  }

  readonly checkAvailability = async (signal?: AbortSignal): Promise<Qwen38ProviderAvailability> => {
    this.calls.push('readiness');
    if (signal?.aborted === true) throw codedError('QWEN38_PROVIDER_ABORTED');
    if (this.#availability instanceof Error) throw this.#availability;
    return this.#availability;
  };

  readonly stream = (input: Qwen38ChatRequest, signal?: AbortSignal): AsyncGenerator<Qwen38StreamEvent> => {
    this.calls.push('stream');
    this.inputs.push(input);
    return this.#streamWithProviderGate(input, signal ?? new AbortController().signal);
  };

  async *#streamWithProviderGate(
    input: Qwen38ChatRequest,
    signal: AbortSignal,
  ): AsyncGenerator<Qwen38StreamEvent> {
    const release = this.#streamGate?.acquire();
    try {
      yield* this.#script(input, signal);
    } finally {
      release?.();
      this.#onStreamFinally?.();
    }
  }
}

async function* normalStream(): AsyncGenerator<Qwen38StreamEvent> {
  yield Object.freeze({ kind: 'delta', text: '部分建议。' });
  yield Object.freeze({ kind: 'final', text: '完整建议。', finishReason: 'stop' });
}

async function collect(
  orchestrator: ReturnType<typeof createWindowsAiInferenceOrchestrator>,
  input: WindowsAiInferenceRunInput = { context: baseInput() },
): Promise<Readonly<{ events: readonly WindowsAiInferenceEvent[]; terminal: Awaited<ReturnType<typeof orchestrator.run>> }>> {
  const events: WindowsAiInferenceEvent[] = [];
  const terminal = await orchestrator.run(input, async (event) => { events.push(event); });
  return Object.freeze({ events: Object.freeze(events), terminal });
}

async function waitUntil(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.fail('condition did not become true');
}

test('compiles once, checks readiness before stream, assembles reserved output and is deterministic', async () => {
  const firstProvider = new FakeProvider(normalStream);
  const secondProvider = new FakeProvider(normalStream);
  const runInput: WindowsAiInferenceRunInput = {
    context: baseInput({
      transcripts: [{ ref: FINAL, status: 'final', text: '最终确认内容。', startMs: 10, endMs: 20 }],
    }),
    temperature: 0.2,
  };
  const first = await collect(createWindowsAiInferenceOrchestrator({
    provider: firstProvider,
    estimator,
  }), runInput);
  const second = await collect(createWindowsAiInferenceOrchestrator({
    provider: secondProvider,
    estimator,
  }), runInput);

  assert.deepEqual(first, second);
  assert.deepEqual(firstProvider.calls, ['readiness', 'stream']);
  assert.equal(firstProvider.inputs[0]?.maxTokens, 32_768);
  assert.equal(firstProvider.inputs[0]?.temperature, 0.2);
  assert.equal(first.terminal.terminal, 'final');
  assert.deepEqual(first.events.map((event) => event.kind), ['delta', 'final']);
  assert.equal(first.terminal.manifest.events.final, 1);
  assert.equal(first.terminal.manifest.provider.readiness, 'ready');
  assert.equal(first.terminal.manifest.provider.activeRequests, 0);
});

test('compiler failures stop before Provider and missing modalities remain explicit', async () => {
  let estimatorCalls = 0;
  const provider = new FakeProvider(normalStream);
  const input = baseInput({ providerRouteRef: { ...ROUTE, ref_id: 'not-a-uuid' } });
  const result = await collect(createWindowsAiInferenceOrchestrator({
    provider,
    estimator: () => { estimatorCalls += 1; return 10; },
  }), { context: input });

  assert.equal(result.terminal.terminal, 'error');
  assert.deepEqual(result.events, [{
    kind: 'error', error: { code: 'CONTEXT_INVALID', retryable: false },
  }]);
  assert.equal(estimatorCalls, 0);
  assert.deepEqual(provider.calls, []);

  const missing = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(normalStream),
    estimator,
  }));
  assert.deepEqual(missing.terminal.manifest.degradedReasons, [
    'ARTIFACT_MISSING',
    'FINAL_TRANSCRIPT_MISSING',
    'HEALTH_SUMMARY_MISSING',
    'LOCATION_SUMMARY_MISSING',
    'MEMORY_CONTEXT_MISSING',
    'SESSION_HISTORY_MISSING',
    'SPEAKER_TIMELINE_MISSING',
  ]);
});

test('caller cancellation before compile does not touch estimator, gate or Provider', async () => {
  const abort = new AbortController();
  abort.abort();
  let estimatorCalls = 0;
  const provider = new FakeProvider(normalStream);
  const result = await collect(createWindowsAiInferenceOrchestrator({
    provider,
    estimator: () => { estimatorCalls += 1; return 10; },
  }), { context: baseInput(), signal: abort.signal });

  assert.deepEqual(result.events, [{ kind: 'cancelled', reason: 'caller' }]);
  assert.equal(result.terminal.terminal, 'cancelled');
  assert.equal(estimatorCalls, 0);
  assert.deepEqual(provider.calls, []);
  assert.deepEqual(result.terminal.manifest.phases, ['created', 'terminal_cancelled', 'fenced']);
});

test('cancellation raised by the injected estimator stops before readiness', async () => {
  const abort = new AbortController();
  let estimatorCalls = 0;
  const provider = new FakeProvider(normalStream);
  const result = await collect(createWindowsAiInferenceOrchestrator({
    provider,
    estimator: () => {
      estimatorCalls += 1;
      abort.abort();
      return 10;
    },
  }), { context: baseInput(), signal: abort.signal });

  assert.deepEqual(result.events, [{ kind: 'cancelled', reason: 'caller' }]);
  assert.equal(result.terminal.terminal, 'cancelled');
  assert.equal(estimatorCalls, 1);
  assert.deepEqual(provider.calls, []);
  assert.equal(result.terminal.manifest.replayManifest.length, 0);
});

test('readiness errors are typed and active three is rejected without stream', async () => {
  const unavailable = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(normalStream, codedError('QWEN38_PROVIDER_NOT_READY')),
    estimator,
  }));
  assert.deepEqual(unavailable.events, [{
    kind: 'error', error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
  }]);
  assert.equal(unavailable.terminal.manifest.provider.readiness, 'failed');

  const busy = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(normalStream, availability({ activeRequests: QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS })),
    estimator,
  }));
  assert.deepEqual(busy.events, [{
    kind: 'error', error: { code: 'PROVIDER_BUSY', retryable: true },
  }]);
  assert.equal(busy.terminal.manifest.provider.readiness, 'busy');
  assert.deepEqual(busy.terminal.manifest.events, {
    delta: 0, final: 0, error: 1, cancelled: 0, lateDropped: 0,
  });
});

test('missing final is invalid while duplicate final is fenced to one terminal', async () => {
  const missing = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(async function* missingFinal() {
      yield Object.freeze({ kind: 'delta', text: '只有增量。' });
    }),
    estimator,
  }));
  assert.deepEqual(missing.events, [
    { kind: 'delta', text: '只有增量。' },
    { kind: 'error', error: { code: 'PROVIDER_STREAM_INVALID', retryable: false } },
  ]);

  let produced = 0;
  const duplicate = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(async function* duplicateFinal() {
      produced += 1;
      yield Object.freeze({ kind: 'final', text: '第一次终态。', finishReason: 'stop' });
      produced += 1;
      yield Object.freeze({ kind: 'final', text: '第二次终态。', finishReason: 'stop' });
    }),
    estimator,
  }));
  assert.deepEqual(duplicate.events, [{ kind: 'final', text: '第一次终态。', finishReason: 'stop' }]);
  assert.equal(duplicate.terminal.terminal, 'final');
  assert.equal(duplicate.terminal.manifest.events.final, 1);
  assert.equal(produced, 1, 'the fence closes the provider iterator after the first terminal');
});

test('Provider stream errors map stably and never retry', async () => {
  const streamError = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(async function* invalidStream() {
      yield Object.freeze({ kind: 'delta', text: '前缀。' });
      throw codedError('QWEN38_PROVIDER_STREAM_INVALID');
    }),
    estimator,
  }));
  assert.deepEqual(streamError.events, [
    { kind: 'delta', text: '前缀。' },
    { kind: 'error', error: { code: 'PROVIDER_STREAM_INVALID', retryable: false } },
  ]);
  assert.equal(streamError.terminal.manifest.provider.readiness, 'ready');

  const closed = await collect(createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(async function* closedStream() {
      throw codedError('QWEN38_PROVIDER_CLOSED');
    }),
    estimator,
  }));
  assert.deepEqual(closed.events, [{
    kind: 'error', error: { code: 'PROVIDER_CLOSED', retryable: false },
  }]);
});

test('caller Abort during Provider drops the late final and emits one cancellation', async () => {
  const abort = new AbortController();
  const resultEvents: WindowsAiInferenceEvent[] = [];
  const provider = new FakeProvider(async function* lateFinal(_input, signal) {
    yield Object.freeze({ kind: 'delta', text: '先到的增量。' });
    await Promise.resolve();
    if (signal.aborted) yield Object.freeze({ kind: 'final', text: '迟到终态。', finishReason: 'stop' });
  });
  const result = await createWindowsAiInferenceOrchestrator({ provider, estimator }).run(
    { context: baseInput(), signal: abort.signal },
    async (event) => {
      resultEvents.push(event);
      if (event.kind === 'delta') abort.abort();
    },
  );

  assert.deepEqual(resultEvents, [
    { kind: 'delta', text: '先到的增量。' },
    { kind: 'cancelled', reason: 'caller' },
  ]);
  assert.equal(result.terminal, 'cancelled');
  assert.equal(result.manifest.events.lateDropped, 1);
  assert.equal(result.manifest.events.final, 0);
});

test('final delivered before a later Abort remains final', async () => {
  const abort = new AbortController();
  const events: WindowsAiInferenceEvent[] = [];
  const result = await createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(normalStream),
    estimator,
  }).run({ context: baseInput(), signal: abort.signal }, async (event) => {
    events.push(event);
    if (event.kind === 'final') abort.abort();
  });

  assert.deepEqual(events, [
    { kind: 'delta', text: '部分建议。' },
    { kind: 'final', text: '完整建议。', finishReason: 'stop' },
  ]);
  assert.equal(result.terminal, 'final');
  assert.equal(result.manifest.events.cancelled, 0);
});

test('awaited sink provides one-event backpressure and no eager final pull', async () => {
  let pullCount = 0;
  let deltaSeen = false;
  let finalSeen = false;
  let releaseDelta: (() => void) | undefined;
  const provider = new FakeProvider(async function* paced() {
    pullCount += 1;
    yield Object.freeze({ kind: 'delta', text: '背压增量。' });
    pullCount += 1;
    yield Object.freeze({ kind: 'final', text: '背压终态。', finishReason: 'stop' });
  });
  const run = createWindowsAiInferenceOrchestrator({ provider, estimator }).run(
    { context: baseInput() },
    (event) => {
      if (event.kind === 'delta') {
        deltaSeen = true;
        return new Promise<void>((resolve) => { releaseDelta = resolve; });
      }
      finalSeen = true;
    },
  );
  await waitUntil(() => deltaSeen);
  assert.equal(pullCount, 1);
  assert.equal(finalSeen, false);
  releaseDelta?.();
  const result = await run;
  assert.equal(result.terminal, 'final');
  assert.equal(pullCount, 2);
  assert.equal(finalSeen, true);
});

test('generic sink failure becomes CONSUMER_FAILURE without a second terminal', async () => {
  const events: string[] = [];
  const result = await createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(normalStream),
    estimator,
  }).run({ context: baseInput() }, (event) => {
    events.push(event.kind);
    throw new Error('sink failure must not be persisted');
  });

  assert.deepEqual(events, ['delta']);
  assert.equal(result.terminal, 'error');
  assert.deepEqual(result.manifest.error, { code: 'CONSUMER_FAILURE', retryable: false });
  assert.equal(result.manifest.events.error, 0);
  assert.equal(result.manifest.events.cancelled, 0);
});

test('generic final sink failure records terminal_error and fenced, without a second terminal', async () => {
  const events: string[] = [];
  const result = await createWindowsAiInferenceOrchestrator({
    provider: new FakeProvider(normalStream),
    estimator,
  }).run({ context: baseInput() }, (event) => {
    events.push(event.kind);
    if (event.kind === 'final') throw new Error('final sink failure');
  });

  assert.deepEqual(events, ['delta', 'final']);
  assert.equal(result.terminal, 'error');
  assert.deepEqual(result.manifest.error, { code: 'CONSUMER_FAILURE', retryable: false });
  assert.deepEqual(result.manifest.phases.slice(-2), ['terminal_error', 'fenced']);
  assert.equal(result.manifest.events.final, 0);
  assert.equal(result.manifest.events.error, 0);
});

test('sink AbortError while awaiting delta becomes consumer cancellation and releases Provider gate', async () => {
  const providerGate = createQwen38ProviderConcurrencyGate();
  let providerFinally = 0;
  const provider = new FakeProvider(
    normalStream,
    availability(),
    providerGate,
    () => { providerFinally += 1; },
  );
  const events: string[] = [];
  const result = await createWindowsAiInferenceOrchestrator({ provider, estimator }).run(
    { context: baseInput() },
    (event) => {
      events.push(event.kind);
      if (event.kind === 'delta') throw new DOMException('consumer cancelled', 'AbortError');
    },
  );

  assert.deepEqual(events, ['delta']);
  assert.equal(result.terminal, 'cancelled');
  assert.equal(result.manifest.error, null);
  assert.deepEqual(result.manifest.phases.slice(-2), ['terminal_cancelled', 'fenced']);
  assert.equal(providerFinally, 1);
  assert.equal(providerGate.active, 0);
});

test('sink AbortError while awaiting final cancels without claiming final delivery and releases Provider gate', async () => {
  const providerGate = createQwen38ProviderConcurrencyGate();
  let providerFinally = 0;
  const provider = new FakeProvider(
    normalStream,
    availability(),
    providerGate,
    () => { providerFinally += 1; },
  );
  const events: string[] = [];
  const result = await createWindowsAiInferenceOrchestrator({ provider, estimator }).run(
    { context: baseInput() },
    (event) => {
      events.push(event.kind);
      if (event.kind === 'final') throw new DOMException('consumer cancelled', 'AbortError');
    },
  );

  assert.deepEqual(events, ['delta', 'final']);
  assert.equal(result.terminal, 'cancelled');
  assert.equal(result.manifest.error, null);
  assert.deepEqual(result.manifest.phases.slice(-2), ['terminal_cancelled', 'fenced']);
  assert.equal(result.manifest.events.final, 0);
  assert.equal(providerFinally, 1);
  assert.equal(providerGate.active, 0);
});

test('the fixed gate admits three runs and rejects the fourth without queueing', async () => {
  const resolvers: Array<() => void> = [];
  const providerGate = createQwen38ProviderConcurrencyGate();
  const provider = new FakeProvider(async function* blocked(_input, signal) {
    await new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    yield Object.freeze({ kind: 'delta', text: '并发增量。' });
    yield Object.freeze({ kind: 'final', text: '并发终态。', finishReason: 'stop' });
  }, availability(), providerGate);
  const orchestrator = createWindowsAiInferenceOrchestrator({ provider, estimator });
  const admitted = Array.from({ length: QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS }, () => collect(orchestrator));
  await waitUntil(() => resolvers.length === QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS);
  const fourth = await collect(orchestrator);
  assert.deepEqual(fourth.events, [{
    kind: 'error', error: { code: 'PROVIDER_BUSY', retryable: true },
  }]);
  assert.equal(provider.calls.filter((call) => call === 'readiness').length, 4);
  assert.equal(providerGate.active, QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS);
  resolvers.forEach((resolve) => resolve());
  const completed = await Promise.all(admitted);
  assert.equal(completed.every((value) => value.terminal.terminal === 'final'), true);
  assert.equal(providerGate.active, 0);
});

test('late provider throw after cancellation cannot replace the cancellation terminal', async () => {
  const abort = new AbortController();
  const events: WindowsAiInferenceEvent[] = [];
  const provider = new FakeProvider(async function* lateThrow(_input, signal) {
    yield Object.freeze({ kind: 'delta', text: '可见增量。' });
    await Promise.resolve();
    if (signal.aborted) throw codedError('QWEN38_PROVIDER_ABORTED');
    yield Object.freeze({ kind: 'final', text: '不应到达。', finishReason: 'stop' });
  });
  const result = await createWindowsAiInferenceOrchestrator({ provider, estimator }).run(
    { context: baseInput(), signal: abort.signal },
    async (event) => {
      events.push(event);
      if (event.kind === 'delta') abort.abort();
    },
  );
  assert.deepEqual(events, [
    { kind: 'delta', text: '可见增量。' },
    { kind: 'cancelled', reason: 'caller' },
  ]);
  assert.equal(result.terminal, 'cancelled');
  assert.equal(result.manifest.events.error, 0);
});

test('source remains an internal non-wire core without shared identity or delivery fields', () => {
  const source = readFileSync(new URL('../src/windows-ai-inference-orchestrator.ts', import.meta.url), 'utf8');
  for (const token of ['request_id', 'session_id', 'continuity_id', 'receipt', 'DeliveryReceipt', 'sequence', 'cursor']) {
    assert.equal(source.includes(token), false, `forbidden shared token: ${token}`);
  }
  assert.equal(/Date\s*\.|Math\.random|crypto\.random|setTimeout/u.test(source), false);
});

assert.equal(QWEN38_PROVIDER_CONTEXT_TOKENS, 131_072);
