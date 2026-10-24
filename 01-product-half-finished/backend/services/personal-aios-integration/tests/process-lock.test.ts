import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireProcessLock} from '../src/process-lock.ts';

const lockModule = new URL('../src/process-lock.ts', import.meta.url).href;
// One independent OS process per contender: the race the audit describes is between processes, not promises.
const contender = `
const {acquireProcessLock} = await import(${JSON.stringify(lockModule)});
const {promises: fs} = await import('node:fs');
const [path, mode, holdMs, rounds, marker] = process.argv.slice(1);
const sleep = ms => new Promise(resolve => setTimeout(resolve, Number(ms)));
if (mode === 'once') {
  // Start barrier: every contender is loaded before any of them races.
  console.log('ready'); while (!(await fs.stat(marker).catch(() => undefined))) await sleep(2);
  try { const release = await acquireProcessLock(path); console.log('locked'); await sleep(holdMs); await release(); }
  catch (error) { console.log(error.message); }
} else if (mode === 'hold') {
  const release = await acquireProcessLock(path); console.log('locked'); await sleep(600000); await release();
} else {
  let owned = 0;
  for (let i = 0; i < Number(rounds); i++) {
    let release;
    while (!release) { try { release = await acquireProcessLock(path); } catch (error) {
      if (error.message !== 'PERSONAL_AIOS_ALREADY_RUNNING' && error.message !== 'RUNTIME_LOCK_CONTENTION') throw error; await sleep(1); } }
    // A second simultaneous owner would find the marker already present.
    await fs.writeFile(marker, String(process.pid), {flag: 'wx'});
    await sleep(holdMs); await fs.unlink(marker); await release(); owned++;
  }
  console.log('owned ' + owned);
}`;
function run(args: string[]) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', contender, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = ''; const started = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  child.stdout.on('data', chunk => { out += chunk; if (out.includes('ready')) ready.resolve(); if (out.includes('locked')) started.resolve(); });
  child.stderr.on('data', chunk => { err += chunk; });
  const done = new Promise<{code: number | null; out: string}>(resolve => child.on('exit', code => {
    started.resolve(); ready.resolve(); resolve({code, out: out + err}); }));
  return {done, kill: () => child.kill('SIGKILL'), started: started.promise, ready: ready.promise};
}
async function root(t: test.TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'paios-lock-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('a lock file left by a dead owner is not an owner; acquire, diagnose and release', async t => {
  const path = join(await root(t), 'owner.lock');
  await fs.writeFile(path, JSON.stringify({pid: 2147483646, instance_id: 'dead'}), {mode: 0o600});
  const release = await acquireProcessLock(path);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).pid, process.pid);
  await assert.rejects(acquireProcessLock(path), /PERSONAL_AIOS_ALREADY_RUNNING/);
  await Promise.all([release(), release()]);
  await assert.rejects(fs.stat(path), {code: 'ENOENT'});
  await (await acquireProcessLock(path))();
});

test('independent processes racing over one stale lock: exactly one owner', async t => {
  const dir = await root(t), path = join(dir, 'owner.lock');
  for (let round = 0; round < 3; round++) {
    const go = join(dir, `go-${round}`);
    await fs.writeFile(path, JSON.stringify({pid: 2147483646, instance_id: `stale-${round}`}), {mode: 0o600});
    const contenders = Array.from({length: 6}, () => run([path, 'once', '2000', '0', go]));
    await Promise.all(contenders.map(c => c.ready)); await fs.writeFile(go, '');
    const results = await Promise.all(contenders.map(c => c.done));
    const outcomes = results.map(result => result.out.replace('ready', '').trim()).sort();
    assert.equal(outcomes.filter(line => line === 'locked').length, 1, outcomes.join('|'));
    assert.ok(outcomes.every(line => ['locked', 'PERSONAL_AIOS_ALREADY_RUNNING'].includes(line)), outcomes.join('|'));
    await assert.rejects(fs.stat(path), {code: 'ENOENT'});
  }
});

test('a killed owner is released by the kernel even though its lock file remains', async t => {
  const path = join(await root(t), 'owner.lock');
  const owner = run([path, 'hold', '0']);
  await owner.started;
  await assert.rejects(acquireProcessLock(path), /PERSONAL_AIOS_ALREADY_RUNNING/);
  owner.kill(); await owner.done;
  assert.ok(await fs.stat(path));
  const release = await acquireProcessLock(path);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).pid, process.pid);
  await release();
});

test('acquire/release churn across processes never yields two simultaneous owners', async t => {
  const dir = await root(t), path = join(dir, 'owner.lock'), marker = join(dir, 'active');
  const results = await Promise.all(Array.from({length: 4}, () => run([path, 'churn', '2', '15', marker]).done));
  for (const result of results) assert.match(result.out, /owned 15/, result.out);
  await assert.rejects(fs.stat(path), {code: 'ENOENT'});
});
