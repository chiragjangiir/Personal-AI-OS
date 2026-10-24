import { createHash, randomBytes } from "node:crypto";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_UUID_TIMESTAMP = (1n << 48n) - 1n;

type JsonRecord = Record<string, unknown>;

export interface RealtimeCanonicalDeviceIdentityIssueInput {
  readonly rawDeviceId: string;
  readonly sessionId: string;
  readonly clientInstanceId: string;
  readonly eligibilityObservedAt: string;
  readonly requestId: string;
}

export interface RealtimeCanonicalDeviceIdentityReceipt {
  readonly kind: "t02.realtime.canonical-device-identity.v1";
  readonly canonicalDeviceId: string;
  readonly objectVersion: "1";
  readonly canonicalPayloadSha256: string;
}

export interface RealtimeCanonicalDeviceIdentityIssuerPort {
  issue(input: RealtimeCanonicalDeviceIdentityIssueInput): RealtimeCanonicalDeviceIdentityReceipt;
}

export class RealtimeCanonicalDeviceIdentityIssuerError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "RealtimeCanonicalDeviceIdentityIssuerError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimeCanonicalDeviceIdentityIssuerError(code);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) fail(code);
  }
  return value;
}

function exactString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value) fail(code);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) fail("REALTIME_CANONICAL_DEVICE_TIME_INVALID");
  const milliseconds = BigInt(Date.parse(value));
  if (milliseconds < 0n || milliseconds > MAX_UUID_TIMESTAMP) fail("REALTIME_CANONICAL_DEVICE_TIME_RANGE_INVALID");
  return value;
}

function normalizeInput(value: RealtimeCanonicalDeviceIdentityIssueInput): RealtimeCanonicalDeviceIdentityIssueInput {
  const record = exactRecord(value, ["rawDeviceId", "sessionId", "clientInstanceId", "eligibilityObservedAt", "requestId"],
    "REALTIME_CANONICAL_DEVICE_INPUT_INVALID");
  return Object.freeze({
    rawDeviceId: exactString(record.rawDeviceId, "REALTIME_CANONICAL_DEVICE_RAW_ID_INVALID"),
    sessionId: exactString(record.sessionId, "REALTIME_CANONICAL_DEVICE_SESSION_INVALID"),
    clientInstanceId: exactString(record.clientInstanceId, "REALTIME_CANONICAL_DEVICE_CLIENT_INVALID"),
    eligibilityObservedAt: timestamp(record.eligibilityObservedAt),
    requestId: exactString(record.requestId, "REALTIME_CANONICAL_DEVICE_REQUEST_INVALID"),
  });
}

function canonicalPayload(input: RealtimeCanonicalDeviceIdentityIssueInput): string {
  return JSON.stringify({
    clientInstanceId: input.clientInstanceId,
    eligibilityObservedAt: input.eligibilityObservedAt,
    rawDeviceId: input.rawDeviceId,
    requestId: input.requestId,
    sessionId: input.sessionId,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidV7(issuedAt: string, entropy: Uint8Array): string {
  if (entropy.length !== 10) fail("REALTIME_CANONICAL_DEVICE_ENTROPY_INVALID");
  const bytes = Buffer.alloc(16);
  let milliseconds = BigInt(Date.parse(issuedAt));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(milliseconds & 0xffn);
    milliseconds >>= 8n;
  }
  bytes[6] = 0x70 | (entropy[0]! & 0x0f);
  bytes[7] = entropy[1]!;
  bytes[8] = 0x80 | (entropy[2]! & 0x3f);
  for (let index = 9; index < 16; index += 1) bytes[index] = entropy[index - 6]!;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestampFromUuid(value: string): bigint {
  return BigInt(`0x${value.replaceAll("-", "").slice(0, 12)}`);
}

export function assertRealtimeCanonicalDeviceIdentityReceipt(
  value: unknown,
  rawInput: RealtimeCanonicalDeviceIdentityIssueInput,
): RealtimeCanonicalDeviceIdentityReceipt {
  const input = normalizeInput(rawInput);
  const record = exactRecord(value, ["kind", "canonicalDeviceId", "objectVersion", "canonicalPayloadSha256"],
    "REALTIME_CANONICAL_DEVICE_RECEIPT_INVALID");
  if (record.kind !== "t02.realtime.canonical-device-identity.v1" ||
      typeof record.canonicalDeviceId !== "string" || !UUID_V7.test(record.canonicalDeviceId) ||
      record.objectVersion !== "1" || typeof record.canonicalPayloadSha256 !== "string" ||
      !SHA256.test(record.canonicalPayloadSha256) ||
      record.canonicalPayloadSha256 !== sha256(canonicalPayload(input)) ||
      timestampFromUuid(record.canonicalDeviceId) !== BigInt(Date.parse(input.eligibilityObservedAt))) {
    fail("REALTIME_CANONICAL_DEVICE_RECEIPT_INVALID");
  }
  return Object.freeze({
    kind: "t02.realtime.canonical-device-identity.v1",
    canonicalDeviceId: record.canonicalDeviceId,
    objectVersion: "1",
    canonicalPayloadSha256: record.canonicalPayloadSha256,
  });
}

export function createProductionRealtimeCanonicalDeviceIdentityIssuer(): RealtimeCanonicalDeviceIdentityIssuerPort {
  return Object.freeze({
    issue(rawInput: RealtimeCanonicalDeviceIdentityIssueInput): RealtimeCanonicalDeviceIdentityReceipt {
      const input = normalizeInput(rawInput);
      return assertRealtimeCanonicalDeviceIdentityReceipt(Object.freeze({
        kind: "t02.realtime.canonical-device-identity.v1",
        canonicalDeviceId: uuidV7(input.eligibilityObservedAt, randomBytes(10)),
        objectVersion: "1",
        canonicalPayloadSha256: sha256(canonicalPayload(input)),
      }), input);
    },
  });
}
