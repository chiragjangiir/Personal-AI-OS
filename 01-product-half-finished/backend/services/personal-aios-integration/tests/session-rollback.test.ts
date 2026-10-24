import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PosixStorage,type StoragePort} from '../src/storage.ts';
import {StreamArchive,type TrackChunk} from '../src/stream-archive.ts';
import {finalizeSession} from '../src/session-finalization.ts';
import {canonical,digest,sha256,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {restoreSessionLayout} from '../tools/restore-session-layout.ts';

const at='2026-10-17T00:00:00.000Z',budget={max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:64,max_revisions:64,max_seq:100};
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'fixture',channel:'livekit',submission:'observation'};
const raw=(payload:Buffer):RawEvent=>({schema_version:'paios.event.v1',event_id:'rollback',device_id:'glasses',device_type:'glasses',
  captured_at:at,source:{channel:'livekit'},media_type:'livekit_tracks',mime:'audio/pcm',representation:'received_decoded_sample',payload});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'audio',seq,modality:'audio',format:'pcm_s16le:16000:1',
  source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'audio',start_ms:seq*100,end_ms:(seq+1)*100}});
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'paios-rollback-')),storage=new PosixStorage(root),archive=new StreamArchive(storage,budget);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const payloads=[Buffer.alloc(3200,1),Buffer.alloc(3200,2)],receipts=[];
  receipts.push(await archive.append(raw(payloads[0]!),trusted,at,chunk(0)));
  const visual=Buffer.from([4,8,12,16]),video:TrackChunk={track_id:'camera',stream_epoch:'visual',seq:0,modality:'visual',
    format:'livekit_decoded:0:2:2:rotation:0',source_range:{kind:'instant',timebase_id:'camera',stream_epoch:'visual',at_ms:50}};
  receipts.push(await archive.append({...raw(visual),mime:'application/x-livekit-video-buffer'},trusted,at,video));
  receipts.push(await archive.append(raw(payloads[1]!),trusted,at,chunk(1)));
  const metadata=Buffer.from(canonical({raw_ref:receipts[0]!.event.raw_ref,status:'retained failure'})),metadataKey=digest('rollback-metadata');
  await storage.trackSessionRecords(receipts[0]!.event.raw_ref,[{namespace:'media-source-failures',key:metadataKey}]);
  await storage.publish('media-source-failures',metadataKey,metadata);
  const before=[];for(const receipt of receipts)before.push(await archive.readRecord(receipt.event.raw_ref,'owner',receipt.event.archive_revision));
  const final=await finalizeSession(storage,archive,receipts[0]!.event.raw_ref,'fixture_end');await storage.close();
  assert.ok(final);
  return {root,storage,payloads,visual,receipts,before,final,metadata,metadataKey};
}

test('rollback restores every pinned revision for a loose-only pre-fold reader and keeps mixed visual bytes',async t=>{
  const f=await fixture(t);
  const previewState=async()=>{const entries:unknown[]=[];const walk=async(dir:string):Promise<void>=>{
    for(const name of (await fs.readdir(dir)).sort()){const path=join(dir,name),stat=await fs.lstat(path);
      entries.push([path.slice(f.root.length),stat.mode,stat.size,stat.mtimeMs,stat.isFile()?(await fs.readFile(path)).toString('base64'):null]);
      if(stat.isDirectory())await walk(path);}};await walk(f.root);return entries;};
  const before=await previewState(),dry=await restoreSessionLayout(f.root);
  assert.deepEqual(await previewState(),before,'rollback preview must not alter source bytes or file metadata');
  assert.equal(dry.mode,'dry-run');assert.equal(dry.restored_files,0);assert.equal(dry.sessions,1);
  await assert.rejects(fs.lstat(join(f.root,'objects',sha256(f.payloads[0]!))),/ENOENT/);
  await assert.rejects(restoreSessionLayout(f.root,{apply:true}),/APPLY_REQUIRES_GATEWAY_STOPPED/);
  const result=await restoreSessionLayout(f.root,{apply:true,gatewayStopped:true});assert.equal(result.already_present,1);
  assert.equal(result.restored_files,result.files-result.already_present);assert.ok(result.restored_bytes>6400);
  const physical=new PosixStorage(f.root);
  t.after(()=>physical.close());
  const loose:StoragePort={read:(namespace,key)=>physical.readHot(namespace,key),publish:(namespace,key,bytes)=>physical.publish(namespace,key,bytes),
    list:namespace=>physical.listHot(namespace),removePending:key=>physical.removePending(key)};
  const oldReader=new StreamArchive(loose,budget);
  for(let n=0;n<f.receipts.length;n++){const receipt=f.receipts[n]!,restored=await oldReader.readRecord(receipt.event.raw_ref,'owner',receipt.event.archive_revision);
    assert.deepEqual(restored,f.before[n]);}
  for(const record of f.final.records)assert.deepEqual(await physical.readHot(record.namespace,record.key),Buffer.from(record.bytes,'base64'));
  assert.deepEqual(await physical.readHot('media-source-failures',f.metadataKey),f.metadata);
  assert.deepEqual(await physical.readHot('objects',sha256(f.visual)),f.visual);
  assert.deepEqual(await physical.readHot('objects',f.final.object_hash),Buffer.concat(f.payloads));
  assert.deepEqual(await physical.readFinal(f.final.raw_ref),f.final);
});

test('an interrupted partial physical restoration resumes and completed reruns write no new keys',async t=>{
  const f=await fixture(t),partial=new PosixStorage(f.root),record=f.final.records[0]!,object=f.final.objects[0]!;
  await partial.publishRestored(record.namespace,record.key,Buffer.from(record.bytes,'base64'));
  await partial.publishRestored('objects',object.key,await partial.read('objects',object.key));await partial.close();
  const result=await restoreSessionLayout(f.root,{apply:true,gatewayStopped:true});assert.equal(result.already_present,3);assert.equal(result.restored_files,result.files-3);
  const again=await restoreSessionLayout(f.root,{apply:true,gatewayStopped:true});assert.equal(again.restored_files,0);assert.equal(again.restored_bytes,0);assert.equal(again.already_present,again.files);
  assert.deepEqual(again.bytes,result.bytes);
});
test('rollback preview retains the physical reader symlink boundary',async t=>{
  const f=await fixture(t);await fs.rename(join(f.root,'objects'),join(f.root,'objects-source'));
  await fs.symlink('objects-source',join(f.root,'objects'));
  await assert.rejects(restoreSessionLayout(f.root),/UNSAFE_STORAGE_NAMESPACE/);
});
test('rollback cannot report complete when a retained visual original is absent',async t=>{
  const f=await fixture(t);await fs.unlink(join(f.root,'objects',sha256(f.visual)));
  await assert.rejects(restoreSessionLayout(f.root),{code:'ENOENT'});
  await assert.rejects(restoreSessionLayout(f.root,{apply:true,gatewayStopped:true}),{code:'ENOENT'});
});
test('rollback requires the consolidated payload even for a singleton with no range mappings',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-singleton-rollback-')),storage=new PosixStorage(root),archive=new StreamArchive(storage,budget);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const receipt=await archive.append(raw(Buffer.alloc(3200,7)),trusted,at,chunk(0));
  const final=await finalizeSession(storage,archive,receipt.event.raw_ref,'fixture_end');await storage.close();assert.ok(final);
  assert.equal(final.objects.length,0);await fs.unlink(join(root,'objects',final.object_hash));
  await assert.rejects(restoreSessionLayout(root),{code:'ENOENT'});
  await assert.rejects(restoreSessionLayout(root,{apply:true,gatewayStopped:true}),{code:'ENOENT'});
});
test('rollback joins admitted metadata writes before surfacing a batch failure and can resume',async t=>{
  const f=await fixture(t),publish=PosixStorage.prototype.publishRestored;let active=0,first=true,release!:()=>void;
  const secondStarted=new Promise<void>(resolve=>{release=resolve;});
  PosixStorage.prototype.publishRestored=async function(namespace,key,bytes){
    active++;
    try{if(first){first=false;await secondStarted;throw new Error('INJECTED_RESTORE_WRITE_FAILURE');}
      release();await new Promise(resolve=>setTimeout(resolve,20));return await publish.call(this,namespace,key,bytes);
    }finally{active--;}
  };
  try{await assert.rejects(restoreSessionLayout(f.root,{apply:true,gatewayStopped:true}),/INJECTED_RESTORE_WRITE_FAILURE/);
    assert.equal(active,0,'failure must join admitted writes before closing their storage');
  }finally{PosixStorage.prototype.publishRestored=publish;}
  const resumed=await restoreSessionLayout(f.root,{apply:true,gatewayStopped:true});assert.ok(resumed.already_present>1);
  assert.equal(resumed.restored_files+resumed.already_present,resumed.files);
  assert.equal((await restoreSessionLayout(f.root,{apply:true,gatewayStopped:true})).restored_files,0);
});
