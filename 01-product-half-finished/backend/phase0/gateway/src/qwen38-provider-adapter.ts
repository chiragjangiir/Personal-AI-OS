export const QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS = 3 as const;
export const QWEN38_PROVIDER_MAX_OUTPUT_TOKENS = 32_768 as const;

export type Qwen38ProviderAvailabilityMode = 'supervisor-health' | 'openai-models';

export interface Qwen38LocalProviderProfile {
  /** Canonical loopback origin only; no path, query, fragment, or credentials. */
  readonly origin: string;
  /** Exact model id returned by the provider's /v1/models endpoint. */
  readonly model: string;
  readonly contextTokens: number;
  readonly availabilityMode: Qwen38ProviderAvailabilityMode;
  /** Capabilities used by the runtime selector (for example completion and vision). */
  readonly capabilities?: readonly string[];
  /** Lower values win; omitted priority preserves candidate-array order. */
  readonly priority?: number;
  /** Supervisor-owned backend port, when the health payload exposes one. */
  readonly supervisorBackendPort?: number;
}

const QWEN38_NVFP4_LOCAL_PROVIDER_PROFILE = Object.freeze({
  origin: 'http://127.0.0.1:11482',
  model: 'qwen38-gittensor-nvfp4-nextn-128k-stable',
  contextTokens: 131_072,
  availabilityMode: 'supervisor-health' as const,
  capabilities: Object.freeze(['completion', 'vision']),
  priority: 100,
  supervisorBackendPort: 11_582,
});

const QWEN38_ORCAROUTER_LOCAL_PROVIDER_PROFILE = Object.freeze({
  origin: 'http://127.0.0.1:11601',
  model: 'qwen38-orcarouter-uncensored-q6-262k-mtp4',
  contextTokens: 262_144,
  availabilityMode: 'openai-models' as const,
  capabilities: Object.freeze(['completion', 'vision']),
  priority: 10,
});

const QWEN38_ORCAROUTER_CANARY_LOCAL_PROVIDER_PROFILE = Object.freeze({
  origin: 'http://127.0.0.1:16001',
  model: 'qwen38-orcarouter-uncensored-q6-262k-mtp4',
  contextTokens: 262_144,
  availabilityMode: 'openai-models' as const,
  capabilities: Object.freeze(['completion', 'vision']),
  priority: 10,
});

const QWEN38_ORCAROUTER_SUPERVISED_LOCAL_PROVIDER_PROFILE = Object.freeze({
  origin: 'http://127.0.0.1:16001',
  model: 'qwen38-orcarouter-uncensored-q6-262k-mtp4',
  contextTokens: 262_144,
  availabilityMode: 'supervisor-health' as const,
  capabilities: Object.freeze(['completion', 'vision']),
  priority: 10,
  supervisorBackendPort: 15_811,
});

/** Example/fixture profiles. Product selection receives its own runtime list. */
export const QWEN38_NVFP4_PROFILE: Qwen38LocalProviderProfile = QWEN38_NVFP4_LOCAL_PROVIDER_PROFILE;
export const QWEN38_ORCAROUTER_PROFILE: Qwen38LocalProviderProfile = QWEN38_ORCAROUTER_LOCAL_PROVIDER_PROFILE;
/** Debug-canary-only ORCA profile; never add this to the global selector list. */
export const QWEN38_ORCAROUTER_CANARY_PROFILE: Qwen38LocalProviderProfile =
  QWEN38_ORCAROUTER_CANARY_LOCAL_PROVIDER_PROFILE;
export const QWEN38_ORCAROUTER_SUPERVISED_PROFILE: Qwen38LocalProviderProfile =
  QWEN38_ORCAROUTER_SUPERVISED_LOCAL_PROVIDER_PROFILE;
export const QWEN38_LOCAL_PROVIDER_PROFILES: readonly Qwen38LocalProviderProfile[] = Object.freeze([
  QWEN38_NVFP4_PROFILE, QWEN38_ORCAROUTER_PROFILE,
]);

// Legacy names remain exported for source compatibility only. No adapter or
// runtime path uses these values as an implicit profile.
export const QWEN38_PROVIDER_ORIGIN = QWEN38_NVFP4_PROFILE.origin;
export const QWEN38_PROVIDER_ENDPOINT = `${QWEN38_PROVIDER_ORIGIN}/v1`;
export const QWEN38_PROVIDER_MODEL = QWEN38_NVFP4_PROFILE.model;
export const QWEN38_PROVIDER_CONTEXT_TOKENS = QWEN38_NVFP4_PROFILE.contextTokens;

const QWEN38_PROVIDER_MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const QWEN38_PROVIDER_MAX_BUFFERED_RESPONSE_BYTES = 8 * 1024 * 1024;

export class Qwen38ProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'Qwen38ProviderError';
    this.code = code;
  }
}

function profileFailure(): Qwen38ProviderError {
  return new Qwen38ProviderError('QWEN38_PROVIDER_PROFILE_INVALID');
}

/**
 * Validate and freeze a profile at the boundary. This is intentionally a
 * data-only operation: it never reads environment state and never probes a
 * provider, so a selected session cannot drift after construction.
 */
export function freezeQwen38LocalProviderProfile(
  profile: Qwen38LocalProviderProfile,
): Qwen38LocalProviderProfile {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) throw profileFailure();
  let parsed: URL;
  try { parsed = new URL(profile.origin); }
  catch { throw profileFailure(); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
    !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
    parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' ||
    parsed.search !== '' || parsed.hash !== '' || parsed.origin !== profile.origin) {
    throw profileFailure();
  }
  if (typeof profile.model !== 'string' || profile.model.length === 0 ||
    !Number.isSafeInteger(profile.contextTokens) || profile.contextTokens < 1 ||
    (profile.availabilityMode !== 'supervisor-health' && profile.availabilityMode !== 'openai-models')) {
    throw profileFailure();
  }
  if (profile.capabilities !== undefined && !Array.isArray(profile.capabilities)) throw profileFailure();
  const capabilities = profile.capabilities === undefined ? [] : [...profile.capabilities];
  if (capabilities.some((capability) => typeof capability !== 'string' || capability.length === 0) ||
    new Set(capabilities).size !== capabilities.length) throw profileFailure();
  if (profile.priority !== undefined &&
    (!Number.isSafeInteger(profile.priority) || profile.priority < 0)) throw profileFailure();
  if (profile.supervisorBackendPort !== undefined &&
    (!Number.isSafeInteger(profile.supervisorBackendPort) || profile.supervisorBackendPort < 1 ||
      profile.supervisorBackendPort > 65_535)) throw profileFailure();
  return Object.freeze({
    origin: profile.origin,
    model: profile.model,
    contextTokens: profile.contextTokens,
    availabilityMode: profile.availabilityMode,
    capabilities: Object.freeze(capabilities),
    ...(profile.priority === undefined ? {} : { priority: profile.priority }),
    ...(profile.supervisorBackendPort === undefined ? {} : { supervisorBackendPort: profile.supervisorBackendPort }),
  });
}

export interface Qwen38ProviderSelectionRequirements {
  readonly requiredCapabilities?: readonly string[];
  readonly minContextTokens?: number;
}

export type Qwen38ProviderAvailabilityProbe = (
  profile: Qwen38LocalProviderProfile,
) => boolean | Qwen38ProviderAvailability | Promise<boolean | Qwen38ProviderAvailability>;

/**
 * Select one available local profile for one session. Explicit priorities are
 * ordered first; equal explicit priorities are rejected as ambiguous. Profiles
 * with no priority use their stable candidate-array order.
 */
export async function selectQwen38LocalProviderProfile(
  candidates: readonly Qwen38LocalProviderProfile[],
  requirements: Qwen38ProviderSelectionRequirements = {},
  probe: Qwen38ProviderAvailabilityProbe = () => true,
): Promise<Qwen38LocalProviderProfile> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_EMPTY');
  }
  if (requirements.minContextTokens !== undefined &&
    (!Number.isSafeInteger(requirements.minContextTokens) || requirements.minContextTokens < 1)) {
    throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_REQUIREMENTS_INVALID');
  }
  if (requirements.requiredCapabilities !== undefined && !Array.isArray(requirements.requiredCapabilities)) {
    throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_REQUIREMENTS_INVALID');
  }
  const requiredCapabilities = requirements.requiredCapabilities === undefined
    ? [] : [...requirements.requiredCapabilities];
  if (requiredCapabilities.some((capability) => typeof capability !== 'string' || capability.length === 0)) {
    throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_REQUIREMENTS_INVALID');
  }
  const normalized = candidates.map((candidate) => freezeQwen38LocalProviderProfile(candidate));
  const identities = new Set<string>();
  for (const profile of normalized) {
    const identity = `${profile.origin}\u0000${profile.model}`;
    if (identities.has(identity)) throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_AMBIGUOUS');
    identities.add(identity);
  }
  const eligible: Array<Readonly<{ profile: Qwen38LocalProviderProfile; index: number }>> = [];
  for (const [index, profile] of normalized.entries()) {
    const capabilities = profile.capabilities ?? [];
    if ((requirements.minContextTokens !== undefined && profile.contextTokens < requirements.minContextTokens) ||
      requiredCapabilities.some((capability) => !capabilities.includes(capability))) continue;
    let available = false;
    try {
      const result = await probe(profile);
      available = result === true || (result !== false && result.ready === true);
    } catch { available = false; }
    if (available) eligible.push(Object.freeze({ profile, index }));
  }
  if (eligible.length === 0) throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_UNAVAILABLE');
  const sorted = [...eligible].sort((left, right) => {
    const leftPriority = left.profile.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.profile.priority ?? Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || left.index - right.index;
  });
  const first = sorted[0]!;
  if (first.profile.priority !== undefined && sorted[1]?.profile.priority === first.profile.priority) {
    throw new Qwen38ProviderError('QWEN38_PROVIDER_SELECTION_AMBIGUOUS');
  }
  return first.profile;
}

function providerEndpoint(profile: Qwen38LocalProviderProfile): string {
  return `${profile.origin}/v1`;
}

export interface Qwen38ProviderConcurrencyGate {
  readonly active: number;
  acquire(): () => void;
}

export function createQwen38ProviderConcurrencyGate(
  maximum = QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS,
): Qwen38ProviderConcurrencyGate {
  if (maximum !== QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS) {
    throw new Qwen38ProviderError('QWEN38_PROVIDER_CONCURRENCY_INVALID');
  }
  let active = 0;
  return Object.freeze({
    get active() { return active; },
    acquire(): () => void {
      if (active >= maximum) throw new Qwen38ProviderError('QWEN38_PROVIDER_BUSY');
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  });
}

const SHARED_CONCURRENCY_GATE = createQwen38ProviderConcurrencyGate();

export type Qwen38ChatRole = 'system' | 'user' | 'assistant';

export interface Qwen38ChatMessage {
  readonly role: Qwen38ChatRole;
  readonly content: unknown;
}

export interface Qwen38ChatRequest {
  readonly messages: readonly Qwen38ChatMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
}

export type Qwen38StreamEvent =
  | Readonly<{ kind: 'delta'; text: string }>
  | Readonly<{ kind: 'final'; text: string; finishReason: 'stop' }>;

export interface Qwen38ProviderAvailability {
  readonly ready: true;
  readonly loaded: boolean;
  readonly activeRequests: number;
}

export interface Qwen38ProviderAdapterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly concurrencyGate?: Qwen38ProviderConcurrencyGate;
}

function providerFailure(code: string): Qwen38ProviderError {
  return new Qwen38ProviderError(code);
}

function assertJsonResponse(response: Response): void {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!response.ok || response.status !== 200 || !contentType.startsWith('application/json')) {
    throw providerFailure('QWEN38_PROVIDER_NOT_READY');
  }
}

function assertModelsPayload(payload: unknown, profile: Qwen38LocalProviderProfile): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerFailure('QWEN38_PROVIDER_MODELS_INVALID');
  }
  const data = (payload as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) throw providerFailure('QWEN38_PROVIDER_MODELS_INVALID');
  const matches = data.filter((candidate) => candidate !== null && typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (candidate as { readonly id?: unknown }).id === profile.model);
  if (matches.length !== 1) throw providerFailure('QWEN38_PROVIDER_MODEL_UNAVAILABLE');
  const contextWindow = (matches[0] as { readonly context_window?: unknown }).context_window;
  if (contextWindow !== undefined && contextWindow !== profile.contextTokens) {
    throw providerFailure('QWEN38_PROVIDER_CONTEXT_DRIFT');
  }
}

function assertHealthPayload(
  payload: unknown,
  profile: Qwen38LocalProviderProfile,
): Qwen38ProviderAvailability {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerFailure('QWEN38_PROVIDER_HEALTH_INVALID');
  }
  const value = payload as Record<string, unknown>;
  if (value.status !== 'ok' || value.service !== 'qwen-model-supervisor' ||
    !Number.isSafeInteger(value.active_requests) || Number(value.active_requests) < 0 ||
    Number(value.active_requests) > QWEN38_PROVIDER_MAX_CONCURRENT_REQUESTS ||
    typeof value.owned_process !== 'boolean' || typeof value.last_error !== 'string' ||
    (value.loaded_model !== null && typeof value.loaded_model !== 'string') ||
    (value.loading_model !== null && typeof value.loading_model !== 'string') ||
    (value.backend_port !== null && !Number.isSafeInteger(value.backend_port))) {
    throw providerFailure('QWEN38_PROVIDER_HEALTH_INVALID');
  }
  if ((value.loaded_model !== null && value.loaded_model !== profile.model) ||
    (value.loading_model !== null && value.loading_model !== profile.model)) {
    throw providerFailure('QWEN38_PROVIDER_MODEL_DRIFT');
  }
  if (profile.supervisorBackendPort !== undefined &&
    (value.loaded_model === profile.model || value.loading_model === profile.model) &&
    value.backend_port !== profile.supervisorBackendPort) {
    throw providerFailure('QWEN38_PROVIDER_BACKEND_BINDING_INVALID');
  }
  return Object.freeze({
    ready: true,
    loaded: value.loaded_model === profile.model,
    activeRequests: Number(value.active_requests),
  });
}

function validateRequest(
  input: Qwen38ChatRequest,
  profile: Qwen38LocalProviderProfile,
): Readonly<Record<string, unknown>> {
  if (!Array.isArray(input.messages) || input.messages.length < 1 ||
    !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 ||
    input.maxTokens > QWEN38_PROVIDER_MAX_OUTPUT_TOKENS ||
    (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0))) {
    throw providerFailure('QWEN38_PROVIDER_REQUEST_INVALID');
  }
  for (const message of input.messages) {
    if (message === null || typeof message !== 'object' ||
      !['system', 'user', 'assistant'].includes(message.role) || message.content === undefined) {
      throw providerFailure('QWEN38_PROVIDER_REQUEST_INVALID');
    }
  }
  const request = Object.freeze({
    model: profile.model,
    reasoning_effort: 'none',
    stream: true,
    chat_template_kwargs: Object.freeze({ enable_thinking: false }),
    temperature: input.temperature ?? 0,
    max_tokens: input.maxTokens,
    messages: input.messages,
  });
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(request), 'utf8'); }
  catch { throw providerFailure('QWEN38_PROVIDER_REQUEST_INVALID'); }
  if (bytes > QWEN38_PROVIDER_MAX_REQUEST_BYTES) {
    throw providerFailure('QWEN38_PROVIDER_REQUEST_TOO_LARGE');
  }
  return request;
}

function abortFailure(): Qwen38ProviderError {
  return providerFailure('QWEN38_PROVIDER_ABORTED');
}

function combinedSignal(external: AbortSignal | undefined, owned: AbortSignal): AbortSignal {
  if (external?.aborted === true || owned.aborted) throw abortFailure();
  return external === undefined ? owned : AbortSignal.any([external, owned]);
}

type ParsedSseEvent =
  | Readonly<{ kind: 'delta'; text: string; finish: boolean }>
  | Readonly<{ kind: 'done' }>;

function parseSseFrame(frame: string): ParsedSseEvent | undefined {
  const data = frame.split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /u, ''))
    .join('\n');
  if (data === '') return undefined;
  if (data === '[DONE]') return Object.freeze({ kind: 'done' });
  let payload: unknown;
  try { payload = JSON.parse(data); }
  catch { throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID'); }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
  }
  const choices = (payload as { readonly choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1 || choices[0] === null ||
    typeof choices[0] !== 'object' || Array.isArray(choices[0])) {
    throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
  }
  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta;
  if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) {
    throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
  }
  const typedDelta = delta as Record<string, unknown>;
  if ((typedDelta.reasoning_content !== undefined && typedDelta.reasoning_content !== null &&
      typedDelta.reasoning_content !== '') || typedDelta.tool_calls !== undefined) {
    throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
  }
  const content = typedDelta.content;
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
  }
  if (choice.finish_reason !== null && choice.finish_reason !== undefined && choice.finish_reason !== 'stop') {
    throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
  }
  return Object.freeze({
    kind: 'delta',
    text: typeof content === 'string' ? content : '',
    finish: choice.finish_reason === 'stop',
  });
}

async function* sseFrames(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!response.ok || response.status !== 200 || !contentType.startsWith('text/event-stream') || !response.body) {
    throw providerFailure('QWEN38_PROVIDER_HTTP_REJECTED');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let bufferedBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortFailure();
      const { done, value } = await reader.read();
      if (done) break;
      bufferedBytes += value.byteLength;
      if (bufferedBytes > QWEN38_PROVIDER_MAX_BUFFERED_RESPONSE_BYTES) {
        throw providerFailure('QWEN38_PROVIDER_RESPONSE_TOO_LARGE');
      }
      buffered += decoder.decode(value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/u.exec(buffered);
        if (!match || match.index === undefined) break;
        const frame = buffered.slice(0, match.index);
        buffered = buffered.slice(match.index + match[0].length);
        yield frame;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim() !== '') yield buffered;
  } catch (error) {
    if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortFailure();
    throw error;
  } finally {
    try { await reader.cancel(); } catch { /* best-effort local HTTP cancellation */ }
    reader.releaseLock();
  }
}

async function readBufferedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) return new Response(null, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortFailure();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > QWEN38_PROVIDER_MAX_BUFFERED_RESPONSE_BYTES) {
        throw providerFailure('QWEN38_PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortFailure();
    throw error;
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(bytes, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

export class Qwen38ProviderAdapter {
  readonly #profile: Qwen38LocalProviderProfile;
  readonly #fetch: typeof fetch;
  readonly #gate: Qwen38ProviderConcurrencyGate;
  readonly #active = new Set<AbortController>();
  #closed = false;

  constructor(profile: Qwen38LocalProviderProfile, options?: Qwen38ProviderAdapterOptions);
  constructor(options: Qwen38ProviderAdapterOptions & { readonly profile: Qwen38LocalProviderProfile });
  constructor(
    profileOrOptions: Qwen38LocalProviderProfile | (Qwen38ProviderAdapterOptions & {
      readonly profile: Qwen38LocalProviderProfile;
    }),
    options: Qwen38ProviderAdapterOptions = {},
  ) {
    const profile = 'profile' in profileOrOptions ? profileOrOptions.profile : profileOrOptions;
    const resolvedOptions = 'profile' in profileOrOptions ? profileOrOptions : options;
    this.#profile = freezeQwen38LocalProviderProfile(profile);
    this.#fetch = resolvedOptions.fetchImpl ?? globalThis.fetch;
    this.#gate = resolvedOptions.concurrencyGate ?? SHARED_CONCURRENCY_GATE;
  }

  get profile(): Qwen38LocalProviderProfile { return this.#profile; }

  get closed(): boolean { return this.#closed; }

  get activeRequests(): number { return this.#gate.active; }

  async checkAvailability(signal?: AbortSignal): Promise<Qwen38ProviderAvailability> {
    this.#assertOpen();
    const owned = new AbortController();
    this.#active.add(owned);
    const requestSignal = combinedSignal(signal, owned.signal);
    try {
      const endpoint = providerEndpoint(this.#profile);
      const models = await this.#fetch(`${endpoint}/models`, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: requestSignal,
        headers: { Accept: 'application/json' },
      });
      assertJsonResponse(models);
      assertModelsPayload(await models.json(), this.#profile);
      if (this.#profile.availabilityMode === 'openai-models') {
        return Object.freeze({ ready: true, loaded: false, activeRequests: this.#gate.active });
      }
      const health = await this.#fetch(`${this.#profile.origin}/health`, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: requestSignal,
        headers: { Accept: 'application/json' },
      });
      assertJsonResponse(health);
      return assertHealthPayload(await health.json(), this.#profile);
    } catch (error) {
      if (requestSignal.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortFailure();
      throw error;
    } finally {
      this.#active.delete(owned);
    }
  }

  async *stream(
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<Qwen38StreamEvent> {
    this.#assertOpen();
    const request = validateRequest(input, this.#profile);
    const release = this.#gate.acquire();
    const owned = new AbortController();
    this.#active.add(owned);
    let requestSignal: AbortSignal;
    try { requestSignal = combinedSignal(signal, owned.signal); }
    catch (error) { release(); this.#active.delete(owned); throw error; }
    let text = '';
    let finishSeen = false;
    let doneSeen = false;
    try {
      const response = await this.#fetch(`${providerEndpoint(this.#profile)}/chat/completions`, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        referrerPolicy: 'no-referrer', signal: requestSignal,
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      for await (const frame of sseFrames(response, requestSignal)) {
        const event = parseSseFrame(frame);
        if (!event) continue;
        if (event.kind === 'done') { doneSeen = true; break; }
        if (event.text !== '') {
          text += event.text;
          yield Object.freeze({ kind: 'delta', text: event.text });
        }
        if (event.finish) finishSeen = true;
      }
      if (!finishSeen || (!doneSeen && text === '') || text.trim() === '' || text !== text.trim()) {
        throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
      }
      yield Object.freeze({ kind: 'final', text, finishReason: 'stop' });
    } catch (error) {
      if (requestSignal.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortFailure();
      throw error;
    } finally {
      owned.abort();
      this.#active.delete(owned);
      release();
    }
  }

  async complete(
    input: Qwen38ChatRequest,
    signal?: AbortSignal,
    onDelta?: (text: string) => void,
  ): Promise<Readonly<{ text: string; finishReason: 'stop' }>> {
    let completed: Readonly<{ text: string; finishReason: 'stop' }> | undefined;
    for await (const event of this.stream(input, signal)) {
      if (event.kind === 'delta') onDelta?.(event.text);
      else completed = Object.freeze({ text: event.text, finishReason: event.finishReason });
    }
    if (!completed) throw providerFailure('QWEN38_PROVIDER_STREAM_INVALID');
    return completed;
  }

  readonly fetchThrough = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const expectedUrl = `${providerEndpoint(this.#profile)}/chat/completions`;
    let parsed: URL | undefined;
    try { parsed = new URL(url); } catch { /* delegated fetch preserves its normal error */ }
    if (parsed?.pathname === '/v1/chat/completions' && url !== expectedUrl) {
      throw providerFailure('QWEN38_PROVIDER_ROUTE_INVALID');
    }
    if (url !== expectedUrl) return this.#fetch(input, init);
    this.#assertOpen();
    if (init?.method !== 'POST' || typeof init.body !== 'string') {
      throw providerFailure('QWEN38_PROVIDER_REQUEST_INVALID');
    }
    let payload: unknown;
    try { payload = JSON.parse(init.body); }
    catch { throw providerFailure('QWEN38_PROVIDER_REQUEST_INVALID'); }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      (payload as Record<string, unknown>).model !== this.#profile.model ||
      (payload as Record<string, unknown>).stream !== false ||
      Object.hasOwn(payload, 'keep_alive') || Object.hasOwn(payload, 'keepalive') ||
      Buffer.byteLength(init.body, 'utf8') > QWEN38_PROVIDER_MAX_REQUEST_BYTES) {
      throw providerFailure('QWEN38_PROVIDER_REQUEST_INVALID');
    }
    const release = this.#gate.acquire();
    const owned = new AbortController();
    this.#active.add(owned);
    let requestSignal: AbortSignal;
    try { requestSignal = combinedSignal(init.signal ?? undefined, owned.signal); }
    catch (error) { release(); this.#active.delete(owned); throw error; }
    try {
      const response = await this.#fetch(url, { ...init, signal: requestSignal });
      return await readBufferedResponse(response, requestSignal);
    } catch (error) {
      if (requestSignal.aborted || error instanceof DOMException && error.name === 'AbortError') {
        throw abortFailure();
      }
      throw error;
    } finally {
      owned.abort();
      this.#active.delete(owned);
      release();
    }
  };

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw providerFailure('QWEN38_PROVIDER_CLOSED');
  }
}
