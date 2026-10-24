import { createHash, randomBytes } from "node:crypto";

import type { RealtimeClockPort, RealtimeIdentityPort } from "../../realtime-core/src/ports.ts";
import type { ExternalAlias, OpaqueCanonicalRef } from "../../realtime-core/src/types.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})(?:\d{3})?Z$/u;
const MAX_UUID_TIMESTAMP = (1n << 48n) - 1n;
const UUID_TAIL_MAX = (1n << 74n) - 1n;
const REF_KEYS = ["canonical_payload_sha256", "object_version", "ref_id", "ref_type"] as const;

type JsonRecord = Record<string, unknown>;
type RepositoryRefType = "RealtimeSession" | "DeviceLease";

interface RepositoryRef extends Readonly<Record<string, unknown>> {
  readonly ref_type: RepositoryRefType;
  readonly ref_id: string;
  readonly object_version: string;
  readonly canonical_payload_sha256: string;
}

export interface ProductionRealtimeIdentityPortOptions {
  readonly clock: RealtimeClockPort;
}

export class ProductionRealtimeIdentityError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super(code, options);
    this.name = "ProductionRealtimeIdentityError";
    this.code = code;
  }
}

function fail(code: string, cause?: unknown): never {
  throw cause === undefined
    ? new ProductionRealtimeIdentityError(code)
    : new ProductionRealtimeIdentityError(code, { cause });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): JsonRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const actual = Object.keys(value).sort();
  if (Object.getOwnPropertyNames(value).length !== actual.length) fail(code);
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true) fail(code);
  }
  return value;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value) fail(code);
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) fail("REALTIME_IDENTITY_EPOCH_INVALID");
  return value;
}

function clockMilliseconds(value: unknown): bigint {
  if (typeof value !== "string") fail("REALTIME_IDENTITY_TIME_INVALID");
  const match = CANONICAL_TIME.exec(value);
  if (match === null) fail("REALTIME_IDENTITY_TIME_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== `${match[1]}Z`) {
    fail("REALTIME_IDENTITY_TIME_INVALID");
  }
  const milliseconds = BigInt(parsed);
  if (milliseconds < 0n || milliseconds > MAX_UUID_TIMESTAMP) fail("REALTIME_IDENTITY_TIME_RANGE_INVALID");
  return milliseconds;
}

function randomTail(): bigint {
  const entropy = randomBytes(10);
  let value = 0n;
  for (const byte of entropy) value = (value << 8n) | BigInt(byte);
  return value & UUID_TAIL_MAX;
}

function formatUuidV7(milliseconds: bigint, tail: bigint): string {
  const randA = tail >> 62n;
  const randB = tail & ((1n << 62n) - 1n);
  const encoded = (milliseconds << 80n) | (0x7n << 76n) | (randA << 64n) | (0x2n << 62n) | randB;
  const hex = encoded.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function domainHash(domain: string, payload: string): string {
  return sha256(`${domain}\n${payload}`);
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("REALTIME_IDENTITY_PROVIDER_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail("REALTIME_IDENTITY_PROVIDER_INVALID");
  if (ancestors.has(value)) fail("REALTIME_IDENTITY_PROVIDER_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1) {
        fail("REALTIME_IDENTITY_PROVIDER_INVALID");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            descriptor.enumerable !== true) fail("REALTIME_IDENTITY_PROVIDER_INVALID");
        items.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      fail("REALTIME_IDENTITY_PROVIDER_INVALID");
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true) fail("REALTIME_IDENTITY_PROVIDER_INVALID");
      entries.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function providerPayload(value: ExternalAlias): string {
  if (typeof value === "string") return JSON.stringify(text(value, "REALTIME_IDENTITY_PROVIDER_INVALID"));
  if (!isPlainRecord(value)) fail("REALTIME_IDENTITY_PROVIDER_INVALID");
  return canonicalJson(value);
}

function refPayload(refType: RepositoryRefType, refId: string, objectVersion: string): string {
  return JSON.stringify({ object_version: objectVersion, ref_id: refId, ref_type: refType });
}

function refHash(refType: RepositoryRefType, refId: string, objectVersion: string): string {
  return domainHash(`paios.t02.${refType}.repository-ref.v1`, refPayload(refType, refId, objectVersion));
}

function repositoryRef(value: unknown, expectedType: RepositoryRefType): RepositoryRef {
  const record = exactRecord(value, REF_KEYS, "REALTIME_IDENTITY_REF_INVALID");
  if (record.ref_type !== expectedType || typeof record.ref_id !== "string" || !UUID_V7.test(record.ref_id) ||
      typeof record.object_version !== "string" || !DECIMAL.test(record.object_version) ||
      typeof record.canonical_payload_sha256 !== "string" || !SHA256.test(record.canonical_payload_sha256) ||
      record.canonical_payload_sha256 !== refHash(expectedType, record.ref_id, record.object_version)) {
    fail("REALTIME_IDENTITY_REF_INVALID");
  }
  return record as unknown as RepositoryRef;
}

function makeRef(refType: RepositoryRefType, refId: string): RepositoryRef {
  const objectVersion = "1";
  return Object.freeze({
    ref_type: refType,
    ref_id: refId,
    object_version: objectVersion,
    canonical_payload_sha256: refHash(refType, refId, objectVersion),
  });
}

export function createProductionRealtimeIdentityPort(
  rawOptions: ProductionRealtimeIdentityPortOptions,
): RealtimeIdentityPort {
  const options = exactRecord(rawOptions, ["clock"], "REALTIME_IDENTITY_OPTIONS_INVALID");
  const clock = exactRecord(options.clock, ["now"], "REALTIME_IDENTITY_CLOCK_INVALID");
  if (typeof clock.now !== "function") fail("REALTIME_IDENTITY_CLOCK_INVALID");
  const now = clock.now.bind(options.clock) as () => unknown;
  let lastMilliseconds: bigint | undefined;
  let lastTail = 0n;

  function nextUuid(): string {
    let clockValue: unknown;
    try {
      clockValue = now();
    } catch (error) {
      fail("REALTIME_IDENTITY_CLOCK_FAILED", error);
    }
    const milliseconds = clockMilliseconds(clockValue);
    if (lastMilliseconds !== undefined && milliseconds < lastMilliseconds) fail("REALTIME_IDENTITY_CLOCK_ROLLBACK");
    let tail: bigint;
    if (milliseconds === lastMilliseconds) {
      if (lastTail === UUID_TAIL_MAX) fail("REALTIME_IDENTITY_UUID_TAIL_EXHAUSTED");
      tail = lastTail + 1n;
    } else {
      tail = randomTail();
    }
    lastMilliseconds = milliseconds;
    lastTail = tail;
    return formatUuidV7(milliseconds, tail);
  }

  return Object.freeze({
    createContinuityId(rawInput: Parameters<RealtimeIdentityPort["createContinuityId"]>[0]): string {
      const input = exactRecord(rawInput, ["userId", "requestId"], "REALTIME_IDENTITY_CONTINUITY_INPUT_INVALID");
      text(input.userId, "REALTIME_IDENTITY_USER_INVALID");
      text(input.requestId, "REALTIME_IDENTITY_REQUEST_INVALID");
      return nextUuid();
    },

    assertRepositoryIssuedRef(value: OpaqueCanonicalRef, kind: RepositoryRefType): void {
      if (kind !== "RealtimeSession" && kind !== "DeviceLease") fail("REALTIME_IDENTITY_REF_KIND_INVALID");
      repositoryRef(value, kind);
    },

    createSessionRef(rawInput: Parameters<RealtimeIdentityPort["createSessionRef"]>[0]): OpaqueCanonicalRef {
      const input = exactRecord(rawInput, ["userId", "continuityId", "requestId"],
        "REALTIME_IDENTITY_SESSION_INPUT_INVALID");
      text(input.userId, "REALTIME_IDENTITY_USER_INVALID");
      if (typeof input.continuityId !== "string" || !UUID_V7.test(input.continuityId)) {
        fail("REALTIME_IDENTITY_CONTINUITY_INVALID");
      }
      text(input.requestId, "REALTIME_IDENTITY_REQUEST_INVALID");
      return makeRef("RealtimeSession", nextUuid());
    },

    createDeviceLeaseRef(rawInput: Parameters<RealtimeIdentityPort["createDeviceLeaseRef"]>[0]): OpaqueCanonicalRef {
      const input = exactRecord(rawInput, ["sessionRef", "deviceId", "requestId"],
        "REALTIME_IDENTITY_LEASE_INPUT_INVALID");
      repositoryRef(input.sessionRef, "RealtimeSession");
      text(input.deviceId, "REALTIME_IDENTITY_DEVICE_INVALID");
      text(input.requestId, "REALTIME_IDENTITY_REQUEST_INVALID");
      return makeRef("DeviceLease", nextUuid());
    },

    createTransportAlias(rawInput: Parameters<RealtimeIdentityPort["createTransportAlias"]>[0]): ExternalAlias {
      const input = exactRecord(rawInput, ["provider", "sessionRef", "deviceId", "connectionEpoch", "requestId"],
        "REALTIME_IDENTITY_ALIAS_INPUT_INVALID");
      const sessionRef = repositoryRef(input.sessionRef, "RealtimeSession");
      const deviceId = text(input.deviceId, "REALTIME_IDENTITY_DEVICE_INVALID");
      const connectionEpoch = decimal(input.connectionEpoch);
      const requestId = text(input.requestId, "REALTIME_IDENTITY_REQUEST_INVALID");
      const alias = [
        "t02.realtime.transport-alias.v1",
        domainHash("paios.t02.transport-provider.v1", providerPayload(input.provider as ExternalAlias)),
        sessionRef.canonical_payload_sha256,
        domainHash("paios.t02.transport-device.v1", JSON.stringify(deviceId)),
        connectionEpoch,
        domainHash("paios.t02.transport-request.v1", JSON.stringify(requestId)),
      ].join(":");
      if (alias.length >= 512) fail("REALTIME_IDENTITY_ALIAS_LENGTH_INVALID");
      return alias;
    },

    createConnectionId(rawInput: Parameters<RealtimeIdentityPort["createConnectionId"]>[0]): string {
      const input = exactRecord(rawInput, ["deviceId", "requestId"], "REALTIME_IDENTITY_CONNECTION_INPUT_INVALID");
      text(input.deviceId, "REALTIME_IDENTITY_DEVICE_INVALID");
      text(input.requestId, "REALTIME_IDENTITY_REQUEST_INVALID");
      return nextUuid();
    },
  });
}
