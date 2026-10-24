import test from 'node:test';
import assert from 'node:assert/strict';
import {DataPacketKind,RoomEvent} from '@livekit/rtc-node';
import {createFormalTextIngress,FORMAL_TEXT_INPUT_TOPIC,FORMAL_TEXT_ENVELOPE_SCHEMA} from '../src/personal-aios-formal-text.ts';
import {paymentFixture,glasses,phone} from '../../../services/personal-aios-integration/tests/payment-fixture.ts';
import type {PaymentInputBinding} from '../../../services/personal-aios-integration/src/payment/authority.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';

test('F1 I5 I15: formal unlock request retains its pre-authorization wear generation across same-connection screen-off',async t=>{
  const f=await paymentFixture(t);await f.locks();f.authority.leases.lock(glasses,'screen_off');
  const connection=f.terminals.connectionIdentity(glasses),entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
  const locked=Promise.withResolvers<void>(),refused=Promise.withResolvers<void>();let hold=false;
  const packets:Record<string,unknown>[]=[],errors:unknown[]=[],listeners=new Map<string,(...args:readonly unknown[])=>void>();
  // Real input authority and terminal state; unrelated room subscriptions remain fixture ports.
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>{if(hold){hold=false;entered.resolve();await resume.promise;}return glasses;},
    paymentInputBinding:(source:RegisteredDevice)=>f.authority.inputBinding(source),
    paymentInput:async(source:RegisteredDevice,body:Record<string,unknown>,session:string,origin?:PaymentInputBinding)=>{
      const result=await f.authority.input(source,body,session,origin);if(body.operation==='glasses_lock')locked.resolve();return result;
    },
    cameraReady:async()=>{},movementReady:async()=>{},paymentDetach:async()=>{},watchPayments:async()=>()=>{},watchCare:async()=>()=>{},watchAmbientTurns:async()=>()=>{}};
  const capture=async(data:Uint8Array|string)=>{
    const body=JSON.parse(Buffer.from(data).toString());packets.push(body);
    if(body.control_id==='pre-lock')refused.resolve();
  };
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal'}]]),
    on:(event:string,fn:(...args:readonly unknown[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),
    localParticipant:{publishData:capture,sendText:capture}};
  const ingress=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{}} as never,runtime:runtime as never,
    authority:{credentialForBootstrap:()=>({})} as never,max_packet_bytes:12288,onError:error=>errors.push(error)});
  const send=(body:Record<string,unknown>)=>listeners.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify(body)),
    {identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
  try {
    await ingress.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'session'}} as never);
    hold=true;send({operation:'glasses_unlock_request',control_id:'pre-lock',lock_cycle:0});await entered.promise;
    send({operation:'glasses_lock',reason:'screen_off'});await locked.promise;
    assert.equal(f.terminals.connectionIdentity(glasses),connection);
    resume.resolve();await refused.promise;
    assert.deepEqual(packets.find(p=>p.control_id==='pre-lock'),{schema_version:FORMAL_TEXT_ENVELOPE_SCHEMA,operation:'payment_receipt',
      session_id:'session',control_id:'pre-lock',ok:false,error_code:'APPROVAL_WEAR_CHANGED'});
    assert.deepEqual(await f.authority.leases.approvals(phone),[]);assert.equal(f.terminals.lease(glasses),undefined);
    assert.equal(errors.length,1);assert.equal((errors[0] as {code:string}).code,'APPROVAL_WEAR_CHANGED');
  }finally{resume.resolve();await ingress.close();}
});
