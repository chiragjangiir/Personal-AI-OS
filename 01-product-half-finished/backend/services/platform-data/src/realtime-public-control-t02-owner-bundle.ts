import type { Pool } from "pg";

import {
  createProductionAuthorityFactory,
  type ProductionAuthorityFactoryOptions,
  type ProductionAuthorityFactoryResult,
} from "../../realtime-core/src/production-authority-factory.ts";
import {
  createProductionStructuralEquality,
  type ProductionPortRegistration,
  type ProductionReadiness,
  type ProductionReadinessDescriptor,
} from "../../realtime-core/src/production-owner-ports.ts";
import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  OpaqueEqualityPort,
  RealtimeClockPort,
  RealtimeIdentityPort,
  TransportDisconnectionPort,
} from "../../realtime-core/src/ports.ts";
import {
  createProductionRealtimeIdentityPort,
} from "./realtime-identity-issuer.ts";
import {
  createRealtimeAuthorityRepository,
  type RealtimeAuthorityRepository,
} from "./realtime-authority-repository.ts";
import type {
  JsonRecord,
  RealtimeExternalEffectClaim,
  RealtimeExternalEffectCoordinatorPort,
} from "./realtime-external-effect-coordinator.ts";

export interface RealtimePublicControlT02HandoffOutputFencePort {
  readonly claim: (input: {
    readonly idempotencyContext: JsonRecord;
    readonly fingerprint: string;
    readonly request: JsonRecord;
    readonly wireRequest?: JsonRecord;
  }) => Promise<RealtimeExternalEffectClaim>;
  readonly suppressAndClose: (input: {
    readonly request: unknown;
    readonly fingerprint: string;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }) => Promise<unknown>;
  readonly commit: RealtimeExternalEffectCoordinatorPort["commit"];
  readonly release: RealtimeExternalEffectCoordinatorPort["release"];
  readonly close: RealtimeExternalEffectCoordinatorPort["close"];
}

/** The only inputs needed to compose the T02-owned public-control authority. */
export interface RealtimePublicControlT02OwnerBundleInput {
  readonly pool: Pool;
  readonly postgresReadiness: ProductionReadinessDescriptor;
  readonly clock: ProductionPortRegistration<RealtimeClockPort>;
  readonly t03: {
    readonly policy: ProductionPortRegistration<LeasePolicyPort>;
    readonly bindCurrentBinding: (
      reader: ProductionAuthorityFactoryResult["readCurrentBinding"],
    ) => void | Promise<void>;
  };
  readonly activityAcceptance: ProductionPortRegistration<ActivityAcceptancePort>;
  readonly transportDisconnection: ProductionPortRegistration<TransportDisconnectionPort>;
  readonly externalEffectCoordinator: RealtimeExternalEffectCoordinatorPort;
}

/**
 * The composed authority and its exact concrete data-port aliases.  The pool
 * is borrowed from the caller and is deliberately absent from this close
 * surface.
 */
export interface RealtimePublicControlT02OwnerBundle {
  readonly authority: ProductionAuthorityFactoryResult;
  readonly service: ProductionAuthorityFactoryResult["service"];
  readonly projection: ProductionAuthorityFactoryResult["projection"];
  readonly readCurrentBinding: ProductionAuthorityFactoryResult["readCurrentBinding"];
  readonly dataPorts: Readonly<{
    readonly repository: RealtimeAuthorityRepository;
    readonly identity: RealtimeIdentityPort;
    readonly clock: RealtimeClockPort;
    readonly equality: OpaqueEqualityPort;
  }>;
  readonly issuerReadiness: ProductionReadinessDescriptor;
  readonly externalEffectCoordinator: RealtimeExternalEffectCoordinatorPort;
  readonly handoffOutputFence: RealtimePublicControlT02HandoffOutputFencePort;
  readonly readiness: ProductionReadiness;
  readonly assertReady: ProductionAuthorityFactoryResult["assertReady"];
  readonly close: ProductionAuthorityFactoryResult["close"];
}

type PlainRecord = Record<string, unknown>;

const INPUT_KEYS = Object.freeze([
  "activityAcceptance",
  "clock",
  "externalEffectCoordinator",
  "pool",
  "postgresReadiness",
  "t03",
  "transportDisconnection",
] as const);

function invalidInput(): never {
  throw new TypeError("REALTIME_PUBLIC_CONTROL_T02_OWNER_BUNDLE_INPUT_INVALID");
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[]): PlainRecord {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) invalidInput();
  const expected = [...keys].sort();
  const actual = Object.getOwnPropertyNames(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidInput();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true) invalidInput();
  }
  return value;
}

function assertReadinessDescriptor(value: unknown): asserts value is ProductionReadinessDescriptor {
  if (!isPlainRecord(value)) invalidInput();
  const descriptor = value as PlainRecord;
  if (descriptor.environment !== "production" || typeof descriptor.owner !== "string" ||
      descriptor.owner.trim().length === 0 || typeof descriptor.isReady !== "function") {
    invalidInput();
  }
  if (Object.hasOwn(descriptor, "reason") && descriptor.reason !== undefined &&
      typeof descriptor.reason !== "string") invalidInput();
}

function probe(readiness: ProductionReadinessDescriptor): boolean {
  try {
    return readiness.isReady() === true;
  } catch {
    return false;
  }
}

function identityMethodsReady(identity: RealtimeIdentityPort): boolean {
  return typeof identity.createContinuityId === "function" &&
    typeof identity.assertRepositoryIssuedRef === "function" &&
    typeof identity.createSessionRef === "function" &&
    typeof identity.createDeviceLeaseRef === "function" &&
    typeof identity.createTransportAlias === "function" &&
    typeof identity.createConnectionId === "function";
}

function equalityReadiness(equality: OpaqueEqualityPort): ProductionReadinessDescriptor {
  return Object.freeze({
    owner: "T11B",
    environment: "production" as const,
    isReady: () => typeof equality.key === "function" && typeof equality.same === "function",
  });
}

function handoffOutputFence(
  coordinator: RealtimeExternalEffectCoordinatorPort,
): RealtimePublicControlT02HandoffOutputFencePort {
  for (const method of ["claim", "suppressAndClose", "commit", "release", "close"] as const) {
    if (typeof coordinator[method] !== "function") invalidInput();
  }
  return Object.freeze({
    claim: (input: Parameters<RealtimePublicControlT02HandoffOutputFencePort["claim"]>[0]) =>
      coordinator.claim(input),
    suppressAndClose: (input: Parameters<RealtimePublicControlT02HandoffOutputFencePort["suppressAndClose"]>[0]) =>
      coordinator.suppressAndClose(input),
    commit: (input: Parameters<RealtimePublicControlT02HandoffOutputFencePort["commit"]>[0]) =>
      coordinator.commit(input),
    release: (input: Parameters<RealtimePublicControlT02HandoffOutputFencePort["release"]>[0]) =>
      coordinator.release(input),
    close: () => coordinator.close(),
  });
}

/**
 * Compose the T02 repository, identity issuer, and structural equality with
 * the existing T11B production factory.  T03 binding is the final composition
 * step and may become ready after this function returns.
 */
export async function createRealtimePublicControlT02OwnerBundle(
  input: RealtimePublicControlT02OwnerBundleInput,
): Promise<RealtimePublicControlT02OwnerBundle> {
  const options = exactRecord(input, INPUT_KEYS);
  if (!options.pool || typeof (options.pool as Pool).connect !== "function") invalidInput();
  assertReadinessDescriptor(options.postgresReadiness);
  const externalEffectCoordinator = options.externalEffectCoordinator as RealtimeExternalEffectCoordinatorPort;
  const outputFence = handoffOutputFence(externalEffectCoordinator);

  const clockRegistration = options.clock as ProductionPortRegistration<RealtimeClockPort>;
  const t03 = exactRecord(options.t03, ["bindCurrentBinding", "policy"]);
  if (typeof t03.bindCurrentBinding !== "function") invalidInput();

  const repository = createRealtimeAuthorityRepository(options.pool as Pool);
  const identity = createProductionRealtimeIdentityPort({ clock: clockRegistration.port });
  const equality = createProductionStructuralEquality();
  const issuerIdentityReady = identityMethodsReady(identity);
  const issuerReadiness: ProductionReadinessDescriptor = Object.freeze({
    owner: "T02",
    environment: "production",
    isReady: () => issuerIdentityReady &&
      probe(options.postgresReadiness as ProductionReadinessDescriptor) &&
      probe(clockRegistration.readiness),
  });

  const authorityOptions: ProductionAuthorityFactoryOptions = {
    repository: Object.freeze({
      port: repository,
      readiness: options.postgresReadiness as ProductionReadinessDescriptor,
    }),
    identity: Object.freeze({ port: identity, readiness: issuerReadiness }),
    clock: clockRegistration,
    equality: Object.freeze({ port: equality, readiness: equalityReadiness(equality) }),
    policy: t03.policy as ProductionPortRegistration<LeasePolicyPort>,
    activityAcceptance: options.activityAcceptance as ProductionPortRegistration<ActivityAcceptancePort>,
    transportDisconnection: options.transportDisconnection as ProductionPortRegistration<TransportDisconnectionPort>,
  };

  let authority: ProductionAuthorityFactoryResult | undefined;
  try {
    authority = createProductionAuthorityFactory(authorityOptions);
    await t03.bindCurrentBinding(authority.readCurrentBinding);
  } catch (error) {
    if (authority !== undefined) {
      try {
        await authority.close();
      } catch {
        // Preserve the binding or construction failure as the public error.
      }
    }
    try {
      await externalEffectCoordinator.close();
    } catch {
      // Preserve the binding or construction failure as the public error.
    }
    throw error;
  }

  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closeFlight = (async () => {
      const results = await Promise.allSettled([authority.close(), externalEffectCoordinator.close()]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("REALTIME_PUBLIC_CONTROL_T02_OWNER_BUNDLE_CLOSE_FAILED");
      }
    })();
    return closeFlight;
  };

  const dataPorts = Object.freeze({
    repository,
    identity,
    clock: clockRegistration.port,
    equality,
  });
  return Object.freeze({
    authority,
    service: authority.service,
    projection: authority.projection,
    readCurrentBinding: authority.readCurrentBinding,
    dataPorts,
    issuerReadiness,
    externalEffectCoordinator,
    handoffOutputFence: outputFence,
    readiness: authority.readiness,
    assertReady: authority.assertReady,
    close,
  });
}
