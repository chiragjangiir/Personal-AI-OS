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
const now='2026-10-01T00:00:00.000Z', future='2026-10-01T01:00:00.000Z';
const sessionRef={ref_type:'realtime_session',ref_id:'source-session'}, leaseRef={ref_type:'device_lease',ref_id:'source-lease'};
function fixture() {
  const input={request:{request_id:'bootstrap'},bearer:{principal:{opaque_ref:'not-user-id'},deviceId:'phone-voice'},governance:{accepted:true},authority:{gateway:{identity:'controlled-source-gateway',roomName:'room'}},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',credentialRoom:'room',credentialIdentity:'terminal'},
    enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const current={session:{realtimeSessionRef:sessionRef,userId:'actual-owner',continuityId:'continuity',state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:future,activeDeviceId:'phone-voice',activeDeviceLeaseRef:leaseRef,
    binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',deviceId:'phone-voice',connectionEpoch:'1'}},
    lease:{deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'continuity',userId:'actual-owner',deviceId:'phone-voice',state:'active',
      expiresAt:future,leaseVersion:'1',fencingToken:'1'}} as unknown as RealtimeCurrentBindingProjection;
  let route='route-1',fail=false;
  const authority=new FormalSourceAuthority({ownerContext:{resolve:async({bearer})=>{
    assert.deepEqual(bearer.principal,{opaque_ref:'not-user-id'});return {userId:'actual-owner',deviceId:'phone-voice',purpose:'typed-submit',capabilities:['data'],occurredAt:now as never};}},
    readCurrentBinding:async lookup=>{assert.deepEqual(lookup,{realtimeSessionRef:sessionRef});if(fail)throw new Error('CURRENT_AUTH_UNAVAILABLE');return current;},
    sameRef:(a,b)=>canonical(a)===canonical(b),now:()=>Date.parse(now),resolveSource:async()=>({device_type:'phone',channel:'rtc_typed_text',consent_ref:'submit-consent',route_version:route,output_modes:['text','voice']})});
  return {input,current,authority,setRoute:(value:string)=>{route=value;},setFail:()=>{fail=true;}};
}
// Wait for durable asynchronous boundaries within the enclosing test's timeout.
async function eventually(predicate:()=>boolean|Promise<boolean>){const deadline=performance.now()+5000;while(performance.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('TEST_TIMEOUT');}

import { inspectWav } from '../../../services/personal-aios-integration/src/tts.ts';
import { createAppleCyclingTypedSourceResolver } from '../src/personal-aios-formal-source.ts';
function wav() {
  const bytes=Buffer.alloc(524);bytes.write('RIFF');bytes.writeUInt32LE(516,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(480,40);return bytes;
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function voiceFixture(t:test.TestContext,options:{failFirst?:boolean;blocked?:boolean;mode?:"voice"|"text_and_voice";deferSettlement?:boolean}={}) {
  const f=fixture(),root=await fs.mkdtemp(join(tmpdir(),'paios-formal-voice-source-'));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
  let creates=0,syntheses=0;const runs=new Map<string,NativeRun>(),release=deferred<void>(),written=deferred<void>(),streamClosed=deferred<void>();
  const native:NativeClient={create:async body=>{const run={run_id:'voice-native-'+(++creates),session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},status:async id=>({...runs.get(id)!}),cancel:async id=>({...runs.get(id)!})};
  const output=new OutputAuthority(storage,{tts:{synthesize:async text=>{assert.equal(text,'原回复🔬');syntheses++;await release.promise;if(options.failFirst&&syntheses===1)throw new Error('FIXTURE_TTS_FAILURE');return inspectWav(wav());}},listRunReceipts:async()=>({sources:[]})});
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'formal-voice-source'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output,sourceAuthority:f.authority,skill:'fixed',max_read_bytes:8192});
  const listeners=new Map<string,(...args:readonly unknown[])=>void>(),packets:any[]=[],streams:{options:any;bytes:Buffer[];closed:boolean}[]=[],errors:unknown[]=[];
  let disconnected=false;
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),on:(event:string,fn:(...args:readonly unknown[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),localParticipant:{
    sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{packets.push(JSON.parse(Buffer.from(bytes).toString()));},
    streamBytes:async(args:any)=>{const stream={options:args,bytes:[] as Buffer[],closed:false};streams.push(stream);return {
      write:async(bytes:Uint8Array)=>{if(options.blocked)await written.promise;if(disconnected)throw new Error('FFI_DISCONNECTED');stream.bytes.push(Buffer.from(bytes));},
      close:async()=>{stream.closed=true;streamClosed.resolve();}};}}};
  const participant={roomPort:room,disconnect:async()=>{disconnected=true;written.resolve();listeners.get(RoomEvent.Disconnected)?.();}} as unknown as LiveKitCloudParticipantPort;
  const bridge=createFormalTextIngress({participant,runtime,authority:f.authority,max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES,voice_transport:'wav_byte_stream_v1',onError:error=>errors.push(error)});
  const bridges=[bridge];
  t.after(async()=>{release.resolve();await participant.disconnect();for(const owned of bridges)await owned.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});await assert.rejects(fs.stat(root),{code:'ENOENT'});});
  await bridge.onBootstrapConnected(f.input);
  const send=(value:unknown,identity='terminal')=>listeners.get(RoomEvent.DataReceived)?.(Buffer.from(JSON.stringify(value)),{identity},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  const submit={operation:'submit',event_id:'voice-source-event',captured_at:now,text:'原用户文字'};send(submit);
  await eventually(()=>creates===1&&packets.some(x=>x.operation==='accepted'));
  const accepted=packets.find(x=>x.operation==='accepted'),source=await runtime.authenticate(f.authority.credentialForBootstrap(f.input));
  await eventually(async()=>Boolean((await runtime.event(source,'continuity',accepted.processed_event_id)).admission.run_id));
  await runtime.tool('paios_open_reply',{context:{run_id:'voice-native-1',session_id:'continuity',tool_call_id:'voice-open'},args:{reply_mode:options.mode??'text_and_voice'}});
  runs.get('voice-native-1')!.status='completed';runs.get('voice-native-1')!.output='原回复🔬';
  send({operation:'result',processed_event_id:accepted.processed_event_id});
  try { await eventually(()=>syntheses===1 && packets.some(x=>x.operation==='result_header') && (options.mode==='voice' || packets.some(x=>x.operation==='text_chunk'))); } catch(error) { t.diagnostic(JSON.stringify({packets,errors:errors.map(String),syntheses}));throw error; }
  assert.equal(streams.length,0,'text is available before TTS settles');
  const header=packets.find(x=>x.operation==='result_header'),chunks=packets.filter(x=>x.operation==='text_chunk');
  assert.equal(header.reply_mode,options.mode??'text_and_voice');assert.equal(chunks.map(x=>x.chunk.text).join(''),options.mode==='voice'?'':'原回复🔬');
  if (!options.deferSettlement) release.resolve();
  return {f,storage,runtime,source,send,submit,accepted,header,chunks,packets,streams,errors,release,written,streamClosed:streamClosed.promise,bridge,bridges,participant,counts:()=>({creates,syntheses})};
}
test('host playback capability is source-bound and independent of capture permission',async()=>{
 const f=fixture();const principal={opaque_ref:'owner'},policy={opaque_ref:'policy'};
 const t03={formalWatchPrimaryAuthority:{resolve:async()=>({userId:'actual-owner',deviceId:'phone-voice',principalRef:principal,policyDecisionRef:policy})},readCurrentAuthority:()=>({userId:'actual-owner',deviceId:'phone-voice',principal,policyDecisionRef:policy,allowedMediaCapabilities:['data'],governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'consent'}]}})};
 (f.current.lease as any).capabilities=['data'];(f.current.lease as any).policyDecisionRef=policy;
 const owner={userId:'actual-owner',deviceId:'phone-voice'} as never;
 const producer={device_id:'phone-voice',device_type:'phone' as const,channel:'rtc_typed_text'};
 const text=createAppleCyclingTypedSourceResolver({t03:t03 as never,producer});
 assert.deepEqual((await text(owner,f.current,f.input)).output_modes,['text']);
 const voice=createAppleCyclingTypedSourceResolver({t03:t03 as never,producer,playback:{device_id:'phone-voice',transport:'wav_byte_stream_v1'}});
 assert.deepEqual((await voice(owner,f.current,f.input)).output_modes,['text','voice']);
 assert.notEqual((await voice(owner,f.current,f.input)).route_version,(await text(owner,f.current,f.input)).route_version);
 assert.throws(()=>createAppleCyclingTypedSourceResolver({t03:t03 as never,producer,playback:{device_id:'forged',transport:'wav_byte_stream_v1'}}),/CAPABILITY_DENIED/);
});
test('registered speaker capability controls formal reply modes independently of voice capture and terminal class',async()=>{
 const f=fixture(),principal={opaque_ref:'owner'},policy={opaque_ref:'policy'};
 (f.current.lease as any).capabilities=['data','audio'];(f.current.lease as any).policyDecisionRef=policy;
 const owner={userId:'actual-owner',deviceId:'phone-voice'} as never;
 for(const device_type of ['mac','phone','glasses'] as const) {
  const authority={userId:'actual-owner',deviceId:'phone-voice',deviceType:device_type,principal,policyDecisionRef:policy,
   allowedMediaCapabilities:['data','audio'],capabilities:['display','microphone'],governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'consent'}]}};
  const t03={formalWatchPrimaryAuthority:{resolve:async()=>({userId:'actual-owner',deviceId:'phone-voice',principalRef:principal,policyDecisionRef:policy})},readCurrentAuthority:()=>authority};
  const producer={device_id:'phone-voice',device_type,channel:'rtc_typed_text'};
  const text=createAppleCyclingTypedSourceResolver({t03:t03 as never,producer});
  const source=await text(owner,f.current,f.input);
  assert.deepEqual(source.output_modes,['text']);assert.ok(source.capabilities?.includes('microphone'));
  const playback=createAppleCyclingTypedSourceResolver({t03:t03 as never,producer,playback:{device_id:'phone-voice',transport:'wav_byte_stream_v1'}});
  await assert.rejects(playback(owner,f.current,f.input),/SOURCE_PLAYBACK_CAPABILITY_DENIED/);
  authority.capabilities.push('speaker');
  assert.deepEqual((await playback(owner,f.current,f.input)).output_modes,['text','voice']);
 }
});
test('original OUT WAV uses directed same-room SDK stream; real played ACK suppresses confirmed replay',{timeout:10000},async t=>{
 const f=await voiceFixture(t);await f.streamClosed;const stream=f.streams[0]!;
 const envelope=JSON.parse(stream.options.attributes.out);assert.equal(envelope.operation,'voice_chunk');
 assert.equal(envelope.event_id,f.submit.event_id);assert.deepEqual(stream.options.destinationIdentities,['terminal']);
 assert.equal(stream.options.topic,'paios.central.voice.v1');assert.equal(stream.options.mimeType,'audio/wav');
 assert.equal(stream.options.totalSize,524);assert.deepEqual(Buffer.concat(stream.bytes),wav());
 assert.equal((await f.runtime.result(f.source,'continuity',f.accepted.processed_event_id)).result.delivery_status,'unknown');
 const chunk=envelope.chunk,ack={output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:1,status:'played',observed_at:now};
 f.send({operation:'ack',processed_event_id:f.accepted.processed_event_id,ack:{...ack,route_version:'forged'}});
 await eventually(()=>f.errors.length===1);assert.match(String(f.errors[0]),/BINDING_MISMATCH/);
 f.send({operation:'ack',processed_event_id:f.accepted.processed_event_id,ack});await eventually(()=>f.packets.some(x=>x.operation==='ack_receipt'&&x.receipt.status==='played'));
 const receipt=f.packets.find(x=>x.operation==='ack_receipt'&&x.receipt.status==='played');
 f.send({operation:'ack',processed_event_id:f.accepted.processed_event_id,ack});await eventually(()=>f.packets.filter(x=>x.operation==='ack_receipt').length===2);
 assert.deepEqual(f.packets.filter(x=>x.operation==='ack_receipt')[1].receipt,receipt.receipt);
 const before=f.streams.length,headers=f.packets.filter(x=>x.operation==='result_header').length;f.send({operation:'result',processed_event_id:f.accepted.processed_event_id});await eventually(()=>f.packets.filter(x=>x.operation==='result_header').length>headers);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.streams.length,before);assert.deepEqual(f.counts(),{creates:1,syntheses:1});
 const fixture={trusted_binding:{session_id:'continuity',device_id:'phone-voice',connection_epoch:'1',expected_gateway_identity:'controlled-source-gateway',max_packet_bytes:12288,voice_transport:'wav_byte_stream_v1'},submit:f.submit,accepted:f.accepted,header:f.packets.find(x=>x.operation==='result_header'&&x.voice_status==='ready')??f.header,text_chunks:f.chunks,voice:envelope,ack,ack_receipt:receipt,wav_base64:wav().toString('base64')};
 if(process.env.PAIOS_FORMAL_VOICE_FIXTURE_OUT)await fs.writeFile(process.env.PAIOS_FORMAL_VOICE_FIXTURE_OUT,JSON.stringify(fixture,null,2)+'\n');
});
test('TTS failure keeps text; formal retry reuses OUT and original native run',{timeout:10000},async t=>{
 const f=await voiceFixture(t,{failFirst:true});await eventually(()=>f.packets.some(x=>x.operation==='result_header'&&x.voice_status==='failed'));
 assert.equal(f.streams.length,0);f.send({operation:'retry_voice',control_id:'retry-original-voice',processed_event_id:f.accepted.processed_event_id});
 await f.streamClosed;assert.deepEqual(f.counts(),{creates:1,syntheses:2});
 assert.ok(f.packets.some(x=>x.operation==='control_receipt'&&x.requested_operation==='retry_voice'&&x.receipt.voice_status==='ready'));
});
test('blocked SDK writer does not block playback cancel; owner disconnect releases writer before ingress joins',async t=>{
 const f=await voiceFixture(t,{blocked:true});await eventually(()=>f.streams.length===1);
 f.send({operation:'cancel_playback',control_id:'stop-voice',processed_event_id:f.accepted.processed_event_id,reply_epoch:f.header.reply_epoch});
 await eventually(()=>f.packets.some(x=>x.operation==='control_receipt'&&x.requested_operation==='cancel_playback'));
 assert.equal(f.streams[0]!.closed,false,'cancel receipt does not wait for admitted transfer');
 await assert.rejects(f.runtime.audio(f.source,'continuity',f.accepted.processed_event_id,JSON.parse(f.streams[0]!.options.attributes.out).chunk.audio.ref),/ACCESS_DENIED/);
 const closing=f.bridge.close();let joined=false;void closing.then(()=>{joined=true;});await Promise.resolve();assert.equal(joined,false);
 await f.participant.disconnect();await closing;assert.equal(joined,true);assert.equal(f.streams[0]!.closed,true);assert.deepEqual(f.counts(),{creates:1,syntheses:1});
});

test('voice-only authorized OUT sends original WAV without a caption or a second native run',{timeout:10000},async t=>{
 const f=await voiceFixture(t,{mode:'voice'});await f.streamClosed;
 assert.equal(f.packets.filter(x=>x.operation==='text_chunk').length,0);
 assert.equal(f.header.text_chunk_count,0);assert.equal(f.header.voice_transport,'wav_byte_stream_v1');
 assert.deepEqual(Buffer.concat(f.streams[0]!.bytes),wav());assert.deepEqual(f.counts(),{creates:1,syntheses:1});
});

import { readFileSync } from 'node:fs';
import { createRealtimeSchemaRegistry } from '../src/realtime-public-control-controller.ts';
function originalBootstrap() {
  return JSON.parse(readFileSync(new URL('../../../tests/contracts/fixtures/realtime-public-control/bootstrap-response.valid.json', import.meta.url), 'utf8'));
}
test('original bootstrap registry rejects a voice transport in media grants', () => {
  const registry = createRealtimeSchemaRegistry();
  const value = originalBootstrap();
  assert.equal(registry.validateResponse('bootstrap', value), true);
  value.media_grants.voice_transport = 'wav_byte_stream_v1';
  assert.equal(registry.validateResponse('bootstrap', value), false);
});
test('single canonical central descriptor permits its voice transport and original backend identity limits', () => {
  const registry = createRealtimeSchemaRegistry();
  const value = originalBootstrap();
  value.central_text_transport = {schema:'paios.central.text-transport.v1', execution_owner:'hermes_text',
    expected_gateway_identity:'g'.repeat(1024), input_topic:'paios.central.text.v1',
    output_topic:'paios.central.sealed-text.v1', max_packet_bytes:12288, voice_transport:'wav_byte_stream_v1'};
  assert.equal(registry.validateResponse('bootstrap', value), true);
  value.central_text_transport.expected_gateway_identity = '';
  assert.equal(registry.validateResponse('bootstrap', value), false);
  value.central_text_transport.expected_gateway_identity = 'g'.repeat(1025);
  assert.equal(registry.validateResponse('bootstrap', value), false);
});

test('same-room original subscription naturally delivers a retired D TTS terminal after a new submit', async t => {
  const f = await voiceFixture(t, {deferSettlement:true});
  f.send({...f.submit, event_id:'new-explicit-source', text:'new explicit text'});
  await eventually(() => f.packets.some(x => x.operation === 'accepted' && x.event_id === 'new-explicit-source'));
  const index = f.packets.length;
  f.release.resolve();
  await eventually(() => f.packets.slice(index).some(x => x.operation === 'result_header' &&
    x.processed_event_id === f.accepted.processed_event_id && x.voice_status === 'ready'));
  assert.equal(f.counts().syntheses, 1);
});
test('after detach original old-D result query restores source terminal without creating a run or forging played', async t => {
  const f = await voiceFixture(t, {deferSettlement:true});
  const text = f.chunks[0].chunk;
  f.send({operation:'ack', processed_event_id:f.accepted.processed_event_id, ack:{
    output_id:text.output_id, reply_id:text.reply_id, reply_epoch:text.reply_epoch, target_device_id:text.target_device_id,
    route_version:text.route_version, highest_contiguous_seq:text.seq, status:'rendered', observed_at:now}});
  await eventually(() => f.packets.some(x => x.operation === 'ack_receipt'));
  await f.bridge.close();
  const bridge = createFormalTextIngress({participant:f.participant, runtime:f.runtime, authority:f.f.authority,
    max_packet_bytes:REALTIME_ASSISTANT_MAX_PACKET_BYTES, voice_transport:'wav_byte_stream_v1', onError:error=>f.errors.push(error)});
  f.bridges.push(bridge);
  await bridge.onBootstrapConnected(f.f.input);
  const index = f.packets.length;
  f.release.resolve();
  await eventually(async () => (await f.runtime.result(f.source, 'continuity', f.accepted.processed_event_id)).result.voice_status === 'ready');
  assert.equal(f.packets.slice(index).some(x => x.operation === 'result_header'), false, 'detached subscription was not silently restored');
  f.send({operation:'result', processed_event_id:f.accepted.processed_event_id});
  await eventually(() => f.packets.slice(index).some(x => x.operation === 'result_header' && x.voice_status === 'ready'));
  const header = f.packets.slice(index).find(x => x.operation === 'result_header');
  assert.equal(header.processed_event_id, f.accepted.processed_event_id);
  assert.notEqual(header.delivery_status, 'played');
  assert.equal(header.pending_text_chunk_count, 0);
  assert.deepEqual(f.counts(), {creates:1, syntheses:1});
  const before = f.packets.length;
  f.f.setFail();
  f.send({operation:'result', processed_event_id:f.accepted.processed_event_id});
  await eventually(() => f.errors.some(error=>/CURRENT_AUTH_UNAVAILABLE/.test(String(error))));
  assert.equal(f.packets.slice(before).length,0,'an invalid credential cannot receive even a rejection packet');
  assert.equal(f.packets.slice(before).some(x => x.operation === 'result_header'), false);
  assert.deepEqual(f.counts(), {creates:1, syntheses:1});
});
