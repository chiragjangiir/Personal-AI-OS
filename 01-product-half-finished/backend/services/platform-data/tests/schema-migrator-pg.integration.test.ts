import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { loadMigrations, migrateDatabase } from "../src/schema-migrator.ts";

// Disposable cluster only (never production): PAIOS_MIGRATOR_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55439/postgres
const url = process.env.PAIOS_MIGRATOR_TEST_DATABASE_URL;
const MIGRATIONS = new URL("../../../migrations", import.meta.url).pathname;
const HEAD = 21;
const skip = url ? false : "PAIOS_MIGRATOR_TEST_DATABASE_URL not set";
if (url) { const u = new URL(url); assert.equal(u.hostname, "127.0.0.1"); assert.equal(u.port, "55439"); }

async function withDb(fn: (pool: Pool, name: string) => Promise<void>) {
  const name = `migtest_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url!); target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.href, max: 4 });
  const disconnected: Promise<void>[] = [];
  pool.on("connect", client => disconnected.push(new Promise(resolve => client.once("end", resolve))));
  try { await fn(pool, name); } finally {
    await pool.end();
    // pg-pool resolves end() before all removed clients finish closing their sockets.
    await Promise.all(disconnected);
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}
const ups = () => readdirSync(MIGRATIONS).filter(f => f.endsWith(".up.sql")).sort();
const rawApply = async (pool: Pool, upTo: number, skipVersions: number[] = []) => {
  for (const f of ups()) { const v = Number(f.slice(0, 4)); if (v <= upTo && !skipVersions.includes(v)) await pool.query(readFileSync(join(MIGRATIONS, f), "utf8")); }
};
const ledger = async (pool: Pool) => (await pool.query("SELECT version, origin FROM paios_migrations.schema_migrations ORDER BY version")).rows as { version: number; origin: string }[];
const names = (from: number, to: number) => ups().filter(f => Number(f.slice(0, 4)) >= from && Number(f.slice(0, 4)) <= to).map(f => f.replace(".up.sql", ""));
const tmpCopy = () => { const dir = mkdtempSync(join(tmpdir(), "migrations-")); cpSync(MIGRATIONS, dir, { recursive: true }); return dir; };

test("every migration has a verifier and the files form 0001..N", () => { assert.equal(loadMigrations(MIGRATIONS).length, HEAD); });

test("empty database: applies and verifies every version; rerun is a no-op", { skip }, () => withDb(async pool => {
  const first = await migrateDatabase(pool, MIGRATIONS);
  assert.deepEqual([first.status, first.adopted, first.applied, first.verified], ["migrated", [], names(1, HEAD), HEAD]);
  assert.deepEqual((await ledger(pool)).map(r => [r.version, r.origin]), Array.from({ length: HEAD }, (_, i) => [i + 1, "applied"]));
  const second = await migrateDatabase(pool, MIGRATIONS);
  assert.deepEqual([second.adopted, second.applied], [[], []]);
}));

test("pg_dump round trip of a migrated database still verifies (staging snapshot, backup restore)", { skip }, () => withDb(async (pool, name) => {
  await migrateDatabase(pool, MIGRATIONS);
  const source = new URL(url!); source.pathname = `/${name}`;
  const dump = execFileSync("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--dbname", source.href]);
  await withDb(async (restored, restoredName) => {
    const target = new URL(url!); target.pathname = `/${restoredName}`;
    execFileSync("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", target.href], { input: dump });
    const r = await migrateDatabase(restored, MIGRATIONS);
    assert.deepEqual([r.status, r.adopted, r.applied, r.verified], ["migrated", [], [], HEAD]);
  });
}));

test("legacy 0008 database without ledger: adopts 0001..0008, applies 0009..latest", { skip }, () => withDb(async pool => {
  await rawApply(pool, 8);
  const r = await migrateDatabase(pool, MIGRATIONS);
  assert.deepEqual([r.adopted, r.applied], [names(1, 8), names(9, HEAD)]);
  const rows = await ledger(pool);
  assert.deepEqual(rows.map(x => x.origin), [...Array(8).fill("adopted"), ...Array(HEAD - 8).fill("applied")]);
  assert.equal((await pool.query("SELECT to_regclass('public.paios_l3_forgotten') AS t")).rows[0].t, "paios_l3_forgotten");
}));

test("legacy complete 0013 database: adopts phone authority and applies subsequent migrations", { skip }, () => withDb(async pool => {
  await rawApply(pool, 13);
  const r = await migrateDatabase(pool, MIGRATIONS);
  assert.deepEqual([r.adopted, r.applied], [names(1, 13), names(14, HEAD)]);
}));

test("gap (0011 missing from a 0012 database) fails closed and writes no ledger rows", { skip }, () => withDb(async pool => {
  await rawApply(pool, 10); await pool.query(readFileSync(join(MIGRATIONS, ups()[11]!), "utf8"));
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_ADOPT_GAP:0012_l3_payload_audit_split present but 0011/);
  assert.deepEqual(await ledger(pool), []);
}));

test("partially applied later version fails closed", { skip }, () => withDb(async pool => {
  await rawApply(pool, 8);
  await pool.query("CREATE TABLE paios_l3_versions (principal_id text)");
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_ADOPT_PARTIAL:0009_hermes_l3/);
  assert.deepEqual(await ledger(pool), []);
}));

test("non-empty database with none of 0001 provable fails closed", { skip }, () => withDb(async pool => {
  await pool.query("CREATE TABLE unrelated (id int)");
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_ADOPT_UNPROVABLE:0001_idempotency_outbox/);
}));

test("failure mid-run rolls back only the failing version; rerun after the fix completes", { skip }, () => withDb(async pool => {
  const dir = tmpCopy(); const file = join(dir, "0010_formal_watch_binding.up.sql");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, good.replace("COMMIT;", "ALTER TABLE no_such_table ADD COLUMN x int;\nCOMMIT;"));
  await assert.rejects(migrateDatabase(pool, dir), /no_such_table/);
  assert.deepEqual((await ledger(pool)).map(r => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal((await pool.query("SELECT to_regclass('public.apple_formal_watch_active_primary_uq') AS i")).rows[0].i, null);
  writeFileSync(file, good);
  const r = await migrateDatabase(pool, dir);
  assert.deepEqual(r.applied, names(10, HEAD));
}));

test("tampered ledger sha fails closed", { skip }, () => withDb(async pool => {
  await migrateDatabase(pool, MIGRATIONS);
  await pool.query("UPDATE paios_migrations.schema_migrations SET sha256 = repeat('0', 64) WHERE version = 11");
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_LEDGER_SHA_MISMATCH:0011_device_lease_renewal/);
}));

test("ledger gap and ledger version unknown to the migrations directory fail closed", { skip }, () => withDb(async pool => {
  await migrateDatabase(pool, MIGRATIONS);
  await pool.query("INSERT INTO paios_migrations.schema_migrations VALUES (22, 'future', repeat('1', 64), 'applied')");
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_LEDGER_UNKNOWN_VERSION:22/);
  await pool.query("DELETE FROM paios_migrations.schema_migrations WHERE version IN (5, 22)");
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_LEDGER_GAP:expected 5 found 6/);
}));

test("adoption proves every legacy prefix 0001..N exactly", { skip }, async () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16]) await withDb(async pool => {
    await rawApply(pool, n);
    const r = await migrateDatabase(pool, MIGRATIONS);
    assert.deepEqual([r.adopted, r.applied], [names(1, n), names(n + 1, HEAD)], `legacy ${n}`);
  });
});

test("ledgered version whose schema was dropped fails the final verification", { skip }, () => withDb(async pool => {
  await migrateDatabase(pool, MIGRATIONS);
  await pool.query("DROP TABLE paired_devices CASCADE");
  await assert.rejects(migrateDatabase(pool, MIGRATIONS), /MIGRATION_FINAL_VERIFY_FAILED:0013_paired_devices/);
}));

test("two concurrent migrators: one applies, the other waits and finds nothing to do", { skip }, () => withDb(async pool => {
  const [a, b] = await Promise.all([migrateDatabase(pool, MIGRATIONS), migrateDatabase(pool, MIGRATIONS)]);
  assert.deepEqual([a.applied.length, b.applied.length].sort(), [0, HEAD]);
  assert.equal((await ledger(pool)).length, HEAD);
}));

test("0014 preserves existing phone rows and admits several phones and glasses with per-key uniqueness", {skip}, () => withDb(async pool => {
  await rawApply(pool,13);
  const insert=async(id:number,deviceClass:string,key:number)=>pool.query(
    "INSERT INTO paired_devices (device_id,user_id,device_class,token_sha256,recipient_public_key,recipient_public_key_sha256,device_credential_ref,media,governance,status,paired_at) " +
    "VALUES ($1,'00000000-0000-7000-8000-000000000099',$2,$3,$4,$5,'{}',ARRAY['data'],'{}','active','2026-10-09T00:00:00Z')",
    [`00000000-0000-7000-8000-${String(id).padStart(12,'0')}`,deviceClass,String(id).padStart(64,'0'),Buffer.alloc(32,key).toString('base64url'),String(key).padStart(64,'0')]);
  await insert(1,'iphone',1);
  const original=(await pool.query('SELECT to_jsonb(paired_devices) AS value FROM paired_devices')).rows[0].value;
  await migrateDatabase(pool,MIGRATIONS);
  const migrated=(await pool.query("SELECT to_jsonb(paired_devices) AS value FROM paired_devices WHERE device_id = '00000000-0000-7000-8000-000000000001'")).rows[0].value;
  assert.deepEqual(Object.fromEntries(Object.keys(original).map(key=>[key,migrated[key]])),original);
  await insert(2,'iphone',2);await insert(3,'glasses',3);
  await assert.rejects(insert(4,'glasses',3),/paired_devices_active_key_uq/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM paired_devices')).rows[0].n,3);
  assert.deepEqual((await migrateDatabase(pool,MIGRATIONS)).applied,[],'rerun verifies both old and new migration contracts');
  const client=await pool.connect();
  try {
    const down=readFileSync(join(MIGRATIONS,'0014_paired_terminals.down.sql'),'utf8');
    await assert.rejects(client.query(down),/check constraint/,'active glasses prevent rollback');await client.query('ROLLBACK');
    await client.query("UPDATE paired_devices SET status='revoked', revoked_at=now() WHERE device_class='glasses'");
    await assert.rejects(client.query(down),/(duplicate key|could not create unique index)/,'multiple active phones prevent rollback');await client.query('ROLLBACK');
    await client.query("UPDATE paired_devices SET status='revoked', revoked_at=now() WHERE device_id='00000000-0000-7000-8000-000000000002'");
    await client.query(down);
    assert.equal((await client.query("SELECT status FROM paired_devices WHERE device_class='glasses'")).rows[0].status,'revoked','rollback preserves revoked glasses history');
  } finally {client.release();}
}));
