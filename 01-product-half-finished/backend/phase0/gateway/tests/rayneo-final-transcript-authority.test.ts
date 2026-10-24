import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  FinalTranscriptEvidenceInput,
  FinalTranscriptEvidenceResult,
  FinalTranscriptEvidenceService,
  T11BCanonicalRef,
} from '../../../services/realtime-core/src/final-transcript-evidence-service.ts';
import type { CanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import {
  createRayneoFinalTranscriptAuthority,
  RayneoFinalTranscriptAuthorityError,
  type RayneoFinalTranscriptOwnerBinding,
  type RayneoSourceMediaAuthorityInput,
} from '../src/rayneo-final-transcript-authority.ts';
import type { RayneoFinalTranscriptAuthorityInput } from '../src/rayneo-realtime-audio-controller.ts';

const OBSERVED_AT = '2026-08-28T01:02:03.123Z';
const SESSION = 'phase0_session_aaaaaaaaaaaaaaaaaaaa';
const DEVICE = 'rayneo_device_bbbbbbbbbbbbbbbbbbbb';
const CLIENT = 'rayneo_client_cccccccccccccccccccc';
const CANONICAL_DEVICE_ID = '01952f00-0000-7000-8000-000000000101';
const SESSION_REF = Object.freeze({ kind: 'RealtimeSession', id: 'session-rayneo-authority' });
const SOURCE_REF = ref('SourceArtifact', '01952f00-0000-7000-8000-000000000201');
const RESULT: FinalTranscriptEvidenceResult = Object.freeze({
  transcriptSegmentRef: ref('TranscriptSegment', '01952f00-0000-7000-8000-000000000301'),
  evidenceRef: ref('FinalTranscriptEvidence', '01952f00-0000-7000-8000-000000000401'),
  outboxEventRef: Object.freeze({ kind: 'OutboxEvent', id: 'outbox-rayneo-authority' }),
  observedAt: OBSERVED_AT as CanonicalTimestamp,
});

function ref(refType: T11BCanonicalRef['refType'], refId: string): T11BCanonicalRef {
  return Object.freeze({
    refType,
    refId,
    objectVersion: '1',
    canonicalPayloadSha256: 'a'.repeat(64),
  });
}

function input(overrides: Partial<RayneoFinalTranscriptAuthorityInput> = {}): RayneoFinalTranscriptAuthorityInput {
  const bytes = Uint8Array.of(10, 0, 246, 255);
  return Object.freeze({
    sessionId: SESSION,
    deviceId: DEVICE,
    clientInstanceId: CLIENT,
    segmentId: 'rayneo_segment_aaaaaaaaaaaaaaaaaaaa',
    startMs: 0,
    endMs: 1,
    speakerLabel: 'speaker_0',
    diarizationStatus: 'window_local',
    transcript: '请记住这个测试词。',
    language: 'und',
    observedAt: OBSERVED_AT,
    media: Object.freeze({
      format: 'pcm_s16le',
      sampleRate: 16_000,
      channels: 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    }),
    ...overrides,
  });
}

const BINDING: RayneoFinalTranscriptOwnerBinding = Object.freeze({
  canonicalDeviceId: CANONICAL_DEVICE_ID,
  userId: 'user-rayneo-authority',
  realtimeSessionRef: SESSION_REF,
  continuityId: 'continuity-rayneo-authority',
  purpose: 'conversation',
});

type Harness = {
  readonly authority: ReturnType<typeof createRayneoFinalTranscriptAuthority>;
  readonly order: string[];
  readonly sourceInputs: RayneoSourceMediaAuthorityInput[];
  readonly evidenceInputs: FinalTranscriptEvidenceInput[];
};

function harness(options: {
  readonly resolve?: () => Promise<RayneoFinalTranscriptOwnerBinding | undefined>;
  readonly issue?: (input: RayneoSourceMediaAuthorityInput) => Promise<T11BCanonicalRef>;
  readonly finalize?: (input: FinalTranscriptEvidenceInput) => Promise<FinalTranscriptEvidenceResult>;
} = {}): Harness {
  const order: string[] = [];
  const sourceInputs: RayneoSourceMediaAuthorityInput[] = [];
  const evidenceInputs: FinalTranscriptEvidenceInput[] = [];
  const authority = createRayneoFinalTranscriptAuthority({
    ownerBinding: {
      resolve: async (request) => {
        order.push('binding');
        return options.resolve === undefined ? BINDING : options.resolve();
      },
    },
    sourceMedia: {
      issue: async (request) => {
        order.push('source-media');
        sourceInputs.push(request);
        return options.issue === undefined ? SOURCE_REF : options.issue(request);
      },
    },
    finalTranscript: {
      finalize: async (request) => {
        order.push('final-evidence');
        evidenceInputs.push(request);
        return options.finalize === undefined ? RESULT : options.finalize(request);
      },
    } satisfies FinalTranscriptEvidenceService,
  });
  return { authority, order, sourceInputs, evidenceInputs };
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof RayneoFinalTranscriptAuthorityError && error.code === expected;
}

test('success resolves current binding, issues source media, then commits T11B final evidence', async () => {
  const fixture = harness();
  await fixture.authority.finalize(input());
  assert.deepEqual(fixture.order, ['binding', 'source-media', 'final-evidence']);
  assert.equal(fixture.sourceInputs[0]?.userId, BINDING.userId);
  assert.equal(fixture.sourceInputs[0]?.deviceId, DEVICE);
  assert.equal(fixture.sourceInputs[0]?.realtimeSessionRef, SESSION_REF);
  assert.deepEqual(fixture.evidenceInputs[0]?.sourceMediaRef, SOURCE_REF);
  assert.equal(fixture.evidenceInputs[0]?.deviceId, CANONICAL_DEVICE_ID);
  assert.equal(fixture.evidenceInputs[0]?.transcriptState, 'final');
  assert.equal(fixture.evidenceInputs[0]?.language, 'und');
});

test('missing current binding fails closed before source issuance or final evidence', async () => {
  const fixture = harness({ resolve: async () => undefined });
  await assert.rejects(fixture.authority.finalize(input()), code('RAYNEO_FINAL_TRANSCRIPT_BINDING_UNAVAILABLE'));
  assert.deepEqual(fixture.order, ['binding']);
  assert.equal(fixture.sourceInputs.length, 0);
  assert.equal(fixture.evidenceInputs.length, 0);
});

test('T13 source-media issuer failure fails closed before T11B', async () => {
  const fixture = harness({ issue: async () => { throw new Error('T13_ISSUER_FAILED'); } });
  await assert.rejects(fixture.authority.finalize(input()), code('RAYNEO_SOURCE_MEDIA_AUTHORITY_FAILED'));
  assert.deepEqual(fixture.order, ['binding', 'source-media']);
  assert.equal(fixture.evidenceInputs.length, 0);
});

test('T11B final-evidence failure is surfaced as a fail-closed authority error', async () => {
  const fixture = harness({ finalize: async () => { throw new Error('T11B_FINALIZE_FAILED'); } });
  await assert.rejects(fixture.authority.finalize(input()), code('RAYNEO_FINAL_TRANSCRIPT_AUTHORITY_FAILED'));
  assert.deepEqual(fixture.order, ['binding', 'source-media', 'final-evidence']);
});

test('same operation replays exactly and same-key transcript drift is rejected', async () => {
  const seen = new Map<string, string>();
  const fixture = harness({
    finalize: async (request) => {
      const fingerprint = JSON.stringify({
        ...request,
        realtimeSessionRef: request.realtimeSessionRef,
        sourceMediaRef: request.sourceMediaRef,
      });
      const prior = seen.get(request.idempotencyKey);
      if (prior !== undefined && prior !== fingerprint) throw new Error('FINAL_TRANSCRIPT_IDEMPOTENCY_CONFLICT');
      seen.set(request.idempotencyKey, fingerprint);
      return RESULT;
    },
  });
  await fixture.authority.finalize(input());
  await fixture.authority.finalize(input());
  await assert.rejects(
    fixture.authority.finalize(input({ transcript: '漂移后的测试词。' })),
    code('RAYNEO_FINAL_TRANSCRIPT_AUTHORITY_FAILED'),
  );
  assert.equal(fixture.sourceInputs[0]?.idempotencyKey, fixture.sourceInputs[1]?.idempotencyKey);
  assert.equal(fixture.evidenceInputs[0]?.idempotencyKey, fixture.evidenceInputs[1]?.idempotencyKey);
  assert.equal(fixture.evidenceInputs[0]?.idempotencyKey, fixture.evidenceInputs[2]?.idempotencyKey);
  assert.equal(fixture.sourceInputs[0]?.fingerprint, fixture.sourceInputs[2]?.fingerprint);
});

test('issuer output must be a real T11B source canonical ref; adapter never fabricates one', async () => {
  const fixture = harness({
    issue: async () => ({ refType: 'SourceArtifact', refId: 'not-a-canonical-ref' } as T11BCanonicalRef),
  });
  await assert.rejects(fixture.authority.finalize(input()), code('RAYNEO_SOURCE_MEDIA_REFERENCE_INVALID'));
  assert.equal(fixture.evidenceInputs.length, 0);
});
