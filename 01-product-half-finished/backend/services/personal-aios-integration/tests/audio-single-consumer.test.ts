import {sourceClient} from './native-source-fixture.ts';
import {materialized} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAIOSRuntime } from './native-source-fixture.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { sha256, digest, type RawEvent, type TrustedContext, type TimeRange, type ProcessedEvent } from '../src/contracts.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { StreamArchive, type TrackChunk } from '../src/stream-archive.ts';
import { MediaProcessor, type Capability, type WorkerPort, type WorkerRequest } from '../src/media/processing.ts';
import { MediaService, type MediaServiceConfig, type MediaVadPort } from '../src/media/service.ts';
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
async function mediaFixture(t:test.TestContext, worker=defaultWorker, override:Partial<MediaServiceConfig>={}) {
  const directory=await mkdtemp(join(tmpdir(),'paios-media-service-'));t.after(async()=>{await fixtureRuntimeClose();await rm(directory,{recursive:true,force:true});});
  let fixtureRuntimeClose=async()=>{};
  const storage=new PosixStorage(directory);
  const budget={max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20};
  const archive=new RawArchive(storage,10000,undefined,budget);
  const streamArchive=new StreamArchive(storage,budget);
  const processor=new MediaProcessor(storage,new Map([['controlled',worker]]),{policy_version:'service-fixture',max_inflight:2,
    max_input_bytes:100000,timeout_ms:500,allow_external:false,allow_replay:true,allow_partial:true});
  const config:MediaServiceConfig={storage,archive,streamArchive,processor,capabilities:async()=>[cap],vad,
    align:{max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:200,
    fixtureOnly:true,...override};
  t.after(()=>processor.close());
  return {setCleanup:(close:()=>Promise<void>)=>{fixtureRuntimeClose=close;},storage,archive,processor,service:new MediaService(config),config,budget};
}

import {AudioConsumption,AudioConsumptionUnknownError,type AudioRoute} from '../src/media/audio-consumption.ts';
import type {NativeClient,NativeRun} from './native-source-fixture.ts';
import type {VadStreamFactory} from '../src/media/silero-stream.ts';
import {testJournal} from './speech-fixture.ts';
const route:AudioRoute={consumer:'media',source_scope:'authenticated-continuity',capture_span:'button-span',purpose_evidence_ref:'button-source-evidence'};
async function fixture(t:test.TestContext,options:{consumer?:AudioRoute['consumer'];continuous?:boolean;worker?:WorkerPort;override?:Partial<MediaServiceConfig>}={}) {
 let analyses=0,vadCalls=0,opens=0;
 const errors:unknown[]=[];
 const detector:VadStreamFactory={open:async()=>{opens++;let samples=0;return {model:{id:'controlled',version:'fixture',device:'cpu',native_metadata:{onnx_sha256:digest('fixture')}},
  write:async bytes=>{const start=samples;samples+=bytes.length/2;return [{processed_samples:samples,input_sha256:sha256(bytes),start},{processed_samples:samples,input_sha256:sha256(bytes),end:samples}];},
  finish:async()=>({processed_samples:samples,uninferred_samples:0,input_sha256:digest('fixture')}),close:async()=>{}};}};
 const worker:WorkerPort={analyze:async(request,signal)=>{analyses++;return (options.worker??defaultWorker).analyze(request,signal);}};
 const f=await mediaFixture(t,worker,{vad:{candidates:async request=>{vadCalls++;return [{start_ms:request.time_range.kind==='interval'?request.time_range.start_ms:0,
  end_ms:request.time_range.kind==='interval'?request.time_range.end_ms:0,semantic_status:'open',basis:'controlled'}];}},
  ...(options.continuous?{continuous:{detector,budget:{max_streams:2,max_pending_chunks:4,max_pending_candidates:8,max_chunk_bytes:10000,block_samples:8000,overlap_samples:1600},onError:error=>errors.push(error)}}:{}),...options.override});
 let creates=0;const native:NativeClient={create:async(body,key)=>{creates++;return {run_id:`run-${key}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'completed'};},
  status:async id=>({run_id:id,session_id:'session',conversation_session_id:'session',status:'completed'}),cancel:async id=>({run_id:id,session_id:'session',conversation_session_id:'session',status:'cancelled'})};
 const admission=new RunAdmission(f.storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'controlled'});
 let policy:AudioRoute={...route,consumer:options.consumer??'media'};
 const runtime=new PersonalAIOSRuntime({storage:f.storage,archive:f.archive,admission,native,output:new OutputAuthority(f.storage),media:f.service,
  devices:[{...trusted,route_version:'route',output_modes:['text'],token_sha256:sha256('token')}],skill:'controlled',max_read_bytes:100000,
  audio_route:async()=>policy,...(options.continuous?{continuous_context:async()=>({session:'session',clock_maps:[maps[0]!]}),ambient_journal:await testJournal(t)}:{})});
 f.setCleanup(()=>runtime.close());t.after(()=>runtime.close());const device=await runtime.authenticate('token');
 const append=(seq=0)=>runtime.appendMedia(raw(),device,chunk(seq));
 const process=(event:{raw_ref:string;archive_revision:string},operation='op',revision?:number)=>runtime.processMedia(device,'session',operation,
  {...event,time_range:window,clock_maps:[maps[0]!],...(revision?{revision}: {})});
 return {...f,runtime,device,native,append,process,errors,policy:(value:AudioRoute)=>{policy=value;},analyses:()=>analyses,vadCalls:()=>vadCalls,opens:()=>opens,creates:()=>creates};
}
async function until(run:()=>boolean){for(let i=0;i<100;i++){if(run())return;await new Promise(r=>setTimeout(r,5));}assert.fail('did not settle');}
test('one finite consumer pins original D across cumulative revisions and duplicate native admission',async t=>{
 const f=await fixture(t);const first=await f.append();const a=await f.process(first.event);await until(()=>f.creates()===1);
 const next=await f.append(1);const b=await f.process(next.event,'later-op');
 assert.deepEqual(b.processed_events,a.processed_events);assert.equal(b.processed_events[0]!.archive_revision,first.event.archive_revision);
 assert.equal(f.analyses(),1);assert.equal(f.vadCalls(),1);assert.equal(f.creates(),1);
 assert.equal(b.processed_events[0]!.user_identity,'unknown');assert.equal(b.processed_events[0]!.intent_class,'observation');
 assert.equal(await f.archive.validateEvidence(b.processed_events[0]!),true);
});
test('voice missing and audit_only archive original but cannot bypass through finite or direct service',async t=>{
 for(const consumer of ['voice','audit_only'] as const){const f=await fixture(t,{consumer});const a=await f.append();
  assert.equal(a.event.archive_status,'durable');assert.equal(a.processing_admission!.status,consumer==='voice'?'failed':'skipped');
  await assert.rejects(f.process(a.event),consumer==='voice'?/VOICE_CONSUMER_NOT_CONFIGURED/:/AUDIO_AUDIT_ONLY/);
  await assert.rejects(f.service.process('owner',{...a.event,time_range:window,clock_maps:[maps[0]!]}),consumer==='voice'?/VOICE_CONSUMER_NOT_CONFIGURED/:/AUDIO_AUDIT_ONLY/);
  assert.equal(f.analyses(),0);assert.equal(f.vadCalls(),0);assert.equal(f.creates(),0);
 }
});
test('fixed capture span rejects route changes after archive; durable watermark remains visible',async t=>{
 const f=await fixture(t,{continuous:true});const a=await f.append();await f.runtime.continuousMedia().drain();
 f.policy({...route,consumer:'voice'});const b=await f.append(1);
 assert.equal(b.processing_admission!.error_code,'AUDIO_ROUTE_CONFLICT');assert.equal(b.event.archive_status,'durable');
 assert.equal((await materialized(f.storage,b)).chunks.length,2);assert.equal(f.analyses(),1);
 await assert.rejects(f.process(a.event),/AUDIO_ROUTE_CONFLICT|LANE_CONFLICT/);
});
test('continuous reset of consumed chunk is duplicate; candidate retry replays original D without worker',async t=>{
 const f=await fixture(t,{continuous:true});const a=await f.append();assert.equal(a.processing_admission?.status,'queued');
 await f.runtime.continuousMedia().drain();const candidates=await f.storage.list('media-continuous-candidates');assert.equal(candidates.length,1);
 await f.runtime.continuousMedia().retry(`l5-continuous:${candidates[0]}`);await f.runtime.continuousMedia().drain();
 const reset=await f.runtime.resetContinuousMedia(f.device,a.event,chunk());assert.equal(reset.status,'duplicate');
 assert.equal(f.analyses(),1);assert.equal(f.opens(),1);assert.deepEqual(f.errors,[]);
});
test('accepted worker failure is unknown and never re-executed by retry or finite bypass',async t=>{
 const f=await fixture(t,{continuous:true,worker:{analyze:async()=>{throw new Error('PROVIDER_RESPONSE_UNKNOWN');}}});const a=await f.append();
 await f.runtime.continuousMedia().drain();const candidates=await f.storage.list('media-continuous-candidates');
 await f.runtime.continuousMedia().retry(`l5-continuous:${candidates[0]}`);await f.runtime.continuousMedia().drain();
 assert.equal(f.analyses(),1);assert.ok(f.errors.some(error=>String(error).includes('ACCEPTANCE_UNKNOWN')));
 await assert.rejects(f.process(a.event),/AUDIO_ROUTE_CONFLICT|LANE_CONFLICT/);assert.equal(f.creates(),0);
});
test('explicit preacceptance resource rejection retains legal same-consumer retry',async t=>{
 const f=await fixture(t);delete f.config.vad;const a=await f.append();await assert.rejects(f.process(a.event),/MEDIA_VAD_NOT_CONFIGURED/);
 assert.equal((await f.storage.list('audio-consumer-not-accepted')).length,1);f.config.vad=vad;
 const result=await f.process(a.event,'retry');assert.equal(result.processed_events.length,1);assert.equal(f.analyses(),1);
 assert.equal((await f.storage.list('audio-consumer-attempts')).length,2);
});
test('restart with shared storage returns exact prior outcome; interruption is unknown',async t=>{
 const f=await fixture(t);const a=await f.append();const result=await f.process(a.event);
 const {alignSegment}=await import('../src/media/align.ts');const aligned=await alignSegment(a.event,(await materialized(f.storage,a)),window,'source_window',[maps[0]!],f.storage,f.config.align);
 const prepared=await f.processor.prepareRequest(aligned.segment,aligned.views),restarted=new AudioConsumption(f.storage,100000);let calls=0;
 const replay=await restarted.consume(a.event,prepared,'finite',async()=>{calls++;return result;},r=>r.processed_events);
 assert.equal(calls,0);assert.deepEqual(replay.processed_events,result.processed_events);assert.equal(replay.archive_revision,result.archive_revision);
});
test('close aborts and joins worker; stopped input cannot create late D or cancel unrelated playback/run',async t=>{
 const entered=Promise.withResolvers<void>(),joined=Promise.withResolvers<void>();
 const f=await fixture(t,{worker:{analyze:async(_request,signal)=>{entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  await joined.promise;throw new Error('CONTROLLED_ABORT_JOIN');}}});
 const a=await f.append();const work=f.process(a.event).catch(error=>error);await entered.promise;
 let closed=false;const close=f.runtime.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);
 joined.resolve();await close;assert.match(String(await work),/CANCELLED/);assert.equal(f.creates(),0);
 await assert.rejects(f.append(1),/RUNTIME_CLOSED/);assert.deepEqual(await f.storage.list('processed-events'),[]);
});
test('conflicting source bytes on the same authorized capture interval reject before a second consumer',async t=>{
 const f=await fixture(t);const a=await f.append();await f.process(a.event);
 const other=await f.runtime.appendMedia({...raw(),event_id:'other',payload:Buffer.alloc(pcm.length,9)},f.device,chunk());
 await assert.rejects(f.process(other.event,'conflict'),/AUDIO_CONSUMPTION_CONFLICT/);
 assert.equal(f.analyses(),1);assert.equal(f.vadCalls(),1);
});
test('parallel callers share immutable ownership; loser is unknown until original result is durable',async t=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const f=await fixture(t,{worker:{analyze:async(request,signal)=>{entered.resolve();await release.promise;return defaultWorker.analyze(request,signal);}}});
 const a=await f.append();const first=f.process(a.event,'first');await entered.promise;
 await assert.rejects(f.process(a.event,'second'),/AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN/);release.resolve();const result=await first;
 const replay=await f.process(a.event,'third');assert.deepEqual(replay.processed_events,result.processed_events);assert.equal(f.analyses(),1);
});
test('route EIO after L5 preserves exact durable original and prevents processing',async t=>{
 const f=await fixture(t);const publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='audio-consumer-spans')throw Object.assign(new Error('ROUTE_EIO'),{code:'EIO'});return publish(namespace,key,bytes);};
 const a=await f.append();assert.equal(a.event.archive_status,'durable');assert.equal(a.processing_admission?.status,'failed');assert.equal(a.processing_receipt_ref,null);
 assert.equal((await f.archive.readRecord(a.event.raw_ref,'owner',a.event.archive_revision)).kind,'stream');assert.equal(f.analyses(),0);
});
test('accepted receipt EIO starts no VAD/worker and pins unknown rather than guessing unsent',async t=>{
 const f=await fixture(t);const a=await f.append(),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='audio-consumer-accepted')throw Object.assign(new Error('ACCEPT_EIO'),{code:'EIO'});return publish(namespace,key,bytes);};
 await assert.rejects(f.process(a.event),/ACCEPT_EIO/);f.storage.publish=publish;
 await assert.rejects(f.process(a.event,'retry'),/AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN/);assert.equal(f.analyses(),0);assert.equal(f.vadCalls(),0);
 assert.equal(f.creates(),0);
});
test('final receipt EIO cannot produce run; original worker D cannot bypass centralized admission',async t=>{
 const f=await fixture(t);const a=await f.append(),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='audio-consumer-results')throw Object.assign(new Error('RESULT_EIO'),{code:'EIO'});return publish(namespace,key,bytes);};
 await assert.rejects(f.process(a.event),/RESULT_EIO/);assert.equal(f.analyses(),1);assert.equal(f.creates(),0);
 const keys=await f.storage.list('processed-media'),d=JSON.parse(Buffer.from(await f.storage.read('processed-media',keys[0]!)).toString());
 const owner=f.runtime as unknown as {admitProcessed(d:ProcessedEvent,device:typeof f.device,session:string):Promise<unknown>};
 await assert.rejects(owner.admitProcessed(d,f.device,'session'),/AUDIO_D_CONSUMPTION_REQUIRED/);
 f.storage.publish=publish;await assert.rejects(f.process(a.event,'retry'),/AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN/);assert.equal(f.analyses(),1);
});
test('D binding EIO resumes finalized result without a fresh worker',async t=>{
 const f=await fixture(t);const a=await f.append(),publish=f.storage.publish.bind(f.storage);let fail=true;
 f.storage.publish=async(namespace,key,bytes)=>{if(fail&&namespace==='audio-consumer-d')throw new Error('D_BIND_EIO');return publish(namespace,key,bytes);};
 await assert.rejects(f.process(a.event),/D_BIND_EIO/);assert.equal(f.creates(),0);fail=false;
 const result=await f.process(a.event,'retry');assert.equal(result.processed_events.length,1);assert.equal(f.analyses(),1);await until(()=>f.creates()===1);
});
test('restarted unknown owner cannot start a second worker from the same B selection',async t=>{
 const f=await fixture(t,{worker:{analyze:async()=>{throw new Error('REMOTE_UNKNOWN');}}});const a=await f.append();await assert.rejects(f.process(a.event),/ALL_MEDIA_WORKERS_FAILED/);
 const {alignSegment}=await import('../src/media/align.ts');const aligned=await alignSegment(a.event,(await materialized(f.storage,a)),window,'source_window',[maps[0]!],f.storage,f.config.align);
 const prepared=await f.processor.prepareRequest(aligned.segment,aligned.views),restarted=new AudioConsumption(f.storage,100000);let calls=0;
 await assert.rejects(restarted.consume(a.event,prepared,'finite',async()=>{calls++;return [];},result=>result),/AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN/);
 assert.equal(calls,0);assert.equal(f.analyses(),1);
});

test('new actual Runtime/MEDIA constructor reloads durable selection and original D/run',async t=>{
 const f=await fixture(t);const a=await f.append();const first=await f.process(a.event);await until(()=>f.creates()===1);await f.runtime.close();
 let restartedWorkers=0;const processor=new MediaProcessor(f.storage,new Map([['controlled',{analyze:async()=>{restartedWorkers++;throw new Error('MUST_REPLAY');}}]]),f.processor.config);
 const archive=new RawArchive(f.storage,10000,undefined,f.budget);
 const service=new MediaService({...f.config,archive,streamArchive:archive.streams,processor});const admission=new RunAdmission(f.storage,f.native,{max_pending_events:8,max_pending_bytes:100000,
  max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'controlled'});
 const runtime=new PersonalAIOSRuntime({storage:f.storage,archive,admission,native:f.native,output:new OutputAuthority(f.storage),media:service,
  devices:[{...trusted,route_version:'route',output_modes:['text'],token_sha256:sha256('token')}],skill:'controlled',max_read_bytes:100000,audio_route:async()=>route});
 t.after(()=>runtime.close());const device=await runtime.authenticate('token');
 const second=await runtime.processMedia(device,'session','restarted',{...a.event,time_range:window,clock_maps:[maps[0]!]});
 assert.deepEqual(second.processed_events,first.processed_events);assert.equal(restartedWorkers,0);assert.equal(f.creates(),1);await runtime.close();
});
test('preacceptance failure plus receipt EIO preserves both causes and cannot reopen unknown ownership',async t=>{
 const f=await fixture(t);delete f.config.vad;const a=await f.append(),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='audio-consumer-not-accepted')throw new Error('REJECTION_RECEIPT_EIO');return publish(namespace,key,bytes);};
 const failure=await f.process(a.event).catch(error=>error);assert.ok(failure instanceof AudioConsumptionUnknownError);assert.match(String(failure.cause),/MEDIA_VAD_NOT_CONFIGURED/);
 assert.match(String(failure.errors[1]),/REJECTION_RECEIPT_EIO/);f.storage.publish=publish;f.config.vad=vad;
 await assert.rejects(f.process(a.event,'retry'),/AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN/);assert.equal(f.analyses(),0);
});

import {createPersonalAIOSAssembly} from '../src/assembly.ts';
test('existing production assembly passes trusted audio route to its same Runtime without another owner',async t=>{
 const f=await mediaFixture(t);const native:NativeClient={create:async()=>{throw new Error('NO_RUN');},status:async()=>{throw new Error('NO_RUN');},cancel:async()=>{throw new Error('NO_RUN');}};
 const assembly=createPersonalAIOSAssembly({storage:f.storage,archive:f.archive,native:sourceClient(native),media:f.service,
  devices:[{...trusted,route_version:'route',output_modes:['text'],token_sha256:sha256('token')}],skill:'controlled',max_event_bytes:10000,max_read_bytes:100000,
  audio_route:async()=>({...route,consumer:'audit_only'}),admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'controlled'},
  http:{internal_token:'controlled-assembly-internal-key',max_request_bytes:100000,request_timeout_ms:1000}});
 f.setCleanup(()=>assembly.close());t.after(()=>assembly.close());const device=await assembly.runtime.authenticate('token');
 const a=await assembly.runtime.appendMedia(raw(),device,chunk());assert.equal(a.processing_admission?.status,'skipped');
 await assert.rejects(assembly.runtime.processMedia(device,'session','op',{...a.event,time_range:window,clock_maps:[maps[0]!]}),/AUDIO_AUDIT_ONLY/);
 await assembly.close();
});
test('capture exhaustion for voice/audit does not start MEDIA or assert semantic end/run/playback stop',async t=>{
 for(const consumer of ['voice','audit_only'] as const){const f=await fixture(t,{consumer,continuous:true});const a=await f.append();
  const finished=await f.runtime.finishContinuousMedia(a.event,chunk());assert.deepEqual(finished,{status:'not_finished',reason:`consumer_${consumer}`});
  assert.equal(f.opens(),0);assert.equal(f.analyses(),0);assert.equal(f.creates(),0);
 }
});

test('same hash on adjacent exact sample ranges is new MEDIA input rather than hash-only dedup',async t=>{
 const f=await fixture(t);const a=await f.append();await f.process(a.event);const b=await f.append(1);
 const result=await f.runtime.processMedia(f.device,'session','next-window',{...b.event,
  time_range:{...window,start_ms:100,end_ms:200},clock_maps:[maps[0]!]});
 assert.equal(result.processed_events.length,1);assert.equal(f.analyses(),2);assert.equal(f.vadCalls(),2);await until(()=>f.creates()===2);
});
test('cumulative revision with duplicate source sample support cannot inflate a fresh selection',async t=>{
 const f=await fixture(t);const a=await f.append();await f.process(a.event);
 const b=await f.runtime.appendMedia(raw(),f.device,{...chunk(),seq:1});assert.equal((await materialized(f.storage,b)).chunks.length,2);
 await assert.rejects(f.process(b.event,'duplicate-support'),/AUDIO_SOURCE_SAMPLE_OVERLAP/);assert.equal(f.analyses(),1);
});
test('audio admission binds exact original MEDIA D, not an altered body carrying its original id',async t=>{
 const f=await fixture(t);const a=await f.append();const result=await f.process(a.event),d=structuredClone(result.processed_events[0]!);
 d.content.audio_observations=['FORGED'];const owner=f.runtime as unknown as {admitProcessed(d:ProcessedEvent,device:typeof f.device,session:string):Promise<unknown>};
 await assert.rejects(owner.admitProcessed(d,f.device,'session'),/AUDIO_FINAL_D_INTEGRITY/);await until(()=>f.creates()===1);
});
test('peer counterexample: reordered authorized audio maps create second consumption of same sample set',async t=>{
 const f=await fixture(t);await f.append();
 const b=await f.runtime.appendMedia(raw(),f.device,{...chunk(),track_id:'second-audio-track'});
 const map2={...maps[0]!,track_id:'second-audio-track'};
 const req={...b.event,time_range:window,clock_maps:[maps[0]!,map2]};
 const first=await f.runtime.processMedia(f.device,'session','two-track-first',req);
 const second=await f.runtime.processMedia(f.device,'session','two-track-second',{...req,clock_maps:[map2,maps[0]!]});
 assert.deepEqual(second.processed_events,first.processed_events);
 assert.equal(f.analyses(),1);assert.equal(f.vadCalls(),1);
 assert.equal((await f.storage.list('audio-consumer-results')).length,1);
 assert.equal((await f.storage.list('audio-consumer-accepted')).length,1);
 await until(()=>f.creates()===1);
});

test('peer counterexample: accepted final publication EIO is labeled retryable although work cannot rerun',async t=>{
 const f=await fixture(t,{continuous:true}),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{
  if(namespace==='audio-consumer-results'&&JSON.parse(Buffer.from(bytes).toString()).result?.pins)throw new Error('PEER_FINAL_RESULT_EIO');
  return publish(namespace,key,bytes);
 };
 await f.append();await f.runtime.continuousMedia().drain();
 const attempts=await f.storage.list('media-continuous-attempts');assert.equal(attempts.length,1);
 const receipt=JSON.parse(Buffer.from(await f.storage.read('media-continuous-attempts',attempts[0]!)).toString());
 assert.equal(receipt.state,'unknown');assert.equal(f.analyses(),1);assert.equal(f.creates(),0);
 f.storage.publish=publish;
 const candidates=await f.storage.list('media-continuous-candidates');
 await f.runtime.continuousMedia().retry(`l5-continuous:${candidates[0]}`);await f.runtime.continuousMedia().drain();
 assert.equal(f.analyses(),1);assert.equal(f.creates(),0);
 assert.ok(f.errors.some(error=>String(error).includes('ACCEPTANCE_UNKNOWN')));
});

test('paired canonical ranges preserve different track PCM and reject changed PCM before VAD',async t=>{
 const f=await fixture(t);await f.append();
 const other=Buffer.alloc(pcm.length,7),map2={...maps[0]!,track_id:'second-audio-track'};
 const b=await f.runtime.appendMedia({...raw(),payload:other},f.device,{...chunk(),track_id:map2.track_id});
 const req={...b.event,time_range:window,clock_maps:[maps[0]!,map2]};
 const first=await f.runtime.processMedia(f.device,'session','paired-first',req);
 const replay=await f.runtime.processMedia(f.device,'session','paired-reversed',{...req,clock_maps:[map2,maps[0]!]});
 assert.deepEqual(replay.processed_events,first.processed_events);
 await f.runtime.appendMedia({...raw(),event_id:'changed-source'},f.device,chunk());
 const changed=await f.runtime.appendMedia({...raw(),event_id:'changed-source',payload:Buffer.alloc(pcm.length,8)},f.device,{...chunk(),track_id:map2.track_id});
 await assert.rejects(f.runtime.processMedia(f.device,'session','paired-conflict',{...changed.event,time_range:window,clock_maps:[map2,maps[0]!]}),/AUDIO_CONSUMPTION_CONFLICT/);
 assert.equal(f.analyses(),1);assert.equal(f.vadCalls(),1);await until(()=>f.creates()===1);
});

test('confirmed final publication with lost response retains IO cause and retries only D linkage',async t=>{
 const f=await fixture(t,{continuous:true}),publish=f.storage.publish.bind(f.storage);let fail=true;
 // This scenario controls publication failure, independently of wall-clock worker expiry during durable I/O.
 t.mock.timers.enable({apis:['setTimeout']});
 f.storage.publish=async(namespace,key,bytes)=>{
  const saved=await publish(namespace,key,bytes);
  if(fail&&namespace==='audio-consumer-results'&&JSON.parse(Buffer.from(bytes).toString()).result?.pins)throw new Error('FINAL_RESPONSE_EIO');
  return saved;
 };
 await f.append();await f.runtime.continuousMedia().drain();
 const attempts=await f.storage.list('media-continuous-attempts');
 const receipt=JSON.parse(Buffer.from(await f.storage.read('media-continuous-attempts',attempts[0]!)).toString());
 assert.equal(receipt.state,'retryable');assert.match(String(f.errors[0]),/FINAL_RESPONSE_EIO/);
 assert.equal(f.analyses(),1);assert.equal(f.creates(),0);assert.equal((await f.storage.list('audio-consumer-d')).length,0);
 fail=false;const candidates=await f.storage.list('media-continuous-candidates');
 await f.runtime.continuousMedia().retry(`l5-continuous:${candidates[0]}`);await f.runtime.continuousMedia().drain();
 // The retried continuous D is ambient: linked and journaled, never a run.
 assert.equal(f.analyses(),1);assert.equal((await f.storage.list('media-continuous-admitted')).length,1);assert.equal(f.creates(),0);
 assert.equal((await f.storage.list('audio-consumer-d')).length,1);
 assert.equal((await f.storage.list('audio-consumer-accepted')).length,2); // Original chunk + one candidate acceptance.
});

test('unconfirmed final readback retains publication and secondary IO causes without a new consumer',async t=>{
 const f=await fixture(t),publish=f.storage.publish.bind(f.storage),read=f.storage.read.bind(f.storage);const a=await f.append();let failed=false;
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='audio-consumer-results'){failed=true;throw new Error('FINAL_WRITE_EIO');}return publish(namespace,key,bytes);};
 f.storage.read=async(namespace,key)=>{if(failed&&namespace==='audio-consumer-results')throw new Error('FINAL_READ_EIO');return read(namespace,key);};
 const error=await f.process(a.event).catch(error=>error);assert.ok(error instanceof AudioConsumptionUnknownError);
 assert.match(String(error.cause),/FINAL_WRITE_EIO/);assert.match(String(error.errors[1]),/FINAL_READ_EIO/);
 f.storage.publish=publish;f.storage.read=read;await assert.rejects(f.process(a.event,'no-reconsume'),/AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN/);
 assert.equal(f.analyses(),1);assert.equal(f.creates(),0);
});

test('presence of a different final fact is not confirmation of the generated outcome',async t=>{
 const f=await fixture(t),publish=f.storage.publish.bind(f.storage),read=f.storage.read.bind(f.storage);const a=await f.append();let failed=false;
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='audio-consumer-results'){failed=true;throw new Error('FINAL_WRITE_EIO');}return publish(namespace,key,bytes);};
 f.storage.read=async(namespace,key)=>{if(failed&&namespace==='audio-consumer-results')return Buffer.from(JSON.stringify({key,result:{metadata:null,pins:[]},processed_event_ids:[]}));return read(namespace,key);};
 const error=await f.process(a.event).catch(error=>error);assert.ok(error instanceof AudioConsumptionUnknownError);assert.match(String(error.cause),/FINAL_WRITE_EIO/);
 f.storage.publish=publish;f.storage.read=read;assert.equal(f.analyses(),1);assert.equal(f.creates(),0);
});
