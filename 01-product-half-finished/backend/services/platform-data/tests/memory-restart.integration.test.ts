import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import type { ExplicitUserRememberCommand } from "../../memory-os/src/explicit-user-remember-service.ts";
import {
  createProductionMemoryRuntime,
  type ProductionMemoryRuntimeOptions,
} from "../src/memory-runtime.ts";
import { closePostgresPool, createPostgresPool, isPostgresConfigured } from "../src/postgres-pool.ts";

const RUN = process.env.PAIOS_RUN_PG_RESTART === "1";
const CHILD_PHASE = process.env.PAIOS_MEMORY_RESTART_CHILD;
const CONTAINER = process.env.PAIOS_MEMORY_RESTART_CONTAINER ?? "";
const SKIP_REASON = "set exact PAIOS_PG_* values, PAIOS_MEMORY_RESTART_CONTAINER, and PAIOS_RUN_PG_RESTART=1";
const DOCKER = process.env.PAIOS_DOCKER_CLI ?? "G:\\安装文件\\DockerDesktop\\resources\\bin\\docker.exe";
const USER = "memory-explicit-restart-source-028";
const PURPOSE = "conversation";
const SLOT = "preference.restart_inspection_word";
const PHRASE = "巡检测试词-容器重启";
const KEY = "explicit-remember-source-028-postgres-restart-001";

function postgresOptions(phase: string): ProductionMemoryRuntimeOptions["postgres"] {
  return {
    host: process.env.PAIOS_PG_HOST ?? "",
    port: Number(process.env.PAIOS_PG_PORT),
    database: process.env.PAIOS_PG_DATABASE ?? "",
    user: process.env.PAIOS_PG_USER ?? "",
    password: process.env.PAIOS_PG_PASSWORD ?? "",
    max: 2,
    connectionTimeoutMillis: 5_000,
    applicationName: `memory-explicit-restart-${phase}`,
  };
}

function runtimeOptions(phase: string): ProductionMemoryRuntimeOptions {
  return { postgres: postgresOptions(phase), userId: USER, purposeScope: PURPOSE };
}

function evidenceRef() {
  return createCanonicalObjectVersionRef({
    refType: "TextEvidence",
    refId: "01952f00-0000-7000-8000-000000000401",
    objectVersion: "1",
    canonicalPayloadSha256: createHash("sha256").update(`restart:${PHRASE}`, "utf8").digest("hex"),
  });
}

function rememberCommand(): ExplicitUserRememberCommand {
  return {
    action: "remember",
    userConfirmed: true,
    userId: USER,
    purposeScopes: [PURPOSE, "memory"],
    memoryKind: "preference_memory",
    slot: SLOT,
    value: { text: PHRASE },
    boundedContent: PHRASE,
    evidenceRef: evidenceRef(),
    evidenceObservedAt: "2026-08-26T02:00:00.000Z",
    sensitivity: { classification: "normal", userConfirmed: true },
    validity: { observedAt: "2026-08-26T02:00:00.000Z" },
    idempotencyKey: KEY,
  };
}

async function child(phase: "write" | "read"): Promise<void> {
  const runtime = createProductionMemoryRuntime(runtimeOptions(phase));
  try {
    if (phase === "write") {
      const result = await runtime.rememberExplicit(rememberCommand());
      console.log(JSON.stringify({ status: "RESTART_WRITE_PASS", pid: process.pid, ...result }));
      return;
    }
    const context = await runtime.recallForAnswerContext({
      asOf: new Date().toISOString(),
      maxItems: 4,
      maxContentBytes: 2_048,
      slot: SLOT,
    });
    assert.equal(context.memories.length, 1);
    assert.equal(context.memories[0]!.boundedContent, PHRASE);
    console.log(JSON.stringify({
      status: "RESTART_RECALL_PASS",
      pid: process.pid,
      selectedRef: context.memories[0]!.ref,
      content: context.memories[0]!.boundedContent,
      selectionReason: context.memories[0]!.selectionReason,
      authorityWatermark: context.authorityWatermark,
    }));
  } finally {
    await runtime.close();
  }
}

function container(action: "start" | "stop"): void {
  if (CONTAINER.length === 0) throw new Error("MEMORY_RESTART_CONTAINER_MISSING");
  execFileSync(DOCKER, [action, CONTAINER], { env: { ...process.env }, stdio: "ignore" });
}

function parseChild(phase: "write" | "read"): Record<string, unknown> {
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url)],
    { env: { ...process.env, PAIOS_MEMORY_RESTART_CHILD: phase }, encoding: "utf8" },
  );
  const lines = stdout.trim().split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assert.ok(lines.length > 0, `${phase} child produced no receipt`);
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = createPostgresPool({ applicationName: "memory-restart-health" });
    try {
      await probe.query("SELECT 1");
      await closePostgresPool(probe);
      return;
    } catch {
      await closePostgresPool(probe).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("MEMORY_RESTART_TIMEOUT");
}

if (CHILD_PHASE !== undefined) {
  await child(CHILD_PHASE as "write" | "read");
} else {
  test("explicit remember survives writer exit and PostgreSQL restart into a new runtime context", {
    skip: !RUN || !isPostgresConfigured() || CONTAINER.length === 0 ? SKIP_REASON : false,
    concurrency: false,
  }, async () => {
    container("start");
    await waitForDatabase();
    const pool = createPostgresPool({ ...postgresOptions("preflight"), applicationName: "memory-explicit-restart-preflight" });
    try {
      const schema = await pool.query<{ readonly ready: boolean }>(
        "SELECT to_regclass('public.memory_candidates') IS NOT NULL AND to_regclass('public.memory_versions') IS NOT NULL AND to_regclass('public.memory_candidate_heads') IS NOT NULL AND to_regclass('public.memory_slot_heads') IS NOT NULL AND to_regclass('public.idempotency_ledger') IS NOT NULL AS ready",
      );
      assert.equal(schema.rows[0]?.ready, true);
      const initial = await pool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM memory_versions WHERE user_id = $1 AND slot = $2",
        [USER, SLOT],
      );
      assert.equal(initial.rows[0]?.count, "0", "restart validation identity must be unused");
    } finally {
      await closePostgresPool(pool);
    }
    try {
      const written = parseChild("write");
      assert.equal(written.status, "RESTART_WRITE_PASS");
      container("stop");
      container("start");
      await waitForDatabase();
      const recalled = parseChild("read");
      assert.equal(recalled.status, "RESTART_RECALL_PASS");
      assert.notEqual(written.pid, recalled.pid);
      assert.deepEqual(recalled.selectedRef, written.memoryRef);
      assert.equal(recalled.content, PHRASE);

      const verify = createPostgresPool({ ...postgresOptions("verify"), applicationName: "memory-explicit-restart-verify" });
      try {
        const rows = await verify.query<{ readonly memories: string; readonly candidates: string }>(
          "SELECT (SELECT count(*)::text FROM memory_versions WHERE user_id = $1 AND slot = $2 AND status = 'current' AND current = TRUE AND canonical_payload_jcs IS NOT NULL) AS memories, (SELECT count(*)::text FROM memory_candidates WHERE user_id = $1 AND slot = $2 AND status = 'candidate' AND canonical_payload_jcs IS NOT NULL) AS candidates",
          [USER, SLOT],
        );
        assert.equal(rows.rows[0]?.memories, "1");
        assert.equal(rows.rows[0]?.candidates, "1");
      } finally {
        await closePostgresPool(verify);
      }
      console.log(JSON.stringify({
        status: "PG_RESTART_BUSINESS_PASS",
        writePid: written.pid,
        recallPid: recalled.pid,
        memoryRef: written.memoryRef,
        selectedRef: recalled.selectedRef,
        content: recalled.content,
        currentMemoryRows: 1,
        candidateRows: 1,
      }));
    } finally {
      container("stop");
    }
  });
}
