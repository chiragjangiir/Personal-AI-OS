import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises,{mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {getLoadablePath} from 'sqlite-vec';
import {VisualMemory} from '../src/visual/store.ts';
import {prepareVisualImage} from '../src/visual/image.ts';
const python=process.env.PAIOS_VISION_PYTHON??'python3';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {digest} from '../src/contracts.ts';
import type {CameraFrame} from '../src/visual/store.ts';
const temporary=tmpdir();
async function openMemory(...args:Parameters<typeof VisualMemory.open>) {
  args[6]??=new RawArchive(new PosixStorage(join(args[0],'..')),32*1024*1024);
  const store=await VisualMemory.open(...args),ingest=store.ingest.bind(store),archive=args[6];
  store.ingest=async(principal,device,frame,place,signal,archived)=>{
    if(!archived){const capture=await store.captureArchive(principal,frame,signal??new AbortController().signal,()=>archive.archive({schema_version:'paios.event.v1',
      event_id:`fixture:${digest([principal,device,frame.frame_id])}`,device_id:device,device_type:'glasses',captured_at:frame.captured_at,
      source:{channel:'visual-fixture'},media_type:'visual',mime:'image/jpeg',representation:'uploaded_original',payload:frame.image},
      {principal_id:principal,device_id:device,device_type:'glasses',channel:'visual-fixture',consent_ref:'fixture-consent',submission:'observation'}));
      archived=capture.archived;signal=capture.signal;}
    return ingest(principal,device,frame,place,signal,archived);
  };
  return store;
}


test('persisted visual recall isolates owners; off skips faces; naming and range deletion revoke all frame evidence',async t=>{
  const root=await mkdtemp(join(temporary,'store-test-'));
  const storage=new PosixStorage(root),model={id:'voice-fixture',sha256:'a'.repeat(64),dim:16};
  let people=new VoiceprintRegistry(storage,model);
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  const vector=Array.from({length:1024},(_,i)=>i===0?1:0),face=Float32Array.from({length:128},(_,i)=>i===0?1:0);
  let faceCalls=0,observedFace=face;
  const models={embedImage:async()=>vector,embedQuery:async()=>vector,describe:async()=>({caption:'钥匙放在桌上的白色碗里',ocr:'会议记录：10点开会'})};
  const directory=join(root,'visual-memory'),faces={prepare:async(bytes:Buffer)=>{faceCalls++;return {...await prepareVisualImage(bytes,python),faces:[{embedding:observedFace,bbox:[0,0,1,1],confidence:1}]};}};
  let store=await openMemory(directory,models,{},people,faces);
  t.after(async()=>{await store.close();await people.close();await rm(root,{recursive:true,force:true});});
  const now=Date.now()-3*86400000-500000;
  const frame=(n:number):CameraFrame=>({frame_id:`frame:${n}`,captured_at:new Date(now+n*120000).toISOString(),
    image,trigger:'head_dwell',worn:true,private_paused:false});
  await store.ingest('owner','glasses',frame(0),'家里');assert.equal(faceCalls,0);
  assert.equal((await store.ingest('owner','glasses',{...frame(0),frame_id:'repeat',trigger:'interval',captured_at:new Date(now+1000).toISOString()})).status,'near_duplicate');
  const remembered=await store.recall('owner',{query:'钥匙'});assert.equal(remembered.frames[0]!.caption,'钥匙放在桌上的白色碗里');
  assert.equal(remembered.frames[0]!.place,'家里');assert.deepEqual(await store.imageBytes('owner',remembered.frames[0]!.frame_id,true),image);
  assert.deepEqual((await store.recall('guest',{query:'钥匙'})).frames,[]);
  await people.faceRecognition(true);await store.ingest('owner','glasses',frame(1));
  const person=(await people.clusters())[0]!;await people.renameCluster(person.cluster_id,{display_name:'老王'});
  await store.ingest('owner','glasses',frame(2));assert.equal(faceCalls,2);
  assert.equal((await store.recall('owner',{from:frame(2).captured_at})).frames[0]!.people[0]!.name,'老王');
  const oldest=(await store.recall('owner',{from:frame(1).captured_at,until:frame(2).captured_at})).frames[0]!;
  for(let n=3;n<=23;n++)await store.ingest('owner','glasses',frame(n));
  await store.close();await people.close();people=new VoiceprintRegistry(storage,model);
  store=await openMemory(directory,models,{},people,faces);
  assert.deepEqual((await store.recall('owner',{query:'老王',limit:50})).frames.map(f=>f.frame_id).includes(oldest.frame_id),true);
  assert.deepEqual((await store.recall('owner',{query:'老王',from:frame(1).captured_at,until:frame(2).captured_at})).frames.map(f=>f.people),[[{speaker_ref:`speaker:${person.cluster_id}`,name:'老王'}]]);
  await store.ingest('guest','glasses',frame(1));
  const guest=(await store.recall('guest',{query:'老王'})).frames;
  assert.equal(guest.length,1);assert.notEqual(guest[0]!.frame_id,oldest.frame_id);
  assert.equal((await store.recall('owner',{query:'老王',limit:50})).frames.length,23);
  await store.deleteRange('guest',{from:frame(1).captured_at,until:frame(2).captured_at});
  await people.renameCluster(person.cluster_id,{display_name:'王老师'});
  observedFace=new Float32Array(128);observedFace[1]=1;
  const second=(await store.ingest('owner','glasses',frame(24))).people[0]!;
  const secondFrame=(await store.recall('owner',{from:frame(24).captured_at})).frames[0]!.frame_id;
  await people.renameCluster(second.cluster_id,{display_name:'小张'});
  await people.mergeClusters(person.cluster_id,second.cluster_id);
  assert.deepEqual(store.personIdsInFrames([secondFrame]),[person.cluster_id],'merge moves the actual link rows');
  await store.close();await people.close();people=new VoiceprintRegistry(storage,model);
  store=await openMemory(directory,models,{},people,faces);
  for(const query of ['老王','王老师','小张',`speaker:${second.cluster_id}`]){
    const result=(await store.recall('owner',{query,limit:50})).frames;
    assert.equal(result.length,24);assert.ok(result.some(f=>f.frame_id===oldest.frame_id));
    assert.ok(result.every(f=>f.people.length===1&&f.people[0]!.speaker_ref===`speaker:${person.cluster_id}`&&f.people[0]!.name==='王老师'));
    assert.deepEqual((await store.recall('guest',{query})).frames,[]);
  }
  await people.forgetCluster(person.cluster_id);
  assert.deepEqual(store.personIdsInFrames(),[],'forget deletes the actual link rows');
  await store.close();await people.close();people=new VoiceprintRegistry(storage,model);
  store=await openMemory(directory,models,{},people,faces);
  assert.ok((await store.recall('owner',{limit:50})).frames.every(f=>f.people.length===0));
  observedFace=face;vector.pop();
  await assert.rejects(store.ingest('owner','glasses',frame(25)),/1024/u);
  assert.deepEqual(await people.clusters(),[]);assert.deepEqual(store.personIdsInFrames(),[],'failed publication retracts the already-committed face and link');
  vector.push(0);
  observedFace=face;const fresh=(await store.ingest('owner','glasses',frame(25))).people[0]!;
  assert.notEqual(fresh.cluster_id,person.cluster_id,'forget removes biometric exemplars as well as historical links');
  const outcome=await store.deleteRange('owner',{from:new Date(now).toISOString(),until:frame(26).captured_at});
  assert.equal(outcome.frames,26);assert.deepEqual(await readdir(join(directory,'frames')),[]);
  assert.deepEqual((await store.recall('owner',{query:'钥匙'})).frames,[]);assert.deepEqual(await people.clusters(),[]);
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true,allowExtension:true});
  db.loadExtension(getLoadablePath());db.enableLoadExtension(false);
  try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frames').get()!.n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_text').get()!.n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vectors').get()!.n,0);}finally{db.close();}
});

test('visual links migrate once from face samples, keep only retained frames and survive deletion/restart',async t=>{
  const root=await mkdtemp(join(temporary,'face-migrate-')),directory=join(root,'visual'),storage=new PosixStorage(root);
  const model={id:'fixture',sha256:'a'.repeat(64),dim:16};let people=new VoiceprintRegistry(storage,model);
  const prepared=await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python);
  const vector=Array(1024).fill(1),face=new Float32Array(128);face[0]=1;
  const models={embedImage:async()=>vector,embedQuery:async()=>vector,describe:async()=>({caption:'',ocr:''})};
  const faces={prepare:async()=>({...prepared,faces:[{embedding:face,bbox:[0,0,1,1],confidence:1}]})};
  let store=await openMemory(directory,models,{},people,faces);
  t.after(async()=>{await store.close();await people.close();await rm(root,{recursive:true,force:true});});
  await people.faceRecognition(true);const at=Date.now()-5000000;
  for(let n=0;n<23;n++)await store.ingest('owner','glasses',{frame_id:`frame-${n}`,captured_at:new Date(at+n*120000).toISOString(),image:prepared.thumbnail,trigger:'user_request',worn:true,private_paused:false});
  const keys=(await store.recall('owner',{limit:50})).frames.map(f=>f.frame_id);
  await people.renameCluster('1',{display_name:'小林'});await store.close();await people.close();
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
  db.exec("PRAGMA foreign_keys=ON;DROP TABLE frame_people;DELETE FROM meta WHERE key='face_links_migrated'");
  t.after(()=>db.close());people=new VoiceprintRegistry(storage,model);
  store=await openMemory(directory,models,{},people,faces);
  const expected=20;
  assert.equal((await store.recall('owner',{query:'小林',limit:50})).frames.length,expected);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_people').get()!.n,expected,'only retained frames migrate, without duplicate links');
  db.prepare('DELETE FROM vectors WHERE rowid=(SELECT id FROM frames WHERE frame_key=?)').run(keys[0]!);
  db.prepare('DELETE FROM frames WHERE frame_key=?').run(keys[0]!);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_people WHERE frame_key=?').get(keys[0]!)!.n,0,'all frame-row deletion paths cascade');
  await store.close();await people.close();people=new VoiceprintRegistry(storage,model);
  store=await openMemory(directory,models,{},people,faces);
  assert.equal((await store.recall('owner',{query:'小林',limit:50})).frames.length,expected-1,'restart does not re-import a deleted link');
});

test('failed indexing retracts derived evidence but keeps exact input in L5',async t=>{
  const root=await mkdtemp(join(temporary,'recovery-test-')),directory=join(root,'visual-memory');
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  const models={embedImage:async():Promise<number[]>=>{throw new Error('provider rejected');},embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'',ocr:''})};
  const store=await openMemory(directory,models,{},undefined,undefined);t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  await assert.rejects(store.ingest('owner','glasses',{frame_id:'bad',captured_at:new Date().toISOString(),image,
    trigger:'user_request',worn:true,private_paused:false}),/provider rejected/);
  assert.deepEqual(await readdir(join(directory,'frames')),[]);assert.deepEqual((await store.recall('owner',{})).frames,[]);
  assert.equal((await readdir(join(root,'manifests'))).length,1);
});

test('recall and local deletion remain responsive during slow models and cancel active or queued capture',{timeout:10000},async t=>{
  const root=await mkdtemp(join(temporary,'delete-race-'));const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  const ready=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let slow=false;
  const store=await openMemory(join(root,'visual'),{embedImage:async(_bytes,signal)=>{if(slow){ready.resolve();await release.promise;signal!.throwIfAborted();}return Array(1024).fill(1);},
    embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'',ocr:''})},{},undefined,undefined);
  t.after(async()=>{release.resolve();await store.close();await rm(root,{recursive:true,force:true});});
  const at=new Date().toISOString();await store.ingest('owner','glasses',{frame_id:'seed',captured_at:new Date(Date.parse(at)-180000).toISOString(),image,trigger:'user_request',worn:true,private_paused:false});slow=true;
  const active=store.ingest('owner','glasses',{frame_id:'race',captured_at:at,image,trigger:'user_request',worn:true,private_paused:false});
  await ready.promise;const pending=store.ingest('owner','glasses',{frame_id:'queued',captured_at:at,image,trigger:'user_request',worn:true,private_paused:false});
  const activeRejected=assert.rejects(active,/VISUAL_DELETED/),pendingRejected=assert.rejects(pending,/VISUAL_DELETED/);
  assert.equal((await store.recall('owner',{})).frames.length,1);
  const deleted=await store.deleteRange('owner',{from:at,until:new Date(Date.parse(at)+1).toISOString()});assert.equal(deleted.status,'deleted');slow=false;release.resolve();await activeRejected;
  await store.ingest('owner','glasses',{frame_id:'after-delete',captured_at:new Date(Date.parse(at)+2).toISOString(),image,trigger:'user_request',worn:true,private_paused:false});release.resolve();
  await Promise.all([activeRejected,pendingRejected]);assert.equal((await store.recall('owner',{})).frames.length,2);
});


test('L5 retains every frame across duplicate filtering, small visual budgets, restart and thumbnail regeneration',async t=>{
  const root=await mkdtemp(join(temporary,'l5-visual-retain-')),directory=join(root,'visual'),archive=new RawArchive(new PosixStorage(root),32*1024*1024);
  const small=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  const image=Buffer.concat([small,Buffer.alloc(2900000),small.subarray(-2)]);
  const models={embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'retained',ocr:''})};
  let store=await openMemory(directory,models,{retention_days:1,max_bytes:8*1024*1024},undefined,undefined,undefined,archive);
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  const at=Date.now()-7*86400000;
  for(let n=0;n<4;n++)await store.ingest('owner','glasses',{frame_id:`frame-${n}`,captured_at:new Date(at+n*120000).toISOString(),image,trigger:'user_request',worn:true,private_paused:false});
  assert.equal((await store.ingest('owner','glasses',{frame_id:'near',captured_at:new Date(at+360001).toISOString(),image,trigger:'interval',worn:true,private_paused:false})).status,'near_duplicate');
  assert.equal((await readdir(join(root,'manifests'))).length,5);
  assert.equal((await readdir(join(directory,'frames'))).length,4,'catalogue holds thumbnails only');
  const frames=(await store.recall('owner',{})).frames;await store.stageCold();
  for(const f of frames)assert.deepEqual(await store.imageBytes('owner',f.frame_id,true),image);
  await store.close();await rm(join(directory,'frames'),{recursive:true});
  store=await openMemory(directory,models,{},undefined,undefined,undefined,archive);
  assert.ok((await store.imageBytes('owner',frames[0]!.frame_id)).length);
  await assert.rejects(store.imageBytes('guest',frames[0]!.frame_id,true),/NOT_FOUND/);
});

test('opening and staging legacy originals preserve bytes without invented provenance',async t=>{
  const root=await mkdtemp(join(temporary,'l5-visual-migrate-')),directory=join(root,'visual'),archive=new RawArchive(new PosixStorage(root),32*1024*1024);
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  const models={embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'legacy',ocr:''})};
  let store=await openMemory(directory,models,{},undefined,undefined,undefined,archive);
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  await store.ingest('owner','glasses',{frame_id:'legacy',captured_at:new Date().toISOString(),image,trigger:'user_request',worn:true,private_paused:false});
  const key=(await store.recall('owner',{})).frames[0]!.frame_id;await store.close();
  const original=`frames/${key}.jpg`;await writeFile(join(directory,original),image);
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
  db.prepare("UPDATE frames SET raw_ref=NULL,archive_revision=NULL,original=?,bytes=?,cold_ref='originals/legacy.jpg'").run(original,image.length);db.close();
  let downloads=0;store=await openMemory(directory,models,{},undefined,undefined,{download:async()=>{downloads++;return image;},delete:async()=>{}},archive);
  await store.stageCold();assert.deepEqual(await readFile(join(directory,original)),image);assert.equal(downloads,0);
  await assert.rejects(store.imageBytes('owner',key,true),/VISUAL_LEGACY_IMPORT_REQUIRED/);
  const remaining=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});
  assert.equal(remaining.prepare('SELECT raw_ref FROM frames').get()!.raw_ref,null);remaining.close();
});

test('explicit owner range deletion revokes indexed, duplicate-filtered and failed-index raw inputs',async t=>{
  const root=await mkdtemp(join(temporary,'visual-all-delete-')),directory=join(root,'visual'),archive=new RawArchive(new PosixStorage(root),32*1024*1024);
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  let fail=false;const models={embedImage:async()=>{if(fail)throw new Error('index failure');return Array(1024).fill(1);},embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'',ocr:''})};
  let store=await openMemory(directory,models,{},undefined,undefined,undefined,archive);
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  const at=Date.now(),frame=(id:string,offset:number):CameraFrame=>({frame_id:id,captured_at:new Date(at+offset).toISOString(),image,trigger:'user_request',worn:true,private_paused:false});
  await store.ingest('owner','glasses',frame('kept',0));
  assert.equal((await store.ingest('owner','glasses',{...frame('near',1),trigger:'interval'})).status,'near_duplicate');
  fail=true;await assert.rejects(store.ingest('owner','glasses',frame('failed',120000)),/index failure/);
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});
  const refs=db.prepare('SELECT raw_ref,archive_revision,owner_delete FROM capture_refs').all();db.close();assert.equal(refs.length,3);
  assert.ok(refs.every(ref=>ref.owner_delete===0),'all raw inputs remain live before explicit deletion');
  const range={from:new Date(at).toISOString(),until:new Date(at+120001).toISOString()};
  const deletion=t.mock.method(archive,'deleteMany',async()=>{throw new Error('deletion interrupted');});
  await assert.rejects(store.deleteRange('owner',range),/deletion interrupted/);deletion.mock.restore();await store.close();
  store=await VisualMemory.open(directory,models);
  const outcome=await store.deleteRange('owner',range);assert.equal(outcome.originals,0);assert.equal(outcome.status,'pending');
  assert.equal(outcome.raw_cleanup_pending,3,'retry keeps the three existing cleanup obligations');
  const pending=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});
  assert.deepEqual(pending.prepare('SELECT owner_delete FROM capture_refs').all().map(ref=>ref.owner_delete),[1,1,1]);pending.close();
  store.bindArchive(archive);await store.stageCold();
  for(const ref of refs)await assert.rejects(archive.read(String(ref.raw_ref),'owner',String(ref.archive_revision)),/DELETED|NOT_FOUND|ENOENT/);
  const completed=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});
  assert.deepEqual(completed.prepare('SELECT owner_delete FROM capture_refs').all().map(ref=>ref.owner_delete),[2,2,2]);completed.close();
  assert.deepEqual((await store.recall('owner',{})).frames,[]);
});

test('range deletion fences completed archive admission before indexing, including after reopen',async t=>{
  const root=await mkdtemp(join(temporary,'visual-handoff-delete-')),directory=join(root,'visual'),archive=new RawArchive(new PosixStorage(root),32*1024*1024);
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  const models={embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'retained',ocr:''})};
  let store=await VisualMemory.open(directory,models,{},undefined,undefined,undefined,archive);
  const gates:{resolve:()=>void}[]=[];
  t.after(async()=>{for(const gate of gates)gate.resolve();await store.close();await rm(root,{recursive:true,force:true});});
  const at=Date.now(),frame=(id:string,offset:number):CameraFrame=>({frame_id:id,captured_at:new Date(at+offset).toISOString(),image,
    trigger:'user_request',worn:true,private_paused:false});
  const archiveFrame=(principal:string,input:CameraFrame)=>store.captureArchive(principal,input,new AbortController().signal,()=>archive.archive({
    schema_version:'paios.event.v1',event_id:`fixture:${digest([principal,input.frame_id])}`,device_id:'glasses',device_type:'glasses',captured_at:input.captured_at,
    source:{channel:'visual-fixture'},media_type:'visual',mime:'image/jpeg',representation:'uploaded_original',payload:input.image},
    {principal_id:principal,device_id:'glasses',device_type:'glasses',channel:'visual-fixture',consent_ref:'fixture-consent',submission:'observation'}));
  const retained=frame('retained',-120000),retainedCapture=await archiveFrame('owner',retained);
  await store.ingest('owner','glasses',retained,undefined,retainedCapture.signal,retainedCapture.archived);
  for(const reopen of [false,true]){
    const input=frame(`handoff-${reopen}`,reopen?120000:0),captured=await archiveFrame('owner',input);
    const release=Promise.withResolvers<void>();gates.push(release);
    // Admission has returned and unregistered. Hold the caller before the next public operation.
    const indexing=release.promise.then(()=>store.ingest('owner','glasses',input,undefined,captured.signal,captured.archived));
    const rejected=assert.rejects(indexing,/VISUAL_DELETED/);
    const range={from:input.captured_at,until:new Date(Date.parse(input.captured_at)+1).toISOString()};
    assert.equal((await store.deleteRange('owner',range)).status,'deleted');
    if(reopen){await store.close();store=await VisualMemory.open(directory,models,{},undefined,undefined,undefined,archive);}
    release.resolve();await rejected;
    assert.deepEqual((await store.recall('owner',{})).frames.map(row=>row.caption),['retained']);
    await assert.rejects(archive.read(captured.archived.raw_ref,'owner',captured.archived.archive_revision),/RAW_DELETED/);
    assert.equal((await store.deleteRange('owner',range)).originals,0,'completed revocation stays complete');
  }
  assert.deepEqual(await archive.read(retainedCapture.archived.raw_ref,'owner',retainedCapture.archived.archive_revision),image);
  assert.equal((await store.recall('guest',{})).frames.length,0);
});

test('visual admission owns one bounded frame through face work, failure and close',{timeout:5000},async t=>{
  const root=await mkdtemp(join(temporary,'visual-budget-')),storage=new PosixStorage(root),archive=new RawArchive(storage,4*1024*1024);
  const people=new VoiceprintRegistry(storage,{id:'fixture',sha256:'a'.repeat(64),dim:16});await people.faceRecognition(true);
  let entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),calls=0,failing=false;
  const faces={prepare:async(_bytes:Buffer,signal?:AbortSignal)=>{calls++;entered.resolve();await release.promise;signal?.throwIfAborted();
    if(failing)throw new Error('controlled face failure');return {thumbnail:Buffer.from('derived thumbnail'),signature:Buffer.alloc(64),faces:[]};}};
  const models={embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'',ocr:''})};
  const store=await openMemory(join(root,'visual'),models,{},people,faces,undefined,archive);
  t.after(async()=>{release.resolve();await store.close();await people.close();await archive.close();await rm(root,{recursive:true,force:true});});
  const frame=(n:number):CameraFrame=>({frame_id:`budget-${n}`,captured_at:new Date(Date.now()+n*180000).toISOString(),
    image:Buffer.from('durable original'),trigger:'user_request',worn:true,private_paused:false});
  const first=store.ingest('owner','glasses',frame(0));await entered.promise;
  assert.equal(store.resourceSnapshot().active_jobs,1);assert.equal(store.resourceSnapshot().input_bytes,frame(0).image.length);
  await assert.rejects(store.ingest('owner','glasses',frame(1)),/VISUAL_INGEST_BUSY/);assert.equal(calls,1);
  assert.equal((await storage.list('manifests')).length,2,'busy indexing retains the already durable L5 original');
  release.resolve();assert.equal((await first).status,'kept');assert.equal(store.resourceSnapshot().input_bytes,0);
  await assert.rejects(store.ingest('owner','glasses',{...frame(2),image:Buffer.alloc(3*1024*1024+1)}),/VISUAL_IMAGE_TOO_LARGE/);
  assert.equal(calls,1);
  entered=Promise.withResolvers<void>();release=Promise.withResolvers<void>();failing=true;
  const failed=assert.rejects(store.ingest('owner','glasses',frame(3)),/controlled face failure/);await entered.promise;release.resolve();await failed;
  assert.equal(store.resourceSnapshot().active_jobs,0);
  entered=Promise.withResolvers<void>();release=Promise.withResolvers<void>();failing=false;
  const cancelled=assert.rejects(store.ingest('owner','glasses',frame(4)),/VISUAL_CLOSED/);await entered.promise;
  const closing=store.close();await assert.rejects(store.ingest('owner','glasses',frame(5)),/VISUAL_CLOSED/);
  assert.equal(calls,3);release.resolve();await Promise.all([cancelled,closing]);
  assert.equal(store.resourceSnapshot().input_bytes,0);assert.equal(store.resourceSnapshot().active_jobs,0);
});

test('exact raw deletion revokes visual reads before cleanup and survives late indexing and restart',{timeout:15000},async t=>{
  const root=await mkdtemp(join(temporary,'visual-exact-delete-')),directory=join(root,'visual'),storage=new PosixStorage(root);
  const archive=new RawArchive(storage,4*1024*1024),people=new VoiceprintRegistry(storage,{id:'fixture',sha256:'a'.repeat(64),dim:16});
  await people.faceRecognition(true);
  const image=Buffer.from('shared original'),thumbnail=Buffer.from('shared thumbnail'),face=Float32Array.from({length:128},(_,i)=>Number(i===0));
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let slow=false;
  const models={embedImage:async()=>{if(slow){entered.resolve();await release.promise;}return Array(1024).fill(1);},
    embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'secret keys',ocr:'private OCR'})};
  const faces={prepare:async()=>({thumbnail,signature:Buffer.alloc(64),faces:[{embedding:face,bbox:[0,0,1,1],confidence:1}]})};
  let store=await openMemory(directory,models,{},people,faces,undefined,archive);
  t.after(async()=>{release.resolve();await store.close();await people.close();await archive.close();await rm(root,{recursive:true,force:true});});
  await archive.setRemoval((principal,_processed,refs)=>store.forgetRawRefs(principal,refs));
  const at=Date.now(),frame=(id:string,n:number):CameraFrame=>({frame_id:id,captured_at:new Date(at+n*180000).toISOString(),image,trigger:'user_request',worn:true,private_paused:false});
  await store.ingest('owner','glasses',frame('deleted',0));await store.ingest('owner','glasses',frame('retained',1));
  await store.ingest('guest','glasses',frame('guest',2));
  const target=(await store.recall('owner',{until:frame('retained',1).captured_at})).frames[0]!;
  const cleanup=t.mock.method(people,'deleteFrameEvidence',async()=>{throw new Error('face cleanup interrupted');});
  await assert.rejects(archive.deleteMany([target.raw_ref!],'owner'),/face cleanup interrupted/);
  assert.deepEqual((await store.recall('owner',{until:frame('retained',1).captured_at})).frames,[]);
  await assert.rejects(store.imageBytes('owner',target.frame_id),/NOT_FOUND/);
  await assert.rejects(store.imageBytes('owner',target.frame_id,true),/NOT_FOUND/);
  await assert.rejects(store.stageCold(),/face cleanup interrupted/);cleanup.mock.restore();
  await store.stageCold();assert.equal((await store.recall('owner',{})).frames.length,1);
  assert.equal((await store.recall('guest',{})).frames.length,1,'shared source bytes and other owner evidence stay live');
  const retained=(await store.recall('owner',{})).frames[0]!;assert.deepEqual(await store.imageBytes('owner',retained.frame_id),thumbnail);
  slow=true;const pending=store.ingest('owner','glasses',frame('late',3));await entered.promise;
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});
  const late=db.prepare('SELECT raw_ref FROM capture_refs WHERE captured_ms=?').get(at+3*180000)!;db.close();
  const rejected=assert.rejects(pending,/VISUAL_DELETED/);await archive.deleteMany([String(late.raw_ref)],'owner');release.resolve();await rejected;
  const handoff=frame('handoff',4),archived=await archive.archive({schema_version:'paios.event.v1',event_id:'late-handoff',device_id:'glasses',device_type:'glasses',
    captured_at:handoff.captured_at,source:{channel:'visual-fixture'},media_type:'visual',mime:'image/jpeg',representation:'uploaded_original',payload:image},
    {principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'visual-fixture',consent_ref:'fixture-consent',submission:'observation'});
  const admitted=Promise.withResolvers<void>(),publish=Promise.withResolvers<void>();
  const admission=store.captureArchive('owner',handoff,new AbortController().signal,async()=>{admitted.resolve();await publish.promise;return archived;});
  const admissionRejected=assert.rejects(admission,/RAW_DELETED/);await admitted.promise;
  await archive.deleteMany([archived.raw_ref],'owner');publish.resolve();await admissionRejected;
  await store.close();store=await openMemory(directory,models,{},people,faces,undefined,archive);
  await archive.reconcileRemovals();await store.stageCold();
  assert.deepEqual((await store.recall('owner',{})).frames.map(f=>f.frame_id),[retained.frame_id]);
  assert.equal((await people.clusters()).length,1,'shared face evidence remains');
  assert.equal((await readdir(join(directory,'frames'))).length,2,'deleted thumbnails are removed');
  const outcome=await store.deleteRange('owner',{from:retained.at,until:new Date(Date.parse(retained.at)+1).toISOString()});
  assert.equal(outcome.status,'deleted','range cleanup can re-enter through the same raw removal callback');
  assert.deepEqual((await store.recall('owner',{})).frames,[]);
  assert.equal((await store.recall('guest',{})).frames.length,1);
});


async function deletionRaceFixture(t:{after:(cleanup:()=>Promise<void>)=>void}) {
  const root=await mkdtemp(join(temporary,'visual-cleanup-race-')),directory=join(root,'visual'),storage=new PosixStorage(root);
  const archive=new RawArchive(storage,4*1024*1024),people=new VoiceprintRegistry(storage,{id:'fixture',sha256:'a'.repeat(64),dim:16});
  await people.faceRecognition(true);
  const models={embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'retained',ocr:''})};
  const thumbnail=Buffer.from('thumbnail'),faces={prepare:async()=>({thumbnail,signature:Buffer.alloc(64),faces:[]})};
  const store=await openMemory(directory,models,{},people,faces,undefined,archive);
  t.after(async()=>{await store.close();await people.close();await archive.close();await rm(root,{recursive:true,force:true});});
  const frame=(id:string):CameraFrame=>({frame_id:id,captured_at:new Date().toISOString(),image:Buffer.from('original'),trigger:'user_request',worn:true,private_paused:false});
  return {directory,archive,people,store,frame,thumbnail};
}

test('raw callback waits for the thumbnail publication before removing its catalogue row',{timeout:10000},async t=>{
  const {directory,archive,people,store,frame}=await deletionRaceFixture(t);
  const writing=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),notified=Promise.withResolvers<void>();
  const originalWrite=fsPromises.writeFile;
  const writer=t.mock.method(fsPromises,'writeFile',async(...args:Parameters<typeof originalWrite>)=>{
    if(String(args[0]).startsWith(join(directory,'frames'))){writing.resolve();await release.promise;}
    return originalWrite(...args);
  });syncBuiltinESMExports();
  t.after(async()=>{release.resolve();writer.mock.restore();syncBuiltinESMExports();});
  const cleanup=t.mock.method(people,'deleteFrameEvidence',async()=>{});
  await archive.setRemoval((principal,_processed,refs)=>{const pending=store.forgetRawRefs(principal,refs);notified.resolve();return pending;});
  const input=frame('publication'),ingesting=assert.rejects(store.ingest('owner','glasses',input),/VISUAL_DELETED/);await writing.promise;
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true}),row=db.prepare('SELECT raw_ref FROM frames').get()!;db.close();
  const deleting=archive.deleteMany([String(row.raw_ref)],'owner');await notified.promise;
  const cleanupBeforeWriteFinished=cleanup.mock.calls.length;
  if(cleanupBeforeWriteFinished)await deleting;
  release.resolve();await Promise.all([deleting,ingesting]);
  assert.deepEqual(await readdir(join(directory,'frames')),[],'deletion leaves no thumbnail after its admitted writer finishes');
  assert.equal(cleanupBeforeWriteFinished,0,'raw cleanup cannot overtake an admitted thumbnail writer');
  assert.deepEqual((await store.recall('owner',{})).frames,[]);
});

test('raw callback and maintenance cannot remove a new frame that reuses a deleted row id',{timeout:10000},async t=>{
  const {directory,archive,people,store,frame,thumbnail}=await deletionRaceFixture(t);
  await store.ingest('owner','glasses',frame('old'));
  const target=(await store.recall('owner',{})).frames[0]!;
  const nextFrame=frame('new'),nextOriginal=await archive.archive({schema_version:'paios.event.v1',event_id:'new-original',device_id:'glasses',device_type:'glasses',
    captured_at:nextFrame.captured_at,source:{channel:'visual-fixture'},media_type:'visual',mime:'image/jpeg',representation:'uploaded_original',payload:nextFrame.image},
    {principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'visual-fixture',consent_ref:'fixture-consent',submission:'observation'});
  const db=new DatabaseSync(join(directory,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
  const oldId=db.prepare('SELECT id FROM frames').get()!.id;
  db.exec("UPDATE capture_refs SET owner_delete=2;UPDATE frames SET state='deleting',owner_delete=1");db.close();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),late=Promise.withResolvers<void>(),notified=Promise.withResolvers<void>();
  let calls=0;const originalCleanup=people.deleteFrameEvidence.bind(people);
  t.mock.method(people,'deleteFrameEvidence',async(keys:string[])=>{if(++calls===1){entered.resolve();await release.promise;}else await late.promise;return originalCleanup(keys);});
  t.after(async()=>{release.resolve();late.resolve();});
  await archive.setRemoval((principal,_processed,refs)=>{const pending=store.forgetRawRefs(principal,refs);notified.resolve();return pending;});
  const maintenance=store.stageCold();await entered.promise;
  const deleting=archive.deleteMany([target.raw_ref!],'owner');await notified.promise;
  release.resolve();await maintenance;
  await store.ingest('owner','glasses',nextFrame,undefined,undefined,nextOriginal);
  const current=(await store.recall('owner',{})).frames[0]!;
  const rows=new DatabaseSync(join(directory,'visual.sqlite'),{readOnly:true});assert.equal(rows.prepare('SELECT id FROM frames').get()!.id,oldId,'SQLite reuses the removed integer row id');rows.close();
  late.resolve();await deleting;
  assert.deepEqual(await store.imageBytes('owner',current.frame_id),thumbnail);
  assert.equal((await store.recall('owner',{})).frames[0]!.frame_id,current.frame_id);
});

for(const operation of ['range','maintenance'])test(`close waits for ${operation} raw deletion before closing the visual database`,{timeout:10000},async t=>{
    const {directory,archive,store,frame}=await deletionRaceFixture(t);
    const input=frame(operation);await store.ingest('owner','glasses',input);
    await archive.setRemoval((principal,_processed,refs)=>store.forgetRawRefs(principal,refs));
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),originalDelete=archive.deleteMany.bind(archive);
    t.mock.method(archive,'deleteMany',async(refs:string[],principal:string)=>{entered.resolve();await release.promise;return originalDelete(refs,principal);});
    t.after(async()=>{release.resolve();});
    if(operation==='maintenance'){
      const db=new DatabaseSync(join(directory,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
      db.exec("UPDATE capture_refs SET owner_delete=1;UPDATE frames SET state='deleting',owner_delete=1");db.close();
    }
    const deleting=operation==='range'?store.deleteRange('owner',{from:input.captured_at,until:new Date(Date.parse(input.captured_at)+1).toISOString()}):store.stageCold();
    await entered.promise;
    const closing=store.close();
    // Drain ready continuations while the archive boundary remains held, without a time delay.
    await new Promise<void>(resolve=>setImmediate(resolve));
    release.resolve();await Promise.all([deleting,closing]);
    await assert.rejects(store.recall('owner',{}),/VISUAL_CLOSED/);
});
