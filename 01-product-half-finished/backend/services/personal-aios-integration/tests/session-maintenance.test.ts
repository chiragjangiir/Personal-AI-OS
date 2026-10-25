import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {EVENT_SCHEMA,digest,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {webdav} from './stream-materialized-fixture.ts';
import {AudioConsumption} from '../src/media/audio-consumption.ts';
const at='2026-10-01T00:00:00.000Z',time=Date.parse(at);
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',channel:'livekit',submission:'observation'};
async function fixture(t:test.TestContext,cold=false){
  const root=await fs.mkdtemp(join(tmpdir(),'fold-maintenance-')),remote=cold?await webdav(t,root):undefined;
  const storage=new PosixStorage(join(root,'hot'),remote?{cold:remote.config}:{}),archive=new RawArchive(storage,320000,()=>at);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  async function add(id:string,seq=0,received=at){
    const raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:id,device_id:'glasses',device_type:'glasses',captured_at:at,
      source:{channel:'livekit'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,id.charCodeAt(0)+seq)};
    return archive.streams.append(raw,trusted,received,{track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',
      source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}});
  }
  return {root,storage,archive,add};
}
test('startup leaves the ended backlog intact; maintenance folds oldest first and respects call/PTT busy',async t=>{
  const f=await fixture(t),first=await f.add('older'),second=await f.add('newer');
  f.archive.setSessionFolding(false);await f.archive.finalizeSession(first.event.raw_ref);await f.archive.finalizeSession(second.event.raw_ref);
  await fs.utimes(join(f.storage.root,'session-ends',first.event.raw_ref.slice(3)),new Date(time),new Date(time));
  await fs.utimes(join(f.storage.root,'session-ends',second.event.raw_ref.slice(3)),new Date(time+1000),new Date(time+1000));
  f.archive.setSessionFolding(true);await f.archive.recover();assert.deepEqual(await f.storage.list('session-finals'),[]);
  const order:string[]=[],publish=f.storage.publishFinal.bind(f.storage);
  f.storage.publishFinal=async final=>{order.push(final.raw_ref);return publish(final);};
  await f.archive.maintenance(1,time+2000,{busy:()=>true});assert.deepEqual(order,[]);
  await f.archive.maintenance(1,time+2000);assert.deepEqual(order,[first.event.raw_ref,second.event.raw_ref]);
  assert.equal(f.archive.maintenanceSnapshot().sessions_remaining,0);assert.equal(f.archive.maintenanceSnapshot().files_remaining,0);
});
test('an interrupted fold resumes next tick, releases capture and closes without waiting for another tick',async t=>{
  const f=await fixture(t),a=await f.add('a');await f.add('a',1);await f.archive.endSession(a.event.raw_ref);
  let busy=false,reads=0;const read=f.storage.read.bind(f.storage);
  f.storage.read=async(ns,key)=>{const bytes=await read(ns,key);if(ns==='objects'&&++reads===1)busy=true;return bytes;};
  await f.archive.maintenance(1,time,{busy:()=>busy});assert.equal(f.archive.maintenanceSnapshot().phase,'yielded');
  assert.equal(await f.storage.readFinal(a.event.raw_ref),null);await f.add('live');
  busy=false;await f.archive.maintenance(1,time);assert.ok(await f.storage.readFinal(a.event.raw_ref));
  const next=await f.add('next');await f.archive.endSession(next.event.raw_ref);
  await f.archive.maintenance(1,time,{budget_ms:0});assert.equal(f.archive.maintenanceSnapshot().phase,'yielded');
  await f.archive.close();
});
test('idle orphan ends through the normal authority; recently received chunks remain live',async t=>{
  const f=await fixture(t),orphan=await f.add('orphan'),live=await f.add('live',0,new Date(time+29*60000).toISOString());
  await f.archive.maintenance(1,time+31*60000);
  assert.equal((await f.storage.readFinal(orphan.event.raw_ref))?.ended_by,'idle_timeout');
  assert.equal(await f.storage.readFinal(live.event.raw_ref),null);
  await assert.rejects(f.add('orphan',1),/STREAM_ALREADY_FINAL/);await f.add('live',1);
});
test('fold failures stay visible and preserve originals; the next sweep can recover',async t=>{
  const f=await fixture(t),a=await f.add('a');await f.archive.endSession(a.event.raw_ref);
  const publish=f.storage.publishFinal.bind(f.storage);f.storage.publishFinal=async()=>{throw new Error('fixture disk failure');};
  await f.archive.maintenance(1,time);assert.match(f.archive.maintenanceSnapshot().last_error!,/fixture disk failure/);
  assert.deepEqual(await f.storage.readHot('objects',a.chunk.object_hash),Buffer.alloc(3200,'a'.charCodeAt(0)));
  f.storage.publishFinal=publish;await f.archive.maintenance(1,time);assert.ok(await f.storage.readFinal(a.event.raw_ref));
});
test('one-day hot policy preserves bytes until 24h and materializes original keys after eviction',async t=>{
  const f=await fixture(t,true),a=await f.add('a');await f.add('a',1);await f.archive.endSession(a.event.raw_ref);
  await f.archive.maintenance(1,time);const final=(await f.storage.readFinal(a.event.raw_ref))!;
  const modified=await f.storage.modifiedAt('objects',final.object_hash);
  await f.archive.moveCold(1,modified+86400000-1);
  assert.equal((await f.storage.readHot('objects',final.object_hash)).length,6400);
  await f.archive.moveCold(1,modified+86400000+1);await assert.rejects(f.storage.readHot('objects',final.object_hash),{code:'ENOENT'});
  assert.deepEqual(Buffer.from((await f.archive.readExactChunk(a.event,a.chunk,3200)).bytes),Buffer.alloc(3200,'a'.charCodeAt(0)));
  assert.throws(()=>f.archive.setHotDays(0),/INVALID_HOT_DAYS/);
});

test('an abandoned visual-only stream ends, folds, reads cold and deletes through the same authority',async t=>{
  const f=await fixture(t,true),raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:'camera-only',device_id:'glasses',device_type:'glasses',captured_at:at,
    source:{channel:'livekit'},media_type:'livekit_tracks',mime:'image/jpeg',representation:'received_decoded_sample',payload:Buffer.from('camera frame')};
  const receipt=await f.archive.streams.append(raw,trusted,at,{track_id:'camera',stream_epoch:'video',seq:0,modality:'visual',format:'jpeg',
    source_range:{kind:'instant',timebase_id:'samples',stream_epoch:'video',at_ms:0}});
  await f.archive.maintenance(1,time+31*60000);
  assert.equal((await f.storage.readFinal(receipt.event.raw_ref))?.ended_by,'idle_timeout');
  await f.archive.moveCold(1,Date.now()+2*86400000);
  assert.deepEqual(Buffer.from((await f.archive.readExactChunk(receipt.event,receipt.chunk,320000)).bytes),raw.payload);
  await f.archive.delete(receipt.event.raw_ref,'owner');
  await assert.rejects(f.archive.readExactChunk(receipt.event,receipt.chunk,320000),/RAW_DELETED/);
});

test('source end publication does not wait for an in-flight cold upload',async t=>{
  const f=await fixture(t,true),first=await f.add('first');await f.archive.endSession(first.event.raw_ref);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),move=f.storage.moveCold.bind(f.storage);
  f.storage.moveCold=async(...args)=>{entered.resolve();await release.promise;return move(...args);};
  const tick=f.archive.maintenance(1,time);await entered.promise;
  const live=await f.add('live');let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([f.archive.endSession(live.event.raw_ref,'call_hangup'),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SOURCE_END_BLOCKED_BY_COLD_UPLOAD')),1000);})]);
    assert.equal(JSON.parse(Buffer.from(await f.storage.read('session-ends',live.event.raw_ref.slice(3))).toString()).ended_by,'call_hangup');
  }finally{clearTimeout(timer);release.resolve();await tick;}
});

test('large proof overflow yields to capture before publishing the final',async t=>{
  const f=await fixture(t),receipt=await f.add('overflow'),refs=[];
  for(let n=0;n<160;n++){
    const value={raw_ref:receipt.event.raw_ref,segment_id:`segment:${n}`,revision:1,content:'x'.repeat(128*1024)},
      key=digest([value.raw_ref,value.segment_id,value.revision]);await f.storage.publish('processed-media',key,Buffer.from(JSON.stringify(value)));
    refs.push({namespace:'processed-media',key});
  }
  await f.storage.trackSessionRecords(receipt.event.raw_ref,refs);await f.archive.endSession(receipt.event.raw_ref);
  const track=f.storage.trackSessionRecords.bind(f.storage);let busy=false,registered=0,maxBatch=0;
  f.storage.trackSessionRecords=async(ref,records)=>{
    await track(ref,records);
    if(records.some(record=>record.namespace==='processed-media')){registered+=records.length;maxBatch=Math.max(maxBatch,records.length);busy=true;}
  };
  for(let tick=0;tick<20&&!registered;tick++)await f.archive.maintenance(1,time,{busy:()=>busy});
  assert.ok(registered,'Maintenance must reach overflow ownership registration');
  assert.equal(await f.storage.readFinal(receipt.event.raw_ref),null,'Busy capture must park before final publication');
  assert.ok(maxBatch<=64,'One ownership transaction must stay within the maintenance batch budget');
  await f.add('live-during-overflow');f.storage.trackSessionRecords=track;busy=false;
  for(let tick=0;tick<20&&!await f.storage.readFinal(receipt.event.raw_ref);tick++)await f.archive.maintenance(1,time);
  assert.ok(await f.storage.readFinal(receipt.event.raw_ref));
});

test('maintenance adopts pre-index producer proofs and discovers unended legacy streams before folding',async t=>{
  const f=await fixture(t,true),track=f.storage.trackSessionRecords.bind(f.storage);
  // These are real producer writes with the pre-SessionRecords ownership capability absent.
  f.storage.trackSessionRecords=async()=>{};
  const first=await f.add('ancient'),second=await f.add('ancient',1);
  const orphan=await f.add('also-ancient',0,new Date(time+29*60000).toISOString());
  const audio=new AudioConsumption(f.storage,1048576);
  await audio.select(first.event,'continuous');
  for(const receipt of [first,second])await audio.chunk(receipt.event,{seq:receipt.chunk.seq},receipt.chunk.object_hash,
    async accept=>{await accept();return {status:'queued'};});
  await f.archive.endSession(first.event.raw_ref);
  f.storage.trackSessionRecords=track;
  const proofs:{namespace:string;key:string;bytes:Uint8Array}[]=[];
  for(const namespace of ['audio-consumer-routes','audio-consumer-spans','audio-consumer-attempts','audio-consumer-accepted','audio-consumer-results'])
    for(const key of await f.storage.listHot(namespace))proofs.push({namespace,key,bytes:await f.storage.read(namespace,key)});
  assert.equal(await f.storage.sessionRecordCount(first.event.raw_ref),0);
  await f.archive.recover();assert.equal(await f.storage.readFinal(first.event.raw_ref),null);
  await f.archive.maintenance(1,time+31*60000,{busy:()=>true});
  assert.equal(await f.storage.sessionRecordCount(first.event.raw_ref),0,'busy tick must not adopt historical files');
  for(let tick=0;tick<20&&!await f.storage.readFinal(first.event.raw_ref);tick++)await f.archive.maintenance(1,time+31*60000);
  assert.ok(await f.storage.readFinal(first.event.raw_ref));
  for(const proof of proofs){
    assert.deepEqual(await f.storage.read(proof.namespace,proof.key),proof.bytes);
    await assert.rejects(f.storage.readHot(proof.namespace,proof.key),{code:'ENOENT'},'legacy proof must join the fold');
  }
  assert.equal(await f.storage.readFinal(orphan.event.raw_ref),null,'recent legacy stream must remain live');
  assert.ok((await f.storage.activeSessionRefs()).includes(orphan.event.raw_ref));
  await f.archive.moveCold(1,Date.now()+2*86400000);
  for(const proof of proofs)assert.deepEqual(await f.storage.read(proof.namespace,proof.key),proof.bytes);
  await f.archive.delete(first.event.raw_ref,'owner');
  assert.deepEqual(Buffer.from((await f.archive.readExactChunk(orphan.event,orphan.chunk,3200)).bytes),Buffer.alloc(3200,'a'.charCodeAt(0)));
  await f.archive.maintenance(1,time+61*60000);
  assert.equal((await f.storage.readFinal(orphan.event.raw_ref))?.ended_by,'idle_timeout');
});

test('legacy fact bundles and partially tracked retry claims keep every winning proof',async t=>{
  const f=await fixture(t),track=f.storage.trackSessionRecords.bind(f.storage);f.storage.trackSessionRecords=async()=>{};
  const first=await f.add('bundled'),second=await f.add('bundled',1),audio=new AudioConsumption(f.storage,1048576);
  await audio.select(first.event,'continuous',{consumer:'media',source_scope:'bundled',capture_span:first.event.raw_ref,
    purpose_evidence_ref:'fixture',input_contract:'interval_v2'});
  const entries=[first,second].map(receipt=>({event:receipt.event,identity:{seq:receipt.chunk.seq},payloadHash:receipt.chunk.object_hash}));
  await assert.rejects(audio.interval(entries,async()=>{throw new Error('fixture before acceptance');}),/fixture before acceptance/);
  await audio.interval(entries,async(fresh,accept)=>{await accept();return fresh.map(seq=>({seq}));});
  await f.archive.endSession(first.event.raw_ref);f.storage.trackSessionRecords=track;
  const proofs:{namespace:string;key:string;bytes:Uint8Array}[]=[];
  for(const namespace of ['audio-consumer-attempts','audio-consumer-not-accepted','audio-consumer-accepted','audio-consumer-results'])
    for(const key of await f.storage.listHot(namespace))proofs.push({namespace,key,bytes:await f.storage.read(namespace,key)});
  // A replay may register an existing root while its historical children remain unregistered.
  await track(first.event.raw_ref,proofs.filter(p=>p.namespace==='audio-consumer-attempts'));
  for(let tick=0;tick<20&&!await f.storage.readFinal(first.event.raw_ref);tick++)await f.archive.maintenance(1,time);
  assert.ok(await f.storage.readFinal(first.event.raw_ref),f.archive.maintenanceSnapshot().last_error??'fold missing');
  assert.equal(f.archive.maintenanceSnapshot().discovery.unresolved,0);
  for(const proof of proofs){assert.deepEqual(await f.storage.read(proof.namespace,proof.key),proof.bytes);
    await assert.rejects(f.storage.readHot(proof.namespace,proof.key),{code:'ENOENT'});}
});


test('owner deletion preserves the span of an untracked legacy peer before discovery',async t=>{
  const f=await fixture(t),first=await f.add('a-span'),second=await f.add('b-span');
  const audio=new AudioConsumption(f.storage,1048576),route={consumer:'media' as const,source_scope:'shared-source',capture_span:'shared-span',purpose_evidence_ref:'fixture'};
  await audio.select(first.event,'continuous',route);
  const track=f.storage.trackSessionRecords.bind(f.storage);f.storage.trackSessionRecords=async()=>{};
  await audio.select(second.event,'continuous',route);f.storage.trackSessionRecords=track;
  const key=digest([trusted.principal_id,trusted.device_id,route.source_scope,route.capture_span]),before=await f.storage.read('audio-consumer-spans',key);
  await f.archive.delete(first.event.raw_ref,trusted.principal_id);
  assert.deepEqual(await f.storage.read('audio-consumer-spans',key),before);
  assert.equal((await audio.existingRoute(second.event))?.capture_span,route.capture_span);
});


test('replayed cross-source frame claims retain dedup after the original owner is deleted',async t=>{
  const f=await fixture(t),first=await f.add('a-first'),second=await f.add('a-second');
  const audio=new AudioConsumption(f.storage,1048576),route={consumer:'media' as const,source_scope:'shared-source',capture_span:'shared-span',purpose_evidence_ref:'fixture'};
  await audio.select(first.event,'continuous',route);await audio.select(second.event,'continuous',route);
  let calls=0;const run=async(accept:()=>Promise<void>)=>{calls++;await accept();return {status:'queued'};};
  await audio.chunk(first.event,{seq:0},first.chunk.object_hash,run);
  assert.equal((await audio.chunk(second.event,{seq:0},second.chunk.object_hash,run)).status,'duplicate');
  await f.archive.finalizeSession(first.event.raw_ref);
  await f.archive.delete(first.event.raw_ref,trusted.principal_id);
  assert.equal((await audio.chunk(second.event,{seq:0},second.chunk.object_hash,run)).status,'duplicate');
  assert.equal(calls,1,'Deleting the original owner must not permit the surviving source to consume the same samples twice');
});

for(const replacement of [false,true])test(`a replay rejects ${replacement?'replaced':'deleted'} facts between verification and ownership binding`,async t=>{
  const f=await fixture(t),first=await f.add('a-first'),second=await f.add('a-second'),third=await f.add('a-third');
  const audio=new AudioConsumption(f.storage,1048576),route={consumer:'media' as const,source_scope:'shared-source',capture_span:'shared-span',purpose_evidence_ref:'fixture'};
  await audio.select(first.event,'continuous',route);await audio.select(second.event,'continuous',route);await audio.select(third.event,'continuous',route);
  let calls=0;const run=async(accept:()=>Promise<void>)=>{calls++;await accept();return {status:'queued'};};
  await audio.chunk(first.event,{seq:0},first.chunk.object_hash,run);
  const read=f.storage.read.bind(f.storage);let remove=true;
  f.storage.read=async(namespace,key)=>{
    const bytes=await read(namespace,key);
    if(remove&&namespace==='audio-consumer-attempts'){
      remove=false;await f.archive.delete(first.event.raw_ref,trusted.principal_id);
      if(replacement)await audio.chunk(third.event,{seq:0},third.chunk.object_hash,async accept=>{await accept();return {status:'replacement'};});
    }
    return bytes;
  };
  await assert.rejects(audio.chunk(second.event,{seq:0},second.chunk.object_hash,run),/AUDIO_CONSUMPTION_CONFLICT/);
  assert.equal(calls,1,'An ownership race must not start a second consumer');
  assert.equal((await f.storage.sessionRecords(second.event.raw_ref)).filter(r=>r.namespace==='audio-consumer-results').length,0);
});
