import { createHash } from "node:crypto";

import {
  admitMemoryProposal,
  type AdmittedMemoryCandidateIntent,
} from "./admission.ts";
import {
  assertCanonicalObjectVersionRef,
  assertSha256,
  canonicalRefEquals,
  createCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "./canonical-ref.ts";
import {
  createProductionMemoryCanonicalIssuer,
  jcsSerialize,
  type ProductionMemoryIssuerReceipt,
} from "./canonical-issuer.ts";
import {
  assertCanonicalUtcInstant,
  MEMORY_KINDS,
  type MemoryKind,
  type MemorySensitivity,
  type MemoryValidity,
  type ReadonlyJsonValue,
} from "./domain.ts";

export const MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES = 16_384;

const COMMAND_KEYS = Object.freeze([
  "action",
  "userConfirmed",
  "userId",
  "purposeScopes",
  "memoryKind",
  "slot",
  "value",
  "boundedContent",
  "evidenceRef",
  "evidenceObservedAt",
  "sensitivity",
  "validity",
  "idempotencyKey",
] as const);
const REF_KEYS = Object.freeze([
  "refType",
  "refId",
  "objectVersion",
  "canonicalPayloadSha256",
] as const);
const SENSITIVITY_KEYS = Object.freeze(["classification", "userConfirmed"] as const);
const VALIDITY_KEYS = Object.freeze(["validFrom", "validTo", "observedAt"] as const);
const ALLOWED_EVIDENCE_TYPES = new Set(["TextEvidence", "FinalTranscriptEvidence"]);

type PlainRecord = Record<string, unknown>;

export class ExplicitUserRememberError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "ExplicitUserRememberError";
    this.code = code;
  }
}

export interface ExplicitUserRememberCommand {
  readonly action: "remember";
  readonly userConfirmed: true;
  readonly userId: string;
  readonly purposeScopes: readonly string[];
  readonly memoryKind: MemoryKind;
  readonly slot: string;
  readonly value: ReadonlyJsonValue;
  readonly boundedContent: string;
  readonly evidenceRef: CanonicalObjectVersionRef;
  readonly evidenceObservedAt: string;
  readonly sensitivity: MemorySensitivity;
  readonly validity: MemoryValidity;
  readonly idempotencyKey: string;
}

export interface ExplicitUserRememberPersistenceInput {
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly candidateReceipt: ProductionMemoryIssuerReceipt;
  readonly memoryReceipt: ProductionMemoryIssuerReceipt;
  readonly candidateAppendIdempotencyKey: string;
  readonly candidateAppendFingerprint: Sha256;
  readonly memoryAppendIdempotencyKey: string;
  readonly memoryAppendFingerprint: Sha256;
}

export interface ExplicitUserRememberPersistenceResult {
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly memoryRef: CanonicalObjectVersionRef;
  readonly authorityWatermark: unknown;
}

export interface ExplicitUserRememberPersistencePort {
  remember(input: ExplicitUserRememberPersistenceInput): Promise<ExplicitUserRememberPersistenceResult>;
}

export interface ExplicitUserRememberResult {
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly memoryRef: CanonicalObjectVersionRef;
  readonly authorityWatermark: unknown;
}

export interface ExplicitUserRememberService {
  remember(input: ExplicitUserRememberCommand): Promise<ExplicitUserRememberResult>;
}

export interface ProductionExplicitUserRememberServiceOptions {
  readonly persistence: ExplicitUserRememberPersistencePort;
  /** Six-fraction transaction clock. T02 may replace this seam at composition. */
  readonly now?: () => string;
}

interface NormalizedCommand extends ExplicitUserRememberCommand {
  readonly value: ReadonlyJsonValue;
  readonly evidenceRef: CanonicalObjectVersionRef;
  readonly purposeScopes: readonly string[];
  readonly sensitivity: MemorySensitivity;
  readonly validity: MemoryValidity;
}

interface ReplayEntry {
  readonly fingerprint: Sha256;
  readonly result: Promise<ExplicitUserRememberResult>;
}

function fail(code: string, cause?: unknown): never {
  throw new ExplicitUserRememberError(code, cause === undefined ? {} : { cause });
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    fail("EXPLICIT_REMEMBER_INPUT_INVALID");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      keys.some((key) => !allowed.has(key)) || keys.length < required.length) {
    fail("EXPLICIT_REMEMBER_INPUT_INVALID");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail("EXPLICIT_REMEMBER_INPUT_INVALID");
    }
  }
}

function nonEmptyExactString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    !value.includes("\u0000");
}

function sha256(value: string): Sha256 {
  return assertSha256(createHash("sha256").update(value, "utf8").digest("hex"));
}

function cloneJson<T>(value: T): T {
  const clone = JSON.parse(jcsSerialize(value, "explicit remember data")) as T;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as PlainRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizePurposeScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((scope) => !nonEmptyExactString(scope)) ||
      new Set(value as readonly string[]).size !== value.length) {
    fail("EXPLICIT_REMEMBER_PURPOSE_INVALID");
  }
  return Object.freeze([...(value as readonly string[])]);
}

function normalizeEvidenceRef(value: unknown): CanonicalObjectVersionRef {
  assertClosedDataRecord(value, REF_KEYS);
  let ref: CanonicalObjectVersionRef;
  try {
    ref = assertCanonicalObjectVersionRef(value);
  } catch (error) {
    fail("EXPLICIT_REMEMBER_EVIDENCE_INVALID", error);
  }
  if (!ALLOWED_EVIDENCE_TYPES.has(ref.refType)) {
    fail("EXPLICIT_REMEMBER_EVIDENCE_TYPE_INVALID");
  }
  return createCanonicalObjectVersionRef(ref);
}

function normalizeSensitivity(value: unknown): MemorySensitivity {
  assertClosedDataRecord(value, SENSITIVITY_KEYS);
  if ((value.classification !== "normal" && value.classification !== "sensitive") ||
      value.userConfirmed !== true) {
    fail("EXPLICIT_REMEMBER_CONFIRMATION_REQUIRED");
  }
  return Object.freeze({
    classification: value.classification,
    userConfirmed: true,
  });
}

function normalizeValidity(value: unknown, evidenceObservedAt: string): MemoryValidity {
  assertClosedDataRecord(value, ["observedAt"], ["validFrom", "validTo"]);
  const normalized: { validFrom?: string; validTo?: string; observedAt: string } = {
    observedAt: assertCanonicalUtcInstant(value.observedAt, "validity.observedAt"),
  };
  if (value.validFrom !== undefined) {
    normalized.validFrom = assertCanonicalUtcInstant(value.validFrom, "validity.validFrom");
  }
  if (value.validTo !== undefined) {
    normalized.validTo = assertCanonicalUtcInstant(value.validTo, "validity.validTo");
  }
  if (normalized.observedAt !== evidenceObservedAt) {
    fail("EXPLICIT_REMEMBER_EVIDENCE_TIME_MISMATCH");
  }
  return Object.freeze(normalized);
}

function normalizeCommand(value: ExplicitUserRememberCommand | unknown): NormalizedCommand {
  assertClosedDataRecord(value, COMMAND_KEYS);
  if (value.action !== "remember" || value.userConfirmed !== true) {
    fail("EXPLICIT_REMEMBER_CONFIRMATION_REQUIRED");
  }
  if (!nonEmptyExactString(value.userId) || !nonEmptyExactString(value.slot) ||
      !nonEmptyExactString(value.idempotencyKey)) {
    fail("EXPLICIT_REMEMBER_INPUT_INVALID");
  }
  if (!(MEMORY_KINDS as readonly unknown[]).includes(value.memoryKind)) {
    fail("EXPLICIT_REMEMBER_KIND_INVALID");
  }
  if (!nonEmptyExactString(value.boundedContent) ||
      Buffer.byteLength(value.boundedContent, "utf8") > MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES) {
    fail("EXPLICIT_REMEMBER_CONTENT_INVALID");
  }
  try {
    jcsSerialize(value.boundedContent, "boundedContent");
  } catch (error) {
    fail("EXPLICIT_REMEMBER_CONTENT_INVALID", error);
  }
  const evidenceObservedAt = assertCanonicalUtcInstant(
    value.evidenceObservedAt,
    "evidenceObservedAt",
  );
  let normalizedValue: ReadonlyJsonValue;
  try {
    normalizedValue = cloneJson(value.value as ReadonlyJsonValue);
  } catch (error) {
    fail("EXPLICIT_REMEMBER_VALUE_INVALID", error);
  }
  return Object.freeze({
    action: "remember",
    userConfirmed: true,
    userId: value.userId,
    purposeScopes: normalizePurposeScopes(value.purposeScopes),
    memoryKind: value.memoryKind as MemoryKind,
    slot: value.slot,
    value: normalizedValue,
    boundedContent: value.boundedContent,
    evidenceRef: normalizeEvidenceRef(value.evidenceRef),
    evidenceObservedAt,
    sensitivity: normalizeSensitivity(value.sensitivity),
    validity: normalizeValidity(value.validity, evidenceObservedAt),
    idempotencyKey: value.idempotencyKey,
  });
}

function canonicalSystemTime(now: () => string): string {
  const value = now();
  if (typeof value !== "string" ||
      !/^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$/u.test(value)) {
    fail("EXPLICIT_REMEMBER_CLOCK_INVALID");
  }
  return value;
}

function defaultSystemTime(): string {
  return new Date().toISOString().replace(/\.([0-9]{3})Z$/u, ".$1000Z");
}

function commandPreimage(command: NormalizedCommand): Readonly<Record<string, unknown>> {
  return Object.freeze({
    domain: "paios.memory.explicit-user-remember.command.v1",
    action: command.action,
    userConfirmed: command.userConfirmed,
    userId: command.userId,
    purposeScopes: command.purposeScopes,
    memoryKind: command.memoryKind,
    slot: command.slot,
    value: command.value,
    boundedContent: command.boundedContent,
    evidenceRef: command.evidenceRef,
    evidenceObservedAt: command.evidenceObservedAt,
    sensitivity: command.sensitivity,
    validity: command.validity,
    idempotencyKey: command.idempotencyKey,
  });
}

function domainHash(domain: string, value: unknown): Sha256 {
  return sha256(jcsSerialize({ domain, value }, domain));
}

function appendKey(domain: "candidate" | "memory", idempotencyKey: string): string {
  const keyHash = domainHash(`paios.memory.explicit-user-remember.${domain}.key.v1`, idempotencyKey);
  return `memory.explicit-user-remember.${domain}:${keyHash}`;
}

function outputRef(value: unknown, expected: CanonicalObjectVersionRef): CanonicalObjectVersionRef {
  let actual: CanonicalObjectVersionRef;
  try {
    assertClosedDataRecord(value, REF_KEYS);
    actual = createCanonicalObjectVersionRef(assertCanonicalObjectVersionRef(value));
  } catch (error) {
    if (error instanceof ExplicitUserRememberError &&
        error.code === "EXPLICIT_REMEMBER_PERSISTENCE_RECEIPT_INVALID") throw error;
    fail("EXPLICIT_REMEMBER_PERSISTENCE_RECEIPT_INVALID", error);
  }
  if (!canonicalRefEquals(actual, expected)) {
    fail("EXPLICIT_REMEMBER_PERSISTENCE_RECEIPT_INVALID");
  }
  return actual;
}

function normalizePersistenceResult(
  value: unknown,
  candidateRef: CanonicalObjectVersionRef,
  memoryRef: CanonicalObjectVersionRef,
): ExplicitUserRememberResult {
  try {
    assertClosedDataRecord(value, ["candidateRef", "memoryRef", "authorityWatermark"]);
  } catch (error) {
    fail("EXPLICIT_REMEMBER_PERSISTENCE_RECEIPT_INVALID", error);
  }
  let authorityWatermark: unknown;
  try {
    authorityWatermark = cloneJson(value.authorityWatermark);
  } catch (error) {
    fail("EXPLICIT_REMEMBER_PERSISTENCE_RECEIPT_INVALID", error);
  }
  return Object.freeze({
    candidateRef: outputRef(value.candidateRef, candidateRef),
    memoryRef: outputRef(value.memoryRef, memoryRef),
    authorityWatermark,
  });
}

export function createProductionExplicitUserRememberService(
  options: ProductionExplicitUserRememberServiceOptions,
): ExplicitUserRememberService {
  if (!isPlainRecord(options) || typeof options.persistence !== "object" ||
      options.persistence === null || typeof options.persistence.remember !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")) {
    fail("EXPLICIT_REMEMBER_CONFIGURATION_INVALID");
  }
  const persistence = options.persistence;
  const now = options.now ?? defaultSystemTime;
  const issuer = createProductionMemoryCanonicalIssuer();
  const replays = new Map<string, ReplayEntry>();

  return Object.freeze({
    async remember(input: ExplicitUserRememberCommand): Promise<ExplicitUserRememberResult> {
      const command = normalizeCommand(input);
      const fingerprint = domainHash(
        "paios.memory.explicit-user-remember.command-fingerprint.v1",
        commandPreimage(command),
      );
      const previous = replays.get(command.idempotencyKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) fail("EXPLICIT_REMEMBER_IDEMPOTENCY_CONFLICT");
        return previous.result;
      }

      const result = (async (): Promise<ExplicitUserRememberResult> => {
        const systemTime = canonicalSystemTime(now);
        const candidateResult = admitMemoryProposal({
          proposalId: `explicit-user-remember:${fingerprint}`,
          intent: { kind: "create" },
          userId: command.userId,
          kind: command.memoryKind,
          slot: command.slot,
          value: command.value,
          sourceClass: "explicit_user_preference",
          evidenceRefs: [command.evidenceRef],
          confidencePpm: 1_000_000,
          purposeScopes: command.purposeScopes,
          sensitivity: command.sensitivity,
          validity: command.validity,
          idempotencyKey: command.idempotencyKey,
          externalInstruction: false,
          identityInference: false,
        });
        if (candidateResult.status !== "candidate") {
          fail(`EXPLICIT_REMEMBER_ADMISSION_${candidateResult.reasonCode}`);
        }
        const candidate = candidateResult.intent;
        const candidateReceipt = issuer.issueCandidate({
          candidate,
          context: { systemTime, createdAt: systemTime, updatedAt: systemTime },
        });
        const acceptedReceipt = issuer.issueCandidateSuccessor({
          previous: candidateReceipt,
          status: "accepted",
          context: {
            systemTime,
            createdAt: systemTime,
            updatedAt: systemTime,
            reviewedAt: systemTime,
          },
        });
        const memoryReceipt = issuer.issueMemory({
          candidate,
          candidateReceipt: acceptedReceipt,
          resolvedContent: command.boundedContent,
          context: { systemTime, createdAt: systemTime, updatedAt: systemTime },
        });
        if (candidateReceipt.candidateRef === undefined || memoryReceipt.memoryRef === undefined) {
          fail("EXPLICIT_REMEMBER_ISSUER_RECEIPT_INVALID");
        }
        const persistenceInput: ExplicitUserRememberPersistenceInput = Object.freeze({
          candidate,
          candidateReceipt,
          memoryReceipt,
          candidateAppendIdempotencyKey: appendKey("candidate", command.idempotencyKey),
          candidateAppendFingerprint: domainHash(
            "paios.memory.explicit-user-remember.candidate-append-fingerprint.v1",
            fingerprint,
          ),
          memoryAppendIdempotencyKey: appendKey("memory", command.idempotencyKey),
          memoryAppendFingerprint: domainHash(
            "paios.memory.explicit-user-remember.memory-append-fingerprint.v1",
            fingerprint,
          ),
        });
        let persisted: ExplicitUserRememberPersistenceResult;
        try {
          persisted = await persistence.remember(persistenceInput);
        } catch (error) {
          fail("EXPLICIT_REMEMBER_PERSISTENCE_FAILED", error);
        }
        return normalizePersistenceResult(
          persisted,
          candidateReceipt.candidateRef,
          memoryReceipt.memoryRef,
        );
      })();

      const entry = Object.freeze({ fingerprint, result });
      replays.set(command.idempotencyKey, entry);
      try {
        return await result;
      } catch (error) {
        if (replays.get(command.idempotencyKey) === entry) replays.delete(command.idempotencyKey);
        throw error;
      }
    },
  });
}
