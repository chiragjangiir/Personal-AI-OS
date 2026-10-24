import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  RealtimeAuthorityRepository,
  RealtimeAuthorityTransaction,
} from "../../realtime-core/src/ports.ts";
import type {
  IdempotencyRecord,
  OpaqueCanonicalRef,
  OutboxEvent,
  RealtimeSessionRecord,
} from "../../realtime-core/src/types.ts";
import type { T11BCanonicalRef } from "../../realtime-core/src/final-transcript-evidence-service.ts";
import type { CanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import type {
  FinalTranscriptEvidenceReader,
  FinalTranscriptEvidenceRecord,
} from "../../memory-os/src/final-transcript-explicit-remember-adapter.ts";
import { BACKUP_MIGRATION_HEAD, inspectBackupAuthorityCatalog, type Sha256 } from "./backup-restore-barrier.ts";
import { createRealtimeAuthorityRepository } from "./realtime-authority-repository.ts";
import {backupAuthorityScope, verifyBackupMigrationSources, verifyBackupSequenceScope} from "./backup-authority-contract.ts";
import { withTransaction } from "./transaction.ts";

const OPERATION = "final_transcript_evidence" as const;
const EVENT_TYPE = "realtime.transcript_segment.finalized.v1" as const;
const OUTBOX_SCOPE = "realtime.outbox" as const;
const EVENT_VERSION = 1 as const;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_VERSION = /^[1-9][0-9]*$/u;
const MAX_READINESS_ARTIFACT_BYTES = 65_536;

const MIGRATION_SHA256 = backupAuthorityScope(BACKUP_MIGRATION_HEAD, []).migrationSha256;

const EXPECTED_COLUMNS = Object.freeze({
  idempotency_ledger: [
    "scope", "idempotency_key", "request_hash", "request_fingerprint", "status", "response",
    "response_hash", "fencing_epoch", "claim_token_sha256", "claim_owner", "claimed_at",
    "completed_at", "created_at", "updated_at",
  ],
  outbox_events: [
    "event_id", "aggregate_type", "aggregate_id", "aggregate_ref", "event_type", "event_version",
    "idempotency_scope", "idempotency_key", "payload", "payload_sha256", "status", "attempt_count",
    "available_at", "claimed_at", "claimed_by", "published_at", "last_error_code", "created_at", "updated_at",
  ],
  outbox_consumer_dedupe: ["consumer_name", "event_id", "payload_hash", "processed_at"],
  realtime_sessions: [
    "session_ref_id", "realtime_session_ref", "session_object_version", "session_payload_sha256",
    "continuity_ref", "user_id", "continuity_id", "continuity_state", "active_device_lease_ref",
    "active_device_id", "binding", "state", "connection_epoch", "last_accepted_activity_at",
    "continuity_expires_at", "terminal_at", "terminal_reason", "created_at", "updated_at", "revision",
  ],
  device_leases: [
    "lease_ref_id", "device_lease_ref", "lease_object_version", "lease_payload_sha256", "session_ref_id",
    "realtime_session_ref", "continuity_ref", "user_id", "device_id", "continuity_id", "capabilities",
    "purpose", "policy_decision_ref", "capability_scope", "purpose_scope", "policy_binding", "revocable",
    "state", "lease_version", "fencing_token", "issued_at", "acquired_at", "expires_at", "released_at",
    "revoked_at", "updated_at",
  ],
  realtime_transport_aliases: [
    "session_ref_id", "lease_ref_id", "connection_epoch", "alias_kind", "alias_value", "active", "created_at", "retired_at",
  ],
  realtime_terminal_facts: [
    "terminal_fact_id", "operation", "status", "request_scope", "idempotency_key", "request_hash",
    "session_ref_id", "lease_ref_id", "continuity_id", "connection_epoch", "realtime_session_ref",
    "device_lease_ref", "continuity_ref", "operation_outcome", "execution_facts", "created_at",
  ],
  realtime_handoff_facts: [
    "handoff_ref_id", "session_ref_id", "continuity_id", "from_device_id", "to_device_id",
    "expected_lease_version", "resulting_lease_version", "connection_epoch", "request_scope",
    "idempotency_key", "request_hash", "outcome", "occurred_at",
  ],
  realtime_external_effects: [
    "effect_id", "operation", "request_scope", "idempotency_key", "fingerprint", "fingerprint_sha256",
    "wire_request", "intent", "claim_id", "fencing_epoch", "expected_connection_epoch",
    "expected_lease_version", "effect_state", "stage_state", "suppression_result", "result",
    "result_sha256", "created_at", "claimed_at", "committed_at", "released_at", "updated_at",
  ],
  memory_authority_clock: ["clock_id", "watermark", "updated_at"],
  memory_candidates: [
    "candidate_ref", "candidate_ref_type", "candidate_ref_id", "candidate_object_version",
    "candidate_payload_sha256", "kind", "status", "proposal_id", "slot", "value", "evidence_refs",
    "source_class", "confidence_ppm", "idempotency_key", "current", "memory_kind", "user_id",
    "purpose_scopes", "sensitivity", "validity", "target_ref", "target_ref_type", "target_ref_id",
    "target_object_version", "target_payload_sha256", "correction_intent", "reason", "conflict",
    "requires_review", "conflict_binding", "linked_memory_ref", "linked_memory_ref_type",
    "linked_memory_ref_id", "linked_memory_object_version", "linked_memory_payload_sha256", "reviewed_at",
    "created_at", "updated_at", "canonical_payload_jcs", "canonical_payload", "canonical_receipt_projection",
    "canonical_receipt_projection_jcs", "canonical_receipt_projection_sha256",
  ],
  memory_versions: [
    "memory_ref", "memory_ref_type", "memory_ref_id", "memory_object_version", "memory_payload_sha256",
    "user_id", "kind", "slot", "value", "resolved_content", "status", "current", "source_class",
    "evidence_refs", "confidence_ppm", "allowed_purpose_scopes", "sensitivity", "validity",
    "supersedes_ref", "supersedes_ref_type", "supersedes_ref_id", "supersedes_object_version",
    "supersedes_payload_sha256", "correction_intent", "dream_accepted_delta", "deleted_at", "suppressed_at",
    "stale", "derived_rank_score", "created_at", "updated_at", "canonical_payload_jcs", "canonical_payload",
    "canonical_receipt_projection", "canonical_receipt_projection_jcs", "canonical_receipt_projection_sha256",
  ],
  memory_dream_deltas: [
    "delta_ref", "delta_ref_type", "delta_ref_id", "delta_object_version", "delta_payload_sha256",
    "user_id", "accepted", "delta", "source_refs", "accepted_at", "authority_watermark", "created_at",
  ],
  memory_derived_projections: [
    "projection_kind", "authority_ref", "authority_ref_type", "authority_ref_id", "authority_object_version",
    "authority_payload_sha256", "authority_watermark", "implementation_version", "configuration_sha256",
    "projection_sha256", "record_count", "created_at", "updated_at",
  ],
  memory_deletion_mutations: [
    "deletion_job_ref", "deletion_job_ref_type", "deletion_job_ref_id", "deletion_job_object_version",
    "deletion_job_payload_sha256", "target_ref", "target_ref_type", "target_ref_id", "target_object_version",
    "target_payload_sha256", "target_status", "target_current", "deleted", "suppressed", "tombstone",
    "non_resurrection", "authority_watermark", "idempotency_key", "created_at", "updated_at",
  ],
  memory_rebuild_runs: [],
  memory_candidate_heads: [
    "candidate_ref_id", "candidate_object_version", "candidate_payload_sha256", "authority_watermark", "updated_at",
  ],
  memory_slot_heads: [
    "user_id", "slot", "memory_ref_type", "memory_ref_id", "memory_object_version",
    "memory_payload_sha256", "authority_watermark", "updated_at",
  ],
} satisfies Readonly<Record<string, readonly string[]>>);

const REQUIRED_CONSTRAINTS = Object.freeze([
  "idempotency_ledger_pkey", "idempotency_ledger_scope_ck", "idempotency_ledger_key_ck",
  "idempotency_ledger_request_hash_ck", "idempotency_ledger_status_ck", "idempotency_ledger_response_hash_ck",
  "idempotency_ledger_response_pair_ck", "idempotency_ledger_terminal_response_ck",
  "idempotency_ledger_fencing_epoch_ck", "idempotency_ledger_claim_token_ck", "outbox_events_pkey",
  "outbox_events_idempotency_uq", "outbox_events_aggregate_type_ck", "outbox_events_event_type_ck",
  "outbox_events_event_version_ck", "outbox_events_payload_sha256_ck", "outbox_events_status_ck",
  "outbox_events_attempt_count_ck", "outbox_consumer_dedupe_pkey", "outbox_consumer_dedupe_consumer_ck",
  "outbox_consumer_dedupe_payload_hash_ck", "outbox_consumer_dedupe_event_fk", "realtime_sessions_pkey",
  "realtime_sessions_object_version_ck", "realtime_sessions_payload_sha256_ck",
  "realtime_sessions_continuity_state_ck", "realtime_sessions_state_ck",
  "realtime_sessions_connection_epoch_ck", "realtime_sessions_revision_ck", "device_leases_pkey",
  "device_leases_session_fk", "device_leases_object_version_ck", "device_leases_payload_sha256_ck",
  "device_leases_state_ck", "device_leases_lease_version_ck", "device_leases_fencing_token_ck",
  "realtime_transport_aliases_pkey", "realtime_transport_aliases_session_fk",
  "realtime_transport_aliases_lease_fk", "realtime_transport_aliases_epoch_ck",
  "realtime_transport_aliases_kind_ck", "realtime_transport_aliases_value_ck", "realtime_terminal_facts_pkey",
  "realtime_terminal_facts_request_uq", "realtime_terminal_facts_operation_ck",
  "realtime_terminal_facts_status_ck", "realtime_terminal_facts_request_hash_ck",
  "realtime_terminal_facts_epoch_ck", "realtime_handoff_facts_pkey", "realtime_handoff_facts_request_uq",
  "realtime_handoff_facts_expected_version_ck", "realtime_handoff_facts_resulting_version_ck",
  "realtime_handoff_facts_epoch_ck", "realtime_handoff_facts_request_hash_ck",
  "realtime_external_effects_pkey", "realtime_external_effects_request_uq",
  "realtime_external_effects_claim_uq", "realtime_external_effects_operation_ck",
  "realtime_external_effects_fingerprint_hash_ck", "realtime_external_effects_claim_ck",
  "realtime_external_effects_fencing_epoch_ck", "realtime_external_effects_expected_epoch_ck",
  "realtime_external_effects_expected_lease_ck", "realtime_external_effects_state_ck",
  "realtime_external_effects_result_hash_ck", "realtime_external_effects_result_pair_ck",
  "memory_authority_clock_pkey", "memory_authority_clock_singleton_ck", "memory_authority_clock_watermark_ck",
  "memory_candidates_identity_uq", "memory_candidates_object_version_ck", "memory_candidates_payload_sha256_ck",
  "memory_candidates_confidence_ck", "memory_candidates_current_false_ck", "memory_candidates_target_bundle_ck",
  "memory_candidates_linked_bundle_ck", "memory_candidates_canonical_bundle_ck", "memory_versions_identity_uq",
  "memory_versions_object_version_ck", "memory_versions_payload_sha256_ck", "memory_versions_confidence_ck",
  "memory_versions_supersedes_bundle_ck", "memory_versions_canonical_bundle_ck",
  "memory_dream_deltas_identity_uq", "memory_dream_deltas_object_version_ck",
  "memory_dream_deltas_payload_sha256_ck", "memory_dream_deltas_accepted_ck",
  "memory_derived_projections_pkey", "memory_derived_projections_kind_ck",
  "memory_derived_projections_object_version_ck", "memory_derived_projections_authority_hash_ck",
  "memory_derived_projections_configuration_hash_ck", "memory_derived_projections_projection_hash_ck",
  "memory_derived_projections_record_count_ck", "memory_derived_projections_implementation_ck",
  "memory_deletion_mutations_pkey", "memory_deletion_mutations_job_version_ck",
  "memory_deletion_mutations_job_hash_ck", "memory_deletion_mutations_target_version_ck",
  "memory_deletion_mutations_target_hash_ck", "memory_deletion_mutations_non_resurrection_ck",
  "memory_candidate_heads_pkey", "memory_candidate_heads_version_ck", "memory_candidate_heads_hash_ck",
  "memory_candidate_heads_candidate_fk", "memory_slot_heads_pkey", "memory_slot_heads_version_ck",
  "memory_slot_heads_hash_ck", "memory_slot_heads_memory_fk",
] as const);

const REQUIRED_INDEXES = Object.freeze([
  "outbox_events_claim_idx", "realtime_sessions_one_active_per_continuity_uq",
  "device_leases_session_state_idx", "realtime_transport_aliases_active_idx",
  "memory_candidates_user_status_idx", "memory_versions_user_slot_read_idx", "memory_dream_deltas_read_idx",
] as const);

type PlainRecord = Record<string, unknown>;

export class FinalTranscriptEvidencePostgresError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "FinalTranscriptEvidencePostgresError";
    this.code = code;
  }
}

export interface FinalTranscriptEvidencePostgresBridge {
  readonly repository: RealtimeAuthorityRepository;
  readonly reader: FinalTranscriptEvidenceReader;
}

export interface PostgresReadinessArtifactBinding {
  readonly absolutePath: string;
  readonly sha256: string;
}

export interface PostgresSchemaReadinessOptions {
  readonly authority?: Readonly<{migrationHead:string;l3Namespace:string;schemaSha256:Sha256}>;
  readonly pool: Pool;
  readonly expected: Readonly<{
    host: string;
    port: number;
    database: string;
    user: string;
    serverVersion: string;
    catalogDefinitionSha256: string;
  }>;
  readonly readinessArtifact: PostgresReadinessArtifactBinding;
}

export interface PostgresSchemaReadinessSnapshot {
  readonly ready: true;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly serverVersion: string;
  readonly migrationHead: string;
  readonly migrationSha256: Readonly<Record<string,string>>;
  readonly readinessArtifactSha256: string;
  readonly catalogDefinitionSha256: string;
  readonly relationCount: number;
}

export interface PostgresSchemaReadinessReader {
  readonly read: () => Promise<PostgresSchemaReadinessSnapshot>;
}

function withStableReadOnlyTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, work, { isolation: "REPEATABLE READ", readOnly: true });
}

function fail(code: string, cause?: unknown): never {
  throw new FinalTranscriptEvidencePostgresError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
  optional: readonly string[] = [],
): PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const actual = Object.keys(value).sort();
  const allowed = new Set([...keys, ...optional]);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || actual.some((key) => !allowed.has(key))) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  return value;
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) fail(code);
  return value;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("FINAL_TRANSCRIPT_JSON_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) fail("FINAL_TRANSCRIPT_JSON_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("FINAL_TRANSCRIPT_JSON_INVALID");
        output.push(canonicalJson(value[index], seen));
      }
      return `[${output.join(",")}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail("FINAL_TRANSCRIPT_JSON_INVALID");
    const output: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        fail("FINAL_TRANSCRIPT_JSON_INVALID");
      }
      output.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`);
    }
    return `{${output.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonHash(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function camelRef(value: unknown, expectedType: "FinalTranscriptEvidence" | "TranscriptSegment"): T11BCanonicalRef {
  const record = exactRecord(
    value,
    ["refType", "refId", "objectVersion", "canonicalPayloadSha256"],
    "FINAL_TRANSCRIPT_REF_INVALID",
  );
  if (record.refType !== expectedType || typeof record.refId !== "string" || !UUID_V7.test(record.refId) ||
      typeof record.objectVersion !== "string" || !POSITIVE_VERSION.test(record.objectVersion) ||
      typeof record.canonicalPayloadSha256 !== "string" || !SHA256.test(record.canonicalPayloadSha256)) {
    fail("FINAL_TRANSCRIPT_REF_INVALID");
  }
  return Object.freeze({
    refType: expectedType,
    refId: record.refId,
    objectVersion: record.objectVersion,
    canonicalPayloadSha256: record.canonicalPayloadSha256,
  });
}

interface SnakeSessionRef {
  readonly ref_type: "RealtimeSession";
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

function snakeSessionRef(value: unknown): SnakeSessionRef {
  const record = exactRecord(
    value,
    ["ref_type", "ref_id", "object_version", "canonical_payload_sha256"],
    "FINAL_TRANSCRIPT_SESSION_REF_INVALID",
  );
  if (record.ref_type !== "RealtimeSession" || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !POSITIVE_VERSION.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256)) {
    fail("FINAL_TRANSCRIPT_SESSION_REF_INVALID");
  }
  return Object.freeze({
    ref_type: "RealtimeSession",
    ref_id: record.ref_id,
    object_version: record.object_version,
    canonical_payload_sha256: record.canonical_payload_sha256,
  });
}

interface ValidatedPayload {
  readonly segment: PlainRecord;
  readonly evidence: PlainRecord;
  readonly evidenceRef: T11BCanonicalRef;
  readonly transcriptSegmentRef: T11BCanonicalRef;
}

function validatePayload(value: unknown, expectedEvidenceRef?: unknown, expectedSessionRef?: unknown): ValidatedPayload {
  const payload = exactRecord(value, ["segment", "evidence", "evidenceRef"], "FINAL_TRANSCRIPT_PAYLOAD_INVALID");
  const segment = exactRecord(payload.segment, [
    "schema", "transcriptState", "userId", "deviceId", "realtimeSessionRef", "continuityId", "purpose",
    "text", "language", "sourceMediaRef", "observedAt",
  ], "FINAL_TRANSCRIPT_SEGMENT_INVALID", ["correction"]);
  const evidence = exactRecord(payload.evidence, [
    "schema", "transcriptSegmentRef", "userId", "deviceId", "realtimeSessionRef", "continuityId", "purpose",
    "sourceMediaRef", "observedAt",
  ], "FINAL_TRANSCRIPT_EVIDENCE_INVALID", ["supersedes"]);
  if (segment.schema !== "paios.realtime.transcript-segment.v1" || segment.transcriptState !== "final" ||
      evidence.schema !== "paios.realtime.final-transcript-evidence.v1") fail("FINAL_TRANSCRIPT_PAYLOAD_INVALID");
  const evidenceRef = camelRef(payload.evidenceRef, "FinalTranscriptEvidence");
  const transcriptSegmentRef = camelRef(evidence.transcriptSegmentRef, "TranscriptSegment");
  if (expectedEvidenceRef !== undefined && !sameJson(evidenceRef, expectedEvidenceRef)) fail("FINAL_TRANSCRIPT_REF_DRIFT");
  if (jsonHash(evidence) !== evidenceRef.canonicalPayloadSha256 ||
      jsonHash(segment) !== transcriptSegmentRef.canonicalPayloadSha256) fail("FINAL_TRANSCRIPT_PAYLOAD_HASH_DRIFT");
  for (const key of ["userId", "deviceId", "realtimeSessionRef", "continuityId", "purpose", "sourceMediaRef", "observedAt"] as const) {
    if (!sameJson(segment[key], evidence[key])) fail("FINAL_TRANSCRIPT_BINDING_DRIFT");
  }
  if ((segment.correction === undefined) !== (evidence.supersedes === undefined)) fail("FINAL_TRANSCRIPT_CORRECTION_DRIFT");
  if (segment.correction !== undefined && evidence.supersedes !== undefined) {
    const correction = exactRecord(
      segment.correction,
      ["previousTranscriptSegmentRef", "correctionReason"],
      "FINAL_TRANSCRIPT_CORRECTION_INVALID",
    );
    const supersedes = exactRecord(
      evidence.supersedes,
      ["previousTranscriptSegmentRef", "previousFinalEvidenceRef", "correctionReason"],
      "FINAL_TRANSCRIPT_CORRECTION_INVALID",
    );
    camelRef(correction.previousTranscriptSegmentRef, "TranscriptSegment");
    camelRef(supersedes.previousTranscriptSegmentRef, "TranscriptSegment");
    camelRef(supersedes.previousFinalEvidenceRef, "FinalTranscriptEvidence");
    if (!sameJson(correction.previousTranscriptSegmentRef, supersedes.previousTranscriptSegmentRef) ||
        correction.correctionReason !== supersedes.correctionReason) fail("FINAL_TRANSCRIPT_CORRECTION_DRIFT");
  }
  if (expectedSessionRef !== undefined && !sameJson(segment.realtimeSessionRef, expectedSessionRef)) {
    fail("FINAL_TRANSCRIPT_SESSION_BINDING_DRIFT");
  }
  exactString(segment.userId, "FINAL_TRANSCRIPT_BINDING_INVALID");
  exactString(segment.deviceId, "FINAL_TRANSCRIPT_BINDING_INVALID");
  exactString(segment.continuityId, "FINAL_TRANSCRIPT_BINDING_INVALID");
  exactString(segment.purpose, "FINAL_TRANSCRIPT_BINDING_INVALID");
  exactString(segment.text, "FINAL_TRANSCRIPT_TEXT_INVALID");
  exactString(segment.observedAt, "FINAL_TRANSCRIPT_TIME_INVALID");
  return Object.freeze({ segment, evidence, evidenceRef, transcriptSegmentRef });
}

function wrapFinalTranscriptRepository(base: RealtimeAuthorityRepository): RealtimeAuthorityRepository {
  if (!base || typeof base.transaction !== "function") fail("FINAL_TRANSCRIPT_REPOSITORY_REQUIRED");
  return Object.freeze({
    transaction<T>(operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
      if (operation !== OPERATION || typeof work !== "function") {
        return Promise.reject(new FinalTranscriptEvidencePostgresError("FINAL_TRANSCRIPT_OPERATION_INVALID"));
      }
      return base.transaction<T>(operation, async (transaction) => {
        let session: RealtimeSessionRecord | undefined;
        let appended: Readonly<{ readonly event: OutboxEvent; readonly eventRef: OpaqueCanonicalRef }> | undefined;
        const guarded: RealtimeAuthorityTransaction = Object.freeze({
          readSession: async (ref: Parameters<RealtimeAuthorityTransaction["readSession"]>[0]) => {
            const result = await transaction.readSession(ref);
            if (result !== undefined) {
              const requested = snakeSessionRef(ref);
              const returned = snakeSessionRef(result.realtimeSessionRef);
              if (!sameJson(requested, returned)) fail("FINAL_TRANSCRIPT_SESSION_BINDING_DRIFT");
              session = result;
            }
            return result;
          },
          readSessionByContinuityId: (continuityId: Parameters<RealtimeAuthorityTransaction["readSessionByContinuityId"]>[0]) => transaction.readSessionByContinuityId(continuityId),
          readLease: (ref: Parameters<RealtimeAuthorityTransaction["readLease"]>[0]) => transaction.readLease(ref),
          readCurrentBinding: (lookup: Parameters<RealtimeAuthorityTransaction["readCurrentBinding"]>[0]) => transaction.readCurrentBinding(lookup),
          readActiveDeviceSessions: async () => fail("FINAL_TRANSCRIPT_UNEXPECTED_READ"),
          readIdempotency: (scope: Parameters<RealtimeAuthorityTransaction["readIdempotency"]>[0], key: Parameters<RealtimeAuthorityTransaction["readIdempotency"]>[1]) => transaction.readIdempotency(scope, key),
          writeSession: async () => fail("FINAL_TRANSCRIPT_UNEXPECTED_WRITE"),
          writeLease: async () => fail("FINAL_TRANSCRIPT_UNEXPECTED_WRITE"),
          writeBinding: async () => fail("FINAL_TRANSCRIPT_UNEXPECTED_WRITE"),
          recordHandoffFact: async () => fail("FINAL_TRANSCRIPT_UNEXPECTED_WRITE"),
          appendOutbox: async (event: Parameters<RealtimeAuthorityTransaction["appendOutbox"]>[0]) => {
            if (session === undefined || appended !== undefined || event.eventType !== EVENT_TYPE) {
              fail("FINAL_TRANSCRIPT_OUTBOX_INVALID");
            }
            const evidenceRef = camelRef(event.aggregateRef, "FinalTranscriptEvidence");
            const sessionRef = snakeSessionRef(session.realtimeSessionRef);
            validatePayload(event.payload, evidenceRef, sessionRef);
            const storageEvent = Object.freeze({ ...event, aggregateRef: sessionRef as unknown as OpaqueCanonicalRef });
            const eventRef = await transaction.appendOutbox(storageEvent);
            appended = Object.freeze({ event: Object.freeze({ ...event }), eventRef });
            return eventRef;
          },
          writeIdempotency: async (record: IdempotencyRecord) => {
            if (record.operation !== OPERATION || appended === undefined ||
                !isPlainRecord(record.result) || !sameJson(record.result.evidenceRef, appended.event.aggregateRef) ||
                !sameJson(record.result.outboxEventRef, appended.eventRef)) {
              fail("FINAL_TRANSCRIPT_IDEMPOTENCY_RESULT_DRIFT");
            }
            await transaction.writeIdempotency(record);
          },
        });
        return work(guarded);
      });
    },
  });
}

export function createFinalTranscriptEvidencePostgresBridge(pool: Pool): FinalTranscriptEvidencePostgresBridge {
  if (!pool || typeof pool.connect !== "function") fail("FINAL_TRANSCRIPT_POOL_REQUIRED");
  return Object.freeze({
    repository: wrapFinalTranscriptRepository(createRealtimeAuthorityRepository(pool)),
    reader: createFinalTranscriptEvidencePostgresReader(pool),
  });
}

/** Storage-neutral entry for focused unit validation; production callers use the Pool factory above. */
export function createFinalTranscriptEvidenceRepositoryBridge(
  repository: RealtimeAuthorityRepository,
): RealtimeAuthorityRepository {
  return wrapFinalTranscriptRepository(repository);
}

function eventCandidateFromRow(row: QueryResultRow): Readonly<{
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateRef: unknown;
  eventType: string;
  eventVersion: number;
  idempotencyScope: string;
  idempotencyKey: string;
  payload: unknown;
  payloadSha256: string;
}> {
  return Object.freeze({
    eventId: String(row.event_id), aggregateType: String(row.aggregate_type), aggregateId: String(row.aggregate_id),
    aggregateRef: row.aggregate_ref, eventType: String(row.event_type), eventVersion: Number(row.event_version),
    idempotencyScope: String(row.idempotency_scope), idempotencyKey: String(row.idempotency_key),
    payload: row.payload, payloadSha256: String(row.payload_sha256).trim(),
  });
}

async function readEvidence(client: PoolClient, ref: CanonicalObjectVersionRef): Promise<FinalTranscriptEvidenceRecord | undefined> {
  const evidenceRef = camelRef(ref, "FinalTranscriptEvidence");
  const candidates = await client.query(
    [
      "SELECT event_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version,",
      "idempotency_scope, idempotency_key, payload, payload_sha256 FROM outbox_events",
      "WHERE payload #>> '{evidenceRef,refId}' = $1",
    ].join(" "),
    [evidenceRef.refId],
  );
  if (candidates.rows.length === 0) return undefined;
  if (candidates.rows.length !== 1) fail("FINAL_TRANSCRIPT_DUPLICATE");
  const event = eventCandidateFromRow(candidates.rows[0]!);
  if (!UUID.test(event.eventId) || event.aggregateType !== "realtime" || !UUID_V7.test(event.aggregateId) ||
      event.eventType !== EVENT_TYPE || event.eventVersion !== EVENT_VERSION ||
      event.idempotencyScope !== OUTBOX_SCOPE || !SHA256.test(event.payloadSha256) ||
      jsonHash(event.payload) !== event.payloadSha256) fail("FINAL_TRANSCRIPT_OUTBOX_DRIFT");
  const sessionRef = snakeSessionRef(event.aggregateRef);
  if (sessionRef.ref_id !== event.aggregateId) fail("FINAL_TRANSCRIPT_AGGREGATE_DRIFT");
  const payload = validatePayload(event.payload, evidenceRef, sessionRef);

  const sessionRows = await client.query(
    "SELECT realtime_session_ref, user_id::text, continuity_id::text FROM realtime_sessions WHERE session_ref_id = $1",
    [event.aggregateId],
  );
  if (sessionRows.rows.length !== 1) fail("FINAL_TRANSCRIPT_SESSION_MISSING");
  const session = sessionRows.rows[0]!;
  if (!sameJson(session.realtime_session_ref, sessionRef) || String(session.user_id) !== payload.segment.userId ||
      String(session.continuity_id) !== payload.segment.continuityId) fail("FINAL_TRANSCRIPT_SESSION_BINDING_DRIFT");

  const ledgerRows = await client.query(
    [
      "SELECT request_hash, request_fingerprint, status, response, response_hash FROM idempotency_ledger",
      "WHERE scope = $1 AND idempotency_key = $2",
    ].join(" "),
    [OPERATION, event.idempotencyKey],
  );
  if (ledgerRows.rows.length !== 1) fail("FINAL_TRANSCRIPT_IDEMPOTENCY_MISSING");
  const ledger = ledgerRows.rows[0]!;
  if (ledger.status !== "committed" || typeof ledger.request_fingerprint !== "string" ||
      sha256Bytes(ledger.request_fingerprint) !== String(ledger.request_hash).trim() ||
      !SHA256.test(String(ledger.response_hash).trim()) || jsonHash(ledger.response) !== String(ledger.response_hash).trim()) {
    fail("FINAL_TRANSCRIPT_IDEMPOTENCY_DRIFT");
  }
  const response = exactRecord(
    ledger.response,
    ["transcriptSegmentRef", "evidenceRef", "outboxEventRef", "observedAt"],
    "FINAL_TRANSCRIPT_IDEMPOTENCY_DRIFT",
  );
  if (!sameJson(response.transcriptSegmentRef, payload.transcriptSegmentRef) ||
      !sameJson(response.evidenceRef, evidenceRef) || String(response.outboxEventRef) !== event.eventId ||
      response.observedAt !== payload.segment.observedAt) fail("FINAL_TRANSCRIPT_IDEMPOTENCY_DRIFT");
  return Object.freeze({
    ref: evidenceRef as unknown as CanonicalObjectVersionRef,
    transcriptState: "final",
    userId: String(payload.segment.userId),
    purpose: String(payload.segment.purpose),
    text: String(payload.segment.text),
    observedAt: String(payload.segment.observedAt),
  });
}

export function createFinalTranscriptEvidencePostgresReader(pool: Pool): FinalTranscriptEvidenceReader {
  if (!pool || typeof pool.connect !== "function") fail("FINAL_TRANSCRIPT_POOL_REQUIRED");
  return Object.freeze({
    read: (ref: CanonicalObjectVersionRef) => withStableReadOnlyTransaction(pool, (client) => readEvidence(client, ref)),
  });
}

async function artifactSha256(binding: PostgresReadinessArtifactBinding): Promise<string> {
  if (!binding || !isAbsolute(binding.absolutePath) || !SHA256.test(binding.sha256)) fail("PG_READINESS_ARTIFACT_BINDING_INVALID");
  const expectedPath = resolve(binding.absolutePath);
  const before = await lstat(expectedPath).catch((error: unknown) => fail("PG_READINESS_ARTIFACT_UNAVAILABLE", error));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 ||
      before.size > MAX_READINESS_ARTIFACT_BYTES) fail("PG_READINESS_ARTIFACT_INVALID");
  const actualPath = resolve(await realpath(expectedPath));
  if (actualPath.toLowerCase() !== expectedPath.toLowerCase()) fail("PG_READINESS_ARTIFACT_REPARSE_FORBIDDEN");
  const handle = await open(expectedPath, "r").catch((error: unknown) => fail("PG_READINESS_ARTIFACT_UNAVAILABLE", error));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) fail("PG_READINESS_ARTIFACT_CHANGED");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("PG_READINESS_ARTIFACT_CHANGED");
    const digest = sha256Bytes(bytes);
    bytes.fill(0);
    if (digest !== binding.sha256) fail("PG_READINESS_ARTIFACT_HASH_MISMATCH");
    return digest;
  } finally {
    await handle.close();
  }
}

function rowsByName(rows: readonly QueryResultRow[], nameField: string, valueField: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const name = String(row[nameField]);
    const values = result.get(name) ?? [];
    values.push(String(row[valueField]));
    result.set(name, values);
  }
  return result;
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function schemaReadiness(
  client: PoolClient,
  options: PostgresSchemaReadinessOptions,
  readinessArtifactSha256: string,
): Promise<PostgresSchemaReadinessSnapshot> {
  const identityRows = await client.query([
    "SELECT host(inet_server_addr()) AS host, inet_server_port() AS port, current_database() AS database,",
    "current_user AS user, current_setting('server_version') AS server_version,",
    "current_setting('server_version_num') AS server_version_num, current_setting('transaction_read_only') AS read_only",
  ].join(" "));
  if (identityRows.rows.length !== 1) fail("PG_READINESS_IDENTITY_INVALID");
  const identity = identityRows.rows[0]!;
  if (String(identity.host) !== options.expected.host || Number(identity.port) !== options.expected.port ||
      String(identity.database) !== options.expected.database || String(identity.user) !== options.expected.user ||
      String(identity.server_version) !== options.expected.serverVersion || !String(identity.server_version_num).startsWith("18") ||
      String(identity.read_only) !== "on") fail("PG_READINESS_IDENTITY_MISMATCH");

  if(options.authority) {
    if(options.authority.schemaSha256!==options.expected.catalogDefinitionSha256)fail("PG_READINESS_SCHEMA_HASH_MISMATCH");
    const scope=await inspectBackupAuthorityCatalog(client,options.authority);
    return Object.freeze({ready:true,host:String(identity.host),port:Number(identity.port),database:String(identity.database),
      user:String(identity.user),serverVersion:String(identity.server_version),migrationHead:scope.head,
      migrationSha256:scope.migrationSha256,readinessArtifactSha256,
      catalogDefinitionSha256:options.authority.schemaSha256,relationCount:scope.tables.length});
  }
  const legacyScope=backupAuthorityScope(BACKUP_MIGRATION_HEAD, []);
  await verifyBackupMigrationSources(legacyScope);
  await verifyBackupSequenceScope(client,legacyScope);
  const tableRows = await client.query([
    "SELECT c.relname AS table_name FROM pg_catalog.pg_class AS c",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
    "WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relispartition = FALSE ORDER BY c.relname",
  ].join(" "));
  const expectedTables = Object.keys(EXPECTED_COLUMNS).sort();
  const actualTables = tableRows.rows.map((row) => String(row.table_name));
  if (!exactArray(actualTables, expectedTables) || actualTables.length !== 18) fail("PG_READINESS_TABLE_SET_MISMATCH");

  const columnRows = await client.query([
    "SELECT c.relname AS table_name, a.attname AS column_name FROM pg_catalog.pg_class AS c",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
    "JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid",
    "WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped",
    "ORDER BY c.relname, a.attnum",
  ].join(" "), [expectedTables]);
  const columns = rowsByName(columnRows.rows, "table_name", "column_name");
  for (const table of expectedTables) {
    if (!exactArray(columns.get(table) ?? [], EXPECTED_COLUMNS[table as keyof typeof EXPECTED_COLUMNS])) {
      fail("PG_READINESS_COLUMN_SET_MISMATCH");
    }
  }

  const constraintRows = await client.query([
    "SELECT c.conname AS name, pg_catalog.pg_get_constraintdef(c.oid, TRUE) AS definition",
    "FROM pg_catalog.pg_constraint AS c WHERE c.connamespace = 'public'::regnamespace ORDER BY c.conname",
  ].join(" "));
  const constraintNames = constraintRows.rows.map((row) => String(row.name));
  if (REQUIRED_CONSTRAINTS.some((name) => !constraintNames.includes(name))) fail("PG_READINESS_CONSTRAINT_SET_MISMATCH");
  const indexRows = await client.query([
    "SELECT c.relname AS name, pg_catalog.pg_get_indexdef(c.oid) AS definition FROM pg_catalog.pg_class AS c",
    "JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
    "WHERE n.nspname = 'public' AND c.relkind = 'i' ORDER BY c.relname",
  ].join(" "));
  const indexNames = indexRows.rows.map((row) => String(row.name));
  if (REQUIRED_INDEXES.some((name) => !indexNames.includes(name)) ||
      indexNames.includes("memory_versions_one_current_per_slot_uq")) fail("PG_READINESS_INDEX_SET_MISMATCH");
  const catalogDefinitions = Object.freeze({
    constraints: constraintRows.rows.map((row) => Object.freeze({ name: String(row.name), definition: String(row.definition) })),
    indexes: indexRows.rows.map((row) => Object.freeze({ name: String(row.name), definition: String(row.definition) })),
  });
  const catalogDefinitionSha256 = jsonHash(catalogDefinitions);
  if (catalogDefinitionSha256 !== options.expected.catalogDefinitionSha256) fail("PG_READINESS_CATALOG_DEFINITION_DRIFT");
  return Object.freeze({
    ready: true,
    host: String(identity.host), port: Number(identity.port), database: String(identity.database),
    user: String(identity.user), serverVersion: String(identity.server_version),
    migrationHead: BACKUP_MIGRATION_HEAD, migrationSha256: MIGRATION_SHA256,
    readinessArtifactSha256, catalogDefinitionSha256, relationCount: 18,
  });
}

export function createPostgresSchemaReadinessReader(
  options: PostgresSchemaReadinessOptions,
): PostgresSchemaReadinessReader {
  if (!options?.pool || typeof options.pool.connect !== "function" || !options.expected ||
      !SHA256.test(options.expected.catalogDefinitionSha256)) fail("PG_READINESS_OPTIONS_INVALID");
  return Object.freeze({
    read: async () => {
      const digest = await artifactSha256(options.readinessArtifact);
      return withStableReadOnlyTransaction(options.pool, (client) => schemaReadiness(client, options, digest));
    },
  });
}
