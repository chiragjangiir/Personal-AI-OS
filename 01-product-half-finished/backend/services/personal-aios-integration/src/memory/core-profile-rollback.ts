import {promises as fs} from 'node:fs';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {check, sha256} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import {coreProfileMigration, projectCoreProfile, type CoreProfileMemory, type CoreProfileMigration} from './core-profile.ts';
import {CORE_PROFILE_FILES as FILES, baselinePath, entryDigests, readCoreProfileBaseline,
  type CoreProfileBaseline, type EntryDigests} from './core-profile-state.ts';

async function syncDirectory(path: string) {
  const handle = await fs.open(path, 'r');
  try {await handle.sync();} finally {await handle.close();}
}

async function writeOwned(path: string, bytes: Uint8Array, owner: {uid: number; gid: number; mode: number}) {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.chown(owner.uid, owner.gid);
      await handle.chmod(owner.mode & 0o7777);
      await handle.sync();
    } finally {await handle.close();}
    await fs.rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {await fs.rm(temporary, {force: true});}
}

/** Offline, after writers stop. Both preimages are durable before either legacy file is replaced. */
export async function projectNativeMemoryForRollback(options: {
  state_owner: {uid: number; gid: number};
  principal_id: string; profile_home: string; source_profile_home: string; storage: StoragePort; l3: CoreProfileMemory;
}) {
  const {principal_id: principal, profile_home: home, source_profile_home: sourceHome, storage, l3} = options;
  let initial: CoreProfileMigration;
  try {initial = await coreProfileMigration(storage, home);}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {status: 'skipped', reason: 'no_checkpoint'};}
  check(initial.principal_id === principal, 'CORE_PROFILE_PRINCIPAL_MISMATCH', 403);
  const previous = await readCoreProfileBaseline(home);
  if (previous) check(previous.principal_id === principal, 'CORE_PROFILE_PRINCIPAL_MISMATCH', 403);
  let latest = initial;
  let completedUpgrade = true;
  if (previous) {
    try {latest = await coreProfileMigration(storage, home, previous.id);}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; completedUpgrade = false;}
  }
  const memories = join(sourceHome, 'memories');
  try {await fs.stat(memories);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await fs.stat(sourceHome);
    await fs.mkdir(memories, {mode: 0o700});
    await fs.chown(memories, parent.uid, parent.gid);
    await syncDirectory(sourceHome);
  }
  const sourceDirectory = await fs.stat(memories);
  const before = await Promise.all(FILES.map(async file => {
    try {return {file, bytes: await fs.readFile(join(memories, file)), metadata: await fs.stat(join(memories, file)), existed: true};}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {file, bytes: Buffer.alloc(0), metadata: {...sourceDirectory, mode: 0o600}, existed: false};}
  }));
  // Forward import never writes the legacy home. An incomplete re-upgrade can restart the old release
  // with those exact bytes; projecting its partial L3 set would discard native facts not yet imported.
  if (previous && !completedUpgrade) return {status: 'preserved', reason: 'upgrade_not_checkpointed',
    baseline_id: previous.id, checkpoint_written: false,
    files: before.map(({file, bytes}) => ({file, sha256: sha256(bytes), source_bytes: bytes.length}))};
  const projected = await projectCoreProfile(l3, principal, home, options.state_owner);
  const known = Object.fromEntries(FILES.map(file => {
    const hashes = [...(previous?.known_entry_sha256[file] ?? []), ...entryDigests(projected.views[file])];
    for (const checkpoint of [initial, latest]) {
      const record = checkpoint.files.find(row => row.file === file)!;
      if (record.entry_sha256) hashes.push(...record.entry_sha256);
      else {
        const original = before.find(row => row.file === file)!;
        check(sha256(original.bytes) === record.source_sha256, 'CORE_PROFILE_BASELINE_SOURCE_CHANGED');
        hashes.push(...entryDigests(original.bytes));
      }
    }
    return [file, [...new Set(hashes)].sort()];
  })) as EntryDigests;
  const baseline: CoreProfileBaseline = {id: randomUUID(), principal_id: principal, known_entry_sha256: known,
    files: FILES.map(file => ({file, sha256: sha256(projected.views[file]), entries: entryDigests(projected.views[file]).length}))};
  const owner = {...options.state_owner, mode: 0o600};
  const backups = join(home, 'rollback-backups'), directory = join(backups, baseline.id);
  for (const path of [backups, directory]) {
    await fs.mkdir(path, {recursive: true, mode: 0o700});
    await fs.chown(path, owner.uid, owner.gid);
    await fs.chmod(path, 0o700);
  }
  const filesBefore = before.map(({file, bytes, metadata, existed}) => ({file, existed, bytes: bytes.length,
    sha256: sha256(bytes), uid: metadata.uid, gid: metadata.gid, mode: metadata.mode & 0o7777}));
  for (const row of before) if (row.existed) await writeOwned(join(directory, row.file), row.bytes, owner);
  const manifest = Buffer.from(JSON.stringify({baseline, files_before: filesBefore}));
  await writeOwned(join(directory, 'manifest.json'), manifest, owner);
  await syncDirectory(backups);
  await syncDirectory(home);
  for (const row of before) {
    const bytes = Buffer.from(projected.views[row.file]);
    await writeOwned(join(memories, row.file), bytes, row.metadata);
    check(sha256(await fs.readFile(join(memories, row.file))) === sha256(bytes), 'CORE_PROFILE_ROLLBACK_READBACK_FAILED');
  }
  const baselineBytes = Buffer.from(JSON.stringify(baseline));
  await writeOwned(baselinePath(home), baselineBytes, owner);
  return {status: 'projected', backup_id: baseline.id, backup_bytes: before.reduce((sum, row) => sum + row.bytes.length, 0) + manifest.length,
    baseline_bytes: baselineBytes.length, files: baseline.files, assertions: projected.assertion_ids, entries: projected.entries};
}
