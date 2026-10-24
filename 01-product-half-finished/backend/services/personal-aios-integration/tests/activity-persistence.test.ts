import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ActivityProjection,type ActivityItem,type ActivitySaved} from '../src/activity.ts';
import {canonical} from '../src/contracts.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256,type NativeRunEvent} from '../src/hermes-client.ts';

const events=JSON.parse(readFileSync(new URL('./fixtures/activity-persistence-events.json',import.meta.url),'utf8')) as
  {staged:NativeRunEvent[];native:NativeRunEvent[]};
const base=Date.parse('2026-10-19T16:28:00.000Z');
const start:NativeRunEvent={event:'tool.started',run_id:'run-test',timestamp:base/1000,tool_call_id:'tool-test'};
function projection(t:test.TestContext,saved?:ActivitySaved){
  const value=new ActivityProjection('owner','session-test','processed-test',()=>{},()=>base+120000,saved);
  t.after(()=>value.close());return value;
}
function roundTrip(value:ActivityProjection){
  const saved=value.snapshot()!;assert.ok(saved);
  const decoded=JSON.parse(canonical(saved)) as ActivitySaved;
  assert.deepEqual(decoded,saved);return decoded;
}
async function feed(value:ActivityProjection,activity:NativeRunEvent[],snapshot:boolean){
  const frames=snapshot?[{event:'run.snapshot',run_id:'run-test',timestamp:(base+120000)/1000,activity_events:activity,
    run:{schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',run_id:'run-test',status:'running'}}]:activity;
  const client=new HermesClient('http://127.0.0.1:1','synthetic-test-auth-value',10000,65536,undefined,async()=>
    new Response(frames.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}}));
  await client.events('run-test',event=>{value.event(event);roundTrip(value);});
}

for(const snapshot of [false,true]){
  test(`staged native lifecycle shapes persist through ${snapshot?'snapshot recovery':'live SSE'}`,async t=>{
    const value=projection(t);await feed(value,events.staged,snapshot);
    value.settle('completed');roundTrip(value);
  });
  test(`native delegated progress persists through ${snapshot?'snapshot recovery':'live SSE'}`,async t=>{
    const value=projection(t);await feed(value,events.native.slice(0,-1),snapshot);
    const saved=roundTrip(value);
    assert.equal(Object.hasOwn(saved.items[0]!,'progress'),false);
    assert.equal(Object.hasOwn(saved.packet.card.items[0]!,'progress'),false);
    assert.equal(Object.hasOwn(saved.packet.card,'progress'),false);
    const restored=projection(t,saved);assert.deepEqual(roundTrip(restored),saved);
    await feed(restored,events.native.slice(-1),false);restored.settle('completed');roundTrip(restored);
  });
}

for(const [index,progress] of events.native.filter(event=>event.event==='subagent.progress').entries()){
  const label=progress.total===undefined?progress.progress===undefined?'heartbeat':'without total':`total ${progress.total}`;
  test(`delegated progress ${index+1} (${label}) preserves JSON after numeric progress`,async t=>{
    const value=projection(t);
    await feed(value,[events.native[0]!,events.native[1]!,progress],false);
    const saved=roundTrip(value);
    if(progress.total&&progress.progress!==undefined)assert.deepEqual(saved.items[0]!.progress,{version:1,value:progress.progress,total:progress.total});
    else assert.equal(Object.hasOwn(saved.items[0]!,'progress'),false);
  });
}

for(const kind of ['subagent','errand'] as const)for(const status of ['completed','failed','interrupted']){
  test(`${kind} snapshot round trip preserves running and ${status} settlement`,t=>{
    let value=projection(t);value.event(start);
    if(kind==='subagent')value.event(events.native[0]!);
    else value.errand({job_id:'job-test',title:'检查测试资料',app:'phone',state:'running',
      started_at:new Date(base).toISOString(),step:1,max_steps:4});
    const saved=roundTrip(value);assert.equal(saved.items[0]!.kind,kind);
    value=projection(t,saved);value.settle(status);
    if(kind==='subagent'&&status==='completed')value.event({...events.native.at(-1)!,exit_reason:'completed',outcome:'succeeded',outcome_reason:''});
    if(kind==='errand')value.errand({principal_id:'owner',job_id:'job-test',task:'synthetic',success:status==='completed',
      answer:'synthetic',finished_at:new Date(base+120000).toISOString(),terminal_reason:status==='interrupted'?'cancelled_by_user':'completed'});
    assert.equal(roundTrip(value).packet.card.state,status==='completed'?'succeeded':status==='failed'?'failed':'cancelled');
  });
}

test('persisted task wire kind round trips with absent and present optional fields',t=>{
  // Task is a persisted wire kind; the native event producer currently creates subagents and errands.
  const value=projection(t);value.event(start);
  for(const state of ['running','succeeded','failed','partial','cancelled'] as const){
    const saved=roundTrip(value),item:ActivityItem={id:'i:task-test',kind:'task',state,summary:'检查测试资料',
      started_at:new Date(base).toISOString(),elapsed_ms:0,...(state==='running'?{}:{completed_at:new Date(base+1000).toISOString()}),
      ...(['failed','partial'].includes(state)?{failure_reason:'这件事未办成'}:{})};
    saved.items=[item];saved.packet.card.items=[item];
    saved.packet.card.state=state;saved.packet.card.counts={total:1,running:0,succeeded:0,failed:0,cancelled:0};saved.packet.card.counts[state]=1;
    if(item.completed_at)saved.packet.card.completed_at=item.completed_at;
    if(item.failure_reason)saved.packet.card.failure_reason=item.failure_reason;
    assert.deepEqual(roundTrip(projection(t,saved)),saved);
  }
});

for(const state of ['succeeded','failed','partial','cancelled'] as const)test(`titled ${state} errand receipt is JSON before any progress`,t=>{
  const value=projection(t);value.event(start);
  const finished_at=new Date(base+1000).toISOString();
  value.errand({principal_id:'owner',job_id:'job-test',origin_processed_event_id:'processed-test',title:'检查测试资料',
    task:'检查测试资料',app:'fixture',tier:'fast',success:state==='succeeded',answer:'synthetic receipt',finished_at,
    terminal_reason:state==='cancelled'?'cancelled_by_user':state==='succeeded'?'completed':'timed_out',retryable:false,
    evidence_ref:{tool:'phone_status',job_id:'job-test'},...(state==='partial'?{partial_findings:{
      verified:['synthetic finding'],not_verified:['synthetic gap'],last_screen_text:'synthetic screen',truncated:false}}:{})});
  value.settle('completed');const saved=roundTrip(value),item=saved.items[0]!;
  assert.equal(item.state,state);assert.equal(item.started_at,finished_at);assert.equal(item.completed_at,finished_at);
  assert.equal(item.elapsed_ms,0);assert.equal(saved.packet.card.state,state);
  assert.equal(Object.hasOwn(item,'step_summary'),false);assert.equal(Object.hasOwn(item,'progress'),false);
  assert.equal(canonical(saved).includes('synthetic finding'),false);
});

test('direct tool progress and a card without items omit unavailable optional fields',async t=>{
  const value=projection(t);value.event(start);
  for(const fields of [{progress:1,total:4},{progress:2},{progress:0,total:0}]){
    await feed(value,[{...start,event:'tool.progress',...fields}],false);
  }
  value.event({...start,event:'tool.completed'});value.settle('failed');roundTrip(value);
});

test('a total without a value is rejected on SSE and cannot create an undefined snapshot value',async t=>{
  const value=projection(t);value.event(start);
  const event={...start,event:'tool.progress',total:4};
  await assert.rejects(feed(value,[event],false),{code:'HERMES_TOOL_PROGRESS_INVALID'});
  value.event(event);const saved=roundTrip(value);
  assert.equal(Object.hasOwn(saved.packet.card,'progress'),false);
});

test('overflowing JSON numbers never reach an activity snapshot from live or recovery frames',async t=>{
  for(const snapshot of [false,true])for(const field of ['timestamp','progress','total'])for(const number of ['1e400','-1e400']){
    const value=projection(t);value.event(start);const before=roundTrip(value);
    const event={...start,event:'subagent.progress',subagent_id:'child-test',progress:1,total:4,[field]:'overflow'};
    const frame=snapshot?{event:'run.snapshot',run_id:'run-test',timestamp:base/1000,activity_events:[event],
      run:{schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',run_id:'run-test',status:'running'}}:event;
    const client=new HermesClient('http://127.0.0.1:1','synthetic-test-auth-value',10000,65536,undefined,async()=>
      new Response(`data: ${JSON.stringify(frame).replace('"overflow"',number)}\n\n`,{headers:{'content-type':'text/event-stream'}}));
    await assert.rejects(client.events('run-test',event=>value.event(event)),{
      code:field==='timestamp'?'HERMES_PROGRESS_BINDING_INVALID':'HERMES_TOOL_PROGRESS_INVALID'});
    assert.deepEqual(roundTrip(value),before);
  }
});
