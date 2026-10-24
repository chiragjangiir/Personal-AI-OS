import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createRealtimePublicControlHandoffTerminalCodec,
  createRealtimePublicControlTerminalCodec,
  type RealtimePublicControlTerminalCodec,
} from '../src/realtime-public-control-terminal-codec.ts';
import { createRealtimeSchemaRegistry } from '../src/realtime-public-control-controller.ts';
import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
  snapshotOpaqueOwnerValue,
  type HandoffRequest,
  type StopRequest,
  type TerminalReceipt,
} from '../../../services/realtime-core/src/types.ts';

type JsonRecord = Record<string, unknown>;

const registry = createRealtimeSchemaRegistry();
const mediaWire = JSON.parse(readFileSync(new URL('../../../tests/contracts/fixtures/realtime-public-control/media-stop.valid.json', import.meta.url), 'utf8')) as JsonRecord;
const handoffFixture = JSON.parse(readFileSync(new URL('../../../tests/contracts/fixtures/realtime-public-control/handoff.valid.json', import.meta.url), 'utf8')) as JsonRecord;
const handoffWire = handoffFixture.request as JsonRecord;
const handoffTerminal = handoffFixture.terminal_result as JsonRecord;
const OCCURRED = assertCanonicalTimestamp('2026-08-23T01:00:00.000Z');
const DEVICE_ID = '018f0000-0000-7000-8000-000000000002';
const TERMINAL_DEVICE_ID = '018f0000-0000-7000-8000-000000000012';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stopRequest(wire = mediaWire, operation: 'media_stop' | 'end_continuity' = 'media_stop'): StopRequest {
  return Object.freeze({
    requestId: String(wire.request_id),
    idempotencyKey: String((wire.idempotency_context as JsonRecord).idempotency_key),
    operation,
    realtimeSessionRef: snapshotOpaqueOwnerValue(wire.realtime_session_ref),
    continuityId: String(wire.continuity_id),
    ...(wire.device_lease_ref === undefined ? {} : { deviceLeaseRef: snapshotOpaqueOwnerValue(wire.device_lease_ref) }),
    deviceId: DEVICE_ID,
    expectedConnectionEpoch: assertDecimalConnectionEpoch(wire.connection_epoch),
    expectedLeaseVersion: assertDecimalCounter('1'),
    reason: operation === 'media_stop' ? 'user_stop' : 'user_stop',
    occurredAt: OCCURRED,
    governance: snapshotOpaqueOwnerValue(wire.governance),
  });
}

function stopReceipt(wire: JsonRecord, request: StopRequest, operation: 'media_stop' | 'end_continuity' = request.operation): TerminalReceipt {
  const context = clone(wire.idempotency_context);
  const operationOutcome = {
    outcome_class: 'committed_success',
    recorded_result_ref: {
      idempotency_context: context,
      fencing_epoch: '2',
      outcome_class: 'committed_success',
      result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json',
      result_schema_version: '1.0.0',
      result_schema_sha256: 'c'.repeat(64),
      result_payload_sha256: 'd'.repeat(64),
    },
    resolution_mode: 'direct',
  };
  return {
    kind: 'realtime_terminal_receipt',
    operation,
    status: 'success',
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    realtimeSessionRef: request.realtimeSessionRef,
    ...(request.deviceLeaseRef === undefined ? {} : { deviceLeaseRef: request.deviceLeaseRef }),
    continuityId: request.continuityId,
    connectionEpoch: request.expectedConnectionEpoch,
    outcome: 'owner_recorded_success',
    recordedAt: OCCURRED,
    replayed: false,
    operationOutcome,
    ...(wire.governance === undefined ? {} : { governance: wire.governance }),
  } as TerminalReceipt;
}

function handoffRequest(): HandoffRequest {
  return Object.freeze({
    requestId: String(handoffWire.request_id),
    idempotencyKey: String((handoffWire.idempotency_context as JsonRecord).idempotency_key),
    realtimeSessionRef: snapshotOpaqueOwnerValue(handoffWire.realtime_session_ref),
    continuityId: String(handoffWire.continuity_id),
    fromDeviceId: String(handoffWire.from_device_id),
    toDeviceId: String(handoffWire.to_device_id),
    expectedConnectionEpoch: assertDecimalConnectionEpoch(handoffWire.connection_epoch),
    expectedLeaseVersion: assertDecimalCounter(handoffWire.expected_lease_version),
    occurredAt: OCCURRED,
    governance: snapshotOpaqueOwnerValue(handoffWire.governance),
  });
}

function handoffOwner(): JsonRecord {
  return {
    userId: '018f0000-0000-7000-8000-000000000001',
    deviceId: DEVICE_ID,
    purpose: 'realtime_assistant',
    capabilities: ['audio', 'video'],
    occurredAt: OCCURRED,
  };
}

function suppression(): JsonRecord {
  return {
    state: 'old_device_suppressed',
    closure_status: 'verified_closed',
    evidence_refs: clone((handoffTerminal.execution_facts as JsonRecord).evidence_refs),
    old_device_suppression_fence: clone(handoffTerminal.old_device_suppression_fence),
  };
}

function assertTerminal(value: unknown): asserts value is JsonRecord {
  assert.equal(registry.validateTerminal(value), true, JSON.stringify(value));
}

test('production terminal codec emits schema-valid media_stop and end_continuity records', async () => {
  const codec: RealtimePublicControlTerminalCodec = createRealtimePublicControlTerminalCodec();
  const mediaRequest = stopRequest();
  const facts = {
    closure_status: 'verified_closed',
    device_lease_release: 'released',
    participant_cleanup: 'verified_absent',
    track_cleanup: 'verified_absent',
    room_cleanup: 'verified_absent',
  };
  const media = await codec.encode({
    operation: 'media_stop', wireRequest: mediaWire, request: mediaRequest,
    governance: mediaWire.governance as JsonRecord,
    receipt: stopReceipt(mediaWire, mediaRequest), executionFacts: facts,
  });
  assertTerminal(media);
  assert.equal(media.operation, 'media_stop');
  assert.deepEqual(media.execution_facts, facts);
  assert.equal(Object.isFrozen(media), true);
  assert.equal(Object.isFrozen(media.operation_outcome), true);
  assert.equal(Object.isFrozen(media.execution_facts), true);

  const endWire: JsonRecord = {
    operation: 'end_continuity', request_id: mediaWire.request_id,
    idempotency_context: mediaWire.idempotency_context,
    realtime_session_ref: mediaWire.realtime_session_ref,
    continuity_id: mediaWire.continuity_id,
    connection_epoch: mediaWire.connection_epoch,
    confirmation: 'explicit_user_end_continuity', governance: mediaWire.governance,
  };
  const endRequest = stopRequest(endWire, 'end_continuity');
  const end = await codec.encode({
    operation: 'end_continuity', wireRequest: endWire, request: endRequest,
    governance: endWire.governance as JsonRecord,
    receipt: stopReceipt(endWire, endRequest, 'end_continuity'),
  });
  assertTerminal(end);
  assert.equal(end.operation, 'end_continuity');
  assert.deepEqual(end.execution_facts, { closure_status: 'not_applicable' });
});

test('production handoff codec maps the injected canonical authority and suppression facts exactly', async () => {
  const codec = createRealtimePublicControlHandoffTerminalCodec();
  const request = handoffRequest();
  const output = await codec.encode({
    wireRequest: handoffWire,
    request,
    owner: handoffOwner() as never,
    governance: handoffWire.governance as JsonRecord,
    authorityResult: handoffTerminal,
    suppressionResult: suppression(),
  });
  assertTerminal(output);
  assert.deepEqual(output, handoffTerminal);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.old_device_suppression_fence), true);
  assert.equal(Object.isFrozen(output.execution_facts), true);
  assert.equal(Object.isFrozen((output.execution_facts as JsonRecord).evidence_refs), true);
});

test('unmounted handoff codec requires caller-provided canonical outcome and execution facts', async () => {
  const codec = createRealtimePublicControlHandoffTerminalCodec();
  const request = handoffRequest();
  const receipt = {
    kind: 'realtime_terminal_receipt', operation: 'handoff', status: 'success',
    requestId: request.requestId, idempotencyKey: request.idempotencyKey,
    realtimeSessionRef: request.realtimeSessionRef,
    deviceLeaseRef: handoffTerminal.device_lease_ref,
    continuityId: request.continuityId, connectionEpoch: request.expectedConnectionEpoch,
    leaseVersion: '2', outcome: 'handoff_completed', recordedAt: OCCURRED, replayed: false,
    operationOutcome: clone(handoffTerminal.operation_outcome),
  };
  const authority = {
    state: 'completed', requestId: request.requestId, idempotencyKey: request.idempotencyKey,
    realtimeSessionRef: request.realtimeSessionRef, continuityId: request.continuityId,
    activeDeviceId: request.toDeviceId, activeDeviceLeaseRef: handoffTerminal.device_lease_ref,
    connectionEpoch: request.expectedConnectionEpoch, leaseVersion: '2', fencingToken: '2',
    operationOutcome: clone(handoffTerminal.operation_outcome),
    executionFacts: clone(handoffTerminal.execution_facts), receipt,
  };
  const output = await codec.encode({
    wireRequest: handoffWire, request, owner: handoffOwner() as never,
    governance: handoffWire.governance as JsonRecord,
    authorityResult: authority, suppressionResult: suppression(),
  });
  assertTerminal(output);
  assert.equal(output.status, 'success');
  assert.deepEqual(output.device_lease_ref, handoffTerminal.device_lease_ref);
  assert.deepEqual(output.old_device_suppression_fence, handoffTerminal.old_device_suppression_fence);
});

test('codec rejects wrong operation, refs, facts, governance, extra keys, accessors, and cycles', async () => {
  const terminalCodec = createRealtimePublicControlTerminalCodec();
  const request = stopRequest();
  const base = {
    operation: 'media_stop' as const, wireRequest: mediaWire, request,
    governance: mediaWire.governance as JsonRecord, receipt: stopReceipt(mediaWire, request),
    executionFacts: {
      closure_status: 'verified_closed', device_lease_release: 'released',
      participant_cleanup: 'verified_absent', track_cleanup: 'verified_absent', room_cleanup: 'verified_absent',
    },
  };
  await assert.rejects(terminalCodec.encode({ ...base, operation: 'end_continuity' } as never), /OPERATION_INVALID|WIRE_REQUEST_INVALID/);
  await assert.rejects(terminalCodec.encode({ ...base, wireRequest: { ...mediaWire, realtime_session_ref: { ...(mediaWire.realtime_session_ref as JsonRecord), ref_id: '018f0000-0000-7000-8000-000000000099' } } } as never), /REQUEST_BINDING|RECEIPT_BINDING/);
  await assert.rejects(terminalCodec.encode({ ...base, executionFacts: { ...base.executionFacts, closure_status: 'indeterminate' } } as never), /FALSE_SUCCESS/);
  await assert.rejects(terminalCodec.encode({ ...base, governance: { ...(mediaWire.governance as JsonRecord), purpose_scopes: ['other_scope'] } } as never), /GOVERNANCE_BINDING/);
  const receiptWithExtra: JsonRecord = { ...base.receipt, unknown_extra: true };
  await assert.rejects(terminalCodec.encode({ ...base, receipt: receiptWithExtra } as never), /RECEIPT_INVALID/);
  const accessor = { ...mediaWire } as JsonRecord;
  Object.defineProperty(accessor, 'request_id', { enumerable: true, get: () => mediaWire.request_id });
  await assert.rejects(terminalCodec.encode({ ...base, wireRequest: accessor } as never), /WIRE_REQUEST_INVALID|INPUT_INVALID/);
  const cycle = { ...mediaWire } as JsonRecord;
  cycle.cycle = cycle;
  await assert.rejects(terminalCodec.encode({ ...base, wireRequest: cycle } as never), /VALUE_CYCLE|INPUT_INVALID/);
  const missingOutcome: JsonRecord = { ...base.receipt };
  delete missingOutcome.operationOutcome;
  await assert.rejects(terminalCodec.encode({ ...base, receipt: missingOutcome } as never), /CANONICAL_OUTCOME_REQUIRED/);
});

test('handoff codec rejects authority/fence mismatch, unknown extras, indeterminate promotion, and secret leakage', async () => {
  const codec = createRealtimePublicControlHandoffTerminalCodec();
  const request = handoffRequest();
  const base = {
    wireRequest: handoffWire, request, owner: handoffOwner() as never,
    governance: handoffWire.governance as JsonRecord,
    authorityResult: handoffTerminal, suppressionResult: suppression(),
  };
  await assert.rejects(codec.encode({ ...base, authorityResult: { ...handoffTerminal, to_device_id: DEVICE_ID } } as never), /TERMINAL_BINDING/);
  const badFence = suppression();
  badFence.old_device_suppression_fence = { ...(badFence.old_device_suppression_fence as JsonRecord), fencing_token: '3' };
  await assert.rejects(codec.encode({ ...base, suppressionResult: badFence } as never), /FENCE_INVALID/);
  await assert.rejects(codec.encode({ ...base, authorityResult: { ...handoffTerminal, extra: true } } as never), /AUTHORITY_INVALID/);
  const indeterminate = clone(handoffTerminal);
  indeterminate.status = 'indeterminate';
  indeterminate.operation_outcome = {
    outcome_class: 'indeterminate',
    error: {
      error_family: 'provider', error_code: 'provider.handoff_unknown', retry_class: 'never',
      trace_id: '018f0000-0000-7000-8000-000000000011', occurred_at: '2026-08-23T01:00:00.000000Z',
    },
  };
  indeterminate.execution_facts = { closure_status: 'indeterminate' };
  delete indeterminate.device_lease_ref;
  delete indeterminate.lease_version;
  delete indeterminate.fencing_token;
  delete indeterminate.old_device_suppression_fence;
  const indeterminateInput = { ...base, authorityResult: indeterminate } as Record<string, unknown>;
  delete indeterminateInput.suppressionResult;
  const indeterminateOutput = await codec.encode(indeterminateInput as never);
  assertTerminal(indeterminateOutput);
  assert.equal(indeterminateOutput.status, 'indeterminate');
  const promoted = { ...indeterminate, status: 'indeterminate', operation_outcome: handoffTerminal.operation_outcome };
  await assert.rejects(codec.encode({ ...base, authorityResult: promoted } as never), /STATUS_OUTCOME_INVALID|AUTHORITY_INVALID/);
  await assert.rejects(codec.encode({ ...base, authorityResult: { ...handoffTerminal, token: 'secret' } } as never), /AUTHORITY_INVALID|SECRET/);
});
