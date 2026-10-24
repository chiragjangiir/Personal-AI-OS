import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FixedCanarySttAdapter,
  type FixedCanaryAudioFrame,
  type FixedCanarySttAttempt,
} from '../src/fixed-canary-stt-adapter.ts';

const SAMPLE_COUNT = 144_000;
const WAV_BYTES = 288_044;
const PORT = 8_000;
const ENDPOINT = `http://127.0.0.1:${PORT}/v1/audio/transcriptions`;

function audioFrame(
  samples: number | Int16Array,
  overrides: Partial<FixedCanaryAudioFrame> = {},
): FixedCanaryAudioFrame {
  const data = typeof samples === 'number' ? new Int16Array(samples) : samples;
  return {
    data,
    sampleRate: 16_000,
    channels: 1,
    samplesPerChannel: data.length,
    ...overrides,
  };
}

function frames(values: readonly FixedCanaryAudioFrame[]): AsyncIterable<FixedCanaryAudioFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

interface AttemptFixture {
  readonly attempt: FixedCanarySttAttempt;
  readonly stop: AbortController;
  invalidate(): void;
}

function attemptFixture(
  stream: AsyncIterable<FixedCanaryAudioFrame>,
  overrides: Partial<FixedCanarySttAttempt> = {},
): AttemptFixture {
  const token = {};
  const stop = new AbortController();
  let valid = true;
  return {
    attempt: {
      stream,
      endpointUrl: ENDPOINT,
      endpointPort: PORT,
      model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
      deadlineMs: 5_000,
      token,
      isValid: (candidate) => valid && candidate === token,
      stopSignal: stop.signal,
      ...overrides,
    },
    stop,
    invalidate: () => {
      valid = false;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function submittedWav(
  frameList: readonly FixedCanaryAudioFrame[],
): Promise<{ result: string; bytes: Buffer; calls: number; init: RequestInit; model: string }> {
  let calls = 0;
  let bytes = Buffer.alloc(0);
  let init: RequestInit | undefined;
  let model = '';
  const fakeFetch: typeof fetch = async (_input, suppliedInit) => {
    calls += 1;
    init = suppliedInit;
    assert.ok(suppliedInit?.body instanceof FormData);
    const file = suppliedInit.body.get('file');
    assert.ok(file instanceof File);
    assert.equal(file.name, 'fixed-canary.wav');
    assert.equal(file.type, 'audio/wav');
    bytes = Buffer.from(await file.arrayBuffer());
    model = String(suppliedInit.body.get('model'));
    assert.equal(suppliedInit.body.get('response_format'), 'json');
    return jsonResponse({ text: ' exact final ' });
  };
  const fixture = attemptFixture(frames(frameList));
  const result = await new FixedCanarySttAdapter({ fetch: fakeFetch }).transcribe(fixture.attempt);
  assert.ok(init);
  return { result: result.text, bytes, calls, init, model };
}

test('0, 1, and 143,999 samples end early; a zero-sized frame is malformed', async () => {
  for (const [name, frameList, expected] of [
    ['empty', [], /STT_AUDIO_ENDED_EARLY/],
    ['one', [audioFrame(1)], /STT_AUDIO_ENDED_EARLY/],
    ['143,999', [audioFrame(143_999)], /STT_AUDIO_ENDED_EARLY/],
    ['zero frame', [audioFrame(0)], /STT_AUDIO_FRAME_INVALID/],
  ] as const) {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ text: 'must not happen' });
    };
    const fixture = attemptFixture(frames(frameList));
    await assert.rejects(
      new FixedCanarySttAdapter({ fetch: fakeFetch }).transcribe(fixture.attempt),
      expected,
      name,
    );
    assert.equal(calls, 0, name);
  }
});

test('exactly 144,000 samples produce one bounded POST; extra samples fail before REST', async () => {
  const submitted = await submittedWav([audioFrame(SAMPLE_COUNT)]);
  assert.equal(submitted.result, 'exact final');
  assert.equal(submitted.bytes.length, WAV_BYTES);
  assert.equal(submitted.calls, 1);
  assert.equal(submitted.init.method, 'POST');
  assert.equal(submitted.init.redirect, 'error');
  assert.equal(submitted.init.cache, 'no-store');
  assert.equal(submitted.init.credentials, 'omit');
  assert.ok(submitted.init.signal instanceof AbortSignal);
  assert.equal(submitted.model, 'deepdml/faster-whisper-large-v3-turbo-ct2');

  for (const [name, stream, expected] of [
    ['oversized frame', frames([audioFrame(SAMPLE_COUNT + 1)]), /STT_PCM_BOUNDARY_INVALID/],
    ['extra frame', frames([audioFrame(SAMPLE_COUNT), audioFrame(1)]), /STT_PCM_BOUNDARY_INVALID/],
    ['extra zero frame', frames([audioFrame(SAMPLE_COUNT), audioFrame(0)]), /STT_AUDIO_FRAME_INVALID/],
  ] as const) {
    let calls = 0;
    const fixture = attemptFixture(stream);
    await assert.rejects(
      new FixedCanarySttAdapter({ fetch: async () => { calls += 1; return jsonResponse({ text: 'must not happen' }); } })
        .transcribe(fixture.attempt),
      expected,
      name,
    );
    assert.equal(calls, 0, name);
  }
});

test('an owner-supplied PCM digest is checked against the captured little-endian bytes before REST', async () => {
  const pcm = new Int16Array(SAMPLE_COUNT);
  pcm.set([-32_768, -1, 0, 1, 32_767]);
  const expected = await submittedWav([audioFrame(pcm)]);
  const digest = createHash('sha256').update(expected.bytes.subarray(44)).digest('hex');
  const matching = attemptFixture(frames([audioFrame(pcm)]), { expectedPcmSha256: digest });
  const accepted = await new FixedCanarySttAdapter({ fetch: async () => jsonResponse({ text: 'hash checked' }) })
    .transcribe(matching.attempt);
  assert.equal(accepted.text, 'hash checked');

  let calls = 0;
  const mismatched = attemptFixture(frames([audioFrame(pcm)]), { expectedPcmSha256: '0'.repeat(64) });
  await assert.rejects(
    new FixedCanarySttAdapter({ fetch: async () => { calls += 1; return jsonResponse({ text: 'must not happen' }); } })
      .transcribe(mismatched.attempt),
    /STT_PCM_HASH_MISMATCH/,
  );
  assert.equal(calls, 0);
});

test('fragmented frames copy only the exact oversized tail without aliasing', async () => {
  const first = new Int16Array(143_999);
  first[0] = -12_345;
  first[143_998] = 23_456;
  const tail = Int16Array.from([321]);
  const stream: AsyncIterable<FixedCanaryAudioFrame> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          index += 1;
          if (index === 1) return { done: false, value: audioFrame(first) };
          if (index === 2) {
            first.fill(777);
            return { done: false, value: audioFrame(tail) };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
  const fixture = attemptFixture(stream);
  let wav = Buffer.alloc(0);
  const fakeFetch: typeof fetch = async (_input, init) => {
    const file = (init!.body as FormData).get('file');
    assert.ok(file instanceof File);
    wav = Buffer.from(await file.arrayBuffer());
    tail.fill(999);
    return jsonResponse({ text: 'fragmented' });
  };
  const result = await new FixedCanarySttAdapter({ fetch: fakeFetch }).transcribe(fixture.attempt);
  assert.equal(result.text, 'fragmented');
  assert.equal(wav.readInt16LE(44), -12_345);
  assert.equal(wav.readInt16LE(44 + 143_998 * 2), 23_456);
  assert.equal(wav.readInt16LE(44 + 143_999 * 2), 321);
  assert.equal(wav.includes(Buffer.from([0x42, 0x01])), false);
});

test('canonical PCM16 WAV header and little-endian body are exact', async () => {
  const pcm = new Int16Array(SAMPLE_COUNT);
  pcm.set([-32_768, -1, 0, 1, 32_767]);
  pcm[SAMPLE_COUNT - 1] = -1_234;
  const { bytes } = await submittedWav([audioFrame(pcm)]);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
   assert.equal(bytes.readUInt32LE(4), 288_036);
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.readUInt32LE(16), 16);
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
   assert.equal(bytes.readUInt32LE(24), 16_000);
   assert.equal(bytes.readUInt32LE(28), 32_000);
  assert.equal(bytes.readUInt16LE(32), 2);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
   assert.equal(bytes.readUInt32LE(40), 288_000);
  assert.deepEqual([...bytes.subarray(44, 54)], [0, 128, 255, 255, 0, 0, 1, 0, 255, 127]);
  assert.equal(bytes.readInt16LE(bytes.length - 2), -1_234);
});

test('wrong frame types and geometry fail before REST', async () => {
  const hostiles: Array<[string, FixedCanaryAudioFrame]> = [
    ['rate', audioFrame(SAMPLE_COUNT, { sampleRate: 48_000 })],
    ['channels', audioFrame(SAMPLE_COUNT, { channels: 2 })],
    ['declared underflow', audioFrame(SAMPLE_COUNT, { samplesPerChannel: SAMPLE_COUNT + 1 })],
    ['declared overflow', audioFrame(SAMPLE_COUNT, { samplesPerChannel: SAMPLE_COUNT - 1 })],
    ['fraction', audioFrame(SAMPLE_COUNT, { samplesPerChannel: 1.5 })],
    ['negative', audioFrame(SAMPLE_COUNT, { samplesPerChannel: -1 })],
    ['wrong data', audioFrame(SAMPLE_COUNT, { data: new Uint8Array(SAMPLE_COUNT) as any })],
  ];
  for (const [name, hostile] of hostiles) {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ text: 'no' });
    };
    const fixture = attemptFixture(frames([hostile]));
    await assert.rejects(
      new FixedCanarySttAdapter({ fetch: fakeFetch }).transcribe(fixture.attempt),
      /STT_AUDIO_FRAME_INVALID/,
      name,
    );
    assert.equal(calls, 0, name);
  }
});

test('loopback URL, explicit port, model, and deadline are closed and bounded', async () => {
  const hostileOverrides: Array<[string, Partial<FixedCanarySttAttempt>, RegExp]> = [
    ['https', { endpointUrl: 'https://127.0.0.1:8000/v1/audio/transcriptions' }, /STT_ENDPOINT_REJECTED/],
    ['localhost', { endpointUrl: 'http://localhost:8000/v1/audio/transcriptions' }, /STT_ENDPOINT_REJECTED/],
    ['ipv6', { endpointUrl: 'http://[::1]:8000/v1/audio/transcriptions' }, /STT_ENDPOINT_REJECTED/],
    ['remote', { endpointUrl: 'http://192.0.2.1:8000/v1/audio/transcriptions' }, /STT_ENDPOINT_REJECTED/],
    ['wrong path', { endpointUrl: 'http://127.0.0.1:8000/v1/audio/translations' }, /STT_ENDPOINT_REJECTED/],
    ['wrong port', { endpointPort: 8001 }, /STT_ENDPOINT_REJECTED/],
    ['noncanonical port', { endpointUrl: 'http://127.0.0.1:08000/v1/audio/transcriptions' }, /STT_ENDPOINT_REJECTED/],
    ['query', { endpointUrl: `${ENDPOINT}?token=x` }, /STT_ENDPOINT_REJECTED/],
    ['userinfo', { endpointUrl: 'http://user@127.0.0.1:8000/v1/audio/transcriptions' }, /STT_ENDPOINT_REJECTED/],
    ['blank model', { model: '' }, /STT_MODEL_INVALID/],
    ['trimmed model', { model: ' model ' }, /STT_MODEL_INVALID/],
    ['zero deadline', { deadlineMs: 0 }, /STT_DEADLINE_INVALID/],
    ['long deadline', { deadlineMs: 120_001 }, /STT_DEADLINE_INVALID/],
  ];
  for (const [name, overrides, expected] of hostileOverrides) {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ text: 'no' });
    };
    const fixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]), overrides);
    await assert.rejects(
      new FixedCanarySttAdapter({ fetch: fakeFetch }).transcribe(fixture.attempt),
      expected,
      name,
    );
    assert.equal(calls, 0, name);
  }
});

test('redirect and non-2xx responses are terminal with one call', async () => {
  for (const [name, fakeFetch, expected] of [
    ['redirect', (async () => {
      const response = jsonResponse({ text: 'no' });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }) as typeof fetch, /STT_REDIRECT_REJECTED/],
    ['non-2xx', (async () => jsonResponse({ error: 'unavailable' }, 503)) as typeof fetch, /STT_HTTP_REJECTED/],
  ] as const) {
    let calls = 0;
    const counted: typeof fetch = async (input, init) => {
      calls += 1;
      return fakeFetch(input, init);
    };
    const fixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
    await assert.rejects(
      new FixedCanarySttAdapter({ fetch: counted }).transcribe(fixture.attempt),
      expected,
      name,
    );
    assert.equal(calls, 1, name);
  }
});

test('malformed, empty, and explicitly non-final responses are rejected', async () => {
  const cases: Array<[string, typeof fetch, RegExp]> = [
    ['invalid JSON', async () => new Response('{', { status: 200 }), /STT_RESPONSE_MALFORMED/],
    ['array', async () => jsonResponse([{ text: 'x' }]), /STT_RESPONSE_MALFORMED/],
    ['missing text', async () => jsonResponse({ value: 'x' }), /STT_RESPONSE_MALFORMED/],
    ['empty', async () => jsonResponse({ text: ' \n ' }), /STT_RESPONSE_EMPTY/],
    ['final false', async () => jsonResponse({ text: 'x', final: false }), /STT_RESPONSE_NOT_FINAL/],
    ['is_final false', async () => jsonResponse({ text: 'x', is_final: false }), /STT_RESPONSE_NOT_FINAL/],
  ];
  for (const [name, fakeFetch, expected] of cases) {
    const fixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
    await assert.rejects(
      new FixedCanarySttAdapter({ fetch: fakeFetch }).transcribe(fixture.attempt),
      expected,
      name,
    );
  }
});

test('deadline aborts a stalled stream and a stalled REST call without retry', async () => {
  const neverFrame: AsyncIterable<FixedCanaryAudioFrame> = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => undefined) };
    },
  };
  let calls = 0;
  const streamFixture = attemptFixture(neverFrame, { deadlineMs: 5 });
  await assert.rejects(
    new FixedCanarySttAdapter({ fetch: async () => {
      calls += 1;
      return jsonResponse({ text: 'no' });
    } }).transcribe(streamFixture.attempt),
    /STT_DEADLINE_EXCEEDED/,
  );
  assert.equal(calls, 0);

  const restFixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]), { deadlineMs: 5 });
  await assert.rejects(
    new FixedCanarySttAdapter({ fetch: async () => {
      calls += 1;
      return new Promise(() => undefined);
    } }).transcribe(restFixture.attempt),
    /STT_DEADLINE_EXCEEDED/,
  );
  assert.equal(calls, 1);
});

test('Stop before capture and while REST is pending yields zero final and zero retry', async () => {
  const before = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  before.stop.abort();
  let calls = 0;
  await assert.rejects(
    new FixedCanarySttAdapter({ fetch: async () => {
      calls += 1;
      return jsonResponse({ text: 'no' });
    } }).transcribe(before.attempt),
    /STT_ATTEMPT_STOPPED/,
  );
  assert.equal(calls, 0);

  let started!: () => void;
  const restStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const during = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  const pending = new FixedCanarySttAdapter({ fetch: async (_input, init) => {
    calls += 1;
    started();
    assert.ok(init?.signal);
    return new Promise(() => undefined);
  } }).transcribe(during.attempt);
  await restStarted;
  during.stop.abort();
  await assert.rejects(pending, /STT_ATTEMPT_STOPPED/);
  assert.equal(calls, 1);
});

test('isValid synchronously aborting the bound Stop signal prevents POST', async () => {
  const fixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  const replacement = new AbortController();
  let stopSignalReads = 0;
  const hostileAttempt = {
    ...fixture.attempt,
    isValid: () => {
      fixture.stop.abort();
      return true;
    },
  };
  Object.defineProperty(hostileAttempt, 'stopSignal', {
    enumerable: true,
    get: () => {
      stopSignalReads += 1;
      return stopSignalReads === 1 ? fixture.stop.signal : replacement.signal;
    },
  });
  let calls = 0;
  await assert.rejects(
    new FixedCanarySttAdapter({ fetch: async () => {
      calls += 1;
      return jsonResponse({ text: 'must not post' });
    } }).transcribe(hostileAttempt),
    /STT_ATTEMPT_STOPPED/,
  );
  assert.equal(stopSignalReads, 1);
  assert.equal(calls, 0);
});

test('final isValid synchronously aborting Stop after response JSON yields zero final', async () => {
  const fixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  let jsonCompleted = false;
  let calls = 0;
  const hostileAttempt: FixedCanarySttAttempt = {
    ...fixture.attempt,
    isValid: (token) => {
      if (jsonCompleted) fixture.stop.abort();
      return token === fixture.attempt.token;
    },
  };
  const response = jsonResponse({ text: 'must not escape' });
  Object.defineProperty(response, 'json', {
    value: async () => {
      jsonCompleted = true;
      return { text: 'must not escape' };
    },
  });
  await assert.rejects(
    new FixedCanarySttAdapter({ fetch: async () => {
      calls += 1;
      return response;
    } }).transcribe(hostileAttempt),
    /STT_ATTEMPT_STOPPED/,
  );
  assert.equal(jsonCompleted, true);
  assert.equal(calls, 1);
});

test('post-await invalidation rejects output and aborts before response parsing', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  let jsonCalls = 0;
  const response = jsonResponse({ text: 'late' });
  Object.defineProperty(response, 'json', {
    value: async () => {
      jsonCalls += 1;
      return { text: 'late' };
    },
  });
  const pending = new FixedCanarySttAdapter({ fetch: async () => {
    await gate;
    return response;
  } }).transcribe(fixture.attempt);
  fixture.invalidate();
  release();
  await assert.rejects(pending, /STT_ATTEMPT_INVALIDATED/);
  assert.equal(jsonCalls, 0);
});

test('late REST completion is ignored and the adapter tombstone rejects a second call', async () => {
  let resolveFetch!: (response: Response) => void;
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    started();
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  };
  const adapter = new FixedCanarySttAdapter({ fetch: fakeFetch });
  const first = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  const pending = adapter.transcribe(first.attempt);
  await fetchStarted;
  first.stop.abort();
  await assert.rejects(pending, /STT_ATTEMPT_STOPPED/);
  resolveFetch(jsonResponse({ text: 'too late' }));
  await Promise.resolve();
  assert.equal(calls, 1);

  const second = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  await assert.rejects(adapter.transcribe(second.attempt), /STT_ATTEMPT_ALREADY_TERMINAL/);
  assert.equal(calls, 1);
});

test('a concurrent second invocation fails while the first attempt is running', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = new FixedCanarySttAdapter({ fetch: async () => {
    await gate;
    return jsonResponse({ text: 'first' });
  } });
  const first = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  const second = attemptFixture(frames([audioFrame(SAMPLE_COUNT)]));
  const pending = adapter.transcribe(first.attempt);
  await assert.rejects(adapter.transcribe(second.attempt), /STT_ATTEMPT_ALREADY_TERMINAL/);
  release();
  assert.deepEqual(await pending, { text: 'first', final: true });
});

test('internal PCM and WAV buffers have explicit terminal zeroization', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/fixed-canary-stt-adapter.ts', import.meta.url)),
    'utf8',
  );
  assert.match(source, /finally \{[\s\S]*pcm\?\.fill\(0\);[\s\S]*wav\?\.fill\(0\);/u);
  assert.equal(source.includes('writeFile'), false);
  assert.equal(source.includes('console.'), false);
});
