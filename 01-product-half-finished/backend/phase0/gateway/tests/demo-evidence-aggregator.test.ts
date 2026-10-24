import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DemoEvidenceAggregator,
  SYNTHETIC_REHEARSAL_LABEL,
  evaluateDemoRun,
  type DemoRunEvidence,
} from '../src/demo-evidence-aggregator.ts';

const SHA = 'a'.repeat(64);
const DEVICES = {
  iphone: 'iphone_device_bbbbbbbbbbbbbbbbbbbb',
  watch: 'watch_device_cccccccccccccccccccc',
  rayneo: 'rayneo_device_dddddddddddddddddddd',
} as const;

function run(index: number, mode: 'synthetic' | 'physical' = 'synthetic'): DemoRunEvidence {
  const base = Date.parse('2026-08-12T02:00:00.000Z') + index * 4_000_000;
  return {
    runId: `phase0_run_${String(index).repeat(20)}`,
    sessionId: `phase0_session_${String(index).repeat(20)}`,
    evidenceMode: mode,
    label: mode === 'synthetic' ? SYNTHETIC_REHEARSAL_LABEL : 'PHYSICAL_CANDIDATE_PENDING_T14',
    usedMockOrSimulator: mode === 'synthetic',
    deviceIds: DEVICES,
    steps: Array.from({ length: 12 }, (_, step) => ({
      step: step + 1,
      status: 'passed' as const,
      occurredAt: new Date(base + step * 100).toISOString(),
      evidenceRefs: [`evidence/run-${index}/step-${step + 1}.json`],
      latencyMs: step === 6 || step === 7 ? 800 : 20,
    })),
    provenance: {
      sourceSha256: SHA,
      binarySha256: 'b'.repeat(64),
      dependencyLockSha256: 'c'.repeat(64),
      deviceOsIdentities: ['iphone / ios / signed', 'watch / watchos / paired', 'rayneo / android / worn'],
    },
    iphoneVoiceDurationMs: 1_800_000,
    rayneoLowRateDurationMs: 1_800_000,
    rayneoAcceptedFrames: 360,
    rayneoTelemetryBuckets: 30,
    handoffLatenciesMs: [800, 900],
    publicStopEffectCount: 1,
  };
}

test('three synthetic rehearsals retain zero Gate credit', () => {
  const aggregator = new DemoEvidenceAggregator();
  for (const index of [1, 2, 3]) {
    const evaluated = aggregator.record(run(index));
    assert.equal(evaluated.complete, true);
    assert.equal(evaluated.eligibleForIndependentReview, false);
    assert.equal(evaluated.gateCredit, 0);
  }
  assert.deepEqual(aggregator.summary(), {
    recordedRuns: 3,
    syntheticRuns: 3,
    physicalCandidates: 0,
    uniqueSessionIds: true,
    stableInstallDeviceIds: true,
    readyForIndependentReview: false,
    finalGateGranted: false,
    gateCredit: 0,
    runs: [1, 2, 3].map((index) => ({
      runId: `phase0_run_${String(index).repeat(20)}`,
      sessionId: `phase0_session_${String(index).repeat(20)}`,
      evidenceMode: 'synthetic', complete: true,
      eligibleForIndependentReview: false, gateCredit: 0, failures: [],
    })),
  });
});

test('physical candidates remain pending independent review and never self-grant', () => {
  const aggregator = new DemoEvidenceAggregator();
  for (const index of [4, 5, 6]) aggregator.record(run(index, 'physical'));
  const summary = aggregator.summary();
  assert.equal(summary.physicalCandidates, 3);
  assert.equal(summary.readyForIndependentReview, true);
  assert.equal(summary.finalGateGranted, false);
  assert.equal(summary.gateCredit, 0);
});

test('rejects incomplete physical criteria and cross-run identity drift', () => {
  const incomplete = run(7, 'physical');
  const evaluated = evaluateDemoRun({ ...incomplete, publicStopEffectCount: 2, rayneoTelemetryBuckets: 29 });
  assert.equal(evaluated.eligibleForIndependentReview, false);
  assert.deepEqual(evaluated.failures, ['RAYNEO_TELEMETRY_BUCKETS_INVALID', 'PUBLIC_STOP_EFFECT_COUNT_INVALID']);

  const aggregator = new DemoEvidenceAggregator();
  aggregator.record(run(7));
  assert.throws(() => aggregator.record({
    ...run(8), deviceIds: { ...DEVICES, watch: 'watch_device_eeeeeeeeeeeeeeeeeeee' },
  }), /INSTALL_DEVICE_ID_DRIFT/);
  assert.throws(() => aggregator.record({ ...run(8), sessionId: run(7).sessionId }), /SESSION_ID_REUSE/);
});
