import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createQwenModelSupervisor, type QwenModelSupervisorAssets } from '../src/qwen-model-supervisor.ts';

const MODEL = 'qwen38-orcarouter-uncensored-q6-262k-mtp4';
const assets: QwenModelSupervisorAssets = Object.freeze({
  runtimeRoot: '/opt/runtime', runtimeRootBytes: 1, runtimeTreeSha256: 'a'.repeat(64),
  executablePath: '/opt/runtime/llama-server', executableBytes: 1, executableSha256: 'b'.repeat(64),
  modelPath: '/opt/models/model.gguf', modelBytes: 1, modelSha256: 'c'.repeat(64),
  mmprojPath: '/opt/models/mmproj.gguf', mmprojBytes: 1, mmprojSha256: 'd'.repeat(64),
  templatePath: '/opt/models/template.jinja', templateBytes: 1, templateSha256: 'e'.repeat(64),
  model: MODEL, contextTokens: 262_144, frontOrigin: 'http://127.0.0.1:16001', frontPort: 16_001,
  backendPort: 15_811, idleMs: 2_700_000, maxActiveRequests: 3,
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function models(): Response {
  return json({ object: 'list', data: [{ id: MODEL, context_window: 262_144 }] });
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  kill(): boolean { this.exitCode = 0; this.emit('exit', 0, null); return true; }
}

test('unloaded health/models do not load; first request borrows exact backend and unload never kills it', async () => {
  let childSpawns = 0;
  let backendRequests = 0;
  const supervisor = createQwenModelSupervisor({
    assets, frontPort: 19_601, backendPort: 19_611,
    assetVerifier: async () => undefined,
    spawnImpl: (() => { childSpawns += 1; return new FakeChild() as never; }) as never,
    fetchImpl: async (url) => {
      backendRequests += 1;
      if (String(url).endsWith('/health')) return json({ status: 'ok' });
      if (String(url).endsWith('/v1/models')) return models();
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await supervisor.start();
  assert.deepEqual(supervisor.health(), {
    status: 'ok', service: 'qwen-model-supervisor', active_requests: 0, owned_process: false,
    last_error: '', loaded_model: null, loading_model: null, backend_port: null,
  });
  const response = await fetch('http://127.0.0.1:19601/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(childSpawns, 0);
  assert.ok(backendRequests >= 3);
  await supervisor.close();
  assert.equal(childSpawns, 0);
});

test('missing backend has one load flight and owned child is unloaded after idle', async () => {
  let childSpawns = 0;
  let backendReady = false;
  let child: FakeChild | undefined;
  const supervisor = createQwenModelSupervisor({
    assets, frontPort: 19_602, backendPort: 19_612, idleMs: 20,
    assetVerifier: async () => undefined,
    spawnImpl: (() => { childSpawns += 1; backendReady = true; child = new FakeChild(); return child as never; }) as never,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/health')) {
        if (!backendReady) throw new Error('ECONNREFUSED');
        return json({ status: 'ok' });
      }
      if (String(url).endsWith('/v1/models')) return models();
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await supervisor.start();
  const response = await fetch('http://127.0.0.1:19602/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'load' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(childSpawns, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(child?.exitCode, 0);
  await supervisor.close();
});

test('fourth active request is busy and wrong model never spawns', async () => {
  let childSpawns = 0;
  const releaseBackends: Array<() => void> = [];
  const supervisor = createQwenModelSupervisor({
    assets, frontPort: 19_603, backendPort: 19_613,
    assetVerifier: async () => undefined,
    spawnImpl: (() => { childSpawns += 1; return new FakeChild() as never; }) as never,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/health')) return json({ status: 'ok' });
      if (String(url).endsWith('/v1/models')) return models();
      await new Promise<void>((resolve) => { releaseBackends.push(resolve); });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await supervisor.start();
  const request = () => fetch('http://127.0.0.1:19603/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'busy' }] }),
  });
  const requests = [request(), request(), request()];
  await new Promise((resolve) => setImmediate(resolve));
  const fourth = await request();
  assert.equal(fourth.status, 429);
  for (const release of releaseBackends) release();
  await Promise.all(requests);
  const wrong = await fetch('http://127.0.0.1:19603/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'wrong', stream: true, messages: [] }),
  });
  assert.equal(wrong.status, 400);
  assert.equal(childSpawns, 0);
  await supervisor.close();
});
