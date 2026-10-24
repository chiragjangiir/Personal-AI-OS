import { createHash } from "node:crypto";

import {
  ADMISSIBLE_EVIDENCE_REF_TYPES,
  admitMemoryProposal,
  type AdmittedMemoryCandidateIntent,
} from "./admission.ts";
import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  assertProductionMemoryIssuerReceipt,
  canonicalPayloadHash,
  jcsSerialize,
  type CanonicalIssuerSystemContext,
  type ProductionMemoryIssuerReceipt,
} from "./canonical-issuer.ts";
import {
  assertCanonicalUtcInstant,
  type MemoryCommandResult,
  type MemoryCommitReceipt,
  type MemoryVersionRecord,
  type ReadonlyJsonValue,
} from "./domain.ts";
import type { MemoryConsumerContext } from "./context-consumer-adapter.ts";
import type {
  ProductionMemoryLifecycle,
  ProductionMemoryLifecycleEnvelope,
  ProductionMemoryLifecycleExecution,
} from "./production-memory-lifecycle.ts";
import type { ProductionMemoryReadyBinding } from "./production-memory-ready.ts";
import {
  assertMemoryCanonicalVersionRead,
  type MemoryCanonicalVersionReader,
  type MemoryReviewStateReader,
  type OwnerPortResult,
  type ProductionMemoryCanonicalIssuerPort,
} from "./ports.ts";
import type { ProductionCommitCorrectionInput } from "./memory-application-service.ts";
import { MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES } from "./explicit-user-remember-service.ts";

const INPUT_KEYS = Object.freeze([
  "binding",
  "correctionEnvelope",
  "correctionEvidence",
  "kind",
  "newValue",
  "recallEnvelope",
  "recallInput",
  "slot",
] as const);
const BINDING_KEYS = Object.freeze([
  "clientInstanceId",
  "continuityId",
  "deviceId",
  "purpose",
  "realtimeSessionRef",
  "sessionId",
  "userId",
] as const);
const EVIDENCE_KEYS = Object.freeze(["observedAt", "ref"] as const);
const MEMORY_REF_TYPES = new Set([
  "MemoryCandidate",
  "SemanticFact",
  "EpisodicMemory",
  "PreferenceMemory",
  "OpenLoop",
]);
const ALLOWED_EVIDENCE_TYPES = new Set<string>(ADMISSIBLE_EVIDENCE_REF_TYPES);
const MAX_SAFE_RECALL_ITEMS = 10_000;
const MAX_SAFE_RECALL_BYTES = 16 * 1024 * 1024;

type PlainRecord = Record<string, unknown>;

export class ExplicitUserCorrectionAdapterError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ExplicitUserCorrectionAdapterError";
    this.code = code;
  }
}

export interface ExplicitUserCorrectionEvidence {
  readonly ref: CanonicalObjectVersionRef;
  readonly observedAt: string;
}

export interface ExplicitUserCorrectionInput {
  readonly kind: "explicit_user_correction";
  readonly binding: ProductionMemoryReadyBinding;
  readonly slot: string;
  readonly newValue: string;
  readonly correctionEvidence: ExplicitUserCorrectionEvidence;
  readonly correctionEnvelope: ProductionMemoryLifecycleEnvelope;
  readonly recallEnvelope: ProductionMemoryLifecycleEnvelope;
  readonly recallInput: Readonly<{
    readonly asOf: string;
    readonly maxItems: number;
    readonly maxContentBytes: number;
    readonly slot: string;
  }>;
}

export interface ExplicitUserCorrectionNotHandled {
  readonly handled: false;
  readonly reason: "not_explicit_correction";
}

export interface ExplicitUserCorrectionHandled {
  readonly handled: true;
  readonly idempotencyKey: string;
  readonly predecessorRef: CanonicalObjectVersionRef;
  readonly successorRef: CanonicalObjectVersionRef;
  readonly correction: ProductionMemoryLifecycleExecution<MemoryCommandResult<MemoryCommitReceipt>>;
  readonly recall: ProductionMemoryLifecycleExecution<MemoryConsumerContext>;
  readonly oldRefSuppressionReasons: readonly string[];
}

export type ExplicitUserCorrectionResult =
  | ExplicitUserCorrectionNotHandled
  | ExplicitUserCorrectionHandled;

export interface ExplicitUserCorrectionAdapterOptions {
  readonly lifecycle: ProductionMemoryLifecycle;
  readonly reviewStateReader: MemoryReviewStateReader;
  readonly canonicalVersionReader: MemoryCanonicalVersionReader;
  readonly issuer: ProductionMemoryCanonicalIssuerPort;
  readonly systemContext: CanonicalIssuerSystemContext;
}

export interface ExplicitUserCorrectionAdapter {
  execute(input: unknown): Promise<ExplicitUserCorrectionResult>;
  close(): Promise<void>;
}

type NormalizedInput = Omit<ExplicitUserCorrectionInput, "binding" | "correctionEvidence" | "recallInput"> & {
  readonly binding: ProductionMemoryReadyBinding;
  readonly correctionEvidence: ExplicitUserCorrectionEvidence;
  readonly recallInput: ExplicitUserCorrectionInput["recallInput"];
};

interface ReplayEntry {
  readonly key: string;
  readonly fingerprint: Sha256;
  readonly result: Promise<ExplicitUserCorrectionHandled>;
}

function fail(code: string, cause?: unknown): never {
  throw new ExplicitUserCorrectionAdapterError(code, cause);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => typeof key === "string");
  } catch {
    return false;
  }
}

function assertClosedRecord(value: unknown, keys: readonly string[], code: string): PlainRecord {
  if (!isPlainRecord(value)) fail(code);
  const names = Object.getOwnPropertyNames(value);
  const expected = new Set(keys);
  if (names.length !== keys.length || names.some((key) => !expected.has(key))) fail(code);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  return value;
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) {
    fail(code);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(jcsSerialize(value, "correction input")) as T;
  } catch (error) {
    fail("CORRECTION_INPUT_JSON_INVALID", error);
  }
}

function freezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as PlainRecord)) freezeJson(child);
  return Object.freeze(value);
}

function copyRef(value: unknown, code = "CORRECTION_REF_INVALID"): CanonicalObjectVersionRef {
  const input = assertClosedRecord(value, [
    "canonicalPayloadSha256",
    "objectVersion",
    "refId",
    "refType",
  ], code);
  try {
    const ref = assertCanonicalObjectVersionRef(input);
    return Object.freeze({
      refType: ref.refType,
      refId: ref.refId,
      objectVersion: ref.objectVersion,
      canonicalPayloadSha256: ref.canonicalPayloadSha256,
    });
  } catch (error) {
    fail(code, error);
  }
}

function copyBinding(value: unknown): ProductionMemoryReadyBinding {
  const input = assertClosedRecord(value, BINDING_KEYS, "CORRECTION_BINDING_INVALID");
  return Object.freeze({
    clientInstanceId: exactString(input.clientInstanceId, "CORRECTION_BINDING_INVALID"),
    continuityId: exactString(input.continuityId, "CORRECTION_BINDING_INVALID"),
    deviceId: exactString(input.deviceId, "CORRECTION_BINDING_INVALID"),
    purpose: exactString(input.purpose, "CORRECTION_BINDING_INVALID"),
    realtimeSessionRef: freezeJson(cloneJson(input.realtimeSessionRef)),
    sessionId: exactString(input.sessionId, "CORRECTION_BINDING_INVALID"),
    userId: exactString(input.userId, "CORRECTION_BINDING_INVALID"),
  }) as ProductionMemoryReadyBinding;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return jcsSerialize(left, "correction equality") === jcsSerialize(right, "correction equality");
  } catch {
    return false;
  }
}

function sameRef(left: unknown, right: unknown): boolean {
  try {
    return canonicalRefKey(assertCanonicalObjectVersionRef(left)) ===
      canonicalRefKey(assertCanonicalObjectVersionRef(right));
  } catch {
    return false;
  }
}

function normalizeEvidence(value: unknown): ExplicitUserCorrectionEvidence {
  const input = assertClosedRecord(value, EVIDENCE_KEYS, "CORRECTION_EVIDENCE_INVALID");
  const ref = copyRef(input.ref, "CORRECTION_EVIDENCE_INVALID");
  if (!ALLOWED_EVIDENCE_TYPES.has(ref.refType)) fail("CORRECTION_EVIDENCE_TYPE_INVALID");
  return Object.freeze({
    ref,
    observedAt: assertCanonicalUtcInstant(input.observedAt, "correctionEvidence.observedAt"),
  });
}

function normalizeRecallInput(value: unknown, slot: string): ExplicitUserCorrectionInput["recallInput"] {
  const input = assertClosedRecord(value, ["asOf", "maxContentBytes", "maxItems", "slot"], "CORRECTION_RECALL_INPUT_INVALID");
  if (input.slot !== slot) fail("CORRECTION_RECALL_SLOT_INVALID");
  if (typeof input.maxItems !== "number" || !Number.isSafeInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > MAX_SAFE_RECALL_ITEMS ||
      typeof input.maxContentBytes !== "number" || !Number.isSafeInteger(input.maxContentBytes) || input.maxContentBytes < 1 || input.maxContentBytes > MAX_SAFE_RECALL_BYTES) {
    fail("CORRECTION_RECALL_INPUT_INVALID");
  }
  return Object.freeze({
    asOf: assertCanonicalUtcInstant(input.asOf, "recallInput.asOf"),
    maxItems: input.maxItems,
    maxContentBytes: input.maxContentBytes,
    slot,
  });
}

function envelopeBinding(value: ProductionMemoryLifecycleEnvelope): unknown {
  if (!isPlainRecord(value) || !isPlainRecord(value.binding)) fail("CORRECTION_ENVELOPE_INVALID");
  return value.binding;
}

function normalizeInput(value: unknown): NormalizedInput {
  const input = assertClosedRecord(value, INPUT_KEYS, "CORRECTION_INPUT_INVALID");
  if (input.kind !== "explicit_user_correction") fail("CORRECTION_KIND_INVALID");
  const binding = copyBinding(input.binding);
  const slot = exactString(input.slot, "CORRECTION_SLOT_INVALID");
  const newValue = exactString(input.newValue, "CORRECTION_VALUE_INVALID");
  if (Buffer.byteLength(newValue, "utf8") > MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES) {
    fail("CORRECTION_VALUE_INVALID");
  }
  const correctionEvidence = normalizeEvidence(input.correctionEvidence);
  const correctionEnvelope = input.correctionEnvelope as ProductionMemoryLifecycleEnvelope;
  const recallEnvelope = input.recallEnvelope as ProductionMemoryLifecycleEnvelope;
  if (!isPlainRecord(correctionEnvelope) || !isPlainRecord(recallEnvelope) ||
      correctionEnvelope.authorityReceipt?.action !== "correct_memory" ||
      recallEnvelope.authorityReceipt?.action !== "recall_for_answer_context") {
    fail("CORRECTION_ENVELOPE_INVALID");
  }
  if (correctionEnvelope.idempotencyKey === recallEnvelope.idempotencyKey) {
    fail("CORRECTION_ENVELOPE_INVALID");
  }
  if (!sameJson(envelopeBinding(correctionEnvelope), binding) || !sameJson(envelopeBinding(recallEnvelope), binding)) {
    fail("CORRECTION_BINDING_DRIFT");
  }
  const recallInput = normalizeRecallInput(input.recallInput, slot);
  return Object.freeze({
    kind: "explicit_user_correction",
    binding,
    slot,
    newValue,
    correctionEvidence,
    correctionEnvelope,
    recallEnvelope,
    recallInput,
  });
}

function fingerprint(value: NormalizedInput): Sha256 {
  return createHash("sha256").update(jcsSerialize(value, "correction fingerprint"), "utf8").digest("hex") as Sha256;
}

function wireRef(value: unknown): CanonicalObjectVersionRef {
  const input = assertClosedRecord(value, [
    "canonical_payload_sha256",
    "object_version",
    "ref_id",
    "ref_type",
  ], "CORRECTION_PREDECESSOR_PAYLOAD_INVALID");
  return copyRef({
    canonicalPayloadSha256: input.canonical_payload_sha256,
    objectVersion: input.object_version,
    refId: input.ref_id,
    refType: input.ref_type,
  }, "CORRECTION_PREDECESSOR_PAYLOAD_INVALID");
}

function predecessorPayload(read: ReturnType<typeof assertMemoryCanonicalVersionRead>, current: MemoryVersionRecord): void {
  const payload = read.payload;
  const receipt = read.receipt;
  const memoryRef = receipt.memoryRef;
  if ((receipt.operation !== "memory_create" && receipt.operation !== "memory_successor") ||
      memoryRef === undefined || !sameRef(memoryRef, current.ref) ||
      !isPlainRecord(payload) || !sameJson(receipt.payload, payload)) {
    fail("CORRECTION_PREDECESSOR_RECEIPT_INVALID");
  }
  const payloadRef = wireRef(payload.ref);
  const envelope = assertClosedRecord(payload.envelope, [
    "action_risk_class",
    "canonical_payload_sha256",
    "clock_skew_status",
    "contract_version",
    "data_sensitivity_class",
    "egress_mode",
    "event_time_status",
    "object_id",
    "object_type",
    "object_version",
    "owner_module",
    "producer",
    "producer_version",
    "schema_id",
    "schema_version",
    "status",
    "system_time",
  ], "CORRECTION_PREDECESSOR_PAYLOAD_INVALID");
  if (!sameRef(payloadRef, current.ref) ||
      envelope.object_id !== current.ref.refId || envelope.object_type !== current.ref.refType ||
      envelope.object_version !== current.ref.objectVersion ||
      envelope.canonical_payload_sha256 !== receipt.canonicalPayloadSha256 ||
      envelope.status !== "current" || payload.user_id !== current.userId ||
      payload.kind !== current.kind || payload.slot !== current.slot ||
      payload.resolved_content !== current.resolvedContent || payload.status !== "current" ||
      payload.current !== true || payload.source_class !== current.sourceClass ||
      !sameJson(payload.value, current.value) ||
      !sameJson(payload.evidence_refs, current.evidenceRefs.map((ref) => ({
        ref_type: ref.refType,
        ref_id: ref.refId,
        object_version: ref.objectVersion,
        canonical_payload_sha256: ref.canonicalPayloadSha256,
      }))) ||
      !sameJson(payload.allowed_purpose_scopes, current.allowedPurposeScopes) ||
      payload.deleted_at !== undefined || payload.suppressed_at !== undefined) {
    fail("CORRECTION_PREDECESSOR_BINDING_DRIFT");
  }
}

function currentRecord(
  snapshot: Awaited<ReturnType<MemoryReviewStateReader["findAuthoritativeCurrentBySlot"]>>,
  binding: ProductionMemoryReadyBinding,
  slot: string,
): MemoryVersionRecord {
  if (!isPlainRecord(snapshot) || snapshot.conflict !== false || !Array.isArray(snapshot.currentRecords) ||
      snapshot.currentRecords.length !== 1) {
    fail("CORRECTION_CURRENT_MISSING_OR_MULTIPLE");
  }
  const record = snapshot.currentRecords[0] as MemoryVersionRecord;
  if (!isPlainRecord(record) || record.userId !== binding.userId || record.slot !== slot ||
      !MEMORY_REF_TYPES.has(String(record.ref?.refType)) || record.current !== true || record.status !== "current" ||
      record.stale === true || record.deletedAt !== undefined || record.suppressedAt !== undefined ||
      !Array.isArray(record.allowedPurposeScopes) || !record.allowedPurposeScopes.includes(binding.purpose) ||
      typeof record.resolvedContent !== "string" || record.resolvedContent.trim().length === 0 ||
      !Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) {
    fail("CORRECTION_CURRENT_NOT_ELIGIBLE");
  }
  return record;
}

function candidateFor(
  input: NormalizedInput,
  current: MemoryVersionRecord,
): AdmittedMemoryCandidateIntent {
  const currentRef = copyRef(current.ref, "CORRECTION_CURRENT_REF_INVALID");
  const evidenceRef = input.correctionEvidence.ref;
  if (sameRef(currentRef, evidenceRef)) fail("CORRECTION_EVIDENCE_INVALID");
  const evidenceRefs = Object.freeze([currentRef, evidenceRef].sort(compareCanonicalObjectVersionRefs));
  const purposeScopes = Object.freeze([...new Set(current.allowedPurposeScopes)].sort());
  const proposal = {
    proposalId: `explicit-user-correction:${input.correctionEnvelope.idempotencyKey}`,
    intent: Object.freeze({ kind: "correct" as const, target: currentRef }),
    userId: input.binding.userId,
    kind: current.kind,
    slot: input.slot,
    value: Object.freeze({ text: input.newValue }),
    sourceClass: "explicit_user_correction" as const,
    evidenceRefs,
    confidencePpm: 1_000_000,
    purposeScopes,
    sensitivity: freezeJson(cloneJson(current.sensitivity)),
    validity: Object.freeze({ observedAt: input.correctionEvidence.observedAt }),
    correctionIntent: Object.freeze({ kind: "correct" as const, target: currentRef, evidenceRefs }),
    idempotencyKey: input.correctionEnvelope.idempotencyKey,
    externalInstruction: false,
    identityInference: false,
  };
  const admitted = admitMemoryProposal(proposal);
  if (admitted.status !== "candidate") fail(`CORRECTION_ADMISSION_${admitted.reasonCode}`);
  return admitted.intent;
}

function ownerResultValue<T>(value: OwnerPortResult<T>): T {
  if (!isPlainRecord(value) || value.ok !== true || !Object.prototype.hasOwnProperty.call(value, "value")) {
    fail("CORRECTION_OWNER_READ_FAILED");
  }
  return value.value as T;
}

function assertCorrectionReceipt(
  value: ProductionMemoryLifecycleExecution<MemoryCommandResult<MemoryCommitReceipt>>,
  oldRef: CanonicalObjectVersionRef,
  expectedKey: string,
  expectedRef: CanonicalObjectVersionRef,
): void {
  if (!isPlainRecord(value) || !isPlainRecord(value.value) || value.value.ok !== true) {
    fail("CORRECTION_COMMIT_REJECTED");
  }
  const receipt = value.value.receipt;
  if (!isPlainRecord(receipt) || receipt.operation !== "correction" || receipt.idempotencyKey !== expectedKey ||
      !Array.isArray(receipt.canonicalRefs) || receipt.canonicalRefs.length !== 1 ||
      !sameRef(receipt.canonicalRefs[0], expectedRef) || !Array.isArray(receipt.supersededRefs) ||
      receipt.supersededRefs.length !== 1 || !sameRef(receipt.supersededRefs[0], oldRef)) {
    fail("CORRECTION_COMMIT_RECEIPT_INVALID");
  }
}

function assertRecall(
  value: ProductionMemoryLifecycleExecution<MemoryConsumerContext>,
  oldRef: CanonicalObjectVersionRef,
  newRef: CanonicalObjectVersionRef,
  newValue: string,
): readonly string[] {
  if (!isPlainRecord(value) || !isPlainRecord(value.value) || !Array.isArray(value.value.memories) ||
      !Array.isArray(value.value.suppressions)) fail("CORRECTION_RECALL_INVALID");
  const memories = value.value.memories;
  if (memories.length !== 1 || !sameRef(memories[0]?.ref, newRef) || memories[0]?.boundedContent !== newValue ||
      memories.some((item) => sameRef(item.ref, oldRef))) {
    fail("CORRECTION_RECALL_CURRENT_INVALID");
  }
  const suppressions = value.value.suppressions as readonly { readonly ref?: unknown; readonly suppressionReasons?: unknown }[];
  const suppression = suppressions.find((item) => sameRef(item.ref, oldRef));
  if (suppression === undefined || !Array.isArray(suppression.suppressionReasons) ||
      !suppression.suppressionReasons.some((reason) => reason === "superseded" || reason === "suppressed" || reason === "non_current")) {
    fail("CORRECTION_RECALL_OLD_REF_EXPLANATION_MISSING");
  }
  return Object.freeze([...suppression.suppressionReasons]);
}

export function createExplicitUserCorrectionAdapter(
  options: ExplicitUserCorrectionAdapterOptions,
): ExplicitUserCorrectionAdapter {
  if (!isPlainRecord(options) || !isPlainRecord(options.lifecycle) ||
      typeof options.lifecycle.correctMemory !== "function" || typeof options.lifecycle.recallForAnswerContext !== "function" ||
      typeof options.reviewStateReader?.findAuthoritativeCurrentBySlot !== "function" ||
      typeof options.canonicalVersionReader?.readVersionByRef !== "function" ||
      options.issuer?.environment !== "production" || typeof options.issuer.issueCandidate !== "function" ||
      typeof options.issuer.issueMemorySuccessor !== "function" || !isPlainRecord(options.systemContext)) {
    fail("CORRECTION_CONFIGURATION_INVALID");
  }
  // ponytail: session-local single-entry replay; durable replay remains lifecycle/repository authority.
  let replayEntry: ReplayEntry | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (closed) fail("CORRECTION_ADAPTER_CLOSED");
  };

  const execute = async (rawInput: unknown): Promise<ExplicitUserCorrectionResult> => {
    assertOpen();
    if (!isPlainRecord(rawInput) || rawInput.kind !== "explicit_user_correction") {
      return Object.freeze({ handled: false as const, reason: "not_explicit_correction" as const });
    }
    const input = normalizeInput(rawInput);
    const key = input.correctionEnvelope.idempotencyKey;
    const requestFingerprint = fingerprint(input);
    const existing = replayEntry;
    if (existing !== undefined) {
      if (existing.key !== key) {
        replayEntry = undefined;
      } else {
      if (existing.fingerprint !== requestFingerprint) fail("CORRECTION_IDEMPOTENCY_CONFLICT");
      return existing.result;
      }
    }
    const result = (async (): Promise<ExplicitUserCorrectionHandled> => {
      let snapshot: Awaited<ReturnType<MemoryReviewStateReader["findAuthoritativeCurrentBySlot"]>>;
      try {
        snapshot = await options.reviewStateReader.findAuthoritativeCurrentBySlot({
          userId: input.binding.userId,
          slot: input.slot,
        });
      } catch (error) {
        fail("CORRECTION_CURRENT_READ_FAILED", error);
      }
      const current = currentRecord(snapshot, input.binding, input.slot);
      const predecessorRef = copyRef(current.ref, "CORRECTION_CURRENT_REF_INVALID");
      let rawRead: OwnerPortResult<unknown>;
      try {
        rawRead = await options.canonicalVersionReader.readVersionByRef({ ref: predecessorRef }) as OwnerPortResult<unknown>;
      } catch (error) {
        fail("CORRECTION_PREDECESSOR_READ_FAILED", error);
      }
      let read: ReturnType<typeof assertMemoryCanonicalVersionRead>;
      try {
        read = assertMemoryCanonicalVersionRead(ownerResultValue(rawRead));
      } catch (error) {
        fail("CORRECTION_PREDECESSOR_RECEIPT_INVALID", error);
      }
      predecessorPayload(read, current);
      const candidate = candidateFor(input, current);
      let candidateReceipt: ProductionMemoryIssuerReceipt;
      let successorReceipt: ProductionMemoryIssuerReceipt;
      try {
        candidateReceipt = assertProductionMemoryIssuerReceipt(options.issuer.issueCandidate({
          candidate,
          context: options.systemContext,
        }));
        if (candidateReceipt.operation !== "candidate_create") fail("CORRECTION_ISSUER_CANDIDATE_INVALID");
        successorReceipt = assertProductionMemoryIssuerReceipt(options.issuer.issueMemorySuccessor({
          candidate,
          resolvedContent: input.newValue,
          context: options.systemContext,
          candidateReceipt,
          previous: read.receipt,
          status: "current",
        }));
        if (successorReceipt.operation !== "memory_successor" || successorReceipt.memoryRef === undefined ||
            !sameRef(successorReceipt.previousRef, predecessorRef)) fail("CORRECTION_ISSUER_SUCCESSOR_INVALID");
      } catch (error) {
        if (error instanceof ExplicitUserCorrectionAdapterError) throw error;
        fail("CORRECTION_ISSUER_FAILED", error);
      }
      const correctionInput: ProductionCommitCorrectionInput = Object.freeze({
        idempotencyKey: key,
        expectedCurrentRef: predecessorRef,
        candidate,
        resolvedContent: input.newValue,
        issuerReceipt: successorReceipt,
      });
      let correction: ProductionMemoryLifecycleExecution<MemoryCommandResult<MemoryCommitReceipt>>;
      try {
        correction = await options.lifecycle.correctMemory({
          envelope: input.correctionEnvelope,
          input: correctionInput,
        });
      } catch (error) {
        fail("CORRECTION_LIFECYCLE_FAILED", error);
      }
      const successorRef = copyRef(successorReceipt.memoryRef, "CORRECTION_ISSUER_SUCCESSOR_INVALID");
      assertCorrectionReceipt(correction, predecessorRef, key, successorRef);
      const frozenCorrection = freezeJson(cloneJson(correction)) as typeof correction;
      let recall: ProductionMemoryLifecycleExecution<MemoryConsumerContext>;
      try {
        recall = await options.lifecycle.recallForAnswerContext({
          envelope: input.recallEnvelope,
          input: input.recallInput,
        });
      } catch (error) {
        fail("CORRECTION_RECALL_FAILED", error);
      }
      const frozenRecall = freezeJson(cloneJson(recall)) as typeof recall;
      const oldRefSuppressionReasons = assertRecall(frozenRecall, predecessorRef, successorRef, input.newValue);
      const handled: ExplicitUserCorrectionHandled = Object.freeze({
        handled: true,
        idempotencyKey: key,
        predecessorRef,
        successorRef,
        correction: frozenCorrection,
        recall: frozenRecall,
        oldRefSuppressionReasons,
      });
      return handled;
    })();
    const entry = Object.freeze({ key, fingerprint: requestFingerprint, result });
    replayEntry = entry;
    try {
      return await result;
    } catch (error) {
      if (replayEntry === entry) replayEntry = undefined;
      throw error;
    }
  };

  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => {
      closed = true;
      replayEntry = undefined;
    });
    return closePromise;
  };

  return Object.freeze({ execute, close });
}
