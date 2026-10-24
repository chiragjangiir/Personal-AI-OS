import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {playRecordedCallSpeech,regressionErrandHeader,regressionRenderedAck,validateSimulatorOutput} from '../tools/mac-product-sim-client.ts';
import {createFormalWireAjv} from '../src/personal-aios-formal-text.ts';

test('wire validation accepts owner activity replay across continuities while preserving schema and other session bounds',()=>{
  const root=new URL('../../../../../integrations/contracts/',import.meta.url);
  const wire=JSON.parse(readFileSync(new URL('formal-message.v1.json',root),'utf8'));
  const {fixtures}=JSON.parse(readFileSync(new URL('activity-update.fixtures.json',root),'utf8'));
  const ajv=createFormalWireAjv();
  const validators=Object.fromEntries(['activity_update','ready'].map(operation=>
    [operation,ajv.compile({$defs:wire.$defs,...wire.outputs[operation]})]));
  const activity=fixtures.single_running,continuity='new-transport-continuity';
  assert.notEqual(activity.session_id,continuity);
  assert.equal(validators.activity_update(activity),true,JSON.stringify(validators.activity_update.errors));
  assert.strictEqual(validateSimulatorOutput(activity,continuity,validators),activity);
  const malformed={...activity,card:{...activity.card,preview:'private arguments'}};
  assert.throws(()=>validateSimulatorOutput(malformed,continuity,validators),/SIM_ACCEPTANCE_FAILED/);
  const ready={schema_version:wire.outputs.ready.properties.schema_version.const,operation:'ready',session_id:activity.session_id};
  assert.throws(()=>validateSimulatorOutput(ready,continuity,validators),/SIM_ACCEPTANCE_FAILED/);
  assert.deepEqual(validateSimulatorOutput({...ready,session_id:continuity},continuity,validators),{...ready,session_id:continuity});
});

function wav(rate=16000){
  const bytes=Buffer.alloc(44+640);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);
  bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(640,40);bytes.writeInt16LE(1234,44);return bytes;
}

test('recorded WAV reaches microphone; completion and quiet reply precede return',async()=>{
  const events:string[]=[],frames:Int16Array[]=[];let now=0,loud=0,replyComplete=false;
  const mic={captureFrame:async(frame:any)=>{frames.push(frame.data);},waitForPlayout:async()=>{events.push('input-played');}};
  const sent=await playRecordedCallSpeech(wav(),mic as never,{inputEnded:()=>events.push('input-ended'),
    complete:async()=>{events.push('reply-complete');replyComplete=true;},audibleSamples:()=>loud,check:()=>{}},
    {now:()=>now,wait:async ms=>{now+=ms;if(replyComplete&&now<4000)loud+=100;}});
  assert.equal(sent,320);assert.equal(frames[0]![0],1234);assert.equal(frames.length,76);
  assert.deepEqual(events,['input-played','input-ended','reply-complete']);assert.ok(now>=4500);
});

test('invalid speech format fails before microphone publication',async()=>{
  let frames=0;await assert.rejects(playRecordedCallSpeech(wav(24000),{
    captureFrame:async()=>{frames++;},waitForPlayout:async()=>{}} as never,
    {inputEnded:()=>{},complete:async()=>{},audibleSamples:()=>0,check:()=>{}}),/SIM_SPEECH_FORMAT_INVALID/);
  assert.equal(frames,0);
});

test('reply completion failure and endless audio cannot become successful playback',async()=>{
  const mic={captureFrame:async()=>{},waitForPlayout:async()=>{}} as never;
  await assert.rejects(playRecordedCallSpeech(wav(),mic,{inputEnded:()=>{},complete:async()=>{throw Error('reply failed');},
    audibleSamples:()=>0,check:()=>{}},{now:()=>0,wait:async()=>{}}),/reply failed/);
  let now=0;
  await assert.rejects(playRecordedCallSpeech(wav(),mic,{inputEnded:()=>{},complete:async()=>{},audibleSamples:()=>now,check:()=>{}},
    {now:()=>now,wait:async ms=>{now+=ms;}}),/SIM_REPLY_PLAYOUT_TIMEOUT/);
});

test('regression evidence refuses a production process before bootstrap',()=>{
  const root=mkdtempSync(join(tmpdir(),'staging-sim-'));
  try{
    const pairing=join(root,'pairing.json'),key=join(root,'recipient.json');
    writeFileSync(pairing,JSON.stringify({device_id:'test',origin:'https://invalid.invalid'}));writeFileSync(key,'{}');
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/mac-product-sim-client.ts',import.meta.url)),
      '--pairing',pairing,'--recipient-key',key,'--regression-evidence'],{encoding:'utf8',env:{...process.env,PAIOS_STAGE:'production'}});
    assert.notEqual(child.status,0);assert.match(child.stderr,/SIM_STAGING_REQUIRED/);assert.equal(child.stdout,'');
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('failed regression client output keeps exact accepted or header binding for trace collection',()=>{
  const module=fileURLToPath(new URL('../tools/mac-product-sim-client.ts',import.meta.url));
  const script=`import {regressionFailureBinding} from ${JSON.stringify(module)};
    const packets=[{operation:'accepted',event_id:'other',processed_event_id:'wrong',admission:{run_id:'wrong'}},
      {operation:'accepted',event_id:'current',processed_event_id:'d:current',admission:{run_id:'run_accepted'}},
      {operation:'result_header',event_id:'current',run_id:'run_current'}];
    console.log(JSON.stringify({steps:[{step:'playback',status:'failed',...regressionFailureBinding('current',packets)}]}));
    console.error('playback timeout');process.exitCode=1;`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(child.status,1);assert.match(child.stderr,/playback timeout/);
  assert.deepEqual(JSON.parse(child.stdout).steps[0],{step:'playback',status:'failed',event_id:'current',processed_event_id:'d:current',run_id:'run_current'});
});


test('async effect selects only the fresh authoritative job, independent of model wording',async()=>{
  const token='regression-'+'a'.repeat(32),device='phone',event='original';
  const header={operation:'result_header',event_id:'errand:job-current',processed_event_id:'d:report',run_id:'report-run',reply_mode:'text'};
  const source={operation:'accepted',event_id:event,processed_event_id:'d:source'};
  const accepted={operation:'accepted',event_id:header.event_id,processed_event_id:header.processed_event_id,admission:{run_id:header.run_id}};
  const original={d:{processed_event_id:'d:source',event_id:event,principal_id:'owner',device_id:device,origin:'explicit_user_prompt',content:{text:'read '+token}},session_id:'conversation'};
  const report={d:{processed_event_id:'d:report',principal_id:'owner',device_id:device,event_id:header.event_id,content:{app_event:{kind:'errand_result',job_id:'job-current',task:'read '+token,success:true,terminal_reason:'completed'}}},session_id:'conversation'};
  const packets=[source,accepted,header];
  const read=async(id:string)=>id==='d:source'?original:report;
  assert.equal(await regressionErrandHeader(packets,token,device,event,read),header);
  // Neither token nor job needs to appear in the model's natural-language report.
  for(const mutate of [
    (r:any)=>{r.d.principal_id='foreign';},(r:any)=>{r.d.device_id='other-device';},
    (r:any)=>{r.session_id='other-session';},(r:any)=>{r.d.content.app_event.task='old-token';},
    (r:any)=>{r.d.content.app_event.job_id='job-other';},(r:any)=>{r.d.content.app_event.success=false;}
  ]){
    const changed=structuredClone(report);mutate(changed);
    assert.equal(await regressionErrandHeader(packets,token,device,event,async id=>id==='d:source'?original:changed),undefined);
  }
  assert.equal(await regressionErrandHeader([accepted,source,header],token,device,event,read),undefined);
  assert.equal(await regressionErrandHeader([source,header],token,device,event,read),undefined);
});

test('async rendering requires the exact persisted ACK, never publication or another output receipt',()=>{
  const ack={output_id:'output:job',reply_id:'reply:job',reply_epoch:1,route_version:'route',target_device_id:'phone',highest_contiguous_seq:1,status:'rendered',observed_at:'2026-10-21T19:06:40Z'};
  const receipt={operation:'ack_receipt',processed_event_id:'d:job',receipt:{...ack,receipt_ref:'out-ack:job'}};
  assert.equal(regressionRenderedAck([], 'd:job',ack),false);
  assert.equal(regressionRenderedAck([receipt],'d:job',ack),true);
  assert.equal(regressionRenderedAck([receipt],'d:foreign',ack),false);
  for(const key of ['output_id','reply_id','reply_epoch','route_version','target_device_id','highest_contiguous_seq','status','observed_at']){
    const wrong=structuredClone(receipt);(wrong.receipt as any)[key]='wrong';
    assert.equal(regressionRenderedAck([wrong],'d:job',ack),false);
  }
});
