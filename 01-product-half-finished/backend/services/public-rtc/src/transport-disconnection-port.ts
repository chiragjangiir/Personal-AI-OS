import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  snapshotOpaqueOwnerValue,
  type CanonicalTimestamp,
  type OpaqueCanonicalRef,
  type OpaqueGovernanceValue,
  type RealtimeTransportBinding,
} from "../../realtime-core/src/types.ts";
import type {
  OpaqueEqualityPort,
  TransportDisconnectionPort,
  VerifiedTransportDisconnection,
} from "../../realtime-core/src/ports.ts";
import type { TransportRecoveryState } from "./transport-recovery.ts";

/** Runtime028 requires the decimal-epoch recovery instantiation. */
export type Runtime028RecoveryState = TransportRecoveryState<
  OpaqueCanonicalRef,
  OpaqueCanonicalRef,
  string,
  OpaqueCanonicalRef,
  OpaqueCanonicalRef,
  string
>;

export interface TransportRecoverySnapshotPort {
  readonly snapshot: () => Runtime028RecoveryState;
}

/** The only non-derived value admitted from the Public/RTC authority owner. */
export interface TransportDisconnectionProofInput {
  readonly binding: RealtimeTransportBinding;
  readonly userId: string;
  readonly deviceId: string;
  readonly occurredAt: CanonicalTimestamp;
  readonly recovery: Runtime028RecoveryState;
}

export type TransportDisconnectionProofReader = (
  input: TransportDisconnectionProofInput,
) => OpaqueGovernanceValue | PromiseLike<OpaqueGovernanceValue>;

export interface TransportDisconnectionPortOptions {
  /** Existing Public RTC recovery/controller state; this adapter only reads it. */
  readonly recovery: TransportRecoverySnapshotPort;
  /** Public/RTC owner-issued opaque proof; never synthesized from local state. */
  readonly authorityProof: TransportDisconnectionProofReader;
  /** Existing T01/T11B opaque equality seam. */
  readonly equality: Pick<OpaqueEqualityPort, "same">;
}

export type TransportDisconnectionPortErrorCode =
  | "TRANSPORT_DISCONNECTION_OPTIONS_INVALID"
  | "TRANSPORT_DISCONNECTION_INPUT_INVALID"
  | "TRANSPORT_DISCONNECTION_RECOVERY_UNAVAILABLE"
  | "TRANSPORT_DISCONNECTION_STATE_INVALID"
  | "TRANSPORT_DISCONNECTION_BINDING_MISMATCH"
  | "TRANSPORT_DISCONNECTION_TIME_INVALID"
  | "TRANSPORT_DISCONNECTION_PROOF_MISSING"
  | "TRANSPORT_DISCONNECTION_PROOF_UNAVAILABLE";

export class TransportDisconnectionPortError extends Error {
  readonly code: TransportDisconnectionPortErrorCode;

  public constructor(code: TransportDisconnectionPortErrorCode) {
    super(code);
    this.name = "TransportDisconnectionPortError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameOpaque(
  equality: Pick<OpaqueEqualityPort, "same">,
  left: unknown,
  right: unknown,
): boolean {
  try {
    return equality.same(left as Parameters<OpaqueEqualityPort["same"]>[0], right as Parameters<OpaqueEqualityPort["same"]>[1]) === true;
  } catch {
    return false;
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function assertInput(input: unknown): asserts input is Parameters<TransportDisconnectionPort["verify"]>[0] {
  if (!isRecord(input) || !isRecord(input.binding) ||
      input.binding.state !== "connected" || !validIdentifier(input.userId) ||
      !validIdentifier(input.deviceId) || !validIdentifier(input.occurredAt) ||
      input.governance === undefined) {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_INPUT_INVALID");
  }
}

function assertBindingMatches(
  binding: RealtimeTransportBinding,
  recovery: Runtime028RecoveryState,
  equality: Pick<OpaqueEqualityPort, "same">,
): void {
  if (binding.realtimeSessionRef === undefined || binding.deviceLeaseRef === undefined ||
      !validIdentifier(binding.continuityId) || !validIdentifier(binding.deviceId) ||
      binding.transportSessionAlias === undefined || binding.roomAlias === undefined ||
      binding.deviceAlias === undefined || recovery.realtime_session_ref === undefined ||
      recovery.device_lease_ref === undefined || !validIdentifier(recovery.continuity_id)) {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_BINDING_MISMATCH");
  }
  let bindingEpoch: string;
  let recoveryEpoch: string;
  try {
    bindingEpoch = assertDecimalConnectionEpoch(binding.connectionEpoch);
    recoveryEpoch = assertDecimalConnectionEpoch(recovery.epoch);
  } catch {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_BINDING_MISMATCH");
  }
  if (!sameOpaque(equality, binding.realtimeSessionRef, recovery.realtime_session_ref) ||
      !sameOpaque(equality, binding.deviceLeaseRef, recovery.device_lease_ref) ||
      binding.continuityId !== recovery.continuity_id || bindingEpoch !== recoveryEpoch) {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_BINDING_MISMATCH");
  }
  const bindingAliases = [
    binding.transportSessionAlias,
    binding.roomAlias,
    binding.deviceAlias,
  ] as const;
  if (!Array.isArray(recovery.transport_aliases) ||
      bindingAliases.length !== recovery.transport_aliases.length) {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_BINDING_MISMATCH");
  }
  for (let index = 0; index < bindingAliases.length; index += 1) {
    if (!sameOpaque(equality, bindingAliases[index], recovery.transport_aliases[index])) {
      throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_BINDING_MISMATCH");
    }
  }
}

function disconnectedAt(
  value: unknown,
  occurredAt: CanonicalTimestamp,
): CanonicalTimestamp {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_TIME_INVALID");
  }
  const occurredAtMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredAtMs) || value > occurredAtMs) {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_TIME_INVALID");
  }
  try {
    return assertCanonicalTimestamp(new Date(value).toISOString());
  } catch {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_TIME_INVALID");
  }
}

/**
 * Adapt existing Public RTC recovery state to T11B's proof port.  The adapter
 * performs no recovery transition and never treats a local snapshot as proof.
 */
export function createTransportDisconnectionPort(
  options: TransportDisconnectionPortOptions,
): TransportDisconnectionPort {
  if (options === null || typeof options !== "object" ||
      options.recovery === null || typeof options.recovery !== "object" ||
      typeof options.recovery.snapshot !== "function" ||
      typeof options.authorityProof !== "function" || options.equality === null ||
      typeof options.equality !== "object" || typeof options.equality.same !== "function") {
    throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_OPTIONS_INVALID");
  }

  return Object.freeze({
    verify: async (
      input: Parameters<TransportDisconnectionPort["verify"]>[0],
    ): Promise<VerifiedTransportDisconnection> => {
      assertInput(input);
      const occurredAt = assertCanonicalTimestamp(input.occurredAt);
      let recovery: Runtime028RecoveryState;
      try {
        recovery = options.recovery.snapshot();
      } catch {
        throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_RECOVERY_UNAVAILABLE");
      }
      if (!isRecord(recovery) || recovery.status !== "disconnected") {
        throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_STATE_INVALID");
      }
      assertBindingMatches(input.binding, recovery, options.equality);
      const disconnected = disconnectedAt(recovery.disconnected_at_ms, occurredAt);
      let authorityProof: OpaqueGovernanceValue;
      try {
        const resolved = await options.authorityProof(Object.freeze({
          binding: input.binding,
          userId: input.userId,
          deviceId: input.deviceId,
          occurredAt,
          recovery,
        }));
        if (resolved === undefined || resolved === null) {
          throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_PROOF_MISSING");
        }
        authorityProof = snapshotOpaqueOwnerValue(resolved);
      } catch (error) {
        if (error instanceof TransportDisconnectionPortError) throw error;
        throw new TransportDisconnectionPortError("TRANSPORT_DISCONNECTION_PROOF_UNAVAILABLE");
      }
      return Object.freeze({
        verified: true as const,
        disconnectedAt: disconnected,
        authorityProof,
      });
    },
  });
}
