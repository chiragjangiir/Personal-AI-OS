import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ColdCasError,
  ColdCasStore,
  PRODUCTION_HELPER_EXECUTABLE,
  PRODUCTION_ROOT,
  VALIDATION_ROOT,
  assertStrictSha256,
  createProductionColdCas,
  pathForHash,
} from "../src/cold-cas.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("strict hash and derived layout are closed and containment-safe", () => {
  assert.doesNotThrow(() => assertStrictSha256(HASH));
  assert.throws(() => assertStrictSha256(HASH.toUpperCase()), ColdCasError);
  assert.throws(() => assertStrictSha256("0".repeat(63)), ColdCasError);
  assert.throws(() => assertStrictSha256(`${HASH.slice(0, 63)}\n`), ColdCasError);
  assert.throws(() => assertStrictSha256(`${HASH.slice(0, 63)}\0`), ColdCasError);
  assert.throws(() => assertStrictSha256("../" + "0".repeat(61)), ColdCasError);

  const layout = pathForHash(VALIDATION_ROOT, HASH);
  assert.equal(layout.namespace, "sha256");
  assert.equal(layout.first, "01");
  assert.equal(layout.second, "23");
  assert.match(layout.finalPath, /[\\/]sha256[\\/]01[\\/]23[\\/]0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef$/);
  assert.doesNotThrow(() => pathForHash("K:\\PersonalAIOS\\cold-cas-001", HASH));
});

test("default store is validation-root bound and does not accept production root", () => {
  const store = new ColdCasStore();
  assert.equal(store.root.toLowerCase(), resolve(VALIDATION_ROOT).toLowerCase());
  assert.throws(() => new ColdCasStore({ root: "K:\\PersonalAIOS\\cold-cas-001" }), ColdCasError);
  assert.throws(() => new ColdCasStore({ root: "K:\\PersonalAIOS\\cold-cas-validation-001" }), ColdCasError);
  assert.throws(() => new ColdCasStore({ root: "K:\\PersonalAIOS\\cold-cas-validation-successor-001\\..\\cold-cas-001" }), ColdCasError);
});

test("production store is explicit and remains bound to compiled root and helper", async () => {
  const store = createProductionColdCas();
  assert.equal(store.profile, "production");
  assert.equal(store.root.toLowerCase(), resolve(PRODUCTION_ROOT).toLowerCase());
  assert.throws(
    () =>
      new ColdCasStore({
        profile: "production",
        root: PRODUCTION_ROOT,
        helperExecutablePath: "D:\\unexpected\\cold-cas-helper.exe",
      }),
    (error: unknown) => error instanceof ColdCasError && error.code === "INVALID_HELPER",
  );
  assert.equal(PRODUCTION_HELPER_EXECUTABLE, process.env.PAIOS_COLD_CAS_PRODUCTION_HELPER ?? "C:\\ProgramData\\PersonalAIOS\\connector-runtime-helper-production-001\\cold-cas-helper.exe");
  await store.close();
});

test("helper locations come from the process deployment configuration", () => {
  const module = new URL("../src/cold-cas.ts", import.meta.url).href;
  const code = `const m=await import(${JSON.stringify(module)}); console.log(JSON.stringify([m.DEFAULT_HELPER_EXECUTABLE,m.PRODUCTION_HELPER_EXECUTABLE]));`;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, PAIOS_COLD_CAS_VALIDATION_HELPER: "C:/fixtures/validation-helper.exe", PAIOS_COLD_CAS_PRODUCTION_HELPER: "C:/fixtures/production-helper.exe" },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(result), ["C:/fixtures/validation-helper.exe", "C:/fixtures/production-helper.exe"]);
});

test("source identity is supplied by the caller and no canonical payload is synthesized", async () => {
  const store = new ColdCasStore();
  assert.equal(typeof store.publish, "function");
  await assert.rejects(
    store.publish(HASH),
    (error: unknown) =>
      error instanceof ColdCasError &&
      (error.code === "INVALID_SOURCE" || error.code === "PRODUCTION_ROOT_PRESENT"),
  );
});

test("helper existing-object validation hashes the held handle and forbids delete-sharing reopen", async () => {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "helper", "cold-cas-helper.cs");
  const helperSource = await readFile(helperPath, "utf8");
  assert.match(helperSource, /HashHandle\(SafeFileHandle handle, ulong expectedBytes\)/u);
  assert.doesNotMatch(helperSource, /HashHandle\(path\)/u);
  assert.doesNotMatch(helperSource, /FileShareRead \| FileShareWrite \| 4/u);
  assert.match(helperSource, /existing final changed during same-handle verification/u);
  assert.match(helperSource, /return Pending\(allocation\)/u);
  assert.match(helperSource, /TryReadExisting\(allocation\.FinalPath, allocation\.Hash, 1\)/u);
  const nodeSource = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cold-cas.ts"), "utf8");
  assert.match(nodeSource, /pending = await helper\.publish\(allocationToken, request\.hash\)/u);
  assert.match(nodeSource, /complete = await helper\.finalize\(allocationToken\)/u);
});
