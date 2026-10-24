import {
  assertCanonicalTimestamp,
  incrementDecimalCounter,
  type ActivityRenewalResult,
  type AcceptedUserActivity,
  type CanonicalTimestamp,
  type OpaqueOwnerValue,
  type RealtimeActivity,
  type RealtimeSessionRecord,
  type VerifiedActivityAcceptance,
} from "./types.ts";

const CONTINUITY_MS = 24 * 60 * 60 * 1000;

export function acceptedActivityDeadline(value: CanonicalTimestamp): CanonicalTimestamp {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("INVALID_TIMESTAMP");
  return assertCanonicalTimestamp(new Date(millis + CONTINUITY_MS).toISOString());
}

/** Only an accepted user-originated activity may move this deadline forward. */
export function applyAcceptedUserActivityRenewal(
  session: RealtimeSessionRecord,
  activity: RealtimeActivity,
  verification?: VerifiedActivityAcceptance,
  sameOwnerRef?: (left: OpaqueOwnerValue, right: OpaqueOwnerValue) => boolean,
): { readonly session: RealtimeSessionRecord; readonly result: ActivityRenewalResult } {
  if (session.continuityState === "ended" || session.state === "terminal") {
    return {
      session,
      result: {
        renewed: false,
        reason: "already_ended",
        continuityExpiresAt: session.continuityExpiresAt,
        lastAcceptedUserActivityAt: session.lastAcceptedUserActivityAt,
      },
    };
  }
  if (activity.kind !== "accepted_user_activity" || activity.accepted !== true) {
    return {
      session,
      result: {
        renewed: false,
        reason: "non_renewing_activity",
        continuityExpiresAt: session.continuityExpiresAt,
        lastAcceptedUserActivityAt: session.lastAcceptedUserActivityAt,
      },
    };
  }
  if (verification?.verified !== true || sameOwnerRef === undefined ||
      !sameOwnerRef(verification.acceptanceRef, activity.acceptanceRef)) {
    return {
      session,
      result: {
        renewed: false,
        reason: "non_renewing_activity",
        continuityExpiresAt: session.continuityExpiresAt,
        lastAcceptedUserActivityAt: session.lastAcceptedUserActivityAt,
      },
    };
  }
  if (activity.userId !== session.userId || activity.deviceId !== session.activeDeviceId ||
      activity.continuityId !== session.continuityId) {
    throw new Error("ACTIVITY_BINDING_INVALID");
  }
  const occurredAt = assertCanonicalTimestamp(activity.occurredAt);
  const last = Date.parse(session.lastAcceptedUserActivityAt);
  const next = Date.parse(occurredAt);
  if (!Number.isFinite(last) || !Number.isFinite(next)) throw new Error("INVALID_TIMESTAMP");
  if (next < last) throw new Error("ACTIVITY_OUT_OF_ORDER");
  if (next === last) {
    return {
      session,
      result: {
        renewed: false,
        reason: "non_renewing_activity",
        continuityExpiresAt: session.continuityExpiresAt,
        lastAcceptedUserActivityAt: session.lastAcceptedUserActivityAt,
      },
    };
  }
  const expiresAt = acceptedActivityDeadline(occurredAt);
  const updated: RealtimeSessionRecord = {
    ...session,
    lastAcceptedUserActivityAt: occurredAt,
    continuityExpiresAt: Date.parse(expiresAt) > Date.parse(session.continuityExpiresAt)
      ? expiresAt
      : session.continuityExpiresAt,
    revision: incrementDecimalCounter(session.revision),
  };
  return {
    session: updated,
    result: {
      renewed: true,
      reason: "accepted_user_activity",
      continuityExpiresAt: updated.continuityExpiresAt,
      lastAcceptedUserActivityAt: updated.lastAcceptedUserActivityAt,
    },
  };
}

export function activityRenewsContinuity(kind: RealtimeActivity["kind"] | string): boolean {
  return kind === "accepted_user_activity";
}
