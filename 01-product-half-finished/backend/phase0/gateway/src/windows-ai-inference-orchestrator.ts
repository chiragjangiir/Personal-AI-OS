import {
  compileWindowsAiContext,
  WindowsAiContextCompilerError,
  type CompiledWindowsAiContext,
  type WindowsAiContextCompilerInput,
  type WindowsAiContextDegradedReason,
  type WindowsAiReplayManifestEntry,
  type WindowsAiTokenEstimator,
} from './windows-ai-context-compiler.ts';
import {
  QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS,
  type Qwen38ChatRequest,
  type Qwen38ProviderAvailability,
  type Qwen38StreamEvent,
} from './qwen38-provider-adapter.ts';

/**
 * Windows-local dependency boundary. The concrete Qwen adapter satisfies this
 * shape, while unit tests can provide a deterministic in-memory implementation.
 * This interface is intentionally not a transport or shared result contract.
 */
export interface WindowsAiInferenceProviderPort {
  readonly checkAvailability: (signal?: AbortSignal) => Promise<Qwen38ProviderAvailability>;
  readonly stream: (
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
  ) => AsyncGenerator<Qwen38StreamEvent>;
}

export interface WindowsAiInferenceRunInput {
  readonly context: WindowsAiContextCompilerInput;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface WindowsAiInferenceDependencies {
  readonly provider: WindowsAiInferenceProviderPort;
  readonly estimator: WindowsAiTokenEstimator;
}

export type WindowsAiInferenceErrorCode =
  | 'CONTEXT_INVALID'
  | 'PROVIDER_BUSY'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_BINDING_INVALID'
  | 'REQUEST_INVALID'
  | 'PROVIDER_STREAM_INVALID'
  | 'PROVIDER_CLOSED'
  | 'PROVIDER_FAILURE'
  | 'CONSUMER_FAILURE';

export interface WindowsAiInferenceErrorInfo {
  readonly code: WindowsAiInferenceErrorCode;
  readonly retryable: boolean;
}

export class WindowsAiInferenceError extends Error {
  readonly code: WindowsAiInferenceErrorCode;
  readonly retryable: boolean;

  constructor(code: WindowsAiInferenceErrorCode, retryable: boolean) {
    super(code);
    this.name = 'WindowsAiInferenceError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type WindowsAiInferenceEvent =
  | Readonly<{ kind: 'delta'; text: string }>
  | Readonly<{ kind: 'final'; text: string; finishReason: 'stop' }>
  | Readonly<{ kind: 'error'; error: WindowsAiInferenceErrorInfo }>
  | Readonly<{
    kind: 'cancelled';
    reason: 'caller' | 'compile' | 'provider' | 'consumer';
  }>;

/** Awaiting the sink is the only output buffer: no internal event queue exists. */
export type WindowsAiInferenceEventSink = (
  event: WindowsAiInferenceEvent,
  signal: AbortSignal,
) => void | PromiseLike<void>;

export type WindowsAiInferencePhase =
  | 'created'
  | 'compiling'
  | 'compiled'
  | 'checking_readiness'
  | 'ready'
  | 'streaming'
  | 'terminal_final'
  | 'terminal_error'
  | 'terminal_cancelled'
  | 'fenced';

export interface WindowsAiInferenceManifest {
  readonly phases: readonly WindowsAiInferencePhase[];
  readonly replayManifest: readonly WindowsAiReplayManifestEntry[];
  readonly degradedReasons: readonly WindowsAiContextDegradedReason[];
  readonly provider: Readonly<{
    readonly readiness: 'not_checked' | 'ready' | 'busy' | 'failed';
    readonly loaded: boolean | null;
    readonly activeRequests: number | null;
  }>;
  readonly events: Readonly<{
    readonly delta: number;
    readonly final: number;
    readonly error: number;
    readonly cancelled: number;
    readonly lateDropped: number;
  }>;
  readonly terminal: 'final' | 'error' | 'cancelled';
  readonly error: WindowsAiInferenceErrorInfo | null;
}

export interface WindowsAiInferenceOutcome {
  readonly terminal: 'final' | 'error' | 'cancelled';
  readonly manifest: WindowsAiInferenceManifest;
}

export interface WindowsAiInferenceOrchestrator {
  readonly run: (
    input: WindowsAiInferenceRunInput,
    sink: WindowsAiInferenceEventSink,
  ) => Promise<WindowsAiInferenceOutcome>;
}

type TerminalKind = WindowsAiInferenceOutcome['terminal'];
type ErrorStage = 'admission' | 'compile' | 'readiness' | 'stream';

const MAX_CONCURRENT_REQUESTS = QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS;
const CONTEXT_ABORT = 'WINDOWS_AI_CONTEXT_ABORTED';
const PROVIDER_ABORT = 'QWEN38_PROVIDER_ABORTED';
const PROVIDER_BUSY = 'QWEN38_PROVIDER_BUSY';
const PROVIDER_CLOSED = 'QWEN38_PROVIDER_CLOSED';

function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof WindowsAiContextCompilerError) return error.code;
  if (error instanceof WindowsAiInferenceError) return error.code;
  if (error !== null && typeof error === 'object' &&
    typeof (error as { readonly code?: unknown }).code === 'string') {
    return (error as { readonly code: string }).code;
  }
  return undefined;
}

function isAbortException(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function mapProviderFailure(code: string | undefined): WindowsAiInferenceErrorInfo {
  switch (code) {
    case 'PROVIDER_BUSY':
    case PROVIDER_BUSY:
      return Object.freeze({ code: 'PROVIDER_BUSY', retryable: true });
    case 'PROVIDER_UNAVAILABLE':
    case 'QWEN38_PROVIDER_NOT_READY':
    case 'QWEN38_PROVIDER_HTTP_REJECTED':
      return Object.freeze({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    case 'PROVIDER_CLOSED':
    case PROVIDER_CLOSED:
      return Object.freeze({ code: 'PROVIDER_CLOSED', retryable: false });
    case 'REQUEST_INVALID':
    case 'QWEN38_PROVIDER_REQUEST_INVALID':
    case 'QWEN38_PROVIDER_REQUEST_TOO_LARGE':
      return Object.freeze({ code: 'REQUEST_INVALID', retryable: false });
    case 'PROVIDER_STREAM_INVALID':
    case 'QWEN38_PROVIDER_STREAM_INVALID':
    case 'QWEN38_PROVIDER_RESPONSE_TOO_LARGE':
      return Object.freeze({ code: 'PROVIDER_STREAM_INVALID', retryable: false });
    case 'PROVIDER_BINDING_INVALID':
    case 'QWEN38_PROVIDER_MODELS_INVALID':
    case 'QWEN38_PROVIDER_MODEL_UNAVAILABLE':
    case 'QWEN38_PROVIDER_CONTEXT_DRIFT':
    case 'QWEN38_PROVIDER_HEALTH_INVALID':
    case 'QWEN38_PROVIDER_MODEL_DRIFT':
    case 'QWEN38_PROVIDER_BACKEND_BINDING_INVALID':
    case 'QWEN38_PROVIDER_ROUTE_INVALID':
    case 'QWEN38_PROVIDER_CONCURRENCY_INVALID':
      return Object.freeze({ code: 'PROVIDER_BINDING_INVALID', retryable: false });
    default:
      return Object.freeze({ code: 'PROVIDER_FAILURE', retryable: false });
  }
}

function mapFailure(
  error: unknown,
  stage: ErrorStage,
  callerSignal: AbortSignal | undefined,
  runSignal: AbortSignal,
): Readonly<{
  readonly terminal: 'error' | 'cancelled';
  readonly reason?: 'caller' | 'compile' | 'provider';
  readonly error?: WindowsAiInferenceErrorInfo;
}> {
  const code = errorCodeOf(error);
  if (callerSignal?.aborted === true) {
    return Object.freeze({ terminal: 'cancelled', reason: 'caller' });
  }
  if (code === CONTEXT_ABORT) {
    return Object.freeze({ terminal: 'cancelled', reason: stage === 'compile' ? 'compile' : 'provider' });
  }
  if (code === PROVIDER_ABORT || isAbortException(error) || runSignal.aborted) {
    return Object.freeze({ terminal: 'cancelled', reason: 'provider' });
  }
  if (stage === 'compile') {
    return Object.freeze({
      terminal: 'error',
      error: Object.freeze({
        code: 'CONTEXT_INVALID',
        retryable: false,
      }),
    });
  }
  return Object.freeze({ terminal: 'error', error: mapProviderFailure(code) });
}

function assertAvailability(value: Qwen38ProviderAvailability): void {
  if (value === null || typeof value !== 'object' || value.ready !== true ||
    typeof value.loaded !== 'boolean' || !Number.isSafeInteger(value.activeRequests) ||
    value.activeRequests < 0 || value.activeRequests > MAX_CONCURRENT_REQUESTS) {
    throw new WindowsAiInferenceError('PROVIDER_BINDING_INVALID', false);
  }
}

function isValidDelta(value: Qwen38StreamEvent): value is Readonly<{ kind: 'delta'; text: string }> {
  return value !== null && typeof value === 'object' && value.kind === 'delta' &&
    typeof value.text === 'string' && value.text.length > 0;
}

function isValidFinal(value: Qwen38StreamEvent): value is Readonly<{
  kind: 'final'; text: string; finishReason: 'stop';
}> {
  return value !== null && typeof value === 'object' && value.kind === 'final' &&
    value.finishReason === 'stop' && typeof value.text === 'string' &&
    value.text.length > 0 && value.text === value.text.trim();
}

function makeErrorInfo(error: WindowsAiInferenceErrorInfo): WindowsAiInferenceErrorInfo {
  return Object.freeze({ code: error.code, retryable: error.retryable });
}

function makeManifest(
  phases: readonly WindowsAiInferencePhase[],
  replayManifest: readonly WindowsAiReplayManifestEntry[],
  degradedReasons: readonly WindowsAiContextDegradedReason[],
  provider: Readonly<{
    readiness: 'not_checked' | 'ready' | 'busy' | 'failed';
    loaded: boolean | null;
    activeRequests: number | null;
  }>,
  events: Readonly<{
    delta: number;
    final: number;
    error: number;
    cancelled: number;
    lateDropped: number;
  }>,
  terminal: TerminalKind,
  error: WindowsAiInferenceErrorInfo | null,
): WindowsAiInferenceManifest {
  return Object.freeze({
    phases: Object.freeze([...phases]),
    replayManifest: Object.freeze([...replayManifest]),
    degradedReasons: Object.freeze([...degradedReasons]),
    provider: Object.freeze({ ...provider }),
    events: Object.freeze({ ...events }),
    terminal,
    error: error === null ? null : makeErrorInfo(error),
  });
}

class ConsumerFailure extends Error {
  constructor() {
    super('CONSUMER_FAILURE');
    this.name = 'ConsumerFailure';
  }
}

class ConsumerCancellation extends Error {
  constructor() {
    super('CONSUMER_CANCELLED');
    this.name = 'ConsumerCancellation';
  }
}

function isSinkCancellation(error: unknown): boolean {
  const code = errorCodeOf(error);
  return isAbortException(error) || code === 'CONSUMER_ABORTED' || code === 'ABORT_ERR';
}

export function createWindowsAiInferenceOrchestrator(
  dependencies: WindowsAiInferenceDependencies,
): WindowsAiInferenceOrchestrator {
  return Object.freeze({
    run: (input: WindowsAiInferenceRunInput, sink: WindowsAiInferenceEventSink) =>
      runInference(dependencies, input, sink),
  });
}

async function runInference(
  dependencies: WindowsAiInferenceDependencies,
  input: WindowsAiInferenceRunInput,
  sink: WindowsAiInferenceEventSink,
): Promise<WindowsAiInferenceOutcome> {
  const phases: WindowsAiInferencePhase[] = ['created'];
  const events = { delta: 0, final: 0, error: 0, cancelled: 0, lateDropped: 0 };
  const provider: {
    readiness: 'not_checked' | 'ready' | 'busy' | 'failed';
    loaded: boolean | null;
    activeRequests: number | null;
  } = { readiness: 'not_checked', loaded: null, activeRequests: null };
  const localAbort = new AbortController();
  const callerSignal = input?.signal;
  const runSignal = callerSignal === undefined
    ? localAbort.signal
    : AbortSignal.any([callerSignal, localAbort.signal]);
  let replayManifest: readonly WindowsAiReplayManifestEntry[] = [];
  let degradedReasons: readonly WindowsAiContextDegradedReason[] = [];
  let terminalAttempted = false;
  let consumerFailed = false;
  let consumerCancelled: 'caller' | 'consumer' | undefined;
  let terminal: TerminalKind = 'error';
  let terminalError: WindowsAiInferenceErrorInfo | null = null;

  const phase = (value: WindowsAiInferencePhase): void => { phases.push(value); };

  const outcome = (): WindowsAiInferenceOutcome => Object.freeze({
    terminal,
    manifest: makeManifest(
      phases,
      replayManifest,
      degradedReasons,
      provider,
      events,
      terminal,
      terminalError,
    ),
  });

  const deliver = async (event: WindowsAiInferenceEvent): Promise<void> => {
    if (consumerFailed) return;
    try {
      await sink(event, runSignal);
    } catch (error) {
      localAbort.abort();
      if (callerSignal?.aborted === true) {
        consumerCancelled = 'caller';
        throw new ConsumerCancellation();
      }
      if (isSinkCancellation(error)) {
        consumerCancelled = 'consumer';
        throw new ConsumerCancellation();
      }
      consumerFailed = true;
      throw new ConsumerFailure();
    }
  };

  const deliverTerminal = async (
    kind: TerminalKind,
    event: WindowsAiInferenceEvent,
    error: WindowsAiInferenceErrorInfo | null,
  ): Promise<void> => {
    if (terminalAttempted) return;
    terminalAttempted = true;
    try {
      await sink(event, runSignal);
    } catch (sinkError) {
      localAbort.abort();
      if (callerSignal?.aborted === true || isSinkCancellation(sinkError)) {
        terminal = 'cancelled';
        terminalError = null;
        consumerCancelled = callerSignal?.aborted === true ? 'caller' : 'consumer';
        phase('terminal_cancelled');
      } else {
        consumerFailed = true;
        terminal = 'error';
        terminalError = Object.freeze({ code: 'CONSUMER_FAILURE', retryable: false });
        phase('terminal_error');
      }
      phase('fenced');
      return;
    }
    terminal = kind;
    terminalError = error;
    phase(kind === 'final' ? 'terminal_final' : kind === 'cancelled' ? 'terminal_cancelled' : 'terminal_error');
    phase('fenced');
    if (event.kind === 'final') events.final += 1;
    else if (event.kind === 'error') events.error += 1;
    else if (event.kind === 'cancelled') events.cancelled += 1;
  };

  const finishFailure = async (
    failure: Readonly<{
      terminal: 'error' | 'cancelled';
      reason?: 'caller' | 'compile' | 'provider';
      error?: WindowsAiInferenceErrorInfo;
    }>,
  ): Promise<void> => {
    if (failure.terminal === 'cancelled') {
      const reason = failure.reason ?? 'provider';
      await deliverTerminal('cancelled', Object.freeze({ kind: 'cancelled', reason }), null);
      return;
    }
    const error = failure.error ?? Object.freeze({ code: 'PROVIDER_FAILURE', retryable: false });
    await deliverTerminal('error', Object.freeze({ kind: 'error', error }), error);
  };

  if (typeof sink !== 'function') {
    terminal = 'error';
    terminalError = Object.freeze({ code: 'CONSUMER_FAILURE', retryable: false });
    phase('terminal_error');
    phase('fenced');
    return outcome();
  }

  if (callerSignal?.aborted === true) {
    await deliverTerminal('cancelled', Object.freeze({ kind: 'cancelled', reason: 'caller' }), null);
    return outcome();
  }

  try {
    phase('compiling');
    const compiled: CompiledWindowsAiContext = compileWindowsAiContext(
      input.context,
      dependencies.estimator,
      runSignal,
    );
    replayManifest = compiled.replayManifest;
    degradedReasons = compiled.degradedReasons;
    phase('compiled');
    if (runSignal.aborted) throw new WindowsAiInferenceError('PROVIDER_FAILURE', false);

    phase('checking_readiness');
    const availability = await dependencies.provider.checkAvailability(runSignal);
    assertAvailability(availability);
    provider.readiness = 'ready';
    provider.loaded = availability.loaded;
    provider.activeRequests = availability.activeRequests;
    if (availability.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      provider.readiness = 'busy';
      throw new WindowsAiInferenceError('PROVIDER_BUSY', true);
    }
    phase('ready');
    if (runSignal.aborted) throw new WindowsAiInferenceError('PROVIDER_FAILURE', false);

    const providerInput: Qwen38ChatRequest = input.temperature === undefined
      ? { messages: compiled.messages, maxTokens: input.context.budget.reservedOutputTokens }
      : {
        messages: compiled.messages,
        maxTokens: input.context.budget.reservedOutputTokens,
        temperature: input.temperature,
      };
    phase('streaming');
    let finalSeen = false;
    for await (const event of dependencies.provider.stream(providerInput, runSignal)) {
      if (runSignal.aborted) {
        events.lateDropped += 1;
        throw new WindowsAiInferenceError('PROVIDER_FAILURE', false);
      }
      if (finalSeen || terminalAttempted) {
        events.lateDropped += 1;
        continue;
      }
      if (isValidDelta(event)) {
        await deliver(Object.freeze({ kind: 'delta', text: event.text }));
        events.delta += 1;
        continue;
      }
      if (isValidFinal(event)) {
        finalSeen = true;
        await deliverTerminal(
          'final',
          Object.freeze({ kind: 'final', text: event.text, finishReason: 'stop' }),
          null,
        );
        break;
      }
      throw new WindowsAiInferenceError('PROVIDER_STREAM_INVALID', false);
    }
    if (!finalSeen && !terminalAttempted) {
      throw new WindowsAiInferenceError('PROVIDER_STREAM_INVALID', false);
    }
  } catch (error) {
    if (terminalAttempted) return outcome();
    if (consumerCancelled !== undefined || error instanceof ConsumerCancellation) {
      terminal = 'cancelled';
      terminalError = null;
      phase('terminal_cancelled');
      phase('fenced');
      return outcome();
    }
    if (consumerFailed || error instanceof ConsumerFailure) {
      terminal = 'error';
      terminalError = Object.freeze({ code: 'CONSUMER_FAILURE', retryable: false });
      phase('terminal_error');
      phase('fenced');
      return outcome();
    }
    const stage: ErrorStage = phases.includes('streaming')
      ? 'stream'
      : phases.includes('checking_readiness')
        ? 'readiness'
        : phases.includes('compiling')
          ? 'compile'
          : 'admission';
    const failure = mapFailure(error, stage, callerSignal, runSignal);
    if (failure.terminal === 'error' && failure.error?.code === 'PROVIDER_BUSY') {
      provider.readiness = 'busy';
    } else if (stage !== 'admission' && provider.readiness === 'not_checked') {
      provider.readiness = 'failed';
    }
    await finishFailure(failure);
  } finally {
    localAbort.abort();
  }
  return outcome();
}
