import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {HermesClient,type NativeRun} from '../src/hermes-client.ts';
import {ModelUsage} from '../src/model-usage.ts';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {EVENT_SCHEMA,sha256} from '../src/contracts.ts';
import {handleModelSettingsHttp} from '../src/model-settings-http.ts';

test('offline usage POST survives native SQLite reopen and Integration restart; journal replay never reexecutes paid inference',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'usage-journal-')),repository=fileURLToPath(new URL('../../../../../',import.meta.url));
  const nativeSource=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT,python=process.env.PAIOS_HERMES_PYTHON;
  assert.ok(nativeSource&&python,'Set PAIOS_NATIVE_SOURCE_TEST_ROOT and PAIOS_HERMES_PYTHON to the committed candidate');
  const bytes=execFileSync(python,[resolve(repository,'tests/hermes/model_usage_journal_probe.py'),repository,nativeSource,join(root,'native')],
    {encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
  const proof=JSON.parse(bytes.trim().split('\n').at(-1)!) as {run:NativeRun;wire_calls:number;http_failures:number};
  assert.equal(proof.wire_calls,1);assert.equal(proof.http_failures,1);assert.equal(proof.run.activity_events!.filter(event=>event.event==='model.usage').length,1);
  const authority=ModelSettingsAuthority.open(join(root,'models'),{environment_id:'test',master_key:Buffer.alloc(32,8)});
  authority.bootstrap({providers:[{id:'fake-provider',display_name:'Fake',wire_protocol:'chat_completions',base_url:'https://models.invalid/v1',credential_ref:'fake-key'}],
    roles:[{id:'brain',profile:'owner',provider_ref:'fake-provider',model_id:'fake-model',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'}]},
    {'fake-key':'fake-journal-key'});
  const storage=new PosixStorage(join(root,'storage'));let creates=0,online=false;
  let serviceUrl='';const serviceToken='fake-source-journal-token-abcdefghijklmnop';
  const streamOpened=Promise.withResolvers<void>();
  const native=new HermesClient('http://127.0.0.1:1','fake-native-token-abcdefghijklmnop',10000,1048576,undefined,async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.startsWith('/api/sessions'))return Response.json({data:[]});
    if(path==='/v1/runs'){creates++;const body=JSON.parse(String(init?.body));
      return Response.json({...proof.run,status:'running',activity_events:[],granted_toolsets:body.grant_toolsets??[]},{status:202});}
    if(path.endsWith('/events')){
      streamOpened.resolve();
      if(!online)return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
        {headers:{'content-type':'text/event-stream'}});
      const live=proof.run.activity_events!.find(event=>event.event==='model.usage')!;
      assert.ok(live.text);
      const duplicate=await fetch(serviceUrl,{method:'POST',headers:{Authorization:`Bearer ${serviceToken}`,'Content-Type':'application/json'},body:live.text});
      assert.equal(duplicate.status,200);
      const snapshot={event:'run.snapshot',run_id:'journal-run',timestamp:Date.now()/1000,seq:proof.run.seq!+1,run:proof.run,activity_events:proof.run.activity_events};
      return new Response(`data: ${JSON.stringify(live)}\n\ndata: ${JSON.stringify(snapshot)}\n\n`,{headers:{'content-type':'text/event-stream'}});
    }
    return Response.json(proof.run);
  });
  function instance(){
    const archive=new RawArchive(storage,8192);
    const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:1000,
      native_idempotency_retention_ms:86400000,policy_version:'usage-recovery'});
    const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),skill:'test',max_read_bytes:8192,
      payment:PaymentAuthority.open(join(root,'payments')),devices:[{principal_id:'real-owner',device_id:'phone',device_type:'phone',
        channel:'fixture',consent_ref:'c',route_version:'r1',output_modes:['text'],token_sha256:sha256('fake-phone')}]});
    runtime.installModelSettings(authority);
    const usage=new ModelUsage(authority.db,{notify:async()=>{}});runtime.installModelUsage(usage,'test');
    return {runtime,admission,usage};
  }
  let current=instance();
  const server=createServer(async(req,res)=>{await handleModelSettingsHttp(req,res,current.runtime,serviceToken,16384);});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));serviceUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/internal/model-settings/usage`;
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await current.runtime.close();authority.close();await rm(root,{recursive:true,force:true});});
  const phone=await current.runtime.authenticate('fake-phone');
  const submitted=await current.runtime.submit({schema_version:EVENT_SCHEMA,event_id:'durable-source',device_id:'phone',device_type:'phone',captured_at:new Date().toISOString(),
    source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('work')},
    phone,'canonical-session',true);
  await streamOpened.promise;
  assert.equal(current.usage.summary('test','real-owner').attempts,0);
  await current.runtime.close();online=true;current=instance();await current.admission.recover();
  for(let n=0;n<200&&current.usage.summary('test','real-owner').attempts===0;n++)await new Promise(done=>setTimeout(done,5));
  assert.equal(current.usage.summary('test','real-owner').attempts,1);
  const attempt=current.usage.recentAttempts('test','real-owner')[0];assert.ok(attempt);
  assert.equal(attempt.input_tokens,9);assert.equal(attempt.output_tokens,2);assert.equal(attempt.owner,'real-owner');
  const reconnected=await current.runtime.authenticate('fake-phone'),output=await current.runtime.result(reconnected,'canonical-session',submitted.processed_event.processed_event_id);
  assert.equal(output.chunks.length,0);assert.ok(!JSON.stringify(output.result).includes('prompt_tokens'));
  await current.usage.record(attempt);
  assert.equal(current.usage.summary('test','real-owner').attempts,1);assert.equal(creates,1);
});
