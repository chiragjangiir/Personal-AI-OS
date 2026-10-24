import type { Pool } from "pg";

import type { AdmittedMemoryCandidateIntent } from "../../memory-os/src/admission.ts";
import {
  canonicalRefKey,
  type CanonicalObjectVersionRef,
  type Sha256,
} from "../../memory-os/src/canonical-ref.ts";
import {
  assertProductionMemoryIssuerReceipt,
  issuerReceiptMatchesCandidate,
  projectProductionMemoryIssuerReceipt,
  rehydrateProductionMemoryIssuerReceipt,
  type ProductionMemoryIssuerReceipt,
} from "../../memory-os/src/canonical-issuer.ts";
import {
  adaptCompiledMemoryContext,
  type MemoryConsumerContext,
} from "../../memory-os/src/context-consumer-adapter.ts";
import type { CompilerQuery } from "../../memory-os/src/domain.ts";
import {
  createProductionExplicitUserRememberService,
  type ExplicitUserRememberCommand,
  type ExplicitUserRememberResult,
} from "../../memory-os/src/explicit-user-remember-service.ts";
import { createProductionMemoryApplicationService } from "../../memory-os/src/memory-application-service.ts";
import { createMemoryAuthorityRepository } from "./memory-authority-repository.ts";
import type { MemoryCanonicalReceiptCodec } from "./memory-persistence-primitives.ts";
import {
  closePostgresPool,
  createPostgresPool,
  type PostgresPoolOptions,
} from "./postgres-pool.ts";

const T05_CANONICAL_CODEC: MemoryCanonicalReceiptCodec = Object.freeze({
  assertReceipt: assertProductionMemoryIssuerReceipt,
  projectReceipt: projectProductionMemoryIssuerReceipt,
  rehydrateReceipt: rehydrateProductionMemoryIssuerReceipt,
});

export class MemoryRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MemoryRuntimeError";
    this.code = code;
  }
}

export interface ProductionMemoryRuntimeOptions {
  readonly postgres: Required<Pick<PostgresPoolOptions, "host" | "port" | "database" | "user" | "password">> &
    Pick<PostgresPoolOptions, "max" | "idleTimeoutMillis" | "connectionTimeoutMillis" | "applicationName">;
  readonly userId: string;
  readonly purposeScope: string;
}

export interface RememberCanonicalMemoryInput {
  readonly candidate: AdmittedMemoryCandidateIntent;
  readonly candidateReceipt: ProductionMemoryIssuerReceipt;
  readonly memoryReceipt: ProductionMemoryIssuerReceipt;
  readonly candidateAppendIdempotencyKey: string;
  readonly candidateAppendFingerprint: Sha256;
  readonly memoryAppendIdempotencyKey: string;
  readonly memoryAppendFingerprint: Sha256;
}

export interface RememberCanonicalMemoryResult {
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly memoryRef: CanonicalObjectVersionRef;
  readonly authorityWatermark: unknown;
}

export type RecallMemoryContextInput = Omit<CompilerQuery, "userId" | "purposeScope">;

export interface ProductionMemoryRuntime {
  readonly userId: string;
  readonly purposeScope: string;
  remember(input: RememberCanonicalMemoryInput): Promise<RememberCanonicalMemoryResult>;
  rememberExplicit(input: ExplicitUserRememberCommand): Promise<ExplicitUserRememberResult>;
  recallForAnswerContext(input: RecallMemoryContextInput): Promise<MemoryConsumerContext>;
  close(): Promise<void>;
}

function fail(code: string): never {
  throw new MemoryRuntimeError(code);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\u0000");
}

function positivePort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function assertRuntimeOptions(input: ProductionMemoryRuntimeOptions): void {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      !nonEmpty(input.userId) || !nonEmpty(input.purposeScope) ||
      typeof input.postgres !== "object" || input.postgres === null || Array.isArray(input.postgres) ||
      !nonEmpty(input.postgres.host) || !positivePort(input.postgres.port) ||
      !nonEmpty(input.postgres.database) || !nonEmpty(input.postgres.user) ||
      !nonEmpty(input.postgres.password)) {
    fail("MEMORY_RUNTIME_CONFIG_INVALID");
  }
}

function assertRememberBinding(
  input: RememberCanonicalMemoryInput,
  userId: string,
  purposeScope: string,
): {
  readonly candidateReceipt: ProductionMemoryIssuerReceipt;
  readonly memoryReceipt: ProductionMemoryIssuerReceipt;
  readonly candidateRef: CanonicalObjectVersionRef;
  readonly memoryRef: CanonicalObjectVersionRef;
} {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input) ||
        typeof input.candidate !== "object" || input.candidate === null || Array.isArray(input.candidate) ||
        input.candidate.userId !== userId || !input.candidate.purposeScopes.includes(purposeScope) ||
        !nonEmpty(input.candidateAppendIdempotencyKey) || !nonEmpty(input.memoryAppendIdempotencyKey)) {
      fail("MEMORY_RUNTIME_BINDING_INVALID");
    }
    const candidateReceipt = assertProductionMemoryIssuerReceipt(input.candidateReceipt);
    const memoryReceipt = assertProductionMemoryIssuerReceipt(input.memoryReceipt);
    const acceptedCandidateReceipt = memoryReceipt.candidateReceipt;
    if (candidateReceipt.operation !== "candidate_create" || candidateReceipt.candidateRef === undefined ||
        memoryReceipt.operation !== "memory_create" || memoryReceipt.memoryRef === undefined ||
        acceptedCandidateReceipt === undefined || acceptedCandidateReceipt.operation !== "candidate_successor" ||
        acceptedCandidateReceipt.previousRef === undefined || acceptedCandidateReceipt.payload.status !== "accepted" ||
        canonicalRefKey(acceptedCandidateReceipt.previousRef) !== canonicalRefKey(candidateReceipt.candidateRef) ||
        !issuerReceiptMatchesCandidate(candidateReceipt, input.candidate) ||
        !issuerReceiptMatchesCandidate(memoryReceipt, input.candidate)) {
      fail("MEMORY_RUNTIME_RECEIPT_INVALID");
    }
    return Object.freeze({
      candidateReceipt,
      memoryReceipt,
      candidateRef: candidateReceipt.candidateRef,
      memoryRef: memoryReceipt.memoryRef,
    });
  } catch (error) {
    if (error instanceof MemoryRuntimeError) throw error;
    fail("MEMORY_RUNTIME_RECEIPT_INVALID");
  }
}

function createRuntime(
  pool: Pool,
  userId: string,
  purposeScope: string,
): ProductionMemoryRuntime {
  const repository = createMemoryAuthorityRepository(pool, {
    canonicalCodec: T05_CANONICAL_CODEC,
    environment: "production",
  });
  const application = createProductionMemoryApplicationService(repository, repository);
  let closed = false;

  function assertOpen(): void {
    if (closed) fail("MEMORY_RUNTIME_CLOSED");
  }

  async function rememberCanonical(
    input: RememberCanonicalMemoryInput,
  ): Promise<RememberCanonicalMemoryResult> {
    assertOpen();
    const bound = assertRememberBinding(input, userId, purposeScope);
    const candidateAppend = await repository.appendCanonical({
      idempotencyKey: input.candidateAppendIdempotencyKey,
      fingerprint: input.candidateAppendFingerprint,
      receipt: bound.candidateReceipt,
    });
    if (!candidateAppend.ok) fail(`MEMORY_RUNTIME_CANDIDATE_APPEND_${candidateAppend.error.code}`);
    const memoryAppend = await repository.appendCanonical({
      idempotencyKey: input.memoryAppendIdempotencyKey,
      fingerprint: input.memoryAppendFingerprint,
      receipt: bound.memoryReceipt,
    });
    if (!memoryAppend.ok) fail(`MEMORY_RUNTIME_MEMORY_APPEND_${memoryAppend.error.code}`);
    if (canonicalRefKey(memoryAppend.value.appendedRef) !== canonicalRefKey(bound.memoryRef)) {
      fail("MEMORY_RUNTIME_APPEND_REF_MISMATCH");
    }
    return Object.freeze({
      candidateRef: bound.candidateRef,
      memoryRef: bound.memoryRef,
      authorityWatermark: memoryAppend.value.authorityWatermark,
    });
  }

  const explicitRemember = createProductionExplicitUserRememberService({
    persistence: Object.freeze({ remember: rememberCanonical }),
  });

  return Object.freeze({
    userId,
    purposeScope,
    remember: rememberCanonical,
    rememberExplicit(input: ExplicitUserRememberCommand) {
      assertOpen();
      return explicitRemember.remember(input);
    },
    async recallForAnswerContext(input: RecallMemoryContextInput) {
      assertOpen();
      if (typeof input !== "object" || input === null || Array.isArray(input) ||
          Object.prototype.hasOwnProperty.call(input, "userId") ||
          Object.prototype.hasOwnProperty.call(input, "purposeScope")) {
        fail("MEMORY_RUNTIME_QUERY_SCOPE_INVALID");
      }
      const compiled = await application.queryContext({
        ...input,
        userId,
        purposeScope,
      });
      return adaptCompiledMemoryContext(compiled);
    },
    async close() {
      if (closed) return;
      closed = true;
      await closePostgresPool(pool);
    },
  });
}

/**
 * Production composition only: T05 supplies admitted intent and exact private
 * receipts; T02 persists them and exposes the authoritative compiler snapshot.
 */
export function createProductionMemoryRuntime(
  input: ProductionMemoryRuntimeOptions,
): ProductionMemoryRuntime {
  assertRuntimeOptions(input);
  const pool = createPostgresPool(input.postgres);
  return createRuntime(pool, input.userId, input.purposeScope);
}
