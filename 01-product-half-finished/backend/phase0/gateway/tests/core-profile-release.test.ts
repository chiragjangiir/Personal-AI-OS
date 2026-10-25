import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {boundCoreProfilePrincipal, releaseCoreProfile, coreProfileReleaseFailure} from '../src/core-profile-release.ts';

test('migration identity is policy userId cross-checked against all active paired devices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'core-profile-owner-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const policy = join(root, 'owner.json');
  await writeFile(policy, JSON.stringify({schema: 'paios.windows.local-owner.v1', purpose: 'public_product_canary',
    userId: 'fictional-owner', revocable: true}));
  const pool = (owners: string[]) => ({query: async (sql: string) => {
    assert.match(sql, /FROM paired_devices WHERE status = 'active'/);
    return {rows: owners.map((user_id, index) => ({user_id, device_id: String(index), device_class: 'iphone',
      governance: {}, media: [], device_credential_ref: {}, recipient_public_key: 'fictional', paired_at: new Date(0)}))};
  }}) as Parameters<typeof boundCoreProfilePrincipal>[1];
  assert.equal(await boundCoreProfilePrincipal(policy, pool(['fictional-owner', 'fictional-owner'])), 'fictional-owner');
  await assert.rejects(boundCoreProfilePrincipal(policy, pool(['fictional-owner', 'someone-else'])), /CORE_PROFILE_BOUND_OWNER_MISMATCH/);
  await assert.rejects(boundCoreProfilePrincipal(policy, pool([])), /CORE_PROFILE_BOUND_OWNER_MISMATCH/);
});

test('fresh empty source and checkpoint-free rollback need no principal, database or memory writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'core-profile-fresh-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const config = join(root, 'config.json');
  await mkdir(join(root, 'source'));
  await writeFile(config, JSON.stringify({core_profile: {enabled: true, profile_home: join(root, 'derived'),
    native_profile_home: join(root, 'source')}, storage_root: join(root, 'l5')}));
  assert.deepEqual(await releaseCoreProfile(config, 'migrate'), {status: 'skipped', reason: 'empty_source'});
  assert.deepEqual(await releaseCoreProfile(config, 'rollback'), {status: 'skipped', reason: 'no_checkpoint'});
  assert.deepEqual(coreProfileReleaseFailure(new Error('fictional memory must not leak')), {status: 'failed', code: 'CORE_PROFILE_RELEASE_FAILED'});
});
