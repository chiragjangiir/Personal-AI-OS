import { createRealtimePublicOperationReceipts } from '../../../services/platform-data/src/realtime-public-operation-receipts.ts';
/**
 * Windows/T15 V2-only composition seam.
 *
 * This module is intentionally an internal composition boundary.  It creates
 * the PostgreSQL-backed T02 repository and wires explicitly supplied T11B,
 * T03, T04, T01, Public, Cloud/transport, and E2EE ports.  It does not define
 * a wire schema, mint an identity, read ambient host configuration, or bind a listener until
 * every declared production readiness probe is true.
 */

import {
  closePostgresPool,
  createPostgresPool,
  type PostgresPoolOptions,
} from '../../../services/platform-data/src/postgres-pool.ts';
import type {
  RealtimePublicControlT02OwnerBundle,
  RealtimePublicControlT02HandoffOutputFencePort,
  RealtimePublicControlT02OwnerBundleInput,
} from '../../../services/platform-data/src/realtime-public-control-t02-owner-bundle.ts';
import { createRealtimeAuthorityRepository } from '../../../services/platform-data/src/realtime-authority-repository.ts';
import {
  createApplePhysicalCanaryBindingPostgres,
  type ApplePhysicalCanaryBindingPostgresPort,
} from '../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts';
import { createProductionRealtimeCanonicalDeviceIdentityIssuer } from '../../../services/platform-data/src/realtime-canonical-device-issuer.ts';
import {
  createRealtimeExternalEffectCoordinator,
  type RealtimeExternalEffectCoordinatorPort,
  type RealtimeExternalEffectExecutor,
} from '../../../services/platform-data/src/realtime-external-effect-coordinator.ts';
import {
  createRealtimeCredentialFence,
  type CredentialFencePort,
  type CredentialFenceTuple,
} from '../../../services/platform-data/src/realtime-credential-fence.ts';
import {
  createProductionAuthorityFactory,
  type ProductionAuthorityFactoryOptions,
  type ProductionAuthorityFactoryResult,
} from '../../../services/realtime-core/src/production-authority-factory.ts';
import type {
  AcceptedUserActivity,
  CurrentBindingLookup,
  OpaqueCanonicalRef,
  StopRequest,
} from '../../../services/realtime-core/src/types.ts';
import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
} from '../../../services/realtime-core/src/types.ts';
import {
  createRealtimePublicControlController,
  createRealtimeSchemaRegistry,
  type RealtimePublicControlBearerPort,
  type RealtimePublicControlController,
  type RealtimePublicControlEdgePort,
  type RealtimeSchemaRegistry,
} from './realtime-public-control-controller.ts';
import {
  createRealtimePublicControlRuntime,
  type RealtimePublicControlRuntimeOptions,
  type RealtimeCredentialFenceAdmissionPort,
  type RealtimeCredentialFenceTuple,
  type RealtimeE2eeCiphertextResolverPort,
  type RealtimeGovernancePort,
  type RealtimeBootstrapConnectedInput,
  type RealtimeKeyResolverPort,
  type RealtimeBootstrapConnectedPort,
  type RealtimeDeviceCredentialPort,
} from './realtime-public-control-runtime.ts';
import {
  createRealtimePublicControlT11bT02Adapter,
  type RealtimePublicControlT11bT02Adapter,
  type T11bCanonicalIssuerReadinessPort,
  type T11bCloudProjectionPort,
  type T11bCurrentBindingPort,
  type T11bHandoffOutputFencePort,
  type T11bMediaStopIntent,
  type T11bOwnerContextPort,
  type T11bT02ExternalEffectCoordinatorPort,
  type T11bT03GovernancePort,
} from './realtime-public-control-t11b-t02-adapter.ts';
import {
  createRealtimePublicControlTerminalCodec,
} from './realtime-public-control-terminal-codec.ts';
import type {
  LiveKitCloudParticipantPort,
} from './livekit-cloud-participant.ts';
import type {
  LiveKitCloudTokenSignerPort,
  SecretResolverPort,
} from './livekit-cloud-token-signer.ts';
import {
  startV2GatewayLoopback,
  type GatewayRuntimeConfig,
  type V2GatewayLoopbackHandle,
  type V2GatewayLoopbackStartOptions,
} from './main.ts';
import type { DeviceSessionAdapter } from './device-session-adapter.ts';
import {
  createRealtimePublicControlAppleCyclingTelemetry,
  type AppleCyclingTelemetryInputPort,
  type RayneoCyclingTelemetryConsumerPort,
  type RealtimePublicControlAppleCyclingTelemetry,
} from './realtime-public-control-apple-cycling-telemetry.ts';
import {
  createRealtimeAcceptedUserActivityProduction,
  type RealtimeAcceptedUserActivityProduction,
  type RealtimeAcceptedUserActivityProductionOptions,
} from './realtime-accepted-user-activity-production.ts';
import type { T04ProductionOwner } from './realtime-public-control-t04-owner.ts';

const LOOPBACK_HOST = '127.0.0.1' as const;
const LOOPBACK_PORT = 8787 as const;
type BorrowedPostgresPool = ReturnType<typeof createPostgresPool>;

/** A readiness probe is owner metadata, not an identity or canonical ref. */
export interface V2CompositionReadinessInput {
  readonly owner: string;
  readonly isReady: () => boolean;
  readonly reason?: string;
  readonly close?: () => void | Promise<void>;
}

/** The pool factory falls back to ambient host configuration for omitted values; all fields
 * below are therefore mandatory at this composition boundary. */
export interface ExplicitPostgresPoolOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
}

export interface V2CompositionReadinessStatus {
  readonly name: string;
  readonly owner: string;
  readonly ready: boolean;
  readonly reason?: string;
}

export interface V2CompositionReadinessSnapshot {
  readonly ready: boolean;
  readonly statuses: readonly V2CompositionReadinessStatus[];
}

export interface V2GatewayProductionPorts {
  readonly postgres: V2CompositionReadinessInput;
  readonly canonicalIssuer: V2CompositionReadinessInput;
  readonly ownerContext: V2CompositionReadinessInput;
  /** T04 final-transcript resolver readiness; no resolver is invented here. */
  readonly finalTranscript: V2CompositionReadinessInput;
  readonly governance: V2CompositionReadinessInput;
  readonly edge: V2CompositionReadinessInput;
  readonly bearer: V2CompositionReadinessInput;
  readonly cloud: V2CompositionReadinessInput;
  readonly externalEffects: V2CompositionReadinessInput;
  readonly terminalCodec: V2CompositionReadinessInput;
  /** Reserved for older callers; public handoff is retired and this probe is not used. */
  readonly handoffTerminalCodec?: V2CompositionReadinessInput;
  readonly e2ee: V2CompositionReadinessInput;
  readonly e2eeCiphertext: V2CompositionReadinessInput;
  readonly secretResolver: V2CompositionReadinessInput;
  readonly tokenSigner: V2CompositionReadinessInput;
  readonly participant: V2CompositionReadinessInput;
}

export type V2T11bOwnerPorts = Omit<ProductionAuthorityFactoryOptions, 'repository'>;

/** Single connected-owner aggregate: native T04 control remains authoritative beside the selected execution hook.
 *  Every port member is forwarded or merged here; `BootstrapMembersHandled` fails typecheck for an unhandled new member. */
export function createProductionBootstrapConnectedOwner(t04Owner:T04ProductionOwner|undefined, assistant:RealtimeBootstrapConnectedPort|undefined):RealtimeBootstrapConnectedPort {
  return Object.freeze({ownsClose:false,
    ...(assistant?.assertBootstrapRequest === undefined ? {} : {assertBootstrapRequest:(request:Record<string,unknown>)=>assistant.assertBootstrapRequest!(request)}),
    ...(assistant?.centralTextTransport === undefined ? {} : {centralTextTransport:assistant.centralTextTransport}),
    ...(assistant?.centralTextTransportForDevice === undefined ? {} : {centralTextTransportForDevice:assistant.centralTextTransportForDevice}),
    // The call owner's lost-call deadline, which credential refresh advertises as call_rejoin.
    ...(assistant?.callRejoinForDevice === undefined ? {} : {callRejoinForDevice:assistant.callRejoinForDevice}),
    onBootstrapConnected:async(input:RealtimeBootstrapConnectedInput)=>{
      if(t04Owner!==undefined)await t04Owner.onBootstrapConnected(input);
      await assistant?.onBootstrapConnected?.(input);
    },
    ...(assistant?.close === undefined ? {} : {close:()=>assistant.close!()}),
  });
}
// `bootstrapConnected` is not forwarded: this composition requires the assistant's onBootstrapConnected.
type BootstrapMembersHandled<Unhandled extends never> = Unhandled;
export type ProductionBootstrapMembersHandled = BootstrapMembersHandled<Exclude<keyof RealtimeBootstrapConnectedPort,
  'assertBootstrapRequest'|'centralTextTransport'|'centralTextTransportForDevice'|'callRejoinForDevice'|'onBootstrapConnected'|'bootstrapConnected'|'close'|'ownsClose'>>;

interface RealtimePublicControlPgCompositionCommonOptions {
  /** This V2 composition is enabled-only; disabling it is a configuration error. */
  readonly enabled: boolean;
  readonly controlHost: typeof LOOPBACK_HOST;
  readonly readiness: V2GatewayProductionPorts;
  readonly ownerContext: T11bOwnerContextPort;
  readonly governance: RealtimeGovernancePort & T11bT03GovernancePort;
  readonly edge: RealtimePublicControlEdgePort;
  readonly bearer: RealtimePublicControlBearerPort;
  readonly canonicalApiOrigin?: string;
  readonly glassesEnrollment?: import('./realtime-public-control-controller.ts').RealtimePublicControlControllerOptions['glassesEnrollment'];
  readonly capabilityUpgrade?: import('./realtime-public-control-controller.ts').RealtimePublicControlControllerOptions['capabilityUpgrade'];
  readonly ownerMac?: import('./realtime-public-control-controller.ts').RealtimePublicControlControllerOptions['ownerMac'];
  readonly appearanceImages?: import('./realtime-public-control-controller.ts').RealtimePublicControlControllerOptions['appearanceImages'];
  readonly place?: import('./realtime-public-control-controller.ts').RealtimePublicControlControllerOptions['place'];
  readonly watch?: import('./watch-http.ts').WatchHttpOwner;
  readonly viduRetrieval?:import('./vidu-call-session.ts').ViduRetrieval;
  readonly cloud: T11bCloudProjectionPort & { readonly secretResolver: SecretResolverPort };
  readonly e2ee: RealtimeKeyResolverPort;
  readonly e2eeCiphertext: RealtimeE2eeCiphertextResolverPort;
  readonly tokenSigner: LiveKitCloudTokenSignerPort;
  readonly participant: LiveKitCloudParticipantPort;
  readonly participantForDevice?: (deviceId: string) => LiveKitCloudParticipantPort | undefined;
  /** Borrowed mode requires its owner-held runtime admission seam. */
  readonly credentialFenceAdmission?: RealtimeCredentialFenceAdmissionPort;
  readonly schemaRegistry?: RealtimeSchemaRegistry;
  readonly maxBodyBytes?: number;
  readonly now?: () => number;
  readonly gateway: Readonly<{
    readonly config: GatewayRuntimeConfig;
    readonly adapter: DeviceSessionAdapter;
  }>;
  /** Optional one-shot Apple input and RayNeo delivery seam. It retains no telemetry payload. */
  readonly appleCycling?: Readonly<{
    readonly bindingSource?: "formal" | "canary";
    readonly input: AppleCyclingTelemetryInputPort<unknown>;
    readonly consumer: RayneoCyclingTelemetryConsumerPort;
    readonly maxObservationAgeMs?: number;
  }>;
  /**
   * Optional production T04 user-action source. The composition supplies the
   * authoritative service sink; callers can neither replace nor bypass it.
   */
  readonly acceptedUserActivity?: Omit<
    RealtimeAcceptedUserActivityProductionOptions,
    'sink' | 'equality'
  >;
  /** One real T04 owner is the persistent production source/hook. */
  readonly t04Owner?: T04ProductionOwner;
  /** Same-room assistant hook; the runtime remains the only bootstrap owner. */
  readonly assistantBridge?: RealtimeBootstrapConnectedPort;
  /** Every production bootstrap binds the paired device's E2EE recipient credential. */
  readonly deviceCredential: RealtimeDeviceCredentialPort;
  /** Borrowed same-pool Apple authority used by persistent owner preflight. */
  readonly applePhysicalBinding?: ApplePhysicalCanaryBindingPostgresPort;
  /** Formal mutation capability built with the designated T03 primary authority. */
  readonly watchBinding?: NonNullable<RealtimePublicControlRuntimeOptions['watchBinding']>;
  /** Source/unit seam; production defaults to the fixed main.ts starter. */
  readonly startGateway?: (
    options: V2GatewayLoopbackStartOptions,
  ) => Promise<V2GatewayLoopbackHandle>;
}

export interface RealtimePublicControlPgInternalOwnedOptions
  extends RealtimePublicControlPgCompositionCommonOptions {
  readonly t02AuthorityMode: 'internal-owned';
  readonly postgres: ExplicitPostgresPoolOptions;
  readonly ownerPorts: V2T11bOwnerPorts;
  readonly issuerReadiness: T11bCanonicalIssuerReadinessPort;
  /** T02 provider access is mandatory; the durable coordinator is composed here from PG. */
  readonly externalEffectExecutor: RealtimeExternalEffectExecutor;
  readonly handoffOutputFence?: T11bHandoffOutputFencePort;
  readonly pool?: never;
  readonly postgresReadiness?: never;
  readonly prebuiltT02Bundle?: never;
}

export interface RealtimePublicControlPgPrebuiltBorrowedOptions
  extends RealtimePublicControlPgCompositionCommonOptions {
  readonly t02AuthorityMode: 'prebuilt-borrowed';
  readonly pool: BorrowedPostgresPool;
  readonly postgresReadiness: RealtimePublicControlT02OwnerBundleInput['postgresReadiness'];
  readonly prebuiltT02Bundle: RealtimePublicControlT02OwnerBundle;
  /** Handoff authority/fence and external effects are owned by the borrowed bundle. */
  readonly externalEffectExecutor?: never;
  readonly handoffOutputFence?: never;
  readonly postgres?: never;
  readonly ownerPorts?: never;
  readonly issuerReadiness?: never;
}

export type RealtimePublicControlPgCompositionOptions =
  | RealtimePublicControlPgInternalOwnedOptions
  | RealtimePublicControlPgPrebuiltBorrowedOptions;

/**
 * Grant187 still freezes one caller whose composition input is an Omit over
 * the former monolithic options shape.  This overload keeps that caller
 * type-checkable until its already-approved migration, while runtime mode
 * validation continues to reject every mixed prebuilt/internal object before
 * any resource is created.
 */
type TransitionalInternalOwnedOptions = RealtimePublicControlPgCompositionCommonOptions & Readonly<{
  readonly t02AuthorityMode: 'internal-owned' | 'prebuilt-borrowed';
  readonly postgres: ExplicitPostgresPoolOptions;
  readonly ownerPorts?: V2T11bOwnerPorts;
  readonly issuerReadiness?: T11bCanonicalIssuerReadinessPort;
  readonly externalEffectExecutor?: RealtimeExternalEffectExecutor;
  readonly handoffOutputFence?: T11bHandoffOutputFencePort;
}>;

export interface RealtimePublicControlPgComposition {
  readonly controller: RealtimePublicControlController;
  readonly applePhysicalBinding: ApplePhysicalCanaryBindingPostgresPort;
  readonly appleCyclingTelemetry?: RealtimePublicControlAppleCyclingTelemetry<unknown>;
  readonly t04Owner?: T04ProductionOwner;
  readonly bindAcceptedUserActivitySource?: () => void;
  readonly readiness: () => V2CompositionReadinessSnapshot;
  readonly preflight: () => Promise<void>;
  readonly start: () => Promise<V2GatewayLoopbackHandle>;
  readonly close: () => Promise<void>;
}

function fail(code: string): never {
  throw new Error(code);
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function method(value: unknown, name: string, code: string): void {
  if (value === null || typeof value !== 'object' || typeof (value as Record<string, unknown>)[name] !== 'function') {
    fail(code);
  }
}

type JsonRecord = Record<string, unknown>;

const MEDIA_CLEANUP_STAGES = new Set([
  'tracks_unpublished',
  'participant_disconnected',
  'credential_revoked',
  'closure_verified',
] as const);
const STOP_REASONS = new Set([
  'user_stop',
  'lease_expired',
  'permission_revoked',
  'disconnect',
  'provider_failure',
  'cancelled',
] as const);
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,37}$/u;

function strictSnapshot(value: unknown, code: string, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) fail(code);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string') || names.length !== value.length + 1) {
      fail(code);
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail(code);
      output.push(strictSnapshot(descriptor.value, code, ancestors));
    }
    ancestors.delete(value);
    return Object.freeze(output);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const names = Object.getOwnPropertyNames(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
      names.some((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true;
      })) {
    fail(code);
  }
  const output: JsonRecord = Object.create(null) as JsonRecord;
  for (const name of names.sort()) {
    Object.defineProperty(output, name, {
      configurable: true,
      enumerable: true,
      value: strictSnapshot((value as JsonRecord)[name], code, ancestors),
      writable: true,
    });
  }
  ancestors.delete(value);
  return Object.freeze(output);
}

function strictRecord(value: unknown, code: string): JsonRecord {
  const snapshot = strictSnapshot(value, code);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail(code);
  return snapshot as JsonRecord;
}

function strictString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

function strictOpaqueRef(value: unknown, code: string): OpaqueCanonicalRef {
  const snapshot = strictSnapshot(value, code);
  if (typeof snapshot === 'string') return snapshot;
  if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    return snapshot as Readonly<Record<string, unknown>>;
  }
  fail(code);
}

function stable(value: unknown, code = 'V2_EXTERNAL_EFFECT_VALUE_INVALID'): string {
  const snapshot = strictSnapshot(value, code);
  const encoded = JSON.stringify(snapshot);
  if (encoded === undefined || encoded.length === 0 || encoded.length > 262_144) fail(code);
  return encoded;
}

function same(left: unknown, right: unknown, code = 'V2_EXTERNAL_EFFECT_BINDING_INVALID'): boolean {
  return stable(left, code) === stable(right, code);
}

function positiveDecimal(value: unknown, code: string): string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) fail(code);
  return value;
}

function ownerScalar<T>(action: () => T, code: string): T {
  try {
    return action();
  } catch {
    fail(code);
  }
}

function stopReason(value: unknown): StopRequest['reason'] {
  if (typeof value !== 'string' || !STOP_REASONS.has(value as StopRequest['reason'])) {
    fail('V2_EXTERNAL_EFFECT_REQUEST_REASON_INVALID');
  }
  return value as StopRequest['reason'];
}

function narrowStopRequest(value: unknown): StopRequest {
  const input = strictRecord(value, 'V2_EXTERNAL_EFFECT_REQUEST_INVALID');
  const allowed = new Set([
    'requestId', 'idempotencyKey', 'operation', 'realtimeSessionRef', 'continuityId',
    'deviceLeaseRef', 'deviceId', 'expectedConnectionEpoch', 'expectedLeaseVersion',
    'credentialGeneration', 'reason', 'occurredAt', 'governance',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail('V2_EXTERNAL_EFFECT_REQUEST_UNKNOWN_FIELD');
  for (const key of [
    'requestId', 'idempotencyKey', 'operation', 'realtimeSessionRef', 'continuityId',
    'deviceId', 'expectedConnectionEpoch', 'reason', 'occurredAt', 'governance',
  ]) {
    if (!Object.hasOwn(input, key)) fail('V2_EXTERNAL_EFFECT_REQUEST_FIELD_REQUIRED');
  }
  if (input.operation !== 'media_stop') fail('V2_EXTERNAL_EFFECT_REQUEST_OPERATION_INVALID');
  const expectedLeaseVersion = input.expectedLeaseVersion === undefined
    ? undefined
    : ownerScalar(
      () => assertDecimalCounter(positiveDecimal(input.expectedLeaseVersion, 'V2_EXTERNAL_EFFECT_LEASE_VERSION_INVALID')),
      'V2_EXTERNAL_EFFECT_LEASE_VERSION_INVALID',
    );
  const credentialGeneration = input.credentialGeneration === undefined
    ? undefined
    : ownerScalar(
      () => assertDecimalCounter(positiveDecimal(input.credentialGeneration, 'V2_EXTERNAL_EFFECT_CREDENTIAL_GENERATION_INVALID')),
      'V2_EXTERNAL_EFFECT_CREDENTIAL_GENERATION_INVALID',
    );
  const governance = strictRecord(input.governance, 'V2_EXTERNAL_EFFECT_GOVERNANCE_INVALID');
  return Object.freeze({
    requestId: strictString(input.requestId, 'V2_EXTERNAL_EFFECT_REQUEST_ID_INVALID'),
    idempotencyKey: strictString(input.idempotencyKey, 'V2_EXTERNAL_EFFECT_IDEMPOTENCY_KEY_INVALID'),
    operation: 'media_stop' as const,
    realtimeSessionRef: strictOpaqueRef(input.realtimeSessionRef, 'V2_EXTERNAL_EFFECT_SESSION_REF_INVALID'),
    continuityId: strictString(input.continuityId, 'V2_EXTERNAL_EFFECT_CONTINUITY_INVALID'),
    ...(input.deviceLeaseRef === undefined ? {} : {
      deviceLeaseRef: strictOpaqueRef(input.deviceLeaseRef, 'V2_EXTERNAL_EFFECT_LEASE_REF_INVALID'),
    }),
    deviceId: strictString(input.deviceId, 'V2_EXTERNAL_EFFECT_DEVICE_INVALID'),
    expectedConnectionEpoch: ownerScalar(
      () => assertDecimalConnectionEpoch(input.expectedConnectionEpoch),
      'V2_EXTERNAL_EFFECT_CONNECTION_EPOCH_INVALID',
    ),
    ...(expectedLeaseVersion === undefined ? {} : { expectedLeaseVersion }),
    ...(credentialGeneration === undefined ? {} : { credentialGeneration }),
    reason: stopReason(input.reason),
    occurredAt: ownerScalar(
      () => assertCanonicalTimestamp(input.occurredAt),
      'V2_EXTERNAL_EFFECT_TIMESTAMP_INVALID',
    ),
    governance,
  });
}

function narrowWireRequest(
  value: unknown,
  request: StopRequest,
  governance: JsonRecord,
  fingerprint: string,
): JsonRecord {
  const wire = strictRecord(value, 'V2_EXTERNAL_EFFECT_WIRE_REQUEST_INVALID');
  if (wire.operation !== 'media_stop') fail('V2_EXTERNAL_EFFECT_WIRE_OPERATION_INVALID');
  const requestId = strictString(wire.request_id, 'V2_EXTERNAL_EFFECT_WIRE_REQUEST_ID_INVALID');
  const context = strictRecord(wire.idempotency_context, 'V2_EXTERNAL_EFFECT_WIRE_IDEMPOTENCY_INVALID');
  const idempotencyKey = strictString(context.idempotency_key, 'V2_EXTERNAL_EFFECT_WIRE_IDEMPOTENCY_KEY_INVALID');
  if (requestId !== request.requestId || idempotencyKey !== request.idempotencyKey) {
    fail('V2_EXTERNAL_EFFECT_REQUEST_BINDING_INVALID');
  }
  const wireGovernance = strictRecord(wire.governance, 'V2_EXTERNAL_EFFECT_WIRE_GOVERNANCE_INVALID');
  if (!same(wireGovernance, governance) || !same(request.governance, governance)) {
    fail('V2_EXTERNAL_EFFECT_GOVERNANCE_BINDING_INVALID');
  }
  if (request.deviceLeaseRef === undefined) fail('V2_EXTERNAL_EFFECT_LEASE_REF_INVALID');
  const requiredBindings: readonly (readonly [string, unknown])[] = [
    ['realtime_session_ref', request.realtimeSessionRef],
    ['device_lease_ref', request.deviceLeaseRef],
    ['continuity_id', request.continuityId],
    ['connection_epoch', request.expectedConnectionEpoch],
    ['reason', request.reason],
  ];
  for (const [name, expected] of requiredBindings) {
    if (!Object.hasOwn(wire, name) || !same(wire[name], expected)) fail('V2_EXTERNAL_EFFECT_BINDING_INVALID');
  }
  if (Object.hasOwn(wire, 'device_id') && strictString(wire.device_id, 'V2_EXTERNAL_EFFECT_WIRE_DEVICE_INVALID') !== request.deviceId) {
    fail('V2_EXTERNAL_EFFECT_BINDING_INVALID');
  }
  // The media_stop wire carries no lease version: the T11b adapter fences with the current lease version it read.
  // A wire value, when present, must agree with that fence (same rule as the adapter).
  if (Object.hasOwn(wire, 'expected_lease_version') && (request.expectedLeaseVersion === undefined ||
      positiveDecimal(wire.expected_lease_version, 'V2_EXTERNAL_EFFECT_LEASE_VERSION_INVALID') !== request.expectedLeaseVersion)) {
    fail('V2_EXTERNAL_EFFECT_LEASE_VERSION_INVALID');
  }
  if (stable(wire, 'V2_EXTERNAL_EFFECT_WIRE_REQUEST_INVALID') !== fingerprint) {
    fail('V2_EXTERNAL_EFFECT_FINGERPRINT_INVALID');
  }
  return wire;
}

function narrowIntent(value: unknown): T11bMediaStopIntent {
  const input = strictRecord(value, 'V2_EXTERNAL_EFFECT_INTENT_INVALID');
  const keys = new Set(['wireRequest', 'request', 'governance', 'fingerprint']);
  if (Object.keys(input).some((key) => !keys.has(key)) ||
      [...keys].some((key) => !Object.hasOwn(input, key))) {
    fail('V2_EXTERNAL_EFFECT_INTENT_UNKNOWN_FIELD');
  }
  const fingerprint = strictString(input.fingerprint, 'V2_EXTERNAL_EFFECT_FINGERPRINT_INVALID');
  const request = narrowStopRequest(input.request);
  const governance = strictRecord(input.governance, 'V2_EXTERNAL_EFFECT_GOVERNANCE_INVALID');
  const wireRequest = narrowWireRequest(input.wireRequest, request, governance, fingerprint);
  return Object.freeze({ wireRequest, request, governance, fingerprint });
}

type T11bDurableMediaStopClaim = Awaited<ReturnType<T11bT02ExternalEffectCoordinatorPort['claim']>>;

function narrowClaim(value: unknown): T11bDurableMediaStopClaim {
  const claim = strictRecord(value, 'V2_EXTERNAL_EFFECT_CLAIM_INVALID');
  if (claim.disposition === 'claimed') {
    return Object.freeze({
      disposition: 'claimed' as const,
      claimId: strictString(claim.claimId, 'V2_EXTERNAL_EFFECT_CLAIM_ID_INVALID'),
    });
  }
  if (claim.disposition === 'replay') {
    return Object.freeze({
      disposition: 'replay' as const,
      result: strictRecord(claim.result, 'V2_EXTERNAL_EFFECT_REPLAY_INVALID'),
    });
  }
  if (claim.disposition === 'conflict' || claim.disposition === 'in_flight' || claim.disposition === 'indeterminate') {
    return Object.freeze({ disposition: claim.disposition });
  }
  fail('V2_EXTERNAL_EFFECT_CLAIM_INVALID');
}

function validateExternalEffectExecutor(value: unknown): RealtimeExternalEffectExecutor {
  const executor = objectValue(value, 'V2_EXTERNAL_EFFECT_EXECUTOR_REQUIRED');
  if (typeof executor.executeStage !== 'function' && typeof executor.executeMediaStage !== 'function') {
    fail('V2_EXTERNAL_EFFECT_EXECUTOR_STAGE_REQUIRED');
  }
  for (const name of ['executeStage', 'executeMediaStage', 'suppressAndClose', 'executeHandoffSuppression', 'close'] as const) {
    if (executor[name] !== undefined && typeof executor[name] !== 'function') {
      fail(`V2_EXTERNAL_EFFECT_EXECUTOR_${name.toUpperCase()}_INVALID`);
    }
  }
  return value as RealtimeExternalEffectExecutor;
}

/**
 * Adapt the broad T02 persistence port at the Windows boundary.  T02 owns
 * durable state and execution fencing; this wrapper only validates and
 * snapshots the restored intent before exposing the closed T11B shape.
 */
export function createT11bT02ExternalEffectCoordinatorPort(
  coordinator: RealtimeExternalEffectCoordinatorPort,
  options: Readonly<{
    readonly closeCoordinator?: boolean;
    readonly requireCredentialGeneration?: boolean;
  }> = {},
): T11bT02ExternalEffectCoordinatorPort {
  objectValue(coordinator, 'V2_EXTERNAL_EFFECT_COORDINATOR_REQUIRED');
  for (const name of ['claim', 'restore', 'executeStage', 'commit', 'release', 'close'] as const) {
    method(coordinator, name, `V2_EXTERNAL_EFFECT_COORDINATOR_${name.toUpperCase()}_REQUIRED`);
  }
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeFlight ??= Promise.resolve().then(() => coordinator.close());
    return closeFlight;
  };
  const port: T11bT02ExternalEffectCoordinatorPort = {
    claim: async (input: Parameters<T11bT02ExternalEffectCoordinatorPort['claim']>[0]) => {
      const intent = narrowIntent(input?.intent);
      if (options.requireCredentialGeneration === true && intent.request.credentialGeneration === undefined) {
        fail('V2_EXTERNAL_EFFECT_CREDENTIAL_GENERATION_REQUIRED');
      }
      const idempotencyContext = strictRecord(input?.idempotencyContext, 'V2_EXTERNAL_EFFECT_IDEMPOTENCY_INVALID');
      const fingerprint = strictString(input?.fingerprint, 'V2_EXTERNAL_EFFECT_FINGERPRINT_INVALID');
      if (fingerprint !== intent.fingerprint ||
          strictString(idempotencyContext.idempotency_key, 'V2_EXTERNAL_EFFECT_IDEMPOTENCY_KEY_INVALID') !== intent.request.idempotencyKey) {
        fail('V2_EXTERNAL_EFFECT_BINDING_INVALID');
      }
      const claimed: unknown = await coordinator.claim({ idempotencyContext, fingerprint, intent });
      return narrowClaim(claimed);
    },
    restore: async (input: Parameters<T11bT02ExternalEffectCoordinatorPort['restore']>[0]) => {
      const claimId = strictString(input?.claimId, 'V2_EXTERNAL_EFFECT_CLAIM_ID_INVALID');
      const restored: unknown = await coordinator.restore({ claimId });
      if (restored === undefined) return undefined;
      const intent = narrowIntent(restored);
      if (options.requireCredentialGeneration === true && intent.request.credentialGeneration === undefined) {
        fail('V2_EXTERNAL_EFFECT_CREDENTIAL_GENERATION_REQUIRED');
      }
      return intent;
    },
    executeStage: async (input: Parameters<T11bT02ExternalEffectCoordinatorPort['executeStage']>[0]) => {
      const claimId = strictString(input?.claimId, 'V2_EXTERNAL_EFFECT_CLAIM_ID_INVALID');
      if (!MEDIA_CLEANUP_STAGES.has(input.stage)) fail('V2_EXTERNAL_EFFECT_STAGE_INVALID');
      const intent = narrowIntent(input?.intent);
      await coordinator.executeStage({ claimId, stage: input.stage, intent });
    },
    commit: async (input: Parameters<T11bT02ExternalEffectCoordinatorPort['commit']>[0]) => {
      const claimId = strictString(input?.claimId, 'V2_EXTERNAL_EFFECT_CLAIM_ID_INVALID');
      const fingerprint = strictString(input?.fingerprint, 'V2_EXTERNAL_EFFECT_FINGERPRINT_INVALID');
      const result = strictRecord(input?.result, 'V2_EXTERNAL_EFFECT_RESULT_INVALID');
      await coordinator.commit({ claimId, fingerprint, result });
    },
    release: async (input: Parameters<T11bT02ExternalEffectCoordinatorPort['release']>[0]) => {
      const claimId = strictString(input?.claimId, 'V2_EXTERNAL_EFFECT_CLAIM_ID_INVALID');
      const fingerprint = strictString(input?.fingerprint, 'V2_EXTERNAL_EFFECT_FINGERPRINT_INVALID');
      await coordinator.release({ claimId, fingerprint });
    },
    ...(options.closeCoordinator === false ? {} : { close }),
  };
  return Object.freeze(port);
}

function validatePostgresOptions(value: ExplicitPostgresPoolOptions): PostgresPoolOptions {
  objectValue(value, 'V2_PG_OPTIONS_REQUIRED');
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === undefined) fail(`V2_PG_OPTION_UNDEFINED:${key}`);
  }
  for (const key of ['host', 'database', 'user', 'password'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) fail(`V2_PG_${key.toUpperCase()}_REQUIRED`);
  }
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) fail('V2_PG_PORT_INVALID');
  return Object.freeze({ ...value });
}

type T02AuthorityPlan = Readonly<{
  readonly mode: 'internal-owned';
  readonly postgres: PostgresPoolOptions;
  readonly ownerPorts: V2T11bOwnerPorts;
  readonly issuerReadiness: T11bCanonicalIssuerReadinessPort;
}> | Readonly<{
  readonly mode: 'prebuilt-borrowed';
  readonly pool: BorrowedPostgresPool;
  readonly bundle: RealtimePublicControlT02OwnerBundle;
}>;

function assertReadinessDescriptor(value: unknown, code: string): asserts value is V2CompositionReadinessInput {
  const descriptor = objectValue(value, code);
  if (typeof descriptor.owner !== 'string' || descriptor.owner.trim().length === 0 ||
      typeof descriptor.isReady !== 'function') fail(code);
}

function assertPrebuiltBundle(value: unknown): asserts value is RealtimePublicControlT02OwnerBundle {
  const bundle = objectValue(value, 'V2_T02_PREBUILT_BUNDLE_REQUIRED');
  const authority = objectValue(bundle.authority, 'V2_T02_PREBUILT_AUTHORITY_REQUIRED');
  const dataPorts = objectValue(bundle.dataPorts, 'V2_T02_PREBUILT_DATA_PORTS_REQUIRED');
  for (const [candidate, name, methods] of [
    [authority, 'AUTHORITY', ['assertReady', 'close', 'readCurrentBinding']],
    [bundle.service, 'SERVICE', ['readCurrentBinding']],
    [bundle.projection, 'PROJECTION', [
      'bootstrap', 'connectedRefresh', 'fullyDisconnectedRefresh', 'mediaStop', 'endContinuity',
    ]],
    [bundle.externalEffectCoordinator, 'EXTERNAL_EFFECT_COORDINATOR', [
      'claim', 'suppressAndClose', 'commit', 'release', 'close',
    ]],
    [dataPorts.identity, 'IDENTITY', [
      'createContinuityId', 'assertRepositoryIssuedRef', 'createSessionRef', 'createDeviceLeaseRef',
      'createTransportAlias', 'createConnectionId',
    ]],
    [bundle, 'BUNDLE', ['readCurrentBinding', 'assertReady', 'close']],
  ] as const) {
    for (const required of methods) method(candidate, required, `V2_T02_PREBUILT_${name}_${required.toUpperCase()}_REQUIRED`);
  }
  assertReadinessDescriptor(bundle.issuerReadiness, 'V2_T02_PREBUILT_ISSUER_READINESS_REQUIRED');
  if (bundle.authority !== authority || bundle.service !== authority.service ||
      bundle.projection !== authority.projection || bundle.readCurrentBinding !== authority.readCurrentBinding ||
      bundle.readiness !== authority.readiness || bundle.assertReady !== authority.assertReady ||
      bundle.close !== authority.close) {
    fail('V2_T02_PREBUILT_AUTHORITY_IDENTITY_DRIFT');
  }
}

function validateT02AuthorityPlan(
  options: RealtimePublicControlPgCompositionOptions | TransitionalInternalOwnedOptions,
): T02AuthorityPlan {
  const raw = objectValue(options, 'V2_COMPOSITION_OPTIONS_REQUIRED');
  if (raw.t02AuthorityMode === 'internal-owned') {
    const internal = options as RealtimePublicControlPgInternalOwnedOptions;
    if (['pool', 'postgresReadiness', 'prebuiltT02Bundle'].some((key) => Object.hasOwn(raw, key))) {
      fail('V2_T02_AUTHORITY_MODE_MIXED');
    }
    objectValue(internal.ownerPorts, 'V2_T11B_OWNER_PORTS_REQUIRED');
    if (Object.hasOwn(internal.ownerPorts as object, 'repository')) {
      fail('V2_T11B_REPOSITORY_MUST_BE_COMPOSED_FROM_PG');
    }
    method(internal.issuerReadiness, 'assertReady', 'V2_ISSUER_READINESS_REQUIRED');
    return Object.freeze({
      mode: 'internal-owned' as const,
      postgres: validatePostgresOptions(internal.postgres),
      ownerPorts: internal.ownerPorts,
      issuerReadiness: internal.issuerReadiness,
    });
  }
  if (raw.t02AuthorityMode === 'prebuilt-borrowed') {
    const prebuilt = options as RealtimePublicControlPgPrebuiltBorrowedOptions;
    if (['postgres', 'ownerPorts', 'issuerReadiness', 'externalEffectExecutor', 'handoffOutputFence']
      .some((key) => Object.hasOwn(raw, key))) {
      fail('V2_T02_AUTHORITY_MODE_MIXED');
    }
    const pool = objectValue(prebuilt.pool, 'V2_T02_BORROWED_POOL_REQUIRED');
    method(pool, 'connect', 'V2_T02_BORROWED_POOL_REQUIRED');
    method(pool, 'query', 'V2_T02_BORROWED_POOL_REQUIRED');
    assertReadinessDescriptor(prebuilt.postgresReadiness, 'V2_T02_POSTGRES_READINESS_REQUIRED');
    if ((prebuilt.postgresReadiness as { readonly environment?: unknown }).environment !== 'production') {
      fail('V2_T02_POSTGRES_READINESS_NON_PRODUCTION');
    }
    assertPrebuiltBundle(prebuilt.prebuiltT02Bundle);
    if (prebuilt.readiness.postgres !== prebuilt.postgresReadiness ||
        prebuilt.readiness.canonicalIssuer !== prebuilt.prebuiltT02Bundle.issuerReadiness) {
      fail('V2_T02_PREBUILT_READINESS_DRIFT');
    }
    return Object.freeze({
      mode: 'prebuilt-borrowed' as const,
      pool: prebuilt.pool,
      bundle: prebuilt.prebuiltT02Bundle,
    });
  }
  fail('V2_T02_AUTHORITY_MODE_REQUIRED');
}

function descriptorStatus(
  name: string,
  descriptor: V2CompositionReadinessInput,
): V2CompositionReadinessStatus {
  let ready = false;
  let reason = descriptor.reason;
  try {
    ready = descriptor.isReady() === true;
    if (!ready && reason === undefined) reason = 'OWNER_NOT_READY';
  } catch {
    reason = 'OWNER_READINESS_ERROR';
  }
  return Object.freeze({ name, owner: descriptor.owner, ready, ...(reason === undefined ? {} : { reason }) });
}

async function closePort(value: unknown): Promise<void> {
  const close = value !== null && typeof value === 'object'
    ? Reflect.get(value, 'close')
    : undefined;
  if (close === undefined) return;
  if (typeof close !== 'function') throw new Error('V2_CLOSE_HOOK_INVALID');
  await Reflect.apply(close, value, []);
}

export function createRuntimeCredentialFenceAdmission(
  fence: CredentialFencePort,
): RealtimeCredentialFenceAdmissionPort {
  const tuple = (value: RealtimeCredentialFenceTuple): CredentialFenceTuple => Object.freeze({
    realtimeSessionRef: value.sessionRef as unknown as CredentialFenceTuple['realtimeSessionRef'],
    deviceLeaseRef: value.leaseRef as unknown as CredentialFenceTuple['deviceLeaseRef'],
    continuityId: value.continuityId,
    connectionEpoch: value.connectionEpoch,
    credentialGeneration: value.credentialGeneration,
  });
  return Object.freeze({
    withAdmission: <T>(value: RealtimeCredentialFenceTuple, callback: () => Promise<T>): Promise<T> =>
      fence.withAdmission(tuple(value), callback),
    verifyReconnect: async (value: RealtimeCredentialFenceTuple): Promise<void> => {
      const snapshot = await fence.verify(tuple(value));
      if (snapshot.active === true) throw new Error('CREDENTIAL_FENCE_ACTIVE');
    },
    // The coordinator owns the shared pool-backed fence and closes it once.
    ownsClose: false as const,
  });
}

function currentBindingPort(
  readCurrentBinding: ProductionAuthorityFactoryResult['readCurrentBinding'],
): T11bCurrentBindingPort {
  return Object.freeze({
    resolve: async (input: Parameters<T11bCurrentBindingPort['resolve']>[0]) => {
      const request = input.request;
      const hasRef = request.realtime_session_ref !== undefined;
      const hasContinuity = request.continuity_id !== undefined;
      if (!hasRef && !hasContinuity) fail('V2_CURRENT_BINDING_LOOKUP_INVALID');
      // The wire request commonly carries both bindings.  The closed T11B
      // lookup still uses exactly one key; prefer the exact canonical ref and
      // verify the scalar continuity projection below.
      const lookup: CurrentBindingLookup = hasRef
        ? { realtimeSessionRef: request.realtime_session_ref as OpaqueCanonicalRef }
        : { continuityId: String(request.continuity_id) };
      const projection = await readCurrentBinding(lookup);
      if (projection === undefined) return undefined;
      if (hasContinuity && projection.session.continuityId !== String(request.continuity_id)) {
        fail('V2_CURRENT_BINDING_CONTINUITY_MISMATCH');
      }
      if (projection.session.binding.deviceId !== input.owner.deviceId ||
          projection.lease.deviceId !== input.owner.deviceId) {
        fail('V2_CURRENT_BINDING_OWNER_MISMATCH');
      }
      return Object.freeze({
        binding: projection.session.binding,
        continuityExpiresAt: projection.session.continuityExpiresAt,
        leaseVersion: projection.lease.leaseVersion,
      });
    },
  });
}

function validateT04Owner(value: unknown): asserts value is T04ProductionOwner {
  const owner = objectValue(value, 'V2_T04_OWNER_REQUIRED');
  const activityAcceptance = objectValue(owner.activityAcceptance, 'V2_T04_ACTIVITY_ACCEPTANCE_REQUIRED');
  method(activityAcceptance.port, 'verify', 'V2_T04_ACTIVITY_ACCEPTANCE_VERIFY_REQUIRED');
  const readiness = objectValue(activityAcceptance.readiness, 'V2_T04_ACTIVITY_ACCEPTANCE_READINESS_REQUIRED');
  if (readiness.environment !== 'production' || typeof readiness.owner !== 'string' ||
      readiness.owner.trim().length === 0 || typeof readiness.isReady !== 'function') {
    fail('V2_T04_ACTIVITY_ACCEPTANCE_READINESS_INVALID');
  }
  const source = objectValue(owner.source, 'V2_T04_OWNER_SOURCE_REQUIRED');
  if (source.environment !== 'production' || typeof source.owner !== 'string' ||
      source.owner.trim().length === 0 || typeof source.isReady !== 'function' ||
      typeof source.subscribe !== 'function') {
    fail('V2_T04_OWNER_SOURCE_INVALID');
  }
  method(owner, 'onBootstrapConnected', 'V2_T04_OWNER_HOOK_REQUIRED');
  method(owner, 'preflight', 'V2_T04_OWNER_PREFLIGHT_REQUIRED');
  method(owner, 'close', 'V2_T04_OWNER_CLOSE_REQUIRED');
}

export function createRealtimePublicControlPgComposition(
  options: RealtimePublicControlPgCompositionOptions,
): RealtimePublicControlPgComposition;
export function createRealtimePublicControlPgComposition(
  options: TransitionalInternalOwnedOptions,
): RealtimePublicControlPgComposition;
export function createRealtimePublicControlPgComposition(
  options: RealtimePublicControlPgCompositionOptions | TransitionalInternalOwnedOptions,
): RealtimePublicControlPgComposition {
  objectValue(options, 'V2_COMPOSITION_OPTIONS_REQUIRED');
  if (options.enabled !== true) fail('V2_COMPOSITION_MUST_BE_ENABLED');
  if (options.controlHost !== LOOPBACK_HOST) fail('V2_COMPOSITION_CONTROL_HOST_INVALID');
  if (options.t04Owner !== undefined && options.acceptedUserActivity !== undefined) {
    fail('V2_ACCEPTED_USER_ACTIVITY_SOURCES_CONFLICT');
  }
  if (options.t04Owner !== undefined) validateT04Owner(options.t04Owner);
  if (Object.hasOwn(options as object, 'handoffAuthority')) {
    fail('V2_HANDOFF_AUTHORITY_INJECTION_FORBIDDEN');
  }
  if (Object.hasOwn(options as object, 'terminalCodec')) {
    fail('V2_TERMINAL_CODEC_INJECTION_FORBIDDEN');
  }
  if (Object.hasOwn(options as object, 'handoffTerminalCodec')) {
    fail('V2_HANDOFF_TERMINAL_CODEC_INJECTION_FORBIDDEN');
  }
  const t02Plan = validateT02AuthorityPlan(options);
  if (t02Plan.mode === 'prebuilt-borrowed' && options.credentialFenceAdmission === undefined) fail('V2_CREDENTIAL_FENCE_ADMISSION_REQUIRED');
  const externalEffectExecutor = t02Plan.mode === 'internal-owned'
    ? validateExternalEffectExecutor(options.externalEffectExecutor)
    : undefined;
  objectValue(options.readiness, 'V2_READINESS_REQUIRED');
  method(options.deviceCredential, 'resolve', 'V2_DEVICE_CREDENTIAL_REQUIRED');

  method(options.gateway?.adapter, 'close', 'V2_GATEWAY_ADAPTER_REQUIRED');
  method(options.ownerContext, 'resolve', 'V2_OWNER_CONTEXT_REQUIRED');
  method(options.governance, 'evaluate', 'V2_GOVERNANCE_EVALUATE_REQUIRED');
  method(options.governance, 'assertAuthorized', 'V2_GOVERNANCE_ASSERT_REQUIRED');
  method(options.edge, 'authorize', 'V2_EDGE_REQUIRED');
  method(options.bearer, 'authorize', 'V2_BEARER_REQUIRED');
  method(options.cloud, 'bootstrap', 'V2_CLOUD_BOOTSTRAP_REQUIRED');
  method(options.cloud, 'connectedRefresh', 'V2_CLOUD_REFRESH_REQUIRED');
  method(options.cloud.secretResolver, 'resolve', 'V2_SECRET_RESOLVER_REQUIRED');
  for (const [value, name, methods] of [
    [options.e2ee, 'e2ee', ['issue']],
    [options.e2eeCiphertext, 'e2eeCiphertext', ['resolve']],
    [options.tokenSigner, 'tokenSigner', ['assertProjectUrl', 'sign', 'close']],
    [options.participant, 'participant', ['connect', 'disconnect', 'snapshot', 'close']],
  ] as const) {
    for (const required of methods) method(value, required, `V2_${name.toUpperCase()}_${required.toUpperCase()}_REQUIRED`);
  }
  if (options.assistantBridge !== undefined) {
    method(options.assistantBridge, 'onBootstrapConnected', 'V2_ASSISTANT_BRIDGE_HOOK_REQUIRED');
    if (options.assistantBridge.close !== undefined && typeof options.assistantBridge.close !== 'function') {
      fail('V2_ASSISTANT_BRIDGE_CLOSE_INVALID');
    }
  }
  const pool = t02Plan.mode === 'internal-owned' ? createPostgresPool(t02Plan.postgres) : t02Plan.pool;
  const ownsPool = t02Plan.mode === 'internal-owned';
  let authority: ProductionAuthorityFactoryResult | undefined =
    t02Plan.mode === 'prebuilt-borrowed' ? t02Plan.bundle.authority : undefined;
  let externalEffectCoordinator: RealtimeExternalEffectCoordinatorPort | undefined;
  let externalEffects: T11bT02ExternalEffectCoordinatorPort | undefined;
  let credentialFence: CredentialFencePort | undefined;
  let acceptedUserActivity: RealtimeAcceptedUserActivityProduction | undefined;
  let t04Owner: T04ProductionOwner | undefined = options.t04Owner;
  let t04Preflighted = false;
  let preflightFlight: Promise<void> | undefined;
  try {
    if (t02Plan.mode === 'internal-owned') {
      const repository = createRealtimeAuthorityRepository(pool);
      authority = createProductionAuthorityFactory({
        repository: {
          port: repository,
          readiness: {
            owner: options.readiness.postgres.owner,
            environment: 'production',
            isReady: options.readiness.postgres.isReady,
            ...(options.readiness.postgres.reason === undefined ? {} : { reason: options.readiness.postgres.reason }),
          },
        },
        ...t02Plan.ownerPorts,
      });
    }
    const boundAuthority = authority!;
    const identity = t02Plan.mode === 'prebuilt-borrowed'
      ? t02Plan.bundle.dataPorts.identity
      : boundAuthority.ports.identity;
    const applePhysicalBinding = options.applePhysicalBinding ?? createApplePhysicalCanaryBindingPostgres({
      pool,
      identity,
      canonicalDeviceIssuer: createProductionRealtimeCanonicalDeviceIdentityIssuer(),
    });
    const appleCyclingTelemetry = options.appleCycling === undefined
      ? undefined
      : createRealtimePublicControlAppleCyclingTelemetry({
          binding: applePhysicalBinding,
          bindingSource: options.appleCycling.bindingSource ?? 'formal',
          input: options.appleCycling.input,
          consumer: options.appleCycling.consumer,
          ...(options.appleCycling.maxObservationAgeMs === undefined
            ? {}
            : { maxObservationAgeMs: options.appleCycling.maxObservationAgeMs }),
        });
    acceptedUserActivity = t04Owner === undefined && options.acceptedUserActivity === undefined
      ? undefined
      : createRealtimeAcceptedUserActivityProduction(
          t04Owner === undefined
            ? {
                ...options.acceptedUserActivity!,
                sink: Object.freeze({
                  recordAcceptedUserActivity: (activity: AcceptedUserActivity) =>
                    boundAuthority.service.recordAcceptedUserActivity(activity),
                }),
                equality: boundAuthority.ports.equality,
              }
            : {
                source: t04Owner.source,
                sink: Object.freeze({
                  recordAcceptedUserActivity: (activity: AcceptedUserActivity) =>
                    boundAuthority.service.recordAcceptedUserActivity(activity),
                }),
                equality: boundAuthority.ports.equality,
                purpose: 'cycling_assistant',
              },
        );
    credentialFence = t02Plan.mode === 'internal-owned'
      ? createRealtimeCredentialFence(pool)
      : undefined;
    const coordinator = t02Plan.mode === 'prebuilt-borrowed'
      ? t02Plan.bundle.externalEffectCoordinator
      : createRealtimeExternalEffectCoordinator({
          pool,
          executor: externalEffectExecutor!,
          ...(credentialFence === undefined ? {} : { credentialFence }),
        });
    externalEffectCoordinator = coordinator;
    const t11bExternalEffects = createT11bT02ExternalEffectCoordinatorPort(
      coordinator,
      t02Plan.mode === 'prebuilt-borrowed'
        ? { closeCoordinator: false }
        : { requireCredentialGeneration: true },
    );
    externalEffects = t11bExternalEffects;
    const t11bIssuerReadiness: T11bCanonicalIssuerReadinessPort = Object.freeze({
      assertReady: async (
        input: Parameters<T11bCanonicalIssuerReadinessPort['assertReady']>[0],
      ) => {
        boundAuthority.assertReady();
        const descriptor = t02Plan.mode === 'prebuilt-borrowed'
          ? t02Plan.bundle.issuerReadiness
          : options.readiness.canonicalIssuer;
        if (!descriptor.isReady()) throw new Error('V2_CANONICAL_ISSUER_NOT_READY');
        if (t02Plan.mode === 'prebuilt-borrowed') return true;
        return t02Plan.issuerReadiness.assertReady(input);
      },
      ...(t02Plan.mode === 'internal-owned' && t02Plan.issuerReadiness.close !== undefined
        ? { close: t02Plan.issuerReadiness.close }
        : {}),
    });
    const t11bOwnerContext: T11bOwnerContextPort = Object.freeze({
      resolve: async (input: Parameters<T11bOwnerContextPort['resolve']>[0]) => {
        if (!options.readiness.ownerContext.isReady()) throw new Error('V2_OWNER_CONTEXT_NOT_READY');
        return options.ownerContext.resolve(input);
      },
      ...(options.ownerContext.close === undefined ? {} : { close: options.ownerContext.close }),
    });
    const currentBinding = currentBindingPort(
      t02Plan.mode === 'prebuilt-borrowed'
        ? t02Plan.bundle.readCurrentBinding
        : boundAuthority.readCurrentBinding,
    );
    const terminalCodec = createRealtimePublicControlTerminalCodec();
    const adapter: RealtimePublicControlT11bT02Adapter = createRealtimePublicControlT11bT02Adapter({
      issuerReadiness: t11bIssuerReadiness,
      ownerContext: t11bOwnerContext,
      currentBinding,
      governance: options.governance,
      projection: t02Plan.mode === 'prebuilt-borrowed'
        ? t02Plan.bundle.projection
        : boundAuthority.projection,
      cloud: options.cloud,
      externalEffects: t11bExternalEffects,
      terminalCodec,
    });
    const runtime = createRealtimePublicControlRuntime({
      operationReceipts: createRealtimePublicOperationReceipts(pool),
      ...(options.watchBinding === undefined ? {} : {watchBinding:options.watchBinding}),
      governance: options.governance,
      sessions: adapter.sessions,
      mediaStop: adapter.mediaStop,
      e2ee: options.e2ee,
      e2eeCiphertext: options.e2eeCiphertext,
      tokenSigner: options.tokenSigner,
      participant: options.participant,
      ...(options.participantForDevice === undefined ? {} : { participantForDevice: options.participantForDevice }),
      deviceCredential: options.deviceCredential,
      ...(credentialFence === undefined && options.credentialFenceAdmission === undefined
        ? {}
        : {
            credentialFenceAdmission: credentialFence === undefined
              ? options.credentialFenceAdmission
              : createRuntimeCredentialFenceAdmission(credentialFence),
          }),
      ...(t04Owner === undefined && options.assistantBridge === undefined ? {} : {
        bootstrapConnected:createProductionBootstrapConnectedOwner(t04Owner,options.assistantBridge),
      }),
    });
    const controller = createRealtimePublicControlController({
      enabled: true,
      controlHost: LOOPBACK_HOST,
      edge: options.edge,
      ...(options.canonicalApiOrigin ? {canonicalApiOrigin: options.canonicalApiOrigin} : {}),
      bearer: options.bearer,
      ...(options.glassesEnrollment ? {glassesEnrollment:options.glassesEnrollment} : {}),
      ...(options.capabilityUpgrade ? {capabilityUpgrade:options.capabilityUpgrade} : {}),
      ...(options.ownerMac ? {ownerMac:options.ownerMac} : {}),
      ...(options.appearanceImages ? {appearanceImages:options.appearanceImages} : {}),
      ...(options.place ? {place:options.place} : {}),
      ...(options.watch ? {watch:options.watch} : {}),
      ...(options.viduRetrieval ? {viduRetrieval:options.viduRetrieval} : {}),
      runtime,
      schemaRegistry: options.schemaRegistry ?? createRealtimeSchemaRegistry(),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    });

    let handle: V2GatewayLoopbackHandle | undefined;
    let startFlight: Promise<V2GatewayLoopbackHandle> | undefined;
    let closeFlight: Promise<void> | undefined;
    let closed = false;
    const readiness = (): V2CompositionReadinessSnapshot => {
      const customEntries = Object.entries(options.readiness).filter(([name]) => name !== 'handoffTerminalCodec') as readonly (readonly [string, V2CompositionReadinessInput])[];
      const statuses = customEntries.map(([name, descriptor]) => descriptorStatus(name, descriptor));
      const ownerStatus = (t02Plan.mode === 'prebuilt-borrowed'
        ? t02Plan.bundle.readiness
        : boundAuthority.readiness).current();
      const ownerStatuses = ownerStatus.ports.map((status) => Object.freeze({
        name: `t11b.${status.name}`,
        owner: status.owner,
        ready: status.ready,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
      }));
      const activityStatus = acceptedUserActivity?.readiness();
      let t04Ready = false;
      if (t04Owner !== undefined && t04Preflighted) {
        try { t04Ready = t04Owner.activityAcceptance.readiness.isReady() === true; }
        catch { t04Ready = false; }
      }
      const all = Object.freeze([
        ...statuses,
        ...ownerStatuses,
        ...(t04Owner === undefined ? [] : [Object.freeze({
          name: 't04Owner',
          owner: t04Owner.activityAcceptance.readiness.owner,
          ready: t04Ready,
          ...(t04Ready
            ? {}
            : { reason: t04Preflighted ? 'T04_OWNER_NOT_READY' : 'T04_OWNER_PREFLIGHT_REQUIRED' }),
        })]),
        ...(activityStatus === undefined ? [] : [Object.freeze({
          name: 'acceptedUserActivity',
          owner: activityStatus.owner,
          ready: activityStatus.ready,
          ...(activityStatus.reason === undefined ? {} : { reason: activityStatus.reason }),
        })]),
      ]);
      return Object.freeze({ ready: ownerStatus.ready && all.every((status) => status.ready), statuses: all });
    };
    const assertReady = (): void => {
      const snapshot = readiness();
      if (!snapshot.ready) throw new Error('V2_GATEWAY_OWNER_READINESS_FAILED');
      if (t02Plan.mode === 'prebuilt-borrowed') t02Plan.bundle.assertReady();
      else boundAuthority.assertReady();
    };
    const preflight = (): Promise<void> => {
      if (closed) return Promise.reject(new Error('V2_COMPOSITION_CLOSED'));
      preflightFlight ??= (async () => {
        if (t04Owner !== undefined && !t04Preflighted) {
          await t04Owner.preflight();
          t04Preflighted = true;
          acceptedUserActivity?.bind();
        }
        assertReady();
      })();
      return preflightFlight;
    };
    const start = (): Promise<V2GatewayLoopbackHandle> => {
      if (closed) return Promise.reject(new Error('V2_COMPOSITION_CLOSED'));
      startFlight ??= (async () => {
        await preflight();
        const starter = options.startGateway ?? startV2GatewayLoopback;
        const started = await starter({
          config: options.gateway.config,
          adapter: options.gateway.adapter,
          publicRtcControl: controller,
        });
        handle = started;
        return started;
      })();
      return startFlight;
    };
    const bindAcceptedUserActivitySource = (): void => {
      if (closed) fail('V2_COMPOSITION_CLOSED');
      if (acceptedUserActivity === undefined) fail('V2_ACCEPTED_USER_ACTIVITY_SOURCE_NOT_CONFIGURED');
      assertReady();
      acceptedUserActivity.bind();
    };
    const close = (): Promise<void> => {
      if (closeFlight !== undefined) return closeFlight;
      closed = true;
      closeFlight = (async () => {
        const failures: unknown[] = [];
        const attempt = async (action: () => void | Promise<void>): Promise<void> => {
          try { await action(); } catch (error) { failures.push(error); }
        };
        // Fence new user actions before the listener, runtime and durable
        // authority service begin their own close cascades.
        await attempt(() => acceptedUserActivity?.close());
        await attempt(() => handle?.close());
        await attempt(() => appleCyclingTelemetry?.close());
        // The controller owns the runtime cascade: it closes the T11B adapter,
        // coordinator, cloud, participant, crypto, and signer exactly once.
        await attempt(() => controller.close());
        await attempt(() => options.assistantBridge?.close?.());
        await attempt(() => t04Owner?.close());
        // The Gateway device-session adapter is a separate owner and is never
        // closed by the public-control controller.
        await attempt(() => options.gateway.adapter.close());
        if (t02Plan.mode === 'internal-owned') await attempt(() => boundAuthority.close());
        if (ownsPool) await attempt(() => closePostgresPool(pool));
        if (failures.length !== 0) throw new AggregateError(failures,'V2_COMPOSITION_CLOSE_FAILED');
      })();
      return closeFlight;
    };
    return Object.freeze({
      controller,
      applePhysicalBinding,
      ...(appleCyclingTelemetry === undefined ? {} : { appleCyclingTelemetry }),
      ...(t04Owner === undefined ? {} : { t04Owner }),
      ...(acceptedUserActivity === undefined ? {} : { bindAcceptedUserActivitySource }),
      readiness,
      preflight,
      start,
      close,
    });
  } catch (error) {
    void acceptedUserActivity?.close().catch(() => undefined);
    void t04Owner?.close().catch(() => undefined);
    if (t02Plan.mode === 'internal-owned') {
      if (externalEffects !== undefined) void closePort(externalEffects).catch(() => undefined);
      else if (externalEffectCoordinator !== undefined) void externalEffectCoordinator.close().catch(() => undefined);
      else if (credentialFence !== undefined) void credentialFence.close().catch(() => undefined);
    }
    void closePort(options.cloud).catch(() => undefined);
    void closePort(options.gateway.adapter).catch(() => undefined);
    if (t02Plan.mode === 'internal-owned') {
      void authority?.close().catch(() => undefined);
      if (ownsPool) void closePostgresPool(pool).catch(() => undefined);
    }
    throw error;
  }
}

export const createRealtimePublicControlPgProduction = createRealtimePublicControlPgComposition;
