import {
  FixedCanarySttAdapter,
  type FixedCanaryAudioFrame,
  type FixedCanarySttAttempt,
  type FixedCanaryFinalTranscript,
} from './fixed-canary-stt-adapter.ts';

const CONTRACT_PROFILE = 'phase0-demo/0.3';
const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
const MODEL_DEADLINE_MS = 30_000;
const IDENTIFIER = /^[a-z][a-z0-9_-]{2,63}$/;
const PUBLICATION_SID = /^TR_[A-Za-z0-9]+$/;

export type DirectLoopState =
  | 'RESERVED'
  | 'MODEL_IN_FLIGHT'
  | 'RESULT_COMMITTED'
  | 'DELIVERY_IN_FLIGHT'
  | 'SUCCESS'
  | 'TERMINAL_FAILURE';

export interface DirectLoopAttemptKey {
  readonly contract_profile: typeof CONTRACT_PROFILE;
  readonly session_id: string;
  readonly publisher_identity: string;
  readonly publication_sid: string;
  readonly track_attempt: number;
}

export interface DirectLoopConfig {
  readonly sttEndpointUrl: string;
  readonly sttEndpointPort: number;
  readonly sttModel: string;
  readonly sttDeadlineMs: number;
  readonly ollamaModel: string;
}

export interface DirectLoopAttempt {
  readonly key: DirectLoopAttemptKey;
  readonly token: object;
  readonly originatingParticipantIdentity: string;
  readonly createStream: () => AsyncIterable<FixedCanaryAudioFrame>;
  readonly isValid: (token: object) => boolean;
  readonly prepareSource: () => void;
  readonly acceptTranscriptAndModelRequested: (
    transcript: FixedCanaryFinalTranscript,
    observedAt: number,
  ) => { readonly requestEventId: string };
  readonly acceptModelResult: (input: {
    readonly requestEventId: string;
    readonly text: string;
    readonly model: string;
    readonly latencyMs: number;
    readonly observedAt: number;
  }) => { readonly resultEventId: string };
  readonly sendDirectedChat: (
    text: string,
    destinationIdentity: string,
  ) => Promise<unknown>;
}

export interface DirectLoopSnapshot {
  readonly key: DirectLoopAttemptKey;
  readonly state: DirectLoopState;
  readonly tombstoned: boolean;
  readonly stopped: boolean;
  readonly error?: string;
}

interface DeadlineHandle {
  cancel(): void;
}

export interface DirectLoopDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly createStt?: (fetchImplementation: typeof fetch) => {
    transcribe(attempt: FixedCanarySttAttempt): Promise<FixedCanaryFinalTranscript>;
  };
  readonly scheduleModelDeadline?: (
    callback: () => void,
    delayMs: typeof MODEL_DEADLINE_MS,
  ) => DeadlineHandle;
}

interface AttemptRecord {
  readonly key: DirectLoopAttemptKey;
  readonly fingerprint: string;
  readonly token: object;
  readonly abortController: AbortController;
  state: DirectLoopState;
  tombstoned: boolean;
  stopped: boolean;
  cleaned: boolean;
  error?: string;
  completion?: Promise<'success'>;
}

function failure(code: string): Error {
  return new Error(code);
}

function assertNonblank(value: unknown, code: string, maxLength: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw failure(code);
  }
}

function assertConfig(config: DirectLoopConfig): void {
  if (
    config === null ||
    typeof config !== 'object' ||
    !Number.isInteger(config.sttEndpointPort) ||
    config.sttEndpointPort < 1 ||
    config.sttEndpointPort > 65_535 ||
    config.sttEndpointUrl !==
      `http://127.0.0.1:${config.sttEndpointPort}/v1/audio/transcriptions` ||
    !Number.isInteger(config.sttDeadlineMs) ||
    config.sttDeadlineMs < 1 ||
    config.sttDeadlineMs > 120_000
  ) {
    throw failure('DIRECT_LOOP_CONFIG_REQUIRED');
  }
  assertNonblank(config.sttModel, 'DIRECT_LOOP_CONFIG_REQUIRED', 512);
  assertNonblank(config.ollamaModel, 'OLLAMA_MODEL_REQUIRED', 128);
}

function assertKey(key: DirectLoopAttemptKey): void {
  if (
    key === null ||
    typeof key !== 'object' ||
    key.contract_profile !== CONTRACT_PROFILE ||
    !IDENTIFIER.test(key.session_id) ||
    !IDENTIFIER.test(key.publisher_identity) ||
    !PUBLICATION_SID.test(key.publication_sid) ||
    !Number.isSafeInteger(key.track_attempt) ||
    key.track_attempt < 1
  ) {
    throw failure('DIRECT_LOOP_ATTEMPT_INVALID');
  }
}

function keyFingerprint(key: DirectLoopAttemptKey): string {
  return [
    key.contract_profile,
    key.session_id,
    key.publisher_identity,
    key.publication_sid,
    String(key.track_attempt),
  ].join('\u0000');
}

function waitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  code: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(failure(code));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(failure(code));
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

function assistantText(payload: unknown): string {
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw failure('OLLAMA_RESPONSE_MALFORMED');
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw failure('OLLAMA_RESPONSE_MALFORMED');
  }
  const choice = choices[0];
  if (choice === null || Array.isArray(choice) || typeof choice !== 'object') {
    throw failure('OLLAMA_RESPONSE_MALFORMED');
  }
  const message = (choice as Record<string, unknown>).message;
  if (message === null || Array.isArray(message) || typeof message !== 'object') {
    throw failure('OLLAMA_RESPONSE_MALFORMED');
  }
  const record = message as Record<string, unknown>;
  if (record.role !== 'assistant' || typeof record.content !== 'string') {
    throw failure('OLLAMA_RESPONSE_MALFORMED');
  }
  if (record.content.trim().length === 0) throw failure('OLLAMA_RESPONSE_EMPTY');
  if (record.content.length > 4_096) throw failure('OLLAMA_RESPONSE_TOO_LARGE');
  return record.content;
}

export class DirectLoopController {
  readonly #config: DirectLoopConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #createStt: NonNullable<DirectLoopDependencies['createStt']>;
  readonly #scheduleModelDeadline: NonNullable<
    DirectLoopDependencies['scheduleModelDeadline']
  >;
  readonly #records = new Map<string, AttemptRecord>();
  readonly #stoppedSessions = new Set<string>();

  constructor(config: DirectLoopConfig, dependencies: DirectLoopDependencies = {}) {
    assertConfig(config);
    if (dependencies.fetch !== undefined && typeof dependencies.fetch !== 'function') {
      throw failure('DIRECT_LOOP_DEPENDENCIES_INVALID');
    }
    this.#config = Object.freeze({ ...config });
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#createStt =
      dependencies.createStt ??
      ((fetchImplementation) => new FixedCanarySttAdapter({ fetch: fetchImplementation }));
    this.#scheduleModelDeadline = dependencies.scheduleModelDeadline ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    });
  }

  execute(attempt: DirectLoopAttempt): Promise<'success'> {
    this.#assertAttempt(attempt);
    const { session_id: sessionId } = attempt.key;
    if (this.#stoppedSessions.has(sessionId)) {
      return Promise.reject(failure('DIRECT_LOOP_ATTEMPT_STOPPED'));
    }
    const fingerprint = keyFingerprint(attempt.key);
    const existing = this.#records.get(sessionId);
    if (existing) {
      if (
        !existing.tombstoned &&
        existing.fingerprint === fingerprint &&
        existing.token === attempt.token
      ) {
        return existing.completion!;
      }
      this.#makeTerminal(existing, 'DIRECT_LOOP_ATTEMPT_CONFLICT', true);
      return Promise.reject(failure('DIRECT_LOOP_ATTEMPT_CONFLICT'));
    }
    const record: AttemptRecord = {
      key: Object.freeze({ ...attempt.key }),
      fingerprint,
      token: attempt.token,
      abortController: new AbortController(),
      state: 'RESERVED',
      tombstoned: false,
      stopped: false,
      cleaned: false,
    };
    this.#records.set(sessionId, record);
    record.completion = this.#run(record, attempt);
    return record.completion;
  }

  invalidate(sessionId: string, token: object): void {
    const record = this.#records.get(sessionId);
    if (record?.token === token) {
      this.#makeTerminal(record, 'DIRECT_LOOP_ATTEMPT_INVALIDATED', true);
    }
  }

  stopSession(sessionId: string): void {
    this.#stoppedSessions.add(sessionId);
    const record = this.#records.get(sessionId);
    if (!record) return;
    record.stopped = true;
    if (record.state !== 'SUCCESS') {
      this.#makeTerminal(record, 'DIRECT_LOOP_ATTEMPT_STOPPED', true);
    } else {
      record.abortController.abort();
    }
  }

  clearAfterVerifiedCleanup(sessionId: string): void {
    if (!this.#stoppedSessions.has(sessionId)) {
      throw failure('DIRECT_LOOP_CLEANUP_NOT_STOPPED');
    }
    const record = this.#records.get(sessionId);
    if (record) {
      record.cleaned = true;
      record.abortController.abort();
      this.#records.delete(sessionId);
    }
    this.#stoppedSessions.delete(sessionId);
  }

  snapshot(sessionId: string): DirectLoopSnapshot | undefined {
    const record = this.#records.get(sessionId);
    if (!record) return undefined;
    return Object.freeze({
      key: Object.freeze({ ...record.key }),
      state: record.state,
      tombstoned: record.tombstoned,
      stopped: record.stopped,
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  }

  async #run(record: AttemptRecord, attempt: DirectLoopAttempt): Promise<'success'> {
    try {
      this.#assertActive(record, attempt);
      attempt.prepareSource();
      this.#assertActive(record, attempt);
      const transcript = await this.#createStt(this.#fetch).transcribe({
        stream: attempt.createStream(),
        endpointUrl: this.#config.sttEndpointUrl,
        endpointPort: this.#config.sttEndpointPort,
        model: this.#config.sttModel,
        deadlineMs: this.#config.sttDeadlineMs,
        token: attempt.token,
        isValid: (token) => this.#isActive(record, attempt, token),
        stopSignal: record.abortController.signal,
      });
      this.#assertActive(record, attempt);
      const requestedAt = this.#now();
      const { requestEventId } = attempt.acceptTranscriptAndModelRequested(
        transcript,
        requestedAt,
      );
      this.#assertActive(record, attempt);
      record.state = 'MODEL_IN_FLIGHT';

      const modelStartedAt = this.#now();
      const modelAbort = new AbortController();
      let deadlineReached = false;
      const onStop = () => modelAbort.abort();
      record.abortController.signal.addEventListener('abort', onStop, { once: true });
      const deadline = this.#scheduleModelDeadline(() => {
        deadlineReached = true;
        modelAbort.abort();
      }, MODEL_DEADLINE_MS);
      try {
        let response: Response;
        try {
          response = await waitWithAbort(this.#fetch(OLLAMA_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.#config.ollamaModel,
              messages: [{ role: 'user', content: transcript.text }],
              stream: false,
            }),
            signal: modelAbort.signal,
            redirect: 'error',
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          }), modelAbort.signal, 'OLLAMA_REQUEST_ABORTED');
        } catch (error) {
          if (record.abortController.signal.aborted) this.#assertActive(record, attempt);
          if (deadlineReached) throw failure('OLLAMA_DEADLINE_EXCEEDED');
          if (error instanceof Error && error.message.startsWith('OLLAMA_')) throw error;
          throw failure('OLLAMA_REQUEST_FAILED');
        }
        this.#assertActive(record, attempt);
        if (response.redirected || response.type === 'opaqueredirect') {
          throw failure('OLLAMA_REDIRECT_REJECTED');
        }
        if (response.status < 200 || response.status >= 300) {
          throw failure('OLLAMA_HTTP_REJECTED');
        }
        let payload: unknown;
        try {
          payload = await waitWithAbort(
            response.json(),
            modelAbort.signal,
            'OLLAMA_REQUEST_ABORTED',
          );
        } catch {
          if (record.abortController.signal.aborted) this.#assertActive(record, attempt);
          if (deadlineReached) throw failure('OLLAMA_DEADLINE_EXCEEDED');
          throw failure('OLLAMA_RESPONSE_MALFORMED');
        }
        this.#assertActive(record, attempt);
        const text = assistantText(payload);
        attempt.acceptModelResult({
          requestEventId,
          text,
          model: this.#config.ollamaModel,
          latencyMs: Math.max(0, this.#now() - modelStartedAt),
          observedAt: this.#now(),
        });
        this.#assertActive(record, attempt);
        record.state = 'RESULT_COMMITTED';
        record.state = 'DELIVERY_IN_FLIGHT';
        await waitWithAbort(
          attempt.sendDirectedChat(text, attempt.originatingParticipantIdentity),
          record.abortController.signal,
          'DIRECT_LOOP_ATTEMPT_STOPPED',
        );
        this.#assertActive(record, attempt);
        record.state = 'SUCCESS';
        return 'success';
      } finally {
        deadline.cancel();
        record.abortController.signal.removeEventListener('abort', onStop);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DIRECT_LOOP_FAILED';
      this.#makeTerminal(record, code, true);
      throw error instanceof Error ? error : failure(code);
    }
  }

  #assertAttempt(attempt: DirectLoopAttempt): void {
    if (
      attempt === null ||
      typeof attempt !== 'object' ||
      attempt.token === null ||
      typeof attempt.token !== 'object' ||
      typeof attempt.createStream !== 'function' ||
      typeof attempt.isValid !== 'function' ||
      typeof attempt.prepareSource !== 'function' ||
      typeof attempt.acceptTranscriptAndModelRequested !== 'function' ||
      typeof attempt.acceptModelResult !== 'function' ||
      typeof attempt.sendDirectedChat !== 'function'
    ) {
      throw failure('DIRECT_LOOP_ATTEMPT_INVALID');
    }
    assertKey(attempt.key);
    if (attempt.originatingParticipantIdentity !== attempt.key.publisher_identity) {
      throw failure('DIRECT_LOOP_ATTEMPT_INVALID');
    }
  }

  #isActive(record: AttemptRecord, attempt: DirectLoopAttempt, token: object): boolean {
    if (
      token !== record.token ||
      record.cleaned ||
      record.tombstoned ||
      record.stopped ||
      record.state === 'TERMINAL_FAILURE' ||
      record.state === 'SUCCESS' ||
      this.#records.get(record.key.session_id) !== record ||
      this.#stoppedSessions.has(record.key.session_id)
    ) {
      return false;
    }
    try {
      return attempt.isValid(token) === true;
    } catch {
      return false;
    }
  }

  #assertActive(record: AttemptRecord, attempt: DirectLoopAttempt): void {
    if (record.cleaned) throw failure('DIRECT_LOOP_AFTER_VERIFIED_CLEANUP');
    if (record.stopped || this.#stoppedSessions.has(record.key.session_id)) {
      throw failure('DIRECT_LOOP_ATTEMPT_STOPPED');
    }
    if (!this.#isActive(record, attempt, record.token)) {
      throw failure(
        record.error === 'DIRECT_LOOP_ATTEMPT_CONFLICT'
          ? record.error
          : 'DIRECT_LOOP_ATTEMPT_INVALIDATED',
      );
    }
  }

  #makeTerminal(record: AttemptRecord, code: string, tombstone: boolean): void {
    if (record.cleaned) return;
    record.state = 'TERMINAL_FAILURE';
    record.error ??= code;
    record.tombstoned ||= tombstone;
    record.abortController.abort();
  }
}
