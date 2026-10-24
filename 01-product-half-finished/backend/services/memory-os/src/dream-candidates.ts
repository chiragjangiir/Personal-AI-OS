/**
 * Dream is an extractor-to-candidate boundary. It never accepts a durable
 * memory, opens a loop, grants a permission, or performs an effect.
 */

import {
  admitMemoryProposal,
  type AdmittedMemoryCandidateIntent,
  type AdmissionDisposition,
  type MemoryAdmissionProposal,
} from './admission.ts';
import {
  canonicalRefKey,
  isCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from './canonical-ref.ts';
import type { MemoryCandidateProposal } from './domain.ts';

export interface DreamWindow {
  readonly from: string | Date;
  readonly to: string | Date;
}

/** Optional extractor annotations are intentionally closed to Dream policy. */
export type DreamExtractorProposal = MemoryCandidateProposal & {
  readonly idempotencyKey?: string;
  readonly occurredAt?: string | Date;
  readonly externalInstruction?: boolean;
  readonly identityInference?: boolean;
  readonly reminder?: boolean;
  readonly toolPermission?: boolean;
  readonly sideEffect?: boolean;
};

export interface DreamCandidateBatchInput {
  readonly window: DreamWindow;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly proposals: readonly DreamExtractorProposal[];
  readonly modelConfidenceThresholdPpm?: number;
}

export interface DreamDisposition extends AdmissionDisposition {
  readonly proposalId: string;
}

export interface DreamCandidateBatch {
  readonly kind: 'MemoryCandidateBatch';
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly window: Readonly<{ from: string; to: string }> | null;
  readonly candidates: readonly AdmittedMemoryCandidateIntent[];
  readonly rejected: readonly DreamDisposition[];
  readonly quarantined: readonly DreamDisposition[];
}

const DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM = 900_000;
const SOURCE_CLASSES = new Set([
  'explicit_user_correction',
  'explicit_user_preference',
  'repeated_behavior',
  'model_inference',
]);
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/;

function parseMillis(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function isoTime(value: string | Date): string | undefined {
  if (typeof value === 'string' && !CANONICAL_INSTANT_PATTERN.test(value)) return undefined;
  const time = parseMillis(value);
  return time === undefined ? undefined : new Date(time).toISOString();
}

function stableValue(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return `[${typeof value}]`;
    }
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = `[${value.map((item) => stableValue(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }

  let prototype: object | null;
  let keys: string[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Object.keys(value);
  } catch {
    seen.delete(value);
    return '[OpaqueObject]';
  }
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return '[NonPlainObject]';
  }

  const parts: string[] = [];
  for (const key of keys.sort()) {
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      child = '[Unreadable]';
    }
    parts.push(`${JSON.stringify(key)}:${stableValue(child, seen)}`);
  }
  seen.delete(value);
  return `{${parts.join(',')}}`;
}

function windowValue(window: DreamWindow): Readonly<{ from: string; to: string }> | null {
  const from = isoTime(window.from);
  const to = isoTime(window.to);
  if (from === undefined || to === undefined) return null;
  // Dream windows are UTC half-open intervals.  A zero-length window is not
  // a daily run and must not be allowed to admit a candidate at its boundary.
  if ((parseMillis(from) ?? Number.NaN) >= (parseMillis(to) ?? Number.NaN)) return null;
  return { from, to };
}

function proposalTimestamp(proposal: DreamExtractorProposal): unknown {
  return proposal.occurredAt ?? proposal.validity.observedAt;
}

function outsideWindow(proposal: DreamExtractorProposal, window: Readonly<{ from: string; to: string }>): boolean {
  const timestamp = proposalTimestamp(proposal);
  if (timestamp === undefined) return false;
  const observed = parseMillis(timestamp);
  if (observed === undefined) return true;
  const windowStart = parseMillis(window.from) ?? Number.POSITIVE_INFINITY;
  const windowEnd = parseMillis(window.to) ?? Number.NEGATIVE_INFINITY;
  // `to` is exclusive: a proposal exactly at the end belongs to the next
  // window, never to this Dream batch.
  if (observed < windowStart || observed >= windowEnd) return true;
  const validityStart = parseMillis(proposal.validity.validFrom);
  const validityEnd = parseMillis(proposal.validity.validTo);
  return (validityStart !== undefined && validityStart >= windowEnd) ||
    (validityEnd !== undefined && validityEnd <= windowStart);
}

function proposalIdempotencyKey(proposal: DreamExtractorProposal): string | undefined {
  return typeof proposal.idempotencyKey === 'string' && proposal.idempotencyKey.trim().length > 0
    ? proposal.idempotencyKey.trim()
    : undefined;
}

function canonicalRefOnly(ref: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  const validated = isCanonicalObjectVersionRef(ref) ? ref : undefined;
  if (validated === undefined) throw new TypeError('invalid canonical evidence reference');
  return {
    refType: validated.refType,
    refId: validated.refId,
    objectVersion: validated.objectVersion,
    canonicalPayloadSha256: validated.canonicalPayloadSha256,
  };
}

const FORBIDDEN_EFFECT_KEYS = new Set([
  'reminder',
  'toolpermission',
  'sideeffect',
  'tool',
  'effects',
  'requestedeffects',
]);

function dangerousEffectValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    try {
      return Object.keys(value).length > 0;
    } catch {
      return true;
    }
  }
  return true;
}

function valueContainsForbiddenEffect(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    const forbidden = value.some((item) => valueContainsForbiddenEffect(item, seen));
    seen.delete(value);
    return forbidden;
  }

  let prototype: object | null;
  let keys: string[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Object.keys(value);
  } catch {
    seen.delete(value);
    return true;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }

  for (const key of keys) {
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      seen.delete(value);
      return true;
    }
    if (FORBIDDEN_EFFECT_KEYS.has(key.toLowerCase()) && dangerousEffectValue(child)) {
      seen.delete(value);
      return true;
    }
    if (valueContainsForbiddenEffect(child, seen)) {
      seen.delete(value);
      return true;
    }
  }
  seen.delete(value);
  return false;
}

function disposition(
  proposalId: string,
  status: 'reject' | 'quarantine',
  reasonCode: string,
  reason: string,
): DreamDisposition {
  return { proposalId, status, kind: status, reasonCode, reason };
}

function kindForbidden(proposal: DreamExtractorProposal): boolean {
  // `kind` classifies the candidate for later admission.  It must not be
  // emitted as a direct durable SemanticFact/EpisodicMemory/etc. object;
  // that boundary is enforced by the candidate intent shape below.
  return proposal.intent.kind !== 'create' ||
    proposal.reminder === true ||
    proposal.toolPermission === true ||
    proposal.sideEffect === true ||
    valueContainsForbiddenEffect(proposal.value);
}

function acceptedRefsOnly(
  refs: readonly CanonicalObjectVersionRef[],
  accepted: ReadonlySet<string>,
): boolean {
  return refs.length > 0 && refs.every((ref) => isCanonicalObjectVersionRef(ref) && accepted.has(canonicalRefKey(ref)));
}

function admissionProposal(
  proposal: DreamExtractorProposal,
  idempotencyKey: string,
): MemoryAdmissionProposal {
  return {
    ...proposal,
    idempotencyKey,
    memoryKind: proposal.kind,
    slot: proposal.slot,
    value: proposal.value,
    sourceClass: proposal.sourceClass,
    evidenceRefs: proposal.evidenceRefs.map(canonicalRefOnly),
    confidencePpm: proposal.confidencePpm,
    ...(proposal.externalInstruction === undefined ? {} : { externalInstruction: proposal.externalInstruction }),
    ...(proposal.identityInference === undefined ? {} : { identityInference: proposal.identityInference }),
  };
}

function isAdmissionDisposition(value: AdmissionDisposition | { readonly status: 'candidate' }): value is AdmissionDisposition {
  return value.status !== 'candidate';
}

/**
 * Build deterministic T05 MemoryCandidate intents from one explicit Dream
 * window and one accepted-delta reference set.
 */
export function buildDreamCandidateBatch(input: DreamCandidateBatchInput): DreamCandidateBatch {
  const window = windowValue(input.window);
  const rejected: DreamDisposition[] = [];
  const quarantined: DreamDisposition[] = [];
  const candidates: AdmittedMemoryCandidateIntent[] = [];

  let accepted = new Set<string>();
  try {
    accepted = new Set(input.acceptedDeltaRefs.map((ref) => canonicalRefKey(ref)));
  } catch {
    // Every proposal is rejected below when the accepted-delta boundary is invalid.
  }

  const seen = new Map<string, string>();
  const proposals = input.proposals.slice().sort((left, right) => {
    const leftKey = `${left.proposalId}:${proposalIdempotencyKey(left) ?? ''}`;
    const rightKey = `${right.proposalId}:${proposalIdempotencyKey(right) ?? ''}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const batchValid = typeof input.batchId === 'string' && input.batchId.trim().length > 0 &&
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim().length > 0;

  for (const proposal of proposals) {
    const proposalId = proposal.proposalId;
    const proposalKey = proposalIdempotencyKey(proposal);
    if (!batchValid) {
      rejected.push(disposition(proposalId, 'reject', 'INVALID_BATCH_IDEMPOTENCY', 'batchId and idempotencyKey are required'));
      continue;
    }
    if (typeof proposalId !== 'string' || proposalId.trim().length === 0) {
      rejected.push(disposition(proposalId, 'reject', 'MISSING_PROPOSAL_ID', 'each proposal requires a stable proposalId'));
      continue;
    }
    if (proposalKey === undefined) {
      rejected.push(disposition(proposalId, 'reject', 'MISSING_IDEMPOTENCY_KEY', 'each proposal requires a stable idempotencyKey'));
      continue;
    }

    const identity = `${proposalId}\u0000${proposalKey}`;
    const fingerprint = stableValue(proposal);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      rejected.push(disposition(
        proposalId,
        'reject',
        previous === fingerprint ? 'DUPLICATE_PROPOSAL' : 'DUPLICATE_PROPOSAL_IDENTITY_CONFLICT',
        previous === fingerprint ? 'duplicate proposal is idempotently ignored' : 'proposal identity was reused with different content',
      ));
      continue;
    }
    seen.set(identity, fingerprint);

    if (window === null) {
      rejected.push(disposition(proposalId, 'reject', 'INVALID_WINDOW', 'Dream requires a finite ordered window'));
      continue;
    }
    if (!acceptedRefsOnly(proposal.evidenceRefs, accepted)) {
      rejected.push(disposition(proposalId, 'reject', 'UNACCEPTED_EVIDENCE_REF', 'every evidenceRef must belong to acceptedDeltaRefs'));
      continue;
    }
    if (outsideWindow(proposal, window)) {
      rejected.push(disposition(proposalId, 'reject', 'OUT_OF_WINDOW', 'proposal evidence time is outside the Dream window'));
      continue;
    }
    if (!SOURCE_CLASSES.has(proposal.sourceClass)) {
      rejected.push(disposition(proposalId, 'reject', 'INVALID_SOURCE_CLASS', 'sourceClass must be a governed admission source'));
      continue;
    }
    if (kindForbidden(proposal)) {
      rejected.push(disposition(proposalId, 'reject', 'FORBIDDEN_MEMORY_OR_EFFECT', 'Dream may emit only MemoryCandidate intents'));
      continue;
    }
    if (proposal.externalInstruction === true) {
      quarantined.push(disposition(proposalId, 'quarantine', 'EXTERNAL_INSTRUCTION', 'external instructions cannot become memory'));
      continue;
    }
    if (proposal.identityInference === true) {
      quarantined.push(disposition(proposalId, 'quarantine', 'IDENTITY_INFERENCE', 'identity inference requires quarantine'));
      continue;
    }

    const threshold = input.modelConfidenceThresholdPpm ?? DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1_000_000) {
      rejected.push(disposition(proposalId, 'reject', 'INVALID_CONFIDENCE_THRESHOLD', 'confidence threshold must use ppm'));
      continue;
    }
    if (!Number.isInteger(proposal.confidencePpm) || proposal.confidencePpm < 0 || proposal.confidencePpm > 1_000_000) {
      rejected.push(disposition(proposalId, 'reject', 'INVALID_CONFIDENCE', 'confidencePpm must be an integer from 0 to 1000000'));
      continue;
    }
    if (proposal.confidencePpm < threshold) {
      quarantined.push(disposition(proposalId, 'quarantine', 'LOW_CONFIDENCE', `confidencePpm is below ${threshold}`));
      continue;
    }

    const admitted = admitMemoryProposal(admissionProposal(proposal, proposalKey), {
      modelConfidenceThresholdPpm: threshold,
    });
    if (isAdmissionDisposition(admitted)) {
      const target = admitted.status === 'quarantine' ? quarantined : rejected;
      target.push(disposition(proposalId, admitted.status, admitted.reasonCode, admitted.reason));
      continue;
    }
    candidates.push(admitted.intent);
  }

  return {
    kind: 'MemoryCandidateBatch',
    batchId: input.batchId,
    idempotencyKey: input.idempotencyKey,
    window,
    candidates,
    rejected,
    quarantined,
  };
}
