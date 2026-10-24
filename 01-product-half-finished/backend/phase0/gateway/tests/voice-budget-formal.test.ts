import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataPacketKind, RoomEvent } from '@livekit/rtc-node';
import { REALTIME_ASSISTANT_MAX_PACKET_BYTES } from '../src/realtime-public-control-assistant-bridge.ts';
import { canonical, type ProcessedEvent } from '../../../services/personal-aios-integration/src/contracts.ts';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import { RawArchive } from '../../../services/personal-aios-integration/src/archive.ts';
import {nativeRunStreamFixture,waitForNativeCondition} from '../../../services/personal-aios-integration/tests/native-run-stream-fixture.ts';
import { RunAdmission } from '../../../services/personal-aios-integration/src/admission.ts';
import { OutputTargetAuthority } from '../../../services/personal-aios-integration/src/routing.ts';
import { OutputAuthority } from '../../../services/personal-aios-integration/src/output.ts';
import { PersonalAIOSRuntime } from '../../../services/personal-aios-integration/src/runtime.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256, type NativeClient, type NativeRun } from '../../../services/personal-aios-integration/src/hermes-client.ts';
import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import { FormalSourceAuthority } from '../src/personal-aios-formal-source.ts';
import { createFormalTextIngress, FORMAL_TEXT_INPUT_TOPIC, FORMAL_TEXT_OUTPUT_TOPIC } from '../src/personal-aios-formal-text.ts';
const NATIVE_REQUEST_TIMEOUT_MS=1000;
const eventually=(predicate:()=>boolean|Promise<boolean>)=>waitForNativeCondition(predicate,NATIVE_REQUEST_TIMEOUT_MS);
const now='2026-10-01T00:00:00.000Z', future='2026-10-01T01:00:00.000Z';
const sessionRef={ref_type:'realtime_session',ref_id:'source-session'}, leaseRef={ref_type:'device_lease',ref_id:'source-lease'};
function fixture(modes=['text']) {
  const input={request:{request_id:'bootstrap'},bearer:{principal:{opaque_ref:'not-user-id'},deviceId:'mac'},governance:{accepted:true},authority:{gateway:{identity:'controlled-source-gateway',roomName:'room'}},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',credentialRoom:'room',credentialIdentity:'terminal'},
    enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const current={session:{realtimeSessionRef:sessionRef,userId:'actual-owner',continuityId:'continuity',state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:future,activeDeviceId:'mac',activeDeviceLeaseRef:leaseRef,
    binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',deviceId:'mac',connectionEpoch:'1'}},
    lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'continuity',userId:'actual-owner',deviceId:'mac',state:'active',
      expiresAt:future,leaseVersion:'1',fencingToken:'1'}} as unknown as RealtimeCurrentBindingProjection;
  let route='route-1',fail=false;
  const authority=new FormalSourceAuthority({ownerContext:{resolve:async({bearer})=>{
    assert.deepEqual(bearer.principal,{opaque_ref:'not-user-id'});return {userId:'actual-owner',deviceId:'mac',purpose:'typed-submit',capabilities:['data'],occurredAt:now as never};}},
    readCurrentBinding:async lookup=>{assert.deepEqual(lookup,{realtimeSessionRef:sessionRef});if(fail)throw new Error('CURRENT_AUTH_UNAVAILABLE');return current;},
    sameRef:(a,b)=>canonical(a)===canonical(b),now:()=>Date.parse(now),resolveSource:async()=>({device_type:'mac',channel:'rtc_typed_text',consent_ref:'submit-consent',route_version:route,output_modes:modes})});
  return {input,current,authority,setRoute:(value:string)=>{route=value;},setFail:()=>{fail=true;}};
}

import {inspectWav} from '../../../services/personal-aios-integration/src/tts.ts';
function wavFixture(){const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);return inspectWav(bytes);}
test('original admission output budget queues four native completions, drains within budget, and closes without native rerun',async t=>{
 const f=fixture(['text','voice']),root=await fs.mkdtemp(join(tmpdir(),'paios-voice-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const storage=new PosixStorage(root),archive=new RawArchive(storage,8192);let creates=0,calls=0;
 const signals:AbortSignal[]=[];const runs=new Map<string,NativeRun>(),release=Array.from({length:4},()=>Promise.withResolvers<void>());
 const stream=nativeRunStreamFixture(runId=>runs.get(runId)!);
 const native=new HermesClient('http://127.0.0.1:1','controlled-private-token-24',NATIVE_REQUEST_TIMEOUT_MS,8192,undefined,async(input,options)=>{
  if(new URL(String(input)).pathname.startsWith('/api/sessions'))return Response.json({data:[]});
  if(new URL(String(input)).pathname.endsWith('/events'))return stream.response(new URL(String(input)),options?.signal);
  if(options?.method==='POST' && !String(input).endsWith('/stop')) {const body=JSON.parse(String(options.body));const run_id='native-'+ ++creates;const run={schema:'hermes.run.v2' as const,shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'controlled',granted_toolsets:body.grant_toolsets,run_id,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run_id,run);return new Response(JSON.stringify(run),{status:202});}
  const run_id=String(input).split('/').at(-1)!;return new Response(JSON.stringify(runs.get(run_id)),{status:200});
 });
 const admission=new RunAdmission(storage,native,{max_pending_events:2,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'original-budget'});
 const out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async(_text,_id,signal)=>{const index=calls++;signals.push(signal!);await release[index]!.promise;return wavFixture();}}});
 const errors:unknown[]=[],runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:out,sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
 const listeners=new Map<string,(...args:readonly unknown[])=>void>(),publications:any[]=[];
 const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:readonly unknown[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>publications.push(JSON.parse(Buffer.from(bytes).toString()))}};
 const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
 t.after(async()=>{for(const item of release)item.resolve();await bridge.close();await runtime.close();});await bridge.onBootstrapConnected(f.input);const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));const ids:string[]=[];
 for(let index=1;index<=4;index++){
  listeners.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify({operation:'submit',event_id:'event-'+index,captured_at:now,text:'prompt '+index})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  await eventually(()=>publications.some(x=>x.operation==='accepted' && x.event_id==='event-'+index));const dId=publications.find(x=>x.operation==='accepted' && x.event_id==='event-'+index).processed_event_id;ids.push(dId);
  await eventually(async()=>!!(await runtime.event(source,'continuity',dId)).admission.run_id);await runtime.tool('paios_open_reply',{context:{run_id:'native-'+index,session_id:'continuity',tool_call_id:'open-'+index},args:{reply_mode:'text_and_voice'}});runs.get('native-'+index)!.output='text '+index;runs.get('native-'+index)!.status='completed';stream.update('native-'+index);
  await eventually(()=>publications.some(x=>x.operation==='text_chunk' && x.processed_event_id===dId));const value=await runtime.result(source,'continuity',dId);
  assert.equal(value.result.reply_text,'text '+index);assert.equal(value.result.result_status,'completed');
  assert.equal(value.result.voice_status,'pending');assert.equal(value.result.voice_error,null);
  // Pending confirms admission; the provider starts asynchronously after text delivery.
  await eventually(()=>calls===Math.min(index,2));
  assert.equal(calls,Math.min(index,2));assert.deepEqual(value.voice_chunks,[]);

 }
 assert.equal(creates,4);assert.equal(calls,2);
 // Completing one provider task releases one original output slot, so the next queued turn starts.
 release[0]!.resolve();await eventually(()=>calls===3);
 await eventually(async()=>((await runtime.result(source,'continuity',ids[0]!)).result.voice_status==='ready'));
 assert.equal((await runtime.result(source,'continuity',ids[3]!)).result.voice_status,'pending');
 assert.equal(calls,3);assert.equal(creates,4);
 await runtime.cancelPlayback(source,'continuity',ids[1]!,1);assert.equal(signals[1]!.aborted,true);
 assert.equal((await runtime.result(source,'continuity',ids[1]!)).result.reply_phase,'interrupted');
 release[1]!.resolve();await eventually(()=>calls===4);
 const d=(await runtime.event(source,'continuity',ids[3]!)).processed_event;
 const ctx={principal_id:d.principal_id,run_id:'native-4',session_id:'continuity',tool_call_id:'final-buffer',d,target:await new OutputTargetAuthority(storage).read(d)};
 let closed=false;const closing=runtime.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
 assert.equal(signals[2]!.aborted,true);assert.equal(signals[3]!.aborted,true);
 release[2]!.resolve();release[3]!.resolve();await closing;
 assert.equal(closed,true);assert.equal(calls,4);assert.equal(creates,4);assert.deepEqual(errors,[]);
 const retained=await out.readFinalized(ctx);assert.equal(retained.result.reply_text,'text 4');assert.equal(retained.result.voice_error,'TTS_SYNTHESIS_CANCELLED');
});
