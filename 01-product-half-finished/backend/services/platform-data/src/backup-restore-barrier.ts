import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { closePostgresPool, createPostgresPool } from "./postgres-pool.ts";
import {CURRENT_BACKUP_MIGRATION_HEAD,isCurrentBackupHead, backupAuthorityScope, backupRelationSql, verifyBackupMigrationSources,
  verifyBackupSequenceScope, BACKUP_SEQUENCE_FINGERPRINT_COMPONENTS} from "./backup-authority-contract.ts";

/** Closed version of the T02 backup/restore diagnostic contract. */
export const BACKUP_RESTORE_SCHEMA_VERSION = "t02.backup-restore.v1" as const;
export const BACKUP_MIGRATION_HEAD = "0004_memory_append_only_lifecycle" as const;

export const DEFAULT_BACKUP_LOCK_TIMEOUT_MS = 5_000;
export const MAX_BACKUP_LOCK_TIMEOUT_MS = 30_000;
export const DEFAULT_BACKUP_COMMAND_TIMEOUT_MS = 300_000;
export const MAX_BACKUP_COMMAND_TIMEOUT_MS = 900_000;
export const DEFAULT_BACKUP_MONITOR_INTERVAL_MS = 250;
export const MAX_BACKUP_MONITOR_INTERVAL_MS = 5_000;
export const MAX_BACKUP_TABLE_CONTENT_ROWS = 100_000;
export const BACKUP_BASEBACKUP_COMPLETE_COMMAND = "PAIOS_BASEBACKUP_COMPLETE" as const;
export const BACKUP_BASEBACKUP_ABORT_COMMAND = "PAIOS_BASEBACKUP_ABORT" as const;
export const BACKUP_BARRIER_PROTOCOL = "paios.backup-restore.writer-barrier.v1" as const;
export const BACKUP_BASEBACKUP_APPLICATION_NAME = "paios-pg-basebackup-001" as const;

/**
 * Every table that can carry authoritative state, idempotency, terminal, or
 * outbox facts is locked in this exact lexical order.  Keep this list closed;
 * adding a table requires a new contract review and a new migration binding.
 */
export const BACKUP_AUTHORITY_TABLES = Object.freeze([
  "device_leases",
  "idempotency_ledger",
  "memory_authority_clock",
  "memory_candidate_heads",
  "memory_candidates",
  "memory_deletion_mutations",
  "memory_derived_projections",
  "memory_dream_deltas",
  "memory_rebuild_runs",
  "memory_slot_heads",
  "memory_versions",
  "outbox_consumer_dedupe",
  "outbox_events",
  "realtime_external_effects",
  "realtime_handoff_facts",
  "realtime_sessions",
  "realtime_terminal_facts",
  "realtime_transport_aliases",
] as const);

export type BackupAuthorityTable = string;
export type Sha256 = string & { readonly __backupRestoreSha256: unique symbol };
export type PositiveDecimalString = string & { readonly __backupRestoreDecimal: unique symbol };

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]{0,37}$/u;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,37})$/u;
const LSN_PATTERN = /^[0-9A-F]+\/[0-9A-F]+$/iu;
const DIAGNOSTIC_SNAPSHOT_PATTERN = /^diagnostic-[1-9][0-9]{0,37}-[1-9][0-9]{0,37}$/u;
const ALLOWED_TABLESPACES = Object.freeze(["pg_default", "pg_global"] as const);

export type BackupRestoreBarrierErrorCode =
  | "BACKUP_INPUT_INVALID"
  | "BACKUP_CONNECTION_UNKNOWN"
  | "BACKUP_LOCK_TIMEOUT"
  | "BACKUP_LOCK_CONFLICT"
  | "BACKUP_SNAPSHOT_PARTIAL"
  | "BACKUP_SNAPSHOT_CONFLICT"
  | "BACKUP_SCHEMA_MISMATCH"
  | "BACKUP_MANIFEST_INVALID"
  | "BACKUP_REPLAY_INPUT_INVALID"
  | "BACKUP_REPLAY_MISMATCH"
  | "BACKUP_PROTOCOL_INVALID"
  | "BACKUP_PROTOCOL_ABORT"
  | "BACKUP_PROTOCOL_EOF"
  | "BACKUP_PROTOCOL_TIMEOUT"
  | "BACKUP_SECRET_ABSENT"
  | "BACKUP_CLI_INVALID"
  | "BACKUP_TRANSACTION_FAILED";

export class BackupRestoreBarrierError extends Error {
  public readonly code: BackupRestoreBarrierErrorCode;

  public constructor(code: BackupRestoreBarrierErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "BackupRestoreBarrierError";
    this.code = code;
  }
}

export interface BackupClockSnapshot {
  readonly transactionTimestamp: string;
  readonly wallClockTimestamp: string;
  readonly transactionId: PositiveDecimalString;
  readonly walLsn: string;
}

export interface BackupIdempotencySnapshot {
  readonly rowCount: PositiveDecimalString | "0";
  readonly rowsSha256: Sha256;
  readonly requestHashesSha256: Sha256;
  readonly statusSha256: Sha256;
}

export interface BackupOutboxSnapshot {
  readonly rowCount: PositiveDecimalString | "0";
  readonly rowsSha256: Sha256;
  readonly payloadHashesSha256: Sha256;
  readonly consumerDedupeRowsSha256: Sha256;
}

export interface BackupDiagnosticHashes {
  readonly tableCountsSha256: Sha256;
  readonly snapshotSha256: Sha256;
}

export interface PgDiagnosticSnapshot {
  readonly schemaVersion: typeof BACKUP_RESTORE_SCHEMA_VERSION | "t02.backup-restore.v2";
  readonly systemIdentifier: PositiveDecimalString;
  readonly databaseName: string;
  readonly backendPid: PositiveDecimalString;
  readonly snapshotName: string;
  readonly migrationHead: string;
  readonly l3Namespace?: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
  readonly capturedAt: string;
  readonly sequenceStates?: Readonly<Record<string,{readonly lastValue:string;readonly isCalled:boolean}>>;
  readonly clock: BackupClockSnapshot;
  readonly tableCounts: Readonly<Record<BackupAuthorityTable, PositiveDecimalString | "0">>;
  /** One SHA-256 over the sorted, canonical PostgreSQL JSONB row texts per table. */
  readonly tableContentSha256: Readonly<Record<BackupAuthorityTable, Sha256>>;
  readonly idempotency: BackupIdempotencySnapshot;
  readonly outbox: BackupOutboxSnapshot;
  readonly tablespaces: readonly string[];
  readonly diagnosticHashes: BackupDiagnosticHashes;
}

export interface PgBasebackupContext {
  readonly snapshot: PgDiagnosticSnapshot;
  readonly backupRoot: string;
  readonly snapshotName: string;
  readonly basebackupApplicationName: typeof BACKUP_BASEBACKUP_APPLICATION_NAME;
  /** Aborted when same-client activity monitoring detects a fail-closed condition. */
  readonly signal: AbortSignal;
}

export interface WriterBarrierInput<T> {
  readonly backupRoot: string;
  readonly migrationHead: string;
  readonly l3Namespace?: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
  readonly lockTimeoutMs?: number;
  readonly monitorIntervalMs?: number;
  /** Runs while the same transaction and all table locks remain held. */
  readonly runBasebackup: (context: PgBasebackupContext) => Promise<T>;
}

export interface WriterBarrierPort {
  withWriterBarrier<T>(input: WriterBarrierInput<T>): Promise<T>;
}

/** The only two protocol lines a persistent T15 runner may send. */
export type BackupBasebackupCommand =
  | typeof BACKUP_BASEBACKUP_COMPLETE_COMMAND
  | typeof BACKUP_BASEBACKUP_ABORT_COMMAND;

export interface PersistentBarrierIO {
  /** Writes one complete protocol line and must not write diagnostics to stdout. */
  readonly writeStdout: (line: string) => void;
  /** Resolves exactly one strict command line or rejects with a protocol error. */
  readonly readCommandLine: (timeoutMs: number, signal?: AbortSignal) => Promise<string>;
}

export interface PersistentWriterBarrierInput {
  readonly backupRoot: string;
  readonly migrationHead: string;
  readonly l3Namespace?: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
  readonly lockTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly monitorIntervalMs?: number;
  readonly basebackupApplicationName?: typeof BACKUP_BASEBACKUP_APPLICATION_NAME;
  readonly io: PersistentBarrierIO;
}

export interface PersistentWriterBarrierResult {
  readonly snapshot: PgDiagnosticSnapshot;
}

export interface BackupRestoreCliConfig {
  readonly backupRoot: string;
  readonly migrationHead: string;
  readonly l3Namespace?: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
  readonly lockTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly basebackupApplicationName: typeof BACKUP_BASEBACKUP_APPLICATION_NAME;
}

export interface DiagnosticSnapshotPort {
  captureDiagnosticSnapshot(input: {
    readonly client: PoolClient;
    readonly migrationHead: string;
  readonly l3Namespace?: string | undefined;
    readonly imageDigest: string;
    readonly schemaSha256: Sha256;
  }): Promise<PgDiagnosticSnapshot>;
}

export interface BackupManifestBasebackup {
  readonly completed: true;
  readonly backupLabelSha256: Sha256;
  readonly backupManifestSha256: Sha256;
  readonly walStartLsn: string;
  readonly walEndLsn: string;
}

export interface BackupManifest {
  readonly schemaVersion: typeof BACKUP_RESTORE_SCHEMA_VERSION | "t02.backup-restore.v2";
  readonly backupRoot: string;
  readonly systemIdentifier: PositiveDecimalString;
  readonly migrationHead: string;
  readonly l3Namespace?: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
  readonly snapshot: PgDiagnosticSnapshot;
  readonly basebackup: BackupManifestBasebackup;
}

export interface BackupManifestExpectation {
  readonly backupRoot: string;
  readonly systemIdentifier: PositiveDecimalString;
  readonly migrationHead: string;
  readonly l3Namespace?: string;
  readonly imageDigest: string;
  readonly schemaSha256: Sha256;
}

export interface VerifiedBackupManifest {
  readonly verified: true;
  readonly manifestSha256: Sha256;
  readonly manifest: BackupManifest;
}

export interface BackupManifestVerifierPort {
  verifyBackupManifest(
    value: unknown,
    expected: BackupManifestExpectation,
  ): VerifiedBackupManifest;
}

export interface ReplayObservation {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: Sha256;
  readonly responseHash: Sha256;
  readonly status: "committed" | "indeterminate";
  readonly response: unknown;
  readonly terminalFactIds: readonly string[];
  readonly outboxEventIds: readonly string[];
}

export interface ReplayComparison {
  readonly equal: boolean;
  readonly expectedSha256: Sha256;
  readonly actualSha256: Sha256;
  readonly comparedRows: PositiveDecimalString | "0";
  readonly mismatchCount: PositiveDecimalString | "0";
}

export interface ReplayComparatorPort {
  compareReplay(
    expected: unknown,
    actual: unknown,
  ): ReplayComparison;
}

function sha256(value: string): Sha256 {
  return createHash("sha256").update(value, "utf8").digest("hex") as Sha256;
}

function assertSha256(value: unknown, code = "BACKUP_SNAPSHOT_PARTIAL"): Sha256 {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BackupRestoreBarrierError(code as BackupRestoreBarrierErrorCode);
  }
  return value as Sha256;
}

function assertImageDigest(value: unknown, code = "BACKUP_MANIFEST_INVALID"): string {
  if (typeof value !== "string" || !IMAGE_DIGEST_PATTERN.test(value)) {
    throw new BackupRestoreBarrierError(code as BackupRestoreBarrierErrorCode);
  }
  return value;
}

function assertPositiveDecimal(value: unknown, code = "BACKUP_SNAPSHOT_PARTIAL"): PositiveDecimalString {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new BackupRestoreBarrierError(code as BackupRestoreBarrierErrorCode);
  }
  return value as PositiveDecimalString;
}

function assertDecimal(value: unknown, code = "BACKUP_SNAPSHOT_PARTIAL"): PositiveDecimalString | "0" {
  if (typeof value !== "string" || !NON_NEGATIVE_DECIMAL_PATTERN.test(value)) {
    throw new BackupRestoreBarrierError(code as BackupRestoreBarrierErrorCode);
  }
  return value as PositiveDecimalString | "0";
}

function assertText(value: unknown, code: BackupRestoreBarrierErrorCode): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BackupRestoreBarrierError(code);
  }
  return value;
}

function assertPlainRecord(value: unknown, code: BackupRestoreBarrierErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new BackupRestoreBarrierError(code);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: BackupRestoreBarrierErrorCode,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new BackupRestoreBarrierError(code);
  }
}

function cloneJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  }
  if (seen.has(value)) throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneJson(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  const record = assertPlainRecord(value, "BACKUP_SNAPSHOT_PARTIAL");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) result[key] = cloneJson(record[key], seen);
  seen.delete(value);
  return Object.freeze(result);
}

function stableJson(value: unknown): string {
  return JSON.stringify(cloneJson(value));
}

function assertTimestamp(value: unknown, code = "BACKUP_SNAPSHOT_PARTIAL"): string {
  const text = assertText(value, code as BackupRestoreBarrierErrorCode);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(text)) {
    throw new BackupRestoreBarrierError(code as BackupRestoreBarrierErrorCode);
  }
  return text;
}

function assertLsn(value: unknown, code = "BACKUP_SNAPSHOT_PARTIAL"): string {
  const text = assertText(value, code as BackupRestoreBarrierErrorCode);
  if (!LSN_PATTERN.test(text)) throw new BackupRestoreBarrierError(code as BackupRestoreBarrierErrorCode);
  return text;
}

function assertSnapshotName(value: unknown): string {
  const text = assertText(value, "BACKUP_SNAPSHOT_PARTIAL");
  if (!DIAGNOSTIC_SNAPSHOT_PATTERN.test(text)) throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  return text;
}

function assertProtocolSafeText(value: unknown, code: BackupRestoreBarrierErrorCode): string {
  const text = assertText(value, code);
  if (/[\r\n]/u.test(text)) throw new BackupRestoreBarrierError(code);
  return text;
}

function assertMigrationHead(value: unknown, code: BackupRestoreBarrierErrorCode): string {
  const text = assertProtocolSafeText(value, code);
  if (text !== BACKUP_MIGRATION_HEAD && !isCurrentBackupHead(text)) throw new BackupRestoreBarrierError(code);
  return text;
}

function readyProtocolLine(snapshot: PgDiagnosticSnapshot): string {
  return JSON.stringify({
    protocol: BACKUP_BARRIER_PROTOCOL,
    type: "READY",
    snapshot,
  });
}

function releasedProtocolLine(snapshot: PgDiagnosticSnapshot): string {
  return JSON.stringify({
    protocol: BACKUP_BARRIER_PROTOCOL,
    type: "RELEASED",
    status: "committed",
    snapshot_name: snapshot.snapshotName,
    snapshot_sha256: snapshot.diagnosticHashes.snapshotSha256,
  });
}

function expectOne<T extends QueryResultRow>(result: { readonly rows: readonly T[] }, code: BackupRestoreBarrierErrorCode): T {
  if (result.rows.length !== 1 || result.rows[0] === undefined) throw new BackupRestoreBarrierError(code);
  return result.rows[0];
}

function assertBoundedLockTimeout(value: unknown): number {
  const timeout = value === undefined ? DEFAULT_BACKUP_LOCK_TIMEOUT_MS : value;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) ||
      timeout < 1 || timeout > MAX_BACKUP_LOCK_TIMEOUT_MS) {
    throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  }
  return timeout;
}

function assertBoundedCommandTimeout(value: unknown): number {
  const timeout = value === undefined ? DEFAULT_BACKUP_COMMAND_TIMEOUT_MS : value;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) ||
      timeout < 1 || timeout > MAX_BACKUP_COMMAND_TIMEOUT_MS) {
    throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  }
  return timeout;
}

function assertBoundedMonitorInterval(value: unknown): number {
  const interval = value === undefined ? DEFAULT_BACKUP_MONITOR_INTERVAL_MS : value;
  if (typeof interval !== "number" || !Number.isSafeInteger(interval) ||
      interval < 1 || interval > MAX_BACKUP_MONITOR_INTERVAL_MS) {
    throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  }
  return interval;
}

function freezeRecord<T extends object>(value: T): T {
  return Object.freeze(value);
}

function tableCountSql(tables: readonly string[] = BACKUP_AUTHORITY_TABLES): string {
  return tables.map((table, index) =>
    `${index === 0 ? "SELECT" : "UNION ALL SELECT"} '${table}'::text AS table_name, count(*)::text AS row_count FROM ${backupRelationSql(table)}`,
  ).join(" ");
}

function lockSql(tables:readonly string[]=BACKUP_AUTHORITY_TABLES): string {
  return `LOCK TABLE ${tables.map(backupRelationSql).join(", ")} IN SHARE MODE`;
}

function tableContentSql(table: BackupAuthorityTable): string {
  return `SELECT to_jsonb(source_row)::text AS row_json FROM (SELECT * FROM ${backupRelationSql(table)}) AS source_row`;
}

/** Enumerates the current user tables from the catalog before any READY line. */
export const BACKUP_CATALOG_TABLE_STATEMENT =
  "SELECT n.nspname::text AS schema_name, c.relname::text AS table_name, c.relkind::text AS relkind " +
  "FROM pg_catalog.pg_class AS c " +
  "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = false " +
  "ORDER BY n.nspname, c.relname";

/**
 * The fingerprint is derived from normalized catalog components, not from a
 * caller-provided echo.  The SQL intentionally names only pg_catalog sources
 * and uses stable textual type/constraint/index definitions.
 */
export const BACKUP_SCHEMA_FINGERPRINT_STATEMENT =
  "WITH catalog_components AS (" +
  "SELECT format('table|%s|%s|%s|%s', n.nspname, c.relname, c.relkind, c.relpersistence) AS schema_component " +
  "FROM pg_catalog.pg_class AS c " +
  "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = false " +
  "UNION ALL " +
  "SELECT format('column|%s|%s|%s|%s|%s|%s|%s', n.nspname, c.relname, a.attnum, a.attname, " +
  "pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, " +
  "COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '')) " +
  "FROM pg_catalog.pg_attribute AS a " +
  "JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid " +
  "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
  "LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum " +
  "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = false " +
  "AND a.attnum > 0 AND a.attisdropped = false " +
  "UNION ALL " +
  "SELECT format('constraint|%s|%s|%s|%s', n.nspname, c.relname, con.contype, con.conname) || '|' || " +
  "pg_catalog.pg_get_constraintdef(con.oid, true) " +
  "FROM pg_catalog.pg_constraint AS con " +
  "JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid " +
  "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = false " +
  "UNION ALL " +
  "SELECT format('index|%s|%s|%s', n.nspname, t.relname, i.relname) || '|' || " +
  "pg_catalog.pg_get_indexdef(i.oid) " +
  "FROM pg_catalog.pg_index AS ix " +
  "JOIN pg_catalog.pg_class AS t ON t.oid = ix.indrelid " +
  "JOIN pg_catalog.pg_class AS i ON i.oid = ix.indexrelid " +
  "JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace " +
  "WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p') AND t.relispartition = false" +
  ") SELECT schema_component::text FROM catalog_components ORDER BY schema_component";

export async function inspectBackupAuthorityCatalog(client:PoolClient,input:{migrationHead:string;l3Namespace?:string | undefined;schemaSha256:Sha256;lockForSnapshot?:boolean}) {
  try {
    const scope=backupAuthorityScope(input.migrationHead,BACKUP_AUTHORITY_TABLES,input.l3Namespace);
    await verifyBackupMigrationSources(scope);
    await verifyBackupSequenceScope(client,scope);
    const catalog=BACKUP_CATALOG_TABLE_STATEMENT.replaceAll("n.nspname = 'public'","n.nspname = ANY($1::text[])");
    assertCatalogTableSet((await client.query(catalog,[scope.namespaces])).rows,scope.tables);
    if(input.lockForSnapshot)await client.query(lockSql(scope.tables));
    const fingerprint=scope.current ? BACKUP_SCHEMA_FINGERPRINT_STATEMENT
      .replaceAll("n.nspname = 'public'","n.nspname = ANY($1::text[])")
      .replace(") SELECT schema_component",BACKUP_SEQUENCE_FINGERPRINT_COMPONENTS+") SELECT schema_component")
      : BACKUP_SCHEMA_FINGERPRINT_STATEMENT;
    const hash=catalogFingerprintHash((await client.query(fingerprint,scope.current?[scope.namespaces]:[])).rows);
    if(hash!==input.schemaSha256)throw new BackupRestoreBarrierError("BACKUP_SCHEMA_MISMATCH");
    return scope;
  } catch(error) {
    if(error instanceof BackupRestoreBarrierError)throw error;
    if(input.lockForSnapshot && ["55P03","57014"].includes(String((error as {code?:unknown})?.code)))throw error;
    throw new BackupRestoreBarrierError("BACKUP_SCHEMA_MISMATCH",error);
  }
}

const SNAPSHOT_SESSION_CONFIG_STATEMENT =
  "SELECT set_config('TimeZone', 'UTC', true) AS timezone, " +
  "set_config('bytea_output', 'hex', true) AS bytea_output, " +
  "set_config('DateStyle', 'ISO, YMD', true) AS datestyle, " +
  "set_config('extra_float_digits', '3', true) AS extra_float_digits, " +
  "set_config('stats_fetch_consistency', 'none', true) AS stats_fetch_consistency";

const WRITER_SESSION_CONFIG_STATEMENT =
  "SELECT set_config('lock_timeout', $1, true) AS lock_timeout, " +
  "set_config('TimeZone', 'UTC', true) AS timezone, " +
  "set_config('bytea_output', 'hex', true) AS bytea_output, " +
  "set_config('DateStyle', 'ISO, YMD', true) AS datestyle, " +
  "set_config('extra_float_digits', '3', true) AS extra_float_digits, " +
  "set_config('stats_fetch_consistency', 'none', true) AS stats_fetch_consistency";

/**
 * The activity query deliberately runs on the barrier client.  It is never
 * executed through a second pool connection because a second snapshot would
 * make the writer fence non-atomic.
 */
export const BACKUP_ACTIVITY_STATEMENT =
  "SELECT pid::text AS pid, datname::text AS database_name, usename::text AS user_name, " +
  "application_name::text AS application_name, client_addr::text AS client_addr, " +
  "backend_type::text AS backend_type, state::text AS state, " +
  "wait_event_type::text AS wait_event_type, wait_event::text AS wait_event, " +
  "query::text AS query, COALESCE(array_to_json(pg_blocking_pids(pid))::text, '[]') AS blocking_pids " +
  "FROM pg_catalog.pg_stat_activity WHERE backend_type IN ('client backend', 'walsender') OR pid = pg_backend_pid() ORDER BY pid";

const SAFE_WALSENDER_WAIT_EVENT = /^(?:WalSender[A-Za-z0-9_]*|Client(?:Read|Write)|Basebackup(?:Read|Sync|Write))$/u;
const SAFE_WALSENDER_QUERY = /^(?:BASE_BACKUP|START_REPLICATION|IDENTIFY_SYSTEM)(?:\s|$)/u;

function assertTableCounts(value: unknown, tables:readonly string[]=BACKUP_AUTHORITY_TABLES): Readonly<Record<BackupAuthorityTable, PositiveDecimalString | "0">> {
  const result: Partial<Record<BackupAuthorityTable, PositiveDecimalString | "0">> = {};
  if (Array.isArray(value)) {
    if (value.length !== tables.length) {
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
    }
    for (const rowValue of value) {
      const row = assertPlainRecord(rowValue, "BACKUP_SNAPSHOT_PARTIAL");
      assertExactKeys(row, ["table_name", "row_count"], "BACKUP_SNAPSHOT_PARTIAL");
      const table = assertText(row.table_name, "BACKUP_SNAPSHOT_PARTIAL") as BackupAuthorityTable;
      if (!(tables as readonly string[]).includes(table) || result[table] !== undefined) {
        throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_CONFLICT");
      }
      result[table] = assertDecimal(row.row_count);
    }
  } else {
    const record = assertPlainRecord(value, "BACKUP_SNAPSHOT_PARTIAL");
    assertExactKeys(record, tables, "BACKUP_SNAPSHOT_PARTIAL");
    for (const table of tables) result[table] = assertDecimal(record[table]);
  }
  if (tables.some((table) => result[table] === undefined)) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  }
  return Object.freeze(result as Record<BackupAuthorityTable, PositiveDecimalString | "0">);
}

function assertCatalogTableSet(value: readonly QueryResultRow[], tables:readonly string[]=BACKUP_AUTHORITY_TABLES): void {
  const actual: string[] = [];
  for (const rowValue of value) {
    const row = assertPlainRecord(rowValue, "BACKUP_SCHEMA_MISMATCH");
    assertExactKeys(row, ["schema_name", "table_name", "relkind"], "BACKUP_SCHEMA_MISMATCH");
    if (row.relkind !== "r" && row.relkind !== "p") {
      throw new BackupRestoreBarrierError("BACKUP_SCHEMA_MISMATCH");
    }
    const table = assertText(row.table_name, "BACKUP_SCHEMA_MISMATCH");
    actual.push(row.schema_name === "public" ? table : row.schema_name + "." + table);
  }
  const expected = [...tables];
  const sortedActual = [...actual].sort();
  if (sortedActual.length !== expected.length ||
      sortedActual.some((table, index) => table !== expected[index]) ||
      new Set(actual).size !== actual.length) {
    throw new BackupRestoreBarrierError("BACKUP_SCHEMA_MISMATCH");
  }
}

function catalogFingerprintHash(value: readonly QueryResultRow[]): Sha256 {
  const components = value.map((rowValue) => {
    const row = assertPlainRecord(rowValue, "BACKUP_SCHEMA_MISMATCH");
    assertExactKeys(row, ["schema_component"], "BACKUP_SCHEMA_MISMATCH");
    const component = assertText(row.schema_component, "BACKUP_SCHEMA_MISMATCH");
    if (component.length === 0) throw new BackupRestoreBarrierError("BACKUP_SCHEMA_MISMATCH");
    return component.normalize("NFC");
  });
  const sorted = [...components].sort();
  if (sorted.length === 0 || sorted.some((component, index) => component !== components[index]) ||
      new Set(components).size !== components.length) {
    throw new BackupRestoreBarrierError("BACKUP_SCHEMA_MISMATCH");
  }
  return sha256(JSON.stringify(sorted));
}

function assertTableContentSha256(value: unknown, code: BackupRestoreBarrierErrorCode = "BACKUP_SNAPSHOT_PARTIAL", tables:readonly string[]=BACKUP_AUTHORITY_TABLES):
  Readonly<Record<BackupAuthorityTable, Sha256>> {
  const record = assertPlainRecord(value, code);
  assertExactKeys(record, tables, code);
  const result: Partial<Record<BackupAuthorityTable, Sha256>> = {};
  for (const table of tables) result[table] = assertSha256(record[table], code);
  return Object.freeze(result as Record<BackupAuthorityTable, Sha256>);
}

function canonicalPgJsonbRow(value: unknown): string {
  if (value === null || value === undefined) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
    try {
      JSON.parse(text);
    } catch (error) {
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL", error);
    }
    // PostgreSQL's jsonb output is already key-sorted and numeric-normalized.
    // Keep it as text so decimal tokens cannot be rounded by JSON.parse.
    return text;
  }
  // Unit fixtures may provide the parsed JSONB object.  stableJson sorts keys
  // while retaining the closed, non-secret in-memory boundary.
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  }
  return stableJson(value);
}

function tableContentHash(rows: readonly QueryResultRow[]): Sha256 {
  if (rows.length > MAX_BACKUP_TABLE_CONTENT_ROWS) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  }
  const canonicalRows = rows.map((rowValue) => {
    const row = assertPlainRecord(rowValue, "BACKUP_SNAPSHOT_PARTIAL");
    const keys = Object.keys(row);
    if (keys.length !== 1 || (keys[0] !== "row_json" && keys[0] !== "row")) {
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
    }
    return canonicalPgJsonbRow(row.row_json ?? row.row);
  }).sort();
  return sha256(JSON.stringify(canonicalRows));
}

function parseActivityNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  return value;
}

interface PgActivityRow {
  readonly pid: PositiveDecimalString;
  readonly databaseName: string | null;
  readonly userName: string | null;
  readonly applicationName: string | null;
  readonly clientAddr: string | null;
  readonly backendType: string | null;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly query: string | null;
  readonly blockingPids: readonly PositiveDecimalString[];
}

function parseBlockingPids(value: unknown): readonly PositiveDecimalString[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL", error);
    }
  }
  if (!Array.isArray(parsed)) throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  const pids = parsed.map((pid) => assertPositiveDecimal(String(pid), "BACKUP_SNAPSHOT_PARTIAL"));
  const sorted = [...pids].sort();
  if (sorted.some((pid, index) => pid !== pids[index]) || new Set(pids).size !== pids.length) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_CONFLICT");
  }
  return Object.freeze(pids);
}

function parseActivityRow(value: QueryResultRow): PgActivityRow {
  const row = assertPlainRecord(value, "BACKUP_SNAPSHOT_PARTIAL");
  const pid = row.pid ?? row.backend_pid;
  if (pid === undefined) throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  return freezeRecord({
    pid: assertPositiveDecimal(String(pid), "BACKUP_SNAPSHOT_PARTIAL"),
    databaseName: parseActivityNullableText(row.database_name),
    userName: parseActivityNullableText(row.user_name),
    applicationName: parseActivityNullableText(row.application_name),
    clientAddr: parseActivityNullableText(row.client_addr),
    backendType: parseActivityNullableText(row.backend_type),
    state: parseActivityNullableText(row.state),
    waitEventType: parseActivityNullableText(row.wait_event_type),
    waitEvent: parseActivityNullableText(row.wait_event),
    query: parseActivityNullableText(row.query),
    blockingPids: parseBlockingPids(row.blocking_pids ?? row.blocking_pids_json ?? "[]"),
  });
}

function activityHasLockWait(row: PgActivityRow): boolean {
  return row.blockingPids.length > 0 ||
    row.waitEventType === "Lock" ||
    row.waitEventType === "BufferPin" ||
    (row.waitEvent !== null && /lock|bufferpin/iu.test(row.waitEvent));
}

function isAllowedBasebackupWalsender(row: PgActivityRow): boolean {
  if (row.backendType !== "walsender" || row.applicationName !== BACKUP_BASEBACKUP_APPLICATION_NAME) return false;
  if (row.state !== "active" && row.state !== "streaming") return false;
  if (row.waitEventType !== null && row.waitEventType !== "Activity" && row.waitEventType !== "Client" && row.waitEventType !== "IO") return false;
  if (row.waitEvent !== null && !SAFE_WALSENDER_WAIT_EVENT.test(row.waitEvent)) return false;
  if (row.query !== null && row.query !== "" && !SAFE_WALSENDER_QUERY.test(row.query.trim())) return false;
  return !activityHasLockWait(row);
}

function assertSafeActivityRows(
  value: readonly QueryResultRow[],
  barrierPid: PositiveDecimalString,
  allowBasebackupWalsender: boolean,
): void {
  const seen = new Set<string>();
  for (const rowValue of value) {
    const row = parseActivityRow(rowValue);
    if (seen.has(row.pid)) throw new BackupRestoreBarrierError("BACKUP_LOCK_CONFLICT");
    seen.add(row.pid);
    if (row.pid === barrierPid) {
      if (row.backendType !== "client backend" || activityHasLockWait(row)) {
        throw new BackupRestoreBarrierError("BACKUP_LOCK_CONFLICT");
      }
      continue;
    }
    if (!allowBasebackupWalsender || !isAllowedBasebackupWalsender(row)) {
      throw new BackupRestoreBarrierError("BACKUP_LOCK_CONFLICT");
    }
  }
  if (!seen.has(barrierPid)) throw new BackupRestoreBarrierError("BACKUP_CONNECTION_UNKNOWN");
}

function nullableText(value: unknown, code: BackupRestoreBarrierErrorCode): string | null {
  if (value === null) return null;
  return assertText(value, code);
}

function nullableSha256(value: unknown, code: BackupRestoreBarrierErrorCode): Sha256 | null {
  if (value === null) return null;
  return assertSha256(value, code);
}

function assertIdempotencyRows(value: readonly QueryResultRow[]): readonly Record<string, unknown>[] {
  return Object.freeze(value.map((rowValue) => {
    const row = assertPlainRecord(rowValue, "BACKUP_SNAPSHOT_PARTIAL");
    assertExactKeys(row, ["scope", "idempotency_key", "request_hash", "request_fingerprint", "status", "response_hash", "response"], "BACKUP_SNAPSHOT_PARTIAL");
    const status = row.status;
    if (status !== "in_flight" && status !== "committed" && status !== "failed" && status !== "indeterminate") {
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_CONFLICT");
    }
    return freezeRecord({
      scope: assertText(row.scope, "BACKUP_SNAPSHOT_PARTIAL"),
      idempotency_key: assertText(row.idempotency_key, "BACKUP_SNAPSHOT_PARTIAL"),
      request_hash: assertSha256(row.request_hash),
      request_fingerprint: nullableText(row.request_fingerprint, "BACKUP_SNAPSHOT_PARTIAL"),
      status,
      response_hash: nullableSha256(row.response_hash, "BACKUP_SNAPSHOT_PARTIAL"),
      response: cloneJson(row.response),
    });
  }));
}

function assertOutboxRows(value: readonly QueryResultRow[]): readonly Record<string, unknown>[] {
  return Object.freeze(value.map((rowValue) => {
    const row = assertPlainRecord(rowValue, "BACKUP_SNAPSHOT_PARTIAL");
    assertExactKeys(row, [
      "idempotency_scope", "idempotency_key", "event_type", "event_id", "aggregate_type", "aggregate_id",
      "aggregate_ref", "event_version", "payload", "payload_sha256", "status", "attempt_count",
    ], "BACKUP_SNAPSHOT_PARTIAL");
    const status = row.status;
    if (status !== "pending" && status !== "claimed" && status !== "published" && status !== "failed") {
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_CONFLICT");
    }
    return freezeRecord({
      idempotency_scope: assertText(row.idempotency_scope, "BACKUP_SNAPSHOT_PARTIAL"),
      idempotency_key: assertText(row.idempotency_key, "BACKUP_SNAPSHOT_PARTIAL"),
      event_type: assertText(row.event_type, "BACKUP_SNAPSHOT_PARTIAL"),
      event_id: assertText(row.event_id, "BACKUP_SNAPSHOT_PARTIAL"),
      aggregate_type: assertText(row.aggregate_type, "BACKUP_SNAPSHOT_PARTIAL"),
      aggregate_id: assertText(row.aggregate_id, "BACKUP_SNAPSHOT_PARTIAL"),
      aggregate_ref: cloneJson(row.aggregate_ref),
      event_version: assertPositiveDecimal(row.event_version),
      payload: cloneJson(row.payload),
      payload_sha256: assertSha256(row.payload_sha256),
      status,
      attempt_count: assertDecimal(row.attempt_count),
    });
  }));
}

function assertDedupeRows(value: readonly QueryResultRow[]): readonly Record<string, unknown>[] {
  return Object.freeze(value.map((rowValue) => {
    const row = assertPlainRecord(rowValue, "BACKUP_SNAPSHOT_PARTIAL");
    assertExactKeys(row, ["consumer_name", "event_id", "payload_hash", "processed_at"], "BACKUP_SNAPSHOT_PARTIAL");
    return freezeRecord({
      consumer_name: assertText(row.consumer_name, "BACKUP_SNAPSHOT_PARTIAL"),
      event_id: assertText(row.event_id, "BACKUP_SNAPSHOT_PARTIAL"),
      payload_hash: assertSha256(row.payload_hash),
      processed_at: assertTimestamp(row.processed_at),
    });
  }));
}

function assertTablespaces(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL");
  }
  const names = [...value] as string[];
  const sorted = [...new Set(names)].sort();
  if (sorted.length !== names.length || sorted.some((name, index) => name !== names[index]) ||
      names.some((name) => !(ALLOWED_TABLESPACES as readonly string[]).includes(name))) {
    throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_CONFLICT");
  }
  return Object.freeze(names);
}

function assertDiagnosticSnapshot(value: unknown): PgDiagnosticSnapshot {
  const root = assertPlainRecord(value, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(root, [
    "schemaVersion", "systemIdentifier", "databaseName", "backendPid", "snapshotName",
    "migrationHead", "imageDigest", "schemaSha256", "capturedAt", "clock", "tableCounts", "tableContentSha256",
    "idempotency", "outbox", "tablespaces", "diagnosticHashes",
    ...(isCurrentBackupHead(root.migrationHead) ? ["l3Namespace","sequenceStates"] : []),
  ], "BACKUP_MANIFEST_INVALID");
  const scope=backupAuthorityScope(String(root.migrationHead),BACKUP_AUTHORITY_TABLES,root.l3Namespace as string|undefined);
  if (root.schemaVersion !== (scope.current?"t02.backup-restore.v2":BACKUP_RESTORE_SCHEMA_VERSION)) throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
  const sequenceStates:Record<string,{lastValue:string;isCalled:boolean}>={};
  if(scope.current) {
    const sequences=assertPlainRecord(root.sequenceStates,"BACKUP_MANIFEST_INVALID");
    assertExactKeys(sequences,scope.sequences,"BACKUP_MANIFEST_INVALID");
    for(const name of scope.sequences) {
      const value=assertPlainRecord(sequences[name],"BACKUP_MANIFEST_INVALID");
      assertExactKeys(value,["lastValue","isCalled"],"BACKUP_MANIFEST_INVALID");
      if(typeof value.isCalled!=="boolean")throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
      sequenceStates[name]={lastValue:assertDecimal(value.lastValue),isCalled:value.isCalled};
    }
  }
  const clock = assertPlainRecord(root.clock, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(clock, ["transactionTimestamp", "wallClockTimestamp", "transactionId", "walLsn"], "BACKUP_MANIFEST_INVALID");
  const idempotency = assertPlainRecord(root.idempotency, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(idempotency, ["rowCount", "rowsSha256", "requestHashesSha256", "statusSha256"], "BACKUP_MANIFEST_INVALID");
  const outbox = assertPlainRecord(root.outbox, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(outbox, ["rowCount", "rowsSha256", "payloadHashesSha256", "consumerDedupeRowsSha256"], "BACKUP_MANIFEST_INVALID");
  const hashes = assertPlainRecord(root.diagnosticHashes, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(hashes, ["tableCountsSha256", "snapshotSha256"], "BACKUP_MANIFEST_INVALID");
  const tableCounts = assertTableCounts(root.tableCounts,scope.tables);
  const tableContentSha256 = assertTableContentSha256(root.tableContentSha256, "BACKUP_MANIFEST_INVALID",scope.tables);
  const snapshot: PgDiagnosticSnapshot = freezeRecord({
    schemaVersion: scope.current ? "t02.backup-restore.v2" : BACKUP_RESTORE_SCHEMA_VERSION,
    ...(scope.current ? {l3Namespace:scope.l3Namespace,sequenceStates:freezeRecord(sequenceStates)} : {}),
    systemIdentifier: assertPositiveDecimal(root.systemIdentifier, "BACKUP_MANIFEST_INVALID"),
    databaseName: assertText(root.databaseName, "BACKUP_MANIFEST_INVALID"),
    backendPid: assertPositiveDecimal(root.backendPid, "BACKUP_MANIFEST_INVALID"),
    snapshotName: assertSnapshotName(root.snapshotName),
    migrationHead: assertMigrationHead(root.migrationHead, "BACKUP_MANIFEST_INVALID"),
    imageDigest: assertImageDigest(root.imageDigest),
    schemaSha256: assertSha256(root.schemaSha256, "BACKUP_MANIFEST_INVALID"),
    capturedAt: assertTimestamp(root.capturedAt, "BACKUP_MANIFEST_INVALID"),
    clock: freezeRecord({
      transactionTimestamp: assertTimestamp(clock.transactionTimestamp, "BACKUP_MANIFEST_INVALID"),
      wallClockTimestamp: assertTimestamp(clock.wallClockTimestamp, "BACKUP_MANIFEST_INVALID"),
      transactionId: assertPositiveDecimal(clock.transactionId, "BACKUP_MANIFEST_INVALID"),
      walLsn: assertLsn(clock.walLsn, "BACKUP_MANIFEST_INVALID"),
    }),
    tableCounts,
    tableContentSha256,
    idempotency: freezeRecord({
      rowCount: assertDecimal(idempotency.rowCount, "BACKUP_MANIFEST_INVALID"),
      rowsSha256: assertSha256(idempotency.rowsSha256, "BACKUP_MANIFEST_INVALID"),
      requestHashesSha256: assertSha256(idempotency.requestHashesSha256, "BACKUP_MANIFEST_INVALID"),
      statusSha256: assertSha256(idempotency.statusSha256, "BACKUP_MANIFEST_INVALID"),
    }),
    outbox: freezeRecord({
      rowCount: assertDecimal(outbox.rowCount, "BACKUP_MANIFEST_INVALID"),
      rowsSha256: assertSha256(outbox.rowsSha256, "BACKUP_MANIFEST_INVALID"),
      payloadHashesSha256: assertSha256(outbox.payloadHashesSha256, "BACKUP_MANIFEST_INVALID"),
      consumerDedupeRowsSha256: assertSha256(outbox.consumerDedupeRowsSha256, "BACKUP_MANIFEST_INVALID"),
    }),
    tablespaces: assertTablespaces(root.tablespaces),
    diagnosticHashes: freezeRecord({
      tableCountsSha256: assertSha256(hashes.tableCountsSha256, "BACKUP_MANIFEST_INVALID"),
      snapshotSha256: assertSha256(hashes.snapshotSha256, "BACKUP_MANIFEST_INVALID"),
    }),
  });
  const expectedTableCountsHash = sha256(stableJson(snapshot.tableCounts));
  if (expectedTableCountsHash !== snapshot.diagnosticHashes.tableCountsSha256) {
    throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
  }
  const expectedSnapshotHash = sha256(stableJson({
    ...(scope.current ? {l3Namespace:snapshot.l3Namespace,sequenceStates:snapshot.sequenceStates} : {}),
    systemIdentifier: snapshot.systemIdentifier,
    databaseName: snapshot.databaseName,
    backendPid: snapshot.backendPid,
    snapshotName: snapshot.snapshotName,
    migrationHead: snapshot.migrationHead,
    imageDigest: snapshot.imageDigest,
    schemaSha256: snapshot.schemaSha256,
    clock: snapshot.clock,
    tableCounts: snapshot.tableCounts,
    tableContentSha256: snapshot.tableContentSha256,
    idempotency: snapshot.idempotency,
    outbox: snapshot.outbox,
    tablespaces: snapshot.tablespaces,
  }));
  if (expectedSnapshotHash !== snapshot.diagnosticHashes.snapshotSha256) {
    throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
  }
  return snapshot;
}

function normalizeReplayObservation(value: unknown): ReplayObservation {
  const record = assertPlainRecord(value, "BACKUP_REPLAY_INPUT_INVALID");
  assertExactKeys(record, [
    "scope", "idempotencyKey", "requestHash", "responseHash", "status", "response",
    "terminalFactIds", "outboxEventIds",
  ], "BACKUP_REPLAY_INPUT_INVALID");
  if (record.status !== "committed" && record.status !== "indeterminate") {
    throw new BackupRestoreBarrierError("BACKUP_REPLAY_INPUT_INVALID");
  }
  const terminalFactIds = record.terminalFactIds;
  const outboxEventIds = record.outboxEventIds;
  if (!Array.isArray(terminalFactIds) || !Array.isArray(outboxEventIds) ||
      terminalFactIds.some((id) => typeof id !== "string" || id.length === 0) ||
      outboxEventIds.some((id) => typeof id !== "string" || id.length === 0) ||
      [...terminalFactIds].sort().some((id, index) => id !== terminalFactIds[index]) ||
      [...outboxEventIds].sort().some((id, index) => id !== outboxEventIds[index])) {
    throw new BackupRestoreBarrierError("BACKUP_REPLAY_INPUT_INVALID");
  }
  return freezeRecord({
    scope: assertText(record.scope, "BACKUP_REPLAY_INPUT_INVALID"),
    idempotencyKey: assertText(record.idempotencyKey, "BACKUP_REPLAY_INPUT_INVALID"),
    requestHash: assertSha256(record.requestHash, "BACKUP_REPLAY_INPUT_INVALID"),
    responseHash: assertSha256(record.responseHash, "BACKUP_REPLAY_INPUT_INVALID"),
    status: record.status,
    response: cloneJson(record.response),
    terminalFactIds: Object.freeze([...terminalFactIds]),
    outboxEventIds: Object.freeze([...outboxEventIds]),
  });
}

function normalizeReplayList(value: unknown): readonly ReplayObservation[] {
  if (!Array.isArray(value)) throw new BackupRestoreBarrierError("BACKUP_REPLAY_INPUT_INVALID");
  const normalized = value.map(normalizeReplayObservation);
  const keys = normalized.map((item) => `${item.scope}\u0000${item.idempotencyKey}`);
  const sortedKeys = [...keys].sort();
  if (sortedKeys.some((key, index) => key !== keys[index]) || new Set(keys).size !== keys.length) {
    throw new BackupRestoreBarrierError("BACKUP_REPLAY_INPUT_INVALID");
  }
  return Object.freeze(normalized);
}

interface NormalizedReplayInput {
  readonly rows: readonly ReplayObservation[];
  readonly authority: unknown | undefined;
}

function normalizeReplayInput(value: unknown): NormalizedReplayInput {
  if (Array.isArray(value)) return freezeRecord({ rows: normalizeReplayList(value), authority: undefined });
  const record = assertPlainRecord(value, "BACKUP_REPLAY_INPUT_INVALID");
  assertExactKeys(record, ["replay", "snapshot"], "BACKUP_REPLAY_INPUT_INVALID");
  let snapshot: PgDiagnosticSnapshot;
  try {
    snapshot = assertDiagnosticSnapshot(record.snapshot);
  } catch (error) {
    if (error instanceof BackupRestoreBarrierError && error.code === "BACKUP_MANIFEST_INVALID") {
      throw new BackupRestoreBarrierError("BACKUP_REPLAY_INPUT_INVALID", error);
    }
    throw error;
  }
  return freezeRecord({
    rows: normalizeReplayList(record.replay),
    // Compare only restore-stable authority diagnostics.  Backend pid, clock,
    // snapshot name, and capturedAt are intentionally excluded.
    authority: freezeRecord({
      tableCounts: snapshot.tableCounts,
      tableContentSha256: snapshot.tableContentSha256,
      idempotency: snapshot.idempotency,
      outbox: snapshot.outbox,
    }),
  });
}

export function compareReplay(expected: unknown, actual: unknown): ReplayComparison {
  const expectedInput = normalizeReplayInput(expected);
  const actualInput = normalizeReplayInput(actual);
  if ((expectedInput.authority === undefined) !== (actualInput.authority === undefined)) {
    throw new BackupRestoreBarrierError("BACKUP_REPLAY_INPUT_INVALID");
  }
  const expectedRows = expectedInput.rows;
  const actualRows = actualInput.rows;
  const expectedText = expectedInput.authority === undefined
    ? stableJson(expectedRows)
    : stableJson({ replay: expectedRows, authority: expectedInput.authority });
  const actualText = actualInput.authority === undefined
    ? stableJson(actualRows)
    : stableJson({ replay: actualRows, authority: actualInput.authority });
  const expectedSha256 = sha256(expectedText);
  const actualSha256 = sha256(actualText);
  const equal = expectedSha256 === actualSha256;
  return freezeRecord({
    equal,
    expectedSha256,
    actualSha256,
    comparedRows: assertDecimal(String(expectedRows.length >= actualRows.length ? expectedRows.length : actualRows.length), "BACKUP_REPLAY_INPUT_INVALID"),
    mismatchCount: equal ? "0" : assertDecimal("1", "BACKUP_REPLAY_INPUT_INVALID"),
  });
}

export function verifyBackupManifest(
  value: unknown,
  expected: BackupManifestExpectation,
): VerifiedBackupManifest {
  const expectedRoot = assertText(expected?.backupRoot, "BACKUP_MANIFEST_INVALID");
  const expectedSystemIdentifier = assertPositiveDecimal(expected?.systemIdentifier, "BACKUP_MANIFEST_INVALID");
  const expectedMigrationHead = assertMigrationHead(expected?.migrationHead, "BACKUP_MANIFEST_INVALID");
  const expectedImageDigest = assertImageDigest(expected?.imageDigest);
  const expectedSchemaSha256 = assertSha256(expected?.schemaSha256, "BACKUP_MANIFEST_INVALID");
  const root = assertPlainRecord(value, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(root, [
    "schemaVersion", "backupRoot", "systemIdentifier", "migrationHead", "imageDigest",
    "schemaSha256", "snapshot", "basebackup",
  ], "BACKUP_MANIFEST_INVALID");
  const basebackup = assertPlainRecord(root.basebackup, "BACKUP_MANIFEST_INVALID");
  assertExactKeys(basebackup, ["completed", "backupLabelSha256", "backupManifestSha256", "walStartLsn", "walEndLsn"], "BACKUP_MANIFEST_INVALID");
  if (basebackup.completed !== true) throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
  if (root.schemaVersion !== (isCurrentBackupHead(expectedMigrationHead)?"t02.backup-restore.v2":BACKUP_RESTORE_SCHEMA_VERSION)) throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
  const snapshot = assertDiagnosticSnapshot(root.snapshot);
  const manifest: BackupManifest = freezeRecord({
    schemaVersion: isCurrentBackupHead(expectedMigrationHead)?"t02.backup-restore.v2":BACKUP_RESTORE_SCHEMA_VERSION,
    backupRoot: assertText(root.backupRoot, "BACKUP_MANIFEST_INVALID"),
    systemIdentifier: assertPositiveDecimal(root.systemIdentifier, "BACKUP_MANIFEST_INVALID"),
    migrationHead: assertMigrationHead(root.migrationHead, "BACKUP_MANIFEST_INVALID"),
    imageDigest: assertImageDigest(root.imageDigest),
    schemaSha256: assertSha256(root.schemaSha256, "BACKUP_MANIFEST_INVALID"),
    snapshot,
    basebackup: freezeRecord({
      completed: true,
      backupLabelSha256: assertSha256(basebackup.backupLabelSha256, "BACKUP_MANIFEST_INVALID"),
      backupManifestSha256: assertSha256(basebackup.backupManifestSha256, "BACKUP_MANIFEST_INVALID"),
      walStartLsn: assertLsn(basebackup.walStartLsn, "BACKUP_MANIFEST_INVALID"),
      walEndLsn: assertLsn(basebackup.walEndLsn, "BACKUP_MANIFEST_INVALID"),
    }),
  });
  if (manifest.backupRoot !== expectedRoot ||
      manifest.systemIdentifier !== expectedSystemIdentifier ||
      manifest.migrationHead !== expectedMigrationHead ||
      manifest.imageDigest !== expectedImageDigest ||
      manifest.schemaSha256 !== expectedSchemaSha256 ||
      snapshot.systemIdentifier !== expectedSystemIdentifier ||
      snapshot.migrationHead !== expectedMigrationHead ||
      snapshot.imageDigest !== expectedImageDigest ||
      snapshot.schemaSha256 !== expectedSchemaSha256 ||
      (isCurrentBackupHead(expectedMigrationHead) && snapshot.l3Namespace!==expected.l3Namespace) ||
      snapshot.tablespaces.some((name) => !(ALLOWED_TABLESPACES as readonly string[]).includes(name))) {
    throw new BackupRestoreBarrierError("BACKUP_MANIFEST_INVALID");
  }
  const manifestSha256 = sha256(stableJson(manifest));
  return freezeRecord({ verified: true as const, manifestSha256, manifest });
}

type BackupCommandReadable = NodeJS.ReadableStream & {
  setEncoding?: (encoding: BufferEncoding) => void;
  pause?: () => BackupCommandReadable;
};

/**
 * Reads one and only one newline-terminated command from the persistent
 * runner pipe.  A second line, extra bytes after the first newline, EOF,
 * stream error, or timeout is a fail-closed protocol result.
 */
export function readSingleBackupCommand(
  input: NodeJS.ReadableStream,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BackupBasebackupCommand> {
  const boundedTimeoutMs = assertBoundedCommandTimeout(timeoutMs);
  const stream = input as BackupCommandReadable;
  return new Promise<BackupBasebackupCommand>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      stream.pause?.();
    };
    const finish = (error: BackupRestoreBarrierError | undefined, value?: BackupBasebackupCommand): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID"));
    };
    const onData = (chunk: unknown): void => {
      if (settled) return;
      const text = typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      buffer += text;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        if (buffer.length > 128) finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID"));
        return;
      }
      if (buffer.indexOf("\n", newlineIndex + 1) >= 0 || buffer.slice(newlineIndex + 1).length !== 0) {
        finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID"));
        return;
      }
      const command = buffer.slice(0, newlineIndex).endsWith("\r")
        ? buffer.slice(0, newlineIndex - 1)
        : buffer.slice(0, newlineIndex);
      if (command === BACKUP_BASEBACKUP_COMPLETE_COMMAND) finish(undefined, command);
      else if (command === BACKUP_BASEBACKUP_ABORT_COMMAND) finish(undefined, command);
      else finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID"));
    };
    const onEnd = (): void => finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_EOF"));
    const onClose = (): void => finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_EOF"));
    const onError = (error: unknown): void => finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID", error));
    const onAbort = (): void => finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_ABORT"));
    const timer = setTimeout(() => finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_TIMEOUT")), boundedTimeoutMs);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      stream.setEncoding?.("utf8");
      stream.resume();
    } catch (error) {
      finish(new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID", error));
    }
  });
}

function envText(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function readBoundedTimeoutEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  assertTimeout: (value: unknown) => number,
): number {
  const raw = envText(env, name);
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  const parsed = Number.parseInt(raw, 10);
  return assertTimeout(parsed);
}

function persistentBackupScope(head: string, namespace: string | undefined, code: BackupRestoreBarrierErrorCode) {
  try { return backupAuthorityScope(head, BACKUP_AUTHORITY_TABLES, namespace); }
  catch (error) { throw new BackupRestoreBarrierError(code, error); }
}

/** Reads non-secret CLI configuration without returning or logging the password. */
export function readBackupRestoreCliConfig(
  env: Readonly<Record<string, string | undefined>>,
): BackupRestoreCliConfig {
  if (envText(env, "PAIOS_PG_PASSWORD") === undefined) {
    throw new BackupRestoreBarrierError("BACKUP_SECRET_ABSENT");
  }
  const backupRoot = envText(env, "PAIOS_BACKUP_ROOT");
  const migrationHead = envText(env, "PAIOS_BACKUP_MIGRATION_HEAD");
  const imageDigest = envText(env, "PAIOS_BACKUP_IMAGE_DIGEST");
  const schemaSha256 = envText(env, "PAIOS_BACKUP_SCHEMA_SHA256");
  if (backupRoot === undefined || migrationHead === undefined || imageDigest === undefined || schemaSha256 === undefined) {
    throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  }
  const head = assertMigrationHead(migrationHead, "BACKUP_INPUT_INVALID");
  const scope = persistentBackupScope(head, envText(env, "PAIOS_BACKUP_L3_NAMESPACE"), "BACKUP_INPUT_INVALID");
  return freezeRecord({
    backupRoot: assertText(backupRoot, "BACKUP_INPUT_INVALID"),
    migrationHead: head,
    ...(scope.current ? {l3Namespace: scope.l3Namespace} : {}),
    imageDigest: assertImageDigest(imageDigest, "BACKUP_INPUT_INVALID"),
    schemaSha256: assertSha256(schemaSha256, "BACKUP_INPUT_INVALID"),
    lockTimeoutMs: readBoundedTimeoutEnv(env, "PAIOS_BACKUP_LOCK_TIMEOUT_MS", DEFAULT_BACKUP_LOCK_TIMEOUT_MS, assertBoundedLockTimeout),
    commandTimeoutMs: readBoundedTimeoutEnv(env, "PAIOS_BACKUP_COMMAND_TIMEOUT_MS", DEFAULT_BACKUP_COMMAND_TIMEOUT_MS, assertBoundedCommandTimeout),
    basebackupApplicationName: BACKUP_BASEBACKUP_APPLICATION_NAME,
  });
}

export async function runPersistentWriterBarrier(
  barrier: PostgresBackupRestoreBarrier,
  input: PersistentWriterBarrierInput,
): Promise<PersistentWriterBarrierResult> {
  if (!barrier || typeof barrier.withWriterBarrier !== "function" ||
      !input?.io || typeof input.io.writeStdout !== "function" || typeof input.io.readCommandLine !== "function") {
    throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  }
  const backupRoot = assertText(input.backupRoot, "BACKUP_INPUT_INVALID");
  const migrationHead = assertMigrationHead(input.migrationHead, "BACKUP_PROTOCOL_INVALID");
  const scope = persistentBackupScope(migrationHead, input.l3Namespace, "BACKUP_PROTOCOL_INVALID");
  const imageDigest = assertImageDigest(input.imageDigest, "BACKUP_INPUT_INVALID");
  const schemaSha256 = assertSha256(input.schemaSha256, "BACKUP_INPUT_INVALID");
  const lockTimeoutMs = assertBoundedLockTimeout(input.lockTimeoutMs);
  const commandTimeoutMs = assertBoundedCommandTimeout(input.commandTimeoutMs);
  const monitorIntervalMs = assertBoundedMonitorInterval(input.monitorIntervalMs);
  if (input.basebackupApplicationName !== undefined &&
      input.basebackupApplicationName !== BACKUP_BASEBACKUP_APPLICATION_NAME) {
    throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
  }
  let snapshot: PgDiagnosticSnapshot | undefined;
  await barrier.withWriterBarrier({
    backupRoot,
    migrationHead,
    ...(scope.current ? {l3Namespace: scope.l3Namespace} : {}),
    imageDigest,
    schemaSha256,
    lockTimeoutMs,
    monitorIntervalMs,
    async runBasebackup(context) {
      snapshot = context.snapshot;
      input.io.writeStdout(readyProtocolLine(context.snapshot));
      let command: string;
      try {
        command = await input.io.readCommandLine(commandTimeoutMs, context.signal);
      } catch (error) {
        if (error instanceof BackupRestoreBarrierError) throw error;
        throw new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID", error);
      }
      if (command === BACKUP_BASEBACKUP_ABORT_COMMAND) {
        throw new BackupRestoreBarrierError("BACKUP_PROTOCOL_ABORT");
      }
      if (command !== BACKUP_BASEBACKUP_COMPLETE_COMMAND) {
        throw new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID");
      }
      return undefined;
    },
  });
  if (snapshot === undefined) throw new BackupRestoreBarrierError("BACKUP_TRANSACTION_FAILED");
  input.io.writeStdout(releasedProtocolLine(snapshot));
  return freezeRecord({ snapshot });
}

export class PostgresBackupRestoreBarrier implements WriterBarrierPort, DiagnosticSnapshotPort, BackupManifestVerifierPort, ReplayComparatorPort {
  private readonly pool: Pool;

  public constructor(pool: Pool) {
    if (!pool || typeof pool.connect !== "function") throw new BackupRestoreBarrierError("BACKUP_CONNECTION_UNKNOWN");
    this.pool = pool;
  }

  public async withWriterBarrier<T>(input: WriterBarrierInput<T>): Promise<T> {
    const backupRoot = assertText(input?.backupRoot, "BACKUP_INPUT_INVALID");
    const migrationHead = assertMigrationHead(input?.migrationHead, "BACKUP_INPUT_INVALID");
    const imageDigest = assertImageDigest(input?.imageDigest, "BACKUP_INPUT_INVALID");
    const schemaSha256 = assertSha256(input?.schemaSha256, "BACKUP_INPUT_INVALID");
    const lockTimeoutMs = assertBoundedLockTimeout(input?.lockTimeoutMs);
    const monitorIntervalMs = assertBoundedMonitorInterval(input?.monitorIntervalMs);
    if (typeof input?.runBasebackup !== "function") throw new BackupRestoreBarrierError("BACKUP_INPUT_INVALID");
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new BackupRestoreBarrierError("BACKUP_CONNECTION_UNKNOWN", error);
    }
    if (client === undefined || client === null || typeof client.query !== "function" || typeof client.release !== "function") {
      throw new BackupRestoreBarrierError("BACKUP_CONNECTION_UNKNOWN");
    }
    let begun = false;
    let committed = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      begun = true;
      await client.query(WRITER_SESSION_CONFIG_STATEMENT, [`${lockTimeoutMs}ms`]);
      const snapshot = await this.captureDiagnosticSnapshot({ client, migrationHead, imageDigest, schemaSha256, l3Namespace:input.l3Namespace, sessionConfigured: true });
      await this.assertActivitySafe(client, snapshot.backendPid, false);
      const result = await this.runMonitoredBasebackup({
        client,
        barrierPid: snapshot.backendPid,
        monitorIntervalMs,
        run: (signal) => input.runBasebackup({
          snapshot,
          backupRoot,
          snapshotName: snapshot.snapshotName,
          basebackupApplicationName: BACKUP_BASEBACKUP_APPLICATION_NAME,
          signal,
        }),
      });
      // Close the race between the final stdin command and COMMIT.  A
      // legal walsender may still be visible for a short drain window.
      await this.assertActivitySafe(client, snapshot.backendPid, true);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (begun && !committed) await client.query("ROLLBACK").catch(() => undefined);
      throw this.classifyTransactionError(error);
    } finally {
      client.release();
    }
  }

  private async assertActivitySafe(
    client: PoolClient,
    barrierPid: PositiveDecimalString,
    allowBasebackupWalsender: boolean,
  ): Promise<void> {
    try {
      const result = await client.query(BACKUP_ACTIVITY_STATEMENT);
      assertSafeActivityRows(result.rows, barrierPid, allowBasebackupWalsender);
    } catch (error) {
      if (error instanceof BackupRestoreBarrierError) throw error;
      throw new BackupRestoreBarrierError("BACKUP_LOCK_CONFLICT", error);
    }
  }

  private async runMonitoredBasebackup<T>(input: {
    readonly client: PoolClient;
    readonly barrierPid: PositiveDecimalString;
    readonly monitorIntervalMs: number;
    readonly run: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const controller = new AbortController();
    let stopped = false;
    let monitorError: unknown;
    let inFlight: Promise<void> | undefined;
    let rejectMonitor!: (error: unknown) => void;
    const monitorFailure = new Promise<never>((_resolve, reject) => {
      rejectMonitor = reject;
    });
    const tick = (): void => {
      if (stopped || inFlight !== undefined) return;
      inFlight = this.assertActivitySafe(input.client, input.barrierPid, true)
        .catch((error: unknown) => {
          if (monitorError === undefined) {
            monitorError = error;
            controller.abort();
            if (!stopped) rejectMonitor(error);
          }
        })
        .finally(() => {
          inFlight = undefined;
        });
    };
    const timer = setInterval(tick, input.monitorIntervalMs);
    timer.unref?.();
    const callbackPromise = Promise.resolve().then(() => input.run(controller.signal));
    const callbackOutcome = callbackPromise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let outcome!: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      outcome = await Promise.race([callbackOutcome, monitorFailure]);
    } finally {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      // The same pg client must not have a queued activity query when the
      // caller starts ROLLBACK or COMMIT.
      if (inFlight !== undefined) await inFlight;
      // callbackOutcome always observes callback rejection; do not await a
      // callback that ignored AbortSignal and could otherwise deadlock the
      // transaction cleanup path.
      void callbackPromise.catch(() => undefined);
    }
    if (monitorError !== undefined) throw monitorError;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  public async captureDiagnosticSnapshot(input: {
    readonly client: PoolClient;
    readonly migrationHead: string;
  readonly l3Namespace?: string | undefined;
    readonly imageDigest: string;
    readonly schemaSha256: Sha256;
    readonly sessionConfigured?: boolean;
  }): Promise<PgDiagnosticSnapshot> {
    if (!input?.client || typeof input.client.query !== "function") {
      throw new BackupRestoreBarrierError("BACKUP_CONNECTION_UNKNOWN");
    }
    const migrationHead = assertMigrationHead(input.migrationHead, "BACKUP_INPUT_INVALID");
    const imageDigest = assertImageDigest(input.imageDigest, "BACKUP_INPUT_INVALID");
    const schemaSha256 = assertSha256(input.schemaSha256, "BACKUP_INPUT_INVALID");
    try {
      if (input.sessionConfigured !== true) await input.client.query(SNAPSHOT_SESSION_CONFIG_STATEMENT);
      const backend = expectOne(await input.client.query(
        "SELECT pg_backend_pid()::text AS backend_pid, current_database()::text AS database_name, (pg_control_system()).system_identifier::text AS system_identifier",
      ), "BACKUP_SNAPSHOT_PARTIAL");
      const clock = expectOne(await input.client.query(
        "SELECT txid_current()::text AS transaction_id, pg_current_wal_lsn()::text AS wal_lsn, " +
          "to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS transaction_timestamp, " +
          "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS wall_clock_timestamp",
      ), "BACKUP_SNAPSHOT_PARTIAL");
      const scope=await inspectBackupAuthorityCatalog(input.client,{migrationHead,schemaSha256,l3Namespace:input.l3Namespace,lockForSnapshot:true});
      const countRows = (await input.client.query(tableCountSql(scope.tables))).rows;
      const tableCounts = assertTableCounts(countRows,scope.tables);
      const sequenceStates:Record<string,{lastValue:string;isCalled:boolean}>={};
      for(const name of scope.sequences) {
        const row=expectOne(await input.client.query(`SELECT last_value::text AS last_value,is_called FROM ${backupRelationSql(name)}`),"BACKUP_SNAPSHOT_PARTIAL");
        sequenceStates[name]={lastValue:assertDecimal(row.last_value),isCalled:row.is_called===true};
      }
      const tableContentSha256: Partial<Record<BackupAuthorityTable, Sha256>> = {};
      for (const table of scope.tables) {
        const contentRows = (await input.client.query(tableContentSql(table))).rows;
        const expectedCount = tableCounts[table];
        if (expectedCount !== String(contentRows.length)) {
          throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_CONFLICT");
        }
        tableContentSha256[table] = tableContentHash(contentRows);
      }
      const idempotencyRows = (await input.client.query(
        "SELECT scope::text, idempotency_key::text, request_hash::text, request_fingerprint::text, status::text, response_hash::text, response FROM public.idempotency_ledger ORDER BY scope, idempotency_key",
      )).rows;
      const outboxRows = (await input.client.query(
        "SELECT idempotency_scope::text, idempotency_key::text, event_type::text, event_id::text, aggregate_type::text, aggregate_id::text, aggregate_ref, event_version::text, payload, payload_sha256::text, status::text, attempt_count::text FROM public.outbox_events ORDER BY idempotency_scope, idempotency_key, event_type, event_id",
      )).rows;
      const dedupeRows = (await input.client.query(
        "SELECT consumer_name::text, event_id::text, payload_hash::text, " +
          "to_char(processed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS processed_at " +
          "FROM public.outbox_consumer_dedupe ORDER BY consumer_name, event_id",
      )).rows;
      const tablespaceRows = (await input.client.query("SELECT spcname::text AS tablespace_name FROM pg_catalog.pg_tablespace ORDER BY spcname")).rows;
      const validatedTableContentSha256 = assertTableContentSha256(tableContentSha256,"BACKUP_SNAPSHOT_PARTIAL",scope.tables);
      const tablespaces = assertTablespaces(tablespaceRows.map((row) => row.tablespace_name));
      const validatedIdempotencyRows = assertIdempotencyRows(idempotencyRows);
      const validatedOutboxRows = assertOutboxRows(outboxRows);
      const validatedDedupeRows = assertDedupeRows(dedupeRows);
      const idempotencyText = stableJson(validatedIdempotencyRows);
      const outboxText = stableJson(validatedOutboxRows);
      const dedupeText = stableJson(validatedDedupeRows);
      const idempotencySnapshot = freezeRecord({
        rowCount: assertDecimal(String(validatedIdempotencyRows.length)),
        rowsSha256: sha256(idempotencyText),
        requestHashesSha256: sha256(stableJson(validatedIdempotencyRows.map((row) => row.request_hash))),
        statusSha256: sha256(stableJson(validatedIdempotencyRows.map((row) => row.status))),
      });
      const outboxSnapshot = freezeRecord({
        rowCount: assertDecimal(String(validatedOutboxRows.length)),
        rowsSha256: sha256(outboxText),
        payloadHashesSha256: sha256(stableJson(validatedOutboxRows.map((row) => row.payload_sha256))),
        consumerDedupeRowsSha256: sha256(dedupeText),
      });
      const clockSnapshot = freezeRecord({
        transactionTimestamp: assertTimestamp(clock.transaction_timestamp),
        wallClockTimestamp: assertTimestamp(clock.wall_clock_timestamp),
        transactionId: assertPositiveDecimal(clock.transaction_id),
        walLsn: assertLsn(clock.wal_lsn),
      });
      const systemIdentifier = assertPositiveDecimal(backend.system_identifier);
      const databaseName = assertText(backend.database_name, "BACKUP_SNAPSHOT_PARTIAL");
      const backendPid = assertPositiveDecimal(backend.backend_pid);
      const snapshotName = assertSnapshotName(`diagnostic-${backendPid}-${clockSnapshot.transactionId}`);
      const tableCountsSha256 = sha256(stableJson(tableCounts));
      const snapshotCore = {
        ...(scope.current ? {l3Namespace:scope.l3Namespace,sequenceStates:freezeRecord(sequenceStates)} : {}),
        systemIdentifier,
        databaseName,
        backendPid,
        // Source-compatible protocol field; this is a diagnostic token only.
        // It is never passed to pg_basebackup and is not a PostgreSQL snapshot.
        snapshotName,
        migrationHead,
        imageDigest,
        schemaSha256,
        clock: clockSnapshot,
        tableCounts,
        tableContentSha256: validatedTableContentSha256,
        idempotency: idempotencySnapshot,
        outbox: outboxSnapshot,
        tablespaces,
      };
      const snapshotSha256 = sha256(stableJson(snapshotCore));
      return freezeRecord({
        schemaVersion: scope.current ? "t02.backup-restore.v2" : BACKUP_RESTORE_SCHEMA_VERSION,
        ...snapshotCore,
        capturedAt: clockSnapshot.wallClockTimestamp,
        diagnosticHashes: freezeRecord({ tableCountsSha256, snapshotSha256 }),
      });
    } catch (error) {
      if (error instanceof BackupRestoreBarrierError) throw error;
      const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined;
      if (code === "55P03" || code === "57014") {
        throw new BackupRestoreBarrierError("BACKUP_LOCK_TIMEOUT", error);
      }
      if (code === "40001" || code === "40P01") {
        throw new BackupRestoreBarrierError("BACKUP_LOCK_CONFLICT", error);
      }
      throw new BackupRestoreBarrierError("BACKUP_SNAPSHOT_PARTIAL", error);
    }
  }

  public verifyBackupManifest(value: unknown, expected: BackupManifestExpectation): VerifiedBackupManifest {
    return verifyBackupManifest(value, expected);
  }

  public compareReplay(expected: unknown, actual: unknown): ReplayComparison {
    return compareReplay(expected, actual);
  }

  private classifyTransactionError(error: unknown): BackupRestoreBarrierError {
    if (error instanceof BackupRestoreBarrierError) return error;
    const code = typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined;
    if (code === "55P03" || code === "57014") return new BackupRestoreBarrierError("BACKUP_LOCK_TIMEOUT", error);
    if (code === "40001" || code === "40P01") return new BackupRestoreBarrierError("BACKUP_LOCK_CONFLICT", error);
    return new BackupRestoreBarrierError("BACKUP_TRANSACTION_FAILED", error);
  }
}

export const LOCK_TABLE_STATEMENT = lockSql();
export const TABLE_COUNT_STATEMENT = tableCountSql();
export const CATALOG_TABLE_STATEMENT = BACKUP_CATALOG_TABLE_STATEMENT;
export const SCHEMA_FINGERPRINT_STATEMENT = BACKUP_SCHEMA_FINGERPRINT_STATEMENT;
export const TABLE_CONTENT_STATEMENTS = Object.freeze(
  Object.fromEntries(BACKUP_AUTHORITY_TABLES.map((table) => [table, tableContentSql(table)])) as Record<BackupAuthorityTable, string>,
);

function safeCliErrorCode(error: unknown): BackupRestoreBarrierErrorCode {
  return error instanceof BackupRestoreBarrierError ? error.code : "BACKUP_TRANSACTION_FAILED";
}

/**
 * Node24 entrypoint for the persistent writer barrier.  It is intentionally
 * the only process seam: T15 must hold this process open while its
 * pg_basebackup child runs, then send exactly one completion or abort line.
 */
export async function runBackupRestoreCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 1 || argv[0] !== "--mode=writer-barrier") {
    throw new BackupRestoreBarrierError("BACKUP_CLI_INVALID");
  }
  const config = readBackupRestoreCliConfig(process.env);
  const secret = process.env.PAIOS_PG_PASSWORD;
  const pool = createPostgresPool();
  try {
    const barrier = new PostgresBackupRestoreBarrier(pool);
    await runPersistentWriterBarrier(barrier, {
      ...config,
      io: {
        writeStdout(line) {
          if (line.includes("\r") || line.includes("\n") || (secret !== undefined && line.includes(secret))) {
            throw new BackupRestoreBarrierError("BACKUP_PROTOCOL_INVALID");
          }
          process.stdout.write(`${line}\n`);
        },
        readCommandLine(timeoutMs, signal) {
          return readSingleBackupCommand(process.stdin, timeoutMs, signal);
        },
      },
    });
  } finally {
    await closePostgresPool(pool);
  }
}

const directInvocation = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (directInvocation) {
  runBackupRestoreCli().catch((error: unknown) => {
    process.stderr.write(`PAIOS_BACKUP_RESTORE_ERROR:${safeCliErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
