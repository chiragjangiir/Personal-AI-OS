/**
 * T01's production terminal-result codecs for the T11B/T02 adapter.
 *
 * This module is deliberately a pure projection seam.  It does not issue
 * identities, calculate result hashes, read a schema file, call a provider,
 * or persist a receipt.  All identity, outcome, receipt, evidence, and fence
 * values must be supplied by the owning port and are copied into the canonical
 * snake_case wire representation only after their bindings are checked.
 */

import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
  snapshotOpaqueOwnerValue,
  type HandoffRequest,
  type StopRequest,
  type TerminalReceipt,
} from '../../../services/realtime-core/src/types.ts';
import type {
  T11bHandoffTerminalCodecPort,
  T11bOwnerContext,
  T11bTerminalCodecPort,
} from './realtime-public-control-t11b-t02-adapter.ts';

type JsonRecord = Record<string, unknown>;
type TerminalOperation = 'media_stop' | 'end_continuity';
type TerminalStatus = 'success' | 'error' | 'cancelled' | 'expired' | 'revoked' | 'indeterminate';

export const REALTIME_TERMINAL_RESULT_SCHEMA_ID =
  'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json' as const;
export const REALTIME_TERMINAL_RESULT_SCHEMA_VERSION = '1.0.0' as const;
export const REALTIME_TERMINAL_RESULT_SCHEMA_SHA256 =
  '48c9a20c5184ed461f7604ad07269423854e96f186e30b5e06fe55397933e57b' as const;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const CONNECTION_EPOCH = /^[1-9][0-9]{0,37}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const HTTPS_URI = /^https:\/\/[^\s]+$/u;
const PURPOSE_SCOPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const OPERATION_KIND = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const ERROR_CODE = /^(?:validation|authn|authz|policy|state|conflict|dependency|provider|tool|storage|security|privacy|deletion|replay|risk)\.[a-z0-9_]+$/u;
const SYSTEM_TIME = /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$/u;

const TERMINAL_STATUSES = new Set<TerminalStatus>([
  'success', 'error', 'cancelled', 'expired', 'revoked', 'indeterminate',
]);
const ERROR_FAMILIES = new Set([
  'validation', 'authn', 'authz', 'policy', 'state', 'conflict', 'dependency',
  'provider', 'tool', 'storage', 'security', 'privacy', 'deletion', 'replay', 'risk',
]);
const RETRY_CLASSES = new Set([
  'never', 'immediate', 'backoff', 'after_user_action', 'after_policy_change',
  'after_dependency_recovery',
]);
const OUTCOME_CLASSES = new Set([
  'pre_claim_rejection', 'rollback_no_commit', 'committed_rejection',
  'committed_success', 'indeterminate',
]);
const RESOLUTION_MODES = new Set([
  'direct', 'reconciled_no_effect', 'reconciled_effect_confirmed',
]);
const CLOSURE_STATUSES = new Set(['not_applicable', 'verified_closed', 'failed', 'indeterminate']);
const LEASE_RELEASES = new Set(['not_requested', 'released', 'already_released', 'failed', 'indeterminate']);
const CLEANUP_FACTS = new Set(['not_requested', 'verified_absent', 'failed', 'indeterminate']);

/** The ref_type registry in versioning-hash.v1.schema.json. */
const CANONICAL_REF_TYPES = new Set([
  'ActionAudit', 'ActionProposal', 'ApprovalDecision', 'ApprovalRequest', 'ArtifactVersion',
  'AuditExport', 'AuditRecord', 'CapabilityGrant', 'ConsentRecord', 'CompensationPlan',
  'ContextAssertion', 'CriticalViolation', 'DecisionCase', 'DeletionJob', 'DeletionProof',
  'DeliveryPlan', 'DeliveryReceipt', 'DerivedPersonalRiskAssessment', 'DeviceCredential',
  'DeviceLease', 'DomainDeletionAttestation', 'EmergencyDeliveryObligation', 'EpisodicMemory',
  'EvidenceSpan', 'ExposureAssessment', 'ExecutionPlan', 'ExpressionPlan',
  'ExtractionCandidate', 'Feedback', 'FinalTranscriptEvidence', 'GoalHierarchy',
  'HazardVersion', 'IngestionAudit', 'MemoryCandidate', 'ModelDefinition', 'NormalizedEvent',
  'Observation', 'OfficialPublicWarningReference', 'OpenLoop', 'PersonalModelClaimCandidate',
  'PersonalModelFacet', 'PersonalModelProjection', 'PersonaConstitution', 'PolicyDecision',
  'PreferenceMemory', 'PreferenceProfile', 'ProactiveCandidate', 'ProactiveDecision',
  'ProviderRoute', 'PurposeToken', 'Recommendation', 'Regression', 'RelationshipEvent',
  'RelationshipPolicyProjection', 'RelationshipState', 'ReleaseGate', 'RealtimeSession',
  'ReplayRun', 'RiskAlertCandidate', 'RiskEvidencePackage', 'SemanticFact',
  'SituationHypothesis', 'SoftwareKillSwitch', 'SourceArtifact', 'SurfaceAvailability',
  'TextEvidence', 'ToolDefinition', 'ToolInvocation', 'ToolResultArtifact', 'TranscriptSegment',
  'UrgentDeliveryEligibilityCandidate', 'WorldStateProjection',
]);

const FORBIDDEN_KEYS = new Set([
  'api_key', 'api_secret', 'authorization', 'body', 'content_key', 'contentkey',
  'delivery_receipt', 'deliveryreceipt', 'key_material', 'keymaterial', 'password',
  'participant_token', 'plaintext', 'plaintext_key', 'private', 'private_key', 'privatekey',
  'raw_body', 'raw_request', 'room_options', 'roomoptions', 'secret', 'secret_key',
  'secretkey', 'token',
]);

const OUTER_TERMINAL_KEYS = new Set(['operation', 'wireRequest', 'request', 'governance', 'receipt', 'executionFacts']);
const OUTER_HANDOFF_KEYS = new Set(['wireRequest', 'request', 'owner', 'governance', 'authorityResult', 'suppressionResult']);
const TERMINAL_WIRE_KEYS: Readonly<Record<TerminalOperation, ReadonlySet<string>>> = Object.freeze({
  media_stop: new Set([
    'operation', 'request_id', 'idempotency_context', 'realtime_session_ref', 'device_lease_ref',
    'continuity_id', 'transport_aliases', 'connection_epoch', 'reason', 'release_scope',
    'expected_lease_version', 'governance',
  ]),
  end_continuity: new Set([
    'operation', 'request_id', 'idempotency_context', 'realtime_session_ref', 'continuity_id',
    'connection_epoch', 'confirmation', 'expected_lease_version', 'governance',
  ]),
});
const HANDOFF_WIRE_KEYS = new Set([
  'operation', 'request_id', 'idempotency_context', 'realtime_session_ref',
  'current_device_lease_ref', 'continuity_id', 'connection_epoch', 'expected_lease_version',
  'from_device_id', 'to_device_id', 'governance',
]);
const STOP_REQUEST_KEYS = new Set([
  'requestId', 'idempotencyKey', 'operation', 'realtimeSessionRef', 'continuityId',
  'deviceLeaseRef', 'deviceId', 'expectedConnectionEpoch', 'expectedLeaseVersion', 'credentialGeneration', 'reason',
  'occurredAt', 'governance',
]);
const HANDOFF_REQUEST_KEYS = new Set([
  'requestId', 'idempotencyKey', 'realtimeSessionRef', 'continuityId', 'fromDeviceId',
  'toDeviceId', 'expectedConnectionEpoch', 'expectedLeaseVersion', 'occurredAt', 'governance',
]);
const OWNER_KEYS = new Set(['userId', 'deviceId', 'purpose', 'capabilities', 'occurredAt']);
const RECEIPT_KEYS = new Set([
  'kind', 'operation', 'status', 'requestId', 'idempotencyKey', 'realtimeSessionRef',
  'deviceLeaseRef', 'continuityId', 'connectionEpoch', 'leaseVersion', 'outcome', 'errorCode',
  'recordedAt', 'replayed', 'outboxEventRef', 'operationOutcome', 'operation_outcome',
  'recordedResultReference', 'recorded_result_ref', 'executionFacts', 'execution_facts',
  'governance',
]);

export class RealtimePublicControlTerminalCodecError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RealtimePublicControlTerminalCodecError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlTerminalCodecError(code);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonRecord, allowed: ReadonlySet<string>, code: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code);
}

function ownData(value: JsonRecord, key: string, code: string): unknown {
  if (!Object.hasOwn(value, key)) fail(code);
  return value[key];
}

/**
 * Clone a JSON value without invoking accessors.  Object keys are sorted so
 * repeated calls with the same value produce the same canonical JSON order.
 */
function snapshotJson(value: unknown, code: string, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    fail(code);
  }
  if (typeof value !== 'object') fail(code);
  if (ancestors.has(value)) fail('REALTIME_TERMINAL_CODEC_VALUE_CYCLE');
  ancestors.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || names.length !== value.length + 1) {
      fail(code);
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
        fail(code);
      }
      output.push(snapshotJson(descriptor.value, code, ancestors));
    }
    ancestors.delete(value);
    return Object.freeze(output);
  }
  if (!isPlainRecord(value)) fail(code);
  const names = Object.getOwnPropertyNames(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || names.length !== Object.keys(value).length) fail(code);
  const output: JsonRecord = {};
  for (const key of names.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      fail(code);
    }
    Object.defineProperty(output, key, {
      value: snapshotJson(descriptor.value, code, ancestors),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  ancestors.delete(value);
  return Object.freeze(output);
}

function record(value: unknown, code: string): JsonRecord {
  /* Reuse the realtime-core opaque-value guard before applying wire closure. */
  try {
    snapshotOpaqueOwnerValue(value);
  } catch {
    fail(code);
  }
  const snapshot = snapshotJson(value, code);
  if (!isPlainRecord(snapshot)) fail(code);
  return snapshot;
}

function canonicalString(value: unknown, code: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || (pattern !== undefined && !pattern.test(value))) {
    fail(code);
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function assertNoForbiddenKeys(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) fail('REALTIME_TERMINAL_CODEC_VALUE_CYCLE');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item, ancestors);
  } else {
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail('REALTIME_TERMINAL_CODEC_SECRET_OR_RAW_OUTPUT');
      assertNoForbiddenKeys(item, ancestors);
    }
  }
  ancestors.delete(value);
}

function alias(value: JsonRecord, names: readonly string[], code: string): unknown {
  const present = names.filter((name) => Object.hasOwn(value, name));
  if (present.length > 1) fail(code);
  return present.length === 0 ? undefined : value[present[0]!];
}

function requiredAlias(value: JsonRecord, names: readonly string[], code: string): unknown {
  const result = alias(value, names, code);
  if (result === undefined) fail(code);
  return result;
}

function canonicalRef(value: unknown, expectedType: string | undefined, code: string): JsonRecord {
  const ref = record(value, code);
  exactKeys(ref, new Set(['ref_type', 'ref_id', 'object_version', 'canonical_payload_sha256']), code);
  const refType = canonicalString(ownData(ref, 'ref_type', code), code);
  if (!CANONICAL_REF_TYPES.has(refType) || (expectedType !== undefined && refType !== expectedType)) fail(code);
  canonicalString(ownData(ref, 'ref_id', code), code, UUID_V7);
  canonicalString(ownData(ref, 'object_version', code), code, POSITIVE_DECIMAL);
  canonicalString(ownData(ref, 'canonical_payload_sha256', code), code, SHA256);
  return ref;
}

/** The evidence schema uses a short CanonicalRef (type/id), not a versioned ref. */
function canonicalShortRef(value: unknown, code: string): JsonRecord {
  const ref = record(value, code);
  exactKeys(ref, new Set(['ref_type', 'ref_id']), code);
  const refType = canonicalString(ownData(ref, 'ref_type', code), code);
  if (!CANONICAL_REF_TYPES.has(refType)) fail(code);
  canonicalString(ownData(ref, 'ref_id', code), code, UUID_V7);
  return ref;
}

function idArray(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) fail(code);
  const result = value.map((item) => canonicalString(item, code, UUID_V7));
  if (new Set(result).size !== result.length) fail(code);
  return Object.freeze(result);
}

function canonicalGovernance(value: unknown, code = 'REALTIME_TERMINAL_CODEC_GOVERNANCE_INVALID'): JsonRecord {
  const governance = record(value, code);
  exactKeys(governance, new Set([
    'purpose_scopes', 'consent_record_refs', 'policy_decision_refs', 'purpose_token_refs',
    'capability_grant_refs', 'audit_ref',
  ]), code);
  const purposeScopesValue = ownData(governance, 'purpose_scopes', code);
  if (!Array.isArray(purposeScopesValue) || purposeScopesValue.length === 0) fail(code);
  const purposeScopes = purposeScopesValue.map((item) => canonicalString(item, code, PURPOSE_SCOPE));
  if (new Set(purposeScopes).size !== purposeScopes.length) fail(code);
  const output: JsonRecord = { purpose_scopes: Object.freeze(purposeScopes) };
  for (const [key, field] of [
    ['consent_record_refs', 'consent_record_refs'],
    ['policy_decision_refs', 'policy_decision_refs'],
    ['purpose_token_refs', 'purpose_token_refs'],
    ['capability_grant_refs', 'capability_grant_refs'],
  ] as const) {
    if (Object.hasOwn(governance, key)) output[field] = idArray(governance[key], code);
  }
  if (!Object.hasOwn(output, 'policy_decision_refs') || !Object.hasOwn(output, 'capability_grant_refs')) fail(code);
  if (Object.hasOwn(governance, 'audit_ref')) output.audit_ref = canonicalRef(governance.audit_ref, 'AuditRecord', code);
  return snapshotJson(output, code) as JsonRecord;
}

function canonicalIdempotencyScope(value: unknown, code: string): JsonRecord {
  const scope = record(value, code);
  exactKeys(scope, new Set(['owner_module', 'operation_kind', 'target_object_type', 'user_id', 'tenant_id', 'target_object_id']), code);
  const owner = canonicalString(ownData(scope, 'owner_module', code), code);
  const allowedOwners = new Set([
    'SCOPED_DOMAIN_OWNER', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
    'T11A', 'T11B', 'T12', 'T13', 'T14',
  ]);
  if (!allowedOwners.has(owner)) fail(code);
  canonicalString(ownData(scope, 'operation_kind', code), code, OPERATION_KIND);
  canonicalString(ownData(scope, 'target_object_type', code), code);
  for (const key of ['user_id', 'tenant_id', 'target_object_id'] as const) {
    if (Object.hasOwn(scope, key)) canonicalString(scope[key], code, UUID_V7);
  }
  return scope;
}

function canonicalIdempotencyContext(value: unknown, expectedKey: string, code: string): JsonRecord {
  const context = record(value, code);
  exactKeys(context, new Set([
    'idempotency_scope', 'idempotency_key', 'idempotency_profile_id', 'idempotency_profile_version',
    'idempotency_profile_sha256', 'idempotency_request_sha256',
  ]), code);
  const key = canonicalString(ownData(context, 'idempotency_key', code), code, IDEMPOTENCY_KEY);
  if (key !== expectedKey) fail(code);
  canonicalIdempotencyScope(ownData(context, 'idempotency_scope', code), code);
  canonicalString(ownData(context, 'idempotency_profile_id', code), code, HTTPS_URI);
  canonicalString(ownData(context, 'idempotency_profile_version', code), code, SEMVER);
  canonicalString(ownData(context, 'idempotency_profile_sha256', code), code, SHA256);
  canonicalString(ownData(context, 'idempotency_request_sha256', code), code, SHA256);
  return context;
}

function canonicalAuditRef(value: unknown, code: string): JsonRecord {
  return canonicalRef(value, 'AuditRecord', code);
}

function canonicalError(value: unknown, code: string): JsonRecord {
  const error = record(value, code);
  exactKeys(error, new Set(['error_family', 'error_code', 'retry_class', 'trace_id', 'occurred_at', 'audit_ref']), code);
  const family = canonicalString(ownData(error, 'error_family', code), code);
  if (!ERROR_FAMILIES.has(family)) fail(code);
  const errorCode = canonicalString(ownData(error, 'error_code', code), code, ERROR_CODE);
  if (!errorCode.startsWith(`${family}.`)) fail(code);
  const retryClass = canonicalString(ownData(error, 'retry_class', code), code);
  if (!RETRY_CLASSES.has(retryClass)) fail(code);
  canonicalString(ownData(error, 'trace_id', code), code, UUID_V7);
  const occurredAt = ownData(error, 'occurred_at', code);
  assertCanonicalTimestamp(occurredAt);
  if (typeof occurredAt !== 'string' || !SYSTEM_TIME.test(occurredAt)) fail(code);
  if (Object.hasOwn(error, 'audit_ref')) canonicalAuditRef(error.audit_ref, code);
  return error;
}

function canonicalRecordedResultReference(value: unknown, expectedOutcome: string, expectedContext: JsonRecord, code: string): JsonRecord {
  const reference = record(value, code);
  exactKeys(reference, new Set([
    'idempotency_context', 'fencing_epoch', 'outcome_class', 'result_schema_id',
    'result_schema_version', 'result_schema_sha256', 'result_payload_sha256',
  ]), code);
  if (!same(reference.idempotency_context, expectedContext)) fail('REALTIME_TERMINAL_CODEC_RRR_BINDING_INVALID');
  canonicalString(reference.fencing_epoch, code, CONNECTION_EPOCH);
  if (reference.outcome_class !== expectedOutcome) fail(code);
  canonicalString(reference.result_schema_id, code, HTTPS_URI);
  canonicalString(reference.result_schema_version, code, SEMVER);
  canonicalString(reference.result_schema_sha256, code, SHA256);
  canonicalString(reference.result_payload_sha256, code, SHA256);
  return reference;
}

function canonicalOutcome(value: unknown, expectedContext: JsonRecord, expectedStatus: TerminalStatus | undefined, code: string): JsonRecord {
  const raw = record(value, code);
  exactKeys(raw, new Set([
    'outcome_class', 'outcomeClass', 'error', 'recorded_result_ref', 'recordedResultReference',
    'resolution_mode', 'resolutionMode',
  ]), code);
  const outcomeClass = canonicalString(requiredAlias(raw, ['outcome_class', 'outcomeClass'], code), code);
  if (!OUTCOME_CLASSES.has(outcomeClass)) fail(code);
  if (expectedStatus === 'success' && outcomeClass !== 'committed_success') fail('REALTIME_TERMINAL_CODEC_STATUS_OUTCOME_INVALID');
  if (expectedStatus === 'indeterminate' && outcomeClass !== 'indeterminate') fail('REALTIME_TERMINAL_CODEC_STATUS_OUTCOME_INVALID');
  if (expectedStatus !== undefined && expectedStatus !== 'success' && outcomeClass === 'committed_success') {
    fail('REALTIME_TERMINAL_CODEC_STATUS_OUTCOME_INVALID');
  }
  const output: JsonRecord = { outcome_class: outcomeClass };
  if (Object.hasOwn(raw, 'error')) output.error = canonicalError(raw.error, code);
  if (Object.hasOwn(raw, 'resolution_mode') || Object.hasOwn(raw, 'resolutionMode')) {
    const resolution = canonicalString(requiredAlias(raw, ['resolution_mode', 'resolutionMode'], code), code);
    if (!RESOLUTION_MODES.has(resolution)) fail(code);
    output.resolution_mode = resolution;
  }
  const referenceValue = alias(raw, ['recorded_result_ref', 'recordedResultReference'], code);
  if (referenceValue !== undefined) output.recorded_result_ref = canonicalRecordedResultReference(referenceValue, outcomeClass, expectedContext, code);
  if (outcomeClass === 'pre_claim_rejection' || outcomeClass === 'rollback_no_commit' || outcomeClass === 'indeterminate') {
    if (!Object.hasOwn(output, 'error') || Object.hasOwn(output, 'recorded_result_ref') || Object.hasOwn(output, 'resolution_mode')) fail(code);
  } else if (outcomeClass === 'committed_rejection') {
    if (!Object.hasOwn(output, 'error') || !Object.hasOwn(output, 'recorded_result_ref') || !Object.hasOwn(output, 'resolution_mode')) fail(code);
  } else if (!Object.hasOwn(output, 'recorded_result_ref') || !Object.hasOwn(output, 'resolution_mode') || Object.hasOwn(output, 'error')) {
    fail(code);
  }
  if (outcomeClass === 'indeterminate') {
    const error = output.error as JsonRecord;
    if (error.retry_class !== 'never') fail(code);
  }
  return snapshotJson(output, code) as JsonRecord;
}

function canonicalEvidenceReference(value: unknown, code: string): JsonRecord {
  const evidence = record(value, code);
  exactKeys(evidence, new Set([
    'evidence_ref', 'evidence_origin', 'content_mode', 'schema_id', 'schema_version',
    'metadata_sha256', 'content_sha256', 'source_artifact_id', 'artifact_version_id',
    'evidence_span_id', 'internal_input_refs',
  ]), code);
  canonicalRef(evidence.evidence_ref, undefined, code);
  if (evidence.evidence_origin !== 'external' && evidence.evidence_origin !== 'internal') fail(code);
  if (evidence.content_mode !== 'immutable_bytes' && evidence.content_mode !== 'metadata_only') fail(code);
  if (evidence.schema_id !== 'https://personal-ai-os.local/contracts/common/evidence-reference.v1.schema.json' || evidence.schema_version !== '1.0.0') fail(code);
  canonicalString(evidence.metadata_sha256, code, SHA256);
  if (evidence.content_mode === 'immutable_bytes') canonicalString(ownData(evidence, 'content_sha256', code), code, SHA256);
  else if (Object.hasOwn(evidence, 'content_sha256')) fail(code);
  if (evidence.evidence_origin === 'external') {
    canonicalString(ownData(evidence, 'source_artifact_id', code), code, UUID_V7);
    canonicalString(ownData(evidence, 'artifact_version_id', code), code, UUID_V7);
    canonicalString(ownData(evidence, 'evidence_span_id', code), code, UUID_V7);
    if (Object.hasOwn(evidence, 'internal_input_refs')) fail(code);
  } else {
    if (Object.hasOwn(evidence, 'source_artifact_id') || Object.hasOwn(evidence, 'artifact_version_id') || Object.hasOwn(evidence, 'evidence_span_id')) fail(code);
    const refs = evidence.internal_input_refs;
    if (!Array.isArray(refs) || refs.length === 0) fail(code);
    const validated = refs.map((item) => canonicalShortRef(item, code));
    if (new Set(validated.map((item) => JSON.stringify(item))).size !== validated.length) fail(code);
  }
  return evidence;
}

function canonicalFacts(value: unknown, code: string): JsonRecord {
  const facts = record(value, code);
  exactKeys(facts, new Set([
    'closure_status', 'closureStatus', 'device_lease_release', 'deviceLeaseRelease',
    'participant_cleanup', 'participantCleanup', 'track_cleanup', 'trackCleanup',
    'room_cleanup', 'roomCleanup', 'evidence_refs', 'evidenceRefs',
  ]), code);
  const closure = canonicalString(requiredAlias(facts, ['closure_status', 'closureStatus'], code), code);
  if (!CLOSURE_STATUSES.has(closure)) fail(code);
  const output: JsonRecord = { closure_status: closure };
  for (const [wire, internal] of [
    ['device_lease_release', 'deviceLeaseRelease'],
    ['participant_cleanup', 'participantCleanup'],
    ['track_cleanup', 'trackCleanup'],
    ['room_cleanup', 'roomCleanup'],
  ] as const) {
    const item = alias(facts, [wire, internal], code);
    if (item === undefined) continue;
    const text = canonicalString(item, code);
    if (wire === 'device_lease_release') {
      if (!LEASE_RELEASES.has(text)) fail(code);
    } else if (!CLEANUP_FACTS.has(text)) fail(code);
    output[wire] = text;
  }
  const evidenceValue = alias(facts, ['evidence_refs', 'evidenceRefs'], code);
  if (evidenceValue !== undefined) {
    if (!Array.isArray(evidenceValue) || evidenceValue.length === 0) fail(code);
    const evidence = evidenceValue.map((item) => canonicalEvidenceReference(item, code));
    if (new Set(evidence.map((item) => JSON.stringify(item))).size !== evidence.length) fail(code);
    output.evidence_refs = Object.freeze(evidence);
  }
  return snapshotJson(output, code) as JsonRecord;
}

function validateTerminalStatus(value: unknown, code: string): TerminalStatus {
  const status = canonicalString(value, code);
  if (!TERMINAL_STATUSES.has(status as TerminalStatus)) fail(code);
  return status as TerminalStatus;
}

function validateTerminalWire(value: unknown, operation: TerminalOperation, code: string): JsonRecord {
  const wire = record(value, code);
  exactKeys(wire, TERMINAL_WIRE_KEYS[operation], code);
  if (wire.operation !== operation) fail('REALTIME_TERMINAL_CODEC_OPERATION_INVALID');
  const requestId = canonicalString(wire.request_id, code, IDEMPOTENCY_KEY);
  canonicalIdempotencyContext(wire.idempotency_context, requestId, code);
  canonicalRef(wire.realtime_session_ref, 'RealtimeSession', code);
  canonicalString(wire.continuity_id, code, UUID_V7);
  canonicalString(wire.connection_epoch, code, CONNECTION_EPOCH);
  if (operation === 'media_stop') {
    canonicalRef(wire.device_lease_ref, 'DeviceLease', code);
    if (wire.transport_aliases !== undefined) {
      if (!Array.isArray(wire.transport_aliases) || wire.transport_aliases.length === 0) fail(code);
      for (const aliasValue of wire.transport_aliases) {
        const item = record(aliasValue, code);
        exactKeys(item, new Set(['alias_type', 'issuer', 'value', 'provider_id']), code);
        canonicalString(item.alias_type, code, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
        canonicalString(item.issuer, code, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);
        canonicalString(item.value, code);
        if (Object.hasOwn(item, 'provider_id')) canonicalString(item.provider_id, code, UUID_V7);
      }
    }
    if (wire.expected_lease_version !== undefined) canonicalString(wire.expected_lease_version, code, CONNECTION_EPOCH);
  } else if (wire.expected_lease_version !== undefined) {
    canonicalString(wire.expected_lease_version, code, CONNECTION_EPOCH);
  }
  canonicalGovernance(wire.governance, code);
  return wire;
}

function validateHandoffWire(value: unknown, code: string): JsonRecord {
  const wire = record(value, code);
  exactKeys(wire, HANDOFF_WIRE_KEYS, code);
  if (wire.operation !== 'handoff') fail('REALTIME_TERMINAL_CODEC_OPERATION_INVALID');
  const requestId = canonicalString(wire.request_id, code, IDEMPOTENCY_KEY);
  canonicalIdempotencyContext(wire.idempotency_context, requestId, code);
  canonicalRef(wire.realtime_session_ref, 'RealtimeSession', code);
  canonicalRef(wire.current_device_lease_ref, 'DeviceLease', code);
  canonicalString(wire.continuity_id, code, UUID_V7);
  canonicalString(wire.connection_epoch, code, CONNECTION_EPOCH);
  canonicalString(wire.expected_lease_version, code, CONNECTION_EPOCH);
  canonicalString(wire.from_device_id, code, UUID_V7);
  canonicalString(wire.to_device_id, code, UUID_V7);
  if (wire.from_device_id === wire.to_device_id) fail('REALTIME_TERMINAL_CODEC_HANDOFF_DEVICE_INVALID');
  canonicalGovernance(wire.governance, code);
  return wire;
}

function validateStopRequest(value: unknown, operation: TerminalOperation, wire: JsonRecord, governance: JsonRecord, code: string): JsonRecord {
  const request = record(value, code);
  exactKeys(request, STOP_REQUEST_KEYS, code);
  if (request.operation !== operation) fail('REALTIME_TERMINAL_CODEC_OPERATION_INVALID');
  const requestId = canonicalString(request.requestId, code, IDEMPOTENCY_KEY);
  const idempotencyKey = canonicalString(request.idempotencyKey, code, IDEMPOTENCY_KEY);
  if (requestId !== wire.request_id || idempotencyKey !== wire.request_id) fail('REALTIME_TERMINAL_CODEC_REQUEST_BINDING_INVALID');
  canonicalRef(request.realtimeSessionRef, 'RealtimeSession', code);
  if (!same(request.realtimeSessionRef, wire.realtime_session_ref) || request.continuityId !== wire.continuity_id || request.expectedConnectionEpoch !== wire.connection_epoch) {
    fail('REALTIME_TERMINAL_CODEC_REQUEST_BINDING_INVALID');
  }
  canonicalString(request.continuityId, code, UUID_V7);
  canonicalString(request.expectedConnectionEpoch, code, CONNECTION_EPOCH);
  canonicalString(request.deviceId, code);
  if (request.deviceLeaseRef !== undefined) canonicalRef(request.deviceLeaseRef, 'DeviceLease', code);
  if (operation === 'media_stop' && !same(request.deviceLeaseRef, wire.device_lease_ref)) fail('REALTIME_TERMINAL_CODEC_REQUEST_BINDING_INVALID');
  if (request.expectedLeaseVersion !== undefined) canonicalString(request.expectedLeaseVersion, code, CONNECTION_EPOCH);
  // media_stop carries the credential generation the T11b adapter fenced (same stop-request contract as the composition).
  if (request.credentialGeneration !== undefined) canonicalString(request.credentialGeneration, code, CONNECTION_EPOCH);
  assertCanonicalTimestamp(request.occurredAt);
  if (!same(request.governance, governance)) fail('REALTIME_TERMINAL_CODEC_GOVERNANCE_BINDING_INVALID');
  return request;
}

function validateHandoffRequest(value: unknown, wire: JsonRecord, governance: JsonRecord, code: string): JsonRecord {
  const request = record(value, code);
  exactKeys(request, HANDOFF_REQUEST_KEYS, code);
  if (request.requestId !== wire.request_id || request.idempotencyKey !== wire.request_id ||
      !same(request.realtimeSessionRef, wire.realtime_session_ref) || request.continuityId !== wire.continuity_id ||
      request.fromDeviceId !== wire.from_device_id || request.toDeviceId !== wire.to_device_id ||
      request.expectedConnectionEpoch !== wire.connection_epoch || request.expectedLeaseVersion !== wire.expected_lease_version) {
    fail('REALTIME_TERMINAL_CODEC_REQUEST_BINDING_INVALID');
  }
  canonicalString(request.requestId, code, IDEMPOTENCY_KEY);
  canonicalString(request.idempotencyKey, code, IDEMPOTENCY_KEY);
  canonicalRef(request.realtimeSessionRef, 'RealtimeSession', code);
  canonicalString(request.continuityId, code, UUID_V7);
  canonicalString(request.fromDeviceId, code, UUID_V7);
  canonicalString(request.toDeviceId, code, UUID_V7);
  canonicalString(request.expectedConnectionEpoch, code, CONNECTION_EPOCH);
  canonicalString(request.expectedLeaseVersion, code, CONNECTION_EPOCH);
  assertCanonicalTimestamp(request.occurredAt);
  if (!same(request.governance, governance)) fail('REALTIME_TERMINAL_CODEC_GOVERNANCE_BINDING_INVALID');
  return request;
}

function validateOwner(value: unknown, fromDeviceId: string, code: string): JsonRecord {
  const owner = record(value, code);
  exactKeys(owner, OWNER_KEYS, code);
  canonicalString(owner.userId, code);
  if (owner.deviceId !== fromDeviceId) fail('REALTIME_TERMINAL_CODEC_OWNER_BINDING_INVALID');
  canonicalString(owner.deviceId, code, UUID_V7);
  canonicalString(owner.purpose, code);
  if (!Array.isArray(owner.capabilities) || owner.capabilities.length === 0 || owner.capabilities.some((item) => typeof item !== 'string' || item.length === 0 || item.trim() !== item)) fail(code);
  assertCanonicalTimestamp(owner.occurredAt);
  return owner;
}

function validateReceipt(value: unknown, operation: TerminalOperation, wire: JsonRecord, request: JsonRecord, governance: JsonRecord, code: string): JsonRecord {
  const receipt = record(value, code);
  exactKeys(receipt, RECEIPT_KEYS, code);
  if (receipt.kind !== 'realtime_terminal_receipt' || receipt.operation !== operation) fail('REALTIME_TERMINAL_CODEC_RECEIPT_BINDING_INVALID');
  const status = validateTerminalStatus(receipt.status, code);
  if (receipt.requestId !== request.requestId || receipt.requestId !== wire.request_id || receipt.idempotencyKey !== request.idempotencyKey) fail('REALTIME_TERMINAL_CODEC_RECEIPT_BINDING_INVALID');
  canonicalString(receipt.requestId, code, IDEMPOTENCY_KEY);
  canonicalString(receipt.idempotencyKey, code, IDEMPOTENCY_KEY);
  if (!same(receipt.realtimeSessionRef, request.realtimeSessionRef) || receipt.continuityId !== request.continuityId || receipt.connectionEpoch !== request.expectedConnectionEpoch) fail('REALTIME_TERMINAL_CODEC_RECEIPT_BINDING_INVALID');
  canonicalRef(receipt.realtimeSessionRef, 'RealtimeSession', code);
  if (receipt.deviceLeaseRef !== undefined) canonicalRef(receipt.deviceLeaseRef, 'DeviceLease', code);
  if (operation === 'media_stop' && !same(receipt.deviceLeaseRef, request.deviceLeaseRef)) fail('REALTIME_TERMINAL_CODEC_RECEIPT_BINDING_INVALID');
  canonicalString(receipt.continuityId, code, UUID_V7);
  canonicalString(receipt.connectionEpoch, code, CONNECTION_EPOCH);
  if (receipt.leaseVersion !== undefined) canonicalString(receipt.leaseVersion, code, CONNECTION_EPOCH);
  if (typeof receipt.outcome !== 'string' && !isPlainRecord(receipt.outcome)) fail(code);
  if (Object.hasOwn(receipt, 'errorCode') && receipt.errorCode !== undefined) canonicalString(receipt.errorCode, code);
  assertCanonicalTimestamp(receipt.recordedAt);
  if (typeof receipt.replayed !== 'boolean') fail(code);
  if (Object.hasOwn(receipt, 'governance') && !same(receipt.governance, governance)) fail('REALTIME_TERMINAL_CODEC_GOVERNANCE_BINDING_INVALID');
  const receiptGovernance = canonicalGovernance(governance, code);
  if (!same(receiptGovernance, canonicalGovernance(wire.governance, code))) fail('REALTIME_TERMINAL_CODEC_GOVERNANCE_BINDING_INVALID');
  if (status === 'success' && receipt.replayed !== false && receipt.replayed !== true) fail(code);
  return receipt;
}

function receiptOutcome(receipt: JsonRecord, facts: unknown, context: JsonRecord, status: TerminalStatus, code: string): JsonRecord {
  const value = alias(receipt, ['operation_outcome', 'operationOutcome'], code) ??
    (isPlainRecord(receipt.outcome) ? receipt.outcome : undefined);
  if (value === undefined) fail('REALTIME_TERMINAL_CODEC_CANONICAL_OUTCOME_REQUIRED');
  return canonicalOutcome(value, context, status, code);
}

function receiptFacts(receipt: JsonRecord, provided: unknown, operation: TerminalOperation, status: TerminalStatus, code: string): JsonRecord {
  const value = provided ?? alias(receipt, ['execution_facts', 'executionFacts'], code);
  if (value === undefined) {
    if (operation === 'end_continuity') return Object.freeze({ closure_status: 'not_applicable' });
    fail('REALTIME_TERMINAL_CODEC_EXECUTION_FACTS_REQUIRED');
  }
  const facts = canonicalFacts(value, code);
  if (operation === 'media_stop' && status === 'success' &&
      (facts.closure_status !== 'verified_closed' || !['released', 'already_released'].includes(String(facts.device_lease_release)) ||
       facts.participant_cleanup !== 'verified_absent' || facts.track_cleanup !== 'verified_absent' || facts.room_cleanup !== 'verified_absent')) {
    fail('REALTIME_TERMINAL_CODEC_FALSE_SUCCESS');
  }
  return facts;
}

function terminalOutput(input: JsonRecord): JsonRecord {
  exactKeys(input, OUTER_TERMINAL_KEYS, 'REALTIME_TERMINAL_CODEC_INPUT_INVALID');
  const operation = input.operation;
  if (operation !== 'media_stop' && operation !== 'end_continuity') fail('REALTIME_TERMINAL_CODEC_OPERATION_INVALID');
  const governance = canonicalGovernance(input.governance);
  const wire = validateTerminalWire(input.wireRequest, operation, 'REALTIME_TERMINAL_CODEC_WIRE_REQUEST_INVALID');
  if (!same(governance, canonicalGovernance(wire.governance, 'REALTIME_TERMINAL_CODEC_GOVERNANCE_INVALID'))) fail('REALTIME_TERMINAL_CODEC_GOVERNANCE_BINDING_INVALID');
  const request = validateStopRequest(input.request, operation, wire, governance, 'REALTIME_TERMINAL_CODEC_REQUEST_INVALID');
  const receipt = validateReceipt(input.receipt, operation, wire, request, governance, 'REALTIME_TERMINAL_CODEC_RECEIPT_INVALID');
  const context = canonicalIdempotencyContext(wire.idempotency_context, wire.request_id as string, 'REALTIME_TERMINAL_CODEC_IDEMPOTENCY_INVALID');
  const status = receipt.status as TerminalStatus;
  const outcome = receiptOutcome(receipt, input.executionFacts, context, status, 'REALTIME_TERMINAL_CODEC_OUTCOME_INVALID');
  const facts = receiptFacts(receipt, input.executionFacts, operation, status, 'REALTIME_TERMINAL_CODEC_FACTS_INVALID');
  const output: JsonRecord = {
    operation,
    status,
    request_id: wire.request_id,
    realtime_session_ref: receipt.realtimeSessionRef,
    continuity_id: wire.continuity_id,
    connection_epoch: receipt.connectionEpoch,
    operation_outcome: outcome,
    execution_facts: facts,
    governance,
  };
  // The result echoes the binding the request named: only media_stop addresses a device lease.
  if (operation === 'media_stop' && receipt.deviceLeaseRef !== undefined) output.device_lease_ref = receipt.deviceLeaseRef;
  assertNoForbiddenKeys(output);
  return snapshotJson(output, 'REALTIME_TERMINAL_CODEC_OUTPUT_INVALID') as JsonRecord;
}

function fence(value: unknown, wire: JsonRecord, expectedLease: JsonRecord | undefined, expectedToken: string | undefined, code: string): JsonRecord {
  const raw = record(value, code);
  exactKeys(raw, new Set([
    'from_device_id', 'fromDeviceId', 'previous_device_lease_ref', 'previousDeviceLeaseRef',
    'new_device_lease_ref', 'newDeviceLeaseRef', 'connection_epoch', 'connectionEpoch',
    'fencing_token', 'fencingToken', 'state',
  ]), code);
  const from = canonicalString(requiredAlias(raw, ['from_device_id', 'fromDeviceId'], code), code, UUID_V7);
  const previous = canonicalRef(requiredAlias(raw, ['previous_device_lease_ref', 'previousDeviceLeaseRef'], code), 'DeviceLease', code);
  const next = canonicalRef(requiredAlias(raw, ['new_device_lease_ref', 'newDeviceLeaseRef'], code), 'DeviceLease', code);
  const epoch = canonicalString(requiredAlias(raw, ['connection_epoch', 'connectionEpoch'], code), code, CONNECTION_EPOCH);
  const token = canonicalString(requiredAlias(raw, ['fencing_token', 'fencingToken'], code), code, CONNECTION_EPOCH);
  if (raw.state !== 'old_device_suppressed' || from !== wire.from_device_id || !same(previous, wire.current_device_lease_ref) || epoch !== wire.connection_epoch) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
  if (expectedLease !== undefined && !same(next, expectedLease)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
  if (expectedToken !== undefined && token !== expectedToken) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
  return {
    from_device_id: from,
    previous_device_lease_ref: previous,
    new_device_lease_ref: next,
    connection_epoch: epoch,
    fencing_token: token,
    state: 'old_device_suppressed',
  };
}

interface SuppressionProjection {
  readonly fence: JsonRecord;
  readonly facts?: JsonRecord;
}

function suppression(value: unknown, wire: JsonRecord, expectedLease: JsonRecord | undefined, expectedToken: string | undefined, required: boolean): SuppressionProjection | undefined {
  if (value === undefined) {
    if (required) fail('REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_REQUIRED');
    return undefined;
  }
  const raw = record(value, 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
  exactKeys(raw, new Set([
    'state', 'closure_status', 'closureStatus', 'closure', 'evidence_refs', 'evidenceRefs',
    'old_device_suppression_fence', 'oldDeviceSuppressionFence', 'fence', 'output_fence',
    'participant_cleanup', 'participantCleanup', 'track_cleanup', 'trackCleanup',
    'room_cleanup', 'roomCleanup', 'execution_facts', 'executionFacts',
  ]), 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
  const fenceValue = alias(raw, ['old_device_suppression_fence', 'oldDeviceSuppressionFence', 'fence', 'output_fence'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
  if (fenceValue === undefined) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
  const boundFence = fence(fenceValue, wire, expectedLease, expectedToken, 'REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
  const closureValue = alias(raw, ['closure_status', 'closureStatus', 'closure'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
  const evidenceValue = alias(raw, ['evidence_refs', 'evidenceRefs'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
  const factsValue = alias(raw, ['execution_facts', 'executionFacts'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
  let facts: JsonRecord | undefined;
  if (factsValue !== undefined) facts = canonicalFacts(factsValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID');
  else if (closureValue !== undefined || evidenceValue !== undefined || Object.hasOwn(raw, 'participant_cleanup') || Object.hasOwn(raw, 'participantCleanup')) {
    const partial: JsonRecord = {
      closure_status: closureValue,
      ...(evidenceValue === undefined ? {} : { evidence_refs: evidenceValue }),
      ...((alias(raw, ['participant_cleanup', 'participantCleanup'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID') === undefined) ? {} : { participant_cleanup: alias(raw, ['participant_cleanup', 'participantCleanup'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID') }),
      ...((alias(raw, ['track_cleanup', 'trackCleanup'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID') === undefined) ? {} : { track_cleanup: alias(raw, ['track_cleanup', 'trackCleanup'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID') }),
      ...((alias(raw, ['room_cleanup', 'roomCleanup'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID') === undefined) ? {} : { room_cleanup: alias(raw, ['room_cleanup', 'roomCleanup'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID') }),
    };
    if (partial.closure_status === undefined) partial.closure_status = 'not_applicable';
    facts = canonicalFacts(partial, 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID');
  }
  if (required) {
    if (closureValue !== 'verified_closed' || evidenceValue === undefined || !Array.isArray(evidenceValue) || evidenceValue.length === 0) fail('REALTIME_TERMINAL_CODEC_HANDOFF_SUPPRESSION_INVALID');
    /*
     * The T02 suppression owner is only required to attest the old-device
     * fence, closure, and evidence.  Cleanup sub-facts are optional on that
     * seam; fill those optional slots with the non-claiming value while never
     * inventing evidence or a lease transition.
     */
    const supplied: JsonRecord = facts ?? { closure_status: 'verified_closed' };
    facts = canonicalFacts({
      ...supplied,
      closure_status: supplied.closure_status,
      ...(supplied.device_lease_release === undefined ? { device_lease_release: 'released' } : {}),
      ...(supplied.participant_cleanup === undefined ? { participant_cleanup: 'not_requested' } : {}),
      ...(supplied.track_cleanup === undefined ? { track_cleanup: 'not_requested' } : {}),
      ...(supplied.room_cleanup === undefined ? { room_cleanup: 'not_requested' } : {}),
      ...(supplied.evidence_refs === undefined ? { evidence_refs: evidenceValue } : {}),
    }, 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID');
    if (facts.closure_status !== 'verified_closed' || facts.device_lease_release !== 'released' || !Array.isArray(facts.evidence_refs) || facts.evidence_refs.length === 0 || !same(facts.evidence_refs, canonicalFacts({ closure_status: 'verified_closed', evidence_refs: evidenceValue }, 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID').evidence_refs)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FALSE_SUCCESS');
  }
  return Object.freeze({ fence: snapshotJson(boundFence, 'REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID') as JsonRecord, ...(facts === undefined ? {} : { facts }) });
}

function canonicalHandoffTerminal(value: unknown, wire: JsonRecord, governance: JsonRecord, context: JsonRecord): JsonRecord {
  const terminal = record(value, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  exactKeys(terminal, new Set([
    'operation', 'status', 'request_id', 'realtime_session_ref', 'device_lease_ref',
    'previous_device_lease_ref', 'continuity_id', 'connection_epoch', 'from_device_id',
    'to_device_id', 'lease_version', 'fencing_token', 'old_device_suppression_fence',
    'operation_outcome', 'execution_facts', 'governance',
  ]), 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  if (terminal.operation !== 'handoff' || terminal.request_id !== wire.request_id ||
      !same(terminal.realtime_session_ref, wire.realtime_session_ref) ||
      !same(terminal.previous_device_lease_ref, wire.current_device_lease_ref) ||
      terminal.continuity_id !== wire.continuity_id || terminal.connection_epoch !== wire.connection_epoch ||
      terminal.from_device_id !== wire.from_device_id || terminal.to_device_id !== wire.to_device_id ||
      !same(terminal.governance, governance)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_TERMINAL_BINDING_INVALID');
  const status = validateTerminalStatus(terminal.status, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  canonicalRef(terminal.realtime_session_ref, 'RealtimeSession', 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  canonicalRef(terminal.previous_device_lease_ref, 'DeviceLease', 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  canonicalString(terminal.continuity_id, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID', UUID_V7);
  canonicalString(terminal.connection_epoch, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID', CONNECTION_EPOCH);
  canonicalString(terminal.from_device_id, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID', UUID_V7);
  canonicalString(terminal.to_device_id, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID', UUID_V7);
  const outcome = canonicalOutcome(terminal.operation_outcome, context, status, 'REALTIME_TERMINAL_CODEC_HANDOFF_OUTCOME_INVALID');
  const facts = canonicalFacts(terminal.execution_facts, 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID');
  const output: JsonRecord = {
    operation: 'handoff', status, request_id: wire.request_id,
    realtime_session_ref: terminal.realtime_session_ref,
    previous_device_lease_ref: terminal.previous_device_lease_ref,
    continuity_id: wire.continuity_id, connection_epoch: wire.connection_epoch,
    from_device_id: wire.from_device_id, to_device_id: wire.to_device_id,
    operation_outcome: outcome, execution_facts: facts, governance,
  };
  for (const key of ['device_lease_ref', 'lease_version', 'fencing_token', 'old_device_suppression_fence'] as const) {
    if (Object.hasOwn(terminal, key)) output[key] = terminal[key];
  }
  if (output.device_lease_ref !== undefined) canonicalRef(output.device_lease_ref, 'DeviceLease', 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  if (output.lease_version !== undefined) canonicalString(output.lease_version, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID', CONNECTION_EPOCH);
  if (output.fencing_token !== undefined) canonicalString(output.fencing_token, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID', CONNECTION_EPOCH);
  if (output.old_device_suppression_fence !== undefined) output.old_device_suppression_fence = fence(output.old_device_suppression_fence, wire, output.device_lease_ref as JsonRecord | undefined, output.fencing_token as string | undefined, 'REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
  if (status === 'success' && (output.device_lease_ref === undefined || output.lease_version === undefined || output.fencing_token === undefined)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_SUCCESS_FIELDS_REQUIRED');
  return snapshotJson(output, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID') as JsonRecord;
}

function internalHandoffTerminal(authority: JsonRecord, receipt: JsonRecord | undefined, wire: JsonRecord, governance: JsonRecord, context: JsonRecord): JsonRecord {
  const authorityStatusValue = alias(authority, ['status'], 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  const receiptStatusValue = receipt === undefined ? undefined : alias(receipt, ['status'], 'REALTIME_TERMINAL_CODEC_HANDOFF_RECEIPT_INVALID');
  if (authorityStatusValue === undefined && receiptStatusValue === undefined) fail('REALTIME_TERMINAL_CODEC_HANDOFF_STATUS_REQUIRED');
  const status = validateTerminalStatus(authorityStatusValue ?? receiptStatusValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_STATUS_INVALID');
  if (authorityStatusValue !== undefined && receiptStatusValue !== undefined && authorityStatusValue !== receiptStatusValue) fail('REALTIME_TERMINAL_CODEC_HANDOFF_STATUS_INVALID');
  const authorityRequestId = canonicalString(requiredAlias(authority, ['requestId', 'request_id'], 'REALTIME_TERMINAL_CODEC_HANDOFF_REQUEST_BINDING_INVALID'), 'REALTIME_TERMINAL_CODEC_HANDOFF_REQUEST_BINDING_INVALID', IDEMPOTENCY_KEY);
  if (authorityRequestId !== wire.request_id) fail('REALTIME_TERMINAL_CODEC_HANDOFF_REQUEST_BINDING_INVALID');
  if (receipt !== undefined && receipt.requestId !== undefined && receipt.requestId !== wire.request_id) fail('REALTIME_TERMINAL_CODEC_HANDOFF_REQUEST_BINDING_INVALID');
  const sessionValue = requiredAlias(authority, ['realtimeSessionRef', 'realtime_session_ref'], 'REALTIME_TERMINAL_CODEC_HANDOFF_SESSION_REQUIRED');
  const continuityValue = requiredAlias(authority, ['continuityId', 'continuity_id'], 'REALTIME_TERMINAL_CODEC_HANDOFF_CONTINUITY_REQUIRED');
  const epochValue = requiredAlias(authority, ['connectionEpoch', 'connection_epoch'], 'REALTIME_TERMINAL_CODEC_HANDOFF_EPOCH_REQUIRED');
  if (!same(sessionValue, wire.realtime_session_ref) || continuityValue !== wire.continuity_id || epochValue !== wire.connection_epoch) fail('REALTIME_TERMINAL_CODEC_HANDOFF_TERMINAL_BINDING_INVALID');
  canonicalRef(sessionValue, 'RealtimeSession', 'REALTIME_TERMINAL_CODEC_HANDOFF_SESSION_REQUIRED');
  canonicalString(continuityValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_CONTINUITY_REQUIRED', UUID_V7);
  canonicalString(epochValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_EPOCH_REQUIRED', CONNECTION_EPOCH);
  const fromValue = alias(authority, ['fromDeviceId', 'from_device_id'], 'REALTIME_TERMINAL_CODEC_HANDOFF_DEVICE_BINDING_INVALID');
  const toValue = alias(authority, ['toDeviceId', 'to_device_id'], 'REALTIME_TERMINAL_CODEC_HANDOFF_DEVICE_BINDING_INVALID');
  if (fromValue !== undefined && fromValue !== wire.from_device_id) fail('REALTIME_TERMINAL_CODEC_HANDOFF_DEVICE_BINDING_INVALID');
  if (toValue !== undefined && toValue !== wire.to_device_id) fail('REALTIME_TERMINAL_CODEC_HANDOFF_DEVICE_BINDING_INVALID');
  const previousValue = alias(authority, ['previousDeviceLeaseRef', 'previous_device_lease_ref'], 'REALTIME_TERMINAL_CODEC_HANDOFF_PREVIOUS_LEASE_REQUIRED') ?? wire.current_device_lease_ref;
  const newValue = alias(authority, ['activeDeviceLeaseRef', 'active_device_lease_ref', 'deviceLeaseRef', 'device_lease_ref'], 'REALTIME_TERMINAL_CODEC_HANDOFF_NEW_LEASE_REQUIRED');
  const versionValue = alias(authority, ['leaseVersion', 'lease_version'], 'REALTIME_TERMINAL_CODEC_HANDOFF_LEASE_REQUIRED');
  const tokenValue = alias(authority, ['fencingToken', 'fencing_token'], 'REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_REQUIRED');
  canonicalRef(previousValue, 'DeviceLease', 'REALTIME_TERMINAL_CODEC_HANDOFF_PREVIOUS_LEASE_REQUIRED');
  if (!same(previousValue, wire.current_device_lease_ref)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_PREVIOUS_LEASE_INVALID');
  const receiptRecord = receipt;
  const outcomeValue = alias(authority, ['operationOutcome', 'operation_outcome'], 'REALTIME_TERMINAL_CODEC_HANDOFF_OUTCOME_REQUIRED') ??
    (receiptRecord === undefined ? undefined : alias(receiptRecord, ['operationOutcome', 'operation_outcome'], 'REALTIME_TERMINAL_CODEC_HANDOFF_OUTCOME_REQUIRED')) ??
    (receiptRecord !== undefined && isPlainRecord(receiptRecord.outcome) ? receiptRecord.outcome : undefined);
  if (outcomeValue === undefined) fail('REALTIME_TERMINAL_CODEC_CANONICAL_OUTCOME_REQUIRED');
  const outcome = canonicalOutcome(outcomeValue, context, status, 'REALTIME_TERMINAL_CODEC_HANDOFF_OUTCOME_INVALID');
  const factsValue = alias(authority, ['executionFacts', 'execution_facts'], 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID') ??
    (receiptRecord === undefined ? undefined : alias(receiptRecord, ['executionFacts', 'execution_facts'], 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID'));
  const output: JsonRecord = {
    operation: 'handoff', status, request_id: wire.request_id,
    realtime_session_ref: sessionValue, previous_device_lease_ref: previousValue,
    continuity_id: continuityValue, connection_epoch: epochValue,
    from_device_id: wire.from_device_id, to_device_id: wire.to_device_id,
    operation_outcome: outcome,
    execution_facts: factsValue === undefined ? { closure_status: 'not_applicable' } : canonicalFacts(factsValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_INVALID'),
    governance,
  };
  if (newValue !== undefined) output.device_lease_ref = canonicalRef(newValue, 'DeviceLease', 'REALTIME_TERMINAL_CODEC_HANDOFF_NEW_LEASE_REQUIRED');
  if (versionValue !== undefined) output.lease_version = canonicalString(versionValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_LEASE_REQUIRED', CONNECTION_EPOCH);
  if (tokenValue !== undefined) output.fencing_token = canonicalString(tokenValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_REQUIRED', CONNECTION_EPOCH);
  if (status === 'success' && (output.device_lease_ref === undefined || output.lease_version === undefined || output.fencing_token === undefined)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_SUCCESS_FIELDS_REQUIRED');
  return snapshotJson(output, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID') as JsonRecord;
}

function handoffOutput(input: JsonRecord): JsonRecord {
  exactKeys(input, OUTER_HANDOFF_KEYS, 'REALTIME_TERMINAL_CODEC_INPUT_INVALID');
  const governance = canonicalGovernance(input.governance);
  const wire = validateHandoffWire(input.wireRequest, 'REALTIME_TERMINAL_CODEC_HANDOFF_WIRE_INVALID');
  if (!same(governance, canonicalGovernance(wire.governance, 'REALTIME_TERMINAL_CODEC_GOVERNANCE_INVALID'))) fail('REALTIME_TERMINAL_CODEC_GOVERNANCE_BINDING_INVALID');
  const request = validateHandoffRequest(input.request, wire, governance, 'REALTIME_TERMINAL_CODEC_HANDOFF_REQUEST_INVALID');
  const owner = validateOwner(input.owner, wire.from_device_id as string, 'REALTIME_TERMINAL_CODEC_HANDOFF_OWNER_INVALID');
  const context = canonicalIdempotencyContext(wire.idempotency_context, wire.request_id as string, 'REALTIME_TERMINAL_CODEC_HANDOFF_IDEMPOTENCY_INVALID');
  const authority = record(input.authorityResult, 'REALTIME_TERMINAL_CODEC_HANDOFF_AUTHORITY_INVALID');
  const direct = authority.operation === 'handoff';
  const preliminary = direct
    ? canonicalHandoffTerminal(authority, wire, governance, context)
    : (() => {
        const nestedReceiptValue = authority.receipt;
        const nestedReceipt = nestedReceiptValue === undefined ? undefined : record(nestedReceiptValue, 'REALTIME_TERMINAL_CODEC_HANDOFF_RECEIPT_INVALID');
        if (nestedReceipt !== undefined) {
          exactKeys(nestedReceipt, RECEIPT_KEYS, 'REALTIME_TERMINAL_CODEC_HANDOFF_RECEIPT_INVALID');
          if (nestedReceipt.kind !== 'realtime_terminal_receipt' || nestedReceipt.operation !== 'handoff') fail('REALTIME_TERMINAL_CODEC_HANDOFF_RECEIPT_INVALID');
          validateTerminalStatus(nestedReceipt.status, 'REALTIME_TERMINAL_CODEC_HANDOFF_RECEIPT_INVALID');
          assertCanonicalTimestamp(nestedReceipt.recordedAt);
          if (nestedReceipt.idempotencyKey !== wire.request_id || nestedReceipt.requestId !== wire.request_id) fail('REALTIME_TERMINAL_CODEC_HANDOFF_RECEIPT_BINDING_INVALID');
        }
        return internalHandoffTerminal(authority, nestedReceipt, wire, governance, context);
      })();
  const status = preliminary.status as TerminalStatus;
  const expectedLease = preliminary.device_lease_ref as JsonRecord | undefined;
  const expectedToken = preliminary.fencing_token as string | undefined;
  const fenceRequired = status === 'success';
  const suppressionResult = input.suppressionResult;
  const suppressionProjection = suppression(suppressionResult, wire, expectedLease, expectedToken, fenceRequired);
  const output = { ...preliminary } as JsonRecord;
  if (status === 'success') {
    if (suppressionProjection === undefined || suppressionProjection.facts === undefined) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_REQUIRED');
    output.old_device_suppression_fence = suppressionProjection.fence;
    const suppliedFacts = output.execution_facts as JsonRecord;
    if (suppliedFacts.closure_status !== 'verified_closed' || suppliedFacts.device_lease_release !== 'released' ||
        !Array.isArray(suppliedFacts.evidence_refs) || !same(suppliedFacts.evidence_refs, suppressionProjection.facts.evidence_refs) ||
        (suppliedFacts.participant_cleanup !== undefined && suppliedFacts.participant_cleanup !== 'verified_absent') ||
        (suppliedFacts.track_cleanup !== undefined && suppliedFacts.track_cleanup !== 'verified_absent') ||
        (suppliedFacts.room_cleanup !== undefined && suppliedFacts.room_cleanup !== 'verified_absent')) {
      fail('REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_BINDING_INVALID');
    }
  } else if (suppressionProjection !== undefined) {
    if (output.old_device_suppression_fence !== undefined && !same(output.old_device_suppression_fence, suppressionProjection.fence)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FENCE_INVALID');
    if (suppressionProjection.facts !== undefined && Object.hasOwn(output, 'execution_facts') && !same(output.execution_facts, suppressionProjection.facts)) fail('REALTIME_TERMINAL_CODEC_HANDOFF_FACTS_BINDING_INVALID');
  }
  assertNoForbiddenKeys(output);
  return snapshotJson(output, 'REALTIME_TERMINAL_CODEC_HANDOFF_OUTPUT_INVALID') as JsonRecord;
}

export function createRealtimePublicControlTerminalCodec(): T11bTerminalCodecPort {
  return Object.freeze({
    encode: async (input: Parameters<T11bTerminalCodecPort['encode']>[0]): Promise<JsonRecord> => terminalOutput(record(input, 'REALTIME_TERMINAL_CODEC_INPUT_INVALID')),
  });
}

export function createRealtimePublicControlHandoffTerminalCodec(): T11bHandoffTerminalCodecPort {
  return Object.freeze({
    encode: async (input: Parameters<T11bHandoffTerminalCodecPort['encode']>[0]): Promise<JsonRecord> => handoffOutput(record(input, 'REALTIME_TERMINAL_CODEC_INPUT_INVALID')),
  });
}

/** Aliases retained for composition callers that name the T01 ownership explicitly. */
export const createRealtimePublicControlT01TerminalCodec = createRealtimePublicControlTerminalCodec;
export const createRealtimePublicControlT01HandoffTerminalCodec = createRealtimePublicControlHandoffTerminalCodec;

export type RealtimePublicControlTerminalCodec = ReturnType<typeof createRealtimePublicControlTerminalCodec>;
export type RealtimePublicControlHandoffTerminalCodec = ReturnType<typeof createRealtimePublicControlHandoffTerminalCodec>;
