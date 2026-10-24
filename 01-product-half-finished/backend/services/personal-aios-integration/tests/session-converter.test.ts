import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive,streamManifestRevision,type StreamManifest} from '../src/stream-archive.ts';
import {RawArchive} from '../src/archive.ts';
import {EVENT_SCHEMA,canonical,digest,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {consolidateSessions,discoverSessions,measureDisk} from '../tools/consolidate-sessions.ts';
const at='2026-10-01T00:00:00.000Z',budget={max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:64,max_revisions:64,max_seq:100};
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'livekit',consent_ref:'consent',submission:'observation'};
const encode=(value:unknown)=>Buffer.from(canonical(value));
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'paios-converter-'));
  const storage=new PosixStorage(root);t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});return {root,storage};}
async function stream(f:Awaited<ReturnType<typeof fixture>>,id:string,count=3,legacy=false){
  const archive=new StreamArchive(f.storage,budget),manifests:StreamManifest[]=[];let raw_ref='';
  for(let seq=0;seq<count;seq++){
    const raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:id,device_id:'glasses',device_type:'glasses',captured_at:at,source:{channel:'livekit'},
      media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(200,seq+1)};
    const appended=await archive.append(raw,trusted,at,{track_id:'mic',stream_epoch:'e1',seq,modality:'audio',format:'pcm_s16le:1000:1',
      source_range:{kind:'interval',timebase_id:'pts',stream_epoch:'e1',start_ms:seq*100,end_ms:(seq+1)*100}});
    raw_ref=appended.event.raw_ref;manifests.push(structuredClone((await archive.head(raw_ref))!));
  }
  if(legacy){let parent:string|null=null;
    for(const manifest of manifests){const {journal:_,...rest}=manifest;const next={...rest,schema:'paios.stream.v1' as const,parent};
      parent=digest(next);await fs.writeFile(join(f.root,'stream-revisions',digest([raw_ref,next.revision])),encode(next));}
    for(const key of await f.storage.listHot('stream-revisions')){const value=JSON.parse(Buffer.from(await f.storage.read('stream-revisions',key)).toString());
      if(value.raw_ref===raw_ref&&value.schema==='paios.stream.delta.v2')await fs.unlink(join(f.root,'stream-revisions',key));}
  }
  return {raw_ref,manifests};
}
async function put(storage:PosixStorage,namespace:string,value:unknown,key=digest(value)){
  await fs.mkdir(join(storage.root,namespace),{recursive:true});await fs.writeFile(join(storage.root,namespace,key),encode(value),{flag:'wx',mode:0o600});return {namespace,key,bytes:encode(value)};
}
async function snapshot(root:string){const entries:unknown[]=[];const walk=async(dir:string):Promise<void>=>{for(const name of (await fs.readdir(dir)).sort()){
  const path=join(dir,name),stat=await fs.lstat(path);entries.push([path.slice(root.length),stat.mode,stat.size,stat.mtimeMs,stat.isFile()?(await fs.readFile(path)).toString('base64'):null]);
  if(stat.isDirectory())await walk(path);
}};await walk(root);return entries;}
async function metadata(f:Awaited<ReturnType<typeof fixture>>,raw_ref:string){
  const facts:Awaited<ReturnType<typeof put>>[]=[],owner=`owner-${raw_ref}`,claim=digest(['claim',raw_ref]),processed=`processed-${raw_ref}`,epoch=`epoch-${raw_ref}`;
  const route={raw_ref,principal_id:'owner',device_id:'glasses',source_scope:'ambient',capture_span:raw_ref,consumer:'media',lane:'continuous'};
  facts.push(await put(f.storage,'audio-consumer-routes',route));
  facts.push(await put(f.storage,'audio-consumer-spans',{consumer:'media',lane:'continuous',source_scope:'ambient',capture_span:raw_ref},digest(['owner','glasses','ambient',raw_ref])));
  facts.push(await put(f.storage,'audio-consumer-attempts',{raw_ref,key:claim,owner},claim));
  facts.push(await put(f.storage,'audio-consumer-results',{key:claim,processed_event_ids:[processed]}));
  facts.push(await put(f.storage,'audio-consumer-d',{key:claim,processed_event_id:processed}));
  facts.push(await put(f.storage,'audio-consumer-not-accepted',{owner,state:'not_accepted'}));
  const bundle={schema:'paios.audio-consumption.facts.v2',common:{owner},key_from_slot:true,records:[{key:claim,value:{raw_ref}}]};
  facts.push(await put(f.storage,'audio-consumer-accepted',bundle));
  const duplicate=digest(['duplicate',raw_ref]);await fs.link(join(f.root,'audio-consumer-accepted',digest(bundle)),join(f.root,'audio-consumer-accepted',duplicate));
  facts.push({namespace:'audio-consumer-accepted',key:duplicate,bytes:encode(bundle)});
  facts.push(await put(f.storage,'processed-media',{raw_ref,processed_event_id:processed}));
  facts.push(await put(f.storage,'processed-media-inputs',{raw_ref,input_contract:'frame_v1'}));
  for(const namespace of ['media-views','media-vad-selections','media-continuous-candidates','media-continuous-admitted','media-continuous-attempts','media-continuous-selection',
    'media-source-failures','media-derivations','derivation-attempts','media-postarchive-admissions'])facts.push(await put(f.storage,namespace,{event:{raw_ref},purpose:'legacy'}));
  facts.push(await put(f.storage,'media-source-progress',{raw_ref,seq:0,detection_epoch:epoch}));
  const progress={schema:'paios.media.source-progress.interval.v2',raw_ref,frames:[{raw_ref,seq:1},{raw_ref,seq:2}]};
  facts.push(await put(f.storage,'media-source-progress',progress));
  facts.push(await put(f.storage,'media-source-progress',progress,digest(['frame-alias',raw_ref])));
  facts.push(await put(f.storage,'media-detection-epochs',{raw_ref,detection_epoch:epoch}));
  facts.push(await put(f.storage,'media-detection-finished',{detection_epoch:epoch,semantic_status:'open',acoustic_end_asserted:false}));
  return facts;
}
test('offline dry run never writes; converter preserves all legacy keys and raw bytes across v1/v2 metadata formats',async t=>{
  const f=await fixture(t),v1=await stream(f,'old-v1',3,true),v2=await stream(f,'old-v2'),facts=[...await metadata(f,v1.raw_ref),...await metadata(f,v2.raw_ref)];
  const orphan=await put(f.storage,'unclassified-facts',{unknown_purpose:true});
  const ownedUnknown=await put(f.storage,'unclassified-owned',{raw_ref:v1.raw_ref,purpose:'unknown'});
  await fs.writeFile(join(f.root,'stream-revisions','.pending-torn'),'partial bytes');
  const before=await snapshot(f.root),dryStarted=performance.now(),dry=await consolidateSessions(f.root),dryMs=performance.now()-dryStarted;
  assert.deepEqual(await snapshot(f.root),before);assert.equal(dry.mode,'dry-run');assert.deepEqual(dry.converted,[]);
  assert.equal(dry.sessions.filter(s=>s.closed_by.length&&!s.issues.length).length,2);assert.ok(dry.retained.includes(`${orphan.namespace}/${orphan.key}`));
  assert.ok(dry.retained.includes(`${ownedUnknown.namespace}/${ownedUnknown.key}`));
  assert.deepEqual(dry.pending,['stream-revisions/.pending-torn']);
  await assert.rejects(consolidateSessions(f.root,{apply:true}),/APPLY_REQUIRES_GATEWAY_STOPPED/);
  const rawKeys=await f.storage.listHot('objects'),rawBytes=await Promise.all(rawKeys.map(key=>f.storage.read('objects',key)));
  await f.storage.close();const applyStarted=performance.now(),result=await consolidateSessions(f.root,{apply:true,gatewayStopped:true}),applyMs=performance.now()-applyStarted;assert.equal(result.converted.length,2);
  console.log('SESSION_CONVERTER_MEASURED',JSON.stringify({sessions:2,raw_frames:6,raw_bytes:1200,dry_run_ms:dryMs,apply_ms:applyMs,before:result.before,after:result.after,freed:result.freed}));
  const reader=new PosixStorage(f.root);t.after(()=>reader.close());
  for(const fact of facts){assert.deepEqual(Buffer.from(await reader.read(fact.namespace,fact.key)),fact.bytes);await assert.rejects(fs.lstat(join(f.root,fact.namespace,fact.key)),{code:'ENOENT'});}
  for(let n=0;n<rawKeys.length;n++)assert.deepEqual(Buffer.from(await reader.read('objects',rawKeys[n]!)),Buffer.from(rawBytes[n]!));
  const archive=new RawArchive(reader,4096,()=>at,budget);t.after(()=>archive.close());
  for(const lane of [v1,v2]){const head=await archive.streams.head(lane.raw_ref);assert.ok(head);const record=await archive.readRecord(lane.raw_ref,'owner',streamManifestRevision(head));
    assert.equal(record.kind,'stream');if(record.kind==='stream')assert.deepEqual(record.chunks.map(c=>Buffer.from(c.bytes)),[1,2,3].map(n=>Buffer.alloc(200,n)));}
  assert.equal(await fs.readFile(join(f.root,'stream-revisions','.pending-torn'),'utf8'),'partial bytes');
  assert.deepEqual(Buffer.from(await reader.read(orphan.namespace,orphan.key)),orphan.bytes);
  assert.deepEqual(await fs.readFile(join(f.root,ownedUnknown.namespace,ownedUnknown.key)),ownedUnknown.bytes);
  await archive.close();await reader.close();assert.deepEqual(result.after,await measureDisk(f.root));assert.equal(result.freed.allocated_bytes,result.before.allocated_bytes-result.after.allocated_bytes);
  const again=await consolidateSessions(f.root,{apply:true,gatewayStopped:true});assert.deepEqual(again.converted,[]);assert.deepEqual(again.before,again.after);
});
test('open, crashed, unfinished detection epochs and missing/conflicting stream aliases stay untouched',async t=>{
  const f=await fixture(t),open=await stream(f,'open'),torn=await stream(f,'torn'),conflict=await stream(f,'conflict'),restarted=await stream(f,'restart'),ingress=await stream(f,'ingress');
  await metadata(f,torn.raw_ref);await metadata(f,conflict.raw_ref);await metadata(f,restarted.raw_ref);
  await put(f.storage,'media-detection-epochs',{raw_ref:restarted.raw_ref,detection_epoch:'unfinished-restart'});
  await metadata(f,ingress.raw_ref);const pending=await put(f.storage,'raw-ingress',{schema:'paios.raw-ingress.v1',record:{kind:'stream',raw:{event_id:'ingress',device_id:'glasses'},trusted:{principal_id:'owner'}},object_hash:digest('pending bytes'),bytes:200});
  const visual=await new StreamArchive(f.storage,budget).append({schema_version:EVENT_SCHEMA,event_id:'visual-only',device_id:'glasses',device_type:'glasses',captured_at:at,source:{channel:'livekit'},
    media_type:'visual',mime:'image/png',representation:'received_decoded_sample',payload:Buffer.from('png')},trusted,at,{track_id:'cam',stream_epoch:'v1',seq:0,modality:'visual',format:'png',source_range:{kind:'instant',timebase_id:'pts',stream_epoch:'v1',at_ms:0}});
  await metadata(f,visual.event.raw_ref);
  await fs.unlink(join(f.root,'stream-revisions',digest([torn.raw_ref,3])));
  const proposal={schema:'paios.stream.delta.v2',raw_ref:conflict.raw_ref,revision:3,parent:null,chunk:{bytes:200,seq:2,object_hash:digest('uncommitted payload')}};
  await put(f.storage,'stream-revisions',proposal);
  const shared=await put(f.storage,'unclassified-shared',{children:[{raw_ref:torn.raw_ref},{raw_ref:conflict.raw_ref}]});
  const epochShared=await Promise.all([torn,conflict].map(lane=>put(f.storage,'media-source-progress',{raw_ref:lane.raw_ref,detection_epoch:'shared-conflicting-epoch'})));
  const dry=await discoverSessions(f.root);assert.equal(dry.sessions.find(s=>s.raw_ref===open.raw_ref)!.closed_by.length,0);
  assert.match(dry.sessions.find(s=>s.raw_ref===torn.raw_ref)!.issues.join(),/missing stream sequence alias 3/);
  assert.match(dry.sessions.find(s=>s.raw_ref===conflict.raw_ref)!.issues.join(),/uncommitted\/conflicting/);
  assert.match(dry.sessions.find(s=>s.raw_ref===conflict.raw_ref)!.issues.join(),/metadata ownership is ambiguous/);assert.ok(dry.retained.includes(`${shared.namespace}/${shared.key}`));
  for(const fact of epochShared)assert.ok(dry.retained.includes(`${fact.namespace}/${fact.key}`),'shared epoch preserves both owners and retains ambiguous records');
  assert.equal(dry.sessions.find(s=>s.raw_ref===restarted.raw_ref)!.closed_by.length,0);
  assert.match(dry.sessions.find(s=>s.raw_ref===ingress.raw_ref)!.issues.join(),/pending raw ingress/);assert.ok(dry.retained.includes(`${pending.namespace}/${pending.key}`));
  assert.match(dry.sessions.find(s=>s.raw_ref===visual.event.raw_ref)!.issues.join(),/no audio; video consolidation not implemented/);
  await f.storage.close();const before=await snapshot(f.root),applied=await consolidateSessions(f.root,{apply:true,gatewayStopped:true});assert.deepEqual(applied.converted,[]);
  assert.deepEqual(await snapshot(f.root),before);
});
test('operator can close a legacy call/voice session without inferring analysis success; inode statistics deduplicate hard links',async t=>{
  const f=await fixture(t),lane=await stream(f,'legacy-call',1);await put(f.storage,'voice-turns',{raw_ref:lane.raw_ref,state:'analysis_unknown'});
  const alias=digest(['identical-hardlink']);await fs.link(join(f.root,'objects',lane.manifests[0]!.chunks[0]!.object_hash),join(f.root,'objects',alias));
  const stats=await measureDisk(f.root);assert.equal(stats.files-stats.inodes,2,'one stream delta alias and one raw hard link share inodes');
  await assert.rejects(discoverSessions(f.root,['invalid']),/INVALID_CLOSED_REF/);await f.storage.close();
  const result=await consolidateSessions(f.root,{apply:true,gatewayStopped:true,closedRefs:[lane.raw_ref]});assert.deepEqual(result.converted,[lane.raw_ref]);
  const reader=new PosixStorage(f.root);t.after(()=>reader.close());const final=await reader.readFinal(lane.raw_ref);assert.ok(final);assert.equal(final.ended_by,'offline_converter');
  assert.ok(!final.records.some(record=>record.namespace==='voice-turns'));assert.ok(result.retained.some(path=>path.startsWith('voice-turns/')));
  assert.deepEqual(Buffer.from(await reader.read('objects',alias)),Buffer.alloc(200,1));
});
test('durable acquisition end marker authorizes conversion and preserves its end reason',async t=>{
  const f=await fixture(t),lane=await stream(f,'ended-session',1);
  await put(f.storage,'session-ends',{schema:'paios.session.end.v1',raw_ref:lane.raw_ref,revision:streamManifestRevision(lane.manifests[0]!),ended_by:'source_exhausted'},lane.raw_ref.slice(3));
  await f.storage.close();const result=await consolidateSessions(f.root,{apply:true,gatewayStopped:true});assert.deepEqual(result.converted,[lane.raw_ref]);
  assert.ok(result.sessions[0]!.closed_by.includes('session-ends'));const reader=new PosixStorage(f.root);t.after(()=>reader.close());
  assert.equal((await reader.readFinal(lane.raw_ref))!.ended_by,'source_exhausted');
});
test('converter resumes a committed final after a crash cuts original cleanup',async t=>{
  const f=await fixture(t),lane=await stream(f,'converter-crash'),facts=await metadata(f,lane.raw_ref);
  const originals=await Promise.all((await f.storage.listHot('objects')).map(async key=>({key,bytes:await f.storage.read('objects',key)})));
  await f.storage.close();const remove=PosixStorage.prototype.removeOriginals;let cut=false;
  PosixStorage.prototype.removeOriginals=async function(records){
    if(!cut){cut=true;await remove.call(this,records.slice(0,2));throw new Error('INJECTED_CLEANUP_CRASH');}
    return remove.call(this,records);
  };
  try{await assert.rejects(consolidateSessions(f.root,{apply:true,gatewayStopped:true}),/INJECTED_CLEANUP_CRASH/);}
  finally{PosixStorage.prototype.removeOriginals=remove;}
  const result=await consolidateSessions(f.root,{apply:true,gatewayStopped:true});assert.deepEqual(result.converted,[lane.raw_ref]);
  const reader=new PosixStorage(f.root);t.after(()=>reader.close());
  for(const fact of facts)assert.deepEqual(Buffer.from(await reader.read(fact.namespace,fact.key)),fact.bytes);
  for(const object of originals)assert.deepEqual(await reader.read('objects',object.key),object.bytes);
  assert.deepEqual(await reader.pendingFinals(),[]);
});
