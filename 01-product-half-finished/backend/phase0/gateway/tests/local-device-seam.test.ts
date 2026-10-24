import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createGatewayServer } from '../src/main.ts';

const PUBLIC_CONTROL_PATHS = Object.freeze([
  '/v1/realtime/bootstrap',
  '/v1/realtime/e2ee/key/resolve',
  '/v1/realtime/credentials/refresh',
  '/v1/realtime/media/stop',
  '/v1/realtime/end-continuity',
]);

test('one Gateway server owns health and the injected public-control routes', async () => {
  const routed: string[] = [];
  let closeCount = 0;
  const controller = Object.freeze({
    matches: (method: string | undefined, target: string) =>
      method === 'POST' && PUBLIC_CONTROL_PATHS.includes(target),
    handle: async (incoming: { url?: string }, response: {
      writeHead(code: number, headers?: Record<string, string>): unknown;
      end(body?: string): unknown;
    }) => {
      routed.push(incoming.url ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"routed"}');
      return true;
    },
    close: async () => { closeCount += 1; },
  });
  const server = createGatewayServer(
    { precontactAdmission: 'OPEN_NORMAL', deviceLanSecurity: {} } as never,
    { activeSessionIds: () => [], close: async () => undefined } as never,
    undefined,
    undefined,
    undefined,
    { persistentPublicOnly: true, v2Only: true, publicRtcControl: controller as never },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(await exchange(address.port, 'GET', '/healthz'), 200);
    for (const path of PUBLIC_CONTROL_PATHS) assert.equal(await exchange(address.port, 'POST', path), 200);
    assert.deepEqual(routed, PUBLIC_CONTROL_PATHS);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await controller.close();
  }
  assert.equal(closeCount, 1);
});

async function exchange(port: number, method: string, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = httpRequest({hostname: '127.0.0.1', port, method, path,
      headers: {Host: '127.0.0.1:8787'}}, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}
