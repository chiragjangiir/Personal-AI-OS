import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEvent} from '@livekit/rtc-node';
import {createFormalTextIngress} from '../src/personal-aios-formal-text.ts';
import {paymentFixture,phone} from '../../../services/personal-aios-integration/tests/payment-fixture.ts';

test('formal payment snapshots survive one SDK failure and a same-peer reconnect without re-bootstrap',async t=>{
  const f=await paymentFixture(t),card=await f.open(),packets:Record<string,any>[]=[],listeners=new Map<string,(...args:any[])=>void>();
  const failed=Promise.withResolvers<void>();let fail=false,watches=0,disconnects=0;
  const publish=async(data:Uint8Array|string)=>{
    const frame=JSON.parse(Buffer.from(data).toString());
    if(fail&&frame.operation==='payment_cards'){fail=false;failed.resolve();throw Error('fixture SDK publish');}
    packets.push(frame);
  };
  const room={isConnected:true,remoteParticipants:new Map([['terminal',{identity:'terminal'}]]),
    on:(event:string,fn:(...args:any[])=>void)=>listeners.set(event,fn),off:(event:string)=>listeners.delete(event),
    localParticipant:{publishData:publish,sendText:publish}};
  const runtime={watchActivity:async()=>()=>{},replayActivity:async()=>{},authenticate:async()=>phone,paymentDetach:async()=>{},cameraReady:async()=>{},movementReady:async()=>{},watchReminders:async()=>()=>{},
    watchCare:async()=>()=>{},watchVoiceConfirmations:async()=>()=>{},watchAmbientTurns:async()=>()=>{},
    watchPayments:(...args:Parameters<typeof f.authority.watch>)=>{watches++;return f.authority.watch(...args);}};
  const ingress=createFormalTextIngress({participant:{roomPort:room,disconnect:async()=>{disconnects++;}} as never,runtime:runtime as never,
    authority:{credentialForBootstrap:()=>({})} as never,max_packet_bytes:12288,onError:()=>{}});
  try{
    await ingress.onBootstrapConnected({enabledMedia:{data:true},currentBinding:{credentialIdentity:'terminal',continuityId:'session'}} as never);
    fail=true;await f.authority.terminalChanged(phone);await failed.promise;await new Promise<void>(resolve=>setImmediate(resolve));
    listeners.get(RoomEvent.Reconnecting)!();listeners.get(RoomEvent.Reconnected)!();
    f.setNow(f.authority.store.getPayment(card.payment_id)!.expires_at_ms);await f.authority.tick();
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(watches,1);assert.equal(disconnects,0);
    const snapshot=packets.filter(p=>p.operation==='payment_cards').at(-1)!;
    assert.equal(snapshot.cards[0].state,'expired');assert.equal(snapshot.complete,true);
    assert.equal(snapshot.cards[0].version,f.authority.store.getPayment(card.payment_id)!.version);
  }finally{await ingress.close();}
});
