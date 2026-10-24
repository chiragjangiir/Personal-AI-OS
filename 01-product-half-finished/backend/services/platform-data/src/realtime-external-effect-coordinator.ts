import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { claimIdempotency, completeIdempotency } from "./idempotency-ledger.ts";
import {
  createRealtimeCredentialFence,
  normalizeCredentialFenceTuple,
  type CredentialFencePort,
  type CredentialFenceTuple,
} from "./realtime-credential-fence.ts";
import { enqueueOutboxEvent } from "./transactional-outbox.ts";
import { withTransaction } from "./transaction.ts";

export type JsonPrimitive = null | string | boolean | number;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonRecord = Record<string, unknown>;

export type RealtimeExternalEffectOperation = "media_stop" | "handoff";
export type RealtimeMediaCleanupStage =
  | "tracks_unpublished"
  | "participant_disconnected"
  | "credential_revoked"
  | "closure_verified";

export type ExternalEffectStageState = "pending" | "in_flight" | "completed" | "indeterminate";

export interface RealtimeMediaStopIntent {
  readonly wireRequest: unknown;
  readonly request: unknown;
  readonly governance: unknown;
  readonly fingerprint: string;
}

export interface RealtimeExternalEffectExecutor {
  /** Executes one provider cleanup stage. The executor owns provider access. */
  readonly executeStage?: (input: {
    readonly stage: RealtimeMediaCleanupStage;
    readonly intent: RealtimeMediaStopIntent;
  }) => Promise<void>;
  /** Alias accepted by callers that name the operation media-specific. */
  readonly executeMediaStage?: (input: {
    readonly stage: RealtimeMediaCleanupStage;
    readonly intent: RealtimeMediaStopIntent;
  }) => Promise<void>;
  /** Executes the old-device output suppression/closure fence for handoff. */
  readonly suppressAndClose?: (input: {
    readonly request: JsonRecord;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }) => Promise<unknown>;
  readonly executeHandoffSuppression?: (input: {
    readonly request: JsonRecord;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }) => Promise<unknown>;
  readonly close?: () => void | Promise<void>;
}

export interface RealtimeExternalEffectCoordinatorOptions {
  readonly pool: Pool;
  readonly executor: RealtimeExternalEffectExecutor;
  /** Optional shared fence seam; defaults to the pool-backed production fence. */
  readonly credentialFence?: CredentialFencePort;
  /** Test-only opaque claim token source; never a canonical reference issuer. */
  readonly claimId?: () => string;
  /** Test-only event id source; never a canonical reference issuer. */
  readonly eventId?: () => string;
}

export interface RealtimeExternalEffectClaimContext {
  readonly idempotencyContext: JsonRecord;
  readonly fingerprint: string;
}

export interface RealtimeMediaStopClaimInput extends RealtimeExternalEffectClaimContext {
  readonly intent: RealtimeMediaStopIntent;
}

export interface RealtimeHandoffClaimInput extends RealtimeExternalEffectClaimContext {
  readonly request: unknown;
  readonly wireRequest?: unknown;
}

export type RealtimeExternalEffectClaimInput =
  | RealtimeMediaStopClaimInput
  | RealtimeHandoffClaimInput;

export type RealtimeExternalEffectClaim =
  | { readonly disposition: "claimed"; readonly claimId: string }
  | { readonly disposition: "replay"; readonly result: JsonRecord }
  | { readonly disposition: "conflict" | "in_flight" | "indeterminate" };

export interface RealtimeExternalEffectCoordinatorPort {
  readonly claim: (input: RealtimeExternalEffectClaimInput) => Promise<RealtimeExternalEffectClaim>;
  readonly restore: (input: { readonly claimId: string }) => Promise<RealtimeMediaStopIntent | undefined>;
  readonly executeStage: (input: {
    readonly claimId: string;
    readonly stage: RealtimeMediaCleanupStage;
    readonly intent: RealtimeMediaStopIntent;
  }) => Promise<void>;
  readonly commit: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly result: JsonRecord;
  }) => Promise<void>;
  readonly release: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
  }) => Promise<void>;
  readonly suppressAndClose: (input: {
    readonly request: unknown;
    readonly fingerprint: string;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }) => Promise<unknown>;
  readonly reconcileStage: (input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly stage: RealtimeMediaCleanupStage | "handoff_suppression";
    readonly outcome: "applied" | "not_applied" | "indeterminate";
    readonly result?: unknown;
  }) => Promise<void>;
  readonly close: () => Promise<void>;
}

export class RealtimeExternalEffectError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "RealtimeExternalEffectError";
    this.code = code;
    this.retryable = retryable;
  }
}

const HASH = /^[0-9a-f]{64}$/u;
const DECIMAL = /^[1-9][0-9]{0,37}$/u;
const CLAIM_ID = /^\S{1,256}$/u;
const OPERATION_SCOPE: Readonly<Record<RealtimeExternalEffectOperation, string>> = Object.freeze({
  media_stop: "realtime.external.media_stop",
  handoff: "realtime.external.handoff",
});
const MEDIA_STAGES: ReadonlySet<string> = new Set([
  "tracks_unpublished",
  "participant_disconnected",
  "credential_revoked",
  "closure_verified",
]);
const HANDOFF_STAGE = "handoff_suppression";
// Longer than any live media-stop stage (gateway executor timeout 30s) between two updated_at bumps.
const STALLED_ATTEMPT_SECONDS = 120;
const EFFECT_EVENT_TYPE = "realtime.external_effect.claimed";
const COMMIT_EVENT_TYPE = "realtime.external_effect.committed";
const STAGE_EVENT_TYPE = "realtime.external_effect.stage_completed";

type StoredStage = Readonly<{
  state: ExternalEffectStageState;
  updatedAt: string;
}>;

interface EffectRow {
  readonly effectId: string;
  readonly operation: RealtimeExternalEffectOperation;
  readonly requestScope: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly fingerprintSha256: string;
  readonly wireRequest: JsonRecord;
  readonly intent: JsonRecord;
  readonly claimId: string;
  readonly fencingEpoch: string;
  readonly expectedConnectionEpoch?: string;
  readonly expectedLeaseVersion?: string;
  readonly credentialFence?: CredentialFenceTuple;
  readonly effectState: "in_flight" | "committed" | "released" | "indeterminate";
  readonly stageState: Readonly<Record<string, StoredStage>>;
  readonly suppressionResult?: unknown;
  readonly result?: JsonRecord;
  readonly resultSha256?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_JSON_INVALID");
    return value;
  }
  if (typeof value !== "object" || value === undefined || seen.has(value)) {
    throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_JSON_INVALID");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => cloneJson(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (!isPlainObject(value)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_JSON_INVALID");
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = cloneJson(value[key], seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function jsonText(value: unknown): string {
  return JSON.stringify(cloneJson(value));
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(jsonText(value), "utf8").digest("hex");
}

function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function textHash(value: string): string {
  if (!HASH.test(value)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_HASH_INVALID");
  return value;
}

function stringValue(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RealtimeExternalEffectError(code);
  }
  return value;
}

function recordValue(value: unknown, code: string): JsonRecord {
  if (!isPlainObject(value)) throw new RealtimeExternalEffectError(code);
  return cloneJson(value) as JsonRecord;
}

function requestRecord(value: unknown, code: string): JsonRecord {
  return recordValue(value, code);
}

function decimalValue(value: unknown, code: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new RealtimeExternalEffectError(code);
  return value;
}

function incrementDecimal(value: string): string {
  if (!DECIMAL.test(value)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_FENCE_INVALID");
  const next = (BigInt(value) + 1n).toString(10);
  if (!DECIMAL.test(next)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_FENCE_EXHAUSTED");
  return next;
}

function nowIso(): string {
  return new Date().toISOString();
}

function extractIdempotencyKey(context: JsonRecord): string {
  return stringValue(context.idempotency_key, "EXTERNAL_EFFECT_IDEMPOTENCY_KEY_INVALID");
}

function operationOf(input: RealtimeExternalEffectClaimInput): RealtimeExternalEffectOperation {
  if ("intent" in input) {
    if (requestRecord(input.intent.request, "EXTERNAL_EFFECT_REQUEST_INVALID").operation !== "media_stop") {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_MEDIA_OPERATION_INVALID");
    }
    return "media_stop";
  }
  if (requestRecord(input.request, "EXTERNAL_EFFECT_REQUEST_INVALID").operation !== "handoff") {
    throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_HANDOFF_OPERATION_INVALID");
  }
  return "handoff";
}

function expectedEpoch(input: RealtimeExternalEffectClaimInput): string | undefined {
  const request = requestRecord("intent" in input ? input.intent.request : input.request, "EXTERNAL_EFFECT_REQUEST_INVALID");
  return decimalValue(
    request.expectedConnectionEpoch ?? request.expected_connection_epoch ?? request.connectionEpoch ?? request.connection_epoch,
    "EXTERNAL_EFFECT_CONNECTION_EPOCH_INVALID",
  );
}

function expectedLeaseVersion(input: RealtimeExternalEffectClaimInput): string | undefined {
  const request = requestRecord("intent" in input ? input.intent.request : input.request, "EXTERNAL_EFFECT_REQUEST_INVALID");
  return decimalValue(
    request.expectedLeaseVersion ?? request.expected_lease_version ?? request.leaseVersion ?? request.lease_version,
    "EXTERNAL_EFFECT_LEASE_VERSION_INVALID",
  );
}

function credentialFence(input: RealtimeExternalEffectClaimInput): CredentialFenceTuple | undefined {
  if (!("intent" in input)) return undefined;
  const request = requestRecord(input.intent.request, "EXTERNAL_EFFECT_REQUEST_INVALID");
  const values = {
    realtimeSessionRef: request.realtimeSessionRef ?? request.realtime_session_ref,
    deviceLeaseRef: request.deviceLeaseRef ?? request.device_lease_ref,
    continuityId: request.continuityId ?? request.continuity_id,
    connectionEpoch: request.expectedConnectionEpoch ?? request.expected_connection_epoch ??
      request.connectionEpoch ?? request.connection_epoch,
    credentialGeneration: request.credentialGeneration ?? request.credential_generation,
  };
  // Existing T11B media-stop requests predate the durable credential fence.
  // They remain on the legacy path until an owner-issued generation is present.
  if (values.credentialGeneration === undefined || values.credentialGeneration === null) return undefined;
  try {
    return normalizeCredentialFenceTuple(values);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CREDENTIAL_FENCE_")) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CREDENTIAL_FENCE_INVALID", false, error);
    }
    throw error;
  }
}

function validateFingerprint(value: unknown): string {
  return stringValue(value, "EXTERNAL_EFFECT_FINGERPRINT_INVALID", 262144);
}

function claimInputValues(input: RealtimeExternalEffectClaimInput): {
  readonly operation: RealtimeExternalEffectOperation;
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly fingerprintSha256: string;
  readonly wireRequest: JsonRecord;
  readonly intent: JsonRecord;
  readonly expectedConnectionEpoch?: string;
  readonly expectedLeaseVersion?: string;
  readonly credentialFence?: CredentialFenceTuple;
} {
  if (!input || !isPlainObject(input.idempotencyContext)) {
    throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_IDEMPOTENCY_CONTEXT_INVALID");
  }
  const operation = operationOf(input);
  const fingerprint = validateFingerprint(input.fingerprint);
  const wireRequest = "intent" in input
    ? recordValue(input.intent.wireRequest, "EXTERNAL_EFFECT_WIRE_REQUEST_INVALID")
    : recordValue(input.wireRequest ?? input.request, "EXTERNAL_EFFECT_WIRE_REQUEST_INVALID");
  const intent = "intent" in input
    ? recordValue(input.intent as unknown, "EXTERNAL_EFFECT_INTENT_INVALID")
    : recordValue({
      wireRequest,
      request: recordValue(input.request, "EXTERNAL_EFFECT_REQUEST_INVALID"),
      fingerprint,
    }, "EXTERNAL_EFFECT_INTENT_INVALID");
  const expectedConnectionEpoch = expectedEpoch(input);
  const expectedLeaseVersionValue = expectedLeaseVersion(input);
  const credentialFenceValue = credentialFence(input);
  return Object.freeze({
    operation,
    scope: OPERATION_SCOPE[operation],
    key: extractIdempotencyKey(input.idempotencyContext),
    fingerprint,
    fingerprintSha256: textSha256(fingerprint),
    wireRequest,
    intent,
    ...(expectedConnectionEpoch === undefined ? {} : { expectedConnectionEpoch }),
    ...(expectedLeaseVersionValue === undefined ? {} : { expectedLeaseVersion: expectedLeaseVersionValue }),
    ...(credentialFenceValue === undefined ? {} : { credentialFence: credentialFenceValue }),
  });
}

function stageObject(value: unknown): Readonly<Record<string, StoredStage>> {
  if (value === null || value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_STATE_INVALID");
  const result: Record<string, StoredStage> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!isPlainObject(item)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_STATE_INVALID");
    const state = item.state;
    if (state !== "pending" && state !== "in_flight" && state !== "completed" && state !== "indeterminate") {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_STATE_INVALID");
    }
    result[name] = Object.freeze({ state, updatedAt: stringValue(item.updatedAt, "EXTERNAL_EFFECT_STAGE_STATE_INVALID", 64) });
  }
  return Object.freeze(result);
}

function rowFrom(row: QueryResultRow): EffectRow {
  const effectId = stringValue(row.effect_id, "EXTERNAL_EFFECT_ROW_INVALID");
  const operation = row.operation;
  if (operation !== "media_stop" && operation !== "handoff") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_ROW_INVALID");
  const effectState = row.effect_state;
  if (effectState !== "in_flight" && effectState !== "committed" && effectState !== "released" && effectState !== "indeterminate") {
    throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_ROW_INVALID");
  }
  const fingerprint = stringValue(row.fingerprint, "EXTERNAL_EFFECT_ROW_INVALID", 262144);
  const fingerprintSha256 = textHash(String(row.fingerprint_sha256).trim());
  if (textSha256(fingerprint) !== fingerprintSha256) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_ROW_FINGERPRINT_INVALID");
  const resultPresent = row.result !== null && row.result !== undefined;
  const resultSha256 = row.result_sha256 === null || row.result_sha256 === undefined
    ? undefined
    : textHash(String(row.result_sha256).trim());
  if (resultPresent !== (resultSha256 !== undefined)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_ROW_RESULT_INVALID");
  const result = resultPresent ? recordValue(row.result, "EXTERNAL_EFFECT_ROW_RESULT_INVALID") : undefined;
  if (result !== undefined && jsonHash(result) !== resultSha256) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_ROW_RESULT_INVALID");
  const expectedConnectionEpoch = row.expected_connection_epoch === null || row.expected_connection_epoch === undefined
    ? undefined : decimalValue(String(row.expected_connection_epoch), "EXTERNAL_EFFECT_ROW_INVALID");
  const expectedLeaseVersion = row.expected_lease_version === null || row.expected_lease_version === undefined
    ? undefined : decimalValue(String(row.expected_lease_version), "EXTERNAL_EFFECT_ROW_INVALID");
  const fencePresent = [
    row.realtime_session_ref, row.device_lease_ref, row.continuity_id,
    row.connection_epoch, row.credential_generation,
  ].some((value) => value !== null && value !== undefined);
  let credentialFenceValue: CredentialFenceTuple | undefined;
  if (fencePresent) {
    try {
      credentialFenceValue = normalizeCredentialFenceTuple({
        realtimeSessionRef: row.realtime_session_ref,
        deviceLeaseRef: row.device_lease_ref,
        continuityId: row.continuity_id,
        connectionEpoch: row.connection_epoch === null || row.connection_epoch === undefined
          ? undefined : String(row.connection_epoch),
        credentialGeneration: row.credential_generation === null || row.credential_generation === undefined
          ? undefined : String(row.credential_generation),
      });
    } catch (error) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CREDENTIAL_FENCE_INVALID", false, error);
    }
  }
  const base = {
    effectId,
    operation,
    requestScope: stringValue(row.request_scope, "EXTERNAL_EFFECT_ROW_INVALID"),
    idempotencyKey: stringValue(row.idempotency_key, "EXTERNAL_EFFECT_ROW_INVALID"),
    fingerprint,
    fingerprintSha256,
    wireRequest: recordValue(row.wire_request, "EXTERNAL_EFFECT_ROW_INVALID"),
    intent: recordValue(row.intent, "EXTERNAL_EFFECT_ROW_INVALID"),
    claimId: stringValue(row.claim_id, "EXTERNAL_EFFECT_ROW_INVALID"),
    fencingEpoch: decimalValue(String(row.fencing_epoch), "EXTERNAL_EFFECT_ROW_INVALID")!,
    ...(expectedConnectionEpoch === undefined ? {} : { expectedConnectionEpoch }),
    ...(expectedLeaseVersion === undefined ? {} : { expectedLeaseVersion }),
    ...(credentialFenceValue === undefined ? {} : { credentialFence: credentialFenceValue }),
    effectState,
    stageState: stageObject(row.stage_state),
    ...(row.suppression_result === null || row.suppression_result === undefined ? {} : { suppressionResult: cloneJson(row.suppression_result) }),
  };
  if (result === undefined) return Object.freeze(base);
  if (resultSha256 === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_ROW_RESULT_INVALID");
  return Object.freeze({ ...base, result, resultSha256 });
}

const SELECT_COLUMNS = [
  "effect_id, operation, request_scope, idempotency_key, fingerprint, fingerprint_sha256,",
  "wire_request, intent, claim_id, fencing_epoch::text AS fencing_epoch,",
  "expected_connection_epoch::text AS expected_connection_epoch,",
  "expected_lease_version::text AS expected_lease_version,",
  "realtime_session_ref, device_lease_ref, continuity_id,",
  "connection_epoch::text AS connection_epoch, credential_generation::text AS credential_generation,",
  "effect_state, stage_state,",
  "suppression_result, result, result_sha256, created_at, claimed_at, committed_at,",
  "released_at, updated_at",
].join(" ");

function isManagedError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && code.startsWith("EXTERNAL_EFFECT_");
}

function claimEventPayload(row: {
  readonly effectId: string;
  readonly operation: RealtimeExternalEffectOperation;
  readonly scope: string;
  readonly key: string;
  readonly fingerprintSha256: string;
  readonly claimId: string;
  readonly fencingEpoch: string;
}): JsonRecord {
  return Object.freeze({
    effect_id: row.effectId,
    operation: row.operation,
    request_scope: row.scope,
    idempotency_key: row.key,
    fingerprint_sha256: row.fingerprintSha256,
    claim_id: row.claimId,
    fencing_epoch: row.fencingEpoch,
  });
}

export class RealtimeExternalEffectCoordinator implements RealtimeExternalEffectCoordinatorPort {
  readonly #pool: Pool;
  readonly #executor: RealtimeExternalEffectExecutor;
  readonly #credentialFence: CredentialFencePort;
  readonly #claimId: () => string;
  readonly #eventId: () => string;
  #closed = false;
  #closeFlight: Promise<void> | undefined;

  constructor(pool: Pool, options: Omit<RealtimeExternalEffectCoordinatorOptions, "pool">) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool is required");
    if (!options || !options.executor) throw new TypeError("external effect executor is required");
    this.#pool = pool;
    this.#executor = options.executor;
    this.#credentialFence = options.credentialFence ?? createRealtimeCredentialFence(pool);
    this.#claimId = options.claimId ?? randomUUID;
    this.#eventId = options.eventId ?? randomUUID;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_COORDINATOR_CLOSED");
  }

  async claim(input: RealtimeExternalEffectClaimInput): Promise<RealtimeExternalEffectClaim> {
    this.#assertOpen();
    const values = claimInputValues(input);
    const fencingEpoch = "1";
    return withTransaction(this.#pool, async (client) => {
      if (values.credentialFence !== undefined) {
        await this.#credentialFence.lock(client, values.credentialFence);
      }
      const idempotency = await claimIdempotency(client, {
        scope: values.scope,
        idempotencyKey: values.key,
        requestHash: values.fingerprintSha256,
        fencingEpoch,
      });
      const existing = await this.#readEffect(client, values.scope, values.key);
      if (existing !== undefined) {
        this.#assertSameRequest(existing, values);
        if (existing.effectState === "committed") {
          if (existing.result === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_INDETERMINATE");
          return Object.freeze({ disposition: "replay" as const, result: existing.result });
        }
        const mediaStop = existing.operation === "media_stop";
        const unsettled = Object.values(existing.stageState).some((stage) => stage.state === "in_flight" || stage.state === "indeterminate");
        if (existing.effectState === "released" && idempotency.kind === "in_flight") {
          if (unsettled && !mediaStop) return Object.freeze({ disposition: "indeterminate" as const });
          return this.#reclaim(client, existing, values);
        }
        if (existing.effectState === "in_flight" && mediaStop && idempotency.kind === "in_flight" &&
            await this.#stalled(client, existing.effectId)) {
          return this.#reclaim(client, existing, values);
        }
        if (existing.effectState === "in_flight") {
          if (!mediaStop && Object.values(existing.stageState).some((stage) => stage.state === "indeterminate")) {
            return Object.freeze({ disposition: "indeterminate" as const });
          }
          if (idempotency.kind === "replay") {
            throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_INDETERMINATE");
          }
          return Object.freeze({ disposition: "in_flight" as const });
        }
        return Object.freeze({ disposition: "indeterminate" as const });
      }
      if (idempotency.kind === "replay" || idempotency.kind === "terminal") {
        return Object.freeze({ disposition: "indeterminate" as const });
      }
      if (idempotency.kind !== "new") return Object.freeze({ disposition: "in_flight" as const });
      if (values.credentialFence !== undefined) {
        await this.#credentialFence.install(client, values.credentialFence).catch((error: unknown) => {
          if (error instanceof Error && error.message === "CREDENTIAL_FENCE_ACTIVE") {
            throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CREDENTIAL_FENCE_CONFLICT", false, error);
          }
          throw error;
        });
      }
      const effectId = randomUUID();
      const claimId = this.#claimId();
      if (!CLAIM_ID.test(claimId)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_ID_INVALID");
      const intent = values.intent;
      await client.query(
        [
          "INSERT INTO realtime_external_effects (",
          "effect_id, operation, request_scope, idempotency_key, fingerprint, fingerprint_sha256,",
          "wire_request, intent, claim_id, fencing_epoch, expected_connection_epoch,",
          "expected_lease_version, realtime_session_ref, device_lease_ref, continuity_id,",
          "connection_epoch, credential_generation, effect_state, stage_state, created_at, claimed_at, updated_at",
          ") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12,",
          "$13::jsonb, $14::jsonb, $15, $16::numeric, $17::numeric, 'in_flight', '{}'::jsonb, now(), now(), now())",
        ].join(" "),
        [
          effectId,
          values.operation,
          values.scope,
          values.key,
          values.fingerprint,
          values.fingerprintSha256,
          jsonText(values.wireRequest),
          jsonText(intent),
          claimId,
          fencingEpoch,
          values.expectedConnectionEpoch ?? null,
          values.expectedLeaseVersion ?? null,
          values.credentialFence === undefined ? null : jsonText(values.credentialFence.realtimeSessionRef),
          values.credentialFence === undefined ? null : jsonText(values.credentialFence.deviceLeaseRef),
          values.credentialFence?.continuityId ?? null,
          values.credentialFence?.connectionEpoch ?? null,
          values.credentialFence?.credentialGeneration ?? null,
        ],
      );
      const payload = claimEventPayload({
        effectId,
        operation: values.operation,
        scope: values.scope,
        key: values.key,
        fingerprintSha256: values.fingerprintSha256,
        claimId,
        fencingEpoch,
      });
      await this.#enqueue(client, EFFECT_EVENT_TYPE, effectId, values.scope, values.key, payload);
      return Object.freeze({ disposition: "claimed" as const, claimId });
    }).catch((error: unknown) => {
      if (isManagedError(error)) throw error;
      if (errorCode(error) === "IDEMPOTENCY_CONFLICT") {
        throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT");
      }
      throw error;
    });
  }

  async restore(input: { readonly claimId: string }): Promise<any> {
    this.#assertOpen();
    const claimId = stringValue(input?.claimId, "EXTERNAL_EFFECT_CLAIM_ID_INVALID");
    const row = await withTransaction(this.#pool, async (client) => {
      const result = await client.query(
        "SELECT " + SELECT_COLUMNS + " FROM realtime_external_effects WHERE claim_id = $1 FOR UPDATE",
        [claimId],
      );
      return result.rows.length === 0 ? undefined : rowFrom(result.rows[0]!);
    });
    if (row === undefined || row.operation !== "media_stop" || row.effectState === "released" || row.effectState === "indeterminate") {
      return undefined;
    }
    const intent = recordValue(row.intent, "EXTERNAL_EFFECT_INTENT_INVALID") as unknown as RealtimeMediaStopIntent;
    if (requestRecord(intent.request, "EXTERNAL_EFFECT_INTENT_INVALID").operation !== "media_stop" || intent.fingerprint !== row.fingerprint) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_INTENT_INDETERMINATE");
    }
    return Object.freeze(intent);
  }

  async executeStage(input: {
    readonly claimId: string;
    readonly stage: RealtimeMediaCleanupStage;
    readonly intent: RealtimeMediaStopIntent;
  }): Promise<void> {
    this.#assertOpen();
    if (!MEDIA_STAGES.has(input?.stage)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_INVALID");
    const claimId = stringValue(input?.claimId, "EXTERNAL_EFFECT_CLAIM_ID_INVALID");
    const intent = recordValue(input?.intent, "EXTERNAL_EFFECT_INTENT_INVALID") as unknown as RealtimeMediaStopIntent;
    if (requestRecord(intent.request, "EXTERNAL_EFFECT_INTENT_INVALID").operation !== "media_stop" || intent.fingerprint.length === 0) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_INTENT_INVALID");
    }
    const shouldExecute = await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffectByClaim(client, claimId);
      if (row === undefined || row.operation !== "media_stop") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertSameIntent(row, intent);
      if (row.effectState !== "in_flight") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_NOT_ACTIVE");
      const state = row.stageState[input.stage];
      if (state?.state === "completed") return false;
      // Media cleanup stages are idempotent against the provider's own state (unpublish, remove, verify), so a stage
      // left in_flight or indeterminate by a failed or dead attempt is re-executed: retrying is the reconciliation.
      const next = this.#stageJson(row.stageState, input.stage, "in_flight");
      await client.query(
        "UPDATE realtime_external_effects SET stage_state = $2::jsonb, updated_at = now() WHERE effect_id = $1 AND effect_state = 'in_flight' AND claim_id = $3",
        [row.effectId, jsonText(next), claimId],
      );
      return true;
    });
    if (!shouldExecute) return;
    const executor = this.#executor.executeStage ?? this.#executor.executeMediaStage;
    if (executor === undefined) {
      await this.#markStage(claimId, intent.fingerprint, input.stage, "indeterminate");
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_EXECUTOR_STAGE_REQUIRED");
    }
    try {
      await executor({ stage: input.stage, intent });
    } catch (error) {
      // The stage is idempotent: a failed attempt leaves it pending, so this claim can be released and retried.
      await this.#markStage(claimId, intent.fingerprint, input.stage, "pending");
      throw error;
    }
    await this.#markStage(claimId, intent.fingerprint, input.stage, "completed");
  }

  async suppressAndClose(input: {
    readonly request: unknown;
    readonly fingerprint: string;
    readonly authorityResult: unknown;
    readonly previousBinding?: unknown;
  }): Promise<unknown> {
    this.#assertOpen();
    const request = recordValue(input?.request, "EXTERNAL_EFFECT_HANDOFF_REQUEST_INVALID");
    const fingerprint = validateFingerprint(input?.fingerprint);
    const key = stringValue(
      request.idempotencyKey ?? request.idempotency_key,
      "EXTERNAL_EFFECT_IDEMPOTENCY_KEY_INVALID",
    );
    const scope = OPERATION_SCOPE.handoff;
    const shouldExecute = await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffect(client, scope, key);
      if (row === undefined || row.operation !== "handoff") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState !== "in_flight") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_NOT_ACTIVE");
      const state = row.stageState[HANDOFF_STAGE];
      if (state?.state === "completed") return { execute: false, result: row.suppressionResult };
      if (state?.state === "in_flight" || state?.state === "indeterminate") {
        throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_INDETERMINATE");
      }
      const next = this.#stageJson(row.stageState, HANDOFF_STAGE, "in_flight");
      await client.query(
        "UPDATE realtime_external_effects SET stage_state = $2::jsonb, updated_at = now() WHERE effect_id = $1 AND effect_state = 'in_flight' AND fingerprint_sha256 = $3",
        [row.effectId, jsonText(next), row.fingerprintSha256],
      );
      return { execute: true as const };
    });
    if (!shouldExecute.execute) return shouldExecute.result;
    const executor = this.#executor.suppressAndClose ?? this.#executor.executeHandoffSuppression;
    if (executor === undefined) {
      await this.#markSuppressionFailure(scope, key, fingerprint);
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_EXECUTOR_SUPPRESSION_REQUIRED");
    }
    let result: unknown;
    try {
      result = await executor({ request, authorityResult: input.authorityResult, ...(input.previousBinding === undefined ? {} : {previousBinding:input.previousBinding}) });
      cloneJson(result);
    } catch (error) {
      await this.#markSuppressionFailure(scope, key, fingerprint);
      throw error;
    }
    await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffect(client, scope, key);
      if (row === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState !== "in_flight") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_NOT_ACTIVE");
      const next = this.#stageJson(row.stageState, HANDOFF_STAGE, "completed");
      await client.query(
        "UPDATE realtime_external_effects SET stage_state = $2::jsonb, suppression_result = $3::jsonb, updated_at = now() WHERE effect_id = $1 AND effect_state = 'in_flight' AND fingerprint_sha256 = $4",
        [row.effectId, jsonText(next), jsonText(result), row.fingerprintSha256],
      );
      const payload = Object.freeze({
        effect_id: row.effectId,
        operation: row.operation,
        request_scope: row.requestScope,
        idempotency_key: row.idempotencyKey,
        fingerprint_sha256: row.fingerprintSha256,
        stage: HANDOFF_STAGE,
      });
      await this.#enqueue(client, STAGE_EVENT_TYPE, row.effectId, row.requestScope, row.idempotencyKey, payload);
    });
    return result;
  }

  async commit(input: { readonly claimId: string; readonly fingerprint: string; readonly result: JsonRecord }): Promise<void> {
    this.#assertOpen();
    const claimId = stringValue(input?.claimId, "EXTERNAL_EFFECT_CLAIM_ID_INVALID");
    const fingerprint = validateFingerprint(input?.fingerprint);
    const result = recordValue(input?.result, "EXTERNAL_EFFECT_RESULT_INVALID");
    await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffectByClaim(client, claimId);
      if (row === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState === "committed") {
        if (row.result === undefined || jsonText(row.result) !== jsonText(result)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_RESULT_CONFLICT");
        return;
      }
      if (row.effectState !== "in_flight") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_NOT_ACTIVE");
      if (row.operation === "handoff" && row.stageState[HANDOFF_STAGE]?.state !== "completed") {
        throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_SUPPRESSION_REQUIRED");
      }
      const resultHash = jsonHash(result);
      await client.query(
        [
          "UPDATE realtime_external_effects SET effect_state = 'committed', result = $2::jsonb,",
          "result_sha256 = $3, committed_at = now(), updated_at = now()",
          "WHERE effect_id = $1 AND claim_id = $4 AND fingerprint_sha256 = $5 AND effect_state = 'in_flight'",
        ].join(" "),
        [row.effectId, jsonText(result), resultHash, claimId, row.fingerprintSha256],
      );
      await completeIdempotency(
        client,
        {
          scope: row.requestScope,
          idempotencyKey: row.idempotencyKey,
          requestHash: row.fingerprintSha256,
          fencingEpoch: row.fencingEpoch,
        },
        result,
        resultHash,
      );
      const payload = Object.freeze({
        effect_id: row.effectId,
        operation: row.operation,
        request_scope: row.requestScope,
        idempotency_key: row.idempotencyKey,
        fingerprint_sha256: row.fingerprintSha256,
        claim_id: claimId,
        fencing_epoch: row.fencingEpoch,
        result_sha256: resultHash,
      });
      await this.#enqueue(client, COMMIT_EVENT_TYPE, row.effectId, row.requestScope, row.idempotencyKey, payload);
    });
  }

  async release(input: { readonly claimId: string; readonly fingerprint: string }): Promise<void> {
    this.#assertOpen();
    const claimId = stringValue(input?.claimId, "EXTERNAL_EFFECT_CLAIM_ID_INVALID");
    const fingerprint = validateFingerprint(input?.fingerprint);
    await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffectByClaim(client, claimId);
      if (row === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState === "committed" || row.effectState === "released") return;
      if (row.effectState === "indeterminate") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_INDETERMINATE");
      if (Object.values(row.stageState).some((stage) => stage.state === "in_flight" || stage.state === "indeterminate")) {
        throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_INDETERMINATE");
      }
      await client.query(
        "UPDATE realtime_external_effects SET effect_state = 'released', released_at = now(), updated_at = now() WHERE effect_id = $1 AND claim_id = $2 AND fingerprint_sha256 = $3 AND effect_state = 'in_flight'",
        [row.effectId, claimId, row.fingerprintSha256],
      );
    });
  }

  async reconcileStage(input: {
    readonly claimId: string;
    readonly fingerprint: string;
    readonly stage: RealtimeMediaCleanupStage | "handoff_suppression";
    readonly outcome: "applied" | "not_applied" | "indeterminate";
    readonly result?: unknown;
  }): Promise<void> {
    this.#assertOpen();
    if (input.stage !== HANDOFF_STAGE && !MEDIA_STAGES.has(input.stage)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_STAGE_INVALID");
    const claimId = stringValue(input?.claimId, "EXTERNAL_EFFECT_CLAIM_ID_INVALID");
    const fingerprint = validateFingerprint(input?.fingerprint);
    if (input.outcome === "applied") cloneJson(input.result ?? {});
    await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffectByClaim(client, claimId);
      if (row === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState !== "in_flight") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_NOT_ACTIVE");
      const state: ExternalEffectStageState = input.outcome === "applied"
        ? "completed" : input.outcome === "not_applied" ? "pending" : "indeterminate";
      const next = this.#stageJson(row.stageState, input.stage, state);
      await client.query(
        "UPDATE realtime_external_effects SET stage_state = $2::jsonb, suppression_result = CASE WHEN $3 = 'handoff_suppression' AND $4 = 'applied' THEN $5::jsonb ELSE suppression_result END, updated_at = now() WHERE effect_id = $1 AND claim_id = $6 AND fingerprint_sha256 = $7 AND effect_state = 'in_flight'",
        [row.effectId, jsonText(next), input.stage, input.outcome, jsonText(input.result ?? {}), claimId, row.fingerprintSha256],
      );
      if (input.outcome === "applied") {
        const payload = Object.freeze({
          effect_id: row.effectId,
          operation: row.operation,
          request_scope: row.requestScope,
          idempotency_key: row.idempotencyKey,
          fingerprint_sha256: row.fingerprintSha256,
          claim_id: claimId,
          stage: input.stage,
          reconciled: true,
        });
        await this.#enqueue(client, STAGE_EVENT_TYPE, row.effectId, row.requestScope, row.idempotencyKey, payload, `reconciled-${input.stage}`);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    this.#closed = true;
    this.#closeFlight = (async () => {
      if (typeof this.#executor.close === "function") await this.#executor.close();
      await this.#credentialFence.close();
    })();
    return this.#closeFlight;
  }

  async #readEffect(client: PoolClient, scope: string, key: string): Promise<EffectRow | undefined> {
    const result = await client.query(
      "SELECT " + SELECT_COLUMNS + " FROM realtime_external_effects WHERE request_scope = $1 AND idempotency_key = $2 FOR UPDATE",
      [scope, key],
    );
    return result.rows.length === 0 ? undefined : rowFrom(result.rows[0]!);
  }

  async #readEffectByClaim(client: PoolClient, claimId: string): Promise<EffectRow | undefined> {
    const result = await client.query(
      "SELECT " + SELECT_COLUMNS + " FROM realtime_external_effects WHERE claim_id = $1 FOR UPDATE",
      [claimId],
    );
    return result.rows.length === 0 ? undefined : rowFrom(result.rows[0]!);
  }

  #assertFingerprint(row: EffectRow, fingerprint: string): void {
    if (row.fingerprint !== fingerprint || row.fingerprintSha256 !== textSha256(fingerprint)) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT");
    }
  }

  #assertSameRequest(row: EffectRow, values: ReturnType<typeof claimInputValues>): void {
    if (row.operation !== values.operation || row.fingerprint !== values.fingerprint ||
        row.fingerprintSha256 !== values.fingerprintSha256) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT");
    }
    // A media stop is identified by its wire request. The binding it derived (lease version, credential fence) is
    // captured at its first claim and its stored intent drives every retry, even after its own release moved the lease.
    if (row.operation === "media_stop") return;
    if (row.expectedConnectionEpoch !== values.expectedConnectionEpoch ||
        row.expectedLeaseVersion !== values.expectedLeaseVersion ||
        (row.credentialFence === undefined) !== (values.credentialFence === undefined) ||
        (row.credentialFence !== undefined && values.credentialFence !== undefined &&
          JSON.stringify(row.credentialFence) !== JSON.stringify(values.credentialFence))) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT");
    }
  }

  #assertSameIntent(row: EffectRow, intent: RealtimeMediaStopIntent): void {
    this.#assertFingerprint(row, intent.fingerprint);
    if (jsonText(row.intent) !== jsonText(recordValue(intent as unknown, "EXTERNAL_EFFECT_INTENT_INVALID"))) {
      throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_INTENT_CONFLICT");
    }
  }

  /** An attempt that has not touched its effect for longer than any live stage can take (each stage is bounded
   * by the executor timeout and bumps updated_at) is dead, e.g. its gateway process was restarted mid-stop. */
  async #stalled(client: PoolClient, effectId: string): Promise<boolean> {
    const result = await client.query(
      "SELECT updated_at < now() - make_interval(secs => $2) AS stalled FROM realtime_external_effects WHERE effect_id = $1",
      [effectId, STALLED_ATTEMPT_SECONDS],
    );
    return result.rows[0]?.stalled === true;
  }

  /** Re-claims a released or stalled media stop. Completed stage evidence is kept; unfinished stages return to
   * pending because media cleanup is idempotent. The new claim id and fence reject any straggler of the old attempt. */
  async #reclaim(
    client: PoolClient,
    existing: EffectRow,
    values: ReturnType<typeof claimInputValues>,
  ): Promise<RealtimeExternalEffectClaim> {
    const claimId = this.#claimId();
    const eventFence = incrementDecimal(existing.fencingEpoch);
    if (!CLAIM_ID.test(claimId)) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_ID_INVALID");
    const stages: Record<string, JsonValue> = {};
    for (const [name, value] of Object.entries(existing.stageState)) {
      if (value.state === "completed") stages[name] = { state: value.state, updatedAt: value.updatedAt };
    }
    await client.query(
      [
        "UPDATE realtime_external_effects SET effect_state = 'in_flight', claim_id = $3,",
        "fencing_epoch = $4, stage_state = $6::jsonb, result = NULL, result_sha256 = NULL, released_at = NULL,",
        "claimed_at = now(), updated_at = now()",
        "WHERE request_scope = $1 AND idempotency_key = $2 AND effect_state = $5 AND claim_id = $7",
      ].join(" "),
      [values.scope, values.key, claimId, eventFence, existing.effectState, jsonText(stages), existing.claimId],
    );
    const payload = claimEventPayload({
      effectId: existing.effectId,
      operation: existing.operation,
      scope: values.scope,
      key: values.key,
      fingerprintSha256: values.fingerprintSha256,
      claimId,
      fencingEpoch: eventFence,
    });
    await this.#enqueue(client, EFFECT_EVENT_TYPE, existing.effectId, values.scope, values.key, payload, `fence-${eventFence}`);
    return Object.freeze({ disposition: "claimed" as const, claimId });
  }

  #stageJson(
    current: Readonly<Record<string, StoredStage>>,
    stage: string,
    state: ExternalEffectStageState,
  ): JsonRecord {
    const result: Record<string, JsonValue> = {};
    for (const [name, value] of Object.entries(current)) result[name] = { state: value.state, updatedAt: value.updatedAt };
    result[stage] = { state, updatedAt: nowIso() };
    return result;
  }

  async #markStage(
    claimId: string,
    fingerprint: string,
    stage: RealtimeMediaCleanupStage,
    state: ExternalEffectStageState,
  ): Promise<void> {
    await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffectByClaim(client, claimId);
      if (row === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState !== "in_flight") throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_NOT_ACTIVE");
      const next = this.#stageJson(row.stageState, stage, state);
      await client.query(
        "UPDATE realtime_external_effects SET stage_state = $2::jsonb, updated_at = now() WHERE effect_id = $1 AND claim_id = $3 AND fingerprint_sha256 = $4 AND effect_state = 'in_flight'",
        [row.effectId, jsonText(next), claimId, row.fingerprintSha256],
      );
      if (state === "completed") {
        const payload = Object.freeze({
          effect_id: row.effectId,
          operation: row.operation,
          request_scope: row.requestScope,
          idempotency_key: row.idempotencyKey,
          fingerprint_sha256: row.fingerprintSha256,
          claim_id: claimId,
          stage,
        });
        await this.#enqueue(client, STAGE_EVENT_TYPE, row.effectId, row.requestScope, row.idempotencyKey, payload, stage);
      }
    });
  }

  async #markSuppressionFailure(scope: string, key: string, fingerprint: string): Promise<void> {
    await withTransaction(this.#pool, async (client) => {
      const row = await this.#readEffect(client, scope, key);
      if (row === undefined) throw new RealtimeExternalEffectError("EXTERNAL_EFFECT_CLAIM_NOT_FOUND");
      this.#assertFingerprint(row, fingerprint);
      if (row.effectState !== "in_flight") return;
      const next = this.#stageJson(row.stageState, HANDOFF_STAGE, "indeterminate");
      await client.query(
        "UPDATE realtime_external_effects SET stage_state = $2::jsonb, updated_at = now() WHERE effect_id = $1 AND fingerprint_sha256 = $3 AND effect_state = 'in_flight'",
        [row.effectId, jsonText(next), row.fingerprintSha256],
      );
    });
  }

  async #enqueue(
    client: PoolClient,
    eventType: string,
    effectId: string,
    scope: string,
    key: string,
    payload: JsonRecord,
    suffix?: string,
  ): Promise<void> {
    const payloadHash = jsonHash(payload);
    await enqueueOutboxEvent(client, {
      eventId: this.#eventId(),
      aggregateType: "RealtimeExternalEffect",
      aggregateId: effectId,
      eventType: suffix === undefined ? eventType : eventType + ":" + suffix,
      eventVersion: 1,
      idempotencyScope: scope,
      idempotencyKey: key,
      payload,
      payloadHash,
    });
  }
}

export function createRealtimeExternalEffectCoordinator(
  input: RealtimeExternalEffectCoordinatorOptions,
): RealtimeExternalEffectCoordinator {
  return new RealtimeExternalEffectCoordinator(input.pool, input);
}
