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

const RUN = process.env.PAIOS_RUN_BACKUP_RESTORE_PG === "1";
const SKIP_REASON = "set approved PAIOS_PG_* plus PAIOS_RUN_BACKUP_RESTORE_PG=1 and PAIOS_BACKUP_* metadata";

function metadata(): {
  readonly backupRoot: string;
  readonly migrationHead: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
  readonly lockTimeoutMs: number;
} {
  const backupRoot = process.env.PAIOS_BACKUP_ROOT;
  const migrationHead = process.env.PAIOS_BACKUP_MIGRATION_HEAD;
  const imageDigest = process.env.PAIOS_BACKUP_IMAGE_DIGEST;
  const schemaSha256 = process.env.PAIOS_BACKUP_SCHEMA_SHA256;
  const lockTimeoutMs = process.env.PAIOS_BACKUP_LOCK_TIMEOUT_MS === undefined
    ? 5_000
    : Number.parseInt(process.env.PAIOS_BACKUP_LOCK_TIMEOUT_MS, 10);
  if (backupRoot === undefined || migrationHead === undefined || imageDigest === undefined || schemaSha256 === undefined ||
      !Number.isSafeInteger(lockTimeoutMs)) throw new Error("BACKUP_TEST_METADATA_INVALID");
  return { backupRoot, migrationHead, imageDigest, schemaSha256: schemaSha256 as Sha256, lockTimeoutMs };
}

test("real PostgreSQL persistent writer barrier captures diagnostics and releases only after COMPLETE", {
  skip: !RUN || !isPostgresConfigured() ? SKIP_REASON : false,
  concurrency: false,
}, async () => {
  const pool = createPostgresPool();
  const barrier = new PostgresBackupRestoreBarrier(pool);
  const input = metadata();
  try {
    const protocolLines: string[] = [];
    const result = await runPersistentWriterBarrier(barrier, {
      ...input,
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
    assert.equal(ready.snapshot.migrationHead, input.migrationHead);
    assert.equal(ready.snapshot.imageDigest, input.imageDigest);
    assert.equal(ready.snapshot.schemaSha256, input.schemaSha256);
    assert.equal(released.snapshot_name, ready.snapshot.snapshotName);
    assert.equal(released.snapshot_sha256, ready.snapshot.diagnosticHashes.snapshotSha256);
    assert.equal(result.snapshot.migrationHead, input.migrationHead);
    assert.equal(result.snapshot.imageDigest, input.imageDigest);
    assert.equal(result.snapshot.schemaSha256, input.schemaSha256);
    assert.match(result.snapshot.snapshotName, /^diagnostic-[1-9][0-9]{0,37}-[1-9][0-9]{0,37}$/u);
    assert.equal(result.snapshot.tablespaces.includes("pg_default"), true);
    assert.equal(result.snapshot.tableCounts.realtime_sessions !== undefined, true);
    assert.equal(result.snapshot.tableCounts.realtime_external_effects !== undefined, true);
    assert.equal(result.snapshot.tableCounts.memory_candidate_heads !== undefined, true);
    assert.equal(result.snapshot.tableCounts.memory_slot_heads !== undefined, true);
    assert.match(result.snapshot.tableContentSha256.realtime_sessions, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.realtime_external_effects, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.memory_candidate_heads, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableContentSha256.memory_slot_heads, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.diagnosticHashes.snapshotSha256, /^[0-9a-f]{64}$/u);
    assert.match(result.snapshot.tableCounts.realtime_sessions, /^(0|[1-9][0-9]{0,37})$/u);
  } finally {
    await closePostgresPool(pool);
  }
});
