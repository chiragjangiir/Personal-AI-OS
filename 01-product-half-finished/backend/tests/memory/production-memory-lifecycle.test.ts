import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createProductionMemoryLifecycle,
  ProductionMemoryLifecycleError,
  type MemoryColdCasLifecyclePort,
  type ProductionMemoryColdCasLifecycleReceipt,
  type ProductionMemoryLifecycleAction,
  type ProductionMemoryLifecycleAuthorityPort,
  type ProductionMemoryLifecycleAuthorityReceipt,
  type ProductionMemoryLifecycleEnvelope,
} from "../../services/memory-os/src/production-memory-lifecycle.ts";
import {
  assertCanonicalObjectVersionRef,
  canonicalRefKey,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../services/memory-os/src/canonical-ref.ts";
import {
  createProductionMemoryCanonicalIssuer,
  type ProductionMemoryIssuerReceipt,
} from "../../services/memory-os/src/canonical-issuer.ts";
import {
  createProductionMemoryApplicationService,
} from "../../services/memory-os/src/memory-application-service.ts";
import {
  createProductionMemoryReviewService,
} from "../../services/memory-os/src/memory-review-service.ts";
import type {
  AdmittedMemoryCandidateIntent,
} from "../../services/memory-os/src/admission.ts";
import type {
  AuthorityWatermark,
  CompilerQuery,
  MemoryCandidateQuery,
  MemoryCandidateRecord,
  MemoryCandidateSnapshot,
  MemoryCommandResult,
  MemoryCommitReceipt,
  MemoryQuerySnapshot,
  MemoryReviewCommandIdentity,
  MemoryReviewReceipt,
  MemoryReviewReplayRecord,
  MemoryReviewStateQuery,
  MemoryReviewStateSnapshot,
  MemoryVersionRecord,
} from "../../services/memory-os/src/domain.ts";
import { assertCanonicalUtcInstant } from "../../services/memory-os/src/domain.ts";
import type {
  MemoryCandidateBatchCommitCommand,
  MemoryCandidateReviewCommand,
  MemoryCommandRepository,
  MemoryCommandTransaction,
  MemoryCorrectionCommitCommand,
  MemoryRepository,
  MemoryCandidateReader,
  MemoryReviewReceiptReader,
  MemoryReviewStateReader,
} from "../../services/memory-os/src/ports.ts";
import type {
  ProductionMemoryReady,
  ProductionMemoryReadyBinding,
} from "../../services/memory-os/src/production-memory-ready.ts";
import type {
  ProductionDreamRunService,
  DreamRunInput,
  DreamRunResult,
} from "../../services/memory-os/src/dream-run-service.ts";
import type {
  DeletionRebuildApplicationService,
  DeletionRebuildRequest,
  DeletionRebuildResult,
} from "../../services/memory-os/src/deletion-rebuild-service.ts";

const NOW = assertCanonicalUtcInstant("2026-08-30T12:00:00.000Z");
const SYSTEM_NOW = "2026-08-30T12:00:00.000000Z";
const DREAM_FROM = assertCanonicalUtcInstant("2026-08-29T16:00:00.000Z");
const DREAM_TO = assertCanonicalUtcInstant("2026-08-30T16:00:00.000Z");
const WATERMARK: AuthorityWatermark = Object.freeze({ epoch: "31" });

function ref(
  refType: CanonicalObjectVersionRef["refType"],
  serial: number,
  hashCharacter = "a",
): CanonicalObjectVersionRef {
  return assertCanonicalObjectVersionRef({
    refType,
    refId: `01890f0e-0000-7000-8000-${serial.toString().padStart(12, "0")}`,
    objectVersion: "1",
    canonicalPayloadSha256: hashCharacter.repeat(64),
  });
}

const BINDING: ProductionMemoryReadyBinding = Object.freeze({
  userId: "user-owner-001",
  sessionId: "session-owner-001",
  deviceId: "device-owner-001",
  clientInstanceId: "client-owner-001",
  realtimeSessionRef: Object.freeze({ ref_type: "RealtimeSession", ref_id: "session-owner-001" }),
  continuityId: "continuity-owner-001",
  purpose: "personal_assistant",
});

const GOVERNANCE_REF = ref("PolicyDecision", 1, "1");
const EXPLICIT_EVIDENCE_REF = ref("TextEvidence", 2, "2");
const DREAM_EVIDENCE_REF = ref("Observation", 3, "3");
const DELETION_JOB_REF = ref("DeletionJob", 4, "4");

function authorityReceipt(
  action: ProductionMemoryLifecycleAction,
  idempotencyKey: string,
  binding: ProductionMemoryReadyBinding = BINDING,
  governanceRef: CanonicalObjectVersionRef = GOVERNANCE_REF,
): ProductionMemoryLifecycleAuthorityReceipt {
  return Object.freeze({
    kind: "production_memory_lifecycle_authority_receipt",
    action,
    requestId: `request:${idempotencyKey}`,
    idempotencyKey,
    binding,
    governanceRef,
    requestedAt: NOW,
    authorizedAt: NOW,
    authorityWatermark: WATERMARK,
  });
}

function envelope(
  action: ProductionMemoryLifecycleAction,
  idempotencyKey: string,
  overrides: Partial<Pick<ProductionMemoryLifecycleEnvelope, "binding" | "governanceRef">> = {},
): ProductionMemoryLifecycleEnvelope {
  const binding = overrides.binding ?? BINDING;
  const governanceRef = overrides.governanceRef ?? GOVERNANCE_REF;
  return Object.freeze({
    requestId: `request:${idempotencyKey}`,
    idempotencyKey,
    binding,
    governanceRef,
    requestedAt: NOW,
    authorityReceipt: authorityReceipt(action, idempotencyKey, binding, governanceRef),
  });
}

function candidate(input: {
  readonly kind: "create" | "correct";
  readonly idempotencyKey: string;
  readonly slot: string;
  readonly value: string;
  readonly target?: CanonicalObjectVersionRef;
  readonly sourceClass?: "explicit_user_correction" | "model_inference";
  readonly userId?: string;
  readonly purposeScopes?: readonly string[];
}): AdmittedMemoryCandidateIntent {
  const sourceClass = input.sourceClass ?? (input.kind === "correct" ? "explicit_user_correction" : "model_inference");
  const evidenceRefs = input.target === undefined
    ? [sourceClass === "model_inference" ? DREAM_EVIDENCE_REF : EXPLICIT_EVIDENCE_REF]
    : [input.target, EXPLICIT_EVIDENCE_REF];
  return Object.freeze({
    kind: input.kind,
    status: "candidate" as const,
    proposalId: `proposal:${input.idempotencyKey}`,
    slot: input.slot,
    value: input.value,
    evidenceRefs: Object.freeze(evidenceRefs),
    sourceClass,
    confidencePpm: 990_000,
    idempotencyKey: input.idempotencyKey,
    current: false as const,
    memoryKind: "preference_memory" as const,
    userId: input.userId ?? BINDING.userId,
    purposeScopes: Object.freeze([...(input.purposeScopes ?? [BINDING.purpose])]),
    sensitivity: Object.freeze({ classification: "normal" as const, userConfirmed: true }),
    validity: Object.freeze({ observedAt: NOW }),
    ...(input.target === undefined ? {} : {
      target: input.target,
      correctionIntent: Object.freeze({
        kind: "correct" as const,
        target: input.target,
        evidenceRefs: Object.freeze([input.target, EXPLICIT_EVIDENCE_REF]),
      }),
    }),
  });
}

function candidateRecord(
  intent: AdmittedMemoryCandidateIntent,
  candidateRef: CanonicalObjectVersionRef,
): MemoryCandidateRecord {
  return Object.freeze({
    ...intent,
    candidateRef,
    requiresReview: true,
  });
}

function memoryRecord(
  memoryRef: CanonicalObjectVersionRef,
  intent: AdmittedMemoryCandidateIntent | MemoryCandidateRecord,
  resolvedContent: string,
  supersedes?: CanonicalObjectVersionRef,
): MemoryVersionRecord {
  return Object.freeze({
    ref: memoryRef,
    userId: intent.userId,
    kind: intent.memoryKind,
    slot: intent.slot,
    value: intent.value,
    resolvedContent,
    status: "current" as const,
    current: true,
    sourceClass: intent.sourceClass,
    evidenceRefs: intent.evidenceRefs,
    confidencePpm: intent.confidencePpm,
    allowedPurposeScopes: intent.purposeScopes,
    sensitivity: intent.sensitivity,
    validity: intent.validity,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(intent.correctionIntent === undefined ? {} : { correctionIntent: intent.correctionIntent }),
  });
}

class InMemoryOwnerRepository implements MemoryRepository, MemoryCandidateReader,
  MemoryReviewStateReader, MemoryReviewReceiptReader, MemoryCommandRepository {
  readonly candidates = new Map<string, MemoryCandidateRecord>();
  readonly currentBySlot = new Map<string, MemoryVersionRecord>();
  readonly reviewReceipts = new Map<string, MemoryReviewReplayRecord>();
  readonly superseded = new Set<string>();
  applicationCorrectionCalls = 0;
  reviewCalls = 0;
  failNextCorrection = false;

  async loadCompilerSnapshot(query: CompilerQuery): Promise<MemoryQuerySnapshot> {
    return Object.freeze({ query, records: Object.freeze([...this.currentBySlot.values()]), authorityWatermark: WATERMARK });
  }

  async findCurrentBySlot(slot: string, _query: CompilerQuery): Promise<MemoryVersionRecord | undefined> {
    return this.currentBySlot.get(slot);
  }

  async loadCandidateSnapshot(query: MemoryCandidateQuery): Promise<MemoryCandidateSnapshot> {
    const records = [...this.candidates.values()].filter((item) => item.userId === query.userId &&
      (query.slot === undefined || item.slot === query.slot) &&
      (query.statuses === undefined || query.statuses.includes(item.status))).slice(0, query.maxItems);
    return Object.freeze({ query, records: Object.freeze(records), authorityWatermark: WATERMARK });
  }

  async findCandidateByRef(candidateRef: CanonicalObjectVersionRef): Promise<MemoryCandidateRecord | undefined> {
    return this.candidates.get(canonicalRefKey(candidateRef));
  }

  async findAuthoritativeCurrentBySlot(query: MemoryReviewStateQuery): Promise<MemoryReviewStateSnapshot> {
    const current = this.currentBySlot.get(query.slot);
    const currentRecords = current === undefined || current.userId !== query.userId ? [] : [current];
    return Object.freeze({ query, currentRecords: Object.freeze(currentRecords), conflict: false, authorityWatermark: WATERMARK });
  }

  async findReviewReceiptByIdempotencyKey(input: { readonly idempotencyKey: string }): Promise<MemoryReviewReplayRecord | undefined> {
    return this.reviewReceipts.get(input.idempotencyKey);
  }

  async withTransaction<T>(run: (transaction: MemoryCommandTransaction) => Promise<T>): Promise<T> {
    const transaction: MemoryCommandTransaction = {
      commitCandidateBatch: async (command: MemoryCandidateBatchCommitCommand) => {
        const refs = command.issuerReceipt?.candidateRef === undefined ? [] : [command.issuerReceipt.candidateRef];
        return {
          ok: true,
          receipt: Object.freeze({
            kind: "memory_commit_receipt" as const,
            operation: "candidate_batch" as const,
            outcome: "committed" as const,
            idempotencyKey: command.idempotencyKey,
            fingerprint: command.fingerprint,
            canonicalRefs: Object.freeze(refs),
            supersededRefs: Object.freeze([]),
            authorityWatermark: WATERMARK,
          }),
        };
      },
      commitCorrection: async (command: MemoryCorrectionCommitCommand) => this.commitCorrection(command),
      reviewCandidate: async (command: MemoryCandidateReviewCommand) => this.reviewCandidate(command),
    };
    return run(transaction);
  }

  private async commitCorrection(
    command: MemoryCorrectionCommitCommand,
  ): Promise<MemoryCommandResult<MemoryCommitReceipt>> {
    this.applicationCorrectionCalls += 1;
    if (this.failNextCorrection) {
      this.failNextCorrection = false;
      return { ok: false, error: { code: "TRANSACTION_ABORTED", retryable: true } };
    }
    const current = this.currentBySlot.get(command.replacement.slot);
    const replacementRef = command.issuerReceipt?.memoryRef;
    if (current === undefined || !sameRef(current.ref, command.expectedCurrentRef) || replacementRef === undefined) {
      return { ok: false, error: { code: "CURRENT_VERSION_CONFLICT", retryable: false } };
    }
    this.superseded.add(canonicalRefKey(current.ref));
    this.currentBySlot.set(command.replacement.slot, memoryRecord(
      replacementRef,
      command.replacement,
      command.resolvedContent ?? String(command.replacement.value),
      current.ref,
    ));
    return {
      ok: true,
      receipt: Object.freeze({
        kind: "memory_commit_receipt",
        operation: "correction",
        outcome: "committed",
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
        canonicalRefs: Object.freeze([replacementRef]),
        supersededRefs: Object.freeze([current.ref]),
        authorityWatermark: WATERMARK,
      }),
    };
  }

  private async reviewCandidate(
    command: MemoryCandidateReviewCommand,
  ): Promise<MemoryCommandResult<MemoryReviewReceipt>> {
    this.reviewCalls += 1;
    const candidateValue = this.candidates.get(canonicalRefKey(command.candidateRef));
    if (candidateValue === undefined) return { ok: false, error: { code: "CANDIDATE_NOT_FOUND", retryable: false } };
    const accepted = command.resolution === "accept_new" || command.resolution === "accept_superseding" ||
      command.resolution === "accept_existing";
    const created = command.resolution === "accept_new" || command.resolution === "accept_superseding"
      ? command.canonicalMemoryRef === undefined ? [] : [command.canonicalMemoryRef]
      : [];
    const linked = command.resolution === "accept_existing" && command.expectedCurrentRef !== undefined
      ? [command.expectedCurrentRef]
      : [];
    const currentRefs = accepted ? (created.length > 0 ? created : linked) : [];
    const supersededRefs = command.resolution === "accept_superseding" && command.expectedCurrentRef !== undefined
      ? [command.expectedCurrentRef]
      : [];
    if (created[0] !== undefined) {
      this.currentBySlot.set(candidateValue.slot, memoryRecord(
        created[0],
        candidateValue,
        command.resolvedContent ?? String(candidateValue.value),
        command.expectedCurrentRef,
      ));
    }
    const candidateStatus = command.resolution === "reject" ? "rejected" :
      command.resolution === "quarantine" ? "quarantined" : accepted ? "accepted" : "candidate";
    const receipt: MemoryReviewReceipt = Object.freeze({
      kind: "memory_review_receipt",
      outcome: "committed",
      idempotencyKey: command.idempotencyKey,
      fingerprint: command.fingerprint,
      candidateRef: command.candidateRef,
      candidateStatus,
      decision: command.decision,
      resolution: command.resolution,
      createdMemoryRefs: Object.freeze(created),
      linkedMemoryRefs: Object.freeze(linked),
      currentMemoryRefs: Object.freeze(currentRefs),
      supersededRefs: Object.freeze(supersededRefs),
      ...(command.conflictBinding === undefined ? {} : { conflictBinding: command.conflictBinding }),
      authorityWatermark: WATERMARK,
    });
    const commandIdentity: MemoryReviewCommandIdentity = Object.freeze({ ...command });
    this.reviewReceipts.set(command.idempotencyKey, Object.freeze({
      requestFingerprint: command.requestFingerprint,
      commandIdentity,
      receipt,
    }));
    return { ok: true, receipt };
  }
}

function sameRef(left: CanonicalObjectVersionRef, right: CanonicalObjectVersionRef): boolean {
  return canonicalRefKey(left) === canonicalRefKey(right);
}

function createHarness() {
  const repository = new InMemoryOwnerRepository();
  const issuer = createProductionMemoryCanonicalIssuer();
  const context = Object.freeze({ systemTime: SYSTEM_NOW, createdAt: NOW, updatedAt: NOW, reviewedAt: NOW });
  const initialCandidate = candidate({
    kind: "create",
    idempotencyKey: "initial",
    slot: "user.display-density",
    value: "compact",
    sourceClass: "model_inference",
  });
  const initialCandidateReceipt = issuer.issueCandidate({ candidate: initialCandidate, context });
  const initialMemoryReceipt = issuer.issueMemory({
    candidate: initialCandidate,
    candidateReceipt: initialCandidateReceipt,
    context,
    resolvedContent: "compact",
  });
  repository.currentBySlot.set(initialCandidate.slot, memoryRecord(
    initialMemoryReceipt.memoryRef!, initialCandidate, "compact",
  ));

  let authorityCalls = 0;
  const authority: ProductionMemoryLifecycleAuthorityPort = Object.freeze({
    async verify(input: Parameters<ProductionMemoryLifecycleAuthorityPort["verify"]>[0]) {
      authorityCalls += 1;
      return { ok: true as const, value: input.envelope.authorityReceipt };
    },
  });
  let memoryCloseCalls = 0;
  let rememberCalls = 0;
  const memoryReady: ProductionMemoryReady = Object.freeze({
    async rememberFinalTranscript() {
      rememberCalls += 1;
      return undefined;
    },
    async recallForAnswerContext() {
      return Object.freeze({
        memories: Object.freeze([...repository.currentBySlot.values()].map((record) => Object.freeze({
          ref: record.ref,
          boundedContent: record.resolvedContent,
          selectionReason: "authoritative_current",
        }))),
        suppressions: Object.freeze([]),
        authorityWatermark: WATERMARK,
      });
    },
    async close() {
      memoryCloseCalls += 1;
    },
  });
  let coldCasCalls = 0;
  let coldCasCloseCalls = 0;
  const coldCas: MemoryColdCasLifecyclePort = Object.freeze({
    async applyAuthorizedLifecycle(input: Parameters<MemoryColdCasLifecyclePort["applyAuthorizedLifecycle"]>[0]) {
      coldCasCalls += 1;
      const result = input.deletion.rebuildResult!;
      const receipt: ProductionMemoryColdCasLifecycleReceipt = Object.freeze({
        kind: "production_memory_cold_cas_lifecycle_receipt",
        outcome: input.deletion.status === "replayed" ? "replayed" : "applied",
        requestId: input.envelope.requestId,
        idempotencyKey: input.envelope.idempotencyKey,
        deletionJobRef: input.deletion.plan!.deletionJobRef,
        consumedSourceRefs: result.consumedSourceRefs,
        skippedDeletedSourceRefs: result.skippedDeletedSourceRefs,
        authorityWatermark: result.authorityWatermark,
        completedAt: result.completedAt,
      });
      return { ok: true as const, value: receipt };
    },
    async close() {
      coldCasCloseCalls += 1;
    },
  });

  const application = createProductionMemoryApplicationService(repository, repository);
  const review = createProductionMemoryReviewService(repository, repository, repository, repository);
  const dreamQueue: DreamRunResult[] = [];
  const dreamInputs: DreamRunInput[] = [];
  const dream = {
    async runPage(input: DreamRunInput) {
      dreamInputs.push(input);
      const next = dreamQueue.shift();
      assert.notEqual(next, undefined);
      return next!;
    },
  } as unknown as ProductionDreamRunService;
  const deletionQueue: DeletionRebuildResult[] = [];
  const deletion = {
    async execute(_input: DeletionRebuildRequest) {
      const next = deletionQueue.shift();
      assert.notEqual(next, undefined);
      return next!;
    },
  } as DeletionRebuildApplicationService;
  const lifecycle = createProductionMemoryLifecycle({
    binding: BINDING,
    governanceRef: GOVERNANCE_REF,
    authority,
    memoryReady,
    application,
    review,
    candidateReader: repository,
    dream,
    deletion,
    coldCas,
  });
  return {
    lifecycle,
    repository,
    issuer,
    context,
    initialMemoryReceipt,
    dreamQueue,
    dreamInputs,
    deletionQueue,
    counts: {
      authority: () => authorityCalls,
      remember: () => rememberCalls,
      coldCas: () => coldCasCalls,
      memoryClose: () => memoryCloseCalls,
      coldCasClose: () => coldCasCloseCalls,
    },
  };
}

test("explicit correction uses the production application service, supersedes the old ref, and replays exactly", async () => {
  const harness = createHarness();
  const oldRef = harness.initialMemoryReceipt.memoryRef!;
  const replacement = candidate({
    kind: "correct",
    idempotencyKey: "correction-001",
    slot: "user.display-density",
    value: "sparse",
    target: oldRef,
  });
  const candidateReceipt = harness.issuer.issueCandidate({ candidate: replacement, context: harness.context });
  const successorReceipt = harness.issuer.issueMemorySuccessor({
    candidate: replacement,
    candidateReceipt,
    previous: harness.initialMemoryReceipt,
    context: harness.context,
    resolvedContent: "sparse",
  });
  const call = Object.freeze({
    envelope: envelope("correct_memory", "correction-001"),
    input: Object.freeze({
      idempotencyKey: "correction-001",
      expectedCurrentRef: oldRef,
      candidate: replacement,
      resolvedContent: "sparse",
      issuerReceipt: successorReceipt,
    }),
  });
  const first = await harness.lifecycle.correctMemory(call);
  assert.equal(first.value.ok, true);
  if (!first.value.ok) return;
  assert.deepEqual(first.value.receipt.supersededRefs.map(canonicalRefKey), [canonicalRefKey(oldRef)]);
  const replay = await harness.lifecycle.correctMemory(call);
  assert.strictEqual(replay, first);
  assert.equal(harness.repository.applicationCorrectionCalls, 1);

  const recalled = await harness.lifecycle.recallForAnswerContext({
    envelope: envelope("recall_for_answer_context", "recall-after-correction"),
    input: Object.freeze({ maxItems: 8, maxContentBytes: 4_096, asOf: NOW }),
  });
  assert.equal(recalled.value.memories.some((item) => sameRef(item.ref, oldRef)), false);
  assert.equal(recalled.value.memories.some((item) => sameRef(item.ref, successorReceipt.memoryRef!)), true);

  assert.throws(
    () => harness.lifecycle.correctMemory({
      ...call,
      input: Object.freeze({ ...call.input, resolvedContent: "different" }),
    }),
    (error: unknown) => error instanceof ProductionMemoryLifecycleError &&
      error.code === "MEMORY_LIFECYCLE_IDEMPOTENCY_CONFLICT",
  );
});

test("Dream pages remain candidate-only until explicit review; reject and quarantine never become current", async () => {
  const harness = createHarness();
  const dreamIntent = candidate({
    kind: "create",
    idempotencyKey: "dream-candidate-001",
    slot: "user.riding-hydration",
    value: "remind every 20 minutes",
    sourceClass: "model_inference",
  });
  const dreamCandidateReceipt = harness.issuer.issueCandidate({ candidate: dreamIntent, context: harness.context });
  const acceptedDreamCandidateReceipt = harness.issuer.issueCandidateSuccessor({
    previous: dreamCandidateReceipt,
    status: "accepted",
    context: harness.context,
  });
  const dreamMemoryReceipt = harness.issuer.issueMemory({
    candidate: dreamIntent,
    candidateReceipt: acceptedDreamCandidateReceipt,
    context: harness.context,
    resolvedContent: "remind every 20 minutes",
  });
  const dreamRecord = candidateRecord(dreamIntent, dreamCandidateReceipt.candidateRef!);
  harness.repository.candidates.set(canonicalRefKey(dreamRecord.candidateRef), dreamRecord);
  const nextCursor = Object.freeze({ token: "page:2", authorityWatermark: WATERMARK });
  const dreamBatch = Object.freeze({
    kind: "MemoryCandidateBatch" as const,
    batchId: "dream-batch-001",
    idempotencyKey: "dream-page-001",
    window: Object.freeze({ from: DREAM_FROM, to: DREAM_TO }),
    candidates: Object.freeze([dreamIntent]),
    rejected: Object.freeze([]),
    quarantined: Object.freeze([]),
  });
  const commitReceipt: MemoryCommitReceipt = Object.freeze({
    kind: "memory_commit_receipt",
    operation: "candidate_batch",
    outcome: "committed",
    idempotencyKey: "dream-page-001",
    fingerprint: "5".repeat(64) as Sha256,
    canonicalRefs: Object.freeze([dreamRecord.candidateRef]),
    supersededRefs: Object.freeze([]),
    authorityWatermark: WATERMARK,
  });
  harness.dreamQueue.push(Object.freeze({
    kind: "daily_dream_run",
    outcome: "committed",
    userId: BINDING.userId,
    batchId: "dream-batch-001",
    idempotencyKey: "dream-page-001",
    timeZone: "Asia/Shanghai",
    localDate: "2026-08-30",
    window: Object.freeze({ ...dreamBatch.window!, timeZone: "Asia/Shanghai", localDate: "2026-08-30", durationHours: 24 as const }),
    fingerprint: "5".repeat(64) as Sha256,
    pinnedWatermark: WATERMARK,
    readReceipt: Object.freeze({
      kind: "dream_run_read_receipt" as const,
      userId: BINDING.userId,
      timeZone: "Asia/Shanghai",
      localDate: "2026-08-30",
      window: Object.freeze({ ...dreamBatch.window!, timeZone: "Asia/Shanghai", localDate: "2026-08-30", durationHours: 24 as const }),
      acceptedDeltaRefs: Object.freeze([DREAM_EVIDENCE_REF]),
      excludedDeltaRefs: Object.freeze([]),
      authorityWatermark: WATERMARK,
      nextCursor,
    }),
    candidates: Object.freeze([dreamIntent]),
    batch: dreamBatch,
    productionReceipts: Object.freeze([dreamCandidateReceipt]),
    productionReceipt: dreamCandidateReceipt,
    commitReceipt,
  }));
  harness.dreamQueue.push(Object.freeze({
    kind: "daily_dream_run",
    outcome: "no_candidates",
    userId: BINDING.userId,
    batchId: "dream-batch-001",
    idempotencyKey: "dream-page-002",
    timeZone: "Asia/Shanghai",
    localDate: "2026-08-30",
    window: Object.freeze({ ...dreamBatch.window!, timeZone: "Asia/Shanghai", localDate: "2026-08-30", durationHours: 24 as const }),
    fingerprint: "6".repeat(64) as Sha256,
    pinnedWatermark: WATERMARK,
    readReceipt: Object.freeze({
      kind: "dream_run_read_receipt" as const,
      userId: BINDING.userId,
      timeZone: "Asia/Shanghai",
      localDate: "2026-08-30",
      window: Object.freeze({ ...dreamBatch.window!, timeZone: "Asia/Shanghai", localDate: "2026-08-30", durationHours: 24 as const }),
      acceptedDeltaRefs: Object.freeze([]),
      excludedDeltaRefs: Object.freeze([]),
      authorityWatermark: WATERMARK,
    }),
    candidates: Object.freeze([]),
    batch: Object.freeze({ ...dreamBatch, idempotencyKey: "dream-page-002", candidates: Object.freeze([]) }),
  }));
  const firstInput: DreamRunInput = Object.freeze({
    userId: BINDING.userId,
    timeZone: "Asia/Shanghai",
    localDate: "2026-08-30",
    batchId: "dream-batch-001",
    idempotencyKey: "dream-page-001",
    limit: 1,
    productionReceipt: dreamCandidateReceipt,
  });
  const first = await harness.lifecycle.runDreamPage({
    envelope: envelope("run_dream_page", "dream-page-001"),
    input: firstInput,
  });
  assert.equal(first.value.candidates.length, 1);
  const beforeReview = await harness.lifecycle.recallForAnswerContext({
    envelope: envelope("recall_for_answer_context", "recall-before-dream-review"),
    input: Object.freeze({ maxItems: 8, maxContentBytes: 4_096, asOf: NOW }),
  });
  assert.equal(beforeReview.value.memories.some((item) => item.boundedContent.includes("hydration")), false);
  const {
    productionReceipt: _firstProductionReceipt,
    ...secondSourceInput
  } = firstInput;
  const second = await harness.lifecycle.runDreamPage({
    envelope: envelope("run_dream_page", "dream-page-002"),
    input: Object.freeze({ ...secondSourceInput, idempotencyKey: "dream-page-002", cursor: nextCursor }),
  });
  assert.equal(second.value.candidates.length, 0);
  assert.equal(harness.dreamInputs[1]?.cursor?.token, "page:2");

  const accepted = await harness.lifecycle.reviewCandidate({
    envelope: envelope("review_candidate", "dream-review-accept"),
    input: Object.freeze({
      candidateRef: dreamRecord.candidateRef,
      expectedCandidateStatus: "candidate" as const,
      expectedUserId: BINDING.userId,
      expectedSlot: dreamRecord.slot,
      decision: "accept" as const,
      idempotencyKey: "dream-review-accept",
      authorization: Object.freeze({
        mode: "explicit_user_confirmation" as const,
        evidenceRefs: Object.freeze([EXPLICIT_EVIDENCE_REF]),
        authorityWatermark: WATERMARK,
      }),
      resolvedContent: "hydration reminder",
      issuerReceipt: dreamMemoryReceipt,
    }),
  });
  assert.equal(accepted.value.ok, true, `accept:reviewCalls=${harness.repository.reviewCalls}:${JSON.stringify(accepted.value)}`);
  const afterReview = await harness.lifecycle.recallForAnswerContext({
    envelope: envelope("recall_for_answer_context", "recall-after-dream-review"),
    input: Object.freeze({ maxItems: 8, maxContentBytes: 4_096, asOf: NOW }),
  });
  assert.equal(afterReview.value.memories.some((item) => sameRef(item.ref, dreamMemoryReceipt.memoryRef!)), true);

  for (const decision of ["reject", "quarantine"] as const) {
    const rejectedIntent = candidate({
      kind: "create",
      idempotencyKey: `dream-${decision}`,
      slot: `user.${decision}`,
      value: decision,
      sourceClass: "model_inference",
    });
    const initialReceipt = harness.issuer.issueCandidate({ candidate: rejectedIntent, context: harness.context });
    const receipt = harness.issuer.issueCandidateSuccessor({
      previous: initialReceipt,
      status: decision === "reject" ? "rejected" : "quarantined",
      context: harness.context,
    });
    const record = candidateRecord(rejectedIntent, initialReceipt.candidateRef!);
    harness.repository.candidates.set(canonicalRefKey(record.candidateRef), record);
    const result = await harness.lifecycle.reviewCandidate({
      envelope: envelope("review_candidate", `review-${decision}`),
      input: Object.freeze({
        candidateRef: record.candidateRef,
        expectedCandidateStatus: "candidate" as const,
        expectedUserId: BINDING.userId,
        expectedSlot: record.slot,
        decision,
        idempotencyKey: `review-${decision}`,
        authorization: Object.freeze({
          mode: "explicit_user_confirmation" as const,
          evidenceRefs: Object.freeze([EXPLICIT_EVIDENCE_REF]),
          authorityWatermark: WATERMARK,
        }),
        issuerReceipt: receipt,
      }),
    });
    assert.equal(result.value.ok, true, `${decision}:reviewCalls=${harness.repository.reviewCalls}:${JSON.stringify(result.value)}`);
    if (result.value.ok) assert.deepEqual(result.value.receipt.currentMemoryRefs, []);
  }
});

test("production review rejects missing/raw receipts, wrong terminal status, and wrong predecessor without a memory effect", async () => {
  const harness = createHarness();
  const intent = candidate({
    kind: "create",
    idempotencyKey: "terminal-negative-candidate",
    slot: "user.terminal-negative",
    value: "candidate only",
    sourceClass: "model_inference",
  });
  const original = harness.issuer.issueCandidate({ candidate: intent, context: harness.context });
  const record = candidateRecord(intent, original.candidateRef!);
  harness.repository.candidates.set(canonicalRefKey(record.candidateRef), record);
  const base = Object.freeze({
    candidateRef: record.candidateRef,
    expectedCandidateStatus: "candidate" as const,
    expectedUserId: BINDING.userId,
    expectedSlot: record.slot,
    decision: "reject" as const,
    idempotencyKey: "terminal-wrong-status",
    authorization: Object.freeze({
      mode: "explicit_user_confirmation" as const,
      evidenceRefs: Object.freeze([EXPLICIT_EVIDENCE_REF]),
      authorityWatermark: WATERMARK,
    }),
  });

  assert.throws(
    () => harness.lifecycle.reviewCandidate({
      envelope: envelope("review_candidate", "terminal-raw-receipt"),
      input: Object.freeze({
        ...base,
        idempotencyKey: "terminal-raw-receipt",
        issuerReceipt: Object.freeze({ operation: "candidate_successor" }) as unknown as ProductionMemoryIssuerReceipt,
      }),
    }),
    (error: unknown) => error instanceof ProductionMemoryLifecycleError &&
      error.code === "MEMORY_LIFECYCLE_REVIEW_RECEIPT_INVALID",
  );

  const wrongStatus = harness.issuer.issueCandidateSuccessor({
    previous: original,
    status: "quarantined",
    context: harness.context,
  });
  const statusResult = await harness.lifecycle.reviewCandidate({
    envelope: envelope("review_candidate", "terminal-wrong-status"),
    input: Object.freeze({ ...base, issuerReceipt: wrongStatus }),
  });
  assert.deepEqual(statusResult.value, {
    ok: false,
    error: { code: "OWNER_STATE_INVALID", retryable: false },
  });

  const otherIntent = candidate({
    kind: "create",
    idempotencyKey: "terminal-other-candidate",
    slot: "user.other",
    value: "other",
    sourceClass: "model_inference",
  });
  const otherOriginal = harness.issuer.issueCandidate({ candidate: otherIntent, context: harness.context });
  const wrongPredecessor = harness.issuer.issueCandidateSuccessor({
    previous: otherOriginal,
    status: "rejected",
    context: harness.context,
  });
  const predecessorResult = await harness.lifecycle.reviewCandidate({
    envelope: envelope("review_candidate", "terminal-wrong-predecessor"),
    input: Object.freeze({
      ...base,
      idempotencyKey: "terminal-wrong-predecessor",
      issuerReceipt: wrongPredecessor,
    }),
  });
  assert.deepEqual(predecessorResult.value, {
    ok: false,
    error: { code: "OWNER_STATE_INVALID", retryable: false },
  });
  assert.equal(harness.repository.currentBySlot.has(record.slot), false);
});

function completedDeletion(input: {
  readonly consumed?: readonly CanonicalObjectVersionRef[];
  readonly skipped?: readonly CanonicalObjectVersionRef[];
  readonly sourceRefs?: readonly CanonicalObjectVersionRef[];
} = {}): DeletionRebuildResult {
  const retained = ref("SourceArtifact", 20, "7");
  const deleted = ref("ArtifactVersion", 21, "8");
  const consumed = input.consumed ?? [retained];
  const skipped = input.skipped ?? [deleted];
  const sourceRefs = input.sourceRefs ?? [retained, deleted];
  const target = ref("PreferenceMemory", 22, "9");
  return Object.freeze({
    status: "completed",
    stage: "attestation",
    fingerprint: "a".repeat(64) as Sha256,
    plan: Object.freeze({
      kind: "t05_deletion_work_plan" as const,
      deletionJobRef: DELETION_JOB_REF,
      scopeManifestSha256: "b".repeat(64) as Sha256,
      targetMemoryRefs: Object.freeze([target]),
      authorityWatermark: WATERMARK,
      idempotencyKey: "deletion-001",
      stages: Object.freeze(["suppression", "purge", "enumerate", "manifest", "rebuild", "attestation"]),
      surfaces: Object.freeze(["postgres", "fts", "pgvector", "graph"]),
      projectedMutations: Object.freeze([Object.freeze({
        deletionJobRef: DELETION_JOB_REF,
        targetRef: target,
        targetStatus: "deleted" as const,
        targetCurrent: false,
        deleted: true,
        suppressed: true,
        tombstone: true,
        nonResurrection: true,
        authorityWatermark: WATERMARK,
      })]),
    }),
    rebuildRequest: Object.freeze({
      kind: "memory_rebuild_request" as const,
      requestId: "delete-request-001",
      idempotencyKey: "deletion-001",
      requestedAt: NOW,
      authorityWatermark: WATERMARK,
      sourceArtifactRefs: Object.freeze(sourceRefs),
      projections: Object.freeze([]),
      requestSha256: "c".repeat(64) as Sha256,
    }),
    rebuildResult: Object.freeze({
      kind: "memory_rebuild_result" as const,
      requestId: "delete-request-001",
      completedAt: NOW,
      authorityWatermark: WATERMARK,
      consumedSourceRefs: Object.freeze(consumed),
      skippedDeletedSourceRefs: Object.freeze(skipped),
      appliedDeletionJobRefs: Object.freeze(skipped.length === 0 ? [] : [DELETION_JOB_REF]),
      projections: Object.freeze([]),
      resultSha256: "d".repeat(64) as Sha256,
    }),
    attestationIntent: Object.freeze({
      kind: "domain_deletion_attestation_intent" as const,
      ownerModule: "T05" as const,
      deletionJobRef: DELETION_JOB_REF,
      scopeManifestSha256: "b".repeat(64) as Sha256,
      targetMemoryRefs: Object.freeze([target]),
      completedStages: Object.freeze(["suppression", "purge", "enumerate", "manifest", "rebuild", "attestation"]),
      surfaceResults: Object.freeze([]),
      completedAt: NOW,
      authorityWatermark: WATERMARK,
    }),
  } as unknown as DeletionRebuildResult);
}

test("deletion reaches only the injected Cold-CAS lifecycle port after tombstone and complete non-resurrection partition", async () => {
  const harness = createHarness();
  harness.deletionQueue.push(completedDeletion());
  const request: DeletionRebuildRequest = Object.freeze({
    requestId: "delete-request-001",
    deletionJobRef: DELETION_JOB_REF,
    expectedScopeManifestSha256: "b".repeat(64) as Sha256,
    idempotencyKey: "deletion-001",
    requestedAt: NOW,
    projections: Object.freeze([]),
  });
  const execution = await harness.lifecycle.deleteAndRebuild({
    envelope: envelope("delete_and_rebuild", "deletion-001"),
    input: request,
  });
  assert.equal(execution.value.deletion.status, "completed");
  assert.equal(execution.value.coldCas?.outcome, "applied");
  assert.equal(harness.counts.coldCas(), 1);

  const retained = ref("SourceArtifact", 20, "7");
  const deleted = ref("ArtifactVersion", 21, "8");
  harness.deletionQueue.push(completedDeletion({ consumed: [retained, deleted], skipped: [deleted], sourceRefs: [retained, deleted] }));
  await assert.rejects(
    () => harness.lifecycle.deleteAndRebuild({
      envelope: envelope("delete_and_rebuild", "deletion-invalid-partition"),
      input: Object.freeze({ ...request, idempotencyKey: "deletion-invalid-partition" }),
    }),
    (error: unknown) => error instanceof ProductionMemoryLifecycleError &&
      error.code === "MEMORY_LIFECYCLE_REBUILD_PARTITION_INVALID",
  );
  assert.equal(harness.counts.coldCas(), 1);
});

test("binding, purpose, governance and idempotency drift fail before downstream effects; failed calls roll back the local replay fence", async () => {
  const harness = createHarness();
  const oldRef = harness.initialMemoryReceipt.memoryRef!;
  const replacement = candidate({
    kind: "correct",
    idempotencyKey: "rollback-correction",
    slot: "user.display-density",
    value: "expanded",
    target: oldRef,
  });
  const candidateReceipt = harness.issuer.issueCandidate({ candidate: replacement, context: harness.context });
  const successorReceipt = harness.issuer.issueMemorySuccessor({
    candidate: replacement,
    candidateReceipt,
    previous: harness.initialMemoryReceipt,
    context: harness.context,
    resolvedContent: "expanded",
  });
  const correctionCall = {
    envelope: envelope("correct_memory", "rollback-correction"),
    input: Object.freeze({
      idempotencyKey: "rollback-correction",
      expectedCurrentRef: oldRef,
      candidate: replacement,
      issuerReceipt: successorReceipt,
    }),
  };
  harness.repository.failNextCorrection = true;
  const failed = await harness.lifecycle.correctMemory(correctionCall);
  assert.equal(failed.value.ok, false);
  assert.equal(harness.repository.currentBySlot.get(replacement.slot)?.ref.refId, oldRef.refId);
  const retried = await harness.lifecycle.correctMemory(correctionCall);
  assert.equal(retried.value.ok, true);
  assert.equal(harness.repository.applicationCorrectionCalls, 2);

  const wrongBinding = Object.freeze({ ...BINDING, purpose: "unrelated" });
  const callsBefore = harness.counts.authority();
  await assert.rejects(
    () => harness.lifecycle.recallForAnswerContext({
      envelope: envelope("recall_for_answer_context", "wrong-purpose", { binding: wrongBinding }),
      input: Object.freeze({ maxItems: 1, maxContentBytes: 1_024, asOf: NOW }),
    }),
    (error: unknown) => error instanceof ProductionMemoryLifecycleError && error.code === "MEMORY_LIFECYCLE_BINDING_DRIFT",
  );
  assert.equal(harness.counts.authority(), callsBefore);

  const wrongGovernance = ref("PolicyDecision", 99, "f");
  await assert.rejects(
    () => harness.lifecycle.recallForAnswerContext({
      envelope: envelope("recall_for_answer_context", "wrong-governance", { governanceRef: wrongGovernance }),
      input: Object.freeze({ maxItems: 1, maxContentBytes: 1_024, asOf: NOW }),
    }),
    (error: unknown) => error instanceof ProductionMemoryLifecycleError && error.code === "MEMORY_LIFECYCLE_BINDING_DRIFT",
  );
  assert.equal(harness.counts.authority(), callsBefore);
});

test("close is idempotent, fences late calls, and production source has no PG/network/fs-delete/scheduler/CAS implementation", async () => {
  const harness = createHarness();
  await harness.lifecycle.close();
  await harness.lifecycle.close();
  assert.equal(harness.counts.memoryClose(), 1);
  assert.equal(harness.counts.coldCasClose(), 1);
  assert.throws(
    () => harness.lifecycle.recallForAnswerContext({
      envelope: envelope("recall_for_answer_context", "after-close"),
      input: Object.freeze({ maxItems: 1, maxContentBytes: 1_024, asOf: NOW }),
    }),
    (error: unknown) => error instanceof ProductionMemoryLifecycleError && error.code === "MEMORY_LIFECYCLE_CLOSED",
  );

  const source = await readFile(new URL(
    "../../services/memory-os/src/production-memory-lifecycle.ts",
    import.meta.url,
  ), "utf8");
  for (const forbidden of [
    /from\s+["']pg["']/u,
    /node:(?:net|http|https|child_process)/u,
    /from\s+["']node:fs/u,
    /\b(?:unlink|rm|rmdir)\s*\(/u,
    /\bset(?:Interval|Timeout)\s*\(/u,
    /\b(?:ColdCasStore|createProductionColdCas)\b/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
