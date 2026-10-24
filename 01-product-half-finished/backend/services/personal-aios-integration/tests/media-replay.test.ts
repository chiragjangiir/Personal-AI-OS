import {materialized} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EVENT_SCHEMA} from '../src/contracts.ts';
import type {RawEvent,TrustedContext,TimeRange} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import type {TrackChunk} from '../src/stream-archive.ts';
import {PcmVad} from '../src/media/vad.ts';
import {alignSegment,mappedRange} from '../src/media/align.ts';
import type {ClockMap} from '../src/media/align.ts';
import {FeatureReplayWorker,MediaProcessor,selectCapabilities} from '../src/media/processing.ts';
import type {Capability,ProcessingConfig,WorkerPort} from '../src/media/processing.ts';
import {demuxContainer,pairIndependentTracks} from '../src/media/tracks.ts';
const at='2026-10-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'consent',channel:'livekit',submission:'observation'};
const pcm=(voiced:boolean,n=100):Buffer=>{const b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(voiced?Math.round(Math.sin(i*Math.PI/5)*12000):0,i*2);return b;};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
const raw=(payload:Uint8Array,visual=false,kind:RawEvent['media_type']='livekit_tracks'):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:'stream',device_id:'glasses',device_type:'glasses',captured_at:at,source:{channel:'livekit'},media_type:kind,mime:visual?'image/png':'audio/pcm',representation:'received_decoded_sample',payload});
const track=(seq:number,visual=false):TrackChunk=>({track_id:visual?'cam':'mic',stream_epoch:'e1',seq,modality:visual?'visual':'audio',format:visual?'png':'pcm_s16le:1000:1',
  source_range:visual?{kind:'instant',timebase_id:'video_pts',stream_epoch:'e1',at_ms:seq*100+500}:{kind:'interval',timebase_id:'samples',stream_epoch:'e1',start_ms:seq*100,end_ms:(seq+1)*100}});
const maps:ClockMap[]=[{modality:'audio',track_id:'mic',stream_epoch:'e1',source_timebase_id:'samples',target_timebase_id:'common',offset_ms:1000,drift_ppm:0,uncertainty_ms:2,basis_ref:'clock:audio-calibration'},
  {modality:'visual',track_id:'cam',stream_epoch:'e1',source_timebase_id:'video_pts',target_timebase_id:'common',offset_ms:500,drift_ppm:0,uncertainty_ms:3,basis_ref:'clock:camera-calibration'}];
const align={max_chunks:100,max_visual_refs:20,max_frame_gap_ms:100,max_uncertainty_ms:5};
const cfg:ProcessingConfig={policy_version:'replay.v1',max_inflight:4,max_input_bytes:65536,timeout_ms:200,allow_external:false,allow_replay:true,allow_partial:true};
const capability=(extra:Partial<Capability>={}):Capability=>({id:'feature',version:'1',modalities:['audio','visual'],formats:['pcm_s16le:1000:1','png'],joint_av:true,healthy:true,permitted:true,max_duration_ms:1000,execution:'local',evidence:'deterministic_replay',...extra});
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'paios-media-'));t.after(()=>fs.rm(root,{force:true,recursive:true}));const storage=new PosixStorage(root);
  return {storage,archive:new StreamArchive(storage,{max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:100,max_revisions:100,max_seq:100})};}
const window=(start=1000,end=1100):TimeRange=>({kind:'interval',timebase_id:'common',start_ms:start,end_ms:end});
test('E03/E11 actual continuous PCM long expression with two pauses forms three open candidates and D versions',async t=>{
  const {storage,archive}=await fixture(t);const vad=new PcmVad({sample_rate:1000,frame_ms:10,rms_threshold:0.1,silence_ms:50,min_speech_ms:20,max_candidate_ms:1000,max_chunk_samples:200,candidate_overlap_ms:20});
  const candidates=[];let last;
  for(let seq=0;seq<6;seq++){
    const audio=pcm(seq%2===0);last=await archive.append(raw(audio),trusted,at,track(seq));
    last=await archive.append(raw(png,true),trusted,at,track(seq,true));candidates.push(...vad.feed(audio,seq*100));
  }
  assert.deepEqual(candidates.map(c=>[c.start_ms,c.end_ms,c.semantic_status]),[[0,100,'open'],[200,300,'open'],[400,500,'open']]);
  assert.equal((await materialized(storage,last!)).chunks.length,12);const processor=new MediaProcessor(storage,new Map([['feature',new FeatureReplayWorker()]]),cfg);
  const ids:string[]=[];
  for(const candidate of candidates){const aligned=await alignSegment(last!.event,(await materialized(storage,last!)),window(candidate.start_ms+1000,candidate.end_ms+1000),'speech_candidate',maps,storage,align,ids.slice());
    const d=await processor.process(aligned.segment,aligned.views,[capability()]);ids.push(d.processed_event_id);
    assert.equal(d.continuation_hint,'open');assert.equal(d.user_identity,'unknown');assert.equal(d.origin,'device_observation');assert.equal(d.quality.status,'partial');
    assert.equal(d.coverage.alignment_uncertainty_ms,3);assert.equal(d.content.transcript,undefined);assert.match(d.quality.warnings.join('|'),/NOT_REAL_MODEL_ACCEPTANCE/);
  }assert.equal(new Set(ids).size,3);
});
test('VAD frame carry handles arbitrary chunk boundaries and explicit source gap without compressed timeline',()=>{
  const vad=new PcmVad({sample_rate:1000,frame_ms:10,rms_threshold:0.1,silence_ms:20,min_speech_ms:10,max_candidate_ms:100,max_chunk_samples:200,candidate_overlap_ms:20});
  assert.deepEqual(vad.feed(pcm(true,15),0),[]);assert.deepEqual(vad.feed(pcm(true,15),15),[]);
  const gap=vad.feed(pcm(false,30),80);assert.equal(gap[0]!.basis,'gap');assert.equal(gap[0]!.end_ms,30);
  awaitOutOfOrder(vad);
});
function awaitOutOfOrder(vad:PcmVad){assert.throws(()=>vad.feed(pcm(false),0),/VAD_OUT_OF_ORDER/);}
test('resource duration produces explicit overlapping context, never a semantic end or Stop',()=>{
  const vad=new PcmVad({sample_rate:1000,frame_ms:10,rms_threshold:0.1,silence_ms:20,min_speech_ms:10,max_candidate_ms:100,max_chunk_samples:300,candidate_overlap_ms:20});
  const candidates=[...vad.feed(pcm(true,250),0),...vad.flush()];
  assert.deepEqual(candidates.map(c=>[c.start_ms,c.end_ms,c.overlap_context_ms]),[[0,100,0],[80,180,20],[160,250,20]]);
  assert.ok(candidates.every(c=>c.semantic_status==='open'));
});
test('E04 audio-only and visual-only do not depend on unrelated offline workers; LiveKit is PAIR',async t=>{
  const {archive,storage}=await fixture(t);
  const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const a=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  const selected=selectCapabilities(a.segment,a.views,[capability({modalities:['visual'],healthy:false}),capability({id:'audio',modalities:['audio'],joint_av:false})],cfg);
  assert.deepEqual(selected.map(c=>c.id),['audio']);assert.deepEqual(a.segment.visual_refs,[]);
  const visual=await archive.append({...raw(png,true,'visual'),event_id:'visual'},trusted,at,track(0,true));
  const v=await alignSegment(visual.event,(await materialized(storage,visual)),{kind:'instant',timebase_id:'common',at_ms:1000},'still_image',[maps[1]!],storage,align);
  assert.equal(v.segment.audio_ref,null);assert.equal(v.segment.time_range.kind,'instant');
  assert.deepEqual(selectCapabilities(v.segment,v.views,[capability({id:'vision',modalities:['visual'],joint_av:false})],cfg).map(c=>c.id),['vision']);
  const live=await archive.append({...raw(pcm(true)),event_id:'live'},trusted,at,track(0));
  assert.deepEqual(pairIndependentTracks(live.event,[{event_id:'live',device_id:'glasses',stream_epoch:'e1',chunks:(await materialized(storage,live)).chunks}]),(await materialized(storage,live)).chunks);
  await assert.rejects(demuxContainer({...live.event,media_type:'muxed_av'},null,new AbortController().signal),/DEMUX_SERVICE_UNAVAILABLE/);
});
test('late camera produces new archive/processed revision; old evidence remains partial and immutable',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true)),trusted,at,track(0));
  const missing=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',maps,storage,align);
  assert.equal(missing.segment.coverage.status,'partial');assert.equal(missing.segment.coverage.missing_by_track![0]!.track_id,'cam');
  const processor=new MediaProcessor(storage,new Map([['feature',new FeatureReplayWorker()]]),cfg);
  const first=await processor.process(missing.segment,missing.views,[capability()]);
  const late=await archive.append(raw(png,true),trusted,at,track(0,true));
  const complete=await alignSegment(late.event,(await materialized(storage,late)),window(),'speech_candidate',maps,storage,align);
  const second=await processor.process(complete.segment,complete.views,[capability()],2,first.processed_event_id);
  assert.equal(first.segment_id,second.segment_id);assert.notEqual(first.archive_revision,second.archive_revision);
  assert.equal(second.replaces_processed_event_id,first.processed_event_id);assert.equal(first.coverage.status,'partial');
  assert.equal(complete.segment.coverage.status,'complete');assert.deepEqual(await archive.revision(audio.event.raw_ref,1),(await materialized(storage,audio)));
});
test('source clock uncertainty, format capability, licence, and outbound policy fail or mark partial',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[{...maps[0]!,uncertainty_ms:30}],storage,align);
  assert.equal(aligned.segment.coverage.status,'partial');assert.equal(mappedRange(track(0).source_range,{...maps[0]!,drift_ppm:1000}).kind,'interval');
  for(const c of [capability({formats:['mp3']}),capability({permitted:false}),capability({execution:'external'}),capability({evidence:'unverified'})])
    assert.throws(()=>selectCapabilities(aligned.segment,aligned.views,[c],cfg),/NO_COMPLIANT_MEDIA_CAPABILITY/);
});
test('E10 model delays do not block continuous archival; timeout is failure and inflight budget remains bounded',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  let finish:()=>void=()=>{};const hang:WorkerPort={analyze:async()=>{await new Promise<void>(resolve=>finish=resolve);throw new Error('cancelled');}};
  const processor=new MediaProcessor(storage,new Map([['feature',hang]]),{...cfg,max_inflight:1,timeout_ms:20});
  const processing=processor.process(aligned.segment,aligned.views,[capability({modalities:['audio']})]);
  const rejection=assert.rejects(processing,/ALL_MEDIA_WORKERS_FAILED/);
  const second=await archive.append(raw(pcm(false),false,'audio'),trusted,at,track(1));assert.equal((await materialized(storage,second)).chunks.length,2);
  await rejection;await assert.rejects(processor.process(aligned.segment,aligned.views,[capability()]),/MEDIA_BUSY/);finish();
});
test('worker time-range mismatch and feature-only output cannot pretend complete model result',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  const invalid:WorkerPort={analyze:async request=>({...await new FeatureReplayWorker().analyze(request,new AbortController().signal),segment_id:'wrong'})};
  await assert.rejects(new MediaProcessor(storage,new Map([['feature',invalid]]),cfg).process(aligned.segment,aligned.views,[capability()]),/ALL_MEDIA_WORKERS_FAILED/);
  await assert.rejects(new MediaProcessor(storage,new Map([['feature',new FeatureReplayWorker()]]),{...cfg,allow_partial:false}).process(aligned.segment,aligned.views,[capability()]),/MEDIA_PARTIAL_NOT_ACCEPTED|MEDIA_INPUT_REVISION_CONFLICT/);
});
test('sealed input cannot be swapped and a published D replays without re-running changed worker code',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  const processor=new MediaProcessor(storage,new Map([['feature',new FeatureReplayWorker()]]),cfg);
  const d=await processor.process(aligned.segment,aligned.views,[capability()]);
  assert.deepEqual(await processor.process(aligned.segment,aligned.views,[capability()]),d);
  const views=aligned.views.map(v=>({...v,mapped_range:window(1100,1200)}));
  await assert.rejects(processor.process(aligned.segment,views,[capability()]),/MEDIA_INPUT_SCOPE_MISMATCH/);
  const altered:WorkerPort={analyze:async(request,signal)=>{const result=await new FeatureReplayWorker().analyze(request,signal);return {...result,warnings:[...result.warnings,'changed-analysis']};}};
  assert.deepEqual(await new MediaProcessor(storage,new Map([['feature',altered]]),cfg).process(aligned.segment,aligned.views,[capability()]),d);
});
test('MEDIA completion timestamp comes from source clock after the worker finishes', async t=>{
  const {archive,storage}=await fixture(t);
  const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  let clock=at;
  const ended='2026-10-01T04:00:00.000Z';
  const delayed:WorkerPort={analyze:async (request,signal)=>{
    const result=await new FeatureReplayWorker().analyze(request,signal); clock=ended; return result;
  }};
  const processor=new MediaProcessor(storage,new Map([['feature',delayed]]),cfg,()=>clock);
  const d=await processor.process(aligned.segment,aligned.views,[capability()]);
  assert.equal(d.processing.completed_at,ended);
  assert.equal(d.captured_at,at);
});
test('stable input contract replays nondeterministic elapsed output offline and requires new revision for changed archive',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  let calls=0;
  const worker:WorkerPort={analyze:async(request,signal)=>{calls++;const result=await new FeatureReplayWorker().analyze(request,signal);
    return {...result,content:{audio_observations:[{elapsed_ms:calls*125,elapsed_seconds:calls/8}]}};}};
  const processor=new MediaProcessor(storage,new Map([['feature',worker]]),cfg);
  const first=await processor.process(aligned.segment,aligned.views,[capability()]);assert.equal(calls,1);
  assert.deepEqual(await processor.process(aligned.segment,aligned.views,[capability()]),first);assert.equal(calls,1);
  assert.deepEqual(await new MediaProcessor(storage,new Map(),cfg).process(aligned.segment,aligned.views,[]),first);
  assert.deepEqual(await processor.process(aligned.segment,aligned.views,async()=>{throw new Error('CAP endpoint offline');}),first);
  await assert.rejects(new MediaProcessor(storage,new Map(),{...cfg,policy_version:'changed-policy'})
    .process(aligned.segment,aligned.views,[]),/MEDIA_INPUT_REVISION_CONFLICT/);
  const later=await archive.append(raw(pcm(false),false,'audio'),trusted,at,track(1));
  const updated=await alignSegment(later.event,(await materialized(storage,later)),window(),'speech_candidate',[maps[0]!],storage,align);
  await assert.rejects(processor.process(updated.segment,updated.views,[capability()]),/MEDIA_INPUT_REVISION_CONFLICT/);
  const second=await processor.process(updated.segment,updated.views,[capability()],2,first.processed_event_id);
  assert.equal(second.revision,2);assert.equal(calls,2);assert.equal(second.replaces_processed_event_id,first.processed_event_id);
  const key=(await storage.list('processed-media-inputs'))[0]!;
  await fs.unlink(join(storage.root,'processed-media-inputs',key));
  // At least the slot corresponding to that removed fixture input must now reject legacy replay explicitly.
  const outcomes=await Promise.allSettled([processor.process(aligned.segment,aligned.views,[]),
    processor.process(updated.segment,updated.views,[],2,first.processed_event_id)]);
  assert.ok(outcomes.some(r=>r.status==='rejected'&&/MEDIA_LEGACY_INPUT_RECORD_REQUIRED/.test(String(r.reason))));
});
test('input-only failure retries analysis once; overlapping same-slot attempt remains busy until worker exits',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);let finish!:()=>void;let calls=0;
  const worker:WorkerPort={analyze:async(request,signal)=>{calls++;if(calls===1){enter();await new Promise<void>(r=>finish=r);}
    return new FeatureReplayWorker().analyze(request,new AbortController().signal);}};
  const processor=new MediaProcessor(storage,new Map([['feature',worker]]),{...cfg,max_inflight:4,timeout_ms:20});
  const first=processor.process(aligned.segment,aligned.views,[capability()]);const failed=assert.rejects(first,/ALL_MEDIA_WORKERS_FAILED/);
  await entered;await failed;assert.equal((await storage.list('processed-media-inputs')).length,1);
  assert.deepEqual(await storage.list('processed-media'),[]);
  await assert.rejects(processor.process(aligned.segment,aligned.views,[capability()]),/MEDIA_BUSY/);
  assert.equal(calls,1);finish();await new Promise(r=>setTimeout(r,5));
  const recovered=await processor.process(aligned.segment,aligned.views,[capability()]);assert.equal(calls,2);
  assert.deepEqual(await processor.process(aligned.segment,aligned.views,[]),recovered);assert.equal(calls,2);
});
test('partial CAP fallback keeps actual visual evidence while available audio analyzes; strict policy rejects uncovered modality',async t=>{
  const {archive,storage}=await fixture(t);await archive.append(raw(pcm(true)),trusted,at,track(0));
  const paired=await archive.append(raw(png,true),trusted,at,track(0,true));
  const aligned=await alignSegment(paired.event,(await materialized(storage,paired)),window(),'speech_candidate',maps,storage,align);
  const audioCap=capability({id:'audio',modalities:['audio'],joint_av:false});
  const offlineVisual=capability({id:'visual',modalities:['visual'],joint_av:false,healthy:false});
  const d=await new MediaProcessor(storage,new Map([['audio',new FeatureReplayWorker()]]),cfg)
    .process(aligned.segment,aligned.views,[audioCap,offlineVisual]);
  assert.equal(d.quality.status,'partial');assert.ok(d.quality.warnings.includes('MEDIA_MODALITY_UNAVAILABLE:visual'));
  assert.equal(aligned.segment.visual_refs.length,1);assert.equal((await archive.head(paired.event.raw_ref))?.chunks.length,2);
  const fresh=await alignSegment(paired.event,(await materialized(storage,paired)),window(1000,1090),'speech_candidate',maps,storage,align);
  await assert.rejects(new MediaProcessor(storage,new Map([['audio',new FeatureReplayWorker()]]),{...cfg,allow_partial:false})
    .process(fresh.segment,fresh.views,[audioCap,offlineVisual]),/NO_COMPLIANT_MEDIA_CAPABILITY/);
});
test('D published during another request capability await is rechecked before duplicate model work',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  let entered!:()=>void;const held=new Promise<void>(r=>entered=r);let release!:()=>void;const wait=new Promise<void>(r=>release=r);
  let calls=0;const worker:WorkerPort={analyze:async(request,signal)=>{calls++;return new FeatureReplayWorker().analyze(request,signal);}};
  const processor=new MediaProcessor(storage,new Map([['feature',worker]]),cfg);
  const delayed=processor.process(aligned.segment,aligned.views,async()=>{entered();await wait;return [capability()];});
  await held;const first=await processor.process(aligned.segment,aligned.views,[capability()]);release();
  assert.deepEqual(await delayed,first);assert.equal(calls,1);
});

test('E10 close joins actual worker after timeout and rejects fresh processing',async t=>{
  const {archive,storage}=await fixture(t);const audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,(await materialized(storage,audio)),window(),'speech_candidate',[maps[0]!],storage,align);
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let signal:AbortSignal|undefined;
  const worker:WorkerPort={analyze:async(_request,abort)=>{signal=abort;entered.resolve();await finish.promise;throw new Error('settled');}};
  const processor=new MediaProcessor(storage,new Map([['feature',worker]]),{...cfg,max_inflight:1,timeout_ms:1});
  const request=processor.process(aligned.segment,aligned.views,[capability({modalities:['audio']})]);
  const failed=assert.rejects(request,/ALL_MEDIA_WORKERS_FAILED/);
  try {
    await entered.promise;await failed;
    let settled=false;const closing=processor.close();assert.equal(processor.close(),closing);
    void closing.then(()=>{settled=true;});await Promise.resolve();
    assert.equal(settled,false);assert.equal(signal?.aborted,true);
    await assert.rejects(processor.process(aligned.segment,aligned.views,[capability()]),/MEDIA_PROCESSOR_CLOSED/);
    finish.resolve();await closing;assert.equal(settled,true);
    assert.deepEqual(await storage.list('processed-media'),[]);
  } finally {finish.resolve();await processor.close();}
});


test('source admission precedes provider timeout and denial never dispatches or becomes a model failure',async t=>{
  const {archive,storage}=await fixture(t),audio=await archive.append(raw(pcm(true),false,'audio'),trusted,at,track(0));
  const aligned=await alignSegment(audio.event,await materialized(storage,audio),window(),'speech_candidate',[maps[0]!],storage,align);
  let calls=0;const worker:WorkerPort={analyze:async request=>{calls++;return new FeatureReplayWorker().analyze(request,new AbortController().signal);}};
  const processor=new MediaProcessor(storage,new Map([['feature',worker]]),{...cfg,timeout_ms:5});
  const denied=new Error('SOURCE_ADMISSION_DENIED');
  await assert.rejects(processor.process(aligned.segment,aligned.views,[capability()],1,null,undefined,async()=>{throw denied;}),error=>error===denied);
  assert.equal(calls,0);
  const result=await processor.process(aligned.segment,aligned.views,[capability()],1,null,undefined,async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
  assert.ok(result.processed_event_id);assert.equal(calls,1);
});
