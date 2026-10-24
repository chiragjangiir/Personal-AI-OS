import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { WindowsCasHelperClient, type HelperPublishComplete, type HelperPublishPending } from "./windows-cas-helper-client.ts";

/**
 * The validation root is deliberately fixed for this gate.  The production
 * root is named here only so callers and tests can assert that it remains
 * absent; this module never creates or removes it.
 */
export const VALIDATION_ROOT = "K:\\PersonalAIOS\\cold-cas-validation-successor-006";
export const PRODUCTION_ROOT = "K:\\PersonalAIOS\\cold-cas-001";
export const DEFAULT_HELPER_EXECUTABLE = process.env.PAIOS_COLD_CAS_VALIDATION_HELPER ?? "C:\\ProgramData\\PersonalAIOS\\connector-runtime-helper-validation-006\\cold-cas-helper.exe";
export const PRODUCTION_HELPER_EXECUTABLE = process.env.PAIOS_COLD_CAS_PRODUCTION_HELPER ?? "C:\\ProgramData\\PersonalAIOS\\connector-runtime-helper-production-001\\cold-cas-helper.exe";
export const CAS_NAMESPACE = "sha256";
export const CAS_READ_CHUNK_BYTES = 64 * 1024;

export interface ColdCasPlatformCapabilities {
  readonly platform: NodeJS.Platform;
  readonly hasNoFollowOpen: boolean;
  readonly hasDirectoryOpen: boolean;
  readonly hasHandleRelativeUnlink: boolean;
  readonly hasHandleRelativeOpen: boolean;
  readonly hasHandleRelativeLink: boolean;
  readonly hasFileHandleUnlink: boolean;
  readonly hasCompleteReparseTagInspection: boolean;
  readonly hasWin32HelperBridge: boolean;
  readonly safeForMutation: boolean;
  readonly reason: string;
}

/**
 * Node 24's public Win32 fs API remains path based. The approved .NET helper
 * supplies the missing handle-held Win32 operations; Node remains responsible
 * for bounded streaming and identity/hash calculation while the helper owns
 * link/disposition and temp cleanup.
 */
export function inspectColdCasPlatform(helperExecutablePath = DEFAULT_HELPER_EXECUTABLE): ColdCasPlatformCapabilities {
  const hasNoFollowOpen = typeof fsConstants.O_NOFOLLOW === "number";
  const hasDirectoryOpen = typeof fsConstants.O_DIRECTORY === "number";
  const hasWin32HelperBridge = process.platform === "win32" && helperExecutablePath.length > 0;
  return {
    platform: process.platform,
    hasNoFollowOpen,
    hasDirectoryOpen,
    hasHandleRelativeUnlink: hasWin32HelperBridge,
    hasHandleRelativeOpen: hasWin32HelperBridge,
    hasHandleRelativeLink: hasWin32HelperBridge,
    hasFileHandleUnlink: hasWin32HelperBridge,
    hasCompleteReparseTagInspection: hasWin32HelperBridge,
    hasWin32HelperBridge,
    safeForMutation: hasWin32HelperBridge,
    reason:
      hasWin32HelperBridge
        ? "Win32 handle-safe operations delegated to the approved .NET helper"
        : "REVISE: the approved Win32 helper bridge is unavailable on this platform",
  };
}

export type CasStatus =
  | "published"
  | "reused"
  | "corrupt_existing"
  | "failed_cleanup_pending";

export interface CasPath {
  readonly root: string;
  readonly hash: string;
  readonly namespace: typeof CAS_NAMESPACE;
  readonly first: string;
  readonly second: string;
  readonly directory: string;
  readonly finalPath: string;
}

export interface PublishedResult {
  readonly status: "published";
  readonly hash: string;
  readonly finalPath: string;
  readonly bytes: number;
}

export interface ReusedResult {
  readonly status: "reused";
  readonly hash: string;
  readonly finalPath: string;
  readonly bytes: number;
}

export interface CorruptExistingResult {
  readonly status: "corrupt_existing";
  readonly hash: string;
  readonly finalPath: string;
  readonly bytes: number;
  readonly reason: string;
}

export interface FailedCleanupPendingResult {
  readonly status: "failed_cleanup_pending";
  readonly hash: string;
  readonly finalPath: string;
  readonly bytes: number;
  readonly tempPath: string;
  readonly reason: string;
}

export type CasResult =
  | PublishedResult
  | ReusedResult
  | CorruptExistingResult
  | FailedCleanupPendingResult;

export type ContentChunk = Uint8Array;
export type ContentSource =
  | string
  | Uint8Array
  | Iterable<ContentChunk>
  | AsyncIterable<ContentChunk>;

export interface PublishRequest {
  readonly hash: string;
  readonly source: ContentSource;
}

export type FaultPoint =
  | "before_sync"
  | "after_sync"
  | "before_link"
  | "after_link"
  | "before_temp_unlink"
  | "after_temp_unlink";

export type FaultHook = (point: FaultPoint) => void | Promise<void>;

export interface ColdCasOptions {
  /** Must equal VALIDATION_ROOT. */
  readonly root?: string;
  readonly fault?: FaultHook;
  readonly helperExecutablePath?: string;
  /**
   * The default is the frozen validation profile. Production is reachable
   * only through the explicit production factory below and remains bound to
   * the production root and helper configured at process startup.
   */
  readonly profile?: "validation" | "production";
}

export interface ProductionColdCasOptions {
  readonly fault?: FaultHook;
}

export interface ExistingInspection {
  readonly exists: boolean;
  readonly valid: boolean;
  readonly bytes?: number;
  readonly hash?: string;
  readonly reason?: string;
}

export class ColdCasError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ColdCasError";
    this.code = code;
  }
}

export class ColdCasPlatformError extends ColdCasError {
  public constructor(message: string) {
    super("REVISE", message);
    this.name = "ColdCasPlatformError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripExtendedPrefix(value: string): string {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function comparablePath(value: string): string {
  const normalized = stripExtendedPrefix(resolve(value)).replace(/[\\/]+$/, "");
  return normalized.toLowerCase();
}

function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function isInside(root: string, candidate: string): boolean {
  const rootComparable = comparablePath(root);
  const candidateComparable = comparablePath(candidate);
  if (candidateComparable === rootComparable) {
    return true;
  }
  const rel = relative(rootComparable, candidateComparable);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel);
}

function assertSafeSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\\") ||
    value.includes("/") ||
    value.includes(":")
  ) {
    throw new ColdCasError("INVALID_PATH", `${label} contains an unsafe path segment`);
  }
}

export function assertStrictSha256(hash: string): asserts hash is string {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new ColdCasError("INVALID_HASH", "hash must be exactly 64 lowercase hexadecimal characters");
  }
}

export function pathForHash(root: string, hash: string): CasPath {
  assertStrictSha256(hash);
  const resolvedRoot = resolve(root);
  const first = hash.slice(0, 2);
  const second = hash.slice(2, 4);
  assertSafeSegment(first, "hash prefix");
  assertSafeSegment(second, "hash prefix");
  const directory = join(resolvedRoot, CAS_NAMESPACE, first, second);
  const finalPath = join(directory, hash);
  if (!isInside(resolvedRoot, directory) || !isInside(resolvedRoot, finalPath)) {
    throw new ColdCasError("INVALID_PATH", "derived CAS path escapes the configured root");
  }
  return {
    root: resolvedRoot,
    hash,
    namespace: CAS_NAMESPACE,
    first,
    second,
    directory,
    finalPath,
  };
}

export function assertValidationRoot(root: string): string {
  const resolved = resolve(root);
  if (!pathsEqual(resolved, VALIDATION_ROOT)) {
    throw new ColdCasError("INVALID_ROOT", `real-fs root must be ${VALIDATION_ROOT}`);
  }
  return resolved;
}

export function assertProductionRoot(root: string): string {
  const resolved = resolve(root);
  if (!pathsEqual(resolved, PRODUCTION_ROOT)) {
    throw new ColdCasError("INVALID_ROOT", "production real-fs root must be " + PRODUCTION_ROOT);
  }
  return resolved;
}

export async function assertProductionRootAbsent(): Promise<void> {
  try {
    await fs.lstat(PRODUCTION_ROOT);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw new ColdCasError("PRODUCTION_ROOT_CHECK_FAILED", messageOf(error));
  }
  throw new ColdCasError("PRODUCTION_ROOT_PRESENT", `${PRODUCTION_ROOT} must remain absent`);
}

async function realPathMatches(path: string, expected: string): Promise<boolean> {
  try {
    const actual = await fs.realpath(path);
    return pathsEqual(actual, expected);
  } catch {
    return false;
  }
}

function isRegularNonReparse(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function isDirectoryNonReparse(stats: Stats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

function sameIdentity(left: Stats, right: Stats): boolean {
  if (!Number.isSafeInteger(left.dev) || !Number.isSafeInteger(left.ino)) {
    return false;
  }
  if (!Number.isSafeInteger(right.dev) || !Number.isSafeInteger(right.ino)) {
    return false;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function validNlink(stats: Stats, expected: number): boolean {
  return Number.isSafeInteger(stats.nlink) && stats.nlink === expected;
}

async function* chunksFrom(source: ContentSource): AsyncGenerator<Uint8Array> {
  if (typeof source === "string") {
    yield new TextEncoder().encode(source);
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source !== null && typeof source === "object") {
    if (Symbol.asyncIterator in source) {
      for await (const chunk of source as AsyncIterable<unknown>) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ColdCasError("INVALID_SOURCE", "content source yielded a non-Uint8Array chunk");
        }
        yield chunk;
      }
      return;
    }
    if (Symbol.iterator in source) {
      for (const chunk of source as Iterable<unknown>) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ColdCasError("INVALID_SOURCE", "content source yielded a non-Uint8Array chunk");
        }
        yield chunk;
      }
      return;
    }
  }
  throw new ColdCasError("INVALID_SOURCE", "content source must be bytes or an iterable of bytes");
}

async function hashHandle(handle: FileHandle, expectedSize: number): Promise<{ hash: string; bytes: number }> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new ColdCasPlatformError("file size is not a safe non-negative integer");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CAS_READ_CHUNK_BYTES);
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - position);
    const read = await handle.read(buffer, 0, length, position);
    if (read.bytesRead <= 0) {
      throw new ColdCasPlatformError("file ended before its stable size was read");
    }
    digest.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return { hash: digest.digest("hex"), bytes: position };
}

export class ColdCasStore {
  public readonly root: string;
  public readonly capabilities: ColdCasPlatformCapabilities;
  public readonly profile: "validation" | "production";
  private readonly fault: FaultHook | undefined;
  private readonly helperExecutablePath: string;
  private helper: WindowsCasHelperClient | undefined;
  private helperStart: Promise<WindowsCasHelperClient> | undefined;
  private readonly ownedTemps = new Set<string>();
  private readonly ownedTempIdentity = new Map<string, { dev: number; ino: number }>();
  private readonly ownedTempTokens = new Map<string, string>();

  public constructor(options: ColdCasOptions = {}) {
    this.profile = options.profile ?? "validation";
    const root = options.root ?? (this.profile === "production" ? PRODUCTION_ROOT : VALIDATION_ROOT);
    if (this.profile === "production") {
      this.root = assertProductionRoot(root);
    } else {
      this.root = assertValidationRoot(root);
    }
    this.fault = options.fault;
    const expectedHelper =
      this.profile === "production" ? PRODUCTION_HELPER_EXECUTABLE : DEFAULT_HELPER_EXECUTABLE;
    const helperExecutablePath = options.helperExecutablePath ?? expectedHelper;
    if (this.profile === "production" && helperExecutablePath !== PRODUCTION_HELPER_EXECUTABLE) {
      throw new ColdCasError(
        "INVALID_HELPER",
        "production CAS must use the compiled helper " + PRODUCTION_HELPER_EXECUTABLE,
      );
    }
    this.helperExecutablePath = helperExecutablePath;
    this.capabilities = inspectColdCasPlatform(this.helperExecutablePath);
  }

  public path(hash: string): CasPath {
    return pathForHash(this.root, hash);
  }

  public async verifyEnvironment(): Promise<void> {
    try {
      await this.verifyProfileEnvironment();
    } finally {
      await this.verifyProfileAfterEnvironment();
    }
  }

  public async close(): Promise<void> {
    if (this.helperStart !== undefined) {
      await this.helperStart.catch(() => undefined);
    }
    if (this.helper !== undefined) {
      const helper = this.helper;
      this.helper = undefined;
      this.helperStart = undefined;
      await helper.close();
    }
  }

  public get helperPid(): number | undefined {
    return this.helper?.pid;
  }

  public async inspect(hash: string): Promise<ExistingInspection> {
    try {
      const casPath = this.path(hash);
      await this.verifyProfileEnvironment();
      this.requireSafeMutation();
      const layout = await this.ensureLayout(casPath);
      if (!layout) {
        return { exists: false, valid: false, reason: "layout unavailable" };
      }
      return this.inspectFinal(casPath.finalPath, hash, undefined, 1);
    } finally {
      await this.verifyProfileAfterEnvironment();
    }
  }

  /**
   * Read a final CAS object with the same regular-file, identity, nlink and
   * hash checks used by publish finalization. This is intentionally a
   * production-facing read seam; validation callers retain the default
   * validation profile and its frozen production-root-absent guard.
   */
  public async read(hash: string): Promise<Buffer> {
    assertStrictSha256(hash);
    let output: Buffer | undefined;
    try {
      const casPath = this.path(hash);
      await this.verifyProfileEnvironment();
      const inspection = await this.inspectFinal(casPath.finalPath, hash, undefined, 1);
      if (!inspection.valid || inspection.bytes === undefined) {
        throw new ColdCasError("OBJECT_NOT_FOUND", inspection.reason ?? "final object failed verification");
      }
      output = Buffer.allocUnsafe(inspection.bytes);
      let handle: FileHandle | undefined;
      try {
        handle = await fs.open(casPath.finalPath, "r");
        const handleStats = await handle.stat();
        if (
          !isRegularNonReparse(handleStats) ||
          !validNlink(handleStats, 1) ||
          handleStats.size !== output.byteLength
        ) {
          throw new ColdCasError("OBJECT_CHANGED", "final object changed before readback");
        }
        let position = 0;
        while (position < output.byteLength) {
          const read = await handle.read(output, position, output.byteLength - position, position);
          if (read.bytesRead <= 0) {
            throw new ColdCasError("OBJECT_CHANGED", "final object ended before readback completed");
          }
          position += read.bytesRead;
        }
        const digest = createHash("sha256").update(output).digest("hex");
        if (digest !== hash) {
          throw new ColdCasError("HASH_MISMATCH", "final object readback hash differs from requested hash");
        }
      } finally {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
        }
      }
      const after = await this.inspectFinal(casPath.finalPath, hash, output.byteLength, 1);
      if (!after.valid) {
        throw new ColdCasError("OBJECT_CHANGED", after.reason ?? "final object changed during readback");
      }
      return output;
    } catch (error) {
      if (output !== undefined) {
        output.fill(0);
      }
      throw error;
    } finally {
      await this.verifyProfileAfterEnvironment();
    }
  }

  /** Publish an already identity-bound object. The hash is supplied by the owner. */
  public async publish(request: PublishRequest): Promise<CasResult>;
  public async publish(hash: string): Promise<CasResult>;
  public async publish(hash: string, source: ContentSource): Promise<CasResult>;
  public async publish(
    requestOrHash: PublishRequest | string,
    optionalSource?: ContentSource,
  ): Promise<CasResult> {
    try {
      return await this.publishInternal(requestOrHash, optionalSource);
    } finally {
      await this.verifyProfileAfterEnvironment();
    }
  }

  private async publishInternal(
    requestOrHash: PublishRequest | string,
    optionalSource?: ContentSource,
  ): Promise<CasResult> {
    const request: PublishRequest =
      typeof requestOrHash === "string"
        ? { hash: requestOrHash, source: optionalSource as ContentSource }
        : requestOrHash;
    assertStrictSha256(request.hash);
    if (optionalSource === undefined && typeof requestOrHash === "string") {
      throw new ColdCasError("INVALID_SOURCE", "publish requires a content source");
    }
    const casPath = this.path(request.hash);
    await this.verifyEnvironment();
    this.requireSafeMutation();
    await this.ensureLayout(casPath);
    const helper = await this.helperClient();
    const allocation = await helper.allocate(this.root, casPath.finalPath, request.hash);
    const tempPath = allocation.tempPath;
    const allocationToken = allocation.token;
    this.ownedTempTokens.set(tempPath, allocationToken);
    let bytes = 0;
    const digest = createHash("sha256");
    try {
      // The helper owns the CREATE_NEW handle for the entire write/link/
      // disposition sequence. Node only streams bounded chunks over private
      // framed stdio, avoiding a pre-link close/replacement window.
      this.ownedTemps.add(tempPath);
      for await (const chunk of chunksFrom(request.source)) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const bounded = chunk.subarray(offset, Math.min(offset + 60 * 1024, chunk.byteLength));
          await helper.write(allocationToken, bounded);
          digest.update(bounded);
          bytes += bounded.byteLength;
          if (!Number.isSafeInteger(bytes)) {
            throw new ColdCasError("OBJECT_TOO_LARGE", "object byte count exceeded safe integer range");
          }
          offset += bounded.byteLength;
        }
      }
      const computedHash = digest.digest("hex");
      if (computedHash !== request.hash) {
        throw new ColdCasError("HASH_MISMATCH", "streamed content does not match the supplied SHA-256");
      }
      await this.callFault("before_sync");
      await helper.sync(allocationToken);
      await this.callFault("after_sync");
    } catch (error) {
      const cleaned = await this.cleanupOwnedTemp(tempPath);
      if (!cleaned) {
        return {
          status: "failed_cleanup_pending",
          hash: request.hash,
          finalPath: casPath.finalPath,
          bytes,
          tempPath,
          reason: `${messageOf(error)}; owned temporary file cleanup failed`,
        };
      }
      throw error;
    }

    let pending: HelperPublishPending;
    let complete: HelperPublishComplete;
    try {
      await this.callFault("before_link");
      pending = await helper.publish(allocationToken, request.hash);
      complete = await helper.finalize(allocationToken);
      await this.callFault("after_link");
    } catch (error) {
      const cleaned = await this.cleanupOwnedTemp(tempPath);
      if (!cleaned) {
        return {
          status: "failed_cleanup_pending",
          hash: request.hash,
          finalPath: casPath.finalPath,
          bytes,
          tempPath,
          reason: `${messageOf(error)}; owned temporary file cleanup failed`,
        };
      }
      throw error;
    }

    this.ownedTemps.delete(tempPath);
    this.ownedTempIdentity.delete(tempPath);
    this.ownedTempTokens.delete(tempPath);
    if (complete.status === "corrupt_existing") {
      // The frozen helper may conservatively report a corrupt existing
      // object when its nlink=2 same-handle probe collides with the owned
      // delete disposition. The helper has already closed/disposed only its
      // owned temp; accept the result only after Node independently proves
      // the final path is regular, nlink=1, stable, and hash-identical.
      const finalVerification = await this.inspectFinal(casPath.finalPath, request.hash, bytes, 1);
      if (finalVerification.valid) {
        return {
          status: "published",
          hash: request.hash,
          finalPath: casPath.finalPath,
          bytes: finalVerification.bytes ?? bytes,
        };
      }
      return {
        status: "corrupt_existing",
        hash: request.hash,
        finalPath: casPath.finalPath,
        bytes: complete.bytes,
        reason: complete.reason ?? pending.reason ?? "existing final failed strict validation",
      };
    }
    return { status: complete.status, hash: request.hash, finalPath: casPath.finalPath, bytes: complete.bytes };
  }

  public async put(request: PublishRequest): Promise<CasResult> {
    return this.publish(request);
  }

  /** Retry only a temp path that this store allocated through the helper. */
  public async reconcileOwnedTemp(tempPath: string): Promise<boolean> {
    return this.cleanupOwnedTemp(tempPath);
  }

  private async callFault(point: FaultPoint): Promise<void> {
    if (this.fault !== undefined) {
      await this.fault(point);
    }
  }

  private requireSafeMutation(): void {
    if (!this.capabilities.safeForMutation) {
      throw new ColdCasPlatformError(this.capabilities.reason);
    }
  }

  private async helperClient(): Promise<WindowsCasHelperClient> {
    if (this.helper !== undefined) {
      return this.helper;
    }
    if (this.helperStart === undefined) {
      this.helperStart = (async () => {
        const helper = new WindowsCasHelperClient(this.helperExecutablePath);
        await helper.start();
        this.helper = helper;
        return helper;
      })();
    }
    return this.helperStart;
  }

  private async verifyProfileEnvironment(): Promise<void> {
    if (this.profile === "validation") {
      await assertProductionRootAbsent();
      await this.verifyRootAncestors();
      return;
    }
    await this.verifyProductionParentChain();
  }

  private async verifyProfileAfterEnvironment(): Promise<void> {
    if (this.profile === "validation") {
      await assertProductionRootAbsent();
      return;
    }
    await this.verifyProductionParentChain();
  }

  private async verifyRootAncestors(): Promise<void> {
    const root = resolve(this.root);
    const parsed = parse(root);
    if (!parsed.root || !pathsEqual(parsed.root, parse(VALIDATION_ROOT).root)) {
      throw new ColdCasError("INVALID_ROOT", "configured root must be an absolute drive path");
    }
    let current = parsed.root;
    const segments = relative(parsed.root, root).split(/[\\/]/).filter((segment) => segment.length > 0);
    await this.verifyDirectory(current, current);
    for (const segment of segments) {
      assertSafeSegment(segment, "root ancestor");
      current = join(current, segment);
      await this.verifyDirectory(current, current);
    }
  }

  private async verifyProductionParentChain(): Promise<void> {
    const root = resolve(this.root);
    const parsed = parse(root);
    const productionParsed = parse(PRODUCTION_ROOT);
    if (!parsed.root || !productionParsed.root || !pathsEqual(parsed.root, productionParsed.root)) {
      throw new ColdCasError("INVALID_ROOT", "configured production root must be an absolute drive path");
    }
    const segments = relative(parsed.root, root).split(/[\\/]/).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      throw new ColdCasError("INVALID_ROOT", "configured production root cannot be a drive root");
    }
    let current = parsed.root;
    await this.verifyDirectory(current, current);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        throw new ColdCasError("INVALID_ROOT", "production root contains an empty ancestor segment");
      }
      assertSafeSegment(segment, "production root ancestor");
      const next = join(current, segment);
      if (!isInside(parsed.root, next) || !pathsEqual(dirname(next), current)) {
        throw new ColdCasError("INVALID_PATH", "production root ancestor escaped its drive root");
      }
      if (index === segments.length - 1) {
        try {
          await this.verifyDirectory(next, next);
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            return;
          }
          if (error instanceof ColdCasError && error.code === "ROOT_UNAVAILABLE") {
            try {
              await fs.lstat(next);
            } catch (retryError) {
              if (errorCode(retryError) === "ENOENT") {
                return;
              }
            }
          }
          throw error;
        }
      } else {
        await this.verifyDirectory(next, next);
      }
      current = next;
    }
  }

  private async verifyDirectory(path: string, expected: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await fs.lstat(path);
    } catch (error) {
      throw new ColdCasError("ROOT_UNAVAILABLE", messageOf(error));
    }
    if (!isDirectoryNonReparse(stats)) {
      throw new ColdCasError("REPARSE_OR_NOT_DIRECTORY", `${path} is not a regular non-reparse directory`);
    }
    if (!(await realPathMatches(path, expected))) {
      throw new ColdCasError("REPARSE_OR_ESCAPE", `${path} does not resolve to itself`);
    }
  }

  private async ensureLayout(casPath: CasPath): Promise<boolean> {
    if (this.profile === "validation") {
      await this.verifyRootAncestors();
    } else {
      await this.verifyProductionParentChain();
      try {
        await fs.mkdir(this.root);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new ColdCasError("LAYOUT_CREATE_FAILED", messageOf(error));
        }
      }
      await this.verifyDirectory(this.root, this.root);
    }
    for (const child of [CAS_NAMESPACE, casPath.first, casPath.second]) {
      assertSafeSegment(child, "CAS layout segment");
    }
    let current = this.root;
    for (const child of [CAS_NAMESPACE, casPath.first, casPath.second]) {
      const next = join(current, child);
      if (!isInside(this.root, next) || !pathsEqual(dirname(next), current)) {
        throw new ColdCasError("INVALID_PATH", "CAS layout escaped its root");
      }
      try {
        await fs.mkdir(next);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new ColdCasError("LAYOUT_CREATE_FAILED", messageOf(error));
        }
      }
      await this.verifyDirectory(next, next);
      current = next;
    }
    if (!pathsEqual(current, casPath.directory)) {
      throw new ColdCasError("INVALID_PATH", "derived final directory mismatch");
    }
    return true;
  }

  private async inspectFinal(
    finalPath: string,
    expectedHash: string,
    expectedBytes: number | undefined,
    expectedNlink: number,
  ): Promise<ExistingInspection> {
    let pathStats: Stats;
    try {
      pathStats = await fs.lstat(finalPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { exists: false, valid: false, reason: "final object does not exist" };
      }
      return { exists: true, valid: false, reason: `lstat failed: ${messageOf(error)}` };
    }
    if (!isRegularNonReparse(pathStats)) {
      return { exists: true, valid: false, reason: "final object is not a regular non-reparse file" };
    }
    if (!validNlink(pathStats, expectedNlink)) {
      return { exists: true, valid: false, reason: `final object nlink was ${pathStats.nlink}, expected ${expectedNlink}` };
    }
    if (!(await realPathMatches(finalPath, finalPath))) {
      return { exists: true, valid: false, reason: "final object resolves through a reparse point" };
    }
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(finalPath, "r");
      const handleStats = await handle.stat();
      if (!isRegularNonReparse(handleStats) || !validNlink(handleStats, expectedNlink)) {
        return { exists: true, valid: false, reason: "opened final handle failed regular/nlink validation" };
      }
      if (!sameIdentity(pathStats, handleStats)) {
        return { exists: true, valid: false, reason: "path lstat and opened-handle fstat identify different files" };
      }
      if (pathStats.size !== handleStats.size) {
        return { exists: true, valid: false, reason: "final size changed between path lstat and opened-handle fstat" };
      }
      if (expectedBytes !== undefined && handleStats.size !== expectedBytes) {
        return { exists: true, valid: false, bytes: handleStats.size, reason: "final object size differs from supplied content" };
      }
      const digest = await hashHandle(handle, handleStats.size);
      if (digest.hash !== expectedHash) {
        return { exists: true, valid: false, bytes: digest.bytes, hash: digest.hash, reason: "final object hash differs from supplied content" };
      }
      const pathAfter = await fs.lstat(finalPath);
      if (
        !isRegularNonReparse(pathAfter) ||
        !validNlink(pathAfter, expectedNlink) ||
        !sameIdentity(pathAfter, handleStats) ||
        pathAfter.size !== handleStats.size ||
        !(await realPathMatches(finalPath, finalPath))
      ) {
        return { exists: true, valid: false, bytes: digest.bytes, hash: digest.hash, reason: "final changed during same-handle verification" };
      }
      return { exists: true, valid: true, bytes: digest.bytes, hash: digest.hash };
    } catch (error) {
      return { exists: true, valid: false, reason: `opened-handle validation failed: ${messageOf(error)}` };
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  private async cleanupOwnedTemp(tempPath: string): Promise<boolean> {
    const token = this.ownedTempTokens.get(tempPath);
    if (token === undefined) {
      // A caller-supplied or unknown path is never eligible for cleanup. The
      // token map is the ownership proof; absence is a fail-closed result.
      return false;
    }
    try {
      await this.callFault("before_temp_unlink");
      const helper = await this.helperClient();
      const cleaned = await helper.cleanup(token);
      if (cleaned) {
        this.ownedTemps.delete(tempPath);
        this.ownedTempIdentity.delete(tempPath);
        this.ownedTempTokens.delete(tempPath);
      }
      return cleaned;
    } catch {
      return false;
    }
  }

  private async hasCompetingTemp(directory: string, hash: string, ownTempPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const prefix = `.${hash}.tmp-`;
      return entries.some(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.startsWith(prefix) &&
          /^[0-9a-f]{64}$/u.test(entry.name.slice(prefix.length)) &&
          !pathsEqual(join(directory, entry.name), ownTempPath),
      );
    } catch {
      // An unreadable directory cannot prove a competing allocation. The
      // caller must fail closed, and this probe never deletes an entry.
      return false;
    }
  }
}

export async function publishColdObject(
  request: PublishRequest,
  options: ColdCasOptions = {},
): Promise<CasResult> {
  return new ColdCasStore(options).publish(request);
}

export function createProductionColdCas(options: ProductionColdCasOptions = {}): ColdCasStore {
  if (options.fault === undefined) {
    return new ColdCasStore({
      profile: "production",
      root: PRODUCTION_ROOT,
      helperExecutablePath: PRODUCTION_HELPER_EXECUTABLE,
    });
  }
  return new ColdCasStore({
    profile: "production",
    root: PRODUCTION_ROOT,
    helperExecutablePath: PRODUCTION_HELPER_EXECUTABLE,
    fault: options.fault,
  });
}

export { ColdCasStore as ColdCas };
