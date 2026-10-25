import {committedCount} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive,type TrackChunk} from '../src/stream-archive.ts';
import {MediaService} from '../src/media/service.ts';
import {MediaCancelledWithoutEffectError,MediaProcessor,type WorkerPort,type Capability} from '../src/media/processing.ts';
import {AudioConsumption} from '../src/media/audio-consumption.ts';
import {ContinuousMediaSource} from '../src/media/continuous-source.ts';
import {SherpaSileroStreamFactory,type VadStreamFactory} from '../src/media/silero-stream.ts';
import {LocalSpeechEngine} from '../src/voiceprint/engine.ts';
import {controlledDetector,realModelsPresent,realSpeechConfig,sayPresent,silence,synthesize,testJournal,VOICE_A,VOICE_B} from './speech-fixture.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
import {digest,sha256,type RawEvent,type ProcessedEvent,type ArchivedEvent} from '../src/contracts.ts';
import type {NativeClient,NativeRun} from './native-source-fixture.ts';
import type {ContinuousBudget,ContinuousCandidate} from '../src/media/continuous-source.ts';
const evidenceRoot=process.env.MEDIA_CONTINUOUS_EVIDENCE_ROOT;
class ControlledNative implements NativeClient {
  calls=0;readonly runs=new Map<string,NativeRun>();
  async create(body:{input:string;instructions:string;session_id:string},key:string){this.calls++;assert(!this.runs.has(key));
    const run={run_id:`controlled-run-${this.calls}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
    this.runs.set(key,run);return {...run};}
  async status(id:string){const run=[...this.runs.values()].find(r=>r.run_id===id);assert(run);return {...run};}
  async cancel(id:string){return this.status(id);}
  finish(){for(const run of this.runs.values())run.status='completed';}
}
const defaultBudget:ContinuousBudget={max_streams:2,max_pending_chunks:8,max_pending_candidates:16,max_chunk_bytes:1000000,
  block_samples:160000,overlap_samples:8000};
async function until(predicate:()=>boolean|Promise<boolean>){for(let n=0;n<500;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition did not settle');}
// Continuous D are ambient speech: journaled, never a run (wake turns: ambient-lane tests). `transcript`: the controlled
// worker reports text for every candidate, so each D is a journal entry.
const T0=1_760_000_000_000;
async function fixture(t:test.TestContext,options:{worker?:WorkerPort;workerTimeout?:number;budget?:Partial<ContinuousBudget>;pending?:number;context?:'missing';hang?:boolean;detector?:VadStreamFactory;contextWait?:Promise<void>;interval?:boolean;transcript?:boolean;realtimeBusy?:()=>boolean;callOwned?:(range:{start_ms:number;end_ms:number})=>boolean}={}) {
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-continuous-'));
  let runtime:PersonalAIOSRuntime|undefined;
  t.after(async()=>{await runtime?.close();
    if(evidenceRoot){await fs.mkdir(evidenceRoot,{recursive:true});await fs.cp(directory,join(evidenceRoot,basename(directory)),{recursive:true});}
    await fs.rm(directory,{recursive:true,force:true});});
  const storage=new PosixStorage(join(directory,'storage'));
  const archiveBudget={max_chunk_bytes:1000000,max_total_bytes:3000000,max_chunks:100,max_revisions:100,max_seq:100};
  const archive=new RawArchive(storage,1000000,undefined,archiveBudget),streamArchive=new StreamArchive(storage,archiveBudget);
  // Controlled marker detector in place of the engine's Silero; a hanging one never answers a write.
  const controlled=controlledDetector(options.hang?{write:()=>new Promise<void>(()=>{})}:{}),detector=options.detector??controlled;
  let analyses=0;const errors:{error:unknown;ref?:string}[]=[];
  const worker:WorkerPort={...(options.worker?.effects?{effects:options.worker.effects}:{}),analyze:async(request,signal)=>{analyses++;
    return options.worker?options.worker.analyze(request,signal):{
    event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
    content:{...(options.transcript&&!request.sound_only?{transcript:'CONTROLLED TEXT, NOT ASR'}:{}),audio_observations:['CONTROLLED_BYTE_WORKER']},speakers:[],warnings:['CONTROLLED_NOT_MODEL'],status:'partial'};}};
  const capability:Capability={id:'controlled',version:'fixture',modalities:['audio'],formats:['pcm_s16le:16000:1'],joint_av:false,
    healthy:true,permitted:true,max_duration_ms:10000,execution:'local',evidence:'deterministic_replay'};
  const processor=new MediaProcessor(storage,new Map([['controlled',worker]]),{policy_version:'continuous-test',max_inflight:1,
    max_input_bytes:1000000,timeout_ms:options.workerTimeout??10000,allow_external:false,allow_replay:true,allow_partial:true});
  const service=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[capability],
    align:{max_chunks:100,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:16,max_window_ms:10000,
    fixtureOnly:true,clockEvidence:'synthetic',
    continuous:{detector,budget:{...defaultBudget,...options.budget},onError:(error,ref)=>errors.push({error,...(ref?{ref}:{})})}});
  const native=new ControlledNative();
  const admission=new RunAdmission(storage,native,{max_pending_events:options.pending??16,max_pending_bytes:1000000,
    max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'controlled'});
  const deviceRecord={principal_id:'owner',device_id:'mac',device_type:'mac' as const,consent_ref:'fixture',channel:'controlled',
    route_version:'fixture',output_modes:['text'],token_sha256:sha256('token')};
  const journal=await testJournal(t);
  runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),media:service,ambient_journal:journal,
    ...(options.interval?{audio_route:async()=>({consumer:'media' as const,source_scope:'mac',capture_span:'interval-fixture',purpose_evidence_ref:'fixture',input_contract:'interval_v2' as const})}:{}),
    ...(options.realtimeBusy?{realtime_busy:options.realtimeBusy}:{}),...(options.callOwned?{call_heard:(_principal,_device,range)=>options.callOwned!(range)}:{}),
    devices:[deviceRecord],skill:'controlled',max_read_bytes:1000000,continuous_context:async(_source,_event,chunk)=>{
      if(options.contextWait)await options.contextWait;
      if(options.context==='missing')throw new Error('CLOCK_MAP_REQUIRED');return {session:'same-continuity',clock_maps:[{modality:'audio',track_id:chunk.track_id,
        stream_epoch:chunk.stream_epoch,source_timebase_id:'samples',target_timebase_id:'utc_epoch_ms',offset_ms:T0,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]};}});
  const device=await runtime.authenticate('token');
  const ownedRuntime=runtime;
  const raw=(payload:Buffer):RawEvent=>({schema_version:'paios.event.v1',event_id:'raw',device_id:'mac',device_type:'mac',
    captured_at:'2026-10-02T00:00:00.000Z',source:{channel:'controlled'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload});
  const append=(payload:Buffer,seq:number,start:number,reset=false)=>{const chunk:TrackChunk={track_id:'mic',stream_epoch:'source-epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'source-epoch',start_ms:start/16,end_ms:(start+payload.length/2)/16}};
    return ownedRuntime.appendMedia(raw(payload),device,chunk,undefined,reset?{onDurable:()=>{},beforeConsume:Promise.resolve(),resetConsume:true}:undefined);};
  const records=async<T>(namespace:string):Promise<T[]>=>Promise.all((await storage.list(namespace)).map(async key=>JSON.parse(Buffer.from(await storage.read(namespace,key)).toString())));
  return {directory,storage,archive,service,runtime:ownedRuntime,device,native,admission,append,errors,records,detector,vad:controlled.vad,raw,journal,analyses:()=>analyses};
}
const marker=(samples:number,speech:boolean)=>{const pcm=Buffer.alloc(samples*2);if(speech)for(let n=0;n<samples;n++)pcm.writeInt16LE(1,n*2);return pcm;};
test('fixture media durable callbacks follow stored single/batch commits and never acknowledge failed writes',async t=>{
  const f=await fixture(t),trusted={...f.device,submission:'observation' as const};
  let acknowledged=0;const checks:Promise<void>[]=[];
  const durable=()=>{acknowledged++;checks.push(f.storage.list('stream-revisions').then(keys=>{assert.ok(keys.length>0);}));};
  const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'durable-test',seq,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'durable-test',start_ms:seq*32,end_ms:(seq+1)*32}});
  const raw=f.raw(Buffer.alloc(1024));
  assert.equal((await f.service.append(raw,trusted,chunk(0),undefined,durable)).event.archive_status,'durable');
  assert.equal(acknowledged,1);
  await assert.rejects(f.service.append({...raw,payload:Buffer.alloc(1024,1)},trusted,chunk(0),undefined,durable));assert.equal(acknowledged,1);
  const inputs=[1,2].map(seq=>({raw,chunk:chunk(seq)}));
  assert.equal((await f.service.appendBatch(inputs,trusted,{max_chunks:2,max_bytes:2048},undefined,durable)).length,2);assert.equal(acknowledged,2);
  await assert.rejects(f.service.appendBatch(inputs,trusted,{max_chunks:1,max_bytes:2048},undefined,durable));assert.equal(acknowledged,2);
  await Promise.all(checks);
});
test('two acoustic pauses cross irregular acquisition blocks; each pinned open C becomes a journaled ambient D, never a run',async t=>{
  const f=await fixture(t,{transcript:true});const input=Buffer.concat([marker(2048,true),marker(1024,false),marker(1536,true),marker(1024,false)]);
  let at=0,seq=0;for(const width of [100,320,480,753,1,1024,2048,906]){const end=Math.min(input.length/2,at+width);
    if(end>at)await f.append(input.subarray(at*2,end*2),seq++,at);at=end;}
  if(at<input.length/2)await f.append(input.subarray(at*2),seq,at);
  await f.runtime.continuousMedia().drain();assert.deepEqual(f.errors,[]);
  const c=await f.records<ContinuousCandidate>('media-continuous-candidates');assert.equal(c.length,2);
  assert(c.every(x=>x.semantic_status==='open'&&x.reason==='acoustic_pause'));
  const d=await f.records<ProcessedEvent>('processed-media');assert.equal(d.length,2);assert(d.every(x=>x.origin==='device_observation'&&x.user_identity==='unknown'));
  assert(d.every(x=>x.continuation!.basis_refs.some(r=>r.startsWith('l5-vad:'))&&x.continuation!.basis_refs.some(r=>r.startsWith('l5-continuous:'))));
  const entries=f.journal.search({principal_id:'owner',limit:10}).entries;
  assert.deepEqual(entries.map(e=>e.processed_event_id).sort(),d.map(x=>x.processed_event_id).sort());
  assert.equal((await f.storage.list('media-continuous-admitted')).length,2);assert.equal(f.native.calls,0);assert.equal(f.analyses(),2);
});
test('long utterance resource blocks overlap only consumers and never exceed real 10s ASR budget',async t=>{
  const f=await fixture(t);await f.append(marker(352256,true),0,0);await f.runtime.continuousMedia().drain();
  const progress=await f.records<{detection_epoch:string;inferred_sample_end:number}>('media-source-progress');assert.equal(progress[0]!.inferred_sample_end,352256);
  const c=await f.records<ContinuousCandidate>('media-continuous-candidates');assert.equal(c.length,2);
  c.sort((a,b)=>a.start_sample-b.start_sample);assert.deepEqual(c.map(x=>[x.start_sample,x.end_sample_exclusive,x.reason]),[[0,160000,'resource_limit'],[152000,312000,'resource_limit']]);
  const key=c[0]!.stream_key;await f.runtime.continuousMedia().finish(key);await f.runtime.continuousMedia().drain();
  const all=await f.records<ContinuousCandidate>('media-continuous-candidates');assert.equal(all.length,3);assert(all.every(x=>x.end_sample_exclusive-x.start_sample<=160000));
  assert(all.find(x=>x.reason==='input_exhausted')?.semantic_status==='open');assert.equal(f.analyses(),3);assert.deepEqual(f.errors,[]);
});
test('slow analysis does not block subsequent raw archive or detector progress',async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const f=await fixture(t,{worker:{analyze:async(request,signal)=>{entered.resolve();await release.promise;
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{audio_observations:['SLOW_CONTROLLED']},speakers:[],warnings:['CONTROLLED'],status:'partial'};}}});
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);await entered.promise;
  const next=await f.append(marker(2048,true),1,1536);assert.equal((await f.archive.readRecord(next.event.raw_ref,next.event.principal_id,next.event.archive_revision)).kind,'stream');assert.equal(next.event.bytes,7168);
  await until(async()=> (await f.storage.list('media-source-progress')).length===2);assert.equal(f.analyses(),1);
  release.resolve();await f.runtime.continuousMedia().drain();assert.deepEqual(f.errors,[]);
});
test('duplicate is explicit; reordering/gap remains durable and requires new partial detection epoch',async t=>{
  const f=await fixture(t);const a=await f.append(marker(1024,false),0,0);await f.runtime.continuousMedia().drain();
  await f.append(marker(1024,false),0,0);assert.equal((await f.storage.list('media-source-progress')).length,1);
  const gap=await f.append(marker(1024,true),2,4096);assert.equal(gap.processing_admission?.status,'failed');assert.match(gap.processing_admission?.error_code??'',/SEQUENCE_GAP_OR_REORDER/);
  const latest=(await f.archive.readRecord(a.event.raw_ref,'owner',(await f.service.append({schema_version:'paios.event.v1',event_id:'raw',device_id:'mac',device_type:'mac',captured_at:'2026-10-02T00:00:00.000Z',source:{channel:'controlled'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:marker(1024,true)},
    {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'controlled',submission:'observation'},
    {track_id:'mic',stream_epoch:'source-epoch',seq:2,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'source-epoch',start_ms:256,end_ms:320}})).event.archive_revision));
  assert.equal(latest.kind,'stream');assert.equal(latest.kind==='stream'?latest.manifest.chunks.length:0,2);
});
test('a failed sink keeps the pinned D; retry journals that same D once without a second analysis',async t=>{
  const f=await fixture(t,{transcript:true});const append=f.journal.append.bind(f.journal);let fail=true;
  f.journal.append=(source,utterances)=>{if(fail){fail=false;throw new Error('JOURNAL_EIO');}return append(source,utterances);};
  await f.append(Buffer.concat([marker(1024,true),marker(512,false),marker(1024,true),marker(512,false)]),0,0);
  await f.runtime.continuousMedia().drain();assert.equal(f.analyses(),2);
  const error=f.errors.find(e=>String(e.error).includes('JOURNAL_EIO'));assert(error?.ref);
  assert.equal(f.journal.search({principal_id:'owner',limit:10}).entries.length,1);
  const before=await f.records<ProcessedEvent>('processed-media');
  await f.runtime.continuousMedia().retry(error.ref);await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),2);assert.deepEqual(await f.records<ProcessedEvent>('processed-media'),before);
  assert.equal(f.journal.search({principal_id:'owner',limit:10}).entries.length,2);
  await f.runtime.continuousMedia().retry(error.ref);await f.runtime.continuousMedia().drain();
  assert.equal(f.journal.search({principal_id:'owner',limit:10}).entries.length,2,'a repeated retry journals nothing twice');assert.equal(f.native.calls,0);
});
test('missing trusted clock fails after durable append and forged device fails before publication',async t=>{
  const f=await fixture(t,{context:'missing'});const result=await f.append(marker(1024,true),0,0);assert.equal(result.event.archive_status,'durable');assert.equal(result.processing_admission?.status,'failed');assert.match(result.processing_admission?.error_code??'',/CLOCK_MAP_REQUIRED/);assert(result.processing_receipt_ref);
  assert.equal(await committedCount(f.storage),1);assert.equal((await f.storage.list('media-detection-epochs')).length,0);
  await assert.rejects(f.runtime.appendMedia({} as RawEvent,{...f.device},{track_id:'mic'} as TrackChunk),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  assert.equal(await committedCount(f.storage),1);
});
test('close cancels pending native detection and closes its detector; raw remains durable',async t=>{
  const f=await fixture(t,{hang:true});await f.append(marker(1024,true),0,0);
  await until(()=>f.vad.opened===1);await f.runtime.close();
  assert.equal(f.vad.closed,1);
  assert.equal(await committedCount(f.storage),1);assert.equal((await f.storage.list('processed-events')).length,0);
});

test('concurrent duplicate appends create one detection epoch and one verified progression',async t=>{
  const f=await fixture(t);await Promise.all([f.append(marker(4096,false),0,0),f.append(marker(4096,false),0,0)]);
  await f.runtime.continuousMedia().drain();assert.deepEqual(f.errors,[]);
  assert.equal((await f.storage.list('media-detection-epochs')).length,1);
  assert.equal((await f.storage.list('media-source-progress')).length,1);
});
test('durable candidate backpressure retains exact C and bounds explicit retries without failing detection',async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  t.after(()=>release.resolve());
  const f=await fixture(t,{budget:{max_pending_candidates:1},worker:{analyze:async(request)=>{
    entered.resolve();await release.promise;return {event_id:request.event_id,segment_id:request.segment_id,
      archive_revision:request.archive_revision,time_range:request.time_range,content:{audio_observations:['CONTROLLED']},speakers:[],warnings:[],status:'partial'};
  }}});
  await f.append(Buffer.concat([marker(1024,true),marker(512,false),marker(1024,true),marker(512,false)]),0,0);
  await entered.promise;await until(async()=>(await f.storage.list('media-continuous-candidates')).length===2);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,2);assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,1);
  assert.equal((await f.storage.list('media-source-failures')).length,0);
  const waiting=(await f.records<ContinuousCandidate>('media-continuous-candidates')).find(c=>c.start_sample>0)!;
  await assert.rejects(f.runtime.continuousMedia().retry(`l5-continuous:${digest(waiting)}`),/CONTINUOUS_CANDIDATE_BACKLOG/);
  release.resolve();await f.runtime.continuousMedia().drain();assert.deepEqual(f.errors,[]);
  assert.equal((await f.storage.list('processed-media')).length,2);assert.equal((await f.storage.list('media-continuous-admitted')).length,2);
  assert.equal(f.analyses(),2);assert.equal(f.native.calls,0,'ambient D are journaled, never a run');
});
test('restart rejects implicit state restoration and explicit next-chunk reset records partial new epoch',async t=>{
  const f=await fixture(t);const first=await f.append(marker(1024,false),0,0);await f.runtime.continuousMedia().drain();
  await f.runtime.continuousMedia().close();
  const chunk:TrackChunk={track_id:'mic',stream_epoch:'source-epoch',seq:1,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'source-epoch',start_ms:64,end_ms:160}};
  const archived=await f.service.append(f.raw(Buffer.concat([marker(1024,true),marker(512,false)])),
    {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'controlled',submission:'observation'},chunk);
  const context={session:'same-continuity',clock_maps:[{modality:'audio' as const,track_id:'mic',stream_epoch:'source-epoch',source_timebase_id:'samples',
    target_timebase_id:'common',offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]};
  const restarted=new ContinuousMediaSource({storage:f.storage,archive:f.archive,detector:f.detector,budget:defaultBudget,
    process:async()=>[],admit:async()=>{},onError:error=>assert.fail(String(error))});t.after(()=>restarted.close());
  await assert.rejects(restarted.accept(archived.event,chunk,context),/RESET_REQUIRED/);
  await restarted.accept(archived.event,chunk,context,true);await restarted.drain();
  const candidates=await f.records<ContinuousCandidate>('media-continuous-candidates');assert.equal(candidates.length,1);
  assert.equal(candidates[0]!.partial,true);assert.equal(candidates[0]!.detection_origin_sample,1024);
  assert.equal(candidates[0]!.start_sample,1024);assert.equal(first.event.raw_ref,archived.event.raw_ref);
  assert.equal((await f.storage.list('media-detection-epochs')).length,2);
});
test('finish and accept are serialized; finish does not infer silence or claim semantic completion',async t=>{
  const f=await fixture(t);await f.append(marker(1024,true),0,0);await f.runtime.continuousMedia().drain();
  const progress=await f.records<{detection_epoch:string}>('media-source-progress');assert.equal(progress.length,1);
  const epoch=await f.records<{raw_ref:string}>('media-detection-epochs');assert.equal(epoch.length,1);
  const key=(await import('../src/contracts.ts')).digest([epoch[0]!.raw_ref,'mic','source-epoch']);
  const [,result]=await Promise.all([f.runtime.continuousMedia().finish(key),f.append(marker(512,false),1,1024)]);assert.equal(result.processing_admission?.status,'failed');assert.match(result.processing_admission?.error_code??'',/RESET_REQUIRED/);
  await f.runtime.continuousMedia().drain();const c=await f.records<ContinuousCandidate>('media-continuous-candidates');
  assert.equal(c.length,1);assert.equal(c[0]!.reason,'input_exhausted');assert.equal(c[0]!.semantic_status,'open');
  assert.equal(await committedCount(f.storage),2);
});

test('actual sherpa Silero detector cuts two spoken utterances into automatic L5 C D and two journal entries',
  {skip:!realModelsPresent||!sayPresent?'sherpa models or macOS say voices absent':false},async t=>{
  const engine=await LocalSpeechEngine.open(realSpeechConfig);t.after(()=>engine.close());
  const voices=await fs.mkdtemp(join(tmpdir(),'paios-continuous-voices-'));t.after(()=>fs.rm(voices,{recursive:true,force:true}));
  const input=Buffer.concat([silence(0.3),await synthesize(voices,VOICE_A,'今天中午我们去吃面条吧。'),silence(0.9),
    await synthesize(voices,VOICE_B,'好的，下午三点再开会。'),silence(0.9)]);
  const f=await fixture(t,{detector:new SherpaSileroStreamFactory(async()=>engine),transcript:true});
  let at=0,seq=0;for(const width of [100,320,480,753,1,1024,2048,16000,9000]){await f.append(input.subarray(at*2,(at+width)*2),seq++,at);at+=width;}
  for(;at<input.length/2;at+=16000)await f.append(input.subarray(at*2,Math.min(input.length,(at+16000)*2)),seq++,at);
  await f.runtime.continuousMedia().drain();assert.deepEqual(f.errors,[]);
  const candidates=(await f.records<ContinuousCandidate>('media-continuous-candidates')).filter(c=>c.reason!=='non_speech');assert.equal(candidates.length,2);
  assert(candidates.every(c=>c.reason==='acoustic_pause'&&c.semantic_status==='open'&&c.detection.model.id==='silero-vad'&&
    c.detection.model.native_metadata.onnx_sha256===realSpeechConfig.vad.model.sha256&&c.detection.start_evidence.start!==undefined));
  const [first,second]=candidates.sort((a,b)=>a.start_sample-b.start_sample);
  assert.ok(first!.end_sample_exclusive<second!.start_sample&&second!.end_sample_exclusive<=input.length/2);
  await f.runtime.continuousMedia().finish(first!.stream_key);await f.runtime.continuousMedia().drain();
  const finished=await f.records<{terminal:{input_sha256:string;processed_samples:number;uninferred_samples:number}}>('media-detection-finished');
  assert.equal(finished[0]!.terminal.input_sha256,sha256(input));
  assert.equal(finished[0]!.terminal.processed_samples+finished[0]!.terminal.uninferred_samples,input.length/2);
  const d=await f.records<ProcessedEvent>('processed-media');assert.equal(d.filter(e=>e.content.transcript).length,2);assert.equal(f.analyses(),d.length);
  assert.equal(f.journal.search({principal_id:'owner',limit:10}).entries.length,2);assert.equal(f.native.calls,0);
  assert.equal((await f.records('media-continuous-admitted')).length,d.length);
});

test('processing cancellation keeps capture/detection separate and explicit retry reuses pinned C',async t=>{
  const entered=Promise.withResolvers<void>();let calls=0;
  const f=await fixture(t,{worker:{effects:'pure_analysis',analyze:async(request,signal)=>{calls++;if(calls===1){entered.resolve();await new Promise<void>((_resolve,reject)=>{
    if(signal.aborted)reject(new Error('CONTROLLED_CANCELLED'));else signal.addEventListener('abort',()=>reject(new Error('CONTROLLED_CANCELLED')),{once:true});});}
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{audio_observations:['CONTROLLED']},speakers:[],warnings:[],status:'partial'};}}});
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);await entered.promise;
  f.runtime.continuousMedia().cancelProcessing();await f.runtime.continuousMedia().drain();assert.equal(f.native.calls,0);
  await f.append(marker(512,false),1,1536);await f.runtime.continuousMedia().drain();assert.equal((await f.storage.list('media-source-progress')).length,2);
  const key=(await f.storage.list('media-continuous-candidates'))[0]!;await f.runtime.continuousMedia().retry(`l5-continuous:${key}`);
  await f.runtime.continuousMedia().drain();assert.equal(calls,2);
  assert.equal((await f.storage.list('media-continuous-admitted')).length,1);assert.equal(f.native.calls,0);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,1);
});

test('runtime close joins owned postarchive context/receipt work and fences fresh append',async t=>{
  const release=Promise.withResolvers<void>();const f=await fixture(t,{contextWait:release.promise});
  const pending=f.append(marker(1024,false),0,0);await until(async()=> (await f.storage.list('stream-revisions')).length===2);
  let closed=false;const closing=f.runtime.close().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,false);
  await assert.rejects(f.append(marker(512,false),1,1024),/RUNTIME_CLOSED/);
  release.resolve();const archived=await pending;await closing;assert.equal(archived.event.archive_status,'durable');
  assert(archived.processing_receipt_ref);assert.equal(closed,true);assert.equal(await committedCount(f.storage),1);
});

test('public source mutation queue is bounded before asynchronous checkpoint lookup; overflow keeps L5 durable',async t=>{
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();const f=await fixture(t,{budget:{max_streams:1,max_pending_chunks:1}});
  t.after(()=>gate.resolve());const read=f.storage.read.bind(f.storage);f.storage.read=async(namespace,key)=>{
    if(namespace==='media-source-progress'){entered.resolve();await gate.promise;}return read(namespace,key);};
  const first=f.append(marker(1024,false),0,0);await entered.promise;
  const second=f.append(marker(1024,false),0,0);await until(()=>f.runtime.continuousMedia().snapshot().pending_control===2);
  const rejected=await f.append(marker(1024,false),0,0);assert.equal(rejected.event.archive_status,'durable');
  assert.equal(rejected.processing_admission?.status,'failed');assert.match(rejected.processing_admission?.error_code??'',/CONTINUOUS_CONTROL_BACKLOG/);
  gate.resolve();await Promise.all([first,second]);await f.runtime.continuousMedia().drain();
  assert.equal(await committedCount(f.storage),1);assert.equal((await f.storage.list('media-source-progress')).length,1);
});

test('pure local resource is still unknown until its cancelled operation actually joins',async t=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
 const f=await fixture(t,{workerTimeout:100,worker:{effects:'pure_analysis',analyze:async request=>{
  calls++;entered.resolve();await release.promise;return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,
   time_range:request.time_range,content:{audio_observations:['NO_EFFECT']},speakers:[],warnings:[],status:'partial'};}}});
 t.mock.timers.enable({apis:['setTimeout']});
 try {
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);await entered.promise;
  f.runtime.continuousMedia().cancelProcessing();t.mock.timers.tick(100);await f.runtime.continuousMedia().drain();
  const receipts=await f.records<{state:string}>('media-continuous-attempts');assert.equal(receipts[0]!.state,'unknown');
  const key=(await f.storage.list('media-continuous-candidates'))[0]!;await f.runtime.continuousMedia().retry(`l5-continuous:${key}`);await f.runtime.continuousMedia().drain();
  assert.equal(calls,1);assert.equal(f.native.calls,0);assert.equal((await f.storage.list('processed-media')).length,0);
 } finally {release.resolve();}
});

const intervalChunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'source-epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',
 source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'source-epoch',start_ms:seq*20,end_ms:(seq+1)*20}});
const intervalAppend=(f:Awaited<ReturnType<typeof fixture>>,seqs:number[])=>f.runtime.appendMediaBatch(seqs.map(seq=>({raw:f.raw(marker(320,true)),device:f.device,chunk:intervalChunk(seq)})),{max_chunks:64,max_bytes:40960});
test('interval v2 preserves each raw SHA and C pin; changing retry boundaries does not consume samples twice',async t=>{
 const f=await fixture(t,{interval:true});const first=await intervalAppend(f,[0,1,2]);assert(first.every(x=>x.processing_admission?.status==='queued'));
 assert.equal(new Set(first.map(x=>x.processing_receipt_ref)).size,1);await f.runtime.continuousMedia().drain();
 const second=await intervalAppend(f,[1,2,3]);assert.deepEqual(second.map(x=>x.processing_admission?.status),['duplicate','duplicate','queued']);
 await f.runtime.continuousMedia().drain();await f.runtime.finishContinuousMedia(second[2]!.event,intervalChunk(3));await f.runtime.continuousMedia().drain();
 const proof=await f.archive.readRecord(second[2]!.event.raw_ref,'owner',second[2]!.event.archive_revision);assert.equal(proof.kind,'stream');
 if(proof.kind==='stream'){assert.equal(proof.chunks.length,4);for(const chunk of proof.chunks)assert.equal(sha256(chunk.bytes),sha256(marker(320,true)));}
 const candidates=await f.records<ContinuousCandidate>('media-continuous-candidates');assert.equal(candidates.length,1);
 assert.equal(candidates[0]!.event.archive_revision,second[2]!.event.archive_revision);assert.equal(candidates[0]!.end_sample_exclusive,1024);
 assert.equal((await f.storage.list('audio-consumer-attempts')).length,6); // Four frame claim slots, one interval blob and one C sample claim.
 assert.equal((await f.storage.list('media-postarchive-admissions')).length,2);assert.deepEqual(f.errors,[]);
});
test('interval v2 preflight rejects a bad later clock before any frame claim acceptance or VAD',async t=>{
 const f=await fixture(t,{interval:true}),context=(f.runtime as unknown as {continuousContext:Function}).continuousContext;
 (f.runtime as unknown as {continuousContext:Function}).continuousContext=async(...args:unknown[])=>{const value=await context(...args);if((args[2] as TrackChunk).seq===1)value.clock_maps[0].track_id='wrong';return value;};
 const values=await intervalAppend(f,[0,1]);assert(values.every(x=>x.processing_admission?.status==='failed'));assert.equal(values[1]!.event.bytes,1280);
 assert.equal((await f.storage.list('audio-consumer-accepted')).length,0);assert.equal((await f.storage.list('media-detection-epochs')).length,0);assert.equal(f.analyses(),0);
});
test('interval v2 partial final publication remains unknown; changed boundaries cannot reopen the missing claim',async t=>{
 const f=await fixture(t,{interval:true}),stage=f.storage.stageAlias.bind(f.storage);let fail=true,results=0;
 f.storage.stageAlias=async(ns,key,alias)=>{if(fail&&ns==='audio-consumer-results'&&++results===2)throw new Error('PARTIAL_INTERVAL_RESULT_EIO');return stage(ns,key,alias);};
 const values=await intervalAppend(f,[0,1,2]);assert(values.every(x=>x.processing_admission?.error_code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'));
 fail=false;const retry=await intervalAppend(f,[1,2]);assert(retry.every(x=>x.processing_admission?.error_code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'));
 await f.runtime.continuousMedia().drain();assert.equal((await f.storage.list('media-detection-epochs')).length,1);assert.equal((await f.storage.list('audio-consumer-accepted')).length,4); // Three slots and one interval blob.
});

test('interval v2 cross-Node overlap cannot steal canonical claims or queue partial work',async t=>{
 const f=await fixture(t,{interval:true}),entries=[];
 for(let seq=0;seq<3;seq++){const chunk=intervalChunk(seq),a=await f.service.append(f.raw(marker(320,true)),
  {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'controlled',submission:'observation'},chunk);
  entries.push({event:a.event,identity:{track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_range:chunk.source_range},payloadHash:a.chunk.object_hash});}
 const one=new AudioConsumption(f.storage,1000000),two=new AudioConsumption(f.storage,1000000);
 await one.select(entries[0]!.event,'continuous',{consumer:'media',source_scope:'mac',capture_span:'interval-fixture',purpose_evidence_ref:'fixture',input_contract:'interval_v2'});
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const work=one.interval(entries.slice(0,2),async(fresh,accept)=>{await accept();entered.resolve();await release.promise;return fresh.map(()=>({status:'queued'}));});
 await entered.promise;
 const script=`const {AudioConsumption}=await import(${JSON.stringify(new URL('../src/media/audio-consumption.ts',import.meta.url).href)});const {PosixStorage}=await import(${JSON.stringify(new URL('../src/storage.ts',import.meta.url).href)});const owner=new AudioConsumption(new PosixStorage(process.argv[1]),1000000);try{await owner.interval(JSON.parse(process.argv[2]),async()=>{console.log('UNEXPECTED_QUEUE');return [];});}catch(e){console.log(e.code);}`;
 const child=execFileSync(process.execPath,['--input-type=module','-e',script,f.storage.root,JSON.stringify(entries.slice(1))],{timeout:5000,encoding:'utf8'});
 assert.equal(child.trim(),'AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN');
 release.resolve();assert.equal((await work).length,2);
 const retry=await two.interval(entries,async(fresh,accept)=>{assert.deepEqual(fresh,[2]);await accept();return [{status:'queued'}];});
 assert.deepEqual(retry.map(r=>r.replayed),[true,true,false]);
});
test('interval v2 cold reset starts a new partial detection epoch with exact source C pin',async t=>{
 const f=await fixture(t,{interval:true});await intervalAppend(f,[0,1]);await f.runtime.continuousMedia().drain();await f.runtime.continuousMedia().close();
 const chunk={...intervalChunk(2),source_range:{kind:'interval' as const,timebase_id:'samples',stream_epoch:'source-epoch',start_ms:40,end_ms:136}},a=await f.service.append(f.raw(marker(1536,true)),{principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'controlled',submission:'observation'},chunk);
 const context={session:'same-continuity',clock_maps:[{modality:'audio' as const,track_id:'mic',stream_epoch:'source-epoch',source_timebase_id:'samples',target_timebase_id:'common',offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]};
 const next=new ContinuousMediaSource({storage:f.storage,archive:f.archive,detector:f.detector,budget:defaultBudget,process:async()=>[],admit:async()=>{},onError:e=>assert.fail(String(e))});t.after(()=>next.close());
 const owner=new AudioConsumption(f.storage,1000000),claims=[{event:a.event,identity:{track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_range:chunk.source_range},payloadHash:a.chunk.object_hash}];
 await assert.rejects(next.acceptInterval([{event:a.event,chunk,context}],queue=>owner.interval(claims,queue)),/RESET_REQUIRED/);
 await next.acceptInterval([{event:a.event,chunk,context}],queue=>owner.interval(claims,queue),true);await next.drain();
 await next.finish((await f.records<ContinuousCandidate>('media-continuous-candidates'))[0]?.stream_key??digest([a.event.raw_ref,chunk.track_id,chunk.stream_epoch]));await next.drain();
 const candidates=await f.records<ContinuousCandidate>('media-continuous-candidates');assert.equal(candidates.length,1);assert.equal(candidates[0]!.partial,true);assert.equal(candidates[0]!.event.archive_revision,a.event.archive_revision);
 const epochs=await f.records<{origin_sample:number;reset_reason:string}>('media-detection-epochs');assert.equal(epochs.length,2);assert(epochs.some(x=>x.origin_sample===640&&x.reset_reason==='explicit_gap_or_restart'));
 assert.equal((await f.storage.list('audio-consumer-accepted')).length,4); // Three slots and one interval blob.
});

test('interval v2 orphan selected bundle does not claim frames; explicit retry can acquire the original canonical slots',async t=>{
 const f=await fixture(t,{interval:true}),stage=f.storage.stageAlias.bind(f.storage);let fail=true;
 f.storage.stageAlias=async(ns,key,alias)=>{if(fail&&ns==='audio-consumer-attempts')throw new Error('ORPHAN_SELECTED');return stage(ns,key,alias);};
 const first=await intervalAppend(f,[0,1]);assert(first.every(x=>x.processing_admission?.status==='failed'));assert.equal((await f.storage.list('audio-consumer-accepted')).length,0);assert.equal((await f.storage.list('media-detection-epochs')).length,0);
 fail=false;const retry=await intervalAppend(f,[0,1]);assert(retry.every(x=>x.processing_admission?.status==='queued'));await f.runtime.continuousMedia().drain();assert.equal((await f.storage.list('media-detection-epochs')).length,1);
});
test('interval v2 cold reader rejects missing canonical blob behind a surviving slot and never queues new work',async t=>{
 const f=await fixture(t,{interval:true}),values=await intervalAppend(f,[0,1]);await f.runtime.continuousMedia().drain();
 const keys=await f.storage.list('audio-consumer-results');let blob:string|undefined;
 for(const key of keys){const bytes=await f.storage.read('audio-consumer-results',key);if(sha256(bytes)===key)blob=key;}
 assert(blob);await fs.unlink(join(f.storage.root,'audio-consumer-results',blob));
 const owner=new AudioConsumption(f.storage,1000000),claims=values.map((a,n)=>({event:a.event,identity:{track_id:'mic',stream_epoch:'source-epoch',source_range:intervalChunk(n).source_range},payloadHash:a.chunk.object_hash}));let runs=0;
 await assert.rejects(owner.interval(claims,async()=>{runs++;return [];}),/AUDIO_FACT_BUNDLE_INTEGRITY/);assert.equal(runs,0);
});

test('interval v2 partial queue failure after durable acceptance reports unknown for the whole interval',async t=>{
 const f=await fixture(t,{interval:true}),source=f.runtime.continuousMedia() as unknown as {acceptOwned:Function},accept=source.acceptOwned.bind(source);let calls=0;
 source.acceptOwned=async(...args:unknown[])=>{if(++calls===2)throw new Error('PARTIAL_QUEUE_FAILURE');return accept(...args);};
 const values=await intervalAppend(f,[0,1,2]);assert(values.every(v=>v.processing_admission?.error_code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'));assert.equal(values[2]!.event.bytes,1920);
 const retry=await intervalAppend(f,[1,2]);assert(retry.every(v=>v.processing_admission?.error_code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'));await f.runtime.continuousMedia().drain();
 assert.equal((await f.storage.list('audio-consumer-accepted')).length,4);assert.equal((await f.storage.list('audio-consumer-results')).length,0);assert.equal(f.analyses(),0);
});
test('interval v2 route cannot mix input contracts within the same capture span',async t=>{
 const f=await fixture(t,{interval:true}),values=await intervalAppend(f,[0,1]),owner=new AudioConsumption(f.storage,1000000);
 await assert.rejects(owner.select(values[0]!.event,'continuous',{consumer:'media',source_scope:'mac',capture_span:'interval-fixture',purpose_evidence_ref:'fixture'}),/AUDIO_ROUTE_CONFLICT/);
 const route=JSON.parse(Buffer.from(await f.storage.read('audio-consumer-routes',digest(['owner','mac',values[0]!.event.raw_ref]))).toString());assert.equal(route.schema,'paios.audio-consumer.v2');assert.equal(route.input_contract,'interval_v2');
 await assert.rejects(owner.chunk(values[0]!.event,{},'unused',async()=>{}),/AUDIO_FRAME_ROUTE_REQUIRED/);
});

test('interval v2 one frame cancellation certificate cannot release an accepted multi-frame interval',async t=>{
 const f=await fixture(t,{interval:true}),source=f.runtime.continuousMedia() as unknown as {acceptOwned:Function},accept=source.acceptOwned.bind(source);let calls=0;
 source.acceptOwned=async(...args:unknown[])=>{if(++calls===2)throw new MediaCancelledWithoutEffectError();return accept(...args);};
 const values=await intervalAppend(f,[0,1,2]);assert(values.every(v=>v.processing_admission?.error_code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'));await f.runtime.continuousMedia().drain();
 assert.equal((await f.storage.list('audio-consumer-not-accepted')).length,0);const retry=await intervalAppend(f,[1,2]);assert(retry.every(v=>v.processing_admission?.error_code==='AUDIO_CONSUMER_ACCEPTANCE_UNKNOWN'));
});


test('interval v2 cold completed nonzero replay needs no epoch; mixed fresh requires explicit partial reset',async t=>{
 const f=await fixture(t,{interval:true}),completed=await intervalAppend(f,[0,1,2]);await f.runtime.continuousMedia().drain();await f.runtime.continuousMedia().close();
 const context={session:'same-continuity',clock_maps:[{modality:'audio' as const,track_id:'mic',stream_epoch:'source-epoch',source_timebase_id:'samples',target_timebase_id:'common',offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]};
 let detector=0,process=0,admit=0;
 const next=new ContinuousMediaSource({storage:f.storage,archive:f.archive,detector:{open:async signal=>{detector++;return f.detector.open(signal);}},budget:defaultBudget,process:async()=>{process++;return [];},admit:async()=>{admit++;},onError:e=>assert.fail(String(e))});t.after(()=>next.close());
 const owner=new AudioConsumption(f.storage,1000000),entries=completed.slice(1).map((a,n)=>({event:a.event,chunk:intervalChunk(n+1),context}));
 const claims=(values:typeof entries)=>values.map(({event,chunk})=>({event,identity:{track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_range:chunk.source_range},payloadHash:completed[0]!.chunk.object_hash}));
 const epochs=(await f.storage.list('media-detection-epochs')).length,native=f.native.calls;
 await assert.rejects(f.runtime.continuousMedia().acceptInterval(entries,queue=>owner.interval(claims(entries),queue)),/CONTINUOUS_MEDIA_CLOSED/);
 const replay=await next.acceptInterval(entries,queue=>owner.interval(claims(entries),queue));assert.deepEqual(replay.map(x=>x.replayed),[true,true]);
 const explicitDuplicate=await next.acceptInterval(entries,queue=>owner.interval(claims(entries),queue),true);assert.deepEqual(explicitDuplicate.map(x=>x.replayed),[true,true]);
 assert.deepEqual([detector,process,admit,f.native.calls-native],[0,0,0,0]);assert.equal((await f.storage.list('media-detection-epochs')).length,epochs);assert.equal(next.snapshot().streams,0);
 const invalid=structuredClone(entries);invalid[1]!.context.clock_maps[0]!.track_id='foreign';
 await assert.rejects(next.acceptInterval(invalid,queue=>owner.interval(claims(invalid),queue)),/CONTINUOUS_CLOCK_SCOPE/);
 const chunk=intervalChunk(3),a=await f.service.append(f.raw(marker(320,true)),{principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'controlled',submission:'observation'},chunk),mixed=[...entries,{event:a.event,chunk,context}];
 await assert.rejects(next.acceptInterval(mixed,queue=>owner.interval(claims(mixed),queue)),/CONTINUOUS_RESET_REQUIRED/);
 assert.deepEqual([detector,process,admit,f.native.calls-native],[0,0,0,0]);assert.equal((await f.storage.list('media-detection-epochs')).length,epochs);
 const reset=await next.acceptInterval(mixed,queue=>owner.interval(claims(mixed),queue),true);assert.deepEqual(reset.map(x=>x.replayed),[true,true,false]);await next.drain();assert.equal(detector,1);assert.equal(process,0);assert.equal(admit,0);assert.equal(f.native.calls,native);
 const records=await f.records<{origin_sample:number;seq:number;reset_reason:string}>('media-detection-epochs');assert.equal(records.length,epochs+1);assert(records.some(x=>x.seq===3&&x.origin_sample===960&&x.reset_reason==='explicit_gap_or_restart'));
});

test('non-speech windows cover VAD-missed audio and short EOF tails without overlapping speech or creating runs',async t=>{
  const detector=controlledDetector();Object.assign(detector.vad.vad_model.native_metadata,{sound_window_samples:2048,lookback_samples:512});
  const requests:{sound:boolean;range:unknown}[]=[];
  const f=await fixture(t,{detector,worker:{effects:'pure_analysis',analyze:async request=>{
    requests.push({sound:request.sound_only===true,range:request.time_range});
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{transcript:''},speakers:[],warnings:[],status:'partial'};}}});
  const input=Buffer.concat([marker(3072,false),marker(1024,true),marker(1900,false)]);
  await f.append(input.subarray(0,5888*2),0,0);await f.runtime.continuousMedia().drain();
  await f.append(input.subarray(5888*2),1,5888);await f.runtime.continuousMedia().drain();
  const [first]=await f.records<ContinuousCandidate>('media-continuous-candidates');
  await f.runtime.continuousMedia().finish(first!.stream_key);await f.runtime.continuousMedia().drain();
  const candidates=(await f.records<ContinuousCandidate>('media-continuous-candidates')).sort((a,b)=>a.start_sample-b.start_sample);
  assert.deepEqual(candidates.map(c=>[c.start_sample,c.end_sample_exclusive,c.reason]),
    [[0,2048,'non_speech'],[2048,3072,'non_speech'],[3072,4096,'acoustic_pause'],[4096,5996,'non_speech']]);
  assert.equal(requests.filter(r=>r.sound).length,3);assert.equal(f.native.calls,0);assert.deepEqual(f.errors,[]);
});


test('live calls defer ambient analysis in the existing bounded chain and idle resumes it',async t=>{
  let busy=true;const f=await fixture(t,{realtimeBusy:()=>busy});
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);
  await until(()=>f.runtime.continuousMedia().snapshot().pending_candidates===1);
  assert.equal(f.analyses(),0);busy=false;await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),1);assert.equal((await f.storage.list('media-continuous-admitted')).length,1);assert.deepEqual(f.errors,[]);
});

test('candidate capacity backpressures detection during a call and resumes without failing the source',async t=>{
  let busy=true;t.after(()=>{busy=false;});
  const f=await fixture(t,{realtimeBusy:()=>busy,budget:{max_pending_candidates:1}});
  const pcm=Buffer.concat([marker(1024,true),marker(512,false)]);
  await f.append(pcm,0,0);await until(()=>f.runtime.continuousMedia().snapshot().pending_candidates===1);
  await f.append(pcm,1,1536);await until(async()=>(await f.storage.list('media-continuous-candidates')).length===2);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(f.runtime.continuousMedia().snapshot().pending_chunks,1);
  assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,1);
  assert.deepEqual(f.errors,[]);
  busy=false;await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),2);assert.equal((await f.storage.list('media-continuous-admitted')).length,2);
  assert.deepEqual(f.errors,[]);
});

for(const action of ['close','reset','call_owned','cancelProcessing'] as const)test(`candidate capacity wait releases for ${action}`,async t=>{
  let busy=true,owned=false;t.after(()=>{busy=false;});
  const f=await fixture(t,{realtimeBusy:()=>busy,callOwned:()=>owned,budget:{max_pending_candidates:1}});
  const pcm=Buffer.concat([marker(1024,true),marker(512,false)]);
  await f.append(pcm,0,0);await until(()=>f.runtime.continuousMedia().snapshot().pending_candidates===1);
  await f.append(pcm,1,1536);await until(async()=>(await f.storage.list('media-continuous-candidates')).length===2);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(f.runtime.continuousMedia().snapshot().pending_chunks,1);
  if(action==='close'){
    await Promise.race([f.runtime.continuousMedia().close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('CAPACITY_CLOSE_TIMEOUT')),2000))]);
    assert.equal(f.runtime.continuousMedia().snapshot().streams,0);
  }else if(action==='reset'){
    const reset=await Promise.race([f.append(pcm,2,3072,true),
      new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('CAPACITY_RESET_TIMEOUT')),2000))]);
    assert.equal(reset.processing_admission?.status,'queued');
    busy=false;await f.runtime.continuousMedia().drain();
    assert.equal(f.analyses(),2);
  }else if(action==='cancelProcessing'){
    f.runtime.continuousMedia().cancelProcessing();await f.runtime.continuousMedia().drain();
    assert.equal(f.runtime.continuousMedia().snapshot().pending_chunks,0);
    assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,0);
    assert.equal(f.analyses(),0);
  }else{
    owned=true;await f.runtime.continuousMedia().drain();
    assert.equal(f.analyses(),0);
    assert.equal((await f.storage.list('media-continuous-dispositions')).length,2);
    assert.deepEqual(f.errors,[]);
  }
  assert.ok(!f.errors.some(entry=>String(entry.error).includes('CONTINUOUS_CANDIDATE_BACKLOG')));
});

test('candidate capacity shared by two sources resumes both after the call',async t=>{
  let busy=true;t.after(()=>{busy=false;});
  const f=await fixture(t,{realtimeBusy:()=>busy,budget:{max_pending_candidates:1}});
  const pcm=Buffer.concat([marker(1024,true),marker(512,false)]);
  await f.append(pcm,0,0);await until(()=>f.runtime.continuousMedia().snapshot().pending_candidates===1);
  const chunk:TrackChunk={track_id:'mic',stream_epoch:'other-source',seq:0,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'other-source',start_ms:0,end_ms:96}};
  await f.runtime.appendMedia({...f.raw(pcm),event_id:'other'},f.device,chunk);
  await until(async()=>(await f.storage.list('media-continuous-candidates')).length===2);
  assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,1);
  busy=false;await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),2);assert.equal((await f.storage.list('media-continuous-admitted')).length,2);
  assert.deepEqual(f.errors,[]);
});

test('a deferred span taken by the call keeps its source and candidate without claiming ambient admission',async t=>{
  let owned=false;const f=await fixture(t,{realtimeBusy:()=>true,callOwned:()=>owned});
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);
  await until(()=>f.runtime.continuousMedia().snapshot().pending_candidates===1);owned=true;
  await f.runtime.continuousMedia().drain();assert.equal(f.analyses(),0);
  assert.equal((await f.storage.list('media-continuous-candidates')).length,1);
  assert.equal((await f.storage.list('media-continuous-admitted')).length,0);
  const records=await f.records<{state:string;raw_status:string}>('media-continuous-dispositions');
  assert.equal(records[0]!.state,'call_owned');assert.equal(records[0]!.raw_status,'durable');assert.deepEqual(f.errors,[]);
});

test('call ownership acquired during audio acceptance cancels before dispatch without unknown consumption',async t=>{
  let owned=false;const f=await fixture(t,{callOwned:()=>owned}),publish=f.storage.publish.bind(f.storage);
  f.storage.publish=async(namespace,key,bytes)=>{const result=await publish(namespace,key,bytes);if(namespace==='audio-consumer-accepted'&&(await f.storage.list('processed-media-inputs')).length)owned=true;return result;};
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),0);assert.equal((await f.storage.list('media-continuous-dispositions')).length,1);
  const rejected=await f.records<{state:string}>('audio-consumer-not-accepted');assert.equal(rejected[0]!.state,'cancelled_without_effect');
  assert.equal((await f.storage.list('media-continuous-attempts')).length,0);assert.deepEqual(f.errors,[]);
});

test('call-owned spans release before the deferred ambient candidate budget and do not fail detection',async t=>{
  let busy=true;const f=await fixture(t,{budget:{max_pending_candidates:1},realtimeBusy:()=>busy,
    callOwned:range=>range.start_ms>=T0+96});
  t.after(()=>{busy=false;});
  await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);
  await until(()=>f.runtime.continuousMedia().snapshot().pending_candidates===1);
  try {
    await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),1,1536);
    await until(async()=> (await f.storage.list('media-source-progress')).length===2||f.errors.length>0);
    assert.deepEqual(f.errors,[],'a call-owned span must not consume the deferred ambient candidate budget');
    assert.equal((await f.storage.list('media-continuous-candidates')).length,2);
    assert.equal((await f.storage.list('media-continuous-dispositions')).length,1);
    assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,1);assert.equal(f.analyses(),0);
  } finally {busy=false;}
  const [candidate]=await f.records<ContinuousCandidate>('media-continuous-candidates');
  await f.runtime.continuousMedia().finish(candidate!.stream_key);await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),1);assert.equal((await f.storage.list('media-continuous-admitted')).length,1);
  assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,0);
  assert.equal(f.runtime.continuousMedia().holds(candidate!.event.raw_ref),false);assert.deepEqual(f.errors,[]);
});

test('closing a call with no greeting audio finalizes raw acquisition before its deferred analysis and permits the next call',async t=>{
  const {createVoiceCallSession}=await import('../../../phase0/gateway/src/voice-call-session.ts');
  const errors:unknown[]=[],states:string[]=[],greeted=Promise.withResolvers<void>(),deferred=Promise.withResolvers<void>(),closeRelease=Promise.withResolvers<void>();
  let releaseBusy=false,captured:{event:ArchivedEvent};
  const chunk:TrackChunk={track_id:'mic',stream_epoch:'source-epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'source-epoch',start_ms:0,end_ms:96}};
  const call=createVoiceCallSession({room:()=>({}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>{},context:async()=>{},close:()=>{},
      greet:async()=>{greeted.resolve();return new Promise(()=>{});}}),
    onState:async(id,state)=>{states.push(`${id}:${state}`);if(id==='first'&&state==='closing'){await closeRelease.promise;await f.runtime.finalizeMediaSession(captured.event,chunk,'call_closed');}},
    onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const f=await fixture(t,{realtimeBusy:()=>{const busy=!releaseBusy&&!!call.pending();if(busy)deferred.resolve();return busy;}});
  await call.open('first');await greeted.promise;
  captured=await f.append(Buffer.concat([marker(1024,true),marker(512,false)]),0,0);
  await deferred.promise;assert.equal(f.runtime.continuousMedia().snapshot().pending_candidates,1);
  const source=f.runtime.continuousMedia(),drain=source.drain.bind(source),drainEntered=Promise.withResolvers<void>();
  source.drain=()=>{drainEntered.resolve();return drain();};
  const closing=call.close('first','button'),reopening=call.open('second').then(()=>undefined,error=>error);
  try {
    assert.equal(states.includes('second:opening'),false,'manual reopen waits for the old call to finish closing');closeRelease.resolve();
    const boundary=await Promise.race([closing.then(()=> 'closed'),drainEntered.promise.then(()=> 'global_drain')]);
    assert.equal(boundary,'closed','raw acquisition end cannot wait for semantic work deferred by this closing call');
    assert.equal(await reopening,undefined,'manual reopen succeeds after the old call closes');assert.equal(call.pending(),'second');
    assert.ok(states.indexOf('first:closed')<states.indexOf('second:opening'));
    assert.equal(await f.storage.readFinal(captured.event.raw_ref),null,'the call close records acquisition end without physical folding');
    assert.equal(JSON.parse(Buffer.from(await f.storage.read('session-ends',captured.event.raw_ref.slice(3))).toString()).ended_by,'call_closed');
    assert.equal(source.snapshot().streams,0);assert.equal(source.snapshot().pending_candidates,1);
    assert.equal(source.holds(captured.event.raw_ref),true);assert.equal(f.analyses(),0);
  } finally {closeRelease.resolve();releaseBusy=true;await closing;await reopening;await call.closeAll();}
  await drain();
  assert.equal(f.analyses(),1);assert.equal((await f.storage.list('media-continuous-admitted')).length,1);
  assert.equal(source.holds(captured.event.raw_ref),false);assert.deepEqual([...f.errors,...errors],[]);
});
