import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {finalizeSession} from '../src/session-finalization.ts';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {AudioConsumption} from '../src/media/audio-consumption.ts';
import {canonical,digest,EVENT_SCHEMA,sha256,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import {type TrackChunk} from '../src/stream-archive.ts';
import type {FinalSession} from '../src/session-records.ts';
import {webdav} from './stream-materialized-fixture.ts';
const at='2026-10-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'consent',channel:'livekit',submission:'observation'};
const budget={max_chunk_bytes:3200,max_total_bytes:100000,max_chunks:64,max_revisions:64,max_seq:100};
const raw=(seq:number,event='session'):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:event,device_id:'glasses',device_type:'glasses',captured_at:at,
  source:{channel:'livekit'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,seq+1)});
const chunk=(seq:number):TrackChunk=>({track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',
  source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}});
const archive=(storage:PosixStorage)=>new RawArchive(storage,100000,()=>at,budget);
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'session-final-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('session final preserves journal raw_ref, old hashes, turn references and idempotent consumption across restart',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage),consumer=new AudioConsumption(storage,1048576);
  const saved=[];let consumed=0;
  for(let seq=0;seq<3;seq++){
    const a=await writer.streams.append(raw(seq),trusted,at,chunk(seq));saved.push(a);
    await consumer.select(a.event,'continuous');
    await consumer.chunk(a.event,chunk(seq),sha256(raw(seq).payload),async accept=>{await accept();consumed++;return {status:'queued',stream_key:'source'};});
  }
  const originals=new Map<string,Buffer>();
  for(const namespace of ['stream-revisions','audio-consumer-routes','audio-consumer-spans','audio-consumer-attempts','audio-consumer-accepted','audio-consumer-results'])
    for(const key of await storage.list(namespace))originals.set(`${namespace}/${key}`,Buffer.from(await storage.read(namespace,key)));
  // Call-turn rows written before online collection was removed keep referencing these revisions.
  const turnRoot=join(root,'turns');await fs.mkdir(turnRoot,{recursive:true,mode:0o700});
  const audio=saved.map(a=>({event:a.event,chunk:chunk(a.chunk.seq),sample_from:0,sample_to:1600}));
  await fs.writeFile(join(turnRoot,'legacy-turn.json'),JSON.stringify({schema:'paios.call-turn.v2',label:'finished',probability:0.8,sample_rate:16000,audio}),{mode:0o600});
  const final=await writer.finalizeSession(saved[2]!.event.raw_ref,'capture_stopped');
  assert.ok(final);
  assert.equal(final.objects.length,3);assert.equal(final.bytes,9600);
  assert.deepEqual(await fs.readdir(join(root,'objects')),[final.object_hash]);
  for(const namespace of ['stream-revisions','audio-consumer-attempts','audio-consumer-accepted','audio-consumer-results'])assert.deepEqual(await fs.readdir(join(root,namespace)),[]);
  assert.deepEqual(await storage.pendingFinals(),[]);
  await writer.close();await storage.close();
  const reopened=new PosixStorage(root),reader=archive(reopened);t.after(()=>reopened.close());
  for(const [path,bytes] of originals){const [namespace,key]=path.split('/');assert.deepEqual(Buffer.from(await reopened.read(namespace!,key!)),bytes);}
  // Journal links retain their originally pinned prefix, rather than expanding to the final head.
  for(const a of saved){const record=await reader.readRecord(a.event.raw_ref,'owner',a.event.archive_revision);
    assert.equal(record.kind,'stream');if(record.kind==='stream')assert.deepEqual(record.chunks.map(c=>Buffer.from(c.bytes)),saved.slice(0,a.chunk.seq+1).map(c=>Buffer.from(raw(c.chunk.seq).payload)));}
  const row=JSON.parse(await fs.readFile(join(turnRoot,(await fs.readdir(turnRoot))[0]!), 'utf8'));
  for(const ref of row.audio)assert.deepEqual(Buffer.from((await reader.readExactChunk(ref.event,ref.chunk,3200)).bytes),Buffer.from(raw(ref.chunk.seq).payload));
  const after=new AudioConsumption(reopened,1048576);
  for(const a of saved){const replay=await after.chunk(a.event,chunk(a.chunk.seq),sha256(raw(a.chunk.seq).payload),async()=>{consumed++;return {status:'queued',stream_key:'source'};});assert.equal(replay.status,'duplicate');}
  assert.equal(consumed,3);
  assert.deepEqual(await reader.streams.append(raw(1),trusted,at,chunk(1)),saved[1]);
  await assert.rejects(reader.streams.append(raw(3),trusted,at,chunk(3)),/STREAM_ALREADY_FINAL/);
  const live=await reader.streams.append(raw(0,'still-live'),trusted,at,chunk(0));
  assert.deepEqual(Buffer.from((await reader.readRecord(live.event.raw_ref,'owner',live.event.archive_revision) as {chunks:{bytes:Uint8Array}[]}).chunks[0]!.bytes),Buffer.from(raw(0).payload));
});

class CrashStorage extends PosixStorage {
  fault='';armed=false;unlinks=0;publishedFull=false;deleting=false;
  private fail(boundary:string){if(this.armed&&this.fault===boundary){this.armed=false;throw new Error(`CRASH:${boundary}`);}}
  override async publish(namespace:string,key:string,bytes:Uint8Array){
    if(namespace==='session-ends')this.fail('before_end');if(namespace==='objects')this.fail('before_object');
    const saved=await super.publish(namespace,key,bytes);
    if(namespace==='objects'&&bytes.length===9600)this.publishedFull=true;
    if(namespace==='session-ends')this.fail('after_end');if(namespace==='objects')this.fail('after_object');return saved;
  }
  override async publishObjectStream(chunks:AsyncIterable<Uint8Array>,beforePublish?:(key:string)=>Promise<void>){
    this.fail('before_object');const saved=await super.publishObjectStream(chunks,beforePublish);this.publishedFull=true;
    this.fail('after_object');return saved;
  }
  override async *readObjectRange(key:string,offset:number,bytes:number):AsyncGenerator<Uint8Array>{
    for await(const block of super.readObjectRange(key,offset,bytes)){
      if(this.armed&&this.publishedFull&&this.fault==='readback'){this.armed=false;yield Buffer.alloc(block.length);}
      else yield block;
    }
  }
  override async read(namespace:string,key:string){const saved=await super.read(namespace,key);
    if(this.armed&&this.publishedFull&&this.fault==='readback'&&namespace==='objects'&&saved.length===9600){this.armed=false;return Buffer.alloc(saved.length);}
    return saved;
  }
  override async publishFinal(record:FinalSession){this.fail('before_fold');const result=await super.publishFinal(record);this.fail('after_fold');return result;}
  override async removeOriginals(records:{namespace:string;key:string}[]){
    this.deleting=true;
    for(const record of records){this.fail(`before_unlink_${this.unlinks}`);await super.removeOriginals([record]);this.fail(`after_unlink_${this.unlinks++}`);}
  }
  override async syncDirectory(directory:string){
    if(this.deleting)this.fail('before_directory_flush');await super.syncDirectory(directory);
    if(this.deleting)this.fail('after_directory_flush');
  }
  override async completeFinal(ref:string){this.fail('before_clean');await super.completeFinal(ref);this.fail('after_clean');}
}
for(const boundary of ['before_end','after_end','before_object','after_object','readback','before_fold','after_fold','before_unlink_0','after_unlink_0','after_unlink_3','after_unlink_7','before_directory_flush','after_directory_flush','before_clean','after_clean'])
  test(`session final restart boundary: ${boundary}`,async t=>{
    const root=await fixture(t),storage=new CrashStorage(root),writer=archive(storage),saved=[];
    for(let seq=0;seq<3;seq++)saved.push(await writer.streams.append(raw(seq),trusted,at,chunk(seq)));
    const ref=saved[2]!.event.raw_ref;storage.fault=boundary;storage.armed=true;
    await assert.rejects(writer.finalizeSession(ref,'source_stopped'),boundary==='readback'?/SESSION_FINAL_READBACK_FAILED/:/CRASH:/);
    await writer.close();await storage.close();
    const disk=new PosixStorage(root),restarted=archive(disk);t.after(()=>disk.close());
    await restarted.recover();assert.equal(await disk.readFinal(ref)!==null,boundary.startsWith('after_fold')||['before_unlink_0','after_unlink_0','after_unlink_3','after_unlink_7','before_directory_flush','after_directory_flush','before_clean','after_clean'].includes(boundary));
    await restarted.maintenance(2,Date.parse(at)+1000);
    // A crash before publishing the end fact intentionally leaves an ambiguous live stream untouched.
    if(boundary==='before_end')assert.equal(await disk.readFinal(ref),null);
    else assert.ok(await disk.readFinal(ref));
    for(const a of saved)assert.deepEqual(Buffer.from((await restarted.readExactChunk(a.event,chunk(a.chunk.seq),3200)).bytes),Buffer.from(raw(a.chunk.seq).payload));
    await restarted.finalizeSession(ref,'source_stopped');
    const final=(await disk.readFinal(ref))!;
    assert.deepEqual(await fs.readdir(join(root,'objects')),[final.object_hash]);
    assert.deepEqual(await fs.readdir(join(root,'stream-revisions')),[]);
    assert.deepEqual(await disk.pendingFinals(),[]);
  });

test('repeated identical chunks have one hash route and still preserve their complete ordered duration',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);t.after(()=>storage.close());
  for(let seq=0;seq<3;seq++)await writer.streams.append(raw(0),trusted,at,chunk(seq));
  const ref=`l5:${digest({event_id:'session',principal_id:'owner',device_id:'glasses'})}`,final=await writer.finalizeSession(ref);
  assert.ok(final);
  assert.equal(final.objects.length,1);assert.deepEqual(Buffer.from(await storage.read('objects',final.object_hash)),Buffer.alloc(9600,1));
  const header=await writer.locate(ref,'owner');assert.equal(header.bytes,9600);
  assert.equal((await writer.readRecord(ref,'owner',header.archive_revision) as {chunks:unknown[]}).chunks.length,3);
});

for(const previous of [false,true])test(`ended source recovers detached admitted originals with ${previous?'an earlier published batch':'no published snapshot'}`,async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);
  if(previous)await writer.streams.append(raw(0),trusted,at,chunk(0));
  for(let seq=previous?1:0;seq<3;seq++){
    const {payload,...metadata}=raw(seq),object_hash=sha256(payload);
    const input={schema:'paios.raw-ingress.v1',record:{kind:'stream',raw:metadata,trusted,chunk:chunk(seq),received_at:at},object_hash,bytes:payload.length};
    const encoded=Buffer.from(canonical(input));await storage.publish('objects',object_hash,payload);await storage.publish('raw-ingress',sha256(encoded),encoded);
  }
  const ref=`l5:${digest({event_id:'session',principal_id:'owner',device_id:'glasses'})}`;
  assert.equal(await writer.finalizeSession(ref,'source_closed'),null);
  await assert.rejects(writer.streams.append(raw(4),trusted,at,chunk(4)),/STREAM_ALREADY_FINAL/);
  await writer.close();await storage.close();
  const disk=new PosixStorage(root),restarted=archive(disk);t.after(async()=>{await restarted.close();await disk.close();});
  await restarted.recover();
  for(let n=0;n<1000;n++){
    await restarted.maintenance(2,Date.parse(at)+1000);
    if(await disk.readFinal(ref)&&(await disk.pendingFinals()).length===0)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  const final=await disk.readFinal(ref);assert.ok(final);assert.equal(final.ended_by,'source_closed');assert.equal(final.bytes,9600);
  assert.deepEqual(await disk.list('raw-ingress'),[]);assert.deepEqual(await fs.readdir(join(root,'objects')),[final.object_hash]);
  assert.deepEqual(Buffer.from(await disk.read('objects',final.object_hash)),Buffer.concat([0,1,2].map(seq=>Buffer.from(raw(seq).payload))));
  await restarted.close();
});

test('cold eligibility excludes live journals and chunk proofs; finalized prefix reads survive hot eviction',async t=>{
  const root=await fixture(t),remote=await webdav(t,root),storage=new PosixStorage(join(root,'hot'),{cold:remote.config}),writer=archive(storage);
  const saved=[];for(let seq=0;seq<3;seq++)saved.push(await writer.streams.append(raw(seq),trusted,at,chunk(seq)));
  const live=await writer.streams.append(raw(9,'open-source'),trusted,at,chunk(0));
  assert.equal((await writer.moveCold()).segments,0);
  const final=await writer.finalizeSession(saved[2]!.event.raw_ref);assert.ok(final);
  const transferred:{namespace:string;key:string}[]=[],move=storage.moveCold.bind(storage);
  storage.moveCold=records=>{transferred.push(...records.map(({namespace,key})=>({namespace,key})));return move(records);};
  await writer.moveCold(2,Date.now()+5*86400000);
  assert.deepEqual(transferred.map(r=>r.namespace).sort(),['objects','session-finals']);
  assert.equal(await storage.cold!.contains('objects',live.chunk.object_hash),false);
  assert.deepEqual(Buffer.from(await storage.readHot('objects',live.chunk.object_hash)),Buffer.from(raw(9).payload));
  await assert.rejects(storage.readHot('objects',final.object_hash),{code:'ENOENT'});
  await writer.close();await storage.close();
  const disk=new PosixStorage(join(root,'hot'),{cold:remote.config}),reader=archive(disk);t.after(()=>disk.close());
  for(const a of saved)assert.deepEqual(Buffer.from((await reader.readExactChunk(a.event,chunk(a.chunk.seq),3200)).bytes),Buffer.from(raw(a.chunk.seq).payload));
  assert.deepEqual(Buffer.from((await reader.readExactChunk(live.event,chunk(0),3200)).bytes),Buffer.from(raw(9).payload));
});

test('archive close joins the end-intent scan before retiring recovery and cannot reopen a closed owner',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
  t.after(()=>storage.close());const list=storage.listHot.bind(storage);let held=false;
  storage.listHot=async(namespace,limit)=>{if(namespace==='session-ends'&&!held){held=true;entered.resolve();await gate.promise;}return list(namespace,limit);};
  const recovering=writer.recover();await entered.promise;
  let retired=false;const closing=writer.close().then(()=>{retired=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(retired,false);gate.resolve();await recovering;await closing;
  await assert.rejects(writer.recover(),/RAW_ARCHIVE_CLOSED/);
});

test('an already-open raw chunk remains readable when finalization unlinks its name before stat',{timeout:10000},async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage),saved=[];
  t.after(async()=>{await writer.close();await storage.close();});
  for(let seq=0;seq<3;seq++)saved.push(await writer.streams.append(raw(seq),trusted,at,chunk(seq)));
  const key=saved[0]!.chunk.object_hash,target=join(await fs.realpath(root),'objects',key),open=fs.open;
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held=false,links:number|undefined;
  fs.open=async(...args)=>{
    const handle=await open(...args);
    if(args[0]===target&&!held){held=true;const stat=handle.stat.bind(handle);
      handle.stat=(async()=>{entered.resolve();await release.promise;const result=await stat();links=result.nlink;return result;}) as typeof handle.stat;}
    return handle;
  };
  try{
    const reading=storage.readHot('objects',key);await entered.promise;
    assert.ok(await writer.finalizeSession(saved[2]!.event.raw_ref,'capture_stopped'));
    await assert.rejects(fs.lstat(target),{code:'ENOENT'});
    release.resolve();assert.deepEqual(Buffer.from(await reading),Buffer.from(raw(0).payload));assert.equal(links,0);
    assert.deepEqual(Buffer.from(await storage.read('objects',key)),Buffer.from(raw(0).payload));
  }finally{release.resolve();fs.open=open;}
});

for(const namespace of ['audio-consumer-routes','objects'])
test(`publication survives session folding unlinking an open ${namespace} target before stat`,{timeout:10000},async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage),consumer=new AudioConsumption(storage,1048576);
  t.after(async()=>{await writer.close();await storage.close();});
  const saved=[];
  for(let seq=0;seq<3;seq++)saved.push(await writer.streams.append(raw(seq),trusted,at,chunk(seq)));
  const event=saved[0]!.event,route=await consumer.select(event,'continuous');
  const key=namespace==='objects'?saved[0]!.chunk.object_hash:digest([event.principal_id,event.device_id,event.raw_ref]);
  const target=join(await fs.realpath(root),namespace,key),open=fs.open;
  let held=false,links:number|undefined,folding:ReturnType<typeof writer.finalizeSession>|undefined;
  const folded=(final:Awaited<ReturnType<typeof writer.finalizeSession>>)=>{assert.ok(final);
    assert.ok(final.records.some(r=>r.namespace==='audio-consumer-routes'&&r.key===digest([event.principal_id,event.device_id,event.raw_ref])));};
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await open(...args);
    if(args[0]===target&&!held){held=true;const stat=handle.stat.bind(handle);
      handle.stat=(async()=>{
        // Route publication holds the original-write fence that folding also takes, so folding waits for it;
        // an unfenced object publication can still see folding unlink its open target.
        if(namespace==='objects'){folded(await writer.finalizeSession(event.raw_ref,'capture_stopped'));await assert.rejects(fs.lstat(target),{code:'ENOENT'});}
        else folding=writer.finalizeSession(event.raw_ref,'capture_stopped');
        const result=await stat();links=result.nlink;return result;
      }) as typeof handle.stat;
    }
    return handle;
  });
  if(namespace==='objects'){
    assert.deepEqual(Buffer.from(await storage.publish(namespace,key,raw(0).payload)),Buffer.from(raw(0).payload));assert.equal(links,0);
  }else{
    assert.deepEqual(await consumer.select(event,'continuous'),route);assert.equal(links,1);
    folded(await folding);
    assert.deepEqual(await consumer.select(event,'continuous'),route);
    assert.deepEqual(await storage.listHot(namespace),[],'the folded winner remains authoritative');
  }
  assert.deepEqual(await storage.pendingFinals(),[]);
  assert.deepEqual(Buffer.from(await storage.read('objects',saved[0]!.chunk.object_hash)),Buffer.from(raw(0).payload));
});

test('disabled folding retains source bytes and processing proofs across restart; reenabling folds once',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage),consumer=new AudioConsumption(storage,1048576);
  writer.setSessionFolding(false);
  const saved=[];
  for(let seq=0;seq<3;seq++){
    const a=await writer.streams.append(raw(seq),trusted,at,chunk(seq));saved.push(a);
    await consumer.select(a.event,'continuous');
    await consumer.chunk(a.event,chunk(seq),sha256(raw(seq).payload),async accept=>{await accept();return {status:'queued',stream_key:'source'};});
  }
  const retained=new Map<string,Buffer>();
  for(const namespace of ['objects','stream-revisions','audio-consumer-routes','audio-consumer-spans','audio-consumer-attempts','audio-consumer-accepted','audio-consumer-results'])
    for(const key of await storage.list(namespace))retained.set(`${namespace}/${key}`,Buffer.from(await storage.read(namespace,key)));
  const ref=saved[2]!.event.raw_ref;
  assert.equal(await writer.finalizeSession(ref,'capture_stopped'),null);
  const end=JSON.parse(Buffer.from(await storage.read('session-ends',ref.slice(3))).toString());
  assert.equal(end.ended_by,'capture_stopped');assert.equal(await storage.readFinal(ref),null);
  await assert.rejects(writer.streams.append(raw(3),trusted,at,chunk(3)),/STREAM_ALREADY_FINAL/);
  await writer.close();await storage.close();
  const disk=new PosixStorage(root),restarted=archive(disk);restarted.setSessionFolding(false);
  await restarted.recover();assert.equal(await disk.readFinal(ref),null);
  for(const [path,bytes] of retained)assert.deepEqual(await fs.readFile(join(root,path)),bytes);
  await restarted.close();await disk.close();
  const enabledDisk=new PosixStorage(root),enabled=archive(enabledDisk);await enabled.recover();await enabled.maintenance(2,Date.parse(at)+1000);
  const final=await enabledDisk.readFinal(ref);assert.ok(final);
  await enabled.recover();assert.deepEqual(await enabled.finalizeSession(ref),final);
  assert.deepEqual(await enabledDisk.list('session-finals'),[ref.slice(3)]);
  assert.deepEqual(await enabledDisk.pendingFinals(),[]);
  assert.deepEqual(await fs.readdir(join(root,'objects')),[final.object_hash]);
  await enabled.close();await enabledDisk.close();
});

test('disabled folding does not resume cleanup of an already committed final',async t=>{
  const root=await fixture(t),storage=new CrashStorage(root),writer=archive(storage);let ref='';
  for(let seq=0;seq<3;seq++)ref=(await writer.streams.append(raw(seq),trusted,at,chunk(seq))).event.raw_ref;
  storage.fault='after_fold';storage.armed=true;
  await assert.rejects(writer.finalizeSession(ref,'capture_stopped'),/CRASH:after_fold/);
  const originals=await fs.readdir(join(root,'objects')),revisions=await fs.readdir(join(root,'stream-revisions'));
  await writer.close();await storage.close();
  const disk=new PosixStorage(root),disabled=archive(disk);disabled.setSessionFolding(false);
  await disabled.recover();assert.deepEqual(await disk.pendingFinals(),[ref]);
  assert.deepEqual(await fs.readdir(join(root,'objects')),originals);
  assert.deepEqual(await fs.readdir(join(root,'stream-revisions')),revisions);
  await disabled.close();await disk.close();
  const enabledDisk=new PosixStorage(root),enabled=archive(enabledDisk);await enabled.recover();await enabled.maintenance(2,Date.parse(at)+1000);
  assert.deepEqual(await enabledDisk.pendingFinals(),[]);
  assert.deepEqual(await fs.readdir(join(root,'objects')),[(await enabledDisk.readFinal(ref))!.object_hash]);
  await enabled.close();await enabledDisk.close();
});

for(const interruption of ['capture','delete'] as const)test(`fold payload read yields the original-write fence to ${interruption}`,{timeout:10000},async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);
  t.after(async()=>{await writer.close();await storage.close();});
  await writer.prepareCapture();
  const first=await writer.streams.append(raw(0),trusted,at,chunk(0));
  await writer.streams.append(raw(1),trusted,at,chunk(1));
  let entered!:()=>void,release!:()=>void;
  const reading=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const read=storage.read.bind(storage);let held=false;
  storage.read=async(namespace,key)=>{
    if(interruption==='capture'&&!held&&namespace==='objects'&&key===first.chunk.object_hash){held=true;entered();await gate;}
    return read(namespace,key);
  };
  const callTrack=storage.callTrack.bind(storage);
  if(interruption==='delete')storage.callTrack=async ref=>{const track=await callTrack(ref);if(!held){held=true;entered();await gate;}return track;};
  const folding=writer.finalizeSession(first.event.raw_ref);
  const outcome=folding.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  let interrupted:Promise<unknown>|undefined;
  await reading;
  try{
    if(interruption==='capture'){
      // Both producers reuse an old payload. Cleanup must preserve their new live ownership.
      const admissions=Promise.all(['new-call','ambient'].map(event=>writer.admitStream(raw(0,event),trusted,chunk(0))));
      interrupted=admissions.then(receipts=>Promise.all(receipts.map(receipt=>receipt.commit)));
      const receipts=await Promise.race([
        admissions,
        new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('CAPTURE_BLOCKED_BY_FOLD_READ')),1000);timer.unref();})
      ]);
      await Promise.all(receipts.map(receipt=>receipt.commit));
      assert.equal(await storage.readFinal(first.event.raw_ref),null);
    }else{
      const remover=archive(storage);
      interrupted=remover.delete(first.event.raw_ref,'owner');
      await Promise.race([interrupted,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('DELETE_BLOCKED_BY_FOLD_READ')),1000);timer.unref();})]);
      await remover.close();
    }
  }finally{release();await Promise.allSettled([outcome,interrupted]);}
  if(interruption==='delete'){assert.match((await outcome).error.message,/RAW_DELETED/);assert.equal(await storage.readFinal(first.event.raw_ref),null);}
  else{
    assert.ok(await folding);
    assert.deepEqual(Buffer.from(await storage.read('objects',first.chunk.object_hash)),Buffer.from(raw(0).payload));
  }
});

test('fold cleanup preserves a newly admitted shared payload before its publication',{timeout:10000},async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);
  let releaseRead!:()=>void,releasePublish!:()=>void,entered!:()=>void;
  const reading=new Promise<void>(resolve=>{entered=resolve;}),readGate=new Promise<void>(resolve=>{releaseRead=resolve;}),publishGate=new Promise<void>(resolve=>{releasePublish=resolve;});
  t.after(async()=>{releaseRead();releasePublish();await writer.close();await storage.close();});
  await writer.prepareCapture();
  const first=await writer.streams.append(raw(0),trusted,at,chunk(0));
  await writer.streams.append(raw(1),trusted,at,chunk(1));
  const read=storage.read.bind(storage);let held=false;
  storage.read=async(namespace,key)=>{if(!held&&namespace==='objects'&&key===first.chunk.object_hash){held=true;entered();await readGate;}return read(namespace,key);};
  const append=writer.streams.append.bind(writer.streams);
  writer.streams.append=async(...args)=>{if(args[0].event_id==='new-call')await publishGate;return append(...args);};
  const folding=writer.finalizeSession(first.event.raw_ref);await reading;
  const next=await writer.admitStream(raw(0,'new-call'),trusted,chunk(0));
  releaseRead();assert.ok(await folding);
  assert.deepEqual(await storage.list('raw-ingress'),[next.key]);
  assert.deepEqual(Buffer.from(await storage.read('objects',first.chunk.object_hash)),Buffer.from(raw(0).payload));
  releasePublish();assert.equal((await next.commit).event.bytes,3200);
});

// Regression: folding must never materialize the session audio in one read.
test('fold streams audio and readback without loading the whole session',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);
  t.after(async()=>{await writer.close();await storage.close();});
  let ref='';for(let seq=0;seq<3;seq++)ref=(await writer.streams.append(raw(seq),trusted,at,chunk(seq))).event.raw_ref;
  const original=writer.streams.readRecord.bind(writer.streams);
  writer.streams.readRecord=async(...args)=>{assert.equal(args[3]?.proof_only,true,'fold must select proofs without payloads');return original(...args);};
  const read=storage.read.bind(storage);storage.read=async(namespace,key)=>{
    const bytes=await read(namespace,key);assert.ok(namespace!=='objects'||bytes.length<=3200,'whole folded audio read');return bytes;};
  const final=await writer.finalizeSession(ref);assert.ok(final);assert.equal(final.bytes,9600);
});


test('streamed object publication and verification exceed the old64MiB payload bound',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root);t.after(()=>storage.close());
  const expected=createHash('sha256');
  async function* payload(){for(let n=0;n<72;n++){const bytes=Buffer.alloc(1024*1024,n);expected.update(bytes);yield bytes;}}
  const saved=await storage.publishObjectStream(payload());assert.equal(saved.bytes,72*1024*1024);
  assert.equal(saved.object_hash,expected.digest('hex'));
  const verified=createHash('sha256');let bytes=0;
  for await(const block of storage.readObjectRange(saved.object_hash,0,saved.bytes)){
    assert.ok(block.length<=65536);verified.update(block);bytes+=block.length;
  }
  assert.equal(bytes,saved.bytes);assert.equal(verified.digest('hex'),saved.object_hash);
});

test('interruption between streamed chunks preserves originals and permits recovery',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);t.after(async()=>{await writer.close();await storage.close();});
  let ref='';for(let seq=0;seq<3;seq++)ref=(await writer.streams.append(raw(seq),trusted,at,chunk(seq))).event.raw_ref;
  const before=await fs.readdir(join(root,'objects'));let checkpoints=0;
  await assert.rejects(finalizeSession(storage,writer.streams,ref,'capture_stopped',true,{checkpoint:async()=>{
    if(++checkpoints===2)throw new Error('INTERRUPTED');
  }}),/INTERRUPTED/);
  assert.equal(await storage.readFinal(ref),null);assert.deepEqual(await fs.readdir(join(root,'objects')),before);
  assert.ok(await writer.finalizeSession(ref));assert.deepEqual(await storage.pendingFinals(),[]);
});

test('fold verifies every replacement chunk range before publishing metadata or unlinking originals',async t=>{
  const root=await fixture(t),storage=new PosixStorage(root),writer=archive(storage);t.after(async()=>{await writer.close();await storage.close();});
  let ref='';for(let seq=0;seq<3;seq++)ref=(await writer.streams.append(raw(seq),trusted,at,chunk(seq))).event.raw_ref;
  const originals=await fs.readdir(join(root,'objects')),readRange=storage.readObjectRange.bind(storage);
  storage.readObjectRange=async function*(key,offset,bytes){for await(const block of readRange(key,offset,bytes))yield offset===3200?Buffer.alloc(block.length):block;};
  await assert.rejects(writer.finalizeSession(ref),/SESSION_FINAL_RANGE_FAILED/);
  assert.equal(await storage.readFinal(ref),null);
  for(const key of originals)assert.ok((await fs.readdir(join(root,'objects'))).includes(key));
});

test('eight-hour session retains all115MB audio and cold-uploads bounded old-reader-compatible objects',async t=>{
  const root=await fixture(t),remote=await webdav(t,root),storage=new PosixStorage(join(root,'hot'),{cold:remote.config});
  const chunkBytes=1600000,count=72,total=chunkBytes*count;
  const writer=new RawArchive(storage,chunkBytes,()=>at,{max_chunk_bytes:chunkBytes,max_total_bytes:total,max_chunks:count,max_revisions:count,max_seq:count});
  t.after(async()=>{await writer.close();await storage.close();});
  const saved=[];
  for(let seq=0;seq<count;seq++){
    const input={...raw(seq,'eight-hour'),payload:Buffer.alloc(chunkBytes,seq+1)};
    const descriptor={...chunk(seq),format:'pcm_s16le:2000:1',source_range:{...chunk(seq).source_range,start_ms:seq*400000,end_ms:(seq+1)*400000}};
    saved.push(await writer.streams.append(input,trusted,at,descriptor));
  }
  assert.equal(count*400000,8*60*60*1000);
  for(const receipt of saved)assert.equal((await writer.readExactChunk(receipt.event,receipt.chunk,chunkBytes)).bytes.length,chunkBytes);
  const final=await finalizeSession(storage,writer.streams,saved.at(-1)!.event.raw_ref,'capture_stopped');assert.ok(final);
  assert.equal(final.bytes,8000000);assert.equal(final.objects.length,5);assert.equal(final.retained_objects!.length,67);
  assert.equal(final.bytes+final.retained_objects!.length*chunkBytes,total);
  const now=Date.now()+86400000+1000;
  for(let tick=0;tick<24;tick++)if((await writer.moveCold(2,now)).segments===0)break;
  for(const key of [final.object_hash,...final.retained_objects!.map(object=>object.key)])assert.ok(await storage.cold!.contains('objects',key));
  for(let tick=0;tick<4;tick++)await writer.moveCold(2,now+2*86400000);
  for(let seq=0;seq<count;seq++){
    const receipt=saved[seq]!,read=await writer.readExactChunk(receipt.event,receipt.chunk,chunkBytes);
    assert.equal(read.bytes.length,chunkBytes);assert.equal(sha256(read.bytes),receipt.chunk.object_hash);
  }
});

test('journal proofs beyond the bounded fold remain owned and enter cold storage',async t=>{
  const root=await fixture(t),remote=await webdav(t,root),storage=new PosixStorage(join(root,'hot'),{cold:remote.config}),count=3000;
  const writer=new RawArchive(storage,3200,()=>at,{max_chunk_bytes:3200,max_total_bytes:count*3200,max_chunks:count,max_revisions:count,max_seq:count});
  t.after(async()=>{await writer.close();await storage.close();});
  let ref='';
  for(let seq=0;seq<count;seq++)ref=(await writer.streams.append(raw(seq,'journal-overflow'),trusted,at,chunk(seq))).event.raw_ref;
  const head=(await writer.streams.head(ref))!,final=await finalizeSession(storage,writer.streams,ref,'source_exhausted');assert.ok(final);
  assert.ok(Buffer.byteLength(canonical(final))<12*1024*1024,'final metadata stays within old reader cache');
  const included=new Set(final.records.map(r=>`${r.namespace}:${r.key}`)),owned=new Set((await storage.sessionRecords(ref)).map(r=>`${r.namespace}:${r.key}`)),overflow:string[]=[];
  for(const journal of head.journal!)for(const key of [digest([ref,journal.revision]),digest(journal)])if(!included.has(`stream-revisions:${key}`)){
    overflow.push(key);assert.ok(owned.has(`stream-revisions:${key}`),'overflow journal has a session owner');
  }
  assert.ok(overflow.length>0,'fixture exceeds the metadata fold budget');
  for(let tick=0;tick<20&&!await storage.cold!.contains('stream-revisions',overflow.at(-1)!);tick++)await writer.moveCold(1,Date.now()+2*86400000);
  for(const key of overflow)assert.ok(await storage.cold!.contains('stream-revisions',key));
  assert.equal((await writer.streams.head(ref))!.revision,count);
});
