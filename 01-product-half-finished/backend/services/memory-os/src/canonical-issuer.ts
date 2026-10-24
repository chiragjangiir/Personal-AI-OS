import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  assertPositiveVersion,
  assertSha256,
  assertUUIDv7,
  canonicalRefKey,
  compareCanonicalObjectVersionRefs,
  isUUIDv7,
  type CanonicalObjectVersionRef,
  type PositiveVersion,
  type Sha256,
  type UUIDv7,
} from "./canonical-ref.ts";
import {
  isCanonicalUtcInstant,
  MEMORY_KINDS,
  type MemoryKind,
  type ReadonlyJsonValue,
} from "./domain.ts";
import type { AdmittedMemoryCandidateIntent } from "./admission.ts";

/** RFC-010 profile identities used by this internal issuer seam. */
export type MemoryIssuerObjectType =
  | "MemoryCandidate"
  | "SemanticFact"
  | "EpisodicMemory"
  | "PreferenceMemory"
  | "OpenLoop";

export type CandidateSuccessorStatus =
  | "candidate"
  | "accepted"
  | "quarantined"
  | "rejected";

export type DurableMemoryStatus =
  | "current"
  | "superseded"
  | "disputed"
  | "suppressed"
  | "deleted";

export interface CanonicalIssuerSystemContext {
  /** T02 supplies this authoritative six-fraction transaction time. */
  readonly systemTime: string;
  /** T05 supplies this body timestamp; it is never filled by a DB default. */
  readonly updatedAt?: string;
  /** The first-lineage created_at omission/value is deliberately preserved. */
  readonly createdAt?: string;
  /** Required for candidate review-successor payloads. */
  readonly reviewedAt?: string;
  readonly deletedAt?: string;
  readonly suppressedAt?: string;
}

/** The complete snake_case persisted shape handed to the later T02 append seam. */
export type CanonicalMemoryPayload = Readonly<Record<string, unknown>> & {
  readonly envelope: Readonly<Record<string, unknown>>;
};

declare const productionIssuerReceiptBrand: unique symbol;

/**
 * A private-brand receipt is the only identity input accepted by production
 * application factories.  The receipt carries the complete canonical payload
 * and its JCS bytes so a later T02 adapter can append exact bytes without
 * deriving a hash from a caller-supplied reference.
 */
export interface ProductionMemoryIssuerReceipt {
  readonly [productionIssuerReceiptBrand]: true;
  readonly kind: "t05_memory_issuer_receipt";
  readonly environment: "production";
  readonly operation:
    | "candidate_create"
    | "candidate_successor"
    | "memory_create"
    | "memory_successor";
  readonly candidateRef?: CanonicalObjectVersionRef;
  readonly memoryRef?: CanonicalObjectVersionRef;
  readonly previousRef?: CanonicalObjectVersionRef;
  /** Durable receipts recursively carry the exact candidate issuer receipt. */
  readonly candidateReceipt?: ProductionMemoryIssuerReceipt;
  readonly candidateBindingSha256: Sha256;
  readonly canonicalPayloadSha256: Sha256;
  readonly canonicalPayloadJcs: string;
  readonly payload: CanonicalMemoryPayload;
};

/** Closed, storage-safe projection of a production receipt. */
export interface ProductionMemoryIssuerReceiptProjection {
  readonly kind: "t05_memory_issuer_receipt_projection";
  readonly environment: "production";
  readonly operation: ProductionMemoryIssuerReceipt["operation"];
  readonly candidateRef?: CanonicalObjectVersionRef;
  readonly memoryRef?: CanonicalObjectVersionRef;
  readonly previousRef?: CanonicalObjectVersionRef;
  readonly candidateReceipt?: ProductionMemoryIssuerReceiptProjection;
  readonly candidateBindingSha256: Sha256;
  readonly canonicalPayloadSha256: Sha256;
  readonly canonicalPayloadJcs: string;
  readonly payload: CanonicalMemoryPayload;
  readonly projectionJcs: string;
  readonly projectionSha256: Sha256;
}

export interface CandidateIssueInput {
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly context: CanonicalIssuerSystemContext;
}

export interface CandidateSuccessorIssueInput {
  readonly previous: ProductionMemoryIssuerReceipt;
  readonly status: CandidateSuccessorStatus;
  readonly context: CanonicalIssuerSystemContext;
}

export interface MemoryIssueInput {
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly resolvedContent: string;
  readonly context: CanonicalIssuerSystemContext;
  /** The candidate admission receipt; raw candidate refs are not accepted. */
  readonly candidateReceipt: ProductionMemoryIssuerReceipt;
}

export interface MemorySuccessorIssueInput extends MemoryIssueInput {
  readonly previous: ProductionMemoryIssuerReceipt;
  readonly status?: DurableMemoryStatus;
}

export interface ProductionMemoryCanonicalIssuer {
  readonly environment: "production";
  issueCandidate(input: CandidateIssueInput): ProductionMemoryIssuerReceipt;
  issueCandidateSuccessor(input: CandidateSuccessorIssueInput): ProductionMemoryIssuerReceipt;
  issueMemory(input: MemoryIssueInput): ProductionMemoryIssuerReceipt;
  issueMemorySuccessor(input: MemorySuccessorIssueInput): ProductionMemoryIssuerReceipt;
}

export interface ProductionMemoryCanonicalIssuerOptions {
  /** A clock seam is allowed for tests; entropy remains node:crypto randomBytes. */
  readonly nowMs?: () => number | bigint;
  readonly maxCollisionAttempts?: number;
}

export interface NonProductionUuidV7Options {
  readonly nowMs: () => number | bigint;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly maxCollisionAttempts?: number;
  readonly issuedIds?: Set<string>;
}

/** Explicitly named test-only UUID generator; never accepted by production factories. */
export interface NonProductionUuidV7Generator {
  readonly environment: "non-production";
  issue(): UUIDv7;
  timestampMs(value: UUIDv7): bigint;
}

/**
 * This adapter exists solely for volatile unit fixtures.  It returns raw refs,
 * not a production receipt, and is intentionally not assignable to any
 * production factory input.
 */
export interface NonProductionMemoryIdentityFixtureAdapter {
  readonly environment: "non-production";
  candidateRefFor(index: number): CanonicalObjectVersionRef;
  memoryRefFor(kind: MemoryKind, index: number): CanonicalObjectVersionRef;
}

const MEMORY_REF_TYPE_BY_KIND: Readonly<Record<MemoryKind, MemoryIssuerObjectType>> = {
  semantic_fact: "SemanticFact",
  episodic_memory: "EpisodicMemory",
  preference_memory: "PreferenceMemory",
  open_loop: "OpenLoop",
};

const PROFILE_SCHEMA_BY_TYPE: Readonly<Record<MemoryIssuerObjectType, string>> = {
  MemoryCandidate: "https://personal-ai-os.local/contracts/memory/memory-candidate.v1.schema.json",
  SemanticFact: "https://personal-ai-os.local/contracts/memory/semantic-fact.v1.schema.json",
  EpisodicMemory: "https://personal-ai-os.local/contracts/memory/episodic-memory.v1.schema.json",
  PreferenceMemory: "https://personal-ai-os.local/contracts/memory/preference-memory.v1.schema.json",
  OpenLoop: "https://personal-ai-os.local/contracts/memory/open-loop.v1.schema.json",
};

const SYSTEM_TIME_PATTERN =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$/;
const MAX_TIMESTAMP = (1n << 48n) - 1n;
const MAX_TAIL = (1n << 74n) - 1n;
const VARIANT_MASK = (1n << 62n) - 1n;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertSystemTime(value: unknown): string {
  if (typeof value !== "string" || !SYSTEM_TIME_PATTERN.test(value)) {
    throw new TypeError("systemTime must be a six-fraction canonical UTC instant");
  }
  return value;
}

function assertEvidenceTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !isCanonicalUtcInstant(value)) {
    throw new TypeError(`${field} must be a canonical UTC instant`);
  }
  return value;
}

function assertJsonValue(value: unknown, field = "value"): asserts value is ReadonlyJsonValue {
  jcsSerialize(value, field);
}

function assertMemoryKind(value: unknown): asserts value is MemoryKind {
  if (!(MEMORY_KINDS as readonly string[]).includes(value as string)) {
    throw new TypeError("memory kind is not a T05 profile kind");
  }
}

function refTypeForKind(kind: MemoryKind): MemoryIssuerObjectType {
  return MEMORY_REF_TYPE_BY_KIND[kind];
}

function isMemoryObjectType(value: unknown): value is MemoryIssuerObjectType {
  return value === "MemoryCandidate" || value === "SemanticFact" ||
    value === "EpisodicMemory" || value === "PreferenceMemory" || value === "OpenLoop";
}

function toWireRef(value: CanonicalObjectVersionRef): Record<string, string> {
  const ref = assertCanonicalObjectVersionRef(value);
  return {
    ref_type: ref.refType,
    ref_id: ref.refId,
    object_version: ref.objectVersion,
    canonical_payload_sha256: ref.canonicalPayloadSha256,
  };
}

function fromWireRef(value: unknown): CanonicalObjectVersionRef {
  if (!isPlainObject(value)) throw new TypeError("wire ref must be an object");
  return assertCanonicalObjectVersionRef({
    refType: value.ref_type,
    refId: value.ref_id,
    objectVersion: value.object_version,
    canonicalPayloadSha256: value.canonical_payload_sha256,
  });
}

function cloneAndFreeze<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value as object)) throw new TypeError("canonical payload contains a cycle");
  ancestors.add(value as object);
  let output: unknown;
  if (Array.isArray(value)) {
    output = Object.freeze(value.map((item) => cloneAndFreeze(item, ancestors)));
  } else if (isPlainObject(value)) {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value)) record[key] = cloneAndFreeze(value[key], ancestors);
    output = Object.freeze(record);
  } else {
    throw new TypeError("canonical payload contains a non-plain value");
  }
  ancestors.delete(value as object);
  return output as T;
}

function assertCanonicalString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${field} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${field} contains an unpaired surrogate`);
    }
  }
  return value;
}

function quoteJcs(value: string): string {
  const input = assertCanonicalString(value, "string");
  let result = '"';
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      result += input[index]! + input[index + 1]!;
      index += 1;
      continue;
    }
    switch (code) {
      case 0x08: result += "\\b"; break;
      case 0x09: result += "\\t"; break;
      case 0x0a: result += "\\n"; break;
      case 0x0c: result += "\\f"; break;
      case 0x0d: result += "\\r"; break;
      case 0x22: result += '\\"'; break;
      case 0x5c: result += "\\\\"; break;
      default:
        result += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : input[index];
    }
  }
  return `${result}"`;
}

/** Small, strict RFC-8785-compatible JSON serializer used only for issuer bytes. */
export function jcsSerialize(value: unknown, field = "value", ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoteJcs(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${field} contains an invalid number`);
    return String(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(`${field} contains an unsupported value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${field} contains a cycle`);
  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        ancestors.delete(value);
        throw new TypeError(`${field} contains a sparse array`);
      }
    }
    result = `[${value.map((item) => jcsSerialize(item, field, ancestors)).join(",")}]`;
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      ancestors.delete(value);
      throw new TypeError(`${field} contains symbol keys`);
    }
    const parts: string[] = [];
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        ancestors.delete(value);
        throw new TypeError(`${field} contains an accessor`);
      }
      parts.push(`${quoteJcs(key)}:${jcsSerialize(descriptor.value, field, ancestors)}`);
    }
    result = `{${parts.join(",")}}`;
  } else {
    ancestors.delete(value);
    throw new TypeError(`${field} contains a non-plain object`);
  }
  ancestors.delete(value);
  return result;
}

export function incrementPositiveDecimal(value: string): PositiveVersion {
  assertPositiveVersion(value);
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    const next = digits[index]!.charCodeAt(0) - 48 + carry;
    if (next === 10) digits[index] = "0";
    else {
      digits[index] = String.fromCharCode(48 + next);
      carry = 0;
    }
  }
  return assertPositiveVersion(carry === 1 ? `1${digits.join("")}` : digits.join(""));
}

function comparePositiveDecimal(left: string, right: string): number {
  assertPositiveVersion(left);
  assertPositiveVersion(right);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneRef(value: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(value);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

function refsEqual(left: CanonicalObjectVersionRef, right: CanonicalObjectVersionRef): boolean {
  return canonicalRefKey(left) === canonicalRefKey(right);
}

function assertOrderedUniqueRefs(refs: readonly CanonicalObjectVersionRef[], field: string): void {
  let previous: CanonicalObjectVersionRef | undefined;
  const seen = new Set<string>();
  for (const value of refs) {
    const ref = assertCanonicalObjectVersionRef(value);
    const key = canonicalRefKey(ref);
    if (seen.has(key)) throw new TypeError(`${field} contains duplicate refs`);
    if (previous !== undefined && compareCanonicalObjectVersionRefs(previous, ref) >= 0) {
      throw new TypeError(`${field} must be RFC-003 ordered`);
    }
    seen.add(key);
    previous = ref;
  }
}

function assertOrderedUniqueStrings(values: readonly string[], field: string): void {
  let previous: string | undefined;
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmptyString(value, field);
    if (seen.has(value) || (previous !== undefined && previous >= value)) {
      throw new TypeError(`${field} must be unique and ordered`);
    }
    seen.add(value);
    previous = value;
  }
}

function normalizeCandidateForBinding(candidate: AdmittedMemoryCandidateIntent): unknown {
  assertNonEmptyString(candidate.proposalId, "candidate.proposalId");
  assertNonEmptyString(candidate.slot, "candidate.slot");
  assertNonEmptyString(candidate.userId, "candidate.userId");
  assertNonEmptyString(candidate.idempotencyKey, "candidate.idempotencyKey");
  assertJsonValue(candidate.value, "candidate.value");
  assertJsonValue(candidate.validity, "candidate.validity");
  assertJsonValue(candidate.sensitivity, "candidate.sensitivity");
  assertOrderedUniqueRefs(candidate.evidenceRefs, "candidate.evidenceRefs");
  assertOrderedUniqueStrings(candidate.purposeScopes, "candidate.purposeScopes");
  if (candidate.correctionIntent?.evidenceRefs !== undefined) {
    assertOrderedUniqueRefs(candidate.correctionIntent.evidenceRefs, "candidate.correctionIntent.evidenceRefs");
  }
  const correction = candidate.correctionIntent;
  return {
    kind: candidate.kind,
    status: candidate.status,
    proposalId: candidate.proposalId,
    slot: candidate.slot,
    value: candidate.value,
    evidenceRefs: candidate.evidenceRefs.map(canonicalRefKey),
    sourceClass: candidate.sourceClass,
    confidencePpm: candidate.confidencePpm,
    idempotencyKey: candidate.idempotencyKey,
    current: false,
    memoryKind: candidate.memoryKind,
    userId: candidate.userId,
    purposeScopes: candidate.purposeScopes,
    sensitivity: candidate.sensitivity,
    validity: candidate.validity,
    ...(candidate.target === undefined ? {} : { target: canonicalRefKey(candidate.target) }),
    ...(correction === undefined ? {} : {
      correctionIntent: {
        kind: correction.kind,
        target: canonicalRefKey(correction.target),
        ...(correction.reason === undefined ? {} : { reason: correction.reason }),
        ...(correction.evidenceRefs === undefined ? {} : {
          evidenceRefs: correction.evidenceRefs.map(canonicalRefKey),
        }),
      },
    }),
    ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    ...(candidate.conflict === undefined ? {} : { conflict: candidate.conflict }),
  };
}

export function candidateBindingSha256(candidate: AdmittedMemoryCandidateIntent): Sha256 {
  return assertSha256(createHash("sha256").update(jcsSerialize(normalizeCandidateForBinding(candidate)), "utf8").digest("hex"));
}

function canonicalPayloadPreimage(payload: CanonicalMemoryPayload): unknown {
  if (!isPlainObject(payload.envelope)) throw new TypeError("payload.envelope must be plain");
  const envelope: Record<string, unknown> = { ...payload.envelope };
  if (!Object.prototype.hasOwnProperty.call(envelope, "canonical_payload_sha256")) {
    throw new TypeError("payload envelope hash must be present");
  }
  delete envelope.canonical_payload_sha256;
  const body: Record<string, unknown> = { ...payload };
  delete body.envelope;
  delete body.ref;
  return { envelope, body };
}

export function canonicalPayloadHash(payload: CanonicalMemoryPayload): {
  readonly jcs: string;
  readonly sha256: Sha256;
} {
  const jcs = jcsSerialize(canonicalPayloadPreimage(payload), "canonical payload");
  return { jcs, sha256: assertSha256(createHash("sha256").update(jcs, "utf8").digest("hex")) };
}

function contextValues(context: CanonicalIssuerSystemContext): {
  readonly systemTime: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly reviewedAt?: string;
  readonly deletedAt?: string;
  readonly suppressedAt?: string;
} {
  const systemTime = assertSystemTime(context.systemTime);
  const createdAt = context.createdAt === undefined ? undefined : assertEvidenceTime(context.createdAt, "createdAt");
  const updatedAt = context.updatedAt === undefined ? undefined : assertEvidenceTime(context.updatedAt, "updatedAt");
  const reviewedAt = context.reviewedAt === undefined ? undefined : assertEvidenceTime(context.reviewedAt, "reviewedAt");
  const deletedAt = context.deletedAt === undefined ? undefined : assertEvidenceTime(context.deletedAt, "deletedAt");
  const suppressedAt = context.suppressedAt === undefined ? undefined : assertEvidenceTime(context.suppressedAt, "suppressedAt");
  return {
    systemTime,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
    ...(suppressedAt === undefined ? {} : { suppressedAt }),
  };
}

function commonEnvelope(input: {
  readonly objectId: UUIDv7;
  readonly objectType: MemoryIssuerObjectType;
  readonly objectVersion: PositiveVersion;
  readonly status: string;
  readonly context: CanonicalIssuerSystemContext;
  readonly sensitivity: "normal" | "sensitive";
}): Record<string, unknown> {
  const context = contextValues(input.context);
  return {
    object_id: input.objectId,
    object_type: input.objectType,
    object_version: input.objectVersion,
    owner_module: "T05",
    status: input.status,
    system_time: context.systemTime,
    event_time_status: "unknown",
    clock_skew_status: "not_applicable",
    contract_version: "1.0.0",
    schema_id: PROFILE_SCHEMA_BY_TYPE[input.objectType],
    schema_version: "1.0.0",
    producer: "memory-os",
    producer_version: "0.1.0",
    canonical_payload_sha256: "0".repeat(64),
    data_sensitivity_class: input.sensitivity === "sensitive" ? "G2" : "G1",
    action_risk_class: "R0",
    egress_mode: "E0",
  };
}

function wireValidity(value: AdmittedMemoryCandidateIntent["validity"]): Record<string, string> {
  const validity: Record<string, string> = {};
  if (value.validFrom !== undefined) validity.valid_from = assertEvidenceTime(value.validFrom, "validFrom");
  if (value.validTo !== undefined) validity.valid_to = assertEvidenceTime(value.validTo, "validTo");
  if (value.observedAt !== undefined) validity.observed_at = assertEvidenceTime(value.observedAt, "observedAt");
  return validity;
}

function wireSensitivity(value: AdmittedMemoryCandidateIntent["sensitivity"]): Record<string, unknown> {
  return {
    classification: value.classification,
    user_confirmed: value.userConfirmed,
  };
}

function candidateBody(candidate: AdmittedMemoryCandidateIntent): Record<string, unknown> {
  assertMemoryKind(candidate.memoryKind);
  assertNonEmptyString(candidate.userId, "candidate.userId");
  assertNonEmptyString(candidate.proposalId, "candidate.proposalId");
  assertNonEmptyString(candidate.slot, "candidate.slot");
  assertNonEmptyString(candidate.idempotencyKey, "candidate.idempotencyKey");
  assertJsonValue(candidate.value, "candidate.value");
  assertOrderedUniqueRefs(candidate.evidenceRefs, "candidate.evidenceRefs");
  assertOrderedUniqueStrings(candidate.purposeScopes, "candidate.purposeScopes");
  const correction = candidate.correctionIntent;
  return {
    proposal_id: candidate.proposalId,
    kind: candidate.kind,
    status: "candidate",
    slot: candidate.slot,
    value: candidate.value,
    evidence_refs: candidate.evidenceRefs.map(toWireRef),
    source_class: candidate.sourceClass,
    confidence_ppm: candidate.confidencePpm,
    idempotency_key: candidate.idempotencyKey,
    current: false,
    memory_kind: candidate.memoryKind,
    user_id: candidate.userId,
    purpose_scopes: candidate.purposeScopes,
    sensitivity: wireSensitivity(candidate.sensitivity),
    validity: wireValidity(candidate.validity),
    requires_review: true,
    ...(candidate.target === undefined ? {} : { target: toWireRef(candidate.target) }),
    ...(correction === undefined ? {} : {
      correction_intent: {
        kind: "correct",
        target: toWireRef(correction.target),
        ...(correction.reason === undefined ? {} : { reason: correction.reason }),
        ...(correction.evidenceRefs === undefined ? {} : {
          evidence_refs: correction.evidenceRefs.map(toWireRef),
        }),
      },
    }),
    ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    ...(candidate.conflict === undefined ? {} : { conflict: candidate.conflict }),
  };
}

function buildCandidatePayload(
  candidate: AdmittedMemoryCandidateIntent,
  objectId: UUIDv7,
  objectVersion: PositiveVersion,
  context: CanonicalIssuerSystemContext,
  previous?: CanonicalObjectVersionRef,
  status: CandidateSuccessorStatus = "candidate",
): CanonicalMemoryPayload {
  const envelope = commonEnvelope({
    objectId,
    objectType: "MemoryCandidate",
    objectVersion,
    status,
    context,
    sensitivity: candidate.sensitivity.classification,
  });
  const body = candidateBody(candidate);
  body.status = status;
  body.requires_review = status === "candidate" || status === "quarantined";
  if (status === "candidate") {
    delete body.reviewed_at;
  } else {
    const reviewedAt = contextValues(context).reviewedAt;
    if (reviewedAt === undefined) throw new TypeError("candidate successor requires reviewedAt");
    body.reviewed_at = reviewedAt;
    body.supersedes = toWireRef(previous!);
  }
  const payload: Record<string, unknown> = { envelope, ...body };
  if (previous !== undefined) {
    payload.supersedes = toWireRef(previous);
    envelope.supersedes_ref = toWireRef(previous);
  }
  return payload as CanonicalMemoryPayload;
}

function durableBody(
  candidate: AdmittedMemoryCandidateIntent,
  status: DurableMemoryStatus,
  resolvedContent: string,
  context: CanonicalIssuerSystemContext,
  previous?: CanonicalObjectVersionRef,
  ref?: CanonicalObjectVersionRef,
): Record<string, unknown> {
  assertMemoryKind(candidate.memoryKind);
  assertNonEmptyString(resolvedContent, "resolvedContent");
  assertOrderedUniqueRefs(candidate.evidenceRefs, "candidate.evidenceRefs");
  assertOrderedUniqueStrings(candidate.purposeScopes, "candidate.purposeScopes");
  const body: Record<string, unknown> = {
    user_id: candidate.userId,
    kind: candidate.memoryKind,
    slot: candidate.slot,
    value: candidate.value,
    resolved_content: resolvedContent,
    status,
    current: status === "current",
    source_class: candidate.sourceClass,
    evidence_refs: candidate.evidenceRefs.map(toWireRef),
    confidence_ppm: candidate.confidencePpm,
    allowed_purpose_scopes: candidate.purposeScopes,
    sensitivity: wireSensitivity(candidate.sensitivity),
    validity: wireValidity(candidate.validity),
  };
  const contextValue = contextValues(context);
  if (contextValue.updatedAt === undefined) {
    throw new TypeError("durable memory version requires issuer updatedAt");
  }
  if (previous !== undefined) {
    body.supersedes = toWireRef(previous);
  }
  if (candidate.correctionIntent !== undefined) {
    body.correction_intent = {
      kind: "correct",
      target: toWireRef(candidate.correctionIntent.target),
      ...(candidate.correctionIntent.reason === undefined ? {} : { reason: candidate.correctionIntent.reason }),
      ...(candidate.correctionIntent.evidenceRefs === undefined ? {} : {
        evidence_refs: candidate.correctionIntent.evidenceRefs.map(toWireRef),
      }),
    };
  }
  if (contextValue.createdAt !== undefined) body.created_at = contextValue.createdAt;
  body.updated_at = contextValue.updatedAt;
  if (status === "deleted") {
    if (contextValue.deletedAt === undefined) throw new TypeError("deleted successor requires deletedAt");
    body.deleted_at = contextValue.deletedAt;
  } else if (status === "suppressed") {
    if (contextValue.suppressedAt === undefined) throw new TypeError("suppressed successor requires suppressedAt");
    body.suppressed_at = contextValue.suppressedAt;
  }
  if (ref !== undefined) body.ref = toWireRef(ref);
  return body;
}

function finalizePayload(
  payload: CanonicalMemoryPayload,
  ref: CanonicalObjectVersionRef,
): { readonly payload: CanonicalMemoryPayload; readonly jcs: string; readonly hash: Sha256 } {
  const first = cloneAndFreeze(payload);
  const hash = canonicalPayloadHash(first);
  const envelope = { ...first.envelope, canonical_payload_sha256: hash.sha256 };
  const finalRecord: Record<string, unknown> = { ...first, envelope };
  if (first.ref !== undefined) finalRecord.ref = toWireRef({ ...ref, canonicalPayloadSha256: hash.sha256 });
  const finalPayload = cloneAndFreeze(finalRecord as CanonicalMemoryPayload);
  const verified = canonicalPayloadHash(finalPayload);
  if (verified.sha256 !== hash.sha256 || verified.jcs !== hash.jcs) {
    throw new TypeError("canonical payload hash did not stabilize");
  }
  return { payload: finalPayload, jcs: verified.jcs, hash: verified.sha256 };
}

function receiptFrom(input: {
  readonly operation: ProductionMemoryIssuerReceipt["operation"];
  readonly payload: CanonicalMemoryPayload;
  readonly ref: CanonicalObjectVersionRef;
  readonly candidateRef?: CanonicalObjectVersionRef;
  readonly candidateReceipt?: ProductionMemoryIssuerReceipt;
  readonly candidateBindingSha256: Sha256;
  readonly previousRef?: CanonicalObjectVersionRef;
}): ProductionMemoryIssuerReceipt {
  const canonical = finalizePayload(input.payload, input.ref);
  const candidateRef = input.candidateRef ?? (input.ref.refType === "MemoryCandidate"
    ? { ...input.ref, canonicalPayloadSha256: canonical.hash }
    : undefined);
  const memoryRef = input.ref.refType === "MemoryCandidate" ? undefined : input.ref;
  const receipt: Record<string | symbol, unknown> = {
    kind: "t05_memory_issuer_receipt",
    environment: "production",
    operation: input.operation,
    ...(candidateRef === undefined ? {} : { candidateRef: cloneRef(candidateRef) }),
    ...(memoryRef === undefined ? {} : { memoryRef: cloneRef({ ...memoryRef, canonicalPayloadSha256: canonical.hash }) }),
    ...(input.previousRef === undefined ? {} : { previousRef: cloneRef(input.previousRef) }),
    ...(input.candidateReceipt === undefined ? {} : { candidateReceipt: input.candidateReceipt }),
    candidateBindingSha256: input.candidateBindingSha256,
    canonicalPayloadSha256: canonical.hash,
    canonicalPayloadJcs: canonical.jcs,
    payload: canonical.payload,
  };
  const branded = Object.freeze(receipt) as unknown as ProductionMemoryIssuerReceipt;
  PRODUCTION_RECEIPTS.add(branded as unknown as object);
  return branded;
}

const PRODUCTION_RECEIPTS = new WeakSet<object>();

function assertReceiptShape(
  value: unknown,
  stack: WeakSet<object> = new WeakSet<object>(),
): ProductionMemoryIssuerReceipt {
  if (typeof value !== "object" || value === null || !PRODUCTION_RECEIPTS.has(value)) {
    throw new TypeError("issuer receipt is not a private production receipt");
  }
  if (stack.has(value)) throw new TypeError("issuer receipt contains a cycle");
  stack.add(value);
  try {
    return assertReceiptShapeBody(value, stack);
  } finally {
    stack.delete(value);
  }
}

function assertReceiptShapeBody(
  value: object,
  stack: WeakSet<object>,
): ProductionMemoryIssuerReceipt {
  const receipt = value as ProductionMemoryIssuerReceipt;
  if (receipt.kind !== "t05_memory_issuer_receipt" || receipt.environment !== "production" ||
      !isSha256(receipt.candidateBindingSha256) || !isSha256(receipt.canonicalPayloadSha256) ||
      typeof receipt.canonicalPayloadJcs !== "string" || !isPlainObject(receipt.payload)) {
    throw new TypeError("issuer receipt shape is invalid");
  }
  const payload = receipt.payload;
  const envelope = payload.envelope;
  if (!isPlainObject(envelope) || !isUUIDv7(envelope.object_id) ||
      !isMemoryObjectType(envelope.object_type) || !assertPositiveVersionSafe(envelope.object_version) ||
      envelope.canonical_payload_sha256 !== receipt.canonicalPayloadSha256) {
    throw new TypeError("issuer receipt payload identity is invalid");
  }
  const canonical = canonicalPayloadHash(payload);
  if (canonical.jcs !== receipt.canonicalPayloadJcs || canonical.sha256 !== receipt.canonicalPayloadSha256) {
    throw new TypeError("issuer receipt payload hash is invalid");
  }
  const expectedType = envelope.object_type as MemoryIssuerObjectType;
  const identity = expectedType === "MemoryCandidate" ? receipt.candidateRef : receipt.memoryRef;
  if (identity === undefined || identity.refType !== expectedType || identity.refId !== envelope.object_id ||
      identity.objectVersion !== envelope.object_version || identity.canonicalPayloadSha256 !== receipt.canonicalPayloadSha256) {
    throw new TypeError("issuer receipt identity does not bind envelope");
  }
  if (receipt.candidateRef !== undefined &&
      (receipt.candidateRef.refType !== "MemoryCandidate" || !isUUIDv7(receipt.candidateRef.refId) ||
       !assertPositiveVersionSafe(receipt.candidateRef.objectVersion) || !isSha256(receipt.candidateRef.canonicalPayloadSha256))) {
    throw new TypeError("issuer receipt candidate binding is invalid");
  }
  if (receipt.previousRef !== undefined && (!isMemoryObjectType(receipt.previousRef.refType) ||
      receipt.previousRef.refType !== expectedType || receipt.previousRef.refId !== identity.refId ||
      comparePositiveDecimal(receipt.previousRef.objectVersion, identity.objectVersion) >= 0 ||
      incrementPositiveDecimal(receipt.previousRef.objectVersion) !== identity.objectVersion)) {
    throw new TypeError("issuer receipt predecessor is invalid");
  }
  const hasPayloadRef = Object.prototype.hasOwnProperty.call(payload, "ref");
  if (expectedType === "MemoryCandidate") {
    if (hasPayloadRef || (receipt.operation !== "candidate_create" && receipt.operation !== "candidate_successor")) {
      throw new TypeError("candidate issuer payload/operation is invalid");
    }
    if (receipt.candidateReceipt !== undefined || payload.status !== envelope.status || payload.current !== false ||
        payload.requires_review !== (payload.status === "candidate" || payload.status === "quarantined")) {
      throw new TypeError("candidate lifecycle fields are not bound");
    }
    if (receipt.operation === "candidate_create" && (identity.objectVersion !== "1" ||
        (payload.kind !== "create" && payload.kind !== "correct"))) {
      throw new TypeError("candidate_create must start at version 1 with a valid candidate kind");
    }
  } else {
    if (!hasPayloadRef || (receipt.operation !== "memory_create" && receipt.operation !== "memory_successor")) {
      throw new TypeError("durable issuer payload/operation is invalid");
    }
    const payloadRef = fromWireRef(payload.ref);
    if (!refsEqual(payloadRef, identity)) throw new TypeError("durable payload ref is not identity-bound");
    if (receipt.candidateReceipt === undefined) {
      throw new TypeError("durable receipt must carry its candidate receipt");
    }
    const candidateReceipt = assertReceiptShape(receipt.candidateReceipt, stack);
    if ((candidateReceipt.operation !== "candidate_create" && candidateReceipt.operation !== "candidate_successor") ||
        candidateReceipt.candidateRef === undefined || receipt.candidateRef === undefined ||
        !refsEqual(candidateReceipt.candidateRef, receipt.candidateRef) ||
        candidateReceipt.candidateBindingSha256 !== receipt.candidateBindingSha256) {
      throw new TypeError("durable receipt candidate binding is not exact");
    }
    assertDurableCandidateBinding(payload, candidateReceipt.payload);
    if (payload.kind !== kindForRefType(expectedType) || payload.status !== envelope.status ||
        payload.current !== (payload.status === "current")) {
      throw new TypeError("durable kind/status/current fields are not bound");
    }
  }
  if (receipt.operation === "candidate_create" || receipt.operation === "memory_create") {
    if (receipt.previousRef !== undefined || Object.prototype.hasOwnProperty.call(payload, "supersedes") ||
        Object.prototype.hasOwnProperty.call(envelope, "supersedes_ref")) {
      throw new TypeError("initial issuer payload cannot contain a predecessor");
    }
    if (identity.objectVersion !== "1" || (receipt.operation === "memory_create" && payload.status !== "current")) {
      throw new TypeError("initial issuer receipt must start at version 1/current status");
    }
  } else {
    if (receipt.previousRef === undefined || !Object.prototype.hasOwnProperty.call(payload, "supersedes") ||
        !Object.prototype.hasOwnProperty.call(envelope, "supersedes_ref")) {
      throw new TypeError("successor issuer payload must contain exact lineage");
    }
    const bodyPrevious = fromWireRef(payload.supersedes);
    const envelopePrevious = fromWireRef(envelope.supersedes_ref);
    if (!refsEqual(bodyPrevious, receipt.previousRef) || !refsEqual(envelopePrevious, receipt.previousRef)) {
      throw new TypeError("successor lineage references disagree");
    }
  }
  return receipt;
}

function assertDurableCandidateBinding(
  durablePayload: CanonicalMemoryPayload,
  candidatePayload: CanonicalMemoryPayload,
): void {
  const mappings: readonly [string, string][] = [
    ["kind", "memory_kind"],
    ["user_id", "user_id"],
    ["slot", "slot"],
    ["value", "value"],
    ["evidence_refs", "evidence_refs"],
    ["source_class", "source_class"],
    ["confidence_ppm", "confidence_ppm"],
    ["allowed_purpose_scopes", "purpose_scopes"],
    ["sensitivity", "sensitivity"],
    ["validity", "validity"],
    ["correction_intent", "correction_intent"],
  ];
  for (const [durableKey, candidateKey] of mappings) {
    const durableHas = Object.prototype.hasOwnProperty.call(durablePayload, durableKey);
    const candidateHas = Object.prototype.hasOwnProperty.call(candidatePayload, candidateKey);
    if (durableHas !== candidateHas) throw new TypeError(`candidate binding field ${durableKey} is missing`);
    if (durableHas && jcsSerialize(durablePayload[durableKey], durableKey) !==
        jcsSerialize(candidatePayload[candidateKey], candidateKey)) {
      throw new TypeError(`candidate binding field ${durableKey} drifted`);
    }
  }
  if (durablePayload.user_id !== candidatePayload.user_id) {
    throw new TypeError("candidate and durable user_id differ");
  }
}

function assertPositiveVersionSafe(value: unknown): value is PositiveVersion {
  try {
    assertPositiveVersion(value);
    return true;
  } catch {
    return false;
  }
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isProductionMemoryIssuerReceipt(value: unknown): value is ProductionMemoryIssuerReceipt {
  try {
    assertReceiptShape(value);
    return true;
  } catch {
    return false;
  }
}

export function assertProductionMemoryIssuerReceipt(value: unknown): ProductionMemoryIssuerReceipt {
  return assertReceiptShape(value);
}

const PROJECTION_REQUIRED_KEYS = new Set([
  "kind",
  "environment",
  "operation",
  "candidateBindingSha256",
  "canonicalPayloadSha256",
  "canonicalPayloadJcs",
  "payload",
  "projectionJcs",
  "projectionSha256",
]);
const PROJECTION_OPTIONAL_KEYS = new Set(["candidateRef", "memoryRef", "previousRef", "candidateReceipt"]);

function projectionKeysValid(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  const allowed = new Set([...PROJECTION_REQUIRED_KEYS, ...PROJECTION_OPTIONAL_KEYS]);
  return [...PROJECTION_REQUIRED_KEYS].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function exactInternalRef(value: unknown): value is CanonicalObjectVersionRef {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value).sort().join("|");
  if (keys !== "canonicalPayloadSha256|objectVersion|refId|refType") return false;
  try {
    assertCanonicalObjectVersionRef(value);
    return true;
  } catch {
    return false;
  }
}

function projectionPreimage(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy.projectionJcs;
  delete copy.projectionSha256;
  return copy;
}

function projectionHash(value: Record<string, unknown>): { readonly jcs: string; readonly sha256: Sha256 } {
  const jcs = jcsSerialize(projectionPreimage(value), "issuer receipt projection");
  return { jcs, sha256: assertSha256(createHash("sha256").update(jcs, "utf8").digest("hex")) };
}

function projectReceiptInternal(
  receipt: ProductionMemoryIssuerReceipt,
  stack: WeakSet<object>,
): ProductionMemoryIssuerReceiptProjection {
  if (stack.has(receipt as unknown as object)) throw new TypeError("issuer receipt projection contains a cycle");
  stack.add(receipt as unknown as object);
  try {
    const base: Record<string, unknown> = {
      kind: "t05_memory_issuer_receipt_projection",
      environment: "production",
      operation: receipt.operation,
      ...(receipt.candidateRef === undefined ? {} : { candidateRef: cloneRef(receipt.candidateRef) }),
      ...(receipt.memoryRef === undefined ? {} : { memoryRef: cloneRef(receipt.memoryRef) }),
      ...(receipt.previousRef === undefined ? {} : { previousRef: cloneRef(receipt.previousRef) }),
      ...(receipt.candidateReceipt === undefined ? {} : {
        candidateReceipt: projectReceiptInternal(receipt.candidateReceipt, stack),
      }),
      candidateBindingSha256: receipt.candidateBindingSha256,
      canonicalPayloadSha256: receipt.canonicalPayloadSha256,
      canonicalPayloadJcs: receipt.canonicalPayloadJcs,
      payload: receipt.payload,
    };
    const digest = projectionHash(base);
    return cloneAndFreeze({
      ...base,
      projectionJcs: digest.jcs,
      projectionSha256: digest.sha256,
    } as ProductionMemoryIssuerReceiptProjection);
  } finally {
    stack.delete(receipt as unknown as object);
  }
}

export function projectProductionMemoryIssuerReceipt(
  value: unknown,
): ProductionMemoryIssuerReceiptProjection {
  const receipt = assertReceiptShape(value);
  return projectReceiptInternal(receipt, new WeakSet<object>());
}

function validateProjectionInternal(
  value: unknown,
  stack: WeakSet<object>,
): ProductionMemoryIssuerReceiptProjection {
  if (!projectionKeysValid(value)) throw new TypeError("issuer receipt projection keys are not closed");
  if (stack.has(value as object)) throw new TypeError("issuer receipt projection contains a cycle");
  stack.add(value as object);
  try {
    const projection = value as unknown as ProductionMemoryIssuerReceiptProjection;
    if (projection.kind !== "t05_memory_issuer_receipt_projection" || projection.environment !== "production" ||
        !isSha256(projection.candidateBindingSha256) || !isSha256(projection.canonicalPayloadSha256) ||
        typeof projection.canonicalPayloadJcs !== "string" || !isPlainObject(projection.payload) ||
        typeof projection.projectionJcs !== "string" || !isSha256(projection.projectionSha256)) {
      throw new TypeError("issuer receipt projection header is invalid");
    }
    const operationSet = new Set(["candidate_create", "candidate_successor", "memory_create", "memory_successor"]);
    if (!operationSet.has(projection.operation)) throw new TypeError("issuer receipt projection operation is invalid");
    for (const key of ["candidateRef", "memoryRef", "previousRef"] as const) {
      if (Object.prototype.hasOwnProperty.call(projection, key) && !exactInternalRef(projection[key])) {
        throw new TypeError(`issuer receipt projection ${key} is invalid`);
      }
    }
    const payloadHash = canonicalPayloadHash(projection.payload);
    if (payloadHash.sha256 !== projection.canonicalPayloadSha256 ||
        payloadHash.jcs !== projection.canonicalPayloadJcs) {
      throw new TypeError("issuer receipt projection payload hash drifted");
    }
    const digest = projectionHash(projection as unknown as Record<string, unknown>);
    if (digest.sha256 !== projection.projectionSha256 || digest.jcs !== projection.projectionJcs) {
      throw new TypeError("issuer receipt projection JCS/hash drifted");
    }
    if (projection.candidateReceipt !== undefined) {
      validateProjectionInternal(projection.candidateReceipt, stack);
    }
    return projection;
  } finally {
    stack.delete(value as object);
  }
}

function rehydrateProjectionInternal(
  projection: ProductionMemoryIssuerReceiptProjection,
): ProductionMemoryIssuerReceipt {
  const candidateReceipt = projection.candidateReceipt === undefined
    ? undefined
    : rehydrateProjectionInternal(projection.candidateReceipt);
  const raw: Record<string, unknown> = {
    kind: "t05_memory_issuer_receipt",
    environment: "production",
    operation: projection.operation,
    ...(projection.candidateRef === undefined ? {} : { candidateRef: cloneRef(projection.candidateRef) }),
    ...(projection.memoryRef === undefined ? {} : { memoryRef: cloneRef(projection.memoryRef) }),
    ...(projection.previousRef === undefined ? {} : { previousRef: cloneRef(projection.previousRef) }),
    ...(candidateReceipt === undefined ? {} : { candidateReceipt }),
    candidateBindingSha256: projection.candidateBindingSha256,
    canonicalPayloadSha256: projection.canonicalPayloadSha256,
    canonicalPayloadJcs: projection.canonicalPayloadJcs,
    payload: cloneAndFreeze(projection.payload),
  };
  const receipt = Object.freeze(raw) as unknown as ProductionMemoryIssuerReceipt;
  PRODUCTION_RECEIPTS.add(receipt as unknown as object);
  try {
    return assertReceiptShape(receipt);
  } catch (error) {
    PRODUCTION_RECEIPTS.delete(receipt as unknown as object);
    throw error;
  }
}

export function rehydrateProductionMemoryIssuerReceipt(
  value: unknown,
): ProductionMemoryIssuerReceipt {
  const projection = validateProjectionInternal(value, new WeakSet<object>());
  return rehydrateProjectionInternal(projection);
}

export function issuerReceiptMatchesCandidate(
  receipt: unknown,
  candidate: AdmittedMemoryCandidateIntent,
): receipt is ProductionMemoryIssuerReceipt {
  try {
    const value = assertReceiptShape(receipt);
    return (value.operation === "candidate_create" || value.operation === "memory_create" || value.operation === "memory_successor") &&
      value.candidateBindingSha256 === candidateBindingSha256(candidate);
  } catch {
    return false;
  }
}

function asTimestamp(value: number | bigint): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("UUIDv7 clock must be a non-negative safe integer");
  }
  const timestamp = typeof value === "bigint" ? value : BigInt(value);
  if (timestamp < 0n || timestamp > MAX_TIMESTAMP) throw new TypeError("UUIDv7 timestamp is outside 48-bit range");
  return timestamp;
}

function bytesToTail(bytes: Uint8Array): bigint {
  if (bytes.length < 10) throw new TypeError("UUIDv7 entropy must provide at least 10 bytes");
  let value = 0n;
  for (let index = 0; index < 10; index += 1) value = (value << 8n) | BigInt(bytes[index]!);
  return value & MAX_TAIL;
}

function uuidFromParts(timestamp: bigint, tail: bigint): UUIDv7 {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 6; index += 1) {
    bytes[5 - index] = Number((timestamp >> BigInt(index * 8)) & 0xffn);
  }
  const randA = Number((tail >> 62n) & 0xfffn);
  const randB = tail & VARIANT_MASK;
  bytes[6] = 0x70 | (randA >> 8);
  bytes[7] = randA & 0xff;
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  for (let index = 0; index < 7; index += 1) {
    bytes[9 + index] = Number((randB >> BigInt((6 - index) * 8)) & 0xffn);
  }
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return assertUUIDv7(`${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`);
}

function timestampFromUuid(value: UUIDv7): bigint {
  const hex = value.replaceAll("-", "").slice(0, 12);
  return BigInt(`0x${hex}`);
}

interface InternalUuidV7Generator {
  readonly environment: "production" | "non-production";
  readonly issueInternal: () => UUIDv7;
  readonly issue: () => UUIDv7;
  readonly timestampMs: (value: UUIDv7) => bigint;
}

function createUuidGenerator(input: {
  readonly environment: "production" | "non-production";
  readonly nowMs: () => number | bigint;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly maxCollisionAttempts: number;
  readonly issuedIds: Set<string>;
}): InternalUuidV7Generator {
  let lastTimestamp: bigint | undefined;
  let lastTail: bigint | undefined;
  return {
    environment: input.environment,
    issue: () => issueUuid(),
    timestampMs: timestampFromUuid,
    issueInternal: issueUuid,
  };

  function issueUuid(): UUIDv7 {
    const timestamp = asTimestamp(input.nowMs());
    if (lastTimestamp !== undefined && timestamp < lastTimestamp) {
      throw new TypeError("UUIDv7 clock moved backwards");
    }
    let tail: bigint | undefined;
    for (let attempt = 0; attempt < input.maxCollisionAttempts; attempt += 1) {
      if (lastTimestamp !== undefined && timestamp === lastTimestamp && lastTail !== undefined && lastTail < MAX_TAIL) {
        tail = lastTail + 1n;
      } else {
        tail = bytesToTail(input.randomBytes(10));
        if (lastTimestamp !== undefined && timestamp === lastTimestamp && lastTail !== undefined && tail <= lastTail) {
          continue;
        }
      }
      const uuid = uuidFromParts(timestamp, tail);
      if (input.issuedIds.has(uuid)) {
        tail = undefined;
        continue;
      }
      input.issuedIds.add(uuid);
      lastTimestamp = timestamp;
      lastTail = tail;
      return uuid;
    }
    throw new Error("UUIDv7 entropy collision or monotonic exhaustion");
  }
}

function assertMaxAttempts(value: number | undefined): number {
  const attempts = value ?? 8;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 128) {
    throw new TypeError("maxCollisionAttempts must be an integer in [1,128]");
  }
  return attempts;
}

export function createNonProductionUuidV7Generator(
  options: NonProductionUuidV7Options,
): NonProductionUuidV7Generator {
  const generator = createUuidGenerator({
    environment: "non-production",
    nowMs: options.nowMs,
    randomBytes: options.randomBytes,
    maxCollisionAttempts: assertMaxAttempts(options.maxCollisionAttempts),
    issuedIds: options.issuedIds ?? new Set<string>(),
  });
  return {
    environment: "non-production",
    issue: generator.issue,
    timestampMs: generator.timestampMs,
  };
}

function fakeUuid(index: number): UUIDv7 {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("fixture index must be a non-negative integer");
  const suffix = index.toString(16).padStart(12, "0").slice(-12);
  return assertUUIDv7(`01900000-0000-7000-8000-${suffix}`);
}

function fixtureRef(refType: MemoryIssuerObjectType, index: number, version = "1"): CanonicalObjectVersionRef {
  const refId = fakeUuid(index);
  const digest = assertSha256(createHash("sha256").update(`non-production:${refType}:${index}:${version}`, "utf8").digest("hex"));
  return Object.freeze({
    refType,
    refId,
    objectVersion: assertPositiveVersion(version),
    canonicalPayloadSha256: digest,
  });
}

export function createNonProductionMemoryIdentityFixture(): NonProductionMemoryIdentityFixtureAdapter {
  return Object.freeze({
    environment: "non-production" as const,
    candidateRefFor: (index: number) => fixtureRef("MemoryCandidate", index),
    memoryRefFor: (kind: MemoryKind, index: number) => fixtureRef(refTypeForKind(kind), index),
  });
}

function issueCandidatePayload(
  generator: { readonly issueInternal: () => UUIDv7 },
  input: CandidateIssueInput,
): ProductionMemoryIssuerReceipt {
  const candidate = input.candidate;
  const id = generator.issueInternal();
  const version = assertPositiveVersion("1");
  const payload = buildCandidatePayload(candidate, id, version, input.context);
  const ref = Object.freeze({
    refType: "MemoryCandidate" as const,
    refId: id,
    objectVersion: version,
    canonicalPayloadSha256: "0".repeat(64) as Sha256,
  });
  const binding = candidateBindingSha256(candidate);
  return receiptFrom({ operation: "candidate_create", payload, ref, candidateBindingSha256: binding });
}

function issueCandidateSuccessorPayload(
  generator: { readonly issueInternal: () => UUIDv7 },
  input: CandidateSuccessorIssueInput,
): ProductionMemoryIssuerReceipt {
  const previous = assertReceiptShape(input.previous);
  if (previous.operation !== "candidate_create" && previous.operation !== "candidate_successor" || previous.candidateRef === undefined) {
    throw new TypeError("candidate successor requires a candidate receipt");
  }
  const previousRef = previous.candidateRef;
  const nextVersion = incrementPositiveDecimal(previousRef.objectVersion);
  const payload = buildCandidatePayload(
    toAdmittedCandidate(previous.payload),
    previousRef.refId,
    nextVersion,
    input.context,
    previousRef,
    input.status,
  );
  return receiptFrom({
    operation: "candidate_successor",
    payload,
    ref: { ...previousRef, objectVersion: nextVersion },
    previousRef,
    candidateBindingSha256: previous.candidateBindingSha256,
  });
}

function issueMemoryPayload(
  generator: { readonly issueInternal: () => UUIDv7 },
  input: MemoryIssueInput,
): ProductionMemoryIssuerReceipt {
  const candidate = input.candidate;
  const candidateReceipt = assertReceiptShape(input.candidateReceipt);
  if ((candidateReceipt.operation !== "candidate_create" && candidateReceipt.operation !== "candidate_successor") ||
      candidateReceipt.candidateRef === undefined ||
      candidateReceipt.candidateBindingSha256 !== candidateBindingSha256(candidate)) {
    throw new TypeError("memory creation requires the matching candidate issuer receipt");
  }
  const objectType = refTypeForKind(candidate.memoryKind);
  const id = generator.issueInternal();
  const version = assertPositiveVersion("1");
  const temporaryRef: CanonicalObjectVersionRef = {
    refType: objectType,
    refId: id,
    objectVersion: version,
    canonicalPayloadSha256: "0".repeat(64) as Sha256,
  };
  const envelope = commonEnvelope({
    objectId: id,
    objectType,
    objectVersion: version,
    status: "current",
    context: input.context,
    sensitivity: candidate.sensitivity.classification,
  });
  const payload: CanonicalMemoryPayload = {
    envelope,
    ...durableBody(candidate, "current", input.resolvedContent, input.context, undefined, temporaryRef),
  };
  return receiptFrom({
    operation: "memory_create",
    payload,
    ref: temporaryRef,
    candidateRef: candidateReceipt.candidateRef,
    candidateReceipt,
    candidateBindingSha256: candidateBindingSha256(candidate),
  });
}

function issueMemorySuccessorPayload(input: MemorySuccessorIssueInput): ProductionMemoryIssuerReceipt {
  const previous = assertReceiptShape(input.previous);
  if (previous.operation !== "memory_create" && previous.operation !== "memory_successor" || previous.memoryRef === undefined) {
    throw new TypeError("memory successor requires a durable memory receipt");
  }
  const candidate = input.candidate;
  const candidateReceipt = assertReceiptShape(input.candidateReceipt);
  if ((candidateReceipt.operation !== "candidate_create" && candidateReceipt.operation !== "candidate_successor") ||
      candidateReceipt.candidateRef === undefined ||
      candidateReceipt.candidateBindingSha256 !== candidateBindingSha256(candidate)) {
    throw new TypeError("memory successor requires the matching candidate issuer receipt");
  }
  const previousRef = previous.memoryRef;
  if (!isDurableMemoryRefType(previousRef.refType) ||
      candidate.memoryKind !== kindForRefType(previousRef.refType) || candidate.userId !== previous.payload.user_id) {
    throw new TypeError("memory successor cannot change durable kind or user");
  }
  const nextVersion = incrementPositiveDecimal(previousRef.objectVersion);
  const nextStatus = input.status ?? "current";
  const temporaryRef: CanonicalObjectVersionRef = {
    refType: previousRef.refType,
    refId: previousRef.refId,
    objectVersion: nextVersion,
    canonicalPayloadSha256: "0".repeat(64) as Sha256,
  };
  const context = contextValues(input.context);
  if (context.createdAt !== undefined && previous.payload.created_at !== context.createdAt) {
    throw new TypeError("successor createdAt must preserve predecessor bytes");
  }
  if (previous.payload.created_at !== undefined && context.createdAt === undefined) {
    throw new TypeError("successor must carry predecessor createdAt");
  }
  const envelope = commonEnvelope({
    objectId: previousRef.refId,
    objectType: previousRef.refType,
    objectVersion: nextVersion,
    status: nextStatus,
    context: input.context,
    sensitivity: candidate.sensitivity.classification,
  });
  envelope.supersedes_ref = toWireRef(previousRef);
  const payload: CanonicalMemoryPayload = {
    envelope,
    ...durableBody(candidate, nextStatus, input.resolvedContent, input.context, previousRef, temporaryRef),
  };
  return receiptFrom({
    operation: "memory_successor",
    payload,
    ref: temporaryRef,
    candidateRef: candidateReceipt.candidateRef,
    candidateReceipt,
    previousRef,
    candidateBindingSha256: candidateBindingSha256(candidate),
  });
}

function kindForRefType(refType: MemoryIssuerObjectType): MemoryKind {
  for (const [kind, type] of Object.entries(MEMORY_REF_TYPE_BY_KIND) as [MemoryKind, MemoryIssuerObjectType][]) {
    if (type === refType) return kind;
  }
  throw new TypeError("not a durable memory ref type");
}

function isDurableMemoryRefType(value: unknown): value is Exclude<MemoryIssuerObjectType, "MemoryCandidate"> {
  return value === "SemanticFact" || value === "EpisodicMemory" ||
    value === "PreferenceMemory" || value === "OpenLoop";
}

function toAdmittedCandidate(payload: CanonicalMemoryPayload): AdmittedMemoryCandidateIntent {
  const body = payload;
  const evidenceRefs = Array.isArray(body.evidence_refs) ? body.evidence_refs.map(fromWireRef) : [];
  const sensitivity = isPlainObject(body.sensitivity) ? body.sensitivity : {};
  const validity = isPlainObject(body.validity) ? body.validity : {};
  const correction = isPlainObject(body.correction_intent) ? body.correction_intent : undefined;
  const candidate = {
    kind: body.kind,
    status: "candidate" as const,
    proposalId: body.proposal_id,
    slot: body.slot,
    value: body.value,
    evidenceRefs,
    sourceClass: body.source_class,
    confidencePpm: body.confidence_ppm,
    idempotencyKey: body.idempotency_key,
    current: false as const,
    memoryKind: body.memory_kind,
    userId: body.user_id,
    purposeScopes: body.purpose_scopes,
    sensitivity: {
      classification: sensitivity.classification,
      userConfirmed: sensitivity.user_confirmed,
    },
    validity: {
      ...(validity.valid_from === undefined ? {} : { validFrom: validity.valid_from }),
      ...(validity.valid_to === undefined ? {} : { validTo: validity.valid_to }),
      ...(validity.observed_at === undefined ? {} : { observedAt: validity.observed_at }),
    },
    ...(body.target === undefined ? {} : { target: fromWireRef(body.target) }),
    ...(correction === undefined ? {} : {
      correctionIntent: {
        kind: "correct" as const,
        target: fromWireRef(correction.target),
        ...(correction.reason === undefined ? {} : { reason: correction.reason }),
        ...(!Array.isArray(correction.evidence_refs) ? {} : {
          evidenceRefs: correction.evidence_refs.map(fromWireRef),
        }),
      },
    }),
    ...(body.reason === undefined ? {} : { reason: body.reason }),
    ...(body.conflict === undefined ? {} : { conflict: body.conflict }),
  } as unknown as AdmittedMemoryCandidateIntent;
  return candidate;
}

export function createProductionMemoryCanonicalIssuer(
  options: ProductionMemoryCanonicalIssuerOptions = {},
): ProductionMemoryCanonicalIssuer {
  const generator = createUuidGenerator({
    environment: "production",
    nowMs: options.nowMs ?? (() => Date.now()),
    randomBytes: (size) => nodeRandomBytes(size),
    maxCollisionAttempts: assertMaxAttempts(options.maxCollisionAttempts),
    issuedIds: new Set<string>(),
  });
  return Object.freeze({
    environment: "production" as const,
    issueCandidate: (input: CandidateIssueInput) => issueCandidatePayload(generator, input),
    issueCandidateSuccessor: (input: CandidateSuccessorIssueInput) => issueCandidateSuccessorPayload(generator, input),
    issueMemory: (input: MemoryIssueInput) => issueMemoryPayload(generator, input),
    issueMemorySuccessor: (input: MemorySuccessorIssueInput) => issueMemorySuccessorPayload(input),
  });
}
