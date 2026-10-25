import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {canonical,digest,sha256,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {streamManifestRevision,type TrackChunk} from '../src/stream-archive.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {sourceClient} from './native-source-fixture.ts';
import {webdav} from './stream-materialized-fixture.ts';
import {AudioConsumption} from '../src/media/audio-consumption.ts';
import {restoreSessionLayout} from '../tools/restore-session-layout.ts';

// The export is unmodified git-archive output. Only npm lookup uses the standard installed dependencies.
const exported=process.env.PAIOS_REL26_ROOT;
const at='2026-10-18T00:00:00.000Z',budget={max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:64,max_revisions:64,max_seq:100};
const trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',consent_ref:'fixture',channel:'formal',submission:'observation'};
const raw=(id:string,seq:number):RawEvent=>({schema_version:'paios.event.v1',event_id:id,device_id:'phone',device_type:'phone',captured_at:at,
  source:{channel:'formal'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,seq+1)});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'audio',seq,modality:'audio',format:'pcm_s16le:16000:1',
  source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'audio',start_ms:seq*100,end_ms:(seq+1)*100}});
const make=(storage:PosixStorage)=>new RawArchive(storage,65536,()=>at,budget);
async function oldCode(){
  const root=pathToFileURL(resolve(exported!)+ '/').href;
  const hook=registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.startsWith(root)&&!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.includes(':'))
      return next(specifier,{...context,parentURL:context.parentURL.replace(root,new URL('../../../../../',import.meta.url).href)});
    return next(specifier,context);
  }});
  const base=root+'01-product-half-finished/backend/services/personal-aios-integration/';
  try{return {archive:await import(base+'src/archive.ts'),storage:await import(base+'src/storage.ts'),
    consumer:await import(base+'src/media/audio-consumption.ts'),assembly:await import(base+'src/assembly.ts'),fixture:await import(base+'tests/native-source-fixture.ts')};}
  finally{hook.deregister();}
}
async function inventory(root:string){
  const files=new Map<string,Buffer>();
  const walk=async(dir:string):Promise<void>=>{for(const name of await fs.readdir(dir)){const path=join(dir,name),s=await fs.lstat(path);
    if(s.isDirectory())await walk(path);else if(s.isFile())files.set(path.slice(root.length+1),await fs.readFile(path));}};
  await walk(root);return files;
}
const policy={max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'legacy-proof'};
const device={...trusted,route_version:'fixture',output_modes:['text'] as ['text'],token_sha256:sha256('legacy-proof-token')};
const options={skill:'fixture',max_event_bytes:65536,max_read_bytes:65536,devices:[device],admission:policy,
  http:{internal_token:'legacy-proof-internal-token',max_request_bytes:65536,request_timeout_ms:1000}};
const noNative={async create(){throw Error('DUPLICATE_NATIVE_CREATE');},async status(){throw Error('UNEXPECTED_POLL');},async cancel(){throw Error('UNEXPECTED_CANCEL');}};
async function rootFor(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'legacy-compat-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function add(writer:RawArchive,id:string){const receipts=[];for(let n=0;n<3;n++)receipts.push(await writer.streams.append(raw(id,n),trusted,at,chunk(n)));return receipts;}
async function listen(assembly:ReturnType<typeof createPersonalAIOSAssembly>){
  await new Promise<void>(done=>assembly.server.listen(0,'127.0.0.1',done));
  const address=assembly.server.address();assert.ok(address&&typeof address!=='string');
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status,200);
}

test('legacy starts; partial cleanup exposes its reader defect; intact folds reject cleanly and roll-forward restores all reads',{skip:!exported},async t=>{
  const old=await oldCode(),root=await rootFor(t),dav=await webdav(t,root),hot=join(root,'hot'),storage=new PosixStorage(hot,{cold:dav.config}),writer=make(storage);
  const sources=[];
  for(const mode of ['folded','end-intent','committed','partial']){
    const receipts=await add(writer,mode),ref=receipts[0]!.event.raw_ref;
    await writer.bindCallTrack(ref,{call_id:'call-round3',principal_id:'owner',track:'microphone'});
    if(mode==='end-intent'){
      const head=await writer.streams.head(ref);assert.ok(head);
      await storage.publish('session-ends',ref.slice(3),Buffer.from(canonical({schema:'paios.session.end.v1',raw_ref:ref,revision:streamManifestRevision(head),ended_by:'call_closed'})));
    }else{
      const remove=storage.removeOriginals.bind(storage);
      if(mode!=='folded')storage.removeOriginals=async records=>{if(mode==='partial')await remove(records.slice(0,2));throw Error('CRASH_AFTER_FINAL_COMMIT');};
      try{if(mode==='folded')await writer.finalizeSession(ref,'call_closed');else await assert.rejects(writer.finalizeSession(ref,'call_closed'),/CRASH_AFTER_FINAL_COMMIT/);}
      finally{storage.removeOriginals=remove;}
    }
    sources.push({mode,receipts,ref});
  }
  await writer.close();await storage.close();
  const before=await inventory(hot),legacy=new old.storage.PosixStorage(hot,{cold:dav.config}),reader=new old.archive.RawArchive(legacy,65536,()=>at,budget);
  const service=old.assembly.createPersonalAIOSAssembly({...options,storage:legacy,archive:reader,native:old.fixture.sourceClient(noNative)});
  try{
    await listen(service);await reader.recover();
    for(const source of sources){
      if(source.mode==='partial')await assert.rejects(reader.readRecord(source.ref,'owner',source.receipts[2]!.event.archive_revision),TypeError);
      else if(source.mode==='folded')await assert.rejects(reader.readRecord(source.ref,'owner',source.receipts[2]!.event.archive_revision),error=>
        error instanceof Error&&/RAW_REF_NOT_FOUND|ARCHIVE_REVISION_CONFLICT|STREAM_REVISION_NOT_FOUND|STREAM_REVISION_INTEGRITY/.test(String(error)));
      else assert.equal((await reader.readRecord(source.ref,'owner',source.receipts[2]!.event.archive_revision)).chunks.length,3);
    }
    await reader.moveCold(2,Date.now());
  }finally{await service.close();await legacy.close();}
  const after=await inventory(hot);
  for(const [path,bytes] of before)if(!/^cold\.sqlite(?:-wal|-shm)?$/u.test(path))assert.ok(after.get(path)?.equals(bytes),`legacy reader changed branch data: ${path}`);
  const disk=new PosixStorage(hot,{cold:dav.config}),forward=make(disk);
  try{
    await forward.recover();assert.deepEqual(await disk.pendingFinals(),[]);
    assert.equal((await forward.readCallTracks('call-round3','owner')).length,4);
    for(const source of sources)for(const receipt of source.receipts){const record=await forward.readExactChunk(receipt.event,chunk(receipt.chunk.seq),3200);
      assert.deepEqual(Buffer.from(record.bytes),Buffer.from(raw(source.mode,receipt.chunk.seq).payload));}
    assert.equal((await disk.list('session-finals')).length,4);await forward.recover();assert.equal((await disk.list('session-finals')).length,4);
  }finally{await forward.close();await disk.close();}
  console.log(JSON.stringify({rel26:'8edc4bd4',kinds:sources.map(s=>s.mode),protected_archive_files:before.size-1,archive_unchanged:true,cold_index:'extended_by_upload',partial_read:'TypeError',folded_read:'ARCHIVE_REVISION_CONFLICT',forward_finals:4}));
});

test('legacy retention cannot protect a folded-only dependency shared by another original; release gate prevents that layout',{skip:!exported},async t=>{
  const old=await oldCode();
  for(const folding of [true,false]){
    const root=await rootFor(t),storage=new PosixStorage(root),writer=make(storage);
    writer.setSessionFolding(folding);
    const receipts=await add(writer,'shared'),ref=receipts[0]!.event.raw_ref;
    await writer.bindCallTrack(ref,{call_id:'gated-call',principal_id:'owner',track:'microphone'});
    if(!folding){const consumer=new AudioConsumption(storage,65536);for(const receipt of receipts){
      await consumer.select(receipt.event,'continuous');
      await consumer.chunk(receipt.event,chunk(receipt.chunk.seq),receipt.chunk.object_hash,async accept=>{await accept();return {status:'queued',stream_key:'gated-source'};});}}
    await writer.finalizeSession(ref,'call_closed');
    const bytes=Buffer.concat([0,1,2].map(n=>Buffer.from(raw('shared',n).payload)));
    const other=await writer.archive({...raw('other',0),media_type:'file',mime:'application/octet-stream',representation:'uploaded_original',payload:bytes},trusted);
    await writer.close();await storage.close();
    const legacy=new old.storage.PosixStorage(root),reader=new old.archive.RawArchive(legacy,65536,()=>at,budget);
    try{await reader.recover();
      if(!folding){const consumer=new old.consumer.AudioConsumption(legacy,65536);for(const receipt of receipts){
        await consumer.select(receipt.event,'continuous');
        await consumer.chunk(receipt.event,chunk(receipt.chunk.seq),receipt.chunk.object_hash,async()=>{throw Error('DUPLICATED_PROCESSING_EFFECT');});}}
      await reader.delete(other.raw_ref,'owner');}finally{await reader.close();await legacy.close();}
    const disk=new PosixStorage(root),forward=make(disk);
    try{
      if(folding)await assert.rejects(forward.readExactChunk(receipts[0]!.event,chunk(0),3200),{code:'ENOENT'});
      else{
        for(const receipt of receipts)assert.deepEqual(Buffer.from((await forward.readExactChunk(receipt.event,chunk(receipt.chunk.seq),3200)).bytes),Buffer.from(raw('shared',receipt.chunk.seq).payload));
        await forward.recover();assert.equal((await disk.list('session-finals')).length,1);
        assert.deepEqual((await forward.readCallBindings('gated-call','owner')).map(r=>r.finalized),[true]);
      }
    }finally{await forward.close();await disk.close();}
    console.log(JSON.stringify({rel26:'8edc4bd4',folding,shared_dependency:folding?'deleted_by_legacy':'preserved',release_config_safe:!folding}));
  }
});

test('legacy recovers the G3 final-turn admission without rewrite or duplicate submission; image rollback then restore is readable',{skip:!exported},async t=>{
  const old=await oldCode(),root=await rootFor(t),storage=new PosixStorage(root),writer=make(storage);
  let creates=0;const native=sourceClient({async create(body){creates++;return {run_id:'round3-run',session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};},async status(){return {run_id:'round3-run',session_id:'conversation',conversation_session_id:'conversation',status:'completed'};},async cancel(){throw Error('UNEXPECTED_CANCEL');}});
  const service=createPersonalAIOSAssembly({...options,storage,archive:writer,native});
  t.after(async()=>{await service.close();await storage.close();});
  const source=await service.runtime.authenticate('legacy-proof-token');
  const event:RawEvent={...raw('voice-turn:'+digest(['conversation','call-round3',1]),0),media_type:'app_event',mime:'application/json',representation:'uploaded_original',
    payload:Buffer.from(JSON.stringify({kind:'voice_turn',call_id:'call-round3',turn:1,user:'最后一句',assistant:''}))};
  const accepted=await service.runtime.submitCallTurn(event,source,'conversation');
  for(let n=0;!(await storage.list('run-terminals')).length&&n<1000;n++)await new Promise(done=>setTimeout(done,5));
  assert.equal((await storage.list('run-terminals')).length,1);await service.close();await storage.close();assert.equal(creates,1);
  const before=await inventory(root),legacy=new old.storage.PosixStorage(root),oldService=old.assembly.createPersonalAIOSAssembly({...options,storage:legacy,native:old.fixture.sourceClient(noNative)});
  try{await listen(oldService);
    const device=await oldService.runtime.authenticate('legacy-proof-token');
    const replay=await oldService.runtime.submitCallTurn(event,device,'conversation');
    assert.equal(replay.processed_event.processed_event_id,accepted.processed_event.processed_event_id);
    assert.equal(replay.admission.state,'completed');
  }finally{await oldService.close();await legacy.close();}
  const after=await inventory(root);for(const [path,bytes] of before)assert.deepEqual(after.get(path),bytes,`G3 rewritten: ${path}`);
  const disk=new PosixStorage(root),forward=createPersonalAIOSAssembly({...options,storage:disk,native});
  try{const replay=await forward.runtime.submitCallTurn(event,await forward.runtime.authenticate('legacy-proof-token'),'conversation');
    assert.equal(replay.admission?.state,'completed');assert.equal(creates,1);assert.equal((await disk.list('admissions')).length,1);
  }finally{await forward.close();await disk.close();}
  const audioStorage=new PosixStorage(root),audio=make(audioStorage),receipts=await add(audio,'restore');
  await audio.finalizeSession(receipts[0]!.event.raw_ref);await audio.close();await audioStorage.close();
  await restoreSessionLayout(root,{apply:true,gatewayStopped:true});
  const restored=new old.storage.PosixStorage(root),oldReader=new old.archive.RawArchive(restored,65536,()=>at,budget);
  try{for(const receipt of receipts)assert.equal((await oldReader.readRecord(receipt.event.raw_ref,'owner',receipt.event.archive_revision)).chunks.length,receipt.chunk.seq+1);}
  finally{await oldReader.close();await restored.close();}
  console.log(JSON.stringify({rel26:'8edc4bd4',g3_admissions:1,native_creates:creates,replayed_terminal:'completed',physical_restore:'legacy_reads_all_pinned_revisions'}));
});

test('legacy drains admitted ingress of a gated ended source; roll-forward folds each admitted chunk once',{skip:!exported},async t=>{
  const old=await oldCode(),root=await rootFor(t),storage=new PosixStorage(root),writer=make(storage);
  writer.setSessionFolding(false);
  const receipts=await add(writer,'pending-ended'),ref=receipts[0]!.event.raw_ref,{payload,...metadata}=raw('pending-ended',3);
  const input={schema:'paios.raw-ingress.v1',record:{kind:'stream',raw:metadata,trusted,chunk:chunk(3),received_at:at},object_hash:sha256(payload),bytes:payload.length};
  const bytes=Buffer.from(canonical(input)),key=sha256(bytes);
  await storage.publish('objects',input.object_hash,payload);await storage.publish('raw-ingress',key,bytes);
  assert.equal(await writer.finalizeSession(ref,'source_closed'),null);
  const end=Buffer.from(await storage.readHot('session-ends',ref.slice(3)));
  await writer.close();await storage.close();
  const legacy=new old.storage.PosixStorage(root),reader=new old.archive.RawArchive(legacy,65536,()=>at,budget);
  try{
    await reader.recover();await reader.close();assert.deepEqual(await legacy.list('raw-ingress'),[]);
    assert.deepEqual(Buffer.from(await legacy.read('session-ends',ref.slice(3))),end);
    const head=await reader.streams.head(ref);assert.equal(head.chunks.length,4);
    const record=await reader.readRecord(ref,'owner',streamManifestRevision(head));assert.deepEqual(Buffer.from(record.chunks[3].bytes),Buffer.from(payload));
  }finally{await reader.close();await legacy.close();}
  const disk=new PosixStorage(root),forward=make(disk);
  try{await forward.recover();await forward.maintenance(2,Date.parse(at)+1000);const final=await disk.readFinal(ref);assert.ok(final);assert.equal(final.bytes,12800);
    await forward.finalizeSession(ref);assert.deepEqual(await disk.pendingFinals(),[]);assert.equal((await disk.list('session-finals')).length,1);
    assert.deepEqual(Buffer.from(await disk.read('objects',final.object_hash)),Buffer.concat([0,1,2,3].map(n=>Buffer.from(raw('pending-ended',n).payload))));
  }finally{await forward.close();await disk.close();}
  console.log(JSON.stringify({rel26:'8edc4bd4',gated_pending_ingress:'published_then_receipt_removed',unchanged_end_intent:true,forward_chunks:4,forward_finals:1}));
});
