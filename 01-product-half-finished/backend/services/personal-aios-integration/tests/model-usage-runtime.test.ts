import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {HermesClient} from '../src/hermes-client.ts';
import {OutputAuthority} from '../src/output.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {PHONE_CAPABILITIES} from '../src/source-authority.ts';
import {sha256,canonical,digest,EVENT_SCHEMA} from '../src/contracts.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';
import {ModelUsage} from '../src/model-usage.ts';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {sourceClient} from './native-source-fixture.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';

test('persisted parent run proof permits configured auxiliary routes without owner reserve',async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-usage-auxiliary-')),storage=new PosixStorage(root),archive=new RawArchive(storage,8192);
  const authority=ModelSettingsAuthority.open(join(root,'models'),{environment_id:'test',master_key:Buffer.alloc(32,7)});
  authority.bootstrap({providers:[{id:'provider',display_name:'Fixture',wire_protocol:'chat_completions',base_url:'https://model.invalid/v1',credential_ref:'credential'}],
    roles:[{id:'brain',profile:'owner',provider_ref:'provider',model_id:'model',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'},
      {id:'auxiliary.compression',profile:'owner',inherit_from:'brain',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'}]}, {'credential':'fake-credential-1234'});
  const run={run_id:'parent-run',session_id:'parent-session',conversation_session_id:'parent-session',status:'running'};
  const native=sourceClient({create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'auxiliary-source'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),skill:'test',max_read_bytes:8192,
    payment:PaymentAuthority.open(join(root,'payments')),payment_devices:async()=>[]});
  t.after(async()=>{await runtime.close();authority.close();await rm(root,{recursive:true,force:true});});
  const usage=new ModelUsage(authority.db,{notify:async()=>{}});runtime.installModelSettings(authority);runtime.installModelUsage(usage,'test');
  const d=await new UnifiedIngress(archive).accept({schema_version:EVENT_SCHEMA,event_id:'parent-event',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),
    source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('hello')},
    {principal_id:'owner',device_id:'phone',device_type:'phone',consent_ref:'fixture',channel:'fixture',submission:'explicit_text'});
  await storage.publish('processed-events',digest({principal_id:d.principal_id,processed_event_id:d.processed_event_id}),Buffer.from(canonical(d)));
  await admission.admit(d,run.session_id,'test');
  for(let n=0;n<100&&!(await admission.readOnly('owner',run.session_id,d.processed_event_id))?.run_id;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await admission.readOnly('owner',run.session_id,d.processed_event_id))?.run_id,run.run_id);
  const start={attempt_id:'compression-attempt',request_id:'compression-request',environment:'test',profile:'owner',revision:1,provider_id:'provider',
    model_id:'model',role:'auxiliary.compression',base_url:'https://model.invalid/v1',run_id:run.run_id,session_id:run.session_id,captured_at:new Date().toISOString(),
    phase:'started',status:'started',input_tokens:null,output_tokens:null,original_usage:{},cost:{kind:'unknown',amount:null,currency:'CNY'},
    source_context:{kind:'run',run_id:run.run_id,session_id:run.session_id,principal_id:'owner',processed_event_id:d.processed_event_id}};
  await runtime.recordModelWireAttempt(start);
  await runtime.recordModelWireAttempt({...start,phase:'terminal',status:'completed',input_tokens:5,output_tokens:1});
  assert.equal(usage.summary('test','owner').attempts,1);assert.equal(usage.recentAttempts('test','owner')[0]!.owner_chat,false);
  await assert.rejects(runtime.recordModelWireAttempt({...start,attempt_id:'unconfigured',role:'auxiliary.unknown'}),/MODEL_USAGE_PROFILE_DENIED/);
  await assert.rejects(runtime.recordModelWireAttempt({...start,attempt_id:'wrong-route',model_id:'other-model'}),/MODEL_USAGE_ROUTE_DENIED/);
  await assert.rejects(runtime.recordModelWireAttempt({...start,attempt_id:'forged-parent',source_context:{...start.source_context,processed_event_id:'other-event'}}),/MODEL_USAGE_ADMISSION_REQUIRED/);
  usage.pause('test','owner');await assert.rejects(runtime.recordModelWireAttempt({...start,attempt_id:'paused'}),/MODEL_USAGE_PAUSED/);
  assert.equal(usage.summary('test','owner').attempts,1);
});

test('budget event reaches timeline and phone text with broken brain; offline retry deduplicates',async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-usage-runtime-')),db=new DatabaseSync(':memory:');
  const storage=new PosixStorage(root);let modelCalls=0,ttsCalls=0;
  const native=new HermesClient('http://127.0.0.1:1','fake-token-abcdefghijklmnop',1000,1048576,undefined,async()=>{
    modelCalls++;throw Error('BRAIN_DOWN');
  });
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:1000,native_idempotency_retention_ms:86400000,policy_version:'budget-test'});
  const output=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),
    tts:{synthesize:async()=>{ttsCalls++;throw Error('TTS_DOWN');}}});
  const inventory:RegisteredDevice[]=[{principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:PHONE_CAPABILITIES,
    channel:'fixture',consent_ref:'fixture',route_version:'r1',output_modes:['text','voice']}];
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output,payment_devices:async()=>inventory,
    skill:'test',max_read_bytes:8192,devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',
      capabilities:PHONE_CAPABILITIES,channel:'fixture',consent_ref:'fixture',route_version:'r1',
      output_modes:['text','voice'],token_sha256:sha256('fake-phone-token')}]});
  t.after(async()=>{await runtime.close();db.close();await rm(root,{recursive:true,force:true});});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  const phone=await runtime.authenticate('fake-phone-token');
  const usage=new ModelUsage(db,{notify:notice=>runtime.modelUsageNotice(notice),resumeWork:()=>runtime.resumeModelUsageWork()});
  runtime.installModelUsage(usage,'staging');
  await assert.rejects(runtime.modelUsageRecord({attempt_id:'wire-1',request_id:'request-1',environment:'staging',owner:'owner',
    provider_id:'fake-provider',model_id:'fake-model',role:'main',revision:'1',owner_chat:false,
    captured_at:new Date().toISOString(),status:'completed',input_tokens:12,output_tokens:3,
    cost:{kind:'known',amount:10.1,currency:'CNY'}}),/CARE_OUTREACH_UNAVAILABLE/);
  assert.equal(runtime.timeline!.page('owner').items.length,1);
  const item=runtime.timeline!.page('owner').items[0];assert.ok(item);assert.equal(item.kind,'notice');
  inventory[0]={...inventory[0]!,device_id:'replacement-phone'};
  const delivered:{id:string;text:string}[]=[];
  t.after(await runtime.watchCare(phone,async(id,text)=>{delivered.push({id,text});return true;}));
  await usage.checkBudget('staging','owner');await usage.checkBudget('staging','owner');
  assert.equal(delivered.length,1);const delivery=delivered[0];assert.ok(delivery);assert.match(delivery.text,/已知消费 10.10 元/);
  assert.equal((await storage.list('system-events')).length,1);
  assert.equal((await storage.list('system-notice-deliveries')).length,1);
  assert.equal(modelCalls,0);assert.equal(ttsCalls,0);
});
