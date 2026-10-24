import { Pool, type PoolConfig } from "pg";

export interface PostgresPoolOptions {
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 55432;
const DEFAULT_DATABASE = "personal_ai_os";
const DEFAULT_MAX = 10;

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("positive safe integer required");
  }
  return value;
}

function envText(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function createPostgresPool(options: PostgresPoolOptions = {}): Pool {
  const configuredPort = options.port === undefined ? envText("PAIOS_PG_PORT") : undefined;
  const port = options.port === undefined
    ? positiveInteger(configuredPort === undefined ? undefined : Number(configuredPort), DEFAULT_PORT)
    : positiveInteger(options.port, DEFAULT_PORT);
  const max = positiveInteger(options.max, DEFAULT_MAX);
  const config: PoolConfig = {
    host: options.host ?? envText("PAIOS_PG_HOST") ?? DEFAULT_HOST,
    port,
    database: options.database ?? envText("PAIOS_PG_DATABASE") ?? DEFAULT_DATABASE,
    user: options.user ?? envText("PAIOS_PG_USER"),
    max,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? "personal-ai-os-platform-data",
  };
  const password = options.password ?? envText("PAIOS_PG_PASSWORD");
  if (password !== undefined) config.password = password;
  const pool = new Pool(config);
  pool.on("error", () => {
    // pg-pool has already removed the failed idle client. Emit a fixed event
    // without connection options, query data, error messages or credentials.
    console.error(JSON.stringify({ event: "POSTGRES_POOL_IDLE_ERROR" }));
  });
  return pool;
}

export async function closePostgresPool(pool: Pool): Promise<void> {
  await pool.end();
}

export function isPostgresConfigured(): boolean {
  return Boolean(
    envText("PAIOS_PG_DATABASE") &&
    envText("PAIOS_PG_USER") &&
    envText("PAIOS_PG_PASSWORD"),
  );
}
