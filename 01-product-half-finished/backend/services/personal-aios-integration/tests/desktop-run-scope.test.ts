import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256,type NativeApproval} from '../src/hermes-client.ts';
import {StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,sha256,principalAttribution} from '../src/contracts.ts';

// Reviewer regression: real runtime/admission/client; only native approval and effect are synthetic.
async function fixture(t:test.TestContext,requestApproval=true){
  const root=await mkdtemp(join(tmpdir(),'desktop-run-scope-')),storage=new PosixStorage(root);
  const accepted=Promise.withResolvers<Record<string,unknown>>(),answered=Promise.withResolvers<void>();
  const question='Synthetic first trash consent',answers:{request_id:string;choice:string}[]=[],notices:string[]=[];
  let session='',grants:string[]=[],approval:NativeApproval|undefined={request_id:'consent',question,expires_at_ms:Date.now()+60000};
  if(!requestApproval)approval=undefined;
  let status=requestApproval?'waiting_for_approval':'running',output:string|undefined;
  const current=()=>({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',run_id:'run',
    session_id:session,conversation_session_id:session,status,granted_toolsets:grants,...(approval?{approval}:{}),...(output?{output}:{})});
  const native=new HermesClient('http://127.0.0.1:1','synthetic-internal-test-key-only',10000,1048576,undefined,async(input,init)=>{
    const url=new URL(String(input));
    if(/^\/v1\/runs\/[^/]+\/events$/u.test(url.pathname))return new Response('',{headers:{'content-type':'text/event-stream'}});
    if(url.pathname.startsWith('/api/sessions'))return Response.json({data:[]});
    if(url.pathname==='/v1/runs'){
      const body=JSON.parse(String(init!.body));session=body.session_id;grants=body.grant_toolsets??[];
      accepted.resolve(body);return Response.json(current(),{status:202});
    }
    if(url.pathname.endsWith('/approval')){
      const body=JSON.parse(String(init!.body));answers.push(body);
      assert.ok(approval,'approval must still be pending when answered');
      assert.equal(body.request_id,approval.request_id);
      approval=undefined;status='completed';output=body.choice==='deny'?'synthetic native denial':'synthetic effect';answered.resolve();
      return Response.json({object:'hermes.run.approval_response',run_id:'run',...body,
        ...(body.confirmation?{confirmation:{...body.confirmation,confirmed_at:'2026-10-22T00:00:00.000Z'}}:{})});
    }
    if(url.pathname.endsWith('/stop')){status='cancelled';approval=undefined;}
    return Response.json(current());
  });
  const authority=Object.assign(new StaticFixtureDeviceAuthority([{principal_id:'owner',device_id:'phone',device_type:'phone',
    channel:'background_scheduled',consent_ref:'fixture',route_version:'fixture',output_modes:['text'],token_sha256:sha256('phone')}]),{
    scheduled:async()=>authority.authenticate('phone')
  });
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:60000,
    poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'test'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage),
    sourceAuthority:authority,skill:'synthetic desktop job',max_read_bytes:8192,notify:async({body})=>{notices.push(body);}});
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const phone=await runtime.authenticate('phone'),views:unknown[][]=[];
  t.after(await runtime.watchVoiceConfirmations(phone,async rows=>{views.push(rows);},error=>assert.fail(String(error))));
  return {runtime,admission,native,storage,phone,accepted:accepted.promise,answered:answered.promise,answers,notices,views};
}

for(const kind of ['scheduled_task','desktop_queue_task'] as const)test(`I18 REVIEW: ${kind} immediately declines native approval without a fresh phone card`,{timeout:10000},async t=>{
  const f=await fixture(t),captured_at=new Date().toISOString();
  const task=kind==='scheduled_task'?await f.runtime.scheduledTask({principal_id:'owner',device_id:'phone',job_id:'job',
    occurrence_id:'once',captured_at,prompt:'Synthetic desktop task',skills:['desktop-assistant']}):
    await f.runtime.submit({schema_version:EVENT_SCHEMA,event_id:'queue-task',device_id:'phone',device_type:'phone',captured_at,
      source:{channel:'background_scheduled'},media_type:'app_event',mime:'application/json',representation:'uploaded_original',
      payload:Buffer.from(JSON.stringify({kind,prompt:'Synthetic queued task'}))},f.phone,'queued-session',false);
  await f.accepted;
  // A native answer arrives while its 60-second request is pending; no timeout or owner answer drives settlement.
  await f.answered;
  assert.deepEqual(f.answers,[{request_id:'consent',choice:'deny'}]);
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  assert.ok(f.views.every(rows=>rows.length===0));assert.deepEqual(f.notices,[]);
  assert.deepEqual(await f.storage.list('voice-confirmations'),[]);
  const {principal_id,session_id,processed_event_id}=task.admission;
  const deadline=Date.now()+2000;
  while((await f.admission.readOnly(principal_id,session_id,processed_event_id))?.state!=='completed'){
    assert.ok(Date.now()<deadline,'declined job did not finish');await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await f.native.status('run',{conversation_session_id:session_id})).output,'synthetic native denial');
});


test('an explicit conversation still publishes approval and waits for the owner answer',{timeout:10000},async t=>{
  const f=await fixture(t),session='conversation';
  await f.runtime.submit({schema_version:EVENT_SCHEMA,event_id:'conversation',device_id:'phone',device_type:'phone',
    captured_at:new Date().toISOString(),source:{channel:'background_scheduled'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('Please do the synthetic desktop action')},f.phone,session,true);
  await f.accepted;
  const deadline=Date.now()+2000;
  let rows=await f.runtime.voiceConfirmations(f.phone);
  while(!rows.length){assert.ok(Date.now()<deadline,'conversation approval did not publish');
    await new Promise(resolve=>setTimeout(resolve,10));rows=await f.runtime.voiceConfirmations(f.phone);}
  assert.equal(rows[0]!.kind,'native_approval');assert.deepEqual(f.answers,[]);
  await f.runtime.confirmVoice(f.phone,{confirmation_id:rows[0]!.confirmation_id,choice:'approve'});
  assert.deepEqual(f.answers,[{request_id:'consent',choice:'once',confirmation:{confirmation_id:rows[0]!.confirmation_id,
    confirmed_by:'owner',surface:{device_id:'phone',device_type:'phone'}}}]);
});

for(const explicit of [false,true])test(`I17 REVIEW: ${explicit?'explicit request carries acknowledged grants':'unattributed observation carries only the gated desktop catalog'} through runtime admission`,{timeout:10000},async t=>{
  const f=await fixture(t,false);
  const result=await f.runtime.submit({schema_version:EVENT_SCHEMA,event_id:'scope-observation',device_id:'phone',device_type:'phone',
    captured_at:new Date().toISOString(),source:{channel:'background_scheduled'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('Synthetic observed text')},f.phone,'scope-session',explicit);
  const body=await f.accepted;
  assert.equal(principalAttribution(result.processed_event),explicit?'explicit_text':null);
  assert.deepEqual(body.grant_toolsets,explicit?['desktop','terminal','file']:['desktop']);
  const deadline=Date.now()+2000;
  while(!f.admission.find('run','scope-session')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal((await f.runtime.scheduleContext({run_id:'run',session_id:'scope-session',tool_call_id:'authority'})).allow_owner_mutation,explicit);
  assert.equal(Object.hasOwn(body,'memory_write'),false);
  assert.deepEqual((await f.native.status('run',{conversation_session_id:'scope-session'})).granted_toolsets,body.grant_toolsets);
});
