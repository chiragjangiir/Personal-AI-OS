import {materialized} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAIOSRuntime } from './native-source-fixture.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { sha256, digest, type RawEvent, type TrustedContext, type TimeRange } from '../src/contracts.ts';
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
async function fixture(t:test.TestContext, worker=defaultWorker, override:Partial<MediaServiceConfig>={}) {
  const directory=await mkdtemp(join(tmpdir(),'paios-media-service-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage=new PosixStorage(directory);
  const budget={max_chunk_bytes:10000,max_total_bytes:100000,max_chunks:20,max_revisions:20,max_seq:20};
  const archive=new RawArchive(storage,10000,undefined,budget);
  const streamArchive=new StreamArchive(storage,budget);
  const processor=new MediaProcessor(storage,new Map([['controlled',worker]]),{policy_version:'service-fixture',max_inflight:2,
    max_input_bytes:100000,timeout_ms:500,allow_external:false,allow_replay:true,allow_partial:true});
  const config:MediaServiceConfig={storage,archive,streamArchive,processor,capabilities:async()=>[cap],vad,
    align:{max_chunks:20,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:4,max_window_ms:200,
    fixtureOnly:true,...override};
  return {storage,archive,processor,service:new MediaService(config),config};
}
test('actual archived independent PCM/PNG produce open D with pinned revision; append continues while analysis waits',async t=>{
  let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);let release!:()=>void;const wait=new Promise<void>(r=>release=r);
  const worker:WorkerPort={analyze:async(request,signal)=>{enter();await wait;return defaultWorker.analyze(request,signal);}};
  let locked=false, admissions=0;
  const f=await fixture(t,worker,{withAppendAdmission:async(_raw,_trusted,_chunk,append)=>{
    assert.equal(locked,false);locked=true;admissions++;
    try{return await append();}finally{locked=false;}
  }});
  const publishIngress=f.storage.publishIngress.bind(f.storage);
  f.storage.publishIngress=async(...args)=>{
    assert.equal(locked,true);
    const result=await publishIngress(...args);assert.equal(locked,true);return result;
  };
  await f.service.append(raw(),trusted,chunk());
  const pinned=await f.service.append(raw(true),trusted,chunk(0,true));
  const pending=f.service.process('owner',{raw_ref:pinned.event.raw_ref,archive_revision:pinned.event.archive_revision,
    time_range:window,clock_maps:maps});await entered;
  assert.equal(locked,false); // Mock model waits after the real durable append fence has released.
  const later=await f.service.append(raw(),trusted,chunk(1));assert.equal((await materialized(f.storage,later)).chunks.length,3);
  assert.equal(admissions,3);assert.equal(locked,false);
  release();const result=await pending;assert.equal(result.processed_events.length,1);
  const d=result.processed_events[0]!;assert.equal(d.archive_revision,pinned.event.archive_revision);
  assert.equal(d.origin,'device_observation');assert.equal(d.user_identity,'unknown');assert.equal(d.continuation_hint,'open');
  assert.equal(d.quality.status,'partial');assert.ok(d.quality.warnings.includes('SYNTHETIC_FIXTURE_CLOCK_MAPS_NOT_HARDWARE_CALIBRATION'));
  assert.equal(await f.archive.validateEvidence(d),true);assert.equal((await f.storage.list('processed-media')).length,1);
});
test('silence returns no_segments and no D, while original tracks remain durable',async t=>{
  const f=await fixture(t,defaultWorker,{vad:{candidates:async()=>[]}});
  const archived=await f.service.append(raw(),trusted,chunk());
  const result=await f.service.process('owner',{raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
    time_range:window,clock_maps:[maps[0]!]});assert.equal(result.status,'no_segments');
  assert.deepEqual(result.processed_events,[]);assert.deepEqual(await f.storage.list('processed-media'),[]);
  assert.equal((await f.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision)).kind,'stream');
});
test('pure visual skips VAD, current CAP failure retains archive, and forged scope/revision reject',async t=>{
  let calls=0;
  const worker:WorkerPort={analyze:async request=>{calls++;return {...await defaultWorker.analyze(request,new AbortController().signal),
    content:{visual_observations:['controlled visual']}};}};
  const f=await fixture(t,worker,{vad:{candidates:async()=>{throw new Error('must not call VAD');}}});
  const archived=await f.service.append(raw(true),trusted,chunk(0,true));
  const request={raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
    time_range:{kind:'instant' as const,timebase_id:'fixture-common',at_ms:50},clock_maps:[maps[1]!]};
  const result=await f.service.process('owner',request);assert.equal(result.processed_events[0]?.segment_basis,'still_image');
  assert.equal(calls,1);
  const disabled=new MediaService({...f.config,capabilities:async()=>[{...cap,permitted:false}]});
  assert.deepEqual((await disabled.process('owner',request)).processed_events,result.processed_events);
  await assert.rejects(disabled.process('owner',{...request,revision:2,replaces:result.processed_events[0]!.processed_event_id}),
    /NO_COMPLIANT_MEDIA_CAPABILITY/);
  await assert.rejects(f.service.process('other',request),/ACCESS_DENIED/);
  await assert.rejects(f.service.process('owner',{...request,archive_revision:digest('wrong')}),/REVISION/);
});
test('production permission and clock authorities must be configured; unsupported muxed container does not get guessed',async t=>{
  const f=await fixture(t);const production=new MediaService({...f.config,fixtureOnly:false});
  await assert.rejects(production.append(raw(),trusted,chunk()),/MEDIA_AUTHORITY_NOT_CONFIGURED/);
  assert.deepEqual(await f.storage.list('stream-revisions'),[]);
  await assert.rejects(f.service.append({...raw(),media_type:'muxed_av'},trusted,chunk()),/MUXED_CONTAINER_UNSUPPORTED/);
  const archived=await f.service.append(raw(),trusted,chunk());
  await assert.rejects(production.process('owner',{raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
    time_range:window,clock_maps:[maps[0]!]}),/CLOCK_AUTHORITY_NOT_CONFIGURED/);
});
test('source cancellation aborts worker, retains archive and publishes no analyzed D',async t=>{
  let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);
  const worker:WorkerPort={analyze:async(_request,signal)=>{enter();return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('source worker exited')),{once:true});});}};
  const f=await fixture(t,worker);const archived=await f.service.append(raw(),trusted,chunk());const cancel=new AbortController();
  const pending=f.service.process('owner',{raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
    time_range:window,clock_maps:[maps[0]!]},cancel.signal);await entered;cancel.abort();
  await assert.rejects(pending,/MEDIA_CANCELLED/);assert.deepEqual(await f.storage.list('processed-media'),[]);
  assert.equal((await f.archive.readRecord(archived.event.raw_ref,'owner',archived.event.archive_revision)).kind,'stream');
});
test('VAD cannot consume an unsealed filtered request and byte budgets apply before inference',async t=>{
  const f=await fixture(t);await f.service.append(raw(),trusted,chunk());const archived=await f.service.append(raw(true),trusted,chunk(0,true));
  const {alignSegment}=await import('../src/media/align.ts');
  const aligned=await alignSegment(archived.event,(await materialized(f.storage,archived)),window,'speech_candidate',maps,f.storage,f.config.align);
  await assert.rejects(f.processor.prepareRequest(aligned.segment,aligned.views.filter(v=>v.chunk.modality==='audio')),
    /MEDIA_INPUT_SCOPE_MISMATCH/);
  const small=new MediaProcessor(f.storage,new Map([['controlled',defaultWorker]]),{...f.processor.config,max_input_bytes:100});
  await assert.rejects(small.prepareRequest(aligned.segment,aligned.views),/MODEL_INPUT_BUDGET_EXCEEDED/);
});


test('runtime close aborts and joins actual media worker/storage lifetime',async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let aborted=false;
  const worker:WorkerPort={analyze:async(request,signal)=>{
    entered.resolve();signal.addEventListener('abort',()=>{aborted=true;},{once:true});
    await release.promise;return defaultWorker.analyze(request,signal);
  }};
  const f=await fixture(t,worker);const native={create:async()=>{throw new Error('unexpected create');},
    status:async()=>{throw new Error('unexpected status');},cancel:async()=>{throw new Error('unexpected cancel');}};
  const admission=new RunAdmission(f.storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'shutdown'});
  const runtime=new PersonalAIOSRuntime({storage:f.storage,archive:f.archive,admission,native,output:new OutputAuthority(f.storage),
    media:f.service,skill:'fixed',max_read_bytes:10000,devices:[{...trusted,token_sha256:sha256('fixture-token'),route_version:'1',output_modes:['text']}]});
  const device=await runtime.authenticate('fixture-token');
  const archived=await f.service.append(raw(true),trusted,chunk(0,true));
  const request={raw_ref:archived.event.raw_ref,archive_revision:archived.event.archive_revision,
    time_range:{kind:'instant' as const,timebase_id:'fixture-common',at_ms:50},clock_maps:[maps[1]!]};
  const operation=runtime.processMedia(device,'session','op',request);const rejected=assert.rejects(operation,/MEDIA_CANCELLED/);
  try {
    await entered.promise;let settled=false;const closing=runtime.close();assert.equal(runtime.close(),closing);
    void closing.then(()=>{settled=true;});await Promise.resolve();assert.equal(aborted,true);assert.equal(settled,false);
    await assert.rejects(runtime.processMedia(device,'session','new',request),/RUNTIME_CLOSED/);
    release.resolve();await rejected;await closing;assert.equal(settled,true);
    assert.deepEqual(await f.storage.list('processed-media'),[]);assert.deepEqual(await f.storage.list('admissions'),[]);
  } finally {release.resolve();await runtime.close();}
});

test('direct service close aborts VAD, joins its lifetime and the shared local owner', async t => {
  const entered = Promise.withResolvers<void>();
  const releaseVad = Promise.withResolvers<void>();
  const releaseLocal = Promise.withResolvers<void>();
  let aborted = false, localCloses = 0, reentrant: Promise<void> | undefined;
  const f = await fixture(t, defaultWorker, {
    localExecution: {close: () => { localCloses++; return releaseLocal.promise; }},
    vad: {candidates: async (_request, signal) => {
      signal.addEventListener('abort', () => { aborted = true; reentrant = f.service.close(); }, {once: true});
      entered.resolve();
      await releaseVad.promise;
      return [{start_ms: 0, end_ms: 100, semantic_status: 'open', basis: 'controlled'}];
    }}
  });
  const archived = await f.service.append(raw(), trusted, chunk());
  const request = {raw_ref: archived.event.raw_ref, archive_revision: archived.event.archive_revision,
    time_range: window, clock_maps: [maps[0]!]};
  const operation = f.service.process('owner', request);
  const rejected = assert.rejects(operation, /MEDIA_CANCELLED/);
  try {
    await entered.promise;
    const closing = f.service.close();
    assert.equal(f.service.close(), closing);
    assert.equal(reentrant, closing);
    assert.equal(aborted, true);
    assert.equal(localCloses, 1);
    let settled = false;
    void closing.then(() => { settled = true; });
    await assert.rejects(f.service.process('owner', request), /MEDIA_SERVICE_CLOSED/);
    assert.equal(settled, false);
    releaseVad.resolve();
    await rejected;
    assert.equal(settled, false);
    releaseLocal.resolve();
    await closing;
    assert.equal(settled, true);
    assert.deepEqual(await f.storage.list('processed-media'), []);
    assert.equal((await f.archive.readRecord(request.raw_ref, 'owner', request.archive_revision)).kind, 'stream');
  } finally {
    releaseVad.resolve(); releaseLocal.resolve();
    await f.service.close();
  }
});

test('reentrant close in the first archive lookup joins work before processor admission', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let vadCalls = 0, closing: Promise<void> | undefined, settled = false;
  const f = await fixture(t, defaultWorker, {vad: {candidates: async () => { vadCalls++; return []; }}});
  const archived = await f.service.append(raw(), trusted, chunk());
  const read = f.archive.readRecord.bind(f.archive);
  f.archive.readRecord = async (...args) => {
    closing = f.service.close();
    void closing.then(() => { settled = true; });
    entered.resolve();
    await release.promise;
    return read(...args);
  };
  const operation = f.service.process('owner', {raw_ref: archived.event.raw_ref,
    archive_revision: archived.event.archive_revision, time_range: window, clock_maps: [maps[0]!]});
  const rejected = assert.rejects(operation, /MEDIA_CANCELLED/);
  try {
    await entered.promise;
    assert.equal(f.service.close(), closing);
    assert.equal(settled, false);
    release.resolve();
    await rejected;
    await closing;
    assert.equal(settled, true);
    assert.equal(vadCalls, 0);
    assert.deepEqual(await f.storage.list('processed-media'), []);
  } finally { release.resolve(); await f.service.close(); }
});

test('close joins admitted append publication and fences new collection writes', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(t);
  const publish = f.storage.publish.bind(f.storage);
  f.storage.publish = async (namespace, key, bytes) => {
    if (namespace === 'objects') { entered.resolve(); await release.promise; }
    return publish(namespace, key, bytes);
  };
  const operation = f.service.append(raw(), trusted, chunk());
  try {
    await entered.promise;
    let settled = false;
    const closing = f.service.close();
    void closing.then(() => { settled = true; });
    await assert.rejects(f.service.append(raw(), trusted, chunk(1)), /MEDIA_SERVICE_CLOSED/);
    assert.equal(settled, false);
    release.resolve();
    const archived = await operation;
    await closing;
    assert.equal(settled, true);
    const record = await f.archive.readRecord(archived.event.raw_ref, 'owner', archived.event.archive_revision);
    assert.equal(record.kind, 'stream');
    assert.equal(record.total_bytes, pcm.length);
  } finally { release.resolve(); await f.service.close(); }
});

test('service snapshots C request before asynchronous archive lookup', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(t);
  const archived = await f.service.append(raw(), trusted, chunk());
  const read = f.archive.readRecord.bind(f.archive);
  f.archive.readRecord = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
  const request = {raw_ref: archived.event.raw_ref, archive_revision: archived.event.archive_revision,
    time_range: structuredClone(window), clock_maps: [structuredClone(maps[0]!)]};
  const operation = f.service.process('owner', request);
  try {
    await entered.promise;
    request.clock_maps.length = 0;
    request.archive_revision = 'mutated-after-admission';
    if (request.time_range.kind === 'interval') request.time_range.end_ms = 50;
    release.resolve();
    const result = await operation;
    assert.equal(result.archive_revision, archived.event.archive_revision);
    assert.deepEqual(result.processed_events[0]!.time_range, window);
  } finally { release.resolve(); await f.service.close(); }
});

test('local close failure is reported only after admitted VAD work has joined', async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(t, defaultWorker, {
    localExecution: {close: () => { throw new Error('controlled resource cleanup failure'); }},
    vad: {candidates: async () => { entered.resolve(); await release.promise; return []; }}
  });
  const archived = await f.service.append(raw(), trusted, chunk());
  const operation = f.service.process('owner', {raw_ref: archived.event.raw_ref,
    archive_revision: archived.event.archive_revision, time_range: window, clock_maps: [maps[0]!]});
  const rejected = assert.rejects(operation, /MEDIA_CANCELLED/);
  try {
    await entered.promise;
    const closing = f.service.close();
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    const failedClose = assert.rejects(closing, /controlled resource cleanup failure/);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    release.resolve();
    await rejected; await failedClose;
    assert.equal(settled, true);
  } finally { release.resolve(); await f.service.close().catch(() => {}); }
});
