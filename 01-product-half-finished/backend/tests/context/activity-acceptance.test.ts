import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActivityAcceptanceVerificationError,
  createActivityAcceptanceVerifier,
} from '../../services/context-engine/src/activity-acceptance.ts';
import type { AcceptedUserActivity } from '../../services/realtime-core/src/types.ts';

const SESSION = Object.freeze({
  ref_type: 'RealtimeSession', ref_id: '018f0000-0000-7000-8000-000000000011',
  object_version: '1', canonical_payload_sha256: '1'.repeat(64),
});
const ACCEPTANCE = Object.freeze({
  ref_type: 'ContextAssertion', ref_id: '018f0000-0000-7000-8000-000000000012',
  object_version: '1', canonical_payload_sha256: '2'.repeat(64),
});
const TOOL = Object.freeze({
  ref_type: 'ToolResultArtifact', ref_id: '018f0000-0000-7000-8000-000000000013',
  object_version: '1', canonical_payload_sha256: '3'.repeat(64),
});

function activity(activityId = 'durable-owner-action-1'): AcceptedUserActivity {
  return {
    activityId,
    kind: 'accepted_user_activity',
    userId: 'user-1',
    deviceId: 'iphone-canonical-1',
    realtimeSessionRef: SESSION,
    continuityId: 'continuity-1',
    occurredAt: '2026-08-30T11:59:30.000Z',
    acceptanceRef: ACCEPTANCE,
    accepted: true,
  } as unknown as AcceptedUserActivity;
}

function projection(input = activity()): Record<string, any> {
  return {
    kind: 't04.activity_authority_projection',
    environment: 'production',
    activityId: input.activityId,
    origin: 'user',
    userOriginated: true,
    accepted: true,
    current: true,
    deleted: false,
    suppressed: false,
    stale: false,
    purpose: 'cycling_assistant',
    userId: input.userId,
    deviceId: input.deviceId,
    realtimeSessionRef: SESSION,
    continuityId: input.continuityId,
    sessionTime: input.occurredAt,
    acceptanceRef: ACCEPTANCE,
    authorityWatermark: { owner: 'T04', sequence: '51' },
    watermarkCurrent: true,
    evidence: [{
      kind: 'ContextAssertion', evidenceRef: ACCEPTANCE, activityId: input.activityId,
      userOriginated: true, authority: true, current: true, deleted: false, suppressed: false, stale: false,
    }, {
      kind: 'ToolResultArtifact', attachmentRef: TOOL, attachmentActivityId: input.activityId,
      explicitUserInitiated: true, acceptedByT04: true, authority: false,
    }],
  };
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof ActivityAcceptanceVerificationError && error.code === code,
  );
}

test('direct verifier accepts current owner evidence and treats ToolResult only as attachment', async () => {
  const input = activity();
  const current = projection(input);
  const verifier = createActivityAcceptanceVerifier({
    purpose: 'cycling_assistant',
    authorityReader: { environment: 'production', readCurrent: async () => current },
  });
  const result = await verifier.verify(input);
  assert.equal(result.verified, true);
  assert.deepEqual(result.acceptanceRef, ACCEPTANCE);
  assert.equal(result.acceptedAt, input.occurredAt);
  assert.equal(JSON.stringify(result.authorityWatermark), JSON.stringify(current.authorityWatermark));
  assert.equal(await verifier.verify(structuredClone(input)), result);
});

test('ToolResult alone never supplies authority', async () => {
  const input = activity();
  const current = projection(input);
  current.evidence = [current.evidence[1]];
  const verifier = createActivityAcceptanceVerifier({
    purpose: 'cycling_assistant',
    authorityReader: { environment: 'production', readCurrent: () => current },
  });
  await rejectsCode(verifier.verify(input), 'ACTIVITY_ACCEPTANCE_EVIDENCE_REQUIRED');
});

test('direct verifier covers production rejection families before any acceptance', async () => {
  const cases: Array<[string, (value: Record<string, any>) => void, string]> = [
    ['non-production', (value) => { value.environment = 'non-production'; }, 'ACTIVITY_ACCEPTANCE_PROJECTION_NON_PRODUCTION'],
    ['non-user', (value) => { value.origin = 'system'; }, 'ACTIVITY_ACCEPTANCE_NON_USER_ORIGIN'],
    ['deleted', (value) => { value.deleted = true; }, 'ACTIVITY_ACCEPTANCE_DELETED'],
    ['suppressed', (value) => { value.suppressed = true; }, 'ACTIVITY_ACCEPTANCE_SUPPRESSED'],
    ['stale', (value) => { value.stale = true; }, 'ACTIVITY_ACCEPTANCE_STALE'],
    ['not-current', (value) => { value.current = false; }, 'ACTIVITY_ACCEPTANCE_CURRENTNESS_REJECTED'],
    ['wrong-purpose', (value) => { value.purpose = 'background_sync'; }, 'ACTIVITY_ACCEPTANCE_PURPOSE_MISMATCH'],
    ['wrong-device', (value) => { value.deviceId = 'watch-local'; }, 'ACTIVITY_ACCEPTANCE_BINDING_MISMATCH'],
    ['wrong-session-time', (value) => { value.sessionTime = '2026-08-30T11:59:31.000Z'; }, 'ACTIVITY_ACCEPTANCE_SESSION_TIME_MISMATCH'],
    ['wrong-acceptance', (value) => { value.acceptanceRef = TOOL; }, 'ACTIVITY_ACCEPTANCE_ACCEPTANCE_REF_MISMATCH'],
    ['old-watermark', (value) => { value.watermarkCurrent = false; }, 'ACTIVITY_ACCEPTANCE_WATERMARK_NOT_CURRENT'],
    ['revoked-evidence', (value) => { value.evidence[0].current = false; }, 'ACTIVITY_ACCEPTANCE_EVIDENCE_CURRENTNESS_REJECTED'],
  ];
  for (const [name, mutate, code] of cases) {
    const input = activity(`direct-${name}`);
    const current = projection(input);
    mutate(current);
    const verifier = createActivityAcceptanceVerifier({
      purpose: 'cycling_assistant',
      authorityReader: { environment: 'production', readCurrent: () => current },
    });
    await rejectsCode(verifier.verify(input), code);
  }
});

test('same current replay is stable while changed current projection conflicts', async () => {
  const input = activity('direct-replay');
  let current = projection(input);
  const verifier = createActivityAcceptanceVerifier({
    purpose: 'cycling_assistant',
    authorityReader: { environment: 'production', readCurrent: () => current },
  });
  const first = await verifier.verify(input);
  assert.equal(await verifier.verify(structuredClone(input)), first);
  current = structuredClone(current);
  current.authorityWatermark.sequence = '52';
  await rejectsCode(verifier.verify(input), 'ACTIVITY_ACCEPTANCE_REPLAY_CONFLICT');
});

test('deleted or revoked current authority is rejected even after an earlier valid replay', async () => {
  const input = activity('direct-revoked');
  let current = projection(input);
  const verifier = createActivityAcceptanceVerifier({
    purpose: 'cycling_assistant',
    authorityReader: { environment: 'production', readCurrent: () => current },
  });
  await verifier.verify(input);
  current = structuredClone(current);
  current.deleted = true;
  await rejectsCode(verifier.verify(input), 'ACTIVITY_ACCEPTANCE_DELETED');
});
