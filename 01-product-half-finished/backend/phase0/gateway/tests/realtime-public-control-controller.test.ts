import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  RealtimePublicControlController,
  createRealtimeSchemaRegistry,
  isRealtimePublicControlRoute,
} from '../src/realtime-public-control-controller.ts';
import {
  RealtimePublicControlRuntime,
  type RealtimePublicControlRuntimeOptions,
} from '../src/realtime-public-control-runtime.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import type { LiveKitCloudTokenSignerPort } from '../src/livekit-cloud-token-signer.ts';

const fixturePath = new URL(
  '../../../tests/contracts/fixtures/realtime-public-control/bootstrap-request.valid.json',
  import.meta.url,
);
const requestFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
const resolveResponseFixture = JSON.parse(readFileSync(new URL(
  '../../../tests/contracts/fixtures/realtime-public-control/e2ee-key-resolve.valid.json',
  import.meta.url,
), 'utf8')) as Record<string, unknown>;
const handoffResponseFixture = JSON.parse(readFileSync(new URL(
  '../../../tests/contracts/fixtures/realtime-public-control/handoff.valid.json',
  import.meta.url,
), 'utf8')) as Record<string, unknown>;
const handoffRequestFixture = handoffResponseFixture.request as Record<string, unknown>;
const resolveFixture = {
  operation: resolveResponseFixture.operation,
  request_id: resolveResponseFixture.request_id,
  idempotency_context: resolveResponseFixture.idempotency_context,
  realtime_session_ref: resolveResponseFixture.realtime_session_ref,
  device_lease_ref: resolveResponseFixture.device_lease_ref,
  continuity_id: resolveResponseFixture.continuity_id,
  connection_epoch: resolveResponseFixture.connection_epoch,
  transport_aliases: resolveResponseFixture.transport_aliases,
  key_envelope_ref: resolveResponseFixture.key_envelope_ref,
  key_index: resolveResponseFixture.key_index,
  key_generation: resolveResponseFixture.key_generation,
  device_id: resolveResponseFixture.device_id,
  recipient_device_credential_ref: resolveResponseFixture.recipient_device_credential_ref,
  participant_audience: resolveResponseFixture.participant_audience,
  governance: resolveResponseFixture.governance,
};
const REF = Object.freeze({
  ref_type: 'RealtimeSession', ref_id: '018f0000-0000-7000-8000-000000000004',
  object_version: '1', canonical_payload_sha256: '2'.repeat(64),
});
const LEASE = Object.freeze({
  ref_type: 'DeviceLease', ref_id: '018f0000-0000-7000-8000-000000000005',
  object_version: '1', canonical_payload_sha256: '3'.repeat(64),
});
const GOVERNANCE = Object.freeze({
  purpose_scopes: ['realtime_assistant'],
  consent_record_refs: ['018f0000-0000-7000-8000-000000000006'],
  policy_decision_refs: ['018f0000-0000-7000-8000-000000000007'],
  purpose_token_refs: ['018f0000-0000-7000-8000-000000000008'],
  capability_grant_refs: ['018f0000-0000-7000-8000-000000000009'],
});

function makeRuntime(includeDeviceCredential = true): { runtime: RealtimePublicControlRuntime; participant: { connects: number }; owner: { bootstrapCalls: number } } {
  const participantState = { connects: 0 };
  const ownerState = { bootstrapCalls: 0 };
  const participant: LiveKitCloudParticipantPort = {
    async connect() { participantState.connects += 1; },
    async disconnect() {},
    snapshot: () => ({ connected: true, transportState: 'connected' }),
    async close() {},
  };
  const signer: LiveKitCloudTokenSignerPort = {
    assertProjectUrl(projectUrl) { if (projectUrl !== 'wss://media.example.invalid') throw new Error('PROJECT_BINDING_MISMATCH'); },
    async sign(input) { return `token-${input.room}`; },
    close() {},
  };
  const recipientRef = resolveResponseFixture.recipient_device_credential_ref;
  const options: RealtimePublicControlRuntimeOptions = {
    governance: { async evaluate() { return { accepted: true, refs: GOVERNANCE }; } },
    sessions: {
      async bootstrap() {
        ownerState.bootstrapCalls += 1;
        return {
          realtime_session_ref: REF,
          device_lease_ref: LEASE,
          continuity_id: '018f0000-0000-7000-8000-000000000003',
          transport_aliases: [
            { alias_type: 'room', issuer: 'livekit_cloud', value: 'room-opaque-fixture-1' },
            { alias_type: 'participant', issuer: 'livekit_cloud', value: 'participant-opaque-fixture-1' },
          ],
          connection_epoch: '1',
          server_url: 'wss://media.example.invalid',
          credential_expires_at: '2026-08-22T12:15:00Z',
          continuity_expires_at: '2026-08-22T12:30:00Z',
          terminal_room_name: 'terminal-room-opaque',
          terminal_identity: 'terminal-identity-opaque',
          terminal_grants: {
            room: 'terminal-room-opaque', roomJoin: true, canPublish: true,
            canSubscribe: true, canPublishData: true, canPublishSources: ['microphone', 'camera'],
          },
          media_grants: {
            audio: { enabled: true, device_id: requestFixture.device_id, device_lease_ref: LEASE, start_binding: { kind: 'explicit_user_start', device_id: requestFixture.device_id, modalities: ['audio', 'video', 'data'] }, expires_at: '2026-08-22T12:14:00Z' },
            video: { enabled: true, device_id: requestFixture.device_id, device_lease_ref: LEASE, start_binding: { kind: 'explicit_user_start', device_id: requestFixture.device_id, modalities: ['audio', 'video', 'data'] }, expires_at: '2026-08-22T12:14:00Z' },
            data: { enabled: true, device_id: requestFixture.device_id, device_lease_ref: LEASE, start_binding: { kind: 'explicit_user_start', device_id: requestFixture.device_id, modalities: ['audio', 'video', 'data'] }, expires_at: '2026-08-22T12:14:00Z' },
          },
          governance: GOVERNANCE,
          gateway: {
            roomName: 'gateway-room-opaque', identity: 'gateway-identity-opaque',
            grants: {
              room: 'gateway-room-opaque', roomJoin: true, canPublish: false,
              canSubscribe: true, canPublishData: true, canPublishSources: [],
            },
          },
        };
      },
      async refresh() { throw new Error('UNUSED'); },
      async endContinuity() { throw new Error('UNUSED'); },
      async handoff() { return handoffResponseFixture.terminal_result as Record<string, unknown>; },
    },
    mediaStop: {
      async claim() { throw new Error('UNUSED'); },
      async unpublishAllTracks() {},
      async disconnectParticipant() {},
      async complete() { throw new Error('UNUSED'); },
    },
    e2ee: {
      async issue(input) {
        return {
          envelope: {
            key_envelope_ref: { alias_type: 'key_envelope', issuer: 'local_gateway', value: 'key-envelope-opaque-1' },
            key_index: 0, key_generation: '1', expires_at: '2026-08-22T12:10:00Z',
            scope: { device_id: requestFixture.device_id, channels: ['audio', 'video', 'data'], distribution_mode: 'application_controlled_envelope' },
            realtime_session_ref: input.realtimeSessionRef,
            continuity_id: input.continuityId,
            governance: input.governance,
          },
          roomOptions: { encryption: { keyProviderOptions: {} } },
          release: () => {},
        };
      },
    },
    e2eeCiphertext: {
      async resolve(input) {
        const request = input.request;
        return {
          operation: 'realtime_e2ee_key_resolve', status: 'key_resolved', request_id: request.request_id,
          idempotency_context: request.idempotency_context,
          realtime_session_ref: request.realtime_session_ref, device_lease_ref: request.device_lease_ref,
          continuity_id: request.continuity_id, connection_epoch: request.connection_epoch,
          transport_aliases: request.transport_aliases, key_envelope_ref: request.key_envelope_ref,
          key_index: request.key_index, key_generation: request.key_generation, device_id: request.device_id,
          recipient_device_credential_ref: request.recipient_device_credential_ref,
          participant_audience: request.participant_audience, expires_at: '2026-08-22T12:10:00Z',
          cipher_suite: 'DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM',
          encapsulated_key: 'fixture_non_secret_encapsulated_key', ciphertext: 'fixture_non_secret_ciphertext',
          aad_sha256: 'c'.repeat(64), governance: input.governance,
        };
      },
    },
    tokenSigner: signer,
    ...(includeDeviceCredential ? { deviceCredential: {
      async resolve() { return recipientRef as never; },
    } } : {}),
    participant,
    now: () => Date.parse('2026-08-22T12:00:00Z'),
  };
  return { runtime: new RealtimePublicControlRuntime(options), participant: participantState, owner: ownerState };
}

function requestFor(body: unknown, path: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: 'POST', url: path,
    rawHeaders: [
      'Host', 'ai.example.invalid',
      'Content-Type', 'application/json',
      'Content-Length', String(Buffer.byteLength(JSON.stringify(body))),
      'Authorization', 'Bearer opaque-control-capability-123456',
    ],
    socket: { remoteAddress: '127.0.0.1' },
  });
  return stream;
}

function responseCapture(): { response: ServerResponse; readonly status: number | undefined; readonly body: string | undefined } {
  let status: number | undefined;
  let body: string | undefined;
  const state = { headersSent: false, writableEnded: false };
  const response = {
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    writeHead(value: number) { status = value; state.headersSent = true; },
    end(value?: string) { body = value; state.writableEnded = true; },
  } as unknown as ServerResponse;
  return {
    response,
    get status(): number | undefined { return status; },
    get body(): string | undefined { return body; },
  };
}

function controller(enabled: boolean, bearerDeviceId = String(requestFixture.device_id), includeDeviceCredential = true, glassesEnrollment?: ConstructorParameters<typeof RealtimePublicControlController>[0]['glassesEnrollment'],capabilityUpgrade?:ConstructorParameters<typeof RealtimePublicControlController>[0]['capabilityUpgrade']): { instance: RealtimePublicControlController; runtime: RealtimePublicControlRuntime; participant: { connects: number }; calls: { bearer: number; readonly owner: number } } {
  const { runtime, participant, owner } = makeRuntime(includeDeviceCredential);
  const calls = { bearer: 0, get owner() { return owner.bootstrapCalls; } };
  const schemas = createRealtimeSchemaRegistry();
  const instance = new RealtimePublicControlController({
    enabled,
    canonicalApiOrigin: 'https://bj.example.invalid:9443',
    controlHost: 'ai.example.invalid',
    edge: { async authorize() {} },
    bearer: {
      async authorize() {
        calls.bearer += 1;
        return { principal: 'fixture', deviceId: bearerDeviceId };
      },
    },
    runtime,
    schemaRegistry: schemas,
    ...(glassesEnrollment ? {glassesEnrollment} : {}),
    ...(capabilityUpgrade ? {capabilityUpgrade} : {}),
  });
  return { instance, runtime, participant, calls };
}

test('capability declaration is an authenticated paired-device operation before bootstrap, with an exact body',async t=>{
  const grant={governance:GOVERNANCE,media:['data','audio'],capabilities:['display','microphone']};let declarations=0;
  const h=controller(true,undefined,true,undefined,{declare:async(token,capabilities)=>{
    assert.equal(token,'opaque-control-capability-123456');assert.deepEqual(capabilities,['display','speaker']);declarations++;return grant;
  }});t.after(()=>h.instance.close());
  const path='/v1/terminals/capabilities';assert.equal(h.instance.matches('POST',path),true);assert.equal(h.instance.matches('GET',path),false);
  const out=responseCapture();await h.instance.handle(requestFor({capabilities:['display','speaker']},path),out.response);
  assert.equal(out.status,200);assert.deepEqual(JSON.parse(out.body!),grant);assert.equal(h.calls.owner,0);assert.equal(declarations,1);
  const extra=responseCapture();await h.instance.handle(requestFor({capabilities:[],approved:true},path),extra.response);
  assert.equal(extra.status,422);assert.equal(declarations,1);
  const missing=responseCapture();const request=requestFor({capabilities:[]},path);request.rawHeaders=request.rawHeaders.filter((_,index)=>index<6);
  await h.instance.handle(request,missing.response);assert.equal(missing.status,401);assert.equal(declarations,1);
});

test('paired-phone QR enrollment and unauthenticated capability exchange use exact public routes', async () => {
  const payload={schema:'paios.glasses-enrollment.v1',origin:'https://api.example',token:'a'.repeat(43),expires_at:'2026-10-12T10:05:00.000Z'};
  const {instance}=controller(true,undefined,true,{issue:async token=>{assert.equal(token,'opaque-control-capability-123456');return payload;},
    exchange:async(token,registration)=>{assert.equal(token,payload.token);assert.deepEqual(registration,{device_type:'glasses'});return {schema:'paios.device-pairing.v1'} as never;},
    requestMac:async()=>assert.fail('unused'),previewMac:async()=>assert.fail('unused'),approveMac:async()=>assert.fail('unused'),exchangeMac:async()=>assert.fail('unused')});
  const issue=responseCapture();await instance.handle(requestFor({},'/v1/devices/glasses/enrollment'),issue.response);
  assert.equal(issue.status,200);assert.deepEqual(JSON.parse(issue.body!),payload);
  const request=requestFor({token:payload.token,registration:{device_type:'glasses'}},'/v1/devices/glasses/enrollment/exchange');
  request.rawHeaders.splice(-2);const exchange=responseCapture();await instance.handle(request,exchange.response);
  assert.equal(exchange.status,200);
  const invalid=responseCapture();await instance.handle(requestFor({token:'client-selected'},'/v1/devices/glasses/enrollment'),invalid.response);
  assert.equal(invalid.status,422);
  const unauthenticated=requestFor({},'/v1/devices/glasses/enrollment');unauthenticated.rawHeaders.splice(-2);
  const denied=responseCapture();await instance.handle(unauthenticated,denied.response);assert.equal(denied.status,401);
  assert.equal(instance.matches('POST','/v1/devices/glasses/enrollment/exchange'),true);
  assert.equal(instance.matches('POST','/v1/devices/glasses/enrollment?token=secret'),false);
  await instance.close();
});

test('successor route matcher is exact and separate from legacy routes', () => {
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/bootstrap'), true);
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/e2ee/key/resolve'), true);
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/handoff'), false);
  assert.equal(isRealtimePublicControlRoute('GET', '/v1/realtime/bootstrap'), false);
  assert.equal(isRealtimePublicControlRoute('POST', '/v1/realtime/bootstrap?x=1'), false);
  assert.equal(isRealtimePublicControlRoute('POST', '/phase0/rayneo/v1/bootstrap'), false);
});

test('feature flag OFF leaves successor route unhandled and produces no participant effect', async () => {
  const { instance, participant } = controller(false);
  const capture = responseCapture();
  const handled = await instance.handle(requestFor(requestFixture, '/v1/realtime/bootstrap'), capture.response);
  assert.equal(handled, false);
  assert.equal(participant.connects, 0);
  await instance.close();
});

test('enabled bootstrap validates T01 request and response through injected ports', async () => {
  const { instance, participant } = controller(true);
  const capture = responseCapture();
  const handled = await instance.handle(requestFor(requestFixture, '/v1/realtime/bootstrap'), capture.response);
  assert.equal(handled, true);
  assert.equal(capture.status, 200, capture.body);
  assert.equal(participant.connects, 1);
  const body = JSON.parse(capture.body ?? '{}') as Record<string, unknown>;
  assert.equal(body.status, 'bootstrap_accepted');
  assert.equal(body.canonical_api_origin, 'https://bj.example.invalid:9443');
  assert.equal((body.livekit as Record<string, unknown>).server_url, 'wss://media.example.invalid');
  await instance.close();
});

test('canonical announcement preserves the legacy closed reconcile response', async () => {
  const { instance, runtime, calls } = controller(true);
  const fact = { operation: 'bootstrap', kind: 'paios.public-operation.read.v1', status: 'missing' };
  runtime.readBootstrapFact = async () => fact;
  const capture = responseCapture();
  await instance.handle(requestFor(requestFixture, '/v1/realtime/bootstrap/reconcile'), capture.response);
  assert.equal(capture.status, 200, capture.body);
  assert.deepEqual(JSON.parse(capture.body!), fact);
  assert.equal(calls.bearer, 1);
  await instance.close();
});

test('enabled bootstrap missing required successor enrollment fails closed before participant connect', async () => {
  const { instance, participant } = controller(true, String(requestFixture.device_id), false);
  const capture = responseCapture();
  await instance.handle(requestFor(requestFixture, '/v1/realtime/bootstrap'), capture.response);
  assert.equal(capture.status, 503);
  assert.equal(participant.connects, 0);
});

test('enabled E2EE resolve returns ciphertext-only response and no RoomOptions', async () => {
  const { instance } = controller(true);
  const capture = responseCapture();
  const handled = await instance.handle(requestFor(resolveFixture, '/v1/realtime/e2ee/key/resolve'), capture.response);
  assert.equal(handled, true);
  assert.equal(capture.status, 200, capture.body);
  const body = JSON.parse(capture.body ?? '{}') as Record<string, unknown>;
  assert.equal(body.status, 'key_resolved');
  assert.equal(typeof body.ciphertext, 'string');
  assert.equal(body.plaintext, undefined);
  assert.equal(body.roomOptions, undefined);
  assert.equal(body.room_options, undefined);
  await instance.close();
});

test('retired handoff has no public route and cannot reach bearer or owner ports', async () => {
  const { instance, calls } = controller(true, String(handoffRequestFixture.from_device_id));
  const capture = responseCapture();
  assert.equal(instance.matches('POST', '/v1/realtime/handoff'), false);
  assert.equal(await instance.handle(requestFor(handoffRequestFixture, '/v1/realtime/handoff'), capture.response), false);
  assert.equal(capture.status, undefined);
  assert.equal(calls.bearer, 0);
  assert.equal(calls.owner, 0);
  await instance.close();
});

test('invalid schema and invalid bearer fail closed without runtime success', async () => {
  const { instance, participant, calls } = controller(true);
  const invalid = structuredClone(requestFixture) as Record<string, unknown>;
  delete invalid.device_id;
  const capture = responseCapture();
  const stderr = process.stderr;
  const originalWrite = stderr.write;
  let log = '';
  stderr.write = ((chunk: string | Uint8Array) => {
    log += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof stderr.write;
  try {
    await instance.handle(requestFor(invalid, '/v1/realtime/bootstrap'), capture.response);
  } finally {
    stderr.write = originalWrite;
  }
  assert.equal(capture.status, 422);
  assert.equal(log, '{"route":"/v1/realtime/bootstrap","status":422,"safeErrorCode":"REALTIME_SCHEMA_INVALID"}\n');
  assert.equal(participant.connects, 0);
  assert.equal(calls.bearer, 0);
  assert.equal(calls.owner, 0);
  await instance.close();
});

test('caller token provenance is bound to the request device before runtime execution', async () => {
  const { instance, participant } = controller(true, 'different-device');
  const capture = responseCapture();
  const stderr = process.stderr;
  const originalWrite = stderr.write;
  let log = '';
  stderr.write = ((chunk: string | Uint8Array) => {
    log += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof stderr.write;
  try {
    await instance.handle(requestFor(requestFixture, '/v1/realtime/bootstrap'), capture.response);
  } finally {
    stderr.write = originalWrite;
  }
  assert.equal(capture.status, 403);
  assert.equal(log, '{"route":"/v1/realtime/bootstrap","status":403,"safeErrorCode":"CONTROL_CAPABILITY_DEVICE_MISMATCH"}\n');
  assert.equal(participant.connects, 0);
  await instance.close();
});


test('background place route is exact and bounded, validates formal location, and never bootstraps LiveKit',async()=>{
  const {runtime,participant,owner}=makeRuntime();let uploads=0,edges=0;
  const result={schema:'paios.place-upload-response.v1',stored_ids:[],duplicate_ids:[],expired_ids:[],regions:{version:0,items:[]}};
  const instance=new RealtimePublicControlController({enabled:true,controlHost:'ai.example.invalid',runtime,
    edge:{authorize:async()=>{edges++;}},bearer:{authorize:async()=>{throw new Error('NO_NORMAL_BEARER');}},
    place:{upload:async()=>{uploads++;return result;},credential:async()=>({revoked:true})}});
  const batch={schema:'paios.place-upload.v1',device_id:requestFixture.device_id,events:[]};
  const response=responseCapture();await instance.handle(requestFor(batch,'/v1/place/upload'),response.response);assert.equal(response.status,200);
  for(const body of [{...batch,extra:true},{...batch,events:Array(65).fill({})},{...batch,events:[{id:'a',kind:'visit_arrival',sensor_at:'2026-10-13T00:00:00.000Z',arrival_at:'2026-10-13T00:00:00.000Z',location:{latitude:1,longitude:2}}]}]){
    const rejected=responseCapture();await instance.handle(requestFor(body,'/v1/place/upload'),rejected.response);assert.equal(rejected.status,422);
  }
  const oversized=requestFor(batch,'/v1/place/upload');oversized.rawHeaders[5]='131073';
  const rejected=responseCapture();await instance.handle(oversized,rejected.response);assert.equal(rejected.status,413);
  assert.equal(instance.matches('POST','/v1/place/upload?x=1'),false);assert.equal(instance.matches('GET','/v1/place/upload'),false);
  assert.equal(uploads,1);assert.equal(edges,4);assert.equal(participant.connects,0);assert.equal(owner.bootstrapCalls,0);
  await instance.close();
});

test('passive WeChat upload uses paired bearer and edge authentication independently of SSH',async t=>{
  const {runtime}=makeRuntime();let uploads=0,bearers=0,edges=0;
  const value={device_id:'mac',batch_id:'fixture',previews:[]};
  const receipt={schema:'paios.wechat-previews-response.v1',batch_id:'fixture',accepted_ids:[]};
  const instance=new RealtimePublicControlController({enabled:true,controlHost:'example.invalid',runtime,
    edge:{authorize:async()=>{edges++;}},bearer:{authorize:async input=>{
      assert.equal(input.token,'opaque-control-capability-123456');assert.equal(input.operation,'bootstrap');
      assert.deepEqual(input.request,value);bearers++;return {principal:'owner',deviceId:'mac'};
    }},wechatPreviews:async(bearer,body)=>{assert.equal(bearer.deviceId,body.device_id);uploads++;return receipt;}});
  t.after(()=>instance.close());const path='/v1/mac/wechat/previews';
  assert.equal(instance.matches('POST',path),true);assert.equal(instance.matches('GET',path),false);
  const response=responseCapture();await instance.handle(requestFor(value,path),response.response);
  assert.equal(response.status,202);assert.deepEqual(JSON.parse(response.body!),receipt);assert.equal(uploads,1);
  assert.equal(edges,1);assert.equal(bearers,1);
  const noAuth=requestFor(value,path);noAuth.rawHeaders.splice(-2);const denied=responseCapture();
  await instance.handle(noAuth,denied.response);assert.equal(denied.status,401);assert.equal(uploads,1);
});
