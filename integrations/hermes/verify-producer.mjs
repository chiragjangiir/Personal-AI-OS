#!/usr/bin/env node
// Hermes producer closure: personal_aios/producer.lock.json is the only record of what the running
// Hermes must be (upstream pin + native-context.patch -> one git tree). This script proves it; it never
// relaxes the consumer pin in hermes-client.ts.
//   verify-producer.mjs [--source <git url|dir>] [--keep <new dir>] [--lock <file>]  clean pin+patch rebuild
//   verify-producer.mjs --check-running <hermes dir> [--lock <file>]             deployed tree == lock (offline)
//   verify-producer.mjs --export <fork dir>                                       re-export patch+lock, then rebuild
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = fileURLToPath(import.meta.url);
const HEX40 = /^[0-9a-f]{40}$/u, HEX64 = /^[0-9a-f]{64}$/u;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failures = [];
const fail = (code, detail, fix) => failures.push({code, detail, fix});
// Hermetic git: user/global settings (autocrlf, apply.whitespace=fix, optional index refresh) cannot change results.
const gitRaw = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'apply.whitespace=nowarn', ...args],
  {cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'}});
const git = (cwd, args) => gitRaw(cwd, args).trim();
const reason = error => String(error?.stderr || error?.message || error).trim().split('\n').slice(-3).join(' | ');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--source', '--keep', '--lock', '--check-running', '--export'].includes(flag) || value === undefined) {
      console.error(`usage: node ${SELF} [--source <git url|dir>] [--keep <dir>] | --check-running <dir> | --export <fork dir> [--lock <file>]`);
      process.exit(2);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function loadLock(path) {
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  const ok = lock.schema === 'paios.hermes-producer-lock.v1' && typeof lock.contract === 'string' &&
    HEX40.test(lock.upstream?.commit ?? '') && typeof lock.upstream?.repository === 'string' &&
    HEX64.test(lock.patch?.sha256 ?? '') && typeof lock.patch?.path === 'string' && HEX40.test(lock.result_tree ?? '') &&
    HEX64.test(lock.shape_sha256 ?? '') && typeof lock.producer?.publisher === 'string' &&
    typeof lock.producer?.shape_schema === 'string' && typeof lock.consumer?.shape_schema === 'string' &&
    typeof lock.consumer?.pin === 'string';
  if (!ok) throw new Error(`${path}: not a valid paios.hermes-producer-lock.v1`);
  return lock;
}

// Repo-side consistency: the lock, the archived patch and the consumer's own pin must agree before any H is judged.
function checkRepo(lock, lockPath) {
  const patchPath = resolve(dirname(lockPath), lock.patch.path);
  const patchSha = existsSync(patchPath) ? sha256(readFileSync(patchPath)) : 'missing';
  if (patchSha !== lock.patch.sha256)
    fail('PATCH_SHA_MISMATCH', `${patchPath} sha256 ${patchSha} != lock ${lock.patch.sha256}`,
      `Re-export from the fork: node ${SELF} --export <hermes fork dir>`);
  const consumerBytes = readFileSync(join(REPO, lock.consumer.shape_schema));
  if (sha256(consumerBytes) !== lock.shape_sha256)
    fail('CONSUMER_SHAPE_MISMATCH', `${lock.consumer.shape_schema} sha256 ${sha256(consumerBytes)} != lock ${lock.shape_sha256}`,
      'The consumer schema and the producer schema must change together in the fork, then --export.');
  const client = readFileSync(join(REPO, lock.consumer.pin), 'utf8');
  const pin = /NATIVE_RUN_SHAPE_SHA256\s*=\s*'([0-9a-f]{64})'/u.exec(client)?.[1];
  const contract = /'X-Hermes-Run-Contract'\s*:\s*'([^']+)'/u.exec(client)?.[1];
  if (pin !== lock.shape_sha256 || contract !== lock.contract)
    fail('CONSUMER_PIN_MISMATCH', `${lock.consumer.pin} pins ${pin}/${contract}, lock has ${lock.shape_sha256}/${lock.contract}`,
      'Do not relax the client; align the producer fork and re-export the lock.');
  return {patchPath, consumerBytes};
}

// The tree that actually runs must publish the consumer's exact shape bytes and contract literals.
function checkProducerFiles(root, lock, consumerBytes) {
  const schemaPath = join(root, lock.producer.shape_schema), publisherPath = join(root, lock.producer.publisher);
  const schema = existsSync(schemaPath) ? readFileSync(schemaPath) : Buffer.alloc(0);
  if (!schema.equals(consumerBytes))
    fail('PRODUCER_SHAPE_MISMATCH', `${schemaPath} (sha256 ${sha256(schema)}) is not byte-identical to ${lock.consumer.shape_schema}`,
      'The producer does not publish the consumer shape; rebuild from the lock or fix the fork.');
  const publisher = existsSync(publisherPath) ? readFileSync(publisherPath, 'utf8') : '';
  for (const literal of [`schema="${lock.contract}"`, `shape_sha256="${lock.shape_sha256}"`, 'X-Hermes-Run-Contract'])
    if (!publisher.includes(literal))
      fail('PRODUCER_CONTRACT_MISSING', `${publisherPath} does not contain ${literal}`, 'The producer publisher lost the native run contract.');
}

function rebuild(lock, lockPath, options) {
  const {patchPath, consumerBytes} = checkRepo(lock, lockPath);
  const work = options.keep ? resolve(options.keep) : mkdtempSync(join(tmpdir(), 'paios-hermes-rebuild-'));
  let tree = null, owned = !options.keep;
  try {
    if (options.keep) { mkdirSync(work); owned = true; }  // never reuse, overwrite or delete an existing directory
    git(work, ['init', '-q']);
    const source = options.source ?? lock.upstream.repository;  // a local clone path is resolved from the caller's cwd
    git(work, ['fetch', '-q', '--no-tags', '--depth', '1', /^[\w+.-]+:\/\/|^[^/]+@[^:]+:/u.test(source) ? source : resolve(source),
      lock.upstream.commit]);
    git(work, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
    if (git(work, ['rev-parse', 'HEAD']) !== lock.upstream.commit) throw new Error('fetched commit differs from the upstream pin');
    try { git(work, ['apply', '--index', '--whitespace=nowarn', patchPath]); }
    catch (error) {
      fail('PATCH_APPLY_FAILED', reason(error), `The patch does not apply to upstream ${lock.upstream.commit}; re-export it.`);
      return {mode: 'rebuild', upstream: lock.upstream.commit, tree};
    }
    tree = git(work, ['write-tree']);
    if (tree !== lock.result_tree)
      fail('REBUILT_TREE_MISMATCH', `pin+patch tree ${tree} != lock result_tree ${lock.result_tree}`,
        `The archived patch does not reproduce the locked producer; re-export with --export <fork dir>.`);
    checkProducerFiles(work, lock, consumerBytes);
    // A kept rebuild is a deployable checkout: committed, clean, and accepted by --check-running.
    if (options.keep && !failures.length)
      git(work, ['-c', 'user.name=Personal-AIOS producer lock', '-c', 'user.email=producer-lock@paios.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', `Personal-AIOS Hermes producer ${tree}`]);
  } catch (error) {
    fail('REBUILD_FAILED', reason(error), 'Offline? pass --source <local hermes-agent clone>. --keep must name a new directory.');
  } finally {
    if (owned && (!options.keep || failures.length)) rmSync(work, {recursive: true, force: true});
  }
  return {mode: 'rebuild', upstream: lock.upstream.commit, tree, kept: options.keep && !failures.length ? work : null};
}

function checkRunning(lock, lockPath, dir) {
  const {consumerBytes} = checkRepo(lock, lockPath);
  const root = resolve(dir);
  let tree = null, dirty = null;
  try {
    tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    dirty = git(root, ['status', '--porcelain', '--untracked-files=normal']);
  } catch (error) { fail('RUNNING_NOT_A_GIT_TREE', `${root}: ${reason(error)}`, 'Deploy Hermes as a git checkout built from the lock.'); }
  if (tree !== null && tree !== lock.result_tree)
    fail('RUNNING_TREE_MISMATCH', `${root} HEAD tree ${tree} != lock result_tree ${lock.result_tree}`,
      `Either rebuild H from the lock (node ${SELF} --keep <dir>), or, if the fork change is intended, commit it in H and ` +
      `run: node ${SELF} --export ${root}  (then commit the patch+lock in Personal-AIOS).`);
  if (dirty)
    fail('RUNNING_TREE_DIRTY', `${root} has uncommitted changes:\n${dirty.split('\n').slice(0, 10).join('\n')}`,
      `Commit the change in H and run: node ${SELF} --export ${root}; or discard it.`);
  checkProducerFiles(root, lock, consumerBytes);
  return {mode: 'check-running', dir: root, tree};
}

function exportFork(lock, lockPath, dir) {
  const root = resolve(dir);
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']))
    throw new Error(`${root} has uncommitted changes; commit them in the fork before exporting`);
  const head = git(root, ['rev-parse', 'HEAD']);
  const patch = gitRaw(root, ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', lock.upstream.commit, head]);
  const patchPath = resolve(dirname(lockPath), lock.patch.path);
  writeFileSync(patchPath, patch);
  const next = {...lock, patch: {...lock.patch, sha256: sha256(Buffer.from(patch))},
    shape_sha256: sha256(readFileSync(join(root, lock.producer.shape_schema))),
    result_tree: git(root, ['rev-parse', 'HEAD^{tree}']), exported_from_commit: head};
  writeFileSync(lockPath, JSON.stringify(next, null, 2) + '\n');
  console.error(`exported ${patchPath} and ${lockPath} from ${root}@${head}; verifying a clean rebuild`);
  return {...rebuild(next, lockPath, {source: root}), exported_from_commit: head};
}

const options = parseArgs(process.argv.slice(2));
const lockPath = resolve(options.lock ?? join(REPO, 'integrations/hermes/personal_aios/producer.lock.json'));
let result;
try {
  const lock = loadLock(lockPath);
  result = options['check-running'] ? checkRunning(lock, lockPath, options['check-running']) :
    options.export ? exportFork(lock, lockPath, options.export) : rebuild(lock, lockPath, options);
} catch (error) { fail('VERIFIER_ERROR', reason(error), `The lock (${lockPath}), its patch and the consumer files must exist and parse.`); }
if (failures.length) {
  console.error(`Hermes producer is NOT the locked composition (${lockPath}):`);
  for (const {code, detail, fix} of failures) console.error(`  ${code}: ${detail}\n    fix: ${fix}`);
  process.exit(1);
}
console.log(JSON.stringify({ok: true, contract: 'producer matches lock', ...result}));
