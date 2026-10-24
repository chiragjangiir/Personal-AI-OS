import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { check, sha256 } from '../contracts.ts';
import {BACKUP_MIGRATION_SHA256} from '../../../platform-data/src/backup-authority-contract.ts';
import { L3Service } from './l3.ts';

const require = createRequire(new URL('../../../platform-data/package.json', import.meta.url));
type Pool = ConstructorParameters<typeof L3Service>[0];
const PgPool = (require('pg') as {Pool: new(config: Record<string, unknown>) => Pool}).Pool;

// Isolated test database setup only. Never migrates a user's existing database.
export async function openFixtureDatabase(config: {url: string; schema: string; migration_file: string}, PoolConstructor = PgPool) {
  const url = new URL(config.url);
  check(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port === '55439' &&
    url.username === 'l3test' && url.pathname === '/postgres', 'FIXTURE_DATABASE_REQUIRED');
  check(/^paios_fixture_[a-z0-9_]{1,40}$/u.test(config.schema), 'FIXTURE_SCHEMA_REQUIRED');
  const original = await fs.readFile(config.migration_file, 'utf-8');
  check(sha256(original)===BACKUP_MIGRATION_SHA256['0009_hermes_l3'],'FIXTURE_MIGRATION_CHANGED',409);
  const split=await fs.readFile(new URL('../../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf-8');
  check(sha256(split)===BACKUP_MIGRATION_SHA256['0012_l3_payload_audit_split'],'FIXTURE_MIGRATION_CHANGED',409);
  // Only this pinned source's exact top-level boundaries are removed inside our original transaction.
  const prefix='-- Owned, offline source migration. Apply only after draining old writers in this namespace.\nBEGIN;\n';
  const suffix='COMMIT;\n';
  check(split.startsWith(prefix)&&split.endsWith(suffix),'FIXTURE_MIGRATION_BOUNDARY_CHANGED',409);
  const body=prefix.slice(0,-'BEGIN;\n'.length)+split.slice(prefix.length,-suffix.length);
  check(body+'COMMIT;\n'!==split && prefix.slice(0,-'BEGIN;\n'.length)+'BEGIN;\n'+
    body.slice(prefix.length-'BEGIN;\n'.length)+suffix===split,'FIXTURE_MIGRATION_BOUNDARY_CHANGED',409);
  const closure=await fs.readFile(new URL('../../../../migrations/0018_l3_forget_dependency_closure.up.sql',import.meta.url),'utf-8');
  check(sha256(closure)===BACKUP_MIGRATION_SHA256['0018_l3_forget_dependency_closure'],'FIXTURE_MIGRATION_CHANGED',409);
  const closureStart=closure.indexOf('\nBEGIN;\n');
  check(closureStart>=0&&closure.endsWith(suffix),'FIXTURE_MIGRATION_BOUNDARY_CHANGED',409);
  const migrations=[{version:'0009_hermes_l3',sql:original,hash:sha256(original)},
    {version:'0012_l3_payload_audit_split',sql:body,hash:sha256(split)},
    {version:'0018_l3_forget_dependency_closure',sql:closure.slice(0,closureStart)+closure.slice(closureStart+7,-suffix.length),hash:sha256(closure)}];
  const admin = new PoolConstructor({connectionString: config.url});
  let client: Parameters<Parameters<typeof import('../../../platform-data/src/transaction.ts').withTransaction>[1]>[0] | undefined;
  const errors: unknown[] = [];
  try {
    client = await admin.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [config.schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema}`);
    await client.query(`SET LOCAL search_path=${config.schema}`);
    await client.query('CREATE TABLE IF NOT EXISTS fixture_migrations(version text PRIMARY KEY, sha256 text NOT NULL)');
    for (const migration of migrations) {
      const applied=await client.query('SELECT sha256 FROM fixture_migrations WHERE version=$1',[migration.version]);
      if (applied.rows[0]) check(applied.rows[0].sha256===migration.hash,'FIXTURE_MIGRATION_CHANGED',409);
      else {
        await client.query(migration.sql);
        await client.query('INSERT INTO fixture_migrations VALUES($1,$2)',[migration.version,migration.hash]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    errors.push(error);
    if (client) try { await client.query('ROLLBACK'); } catch (rollback) { errors.push(rollback); }
  } finally {
    if (client) try { client.release(); } catch (release) { errors.push(release); }
    try { await admin.end(); } catch (end) { errors.push(end); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'FIXTURE_DATABASE_STARTUP_FAILED', {cause: errors[0]});
  const pool = new PoolConstructor({connectionString: config.url, options: `-c search_path=${config.schema}`, max: 2});
  let closing: Promise<void> | undefined;
  const l3 = new L3Service(pool);
  return {pool, l3, close: () => closing ??= Promise.resolve().then(async () => {await l3.close(); await pool.end();})};
}
