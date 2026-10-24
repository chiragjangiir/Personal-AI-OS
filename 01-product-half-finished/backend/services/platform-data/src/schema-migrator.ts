/**
 * The single authority for applying backend/migrations/NNNN_name.up.sql to the product database.
 *
 * State lives in one ledger table, paios_migrations.schema_migrations (version, name, sha256, origin, applied_at). Each
 * migration has a sibling NNNN_name.verify.sql returning one row (complete, touched) so schema knowledge stays with
 * the migration. Rules:
 *  - one session-level advisory lock serializes migrators;
 *  - ledgered rows must be the contiguous prefix 1..k of the files, with identical names and sha256 (else fail closed);
 *  - a non-empty database with no ledger is adopted only as far as the verifiers prove a contiguous complete prefix
 *    1..n with nothing of any later version present; gaps and partial versions fail closed;
 *  - each missing version runs in its own transaction with its ledger row and is verified before COMMIT;
 *  - `migrated` is returned only after every version is ledgered and verifies complete.
 * Migration files that carry their own outer BEGIN;/COMMIT; have exactly that pair stripped so the ledger row shares
 * their transaction; any other top-level transaction control is rejected.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrationFile { readonly version: number; readonly name: string; readonly sha256: string; readonly up: string; readonly verify: string }
export interface MigrationResult { readonly status: "migrated"; readonly adopted: readonly string[]; readonly applied: readonly string[]; readonly verified: number }

// Own schema, not public: migrations 0004/0005 assert the exact public table set, so a public ledger would break them.
const LEDGER = "paios_migrations.schema_migrations";
const LOCK_SQL = "SELECT pg_advisory_lock(hashtextextended('paios.schema_migrations', 0))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended('paios.schema_migrations', 0))";
const fail = (code: string, detail: string): never => { throw new Error(`MIGRATION_${code}:${detail}`); };
const label = (m: { version: number; name: string }) => `${String(m.version).padStart(4, "0")}_${m.name}`;

export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir);
  const ups = files.filter(f => f.endsWith(".up.sql")).sort();
  const result = ups.map((file): MigrationFile => {
    const match = /^(\d{4})_([a-z0-9_]+)\.up\.sql$/.exec(file);
    if (!match) return fail("FILE_NAME_INVALID", file);
    const base = file.slice(0, -".up.sql".length);
    if (!files.includes(`${base}.verify.sql`)) return fail("VERIFIER_MISSING", base);
    const up = readFileSync(join(dir, file), "utf8");
    return { version: Number(match[1]), name: match[2]!, sha256: createHash("sha256").update(up).digest("hex"), up,
      verify: readFileSync(join(dir, `${base}.verify.sql`), "utf8") };
  });
  result.forEach((m, i) => { if (m.version !== i + 1) fail("VERSION_SEQUENCE_INVALID", `expected ${i + 1} found ${m.version}`); });
  if (result.length === 0) fail("NO_MIGRATIONS", dir);
  return result;
}

const isNoise = (line: string) => line.trim() === "" || line.trim().startsWith("--");
/** Remove the outer BEGIN;/COMMIT; pair (the runner owns the transaction); reject any other top-level control. */
export function transactionBody(m: MigrationFile): string {
  const lines = m.up.split("\n");
  const first = lines.findIndex(l => !isNoise(l));
  let last = lines.length - 1;
  while (last >= 0 && isNoise(lines[last]!)) last--;
  const hasBegin = lines[first]?.trim().toUpperCase() === "BEGIN;";
  const hasCommit = lines[last]?.trim().toUpperCase() === "COMMIT;";
  if (hasBegin !== hasCommit) fail("TRANSACTION_CONTROL_UNBALANCED", label(m));
  const body = lines.filter((_, i) => !(hasBegin && (i === first || i === last))).join("\n");
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION)\s*;/im.test(body)) fail("TRANSACTION_CONTROL_UNSUPPORTED", label(m));
  return body;
}

type State = "complete" | "partial" | "absent";
async function state(client: PoolClient, m: MigrationFile): Promise<State> {
  const row = (await client.query(m.verify)).rows;
  if (row.length !== 1 || typeof row[0].complete !== "boolean" || typeof row[0].touched !== "boolean") fail("VERIFIER_CONTRACT", label(m));
  const { complete, touched } = row[0] as { complete: boolean; touched: boolean };
  return complete ? "complete" : touched ? "partial" : "absent";
}

async function adopt(client: PoolClient, migrations: MigrationFile[]): Promise<string[]> {
  const others = (await client.query(
    "SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'")).rows[0].n as number;
  if (others === 0) return [];
  const states: State[] = [];
  for (const m of migrations) states.push(await state(client, m));
  let n = 0;
  while (n < states.length && states[n] === "complete") n++;
  if (n === 0) fail("ADOPT_UNPROVABLE", `${label(migrations[0]!)} not provably applied in a non-empty database with no ledger`);
  for (let i = n; i < states.length; i++) {
    if (states[i] === "partial") fail("ADOPT_PARTIAL", `${label(migrations[i]!)} partially present`);
    if (states[i] === "complete") fail("ADOPT_GAP", `${label(migrations[i]!)} present but ${label(migrations[n]!)} is not provably applied`);
  }
  const adopted = migrations.slice(0, n);
  await client.query("BEGIN");
  try {
    for (const m of adopted) await client.query(
      `INSERT INTO ${LEDGER} (version, name, sha256, origin) VALUES ($1, $2, $3, 'adopted')`, [m.version, m.name, m.sha256]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  return adopted.map(label);
}

async function applyOne(client: PoolClient, m: MigrationFile): Promise<void> {
  const body = transactionBody(m);
  await client.query("BEGIN");
  try {
    await client.query(body);
    await client.query(`INSERT INTO ${LEDGER} (version, name, sha256, origin) VALUES ($1, $2, $3, 'applied')`, [m.version, m.name, m.sha256]);
    if (await state(client, m) !== "complete") fail("VERIFY_FAILED", label(m));
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function migrateDatabase(pool: Pool, migrationsDir: string): Promise<MigrationResult> {
  const migrations = loadMigrations(migrationsDir);
  const client = await pool.connect();
  try {
    await client.query(LOCK_SQL);
    await client.query("CREATE SCHEMA IF NOT EXISTS paios_migrations");
    await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
      version integer PRIMARY KEY CHECK (version > 0), name text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      origin text NOT NULL CHECK (origin IN ('applied', 'adopted')), applied_at timestamptz NOT NULL DEFAULT now())`);
    const readLedger = async () => (await client.query(`SELECT version, name, sha256 FROM ${LEDGER} ORDER BY version`)).rows as
      { version: number; name: string; sha256: string }[];
    let ledger = await readLedger();
    const adopted = ledger.length === 0 ? await adopt(client, migrations) : [];
    if (adopted.length > 0) ledger = await readLedger();
    ledger.forEach((row, i) => {
      const m = migrations[i];
      if (row.version !== i + 1) fail("LEDGER_GAP", `expected ${i + 1} found ${row.version}`);
      if (!m) fail("LEDGER_UNKNOWN_VERSION", String(row.version));
      else if (row.name !== m.name || row.sha256 !== m.sha256) fail("LEDGER_SHA_MISMATCH", label(m));
    });
    const applied: string[] = [];
    for (const m of migrations.slice(ledger.length)) { await applyOne(client, m); applied.push(label(m)); }
    for (const m of migrations) if (await state(client, m) !== "complete") fail("FINAL_VERIFY_FAILED", label(m));
    return { status: "migrated", adopted, applied, verified: migrations.length };
  } finally {
    try { await client.query(UNLOCK_SQL); } catch { /* connection already lost: session lock is released with it */ }
    client.release();
  }
}
