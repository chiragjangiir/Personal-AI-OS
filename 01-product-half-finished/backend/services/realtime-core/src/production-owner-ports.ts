import type {
  ActivityAcceptancePort,
  LeasePolicyPort,
  OpaqueEqualityPort,
  RealtimeAuthorityPorts,
  RealtimeAuthorityRepository,
  RealtimeAuthorityTransaction,
  RealtimeClockPort,
  RealtimeIdentityPort,
  TransportDisconnectionPort,
} from "./ports.ts";
import type { OpaqueCanonicalRef } from "./types.ts";

/**
 * A production owner port is registered with an explicit owner and readiness
 * probe.  The probe is deliberately synchronous: the Gateway must be able to
 * fail closed before it binds a listener, and no request is allowed to start
 * while a required owner is unavailable.
 */
export interface ProductionReadinessDescriptor {
  readonly owner: string;
  readonly environment: "production";
  readonly isReady: () => boolean;
  readonly reason?: string;
}

export interface ProductionPortRegistration<T extends object> {
  readonly port: T;
  readonly readiness: ProductionReadinessDescriptor;
  readonly close?: () => void | Promise<void>;
}

export interface ProductionOwnerPortsInput {
  readonly repository: ProductionPortRegistration<RealtimeAuthorityRepository>;
  readonly policy: ProductionPortRegistration<LeasePolicyPort>;
  readonly activityAcceptance: ProductionPortRegistration<ActivityAcceptancePort>;
  readonly transportDisconnection: ProductionPortRegistration<TransportDisconnectionPort>;
  readonly identity: ProductionPortRegistration<RealtimeIdentityPort>;
  readonly clock: ProductionPortRegistration<RealtimeClockPort>;
  readonly equality: ProductionPortRegistration<OpaqueEqualityPort>;
}

export type ProductionPortName = keyof ProductionOwnerPortsInput;

export interface ProductionPortStatus {
  readonly name: ProductionPortName;
  readonly owner: string;
  readonly environment: "production";
  readonly ready: boolean;
  readonly reason?: string;
}

export interface ProductionReadinessSnapshot {
  readonly ready: boolean;
  readonly ports: readonly ProductionPortStatus[];
}

export interface ProductionReadiness {
  readonly current: () => ProductionReadinessSnapshot;
  readonly assertReady: () => void;
}

/**
 * Encode only a supported plain value without JSON serialization.  This is a
 * structural comparison key, not a canonical object hash or an owner ref.
 * Undefined, accessors, symbols, host objects, and cycles are rejected.
 */
function structuralKey(value: unknown, ancestors: WeakSet<object> = new WeakSet<object>()): string {
  if (value === null) return "null;";
  if (typeof value === "string") return `string:${value.length}:${value};`;
  if (typeof value === "boolean") return value ? "boolean:1;" : "boolean:0;";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
    if (value === 0 && 1 / value === -Infinity) return "number:-0;";
    return `number:${String(value)};`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
  }
  if (ancestors.has(value)) throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_CYCLE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") ||
          names.length !== value.length + 1 || !names.includes("length")) {
        throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || descriptor.enumerable !== true ||
            descriptor.get !== undefined || descriptor.set !== undefined ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
        }
        items.push(structuralKey(descriptor.value, ancestors));
      }
      return `array:${items.length}:[${items.join("")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || names.length !== Object.keys(value).length) {
      throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
    }
    const fields: string[] = [];
    for (const name of names.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || descriptor.enumerable !== true ||
          descriptor.get !== undefined || descriptor.set !== undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_VALUE_INVALID");
      }
      fields.push(`key:${name.length}:${name}=${structuralKey(descriptor.value, ancestors)}`);
    }
    return `object:${fields.length}:{${fields.join("")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * T11B's dependency-free restart-safe structural equality implementation.
 * It is suitable for injection when the Owner has no stricter equality
 * implementation.  `key` is intentionally an opaque structural key only;
 * it is not a canonical payload hash and must never be persisted as one.
 */
export function createProductionStructuralEquality(): OpaqueEqualityPort {
  return Object.freeze({
    key: (value: OpaqueCanonicalRef): string => structuralKey(value),
    same: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef): boolean => {
      try {
        return structuralKey(left) === structuralKey(right);
      } catch {
        return false;
      }
    },
  });
}

/** Descriptive alias for callers that refer to this seam as canonical equality. */
export const createCanonicalStructuralEquality = createProductionStructuralEquality;

export class ProductionOwnerPortsError extends Error {
  readonly code: string;
  readonly statuses: readonly ProductionPortStatus[] | undefined;

  public constructor(
    code: string,
    message = code,
    statuses?: readonly ProductionPortStatus[],
  ) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = "ProductionOwnerPortsError";
    this.code = code;
    this.statuses = statuses;
  }
}

type AnyRegistration = ProductionPortRegistration<object>;

const REQUIRED_METHODS: Readonly<Record<ProductionPortName, readonly string[]>> = Object.freeze({
  repository: ["transaction"],
  policy: ["evaluate"],
  activityAcceptance: ["verify"],
  transportDisconnection: ["verify"],
  identity: [
    "createContinuityId",
    "assertRepositoryIssuedRef",
    "createSessionRef",
    "createDeviceLeaseRef",
    "createTransportAlias",
    "createConnectionId",
  ],
  clock: ["now"],
  equality: ["key", "same"],
});

const PORT_NAMES: readonly ProductionPortName[] = Object.freeze([
  "repository",
  "policy",
  "activityAcceptance",
  "transportDisconnection",
  "identity",
  "clock",
  "equality",
]);

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionOwnerPortsError(code);
  }
  return value as Record<string, unknown>;
}

function assertMethods(
  name: ProductionPortName,
  registration: unknown,
): AnyRegistration {
  if (registration === undefined) {
    throw new ProductionOwnerPortsError(`PRODUCTION_${name.toUpperCase()}_REGISTRATION_REQUIRED`);
  }
  const record = asRecord(registration, "PRODUCTION_PORT_REGISTRATION_REQUIRED");
  const port = asRecord(record.port, `PRODUCTION_${name.toUpperCase()}_PORT_REQUIRED`);
  for (const method of REQUIRED_METHODS[name]) {
    if (typeof port[method] !== "function") {
      throw new ProductionOwnerPortsError(`PRODUCTION_${name.toUpperCase()}_METHOD_REQUIRED`);
    }
  }
  const readiness = asRecord(record.readiness, `PRODUCTION_${name.toUpperCase()}_READINESS_REQUIRED`);
  if (readiness.environment !== "production") {
    throw new ProductionOwnerPortsError(`PRODUCTION_${name.toUpperCase()}_NON_PRODUCTION`);
  }
  if (typeof readiness.owner !== "string" || readiness.owner.trim().length === 0) {
    throw new ProductionOwnerPortsError(`PRODUCTION_${name.toUpperCase()}_OWNER_REQUIRED`);
  }
  if (typeof readiness.isReady !== "function") {
    throw new ProductionOwnerPortsError(`PRODUCTION_${name.toUpperCase()}_READINESS_PROBE_REQUIRED`);
  }
  return registration as AnyRegistration;
}

function assertStructuralEquality(
  registration: ProductionPortRegistration<OpaqueEqualityPort>,
): void {
  const equality = registration.port;
  // Probe only an explicitly non-authoritative nested value and an
  // independently allocated clone.  This catches identity-only equality
  // without minting, parsing, or persisting a UUID, hash, or canonical ref.
  const left = Object.freeze({
    probe: Object.freeze({ alpha: "structural", beta: Object.freeze(["one", 2]) }),
    order: Object.freeze(["first", "second"]),
  });
  const right = Object.freeze({
    order: Object.freeze(["first", "second"]),
    probe: Object.freeze({ beta: Object.freeze(["one", 2]), alpha: "structural" }),
  });
  const changed = Object.freeze({
    probe: Object.freeze({ alpha: "drift", beta: Object.freeze(["one", 2]) }),
    order: Object.freeze(["first", "second"]),
  });
  let sameClone: unknown;
  let sameChanged: unknown;
  let leftKey: unknown;
  let rightKey: unknown;
  let changedKey: unknown;
  try {
    sameClone = equality.same(left, right);
    sameChanged = equality.same(left, changed);
    leftKey = equality.key(left);
    rightKey = equality.key(right);
    changedKey = equality.key(changed);
  } catch {
    throw new ProductionOwnerPortsError("PRODUCTION_EQUALITY_PROBE_FAILED");
  }
  if (sameClone !== true || sameChanged !== false ||
      typeof leftKey !== "string" || leftKey.length === 0 ||
      leftKey !== rightKey || leftKey === changedKey) {
    throw new ProductionOwnerPortsError("PRODUCTION_STRUCTURAL_EQUALITY_REQUIRED");
  }
}

function invokeClose(registration: AnyRegistration): Promise<void> {
  const close = (registration as { readonly close?: unknown }).close;
  if (close === undefined) return Promise.resolve();
  if (typeof close !== "function") {
    return Promise.reject(new ProductionOwnerPortsError("PRODUCTION_CLOSE_HOOK_INVALID"));
  }
  return Promise.resolve(Reflect.apply(close as () => void | Promise<void>, registration, []));
}

function ownerStatus(
  name: ProductionPortName,
  registration: AnyRegistration,
): ProductionPortStatus {
  const readiness = registration.readiness;
  let ready = false;
  let reason = readiness.reason;
  try {
    ready = readiness.isReady() === true;
    if (!ready && reason === undefined) reason = "OWNER_NOT_READY";
  } catch {
    ready = false;
    reason = "OWNER_READINESS_ERROR";
  }
  return Object.freeze({
    name,
    owner: readiness.owner,
    environment: "production" as const,
    ready,
    ...(reason === undefined ? {} : { reason }),
  });
}

function createReadiness(
  registrations: Readonly<Record<ProductionPortName, AnyRegistration>>,
  isClosed: () => boolean,
): ProductionReadiness {
  const current = (): ProductionReadinessSnapshot => {
    if (isClosed()) {
      const ports = Object.freeze(PORT_NAMES.map((name) => Object.freeze({
        name,
        owner: registrations[name].readiness.owner,
        environment: "production" as const,
        ready: false,
        reason: "PORTS_CLOSED",
      })));
      return Object.freeze({ ready: false, ports });
    }
    const ports = Object.freeze(PORT_NAMES.map((name) => ownerStatus(name, registrations[name])));
    return Object.freeze({ ready: ports.every((status) => status.ready), ports });
  };
  const assertReady = (): void => {
    const snapshot = current();
    if (!snapshot.ready) {
      throw new ProductionOwnerPortsError(
        "REALTIME_PRODUCTION_PORTS_NOT_READY",
        "required production owner ports are not ready",
        snapshot.ports,
      );
    }
  };
  return Object.freeze({ current, assertReady });
}

export interface ProductionOwnerPorts extends RealtimeAuthorityPorts {
  readonly readiness: ProductionReadiness;
  readonly assertReady: () => void;
  readonly close: () => Promise<void>;
}

/**
 * Build the only T11B production port set.  Every dependency is explicit and
 * owner-registered; there is no default, Map, in-memory authority, or test
 * fallback.  A not-ready identity issuer is allowed to construct the set so
 * callers can inspect readiness, but every service operation remains fenced
 * until all owner probes report ready.
 */
export function createProductionOwnerPorts(input: ProductionOwnerPortsInput): ProductionOwnerPorts {
  const registrations = {} as Record<ProductionPortName, AnyRegistration>;
  for (const name of PORT_NAMES) {
    registrations[name] = assertMethods(name, input?.[name]);
  }
  assertStructuralEquality(input.equality);

  const ports = PORT_NAMES.map((name) => registrations[name].port);
  for (let index = 0; index < ports.length; index += 1) {
    for (let other = index + 1; other < ports.length; other += 1) {
      if (ports[index] === ports[other]) {
        throw new ProductionOwnerPortsError("PRODUCTION_PORT_REUSE_FORBIDDEN");
      }
    }
  }

  let closed = false;
  const readiness = createReadiness(registrations, () => closed);
  const guard = (): void => {
    if (closed) throw new ProductionOwnerPortsError("REALTIME_PRODUCTION_PORTS_CLOSED");
    readiness.assertReady();
  };

  const repository = registrations.repository.port as RealtimeAuthorityRepository;
  const policy = registrations.policy.port as LeasePolicyPort;
  const activityAcceptance = registrations.activityAcceptance.port as ActivityAcceptancePort;
  const transportDisconnection = registrations.transportDisconnection.port as TransportDisconnectionPort;
  const identity = registrations.identity.port as RealtimeIdentityPort;
  const clock = registrations.clock.port as RealtimeClockPort;
  const equality = registrations.equality.port as OpaqueEqualityPort;

  const guardedRepository: RealtimeAuthorityRepository = Object.freeze({
    transaction<T>(operation: string, work: (transaction: RealtimeAuthorityTransaction) => Promise<T>): Promise<T> {
      guard();
      return repository.transaction<T>(operation, work);
    },
  });
  const guardedPolicy: LeasePolicyPort = Object.freeze({
    evaluate(input: Parameters<LeasePolicyPort["evaluate"]>[0]) {
      guard();
      return policy.evaluate(input);
    },
  });
  const guardedActivityAcceptance: ActivityAcceptancePort = Object.freeze({
    verify(input: Parameters<ActivityAcceptancePort["verify"]>[0]) {
      guard();
      return activityAcceptance.verify(input);
    },
  });
  const guardedTransportDisconnection: TransportDisconnectionPort = Object.freeze({
    verify(input: Parameters<TransportDisconnectionPort["verify"]>[0]) {
      guard();
      return transportDisconnection.verify(input);
    },
  });
  const guardedIdentity: RealtimeIdentityPort = Object.freeze({
    createContinuityId(input: Parameters<RealtimeIdentityPort["createContinuityId"]>[0]) {
      guard();
      return identity.createContinuityId(input);
    },
    assertRepositoryIssuedRef(value: Parameters<RealtimeIdentityPort["assertRepositoryIssuedRef"]>[0], kind: Parameters<RealtimeIdentityPort["assertRepositoryIssuedRef"]>[1]) {
      guard();
      identity.assertRepositoryIssuedRef(value, kind);
    },
    createSessionRef(input: Parameters<RealtimeIdentityPort["createSessionRef"]>[0]) {
      guard();
      return identity.createSessionRef(input);
    },
    createDeviceLeaseRef(input: Parameters<RealtimeIdentityPort["createDeviceLeaseRef"]>[0]) {
      guard();
      return identity.createDeviceLeaseRef(input);
    },
    createTransportAlias(input: Parameters<RealtimeIdentityPort["createTransportAlias"]>[0]) {
      guard();
      return identity.createTransportAlias(input);
    },
    createConnectionId(input: Parameters<RealtimeIdentityPort["createConnectionId"]>[0]) {
      guard();
      return identity.createConnectionId(input);
    },
  });
  const guardedClock: RealtimeClockPort = Object.freeze({
    now() {
      guard();
      return clock.now();
    },
  });
  const guardedEquality: OpaqueEqualityPort = Object.freeze({
    key(value: Parameters<OpaqueEqualityPort["key"]>[0]) {
      guard();
      return equality.key(value);
    },
    same(left: Parameters<OpaqueEqualityPort["same"]>[0], right: Parameters<OpaqueEqualityPort["same"]>[1]) {
      guard();
      return equality.same(left, right);
    },
  });

  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeFlight !== undefined) return closeFlight;
    closed = true;
    closeFlight = (async () => {
      const orderedNames: readonly ProductionPortName[] = Object.freeze([
        "policy",
        "activityAcceptance",
        "transportDisconnection",
        "identity",
        "clock",
        "equality",
        "repository",
      ]);
      const failures: unknown[] = [];
      for (const name of orderedNames) {
        try {
          await invokeClose(registrations[name]);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length !== 0) {
        throw new ProductionOwnerPortsError("PRODUCTION_OWNER_PORT_CLOSE_FAILED");
      }
    })();
    return closeFlight;
  };

  return Object.freeze({
    repository: guardedRepository,
    policy: guardedPolicy,
    activityAcceptance: guardedActivityAcceptance,
    transportDisconnection: guardedTransportDisconnection,
    identity: guardedIdentity,
    clock: guardedClock,
    equality: guardedEquality,
    readiness,
    assertReady: readiness.assertReady,
    close,
  });
}
