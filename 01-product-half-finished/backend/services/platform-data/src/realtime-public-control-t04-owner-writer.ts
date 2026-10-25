import type { Pool } from "pg";

import type { OpaqueEqualityPort } from "../../realtime-core/src/ports.ts";
import type {
  AcceptedUserActivity,
  RealtimeSessionRecord,
} from "../../realtime-core/src/types.ts";
import type { RealtimeAcceptedUserActivityOwnerEvent } from "../../realtime-core/src/realtime-session-service.ts";
import {
  createRealtimeAcceptedUserActivityProduction,
  type RealtimeAcceptedUserActivityOwnerEvent as ProductionOwnerEvent,
  type RealtimeAcceptedUserActivityOwnerSource,
} from "../../../phase0/gateway/src/realtime-accepted-user-activity-production.ts";
import {
  createAcceptedActivityStream,
  T04_ACCEPTED_ACTIVITY_EVENT_TYPE,
  type AcceptedActivityRecord,
  type AcceptedActivityStream,
  type AcceptedActivityStreamPool,
} from "./accepted-activity-stream.ts";

export const REALTIME_T04_ACCEPTED_USER_ACTIVITY_EVENT_TYPE = T04_ACCEPTED_ACTIVITY_EVENT_TYPE;
export const T04_ACCEPTED_USER_ACTIVITY_EVENT_TYPE = T04_ACCEPTED_ACTIVITY_EVENT_TYPE;
export const T04_ACCEPTED_USER_ACTIVITY_EVENT_VERSION = 1 as const;

export interface RealtimePublicControlT04OwnerEvent extends ProductionOwnerEvent {}

export interface RealtimePublicControlT04OwnerSource extends RealtimeAcceptedUserActivityOwnerSource {}

export interface RealtimePublicControlT04OwnerService {
  readonly recordAcceptedUserActivity: (
    activity: AcceptedUserActivity,
    ownerEvent?: RealtimeAcceptedUserActivityOwnerEvent,
  ) => Promise<RealtimeSessionRecord>;
}

export interface RealtimePublicControlT04OwnerWriterOptions {
  readonly pool: AcceptedActivityStreamPool;
  readonly service: RealtimePublicControlT04OwnerService;
  readonly source?: RealtimePublicControlT04OwnerSource;
  readonly stream?: AcceptedActivityStream;
  readonly equality?: Pick<OpaqueEqualityPort, "same">;
  readonly purpose?: string;
  readonly now?: () => number;
}

export interface RealtimePublicControlT04OwnerReadiness {
  readonly owner: "T04.accepted-user-activity";
  readonly environment: "production";
  readonly ready: boolean;
  readonly reason?: string;
}

export interface RealtimePublicControlT04OwnerWriter {
  readonly readiness: () => RealtimePublicControlT04OwnerReadiness;
  readonly bind: () => void;
  readonly write: (event: RealtimePublicControlT04OwnerEvent) => Promise<RealtimeSessionRecord>;
  readonly record: (event: RealtimePublicControlT04OwnerEvent) => Promise<RealtimeSessionRecord>;
  readonly read: (idempotencyKey: string) => Promise<AcceptedActivityRecord | undefined>;
  readonly readByIdempotency: (idempotencyKey: string) => Promise<AcceptedActivityRecord | undefined>;
  readonly close: () => Promise<void>;
}

function stable(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("T04_OWNER_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) {
    throw new Error("T04_OWNER_VALUE_INVALID");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stable(item, ancestors)).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function defaultEquality(): Pick<OpaqueEqualityPort, "same"> {
  return Object.freeze({
    same(left: Parameters<OpaqueEqualityPort["same"]>[0], right: Parameters<OpaqueEqualityPort["same"]>[1]): boolean {
      try { return stable(left) === stable(right); }
      catch { return false; }
    },
  });
}

function internalSource(
  capture: (consumer: (event: ProductionOwnerEvent) => Promise<RealtimeSessionRecord>) => void,
): RealtimeAcceptedUserActivityOwnerSource {
  return Object.freeze({
    owner: "T04.accepted-user-activity",
    environment: "production" as const,
    isReady: () => true,
    subscribe: (consumer: (event: ProductionOwnerEvent) => Promise<RealtimeSessionRecord>) => {
      capture(consumer);
      return () => undefined;
    },
  });
}

export function createRealtimePublicControlT04OwnerWriter(
  options: RealtimePublicControlT04OwnerWriterOptions,
): RealtimePublicControlT04OwnerWriter {
  if (options === null || typeof options !== "object" || options.pool === undefined ||
      typeof options.pool.connect !== "function" || options.service === undefined ||
      typeof options.service.recordAcceptedUserActivity !== "function") {
    throw new Error("T04_OWNER_WRITER_OPTIONS_INVALID");
  }
  if (options.stream !== undefined && typeof options.stream.readByIdempotency !== "function") {
    throw new Error("T04_OWNER_WRITER_STREAM_INVALID");
  }
  const purpose = options.purpose ?? "cycling_assistant";
  if (typeof purpose !== "string" || purpose.length === 0 || purpose !== purpose.trim()) {
    throw new Error("T04_OWNER_WRITER_PURPOSE_INVALID");
  }
  if (options.source !== undefined &&
      (options.source.environment !== "production" || typeof options.source.subscribe !== "function" ||
       typeof options.source.isReady !== "function")) {
    throw new Error("T04_OWNER_WRITER_SOURCE_INVALID");
  }

  let closed = false;
  let bound = false;
  let bridgeConsumer: ((event: ProductionOwnerEvent) => Promise<RealtimeSessionRecord>) | undefined;
  const source = options.source === undefined
    ? internalSource((consumer) => { bridgeConsumer = consumer; })
    : Object.freeze({
      ...options.source,
      subscribe: (consumer: (event: ProductionOwnerEvent) => Promise<RealtimeSessionRecord>) => {
        bridgeConsumer = consumer;
        return options.source!.subscribe(consumer);
      },
    });

  const bridge = createRealtimeAcceptedUserActivityProduction({
    source,
    equality: options.equality ?? defaultEquality(),
    purpose,
    ...(options.now === undefined ? {} : { now: options.now }),
    sink: {
      recordAcceptedUserActivity: (activity, ownerEvent) => options.service.recordAcceptedUserActivity(activity, ownerEvent),
    },
  });

  let stream: AcceptedActivityStream | undefined = options.stream;
  let ownsStream = false;
  const ensureStream = (): AcceptedActivityStream => {
    if (stream === undefined) {
      stream = createAcceptedActivityStream({
        pool: options.pool,
        source: "t04",
      });
      ownsStream = true;
    }
    return stream;
  };
  const ensureOpen = (): void => {
    if (closed) throw new Error("T04_OWNER_WRITER_CLOSED");
  };
  const bind = (): void => {
    ensureOpen();
    if (bound) return;
    bridge.bind();
    bound = true;
  };
  const write = async (event: RealtimePublicControlT04OwnerEvent): Promise<RealtimeSessionRecord> => {
    ensureOpen();
    bind();
    const consumer = bridgeConsumer;
    if (consumer === undefined) {
      throw new Error("T04_OWNER_WRITER_CONSUMER_UNAVAILABLE");
    }
    return consumer(event);
  };
  const read = async (idempotencyKey: string): Promise<AcceptedActivityRecord | undefined> => {
    ensureOpen();
    return ensureStream().readByIdempotency(idempotencyKey);
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await bridge.close();
    if (ownsStream) await stream?.close();
  };

  return Object.freeze({
    readiness: (): RealtimePublicControlT04OwnerReadiness => {
      let ready = false;
      let reason: string | undefined;
      if (closed) reason = "closed";
      else if (options.source !== undefined && options.source.environment !== "production") reason = "non_production_source";
      else {
        try { ready = options.source === undefined || options.source.isReady() === true; }
        catch { ready = false; }
        if (!ready) reason = "owner_source_not_ready";
      }
      return Object.freeze({
        owner: "T04.accepted-user-activity" as const,
        environment: "production" as const,
        ready,
        ...(reason === undefined ? {} : { reason }),
      });
    },
    bind,
    write,
    record: write,
    read,
    readByIdempotency: read,
    close,
  });
}

export const createRealtimePublicControlT04OwnerWriterPostgres = createRealtimePublicControlT04OwnerWriter;
export const createT04AcceptedUserActivityOwnerWriter = createRealtimePublicControlT04OwnerWriter;
