import type {
  AcceptedUserActivity,
  CurrentBindingLookup,
  OpaqueEqualityPort,
  RealtimeCurrentBindingProjection,
} from "../../realtime-core/src/index.ts";
import type { ActivityAuthorityReader } from "./activity-acceptance.ts";

/** The existing T02/T11B authoritative current-binding function seam. */
export type ActivityCurrentBindingReader = (
  lookup: CurrentBindingLookup,
) => Promise<RealtimeCurrentBindingProjection | undefined>;

/** Exactly one T04-owned projection callback crosses this adapter boundary. */
export interface ActivityAuthorityProjectionInput {
  readonly activity: AcceptedUserActivity;
  readonly currentBinding: RealtimeCurrentBindingProjection;
}

export type ActivityAuthorityProjectionReader = (
  input: ActivityAuthorityProjectionInput,
) => unknown | PromiseLike<unknown>;

export interface ActivityAuthorityReaderOptions {
  /** Existing authoritative T02/T11B read; aliases are never accepted here. */
  readonly readCurrentBinding: ActivityCurrentBindingReader;
  /** T04 supplies acceptance evidence, refs, and watermark through this one callback. */
  readonly readAuthorityProjection: ActivityAuthorityProjectionReader;
  /** Reuse the existing owner equality seam for opaque refs. */
  readonly equality: Pick<OpaqueEqualityPort, "same">;
}

export type ActivityAuthorityReaderErrorCode =
  | "ACTIVITY_AUTHORITY_READER_OPTIONS_INVALID"
  | "ACTIVITY_AUTHORITY_ACTIVITY_INVALID"
  | "ACTIVITY_AUTHORITY_CURRENT_BINDING_UNAVAILABLE"
  | "ACTIVITY_AUTHORITY_CURRENT_BINDING_INVALID"
  | "ACTIVITY_AUTHORITY_CURRENT_BINDING_MISMATCH"
  | "ACTIVITY_AUTHORITY_PROJECTION_UNAVAILABLE";

export class ActivityAuthorityReaderError extends Error {
  readonly code: ActivityAuthorityReaderErrorCode;

  public constructor(code: ActivityAuthorityReaderErrorCode) {
    super(code);
    this.name = "ActivityAuthorityReaderError";
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

function assertActivity(activity: unknown): asserts activity is AcceptedUserActivity {
  if (!isRecord(activity) || activity.kind !== "accepted_user_activity" || activity.accepted !== true ||
      !validIdentifier(activity.activityId) || !validIdentifier(activity.userId) ||
      !validIdentifier(activity.deviceId) || !validIdentifier(activity.continuityId) ||
      activity.realtimeSessionRef === undefined || activity.acceptanceRef === undefined ||
      !validIdentifier(activity.occurredAt)) {
    throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_ACTIVITY_INVALID");
  }
}

function assertCurrentBinding(
  activity: AcceptedUserActivity,
  current: unknown,
  equality: Pick<OpaqueEqualityPort, "same">,
): asserts current is RealtimeCurrentBindingProjection {
  if (!isRecord(current) || !isRecord(current.session) || !isRecord(current.lease)) {
    throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_CURRENT_BINDING_INVALID");
  }
  const session = current.session;
  const lease = current.lease;
  const binding = session.binding;
  if (!isRecord(binding) || session.state !== "active" || session.continuityState !== "active" ||
      lease.state !== "active" || binding.state !== "connected") {
    throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_CURRENT_BINDING_INVALID");
  }
  if (!validIdentifier(session.userId) || !validIdentifier(session.continuityId) ||
      !validIdentifier(session.activeDeviceId) || !validIdentifier(lease.userId) ||
      !validIdentifier(lease.deviceId) || !validIdentifier(lease.continuityId) ||
      !validIdentifier(binding.deviceId) || binding.continuityId === undefined) {
    throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_CURRENT_BINDING_INVALID");
  }

  const matching =
    sameOpaque(equality, activity.realtimeSessionRef, session.realtimeSessionRef) &&
    sameOpaque(equality, session.realtimeSessionRef, lease.realtimeSessionRef) &&
    sameOpaque(equality, session.realtimeSessionRef, binding.realtimeSessionRef) &&
    sameOpaque(equality, session.activeDeviceLeaseRef, lease.deviceLeaseRef) &&
    sameOpaque(equality, lease.deviceLeaseRef, binding.deviceLeaseRef) &&
    session.userId === activity.userId &&
    session.userId === lease.userId &&
    session.continuityId === activity.continuityId &&
    session.continuityId === lease.continuityId &&
    session.continuityId === binding.continuityId &&
    session.activeDeviceId === activity.deviceId &&
    session.activeDeviceId === lease.deviceId &&
    session.activeDeviceId === binding.deviceId;
  if (!matching) {
    throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_CURRENT_BINDING_MISMATCH");
  }
}

/**
 * Compose T04's production reader from the existing authoritative T02/T11B
 * current-binding seam.  This adapter does not mint or reinterpret any T04
 * evidence; the owner projection callback remains the sole source of those
 * opaque values.
 */
export function createActivityAuthorityReader(
  options: ActivityAuthorityReaderOptions,
): ActivityAuthorityReader {
  if (options === null || typeof options !== "object" ||
      typeof options.readCurrentBinding !== "function" ||
      typeof options.readAuthorityProjection !== "function" ||
      options.equality === null || typeof options.equality !== "object" ||
      typeof options.equality.same !== "function") {
    throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_READER_OPTIONS_INVALID");
  }

  return Object.freeze({
    environment: "production" as const,
    readCurrent: async (activity: AcceptedUserActivity): Promise<unknown> => {
      assertActivity(activity);
      const lookup: CurrentBindingLookup = Object.freeze({
        realtimeSessionRef: activity.realtimeSessionRef,
      });
      let current: RealtimeCurrentBindingProjection | undefined;
      try {
        current = await options.readCurrentBinding(lookup);
      } catch {
        throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_CURRENT_BINDING_UNAVAILABLE");
      }
      if (current === undefined) {
        throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_CURRENT_BINDING_UNAVAILABLE");
      }
      assertCurrentBinding(activity, current, options.equality);
      try {
        const projection = await options.readAuthorityProjection(Object.freeze({
          activity,
          currentBinding: current,
        }));
        if (projection === undefined || projection === null) {
          throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_PROJECTION_UNAVAILABLE");
        }
        return projection;
      } catch (error) {
        if (error instanceof ActivityAuthorityReaderError) throw error;
        throw new ActivityAuthorityReaderError("ACTIVITY_AUTHORITY_PROJECTION_UNAVAILABLE");
      }
    },
  });
}
