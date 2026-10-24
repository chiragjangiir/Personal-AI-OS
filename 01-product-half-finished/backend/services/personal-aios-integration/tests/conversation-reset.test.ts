import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PosixStorage} from '../src/storage.ts';
import {Timeline} from '../src/timeline.ts';
import {AmbientJournal} from '../src/ambient/journal.ts';
import {CareAuthority} from '../src/care/authority.ts';
import {digest,sha256} from '../src/contracts.ts';
import {resetIntegrationConversation} from '../src/conversation-reset.ts';
import {CONVERSATION_RESET_CUTOFF} from '../src/archive-conversation-reset.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {PersonalAIOSRuntime,RunAdmission} from './native-source-fixture.ts';
const cutoff=Date.parse(CONVERSATION_RESET_CUTOFF),raw=`l5:${'a'.repeat(64)}`;
const never=async()=>{throw new Error('NO_EXTERNAL_CALLS');};

test('empty integration preview accepts absent central storage without creating it',async t=>{
  const owner=await fs.mkdtemp(join(tmpdir(),'empty-reset-'));t.after(()=>fs.rm(owner,{recursive:true,force:true}));
  const root=join(owner,'central-storage'),storage=new PosixStorage(root,{read_only:true});t.after(()=>storage.close());
  const report=await resetIntegrationConversation({storage_root:root,storage,removed_raw_refs:[],selected_records:[]});
  assert.ok(report.categories.every(c=>c.delete_count===0&&c.keep_count===0));
  assert.deepEqual(await fs.readdir(owner),[]);
});

test('offline cutoff preserves protected stores and boundary; real timeline/journal/care readers and repeat are clean',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'integration-reset-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);t.after(()=>storage.close());
  let created=cutoff-1;const timeline=new Timeline({directory:join(root,'timeline'),now:()=>created},storage,never,{readOnly:async()=>undefined});
  for(const [item_id,at_ms,via] of [['old',cutoff-1,'text'],['boundary',cutoff,'text'],['errand',cutoff-1,'errand']] as const){created=at_ms;
    timeline.append({principal_id:'owner',item_id,at_ms,kind:'owner',via,text:item_id});}
  created=cutoff;timeline.append({principal_id:'owner',item_id:'created-later',at_ms:cutoff-5,kind:'owner',via:'text',text:'created-later'});
  created=cutoff-1;timeline.append({principal_id:'owner',item_id:'source-later',at_ms:cutoff-5,source_at_ms:cutoff,kind:'owner',via:'text',text:'source-later'});
  await timeline.close();
  const journal=AmbientJournal.open(join(root,'ambient-journal'));
  const source={principal_id:'owner',device_id:'mac',processed_event_id:'d:old',raw_ref:raw,archive_revision:'b'.repeat(64),segment_id:'segment'};
  const utterance=(segment_index:number,end_ms:number,text:string)=>({segment_index,start_ms:end_ms-1,end_ms,speaker:'owner',score:0.9,text,lang:null,wake:null,wake_cut_ms:null});
  const old=utterance(0,cutoff-1,'old-search-token'),boundary=utterance(1,cutoff,'boundary-search-token');
  const newRaw=`l5:${'9'.repeat(64)}`,newSource={...source,processed_event_id:'d:new',raw_ref:newRaw};
  journal.append(source,[old]);journal.append(newSource,[utterance(0,cutoff-10,'new-server-old-clock'),boundary]);journal.close();
  CareAuthority.open(join(root,'care'),()=>cutoff).close();
  const careDb=new DatabaseSync(join(root,'care','care.sqlite'));
  careDb.prepare('INSERT INTO timeline VALUES(?,?,?)').run('owner',cutoff-1,'主人：old-private-words');
  careDb.prepare('INSERT INTO timeline VALUES(?,?,?)').run('owner',cutoff-1,'手表检测到摔倒');
  careDb.prepare('INSERT INTO timeline VALUES(?,?,?)').run('owner',cutoff,'主人：boundary-words');careDb.close();
  const put=async(namespace:string,key:string,value:unknown)=>storage.publish(namespace,key,Buffer.from(JSON.stringify(value)));
  const d={principal_id:'owner',processed_event_id:'d:old',raw_ref:raw,media_type:'text',captured_at:new Date(cutoff-2).toISOString(),received_at:new Date(cutoff-1).toISOString(),content:{text:'old'}};
  await put('processed-events',digest({principal_id:'owner',processed_event_id:d.processed_event_id}),d);
  await put('processed-events',digest('protected-approval'),{...d,raw_ref:`l5:${'c'.repeat(64)}`,media_type:'app_event',content:{app_event:{kind:'owner_confirmation'}}});
  const protectedBytes=Buffer.from('protected-original');for(const name of ['voiceprints','payment-initiating','terminal-cards','effect-consents','session-owners'])await storage.publish(name,digest('protected'),protectedBytes);
  const options={storage_root:root,storage,removed_raw_refs:[raw],known_raw_refs:[newRaw],selected_records:[]};
  const before=await fs.readFile(join(root,'timeline','timeline.sqlite'));
  const namesBefore=(await fs.readdir(root,{recursive:true})).sort();
  const preview=await resetIntegrationConversation(options);assert.equal(preview.categories.find(c=>c.name==='formal-timeline')?.delete_count,1);
  assert.deepEqual(await fs.readFile(join(root,'timeline','timeline.sqlite')),before);
  assert.deepEqual((await fs.readdir(root,{recursive:true})).sort(),namesBefore);
  await resetIntegrationConversation({...options,apply:true});
  const reopened=new Timeline({directory:join(root,'timeline'),now:()=>cutoff},storage,never,{readOnly:async()=>undefined});
  assert.deepEqual(reopened.page('owner').items.map(r=>r.item_id),['boundary','errand','created-later','source-later']);
  assert.ok(reopened.page('owner',{after_seq:1}).removals?.length);await reopened.close();
  const afterJournal=AmbientJournal.open(join(root,'ambient-journal'));
  assert.deepEqual(afterJournal.search({principal_id:'owner',limit:10}).entries.map(r=>r.text),['boundary-search-token','new-server-old-clock']);
  assert.equal(afterJournal.search({principal_id:'owner',text:'old-search-token',limit:10}).entries.length,0);
  afterJournal.append(source,[old]);assert.equal(afterJournal.entriesOf('owner','d:old').length,0);afterJournal.close();
  const care=CareAuthority.open(join(root,'care'),()=>cutoff);
  const recent=care.recent('owner').join('\n');assert.doesNotMatch(recent,/old-private-words/u);assert.match(recent,/手表检测到摔倒/u);assert.match(recent,/boundary-words/u);care.close();
  for(const name of ['voiceprints','payment-initiating','terminal-cards','effect-consents','session-owners'])assert.deepEqual(Buffer.from(await storage.read(name,digest('protected'))),protectedBytes);
  assert.equal((await storage.list('processed-events')).length,1);
  const repeated=await resetIntegrationConversation({...options,apply:true});assert.equal(repeated.categories.reduce((n,c)=>n+c.delete_count,0),0);
  const empty=await resetIntegrationConversation(options);assert.equal(empty.categories.reduce((n,c)=>n+c.delete_count,0),0);
});

test('source closure removes restart inputs and unfinished output, keeps shared TTS and later sources',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-closure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);t.after(()=>storage.close());
  const put=async(namespace:string,key:string,value:unknown)=>storage.publish(namespace,key,Buffer.from(JSON.stringify(value)));
  const d={principal_id:'owner',processed_event_id:'d:old',raw_ref:raw,media_type:'text',captured_at:new Date(cutoff+100000).toISOString(),received_at:new Date(cutoff-1).toISOString(),content:{text:'old-clock-skew'}};
  const dKey=digest({principal_id:d.principal_id,processed_event_id:d.processed_event_id}),aKey=digest({principal_id:d.principal_id,session_id:'session',processed_event_id:d.processed_event_id});
  await put('processed-events',dKey,d);await put('processed-event-sources',dKey,{raw_ref:raw});await put('d-session-bindings',dKey,{session_id:'session'});
  await put('admissions',aKey,{principal_id:'owner',processed_event_id:d.processed_event_id});await put('admission-inputs',aKey,{d,skill:'fixture'});
  await put('run-bindings',aKey,{run_id:'run-old'});await put('run-terminals',aKey,{native:{output:'old private output'}});
  const attempt=digest({admission:aKey,attempt_seq:2});await put('run-attempts',attempt,{});await put('run-attempt-results',attempt,{});
  const shared='c'.repeat(64),unique='d'.repeat(64),scope=digest({principal_id:'owner',run_id:'run-old'});
  await put('output-journal',digest({scope,seq:0}),{binding:'old-binding',chunks:[{text:'unfinished-private'}],voice:{audio_ref:`audio:${unique}`}});
  await put('output-journal',digest({scope,seq:1}),{binding:'old-binding',voice:{audio_ref:`audio:${shared}`}});
  await put('output-journal',digest('new-output'),{binding:'kept-binding',voice:{audio_ref:`audio:${shared}`}});
  await storage.publish('derived-audio',shared,Buffer.from('shared pcm'));await storage.publish('derived-audio',unique,Buffer.from('old pcm'));
  const laterRaw=`l5:${'e'.repeat(64)}`;await put('processed-events',digest('later-d'),{...d,processed_event_id:'d:later',raw_ref:laterRaw,received_at:CONVERSATION_RESET_CUTOFF});
  const fact=digest('fact');await put('audio-consumer-spans',fact,{capture_span:'not-a-raw-ref',consumer:'media'});
  const options={storage_root:root,storage,removed_raw_refs:[raw],selected_records:[{namespace:'audio-consumer-spans',key:fact}]};
  const plan=await resetIntegrationConversation({...options,apply:true});assert.equal(plan.removed_processed_events.length,1);
  for(const namespace of ['admissions','admission-inputs','run-bindings','run-terminals','run-attempts','run-attempt-results','processed-event-sources','d-session-bindings','audio-consumer-spans'])assert.deepEqual(await storage.list(namespace),[]);
  assert.equal((await storage.list('output-journal')).length,1);assert.deepEqual(await storage.list('derived-audio'),[shared]);
  assert.equal((await storage.list('processed-events')).length,1);
  assert.equal((await resetIntegrationConversation(options)).categories.reduce((sum,c)=>sum+c.delete_count,0),0);
});

test('unknown SQLite schema fails before deleting conversational rows',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-schema-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  CareAuthority.open(join(root,'care')).close();const db=new DatabaseSync(join(root,'care','care.sqlite'));
  db.exec("INSERT INTO timeline VALUES('owner',1,'主人：keep on failure');UPDATE meta SET value='future' WHERE key='schema'");db.close();
  assert.throws(()=>CareAuthority.resetConversation(join(root,'care'),cutoff,true),/RESET_DATABASE_SCHEMA_UNSUPPORTED/u);
  const read=new DatabaseSync(join(root,'care','care.sqlite'),{readOnly:true});assert.equal(read.prepare('SELECT COUNT(*) AS n FROM timeline').get()?.n,1);read.close();
});

test('unknown old ambient sources block the full reset before filesystem deletion',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-unresolved-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);t.after(()=>storage.close());const journal=AmbientJournal.open(join(root,'ambient-journal'));
  journal.append({principal_id:'owner',device_id:'mac',processed_event_id:'d:unknown',raw_ref:raw,archive_revision:'b'.repeat(64),segment_id:'segment'},[{segment_index:0,start_ms:cutoff-2,end_ms:cutoff-1,speaker:'owner',score:null,text:'unknown-source',lang:null,wake:null,wake_cut_ms:null}]);journal.close();
  const options={storage_root:root,storage,removed_raw_refs:[],known_raw_refs:[],selected_records:[]};
  const before=await fs.readFile(join(root,'ambient-journal','journal.sqlite')),preview=await resetIntegrationConversation(options);
  assert.deepEqual(preview.blockers,['ambient_source_unresolved']);assert.equal(preview.categories.find(c=>c.name==='ambient-journal')?.unresolved_sources,1);
  await assert.rejects(resetIntegrationConversation({...options,apply:true}),/RESET_INTEGRATION_SOURCE_UNRESOLVED/u);
  assert.deepEqual(await fs.readFile(join(root,'ambient-journal','journal.sqlite')),before);
});

test('a selected raw source with boundary ambient evidence blocks before any deletion',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-ambient-crossing-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);t.after(()=>storage.close());const journal=AmbientJournal.open(join(root,'ambient-journal'));
  journal.append({principal_id:'owner',device_id:'mac',processed_event_id:'d:crossing',raw_ref:raw,archive_revision:'b'.repeat(64),segment_id:'segment'},[cutoff-1,cutoff].map((end_ms,segment_index)=>({segment_index,start_ms:end_ms-1,end_ms,speaker:'owner',score:null,text:'preserve-crossing',lang:null,wake:null,wake_cut_ms:null})));journal.close();
  const options={storage_root:root,storage,removed_raw_refs:[raw],known_raw_refs:[raw],selected_records:[]};
  const before=await fs.readFile(join(root,'ambient-journal','journal.sqlite')),preview=await resetIntegrationConversation(options);
  assert.deepEqual(preview.blockers,['ambient_source_crosses_cutoff']);assert.equal(preview.categories.find(c=>c.name==='ambient-journal')?.crossing_sources,1);
  await assert.rejects(resetIntegrationConversation({...options,apply:true}),/RESET_INTEGRATION_SOURCE_UNRESOLVED/u);
  assert.deepEqual(await fs.readFile(join(root,'ambient-journal','journal.sqlite')),before);
});

test('fresh planning resumes every interrupted deletion prefix without orphan output or retry records',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-interrupt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);t.after(()=>storage.close());
  const put=async(namespace:string,key:string,value:unknown)=>storage.publish(namespace,key,Buffer.from(JSON.stringify(value)));
  const d={principal_id:'owner',processed_event_id:'d:old',raw_ref:raw,media_type:'text',captured_at:new Date(cutoff-1).toISOString(),received_at:new Date(cutoff-1).toISOString(),content:{text:'old'}};
  const dKey=digest({principal_id:'owner',processed_event_id:'d:old'}),aKey=digest('admission'),scope=digest({principal_id:'owner',run_id:'old-run'}),audio='f'.repeat(64);
  await put('processed-events',dKey,d);await put('processed-event-sources',dKey,{raw_ref:raw});await put('d-session-bindings',dKey,{session_id:'session'});
  await put('admission-inputs',aKey,{d});await put('admissions',aKey,{principal_id:'owner',processed_event_id:'d:old'});await put('run-bindings',aKey,{run_id:'old-run'});
  for(let seq=0;seq<3;seq++)await put('output-journal',digest({scope,seq}),{binding:'same',chunks:[{text:'old'}],...(seq===2?{voice:{audio_ref:`audio:${audio}`}}:{})});
  await storage.publish('derived-audio',audio,Buffer.from('old-wave'));
  for(let count=1;count<4;count++){const key=count===1?aKey:digest({admission:aKey,attempt_seq:count});await put('run-attempts',key,{});await put('run-attempt-results',key,{});}
  const options={storage_root:root,storage,removed_raw_refs:[raw],selected_records:[]};
  const remove=storage.removeOriginals.bind(storage);storage.removeOriginals=async records=>{if(records.length){await remove([records[0]!]);throw Error('INTERRUPTED');}};
  let interruptions=0;
  for(;;){const plan=await resetIntegrationConversation(options);if(!plan.categories.some(c=>c.delete_count))break;
    assert.ok(interruptions++<30);await assert.rejects(resetIntegrationConversation({...options,apply:true}),/INTERRUPTED/u);}
  storage.removeOriginals=remove;assert.ok(interruptions>10);
  for(const namespace of ['processed-events','processed-event-sources','d-session-bindings','admissions','admission-inputs','run-bindings','output-journal','derived-audio','run-attempts','run-attempt-results'])assert.deepEqual(await storage.list(namespace),[],namespace);
  assert.equal((await resetIntegrationConversation({...options,apply:true})).categories.reduce((n,c)=>n+c.delete_count,0),0);
});

test('a later D referring to an old selected raw source is byte-preserved and blocks apply before mutations',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-later-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root);t.after(()=>storage.close());
  const key=digest('later-d'),bytes=Buffer.from(JSON.stringify({principal_id:'owner',processed_event_id:'d:later',raw_ref:raw,media_type:'text',captured_at:new Date(cutoff-1).toISOString(),received_at:CONVERSATION_RESET_CUTOFF,content:{text:'keep later'}}));
  await storage.publish('processed-events',key,bytes);
  const options={storage_root:root,storage,removed_raw_refs:[raw],selected_records:[{namespace:'processed-events',key}]};
  const preview=await resetIntegrationConversation(options);assert.deepEqual(preview.blocked_raw_refs,[raw]);assert.equal(preview.categories.find(c=>c.name==='processed-events')?.delete_count,0);
  await assert.rejects(resetIntegrationConversation({...options,apply:true}),/RESET_D_SOURCE_CROSSES_CUTOFF/u);
  assert.deepEqual(Buffer.from(await storage.read('processed-events',key)),bytes);
});

test('kept new and protected D sourced-speech dependencies block old raw removal',async t=>{
  for(const protectedEvent of [false,true]){
    const root=await fs.mkdtemp(join(tmpdir(),'reset-sourced-evidence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const storage=new PosixStorage(root);t.after(()=>storage.close());
    const old={principal_id:'owner',processed_event_id:'d:old',raw_ref:raw,media_type:'text',captured_at:new Date(cutoff-1).toISOString(),received_at:new Date(cutoff-1).toISOString(),content:{text:'old'}};
    const kept={...old,processed_event_id:'d:kept',raw_ref:`l5:${'e'.repeat(64)}`,received_at:protectedEvent?old.received_at:CONVERSATION_RESET_CUTOFF,
      media_type:protectedEvent?'app_event':'text',content:{app_event:{kind:'owner_confirmation'},text:'retained '.repeat(100000),audio_observations:[{observation_kind:'sourced_speech',text:'retained evidence',evidence:{raw_ref:raw}}]}};
    const oldKey=digest('old-source'),keptKey=digest('kept-source'),oldBytes=Buffer.from(JSON.stringify(old)),keptBytes=Buffer.from(JSON.stringify(kept));
    await storage.publish('processed-events',oldKey,oldBytes);await storage.publish('processed-events',keptKey,keptBytes);
    const options={storage_root:root,storage,removed_raw_refs:[raw],selected_records:[]},preview=await resetIntegrationConversation(options);
    assert.deepEqual(preview.blocked_raw_refs,[raw]);assert.ok(preview.blockers.includes('derivative_source_crosses_cutoff'));
    const counts=preview.categories.find(c=>c.name==='processed-events')!;assert.equal(counts.delete_bytes,oldBytes.length);assert.equal(counts.keep_bytes,keptBytes.length);
    await assert.rejects(resetIntegrationConversation({...options,apply:true}),/RESET_D_SOURCE_CROSSES_CUTOFF/u);
    assert.deepEqual(Buffer.from(await storage.read('processed-events',oldKey)),oldBytes);assert.deepEqual(Buffer.from(await storage.read('processed-events',keptKey)),keptBytes);
  }
});

test('missing D returns a public 404 instead of a storage exception after reset',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'reset-read-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),archive=new RawArchive(storage,8192),native={create:never,status:never,cancel:never};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'fixture'});
  const device={principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'http',consent_ref:'fixture',token_sha256:sha256('fixture-device-token'),route_version:'fixture-route',output_modes:['text']};
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),devices:[device],skill:'fixture',max_read_bytes:8192});
  t.after(async()=>{await runtime.close();await storage.close();});
  await assert.rejects(runtime.event(await runtime.authenticate('fixture-device-token'),'session','d:removed'),(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='D_NOT_FOUND'&&'status' in error&&error.status===404);
});
