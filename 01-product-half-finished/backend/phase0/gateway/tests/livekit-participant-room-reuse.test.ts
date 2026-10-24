import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { DisconnectReason } from '@livekit/rtc-node';
import { FfiClient, type FfiHandle, dispose } from '../node_modules/@livekit/rtc-node/dist/ffi_client.js';
import { LiveKitCloudParticipant, type LiveKitCloudRoomPort } from '../src/livekit-cloud-participant.ts';
import { createGatewayRoom } from '../src/sdk-room.ts';

// rtc-node 0.13.32 Room.disconnect() ends with removeAllListeners(). An initial
// bootstrap replaced the binding (participant.disconnect + connect on the same SDK room), so the next room loss went
// unobserved; the participant kept reporting connected, refresh never rejoined, and every PCM attach answered
// FORMAL_PCM_ROOM_REQUIRED.
test('a room loss after the participant reconnected on the same SDK room is still observed', async (t) => {
  const ffi=FfiClient.instance,room=createGatewayRoom();
  const ids = Array.from({length:4}, () => (ffi.request({message:{case:'newVideoSource',value:{
    type:0,resolution:{width:2,height:2},
  }}}) as {source:{handle:{id:bigint}}}).source.handle.id);
  const emit=(kind:string,value:unknown)=>ffi.emit('ffi_event',{message:{case:kind,value}} as never);
  let connects=0;
  t.mock.method(ffi,'request',(req:Parameters<FfiClient['request']>[0])=>{
    if(req.message?.case==='connect'){
      const [roomId,localId]=ids.slice(connects*2,connects*2+2) as [bigint,bigint];connects+=1;
      queueMicrotask(()=>emit('connect',{asyncId:1n,message:{case:'result',value:{
        room:{handle:{id:roomId},info:{sid:'RM_test'}},localParticipant:{handle:{id:localId},info:{identity:'gateway',sid:'PA_local'}},participants:[],
      }}}));
    }
    if(req.message?.case==='disconnect')queueMicrotask(()=>emit('disconnect',{asyncId:1n}));
    return {asyncId:1n} as never;
  });
  const handles:FfiHandle[]=[];
  const keep=()=>handles.push((room as unknown as {ffiHandle:FfiHandle}).ffiHandle,room.localParticipant!.ffi_handle);
  t.after(async()=>{for(const handle of handles)handle.dispose();await dispose();});
  const participant=new LiveKitCloudParticipant(room as unknown as LiveKitCloudRoomPort);
  const binding={realtimeSessionRef:{ref_type:'RealtimeSession',ref_id:'session'},deviceLeaseRef:{ref_type:'DeviceLease',ref_id:'lease'},
    continuityId:'continuity',transportAliases:['room-alias','participant-alias'],connectionEpoch:'1'};
  const input={projectUrl:'wss://project.livekit.cloud',roomName:'gateway-room',identity:'gateway-identity',token:'opaque-participant-token',
    grants:{room:'gateway-room',roomJoin:true as const,canPublish:false,canSubscribe:true,canPublishData:true,canPublishSources:[] as const},
    binding,roomOptions:{encryption:{keyProviderOptions:{}}}};
  await participant.connect(input);keep();
  await participant.disconnect();
  await participant.connect({...input,binding:{...binding,connectionEpoch:'2'}});keep();
  assert.equal(participant.snapshot().connected,true);
  emit('roomEvent',{roomHandle:ids[2],message:{case:'disconnected',value:{reason:DisconnectReason.PARTICIPANT_REMOVED}}});
  await setImmediate();
  assert.equal(room.isConnected,false);
  assert.deepEqual(participant.snapshot(),{connected:false,transportState:'disconnected'});
});
