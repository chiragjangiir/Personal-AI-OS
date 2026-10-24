import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { admitMemoryProposal } from "../../../services/memory-os/src/admission.ts";
import { createProductionMemoryCanonicalIssuer, jcsSerialize, type ProductionMemoryIssuerReceipt } from "../../../services/memory-os/src/canonical-issuer.ts";
import { assertSha256, createCanonicalObjectVersionRef, type CanonicalObjectVersionRef, type Sha256 } from "../../../services/memory-os/src/canonical-ref.ts";
import type { MemoryConsumerContext, } from "../../../services/memory-os/src/context-consumer-adapter.ts";
import type { MemoryCommitReceipt, MemoryVersionRecord } from "../../../services/memory-os/src/domain.ts";
import {
  createExplicitUserCorrectionAdapter,
  type ExplicitUserCorrectionAdapterOptions,
  type ExplicitUserCorrectionInput,
} from "../../../services/memory-os/src/explicit-user-correction-adapter.ts";
import {
  createProductionMemoryLifecycle,
  type ProductionMemoryLifecycleOptions,
  type ProductionMemoryLifecycleAuthorityPort,
} from "../../../services/memory-os/src/production-memory-lifecycle.ts";
import type { MemoryCanonicalVersionRead, MemoryCanonicalVersionReader, MemoryReviewStateReader } from "../../../services/memory-os/src/ports.ts";
import type { ProductionMemoryReadyBinding } from "../../../services/memory-os/src/production-memory-ready.ts";
import { assertCanonicalTimestamp } from "../../../services/realtime-core/src/types.ts";
import type { T04AcceptedUserActivityOwnerEvent } from "../src/realtime-public-control-t04-owner.ts";
import {
  createT03ProductionMemoryLifecycleAuthority,
  T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH,
  T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_SCHEMA,
  type T03ProductionMemoryLifecycleAuthorityOptions,
} from "../src/t03-production-memory-lifecycle-authority.ts";

const NOW = "2026-09-07T00:10:00.000Z";
const ISSUED = "2026-09-07T00:00:00.000Z";
const EXPIRES = "2026-09-07T00:50:00.000Z";
const USER = "user-owner-001";
const DEVICE = "device-owner-001";
const CLIENT = "client-owner-001";
const SESSION_ID = "session-owner-001";
const LEASE_ID = "lease-owner-001";
const CONTINUITY = "continuity-owner-001";
const PURPOSE = "personal_assistant";
const SLOT = "preference.color";
const NEW_VALUE = "改为绿色";

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function wireRef(type: string, suffix: string): Record<string, string> {
  return {
    ref_type: type,
    ref_id: `01900000-0000-7000-8000-${suffix.padStart(12, "0")}`,
    object_version: "1",
    canonical_payload_sha256: sha(`${type}:${suffix}`),
  };
}

function internalRef(type: "PreferenceMemory" | "MemoryCandidate", suffix: string): CanonicalObjectVersionRef {
  return createCanonicalObjectVersionRef({
    refType: type,
    refId: `01900000-0000-7000-8000-${suffix.padStart(12, "0")}`,
    objectVersion: "1",
    canonicalPayloadSha256: assertSha256(sha(`${type}:${suffix}`)),
  });
}

const SESSION_REF = Object.freeze(wireRef("RealtimeSession", "1"));
const DEVICE_LEASE_REF = Object.freeze(wireRef("DeviceLease", "2"));
const CONTEXT_REF = Object.freeze(wireRef("ContextAssertion", "3"));
const BINDING: ProductionMemoryReadyBinding = Object.freeze({
  userId: USER,
  sessionId: SESSION_ID,
  deviceId: DEVICE,
  clientInstanceId: CLIENT,
  realtimeSessionRef: SESSION_REF,
  continuityId: CONTINUITY,
  purpose: PURPOSE,
});

interface CurrentFixture {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientInstanceId: string;
  readonly deviceId: string;
  readonly realtimeSessionRef: Readonly<Record<string, string>>;
  readonly deviceLeaseRef: Readonly<Record<string, string>>;
  readonly continuityId: string;
  readonly purpose: string;
  readonly connectionEpoch: string;
  readonly leaseVersion: string;
  readonly sessionState: string;
  readonly continuityState: string;
  readonly transportState: string;
  readonly leaseState: string;
  readonly continuityExpiresAt: string;
  readonly leaseExpiresAt: string;
}

function currentFixture(userId = USER): CurrentFixture {
  return Object.freeze({
    userId,
    sessionId: SESSION_ID,
    clientInstanceId: CLIENT,
    deviceId: DEVICE,
    realtimeSessionRef: SESSION_REF,
    deviceLeaseRef: DEVICE_LEASE_REF,
    continuityId: CONTINUITY,
    purpose: PURPOSE,
    connectionEpoch: "7",
    leaseVersion: "3",
    sessionState: "active",
    continuityState: "active",
    transportState: "connected",
    leaseState: "active",
    continuityExpiresAt: EXPIRES,
    leaseExpiresAt: EXPIRES,
  });
}

const CURRENT = currentFixture();
const OCCURRED_AT = assertCanonicalTimestamp("2026-09-07T00:05:00.000Z");

function acceptedActivity(authorityWatermarkValue = "watermark-1"): T04AcceptedUserActivityOwnerEvent {
  const activityId = "activity-correction-001";
  const acceptanceRef = authorityWatermarkValue === "watermark-1" ? CONTEXT_REF : Object.freeze(wireRef("ContextAssertion", "4"));
  const activity = Object.freeze({
    accepted: true as const,
    acceptanceRef,
    activityId,
    continuityId: CONTINUITY,
    deviceId: DEVICE,
    kind: "accepted_user_activity" as const,
    occurredAt: OCCURRED_AT,
    realtimeSessionRef: SESSION_REF,
    userId: USER,
  });
  const actionReceipt = Object.freeze({
    action: "button_submit" as const,
    activityId,
    bindingCommitted: false as const,
    committed: true as const,
    deleted: false as const,
    kind: "t04.accepted_user_action_receipt" as const,
    origin: "iphone" as const,
    purpose: PURPOSE,
    revoked: false as const,
    stale: false as const,
  });
  const currentBinding = Object.freeze({
    activeDeviceId: DEVICE,
    continuityExpiresAt: EXPIRES,
    continuityId: CONTINUITY,
    lastAcceptedUserActivityAt: activity.occurredAt,
    leaseExpiresAt: EXPIRES,
    leaseState: "active" as const,
    realtimeSessionRef: SESSION_REF,
    sessionState: "active" as const,
    continuityState: "active" as const,
    transportState: "connected" as const,
    userId: USER,
  });
  const evidence = Object.freeze({
    activityId,
    authority: true as const,
    current: true as const,
    deleted: false as const,
    evidenceRef: acceptanceRef,
    kind: "ContextAssertion" as const,
    stale: false as const,
    suppressed: false as const,
    userOriginated: true as const,
  });
  const authorityProjection = Object.freeze({
    accepted: true as const,
    acceptanceRef,
    activityId,
    authorityWatermark: Object.freeze({ kind: "t04.authority_watermark", value: authorityWatermarkValue }),
    continuityId: CONTINUITY,
    current: true as const,
    deleted: false as const,
    deviceId: DEVICE,
    environment: "production" as const,
    evidence: Object.freeze([evidence]),
    kind: "t04.activity_authority_projection" as const,
    origin: "user" as const,
    purpose: PURPOSE,
    realtimeSessionRef: SESSION_REF,
    sessionTime: activity.occurredAt,
    stale: false as const,
    suppressed: false as const,
    userId: USER,
    userOriginated: true as const,
    watermarkCurrent: true as const,
  });
  return Object.freeze({ activity, actionReceipt, authorityProjection, currentBinding }) as unknown as T04AcceptedUserActivityOwnerEvent;
}

function authorityRecord() {
  const refs = {
    issuer: wireRef("DeviceCredential", "10"),
    policyCorrect: wireRef("PolicyDecision", "11"),
    policyRecall: wireRef("PolicyDecision", "12"),
    consentCorrect: wireRef("ConsentRecord", "13"),
    consentRecall: wireRef("ConsentRecord", "14"),
    purposeCorrect: wireRef("PurposeToken", "15"),
    purposeRecall: wireRef("PurposeToken", "16"),
    grantCorrect: wireRef("CapabilityGrant", "17"),
    grantRecall: wireRef("CapabilityGrant", "18"),
  };
  return {
    schema: T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_SCHEMA,
    grant_id: "01900000-0000-7000-8000-000000000099",
    issuer_ref: refs.issuer,
    issued_at_utc: ISSUED,
    expires_at_utc: EXPIRES,
    user_id: USER,
    device_id: DEVICE,
    realtime_session_ref: SESSION_REF,
    continuity_id: CONTINUITY,
    purpose: PURPOSE,
    scopes: ["correct_memory", "recall_for_answer_context"],
    action_grants: [
      {
        action: "correct_memory",
        governance_ref: refs.policyCorrect,
        consent_record_ref: refs.consentCorrect,
        purpose_token_ref: refs.purposeCorrect,
        capability_grant_ref: refs.grantCorrect,
        t04_actions: ["button_submit", "explicit_voice_command"],
        requires_correction_pair: false,
      },
      {
        action: "recall_for_answer_context",
        governance_ref: refs.policyRecall,
        consent_record_ref: refs.consentRecall,
        purpose_token_ref: refs.purposeRecall,
        capability_grant_ref: refs.grantRecall,
        t04_actions: ["button_submit", "explicit_voice_command"],
        requires_correction_pair: true,
      },
    ],
  };
}

function makeHarness(overrides: { readonly expectedSha256?: string; readonly activity?: T04AcceptedUserActivityOwnerEvent } = {}) {
  const record = authorityRecord();
  const bytes = new TextEncoder().encode(`${jcsSerialize(record)}\n`);
  const recordSha256 = sha(new TextDecoder().decode(bytes));
  let current: CurrentFixture = CURRENT;
  const durable = overrides.activity ?? acceptedActivity();
  const counts = { record: 0, current: 0, activity: 0, protection: 0 };
  const options: T03ProductionMemoryLifecycleAuthorityOptions = {
    record: {
      path: T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH,
      expectedSha256: overrides.expectedSha256 ?? recordSha256,
      read: () => { counts.record += 1; return bytes; },
    },
    ownerProtection: {
      assertOwnerProtected: (path) => { counts.protection += 1; assert.equal(path, T03_PRODUCTION_MEMORY_LIFECYCLE_AUTHORITY_PATH); },
    },
    currentBinding: {
      readCurrentBinding: (input) => { counts.current += 1; assert.deepEqual(Object.keys(input), ["realtimeSessionRef"]); return current; },
    },
    acceptedActivity: {
      read: (input) => { counts.activity += 1; assert.deepEqual(Object.keys(input), ["activityId", "idempotencyKey", "realtimeSessionRef"]); return durable; },
    },
    clock: { now: () => NOW },
  };
  const owner = createT03ProductionMemoryLifecycleAuthority(options);
  return {
    owner,
    record,
    binding: BINDING,
    event: durable,
    counts,
    setCurrent: (value: CurrentFixture) => { current = value; },
    recordSha256,
  };
}

function shaValue(): Sha256 {
  return assertSha256(sha(NEW_VALUE));
}

function productionLifecycle(
  authority: ProductionMemoryLifecycleAuthorityPort,
  binding: ProductionMemoryReadyBinding,
  governanceRef: ProductionMemoryLifecycleOptions["governanceRef"],
  oldRef: ReturnType<typeof internalRef>,
) {
  let successorRef = oldRef;
  const application = {
    commitCorrection: async (input: { readonly idempotencyKey: string; readonly expectedCurrentRef: typeof oldRef; readonly issuerReceipt: ProductionMemoryIssuerReceipt }) => {
      successorRef = input.issuerReceipt.memoryRef ?? oldRef;
      const receipt: MemoryCommitReceipt = Object.freeze({
        kind: "memory_commit_receipt",
        operation: "correction",
        outcome: "committed",
        idempotencyKey: input.idempotencyKey,
        fingerprint: assertSha256(sha("commit")),
        canonicalRefs: Object.freeze([successorRef]),
        supersededRefs: Object.freeze([input.expectedCurrentRef]),
        authorityWatermark: Object.freeze({ seq: "1" }),
      });
      return Object.freeze({ ok: true as const, receipt });
    },
  };
  const review = { reviewCandidate: async () => ({ ok: false as const, error: { code: "OWNER_STATE_INVALID" as const, retryable: false } }) };
  const emptyContext: MemoryConsumerContext = Object.freeze({ memories: Object.freeze([]), suppressions: Object.freeze([]), authorityWatermark: Object.freeze({ seq: "1" }) });
  const memoryReady = {
    rememberFinalTranscript: async () => undefined,
    recallForAnswerContext: async () => emptyContext,
    close: async () => undefined,
  };
  const fakeOptions = {
    binding,
    governanceRef,
    authority,
    memoryReady,
    application,
    review,
    candidateReader: { findCandidateByRef: async () => undefined },
    dream: { runPage: async () => { throw new Error("unused"); } },
    deletion: { execute: async () => { throw new Error("unused"); } },
    coldCas: { applyAuthorizedLifecycle: async () => { throw new Error("unused"); }, close: async () => undefined },
  } as unknown as ProductionMemoryLifecycleOptions;
  return { lifecycle: createProductionMemoryLifecycle(fakeOptions), successor: () => successorRef };
}

test("compile-time port assignment and deterministic envelopes verify with durable T04 evidence", async () => {
  const h = makeHarness();
  const port: ProductionMemoryLifecycleAuthorityPort = h.owner.authority;
  assert.equal(await h.owner.readiness(), true);
  const input = {
    serverCurrentBinding: h.binding,
    durableAcceptedActivity: h.event,
    slot: SLOT,
    newValueSha256: shaValue(),
    requestedAt: NOW,
  } as const;
  const first = await h.owner.issueEnvelopes(input);
  const second = await h.owner.issueEnvelopes(input);
  assert.deepEqual(first, second);
  assert.notEqual(first.correctionEnvelope.idempotencyKey, first.recallEnvelope.idempotencyKey);
  assert.equal(first.correctionEnvelope.authorityReceipt.action, "correct_memory");
  assert.equal(first.recallEnvelope.authorityReceipt.action, "recall_for_answer_context");
  assert.equal(first.correctionEvidence.ref.refType, "ContextAssertion");
  assert.equal(JSON.stringify(first).includes(NEW_VALUE), false);
  const verifiedCorrect = await port.verify({ action: "correct_memory", envelope: first.correctionEnvelope });
  const verifiedRecall = await port.verify({ action: "recall_for_answer_context", envelope: first.recallEnvelope });
  assert.equal(verifiedCorrect.ok, true, JSON.stringify(verifiedCorrect));
  assert.equal(verifiedRecall.ok, true, JSON.stringify(verifiedRecall));
  assert.equal(h.counts.activity, 4);
});

test("the same envelopes execute through the real lifecycle and adapter-shaped correction input", async () => {
  const h = makeHarness();
  const issued = await h.owner.issueEnvelopes({ serverCurrentBinding: h.binding, durableAcceptedActivity: h.event, slot: SLOT, newValueSha256: shaValue(), requestedAt: NOW });
  const oldRef = internalRef("MemoryCandidate", "40");
  const issuer = createProductionMemoryCanonicalIssuer({ nowMs: () => Date.parse(NOW) });
  const admitted = admitMemoryProposal({
    proposalId: "proposal-1",
    intent: { kind: "correct", target: oldRef },
    userId: USER,
    kind: "preference_memory",
    slot: SLOT,
    value: { text: "旧值" },
    sourceClass: "explicit_user_correction",
    evidenceRefs: [oldRef],
    confidencePpm: 1_000_000,
    purposeScopes: [PURPOSE],
    sensitivity: { classification: "normal", userConfirmed: true },
    validity: { observedAt: NOW },
    idempotencyKey: issued.correctionEnvelope.idempotencyKey,
    correctionIntent: { kind: "correct", target: oldRef, evidenceRefs: [oldRef] },
  });
  assert.equal(admitted.status, "candidate");
  if (admitted.status !== "candidate") return;
  const issuerReceipt = issuer.issueCandidate({ candidate: admitted.intent, context: { systemTime: "2026-09-07T00:10:00.000000Z" } });
  const productionCorrect = productionLifecycle(h.owner.authority, h.binding, issued.correctionEnvelope.governanceRef, oldRef);
  const correction = await productionCorrect.lifecycle.correctMemory({
    envelope: issued.correctionEnvelope,
    input: { idempotencyKey: issued.correctionEnvelope.idempotencyKey, expectedCurrentRef: oldRef, candidate: admitted.intent, resolvedContent: NEW_VALUE, issuerReceipt: issuerReceipt },
  });
  const productionRecall = productionLifecycle(h.owner.authority, h.binding, issued.recallEnvelope.governanceRef, oldRef);
  const recall = await productionRecall.lifecycle.recallForAnswerContext({ envelope: issued.recallEnvelope, input: { asOf: NOW, maxItems: 1, maxContentBytes: 1024, slot: SLOT } });
  assert.equal(correction.authorityReceipt.action, "correct_memory");
  assert.equal(recall.authorityReceipt.action, "recall_for_answer_context");
  const adapterInput: ExplicitUserCorrectionInput = Object.freeze({
    kind: "explicit_user_correction",
    binding: h.binding,
    slot: SLOT,
    newValue: NEW_VALUE,
    correctionEvidence: issued.correctionEvidence,
    correctionEnvelope: issued.correctionEnvelope,
    recallEnvelope: issued.recallEnvelope,
    recallInput: { asOf: NOW, maxItems: 1, maxContentBytes: 1024, slot: SLOT },
  });
  assert.equal(adapterInput.correctionEnvelope.authorityReceipt.action, "correct_memory");
  assert.equal(adapterInput.recallEnvelope.authorityReceipt.action, "recall_for_answer_context");
  assert.equal(typeof createExplicitUserCorrectionAdapter, "function");
});

test("readiness and verification fail closed on hash, current binding, T04, watermark, replay, and close drift", async () => {
  const badHash = makeHarness({ expectedSha256: "0".repeat(64) });
  assert.equal(await badHash.owner.readiness(), false);
  const h = makeHarness();
  const issued = await h.owner.issueEnvelopes({ serverCurrentBinding: h.binding, durableAcceptedActivity: h.event, slot: SLOT, newValueSha256: shaValue(), requestedAt: NOW });
  const tampered = { ...issued.correctionEnvelope, authorityReceipt: { ...issued.correctionEnvelope.authorityReceipt, authorityWatermark: { ...(issued.correctionEnvelope.authorityReceipt.authorityWatermark as Record<string, unknown>), slot_sha256: "f".repeat(64) } } };
  assert.equal((await h.owner.authority.verify({ action: "correct_memory", envelope: tampered })).ok, false);
  assert.equal((await h.owner.authority.verify({ action: "recall_for_answer_context", envelope: issued.correctionEnvelope })).ok, false);
  h.setCurrent({ ...CURRENT, userId: "drifted-user" });
  assert.equal(await h.owner.readiness(), false);
  h.setCurrent(CURRENT);
  const badActivity = makeHarness({ activity: acceptedActivity("watermark-drift") });
  assert.equal((await badActivity.owner.authority.verify({ action: "correct_memory", envelope: issued.correctionEnvelope })).ok, false);
  await h.owner.close();
  assert.equal(await h.owner.isReady(), false);
  assert.equal((await h.owner.authority.verify({ action: "correct_memory", envelope: issued.correctionEnvelope })).ok, false);
  await assert.rejects(() => h.owner.issueEnvelopes({ serverCurrentBinding: h.binding, durableAcceptedActivity: h.event, slot: SLOT, newValueSha256: shaValue(), requestedAt: NOW }));
});
