// Continuous source handle / detector lifecycle through the real Runtime -> MEDIA -> continuous C -> D -> Admission path.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
import {sha256,digest,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive,type TrackChunk} from '../src/stream-archive.ts';
import {MediaProcessor,type Capability,type WorkerPort} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';
import type {ClockMap} from '../src/media/align.ts';
import type {VadStreamFactory} from '../src/media/silero-stream.ts';
import {AudioConsumption,type AudioRoute} from '../src/media/audio-consumption.ts';
import type {ContinuousBudget} from '../src/media/continuous-source.ts';
import {testJournal} from './speech-fixture.ts';
import {createSourceMediaAdmission} from '../../../phase0/gateway/src/source-media-admission.ts';
import {RealtimeAuthorityConflictError} from '../../platform-data/src/realtime-authority-repository.ts';

const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',channel:'fixture',submission:'observation'};
const pcm=Buffer.alloc(3200);for(let n=0;n<1600;n++)pcm.writeInt16LE(Math.round(Math.sin(n/10)*12000),n*2);
// Each capture span is its own raw event and stream epoch, as the formal PCM rollover produces.
const raw=(span:string):RawEvent=>({schema_version:'paios.event.v1',event_id:span,device_id:'glasses',device_type:'glasses',
  captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'fixture'},media_type:'livekit_tracks',mime:'audio/pcm',representation:'received_decoded_sample',payload:pcm});
const chunk=(span:string):TrackChunk=>({track_id:'mic',stream_epoch:span,seq:0,modality:'audio',format:'pcm_s16le:16000:1',
  source_range:{kind:'interval',timebase_id:'capture',stream_epoch:span,start_ms:0,end_ms:100}});
const map=(epoch:string):ClockMap=>({modality:'audio',track_id:'mic',stream_epoch:epoch,source_timebase_id:'capture',target_timebase_id:'fixture-common',
  offset_ms:0,drift_ppm:0,uncertainty_ms:1,basis_ref:'clock:fixture-unverified'});
const capability:Capability={id:'controlled',version:'fixture',modalities:['audio'],formats:['pcm_s16le:16000:1'],joint_av:false,healthy:true,
  permitted:true,max_duration_ms:200,evidence:'deterministic_replay',execution:'local'};
const analysis:WorkerPort['analyze']=async request=>({event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,
  time_range:request.time_range,content:{audio_observations:['controlled byte analysis']},speakers:[],warnings:['CONTROLLED_WORKER_NOT_REAL_MODEL'],status:'partial'});

async function fixture(t:test.TestContext,options:{budget?:Partial<ContinuousBudget>;worker?:WorkerPort['analyze'];consumer?:AudioRoute['consumer'];capturePurpose?:'request'|'voiceprint';contextFault?:()=>boolean|Error;detectionWait?:Promise<void>;detectionEntered?:()=>void}={}) {
  const directory=await mkdtemp(join(tmpdir(),'paios-continuous-lifecycle-'));
  const storage=new PosixStorage(directory);
  const budget={max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20};
  const archive=new RawArchive(storage,10000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
  let analyses=0;const errors:unknown[]=[];const detectors={opened:0,closed:0};
  // Controlled detector: one speech start/end per written chunk, so every span pins exactly one C.
  const detector:VadStreamFactory={open:async()=>{detectors.opened++;let samples=0,closed=false;return {
    model:{id:'controlled',version:'fixture',device:'cpu',native_metadata:{onnx_sha256:digest('fixture')}},
    write:async bytes=>{options.detectionEntered?.();await options.detectionWait;const start=samples;samples+=bytes.length/2;return [{processed_samples:samples,input_sha256:sha256(bytes),start},{processed_samples:samples,input_sha256:sha256(bytes),end:samples}];},
    finish:async()=>({processed_samples:samples,uninferred_samples:0,input_sha256:digest('fixture')}),
    close:async()=>{if(!closed){closed=true;detectors.closed++;}}};}};
  const processor=new MediaProcessor(storage,new Map([['controlled',{analyze:async(request,signal)=>{analyses++;return (options.worker??analysis)(request,signal);}}]]),
    {policy_version:'lifecycle-fixture',max_inflight:2,max_input_bytes:100000,timeout_ms:5000,allow_external:false,allow_replay:true,allow_partial:true});
  let captureSource:TrustedContext;
  const gate=createSourceMediaAdmission({source:{capture:async()=>({binding:{userId:'owner',deviceId:'glasses'} as never,trusted:captureSource})},
    clock:{read:async(_binding,chunk)=>({...map(chunk.stream_epoch),target_timebase_id:'utc_epoch_ms'})},
    permission:{read:async()=>{throw new Error('preflight forbidden');},withPermission:async(_binding,_modality,consume)=>consume({authorizedMediaUntil:new Date(100000).toISOString()} as never)},requestTeardown:async()=>{}});
  const service=new MediaService({storage,archive,streamArchive,processor,
    ...(options.capturePurpose?gate:{}),capabilities:async()=>[capability],
    vad:{candidates:async request=>[{start_ms:0,end_ms:request.time_range.kind==='interval'?request.time_range.end_ms:0,semantic_status:'open',basis:'controlled'}]},
    align:{max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:200,fixtureOnly:true,
    continuous:{detector,budget:{max_streams:2,max_pending_chunks:4,max_pending_candidates:32,max_chunk_bytes:10000,block_samples:8000,overlap_samples:1600,...options.budget},
      onError:error=>errors.push(error)}});
  let creates=0;const native:NativeClient={create:async(body,key)=>{creates++;return {run_id:`run-${key}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'completed'};},
    status:async id=>({run_id:id,session_id:'session',conversation_session_id:'session',status:'completed'}),
    cancel:async id=>({run_id:id,session_id:'session',conversation_session_id:'session',status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:64,max_pending_bytes:1000000,max_event_age_ms:100000,poll_interval_ms:5,
    native_idempotency_retention_ms:86400000,policy_version:'controlled'});
  const route:AudioRoute={consumer:options.consumer??'media',source_scope:'authenticated-continuity',capture_span:'button-span',purpose_evidence_ref:'button-source-evidence'};
  // Continuous D are ambient speech: journaled and never a run (no wake word here), so every span ends without a native create.
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),media:service,ambient_journal:await testJournal(t),
    devices:[{...trusted,route_version:'route',output_modes:['text'],token_sha256:sha256('token')},
      {...trusted,device_id:'other-glasses',route_version:'route',output_modes:['text'],token_sha256:sha256('other-token')}],
    skill:'controlled',max_read_bytes:100000,audio_route:async(_source,event)=>({...route,capture_span:event.raw_ref,...(options.capturePurpose?{source_scope:event.device_id,purpose_evidence_ref:event.consent_ref}:{})}),
    continuous_context:async(_source,_event,chunk)=>{const fault=options.contextFault?.();if(fault)throw fault instanceof Error?fault:new Error('CONTROLLED_CONTEXT_UNAVAILABLE');
      return {session:'session',clock_maps:[map(chunk.stream_epoch)]};}});
  t.after(async()=>{await runtime.close();await processor.close();await rm(directory,{recursive:true,force:true});});
  const device=await runtime.authenticate('token');captureSource={...device,submission:'observation'};
  const handles=()=>(runtime as unknown as {mediaSources:Map<string,unknown>}).mediaSources.size;
  const append=(span:string)=>runtime.appendMedia(raw(span),device,chunk(span));
  return {directory,storage,archive,runtime,service,gate,device,append,errors,detectors,handles,analyses:()=>analyses,creates:()=>creates,
    other:()=>runtime.authenticate('other-token')};
}
const within=<T>(work:Promise<T>)=>Promise.race([work,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('did not settle')),30000).unref())]);
async function until(run:()=>boolean){for(let i=0;i<400;i++){if(run())return;await new Promise(r=>setTimeout(r,5));}assert.fail('did not settle');}
const idle={streams:0,pending_control:0,pending_chunks:0,pending_candidates:0};

test('17 rotated capture spans, each finished: processing stays available and handles/detectors are reclaimed',async t=>{
  const f=await fixture(t);
  for(let n=0;n<17;n++){
    const span=`span-${n}`,a=await f.append(span);
    assert.equal(a.processing_admission?.status,'queued',`${span}: ${a.processing_admission?.error_code}`);
    assert.deepEqual(await f.runtime.finishContinuousMedia(a.event,chunk(span)),{status:'input_exhausted'});
    await f.runtime.continuousMedia().drain();
    assert.equal(f.handles(),0);assert.deepEqual(f.runtime.continuousMedia().snapshot(),idle);
  }
  assert.deepEqual(f.errors,[]);
  assert.equal((await f.storage.list('media-continuous-admitted')).length,17);
  assert.equal((await f.storage.list('media-detection-finished')).length,17);
  assert.equal(f.creates(),0);assert.equal(f.analyses(),17);
  assert.deepEqual(f.detectors,{opened:17,closed:17});
});

test('unfinished spans keep their handles; the 16-handle budget bounds concurrent use, not history',async t=>{
  const f=await fixture(t,{budget:{max_streams:32}});const live=[];
  for(let n=0;n<16;n++){const a=await f.append(`live-${n}`);assert.equal(a.processing_admission?.status,'queued');live.push(a);}
  await f.runtime.continuousMedia().drain();assert.equal(f.handles(),16);
  const refused=await f.append('live-16');assert.equal(refused.event.archive_status,'durable');
  assert.equal(refused.processing_admission?.error_code,'CONTINUOUS_SOURCE_HANDLE_BUDGET');assert.equal(f.handles(),16);
  assert.deepEqual(await f.runtime.finishContinuousMedia(live[0]!.event,chunk('live-0')),{status:'input_exhausted'});
  await f.runtime.continuousMedia().drain();assert.equal(f.handles(),15);
  const next=await f.append('live-17');assert.equal(next.processing_admission?.status,'queued');assert.equal(f.handles(),16);
  for(const [n,a] of [...live.entries()].slice(1))await f.runtime.finishContinuousMedia(a.event,chunk(`live-${n}`));
  await f.runtime.finishContinuousMedia(next.event,chunk('live-17'));await f.runtime.continuousMedia().drain();
  assert.equal(f.handles(),0);assert.deepEqual(f.runtime.continuousMedia().snapshot(),idle);assert.deepEqual(f.detectors,{opened:17,closed:17});
  assert.equal(f.creates(),0);
});

test('a finished span whose pinned C is still processing keeps its handle until admission joins',async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const f=await fixture(t,{worker:async(request,signal)=>{entered.resolve();await release.promise;return analysis(request,signal);}});
  t.after(()=>release.resolve());
  const a=await f.append('busy');await within(entered.promise);
  assert.deepEqual(await f.runtime.finishContinuousMedia(a.event,chunk('busy')),{status:'input_exhausted'});
  assert.equal(f.runtime.continuousMedia().snapshot().streams,0);assert.equal(f.handles(),1); // held by the pending C job, not evicted
  release.resolve();await f.runtime.continuousMedia().drain();
  assert.equal((await f.storage.list('media-continuous-admitted')).length,1);assert.equal(f.creates(),0);
  assert.equal(f.handles(),0);assert.deepEqual(f.errors,[]);
});

test('retry of a pinned C after its span finished: bare retry cannot use a released handle; the source re-presents it',async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let fault=false;
  const f=await fixture(t,{contextFault:()=>fault,worker:async(request,signal)=>{entered.resolve();await release.promise;return analysis(request,signal);}});
  t.after(()=>release.resolve());
  const a=await f.append('retry');await within(entered.promise);fault=true;
  await f.runtime.finishContinuousMedia(a.event,chunk('retry'));release.resolve();await f.runtime.continuousMedia().drain();
  assert.match(String(f.errors.at(-1)),/CONTROLLED_CONTEXT_UNAVAILABLE/);assert.equal(f.creates(),0);assert.equal(f.handles(),0);fault=false;
  const ref=`l5-continuous:${(await f.storage.list('media-continuous-candidates'))[0]}`;
  await f.runtime.continuousMedia().retry(ref);await f.runtime.continuousMedia().drain();
  assert.match(String(f.errors.at(-1)),/AUDIO_SOURCE_HANDLE_REQUIRED/);assert.equal(f.creates(),0);
  await assert.rejects(f.runtime.retryContinuousMedia(await f.other(),ref),/CONTINUOUS_SOURCE_SCOPE/);assert.equal(f.handles(),0);
  await f.runtime.retryContinuousMedia(f.device,ref);await f.runtime.continuousMedia().drain();
  assert.equal((await f.storage.list('media-continuous-admitted')).length,1);assert.equal(f.creates(),0);
  assert.equal(f.analyses(),1);assert.equal(f.handles(),0); // cached D replayed, no second analysis
});

test('voice and audit-only continuous sources never retain a handle',async t=>{
  for(const consumer of ['voice','audit_only'] as const){
    const f=await fixture(t,{consumer});const a=await f.append(`routed-${consumer}`);assert.equal(f.handles(),0);
    assert.deepEqual(await f.runtime.finishContinuousMedia(a.event,chunk(`routed-${consumer}`)),{status:'not_finished',reason:`consumer_${consumer}`});
    assert.deepEqual(f.detectors,{opened:0,closed:0});
  }
});


test('ending a slow detector does not block acceptance on the next epoch',async t=>{
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  const f=await fixture(t,{detectionWait:gate.promise,detectionEntered:()=>entered.resolve()});
  const first=await f.append('slow');await entered.promise;let ended=false;
  const finishing=f.runtime.finishContinuousMedia(first.event,chunk('slow')).then(()=>{ended=true;});
  try {
    const next=await f.append('next');
    assert.equal(next.processing_admission?.status,'queued');assert.equal(ended,false,'next epoch is accepted while the detector remains gated');
    gate.resolve();await finishing;await f.runtime.finishContinuousMedia(next.event,chunk('next'));
    await f.runtime.continuousMedia().drain();assert.deepEqual(f.errors,[]);assert.equal(f.detectors.closed,2);
  } finally {gate.resolve();await finishing;}
});

test('stream-budget rejection reports once per lane, retains every frame receipt, and clears at exhaustion',async t=>{
  const f=await fixture(t,{budget:{max_streams:1}}),first=await f.append('occupied');
  let rejected:Awaited<ReturnType<typeof f.append>>|undefined;
  for(let seq=0;seq<10;seq++){
    const frame={...chunk('blocked'),seq,source_range:{kind:'interval' as const,timebase_id:'capture',stream_epoch:'blocked',start_ms:seq*100,end_ms:(seq+1)*100}};
    rejected=await f.runtime.appendMedia(raw('blocked'),f.device,frame);
    assert.equal(rejected.event.archive_status,'durable');
    assert.equal(rejected.processing_admission?.error_code,'CONTINUOUS_STREAM_BACKLOG');
    assert.ok(rejected.processing_receipt_ref);
  }
  const reports=()=>f.errors.filter(error=>(error as {continuous_pcm_admission?:string}).continuous_pcm_admission==='rejected');
  assert.equal(reports().length,1);
  assert.match(String(reports()[0]),/CONTINUOUS_STREAM_BACKLOG/);
  assert.equal((await f.storage.list('media-postarchive-admissions')).length,11);
  const reporting=(f.service as unknown as {continuousAdmissionReports:Map<string,unknown>}).continuousAdmissionReports;
  // No detector was accepted for this lane. Its terminal signal still clears diagnostic state.
  assert.deepEqual(await f.runtime.finishContinuousMedia(rejected!.event,chunk('blocked')),{status:'not_finished',reason:'no_continuous_input'});
  await f.runtime.finishContinuousMedia(first.event,chunk('occupied'));
  const fresh=await f.append('available');assert.equal(fresh.processing_admission?.status,'queued');
  await f.runtime.finishContinuousMedia(fresh.event,chunk('available'));await f.runtime.continuousMedia().drain();
  assert.equal(reports().length,1);assert.equal(reporting.size,0);assert.equal(f.handles(),0);
  assert.deepEqual(f.runtime.continuousMedia().snapshot(),idle);assert.deepEqual(f.detectors,{opened:2,closed:2});
});

test('the same rejected lane reports recovery after capacity is released',async t=>{
  const f=await fixture(t,{budget:{max_streams:1}}),first=await f.append('occupying');
  const refused=await f.append('retry-admission');assert.equal(refused.processing_admission?.error_code,'CONTINUOUS_STREAM_BACKLOG');
  await f.runtime.finishContinuousMedia(first.event,chunk('occupying'));
  const admitted=await f.append('retry-admission');assert.equal(admitted.processing_admission?.status,'queued');
  assert.deepEqual(f.errors.map(error=>(error as {continuous_pcm_admission?:string}).continuous_pcm_admission),['rejected','recovered']);
  await f.runtime.finishContinuousMedia(admitted.event,chunk('retry-admission'));await f.runtime.continuousMedia().drain();
  assert.equal(f.handles(),0);assert.deepEqual(f.runtime.continuousMedia().snapshot(),idle);
});

test('postarchive authority conflict preserves exact PCM and a failed processing receipt; the same original can resume',async t=>{
  let conflict=true;
  const failure=new RealtimeAuthorityConflictError(),f=await fixture(t,{contextFault:()=>conflict&&failure});
  const refused=await f.append('authority-tail');
  assert.equal(refused.event.archive_status,'durable');
  assert.deepEqual(refused.processing_admission,{status:'failed',error_code:'REALTIME_AUTHORITY_CONFLICT'});
  assert.deepEqual(Buffer.from((await f.runtime.existingArchive().readExactChunk(refused.event,chunk('authority-tail'),10000)).bytes),pcm);
  const receipt=JSON.parse(Buffer.from(await f.storage.read('media-postarchive-admissions',refused.processing_receipt_ref!.slice('media-postarchive:'.length))).toString());
  assert.equal(receipt.raw_status,'durable');assert.deepEqual(receipt.processing_admission,refused.processing_admission);
  const report=f.errors[0] as Error&{continuous_pcm_admission:string};
  assert.equal(report.continuous_pcm_admission,'rejected');assert.equal(report.cause,failure);
  assert.match(failure.stack!,/RealtimeAuthorityConflictError: REALTIME_AUTHORITY_CONFLICT/);
  assert.equal(f.analyses(),0);assert.equal(f.handles(),0);
  conflict=false;const resumed=await f.append('authority-tail');
  assert.equal(resumed.event.raw_ref,refused.event.raw_ref);assert.equal(resumed.processing_admission?.status,'queued');
  await f.runtime.finishContinuousMedia(resumed.event,chunk('authority-tail'));await f.runtime.continuousMedia().drain();
  assert.equal(f.analyses(),1);assert.deepEqual(f.errors.map(error=>(error as {continuous_pcm_admission?:string}).continuous_pcm_admission),['rejected','recovered']);
});

test('receipt publication failures remain one rejection until the lane receipt succeeds',async t=>{
  const f=await fixture(t),publish=f.storage.publish.bind(f.storage);let fault=true;
  f.storage.publish=async(namespace,key,bytes)=>{
    if(namespace==='media-postarchive-admissions'&&fault)throw Object.assign(new Error('controlled receipt write'),{code:'EIO'});
    return publish(namespace,key,bytes);
  };
  let last:Awaited<ReturnType<typeof f.append>>|undefined;
  for(let seq=0;seq<4;seq++){
    fault=seq<3;
    last=await f.runtime.appendMedia(raw('receipt'),f.device,{...chunk('receipt'),seq,
      source_range:{kind:'interval',timebase_id:'capture',stream_epoch:'receipt',start_ms:seq*100,end_ms:(seq+1)*100}});
    assert.equal(last.processing_admission?.status,fault?'failed':'queued');
    if(fault)assert.equal(last.processing_admission?.error_code,'CONTINUOUS_RECEIPT_PUBLICATION_FAILED');
  }
  const reports=f.errors as {continuous_pcm_admission?:string;cause?:unknown}[];
  assert.deepEqual(reports.map(error=>error.continuous_pcm_admission),['rejected','recovered']);
  assert.match(String((reports[0]!.cause as Error).cause),/controlled receipt write/);
  await f.runtime.finishContinuousMedia(last!.event,chunk('receipt'));await f.runtime.continuousMedia().drain();
  assert.equal(f.handles(),0);
});

test('delayed older admission reports cannot recover or regress a newer lane report',async t=>{
  const f=await fixture(t),report=f.service.reportContinuousAdmission.bind(f.service);
  let older:(()=>void)|undefined;
  f.service.reportContinuousAdmission=(event,chunk,error)=>{
    if(chunk.seq===0){older=()=>report(event,chunk,error);return;}
    report(event,chunk,error);
  };
  t.after(()=>{f.service.reportContinuousAdmission=report;});
  const prior=await f.append('ordered');
  assert.equal(prior.processing_admission?.status,'queued');assert.ok(older);
  const frame=(seq:number):TrackChunk=>({...chunk('ordered'),seq,source_range:{kind:'interval',timebase_id:'capture',stream_epoch:'ordered',start_ms:seq*100,end_ms:(seq+1)*100}});
  const failed=await f.runtime.appendMedia(raw('ordered'),f.device,frame(1),undefined,{onDurable:()=>{},beforeConsume:Promise.resolve(),consume:false});
  assert.equal(failed.processing_admission?.error_code,'FORMAL_PCM_PROCESSING_BACKLOG');
  const transitions=()=>f.errors.map(error=>(error as {continuous_pcm_admission?:string}).continuous_pcm_admission);
  assert.deepEqual(transitions(),['rejected']);
  older!();f.service.reportContinuousAdmission=report;
  assert.deepEqual(transitions(),['rejected']);
  const fresh=await f.runtime.appendMedia(raw('ordered'),f.device,frame(2),undefined,{onDurable:()=>{},beforeConsume:Promise.resolve(),resetConsume:true});
  assert.equal(fresh.processing_admission?.status,'queued');assert.deepEqual(transitions(),['rejected','recovered']);
  f.service.reportContinuousAdmission(prior.event,frame(0),Object.assign(new Error('late failure'),{code:'FORMAL_PCM_PROCESSING_BACKLOG'}));
  assert.deepEqual(transitions(),['rejected','recovered']);
  await f.runtime.finishContinuousMedia(fresh.event,frame(2));await f.runtime.continuousMedia().drain();
  assert.equal((f.service as unknown as {continuousAdmissionReports:Map<string,unknown>}).continuousAdmissionReports.size,0);
});


for(const consumer of ['voice','audit_only'] as const)for(const batch of [false,true])
test(`processing backlog preserves durable ${consumer} acquisition route (${batch?'batch':'frame'})`,async t=>{
  const f=await fixture(t,{consumer}),span=`cancelled-${consumer}-${batch}`;
  const lifecycle={onDurable:()=>{},beforeConsume:Promise.resolve(),consume:false};
  const a=batch?(await f.runtime.appendMediaBatch([{raw:raw(span),device:f.device,chunk:chunk(span)}],{max_chunks:2,max_bytes:10000},undefined,lifecycle))[0]!
    :await f.runtime.appendMedia(raw(span),f.device,chunk(span),undefined,lifecycle);
  assert.equal(a.event.archive_status,'durable');assert.equal(a.processing_admission?.error_code,'FORMAL_PCM_PROCESSING_BACKLOG');
  assert.equal((await f.runtime.archivedAudioRoute(a.event))?.consumer,consumer);
  assert.equal((await f.archive.readRecord(a.event.raw_ref,'owner',a.event.archive_revision,{maxReadBytes:10000})).kind,'stream');
  const replay=await f.runtime.appendMedia(raw(span),f.device,chunk(span));
  assert.equal((await f.runtime.archivedAudioRoute(replay.event))?.consumer,consumer);assert.equal(f.analyses(),0);assert.equal(f.creates(),0);
});


for(const purpose of ['request','voiceprint'] as const)for(const batch of [false,true])for(const cut of ['audio-consumer-spans','audio-consumer-routes'])
test(`durable ${purpose} capture recovers after interruption before ${cut} (${batch?'batch':'frame'})`,async t=>{
  const consumer=purpose==='request'?'voice':'audit_only',f=await fixture(t,{consumer,capturePurpose:purpose});
  const span=`crash-${purpose}-${batch}-${cut}`,ref=`l5:${digest({event_id:span,principal_id:'owner',device_id:'glasses'})}`;
  const publish=f.storage.publish.bind(f.storage);let interrupted=false;
  f.storage.publish=async(namespace,key,bytes)=>{
    if(namespace===cut&&!interrupted){interrupted=true;throw new Error('controlled process interruption before route publication');}
    return publish(namespace,key,bytes);
  };
  const lifecycle={onDurable:()=>{},beforeConsume:Promise.resolve(),consume:false,audioPurpose:purpose};
  await assert.rejects(batch?f.runtime.appendMediaBatch([{raw:raw(span),device:f.device,chunk:chunk(span)}],{max_chunks:2,max_bytes:10000},undefined,lifecycle)
    :f.runtime.appendMedia(raw(span),f.device,chunk(span),undefined,lifecycle),/controlled process interruption/);
  assert.equal(interrupted,true);f.storage.publish=publish;
  await assert.rejects(f.gate.withAppendAdmission!(raw(span),{...f.device,submission:'observation',principal_id:'forged'},chunk(span),async()=>assert.fail('wrong identity must not archive')),/MEDIA_CAPTURE_CONTEXT_MISMATCH/);
  await f.runtime.close();
  const storage=new PosixStorage(f.directory),recoveredArchive=new RawArchive(storage,10000),owner=new AudioConsumption(storage,100000);
  t.after(()=>recoveredArchive.close());await recoveredArchive.recover();
  const recovered=await recoveredArchive.locate(ref,'owner');
  const lane=purpose==='request'?'finite':'continuous';
  assert.deepEqual(recovered.audio_capture,{purpose,lane});
  const route=cut==='audio-consumer-spans'?await owner.select(recovered,lane):await owner.existingRoute(recovered);
  assert.equal(route?.consumer,consumer);assert.equal((await owner.existingRoute(recovered))?.consumer,consumer);
  await assert.rejects(owner.select(recovered,lane,{consumer:'media',source_scope:'glasses',capture_span:ref,purpose_evidence_ref:'fixture'}),/AUDIO_ROUTE_CONFLICT/);
  assert.equal(f.analyses(),0);assert.equal(f.creates(),0);
});

test('external raw metadata cannot forge the Host audio capture purpose',async t=>{
  const f=await fixture(t),span='forged-purpose';
  const forged={...raw(span),audio_capture:{purpose:'voiceprint',lane:'continuous'}};
  const archived=await f.runtime.appendMedia(forged,f.device,chunk(span),undefined,{onDurable:()=>{},beforeConsume:Promise.resolve(),consume:false});
  assert.equal(archived.event.audio_capture,undefined);
  assert.equal((await f.runtime.archivedAudioRoute(archived.event))?.consumer,'media');
});
