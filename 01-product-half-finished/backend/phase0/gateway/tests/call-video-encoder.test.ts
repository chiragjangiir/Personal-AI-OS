import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoBufferType, VideoFrame, type VideoFrameEvent } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { createCallVideoEncoder, boundedCameraReader, type CallCameraSegment, callVideoResourcesSnapshot, CALL_VIDEO_QUEUE_BYTES } from '../src/call-video-encoder.ts';
const event=(rotation=0,width=64,height=36,timestamp=100n)=>({frame:new VideoFrame(new Uint8Array(width*height*3/2),width,height,VideoBufferType.I420),rotation,timestampUs:timestamp} as VideoFrameEvent);
test('queued SDK camera frames yield to live call work even while recording is saturated',async()=>{
  const before=callVideoResourcesSnapshot(),errors:unknown[]=[];
  const frame=event(0,2048,4096);let acquired=0;
  const source=new ReadableStream<VideoFrameEvent>({start:c=>{for(let n=0;n<256;n++)c.enqueue(frame);c.close();}});
  const bounded=boundedCameraReader(source,error=>errors.push(error),Date.now,error=>errors.push(error),()=>{acquired++;});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(acquired>0&&acquired<256,`live work must run before the entire SDK backlog, got ${acquired}`);
    assert.ok(callVideoResourcesSnapshot().dropped_frames>before.dropped_frames,'saturated frames must yield too');
    await bounded.stop();while(!(await bounded.reader.read()).done){}await bounded.settled;
    assert.equal(errors.length,1);assert.match(String(errors[0]),/CALL_VIDEO_BACKPRESSURE_FRAME_DROPPED/);
  }finally{await bounded.reader.cancel();bounded.reader.releaseLock();}
  assert.equal(callVideoResourcesSnapshot().queued_bytes,before.queued_bytes);
});
async function fixture(run:(binary:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'paios-video-pipe-'));
  const binary=join(dir,'encoder');
  await writeFile(binary,`#!${process.execPath}\nlet count=0;process.stdin.on('data',b=>{count+=b.length;});process.stdin.on('end',()=>{const out=Buffer.alloc(8);out.writeUInt32BE(1);out.writeUInt32BE(count,4);process.stdout.end(out);});\n`);
  await chmod(binary,0o700);
  try{await run(binary);}finally{await rm(dir,{recursive:true,force:true});}
}
test('pipe encoder finalizes each60 frames and each rotation or dimensions boundary without writing raw files',async()=>fixture(async binary=>{
  const segments:CallCameraSegment[]=[];
  const encoder=createCallVideoEncoder('phone-camera',async s=>{segments.push(s);},binary);
  for(let n=0;n<61;n++)await encoder.write(event(0,64,36,BigInt(n)),n*33);
  await encoder.write(event(1),2100);
  await encoder.write(event(1,128,72),2200);
  await encoder.finish();
  assert.deepEqual(segments.map(s=>s.frameCount),[60,1,1,1]);
  assert.deepEqual(segments.map(s=>s.rotation),[0,0,1,1]);
  assert.deepEqual(segments.map(s=>s.sourceWidth),[64,64,64,128]);
  assert.equal(segments[0]!.bytes.readUInt32BE(4),60*64*36*3/2);
  assert.equal(segments[0]!.sourceFrames.at(-1)!.timestampUs,'59');
  assert.equal(segments[0]!.startedAt,0);assert.equal(segments[0]!.endedAt,59*33);
}));
test('archive ack backpressure retains identical finalized segment and retry never reencodes',async()=>fixture(async binary=>{
  let failed=true;const seen:CallCameraSegment[]=[];
  const encoder=createCallVideoEncoder('track',async segment=>{seen.push(segment);if(failed)throw new Error('archive unavailable');},binary);
  await encoder.write(event(),42);
  await assert.rejects(encoder.finish(),/archive unavailable/);
  failed=false;await encoder.finish();await encoder.finish();
  assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);assert.equal(seen[0]!.bytes.readUInt32BE(4),64*36*3/2);
}));
test('missing encoder is a visible capture failure',async()=>{
  const encoder=createCallVideoEncoder('track',async()=>{assert.fail('must not archive');},'/missing/paios-encoder');
  await assert.rejects(encoder.write(event(),0));
  await assert.rejects(encoder.finish());
  await encoder.discard?.();await encoder.finish();
});
test('the archive encoder runs at the lowest CPU priority so live call work wins a busy host',async()=>fixture(async binary=>{
  const encoder=createCallVideoEncoder('priority',async()=>{},binary);
  await encoder.write(event(),0);
  const pids=callVideoResourcesSnapshot().encoder_pids;
  assert.ok(pids.length>0);
  for(const pid of pids)assert.equal(getPriority(pid),19);
  await encoder.finish();
}));
test('a burst below the byte budget archives every frame instead of stopping at thirty-two',async()=>{
  let canceled=false;const errors:unknown[]=[];
  const source=new ReadableStream<VideoFrameEvent>({start:c=>{for(let n=0;n<40;n++)c.enqueue(event(0,1280,720));},cancel:()=>{canceled=true;}});
  const bounded=boundedCameraReader(source,error=>errors.push(error));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(canceled,false);await bounded.stop();let count=0;while(!(await bounded.reader.read()).done)count++;
  assert.equal(count,40);assert.equal(errors.length,0);bounded.reader.releaseLock();
});

test('actual byte saturation counts loss, alerts, and resumes without replacing the source',async()=>{
  const before=callVideoResourcesSnapshot(),errors:unknown[]=[];let canceled=false,controller!:ReadableStreamDefaultController<VideoFrameEvent>;
  const source=new ReadableStream<VideoFrameEvent>({start:c=>{controller=c;for(let n=0;n<6;n++)c.enqueue(event(0,2048,4096));},cancel:()=>{canceled=true;}});
  const bounded=boundedCameraReader(source,error=>errors.push(error));await new Promise(resolve=>setImmediate(resolve));
  const full=callVideoResourcesSnapshot();assert.equal(canceled,false);assert.equal(errors.length,1);
  assert.match(String(errors[0]),/CALL_VIDEO_BACKPRESSURE_FRAME_DROPPED/);
  assert.equal(full.queued_bytes-before.queued_bytes,5*2048*4096*3/2);
  assert(full.queued_bytes-before.queued_bytes<=CALL_VIDEO_QUEUE_BYTES);
  assert.equal(full.dropped_frames-before.dropped_frames,1);
  assert.equal(full.dropped_bytes-before.dropped_bytes,2048*4096*3/2);
  for(let n=0;n<5;n++)assert.equal((await bounded.reader.read()).done,false);
  controller.enqueue(event());controller.close();
  let count=0;while(!(await bounded.reader.read()).done)count++;assert.equal(count,1);
  bounded.reader.releaseLock();assert.equal(callVideoResourcesSnapshot().queued_bytes,before.queued_bytes);
  assert.equal(callVideoResourcesSnapshot().received_frames-before.received_frames,7);
  assert.equal(callVideoResourcesSnapshot().dropped_frames-before.dropped_frames,1,'loss remains visible after reader retirement');
});

test('source stop drains queued frames before delayed cancellation settles',async()=>{
  const cancel=Promise.withResolvers<void>(),errors:unknown[]=[];
  const source=new ReadableStream<VideoFrameEvent>({start:c=>{for(let n=0;n<3;n++)c.enqueue(event(0,64,36,BigInt(n)));},cancel:()=>cancel.promise});
  const bounded=boundedCameraReader(source,error=>errors.push(error));await new Promise(resolve=>setImmediate(resolve));
  let settled=false;void bounded.settled.then(()=>{settled=true;});await bounded.stop();
  const timestamps:string[]=[];while(true){const next=await bounded.reader.read();if(next.done)break;timestamps.push(String(next.value.timestampUs));}
  assert.deepEqual(timestamps,['0','1','2']);assert.equal(settled,false);
  cancel.resolve();await bounded.settled;bounded.reader.releaseLock();assert.deepEqual(errors,[]);
});

test('source stop retains an already-read handoff and exposes rejected cancellation',async()=>{
  const cancel=Promise.withResolvers<void>(),errors:unknown[]=[];
  const source=new ReadableStream<VideoFrameEvent>({start:c=>c.enqueue(event()),cancel:()=>cancel.promise});
  const bounded=boundedCameraReader(source,error=>errors.push(error));await bounded.stop();
  assert.equal((await bounded.reader.read()).done,false);assert.equal((await bounded.reader.read()).done,true);
  const failed=assert.rejects(bounded.settled,/CALL_VIDEO_SOURCE_CANCEL_FAILED/);cancel.reject(new TypeError('native cancel failed'));await failed;
  assert.match(String(errors[0]),/CALL_VIDEO_SOURCE_CANCEL_FAILED/);bounded.reader.releaseLock();
});


test('failed child remains an explicit finish failure until its owner discards it',async()=>fixture(async binary=>{
  await writeFile(binary,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.once('end',()=>{process.stdout.write(Buffer.from([1,2,3]));process.exitCode=7;});\n`);
  const before=callVideoResourcesSnapshot();let archived=0;
  const encoder=createCallVideoEncoder('failed-child',async()=>{archived++;},binary);
  await encoder.write(event(),0);
  await assert.rejects(encoder.finish(),/CALL_VIDEO_ENCODER_EXIT:7/);
  await assert.rejects(encoder.finish(),/CALL_VIDEO_ENCODER_EXIT:7/);
  assert.equal(callVideoResourcesSnapshot().encoders,before.encoders+1);
  assert.equal(callVideoResourcesSnapshot().encoded_bytes-before.encoded_bytes,3);
  await encoder.discard!();await encoder.discard!();await encoder.finish();await encoder.finish();
  assert.equal(archived,0);assert.equal(callVideoResourcesSnapshot().encoders,before.encoders);
  assert.equal(callVideoResourcesSnapshot().encoded_bytes,before.encoded_bytes);
}));

test('explicit discard kills and joins only its live child and releases its snapshot',async()=>fixture(async binary=>{
  const before=callVideoResourcesSnapshot();let archived=0;
  const encoder=createCallVideoEncoder('discard-live',async()=>{archived++;},binary);
  await encoder.write(event(),0);const active=callVideoResourcesSnapshot();
  const pid=active.encoder_pids.find(pid=>!before.encoder_pids.includes(pid));assert.ok(pid);
  await Promise.all([encoder.discard!(),encoder.discard!()]);await encoder.finish();
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(archived,0);
  const after=callVideoResourcesSnapshot();assert.equal(after.encoders,before.encoders);
  assert.equal(after.input_frame_bytes,before.input_frame_bytes);assert.equal(after.stdin_bytes,before.stdin_bytes);
}));

test('downstream cancellation releases queued originals and records their loss',async()=>{
  const before=callVideoResourcesSnapshot();let cancellations=0;const errors:unknown[]=[];
  const source=new ReadableStream<VideoFrameEvent>({start:c=>{for(let n=0;n<3;n++)c.enqueue(event());},cancel:()=>{cancellations++;}});
  const bounded=boundedCameraReader(source,error=>errors.push(error));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(callVideoResourcesSnapshot().queued_frames-before.queued_frames,3);
  await bounded.reader.cancel();await bounded.settled;await bounded.reader.cancel();bounded.reader.releaseLock();
  const after=callVideoResourcesSnapshot();assert.equal(cancellations,1);assert.deepEqual(errors,[]);
  assert.equal(after.queued_bytes,before.queued_bytes);assert.equal(after.queued_frames,before.queued_frames);assert.equal(after.readers,before.readers);
  assert.equal(after.dropped_frames-before.dropped_frames,3);assert.equal(after.dropped_bytes-before.dropped_bytes,3*64*36*3/2);
});
