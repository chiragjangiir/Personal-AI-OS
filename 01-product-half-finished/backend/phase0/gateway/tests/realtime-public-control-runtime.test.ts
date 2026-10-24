import { createRealtimePublicControlSelfHostedCloudProjection } from '../src/realtime-public-control-self-hosted-cloud-projection.ts';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { Pool } = createRequire(new URL('../../../services/platform-data/package.json', import.meta.url))('pg');
import { readFile } from 'node:fs/promises';
import { createRealtimePublicOperationReceipts } from '../../../services/platform-data/src/realtime-public-operation-receipts.ts';
import test from 'node:test';
import {createRealtimeSchemaRegistry} from '../src/realtime-public-control-controller.ts';
import {LocalSpeechEngine} from '../../../services/personal-aios-integration/src/voiceprint/engine.ts';
import {realModelsPresent,realSpeechConfig} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  RealtimePublicControlRuntime,
  type JsonRecord,
  type RealtimeBootstrapAuthorityResult,
  type RealtimeBootstrapConnectedPort, type RealtimeBootstrapConnectedInput,
  type RealtimeCredentialFenceAdmissionPort,
  type RealtimeCredentialFenceTuple,
  type RealtimePublicControlRuntimeOptions,
} from '../src/realtime-public-control-runtime.ts';
import { LiveKitCloudParticipant, type LiveKitCloudParticipantPort, type LiveKitCloudRoomPort } from '../src/livekit-cloud-participant.ts';
import { EventEmitter } from 'node:events';
import type { LiveKitCloudGrantInput, LiveKitCloudTokenInput, LiveKitCloudTokenSignerPort } from '../src/livekit-cloud-token-signer.ts';
import { createProductionBootstrapConnectedOwner, createRuntimeCredentialFenceAdmission } from '../src/realtime-public-control-pg-composition.ts';
import { createRealtimeCredentialFence } from '../../../services/platform-data/src/realtime-credential-fence.ts';

const REF = Object.freeze({ ref_type: 'RealtimeSession', ref_id: '018f0000-0000-7000-8000-000000000001', object_version: '1', canonical_payload_sha256: 'a'.repeat(64) });
const REF2 = Object.freeze({ ref_type: 'RealtimeSession', ref_id: '018f0000-0000-7000-8000-000000000003', object_version: '2', canonical_payload_sha256: 'c'.repeat(64) });
const LEASE = Object.freeze({ ref_type: 'DeviceLease', ref_id: '018f0000-0000-7000-8000-000000000004', object_version: '1', canonical_payload_sha256: 'b'.repeat(64) });
const LEASE2 = Object.freeze({ ref_type: 'DeviceLease', ref_id: '018f0000-0000-7000-8000-000000000005', object_version: '2', canonical_payload_sha256: 'd'.repeat(64) });
const GOVERNANCE = Object.freeze({ purpose_scopes: ['realtime_assistant'], policy_decision_refs: ['policy-ref'], capability_grant_refs: ['grant-ref'] });
const IDEMPOTENCY = Object.freeze({ idempotency_key: 'request-1', idempotency_profile_id: 'https://personal-ai-os.local/contracts/realtime/idempotency/test', idempotency_profile_version: '1.0.0', idempotency_profile_sha256: '1'.repeat(64), idempotency_request_sha256: '2'.repeat(64), idempotency_scope: { owner_module: 'T11B', operation_kind: 'test', target_object_type: 'RealtimeSession', user_id: '018f0000-0000-7000-8000-000000000001' } });
const DEVICE = 'device-1';
const CONTINUITY = '018f0000-0000-7000-8000-000000000006';
const ALIASES = Object.freeze(['room-alias', 'participant-alias']);
const NEW_ALIASES = Object.freeze(['room-alias-2', 'participant-alias-2']);
const START = Object.freeze({ kind: 'explicit_user_start', device_id: DEVICE, modalities: ['audio', 'video', 'data'], started_at: '2026-08-22T12:00:00Z' });
const REQUESTED = Object.freeze({ audio: true, video: true, data: true });
const BASE_REQUEST = Object.freeze({ operation: 'bootstrap', bootstrap_mode: 'initial', request_id: 'request-1', idempotency_context: IDEMPOTENCY, device_id: DEVICE, start: START, requested_media: REQUESTED, governance: GOVERNANCE });
const PREVIOUS_CONTINUITY_EXPIRES_AT = '2026-08-22T12:30:00Z';
const PREVIOUS_TRANSITION = Object.freeze({
  atomic: true,
  previous_connection_epoch: '1',
  previous_realtime_session_ref: REF,
  previous_device_lease_ref: LEASE,
  previous_transport_aliases: ALIASES,
  previous_continuity_expires_at: PREVIOUS_CONTINUITY_EXPIRES_AT,
  provider_session_reused: false,
} as const);
const REFRESH_REQUEST = Object.freeze({ operation: 'connected_credential_refresh', request_id: 'refresh-1', idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'refresh-1' }, realtime_session_ref: REF, device_lease_ref: LEASE, continuity_id: CONTINUITY, transport_aliases: ALIASES, connection_epoch: '1', refresh_reason: 'sdk_reconnect', governance: GOVERNANCE });
const E2EE_REQUEST = Object.freeze({ operation: 'realtime_e2ee_key_resolve', request_id: 'resolve-1', idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'resolve-1' }, realtime_session_ref: REF, device_lease_ref: LEASE, continuity_id: CONTINUITY, connection_epoch: '1', transport_aliases: ALIASES, key_envelope_ref: { alias_type: 'key_envelope', issuer: 'local_gateway', value: 'key-ref' }, key_index: 0, key_generation: '1', device_id: DEVICE, recipient_device_credential_ref: { ref_type: 'DeviceCredential', ref_id: '018f0000-0000-7000-8000-000000000010', object_version: '1', canonical_payload_sha256: 'e'.repeat(64) }, participant_audience: { alias_type: 'participant', issuer: 'livekit_cloud', value: 'participant-alias' }, governance: GOVERNANCE });
const STOP_REQUEST = Object.freeze({ operation: 'media_stop', request_id: 'stop-1', idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'stop-1' }, realtime_session_ref: REF, device_lease_ref: LEASE, continuity_id: CONTINUITY, transport_aliases: ALIASES, connection_epoch: '1', reason: 'user_stop', release_scope: 'media_device_lease_only', governance: GOVERNANCE });
const HANDOFF_REQUEST = Object.freeze({ operation: 'handoff', request_id: 'handoff-1', idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'handoff-1' }, realtime_session_ref: REF, current_device_lease_ref: LEASE, continuity_id: CONTINUITY, connection_epoch: '1', expected_lease_version: '1', from_device_id: DEVICE, to_device_id: 'device-2', governance: GOVERNANCE });

type RuntimeConfig = {
  readonly operationReceipts?: RealtimePublicControlRuntimeOptions['operationReceipts'];
  readonly participantForDevice?: RealtimePublicControlRuntimeOptions['participantForDevice'];
  readonly rejectCurrentState?: () => boolean;
  readonly ciphertextResult?: JsonRecord;
  readonly bootstrapResults?: readonly RealtimeBootstrapAuthorityResult[];
  /** Binding the gateway participant still serves from an earlier session (supersede tests). */
  readonly heldParticipantBinding?: import('../src/livekit-cloud-participant.ts').LiveKitCloudParticipantBinding;
  readonly refreshResult?: Partial<RealtimeBootstrapAuthorityResult> & { readonly credential_input?: LiveKitCloudTokenInput; readonly credential_generation?: string; readonly credential_expires_at?: string; readonly requested_media?: { readonly audio: boolean; readonly video: boolean; readonly data: boolean } };
  readonly terminalGrantOverride?: Partial<LiveKitCloudGrantInput>;
  readonly gatewayGrantOverride?: Partial<LiveKitCloudGrantInput>;
  readonly mediaGrantOverride?: JsonRecord;
  readonly stopResult?: JsonRecord;
  readonly alreadyCompleted?: JsonRecord;
  readonly endResult?: JsonRecord;
  readonly envelopeOverride?: JsonRecord;
  readonly envelopeRoomOptions?: object;
  readonly omitEnvelopeRelease?: boolean;
  readonly participantConnectFails?: boolean;
  readonly participantConnectGate?:()=>Promise<void>;
  readonly participantConnected?:()=>boolean;
  readonly closeFailures?: readonly string[];
  readonly serverUrl?: string;
  readonly signerProjectUrl?: string;
  readonly handoffResult?: JsonRecord;
  readonly bootstrapConnected?: RealtimeBootstrapConnectedPort;
  readonly credentialFenceAdmission?: RealtimeCredentialFenceAdmissionPort;
  readonly recordSigns?: boolean;
  readonly captureReconnectGuard?: boolean;
  /** The default participant already carries its borrowed owner's reconnect guard. */
  readonly ownerReconnectGuard?: boolean;
  readonly events?: string[];
  readonly credentialFailure?: boolean;
  readonly credentialResult?: unknown;
  /** Awaited inside the owner call: a never-settling gate is a process that died mid-operation. */
  readonly bootstrapGate?: () => Promise<void>;
  readonly signGate?: (input: LiveKitCloudTokenInput) => Promise<void>;
  readonly stopClaimGate?: () => Promise<void>;
};

function mediaGrant(enabled: boolean, _modality: 'audio' | 'video' | 'data', request: JsonRecord, lease: unknown): JsonRecord {
  if (!enabled) return { enabled: false };
  const requested = ((request.requested_media as Record<string, boolean> | undefined) ?? REQUESTED) as Record<string, boolean>;
  const modalities = ['audio', 'video', 'data'].filter((modality) => requested[modality] === true);
  return { enabled: true, device_id: request.device_id, device_lease_ref: lease, start_binding: { kind: 'explicit_user_start', device_id: request.device_id, modalities }, expires_at: '2026-08-22T12:14:00Z' };
}

function makeAuthority(request: JsonRecord, refs: { session: unknown; lease: unknown; epoch: string; aliases: readonly unknown[] } | undefined = undefined, config: RuntimeConfig = {}): RealtimeBootstrapAuthorityResult {
  const bindingRefs = refs ?? { session: REF, lease: LEASE, epoch: '1', aliases: ALIASES };
  const requested = (request.requested_media as Record<string, boolean> | undefined) ?? REQUESTED;
  const media = { audio: mediaGrant(requested.audio === true, 'audio', request, bindingRefs.lease), video: mediaGrant(requested.video === true, 'video', request, bindingRefs.lease), data: mediaGrant(requested.data === true, 'data', request, bindingRefs.lease), ...(config.mediaGrantOverride ?? {}) };
  const terminalGrants: LiveKitCloudGrantInput = { room: 'terminal-room', roomJoin: true, canPublish: requested.audio === true || requested.video === true, canSubscribe: true, canPublishData: requested.data === true, canPublishSources: [...(requested.audio === true ? ['microphone' as const] : []), ...(requested.video === true ? ['camera' as const] : [])], ...config.terminalGrantOverride };
  const gatewayGrants: LiveKitCloudGrantInput = { room: 'gateway-room', roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: requested.data === true, canPublishSources: [], ...config.gatewayGrantOverride };
  return { realtime_session_ref: bindingRefs.session, device_lease_ref: bindingRefs.lease, continuity_id: CONTINUITY, transport_aliases: bindingRefs.aliases, connection_epoch: bindingRefs.epoch, server_url: config.serverUrl ?? 'wss://project.livekit.cloud', credential_expires_at: '2026-08-22T12:15:00Z', continuity_expires_at: '2026-08-22T12:30:00Z', terminal_room_name: 'terminal-room', terminal_identity: 'terminal-identity', terminal_grants: terminalGrants, media_grants: media, governance: GOVERNANCE, gateway: { roomName: 'gateway-room', identity: 'gateway-identity', grants: gatewayGrants, roomOptions: { encryption: { keyProviderOptions: {} } } } };
}

function terminalResult(request: JsonRecord, status: 'success' | 'indeterminate' = 'success'): JsonRecord {
  const success = status === 'success';
  return { operation: 'media_stop', status, request_id: request.request_id, realtime_session_ref: request.realtime_session_ref, device_lease_ref: request.device_lease_ref, continuity_id: request.continuity_id, connection_epoch: request.connection_epoch, operation_outcome: success ? { outcome_class: 'committed_success', recorded_result_ref: { idempotency_context: request.idempotency_context, fencing_epoch: '1', outcome_class: 'committed_success', result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json', result_schema_version: '1.0.0', result_schema_sha256: '3'.repeat(64), result_payload_sha256: '4'.repeat(64) }, resolution_mode: 'direct' } : { outcome_class: 'indeterminate', error: { error_family: 'provider', error_code: 'provider.cleanup_indeterminate', retry_class: 'never', trace_id: '018f0000-0000-7000-8000-000000000011', occurred_at: '2026-08-22T12:00:00Z' } }, execution_facts: success ? { closure_status: 'verified_closed', device_lease_release: 'released', participant_cleanup: 'verified_absent', track_cleanup: 'verified_absent', room_cleanup: 'verified_absent' } : { closure_status: 'indeterminate', device_lease_release: 'indeterminate', participant_cleanup: 'indeterminate', track_cleanup: 'indeterminate', room_cleanup: 'indeterminate' }, governance: request.governance };
}

function handoffTerminal(request: JsonRecord, status: 'success' | 'indeterminate' = 'success'): JsonRecord {
  if (status === 'indeterminate') return {
    operation: 'handoff', status, request_id: request.request_id,
    realtime_session_ref: request.realtime_session_ref, previous_device_lease_ref: request.current_device_lease_ref,
    continuity_id: request.continuity_id, connection_epoch: request.connection_epoch,
    from_device_id: request.from_device_id, to_device_id: request.to_device_id,
    operation_outcome: { outcome_class: 'indeterminate', error: { error_family: 'provider', error_code: 'provider.handoff_unknown', retry_class: 'never', trace_id: '018f0000-0000-7000-8000-000000000011', occurred_at: '2026-08-22T12:00:00Z' } },
    execution_facts: { closure_status: 'indeterminate', device_lease_release: 'indeterminate' }, governance: request.governance,
  };
  const nextLease = LEASE2;
  return {
    operation: 'handoff', status, request_id: request.request_id,
    realtime_session_ref: request.realtime_session_ref, device_lease_ref: nextLease,
    previous_device_lease_ref: request.current_device_lease_ref, continuity_id: request.continuity_id,
    connection_epoch: request.connection_epoch, from_device_id: request.from_device_id, to_device_id: request.to_device_id,
    lease_version: '2', fencing_token: '2',
    old_device_suppression_fence: { from_device_id: request.from_device_id, previous_device_lease_ref: request.current_device_lease_ref, new_device_lease_ref: nextLease, connection_epoch: request.connection_epoch, fencing_token: '2', state: 'old_device_suppressed' },
    operation_outcome: { outcome_class: 'committed_success', resolution_mode: 'direct', recorded_result_ref: { idempotency_context: request.idempotency_context, fencing_epoch: '2', outcome_class: 'committed_success', result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json', result_schema_version: '1.0.0', result_schema_sha256: '3'.repeat(64), result_payload_sha256: '4'.repeat(64) } },
    execution_facts: { closure_status: 'verified_closed', device_lease_release: 'released', evidence_refs: [{ evidence_ref: 'handoff-evidence' }] },
    governance: request.governance,
  };
}

function makeRuntime(config: RuntimeConfig = {}) {
  const signed: LiveKitCloudTokenInput[] = [];
  let connects = 0;
  const connectedProjectUrls: string[] = [];
  let participantDisconnects = 0;
  let participantClosed = 0;
  let e2eeClosed = 0;
  let mediaStopClosed = 0;
  let sessionsClosed = 0;
  let ciphertextClosed = 0;
  let signerClosed = 0;
  let e2eeIssued = 0;
  let credentialCalls = 0;
  const releaseEvents: number[] = [];
  let endCalls = 0;
  let handoffCalls = 0;
  let stopCalls = 0;
  let stopRequest: JsonRecord | undefined;
  let reconnectGuard: ((binding: import('../src/livekit-cloud-participant.ts').LiveKitCloudParticipantBinding) => Promise<void>) | undefined = config.ownerReconnectGuard ? OWNER_RECONNECT_GUARD : undefined;
  const bootstrapQueue = [...(config.bootstrapResults ?? [])];
  const participant: LiveKitCloudParticipantPort = {
    async connect(input) { connectedProjectUrls.push(input.projectUrl); config.events?.push('participant.connect'); connects += 1; await config.participantConnectGate?.(); if (config.participantConnectFails === true) throw new Error('CONNECT_FAILED'); },
    async disconnect() { config.events?.push('participant.disconnect'); participantDisconnects += 1; },
    snapshot: () => {const connected=config.participantConnected?.()??true;return {connected,transportState:connected?'connected':'disconnected'};},
    ...(config.heldParticipantBinding === undefined ? {} : { bindingSnapshot: () => config.heldParticipantBinding }),
    ...(config.captureReconnectGuard ? { setReconnectAdmissionGuard(value: NonNullable<LiveKitCloudParticipantPort['setReconnectAdmissionGuard']> extends (guard: infer T) => void ? T : never) {
      if (reconnectGuard !== undefined && reconnectGuard !== value) throw new Error('LIVEKIT_PARTICIPANT_RECONNECT_GUARD_ALREADY_BOUND');
      reconnectGuard = value; } } : {}),
    async close() { participantClosed += 1; if (config.closeFailures?.includes('participant')) throw new Error('PARTICIPANT_CLOSE_FAILED'); },
  };
  const tokenSigner: LiveKitCloudTokenSignerPort = { assertProjectUrl(projectUrl) { if (projectUrl !== (config.signerProjectUrl ?? 'wss://project.livekit.cloud')) throw new Error('PROJECT_BINDING_MISMATCH'); }, async sign(input) { if (config.recordSigns) config.events?.push('sign'); signed.push(input); await config.signGate?.(input); return `token-${signed.length}`; }, close() { signerClosed += 1; if (config.closeFailures?.includes('token_signer')) throw new Error('SIGNER_CLOSE_FAILED'); } };
  const options: RealtimePublicControlRuntimeOptions = {
    ...(config.operationReceipts === undefined ? {} : { operationReceipts: config.operationReceipts }),
    governance: { async evaluate() { return { accepted: config.rejectCurrentState?.() !== true, refs: GOVERNANCE }; } },
    sessions: {
      async bootstrap(input) { input.effectStarted?.(); await config.bootstrapGate?.(); return bootstrapQueue.shift() ?? makeAuthority(input.request, undefined, config); },
      async refresh() { const base = makeAuthority(BASE_REQUEST); return { realtime_session_ref: config.refreshResult?.realtime_session_ref ?? base.realtime_session_ref, device_lease_ref: config.refreshResult?.device_lease_ref ?? base.device_lease_ref, continuity_id: config.refreshResult?.continuity_id ?? base.continuity_id, transport_aliases: config.refreshResult?.transport_aliases ?? base.transport_aliases, connection_epoch: config.refreshResult?.connection_epoch ?? base.connection_epoch, credential_expires_at: config.refreshResult?.credential_expires_at ?? '2026-08-22T12:14:59Z', credential_generation: config.refreshResult?.credential_generation ?? '2', credential_input: config.refreshResult?.credential_input ?? { room: 'terminal-room', identity: 'terminal-identity', ttlSeconds: 898, grants: base.terminal_grants }, governance: config.refreshResult?.governance ?? GOVERNANCE, ...(config.refreshResult?.requested_media === undefined ? {} : { requested_media: config.refreshResult.requested_media }) }; },
      async endContinuity(input) { endCalls += 1; return config.endResult ?? { operation: 'end_continuity', request_id: input.request.request_id, status: 'success' }; },
      async handoff(input) { handoffCalls += 1; return config.handoffResult ?? handoffTerminal(input.request); },
      async close() { sessionsClosed += 1; if (config.closeFailures?.includes('sessions')) throw new Error('SESSIONS_CLOSE_FAILED'); },
    },
    mediaStop: {
      async claim(input) { input.effectStarted?.(); await config.stopClaimGate?.(); stopRequest = input.request; return { claimId: 'claim-1', ...(config.alreadyCompleted === undefined ? {} : { alreadyCompleted: config.alreadyCompleted }) }; },
      async unpublishAllTracks() { stopCalls += 1; }, async disconnectParticipant() { stopCalls += 1; }, async revokeCredential() { stopCalls += 1; }, async verifyMediaClosed() { stopCalls += 1; },
      async complete() { return config.stopResult ?? terminalResult(stopRequest ?? STOP_REQUEST); }, async close() { mediaStopClosed += 1; if (config.closeFailures?.includes('media_stop')) throw new Error('MEDIA_STOP_CLOSE_FAILED'); },
    },
    e2ee: {
      async issue(input) { const issued = ++e2eeIssued; return { envelope: { key_envelope_ref: { alias_type: 'key_envelope', issuer: 'local_gateway', value: 'key-ref' }, key_index: 0, key_generation: '1', expires_at: '2026-08-22T12:10:00Z', scope: { device_id: DEVICE, channels: ['audio', 'video', 'data'], distribution_mode: 'application_controlled_envelope' }, realtime_session_ref: input.realtimeSessionRef, continuity_id: input.continuityId, governance: GOVERNANCE, ...(config.envelopeOverride ?? {}) }, roomOptions: config.envelopeRoomOptions ?? { encryption: { keyProviderOptions: {} } }, ...(config.omitEnvelopeRelease === true ? {} : { release: () => { releaseEvents.push(issued); } }) }; },
      close() { e2eeClosed += 1; if (config.closeFailures?.includes('e2ee')) throw new Error('E2EE_CLOSE_FAILED'); },
    },
    e2eeCiphertext: {
      async resolve(input) {
        const request = input.request;
        const success = { operation: 'realtime_e2ee_key_resolve', status: 'key_resolved', request_id: request.request_id, idempotency_context: request.idempotency_context, realtime_session_ref: request.realtime_session_ref, device_lease_ref: request.device_lease_ref, continuity_id: request.continuity_id, connection_epoch: request.connection_epoch, transport_aliases: request.transport_aliases, key_envelope_ref: request.key_envelope_ref, key_index: request.key_index, key_generation: request.key_generation, device_id: request.device_id, recipient_device_credential_ref: request.recipient_device_credential_ref, participant_audience: request.participant_audience, expires_at: '2026-08-22T12:10:00Z', cipher_suite: 'DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM', encapsulated_key: 'fixture_encapsulated_key', ciphertext: 'fixture_ciphertext', aad_sha256: 'c'.repeat(64), governance: request.governance };
        return config.ciphertextResult === undefined ? success : { ...success, ...config.ciphertextResult };
      }, async close() { ciphertextClosed += 1; if (config.closeFailures?.includes('e2ee_ciphertext')) throw new Error('CIPHERTEXT_CLOSE_FAILED'); },
    }, tokenSigner, participant,
    ...(config.participantForDevice === undefined ? {} : { participantForDevice: config.participantForDevice }),
    deviceCredential: {
      async resolve() {
        credentialCalls += 1;
        config.events?.push('device_credential');
        if (config.credentialFailure === true) throw new Error('DEVICE_CREDENTIAL_FAILED');
        if (Object.hasOwn(config, 'credentialResult')) return config.credentialResult as never;
        return E2EE_REQUEST.recipient_device_credential_ref as JsonRecord;
      },
    },
    ...(config.bootstrapConnected === undefined ? {} : { bootstrapConnected: config.bootstrapConnected }),
    ...(config.credentialFenceAdmission === undefined ? {} : { credentialFenceAdmission: config.credentialFenceAdmission }),
    now: () => Date.parse('2026-08-22T12:00:00Z'),
  };
  return { runtime: new RealtimePublicControlRuntime(options), state: { signed, connectedProjectUrls, connects: () => connects, participantDisconnects: () => participantDisconnects, reconnectGuard: () => reconnectGuard, participantClosed: () => participantClosed, e2eeClosed: () => e2eeClosed, mediaStopClosed: () => mediaStopClosed, sessionsClosed: () => sessionsClosed, ciphertextClosed: () => ciphertextClosed, signerClosed: () => signerClosed, endCalls: () => endCalls, handoffCalls: () => handoffCalls, credentialCalls: () => credentialCalls, stopCalls: () => stopCalls, releaseEvents } };
}

function admissionHarness(options: { readonly deny?: boolean; readonly timeout?: boolean } = {}) {
  const events: string[] = [];
  const tuples: RealtimeCredentialFenceTuple[] = [];
  let reconnectCalls = 0;
  let closes = 0;
  let denied = options.deny === true;
  let timedOut = options.timeout === true;
  const admission: RealtimeCredentialFenceAdmissionPort = {
    async withAdmission<T>(tuple: RealtimeCredentialFenceTuple, callback: () => Promise<T>): Promise<T> {
      tuples.push(tuple);
      events.push(`admission:${tuple.credentialGeneration}`);
      if (denied) throw new Error('CREDENTIAL_FENCE_DENIED');
      if (timedOut) throw new Error('CREDENTIAL_FENCE_TIMEOUT');
      events.push('admission.callback');
      const result = await callback();
      events.push('admission.complete');
      return result;
    },
    async verifyReconnect(tuple) {
      reconnectCalls += 1;
      events.push(`reconnect:${tuple.credentialGeneration}`);
    },
    close() { closes += 1; },
  };
  return {
    admission, events, tuples, reconnectCalls: () => reconnectCalls, closes: () => closes,
    setDenied: (value: boolean) => { denied = value; },
    setTimedOut: (value: boolean) => { timedOut = value; },
  };
}

const bearer = { principal: 'user', deviceId: DEVICE };
const OWNER_RECONNECT_GUARD = async (): Promise<void> => undefined;

// Isolated bootstrap latency: real speech warmup, synthetic authority/signing/E2EE/participant, no listener or network.
// Run alone in a fresh Node process; this does not measure production PG, LiveKit connect, nginx or phone latency.
test('process-cold speech readiness precedes the first runtime bootstrap operation',
  {skip:!realModelsPresent},async t=>{
    const started=performance.now();const engine=await LocalSpeechEngine.open(realSpeechConfig);
    const speech_load_ms=performance.now()-started;t.after(()=>engine.close());
    let hooks=0;const events:string[]=[];
    const composed=performance.now();const h=makeRuntime({events,recordSigns:true,
      bootstrapConnected:{onBootstrapConnected:async()=>{hooks++;assert.equal(engine.available(),true);}}});
    const runtime_composition_ms=performance.now()-composed;t.after(()=>h.runtime.close());
    const requestStarted=performance.now();const result=await h.runtime.bootstrap(BASE_REQUEST,bearer);
    const first_bootstrap_ms=performance.now()-requestStarted;
    assert.equal(result.operation,'bootstrap');assert.equal(hooks,1);assert.equal(h.state.connects(),1);
    assert.deepEqual(events,['device_credential','sign','sign','participant.connect']);
    process.stdout.write(JSON.stringify({cold_runtime_bootstrap:{speech_load_ms,runtime_composition_ms,first_bootstrap_ms,
      hooks,signs:h.state.signed.length,connects:h.state.connects(),scope:'real-speech-synthetic-authority-token-e2ee-participant-no-http-pg-network'}})+'\n');
});


test('credential admission fences bootstrap signing and connect with the authoritative generation', async () => {
  const events: string[] = [];
  const fence = admissionHarness();
  const authority = { ...makeAuthority(BASE_REQUEST), credential_generation: '1' };
  const h = makeRuntime({
    bootstrapResults: [authority], credentialFenceAdmission: fence.admission,
    events, recordSigns: true, captureReconnectGuard: true,
  });
  await h.runtime.bootstrap(BASE_REQUEST, bearer);
  assert.deepEqual(events, ['device_credential', 'sign', 'sign', 'participant.connect']);
  assert.deepEqual(fence.events, ['admission:1', 'admission.callback', 'admission.complete']);
  assert.equal(fence.tuples.length, 1);
  assert.deepEqual(fence.tuples[0], {
    sessionRef: REF, leaseRef: LEASE, continuityId: CONTINUITY,
    connectionEpoch: '1', credentialGeneration: '1',
  });
  const reconnect = h.state.reconnectGuard();
  assert.ok(reconnect);
  await reconnect({ realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: CONTINUITY, transportAliases: ALIASES, connectionEpoch: '1' });
  assert.equal(fence.reconnectCalls(), 1);
  assert.equal(fence.events.at(-1), 'reconnect:1');
  await h.runtime.close();
  assert.equal(fence.closes(), 1);
});

test('credential fence denial and timeout happen before token signing or participant connect', async () => {
  for (const mode of ['deny', 'timeout'] as const) {
    const fence = admissionHarness(mode === 'deny' ? { deny: true } : { timeout: true });
    const authority = { ...makeAuthority(BASE_REQUEST), credential_generation: '1' };
    const h = makeRuntime({ bootstrapResults: [authority], credentialFenceAdmission: fence.admission });
    await assert.rejects(
      h.runtime.bootstrap(BASE_REQUEST, bearer),
      mode === 'deny' ? /CREDENTIAL_FENCE_DENIED/u : /CREDENTIAL_FENCE_TIMEOUT/u,
    );
    assert.equal(h.state.signed.length, 0);
    assert.equal(h.state.connects(), 0);
    assert.deepEqual(h.state.releaseEvents, [1]);
    await h.runtime.close();
  }
});

test('per-device runtime construction keeps the reconnect guard a borrowed owner bound on its default participant', () => {
  const h = makeRuntime({ credentialFenceAdmission: admissionHarness().admission, captureReconnectGuard: true, ownerReconnectGuard: true,
    participantForDevice: () => undefined });
  assert.equal(h.state.reconnectGuard(), OWNER_RECONNECT_GUARD);
});

test('the shared production stop fence denies signing/connect and SDK reconnect without transferring ownership', async () => {
  let active = true;
  const client = { release() {}, async query(sql: string) { return { rows: sql.startsWith('SELECT effect_state') && active
    ? [{ effect_state: 'committed', stage_state: {}, fencing_epoch: '1', credential_generation: '1' }] : [] }; } };
  const fence = createRealtimeCredentialFence({ connect: async () => client } as never);
  const authority = { ...makeAuthority(BASE_REQUEST), credential_generation: '1' };
  const replacement = { ...makeAuthority(BASE_REQUEST, { session: REF2, lease: LEASE2, epoch: '1', aliases: NEW_ALIASES }), credential_generation: '1', continuity_id: 'replacement-continuity' };
  const h = makeRuntime({ bootstrapResults: [authority, authority, replacement], credentialFenceAdmission: createRuntimeCredentialFenceAdmission(fence), captureReconnectGuard: true });
  await assert.rejects(h.runtime.bootstrap(BASE_REQUEST, bearer), /CREDENTIAL_FENCE_ACTIVE/);
  assert.equal(h.state.signed.length, 0); assert.equal(h.state.connects(), 0);
  active = false; await h.runtime.bootstrap(BASE_REQUEST, bearer);
  const binding = { realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: CONTINUITY, connectionEpoch: '1', transportAliases: ALIASES };
  await h.state.reconnectGuard()!(binding);
  active = true; await assert.rejects(h.state.reconnectGuard()!(binding), /CREDENTIAL_FENCE_ACTIVE/);
  await assert.rejects(h.runtime.bootstrap({ ...BASE_REQUEST, request_id: 'replacement' }, bearer), /CREDENTIAL_FENCE_ACTIVE/);
  await assert.rejects(h.state.reconnectGuard()!(binding), /REALTIME_RECONNECT_BINDING_UNKNOWN/);
  assert.deepEqual(h.state.releaseEvents, [1, 2, 3]);
  await h.runtime.close();
  assert.equal((await fence.verify({ realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: CONTINUITY, connectionEpoch: '1', credentialGeneration: '1' })).active, true);
  await fence.close();
});

test('refresh admits the returned generation and updates reconnect binding only after signing succeeds', async () => {
  const events: string[] = [];
  const fence = admissionHarness();
  const authority = { ...makeAuthority(BASE_REQUEST), credential_generation: '1' };
  const h = makeRuntime({
    bootstrapResults: [authority], credentialFenceAdmission: fence.admission,
    events, recordSigns: true, captureReconnectGuard: true,
  });
  await h.runtime.bootstrap(BASE_REQUEST, bearer);
  fence.events.length = 0;
  fence.tuples.length = 0;
  events.length = 0;
  const refreshed = await h.runtime.refresh(REFRESH_REQUEST, bearer);
  assert.equal(refreshed.status, 'credential_refreshed');
  assert.deepEqual(events, ['sign']);
  assert.deepEqual(fence.events, ['admission:2', 'admission.callback', 'admission.complete']);
  assert.equal(fence.tuples[0]?.credentialGeneration, '2');
  const reconnect = h.state.reconnectGuard();
  assert.ok(reconnect);
  await reconnect({ realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: CONTINUITY, transportAliases: ALIASES, connectionEpoch: '1' });
  assert.equal(fence.events.at(-1), 'reconnect:2');

  fence.setDenied(true);
  const signedBefore = h.state.signed.length;
  await assert.rejects(h.runtime.refresh(REFRESH_REQUEST, bearer), /CREDENTIAL_FENCE_DENIED/u);
  assert.equal(h.state.signed.length, signedBefore);
  fence.setDenied(false);
  await h.runtime.close();
});

test('refresh deadline covers signing and source readiness without a stage renewal', async t => {
  const signing=Promise.withResolvers<void>(),releaseSign=Promise.withResolvers<void>(),hookEntered=Promise.withResolvers<void>();
  let refreshing=false,signal:AbortSignal|undefined,settled=false;
  const h=makeRuntime({signGate:async()=>{if(refreshing){signing.resolve();await releaseSign.promise;}},
    bootstrapConnected:{onBootstrapConnected:async input=>{if(refreshing){signal=input.readinessSignal;hookEntered.resolve();await new Promise<void>(()=>{});}}}});
  await h.runtime.bootstrap(BASE_REQUEST,bearer);
  t.mock.timers.enable({apis:['setTimeout']});
  refreshing=true;
  const result=h.runtime.refresh(REFRESH_REQUEST,bearer);
  const rejected=assert.rejects(result,{code:'REALTIME_REFRESH_DEADLINE',status:503});
  void result.then(()=>{settled=true;},()=>{settled=true;});
  await signing.promise;t.mock.timers.tick(2000);releaseSign.resolve();await hookEntered.promise;
  assert.ok(signal);assert.equal(signal.aborted,false);
  t.mock.timers.tick(1999);await Promise.resolve();assert.equal(settled,false);
  t.mock.timers.tick(1);await rejected;assert.equal(signal.aborted,true);
  await h.runtime.close();
});

test('refresh deadline fences late signing before hook or reconnect generation changes', async t => {
  const signing=Promise.withResolvers<void>(),releaseSign=Promise.withResolvers<void>();
  const fence=admissionHarness();let refreshing=false,hooks=0;
  const h=makeRuntime({bootstrapResults:[{...makeAuthority(BASE_REQUEST),credential_generation:'1'}],
    credentialFenceAdmission:fence.admission,captureReconnectGuard:true,
    signGate:async()=>{if(refreshing){signing.resolve();await releaseSign.promise;}},
    bootstrapConnected:{onBootstrapConnected:async()=>{hooks++;}}});
  await h.runtime.bootstrap(BASE_REQUEST,bearer);
  t.mock.timers.enable({apis:['setTimeout']});refreshing=true;
  const rejected=assert.rejects(h.runtime.refresh(REFRESH_REQUEST,bearer),{code:'REALTIME_REFRESH_DEADLINE',status:503});
  await signing.promise;t.mock.timers.tick(4000);await rejected;
  releaseSign.resolve();
  // Let the sign continuation encounter the aborted budget before inspecting public reconnect admission.
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(hooks,1);
  await h.state.reconnectGuard()!({realtimeSessionRef:REF,deviceLeaseRef:LEASE,continuityId:CONTINUITY,transportAliases:ALIASES,connectionEpoch:'1'});
  assert.equal(fence.events.at(-1),'reconnect:1');
  assert.equal(h.state.connects(),1);
  await h.runtime.close();
});

for(const replacement of [false,true])test(`refresh reconnect deadline ${replacement?'preserves a replacement bootstrap':'disconnects its pending owner'}`,async t=>{
  const connecting=Promise.withResolvers<void>(),releaseConnect=Promise.withResolvers<void>();
  let hold=false,connected=true,hooks=0;
  const h=makeRuntime({bootstrapResults:[makeAuthority(BASE_REQUEST),
      {...makeAuthority(BASE_REQUEST,{session:REF2,lease:LEASE2,epoch:'1',aliases:NEW_ALIASES}),continuity_id:'replacement-continuity'}],
    participantConnected:()=>connected,
    participantConnectGate:async()=>{if(hold){connecting.resolve();await releaseConnect.promise;}},
    bootstrapConnected:{onBootstrapConnected:async()=>{hooks++;}}});
  await h.runtime.bootstrap(BASE_REQUEST,bearer);
  t.mock.timers.enable({apis:['setTimeout']});hold=true;connected=false;
  const rejected=assert.rejects(h.runtime.refresh(REFRESH_REQUEST,bearer),{code:'REALTIME_REFRESH_DEADLINE',status:503});
  await connecting.promise;
  if(replacement){hold=false;connected=true;await h.runtime.bootstrap({...BASE_REQUEST,request_id:'replacement',
    idempotency_context:{...IDEMPOTENCY,idempotency_key:'replacement'}},bearer);}
  const disconnects=h.state.participantDisconnects();
  t.mock.timers.tick(4000);await rejected;
  assert.equal(h.state.participantDisconnects(),disconnects+(replacement?0:1));
  const hooksBeforeRelease=hooks;releaseConnect.resolve();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(hooks,hooksBeforeRelease);
  await h.runtime.close();
});

test('refresh deadline releases credential admission before a held reconnect finishes',async t=>{
  const fence=admissionHarness(),connecting=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let active=0,hold=false;
  const admission:RealtimeCredentialFenceAdmissionPort={...fence.admission,
    async withAdmission<T>(tuple:RealtimeCredentialFenceTuple,callback:()=>Promise<T>):Promise<T>{
      active++;try{return await fence.admission.withAdmission(tuple,callback);}finally{active--;}}};
  const h=makeRuntime({bootstrapResults:[{...makeAuthority(BASE_REQUEST),credential_generation:'1'}],
    credentialFenceAdmission:admission,captureReconnectGuard:true,participantConnected:()=>!hold,
    participantConnectGate:async()=>{if(hold){connecting.resolve();await release.promise;}}});
  try{
    await h.runtime.bootstrap(BASE_REQUEST,bearer);assert.equal(active,0);
    t.mock.timers.enable({apis:['setTimeout']});hold=true;
    const rejected=assert.rejects(h.runtime.refresh(REFRESH_REQUEST,bearer),{code:'REALTIME_REFRESH_DEADLINE',status:503});
    await connecting.promise;assert.equal(active,1);t.mock.timers.tick(4000);await rejected;
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(active,0,'expired refresh must release the credential admission transaction before native connect settles');
  }finally{release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));await h.runtime.close();}
});

test('live HTTP refresh releases departed peer and bounds stalled readiness', {skip:process.env.PUB504_LIVE_HTTP!=='1',timeout:30000},async()=>{
  const {createServer}=await import('node:http');
  const {RoomEvent,dispose}=await import('@livekit/rtc-node');
  const {AccessToken}=await import('livekit-server-sdk');
  const {createGatewayRoom}=await import('../src/sdk-room.ts');
  const {createFormalTextIngress,FORMAL_TEXT_OUTPUT_TOPIC}=await import('../src/personal-aios-formal-text.ts');
  const {createRealtimePublicControlController}=await import('../src/realtime-public-control-controller.ts');
  const {MAC_CAPABILITIES}=await import('../../../services/personal-aios-integration/src/source-authority.ts');
  const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<deadline,'HTTP RTC condition timeout');await pause(5);}};
  try {for(const scenario of ['departed-peer','stalled-ready']){
    const request_id=`pub504-http-${scenario}-${Date.now()}`,name=request_id;
    const gateway=createGatewayRoom(),old=createGatewayRoom(),next=createGatewayRoom();
    const entered=Promise.withResolvers<void>(),barrier=Promise.withResolvers<void>();
    const errors:unknown[]=[],received:Record<string,unknown>[]=[];let refreshing=false,refreshAuths=0;
    const connect=async(room:typeof gateway,identity:string)=>{const token=new AccessToken('devkey','secret',{identity,ttl:600});
      token.addGrant({roomJoin:true,room:name,canPublish:true,canSubscribe:true,canPublishData:true});
      await room.connect('ws://127.0.0.1:19780',await token.toJwt(),{autoSubscribe:true,dynacast:false});};
    const participant={roomPort:gateway,connect:async()=>{},disconnect:async()=>{await gateway.disconnect();},
      snapshot:()=>({connected:true,transportState:'connected' as const}),close:async()=>{await gateway.disconnect();}};
    const device={principal_id:'http-local-owner',device_id:DEVICE,device_type:'mac',capabilities:MAC_CAPABILITIES};
    const business={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{if(refreshing&&refreshAuths++>0){entered.resolve();await barrier.promise;}return device;},
      watchCare:async(_device:unknown,deliver:(id:string,text:string)=>Promise<unknown>)=>{
        void Promise.all([deliver('http-snapshot-one','one'),deliver('http-snapshot-two','two')]).catch(error=>errors.push(error));return()=>{};},
      watchAmbientTurns:async()=>()=>{},terminalChanged:()=>{}};
    const bridge=createFormalTextIngress({participant:participant as never,runtime:business as never,
      authority:{credentialForBootstrap:()=>({request_id})} as never,max_packet_bytes:12288,onError:error=>errors.push(error)});
    const h=makeRuntime({participantForDevice:()=>participant as never,bootstrapConnected:bridge});
    // Synthetic fixture schemas/auth/DB; the HTTP controller, runtime, ingress and RTC are actual implementations.
    const controller=createRealtimePublicControlController({enabled:true,controlHost:'127.0.0.1',runtime:h.runtime,
      edge:{authorize:async()=>{}},bearer:{authorize:async()=>bearer},
      schemaRegistry:{validateRequest:()=>true,validateResponse:()=>true,validateTerminal:()=>true}});
    const server=createServer((request,response)=>{void controller.handle(request,response).then(handled=>{if(!handled){response.statusCode=404;response.end();}});});
    try {
      await connect(gateway,'gateway-identity');await connect(old,'terminal-identity');await until(()=>gateway.remoteParticipants.size===1);
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
      const post=async(path:string,body:unknown)=>{const response=await fetch(origin+path,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-http-capability'},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
        return {status:response.status,body:await response.json() as Record<string,unknown>};};
      const boot=await post('/v1/realtime/bootstrap',{...BASE_REQUEST,request_id:`${request_id}-bootstrap`});assert.equal(boot.status,200,JSON.stringify(boot));
      refreshing=true;const start=Date.now();
      const pending=post('/v1/realtime/credentials/refresh',{...REFRESH_REQUEST,request_id});
      await entered.promise;
      if(scenario==='departed-peer'){
        const departed=Promise.withResolvers<void>();gateway.once(RoomEvent.ParticipantDisconnected,()=>departed.resolve());
        await old.disconnect();await departed.promise;barrier.resolve();
      }
      const result=await pending,elapsed_ms=Date.now()-start;
      if(scenario==='stalled-ready'){
        assert.equal(result.status,503);assert.equal(result.body.error,'REALTIME_REFRESH_DEADLINE');
        assert.ok(elapsed_ms>=3900&&elapsed_ms<5500,`deadline elapsed ${elapsed_ms}`);
      }else{
        assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.status,'credential_refreshed');assert.ok(elapsed_ms<5000);
        next.on(RoomEvent.DataReceived,(bytes,_sender,_kind,topic)=>{if(topic===FORMAL_TEXT_OUTPUT_TOPIC)received.push(JSON.parse(Buffer.from(bytes).toString()));});
        next.registerTextStreamHandler(FORMAL_TEXT_OUTPUT_TOPIC,async reader=>{received.push(JSON.parse(await reader.readAll()));});
        await connect(next,'terminal-identity');await until(()=>received.some(row=>row.operation==='ready'));
        const ready=received.findIndex(row=>row.operation==='ready');assert.equal(ready,2);
        assert.deepEqual(received.slice(0,ready).map(row=>row.processed_event_id).sort(),['http-snapshot-one','http-snapshot-two']);
      }
      console.info('PUB504_LIVE_HTTP_RESULT',JSON.stringify({request_id,scenario,status:result.status,error:result.body.error,elapsed_ms,
        output:received.map(row=>row.operation),scope:'loopback-http-controller-runtime-formal-ingress-real-rtc-synthetic-business-schemas'}));
    }finally{
      barrier.resolve();await next.disconnect();await old.disconnect();await controller.close();await bridge.close();
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await gateway.disconnect();
    }
  }}finally{dispose();}
});

test('initial bootstrap intersects start/requested media and connects participant', async () => {
  const { runtime, state } = makeRuntime();
  const result = await runtime.bootstrap(BASE_REQUEST, bearer);
  assert.equal(result.status, 'bootstrap_accepted'); assert.equal(state.signed.length, 2); assert.equal(state.connects(), 1); assert.equal(result.connection_epoch, '1');
  assert.deepEqual(result.recipient_device_credential_ref, E2EE_REQUEST.recipient_device_credential_ref);
});

test('configured nondefault LiveKit projection reaches the public bootstrap response and participant', async () => {
  const livekitUrl = 'wss://configured-livekit.invalid:19443';
  const occurredAt = '2026-08-22T12:00:00.000Z';
  const owner = { userId: 'owner', deviceId: DEVICE, purpose: 'realtime_assistant',
    capabilities: ['audio', 'video', 'data'], occurredAt };
  const cloud = createRealtimePublicControlSelfHostedCloudProjection({ livekitUrl, now: () => Date.parse(occurredAt) });
  const projected = await cloud.bootstrap({ owner, governance: GOVERNANCE,
    request: { ...owner, governance: GOVERNANCE, requestId: 'request-1', idempotencyKey: 'request-1' },
    projection: { operation: 'bootstrap', binding: { realtimeSessionRef: REF, deviceLeaseRef: LEASE,
      continuityId: CONTINUITY, connectionEpoch: '1', transportSessionAlias: 'transport', roomAlias: 'room',
      deviceAlias: 'device', provider: 'livekit-cloud', connectionId: 'connection' },
      continuityExpiresAt: '2026-08-22T12:30:00.000Z', leaseExpiresAt: '2026-08-22T12:20:00.000Z',
      receipt: { kind: 'realtime_terminal_receipt', operation: 'bootstrap', status: 'success', requestId: 'request-1',
        idempotencyKey: 'request-1', realtimeSessionRef: REF, deviceLeaseRef: LEASE, continuityId: CONTINUITY,
        connectionEpoch: '1', leaseVersion: '1', recordedAt: occurredAt } } } as never);
  const h = makeRuntime({ signerProjectUrl: livekitUrl, bootstrapResults: [{ ...makeAuthority(BASE_REQUEST),
    server_url: projected.serverUrl, terminal_room_name: projected.terminalRoomName,
    terminal_identity: projected.terminalIdentity, terminal_grants: projected.terminalGrants,
    credential_expires_at: projected.credentialExpiresAt, media_grants: projected.mediaGrants,
    gateway: projected.gateway }] });
  try {
    const response = await h.runtime.bootstrap(BASE_REQUEST, bearer);
    assert.equal(response.status, 'bootstrap_accepted');
    assert.equal((response.livekit as JsonRecord).server_url, livekitUrl);
    assert.deepEqual(h.state.connectedProjectUrls, [livekitUrl]);
    assert.equal(h.state.connects(), 1);
    assert.equal(h.state.signed.length, 2);
    assert.equal(h.state.signed[0]?.room, projected.terminalRoomName);
    assert.equal(h.state.signed[1]?.room, projected.gateway.roomName);
  } finally { await h.runtime.close(); cloud.close?.(); }
});

test('device credential is bound before connect and connected refresh does not invoke the port', async () => {
  const h = makeRuntime();
  const first = await h.runtime.bootstrap(BASE_REQUEST, bearer);
  assert.deepEqual(first.recipient_device_credential_ref, E2EE_REQUEST.recipient_device_credential_ref);
  await assert.rejects(h.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_INITIAL_CONTINUITY_REUSE/u);
  assert.equal(h.state.credentialCalls(), 1);
  await h.runtime.refresh(REFRESH_REQUEST, bearer);
  assert.equal(h.state.credentialCalls(), 1);
});

test('device credential failure or a malformed ref stops before E2EE/sign/connect', async () => {
  const failed = makeRuntime({ credentialFailure: true });
  await assert.rejects(failed.runtime.bootstrap(BASE_REQUEST, bearer), /DEVICE_CREDENTIAL_FAILED/u);
  assert.equal(failed.state.signed.length, 0);
  assert.equal(failed.state.connects(), 0);
  for (const credentialResult of [undefined, null, 'ref', ['ref']]) {
    const h = makeRuntime({ credentialResult });
    await assert.rejects(h.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_DEVICE_CREDENTIAL_INVALID/u);
    assert.equal(h.state.signed.length, 0);
    assert.equal(h.state.connects(), 0);
  }
});

test('bootstrap bounds media-grant expiry by credential and continuity deadlines', async () => {
  const authority = makeAuthority(BASE_REQUEST);
  const media = authority.media_grants.audio as JsonRecord;
  media.expires_at = '2026-08-22T12:15:01Z';
  const runtime = makeRuntime({ bootstrapResults: [authority] });
  await assert.rejects(runtime.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_MEDIA_GRANT_EXPIRY_INVALID/);
});

test('bootstrap rejects a Cloud project different from the injected signer profile', async () => {
  const mismatch = makeRuntime({ serverUrl: 'wss://other.livekit.cloud' });
  await assert.rejects(mismatch.runtime.bootstrap(BASE_REQUEST, bearer), /PROJECT_BINDING_MISMATCH/);
});

test('media authorization rejects response grant expansion and unsupported source', async () => {
  const expanded = makeRuntime({ terminalGrantOverride: { canPublishData: true }, mediaGrantOverride: { data: { enabled: false } } });
  const request = { ...BASE_REQUEST, requested_media: { audio: true, video: true, data: false }, start: { ...START, modalities: ['audio', 'video'] } };
  await assert.rejects(expanded.runtime.bootstrap(request, bearer), /REALTIME_GATEWAY_GRANTS_INVALID|REALTIME_TERMINAL_GRANTS_INVALID|REALTIME_MEDIA_GRANT_START_INVALID/);
  const unsupported = makeRuntime({ terminalGrantOverride: { canPublishSources: ['microphone', 'screen_' + 'share'] as never } });
  await assert.rejects(unsupported.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_TERMINAL_GRANTS_INVALID/);
});

test('connected refresh preserves tuple/aliases and rejects owner drift', async () => {
  const { runtime } = makeRuntime(); await runtime.bootstrap(BASE_REQUEST, bearer);
  const result = await runtime.refresh(REFRESH_REQUEST, bearer); assert.equal(result.status, 'credential_refreshed'); assert.equal(result.continuity_id, CONTINUITY); assert.equal(result.connection_epoch, '1');
  const drift = makeRuntime({ refreshResult: { connection_epoch: '2' } }); await drift.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(drift.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_OWNER_RESULT_BINDING_INVALID/);
  for (const [field, replacement] of [['realtime_session_ref', REF2], ['device_lease_ref', LEASE2], ['continuity_id', 'other-continuity'], ['transport_aliases', ['other-room-alias']]] as const) {
    const changed = makeRuntime({ refreshResult: { [field]: replacement } }); await changed.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(changed.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_OWNER_RESULT_BINDING_INVALID/);
  }
  const credentialDrift = makeRuntime({ refreshResult: { credential_input: { room: 'other-room', identity: 'terminal-identity', ttlSeconds: 898, grants: makeAuthority(BASE_REQUEST).terminal_grants } } }); await credentialDrift.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(credentialDrift.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_TRANSPORT_BINDING_INVALID/);
  const governanceDrift = makeRuntime({ refreshResult: { governance: { purpose_scopes: ['other-purpose'] } } }); await governanceDrift.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(governanceDrift.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_GOVERNANCE_BINDING_INVALID/);
});

test('a new explicit Start supersedes the session the gateway participant still serves', async () => {
  const stale = { realtimeSessionRef: { ref_type: 'RealtimeSession', ref_id: 'stale-session' }, deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: 'stale-lease' },
    continuityId: 'stale-continuity', transportAliases: [], connectionEpoch: '1' };
  const events: string[] = [];
  const superseding = makeRuntime({ heldParticipantBinding: stale, events });
  const result = await superseding.runtime.bootstrap(BASE_REQUEST, bearer);
  assert.equal(result.status, 'bootstrap_accepted');
  assert.deepEqual(events.filter((event) => event.startsWith('participant.')), ['participant.disconnect', 'participant.connect']);
  // No held session (or the same one): nothing is torn down.
  const fresh: string[] = [];
  await makeRuntime({ events: fresh }).runtime.bootstrap(BASE_REQUEST, bearer);
  assert.deepEqual(fresh.filter((event) => event.startsWith('participant.')), ['participant.connect']);
});

test('connected refresh rejects unknown bindings and expiry drift; the runtime owns the signed TTL', async () => {
  const unknown = makeRuntime();
  await assert.rejects(unknown.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  for (const refreshResult of [
    { credential_expires_at: '2026-08-22T11:59:59Z' },
    { credential_expires_at: '2026-08-22T12:31:00Z' },
  ] as const) {
    const drift = makeRuntime({ refreshResult });
    await drift.runtime.bootstrap(BASE_REQUEST, bearer);
    await assert.rejects(drift.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_CREDENTIAL_EXPIRY_INVALID/);
  }
  // A projection TTL computed a moment earlier never fails refresh; the token is signed with the runtime's window TTL.
  const stale = makeRuntime({ refreshResult: { credential_input: { room: 'terminal-room', identity: 'terminal-identity', ttlSeconds: 100, grants: makeAuthority(BASE_REQUEST).terminal_grants } } });
  await stale.runtime.bootstrap(BASE_REQUEST, bearer);
  const bootstrapTtl = stale.state.signed.at(-1)!.ttlSeconds;
  await stale.runtime.refresh(REFRESH_REQUEST, bearer);
  assert.notEqual(stale.state.signed.at(-1)!.ttlSeconds, 100);
  assert.ok(stale.state.signed.at(-1)!.ttlSeconds <= bootstrapTtl);
});

test('handoff delegates authority without using local binding maps and validates success/indeterminate facts', async () => {
  const { runtime, state } = makeRuntime();
  const result = await runtime.handoff(HANDOFF_REQUEST, bearer);
  assert.equal(result.status, 'success');
  assert.equal(state.handoffCalls(), 1);
  const active = makeRuntime(); await active.runtime.bootstrap(BASE_REQUEST, bearer); await active.runtime.handoff(HANDOFF_REQUEST, bearer);
  await assert.rejects(active.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  assert.deepEqual(active.state.releaseEvents, [1]); await active.runtime.close();
  const uncertain = makeRuntime({ handoffResult: handoffTerminal(HANDOFF_REQUEST, 'indeterminate') });
  const uncertainResult = await uncertain.runtime.handoff(HANDOFF_REQUEST, bearer);
  assert.equal(uncertainResult.status, 'indeterminate');
  const malformed = makeRuntime({ handoffResult: { ...handoffTerminal(HANDOFF_REQUEST), execution_facts: { closure_status: 'indeterminate', device_lease_release: 'released', evidence_refs: [{ evidence_ref: 'x' }] } } });
  await assert.rejects(malformed.runtime.handoff(HANDOFF_REQUEST, bearer), /REALTIME_HANDOFF_SUCCESS_FACTS_INVALID/);
});

test('cold runtime accepts only an exact T11B fully-disconnected proof and rejects missing or drifted previous fields', async () => {
  const disconnectedRequest = { ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-cold', continuity_id: CONTINUITY, transport_aliases: ALIASES };
  const authorityFor = (transition: unknown): RealtimeBootstrapAuthorityResult => ({
    ...makeAuthority(disconnectedRequest, { session: REF2, lease: LEASE2, epoch: '2', aliases: NEW_ALIASES }),
    ...(transition === undefined ? {} : { binding_transition: transition as NonNullable<RealtimeBootstrapAuthorityResult['binding_transition']> }),
  });
  const cold = makeRuntime({ bootstrapResults: [authorityFor(PREVIOUS_TRANSITION)] });
  const coldResult = await cold.runtime.bootstrap(disconnectedRequest, bearer);
  assert.equal(coldResult.connection_epoch, '2');
  assert.deepEqual(coldResult.recipient_device_credential_ref, E2EE_REQUEST.recipient_device_credential_ref);

  for (const field of ['previous_realtime_session_ref', 'previous_device_lease_ref', 'previous_transport_aliases', 'previous_continuity_expires_at'] as const) {
    const missing = { ...PREVIOUS_TRANSITION } as Record<string, unknown>;
    delete missing[field];
    const runtime = makeRuntime({ bootstrapResults: [authorityFor(missing)] });
    await assert.rejects(runtime.runtime.bootstrap(disconnectedRequest, bearer), /REALTIME_BINDING_TRANSITION_INVALID/);
  }

  const driftCases: readonly [
    'previous_realtime_session_ref' | 'previous_device_lease_ref' | 'previous_transport_aliases' | 'previous_continuity_expires_at',
    unknown,
    RegExp,
  ][] = [
    ['previous_realtime_session_ref', REF2, /REALTIME_BINDING_TRANSITION_CAS_INVALID/],
    ['previous_device_lease_ref', LEASE2, /REALTIME_BINDING_TRANSITION_CAS_INVALID/],
    ['previous_transport_aliases', NEW_ALIASES, /REALTIME_PREVIOUS_TRANSPORT_ALIASES_INVALID/],
    ['previous_continuity_expires_at', '2026-08-22T12:29:59Z', /REALTIME_CONTINUITY_EXPIRY_EXTENDED/],
  ];
  for (const [field, replacement, expected] of driftCases) {
    const transition = { ...PREVIOUS_TRANSITION, [field]: replacement } as RealtimeBootstrapAuthorityResult['binding_transition'];
    const runtime = makeRuntime({ bootstrapResults: [authorityFor(transition)] });
    await assert.rejects(runtime.runtime.bootstrap(disconnectedRequest, bearer), expected);
  }
});

test('fully disconnected bootstrap requires atomic new binding, strict decimal epoch increase and new aliases', async () => {
  const noPrevious = makeRuntime();
  await assert.rejects(noPrevious.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-no-previous', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer), /REALTIME_BINDING_TRANSITION_INVALID/);
  const second: RealtimeBootstrapAuthorityResult = { ...makeAuthority({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', continuity_id: CONTINUITY, transport_aliases: ALIASES }, { session: REF2, lease: LEASE2, epoch: '2', aliases: NEW_ALIASES }), binding_transition: PREVIOUS_TRANSITION };
  const { runtime } = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), second] }); await runtime.bootstrap(BASE_REQUEST, bearer);
  const result = await runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-2', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer); assert.equal(result.connection_epoch, '2');
  const callerAliases = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), second] }); await callerAliases.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(callerAliases.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-caller-alias', continuity_id: CONTINUITY, transport_aliases: ['caller-fake-alias'] }, bearer), /REALTIME_PREVIOUS_TRANSPORT_ALIASES_INVALID/);
  const badEpoch = { ...second, connection_epoch: '10', binding_transition: { ...PREVIOUS_TRANSITION, previous_connection_epoch: '2' } } as RealtimeBootstrapAuthorityResult;
  const reject = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), badEpoch] }); await reject.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(reject.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-3', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer), /REALTIME_CONNECTION_EPOCH_NOT_INCREASING|REALTIME_BINDING_TRANSITION_CAS_INVALID/);
  const reused = { ...second, binding_transition: { ...PREVIOUS_TRANSITION, provider_session_reused: true } as never } as RealtimeBootstrapAuthorityResult;
  const rejectReuse = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), reused] }); await rejectReuse.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(rejectReuse.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-4', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer), /REALTIME_BINDING_TRANSITION_INVALID/);
  const aliasReuse = { ...second, transport_aliases: ALIASES } as RealtimeBootstrapAuthorityResult;
  const rejectAliasReuse = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), aliasReuse] }); await rejectAliasReuse.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(rejectAliasReuse.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-5', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer), /REALTIME_TRANSPORT_ALIASES_NOT_ROTATED|REALTIME_TRANSPORT_ALIAS_REUSED/);
  const partialAliasReuse = { ...second, transport_aliases: ['room-alias', 'participant-alias-2'] } as RealtimeBootstrapAuthorityResult;
  const rejectPartialAlias = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), partialAliasReuse] }); await rejectPartialAlias.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(rejectPartialAlias.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-6', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer), /REALTIME_TRANSPORT_ALIAS_REUSED/);
  const extendedDeadline = { ...second, continuity_expires_at: '2026-08-22T12:31:00Z' } as RealtimeBootstrapAuthorityResult;
  const rejectDeadline = makeRuntime({ bootstrapResults: [makeAuthority(BASE_REQUEST), extendedDeadline] }); await rejectDeadline.runtime.bootstrap(BASE_REQUEST, bearer); await assert.rejects(rejectDeadline.runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-7', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer), /REALTIME_CONTINUITY_EXPIRY_EXTENDED/);
});

test('E2EE resolve binds every recipient/session/key/governance field and remains ciphertext-only', async () => {
  const { runtime } = makeRuntime(); const result = await runtime.resolveE2eeKey(E2EE_REQUEST, bearer); assert.equal(result.status, 'key_resolved'); assert.equal(result.roomOptions, undefined); assert.equal(result.ciphertext, 'fixture_ciphertext');
  for (const field of ['realtime_session_ref', 'device_lease_ref', 'continuity_id', 'connection_epoch', 'transport_aliases', 'key_envelope_ref', 'key_index', 'key_generation', 'device_id', 'recipient_device_credential_ref', 'participant_audience', 'governance'] as const) { const drift = makeRuntime({ ciphertextResult: { [field]: field === 'key_index' ? 99 : field === 'connection_epoch' ? '2' : { drifted: true } } }); await assert.rejects(drift.runtime.resolveE2eeKey(E2EE_REQUEST, bearer), /REALTIME_E2EE_KEY_BINDING_INVALID/); }
});

test('bootstrap validates E2EE envelope provenance, scope, expiry, release and uses only resolver RoomOptions', async () => {
  for (const envelopeOverride of [
    { realtime_session_ref: REF2 },
    { continuity_id: 'other-continuity' },
    { scope: { device_id: 'other-device', channels: ['audio', 'video', 'data'], distribution_mode: 'application_controlled_envelope' } },
    { scope: { device_id: DEVICE, channels: ['audio'], distribution_mode: 'application_controlled_envelope' } },
    { governance: { drifted: true } },
    { key_generation: '0' },
    { expires_at: '2026-08-22T12:16:00Z' },
    { ciphertext: 'fixture_secret' },
  ] as const) {
    const drift = makeRuntime({ envelopeOverride });
    await assert.rejects(drift.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_E2EE_ENVELOPE_BINDING_INVALID|REALTIME_E2EE_ENVELOPE_SCOPE_INVALID|REALTIME_E2EE_ENVELOPE_KEY_INVALID|REALTIME_E2EE_ENVELOPE_EXPIRY_INVALID|REALTIME_E2EE_ENVELOPE_SECRET/);
  }
  const noRelease = makeRuntime({ omitEnvelopeRelease: true });
  await assert.rejects(noRelease.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_E2EE_RELEASE_REQUIRED/);
  const authorityRoomOptionsIgnored = makeRuntime({ envelopeRoomOptions: {} });
  await assert.rejects(authorityRoomOptionsIgnored.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_E2EE_ROOM_OPTIONS_INVALID/);
  const nullEncryption = makeRuntime({ envelopeRoomOptions: { encryption: null } });
  await assert.rejects(nullEncryption.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_E2EE_ROOM_OPTIONS_INVALID/);
});

test('bootstrap releases resolver envelope exactly once when participant connect fails', async () => {
  const failed = makeRuntime({ participantConnectFails: true });
  await assert.rejects(failed.runtime.bootstrap(BASE_REQUEST, bearer));
  assert.equal(failed.state.releaseEvents.length, 1);
  assert.equal(failed.state.participantDisconnects(), 0);
});

test('E2EE stale resolution returns bound terminal expiry without ciphertext', async () => {
  const terminal = { operation: 'realtime_e2ee_key_resolve', status: 'expired', request_id: E2EE_REQUEST.request_id, realtime_session_ref: E2EE_REQUEST.realtime_session_ref, device_lease_ref: E2EE_REQUEST.device_lease_ref, continuity_id: E2EE_REQUEST.continuity_id, connection_epoch: E2EE_REQUEST.connection_epoch, execution_facts: { closure_status: 'not_applicable' }, operation_outcome: { outcome_class: 'committed_rejection', error: { error_family: 'state', error_code: 'state.credential_expired', retry_class: 'never', trace_id: '018f0000-0000-7000-8000-000000000011', occurred_at: '2026-08-22T12:00:00Z' }, recorded_result_ref: { idempotency_context: E2EE_REQUEST.idempotency_context, fencing_epoch: '1', outcome_class: 'committed_rejection', result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json', result_schema_version: '1.0.0', result_schema_sha256: '3'.repeat(64), result_payload_sha256: '4'.repeat(64) }, resolution_mode: 'direct' }, governance: GOVERNANCE } as JsonRecord;
  const { runtime } = makeRuntime({ ciphertextResult: terminal }); await assert.rejects(runtime.resolveE2eeKey(E2EE_REQUEST, bearer), (error: unknown) => (error as { readonly terminalResult?: JsonRecord }).terminalResult?.status === 'expired' && (error as { readonly status?: number }).status === 410);
});

test('media Stop validates authoritative A/B cleanup facts and releases only current binding', async () => {
  const { runtime, state } = makeRuntime(); await runtime.bootstrap(BASE_REQUEST, bearer); const result = await runtime.stop(STOP_REQUEST, bearer); assert.equal(result.status, 'success'); assert.equal(state.stopCalls(), 4);
  await assert.rejects(runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  assert.deepEqual(state.releaseEvents, [1]);
  const invalid = makeRuntime({ stopResult: { ...terminalResult(STOP_REQUEST), execution_facts: { closure_status: 'verified_closed', device_lease_release: 'released', participant_cleanup: 'verified_absent', track_cleanup: 'indeterminate', room_cleanup: 'verified_absent' } } });
  await assert.rejects(invalid.runtime.stop(STOP_REQUEST, bearer), /REALTIME_STOP_SUCCESS_FACTS_INVALID/);
  const replay = makeRuntime({ alreadyCompleted: terminalResult(STOP_REQUEST) }); const replayResult = await replay.runtime.stop(STOP_REQUEST, bearer); assert.equal(replayResult.status, 'success');
  const receipt = makeRuntime({ stopResult: { ...terminalResult(STOP_REQUEST), delivery_receipt: { acknowledged: true } } }); await assert.rejects(receipt.runtime.stop(STOP_REQUEST, bearer), /REALTIME_DELIVERY_RECEIPT_NOT_OPERATION_RESULT/);
  const uncertain = makeRuntime({ stopResult: terminalResult(STOP_REQUEST, 'indeterminate') }); const uncertainResult = await uncertain.runtime.stop(STOP_REQUEST, bearer); assert.equal(uncertainResult.status, 'indeterminate');
});

test('old Stop does not release a new handoff binding with the same continuity', async () => {
  const second: RealtimeBootstrapAuthorityResult = { ...makeAuthority({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', continuity_id: CONTINUITY, transport_aliases: ALIASES }, { session: REF2, lease: LEASE2, epoch: '2', aliases: NEW_ALIASES }), binding_transition: PREVIOUS_TRANSITION };
  const releases: string[] = [];
  const config = { bootstrapResults: [makeAuthority(BASE_REQUEST), second] };
  const { runtime, state } = makeRuntime(config); await runtime.bootstrap(BASE_REQUEST, bearer); await runtime.bootstrap({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: 'bootstrap-2', continuity_id: CONTINUITY, transport_aliases: ALIASES }, bearer); await runtime.stop(STOP_REQUEST, bearer); assert.deepEqual(state.releaseEvents, [1]); void releases;
});

test('end-continuity validates terminal tuple and rejects DeliveryReceipt or secret leakage', async () => {
  const receipt = makeRuntime({ endResult: { operation: 'end_continuity', request_id: 'end-1', status: 'success', delivery_receipt: { acknowledged: true } } });
  await assert.rejects(receipt.runtime.endContinuity({ operation: 'end_continuity', request_id: 'end-1', realtime_session_ref: REF, continuity_id: CONTINUITY, connection_epoch: '1', confirmation: 'explicit_user_end_continuity', governance: GOVERNANCE }, bearer), /REALTIME_DELIVERY_RECEIPT_NOT_OPERATION_RESULT/);
  const drift = makeRuntime({ endResult: { operation: 'end_continuity', request_id: 'end-1', status: 'success', realtime_session_ref: REF2 } });
  await assert.rejects(drift.runtime.endContinuity({ operation: 'end_continuity', request_id: 'end-1', realtime_session_ref: REF, continuity_id: CONTINUITY, connection_epoch: '1', confirmation: 'explicit_user_end_continuity', governance: GOVERNANCE }, bearer), /REALTIME_OWNER_RESULT_BINDING_INVALID/);
});

test('runtime close attempts every owner/resource even when several close operations fail', async () => {
  const allFailures = makeRuntime({ closeFailures: ['participant', 'e2ee', 'media_stop', 'sessions', 'e2ee_ciphertext', 'token_signer'] });
  await assert.rejects(allFailures.runtime.close(),(error:AggregateError)=>{
    assert.equal(error.message,'REALTIME_RUNTIME_CLOSE_FAILED');
    assert.deepEqual(error.errors.map(failure=>[failure.message,failure.cause.message]),[
      ['participant','PARTICIPANT_CLOSE_FAILED'],['e2ee','E2EE_CLOSE_FAILED'],['media_stop','MEDIA_STOP_CLOSE_FAILED'],
      ['sessions','SESSIONS_CLOSE_FAILED'],['e2ee_ciphertext','CIPHERTEXT_CLOSE_FAILED'],['token_signer','SIGNER_CLOSE_FAILED']]);
    return true;
  });
  assert.equal(allFailures.state.participantClosed(), 1);
  assert.equal(allFailures.state.e2eeClosed(), 1);
  assert.equal(allFailures.state.mediaStopClosed(), 1);
  assert.equal(allFailures.state.sessionsClosed(), 1);
  assert.equal(allFailures.state.ciphertextClosed(), 1);
  assert.equal(allFailures.state.signerClosed(), 1);
});

test('end-continuity remains separate from media Stop and runtime close is idempotent', async () => {
  const { runtime, state } = makeRuntime(); await runtime.bootstrap(BASE_REQUEST, bearer);
  const result = await runtime.endContinuity({ operation: 'end_continuity', request_id: 'end-1', realtime_session_ref: REF, continuity_id: CONTINUITY, connection_epoch: '1', confirmation: 'explicit_user_end_continuity', governance: GOVERNANCE }, bearer); assert.equal(result.operation, 'end_continuity'); assert.equal(state.endCalls(), 1);
  await assert.rejects(runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  assert.deepEqual(state.releaseEvents, [1]);
  await runtime.close(); await runtime.close(); assert.equal(state.participantClosed(), 1); assert.equal(state.e2eeClosed(), 1);
});

test('bootstrap-connected hook runs after participant connect and binding preparation', async () => {
  const events: string[] = [];
  let received: import('../src/realtime-public-control-runtime.ts').RealtimeBootstrapConnectedInput | undefined;
  const { runtime } = makeRuntime({
    events,
    bootstrapConnected: {
      async onBootstrapConnected(input) {
        events.push('hook');
        received = input;
      },
    },
  });
  const result = await runtime.bootstrap(BASE_REQUEST, bearer);
  assert.equal(result.status, 'bootstrap_accepted');
   assert.deepEqual(events, ['device_credential', 'participant.connect', 'hook']);
  assert.equal(received?.authority.realtime_session_ref, REF);
  assert.deepEqual(received?.enabledMedia, REQUESTED);
  assert.equal(received?.currentBinding.connectionEpoch, '1');
});

test('bootstrap-connected hook failure disconnects/releases and removes the tentative binding', async () => {
  const events: string[] = [];
  const failed = makeRuntime({
    events,
    bootstrapConnected: {
      async onBootstrapConnected() {
        events.push('hook');
        throw new Error('T04_FAILED');
      },
    },
  });
  await assert.rejects(failed.runtime.bootstrap(BASE_REQUEST, bearer), /T04_FAILED/u);
  assert.deepEqual(events, ['device_credential', 'participant.connect', 'hook', 'participant.disconnect']);
  assert.equal(failed.state.participantDisconnects(), 1);
  assert.deepEqual(failed.state.releaseEvents, [1]);
});

for (const replacementState of ['connecting', 'connected']) test(`late bootstrap failure cannot dismantle a ${replacementState} replacement on the same participant`, async () => {
  const entered = Promise.withResolvers<void>(), late = Promise.withResolvers<void>(), connecting = Promise.withResolvers<void>(), connect = Promise.withResolvers<void>();
  const refs = [
    { session: REF, lease: LEASE, epoch: '1', aliases: ALIASES },
    { session: REF2, lease: LEASE2, epoch: '2', aliases: NEW_ALIASES },
    { session: { ...REF2, ref_id: '018f0000-0000-7000-8000-000000000013' }, lease: { ...LEASE2, ref_id: '018f0000-0000-7000-8000-000000000014' }, epoch: '3', aliases: ['room-3', 'participant-3'] },
    { session: { ...REF2, ref_id: '018f0000-0000-7000-8000-000000000015' }, lease: { ...LEASE2, ref_id: '018f0000-0000-7000-8000-000000000016' }, epoch: '4', aliases: ['room-4', 'participant-4'] },
  ];
  const authorities = refs.map((binding, index) => ({ ...makeAuthority(BASE_REQUEST, binding), ...(index === 0 ? {} : { binding_transition: {
    ...PREVIOUS_TRANSITION, previous_realtime_session_ref: refs[index - 1]!.session, previous_device_lease_ref: refs[index - 1]!.lease,
    previous_connection_epoch: refs[index - 1]!.epoch, previous_transport_aliases: refs[index - 1]!.aliases,
  } }) }));
  let disconnects = 0;
  const participant: LiveKitCloudParticipantPort = {
    async connect(input) { if (input.binding.connectionEpoch === '3') { connecting.resolve(); if (replacementState === 'connecting') await connect.promise; } },
    disconnect: async () => { disconnects++; }, snapshot: () => ({ connected: false, transportState: 'disconnected' }), close: async () => undefined,
  };
  const h = makeRuntime({ bootstrapResults: authorities, refreshResult: authorities[2]!, participantForDevice: () => participant,
    bootstrapConnected: { onBootstrapConnected: async input => { if (input.authority.connection_epoch === '2') { entered.resolve(); await late.promise; } } } });
  const rebind = (index: number) => ({ ...BASE_REQUEST, bootstrap_mode: 'fully_disconnected', request_id: `bootstrap-${index + 1}`, continuity_id: CONTINUITY, transport_aliases: refs[index - 1]!.aliases });
  await h.runtime.bootstrap(BASE_REQUEST, bearer);
  const failed = assert.rejects(h.runtime.bootstrap(rebind(1), bearer), /T04_FAILED/); await entered.promise;
  const replacement = h.runtime.bootstrap(rebind(2), bearer); await connecting.promise;
  if (replacementState === 'connected') await replacement;
  late.reject(new Error('T04_FAILED')); await failed; connect.resolve(); await replacement;
  assert.equal(disconnects, 0); assert.deepEqual(h.state.releaseEvents, [1, 2]);
  const refresh = { ...REFRESH_REQUEST, realtime_session_ref: refs[2]!.session, device_lease_ref: refs[2]!.lease, connection_epoch: '3', transport_aliases: refs[2]!.aliases };
  assert.equal((await h.runtime.refresh(refresh, bearer)).status, 'credential_refreshed');
  assert.equal((await h.runtime.bootstrap(rebind(3), bearer)).status, 'bootstrap_accepted');
  await assert.rejects(h.runtime.refresh(refresh, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  await h.runtime.close(); assert.deepEqual(h.state.releaseEvents, [1, 2, 3, 4]);
});

test('Stop during signing cannot let a delayed refresh resurrect completed binding metadata', async () => {
  const signing = Promise.withResolvers<void>(), signed = Promise.withResolvers<void>();
  const h = makeRuntime({ signGate: async input => { if (input.name === undefined) { signing.resolve(); await signed.promise; } } });
  await h.runtime.bootstrap(BASE_REQUEST, bearer);
  const refused = assert.rejects(h.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_CHANGED/);
  await signing.promise; await h.runtime.stop(STOP_REQUEST, bearer); signed.resolve(); await refused;
  await assert.rejects(h.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  await h.runtime.close(); assert.deepEqual(h.state.releaseEvents, [1]);
});

test('a bootstrap stopped during its owner hook cannot return accepted credentials', async () => {
  const h = makeRuntime({ bootstrapConnected: { onBootstrapConnected: async () => { await h.runtime.stop(STOP_REQUEST, bearer); } } });
  await assert.rejects(h.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_BOOTSTRAP_SUPERSEDED/);
  await assert.rejects(h.runtime.refresh(REFRESH_REQUEST, bearer), /REALTIME_REFRESH_BINDING_UNKNOWN/);
  await h.runtime.close(); assert.deepEqual(h.state.releaseEvents, [1]);
});

test('an exact initial bootstrap replay does not invoke the hook twice', async () => {
  let hookCalls = 0;
  const h = makeRuntime({
    bootstrapConnected: {
      async onBootstrapConnected() { hookCalls += 1; },
    },
  });
  await h.runtime.bootstrap(BASE_REQUEST, bearer);
  await assert.rejects(h.runtime.bootstrap(BASE_REQUEST, bearer), /REALTIME_INITIAL_CONTINUITY_REUSE/u);
  assert.equal(hookCalls, 1);
});

test('runtime closes an owned bootstrap-connected hook once and leaves composition-owned hooks alone', async () => {
  let ownedCloses = 0;
  const owned = makeRuntime({
    bootstrapConnected: {
      async onBootstrapConnected() {},
      close() { ownedCloses += 1; },
    },
  });
  await Promise.all([owned.runtime.close(), owned.runtime.close()]);
  assert.equal(ownedCloses, 1);

  let borrowedCloses = 0;
  const borrowed = makeRuntime({
    bootstrapConnected: {
      async onBootstrapConnected() {},
      ownsClose: false,
      close() { borrowedCloses += 1; },
    },
  });
  await borrowed.runtime.close();
  assert.equal(borrowedCloses, 0);
});

// The existing runtime fixture controls RTC/T03 ports; receipts below are actual PG.
test('PG complete public receipts survive response loss, state release/device switch and a fresh runtime', { skip: !process.env.DEVICE_RECEIPTS_PG_URL }, async () => {
  const schema = `device_receipts_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({ connectionString: process.env.DEVICE_RECEIPTS_PG_URL });
  const pool = new Pool({ connectionString: process.env.DEVICE_RECEIPTS_PG_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migration = await readFile(new URL('../../../migrations/0001_idempotency_outbox.up.sql', import.meta.url), 'utf8');
    await pool.query(migration.slice(0, migration.indexOf('CREATE TABLE IF NOT EXISTS outbox_events')) + 'COMMIT;');
    let rejected = false;
    const receipts = createRealtimePublicOperationReceipts(pool);
    const first = makeRuntime({ operationReceipts: receipts, rejectCurrentState: () => rejected });
    const bootstrapResult = await first.runtime.bootstrap(BASE_REQUEST, bearer);
    const stopResult = await first.runtime.stop(STOP_REQUEST, bearer);
    const handoffResult = await first.runtime.handoff(HANDOFF_REQUEST, bearer);
    const beforeReplay = (await pool.query("SELECT scope, idempotency_key, updated_at::text FROM idempotency_ledger ORDER BY scope")).rows;
    rejected = true; // controlled owner now reports released / successor device active
    assert.deepEqual(await first.runtime.bootstrap(BASE_REQUEST, bearer), bootstrapResult);
    assert.deepEqual(await first.runtime.stop(STOP_REQUEST, bearer), stopResult);
    assert.deepEqual(await first.runtime.handoff(HANDOFF_REQUEST, bearer), handoffResult);
    assert.equal(first.state.connects(), 1);
    assert.equal(first.state.stopCalls(), 4);
    assert.equal(first.state.handoffCalls(), 1);
    const second = makeRuntime({ operationReceipts: createRealtimePublicOperationReceipts(pool), rejectCurrentState: () => true,
      bootstrapConnected:{assertBootstrapRequest:()=>{throw new Error('NEW_EXECUTION_OWNER_ONLY_DATA');},onBootstrapConnected:async()=>{throw new Error('REPLAY_MUST_NOT_ATTACH');}} });
    for (const [method, request, result] of [
      ['bootstrap', BASE_REQUEST, bootstrapResult], ['stop', STOP_REQUEST, stopResult], ['handoff', HANDOFF_REQUEST, handoffResult],
    ] as const) {
      assert.deepEqual(await second.runtime[method](request, bearer), result);
      const worker = `import { createRequire } from 'node:module';
        import { createRealtimePublicOperationReceipts } from ${JSON.stringify(new URL('../../../services/platform-data/src/realtime-public-operation-receipts.ts', import.meta.url).href)};
        const { Pool } = createRequire(${JSON.stringify(new URL('../../../services/platform-data/package.json', import.meta.url).href)})('pg');
        const pool = new Pool({ connectionString: process.env.DEVICE_RECEIPTS_PG_URL, options: '-c search_path=' + process.env.DEVICE_RECEIPTS_SCHEMA });
        let data = ''; for await (const chunk of process.stdin) data += chunk;
        const output = await createRealtimePublicOperationReceipts(pool).execute(JSON.parse(data), async () => { throw new Error('REPLAY_REEXECUTED'); });
        process.stdout.write(JSON.stringify(output)); await pool.end();`;
      const actual = execFileSync(process.execPath, ['--input-type=module', '-e', worker], {
        env: { ...process.env, DEVICE_RECEIPTS_SCHEMA: schema }, input: JSON.stringify({ request, bearer }), encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(actual), result);
      await assert.rejects(second.runtime[method]({ ...request, request_id: 'changed' }, bearer), /IDEMPOTENCY_CONFLICT/);
      await assert.rejects(second.runtime[method](request, { ...bearer, principal: 'forged' }), /IDEMPOTENCY_CONFLICT/);
      await assert.rejects(second.runtime[method](request, { ...bearer, deviceId: 'forged-device' }), /IDEMPOTENCY_CONFLICT/);
      await assert.rejects(second.runtime[method]({ ...request, idempotency_context: { ...IDEMPOTENCY, idempotency_key: `new-${method}` } }, bearer), method === 'bootstrap' ? /NEW_EXECUTION_OWNER_ONLY_DATA/ : /GOVERNANCE_DENIED/);
    }
    const afterReplay = (await pool.query("SELECT scope, idempotency_key, updated_at::text FROM idempotency_ledger ORDER BY scope")).rows;
    assert.deepEqual(afterReplay, beforeReplay); // history and rejected new commands make no writes
    assert.equal(second.state.connects(), 0);
    assert.equal(second.state.stopCalls(), 0);
    assert.equal(second.state.handoffCalls(), 0);
    const unknown = { ...BASE_REQUEST, idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'unknown-effect' } };
    let effects = 0;
    await assert.rejects(receipts.execute({ request: unknown, bearer }, async () => { effects++; throw new Error('PROCESS_INTERRUPTED'); }), /PROCESS_INTERRUPTED/);
    await assert.rejects(createRealtimePublicOperationReceipts(pool).execute({ request: unknown, bearer }, async () => { effects++; return {}; }), error => error instanceof Error && error.message === 'PROCESS_INTERRUPTED' && (error as Error&{operation_outcome:string}).operation_outcome === 'unknown');
    assert.equal((await receipts.read({request:unknown,bearer}))?.status,'indeterminate');
    assert.equal(effects, 1);
    const concurrent = { ...BASE_REQUEST, idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'concurrent' } };
    let unblock!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const winner = receipts.execute({ request: concurrent, bearer }, async () => { effects++; started(); await pending; return { operation: 'bootstrap', fixture: 'complete' }; });
    await entered;
    await assert.rejects(createRealtimePublicOperationReceipts(pool).execute({ request: concurrent, bearer }, async () => { effects++; return {}; }), /IN_FLIGHT/);
    unblock();
    await winner;
    assert.equal(effects, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const remaining=(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows.length;assert.equal(remaining,0);console.log(JSON.stringify({schema,cleanup_readback_remaining:remaining,host:'127.0.0.1',port:55439,database:'postgres',role:'l3test'}));
    await admin.end();
  }
});


// G-02/G-05: a gateway that died mid-operation leaves its public claim in flight. A restarted runtime recovers it under the
// operation's own authority (Stop re-runs the coordinator, which replays or takes over; bootstrap rebuilds the binding this
// process serves), and a completed end-continuity replays its durable terminal after the continuity has ended.
test('PG public claims of a crashed gateway are recovered through the runtime; end-continuity replays its terminal', { skip: !process.env.DEVICE_RECEIPTS_PG_URL }, async () => {
  const schema = `device_receipts_rec_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({ connectionString: process.env.DEVICE_RECEIPTS_PG_URL });
  const pool = new Pool({ connectionString: process.env.DEVICE_RECEIPTS_PG_URL, options: `-c search_path=${schema}` });
  const never = () => new Promise<void>(() => undefined);
  const stale = () => new Promise(resolve => setTimeout(resolve, 1300));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migration = await readFile(new URL('../../../migrations/0001_idempotency_outbox.up.sql', import.meta.url), 'utf8');
    await pool.query(migration.slice(0, migration.indexOf('CREATE TABLE IF NOT EXISTS outbox_events')) + 'COMMIT;');
    // The first gateway dies inside the owner calls: its bootstrap and its Stop never return.
    const crashed = makeRuntime({ operationReceipts: createRealtimePublicOperationReceipts(pool), bootstrapGate: never, stopClaimGate: never });
    void crashed.runtime.bootstrap(BASE_REQUEST, bearer).catch(() => undefined);
    void crashed.runtime.stop(STOP_REQUEST, bearer).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 200));
    const claims = (await pool.query("SELECT scope, status FROM idempotency_ledger ORDER BY scope")).rows;
    assert.deepEqual(claims.map((row: { status: string }) => row.status), ['in_flight', 'in_flight']);
    // The restarted gateway: a just-made claim may still be live and is refused, never stolen.
    let innerStopBusy = true;
    const restarted = makeRuntime({ operationReceipts: createRealtimePublicOperationReceipts(pool, { staleClaimSeconds: 1 }),
      stopClaimGate: async () => { if (innerStopBusy) throw Object.assign(new Error('T11B_ADAPTER_IDEMPOTENCY_IN_FLIGHT'), { code: 'T11B_ADAPTER_IDEMPOTENCY_IN_FLIGHT', status: 503 }); } });
    await assert.rejects(restarted.runtime.stop(STOP_REQUEST, bearer), /PUBLIC_OPERATION_RECEIPT_IN_FLIGHT/);
    await assert.rejects(restarted.runtime.bootstrap(BASE_REQUEST, bearer), /PUBLIC_OPERATION_RECEIPT_IN_FLIGHT/);
    await stale();
    // Stop: the outer claim no longer stands in front of the coordinator. While the inner attempt is itself still in
    // flight the outcome is an explicit unknown; once the coordinator takes over its stalled attempt, Stop completes.
    await assert.rejects(restarted.runtime.stop(STOP_REQUEST, bearer), (error: Error & { operation_outcome?: string }) => error.operation_outcome === 'unknown');
    innerStopBusy = false;
    const stopped = await restarted.runtime.stop(STOP_REQUEST, bearer);
    assert.equal(stopped.operation, 'media_stop');
    assert.equal(restarted.state.stopCalls(), 4, 'every cleanup stage ran under the recovered claim');
    assert.deepEqual(await makeRuntime({ operationReceipts: createRealtimePublicOperationReceipts(pool), rejectCurrentState: () => true }).runtime.stop(STOP_REQUEST, bearer), stopped);
    // Bootstrap: recovered by re-running under T11B (which replays its session); this process now serves the binding.
    const accepted = await restarted.runtime.bootstrap(BASE_REQUEST, bearer);
    assert.equal(accepted.status, 'bootstrap_accepted');
    assert.equal(restarted.state.connects(), 1, 'the recovered bootstrap connected the gateway participant here');
    assert.equal((await restarted.runtime.refresh(REFRESH_REQUEST, bearer)).status, 'credential_refreshed', 'and the binding is known to this process');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM idempotency_ledger WHERE status = 'in_flight'")).rows[0].n, 0);
    // End-continuity: the first call ends it; its retry (lost response) replays the durable terminal although the owner
    // would now refuse the ended continuity, and never runs the owner again.
    const END = { operation: 'end_continuity', request_id: 'end-1', idempotency_context: { ...IDEMPOTENCY, idempotency_key: 'end-1' }, realtime_session_ref: REF, continuity_id: CONTINUITY, connection_epoch: '1', confirmation: 'explicit_user_end_continuity', governance: GOVERNANCE };
    let ended = false;
    const ender = makeRuntime({ operationReceipts: createRealtimePublicOperationReceipts(pool), rejectCurrentState: () => ended });
    const terminal = await ender.runtime.endContinuity(END, bearer);
    ended = true;
    assert.deepEqual(await ender.runtime.endContinuity(END, bearer), terminal);
    assert.deepEqual(await makeRuntime({ operationReceipts: createRealtimePublicOperationReceipts(pool), rejectCurrentState: () => true }).runtime.endContinuity(END, bearer), terminal);
    assert.equal(ender.state.endCalls(), 1);
    await assert.rejects(ender.runtime.endContinuity({ ...END, request_id: 'end-2' }, bearer), /IDEMPOTENCY_CONFLICT/);
    await Promise.all([restarted.runtime.close(), ender.runtime.close()]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('central metadata comes only from successful attached source hook and actual gateway authority; legacy stays absent', async()=>{
  const request={...BASE_REQUEST,requested_media:{data:true,audio:false,video:false},start:{...START,modalities:['data']}};
  const descriptor={inputTopic:'paios.central.text.v1',outputTopic:'paios.central.sealed-text.v1',maxPacketBytes:12288} as const;
  let evaluations=0,attached=false;
  const envelopeOverride={scope:{device_id:DEVICE,channels:['data'],distribution_mode:'application_controlled_envelope'}};
  const source=makeRuntime({envelopeOverride,rejectCurrentState:()=>{evaluations++;return false;},bootstrapConnected:{centralTextTransport:descriptor,
    assertBootstrapRequest:request=>{const media=request.requested_media as JsonRecord;if(media.audio || media.video)throw new Error('HERMES_TEXT_ONLY_DATA_REQUIRED');},
    onBootstrapConnected:async input=>{assert.equal(input.authority.gateway.identity,'gateway-identity');attached=true;}}});
  await assert.rejects(source.runtime.bootstrap(BASE_REQUEST,bearer),/TEXT_ONLY_DATA/);
  assert.equal(evaluations,0);assert.equal(source.state.connects(),0);
  const result=await source.runtime.bootstrap(request,bearer);assert.equal(attached,true);
  assert.deepEqual(result.central_text_transport,{schema:'paios.central.text-transport.v1',execution_owner:'hermes_text',expected_gateway_identity:'gateway-identity',input_topic:descriptor.inputTopic,output_topic:descriptor.outputTopic,max_packet_bytes:12288});
  const legacy=makeRuntime();assert.equal(Object.hasOwn(await legacy.runtime.bootstrap(BASE_REQUEST,bearer),'central_text_transport'),false);
  const failed=makeRuntime({envelopeOverride,bootstrapConnected:{centralTextTransport:descriptor,onBootstrapConnected:async()=>{throw new Error('ATTACH_FAILED');}}});
  await assert.rejects(failed.runtime.bootstrap(request,bearer),/ATTACH_FAILED/);assert.equal(failed.state.participantDisconnects(),1);
  await Promise.all([source.runtime.close(),legacy.runtime.close(),failed.runtime.close()]);
});


test('runtime forwards host effect boundary; legacy authority calls are always marked before invocation',async()=>{
 const operations:string[]=[];
 const receipts:NonNullable<RealtimePublicControlRuntimeOptions['operationReceipts']>={execute:async(input,fresh,authorize,boundary)=>{assert.equal(boundary,'v1');await authorize?.();let started=false;const result=await fresh(()=>{started=true;});assert(started);operations.push(String(input.request.operation));return result;}};
 const f=makeRuntime({operationReceipts:receipts});
 await f.runtime.bootstrap(BASE_REQUEST,bearer);await f.runtime.stop(STOP_REQUEST,bearer);await f.runtime.handoff(HANDOFF_REQUEST,bearer);assert.deepEqual(operations,['bootstrap','media_stop','handoff']);await f.runtime.close();
});


test('original runtime participant owner is released before central writer drain',async()=>{
 let control:ReturnType<typeof makeRuntime>;
 control=makeRuntime({bootstrapConnected:{onBootstrapConnected:async()=>{},close:async()=>{
   assert.equal(control.state.participantClosed(),1,'FFI participant release precedes source writer drain');
 }}});
 await control.runtime.close();
});


test('bootstrap selects only the authenticated device participant and closes selected participants once', async () => {
  const calls = { connect: 0, close: 0 };
  const selected: LiveKitCloudParticipantPort = {
    connect: async () => { calls.connect += 1; },
    disconnect: async () => undefined,
    snapshot: () => ({ connected: false, transportState: 'disconnected' }),
    close: async () => { calls.close += 1; },
  };
  const devices: string[] = [];
  const h = makeRuntime({ participantForDevice: (deviceId) => { devices.push(deviceId); return selected; } });
  await h.runtime.bootstrap(BASE_REQUEST, bearer);
  assert.deepEqual(devices, [bearer.deviceId]);
  assert.equal(calls.connect, 1);
  assert.equal(h.state.connects(), 0);
  assert.equal(h.state.participantDisconnects(), 0);
  await h.runtime.close();
  assert.equal(calls.close, 1);
  assert.equal(h.state.participantClosed(), 1);
});


test('bootstrap rejects an absent paired participant before authority effects', async () => {
  const h=makeRuntime({participantForDevice:()=>undefined});
  await assert.rejects(h.runtime.bootstrap(BASE_REQUEST,bearer),/REALTIME_PARTICIPANT_DEVICE_REQUIRED/);
  assert.equal(h.state.connects(),0);assert.equal(h.state.credentialCalls(),0);
  await h.runtime.close();
});

test('bootstrap uses the source terminal transport descriptor', async () => {
  const h=makeRuntime({bootstrapConnected:{
    centralTextTransport:{inputTopic:'paios.central.text.v1',outputTopic:'paios.central.sealed-text.v1',maxPacketBytes:12288,voiceTransport:'wav_byte_stream_v1',callRejoinWindowS:42},
    centralTextTransportForDevice:deviceId=>{assert.equal(deviceId,bearer.deviceId);return {inputTopic:'paios.central.text.v1',outputTopic:'paios.central.sealed-text.v1',maxPacketBytes:12288,callRejoinWindowS:37};},
    onBootstrapConnected:async()=>undefined,
  }});
  const result=await h.runtime.bootstrap(BASE_REQUEST,bearer);
  assert.equal((result.central_text_transport as JsonRecord).voice_transport,undefined);
  assert.equal((result.central_text_transport as JsonRecord).call_rejoin_window_s,37);
  await h.runtime.close();
});

test('reliable bootstrap carries the server window and refresh exposes only the current lost call deadline',async t=>{
  const current={call_id:'current-lost-call',rejoin_deadline:'2026-10-16T01:00:00.000Z'};let lost=true;
  const h=makeRuntime({bootstrapConnected:{onBootstrapConnected:async()=>{},
    centralTextTransport:{inputTopic:'paios.central.text.v1',outputTopic:'paios.central.sealed-text.v1',maxPacketBytes:12288,callRejoinWindowS:7},
    callRejoinForDevice:deviceId=>{assert.equal(deviceId,bearer.deviceId);return lost?current:undefined;}}});t.after(()=>h.runtime.close());
  const schemas=createRealtimeSchemaRegistry(),opened=await h.runtime.bootstrap(BASE_REQUEST,bearer);
  assert.equal((opened.central_text_transport as JsonRecord).call_rejoin_window_s,7);
  const refreshed=await h.runtime.refresh(REFRESH_REQUEST,bearer);assert.deepEqual(refreshed.call_rejoin,current);
  const fixture=JSON.parse(await readFile(new URL('../../../tests/contracts/fixtures/realtime-public-control/credential-refresh.valid.json',import.meta.url),'utf8'));
  const envelope={...refreshed,request_id:fixture.request_id,governance:fixture.governance,transport_aliases:fixture.transport_aliases};
  assert.equal(schemas.validateResponse('connected_credential_refresh',envelope),true);
  assert.equal(schemas.validateResponse('connected_credential_refresh',{...envelope,call_rejoin:{...current,rejoin_deadline:'invalid'}}),false);
  lost=false;assert.equal(Object.hasOwn(await h.runtime.refresh({...REFRESH_REQUEST,request_id:'recovered'},bearer),'call_rejoin'),false);
});

test('the production bootstrap aggregate keeps the call owner rejoin deadline in refresh',async t=>{
  const current={call_id:'aggregate-lost-call',rejoin_deadline:'2026-10-16T01:00:00.000Z'};let lost=true,connected=0;
  const assistant:RealtimeBootstrapConnectedPort={onBootstrapConnected:async()=>{connected++;},
    centralTextTransport:{inputTopic:'paios.central.text.v1',outputTopic:'paios.central.sealed-text.v1',maxPacketBytes:12288,callRejoinWindowS:120},
    callRejoinForDevice:deviceId=>{assert.equal(deviceId,bearer.deviceId);return lost?current:undefined;}};
  const h=makeRuntime({bootstrapConnected:createProductionBootstrapConnectedOwner(undefined,assistant)});t.after(()=>h.runtime.close());
  const opened=await h.runtime.bootstrap(BASE_REQUEST,bearer);
  assert.equal((opened.central_text_transport as JsonRecord).call_rejoin_window_s,120);assert.equal(connected,1);
  assert.deepEqual((await h.runtime.refresh(REFRESH_REQUEST,bearer)).call_rejoin,current);
  lost=false;assert.equal(Object.hasOwn(await h.runtime.refresh({...REFRESH_REQUEST,request_id:'recovered'},bearer),'call_rejoin'),false);
});


test('credential refresh reattaches the same accepted source and reacquires a lost gateway transport',async t=>{
  let connected=true;const attachments:RealtimeBootstrapConnectedInput[]=[];
  const h=makeRuntime({participantConnected:()=>connected,bootstrapConnected:{onBootstrapConnected:async input=>{attachments.push(input);}}});
  t.after(()=>h.runtime.close());await h.runtime.bootstrap(BASE_REQUEST,bearer);
  assert.equal(attachments.length,1);const original=attachments[0]!;
  connected=false;await h.runtime.refresh(REFRESH_REQUEST,bearer);
  assert.equal(h.state.connects(),2);assert.equal(attachments.length,2);
  assert.deepEqual(attachments[1]!.currentBinding,original.currentBinding);
  assert.equal(attachments[1]!.request,original.request,'rejoin reuses the accepted bootstrap authority; no new call/continuity');
  assert.equal(attachments[1]!.authority.credential_generation,'2');
  assert.equal(h.state.participantDisconnects(),0,'no stop or second logical session');
});

// Regression: the gateway's SDK room had been disconnected client-side once (rtc-node's
// Room.disconnect() ends with removeAllListeners()), rejoined, and then lost again. The participant missed the second loss,
// so every refresh skipped the rejoin and the PCM attach answered a retryable 503 FORMAL_PCM_ROOM_REQUIRED for 2.5 minutes.
test('refresh rejoins a gateway room lost after an earlier client-side disconnect on the same SDK room',async t=>{
  class SdkRoom extends EventEmitter {
    isConnected=false;connects=0;remoteParticipants=new Map();
    async connect(){this.connects+=1;this.isConnected=true;}
    // As rtc-node 0.13.32: emit Disconnected, then drop every listener (the participant's own included).
    async disconnect(){if(!this.isConnected)return;this.lose();this.removeAllListeners();}
    lose(){this.isConnected=false;this.emit('disconnected');}
  }
  const room=new SdkRoom(),participant=new LiveKitCloudParticipant(room as unknown as LiveKitCloudRoomPort);
  const pcmAttach=async()=>{if(room.isConnected===false)throw Object.assign(new Error('FORMAL_PCM_ROOM_REQUIRED'),{status:503});};
  const h=makeRuntime({participantForDevice:()=>participant,bootstrapConnected:{onBootstrapConnected:pcmAttach}});
  t.after(()=>h.runtime.close());
  await h.runtime.bootstrap(BASE_REQUEST,bearer);
  await room.disconnect();                                    // a consumer leaves the room directly (terminal wire)
  await h.runtime.refresh(REFRESH_REQUEST,bearer);            // observed: refresh rejoins
  assert.equal(room.connects,2);
  room.lose();                                                // server-side removal after that rejoin
  await h.runtime.refresh({...REFRESH_REQUEST,request_id:'refresh-after-second-loss'},bearer);
  assert.equal(room.connects,3,'the second loss is observed, so refresh rejoins before the source attach');
});

test('concurrent credential refreshes on the same binding do not report owner revocation',async t=>{
  const held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let hold=false,once=false;
  const h=makeRuntime({signGate:async()=>{if(hold&&!once){once=true;entered.resolve();await held.promise;}}});
  t.after(()=>h.runtime.close());await h.runtime.bootstrap(BASE_REQUEST,bearer);hold=true;
  const first=h.runtime.refresh(REFRESH_REQUEST,bearer);await entered.promise;
  const second=await h.runtime.refresh({...REFRESH_REQUEST,request_id:'parallel-refresh'},bearer);
  held.resolve();assert.equal((await first).status,'credential_refreshed');assert.equal(second.status,'credential_refreshed');
});
