import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,sha256} from '../src/contracts.ts';

const repo=fileURLToPath(new URL('../../../../../',import.meta.url));
const fork=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT;
// Same convention as the standing-watch test: an exported fork without its own venv names the interpreter explicitly.
const python=process.env.PAIOS_NATIVE_TEST_PYTHON??(fork&&join(fork,'.venv/bin/python'));
for(const staging of [false,true])test(`actual cron lineage chain, ${staging?'staging':'production'}`,
  {skip:!fork||!python||!existsSync(python)?'native patched source and venv required':false,timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'cron-lineage-')),storage=new PosixStorage(join(root,'storage'));
  const bodies:any[]=[],nativeRuns=new Map<string,any>();let deliveryPhase=false;
  const native=new HermesClient('http://127.0.0.1:1','synthetic-lineage-key-abcdefghijklmnop',10000,1048576,undefined,async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(/^\/v1\/runs\/[^/]+\/events$/u.test(path))return new Response('',{headers:{'content-type':'text/event-stream'}});
    if(path.startsWith('/api/sessions'))return Response.json({data:[]});
    if(path==='/v1/runs'){
      const body=JSON.parse(String(init!.body));bodies.push(body);
      const run={schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',
        run_id:`native-${bodies.length}`,session_id:body.session_id,conversation_session_id:body.session_id,
        status:deliveryPhase?'completed':'running',...(deliveryPhase?{output:'synthetic task complete'}:{}),
        granted_toolsets:body.grant_toolsets};nativeRuns.set(run.run_id,run);
      return Response.json(run,{status:202});
    }
    const runId=path.split('/')[3];assert.ok(runId,path);
    const run=nativeRuns.get(runId);assert.ok(run,path);
    return Response.json(path.endsWith('/stop')?{...run,status:'cancelled'}:run);
  });
  const authority=Object.assign(new StaticFixtureDeviceAuthority(['text','background_scheduled'].map(channel=>({
    principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel,consent_ref:'fixture',
    route_version:'fixture',output_modes:['text' as const],token_sha256:sha256(channel)}))),{
    scheduled:async()=>authority.authenticate('background_scheduled')});
  let admission:RunAdmission;
  const open=()=>new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),native,
    admission:admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,
      max_event_age_ms:86400000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'lineage'}),
    output:new OutputAuthority(storage),sourceAuthority:authority,skill:'fixture',max_read_bytes:8192});
  let runtime=open();t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const until=async(check:()=>boolean)=>{const limit=Date.now()+5000;while(!check()){
    assert.ok(Date.now()<limit,'native run not admitted');await new Promise(r=>setTimeout(r,5));}};
  const phone=await runtime.authenticate('text');
  async function context(id:string,explicit:boolean){
    const accepted=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:id,device_id:'phone',device_type:'phone',
      captured_at:new Date().toISOString(),source:{channel:'text'},media_type:explicit?'text':'app_event',
      mime:explicit?'text/plain;charset=utf-8':'application/json',representation:'uploaded_original',
      payload:Buffer.from(explicit?'Owner documents':JSON.stringify({kind:'device_status',text:'ambient'}))},phone,id,explicit);
    await until(()=>!!admission.get('owner',id,accepted.processed_event.processed_event_id)?.run_id);
    const run=admission.get('owner',id,accepted.processed_event.processed_event_id)!;
    return runtime.scheduleContext({run_id:run.run_id!,session_id:id,tool_call_id:`schedule-${id}`});
  }
  const owner=await context('owner-create',true),observation=await context('observation',false),owner_update=await context('owner-update',true);
  assert.equal(observation.allow_reasoning_create,false);assert.equal(observation.allow_owner_mutation,false);
  const env={...process.env,PYTHONPATH:resolve(fork!),PYTHONDONTWRITEBYTECODE:'1',HERMES_DISABLE_LAZY_INSTALLS:'1',
    HERMES_HOME:join(root,'native-home'),PAIOS_STAGE:staging?'staging':'production'};
  const result=spawnSync(python!,[fileURLToPath(new URL('./cron-lineage-native.py',import.meta.url))],{
    env,input:JSON.stringify({home:env.HERMES_HOME,cron:join(repo,'integrations/hermes/personal_aios/cron.py'),owner,observation,owner_update}),encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const line=result.stdout.split('\n').find(line=>line.startsWith('LINEAGE_RESULT='));assert.ok(line,result.stdout);
  const proof=JSON.parse(line.slice('LINEAGE_RESULT='.length));assert.equal(proof.refused.success,false);
  assert.equal(proof.legacy_refused.success,false);
  // Drop the runtime and admission maps. Only the durable raw/processed origin can authorize delivery.
  await runtime.close();deliveryPhase=true;runtime=open();
  for(const [index,delivery] of proof.deliveries.entries()){
    const before=bodies.length,accepted=await runtime.scheduledTask(delivery);
    await until(()=>bodies.length>before);
    assert.deepEqual(bodies.at(-1).grant_toolsets,index===0||index===3?['desktop','terminal','file']:['desktop']);
    if(index===1)assert.equal(delivery.origin_processed_event_id,undefined,'legacy origin was invented');
    if(index===3)assert.equal(delivery.origin_processed_event_id,owner_update.origin_processed_event_id);
    assert.equal(JSON.parse(bodies.at(-1).input).processed_event_id,accepted.processed_event.processed_event_id);
  }
  t.diagnostic(JSON.stringify({staging,observationMutationRefused:true,restarted:true,
    deliveryGrants:bodies.slice(-4).map(body=>body.grant_toolsets),ownerUpdateOrigin:owner_update.origin_processed_event_id}));
});
