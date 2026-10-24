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
import { RunAdmission } from '../../../services/personal-aios-integration/src/admission.ts';
import { OutputAuthority } from '../../../services/personal-aios-integration/src/output.ts';
import { OutputTargetAuthority } from '../../../services/personal-aios-integration/src/routing.ts';
import { PersonalAIOSRuntime } from '../../../services/personal-aios-integration/src/runtime.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256, type NativeClient, type NativeRun } from '../../../services/personal-aios-integration/src/hermes-client.ts';
import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import { FormalSourceAuthority } from '../src/personal-aios-formal-source.ts';
import { createFormalTextIngress, FORMAL_TEXT_INPUT_TOPIC, FORMAL_TEXT_OUTPUT_TOPIC } from '../src/personal-aios-formal-text.ts';
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
async function eventually(predicate:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('TEST_TIMEOUT');}

import {inspectWav} from '../../../services/personal-aios-integration/src/tts.ts';
function wavFixture(){const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);return inspectWav(bytes);}
for(const scenario of ['ready','failed','detach'] as const)test(`actual formal automatic text before TTS; independent ${scenario}`,async t=>{
 const f=fixture(['text','voice']),root=await fs.mkdtemp(join(tmpdir(),'paios-formal-voice-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
 let creates=0,calls=0;const runs=new Map<string,NativeRun>(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const native=new HermesClient('http://127.0.0.1:1','controlled-private-token-24',1000,8192,undefined,async(_url,options)=>{
  if(new URL(String(_url)).pathname.startsWith('/api/sessions'))return Response.json({data:[]});
  if(new URL(String(_url)).pathname.endsWith('/events'))return new Response(': no fixture progress\n\n',{headers:{'content-type':'text/event-stream'}});
  if(options?.method==='POST' && !String(_url).endsWith('/stop')) {const body=JSON.parse(String(options.body));creates++;runs.set('native-one',{schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'controlled',granted_toolsets:body.grant_toolsets,run_id:'native-one',session_id:body.session_id,conversation_session_id:body.session_id,status:'running'});}
  return new Response(JSON.stringify(runs.get('native-one')),{status:200});
 });
 const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'controlled'});
 const out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),tts:{synthesize:async()=>{calls++;entered.resolve();await release.promise;if(scenario==='failed')throw Error('failed');return wavFixture();}}});
 const errors:unknown[]=[],runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:out,sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});
 const listeners=new Map<string,(...args:readonly unknown[])=>void>(),publications:any[]=[];
 const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:readonly unknown[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{publications.push(JSON.parse(Buffer.from(bytes).toString()));}}};
 const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,onError:error=>errors.push(error)});
 t.after(async()=>{release.resolve();await bridge.close();await runtime.close();});await bridge.onBootstrapConnected(f.input);
 const send=(body:unknown)=>listeners.get(RoomEvent.DataReceived)?.(Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
 send({operation:'submit',event_id:'voice-event',captured_at:now,text:'explicit controlled'});await eventually(()=>publications.some(x=>x.operation==='accepted'));
 const accepted=publications.find(x=>x.operation==='accepted'),source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
 await eventually(async()=>!!(await runtime.event(source,'continuity',accepted.processed_event_id)).admission.run_id);
 await runtime.tool('paios_open_reply',{context:{run_id:'native-one',session_id:'continuity',tool_call_id:'open-one'},args:{reply_mode:'text_and_voice'}});runs.get('native-one')!.output='sealed text';runs.get('native-one')!.status='completed';
 await entered.promise;await eventually(()=>publications.some(x=>x.operation==='text_chunk'));const header=publications.find(x=>x.operation==='result_header');assert.equal(header.voice_status,'pending');assert.equal(header.reply_status,'complete');assert.equal(header.voice_transport,'not_supported');assert.equal(calls,1);assert.equal(creates,1);
 const early=await runtime.result(source,'continuity',accepted.processed_event_id);assert.equal(early.result.voice_status,'pending');assert.equal(early.result.reply_text,'sealed text');assert.equal(calls,1);
 const text=publications.filter(x=>x.operation==='text_chunk');assert.equal(text.map(x=>x.chunk.text).join(''),'sealed text');assert.equal(header.delivery_status,'unknown');
 if(scenario==='detach'){await bridge.close();const count=publications.length;release.resolve();await runtime.close();assert.equal(publications.length,count);assert.equal((runtime as any).resultListeners.size,0);return;}
 const chunk=text[0].chunk;await runtime.acknowledge(source,'continuity',accepted.processed_event_id,{...chunk,highest_contiguous_seq:text.length,status:'rendered',observed_at:now});release.resolve();
 await eventually(()=>publications.filter(x=>x.operation==='result_header').length===2);const next=publications.filter(x=>x.operation==='result_header')[1];assert.equal(next.voice_status,scenario);assert.equal(next.reply_status,'complete');assert.equal(next.delivery_status,'partial');assert.equal(publications.filter(x=>x.operation==='text_chunk').length,text.length);assert.equal((runtime as any).resultListeners.size,0);assert.equal(errors.length,0);
 const result=await runtime.result(source,'continuity',accepted.processed_event_id);assert.equal(result.result.reply_text,'sealed text');assert.equal(result.chunks.length,0);assert.equal(creates,1);
 if(scenario==='failed'){await runtime.retryVoice(source,'continuity',accepted.processed_event_id);assert.equal(creates,1);assert.equal(calls,2);}
});
