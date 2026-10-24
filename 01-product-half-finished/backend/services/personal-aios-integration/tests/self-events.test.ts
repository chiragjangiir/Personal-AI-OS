import test from 'node:test';
import {channel} from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeEventStore,emitRuntimeEvent,installRuntimeEventStore} from '../src/self-events.ts';

async function directory(t:{after:(fn:()=>Promise<void>)=>void}){
  const path=await mkdtemp(join(tmpdir(),'self-events-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;
}
test('rotation and restart retain bounded sanitized events and explicit unknown channels',async t=>{
  const path=await directory(t),options={directory:path,max_file_bytes:220,files:2,now:()=>1000};
  let store=new RuntimeEventStore(options);
  for(let i=0;i<14;i++)store.write({voice_call_stage:'turn_speaker',at:1000,score:i/20,verdict:'owner',
    transcript:'private speech',message:'credential',call:'private identifier',arbitrary:'secret',encoder_backlog:i});
  await store.close();
  assert.equal((await stat(path)).mode&0o777,0o700);
  for(const file of await readdir(path)){
    const info=await stat(join(path,file));assert.ok(info.size<=220);assert.equal(info.mode&0o777,0o600);
  }
  assert.ok((await readdir(path)).length<=2);
  store=new RuntimeEventStore(options);const events=await store.read();
  assert.ok(events.length>0&&events.length<14);assert.equal(events.at(-1)?.score,13/20);
  assert.ok(events.every(e=>e.channel==='unknown'&&!('transcript' in e)&&!('message' in e)&&!('call' in e)&&!('arbitrary' in e)));
  assert.equal(events.at(-1)?.encoder_backlog,13);await store.close();
});
test('retention, channel and time filters, partial crash line, and reduced restart limits',async t=>{
  const path=await directory(t);let now=1000;
  await writeFile(join(path,'runtime-events.0.jsonl'),JSON.stringify({voice_call_stage:'session_open',at:900,channel:'phone'})+'\n{"broken":');
  await writeFile(join(path,'runtime-events.8.jsonl'),'old out-of-bounds file');
  const store=new RuntimeEventStore({directory:path,files:2,retention_ms:100,now:()=>now});
  store.write({voice_call_stage:'turn_speaker',at:950,channel:'glasses',verdict:'other',score:.2});
  store.write({voice_call_stage:'turn_speaker',at:990,channel:'phone',verdict:'owner',score:.9});
  assert.equal((await store.read({since:940,until:980,channel:'glasses'})).length,1);
  assert.equal((await store.read({channel:'phone'})).length,2);
  now=1100;assert.deepEqual(await store.read(),[]);
  assert.ok(!(await readdir(path)).includes('runtime-events.8.jsonl'));
  assert.equal(await readFile(join(path,'runtime-events.0.jsonl'),'utf8'),'');await store.close();
});
test('bounded queue drops promptly; unsupported, text, nonfinite metrics never persist',async t=>{
  const path=await directory(t),store=new RuntimeEventStore({directory:path,max_queue_bytes:150,now:()=>1000});
  store.write({transcript:'unsupported'});
  for(let i=0;i<30;i++)store.write({ambient_stage:'candidate_ready',at:1000,channel:'api-secret',score:NaN,endpoint_ms:10,error:'secret',code:'secret-token'});
  assert.ok(store.snapshot().queued_bytes<=150);assert.ok(store.snapshot().dropped>0);
  const events=await store.read();assert.ok(events.length>0);assert.equal(store.snapshot().ignored,1);
  assert.ok(events.every(e=>e.channel==='unknown'&&!('score' in e)&&!('error' in e)&&!('code' in e)));
  await store.close();store.write({ambient_stage:'closed'});assert.equal(store.snapshot().queued_bytes,0);
});
test('emitter preserves original stderr line and one installed process sink',async t=>{
  const path=await directory(t),store=new RuntimeEventStore({directory:path,now:()=>1000});
  const lines:string[]=[];t.mock.method(process.stderr,'write',((chunk:unknown)=>{lines.push(String(chunk));return true;}) as never);
  const detach=installRuntimeEventStore(store);t.after(detach);
  assert.throws(()=>installRuntimeEventStore(store),/already installed/);
  const event={voice_call_stage:'turn_speaker',at:1000,channel:'phone',verdict:'owner',score:.9,message:'stderr unchanged'};
  emitRuntimeEvent(event);assert.equal(lines[0],JSON.stringify(event)+'\n');
  assert.equal((await store.read()).length,1);detach();emitRuntimeEvent(event);
  assert.equal((await store.read()).length,1);
  const replacement=new RuntimeEventStore({directory:join(path,'replacement'),now:()=>1000});
  const detachReplacement=installRuntimeEventStore(replacement);t.after(detachReplacement);
  detach(); // An old detach must not remove the replacement's listener or process sink.
  channel('paios.runtime.events').publish({kind:'release_rollback',status:'completed',at:1000});
  emitRuntimeEvent(event);
  assert.equal((await replacement.read()).length,2);assert.equal((await store.read()).length,1);
  detachReplacement();await replacement.close();await store.close();
});
test('I/O failures surface through flush and snapshot without error text',async t=>{
  const path=await directory(t),file=join(path,'not-a-directory');await writeFile(file,'x');
  let reported=0;const store=new RuntimeEventStore({directory:file,onError:()=>{reported++;}});
  store.write({voice_call_stage:'session_open'});await assert.rejects(store.flush());
  assert.ok(reported>0);assert.equal(store.snapshot().last_error,'RUNTIME_EVENT_IO_FAILED');
  await assert.rejects(store.close());
});
test('the production error reporter cannot feed a failed sink back into itself',async t=>{
  const path=await directory(t),file=join(path,'not-a-directory');await writeFile(file,'x');
  let reports=0;const store=new RuntimeEventStore({directory:file,onError:()=>{reports++;if(reports<3)emitRuntimeEvent({central_text_failed:'EVENT_STORE_FAILED'});}});
  const detach=installRuntimeEventStore(store);t.after(detach);
  t.mock.method(process.stderr,'write',(()=>true) as never);
  await assert.rejects(store.flush());await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(reports,1);assert.equal(store.snapshot().queued_bytes,0);assert.equal(store.snapshot().dropped,1);
  detach();await assert.rejects(store.close());
});
test('complete malformed records surface corruption rather than returning successful partial statistics',async t=>{
  const path=await directory(t);await writeFile(join(path,'runtime-events.0.jsonl'),'{"voice_call_stage":"session_open","at":1000}\n{broken}\n');
  const store=new RuntimeEventStore({directory:path,now:()=>1000});await assert.rejects(store.read(),SyntaxError);
  assert.equal(store.snapshot().errors,1);await assert.rejects(store.close());
});
test('error categories and resource counters remain inspectable without frame or message content',async t=>{
  const path=await directory(t),store=new RuntimeEventStore({directory:path,now:()=>1000});
  store.write({central_text_failed:'CENTRAL_TEXT_FAILED',message:'private',at:[{text:'private frame'}]});
  store.write({continuous_pcm_admission:'rejected',code:'QUEUE_FULL',at:1000});
  store.write({kind:'resource_snapshot',encoder_backlog:3,gateway_packing_backlog:7,at:1000});
  const events=await store.read();assert.equal(events.length,3);
  assert.deepEqual(events[0],{central_text_failed:'CENTRAL_TEXT_FAILED',at:1000,channel:'unknown'});
  assert.equal(events[1]?.code,'QUEUE_FULL');assert.equal(events[2]?.gateway_packing_backlog,7);
  await store.close();
});
test('query results have an explicit record cap within disk bounds',async t=>{
  const path=await directory(t);
  await writeFile(join(path,'runtime-events.0.jsonl'),Array.from({length:10002},(_,count)=>JSON.stringify({voice_call_stage:'session_open',at:1000,count})+'\n').join(''));
  const store=new RuntimeEventStore({directory:path,now:()=>1000});
  const events=await store.read();assert.equal(events.length,10000);assert.equal(store.snapshot().query_truncated,true);
  assert.equal(events[0]?.count,2);assert.equal(events.at(-1)?.count,10001);
  await store.close();
});
test('symlink event files and store directory are rejected',async t=>{
  const path=await directory(t),target=join(path,'private');await writeFile(target,'private');
  await symlink(target,join(path,'runtime-events.0.jsonl'));
  const store=new RuntimeEventStore({directory:path});await assert.rejects(store.flush());
  assert.equal(await readFile(target,'utf8'),'private');
  const link=path+'-link';await symlink(path,link);t.after(()=>rm(link));
  await assert.rejects(new RuntimeEventStore({directory:link}).flush());
});
test('call turn metrics keep route, phase and counts but never the handoff text, usage or identifiers',async t=>{
  const store=new RuntimeEventStore({directory:await directory(t),now:()=>1000});
  store.write({voice_call_stage:'turn_metrics',call_id:'private-call',turn:3,phase:'front_complete',path:'front_only',at:1000,
    first_audio_ms:420,front_web_search_calls:1,repeated_exactly:false,asked_again:null,interrupted:true,
    difficulty:'前台判断可直接回答',handoff:{intent:'private request'},usage:[{response_id:'r',usage:{input_tokens:9}}]});
  store.write({voice_call_stage:'turn_recorded',call_id:'private-call',turn:3,processed_event_id:'d:private',path:'invented',at:1000});
  const [metrics,recorded]=await store.read();await store.close();
  assert.deepEqual(metrics,{voice_call_stage:'turn_metrics',at:1000,channel:'unknown',turn:3,phase:'front_complete',path:'front_only',
    first_audio_ms:420,front_web_search_calls:1,repeated_exactly:false,interrupted:true});
  assert.deepEqual(recorded,{voice_call_stage:'turn_recorded',at:1000,channel:'unknown',turn:3});
});

test('structured producer logs preserve redacted diagnostic messages, frames and causes across restart',async t=>{
  const path=await directory(t),options={directory:path};let store=new RuntimeEventStore(options);
  const detach=installRuntimeEventStore(store);t.after(detach);
  t.mock.method(process.stderr,'write',(()=>true) as never);
  emitRuntimeEvent({central_text_failed:'PHONE_TIMEOUT',message:'waiting for model token=synthetic-secret',at:['phone.step timeout'],cause_codes:['UPSTREAM_TIMEOUT']});
  emitRuntimeEvent({kind:'device_wait',logger:'gateway.phone',level:'WARNING',message:'waiting for device https://test-user:synthetic-password@host'});
  await store.close();detach();store=new RuntimeEventStore(options);
  const rows=await store.read();
  assert.equal(rows[1]?.logger,'gateway.phone');assert.equal(rows[1]?.level,'WARNING');assert.equal(rows[1]?.message,'waiting for device https://[redacted]@host');assert.equal(rows[0]?.message,'waiting for model token=[redacted]');
  assert.equal(rows[0]?.service,'gateway');assert.equal(rows[0]?.level,'ERROR');
  assert.deepEqual(rows[0]?.frames,['phone.step timeout']);assert.deepEqual(rows[0]?.cause_codes,['UPSTREAM_TIMEOUT']);
  assert.ok(!JSON.stringify(rows).includes('synthetic-secret'));assert.ok(!JSON.stringify(rows).includes('synthetic-password'));await store.close();
});
