import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile as run} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const execFile=promisify(run);
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {canonical,sha256,EVENT_SCHEMA,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {planArchiveConversationReset,executeArchiveConversationReset,CONVERSATION_RESET_CUTOFF} from '../src/archive-conversation-reset.ts';
import {webdav} from './stream-materialized-fixture.ts';
const old='2026-10-18T10:00:00.000Z',trusted:TrustedContext={principal_id:'owner',device_id:'mac',device_type:'mac',channel:'test',consent_ref:'consent',submission:'observation'};
const raw=(id:string,media_type:RawEvent['media_type'],payload:Buffer,captured_at=old):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:id,device_id:'mac',device_type:'mac',captured_at,source:{channel:'test'},media_type,mime:media_type==='text'?'text/plain':'application/json',representation:'uploaded_original',payload});
const budget={max_chunk_bytes:4000,max_total_bytes:20000,max_chunks:100,max_revisions:100,max_seq:100};
async function fixture(t:test.TestContext,cold=false){const root=await fs.mkdtemp(join(tmpdir(),'conversation-reset-')),dav=cold?await webdav(t,root):null;
  const storage=new PosixStorage(join(root,'hot'),dav?{cold:dav.config}:{}),archive=new RawArchive(storage,20000,()=>old,budget);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});return {root,storage,archive,dav};}
test('mixed shared cold pack resets only old conversations, preserves source readers and repeats safely',async t=>{
  const {storage,archive,dav}=await fixture(t,true),shared=Buffer.from('shared');
  const deleted=await archive.archive(raw('old','text',shared),trusted);
  const newer=new RawArchive(storage,20000,()=>CONVERSATION_RESET_CUTOFF);t.after(()=>newer.close());
  const kept=await newer.archive(raw('new','text',shared,CONVERSATION_RESET_CUTOFF),trusted);
  const file=await archive.archive(raw('file','file',Buffer.from('document')),trusted);
  const voice=await archive.archive(raw('voice','app_event',Buffer.from(JSON.stringify({kind:'voice_turn',user:'hello',assistant:'hi'}))),trusted);
  const approval=await archive.archive(raw('approval','app_event',Buffer.from(JSON.stringify({kind:'owner_confirmation',request_text:'keep'}))),trusted);
  const records=[];for(const namespace of ['manifests','objects'])for(const key of await storage.list(namespace))records.push({namespace,key,bytes:await storage.read(namespace,key)});
  await storage.moveCold(records);await storage.removeOriginals(records);
  const objectReads:string[]=[],read=storage.read.bind(storage);storage.read=async(namespace,key)=>{if(namespace==='objects')objectReads.push(key);return read(namespace,key);};
  const plan=await planArchiveConversationReset(storage);storage.read=read;
  assert.deepEqual(new Set(objectReads),new Set([voice.payload_sha256,approval.payload_sha256]));assert.deepEqual(new Set(plan.targets.map(t=>t.raw_ref)),new Set([deleted.raw_ref,voice.raw_ref]));
  await archive.retainBackupDependencies('a'.repeat(64));
  const originalPacks=await fs.readdir(dav!.directory);
  await executeArchiveConversationReset(archive,plan);await executeArchiveConversationReset(archive,plan);
  for(const event of [kept,file,approval])assert.equal((await archive.readRecord(event.raw_ref,'owner',event.archive_revision)).event.event_id,event.event_id);
  await assert.rejects(archive.readRecord(deleted.raw_ref,'owner',deleted.archive_revision),/RAW_DELETED/);
  assert.equal((await planArchiveConversationReset(storage)).targets.length,0);
  for(const pack of originalPacks)assert.ok((await fs.readdir(dav!.directory)).includes(pack));
});
test('folded sessions physically disappear while kept folded sessions survive restart',async t=>{
  const {storage,archive}=await fixture(t);
  const add=async(id:string,at:string)=>{let event;
    for(let seq=0;seq<2;seq++)event=(await archive.streams.append({...raw(id,'audio',Buffer.alloc(200,seq+1),at),mime:'audio/pcm'},trusted,at,
      {track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}})).event;
    await archive.finalizeSession(event!.raw_ref,'capture_stopped');return event!;};
  const before=await add('before',old),after=await add('after',CONVERSATION_RESET_CUTOFF);
  const plan=await planArchiveConversationReset(storage);assert.equal(plan.targets.length,1);
  await executeArchiveConversationReset(archive,plan);await executeArchiveConversationReset(archive,plan);
  assert.equal(await storage.readFinal(before.raw_ref),null);assert.ok(await storage.readFinal(after.raw_ref));
  assert.equal((await archive.readRecord(after.raw_ref,'owner',after.archive_revision)).total_bytes,400);
  const readOnly=new PosixStorage(storage.root,{read_only:true});try{assert.equal((await planArchiveConversationReset(readOnly)).targets.length,0);}finally{await readOnly.close();}
});
test('cutoff crossing source blocks execute and keeps immutable journal intact',async t=>{
  const {storage,archive}=await fixture(t);let event;
  for(let seq=0;seq<2;seq++)event=(await archive.streams.append({...raw('cross','audio',Buffer.alloc(200,seq+1)),mime:'audio/pcm'},trusted,seq?CONVERSATION_RESET_CUTOFF:old,
    {track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}})).event;
  const plan=await planArchiveConversationReset(storage);assert.deepEqual(plan.crossing_sources,[event!.raw_ref]);
  await assert.rejects(executeArchiveConversationReset(archive,plan),/RESET_CROSSING/);
});

test('read-only empty inventory creates no directories or indexes',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-preview-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(join(root,'absent'),{read_only:true,cold:{url:'http://127.0.0.1:1',username:'unused',password_file:join(root,'absent-secret')}});
  try{assert.equal((await planArchiveConversationReset(storage)).targets.length,0);assert.deepEqual(await fs.readdir(root),[]);}finally{await storage.close();}
});

test('e248d09a production storage reader resolves retained folded and original records after reset',async t=>{
  const {root,storage,archive}=await fixture(t),readerRoot=join(root,'reader');await fs.mkdir(readerRoot);
  const newer=new RawArchive(storage,20000,()=>CONVERSATION_RESET_CUTOFF,budget);t.after(()=>newer.close());
  const original=await newer.archive(raw('original-kept','text',Buffer.from('new retained text'),CONVERSATION_RESET_CUTOFF),trusted);
  await archive.archive(raw('remove-me','text',Buffer.from('old text')),trusted);
  let event;for(let seq=0;seq<2;seq++)event=(await newer.streams.append({...raw('fold-kept','audio',Buffer.alloc(200,seq+1),CONVERSATION_RESET_CUTOFF),mime:'audio/pcm'},trusted,CONVERSATION_RESET_CUTOFF,
    {track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}})).event;
  const final=await newer.finalizeSession(event!.raw_ref,'capture_stopped');assert.ok(final);
  await executeArchiveConversationReset(archive,await planArchiveConversationReset(storage));
  const refs=[{namespace:'manifests',key:original.raw_ref.slice(3)},{namespace:'objects',key:original.payload_sha256},
    ...final.records.map(({namespace,key})=>({namespace,key})),...final.objects.map(({key})=>({namespace:'objects',key}))];
  const expected=[];for(const ref of refs)expected.push(Buffer.from(await storage.read(ref.namespace,ref.key)).toString('base64'));
  await archive.close();await newer.close();await storage.close();
  for(const file of ['storage.ts','session-records.ts','cold-storage.ts','contracts.ts']){
    const result=await execFile('git',['show',`e248d09a:01-product-half-finished/backend/services/personal-aios-integration/src/${file}`],{maxBuffer:1024*1024});
    await fs.writeFile(join(readerRoot,file),result.stdout);
  }
  const script=`const {PosixStorage}=await import(${JSON.stringify(pathToFileURL(join(readerRoot,'storage.ts')).href)});const storage=new PosixStorage(${JSON.stringify(storage.root)});const result=[];try{for(const ref of ${JSON.stringify(refs)})result.push(Buffer.from(await storage.read(ref.namespace,ref.key)).toString('base64'));console.log(JSON.stringify(result));}finally{await storage.close();}`;
  const result=await execFile(process.execPath,['--input-type=module','-e',script],{maxBuffer:1024*1024});assert.deepEqual(JSON.parse(result.stdout),expected);
});

test('unknown device capture clocks use durable admission time and preserve cutoff admissions',async t=>{
  const {storage,archive}=await fixture(t),newer=new RawArchive(storage,20000,()=>CONVERSATION_RESET_CUTOFF,budget);t.after(()=>newer.close());
  const chunk={track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio' as const,format:'pcm_s16le:1000:1',source_range:{kind:'interval' as const,timebase_id:'local',stream_epoch:'epoch',start_ms:0,end_ms:100}};
  const unknown=(id:string)=>({...raw(id,'audio',Buffer.alloc(200,1)),captured_at:null,capture_clock_status:'unknown' as const,mime:'audio/pcm'});
  const prior=await archive.archiveUnknownClock(unknown('unknown-old'),trusted,chunk,{}),kept=await newer.archiveUnknownClock(unknown('unknown-new'),trusted,chunk,{});
  const plan=await planArchiveConversationReset(storage);assert.equal(plan.unknown_sources,0);assert.deepEqual(plan.targets.map(t=>t.raw_ref),[prior.quarantine_ref]);
  await executeArchiveConversationReset(archive,plan);await executeArchiveConversationReset(archive,plan);
  assert.equal((await newer.readUnknownClock(kept.quarantine_ref,'owner',kept.archive_revision)).bytes.length,200);
  await assert.rejects(archive.readUnknownClock(prior.quarantine_ref,'owner',prior.archive_revision),/RAW_DELETED/);
});

test('preview of closed WAL indexes leaves source files, metadata and bytes unchanged',async t=>{
  const {root,storage,archive}=await fixture(t,true);
  const source=await archive.streams.append({...raw('fold-preview','audio',Buffer.alloc(200,1)),mime:'audio/pcm'},trusted,old,
    {track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:0,end_ms:100}});
  await archive.finalizeSession(source.event.raw_ref,'capture_stopped');
  await storage.cold!.packs();await archive.close();await storage.close();
  const snapshot=async()=>{const entries:unknown[]=[];const walk=async(directory:string):Promise<void>=>{
    for(const name of (await fs.readdir(directory)).sort()){const path=join(directory,name),stat=await fs.lstat(path);
      entries.push([path.slice(root.length),stat.size,stat.mode,stat.mtimeMs,stat.isFile()?(await fs.readFile(path)).toString('base64'):null]);
      if(stat.isDirectory())await walk(path);
    }};await walk(storage.root);return entries;};
  assert.ok(!(await fs.readdir(storage.root)).some(name=>name.endsWith('-wal')||name.endsWith('-shm')));
  const before=await snapshot(),readOnly=new PosixStorage(storage.root,{read_only:true,cold:{url:'http://127.0.0.1:1',username:'unused',password_file:join(root,'unused')}});
  try{assert.equal((await planArchiveConversationReset(readOnly)).targets.length,1);assert.deepEqual(await snapshot(),before);}finally{await readOnly.close();}
  assert.deepEqual(await snapshot(),before);
});

test('fresh preview resumes durable deletion intents after original or folded metadata disappears',async t=>{
  for(const folded of [false,true]){
    const {storage,archive}=await fixture(t);let reference:string;
    if(folded){const saved=await archive.streams.append({...raw('crash-fold','audio',Buffer.alloc(200,1)),mime:'audio/pcm'},trusted,old,
      {track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:0,end_ms:100}});
      reference=saved.event.raw_ref;await archive.finalizeSession(reference,'capture_stopped');
    }else reference=(await archive.archive(raw('crash-original','text',Buffer.from('orphan-body')),trusted)).raw_ref;
    const plan=await planArchiveConversationReset(storage),remove=storage.removeOriginals.bind(storage);let armed=true;
    storage.removeOriginals=async records=>{for(const record of records){if(folded&&armed){armed=false;throw new Error('RESET_CRASH');}
      await remove([record]);if(!folded&&record.namespace==='manifests'&&armed){armed=false;throw new Error('RESET_CRASH');}}};
    await assert.rejects(executeArchiveConversationReset(archive,plan),/RESET_CRASH/);storage.removeOriginals=remove;
    const resumed=await planArchiveConversationReset(storage);assert.deepEqual(resumed.targets.map(t=>t.raw_ref),[reference]);assert.equal(resumed.pending_deletions,1);
    await executeArchiveConversationReset(archive,resumed);
    const finished=await planArchiveConversationReset(storage);assert.equal(finished.targets.length,0);assert.equal(finished.pending_deletions,0);assert.equal((await storage.list('objects')).length,0);
  }
});

test('legacy chunk-only deletion intent durably acquires folded container before index removal',async t=>{
  const {storage,archive}=await fixture(t);let event;
  for(let seq=0;seq<2;seq++)event=(await archive.streams.append({...raw('legacy-intent','audio',Buffer.alloc(200,seq+1)),mime:'audio/pcm'},trusted,old,
    {track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}})).event;
  const final=await archive.finalizeSession(event!.raw_ref,'capture_stopped');assert.ok(final);
  const legacy={principal_id:'owner',raw_ref:event!.raw_ref,objects:final.objects.map(o=>o.key)};
  await storage.publish('owner-deletions',event!.raw_ref.slice(3),Buffer.from(canonical(legacy)));
  const remove=storage.removeOriginals.bind(storage);storage.removeOriginals=async()=>{throw new Error('CRASH_AFTER_INDEX_DROP');};
  await assert.rejects(executeArchiveConversationReset(archive,await planArchiveConversationReset(storage)),/CRASH_AFTER_INDEX_DROP/);storage.removeOriginals=remove;
  assert.equal(await storage.readFinal(event!.raw_ref),null);
  const enriched=JSON.parse(Buffer.from(await storage.read('owner-deletions',event!.raw_ref.slice(3))).toString());
  assert.deepEqual(new Set(enriched.objects),new Set([...legacy.objects,final.object_hash]));
  const recovered=await planArchiveConversationReset(storage);assert.equal(recovered.pending_deletions,1);
  await executeArchiveConversationReset(archive,recovered);assert.equal((await storage.list('objects')).length,0);assert.equal((await planArchiveConversationReset(storage)).targets.length,0);
});

test('cold kept self-container never inherits a recursive folded alias from deleted slices',async t=>{
  const {storage,archive}=await fixture(t,true),newer=new RawArchive(storage,20000,()=>CONVERSATION_RESET_CUTOFF,budget);t.after(()=>newer.close());
  const audio=Buffer.alloc(200,1),other=Buffer.alloc(200,2);
  const append=async(writer:RawArchive,id:string,seq:number,payload:Buffer,at:string)=>(await writer.streams.append({...raw(id,'audio',payload,at),mime:'audio/pcm'},trusted,at,
    {track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:1000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}})).event;
  await append(archive,'old-two',0,audio,old);const before=await append(archive,'old-two',1,other,old);
  await archive.finalizeSession(before.raw_ref,'capture_stopped');
  const kept=await append(newer,'kept-one',0,audio,CONVERSATION_RESET_CUTOFF),hash=sha256(audio);
  // Identity mappings are accepted final metadata; publishFinal never installs them as folded routes.
  await storage.publishFinal({schema:'paios.session.final.v1',raw_ref:kept.raw_ref,object_hash:hash,bytes:audio.length,records:[],objects:[{key:hash,offset:0,bytes:audio.length}],ended_by:'capture_stopped'});
  const records=[];for(const key of await storage.listHot('objects'))records.push({namespace:'objects',key,bytes:await storage.read('objects',key)});
  await storage.moveCold(records);await storage.removeOriginals(records);
  await executeArchiveConversationReset(archive,await planArchiveConversationReset(storage));
  assert.deepEqual(Buffer.from(await storage.read('objects',hash)),audio);
  assert.deepEqual(Buffer.from((await newer.readRecord(kept.raw_ref,'owner',kept.archive_revision) as {chunks:{bytes:Uint8Array}[]}).chunks[0]!.bytes),audio);
});
