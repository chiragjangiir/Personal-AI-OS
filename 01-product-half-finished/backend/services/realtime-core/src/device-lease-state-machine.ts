import {
  assertCanonicalTimestamp,
  assertDecimalCounter,
  incrementDecimalCounter,
  snapshotOpaqueOwnerValue,
  type CanonicalTimestamp,
  type DeviceLeaseRecord,
  type OpaqueCanonicalRef,
} from "./types.ts";
import type { LeasePolicyDecision } from "./ports.ts";

export function createDeviceLease(input: {
  readonly deviceLeaseRef: OpaqueCanonicalRef;
  readonly realtimeSessionRef: OpaqueCanonicalRef;
  readonly continuityId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly issuedAt: CanonicalTimestamp;
  readonly policy: LeasePolicyDecision;
}): DeviceLeaseRecord {
  const policyValue: unknown = input.policy;
  if (policyValue === null || typeof policyValue !== "object" || Array.isArray(policyValue)) {
    throw new Error("POLICY_DECISION_INVALID");
  }
  const policy = policyValue as Record<string, unknown>;
  if (policy.allowed !== true || policy.revocable !== true ||
      typeof policy.purpose !== "string" || policy.purpose.trim().length === 0 ||
      !Array.isArray(policy.capabilities)) {
    throw new Error("POLICY_DECISION_INVALID");
  }
  const capabilityNames = Object.getOwnPropertyNames(policy.capabilities);
  if (Reflect.ownKeys(policy.capabilities).some((key) => typeof key !== "string") ||
      capabilityNames.length !== policy.capabilities.length + 1) {
    throw new Error("POLICY_DECISION_INVALID");
  }
  for (let index = 0; index < policy.capabilities.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(policy.capabilities, String(index));
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true || typeof descriptor.value !== "string" || descriptor.value.trim().length === 0) {
      throw new Error("POLICY_DECISION_INVALID");
    }
  }
  const policyDecisionRef = snapshotOpaqueOwnerValue(policy.policyDecisionRef);
  if (typeof policyDecisionRef === "string" && policyDecisionRef.trim().length === 0) {
    throw new Error("POLICY_DECISION_INVALID");
  }
  const issuedAt = assertCanonicalTimestamp(input.issuedAt);
  const expiresAt = assertCanonicalTimestamp(policy.leaseExpiresAt);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error("INVALID_LEASE_WINDOW");
  return {
    deviceLeaseRef: snapshotOpaqueOwnerValue(input.deviceLeaseRef),
    realtimeSessionRef: snapshotOpaqueOwnerValue(input.realtimeSessionRef),
    continuityId: input.continuityId,
    userId: input.userId,
    deviceId: input.deviceId,
    state: "active",
    capabilities: Object.freeze([...policy.capabilities] as string[]),
    purpose: policy.purpose,
    issuedAt,
    expiresAt,
    revocable: true,
    leaseVersion: assertDecimalCounter("1"),
    fencingToken: assertDecimalCounter("1"),
    policyDecisionRef,
  };
}

export function releaseDeviceLease(
  lease: DeviceLeaseRecord,
  expectedLeaseVersion: string,
): DeviceLeaseRecord {
  assertLeaseVersion(lease, expectedLeaseVersion);
  if (lease.state === "revoked" || lease.state === "expired") {
    throw new Error("LEASE_NOT_RELEASEABLE");
  }
  if (lease.state === "released") return lease;
  return {
    ...lease,
    state: "released",
    leaseVersion: incrementDecimalCounter(lease.leaseVersion),
    fencingToken: incrementDecimalCounter(lease.fencingToken),
  };
}

export function revokeDeviceLease(
  lease: DeviceLeaseRecord,
  expectedLeaseVersion: string,
): DeviceLeaseRecord {
  assertLeaseVersion(lease, expectedLeaseVersion);
  if (lease.state === "expired") throw new Error("LEASE_EXPIRED");
  if (lease.state === "revoked") return lease;
  return {
    ...lease,
    state: "revoked",
    leaseVersion: incrementDecimalCounter(lease.leaseVersion),
    fencingToken: incrementDecimalCounter(lease.fencingToken),
  };
}

export function expireDeviceLease(
  lease: DeviceLeaseRecord,
  now: CanonicalTimestamp,
): DeviceLeaseRecord {
  const nowAt = Date.parse(assertCanonicalTimestamp(now));
  if (lease.state !== "active" || Date.parse(lease.expiresAt) > nowAt) return lease;
  return {
    ...lease,
    state: "expired",
    leaseVersion: incrementDecimalCounter(lease.leaseVersion),
    fencingToken: incrementDecimalCounter(lease.fencingToken),
  };
}

export function assertLeaseUsable(input: {
  readonly lease: DeviceLeaseRecord;
  readonly now: CanonicalTimestamp;
  readonly expectedLeaseVersion: string;
  readonly expectedDeviceId: string;
  readonly expectedSessionRef: OpaqueCanonicalRef;
  readonly sameRef: (left: OpaqueCanonicalRef, right: OpaqueCanonicalRef) => boolean;
}): DeviceLeaseRecord {
  assertLeaseVersion(input.lease, input.expectedLeaseVersion);
  if (input.lease.state !== "active") throw new Error(`LEASE_${input.lease.state.toUpperCase()}`);
  if (input.lease.deviceId !== input.expectedDeviceId ||
      !input.sameRef(input.lease.realtimeSessionRef, input.expectedSessionRef)) {
    throw new Error("LEASE_BINDING_INVALID");
  }
  if (Date.parse(input.lease.expiresAt) <= Date.parse(assertCanonicalTimestamp(input.now))) {
    throw new Error("LEASE_EXPIRED");
  }
  return input.lease;
}

function assertLeaseVersion(lease: DeviceLeaseRecord, expected: string): void {
  const expectedVersion = assertDecimalCounter(expected);
  if (lease.leaseVersion !== expectedVersion) throw new Error("LEASE_VERSION_CONFLICT");
}
