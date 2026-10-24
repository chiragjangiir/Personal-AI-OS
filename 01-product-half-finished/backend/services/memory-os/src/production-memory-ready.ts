import type {
  FinalTranscriptEvidenceResult,
} from "../../realtime-core/src/final-transcript-evidence-service.ts";
import {
  assertCanonicalTimestamp,
  type OpaqueCanonicalRef,
} from "../../realtime-core/src/types.ts";
import type {
  MemoryConsumerContext,
} from "./context-consumer-adapter.ts";
import {
  assertCanonicalUtcInstant,
  type CompilerQuery,
  type MemorySensitivity,
} from "./domain.ts";
import type {
  ExplicitUserRememberResult,
} from "./explicit-user-remember-service.ts";
import {
  assertCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "./canonical-ref.ts";
import {
  createFinalTranscriptExplicitRememberAdapter,
  type FinalTranscriptEvidenceReader,
  type FinalTranscriptEvidenceRecord,
  type FinalTranscriptExplicitRememberAdapter,
} from "./final-transcript-explicit-remember-adapter.ts";
import type {
  ProductionMemoryRuntime,
  RecallMemoryContextInput,
} from "../../platform-data/src/memory-runtime.ts";

const BINDING_KEYS = Object.freeze([
  "clientInstanceId",
  "continuityId",
  "deviceId",
  "purpose",
  "realtimeSessionRef",
  "sessionId",
  "userId",
] as const);
const COMMIT_KEYS = Object.freeze(["binding", "evidence"] as const);
const EVIDENCE_RESULT_KEYS = Object.freeze([
  "evidenceRef",
  "observedAt",
  "outboxEventRef",
  "transcriptSegmentRef",
] as const);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_TRANSCRIPT_BYTES = 16_384;
const MAX_EVIDENCE_REPLAY_ENTRIES = 128;

type PlainRecord = Record<string, unknown>;

export class ProductionMemoryReadyError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "ProductionMemoryReadyError";
    this.code = code;
  }
}

/**
 * The exact binding proven by the Windows/T11B owner resolver for one active
 * session.  This seam never derives identity from process environment or an
 * in-process collection.
 */
export interface ProductionMemoryReadyBinding {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly purpose: string;
}

/**
 * T11B's committed final-transcript projection.  It contains references and
 * the exact binding only; transcript text is read back through the supplied
 * authoritative evidence reader before admission.
 */
export interface ProductionFinalTranscriptEvidenceCommitProjection {
  readonly binding: ProductionMemoryReadyBinding;
  readonly evidence: FinalTranscriptEvidenceResult;
}

export interface ProductionMemoryReadyOptions {
  readonly binding: ProductionMemoryReadyBinding;
  readonly evidenceReader: FinalTranscriptEvidenceReader;
  readonly memory: ProductionMemoryRuntime;
  /** Caller-bound and explicitly confirmed; this seam never infers it. */
  readonly sensitivity: MemorySensitivity;
}

export interface ProductionMemoryReady {
  readonly rememberFinalTranscript: (
    commit: ProductionFinalTranscriptEvidenceCommitProjection,
  ) => Promise<ExplicitUserRememberResult | undefined>;
  readonly recallForAnswerContext: (
    input: RecallMemoryContextInput,
  ) => Promise<MemoryConsumerContext>;
  readonly close: () => Promise<void>;
}

function fail(code: string, cause?: unknown): never {
  throw new ProductionMemoryReadyError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) {
    fail(code);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("MEMORY_READY_BINDING_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) fail("MEMORY_READY_BINDING_INVALID");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(",")}}`;
}

function assertClosedRecord(value: unknown, keys: readonly string[], code: string): PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return value;
}

function normalizeOpaqueRef(value: unknown): OpaqueCanonicalRef {
  if (typeof value !== "string" && !isPlainRecord(value)) fail("MEMORY_READY_BINDING_INVALID");
  canonicalJson(value);
  return value as OpaqueCanonicalRef;
}

function normalizeBinding(value: unknown): ProductionMemoryReadyBinding {
  const input = assertClosedRecord(value, BINDING_KEYS, "MEMORY_READY_BINDING_INVALID");
  const binding = Object.freeze({
    userId: exactString(input.userId, "MEMORY_READY_BINDING_INVALID"),
    sessionId: exactString(input.sessionId, "MEMORY_READY_BINDING_INVALID"),
    deviceId: exactString(input.deviceId, "MEMORY_READY_BINDING_INVALID"),
    clientInstanceId: exactString(input.clientInstanceId, "MEMORY_READY_BINDING_INVALID"),
    realtimeSessionRef: normalizeOpaqueRef(input.realtimeSessionRef),
    continuityId: exactString(input.continuityId, "MEMORY_READY_BINDING_INVALID"),
    purpose: exactString(input.purpose, "MEMORY_READY_BINDING_INVALID"),
  });
  return binding;
}

function refsEqual(left: unknown, right: unknown): boolean {
  try {
    const a = assertCanonicalObjectVersionRef(left);
    const b = assertCanonicalObjectVersionRef(right);
    return a.refType === b.refType && a.refId === b.refId &&
      a.objectVersion === b.objectVersion &&
      a.canonicalPayloadSha256 === b.canonicalPayloadSha256;
  } catch {
    return false;
  }
}

function bindingEqual(left: ProductionMemoryReadyBinding, right: ProductionMemoryReadyBinding): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId &&
    left.deviceId === right.deviceId && left.clientInstanceId === right.clientInstanceId &&
    left.continuityId === right.continuityId && left.purpose === right.purpose &&
    canonicalJson(left.realtimeSessionRef) === canonicalJson(right.realtimeSessionRef);
}

function normalizeSensitivity(value: unknown): MemorySensitivity {
  const input = assertClosedRecord(value, ["classification", "userConfirmed"],
    "MEMORY_READY_SENSITIVITY_INVALID");
  if ((input.classification !== "normal" && input.classification !== "sensitive") ||
      input.userConfirmed !== true) {
    fail("MEMORY_READY_SENSITIVITY_INVALID");
  }
  return Object.freeze({
    classification: input.classification,
    userConfirmed: true,
  });
}

function normalizeEvidenceResult(value: unknown): FinalTranscriptEvidenceResult {
  const input = assertClosedRecord(value, EVIDENCE_RESULT_KEYS, "MEMORY_READY_EVIDENCE_INVALID");
  const evidenceRef = assertCanonicalObjectVersionRef(input.evidenceRef);
  if (evidenceRef.refType !== "FinalTranscriptEvidence") fail("MEMORY_READY_EVIDENCE_INVALID");
  assertCanonicalObjectVersionRef(input.transcriptSegmentRef);
  normalizeOpaqueRef(input.outboxEventRef);
  const observedAt = assertCanonicalTimestamp(input.observedAt);
  return Object.freeze({
    transcriptSegmentRef: input.transcriptSegmentRef as FinalTranscriptEvidenceResult["transcriptSegmentRef"],
    evidenceRef: evidenceRef as FinalTranscriptEvidenceResult["evidenceRef"],
    outboxEventRef: input.outboxEventRef as FinalTranscriptEvidenceResult["outboxEventRef"],
    observedAt,
  }) as unknown as FinalTranscriptEvidenceResult;
}

function normalizeCommit(value: unknown): ProductionFinalTranscriptEvidenceCommitProjection {
  const input = assertClosedRecord(value, COMMIT_KEYS, "MEMORY_READY_COMMIT_INVALID");
  return Object.freeze({
    binding: normalizeBinding(input.binding),
    evidence: normalizeEvidenceResult(input.evidence),
  });
}

function validateEvidenceRecord(
  record: FinalTranscriptEvidenceRecord,
  commit: ProductionFinalTranscriptEvidenceCommitProjection,
): FinalTranscriptEvidenceRecord {
  if (!isPlainRecord(record) || record.transcriptState !== "final" ||
      !refsEqual(record.ref, commit.evidence.evidenceRef) ||
      record.userId !== commit.binding.userId || record.purpose !== commit.binding.purpose ||
      typeof record.text !== "string" || record.text.trim() !== record.text || record.text.length === 0 ||
      Buffer.byteLength(record.text, "utf8") > MAX_TRANSCRIPT_BYTES) {
    fail("MEMORY_READY_EVIDENCE_INVALID");
  }
  assertCanonicalUtcInstant(record.observedAt, "evidence.observedAt");
  if (record.observedAt !== commit.evidence.observedAt) fail("MEMORY_READY_EVIDENCE_TIME_DRIFT");
  return record;
}

function assertOptions(value: ProductionMemoryReadyOptions): Readonly<ProductionMemoryReadyOptions> {
  if (!isPlainRecord(value) || !isPlainRecord(value.evidenceReader) ||
      typeof value.evidenceReader.read !== "function" || !isPlainRecord(value.memory) ||
      typeof value.memory.rememberExplicit !== "function" ||
      typeof value.memory.recallForAnswerContext !== "function" ||
      typeof value.memory.close !== "function") {
    fail("MEMORY_READY_CONFIGURATION_INVALID");
  }
  const binding = normalizeBinding(value.binding);
  const sensitivity = normalizeSensitivity(value.sensitivity);
  if (value.memory.userId !== binding.userId || value.memory.purposeScope !== binding.purpose) {
    fail("MEMORY_READY_RUNTIME_BINDING_INVALID");
  }
  return Object.freeze({ ...value, binding, sensitivity });
}

function createBoundEvidenceReader(
  reader: FinalTranscriptEvidenceReader,
  commit: ProductionFinalTranscriptEvidenceCommitProjection,
): FinalTranscriptEvidenceReader {
  return Object.freeze({
    async read(ref: CanonicalObjectVersionRef): Promise<FinalTranscriptEvidenceRecord | undefined> {
      if (!refsEqual(ref, commit.evidence.evidenceRef)) fail("MEMORY_READY_EVIDENCE_REFERENCE_DRIFT");
      return reader.read(ref);
    },
  });
}

export function createProductionMemoryReady(
  options: ProductionMemoryReadyOptions,
): ProductionMemoryReady {
  const config = assertOptions(options);
  let closed = false;
  const adaptersByEvidence = new Map<string, Readonly<{
    readonly commit: ProductionFinalTranscriptEvidenceCommitProjection;
    readonly adapter: FinalTranscriptExplicitRememberAdapter;
  }>>();
  const evidenceReplayOrder: string[] = [];
  const assertOpen = (): void => {
    if (closed) fail("MEMORY_READY_CLOSED");
  };

  const rememberFinalTranscript = async (
    rawCommit: ProductionFinalTranscriptEvidenceCommitProjection,
  ): Promise<ExplicitUserRememberResult | undefined> => {
    assertOpen();
    const commit = normalizeCommit(rawCommit);
    if (!bindingEqual(commit.binding, config.binding)) fail("MEMORY_READY_BINDING_DRIFT");
    const evidenceRef = assertCanonicalObjectVersionRef(commit.evidence.evidenceRef);
    const evidenceKey = canonicalJson(evidenceRef);
    let state = adaptersByEvidence.get(evidenceKey);
    if (state !== undefined && canonicalJson(state.commit) !== canonicalJson(commit)) {
      fail("MEMORY_READY_COMMIT_DRIFT");
    }
    if (state === undefined) {
      state = Object.freeze({
        commit,
        adapter: createFinalTranscriptExplicitRememberAdapter({
          evidenceReader: createBoundEvidenceReader(config.evidenceReader, commit),
          remember: { rememberExplicit: config.memory.rememberExplicit },
        }),
      });
      adaptersByEvidence.set(evidenceKey, state);
    }
    const evidenceState = state;
    let rememberResult: ExplicitUserRememberResult | undefined;
    try {
      let record: FinalTranscriptEvidenceRecord | undefined;
      try {
        record = await config.evidenceReader.read(evidenceRef);
      } catch (error) {
        fail("MEMORY_READY_EVIDENCE_READ_FAILED", error);
      }
      if (record === undefined) fail("MEMORY_READY_EVIDENCE_NOT_FOUND");
      const evidence = validateEvidenceRecord(record, commit);
      rememberResult = await evidenceState.adapter.remember(Object.freeze({
        userId: config.binding.userId,
        purposeScopes: Object.freeze([config.binding.purpose]),
        originalUtterance: evidence.text,
        evidenceRef,
        sensitivity: config.sensitivity,
      }));
      return rememberResult;
    } finally {
      if (adaptersByEvidence.get(evidenceKey) === evidenceState) {
        if (rememberResult === undefined) {
          adaptersByEvidence.delete(evidenceKey);
          const index = evidenceReplayOrder.indexOf(evidenceKey);
          if (index >= 0) evidenceReplayOrder.splice(index, 1);
        } else {
          const prior = evidenceReplayOrder.indexOf(evidenceKey);
          if (prior >= 0) evidenceReplayOrder.splice(prior, 1);
          evidenceReplayOrder.push(evidenceKey);
          while (evidenceReplayOrder.length > MAX_EVIDENCE_REPLAY_ENTRIES) {
            const oldest = evidenceReplayOrder.shift();
            if (oldest !== undefined) adaptersByEvidence.delete(oldest);
          }
        }
      }
    }
  };

  const recallForAnswerContext = async (
    input: RecallMemoryContextInput,
  ): Promise<MemoryConsumerContext> => {
    assertOpen();
    if (!isPlainRecord(input) || Object.prototype.hasOwnProperty.call(input, "userId") ||
        Object.prototype.hasOwnProperty.call(input, "purposeScope")) {
      fail("MEMORY_READY_QUERY_SCOPE_INVALID");
    }
    return config.memory.recallForAnswerContext(input as Omit<CompilerQuery, "userId" | "purposeScope">);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    adaptersByEvidence.clear();
    evidenceReplayOrder.length = 0;
    await config.memory.close();
  };

  return Object.freeze({ rememberFinalTranscript, recallForAnswerContext, close });
}
