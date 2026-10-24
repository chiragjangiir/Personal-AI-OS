import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {fileURLToPath} from 'node:url';
import { PersonalAIOSRuntime } from './native-source-fixture.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { OutputTargetAuthority } from '../src/routing.ts';
import { ContractError, sha256, digest, principalAttribution, ownerActionGrant, type RawEvent, type TrustedContext, type TimeRange, type ProcessedEvent } from '../src/contracts.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { StreamArchive, type TrackChunk } from '../src/stream-archive.ts';
import { MediaProcessor, type Capability, type WorkerPort, type WorkerRequest, type VoiceIdentityAnalysis } from '../src/media/processing.ts';
import { MediaService, type MediaServiceConfig, type MediaVadPort } from '../src/media/service.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {OwnerOverride,createOwnerOverrideSecret} from '../src/owner-override.ts';
import {SherpaAudioWorker,sherpaAudioCapability} from '../src/media/sherpa-audio-worker.ts';
import {controlledDetector,controlledEngine} from './speech-fixture.ts';
import {runScope,voiceEvidence} from '../src/contracts.ts';
import type { ClockMap } from '../src/media/align.ts';
const trusted: TrustedContext = {principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',
  channel:'fixture',submission:'observation'};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
const pcm = Buffer.alloc(3200); for (let n=0;n<1600;n++) pcm.writeInt16LE(Math.round(Math.sin(n/10)*12000),n*2);
const raw = (visual=false):RawEvent => ({schema_version:'paios.event.v1',event_id:'stream',device_id:'glasses',
  device_type:'glasses',captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'fixture'},media_type:'livekit_tracks',
  mime:visual?'image/png':'audio/pcm',representation:'received_decoded_sample',payload:visual?png:pcm});
const chunk = (seq=0,visual=false):TrackChunk => ({track_id:visual?'camera':'mic',stream_epoch:'epoch',seq,
  modality:visual?'visual':'audio',format:visual?'png':'pcm_s16le:16000:1',source_range:visual?
    {kind:'instant',timebase_id:'capture',stream_epoch:'epoch',at_ms:seq*100+50}:
    {kind:'interval',timebase_id:'capture',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}});
const maps:ClockMap[] = ['audio','visual'].map(modality=>({modality:modality as 'audio'|'visual',
  track_id:modality==='audio'?'mic':'camera',stream_epoch:'epoch',source_timebase_id:'capture',target_timebase_id:'fixture-common',
  offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'clock:fixture-unverified'}));
const window:TimeRange={kind:'interval',timebase_id:'fixture-common',start_ms:0,end_ms:100};
const cap:Capability={id:'controlled',version:'fixture',modalities:['audio','visual'],formats:['pcm_s16le:16000:1','png'],
  joint_av:true,healthy:true,permitted:true,max_duration_ms:200,evidence:'deterministic_replay',execution:'local'};
const defaultWorker:WorkerPort={analyze:async request=>({event_id:request.event_id,segment_id:request.segment_id,
  archive_revision:request.archive_revision,time_range:request.time_range,content:{audio_observations:['fixture byte analysis'],
    visual_observations:['fixture frame analysis']},speakers:[],warnings:['CONTROLLED_WORKER_NOT_REAL_MODEL'],status:'partial'})};
const vad:MediaVadPort={candidates:async(request)=>{assert.ok(request.views.every(v=>v.modality==='audio'));
  assert.ok(Buffer.from(request.views[0]!.bytes).equals(pcm));return [{start_ms:0,end_ms:100,semantic_status:'open',basis:'controlled'}];}};
async function mediaFixture(t:test.TestContext, worker=defaultWorker, override:Partial<MediaServiceConfig>={},large=false) {
  const scratch=new URL('../../../../../.scratch/tm1/round2/',import.meta.url);await mkdir(scratch,{recursive:true});
  const directory=await mkdtemp(fileURLToPath(new URL('paios-media-service-',scratch)));t.after(async()=>{await fixtureRuntimeClose();await rm(directory,{recursive:true,force:true});});
  let fixtureRuntimeClose=async()=>{};
  const storage=new PosixStorage(directory);
  const budget={max_chunk_bytes:large?100000:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20};
  const archive=new RawArchive(storage,large?100000:10000,undefined,budget);
  const streamArchive=new StreamArchive(storage,budget);
  const processor=new MediaProcessor(storage,new Map([['controlled',worker]]),{policy_version:'service-fixture',max_inflight:2,
    max_input_bytes:100000,timeout_ms:500,allow_external:false,allow_replay:true,allow_partial:true});
  const config:MediaServiceConfig={storage,archive,streamArchive,processor,capabilities:async()=>[cap],vad,
    align:{max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:200,
    fixtureOnly:true,...override};
  t.after(()=>processor.close());
  return {setCleanup:(close:()=>Promise<void>)=>{fixtureRuntimeClose=close;},storage,archive,processor,service:new MediaService(config),config};
}

import {EventEmitter} from 'node:events';
import type {VoiceResources,VoiceRecord,VoiceDecision} from '../src/voice/contracts.ts';
import {createQwenVoiceResources} from '../src/voice/qwen-resources.mjs';
import {createFormalVoiceAuthority} from '../src/voice/formal-authority.ts';
class Socket extends EventEmitter{
 static OPEN=1;static sockets:Socket[]=[];readyState=1;bufferedAmount=0;sent:Record<string,any>[]=[];acknowledgeUpdates=true;url:string;
 constructor(url:string,options:unknown){super();this.url=url;Socket.sockets.push(this);queueMicrotask(()=>{this.emit('open');this.incoming({type:'session.created'});});}
 incoming(event:unknown){this.emit('message',Buffer.from(JSON.stringify(event)));}
 send(wire:string){const event=JSON.parse(wire);this.sent.push(event);if(event.type==='session.update'&&this.acknowledgeUpdates)queueMicrotask(()=>this.incoming({type:'session.updated'}));}
 close(){this.readyState=3;queueMicrotask(()=>this.emit('close'));}terminate(){this.close();}
}
async function until(run:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await run())return;await new Promise(r=>setTimeout(r,5));}assert.fail('did not settle');}
async function voiceFixture(t:test.TestContext,configured=true,formal=false,macPtt=false,ptt?:{device_type:'phone'|'mac';audio:Buffer;identity:VoiceIdentityAnalysis},override=false){
 const f=await mediaFixture(t,defaultWorker,ptt?{voiceIdentity:ptt.identity,max_window_ms:4000}:{},!!ptt);f.processor.config.timeout_ms=3000;
 const socketStart=Socket.sockets.length;let nativeBody:unknown;let creates=0,opens=0;let state:VoiceDecision['state']='unknown',badEpoch=false,denied=false;const errors:unknown[]=[];
 const resources=createQwenVoiceResources({configuration:{usable:configured,WebSocket:Socket,
  provider:'dashscope',model:'alternate-ptt',dialect:'nested-audio',transcription_model:'alternate-ptt-asr',region:'cn-beijing',endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  voice:'Tina',apiKey:'synthetic-offline-only',instructions:'只产候选。'},
  authorizeWindow:async()=>{if(denied)throw new Error('VOICE_WINDOW_PERMISSION_MISSING');return {window_ref:'window:host',turn_id:'turn:host',purpose_evidence_ref:'permission:controlled'};},
  authorizeFinal:async(_source,record,evidence)=>({state,semantic_status:'explicit_end',candidate_ref:record.candidate_ref,window_ref:record.window_ref,
   turn_id:record.turn_id,identity:{connectionId:record.candidate.connectionId,connectionEpoch:record.candidate.connectionEpoch+(badEpoch?1:0)},
   source_digest:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript)),request_evidence_ref:evidence}),
  ...(formal?createFormalVoiceAuthority(f.storage):{}),
  onError:error=>errors.push(error)});
 const voice:VoiceResources={...resources,create:callbacks=>{opens++;return resources.create(callbacks);}};
 let nativePending=macPtt,ttsCalls=0;
 const native={create:async(body:any,key:string)=>{nativeBody=structuredClone(body);creates++;return {run_id:`run-${key}`,session_id:body.session_id,conversation_session_id:body.session_id,status:nativePending?'running':'completed'};},
  status:async(id:string)=>({run_id:id,session_id:'session',conversation_session_id:'session',status:nativePending?'running':'completed',...(macPtt&&!nativePending?{output:'Mac 文字回复。'}:{})}),cancel:async(id:string)=>({run_id:id,session_id:'session',conversation_session_id:'session',status:'cancelled' as const})};
 const admission=new RunAdmission(f.storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'controlled'});
 const source=ptt?{...trusted,device_id:ptt.device_type,device_type:ptt.device_type}:macPtt?{...trusted,device_id:'mac',device_type:'mac' as const}:trusted;
 const ownerOverride=new OwnerOverride({storage:f.storage,secret_root:f.storage.root,ttl_s:0});t.after(()=>ownerOverride.close());
 if(override){await writeFile(join(f.storage.root,'owner-override.json'),JSON.stringify(await createOwnerOverrideSecret('fixture override')),{mode:0o600});await ownerOverride.enable(source.device_id,'fixture override');}
 const runtime=new PersonalAIOSRuntime({storage:f.storage,archive:f.archive,admission,native,output:new OutputAuthority(f.storage,macPtt?{tts:{synthesize:async()=>{ttsCalls++;throw new Error('MAC_PTT_MUST_NOT_SYNTHESIZE');}}}:{}),media:f.service,voice,
  owner_override:ownerOverride,
  devices:[{...source,...(macPtt?{capabilities:['display','microphone','chat_ui','desktop_tools',...(ptt?['owner_unlock' as const]:[])] as const}:{}),route_version:'route',output_modes:['text'],token_sha256:sha256('token')},...(ptt?.device_type==='mac'?[{...trusted,device_id:'phone',device_type:'phone' as const,route_version:'phone-route',output_modes:['text' as const],token_sha256:sha256('phone-token')}]:[])],skill:'controlled',max_read_bytes:100000,
  audio_route:async()=>({consumer:'voice',source_scope:'authenticated-continuity',capture_span:'button-span',purpose_evidence_ref:'capture:controlled'})});
 f.setCleanup(()=>runtime.close());const device=await runtime.authenticate('token');
 const audio=ptt?.audio??pcm,range={...window,end_ms:audio.length/32};
 const append=()=>runtime.appendMedia({...raw(),device_id:source.device_id,device_type:source.device_type,payload:audio},device,{...chunk(),source_range:{...chunk().source_range,end_ms:audio.length/32} as TimeRange});
 const process=(event:{raw_ref:string;archive_revision:string},op='voice-op')=>runtime.processVoice(device,'session',op,{...event,time_range:range,clock_maps:[maps[0]!]});
 
 const records=async()=>Promise.all((await f.storage.list('voice-transcripts')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('voice-transcripts',key)).toString()) as VoiceRecord));
 const final=async()=>{await until(()=>Socket.sockets.length>socketStart&&Socket.sockets[socketStart]!.sent.some(e=>e.type==='input_audio_buffer.append')===true);const socket=Socket.sockets.at(-1)!;
  assert.ok(Buffer.from(socket.sent.find(e=>e.type==='input_audio_buffer.append')!.audio,'base64').equals(audio));
  socket.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'item:1',transcript:'不要开灯。只查询状态。'});
  for(let i=0;i<100&&(await records()).length===0;i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,10));return (await records()).find(r=>r.candidate.kind==='transcript')!;};
 return {...f,runtime,device,append,process,records,final,errors,nativeBody:()=>nativeBody,socket:()=>Socket.sockets[socketStart],opens:()=>opens,creates:()=>creates,ttsCalls:()=>ttsCalls,finishNative:()=>{nativePending=false;},state:(value:typeof state)=>{state=value;},badEpoch:()=>{badEpoch=true;},deny:()=>{denied=true;}};
}
test('actual L5 PCM→pure Qwen module→persistent final candidate→original D→original Admission/native once',async t=>{
 const f=await voiceFixture(t);const a=await f.append();assert.equal(a.processing_admission?.status,'awaiting_window');assert.equal(f.opens(),0);
 const work=f.process(a.event);const record=await f.final();
 assert.match(record.archive_revision,/^[a-f0-9]{64}$/);assert.equal(record.candidate.connectionEpoch,1);assert.equal(record.authorization,'unknown');assert.equal(record.candidate.model,'alternate-ptt');
 assert.equal(new URL(f.socket()!.url).searchParams.get('model'),'alternate-ptt');
 assert.deepEqual(f.socket()!.sent.find(e=>e.type==='session.update')!.session.input_audio_transcription,{model:'alternate-ptt-asr'});
 assert.deepEqual(await f.runtime.voiceCandidate(f.device,record.candidate_ref),record);assert.equal(f.creates(),0);
 f.state('confirmed_request');await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:adopt-exact-text');
 const result=await work;const d=result.processed_events[0]!;assert.equal(d.origin,'device_observation');assert.equal(d.user_identity,'unknown');
 assert.equal(runScope(d),'owner_uncertain','directed PTT with no registry stays restricted');assert.deepEqual(d.speakers,[]);
 assert.equal((d.processing.models[0] as {id:string}).id,'alternate-ptt');assert.equal(d.intent_class,'explicit_request');assert.equal(d.continuation_hint,'explicit_end');assert.equal(await f.archive.validateEvidence(d),true);
 await until(()=>f.creates()===1);const replay=await f.process(a.event,'retry');assert.deepEqual(replay.processed_events,result.processed_events);
 assert.equal(f.opens(),1);assert.equal(f.creates(),1);assert.equal(Socket.sockets.at(-1)!.readyState,3);
 const nativeBody=f.nativeBody() as {input:string};const {voice_confirmation,...nativeD}=JSON.parse(nativeBody.input);assert.deepEqual(nativeD,d);
 assert.equal(voice_confirmation,null);
 if(process.env.VOICE_PROOF_FILE)await writeFile(process.env.VOICE_PROOF_FILE,JSON.stringify({scope:'controlled_not_real_cloud',
   archive:a.event,selected_pcm_sha256:sha256(pcm),candidate:record,d,admission:result.events,native_request:nativeBody,
   native_create_count:f.creates(),frontend_open_count:f.opens(),replay_same_d:true},null,2));
});
test('unknown and other speaker final remain candidate only; cancel/retry cannot create a second consumption',async t=>{
 for(const state of ['unknown','other'] as const){const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();f.state(state);
  assert.equal((await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:none')).status,'not_finalized');
  await f.runtime.cancelMedia(f.device,'voice-op');assert.match(String(await work),/ACCEPTANCE_UNKNOWN/);await assert.rejects(f.process(a.event,'retry'),/ACCEPTANCE_UNKNOWN/);
  assert.equal(f.creates(),0);assert.equal(f.opens(),1);assert.deepEqual(await f.storage.list('processed-events'),[]);}
});
test('partial cannot finalize; close joins actual frontend and blocks late socket event',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);await until(()=>f.socket()?.sent.some(e=>e.type==='input_audio_buffer.append')===true);
 const socket=f.socket()!;socket.incoming({type:'conversation.item.input_audio_transcription.delta',item_id:'item:1',delta:'打开'});
 for(let i=0;i<100&&(await f.records()).length===0;i++)await new Promise(r=>setTimeout(r,5));
 await new Promise(r=>setTimeout(r,10));const record=(await f.records())[0]!;assert.equal(record.candidate.kind,'partial');
 assert.equal(record.candidate.region,'unknown');
 await assert.rejects(f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:partial'),/FINAL_TRANSCRIPT_REQUIRED/);
 await f.runtime.close();assert.match(String(await work),/ACCEPTANCE_UNKNOWN/);socket.incoming({type:'conversation.item.input_audio_transcription.completed',transcript:'late'});
 assert.equal((await f.records()).length,1);assert.equal(f.creates(),0);assert.equal(socket.readyState,3);
});

test('current actual epoch mismatch rejects host confirmation; source permission/config missing opens no frontend',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();f.state('confirmed_request');f.badEpoch();
 await assert.rejects(f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:epoch'),/EVIDENCE_MISMATCH/);
 await f.runtime.cancelMedia(f.device,'voice-op');await work;assert.equal(f.creates(),0);
 for(const configured of [false,true]){const g=await voiceFixture(t,configured);g.deny();const b=await g.append();assert.equal(b.event.archive_status,'durable');
 await assert.rejects(g.process(b.event),configured?/PERMISSION_MISSING/:/NOT_CONFIGURED/);assert.equal(g.opens(),0);assert.equal(g.creates(),0);}
});
test('candidate publication EIO pins accepted unknown; no D, native run, or automatic provider retry',async t=>{
 const f=await voiceFixture(t);const a=await f.append(),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='voice-transcripts')throw Object.assign(new Error('VOICE_TRANSCRIPT_EIO'),{code:'EIO'});return publish(namespace,key,bytes);};
 const work=f.process(a.event).catch(e=>e);await until(()=>f.socket()?.sent.some(e=>e.type==='input_audio_buffer.append')===true);
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'item:1',transcript:'查询'});
 assert.match(String(await work),/ACCEPTANCE_UNKNOWN/);f.storage.publish=publish;
 await assert.rejects(f.process(a.event,'retry'),/ACCEPTANCE_UNKNOWN/);assert.equal(f.opens(),1);assert.equal(f.creates(),0);assert.deepEqual(await f.storage.list('processed-media'),[]);
});
test('transport closure leaves final unknown until bounded window exits; no cloud cancel ACK or auto reopen',async t=>{
 const f=await voiceFixture(t);f.processor.config.timeout_ms=100;const a=await f.append();const work=f.process(a.event).catch(e=>e);
 await until(()=>f.socket()?.sent.some(e=>e.type==='input_audio_buffer.append')===true);f.socket()!.close();
 assert.match(String(await work),/ACCEPTANCE_UNKNOWN/);await assert.rejects(f.process(a.event,'retry'),/ACCEPTANCE_UNKNOWN/);
 assert.equal(f.opens(),1);assert.equal(f.creates(),0);assert.deepEqual(await f.storage.list('processed-events'),[]);
});

test('peer counterexample: in-flight conflicting transcript does not block final D',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();
 const publish=f.storage.publish.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 f.storage.publish=async(namespace,key,bytes)=>{
  if(namespace==='voice-transcripts'&&JSON.parse(Buffer.from(bytes).toString()).candidate.event.item_id==='item:2'){
   entered.resolve();await release.promise;
  }
  return publish(namespace,key,bytes);
 };
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'item:2',transcript:'打开灯。'});
 await entered.promise;f.state('confirmed_request');
 try{
  const finalize=f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:exact-first');
  let completed=false;void finalize.then(()=>completed=true,()=>completed=true);
  await new Promise(r=>setImmediate(r));assert.equal(completed,false);release.resolve();
  await assert.rejects(finalize,/VOICE_MULTI_ITEM_RANGE_UNKNOWN/);
  await f.runtime.cancelMedia(f.device,'voice-op');await work;
  assert.equal((await f.records()).length,2);assert.equal(f.creates(),0);assert.deepEqual(await f.storage.list('processed-media'),[]);
 }finally{release.resolve();f.storage.publish=publish;}
});

test('peer counterexample: cancel during finalized input publication still writes D and replay admits it',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();
 const publish=f.storage.publish.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 f.storage.publish=async(namespace,key,bytes)=>{
  if(namespace==='processed-media-inputs'){entered.resolve();await release.promise;}
  return publish(namespace,key,bytes);
 };
 f.state('confirmed_request');
 try{
  assert.equal((await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:exact')).status,'finalized');
  await entered.promise;await f.runtime.cancelMedia(f.device,'voice-op');release.resolve();
  assert.match(String(await work),/MEDIA_CANCELLED|ACCEPTANCE_UNKNOWN/);
  assert.equal((await f.storage.list('processed-media')).length,0);assert.equal(f.creates(),0);
  assert.deepEqual(await f.storage.list('audio-consumer-results'),[]);
  f.storage.publish=publish;await assert.rejects(f.process(a.event,'replay-after-cancel'),/ACCEPTANCE_UNKNOWN/);assert.equal(f.creates(),0);assert.equal(f.opens(),1);
 }finally{release.resolve();f.storage.publish=publish;}
});
test('pending conflicting publication failure rejects finalization and leaves accepted range unknown',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();
 const publish=f.storage.publish.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 f.storage.publish=async(namespace,key,bytes)=>{
  if(namespace==='voice-transcripts'&&JSON.parse(Buffer.from(bytes).toString()).candidate.event.item_id==='item:2'){
   entered.resolve();await release.promise;throw new Error('PENDING_CANDIDATE_EIO');
  }
  return publish(namespace,key,bytes);
 };
 try{
  f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'item:2',transcript:'打开灯'});
  await entered.promise;f.state('confirmed_request');const final=f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:first');
  const rejected=assert.rejects(final,/PENDING_CANDIDATE_EIO/);release.resolve();await rejected;await work;
  assert.deepEqual(await f.storage.list('processed-media'),[]);assert.equal(f.creates(),0);
  f.storage.publish=publish;await assert.rejects(f.process(a.event,'retry-failed-candidate'),/ACCEPTANCE_UNKNOWN/);
 }finally{release.resolve();f.storage.publish=publish;}
});
test('candidate arriving during host authorization invalidates its observed source snapshot',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();
 const resources=(f.service as unknown as {voice:VoiceResources}).voice;
 const authorize=resources.authorizeFinal,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 resources.authorizeFinal=async(...args)=>{entered.resolve();await release.promise;return authorize(...args);};f.state('confirmed_request');
 const final=f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:snapshot');
 const rejected=assert.rejects(final,/EVIDENCE_MISMATCH/);await entered.promise;
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.delta',item_id:'item:1',delta:'再补一句'});
 release.resolve();await rejected;await f.runtime.cancelMedia(f.device,'voice-op');await work;
 assert.deepEqual(await f.storage.list('processed-media'),[]);assert.equal(f.creates(),0);
});
test('cancel after D publication began cannot finalize consumer or replay into native admission',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();
 const publish=f.storage.publish.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 f.storage.publish=async(namespace,key,bytes)=>{const saved=await publish(namespace,key,bytes);
  if(namespace==='processed-media'){entered.resolve();await release.promise;}return saved;};
 f.state('confirmed_request');
 try{
  await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:exact');await entered.promise;
  await f.runtime.cancelMedia(f.device,'voice-op');release.resolve();await work;
  const dKeys=await f.storage.list('processed-media');assert.equal(dKeys.length,1);assert.deepEqual(await f.storage.list('audio-consumer-results'),[]);
  const orphan=JSON.parse(Buffer.from(await f.storage.read('processed-media',dKeys[0]!)).toString());
  const admissionOwner=f.runtime as unknown as {admitProcessed(d:ProcessedEvent,device:typeof f.device,session:string):Promise<unknown>};
  await assert.rejects(admissionOwner.admitProcessed(orphan,f.device,'session'),/AUDIO_D_CONSUMPTION_REQUIRED/);
  f.storage.publish=publish;await assert.rejects(f.process(a.event,'retry-orphan-d'),/ACCEPTANCE_UNKNOWN/);assert.equal(f.creates(),0);assert.equal(f.opens(),1);
 }finally{release.resolve();f.storage.publish=publish;}
});
test('close during finalized input publication joins write and blocks D and consumer outcome',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event).catch(e=>e);const record=await f.final();
 const publish=f.storage.publish.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='processed-media-inputs'){entered.resolve();await release.promise;}return publish(namespace,key,bytes);};
 f.state('confirmed_request');
 try{
  await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:close');await entered.promise;
  let closed=false;const closing=f.runtime.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);
  release.resolve();await closing;await work;assert.deepEqual(await f.storage.list('processed-media'),[]);
  assert.deepEqual(await f.storage.list('audio-consumer-results'),[]);assert.equal(f.creates(),0);
 }finally{release.resolve();f.storage.publish=publish;}
});


const {createEmbeddedRealtimeSession,createFrontRealtimeSession}=await import(new URL('../../qwen-embedded/server/src/voice/embedded-realtime-session.mjs',import.meta.url).href);
const {RealtimeFrontend}=await import(new URL('../../qwen-embedded/server/src/voice/realtime-frontend-core.mjs',import.meta.url).href);
const {createDashscopeProvider}=await import(new URL('../../qwen-embedded/server/src/voice/providers/dashscope-core.mjs',import.meta.url).href);
function manualFrontend(){return createEmbeddedRealtimeSession({provider:'dashscope',model:'alternate-ptt',dialect:'nested-audio',transcription_model:'alternate-ptt-asr',region:'cn-beijing',endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'Tina',apiKey:'synthetic-offline-only',WebSocket:Socket,instructions:'only candidate',onCandidate:()=>{}});}
function originalTransport(options={}){const provider=createDashscopeProvider({config:{audioModel:'qwen3.8-omni-flash-realtime',audioDialect:'nested-audio',audioVoice:'Tina',audioRealtimeBaseUrl:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',dashscopeApiKey:'synthetic-offline-only'},realtimeUrl:(url:string)=>url,buildFrontendInstructions:()=>'',frontendTools:()=>[],resultResponseInstructions:'',speakResponseInstructions:()=>'',permissionResponseInstructions:''});return new RealtimeFrontend({...options,provider,WebSocket:Socket});}
test('automatic response progress extends the watchdog; stalls recover later context and replies',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 for(const [created,acknowledge] of [[true,true],[false,true],[true,false]]){
  const core=originalTransport({responseInactivityTimeoutMs:40});await core.connect();let socket=Socket.sockets.at(-1)!;
  try{
   socket.incoming(created?{type:'response.created',response:{id:'automatic'}}:{type:'response.audio.delta',response_id:'automatic',delta:'AA=='});
   if(created&&acknowledge){socket.incoming({type:'error',error:{message:'Another response is in progress'}});
    socket.incoming({type:'error',response_id:'unrelated',error:{message:'content safety failure'}});}
   for(let i=0;i<3;i++){t.mock.timers.tick(25);socket.incoming({type:'response.audio.delta',response_id:'automatic',delta:'AA=='});}
   assert.equal(socket.sent.some(e=>e.type==='response.cancel'),false,'continued progress can outlive the inactivity limit');
   const context=core.injectDelivery('later context','agent',{}, {route:'context'});await new Promise(r=>setImmediate(r));
   assert.equal(socket.sent.some(e=>e.type==='conversation.item.create'),false);
   t.mock.timers.tick(40);assert.equal(socket.sent.filter(e=>e.type==='response.cancel').length,1);
   if(acknowledge)socket.incoming(created?{type:'response.done',response:{id:'automatic',status:'cancelled'}}:{type:'error',error:{message:'No active response'}});
   else{t.mock.timers.tick(1000);await context;await core.join();assert.equal(socket.readyState,3);await core.connect();socket=Socket.sockets.at(-1)!;}
   const delivery=acknowledge?context:core.injectDelivery('later context','agent',{}, {route:'context'});
   await new Promise(r=>setImmediate(r));const item=socket.sent.find(e=>e.type==='conversation.item.create')!.item;
   assert.equal(item.content[0].text,'later context');socket.incoming({type:'conversation.item.created',item});await delivery;
   const reply=core.speak('later reply');await new Promise(r=>setImmediate(r));assert.ok(socket.sent.some(e=>e.type==='response.create'));
   socket.incoming({type:'response.created',response:{id:'manual'}});
   for(let i=0;i<3;i++){t.mock.timers.tick(25);socket.incoming({type:'response.text.delta',response_id:'manual',delta:'reply'});}
   socket.incoming({type:'response.done',response:{id:'manual',status:'completed'}});
   assert.equal((await reply).completed,true);const cancels=socket.sent.filter(e=>e.type==='response.cancel').length;
   t.mock.timers.tick(80);assert.equal(socket.sent.filter(e=>e.type==='response.cancel').length,cancels,'terminal responses leave no watchdog');
  }finally{core.close();await core.join();}
 }
});
test('a refused manual create leaves the misassociated automatic response under the watchdog',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const core=originalTransport({responseInactivityTimeoutMs:40});await core.connect();
 try{
  const socket=Socket.sockets.at(-1)!,reply=core.speak('manual reply');await new Promise(r=>setImmediate(r));
  socket.incoming({type:'response.created',response:{id:'automatic'}});
  socket.incoming({type:'error',error:{message:'Another response is in progress'}});
  t.mock.timers.tick(40);assert.equal(socket.sent.filter(e=>e.type==='response.cancel').length,1);
  socket.incoming({type:'response.done',response:{id:'automatic',status:'cancelled'}});await new Promise(r=>setImmediate(r));
  assert.equal(socket.sent.filter(e=>e.type==='response.create').length,2,'manual reply retries only after automatic recovery');
  socket.incoming({type:'response.created',response:{id:'retry'}});socket.incoming({type:'response.done',response:{id:'retry',status:'completed'}});
  assert.equal((await reply).completed,true);
 }finally{core.close();await core.join();}
});
test('managed call keeps provider ASR, commits exact audio and creates only an explicitly requested reply',async t=>{
 const events:Record<string,unknown>[]=[],front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  manualTurns:true,instructions:'call',session_options:{enable_search:true},onEvent:(event:Record<string,unknown>)=>events.push(event)});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!;
 await front.setInstructions('same call scope');
 for(const event of socket.sent.filter(e=>e.type==='session.update')){assert.equal(event.session.turn_detection,null);assert.deepEqual(event.session.tools,[]);assert.equal(event.session.enable_search,true);assert.deepEqual(event.session.input_audio_transcription,{model:'qwen3-asr-flash-realtime'});}
 front.appendAudio(pcm.toString('base64'));front.commitInput();
 assert.deepEqual(socket.sent.filter(e=>e.type.startsWith('input_audio_buffer.')).map(e=>e.type),['input_audio_buffer.append','input_audio_buffer.commit']);
 assert.equal(socket.sent.some(e=>e.type==='response.create'),false);
 socket.incoming({type:'input_audio_buffer.committed',item_id:'owner'});
 const committed=events.find(e=>e.type==='input_audio_buffer.committed')!;
 assert.deepEqual([committed.__voiceInputStart,committed.__voiceInputEnd],[0,pcm.length/2]);
 socket.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'owner',transcript:'云端最终识别'});
 assert.equal(events.find(e=>e.type==='conversation.item.input_audio_transcription.completed')?.transcript,'云端最终识别');
 const stale=await front.requestReply(()=>false);assert.equal(stale.skipped,true);assert.equal(socket.sent.some(e=>e.type==='response.create'),false);
 const reply=front.requestReply();await until(()=>socket.sent.some(e=>e.type==='response.create'));
 socket.incoming({type:'response.created',response:{id:'answer'}});socket.incoming({type:'response.done',response:{id:'answer',status:'completed'}});
 assert.equal((await reply).completed,true);
});
test('call front defers output pressure until handshake is ready and resumes the same socket',async t=>{
 class PressureSocket extends Socket {
  paused=false;
  pause(){this.paused=true;}
  resume(){this.paused=false;}
  override incoming(event:unknown){
   if(['session.created','session.updated'].includes((event as {type:string}).type))assert.equal(this.paused,false,'pressure must not block handshake acknowledgements');
   super.incoming(event);
  }
 }
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:PressureSocket,
  instructions:'call',onEvent:()=>{}});
 t.after(async()=>{front.close();await front.join();});front.setOutputPaused(true);await front.connect();
 const socket=Socket.sockets.at(-1)! as PressureSocket;
 assert.equal(front.ready(),true);assert.equal(socket.paused,true);
 front.setOutputPaused(false);assert.equal(socket.paused,false);assert.equal(Socket.sockets.at(-1),socket);
 front.setOutputPaused(true);assert.equal(socket.paused,true);
});
test('call front switches search and gestures atomically on the same connection',async t=>{
 const calls:unknown[]=[],tool={type:'function',name:'avatar_gesture',parameters:{type:'object'}};
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  manualTurns:true,instructions:'voice',session_options:{enable_search:true},onTool:(...args:unknown[])=>{calls.push(args);return {sent:true};},onEvent:()=>{}});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!,connections=Socket.sockets.length;
 const updates=()=>socket.sent.filter(e=>e.type==='session.update');
 assert.deepEqual(updates().at(-1)!.session.tools,[]);assert.equal(updates().at(-1)!.session.enable_search,true);
 socket.acknowledgeUpdates=false;
 let acknowledged=false;const video=front.setInstructions('video',{tools:[tool]}).then(()=>{acknowledged=true;});
 await new Promise(r=>setImmediate(r));
 assert.equal(updates().length,2);assert.equal(updates().at(-1)!.session.instructions,'video');
 assert.deepEqual(updates().at(-1)!.session.tools,[tool]);assert.equal(updates().at(-1)!.session.enable_search,false);
 const context=front.setInstructions('video context');await new Promise(r=>setImmediate(r));
 assert.equal(updates().length,2);assert.equal(acknowledged,false);
 socket.acknowledgeUpdates=true;socket.incoming({type:'session.updated'});await video;await context;
 assert.deepEqual(updates().at(-1)!.session.tools,[tool]);
 await front.setInstructions('voice',{tools:[]});assert.equal(updates().at(-1)!.session.instructions,'voice');
 assert.deepEqual(updates().at(-1)!.session.tools,[]);assert.equal(updates().at(-1)!.session.enable_search,true);
 socket.incoming({type:'response.created',response:{id:'late-gesture'}});
 socket.incoming({type:'response.function_call_arguments.done',response_id:'late-gesture',call_id:'late',name:'avatar_gesture',arguments:'{}'});
 socket.incoming({type:'response.done',response:{id:'late-gesture',status:'completed'}});
 assert.deepEqual(calls,[]);assert.equal(socket.sent.some(e=>e.type==='conversation.item.create'||e.type==='response.create'),false);
 assert.equal(Socket.sockets.length,connections);assert.equal(front.ready(),true);
});
test('call front native gesture output preserves tool items and queues its spoken continuation before the next manual reply',async t=>{
 const calls:unknown[]=[],errors:unknown[]=[],tool={type:'function',name:'avatar_gesture',description:'Choose a gesture',parameters:{type:'object',properties:{gesture:{type:'string',enum:['wave','heart','rest']}},required:['gesture'],additionalProperties:false}};
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  manualTurns:true,instructions:'call',session_options:{enable_search:true},onTool:(name:string,args:unknown)=>{calls.push([name,args]);return {sent:true};},onEvent:()=>{},onError:(error:unknown)=>errors.push(error)});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!;
 await front.setInstructions('video',{tools:[tool]});assert.deepEqual(socket.sent.filter(e=>e.type==='session.update').at(-1)!.session.tools,[tool]);
 await front.setInstructions('same call scope');assert.equal(socket.sent.filter(e=>e.type==='session.update').at(-1)!.session.enable_search,false);
 const reply=front.requestReply();await until(()=>socket.sent.some(e=>e.type==='response.create'));
 socket.incoming({type:'response.created',response:{id:'gesture'}});
 const item={id:'gesture-item',type:'function_call',call_id:'gesture-call',name:'avatar_gesture',arguments:'{"gesture":"heart"}'};
 socket.incoming({type:'response.output_item.added',response_id:'gesture',item});
 socket.incoming({type:'response.function_call_arguments.done',response_id:'gesture',call_id:item.call_id,name:item.name,arguments:item.arguments});
 assert.deepEqual(calls,[['avatar_gesture',{gesture:'heart'}]]);assert.equal(socket.sent.some(e=>e.type==='conversation.item.create'),false);
 const next=front.requestReply();socket.incoming({type:'response.done',response:{id:'gesture',status:'completed',output:[item]}});
 assert.equal((await reply).completed,true);await until(()=>socket.sent.some(e=>e.type==='conversation.item.create'));
 const output=socket.sent.find(e=>e.type==='conversation.item.create')!.item;
 assert.equal(output.type,'function_call_output');assert.equal(output.call_id,item.call_id);assert.deepEqual(JSON.parse(output.output),{sent:true});
 socket.incoming({type:'conversation.item.created',item:output});await until(()=>socket.sent.filter(e=>e.type==='response.create').length===2);
 socket.incoming({type:'response.created',response:{id:'spoken'}});socket.incoming({type:'response.audio.delta',response_id:'spoken',delta:'AA=='});
 socket.incoming({type:'response.done',response:{id:'spoken',status:'completed'}});await until(()=>socket.sent.filter(e=>e.type==='response.create').length===3);
 socket.incoming({type:'response.created',response:{id:'next'}});socket.incoming({type:'response.done',response:{id:'next',status:'completed'}});
 assert.equal((await next).completed,true);assert.equal(socket.sent.some(e=>e.type==='conversation.item.delete'),false);assert.deepEqual(errors,[]);
});
test('call front cancellation suppresses late gesture calls and drops in-flight tool results',async t=>{
 for(const started of [false,true]){
  const calls:unknown[]=[],errors:unknown[]=[];let resolveOutput:(value:unknown)=>void=()=>{};
  const output=new Promise(resolve=>{resolveOutput=resolve;});
  const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
   endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
   manualTurns:true,instructions:'call',tools:[{type:'function',name:'avatar_gesture',parameters:{type:'object'}}],
   onTool:(name:string,args:unknown)=>{calls.push([name,args]);return output;},onEvent:()=>{},onError:(error:unknown)=>errors.push(error)});
  try{
   await front.connect();const socket=Socket.sockets.at(-1)!,reply=front.requestReply();await until(()=>socket.sent.some(e=>e.type==='response.create'));
   socket.incoming({type:'response.created',response:{id:'cancelled-gesture'}});
   const call={type:'response.function_call_arguments.done',response_id:'cancelled-gesture',call_id:'late-call',name:'avatar_gesture',arguments:'{"gesture":"wave"}'};
   if(started)socket.incoming(call);
   const cancelled=front.cancel();socket.incoming(call);
   socket.incoming({type:'response.done',response:{id:'cancelled-gesture',status:'cancelled'}});await cancelled;
   socket.incoming(call);socket.incoming({type:'response.done',response:{id:'cancelled-gesture',status:'cancelled'}});
   resolveOutput({sent:true});await new Promise(r=>setImmediate(r));
   assert.equal((await reply).cancelled,true);assert.equal(calls.length,started?1:0);
   assert.equal(socket.sent.some(e=>e.type==='conversation.item.create'),false);assert.equal(socket.sent.filter(e=>e.type==='response.create').length,1);assert.deepEqual(errors,[]);
  }finally{front.close();await front.join();}
 }
});
test('call front surfaces gesture callback failures, sends a refusal receipt and keeps the call connected',async t=>{
 const errors:unknown[]=[],failure=new Error('gesture transport failed'),front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  instructions:'call',tools:[{type:'function',name:'avatar_gesture',parameters:{type:'object'}}],onTool:()=>{throw failure;},onEvent:()=>{},onError:(error:unknown)=>errors.push(error)});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!;
 socket.incoming({type:'response.created',response:{id:'failure'}});
 socket.incoming({type:'response.function_call_arguments.done',response_id:'failure',call_id:'failed-call',name:'avatar_gesture',arguments:'{}'});
 socket.incoming({type:'response.done',response:{id:'failure',status:'completed',output:[{type:'function_call'}]}});
 await until(()=>socket.sent.some(e=>e.type==='conversation.item.create'));assert.deepEqual(errors,[failure]);assert.equal(front.ready(),true);
 const output=socket.sent.find(e=>e.type==='conversation.item.create')!.item;assert.deepEqual(JSON.parse(output.output),{sent:false});
 socket.incoming({type:'conversation.item.created',item:output});await until(()=>socket.sent.some(e=>e.type==='response.create'));
 socket.incoming({type:'response.created',response:{id:'refusal'}});socket.incoming({type:'response.done',response:{id:'refusal',status:'completed'}});
});
test('call cancel waits for acknowledgement or closed transport and never cancels an absent response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const acknowledge of [true,false]){
  const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
   endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'longanlingxi',apiKey:'synthetic-offline-only',WebSocket:Socket,
   instructions:'call',onEvent:()=>{}});
  await front.connect();const socket=Socket.sockets.at(-1)!;socket.incoming({type:'response.created',response:{id:'counting'}});
  let settled=false;const cancelling=front.cancel().then(()=>{settled=true;});await new Promise(r=>setImmediate(r));
  assert.equal(settled,false,'the owner sentence must stay buffered until the remote lifecycle settles');
  if(acknowledge)socket.incoming({type:'response.done',response:{id:'counting',status:'cancelled'}});else t.mock.timers.tick(1000);
  await cancelling;
  assert.equal(socket.readyState,acknowledge?Socket.OPEN:3);
  await front.cancel();assert.equal(socket.sent.filter(e=>e.type==='response.cancel').length,1,'finished/absent inference sends no second cancel');
  front.close();await front.join();
 }
});
test('cancelling a requested call reply waits for its late ID before cancelling and admitting the next request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const starts of [true,false]){
  const events:Record<string,any>[]=[],front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
   endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
   manualTurns:true,instructions:'call',onEvent:(event:Record<string,any>)=>events.push(event)});
  await front.connect();const socket=Socket.sockets.at(-1)!,reply=front.requestReply();await new Promise(r=>setImmediate(r));
  let settled=false;const cancelling=front.cancel().then(()=>{settled=true;}),next=front.requestReply();
  assert.equal((await reply).cancelled,true);t.mock.timers.tick(1000);await new Promise(r=>setImmediate(r));
  assert.equal(socket.sent.filter(e=>e.type==='response.cancel').length,0,'Qwen cannot cancel before response.created');
  assert.equal(socket.sent.filter(e=>e.type==='response.create').length,1);assert.equal(settled,false);assert.equal(socket.readyState,Socket.OPEN);
  if(starts){
   socket.incoming({type:'response.created',response:{id:'late'}});socket.incoming({type:'response.audio.delta',response_id:'late',delta:'AA=='});
   assert.ok(events.filter(e=>e.response?.id==='late'||e.response_id==='late').every(e=>e.__voiceContext.suppressed));
   assert.equal(socket.sent.filter(e=>e.type==='response.cancel').length,1);assert.equal(settled,false);
   socket.incoming({type:'response.done',response:{id:'late',status:'cancelled'}});await cancelling;await new Promise(r=>setImmediate(r));
   assert.equal(socket.sent.filter(e=>e.type==='response.create').length,2);
   socket.incoming({type:'response.created',response:{id:'next'}});socket.incoming({type:'response.done',response:{id:'next',status:'completed'}});
   assert.equal((await next).completed,true);
  }else{t.mock.timers.tick(30000);await cancelling;await next;assert.equal(socket.readyState,3);}
  front.close();await front.join();
 }
});
test('call backchannels stay silent and discarded unheard replies leave no cloud conversation items',async t=>{
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'longanqian_v3.1',apiKey:'synthetic-offline-only',
  WebSocket:Socket,instructions:'only call context',onEvent:()=>{}});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!;
 assert.deepEqual(socket.sent.find(e=>e.type==='session.update')!.session.turn_detection,{type:'smart_turn'});
 front.appendAudio(pcm.toString('base64'));await front.setInstructions('updated call context');
 assert.equal('turn_detection' in socket.sent.filter(e=>e.type==='session.update').at(-1)!.session,false,
  'Qwen 3.1 forbids resending interaction mode after audio starts');
 const heard=front.hear('嗯，对');await until(()=>socket.sent.some(e=>e.type==='conversation.item.create'));
 const item=socket.sent.find(e=>e.type==='conversation.item.create')!.item;
 socket.incoming({type:'conversation.item.created',item});await heard;
 assert.equal(item.role,'user');assert.equal(item.content[0].text,'嗯，对');
 const audio=pcm.toString('base64'),recorded=front.hear({audio});
 await until(()=>socket.sent.filter(e=>e.type==='conversation.item.create').length===2);
 const sound=socket.sent.filter(e=>e.type==='conversation.item.create')[1]!.item;
 socket.incoming({type:'conversation.item.created',item:sound});await recorded;
 assert.deepEqual(sound.content[1],{type:'input_audio',audio});assert.match(sound.content[0].text,/不是新请求，也不是身份确认/);
 assert.equal(socket.sent.some(e=>e.type==='response.create'||e.type==='response.cancel'),false);
 socket.incoming({type:'response.created',response:{id:'unheard'}});
 socket.incoming({type:'response.output_item.added',response_id:'unheard',item:{id:'early-item'}});
 front.discardReply('unheard');
 socket.incoming({type:'response.output_item.done',response_id:'unheard',item:{id:'early-item'}});
 socket.incoming({type:'response.done',response:{id:'unheard',status:'cancelled',output:[{id:'late-item'}]}});
 assert.deepEqual(socket.sent.filter(e=>e.type==='conversation.item.delete').map(e=>e.item_id),['early-item','late-item']);
});
test('call front instruction promotion waits for configured session ACK and rejects provider failure or close',async()=>{
 for(const outcome of ['ack','error','close'] as const){
  const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
   endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'Tina',apiKey:'synthetic-offline-only',
   WebSocket:Socket,instructions:'pending restricted',onEvent:()=>{}});
  await front.connect();const socket=Socket.sockets.at(-1)!;socket.acknowledgeUpdates=false;
  let promoted=false;const update=front.setInstructions('owner authorized context').then(()=>{promoted=true;});
  const rejected=outcome==='ack'?undefined:assert.rejects(update);
  const queued=front.setInstructions('concurrent scope'),queuedRejected=outcome==='close'?assert.rejects(queued):undefined;
  await new Promise(r=>setImmediate(r));
  assert.equal(promoted,false);assert.equal(socket.sent.filter(e=>e.type==='session.update').at(-1)!.session.instructions,'owner authorized context');
  assert.equal(socket.sent.some(e=>e.type==='response.create'||e.type==='conversation.item.create'),false);
  socket.acknowledgeUpdates=true;
  if(outcome==='ack')socket.incoming({type:'session.updated'});
  else if(outcome==='error')socket.incoming({type:'error',error:{message:'reconfiguration denied'}});
  else front.close();
  await (rejected??update);await (queuedRejected??queued);assert.equal(promoted,outcome==='ack');
  if(outcome!=='close')assert.equal(socket.sent.filter(e=>e.type==='session.update').at(-1)!.session.instructions,'concurrent scope');
  front.close();await front.join();
 }
});
test('H manual ASR config survives configured refresh, commits once and never creates response',async t=>{
 const frontend=manualFrontend();t.after(async()=>{frontend.close();await frontend.join();});
 assert.throws(()=>frontend.commitInput(),/EMPTY_OR_NOT_READY/);await frontend.connect();let socket=Socket.sockets.at(-1)!;
 const checkSession=()=>{const sessions=socket.sent.filter(event=>event.type==='session.update');assert.ok(sessions.length);for(const event of sessions){assert.equal(event.session.turn_detection,null);assert.deepEqual(event.session.input_audio_transcription,{model:'alternate-ptt-asr'});assert.deepEqual(event.session.modalities,['text']);}};
 checkSession();socket.incoming({type:'session.created'});checkSession();assert.throws(()=>frontend.appendAudio(''),/INPUT_AUDIO_EMPTY/);
 frontend.appendAudio(pcm.toString('base64'));frontend.commitInput();assert.throws(()=>frontend.commitInput(),/EMPTY_OR_NOT_READY/);
 assert.deepEqual(socket.sent.filter(event=>event.type.startsWith('input_audio_buffer.')).map(event=>event.type),['input_audio_buffer.append','input_audio_buffer.commit']);assert.equal(socket.sent.filter(event=>event.type==='response.create').length,0);
 frontend.appendAudio(pcm.toString('base64'));frontend.close();await frontend.join();await frontend.connect();socket=Socket.sockets.at(-1)!;checkSession();assert.throws(()=>frontend.commitInput(),/EMPTY_OR_NOT_READY/);assert.equal(socket.sent.filter(event=>event.type==='input_audio_buffer.commit').length,0);
});
test('original transport commits only sent audio and closes when a commit cannot be sent',async t=>{
 const core=originalTransport();t.after(async()=>{core.close();await core.join();});
 core.appendAudio(pcm.toString('base64'));assert.throws(()=>core.commitInput(),/EMPTY_OR_NOT_READY/);
 await core.connect();const socket=Socket.sockets.at(-1)!;const session=socket.sent.find(event=>event.type==='session.update')!.session;
 assert.notEqual(session.turn_detection,null);assert.equal(session.input_audio_transcription,undefined);
 core.appendAudio(pcm.toString('base64'));core.commitInput();assert.throws(()=>core.commitInput(),/EMPTY_OR_NOT_READY/);
 assert.deepEqual(socket.sent.filter(event=>event.type.startsWith('input_audio_buffer.')).map(event=>event.type),['input_audio_buffer.append','input_audio_buffer.commit']);
 core.appendAudio(pcm.toString('base64'));socket.bufferedAmount=1024*1024+1;assert.throws(()=>core.commitInput(),/NOT_SENT/);await core.join();assert.equal(socket.readyState,3);assert.throws(()=>core.commitInput(),/EMPTY_OR_NOT_READY/);
});
test('append send rejection cannot manufacture nonempty manual buffer',async t=>{
 const core=originalTransport();t.after(async()=>{core.close();await core.join();});await core.connect();const socket=Socket.sockets.at(-1)!;
 socket.bufferedAmount=512*1024+1;core.appendAudio(pcm.toString('base64'));assert.throws(()=>core.commitInput(),/EMPTY_OR_NOT_READY/);await core.join();assert.equal(socket.readyState,3);assert.equal(socket.sent.some(event=>event.type==='input_audio_buffer.append'||event.type==='input_audio_buffer.commit'),false);
});
test('audio upload drain has a local PCM/base64 horizon and closes a sub-budget stalled transport',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const errors:unknown[]=[],core=originalTransport({onError:(error:unknown)=>errors.push(error)});
 await core.connect();const socket=Socket.sockets.at(-1)!;
 try{
  core.appendAudio(pcm.toString('base64'));socket.bufferedAmount=1;
  const drained=core.audioSent(),rejected=assert.rejects(drained,/REALTIME_AUDIO_UPLOAD_TIMEOUT/);
  t.mock.timers.tick(12287);assert.equal(socket.readyState,1,'a sub-budget queue is allowed its existing 512KiB wire horizon');
  t.mock.timers.tick(1);await rejected;await core.join();
  assert.equal(socket.readyState,3);assert.match(String(errors[0]),/REALTIME_AUDIO_UPLOAD_TIMEOUT/);
  t.mock.timers.tick(600000);assert.equal(errors.length,1,'a ten-minute stall leaves no live drain timer');
  await core.connect();core.appendAudio(pcm.toString('base64'));core.commitInput();
  assert.equal(Socket.sockets.at(-1)!.sent.filter(e=>e.type==='input_audio_buffer.commit').length,1,'normal recovery accepts replay input');
 }finally{core.close();await core.join();}
});
for(const event of ['close','error'] as const)test(`audio upload drain settles on transport ${event}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});let closed=0;
 const core=originalTransport({onClose:()=>closed++,onError:()=>{}});await core.connect();const socket=Socket.sockets.at(-1)!;
 try{
  core.appendAudio(pcm.toString('base64'));socket.bufferedAmount=1;const drained=core.audioSent();
  if(event==='close')socket.close();else socket.emit('error',new Error('upload transport failed'));
  await drained;await core.join();assert.equal(closed,1);assert.equal(socket.readyState,3);
  t.mock.timers.tick(600000);assert.equal(closed,1,'the cleared deadline cannot terminate again');
 }finally{core.close();await core.join();}
});
test('audio upload drain resolves after the actual write callback',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const core=originalTransport();await core.connect();const socket=Socket.sockets.at(-1)!;
 try{
  const original=socket.send.bind(socket);let written:(()=>void)|undefined;
  socket.send=((wire:string,callback?:()=>void)=>{original(wire);written=callback;socket.bufferedAmount=100;}) as typeof socket.send;
  core.appendAudio(pcm.toString('base64'));const drained=core.audioSent();socket.bufferedAmount=0;written!();await drained;
  t.mock.timers.tick(600000);assert.equal(socket.readyState,1);
 }finally{core.close();await core.join();}
});
test('MEDIA sends exact finite audio before one manual commit then original confirmation/D/native',async t=>{
 const f=await voiceFixture(t);const a=await f.append();const work=f.process(a.event);await until(()=>f.socket()?.sent.some(event=>event.type==='input_audio_buffer.commit')===true);
 const sent=f.socket()!.sent;assert.deepEqual(sent.filter(event=>event.type.startsWith('input_audio_buffer.')).map(event=>event.type),['input_audio_buffer.append','input_audio_buffer.commit']);assert.equal(sent.filter(event=>event.type==='response.create').length,0);assert.ok(Buffer.from(sent.find(event=>event.type==='input_audio_buffer.append')!.audio,'base64').equals(pcm));
 const record=await f.final();f.state('confirmed_request');await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,'request:manual-commit');const result=await work;assert.equal(result.processed_events.length,1);await until(()=>f.creates()===1);assert.equal(f.opens(),1);
});

test('independent ASR failed settles through original owned join without D or native reply',async t=>{
 const f=await voiceFixture(t);const a=await f.append();let settled=false;const work=f.process(a.event).catch(error=>{settled=true;return error;});
 await until(()=>f.socket()?.sent.some(e=>e.type==='input_audio_buffer.append')===true);
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.failed',item_id:'item:1',content_index:0,error:{code:'controlled_failure',message:'PRIVATE_DETAIL'}});
 await until(()=>settled);const error=await work;assert.match(String(error),/ACCEPTANCE_UNKNOWN/);assert.equal(String(error).includes('PRIVATE_DETAIL'),false);
 assert.equal(f.creates(),0);assert.deepEqual(await f.storage.list('processed-events'),[]);assert.deepEqual(await f.records(),[]);assert.equal(f.socket()!.readyState,3);
});

test('formal voice_send receipt is the only final authorization; forged, direct or mismatched evidence stays candidate',async t=>{
 const f=await voiceFixture(t,true,true);await f.runtime.configureTimeline({directory:join(f.storage.root,'timeline')});
 const a=await f.append();const work=f.process(a.event);const record=await f.final();
 assert.deepEqual(f.runtime.timeline!.page('owner').items,[]);
 for(const evidence of [`voice-send:${'0'.repeat(64)}`,'request:any','voice-send:forged'])
  assert.equal((await f.runtime.finalizeVoice(f.device,'session','voice-op',record.candidate_ref,evidence)).status,'not_finalized');
 const candidate=(await f.runtime.formalVoiceCandidates(f.device,'session','voice-op')).find(value=>value.kind==='transcript')!;
 const exact={candidate_ref:candidate.candidate_ref,candidate_revision:candidate.candidate_revision,window_ref:candidate.window_ref,
  selected_input_sha256:candidate.selected_input_sha256,transcript_sha256:candidate.transcript_sha256!};
 await assert.rejects(f.runtime.confirmFormalVoice(f.device,'session','voice-op',{...exact,transcript_sha256:sha256('不是这句话')}),
  /VOICE_EXACT_CONFIRMATION_REQUIRED/);
 assert.deepEqual(await f.storage.list('voice-confirmations'),[]);assert.equal(f.creates(),0);
 const sends=await Promise.all([f.runtime.confirmFormalVoice(f.device,'session','voice-op',exact),
   f.runtime.confirmFormalVoice(f.device,'session','voice-op',exact)]);
 assert.ok(sends.every(value=>value.status==='finalized'));
 const result=await work;const d=result.processed_events[0]!;
 const replay=await f.runtime.confirmFormalVoice(f.device,'session','voice-op',exact);
 assert.equal(replay.status,'finalized','lost confirmation can be resent unchanged after the source window was disposed');
 assert.equal('events' in replay&&replay.events[0]?.processed_event.processed_event_id,d.processed_event_id,
   'replay includes authoritative admission so a lost accepted packet can be recovered');
 await assert.rejects(f.runtime.confirmFormalVoice(f.device,'session','voice-op',{...exact,transcript_sha256:sha256('另一个原文')}),
   /VOICE_CONFIRMATION_CONFLICT/);
 // Without the cached outcome (released or a restart) the persisted confirmation answers; nothing recorded is a rejection.
 (f.runtime as unknown as {voiceSendReceipts:Map<string,unknown>}).voiceSendReceipts.clear();
 const restarted=await f.runtime.confirmFormalVoice(f.device,'session','voice-op',exact);
 assert.equal(restarted.status,'finalized');assert.deepEqual('events' in restarted&&restarted.events,[]);
 await assert.rejects(f.runtime.confirmFormalVoice(f.device,'session','voice-op',{...exact,transcript_sha256:sha256('另一个原文')}),/VOICE_WINDOW_CLOSED/);
 await assert.rejects(f.runtime.confirmFormalVoice(f.device,'session','never-opened',exact),/VOICE_WINDOW_CLOSED/);
 assert.equal(d.origin,'device_observation');assert.equal(d.user_identity,'unknown');assert.equal(d.intent_class,'explicit_request');
 assert.match(JSON.stringify(d.content),/不要开灯/);
 const receipts=await Promise.all((await f.storage.list('voice-confirmations')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('voice-confirmations',key)).toString())));
 const sendReceipts=receipts.filter(receipt=>receipt.source==='formal_voice_send');assert.equal(sendReceipts.length,1);
 const receipt=sendReceipts[0]!;assert.equal(receipts.filter(receipt=>receipt.processed_event_id===d.processed_event_id).length,0,'unidentified PTT opens no identity card; the exact-text voice_send receipt stays intact');
 assert.equal(receipt.source,'formal_voice_send');assert.equal(receipt.candidate_ref,record.candidate_ref);
 assert.equal(receipt.principal_id,'owner');assert.equal(receipt.device_id,'glasses');
 await until(()=>f.creates()===1);assert.equal(f.opens(),1);
 await f.process(a.event,'timeline-replay');
 assert.equal(principalAttribution(d),null,'voice_send adopts exact text without attesting the speaker');
 assert.deepEqual(await ownerActionGrant(d),[]);
 assert.deepEqual(f.runtime.timeline!.page('owner').items,[],'unattributed voice stays outside the owner timeline after replay');
});
test('a confirmed voice_send whose processing failed replays that definite error',async t=>{
 const f=await voiceFixture(t,true,true);const a=await f.append();const work=f.process(a.event);void work.catch(()=>{});const record=await f.final();
 (f.runtime as unknown as {admitProcessed:()=>Promise<never>}).admitProcessed=async()=>{throw new ContractError('ADMISSION_CAPACITY_EXCEEDED',429);};
 const exact={candidate_ref:record.candidate_ref,candidate_revision:record.candidate_revision,window_ref:record.window_ref,
  selected_input_sha256:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript))};
 assert.equal((await f.runtime.confirmFormalVoice(f.device,'session','voice-op',exact)).status,'finalized');
 await assert.rejects(work,/ADMISSION_CAPACITY_EXCEEDED/);
 await assert.rejects(f.runtime.confirmFormalVoice(f.device,'session','voice-op',exact),/ADMISSION_CAPACITY_EXCEEDED/);
 assert.equal(f.creates(),0);
});
test('Mac formal PTT PCM and voice_send produce a text-only reply without TTS or speaker attribution',async t=>{
 const f=await voiceFixture(t,true,true,true),a=await f.append(),work=f.process(a.event);
 const record=await f.final();
 assert.equal(f.socket()!.sent.filter(event=>event.type==='input_audio_buffer.commit').length,1);
 assert.equal(f.socket()!.sent.filter(event=>event.type==='response.create').length,0);
 assert.equal((await f.runtime.confirmFormalVoice(f.device,'session','voice-op',{
  candidate_ref:record.candidate_ref,candidate_revision:record.candidate_revision,window_ref:record.window_ref,
  selected_input_sha256:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript))})).status,'finalized');
 const d=(await work).processed_events[0]!;
 assert.equal(d.device_type,'mac');assert.equal(d.user_identity,'unknown');assert.equal(principalAttribution(d),null);
 assert.deepEqual(await ownerActionGrant(d),[]);assert.equal(await f.archive.validateEvidence(d),true);
 assert.deepEqual((await new OutputTargetAuthority(f.storage).read(d)).output_modes,['text']);
 await until(()=>f.creates()===1);
 let run:string|undefined;
 await until(async()=>{run=(await f.runtime.event(f.device,'session',d.processed_event_id)).admission.run_id??undefined;return Boolean(run);});
 assert.ok(run);
 assert.deepEqual(await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'ptt-open'},
  args:{reply_mode:'text_and_voice'}}),{status:'opened',error_code:null});
 f.finishNative();
 const reply=await f.runtime.result(f.device,'session',d.processed_event_id);
 assert.equal(reply.result.result_status,'completed');assert.equal(reply.result.reply_mode,'text');assert.equal(reply.result.voice_status,'none');
 assert.equal(reply.chunks.map(chunk=>chunk.text).join(''),'Mac 文字回复。');assert.deepEqual(reply.voice_chunks,[]);
 assert.deepEqual(reply.result.output_plan,[{target_device_id:'mac',device_type:'mac',output_modes:['text'],route_version:'route'}]);
 assert.equal(f.ttsCalls(),0);assert.deepEqual(await f.storage.list('derived-audio'),[]);
 assert.equal(f.creates(),1);assert.equal(f.opens(),1);
});
test('formal final authorization rejects a receipt recorded for another device or a tampered receipt',async t=>{
 const f=await voiceFixture(t,true,true);const a=await f.append();const work=f.process(a.event);void work.catch(()=>{});const record=await f.final();
 const authority=createFormalVoiceAuthority(f.storage);
 const fields={candidate_ref:record.candidate_ref,candidate_revision:record.candidate_revision,window_ref:record.window_ref,
  selected_input_sha256:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript))};
 const other=await authority.recordConfirmation({...f.device,device_id:'phone'},'session','voice-op',fields);
 assert.equal((await authority.authorizeFinal(f.device,record,other)).state,'unknown');
 const own=await authority.recordConfirmation(f.device,'session','voice-op',fields);
 assert.equal((await authority.authorizeFinal(f.device,record,own)).state,'confirmed_request');
 assert.equal((await authority.authorizeFinal(f.device,{...record,candidate_revision:'changed-revision'},own)).state,'unknown');
 await f.runtime.cancelMedia(f.device,'voice-op');await assert.rejects(work);
});


test('late clear and commit ACKs cannot erase newer manually appended input',async t=>{
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  manualTurns:true,instructions:'call',onEvent:()=>{}});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!;
 front.appendAudio(pcm.toString('base64'));front.clearInput();front.appendAudio(pcm.toString('base64'));
 socket.incoming({type:'input_audio_buffer.cleared'});assert.doesNotThrow(()=>front.commitInput(),'late clear ACK does not clear newer input');
 front.appendAudio(pcm.toString('base64'));socket.incoming({type:'input_audio_buffer.committed',item_id:'earlier'});
 assert.doesNotThrow(()=>front.commitInput(),'late commit ACK does not clear newer input');
 assert.equal(socket.sent.filter(e=>e.type==='input_audio_buffer.commit').length,2);assert.throws(()=>front.commitInput(),/EMPTY_OR_NOT_READY/);
});


test('aborted queued call progress injects no stale item and leaves the final result deliverable',async t=>{
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  manualTurns:true,instructions:'call',onEvent:()=>{}});
 t.after(async()=>{front.close();await front.join();});await front.connect();const socket=Socket.sockets.at(-1)!;
 const first=front.respond('先前正在播放的回复');await until(()=>socket.sent.some(e=>e.type==='conversation.item.create'));
 socket.incoming({type:'conversation.item.created',item:socket.sent.find(e=>e.type==='conversation.item.create')!.item});
 await until(()=>socket.sent.some(e=>e.type==='response.create'));
 socket.incoming({type:'response.created',response:{id:'preceding'}});
 const abort=new AbortController(),progress=front.respond('过期的查询进度',()=>!abort.signal.aborted),final=front.respond('最终查询结果');
 abort.abort();socket.incoming({type:'response.done',response:{id:'preceding',status:'completed'}});await first;
 await until(()=>socket.sent.filter(e=>e.type==='conversation.item.create').length===2);
 socket.incoming({type:'conversation.item.created',item:socket.sent.filter(e=>e.type==='conversation.item.create')[1]!.item});
 await until(()=>socket.sent.filter(e=>e.type==='response.create').length===2);
 assert.equal((await progress).skipped,true);
 const items=socket.sent.filter(e=>e.type==='conversation.item.create');
 assert.equal(items.some(e=>JSON.stringify(e.item).includes('过期的查询进度')),false,'cancelled commentary never enters native history');
 assert.equal(items.some(e=>JSON.stringify(e.item).includes('最终查询结果')),true);
 socket.incoming({type:'response.created',response:{id:'final'}});socket.incoming({type:'response.done',response:{id:'final',status:'completed'}});
 assert.equal((await final).completed,true);assert.equal(socket.sent.filter(e=>e.type==='response.create').length,2);
});

// Controlled VAD/embedding; the real shared registry, finalizer, archive, admission and phone watch run unchanged.
for(const device_type of ['phone','mac'] as const)for(const verdict of ['owner','uncertain','speaker','unknown','short','silent'] as const)
test(`formal ${device_type} PTT scores ${verdict} through the unified registry before native admission`,async t=>{
 const axis=(x:number)=>{const e=new Float32Array(32);e[0]=x;e[1]=Math.sqrt(1-x*x);return e;};
 const controlled=controlledEngine({wake:[1]}),engine={...controlled,speaker_model:{...controlled.speaker_model,dim:32}};
 const stranger=new Float32Array(32);stranger[2]=1;
 const unknown=new Float32Array(32);unknown[3]=1;
 const embedding=verdict==='speaker'?stranger:verdict==='unknown'?unknown:axis(verdict==='uncertain'?.55:1);
 engine.embed=async samples=>{engine.calls.push(`embed:${samples.length}`);if(samples.length<1600)throw new ContractError('SPEECH_INPUT_TOO_SHORT');return embedding;};
 let registry:VoiceprintRegistry;const inputs:import('../src/voiceprint/contracts.ts').IdentifyInput[]=[];
 const identifier={model:engine.speaker_model,identify:(vector:Float32Array,input:import('../src/voiceprint/contracts.ts').IdentifyInput)=>{inputs.push(input);return registry.identify(vector,input);}};
 const worker=new SherpaAudioWorker(async()=>engine,controlledDetector(),identifier,'turn');
 const speech=verdict==='silent'?0:verdict==='short'?1024:24064;
 const audio=Buffer.alloc((speech+4096)*2);for(let n=0;n<speech;n++)audio.writeInt16LE(1,n*2);
 const f=await voiceFixture(t,true,true,device_type==='mac',{device_type,audio,
  identity:async(request,signal)=>({result:await worker.analyzeIdentity(request,signal),capability:sherpaAudioCapability(engine,true,'turn')})});
 registry=new VoiceprintRegistry(f.storage,engine.speaker_model);t.after(()=>registry.close());
 const fileVoice=new Float32Array(32);fileVoice[4]=1;
 await registry.enrollOwner({speaker_model:engine.speaker_model,channel:'file',mode:'replace',samples:Array.from({length:5},()=>({embedding:fileVoice,speech_ms:2000}))});
 await registry.enrollOwner({speaker_model:engine.speaker_model,channel:device_type==='phone'?'phone_app':'mac',mode:'replace',samples:Array.from({length:5},()=>({embedding:axis(1),speech_ms:2000}))});
 const other=await registry.identify(stranger,{mode:'observe',channel:'ambient',speech_ms:2500,observed_at:'2026-10-01T00:00:00.000Z'});
 assert.equal(other.kind,'speaker');
 await f.runtime.configureTimeline({directory:join(f.storage.root,'timeline')});
 const phone=device_type==='phone'?f.device:await f.runtime.authenticate('phone-token');
 t.after(await f.runtime.watchCare(phone,async()=>true));
 const updates:import('../src/runtime.ts').PendingVoiceConfirmation[][]=[];
 const unwatch=await f.runtime.watchVoiceConfirmations(phone,async pending=>{updates.push(pending);},error=>{throw error;});t.after(unwatch);
 const a=await f.append(),work=f.process(a.event),record=await f.final();
 await f.runtime.confirmFormalVoice(f.device,'session','voice-op',{candidate_ref:record.candidate_ref,candidate_revision:record.candidate_revision,
  window_ref:record.window_ref,selected_input_sha256:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript))});
 const d=(await work).processed_events[0]!;
 assert.deepEqual(d.speakers.map(s=>(s as {voiceprint:string}).voiceprint),verdict==='silent'?[]:[verdict==='owner'?'owner':verdict==='uncertain'?'owner_uncertain':verdict==='speaker'?`speaker:${other.kind==='speaker'?other.cluster_id:''}`:'unknown']);
 assert.equal(voiceEvidence(d),verdict==='owner'?'owner':verdict==='uncertain'?'owner_uncertain':'other');
 assert.equal(runScope(d),verdict==='owner'?'owner':'owner_uncertain');
 assert.equal(principalAttribution(d),verdict==='owner'?'owner_voice':null);
 assert.deepEqual(inputs.map(input=>[input.channel,input.mode,input.speech_ms]),speech<1600?[]:[[device_type==='phone'?'phone_app':'mac','verify',1504]]);
 assert.deepEqual(engine.calls,speech?[`embed:${speech}`]:[],'PTT performs no local ASR or wake detection');
 assert.equal((d.content.transcript as {text:string}).text,'不要开灯。只查询状态。');
 const observation=(d.content.audio_observations as {observation_kind:string;model:{native_metadata:{identity_only:boolean;asr_ms:number;kws_ms:number}}}[])[0]!;
 assert.equal(observation.observation_kind,'sample_voice_identity');assert.equal(observation.model.native_metadata.identity_only,true);
 assert.equal(observation.model.native_metadata.asr_ms,0);assert.equal(observation.model.native_metadata.kws_ms,0);
 assert.equal(await f.archive.validateEvidence(d),true);
 await until(()=>f.creates()===1);const native=f.nativeBody() as {input:string;run_scope?:string};
 assert.equal(native.run_scope,verdict==='owner'?undefined:'owner_uncertain');
 const fact=JSON.parse(native.input).voice_confirmation;
 if(verdict==='uncertain'){
  await until(()=>updates.some(pending=>pending.length===1));const pending=updates.flat().find(p=>p.processed_event_id===d.processed_event_id)!;
  assert.equal(pending.event_id,`voice-confirm:${fact.confirmation_id}`);assert.equal(pending.confirmation_id,fact.confirmation_id);
  assert.equal(pending.text,'不要开灯。只查询状态。');assert.equal(pending.session_id,'session');
  assert.ok(pending.expires_in_ms>0&&pending.expires_in_ms<=120000);assert.ok(Math.abs(Date.now()+pending.expires_in_ms-fact.expires_at_ms)<1000);
 }else {assert.equal(fact,verdict==='owner'?undefined:null);assert.ok(updates.every(pending=>pending.length===0));}
 if(verdict==='owner')assert.ok(f.runtime.timeline!.page('owner').items.some(item=>item.via==='ptt'&&item.text==='不要开灯。只查询状态。'));
 const replay=await f.process(a.event,'replay');assert.deepEqual(replay.processed_events,[d]);assert.equal(f.opens(),1);assert.equal(f.creates(),1);assert.deepEqual(engine.calls,speech?[`embed:${speech}`]:[]);
 if(verdict==='uncertain'){
  const confirmer=device_type==='mac'?f.device:phone;
  await assert.rejects(f.runtime.confirmVoice(confirmer,{confirmation_id:fact.confirmation_id}),/VOICE_CONFIRMATION_APP_UPDATE_REQUIRED/);
  for(const auth of ['failed',device_type==='mac'?'face_id':'touch_id'])
   await assert.rejects(f.runtime.confirmVoice(confirmer,{confirmation_id:fact.confirmation_id,auth}),/VOICE_CONFIRMATION_BIOMETRIC_INVALID/);
  assert.equal(f.creates(),1);assert.equal((await f.runtime.voiceConfirmations(phone)).length,1);
  assert.deepEqual(await f.storage.list('voice-confirmation-decisions'),[],'failed local authentication cannot adopt the request');
  f.finishNative();
  const confirmed=await f.runtime.confirmVoice(confirmer,{confirmation_id:fact.confirmation_id,auth:device_type==='mac'?'touch_id':'face_id'});
  assert.equal(runScope(confirmed.processed_event),'owner');
  assert.equal((confirmed.processed_event.content.app_event as {request_text:string}).request_text,'不要开灯。只查询状态。');
  await until(()=>f.creates()===2);await until(()=>updates.at(-1)?.length===0);
  const admitted=JSON.parse((f.nativeBody() as {input:string}).input);
  assert.equal(admitted.content.app_event.confirmed_request.processed_event_id,d.processed_event_id);
  assert.equal(admitted.content.app_event.request_text,'不要开灯。只查询状态。');
  assert.ok(f.runtime.timeline!.page('owner').items.some(item=>item.via==='ptt'&&item.text==='不要开灯。只查询状态。'));
 }
 if(verdict==='owner'&&device_type==='mac'){
  let run:string|undefined;await until(async()=>{run=(await f.runtime.event(f.device,'session',d.processed_event_id)).admission.run_id??undefined;return Boolean(run);});
  assert.ok(run);await f.runtime.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'scored-ptt-open'},args:{reply_mode:'text_and_voice'}});
  f.finishNative();await f.runtime.result(f.device,'session',d.processed_event_id);
  assert.ok(f.runtime.timeline!.page('owner').items.some(item=>item.kind==='yimi'&&item.via==='ptt'&&item.text==='Mac 文字回复。'));
 }
});

test('restart preserves an immutable legacy PTT final and does not rescore or rewrite its input',async t=>{
 const f=await voiceFixture(t,true,true,true);let captured:Parameters<MediaProcessor['finalizeVoice']>|undefined;
 const finalize=f.processor.finalizeVoice.bind(f.processor);
 f.processor.finalizeVoice=(...args)=>{captured=args;return finalize(...args);};
 const a=await f.append(),work=f.process(a.event),record=await f.final();
 await f.runtime.confirmFormalVoice(f.device,'session','voice-op',{candidate_ref:record.candidate_ref,candidate_revision:record.candidate_revision,
  window_ref:record.window_ref,selected_input_sha256:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript))});
 const d=(await work).processed_events[0]!;assert.equal(d.processing.path_id,'voice_frontend');assert.deepEqual(d.speakers,[]);
 const key=digest([d.raw_ref,d.segment_id,1]),before=await f.storage.read('processed-media-inputs',key);
 const restarted=new MediaProcessor(f.storage,new Map(),f.processor.config);t.after(()=>restarted.close());
 const [segment,request,text,candidateRef,requestRef,model]=captured!;
 const restored=await restarted.finalizeVoice(segment,request,text,candidateRef,requestRef,model,new AbortController().signal,async()=>{throw new Error('LEGACY_FINAL_MUST_NOT_BE_RESCORED');});
 assert.deepEqual(restored,d);assert.equal(restored.revision,1);
 assert.ok(Buffer.from(await f.storage.read('processed-media-inputs',key)).equals(Buffer.from(before)));
});

for(const device_type of ['phone','mac'] as const)test(`owner override actual ${device_type} short PTT final admits owner without a confirmation card`,async t=>{
 const engine=controlledEngine({wake:[1]}),worker=new SherpaAudioWorker(async()=>engine,controlledDetector(),undefined,'turn');
 const audio=Buffer.alloc(4096);for(let n=0;n<1024;n++)audio.writeInt16LE(1,n*2);
 const f=await voiceFixture(t,true,true,device_type==='mac',{device_type,audio,
  identity:async(request,signal)=>({result:await worker.analyzeIdentity(request,signal),capability:sherpaAudioCapability(engine,true,'turn')})},true);
 const a=await f.append(),work=f.process(a.event),record=await f.final();
 await f.runtime.confirmFormalVoice(f.device,'session','voice-op',{candidate_ref:record.candidate_ref,candidate_revision:record.candidate_revision,
  window_ref:record.window_ref,selected_input_sha256:record.selected_input_sha256,transcript_sha256:sha256(String(record.candidate.event.transcript))});
 const result=await work,original=result.processed_events[0]!,accepted=result.events[0]!.processed_event;
 assert.equal(principalAttribution(accepted),'owner_override');assert.equal(runScope(accepted),'owner');assert.equal(result.events[0]!.voice_confirmation,undefined);
 assert.deepEqual(accepted.speakers,original.speakers);assert.equal(accepted.user_identity,original.user_identity);
 assert.equal(await f.archive.validateEvidence(accepted),true);await until(()=>f.creates()===1);
 const native=f.nativeBody() as {input:string;run_scope?:string};assert.equal(native.run_scope,undefined);assert.equal(JSON.parse(native.input).voice_confirmation,undefined);
});

test('owner deletion fences a late real voice candidate and legacy candidate reads',async t=>{
 const f=await voiceFixture(t),a=await f.append();
 const committed=Promise.withResolvers<void>(),saved=Promise.withResolvers<VoiceRecord>();
 const send=Socket.prototype.send,publish=f.storage.publish.bind(f.storage);
 Socket.prototype.send=function(wire:string){send.call(this,wire);if(JSON.parse(wire).type==='input_audio_buffer.commit')committed.resolve();};
 t.after(()=>{Socket.prototype.send=send;f.storage.publish=publish;});
 f.storage.publish=async(namespace,key,bytes)=>{const result=await publish(namespace,key,bytes);
  if(namespace==='voice-transcripts')saved.resolve(JSON.parse(Buffer.from(result).toString()) as VoiceRecord);return result;};
 const work=f.process(a.event).catch(error=>error);
 await committed.promise;
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'before-delete',transcript:'before deletion'});
 const record=await saved.promise;
 await f.archive.delete(a.event.raw_ref,'owner');
 await assert.rejects(f.service.voiceCandidates(f.device,'voice-op'),/RAW_DELETED/);
 await assert.rejects(f.runtime.formalVoiceCandidates(f.device,'session','voice-op'),/RAW_DELETED/);
 assert.deepEqual(await f.storage.list('voice-transcripts'),[]);
 // A pre-upgrade retained record must also fail closed through the public reader.
 const key=record.candidate_ref.slice('voice-candidate:'.length);
 await publish('voice-transcripts',key,Buffer.from(JSON.stringify(record)));
 await assert.rejects(f.runtime.voiceCandidate(f.device,record.candidate_ref),/RAW_DELETED/);
 await f.storage.removeOriginals([{namespace:'voice-transcripts',key}]);
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'after-delete',transcript:'late private transcript'});
 const outcome=await work;
 assert.deepEqual(await f.storage.list('voice-transcripts'),[]);
 assert.match(String(outcome),/RAW_DELETED/);
 assert.deepEqual(await f.storage.list('processed-media'),[]);
 assert.deepEqual(await f.storage.sessionRecords(a.event.raw_ref),[]);
});

test('source revocation probe precedes a consistent snapshot of newly persisted voice candidates',async t=>{
 const f=await voiceFixture(t),a=await f.append(),committed=Promise.withResolvers<void>();
 const send=Socket.prototype.send,read=f.storage.read.bind(f.storage);
 Socket.prototype.send=function(wire:string){send.call(this,wire);if(JSON.parse(wire).type==='input_audio_buffer.commit')committed.resolve();};
 t.after(()=>{Socket.prototype.send=send;f.storage.read=read;});
 const work=f.process(a.event).catch(error=>error);
 await committed.promise;
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'snapshot:first',transcript:'first candidate'});
 const first=await f.service.voiceCandidates(f.device,'voice-op');assert.equal(first.length,1);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let armed=true;
 t.after(()=>release.resolve());
 f.storage.read=async(namespace,key)=>{
  if(armed&&namespace==='owner-deletions'&&key===a.event.raw_ref.slice(3)){armed=false;entered.resolve();await release.promise;}
  return read(namespace,key);
 };
 const pending=f.service.voiceCandidates(f.device,'voice-op').then(records=>({records}),error=>({error}));
 await entered.promise;
 f.socket()!.incoming({type:'conversation.item.input_audio_transcription.completed',item_id:'snapshot:next',transcript:'next candidate'});
 const latest=await f.service.voiceCandidates(f.device,'voice-op');assert.equal(latest.length,2);
 release.resolve();const snapshot=await pending;
 await f.runtime.cancelMedia(f.device,'voice-op');await work;
 if('error' in snapshot)throw snapshot.error;
 assert.deepEqual(snapshot.records,latest);
 assert.ok(snapshot.records.some(record=>record.candidate.event.transcript==='next candidate'));
});
