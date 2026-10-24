/**
 * T05's internal object-version reference seam.
 *
 * This module deliberately does not mirror or publish a T01 wire schema.  The
 * wire contract uses snake_case strings for these fields; the memory domain
 * keeps the small, typed, camelCase representation below and validates it at
 * the boundary where a reference enters T05.
 */

declare const sha256Brand: unique symbol;
declare const uuidV7Brand: unique symbol;
declare const positiveVersionBrand: unique symbol;

/** A lowercase hexadecimal SHA-256 digest. */
export type Sha256 = string & { readonly [sha256Brand]: true };

/** A lowercase UUID version 7. */
export type UUIDv7 = string & { readonly [uuidV7Brand]: true };

/** A positive decimal object version, matching the canonical version language. */
export type PositiveVersion = string & { readonly [positiveVersionBrand]: true };

/**
 * Canonical object names that can cross the T05 internal seam in this grant.
 * This list is deliberately limited to memory, source/evidence, governance,
 * T13 lineage, and T11B realtime objects; it is not a T01 wire registry.
 */
export const CANONICAL_OBJECT_NAMES = [
  // Source/context evidence consumed by memory admission.
  "ContextAssertion",
  "Observation",
  "TextEvidence",
  // T05/memory objects.
  "EpisodicMemory",
  "MemoryCandidate",
  "OpenLoop",
  "PreferenceMemory",
  "SemanticFact",
  // T03/governance objects referenced by admission/deletion boundaries.
  "PolicyDecision",
  "CapabilityGrant",
  "PurposeToken",
  "SoftwareKillSwitch",
  "ConsentRecord",
  "DeletionJob",
  "DomainDeletionAttestation",
  "DeletionProof",
  "AuditExport",
  "EmergencyDeliveryObligation",
  "DeviceCredential",
  "AuditRecord",
  // Evidence-bearing objects that may support a memory version.
  "ActionAudit",
  "ToolResultArtifact",
  "RiskEvidencePackage",
  "ReplayRun",
  "Regression",
  "ReleaseGate",
  // T11B/realtime evidence and session objects.
  "DeviceLease",
  "FinalTranscriptEvidence",
  "RealtimeSession",
  "SurfaceAvailability",
  "TranscriptSegment",
  // T13/source lineage objects.
  "ArtifactVersion",
  "EvidenceSpan",
  "ExtractionCandidate",
  "IngestionAudit",
  "SourceArtifact",
] as const;

export type CanonicalObjectName = (typeof CANONICAL_OBJECT_NAMES)[number];

const CANONICAL_OBJECT_NAME_SET: ReadonlySet<string> = new Set(CANONICAL_OBJECT_NAMES);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T01_WIRE_REF_PROPERTIES = [
  "ref_type",
  "ref_id",
  "object_version",
  "canonical_payload_sha256",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a value is a lowercase SHA-256 digest. */
export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/** Validates and brands a lowercase SHA-256 digest. */
export function assertSha256(value: unknown): Sha256 {
  if (!isSha256(value)) {
    throw new TypeError("Expected a lowercase 64-character SHA-256 digest");
  }
  return value;
}

/** Returns true when a value is a lowercase UUID version 7. */
export function isUUIDv7(value: unknown): value is UUIDv7 {
  return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

/** Validates and brands a lowercase UUID version 7. */
export function assertUUIDv7(value: unknown): UUIDv7 {
  if (!isUUIDv7(value)) {
    throw new TypeError("Expected a lowercase UUIDv7");
  }
  return value;
}

const POSITIVE_VERSION_PATTERN = /^[1-9][0-9]*$/;

/** Returns true for a positive decimal object version. */
export function isPositiveVersion(value: unknown): value is PositiveVersion {
  return typeof value === "string" && POSITIVE_VERSION_PATTERN.test(value);
}

/** Validates and brands a positive decimal object version. */
export function assertPositiveVersion(value: unknown): PositiveVersion {
  if (!isPositiveVersion(value)) {
    throw new TypeError("Expected a positive decimal object version");
  }
  return value;
}

/** Returns true for a registered canonical object name. */
export function isCanonicalObjectName(value: unknown): value is CanonicalObjectName {
  return typeof value === "string" && CANONICAL_OBJECT_NAME_SET.has(value);
}

/** The internal, camelCase representation used by T05. */
export interface CanonicalObjectVersionRef {
  readonly refType: CanonicalObjectName;
  readonly refId: UUIDv7;
  readonly objectVersion: PositiveVersion;
  readonly canonicalPayloadSha256: Sha256;
}

/**
 * Validate an unknown value at the T05 boundary and return it as the typed
 * internal reference. Extra internal metadata is intentionally not inspected;
 * closed-property enforcement belongs to the T01 wire contract.
 */
export function assertCanonicalObjectVersionRef(
  value: unknown,
): CanonicalObjectVersionRef {
  if (!isObject(value)) {
    throw new TypeError("Expected a canonical object-version reference object");
  }
  if (T01_WIRE_REF_PROPERTIES.some((property) => property in value)) {
    throw new TypeError("T01 snake_case wire references are not accepted at the T05 seam");
  }
  if (!isCanonicalObjectName(value.refType)) {
    throw new TypeError("Expected a registered canonical object name in refType");
  }
  assertUUIDv7(value.refId);
  assertPositiveVersion(value.objectVersion);
  assertSha256(value.canonicalPayloadSha256);
  return value as unknown as CanonicalObjectVersionRef;
}

/** Non-throwing counterpart to assertCanonicalObjectVersionRef. */
export function isCanonicalObjectVersionRef(
  value: unknown,
): value is CanonicalObjectVersionRef {
  try {
    assertCanonicalObjectVersionRef(value);
    return true;
  } catch {
    return false;
  }
}

/** Construct and validate an internal reference from untrusted field values. */
export function createCanonicalObjectVersionRef(input: {
  readonly refType: unknown;
  readonly refId: unknown;
  readonly objectVersion: unknown;
  readonly canonicalPayloadSha256: unknown;
}): CanonicalObjectVersionRef {
  const ref = assertCanonicalObjectVersionRef(input);
  return Object.freeze({
    refType: ref.refType,
    refId: ref.refId,
    objectVersion: ref.objectVersion,
    canonicalPayloadSha256: ref.canonicalPayloadSha256,
  });
}

/**
 * Stable human-readable key for equality, maps, and deterministic snapshots.
 * The components are all constrained tokens, so the delimiter is unambiguous.
 */
export function canonicalRefKey(
  value: CanonicalObjectVersionRef | unknown,
): string {
  const ref = assertCanonicalObjectVersionRef(value);
  return `${ref.refType}:${ref.refId}:${ref.objectVersion}:${ref.canonicalPayloadSha256}`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Compare canonical refs by object name, UUID, numeric version, then hash. */
export function compareCanonicalObjectVersionRefs(
  left: CanonicalObjectVersionRef | unknown,
  right: CanonicalObjectVersionRef | unknown,
): number {
  const a = assertCanonicalObjectVersionRef(left);
  const b = assertCanonicalObjectVersionRef(right);
  return (
    compareStrings(a.refType, b.refType) ||
    compareStrings(a.refId, b.refId) ||
    comparePositiveDecimalStrings(a.objectVersion, b.objectVersion) ||
    compareStrings(a.canonicalPayloadSha256, b.canonicalPayloadSha256)
  );
}

function comparePositiveDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareStrings(left, right);
}

/** Equality helper based on the complete object-version/hash identity. */
export function canonicalRefEquals(
  left: CanonicalObjectVersionRef | unknown,
  right: CanonicalObjectVersionRef | unknown,
): boolean {
  return compareCanonicalObjectVersionRefs(left, right) === 0;
}
