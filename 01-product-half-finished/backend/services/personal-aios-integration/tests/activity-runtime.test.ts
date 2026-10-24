import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime} from '../src/runtime.ts';
import {RunAdmission} from '../src/admission.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,canonical,digest,sha256} from '../src/contracts.ts';
import type {ActivityUpdate} from '../src/activity.ts';
import type {ErrandResult} from '../src/runtime.ts';
import {policy} from './sealed-replay-check.ts';
import {sourceClient} from './native-source-fixture.ts';

test('activity snapshot storage never delays terminal watcher attachment',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const list=f.storage.list.bind(f.storage);let attached=false;
  t.mock.method(f.storage,'list',async(...args:Parameters<typeof list>)=>{if(args[0]==='activity-cards'){entered.resolve();await release.promise;}return list(...args);});
  const opening=runtime.watchActivity(source,async()=>{},error=>f.errors.push(error)).then(stop=>{attached=true;return stop;});
  try {await entered.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(attached,true);}
  finally {release.resolve();}
  const stop=await opening;stop();assert.deepEqual(f.errors,[]);
});

test('blocked activity persistence retains the latest snapshot instead of accumulating writes',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),packets:ActivityUpdate[]=[],entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const replace=f.storage.replace.bind(f.storage);let writes=0;
  t.mock.method(f.storage,'replace',async(...args:Parameters<typeof replace>)=>{if(args[0]==='activity-cards'&&++writes===1){entered.resolve();await release.promise;}return replace(...args);});
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('blocked-save'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});await entered.promise;t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  try {for(let n=1;n<=6;n++){
    f.send('run-1',{event:'tool.started',public_intent:`正在处理第 ${n} 项`});await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(500);await new Promise(resolve=>setImmediate(resolve));
  }}finally {t.mock.timers.reset();release.resolve();}
  await until(()=>packets.at(-1)?.card.summary==='正在处理第 6 项');assert.ok(writes<=2,'only the in-flight save and latest snapshot are persisted');
  assert.equal(packets.length,1);stop();assert.deepEqual(f.errors,[]);
});

async function until(predicate:()=>boolean|Promise<boolean>){
  for(let n=0;n<400;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('activity lifecycle did not reach expected state');
}
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'paios-activity-')),storage=new PosixStorage(root);
  const runs=new Map<string,Record<string,unknown>>(),streams=new Map<string,ReadableStreamDefaultController<Uint8Array>>();
  const sequences=new Map<string,number>();
  const streamGets:string[]=[],errors:unknown[]=[],instances:PersonalAIOSRuntime[]=[];
  const native=new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',1000000,1048576,undefined,async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/api/sessions'||path.startsWith('/api/sessions/'))return Response.json({data:[]});
    if(path==='/v1/runs'){
      const body=JSON.parse(String(init?.body)),run={schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,
        profile_home:'/fixture',run_id:`run-${runs.size+1}`,session_id:body.session_id,conversation_session_id:body.session_id,
        status:'running',granted_toolsets:body.grant_toolsets};runs.set(run.run_id,run);return Response.json(run,{status:202});
    }
    const runId=path.split('/')[3]!,run=runs.get(runId);assert.ok(run);
    if(path.endsWith('/events')){
      streamGets.push(runId);return new Response(new ReadableStream<Uint8Array>({start(controller){
        streams.set(runId,controller);controller.enqueue(new TextEncoder().encode(`data: ${canonical({event:'run.snapshot',run_id:runId,timestamp:Date.now()/1000,seq:sequences.get(runId)??0,run,activity_events:[]})}\n\n`));init?.signal?.addEventListener('abort',()=>{if(streams.delete(runId))controller.close();},{once:true});
      },cancel(){streams.delete(runId);}}),{headers:{'content-type':'text/event-stream'}});
    }
    return Response.json(run);
  });
  const device={principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'formal',consent_ref:'consent',
    route_version:'r1',output_modes:['text'],token_sha256:sha256('fixture')};
  const make=async()=>{
    const admission=new RunAdmission(storage,native,policy),runtime=new PersonalAIOSRuntime({storage,admission,native,
      archive:new RawArchive(storage,65536),output:new OutputAuthority(storage),devices:[device],skill:'fixed',max_read_bytes:65536});
    instances.push(runtime);return {runtime,admission,source:await runtime.authenticate('fixture')};
  };
  t.after(async()=>{await Promise.all(instances.map(runtime=>runtime.close()));await storage.close();await rm(root,{recursive:true,force:true});});
  const raw=(id:string,voice=false)=>({schema_version:EVENT_SCHEMA,event_id:id,device_id:device.device_id,device_type:device.device_type,
    captured_at:new Date().toISOString(),source:{channel:device.channel},media_type:voice?'app_event' as const:'text' as const,
    mime:voice?'application/json':'text/plain;charset=utf-8',representation:'uploaded_original' as const,
    payload:Buffer.from(voice?canonical({kind:'voice_turn',call_id:'call-test',turn:1,speaker:'owner',user:'帮我检查资料',assistant:'',phase:'handoff'}):'帮我检查资料')});
  const send=(runId:string,event:Record<string,unknown>)=>{
    const run=runs.get(runId)!;if(event.event==='run.completed'){run.status='completed';run.updated_at=Date.now()/1000;}
    const seq=(sequences.get(runId)??0)+1;sequences.set(runId,seq);
    streams.get(runId)!.enqueue(new TextEncoder().encode(`data: ${canonical({run_id:runId,timestamp:Date.now()/1000,seq,tool_call_id:'tool-fixture',...event,
      ...(event.event==='run.completed'?{event:'run.updated',run}: {})})}\n\n`));
  };
  return {storage,runs,streams,streamGets,errors,make,raw,send};
}

for(const voice of [false,true])test(`owner ${voice?'voice':'text'} admission owns one SSE stream, activity survives reconnect and runtime restart`,async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make();const packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  const accepted=voice?await runtime.submitCallTurn(f.raw('owner-input',true),source,'session'):
    await runtime.submit(f.raw('owner-input'),source,'session',true);
  const processed=accepted.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-1'));assert.deepEqual(f.streamGets,['run-1']);
  const progress:string[]=[],abort=new AbortController();
  const watching=voice?runtime.watchCallProgress(source,'session',processed,text=>progress.push(text),abort.signal):Promise.resolve();
  f.send('run-1',{event:'message.interim',text:'正在检查资料'});f.send('run-1',{event:'tool.started',name:'private_tool',public_intent:'正在检查资料'});
  await until(()=>packets.length>0&&(!voice||progress.length>0));
  assert.equal(packets.at(-1)!.processed_event_id,processed);assert.equal(packets.at(-1)!.card.summary,'正在检查资料');
  if(voice)assert.deepEqual(progress,['正在检查资料']);assert.deepEqual(f.streamGets,['run-1'],'call progress shares admission SSE');
  stop();const reconnect:ActivityUpdate[]=[];
  const disconnect=await runtime.watchActivity(source,async packet=>{reconnect.push(packet);},error=>f.errors.push(error));
  await until(()=>reconnect.length>0);assert.deepEqual(reconnect.at(-1),packets.at(-1));
  f.send('run-1',{event:'tool.completed'});f.send('run-1',{event:'run.completed'});f.runs.get('run-1')!.status='completed';
  await until(()=>reconnect.at(-1)?.card.state==='succeeded');await watching;abort.abort();disconnect();
  const terminal=reconnect.at(-1)!;assert.equal((await admission.readOnly('owner','session',processed))?.state,'completed');
  assert.equal((await f.storage.list('activity-cards')).length,1);await runtime.close();
  const restarted=await f.make(),replayed:ActivityUpdate[]=[];
  const close=await restarted.runtime.watchActivity(restarted.source,async packet=>{replayed.push(packet);},error=>f.errors.push(error));
  await until(()=>replayed.length>0);assert.deepEqual(replayed,[terminal]);assert.deepEqual(f.streamGets,['run-1']);
  close();assert.deepEqual(f.errors,[]);
});

test('phone task origin binds only its owner input; real errand completion owns activity beyond run final',async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  const accepted=await runtime.submit(f.raw('phone-request'),source,'session',true),processed=accepted.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-1'));f.send('run-1',{event:'tool.started'});await until(()=>packets.length>0);
  const binding=await runtime.phoneTaskContext({run_id:'run-1',session_id:'session',tool_call_id:'phone-call'});
  assert.equal(binding.origin_processed_event_id,processed);
  const persisted=JSON.parse(Buffer.from(await f.storage.read('errand-origins',digest({principal_id:'owner',job_id:binding.job_id}))).toString());
  assert.deepEqual(persisted,binding);
  const job={job_id:binding.job_id,title:'打开云手机',app:'phone',state:'running' as const,started_at:new Date().toISOString(),step:1,max_steps:10};
  const jobs=[job];for(let n=1;n<9;n++){
    const extra=await runtime.phoneTaskContext({run_id:'run-1',session_id:'session',tool_call_id:`phone-call-${n}`});
    jobs.push({...job,job_id:extra.job_id,title:`处理第 ${n+1} 件事`});
  }
  let refreshed=0;runtime.setErrandRefresh(async()=>{
    refreshed++;await runtime.errandProgress('owner',[{...job,job_id:'unbound-job',title:'不可显示的无来源任务'},...jobs],error=>f.errors.push(error));
  });
  f.send('run-1',{event:'tool.completed'});f.send('run-1',{event:'run.completed'});f.runs.get('run-1')!.status='completed';
  await until(async()=>(await admission.readOnly('owner','session',processed))?.state==='completed');
  await until(()=>packets.at(-1)?.card.counts.total===9);assert.equal(packets.at(-1)!.card.state,'running');
  assert.equal(packets.at(-1)!.card.items.length,8);assert.equal(packets.at(-1)!.card.omitted_items,1);
  assert.ok(refreshed>0);assert.ok(packets.every(packet=>packet.card.state==='running'),'terminal sweep loads pending errand before card settlement');
  assert.equal(packets.at(-1)!.card.items[0]!.summary,'打开云手机');
  for(const pending of jobs)await runtime.deliverErrand({principal_id:'owner',job_id:pending.job_id,task:'private raw task',answer:'private raw result',
    success:true,finished_at:new Date().toISOString(),terminal_reason:'completed'},error=>f.errors.push(error));
  await until(()=>packets.at(-1)?.card.state==='succeeded');assert.equal(packets.at(-1)!.card.counts.succeeded,9);
  assert.ok(!canonical(packets).includes('private raw'));stop();assert.deepEqual(f.errors,[]);
});

test('replay within the coalescing window returns only the previous durable revision',async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('coalesced'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});await until(()=>packets.length===1);const saved=packets[0]!;
  t.mock.timers.enable({apis:['setTimeout']});
  f.send('run-1',{event:'tool.started',public_intent:'正在整理最新结果'});f.streams.get('run-1')!.close();
  // Drain source callbacks without advancing the independent 500 ms publication timer.
  await admission.drainEvents('run-1');
  const replayed:ActivityUpdate[]=[];await runtime.replayActivity(source,async packet=>{replayed.push(packet);});
  assert.deepEqual(replayed,[saved]);assert.equal(packets.length,1);
  t.mock.timers.tick(500);t.mock.timers.reset();await until(()=>packets.length===2);
  assert.equal(packets[1]!.card.summary,'正在整理最新结果');assert.ok(packets[1]!.card.revision>saved.card.revision);stop();
});

test('cards that ended over ten minutes ago are neither replayed nor reloaded; a run without tools keeps nothing',async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('with-tool'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});f.send('run-1',{event:'run.completed'});f.runs.get('run-1')!.status='completed';
  await until(()=>packets.at(-1)?.card.state==='succeeded');
  const plain=await runtime.submit(f.raw('no-tool'),source,'session',true);await until(()=>f.streams.has('run-2'));
  f.send('run-2',{event:'run.completed'});f.runs.get('run-2')!.status='completed';
  await until(async()=>(await admission.readOnly('owner','session',plain.processed_event.processed_event_id))?.state==='completed');
  await until(()=>(runtime as unknown as {activities:Map<string,unknown>}).activities.size===1);
  const recent:ActivityUpdate[]=[];await runtime.replayActivity(source,async packet=>{recent.push(packet);});
  assert.deepEqual(recent,[packets.at(-1)]);stop();
  t.mock.timers.enable({apis:['Date'],now:Date.now()+11*60_000});
  const late:ActivityUpdate[]=[];await runtime.replayActivity(source,async packet=>{late.push(packet);});assert.deepEqual(late,[]);
  await runtime.close();const next=await f.make(),reloaded:ActivityUpdate[]=[];
  await next.runtime.replayActivity(next.source,async packet=>{reloaded.push(packet);});assert.deepEqual(reloaded,[]);
  t.mock.timers.reset();assert.deepEqual(f.errors,[]);
});

test('restart reconciles a running card with the already durable admission terminal',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('terminal-checkpoint'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});await until(()=>packets.length>0);
  const key=(await f.storage.list('activity-cards'))[0]!,checkpoint=await f.storage.read('activity-cards',key),revision=packets[0]!.card.revision;
  f.send('run-1',{event:'run.completed'});f.runs.get('run-1')!.status='completed';
  await until(()=>packets.at(-1)?.card.state==='succeeded');stop();await runtime.close();
  const completedAt=packets.at(-1)!.card.completed_at;
  // Crash checkpoint: the admission is terminal, but its durable card is still running.
  await f.storage.replace('activity-cards',key,checkpoint);
  const next=await f.make(),replayed:ActivityUpdate[]=[];
  const detach=await next.runtime.watchActivity(next.source,async packet=>{replayed.push(packet);},error=>f.errors.push(error));
  await until(()=>replayed.at(-1)?.card.state==='succeeded');assert.ok(replayed.at(-1)!.card.revision>revision);
  assert.equal(replayed.at(-1)!.card.completed_at,completedAt);
  assert.deepEqual(f.streamGets,['run-1']);detach();assert.deepEqual(f.errors,[]);
});

test('a failed activity save is reported and the next terminal snapshot resumes durable publication',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),packets:ActivityUpdate[]=[],logged:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>{logged.push(args);});
  const replace=f.storage.replace.bind(f.storage);let fail=true;
  t.mock.method(f.storage,'replace',async(...args:Parameters<typeof replace>)=>{
    if(args[0]==='activity-cards'&&fail){fail=false;throw new Error('SYNTHETIC_ACTIVITY_SAVE_FAILURE');}return replace(...args);
  });
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('save-failure'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});await until(()=>logged.length>0);
  assert.equal(packets.length,0);assert.deepEqual(await f.storage.list('activity-cards'),[]);
  assert.equal(logged[0]![0],'ACTIVITY_PUBLICATION_FAILED');assert.match(String(logged[0]![1]),/SYNTHETIC_ACTIVITY_SAVE_FAILURE/);
  f.send('run-1',{event:'tool.completed'});f.send('run-1',{event:'run.completed'});f.runs.get('run-1')!.status='completed';
  await until(()=>packets.at(-1)?.card.state==='succeeded');assert.equal((await f.storage.list('activity-cards')).length,1);
  const replayed:ActivityUpdate[]=[];await runtime.replayActivity(source,async packet=>{replayed.push(packet);});
  assert.deepEqual(replayed,[packets.at(-1)]);assert.equal(logged.length,1);stop();assert.deepEqual(f.errors,[]);
});

test('delegated heartbeat persists and replays without poisoning activity publication',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),packets:ActivityUpdate[]=[],logged:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>{logged.push(args);});
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('delegated-heartbeat'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});await until(()=>packets.length>0);
  const at=Date.now();
  f.send('run-1',{event:'subagent.start',timestamp:at/1000,subagent_id:'child-test',goal:'检查测试资料'});
  f.send('run-1',{event:'subagent.progress',timestamp:(at+1)/1000,subagent_id:'child-test',tool_call_id:'child-tool',progress:1,total:4});
  f.send('run-1',{event:'subagent.progress',timestamp:(at+2)/1000,subagent_id:'child-test',tool_count:1});
  try {
    await until(()=>logged.length>0||packets.at(-1)?.card.last_progress_at===new Date(at+2).toISOString());
    const replayed:ActivityUpdate[]=[];await runtime.replayActivity(source,async packet=>{replayed.push(packet);});
    assert.equal(replayed[0]!.card.items.length,1);
    assert.equal(Object.hasOwn(replayed[0]!.card.items[0]!,'progress'),false);
    const key=(await f.storage.list('activity-cards'))[0]!;
    const saved=JSON.parse(Buffer.from(await f.storage.read('activity-cards',key)).toString());
    assert.deepEqual(saved.packet,replayed[0]);assert.deepEqual(saved.items,saved.packet.card.items);
    assert.deepEqual(logged,[]);assert.deepEqual(f.errors,[]);
  }finally {
    f.send('run-1',{event:'subagent.complete',subagent_id:'child-test',status:'completed',exit_reason:'completed',outcome:'succeeded',outcome_reason:''});
    f.send('run-1',{event:'run.completed'});
    await until(()=>packets.at(-1)?.card.state==='succeeded');stop();
  }
  await runtime.close();const next=await f.make(),replayed:ActivityUpdate[]=[];
  await next.runtime.replayActivity(next.source,async packet=>{replayed.push(packet);});assert.deepEqual(replayed,[packets.at(-1)]);
});

for(const kind of ['errand_result','errand_delivery_failed'] as const)test(`failed task → ${kind} self-check persists, publishes and replays`,async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[],logged:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>{logged.push(args);});
  let stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  const accepted=await runtime.submit(f.raw('failed-task'),source,'session',true),origin=accepted.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-1'));f.send('run-1',{event:'tool.started'});await until(()=>packets.length>0);
  const binding=await runtime.phoneTaskContext({run_id:'run-1',session_id:'session',tool_call_id:'failed-phone-call'});
  await runtime.errandProgress('owner',[{job_id:binding.job_id,title:'查询测试资料',app:'fixture',state:'running',
    started_at:new Date().toISOString(),step:1,max_steps:4}],error=>f.errors.push(error));
  f.send('run-1',{event:'tool.completed'});f.send('run-1',{event:'run.completed'});
  await until(async()=>(await admission.readOnly('owner','session',origin))?.state==='completed');
  const failure:ErrandResult={principal_id:'owner',job_id:binding.job_id,origin_processed_event_id:origin,
    title:'查询测试资料',task:'查询测试资料',app:'fixture',tier:'fast',success:false,answer:'synthetic timeout',
    finished_at:new Date().toISOString(),terminal_reason:'timed_out',retryable:false,
    evidence_ref:{tool:'phone_status',job_id:binding.job_id}};
  // The receipt has a title but no progress timestamp, exactly like the terminal executor wire shape.
  await runtime.deliverErrand(failure,error=>f.errors.push(error));
  await until(()=>packets.at(-1)?.card.state==='failed');const original=packets.at(-1)!;
  const raw=f.raw(`failure-${kind}`),app=kind==='errand_result'?{kind,...failure}:{kind,principal_id:'owner',
    job_id:binding.job_id,origin_processed_event_id:origin,title:failure.title!,task:failure.task,
    terminal_reason:'failed',evidence_ref:failure.evidence_ref!,status:'failed',error_code:'ERRAND_REPORT_NOT_DELIVERED'};
  const check=await runtime.submitErrand({...raw,media_type:'app_event',mime:'application/json',payload:Buffer.from(canonical(app))},source,'session');
  const processed=check.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-2'));
  f.send('run-2',{event:'tool.started',public_intent:''});f.send('run-2',{event:'tool.completed'});
  f.send('run-2',{event:'subagent.start',subagent_id:'self-check',goal:'自检：查询测试资料'});
  f.send('run-2',{event:'subagent.progress',subagent_id:'self-check',tool_count:5});
  try {
    await until(()=>packets.some(packet=>packet.processed_event_id===processed&&packet.card.items.length===1));
    const running=packets.findLast(packet=>packet.processed_event_id===processed)!;
    assert.equal(running.card.items[0]!.summary,'自检：查询测试资料');
    assert.equal(Object.hasOwn(running.card.items[0]!,'progress'),false);
    const saved=JSON.parse(Buffer.from(await f.storage.read('activity-cards',digest(['owner','session',processed]))).toString());
    assert.deepEqual(JSON.parse(canonical(saved)).packet,running);assert.deepEqual(saved.items,running.card.items);
    stop();const reconnect:ActivityUpdate[]=[];
    stop=await runtime.watchActivity(source,async packet=>{reconnect.push(packet);},error=>f.errors.push(error));
    await until(()=>reconnect.some(packet=>packet.processed_event_id===processed));
    assert.deepEqual(reconnect.find(packet=>packet.processed_event_id===processed),running);
    f.send('run-2',{event:'subagent.complete',subagent_id:'self-check',status:'completed',exit_reason:'completed',
      outcome:'partial',outcome_reason:'故障原因已查明，原任务尚未完成'});f.send('run-2',{event:'run.completed'});
    await until(()=>reconnect.some(packet=>packet.processed_event_id===processed&&packet.card.state==='partial'));
    const terminal=reconnect.findLast(packet=>packet.processed_event_id===processed)!;
    assert.equal(terminal.card.counts.partial,1);assert.equal(terminal.card.failure_reason,'故障原因已查明，原任务尚未完成');
    stop();await runtime.close();const next=await f.make(),replayed:ActivityUpdate[]=[];
    await next.runtime.replayActivity(next.source,async packet=>{replayed.push(packet);});
    assert.deepEqual(replayed.find(packet=>packet.processed_event_id===processed),terminal);
    assert.deepEqual(replayed.find(packet=>packet.processed_event_id===origin),original);
    assert.equal(replayed.length,2);assert.deepEqual(logged,[]);assert.deepEqual(f.errors,[]);
  }finally {stop();}
});

test('an errand observation without a verified owner origin cannot publish an activity card',async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[];
  const raw=f.raw('unbound-result');
  await runtime.submitErrand({...raw,media_type:'app_event',mime:'application/json',payload:Buffer.from(canonical({
    kind:'errand_result',principal_id:'owner',job_id:'unbound-job',title:'测试资料',task:'测试资料',success:false,
    answer:'synthetic timeout',finished_at:new Date().toISOString(),terminal_reason:'timed_out'}))},source,'session');
  await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});f.send('run-1',{event:'subagent.start',subagent_id:'unbound',goal:'自检：测试资料'});
  f.send('run-1',{event:'run.completed'});await admission.drainEvents('run-1');
  await runtime.replayActivity(source,async packet=>{packets.push(packet);});
  assert.deepEqual(packets,[]);assert.deepEqual(await f.storage.list('activity-cards'),[]);assert.deepEqual(f.errors,[]);
});

test('a fast errand result is projected without exposing raw task or answer text',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  await runtime.submit(f.raw('fast-errand'),source,'session',true);await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started'});await until(()=>packets.length>0);
  const binding=await runtime.phoneTaskContext({run_id:'run-1',session_id:'session',tool_call_id:'fast-phone'});
  await runtime.deliverErrand({...binding,task:'原始任务参数不可显示',answer:'原始结果不可显示',success:true,finished_at:new Date().toISOString()},error=>f.errors.push(error));
  f.send('run-1',{event:'run.completed'});f.runs.get('run-1')!.status='completed';
  await until(()=>packets.at(-1)?.card.state==='succeeded');
  assert.equal(packets.at(-1)!.card.items[0]!.summary,'正在处理这件事');
  assert.ok(!JSON.stringify(packets).includes('不可显示'));stop();assert.deepEqual(f.errors,[]);
});

test('authoritative final status before buffered SSE still settles the late-created activity card',async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  const accepted=await runtime.submit(f.raw('fast-final'),source,'session',true),processed=accepted.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-1'));f.runs.get('run-1')!.status='completed';
  assert.notEqual((await admission.readOnly('owner','session',processed))?.state,'completed');
  assert.equal(packets.length,0);
  f.send('run-1',{event:'message.interim',text:'正在核验资料'});f.send('run-1',{event:'tool.started',public_intent:'正在核验资料'});
  f.send('run-1',{event:'tool.completed'});f.send('run-1',{event:'run.completed'});
  await until(()=>packets.at(-1)?.card.state==='succeeded');
  assert.equal(packets.at(-1)!.card.summary,'正在核验资料');stop();assert.deepEqual(f.errors,[]);
});

test('voice progress drains pre-watch commentary in order and reattachment never repeats spoken text',async t=>{
  const f=await fixture(t),{runtime,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  const accepted=await runtime.submitCallTurn(f.raw('buffered-voice',true),source,'session'),processed=accepted.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'message.interim',text:'正在查看资料'});f.send('run-1',{event:'message.interim',text:'正在核验结果'});
  f.send('run-1',{event:'tool.started'});await until(()=>packets.length>0);
  const first:string[]=[],abortFirst=new AbortController();
  const watchingFirst=runtime.watchCallProgress(source,'session',processed,text=>first.push(text),abortFirst.signal);
  await until(()=>first.length===2);assert.deepEqual(first,['正在查看资料','正在核验结果']);abortFirst.abort();await watchingFirst;
  const next:string[]=[],abortNext=new AbortController();
  const watchingNext=runtime.watchCallProgress(source,'session',processed,text=>next.push(text),abortNext.signal);
  f.send('run-1',{event:'message.interim',text:'已经整理好资料'});await until(()=>next.includes('已经整理好资料'));
  assert.deepEqual(next,['已经整理好资料']);assert.deepEqual(f.streamGets,['run-1']);
  f.send('run-1',{event:'run.completed'});await watchingNext;
  assert.equal(f.runs.get('run-1')!.status,'completed','authoritative stream state settles progress and admission together');
  const replayed:string[]=[];
  await runtime.watchCallProgress(source,'session',processed,text=>replayed.push(text),new AbortController().signal);
  assert.deepEqual(replayed,[]);stop();assert.deepEqual(f.errors,[]);
});

test('duplicate events are ignored and a sequence gap recovers from the same native snapshot',async t=>{
  const f=await fixture(t),{runtime,admission,source}=await f.make(),packets:ActivityUpdate[]=[];
  const stop=await runtime.watchActivity(source,async packet=>{packets.push(packet);},error=>f.errors.push(error));
  const accepted=await runtime.submit(f.raw('sequence-recovery'),source,'session',true),processed=accepted.processed_event.processed_event_id;
  await until(()=>f.streams.has('run-1'));
  f.send('run-1',{event:'tool.started',public_intent:'正在检查资料'});await until(()=>packets.length>0);
  const revision=packets.at(-1)!.card.revision;
  f.send('run-1',{event:'tool.started',seq:1,public_intent:'重复事件不可覆盖'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(packets.at(-1)!.card.revision,revision);
  const run=f.runs.get('run-1')!;run.seq=5;run.activity_events=[
    {event:'tool.started',run_id:'run-1',seq:1,timestamp:Date.now()/1000,tool_call_id:'tool-fixture',public_intent:'正在检查资料'},
    {event:'tool.progress',run_id:'run-1',seq:5,timestamp:Date.now()/1000,tool_call_id:'tool-fixture',progress:3,total:4}];
  f.send('run-1',{event:'tool.progress',seq:5,progress:3,total:4});
  await until(()=>packets.at(-1)?.card.progress?.value===3);
  assert.deepEqual(packets.at(-1)!.card.progress,{version:1,value:3,total:4});
  assert.equal(admission.get('owner','session',processed)?.state,'running');
  assert.equal(f.runs.size,1);assert.ok(!JSON.stringify(packets).includes('重复事件不可覆盖'));stop();
});
