import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSourceMediaClock,type SourceClockProvider,type SourceSpanDeclaration} from '../src/source-media-clock.ts';
import {createSourceMediaAdmission} from '../src/source-media-admission.ts';
import type {SourceMediaCaptureBinding,SourceMediaPermissionPort} from '../src/source-media-permission.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {StreamArchive,type TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {MediaService} from '../../../services/personal-aios-integration/src/media/service.ts';
import {MediaProcessor,type WorkerRequest,type WorkerPort} from '../../../services/personal-aios-integration/src/media/processing.ts';
import {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {RunAdmission} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {OutputAuthority} from '../../../services/personal-aios-integration/src/output.ts';
import {sha256,type RawEvent,type TrustedContext,type ArchivedEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {NativeClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
const base=Date.parse('2030-01-01T00:00:00.000Z');
const declaration:SourceSpanDeclaration={span_id:'controlled-owner-span',modalities:['audio','visual'],
  anchor_range:{kind:'instant',timebase_id:'capture-origin',stream_epoch:'source-span',at_ms:100}};
const audio=(seq=0):TrackChunk=>({track_id:'mic',stream_epoch:'audio-1',seq,modality:'audio',format:'pcm_s16le:16000:1',
  source_range:{kind:'interval',timebase_id:'pcm-ordinal',stream_epoch:'audio-1',start_ms:seq*100,end_ms:(seq+1)*100}});
const visual=(epoch='video-1',at=550):TrackChunk=>({track_id:'camera',stream_epoch:epoch,seq:0,modality:'visual',format:'png',
  source_range:{kind:'instant',timebase_id:'camera-pts',stream_epoch:epoch,at_ms:at}});
const png=await fs.readFile(new URL('../../../services/personal-aios-integration/tests/fixtures/continuous-coverage-rgba2x1.png',import.meta.url));
assert.equal(png.readUInt32BE(16),2);assert.equal(png.readUInt32BE(20),1);
async function fixture(t:test.TestContext){
  const root=process.env.SPAN_EVIDENCE_ROOT ?? tmpdir();
  const directory=await fs.mkdtemp(join(root,'controlled-'));
  const storage=new PosixStorage(join(directory,'storage'));
  const budget={max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:32,max_revisions:32,max_seq:32};
  const archive=new RawArchive(storage,10000,undefined,budget),streamArchive=new StreamArchive(storage,budget);
  const binding={userId:'owner',deviceId:'glasses',continuityId:'controlled-continuity'} as SourceMediaCaptureBinding;
  const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',channel:'controlled',submission:'observation'};
  Object.assign(trusted,{capabilities:['microphone','continuous_audio','camera','display'],route_version:'fixture',output_modes:['text']});
  let locked=false,denyVideo=false,permissionCalls=0,providerCalls=0;
  const provider:SourceClockProvider={evidence:'synthetic',resolveSpan:async()=>({modality:'audio',track_id:'span-origin',stream_epoch:'source-span',
    source_timebase_id:'capture-origin',target_timebase_id:'utc_epoch_ms',offset_ms:base-100+.25,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-independent-anchor'}),
    resolve:async(_binding,chunk)=>{providerCalls++;return {modality:chunk.modality,track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,
      source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',
      offset_ms:chunk.modality==='audio'?base+10:chunk.stream_epoch==='video-1'?base-500:base-900,
      drift_ppm:0,uncertainty_ms:2,basis_ref:'controlled-independent-track-proof'};}};
  const clock=createSourceMediaClock(storage,provider),span=await clock.sealSpan(binding,declaration);
  const permission:SourceMediaPermissionPort={read:async()=>assert.fail('NO_PERMISSION_PREFLIGHT'),withPermission:async(_binding,modality,consume)=>{
    permissionCalls++;if(modality==='video'&&denyVideo)throw new Error('MEDIA_MODALITY_NOT_AUTHORIZED');locked=true;
    try{return await consume({authorizedMediaUntil:new Date(base+10000).toISOString()} as never);}finally{locked=false;}}};
  let wait:Promise<void>|undefined;let illegalAudio=false,visualFailure=false;const requests:WorkerRequest[]=[];
  const worker:WorkerPort={analyze:async request=>{assert.equal(locked,false);requests.push(request);if(wait)await wait;if(visualFailure&&request.views.every(v=>v.modality==='visual'))throw new Error('CONTROLLED_VISUAL_FAILURE');
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{...(request.views.some(v=>v.modality==='audio')||illegalAudio?{audio_observations:['controlled bytes only']}:{}),
        ...(request.views.some(v=>v.modality==='visual')?{visual_observations:['controlled PNG only']}:{})},speakers:[],warnings:['NO_MODEL'],status:'partial'};}};
  const processor=new MediaProcessor(storage,new Map([['controlled',worker]]),{policy_version:'controlled',max_inflight:2,max_input_bytes:100000,
    timeout_ms:10000,allow_external:false,allow_replay:true,allow_partial:true});
  const service=new MediaService({storage,archive,streamArchive,processor,clockEvidence:'synthetic',authorizeClockMaps:clock.authorizeClockMaps,
    ...createSourceMediaAdmission({clock,permission,source:{capture:async()=>({binding,trusted})},requestTeardown:async()=>{}}),
    capabilities:async()=>[{id:'controlled',version:'fixture',modalities:['audio','visual'],formats:['png','pcm_s16le:16000:1'],joint_av:true,
      healthy:true,permitted:true,max_duration_ms:10000,execution:'local',evidence:'deterministic_replay'}],
    vad:{candidates:async request=>{assert.equal(request.time_range.kind,'interval');const range=request.time_range as {start_ms:number;end_ms:number};
      return [{start_ms:range.start_ms,end_ms:range.end_ms,semantic_status:'open',basis:'CONTROLLED_NOT_SILERO'}];}},
    align:{max_chunks:32,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:3},max_segments:4,max_window_ms:10000});
  let nativeCalls=0;const native:NativeClient={create:async(body,key)=>{nativeCalls++;return {run_id:`controlled-${key}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'completed'};},
    status:async id=>({run_id:id,session_id:'controlled-span-session',conversation_session_id:'controlled-span-session',status:'completed'}),
    cancel:async id=>({run_id:id,session_id:'controlled-span-session',conversation_session_id:'controlled-span-session',status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:10,native_idempotency_retention_ms:10000,policy_version:'controlled'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),media:service,
    devices:[{...trusted,route_version:'fixture',output_modes:['text'],token_sha256:sha256('controlled-token')}],skill:'controlled',max_read_bytes:100000});
  t.after(async()=>{await runtime.close();if(!process.env.SPAN_EVIDENCE_ROOT)await fs.rm(directory,{recursive:true,force:true});});const device=await runtime.authenticate('controlled-token');
  const raw=(chunk:TrackChunk):RawEvent=>({schema_version:'paios.event.v1',event_id:span.event_id,device_id:'glasses',device_type:'glasses',
    ...span.metadata,source:{channel:'controlled',capture_timing:span.capture_timing},media_type:span.media_type,
    mime:chunk.modality==='audio'?'audio/pcm':'image/png',representation:'received_decoded_sample',payload:chunk.modality==='audio'?Buffer.alloc(3200):png});
  const append=async(chunk:TrackChunk)=>{const sealed=await clock.captureTrack(binding,chunk,span);const result=await runtime.appendMedia(raw(sealed),device,sealed);
    return {...result,chunk:sealed};};
  const record=async(event:ArchivedEvent)=>{const result=await archive.readRecord(event.raw_ref,'owner',event.archive_revision);assert.equal(result.kind,'stream');
    if(result.kind!=='stream')assert.fail();return result;};
  const maps=async(event:ArchivedEvent)=>clock.archivedClockMaps(event,(await record(event)).manifest);
  let operation=0;const analyze=async(event:ArchivedEvent,revision=1,replaces:string|null=null)=>runtime.processMedia(device,'controlled-span-session',`span-op-${++operation}`,{raw_ref:event.raw_ref,archive_revision:event.archive_revision,
    revision,replaces,time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:base+10,end_ms:base+110},clock_maps:await maps(event)});
  const followup=async(event:ArchivedEvent,previous:string)=>runtime.processMedia(device,'controlled-span-session',`visual-op-${++operation}`,{
    raw_ref:event.raw_ref,archive_revision:event.archive_revision,previous_processed_event_ids:[previous],
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:base+10,end_ms:base+110},
    clock_maps:(await maps(event)).filter(map=>map.modality==='visual')});
  return {directory,storage,archive,clock,span,binding,provider,raw,append,record,maps,process:analyze,followup,requests,runtime,device,service,
    get nativeCalls(){return nativeCalls;},get permissionCalls(){return permissionCalls;},get providerCalls(){return providerCalls;},fakeAudio:()=>{illegalAudio=true;},failVisual:()=>{visualFailure=true;},deny:()=>{denyVideo=true;},hold:(gate:Promise<void>)=>{wait=gate;}};
}
test('source-owned span shares immutable L5 while clocks and track epochs remain independent; existing ALIGN/MEDIA selects AV',async t=>{
  const f=await fixture(t),a=await f.append(audio()),v=await f.append(visual());
  assert.equal(a.event.raw_ref,v.event.raw_ref);assert.equal(v.event.event_id,f.span.event_id);assert.equal(v.event.media_type,'livekit_tracks');
  assert.equal(v.event.captured_at,new Date(base).toISOString());assert.equal(v.event.source.capture_timing!.uncertainty_ms,1.25);
  assert.deepEqual((await f.maps(v.event)).map(m=>m.offset_ms).sort(),[base-500,base+10]);
  const result=await f.process(v.event);assert.equal(result.processed_events.length,1);
  assert.equal(f.requests[0]!.views.length,2);
  assert.deepEqual(f.requests[0]!.views.find(v=>v.modality==='visual')!.time_range,{kind:'instant',timebase_id:'utc_epoch_ms',at_ms:base+50});assert.equal(result.processed_events[0]!.source.capture_timing!.basis_ref,f.span.capture_timing.basis_ref);
  const rec=await f.record(v.event);assert.equal(rec.manifest.chunks.length,2);assert(rec.manifest.chunks.every(c=>c.clock_basis_ref));
  await fs.writeFile(join(f.directory,'result.json'),JSON.stringify({a:a.event,v:v.event,maps:await f.maps(v.event),d:result.processed_events},null,2));
});
test('slow controlled model does not hold raw append fence; delayed visual and new epoch cannot contaminate pinned audio revision',async t=>{
  const f=await fixture(t),a=await f.append(audio());const release=Promise.withResolvers<void>();f.hold(release.promise);
  const work=f.process(a.event);while(f.requests.length===0)await new Promise(resolve=>setTimeout(resolve,1));
  const v=await f.append(visual()),v2=await f.append(visual('video-2',950));await f.append(audio(1));
  assert.equal((await f.record(a.event)).manifest.chunks.length,1);assert.equal((await f.maps(a.event)).length,1);
  await assert.rejects(f.clock.authorizeClockMaps('owner',await f.maps(v.event),a.event,(await f.record(a.event)).manifest),/MEDIA_CLOCK_BASIS_DENIED/);
  await assert.rejects(f.clock.archivedClockMaps(a.event,(await f.record(v2.event)).manifest),/MEDIA_PINNED_TRACK_PROOFS_REQUIRED/);
  release.resolve();const old=await work;assert.equal(old.processed_events[0]!.archive_revision,a.event.archive_revision);
  assert.deepEqual(f.requests[0]!.views.map(v=>v.modality),['audio']);
  const fresh=await f.process(v2.event,2,old.processed_events[0]!.processed_event_id);assert.equal(f.requests.length,2,'late visual revision must produce a new source processing result');assert.equal(f.requests[1]!.views.filter(v=>v.modality==='visual').length,2);
  assert.equal(fresh.processed_events[0]!.segment_id,old.processed_events[0]!.segment_id);
  assert.equal(fresh.processed_events[0]!.revision,2);assert.equal(fresh.processed_events[0]!.replaces_processed_event_id,old.processed_events[0]!.processed_event_id);
  assert.equal(fresh.processed_events[0]!.segment_basis,'speech_candidate');
  assert.equal(fresh.processed_events[0]!.processing.reused_audio?.processed_event_id,old.processed_events[0]!.processed_event_id);
  assert.deepEqual(fresh.processed_events[0]!.content.audio_observations,old.processed_events[0]!.content.audio_observations);
  assert(f.requests[1]!.views.every(view=>view.modality==='visual'));assert.equal(await f.archive.validateEvidence(fresh.processed_events[0]!),true);
  assert.equal(fresh.processed_events[0]!.archive_revision,v2.event.archive_revision);assert.equal((await f.maps(v2.event)).length,3);
});
test('foreign proof, altered anchor, forged ref and same-epoch changed map fail; archived clock reads bypass fresh video permission/provider',async t=>{
  const f=await fixture(t),a=await f.append(audio()),v=await f.append(visual());
  const foreign=await f.clock.sealSpan(f.binding,{...declaration,span_id:'foreign-span'});
  const foreignChunk=await f.clock.captureTrack(f.binding,visual('video-2',950),foreign);
  await assert.rejects(f.runtime.appendMedia(f.raw(foreignChunk),f.device,foreignChunk),/MEDIA_CLOCK_BASIS_DENIED/);
  const otherBinding={...f.binding,deviceId:'other-device'};
  const otherSpan=await f.clock.sealSpan(otherBinding,declaration);
  const otherChunk=await f.clock.captureTrack(otherBinding,visual('video-2',950),otherSpan);
  await assert.rejects(f.runtime.appendMedia(f.raw(otherChunk),f.device,otherChunk),/MEDIA_CLOCK_BASIS_DENIED/);
  const forged={...v.chunk,seq:1,clock_basis_ref:'source-clock:'+'0'.repeat(64)};
  await assert.rejects(f.runtime.appendMedia(f.raw(forged),f.device,forged),/ENOENT/);
  await assert.rejects(f.runtime.appendMedia({...f.raw(v.chunk),captured_at:new Date(base+1).toISOString()},f.device,v.chunk),/MEDIA_CAPTURE_TIMING_MISMATCH/);
  const resolve=f.provider.resolve;f.provider.resolve=async(binding,chunk)=>({... (await resolve(binding,chunk))!,offset_ms:base+999});
  await assert.rejects(f.append({...visual(),seq:1}),/TRACK_DESCRIPTOR_CHANGED_WITHOUT_EPOCH/);
  const before=f.permissionCalls,reads=f.providerCalls;f.deny();
  await f.process(v.event);assert.equal(f.permissionCalls,before);assert.equal(f.providerCalls,reads);
  await assert.rejects(f.append(visual('video-2',950)),/MEDIA_MODALITY_NOT_AUTHORIZED/);
  assert.equal((await f.record(a.event)).manifest.chunks.length,1);
});
test('v1 pure audio archived capture remains valid without track proof; missing independent anchor cannot fabricate UTC',async t=>{
  const f=await fixture(t),chunk=audio();const timing=await f.clock.capture(f.binding,chunk);
  const {pcmEventId}=await import('../src/personal-aios-formal-pcm.ts');
  const raw:RawEvent={...f.raw(chunk),...timing.metadata,event_id:pcmEventId(f.binding.continuityId,chunk.stream_epoch),media_type:'audio',
    source:{channel:'controlled',capture_timing:timing.capture_timing}};
  const archived=await f.runtime.appendMedia(raw,f.device,chunk);const map=await f.clock.read(f.binding,chunk,raw);
  await f.clock.authorizeClockMaps('owner',[map!],archived.event);assert.equal((await f.record(archived.event)).manifest.chunks[0]!.clock_basis_ref,undefined);
  const missing=createSourceMediaClock(f.storage,{evidence:'synthetic',resolve:f.provider.resolve});
  await assert.rejects(missing.sealSpan(f.binding,declaration),/MEDIA_SPAN_CLOCK_PROVIDER_REQUIRED/);
});

// Supplemental actual existing pure-visual owner; it does not claim automatic joint revision is repaired.
test('actual Runtime preserves consumed audio D and publishes separately linked late visual D without replaying audio',async t=>{
 const f=await fixture(t),a=await f.append(audio());const old=await f.process(a.event);
 const v=await f.append(visual()),v2=await f.append(visual('video-2',950));
 const cached=await f.process(v2.event);assert.deepEqual(cached.processed_events,old.processed_events);assert.equal(f.requests.length,1);
 const related=await f.followup(v2.event,old.processed_events[0]!.processed_event_id);
 assert.equal(f.requests.length,2);assert(f.requests[1]!.views.every(view=>view.modality==='visual'));
 const d=related.processed_events[0]!;assert.equal(d.archive_revision,v2.event.archive_revision);
 assert.equal(d.raw_ref,old.processed_events[0]!.raw_ref);assert.equal(d.user_identity,'unknown');assert.equal(d.intent_class,'observation');
 assert(d.continuation!.previous_processed_event_ids.includes(old.processed_events[0]!.processed_event_id));
 assert.equal(await f.archive.validateEvidence(d),true);
 assert.equal((await f.record(v.event)).manifest.chunks.length,2);assert.equal((await f.record(v2.event)).manifest.chunks.length,3);
});

test('AV revision2 and3 keep exact predecessor chain and replay no workers or new consumption',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event),v=await f.append(visual());
 const second=await f.process(v.event,2,first.processed_events[0]!.processed_event_id),replay=await f.process(v.event,2,first.processed_events[0]!.processed_event_id);
 assert.deepEqual(replay.processed_events,second.processed_events);assert.equal(f.requests.length,2);
 const v2=await f.append(visual('video-2',950)),third=await f.process(v2.event,3,second.processed_events[0]!.processed_event_id);
 const d=third.processed_events[0]!;assert.equal(d.revision,3);assert.equal(d.replaces_processed_event_id,second.processed_events[0]!.processed_event_id);
 assert.equal(d.segment_id,first.processed_events[0]!.segment_id);assert.equal(d.processing.reused_audio!.processed_event_id,first.processed_events[0]!.processed_event_id);
 assert.equal(f.requests.filter(r=>r.views.some(v=>v.modality==='audio')).length,1);assert.equal((await f.storage.list('audio-consumer-accepted')).length,1);
 assert.equal((await f.storage.list('audio-consumer-results')).length,1);assert.equal(await f.archive.validateEvidence(d),true);
});
test('AV revision cannot change source window or predecessor or invent a new visual cause',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event);
 await assert.rejects(f.process(a.event,2,first.processed_events[0]!.processed_event_id),/MEDIA_REVISION_WITHOUT_NEW_VISUAL_CONTEXT/);
 const v=await f.append(visual());await assert.rejects(f.process(v.event,2,'processed:'+'a'.repeat(64)),/MEDIA_REPLACES_MISMATCH/);
 await assert.rejects(f.runtime.processMedia(f.device,'controlled-span-session','shifted-source-window',{...v.event,
  revision:2,replaces:first.processed_events[0]!.processed_event_id,
  time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:base+20,end_ms:base+110},clock_maps:await f.maps(v.event)}),/MEDIA_REVISION_PREDECESSOR_REQUIRED/);
 assert.equal(f.requests.length,1);assert.equal((await f.storage.list('processed-media')).length,1);
});
test('missing typed cached audio evidence rejects AV revision instead of new visual observation',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event),v=await f.append(visual());
 const key=await f.storage.list('processed-media-inputs'),read=f.storage.read.bind(f.storage);
 f.storage.read=async(namespace,k)=>{
  const bytes=await read(namespace,k);if(namespace==='processed-media-inputs'&&k===key[0]){
   const value=JSON.parse(Buffer.from(bytes).toString());delete value.selected_views;return Buffer.from(JSON.stringify(value));}return bytes;};
 await assert.rejects(f.process(v.event,2,first.processed_events[0]!.processed_event_id),/MEDIA_AUDIO_REUSE_INPUT_MISMATCH/);
 f.storage.read=read;assert.equal(f.requests.length,1);assert.equal((await f.storage.list('processed-media')).length,1);
});
test('cached PCM metadata selfhash cannot substitute different actual received PCM',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event),v=await f.append(visual());
 const key=await f.storage.list('processed-media-inputs'),read=f.storage.read.bind(f.storage);
 f.storage.read=async(namespace,k)=>{const bytes=await read(namespace,k);if(namespace==='processed-media-inputs'&&k===key[0]){
  const value=JSON.parse(Buffer.from(bytes).toString());value.selected_views[0].pcm_selection.selected_sha256='f'.repeat(64);
  value.selected_input_sha256=(await import('../../../services/personal-aios-integration/src/contracts.ts')).digest({input_contract:value.input_contract,views:value.selected_views});
  return Buffer.from(JSON.stringify(value));}return bytes;};
 await assert.rejects(f.process(v.event,2,first.processed_events[0]!.processed_event_id),/MEDIA_AUDIO_REUSE_INPUT_MISMATCH|MEDIA_AUDIO_REUSE_RAW_MISMATCH/);
 f.storage.read=read;assert.equal(f.requests.length,1);
});
test('fresh visual worker cannot claim another audio result; prior D stays intact',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event),v=await f.append(visual());f.fakeAudio();
 await assert.rejects(f.process(v.event,2,first.processed_events[0]!.processed_event_id),/ALL_MEDIA_WORKERS_FAILED/);
 assert.equal((await f.storage.list('processed-media')).length,1);assert(f.requests[1]!.views.every(view=>view.modality==='visual'));
});
test('AV revision final EIO produces no new D; original audio result remains authoritatively consumed',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event),v=await f.append(visual()),publish=f.storage.publish.bind(f.storage);
 f.storage.publish=async(namespace,key,bytes)=>{if(namespace==='processed-media'&&JSON.parse(Buffer.from(bytes).toString()).revision===2)throw new Error('AV_FINAL_EIO');return publish(namespace,key,bytes);};
 await assert.rejects(f.process(v.event,2,first.processed_events[0]!.processed_event_id),/AV_FINAL_EIO/);f.storage.publish=publish;
 assert.equal((await f.storage.list('processed-media')).length,1);assert.equal((await f.storage.list('audio-consumer-results')).length,1);
 const old=await f.process(a.event);assert.deepEqual(old.processed_events,first.processed_events);assert.equal(f.requests.filter(r=>r.views.some(v=>v.modality==='audio')).length,1);
});
test('AV revision proof tampering is rejected by original archive source validation',async t=>{
 const f=await fixture(t),a=await f.append(audio()),first=await f.process(a.event),v=await f.append(visual()),second=await f.process(v.event,2,first.processed_events[0]!.processed_event_id);
 const d=structuredClone(second.processed_events[0]!);d.processing.reused_audio!.processed_sha256='a'.repeat(64);
 assert.equal(await f.archive.validateEvidence(d),false);
 const changed=structuredClone(second.processed_events[0]!);changed.content.audio_observations=['FORGED'];assert.equal(await f.archive.validateEvidence(changed),false);
});
