import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import { createRealtimeCredentialFence, type CredentialFenceTuple } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import { RealtimeExternalEffectCoordinator, type RealtimeMediaCleanupStage } from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';

/** Runs production fence/coordinator SQL in a disposable schema of the approved test database. */
export async function createCredentialFencePgFixture(t: TestContext, tuple: CredentialFenceTuple) {
  assert.ok(process.env.DEVICE_RECEIPTS_PG_URL, 'DEVICE_RECEIPTS_PG_URL is required');
  const { Pool } = createRequire(new URL('../../../services/platform-data/package.json', import.meta.url))('pg') as typeof import('pg');
  const schema = `credential_fence_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.DEVICE_RECEIPTS_PG_URL,
    options: `-c search_path=${schema}`, max: 1 });
  // Production fence SQL deliberately qualifies public; redirect only its table for this fixture.
  const fencePool = new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, key) {
        if (key === 'query') return (sql: string, values?: unknown[]) =>
          connection.query(sql.replaceAll('public.realtime_external_effects', `${schema}.realtime_external_effects`), values);
        const value = Reflect.get(connection, key);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const fence = createRealtimeCredentialFence(fencePool);
  let beforeDisconnect: (() => Promise<void>) | undefined;
  const coordinator = new RealtimeExternalEffectCoordinator(fencePool, { credentialFence: fence,
    executor: { executeStage: async ({ stage }) => {
      if (stage === 'participant_disconnected') await beforeDisconnect?.();
    } } });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await coordinator.close(); await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  })();
  t.after(close);
  await pool.query(`CREATE SCHEMA ${schema}`);
  for (const name of ['0001_idempotency_outbox', '0002_realtime_authority', '0008_realtime_credential_fence']) {
    const migration = await readFile(new URL(`../../../migrations/${name}.up.sql`, import.meta.url), 'utf8');
    try { await pool.query(migration.replaceAll('public.', `${schema}.`).replaceAll("'public'::regnamespace", `'${schema}'::regnamespace`)); }
    catch (error) { await pool.query('ROLLBACK'); throw error; }
  }
  return { fence, coordinator, close,
    rows: async () => (await pool.query('SELECT effect_state, stage_state, credential_generation::text FROM realtime_external_effects')).rows,
    stop: async (options: { beforeDisconnect?: () => Promise<void> } = {}) => {
      beforeDisconnect = options.beforeDisconnect;
      const key = randomUUID(), fingerprint = `stop:${key}`;
      const intent = { fingerprint, wireRequest: { operation: 'media_stop', request_id: key }, governance: {},
        request: { operation: 'media_stop', ...tuple, expectedConnectionEpoch: tuple.connectionEpoch,
          expectedLeaseVersion: tuple.credentialGeneration, idempotencyKey: key } };
      const claim = await coordinator.claim({ intent, fingerprint, idempotencyContext: { idempotency_key: key } });
      assert.equal(claim.disposition, 'claimed');
      if (claim.disposition !== 'claimed') throw new Error('PG media-stop claim failed');
      for (const stage of ['tracks_unpublished', 'participant_disconnected', 'credential_revoked', 'closure_verified'] as const satisfies readonly RealtimeMediaCleanupStage[]) {
        await coordinator.executeStage({ claimId: claim.claimId, stage, intent });
      }
      await coordinator.commit({ claimId: claim.claimId, fingerprint, result: { status: 'success' } });
    } };
}
