import { promises as fs, constants } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Exactly one local product admission owner per lock path. The kernel arbitrates ownership and drops it when the
 *  owning process exits, so recovery never judges a recorded PID and never unlinks a lock another process now holds.
 *  The file body ({pid, instance_id}) is diagnostic only; it is never used to decide who owns the lock. */
export type ProcessLockRelease = () => Promise<void>;
export interface ProcessLockClaim {pid: number; instance_id: string}

// BSD/darwin open(2) takes flock(LOCK_EX) atomically with the open; with O_NONBLOCK a held lock fails EAGAIN.
const O_EXLOCK = 0x20;

export async function acquireProcessLock(path: string): Promise<ProcessLockRelease> {
  await fs.mkdir(dirname(path), {recursive: true, mode: 0o700});
  const claim: ProcessLockClaim = {pid: process.pid, instance_id: randomUUID()};
  return process.platform === 'darwin' || process.platform === 'freebsd' ? flockFile(path, claim) : kernelName(path, claim);
}

const once = (release: () => Promise<void>): ProcessLockRelease => {
  let released: Promise<void> | undefined;
  return () => released ??= release();
};
const held = () => new Error('PERSONAL_AIOS_ALREADY_RUNNING');

async function flockFile(path: string, claim: ProcessLockClaim): Promise<ProcessLockRelease> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK, 0o600);
    } catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw held();
      throw error;
    }
    try {
      // A releasing owner unlinks before closing; a lock taken on that unlinked inode guards nothing. Only the
      // inode still reachable at the path is the lock.
      const [mine, current] = await Promise.all([handle.stat(), fs.lstat(path).catch(() => undefined)]);
      if (!current || current.ino !== mine.ino || current.dev !== mine.dev) { await handle.close(); continue; }
      await handle.truncate(0); await handle.write(JSON.stringify(claim), 0); await handle.sync();
    } catch (error) { await handle.close().catch(() => undefined); throw error; }
    const lockHandle = handle;
    return once(async () => {
      try {
        const [mine, current] = await Promise.all([lockHandle.stat(), fs.lstat(path).catch(() => undefined)]);
        if (current && current.ino === mine.ino && current.dev === mine.dev) await fs.unlink(path);
      } finally { await lockHandle.close(); }
    });
  }
  throw new Error('RUNTIME_LOCK_CONTENTION');
}

// Linux abstract sockets and Windows named pipes are kernel names released with the process; the name is bound to
// the canonical lock path so two spellings of one path share one owner.
async function kernelName(path: string, claim: ProcessLockClaim): Promise<ProcessLockRelease> {
  const canonical = join(await fs.realpath(dirname(path)), basename(path));
  const name = `paios-owner-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
  const server: Server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => reject((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? held() : error));
    server.listen({path: address, exclusive: true}, () => resolve());
  });
  server.unref();
  try {
    const next = `${path}.${claim.instance_id}`;
    await fs.writeFile(next, JSON.stringify(claim), {mode: 0o600, flag: 'wx'});
    await fs.rename(next, path);
  } catch (error) { server.close(); throw error; }
  return once(async () => {
    try {
      const owner = JSON.parse(await fs.readFile(path, 'utf-8').catch(() => '{}')) as Partial<ProcessLockClaim>;
      if (owner.instance_id === claim.instance_id) await fs.unlink(path);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
