import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PhotoRequests} from '../src/photo-request.ts';
import {PersonalAIOSRuntime,RunAdmission,sourceClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,sha256,ContractError} from '../src/contracts.ts';
import {MAC_CAPABILITIES,GLASSES_CAPABILITIES,PHONE_CAPABILITIES} from '../src/source-authority.ts';
import {VisualMemory} from '../src/visual/store.ts';
import {prepareVisualImage} from '../src/visual/image.ts';

test('photo correlation releases on timeout, publication failure and close',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=new PhotoRequests();let frame='';
  const timed=requests.capture('glasses',async id=>{frame=id;}),failed=assert.rejects(timed,/CAMERA_REQUEST_TIMEOUT/);
  assert.equal(requests.expects('other',frame),false);requests.observed('other',frame,{status:'wrong'});
  await assert.rejects(requests.capture('glasses',async()=>{}),/CAMERA_REQUEST_BUSY/);
  t.mock.timers.tick(20000);await failed;assert.equal(requests.expects('glasses',frame),false);
  await assert.rejects(requests.capture('glasses',async()=>{throw new Error('disconnect');}),/disconnect/);
  const local=requests.capture('glasses',async id=>{frame=id;}),denied=assert.rejects(local,/CAMERA_CAPTURE_UNAVAILABLE/);
  requests.failed('other',frame,new Error('wrong device'));assert.equal(requests.expects('glasses',frame),true);
  requests.failed('glasses','other-frame',new Error('wrong frame'));assert.equal(requests.expects('glasses',frame),true);
  requests.failed('glasses',frame,new Error('CAMERA_CAPTURE_UNAVAILABLE'));await denied;
  const pending=requests.capture('glasses',async()=>{}),closed=assert.rejects(pending,/RUNTIME_CLOSED/);
  requests.close();await closed;await assert.rejects(requests.capture('glasses',async()=>{}),/RUNTIME_CLOSED/);
});

test('photo tool waits for requested upload and archived bytes; privacy pause prevents capture',async t=>{
  const root=await mkdtemp(join(tmpdir(),'paios-photo-')),storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
  const run={run_id:'photo-run',session_id:'owner-session',conversation_session_id:'owner-session',status:'running'};
  const native=sourceClient({create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})});
  let slow=false;const embeddingStarted=Promise.withResolvers<void>(),releaseEmbedding=Promise.withResolvers<void>();
  const visual=await VisualMemory.open(join(root,'visual'),{embedImage:async()=>{if(slow){embeddingStarted.resolve();await releaseEmbedding.promise;}return Array(1024).fill(1);},embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'当前照片',ocr:''})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'photo-test'});
  const runtime=new PersonalAIOSRuntime({storage,archive,native,admission,visual_memory:visual,output:new OutputAuthority(storage),skill:'fixture',max_read_bytes:8192,
    devices:[['mac','mac',MAC_CAPABILITIES],['glasses','glasses',GLASSES_CAPABILITIES]].map(([device_id,device_type,capabilities])=>({
      principal_id:'owner',device_id,device_type,capabilities,channel:'formal',consent_ref:'consent',route_version:'r1',output_modes:['text'],token_sha256:sha256(String(device_id))})) as never});
  t.after(async()=>{await runtime.close();await visual.close();await rm(root,{recursive:true,force:true});});
  const mac=await runtime.authenticate('mac'),glasses=await runtime.authenticate('glasses');let frame='',captures=0;
  t.after(await runtime.watchCare(glasses,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'camera',deliver:async()=>{},captureOnce:async id=>{frame=id;captures++;}}));
  await runtime.wearState(glasses,true);
  await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'request-photo',device_id:'mac',device_type:'mac',captured_at:new Date().toISOString(),
    source:{channel:'formal'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('拍张眼前照片')},mac,'owner-session',true);
  for(let n=0;!admission.find('photo-run')&&n<200;n++)await new Promise(r=>setTimeout(r,5));
  const tool=()=>runtime.tool('paios_senses',{context:{run_id:'photo-run',session_id:'owner-session',tool_call_id:'photo'},args:{sense:'glasses_photo'}});
  t.mock.timers.enable({apis:['setTimeout']});
  let settled=false;const result=tool().then(value=>{settled=true;return value;});
  const deadline=Date.now()+2000;while(!frame&&Date.now()<deadline)await new Promise(r=>setImmediate(r));assert.ok(frame);
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)))).thumbnail,upload=(id:string)=>runtime.ingestVisualFrame(glasses,{frame_id:id,captured_at:new Date().toISOString(),
    image,trigger:'user_request',worn:true,private_paused:false},'camera');
  await upload('unrelated');assert.equal(settled,false);
  slow=true;const indexing=upload(frame);await embeddingStarted.promise;
  t.mock.timers.tick(20001);await new Promise(r=>setImmediate(r));assert.equal(settled,false,'archived photo uses the existing model deadline instead of the acquisition timeout');
  releaseEmbedding.resolve();assert.equal((await indexing).status,'kept');
  const observed=await result as {status:string;frame_id:string;visual_frame_id:string;raw_ref:string;archive_revision:string};t.mock.timers.reset();
  assert.equal(observed.status,'observed');assert.equal(observed.frame_id,frame);
  assert.deepEqual(await archive.read(observed.raw_ref,'owner',observed.archive_revision),image);
  assert.ok(observed.visual_frame_id);assert.notEqual(observed.visual_frame_id,observed.frame_id);
  t.mock.method(native,'analyzeVision',async(bytes:Buffer)=>{assert.deepEqual(bytes,image);return '看到了当前照片';});
  assert.equal(await runtime.tool('paios_visual_analyze',{context:{run_id:'photo-run',session_id:'owner-session',tool_call_id:'analyze-photo'},
    args:{frame_id:observed.visual_frame_id,question:'眼前是什么？',full:true}}),'看到了当前照片');
  await runtime.setCameraPrivatePause(glasses,true);
  assert.deepEqual(await tool(),{status:'unavailable',error_code:'CAMERA_CAPTURE_PAUSED'});assert.equal(captures,1);
  await runtime.setCameraPrivatePause(glasses,false);frame='';settled=false;
  const deleted=tool().then(value=>{settled=true;return value;}),failed=assert.rejects(deleted,/RAW_DELETED/);
  for(let n=0;!frame&&n<200;n++)await new Promise(r=>setTimeout(r,5));assert.ok(frame);
  const original=archive.archive.bind(archive);
  t.mock.method(archive,'archive',async(...args:Parameters<typeof archive.archive>)=>{
    const archived=await original(...args);await archive.delete(archived.raw_ref,'owner');return archived;
  });
  await assert.rejects(upload(frame),/RAW_DELETED/);assert.equal(settled,false,'a deleted archive cannot fulfill the photo request');
  await failed;await runtime.close();
});


test('inactive photo retains correlation until resumed capture or expiry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=new PhotoRequests();let frame='',published=0,completed:Record<string,unknown>|undefined;
  const capture=requests.capture('phone',async id=>{frame=id;published++;},async result=>{completed=result;});
  requests.inactive('other',frame);requests.inactive('phone',frame);
  assert.deepEqual(await capture,{status:'unavailable',error_code:'CAMERA_APP_INACTIVE',frame_id:frame,pending:true});
  await assert.rejects(requests.capture('phone',async()=>{}),/CAMERA_REQUEST_BUSY/);
  await requests.resume('phone');assert.equal(published,2);
  requests.archived('phone',frame);await requests.resume('phone');assert.equal(published,2);
  await requests.observed('phone',frame,{status:'observed',frame_id:frame});
  assert.deepEqual(completed,{status:'observed',frame_id:frame});assert.equal(requests.expects('phone',frame),false);
  const expiring=requests.capture('phone',async id=>{frame=id;published++;});requests.inactive('phone',frame);await expiring;
  t.mock.timers.tick(20000);assert.equal(requests.expects('phone',frame),false);
  await requests.observed('phone',frame,{status:'late'});assert.equal(completed?.status,'observed');
  await requests.resume('phone');assert.equal(published,3);assert.equal(requests.expects('phone',frame),false);requests.close();
});

for(const initial of ['inactive','offline','unseen'])test(`${initial} phone camera reconnects into original Mac session with protected owner lineage and vision`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'paios-phone-photo-')),storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
  const run={run_id:'phone-photo-run',session_id:'owner-session',conversation_session_id:'owner-session',status:'running'};
  let created=0;const runs=new Map<string,typeof run>();
  const native=sourceClient({create:async body=>{const value={...run,session_id:body.session_id,conversation_session_id:body.session_id,run_id:created++===0?run.run_id:created===2?'phone-completion-run':'phone-guest-run'};runs.set(value.run_id,value);return value;},status:async id=>runs.get(id)!,cancel:async id=>({...runs.get(id)!,status:'cancelled'})});
  const visual=await VisualMemory.open(join(root,'visual'),{embedImage:async()=>Array(1024).fill(1),embedQuery:async()=>Array(1024).fill(1),describe:async()=>({caption:'phone photograph',ocr:''})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'phone-photo-test'});
  let inventoryReads=0,inventoryAvailable=initial!=='offline';
  const runtime=new PersonalAIOSRuntime({storage,archive,native,admission,visual_memory:visual,output:new OutputAuthority(storage),skill:'fixture',max_read_bytes:8192,
    ...(initial!=='inactive'?{payment_devices:async(principal:string)=>{inventoryReads++;assert.equal(principal,'owner');return inventoryAvailable?[{principal_id:'owner',device_id:'phone',device_type:'phone' as const,capabilities:PHONE_CAPABILITIES,channel:'paired_inventory',consent_ref:'consent',route_version:'paired-route',output_modes:['text']}]:[];}}:{}),
    devices:[['mac','mac',MAC_CAPABILITIES],['phone','phone',PHONE_CAPABILITIES]].map(([device_id,device_type,capabilities])=>({
      principal_id:'owner',device_id,device_type,capabilities,channel:'formal',consent_ref:'consent',route_version:'r1',output_modes:['text'],token_sha256:sha256(String(device_id))})) as never});
  t.after(async()=>{await runtime.close();await visual.close();await rm(root,{recursive:true,force:true});});
  const mac=await runtime.authenticate('mac');let phone!:Awaited<ReturnType<typeof runtime.authenticate>>;
  if(initial!=='unseen')phone=await runtime.authenticate('phone');
  let frame='',camera:string|undefined,completion:any,expires:number|undefined;
  const attach=()=>runtime.watchCare(phone,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'phone-session',captureOnce:async(id,position,deadline)=>{frame=id;camera=position;expires=deadline;await runtime.cameraCaptureFailed(phone,id,new ContractError('CAMERA_APP_INACTIVE',409));}});
  const stopPhone=initial==='inactive'?await attach():undefined;
  t.after(await runtime.watchCare(mac,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'owner-session',event:async accepted=>{completion=accepted;}}));
  const raw=(event_id:string,payload:Buffer,media_type:'text'|'app_event'='text')=>({schema_version:EVENT_SCHEMA,event_id,device_id:'mac',device_type:'mac' as const,
    captured_at:new Date().toISOString(),source:{channel:'formal'},media_type,mime:media_type==='text'?'text/plain;charset=utf-8':'application/json',representation:'uploaded_original' as const,payload});
  const request=await runtime.submit(raw('request-phone-photo',Buffer.from('用手机后摄看看')),mac,'owner-session',true);
  for(let n=0;!admission.find(run.run_id)&&n<200;n++)await new Promise(r=>setTimeout(r,5));
  const context={run_id:run.run_id,session_id:'owner-session',tool_call_id:'phone-photo'};
  if(initial==='offline'){
    assert.deepEqual(await runtime.tool('paios_senses',{context,args:{sense:'phone_camera'}}),{status:'unavailable',error_code:'PHONE_CAMERA_NOT_CONNECTED'});
    inventoryAvailable=true;
  }
  const pending=await runtime.tool('paios_senses',{context,args:{sense:'phone_camera'}});
  const requested=(pending as {frame_id:string}).frame_id,originalExpiry=expires;
  assert.deepEqual(pending,{status:'unavailable',error_code:initial==='inactive'?'CAMERA_APP_INACTIVE':'PHONE_CAMERA_NOT_CONNECTED',frame_id:requested,pending:true});
  if(initial!=='inactive')assert.equal(frame,'');
  if(initial==='unseen'){assert.equal(inventoryReads,1);phone=await runtime.authenticate('phone');}
  stopPhone?.();t.after(await attach());
  if(initial!=='inactive')assert.equal(frame,'','attachment alone cannot replay before formal readiness');
  await runtime.cameraReady(phone);
  assert.equal(frame,requested);assert.equal(camera,'back');assert.ok(expires!>Date.now());
  if(originalExpiry!==undefined)assert.equal(expires,originalExpiry);
  runs.get(run.run_id)!.status='completed';
  for(let n=0;admission.find(run.run_id)&&n<200;n++)await new Promise(r=>setTimeout(r,5));
  assert.equal(admission.find(run.run_id),undefined,'the original run is retired before the camera result arrives');
  const forged={kind:'camera_result',principal_id:'owner',job_id:`camera:${frame}`,origin_processed_event_id:request.processed_event.processed_event_id};
  await assert.rejects(runtime.submit(raw('forged-completion',Buffer.from(JSON.stringify(forged)),'app_event'),mac,'owner-session',false),/ERRAND_REPLAY_CONFLICT/);
  const image=(await prepareVisualImage(await readFile(new URL('fixtures/continuous-coverage-rgba2x1.png',import.meta.url)))).thumbnail;
  await assert.rejects(runtime.ingestVisualFrame(phone,{frame_id:'unrequested',captured_at:new Date().toISOString(),image,trigger:'user_request',worn:false,private_paused:false},'phone-session'),/CAMERA_REQUEST_REQUIRED/);
  await runtime.ingestVisualFrame(phone,{frame_id:frame,captured_at:new Date().toISOString(),image,trigger:'user_request',worn:false,private_paused:false},'phone-session');
  assert.equal(completion.processed_event.device_id,'mac');assert.equal(completion.admission.session_id,'owner-session');
  const app=completion.processed_event.content.app_event;assert.equal(app.kind,'camera_result');assert.equal(app.frame_id,frame);assert.ok(app.visual_frame_id);
  t.mock.method(native,'analyzeVision',async(bytes:Buffer)=>{assert.deepEqual(bytes,image);return 'phone content';});
  const completedRun='phone-completion-run';assert.notEqual(completedRun,run.run_id);
  for(let n=0;!admission.find(completedRun)&&n<200;n++)await new Promise(r=>setTimeout(r,5));
  assert.equal(await runtime.tool('paios_visual_analyze',{context:{run_id:completedRun,session_id:'owner-session',tool_call_id:'view-phone'},args:{frame_id:app.visual_frame_id,question:'照片是什么',full:true}}),'phone content');
  await runtime.submit(raw('guest-photo',Buffer.from(JSON.stringify({kind:'voice_turn',speaker:'other',user:'拍照'})),'app_event'),mac,'guest-session',false);
  for(let n=0;!admission.find('phone-guest-run')&&n<200;n++)await new Promise(r=>setTimeout(r,5));
  await assert.rejects(runtime.tool('paios_senses',{context:{run_id:'phone-guest-run',session_id:'guest-session',tool_call_id:'guest-photo'},args:{sense:'phone_camera'}}),/RUN_SCOPE_TOOL_DENIED/);
  const front=await runtime.tool('paios_senses',{context:{run_id:completedRun,session_id:'owner-session',tool_call_id:'front-photo'},args:{sense:'phone_camera',camera:'front'}});
  assert.equal(camera,'front');assert.equal((front as {pending:boolean}).pending,true);
});
