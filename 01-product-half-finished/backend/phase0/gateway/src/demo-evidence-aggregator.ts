export const SYNTHETIC_REHEARSAL_LABEL = 'SYNTHETIC_REHEARSAL_NOT_GATE' as const;

export interface DemoStepEvidence {
  readonly step: number;
  readonly status: 'passed' | 'failed';
  readonly occurredAt: string;
  readonly evidenceRefs: readonly string[];
  readonly latencyMs?: number;
}

export interface DemoRunProvenance {
  readonly sourceSha256: string;
  readonly binarySha256: string;
  readonly dependencyLockSha256: string;
  readonly deviceOsIdentities: readonly string[];
}

export interface DemoRunEvidence {
  readonly runId: string;
  readonly sessionId: string;
  readonly evidenceMode: 'synthetic' | 'physical';
  readonly label: typeof SYNTHETIC_REHEARSAL_LABEL | 'PHYSICAL_CANDIDATE_PENDING_T14';
  readonly usedMockOrSimulator: boolean;
  readonly deviceIds: Readonly<{ iphone: string; watch: string; rayneo: string }>;
  readonly steps: readonly DemoStepEvidence[];
  readonly provenance: DemoRunProvenance;
  readonly iphoneVoiceDurationMs: number;
  readonly rayneoLowRateDurationMs: number;
  readonly rayneoAcceptedFrames: number;
  readonly rayneoTelemetryBuckets: number;
  readonly handoffLatenciesMs: readonly number[];
  readonly publicStopEffectCount: number;
}

export interface EvaluatedDemoRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly evidenceMode: 'synthetic' | 'physical';
  readonly complete: boolean;
  readonly eligibleForIndependentReview: boolean;
  readonly gateCredit: 0;
  readonly failures: readonly string[];
}

export interface DemoEvidenceSummary {
  readonly recordedRuns: number;
  readonly syntheticRuns: number;
  readonly physicalCandidates: number;
  readonly uniqueSessionIds: boolean;
  readonly stableInstallDeviceIds: boolean;
  readonly readyForIndependentReview: boolean;
  readonly finalGateGranted: false;
  readonly gateCredit: 0;
  readonly runs: readonly EvaluatedDemoRun[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function validTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value;
}

function exactTwelveSteps(steps: readonly DemoStepEvidence[]): boolean {
  if (steps.length !== 12) return false;
  let previous = -1;
  return steps.every((step, index) => {
    const occurredAt = Date.parse(step.occurredAt);
    const valid = step.step === index + 1 &&
      step.status === 'passed' &&
      validTimestamp(step.occurredAt) &&
      occurredAt > previous &&
      step.evidenceRefs.length > 0;
    previous = occurredAt;
    return valid;
  });
}

function hasCompleteProvenance(provenance: DemoRunProvenance): boolean {
  return SHA256.test(provenance.sourceSha256) &&
    SHA256.test(provenance.binarySha256) &&
    SHA256.test(provenance.dependencyLockSha256) &&
    provenance.deviceOsIdentities.length === 3 &&
    provenance.deviceOsIdentities.every((identity) => identity.length >= 3 && identity.length <= 160);
}

export function evaluateDemoRun(run: DemoRunEvidence): EvaluatedDemoRun {
  const failures: string[] = [];
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(run.runId)) failures.push('RUN_ID_INVALID');
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(run.sessionId)) failures.push('SESSION_ID_INVALID');
  if (new Set(Object.values(run.deviceIds)).size !== 3) failures.push('DEVICE_IDENTITY_COLLISION');
  if (!exactTwelveSteps(run.steps)) failures.push('TWELVE_STEP_SEQUENCE_INCOMPLETE');
  if (!hasCompleteProvenance(run.provenance)) failures.push('PROVENANCE_INCOMPLETE');

  if (run.evidenceMode === 'synthetic') {
    if (run.label !== SYNTHETIC_REHEARSAL_LABEL) failures.push('SYNTHETIC_LABEL_INVALID');
    return Object.freeze({
      runId: run.runId,
      sessionId: run.sessionId,
      evidenceMode: run.evidenceMode,
      complete: failures.length === 0,
      eligibleForIndependentReview: false,
      gateCredit: 0,
      failures,
    });
  }

  if (run.label !== 'PHYSICAL_CANDIDATE_PENDING_T14') failures.push('PHYSICAL_LABEL_INVALID');
  if (run.usedMockOrSimulator) failures.push('PHYSICAL_PROVENANCE_REJECTED');
  if (run.iphoneVoiceDurationMs < 1_800_000) failures.push('IPHONE_VOICE_DURATION_SHORT');
  if (run.rayneoLowRateDurationMs !== 1_800_000) failures.push('RAYNEO_WINDOW_INVALID');
  if (run.rayneoAcceptedFrames < 360 || run.rayneoAcceptedFrames > 1_800) failures.push('RAYNEO_FRAME_COUNT_INVALID');
  if (run.rayneoTelemetryBuckets !== 30) failures.push('RAYNEO_TELEMETRY_BUCKETS_INVALID');
  if (run.handoffLatenciesMs.length !== 2 || run.handoffLatenciesMs.some((latency) => latency < 0 || latency >= 10_000)) {
    failures.push('HANDOFF_LATENCY_INVALID');
  }
  if (run.publicStopEffectCount !== 1) failures.push('PUBLIC_STOP_EFFECT_COUNT_INVALID');
  return Object.freeze({
    runId: run.runId,
    sessionId: run.sessionId,
    evidenceMode: run.evidenceMode,
    complete: failures.length === 0,
    eligibleForIndependentReview: failures.length === 0,
    gateCredit: 0,
    failures,
  });
}

/** Bounded current-evaluation accumulator, never a durable evidence ledger. */
export class DemoEvidenceAggregator {
  readonly #runs: DemoRunEvidence[] = [];
  readonly #evaluated: EvaluatedDemoRun[] = [];

  record(run: DemoRunEvidence): EvaluatedDemoRun {
    if (this.#runs.length >= 3) throw new Error('RUN_LIMIT_REACHED');
    if (this.#runs.some((candidate) => candidate.runId === run.runId)) throw new Error('RUN_ID_CONFLICT');
    if (this.#runs.some((candidate) => candidate.sessionId === run.sessionId)) throw new Error('SESSION_ID_REUSE');
    const prior = this.#runs[0];
    if (prior && (
      prior.deviceIds.iphone !== run.deviceIds.iphone ||
      prior.deviceIds.watch !== run.deviceIds.watch ||
      prior.deviceIds.rayneo !== run.deviceIds.rayneo
    )) throw new Error('INSTALL_DEVICE_ID_DRIFT');
    const evaluated = evaluateDemoRun(run);
    this.#runs.push(run);
    this.#evaluated.push(evaluated);
    return evaluated;
  }

  summary(): DemoEvidenceSummary {
    const physical = this.#evaluated.filter((run) => run.evidenceMode === 'physical');
    return Object.freeze({
      recordedRuns: this.#runs.length,
      syntheticRuns: this.#evaluated.filter((run) => run.evidenceMode === 'synthetic').length,
      physicalCandidates: physical.filter((run) => run.eligibleForIndependentReview).length,
      uniqueSessionIds: new Set(this.#runs.map((run) => run.sessionId)).size === this.#runs.length,
      stableInstallDeviceIds: this.#runs.every((run) => {
        const first = this.#runs[0];
        return first !== undefined &&
          run.deviceIds.iphone === first.deviceIds.iphone &&
          run.deviceIds.watch === first.deviceIds.watch &&
          run.deviceIds.rayneo === first.deviceIds.rayneo;
      }),
      readyForIndependentReview: this.#runs.length === 3 && physical.length === 3 && physical.every((run) => run.eligibleForIndependentReview),
      finalGateGranted: false,
      gateCredit: 0,
      runs: this.#evaluated.map((run) => ({ ...run, failures: [...run.failures] })),
    });
  }
}
