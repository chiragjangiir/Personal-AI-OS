import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {PosixStorage} from '../src/storage.ts';
import {canonical,digest,sha256} from '../src/contracts.ts';
import type {FinalSession} from '../src/session-records.ts';

async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'paios-session-records-')),storage=new PosixStorage(root);
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const chunks=[Buffer.from('first pcm block'),Buffer.from('second pcm block')],whole=Buffer.concat(chunks);
  const metadata=Buffer.from(canonical({schema:'journal',revision:2})),key=sha256(metadata),alias=digest({slot:1});
  const record:FinalSession={schema:'paios.session.final.v1',raw_ref:`l5:${digest({session:1})}`,object_hash:sha256(whole),bytes:whole.length,
    records:[{namespace:'stream-revisions',key,bytes:metadata.toString('base64')},{namespace:'stream-revisions',key:alias,bytes:metadata.toString('base64')}],
    objects:chunks.map((chunk,i)=>({key:sha256(chunk),offset:i?chunks[0]!.length:0,bytes:chunk.length})),ended_by:'explicit_stop'};
  return {root,storage,chunks,whole,metadata,key,alias,record};
}

test('one compressed final resolves metadata aliases and raw slices after every old file is removed',async t=>{
  const f=await fixture(t);await f.storage.publish('objects',f.record.object_hash,f.whole);
  await f.storage.publishAliased('stream-revisions',f.key,f.alias,f.metadata);
  for(const chunk of f.chunks)await f.storage.publish('objects',sha256(chunk),chunk);
  await f.storage.publishFinal(f.record);
  await f.storage.removeOriginals([...f.record.records,...f.record.objects.map(object=>({namespace:'objects',key:object.key}))]);
  assert.deepEqual(await f.storage.read('stream-revisions',f.alias),f.metadata);
  for(const chunk of f.chunks)assert.deepEqual(await f.storage.read('objects',sha256(chunk)),chunk);
  assert.deepEqual(await f.storage.list('stream-revisions'),[f.key,f.alias].sort());
  assert.deepEqual(await f.storage.listHot('stream-revisions'),[]);
  const id=f.record.raw_ref.slice(3),finalBytes=Buffer.from(canonical(f.record));
  assert.deepEqual(await f.storage.listHot('session-finals'),[id]);
  assert.deepEqual(await f.storage.read('session-finals',id),finalBytes);
  assert.equal(await f.storage.hotSize('session-finals',id),finalBytes.length);
  assert.ok(await f.storage.modifiedAt('session-finals',id)>0);
  assert.deepEqual(await fs.readdir(join(f.root,'session-finals')),[]);
  assert.deepEqual(await fs.readdir(join(f.root,'objects')),[f.record.object_hash]);
  const db=new DatabaseSync(join(f.root,'session-records.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refs').get()!.n,4);
  assert.equal(db.prepare('PRAGMA table_info(refs)').all().some(row=>row.name==='record'),false);db.close();
});

test('metadata replays keep folded winners; new single and batch raw publications materialize hot bytes',async t=>{
  const f=await fixture(t);await f.storage.publish('objects',f.record.object_hash,f.whole);await f.storage.publishFinal(f.record);
  assert.deepEqual(await f.storage.publish('stream-revisions',f.key,Buffer.from('different')),f.metadata);
  assert.deepEqual(await f.storage.publishAliased('stream-revisions',f.key,f.alias,f.metadata),f.metadata);
  assert.deepEqual((await f.storage.stageAlias('stream-revisions',f.key,f.alias)).winner,f.metadata);
  await f.storage.publishMany('stream-revisions',[{key:f.key,bytes:f.metadata}]);
  assert.deepEqual(await f.storage.listHot('stream-revisions'),[]);
  assert.deepEqual(await fs.readdir(join(f.root,'objects')),[f.record.object_hash]);
  assert.deepEqual(await f.storage.publish('objects',sha256(f.chunks[0]!),f.chunks[0]!),f.chunks[0]);
  await f.storage.publishMany('objects',[{key:sha256(f.chunks[1]!),bytes:f.chunks[1]!}]);
  for(const chunk of f.chunks)assert.deepEqual(await f.storage.readHot('objects',sha256(chunk)),chunk);
  assert.deepEqual((await fs.readdir(join(f.root,'objects'))).sort(),[f.record.object_hash,...f.chunks.map(sha256)].sort());
});

test('ownership and incomplete cleanup survive restart; final conflicts roll back atomically',async t=>{
  const f=await fixture(t);await f.storage.trackSessionRecords(f.record.raw_ref,f.record.records);
  assert.equal((await f.storage.sessionRecords(f.record.raw_ref)).length,2);
  await f.storage.publishFinal(f.record);await f.storage.close();
  assert.deepEqual(await f.storage.readFinal(f.record.raw_ref),f.record);
  assert.deepEqual(await f.storage.pendingFinals(),[f.record.raw_ref]);
  await assert.rejects(f.storage.publishFinal({...f.record,ended_by:'different'}),/FINAL_SESSION_CONFLICT/);
  const conflict={...f.record,raw_ref:`l5:${digest({session:2})}`,records:[{...f.record.records[0]!,bytes:Buffer.from('conflict').toString('base64')}]};
  await assert.rejects(f.storage.publishFinal(conflict),/FINAL_RECORD_CONFLICT/);
  assert.equal(await f.storage.readFinal(conflict.raw_ref),null);
  assert.deepEqual(await f.storage.pendingFinals(),[f.record.raw_ref]);
  await f.storage.completeFinal(f.record.raw_ref);
  assert.deepEqual(await f.storage.pendingFinals(),[]);assert.deepEqual(await f.storage.sessionRecords(f.record.raw_ref),[]);
  await f.storage.trackSessionRecords(f.record.raw_ref,f.record.records);
  assert.deepEqual(await f.storage.sessionRecords(f.record.raw_ref),[]);
  assert.deepEqual(await f.storage.readFinal(f.record.raw_ref),f.record);
});

test('folded raw reads use cold whole objects and verify the original slice hash',async t=>{
  const f=await fixture(t),storage=new PosixStorage(f.root,{cold:{url:'http://127.0.0.1:1',username:'test',password_file:'/unused'}});
  t.after(()=>storage.close());await storage.publishFinal(f.record);let calls=0;
  storage.cold!.read=async(namespace,key)=>{calls++;assert.equal(namespace,'objects');assert.equal(key,f.record.object_hash);return f.whole;};
  assert.deepEqual(await storage.read('objects',sha256(f.chunks[1]!)),f.chunks[1]);assert.equal(calls,1);
  storage.cold!.read=async()=>Buffer.alloc(f.whole.length);
  await assert.rejects(storage.read('objects',sha256(f.chunks[0]!)),/FINAL_OBJECT_INTEGRITY/);
});

test('ordinary missing reads do not create a database; symlinked database is rejected',async t=>{
  const f=await fixture(t);assert.equal(await f.storage.readFinal(f.record.raw_ref),null);
  await assert.rejects(f.storage.read('objects',sha256('missing')),/ENOENT/);
  await assert.rejects(fs.lstat(join(f.root,'session-records.sqlite')),/ENOENT/);
  const target=join(f.root,'other');await fs.writeFile(target,'untouched');await fs.symlink(target,join(f.root,'session-records.sqlite'));
  await assert.rejects(f.storage.publishFinal(f.record),/UNSAFE_STORAGE_OBJECT/);
  assert.equal(await fs.readFile(target,'utf8'),'untouched');
});

test('identity raw mappings remain physical whole objects without recursive routes',async t=>{
  const f=await fixture(t),record={...f.record,objects:[{key:f.record.object_hash,offset:0,bytes:f.whole.length}]};
  await f.storage.publish('objects',record.object_hash,f.whole);await f.storage.publishFinal(record);
  assert.deepEqual(await f.storage.read('objects',record.object_hash),f.whole);
});

test('read-only storage reads folded sessions without changing files and rejects writes',async t=>{
  const f=await fixture(t);await f.storage.publish('objects',f.record.object_hash,f.whole);
  await f.storage.publishFinal(f.record);
  await fs.chmod(join(f.root,'session-records.sqlite'),0o440);
  await fs.chmod(join(f.root,'session-records.sqlite-shm'),0o440);
  const snapshot=async()=>{
    const entries:unknown[][]=[];
    const visit=async(path:string)=>{const stat=await fs.lstat(path);
      entries.push([path,stat.ino,stat.mode,stat.size,stat.mtimeMs,stat.isFile()?(await fs.readFile(path)).toString('base64'):null]);
      if(stat.isDirectory())for(const name of (await fs.readdir(path)).sort())await visit(join(path,name));};
    await visit(f.root);return entries;
  };
  const before=await snapshot();
  // A separate reader cannot reuse SQLite's process-global writable SHM mapping from the fixture's writer.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';import {PosixStorage} from './src/storage.ts';
    const f=JSON.parse(process.argv[1]),storage=new PosixStorage(f.root,{read_only:true});
    try{
      assert.deepEqual(await storage.read('stream-revisions',f.alias),Buffer.from(f.metadata,'base64'));
      assert.deepEqual(await storage.read('objects',f.chunk_key),Buffer.from(f.chunk,'base64'));
      assert.deepEqual(await storage.list('stream-revisions'),[f.key,f.alias].sort());
      assert.deepEqual(await storage.readFinal(f.record.raw_ref),f.record);
      await assert.rejects(storage.read('owner-deletions',f.record.raw_ref.slice(3)),/ENOENT/);
      for(const write of [()=>storage.publishFinal(f.record),()=>storage.completeFinal(f.record.raw_ref),
        ()=>storage.bindCallTrack(f.record.raw_ref,{call_id:'test',principal_id:'owner',track:'microphone'}),
        ()=>storage.trackSessionRecords(f.record.raw_ref,f.record.records),
        ()=>storage.replace('voiceprints',f.key,Buffer.from('denied'))])await assert.rejects(write,/STORAGE_READ_ONLY/);
    }finally{await storage.close();}
  `,JSON.stringify({root:f.root,alias:f.alias,key:f.key,record:f.record,metadata:f.metadata.toString('base64'),
    chunk_key:sha256(f.chunks[1]!),chunk:f.chunks[1]!.toString('base64')})],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const after=await snapshot();
  assert.equal(after.length,before.length);
  for(let i=0;i<before.length;i++)for(let field=0;field<before[i]!.length;field++)
    assert.ok(after[i]![field]===before[i]![field],`read-only access changed ${before[i]![0]} field ${field}`);
});

test('read-only reads a closed store from a private copy and never creates sidecars',async t=>{
  const f=await fixture(t);await f.storage.publishFinal(f.record);await f.storage.close();
  const before=(await fs.readdir(f.root)).sort(),storage=new PosixStorage(f.root,{read_only:true});
  t.after(()=>storage.close());
  assert.deepEqual(await storage.readFinal(f.record.raw_ref),f.record);
  assert.deepEqual((await fs.readdir(f.root)).sort(),before);
});

test('read-only sees a live writer\'s committed WAL; missing stores remain absent',async t=>{
  const f=await fixture(t),missing=join(f.root,'absent'),empty=new PosixStorage(missing,{read_only:true});
  // A cold index is opened as a copy too, so read-only storage may carry the cold configuration.
  await new PosixStorage(missing,{read_only:true,cold:{url:'http://127.0.0.1:1',username:'test',password_file:'/unused'}}).close();
  assert.equal(await empty.readFinal(f.record.raw_ref),null);await empty.close();
  await assert.rejects(fs.lstat(missing),/ENOENT/);
  await f.storage.publishFinal(f.record);const storage=new PosixStorage(f.root,{read_only:true});
  t.after(()=>storage.close());
  assert.deepEqual(await storage.readFinal(f.record.raw_ref),f.record);
});

test('final inventory replays remain frozen while mixed late metadata keeps its own durable ownership',async t=>{
 const f=await fixture(t),retained={key:sha256('retained visual original'),format:'png'};
 f.record.retained_objects=[retained];
 await f.storage.publishFinal(f.record);await f.storage.completeFinal(f.record.raw_ref);
 const late={namespace:'processed-media-inputs',key:digest('postfold input')};
 const objects=[f.record.object_hash,...f.record.objects.map(object=>object.key),retained.key].map(key=>({namespace:'objects',key}));
 await f.storage.trackSessionRecords(f.record.raw_ref,[...f.record.records,...objects,late]);
 assert.deepEqual((await f.storage.sessionRecords(f.record.raw_ref)).map(ref=>({...ref})),[late]);
 await f.storage.close();
 assert.deepEqual((await f.storage.sessionRecords(f.record.raw_ref)).map(ref=>({...ref})),[late]);
 await f.storage.completeFinal(f.record.raw_ref);
 assert.deepEqual((await f.storage.sessionRecords(f.record.raw_ref)).map(ref=>({...ref})),[late]);
});
