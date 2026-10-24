import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runtimeAggregates,memoryLayerCounts} from '../src/self-metrics.ts';
import {PosixStorage} from '../src/storage.ts';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';
import {emitRuntimeEvent,RuntimeEventStore} from '../src/self-events.ts';

test('retained fixtures aggregate calls, verdicts by channel, failures, latency and backlog',()=>{
  const rows=[{voice_call_stage:'session_open'},{voice_call_stage:'turn_commit'},
    {voice_call_stage:'turn_speaker',channel:'phone',verdict:'owner',score:.9},
    {voice_call_stage:'turn_speaker',channel:'phone',verdict:'uncertain',score:.5},
    {voice_call_stage:'turn_speaker',channel:'glasses',verdict:'guest',score:.1},
    {voice_call_stage:'turn_speaker',verdict:'unknown'},
    ...[10,20,100].map(duration_ms=>({voice_call_stage:'front_connected',duration_ms})),
    {voice_call_event:'error',code:'PROVIDER_BUSY'}, {central_text_failed:'QUEUE_FULL'},
    {kind:'resource_snapshot',encoder_backlog:4},{kind:'resource_snapshot',encoder_backlog:2},
    {vidu_component_stage:'ready'}];
  const a=runtimeAggregates(rows);assert.equal(a.calls,1);assert.equal(a.turns,1);
  assert.deepEqual(a.speakers.phone?.verdicts,{owner:1,uncertain:1});assert.equal(a.speakers.phone?.scores.mean,.7);
  assert.equal(a.speakers.glasses?.verdicts.guest,1);assert.equal(a.speakers.unknown?.verdicts.unknown,1);
  assert.equal(a.failures.PROVIDER_BUSY,1);assert.equal(a.failures.QUEUE_FULL,1);
  assert.deepEqual(a.latencies_ms['front_connected.duration_ms'],{samples:3,min:10,p50:20,p95:100,p99:100,max:100});
  assert.equal(a.backlog_max.encoder_backlog,4);assert.equal(a.stages.ready,1);assert.match(a.interpretation,/not labeled accuracy/);
  assert.equal(runtimeAggregates([]).calls,0);
});

test('windowed channel voiceprint counts separate verdict rates from score coverage',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'self-voiceprint-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new RuntimeEventStore({directory,now:()=>1000});t.after(()=>store.close());
  for(const event of [
    {voice_call_stage:'turn_speaker',channel:'phone',at:900,verdict:'owner',score:.1},
    {voice_call_stage:'turn_speaker',channel:'phone',at:950,verdict:'owner',score:.9},
    {voice_call_stage:'turn_speaker',channel:'phone',at:960,verdict:'uncertain',score:.5},
    {ambient_stage:'speaker_verdict',channel:'phone',at:970,verdict:'owner',score:null},
    {ambient_stage:'speaker_verdict',channel:'phone',at:980,verdict:'unknown',score:NaN},
    {voice_call_stage:'turn_speaker',channel:'glasses',at:960,verdict:'guest',score:.2},
    {kind:'approval',channel:'phone',at:960,verdict:'accepted'},
    {voice_call_stage:'turn_speaker',channel:'phone',at:990,verdict:'owner',score:1},
  ])store.write(event);
  const result=runtimeAggregates(await store.read({since:950,until:980,channel:'phone'}));
  assert.equal(result.events,5);assert.deepEqual(Object.keys(result.speakers),['phone']);
  const phone=result.speakers.phone;
  assert.equal(phone.count,4);
  assert.deepEqual(phone.counts,{verified:2,uncertain:1});
  assert.deepEqual(phone.rates,{verified:.5,uncertain:.25});
  assert.deepEqual(phone.scoring,{scored:2,unscored:2,scored_rate:.5,unscored_rate:.5});
  assert.deepEqual(phone.sources,{turn_speaker:2,speaker_verdict:2});
  assert.deepEqual(phone.scores,{samples:2,min:.5,p50:.5,p95:.9,p99:.9,max:.9,mean:.7});
  assert.deepEqual(runtimeAggregates(await store.read({since:1000,until:1000})).speakers,{});
  const unscored=runtimeAggregates([{voice_call_stage:'turn_speaker',verdict:'unknown',score:Infinity}]).speakers.unknown;
  assert.deepEqual(unscored.scoring,{scored:0,unscored:1,scored_rate:0,unscored_rate:1});
  assert.deepEqual(unscored.scores,{samples:0,min:null,p50:null,p95:null,p99:null,max:null,mean:null});
});

test('memory counts reuse paged L3 authority, hot object metadata and public voiceprint owner status',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'self-layers-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const storage=new PosixStorage(directory);await storage.publish('objects','a'.repeat(64),Buffer.from('private original'));
  let page=0;const l3={query:async(ctx:any,_id:any,_status:any,options:any)=>{
    assert.equal(ctx.principal_id,'owner');assert.equal(options.cursor,page?'next':undefined);
    return {assertions:Array(page++?1:2).fill({}),next_cursor:page===1?'next':null,truncated:page===1};}};
  const counts=await memoryLayerCounts({storage,principal:'owner',l3:l3 as never,voiceprint:{owner:async()=>({enrolled:true,samples:3})} as never});
  assert.deepEqual(counts.l3,{assertions:3,complete:true,scope:'applicable active and candidate assertions'});
  assert.equal(counts.l5.hot_bytes,16);assert.equal(counts.l5.hot_objects,1);assert.equal(counts.l5.cold_configured,false);
  assert.deepEqual(counts.voiceprint,{enrolled:true,samples:3});assert.ok(!JSON.stringify(counts).includes('private original'));
  await assert.rejects(memoryLayerCounts({storage,principal:'owner',busy:()=>true}),/SELF_BACKGROUND_BUSY/);
});

test('central provision owns and releases the process event sink across restarts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'self-provision-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {writeFile}=await import('node:fs/promises');await writeFile(join(root,'key'),'self-provision-synthetic-token-123456',{mode:0o600});await writeFile(join(root,'skill'),'synthetic skill');
  const config:CentralProvisionConfiguration={storage_root:join(root,'data'),lock_file:join(root,'lock'),port:18898,hermes_base_url:'http://127.0.0.1:1',hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:8192,max_event_bytes:8192,max_read_bytes:8192,admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'self-provision'}};
  for(const score of [.8,.9]){
    const provision=await provisionCentralResources(config);
    try{emitRuntimeEvent({voice_call_stage:'turn_speaker',channel:'phone',verdict:'owner',score,at:Date.now()});
      assert.equal((await provision.resources.self_events!.read()).at(-1)?.score,score);
    }finally{await provision.release();}
    assert.equal(provision.resources.self_events!.snapshot().closed,true);
  }
});
