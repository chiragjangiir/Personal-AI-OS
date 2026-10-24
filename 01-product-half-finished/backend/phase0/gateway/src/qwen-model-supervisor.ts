import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const QWEN_SUPERVISOR_FRONT_ORIGIN = 'http://127.0.0.1:16001' as const;
export const QWEN_SUPERVISOR_BACKEND_PORT = 15_811 as const;
export const QWEN_SUPERVISOR_IDLE_MS = 2_700_000 as const;
export const QWEN_SUPERVISOR_MAX_ACTIVE_REQUESTS = 3 as const;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

export interface QwenModelSupervisorAssets {
  readonly runtimeRoot: string;
  readonly runtimeRootBytes: number;
  readonly runtimeTreeSha256: string;
  readonly executablePath: string;
  readonly executableBytes: number;
  readonly executableSha256: string;
  readonly modelPath: string;
  readonly modelBytes: number;
  readonly modelSha256: string;
  readonly mmprojPath: string;
  readonly mmprojBytes: number;
  readonly mmprojSha256: string;
  readonly templatePath: string;
  readonly templateBytes: number;
  readonly templateSha256: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly frontOrigin?: string;
  readonly frontPort?: number;
  readonly backendPort?: number;
  readonly idleMs?: number;
  readonly maxActiveRequests?: number;
}

export interface QwenModelSupervisorOptions {
  readonly assets: QwenModelSupervisorAssets;
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: typeof spawn;
  readonly assetVerifier?: (assets: QwenModelSupervisorAssets) => Promise<void>;
  readonly frontPort?: number;
  readonly backendPort?: number;
  readonly idleMs?: number;
  readonly maxActiveRequests?: number;
}

export interface QwenModelSupervisor {
  readonly origin: string;
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly health: () => Readonly<Record<string, unknown>>;
}

type OwnedChild = Readonly<{ readonly process: ChildProcess; readonly path: string; readonly sha256: string }>;

function fail(code: string): never { throw new Error(code); }

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

export async function validateQwenModelSupervisorAssets(
  assets: QwenModelSupervisorAssets,
): Promise<void> {
  const files = [
    [assets.executablePath, assets.executableBytes, assets.executableSha256],
    [assets.modelPath, assets.modelBytes, assets.modelSha256],
    [assets.mmprojPath, assets.mmprojBytes, assets.mmprojSha256],
    [assets.templatePath, assets.templateBytes, assets.templateSha256],
  ] as const;
  if (!Number.isSafeInteger(assets.runtimeRootBytes) || assets.runtimeRootBytes < 1 ||
      !Number.isSafeInteger(assets.contextTokens) || assets.contextTokens < 1 ||
      !/^[a-f0-9]{64}$/u.test(assets.runtimeTreeSha256)) fail('QWEN_SUPERVISOR_ASSET_PIN_INVALID');
  let total = 0;
  for (const [path, bytes, expected] of files) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== bytes || !/^[a-f0-9]{64}$/u.test(expected) ||
        await fileSha256(path) !== expected) fail('QWEN_SUPERVISOR_ASSET_DRIFT');
  }
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile()) {
        const stat = statSync(full);
        total += stat.size;
        const rel = relative(assets.runtimeRoot, full).replaceAll('\\', '/');
        rows.push(`${rel}|${stat.size}|${sha256Bytes(readFileSync(full))}`);
      }
    }
  };
  if (!existsSync(assets.runtimeRoot) || !statSync(assets.runtimeRoot).isDirectory()) {
    fail('QWEN_SUPERVISOR_RUNTIME_ROOT_INVALID');
  }
  walk(assets.runtimeRoot);
  rows.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const tree = sha256Bytes(Buffer.from(rows.join('\n'), 'utf8'));
  if (rows.length !== 56 || total !== assets.runtimeRootBytes || tree !== assets.runtimeTreeSha256) {
    fail('QWEN_SUPERVISOR_RUNTIME_TREE_DRIFT');
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', body.byteLength);
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) fail('QWEN_SUPERVISOR_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function modelPayload(model: string, contextTokens: number): Readonly<Record<string, unknown>> {
  return Object.freeze({ object: 'list', data: Object.freeze([Object.freeze({ id: model, context_window: contextTokens })]) });
}

export function createQwenModelSupervisor(options: QwenModelSupervisorOptions): QwenModelSupervisor {
  const assets = options.assets;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const frontPort = options.frontPort ?? assets.frontPort ?? 16_001;
  const backendPort = options.backendPort ?? assets.backendPort ?? QWEN_SUPERVISOR_BACKEND_PORT;
  const idleMs = options.idleMs ?? assets.idleMs ?? QWEN_SUPERVISOR_IDLE_MS;
  const maxActive = options.maxActiveRequests ?? assets.maxActiveRequests ?? QWEN_SUPERVISOR_MAX_ACTIVE_REQUESTS;
  const frontOrigin = options.assets.frontOrigin ?? QWEN_SUPERVISOR_FRONT_ORIGIN;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  if ((options.frontPort === undefined && frontPort !== 16_001) ||
      (options.backendPort === undefined && backendPort !== QWEN_SUPERVISOR_BACKEND_PORT) ||
      !Number.isSafeInteger(backendPort) || backendPort < 1 ||
      !Number.isSafeInteger(idleMs) || idleMs < 1 || maxActive !== 3 ||
      frontOrigin !== QWEN_SUPERVISOR_FRONT_ORIGIN) fail('QWEN_SUPERVISOR_CONFIG_INVALID');
  let server: ReturnType<typeof createServer> | undefined;
  let started = false;
  let closed = false;
  let activeRequests = 0;
  let loadedModel: string | null = null;
  let loadingModel: string | null = null;
  let lastError = '';
  let ownedChild: OwnedChild | undefined;
  let loadFlight: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const activeAborts = new Set<AbortController>();

  const clearIdle = (): void => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
  const health = (): Readonly<Record<string, unknown>> => Object.freeze({
    status: 'ok', service: 'qwen-model-supervisor', active_requests: activeRequests,
    owned_process: ownedChild !== undefined, last_error: lastError,
    loaded_model: loadedModel, loading_model: loadingModel,
    backend_port: loadedModel === assets.model ? backendPort : null,
  });
  const probeBackend = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const healthResponse = await fetchImpl(`${backendOrigin}/health`, { signal, headers: { Accept: 'application/json' } });
      if (!healthResponse.ok) throw new Error('QWEN_SUPERVISOR_BACKEND_HEALTH_INVALID');
      const modelsResponse = await fetchImpl(`${backendOrigin}/v1/models`, { signal, headers: { Accept: 'application/json' } });
      if (!modelsResponse.ok) throw new Error('QWEN_SUPERVISOR_BACKEND_MODELS_INVALID');
      const payload = await modelsResponse.json() as { readonly data?: readonly { readonly id?: unknown }[] };
      return Array.isArray(payload.data) && payload.data.length === 1 && payload.data[0]?.id === assets.model;
    } catch (error) {
      if (error instanceof Error && /BACKEND_(?:HEALTH|MODELS)_INVALID/u.test(error.message)) throw error;
      return false;
    }
  };
  const childArgs = (): string[] => [
    '--model', assets.modelPath, '--alias', assets.model, '--mmproj', assets.mmprojPath,
    '--mmproj-offload', '--gpu-layers', 'all', '--spec-draft-ngl', 'all', '--ctx-size', String(assets.contextTokens),
    '--parallel', '3', '--cont-batching', '--kv-unified', '--cache-type-k', 'kvarn4', '--cache-type-v', 'kvarn2',
    '--kv-tail-tokens', '0', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '4', '--spec-draft-p-min', '0.0',
    '--spec-draft-type-k', 'q4_0', '--spec-draft-type-v', 'q4_0', '--flash-attn', 'on', '--batch-size', '8192',
    '--ubatch-size', '512', '--fit', 'off', '--no-context-shift', '--jinja', '--chat-template-file', assets.templatePath,
    '--reasoning', 'on', '--reasoning-preserve', '--cache-ram', '0', '--metrics', '--host', '127.0.0.1',
    '--port', String(backendPort),
  ];
  const unload = async (): Promise<void> => {
    clearIdle();
    const child = ownedChild;
    ownedChild = undefined;
    loadedModel = null;
    loadingModel = null;
    if (child === undefined || child.process.exitCode !== null) return;
    child.process.kill();
    await new Promise<void>((resolve) => {
      if (child.process.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.process.kill('SIGKILL'); } catch {} resolve(); }, 5_000);
      child.process.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  const scheduleIdle = (): void => {
    clearIdle();
    if (activeRequests === 0 && ownedChild !== undefined && loadedModel === assets.model) {
      idleTimer = setTimeout(() => { void unload().catch(() => undefined); }, idleMs);
      idleTimer.unref?.();
    }
  };
  const waitReady = async (signal: AbortSignal): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await probeBackend(signal)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('QWEN_SUPERVISOR_ABORTED')); }, { once: true });
      });
    }
    throw new Error('QWEN_SUPERVISOR_BACKEND_NOT_READY');
  };
  const ensureLoaded = async (): Promise<void> => {
    if (loadedModel === assets.model) { clearIdle(); return; }
    loadFlight ??= (async () => {
      loadingModel = assets.model;
      const signal = new AbortController().signal;
      if (await probeBackend(signal)) { loadedModel = assets.model; loadingModel = null; return; }
      const child = spawnImpl(assets.executablePath, childArgs(), {
        cwd: dirname(assets.templatePath), stdio: 'ignore', windowsHide: true,
      });
      ownedChild = Object.freeze({ process: child, path: assets.executablePath, sha256: assets.executableSha256 });
      child.once('exit', () => {
        if (ownedChild?.process === child) { ownedChild = undefined; loadedModel = null; loadingModel = null; }
      });
      await waitReady(signal);
      loadedModel = assets.model;
      loadingModel = null;
    })().catch((error) => { loadingModel = null; lastError = error instanceof Error ? error.message.slice(0, 160) : 'LOAD_FAILED'; throw error; })
      .finally(() => { loadFlight = undefined; });
    return loadFlight;
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', frontOrigin);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, health());
    if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, modelPayload(assets.model, assets.contextTokens));
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions' || url.search !== '') return json(res, 404, { error: 'NOT_FOUND' });
    if (activeRequests >= maxActive) return json(res, 429, { error: 'QWEN_SUPERVISOR_BUSY' });
    const body = await readBody(req);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'REQUEST_INVALID' }); }
    if (payload.model !== assets.model || typeof payload.stream !== 'boolean') return json(res, 400, { error: 'REQUEST_INVALID' });
    const abort = new AbortController();
    req.once('aborted', () => abort.abort());
    activeAborts.add(abort); activeRequests += 1; clearIdle();
    try {
      await ensureLoaded();
      const response = await fetchImpl(`${backendOrigin}/v1/chat/completions`, {
        method: 'POST', body: JSON.stringify(payload), signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Accept: payload.stream === true ? 'text/event-stream' : 'application/json' },
      });
      res.statusCode = response.status;
      const contentType = response.headers.get('content-type'); if (contentType) res.setHeader('content-type', contentType);
      if (!response.body) { res.end(); return; }
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(Buffer.from(chunk));
      res.end();
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 160) : 'REQUEST_FAILED';
      if (!res.headersSent) json(res, abort.signal.aborted ? 499 : 502, { error: 'QWEN_SUPERVISOR_REQUEST_FAILED' }); else res.destroy();
    } finally { activeAborts.delete(abort); activeRequests -= 1; scheduleIdle(); }
  };
  const start = async (): Promise<void> => {
    if (started) return; if (closed) fail('QWEN_SUPERVISOR_CLOSED');
    if (options.assetVerifier) await options.assetVerifier(assets); else await validateQwenModelSupervisorAssets(assets);
    server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'SUPERVISOR_FAILED' }); }); });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(frontPort, '127.0.0.1', () => resolve()); });
    started = true;
  };
  const close = async (): Promise<void> => {
    if (closed) return; closed = true; clearIdle();
    for (const abort of activeAborts) abort.abort(); activeAborts.clear();
    await unload();
    await new Promise<void>((resolve) => { if (!server) return resolve(); server.close(() => resolve()); });
    server = undefined;
  };
  return Object.freeze({ origin: frontOrigin, start, close, health });
}
