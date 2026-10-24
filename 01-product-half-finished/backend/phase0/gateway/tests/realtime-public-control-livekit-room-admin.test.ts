import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialFencePort, CredentialFenceSnapshot, CredentialFenceTuple } from "../../../services/platform-data/src/realtime-credential-fence.ts";
import { createRealtimePublicControlExternalEffectProduction } from "../src/realtime-public-control-external-effect-production.ts";
import type { LiveKitCloudParticipantBinding } from "../src/livekit-cloud-participant.ts";
const PAIOS_SELF_HOSTED_LIVEKIT_URL = 'wss://ai.example.invalid';
import { PERSISTENT_PUBLIC_SECRET_REFERENCES } from "../src/realtime-public-control-persistent-public-ports.ts";
import { projectRealtimeExternalAliases } from "../src/realtime-public-control-external-alias.ts";
import {
  createRealtimePublicControlLiveKitRoomAdmin,
  createRealtimePublicControlLiveKitTransportDisconnection,
} from "../src/realtime-public-control-livekit-room-admin.ts";

const SESSION = Object.freeze({ ref_type: "RealtimeSession", ref_id: "01900000-0000-7000-8000-000000000001", object_version: "1", canonical_payload_sha256: "a".repeat(64) });
const OLD_LEASE = Object.freeze({ ref_type: "DeviceLease", ref_id: "01900000-0000-7000-8000-000000000002", object_version: "1", canonical_payload_sha256: "b".repeat(64) });
const NEW_LEASE = Object.freeze({ ref_type: "DeviceLease", ref_id: "01900000-0000-7000-8000-000000000003", object_version: "1", canonical_payload_sha256: "c".repeat(64) });
const TRANSPORT_ALIAS = `t02.realtime.transport-alias.v1:${"1".repeat(64)}:${"2".repeat(64)}:7:${"3".repeat(64)}`;
const ROOM_ALIAS = `t02.realtime.transport-alias.v1:${"4".repeat(64)}:${"5".repeat(64)}:7:${"6".repeat(64)}`;
const DEVICE_ALIAS = `t02.realtime.transport-alias.v1:${"7".repeat(64)}:${"8".repeat(64)}:7:${"9".repeat(64)}`;

function projection(options: { readonly handoff?: boolean } = {}) {
  const handoff = options.handoff === true;
  const lease = handoff ? NEW_LEASE : OLD_LEASE;
  const device = handoff ? "watch-owner" : "iphone-owner";
  return {
    session: {
      realtimeSessionRef: SESSION,
      userId: "cycling-owner",
      continuityId: "continuity-1",
      state: "active",
      continuityState: "active",
      connectionEpoch: "7",
      continuityExpiresAt: "2030-01-01T00:30:00.000Z",
      lastAcceptedUserActivityAt: "2030-01-01T00:00:00.000Z",
      activeDeviceId: device,
      activeDeviceLeaseRef: lease,
      binding: {
        state: "connected",
        realtimeSessionRef: SESSION,
        deviceLeaseRef: lease,
        continuityId: "continuity-1",
        deviceId: device,
        connectionEpoch: "7",
        provider: "livekit-cloud",
        transportSessionAlias: handoff ? `${TRANSPORT_ALIAS}:new` : TRANSPORT_ALIAS,
        roomAlias: handoff ? `${ROOM_ALIAS}:new` : ROOM_ALIAS,
        deviceAlias: handoff ? `${DEVICE_ALIAS}:new` : DEVICE_ALIAS,
        connectionId: handoff ? "connection-new" : "connection-old",
      },
      revision: handoff ? "2" : "1",
    },
    lease: {
      deviceLeaseRef: lease,
      realtimeSessionRef: SESSION,
      continuityId: "continuity-1",
      userId: "cycling-owner",
      deviceId: device,
      state: "active",
      capabilities: ["realtime.media"],
      purpose: "cycling_assistant",
      issuedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:20:00.000Z",
      revocable: true,
      leaseVersion: handoff ? "2" : "1",
      fencingToken: handoff ? "2" : "1",
      policyDecisionRef: Object.freeze({ ref_type: "PolicyDecision", ref_id: "policy-1" }),
    },
  } as const;
}

function fixture(credentialFence?: Pick<CredentialFencePort, "verify">, apiUrl?: string, missingParticipant=false) {
  let current = projection();
  let ready = true;
  let fenceActive = true;
  let removeCalls = 0;
  let removeFailure: unknown;
  let listCalls = 0;
  let clientCalls = 0;
  let releaseCalls = 0;
  let listed: readonly { readonly identity: string }[] = Object.freeze([{ identity: "paios-g-present" }]);
  const oldParticipant = Object.freeze({
    realtimeSessionRef: SESSION,
    deviceLeaseRef: OLD_LEASE,
    continuityId: "continuity-1",
    // The runtime hands the participant the wire aliases (as returned to the device).
    transportAliases: projectRealtimeExternalAliases({ transportSessionAlias: TRANSPORT_ALIAS, roomAlias: ROOM_ALIAS, deviceAlias: DEVICE_ALIAS }),
    connectionEpoch: "7",
  });
  let participantBinding = oldParticipant;
  const verified: CredentialFenceTuple[] = [];
  const options = {
    ...(apiUrl ? {apiUrl} : {}),
    serverUrl: PAIOS_SELF_HOSTED_LIVEKIT_URL,
    apiKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey,
    apiSecretRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    secretResolver: {
      resolve: async (reference: { readonly name: string }) => ({
        read: () => reference.name === "livekit-api-key" ? "k".repeat(16) : "s".repeat(32),
        release: () => { releaseCalls += 1; },
      }),
    },
    participant: {
      snapshot: () => ({ connected: true, transportState: "connected" as const }),
      bindingSnapshot: () => participantBinding,
    },
    ...(missingParticipant ? {participantForDevice:()=>undefined} : {}),
    readCurrentBinding: async () => current,
    credentialFence: credentialFence ?? {
      verify: async (tuple: CredentialFenceTuple) => {
        verified.push(tuple);
        return { active: fenceActive, credentialGeneration: tuple.credentialGeneration };
      },
    },
    readiness: () => ready,
    createRoomService: (input: { readonly host: string; readonly apiKey: string; readonly apiSecret: string }) => {
      clientCalls += 1;
      assert.deepEqual(input, {
        host: apiUrl ?? "https://ai.example.invalid",
        apiKey: "k".repeat(16),
        apiSecret: "s".repeat(32),
      });
      return {
        removeParticipant: async () => { removeCalls += 1; if (removeFailure) throw removeFailure; },
        listParticipants: async () => { listCalls += 1; return listed; },
      };
    },
  } as const;
  const bundle = createRealtimePublicControlLiveKitRoomAdmin(options as never);
  return {
    bundle,
    oldParticipant,
    setCurrent: (value: ReturnType<typeof projection>) => { current = value; },
    setParticipant: (value: typeof oldParticipant) => { participantBinding = value; },
    setReady: (value: boolean) => { ready = value; },
    setListed: (value: readonly { readonly identity: string }[]) => { listed = value; },
    setRemoveFailure: (value: unknown) => { removeFailure = value; },
    counts: () => ({ removeCalls, listCalls, clientCalls, releaseCalls }),
    credentialFence: { verify: options.credentialFence.verify.bind(options.credentialFence), close: async () => undefined },
    setFenceActive: (value: boolean) => { fenceActive = value; },
    verified,
  };
}

test("room admin uses the exact self-hosted SDK origin once and releases both secret leases", async () => {
  for (const apiUrl of [undefined, 'http://127.0.0.1:7880']) {
    const f = fixture(undefined, apiUrl);
    await f.bundle.roomAdmin.removeParticipant("paios-r-room", "paios-g-participant");
    const listed = await f.bundle.roomAdmin.listParticipants("paios-r-room");
    assert.deepEqual(listed, [{ identity: "paios-g-present" }]);
    assert.deepEqual(f.counts(), { removeCalls: 1, listCalls: 1, clientCalls: 2, releaseCalls: 4 });
    await f.bundle.close();
  }
});

test("removal is idempotent only on LiveKit not_found; a proxy 404 for an unrouted method is a failure", async () => {
  const f = fixture();
  f.setRemoveFailure(Object.assign(new Error("participant not found"), { status: 404, code: "not_found" }));
  await f.bundle.roomAdmin.removeParticipant("paios-r-room", "paios-g-participant");
  f.setRemoveFailure(Object.assign(new Error('{"error":"ROUTE_NOT_FOUND"}'), { status: 404 }));
  await assert.rejects(f.bundle.roomAdmin.removeParticipant("paios-r-room", "paios-g-participant"), /LIVEKIT_ADMIN_SERVICE_FAILED/);
});

test("media-stop binding and credential fence come from the current T02 projection", async () => {
  const f = fixture();
  const intent = {
    wireRequest: {},
    request: {
      operation: "media_stop",
      realtimeSessionRef: SESSION,
      deviceLeaseRef: OLD_LEASE,
      continuityId: "continuity-1",
      deviceId: "iphone-owner",
      expectedConnectionEpoch: "7",
      credentialGeneration: "1",
    },
    governance: {},
    fingerprint: "fingerprint-1",
  };
  const binding = await f.bundle.binding.resolveMediaStop({ intent });
  assert.match(binding.roomName, /^paios-r-[a-p]{64}$/u);
  assert.match(binding.participantIdentity, /^paios-g-[a-p]{64}$/u);
  const tuple = await f.bundle.binding.resolveCredentialFence({ binding, operation: "media_stop" });
  assert.equal(tuple.credentialGeneration, "1");
  assert.equal(f.verified.length, 1);
  await assert.rejects(
    f.bundle.binding.resolveMediaStop({ intent: { ...intent, request: { ...intent.request, deviceId: "request-device" } } }),
    /LIVEKIT_ADMIN_MEDIA_INTENT_BINDING_INVALID/u,
  );
});

test("handoff resolves the old participant only after T02 exposes the new authoritative lease", async () => {
  const f = fixture();
  f.setCurrent(projection({ handoff: true }));
  const binding = await f.bundle.binding.resolveHandoff({
    request: {
      operation: "handoff",
      realtimeSessionRef: SESSION,
      continuityId: "continuity-1",
      fromDeviceId: "iphone-owner",
      expectedConnectionEpoch: "7",
    },
    authorityResult: {
      state: "completed",
      realtimeSessionRef: SESSION,
      continuityId: "continuity-1",
      activeDeviceId: "watch-owner",
      activeDeviceLeaseRef: NEW_LEASE,
      connectionEpoch: "7",
      leaseVersion: "2",
      fencingToken: "2",
      suppressedDeviceId: "iphone-owner",
    },
  });
  assert.equal(binding.deviceId, "iphone-owner");
  assert.deepEqual(binding.deviceLeaseRef, OLD_LEASE);
  const fence = await f.bundle.binding.resolveHandoffFence({ binding, fingerprint: "handoff-1", authorityResult: undefined });
  assert.deepEqual(fence.previousDeviceLeaseRef, OLD_LEASE);
  assert.deepEqual(fence.newDeviceLeaseRef, NEW_LEASE);
  assert.equal(fence.fencingToken, "2");
  assert.equal(fence.evidenceRefs.length, 2);
});

test("readiness, current-binding drift, and close fail closed", async () => {
  const f = fixture();
  f.setReady(false);
  assert.equal(f.bundle.roomAdmin.isReady(), false);
  await assert.rejects(f.bundle.roomAdmin.listParticipants("paios-r-room"), /LIVEKIT_ADMIN_NOT_READY/u);
  f.setReady(true);
  await Promise.all([f.bundle.close(), f.bundle.close()]);
  assert.equal(f.bundle.binding.isReady(), false);
  await assert.rejects(
    f.bundle.binding.resolveReconnectBinding({ participant: f.oldParticipant }),
    /LIVEKIT_ADMIN_CLOSED/u,
  );
});

test("constructor rejects plaintext URL, secret ref, or missing production owner", () => {
  const f = fixture();
  const base = {
    serverUrl: PAIOS_SELF_HOSTED_LIVEKIT_URL,
    apiKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey,
    apiSecretRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    secretResolver: { resolve: async () => ({ read: () => "x" }) },
    participant: { snapshot: () => ({ connected: false, transportState: "disconnected" }), bindingSnapshot: () => undefined },
    readCurrentBinding: async () => undefined,
    credentialFence: { verify: async () => ({ active: false }) },
    readiness: () => true,
  };
  assert.throws(
    () => createRealtimePublicControlLiveKitRoomAdmin({ ...base, serverUrl: "https://other.example:9443" } as never),
    /INVALID_LIVEKIT_CLOUD_URL/u,
  );
  assert.throws(
    () => createRealtimePublicControlLiveKitRoomAdmin({ ...base, apiKeyRef: { name: "other" } } as never),
    /LIVEKIT_ADMIN_API_KEY_REF_INVALID/u,
  );
  assert.equal(f.bundle.credentialFence !== undefined, true);
});

function disconnectionFixture(options: {
  readonly listed?: readonly { readonly identity: string }[];
  readonly listError?: Error;
  readonly pending?: boolean;
  readonly ready?: boolean;
} = {}) {
  let listCalls = 0;
  let releaseCalls = 0;
  const registration = createRealtimePublicControlLiveKitTransportDisconnection({
    serverUrl: PAIOS_SELF_HOSTED_LIVEKIT_URL,
    apiKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey,
    apiSecretRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    secretResolver: {
      resolve: async (reference) => ({
        read: () => reference.name === "livekit-api-key" ? "k".repeat(16) : "s".repeat(32),
        release: () => { releaseCalls += 1; },
      }),
    },
    readiness: () => options.ready !== false,
    now: () => Date.parse("2030-01-01T00:00:05.000Z"),
    timeoutMs: 10,
    createRoomService: () => ({
      removeParticipant: async () => undefined,
      listParticipants: async () => {
        listCalls += 1;
        if (options.listError !== undefined) throw options.listError;
        if (options.pending === true) return await new Promise<never>(() => undefined);
        return options.listed ?? [];
      },
    }),
  });
  const input = {
    binding: projection().session.binding,
    userId: "cycling-owner",
    deviceId: "iphone-owner",
    occurredAt: "2030-01-01T00:00:00.000Z",
    governance: { purpose_scopes: ["cycling_assistant"] },
  } as const;
  return { registration, input, counts: () => ({ listCalls, releaseCalls }) };
}

test("LiveKit room-empty disconnection proof is PG-free and binds the authoritative outer transaction tuple", async () => {
  const f = disconnectionFixture();
  const result = await f.registration.port.verify(f.input as never);
  assert.equal(result.verified, true);
  assert.equal(result.disconnectedAt, f.input.occurredAt);
  assert.deepEqual(f.counts(), { listCalls: 1, releaseCalls: 2 });
  const proof = result.authorityProof as Record<string, unknown>;
  assert.equal(proof.kind, "realtime.transport.disconnection.livekit-room-empty.v1");
  assert.equal(proof.deviceId, "iphone-owner");
  assert.equal(proof.continuityId, "continuity-1");
  assert.equal(proof.epoch, "7");
  assert.equal(proof.count, 0);
  assert.match(proof.roomName as string, /^paios-r-[a-p]{64}$/u);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.hasOwn(proof, "token"), false);
  assert.equal(Object.hasOwn(proof, "apiSecret"), false);
});

test("LiveKit disconnection proof rejects a nonempty room and authoritative binding drift", async () => {
  const occupied = disconnectionFixture({ listed: [{ identity: "participant-present" }] });
  await assert.rejects(occupied.registration.port.verify(occupied.input as never), /LIVEKIT_DISCONNECTION_ROOM_NOT_EMPTY/u);
  const drift = disconnectionFixture();
  await assert.rejects(
    drift.registration.port.verify({ ...drift.input, deviceId: "other-device" } as never),
    /LIVEKIT_DISCONNECTION_BINDING_INVALID/u,
  );
  assert.deepEqual(drift.counts(), { listCalls: 0, releaseCalls: 0 });
});

test("LiveKit disconnection proof times out, sanitizes service failure, and closes idempotently", async () => {
  const failed = disconnectionFixture({ listError: new Error("secret upstream detail") });
  await assert.rejects(failed.registration.port.verify(failed.input as never), /LIVEKIT_DISCONNECTION_SERVICE_FAILED/u);
  const pending = disconnectionFixture({ pending: true });
  await assert.rejects(pending.registration.port.verify(pending.input as never), /LIVEKIT_DISCONNECTION_TIMEOUT/u);
  await Promise.all([pending.registration.close?.(), pending.registration.close?.()]);
  assert.equal(pending.registration.readiness.isReady(), false);
  await assert.rejects(pending.registration.port.verify(pending.input as never), /LIVEKIT_DISCONNECTION_CLOSED/u);
});

test("credential tuple resolver permits both fence states and preserves identity checks", async () => {
  const f = fixture();
  const binding = await f.bundle.binding.resolveReconnectBinding({ participant: f.oldParticipant });
  f.setFenceActive(false);
  const unfenced = await f.bundle.binding.resolveCredentialFence({ binding, operation: "media_stop" });
  f.setFenceActive(true);
  const fenced = await f.bundle.binding.resolveCredentialFence({ binding, operation: "media_stop" });
  assert.deepEqual(unfenced, fenced);
  await assert.rejects(f.bundle.binding.resolveCredentialFence({ binding: { ...binding, connectionEpoch: "6" }, operation: "media_stop" }), /LIVEKIT_ADMIN_FENCE_BINDING_INVALID/u);
  await f.bundle.close();
});

test("persistent room resolver composed with production reconnect guard admits only unfenced current tuples", async () => {
  const f = fixture();
  let guard: ((binding: LiveKitCloudParticipantBinding) => Promise<void>) | undefined;
  const owner = createRealtimePublicControlExternalEffectProduction({
    binding: f.bundle.binding, roomAdmin: f.bundle.roomAdmin, credentialFence: f.credentialFence as never,
    participant: {
      snapshot: () => ({ connected: true, transportState: "connected" }),
      bindingSnapshot: () => f.oldParticipant,
      disconnect: async () => undefined, unpublishAllTracks: async () => undefined, verifyClosed: async () => undefined,
      setReconnectAdmissionGuard: (callback: typeof guard) => { guard = callback; },
    } as never,
    readiness: { participant: () => true, roomAdmin: () => true, credentialFence: () => true, binding: () => true },
  });
  assert.ok(guard);
  f.setFenceActive(false);
  await guard(f.oldParticipant);
  f.setFenceActive(true);
  await assert.rejects(guard(f.oldParticipant), /EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED/u);
  f.setFenceActive(false);
  await assert.rejects(guard({ ...f.oldParticipant, connectionEpoch: "6" }), /LIVEKIT_ADMIN_PARTICIPANT_BINDING_INVALID|EXTERNAL_EFFECT_PRODUCTION/u);
  await owner.close?.();
});

import { credentialFenceFixture } from '../../../services/platform-data/tests/fence-contract-fixture.ts';
function connectedProductionOwner(f: ReturnType<typeof fixture>,missingParticipant=false) {
  let guard: ((binding: LiveKitCloudParticipantBinding) => Promise<void>) | undefined;
  const owner = createRealtimePublicControlExternalEffectProduction({
    binding:f.bundle.binding,roomAdmin:f.bundle.roomAdmin,credentialFence:f.credentialFence as never,
    ...(missingParticipant?{participantForDevice:()=>undefined}:{}),
    participant:{snapshot:()=>({connected:true,transportState:'connected'}),bindingSnapshot:()=>f.oldParticipant,
      disconnect:async()=>undefined,unpublishAllTracks:async()=>undefined,verifyClosed:async()=>undefined,
      setReconnectAdmissionGuard:(callback:typeof guard)=>{guard=callback;}} as never,
    readiness:{participant:()=>true,roomAdmin:()=>true,credentialFence:()=>true,binding:()=>true}});
  assert.ok(guard);return {owner,guard};
}
test('actual fence no-row contract admits reconnect; actual active row still blocks reconnect',async t=>{
  const actual=credentialFenceFixture();const f=fixture(actual.fence);const {owner,guard}=connectedProductionOwner(f);
  t.after(async()=>{await owner.close?.();await f.bundle.close();await actual.fence.close();});
  const binding=await f.bundle.binding.resolveReconnectBinding({participant:f.oldParticipant});
  const tuple={realtimeSessionRef:SESSION,deviceLeaseRef:OLD_LEASE,continuityId:'continuity-1',connectionEpoch:'7',credentialGeneration:'1'};
  assert.deepEqual(await actual.fence.verify(tuple),{active:false});
  await guard(f.oldParticipant);
  assert.deepEqual(await f.bundle.binding.resolveCredentialFence({binding,operation:'media_stop'}),tuple);
  actual.client.active=true;
  assert.equal((await actual.fence.verify(tuple)).credentialGeneration,'1');
  await assert.rejects(guard(f.oldParticipant),/EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED/);
  assert.ok(actual.client.statements.some(sql=>sql.includes('pg_advisory_xact_lock')));
  actual.client.active=false;
  await assert.rejects(guard({...f.oldParticipant,connectionEpoch:'6'}),/EXTERNAL_EFFECT_PRODUCTION/);
});
test('declared generation drift and active missing generation remain rejected; absent inactive generation is not drift',async t=>{
  let snapshot:CredentialFenceSnapshot={active:false,credentialGeneration:'2'};
  const f=fixture({verify:async()=>snapshot});t.after(()=>f.bundle.close());
  const binding=await f.bundle.binding.resolveReconnectBinding({participant:f.oldParticipant});
  for(const value of [{active:false,credentialGeneration:'2'},{active:true,credentialGeneration:'2'},{active:true}] as CredentialFenceSnapshot[]){
    snapshot=value;await assert.rejects(f.bundle.binding.resolveCredentialFence({binding,operation:'media_stop'}),/LIVEKIT_ADMIN_FENCE_GENERATION_DRIFT/);
  }
  snapshot={active:false};await f.bundle.binding.resolveCredentialFence({binding,operation:'media_stop'});
  snapshot={active:true,credentialGeneration:'1'};await f.bundle.binding.resolveCredentialFence({binding,operation:'media_stop'});
});

import { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import { createRealtimeCredentialFence } from '../../../services/platform-data/src/realtime-credential-fence.ts';
test('isolated PG no-row and active-row fence feed the actual production reconnect guard',
  {skip:process.env.RUN_FENCE_OWN_SCHEMA_PG !== '1'},async()=>{
  const schema=`fence_sol_20261004_${Date.now()}`;
  assert.match(schema,/^fence_sol_20261004_[0-9]+$/);
  const pool=createPostgresPool({host:'127.0.0.1',port:55439,user:'l3test',database:'postgres',password:'',connectionTimeoutMillis:2000});
  let created=false;let f:ReturnType<typeof fixture>|undefined;let owner:ReturnType<typeof connectedProductionOwner>['owner']|undefined;
  const mappedPool={connect:async()=>{const client=await pool.connect();return {
    query:(sql:string,params?:readonly unknown[])=>client.query(sql.replaceAll('public.realtime_external_effects',`${schema}.realtime_external_effects`),params as unknown[]),
    release:()=>client.release()};}};
  const actual=createRealtimeCredentialFence(mappedPool as never);
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);created=true;
    await pool.query(`CREATE TABLE ${schema}.realtime_external_effects(operation text,request_scope text,
      realtime_session_ref jsonb,device_lease_ref jsonb,continuity_id text,connection_epoch numeric,
      credential_generation numeric,effect_state text,stage_state jsonb,fencing_epoch numeric)`);
    f=fixture(actual);const connected=connectedProductionOwner(f);owner=connected.owner;
    const tuple={realtimeSessionRef:SESSION,deviceLeaseRef:OLD_LEASE,continuityId:'continuity-1',connectionEpoch:'7',credentialGeneration:'1'};
    assert.deepEqual(await actual.verify(tuple),{active:false});await connected.guard(f.oldParticipant);
    await pool.query(`INSERT INTO ${schema}.realtime_external_effects VALUES
      ('media_stop','realtime.external.media_stop',$1::jsonb,$2::jsonb,'continuity-1',7,1,'in_flight','{}',1)`,
      [JSON.stringify(SESSION),JSON.stringify(OLD_LEASE)]);
    assert.equal((await actual.verify(tuple)).credentialGeneration,'1');
    await assert.rejects(connected.guard(f.oldParticipant),/EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED/);
    await pool.query(`UPDATE ${schema}.realtime_external_effects SET effect_state='indeterminate'`);
    await assert.rejects(connected.guard(f.oldParticipant),/EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED/);
    await pool.query(`UPDATE ${schema}.realtime_external_effects SET effect_state='committed'`);
    await assert.rejects(connected.guard(f.oldParticipant),/EXTERNAL_EFFECT_PRODUCTION_RECONNECT_FENCED/);
    await pool.query(`DELETE FROM ${schema}.realtime_external_effects`);await connected.guard(f.oldParticipant);
    console.log(JSON.stringify({schema,port:55439,namespace_mapping_only:true,normal_reconnect:true,
      blocking_states:['in_flight','indeterminate','committed'],real_livekit:'not_run'}));
  } finally {
    await owner?.close?.();await f?.bundle.close();await actual.close();
    try {if(created){await pool.query(`DROP SCHEMA ${schema} CASCADE`);console.log(JSON.stringify({schema,cleanup:'dropped'}));}}
    finally {await pool.end();}
  }
});

 test('configured LiveKit disconnect uses private admin origin while public TLS URL remains separate', async () => {
  const hosts: string[] = [];
  const base = {serverUrl: 'wss://192.0.2.1:9443', apiUrl: 'http://127.0.0.1:7880',
    apiKeyRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiKey, apiSecretRef: PERSISTENT_PUBLIC_SECRET_REFERENCES.livekitApiSecret,
    secretResolver: {resolve: async () => ({read: () => 'x'.repeat(32)})}, readiness: () => true,
    createRoomService: ({host}: {host: string}) => {hosts.push(host); return {listParticipants: async () => [], removeParticipant: async () => undefined};}};
  const disconnect = createRealtimePublicControlLiveKitTransportDisconnection(base);
  await disconnect.port.verify({binding: projection().session.binding, userId: 'cycling-owner', deviceId: 'iphone-owner', occurredAt: '2030-01-01T00:00:00.000Z', governance: {purpose_scopes: ['cycling_assistant']}} as never);
  assert.deepEqual(hosts, ['http://127.0.0.1:7880']);
  await disconnect.close?.();
 });


test("handoff resolves authoritative previous aliases after the old device is no longer loaded", async () => {
  const f=fixture(undefined,undefined,true);
  const previousBinding=projection().session.binding;
  f.setCurrent(projection({handoff:true}));
  const old=await f.bundle.binding.resolveHandoff({previousBinding,
    request:{operation:"handoff",realtimeSessionRef:SESSION,continuityId:"continuity-1",fromDeviceId:"iphone-owner",expectedConnectionEpoch:"7"},
    authorityResult:{state:"completed",realtimeSessionRef:SESSION,continuityId:"continuity-1",activeDeviceId:"watch-owner",
      activeDeviceLeaseRef:NEW_LEASE,connectionEpoch:"7",leaseVersion:"2",fencingToken:"2",suppressedDeviceId:"iphone-owner"},
  });
  assert.equal(old.deviceId,"iphone-owner");assert.deepEqual(old.deviceLeaseRef,OLD_LEASE);
  const fence=await f.bundle.binding.resolveHandoffFence({binding:old,fingerprint:"removed-old",authorityResult:undefined});
  assert.deepEqual(fence.newDeviceLeaseRef,NEW_LEASE);
  const {owner}=connectedProductionOwner(f,true);
  const suppression=await owner.suppressAndClose({binding:old,fingerprint:"removed-old",operation:"handoff"}) as {closure_status:string};
  assert.equal(suppression.closure_status,"verified_closed");
  assert.equal(f.counts().removeCalls,1);
  await assert.rejects(f.bundle.binding.resolveHandoff({previousBinding:{...previousBinding,deviceId:"wrong"},
    request:{fromDeviceId:"iphone-owner"},authorityResult:{}}),/LIVEKIT_ADMIN_HANDOFF_BINDING_INVALID/);
  await owner.close?.();
  await f.bundle.close();
});
