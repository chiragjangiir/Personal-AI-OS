import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  claimIdempotency,
  completeIdempotency,
  completeIndeterminate,
  IdempotencyConflictError,
  type IdempotencyRecord,
} from "./idempotency-ledger.ts";
import { enqueueOutboxEvent } from "./transactional-outbox.ts";
import { withTransaction } from "./transaction.ts";

export const REALTIME_CONVERSATION_TURN_SCOPE = "realtime.conversation_turn.v1" as const;
export const REALTIME_CONVERSATION_TURN_EVENT = "realtime.conversation.turn.completed.v1" as const;
export const REALTIME_CONVERSATION_TURN_SCHEMA = "realtime.conversation.turn.completed.v1" as const;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/u;
const SEGMENT_ID = /^rayneo_segment_[a-f0-9]{20}$/u;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const MAX_HISTORY = 32;

type JsonRecord = Record<string, unknown>;
type InputKind = "typed" | "audio" | "visual";

export interface ConversationTurnCanonicalRef extends Readonly<Record<string, unknown>> {
  readonly ref_type: string;
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

export interface RealtimeConversationTurnBinding {
  readonly realtimeSessionRef: ConversationTurnCanonicalRef;
  readonly deviceLeaseRef: ConversationTurnCanonicalRef;
  readonly continuityId: string;
  readonly connectionEpoch: string;
  readonly leaseVersion: string;
}

export interface RealtimeConversationTurnClaimInput {
  readonly idempotencyKey: string;
  readonly idempotencyPayloadSha256: string;
  readonly binding: RealtimeConversationTurnBinding;
  readonly inputKind: InputKind;
  readonly inputId: string;
  readonly userText?: string;
  readonly userTextSha256?: string;
  readonly finalTranscriptEvidenceRef?: ConversationTurnCanonicalRef;
  readonly sourceVisualRefs?: readonly ConversationTurnCanonicalRef[];
}

export interface RealtimeConversationTurnCompletionInput {
  readonly claim: RealtimeConversationTurnClaimInput;
  readonly assistantText: string;
  readonly assistantTextSha256: string;
  readonly publishObservation: Readonly<{
    readonly state: "confirmed" | "ambiguous";
    readonly observedAt: string;
  }>;
}

export interface RealtimeConversationTurnReceipt extends Readonly<Record<string, unknown>> {
  readonly schema: typeof REALTIME_CONVERSATION_TURN_SCHEMA;
  readonly receipt_id: string;
  readonly idempotency_scope: typeof REALTIME_CONVERSATION_TURN_SCOPE;
  readonly idempotency_key: string;
  readonly idempotency_payload_sha256: string;
  readonly committed_at: string;
  readonly realtime_session_ref: ConversationTurnCanonicalRef;
  readonly device_lease_ref: ConversationTurnCanonicalRef;
  readonly continuity_id: string;
  readonly connection_epoch: string;
  readonly lease_version: string;
  readonly input_kind: InputKind;
  readonly input_id: string;
  readonly final_transcript_evidence_ref?: ConversationTurnCanonicalRef;
  readonly source_visual_refs?: readonly ConversationTurnCanonicalRef[];
  readonly user_text?: string;
  readonly user_text_sha256?: string;
  readonly assistant_text: string;
  readonly assistant_text_sha256: string;
  readonly delivery_state: "completed" | "indeterminate";
  readonly publish_observation: Readonly<{ readonly state: "confirmed" | "ambiguous"; readonly observed_at: string }>;
}

export type RealtimeConversationTurnClaimResult =
  | Readonly<{ readonly kind: "claimed"; readonly retryAllowed: false }>
  | Readonly<{ readonly kind: "replay"; readonly retryAllowed: false; readonly receipt: RealtimeConversationTurnReceipt }>
  | Readonly<{ readonly kind: "in_flight"; readonly retryAllowed: false }>
  | Readonly<{ readonly kind: "indeterminate"; readonly retryAllowed: false; readonly receipt: RealtimeConversationTurnReceipt }>
  | Readonly<{ readonly kind: "conflict"; readonly retryAllowed: false }>;

export interface RealtimeConversationTurnPostgres {
  beginClaim(input: RealtimeConversationTurnClaimInput): Promise<RealtimeConversationTurnClaimResult>;
  commitCompletedAfterPublish(input: RealtimeConversationTurnCompletionInput): Promise<RealtimeConversationTurnReceipt>;
  markIndeterminate(input: RealtimeConversationTurnCompletionInput): Promise<RealtimeConversationTurnReceipt>;
  releaseBeforePublish(input: RealtimeConversationTurnClaimInput): Promise<boolean>;
  readByInput(input: RealtimeConversationTurnClaimInput): Promise<RealtimeConversationTurnClaimResult | undefined>;
  readRecentCompleted(input: Readonly<{ readonly binding: RealtimeConversationTurnBinding; readonly limit: number }>): Promise<readonly RealtimeConversationTurnReceipt[]>;
}

export class RealtimeConversationTurnPostgresError extends Error {
  readonly code: string;
  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "RealtimeConversationTurnPostgresError";
    this.code = code;
  }
}

function fail(code: string, cause?: unknown): never {
  throw cause === undefined
    ? new RealtimeConversationTurnPostgresError(code)
    : new RealtimeConversationTurnPostgresError(code, { cause });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail(code);
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      actual.some((key) => !allowed.includes(key))) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  return value;
}

function cloneJson(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CONVERSATION_TURN_JSON_INVALID");
    return value;
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) {
    fail("CONVERSATION_TURN_JSON_INVALID");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy = value.map((item, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("CONVERSATION_TURN_JSON_INVALID");
        return cloneJson(item, ancestors);
      });
      return Object.freeze(copy);
    }
    const record = exactRecord(value, [], Object.keys(value), "CONVERSATION_TURN_JSON_INVALID");
    const copy: JsonRecord = {};
    for (const key of Object.keys(record).sort()) copy[key] = cloneJson(record[key], ancestors);
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(cloneJson(value));
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function timestamp(value: unknown, code = "CONVERSATION_TURN_TIME_INVALID"): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return value;
}

function positiveDecimal(value: unknown, code: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) fail(code);
  return value;
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function text(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximum ||
      FORBIDDEN_TEXT.test(value) || value.normalize("NFC") !== value || Buffer.from(value, "utf8").toString("utf8") !== value) {
    fail(code);
  }
  return value;
}

function textWithHash(value: unknown, digest: unknown, maximum: number, code: string): readonly [string, string] {
  const normalized = text(value, maximum, code);
  if (typeof digest !== "string" || !SHA256.test(digest) || hashText(normalized) !== digest) fail(code);
  return [normalized, digest] as const;
}

function canonicalRef(value: unknown, allowedTypes: readonly string[], code: string): ConversationTurnCanonicalRef {
  const record = exactRecord(value, ["ref_type", "ref_id", "object_version", "canonical_payload_sha256"], [], code);
  if (typeof record.ref_type !== "string" || !allowedTypes.includes(record.ref_type) ||
      typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256)) fail(code);
  return Object.freeze({
    ref_type: record.ref_type,
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

function binding(value: unknown): RealtimeConversationTurnBinding {
  const record = exactRecord(value, ["realtimeSessionRef", "deviceLeaseRef", "continuityId", "connectionEpoch", "leaseVersion"], [], "CONVERSATION_TURN_BINDING_INVALID");
  if (typeof record.continuityId !== "string" || !UUID_V7.test(record.continuityId)) fail("CONVERSATION_TURN_BINDING_INVALID");
  return Object.freeze({
    realtimeSessionRef: canonicalRef(record.realtimeSessionRef, ["RealtimeSession"], "CONVERSATION_TURN_SESSION_REF_INVALID"),
    deviceLeaseRef: canonicalRef(record.deviceLeaseRef, ["DeviceLease"], "CONVERSATION_TURN_LEASE_REF_INVALID"),
    continuityId: record.continuityId,
    connectionEpoch: positiveDecimal(record.connectionEpoch, "CONVERSATION_TURN_EPOCH_INVALID"),
    leaseVersion: positiveDecimal(record.leaseVersion, "CONVERSATION_TURN_LEASE_VERSION_INVALID"),
  });
}

type NormalizedClaim = Readonly<{
  idempotencyKey: string;
  idempotencyPayloadSha256: string;
  binding: RealtimeConversationTurnBinding;
  inputKind: InputKind;
  inputId: string;
  userText?: string;
  userTextSha256?: string;
  finalTranscriptEvidenceRef?: ConversationTurnCanonicalRef;
  sourceVisualRefs?: readonly ConversationTurnCanonicalRef[];
}>;

function claimPayload(input: Omit<NormalizedClaim, "idempotencyKey" | "idempotencyPayloadSha256">): JsonRecord {
  return {
    realtime_session_ref: input.binding.realtimeSessionRef,
    device_lease_ref: input.binding.deviceLeaseRef,
    continuity_id: input.binding.continuityId,
    connection_epoch: input.binding.connectionEpoch,
    lease_version: input.binding.leaseVersion,
    input_kind: input.inputKind,
    input_id: input.inputId,
    ...(input.userText === undefined ? {} : { user_text: input.userText, user_text_sha256: input.userTextSha256 }),
    ...(input.finalTranscriptEvidenceRef === undefined ? {} : { final_transcript_evidence_ref: input.finalTranscriptEvidenceRef }),
    ...(input.sourceVisualRefs === undefined ? {} : { source_visual_refs: input.sourceVisualRefs }),
  };
}

function normalizeClaim(value: RealtimeConversationTurnClaimInput): NormalizedClaim {
  const record = exactRecord(value, ["idempotencyKey", "idempotencyPayloadSha256", "binding", "inputKind", "inputId"],
    ["userText", "userTextSha256", "finalTranscriptEvidenceRef", "sourceVisualRefs"], "CONVERSATION_TURN_CLAIM_INVALID");
  if (typeof record.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(record.idempotencyKey) ||
      typeof record.idempotencyPayloadSha256 !== "string" || !SHA256.test(record.idempotencyPayloadSha256) ||
      (record.inputKind !== "typed" && record.inputKind !== "audio" && record.inputKind !== "visual") ||
      typeof record.inputId !== "string") fail("CONVERSATION_TURN_CLAIM_INVALID");
  const normalizedBinding = binding(record.binding);
  let userText: string | undefined;
  let userTextSha256: string | undefined;
  let finalTranscriptEvidenceRef: ConversationTurnCanonicalRef | undefined;
  let sourceVisualRefs: readonly ConversationTurnCanonicalRef[] | undefined;
  if (record.inputKind === "typed") {
    if (!IDEMPOTENCY_KEY.test(record.inputId) || record.finalTranscriptEvidenceRef !== undefined || record.sourceVisualRefs !== undefined) {
      fail("CONVERSATION_TURN_TYPED_INPUT_INVALID");
    }
    [userText, userTextSha256] = textWithHash(record.userText, record.userTextSha256, 8192, "CONVERSATION_TURN_USER_TEXT_INVALID");
  } else if (record.inputKind === "audio") {
    if (!SEGMENT_ID.test(record.inputId)) fail("CONVERSATION_TURN_AUDIO_INPUT_INVALID");
    [userText, userTextSha256] = textWithHash(record.userText, record.userTextSha256, 8192, "CONVERSATION_TURN_USER_TEXT_INVALID");
    finalTranscriptEvidenceRef = canonicalRef(record.finalTranscriptEvidenceRef, ["FinalTranscriptEvidence"], "CONVERSATION_TURN_FINAL_EVIDENCE_INVALID");
  } else {
    if (!SEGMENT_ID.test(record.inputId) || record.userText !== undefined || record.userTextSha256 !== undefined ||
        record.finalTranscriptEvidenceRef !== undefined) fail("CONVERSATION_TURN_VISUAL_INPUT_INVALID");
  }
  if (record.sourceVisualRefs !== undefined) {
    if (!Array.isArray(record.sourceVisualRefs) || record.sourceVisualRefs.length < 1 || record.sourceVisualRefs.length > 8) {
      fail("CONVERSATION_TURN_VISUAL_REFS_INVALID");
    }
    const refs = record.sourceVisualRefs.map((item) => canonicalRef(item, ["SourceArtifact", "ArtifactVersion"], "CONVERSATION_TURN_VISUAL_REFS_INVALID"));
    if (new Set(refs.map(canonicalJson)).size !== refs.length) fail("CONVERSATION_TURN_VISUAL_REFS_INVALID");
    sourceVisualRefs = Object.freeze(refs);
  }
  if (record.inputKind === "visual" && sourceVisualRefs === undefined) fail("CONVERSATION_TURN_VISUAL_REFS_INVALID");
  const payloadInput: Omit<NormalizedClaim, "idempotencyKey" | "idempotencyPayloadSha256"> = Object.freeze({
    binding: normalizedBinding,
    inputKind: record.inputKind,
    inputId: record.inputId,
    ...(userText === undefined ? {} : { userText, userTextSha256: userTextSha256 as string }),
    ...(finalTranscriptEvidenceRef === undefined ? {} : { finalTranscriptEvidenceRef }),
    ...(sourceVisualRefs === undefined ? {} : { sourceVisualRefs }),
  });
  if (hashJson(claimPayload(payloadInput)) !== record.idempotencyPayloadSha256) fail("CONVERSATION_TURN_IDEMPOTENCY_HASH_INVALID");
  return Object.freeze({
    idempotencyKey: record.idempotencyKey,
    idempotencyPayloadSha256: record.idempotencyPayloadSha256,
    ...payloadInput,
  });
}

export function conversationTurnIdempotencyPayloadSha256(
  input: Omit<RealtimeConversationTurnClaimInput, "idempotencyKey" | "idempotencyPayloadSha256">,
): string {
  const provisional = { ...input, idempotencyKey: "conversation-turn-hash-only", idempotencyPayloadSha256: "0".repeat(64) };
  const record = exactRecord(provisional, ["idempotencyKey", "idempotencyPayloadSha256", "binding", "inputKind", "inputId"],
    ["userText", "userTextSha256", "finalTranscriptEvidenceRef", "sourceVisualRefs"], "CONVERSATION_TURN_CLAIM_INVALID");
  record.idempotencyPayloadSha256 = "0".repeat(64);
  try {
    const normalizedBinding = binding(record.binding);
    const kind = record.inputKind;
    if (kind !== "typed" && kind !== "audio" && kind !== "visual") fail("CONVERSATION_TURN_CLAIM_INVALID");
    const withDigest = normalizeClaim({ ...input, idempotencyKey: "conversation-turn-hash-only", idempotencyPayloadSha256: hashJson(claimPayload({
      binding: normalizedBinding,
      inputKind: kind,
      inputId: String(record.inputId),
      ...(record.userText === undefined ? {} : { userText: String(record.userText), userTextSha256: String(record.userTextSha256) }),
      ...(record.finalTranscriptEvidenceRef === undefined ? {} : { finalTranscriptEvidenceRef: canonicalRef(record.finalTranscriptEvidenceRef, ["FinalTranscriptEvidence"], "CONVERSATION_TURN_FINAL_EVIDENCE_INVALID") }),
      ...(record.sourceVisualRefs === undefined ? {} : { sourceVisualRefs: Object.freeze((record.sourceVisualRefs as unknown[]).map((item) => canonicalRef(item, ["SourceArtifact", "ArtifactVersion"], "CONVERSATION_TURN_VISUAL_REFS_INVALID"))) }),
    })) });
    return withDigest.idempotencyPayloadSha256;
  } catch (error) {
    if (error instanceof RealtimeConversationTurnPostgresError) throw error;
    return fail("CONVERSATION_TURN_CLAIM_INVALID", error);
  }
}

function normalizeCompletion(value: RealtimeConversationTurnCompletionInput, state: "completed" | "indeterminate") {
  const record = exactRecord(value, ["claim", "assistantText", "assistantTextSha256", "publishObservation"], [], "CONVERSATION_TURN_COMPLETION_INVALID");
  const normalizedClaim = normalizeClaim(record.claim as RealtimeConversationTurnClaimInput);
  const [assistantText, assistantTextSha256] = textWithHash(record.assistantText, record.assistantTextSha256, 16384, "CONVERSATION_TURN_ASSISTANT_TEXT_INVALID");
  const observation = exactRecord(record.publishObservation, ["state", "observedAt"], [], "CONVERSATION_TURN_PUBLISH_OBSERVATION_INVALID");
  const requiredObservation = state === "completed" ? "confirmed" : "ambiguous";
  if (observation.state !== requiredObservation) fail("CONVERSATION_TURN_PUBLISH_OBSERVATION_INVALID");
  return Object.freeze({
    claim: normalizedClaim,
    assistantText,
    assistantTextSha256,
    publishObservation: Object.freeze({ state: requiredObservation, observedAt: timestamp(observation.observedAt) }),
  });
}

function uuidV7(at: string): string {
  const milliseconds = BigInt(Date.parse(at));
  if (milliseconds < 0n || milliseconds >= (1n << 48n)) fail("CONVERSATION_TURN_TIME_INVALID");
  const bytes = randomBytes(16);
  let cursor = milliseconds;
  for (let index = 5; index >= 0; index -= 1) { bytes[index] = Number(cursor & 0xffn); cursor >>= 8n; }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BINDING_SELECT = [
  "SELECT s.realtime_session_ref AS s_ref, s.continuity_id::text AS s_continuity_id,",
  "s.state AS s_state, s.continuity_state AS s_continuity_state, s.connection_epoch::text AS s_epoch,",
  "s.continuity_expires_at > transaction_timestamp() AS s_current, s.active_device_lease_ref AS s_active_lease_ref,",
  "s.binding AS s_binding, l.device_lease_ref AS l_ref, l.realtime_session_ref AS l_session_ref,",
  "l.continuity_id::text AS l_continuity_id, l.state AS l_state, l.lease_version::text AS l_version,",
  "l.expires_at > transaction_timestamp() AS l_current",
  "FROM realtime_sessions AS s JOIN device_leases AS l ON l.session_ref_id = s.session_ref_id",
  "WHERE s.session_ref_id = $1::uuid AND l.lease_ref_id = $2::uuid",
].join(" ");

async function assertStoredBinding(client: PoolClient, value: RealtimeConversationTurnBinding, current: boolean, lock: boolean): Promise<void> {
  const result = await client.query(BINDING_SELECT + (lock ? " FOR UPDATE OF s, l" : ""),
    [value.realtimeSessionRef.ref_id, value.deviceLeaseRef.ref_id]);
  if (result.rows.length !== 1) fail("CONVERSATION_TURN_BINDING_MISSING");
  const row = result.rows[0]!;
  const storedSessionRef = canonicalRef(row.s_ref, ["RealtimeSession"], "CONVERSATION_TURN_BINDING_DRIFT");
  const storedLeaseRef = canonicalRef(row.l_ref, ["DeviceLease"], "CONVERSATION_TURN_BINDING_DRIFT");
  const storedLeaseSessionRef = canonicalRef(row.l_session_ref, ["RealtimeSession"], "CONVERSATION_TURN_BINDING_DRIFT");
  if (!sameJson(storedSessionRef, value.realtimeSessionRef) || !sameJson(storedLeaseRef, value.deviceLeaseRef) ||
      !sameJson(storedLeaseSessionRef, value.realtimeSessionRef) || row.s_continuity_id !== value.continuityId ||
      row.l_continuity_id !== value.continuityId) fail("CONVERSATION_TURN_BINDING_DRIFT");
  const storedEpoch = positiveDecimal(String(row.s_epoch), "CONVERSATION_TURN_BINDING_DRIFT");
  const storedVersion = positiveDecimal(String(row.l_version), "CONVERSATION_TURN_BINDING_DRIFT");
  if (!current) {
    if (compareDecimal(storedEpoch, value.connectionEpoch) < 0 || compareDecimal(storedVersion, value.leaseVersion) < 0) {
      fail("CONVERSATION_TURN_HISTORICAL_BINDING_DRIFT");
    }
    return;
  }
  if (storedEpoch !== value.connectionEpoch || storedVersion !== value.leaseVersion) fail("CONVERSATION_TURN_BINDING_DRIFT");
  const transport = isPlainRecord(row.s_binding) ? row.s_binding : undefined;
  if (row.s_state !== "active" || row.s_continuity_state !== "active" || row.l_state !== "active" ||
      row.s_current !== true || row.l_current !== true || !sameJson(row.s_active_lease_ref, value.deviceLeaseRef) ||
      transport?.state !== "connected" || !sameJson(transport.realtimeSessionRef, value.realtimeSessionRef) ||
      !sameJson(transport.deviceLeaseRef, value.deviceLeaseRef) || transport.continuityId !== value.continuityId ||
      String(transport.connectionEpoch) !== value.connectionEpoch) fail("CONVERSATION_TURN_CURRENT_BINDING_INVALID");
}

function receiptFrom(input: ReturnType<typeof normalizeCompletion>, deliveryState: "completed" | "indeterminate", committedAt: string): RealtimeConversationTurnReceipt {
  const claim = input.claim;
  return validateReceipt({
    schema: REALTIME_CONVERSATION_TURN_SCHEMA,
    receipt_id: uuidV7(committedAt),
    idempotency_scope: REALTIME_CONVERSATION_TURN_SCOPE,
    idempotency_key: claim.idempotencyKey,
    idempotency_payload_sha256: claim.idempotencyPayloadSha256,
    committed_at: committedAt,
    realtime_session_ref: claim.binding.realtimeSessionRef,
    device_lease_ref: claim.binding.deviceLeaseRef,
    continuity_id: claim.binding.continuityId,
    connection_epoch: claim.binding.connectionEpoch,
    lease_version: claim.binding.leaseVersion,
    input_kind: claim.inputKind,
    input_id: claim.inputId,
    ...(claim.userText === undefined ? {} : { user_text: claim.userText, user_text_sha256: claim.userTextSha256 }),
    ...(claim.finalTranscriptEvidenceRef === undefined ? {} : { final_transcript_evidence_ref: claim.finalTranscriptEvidenceRef }),
    ...(claim.sourceVisualRefs === undefined ? {} : { source_visual_refs: claim.sourceVisualRefs }),
    assistant_text: input.assistantText,
    assistant_text_sha256: input.assistantTextSha256,
    delivery_state: deliveryState,
    publish_observation: { state: input.publishObservation.state, observed_at: input.publishObservation.observedAt },
  });
}

function claimFromReceipt(receipt: RealtimeConversationTurnReceipt): RealtimeConversationTurnClaimInput {
  return {
    idempotencyKey: receipt.idempotency_key,
    idempotencyPayloadSha256: receipt.idempotency_payload_sha256,
    binding: {
      realtimeSessionRef: receipt.realtime_session_ref,
      deviceLeaseRef: receipt.device_lease_ref,
      continuityId: receipt.continuity_id,
      connectionEpoch: receipt.connection_epoch,
      leaseVersion: receipt.lease_version,
    },
    inputKind: receipt.input_kind,
    inputId: receipt.input_id,
    ...(receipt.user_text === undefined ? {} : { userText: receipt.user_text, userTextSha256: receipt.user_text_sha256 }),
    ...(receipt.final_transcript_evidence_ref === undefined ? {} : { finalTranscriptEvidenceRef: receipt.final_transcript_evidence_ref }),
    ...(receipt.source_visual_refs === undefined ? {} : { sourceVisualRefs: receipt.source_visual_refs }),
  };
}

function validateReceipt(value: unknown): RealtimeConversationTurnReceipt {
  const required = ["schema", "receipt_id", "idempotency_scope", "idempotency_key", "idempotency_payload_sha256", "committed_at",
    "realtime_session_ref", "device_lease_ref", "continuity_id", "connection_epoch", "lease_version", "input_kind", "input_id",
    "assistant_text", "assistant_text_sha256", "delivery_state", "publish_observation"];
  const record = exactRecord(value, required, ["user_text", "user_text_sha256", "final_transcript_evidence_ref", "source_visual_refs"], "CONVERSATION_TURN_RECEIPT_INVALID");
  if (record.schema !== REALTIME_CONVERSATION_TURN_SCHEMA || typeof record.receipt_id !== "string" || !UUID_V7.test(record.receipt_id) ||
      record.idempotency_scope !== REALTIME_CONVERSATION_TURN_SCOPE || typeof record.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(record.idempotency_key) ||
      typeof record.idempotency_payload_sha256 !== "string" || !SHA256.test(record.idempotency_payload_sha256) ||
      (record.delivery_state !== "completed" && record.delivery_state !== "indeterminate")) fail("CONVERSATION_TURN_RECEIPT_INVALID");
  const sessionRef = canonicalRef(record.realtime_session_ref, ["RealtimeSession"], "CONVERSATION_TURN_RECEIPT_INVALID");
  const leaseRef = canonicalRef(record.device_lease_ref, ["DeviceLease"], "CONVERSATION_TURN_RECEIPT_INVALID");
  if (typeof record.continuity_id !== "string" || !UUID_V7.test(record.continuity_id) ||
      (record.input_kind !== "typed" && record.input_kind !== "audio" && record.input_kind !== "visual") || typeof record.input_id !== "string") {
    fail("CONVERSATION_TURN_RECEIPT_INVALID");
  }
  const assistant = textWithHash(record.assistant_text, record.assistant_text_sha256, 16384, "CONVERSATION_TURN_ASSISTANT_TEXT_INVALID");
  const observation = exactRecord(record.publish_observation, ["state", "observed_at"], [], "CONVERSATION_TURN_RECEIPT_INVALID");
  const expectedObservation = record.delivery_state === "completed" ? "confirmed" : "ambiguous";
  if (observation.state !== expectedObservation) fail("CONVERSATION_TURN_RECEIPT_INVALID");
  const reconstructed = normalizeClaim({
    idempotencyKey: record.idempotency_key,
    idempotencyPayloadSha256: record.idempotency_payload_sha256,
    binding: {
      realtimeSessionRef: sessionRef,
      deviceLeaseRef: leaseRef,
      continuityId: record.continuity_id,
      connectionEpoch: positiveDecimal(record.connection_epoch, "CONVERSATION_TURN_RECEIPT_INVALID"),
      leaseVersion: positiveDecimal(record.lease_version, "CONVERSATION_TURN_RECEIPT_INVALID"),
    },
    inputKind: record.input_kind,
    inputId: record.input_id,
    ...(record.user_text === undefined ? {} : { userText: record.user_text as string, userTextSha256: record.user_text_sha256 as string }),
    ...(record.final_transcript_evidence_ref === undefined ? {} : { finalTranscriptEvidenceRef: record.final_transcript_evidence_ref as ConversationTurnCanonicalRef }),
    ...(record.source_visual_refs === undefined ? {} : { sourceVisualRefs: record.source_visual_refs as readonly ConversationTurnCanonicalRef[] }),
  });
  return cloneJson({
    ...record,
    committed_at: timestamp(record.committed_at),
    publish_observation: { state: expectedObservation, observed_at: timestamp(observation.observed_at) },
    realtime_session_ref: reconstructed.binding.realtimeSessionRef,
    device_lease_ref: reconstructed.binding.deviceLeaseRef,
    assistant_text: assistant[0],
    assistant_text_sha256: assistant[1],
  }) as RealtimeConversationTurnReceipt;
}

async function transactionTime(client: PoolClient): Promise<string> {
  const result = await client.query("SELECT transaction_timestamp() AS transaction_time");
  if (result.rows.length !== 1) fail("CONVERSATION_TURN_TIME_INVALID");
  const value = result.rows[0]!.transaction_time;
  return timestamp(value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
}

function ledgerFromRow(row: QueryResultRow): IdempotencyRecord {
  const status = row.status;
  if (row.scope !== REALTIME_CONVERSATION_TURN_SCOPE || typeof row.idempotency_key !== "string" ||
      typeof row.request_hash !== "string" || !SHA256.test(row.request_hash) ||
      (status !== "in_flight" && status !== "committed" && status !== "indeterminate" && status !== "failed")) {
    fail("CONVERSATION_TURN_LEDGER_DRIFT");
  }
  const response = row.response === null || row.response === undefined ? undefined : cloneJson(row.response);
  const responseHash = row.response_hash === null || row.response_hash === undefined ? undefined : String(row.response_hash);
  if ((response === undefined) !== (responseHash === undefined) ||
      (response !== undefined && (!SHA256.test(responseHash!) || hashJson(response) !== responseHash))) fail("CONVERSATION_TURN_LEDGER_DRIFT");
  return Object.freeze({ scope: REALTIME_CONVERSATION_TURN_SCOPE, idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash, status, response, ...(responseHash === undefined ? {} : { responseHash }) });
}

async function outboxRows(client: PoolClient, key: string): Promise<readonly QueryResultRow[]> {
  const result = await client.query([
    "SELECT event_id::text, aggregate_type, aggregate_id::text, event_type, event_version, idempotency_scope,",
    "idempotency_key, payload, payload_sha256, status FROM outbox_events",
    "WHERE idempotency_scope = $1 AND idempotency_key = $2 AND event_type = $3",
  ].join(" "), [REALTIME_CONVERSATION_TURN_SCOPE, key, REALTIME_CONVERSATION_TURN_EVENT]);
  return result.rows;
}

async function storedResult(client: PoolClient, record: IdempotencyRecord): Promise<RealtimeConversationTurnClaimResult> {
  if (record.status === "in_flight") return Object.freeze({ kind: "in_flight", retryAllowed: false });
  if (record.status === "failed") return Object.freeze({ kind: "conflict", retryAllowed: false });
  if (record.response === undefined) fail("CONVERSATION_TURN_LEDGER_DRIFT");
  const receipt = validateReceipt(record.response);
  if (receipt.idempotency_key !== record.idempotencyKey || receipt.idempotency_payload_sha256 !== record.requestHash ||
      hashJson(receipt) !== record.responseHash) fail("CONVERSATION_TURN_LEDGER_DRIFT");
  await assertStoredBinding(client, binding({
    realtimeSessionRef: receipt.realtime_session_ref, deviceLeaseRef: receipt.device_lease_ref,
    continuityId: receipt.continuity_id, connectionEpoch: receipt.connection_epoch, leaseVersion: receipt.lease_version,
  }), false, false);
  const events = await outboxRows(client, record.idempotencyKey);
  if (record.status === "indeterminate") {
    if (receipt.delivery_state !== "indeterminate" || events.length !== 0) fail("CONVERSATION_TURN_INDETERMINATE_DRIFT");
    return Object.freeze({ kind: "indeterminate", retryAllowed: false, receipt });
  }
  if (record.status !== "committed" || receipt.delivery_state !== "completed" || events.length !== 1) {
    fail("CONVERSATION_TURN_COMPLETED_DRIFT");
  }
  const event = events[0]!;
  if (event.event_id !== receipt.receipt_id || event.aggregate_type !== "RealtimeSession" ||
      event.aggregate_id !== receipt.realtime_session_ref.ref_id || event.event_type !== REALTIME_CONVERSATION_TURN_EVENT ||
      Number(event.event_version) !== 1 || event.idempotency_scope !== REALTIME_CONVERSATION_TURN_SCOPE ||
      event.idempotency_key !== receipt.idempotency_key || event.payload_sha256 !== hashJson(receipt) ||
      !sameJson(event.payload, receipt)) fail("CONVERSATION_TURN_OUTBOX_DRIFT");
  return Object.freeze({ kind: "replay", retryAllowed: false, receipt });
}

async function selectLedger(client: PoolClient, key: string): Promise<IdempotencyRecord | undefined> {
  const result = await client.query([
    "SELECT scope, idempotency_key, request_hash, status, response, response_hash, fencing_epoch",
    "FROM idempotency_ledger WHERE scope = $1 AND idempotency_key = $2",
  ].join(" "), [REALTIME_CONVERSATION_TURN_SCOPE, key]);
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1) fail("CONVERSATION_TURN_LEDGER_DUPLICATE");
  return ledgerFromRow(result.rows[0]!);
}

export function createRealtimeConversationTurnPostgres(pool: Pool): RealtimeConversationTurnPostgres {
  if (!pool || typeof pool.connect !== "function") fail("CONVERSATION_TURN_POOL_REQUIRED");
  const beginClaim = async (raw: RealtimeConversationTurnClaimInput): Promise<RealtimeConversationTurnClaimResult> => {
    const input = normalizeClaim(raw);
    return withTransaction(pool, async (client) => {
      await assertStoredBinding(client, input.binding, true, true);
      try {
        const claim = await claimIdempotency(client, { scope: REALTIME_CONVERSATION_TURN_SCOPE,
          idempotencyKey: input.idempotencyKey, requestHash: input.idempotencyPayloadSha256,
          fencingEpoch: input.binding.connectionEpoch });
        if (claim.kind === "new") return Object.freeze({ kind: "claimed", retryAllowed: false });
        return storedResult(client, claim.record);
      } catch (error) {
        if (error instanceof IdempotencyConflictError) return Object.freeze({ kind: "conflict", retryAllowed: false });
        throw error;
      }
    }, { isolation: "SERIALIZABLE" });
  };

  const complete = async (raw: RealtimeConversationTurnCompletionInput, state: "completed" | "indeterminate") => {
    const input = normalizeCompletion(raw, state);
    return withTransaction(pool, async (client) => {
      await assertStoredBinding(client, input.claim.binding, state === "completed", true);
      const claim = await claimIdempotency(client, { scope: REALTIME_CONVERSATION_TURN_SCOPE,
        idempotencyKey: input.claim.idempotencyKey, requestHash: input.claim.idempotencyPayloadSha256,
        fencingEpoch: input.claim.binding.connectionEpoch });
      if (claim.kind === "new") fail("CONVERSATION_TURN_CLAIM_REQUIRED");
      if (claim.kind === "replay" || claim.kind === "terminal") {
        const stored = await storedResult(client, claim.record);
        if (state === "completed") {
          if (stored.kind !== "replay") fail("CONVERSATION_TURN_TERMINAL_CONFLICT");
          return stored.receipt;
        }
        if (stored.kind !== "indeterminate") fail("CONVERSATION_TURN_TERMINAL_CONFLICT");
        return stored.receipt;
      }
      const committedAt = await transactionTime(client);
      const receipt = receiptFrom(input, state, committedAt);
      const receiptHash = hashJson(receipt);
      if (state === "completed") {
        await enqueueOutboxEvent(client, {
          eventId: receipt.receipt_id,
          aggregateType: "RealtimeSession",
          aggregateId: receipt.realtime_session_ref.ref_id,
          eventType: REALTIME_CONVERSATION_TURN_EVENT,
          eventVersion: 1,
          idempotencyScope: REALTIME_CONVERSATION_TURN_SCOPE,
          idempotencyKey: receipt.idempotency_key,
          payload: receipt,
          payloadHash: receiptHash,
        });
        await completeIdempotency(client, { scope: REALTIME_CONVERSATION_TURN_SCOPE,
          idempotencyKey: input.claim.idempotencyKey, requestHash: input.claim.idempotencyPayloadSha256,
          fencingEpoch: input.claim.binding.connectionEpoch }, receipt, receiptHash);
      } else {
        await completeIndeterminate(client, { scope: REALTIME_CONVERSATION_TURN_SCOPE,
          idempotencyKey: input.claim.idempotencyKey, requestHash: input.claim.idempotencyPayloadSha256,
          fencingEpoch: input.claim.binding.connectionEpoch }, receipt, receiptHash);
      }
      return receipt;
    }, { isolation: "SERIALIZABLE" });
  };

  const releaseBeforePublish = async (raw: RealtimeConversationTurnClaimInput): Promise<boolean> => {
    const input = normalizeClaim(raw);
    return withTransaction(pool, async (client) => {
      const result = await client.query([
        "DELETE FROM idempotency_ledger AS l WHERE l.scope = $1 AND l.idempotency_key = $2",
        "AND l.request_hash = $3 AND l.status = 'in_flight' AND NOT EXISTS (",
        "SELECT 1 FROM outbox_events AS o WHERE o.idempotency_scope = l.scope AND o.idempotency_key = l.idempotency_key)",
      ].join(" "), [REALTIME_CONVERSATION_TURN_SCOPE, input.idempotencyKey, input.idempotencyPayloadSha256]);
      return result.rowCount === 1;
    }, { isolation: "SERIALIZABLE" });
  };

  const readByInput = async (raw: RealtimeConversationTurnClaimInput): Promise<RealtimeConversationTurnClaimResult | undefined> => {
    const input = normalizeClaim(raw);
    return withTransaction(pool, async (client) => {
      const record = await selectLedger(client, input.idempotencyKey);
      if (record === undefined) return undefined;
      if (record.requestHash !== input.idempotencyPayloadSha256) return Object.freeze({ kind: "conflict", retryAllowed: false });
      return storedResult(client, record);
    }, { isolation: "REPEATABLE READ", readOnly: true });
  };

  const readRecentCompleted = async (raw: Readonly<{ readonly binding: RealtimeConversationTurnBinding; readonly limit: number }>) => {
    const record = exactRecord(raw, ["binding", "limit"], [], "CONVERSATION_TURN_READ_INVALID");
    const currentBinding = binding(record.binding);
    if (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > MAX_HISTORY) {
      fail("CONVERSATION_TURN_READ_LIMIT_INVALID");
    }
    return withTransaction(pool, async (client) => {
      await assertStoredBinding(client, currentBinding, true, false);
      const result = await client.query([
        "SELECT l.scope, l.idempotency_key, l.request_hash, l.status, l.response, l.response_hash, l.fencing_epoch,",
        "o.event_id::text, o.aggregate_type, o.aggregate_id::text, o.event_type, o.event_version,",
        "o.idempotency_scope, o.payload, o.payload_sha256, o.status AS outbox_status",
        "FROM idempotency_ledger AS l JOIN outbox_events AS o",
        "ON o.idempotency_scope = l.scope AND o.idempotency_key = l.idempotency_key",
        "AND o.event_type = $1 WHERE l.scope = $2 AND l.status = 'committed'",
        "AND o.payload->>'continuity_id' = $3 ORDER BY l.completed_at DESC, o.event_id DESC LIMIT $4",
      ].join(" "), [REALTIME_CONVERSATION_TURN_EVENT, REALTIME_CONVERSATION_TURN_SCOPE,
        currentBinding.continuityId, record.limit]);
      const receipts: RealtimeConversationTurnReceipt[] = [];
      for (const row of result.rows) {
        const ledger = ledgerFromRow(row);
        const receipt = validateReceipt(row.response);
        if (receipt.delivery_state !== "completed" || receipt.continuity_id !== currentBinding.continuityId ||
            receipt.idempotency_key !== ledger.idempotencyKey || receipt.idempotency_payload_sha256 !== ledger.requestHash ||
            row.event_id !== receipt.receipt_id || row.aggregate_type !== "RealtimeSession" ||
            row.aggregate_id !== receipt.realtime_session_ref.ref_id || row.event_type !== REALTIME_CONVERSATION_TURN_EVENT ||
            Number(row.event_version) !== 1 || row.idempotency_scope !== REALTIME_CONVERSATION_TURN_SCOPE ||
            !sameJson(row.payload, receipt) || row.payload_sha256 !== hashJson(receipt) || ledger.responseHash !== hashJson(receipt)) {
          fail("CONVERSATION_TURN_HISTORY_DRIFT");
        }
        await assertStoredBinding(client, binding({
          realtimeSessionRef: receipt.realtime_session_ref, deviceLeaseRef: receipt.device_lease_ref,
          continuityId: receipt.continuity_id, connectionEpoch: receipt.connection_epoch, leaseVersion: receipt.lease_version,
        }), false, false);
        receipts.push(receipt);
      }
      receipts.sort((left, right) => left.committed_at === right.committed_at
        ? left.receipt_id.localeCompare(right.receipt_id) : left.committed_at.localeCompare(right.committed_at));
      return Object.freeze(receipts);
    }, { isolation: "REPEATABLE READ", readOnly: true });
  };

  return Object.freeze({
    beginClaim,
    commitCompletedAfterPublish: (input: RealtimeConversationTurnCompletionInput) => complete(input, "completed"),
    markIndeterminate: (input: RealtimeConversationTurnCompletionInput) => complete(input, "indeterminate"),
    releaseBeforePublish,
    readByInput,
    readRecentCompleted,
  });
}
