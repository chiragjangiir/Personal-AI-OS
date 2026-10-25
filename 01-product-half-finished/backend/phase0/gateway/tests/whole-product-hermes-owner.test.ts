// Synthetic gateway trust root for the pairing fixture.
process.env.PAIOS_GATEWAY_ROOT_SPKI_SHA256 = 'a1'.repeat(32);
import {connect} from 'node:net';
import {RealtimePublicControlController} from '../src/realtime-public-control-controller.ts';
import './gateway-test-port.ts';
import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import { makeMacProductResourceFixture } from './mac-product-resource-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { DataPacketKind, RoomEvent } from '@livekit/rtc-node';
import { createRayneoPersistentProductionHandoff, startRayneoPersistentProduction, createRayneoPersistentPublicControl,
  type WholeProductOwnerPorts, type HermesProductLauncherInput } from '../src/rayneo-persistent-production-entrypoint.ts';
import { createPersistentPublicExecutionOwner, type CentralTextResources } from '../src/persistent-public-execution-owner.ts';
import { FORMAL_TEXT_INPUT_TOPIC } from '../src/personal-aios-formal-text.ts';
import { Phase0SharedSessionOwner } from '../src/phase0-shared-session-owner.ts';
import type { RayneoPairingRecord } from '../src/rayneo-pairing-registry.ts';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import type { NativeClient, NativeRun } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import { startDemoRoamingGateway } from '../src/main.ts';
import { GATEWAY_HOST_HEADER, GATEWAY_PORT } from '../src/gateway-binding.ts';
import { QWEN38_ORCAROUTER_CANARY_PROFILE } from '../src/qwen38-provider-adapter.ts';
import { makePublicControl } from './whole-product-public-owner-fixture.ts';

const SECRET = Buffer.alloc(32, 1).toString('base64url');
const DEVICE = 'rayneo_device_bbbbbbbbbbbbbbbbbbbb';
const INSTALL = 'rayneo_install_aaaaaaaaaaaaaaaaaaaa';
const CLIENT = 'rayneo_client_cccccccccccccccccccc';
class Registry {
  value: RayneoPairingRecord | undefined;
  read() { return this.value; }
  writePaired(input: {installId:string;deviceId:string;keyId:string;publicKeySpkiB64url:string;pairedAtUtc:string}) {
    this.value = {schema:'paios.rayneo.pairing.registry.v1',generation:1,state:'paired',
      install_id:input.installId,device_id:input.deviceId,key_id:input.keyId,
      public_key_spki_b64url:input.publicKeySpkiB64url,gateway_hostname:'paios-gateway.local',
      root_spki_sha256:'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
      paired_at_utc:input.pairedAtUtc,revoked_at_utc:null,revoke_reason:null} as RayneoPairingRecord;
    return this.value;
  }
  revoke(input: {deviceId:string;keyId:string;revokedAtUtc:string}) {
    assert.equal(this.value?.device_id,input.deviceId);
    assert.equal(this.value?.key_id,input.keyId);
    this.value = {...this.value!,state:'revoked',generation:2,revoked_at_utc:input.revokedAtUtc,revoke_reason:'owner_revoke'};
    return this.value;
  }
}
function http(path:string,body:unknown,headers:Record<string,string>={}) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const localOwner = ['/phase0/rayneo/pairing/v1/owner-decision','/phase0/rayneo/pairing/v1/revoke'].includes(path)
    ? {'X-PAIOS-Proxy-Attestation':SECRET} : {};
  const caddy = headers.Host !== GATEWAY_HOST_HEADER && [
    '/phase0/rayneo/pairing/v1/begin', '/phase0/rayneo/pairing/v1/complete',
    '/phase0/rayneo/v1/bootstrap', '/phase0/rayneo/v1/low-rate-capability',
    '/phase0/rayneo/v1/debug-local/bootstrap',
  ].includes(path) ? {
    Host:RAYNEO_ROAMING_HOST,'X-Forwarded-For':'198.51.100.88','X-Forwarded-Host':RAYNEO_ROAMING_HOST,
    'X-Forwarded-Proto':'https','X-PAIOS-Proxy-Attestation':SECRET,
    'X-PAIOS-Trusted-Edge':'tencent-nginx-loopback-v1','X-PAIOS-Trusted-Source-Family':'ipv4',
  } : {};
  return new Promise<{status:number;body:any}>((resolve,reject) => {
    const req=request({hostname:'127.0.0.1',port:GATEWAY_PORT,path,agent:false,method:body===undefined?'GET':'POST',
      headers:{Host:GATEWAY_HOST_HEADER,...(body===undefined?{}:{Accept:'application/json','Content-Type':'application/json','Content-Length':String(bytes.length)}),...caddy,...localOwner,...headers}},res=>{
      const chunks:Buffer[]=[];
      res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });
    // Controlled Caddy projection has no hop-by-hop header; every test request owns its socket.
    req.removeHeader('Connection');
    if (Object.keys(caddy).length) {
      assert.equal(req.getHeader('Connection'), undefined);
      assert.equal(req.getHeader('Transfer-Encoding'), undefined);
    }
    req.on('error',reject);req.end(bytes);
  });
}
const RAYNEO_ROAMING_HOST='ai.example.invalid';
const inputReadiness={owner:'controlled-Hermes-ING-D',isReady:()=>true};

test('whole-product constructor selects Hermes before FinalTranscript/SourceMedia/Qwen and preserves real readiness',async t=>{
  const resources=makeMacProductResourceFixture();t.after(()=>resources.cleanup());
  const calls:string[]=[];
  const central={} as CentralTextResources;
  const pool={end:async()=>{calls.push('pool.close');}} as never;
  const forbidden=()=>{throw new Error('LEGACY_RESOURCE_ALLOCATED');};
  const ports:Partial<WholeProductOwnerPorts>={
    createPool:()=>{calls.push('pool');return pool;},inspectPostgres:async()=>{calls.push('pg.probe');return true;},
    createSourceMedia:forbidden,createFinalTranscript:forbidden,
    createPublicOwner:async input=>{calls.push('public.owner');assert.equal(input.executionOwner,'hermes_text');
      assert.equal(input.central,central);assert.equal(input.inputReadiness,inputReadiness);
      assert.equal(input.finalTranscriptEvidence,undefined);assert.equal(input.sourceMedia,undefined);
      return makePublicControl().handoff;},
  };
  const result=await createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources:resources.config,central,inputReadiness},ports);
  assert.ok('executionOwner' in result.launcherInput);
  assert.deepEqual(calls,['pool','pg.probe','public.owner']);
  assert.equal('memory' in result.launcherInput,false);assert.equal('t13' in result.launcherInput,false);
  await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'legacy'} as never,ports),/PUBLIC_EXECUTION_OWNER_INVALID/);
  await result.launcherInput.owner.close();
  const fail=new Error('PG_PROBE_FAILURE');
  await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources:resources.config,central,inputReadiness},
    {...ports,inspectPostgres:async()=>{throw fail;}}),error=>error===fail);
  assert.equal(calls.at(-1),'pool.close');
  await assert.rejects(createRayneoPersistentProductionHandoff({executionOwner:'hermes_text',product_resources:resources.config,central,
    inputReadiness:{owner:'ING',isReady:()=>false}},ports),/HERMES_INPUT_OWNER_NOT_READY/);
});

test('formal production start retires scratch RayNeo routes and retains Public RTC and central D/native owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'whole-hermes-'));let retire:(()=>Promise<void>)|undefined;
  t.after(async()=>{try{await retire?.();}finally{await rm(root,{recursive:true,force:true});}});
  const storage=new PosixStorage(root);
  const runs=new Map<string,NativeRun>();let creates=0,legacy=0;let admittedD:{raw_ref:string;archive_revision:string;payload_sha256:string;processed_event_id:string}|undefined;
  const native:NativeClient={create:async body=>{
    const d=JSON.parse(body.input);assert.equal(d.origin,'explicit_user_prompt');assert.equal(d.principal_id,'owner');
    admittedD=d;creates++;const run={run_id:'native-'+creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
    runs.set(run.run_id,run);return run;
  },status:async id=>({...runs.get(id)!}),cancel:async id=>({...runs.get(id)!,status:'cancelled'})};
  const now=Date.now();
  const sessionRef={ref_type:'RealtimeSession',ref_id:'controlled-session'};
  const leaseRef={ref_type:'DeviceLease',ref_id:'controlled-lease'};
  const principal={opaque:'controlled-principal'};const policy={ref_type:'PolicyDecision',ref_id:'controlled-policy'};
  const current={session:{realtimeSessionRef:sessionRef,userId:'owner',continuityId:'continuity',state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:new Date(now+600000).toISOString(),activeDeviceId:'phone',activeDeviceLeaseRef:leaseRef,
    binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',deviceId:'phone',connectionEpoch:'1'}},
    lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'continuity',userId:'owner',deviceId:'phone',state:'active',
      expiresAt:new Date(now+600000).toISOString(),leaseVersion:'1',fencingToken:'1',capabilities:['data'],policyDecisionRef:policy}};
  const t03={ownerContext:{resolve:async()=>({userId:'owner',deviceId:'phone',purpose:'assistant',capabilities:['data'],occurredAt:new Date(now).toISOString()})},
    formalWatchPrimaryAuthority:{resolve:async()=>({userId:'owner',deviceId:'phone',principalRef:principal,policyDecisionRef:policy})},
    readCurrentAuthority:()=>({userId:'owner',deviceId:'phone',principal,policyDecisionRef:policy,allowedMediaCapabilities:['data'],
      governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'consent'}]}})};
  const listeners=new Map<string,(...args:any[])=>void>();const packets:any[]=[];
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:any[])=>void)=>listeners.set(event,fn),
    off:(event:string)=>listeners.delete(event),localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>packets.push(JSON.parse(Buffer.from(bytes).toString()))}};
  const owned=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',central:{storage,native:sourceClient(native),
    admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'whole-fixture'},
    skill:'fixed',max_event_bytes:8192,max_read_bytes:8192,http:{internal_token:'controlled-token'.repeat(4),max_request_bytes:16384,request_timeout_ms:5000}},
    t03:t03 as never,readCurrentBinding:async()=>current as never,deviceId:'phone',participant:{roomPort:room} as never,
    onError:error=>assert.fail(String(error))});
  retire=()=>owned.assembly.close();
  assert.equal(owned.executionOwner,'hermes_text');
  if (owned.executionOwner !== 'hermes_text') throw new Error('OWNER_MISMATCH');
  const fixture=makePublicControl();const registry=new Registry();let ends=0;
  const handoff={...fixture.handoff,centralTextAssembly:owned.assembly,
    composition:{...fixture.handoff.composition,assistantBridge:owned.bridge}};
  const owner=new Phase0SharedSessionOwner();
  const launch:HermesProductLauncherInput={executionOwner:'hermes_text',owner,pool:{end:async()=>{ends++;}} as never,
    pairingRegistry:registry,environment:{PAIOS_DEMO_ROAMING:'1',PAIOS_GATE_A_LOCAL_DEVICE:'1',
      PAIOS_RAYNEO_LIVEKIT_URL:'ws://127.0.0.1:7880',PAIOS_RAYNEO_PROXY_ATTESTATION_SECRET:SECRET},inputReadiness};
  const oldEnv=process.env.PAIOS_DEBUG_RAYNEO_STT_URL;
  const handle=await startRayneoPersistentProduction(launch,{executionOwner:'hermes_text',publicControl:handoff});
  retire=()=>handle.close();assert.equal(process.env.PAIOS_DEBUG_RAYNEO_STT_URL,oldEnv);
  assert.equal((await http('/healthz',undefined)).status,200);
  assert.equal((await http('/v1/realtime/bootstrap',{})).status,422);
  for(const path of ['/phase0/rayneo/pairing/v1/begin','/phase0/rayneo/pairing/v1/complete',
    '/phase0/rayneo/pairing/v1/owner-decision','/phase0/rayneo/pairing/v1/revoke',
    '/phase0/rayneo/v1/bootstrap','/phase0/rayneo/v1/debug-local/bootstrap']) {
    assert.equal((await http(path,{})).status,404);
  }
  assert.equal(registry.read(),undefined);
  const input={request:{request_id:'controlled-bootstrap',requested_media:{data:true,audio:false,video:false},start:{modalities:['data']}},
    bearer:{principal,deviceId:'phone'},governance:{controlled:true},authority:{gateway:{identity:'controlled-gateway',roomName:'room'}},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',credentialIdentity:'terminal',credentialRoom:'room'},
    enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  owned.bridge.assertBootstrapRequest!(input.request);await owned.bridge.onBootstrapConnected!(input);
  listeners.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify({operation:'submit',event_id:'whole-source-event',captured_at:new Date(now).toISOString(),text:'whole production controlled D'})),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  for(let n=0;n<200 && creates===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(creates,1);assert.equal(legacy,0);
  const originals=await storage.list('manifests');assert.equal(originals.length,1);
  const original=JSON.parse(Buffer.from(await storage.read('manifests',originals[0]!)).toString());
  assert.equal(admittedD!.raw_ref,`l5:${originals[0]}`);assert.equal(admittedD!.archive_revision,original.archive_revision);
  const originalBytes=await storage.read('objects',original.payload_sha256);
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'),admittedD!.payload_sha256);
  assert.equal(Buffer.from(originalBytes).toString(),'whole production controlled D');
  assert.ok(packets.some(packet=>packet.operation==='accepted'));
  assert.equal((await readdir(root)).some(name=>name!=='run-conversation-releases'&&/history|remember|conversation/.test(name)),false);
  await Promise.all([handle.close(),handle.close()]);assert.equal(ends,1);
  assert.equal(fixture.gatewayClose(),1);assert.equal(fixture.bundleClose(),1);
  assert.equal(listeners.has(RoomEvent.DataReceived),false);
});

test('Hermes startup failure closes concrete public owner and native shared owner before borrowed pool',async()=>{
  const fixture=makePublicControl();let ends=0;
  const owner=new Phase0SharedSessionOwner();
  const launch:HermesProductLauncherInput={executionOwner:'hermes_text',owner,pool:{end:async()=>{ends++;}} as never,
    environment:{PAIOS_RAYNEO_PROXY_ATTESTATION_SECRET:SECRET},pairingRegistry:new Registry(),
    inputReadiness:{owner:'controlled-ING',isReady:()=>false}};
  await assert.rejects(startRayneoPersistentProduction(launch,{publicControl:{...fixture.handoff,
    centralTextAssembly:{} as never}}),/HERMES_EXECUTION_NOT_READY/);
  assert.equal(ends,1);assert.equal(fixture.gatewayClose(),1);assert.equal(fixture.bundleClose(),1);
  await owner.close();
});


test('partial HTTP body cannot delay runtime retirement beyond shared shutdown drain',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const entered=Promise.withResolvers<void>();let runtimeCloses=0;
  const unused=async()=>{throw new Error('UNEXPECTED_PROVIDER_OPERATION');};
  const controller=new RealtimePublicControlController({enabled:true,controlHost:'shutdown.invalid',edge:{authorize:async()=>{}},bearer:{authorize:unused},
    runtime:{bootstrap:unused,resolveE2eeKey:unused,refresh:unused,stop:unused,endContinuity:unused,close:async()=>{runtimeCloses++;}} as never,
    schemaRegistry:{validateRequest:()=>false,validateResponse:()=>false,validateTerminal:()=>false}});
  const realHandle=controller.handle.bind(controller);t.mock.method(controller,'handle',async(...args:Parameters<typeof realHandle>)=>{entered.resolve();return realHandle(...args);});
  const handle=await startDemoRoamingGateway(undefined,{listenerBinding:{host:'127.0.0.1',port:GATEWAY_PORT},installDemoSignalHandlers:false,
    publicRtcControl:controller,hermes:{isReady:()=>true,gateway:{config:{deviceLanSecurity:{publicHost:'shutdown.invalid'}},adapter:{}}} as never});
  const client=connect(GATEWAY_PORT,'127.0.0.1');client.on('error',()=>{});t.after(()=>client.destroy());
  await new Promise<void>(resolve=>client.once('connect',resolve));
  client.write('POST /v1/realtime/credentials/refresh HTTP/1.1\r\nHost: shutdown.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{');
  await entered.promise;const closing=handle.close().catch(error=>error);await new Promise(setImmediate);
  assert.equal(runtimeCloses,1,'Paid-call runtime teardown starts before the partial body drains');assert.ok(handle.server.requestTimeout<120000);
  t.mock.timers.tick(90000);const error=await closing;assert.ok(error instanceof AggregateError);
  assert.equal(handle.server.listening,false);assert.equal(runtimeCloses,1);client.destroy();
});


test('public shutdown begins call retirement independently of a blocked controller cascade',async()=>{
  const fixture=makePublicControl(),gate=Promise.withResolvers<void>();let retirementStarted=false;
  const control=await createRayneoPersistentPublicControl({...fixture.handoff,composition:{...fixture.handoff.composition,
    assistantBridge:{onBootstrapConnected:async()=>{},close:async()=>{retirementStarted=true;}}}});
  const original=control.controller.close.bind(control.controller);
  control.controller.close=async()=>{await gate.promise;await original();};
  const closing=control.close();await new Promise(setImmediate);assert.equal(retirementStarted,true);
  gate.resolve();await closing;
});
