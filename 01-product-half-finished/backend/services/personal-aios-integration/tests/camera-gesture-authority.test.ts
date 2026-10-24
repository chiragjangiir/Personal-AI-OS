import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {RegisteredDevice} from '../src/source-authority.ts';
import {CameraCapturePolicies,type CameraFrame} from '../src/visual/store.ts';
import {TerminalCards} from '../src/terminal-cards.ts';
import {PosixStorage} from '../src/storage.ts';
const temporary=tmpdir();
const source={principal_id:'owner',device_id:'glasses',device_type:'glasses',capabilities:['display','camera','wear_state'],route_version:'r1',
  consent_ref:'consent',channel:'formal',output_modes:['text']} as RegisteredDevice;
const frame={frame_id:'f1',captured_at:'2026-10-11T00:00:00.000Z',image:Buffer.from('/9j/2Q==','base64'),
  trigger:'interval',worn:true,private_paused:false} as CameraFrame;
test('capture authority persists pause, keeps admission intervals in memory and serializes overlapping frames',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-camera-policy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let at=100000,consumed=0;const storage=new PosixStorage(root),policy=new CameraCapturePolicies(storage,()=>at);
  await assert.rejects(policy.admit(source,{...frame,worn:false},async()=>++consumed),/NOT_WORN/);
  await assert.rejects(policy.admit(source,{...frame,private_paused:true},async()=>++consumed),/CAPTURE_PAUSED/);
  assert.equal(consumed,0);
  const results=await Promise.allSettled([policy.admit(source,frame,async()=>++consumed),policy.admit(source,{...frame,frame_id:'f2'},async()=>++consumed)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(consumed,1);
  const restarted=new CameraCapturePolicies(storage,()=>at);
  await restarted.admit(source,frame,async()=>++consumed);
  await assert.rejects(restarted.admit(source,frame,async()=>++consumed),/CAPTURE_INTERVAL/);
  at+=30000;await restarted.admit(source,frame,async()=>++consumed);assert.equal(consumed,3);
  policy.reportStatus(source,'unavailable',null);policy.reportStatus({...source,device_id:'other-camera'},'paused',null);
  policy.reportStatus({...source,principal_id:'other-owner'},'error','busy');policy.reportStatus(source,'available',null);
  assert.deepEqual(policy.statusesFor('owner'),[{device_id:'glasses',device_type:'glasses',status:'available',error:null},{device_id:'other-camera',device_type:'glasses',status:'paused',error:null}]);
  assert.deepEqual(restarted.statusesFor('owner'),[],'device reports stay in memory, not in the persisted capture policy');
  await restarted.set(source,{private_paused:true});
  await assert.rejects(new CameraCapturePolicies(storage,()=>at).admit(source,{...frame,trigger:'user_request'},async()=>++consumed),/CAPTURE_PAUSED/);
  await restarted.set(source,{private_paused:false,triggers:['head_dwell']});
  await assert.rejects(restarted.admit(source,{...frame,trigger:'user_request'},async()=>++consumed),/TRIGGER_DENIED/);
  await assert.rejects(restarted.admit(source,{...frame,trigger:'head_dwell'},async()=>++consumed),/CAPTURE_INTERVAL/);
  at+=5000;await restarted.admit(source,{...frame,trigger:'head_dwell'},async()=>++consumed);assert.equal(consumed,4);
});
test('a bound card is consumed after success; failed or overlapping submissions cannot lose or double-use it',async()=>{
  let at=100000;const cards=new TerminalCards(()=>at);cards.connect(source,'session');cards.wear(source,true);
  const submit=async(answer:{text:string})=>answer.text;
  assert.throws(()=>cards.issue(source,[{id:'yes',label:'pay',lines:[]},{id:'no',label:'cancel',lines:[]}],'session',undefined,'payment' as 'ride'),/SCOPE_DENIED/);
  await assert.rejects(cards.answer(source,{card_id:'unissued',kind:'nod'},submit),/CARD_REQUIRED/);
  const card=cards.issue(source,[{id:'yes',label:'是',lines:[]},{id:'no',label:'不是',lines:[]}],'session'),gesture={card_id:card.card_id,kind:'nod' as const};
  await assert.rejects(cards.answer({...source,device_id:'other'},gesture,submit),/CARD_REQUIRED/);
  await assert.rejects(cards.answer(source,gesture,async()=>{throw new Error('submit failed');}),/submit failed/);
  const release=Promise.withResolvers<void>(),answer=cards.answer(source,gesture,async value=>{await release.promise;return value.text;});
  await assert.rejects(cards.answer(source,gesture,submit),/GESTURE_PENDING/);release.resolve();assert.equal(await answer,'是');
  await assert.rejects(cards.answer(source,gesture,submit),/CARD_REQUIRED/);
  const reply=cards.issue(source,[{id:'yes',label:'收到',lines:[]},{id:'no',label:'稍后',lines:[]}],'session');at+=30001;
  await assert.rejects(cards.answer(source,{card_id:reply.card_id,kind:'nod'},submit),/CARD_EXPIRED/);
});
test('choice cards bind option ids, reject ambiguous choices and retain their originating session',async()=>{
  const cards=new TerminalCards(()=>100000);cards.connect(source,'display-session');cards.wear(source,true);
  const options=[{id:'shop-a',label:'同名店',lines:['实付 ¥20']},{id:'shop-b',label:'同名店',lines:['实付 ¥18'],recommended:true}];
  for(const invalid of [options.slice(0,1),[...options,...options,...options],options.map(option=>({...option,id:'duplicate'})),
    options.map(option=>({...option,recommended:true})),options.map(option=>({...option,lines:['1','2','3','4']}))])
    assert.throws(()=>cards.issue(source,invalid,'owner-session'),/OPTIONS_INVALID/);
  assert.throws(()=>cards.issue(source,options,'owner-session',undefined,'ride'),/SCOPE_DENIED/);
  const card=cards.issue(source,options,'owner-session');options[1]!.label='tampered';card.options[1]!.label='also tampered';
  const submit=async(value:{text:string;session:string;owner:boolean})=>value;
  await assert.rejects(cards.answer(source,{card_id:card.card_id,kind:'tap',answer:'unissued'},submit),/GESTURE_INVALID/);
  await assert.rejects(cards.answer(source,{card_id:card.card_id,kind:'nod'},submit),/GESTURE_INVALID/);
  assert.deepEqual(await cards.answer(source,{card_id:card.card_id,kind:'tap',answer:'shop-b'},submit),
    {card: {...card,options:[{id:'shop-a',label:'同名店',lines:['实付 ¥20']},{id:'shop-b',label:'同名店',lines:['实付 ¥18'],recommended:true}]},
      session:'owner-session',owner:false,text:'就选第2项：同名店',answer:'shop-b'});
});
test('policy pause, disable, device privacy and unwear cancel an active model; actual store retains no frame bytes or index',async t=>{
  const {VisualMemory}=await import('../src/visual/store.ts'),{prepareVisualImage}=await import('../src/visual/image.ts');
  const root=await fs.mkdtemp(join(temporary,'capture-pause-'));
  const python=process.env.PAIOS_VISION_PYTHON??'python3';
  const image=(await prepareVisualImage(await fs.readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)),python)).thumbnail;
  let ready=Promise.withResolvers<AbortSignal>(),release=Promise.withResolvers<void>();
  const store=await VisualMemory.open(join(root,'visual'),{embedImage:async(_bytes:Buffer,signal?:AbortSignal)=>{
    assert.ok(signal);ready.resolve(signal);await release.promise;signal.throwIfAborted();return Array(1024).fill(1);
  },embedQuery:async()=>Array(1024).fill(1),describe:async()=>{throw new Error('description must not run after pause');}}, {},undefined,undefined);
  const storage=new PosixStorage(root),policies=new CameraCapturePolicies(storage);
  const archive=new (await import('../src/archive.ts')).RawArchive(storage,32*1024*1024);store.bindArchive(archive);
  t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
  for(const stop of ['pause','disable','device_private','unwear']){
    await policies.set(source,{enabled:true,private_paused:false});ready=Promise.withResolvers<AbortSignal>();release=Promise.withResolvers<void>();
    const activeFrame={...frame,frame_id:stop,image,trigger:'user_request' as const};
    const event=await archive.archive({schema_version:'paios.event.v1',event_id:stop,device_id:source.device_id,device_type:'glasses',captured_at:activeFrame.captured_at,
      source:{channel:source.channel},media_type:'visual',mime:'image/jpeg',representation:'uploaded_original',payload:image},{...source,submission:'observation'});
    const active=policies.admit(source,activeFrame,signal=>store.ingest(source.principal_id,source.device_id,activeFrame,undefined,signal,event));
    const signal=await ready.promise;
    const change=stop==='pause'||stop==='disable'?policies.set(source,stop==='pause'?{private_paused:true}:{enabled:false}):
      policies.admit(source,{...activeFrame,private_paused:stop==='device_private',worn:stop!=='unwear'},async()=>{throw new Error('paused frame consumed');});
    assert.equal(signal.aborted,true);
    if(stop==='pause'||stop==='disable')await change;else await assert.rejects(change,/CAPTURE_PAUSED|NOT_WORN/);
    release.resolve();await assert.rejects(active,/CAPTURE_PAUSED|NOT_WORN/);
    assert.deepEqual((await store.recall(source.principal_id,{})).frames,[]);assert.deepEqual(await fs.readdir(join(root,'visual','frames')),[]);

  }
});

for(const indexed of [false,true])test(`glasses capture archives authenticated JPEG with visual index ${indexed} and rejects privacy before archive`,async t=>{
  const {VisualMemory}=await import('../src/visual/store.ts'),{prepareVisualImage}=await import('../src/visual/image.ts');
  const {RawArchive}=await import('../src/archive.ts'),{OutputAuthority}=await import('../src/output.ts');
  const {PersonalAIOSRuntime,RunAdmission,sourceClient}=await import('./native-source-fixture.ts');
  const {digest,sha256}=await import('../src/contracts.ts');
  const root=await fs.mkdtemp(join(temporary,'glasses-l5-')),storage=new PosixStorage(root),archive=new RawArchive(storage,4096);
  const image=(await prepareVisualImage(await fs.readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)))).thumbnail;
  const store=indexed?await VisualMemory.open(join(root,'visual'),{embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'camera',ocr:''})}):undefined;
  const native=sourceClient({create:async()=>{throw new Error('no agent run');},status:async()=>{throw new Error('no agent run');},cancel:async()=>{throw new Error('no agent run');}}),token='glasses-archive-fixture-token';
  const runtime=new PersonalAIOSRuntime({storage,archive,native,...(store?{visual_memory:store}:{}),output:new OutputAuthority(storage),
    devices:[{principal_id:'owner',device_id:'glasses',device_type:'glasses',channel:'formal',consent_ref:'camera-consent',route_version:'r1',output_modes:['text'],capabilities:['camera','display','wear_state'],token_sha256:sha256(token)}],
    admission:new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'visual'}),skill:'fixture',max_read_bytes:4096});
  t.after(async()=>{await runtime.close();await store?.close();await fs.rm(root,{recursive:true,force:true});});
  const device=await runtime.authenticate(token);await runtime.watchCare(device,async()=>true,undefined,undefined,undefined,undefined,undefined,{session:'camera',deliver:async()=>{}});await runtime.wearState(device,true);
  const at=Date.now(),frame=(id:string,n:number)=>({frame_id:id,captured_at:new Date(at+n).toISOString(),image,trigger:'user_request' as const,worn:true,private_paused:false});
  assert.equal((await runtime.ingestVisualFrame(device,frame('first',0),'camera')).status,'kept');
  assert.equal((await runtime.ingestVisualFrame(device,frame('near',1),'camera')).status,'kept');
  for(const id of ['first','near']){
    const rawRef=`l5:${digest({principal_id:'owner',event_id:`visual:${digest(['glasses',id])}`})}`,event=await archive.locate(rawRef,'owner');
    assert.equal(event.device_type,'glasses');assert.equal(event.source.channel,'formal');assert.equal(event.consent_ref,'camera-consent');assert.equal(event.mime,'image/jpeg');
    assert.deepEqual(await archive.read(rawRef,'owner',event.archive_revision),image);
  }
  await assert.rejects(runtime.ingestVisualFrame(device,{...frame('private',2),private_paused:true},'camera'),/CAMERA_CAPTURE_PAUSED/);
  assert.equal((await storage.list('manifests')).length,2);
  if(store){
    const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),original=archive.archive.bind(archive);
    const stalled=t.mock.method(archive,'archive',async(...args:Parameters<typeof archive.archive>)=>{started.resolve();await release.promise;return original(...args);});
    const active=runtime.ingestVisualFrame(device,frame('pre-publication',3),'camera'),rejected=assert.rejects(active,/VISUAL_DELETED/);
    await started.promise;let completed=false;
    const deleting=store.deleteRange('owner',{from:new Date(at+3).toISOString(),until:new Date(at+4).toISOString()}).then(value=>{completed=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false,'range deletion waits for admitted archive cleanup');
    release.resolve();assert.equal((await deleting).status,'deleted');await rejected;stalled.mock.restore();
    const ref=`l5:${digest({principal_id:'owner',event_id:`visual:${digest(['glasses','pre-publication'])}`})}`;
    await assert.rejects(archive.locate(ref,'owner'),/RAW_DELETED/);
    assert.equal((await store.recall('owner',{})).frames.length,2);
  }
});

test('a reason repeated within its window reaches the owner once, in words he can read',async t=>{
  const {RawArchive}=await import('../src/archive.ts'),{OutputAuthority}=await import('../src/output.ts');
  const {PersonalAIOSRuntime,RunAdmission,sourceClient}=await import('./native-source-fixture.ts'),{sha256}=await import('../src/contracts.ts');
  const root=await fs.mkdtemp(join(temporary,'archive-alert-window-')),storage=new PosixStorage(root),token='owner-app-alert-window';
  const run={run_id:'unused-run',session_id:'session',conversation_session_id:'session',status:'running'};
  const native=sourceClient({create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'alert-window'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,4096),native,output:new OutputAuthority(storage),
    devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'formal',consent_ref:'owner-consent',route_version:'r1',output_modes:['text'],token_sha256:sha256(token)}],
    admission,skill:'fixture',max_read_bytes:4096});
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const device=await runtime.authenticate(token),messages:string[]=[];
  const stop=await runtime.watchCare(device,async(_id:string,text:string)=>{messages.push(text);return 'pending' as const;});
  await Promise.all(Array.from({length:24},()=>runtime.archiveAlert('FORMAL_PCM_APPEND_BACKLOG','owner')));
  await runtime.archiveAlert('FORMAL_PCM_APPEND_BACKLOG','owner');
  assert.equal((await storage.list('archive-alerts')).length,1);assert.equal(messages.length,1,'one notice per reason window');
  assert.match(messages[0]!,/原始录音没有存上/);assert.doesNotMatch(messages[0]!,/FORMAL_PCM/);
  await runtime.archiveAlert('L5_DISK_RESERVE_EMERGENCY','owner');assert.equal(messages.length,2,'another reason is its own notice');
  stop();
});

test('archive alerts persist offline and drain through owner app conversation once on reconnect',async t=>{
  const {RawArchive}=await import('../src/archive.ts'),{OutputAuthority}=await import('../src/output.ts');
  const {PersonalAIOSRuntime,RunAdmission,sourceClient}=await import('./native-source-fixture.ts'),{sha256}=await import('../src/contracts.ts');
  const root=await fs.mkdtemp(join(temporary,'archive-alert-')),storage=new PosixStorage(root),token='owner-app-alert-fixture';
  const run={run_id:'owner-delete-run',session_id:'session',conversation_session_id:'session',status:'running'},created=Promise.withResolvers<void>();
  const native=sourceClient({create:async()=>{created.resolve();return run;},status:async()=>run,cancel:async()=>({...run,status:'cancelled'})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'alert'});
  let bark=0;const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,4096),native,output:new OutputAuthority(storage),
    notify:async()=>{bark++;},devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',channel:'formal',consent_ref:'owner-consent',route_version:'r1',output_modes:['text'],token_sha256:sha256(token)}],
    admission,skill:'fixture',max_read_bytes:4096});
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await runtime.archiveAlert('disk reserve exhausted','owner');assert.equal((await storage.list('archive-alerts')).length,1);
  const device=await runtime.authenticate(token),messages:{id:string;text:string}[]=[];
  const show=async(id:string,text:string)=>{messages.push({id,text});return 'pending' as const;};
  const stop=await runtime.watchCare(device,show);assert.equal(messages.length,1);assert.match(messages[0]!.text,/disk reserve exhausted/);stop();
  const reconnected=await runtime.watchCare(device,show);assert.equal(messages.length,1);reconnected();assert.equal(bark,0);
  const raw={schema_version:'paios.event.v1' as const,event_id:'delete-file',device_id:'phone',device_type:'phone' as const,captured_at:new Date().toISOString(),
    source:{channel:'formal'},media_type:'file' as const,mime:'application/octet-stream',representation:'uploaded_original' as const,payload:Buffer.from('owner file')};
  const file=await runtime.archiveUpload(raw,device),{captured_at:_capture,...unknown}=raw;
  const q=await runtime.existingArchive().archiveUnknownClock({...unknown,event_id:'unknown-original',media_type:'audio',mime:'audio/pcm',captured_at:null,capture_clock_status:'unknown'},
    {...device,submission:'observation'},{track_id:'mic',stream_epoch:'unknown',seq:0,modality:'audio',format:'pcm_s16le:16000:1',
      source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'unknown',start_ms:0,end_ms:100}},{fixture:'known-receive-permission'});
  const submitted=await runtime.submit({...raw,event_id:'delete-request',media_type:'text',mime:'text/plain;charset=utf-8',payload:Buffer.from('删除这个文件')},device,'session',true);
  await created.promise;
  for(let n=0;n<100&&!(await admission.getAsync('owner','session',submitted.processed_event.processed_event_id))?.run_id;n++)await new Promise(resolve=>setTimeout(resolve,5));
  await storage.replace('objects',file.payload_sha256,Buffer.from('corrupt original bytes'));
  assert.deepEqual(await runtime.tool('paios_visual_delete',{context:{run_id:run.run_id,session_id:'session',tool_call_id:'delete-exact'},args:{raw_refs:[file.raw_ref,q.quarantine_ref]}}),{status:'deleted'});
  await assert.rejects(runtime.existingArchive().read(file.raw_ref,'owner',file.archive_revision),/RAW_DELETED/);
  await assert.rejects(runtime.existingArchive().readUnknownClock(q.quarantine_ref,'owner',q.archive_revision),/RAW_DELETED/);
  const live=await runtime.watchCare(device,show),failure=Object.assign(new Error('fixture disk full'),{code:'ENOSPC'});
  const meta=t.mock.method(storage,'publishIngressMeta',async()=>{throw failure;}),errors:unknown[][]=[];
  const logger=t.mock.method(console,'error',(...args:unknown[])=>{errors.push(args);});
  await assert.rejects(runtime.archiveAlert('capture paused','owner'),error=>error===failure);
  assert.equal(messages.length,2,'actual app outreach still runs when metadata persistence fails');
  assert.match(messages[1]!.text,/capture paused/);assert.equal(errors[0]![0],'ARCHIVE_ALERT_PERSISTENCE_FAILED');assert.equal(bark,0);
  meta.mock.restore();logger.mock.restore();live();
});
