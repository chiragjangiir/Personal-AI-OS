import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closePostgresPool,
  createPostgresPool,
} from "../src/postgres-pool.ts";

const ENV_NAMES = [
  "PAIOS_PG_HOST",
  "PAIOS_PG_PORT",
  "PAIOS_PG_DATABASE",
  "PAIOS_PG_USER",
  "PAIOS_PG_PASSWORD",
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const name of ENV_NAMES) {
    const value = snapshot.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("complete explicit config ignores hostile ambient PG environment", async () => {
  const snapshot = snapshotEnv();
  for (const name of ENV_NAMES) process.env[name] = "not-a-valid-ambient-value";
  let pool: ReturnType<typeof createPostgresPool> | undefined;
  try {
    pool = createPostgresPool({
      host: "explicit-host",
      port: 55499,
      database: "explicit-database",
      user: "explicit-user",
      password: "explicit-password",
      max: 2,
      idleTimeoutMillis: 123,
      connectionTimeoutMillis: 456,
      applicationName: "explicit-application",
    });
    assert.equal(pool.options.host, "explicit-host");
    assert.equal(pool.options.port, 55499);
    assert.equal(pool.options.database, "explicit-database");
    assert.equal(pool.options.user, "explicit-user");
    assert.equal(pool.options.password, "explicit-password");
    assert.equal(pool.options.max, 2);
    assert.equal(pool.options.idleTimeoutMillis, 123);
    assert.equal(pool.options.connectionTimeoutMillis, 456);
    assert.equal(pool.options.application_name, "explicit-application");
  } finally {
    if (pool !== undefined) await closePostgresPool(pool);
    restoreEnv(snapshot);
  }
});

test("omitted fields retain legacy environment fallback", async () => {
  const snapshot = snapshotEnv();
  process.env.PAIOS_PG_HOST = "environment-host";
  process.env.PAIOS_PG_PORT = "55498";
  process.env.PAIOS_PG_DATABASE = "environment-database";
  process.env.PAIOS_PG_USER = "environment-user";
  process.env.PAIOS_PG_PASSWORD = "environment-password";
  let pool: ReturnType<typeof createPostgresPool> | undefined;
  try {
    pool = createPostgresPool({ max: 1 });
    assert.equal(pool.options.host, "environment-host");
    assert.equal(pool.options.port, 55498);
    assert.equal(pool.options.database, "environment-database");
    assert.equal(pool.options.user, "environment-user");
    assert.equal(pool.options.password, "environment-password");
  } finally {
    if (pool !== undefined) await closePostgresPool(pool);
    restoreEnv(snapshot);
  }
});
