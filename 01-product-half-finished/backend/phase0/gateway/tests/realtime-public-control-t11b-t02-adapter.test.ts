import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRealtimePublicOperationReceipts} from '../../../services/platform-data/src/realtime-public-operation-receipts.ts';
const {Pool}=createRequire(new URL('../../../services/platform-data/package.json',import.meta.url))('pg');
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRealtimePublicControlT11bT02Adapter,
  type RealtimePublicControlT11bT02AdapterOptions,
  type T11bDurableMediaStopClaim,
  type T11bMediaStopIntent,
} from '../src/realtime-public-control-t11b-t02-adapter.ts';
import type { MediaClosureFacts, RealtimeBearerContext } from '../src/realtime-public-control-runtime.ts';
import { projectRealtimeExternalAliases, RealtimeExternalAliasError } from '../src/realtime-public-control-external-alias.ts';
import type {
  PublicBindingProjection,
  PublicBootstrapProjection,
  PublicRefreshProjection,
} from '../../../services/realtime-core/src/public-control-projection.ts';
import {
  assertCanonicalTimestamp,
  assertDecimalConnectionEpoch,
  assertDecimalCounter,
  snapshotOpaqueOwnerValue,
  type
  BootstrapRequest,
  type ConnectedRefreshRequest,
  type RealtimeTransportBinding,
  type StopRequest,
  type TerminalReceipt,
} from '../../../services/realtime-core/src/types.ts';

type JsonRecord = Record<string, unknown>;

const DEVICE = 'device-t11b-1';
const USER = 'user-t11b-1';
const OCCURRED = assertCanonicalTimestamp('2026-08-23T01:00:00Z');
const CONTINUITY_EXPIRES = assertCanonicalTimestamp('2026-08-23T01:30:00Z');
const LEASE_EXPIRES = assertCanonicalTimestamp('2026-08-23T01:20:00Z');
const GOVERNANCE = Object.freeze({
  purpose_scopes: ['realtime_assistant'],
  policy_decision_refs: [{ ref_type: 'PolicyDecision', ref_id: 'policy-1' }],
  capability_grant_refs: [{ ref_type: 'CapabilityGrant', ref_id: 'grant-1' }],
});
const SESSION_REF = Object.freeze({
  ref_type: 'RealtimeSession', ref_id: 'session-1', object_version: '17', canonical_payload_sha256: 'a'.repeat(64),
});
const LEASE_REF = Object.freeze({
  ref_type: 'DeviceLease', ref_id: 'lease-1', object_version: '9', canonical_payload_sha256: 'b'.repeat(64),
});
const SESSION_REF_2 = Object.freeze({
  ref_type: 'RealtimeSession', ref_id: 'session-2', object_version: '18', canonical_payload_sha256: 'c'.repeat(64),
});
const LEASE_REF_2 = Object.freeze({
  ref_type: 'DeviceLease', ref_id: 'lease-2', object_version: '10', canonical_payload_sha256: 'd'.repeat(64),
});
const ALIASES = Object.freeze([
  Object.freeze({ alias_type: 'participant', issuer: 'livekit_cloud', value: 'device-alias-1' }),
  Object.freeze({ alias_type: 'room', issuer: 'livekit_cloud', value: 'room-1' }),
  Object.freeze({ alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport-1' }),
]);
const ALIASES_2 = Object.freeze([
  Object.freeze({ alias_type: 'participant', issuer: 'livekit_cloud', value: 'device-alias-2' }),
  Object.freeze({ alias_type: 'room', issuer: 'livekit_cloud', value: 'room-2' }),
  Object.freeze({ alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport-2' }),
]);
const BEARER: RealtimeBearerContext = Object.freeze({
  principal: { user_id: 'must-not-be-trusted', purpose: 'must-not-be-trusted' },
  deviceId: DEVICE,
  capabilityRef: { ref_id: 'bearer-capability-must-not-be-trusted' },
});

function idempotency(key: string): JsonRecord {
  return {
    idempotency_key: key,
    idempotency_profile_id: 'https://personal-ai-os.local/contracts/realtime/idempotency/t11b',
    idempotency_profile_version: '1.0.0',
    idempotency_profile_sha256: '1'.repeat(64),
    idempotency_request_sha256: '2'.repeat(64),
    idempotency_scope: { owner_module: 'T11B', operation_kind: 'test', target_object_type: 'RealtimeSession' },
  };
}

function initialWire(key = 'bootstrap-1'): JsonRecord {
  return {
    operation: 'bootstrap', bootstrap_mode: 'initial', request_id: key, idempotency_context: idempotency(key),
    device_id: DEVICE,
    start: { kind: 'explicit_user_start', device_id: DEVICE, modalities: ['audio', 'video'], started_at: OCCURRED },
    requested_media: { audio: true, video: true, data: false }, governance: GOVERNANCE,
  };
}

function disconnectedWire(key = 'bootstrap-2'): JsonRecord {
  return {
    operation: 'bootstrap', bootstrap_mode: 'fully_disconnected', request_id: key,
    idempotency_context: idempotency(key), device_id: DEVICE,
    start: { kind: 'explicit_user_start', device_id: DEVICE, modalities: ['audio', 'video'], started_at: OCCURRED },
    requested_media: { audio: true, video: true, data: false },
    continuity_id: 'continuity-1', transport_aliases: ALIASES, governance: GOVERNANCE,
  };
}

function refreshWire(key = 'refresh-1'): JsonRecord {
  return {
    operation: 'connected_credential_refresh', request_id: key, idempotency_context: idempotency(key),
    realtime_session_ref: SESSION_REF, device_lease_ref: LEASE_REF, continuity_id: 'continuity-1',
    connection_epoch: '17', transport_aliases: ALIASES, refresh_reason: 'sdk_reconnect', governance: GOVERNANCE,
  };
}

function stopWire(key = 'stop-1'): JsonRecord {
  return {
    operation: 'media_stop', request_id: key, idempotency_context: idempotency(key),
    realtime_session_ref: SESSION_REF, device_lease_ref: LEASE_REF, continuity_id: 'continuity-1',
    connection_epoch: '17', transport_aliases: ALIASES, reason: 'user_stop',
    release_scope: 'media_device_lease_only', expected_lease_version: '9', governance: GOVERNANCE,
  };
}

function endWire(key = 'end-1'): JsonRecord {
  return {
    operation: 'end_continuity', request_id: key, idempotency_context: idempotency(key),
    realtime_session_ref: SESSION_REF, continuity_id: 'continuity-1', connection_epoch: '17',
    confirmation: 'explicit_user_end_continuity', governance: GOVERNANCE,
  };
}

function handoffWire(key = 'handoff-1'): JsonRecord {
  return {
    operation: 'handoff', request_id: key, idempotency_context: idempotency(key),
    realtime_session_ref: SESSION_REF, current_device_lease_ref: LEASE_REF,
    continuity_id: 'continuity-1', connection_epoch: '17', expected_lease_version: '9',
    from_device_id: DEVICE, to_device_id: 'device-t11b-2', governance: GOVERNANCE,
  };
}

function rawAlias(values: readonly unknown[], type: string): unknown {
  const value = values.find((candidate) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) &&
    (candidate as JsonRecord).alias_type === type);
  return value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord).value
    : value;
}

function binding(
  refs: { session: unknown; lease: unknown; aliases: readonly unknown[]; epoch: string } = {
    session: SESSION_REF, lease: LEASE_REF, aliases: ALIASES, epoch: '17',
  },
): RealtimeTransportBinding {
  return {
    state: 'connected', realtimeSessionRef: snapshotOpaqueOwnerValue(refs.session),
    deviceLeaseRef: snapshotOpaqueOwnerValue(refs.lease),
    continuityId: 'continuity-1', deviceId: DEVICE, connectionEpoch: assertDecimalConnectionEpoch(refs.epoch),
    provider: snapshotOpaqueOwnerValue({ provider: 'livekit_cloud', project: 'project-1' }),
    transportSessionAlias: snapshotOpaqueOwnerValue(rawAlias(refs.aliases, 'transport_session')),
    roomAlias: snapshotOpaqueOwnerValue(rawAlias(refs.aliases, 'room')),
    deviceAlias: snapshotOpaqueOwnerValue(rawAlias(refs.aliases, 'participant')),
    connectionId: refs.epoch === '17' ? 'connection-17' : 'connection-18',
  };
}

function projectBinding(value: RealtimeTransportBinding): PublicBindingProjection {
  return {
    realtimeSessionRef: value.realtimeSessionRef,
    deviceLeaseRef: value.deviceLeaseRef,
    continuityId: value.continuityId,
    connectionEpoch: value.connectionEpoch,
    transportSessionAlias: value.transportSessionAlias,
    roomAlias: value.roomAlias,
    deviceAlias: value.deviceAlias,
    provider: value.provider,
    connectionId: value.connectionId,
  };
}

const CURRENT_BINDING = binding();
const NEXT_BINDING = binding({ session: SESSION_REF_2, lease: LEASE_REF_2, aliases: ALIASES_2, epoch: '18' });
const INITIAL_PROJECTION: PublicBootstrapProjection = {
  operation: 'bootstrap', binding: projectBinding(CURRENT_BINDING),
  continuityExpiresAt: CONTINUITY_EXPIRES, leaseExpiresAt: LEASE_EXPIRES,
  receipt: {} as TerminalReceipt,
};
const NEXT_PROJECTION: PublicBootstrapProjection = {
  operation: 'bootstrap', binding: projectBinding(NEXT_BINDING),
  continuityExpiresAt: CONTINUITY_EXPIRES, leaseExpiresAt: LEASE_EXPIRES,
  receipt: {} as TerminalReceipt,
};
const REFRESH_PROJECTION: PublicRefreshProjection = {
  operation: 'connected_credential_refresh', binding: projectBinding(CURRENT_BINDING),
  continuityExpiresAt: CONTINUITY_EXPIRES, leaseExpiresAt: LEASE_EXPIRES,
  receipt: {} as TerminalReceipt,
};
const COMPLETE_FACTS: MediaClosureFacts = {
  completedStages: ['tracks_unpublished', 'participant_disconnected', 'credential_revoked', 'closure_verified'],
  failedStages: [],
};

function receipt(request: StopRequest, overrides: Partial<TerminalReceipt> = {}): TerminalReceipt {
  return {
    kind: 'realtime_terminal_receipt', operation: request.operation, status: 'success',
    requestId: request.requestId, idempotencyKey: request.idempotencyKey,
    realtimeSessionRef: request.realtimeSessionRef,
    ...(request.deviceLeaseRef === undefined ? {} : { deviceLeaseRef: request.deviceLeaseRef }),
    continuityId: request.continuityId, connectionEpoch: request.expectedConnectionEpoch,
    outcome: 'released', recordedAt: OCCURRED, replayed: false, ...overrides,
  } as TerminalReceipt;
}

function terminalResult(
  operation: 'media_stop' | 'end_continuity', wire: JsonRecord, executionFacts?: JsonRecord,
): JsonRecord {
  return {
    operation, status: 'success', request_id: wire.request_id,
    realtime_session_ref: wire.realtime_session_ref, ...(wire.device_lease_ref === undefined ? {} : { device_lease_ref: wire.device_lease_ref }),
    continuity_id: wire.continuity_id, connection_epoch: wire.connection_epoch,
    operation_outcome: {
      outcome_class: 'committed_success', resolution_mode: 'direct',
      recorded_result_ref: {
        idempotency_context: wire.idempotency_context, fencing_epoch: '3', outcome_class: 'committed_success',
        result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json',
        result_schema_version: '1.0.0', result_schema_sha256: '3'.repeat(64), result_payload_sha256: '4'.repeat(64),
      },
    },
    ...(executionFacts === undefined ? {} : { execution_facts: executionFacts }), governance: wire.governance,
  };
}

function replayResult(wire: JsonRecord): JsonRecord {
  return {
    operation: 'media_stop', status: 'failure', request_id: wire.request_id,
    realtime_session_ref: wire.realtime_session_ref, device_lease_ref: wire.device_lease_ref,
    continuity_id: wire.continuity_id, connection_epoch: wire.connection_epoch,
    operation_outcome: {
      outcome_class: 'committed_rejection', resolution_mode: 'direct',
      recorded_result_ref: {
        idempotency_context: wire.idempotency_context, fencing_epoch: '4', outcome_class: 'committed_rejection',
        result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json',
        result_schema_version: '1.0.0', result_schema_sha256: '5'.repeat(64), result_payload_sha256: '6'.repeat(64),
      },
    },
    execution_facts: {
      closure_status: 'failed', device_lease_release: 'failed', participant_cleanup: 'failed',
      track_cleanup: 'failed', room_cleanup: 'failed',
    },
    governance: wire.governance,
  };
}

function handoffTerminal(wire: JsonRecord, status: 'success' | 'indeterminate' = 'success'): JsonRecord {
  if (status === 'indeterminate') {
    return {
      operation: 'handoff', status, request_id: wire.request_id,
      realtime_session_ref: wire.realtime_session_ref, previous_device_lease_ref: wire.current_device_lease_ref,
      continuity_id: wire.continuity_id, connection_epoch: wire.connection_epoch,
      from_device_id: wire.from_device_id, to_device_id: wire.to_device_id,
      operation_outcome: {
        outcome_class: 'indeterminate',
        error: { error_family: 'provider', error_code: 'provider.handoff_unknown', retry_class: 'never', trace_id: '018f0000-0000-7000-8000-000000000011', occurred_at: OCCURRED },
      },
      execution_facts: { closure_status: 'indeterminate', device_lease_release: 'indeterminate', evidence_refs: [] },
      governance: wire.governance,
    };
  }
  const nextLease = LEASE_REF_2;
  return {
    operation: 'handoff', status, request_id: wire.request_id,
    realtime_session_ref: wire.realtime_session_ref, device_lease_ref: nextLease,
    previous_device_lease_ref: wire.current_device_lease_ref, continuity_id: wire.continuity_id,
    connection_epoch: wire.connection_epoch, from_device_id: wire.from_device_id, to_device_id: wire.to_device_id,
    lease_version: '10', fencing_token: '10',
    old_device_suppression_fence: {
      from_device_id: wire.from_device_id, previous_device_lease_ref: wire.current_device_lease_ref,
      new_device_lease_ref: nextLease, connection_epoch: wire.connection_epoch, fencing_token: '10', state: 'old_device_suppressed',
    },
    operation_outcome: {
      outcome_class: 'committed_success', resolution_mode: 'direct',
      recorded_result_ref: {
        idempotency_context: wire.idempotency_context, fencing_epoch: '10', outcome_class: 'committed_success',
        result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json',
        result_schema_version: '1.0.0', result_schema_sha256: '3'.repeat(64), result_payload_sha256: '4'.repeat(64),
      },
    },
    execution_facts: {
      closure_status: 'verified_closed', device_lease_release: 'released',
      participant_cleanup: 'verified_absent', track_cleanup: 'verified_absent', room_cleanup: 'verified_absent',
      evidence_refs: [{ evidence_ref: 'handoff-evidence' }],
    },
    governance: wire.governance,
  };
}

function handoffSuppression(wire: JsonRecord, terminal: JsonRecord, closureStatus: 'verified_closed' | 'indeterminate' = 'verified_closed'): JsonRecord {
  const facts = terminal.execution_facts as JsonRecord;
  return {
    state: closureStatus === 'verified_closed' ? 'old_device_suppressed' : 'indeterminate',
    closure_status: closureStatus,
    evidence_refs: facts.evidence_refs ?? [],
    old_device_suppression_fence: terminal.old_device_suppression_fence,
  };
}

interface HarnessConfig {
  readonly claim?: T11bDurableMediaStopClaim;
  readonly currentBinding?: RealtimeTransportBinding;
  readonly initialProjection?: PublicBootstrapProjection;
  readonly nextProjection?: PublicBootstrapProjection;
  readonly refreshProjection?: PublicRefreshProjection;
  readonly cloudBootstrap?: JsonRecord;
  readonly cloudRefresh?: JsonRecord;
  readonly codecResult?: JsonRecord;
  readonly mediaReceipt?: (request: StopRequest) => TerminalReceipt;
  readonly commitError?: Error;
  readonly readiness?: () => void | boolean | Promise<void | boolean>;
}

function makeHarness(config: HarnessConfig = {}) {
  const events: string[] = [];
  const bootstrapCommands: BootstrapRequest[] = [];
  const refreshCommands: ConnectedRefreshRequest[] = [];
  const stopCommands: StopRequest[] = [];
  const endCommands: StopRequest[] = [];
  const claimedIntents: T11bMediaStopIntent[] = [];
  const intents = new Map<string, T11bMediaStopIntent>();
  let codecOverride = config.codecResult;
  let closeCount = 0;
  const options: RealtimePublicControlT11bT02AdapterOptions = {
    issuerReadiness: {
      async assertReady() { events.push('readiness'); return config.readiness?.(); },
      close() { closeCount += 1; },
    },
    ownerContext: {
      async resolve() {
        events.push('owner');
        return { userId: USER, deviceId: DEVICE, purpose: 'realtime_assistant', capabilities: ['audio', 'video'], occurredAt: OCCURRED };
      },
      close() { closeCount += 1; },
    },
    currentBinding: {
      async resolve() {
        events.push('current');
        return {
          binding: config.currentBinding ?? CURRENT_BINDING,
          continuityExpiresAt: CONTINUITY_EXPIRES,
          leaseVersion: assertDecimalCounter('9'),
        };
      },
      close() { closeCount += 1; },
    },
    governance: {
      async assertAuthorized() { events.push('governance'); return GOVERNANCE; },
      close() { closeCount += 1; },
    },
    projection: {
      async bootstrap(command) { events.push('projection.bootstrap'); bootstrapCommands.push(command); return config.initialProjection ?? INITIAL_PROJECTION; },
      async fullyDisconnectedRefresh(command) { events.push('projection.disconnected'); bootstrapCommands.push(command); return config.nextProjection ?? NEXT_PROJECTION; },
      async connectedRefresh(command) { events.push('projection.refresh'); refreshCommands.push(command); return config.refreshProjection ?? REFRESH_PROJECTION; },
      async mediaStop(command) { events.push('projection.mediaStop'); stopCommands.push(command); return (config.mediaReceipt ?? receipt)(command); },
      async endContinuity(command) { events.push('projection.endContinuity'); endCommands.push(command); return receipt(command); },
    },
    cloud: {
      async bootstrap() {
        events.push('cloud.bootstrap');
        return (config.cloudBootstrap ?? {
          serverUrl: 'wss://project.livekit.cloud', credentialExpiresAt: '2026-08-23T01:15:00Z',
          terminalRoomName: 'terminal-room', terminalIdentity: 'terminal-identity',
          terminalGrants: { room: 'terminal-room', roomJoin: true }, mediaGrants: { audio: { enabled: true } },
          gateway: { roomName: 'gateway-room', identity: 'gateway-identity', grants: { roomJoin: true } },
          credentialGeneration: '17',
        }) as never;
      },
      async connectedRefresh() {
        events.push('cloud.refresh');
        return (config.cloudRefresh ?? {
          credentialExpiresAt: '2026-08-23T01:15:00Z', credentialGeneration: '18',
          credentialInput: { room: 'terminal-room', identity: 'terminal-identity', ttlSeconds: 600, grants: { roomJoin: true } },
        }) as never;
      },
      close() { closeCount += 1; },
    },
    externalEffects: {
      async claim(input) {
        events.push('claim');
        claimedIntents.push(input.intent);
        if ((config.claim?.disposition ?? 'claimed') === 'claimed') intents.set('claim-1', input.intent);
        return config.claim ?? { disposition: 'claimed', claimId: 'claim-1' };
      },
      async restore({ claimId }) { events.push(`restore:${claimId}`); return intents.get(claimId); },
      async executeStage({ claimId, stage }) { events.push(`stage:${claimId}:${stage}`); },
      async commit() { events.push('commit'); if (config.commitError !== undefined) throw config.commitError; },
      async release() { events.push('release'); },
      close() { closeCount += 1; },
    },
    terminalCodec: {
      async encode(input) {
        events.push(`codec:${input.operation}`);
        return codecOverride ?? terminalResult(input.operation, input.wireRequest, input.executionFacts);
      },
      close() { closeCount += 1; },
    },
  };
  return {
    adapter: createRealtimePublicControlT11bT02Adapter(options), options, events,
    bootstrapCommands, refreshCommands, stopCommands, endCommands, claimedIntents,
    setCodecResult(value: JsonRecord) { codecOverride = value; },
    closeCount: () => closeCount,
  };
}

test('factory requires every owner method before any effect can run', () => {
  const valid = makeHarness().options as unknown as JsonRecord;
  const missing = [
    ['issuerReadiness', 'assertReady'], ['ownerContext', 'resolve'], ['currentBinding', 'resolve'],
    ['governance', 'assertAuthorized'], ['projection', 'bootstrap'], ['projection', 'connectedRefresh'],
    ['projection', 'fullyDisconnectedRefresh'], ['projection', 'mediaStop'], ['projection', 'endContinuity'],
    ['cloud', 'bootstrap'], ['cloud', 'connectedRefresh'], ['externalEffects', 'claim'],
    ['externalEffects', 'restore'], ['externalEffects', 'executeStage'], ['externalEffects', 'commit'],
    ['externalEffects', 'release'], ['terminalCodec', 'encode'],
  ] as const;
  for (const [port, method] of missing) {
    let effects = 0;
    const candidate = { ...valid, [port]: { ...(valid[port] as JsonRecord), [method]: undefined } };
    const projection = candidate.projection as JsonRecord;
    candidate.projection = { ...projection, bootstrap: method === 'bootstrap' && port === 'projection' ? undefined : () => { effects += 1; } };
    assert.throws(() => createRealtimePublicControlT11bT02Adapter(candidate as never), /T11B_ADAPTER_/);
    assert.equal(effects, 0, `${port}.${method}`);
  }
});

test('initial bootstrap consumes the T01 wire shape and maps full refs, aliases, decimal epoch, and secret-free Cloud fields', async () => {
  const h = makeHarness();
  const wire = initialWire();
  for (const forbidden of ['user_id', 'purpose', 'capabilities', 'occurred_at']) assert.equal(Object.hasOwn(wire, forbidden), false);
  const result = await h.adapter.sessions.bootstrap({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  const command = h.bootstrapCommands[0];
  assert.ok(command);
  assert.equal(command.userId, USER);
  assert.equal(command.deviceId, DEVICE);
  assert.equal(command.purpose, 'realtime_assistant');
  assert.deepEqual(command.capabilities, ['audio', 'video']);
  assert.equal(command.occurredAt, OCCURRED);
  assert.deepEqual(result.realtime_session_ref, SESSION_REF);
  assert.deepEqual(result.device_lease_ref, LEASE_REF);
  assert.deepEqual(result.transport_aliases, ALIASES);
  assert.equal(result.connection_epoch, '17');
  assert.equal(result.server_url, 'wss://project.livekit.cloud');
  assert.equal(result.credential_generation, '17');
  assert.deepEqual(result.gateway, { roomName: 'gateway-room', identity: 'gateway-identity', grants: { roomJoin: true } });
  assert.equal(Object.hasOwn(result.gateway, 'roomOptions'), false);
  assert.equal(Object.hasOwn(result.gateway, 'token'), false);
});

test('external aliases accept legacy strings and closed historical objects, while rejecting malformed aliases', () => {
  const strings = projectRealtimeExternalAliases({
    transportSessionAlias: 'transport-legacy',
    roomAlias: 'room-legacy',
    deviceAlias: 'device-legacy',
  });
  assert.deepEqual(strings, [
    { alias_type: 'participant', issuer: 'livekit_cloud', value: 'device-legacy' },
    { alias_type: 'room', issuer: 'livekit_cloud', value: 'room-legacy' },
    { alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport-legacy' },
  ]);
  const historical = projectRealtimeExternalAliases({
    transportSessionAlias: { alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport-legacy' },
    roomAlias: { alias_type: 'room', issuer: 'livekit_cloud', value: 'room-legacy' },
    deviceAlias: {
      alias_type: 'device', issuer: 'livekit_cloud', value: 'device-legacy',
      provider_id: '0190a000-0000-7000-8000-000000000001',
    },
  });
  assert.equal(historical[0]!.alias_type, 'device');
  assert.equal(Object.isFrozen(historical), true);
  const malformed = [
    { transportSessionAlias: { alias_type: 'room', issuer: 'livekit_cloud', value: 'transport' }, roomAlias: 'room', deviceAlias: 'device' },
    { transportSessionAlias: { alias_type: 'transport_session', issuer: 'bad issuer', value: 'transport' }, roomAlias: 'room', deviceAlias: 'device' },
    { transportSessionAlias: { alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport', provider_id: 'not-uuid' }, roomAlias: 'room', deviceAlias: 'device' },
    { transportSessionAlias: { alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport', extra: true }, roomAlias: 'room', deviceAlias: 'device' },
  ];
  for (const binding of malformed) assert.throws(() => projectRealtimeExternalAliases(binding), RealtimeExternalAliasError);
  const accessor: JsonRecord = { roomAlias: 'room', deviceAlias: 'device' };
  Object.defineProperty(accessor, 'transportSessionAlias', { get: () => 'transport', enumerable: true });
  assert.throws(() => projectRealtimeExternalAliases(accessor), RealtimeExternalAliasError);
  const symbolKey = Symbol('alias');
  const symbolAlias = { alias_type: 'transport_session', issuer: 'livekit_cloud', value: 'transport', [symbolKey]: true };
  assert.throws(() => projectRealtimeExternalAliases({ transportSessionAlias: symbolAlias, roomAlias: 'room', deviceAlias: 'device' }), RealtimeExternalAliasError);
});

test('projects raw PG aliases into sorted canonical wire aliases and rejects alias drift', async () => {
  const h = makeHarness();
  const result = await h.adapter.sessions.bootstrap({ request: disconnectedWire(), bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(result.transport_aliases, ALIASES_2);
  const variants: readonly [string, readonly unknown[]][] = [
    ['type', ALIASES.map((alias, index) => index === 0 ? { ...alias, alias_type: 'device' } : alias)],
    ['issuer', ALIASES.map((alias, index) => index === 0 ? { ...alias, issuer: 'other' } : alias)],
    ['value', ALIASES.map((alias, index) => index === 0 ? { ...alias, value: 'drifted' } : alias)],
    ['duplicate', [ALIASES[0], ALIASES[0], ALIASES[2]]],
    ['missing', ALIASES.slice(1)],
    ['extra', [...ALIASES, ALIASES[0]]],
    ['unsorted', [...ALIASES].reverse()],
  ];
  for (const [label, transportAliases] of variants) {
    await assert.rejects(
      makeHarness().adapter.sessions.bootstrap({
        request: { ...disconnectedWire(`alias-${label}`), transport_aliases: transportAliases },
        bearer: BEARER,
        governance: GOVERNANCE,
      }),
      /CURRENT_BINDING_MISMATCH/u,
    );
  }
});

test('bootstrap rejects bearer, device/start, idempotency, and governance binding drift before projection or Cloud effects', async () => {
  const cases: readonly [{ readonly request: JsonRecord; readonly bearer: RealtimeBearerContext; readonly governance: JsonRecord }, RegExp][] = [
    [{ request: initialWire(), bearer: { ...BEARER, deviceId: 'other-device' }, governance: GOVERNANCE }, /OWNER_DEVICE_BINDING_INVALID/],
    [{ request: { ...initialWire(), device_id: 'other-device' }, bearer: BEARER, governance: GOVERNANCE }, /OWNER_DEVICE_BINDING_INVALID/],
    [{ request: { ...initialWire(), start: { ...(initialWire().start as JsonRecord), started_at: '2026-08-23T01:00:01Z' } }, bearer: BEARER, governance: GOVERNANCE }, /OCCURRED_AT_BINDING_INVALID/],
    [{ request: { ...initialWire(), request_id: 'not-the-idempotency-key' }, bearer: BEARER, governance: GOVERNANCE }, /REQUEST_ID_BINDING_INVALID/],
    [{ request: initialWire(), bearer: BEARER, governance: { ...GOVERNANCE, purpose_scopes: ['drift'] } }, /GOVERNANCE_BINDING_INVALID/],
  ];
  for (const [input, expected] of cases) {
    const h = makeHarness();
    await assert.rejects(h.adapter.sessions.bootstrap(input), expected);
    assert.equal(h.events.some((event) => event.startsWith('projection.') || event.startsWith('cloud.')), false);
  }
});

test('fully disconnected bootstrap accepts only continuity plus aliases from the prior wire binding and carries the full current binding internally', async () => {
  const h = makeHarness();
  const wire = disconnectedWire();
  assert.equal(Object.hasOwn(wire, 'realtime_session_ref'), false);
  assert.equal(Object.hasOwn(wire, 'device_lease_ref'), false);
  assert.equal(Object.hasOwn(wire, 'connection_epoch'), false);
  const result = await h.adapter.sessions.bootstrap({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  const command = h.bootstrapCommands[0];
  assert.ok(command?.existingBinding);
  assert.deepEqual(command.existingBinding, CURRENT_BINDING);
  assert.deepEqual(command.existingSessionRef, SESSION_REF);
  assert.equal(command.continuityId, 'continuity-1');
  assert.deepEqual(result.realtime_session_ref, SESSION_REF_2);
  assert.deepEqual(result.device_lease_ref, LEASE_REF_2);
  assert.deepEqual(result.transport_aliases, ALIASES_2);
  assert.equal(result.connection_epoch, '18');
  assert.deepEqual(result.binding_transition, {
    atomic: true,
    previous_connection_epoch: '17',
    previous_realtime_session_ref: SESSION_REF,
    previous_device_lease_ref: LEASE_REF,
    previous_transport_aliases: ALIASES,
    previous_continuity_expires_at: CONTINUITY_EXPIRES,
    provider_session_reused: false,
  });

  const disconnected = makeHarness({ currentBinding: { ...CURRENT_BINDING, state: 'disconnected' } });
  const disconnectedResult = await disconnected.adapter.sessions.bootstrap({
    request: disconnectedWire('bootstrap-from-disconnected'), bearer: BEARER, governance: GOVERNANCE,
  });
  assert.equal(disconnectedResult.connection_epoch, '18');
  assert.equal(disconnected.bootstrapCommands[0]?.existingBinding?.state, 'disconnected');

  const released = makeHarness({ currentBinding: { ...CURRENT_BINDING, state: 'released' } });
  await assert.rejects(released.adapter.sessions.bootstrap({
    request: disconnectedWire('bootstrap-from-released'), bearer: BEARER, governance: GOVERNANCE,
  }), /CURRENT_BINDING_INVALID/);
  assert.equal(released.events.includes('projection.disconnected'), false);
});

test('fully disconnected bootstrap rejects current-wire drift, reused identities, non-advanced or numeric epochs, and deadline extension', async () => {
  const badWires = [
    { ...disconnectedWire('disconnected-drift-1'), continuity_id: 'other-continuity' },
    { ...disconnectedWire('disconnected-drift-2'), transport_aliases: ALIASES_2 },
  ];
  for (const request of badWires) {
    await assert.rejects(makeHarness().adapter.sessions.bootstrap({ request, bearer: BEARER, governance: GOVERNANCE }), /CURRENT_BINDING_MISMATCH/);
  }
  const projectionCases: readonly [PublicBootstrapProjection, RegExp][] = [
    [{ ...NEXT_PROJECTION, binding: { ...NEXT_PROJECTION.binding, realtimeSessionRef: SESSION_REF } }, /DISCONNECTED_BINDING_INVALID/],
    [{ ...NEXT_PROJECTION, binding: { ...NEXT_PROJECTION.binding, transportSessionAlias: 'transport-1' } }, /ALIAS_NOT_ROTATED/],
    [{ ...NEXT_PROJECTION, binding: { ...NEXT_PROJECTION.binding, connectionEpoch: '17' } }, /EPOCH_NOT_ADVANCED/],
    [{ ...NEXT_PROJECTION, binding: { ...NEXT_PROJECTION.binding, connectionEpoch: 18 as never } }, /INVALID_CONNECTION_EPOCH/],
    [{ ...NEXT_PROJECTION, continuityExpiresAt: '2026-08-23T01:30:01Z' }, /CONTINUITY_DEADLINE_EXTENDED/],
  ];
  for (const [nextProjection, expected] of projectionCases) {
    await assert.rejects(makeHarness({ nextProjection }).adapter.sessions.bootstrap({ request: disconnectedWire(), bearer: BEARER, governance: GOVERNANCE }), expected);
  }
});

test('connected refresh uses a device-free and occurred-at-free wire, preserves binding/deadline, and bounds credential expiry', async () => {
  const h = makeHarness();
  const wire = refreshWire();
  assert.equal(Object.hasOwn(wire, 'device_id'), false);
  assert.equal(Object.hasOwn(wire, 'occurred_at'), false);
  const result = await h.adapter.sessions.refresh({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.equal(h.refreshCommands[0]?.occurredAt, OCCURRED);
  assert.deepEqual(h.refreshCommands[0]?.binding, CURRENT_BINDING);
  assert.deepEqual(result.realtime_session_ref, SESSION_REF);
  assert.deepEqual(result.transport_aliases, ALIASES);
  assert.equal(result.connection_epoch, '17');
  assert.equal(result.credential_expires_at, '2026-08-23T01:15:00Z');

  const failures: readonly [HarnessConfig, RegExp][] = [
    [{ refreshProjection: { ...REFRESH_PROJECTION, binding: { ...REFRESH_PROJECTION.binding, connectionId: 'drift' } } }, /REFRESH_BINDING_CHANGED/],
    [{ refreshProjection: { ...REFRESH_PROJECTION, continuityExpiresAt: '2026-08-23T01:29:59Z' } }, /CONTINUITY_DEADLINE_EXTENDED/],
    [{ cloudRefresh: { credentialExpiresAt: '2026-08-23T01:20:01Z', credentialGeneration: '18', credentialInput: { room: 'terminal-room', identity: 'terminal-identity', grants: {} } } }, /CREDENTIAL_DEADLINE_INVALID/],
  ];
  for (const [config, expected] of failures) {
    await assert.rejects(makeHarness(config).adapter.sessions.refresh({ request: refreshWire(), bearer: BEARER, governance: GOVERNANCE }), expected);
  }
  for (const state of ['disconnected', 'released'] as const) {
    const invalidState = makeHarness({ currentBinding: { ...CURRENT_BINDING, state } });
    await assert.rejects(invalidState.adapter.sessions.refresh({
      request: refreshWire(`refresh-${state}`), bearer: BEARER, governance: GOVERNANCE,
    }), /CURRENT_BINDING_INVALID/);
    assert.equal(invalidState.events.includes('projection.refresh'), false);
  }
});

test('durable media stop claims first, restores intent for all four cleanup stages, then releases T11B, encodes, and commits in order', async () => {
  const h = makeHarness();
  const wire = stopWire();
  const claim = await h.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.equal(claim.claimId, 'claim-1');
  await h.adapter.mediaStop.unpublishAllTracks(claim.claimId);
  await h.adapter.mediaStop.disconnectParticipant(claim.claimId);
  await h.adapter.mediaStop.revokeCredential?.(claim.claimId);
  await h.adapter.mediaStop.verifyMediaClosed?.(claim.claimId);
  const result = await h.adapter.mediaStop.complete(claim.claimId, COMPLETE_FACTS);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.execution_facts, {
    closure_status: 'verified_closed', device_lease_release: 'released',
    participant_cleanup: 'verified_absent', track_cleanup: 'verified_absent', room_cleanup: 'verified_absent',
  });
  assert.deepEqual(h.events.filter((event) => event === 'claim' || event.startsWith('stage:') || event === 'projection.mediaStop' || event.startsWith('codec:') || event === 'commit'), [
    'claim',
    'stage:claim-1:tracks_unpublished',
    'stage:claim-1:participant_disconnected',
    'stage:claim-1:credential_revoked',
    'stage:claim-1:closure_verified',
    'projection.mediaStop', 'codec:media_stop', 'commit',
  ]);
  assert.equal(h.stopCommands[0]?.deviceId, DEVICE);
  assert.equal(h.stopCommands[0]?.expectedConnectionEpoch, '17');
  assert.equal(h.stopCommands[0]?.expectedLeaseVersion, '9');
  assert.equal((h.stopCommands[0] as StopRequest & { readonly credentialGeneration?: string }).credentialGeneration, '9');

  const disconnected = makeHarness({ currentBinding: { ...CURRENT_BINDING, state: 'disconnected' } });
  const disconnectedClaim = await disconnected.adapter.mediaStop.claim({
    request: stopWire('stop-disconnected'), bearer: BEARER, governance: GOVERNANCE,
  });
  await disconnected.adapter.mediaStop.unpublishAllTracks(disconnectedClaim.claimId);
  await disconnected.adapter.mediaStop.disconnectParticipant(disconnectedClaim.claimId);
  await disconnected.adapter.mediaStop.revokeCredential?.(disconnectedClaim.claimId);
  await disconnected.adapter.mediaStop.verifyMediaClosed?.(disconnectedClaim.claimId);
  const disconnectedResult = await disconnected.adapter.mediaStop.complete(disconnectedClaim.claimId, COMPLETE_FACTS);
  assert.equal(disconnectedResult.status, 'success');
  assert.deepEqual(disconnected.events.filter((event) =>
    event === 'claim' || event.startsWith('stage:') || event === 'projection.mediaStop' || event.startsWith('codec:') || event === 'commit'), [
    'claim',
    'stage:claim-1:tracks_unpublished',
    'stage:claim-1:participant_disconnected',
    'stage:claim-1:credential_revoked',
    'stage:claim-1:closure_verified',
    'projection.mediaStop', 'codec:media_stop', 'commit',
  ]);

  // A stop retried after its own first attempt released the lease still reaches its durable claim: ending is
  // idempotent, and the claim's stored intent plus T02's keyed replay decide the outcome.
  const released = makeHarness({ currentBinding: { ...CURRENT_BINDING, state: 'released' } });
  await released.adapter.mediaStop.claim({ request: stopWire('stop-released'), bearer: BEARER, governance: GOVERNANCE });
  assert.equal(released.events.includes('claim'), true);
});

test('media-stop credential generation comes only from the authoritative current lease version', async () => {
  const h = makeHarness();
  const wire = { ...stopWire(), credential_generation: '999' };
  await h.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.equal((h.claimedIntents[0]?.request as StopRequest & { readonly credentialGeneration?: string }).credentialGeneration, '9');
});

test('media-stop durable success and rejection replay exactly without effects; malformed success and unresolved claims fail closed', async () => {
  const wire = stopWire();
  const successFacts = {
    closure_status: 'verified_closed', device_lease_release: 'already_released',
    participant_cleanup: 'verified_absent', track_cleanup: 'verified_absent', room_cleanup: 'verified_absent',
  };
  const successReplay = terminalResult('media_stop', wire, successFacts);
  const successHarness = makeHarness({ claim: { disposition: 'replay', result: successReplay } });
  const successClaim = await successHarness.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.equal(successClaim.claimId, 'durable-replay');
  assert.deepEqual(successClaim.alreadyCompleted, successReplay);
  assert.deepEqual(
    ((successClaim.alreadyCompleted?.operation_outcome as JsonRecord).recorded_result_ref as JsonRecord).idempotency_context,
    wire.idempotency_context,
  );
  assert.equal(successHarness.events.some((event) =>
    event.startsWith('projection.') || event.startsWith('stage:') || event.startsWith('codec:') || event === 'commit' || event === 'release'), false);

  const rejectionReplay = replayResult(wire);
  const rejectionHarness = makeHarness({ claim: { disposition: 'replay', result: rejectionReplay } });
  const rejectionClaim = await rejectionHarness.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(rejectionClaim.alreadyCompleted, rejectionReplay);
  assert.equal(rejectionHarness.events.some((event) =>
    event.startsWith('projection.') || event.startsWith('stage:') || event.startsWith('codec:') || event === 'commit' || event === 'release'), false);

  const malformedSuccess = {
    ...successReplay,
    execution_facts: { ...successFacts, participant_cleanup: 'indeterminate' },
  };
  const malformedHarness = makeHarness({ claim: { disposition: 'replay', result: malformedSuccess } });
  await assert.rejects(
    malformedHarness.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE }),
    /T11B_ADAPTER_FALSE_SUCCESS/,
  );
  assert.equal(malformedHarness.events.some((event) =>
    event.startsWith('projection.') || event.startsWith('stage:') || event.startsWith('codec:') || event === 'commit' || event === 'release'), false);

  for (const [disposition, expected] of [
    ['conflict', /IDEMPOTENCY_CONFLICT/], ['in_flight', /IDEMPOTENCY_IN_FLIGHT/], ['indeterminate', /IDEMPOTENCY_INDETERMINATE/],
  ] as const) {
    const h = makeHarness({ claim: { disposition } });
    await assert.rejects(h.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE }), expected);
    assert.equal(h.events.includes('projection.mediaStop'), false);
  }
});

test('media-stop precommit failures release the claim, while commit failure never releases it', async () => {
  const wire = stopWire();
  const invalidReceipt = makeHarness({ mediaReceipt: (request) => receipt(request, { requestId: 'drift' }) });
  const first = await invalidReceipt.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  await assert.rejects(invalidReceipt.adapter.mediaStop.complete(first.claimId, COMPLETE_FACTS), /RECEIPT_BINDING_INVALID/);
  assert.deepEqual(invalidReceipt.events.filter((event) => event === 'projection.mediaStop' || event === 'release' || event === 'commit'), ['projection.mediaStop', 'release']);

  const commitFailure = makeHarness({ commitError: new Error('T02_COMMIT_FAILED') });
  const second = await commitFailure.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  await assert.rejects(commitFailure.adapter.mediaStop.complete(second.claimId, COMPLETE_FACTS), /T02_COMMIT_FAILED/);
  assert.deepEqual(commitFailure.events.filter((event) => event === 'commit' || event === 'release'), ['commit']);
});

test('media-stop rejects false success, secret or DeliveryReceipt output, root idempotency, and nested RRR mismatch', async () => {
  const wire = stopWire();
  const validFacts = {
    closure_status: 'verified_closed', device_lease_release: 'released', participant_cleanup: 'verified_absent',
    track_cleanup: 'verified_absent', room_cleanup: 'verified_absent',
  };
  const variants: readonly [JsonRecord, RegExp][] = [
    [{ ...terminalResult('media_stop', wire, validFacts), execution_facts: { ...validFacts, closure_status: 'indeterminate' } }, /FALSE_SUCCESS/],
    [{ ...terminalResult('media_stop', wire, validFacts), token: 'secret' }, /SECRET_OR_RECEIPT_OUTPUT/],
    [{ ...terminalResult('media_stop', wire, validFacts), delivery_receipt: { status: 'rendered' } }, /SECRET_OR_RECEIPT_OUTPUT/],
    [{ ...terminalResult('media_stop', wire, validFacts), idempotency_context: wire.idempotency_context }, /TERMINAL_BINDING_INVALID/],
    [{ ...terminalResult('media_stop', wire, validFacts), operation_outcome: { outcome_class: 'committed_success', recorded_result_ref: { idempotency_context: idempotency('other') } } }, /TERMINAL_RRR_BINDING_INVALID/],
  ];
  for (const [codecResult, expected] of variants) {
    const h = makeHarness({ codecResult });
    const claim = await h.adapter.mediaStop.claim({ request: wire, bearer: BEARER, governance: GOVERNANCE });
    await assert.rejects(h.adapter.mediaStop.complete(claim.claimId, COMPLETE_FACTS), expected);
    assert.equal(h.events.includes('release'), true);
    assert.equal(h.events.includes('commit'), false);
  }
});

test('end continuity accepts connected, disconnected, and released bindings without media-stop or external effects', async () => {
  for (const state of ['connected', 'disconnected', 'released'] as const) {
    const h = makeHarness({ currentBinding: { ...CURRENT_BINDING, state } });
    const wire = endWire(`end-${state}`);
    for (const absent of ['reason', 'device_lease_ref', 'transport_aliases']) assert.equal(Object.hasOwn(wire, absent), false);
    const result = await h.adapter.sessions.endContinuity({ request: wire, bearer: BEARER, governance: GOVERNANCE });
    assert.equal(result.operation, 'end_continuity');
    assert.equal(h.endCommands[0]?.reason, 'user_stop');
    assert.deepEqual(h.endCommands[0]?.deviceLeaseRef, LEASE_REF);
    assert.equal(h.events.includes('projection.endContinuity'), true);
    assert.equal(h.events.some((event) =>
      event === 'claim' || event.startsWith('stage:') || event === 'projection.mediaStop' || event === 'commit' || event === 'release'), false);
  }
});

test('handoff uses current binding plus injected T11B authority and durable output fence', async () => {
  const base = makeHarness();
  const events: string[] = [];
  const wire = handoffWire();
  const result = handoffTerminal(wire);
  let authorityCalls = 0;
  let codecSuppression: unknown;
  const adapter = createRealtimePublicControlT11bT02Adapter({
    ...base.options,
    handoffAuthority: {
      async handoff(request) {
        authorityCalls += 1;
        events.push(`authority:${request.expectedLeaseVersion}`);
        assert.equal(request.fromDeviceId, DEVICE);
        assert.equal(request.toDeviceId, 'device-t11b-2');
        assert.equal(request.expectedConnectionEpoch, '17');
        return result;
      },
    },
    handoffTerminalCodec: {
      async encode(input) { codecSuppression = input.suppressionResult; return result; },
    },
    handoffOutputFence: {
      async claim(input) { events.push(`claim:${input.fingerprint.length}`); return { disposition: 'claimed', claimId: 'handoff-claim-1' }; },
      async suppressAndClose(input) {
        events.push('suppress');
        assert.deepEqual(input.previousBinding, CURRENT_BINDING);
        assert.notEqual(input.previousBinding, CURRENT_BINDING);
        assert.equal(input.request.fromDeviceId, DEVICE);
        assert.equal(input.request.toDeviceId, 'device-t11b-2');
        return handoffSuppression(wire, result);
      },
      async commit(input) { events.push(`commit:${input.claimId}`); assert.deepEqual(input.result, result); },
      async release(input) { events.push(`release:${input.claimId}`); },
    },
  });
  const first = await adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(first, result);
  assert.equal(authorityCalls, 1);
  assert.deepEqual(codecSuppression, handoffSuppression(wire, result));
  assert.deepEqual(events.map((item) => item.split(':')[0]), ['claim', 'authority', 'suppress', 'commit']);
  await adapter.close();
});

test('handoff duplicate replay returns the exact terminal without invoking authority', async () => {
  const base = makeHarness();
  const wire = handoffWire('handoff-replay-1');
  const result = handoffTerminal(wire);
  let authorityCalls = 0;
  let commitCalls = 0;
  const adapter = createRealtimePublicControlT11bT02Adapter({
    ...base.options,
    handoffAuthority: { async handoff() { authorityCalls += 1; return result; } },
    handoffTerminalCodec: { async encode() { return result; } },
    handoffReplay: {
      async claim() { return { disposition: 'replay', result }; },
      async suppressAndClose() { throw new Error('REPLAY_SUPPRESSION_MUST_NOT_RUN'); },
      async commit() { commitCalls += 1; },
      async release() { throw new Error('REPLAY_RELEASE_MUST_NOT_RUN'); },
    },
  });
  const replay = await adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(replay, result);
  assert.equal(authorityCalls, 0);
  assert.equal(commitCalls, 0);
  await adapter.close();
});

test('handoff replay claims before current-binding so a switched current lease cannot break duplicate replay', async () => {
  const base = makeHarness();
  const wire = handoffWire('handoff-current-switch-1');
  const result = handoffTerminal(wire);
  let current = CURRENT_BINDING;
  let currentCalls = 0;
  let authorityCalls = 0;
  let suppressionCalls = 0;
  let firstFingerprint: string | undefined;
  let firstClaim = true;
  const adapter = createRealtimePublicControlT11bT02Adapter({
    ...base.options,
    currentBinding: {
      async resolve() { currentCalls += 1; return { binding: current, continuityExpiresAt: CONTINUITY_EXPIRES, leaseVersion: assertDecimalCounter('9') }; },
    },
    handoffAuthority: { async handoff() { authorityCalls += 1; return result; } },
    handoffTerminalCodec: { async encode() { return result; } },
    handoffOutputFence: {
      async claim(input) {
        if (firstClaim) { firstClaim = false; firstFingerprint = input.fingerprint; return { disposition: 'claimed', claimId: 'claim-current-switch-1' }; }
        if (input.fingerprint === firstFingerprint) return { disposition: 'replay', result };
        return { disposition: 'conflict' };
      },
      async suppressAndClose() { suppressionCalls += 1; return handoffSuppression(wire, result); },
      async commit() {},
      async release() { throw new Error('SWITCH_RELEASE_MUST_NOT_RUN'); },
    },
  });
  const first = await adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  current = { ...NEXT_BINDING, state: 'connected' };
  const replay = await adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE });
  assert.deepEqual(replay, first);
  assert.equal(currentCalls, 1);
  assert.equal(authorityCalls, 1);
  assert.equal(suppressionCalls, 1);
  const drift = { ...wire, current_device_lease_ref: LEASE_REF_2 };
  await assert.rejects(adapter.sessions.handoff!({ request: drift, bearer: BEARER, governance: GOVERNANCE }), /HANDOFF_IDEMPOTENCY_CONFLICT/);
  assert.equal(currentCalls, 1);
  assert.equal(authorityCalls, 1);
  assert.equal(suppressionCalls, 1);
  await adapter.close();
});

test('handoff requires the T01 terminal codec before claim, authority, or suppression', async () => {
  const base = makeHarness();
  const wire = handoffWire('handoff-codec-required-1');
  let claims = 0;
  let authorityCalls = 0;
  let suppressionCalls = 0;
  const adapter = createRealtimePublicControlT11bT02Adapter({
    ...base.options,
    handoffAuthority: { async handoff() { authorityCalls += 1; return handoffTerminal(wire); } },
    handoffOutputFence: {
      async claim() { claims += 1; return { disposition: 'claimed', claimId: 'codec-required-1' }; },
      async suppressAndClose() { suppressionCalls += 1; return {}; },
      async commit() {},
      async release() {},
    },
  });
  await assert.rejects(adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE }), /HANDOFF_TERMINAL_CODEC_REQUIRED/);
  assert.equal(claims, 0);
  assert.equal(authorityCalls, 0);
  assert.equal(suppressionCalls, 0);
  await adapter.close();
});

test('handoff may release a durable claim when current-binding fails before authority starts', async () => {
  const base = makeHarness();
  const wire = handoffWire('handoff-pre-authority-failure-1');
  let releases = 0;
  let authorityCalls = 0;
  const adapter = createRealtimePublicControlT11bT02Adapter({
    ...base.options,
    currentBinding: { async resolve() { throw new Error('CURRENT_BINDING_PRE_AUTHORITY'); } },
    handoffAuthority: { async handoff() { authorityCalls += 1; return handoffTerminal(wire); } },
    handoffTerminalCodec: { async encode() { return handoffTerminal(wire); } },
    handoffOutputFence: {
      async claim() { return { disposition: 'claimed', claimId: 'pre-authority-failure-1' }; },
      async suppressAndClose() { throw new Error('MUST_NOT_SUPPRESS'); },
      async commit() { throw new Error('MUST_NOT_COMMIT'); },
      async release() { releases += 1; },
    },
  });
  await assert.rejects(adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE }), /CURRENT_BINDING_PRE_AUTHORITY/);
  assert.equal(releases, 1);
  assert.equal(authorityCalls, 0);
  await adapter.close();
});

test('handoff keeps the durable claim pending after authority, suppression, codec, or validation uncertainty', async () => {
  const base = makeHarness();
  const postAuthorityCases = [
    ['suppression failure', async () => {
      let authorityCalls = 0;
      let suppressionCalls = 0;
      let releases = 0;
      let claimCalls = 0;
      const wire = handoffWire('handoff-suppression-failure');
      const adapter = createRealtimePublicControlT11bT02Adapter({
        ...base.options,
        handoffAuthority: { async handoff() { authorityCalls += 1; return handoffTerminal(wire); } },
        handoffTerminalCodec: { async encode() { return handoffTerminal(wire); } },
        handoffOutputFence: {
          async claim() { claimCalls += 1; return claimCalls === 1 ? { disposition: 'claimed', claimId: 'claim-suppression-failure' } : { disposition: 'in_flight' }; },
          async suppressAndClose() { suppressionCalls += 1; throw new Error('SUPPRESSION_UNKNOWN'); },
          async commit() { throw new Error('MUST_NOT_COMMIT'); },
          async release() { releases += 1; },
        },
      });
      await assert.rejects(adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE }), /SUPPRESSION_UNKNOWN/);
      assert.equal(authorityCalls, 1); assert.equal(suppressionCalls, 1); assert.equal(releases, 0);
      await assert.rejects(adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE }), /HANDOFF_IN_FLIGHT/);
      assert.equal(authorityCalls, 1); assert.equal(suppressionCalls, 1);
      await adapter.close();
    }],
    ['suppression indeterminate', async () => {
      let releases = 0;
      const wire = handoffWire('handoff-suppression-indeterminate');
      const terminal = handoffTerminal(wire);
      const adapter = createRealtimePublicControlT11bT02Adapter({
        ...base.options,
        handoffAuthority: { async handoff() { return terminal; } },
        handoffTerminalCodec: { async encode() { return terminal; } },
        handoffOutputFence: {
          async claim() { return { disposition: 'claimed', claimId: 'claim-suppression-indeterminate' }; },
          async suppressAndClose() { return handoffSuppression(wire, terminal, 'indeterminate'); },
          async commit() { throw new Error('MUST_NOT_COMMIT'); },
          async release() { releases += 1; },
        },
      });
      await assert.rejects(adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE }), /SUPPRESSION_INDETERMINATE/);
      assert.equal(releases, 0);
      await adapter.close();
    }],
    ['codec failure', async () => {
      let releases = 0;
      const wire = handoffWire('handoff-codec-failure');
      const terminal = handoffTerminal(wire);
      const adapter = createRealtimePublicControlT11bT02Adapter({
        ...base.options,
        handoffAuthority: { async handoff() { return terminal; } },
        handoffTerminalCodec: { async encode() { throw new Error('CODEC_UNKNOWN'); } },
        handoffOutputFence: {
          async claim() { return { disposition: 'claimed', claimId: 'claim-codec-failure' }; },
          async suppressAndClose() { return handoffSuppression(wire, terminal); },
          async commit() { throw new Error('MUST_NOT_COMMIT'); },
          async release() { releases += 1; },
        },
      });
      await assert.rejects(adapter.sessions.handoff!({ request: wire, bearer: BEARER, governance: GOVERNANCE }), /CODEC_UNKNOWN/);
      assert.equal(releases, 0);
      await adapter.close();
    }],
  ] as const;
  for (const [, run] of postAuthorityCases) await run();
});

test('close is idempotent, closes each owned port once, rejects new work, and fences a late completion', async () => {
  let releaseReadiness: (() => void) | undefined;
  const readiness = new Promise<void>((resolve) => { releaseReadiness = resolve; });
  const h = makeHarness({ readiness: () => readiness });
  const pending = h.adapter.sessions.bootstrap({ request: initialWire(), bearer: BEARER, governance: GOVERNANCE });
  await Promise.resolve();
  const first = h.adapter.close();
  const second = h.adapter.close();
  releaseReadiness?.();
  await Promise.all([first, second]);
  assert.equal(h.closeCount(), 7);
  await assert.rejects(pending, /LATE_COMPLETION_FENCED/);
  await assert.rejects(h.adapter.sessions.bootstrap({ request: initialWire('after-close'), bearer: BEARER, governance: GOVERNANCE }), /ADAPTER_CLOSED/);
});


test('public operation effect boundary proves bootstrap/stop preflight rejection but marks unknown inner claims before invocation',async()=>{
 for(const operation of ['bootstrap','media_stop'] as const){
  const f=makeHarness({readiness:()=>false});let started=0;
  await assert.rejects(operation==='bootstrap'?f.adapter.sessions.bootstrap({request:initialWire(),bearer:BEARER,governance:GOVERNANCE,effectStarted:()=>{started++;}}):f.adapter.mediaStop.claim({request:stopWire(),bearer:BEARER,governance:GOVERNANCE,effectStarted:()=>{started++;}}),/CANONICAL_ISSUER_NOT_READY/);
  assert.equal(started,0);assert(!f.events.some(x=>x.startsWith('projection')||x==='claim'||x.startsWith('cloud')));
 }
 const f=makeHarness();let started=0;
 f.options.projection.bootstrap=async()=>{assert.equal(started,1);throw new Error('UNPROVEN_PG_ERROR');};
 const adapter=createRealtimePublicControlT11bT02Adapter(f.options);
 assert.equal(adapter.sessions.publicOperationEffectBoundary,'v1');
 await assert.rejects(adapter.sessions.bootstrap({request:initialWire(),bearer:BEARER,governance:GOVERNANCE,effectStarted:()=>{started++;}}),/UNPROVEN_PG_ERROR/);
 const stopped=makeHarness({claim:{disposition:'in_flight'}});started=0;
 await assert.rejects(stopped.adapter.mediaStop.claim({request:stopWire(),bearer:BEARER,governance:GOVERNANCE,effectStarted:()=>{started++;}}),/IDEMPOTENCY_IN_FLIGHT/);assert.equal(started,1);
});


test('actual PG complete owner consumes original adapter no-effect and unknown boundaries for all three public operations',{skip:!process.env.DEVICE_RECEIPTS_PG_URL,timeout:60000},async()=>{
 const schema='operation_source_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:process.env.DEVICE_RECEIPTS_PG_URL}),pool=new Pool({connectionString:process.env.DEVICE_RECEIPTS_PG_URL,options:'-c search_path='+schema});
 try {
  await admin.query('CREATE SCHEMA '+schema);const migration=await readFile(new URL('../../../migrations/0001_idempotency_outbox.up.sql',import.meta.url),'utf8');await pool.query(migration.slice(0,migration.indexOf('CREATE TABLE IF NOT EXISTS outbox_events'))+'COMMIT;');
  let ready=false;const owner=createRealtimePublicOperationReceipts(pool),base=makeHarness({readiness:()=>ready});
  for(const [method,wire] of [['bootstrap',initialWire('source-bootstrap')],['claim',stopWire('source-stop')],['handoff',handoffWire('source-handoff')]] as const){
   const input={request:wire,bearer:BEARER};
   const run=(begin:()=>void)=>method==='bootstrap'?base.adapter.sessions.bootstrap({request:wire,bearer:BEARER,governance:GOVERNANCE,effectStarted:begin}):method==='claim'?base.adapter.mediaStop.claim({request:wire,bearer:BEARER,governance:GOVERNANCE,effectStarted:begin}):base.adapter.sessions.handoff!({request:wire,bearer:BEARER,governance:GOVERNANCE,effectStarted:begin});
   await assert.rejects(owner.execute(input,async begin=>await run(begin) as unknown as JsonRecord,undefined,'v1'),e=>(e as {operation_outcome:string}).operation_outcome==='not_executed');assert.equal((await owner.read(input))?.status,'failed');
   await assert.rejects(createRealtimePublicOperationReceipts(pool).execute(input,async()=>{throw new Error('REEXECUTED');}),e=>(e as {operation_outcome:string}).operation_outcome==='not_executed');
  }
  assert(!base.events.some(x=>x==='claim'||x.startsWith('projection')||x.startsWith('cloud')));
  ready=true;const recoveredWire=initialWire('source-bootstrap'),recoveredInput={request:recoveredWire,bearer:BEARER};const recovered=await owner.execute(recoveredInput,async begin=>await base.adapter.sessions.bootstrap({request:recoveredWire,bearer:BEARER,governance:GOVERNANCE,effectStarted:begin}) as unknown as JsonRecord,async()=>{},'v1','not_executed_v1');assert.equal((await owner.read(recoveredInput))?.status,'committed');assert.equal(base.bootstrapCommands.length,1);assert.deepEqual(await owner.execute(recoveredInput,async()=>{throw new Error('SUCCESS_REEXECUTED');}),recovered);
  const unknown=makeHarness(),wire=initialWire('source-unknown');unknown.options.projection.bootstrap=async()=>{throw new Error('UNPROVEN_INNER_PG_ERROR');};const adapter=createRealtimePublicControlT11bT02Adapter(unknown.options);
  await assert.rejects(owner.execute({request:wire,bearer:BEARER},async begin=>await adapter.sessions.bootstrap({request:wire,bearer:BEARER,governance:GOVERNANCE,effectStarted:begin}) as unknown as JsonRecord,undefined,'v1'),e=>(e as {operation_outcome:string}).operation_outcome==='unknown');assert.equal((await owner.read({request:wire,bearer:BEARER}))?.status,'indeterminate');
 } finally {await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');const remaining=(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows.length;assert.equal(remaining,0);console.log(JSON.stringify({schema,cleanup_readback_remaining:remaining,host:'127.0.0.1',port:55439,database:'postgres',role:'l3test'}));await admin.end();}
});
