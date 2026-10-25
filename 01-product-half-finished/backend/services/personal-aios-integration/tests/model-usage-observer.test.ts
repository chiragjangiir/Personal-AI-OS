import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {brotliCompressSync} from 'node:zlib';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {ModelUsage,type BudgetNotice} from '../src/model-usage.ts';
import {handleModelSettingsHttp} from '../src/model-settings-http.ts';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {OutputAuthority} from '../src/output.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {EVENT_SCHEMA,canonical,digest,sha256} from '../src/contracts.ts';
import {PHONE_CAPABILITIES} from '../src/source-authority.ts';
import {sourceClient} from './native-source-fixture.ts';

test('brotli SDK attempts cross the real usage HTTP budget path exactly once',{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'usage-observer-'));
  const authority=ModelSettingsAuthority.open(join(root,'models'),{environment_id:'test',master_key:Buffer.alloc(32,7),allow_private_hosts:['127.0.0.1']});
  const token='fake-service-token-abcdefghijklmnop',notices:BudgetNotice[]=[];
  let calls=0,runtime:PersonalAIOSRuntime;
  const providerUsage={prompt_tokens:2000000,completion_tokens:250000,prompt_tokens_details:{cached_tokens:0}};
  const caFile=join(root,'fixture-cert.pem'),keyFile=join(root,'fixture-key.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-noenc','-days','1','-keyout',keyFile,'-out',caFile,
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1']);
  const provider=createHttpsServer({key:await readFile(keyFile),cert:await readFile(caFile)},async(req,res)=>{
    calls++;for await(const _ of req){/* consume request */}
    res.writeHead(200,{'content-type':'text/event-stream','content-encoding':'br'});
    res.end(brotliCompressSync(Buffer.from(`data: ${JSON.stringify({id:'fake',choices:[],usage:providerUsage})}\n\ndata: [DONE]\n\n`)));
  });
  const server=createServer(async(req,res)=>{await handleModelSettingsHttp(req,res,runtime,token,16384);});
  t.after(async()=>{await Promise.all([new Promise<void>(done=>server.close(()=>done())),new Promise<void>(done=>provider.close(()=>done()))]);
    await runtime?.close();authority.close();await rm(root,{recursive:true,force:true});});
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const serviceUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`,
    baseUrl=`https://127.0.0.1:${(provider.address() as {port:number}).port}/v1`;
  authority.bootstrap({providers:[{id:'fake-provider',display_name:'Fake',wire_protocol:'chat_completions',base_url:baseUrl,credential_ref:'key'}],
    roles:['brain','delegation','auxiliary.compression'].map(id=>({id,profile:'owner',provider_ref:'fake-provider',model_id:'fake-model',
      parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle' as const}))},{key:'fake-provider-key'});
  const storage=new PosixStorage(join(root,'storage')),archive=new RawArchive(storage,8192);
  const run={run_id:'observer-run',session_id:'observer-session',conversation_session_id:'observer-session',status:'running'};
  const native=sourceClient({create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run,status:'cancelled'})});
  const admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:1000,native_idempotency_retention_ms:86400000,policy_version:'observer-budget'});
  const device={principal_id:'owner',device_id:'phone',device_type:'phone' as const,capabilities:PHONE_CAPABILITIES,
    channel:'fixture',consent_ref:'fixture',route_version:'r1',output_modes:['text' as const]};
  runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),skill:'test',max_read_bytes:8192,
    payment:PaymentAuthority.open(join(root,'payments')),payment_devices:async()=>[device],
    devices:[{...device,token_sha256:sha256('fake-phone-token')}]});
  const usage=new ModelUsage(authority.db,{notify:async notice=>{notices.push(notice);await runtime.modelUsageNotice(notice);}});
  runtime.installModelSettings(authority);runtime.installModelUsage(usage,'test');
  await runtime.configureTimeline({directory:join(root,'timeline')});
  const delivered:string[]=[];
  t.after(await runtime.watchCare(await runtime.authenticate('fake-phone-token'),async(id,text)=>{delivered.push(id);return true;}));
  usage.setPrices([{environment:'test',provider_id:'fake-provider',model_id:'fake-model',currency:'CNY',price_version:'fixture-standard',
    source:'Synthetic budget proof',updated_at:'2026-10-25T00:00:00.000Z',input_per_million:2,output_per_million:8,
    cache_read_per_million:0.04,cache_write_per_million:0,input_tokens_include_cache:true,cache_write_billing:'input'}]);
  const d=await new UnifiedIngress(archive).accept({schema_version:EVENT_SCHEMA,event_id:'observer-event',device_id:'phone',device_type:'phone',
    captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('hello')},
    {principal_id:'owner',device_id:'phone',device_type:'phone',consent_ref:'fixture',channel:'fixture',submission:'explicit_text'});
  await storage.publish('processed-events',digest({principal_id:d.principal_id,processed_event_id:d.processed_event_id}),Buffer.from(canonical(d)));
  await admission.admit(d,'observer-session','test');
  for(let n=0;n<100&&!(await admission.readOnly('owner','observer-session',d.processed_event_id))?.run_id;n++)await new Promise(done=>setTimeout(done,5));
  assert.equal((await admission.readOnly('owner','observer-session',d.processed_event_id))?.run_id,'observer-run');
  const tokenFile=join(root,'token'),requestFile=join(root,'request.json');
  await writeFile(tokenFile,token);
  await writeFile(requestFile,JSON.stringify({token_file:tokenFile,service_url:serviceUrl,base_url:baseUrl,ca_file:caFile,
    projection:{environment_id:'test',profile:'owner',revision:1,group:'brain',config:{providers:{'fake-provider':{api:baseUrl}}}}}));
  const python=process.env.PAIOS_HERMES_PYTHON,nativeSource=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT;
  assert.ok(python&&nativeSource,'Use the committed composed native');
  const repository=fileURLToPath(new URL('../../../../../',import.meta.url));
  const {stdout}=await promisify(execFile)(python,[join(repository,'tests/hermes/model_usage_stream_probe.py'),repository,nativeSource,join(root,'native'),requestFile]);
  const proof=JSON.parse(stdout.trim().split('\n').at(-1)!);
  assert.equal(calls,3);assert.equal(proof.attempts.length,3);
  const attempts=usage.recentAttempts('test','owner');
  assert.equal(attempts.length,3);assert.ok(attempts.every(attempt=>attempt.status==='completed'&&attempt.cost.amount===6));
  assert.deepEqual(new Set(attempts.map(attempt=>attempt.role)),new Set(['brain','delegation','auxiliary.compression']));
  assert.equal(usage.summary('test','owner').estimated_cny,18);
  for(const attempt of proof.attempts){
    const response=await fetch(serviceUrl+'/internal/model-settings/usage',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(attempt)});
    assert.equal(response.status,200);
  }
  await usage.checkBudget('test','owner');
  assert.equal((await storage.list('system-events')).length,1);
  assert.equal((await storage.list('system-notice-deliveries')).length,1);
  assert.equal(delivered.length,1);assert.equal(new Set(notices.map(notice=>notice.id)).size,1);
  assert.match(notices[0]!.text,/按配置标准价估算，不含时段折扣，不是账单/);
  assert.equal(notices[0]!.system_event.type,'budget_alert');
  assert.equal(notices[0]!.system_event.alert_kind,'estimated');assert.equal(notices[0]!.system_event.estimated_cny,12);
});
