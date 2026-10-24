import {fakeQwenConfiguration,fakeTtsConfiguration} from './speech-fixture.ts';
import {readFileSync} from 'node:fs';
const nativeVersionFixtures=JSON.parse(readFileSync(new URL('./fixtures/native-final-response/native-run-version-fixtures.json',import.meta.url),'utf8'));
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionCentralResources, createMainStop, type CentralProvisionConfiguration} from '../src/main.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {DashScopeTts, inspectWav} from '../src/tts.ts';
import {EVENT_SCHEMA, sha256} from '../src/contracts.ts';

const KEY='controlled-resource-fixture-only-123456';
const TEXT='这是固定测试原文，不是模型回答。';
async function fixture(t:test.TestContext, enable=true) {
  const root=await fs.mkdtemp(join(tmpdir(),'tts-resource-'));
  let completed=false,creates=0,grants:string[]=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${KEY}`);
    if(req.method==='GET'&&req.url?.startsWith('/api/sessions')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
    if(req.method==='POST'&&req.url==='/v1/runs') {creates++;let body='';for await(const chunk of req)body+=chunk;grants=JSON.parse(body).grant_toolsets;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({...nativeVersionFixtures.tts[completed?'completed':'running'],granted_toolsets:grants}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  await fs.writeFile(join(root,'key'),KEY,{mode:0o600});await fs.writeFile(join(root,'skill'),'controlled fixed skill');
  const config:CentralProvisionConfiguration={storage_root:join(root,'storage'),lock_file:join(root,'lock'),port:18898,
    hermes_base_url:`http://127.0.0.1:${address.port}`,hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),
    native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:8192,max_event_bytes:8192,max_read_bytes:8192,
    admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,
      native_idempotency_retention_ms:100000,policy_version:'controlled-tts-resource'},...(enable?{tts:{provider:'dashscope',model:'qwen-audio-3.0-tts-plus',voice:'longanlingxin',sample_rate:22050},voice_frontend:{provider:'dashscope',model:'qwen3.8-omni-flash-realtime',region:'cn-beijing',endpoint:'wss://synthetic.invalid/realtime',key_file:join(root,'key'),voice:'Tina',instructions:'candidate',call:{model:'qwen3.8-omni-flash-realtime',voice:'longanlingxin'}}}:{})};
  const provision=await provisionCentralResources(config);
  const {tts,voice:_voice,...central}=provision.resources;
  if(enable)assert.ok(tts instanceof DashScopeTts);else assert.equal(tts,undefined);
  // Legal source fixture registry. This does not widen the product's current formal text route.
  const assembly=createPersonalAIOSAssembly({...central,devices:[{principal_id:'fixture-owner',device_id:'fixture-mac',device_type:'mac',
    consent_ref:'fixture-consent',channel:'text',route_version:'fixture-route',output_modes:['text','voice'],token_sha256:sha256(KEY)}],
    ...(tts?{output:{tts}}:{})});
  let poolEnds=0;
  const close=createMainStop(assembly,{close:async()=>{poolEnds++;}},provision.release);
  t.after(async()=>{await close();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});});
  const source=await assembly.runtime.authenticate(KEY);
  const submitted=await assembly.runtime.submit({schema_version:EVENT_SCHEMA,event_id:'fixture-event',device_id:'fixture-mac',device_type:'mac',
    captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',
    payload:Buffer.from('固定用户输入')},source,'fixture-session',true);
  // HTTP receipt arrival precedes durable admission binding; wait for the actual source record, not the request spy.
  for(let n=0;n<200;n++){
    const entry=await assembly.runtime.event(source,'fixture-session',submitted.processed_event.processed_event_id);
    if(entry.admission.run_id==='fixture-run')break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal((await assembly.runtime.event(source,'fixture-session',submitted.processed_event.processed_event_id)).admission.run_id,'fixture-run');
  assert.equal(creates,1);
  const context={schema:'hermes.run.v2',profile_home:join(root,'native-profile'),memory_write:false,run_id:'fixture-run',session_id:'fixture-session',tool_call_id:'fixture-open'};
  async function open() {return assembly.runtime.tool('paios_open_reply',{context,args:{reply_mode:'text_and_voice'}});}
  async function result(){return assembly.runtime.result(source,'fixture-session',submitted.processed_event.processed_event_id);}
  async function settledVoice(dId: string) {
    const settled=Promise.withResolvers<void>();
    const timer=setTimeout(()=>settled.reject(new Error('TEST_VOICE_SETTLEMENT_TIMEOUT')),5000);
    const runtime=assembly.runtime;
    let unsubscribe:(()=>void)|undefined;
    try {unsubscribe=await runtime.subscribeResult(source,'fixture-session',dId,async value=>{
      if(value.result.voice_status!=='pending')settled.resolve();
    },settled.reject,{voice_settlement:true});
    await settled.promise;} finally {clearTimeout(timer);unsubscribe?.();}
  }
  async function settledResult(){await result();await settledVoice(submitted.processed_event.processed_event_id);return result();}
  return {settledResult,root,config,provision,assembly,tts,source,open,result,close,complete(){completed=true;},get creates(){return creates;},get poolEnds(){return poolEnds;}};
}
function wav() {
  const b=Buffer.alloc(244);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
  b.write('data',36);b.writeUInt32LE(200,40);return inspectWav(b);
}
test('same provisioned DashScopeTts and legal fixture assembly generate transport WAV from fixed native fixture final text',{},async t=>{
  const stream=DashScopeTts.prototype.stream;
  t.mock.method(DashScopeTts.prototype,'stream',async function*(text:string,id:string,signal?:AbortSignal){
    const tts=new DashScopeTts(fakeQwenConfiguration(), fakeTtsConfiguration);try {yield*stream.call(tts,text,id,signal);} finally {tts.close();}});
  const f=await fixture(t);assert.equal((await f.open() as {status:string}).status,'opened');f.complete();
  const value=await f.settledResult();assert.equal(value.result.voice_status,'ready');assert.equal(value.result.reply_text,TEXT);
  assert.equal(value.result.delivery_status,'unknown');const voice=value.voice_chunks[0]!;assert.ok(voice.audio.duration_ms>0);
  console.info('fixture_qwen_wav',JSON.stringify({run_id:value.result.run_id,processed_event_id:value.result.processed_event_id,reply_id:voice.reply_id,reply_epoch:voice.reply_epoch,target_device_id:voice.target_device_id,route_version:voice.route_version,audio:voice.audio,text_range:voice.text_range,delivery_status:value.result.delivery_status}));
  assert.equal(voice.audio.mime,'audio/wav');assert.equal(voice.audio.sha256.length,64);assert.equal(voice.text_range.end,Array.from(TEXT).length);
  const stored=await f.provision.resources.storage.read('derived-audio',voice.audio.ref.slice('audio:'.length));assert.equal(inspectWav(stored).sha256,voice.audio.sha256);
  const replay=await f.result();assert.equal(replay.voice_chunks[0]?.audio.sha256,voice.audio.sha256);assert.equal(f.creates,1);
  await f.close();assert.equal(f.poolEnds,1);await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
});
test('default text resources reject voice without starting synthesis',async t=>{
  t.mock.method(DashScopeTts.prototype,'stream',async function*(){throw new Error('DEFAULT_MUST_NOT_SYNTHESIZE');});
  const f=await fixture(t,false);assert.equal((await f.open() as {error_code:string}).error_code,'TTS_NOT_CONFIGURED');await f.close();assert.equal(f.creates,1);
});
test('known TTS failure preserves final text and never recreates native run or automatically retries synthesis',async t=>{
  let calls=0;t.mock.method(DashScopeTts.prototype,'stream',async function*(){calls++;throw new Error('CONTROLLED_TTS_EIO');});
  const f=await fixture(t);assert.equal((await f.open() as {status:string}).status,'opened');f.complete();
  const value=await f.settledResult();assert.equal(value.result.voice_status,'failed');assert.equal(value.result.reply_text,TEXT);assert.equal(value.result.result_status,'completed');
  await f.result();assert.equal(calls,1);assert.equal(f.creates,1);await f.close();
});
test('same assembly synthesis abort and join precede borrowed pool close and provisioning lock release',async t=>{
  const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();let signal:AbortSignal|undefined;
  t.mock.method(DashScopeTts.prototype,'stream',async function*(_text:string,_id:string,s?:AbortSignal){signal=s;entered.resolve();await gate.promise;yield wav();});
  const f=await fixture(t);try {await f.open();f.complete();const initial=await f.result();assert.equal(initial.result.voice_status,'pending');assert.equal(initial.result.reply_text,TEXT);assert.equal(initial.result.result_status,'completed');await entered.promise;
  const aborted=Promise.withResolvers<void>();signal!.addEventListener('abort',()=>aborted.resolve(),{once:true});
  const closing=f.close();await aborted.promise;assert.equal(signal?.aborted,true);assert.equal(f.poolEnds,0);assert.ok(await fs.stat(f.config.lock_file));
  gate.resolve();await Promise.all([closing,f.close()]);
  // Text settled before close. Only the owned voice task was cancelled.
  const entries=await Promise.all((await f.provision.resources.storage.list('output-journal')).map(async key=>
    JSON.parse(Buffer.from(await f.provision.resources.storage.read('output-journal',key)).toString())));
  assert.ok(entries.some(entry=>entry.voice?.error==='TTS_SYNTHESIS_CANCELLED'));assert.equal(f.poolEnds,1);assert.equal(f.creates,1);
  await assert.rejects(fs.stat(f.config.lock_file),{code:'ENOENT'});
  } finally {gate.resolve();await f.close();}
});

test('a separate TTS key uses the existing protected-file contract without changing the realtime key',async t=>{
  const f=await fixture(t);await f.close();
  const path=join(f.root,'tts-key');
  await fs.writeFile(path,'controlled-separate-tts-fixture-123456',{mode:0o644});
  const config={...f.config,tts:{...f.config.tts!,key_file:path}};
  await assert.rejects(provisionCentralResources(config),/UNSAFE_KEY_FILE/);
  await fs.chmod(path,0o600);await fs.writeFile(path,'short');
  await assert.rejects(provisionCentralResources(config),/INVALID_KEY/);
  await fs.writeFile(path,'controlled-separate-tts-fixture-123456');
  const provision=await provisionCentralResources(config);
  assert.ok(provision.resources.tts instanceof DashScopeTts);
  await provision.release();
});
