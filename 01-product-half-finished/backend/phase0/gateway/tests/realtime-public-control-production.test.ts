import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRealtimePublicControlProduction,
  REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE,
  type RealtimePublicControlCloudConfig,
  type RealtimePublicControlProduction,
  type RealtimePublicControlProductionPorts,
} from '../src/realtime-public-control-production.ts';
import { startPublicRtcProduction } from '../src/public-rtc-production-entrypoint.ts';
import type { JsonRecord } from '../src/realtime-public-control-runtime.ts';

const CLOUD_URL = 'wss://project.livekit.cloud';
const RESOLVE_GOVERNANCE: JsonRecord = {
  purpose_scopes: ['realtime_audio'],
  consent_record_refs: ['018f0e0e-0000-7000-8000-000000000007'],
  policy_decision_refs: ['018f0e0e-0000-7000-8000-000000000008'],
  purpose_token_refs: ['018f0e0e-0000-7000-8000-000000000009'],
  capability_grant_refs: ['018f0e0e-0000-7000-8000-00000000000a'],
};
const RESOLVE_REQUEST: JsonRecord = {
  operation: 'realtime_e2ee_key_resolve',
  request_id: 'req-test-00000001',
  idempotency_context: {
    idempotency_scope: { owner_module: 'T11B', operation_kind: 'realtime_e2ee_key_resolve', target_object_type: 'RealtimeSession' },
    idempotency_key: 'idem-test-00000001',
    idempotency_profile_id: 'https://personal-ai-os.local/contracts/realtime/realtime-e2ee-key-resolve-request.v1.schema.json',
    idempotency_profile_version: '1.0.0',
    idempotency_profile_sha256: '4'.repeat(64),
    idempotency_request_sha256: '5'.repeat(64),
  },
  realtime_session_ref: { ref_type: 'RealtimeSession', ref_id: '018f0e0e-0000-7000-8000-000000000001', object_version: '1', canonical_payload_sha256: '1'.repeat(64) },
  device_lease_ref: { ref_type: 'DeviceLease', ref_id: '018f0e0e-0000-7000-8000-000000000002', object_version: '2', canonical_payload_sha256: '2'.repeat(64) },
  continuity_id: '018f0e0e-0000-7000-8000-000000000003',
  connection_epoch: '7',
  transport_aliases: [{ alias_type: 'room', issuer: 'test_provider', value: 'room-001' }],
  key_envelope_ref: { alias_type: 'key_envelope', issuer: 'paios', value: 'env-001' },
  key_index: 0,
  key_generation: '1',
  device_id: '018f0e0e-0000-7000-8000-000000000004',
  recipient_device_credential_ref: { ref_type: 'DeviceCredential', ref_id: '018f0e0e-0000-7000-8000-000000000006', object_version: '3', canonical_payload_sha256: '3'.repeat(64) },
  participant_audience: { alias_type: 'participant', issuer: 'paios', value: 'aud-001' },
  governance: RESOLVE_GOVERNANCE,
};

function requestFor(body: JsonRecord, path: string): IncomingMessage {
  const encoded = Buffer.from(JSON.stringify(body));
  const stream = Readable.from([encoded]) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: 'POST',
    url: path,
    rawHeaders: [
      'Host', 'control.example.invalid',
      'Content-Type', 'application/json',
      'Content-Length', String(encoded.byteLength),
      'Authorization', 'Bearer opaque-control-capability-123456',
    ],
    socket: { remoteAddress: '127.0.0.1' },
  });
  return stream;
}

function responseCapture(): { response: ServerResponse; readonly status: number | undefined; readonly body: string | undefined } {
  let status: number | undefined;
  let body: string | undefined;
  let headersSent = false;
  let writableEnded = false;
  const response = {
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    writeHead(value: number) { status = value; headersSent = true; },
    end(value?: string) { body = value; writableEnded = true; },
  } as unknown as ServerResponse;
  return {
    response,
    get status() { return status; },
    get body() { return body; },
  };
}

function cloud(): RealtimePublicControlCloudConfig {
  return {
    profile: REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE,
    projectUrl: CLOUD_URL,
    apiKeyRef: { name: 'paios/livekit/api-key', version: '1' },
    apiSecretRef: { name: 'paios/livekit/api-secret', version: '1' },
    secretResolver: { async resolve() { return { read: () => 'not-read-by-composition' }; } },
  };
}

function ports(order: string[] = []): RealtimePublicControlProductionPorts {
  const tokenSigner = {
    assertProjectUrl(projectUrl: string) { assert.equal(projectUrl, CLOUD_URL); },
    async sign() { return 'opaque-test-token'; },
    close() { order.push('token-signer'); },
  };
  const participant = {
    async connect() {},
    async disconnect() {},
    snapshot: () => ({ connected: false, transportState: 'disconnected' as const }),
    async close() { order.push('participant'); },
  };
  return {
    governance: { async evaluate() { return { accepted: true, refs: {} }; } },
    sessions: {
      async bootstrap() { throw new Error('UNUSED'); },
      async refresh() { throw new Error('UNUSED'); },
      async endContinuity() { throw new Error('UNUSED'); },
      async handoff() { throw new Error('UNUSED'); },
      async close() { order.push('sessions'); },
    },
    mediaStop: {
      async claim() { throw new Error('UNUSED'); },
      async unpublishAllTracks() {},
      async disconnectParticipant() {},
      async complete() { throw new Error('UNUSED'); },
      async close() { order.push('media-stop'); },
    },
    e2ee: {
      async issue() { throw new Error('UNUSED'); },
      async close() { order.push('e2ee'); },
    },
    e2eeCiphertext: {
      async resolve() { throw new Error('UNUSED'); },
      async close() { order.push('ciphertext-resolver'); },
    },
    edge: { async authorize() {} },
    bearer: { async authorize() { return { principal: {}, deviceId: 'device' }; } },
    tokenSigner,
    participant,
    currentBinding: { async resolve() { throw new Error('UNUSED'); } },
    handoffOutputFence: {
      async claim() { throw new Error('UNUSED'); },
      async commit() {},
      async release() {},
      async suppressAndClose() { throw new Error('UNUSED'); },
    },
    handoffTerminalCodec: { async encode() { throw new Error('UNUSED'); } },
  };
}

function productionOptions(
  enabled: boolean,
  overrides: Partial<Parameters<typeof createRealtimePublicControlProduction>[0]> = {},
) {
  return {
    enabled,
    controlHost: 'control.example.invalid',
    cloud: cloud(),
    schemaRegistry: { validateRequest: () => true, validateResponse: () => true, validateTerminal: () => true },
    ports: ports(),
    ...overrides,
  };
}

test('production composition binds only injected ports and closes in reverse order once', async () => {
  const order: string[] = [];
  const production = createRealtimePublicControlProduction({
    ...productionOptions(true),
    ports: ports(order),
  });
  assert.equal(production.enabled, true);
  assert.ok(production.controller);
  assert.ok(production.runtime);
  assert.equal(production.controller.matches('POST', '/v1/realtime/bootstrap'), true);

  await Promise.all([production.close(), production.close()]);
  assert.deepEqual(order, [
    'participant', 'e2ee', 'media-stop', 'sessions', 'ciphertext-resolver', 'token-signer',
  ]);
  await production.close();
  assert.deepEqual(order, [
    'participant', 'e2ee', 'media-stop', 'sessions', 'ciphertext-resolver', 'token-signer',
  ]);
});

test('missing owner, bearer, edge, E2EE, or Cloud inputs fail before a listener can be started', () => {
  assert.throws(
    () => createRealtimePublicControlProduction({
      ...productionOptions(true),
      ports: undefined,
    } as unknown as Parameters<typeof createRealtimePublicControlProduction>[0]),
    /PUBLIC_RTC_OWNER_PORTS_REQUIRED/,
  );
  const incomplete = ports();
  delete (incomplete as { e2eeCiphertext?: unknown }).e2eeCiphertext;
  assert.throws(
    () => createRealtimePublicControlProduction({ ...productionOptions(true), ports: incomplete }),
    /PUBLIC_RTC_E2EE_CIPHERTEXT_PORT_REQUIRED|PUBLIC_RTC_E2EE_CIPHERTEXT_PORT_INVALID/,
  );
  const missingPortCases = [
    ['governance', 'PUBLIC_RTC_GOVERNANCE_PORT_REQUIRED', 'PUBLIC_RTC_GOVERNANCE_PORT_INVALID'],
    ['sessions', 'PUBLIC_RTC_SESSIONS_PORT_REQUIRED', 'PUBLIC_RTC_SESSIONS_PORT_INVALID'],
    ['mediaStop', 'PUBLIC_RTC_MEDIA_STOP_PORT_REQUIRED', 'PUBLIC_RTC_MEDIA_STOP_PORT_INVALID'],
    ['e2ee', 'PUBLIC_RTC_E2EE_PORT_REQUIRED', 'PUBLIC_RTC_E2EE_PORT_INVALID'],
    ['edge', 'PUBLIC_RTC_EDGE_PORT_REQUIRED', 'PUBLIC_RTC_EDGE_PORT_INVALID'],
    ['bearer', 'PUBLIC_RTC_BEARER_PORT_REQUIRED', 'PUBLIC_RTC_BEARER_PORT_INVALID'],
  ] as const;
  for (const [name, missingCode, invalidCode] of missingPortCases) {
    const missingPorts = ports() as unknown as Record<string, unknown>;
    delete missingPorts[name];
    assert.throws(
      () => createRealtimePublicControlProduction({
        ...productionOptions(true),
        ports: missingPorts as never,
      }),
      new RegExp(missingCode),
      `missing ${name} must fail before listener startup`,
    );
    const invalidPorts = ports() as unknown as Record<string, unknown>;
    invalidPorts[name] = {};
    assert.throws(
      () => createRealtimePublicControlProduction({
        ...productionOptions(true),
        ports: invalidPorts as never,
      }),
      new RegExp(invalidCode),
      `invalid ${name} must fail before listener startup`,
    );
  }
  assert.throws(
    () => createRealtimePublicControlProduction({
      ...productionOptions(true),
      cloud: { ...cloud(), projectUrl: 'https://project.livekit.cloud' },
    }),
    /INVALID_LIVEKIT_CLOUD_URL/,
  );
  assert.throws(
    () => createRealtimePublicControlProduction({
      ...productionOptions(true),
      cloud: { ...cloud(), profile: 'self-hosted' as typeof REALTIME_PUBLIC_CONTROL_CLOUD_PROFILE },
    }),
    /PUBLIC_RTC_CLOUD_PROFILE_INVALID/,
  );
  assert.throws(
    () => createRealtimePublicControlProduction({
      ...productionOptions(true),
      cloud: { ...cloud(), apiSecretRef: 'secret-value' as never },
    }),
    /PUBLIC_RTC_API_SECRET_REF_INVALID/,
  );
});

test('handoff authority, current-binding, and durable output-fence inputs fail before listener startup', () => {
  const missingHandoff = ports() as unknown as Record<string, unknown>;
  const sessions = missingHandoff.sessions as Record<string, unknown>;
  delete sessions.handoff;
  assert.throws(
    () => createRealtimePublicControlProduction({ ...productionOptions(true), ports: missingHandoff as never }),
    /PUBLIC_RTC_SESSIONS_PORT_INVALID/,
  );
  const missingBinding = ports() as unknown as Record<string, unknown>;
  delete missingBinding.currentBinding;
  assert.throws(
    () => createRealtimePublicControlProduction({ ...productionOptions(true), ports: missingBinding as never }),
    /PUBLIC_RTC_CURRENT_BINDING_PORT_REQUIRED|PUBLIC_RTC_CURRENT_BINDING_PORT_INVALID/,
  );
  const missingFence = ports() as unknown as Record<string, unknown>;
  delete missingFence.handoffOutputFence;
  assert.throws(
    () => createRealtimePublicControlProduction({ ...productionOptions(true), ports: missingFence as never }),
    /PUBLIC_RTC_HANDOFF_OUTPUT_FENCE_PORT_REQUIRED|PUBLIC_RTC_HANDOFF_OUTPUT_FENCE_PORT_INVALID/,
  );
  const missingSuppression = ports() as unknown as Record<string, unknown>;
  delete (missingSuppression.handoffOutputFence as Record<string, unknown>).suppressAndClose;
  assert.throws(
    () => createRealtimePublicControlProduction({ ...productionOptions(true), ports: missingSuppression as never }),
    /PUBLIC_RTC_HANDOFF_OUTPUT_FENCE_PORT_INVALID/,
  );
  const missingCodec = ports() as unknown as Record<string, unknown>;
  delete missingCodec.handoffTerminalCodec;
  assert.throws(
    () => createRealtimePublicControlProduction({ ...productionOptions(true), ports: missingCodec as never }),
    /PUBLIC_RTC_HANDOFF_TERMINAL_CODEC_PORT_REQUIRED|PUBLIC_RTC_HANDOFF_TERMINAL_CODEC_PORT_INVALID/,
  );
});

test('Cloud and top-level composition inputs reject unknown and raw-secret-shaped keys without echoing values', () => {
  const rawExtras = [
    ['apiSecret', 'raw-api-secret-value'],
    ['token', 'raw-token-value'],
    ['key', 'raw-key-value'],
  ] as const;
  for (const [key, rawValue] of rawExtras) {
    const unsafeCloud = { ...cloud(), [key]: rawValue } as unknown as RealtimePublicControlCloudConfig;
    assert.throws(
      () => createRealtimePublicControlProduction({ ...productionOptions(true), cloud: unsafeCloud }),
      (error: unknown) => {
        assert.match((error as Error).message, /PUBLIC_RTC_CLOUD_CONFIG_UNKNOWN_KEY/);
        assert.doesNotMatch((error as Error).message, new RegExp(rawValue));
        return true;
      },
      `cloud ${key} must be rejected without echoing its value`,
    );
  }
  const rawTopLevel = {
    ...productionOptions(true),
    apiSecret: 'raw-top-level-secret-value',
  } as unknown as Parameters<typeof createRealtimePublicControlProduction>[0];
  assert.throws(
    () => createRealtimePublicControlProduction(rawTopLevel),
    (error: unknown) => {
      assert.match((error as Error).message, /PUBLIC_RTC_PRODUCTION_OPTIONS_UNKNOWN_KEY/);
      assert.doesNotMatch((error as Error).message, /raw-top-level-secret-value/);
      return true;
    },
  );
});

test('feature flag OFF produces no controller and remains idempotently closable', async () => {
  const production = createRealtimePublicControlProduction({
    enabled: false,
    controlHost: 'control.example.invalid',
    cloud: cloud(),
  });
  assert.equal(production.controller, undefined);
  assert.equal(production.runtime, undefined);
  await Promise.all([production.close(), production.close()]);
});

test('composition adapts the admitted RFC-009 resolver factory through owner ports', async () => {
  const resolverPorts = ports() as unknown as Record<string, unknown>;
  delete resolverPorts.e2eeCiphertext;
  const production = createRealtimePublicControlProduction({
    ...productionOptions(true),
    ports: resolverPorts as never,
    e2eeCiphertextResolverOptions: {
      recipientCredential: { async resolve() { return undefined; } },
      contentKey: { async lease() { return undefined; } },
      replay: {
        async claim() { return { disposition: 'conflict' as const }; },
        async commit() {},
        async abort() {},
      },
    },
  });
  assert.ok(production.controller);
  await production.close();
});

test('custom registry is shared by controller and built-in resolver canonical request/terminal seams', async () => {
  let requestValidatorCalls = 0;
  let terminalValidatorCalls = 0;
  const schemaRegistry = {
    validateRequest(operation: string, value: unknown) {
      requestValidatorCalls += 1;
      return operation === 'realtime_e2ee_key_resolve' && value !== undefined;
    },
    validateResponse() { return true; },
    validateTerminal(value: unknown) {
      terminalValidatorCalls += 1;
      return value !== undefined;
    },
  };
  const terminalResponse: JsonRecord = {
    operation: 'realtime_e2ee_key_resolve',
    status: 'expired',
    request_id: RESOLVE_REQUEST.request_id,
    realtime_session_ref: RESOLVE_REQUEST.realtime_session_ref,
    device_lease_ref: RESOLVE_REQUEST.device_lease_ref,
    continuity_id: RESOLVE_REQUEST.continuity_id,
    connection_epoch: RESOLVE_REQUEST.connection_epoch,
    operation_outcome: {
      outcome_class: 'indeterminate',
      error: {
        error_family: 'state',
        error_code: 'state.e2ee_terminal',
        retry_class: 'never',
        trace_id: '018f0e0e-0000-7000-8000-000000000011',
        occurred_at: '2026-08-23T11:00:00.000Z',
      },
    },
    execution_facts: { closure_status: 'not_applicable' },
    governance: RESOLVE_GOVERNANCE,
  };
  const resolverPorts = ports() as unknown as Record<string, unknown>;
  delete resolverPorts.e2eeCiphertext;
  resolverPorts.governance = {
    async evaluate() { return { accepted: true, refs: RESOLVE_GOVERNANCE }; },
  };
  resolverPorts.bearer = {
    async authorize() { return { principal: {}, deviceId: String(RESOLVE_REQUEST.device_id) }; },
  };
  const production = createRealtimePublicControlProduction({
    ...productionOptions(true),
    schemaRegistry,
    ports: resolverPorts as never,
    e2eeCiphertextResolverOptions: {
      recipientCredential: {
        async resolve() {
          return {
            publicKey: new Uint8Array(32),
            status: 'expired' as const,
            expiresAt: '2026-08-23T12:00:00.000Z',
            deviceId: String(RESOLVE_REQUEST.device_id),
            credentialRef: RESOLVE_REQUEST.recipient_device_credential_ref as JsonRecord,
            terminalResult: terminalResponse,
          };
        },
      },
      contentKey: { async lease() { throw new Error('CONTENT_KEY_MUST_NOT_RUN'); } },
      replay: {
        async claim() { return { disposition: 'claimed' as const, claimId: 'claim-1' }; },
        async commit() {},
        async abort() {},
      },
      now: () => Date.parse('2026-08-23T11:00:00.000Z'),
    },
  });
  const capture = responseCapture();
  const handled = await production.controller!.handle(
    requestFor(RESOLVE_REQUEST, '/v1/realtime/e2ee/key/resolve'),
    capture.response,
  );
  assert.equal(handled, true);
  assert.equal(capture.status, 410, capture.body);
  assert.ok(requestValidatorCalls >= 2, 'controller and built-in resolver must use the same request seam');
  assert.ok(terminalValidatorCalls >= 2, 'built-in resolver and controller must use the same terminal seam');
  await production.close();
});

test('missing or invalid terminal schema seam fails closed before Gateway start', () => {
  const resolverPorts = ports() as unknown as Record<string, unknown>;
  delete resolverPorts.e2eeCiphertext;
  const resolverOptions = {
    recipientCredential: { async resolve() { return undefined; } },
    contentKey: { async lease() { return undefined; } },
    replay: {
      async claim() { return { disposition: 'conflict' as const }; },
      async commit() {},
      async abort() {},
    },
  };
  for (const terminalValidator of [undefined, 'not-a-function']) {
    assert.throws(
      () => createRealtimePublicControlProduction({
        ...productionOptions(true),
        schemaRegistry: {
          validateRequest() { return true; },
          validateResponse() { return true; },
          validateTerminal: terminalValidator,
        } as never,
        ports: resolverPorts as never,
        e2eeCiphertextResolverOptions: resolverOptions,
      }),
      /PUBLIC_RTC_SCHEMA_REGISTRY_TERMINAL_INVALID/,
      `terminal validator ${String(terminalValidator)} must fail closed`,
    );
  }
});

test('entrypoint delegates exactly once to main startGateway and never binds itself', async () => {
  const off = createRealtimePublicControlProduction({
    enabled: false,
    controlHost: 'control.example.invalid',
    cloud: cloud(),
  });
  const environment = { PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '0' };
  const calls: unknown[] = [];
  await startPublicRtcProduction({
    production: off,
    environment,
    startGateway: async (_owner, dependencies) => {
      calls.push(dependencies);
      return undefined;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { environment: NodeJS.ProcessEnv }).environment, environment);
  assert.equal('publicRtcControl' in (calls[0] as object), false);
});

test('entrypoint feature-flag mismatch closes production exactly once and does not start Gateway', async () => {
  const off = createRealtimePublicControlProduction({
    enabled: false,
    controlHost: 'control.example.invalid',
    cloud: cloud(),
  });
  let closeCalls = 0;
  let starterCalls = 0;
  const production: RealtimePublicControlProduction = {
    ...off,
    close: async () => { closeCalls += 1; },
  };
  await assert.rejects(
    startPublicRtcProduction({
      production,
      environment: { PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '1' },
      startGateway: async () => { starterCalls += 1; throw new Error('STARTER_MUST_NOT_RUN'); },
    }),
    /PUBLIC_RTC_FEATURE_FLAG_MISMATCH/,
  );
  assert.equal(closeCalls, 1);
  assert.equal(starterCalls, 0);
});

test('entrypoint start failure invokes production.close exactly once', async () => {
  const off = createRealtimePublicControlProduction({
    enabled: false,
    controlHost: 'control.example.invalid',
    cloud: cloud(),
  });
  let closeCalls = 0;
  let starterCalls = 0;
  const production: RealtimePublicControlProduction = {
    ...off,
    close: async () => { closeCalls += 1; },
  };
  await assert.rejects(
    startPublicRtcProduction({
      production,
      environment: { PAIOS_PUBLIC_RTC_SUCCESSOR_ENABLED: '0' },
      startGateway: async () => { starterCalls += 1; throw new Error('START_FAILED'); },
    }),
    /START_FAILED/,
  );
  assert.equal(starterCalls, 1);
  assert.equal(closeCalls, 1);
});
