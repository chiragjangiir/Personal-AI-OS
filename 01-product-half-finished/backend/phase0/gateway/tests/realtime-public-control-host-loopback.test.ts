import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import {
  RealtimePublicControlController,
  createRealtimeSchemaRegistry,
  type RealtimePublicControlBearerPort,
  type RealtimePublicControlEdgePort,
} from '../src/realtime-public-control-controller.ts';
import {
  RealtimePublicControlRuntime,
  type JsonRecord,
  type RealtimeBootstrapAuthorityResult,
  type RealtimePublicControlRuntimeOptions,
} from '../src/realtime-public-control-runtime.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import type {
  LiveKitCloudGrantInput,
  LiveKitCloudTokenInput,
  LiveKitCloudTokenSignerPort,
} from '../src/livekit-cloud-token-signer.ts';

const CONTROL_HOST = 'ai.example.invalid';
const CONTROL_CAPABILITY_VALUE = 'fixture-control-capability-opaque';
const FIXTURE_NOW = Date.parse('2026-08-22T12:00:00Z');
const PROJECT_URL = 'wss://project.livekit.cloud';

type Binding = {
  readonly session: unknown;
  readonly lease: unknown;
  readonly continuity: string;
  readonly epoch: string;
  readonly aliases: readonly unknown[];
};

type BindingTransition = NonNullable<RealtimeBootstrapAuthorityResult['binding_transition']>;

type HttpResult = {
  readonly status: number;
  readonly body: string;
};

type FixtureState = {
  edgeCalls: number;
  bearerCalls: number;
  ownerBootstrapCalls: number;
  ownerRefreshCalls: number;
  ownerEndCalls: number;
  e2eeCalls: number;
  participantConnects: number;
  participantDisconnects: number;
  stopClaims: number;
  stopCompleteCalls: number;
  stopStageCalls: number;
  endCalls: number;
  signedCalls: number;
  e2eeIssued: number;
  e2eeReleases: number;
  participantClosed: number;
  e2eeClosed: number;
  mediaStopClosed: number;
  sessionsClosed: number;
  ciphertextClosed: number;
  signerClosed: number;
  authorizedDeviceId: string;
  lastStopResult: JsonRecord | undefined;
};

type Harness = {
  readonly port: number;
  readonly server: Server;
  readonly controller: RealtimePublicControlController;
  readonly state: FixtureState;
  close(): Promise<void>;
};

function fixture(name: string): JsonRecord {
  const path = new URL(`../../../tests/contracts/fixtures/realtime-public-control/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

const bootstrapFixture = fixture('bootstrap-request.valid.json');
const bootstrapResponseFixture = fixture('bootstrap-response.valid.json');
const refreshFixture = fixture('credential-refresh.valid.json');
const e2eeFixture = fixture('e2ee-key-resolve.valid.json');
const stopFixture = fixture('media-stop.valid.json');

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FIXTURE_RECORD_REQUIRED');
  return value as JsonRecord;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('FIXTURE_ARRAY_REQUIRED');
  return value;
}

function clone(value: JsonRecord): JsonRecord {
  return structuredClone(value) as JsonRecord;
}

function refForSecondBinding(value: unknown, finalHex: string): unknown {
  const result = clone(record(value));
  if (typeof result.ref_id === 'string' && result.ref_id.length > 0) {
    result.ref_id = `${result.ref_id.slice(0, -1)}${finalHex}`;
  }
  result.object_version = '2';
  result.canonical_payload_sha256 = 'f'.repeat(64);
  return result;
}

function aliasesForSecondBinding(values: readonly unknown[]): readonly unknown[] {
  return values.map((value, index) => {
    const alias = clone(record(value));
    if (typeof alias.value === 'string') alias.value = `${alias.value}-second`;
    else alias.value = `fixture-alias-second-${index}`;
    return alias;
  });
}

function requestedMedia(request: JsonRecord): { readonly audio: boolean; readonly video: boolean; readonly data: boolean } {
  const value = record(request.requested_media);
  return { audio: value.audio === true, video: value.video === true, data: value.data === true };
}

function grant(
  room: string,
  requested: { readonly audio: boolean; readonly video: boolean; readonly data: boolean },
  publish: boolean,
): LiveKitCloudGrantInput {
  const sources: ('microphone' | 'camera')[] = publish ? [
    ...(requested.audio ? ['microphone' as const] : []),
    ...(requested.video ? ['camera' as const] : []),
  ] : [];
  return {
    room,
    roomJoin: true,
    canPublish: publish,
    canSubscribe: true,
    canPublishData: requested.data,
    canPublishSources: sources,
  };
}

function mediaGrants(request: JsonRecord, lease: unknown): JsonRecord {
  const requested = requestedMedia(request);
  const requestStart = record(request.start);
  const start: JsonRecord = {
    kind: requestStart.kind,
    device_id: requestStart.device_id,
    modalities: requestStart.modalities,
  };
  const deviceId = String(request.device_id);
  const result: JsonRecord = {};
  for (const modality of ['audio', 'video', 'data'] as const) {
    if (!requested[modality]) {
      result[modality] = { enabled: false };
      continue;
    }
    result[modality] = {
      enabled: true,
      device_id: deviceId,
      device_lease_ref: lease,
      start_binding: start,
      expires_at: '2026-08-22T12:14:00Z',
    };
  }
  return result;
}

function authorityFor(request: JsonRecord, binding: Binding, transition?: BindingTransition): RealtimeBootstrapAuthorityResult {
  const requested = requestedMedia(request);
  const governance = record(request.governance);
  const authority = {
    realtime_session_ref: binding.session,
    device_lease_ref: binding.lease,
    continuity_id: binding.continuity,
    transport_aliases: binding.aliases,
    connection_epoch: binding.epoch,
    server_url: PROJECT_URL,
    credential_expires_at: '2026-08-22T12:15:00Z',
    continuity_expires_at: '2026-08-22T12:30:00Z',
    terminal_room_name: 'fixture-terminal-room',
    terminal_identity: 'fixture-terminal-identity',
    terminal_grants: grant('fixture-terminal-room', requested, requested.audio || requested.video),
    media_grants: mediaGrants(request, binding.lease),
    governance,
    gateway: {
      roomName: 'fixture-gateway-room',
      identity: 'fixture-gateway-identity',
      grants: grant('fixture-gateway-room', requested, false),
    },
  };
  if (transition === undefined) return authority;
  return {
    ...authority,
    binding_transition: transition,
  };
}

function terminalResult(operation: 'media_stop' | 'end_continuity', request: JsonRecord): JsonRecord {
  const outcome = {
    outcome_class: 'committed_success',
    recorded_result_ref: {
      idempotency_context: request.idempotency_context,
      fencing_epoch: '1',
      outcome_class: 'committed_success',
      result_schema_id: 'https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json',
      result_schema_version: '1.0.0',
      result_schema_sha256: '3'.repeat(64),
      result_payload_sha256: '4'.repeat(64),
    },
    resolution_mode: 'direct',
  };
  return {
    operation,
    status: 'success',
    request_id: request.request_id,
    ...(request.realtime_session_ref === undefined ? {} : { realtime_session_ref: request.realtime_session_ref }),
    ...(request.device_lease_ref === undefined ? {} : { device_lease_ref: request.device_lease_ref }),
    continuity_id: request.continuity_id,
    ...(request.connection_epoch === undefined ? {} : { connection_epoch: request.connection_epoch }),
    operation_outcome: outcome,
    execution_facts: {
      closure_status: 'verified_closed',
      device_lease_release: 'released',
      participant_cleanup: 'verified_absent',
      track_cleanup: 'verified_absent',
      room_cleanup: 'verified_absent',
    },
    governance: request.governance,
  };
}

function bindingFromFixture(): Binding {
  return {
    session: refreshFixture.realtime_session_ref,
    lease: refreshFixture.device_lease_ref,
    continuity: String(refreshFixture.continuity_id),
    epoch: String(refreshFixture.connection_epoch),
    aliases: array(refreshFixture.transport_aliases),
  };
}

function secondBindingFrom(initial: Binding): Binding {
  return {
    session: refForSecondBinding(initial.session, 'a'),
    lease: refForSecondBinding(initial.lease, 'b'),
    continuity: initial.continuity,
    epoch: '2',
    aliases: aliasesForSecondBinding(initial.aliases),
  };
}

function requestWithBinding(base: JsonRecord, binding: Binding): JsonRecord {
  const result = clone(base);
  result.realtime_session_ref = binding.session;
  result.device_lease_ref = binding.lease;
  result.continuity_id = binding.continuity;
  result.transport_aliases = binding.aliases;
  result.connection_epoch = binding.epoch;
  return result;
}

function makeEndContinuityRequest(binding: Binding): JsonRecord {
  const result = clone(stopFixture);
  for (const key of ['device_lease_ref', 'transport_aliases', 'reason', 'release_scope']) delete result[key];
  result.operation = 'end_continuity';
  result.request_id = 'fixture-end-continuity-1';
  const idempotency = clone(record(result.idempotency_context));
  idempotency.idempotency_key = result.request_id;
  result.idempotency_context = idempotency;
  result.confirmation = 'explicit_user_end_continuity';
  result.realtime_session_ref = binding.session;
  result.continuity_id = binding.continuity;
  result.connection_epoch = binding.epoch;
  return result;
}

function makeFullyDisconnectedBootstrap(binding: Binding): JsonRecord {
  const result = clone(bootstrapFixture);
  result.bootstrap_mode = 'fully_disconnected';
  result.request_id = 'fixture-bootstrap-fully-disconnected-1';
  const idempotency = clone(record(result.idempotency_context));
  idempotency.idempotency_key = result.request_id;
  result.idempotency_context = idempotency;
  result.continuity_id = binding.continuity;
  result.transport_aliases = binding.aliases;
  return result;
}

function makeEdgeError(code: string, status: number): Error & { readonly status: number } {
  const error = new Error(code) as Error & { status: number };
  error.status = status;
  return error;
}

function headerValues(rawHeaders: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === name.toLowerCase()) values.push(rawHeaders[index + 1]!);
  }
  return values;
}

function createFixtureState(): FixtureState {
  return {
    edgeCalls: 0,
    bearerCalls: 0,
    ownerBootstrapCalls: 0,
    ownerRefreshCalls: 0,
    ownerEndCalls: 0,
    e2eeCalls: 0,
    participantConnects: 0,
    participantDisconnects: 0,
    stopClaims: 0,
    stopCompleteCalls: 0,
    stopStageCalls: 0,
    endCalls: 0,
    signedCalls: 0,
    e2eeIssued: 0,
    e2eeReleases: 0,
    participantClosed: 0,
    e2eeClosed: 0,
    mediaStopClosed: 0,
    sessionsClosed: 0,
    ciphertextClosed: 0,
    signerClosed: 0,
    authorizedDeviceId: String(bootstrapFixture.device_id),
    lastStopResult: undefined,
  };
}

function createFixtureRuntime(state: FixtureState, includeDeviceCredential = true): RealtimePublicControlRuntime {
  const initial = bindingFromFixture();
  const second = secondBindingFrom(initial);
  const bootstrapQueue = [
    authorityFor(bootstrapFixture, initial),
    authorityFor(makeFullyDisconnectedBootstrap(initial), second, {
      atomic: true,
      previous_connection_epoch: initial.epoch,
      previous_realtime_session_ref: initial.session,
      previous_device_lease_ref: initial.lease,
      previous_transport_aliases: initial.aliases,
      previous_continuity_expires_at: '2026-08-22T12:30:00Z',
      provider_session_reused: false,
    }),
  ];
  const participant: LiveKitCloudParticipantPort = {
    async connect() { state.participantConnects += 1; },
    async disconnect() { state.participantDisconnects += 1; },
    snapshot: () => ({ connected: true, transportState: 'connected' }),
    async close() { state.participantClosed += 1; },
  };
  const signer: LiveKitCloudTokenSignerPort = {
    assertProjectUrl(projectUrl) { if (projectUrl !== PROJECT_URL) throw new Error('FIXTURE_PROJECT_BINDING'); },
    async sign(_input: LiveKitCloudTokenInput) {
      state.signedCalls += 1;
      return `fixture-signed-value-${state.signedCalls}`;
    },
    close() { state.signerClosed += 1; },
  };
  const options: RealtimePublicControlRuntimeOptions = {
    governance: {
      async evaluate(input) { return { accepted: true, refs: record(input.request.governance) }; },
    },
    sessions: {
      async bootstrap() {
        state.ownerBootstrapCalls += 1;
        const next = bootstrapQueue.shift();
        if (next === undefined) throw new Error('FIXTURE_BOOTSTRAP_QUEUE_EXHAUSTED');
        return next;
      },
      async refresh(input) {
        state.ownerRefreshCalls += 1;
        const request = input.request;
        const requested = requestedMedia(bootstrapFixture);
        return {
          realtime_session_ref: request.realtime_session_ref,
          device_lease_ref: request.device_lease_ref,
          continuity_id: request.continuity_id as string,
          transport_aliases: array(request.transport_aliases),
          connection_epoch: request.connection_epoch as string,
          credential_expires_at: '2026-08-22T12:14:00Z',
          credential_generation: '2',
          credential_input: {
            room: 'fixture-terminal-room',
            identity: 'fixture-terminal-identity',
            ttlSeconds: 839,
            grants: grant('fixture-terminal-room', requested, requested.audio || requested.video),
          },
          governance: record(request.governance),
        };
      },
      async endContinuity(input) {
        state.ownerEndCalls += 1;
        return terminalResult('end_continuity', input.request);
      },
      async close() { state.sessionsClosed += 1; },
    },
    mediaStop: {
      async claim() {
        state.stopClaims += 1;
        if (state.lastStopResult !== undefined) return { claimId: 'fixture-replay-claim', alreadyCompleted: state.lastStopResult };
        return { claimId: 'fixture-stop-claim' };
      },
      async unpublishAllTracks() { state.stopStageCalls += 1; },
      async disconnectParticipant() { state.stopStageCalls += 1; },
      async revokeCredential() { state.stopStageCalls += 1; },
      async verifyMediaClosed() { state.stopStageCalls += 1; },
      async complete(_claimId, _facts) {
        state.stopCompleteCalls += 1;
        const request = requestWithBinding(stopFixture, second);
        state.lastStopResult = terminalResult('media_stop', request);
        return state.lastStopResult;
      },
      async close() { state.mediaStopClosed += 1; },
    },
    e2ee: {
      async issue(input) {
        state.e2eeIssued += 1;
        const envelopeFixture = record(bootstrapResponseFixture.e2ee_key_envelope);
        return {
          envelope: {
            key_envelope_ref: envelopeFixture.key_envelope_ref,
            key_index: 0,
            key_generation: '1',
            expires_at: '2026-08-22T12:10:00Z',
            scope: {
              device_id: String(bootstrapFixture.device_id),
              channels: ['audio', 'video', 'data'],
              distribution_mode: 'application_controlled_envelope',
            },
            realtime_session_ref: input.realtimeSessionRef,
            continuity_id: input.continuityId,
            governance: input.governance,
          },
          roomOptions: { encryption: { keyProviderOptions: {} } },
          release: () => { state.e2eeReleases += 1; },
        };
      },
      close() { state.e2eeClosed += 1; },
    },
    e2eeCiphertext: {
      async resolve(input) {
        state.e2eeCalls += 1;
        const request = input.request;
        return {
          operation: 'realtime_e2ee_key_resolve',
          status: 'key_resolved',
          request_id: request.request_id,
          idempotency_context: request.idempotency_context,
          realtime_session_ref: request.realtime_session_ref,
          device_lease_ref: request.device_lease_ref,
          continuity_id: request.continuity_id,
          connection_epoch: request.connection_epoch,
          transport_aliases: request.transport_aliases,
          key_envelope_ref: request.key_envelope_ref,
          key_index: request.key_index,
          key_generation: request.key_generation,
          device_id: request.device_id,
          recipient_device_credential_ref: request.recipient_device_credential_ref,
          participant_audience: request.participant_audience,
          expires_at: '2026-08-22T12:10:00Z',
          cipher_suite: 'DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM',
          encapsulated_key: 'fixture-encapsulated-value',
          ciphertext: 'fixture-ciphertext-value',
          aad_sha256: 'c'.repeat(64),
          governance: input.governance,
        };
      },
      close() { state.ciphertextClosed += 1; },
    },
    tokenSigner: signer,
    participant,
    ...(includeDeviceCredential ? { deviceCredential: {
      async resolve() { return e2eeFixture.recipient_device_credential_ref as JsonRecord; },
    } } : {}),
    now: () => FIXTURE_NOW,
  };
  return new RealtimePublicControlRuntime(options);
}

function createFixtureController(state: FixtureState): RealtimePublicControlController {
  const edge: RealtimePublicControlEdgePort = {
    async authorize(input) {
      state.edgeCalls += 1;
      const host = headerValues(input.rawHeaders, 'host');
      if (input.method !== 'POST' || input.url.includes('?') || input.remoteAddress !== '127.0.0.1') {
        throw makeEdgeError('FIXTURE_EDGE_REQUEST_REJECTED', 403);
      }
      if (host.length !== 1 || host[0] !== CONTROL_HOST || input.controlHost !== CONTROL_HOST) {
        throw makeEdgeError('FIXTURE_EDGE_HOST_REJECTED', 421);
      }
      for (const name of ['upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'content-encoding']) {
        if (headerValues(input.rawHeaders, name).length !== 0) throw makeEdgeError('FIXTURE_EDGE_HEADER_REJECTED', 400);
      }
      const connection = headerValues(input.rawHeaders, 'connection');
      if (connection.length > 1 || (connection.length === 1 && connection[0]!.toLowerCase() !== 'keep-alive')) {
        throw makeEdgeError('FIXTURE_EDGE_CONNECTION_REJECTED', 400);
      }
    },
  };
  const bearer: RealtimePublicControlBearerPort = {
    async authorize(input) {
      state.bearerCalls += 1;
      if (input.token !== CONTROL_CAPABILITY_VALUE) throw makeEdgeError('FIXTURE_BEARER_REJECTED', 401);
      return { principal: 'fixture-principal', deviceId: state.authorizedDeviceId };
    },
  };
  return new RealtimePublicControlController({
    enabled: true,
    controlHost: CONTROL_HOST,
    edge,
    bearer,
    runtime: createFixtureRuntime(state),
    schemaRegistry: createRealtimeSchemaRegistry(),
  });
}

async function startHarness(): Promise<Harness> {
  const state = createFixtureState();
  const controller = createFixtureController(state);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const handled = await controller.handle(request, response);
      if (!handled && !response.writableEnded) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"NOT_FOUND"}');
      }
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end('{"error":"FAILED"}');
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('FIXTURE_LISTENER_ADDRESS_INVALID');
  const port = address.port;
  let closed = false;
  return {
    port,
    server,
    controller,
    state,
    async close() {
      if (closed) return;
      closed = true;
      await controller.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      await assertPortClosed(port);
    },
  };
}

async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('FIXTURE_LOOPBACK_PORT_STILL_OPEN'));
    });
    socket.once('error', () => resolve());
  });
}

async function sendHttp(
  port: number,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly host?: string;
    readonly contentType?: string;
    readonly authorization?: string;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } = {},
): Promise<HttpResult> {
  const method = options.method ?? 'POST';
  const payload = options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  const headers: Record<string, string> = {
    Host: options.host ?? CONTROL_HOST,
    Connection: 'keep-alive',
  };
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  headers.Authorization = options.authorization ?? `Bearer ${CONTROL_CAPABILITY_VALUE}`;
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers[name] = value;
  return await new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        response.socket?.destroy();
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function responseRecord(result: HttpResult): JsonRecord {
  return record(JSON.parse(result.body) as unknown);
}

function assertStatus(result: HttpResult, expected: number): void {
  if (result.status === expected) return;
  let safeCode = 'NO_SAFE_ERROR_CODE';
  try {
    const candidate = responseRecord(result).error;
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(candidate)) safeCode = candidate;
  } catch {
    // Keep assertion output free of response material.
  }
  assert.equal(result.status, expected, safeCode);
}

function assertSafeEqual(actual: unknown, expected: unknown, code: string): void {
  try {
    assert.equal(actual, expected);
  } catch {
    throw new Error(code);
  }
}

function assertSafeDeepEqual(actual: unknown, expected: unknown, code: string): void {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(code);
  }
}

function assertSafeNotDeepEqual(actual: unknown, expected: unknown, code: string): void {
  try {
    assert.notDeepEqual(actual, expected);
  } catch {
    throw new Error(code);
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, child]) => name === key || containsKey(child, key));
}

test('host-loopback listener and strict edge/header/body/bearer/device boundary', async () => {
  const harness = await startHarness();
  try {
    const address = harness.server.address();
    assert.equal(typeof address, 'object');
    assert.equal((address as { readonly address: string }).address, '127.0.0.1');
    assert.equal((address as { readonly port: number }).port, harness.port);

    const invalidHost = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: bootstrapFixture, host: '127.0.0.1' });
    assertStatus(invalidHost, 421);
    const invalidContentType = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: bootstrapFixture, contentType: 'text/plain' });
    assertStatus(invalidContentType, 400);
    const invalidJson = await sendHttp(harness.port, '/v1/realtime/bootstrap', { rawBody: '{x' });
    assertStatus(invalidJson, 400);
    const forwardingHeader = await sendHttp(harness.port, '/v1/realtime/bootstrap', {
      body: bootstrapFixture,
      extraHeaders: { 'X-Forwarded-For': '127.0.0.1' },
    });
    assertStatus(forwardingHeader, 400);
    const contentEncoding = await sendHttp(harness.port, '/v1/realtime/bootstrap', {
      body: bootstrapFixture,
      extraHeaders: { 'Content-Encoding': 'gzip' },
    });
    assertStatus(contentEncoding, 400);
    const illegalConnection = await sendHttp(harness.port, '/v1/realtime/bootstrap', {
      body: bootstrapFixture,
      extraHeaders: { Connection: 'keep-alive, upgrade' },
    });
    assertStatus(illegalConnection, 400);
    const invalidBearer = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: bootstrapFixture, authorization: 'Bearer short' });
    assertStatus(invalidBearer, 401);
    harness.state.authorizedDeviceId = 'fixture-other-device';
    const wrongDevice = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: bootstrapFixture });
    assertStatus(wrongDevice, 403);
    harness.state.authorizedDeviceId = String(bootstrapFixture.device_id);
    assert.equal(harness.state.ownerBootstrapCalls, 0);

    const beforeUnknown = harness.state.edgeCalls;
    const beforeUnknownOwners = harness.state.ownerBootstrapCalls;
    const queryTarget = await sendHttp(harness.port, '/v1/realtime/bootstrap?probe=1', { method: 'POST' });
    const unknown = await sendHttp(harness.port, '/v1/realtime/not-a-successor', { method: 'POST' });
    const rtc = await sendHttp(harness.port, '/rtc', { method: 'POST' });
    assertStatus(queryTarget, 404);
    assertStatus(unknown, 404);
    assertStatus(rtc, 404);
    assert.equal(harness.state.edgeCalls, beforeUnknown);
    assert.equal(harness.state.ownerBootstrapCalls, beforeUnknownOwners);
  } finally {
    await harness.close();
  }
});

test('five successor POSTs exercise initial, connected refresh, disconnected bootstrap, and ciphertext-only resolve', async () => {
  const harness = await startHarness();
  try {
    const initialBinding = bindingFromFixture();
    const secondBinding = secondBindingFrom(initialBinding);
    const initial = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: bootstrapFixture });
    assertStatus(initial, 200);
    const initialBody = responseRecord(initial);
    assert.equal(initialBody.status, 'bootstrap_accepted');
    assert.equal(typeof record(initialBody.livekit).participant_token, 'string');

    const refreshRequest = requestWithBinding(refreshFixture, initialBinding);
    const refresh = await sendHttp(harness.port, '/v1/realtime/credentials/refresh', { body: refreshRequest });
    assertStatus(refresh, 200);
    const refreshBody = responseRecord(refresh);
    assert.equal(refreshBody.status, 'credential_refreshed');
    assertSafeDeepEqual(refreshBody.realtime_session_ref, initialBinding.session, 'REFRESH_SESSION_BINDING_INVALID');
    assertSafeDeepEqual(refreshBody.device_lease_ref, initialBinding.lease, 'REFRESH_LEASE_BINDING_INVALID');
    assertSafeEqual(refreshBody.continuity_id, initialBinding.continuity, 'REFRESH_CONTINUITY_BINDING_INVALID');
    assertSafeEqual(refreshBody.connection_epoch, initialBinding.epoch, 'REFRESH_EPOCH_BINDING_INVALID');
    assertSafeDeepEqual(refreshBody.transport_aliases, initialBinding.aliases, 'REFRESH_ALIASES_BINDING_INVALID');
    const refreshedCredential = record(refreshBody.transport_credential);
    assert.equal(typeof refreshedCredential.credential, 'string');
    assertSafeEqual(refreshedCredential.credential_generation, '2', 'REFRESH_GENERATION_INVALID');

    const e2eeRequestFixture = clone(e2eeFixture);
    for (const key of ['status', 'expires_at', 'cipher_suite', 'encapsulated_key', 'ciphertext', 'aad_sha256']) delete e2eeRequestFixture[key];
    const e2eeRequest = requestWithBinding(e2eeRequestFixture, initialBinding);
    const resolve = await sendHttp(harness.port, '/v1/realtime/e2ee/key/resolve', { body: e2eeRequest });
    assertStatus(resolve, 200);
    const resolveBody = responseRecord(resolve);
    assert.equal(resolveBody.status, 'key_resolved');
    assert.equal(typeof resolveBody.ciphertext, 'string');
    for (const forbiddenKey of ['plaintext', 'private', 'private_key', 'key_material', 'roomOptions']) {
      assert.equal(containsKey(resolveBody, forbiddenKey), false);
    }

    const disconnectedRequest = makeFullyDisconnectedBootstrap(initialBinding);
    const disconnected = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: disconnectedRequest });
    assertStatus(disconnected, 200);
    const disconnectedBody = responseRecord(disconnected);
    assert.equal(disconnectedBody.bootstrap_mode, 'fully_disconnected');
    assertSafeEqual(disconnectedBody.connection_epoch, secondBinding.epoch, 'DISCONNECTED_EPOCH_INVALID');
    assertSafeNotDeepEqual(disconnectedBody.realtime_session_ref, initialBinding.session, 'DISCONNECTED_SESSION_NOT_ROTATED');
    assertSafeNotDeepEqual(disconnectedBody.device_lease_ref, initialBinding.lease, 'DISCONNECTED_LEASE_NOT_ROTATED');
    assertSafeDeepEqual(disconnectedBody.realtime_session_ref, secondBinding.session, 'DISCONNECTED_SESSION_BINDING_INVALID');
    assertSafeDeepEqual(disconnectedBody.device_lease_ref, secondBinding.lease, 'DISCONNECTED_LEASE_BINDING_INVALID');
    assertSafeNotDeepEqual(disconnectedBody.transport_aliases, initialBinding.aliases, 'DISCONNECTED_ALIASES_NOT_ROTATED');
    assertSafeDeepEqual(disconnectedBody.transport_aliases, secondBinding.aliases, 'DISCONNECTED_ALIASES_BINDING_INVALID');

    assert.equal(harness.state.ownerBootstrapCalls, 2);
    assert.equal(harness.state.ownerRefreshCalls, 1);
    assert.equal(harness.state.e2eeCalls, 1);
    assert.equal(harness.state.participantConnects, 2);
  } finally {
    await harness.close();
  }
});

test('media Stop repeats a complete terminal result, end-continuity stays separate, and close fences the port', async () => {
  const harness = await startHarness();
  try {
    const initialBinding = bindingFromFixture();
    const secondBinding = secondBindingFrom(initialBinding);
    const initial = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: bootstrapFixture });
    assertStatus(initial, 200);
    const disconnected = await sendHttp(harness.port, '/v1/realtime/bootstrap', { body: makeFullyDisconnectedBootstrap(initialBinding) });
    assertStatus(disconnected, 200);

    const stopRequest = requestWithBinding(stopFixture, secondBinding);
    const firstStop = await sendHttp(harness.port, '/v1/realtime/media/stop', { body: stopRequest });
    const replayStop = await sendHttp(harness.port, '/v1/realtime/media/stop', { body: stopRequest });
    assertStatus(firstStop, 200);
    assertStatus(replayStop, 200);
    const firstStopBody = responseRecord(firstStop);
    const replayStopBody = responseRecord(replayStop);
    try {
      assert.deepEqual(replayStopBody, firstStopBody);
    } catch {
      throw new Error('FIXTURE_STOP_REPLAY_NOT_IDENTICAL');
    }
    assert.equal(firstStopBody.status, 'success');
    assert.equal(replayStopBody.status, 'success');
    assert.equal(record(firstStopBody.operation_outcome).outcome_class, 'committed_success');
    assert.equal(record(replayStopBody.execution_facts).closure_status, 'verified_closed');
    assert.equal(harness.state.stopClaims, 2);
    assert.equal(harness.state.stopCompleteCalls, 1);
    assert.equal(harness.state.stopStageCalls, 4);

    const end = await sendHttp(harness.port, '/v1/realtime/end-continuity', { body: makeEndContinuityRequest(secondBinding) });
    assertStatus(end, 200);
    const endBody = responseRecord(end);
    assert.equal(endBody.operation, 'end_continuity');
    assert.equal(endBody.status, 'success');
    assert.equal(harness.state.ownerEndCalls, 1);
  } finally {
    await harness.close();
    assert.equal(harness.state.participantClosed, 1);
    assert.equal(harness.state.e2eeClosed, 1);
    assert.equal(harness.state.mediaStopClosed, 1);
    assert.equal(harness.state.sessionsClosed, 1);
    assert.equal(harness.state.ciphertextClosed, 1);
    assert.equal(harness.state.signerClosed, 1);
  }
});


test('missing device credential owner rejects before signing or connecting', async () => {
  const state = createFixtureState();
  const runtime = createFixtureRuntime(state, false);
  try {
    await assert.rejects(runtime.bootstrap(bootstrapFixture, { principal: 'fixture-principal', deviceId: state.authorizedDeviceId }), /REALTIME_DEVICE_CREDENTIAL_UNAVAILABLE/u);
    assert.equal(state.signedCalls, 0);
    assert.equal(state.participantConnects, 0);
  } finally { await runtime.close(); }
});
