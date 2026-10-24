import { randomBytes } from 'node:crypto';

/**
 * Internal, non-canonical E2EE key material seam.
 *
 * The SDK owns frame encryption and ratcheting.  This module only creates a
 * short-lived key lease and shapes one key copy into the structural form that
 * `@livekit/rtc-node` 0.13.31 accepts as `RoomOptions.encryption`.  No key is
 * serialised, persisted, logged, or included in a reference object.
 */

export const LIVEKIT_GCM_ENCRYPTION_TYPE = 1 as const;
export const LIVEKIT_E2EE_KEY_BYTES = 32 as const;
export const DEFAULT_E2EE_KEY_LEASE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_LIVEKIT_RATCHET_WINDOW_SIZE = 16;
export const DEFAULT_LIVEKIT_FAILURE_TOLERANCE = -1;

declare const e2eeKeyReferenceBrand: unique symbol;

/** Opaque in-process key reference.  It has no key bytes or wire meaning. */
export interface E2eeKeyReference {
  readonly key_ref: string & { readonly [e2eeKeyReferenceBrand]: 'e2ee-key-ref' };
  readonly generation: number;
}

export type E2EEKeyReference = E2eeKeyReference;

export interface E2eeKeyProviderOptions {
  readonly keyBytes?: number;
  readonly leaseTtlMs?: number;
  readonly nowMs?: () => number;
  /** Testable source seam; the default is Node's cryptographic random source. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface E2eeKeyLease {
  readonly ref: E2eeKeyReference;
  readonly generation: number;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
  /** Returns a defensive copy, or undefined once expired/released/destroyed. */
  readonly read: () => Uint8Array | undefined;
  /** Alias for read(), kept as an explicit delivery seam for an SDK adapter. */
  readonly deliver: () => Uint8Array | undefined;
  readonly getKeyBytes: () => Uint8Array | undefined;
  readonly isActive: () => boolean;
  readonly release: () => void;
}

export type E2EEKeyLease = E2eeKeyLease;

export interface LiveKitKeyProviderOptions {
  /** A defensive copy consumed by the SDK's KeyProvider. */
  readonly sharedKey: Uint8Array;
  readonly ratchetSalt?: Uint8Array;
  readonly ratchetWindowSize?: number;
  readonly failureTolerance?: number;
}

/** Structural equivalent of @livekit/rtc-node's E2EEOptions. */
export interface LiveKitEncryptionOptions {
  readonly encryptionType: typeof LIVEKIT_GCM_ENCRYPTION_TYPE;
  readonly keyProviderOptions: LiveKitKeyProviderOptions;
}

export interface LiveKitEncryptionConfig {
  readonly ratchetSalt?: Uint8Array;
  readonly ratchetWindowSize?: number;
  readonly failureTolerance?: number;
}

export interface LiveKitRoomOptionsWithEncryption {
  readonly encryption: LiveKitEncryptionOptions;
}

interface KeyRecord {
  readonly ref: E2eeKeyReference;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly bytes: Buffer;
}

function finiteTime(value: number, code: string): number {
  if (!Number.isFinite(value)) throw new Error(code);
  return value;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function positiveDuration(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function freezeReference(
  keyRef: string,
  generation: number,
): E2eeKeyReference {
  return Object.freeze({
    key_ref: keyRef as E2eeKeyReference['key_ref'],
    generation,
  });
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cloneOptionalBytes(bytes: Uint8Array | undefined): Uint8Array | undefined {
  return bytes === undefined ? undefined : cloneBytes(bytes);
}

/**
 * In-memory E2EE key provider.  It deliberately has no timer: expiry is
 * checked at each read/delivery call, so a caller owns lifecycle scheduling.
 */
export class InMemoryE2eeKeyProvider {
  readonly #keyBytes: number;
  readonly #leaseTtlMs: number;
  readonly #nowMs: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  // Object-identity lookup makes the in-process reference an unforgeable
  // capability; a structurally identical object cannot retrieve key bytes.
  readonly #records = new Map<E2eeKeyReference, KeyRecord>();
  #generation = 0;
  #currentRef: E2eeKeyReference | undefined;
  #destroyed = false;

  constructor(options: E2eeKeyProviderOptions = {}) {
    this.#keyBytes = positiveInteger(
      options.keyBytes ?? LIVEKIT_E2EE_KEY_BYTES,
      'INVALID_E2EE_KEY_LENGTH',
    );
    this.#leaseTtlMs = positiveDuration(
      options.leaseTtlMs ?? DEFAULT_E2EE_KEY_LEASE_TTL_MS,
      'INVALID_E2EE_KEY_LEASE_TTL',
    );
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#randomBytes = options.randomBytes ?? ((size) => randomBytes(size));
  }

  get keyBytes(): number {
    return this.#keyBytes;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Generate the first/current generation, revoking any prior generation. */
  generate(atMs = this.#nowMs()): E2eeKeyLease {
    this.#assertUsable();
    this.#revokeAll();
    return this.#createLease(atMs);
  }

  /** Generate a new generation and zeroize the previous generation first. */
  rotate(atMs = this.#nowMs()): E2eeKeyLease {
    return this.generate(atMs);
  }

  /** Alias used by adapters that model generation as an issued lease. */
  issue(atMs = this.#nowMs()): E2eeKeyLease {
    return this.generate(atMs);
  }

  currentRef(): E2eeKeyReference | undefined {
    return this.#currentRef;
  }

  getCurrentRef(): E2eeKeyReference | undefined {
    return this.currentRef();
  }

  /** Deliver a defensive key copy only while its opaque ref is active. */
  deliver(ref: E2eeKeyReference, atMs = this.#nowMs()): Uint8Array | undefined {
    this.#assertReference(ref);
    const record = this.#records.get(ref);
    if (record === undefined) return undefined;
    if (finiteTime(atMs, 'INVALID_E2EE_CLOCK') >= record.expiresAtMs) {
      this.#revoke(record.ref);
      return undefined;
    }
    return cloneBytes(record.bytes);
  }

  release(ref: E2eeKeyReference): void {
    this.#assertReference(ref);
    this.#revoke(ref);
  }

  /** Explicitly zeroize all in-memory key material and close the seam. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#revokeAll();
    this.#destroyed = true;
  }

  toLiveKitEncryptionOptions(
    lease: E2eeKeyLease,
    config: LiveKitEncryptionConfig = {},
  ): LiveKitEncryptionOptions {
    return createLiveKitEncryptionOptions(lease, config);
  }

  withLiveKitEncryption<T extends object>(
    roomOptions: T,
    lease: E2eeKeyLease,
    config: LiveKitEncryptionConfig = {},
  ): T & LiveKitRoomOptionsWithEncryption {
    return injectLiveKitEncryption(roomOptions, lease, config);
  }

  #createLease(atMs: number): E2eeKeyLease {
    const issuedAtMs = finiteTime(atMs, 'INVALID_E2EE_CLOCK');
    const expiresAtMs = issuedAtMs + this.#leaseTtlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error('INVALID_E2EE_KEY_EXPIRY');

    const supplied = this.#randomBytes(this.#keyBytes);
    if (!(supplied instanceof Uint8Array) || supplied.byteLength !== this.#keyBytes) {
      throw new Error('INVALID_E2EE_RANDOM_SOURCE');
    }
    // Own exactly one stored copy.  Clear the source buffer immediately so a
    // custom source cannot accidentally retain a second live copy.
    const owned = Buffer.from(supplied);
    supplied.fill(0);

    this.#generation += 1;
    const ref = freezeReference(`public-rtc-e2ee-key-${this.#generation}`, this.#generation);
    const record: KeyRecord = {
      ref,
      issuedAtMs,
      expiresAtMs,
      bytes: owned,
    };
    this.#records.set(ref, record);
    this.#currentRef = ref;

    let released = false;
    const read = (): Uint8Array | undefined => {
      if (released || this.#destroyed) return undefined;
      const value = this.deliver(ref);
      if (value === undefined) released = true;
      return value;
    };
    const release = (): void => {
      if (released) return;
      released = true;
      this.#revoke(ref);
    };
    return Object.freeze({
      ref,
      generation: ref.generation,
      issued_at_ms: issuedAtMs,
      expires_at_ms: expiresAtMs,
      read,
      deliver: read,
      getKeyBytes: read,
      isActive: () => !released && !this.#destroyed && this.#isActive(ref),
      release,
    });
  }

  #isActive(ref: E2eeKeyReference): boolean {
    const record = this.#records.get(ref);
    return record !== undefined
      && finiteTime(this.#nowMs(), 'INVALID_E2EE_CLOCK') < record.expiresAtMs;
  }

  #assertUsable(): void {
    if (this.#destroyed) throw new Error('E2EE_KEY_PROVIDER_DESTROYED');
  }

  #assertReference(ref: E2eeKeyReference): void {
    if (ref === undefined || typeof ref.key_ref !== 'string' || !Number.isSafeInteger(ref.generation)) {
      throw new Error('INVALID_E2EE_KEY_REFERENCE');
    }
  }

  #revoke(ref: E2eeKeyReference): void {
    const record = this.#records.get(ref);
    if (record === undefined) return;
    record.bytes.fill(0);
    this.#records.delete(ref);
    if (this.#currentRef === ref) this.#currentRef = undefined;
  }

  #revokeAll(): void {
    for (const record of this.#records.values()) record.bytes.fill(0);
    this.#records.clear();
    this.#currentRef = undefined;
  }
}

export class E2eeKeyProvider extends InMemoryE2eeKeyProvider {}
export const createE2eeKeyProvider = (
  options: E2eeKeyProviderOptions = {},
): InMemoryE2eeKeyProvider => new InMemoryE2eeKeyProvider(options);
export const createKeyProvider = createE2eeKeyProvider;

/**
 * Shape one lease for the SDK's built-in AES-GCM implementation.  This does
 * not encrypt frames or implement a custom ratchet.
 */
export function createLiveKitEncryptionOptions(
  lease: E2eeKeyLease,
  config: LiveKitEncryptionConfig = {},
): LiveKitEncryptionOptions {
  const sharedKey = lease.read();
  if (sharedKey === undefined) throw new Error('E2EE_KEY_UNAVAILABLE');
  const keyProviderOptions: LiveKitKeyProviderOptions = {
    sharedKey,
    ratchetWindowSize: config.ratchetWindowSize ?? DEFAULT_LIVEKIT_RATCHET_WINDOW_SIZE,
    failureTolerance: config.failureTolerance ?? DEFAULT_LIVEKIT_FAILURE_TOLERANCE,
  };
  const ratchetSalt = cloneOptionalBytes(config.ratchetSalt);
  if (ratchetSalt !== undefined) {
    return Object.freeze({
      encryptionType: LIVEKIT_GCM_ENCRYPTION_TYPE,
      keyProviderOptions: Object.freeze({ ...keyProviderOptions, ratchetSalt }),
    });
  }
  return Object.freeze({
    encryptionType: LIVEKIT_GCM_ENCRYPTION_TYPE,
    keyProviderOptions: Object.freeze(keyProviderOptions),
  });
}

export const toLiveKitEncryptionOptions = createLiveKitEncryptionOptions;
export const toRoomEncryptionOptions = createLiveKitEncryptionOptions;

/** Inject the structural encryption object into caller-owned RoomOptions. */
export function injectLiveKitEncryption<T extends object>(
  roomOptions: T,
  lease: E2eeKeyLease,
  config: LiveKitEncryptionConfig = {},
): T & LiveKitRoomOptionsWithEncryption {
  return {
    ...roomOptions,
    encryption: createLiveKitEncryptionOptions(lease, config),
  } as T & LiveKitRoomOptionsWithEncryption;
}

export const withLiveKitEncryption = injectLiveKitEncryption;

/** Zeroize the mutable SDK options copy after the SDK no longer needs it. */
export function zeroizeLiveKitEncryptionOptions(options: LiveKitEncryptionOptions): void {
  options.keyProviderOptions.sharedKey.fill(0);
  options.keyProviderOptions.ratchetSalt?.fill(0);
}
