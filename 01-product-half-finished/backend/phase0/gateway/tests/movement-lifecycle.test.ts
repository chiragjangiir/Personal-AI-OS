import test from 'node:test';
import assert from 'node:assert/strict';
import {DataPacketKind,RoomEvent} from '@livekit/rtc-node';
import {createFormalTextIngress,FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';
import {Movement} from '../../../services/personal-aios-integration/src/movement.ts';
const deferred=<T>()=>Promise.withResolvers<T>();
const rideId='00000000-0000-4000-8000-000000000001';

// Exercise the real ingress and movement owner with controlled durable-write completion.
async function movementFixture(t:import('node:test').TestContext,_navigation?:unknown,_options?:unknown,
  hooks:{publish?:(packet:any)=>Promise<void>;event?:()=>Promise<void>;projection?:()=>Promise<void>}={}) {
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc_typed_text',capabilities:[]};
  const durable=new Set<string>(),events:any[]=[],packets:any[]=[],listeners=new Map<string,Set<(...args:any[])=>void>>();
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal',trackPublications:new Map()}]]),
    on:(event:string,fn:(...args:any[])=>void)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(fn);},
    off:(event:string,fn:(...args:any[])=>void)=>{listeners.get(event)?.delete(fn);},
    localParticipant:{sendText:async()=>{},publishData:async(bytes:Uint8Array)=>{
      const packet=JSON.parse(Buffer.from(bytes).toString());packets.push(packet);await hooks.publish?.(packet);
    }}};
  const movement=new Movement({send:async()=>{},position:async()=>({lat:0,lng:0}),say:async()=>{},
    event:async(_owner,id,_at,body,onDurable)=>{await hooks.event?.();if(!durable.has(id)){durable.add(id);events.push(body);}await onDurable?.();await hooks.projection?.();}});
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},cameraReady:async()=>{},movementReady:async()=>movement.phoneConnected('owner'),authenticate:async()=>source,watchPayments:async()=>()=>{},paymentDetach:async()=>{},
    terminalChanged:()=>{},ownerInput:async()=>{},activeTerminal:()=>true,watchVoiceConfirmations:async()=>()=>{},
    watchReminders:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    move:async(_source:unknown,body:any,onDurable?:()=>Promise<void>)=>body.operation==='ride_state'?movement.rideState('owner',body,onDurable):movement.navState('owner',body,onDurable)};
  const bridge=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,
    runtime:runtime as never,authority:{credentialForBootstrap:()=>({})} as never,max_packet_bytes:12288,onError:()=>{}});
  await bridge.onBootstrapConnected({request:{},bearer:{},governance:{},authority:{},
    currentBinding:{credentialIdentity:'terminal',continuityId:'session'},enabledMedia:{data:true}} as never);
  t.after(()=>bridge.close());
  const send=(body:unknown)=>{for(const listener of listeners.get(RoomEvent.DataReceived)??[])listener(Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);};
  return {phone:{send,out:(operation:string)=>packets.filter(p=>p.operation===operation)},events,at:()=> '2026-10-18T00:00:00.000Z'};
}

test('movement lifecycle ACK follows durable acceptance and retries the same ID without duplicate history',{timeout:3000},async t=>{
  let delivered=deferred<any>();
  const m=await movementFixture(t,undefined,{}, {publish:async packet=>{
    if(packet.operation==='move_ack'||packet.operation==='rejected')delivered.resolve(packet);
  }});
  const lifecycle_id='00000000-0000-4000-8000-000000000003';
  const start={operation:'ride_state',lifecycle_id,ride_id:rideId,state:'started',at:m.at(),started_by:'phone'};
  m.phone.send(start);
  let ack=await delivered.promise;
  assert.equal(ack.operation,'move_ack');assert.equal(ack.lifecycle_id,lifecycle_id);
  assert.equal(m.events.filter(e=>e.kind==='ride_start').length,1);
  delivered=deferred<any>();m.phone.send(start);ack=await delivered.promise;
  assert.equal(ack.operation,'move_ack');assert.equal(m.events.filter(e=>e.kind==='ride_start').length,1);
});
test('movement never ACKs a failed or uncommitted lifecycle; reconnect retry keeps its identity',{timeout:3000},async t=>{
  let delivered=deferred<any>(),entered=deferred<void>(),release=deferred<void>(),attempt=0;
  const m=await movementFixture(t,undefined,{}, {publish:async packet=>{
    if(packet.operation==='move_ack'||packet.operation==='rejected')delivered.resolve(packet);
  },event:async()=>{
    if(++attempt===1)throw new Error('injected lifecycle archive failure');
    entered.resolve();await release.promise;
  }});
  const lifecycle_id='00000000-0000-4000-8000-000000000004';
  const body={operation:'ride_state',lifecycle_id,ride_id:rideId,state:'started',at:m.at(),started_by:'phone'};
  m.phone.send(body);assert.equal((await delivered.promise).operation,'rejected');assert.equal(m.phone.out('move_ack').length,0);
  delivered=deferred<any>();m.phone.send(body);await entered.promise;
  assert.equal(m.phone.out('move_ack').length,0,'a transport write is not durable acceptance');
  release.resolve();assert.equal((await delivered.promise).lifecycle_id,lifecycle_id);
  assert.equal(m.events.filter(e=>e.kind==='ride_start').length,1);
});

test('durable lifecycle ACK is not blocked by failed terminal projections',{timeout:3000},async t=>{
  const acknowledged=deferred<any>(),rejected=deferred<any>();
  const m=await movementFixture(t,undefined,{}, {publish:async packet=>{
    if(packet.operation==='move_ack')acknowledged.resolve(packet);
    if(packet.operation==='rejected')rejected.resolve(packet);
  },projection:async()=>{throw new Error('controlled terminal projection failure');}});
  const lifecycle_id='00000000-0000-4000-8000-000000000005';
  m.phone.send({operation:'ride_state',lifecycle_id,ride_id:rideId,state:'started',at:m.at(),started_by:'phone'});
  assert.equal((await acknowledged.promise).lifecycle_id,lifecycle_id);
  assert.equal(m.events.filter(e=>e.kind==='ride_start').length,1);
  assert.equal((await rejected.promise).request_operation,'ride_state','projection errors remain visible');
});
