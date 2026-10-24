import { assertAppleFormalWatchBindingReceipt } from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import { createHash } from 'node:crypto';

import type {
  ApplePhysicalCanaryBindingPostgresPort,
  ApplePhysicalCanaryBindingReceipt,
} from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import type { OpaqueCanonicalRef } from '../../../services/realtime-core/src/types.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FORMAT = 'paios.apple-cycling-telemetry.v1+json' as const;
const RECEIPT_KIND = 'windows.public.apple-cycling-telemetry-receipt.v1' as const;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_OBSERVATION_AGE_MS = 120_000;
const REQUIRED_CHANNELS = Object.freeze([
  'iphone.location',
  'iphone.navigation',
  'iphone.speed',
  'watch.active_energy',
  'watch.heart_rate',
] as const);

type JsonRecord = Record<string, unknown>;

export interface AppleCyclingTelemetryEndpointProjection {
  readonly deviceId: string;
  readonly clientInstanceId: string;
  readonly observedAt: string;
}

export interface AppleCyclingTelemetryProjection {
  readonly bindingId: string;
  readonly format: typeof FORMAT;
  readonly channels: typeof REQUIRED_CHANNELS;
  /** Ownership transfers to this adapter; the bytes are zeroized before deliver() settles. */
  readonly payload: Uint8Array;
  readonly payloadSha256: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly iphone: AppleCyclingTelemetryEndpointProjection;
  readonly watch: AppleCyclingTelemetryEndpointProjection;
}

export interface AppleCyclingTelemetryInputPort<TInput> {
  take(input: TInput): Promise<AppleCyclingTelemetryProjection>;
  release(input: TInput): void | Promise<void>;
}

export interface RayneoCyclingTelemetryConsumerAck {
  readonly acceptedPayloadSha256: string;
  readonly deliveredAt: string;
  readonly consumerReceiptSha256: string;
}

export interface RayneoCyclingTelemetryConsumerPort {
  deliver(input: Readonly<{
    readonly currentBinding: ApplePhysicalCanaryBindingReceipt;
    readonly format: typeof FORMAT;
    readonly channels: typeof REQUIRED_CHANNELS;
    readonly payload: Uint8Array;
    readonly payloadSha256: string;
    readonly iphoneObservedAt: string;
    readonly watchObservedAt: string;
  }>): Promise<RayneoCyclingTelemetryConsumerAck>;
}

export interface AppleCyclingTelemetryReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly objectVersion: '1';
  readonly bindingId: string;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly payloadSha256: string;
  readonly iphoneObservedAt: string;
  readonly watchObservedAt: string;
  readonly deliveredAt: string;
  readonly consumerReceiptSha256: string;
  readonly canonicalPayloadSha256: string;
}

export interface RealtimePublicControlAppleCyclingTelemetryOptions<TInput> {
  readonly bindingSource?: "formal" | "canary";
  readonly binding: ApplePhysicalCanaryBindingPostgresPort;
  readonly input: AppleCyclingTelemetryInputPort<TInput>;
  readonly consumer: RayneoCyclingTelemetryConsumerPort;
  readonly now?: () => number;
  readonly maxObservationAgeMs?: number;
}

export interface RealtimePublicControlAppleCyclingTelemetry<TInput> {
  deliver(input: TInput): Promise<AppleCyclingTelemetryReceipt>;
  close(): Promise<void>;
}

export class RealtimePublicControlAppleCyclingTelemetryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RealtimePublicControlAppleCyclingTelemetryError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RealtimePublicControlAppleCyclingTelemetryError(code);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
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

function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !UUID_V7.test(value)) fail(code);
  return value;
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== 'string' || !UTC.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return value;
}

function hash(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CYCLING_CANONICAL_VALUE_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value === undefined || ArrayBuffer.isView(value)) {
    fail('CYCLING_CANONICAL_VALUE_INVALID');
  }
  if (ancestors.has(value)) fail('CYCLING_CANONICAL_VALUE_INVALID');
  ancestors.add(value);
  let encoded: string;
  if (Array.isArray(value)) {
    encoded = `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
  } else {
    const record = exactRecord(value, Object.keys(value), 'CYCLING_CANONICAL_VALUE_INVALID');
    encoded = `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return encoded;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function endpoint(value: unknown): AppleCyclingTelemetryEndpointProjection {
  const record = exactRecord(value, ['deviceId', 'clientInstanceId', 'observedAt'], 'CYCLING_ENDPOINT_INVALID');
  return Object.freeze({
    deviceId: identifier(record.deviceId, 'CYCLING_ENDPOINT_INVALID'),
    clientInstanceId: identifier(record.clientInstanceId, 'CYCLING_ENDPOINT_INVALID'),
    observedAt: timestamp(record.observedAt, 'CYCLING_ENDPOINT_INVALID'),
  });
}

function projection(value: unknown): AppleCyclingTelemetryProjection {
  const record = exactRecord(value, [
    'bindingId', 'format', 'channels', 'payload', 'payloadSha256', 'realtimeSessionRef', 'iphone', 'watch',
  ], 'CYCLING_PROJECTION_INVALID');
  if (record.format !== FORMAT || !(record.payload instanceof Uint8Array) ||
      record.payload.byteLength === 0 || record.payload.byteLength > MAX_PAYLOAD_BYTES ||
      !Array.isArray(record.channels) || record.channels.length !== REQUIRED_CHANNELS.length ||
      record.channels.some((channel, index) => channel !== REQUIRED_CHANNELS[index])) {
    fail('CYCLING_PROJECTION_INVALID');
  }
  const payloadSha256 = hash(record.payloadSha256, 'CYCLING_PAYLOAD_HASH_INVALID');
  if (sha256(record.payload) !== payloadSha256) fail('CYCLING_PAYLOAD_HASH_MISMATCH');
  return Object.freeze({
    bindingId: identifier(record.bindingId, 'CYCLING_BINDING_ID_INVALID'),
    format: FORMAT,
    channels: REQUIRED_CHANNELS,
    payload: record.payload,
    payloadSha256,
    realtimeSessionRef: record.realtimeSessionRef as OpaqueCanonicalRef,
    iphone: endpoint(record.iphone),
    watch: endpoint(record.watch),
  });
}

function transferredPayload(value: unknown): Uint8Array | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'payload');
  return descriptor?.get === undefined && descriptor?.set === undefined && descriptor?.value instanceof Uint8Array
    ? descriptor.value
    : undefined;
}

function assertCurrentBinding(
  value: AppleCyclingTelemetryProjection,
  binding: ApplePhysicalCanaryBindingReceipt,
  now: number,
  maximumAge: number,
): void {
  if (binding.bindingId !== value.bindingId || !same(binding.realtimeSessionRef, value.realtimeSessionRef) ||
      binding.iphone.deviceId !== value.iphone.deviceId ||
      binding.iphone.clientInstanceId !== value.iphone.clientInstanceId ||
      binding.watch.deviceId !== value.watch.deviceId ||
      binding.watch.clientInstanceId !== value.watch.clientInstanceId) {
    fail('CYCLING_CURRENT_BINDING_MISMATCH');
  }
  const issuedAt = Date.parse(binding.issuedAt);
  const expiresAt = Date.parse(binding.expiresAt);
  const iphoneAt = Date.parse(value.iphone.observedAt);
  const watchAt = Date.parse(value.watch.observedAt);
  if (now < issuedAt || now >= expiresAt || iphoneAt < issuedAt || iphoneAt >= expiresAt ||
      watchAt < issuedAt || watchAt >= expiresAt || iphoneAt > now || watchAt > now ||
      now - iphoneAt > maximumAge || now - watchAt > maximumAge || Math.abs(iphoneAt - watchAt) > maximumAge) {
    fail('CYCLING_OBSERVATION_WINDOW_INVALID');
  }
}

function ack(value: unknown, payloadSha256: string): RayneoCyclingTelemetryConsumerAck {
  const record = exactRecord(value, ['acceptedPayloadSha256', 'deliveredAt', 'consumerReceiptSha256'],
    'CYCLING_CONSUMER_ACK_INVALID');
  const result = Object.freeze({
    acceptedPayloadSha256: hash(record.acceptedPayloadSha256, 'CYCLING_CONSUMER_ACK_INVALID'),
    deliveredAt: timestamp(record.deliveredAt, 'CYCLING_CONSUMER_ACK_INVALID'),
    consumerReceiptSha256: hash(record.consumerReceiptSha256, 'CYCLING_CONSUMER_ACK_INVALID'),
  });
  if (result.acceptedPayloadSha256 !== payloadSha256) fail('CYCLING_CONSUMER_ACK_MISMATCH');
  return result;
}

function receipt(
  value: AppleCyclingTelemetryProjection,
  binding: ApplePhysicalCanaryBindingReceipt,
  consumerAck: RayneoCyclingTelemetryConsumerAck,
): AppleCyclingTelemetryReceipt {
  const body = Object.freeze({
    kind: RECEIPT_KIND,
    objectVersion: '1' as const,
    bindingId: binding.bindingId,
    realtimeSessionRef: binding.realtimeSessionRef,
    payloadSha256: value.payloadSha256,
    iphoneObservedAt: value.iphone.observedAt,
    watchObservedAt: value.watch.observedAt,
    deliveredAt: consumerAck.deliveredAt,
    consumerReceiptSha256: consumerAck.consumerReceiptSha256,
  });
  return Object.freeze({ ...body, canonicalPayloadSha256: sha256(canonicalJson(body)) });
}

export function createRealtimePublicControlAppleCyclingTelemetry<TInput>(
  options: RealtimePublicControlAppleCyclingTelemetryOptions<TInput>,
): RealtimePublicControlAppleCyclingTelemetry<TInput> {
  if (typeof options?.binding?.read !== 'function' || typeof options?.input?.take !== 'function' ||
      typeof options.input.release !== 'function' || typeof options?.consumer?.deliver !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    fail('CYCLING_COMPOSITION_OPTIONS_INVALID');
  }
  const maximumAge = options.maxObservationAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS;
  if (!Number.isSafeInteger(maximumAge) || maximumAge < 1_000 || maximumAge > 300_000) {
    fail('CYCLING_OBSERVATION_WINDOW_CONFIG_INVALID');
  }
  const now = options.now ?? Date.now;
  let closed = false;
  let closeFlight: Promise<void> | undefined;

  return Object.freeze({
    async deliver(input: TInput): Promise<AppleCyclingTelemetryReceipt> {
      if (closed) fail('CYCLING_COMPOSITION_CLOSED');
      let transferred: unknown;
      let taken: AppleCyclingTelemetryProjection | undefined;
      try {
        transferred = await options.input.take(input);
        taken = projection(transferred);
        let current: ApplePhysicalCanaryBindingReceipt | undefined;
        try {
          current = await options.binding.read(taken.bindingId);
        } catch {
          fail('CYCLING_CURRENT_BINDING_UNAVAILABLE');
        }
        if (current === undefined) fail('CYCLING_CURRENT_BINDING_MISSING');
        if (options.bindingSource === 'formal') {
          const formal = assertAppleFormalWatchBindingReceipt(current);
          if (formal.status !== 'active') fail('CYCLING_FORMAL_BINDING_REVOKED');
        } else if (current.kind !== 't02.apple.physical-canary-binding.v1') fail('CYCLING_BINDING_SOURCE_MISMATCH');
        const observedNow = now();
        if (!Number.isSafeInteger(observedNow)) fail('CYCLING_CLOCK_INVALID');
        assertCurrentBinding(taken, current, observedNow, maximumAge);
        const delivered = ack(await options.consumer.deliver(Object.freeze({
          currentBinding: current,
          format: FORMAT,
          channels: REQUIRED_CHANNELS,
          payload: taken.payload,
          payloadSha256: taken.payloadSha256,
          iphoneObservedAt: taken.iphone.observedAt,
          watchObservedAt: taken.watch.observedAt,
        })), taken.payloadSha256);
        return receipt(taken, current, delivered);
      } finally {
        transferredPayload(transferred)?.fill(0);
        await options.input.release(input);
      }
    },
    close(): Promise<void> {
      if (closeFlight !== undefined) return closeFlight;
      closed = true;
      closeFlight = Promise.resolve();
      return closeFlight;
    },
  });
}

export const APPLE_CYCLING_TELEMETRY_REQUIRED_CHANNELS = REQUIRED_CHANNELS;
