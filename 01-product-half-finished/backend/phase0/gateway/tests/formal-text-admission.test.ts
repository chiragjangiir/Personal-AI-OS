import test from 'node:test';
import assert from 'node:assert/strict';
import {DataPacketKind,RoomEvent} from '@livekit/rtc-node';
import {createFormalTextIngress,FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';

const deferred=()=>Promise.withResolvers<void>();
// Drain promise continuations at an event-loop boundary, without an elapsed-time assumption.
const drained=()=>new Promise<void>(done=>setImmediate(done));
async function fixture(t: test.TestContext,device_id:string,hold:'auth'|'sdk'|'handler'|'voice'='auth') {
  const gate=deferred(),handlers=new Map<string,(...args:unknown[])=>void>(),errors:unknown[]=[];
  const source={principal_id:'owner',device_id,device_type:'mac',capabilities:[],output_modes:['text']};
  let blocking=false,auth=0,entered=0,publication=0,cancels=0,closes=0,voices=0;
  const entries:ReturnType<typeof deferred>[]=[],authEntries:ReturnType<typeof deferred>[]=[],sdkEntries:ReturnType<typeof deferred>[]=[],controls=deferred();
  const controlEntered=()=>{if(cancels+closes===4)controls.resolve();};
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal'}]]),
    on:(event:string,fn:(...args:unknown[])=>void)=>handlers.set(event,fn),off:(event:string)=>handlers.delete(event),
    localParticipant:{sendText:async()=>{},publishData:async()=>{publication++;sdkEntries[publication-1]?.resolve();if(blocking&&hold==='sdk')await gate.promise;}}};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{auth++;authEntries[auth-1]?.resolve();if(blocking&&hold==='auth')await gate.promise;return source;},
    formalVoice:async(_source:unknown,_kind:unknown,work:()=>Promise<unknown>)=>work(),ownerControl:async()=>{},
    processVoice:async()=>{voices++;await gate.promise;return {events:[]};}};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime:runtime as never,
    authority:{credentialForBootstrap:()=>({})} as never,max_packet_bytes:12288,onError:error=>errors.push(error),
    voice_capture:{open:()=>{},cancel:()=>true,commit:async()=>({event_id:'voice-event',request:{} as never})},
    voice_call:{open:async()=>{},close:async()=>{closes++;controlEntered();},attach:()=>()=>{}},
    errands:{cancel:async()=>{cancels++;controlEntered();await gate.promise;return true;}},
    extensions:[{inputs:{admission_probe:{definition:{type:'object',required:['operation'],additionalProperties:false,
      properties:{operation:{const:'admission_probe'},padding:{type:'string'}}},error:'INVALID_PROBE'}},
      outputs:{probe_receipt:{type:'object',required:['schema_version','operation','session_id'],properties:{
        schema_version:{type:'string'},operation:{const:'probe_receipt'},session_id:{type:'string'}}}},
      handle:async(_op,_body,_source,publish)=>{entered++;entries[entered-1]?.resolve();
        if(hold==='handler')await gate.promise;else if(hold==='sdk')await publish({operation:'probe_receipt'});}}]});
  await bridge.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'session'}} as never);
  blocking=true;auth=0;
  t.after(async()=>{gate.resolve();await bridge.close();});
  const send=(body:unknown)=>{const bytes=Buffer.from(JSON.stringify(body));handlers.get(RoomEvent.DataReceived)?.(
    bytes,{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);return bytes.byteLength;};
  return {bridge,gate,errors,send,controls:controls.promise,stats:()=>({auth,entered,publication,cancels,closes,voices}),
    published:async(count:number)=>{if(publication>=count)return;sdkEntries[count-1]??=deferred();await sdkEntries[count-1]!.promise;},
    authenticated:async(count:number)=>{if(auth>=count)return;authEntries[count-1]??=deferred();await authEntries[count-1]!.promise;},
    entered:async(count:number)=>{if(entered>=count)return;entries[count-1]??=deferred();await entries[count-1]!.promise;}};
}

test('terminal count is shared across overlapping connections and released after work settles',async t=>{
  const a=await fixture(t,'shared'),b=await fixture(t,'shared');
  for(let i=0;i<40;i++)(i%2?a:b).send({operation:'admission_probe'});
  assert.equal(a.stats().auth+b.stats().auth,32);
  assert.equal(a.errors.length+b.errors.length,8);
  a.gate.resolve();b.gate.resolve();await Promise.all([a.bridge.close(),b.bridge.close()]);
  const renewed=await fixture(t,'shared');renewed.send({operation:'admission_probe'});assert.equal(renewed.stats().auth,1);
});

test('terminal byte admission retains reservations during slow SDK publication',async t=>{
  const f=await fixture(t,'byte-source','sdk'),body={operation:'admission_probe',padding:'x'.repeat(8000)};
  const bytes=Buffer.byteLength(JSON.stringify(body)),capacity=Math.floor(128*1024/bytes);
  for(let i=0;i<24;i++)f.send(body);
  assert.equal(f.stats().auth,capacity);
  await f.published(capacity);assert.equal(f.stats().entered,capacity);
  const auth=f.stats().auth;f.send(body);assert.equal(f.stats().auth,auth);
});

test('process count caps pending authentication across terminals',async t=>{
  const fixtures=[];for(let i=0;i<5;i++)fixtures.push(await fixture(t,`count-${i}`));
  for(const f of fixtures)for(let i=0;i<32;i++)f.send({operation:'admission_probe'});
  assert.equal(fixtures.reduce((sum,f)=>sum+f.stats().auth,0),128);
});

test('process byte admission bounds many terminals independently of count',async t=>{
  const fixtures=[];for(let i=0;i<6;i++)fixtures.push(await fixture(t,`bytes-${i}`));
  const body={operation:'admission_probe',padding:'x'.repeat(8000)},bytes=Buffer.byteLength(JSON.stringify(body));
  for(const f of fixtures)for(let i=0;i<20;i++)f.send(body);
  assert.equal(fixtures.reduce((sum,f)=>sum+f.stats().auth,0),Math.floor(512*1024/bytes));
});

test('normal saturation leaves close and cancel capacity; excess control has no async rejection queue',async t=>{
  const f=await fixture(t,'control','handler');
  for(let i=0;i<32;i++)f.send({operation:'admission_probe'});
  await f.entered(32);
  f.send({operation:'call_close',call_id:'call'});
  for(let i=0;i<4;i++)f.send({operation:'errand_cancel',job_id:'job-0123456789ab'});
  assert.equal(f.errors.length,1);
  assert.equal(String(f.errors[0]).includes('FORMAL_TEXT_CAPACITY'),true);
  // close is still ordered behind the existing audio lane, so observe it through its owned callback.
  await f.controls;f.gate.resolve();await f.bridge.close();
  assert.equal(f.stats().closes,1);assert.equal(f.stats().cancels,3);
});

test('reserved process capacity is bounded',async t=>{
  const fixtures=[];for(let i=0;i<5;i++)fixtures.push(await fixture(t,`reserved-${i}`));
  for(const f of fixtures){
    for(let i=0;i<32;i++)f.send({operation:'admission_probe'});
    for(let i=0;i<4;i++)f.send({operation:'errand_cancel',job_id:'job-0123456789ab'});
  }
  await Promise.all(fixtures.slice(0,4).map(f=>f.authenticated(36)));
  assert.equal(fixtures.reduce((sum,f)=>sum+f.stats().auth,0),128+16);
});

test('malformed cancel cannot occupy the empty reserved pool when ordinary work is full',async t=>{
  const f=await fixture(t,'malformed');
  for(let i=0;i<32;i++)f.send({operation:'admission_probe'});
  for(let i=0;i<4;i++)f.send({operation:'errand_cancel',padding:'invalid'});
  assert.ok(f.errors.every(error=>String(error).includes('FORMAL_TEXT_CAPACITY')));
  for(let i=0;i<4;i++)f.send({operation:'errand_cancel',job_id:'job-0123456789ab'});
  await f.authenticated(36);assert.equal(f.stats().auth,36);
});

for(const operation of ['voice_process','voice_commit'])test(`${operation} holds admission after pending until processing settles`,async t=>{
  const f=await fixture(t,operation,'voice');
  const body={operation,operation_id:'voice',...(operation==='voice_process'?{request:{}}:{})};
  for(let i=0;i<32;i++)f.send(body);
  await f.published(32);await drained();assert.equal(f.stats().voices,32);
  f.send(body);await drained();assert.equal(f.stats().voices,32);
  assert.ok(f.errors.some(error=>String(error).includes('FORMAL_TEXT_CAPACITY')));
});

test('retired ingress retains byte admission until the underlying SDK publications settle',async t=>{
  const f=await fixture(t,'retired','sdk'),body={operation:'admission_probe',padding:'x'.repeat(8000)};
  const capacity=Math.floor(128*1024/Buffer.byteLength(JSON.stringify(body)));
  for(let i=0;i<capacity;i++)f.send(body);
  await f.published(capacity);
  const closing=f.bridge.close();await drained();
  const replacement=await fixture(t,'retired');replacement.send(body);
  assert.equal(replacement.stats().auth,0);
  f.gate.resolve();await closing;
  replacement.send(body);assert.equal(replacement.stats().auth,1);
});
