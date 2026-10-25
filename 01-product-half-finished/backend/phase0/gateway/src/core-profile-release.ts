import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {readActivePairedDevices} from './paired-device-authority.ts';
import {parseConfiguredOwnerPolicy} from './rayneo-demo-owner-projection.ts';
import {createPostgresPool, closePostgresPool} from '../../../services/platform-data/src/postgres-pool.ts';
import {loadHostConfiguration} from '../../../services/personal-aios-integration/src/host-configuration.ts';
import {check, sha256} from '../../../services/personal-aios-integration/src/contracts.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {L3Service, isL3Namespace} from '../../../services/personal-aios-integration/src/memory/l3.ts';
import {coreProfileMigration, migrateNativeMemory, CoreProfileMigrationError} from '../../../services/personal-aios-integration/src/memory/core-profile.ts';
import {projectNativeMemoryForRollback} from '../../../services/personal-aios-integration/src/memory/core-profile-rollback.ts';
import {CORE_PROFILE_FILES} from '../../../services/personal-aios-integration/src/memory/core-profile-state.ts';

interface Configuration {
  core_profile?: {enabled: boolean; profile_home: string; native_profile_home?: string};
  storage_root: string; max_event_bytes: number; l3: {namespace: string};
  product_resources: {owner_policy_file: string; postgres: {
    host: string; port: number; database: string; user: string; password_file: string;
  }};
}

export async function boundCoreProfilePrincipal(policyFile: string, authority: Parameters<typeof readActivePairedDevices>[0]) {
  const principal = parseConfiguredOwnerPolicy(JSON.parse(await readFile(policyFile, 'utf8'))).userId;
  const devices = await readActivePairedDevices(authority);
  check(devices.length > 0 && devices.every(device => device.userId === principal), 'CORE_PROFILE_BOUND_OWNER_MISMATCH', 403);
  return principal;
}

export function coreProfileReleaseFailure(error: unknown) {
  const code = (error as {code?: string}).code;
  return {status: 'failed', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : 'CORE_PROFILE_RELEASE_FAILED',
    ...(error instanceof CoreProfileMigrationError ? {partial_import: error.evidence} : {})};
}

/** Release-time identity comes only from the persisted policy and active device authority. */
export async function releaseCoreProfile(configPath: string, operation: 'migrate' | 'rollback') {
  const config = await loadHostConfiguration(configPath) as Configuration, profile = config.core_profile;
  if (!profile?.enabled) return {status: 'skipped', reason: 'disabled'};
  const storage = new PosixStorage(config.storage_root);
  const sourceHome = operation === 'rollback' ? '/opt/paios-rollback-native' : profile.native_profile_home ?? profile.profile_home;
  let hasCheckpoint = false;
  try {await coreProfileMigration(storage, profile.profile_home); hasCheckpoint = true;}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  if (operation === 'rollback' && !hasCheckpoint) return {status: 'skipped', reason: 'no_checkpoint'};
  if (!hasCheckpoint) {
    const sources = await Promise.all(CORE_PROFILE_FILES.map(async file => {
      try {return await readFile(join(sourceHome, 'memories', file));}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return Buffer.alloc(0);}
    }));
    if (sources.every(bytes => !bytes.toString('utf8').trim())) return {status: 'skipped', reason: 'empty_source'};
  }
  const pg = config.product_resources.postgres, password = (await readFile(pg.password_file, 'utf8')).trim();
  check(isL3Namespace(config.l3?.namespace), 'CORE_PROFILE_CONFIGURATION_REQUIRED');
  const authority = createPostgresPool({...pg, password, max: 1});
  const require = createRequire(new URL('../../../services/platform-data/package.json', import.meta.url));
  const {Pool} = require('pg');
  const pool = new Pool({...pg, password, max: 1, options: `-c search_path=${config.l3.namespace}`});
  let l3: L3Service | undefined;
  try {
    const principal = await boundCoreProfilePrincipal(config.product_resources.owner_policy_file, authority);
    l3 = await L3Service.openExisting(pool, config.l3.namespace);
    const options = {principal_id: principal, profile_home: profile.profile_home, source_profile_home: sourceHome, storage, l3};
    // This is the gateway image's declared writer, independent of Docker-created parent directories.
    if (operation === 'rollback') return await projectNativeMemoryForRollback({...options, state_owner: {uid: 10000, gid: 10000}});
    const result = await migrateNativeMemory({...options, archive: new RawArchive(storage, config.max_event_bytes)});
    return {status: 'completed', files: result.files, assertions: result.assertions, entries: result.entries, replayed: result.replayed,
      generated_sha256: Object.fromEntries(Object.entries(result.views).map(([file, text]) => [file, sha256(text)]))};
  } finally {await l3?.close(); await pool.end(); await closePostgresPool(authority);}
}
