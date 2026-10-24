/**
 * Storage-neutral adapter for a compiled T05 memory context.
 *
 * This seam deliberately has no repository, resolver, vector, graph, or
 * Gateway dependency.  It only normalizes the already bounded compiler
 * result for a downstream consumer such as a model-context assembler.
 */

import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
} from './canonical-ref.ts';
import type { AuthorityWatermark } from './domain.ts';
import type {
  CompiledMemoryContext,
} from './context-compiler.ts';

const MEMORY_REF_TYPES = new Set([
  'SemanticFact',
  'EpisodicMemory',
  'PreferenceMemory',
  'OpenLoop',
]);

export interface MemoryConsumerSelection {
  readonly ref: CanonicalObjectVersionRef;
  readonly boundedContent: string;
  /** A deterministic single reason, joined from compiler reasons in order. */
  readonly selectionReason: string;
}

export interface MemoryConsumerSuppression {
  readonly ref?: CanonicalObjectVersionRef;
  readonly suppressionReasons: readonly string[];
}

export interface MemoryConsumerContext {
  readonly memories: readonly MemoryConsumerSelection[];
  readonly suppressions: readonly MemoryConsumerSuppression[];
  readonly authorityWatermark: AuthorityWatermark;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return false;
    const names = Object.getOwnPropertyNames(value);
    const enumerableNames = new Set(Object.keys(value));
    if (names.some((name) => !enumerableNames.has(name))) return false;
    return names.every((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor?.get === undefined && descriptor?.set === undefined;
    });
  } catch {
    return false;
  }
}

function isSafeArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return false;
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === 'length') continue;
      const index = Number(name);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= value.length) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertExactKeys(value: unknown, expected: readonly string[], message: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(message);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(message);
  }
}

/** Clone and freeze JSON-only values so opaque owner state cannot be mutated. */
function cloneStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('authority watermark contains a non-finite number');
    return value;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('authority watermark contains a non-JSON value');
  }
  if (seen.has(value)) throw new TypeError('authority watermark contains a cycle');
  seen.add(value);
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
      throw new TypeError('authority watermark contains a symbol property');
    }
    if (Array.isArray(value)) {
      const ownNames = Object.getOwnPropertyNames(value);
      for (const name of ownNames) {
        if (name === 'length') continue;
        const index = Number(name);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= value.length) {
          throw new TypeError('authority watermark contains an extra array property');
        }
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError('authority watermark contains an array hole');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
          throw new TypeError('authority watermark contains an accessor');
        }
        copy.push(cloneStableJson(value[index], seen));
      }
      return Object.freeze(copy);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('authority watermark contains a non-plain object');
    }
    const names = Object.getOwnPropertyNames(value);
    const enumerableNames = new Set(Object.keys(value));
    if (names.some((name) => !enumerableNames.has(name))) {
      throw new TypeError('authority watermark contains a non-enumerable property');
    }
    const copy: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const name of [...enumerableNames].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
        throw new TypeError('authority watermark contains an accessor');
      }
      Object.defineProperty(copy, name, {
        configurable: true,
        enumerable: true,
        value: cloneStableJson(source[name], seen),
        writable: true,
      });
    }
    return Object.freeze(copy);
  } finally {
    seen.delete(value);
  }
}

function copyMemoryRef(value: unknown): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  if (!MEMORY_REF_TYPES.has(ref.refType)) {
    throw new TypeError('consumer context contains a non-memory reference');
  }
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function normalizeSelection(value: unknown): MemoryConsumerSelection {
  assertExactKeys(value, ['canonicalRef', 'boundedContent', 'selectionReasons'], 'memory selection is malformed');
  const ref = copyMemoryRef(value.canonicalRef);
  if (typeof value.boundedContent !== 'string' || value.boundedContent.trim().length === 0) {
    throw new TypeError('memory selection content is malformed');
  }
  if (!isSafeArray(value.selectionReasons) || value.selectionReasons.length === 0 ||
      !value.selectionReasons.every((reason) => typeof reason === 'string' && reason.length > 0)) {
    throw new TypeError('memory selection reason is malformed');
  }
  const reasons = value.selectionReasons.map((reason) => reason as string);
  return Object.freeze({
    ref,
    boundedContent: value.boundedContent,
    selectionReason: reasons.join('|'),
  });
}

function normalizeSuppression(value: unknown): MemoryConsumerSuppression {
  if (!isPlainRecord(value)) throw new TypeError('memory suppression is malformed');
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'canonicalRef' || key === 'suppressionReasons') ||
      !keys.includes('suppressionReasons')) {
    throw new TypeError('memory suppression contains unexpected fields');
  }
  if (keys.includes('canonicalRef') && value.canonicalRef === undefined) {
    throw new TypeError('memory suppression has an undefined reference');
  }
  const ref = keys.includes('canonicalRef') ? copyMemoryRef(value.canonicalRef) : undefined;
  if (!isSafeArray(value.suppressionReasons) || value.suppressionReasons.length === 0 ||
      !value.suppressionReasons.every((reason) => typeof reason === 'string' && reason.length > 0)) {
    throw new TypeError('memory suppression reasons are malformed');
  }
  const reasons = Object.freeze(value.suppressionReasons.map((reason) => reason as string));
  return ref === undefined
    ? Object.freeze({ suppressionReasons: reasons })
    : Object.freeze({ ref, suppressionReasons: reasons });
}

function refsMatchExactly(
  selected: readonly CanonicalObjectVersionRef[],
  selections: readonly MemoryConsumerSelection[],
): boolean {
  if (selected.length !== selections.length) return false;
  const seen = new Set<string>();
  for (let index = 0; index < selected.length; index += 1) {
    const selectedRef = copyMemoryRef(selected[index]);
    const selection = selections[index];
    if (selection === undefined || canonicalRefKey(selectedRef) !== canonicalRefKey(selection.ref)) return false;
    const key = canonicalRefKey(selectedRef);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Map a compiler result to bounded consumer inputs.  Any malformed or
 * mutated internal result fails closed instead of leaking an unverified ref,
 * content, or watermark downstream.
 */
export function adaptCompiledMemoryContext(
  context: CompiledMemoryContext,
): MemoryConsumerContext {
  assertExactKeys(
    context,
    ['selectedCanonicalRefs', 'selections', 'suppressions', 'authorityWatermark'],
    'compiled memory context is malformed',
  );
  if (!isSafeArray(context.selections) || !isSafeArray(context.selectedCanonicalRefs) ||
      !isSafeArray(context.suppressions)) {
    throw new TypeError('compiled memory context collections are malformed');
  }
  if (context.authorityWatermark === undefined || context.authorityWatermark === null ||
      (typeof context.authorityWatermark === 'string' && context.authorityWatermark.trim().length === 0)) {
    throw new TypeError('compiled memory context watermark is missing');
  }
  const authorityWatermark = cloneStableJson(context.authorityWatermark) as AuthorityWatermark;
  const memories = Object.freeze(context.selections.map((selection) => normalizeSelection(selection)));
  const selectedRefs = Object.freeze(context.selectedCanonicalRefs.map((value) => copyMemoryRef(value)));
  if (!refsMatchExactly(selectedRefs, memories)) {
    throw new TypeError('compiled memory context selected refs do not match selections');
  }
  const suppressions = Object.freeze(context.suppressions.map((item) => normalizeSuppression(item)));
  const selectedKeys = new Set(memories.map((item) => canonicalRefKey(item.ref)));
  const suppressedKeys = new Set<string>();
  for (const suppression of suppressions) {
    if (suppression.ref === undefined) continue;
    const key = canonicalRefKey(suppression.ref);
    if (selectedKeys.has(key) || suppressedKeys.has(key)) {
      throw new TypeError('compiled memory context has conflicting suppression references');
    }
    suppressedKeys.add(key);
  }
  return Object.freeze({ memories, suppressions, authorityWatermark });
}

/** Explicit alias for consumers that prefer a conversion verb. */
export const toMemoryConsumerContext = adaptCompiledMemoryContext;
