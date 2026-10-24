/** T05 context compilation from the repository's authoritative snapshot. */

import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from './canonical-ref.ts';
import type {
  CompilerQuery,
  MemoryKind,
  MemoryVersionRecord,
} from './domain.ts';
import { isCanonicalUtcInstant, isConfidencePpm } from './domain.ts';
import type { MemoryRepository } from './ports.ts';

export type ContextCompilerQuery = CompilerQuery;

export interface ContextSelection {
  readonly canonicalRef: CanonicalObjectVersionRef;
  readonly boundedContent: string;
  readonly selectionReasons: readonly string[];
}

export interface ContextSuppression {
  readonly canonicalRef?: CanonicalObjectVersionRef;
  readonly suppressionReasons: readonly string[];
}

export interface CompiledMemoryContext {
  readonly selectedCanonicalRefs: readonly CanonicalObjectVersionRef[];
  readonly selections: readonly ContextSelection[];
  readonly suppressions: readonly ContextSuppression[];
  readonly authorityWatermark: unknown;
}

export interface ContextCompilerInput {
  readonly repository: MemoryRepository;
  readonly query: ContextCompilerQuery;
}

const MEMORY_REF_TYPE_BY_KIND: Readonly<Record<MemoryKind, CanonicalObjectVersionRef['refType']>> = {
  semantic_fact: 'SemanticFact',
  episodic_memory: 'EpisodicMemory',
  preference_memory: 'PreferenceMemory',
  open_loop: 'OpenLoop',
};
const VALIDITY_KEYS = new Set(['validFrom', 'validTo', 'observedAt']);

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

function frozenArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

/**
 * Copy an owner watermark into a JSON-only, immutable value.  Watermarks are
 * opaque to T05, but they still need a stable runtime representation so a
 * repository cannot mutate the compiler result after it has been selected.
 */
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

function cloneAuthorityWatermark(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new TypeError('authority watermark is empty');
  }
  return cloneStableJson(value);
}

function parseMillis(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function queryTime(query: ContextCompilerQuery): number {
  const value = parseMillis(query.asOf);
  if (value === undefined) throw new TypeError('asOf must be a valid UTC instant');
  return value;
}

function recordRef(record: MemoryVersionRecord): CanonicalObjectVersionRef | undefined {
  try {
    const ref = assertCanonicalObjectVersionRef(record.ref);
    return Object.freeze({
      refType: ref.refType,
      refId: ref.refId,
      objectVersion: ref.objectVersion,
      canonicalPayloadSha256: ref.canonicalPayloadSha256,
    });
  } catch {
    return undefined;
  }
}

function refMatchesMemoryKind(
  record: MemoryVersionRecord,
  ref: CanonicalObjectVersionRef,
): boolean {
  const expected = (MEMORY_REF_TYPE_BY_KIND as Record<string, CanonicalObjectVersionRef['refType'] | undefined>)[
    String(record.kind)
  ];
  return expected !== undefined && ref.refType === expected;
}

function purposeAllowed(record: MemoryVersionRecord, purposeScope: string): boolean {
  return Array.isArray(record.allowedPurposeScopes) &&
    (record.allowedPurposeScopes.includes('*') || record.allowedPurposeScopes.includes(purposeScope));
}

function validityReasons(record: MemoryVersionRecord, now: number): string[] {
  const reasons: string[] = [];
  if (!validityIsValid(record.validity)) return ['invalid_validity'];
  if (record.stale === true) reasons.push('stale');
  const validity = record.validity as { readonly validFrom?: string; readonly validTo?: string };
  const validFrom = parseMillis(validity.validFrom);
  const validTo = parseMillis(validity.validTo);
  if (validFrom !== undefined && validFrom > now) reasons.push('not_yet_valid');
  if (validTo !== undefined && validTo <= now) reasons.push('expired');
  return reasons;
}

function validityIsValid(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => VALIDITY_KEYS.has(key) && isCanonicalUtcInstant(record[key]));
}

function hardFilterReasons(record: MemoryVersionRecord, query: ContextCompilerQuery, now: number): string[] {
  if (!isPlainRecord(record)) return ['invalid_record'];
  const reasons: string[] = [];
  if (record.status !== 'current' || record.current !== true) reasons.push('non_current');
  if (record.status === 'deleted' || record.deletedAt !== undefined) reasons.push('deleted');
  if (record.status === 'suppressed' || record.suppressedAt !== undefined) reasons.push('suppressed');
  if (record.status === 'superseded') reasons.push('superseded');
  if (record.status === 'disputed') reasons.push('disputed');
  reasons.push(...validityReasons(record, now));
  if (record.userId !== query.userId) reasons.push('user_mismatch');
  if (!purposeAllowed(record, query.purposeScope)) reasons.push('purpose_not_allowed');
  if (!isPlainRecord(record.sensitivity) ||
      (record.sensitivity.classification !== 'normal' && record.sensitivity.classification !== 'sensitive') ||
      typeof record.sensitivity.userConfirmed !== 'boolean') {
    reasons.push('invalid_sensitivity');
  } else if (record.sensitivity.classification === 'sensitive' && !record.sensitivity.userConfirmed) {
    reasons.push('sensitive_unconfirmed');
  }
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0 ||
      !record.evidenceRefs.every(isCanonicalObjectVersionRef)) reasons.push('invalid_evidence_ref');
  if (!isConfidencePpm(record.confidencePpm)) reasons.push('invalid_confidence');
  if (query.slot !== undefined && record.slot !== query.slot) reasons.push('slot_not_requested');
  if (query.slots !== undefined && !query.slots.includes(record.slot)) reasons.push('slot_not_requested');
  if (query.kind !== undefined && record.kind !== query.kind) reasons.push('kind_not_requested');
  if (query.kinds !== undefined && !query.kinds.includes(record.kind)) reasons.push('kind_not_requested');
  if (typeof record.resolvedContent !== 'string' || record.resolvedContent.trim().length === 0) {
    reasons.push('missing_bounded_content');
  }
  return [...new Set(reasons)];
}

function suppression(canonicalRef: CanonicalObjectVersionRef | undefined, reasons: readonly string[]): ContextSuppression {
  const frozenReasons = frozenArray([...new Set(reasons)]);
  return canonicalRef === undefined
    ? Object.freeze({ suppressionReasons: frozenReasons })
    : Object.freeze({ canonicalRef, suppressionReasons: frozenReasons });
}

function emptyContext(
  records: readonly MemoryVersionRecord[],
  reason: string,
  authorityWatermark: unknown,
): CompiledMemoryContext {
  return Object.freeze({
    selectedCanonicalRefs: frozenArray([]),
    selections: frozenArray([]),
    suppressions: frozenArray(records.map((record) => suppression(recordRef(record), [reason]))),
    authorityWatermark,
  });
}

function assertCompilerQuery(query: ContextCompilerQuery): void {
  if (query.userId.trim().length === 0) throw new TypeError('userId is required');
  if (query.purposeScope.trim().length === 0) throw new TypeError('purposeScope is required');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/.test(query.asOf)) {
    throw new TypeError('asOf must be a canonical UTC instant');
  }
  queryTime(query);
  if (!Number.isSafeInteger(query.maxItems) || query.maxItems < 0) {
    throw new TypeError('maxItems must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(query.maxContentBytes) || query.maxContentBytes < 0) {
    throw new TypeError('maxContentBytes must be a nonnegative safe integer');
  }
}

/**
 * Compile only from `MemoryRepository.loadCompilerSnapshot`.  Promise values
 * are intentionally part of the port so a caller cannot accidentally use a
 * cache/vector result as authority.
 */
export async function compileMemoryContext(
  repository: MemoryRepository,
  query: ContextCompilerQuery,
): Promise<CompiledMemoryContext>;
export async function compileMemoryContext(
  input: ContextCompilerInput,
): Promise<CompiledMemoryContext>;
export async function compileMemoryContext(
  repositoryOrInput: MemoryRepository | ContextCompilerInput,
  maybeQuery?: ContextCompilerQuery,
): Promise<CompiledMemoryContext> {
  const repository = maybeQuery === undefined
    ? (repositoryOrInput as ContextCompilerInput).repository
    : repositoryOrInput as MemoryRepository;
  const query = maybeQuery === undefined
    ? (repositoryOrInput as ContextCompilerInput).query
    : maybeQuery;
  assertCompilerQuery(query);
  const snapshot = await repository.loadCompilerSnapshot(query);
  if (snapshot.query.userId !== query.userId ||
      snapshot.query.purposeScope !== query.purposeScope ||
      snapshot.query.asOf !== query.asOf) {
    throw new TypeError('repository returned a snapshot for a different compiler scope');
  }
  if (!Array.isArray(snapshot.records)) {
    throw new TypeError('repository returned malformed authority records');
  }
  const records = snapshot.records;
  let authorityWatermark: unknown;
  try {
    authorityWatermark = cloneAuthorityWatermark(snapshot.authorityWatermark);
  } catch {
    return emptyContext(records, 'invalid_authority_watermark', undefined);
  }
  if (snapshot.authorityWatermark === undefined || snapshot.authorityWatermark === null) {
    return emptyContext(records, 'missing_authority_watermark', authorityWatermark);
  }
  const normalizedRecordRefs = records.map((record) => recordRef(record));
  const seenRecordRefs = new Set<string>();
  const duplicateRecordRefs = new Set<string>();
  for (const ref of normalizedRecordRefs) {
    if (ref === undefined) continue;
    const key = canonicalRefKey(ref);
    if (seenRecordRefs.has(key)) duplicateRecordRefs.add(key);
    seenRecordRefs.add(key);
  }
  if (duplicateRecordRefs.size > 0) {
    return Object.freeze({
      selectedCanonicalRefs: frozenArray([]),
      selections: frozenArray([]),
      suppressions: frozenArray(records.map((record, index) => {
        const ref = normalizedRecordRefs[index];
        return suppression(ref, ref !== undefined && duplicateRecordRefs.has(canonicalRefKey(ref))
          ? ['duplicate_canonical_ref']
          : ['authority_snapshot_duplicate_ref']);
      })),
      authorityWatermark,
    });
  }
  const now = queryTime(query);
  const ranked: Array<{ readonly selection: ContextSelection; readonly score: number }> = [];
  const suppressions: ContextSuppression[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const ref = recordRef(record);
    const reasons = hardFilterReasons(record, query, now);
    if (ref === undefined) reasons.push('missing_or_invalid_canonical_ref');
    if (ref !== undefined && !refMatchesMemoryKind(record, ref)) reasons.push('ref_kind_mismatch');
    if (reasons.length > 0 || ref === undefined) {
      suppressions.push(suppression(ref, reasons));
      continue;
    }

    const key = canonicalRefKey(ref);
    if (seen.has(key)) {
      suppressions.push(suppression(ref, ['duplicate_canonical_ref']));
      continue;
    }
    seen.add(key);
    if (typeof record.resolvedContent !== 'string') {
      suppressions.push(suppression(ref, ['missing_bounded_content']));
      continue;
    }
    ranked.push({
      selection: Object.freeze({
        canonicalRef: ref,
        boundedContent: record.resolvedContent,
        selectionReasons: frozenArray(['eligible_current', 'user_match', 'purpose_allowed']),
      }),
      score: typeof record.derivedRankScore === 'number' && Number.isFinite(record.derivedRankScore)
        ? record.derivedRankScore
        : 0,
    });
  }

  ranked.sort((left, right) => {
    return right.score - left.score ||
      compareCanonicalObjectVersionRefs(left.selection.canonicalRef, right.selection.canonicalRef);
  });
  const bounded: ContextSelection[] = [];
  let usedContentBytes = 0;
  for (const item of ranked) {
    if (bounded.length >= query.maxItems) {
      suppressions.push(suppression(item.selection.canonicalRef, ['max_items']));
      continue;
    }
    const bytes = Buffer.byteLength(item.selection.boundedContent, 'utf8');
    if (usedContentBytes + bytes > query.maxContentBytes) {
      suppressions.push(suppression(item.selection.canonicalRef, ['content_budget']));
      continue;
    }
    bounded.push(item.selection);
    usedContentBytes += bytes;
  }

  return Object.freeze({
    selectedCanonicalRefs: frozenArray(bounded.map((selection) => selection.canonicalRef)),
    selections: frozenArray(bounded),
    suppressions: frozenArray(suppressions),
    authorityWatermark,
  });
}
