import { DatabaseError, type Pool, type PoolClient } from "pg";

export type TransactionIsolation =
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}

export type PostgresTransactionPhase = "begin" | "work" | "commit" | "rollback";

export class PostgresTxError extends Error {
  readonly code = "POSTGRES_TX_ERROR";
  readonly phase: PostgresTransactionPhase;
  readonly outcomeUncertain: boolean;

  constructor(phase: PostgresTransactionPhase, outcomeUncertain: boolean, cause?: unknown) {
    super("POSTGRES_TRANSACTION_" + phase.toUpperCase(), cause === undefined ? undefined : { cause });
    this.name = "PostgresTxError";
    this.phase = phase;
    this.outcomeUncertain = outcomeUncertain;
  }
}

export function isPostgresTxOutcomeUncertain(error: unknown): boolean {
  return error instanceof PostgresTxError && error.outcomeUncertain;
}

function isDefiniteCommitRejection(error: unknown): boolean {
  // Only a server ErrorResponse proves rejection. Socket codes such as EPIPE
  // can also have five characters. Connection/fatal errors and SQLSTATE 40003
  // explicitly leave completion unknown, even when emitted by PostgreSQL.
  return error instanceof DatabaseError && error.severity === "ERROR" &&
    typeof error.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code) &&
    !error.code.startsWith("08") && error.code !== "40003";
}

export type TransactionWork<T> = (client: PoolClient) => Promise<T>;

const ISOLATIONS: ReadonlySet<string> = new Set([
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
]);
const MANAGED_TRANSACTION_CLIENTS = new WeakSet<object>();

export function isManagedTransactionClient(value: unknown): value is PoolClient {
  return typeof value === "object" && value !== null && MANAGED_TRANSACTION_CLIENTS.has(value);
}

export async function withTransaction<T>(
  pool: Pool,
  work: TransactionWork<T>,
  options: TransactionOptions = {},
): Promise<T> {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("pool is required");
  }
  if (typeof work !== "function") throw new TypeError("transaction work is required");
  const isolation = options.isolation ?? "READ COMMITTED";
  if (!ISOLATIONS.has(isolation)) throw new TypeError("unsupported transaction isolation");
  const client = await pool.connect();
  let committed = false;
  let destroyClient = false;
  let phase: PostgresTransactionPhase = "begin";
  try {
    MANAGED_TRANSACTION_CLIENTS.add(client);
    await client.query("BEGIN");
    const beginOptions = "SET TRANSACTION ISOLATION LEVEL " + isolation +
      (options.readOnly ? " READ ONLY" : "") +
      (options.deferrable ? " DEFERRABLE" : "");
    await client.query(beginOptions);
    phase = "work";
    const result = await work(client);
    phase = "commit";
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    const failedPhase = phase;
    if (!committed) {
      try {
        phase = "rollback";
        await client.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
    }
    // Before COMMIT, connection loss and failed cleanup cannot commit work.
    // After COMMIT, a successful ROLLBACK cannot undo or disprove a commit.
    if (failedPhase === "commit" && !isDefiniteCommitRejection(error)) {
      throw new PostgresTxError("commit", true, error);
    }
    throw error;
  } finally {
    MANAGED_TRANSACTION_CLIENTS.delete(client);
    client.release(destroyClient ? true : undefined);
  }
}

export async function withSerializableTransaction<T>(
  pool: Pool,
  work: TransactionWork<T>,
): Promise<T> {
  return withTransaction(pool, work, { isolation: "SERIALIZABLE" });
}

export async function withReadOnlyTransaction<T>(
  pool: Pool,
  work: TransactionWork<T>,
): Promise<T> {
  return withTransaction(pool, work, { readOnly: true });
}
