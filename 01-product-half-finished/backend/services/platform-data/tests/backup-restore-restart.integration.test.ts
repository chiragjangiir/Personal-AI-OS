import assert from "node:assert/strict";
import test from "node:test";

import {
  closePostgresPool,
  createPostgresPool,
  isPostgresConfigured,
} from "../src/postgres-pool.ts";
import {
  BACKUP_BASEBACKUP_COMPLETE_COMMAND,
  PostgresBackupRestoreBarrier,
  runPersistentWriterBarrier,
  type Sha256,
} from "../src/backup-restore-barrier.ts";

const RUN = process.env.PAIOS_RUN_BACKUP_RESTORE_RESTART === "1";
const BEFORE = process.env.PAIOS_BACKUP_POSTMASTER_BEFORE;
const AFTER = process.env.PAIOS_BACKUP_POSTMASTER_AFTER;
const HAS_METADATA = process.env.PAIOS_BACKUP_ROOT !== undefined &&
  process.env.PAIOS_BACKUP_MIGRATION_HEAD !== undefined &&
  process.env.PAIOS_BACKUP_IMAGE_DIGEST !== undefined &&
  process.env.PAIOS_BACKUP_SCHEMA_SHA256 !== undefined;
const SKIP_REASON = "T15 must perform the approved isolated stop/start and provide PAIOS_BACKUP_POSTMASTER_BEFORE/AFTER";

test("restored PostgreSQL keeps a new postmaster epoch and remains replay/snapshot-ready", {
  skip: !RUN || !isPostgresConfigured() || BEFORE === undefined || AFTER === undefined || !HAS_METADATA ? SKIP_REASON : false,
  concurrency: false,
}, async () => {
  assert.notEqual(BEFORE, AFTER);
  const pool = createPostgresPool();
  const barrier = new PostgresBackupRestoreBarrier(pool);
  const schemaSha256 = (process.env.PAIOS_BACKUP_SCHEMA_SHA256 ?? "").toLowerCase() as Sha256;
  try {
    const current = await pool.query("SELECT pg_postmaster_start_time()::text AS started_at");
    assert.equal(current.rows.length, 1);
    assert.equal(String(current.rows[0]?.started_at), AFTER);
    const protocolLines: string[] = [];
    const result = await runPersistentWriterBarrier(barrier, {
      backupRoot: process.env.PAIOS_BACKUP_ROOT ?? "",
      migrationHead: process.env.PAIOS_BACKUP_MIGRATION_HEAD ?? "",
      imageDigest: process.env.PAIOS_BACKUP_IMAGE_DIGEST ?? "",
      schemaSha256,
      lockTimeoutMs: 5_000,
      commandTimeoutMs: 60_000,
      io: {
        writeStdout(line) { protocolLines.push(line); },
        async readCommandLine() {
          return BACKUP_BASEBACKUP_COMPLETE_COMMAND;
        },
      },
    });
    assert.equal(protocolLines.length, 2);
    const ready = JSON.parse(protocolLines[0] ?? "{}");
    const released = JSON.parse(protocolLines[1] ?? "{}");
    assert.deepEqual(Object.keys(ready).sort(), ["protocol", "snapshot", "type"]);
    assert.deepEqual(Object.keys(released).sort(), ["protocol", "snapshot_name", "snapshot_sha256", "status", "type"]);
    assert.equal(released.snapshot_name, ready.snapshot.snapshotName);
    assert.equal(released.snapshot_sha256, ready.snapshot.diagnosticHashes.snapshotSha256);
    assert.match(result.snapshot.snapshotName, /^diagnostic-[1-9][0-9]{0,37}-[1-9][0-9]{0,37}$/u);
    assert.match(result.snapshot.diagnosticHashes.snapshotSha256, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.realtime_sessions, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.realtime_external_effects, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.memory_candidate_heads, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.memory_slot_heads, /^[0-9a-f]{64}$/u);
  } finally {
    await closePostgresPool(pool);
  }
});
