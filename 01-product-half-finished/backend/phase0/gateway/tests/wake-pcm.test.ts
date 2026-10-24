import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReadableStream,type ReadableStreamDefaultController} from 'node:stream/web';
import {EventEmitter} from 'node:events';
import {RoomEvent,TrackKind,TrackSource,dispose} from '@livekit/rtc-node';
import {createFormalPcmIngress,type PcmFrame} from '../src/personal-aios-formal-pcm.ts';
import {createSourceMediaClock} from '../src/source-media-clock.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import type {RawEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import type {SourceMediaCaptureBinding} from '../src/source-media-permission.ts';
after(()=>dispose());
const settle=async(predicate:()=>boolean)=>{for(let n=0;n<1000&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(predicate());};
async function fixture(t:test.TestContext,audio=false,decision?:Promise<boolean>,publicationWait?:Promise<void>,pendingBytes=160000){
  const directory=await mkdtemp(join(tmpdir(),'wake-pcm-')),storage=new PosixStorage(directory);
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc',route_version:'route',submission:'observation'};
  const binding={continuityId:'continuity',connectionEpoch:'1',userId:'owner',deviceId:'phone',purpose:'assistant',
    realtimeSessionRef:{ref_id:'session'},deviceLeaseRef:{ref_id:'lease-1'}} as unknown as SourceMediaCaptureBinding;
  const room=Object.assign(new EventEmitter(),{isConnected:true,remoteParticipants:new Map()});
  const track={sid:'rtp'},publication={kind:TrackKind.KIND_AUDIO,source:TrackSource.SOURCE_MICROPHONE,sid:'rtp',track};
  const peer={identity:'terminal',trackPublications:new Map([['rtp',publication]])};room.remoteParticipants.set('terminal',peer);
  const raws:{raw:RawEvent;chunk:TrackChunk}[]=[],heard:number[]=[],errors:unknown[]=[],finished:string[]=[];
  const archivedWaiters=new Map<number,()=>void>();
  let captureWait:Promise<void>|undefined;
  let rtpController!:ReadableStreamDefaultController<PcmFrame>,streams=0,cancels=0,revoked=false,disconnects=0;
  const clock=createSourceMediaClock(storage,{evidence:'calibrated',resolve:async(_binding,chunk)=>({modality:chunk.modality,
    track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_timebase_id:chunk.source_range.timebase_id,
    target_timebase_id:'utc_epoch_ms',offset_ms:Date.now(),drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture'})});
  const ingress=createFormalPcmIngress({participant:{roomPort:room,disconnect:async()=>{disconnects++;}} as never,
    authority:{credentialForBootstrap:(input:{currentBinding:{connectionEpoch:string;deviceLeaseRef?:SourceMediaCaptureBinding['deviceLeaseRef']}})=>({binding:{...binding,connectionEpoch:input.currentBinding.connectionEpoch,deviceLeaseRef:input.currentBinding.deviceLeaseRef??binding.deviceLeaseRef}}),
      authenticate:async()=>source,capture:async(credential:{binding:SourceMediaCaptureBinding})=>{
      if(captureWait)await captureWait;
      if(revoked)throw new Error('CAPTURE_REVOKED');return {binding:credential.binding,trusted:source};}} as never,
    runtime:{authenticate:async()=>source,existingArchive:()=>({prepareCapture:async()=>{},bindCallTrack:async()=>{}}),archivedAudioRoute:async()=>undefined,
      appendMedia:async(raw:RawEvent,_source:unknown,chunk:TrackChunk,_signal:unknown,lifecycle:{onDurable():void})=>{
        raws.push({raw:structuredClone(raw),chunk:structuredClone(chunk)});lifecycle.onDurable();
        archivedWaiters.get(raws.length)?.();archivedWaiters.delete(raws.length);
        if(publicationWait)await publicationWait;
        return {event:{...raw,principal_id:'owner',raw_ref:'l5:'+raw.event_id,archive_revision:'revision'}};
      }} as never,clock,budget:{max_frame_samples:1600,max_pending_frames:50,max_pending_bytes:pendingBytes,max_samples:160000},
    streamFactory:()=>{streams++;return new ReadableStream<PcmFrame>({start:c=>{rtpController=c;},cancel:()=>{cancels++;}});},
    captureDecision:()=>decision,finishArchived:async snapshot=>{finished.push(snapshot.event.event_id);},onError:error=>errors.push(error)});
  ingress.tap(pcm=>{heard.push(pcm[0]!);});
  const input={bearer:{deviceId:'phone'},currentBinding:{credentialIdentity:'terminal',connectionEpoch:'1'},enabledMedia:{audio}};
  await ingress.onBootstrapConnected(input as never);
  t.after(async()=>{await ingress.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const frame=(seq:number,at:number,value=seq+1)=>({seq,captured_at_ms:at,sample_rate:16000 as const,pcm_s16le_base64:Buffer.from(new Int16Array(1600).fill(value).buffer).toString('base64')});
  return {ingress,frame,heard,raws,errors,storage,clock,binding,finished,room,publication,peer,rtp:()=>rtpController,
    archived:(count:number)=>raws.length>=count?Promise.resolve():new Promise<void>(resolve=>archivedWaiters.set(count,resolve)),
    bootstrap:(epoch:string)=>ingress.onBootstrapConnected({...input,currentBinding:{...input.currentBinding,connectionEpoch:epoch,deviceLeaseRef:{ref_id:`lease-${epoch}`}}} as never),
    blockCapture:(wait:Promise<void>)=>{captureWait=wait;},counts:()=>({streams,cancels,disconnects}),revoke:()=>{revoked=true;}};
}

test('wake wire works before RTP enable, archives through the same PCM owner, and seals reported timing as estimated',async t=>{
  const f=await fixture(t),at=Date.now()-3600000+.25;
  await f.ingress.wake.open('wake');
  await f.ingress.wake.append('wake',f.frame(0,at));await f.ingress.wake.append('wake',f.frame(1,at+125));
  await f.ingress.wake.append('wake',f.frame(2,at+225));await settle(()=>f.raws.length===3);
  assert.deepEqual(f.heard,[1,2,3]);assert.equal(f.counts().streams,0);
  assert.equal(f.raws[0]!.raw.captured_at,new Date(at).toISOString());
  assert.ok(Math.abs(Date.parse(f.raws[0]!.raw.captured_at)-at)<1,'UTC serialization preserves fractional device capture within 1 ms');
  assert.equal(f.raws[0]!.raw.source.capture_timing!.quality,'estimated');
  assert.ok(f.raws[0]!.raw.source.capture_timing!.uncertainty_ms>=3600000);
  assert.deepEqual(f.raws.map(x=>x.chunk.source_range).map(r=>r.kind==='interval'?[r.start_ms,r.end_ms]:null),[[0,100],[125,225],[225,325]]);
  const proofs=await f.storage.list('source-clock-bases');assert.equal(proofs.length,1);
  const proof=JSON.parse(Buffer.from(await f.storage.read('source-clock-bases',proofs[0]!)).toString());
  assert.equal(proof.evidence,'receipt_estimated');assert.equal(proof.reported_capture.captured_at_ms,at);
  const map=await f.clock.read(f.binding,f.raws[0]!.chunk,f.raws[0]!.raw);assert.equal(map!.offset_ms,at);
  await f.clock.authorizeClockMaps('owner',[map!],{...f.raws[0]!.raw,principal_id:'owner'} as never);
  await f.ingress.wake.close('wake');assert.equal(f.finished.length,1);assert.deepEqual(f.errors,[]);
});

test('wake pauses the RTP reader, ignores new RTP subscriptions and reconnect events, then resumes ambient RTP',async t=>{
  const f=await fixture(t,true),at=Date.now();assert.equal(f.counts().streams,1);
  await f.ingress.wake.open('wake');assert.equal(f.counts().cancels,1);
  f.room.emit(RoomEvent.TrackSubscribed,f.publication.track,f.publication,f.peer);
  f.room.emit(RoomEvent.Reconnecting);f.room.emit(RoomEvent.Reconnected);
  await f.ingress.wake.append('wake',f.frame(0,at));await settle(()=>f.raws.length===1);
  assert.equal(f.counts().streams,1);assert.deepEqual(f.heard,[1]);
  await f.ingress.wake.close('wake');assert.equal(f.counts().streams,2);
  f.rtp().enqueue({data:new Int16Array([7]),sampleRate:16000,channels:1,samplesPerChannel:1});
  await settle(()=>f.raws.length===2);assert.deepEqual(f.heard,[1,7]);assert.deepEqual(f.errors,[]);
});

test('wake queue admits five seconds without dropping and explicitly rejects overflow, duplicates and other calls',async t=>{
  const decision=Promise.withResolvers<boolean>(),f=await fixture(t,false,decision.promise),at=Date.now();
  await f.ingress.wake.open('wake');
  for(let seq=0;seq<50;seq++)await f.ingress.wake.append('wake',f.frame(seq,at+seq*100));
  await assert.rejects(f.ingress.wake.append('wake',f.frame(50,at+5000)),/WAKE_PCM_BACKPRESSURE/);
  await assert.rejects(f.ingress.wake.append('wake',f.frame(49,at+4900)),/WAKE_PCM_SEQUENCE_INVALID/);
  await assert.rejects(f.ingress.wake.append('other',f.frame(0,at)),/WAKE_PCM_CALL_REQUIRED/);
  decision.resolve(true);await f.archived(50);
  assert.equal(f.ingress.snapshot().dropped_frames,0);assert.equal(f.heard.length,50);
  await f.ingress.wake.close('wake');assert.deepEqual(f.errors,[]);
});

test('wake rechecks source capture permission before archival and retires a revoked source',async t=>{
  const f=await fixture(t);await f.ingress.wake.open('wake');f.revoke();
  await f.ingress.wake.append('wake',f.frame(0,Date.now()));await settle(()=>f.counts().disconnects===1);
  assert.equal(f.raws.length,0);assert.ok(f.errors.some(error=>/CAPTURE_REVOKED/.test(String(error))));
  await assert.rejects(f.ingress.wake.append('wake',f.frame(1,Date.now()+100)),/WAKE_PCM_CALL_REQUIRED/);
});

test('a false wake still reaches the one live tap but never archives its gated PCM',async t=>{
  const decision=Promise.withResolvers<boolean>(),f=await fixture(t,false,decision.promise),at=Date.now();
  await f.ingress.wake.open('false-wake');
  await f.ingress.wake.append('false-wake',f.frame(0,at));await settle(()=>f.heard.length===1);
  assert.equal(f.raws.length,0);decision.resolve(false);await f.ingress.wake.close('false-wake');
  assert.equal(f.raws.length,0);assert.equal(f.finished.length,0);assert.deepEqual(f.errors,[]);
});


test('same wake open reuses its ready promise and pre-ready PCM stays queued behind source allocation',async t=>{
  const f=await fixture(t),allocation=Promise.withResolvers<void>(),at=Date.now();f.blockCapture(allocation.promise);
  const first=f.ingress.wake.open('wake');assert.strictEqual(f.ingress.wake.open('wake'),first);
  const append=f.ingress.wake.append('wake',f.frame(0,at));assert.equal(f.raws.length,0);
  allocation.resolve();await Promise.all([first,append]);await settle(()=>f.raws.length===1);
  await f.ingress.wake.open('wake');await f.ingress.wake.append('wake',f.frame(1,at+100));
  await settle(()=>f.raws.length===2);assert.deepEqual(f.heard,[1,2]);await f.ingress.wake.close('wake');
});

test('new wake acquires the source before old model publication settles and stale close cannot affect it',async t=>{
  const publication=Promise.withResolvers<void>(),f=await fixture(t,false,undefined,publication.promise),at=Date.now();
  await f.ingress.wake.open('old');await f.ingress.wake.append('old',f.frame(0,at));await settle(()=>f.raws.length===1);
  await f.ingress.wake.close('old');await f.ingress.wake.open('new');
  await f.ingress.wake.close('old');await f.ingress.wake.append('new',f.frame(0,at+100));await settle(()=>f.raws.length===2);
  assert.deepEqual(f.heard,[1,1]);assert.equal(f.finished.length,0,'old publication still owns its completion');
  publication.resolve();await f.ingress.wake.close('new');await settle(()=>f.finished.length===2);assert.deepEqual(f.errors,[]);
});

test('close during pending allocation fences the old wake and permits a fresh wake without resurrection',async t=>{
  const f=await fixture(t),allocation=Promise.withResolvers<void>();f.blockCapture(allocation.promise);
  const opening=f.ingress.wake.open('old'),rejected=assert.rejects(opening,/WAKE_PCM_CALL_CLOSED/);
  const closing=f.ingress.wake.close('old'),fresh=f.ingress.wake.open('new');allocation.resolve();
  await Promise.all([rejected,closing,fresh]);await f.ingress.wake.close('old');
  await f.ingress.wake.append('new',f.frame(0,Date.now()));await settle(()=>f.raws.length===1);
  await f.ingress.wake.close('new');assert.deepEqual(f.errors,[]);
});


test('gated first speech longer than five seconds uses the existing PCM byte budget and reaches the live tap immediately',async t=>{
  const decision=Promise.withResolvers<boolean>(),f=await fixture(t,false,decision.promise,undefined,320000),at=Date.now();
  await f.ingress.wake.open('long-first-speech');
  for(let seq=0;seq<60;seq++)await f.ingress.wake.append('long-first-speech',f.frame(seq,at+seq*100));
  await settle(()=>f.heard.length===60);assert.equal(f.heard[0],1);assert.equal(f.heard.at(-1),60);
  assert.equal(f.raws.length,0,'directed speech is not archived before its capture decision');
  decision.resolve(true);await f.archived(60);
  assert.equal(Buffer.from(f.raws[0]!.raw.payload).readInt16LE(0),1);
  assert.equal(Buffer.from(f.raws.at(-1)!.raw.payload).readInt16LE(0),60);
  assert.equal(f.ingress.snapshot().dropped_frames,0);await f.ingress.wake.close('long-first-speech');assert.deepEqual(f.errors,[]);
});


test('live wake survives authenticated bootstrap renewal with strict sequence and original per-frame capture proofs',async t=>{
  const decision=Promise.withResolvers<boolean>(),f=await fixture(t,false,decision.promise),at=Date.now();
  await f.ingress.wake.open('wake');await f.ingress.wake.append('wake',f.frame(0,at));await settle(()=>f.heard.length===1);
  await f.bootstrap('2');await f.ingress.wake.open('wake');
  await assert.rejects(f.ingress.wake.append('wake',f.frame(0,at)),/WAKE_PCM_SEQUENCE_INVALID/);
  await f.ingress.wake.append('wake',f.frame(1,at+100));await settle(()=>f.heard.length===2);
  assert.deepEqual(f.heard,[1,2]);assert.equal(f.raws.length,0);assert.equal(f.counts().streams,0);
  decision.resolve(true);await settle(()=>f.raws.length===2);
  const proofs=await Promise.all((await f.storage.list('source-clock-bases')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('source-clock-bases',key)).toString())));
  assert.deepEqual(proofs.map(proof=>proof.binding.connectionEpoch).sort(),['1','2']);
  assert.deepEqual(proofs.map(proof=>proof.binding.deviceLeaseRef.ref_id).sort(),['lease-1','lease-2']);
  assert.notEqual(f.raws[0]!.chunk.stream_epoch,f.raws[1]!.chunk.stream_epoch);
  assert.equal(f.raws[0]!.raw.captured_at,new Date(at).toISOString());assert.equal(f.raws[1]!.raw.captured_at,new Date(at+100).toISOString());
  await f.ingress.wake.close('wake');assert.deepEqual(f.errors,[]);
});


test('a stopped wake source fails bootstrap renewal instead of reopening its canceled stream',async t=>{
  const f=await fixture(t);await f.ingress.wake.open('wake');f.room.emit(RoomEvent.Disconnected);
  await assert.rejects(f.bootstrap('2'),/WAKE_PCM_SOURCE_REQUIRED/);
  assert.throws(()=>f.ingress.wake.open('wake'),/WAKE_PCM_SOURCE_REQUIRED/);
  await assert.rejects(f.ingress.wake.append('wake',f.frame(0,Date.now())),/WAKE_PCM_CALL_REQUIRED/);
});

test('buffered wake prefix preserves the exact first question sample after the 1600 ms opening receipt',async t=>{
  const f=await fixture(t),at=Date.now()-1600;
  const packets=Array.from({length:16},(_,seq)=>f.frame(seq,at+seq*100,seq<10?4000:13000));
  const question=Buffer.alloc(3200);for(let sample=1120;sample<1600;sample++)question.writeInt16LE(13000,sample*2);
  packets[10]={...packets[10]!,pcm_s16le_base64:question.toString('base64')};
  // These sixteen packets were captured before source readiness. The question starts 70 ms after the wake word ends.
  await f.ingress.wake.open('first-question');const openingReceiptAt=Date.now();assert.ok(openingReceiptAt>=at+1600);
  for(const packet of packets)await f.ingress.wake.append('first-question',packet);
  await settle(()=>f.raws.length===16);
  const archivedQuestion=Buffer.from(f.raws[10]!.raw.payload);
  assert.deepEqual(archivedQuestion,question);assert.equal(archivedQuestion.readInt16LE(1119*2),0);
  assert.equal(archivedQuestion.readInt16LE(1120*2),13000);
  assert.deepEqual(f.raws.map(({chunk})=>chunk.seq),Array.from({length:16},(_,seq)=>seq));
  assert.deepEqual(f.raws.map(({chunk})=>chunk.source_range).map(range=>range.kind==='interval'?[range.start_ms,range.end_ms]:null),
    Array.from({length:16},(_,seq)=>[seq*100,(seq+1)*100]));
  assert.deepEqual(f.raws.map(({raw})=>raw.time_range).map(range=>range?.kind==='interval'?[range.start_ms,range.end_ms]:null),
    Array.from({length:16},(_,seq)=>[at+seq*100,at+(seq+1)*100]));
  assert.equal(f.heard.length,16);assert.equal(f.heard[10],0);assert.equal(f.ingress.snapshot().dropped_frames,0);
  await f.ingress.wake.close('first-question');assert.deepEqual(f.errors,[]);
});
