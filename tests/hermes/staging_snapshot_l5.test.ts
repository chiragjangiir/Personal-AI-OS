import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {exportL5,verifyL5} from '../../deploy/cloud/staging_snapshot_l5.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/archive.ts';
import {EVENT_SCHEMA,canonical,digest,sha256} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import type {RawEvent,TrustedContext} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import type {TrackChunk} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/stream-archive.ts';

const old='2026-10-10T00:00:00.000Z',now='2026-10-17T00:00:00.000Z';
const owner:TrustedContext={principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'text',submission:'explicit_text'};
const observation:TrustedContext={...owner,device_id:'glasses',device_type:'glasses',channel:'livekit',submission:'observation'};
const raw=(event_id:string):RawEvent=>({schema_version:EVENT_SCHEMA,event_id,device_id:'mac',device_type:'mac',captured_at:old,
  source:{channel:'text'},media_type:'text',mime:'text/plain',representation:'uploaded_original',payload:Buffer.from(event_id)});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:1000:1',
  source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}});
async function fixture(t:test.TestContext,cold=false){
  const root=await fs.mkdtemp(join(tmpdir(),'staging-l5-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),dest=join(root,'dest'),packs=new Map<string,Buffer>();
  const server=createServer(async(req,res)=>{
    if(req.method==='PUT'){const parts=[];for await(const p of req)parts.push(p);packs.set(req.url!,Buffer.concat(parts));res.writeHead(201).end();return;}
    const bytes=packs.get(req.url!);if(!bytes){res.writeHead(404).end();return;}
    const range=/bytes=(\d+)-(\d+)/u.exec(String(req.headers.range));
    if(range){const start=Number(range[1]),end=Number(range[2]);res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`}).end(bytes.subarray(start,end+1));}
    else res.end(bytes);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const password=join(root,'cold.password');await fs.writeFile(password,'fixture');
  const config={url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,username:'fixture',password_file:password};
  const storage=new PosixStorage(source,cold?{cold:config}:{});await fs.mkdir(source);
  let clock=old;const archive=new RawArchive(storage,65536,()=>clock);
  t.after(async()=>{await archive.close();await storage.close();});
  const older=await archive.archive(raw('older'),owner);clock=now;const recent=await archive.archive(raw('recent'),owner);
  const streamRaw={...raw('lane'),device_id:'glasses',device_type:'glasses' as const,source:{channel:'livekit'},
    media_type:'livekit_tracks' as const,mime:'audio/pcm',representation:'received_decoded_sample' as const,payload:Buffer.alloc(200)};
  const parent=await archive.streams.append(streamRaw,observation,old,chunk(0));
  const head=await archive.streams.append(streamRaw,observation,now,chunk(1));
  const quarantine=await archive.archiveUnknownClock({...streamRaw,event_id:'unknown',captured_at:null,capture_clock_status:'unknown'},observation,chunk(0),{fixture:true});
  return {root,source,dest,storage,archive,older,recent,parent,head,quarantine,config};
}
for(const cold of [false,true])test(`recent48h exports exact original, quarantine and full stream parents (${cold?'cold+hot':'hot'})`,async t=>{
  const f=await fixture(t,cold);
  if(cold){const records=[];for(const namespace of ['manifests','stream-revisions','quarantine-manifests','objects'])
    for(const key of await f.storage.listHot(namespace))records.push({namespace,key,bytes:await f.storage.read(namespace,key)});
    await f.storage.moveCold(records);await f.storage.removeOriginals(records);await f.storage.close();}
  const before=(await fs.stat(f.source)).mtimeMs;
  const receipt=await exportL5(f.source,f.dest,now,cold?f.config:undefined);
  assert.equal((await fs.stat(f.source)).mtimeMs,before);
  assert.equal(receipt.sources.length,3);assert.ok(receipt.excluded_history.some(r=>r.ref===f.older.raw_ref));
  assert.ok(receipt.files.some(r=>r.namespace==='stream-revisions'&&r.key===f.parent.event.archive_revision));
  assert.ok(receipt.files.some(r=>r.namespace==='stream-revisions'&&r.key===digest([f.parent.event.raw_ref,1])));
  assert.ok(receipt.files.some(r=>r.namespace==='quarantine-manifests'&&r.key===f.quarantine.quarantine_ref.slice(14)));
  await verifyL5(f.dest);
  const restored=new RawArchive(new PosixStorage(f.dest),65536);
  try{assert.deepEqual(await restored.read(f.recent.raw_ref,'owner',f.recent.archive_revision),raw('recent').payload);
    assert.equal((await restored.streams.head(f.head.event.raw_ref))!.revision,2);
    await assert.rejects(restored.read(f.older.raw_ref,'owner',f.older.archive_revision));
  }finally{await restored.close();}
  await fs.writeFile(join(f.dest,'objects',f.recent.payload_sha256),'broken');
  await assert.rejects(verifyL5(f.dest),/L5_INVENTORY_INTEGRITY|ARCHIVE_OBJECT_INTEGRITY_FAILURE/);
});
test('recent stream missing parent alias fails rather than exporting a partial lane',async t=>{
  const f=await fixture(t);await fs.unlink(join(f.source,'stream-revisions',digest([f.parent.event.raw_ref,1])));
  await assert.rejects(exportL5(f.source,f.dest,now),/L5_STREAM_HEAD_MISSING/);
  assert.ok(!(await fs.readdir(f.dest)).some(name=>name.startsWith('.cold-read-')));
});
test('cold index without credential configuration fails explicitly',async t=>{
  const f=await fixture(t,true),key=f.recent.raw_ref.slice(3);
  await f.storage.moveCold([{namespace:'manifests',key,bytes:await f.storage.read('manifests',key)}]);
  await f.storage.close();await assert.rejects(exportL5(f.source,f.dest,now),/COLD_CONFIG_REQUIRED/);
});
test('an uncommitted durable capture refuses a partial window rather than losing its original',async t=>{
  const f=await fixture(t),payload=Buffer.from('uncommitted original'),hash=sha256(payload);
  const bytes=Buffer.from(canonical({schema:'paios.raw-ingress.v1',record:{received_at:now},object_hash:hash,bytes:payload.length}));
  await f.storage.publishIngress(sha256(bytes),bytes,hash,payload);await f.archive.close();await f.storage.close();
  await assert.rejects(exportL5(f.source,f.dest,now),/RAW_INGRESS_PENDING/);
  assert.deepEqual(Buffer.from(await fs.readFile(join(f.source,'objects',hash))),payload);
});
test('unreferenced concurrent stream proposal does not invalidate its committed lane',async t=>{
  const f=await fixture(t),record=JSON.parse(Buffer.from(await f.storage.read('stream-revisions',f.head.event.archive_revision)).toString());
  record.chunk={...record.chunk,received_at:'2026-10-16T23:59:59.000Z'};
  const key=digest(record);await f.storage.publish('stream-revisions',key,Buffer.from(JSON.stringify(record)));
  const receipt=await exportL5(f.source,f.dest,now);
  assert.equal(receipt.uncommitted_proposals,1);assert.equal(receipt.sources.length,3);
  assert.ok(!receipt.files.some(item=>item.namespace==='stream-revisions'&&item.key===key));
  await verifyL5(f.dest);
});
test('native deletion authority excludes revoked original bytes and keeps the revocation',async t=>{
  const f=await fixture(t),key=f.recent.raw_ref.slice(3);
  await f.storage.publish('owner-deletions',key,Buffer.from(JSON.stringify({principal_id:'owner',raw_ref:f.recent.raw_ref,objects:[f.recent.payload_sha256]})));
  const receipt=await exportL5(f.source,f.dest,now);
  assert.equal(receipt.revoked_refs,1);assert.ok(!receipt.sources.some(source=>source.ref===f.recent.raw_ref));
  assert.ok(receipt.files.some(item=>item.namespace==='owner-deletions'&&item.key===key));
  assert.ok(!receipt.files.some(item=>item.namespace==='objects'&&item.key===f.recent.payload_sha256));
  await verifyL5(f.dest);
});
for(const mode of ['hot','cold','pending'])test(`canonical sessions preserve call grouping, pinned revisions and only selected finals (${mode})`,
  {skip:!('readFinal' in PosixStorage.prototype)},async t=>{
  const f=await fixture(t,mode==='cold'),storage=f.storage as any,archive=f.archive as any,ref=f.head.event.raw_ref;
  const call={call_id:'fixture-call',principal_id:'owner',track:'microphone'};
  await storage.bindCallTrack(ref,call);
  const complete=storage.completeFinal.bind(storage);if(mode==='pending')storage.completeFinal=async()=>{};
  const final=await archive.finalizeSession(ref,'fixture-ended');assert.ok(final);
  storage.completeFinal=complete;
  const historical={...raw('historical-lane'),device_id:'glasses',device_type:'glasses',source:{channel:'livekit'},
    media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(200,3)};
  const earlier=await archive.streams.append(historical,observation,old,chunk(0));
  await archive.finalizeSession(earlier.event.raw_ref,'fixture-ended');
  if(mode==='cold'){
    const records=[];for(const namespace of ['objects','manifests','quarantine-manifests'])
      for(const key of await storage.listHot(namespace))records.push({namespace,key,bytes:await storage.read(namespace,key)});
    await storage.moveCold(records);await storage.removeOriginals(records);
  }
  await archive.close();await storage.close();
  const receipt=await exportL5(f.source,f.dest,now,mode==='cold'?f.config:undefined);
  assert.equal(receipt.files.filter(f=>f.namespace==='session-finals').length,1);
  assert.ok(!receipt.files.some(f=>f.namespace==='stream-revisions'));
  assert.ok(receipt.sources.find(s=>s.ref===ref)?.revisions?.includes(f.parent.event.archive_revision));
  const restored=new PosixStorage(f.dest) as any,reader=new RawArchive(restored,65536);
  try{
    assert.deepEqual(await restored.readFinal(ref),final);
    assert.equal(await restored.readFinal(earlier.event.raw_ref),null);
    assert.deepEqual(await restored.callTracks('fixture-call','owner'),[{raw_ref:ref,track:'microphone',finalized:true}]);
    assert.deepEqual(await restored.pendingFinals(),mode==='pending'?[ref]:[]);
    const pinned=await reader.readRecord(ref,'owner',f.parent.event.archive_revision);
    assert.equal(pinned.kind,'stream');if(pinned.kind==='stream')assert.equal(pinned.chunks.length,1);
  }finally{await reader.close();await restored.close();}
  await verifyL5(f.dest);
  await fs.writeFile(join(f.dest,'objects',final.object_hash),Buffer.alloc(final.bytes,7));
  await assert.rejects(verifyL5(f.dest),/SESSION_FINAL_READBACK_FAILED/);
});
test('an unfinished selected session preserves native live record ownership and call binding',
  {skip:!('readFinal' in PosixStorage.prototype)},async t=>{
  const f=await fixture(t),storage=f.storage as any,ref=f.head.event.raw_ref;
  const call={call_id:'live-fixture',principal_id:'owner',track:'assistant_reply'};
  await storage.bindCallTrack(ref,call);const records=await storage.sessionRecords(ref);assert.ok(records.length);
  await f.archive.close();await storage.close();await exportL5(f.source,f.dest,now);
  const restored=new PosixStorage(f.dest) as any;
  try{assert.deepEqual(await restored.callTrack(ref),call);assert.deepEqual(await restored.sessionRecords(ref),records);
    for(const record of records)assert.equal(await restored.hasLiveSessionOwner(record),true);
  }finally{await restored.close();}
});

test('history enumeration never materializes an unbounded storage list',async t=>{
  const f=await fixture(t),original=PosixStorage.prototype.list;
  PosixStorage.prototype.list=async function(namespace,max){
    assert.ok(max!==undefined,`unbounded historical list: ${namespace}`);
    return original.call(this,namespace,max);
  };
  try{const receipt=await exportL5(f.source,f.dest,now);assert.equal(receipt.sources.length,3);}
  finally{PosixStorage.prototype.list=original;}
});

test('old references use disk grouping and an exact count with a bounded sample',async t=>{
  const f=await fixture(t),record=JSON.parse(Buffer.from(await f.storage.read('manifests',f.older.raw_ref.slice(3))).toString());
  for(let i=0;i<256;i++)await fs.writeFile(join(f.source,'manifests',digest(['old',i])),JSON.stringify(record));
  const receipt=await exportL5(f.source,f.dest,now);
  assert.equal(receipt.excluded_history_count,257);assert.equal(receipt.excluded_history.length,128);
  assert.equal(receipt.sources.length,3);assert.ok(receipt.closure_policy.includes('sample'));
  await verifyL5(f.dest);
});
