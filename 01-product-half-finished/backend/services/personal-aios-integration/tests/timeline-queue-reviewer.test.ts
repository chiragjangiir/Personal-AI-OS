import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PersonalAIOSRuntime,RunAdmission,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {OutputAuthority} from '../src/output.ts';
import {MAC_CAPABILITIES,PHONE_CAPABILITIES,sourceSnapshot,type RegisteredDevice} from '../src/source-authority.ts';
import {EVENT_SCHEMA,ContractError,digest,principalAttribution,runScope,ownerActionGrant,type RawEvent} from '../src/contracts.ts';

const policy={max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'review'};
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'queue-review-')),storage=new PosixStorage(root),created:any[]=[],requests:{grant_toolsets?:string[]}[]=[],runs=new Map<string,NativeRun>(),issued=new WeakSet<RegisteredDevice>(),revoked=new Set<string>();
  const sourceAuthority={scheduled:async()=>{
    const source=sourceSnapshot({principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:PHONE_CAPABILITIES,channel:'background_scheduled',consent_ref:'consent',route_version:'route-phone',output_modes:['text']});issued.add(source);return source;
  },authenticate:async(credential:unknown)=>{
    const device_id=String(credential),device_type=device_id==='phone'?'phone':'mac';
    const source=sourceSnapshot({principal_id:'owner',device_id,device_type,capabilities:device_type==='mac'?MAC_CAPABILITIES:PHONE_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:`route-${device_id}`,output_modes:['text']});
    issued.add(source);return source;
  },revalidate:async(source:RegisteredDevice)=>{assert.ok(issued.has(source),'SOURCE_PROVENANCE_REQUIRED');if(revoked.has(source.device_id))throw new ContractError('SOURCE_REVOKED',403);return source;}};
  const native={create:async(body:{session_id:string;input:string;grant_toolsets?:string[]})=>{requests.push(body);created.push(JSON.parse(body.input));const run={run_id:`run-${created.length}`,conversation_session_id:body.session_id,session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},status:async(id:string)=>runs.get(id)!,cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'})};
  let admission:RunAdmission;
  const open=async()=>{const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:admission=new RunAdmission(storage,native,policy),native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority,skill:'fixed',max_read_bytes:8192});await runtime.configureTimeline({directory:join(root,'timeline')});return runtime;};
  let runtime=await open();t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const reopen=async()=>{await runtime.close();runtime=await open();return runtime;};
  const raw=(source:RegisteredDevice,id:string):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:id,device_id:source.device_id,device_type:source.device_type,captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('owner request')});
  return {root,storage,runtime,reopen,created,requests,runs,revoked,raw,get admission(){return admission;}};
}
async function until(fn:()=>boolean){const deadline=Date.now()+3000;while(!fn()){assert.ok(Date.now()<deadline,'native create did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}


test('R2 original revoked-source probe: no new admission, then valid source records its own device',async t=>{
  const f=await fixture(t),old=await f.runtime.authenticate('mac-old');
  const row=f.runtime.timeline!.queue('owner','origin',{action:'add',task:'sort invoices'},{run_id:'fixture',session_id:'fixture',tool_call_id:'add',source_at_ms:Date.now()}) as {queue_id:string};
  const publish=f.storage.publish.bind(f.storage);let interrupt=true;
  f.storage.publish=async(namespace,key,bytes)=>{const saved=await publish(namespace,key,bytes);if(interrupt&&namespace==='processed-events'){interrupt=false;throw Error('interrupted before admission');}return saved;};
  await assert.rejects(f.runtime.desktopReady(old),/interrupted before admission/);assert.equal(f.created.length,0);f.storage.publish=publish;
  const runtime=await f.reopen(),currentOld=await runtime.authenticate('mac-old'),stop=await runtime.watchCare(currentOld,async()=>false);t.after(stop);
  f.revoked.add('mac-old');await assert.rejects(runtime.submit(f.raw(old,'must-deny'),old,'denied-session',true),/SOURCE_REVOKED/);
  await runtime.desktopReady(await runtime.authenticate('mac-new'));assert.equal(f.created.length,0);
  const read=()=>{const db=new DatabaseSync(join(f.root,'timeline/timeline.sqlite'),{readOnly:true});try{return {...db.prepare('SELECT admitted_device_id,state FROM desktop_queue WHERE queue_id=?').get(row.queue_id)};}finally{db.close();}};
  assert.deepEqual(read(),{admitted_device_id:null,state:'pending'});
  f.revoked.delete('mac-old');await runtime.desktopReady(await runtime.authenticate('mac-new'));await until(()=>f.created.length===1);
  assert.equal(f.created[0].device_id,'mac-old');assert.deepEqual(read(),{admitted_device_id:'mac-old',state:'admitted'});
});

for(const removeOrigin of [false,true])test(`queued recovery resolves durable owner origin (${removeOrigin?'removed':'retained'}) before granting`,async t=>{
  const f=await fixture(t),phone=await f.runtime.authenticate('phone');
  const accepted=await f.runtime.submit(f.raw(phone,'recovery-owner'),phone,'recovery-owner',true);
  const origin=accepted.processed_event.processed_event_id;
  await until(()=>!!f.admission.get('owner','recovery-owner',origin)?.run_id);
  const run_id=f.admission.get('owner','recovery-owner',origin)!.run_id!;
  await f.runtime.tool('paios_desktop_queue',{context:{run_id,session_id:'recovery-owner',tool_call_id:'recovery-add'},args:{action:'add',task:'recover owner work'}});
  const publish=f.storage.publish.bind(f.storage);let interrupt=true;
  f.storage.publish=async(namespace,key,bytes)=>{const saved=await publish(namespace,key,bytes);
    if(interrupt&&namespace==='processed-events'){interrupt=false;throw Error('interrupt queued D before admission');}return saved;};
  await assert.rejects(f.runtime.desktopReady(await f.runtime.authenticate('mac')),/interrupt queued D/);
  f.storage.publish=publish;assert.equal(f.requests.length,1);
  if(removeOrigin)await f.storage.removeOriginals([{namespace:'processed-events',key:digest({principal_id:'owner',processed_event_id:origin})}]);
  const runtime=await f.reopen();
  await runtime.desktopReady(await runtime.authenticate('mac'));await until(()=>f.requests.length===2);
  assert.deepEqual(f.requests[1]!.grant_toolsets,removeOrigin?['desktop']:['desktop','terminal','file']);
  assert.equal(f.created[1].content.app_event.kind,'desktop_queue_task');
});

test('R2 original duplicate tool-call probe: same ID creates one queue run and conflicting task/TTL rejected',async t=>{
  const f=await fixture(t),phone=await f.runtime.authenticate('phone'),accepted=await f.runtime.submit(f.raw(phone,'owner'),phone,'owner-session',true);
  await until(()=>!!f.admission.get('owner','owner-session',accepted.processed_event.processed_event_id)?.run_id);
  const run_id=[...f.runs.values()].find(run=>run.conversation_session_id==='owner-session')!.run_id;
  const call={context:{run_id,session_id:'owner-session',tool_call_id:'same-tool-call'},args:{action:'add',task:'sort invoices'}};
  const first=await f.runtime.tool('paios_desktop_queue',call) as {queue_id:string},second=await f.runtime.tool('paios_desktop_queue',call) as {queue_id:string};
  assert.equal(first.queue_id,second.queue_id);
  for(const args of [{...call.args,task:'different task'},{...call.args,expires_in_minutes:1}])await assert.rejects(f.runtime.tool('paios_desktop_queue',{...call,args}),/DESKTOP_QUEUE_TOOL_CALL_CONFLICT/);
  await f.runtime.desktopReady(await f.runtime.authenticate('mac'));await until(()=>f.created.length===2);
  assert.equal(f.created[1].content.app_event.queue_id,first.queue_id);
  assert.deepEqual(f.requests[1]!.grant_toolsets,['desktop','terminal','file']);
  const db=new DatabaseSync(join(f.root,'timeline/timeline.sqlite'),{readOnly:true});
  const row=db.prepare('SELECT origin_processed_event_id FROM desktop_queue WHERE queue_id=?').get(first.queue_id);db.close();
  assert.equal(row?.origin_processed_event_id,accepted.processed_event.processed_event_id);
  console.log(JSON.stringify({ownerOriginPreserved:true,queuedDIdentity:f.created[1].user_identity,queuedDOrigin:f.created[1].origin}));
});

test('A4 conformance: an unattributed observation cannot mint an owner-created desktop queue run',async t=>{
  const f=await fixture(t),phone=await f.runtime.authenticate('phone'),raw=f.raw(phone,'unattributed');
  raw.media_type='app_event';raw.mime='application/json';raw.payload=Buffer.from(JSON.stringify({kind:'device_status',text:'ambient observation'}));
  const accepted=await f.runtime.submit(raw,phone,'observation-session',false),d=accepted.processed_event;
  assert.equal(d.user_identity,'unknown');assert.equal(principalAttribution(d),null);assert.equal(runScope(d),'owner');
  await until(()=>!!f.admission.get('owner','observation-session',d.processed_event_id)?.run_id);
  const run_id=[...f.runs.values()].find(run=>run.conversation_session_id==='observation-session')!.run_id;
  const call={context:{run_id,session_id:'observation-session',tool_call_id:'observation-queue-add'},args:{action:'add',task:'move owner invoices'}};
  await assert.rejects(f.runtime.tool('paios_desktop_queue',call),/DESKTOP_QUEUE_OWNER_REQUIRED/);
  assert.equal(f.created.length,1);
});

// Retained delivery-to-grant reviewer chain: scheduled work must resolve a durable eligible origin.
for(const origin of ['explicit','observation','missing'])test(`scheduled grants resolve ${origin} origin and schedule mutation uses the same authority`,async t=>{
  const f=await fixture(t),phone=await f.runtime.authenticate('phone');let processed:string|undefined;
  if(origin!=='missing'){
    const accepted=await f.runtime.submit(f.raw(phone,`origin-${origin}`),phone,'origin',origin==='explicit');processed=accepted.processed_event.processed_event_id;
    await until(()=>!!f.admission.get('owner','origin',processed!)?.run_id);
    const context=await f.runtime.scheduleContext({run_id:f.runs.values().next().value!.run_id,session_id:'origin',tool_call_id:'schedule'});
    assert.equal(context.allow_owner_mutation,origin==='explicit');assert.equal(context.allow_reasoning_create,origin==='explicit');
    assert.equal(context.origin_processed_event_id,processed);
  }
  const task=await f.runtime.scheduledTask({principal_id:'owner',device_id:'phone',job_id:'job',occurrence_id:'once',captured_at:new Date().toISOString(),prompt:'owner work',skills:[],...(processed?{origin_processed_event_id:processed}:{})});
  await until(()=>f.created.length===(origin==='missing'?1:2));
  assert.deepEqual(f.requests.at(-1)!.grant_toolsets,origin==='explicit'?['desktop','terminal','file']:['desktop']);
  if(origin==='explicit'){
    await until(()=>!!f.admission.get('owner',task.admission.session_id,task.processed_event.processed_event_id)?.run_id);
    const scheduled=f.created.at(-1),run=f.runs.get(`run-${f.created.length}`)!;
    const queued=await f.runtime.tool('paios_desktop_queue',{context:{run_id:run.run_id,session_id:run.conversation_session_id!,tool_call_id:'inherited-add'},args:{action:'add',task:'inherited'}}) as {queue_id:string};
    await f.runtime.desktopReady(await f.runtime.authenticate('mac'));await until(()=>f.created.length===3);
    assert.equal(f.created[2].content.app_event.origin_processed_event_id,scheduled.processed_event_id);
    assert.deepEqual(f.requests[2]!.grant_toolsets,['desktop','terminal','file']);
  }
});


async function errandRun(f:Awaited<ReturnType<typeof fixture>>,phone:RegisteredDevice,job:{job_id:string;origin_processed_event_id:string},session='errand-result',extra={}) {
  const raw={...f.raw(phone,`errand:${job.job_id}`),media_type:'app_event' as const,mime:'application/json',
    payload:Buffer.from(JSON.stringify({kind:'errand_result',principal_id:'owner',...job,task:'只看夜宵，不下单',success:false,
      answer:'cloud phone unavailable',finished_at:new Date().toISOString(),terminal_reason:'failed',retryable:true,...extra}))};
  const accepted=await f.runtime.submitErrand(raw,phone,session);
  await until(()=>!!f.admission.get('owner',session,accepted.processed_event.processed_event_id)?.run_id);
  return {raw,d:accepted.processed_event,context:{run_id:f.admission.get('owner',session,accepted.processed_event.processed_event_id)!.run_id!,session_id:session,tool_call_id:'retry'}};
}

test('errand result retries the owner request through durable job lineage after restart',async t=>{
  const f=await fixture(t),phone=await f.runtime.authenticate('phone'),accepted=await f.runtime.submit(f.raw(phone,'late-food'),phone,'origin',true);
  await until(()=>!!f.admission.get('owner','origin',accepted.processed_event.processed_event_id)?.run_id);
  const context={run_id:f.admission.get('owner','origin',accepted.processed_event.processed_event_id)!.run_id!,session_id:'origin',tool_call_id:'phone-task'};
  const job=await f.runtime.phoneTaskContext(context);
  assert.equal(job.origin_processed_event_id,accepted.processed_event.processed_event_id);
  assert.deepEqual(await f.runtime.phoneTaskContext(context),job,'same tool call keeps its job binding');
  const runtime=await f.reopen(),source=await runtime.authenticate('phone');f.runtime=runtime;
  const result=await errandRun(f,source,job);
  const resolve=(d:any)=>(runtime as any).ownerOrigin(d);
  assert.equal((await resolve(result.d)).processed_event_id,accepted.processed_event.processed_event_id);
  assert.deepEqual(await ownerActionGrant(result.d,resolve),['desktop','terminal','file']);
  assert.deepEqual(await runtime.effectConsent(result.context,{kind:'read',task_type:'food_search',requested:true}),{status:'allowed'});
  const retry=await runtime.phoneTaskContext(result.context);
  assert.equal(retry.origin_processed_event_id,result.d.processed_event_id);
  const again=await errandRun(f,source,retry,'second-result');
  assert.deepEqual(await runtime.effectConsent(again.context,{kind:'read',task_type:'food_search',requested:true}),{status:'allowed'});
  assert.deepEqual(await runtime.effectConsent(result.context,{kind:'send',task_type:'send_message',recipient:'new-person',requested:true}),
    {status:'confirmation_required',scope:{principal_id:'owner',kind:'send',task_type:'send_message',recipient:'new-person'}});
  const paymentResult=await errandRun(f,source,await runtime.phoneTaskContext({...result.context,tool_call_id:'payment-task'}),'payment-result',{payment_intent:'pi-existing'});
  assert.deepEqual(await ownerActionGrant(paymentResult.d,resolve,{payment_source:{...source,chat_ui:true}}),[]);
  assert.deepEqual(runtime.paymentSource(paymentResult.context.run_id,'pi-existing'),{allowed:false,ride_allowed:false});
});

test('errand origins reject forged, cross-principal and unbound result producers',async t=>{
  const f=await fixture(t),phone=await f.runtime.authenticate('phone');
  const owner=await f.runtime.submit(f.raw(phone,'owner'),phone,'owner',true);
  const passiveRaw={...f.raw(phone,'care'),media_type:'app_event' as const,mime:'application/json',payload:Buffer.from(JSON.stringify({kind:'device_status'}))};
  const passive=await f.runtime.submit(passiveRaw,phone,'care',false);
  await until(()=>!!f.admission.get('owner',passive.admission.session_id,passive.processed_event.processed_event_id)?.run_id);
  const job=await f.runtime.phoneTaskContext({run_id:f.admission.get('owner',passive.admission.session_id,passive.processed_event.processed_event_id)!.run_id!,session_id:passive.admission.session_id,tool_call_id:'care-task'});
  const result=await errandRun(f,phone,job);
  assert.deepEqual(await ownerActionGrant(result.d,d=>(f.runtime as any).ownerOrigin(d)),[]);
  await assert.rejects(f.runtime.effectConsent(result.context,{kind:'read',task_type:'food_search',requested:true}),/OWNER_REQUEST_REQUIRED/);
  for(const forged of [{...job,origin_processed_event_id:owner.processed_event.processed_event_id},{job_id:'job-000000000000',origin_processed_event_id:owner.processed_event.processed_event_id}])
    await assert.rejects(errandRun(f,phone,forged),/ERRAND_REPLAY_CONFLICT/);
  const archive=f.runtime.existingArchive(),legacyApp={...JSON.parse(result.raw.payload.toString()),job_id:'job-legacy000001',origin_processed_event_id:owner.processed_event.processed_event_id};
  const archived=await archive.archive({...result.raw,event_id:'legacy-forged',payload:Buffer.from(JSON.stringify(legacyApp))},{...phone,submission:'observation'});
  const recovered=await new UnifiedIngress(archive).replayApp(archived);
  assert.equal(await archive.validateEvidence(recovered),true,'legacy content is valid archival evidence');
  assert.deepEqual(await ownerActionGrant(recovered,d=>(f.runtime as any).ownerOrigin(d)),[],'archive evidence cannot mint a job binding');
  await assert.rejects(f.runtime.submit({...result.raw,event_id:'client-forged'},phone,'client',false),/ERRAND_REPLAY_CONFLICT/);
  const guestRaw={...passiveRaw,event_id:'guest',payload:Buffer.from(JSON.stringify({kind:'voice_turn',speaker:'speaker:guest',user:'只看夜宵'}))};
  const guest=await f.runtime.submit(guestRaw,phone,'guest',false);
  await until(()=>!!f.admission.get('owner',guest.admission.session_id,guest.processed_event.processed_event_id)?.run_id);
  await assert.rejects(f.runtime.phoneTaskContext({run_id:f.admission.get('owner',guest.admission.session_id,guest.processed_event.processed_event_id)!.run_id!,session_id:guest.admission.session_id,tool_call_id:'guest-task'}),/SCHEDULE_OWNER_REQUIRED/);
  const foreign={...job,principal_id:'another-owner'};
  await assert.rejects(errandRun(f,phone,foreign),/ERRAND_REPLAY_CONFLICT/);
});
