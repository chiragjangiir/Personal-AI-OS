import { createHash } from 'node:crypto';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const SAMPLE_COUNT = 144_000;
const PCM_BYTE_COUNT = SAMPLE_COUNT * 2;
const WAV_HEADER_BYTES = 44;
const WAV_BYTE_COUNT = WAV_HEADER_BYTES + PCM_BYTE_COUNT;
const TRANSCRIPTION_PATH = '/v1/audio/transcriptions';
const MIN_DEADLINE_MS = 1;
const MAX_DEADLINE_MS = 120_000;

/** Android Stage-A's fixed 9-second canary PCM digest. */
export const FIXED_CANARY_PCM_SHA256 =
  '74a7d518a51201e9d045411ded734a36882ea00b3cc2a9eb828aebcc869516c9';

export interface FixedCanaryAudioFrame {
  readonly data: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerChannel: number;
}

export interface FixedCanarySttAttempt {
  readonly stream: AsyncIterable<FixedCanaryAudioFrame>;
  readonly endpointUrl: string;
  readonly endpointPort: number;
  readonly model: string;
  /** Optional owner-supplied digest; when present, actual captured PCM must match it. */
  readonly expectedPcmSha256?: string;
  readonly deadlineMs: number;
  readonly token: object;
  readonly isValid: (token: object) => boolean;
  readonly stopSignal: AbortSignal;
}

export interface FixedCanaryFinalTranscript {
  readonly text: string;
  readonly final: true;
}

export interface FixedCanarySttDependencies {
  readonly fetch: typeof fetch;
}

type AbortReason = 'caller_stop' | 'deadline' | 'caller_invalid';
type AdapterState = 'ready' | 'running' | 'terminal';

function failure(code: string): Error {
  return new Error(code);
}

function assertAttemptShape(
  attempt: FixedCanarySttAttempt,
): { readonly endpoint: URL; readonly stopSignal: AbortSignal } {
  const stopSignal = attempt?.stopSignal;
  if (
    attempt === null ||
    typeof attempt !== 'object' ||
    attempt.token === null ||
    typeof attempt.token !== 'object' ||
    typeof attempt.isValid !== 'function' ||
    typeof attempt.stream?.[Symbol.asyncIterator] !== 'function' ||
    !(stopSignal instanceof AbortSignal)
  ) {
    throw failure('STT_ATTEMPT_INVALID');
  }
  if (
    !Number.isInteger(attempt.endpointPort) ||
    attempt.endpointPort < 1 ||
    attempt.endpointPort > 65_535
  ) {
    throw failure('STT_ENDPOINT_REJECTED');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(attempt.endpointUrl);
  } catch {
    throw failure('STT_ENDPOINT_REJECTED');
  }
  const exactUrl =
    `http://127.0.0.1:${attempt.endpointPort}${TRANSCRIPTION_PATH}`;
  if (
    attempt.endpointUrl !== exactUrl ||
    endpoint.href !== exactUrl ||
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port !== String(attempt.endpointPort) ||
    endpoint.pathname !== TRANSCRIPTION_PATH ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw failure('STT_ENDPOINT_REJECTED');
  }
  if (
    typeof attempt.model !== 'string' ||
    attempt.model.length < 1 ||
    attempt.model.length > 512 ||
    attempt.model.trim() !== attempt.model ||
    /[\u0000-\u001f\u007f]/u.test(attempt.model)
  ) {
    throw failure('STT_MODEL_INVALID');
  }
  if (attempt.expectedPcmSha256 !== undefined &&
      (typeof attempt.expectedPcmSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(attempt.expectedPcmSha256))) {
    throw failure('STT_PCM_HASH_INVALID');
  }
  if (
    !Number.isInteger(attempt.deadlineMs) ||
    attempt.deadlineMs < MIN_DEADLINE_MS ||
    attempt.deadlineMs > MAX_DEADLINE_MS
  ) {
    throw failure('STT_DEADLINE_INVALID');
  }
  return { endpoint, stopSignal };
}

function assertFrame(frame: FixedCanaryAudioFrame): void {
  if (
    frame === null ||
    typeof frame !== 'object' ||
    !(frame.data instanceof Int16Array) ||
    frame.sampleRate !== SAMPLE_RATE ||
    frame.channels !== CHANNELS ||
    !Number.isSafeInteger(frame.samplesPerChannel) ||
    frame.samplesPerChannel <= 0 ||
    frame.data.length !== frame.samplesPerChannel
  ) {
    throw failure('STT_AUDIO_FRAME_INVALID');
  }
}

function buildCanonicalWav(pcm: Int16Array): Buffer {
  if (pcm.length !== SAMPLE_COUNT) throw failure('STT_PCM_BOUNDARY_INVALID');
  const wav = Buffer.alloc(WAV_BYTE_COUNT);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(WAV_BYTE_COUNT - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  wav.writeUInt16LE(CHANNELS * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(PCM_BYTE_COUNT, 40);
  for (let index = 0; index < pcm.length; index += 1) {
    wav.writeInt16LE(pcm[index]!, WAV_HEADER_BYTES + index * 2);
  }
  return wav;
}

function waitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(failure('STT_ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(failure('STT_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function detachIterator(iterator: AsyncIterator<FixedCanaryAudioFrame>): void {
  if (typeof iterator.return !== 'function') return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Terminal cleanup is best-effort and cannot ratify or reattempt.
  }
}

function transcriptFromPayload(payload: unknown): FixedCanaryFinalTranscript {
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw failure('STT_RESPONSE_MALFORMED');
  }
  const response = payload as Record<string, unknown>;
  if (
    ('final' in response && response.final !== true) ||
    ('is_final' in response && response.is_final !== true)
  ) {
    throw failure('STT_RESPONSE_NOT_FINAL');
  }
  if (typeof response.text !== 'string') {
    throw failure('STT_RESPONSE_MALFORMED');
  }
  const text = response.text.trim();
  if (text.length === 0) throw failure('STT_RESPONSE_EMPTY');
  return Object.freeze({ text, final: true });
}

export class FixedCanarySttAdapter {
  readonly #fetch: typeof fetch;
  #state: AdapterState = 'ready';

  constructor(dependencies: FixedCanarySttDependencies) {
    if (dependencies === null || typeof dependencies?.fetch !== 'function') {
      throw failure('STT_DEPENDENCIES_INVALID');
    }
    this.#fetch = dependencies.fetch;
  }

  async transcribe(attempt: FixedCanarySttAttempt): Promise<FixedCanaryFinalTranscript> {
    if (this.#state !== 'ready') throw failure('STT_ATTEMPT_ALREADY_TERMINAL');
    this.#state = 'running';

    let pcm: Int16Array | undefined;
    let wav: Buffer | undefined;
    let form: FormData | undefined;
    let iterator: AsyncIterator<FixedCanaryAudioFrame> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let abortReason: AbortReason | undefined;
    const controller = new AbortController();

    const abort = (reason: AbortReason): void => {
      if (controller.signal.aborted) return;
      abortReason = reason;
      controller.abort();
    };
    const throwAbort = (): never => {
      if (abortReason === 'deadline') throw failure('STT_DEADLINE_EXCEEDED');
      if (abortReason === 'caller_invalid') throw failure('STT_ATTEMPT_INVALIDATED');
      throw failure('STT_ATTEMPT_STOPPED');
    };

    try {
      const { endpoint, stopSignal } = assertAttemptShape(attempt);
      const assertActive = (): void => {
        if (controller.signal.aborted || stopSignal.aborted) {
          if (!controller.signal.aborted) abort('caller_stop');
          throwAbort();
        }
        let valid = false;
        try {
          valid = attempt.isValid(attempt.token) === true;
        } catch {
          valid = false;
        }
        if (controller.signal.aborted || stopSignal.aborted) {
          if (!controller.signal.aborted) abort('caller_stop');
          throwAbort();
        }
        if (!valid) {
          abort('caller_invalid');
          throwAbort();
        }
      };

      const onCallerStop = () => abort('caller_stop');
      if (stopSignal.aborted) onCallerStop();
      else stopSignal.addEventListener('abort', onCallerStop, { once: true });
      timer = setTimeout(() => abort('deadline'), attempt.deadlineMs);
      timer.unref?.();

      try {
        assertActive();
        pcm = new Int16Array(SAMPLE_COUNT);
        iterator = attempt.stream[Symbol.asyncIterator]();
        let written = 0;
        while (written < SAMPLE_COUNT) {
          let item: IteratorResult<FixedCanaryAudioFrame>;
          try {
            item = await waitWithAbort(Promise.resolve(iterator.next()), controller.signal);
          } catch (error) {
            if (controller.signal.aborted) throwAbort();
            throw error;
          }
          assertActive();
          if (item.done) throw failure('STT_AUDIO_ENDED_EARLY');
          assertFrame(item.value);
          const remaining = SAMPLE_COUNT - written;
          if (item.value.samplesPerChannel > remaining) throw failure('STT_PCM_BOUNDARY_INVALID');
          pcm.set(item.value.data, written);
          written += item.value.samplesPerChannel;
        }
        assertActive();
        if (written !== SAMPLE_COUNT) throw failure('STT_PCM_BOUNDARY_INVALID');
        let trailing: IteratorResult<FixedCanaryAudioFrame>;
        try {
          trailing = await waitWithAbort(Promise.resolve(iterator.next()), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throwAbort();
          throw error;
        }
        assertActive();
        if (!trailing.done) {
          assertFrame(trailing.value);
          throw failure('STT_PCM_BOUNDARY_INVALID');
        }
        detachIterator(iterator);
        iterator = undefined;

        wav = buildCanonicalWav(pcm);
        assertActive();
        const actualPcmSha256 = createHash('sha256').update(wav.subarray(WAV_HEADER_BYTES)).digest('hex');
        if (attempt.expectedPcmSha256 !== undefined && actualPcmSha256 !== attempt.expectedPcmSha256) {
          throw failure('STT_PCM_HASH_MISMATCH');
        }
        form = new FormData();
        form.append('file', new File([wav], 'fixed-canary.wav', { type: 'audio/wav' }));
        form.append('model', attempt.model);
        form.append('response_format', 'json');

        let response: Response;
        try {
          response = await waitWithAbort(this.#fetch(endpoint, {
            method: 'POST',
            body: form,
            signal: controller.signal,
            redirect: 'error',
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          }), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throwAbort();
          throw error;
        }
        assertActive();
        if (response.redirected || response.type === 'opaqueredirect') {
          throw failure('STT_REDIRECT_REJECTED');
        }
        if (response.status < 200 || response.status >= 300) {
          throw failure('STT_HTTP_REJECTED');
        }

        let payload: unknown;
        try {
          payload = await waitWithAbort(response.json(), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throwAbort();
          throw failure('STT_RESPONSE_MALFORMED');
        }
        assertActive();
        return transcriptFromPayload(payload);
      } finally {
        stopSignal.removeEventListener('abort', onCallerStop);
      }
    } finally {
      this.#state = 'terminal';
      if (timer) clearTimeout(timer);
      controller.abort();
      if (iterator) detachIterator(iterator);
      pcm?.fill(0);
      wav?.fill(0);
      form = undefined;
      pcm = undefined;
      wav = undefined;
    }
  }
}
