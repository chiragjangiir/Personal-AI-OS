import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, type VideoFrameEvent } from '@livekit/rtc-node';
import { changedCells, createCallCamera, encodeCameraFrame, lumaGrid, type CallCameraSegment, type CallVideoEncoderFactory } from '../src/personal-aios-call-camera.ts';
import {createCameraTransforms} from '../src/call-camera-transform.ts';
import {callVideoResourcesSnapshot} from '../src/call-video-encoder.ts';
import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';

const W = 64, H = 36;
/** I420 frame whose luma is `base`, with an optional bright square (a moving object) at column x. */
const frame = (base: number, x?: number) => {
  const data = new Uint8Array(W * H * 3 / 2).fill(128);
  data.fill(base, 0, W * H);
  if (x !== undefined) for (let y = 10; y < 22; y++) data.fill(250, y * W + x, y * W + x + 10);
  return new VideoFrame(data, W, H, VideoBufferType.I420);
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options: {live?: () => boolean;archive?:(segment:CallCameraSegment)=>Promise<void>;encoderFactory?:CallVideoEncoderFactory;encode?:()=>Promise<string|undefined>;cancel?:()=>Promise<void>} = {}) {
  let clock = 0, streams = 0, controller!: ReadableStreamDefaultController<VideoFrameEvent>;
  const sent: number[] = [], errors: unknown[] = [], changes: boolean[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const room = {on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event), remoteParticipants: new Map(), isConnected: true};
  const camera = createCallCamera({participant: {roomPort: room} as never,
    sink: () => (options.live?.() ?? true) ? () => sent.push(clock) : undefined,
    ...(options.archive?{archive:options.archive}:{}),
    ...(options.encoderFactory?{encoderFactory:options.encoderFactory}:{}),
    onError: error => errors.push(error), onActiveChange: active => changes.push(active), now: () => clock,
    streamFactory: () => {streams++; return new ReadableStream<VideoFrameEvent>({start: c => {controller = c;},...(options.cancel?{cancel:options.cancel}:{})});},
    project:async frame=>({frame,grid:lumaGrid(frame.data,frame.width,frame.height)}),
    encode: options.encode ?? (async () => 'jpeg')});
  const input = {enabledMedia: {video: true}, currentBinding: {credentialIdentity: 'phone-1'}} as never;
  const track = {sid: 'track'};
  const publish = (identity = 'phone-1', kind = TrackKind.KIND_VIDEO, source = TrackSource.SOURCE_CAMERA, muted = false, currentTrack = track) => {
    const publication = {kind, source, track: currentTrack, muted};
    room.remoteParticipants.set(identity, {identity, trackPublications: new Map([['p', publication]])});
    listeners.get(RoomEvent.TrackSubscribed)!(currentTrack, publication, {identity});return publication;
  };
  /** Feeds frames at 30 fps for `ms` milliseconds; `moving` slides the bright square every frame. */
  const play = async (ms: number, moving = false) => {
    for (const end = clock + ms; clock < end; clock += 33) {
      controller.enqueue({frame: frame(60, moving ? (clock / 33 * 7) % 50 : undefined), rotation: 0, timestampUs: 0n} as never);
      await tick(); await tick();
    }
  };
  return {camera, input, publish, play, sent, errors, changes, listeners, feed: (n: number,width=W,height=H) => {for (let i=0;i<n;i++) controller.enqueue({frame:width===W&&height===H?frame(60):new VideoFrame(new Uint8Array(width*height*3/2),width,height,VideoBufferType.I420),rotation:0,timestampUs:BigInt(i)} as never);}, streams: () => streams, at: (ms: number) => {clock = ms;}};
}

test('the change check ignores a still view and catches a small moving object', () => {
  const still = lumaGrid(frame(60).data, W, H);
  assert.equal(changedCells(still, lumaGrid(frame(62).data, W, H)), 0, 'sensor-level noise is not change');
  assert.ok(changedCells(still, lumaGrid(frame(60, 20).data, W, H)) >= 12, 'an object entering the view is change');
});

test('a still view goes to the call at 1 fps, motion at 5 fps, and a spoken turn gets a fresh frame at once', async () => {
  const h = harness();
  await h.camera.onBootstrapConnected(h.input);
  h.publish();
  await tick();
  await h.play(3000);
  assert.equal(h.sent.length, 3, `still: one frame per second, got ${h.sent}`);
  h.sent.length = 0;
  await h.play(2000, true);
  assert.ok(h.sent.length >= 8 && h.sent.length <= 11, `moving: about 5 fps, got ${h.sent.length}`);
  await h.play(7000);
  h.sent.length = 0;
  await h.play(400);
  assert.ok(h.sent.length <= 1, 'back to 1 fps once the view settles');
  const before = h.sent.length;
  h.camera.focus('speech');
  await h.play(40);
  assert.equal(h.sent.length, before + 1, 'speech forces the next frame');
  await h.camera.close();
  assert.deepEqual(h.errors, []);
});

test('only the paired phone camera is read, and nothing is sent while no call is live', async () => {
  let live = false;
  const h = harness({live: () => live});
  await h.camera.onBootstrapConnected(h.input);
  h.publish('someone-else');
  h.publish('phone-1', TrackKind.KIND_AUDIO, TrackSource.SOURCE_MICROPHONE);
  await tick();
  h.publish();
  await tick();
  await h.play(2000);
  assert.equal(h.sent.length, 0, 'no live call: frames are dropped');
  live = true;
  await h.play(1000);
  assert.ok(h.sent.length >= 1);
  await h.camera.close();
  assert.equal(h.listeners.size, 0, 'room listeners are detached on close');
});

test('after an SDK reconnect the existing camera track is read again without a new TrackSubscribed', async () => {
  const h = harness();
  await h.camera.onBootstrapConnected(h.input);
  h.publish();
  await tick();
  await h.play(1000);
  const before = h.sent.length;
  h.listeners.get(RoomEvent.Reconnecting)!();
  await tick(); await tick();
  h.listeners.get(RoomEvent.Reconnected)!();
  await tick(); await tick(); await tick();
  assert.equal(h.streams(), 2, 'a fresh reader on the same track');
  await h.play(1500);
  assert.ok(h.sent.length > before, 'frames flow again');
  await h.camera.close();
  assert.deepEqual(h.errors, []);
});

test('a session without video never subscribes', async () => {
  const h = harness();
  await h.camera.onBootstrapConnected({enabledMedia: {video: false}, currentBinding: {credentialIdentity: 'phone-1'}} as never);
  assert.equal(h.listeners.size, 0);
  await h.camera.close();
});

test('video permission alone is inactive; only the owner camera publication and mute state change it',async()=>{
  const h=harness();await h.camera.onBootstrapConnected(h.input);assert.equal(h.camera.active(),false);
  h.publish('yimi-avatar');await tick();assert.deepEqual(h.changes,[]);
  const publication=h.publish('phone-1',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,true);
  await tick();assert.equal(h.camera.active(),false);
  publication.muted=false;h.listeners.get(RoomEvent.TrackUnmuted)!(publication,{identity:'phone-1'});
  await tick();assert.equal(h.camera.active(),true);
  h.listeners.get(RoomEvent.TrackMuted)!(publication,{identity:'yimi-avatar'});await tick();
  assert.equal(h.camera.active(),true);
  publication.muted=true;h.listeners.get(RoomEvent.TrackMuted)!(publication,{identity:'phone-1'});
  assert.equal(h.camera.active(),false);await tick();
  publication.muted=false;h.listeners.get(RoomEvent.TrackUnmuted)!(publication,{identity:'phone-1'});
  await tick();h.listeners.get(RoomEvent.TrackUnpublished)!(publication,{identity:'phone-1'});
  assert.equal(h.camera.active(),false);assert.deepEqual(h.changes,[true,false,true,false]);await h.camera.close();
});

test('unpublishing during camera attachment cancels the pending video activation',async()=>{
  const h=harness();await h.camera.onBootstrapConnected(h.input);const publication=h.publish();
  h.listeners.get(RoomEvent.TrackUnpublished)!(publication,{identity:'phone-1'});
  await tick();assert.equal(h.camera.active(),false);assert.deepEqual(h.changes,[]);await h.camera.close();
});

test('late retirement of an old owner camera cannot disable its replacement',async()=>{
  const h=harness();await h.camera.onBootstrapConnected(h.input);const old=h.publish();await tick();
  h.publish('phone-1',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,false,{sid:'replacement'});
  assert.equal(h.camera.active(),true,'camera remains active while its replacement reader attaches');
  await tick();await tick();
  assert.deepEqual(h.changes,[true],'camera flip cannot deactivate the avatar');
  h.listeners.get(RoomEvent.TrackUnsubscribed)!(old.track,old,{identity:'phone-1'});
  h.listeners.get(RoomEvent.TrackUnpublished)!(old,{identity:'phone-1'});
  assert.equal(h.camera.active(),true);await h.camera.close();
});

test('frames are encoded upright as JPEG within the provider cap', async () => {
  const rgba = new Uint8Array(1280 * 720 * 4).fill(200);
  const base64 = await encodeCameraFrame(new VideoFrame(rgba, 1280, 720, VideoBufferType.RGBA), 1);
  assert.ok(base64 && base64.length <= 256 * 1024);
  const bytes = Buffer.from(base64!, 'base64');
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8, 'JPEG SOI');
  const {default: sharp} = await import('sharp');
  const meta = await sharp(bytes).metadata();
  assert.deepEqual([meta.width, meta.height], [360, 640], 'rotated 90° and scaled to 640 on the long edge');
});

test('dead-source archive rejection stops capture and is never retried by close',async()=>{
  const archived:CallCameraSegment[]=[];let written=0;
  const bytes=Buffer.from([0,0,0,1,0x67]);
  const h=harness({live:()=>false,archive:async segment=>{archived.push(segment);throw new ContractError('SOURCE_BINDING_INACTIVE',403);},
    encoderFactory:(trackId,archive)=>{
      let segment:CallCameraSegment|undefined;
      return {write:async(event,at)=>{written++;segment??={bytes,mime:'video/h264',trackId,startedAt:at,endedAt:at,
        width:1280,height:720,sourceWidth:W,sourceHeight:H,rotation:event.rotation,frameCount:1,sourceFrames:[{timestampUs:'0',receivedAt:at}]};
        await archive(segment);},finish:async()=>{if(segment)await archive(segment);}};
    }});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();await h.play(33);
  assert.equal(written,1);assert.equal(h.camera.active(),false);assert.equal(h.sent.length,0);
  await h.camera.onBootstrapConnected(h.input);await tick();assert.equal(h.streams(),2);
  await h.camera.close();await h.camera.close();assert.equal(archived.length,1);assert.equal(h.errors.length,1);
});

test('dead-source segment admission releases the queued tail and never replays it at close',async()=>{
  const acked:string[]=[],written:string[]=[];
  const h=harness({archive:async()=>{throw new ContractError('SOURCE_CURRENT_BINDING_REQUIRED',403);},
    encoderFactory:(trackId,archive)=>{
      let pending:CallCameraSegment|undefined;
      const finish=async()=>{if(pending){await archive(pending);pending=undefined;}};
      return {finish,write:async(event,receivedAt)=>{written.push(event.timestampUs.toString());
        pending={bytes:Buffer.from([0,0,0,1,0x67]),mime:'video/h264',trackId,startedAt:receivedAt,endedAt:receivedAt,
          width:1280,height:720,sourceWidth:W,sourceHeight:H,rotation:0,frameCount:1,sourceFrames:[{timestampUs:event.timestampUs.toString(),receivedAt}]};
        await finish();}};
    }});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(3);await tick();await tick();
  assert.equal(h.camera.active(),false);assert.deepEqual(written,['0']);
  await h.camera.onBootstrapConnected({enabledMedia:{video:false},currentBinding:{credentialIdentity:'new-phone'}} as never);
  await h.camera.close();await h.camera.close();
  assert.deepEqual(written,['0']);assert.deepEqual(acked,[]);assert.equal(h.errors.length,1);
});

test('camera replacement joins the prior decoded preview before acquiring another reader',async()=>{
  const gate=Promise.withResolvers<string|undefined>();let encodes=0;
  const h=harness({encode:()=>{encodes++;return gate.promise;}});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(1);await tick();
  assert.equal(encodes,1);h.publish('phone-1',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,false,{sid:'replacement'});
  await tick();assert.equal(h.streams(),1,'replacement cannot overlap the retained preview input');
  gate.resolve('jpeg');await tick();await tick();assert.equal(h.streams(),2);await h.camera.close();
});

test('credential refresh keeps the same camera reader while its original is still draining',async()=>{
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let writes=0,refreshed=false;
  const h=harness({archive:async()=>{},encoderFactory:()=>({write:async()=>{writes++;entered.resolve();await gate.promise;},finish:async()=>{}})});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(1);await entered.promise;
  const refresh=h.camera.onBootstrapConnected(h.input).then(()=>{refreshed=true;});
  try{await tick();assert.equal(refreshed,true,'readiness does not join an unchanged capture');assert.equal(h.streams(),1);}
  finally{gate.resolve();await refresh;await h.camera.close();}
  assert.equal(writes,1);assert.deepEqual(h.errors,[]);
});

test('fresh camera source does not replay or inherit a released old archive failure',async()=>{
  let oldAttempts=0;const saved:string[]=[];
  const h=harness({archive:async segment=>{
    if(segment.trackId==='track'){oldAttempts++;throw new ContractError('SOURCE_BINDING_INACTIVE',403);}
    saved.push(segment.trackId);
  },encoderFactory:(trackId,archive)=>{
    let pending:CallCameraSegment|undefined;
    const finish=async()=>{if(pending){await archive(pending);pending=undefined;}};
    return {finish,write:async(event,receivedAt)=>{pending={bytes:Buffer.from([1]),mime:'video/h264',trackId,
      startedAt:receivedAt,endedAt:receivedAt,width:1280,height:720,sourceWidth:W,sourceHeight:H,rotation:0,
      frameCount:1,sourceFrames:[{timestampUs:event.timestampUs.toString(),receivedAt}]};await finish();}};
  }});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(1);await tick();await tick();
  const attempts=oldAttempts;assert.ok(attempts>0);
  await h.camera.onBootstrapConnected({enabledMedia:{video:true},currentBinding:{credentialIdentity:'new-phone'}} as never);
  assert.equal(oldAttempts,attempts,'refresh does not retry deterministic retained failures');
  h.publish('new-phone',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,false,{sid:'fresh'});await tick();h.feed(1);await tick();
  assert.ok(saved.includes('fresh'));assert.equal(h.streams(),2);assert.ok(h.errors.length>0);
  await h.camera.close();assert.equal(saved.includes('track'),false);assert.equal(oldAttempts,1);
});


for(const rejected of [false,true])test(`new camera readiness and archive drain precede ${rejected?'rejected':'delayed'} old cancellation`,async()=>{
  const cancel=Promise.withResolvers<void>();let cancelCalls=0,writes=0;
  const h=harness({cancel:()=>++cancelCalls===1?cancel.promise:Promise.resolve(),archive:async()=>{},
    encoderFactory:()=>({write:async()=>{writes++;},finish:async()=>{}})});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(3);await tick();
  await h.camera.onBootstrapConnected({enabledMedia:{video:true},currentBinding:{credentialIdentity:'new-phone'}} as never);
  h.publish('new-phone',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,false,{sid:'fresh'});await tick();
  assert.equal(h.streams(),1);assert.equal(writes,3,'old originals drain before another SDK reader is acquired');
  let closed=false;const closing=h.camera.close().finally(()=>{closed=true;});
  await tick();assert.equal(closed,false,'close owns the old cancellation obligation');
  if(rejected)cancel.reject(new TypeError('native cancellation failed'));else cancel.resolve();
  await closing;if(rejected)assert.ok(h.errors.some(error=>String(error).includes('CALL_VIDEO_SOURCE_CANCEL_FAILED')));
});

test('repeated invalid camera setup cannot reuse an unarmed registration',async()=>{
  const camera=createCallCamera({participant:{roomPort:{}} as never,sink:()=>undefined,onError:()=>{}});
  const input={enabledMedia:{video:true},currentBinding:{credentialIdentity:'phone'}} as never;
  await assert.rejects(camera.onBootstrapConnected(input),/CALL_CAMERA_ROOM_REQUIRED/);
  await assert.rejects(camera.onBootstrapConnected(input),/CALL_CAMERA_ROOM_REQUIRED/);
  assert.equal(camera.active(),false);await camera.close();
  await assert.rejects(camera.onBootstrapConnected(input),/CALL_CAMERA_CLOSED/);
});

test('same-binding refresh rearms a failed camera and archives the following capture',async()=>{
  let failed=false,attempts=0;const saved:string[]=[];
  const h=harness({archive:async segment=>{attempts++;if(!failed){failed=true;throw new ContractError('SOURCE_BINDING_INACTIVE',403);}saved.push(segment.sourceFrames[0]!.timestampUs);},
    encoderFactory:(trackId,archive)=>({finish:async()=>{},write:async(event,at)=>archive({bytes:Buffer.from([1]),mime:'video/h264',trackId,
      startedAt:at,endedAt:at,width:64,height:36,sourceWidth:W,sourceHeight:H,rotation:0,frameCount:1,sourceFrames:[{timestampUs:String(event.timestampUs),receivedAt:at}]})})});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(1);await tick();await tick();
  assert.equal(h.camera.active(),false);assert.equal(attempts,1);
  await h.camera.onBootstrapConnected(h.input);await tick();assert.equal(h.streams(),2);
  h.feed(1);await tick();assert.deepEqual(saved,['0']);assert.equal(h.errors.length,1);await h.camera.close();
});

test('room retirement and bootstrap share one drain and one camera queue budget',async()=>{
  const gate=Promise.withResolvers<void>(),before=callVideoResourcesSnapshot(),saved:{track:string;stamp:string}[]=[];
  let overlaps=0;
  const h=harness({live:()=>false,archive:async()=>{},encoderFactory:track=>{
    let busy=false;
    const exclusive=async(work:()=>Promise<void>)=>{if(busy)overlaps++;busy=true;try{await work();}finally{busy=false;}};
    return {finish:()=>exclusive(async()=>{}),write:event=>exclusive(async()=>{if(track==='track')await gate.promise;saved.push({track,stamp:String(event.timestampUs)});})};
  }});
  await h.camera.onBootstrapConnected(h.input);const publication=h.publish();await tick();h.feed(48,1280,720);await tick();
  assert.ok(callVideoResourcesSnapshot().queued_bytes-before.queued_bytes>60*1024*1024);
  h.listeners.get(RoomEvent.TrackUnsubscribed)!(publication.track,publication,{identity:'phone-1'});
  let ready=false;const bootstrap=h.camera.onBootstrapConnected({enabledMedia:{video:true},currentBinding:{credentialIdentity:'new-phone'}} as never).then(()=>{ready=true;});
  try{
    await tick();assert.equal(ready,true,'registration readiness does not await old encoding');await bootstrap;
    h.publish('new-phone',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,false,{sid:'fresh'});await tick();
    assert.equal(h.streams(),1,'replacement SDK acquisition waits for old queue release');
    assert.equal(callVideoResourcesSnapshot().readers-before.readers,1);
  }finally{gate.resolve();}
  for(let n=0;n<20&&h.streams()!==2;n++)await tick();assert.equal(h.streams(),2);h.feed(2);await tick();await h.camera.close();
  assert.deepEqual(saved.filter(row=>row.track==='track').map(row=>row.stamp),Array.from({length:48},(_,n)=>String(n)));
  assert.equal(saved.filter(row=>row.track==='fresh').length,2);assert.equal(overlaps,0);
  assert.equal(callVideoResourcesSnapshot().queued_bytes,before.queued_bytes);assert.deepEqual(h.errors,[]);
});

for(const reason of ['SOURCE_BINDING_INACTIVE','SOURCE_CURRENT_BINDING_REQUIRED','PAIRED_DEVICE_REVOKED'])
test(`failed camera capture releases ${reason} once without retaining its queue`,async t=>{
  const before=callVideoResourcesSnapshot(),logs:string[]=[];t.mock.method(console,'warn',(line:unknown)=>logs.push(String(line)));
  let attempts=0,discarded=0;
  const h=harness({archive:async()=>{attempts++;throw new ContractError(reason,403);},encoderFactory:(trackId,archive)=>{
    let segment:CallCameraSegment|undefined;
    return {write:async(event,at)=>{segment={bytes:Buffer.from([1]),mime:'video/h264',trackId,startedAt:at,endedAt:at,width:64,height:36,
      sourceWidth:W,sourceHeight:H,rotation:0,frameCount:1,sourceFrames:[{timestampUs:String(event.timestampUs),receivedAt:at}]};await archive(segment);},
      finish:async()=>{if(segment)await archive(segment);},discard:async()=>{discarded++;segment=undefined;}};
  }});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();h.feed(3);await tick();await tick();
  assert.equal(attempts,1,'a deterministic failed segment is never retried');assert.equal(discarded,1);
  assert.equal(h.errors.length,1);assert.match(String(h.errors[0]),new RegExp(reason));
  assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]!).reason,reason);
  assert.equal(callVideoResourcesSnapshot().queued_bytes,before.queued_bytes);assert.equal(callVideoResourcesSnapshot().readers,before.readers);
  await h.camera.close();await h.camera.close();assert.equal(attempts,1);
});

test('camera queue saturation is an alert: recording and the model frames continue after the pressure episode',async t=>{
  const logs:string[]=[];t.mock.method(console,'warn',(line:unknown)=>logs.push(String(line)));
  const gate=Promise.withResolvers<void>(),before=callVideoResourcesSnapshot();let writes=0;
  const h=harness({archive:async()=>{},encoderFactory:()=>({write:async()=>{writes++;await gate.promise;},finish:async()=>{},discard:async()=>{}})});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();await tick();
  h.feed(60,1280,720);for(let n=0;n<10;n++)await tick();
  assert.ok(callVideoResourcesSnapshot().dropped_frames>before.dropped_frames,'the 64 MiB queue saturates and counts drops');
  gate.resolve();for(let n=0;n<60;n++)await tick();
  const queued=writes,sent=h.sent.length;
  assert.ok(queued>=48,`the queued frames are still recorded after saturation, got ${queued}`);
  await h.play(3000);
  assert.equal(h.camera.active(),true,'one pressure episode does not end the capture');
  assert.ok(writes>queued,'recording continues after the pressure episode');
  assert.ok(h.sent.length>=sent+2,'the live model keeps receiving camera frames');
  assert.equal(h.errors.length,1);assert.match(String(h.errors[0]),/CALL_VIDEO_BACKPRESSURE_FRAME_DROPPED/);
  assert.equal(logs.filter(line=>line.includes('call_camera_capture')).length,0,'saturation is not a released capture');
  await h.camera.close();assert.equal(callVideoResourcesSnapshot().queued_bytes,before.queued_bytes);
});

test('a capture that fails with an empty queue releases its reader bookkeeping',async t=>{
  t.mock.method(console,'warn',()=>{});
  const before=callVideoResourcesSnapshot();
  const h=harness({archive:async()=>{},encoderFactory:()=>({write:async()=>{throw new Error('CALL_VIDEO_ENCODER_EXIT');},finish:async()=>{},discard:async()=>{}})});
  for(let round=0;round<3;round++){
    await h.camera.onBootstrapConnected({enabledMedia:{video:true},currentBinding:{credentialIdentity:'phone-1',round}} as never);
    h.publish('phone-1',TrackKind.KIND_VIDEO,TrackSource.SOURCE_CAMERA,false,{sid:`failed-${round}`});for(let n=0;n<5;n++)await tick();
    h.feed(1);for(let n=0;n<20;n++)await tick();
  }
  await h.camera.close();
  const after=callVideoResourcesSnapshot();
  assert.equal(after.readers,before.readers);assert.equal(after.stopped_readers,before.stopped_readers);
});

for(const reason of ['CALL_ARCHIVE_BACKLOG','CALL_VIDEO_ENCODER_EXIT'])test(`recording failure ${reason} preserves the live preview and releases the encoder`,async()=>{
  let writes=0,discarded=0;
  const h=harness({archive:async()=>{},encoderFactory:()=>({write:async()=>{writes++;throw new Error(reason);},finish:async()=>{},discard:async()=>{discarded++;}})});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();await h.play(100);
  assert.equal(h.camera.active(),true);assert.equal(h.camera.snapshot()?.recording_failed,true);
  assert.equal(writes,1);assert.equal(discarded,1);assert.equal(h.errors.length,1);
  const sent=h.sent.length;await h.play(2000);
  assert.ok(h.sent.length>sent);assert.equal(writes,1,'failed recording is not retried on every frame');
  await h.camera.close();assert.equal(h.camera.snapshot(),null);
});

test('a recorder blocked on the archive never freezes the live model frames',async()=>{
  const gate=Promise.withResolvers<void>();let writes=0;
  const h=harness({archive:async()=>{},encoderFactory:()=>({write:async()=>{writes++;await gate.promise;},finish:async()=>{},discard:async()=>{}})});
  await h.camera.onBootstrapConnected(h.input);h.publish();await tick();await tick();
  await h.play(3000);
  assert.equal(writes,1,'recording is stuck on its first frame');
  assert.ok(h.sent.length>=3,`the live model keeps ~1 fps while recording is blocked, got ${h.sent.length}`);
  gate.resolve();await h.camera.close();
});


test('camera transforms share alternate-format conversion outside the call process and release their child',async()=>{
  const transform=createCameraTransforms(),rgba=new VideoFrame(new Uint8Array(128*72*4).fill(150),128,72,VideoBufferType.RGBA);
  rgba.convert=()=>{throw new Error('main process conversion is forbidden');};
  try{
    const first=transform.project(rgba),second=transform.project(rgba);assert.equal(first,second);
    const projected=await first;assert.equal(projected.frame.type,VideoBufferType.I420);assert.equal(projected.grid.length,32*18);
    const jpeg=await transform.encode(projected.frame,0);assert.ok(jpeg);assert.equal(transform.snapshot().pending,0);
    const pid=transform.snapshot().pid!;assert.notEqual(pid,process.pid);await transform.close();
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }finally{await transform.close();}
});
