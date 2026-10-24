import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createFinalTranscriptEvidenceService,
  type FinalTranscriptEvidenceInput,
  type T11BCanonicalRef,
} from "../../realtime-core/src/final-transcript-evidence-service.ts";
import type { CanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import {
  createFinalTranscriptEvidencePostgresBridge,
  createPostgresSchemaReadinessReader,
} from "../src/final-transcript-evidence-postgres.ts";
import { closePostgresPool, createPostgresPool } from "../src/postgres-pool.ts";

const RUN = process.env.PAIOS_FINAL_TRANSCRIPT_PG_INTEGRATION === "1";
const PRESERVE = process.env.PAIOS_FINAL_TRANSCRIPT_PG_PRESERVE === "1";
const MODE = process.env.PAIOS_FINAL_TRANSCRIPT_PG_MODE ?? "positive";
const DRIFT_CASE = process.env.PAIOS_FINAL_TRANSCRIPT_DRIFT_CASE;
const HASH = "a".repeat(64);
const SESSION_ID = "01952f00-0000-7000-8000-000000000601";
const LEASE_ID = "01952f00-0000-7000-8000-000000000602";
const USER_ID = "01952f00-0000-7000-8000-000000000603";
const DEVICE_ID = "01952f00-0000-7000-8000-000000000604";
const CONTINUITY_ID = "01952f00-0000-7000-8000-000000000605";
const IDEMPOTENCY_KEY = "final-transcript-postgres-integration-001";
const OBSERVED_AT = "2026-08-27T01:02:03.123Z";
const CATALOG_SHA256 = "0f37de714c043d659e424812457d63926e2ccda8c7efeda033495acc5299effc";
const DRIFT_DATABASES = Object.freeze({
  aggregate_ref: "t02_ft_drift_aggregate_048",
  event_type: "t02_ft_drift_event_048",
  event_version: "t02_ft_drift_version_048",
  payload_hash: "t02_ft_drift_payload_hash_048",
  session_binding: "t02_ft_drift_session_binding_048",
  ledger_hash: "t02_ft_drift_ledger_048",
  missing_ledger: "t02_ft_drift_missing_ledger_048",
  duplicate_outbox: "t02_ft_drift_duplicate_048",
  evidence_type: "t02_ft_drift_evidence_type_048",
  missing_outbox: "t02_ft_drift_missing_outbox_048",
} as const);
type DriftCase = keyof typeof DRIFT_DATABASES;

const BASELINE = Object.freeze({
  eventId: "fe5f5bf9-59a0-4a9d-abee-430fc04dd825",
  segmentRefId: "01a040bc-ff73-7376-bcd7-5d9c0724f86d",
  segmentHash: "0b2fea27424a980b7be4ee7cbbdf86026bcd1e6ec0c4af3d2bd622ca3341e1ed",
  evidenceRefId: "01a040bc-ff73-7d94-afcd-4067d7c406ae",
  evidenceHash: "a24c596a9e58b8dfe960b72b63803cdfaa5d4fc12c029874fcaef3ccdee8f0a4",
  payloadHash: "186862fe025f8373dfeade8fd77fdfb8e5db01ea266a2ee58ed78602c9fa8063",
  requestHash: "5574f9debac1b2a25168d75e4bfcae9fa54ba3842169439e0a605f3599801f13",
  responseHash: "4509afe3338311f56eb2f61f12b0756dc9f3c8c5324df90186af9f315fc7bee7",
});

const SESSION_REF = Object.freeze({
  ref_type: "RealtimeSession",
  ref_id: SESSION_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
});
const LEASE_REF = Object.freeze({
  ref_type: "DeviceLease",
  ref_id: LEASE_ID,
  object_version: "1",
  canonical_payload_sha256: HASH,
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function sourceRef(): T11BCanonicalRef {
  return Object.freeze({
    refType: "SourceArtifact",
    refId: "01952f00-0000-7000-8000-000000000606",
    objectVersion: "1",
    canonicalPayloadSha256: HASH,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function exactDriftCase(): DriftCase {
  if (DRIFT_CASE === undefined || !Object.prototype.hasOwnProperty.call(DRIFT_DATABASES, DRIFT_CASE)) {
    throw new Error("PAIOS_FINAL_TRANSCRIPT_DRIFT_CASE_INVALID");
  }
  return DRIFT_CASE as DriftCase;
}

async function cloneBaseline(pool: ReturnType<typeof createPostgresPool>, database: string): Promise<void> {
  const row = (await pool.query(
    [
      "SELECT (SELECT count(*)::int FROM realtime_sessions WHERE session_ref_id=$1) AS session_count,",
      "(SELECT count(*)::int FROM device_leases WHERE lease_ref_id=$2 AND session_ref_id=$1) AS lease_count,",
      "(SELECT count(*)::int FROM outbox_events WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$3) AS outbox_count,",
      "(SELECT count(*)::int FROM idempotency_ledger WHERE scope='final_transcript_evidence' AND idempotency_key=$3) AS ledger_count,",
      "o.event_id::text,o.aggregate_id::text,o.event_type,o.event_version,o.idempotency_scope,o.payload_sha256,",
      "o.payload->'evidenceRef' AS evidence_ref,o.payload->'evidence'->'transcriptSegmentRef' AS segment_ref,",
      "i.request_hash,i.response_hash,i.status FROM outbox_events o JOIN idempotency_ledger i",
      "ON i.scope='final_transcript_evidence' AND i.idempotency_key=o.idempotency_key",
      "WHERE o.idempotency_scope='realtime.outbox' AND o.idempotency_key=$3",
    ].join(" "),
    [SESSION_ID, LEASE_ID, IDEMPOTENCY_KEY],
  )).rows;
  assert.equal(row.length, 1);
  const item = row[0]!;
  assert.deepEqual(
    [item.session_count, item.lease_count, item.outbox_count, item.ledger_count].map(Number),
    [1, 1, 1, 1],
  );
  assert.equal(database, DRIFT_DATABASES[exactDriftCase()]);
  assert.equal(item.event_id, BASELINE.eventId);
  assert.equal(item.aggregate_id, SESSION_ID);
  assert.equal(item.event_type, "realtime.transcript_segment.finalized.v1");
  assert.equal(Number(item.event_version), 1);
  assert.equal(item.idempotency_scope, "realtime.outbox");
  assert.equal(item.payload_sha256, BASELINE.payloadHash);
  assert.equal(item.evidence_ref.refId, BASELINE.evidenceRefId);
  assert.equal(item.evidence_ref.canonicalPayloadSha256, BASELINE.evidenceHash);
  assert.equal(item.segment_ref.refId, BASELINE.segmentRefId);
  assert.equal(item.segment_ref.canonicalPayloadSha256, BASELINE.segmentHash);
  assert.equal(item.request_hash, BASELINE.requestHash);
  assert.equal(item.response_hash, BASELINE.responseHash);
  assert.equal(item.status, "committed");
}

async function runCloneDrift(
  pool: ReturnType<typeof createPostgresPool>,
  driftCase: DriftCase,
): Promise<void> {
  const expected: Readonly<Record<DriftCase, string>> = Object.freeze({
    aggregate_ref: "FINAL_TRANSCRIPT_AGGREGATE_DRIFT",
    event_type: "FINAL_TRANSCRIPT_OUTBOX_DRIFT",
    event_version: "FINAL_TRANSCRIPT_OUTBOX_DRIFT",
    payload_hash: "FINAL_TRANSCRIPT_OUTBOX_DRIFT",
    session_binding: "FINAL_TRANSCRIPT_SESSION_BINDING_DRIFT",
    ledger_hash: "FINAL_TRANSCRIPT_IDEMPOTENCY_DRIFT",
    missing_ledger: "FINAL_TRANSCRIPT_IDEMPOTENCY_MISSING",
    duplicate_outbox: "FINAL_TRANSCRIPT_DUPLICATE",
    evidence_type: "FINAL_TRANSCRIPT_REF_INVALID",
    missing_outbox: "UNDEFINED",
  });
  switch (driftCase) {
    case "aggregate_ref":
      await pool.query("UPDATE outbox_events SET aggregate_ref=jsonb_set(aggregate_ref,'{ref_id}',to_jsonb($2::text)) WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY, "01952f00-0000-7000-8000-000000000699"]);
      break;
    case "event_type":
      await pool.query("UPDATE outbox_events SET event_type='realtime.transcript_segment.corrupt.v1' WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY]);
      break;
    case "event_version":
      await pool.query("UPDATE outbox_events SET event_version=2 WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY]);
      break;
    case "payload_hash":
      await pool.query("UPDATE outbox_events SET payload_sha256=$2 WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY, "b".repeat(64)]);
      break;
    case "session_binding":
      await pool.query("UPDATE realtime_sessions SET user_id=$2 WHERE session_ref_id=$1", [SESSION_ID, "01952f00-0000-7000-8000-000000000698"]);
      break;
    case "ledger_hash":
      await pool.query("UPDATE idempotency_ledger SET response_hash=$2 WHERE scope='final_transcript_evidence' AND idempotency_key=$1", [IDEMPOTENCY_KEY, "b".repeat(64)]);
      break;
    case "missing_ledger":
      await pool.query("DELETE FROM idempotency_ledger WHERE scope='final_transcript_evidence' AND idempotency_key=$1", [IDEMPOTENCY_KEY]);
      break;
    case "duplicate_outbox":
      await pool.query(
        [
          "INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,aggregate_ref,event_type,event_version,",
          "idempotency_scope,idempotency_key,payload,payload_sha256,available_at,created_at,updated_at)",
          "SELECT $2::uuid,aggregate_type,aggregate_id,aggregate_ref,event_type,event_version,idempotency_scope,$3,",
          "payload,payload_sha256,available_at,created_at,updated_at FROM outbox_events",
          "WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1",
        ].join(" "),
        [IDEMPOTENCY_KEY, "fe5f5bf9-59a0-4a9d-abee-430fc04dd826", `${IDEMPOTENCY_KEY}-duplicate`],
      );
      break;
    case "evidence_type": {
      const rows = (await pool.query("SELECT payload FROM outbox_events WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY])).rows;
      assert.equal(rows.length, 1);
      const payload = rows[0]!.payload as Record<string, unknown>;
      (payload.evidenceRef as Record<string, unknown>).refType = "TranscriptSegment";
      const digest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
      await pool.query("UPDATE outbox_events SET payload=$2::jsonb,payload_sha256=$3 WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY, JSON.stringify(payload), digest]);
      break;
    }
    case "missing_outbox":
      await pool.query("DELETE FROM outbox_events WHERE idempotency_scope='realtime.outbox' AND idempotency_key=$1", [IDEMPOTENCY_KEY]);
      break;
  }
  const bridge = createFinalTranscriptEvidencePostgresBridge(pool);
  const ref = Object.freeze({
    refType: "FinalTranscriptEvidence",
    refId: BASELINE.evidenceRefId,
    objectVersion: "1",
    canonicalPayloadSha256: BASELINE.evidenceHash,
  }) as unknown as CanonicalObjectVersionRef;
  let observed = "RETURNED";
  try {
    const value = await bridge.reader.read(ref);
    observed = value === undefined ? "UNDEFINED" : "RETURNED";
  } catch (error) {
    observed = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN_ERROR";
  }
  assert.equal(observed, expected[driftCase]);
  const post = (await pool.query(
    "SELECT (SELECT count(*)::int FROM realtime_sessions WHERE session_ref_id=$1) AS session_count,(SELECT count(*)::int FROM device_leases WHERE lease_ref_id=$2) AS lease_count,(SELECT count(*)::int FROM outbox_events WHERE payload #>> '{evidenceRef,refId}'=$3) AS outbox_count,(SELECT count(*)::int FROM idempotency_ledger WHERE scope='final_transcript_evidence' AND idempotency_key=$4) AS ledger_count",
    [SESSION_ID, LEASE_ID, BASELINE.evidenceRefId, IDEMPOTENCY_KEY],
  )).rows[0]!;
  process.stdout.write(`DRIFT_CASE_RECEIPT ${JSON.stringify({ driftCase, database: DRIFT_DATABASES[driftCase], observed, post })}\n`);
}

test("PG18 final transcript bridge writes, replays and reads exactly once", { skip: !RUN }, async () => {
  const secretBytes = await readFile(required("PAIOS_PG_PASSWORD_FILE"));
  let password = secretBytes.toString("utf8").trim();
  secretBytes.fill(0);
  const pool = createPostgresPool({
    host: required("PAIOS_PG_HOST"),
    port: Number(required("PAIOS_PG_PORT")),
    database: required("PAIOS_PG_DATABASE"),
    user: required("PAIOS_PG_USER"),
    password,
    applicationName: "paios-final-transcript-pg-integration",
  });
  password = "";
  try {
    const readiness = createPostgresSchemaReadinessReader({
      pool,
      expected: {
        host: required("PAIOS_PG_HOST"),
        port: Number(required("PAIOS_PG_PORT")),
        database: required("PAIOS_PG_DATABASE"),
        user: required("PAIOS_PG_USER"),
        serverVersion: required("PAIOS_PG_SERVER_VERSION"),
        catalogDefinitionSha256: required("PAIOS_PG_CATALOG_DEFINITION_SHA256"),
      },
      readinessArtifact: {
        absolutePath: required("PAIOS_PG_READINESS_FILE"),
        sha256: required("PAIOS_PG_READINESS_SHA256"),
      },
    });
    assert.equal((await readiness.read()).ready, true);

    if (MODE === "preprovisioned-drift-clone") {
      if (!PRESERVE || required("PAIOS_PG_CATALOG_DEFINITION_SHA256") !== CATALOG_SHA256) {
        throw new Error("PREPROVISIONED_DRIFT_CLONE_BINDING_INVALID");
      }
      const driftCase = exactDriftCase();
      await cloneBaseline(pool, required("PAIOS_PG_DATABASE"));
      await runCloneDrift(pool, driftCase);
      return;
    }
    if (MODE !== "positive") throw new Error("PAIOS_FINAL_TRANSCRIPT_PG_MODE_INVALID");

    await pool.query(
      [
        "INSERT INTO realtime_sessions (session_ref_id, realtime_session_ref, session_object_version,",
        "session_payload_sha256, user_id, continuity_id, continuity_state, active_device_lease_ref,",
        "active_device_id, binding, state, connection_epoch, last_accepted_activity_at, continuity_expires_at, created_at, updated_at, revision)",
        "VALUES ($1,$2::jsonb,'1',$3,$4,$5,'active',$6::jsonb,$7,$8::jsonb,'active',1,",
        "$9::timestamptz,$10::timestamptz,now(),now(),1) ON CONFLICT (session_ref_id) DO NOTHING",
      ].join(" "),
      [
        SESSION_ID, JSON.stringify(SESSION_REF), HASH, USER_ID, CONTINUITY_ID, JSON.stringify(LEASE_REF), DEVICE_ID,
        JSON.stringify({
          state: "connected", realtimeSessionRef: SESSION_REF, deviceLeaseRef: LEASE_REF,
          continuityId: CONTINUITY_ID, deviceId: DEVICE_ID, connectionEpoch: "1",
          provider: { provider: "livekit", value: "provider-final" },
          transportSessionAlias: { provider: "livekit", value: "transport-final" },
          roomAlias: { provider: "livekit", value: "room-final" },
          deviceAlias: { provider: "livekit", value: "device-final" }, connectionId: "connection-final",
        }),
        OBSERVED_AT, "2026-08-27T02:02:03.123Z",
      ],
    );
    await pool.query(
      [
        "INSERT INTO device_leases (lease_ref_id, device_lease_ref, lease_object_version, lease_payload_sha256,",
        "session_ref_id, realtime_session_ref, user_id, device_id, continuity_id, capabilities, purpose,",
        "policy_decision_ref, capability_scope, purpose_scope, policy_binding, revocable, state, lease_version,",
        "fencing_token, issued_at, acquired_at, expires_at, updated_at)",
        "VALUES ($1,$2::jsonb,'1',$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11::jsonb,",
        "$12::jsonb,$13::jsonb,$14::jsonb,TRUE,'active',1,1,$15::timestamptz,$15::timestamptz,$16::timestamptz,now())",
        "ON CONFLICT (lease_ref_id) DO NOTHING",
      ].join(" "),
      [
        LEASE_ID, JSON.stringify(LEASE_REF), HASH, SESSION_ID, JSON.stringify(SESSION_REF), USER_ID, DEVICE_ID,
        CONTINUITY_ID, JSON.stringify(["microphone"]), "conversation", JSON.stringify({ kind: "PolicyDecision" }),
        JSON.stringify(["microphone"]), JSON.stringify(["conversation"]), JSON.stringify({ permitted: true }),
        "2026-08-27T00:02:03.123Z", "2026-08-27T02:02:03.123Z",
      ],
    );

    const bridge = createFinalTranscriptEvidencePostgresBridge(pool);
    const service = createFinalTranscriptEvidenceService(bridge.repository);
    const request: FinalTranscriptEvidenceInput = {
      transcriptState: "final",
      userId: USER_ID,
      deviceId: DEVICE_ID,
      realtimeSessionRef: SESSION_REF,
      continuityId: CONTINUITY_ID,
      purpose: "conversation",
      text: "请记住 PG18 桥接验收词。",
      language: "zh-CN",
      sourceMediaRef: sourceRef(),
      observedAt: OBSERVED_AT as FinalTranscriptEvidenceInput["observedAt"],
      idempotencyKey: IDEMPOTENCY_KEY as FinalTranscriptEvidenceInput["idempotencyKey"],
    };
    const committed = await service.finalize(request);
    assert.deepEqual(await service.finalize(request), committed);
    const read = await bridge.reader.read(committed.evidenceRef as unknown as CanonicalObjectVersionRef);
    assert.equal(read?.text, request.text);
    const counts = await pool.query(
      [
        "SELECT (SELECT count(*)::int FROM outbox_events WHERE idempotency_scope = 'realtime.outbox'",
        "AND idempotency_key = $1 AND event_type = 'realtime.transcript_segment.finalized.v1') AS outbox_count,",
        "(SELECT count(*)::int FROM idempotency_ledger WHERE scope = 'final_transcript_evidence'",
        "AND idempotency_key = $1) AS ledger_count",
      ].join(" "),
      [IDEMPOTENCY_KEY],
    );
    assert.deepEqual(counts.rows[0], { outbox_count: 1, ledger_count: 1 });
  } finally {
    if (MODE === "positive" && !PRESERVE) {
      await pool.query("DELETE FROM outbox_events WHERE idempotency_scope = 'realtime.outbox' AND idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
      await pool.query("DELETE FROM idempotency_ledger WHERE scope = 'final_transcript_evidence' AND idempotency_key = $1", [IDEMPOTENCY_KEY]).catch(() => undefined);
      await pool.query("DELETE FROM device_leases WHERE lease_ref_id = $1", [LEASE_ID]).catch(() => undefined);
      await pool.query("DELETE FROM realtime_sessions WHERE session_ref_id = $1", [SESSION_ID]).catch(() => undefined);
    }
    await closePostgresPool(pool);
  }
});
