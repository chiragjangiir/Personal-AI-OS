import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ReadableStream,type ReadableStreamDefaultController} from 'node:stream/web';
import {RoomEvent,TrackKind,TrackSource,dispose} from '@livekit/rtc-node';
import {createFormalPcmIngress,type PcmFrame,type VoiceWindowPurpose} from '../src/personal-aios-formal-pcm.ts';
import {AudioConsumption} from '../../../services/personal-aios-integration/src/media/audio-consumption.ts';
import type {ArchivedEvent,RawEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import type {StoragePort} from '../../../services/personal-aios-integration/src/storage.ts';
after(()=>dispose());
function fixture(t:test.TestContext){
  const records=new Map<string,Uint8Array>();
  const storage={publish:async(ns:string,key:string,bytes:Uint8Array)=>{const id=ns+':'+key;if(!records.has(id))records.set(id,bytes.slice());return records.get(id)!;},
    read:async(ns:string,key:string)=>{const bytes=records.get(ns+':'+key);if(!bytes)throw Object.assign(new Error('missing'),{code:'ENOENT'});return bytes;}} as StoragePort;
  const routes=new AudioConsumption(storage,65536),errors:unknown[]=[],events:ArchivedEvent[]=[];
  const binding={continuityId:'continuity',connectionEpoch:'1',userId:'owner',deviceId:'phone'};
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc',consent_ref:'consent',route_version:'route',submission:'observation'};
  const track={sid:'microphone'},publication={track,kind:TrackKind.KIND_AUDIO,source:TrackSource.SOURCE_MICROPHONE};
  const peer={identity:'terminal',trackPublications:new Map([['mic',publication]])};
  const room=Object.assign(new EventEmitter(),{isConnected:true,remoteParticipants:new Map([['terminal',peer]])});
  let controller!:ReadableStreamDefaultController<PcmFrame>,hold:Promise<void>|undefined;
  let tapped=Promise.withResolvers<void>();
  let appended=Promise.withResolvers<void>();
  let archived:Promise<unknown>|undefined;
  const maps=new Map<string,TrackChunk>();
  const ingress:ReturnType<typeof createFormalPcmIngress>=createFormalPcmIngress({participant:{roomPort:room} as never,
    authority:{credentialForBootstrap:()=>({}),authenticate:async()=>source,capture:async()=>({binding,trusted:source})} as never,
    runtime:{authenticate:async()=>source,existingArchive:()=>({prepareCapture:async()=>{}}),
      archivedAudioRoute:(event:ArchivedEvent)=>routes.existingRoute(event),
      appendMedia:async(raw:RawEvent,_source:unknown,chunk:TrackChunk,_signal:unknown,lifecycle:{onDurable():void})=>{
        const event={...raw,principal_id:'owner',consent_ref:'consent',raw_ref:'l5:'+raw.event_id,archive_revision:'revision',
          archive_status:'durable',origin:'device_observation',user_identity:'unknown'} as ArchivedEvent;
        maps.set(event.event_id,chunk);events.push(event);lifecycle.onDurable();appended.resolve();
        if(hold)await hold;
        const requested=await ingress.route(event);await routes.select(event,requested?.consumer==='voice'?'finite':'continuous',requested);
        return {event};
      }} as never,
    clock:{capture:async()=>({metadata:{captured_at:'2030-01-01T00:00:00.000Z'},capture_timing:{}}),
      archivedReceiptClockMaps:async(_principal:string,event:ArchivedEvent)=>{const chunk=maps.get(event.event_id)!;return [{modality:'audio',track_id:'microphone',stream_epoch:chunk.stream_epoch,
        source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:0,drift_ppm:0,uncertainty_ms:0,basis_ref:'test'}];}} as never,
    budget:{max_frame_samples:1600,max_pending_frames:10,max_pending_bytes:32000,max_samples:16000},input_contract:'interval_v2',
    streamFactory:()=>new ReadableStream<PcmFrame>({start:value=>{controller=value;}}),onError:error=>errors.push(error)});
  ingress.tap((_pcm,archive)=>{archived=archive;tapped.resolve();});
  const input={bearer:{deviceId:'phone'},currentBinding:{credentialIdentity:'terminal',connectionEpoch:'1'},enabledMedia:{audio:true}};
  t.after(()=>ingress.close());
  return {ingress,events,errors,routes,room,connect:()=>ingress.onBootstrapConnected(input as never),hold:(wait?:Promise<void>)=>{hold=wait;},
    frame:async()=>{tapped=Promise.withResolvers();appended=Promise.withResolvers();controller.enqueue({data:new Int16Array([1]),sampleRate:16000,channels:1,samplesPerChannel:1});await tapped.promise;return {archived:archived!,appended:appended.promise};}};
}

test('one PCM owner accepts more than 4096 committed and cancelled unique voice windows',async t=>{
  const f=fixture(t);await f.connect();
  for(let n=0;n<4100;n++){
    const purpose:VoiceWindowPurpose=n%2?'voiceprint':'request',operation='commit-'+n;
    await f.ingress.voice.open(operation,purpose);await (await f.frame()).archived;
    const committed=await f.ingress.voice.commit(operation,purpose);
    assert.equal(committed.event_id,f.events.at(-1)!.event_id);
    await f.ingress.voice.open('cancel-'+n,purpose);assert.equal(f.ingress.voice.cancel('cancel-'+n),true);
  }
  await f.connect();await f.ingress.voice.open('after-bootstrap');assert.equal(f.ingress.voice.cancel('after-bootstrap'),true);
  for(const event of [f.events[0]!,f.events[1]!,f.events.at(-1)!])
    assert.equal((await f.ingress.route(event))!.consumer,event===f.events[0]?'voice':'audit_only');
  assert.deepEqual(f.errors,[]);
});

test('cancelled publication keeps its original purpose through reconnect and delayed archive',async t=>{
  const f=fixture(t);await f.connect();
  for(const purpose of ['request','voiceprint'] as const){
    const gate=Promise.withResolvers<void>();f.hold(gate.promise);
    await f.ingress.voice.open(purpose,purpose);const publication=await f.frame();
    await publication.appended;
    assert.equal(f.ingress.voice.cancel(purpose),true);
    await assert.rejects(f.ingress.voice.commit(purpose,purpose),/VOICE_WINDOW_REQUIRED/);
    for(let n=0;n<4100;n++){await f.ingress.voice.open('empty-'+purpose+n);f.ingress.voice.cancel('empty-'+purpose+n);}
    f.hold();gate.resolve();await publication.archived;
    const event=f.events.at(-1)!;assert.equal((await f.ingress.route(event))!.consumer,purpose==='request'?'voice':'audit_only');
  }
  f.room.emit(RoomEvent.Reconnecting);f.room.emit(RoomEvent.Reconnected);await f.connect();
  assert.equal((await f.ingress.route(f.events[0]!))!.consumer,'voice');
  assert.equal((await f.ingress.route(f.events[1]!))!.consumer,'audit_only');
  assert.deepEqual(f.errors,[]);
});
