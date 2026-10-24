import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  admitMemoryProposal,
  type AdmittedMemoryCandidateIntent,
} from "../../memory-os/src/admission.ts";
import {
  assertSha256,
  createCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "../../memory-os/src/canonical-ref.ts";
import { createProductionMemoryCanonicalIssuer } from "../../memory-os/src/canonical-issuer.ts";
import {
  ExplicitUserRememberError,
  type ExplicitUserRememberCommand,
} from "../../memory-os/src/explicit-user-remember-service.ts";
import { compileWindowsAiContext } from "../../../phase0/gateway/src/windows-ai-context-compiler.ts";
import {
  createProductionMemoryRuntime,
  MemoryRuntimeError,
  type ProductionMemoryRuntimeOptions,
} from "../src/memory-runtime.ts";

const USER_ID = "memory-runtime-business-validation-001";
const PURPOSE_SCOPE = "conversation";
const SLOT = "preference.inspection_test_word";
const PHRASE = "巡检测试词";
const CHILD_MODE = process.env.PAIOS_MEMORY_RUNTIME_CHILD_MODE;
const RUNTIME_ENABLED = process.env.PAIOS_MEMORY_RUNTIME_PG === "1";

function postgresOptions(): ProductionMemoryRuntimeOptions["postgres"] {
  return {
    host: process.env.PAIOS_PG_HOST ?? "",
    port: Number(process.env.PAIOS_PG_PORT),
    database: process.env.PAIOS_PG_DATABASE ?? "",
    user: process.env.PAIOS_PG_USER ?? "",
    password: process.env.PAIOS_PG_PASSWORD ?? "",
    max: 2,
    connectionTimeoutMillis: 5_000,
    applicationName: `paios-memory-runtime-${CHILD_MODE ?? "parent"}`,
  };
}

function runtimeOptions(overrides: Partial<ProductionMemoryRuntimeOptions> = {}): ProductionMemoryRuntimeOptions {
  return {
    postgres: postgresOptions(),
    userId: USER_ID,
    purposeScope: PURPOSE_SCOPE,
    ...overrides,
  };
}

function evidenceRef(): CanonicalObjectVersionRef {
  return createCanonicalObjectVersionRef({
    refType: "TextEvidence",
    refId: "01952f00-0000-7000-8000-000000000201",
    objectVersion: "1",
    canonicalPayloadSha256: assertSha256(
      createHash("sha256").update(`user-said-remember:${PHRASE}`, "utf8").digest("hex"),
    ),
  });
}

function admittedCandidate(): AdmittedMemoryCandidateIntent {
  const result = admitMemoryProposal({
    proposalId: "remember-inspection-test-word-runtime-001",
    intent: { kind: "create" },
    userId: USER_ID,
    kind: "preference_memory",
    slot: SLOT,
    value: { text: PHRASE },
    sourceClass: "explicit_user_preference",
    evidenceRefs: [evidenceRef()],
    confidencePpm: 1_000_000,
    purposeScopes: [PURPOSE_SCOPE, "memory"],
    sensitivity: { classification: "normal", userConfirmed: true },
    validity: { observedAt: "2026-08-25T00:00:00.000Z" },
    idempotencyKey: "remember:inspection-test-word:runtime:001",
  });
  assert.equal(result.status, "candidate");
  if (result.status !== "candidate") throw new Error("candidate admission failed");
  return result.intent;
}

function explicitCommand(
  overrides: Partial<ExplicitUserRememberCommand> = {},
): ExplicitUserRememberCommand {
  return {
    action: "remember",
    userConfirmed: true,
    userId: USER_ID,
    purposeScopes: [PURPOSE_SCOPE, "memory"],
    memoryKind: "preference_memory",
    slot: SLOT,
    value: { text: PHRASE },
    boundedContent: PHRASE,
    evidenceRef: evidenceRef(),
    evidenceObservedAt: "2026-08-25T00:00:00.000Z",
    sensitivity: { classification: "normal", userConfirmed: true },
    validity: { observedAt: "2026-08-25T00:00:00.000Z" },
    idempotencyKey: "remember:inspection-test-word:runtime:explicit:001",
    ...overrides,
  };
}

function systemTime(): string {
  const iso = new Date().toISOString();
  return iso.replace(/\.([0-9]{3})Z$/u, ".$1000Z");
}

function parseLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assert.ok(lines.length > 0, "child produced no JSON output");
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

async function writeChild(): Promise<void> {
  const runtime = createProductionMemoryRuntime(runtimeOptions());
  try {
    const input = explicitCommand();
    const result = await runtime.rememberExplicit(input);
    const replay = await runtime.rememberExplicit(explicitCommand());
    assert.deepEqual(replay, result);
    await assert.rejects(
      runtime.rememberExplicit(explicitCommand({ value: { text: "drift" } })),
      (error: unknown) => error instanceof ExplicitUserRememberError &&
        error.code === "EXPLICIT_REMEMBER_IDEMPOTENCY_CONFLICT",
    );
    console.log(JSON.stringify({
      status: "WRITE_PASS",
      pid: process.pid,
      replayDuplicateCount: 0,
      driftWriteCount: 0,
      ...result,
    }));
  } finally {
    await runtime.close();
  }
}

function ownerRef(ref: CanonicalObjectVersionRef) {
  return {
    ref_type: ref.refType,
    ref_id: ref.refId,
    object_version: ref.objectVersion,
    canonical_payload_sha256: ref.canonicalPayloadSha256,
  };
}

async function recallChild(): Promise<void> {
  const runtime = createProductionMemoryRuntime(runtimeOptions());
  try {
    const context = await runtime.recallForAnswerContext({
      asOf: systemTime(),
      maxItems: 8,
      maxContentBytes: 4_096,
      slot: SLOT,
    });
    assert.equal(context.memories.length, 1);
    assert.equal(context.memories[0]!.boundedContent, PHRASE);
    const bindingHash = createHash("sha256").update("memory-runtime-answer-context").digest("hex");
    const answer = compileWindowsAiContext({
      providerRouteRef: {
        ref_type: "ProviderRoute",
        ref_id: "01952f00-0000-7000-8000-000000000211",
        object_version: "1",
        canonical_payload_sha256: bindingHash,
      },
      modelDefinitionRef: {
        ref_type: "ModelDefinition",
        ref_id: "01952f00-0000-7000-8000-000000000212",
        object_version: "1",
        canonical_payload_sha256: bindingHash,
      },
      instruction: "Answer using the relevant local memory context.",
      memories: context.memories.map((item) => ({
        ref: ownerRef(item.ref),
        boundedContent: item.boundedContent,
        selectionReason: item.selectionReason,
      })),
      budget: { reservedOutputTokens: 512, inputTokenLimit: 4_096 },
    }, (messages) => Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4)));
    const rendered = JSON.stringify(answer.messages);
    assert.match(rendered, /\[MEMORY_CONTEXT\]/u);
    assert.match(rendered, new RegExp(PHRASE, "u"));
    const memoryUse = answer.replayManifest.find((entry) =>
      entry.uses.some((use) => use.kind === "memory" && use.disposition === "included"));
    assert.ok(memoryUse);
    console.log(JSON.stringify({
      status: "RECALL_PASS",
      pid: process.pid,
      selectedRef: context.memories[0]!.ref,
      content: context.memories[0]!.boundedContent,
      answerContextContainsMemory: true,
      replayDisposition: "included",
    }));
  } finally {
    await runtime.close();
  }
}

async function runChildMode(): Promise<void> {
  if (CHILD_MODE === "write") return writeChild();
  if (CHILD_MODE === "recall") return recallChild();
  throw new Error("PAIOS_MEMORY_RUNTIME_CHILD_MODE_INVALID");
}

if (CHILD_MODE !== undefined) {
  await runChildMode();
} else {
  test("production memory runtime fails closed before PostgreSQL on missing config", () => {
    assert.throws(() => createProductionMemoryRuntime({
      postgres: { host: "", port: 0, database: "", user: "", password: "" },
      userId: USER_ID,
      purposeScope: PURPOSE_SCOPE,
    }), (error: unknown) => error instanceof MemoryRuntimeError && error.code === "MEMORY_RUNTIME_CONFIG_INVALID");
  });

  test("production memory runtime rejects scope and receipt drift before SQL", async () => {
    const runtime = createProductionMemoryRuntime(runtimeOptions({
      userId: "different-user",
      postgres: {
        host: "127.0.0.1",
        port: 1,
        database: "not_connected",
        user: "not_connected",
        password: "not_connected",
        max: 1,
        connectionTimeoutMillis: 100,
        applicationName: "paios-memory-runtime-negative-no-sql",
      },
    }));
    const candidate = admittedCandidate();
    const candidateKey = "memory-runtime:negative:candidate";
    const memoryKey = "memory-runtime:negative:memory";
    try {
      await assert.rejects(runtime.remember({
        candidate,
        candidateReceipt: {} as never,
        memoryReceipt: {} as never,
        candidateAppendIdempotencyKey: candidateKey,
        candidateAppendFingerprint: assertSha256(createHash("sha256").update(candidateKey).digest("hex")),
        memoryAppendIdempotencyKey: memoryKey,
        memoryAppendFingerprint: assertSha256(createHash("sha256").update(memoryKey).digest("hex")),
      }), (error: unknown) => error instanceof MemoryRuntimeError && error.code === "MEMORY_RUNTIME_BINDING_INVALID");
      await assert.rejects(runtime.recallForAnswerContext({
        userId: USER_ID,
        asOf: "2026-08-25T00:00:00.000Z",
        maxItems: 1,
        maxContentBytes: 128,
      } as never), (error: unknown) => error instanceof MemoryRuntimeError && error.code === "MEMORY_RUNTIME_QUERY_SCOPE_INVALID");
      await assert.rejects(
        runtime.rememberExplicit(explicitCommand()),
        (error: unknown) => error instanceof ExplicitUserRememberError &&
          error.code === "EXPLICIT_REMEMBER_PERSISTENCE_FAILED" &&
          error.cause instanceof MemoryRuntimeError &&
          error.cause.code === "MEMORY_RUNTIME_BINDING_INVALID",
      );
      await assert.rejects(
        runtime.rememberExplicit({
          ...explicitCommand({ idempotencyKey: "runtime-negative-unconfirmed" }),
          userConfirmed: false,
        } as unknown as ExplicitUserRememberCommand),
        (error: unknown) => error instanceof ExplicitUserRememberError &&
          error.code === "EXPLICIT_REMEMBER_CONFIRMATION_REQUIRED",
      );
    } finally {
      await runtime.close();
    }

    const wrongPurpose = createProductionMemoryRuntime(runtimeOptions({
      purposeScope: "different-purpose",
      postgres: {
        host: "127.0.0.1",
        port: 1,
        database: "not_connected",
        user: "not_connected",
        password: "not_connected",
        max: 1,
        connectionTimeoutMillis: 100,
        applicationName: "paios-memory-runtime-purpose-negative-no-sql",
      },
    }));
    try {
      await assert.rejects(
        wrongPurpose.rememberExplicit(explicitCommand({
          idempotencyKey: "runtime-negative-purpose",
        })),
        (error: unknown) => error instanceof ExplicitUserRememberError &&
          error.code === "EXPLICIT_REMEMBER_PERSISTENCE_FAILED" &&
          error.cause instanceof MemoryRuntimeError &&
          error.cause.code === "MEMORY_RUNTIME_BINDING_INVALID",
      );
    } finally {
      await wrongPurpose.close();
    }
  });

  test("remember survives writer exit and a new Node process enters recalled memory into answer context", {
    skip: !RUNTIME_ENABLED,
  }, () => {
    const file = fileURLToPath(import.meta.url);
    const baseEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" };
    const write = spawnSync(process.execPath, ["--experimental-strip-types", file], {
      cwd: process.cwd(),
      env: { ...baseEnv, PAIOS_MEMORY_RUNTIME_CHILD_MODE: "write" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(write.status, 0, write.stderr || write.stdout);
    const written = parseLastJson(write.stdout);
    assert.equal(written.status, "WRITE_PASS");
    assert.equal(written.replayDuplicateCount, 0);
    assert.equal(written.driftWriteCount, 0);
    const recall = spawnSync(process.execPath, ["--experimental-strip-types", file], {
      cwd: process.cwd(),
      env: { ...baseEnv, PAIOS_MEMORY_RUNTIME_CHILD_MODE: "recall" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(recall.status, 0, recall.stderr || recall.stdout);
    const recalled = parseLastJson(recall.stdout);
    assert.equal(recalled.status, "RECALL_PASS");
    assert.notEqual(written.pid, recalled.pid);
    assert.deepEqual(recalled.selectedRef, written.memoryRef);
    assert.equal(recalled.content, PHRASE);
    assert.equal(recalled.answerContextContainsMemory, true);
    assert.equal(recalled.replayDisposition, "included");
    console.log(JSON.stringify({
      status: "BUSINESS_PASS",
      writePid: written.pid,
      recallPid: recalled.pid,
      memoryRef: written.memoryRef,
      selectedRef: recalled.selectedRef,
      content: recalled.content,
      answerContextContainsMemory: recalled.answerContextContainsMemory,
      replayDisposition: recalled.replayDisposition,
    }));
  });
}
