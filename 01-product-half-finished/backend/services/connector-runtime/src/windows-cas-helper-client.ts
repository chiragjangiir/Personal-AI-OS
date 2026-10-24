import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_FRAME_BYTES = 64 * 1024;

const OP_HELLO = 1;
const OP_ALLOCATE = 2;
const OP_PUBLISH = 3;
const OP_FINALIZE = 4;
const OP_CLEANUP = 5;
const OP_CANCEL = 6;
const OP_SHUTDOWN = 7;
const OP_WRITE = 8;
const OP_SYNC = 9;

const RESPONSE_ERROR = 0;
const RESPONSE_HELLO = 1;
const RESPONSE_ALLOCATED = 2;
const RESPONSE_PENDING = 3;
const RESPONSE_COMPLETE = 4;
const RESPONSE_BOOLEAN = 5;

export type HelperPublishStatus = "published" | "reused" | "corrupt_existing";

export interface HelperAllocation {
  readonly token: string;
  readonly tempPath: string;
}

export interface HelperPublishPending {
  readonly status: HelperPublishStatus;
  readonly bytes: number;
  readonly reason?: string;
}

export interface HelperPublishComplete {
  readonly status: HelperPublishStatus;
  readonly bytes: number;
  readonly reason?: string;
}

export class WindowsCasHelperError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "WindowsCasHelperError";
    this.code = code;
  }
}

function encodeString(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > 0xffff || /[\0\r\n]/u.test(value)) {
    throw new WindowsCasHelperError("INVALID_PROTOCOL_STRING", "helper protocol string is invalid");
  }
  const output = Buffer.allocUnsafe(2 + encoded.byteLength);
  output.writeUInt16LE(encoded.byteLength, 0);
  encoded.copy(output, 2);
  return output;
}

function decodeString(buffer: Buffer, offset: number): { readonly value: string; readonly next: number } {
  if (offset + 2 > buffer.byteLength) {
    throw new WindowsCasHelperError("TRUNCATED_RESPONSE", "helper response string length is truncated");
  }
  const length = buffer.readUInt16LE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > buffer.byteLength) {
    throw new WindowsCasHelperError("TRUNCATED_RESPONSE", "helper response string is truncated");
  }
  const value = buffer.subarray(start, end).toString("utf8");
  if (Buffer.byteLength(value, "utf8") !== length || /[\0\r\n]/u.test(value)) {
    throw new WindowsCasHelperError("INVALID_RESPONSE", "helper response string is invalid");
  }
  return { value, next: end };
}

function frame(payload: Buffer): Buffer {
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new WindowsCasHelperError("FRAME_TOO_LARGE", "helper request exceeds the 64 KiB bound");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

function requestPayload(operation: number, parts: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([operation]), ...parts]);
}

function ensureStatus(buffer: Buffer, expected: number): void {
  if (buffer.byteLength === 0) {
    throw new WindowsCasHelperError("INVALID_RESPONSE", "empty helper response");
  }
  if (buffer[0] === RESPONSE_ERROR) {
    const code = decodeString(buffer, 1);
    const message = decodeString(buffer, code.next);
    throw new WindowsCasHelperError(code.value, message.value);
  }
  if (buffer[0] !== expected) {
    throw new WindowsCasHelperError("INVALID_RESPONSE", "unexpected helper response status");
  }
}

export class WindowsCasHelperClient {
  private readonly executablePath: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private sessionToken: string | undefined;
  private inputBuffer = Buffer.alloc(0);
  private readonly frames: Buffer[] = [];
  private readonly readers: Array<{ resolve: (value: Buffer) => void; reject: (reason: unknown) => void }> = [];
  private childFailure: Error | undefined;
  private requestChain: Promise<void> = Promise.resolve();
  private closing = false;

  public constructor(executablePath: string) {
    this.executablePath = executablePath;
  }

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  public get path(): string {
    return this.executablePath;
  }

  public async start(): Promise<void> {
    if (this.child !== undefined) {
      return;
    }
    const child = spawn(this.executablePath, [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => {
      if (!this.closing && code !== 0) {
        this.fail(new Error(`cold CAS helper exited with code ${String(code)}${signal === null ? "" : `/${signal}`}`));
      } else if (!this.closing) {
        this.fail(new Error("cold CAS helper exited unexpectedly"));
      }
    });
    const hello = await this.send(requestPayload(OP_HELLO, []));
    ensureStatus(hello, RESPONSE_HELLO);
    const token = decodeString(hello, 1);
    if (token.next !== hello.byteLength || token.value.length < 32) {
      throw new WindowsCasHelperError("INVALID_HELLO", "helper did not return a session token");
    }
    this.sessionToken = token.value;
  }

  public async allocate(root: string, finalPath: string, hash: string): Promise<HelperAllocation> {
    await this.start();
    const response = await this.send(
      requestPayload(OP_ALLOCATE, [encodeString(this.session()), encodeString(root), encodeString(finalPath), encodeString(hash)]),
    );
    ensureStatus(response, RESPONSE_ALLOCATED);
    const token = decodeString(response, 1);
    const tempPath = decodeString(response, token.next);
    if (tempPath.next !== response.byteLength) {
      throw new WindowsCasHelperError("INVALID_RESPONSE", "helper allocation response has trailing data");
    }
    return { token: token.value, tempPath: tempPath.value };
  }

  public async publish(token: string, hash: string): Promise<HelperPublishPending> {
    const response = await this.send(
      requestPayload(OP_PUBLISH, [encodeString(this.session()), encodeString(token), encodeString(hash)]),
    );
    ensureStatus(response, RESPONSE_PENDING);
    if (response.byteLength < 10) {
      throw new WindowsCasHelperError("TRUNCATED_RESPONSE", "helper publish response is truncated");
    }
    const status = response[1];
    const bytesBig = response.readBigUInt64LE(2);
    const reason = decodeString(response, 10);
    if (status === undefined || reason.next !== response.byteLength || status < 1 || status > 3 || bytesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WindowsCasHelperError("INVALID_RESPONSE", "helper publish response is invalid");
    }
    return {
      status: status === 1 ? "published" : status === 2 ? "reused" : "corrupt_existing",
      bytes: Number(bytesBig),
      ...(reason.value.length === 0 ? {} : { reason: reason.value }),
    };
  }

  public async write(token: string, chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength > 60 * 1024) {
      throw new WindowsCasHelperError("FRAME_TOO_LARGE", "helper write chunk exceeds the 64 KiB bound");
    }
    const bytes = Buffer.from(chunk);
    const length = Buffer.allocUnsafe(2);
    length.writeUInt16LE(bytes.byteLength, 0);
    const response = await this.send(
      requestPayload(OP_WRITE, [encodeString(this.session()), encodeString(token), length, bytes]),
    );
    if (!this.readBoolean(response)) {
      throw new WindowsCasHelperError("WRITE_FAILED", "helper rejected a temporary write");
    }
  }

  public async sync(token: string): Promise<void> {
    const response = await this.send(requestPayload(OP_SYNC, [encodeString(this.session()), encodeString(token)]));
    if (!this.readBoolean(response)) {
      throw new WindowsCasHelperError("SYNC_FAILED", "helper rejected temporary flush/hash validation");
    }
  }

  public async finalize(token: string): Promise<HelperPublishComplete> {
    const response = await this.send(requestPayload(OP_FINALIZE, [encodeString(this.session()), encodeString(token)]));
    ensureStatus(response, RESPONSE_COMPLETE);
    if (response.byteLength < 10) {
      throw new WindowsCasHelperError("TRUNCATED_RESPONSE", "helper finalize response is truncated");
    }
    const status = response[1];
    const bytesBig = response.readBigUInt64LE(2);
    const reason = decodeString(response, 10);
    if (status === undefined || reason.next !== response.byteLength || status < 1 || status > 3 || bytesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WindowsCasHelperError("INVALID_RESPONSE", "helper finalize response is invalid");
    }
    return {
      status: status === 1 ? "published" : status === 2 ? "reused" : "corrupt_existing",
      bytes: Number(bytesBig),
      ...(reason.value.length === 0 ? {} : { reason: reason.value }),
    };
  }

  public async cleanup(token: string): Promise<boolean> {
    const response = await this.send(requestPayload(OP_CLEANUP, [encodeString(this.session()), encodeString(token)]));
    return this.readBoolean(response);
  }

  public async cancel(token: string): Promise<boolean> {
    const response = await this.send(requestPayload(OP_CANCEL, [encodeString(this.session()), encodeString(token)]));
    return this.readBoolean(response);
  }

  public async close(): Promise<void> {
    if (this.child === undefined) {
      return;
    }
    this.closing = true;
    try {
      if (this.sessionToken !== undefined) {
        const response = await this.send(requestPayload(OP_SHUTDOWN, [encodeString(this.sessionToken)]));
        this.readBoolean(response);
      }
    } finally {
      const child = this.child;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("close", () => resolve());
      });
      this.child = undefined;
      this.sessionToken = undefined;
    }
  }

  private session(): string {
    if (this.sessionToken === undefined) {
      throw new WindowsCasHelperError("HELPER_NOT_STARTED", "helper session is not started");
    }
    return this.sessionToken;
  }

  private readBoolean(response: Buffer): boolean {
    ensureStatus(response, RESPONSE_BOOLEAN);
    if (response.byteLength < 2) {
      throw new WindowsCasHelperError("TRUNCATED_RESPONSE", "helper boolean response is truncated");
    }
    const reason = decodeString(response, 2);
    if (reason.next !== response.byteLength) {
      throw new WindowsCasHelperError("INVALID_RESPONSE", "helper boolean response has trailing data");
    }
    return response[1] === 1;
  }

  private async send(payload: Buffer): Promise<Buffer> {
    const task = this.requestChain.then(async () => this.sendImmediately(payload));
    this.requestChain = task.then(() => undefined, () => undefined);
    return task;
  }

  private async sendImmediately(payload: Buffer): Promise<Buffer> {
    if (this.child === undefined || this.child.stdin.destroyed) {
      throw new WindowsCasHelperError("HELPER_UNAVAILABLE", "helper process is unavailable");
    }
    const response = this.nextFrame();
    this.child.stdin.write(frame(payload));
    return response;
  }

  private nextFrame(): Promise<Buffer> {
    const ready = this.frames.shift();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    if (this.childFailure !== undefined) {
      return Promise.reject(this.childFailure);
    }
    return new Promise<Buffer>((resolve, reject) => this.readers.push({ resolve, reject }));
  }

  private consume(chunk: Buffer): void {
    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);
    while (this.inputBuffer.byteLength >= 4) {
      const length = this.inputBuffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new WindowsCasHelperError("FRAME_TOO_LARGE", "helper response exceeds the 64 KiB bound"));
        return;
      }
      if (this.inputBuffer.byteLength < 4 + length) {
        return;
      }
      const payload = this.inputBuffer.subarray(4, 4 + length);
      this.inputBuffer = this.inputBuffer.subarray(4 + length);
      const reader = this.readers.shift();
      if (reader !== undefined) {
        reader.resolve(payload);
      } else {
        this.frames.push(payload);
      }
    }
  }

  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.childFailure = failure;
    while (this.readers.length > 0) {
      this.readers.shift()?.reject(failure);
    }
  }
}

export const WINDOWS_CAS_HELPER_MAX_FRAME_BYTES = MAX_FRAME_BYTES;
