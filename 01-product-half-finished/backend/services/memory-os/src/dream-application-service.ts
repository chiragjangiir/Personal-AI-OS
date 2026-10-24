import { createHash } from "node:crypto";

import { DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM } from "./admission.ts";
import {
  buildDreamCandidateBatch,
  type DreamCandidateBatch,
  type DreamDisposition,
  type DreamExtractorProposal,
} from "./dream-candidates.ts";
import {
  assertCanonicalUtcInstant,
  compareCanonicalUtcInstants,
  createCanonicalUtcWindow,
  isCanonicalUtcInstant,
  type AcceptedDreamDeltaCursor,
  type AcceptedDreamDeltaPage,
  type AcceptedDreamDeltaRecord,
  type AuthorityWatermark,
  type CanonicalUtcWindow,
  type MemoryCommandError,
  type MemoryCommandResult,
  type MemoryCommitReceipt,
  type ReadonlyJsonValue,
} from "./domain.ts";
import type {
  AcceptedDreamDeltaReader,
  MemoryCommandRepository,
} from "./ports.ts";
import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";

/** A bounded page prevents an application call from becoming an unbounded Dream run. */
export const DEFAULT_DREAM_DELTA_PAGE_LIMIT = 1_000;
export const MAX_DREAM_DELTA_PAGE_LIMIT = 10_000;

export interface DreamApplicationInput {
  readonly userId: string;
  readonly window: {
    readonly from: unknown;
    readonly to: unknown;
  };
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly cursor?: AcceptedDreamDeltaCursor;
  readonly limit?: number;
  readonly modelConfidenceThresholdPpm?: number;
}

/**
 * The extractor receives only a sanitized accepted-delta projection.  It does
 * not receive the reader, cursor, watermark, or any caller-provided accepted
 * reference set, and therefore cannot widen the authority boundary.
 */
export interface DreamExtractorDelta {
  readonly ref: CanonicalObjectVersionRef;
  readonly delta: ReadonlyJsonValue;
  readonly sourceRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedAt: string;
}

export interface DreamExtractorInput {
  readonly userId: string;
  readonly window: CanonicalUtcWindow;
  readonly deltas: readonly DreamExtractorDelta[];
}

export interface DreamApplicationExtractor {
  extract(input: DreamExtractorInput): Promise<readonly DreamExtractorProposal[]>;
}

export interface DreamApplicationServiceOptions {
  readonly reader: AcceptedDreamDeltaReader;
  readonly extractor: DreamApplicationExtractor;
  readonly commandRepository: MemoryCommandRepository;
}

export interface DreamReadReceipt {
  readonly kind: "dream_read_receipt";
  readonly userId: string;
  readonly window: CanonicalUtcWindow;
  /** Only refs returned by the owner reader are echoed here. */
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  /** Only the owner reader may provide this watermark. */
  readonly authorityWatermark: AuthorityWatermark;
  /** Only the owner reader may provide this cursor. */
  readonly nextCursor?: AcceptedDreamDeltaCursor;
}

export interface DreamApplicationResultBase {
  readonly kind: "dream_application_result";
  readonly userId: string;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly window: CanonicalUtcWindow;
  readonly fingerprint: Sha256;
  readonly batch: DreamCandidateBatch;
}

export type DreamApplicationResult =
  | (DreamApplicationResultBase & {
      readonly outcome: "no_candidates";
      readonly readReceipt: DreamReadReceipt;
    })
  | (DreamApplicationResultBase & {
      readonly outcome: "committed" | "replayed";
      readonly readReceipt: DreamReadReceipt;
      /** New canonical refs are copied only from the repository receipt. */
      readonly commitReceipt: MemoryCommitReceipt;
    })
  | (DreamApplicationResultBase & {
      readonly outcome: "commit_rejected";
      readonly readReceipt: Omit<DreamReadReceipt, "nextCursor">;
      readonly error: MemoryCommandError;
    });

export type DreamApplicationErrorCode =
  | "INVALID_REQUEST"
  | "READER_FAILED"
  | "READER_CONTRACT_VIOLATION"
  | "EXTRACTOR_FAILED"
  | "EXTRACTOR_CONTRACT_VIOLATION"
  | "FINGERPRINT_FAILED"
  | "ADMISSION_FAILED"
  | "COMMIT_FAILED";

export class DreamApplicationError extends Error {
  readonly code: DreamApplicationErrorCode;
  readonly causeValue: unknown;

  constructor(code: DreamApplicationErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.name = "DreamApplicationError";
    this.code = code;
    this.causeValue = causeValue;
  }
}

interface NormalizedReaderPage {
  readonly records: readonly AcceptedDreamDeltaRecord[];
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly acceptedEvidenceRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
  readonly nextCursor?: AcceptedDreamDeltaCursor;
}

interface BoundaryValidation {
  readonly accepted: readonly DreamExtractorProposal[];
  readonly rejected: readonly DreamDisposition[];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyRef(value: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function copyRefs(values: readonly CanonicalObjectVersionRef[]): readonly CanonicalObjectVersionRef[] {
  const refs = values.map(copyRef);
  const keys = refs.map(canonicalRefKey);
  if (new Set(keys).size !== keys.length) {
    throw new DreamApplicationError(
      "READER_CONTRACT_VIOLATION",
      "accepted-delta references must be unique within one record",
    );
  }
  return Object.freeze(refs.sort(compareCanonicalObjectVersionRefs));
}

function assertLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_DREAM_DELTA_PAGE_LIMIT) {
    throw new DreamApplicationError(
      "INVALID_REQUEST",
      `limit must be an integer in [1, ${MAX_DREAM_DELTA_PAGE_LIMIT}]`,
    );
  }
  return value as number;
}

function effectiveThreshold(value: unknown): number {
  if (value === undefined) return DEFAULT_MODEL_CONFIDENCE_THRESHOLD_PPM;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new DreamApplicationError(
      "INVALID_REQUEST",
      "modelConfidenceThresholdPpm must be an integer from 0 to 1000000",
    );
  }
  return value as number;
}

function normalizeInput(input: DreamApplicationInput): {
  readonly userId: string;
  readonly window: CanonicalUtcWindow;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly cursor?: AcceptedDreamDeltaCursor;
  readonly limit: number;
  readonly modelConfidenceThresholdPpm: number;
} {
  if (!isRecord(input) || !nonEmpty(input.userId) || !nonEmpty(input.batchId) || !nonEmpty(input.idempotencyKey)) {
    throw new DreamApplicationError(
      "INVALID_REQUEST",
      "userId, batchId, and idempotencyKey must be non-empty strings",
    );
  }
  let window: CanonicalUtcWindow;
  try {
    window = createCanonicalUtcWindow(input.window);
  } catch (error) {
    throw new DreamApplicationError("INVALID_REQUEST", "window must be a strict UTC half-open boundary", error);
  }
  const threshold = effectiveThreshold(input.modelConfidenceThresholdPpm);
  const cursor = normalizeInputCursor(input.cursor);
  const normalized = {
    userId: input.userId.trim(),
    window,
    batchId: input.batchId.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
    ...(cursor === undefined ? {} : { cursor }),
    limit: assertLimit(input.limit ?? DEFAULT_DREAM_DELTA_PAGE_LIMIT),
    modelConfidenceThresholdPpm: threshold,
  };
  return normalized;
}

function normalizeInputCursor(value: unknown): AcceptedDreamDeltaCursor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !nonEmpty(value.token)) {
    throw new DreamApplicationError("INVALID_REQUEST", "cursor.token must be non-empty");
  }
  if (!isOpaqueWatermark(value.authorityWatermark)) {
    throw new DreamApplicationError("INVALID_REQUEST", "cursor.authorityWatermark is missing or invalid");
  }
  return value as unknown as AcceptedDreamDeltaCursor;
}

function withinHalfOpenWindow(value: string, window: CanonicalUtcWindow): boolean {
  const instant = assertCanonicalUtcInstant(value);
  return compareCanonicalUtcInstants(instant, window.from) >= 0 &&
    compareCanonicalUtcInstants(instant, window.to) < 0;
}

function cloneJsonValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): ReadonlyJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("delta contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("delta contains a cycle");
    ancestors.add(value);
    const result = value.map((item) => cloneJsonValue(item, ancestors));
    ancestors.delete(value);
    return Object.freeze(result);
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("delta is not JSON-compatible");
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    throw new TypeError("delta prototype is unreadable", { cause: error });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("delta must contain only plain objects");
  }
  if (ancestors.has(value)) throw new TypeError("delta contains a cycle");
  ancestors.add(value);
  const result: Record<string, ReadonlyJsonValue> = {};
  try {
    for (const key of Object.keys(value).sort()) {
      result[key] = cloneJsonValue((value as Record<string, unknown>)[key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
  return Object.freeze(result);
}

function isOpaqueWatermark(value: unknown): boolean {
  if (value === null || value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return false;
  }
  try {
    stableSerialize(value);
    return true;
  } catch (error) {
    return false;
  }
}

function assertOpaqueWatermark(value: unknown, field: string): void {
  if (!isOpaqueWatermark(value)) {
    throw new DreamApplicationError("READER_CONTRACT_VIOLATION", `${field} is missing or not stably serializable`);
  }
}

function assertCursorMatchesWatermark(
  cursor: AcceptedDreamDeltaCursor,
  authorityWatermark: AuthorityWatermark,
): void {
  if (!isRecord(cursor) || !nonEmpty(cursor.token)) {
    throw new DreamApplicationError("READER_CONTRACT_VIOLATION", "nextCursor.token must be non-empty");
  }
  assertOpaqueWatermark(cursor.authorityWatermark, "nextCursor.authorityWatermark");
  try {
    if (stableSerialize(cursor.authorityWatermark) !== stableSerialize(authorityWatermark)) {
      throw new DreamApplicationError(
        "READER_CONTRACT_VIOLATION",
        "nextCursor.authorityWatermark does not match page authorityWatermark",
      );
    }
  } catch (error) {
    if (error instanceof DreamApplicationError) throw error;
    throw new DreamApplicationError("READER_CONTRACT_VIOLATION", "cursor watermark comparison failed", error);
  }
}

function assertInputCursorMatchesPage(
  cursor: AcceptedDreamDeltaCursor | undefined,
  pageWatermark: AuthorityWatermark,
): void {
  if (cursor === undefined) return;
  try {
    if (stableSerialize(cursor.authorityWatermark) !== stableSerialize(pageWatermark)) {
      throw new DreamApplicationError(
        "READER_CONTRACT_VIOLATION",
        "reader page authorityWatermark does not match input cursor watermark",
      );
    }
  } catch (error) {
    if (error instanceof DreamApplicationError) throw error;
    throw new DreamApplicationError("READER_CONTRACT_VIOLATION", "input cursor watermark comparison failed", error);
  }
}

function normalizePage(
  page: AcceptedDreamDeltaPage,
  userId: string,
  window: CanonicalUtcWindow,
): NormalizedReaderPage {
  if (!isRecord(page) || !Array.isArray(page.records) || !("authorityWatermark" in page)) {
    throw new DreamApplicationError(
      "READER_CONTRACT_VIOLATION",
      "reader must return records and an authority watermark",
    );
  }
  assertOpaqueWatermark(page.authorityWatermark, "authorityWatermark");
  if (page.nextCursor !== undefined) {
    assertCursorMatchesWatermark(page.nextCursor, page.authorityWatermark);
  }

  const records: AcceptedDreamDeltaRecord[] = [];
  const acceptedDeltaRefs: CanonicalObjectVersionRef[] = [];
  const acceptedEvidenceRefs: CanonicalObjectVersionRef[] = [];
  const recordKeys = new Set<string>();

  for (const raw of page.records) {
    if (!isRecord(raw) || raw.accepted !== true || raw.userId !== userId) {
      throw new DreamApplicationError(
        "READER_CONTRACT_VIOLATION",
        "reader returned an unaccepted or foreign-user delta",
      );
    }
    let ref: CanonicalObjectVersionRef;
    let sourceRefs: readonly CanonicalObjectVersionRef[];
    let delta: ReadonlyJsonValue;
    try {
      ref = copyRef(raw.ref as CanonicalObjectVersionRef);
      sourceRefs = copyRefs(raw.sourceRefs as readonly CanonicalObjectVersionRef[]);
      assertCanonicalUtcInstant(raw.acceptedAt);
      delta = cloneJsonValue(raw.delta);
    } catch (error) {
      if (error instanceof DreamApplicationError) throw error;
      throw new DreamApplicationError(
        "READER_CONTRACT_VIOLATION",
        "reader returned an invalid accepted-delta record",
        error,
      );
    }
    if (!withinHalfOpenWindow(raw.acceptedAt as string, window)) {
      throw new DreamApplicationError(
        "READER_CONTRACT_VIOLATION",
        "reader returned a delta outside the requested half-open window",
      );
    }
    const refKey = canonicalRefKey(ref);
    if (recordKeys.has(refKey)) {
      throw new DreamApplicationError(
        "READER_CONTRACT_VIOLATION",
        "reader returned duplicate accepted-delta refs",
      );
    }
    recordKeys.add(refKey);
    records.push(Object.freeze({
      ref,
      userId,
      accepted: true,
      delta,
      sourceRefs,
      acceptedAt: raw.acceptedAt as AcceptedDreamDeltaRecord["acceptedAt"],
    }));
    acceptedDeltaRefs.push(ref);
    acceptedEvidenceRefs.push(ref, ...sourceRefs);
  }

  const uniqueEvidenceRefs = new Map<string, CanonicalObjectVersionRef>();
  for (const ref of acceptedEvidenceRefs) uniqueEvidenceRefs.set(canonicalRefKey(ref), ref);
  return {
    records: Object.freeze(records),
    acceptedDeltaRefs: Object.freeze(acceptedDeltaRefs.sort(compareCanonicalObjectVersionRefs)),
    acceptedEvidenceRefs: Object.freeze([...uniqueEvidenceRefs.values()].sort(compareCanonicalObjectVersionRefs)),
      authorityWatermark: page.authorityWatermark,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

function proposalId(value: unknown): string {
  if (isRecord(value) && typeof value.proposalId === "string" && value.proposalId.trim().length > 0) {
    return value.proposalId.trim();
  }
  return "<invalid-proposal>";
}

function boundaryDisposition(
  value: unknown,
  reasonCode: string,
  reason: string,
): DreamDisposition {
  return {
    proposalId: proposalId(value),
    status: "reject",
    kind: "reject",
    reasonCode,
    reason,
  };
}

function proposalInstant(value: DreamExtractorProposal): string | undefined {
  if (value.occurredAt === undefined) return value.validity?.observedAt;
  if (value.occurredAt instanceof Date) {
    return Number.isFinite(value.occurredAt.getTime()) ? value.occurredAt.toISOString() : undefined;
  }
  return value.occurredAt;
}

function proposalIsWithinHalfOpenWindow(
  proposal: DreamExtractorProposal,
  window: CanonicalUtcWindow,
): boolean {
  const observed = proposalInstant(proposal);
  if (observed !== undefined && !withinHalfOpenWindow(observed, window)) return false;
  const validFrom = proposal.validity?.validFrom;
  const validTo = proposal.validity?.validTo;
  if (validFrom !== undefined && !isCanonicalUtcInstant(validFrom)) return false;
  if (validTo !== undefined && !isCanonicalUtcInstant(validTo)) return false;
  if (validFrom !== undefined && compareCanonicalUtcInstants(assertCanonicalUtcInstant(validFrom), window.to) >= 0) {
    return false;
  }
  if (validTo !== undefined && compareCanonicalUtcInstants(assertCanonicalUtcInstant(validTo), window.from) <= 0) {
    return false;
  }
  return true;
}

function validateExtractorProposals(
  proposals: readonly DreamExtractorProposal[],
  userId: string,
  window: CanonicalUtcWindow,
): BoundaryValidation {
  const accepted: DreamExtractorProposal[] = [];
  const rejected: DreamDisposition[] = [];
  for (const proposal of proposals) {
    if (!isRecord(proposal) || proposal.userId !== userId) {
      rejected.push(boundaryDisposition(proposal, "FOREIGN_USER_PROPOSAL", "extractor proposal user does not match the requested user"));
      continue;
    }
    try {
      if (!proposalIsWithinHalfOpenWindow(proposal, window)) {
        rejected.push(boundaryDisposition(proposal, "OUT_OF_WINDOW", "proposal time is outside the half-open Dream window"));
        continue;
      }
    } catch (error) {
      rejected.push(boundaryDisposition(proposal, "INVALID_PROPOSAL_TIME", "proposal time is not a strict UTC instant"));
      continue;
    }
    accepted.push(proposal);
  }
  return { accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) };
}

function stableSerialize(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "\"[undefined]\"";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number cannot be fingerprinted");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("unsupported value cannot be fingerprinted");
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("invalid date cannot be fingerprinted");
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("cyclic value cannot be fingerprinted");
    seen.add(value);
    const result = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) throw new TypeError("non-record value cannot be fingerprinted");
  if (seen.has(value)) throw new TypeError("cyclic value cannot be fingerprinted");
  seen.add(value);
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`);
  seen.delete(value);
  return `{${entries.join(",")}}`;
}

function fingerprintBatch(input: {
  readonly window: CanonicalUtcWindow;
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
  readonly authorityWatermark: AuthorityWatermark;
  readonly modelConfidenceThresholdPpm: number;
  readonly proposals: readonly DreamExtractorProposal[];
}): Sha256 {
  try {
    const payload = {
      schema: "t05.dream.application.fingerprint.v1",
      batchId: input.batchId,
      idempotencyKey: input.idempotencyKey,
      window: input.window,
      authorityWatermark: input.authorityWatermark,
      modelConfidenceThresholdPpm: input.modelConfidenceThresholdPpm,
      acceptedDeltaRefs: input.acceptedDeltaRefs
        .slice()
        .sort(compareCanonicalObjectVersionRefs)
        .map((ref) => ({
          refType: ref.refType,
          refId: ref.refId,
          objectVersion: ref.objectVersion,
          canonicalPayloadSha256: ref.canonicalPayloadSha256,
        })),
      proposals: input.proposals
        .slice()
        .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)))
        .map((proposal) => proposal),
    };
    return assertSha256(createHash("sha256").update(stableSerialize(payload), "utf8").digest("hex"));
  } catch (error) {
    throw new DreamApplicationError("FINGERPRINT_FAILED", "Dream batch fingerprint could not be created", error);
  }
}

function readReceipt(
  input: {
    readonly userId: string;
    readonly window: CanonicalUtcWindow;
    readonly acceptedDeltaRefs: readonly CanonicalObjectVersionRef[];
    readonly authorityWatermark: AuthorityWatermark;
    readonly nextCursor?: AcceptedDreamDeltaCursor;
  },
): DreamReadReceipt {
  return Object.freeze({
    kind: "dream_read_receipt",
    userId: input.userId,
    window: input.window,
    acceptedDeltaRefs: Object.freeze(input.acceptedDeltaRefs.map(copyRef)),
    authorityWatermark: input.authorityWatermark,
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  });
}

function withoutCursor(receipt: DreamReadReceipt): Omit<DreamReadReceipt, "nextCursor"> {
  return {
    kind: receipt.kind,
    userId: receipt.userId,
    window: receipt.window,
    acceptedDeltaRefs: receipt.acceptedDeltaRefs,
    authorityWatermark: receipt.authorityWatermark,
  };
}

function validateCommitReceipt(input: {
  readonly receipt: MemoryCommitReceipt;
  readonly batchIdempotencyKey: string;
  readonly batchFingerprint: Sha256;
  readonly candidateCount: number;
}): MemoryCommitReceipt | undefined {
  try {
    const receipt = input.receipt;
    if (!isRecord(receipt) || receipt.kind !== "memory_commit_receipt" ||
        receipt.operation !== "candidate_batch" ||
        receipt.idempotencyKey !== input.batchIdempotencyKey ||
        receipt.outcome !== "committed" && receipt.outcome !== "replayed" ||
        assertSha256(receipt.fingerprint) !== input.batchFingerprint ||
        !isOpaqueWatermark(receipt.authorityWatermark) ||
        !Array.isArray(receipt.canonicalRefs) ||
        receipt.canonicalRefs.length !== input.candidateCount ||
        !Array.isArray(receipt.supersededRefs) || receipt.supersededRefs.length !== 0) {
      return undefined;
    }
    const canonicalRefs = receipt.canonicalRefs.map((value) => {
      const ref = copyRef(value as CanonicalObjectVersionRef);
      if (ref.refType !== "MemoryCandidate") throw new TypeError("receipt ref is not MemoryCandidate");
      return ref;
    });
    const keys = canonicalRefs.map(canonicalRefKey);
    if (new Set(keys).size !== keys.length) return undefined;
    return Object.freeze({
      kind: "memory_commit_receipt",
      operation: "candidate_batch",
      outcome: receipt.outcome,
      idempotencyKey: input.batchIdempotencyKey,
      fingerprint: input.batchFingerprint,
      canonicalRefs: Object.freeze(canonicalRefs),
      supersededRefs: Object.freeze([]),
      authorityWatermark: receipt.authorityWatermark,
    });
  } catch {
    return undefined;
  }
}

/** T05 application service; all authoritative reads/writes remain injected Owner ports. */
export class DreamApplicationService {
  readonly #reader: AcceptedDreamDeltaReader;
  readonly #extractor: DreamApplicationExtractor;
  readonly #commandRepository: MemoryCommandRepository;

  constructor(options: DreamApplicationServiceOptions) {
    if (!options || typeof options !== "object") {
      throw new DreamApplicationError("INVALID_REQUEST", "Dream application dependencies are required");
    }
    this.#reader = options.reader;
    this.#extractor = options.extractor;
    this.#commandRepository = options.commandRepository;
    if (typeof this.#reader?.readAcceptedDreamDeltas !== "function" ||
        typeof this.#extractor?.extract !== "function" ||
        typeof this.#commandRepository?.withTransaction !== "function") {
      throw new DreamApplicationError("INVALID_REQUEST", "Dream application dependencies are invalid");
    }
  }

  async run(input: DreamApplicationInput): Promise<DreamApplicationResult> {
    const normalized = normalizeInput(input);
    let page: AcceptedDreamDeltaPage;
    try {
      page = await this.#reader.readAcceptedDreamDeltas({
        userId: normalized.userId,
        window: normalized.window,
        limit: normalized.limit,
        ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
      });
    } catch (error) {
      if (error instanceof DreamApplicationError) throw error;
      throw new DreamApplicationError("READER_FAILED", "accepted Dream delta read failed", error);
    }
    const normalizedPage = normalizePage(page, normalized.userId, normalized.window);
    assertInputCursorMatchesPage(normalized.cursor, normalizedPage.authorityWatermark);
    const initialReadReceipt = readReceipt({
      userId: normalized.userId,
      window: normalized.window,
      acceptedDeltaRefs: normalizedPage.acceptedDeltaRefs,
      authorityWatermark: normalizedPage.authorityWatermark,
      ...(normalizedPage.nextCursor === undefined ? {} : { nextCursor: normalizedPage.nextCursor }),
    });

    let extracted: readonly DreamExtractorProposal[] = [];
    if (normalizedPage.records.length > 0) {
      try {
        const value = await this.#extractor.extract({
          userId: normalized.userId,
          window: normalized.window,
          deltas: Object.freeze(normalizedPage.records.map((record) => Object.freeze({
            ref: record.ref,
            delta: record.delta,
            sourceRefs: record.sourceRefs,
            acceptedAt: record.acceptedAt,
          }))),
        });
        if (!Array.isArray(value)) {
          throw new DreamApplicationError("EXTRACTOR_CONTRACT_VIOLATION", "extractor must return a proposal array");
        }
        extracted = value;
      } catch (error) {
        if (error instanceof DreamApplicationError) throw error;
        throw new DreamApplicationError("EXTRACTOR_FAILED", "Dream extractor failed", error);
      }
    }

    const fingerprint = fingerprintBatch({
      window: normalized.window,
      batchId: normalized.batchId,
      idempotencyKey: normalized.idempotencyKey,
      acceptedDeltaRefs: normalizedPage.acceptedDeltaRefs,
      authorityWatermark: normalizedPage.authorityWatermark,
      modelConfidenceThresholdPpm: normalized.modelConfidenceThresholdPpm,
      proposals: extracted,
    });
    const boundary = validateExtractorProposals(extracted, normalized.userId, normalized.window);
    let built: DreamCandidateBatch;
    try {
      built = buildDreamCandidateBatch({
        window: normalized.window,
        batchId: normalized.batchId,
        idempotencyKey: normalized.idempotencyKey,
        acceptedDeltaRefs: normalizedPage.acceptedEvidenceRefs,
        proposals: boundary.accepted,
        modelConfidenceThresholdPpm: normalized.modelConfidenceThresholdPpm,
      });
    } catch (error) {
      throw new DreamApplicationError("ADMISSION_FAILED", "Dream candidate admission failed", error);
    }
    const batch: DreamCandidateBatch = Object.freeze({
      ...built,
      rejected: Object.freeze([...built.rejected, ...boundary.rejected]),
    });
    const base: DreamApplicationResultBase = Object.freeze({
      kind: "dream_application_result",
      userId: normalized.userId,
      batchId: normalized.batchId,
      idempotencyKey: normalized.idempotencyKey,
      window: normalized.window,
      fingerprint,
      batch,
    });

    if (batch.candidates.length === 0) {
      return {
        ...base,
        outcome: "no_candidates",
        readReceipt: initialReadReceipt,
      };
    }

    let commandResult: MemoryCommandResult<MemoryCommitReceipt>;
    try {
      commandResult = await this.#commandRepository.withTransaction(async (transaction) =>
        transaction.commitCandidateBatch({
          batchId: normalized.batchId,
          idempotencyKey: normalized.idempotencyKey,
          fingerprint,
          candidates: batch.candidates,
        }),
      );
    } catch (error) {
      throw new DreamApplicationError("COMMIT_FAILED", "candidate batch commit failed", error);
    }
    if (!commandResult.ok) {
      return {
        ...base,
        outcome: "commit_rejected",
        readReceipt: withoutCursor(initialReadReceipt),
        error: commandResult.error,
      };
    }
    const validatedReceipt = validateCommitReceipt({
      receipt: commandResult.receipt,
      batchIdempotencyKey: normalized.idempotencyKey,
      batchFingerprint: fingerprint,
      candidateCount: batch.candidates.length,
    });
    if (validatedReceipt === undefined) {
      return {
        ...base,
        outcome: "commit_rejected",
        readReceipt: withoutCursor(initialReadReceipt),
        error: { code: "OWNER_STATE_UNAVAILABLE", retryable: true },
      };
    }
    return {
      ...base,
      outcome: validatedReceipt.outcome,
      readReceipt: initialReadReceipt,
      commitReceipt: validatedReceipt,
    };
  }
}

export function createDreamApplicationService(
  options: DreamApplicationServiceOptions,
): DreamApplicationService {
  return new DreamApplicationService(options);
}
