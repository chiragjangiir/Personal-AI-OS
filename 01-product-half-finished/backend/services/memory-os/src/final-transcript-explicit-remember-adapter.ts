import { createHash } from "node:crypto";

import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  createCanonicalObjectVersionRef,
  type CanonicalObjectVersionRef,
} from "./canonical-ref.ts";
import {
  jcsSerialize,
} from "./canonical-issuer.ts";
import {
  MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES,
  type ExplicitUserRememberCommand,
  type ExplicitUserRememberResult,
} from "./explicit-user-remember-service.ts";
import {
  assertCanonicalUtcInstant,
  type MemorySensitivity,
} from "./domain.ts";

const ADAPTER_DOMAIN = "paios.memory.final-transcript-explicit-remember.adapter.v1" as const;
const COMMAND_KEYS = Object.freeze([
  "userId",
  "purposeScopes",
  "originalUtterance",
  "evidenceRef",
  "sensitivity",
] as const);
const REF_KEYS = Object.freeze([
  "refType",
  "refId",
  "objectVersion",
  "canonicalPayloadSha256",
] as const);
const SENSITIVITY_KEYS = Object.freeze(["classification", "userConfirmed"] as const);
const EVIDENCE_KEYS = Object.freeze([
  "ref",
  "transcriptState",
  "userId",
  "purpose",
  "text",
  "observedAt",
] as const);
const REMEMBER_PREFIX = /^记住(?:(?:[ \t]+)|(?:[:：,，][ \t]*))/u;

type PlainRecord = Record<string, unknown>;

/**
 * A T11B-owned read projection.  The adapter never creates or modifies this
 * object; it only accepts a projection returned by the injected owner reader
 * after resolving the exact FinalTranscriptEvidence ref.
 */
export interface FinalTranscriptEvidenceRecord {
  readonly ref: CanonicalObjectVersionRef;
  readonly transcriptState: "final";
  readonly userId: string;
  readonly purpose: string;
  readonly text: string;
  readonly observedAt: string;
}

/** Read-only T11B owner seam; no fallback or fabricated evidence is allowed. */
export interface FinalTranscriptEvidenceReader {
  read(ref: CanonicalObjectVersionRef):
    Promise<FinalTranscriptEvidenceRecord | undefined>;
}

/** The explicit-user-remember method already exposed by ProductionMemoryRuntime. */
export interface ExplicitUserRememberPort {
  rememberExplicit(input: ExplicitUserRememberCommand): Promise<ExplicitUserRememberResult>;
}

export interface FinalTranscriptExplicitRememberInput {
  readonly userId: string;
  /** Ordered, caller-provided purpose scopes; the adapter never guesses or sorts them. */
  readonly purposeScopes: readonly string[];
  /** The exact final STT utterance, including the explicit command prefix. */
  readonly originalUtterance: string;
  /** Exact immutable T11B ref; its record is resolved through the owner reader. */
  readonly evidenceRef: CanonicalObjectVersionRef;
  /** Caller-bound and user-confirmed; the adapter does not infer sensitivity. */
  readonly sensitivity: MemorySensitivity;
}

export interface FinalTranscriptExplicitRememberAdapterOptions {
  readonly evidenceReader: FinalTranscriptEvidenceReader;
  readonly remember: ExplicitUserRememberPort;
}

export interface FinalTranscriptExplicitRememberAdapter {
  /**
   * Returns undefined for ordinary non-command speech.  All malformed or
   * authority-drifting inputs reject before the remember port is called.
   */
  remember(input: FinalTranscriptExplicitRememberInput):
    Promise<ExplicitUserRememberResult | undefined>;
}

export class FinalTranscriptExplicitRememberError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "FinalTranscriptExplicitRememberError";
    this.code = code;
  }
}

interface NormalizedInput {
  readonly userId: string;
  readonly purposeScopes: readonly string[];
  readonly originalUtterance: string;
  readonly evidenceRef: CanonicalObjectVersionRef;
  readonly sensitivity: MemorySensitivity;
}

interface NormalizedEvidence extends FinalTranscriptEvidenceRecord {
  readonly ref: CanonicalObjectVersionRef;
  readonly observedAt: string;
}

interface ReplayEntry {
  readonly fingerprint: string;
  readonly result: Promise<ExplicitUserRememberResult>;
}

function fail(code: string, cause?: unknown): never {
  throw new FinalTranscriptExplicitRememberError(
    code,
    cause === undefined ? {} : { cause },
  );
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertClosedRecord(
  value: unknown,
  required: readonly string[],
): asserts value is PlainRecord {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_INPUT_INVALID");
  }
  const actual = Object.keys(value);
  const ownNames = Object.getOwnPropertyNames(value);
  const expected = new Set(required);
  if (ownNames.length !== required.length || ownNames.some((key) => !expected.has(key)) ||
      actual.length !== ownNames.length || actual.some((key) => !expected.has(key))) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_INPUT_INVALID");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_INPUT_INVALID");
    }
  }
}

function isSafeArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return false;
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name === "length") continue;
      const index = Number(name);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= value.length) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return false;
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) {
    fail(code);
  }
  return value;
}

function copyRef(value: unknown): CanonicalObjectVersionRef {
  assertClosedRecord(value, REF_KEYS);
  try {
    const ref = assertCanonicalObjectVersionRef(value);
    return createCanonicalObjectVersionRef(ref);
  } catch (error) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_REF_INVALID", error);
  }
}

function copySensitivity(value: unknown): MemorySensitivity {
  assertClosedRecord(value, SENSITIVITY_KEYS);
  if ((value.classification !== "normal" && value.classification !== "sensitive") ||
      value.userConfirmed !== true) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CONFIRMATION_REQUIRED");
  }
  return Object.freeze({
    classification: value.classification,
    userConfirmed: true,
  });
}

function normalizeInput(value: FinalTranscriptExplicitRememberInput | unknown): NormalizedInput {
  assertClosedRecord(value, COMMAND_KEYS);
  const userId = exactString(value.userId, "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_USER_INVALID");
  if (!isSafeArray(value.purposeScopes) || value.purposeScopes.length === 0 ||
      value.purposeScopes.some((scope) => typeof scope !== "string" || scope.length === 0 ||
        scope !== scope.trim() || scope.includes("\u0000")) ||
      new Set(value.purposeScopes as readonly string[]).size !== value.purposeScopes.length) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_PURPOSE_INVALID");
  }
  const purposeScopes = Object.freeze([...(value.purposeScopes as readonly string[])]);
  const originalUtterance = exactString(
    value.originalUtterance,
    "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_UTTERANCE_INVALID",
  );
  const evidenceRef = copyRef(value.evidenceRef);
  if (evidenceRef.refType !== "FinalTranscriptEvidence") {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TYPE_INVALID");
  }
  return Object.freeze({
    userId,
    purposeScopes,
    originalUtterance,
    evidenceRef,
    sensitivity: copySensitivity(value.sensitivity),
  });
}

function parseRememberedContent(utterance: string): string | undefined {
  if (utterance === "记住" || utterance.startsWith("记住:") || utterance.startsWith("记住：") ||
      utterance.startsWith("记住,") || utterance.startsWith("记住，")) {
    const match = REMEMBER_PREFIX.exec(utterance);
    if (match === null) fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CONTENT_INVALID");
    const content = utterance.slice(match[0].length);
    if (content.length === 0 || content !== content.trim() || content.includes("\u0000") ||
        Buffer.byteLength(content, "utf8") > MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES) {
      fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CONTENT_INVALID");
    }
    return content;
  }
  return undefined;
}

function sha256(value: unknown, field: string): string {
  let serialized: string;
  try {
    serialized = jcsSerialize(value, field);
  } catch (error) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CANONICALIZATION_INVALID", error);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function normalizeEvidence(value: unknown, expectedRef: CanonicalObjectVersionRef): NormalizedEvidence {
  assertClosedRecord(value, EVIDENCE_KEYS);
  const ref = copyRef(value.ref);
  if (ref.refType !== "FinalTranscriptEvidence" || canonicalRefKey(ref) !== canonicalRefKey(expectedRef)) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_DRIFT");
  }
  if (value.transcriptState !== "final") {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_FINAL_REQUIRED");
  }
  const userId = exactString(value.userId, "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_USER_INVALID");
  const purpose = exactString(value.purpose, "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_PURPOSE_INVALID");
  const text = exactString(value.text, "FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TEXT_INVALID");
  if (Buffer.byteLength(text, "utf8") > MAX_EXPLICIT_USER_REMEMBER_CONTENT_BYTES) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TEXT_INVALID");
  }
  let observedAt: string;
  try {
    observedAt = assertCanonicalUtcInstant(value.observedAt, "evidence.observedAt");
  } catch (error) {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TIME_INVALID", error);
  }
  return Object.freeze({
    ref,
    transcriptState: "final",
    userId,
    purpose,
    text,
    observedAt,
  });
}

function makeCommand(
  input: NormalizedInput,
  evidence: NormalizedEvidence,
  content: string,
): { readonly command: ExplicitUserRememberCommand; readonly fingerprint: string; readonly idempotencyKey: string } {
  const base = Object.freeze({
    domain: `${ADAPTER_DOMAIN}.command-content.v1`,
    action: "remember" as const,
    userConfirmed: true as const,
    userId: input.userId,
    purposeScopes: input.purposeScopes,
    memoryKind: "preference_memory" as const,
    boundedContent: content,
    value: Object.freeze({ text: content }),
    evidenceRef: evidence.ref,
    evidenceObservedAt: evidence.observedAt,
    sensitivity: input.sensitivity,
    validity: Object.freeze({ observedAt: evidence.observedAt }),
  });
  const slotSeed = sha256(base, "explicit remember command content");
  const slot = `preference.explicit_transcript.${slotSeed}`;
  const commandPreimage = Object.freeze({ ...base, slot });
  const fingerprint = sha256(
    Object.freeze({ ...commandPreimage, domain: `${ADAPTER_DOMAIN}.command-fingerprint.v1` }),
    "explicit remember command fingerprint",
  );
  const idempotencySeed = sha256(
    Object.freeze({
      domain: `${ADAPTER_DOMAIN}.idempotency-key.v1`,
      userId: input.userId,
      evidenceRef: evidence.ref,
    }),
    "explicit remember idempotency key",
  );
  const command: ExplicitUserRememberCommand = Object.freeze({
    action: "remember",
    userConfirmed: true,
    userId: input.userId,
    purposeScopes: input.purposeScopes,
    memoryKind: "preference_memory",
    slot,
    value: Object.freeze({ text: content }),
    boundedContent: content,
    evidenceRef: evidence.ref,
    evidenceObservedAt: evidence.observedAt,
    sensitivity: input.sensitivity,
    validity: Object.freeze({ observedAt: evidence.observedAt }),
    idempotencyKey: `${ADAPTER_DOMAIN}:idempotency:${idempotencySeed}`,
  });
  return Object.freeze({ command, fingerprint, idempotencyKey: command.idempotencyKey });
}

function validatePort(options: FinalTranscriptExplicitRememberAdapterOptions): void {
  if (!isPlainRecord(options) || !isPlainRecord(options.evidenceReader) ||
      typeof options.evidenceReader.read !== "function" || !isPlainRecord(options.remember) ||
      typeof options.remember.rememberExplicit !== "function") {
    fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_CONFIGURATION_INVALID");
  }
}

export function createFinalTranscriptExplicitRememberAdapter(
  options: FinalTranscriptExplicitRememberAdapterOptions,
): FinalTranscriptExplicitRememberAdapter {
  validatePort(options);
  const replay = new Map<string, ReplayEntry>();
  return Object.freeze({
    async remember(rawInput: FinalTranscriptExplicitRememberInput) {
      const input = normalizeInput(rawInput);
      const content = parseRememberedContent(input.originalUtterance);
      if (content === undefined) return undefined;

      let resolved: FinalTranscriptEvidenceRecord | undefined;
      try {
        resolved = await options.evidenceReader.read(input.evidenceRef);
      } catch (error) {
        fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_READ_FAILED", error);
      }
      if (resolved === undefined) fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_NOT_FOUND");
      const evidence = normalizeEvidence(resolved, input.evidenceRef);
      if (evidence.transcriptState !== "final") {
        fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_FINAL_REQUIRED");
      }
      if (evidence.userId !== input.userId) {
        fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_USER_DRIFT");
      }
      if (!input.purposeScopes.includes(evidence.purpose)) {
        fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_PURPOSE_DRIFT");
      }
      if (evidence.text !== input.originalUtterance) {
        fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_EVIDENCE_TEXT_DRIFT");
      }

      const built = makeCommand(input, evidence, content);
      const previous = replay.get(built.idempotencyKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== built.fingerprint) {
          fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_IDEMPOTENCY_CONFLICT");
        }
        return previous.result;
      }

      const result = (async () => {
        try {
          return await options.remember.rememberExplicit(built.command);
        } catch (error) {
          fail("FINAL_TRANSCRIPT_EXPLICIT_REMEMBER_FAILED", error);
        }
      })();
      replay.set(built.idempotencyKey, Object.freeze({
        fingerprint: built.fingerprint,
        result,
      }));
      try {
        return await result;
      } catch (error) {
        if (replay.get(built.idempotencyKey)?.result === result) replay.delete(built.idempotencyKey);
        throw error;
      }
    },
  });
}
