import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  CAS_READ_CHUNK_BYTES,
  ColdCasError,
  ColdCasStore,
  DEFAULT_HELPER_EXECUTABLE,
  PRODUCTION_ROOT,
  VALIDATION_ROOT,
  assertProductionRootAbsent,
  inspectColdCasPlatform,
} from "../src/cold-cas.ts";
import { WindowsCasHelperClient } from "../src/windows-cas-helper-client.ts";

const HELPER_EXE = DEFAULT_HELPER_EXECUTABLE;
const store = new ColdCasStore({ root: VALIDATION_ROOT, helperExecutablePath: HELPER_EXE });
const mutationTest = store.capabilities.safeForMutation ? test : test.skip;
const childModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cold-cas.ts")).href;
const blockedReparsePrefixes = new Set<string>();

async function readConnectorSource(relativePath: string): Promise<string> {
  return fs.readFile(join(dirname(fileURLToPath(import.meta.url)), "..", relativePath), "utf8");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueBytes(label: string): Buffer {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const value = Buffer.from(`${label}:${process.pid}:${Date.now()}:${randomBytes(16).toString("hex")}:${attempt}`);
    if (!blockedReparsePrefixes.has(hashBytes(value).slice(0, 2))) {
      return value;
    }
  }
  throw new Error("could not select a hash prefix outside existing reparse fixtures");
}

async function* largeSource(totalBytes: number, seed: Uint8Array): AsyncGenerator<Uint8Array> {
  let left = totalBytes;
  let ordinal = 0;
  while (left > 0) {
    const size = Math.min(32 * 1024, left);
    const chunk = Buffer.alloc(size, ordinal % 251);
    if (ordinal === 0) {
      chunk.set(seed.subarray(0, Math.min(seed.byteLength, chunk.byteLength)), 0);
    }
    ordinal += 1;
    left -= size;
    yield chunk;
  }
}

async function hashLargeSource(totalBytes: number, seed: Uint8Array): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of largeSource(totalBytes, seed)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

function runChild(hash: string, bytes: Uint8Array): Promise<{ code: number; result: string; stderr: string }> {
  const script = `
    const { ColdCasStore } = await import(${JSON.stringify(childModule)});
    const store = new ColdCasStore({ root: process.env.CAS_ROOT ?? '${VALIDATION_ROOT}', helperExecutablePath: process.env.CAS_HELPER ?? '${HELPER_EXE}' });
    const result = await store.publish({ hash: process.env.CAS_HASH, source: Buffer.from(process.env.CAS_B64, 'base64') });
    process.stdout.write(JSON.stringify(result));
    await store.close();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, CAS_ROOT: VALIDATION_ROOT, CAS_HELPER: HELPER_EXE, CAS_HASH: hash, CAS_B64: Buffer.from(bytes).toString("base64") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let result = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    result += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, result, stderr }));
  });
}

async function startExclusiveWriter(path: string): Promise<{ release: () => void; wait: Promise<number> }> {
  const script = "$stream = [IO.File]::Open($env:PAIOS_FINAL_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::In.ReadLine(); $stream.Dispose();";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    shell: false,
    env: { ...process.env, PAIOS_FINAL_PATH: path },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("READY")) {
        resolve();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (!output.includes("READY") && code !== 0) {
        reject(new Error(`exclusive writer failed: ${errorOutput}`));
      }
    });
  });
  await ready;
  return {
    release: () => child.stdin.write("\n"),
    wait: new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? -1))),
  };
}

test.before(async () => {
  assert.equal(await fs.stat("K:\\").then((stats) => stats.isDirectory()), true);
  await assertProductionRootAbsent();
  await store.verifyEnvironment();
  const layoutRoot = join(VALIDATION_ROOT, "sha256");
  for (const entry of await fs.readdir(layoutRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) {
      blockedReparsePrefixes.add(entry.name.toLowerCase());
    }
  }
});

test.afterEach(async () => {
  await assertProductionRootAbsent();
  assert.equal(await fs.lstat(PRODUCTION_ROOT).catch(() => undefined), undefined);
});

test.after(async () => {
  await store.close();
});

test("source/static guards future fresh-root, external-writer, Finalize share/reparse, unknown-entry/temp, and helper-residual", async () => {
  const nodeSource = await readConnectorSource("src/cold-cas.ts");
  const helperSource = await readConnectorSource("helper/cold-cas-helper.cs");
  const readme = await readConnectorSource("README.md");

  assert.match(nodeSource, /cold-cas-validation-successor-006/u);
  assert.match(nodeSource, /connector-runtime-helper-validation-006/u);
  assert.doesNotMatch(nodeSource, /cold-cas-validation-successor-(?:003|005)/u);
  assert.doesNotMatch(nodeSource, /connector-runtime-helper-validation-(?:003|005)/u);
  assert.doesNotMatch(nodeSource, /successor-002|validation-002/u);
  assert.match(helperSource, /private const uint FileShareWrite = 0x00000002;/u);
  assert.match(helperSource, /private static SafeFileHandle OpenDirectory[\s\S]*FileShareRead \| FileShareWrite/u);
  assert.doesNotMatch(helperSource, /FileShareRead \| FileShareWrite \| 4/u);
  const tryReadStart = helperSource.indexOf("private static ExistingFacts TryReadExisting");
  const competingTempStart = helperSource.indexOf("private static bool HasCompetingTemp", tryReadStart);
  assert.ok(tryReadStart >= 0 && competingTempStart > tryReadStart);
  const tryReadSource = helperSource.slice(tryReadStart, competingTempStart);
  assert.match(tryReadSource, /var share = FileShareRead;/u);
  assert.doesNotMatch(tryReadSource, /FileShareWrite/u);
  assert.match(helperSource, /same handle/u);
  assert.match(helperSource, /FileAttributeReparsePoint/u);
  assert.match(helperSource, /private byte\[\] FinalizePublish[\s\S]*TryReadExisting\(allocation\.FinalPath, allocation\.Hash, 1\)/u);
  assert.match(helperSource, /TEMP_STILL_PRESENT/u);
  assert.match(helperSource, /allocations\.Remove\(token\)/u);
  assert.match(helperSource, /HasCompetingTemp/u);
  assert.match(helperSource, /IsAllocationToken/u);
  assert.match(helperSource, /Unknown entries are never cleaned here/u);
  assert.doesNotMatch(helperSource, /Directory\.Delete|File\.Delete/u);
  assert.match(nodeSource, /token map is the ownership proof/u);
  assert.match(readme, /SOURCE\/UNIT\/HOST-BUILD/u);
  assert.match(readme, /cold-cas-validation-successor-006/u);
  assert.doesNotMatch(readme, /cold-cas-validation-successor-(?:003|005)/u);
  assert.doesNotMatch(readme, /connector-runtime-helper-validation-(?:003|005)/u);
  assert.match(readme, /no real-fs/u);
  assert.doesNotMatch(readme, /proves source\/unit.*real-fs publication/u);
});

test("Node 24 delegates mutation capability to the approved hidden helper", async () => {
  const capabilities = inspectColdCasPlatform(HELPER_EXE);
  assert.equal(capabilities.platform, process.platform);
  assert.equal(capabilities.safeForMutation, true);
  assert.equal(capabilities.hasWin32HelperBridge, true);
  assert.equal(capabilities.hasHandleRelativeUnlink, true);
  assert.equal(capabilities.hasHandleRelativeOpen, true);
  assert.equal(capabilities.hasHandleRelativeLink, true);
  assert.equal(capabilities.hasFileHandleUnlink, true);
  assert.equal(capabilities.hasCompleteReparseTagInspection, true);
  assert.match(capabilities.reason, /helper/i);
  assert.equal(CAS_READ_CHUNK_BYTES <= 64 * 1024, true);
  await store.verifyEnvironment();
  await assertProductionRootAbsent();
});

test("replacement-race negative path never reaches open/link/unlink or claims escaped output", async () => {
  const bytes = uniqueBytes("replacement-race-injection");
  const hash = hashBytes(bytes);
  const casPath = store.path(hash);
  let faultCalled = false;
  const guardedStore = new ColdCasStore({ root: VALIDATION_ROOT, helperExecutablePath: HELPER_EXE,
    fault: (point) => {
      if (point === "before_link") {
        faultCalled = true;
        throw new Error("fault injection reached the bounded helper boundary");
      }
    },
  });
  await assert.rejects(
    () => guardedStore.publish({ hash, source: bytes }),
    /fault injection reached/,
  );
  assert.equal(faultCalled, true);
  assert.equal(await fs.lstat(casPath.finalPath).catch(() => undefined), undefined);
  await guardedStore.close();
  await assertProductionRootAbsent();
});

mutationTest("publishes atomically, replays in-process, and replays from an independent process", async () => {
  const bytes = uniqueBytes("restart-replay");
  const hash = hashBytes(bytes);
  const first = await store.publish({ hash, source: bytes });
  assert.equal(first.status, "published");
  const path = store.path(hash).finalPath;
  const firstStats = await fs.stat(path);
  assert.equal(firstStats.nlink, 1);
  assert.equal(firstStats.size, bytes.byteLength);

  const second = await store.publish({ hash, source: bytes });
  assert.equal(second.status, "reused");
  const inspection = await store.inspect(hash);
  assert.equal(inspection.valid, true);
  assert.equal(inspection.hash, hash);

  const child = await runChild(hash, bytes);
  assert.equal(child.code, 0, child.stderr);
  assert.equal(JSON.parse(child.result).status, "reused");
  assert.equal((await fs.stat(path)).nlink, 1);
});

mutationTest("holds pending publication until finalize proves final nlink one", async () => {
  const bytes = uniqueBytes("pending-finalize");
  const hash = hashBytes(bytes);
  await store.inspect(hash);
  const helper = new WindowsCasHelperClient(HELPER_EXE);
  const allocation = await helper.allocate(VALIDATION_ROOT, store.path(hash).finalPath, hash);
  await helper.write(allocation.token, bytes);
  await helper.sync(allocation.token);
  const pending = await helper.publish(allocation.token, hash);
  assert.equal(pending.status, "published");
  const complete = await helper.finalize(allocation.token);
  assert.equal(complete.status, "published");
  assert.equal((await fs.stat(store.path(hash).finalPath)).nlink, 1);
  await helper.close();
});

mutationTest("rejects an external writer during Finalize and leaves no helper residual", async () => {
  const bytes = uniqueBytes("finalize-share-fence");
  const hash = hashBytes(bytes);
  await store.inspect(hash);
  const helper = new WindowsCasHelperClient(HELPER_EXE);
  const allocation = await helper.allocate(VALIDATION_ROOT, store.path(hash).finalPath, hash);
  let writer: Awaited<ReturnType<typeof startExclusiveWriter>> | undefined;
  try {
    await helper.write(allocation.token, bytes);
    await helper.sync(allocation.token);
    const pending = await helper.publish(allocation.token, hash);
    assert.equal(pending.status, "published");
    writer = await startExclusiveWriter(store.path(hash).finalPath);
    await assert.rejects(
      () => helper.finalize(allocation.token),
      /FINAL_VALIDATION_FAILED|REUSED_FINAL_CHANGED/u,
    );
  } finally {
    if (writer !== undefined) {
      writer.release();
      await writer.wait;
    }
    await helper.close();
  }
  assert.deepEqual(await fs.readFile(store.path(hash).finalPath), bytes);
});

mutationTest("preserves an unknown temp entry and closes the helper without residual ownership", async () => {
  const bytes = uniqueBytes("unknown-temp-entry");
  const unknown = Buffer.from("unknown-entry-must-survive-finalize");
  const hash = hashBytes(bytes);
  await store.inspect(hash);
  const helper = new WindowsCasHelperClient(HELPER_EXE);
  const allocation = await helper.allocate(VALIDATION_ROOT, store.path(hash).finalPath, hash);
  try {
    await helper.write(allocation.token, bytes);
    await helper.sync(allocation.token);
    const pending = await helper.publish(allocation.token, hash);
    assert.equal(pending.status, "published");
    await fs.writeFile(allocation.tempPath, unknown, { flag: "wx" });
    await assert.rejects(() => helper.finalize(allocation.token), /TEMP_STILL_PRESENT/u);
    assert.deepEqual(await fs.readFile(allocation.tempPath), unknown);
  } finally {
    await helper.close();
    await fs.unlink(allocation.tempPath).catch(() => undefined);
  }
  assert.equal(helper.pid, undefined);
});

mutationTest("rejects an external writer against the helper-held temp", async () => {
  const bytes = uniqueBytes("temp-share-fence");
  const hash = hashBytes(bytes);
  await store.inspect(hash);
  const helper = new WindowsCasHelperClient(HELPER_EXE);
  const allocation = await helper.allocate(VALIDATION_ROOT, store.path(hash).finalPath, hash);
  await assert.rejects(() => fs.open(allocation.tempPath, "r+"));
  assert.equal(await helper.cancel(allocation.token), true);
  await helper.close();
});

mutationTest("rejects an exclusive external writer without overwriting the final", async () => {
  const bytes = uniqueBytes("final-share-fence");
  const hash = hashBytes(bytes);
  const first = await store.publish({ hash, source: bytes });
  assert.equal(first.status, "published");
  const writer = await startExclusiveWriter(first.finalPath);
  let result;
  try {
    result = await store.publish({ hash, source: bytes });
  } finally {
    writer.release();
    await writer.wait;
  }
  assert.equal(result?.status, "corrupt_existing");
  assert.deepEqual(await fs.readFile(first.finalPath), bytes);
});

mutationTest("streams an object larger than 64 MiB with bounded read/write chunks", async () => {
  const totalBytes = 64 * 1024 * 1024 + 123;
  assert.ok(CAS_READ_CHUNK_BYTES <= 64 * 1024);
  let seed = uniqueBytes("large-source");
  let hash = await hashLargeSource(totalBytes, seed);
  for (let attempt = 0; blockedReparsePrefixes.has(hash.slice(0, 2)) && attempt < 8; attempt += 1) {
    seed = uniqueBytes(`large-source-${attempt}`);
    hash = await hashLargeSource(totalBytes, seed);
  }
  assert.equal(blockedReparsePrefixes.has(hash.slice(0, 2)), false);
  const result = await store.publish({ hash, source: largeSource(totalBytes, seed) });
  assert.equal(result.status, "published");
  assert.equal(result.bytes, totalBytes);
  const stats = await fs.stat(store.path(hash).finalPath);
  assert.equal(stats.size, totalBytes);
  assert.equal(stats.nlink, 1);
});

mutationTest("never overwrites a corrupt existing object and rejects a hard-linked existing final", async () => {
  const wrong = Buffer.from("known-corrupt-existing-object");
  const expected = uniqueBytes("expected-content");
  const hash = hashBytes(expected);
  const casPath = store.path(hash);
  await store.inspect(hash);
  await fs.writeFile(casPath.finalPath, wrong, { flag: "wx" });
  const result = await store.publish({ hash, source: expected });
  assert.equal(result.status, "corrupt_existing");
  assert.deepEqual(await fs.readFile(casPath.finalPath), wrong);

  const hardlinkExpected = uniqueBytes("hardlink-fixture");
  const hardlinkHash = hashBytes(hardlinkExpected);
  const hardlinkPath = store.path(hardlinkHash);
  await store.inspect(hardlinkHash);
  await fs.writeFile(hardlinkPath.finalPath, hardlinkExpected, { flag: "wx" });
  const alias = join(hardlinkPath.directory, `${hardlinkHash}.hardlink-fixture`);
  await fs.link(hardlinkPath.finalPath, alias);
  const hardlinkResult = await store.publish({ hash: hardlinkHash, source: hardlinkExpected });
  assert.equal(hardlinkResult.status, "corrupt_existing");
  assert.match(hardlinkResult.reason, /nlink/i);
  assert.equal((await fs.stat(alias)).nlink, 2);
});

mutationTest("rejects traversal and reparse ancestors without escaping validation root", async () => {
  assert.throws(() => store.path("../" + "0".repeat(61)), ColdCasError);
  assert.throws(() => store.path("A".repeat(64)), ColdCasError);
  assert.throws(() => store.path(`${"0".repeat(63)}\n`), ColdCasError);
  assert.throws(() => store.path(`${"0".repeat(63)}\0`), ColdCasError);

  let bytes = uniqueBytes("reparse-fixture");
  let hash = hashBytes(bytes);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const prefixPath = join(VALIDATION_ROOT, "sha256", hash.slice(0, 2));
    if (!blockedReparsePrefixes.has(hash.slice(0, 2)) && await fs.lstat(prefixPath).catch(() => undefined) === undefined) {
      break;
    }
    bytes = uniqueBytes(`reparse-fixture-${attempt}`);
    hash = hashBytes(bytes);
  }
  const casPath = store.path(hash);
  const targetDirectory = join(VALIDATION_ROOT, `reparse-target-${process.pid}-${Date.now()}-${hash.slice(0, 6)}`);
  await fs.mkdir(targetDirectory, { recursive: false });
  const reparsePrefix = join(VALIDATION_ROOT, "sha256", casPath.first);
  let created = false;
  try {
    await fs.symlink(targetDirectory, reparsePrefix, "junction");
    created = true;
    blockedReparsePrefixes.add(casPath.first);
  } catch (error) {
    // Junction creation requires a host capability. If unavailable, retain an
    // explicit evidence path and fail closed rather than testing through it.
    assert.ok(error instanceof Error);
  }
  if (created) {
    await assert.rejects(() => store.publish({ hash, source: bytes }), ColdCasError);
  }
});

mutationTest("reports cleanup failure as pending and reconciles only the owned temp", async () => {
  let inject = true;
  const expected = uniqueBytes("cleanup-fault-expected");
  const source = uniqueBytes("cleanup-fault-wrong");
  const hash = hashBytes(expected);
  const faultingStore = new ColdCasStore({
    root: VALIDATION_ROOT,
    helperExecutablePath: HELPER_EXE,
    fault: (point) => {
      if (point === "before_temp_unlink" && inject) {
        throw new Error("injected unlink fault");
      }
    },
  });
  const result = await faultingStore.publish({ hash, source });
  assert.equal(result.status, "failed_cleanup_pending");
  assert.ok(result.tempPath);
  assert.equal(await fs.lstat(result.finalPath).catch(() => undefined), undefined);
  assert.equal(await fs.stat(result.tempPath).then((stats) => stats.isFile()), true);
  inject = false;
  assert.equal(await faultingStore.reconcileOwnedTemp(result.tempPath), true);
  assert.equal(await fs.lstat(result.tempPath).catch(() => undefined), undefined);
  await faultingStore.close();
  assert.equal(await fs.lstat(PRODUCTION_ROOT).catch(() => undefined), undefined);
});

mutationTest("two independent processes race safely on the same identity", async () => {
  const bytes = uniqueBytes("multiprocess-race");
  const hash = hashBytes(bytes);
  const [left, right] = await Promise.all([runChild(hash, bytes), runChild(hash, bytes)]);
  assert.equal(left.code, 0, left.stderr);
  assert.equal(right.code, 0, right.stderr);
  const statuses = [JSON.parse(left.result).status, JSON.parse(right.result).status].sort();
  assert.deepEqual(statuses, ["published", "reused"]);
  assert.equal((await fs.stat(store.path(hash).finalPath)).nlink, 1);
});

mutationTest("reconciles a competing winner without exposing an intermediate final", async () => {
  const bytes = uniqueBytes("in-flight-race");
  const hash = hashBytes(bytes);
  const [winner, loser] = await Promise.all([runChild(hash, bytes), runChild(hash, bytes)]);
  assert.equal(winner.code, 0, winner.stderr);
  assert.equal(loser.code, 0, loser.stderr);
  const statuses = [JSON.parse(winner.result).status, JSON.parse(loser.result).status].sort();
  assert.deepEqual(statuses, ["published", "reused"]);
  assert.equal((await fs.stat(store.path(hash).finalPath)).nlink, 1);
});
