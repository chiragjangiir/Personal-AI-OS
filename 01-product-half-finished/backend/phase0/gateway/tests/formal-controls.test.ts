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
import { RunAdmission } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import { OutputAuthority } from '../../../services/personal-aios-integration/src/output.ts';
import { OutputTargetAuthority } from '../../../services/personal-aios-integration/src/routing.ts';
import { PersonalAIOSRuntime } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type { NativeClient, NativeRun } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import { FormalSourceAuthority } from '../src/personal-aios-formal-source.ts';
import { createFormalTextIngress, FORMAL_TEXT_INPUT_TOPIC, FORMAL_TEXT_OUTPUT_TOPIC } from '../src/personal-aios-formal-text.ts';
const inertMacSource={principal_id:'actual-owner',device_id:'mac',device_type:'mac',capabilities:[],
  channel:'rtc_typed_text',consent_ref:'submit-consent',route_version:'route-1',output_modes:['text']};
const now='2026-10-01T00:00:00.000Z', future='2026-10-01T01:00:00.000Z';
const sessionRef={ref_type:'realtime_session',ref_id:'source-session'}, leaseRef={ref_type:'device_lease',ref_id:'source-lease'};
function fixture() {
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
    sameRef:(a,b)=>canonical(a)===canonical(b),now:()=>Date.parse(now),resolveSource:async()=>({device_type:'mac',channel:'rtc_typed_text',consent_ref:'submit-consent',route_version:route,output_modes:['text']})});
  return {input,current,authority,setRoute:(value:string)=>{route=value;},setFail:()=>{fail=true;}};
}
async function eventually(predicate:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('TEST_TIMEOUT');}
function testRoom() {
  const callbacks=new Map<string,Set<(...args:readonly unknown[])=>void>>(),published:unknown[]=[];
  return {isConnected:true,published,callbacks,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,callback:(...args:readonly unknown[])=>void)=>{
    if(!callbacks.has(event))callbacks.set(event,new Set());callbacks.get(event)!.add(callback);},
    off:(event:string,callback:(...args:readonly unknown[])=>void)=>{callbacks.get(event)?.delete(callback);},
    emit:(event:string,...args:readonly unknown[])=>{for(const callback of [...callbacks.get(event)??[]])callback(...args);},
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{published.push(JSON.parse(Buffer.from(bytes).toString('utf8')));}}};
}
test('formal controls invoke original runtime authorities with real POSIX admission/OUT; cancel is not capture Stop',async t=>{
 const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-control-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new PosixStorage(root),archive=new RawArchive(storage,8192);let cancels=0,creates=0;
 const run:NativeRun={run_id:'synthetic-control-run',session_id:'continuity',conversation_session_id:'continuity',status:'running'};
 const native:NativeClient={create:async()=>{creates++;return {...run};},status:async()=>({...run}),cancel:async()=>{cancels++;return {...run};}};
 const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'control-test'});
 const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});t.after(()=>runtime.close());
 const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
 const {processed_event:d}=await runtime.submit({schema_version:'paios.event.v1',event_id:'control-source',captured_at:now,device_id:'mac',device_type:'mac',source:{channel:source.channel},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('synthetic original')},source,'continuity',true);
 await eventually(async()=>Boolean((await runtime.event(source,'continuity',d.processed_event_id)).admission.run_id));
 const room=testRoom(),errors:unknown[]=[];const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:e=>errors.push(e)});t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
 const send=async(body:unknown)=>{const before=room.published.length;room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>room.published.length>before);return room.published.at(-1) as any;};
 const request={operation:'cancel_run',control_id:'cancel-1',processed_event_id:d.processed_event_id};
 const cancelled=await send(request);assert.equal(cancelled.operation,'control_receipt');assert.deepEqual(cancelled.receipt,{status:'cancel_requested',run_id:run.run_id,state:'running'});assert.equal(cancels,1);
 assert.equal((await runtime.event(source,'continuity',d.processed_event_id)).admission.state,'running');
 const again=await send(request);assert.deepEqual(again,cancelled);assert.equal(creates,1);
 const reconciled=await send({...request,operation:'reconcile',control_id:'reconcile-1'});assert.equal(reconciled.receipt.run_id,run.run_id);assert.equal(creates,1);
 const forged=await send({...request,principal_id:'foreign'});assert.equal(forged.operation,'rejected');assert.equal(forged.error_code,'FORMAL_CONTROL_ARGUMENT_INVALID');assert.equal(cancels,2);
 const other=await send({...request,processed_event_id:'unowned-D'});assert.equal(other.operation,'rejected');assert.equal(cancels,2);
 await runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:'continuity',tool_call_id:'reply'},args:{reply_mode:'text'}});
 run.status='completed';run.output='original immutable body';await runtime.result(source,'continuity',d.processed_event_id);const sealed=await runtime.result(source,'continuity',d.processed_event_id,{text_replay:'sealed'});assert.ok(sealed.chunks.length);
 const playback=await send({...request,operation:'cancel_playback',control_id:'playback-1',reply_epoch:sealed.result.reply_epoch});
 assert.equal(playback.receipt.playback_status,'unknown');assert.equal(playback.receipt.receipt.status,'interrupted');assert.equal(run.status,'completed');
 assert.deepEqual(await send({...request,operation:'cancel_playback',control_id:'playback-1',reply_epoch:sealed.result.reply_epoch}),playback);
 await assert.rejects(runtime.result(source,'continuity',d.processed_event_id,{text_replay:'sealed'}),/SEALED_TEXT_OLD_EPOCH/);const replay=await runtime.result(source,'continuity',d.processed_event_id);assert.equal(replay.result.reply_phase,'interrupted');assert.equal(replay.result.delivery_status,'unknown');assert.equal(replay.chunks.length,0);assert.equal(creates,1);
 const old=await send({...request,operation:'cancel_playback',reply_epoch:sealed.result.reply_epoch+1});assert.equal(old.operation,'rejected');
 if(process.env.CONTROL_WIRE_OUT)await fs.writeFile(process.env.CONTROL_WIRE_OUT,JSON.stringify({cancelled,reconciled,playback,forged,other,old},null,2));
 assert.ok(errors.length>=3);assert.equal((await archive.readRecord(d.raw_ref,d.principal_id,d.archive_revision)).kind,'original');
});
test('formal rejection carries bounded fixed code; unknown participant ignored and model JSON cannot confirm memory',async t=>{
 const f=fixture(),room=testRoom(),errors:unknown[]=[];let calls=0;
 const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>inertMacSource,cancelRunControl:async()=>{calls++;throw new Error('PRIVATE_DETAIL_MUST_NOT_ESCAPE');},confirmMemory:async()=>{throw new Error('MUST_NOT_CONFIRM');}} as unknown as PersonalAIOSRuntime;
 const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:e=>errors.push(e)});t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
 const emit=(body:unknown,identity='terminal')=>room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
 emit({operation:'cancel_run',control_id:'control',processed_event_id:'D'},'foreign');await new Promise(r=>setImmediate(r));assert.equal(room.published.length,0);assert.equal(calls,0);
 emit({operation:'cancel_run',control_id:'control',processed_event_id:'D'});await eventually(()=>room.published.length===1);const packet=room.published[0] as any;assert.equal(packet.operation,'rejected');assert.equal(packet.error_code,'FORMAL_TEXT_REQUEST_FAILED');assert.equal(JSON.stringify(packet).includes('PRIVATE_DETAIL'),false);
 emit({operation:'memory_confirm',command_id:'command',payload_sha256:'a'.repeat(64),authenticated:true,source:'explicit_user_ui'});await eventually(()=>room.published.length===2);assert.equal((room.published[1] as any).operation,'rejected');assert.equal(calls,1);
 emit({operation:'cancel_playback',control_id:'control',processed_event_id:'D',reply_epoch:0});await eventually(()=>room.published.length===3);assert.equal((room.published[2] as any).operation,'rejected');assert.equal(errors.length,3);
});
test('control handler close joins original cancel promise and stale epoch cannot publish receipt',async()=>{
 const f=fixture(),room=testRoom(),errors:unknown[]=[];let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);let calls=0;
 const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,
  runtime:{watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>inertMacSource,cancelRunControl:async()=>{calls++;enter();await gate;return {status:'running'};}} as unknown as PersonalAIOSRuntime,
  authority:f.authority,max_packet_bytes:12288,onError:e=>errors.push(e)});await bridge.onBootstrapConnected(f.input);
 room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'cancel_run',control_id:'control',processed_event_id:'D'})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await entered;
 let closed=false;const closing=bridge.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);release();await closing;assert.equal(calls,1);assert.equal(room.published.length,0);assert.equal(errors.length,1);
});
test('shared source contract rejects closed fields, nullable misuse, numeric booleans and stale control epochs before owners',async t=>{
 const f=fixture(),room=testRoom(),errors:unknown[]=[];let calls=0;
 const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>inertMacSource,cancelRunControl:async()=>{calls++;return {status:'running'};},reconcile:async()=>{calls++;return {state:'running'};},cancelPlayback:async()=>{calls++;return {playback_status:'unknown'};}} as unknown as PersonalAIOSRuntime;
 const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:e=>errors.push(e)});t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
 const base={operation:'cancel_playback',control_id:'contract-control',processed_event_id:'D-contract',reply_epoch:1};
 const invalid=[{operation:'__proto__'},{operation:'constructor'},{operation:'toString'},{...base,owner:'forged'},{...base,control_id:null},{...base,reply_epoch:true},{...base,reply_epoch:0},{...base,reply_epoch:9007199254740992},{...base,reply_epoch:1.5},
   {operation:'cancel_run',control_id:'contract-control',processed_event_id:'D-contract',reply_epoch:1},
   {operation:'result',processed_event_id:'D-contract',text_replay:null},
   {operation:'submit',event_id:'contract',captured_at:'2026-02-30T00:00:00.000Z',text:'source'},
   {operation:'ack',processed_event_id:'D-contract',ack:{output_id:'voice:one',reply_id:'reply',reply_epoch:1,target_device_id:'mac',route_version:'route-1',highest_contiguous_seq:1,status:'played',observed_at:now}}];
 for(const body of invalid){const count=room.published.length;room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>room.published.length>count);assert.equal((room.published.at(-1) as any).operation,'rejected');}
 assert.equal(calls,0);assert.equal(errors.length,invalid.length);
 room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(base)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);await eventually(()=>calls===1 && (room.published.at(-1) as any).operation==='control_receipt');
 assert.equal((room.published.at(-1) as any).receipt.playback_status,'unknown');
});
test('formal cancel_run of a queued D returns a durable local cancelled receipt and the D is never sent',async t=>{
 const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-queued-control-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),runs=new Map<string,NativeRun>(),inputs:string[]=[];let cancels=0;
 const native:NativeClient={create:async body=>{const run={run_id:'queued-control-'+(runs.size+1),session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
   runs.set(run.run_id,run);inputs.push((JSON.parse(body.input) as ProcessedEvent).processed_event_id);return {...run};},
  status:async id=>({...runs.get(id)!}),cancel:async id=>{cancels++;return {...runs.get(id)!};}};
 const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'queued-control'});
 const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});t.after(()=>runtime.close());
 const source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
 const submit=async(event_id:string)=>(await runtime.submit({schema_version:'paios.event.v1',event_id,captured_at:now,device_id:'mac',device_type:'mac',source:{channel:source.channel},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(event_id)},source,'continuity',true)).processed_event;
 const first=await submit('queued-first');await eventually(async()=>Boolean((await runtime.event(source,'continuity',first.processed_event_id)).admission.run_id));
 const queued=await submit('queued-second');assert.equal((await runtime.event(source,'continuity',queued.processed_event_id)).admission.state,'pending');
 const room=testRoom(),errors:unknown[]=[];const bridge=createFormalTextIngress({participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,runtime,authority:f.authority,max_packet_bytes:12288,onError:e=>errors.push(e)});t.after(()=>bridge.close());await bridge.onBootstrapConnected(f.input);
 room.emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify({operation:'cancel_run',control_id:'cancel-queued',processed_event_id:queued.processed_event_id})),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
 await eventually(()=>room.published.some((packet:any)=>packet.operation==='control_receipt'));
 const receipt=room.published.find((packet:any)=>packet.operation==='control_receipt') as any;
 assert.deepEqual(receipt.receipt,{status:'cancelled',run_id:null,state:'cancelled'});assert.equal(cancels,0);assert.deepEqual(errors,[]);
 runs.get('queued-control-1')!.status='completed';
 await eventually(async()=>(await runtime.event(source,'continuity',first.processed_event_id)).admission.state==='completed');
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.deepEqual(inputs,[first.processed_event_id]);assert.equal((await runtime.event(source,'continuity',queued.processed_event_id)).admission.state,'cancelled');
});
