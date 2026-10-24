import type { WriterBarrierInput } from "../src/backup-restore-barrier.ts";
import { backupAuthorityScope } from "../src/backup-authority-contract.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  BACKUP_AUTHORITY_TABLES,
  BACKUP_BASEBACKUP_APPLICATION_NAME,
  BACKUP_MIGRATION_HEAD,
  BACKUP_RESTORE_SCHEMA_VERSION,
  BackupRestoreBarrierError,
  LOCK_TABLE_STATEMENT,
  PostgresBackupRestoreBarrier,
  TABLE_COUNT_STATEMENT,
  BACKUP_BASEBACKUP_ABORT_COMMAND,
  BACKUP_BASEBACKUP_COMPLETE_COMMAND,
  readBackupRestoreCliConfig,
  readSingleBackupCommand,
  runPersistentWriterBarrier,
  compareReplay,
  type PgDiagnosticSnapshot,
} from "../src/backup-restore-barrier.ts";

const IMAGE = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SCHEMA_COMPONENTS = ["fixture-schema-v1"] as const;
const SCHEMA_HASH = createHash("sha256").update(JSON.stringify(SCHEMA_COMPONENTS), "utf8").digest("hex");
const HASH = SCHEMA_HASH;
const MIGRATION_HEAD = BACKUP_MIGRATION_HEAD;
const BACKUP_ROOT = "C:\\ProgramData\\PersonalAIOS\\paios-runtime-data\\backup-restore-001";

function tableRows(): Array<Record<string, string>> {
  return BACKUP_AUTHORITY_TABLES.map((table) => ({ table_name: table, row_count: "0" }));
}

function activityRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pid: "123",
    database_name: "personal_ai_os",
    user_name: "paios",
    application_name: "",
    client_addr: null,
    backend_type: "client backend",
    state: "active",
    wait_event_type: null,
    wait_event: null,
    query: "SELECT pg_stat_activity",
    blocking_pids: "[]",
    ...overrides,
  };
}

type PgCatalogTableRow = {
  schema_name: string;
  table_name: string;
  relkind: string;
};

class FakeClient {
  readonly statements: string[] = [];
  readonly params: unknown[][] = [];
  readonly tableCountRows = tableRows();
  catalogRows: PgCatalogTableRow[] = BACKUP_AUTHORITY_TABLES.map((table) => ({ schema_name: "public", table_name: table, relkind: "r" }));
  readonly schemaFingerprintRows = SCHEMA_COMPONENTS.map((schema_component) => ({ schema_component }));
  readonly tableContentRows = new Map(BACKUP_AUTHORITY_TABLES.map((table) => [table, [] as readonly Record<string, unknown>[]]));
  activityRows: readonly Record<string, unknown>[] = [activityRow()];
  readonly activityQueue: Array<readonly Record<string, unknown>[]> = [];
  readonly idempotencyRows: readonly Record<string, unknown>[] = [];
  readonly outboxRows: readonly Record<string, unknown>[] = [];
  readonly dedupeRows: Record<string, unknown>[] = [];
  readonly tablespaceRows = [{ tablespace_name: "pg_default" }, { tablespace_name: "pg_global" }];
  readonly events: string[] = [];
  throwOnLock: { readonly code: string } | undefined;
  released = false;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: readonly Record<string, unknown>[] }> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    this.params.push([...params]);
    if (normalized.startsWith("SELECT n.nspname AS schema_name") || normalized.startsWith("SELECT n.nspname AS namespace")) return { rows: [] };
    if (normalized.startsWith("BEGIN")) { this.events.push("begin"); return { rows: [] }; }
    if (normalized.startsWith("SELECT set_config")) { this.events.push("set_config"); return { rows: [{ set_config: "5000ms" }] }; }
    if (normalized.startsWith("LOCK TABLE")) {
      this.events.push("lock");
      if (this.throwOnLock !== undefined) throw this.throwOnLock;
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT pg_backend_pid")) {
      return { rows: [{ backend_pid: "123", database_name: "personal_ai_os", system_identifier: "456" }] };
    }
    if (normalized.startsWith("SELECT txid_current")) {
      return { rows: [{ transaction_id: "789", wal_lsn: "0/16B6C50", transaction_timestamp: "2026-08-23T12:00:00.000Z", wall_clock_timestamp: "2026-08-23T12:00:00.100Z" }] };
    }
    if (normalized.startsWith("SELECT n.nspname::text")) { this.events.push("catalog"); return { rows: this.catalogRows }; }
    if (normalized.startsWith("WITH catalog_components")) { this.events.push("schema"); return { rows: this.schemaFingerprintRows }; }
    if (normalized.startsWith("SELECT 'device_leases'")) return { rows: this.tableCountRows };
    if (normalized.startsWith("SELECT to_jsonb(source_row)")) {
      const table = BACKUP_AUTHORITY_TABLES.find((candidate) => normalized.includes(`FROM (SELECT * FROM public.${candidate})`));
      return { rows: table === undefined ? [] : (this.tableContentRows.get(table) ?? []) };
    }
    if (normalized.startsWith("SELECT scope::text")) return { rows: this.idempotencyRows };
    if (normalized.startsWith("SELECT idempotency_scope::text")) return { rows: this.outboxRows };
    if (normalized.startsWith("SELECT consumer_name::text")) return { rows: this.dedupeRows };
    if (normalized.startsWith("SELECT spcname::text")) return { rows: this.tablespaceRows };
    if (normalized.startsWith("SELECT pid::text")) return { rows: this.activityQueue.shift() ?? this.activityRows };
    if (normalized.startsWith("COMMIT")) { this.events.push("commit"); return { rows: [] }; }
    if (normalized.startsWith("ROLLBACK")) { this.events.push("rollback"); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${normalized}`);
  }

  release(): void {
    this.released = true;
    this.events.push("release");
  }
}

function poolFor(client: FakeClient): any {
  return { connect: async () => client };
}

async function snapshotFixture(): Promise<{ barrier: PostgresBackupRestoreBarrier; client: FakeClient; snapshot: PgDiagnosticSnapshot }> {
  const client = new FakeClient();
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  const snapshot = await barrier.captureDiagnosticSnapshot({
    client: client as any,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
  });
  return { barrier, client, snapshot };
}

test("dedupe snapshot producer emits UTC ISO timestamps with PostgreSQL microsecond precision", async () => {
  const client = new FakeClient();
  const row = {
    consumer_name: "unit-consumer", event_id: "11111111-1111-4111-8111-111111111111",
    payload_hash: HASH, processed_at: "2026-08-23T12:00:00.123456Z",
  };
  client.dedupeRows.push(row);
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  const snapshot = await barrier.captureDiagnosticSnapshot({
    client: client as any, migrationHead: MIGRATION_HEAD, imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
  });
  const sql = client.statements.find(statement => statement.startsWith("SELECT consumer_name::text"));
  assert.ok(sql);
  assert.match(sql, /to_char\(processed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'\) AS processed_at/u);
  assert.doesNotMatch(sql, /processed_at::text/u);
  assert.equal(snapshot.outbox.consumerDedupeRowsSha256,
    createHash("sha256").update(JSON.stringify([row]), "utf8").digest("hex"));
});

test("current schema is exactly the four bound migrations and the closed 18-table barrier set", () => {
  const migrationRoot = resolve(import.meta.dirname ?? ".", "../../../migrations");
  const migrationFiles = [
    "0001_idempotency_outbox.up.sql",
    "0002_realtime_authority.up.sql",
    "0003_memory_authority.up.sql",
    "0004_memory_append_only_lifecycle.up.sql",
  ];
  const createdTables = migrationFiles.flatMap((file) => {
    const sql = readFileSync(resolve(migrationRoot, file), "utf8");
    return [...sql.matchAll(/^[ \t]*CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gimu)].map((match) => match[1]);
  });
  assert.equal(createdTables.length, BACKUP_AUTHORITY_TABLES.length);
  assert.deepEqual([...new Set(createdTables)].sort(), [...BACKUP_AUTHORITY_TABLES]);
  assert.deepEqual([...BACKUP_AUTHORITY_TABLES].sort(), [...new Set(createdTables)].sort());
});

test("catalog enumeration and normalized fingerprint fail closed for missing, unknown, or echoed schema", async () => {
  const missing = new FakeClient();
  missing.catalogRows.pop();
  await assert.rejects(
    () => new PostgresBackupRestoreBarrier(poolFor(missing)).captureDiagnosticSnapshot({
      client: missing as any, migrationHead: MIGRATION_HEAD, imageDigest: IMAGE, schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SCHEMA_MISMATCH",
  );
  const unknown = new FakeClient();
  unknown.catalogRows[0] = { schema_name: "public", table_name: "artifact", relkind: "r" };
  await assert.rejects(
    () => new PostgresBackupRestoreBarrier(poolFor(unknown)).captureDiagnosticSnapshot({
      client: unknown as any, migrationHead: MIGRATION_HEAD, imageDigest: IMAGE, schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SCHEMA_MISMATCH",
  );
  const echoed = new FakeClient();
  await assert.rejects(
    () => new PostgresBackupRestoreBarrier(poolFor(echoed)).captureDiagnosticSnapshot({
      client: echoed as any, migrationHead: MIGRATION_HEAD, imageDigest: IMAGE,
      schemaSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as PgDiagnosticSnapshot["schemaSha256"],
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SCHEMA_MISMATCH",
  );
});

test("writer barrier uses one connection/transaction, stable table locks, and holds them through the callback", async () => {
  const client = new FakeClient();
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  const callbackEvents: string[] = [];
  const result = await barrier.withWriterBarrier({
    backupRoot: BACKUP_ROOT,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
    lockTimeoutMs: 5_000,
    async runBasebackup(context) {
      callbackEvents.push(context.snapshot.snapshotName);
      assert.equal(context.backupRoot, BACKUP_ROOT);
      assert.equal(context.snapshotName, context.snapshot.snapshotName);
      assert.equal(client.events.includes("commit"), false);
      return context.snapshot.diagnosticHashes.snapshotSha256;
    },
  });
  assert.match(result, /^[0-9a-f]{64}$/u);
  assert.deepEqual(callbackEvents, ["diagnostic-123-789"]);
  assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "schema", "commit", "release"]);
  assert.equal(client.statements.filter((statement) => statement.startsWith("BEGIN")).length, 1);
  assert.equal(client.statements.filter((statement) => statement.startsWith("LOCK TABLE")).length, 1);
  assert.equal(client.statements.find((statement) => statement.startsWith("LOCK TABLE")), LOCK_TABLE_STATEMENT);
  assert.match(TABLE_COUNT_STATEMENT, /count\(\*\)::text AS row_count/u);
  assert.equal(client.params.find((params) => params[0] === "5000ms")?.[0], "5000ms");
});

test("persistent IPC emits READY before waiting, holds the same transaction, and emits RELEASED only after COMPLETE", async () => {
  const client = new FakeClient();
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  const lines: string[] = [];
  let commandStarted!: () => void;
  let resolveCommand!: (command: string) => void;
  const commandReady = new Promise<void>((resolve) => { commandStarted = resolve; });
  const command = new Promise<string>((resolve) => { resolveCommand = resolve; });
  const run = runPersistentWriterBarrier(barrier, {
    backupRoot: BACKUP_ROOT,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
    commandTimeoutMs: 1_000,
    io: {
      writeStdout(line) { lines.push(line); },
      async readCommandLine() {
        commandStarted();
        return command;
      },
    },
  });
  await commandReady;
  assert.equal(lines.length, 1);
  const ready = JSON.parse(lines[0] ?? "{}");
  assert.deepEqual(Object.keys(ready).sort(), ["protocol", "snapshot", "type"]);
  assert.deepEqual(Object.keys(ready.snapshot).sort(), [
    "backendPid", "capturedAt", "clock", "databaseName", "diagnosticHashes", "idempotency",
    "imageDigest", "migrationHead", "outbox", "schemaSha256", "schemaVersion", "snapshotName",
    "systemIdentifier", "tableContentSha256", "tableCounts", "tablespaces",
  ]);
  assert.equal(ready.snapshot.diagnosticHashes.snapshotSha256.length, 64);
  assert.equal(JSON.stringify(ready).includes("row_json"), false);
  assert.equal(lines[0]?.includes("password"), false);
  assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "schema"]);
  resolveCommand(BACKUP_BASEBACKUP_COMPLETE_COMMAND);
  const result = await run;
  assert.match(result.snapshot.diagnosticHashes.snapshotSha256, /^[0-9a-f]{64}$/u);
  assert.equal(lines.length, 2);
  const released = JSON.parse(lines[1] ?? "{}");
  assert.deepEqual(Object.keys(released).sort(), ["protocol", "snapshot_name", "snapshot_sha256", "status", "type"]);
  assert.equal(released.snapshot_name, result.snapshot.snapshotName);
  assert.equal(released.snapshot_sha256, result.snapshot.diagnosticHashes.snapshotSha256);
  assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "schema", "commit", "release"]);
});

test("persistent IPC abort, EOF, timeout, and malformed command all roll back and release", async () => {
  const cases: readonly [string, string, BackupRestoreBarrierError["code"]][] = [
    ["abort", BACKUP_BASEBACKUP_ABORT_COMMAND, "BACKUP_PROTOCOL_ABORT"],
    ["eof", "", "BACKUP_PROTOCOL_EOF"],
    ["timeout", "", "BACKUP_PROTOCOL_TIMEOUT"],
    ["malformed", "bad-command", "BACKUP_PROTOCOL_INVALID"],
  ];
  for (const [name, command, expectedCode] of cases) {
    const client = new FakeClient();
    const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
    const lines: string[] = [];
    await assert.rejects(
      () => runPersistentWriterBarrier(barrier, {
        backupRoot: BACKUP_ROOT,
        migrationHead: MIGRATION_HEAD,
        imageDigest: IMAGE,
        schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
        commandTimeoutMs: 10,
        io: {
          writeStdout(line) { lines.push(line); },
          async readCommandLine() {
            if (name === "timeout") throw new BackupRestoreBarrierError("BACKUP_PROTOCOL_TIMEOUT");
            if (name === "eof") throw new BackupRestoreBarrierError("BACKUP_PROTOCOL_EOF");
            return command;
          },
        },
      }),
      (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === expectedCode,
    );
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? "{}").type, "READY");
    assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "schema", "rollback", "release"]);
  }
});

test("stdin parser is strict single-line and rejects extra protocol data", async () => {
  const input = new PassThrough();
  const read = readSingleBackupCommand(input, 1_000);
  input.end(`${BACKUP_BASEBACKUP_COMPLETE_COMMAND}\nEXTRA\n`);
  await assert.rejects(
    () => read,
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_PROTOCOL_INVALID",
  );
});

test("persistent CLI configuration fails closed when the fixture secret is absent", () => {
  assert.throws(
    () => readBackupRestoreCliConfig({
      PAIOS_BACKUP_ROOT: BACKUP_ROOT,
      PAIOS_BACKUP_MIGRATION_HEAD: MIGRATION_HEAD,
      PAIOS_BACKUP_IMAGE_DIGEST: IMAGE,
      PAIOS_BACKUP_SCHEMA_SHA256: HASH,
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SECRET_ABSENT",
  );
});

test("persistent CLI configuration closes the fixed basebackup application name", () => {
  const config = readBackupRestoreCliConfig({
    PAIOS_PG_PASSWORD: "fixture-secret",
    PAIOS_BACKUP_ROOT: BACKUP_ROOT,
    PAIOS_BACKUP_MIGRATION_HEAD: MIGRATION_HEAD,
    PAIOS_BACKUP_IMAGE_DIGEST: IMAGE,
    PAIOS_BACKUP_SCHEMA_SHA256: HASH,
  });
  assert.equal(config.basebackupApplicationName, BACKUP_BASEBACKUP_APPLICATION_NAME);
});

test("lock timeout fails closed, rolls back, releases the client, and never terminates the process", async () => {
  const client = new FakeClient();
  client.throwOnLock = { code: "55P03" };
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  await assert.rejects(
    () => barrier.withWriterBarrier({
      backupRoot: BACKUP_ROOT,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
      async runBasebackup() { throw new Error("must not run"); },
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_LOCK_TIMEOUT",
  );
  assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "rollback", "release"]);
});

test("activity barrier rejects unknown idle/read/write/waiting clients and pseudo walsenders", async () => {
  const variants = [
    { state: "idle", query: "SELECT 1" },
    { state: "active", query: "SELECT * FROM realtime_sessions" },
    { state: "active", query: "UPDATE realtime_sessions SET state = 'x'" },
    { state: "active", wait_event_type: "Lock", wait_event: "transactionid" },
    { backend_type: "client backend", application_name: "paios-pg-basebackup-001", state: "streaming" },
  ];
  for (const variant of variants) {
    const client = new FakeClient();
    client.activityRows = [activityRow(), activityRow({ pid: "999", ...variant })];
    const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
    await assert.rejects(
      () => barrier.withWriterBarrier({
        backupRoot: BACKUP_ROOT,
        migrationHead: MIGRATION_HEAD,
        imageDigest: IMAGE,
        schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
        async runBasebackup() { throw new Error("must not run"); },
      }),
      (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_LOCK_CONFLICT",
    );
    assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "schema", "rollback", "release"]);
  }
});

test("activity barrier permits only an accurately identified basebackup walsender during the callback", async () => {
  const client = new FakeClient();
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  const walsender = activityRow({
    pid: "999",
    application_name: "paios-pg-basebackup-001",
    backend_type: "walsender",
    state: "streaming",
    wait_event_type: "Activity",
    wait_event: "WalSenderMain",
    query: "START_REPLICATION 0/16B6C50 TIMELINE 1",
  });
  const basebackupWalsender = activityRow({
    pid: "1000",
    application_name: "paios-pg-basebackup-001",
    backend_type: "walsender",
    state: "active",
    wait_event_type: "IO",
    wait_event: "BasebackupRead",
    query: "BASE_BACKUP LABEL 'paios'",
  });
  const result = await barrier.withWriterBarrier({
    backupRoot: BACKUP_ROOT,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
    monitorIntervalMs: 1,
    async runBasebackup(context) {
      client.activityRows = [activityRow(), walsender, basebackupWalsender];
      assert.equal(context.signal.aborted, false);
      return context.snapshot.diagnosticHashes.snapshotSha256;
    },
  });
  assert.match(result, /^[0-9a-f]{64}$/u);
});

test("monitoring an unknown client aborts stdin, rolls back, and emits no RELEASED line", async () => {
  const client = new FakeClient();
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  client.activityQueue.push([activityRow()], [activityRow(), activityRow({ pid: "999", state: "idle" })]);
  const lines: string[] = [];
  await assert.rejects(
    () => runPersistentWriterBarrier(barrier, {
      backupRoot: BACKUP_ROOT,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
      monitorIntervalMs: 1,
      commandTimeoutMs: 1_000,
      io: {
        writeStdout(line) { lines.push(line); },
        async readCommandLine(_timeoutMs, signal) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new BackupRestoreBarrierError("BACKUP_PROTOCOL_ABORT")), { once: true });
          });
          return BACKUP_BASEBACKUP_COMPLETE_COMMAND;
        },
      },
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_LOCK_CONFLICT",
  );
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? "{}").type, "READY");
  assert.deepEqual(client.events, ["begin", "set_config", "catalog", "lock", "schema", "rollback", "release"]);
});

test("table content hash rejects same-count drift and ignores row order", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  for (const client of [first, second]) {
    const count = client.tableCountRows.find((row) => row.table_name === "device_leases");
    if (count === undefined) throw new Error("fixture count missing");
    count.row_count = "2";
  }
  first.tableContentRows.set("device_leases", [
    { row_json: '{"id":"a","amount":1}' },
    { row_json: '{"id":"b","amount":2}' },
  ]);
  second.tableContentRows.set("device_leases", [
    { row_json: '{"id":"b","amount":2}' },
    { row_json: '{"id":"a","amount":1}' },
  ]);
  const firstSnapshot = await new PostgresBackupRestoreBarrier(poolFor(first)).captureDiagnosticSnapshot({
    client: first as any,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
  });
  const secondSnapshot = await new PostgresBackupRestoreBarrier(poolFor(second)).captureDiagnosticSnapshot({
    client: second as any,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
  });
  assert.equal(firstSnapshot.tableContentSha256.device_leases, secondSnapshot.tableContentSha256.device_leases);

  const drift = new FakeClient();
  const driftCount = drift.tableCountRows.find((row) => row.table_name === "device_leases");
  if (driftCount === undefined) throw new Error("fixture count missing");
  driftCount.row_count = "2";
  drift.tableContentRows.set("device_leases", [
    { row_json: '{"id":"changed-a"}' },
    { row_json: '{"id":"changed-b"}' },
  ]);
  const driftSnapshot = await new PostgresBackupRestoreBarrier(poolFor(drift)).captureDiagnosticSnapshot({
    client: drift as any,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
  });
  const replay = { replay: [], snapshot: firstSnapshot };
  const driftReplay = { replay: [], snapshot: driftSnapshot };
  assert.equal(compareReplay(replay, driftReplay).equal, false);

  const partial = new FakeClient();
  const partialCount = partial.tableCountRows.find((row) => row.table_name === "device_leases");
  if (partialCount === undefined) throw new Error("fixture count missing");
  partialCount.row_count = "1";
  partial.tableContentRows.set("device_leases", [
    { row_json: '{"id":"a"}' },
    { row_json: '{"id":"b"}' },
  ]);
  await assert.rejects(
    () => new PostgresBackupRestoreBarrier(poolFor(partial)).captureDiagnosticSnapshot({
      client: partial as any,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SNAPSHOT_CONFLICT",
  );
});

test("unknown pool connection fails closed without attempting process termination", async () => {
  const barrier = new PostgresBackupRestoreBarrier({ connect: async () => undefined } as any);
  await assert.rejects(
    () => barrier.withWriterBarrier({
      backupRoot: BACKUP_ROOT,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"],
      async runBasebackup() { throw new Error("must not run"); },
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_CONNECTION_UNKNOWN",
  );
});

test("diagnostic snapshot is closed, complete, decimal-string safe, and rejects partial/unknown rows", async () => {
  const { snapshot } = await snapshotFixture();
  assert.equal(snapshot.systemIdentifier, "456");
  assert.equal(snapshot.clock.transactionId, "789");
  assert.equal(snapshot.tableCounts.realtime_sessions, "0");
  assert.match(snapshot.tableContentSha256.realtime_sessions, /^[0-9a-f]{64}$/u);
  assert.equal(snapshot.idempotency.rowCount, "0");
  assert.equal(snapshot.outbox.rowCount, "0");
  assert.deepEqual(snapshot.tablespaces, ["pg_default", "pg_global"]);
  const client = new FakeClient();
  client.tableCountRows.pop();
  const barrier = new PostgresBackupRestoreBarrier(poolFor(client));
  await assert.rejects(
    () => barrier.captureDiagnosticSnapshot({ client: client as any, migrationHead: MIGRATION_HEAD, imageDigest: IMAGE, schemaSha256: HASH as PgDiagnosticSnapshot["schemaSha256"] }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SNAPSHOT_PARTIAL",
  );
});

test("manifest verifier binds migration/image/schema/root, default tablespaces, and snapshot diagnostics", async () => {
  const { barrier, snapshot } = await snapshotFixture();
  const manifest = {
    schemaVersion: BACKUP_RESTORE_SCHEMA_VERSION,
    backupRoot: BACKUP_ROOT,
    systemIdentifier: snapshot.systemIdentifier,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: snapshot.schemaSha256,
    snapshot,
    basebackup: {
      completed: true,
      backupLabelSha256: HASH,
      backupManifestSha256: HASH,
      walStartLsn: "0/16B6C50",
      walEndLsn: "0/16B6D00",
    },
  };
  const verified = barrier.verifyBackupManifest(manifest, {
    backupRoot: BACKUP_ROOT,
    systemIdentifier: snapshot.systemIdentifier,
    migrationHead: MIGRATION_HEAD,
    imageDigest: IMAGE,
    schemaSha256: snapshot.schemaSha256,
  });
  assert.equal(verified.verified, true);
  assert.match(verified.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.throws(
    () => barrier.verifyBackupManifest({ ...manifest, unexpected: true }, {
      backupRoot: BACKUP_ROOT,
      systemIdentifier: snapshot.systemIdentifier,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: snapshot.schemaSha256,
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_MANIFEST_INVALID",
  );
  assert.throws(
    () => barrier.verifyBackupManifest({ ...manifest, snapshot: { ...snapshot, tablespaces: ["pg_default", "custom_ts"] } }, {
      backupRoot: BACKUP_ROOT,
      systemIdentifier: snapshot.systemIdentifier,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: snapshot.schemaSha256,
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_SNAPSHOT_CONFLICT",
  );
  assert.throws(
    () => barrier.verifyBackupManifest({
      ...manifest,
      snapshot: {
        ...snapshot,
        tableContentSha256: {
          ...snapshot.tableContentSha256,
          realtime_sessions: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      },
    }, {
      backupRoot: BACKUP_ROOT,
      systemIdentifier: snapshot.systemIdentifier,
      migrationHead: MIGRATION_HEAD,
      imageDigest: IMAGE,
      schemaSha256: snapshot.schemaSha256,
    }),
    (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_MANIFEST_INVALID",
  );
});

test("replay comparator is deterministic and fails closed for partial/duplicate observations", () => {
  const observation = {
    scope: "scope-1",
    idempotencyKey: "key-1",
    requestHash: HASH,
    responseHash: HASH,
    status: "committed" as const,
    response: { accepted: true },
    terminalFactIds: ["fact-1"],
    outboxEventIds: ["event-1"],
  };
  const equal = compareReplay([observation], [{ ...observation, response: { accepted: true } }]);
  assert.equal(equal.equal, true);
  assert.equal(equal.mismatchCount, "0");
  const different = compareReplay([observation], [{ ...observation, responseHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
  assert.equal(different.equal, false);
  assert.equal(different.mismatchCount, "1");
  assert.throws(() => compareReplay([observation, observation], [observation]), /BACKUP_REPLAY_INPUT_INVALID/);
  assert.throws(() => compareReplay([{ ...observation, extra: true }], [observation]), /BACKUP_REPLAY_INPUT_INVALID/);
});

// The current migration contract requires an explicit L3 namespace at the CLI boundary.
function namespaceCliEnv(head: string, namespace?: string): Record<string, string | undefined> {
  return {
    PAIOS_PG_PASSWORD: "fixture-secret",
    PAIOS_BACKUP_ROOT: BACKUP_ROOT,
    PAIOS_BACKUP_MIGRATION_HEAD: head,
    PAIOS_BACKUP_IMAGE_DIGEST: IMAGE,
    PAIOS_BACKUP_SCHEMA_SHA256: HASH,
    ...(namespace === undefined ? {} : {PAIOS_BACKUP_L3_NAMESPACE: namespace}),
  };
}

for (const head of ["0011_device_lease_renewal", "0012_l3_payload_audit_split"]) {
  test(`${head} CLI forwards the explicit namespace through the persistent seam`, async () => {
    const namespace = "paios_fixture_backup_contract";
    const config = readBackupRestoreCliConfig(namespaceCliEnv(head, namespace));
    assert.equal(config.l3Namespace, namespace);
    const reachedScope = new Error("original scope boundary reached");
    let calls = 0;
    class ScopeBoundary extends PostgresBackupRestoreBarrier {
      override async withWriterBarrier<T>(input: WriterBarrierInput<T>): Promise<T> {
        calls += 1;
        assert.equal(input.l3Namespace, namespace);
        const scope = backupAuthorityScope(input.migrationHead, BACKUP_AUTHORITY_TABLES, input.l3Namespace);
        assert.equal(scope.current, true);
        assert.equal(scope.l3Namespace, namespace);
        throw reachedScope;
      }
    }
    await assert.rejects(runPersistentWriterBarrier(new ScopeBoundary(poolFor(new FakeClient())), {
      ...config,
      io: {
        writeStdout() { assert.fail("must not publish before the scope boundary returns"); },
        async readCommandLine() { assert.fail("must not wait before the scope boundary returns"); },
      },
    }), (error: unknown) => error === reachedScope);
    assert.equal(calls, 1);
  });

  test(`${head} missing or invalid namespace fails before persistent dispatch`, async () => {
    for (const namespace of [undefined, "", "UPPER", "bad;namespace", "nested.schema", "x".repeat(64)]) {
      assert.throws(() => readBackupRestoreCliConfig(namespaceCliEnv(head, namespace)),
        (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_INPUT_INVALID");
      let calls = 0;
      class UnexpectedBoundary extends PostgresBackupRestoreBarrier {
        override async withWriterBarrier<T>(_input: WriterBarrierInput<T>): Promise<T> {
          calls += 1;
          throw new Error("invalid namespace reached writer barrier");
        }
      }
      const legacy = readBackupRestoreCliConfig(namespaceCliEnv(MIGRATION_HEAD));
      await assert.rejects(runPersistentWriterBarrier(new UnexpectedBoundary(poolFor(new FakeClient())), {
        ...legacy, migrationHead: head,
        ...(namespace === undefined ? {} : {l3Namespace: namespace}),
        io: {
          writeStdout() { assert.fail("invalid namespace published protocol"); },
          async readCommandLine() { assert.fail("invalid namespace waited for protocol"); },
        },
      }), (error: unknown) => error instanceof BackupRestoreBarrierError && error.code === "BACKUP_PROTOCOL_INVALID");
      assert.equal(calls, 0);
    }
  });

  test(`${head} owns the exact L3 table and sequence scope`, () => {
    const namespace = "paios_fixture_backup_contract";
    const scope = backupAuthorityScope(head, BACKUP_AUTHORITY_TABLES, namespace);
    assert.equal(scope.current, true);
    const expectedL3 = ["paios_l3_dependencies", "paios_l3_heads", "paios_l3_invalidations", "paios_l3_receipts", "paios_l3_versions",
      ...(head === "0012_l3_payload_audit_split" ? ["paios_l3_payloads", "paios_l3_forgotten"] : [])];
    assert.deepEqual(scope.tables, [...BACKUP_AUTHORITY_TABLES, "apple_physical_canary_bindings",
      ...expectedL3.map(name => `${namespace}.${name}`)].sort());
    assert.equal(expectedL3.length, head === "0012_l3_payload_audit_split" ? 7 : 5);
    assert.deepEqual(scope.sequences, ["outbox_events_accepted_activity_cursor_seq", `${namespace}.paios_l3_watermark`].sort());
    assert.deepEqual(scope.namespaces, ["public", namespace]);
  });
}

test("legacy 0004 CLI preserves its closed shape and public scope", () => {
  const config = readBackupRestoreCliConfig(namespaceCliEnv(MIGRATION_HEAD));
  assert.deepEqual(config, {
    backupRoot: BACKUP_ROOT, migrationHead: MIGRATION_HEAD, imageDigest: IMAGE, schemaSha256: HASH,
    lockTimeoutMs: 5_000, commandTimeoutMs: 300_000, basebackupApplicationName: BACKUP_BASEBACKUP_APPLICATION_NAME,
  });
  assert.deepEqual(readBackupRestoreCliConfig(namespaceCliEnv(MIGRATION_HEAD, "ignored_legacy_namespace")), config);
  assert.equal(Object.hasOwn(config, "l3Namespace"), false);
  const scope = backupAuthorityScope(MIGRATION_HEAD, BACKUP_AUTHORITY_TABLES);
  assert.equal(scope.current, false);
  assert.deepEqual(scope.tables, BACKUP_AUTHORITY_TABLES);
  assert.deepEqual(scope.sequences, []);
  assert.deepEqual(scope.namespaces, ["public"]);
});
