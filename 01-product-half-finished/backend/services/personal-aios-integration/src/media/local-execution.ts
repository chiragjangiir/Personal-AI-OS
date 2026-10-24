import { spawn } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from '../contracts.ts';

export type LocalMediaResource = 'decode' | 'audio' | 'vad';
export interface LocalMediaExecutionConfig {
    runtime: string;
    slots: number;
    vad_slots?: number;
}
export interface LocalMediaCommand {
    executable: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdin?: Uint8Array;
    stdin_limit_bytes: number;
    stdout_limit_bytes: number;
    stderr_limit_bytes: number;
    stderr_mode: 'lossless' | 'tail';
}
export interface LocalMediaOutput {
    stdout: Buffer;
    stderr: Buffer;
}
export interface LocalMediaDuplex {
    write(bytes: Uint8Array): Promise<void>;
    end(): Promise<LocalMediaOutput>;
    readonly done: Promise<LocalMediaOutput>;
}
export interface LocalMediaReservation {
    assertReady(): void;
    run(command: LocalMediaCommand): Promise<LocalMediaOutput>;
    open(command: LocalMediaCommand, onStdout: (bytes: Buffer) => void): LocalMediaDuplex;
    release(): Promise<void>;
}

// MEDIA owns operation capacity and immediate-child lifetime, independent of codec/model conversion.
// Crash leftovers remain busy: recovery requires explicit proof of child absence.
export class LocalMediaExecution {
    private readonly reservations = new Set<Reservation>();
    private readonly acquiring = new Set<Promise<LocalMediaReservation>>();
    private closed = false;
    private closing?: Promise<void>;
    private cleanupFailure?: unknown;
    readonly runtime: string;
    readonly slots: number;
    readonly vad_slots: number;
    private readonly root: string;
    private constructor(runtime: string, root: string, slots: number, vadSlots: number) {
        this.runtime = runtime;
        this.root = root;
        this.slots = slots;
        this.vad_slots = vadSlots;
    }

    static async create(config: LocalMediaExecutionConfig): Promise<LocalMediaExecution> {
        check(Number.isSafeInteger(config.slots) && config.slots > 0 && config.slots <= 16, 'LOCAL_MEDIA_CONFIG');
        const vadSlots = config.vad_slots ?? 0;
        check(Number.isSafeInteger(vadSlots) && vadSlots >= 0 && config.slots + vadSlots <= 16, 'LOCAL_MEDIA_CONFIG');
        const runtime = await fs.realpath(resolve(config.runtime));
        const root = join(runtime, 'media');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = join(root, `.execution-config-${randomUUID()}`);
        const identity = JSON.stringify({ schema: 'paios.local-media-execution.v1', slots: config.slots,
            ...(vadSlots ? {vad_slots: vadSlots} : {}) });
        await fs.writeFile(temporary, identity, { mode: 0o600, flag: 'wx' });
        try {
            try { await fs.link(temporary, join(root, '.local-execution-config')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            check(await fs.readFile(join(root, '.local-execution-config'), 'utf8') === identity, 'LOCAL_MEDIA_CONFIG_CONFLICT');
        } finally { await fs.unlink(temporary); }
        return new LocalMediaExecution(runtime, root, config.slots, vadSlots);
    }

    assertRuntime(runtime: string): void {
        check(realpathSync(resolve(runtime)) === this.runtime, 'LOCAL_MEDIA_RUNTIME_MISMATCH');
    }

    /** Current capacity observation only; reserve remains the race-safe admission owner. */
    async available(resource: LocalMediaResource): Promise<boolean> {
        if (this.closed || this.cleanupFailure !== undefined) return false;
        const absent = async (path: string) => {
            try { await fs.lstat(path); return false; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
        };
        if (resource === 'audio' && !await absent(join(this.root, '.local-audio-lease'))) return false;
        for (let n = 0; n < (resource === 'vad' ? this.vad_slots : this.slots); n++)
            if (await absent(this.slotPath(resource, n))) return !this.closed;
        return false;
    }

    private slotPath(resource: LocalMediaResource, index: number): string {
        return join(this.root, resource === 'vad' ? `.local-vad-slot-${index}` : `.local-media-slot-${index}`);
    }

    reserve(resource: LocalMediaResource, signal: AbortSignal, timeoutMs: number): Promise<LocalMediaReservation> {
        const work = this.acquire(resource, signal, timeoutMs);
        this.acquiring.add(work);
        void work.then(() => this.acquiring.delete(work), () => this.acquiring.delete(work));
        return work;
    }

    private async acquire(resource: LocalMediaResource, signal: AbortSignal, timeoutMs: number): Promise<LocalMediaReservation> {
        const prefix = resource === 'decode' ? 'DEMUX' : resource === 'vad' ? 'LOCAL_VAD' : 'LOCAL_AUDIO';
        const cancelled = resource === 'decode' ? 'DEMUX_CANCELLED' : 'MEDIA_CANCELLED';
        const deadline = performance.now() + timeoutMs;
        check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'LOCAL_MEDIA_TIMEOUT_CONFIG');
        check(!this.closed, `${prefix}_CLOSED`, 503);
        check(!signal.aborted, cancelled, 409);
        check(resource !== 'vad' || this.vad_slots > 0, 'LOCAL_VAD_UNAVAILABLE', 503);
        let slot: string | undefined;
        let audio = false;
        try {
            for (let n = 0; n < (resource === 'vad' ? this.vad_slots : this.slots); n++) {
                const path = this.slotPath(resource, n);
                try {
                    await fs.mkdir(path, { mode: 0o700 });
                    slot = path;
                    break;
                }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            }
            check(slot, `${prefix}_BUSY`, 503);
            if (resource === 'audio') {
                try {
                    await fs.mkdir(join(this.root, '.local-audio-lease'), { mode: 0o700 });
                    audio = true;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('LOCAL_AUDIO_BUSY');
                    throw error;
                }
            }
            check(!this.closed, `${prefix}_CLOSED`, 503);
            check(!signal.aborted, cancelled, 409);
            check(performance.now() < deadline, `${prefix}_TIMEOUT`, 503);
            const reservation = new Reservation(prefix, cancelled, signal, deadline - performance.now(), async () => {
                await this.removeOwned([...(audio ? [join(this.root, '.local-audio-lease')] : []), slot!]);
                this.reservations.delete(reservation);
            });
            this.reservations.add(reservation);
            return reservation;
        } catch (error) {
            await this.removeOwned([...(audio ? [join(this.root, '.local-audio-lease')] : []), ...(slot ? [slot] : [])]);
            throw error;
        }
    }

    private async removeOwned(paths: string[]): Promise<void> {
        const results = await Promise.allSettled(paths.map(path => fs.rmdir(path)));
        const failures = results.filter(result => result.status === 'rejected');
        for (const failure of failures) this.cleanupFailure ??= failure.reason;
        if (failures.length) throw failures[0]!.reason;
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        for (const reservation of this.reservations) reservation.stop();
        this.closing = (async () => {
            await Promise.allSettled([...this.acquiring]);
            const released = await Promise.allSettled([...this.reservations].map(reservation => reservation.release()));
            const failure = released.find(result => result.status === 'rejected');
            if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
            if (failure?.status === 'rejected') throw failure.reason;
        })();
        return this.closing;
    }
}

class Reservation implements LocalMediaReservation {
    private failure?: Error;
    private opened = false;
    private released = false;
    private releasing?: Promise<void>;
    private readonly children = new Set<Promise<LocalMediaOutput>>();
    private readonly controller = new AbortController();
    private readonly timer: ReturnType<typeof setTimeout>;
    private readonly abort: () => void;
    private readonly prefix: string;
    private readonly signal: AbortSignal;
    private readonly cleanup: () => Promise<void>;
    constructor(prefix: string, cancelled: string,
        signal: AbortSignal, timeoutMs: number, cleanup: () => Promise<void>) {
        this.prefix = prefix;
        this.signal = signal;
        this.cleanup = cleanup;
        this.abort = () => this.fail(new Error(cancelled));
        signal.addEventListener('abort', this.abort, { once: true });
        this.timer = setTimeout(() => this.fail(new Error(`${prefix}_TIMEOUT`)), timeoutMs);
        if (signal.aborted) this.abort();
    }
    private fail(error: Error): void {
        this.failure ??= error;
        this.controller.abort();
    }
    stop(): void {
        this.fail(new Error(`${this.prefix}_CLOSED`));
    }
    assertReady(): void {
        if (this.failure) throw this.failure;
        check(!this.released, `${this.prefix}_CLOSED`, 503);
    }
    run(command: LocalMediaCommand): Promise<LocalMediaOutput> {
        try {
            this.assertReady();
            check(this.children.size === 0 && !this.opened, 'LOCAL_MEDIA_RESERVATION_ACTIVE', 409);
        } catch (error) { return Promise.reject(error); }
        const exchange = this.execute(command);
        const work = exchange.done;
        void exchange.end().catch(() => {});
        this.children.add(work);
        void work.then(() => this.children.delete(work), () => this.children.delete(work));
        return work;
    }
    open(command: LocalMediaCommand, onStdout: (bytes: Buffer) => void): LocalMediaDuplex {
        this.assertReady();
        check(this.children.size === 0 && !this.opened, 'LOCAL_MEDIA_RESERVATION_ACTIVE', 409);
        check(command.stdin === undefined, 'LOCAL_MEDIA_DUPLEX_INITIAL_INPUT');
        check(command.stderr_mode === 'lossless', 'LOCAL_MEDIA_DUPLEX_LOSSLESS_STDERR');
        this.opened = true;
        const exchange = this.execute(command, onStdout);
        this.children.add(exchange.done);
        void exchange.done.then(() => this.children.delete(exchange.done), () => this.children.delete(exchange.done));
        return exchange;
    }
    private execute(command: LocalMediaCommand, onStdout?: (bytes: Buffer) => void): LocalMediaDuplex {
        let child: ReturnType<typeof spawn> | undefined;
        let ended = false;
        let closed = false;
        let written = command.stdin?.byteLength ?? 0;
        let pending: Promise<void> | undefined;
        let rejectWrite: ((error: Error) => void) | undefined;
        const done = new Promise<LocalMediaOutput>((resolveOutput, reject) => {
            try {
                check([command.stdin_limit_bytes, command.stdout_limit_bytes, command.stderr_limit_bytes]
                    .every(n => Number.isSafeInteger(n) && n >= 0), 'LOCAL_MEDIA_BYTE_CONFIG');
                check((command.stdin?.byteLength ?? 0) <= command.stdin_limit_bytes, `${this.prefix}_INPUT_BUDGET`, 413);
            } catch (error) {
                this.fail(error as Error);
                reject(error);
                return;
            }
            try {
                child = spawn(command.executable, command.args, {
                    cwd: command.cwd, env: command.env, stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (error) {
                this.fail(error as Error);
                reject(this.failure);
                return;
            }
            const output: Buffer[] = [];
            let received = 0;
            let stderr = Buffer.alloc(0);
            const active = child;
            const kill = () => {
                rejectWrite?.(this.failure ?? new Error(`${this.prefix}_CLOSED`));
                active.kill('SIGKILL');
            };
            this.controller.signal.addEventListener('abort', kill, { once: true });
            active.stdout!.on('data', (data: Buffer) => {
                if (this.failure) return;
                if (received + data.length > command.stdout_limit_bytes) {
                    this.fail(new Error(`${this.prefix}_OUTPUT_BUDGET`));
                    return;
                }
                received += data.length;
                if (onStdout) {
                    try {
                        const result = onStdout(data) as unknown;
                        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                            void Promise.resolve(result).catch(() => {});
                            throw new Error('LOCAL_MEDIA_ASYNC_CALLBACK');
                        }
                    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
                } else output.push(data);
            });
            active.stderr!.on('data', (data: Buffer) => {
                if (this.failure) return;
                if (command.stderr_mode === 'lossless' && stderr.length + data.length > command.stderr_limit_bytes) {
                    this.fail(new Error(`${this.prefix}_METADATA_BUDGET`));
                    return;
                }
                stderr = Buffer.concat([stderr, data]);
                if (command.stderr_mode === 'tail' && stderr.length > command.stderr_limit_bytes)
                    stderr = stderr.subarray(stderr.length - command.stderr_limit_bytes);
            });
            active.on('error', error => this.fail(error));
            active.stdin!.on('error', error => this.fail(error));
            active.on('close', code => {
                closed = true;
                if (pending) this.fail(new Error(`${this.prefix}_INPUT_CLOSED`));
                rejectWrite?.(this.failure ?? new Error(`${this.prefix}_INPUT_CLOSED`));
                this.controller.signal.removeEventListener('abort', kill);
                if (code !== 0) this.fail(new Error(this.prefix === 'DEMUX' ? `DEMUX_DECODER_FAILED:${code}` :
                    `${this.prefix}_FAILED:${code}:${stderr.toString()}`));
                if (this.failure) reject(this.failure);
                else resolveOutput({ stdout: Buffer.concat(output, onStdout ? 0 : received), stderr });
            });
            if (this.controller.signal.aborted) kill();
        });
        // Internal observation prevents an unhandled rejection before the consumer awaits done.
        void done.catch(() => {});
        return {
            done,
            write: (bytes: Uint8Array) => {
                try {
                    this.assertReady();
                    check(!ended && !closed && child, `${this.prefix}_INPUT_CLOSED`, 409);
                    check(!pending, 'LOCAL_MEDIA_INPUT_BUSY', 409);
                    check(bytes instanceof Uint8Array, 'LOCAL_MEDIA_INPUT_BYTES');
                    check(written + bytes.byteLength <= command.stdin_limit_bytes, `${this.prefix}_INPUT_BUDGET`, 413);
                } catch (error) {
                    if ((error as Error).message.endsWith('_INPUT_BUDGET')) this.fail(error as Error);
                    return Promise.reject(error);
                }
                written += bytes.byteLength;
                const work = new Promise<void>((resolveWrite, reject) => {
                    rejectWrite = reject;
                    try { child!.stdin!.write(bytes, error => error ? reject(error) : resolveWrite()); }
                    catch (error) { this.fail(error as Error); reject(error); }
                });
                pending = work;
                void work.then(() => { pending = undefined; rejectWrite = undefined; }, error => {
                    pending = undefined; rejectWrite = undefined; this.fail(error as Error);
                });
                return work;
            },
            end: () => {
                if (!ended) {
                    ended = true;
                    const finish = () => {
                        if (!closed && child && !this.failure) {
                            try { child.stdin!.end(command.stdin); } catch (error) { this.fail(error as Error); }
                        }
                    };
                    if (pending) void pending.then(finish, () => {}); else finish();
                }
                return done;
            }
        };
    }
    release(): Promise<void> {
        if (this.releasing) return this.releasing;
        this.released = true;
        // Releasing an operation fences its future runs and joins any actual children first.
        if (this.children.size) this.fail(new Error(`${this.prefix}_CLOSED`));
        this.releasing = (async () => {
            await Promise.allSettled([...this.children]);
            clearTimeout(this.timer);
            this.signal.removeEventListener('abort', this.abort);
            await this.cleanup();
        })();
        return this.releasing;
    }
}
