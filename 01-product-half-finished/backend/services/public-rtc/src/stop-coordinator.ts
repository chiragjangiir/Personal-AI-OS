/**
 * Internal, non-canonical, non-wire Stop orchestration seam.
 *
 * T11B owns the authoritative DeviceLease transition and T01 owns any public
 * request/result bytes. Generic parameters deliberately keep those objects
 * opaque here.
 */

export type MediaCleanupStage =
  | 'tracks_unpublished'
  | 'participant_disconnected'
  | 'credential_revoked'
  | 'closure_verified';

export type MediaStopReason =
  | 'user_stop'
  | 'lease_expired'
  | 'permission_revoked'
  | 'application_exit'
  | 'error'
  | 'disconnect'
  | 'provider_failure'
  | 'cancelled';

export interface MediaStopEpochCodec<TEpoch> {
  validate(value: unknown): TEpoch;
}

const legacyNumericEpochCodec: MediaStopEpochCodec<number> = Object.freeze({
  validate(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error('INVALID_INTERNAL_CONNECTION_EPOCH');
    }
    return value as number;
  },
});

export interface InternalMediaStopRequest<
  TSessionRef,
  TLeaseRef,
  TEpoch = number,
  TReason extends string = MediaStopReason,
> {
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly realtimeSessionRef: TSessionRef;
  readonly deviceLeaseRef: TLeaseRef;
  readonly connectionEpoch: TEpoch;
  readonly reason: TReason;
}

export interface InternalMediaStopClaim<TOperationOutcome, TResultRef, TTerminalResult = unknown> {
  readonly claimId: string;
  readonly alreadyCompleted?: {
    readonly operationOutcome: TOperationOutcome;
    readonly recordedResultReference?: TResultRef;
    readonly terminalResult?: TTerminalResult;
    readonly cleanup?: MediaClosureFacts;
  };
}

export interface MediaClosureFacts {
  readonly completedStages: readonly MediaCleanupStage[];
  readonly failedStages: readonly {
    readonly stage: MediaCleanupStage;
    readonly code: string;
  }[];
}

export interface InternalMediaStopResult<TOperationOutcome, TResultRef, TTerminalResult = unknown> {
  readonly operationOutcome: TOperationOutcome;
  readonly recordedResultReference?: TResultRef;
  readonly terminalResult?: TTerminalResult;
  readonly cleanup: MediaClosureFacts;
}

export interface MediaStopPorts<
  TSessionRef,
  TLeaseRef,
  TOperationOutcome,
  TResultRef,
  TTerminalResult = unknown,
  TEpoch = number,
  TReason extends string = MediaStopReason,
> {
  /** T11B-owned durable idempotency/fence claim. */
  claimMediaStop(
    request: InternalMediaStopRequest<TSessionRef, TLeaseRef, TEpoch, TReason>,
  ): Promise<InternalMediaStopClaim<TOperationOutcome, TResultRef, TTerminalResult>>;
  unpublishAllTracks(claimId: string): Promise<void>;
  disconnectParticipant(claimId: string): Promise<void>;
  revokeCredential?(claimId: string): Promise<void>;
  verifyMediaClosed?(claimId: string): Promise<void>;
  /**
   * T11B/T01-owned projection which atomically releases the lease and returns
   * an opaque OperationOutcome plus optional RecordedResultReference.
   */
  completeMediaStop(
    claimId: string,
    facts: MediaClosureFacts,
  ): Promise<{
    readonly operationOutcome: TOperationOutcome;
    readonly recordedResultReference?: TResultRef;
    readonly terminalResult?: TTerminalResult;
  }>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function assertRequest<TSessionRef, TLeaseRef, TEpoch, TReason extends string>(
  request: InternalMediaStopRequest<TSessionRef, TLeaseRef, TEpoch, TReason>,
  epochCodec: MediaStopEpochCodec<TEpoch>,
): void {
  if (!IDENTIFIER.test(request.idempotencyKey) || !IDENTIFIER.test(request.requestId)) {
    throw new Error('INVALID_INTERNAL_STOP_IDENTIFIER');
  }
  epochCodec.validate(request.connectionEpoch);
  if (request.realtimeSessionRef === undefined || request.deviceLeaseRef === undefined) {
    throw new Error('MISSING_INTERNAL_OWNER_REF');
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message)) {
    return error.message;
  }
  return 'MEDIA_CLEANUP_FAILED';
}

/**
 * Coordinates safe media cleanup while leaving durable ownership to injected
 * ports. The local map only coalesces concurrent duplicates in this process.
 */
export interface StopCoordinatorOptions<TEpoch = number> {
  readonly epochCodec?: MediaStopEpochCodec<TEpoch>;
  /** E3 owner mode: a replay must carry the complete prior terminal payload and facts. */
  readonly requireCompleteReplay?: boolean;
}

export class StopCoordinator<
  TSessionRef,
  TLeaseRef,
  TOperationOutcome,
  TResultRef,
  TTerminalResult = unknown,
  TEpoch = number,
  TReason extends string = MediaStopReason,
> {
  readonly #ports: MediaStopPorts<
    TSessionRef,
    TLeaseRef,
    TOperationOutcome,
    TResultRef,
    TTerminalResult,
    TEpoch,
    TReason
  >;
  readonly #epochCodec: MediaStopEpochCodec<TEpoch>;
  readonly #requireCompleteReplay: boolean;
  readonly #inFlight = new Map<
    string,
    Promise<InternalMediaStopResult<TOperationOutcome, TResultRef, TTerminalResult>>
  >();

  constructor(
    ports: MediaStopPorts<
      TSessionRef,
      TLeaseRef,
      TOperationOutcome,
      TResultRef,
      TTerminalResult,
      TEpoch,
      TReason
    >,
    options: StopCoordinatorOptions<TEpoch> = {},
  ) {
    this.#ports = ports;
    this.#epochCodec = options.epochCodec
      ?? (legacyNumericEpochCodec as unknown as MediaStopEpochCodec<TEpoch>);
    this.#requireCompleteReplay = options.requireCompleteReplay ?? false;
  }

  get requiresCompleteReplay(): boolean {
    return this.#requireCompleteReplay;
  }

  stop(
    request: InternalMediaStopRequest<TSessionRef, TLeaseRef, TEpoch, TReason>,
  ): Promise<InternalMediaStopResult<TOperationOutcome, TResultRef, TTerminalResult>> {
    assertRequest(request, this.#epochCodec);
    const localKey = `${request.requestId}\u0000${request.idempotencyKey}`;
    const existing = this.#inFlight.get(localKey);
    if (existing !== undefined) return existing;

    const operation = this.#stopOnce(request).finally(() => {
      if (this.#inFlight.get(localKey) === operation) this.#inFlight.delete(localKey);
    });
    this.#inFlight.set(localKey, operation);
    return operation;
  }

  async #stopOnce(
    request: InternalMediaStopRequest<TSessionRef, TLeaseRef, TEpoch, TReason>,
  ): Promise<InternalMediaStopResult<TOperationOutcome, TResultRef, TTerminalResult>> {
    const claim = await this.#ports.claimMediaStop(request);
    if (claim.alreadyCompleted !== undefined) {
      if (this.#requireCompleteReplay
        && (claim.alreadyCompleted.terminalResult === undefined
          || claim.alreadyCompleted.cleanup === undefined)) {
        throw new Error('INCOMPLETE_STOP_REPLAY');
      }
      return {
        ...claim.alreadyCompleted,
        cleanup: claim.alreadyCompleted.cleanup ?? { completedStages: [], failedStages: [] },
      };
    }

    const operations: readonly {
      readonly stage: MediaCleanupStage;
      readonly run: (() => Promise<void>) | undefined;
    }[] = [
      { stage: 'tracks_unpublished', run: () => this.#ports.unpublishAllTracks(claim.claimId) },
      { stage: 'participant_disconnected', run: () => this.#ports.disconnectParticipant(claim.claimId) },
      {
        stage: 'credential_revoked',
        run: this.#ports.revokeCredential === undefined
          ? undefined
          : () => this.#ports.revokeCredential!(claim.claimId),
      },
      {
        stage: 'closure_verified',
        run: this.#ports.verifyMediaClosed === undefined
          ? undefined
          : () => this.#ports.verifyMediaClosed!(claim.claimId),
      },
    ];

    const completedStages: MediaCleanupStage[] = [];
    const failedStages: { stage: MediaCleanupStage; code: string }[] = [];
    for (const operation of operations) {
      if (operation.run === undefined) continue;
      try {
        await operation.run();
        completedStages.push(operation.stage);
      } catch (error) {
        failedStages.push({ stage: operation.stage, code: errorCode(error) });
      }
    }
    const cleanup: MediaClosureFacts = { completedStages, failedStages };
    const completed = await this.#ports.completeMediaStop(claim.claimId, cleanup);
    if (this.#requireCompleteReplay && completed.terminalResult === undefined) {
      throw new Error('INCOMPLETE_STOP_RESULT');
    }
    return { ...completed, cleanup };
  }
}
