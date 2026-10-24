import {materialized,webdav} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive,type TrackChunk,type StreamReadOptions} from '../src/stream-archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {EVENT_SCHEMA,canonical,digest,sha256,type RawEvent,type TrustedContext,type ProcessedEvent} from '../src/contracts.ts';
import {alignSegment} from '../src/media/align.ts';
import {MediaProcessor,FeatureReplayWorker} from '../src/media/processing.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
const at='2026-10-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'livekit',consent_ref:'consent',submission:'observation'};
const budget={max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:64,max_revisions:64,max_seq:100};
const raw=(payload=new Uint8Array(200)):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:'stream',device_id:'glasses',device_type:'glasses',
  captured_at:at,source:{channel:'livekit'},media_type:'livekit_tracks',mime:'audio/pcm',representation:'received_decoded_sample',payload});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'e1',seq,modality:'audio',format:'pcm_s16le:1000:1',
  source_range:{kind:'interval',timebase_id:'audio_pts',stream_epoch:'e1',start_ms:seq*100,end_ms:(seq+1)*100}});
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'paios-unified-read-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));const storage=new PosixStorage(root);
  return {root,storage,original:new RawArchive(storage,4096,()=>at,budget),stream:new StreamArchive(storage,budget)};}
async function processMedia(f:Awaited<ReturnType<typeof fixture>>,event:Awaited<ReturnType<StreamArchive['append']>>,end=100){
  const aligned=await alignSegment(event.event,(await materialized(f.storage,event)),{kind:'interval',timebase_id:'capture',start_ms:0,end_ms:end},'speech_candidate',
    [{modality:'audio',track_id:'mic',stream_epoch:'e1',source_timebase_id:'audio_pts',target_timebase_id:'capture',offset_ms:0,drift_ppm:0,
      uncertainty_ms:0,basis_ref:'clock-calibration'}],f.storage,{max_chunks:64,max_visual_refs:64,max_frame_gap_ms:100,max_uncertainty_ms:10});
  return new MediaProcessor(f.storage,new Map([['replay',new FeatureReplayWorker()]]),{
    policy_version:'test-replay',max_inflight:2,max_input_bytes:65536,timeout_ms:1000,allow_external:false,allow_replay:true,allow_partial:true},()=>at)
    .process(aligned.segment,aligned.views,[{id:'replay',version:'1',modalities:['audio'],formats:['pcm_s16le:1000:1'],joint_av:false,
      healthy:true,permitted:true,max_duration_ms:1000,execution:'local',evidence:'deterministic_replay'}]);
}
test('unified original read verifies actual metadata, bytes, revision and owner; original byte API stays exact',async t=>{
  const f=await fixture(t);
  const context={...trusted,submission:'explicit_text' as const};
  const d=await new UnifiedIngress(f.original).accept({...raw(Buffer.from('exact original')),media_type:'text',mime:'text/plain;charset=utf-8'},context);
  const record=await f.original.readRecord(d.raw_ref,'owner',d.archive_revision);
  assert.equal(record.kind,'original');assert.equal(record.event.user_identity,'owner');
  assert.deepEqual(await f.original.read(d.raw_ref,'owner',d.archive_revision),Buffer.from('exact original'));
  assert.equal(await f.original.validateEvidence(d),true);
  assert.equal((await f.original.locate(d.raw_ref,'owner')).archive_revision,d.archive_revision);
  assert.equal(await f.original.validateEvidence({...d,bytes:d.bytes+1}),false);
  assert.equal(await f.original.validateEvidence({...d,device_id:'forged'}),false);
  await assert.rejects(f.original.readRecord(d.raw_ref,'other',d.archive_revision),/RAW_ACCESS_DENIED/);
  await assert.rejects(f.original.readRecord(d.raw_ref,'owner','a'.repeat(64)),/ARCHIVE_REVISION_CONFLICT/);
  await assert.rejects(f.original.readRecord(d.raw_ref,'owner',d.archive_revision,{maxReadBytes:2}),/RAW_READ_BUDGET_EXCEEDED/);
  const pressure=new PosixStorage(f.storage.root,{min_free_bytes:Number.MAX_SAFE_INTEGER}),owner=new RawArchive(pressure,4096,()=>at,budget);
  t.after(async()=>{await owner.close();await pressure.close();});
  await assert.rejects(pressure.publish('objects',sha256('new input'),Buffer.from('new input')),/DISK_RESERVE_EXHAUSTED/);
  await owner.delete(d.raw_ref,'owner');
  await assert.rejects(owner.read(d.raw_ref,'owner',d.archive_revision),/RAW_DELETED/);
  assert.ok(!(await pressure.listHot('objects')).includes(d.payload_sha256),'owner cleanup is still available below the capture reserve floor');
});
test('stream D evidence reads current pinned raw chunks and immutable old revision after late frame',async t=>{
  const f=await fixture(t),first=await f.stream.append(raw(),trusted,at,chunk(0));
  const d=await processMedia(f,first);
  assert.equal(await f.original.validateEvidence(d),true);
  assert.equal(d.user_identity,'unknown');assert.equal(d.origin,'device_observation');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4xkAAAAASUVORK5CYII=','base64');
  const later=await f.stream.append({...raw(png),mime:'image/png'},trusted,at,{track_id:'camera',stream_epoch:'v1',seq:0,modality:'visual',format:'png',
    source_range:{kind:'instant',timebase_id:'video_pts',stream_epoch:'v1',at_ms:50}});
  const old=await f.original.readRecord(first.event.raw_ref,'owner',first.event.archive_revision);
  const current=await f.original.readRecord(later.event.raw_ref,'owner',later.event.archive_revision);
  assert.equal(old.kind,'stream');assert.equal(current.kind,'stream');
  if(old.kind!=='stream'||current.kind!=='stream')throw new Error('not stream');
  assert.equal(old.manifest.revision,1);assert.equal(old.chunks.length,1);assert.equal(current.chunks.length,2);
  assert.deepEqual(Uint8Array.from(old.chunks[0]!.bytes),new Uint8Array(200));
  const located=await f.original.locate(first.event.raw_ref,'owner');
  assert.equal(located.archive_revision,later.event.archive_revision);
  assert.equal(located.bytes,later.event.bytes);
  await assert.rejects(f.original.locate(first.event.raw_ref,'other'),/RAW_ACCESS_DENIED/);
  assert.equal(current.chunks[1]!.source_ref,`l5-object:${current.chunks[1]!.chunk.object_hash}`);
  assert.equal(await f.original.validateEvidence(d),true);
  await assert.rejects(f.original.read(first.event.raw_ref,'owner',first.event.archive_revision),/STREAM_REQUIRES_RECORD_READ/);
  await assert.rejects(f.original.readRecord(first.event.raw_ref,'other',first.event.archive_revision),/RAW_ACCESS_DENIED/);
  const forged={...d,archive_revision:later.event.archive_revision,processing:{...d.processing,archive_revision:later.event.archive_revision}};
  assert.equal(await f.original.validateEvidence(forged),false);
});
test('locate reads no original or stream payload and fences deletion during metadata lookup',async t=>{
  const f=await fixture(t),original=await f.original.archive({...raw(Buffer.from('original')),event_id:'lookup-original',media_type:'text',mime:'text/plain;charset=utf-8'},
    {...trusted,submission:'explicit_text'}),stream=(await f.stream.append(raw(),trusted,at,chunk(0))).event;
  const read=f.storage.read.bind(f.storage);let deleteDuringRead=false;
  t.mock.method(f.storage,'read',async(namespace:string,key:string)=>{
    assert.notEqual(namespace,'objects','a lookup must not load payload bytes');
    const bytes=await read(namespace,key);
    if(deleteDuringRead&&namespace==='manifests'&&key===original.raw_ref.slice(3)){
      deleteDuringRead=false;
      await f.storage.publish('owner-deletions',key,Buffer.from(canonical({raw_ref:original.raw_ref,principal_id:'owner',objects:[original.payload_sha256]})));
    }
    return bytes;
  });
  assert.deepEqual(await f.original.locate(original.raw_ref,'owner'),original);
  assert.deepEqual(await f.original.locate(stream.raw_ref,'owner'),stream);
  await assert.rejects(f.original.locate('l5:invalid','owner'),/INVALID_RAW_REF/);
  for(const ref of [original.raw_ref,stream.raw_ref])await assert.rejects(f.original.locate(ref,'other'),/RAW_ACCESS_DENIED/);
  const key=original.raw_ref.slice(3),stored=await read('manifests',key);
  await f.storage.replace('manifests',key,Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(stored).toString()),fingerprint:'f'.repeat(64)})));
  await assert.rejects(f.original.locate(original.raw_ref,'owner'),/ARCHIVE_MANIFEST_INVALID/);
  await f.storage.replace('manifests',key,stored);
  deleteDuringRead=true;
  await assert.rejects(f.original.locate(original.raw_ref,'owner'),/RAW_DELETED/);
  await assert.rejects(f.original.locate(original.raw_ref,'owner'),/RAW_DELETED/);
});
test('selected range returns complete original PCM chunks under caller budget; never concatenates dual tracks',async t=>{
  const f=await fixture(t);await f.stream.append(raw(),trusted,at,chunk(0));
  const second=await f.stream.append(raw(new Uint8Array(200).fill(1)),trusted,at,chunk(1));
  const selected=await f.original.readRecord(second.event.raw_ref,'owner',second.event.archive_revision,{
    maxReadBytes:200,track_ids:['mic'],source_range:{kind:'interval',timebase_id:'audio_pts',stream_epoch:'e1',start_ms:125,end_ms:175}});
  assert.equal(selected.kind,'stream');if(selected.kind!=='stream')throw new Error('not stream');
  assert.equal(selected.total_bytes,400);assert.equal(selected.selected_bytes,200);assert.equal(selected.chunks.length,1);
  assert.equal(selected.chunks[0]!.chunk.seq,1);assert.equal(selected.chunks[0]!.bytes.length,200);
  assert.deepEqual(selected.selection,{semantics:'whole_chunks_overlap',track_ids:['mic'],
    source_range:{kind:'interval',timebase_id:'audio_pts',stream_epoch:'e1',start_ms:125,end_ms:175}});
  await assert.rejects(f.original.readRecord(second.event.raw_ref,'owner',second.event.archive_revision,{maxReadBytes:200}),/RAW_READ_BUDGET_EXCEEDED/);
  const d=await processMedia(f,second,200);
  assert.equal(await f.original.validateEvidence(d),true);
  assert.equal(await f.original.validateEvidence({...d,payload_sha256:'f'.repeat(64)}),false);
  assert.equal(await f.original.validateEvidence({...d,segment_id:'forged'}),false);
  assert.equal(await f.original.validateEvidence({...d,time_range:{kind:'interval',timebase_id:'capture',start_ms:0,end_ms:400}}),false);
});
test('selection validation belongs to archive authority and finite originals reject unsupported selectors',async t=>{
  const f=await fixture(t),event=await f.stream.append(raw(),trusted,at,chunk(0));
  const read=(options:any)=>f.original.readRecord(event.event.raw_ref,'owner',event.event.archive_revision,options);
  for(const track_ids of [null,'mic',[],['mic','mic'],Array.from({length:65},(_,i)=>`track${i}`)])
    await assert.rejects(read({track_ids}),/INVALID_TRACK_SELECTION/);
  await assert.rejects(read({track_ids:['missing']}),/STREAM_TRACK_NOT_FOUND/);
  for(const source_range of [null,[],{kind:'interval',timebase_id:'audio_pts',start_ms:20,end_ms:10},
    {kind:'instant',timebase_id:'audio_pts',at_ms:Infinity}])
    await assert.rejects(read({source_range}),/INVALID_TIME_RANGE/);
  const empty=await read({source_range:{kind:'interval',timebase_id:'audio_pts',stream_epoch:'other',start_ms:0,end_ms:100}});
  assert.equal(empty.selected_bytes,0);assert.equal(empty.kind,'stream');
  if(empty.kind==='stream')assert.deepEqual(empty.chunks,[]);
  const finite=await f.original.archive({...raw(Buffer.from('exact')),media_type:'text',mime:'text/plain'},
    {...trusted,submission:'explicit_text'});
  const full=await f.original.readRecord(finite.raw_ref,'owner',finite.archive_revision);
  assert.equal(full.selected_bytes,5);
  for(const options of [{track_ids:['mic']},{source_range:chunk(0).source_range}])
    await assert.rejects(f.original.readRecord(finite.raw_ref,'owner',finite.archive_revision,options),/ORIGINAL_SELECTION_UNSUPPORTED/);
});
test('runtime L5 tool exposes and forwards bounded chunk selection with original owner and pinned revision',async t=>{
  const f=await fixture(t),first=await f.stream.append(raw(),trusted,at,chunk(0));
  const second=await f.stream.append(raw(new Uint8Array(200).fill(1)),trusted,at,chunk(1));
  const run={run_id:'range-run',session_id:'session',conversation_session_id:'session',status:'running'};
  const native={create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})};
  const admission=new RunAdmission(f.storage,native,{max_pending_events:8,max_pending_bytes:65536,
    max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'range-test'});
  const runtime=new PersonalAIOSRuntime({storage:f.storage,archive:f.original,admission,native,
    output:new OutputAuthority(f.storage),skill:'fixed',max_read_bytes:200,devices:[{
      principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'livekit',consent_ref:'consent',
      token_sha256:sha256('range-fixture'),route_version:'route',output_modes:['text']}]});
  t.after(()=>runtime.close());
  const source=await runtime.authenticate('range-fixture');
  const {processed_event:d}=await runtime.submit({...raw(Buffer.from('question')),event_id:'question',media_type:'text',mime:'text/plain;charset=utf-8'},source,'session',true);
  for(let i=0;i<100 && !(await admission.getAsync('owner','session',d.processed_event_id))?.run_id;i++)
    await new Promise(resolve=>setTimeout(resolve,5));
  const context={run_id:run.run_id,session_id:'session',tool_call_id:'range-call'};
  const read=(args:Record<string,unknown>)=>runtime.tool('paios_l5_read',{context,args}) as Promise<any>;
  const requested={kind:'interval',timebase_id:'audio_pts',stream_epoch:'e1',start_ms:125,end_ms:175};
  const selected=await read({raw_ref:second.event.raw_ref,archive_revision:second.event.archive_revision,source_range:requested,track_ids:['mic']});
  assert.equal(selected.bytes,400);assert.equal(selected.selected_bytes,200);assert.equal(selected.chunks.length,1);
  assert.equal(selected.chunks[0].chunk.seq,1);assert.equal(Buffer.from(selected.chunks[0].content,'base64').length,200);
  assert.deepEqual(selected.selection,{semantics:'whole_chunks_overlap',source_range:requested,track_ids:['mic']});
  await assert.rejects(read({raw_ref:second.event.raw_ref,archive_revision:second.event.archive_revision}),/RAW_READ_BUDGET_EXCEEDED/);
  const old=await read({raw_ref:first.event.raw_ref,archive_revision:first.event.archive_revision,track_ids:['mic']});
  assert.equal(old.manifest.revision,1);assert.equal(old.bytes,200);assert.equal(old.selected_bytes,200);
  const foreign=await f.stream.append({...raw(),event_id:'foreign'}, {...trusted,principal_id:'other'},at,chunk(0));
  await assert.rejects(read({raw_ref:foreign.event.raw_ref,archive_revision:foreign.event.archive_revision,track_ids:['mic']}),/RAW_ACCESS_DENIED/);
  await assert.rejects(read({raw_ref:first.event.raw_ref,archive_revision:'f'.repeat(64),track_ids:['mic']}),/ARCHIVE_REVISION_CONFLICT/);
  await assert.rejects(read({raw_ref:first.event.raw_ref,archive_revision:first.event.archive_revision,track_ids:'mic'}),/INVALID_TRACK_SELECTION/);
  for(const track_ids of [['mic','mic'],Array.from({length:65},(_,i)=>`track${i}`)])
    await assert.rejects(read({raw_ref:first.event.raw_ref,archive_revision:first.event.archive_revision,track_ids}),/INVALID_TRACK_SELECTION/);
  await assert.rejects(read({raw_ref:first.event.raw_ref,archive_revision:first.event.archive_revision,
    source_range:{...requested,start_ms:175,end_ms:125}}),/INVALID_TIME_RANGE/);
  const current=await read({});assert.equal(current.content,'question');assert.equal(current.selected_bytes,8);
  await assert.rejects(read({track_ids:['mic']}),/ORIGINAL_SELECTION_UNSUPPORTED/);
  await assert.rejects(read({source_range:requested}),/ORIGINAL_SELECTION_UNSUPPORTED/);
  await assert.rejects(read({unknown:'value'}),/UNKNOWN_TOOL_ARGUMENT/);
});
test('public archive reads snapshot selectors and budget before storage awaits',async t=>{
  const f=await fixture(t);
  await f.stream.append(raw(),trusted,at,chunk(0));
  const current=await f.stream.append(raw(new Uint8Array(200).fill(1)),trusted,at,chunk(1));
  for(const entry of ['raw','stream'])await t.test(entry,async()=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let first=true;
    const storage={publish:f.storage.publish.bind(f.storage),list:f.storage.list.bind(f.storage),
      removePending:f.storage.removePending.bind(f.storage),read:async(namespace:string,key:string)=>{
        if(first){first=false;entered();await gate;}
        return f.storage.read(namespace,key);
      }};
    const options:StreamReadOptions={maxReadBytes:200,track_ids:['mic'],
      source_range:{kind:'interval',timebase_id:'audio_pts',stream_epoch:'e1',start_ms:0,end_ms:50}};
    const expected=structuredClone(options);
    const archive=entry==='raw'?new RawArchive(storage,4096,()=>at,budget):new StreamArchive(storage,budget);
    const pending=archive.readRecord(current.event.raw_ref,'owner',current.event.archive_revision,options);
    await started;
    options.maxReadBytes=1;options.track_ids![0]='missing';
    if(options.source_range?.kind==='interval')options.source_range.start_ms=25;
    release();
    const record=await pending;
    assert.ok('chunks' in record);
    assert.equal(record.selected_bytes,200);assert.equal(record.chunks[0]!.chunk.seq,0);
    options.track_ids!.push('later');
    if(options.source_range?.kind==='interval')options.source_range.end_ms=999;
    assert.deepEqual(record.selection,{semantics:'whole_chunks_overlap',
      source_range:expected.source_range,track_ids:expected.track_ids});
  });
});
test('real object corruption and false PCM duration deny both record read and D evidence',async t=>{
  const f=await fixture(t),first=await f.stream.append(raw(),trusted,at,chunk(0)),d=await processMedia(f,first);
  await fs.writeFile(join(f.root,'objects',(await materialized(f.storage,first)).chunks[0]!.object_hash),new Uint8Array(200).fill(8));
  await assert.rejects(f.original.readRecord(first.event.raw_ref,'owner',first.event.archive_revision),/STREAM_OBJECT_INTEGRITY/);
  assert.equal(await f.original.validateEvidence(d),false);
  const second=await f.stream.append({...raw(new Uint8Array(2)),event_id:'bad-pcm'},trusted,at,chunk(0));
  await assert.rejects(f.original.readRecord(second.event.raw_ref,'owner',second.event.archive_revision),/STREAM_PCM_FORMAT_TIME_MISMATCH/);
});
test('forged manifest extent is rejected even under its supplied digest; missing revision cannot pick head',async t=>{
  const f=await fixture(t),first=await f.stream.append(raw(),trusted,at,chunk(0));
  await assert.rejects(f.original.readRecord(first.event.raw_ref,'owner','f'.repeat(64)),/ARCHIVE_REVISION_CONFLICT/);
  // Build an isolated historical v1 fixture. Its old digest/extent gate remains independently tested.
  const {journal:_journal,...snapshot}=await materialized(f.storage,first);
  const forged={...snapshot,schema:'paios.stream.v1',extents:[]};
  await fs.rm(join(f.root,'stream-revisions'),{recursive:true,force:true});
  await fs.mkdir(join(f.root,'stream-revisions'));
  await fs.writeFile(join(f.root,'stream-revisions',digest([first.event.raw_ref,1])),canonical(forged));
  await assert.rejects(f.original.readRecord(first.event.raw_ref,'owner',digest(forged)),/STREAM_EXTENT_INTEGRITY/);
});
test('fresh independent process locates actual head and reads pinned earlier bytes from same source authority',async t=>{
  const f=await fixture(t),first=await f.stream.append(raw(),trusted,at,chunk(0));
  const second=await f.stream.append(raw(new Uint8Array(200).fill(3)),trusted,at,chunk(1));
  const script=`import {RawArchive} from ${JSON.stringify(new URL('../src/archive.ts',import.meta.url).href)};
import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts',import.meta.url).href)};
const archive=new RawArchive(new PosixStorage(${JSON.stringify(f.root)}),4096,()=>${JSON.stringify(at)},${JSON.stringify(budget)});
const head=await archive.locate(${JSON.stringify(first.event.raw_ref)},'owner');
const old=await archive.readRecord(head.raw_ref,'owner',${JSON.stringify(first.event.archive_revision)});
process.stdout.write(JSON.stringify({head:head.archive_revision,old:old.archive_revision,bytes:old.total_bytes,
count:old.kind==='stream'?old.chunks.length:-1}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script]);let out='',errors='';
  child.stdout.on('data',data=>{out+=String(data);});child.stderr.on('data',data=>{errors+=String(data);});
  const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(status,0,errors);
  assert.deepEqual(JSON.parse(out),{head:second.event.archive_revision,old:first.event.archive_revision,bytes:200,count:1});
});

test('a late lane D validates its selected PCM and prefix proof without rereading unrelated audio',async t=>{
  const f=await fixture(t);let last;
  for(let n=0;n<12;n++)last=await f.stream.append(raw(new Uint8Array(200).fill(n)),trusted,at,chunk(n));
  const d=await processMedia(f,last!,100),read=f.storage.read.bind(f.storage),objects:string[]=[];
  let corrupt=false;
  f.storage.read=async(n,k)=>{const bytes=await read(n,k);if(n==='objects'){objects.push(k);if(corrupt)return new Uint8Array(bytes.length).fill(99);}return bytes;};
  assert.equal(await f.original.validateEvidence(d),true);
  assert.equal(objects.length,1,'only the first frame is evidence for this D, despite the 12-frame pinned prefix');
  corrupt=true;assert.equal(await f.original.validateEvidence(d),false,'selected byte integrity is still checked');
  assert.equal(await f.original.validateEvidence({...d,principal_id:'other'}),false);
});

test('versioned snapshot restores its coherent cut while live tiering and owner deletion proceed',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-snapshot-')),dav=await webdav(t,root),stores:PosixStorage[]=[];
  t.after(async()=>{for(const store of stores)await store.close();await fs.rm(root,{recursive:true,force:true});});
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config});stores.push(storage);
  const archive=new RawArchive(storage,4096,()=>at,budget),file=(name:string)=>({...raw(Buffer.from(name)),event_id:name,media_type:'file' as const,mime:'application/octet-stream',representation:'uploaded_original' as const});
  const deleted=await archive.archive(file('deleted-before-cut'),trusted);await archive.delete(deleted.raw_ref,'owner');
  const pcm=Buffer.from([1,0,2,0]),saved=await archive.archive(raw(pcm),trusted),template=Buffer.from('local-template'),templateKey=sha256(template);
  await storage.publish('voiceprints',templateKey,template);await archive.moveCold(2,Date.now()+3*86400000);
  assert.ok(!(await storage.cold!.locations()).some(r=>r.namespace==='voiceprints'),'templates never enter the raw cold tier');
  const reads=dav.state.reads;dav.state.unavailable=true;const receipt=await archive.snapshot();
  assert.equal(receipt.dependency_mode,'remote-versioned');assert.ok(receipt.dependency_packs.length);assert.equal(dav.state.reads,reads,'snapshot requires no cold HTTP');
  await assert.rejects(fs.stat(join(receipt.root,'voiceprints')), {code:'ENOENT'});
  assert.deepEqual(Buffer.from(await storage.read('voiceprints',templateKey)),template,'online cuts leave local templates intact');
  dav.state.unavailable=false;
  const live=Promise.all([archive.moveCold(2,Date.now()+4*86400000),archive.delete(saved.raw_ref,'owner')]);
  const restoredRoot=join(root,'restored');await fs.cp(receipt.root,restoredRoot,{recursive:true});await live;
  await archive.releaseSnapshot(receipt.snapshot_id,true);
  for(const pack of receipt.dependency_packs)assert.ok((await fs.stat(join(dav.directory,`${pack.key}.l5pack`))).size,'completed backup pins survive live delete');
  const restoredStorage=new PosixStorage(restoredRoot,{cold:dav.config});stores.push(restoredStorage);
  const restored=new RawArchive(restoredStorage,4096,()=>at,budget);
  dav.state.corrupt=true;await assert.rejects(restored.restoreSnapshot(),/COLD_COPY_INTEGRITY/);dav.state.corrupt=false;
  assert.equal((await restored.restoreSnapshot()).packs,receipt.dependency_packs.length);
  dav.state.corrupt=true;await assert.rejects(restored.restoreSnapshot(),/COLD_COPY_INTEGRITY/);dav.state.corrupt=false;
  assert.deepEqual(await restored.read(saved.raw_ref,'owner',saved.archive_revision),pcm,'referenced raw audio survives the privacy exclusion and historical restore');
  await assert.rejects(restored.read(deleted.raw_ref,'owner',deleted.archive_revision),/RAW_DELETED/);
  assert.deepEqual(await restoredStorage.listHot('objects'),[],'restoration preserves cold locations rather than materializing history');
  // A later cut must verify the same cold pack again, not inherit this restore attempt's marker.
  const again=await restored.snapshot(),againRoot=join(root,'again');await fs.cp(again.root,againRoot,{recursive:true});
  await restored.releaseSnapshot(again.snapshot_id,true);const nextStorage=new PosixStorage(againRoot,{cold:dav.config});stores.push(nextStorage);
  const next=new RawArchive(nextStorage,4096,()=>at,budget),before=dav.state.reads;await next.restoreSnapshot();assert.ok(dav.state.reads>before);
  await archive.close();await restored.close();await next.close();
});

test('online snapshot preserves existing turn labels and excludes post-cut audio-label interleaving',async t=>{
  const owner=await fs.mkdtemp(join(tmpdir(),'paios-consumer-cut-')),storage=new PosixStorage(join(owner,'central-storage'));
  const archive=new RawArchive(storage,4096,()=>at,budget),labels=join(owner,'state','call-turns');
  await fs.mkdir(labels,{recursive:true});
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(owner,{recursive:true,force:true});});
  const save=async(id:string,value:number)=>{const admitted=await archive.admitStream({...raw(new Uint8Array(200).fill(value)),event_id:id},trusted,chunk(0));
    const saved=await admitted.commit;await fs.writeFile(join(labels,`${id}.json`),JSON.stringify({schema:'paios.call-turn.v2',label:'finished',probability:1,audio:[{event:saved.event,chunk:chunk(0),sample_from:0,sample_to:100}]}));return saved.event;};
  const before=await save('before-cut',1),journal=join(storage.root,'consumer-journal.log');await fs.writeFile(journal,'before\n');
  const receipt=await archive.snapshot(true),after=await save('between-cut-and-export',2);await fs.appendFile(journal,'after\n');
  assert.equal((await fs.readdir(labels)).length,2,'the live consumer export would contain a dangling new reference');
  const cutLabels=join(receipt.consumer_root!,'state','call-turns'),files=await fs.readdir(cutLabels);
  assert.equal(files.length,1);const label=JSON.parse(await fs.readFile(join(cutLabels,files[0]!),'utf8'));
  assert.equal(label.audio[0].event.raw_ref,before.raw_ref);assert.equal(label.audio[0].chunk.object_hash,undefined,'existing labels store only a TrackChunk descriptor');
  assert.equal(await fs.readFile(join(receipt.root,'consumer-journal.log'),'utf8'),'before\n','mutable journals cannot alias the live inode');
  const restoredOwner=join(owner,'restored'),restoredRoot=join(restoredOwner,'central-storage');
  await fs.cp(receipt.consumer_root!,restoredOwner,{recursive:true});await fs.cp(receipt.root,restoredRoot,{recursive:true});
  const restoredStorage=new PosixStorage(restoredRoot),restored=new RawArchive(restoredStorage,4096,()=>at,budget);
  try{await restored.restoreSnapshot();assert.deepEqual(Buffer.from((await restored.readExactChunk(before,chunk(0),200)).bytes),Buffer.alloc(200,1));
    await assert.rejects(restored.locate(after.raw_ref,'owner'),/RAW_REF_NOT_FOUND/);
    await fs.copyFile(join(labels,(await fs.readdir(labels)).find(file=>file!==files[0])!),join(restoredOwner,'state','call-turns','late.json'));
    await assert.rejects(restored.restoreSnapshot(),/ARCHIVE_REVISION_CONFLICT|RAW_REF_NOT_FOUND/,'restore independently rejects a dangling real consumer reference');
  }finally{await restored.close();await restoredStorage.close();await archive.releaseSnapshot(receipt.snapshot_id);}
});

test('consumer cut enumerates gateway roots only; foreign protected mounts stay with their owners',async t=>{
  const owner=await fs.mkdtemp(join(tmpdir(),'paios-owner-roots-')),storage=new PosixStorage(join(owner,'central-storage'));
  const archive=new RawArchive(storage,4096,()=>at,budget),foreign=join(owner,'desktop-out');
  await fs.mkdir(foreign,{mode:0o000});await fs.mkdir(join(owner,'state'),{recursive:true});
  await fs.writeFile(join(owner,'state','owner.json'),'retained');
  t.after(async()=>{await fs.chmod(foreign,0o700);await archive.close();await storage.close();await fs.rm(owner,{recursive:true,force:true});});
  const receipt=await archive.snapshot(true);
  assert.equal(await fs.readFile(join(receipt.consumer_root!,'state','owner.json'),'utf8'),'retained');
  assert.deepEqual(await fs.readdir(receipt.consumer_root!),['state']);
  await archive.releaseSnapshot(receipt.snapshot_id);
  await fs.chmod(join(owner,'state'),0o000);
  try{await assert.rejects(archive.snapshot(true),{code:'EACCES'});}
  finally{await fs.chmod(join(owner,'state'),0o700);}
  assert.deepEqual(await fs.readdir(join(storage.root,'.snapshots')),[],'unreadable included data fails the cut');
});

test('interrupted deletion persists queued hashes before cleanup and authorizes an uncommitted first capture',async t=>{
  const f=await fixture(t),publish=f.storage.publish.bind(f.storage);let blocked=true,failed!:()=>void;
  const attempted=new Promise<void>(resolve=>{failed=resolve;});
  f.storage.publish=async(namespace,key,bytes)=>{if(blocked&&namespace==='objects'){failed();throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return publish(namespace,key,bytes);};
  const payload=Buffer.alloc(200,37),pending=await f.original.admitStream(raw(payload),trusted,chunk(0));await attempted;
  const ref=`l5:${digest({event_id:'stream',principal_id:'owner',device_id:'glasses'})}`,remove=f.storage.removeOriginals.bind(f.storage);
  let fail=true;f.storage.removeOriginals=async records=>{for(const record of records){if(record.namespace==='objects'&&fail){fail=false;throw Object.assign(new Error('interrupted cleanup'),{code:'EIO'});}await remove([record]);}};
  await assert.rejects(f.original.delete(ref,'owner'),/interrupted cleanup/);await assert.rejects(pending.commit,/RAW_INGRESS_CANCELLED/);
  const intent=JSON.parse(Buffer.from(await f.storage.read('owner-deletions',ref.slice(3))).toString());assert.ok(intent.objects.includes(sha256(payload)));
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);assert.ok((await f.storage.list('objects')).includes(sha256(payload)));
  await f.original.close();blocked=false;const restart=new RawArchive(f.storage,4096,()=>at,budget);
  await restart.delete(ref,'owner');assert.ok(!(await f.storage.list('objects')).includes(sha256(payload)));
  await assert.rejects(restart.admitStream(raw(payload),trusted,chunk(0)),/RAW_DELETED/);await restart.close();
});

test('durable PCM batch groups ingress I/O and publishes exact individual source chunks',async t=>{
  const f=await fixture(t),publish=f.storage.publishIngressBatch.bind(f.storage);let admissions=0;
  t.after(()=>f.original.close());
  await f.storage.prepareCapture();
  const actualRoot=await fs.realpath(f.root);
  const disk=f.storage as unknown as {syncDirectory(path:string):Promise<void>},sync=disk.syncDirectory.bind(disk),directories:string[]=[];
  t.mock.method(disk,'syncDirectory',async(...args:Parameters<typeof sync>)=>{directories.push(args[0]);await sync(...args);});
  t.mock.method(f.storage,'publishIngressBatch',async(...args:Parameters<typeof publish>)=>{
    admissions++;assert.equal(args[0].length,2);await publish(...args);
    assert.equal(directories.filter(path=>path===join(actualRoot,'objects')).length,1);
    assert.equal(directories.filter(path=>path===join(actualRoot,'raw-ingress')).length,1);
  });
  const payloads=[Buffer.alloc(200,17),Buffer.alloc(200,29)];
  const inputs=payloads.map((payload,seq)=>({raw:raw(payload),chunk:chunk(seq)}));
  const admitted=await f.original.admitStreamBatch(inputs,trusted,{max_chunks:2,max_bytes:400});
  inputs[0]!.raw.payload.fill(99);
  const saved=await admitted.commit;
  assert.equal(admissions,1);assert.equal(saved.length,2);
  const record=await f.original.readRecord(saved[1]!.event.raw_ref,'owner',saved[1]!.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind!=='stream')throw Error('not stream');
  assert.deepEqual(record.chunks.map(x=>x.chunk.seq),[0,1]);
  assert.deepEqual(record.chunks.map(x=>Buffer.from(x.bytes)),[Buffer.alloc(200,17),Buffer.alloc(200,29)]);
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);
  assert.deepEqual(await f.storage.list('objects'),[sha256(Buffer.alloc(200,17)),sha256(Buffer.alloc(200,29))].sort());
});

test('durable PCM batch recovers all chunks after publication failure and restart',async t=>{
  const f=await fixture(t),publish=f.storage.publish.bind(f.storage);let blocked=true,attempt!:()=>void;
  const attempted=new Promise<void>(resolve=>{attempt=resolve;});
  t.mock.method(f.storage,'publish',async(...args:Parameters<typeof publish>)=>{
    if(blocked&&args[0]==='objects'){attempt();throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return publish(...args);
  });
  const admitted=await f.original.admitStreamBatch([1,2].map((value,seq)=>({raw:raw(Buffer.alloc(200,value)),chunk:chunk(seq)})),trusted,{max_chunks:2,max_bytes:400});
  await attempted;assert.deepEqual(await f.storage.list('raw-ingress'),[...admitted.key].sort());
  const pending=JSON.parse(Buffer.from(await f.storage.read('raw-ingress',admitted.key[0]!)).toString());
  assert.equal(pending.record.kind,'stream');assert.equal(pending.bytes,200);
  await f.original.close();await assert.rejects(admitted.commit,/RAW_INGRESS_PENDING_AT_CLOSE/);
  blocked=false;const restart=new RawArchive(f.storage,4096,()=>at,budget);t.after(()=>restart.close());
  // Re-admission joins the recovered durable original rather than writing a second ingress.
  const recovered=await restart.admitStreamBatch([1,2].map((value,seq)=>({raw:raw(Buffer.alloc(200,value)),chunk:chunk(seq)})),trusted,{max_chunks:2,max_bytes:400});
  assert.deepEqual(recovered.key,admitted.key);const saved=await recovered.commit;
  const record=await restart.readRecord(saved[1]!.event.raw_ref,'owner',saved[1]!.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind!=='stream')throw Error('not stream');
  assert.deepEqual(record.chunks.map(x=>Buffer.from(x.bytes)),[Buffer.alloc(200,1),Buffer.alloc(200,2)]);
});

test('durable PCM batch joins duplicate and in-flight originals while admitting new frames',async t=>{
  const f=await fixture(t),publish=f.storage.publishIngressBatch.bind(f.storage),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  t.after(async()=>{release.resolve();await f.original.close();});
  t.mock.method(f.storage,'publishIngressBatch',async(...args:Parameters<typeof publish>)=>{entered.resolve();await release.promise;return publish(...args);});
  const frame=(seq:number)=>({raw:raw(Buffer.alloc(200,seq+1)),chunk:chunk(seq)}),limit={max_chunks:3,max_bytes:600};
  const first=f.original.admitStreamBatch([frame(0),frame(0),frame(1)],trusted,limit);await entered.promise;
  const second=f.original.admitStreamBatch([frame(0),frame(2)],trusted,limit);release.resolve();
  const [a,b]=await Promise.all([first,second]);assert.equal(a.key[0],a.key[1]);assert.equal(a.key[0],b.key[0]);
  const [saved,next]=await Promise.all([a.commit,b.commit]);assert.deepEqual(saved[0],saved[1]);assert.deepEqual(saved[0],next[0]);
  const record=await f.original.readRecord(next[1]!.event.raw_ref,'owner',next[1]!.event.archive_revision);
  assert.equal(record.kind,'stream');if(record.kind!=='stream')throw Error('not stream');
  assert.deepEqual(record.chunks.map(x=>x.chunk.seq),[0,1,2]);assert.deepEqual(await f.storage.list('raw-ingress'),[]);
});

test('durable PCM batch deletion cancels the whole event and pre-ACK failures stay explicit',async t=>{
  const f=await fixture(t),publish=f.storage.publish.bind(f.storage);let attempt!:()=>void;
  const attempted=new Promise<void>(resolve=>{attempt=resolve;});
  t.mock.method(f.storage,'publish',async(...args:Parameters<typeof publish>)=>{
    if(args[0]==='objects'){attempt();throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return publish(...args);
  });
  const inputs=[1,2].map((value,seq)=>({raw:raw(Buffer.alloc(200,value)),chunk:chunk(seq)})),limit={max_chunks:2,max_bytes:400};
  await assert.rejects(f.original.admitStreamBatch([inputs[0]!,{...inputs[1]!,raw:{...inputs[1]!.raw,event_id:'other'}}],trusted,limit),/STREAM_BATCH_SOURCE_CONFLICT/);
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);
  const admitted=await f.original.admitStreamBatch(inputs,trusted,limit);await attempted;
  const ref=`l5:${digest({event_id:'stream',principal_id:'owner',device_id:'glasses'})}`;
  await f.original.delete(ref,'owner');await assert.rejects(admitted.commit,/RAW_INGRESS_CANCELLED/);
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);
  assert.deepEqual(await f.storage.list('objects'),[]);
  await assert.rejects(f.original.admitStreamBatch(inputs,trusted,limit),/RAW_DELETED/);await f.original.close();
  const denied=await fixture(t);t.after(()=>denied.original.close());
  t.mock.method(denied.storage,'publishIngressBatch',async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});});
  await assert.rejects(denied.original.admitStreamBatch(inputs,trusted,limit),{code:'EACCES'});
  assert.deepEqual(await denied.storage.list('raw-ingress'),[]);
});

test('hot metadata replay works during cold outage and failed snapshot construction leaves no dependency pins',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-hot-offline-')),dav=await webdav(t,root),storage=new PosixStorage(join(root,'hot'),{cold:dav.config});
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const archive=new RawArchive(storage,4096,()=>at,budget),input={...raw(Buffer.from('photo')),event_id:'photo',media_type:'visual' as const,mime:'image/jpeg'};
  const original=await archive.archive(input,trusted);await archive.moveCold();dav.state.unavailable=true;
  assert.deepEqual(await archive.archive(input,trusted),original);assert.deepEqual(await archive.read(original.raw_ref,'owner',original.archive_revision),Buffer.from('photo'));
  await fs.symlink(join(root,'outside'),join(storage.root,'unsafe'));
  await assert.rejects(archive.snapshot(),/UNSAFE_ARCHIVE_SNAPSHOT/);assert.deepEqual(await fs.readdir(join(storage.root,'.snapshots')),[]);
  await fs.unlink(join(storage.root,'unsafe'));const receipt=await archive.snapshot();await archive.releaseSnapshot(receipt.snapshot_id);await archive.close();
});
