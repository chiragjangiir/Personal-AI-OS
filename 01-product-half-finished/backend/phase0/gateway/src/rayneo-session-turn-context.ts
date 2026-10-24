const MAX_TURNS = 8;
const MAX_TURN_BYTES = 512;
const MAX_RENDERED_BYTES = 4096;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1_000;
const CONVERSATION_MAX_ENTRIES = 32;

export interface RayneoSessionTurnInput {
  readonly source: 'visual' | 'realtime';
  readonly speakerLabel?: string;
  readonly transcript?: string;
  readonly reply: string;
}

export interface RayneoSessionTurnContextOptions {
  /** Called only after a new turn has been accepted. */
  readonly onAppend?: () => void;
  /** Media cleanup may call close without deleting this retained context. */
  readonly retainOnClose?: boolean;
}

interface StoredTurn {
  readonly key: string;
  readonly source: RayneoSessionTurnInput['source'];
  readonly rendered: string;
}

function normalize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let result = '';
  let size = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (size + characterBytes > maximumBytes) break;
    result += character;
    size += characterBytes;
  }
  return result;
}

function render(input: RayneoSessionTurnInput): string {
  const reply = normalize(input.reply);
  if (input.source === 'visual') return truncateUtf8(`视觉回复：${reply}`, MAX_TURN_BYTES);
  const speaker = normalize(input.speakerLabel ?? '未知发言者');
  const transcript = normalize(input.transcript ?? '');
  return truncateUtf8(`[${speaker}] ${transcript} 回复：${reply}`, MAX_TURN_BYTES);
}

/** Memory-only bounded context. Keys are never rendered. */
export class RayneoSessionTurnContext {
  readonly #turns: StoredTurn[] = [];
  readonly #keys = new Set<string>();
  readonly #onAppend: (() => void) | undefined;
  readonly #retainOnClose: boolean;
  #closed = false;

  constructor(options: RayneoSessionTurnContextOptions = {}) {
    this.#onAppend = options.onAppend;
    this.#retainOnClose = options.retainOnClose === true;
  }

  get closed(): boolean { return this.#closed; }

  get turnCount(): number { return this.#turns.length; }

  get renderedBytes(): number { return Buffer.byteLength(this.snapshot(), 'utf8'); }

  append(key: string, input: RayneoSessionTurnInput): boolean {
    if (this.#closed || key.length === 0 || this.#keys.has(key)) return false;
    const rendered = render(input);
    if (rendered.length === 0) return false;
    this.#turns.push({ key, source: input.source, rendered });
    this.#keys.add(key);
    while (this.#turns.length > MAX_TURNS || this.renderedBytes > MAX_RENDERED_BYTES) {
      const removed = this.#turns.shift();
      if (removed !== undefined) this.#keys.delete(removed.key);
    }
    try { this.#onAppend?.(); } catch { /* activity tracking is best effort */ }
    return true;
  }

  appendVisual(key: string, reply: string): boolean {
    return this.append(key, { source: 'visual', reply });
  }

  appendRealtime(key: string, speakerLabel: string, transcript: string, reply: string): boolean {
    return this.append(key, { source: 'realtime', speakerLabel, transcript, reply });
  }

  snapshot(): string {
    return this.#turns.map((turn) => turn.rendered).join('\n');
  }

  hasRealtimeTurn(): boolean {
    return this.#turns.some((turn) => turn.source === 'realtime');
  }

  close(): void {
    if (this.#retainOnClose) return;
    this.dispose();
  }

  /** Permanently clears a retained context when its registry entry is evicted. */
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#turns.length = 0;
    this.#keys.clear();
  }
}

export const RAYNEO_SESSION_TURN_CONTEXT_LIMITS = Object.freeze({
  maxTurns: MAX_TURNS,
  maxTurnBytes: MAX_TURN_BYTES,
  maxRenderedBytes: MAX_RENDERED_BYTES,
});

export const RAYNEO_CONVERSATION_LIMITS = Object.freeze({
  ttlMs: CONVERSATION_TTL_MS,
  maxEntries: CONVERSATION_MAX_ENTRIES,
});

interface ConversationEntry {
  readonly context: RayneoSessionTurnContext;
  lastActivityAt: number;
  expiresAt: number;
}

export interface RayneoConversationRegistryOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/** Stable-device keyed, bounded, in-memory conversation continuity. */
export class RayneoConversationRegistry {
  readonly #entries = new Map<string, ConversationEntry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(options: RayneoConversationRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CONVERSATION_TTL_MS;
    this.#maxEntries = options.maxEntries ?? CONVERSATION_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new Error('RAYNEO_CONVERSATION_LIMITS_INVALID');
    }
  }

  get size(): number { return this.#entries.size; }

  acquire(deviceId: string, atMs = this.#now()): RayneoSessionTurnContext {
    if (deviceId.length === 0) throw new Error('RAYNEO_CONVERSATION_DEVICE_INVALID');
    this.prune(atMs);
    const existing = this.#entries.get(deviceId);
    if (existing !== undefined) {
      existing.lastActivityAt = atMs;
      existing.expiresAt = atMs + this.#ttlMs;
      return existing.context;
    }
    while (this.#entries.size >= this.#maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#entries) {
        if (entry.lastActivityAt < oldestAt) {
          oldestKey = key;
          oldestAt = entry.lastActivityAt;
        }
      }
      if (oldestKey === undefined) break;
      this.remove(oldestKey);
    }
    const context = new RayneoSessionTurnContext({
      retainOnClose: true,
      onAppend: () => { this.touch(deviceId); },
    });
    this.#entries.set(deviceId, {
      context,
      lastActivityAt: atMs,
      expiresAt: atMs + this.#ttlMs,
    });
    return context;
  }

  touch(deviceId: string, atMs = this.#now()): void {
    const entry = this.#entries.get(deviceId);
    if (entry === undefined) return;
    if (atMs >= entry.expiresAt) {
      this.remove(deviceId);
      return;
    }
    entry.lastActivityAt = atMs;
    entry.expiresAt = atMs + this.#ttlMs;
  }

  prune(atMs = this.#now()): void {
    for (const [deviceId, entry] of this.#entries) {
      if (atMs >= entry.expiresAt) this.remove(deviceId);
    }
  }

  has(deviceId: string, atMs = this.#now()): boolean {
    this.prune(atMs);
    return this.#entries.has(deviceId);
  }

  remove(deviceId: string): boolean {
    const entry = this.#entries.get(deviceId);
    if (entry === undefined) return false;
    this.#entries.delete(deviceId);
    entry.context.dispose();
    return true;
  }

  clear(): void {
    for (const deviceId of this.#entries.keys()) this.remove(deviceId);
  }
}
