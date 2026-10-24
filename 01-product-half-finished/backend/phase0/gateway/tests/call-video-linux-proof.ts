/** Isolated Linux qualification: node tests/call-video-linux-proof.ts 120; run in owned docker --cpus=1 container.
 * Imports the production encoder. Pipes synthetic decoded frames and finalized H264 only; writes no media files. */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { VideoBufferType, VideoFrame, type VideoFrameEvent } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { boundedCameraReader, createCallVideoEncoder, type CallCameraSegment } from '../src/call-video-encoder.ts';
if(process.platform!=='linux')throw new Error('Linux qualification only');
const seconds=Number(process.argv[2]??120),width=1280,height=720,fps=30;
if(!Number.isInteger(seconds)||seconds<10||seconds>600)throw new Error('duration10..600');
const ticks=async()=>{const raw=await readFile('/proc/self/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');return Number(fields[13])+Number(fields[14]);};
const beforeTicks=await ticks(),before=process.resourceUsage(),start=performance.now();
let maxEncoderRss=0,maxNodeRss=process.memoryUsage().rss,maxWriteMs=0,writesOverFrame=0,peakChildren=0;
let sampleBusy=false;const sample=setInterval(()=>{
  if(sampleBusy)return;sampleBusy=true;
  void(async()=>{
    maxNodeRss=Math.max(maxNodeRss,process.memoryUsage().rss);
    const children=(await readFile(`/proc/self/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean);
    peakChildren=Math.max(peakChildren,children.length);
    for(const pid of children){try{const status=await readFile(`/proc/${pid}/status`,'utf8');maxEncoderRss=Math.max(maxEncoderRss,Number(status.match(/VmRSS:\s+(\d+)/)?.[1]??0)*1024);}catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
  })().finally(()=>{sampleBusy=false;});
},100);
const segments:CallCameraSegment[]=[];let received=0,archivedFrames=0,totalBytes=0;
const encoder=createCallVideoEncoder('isolated-linux-720p30',async segment=>{
  segments.push(segment);archivedFrames+=segment.frameCount;totalBytes+=segment.bytes.length;
});
let controller!:ReadableStreamDefaultController<VideoFrameEvent>,captureStopped=false;const ingressErrors:unknown[]=[];
const source=new ReadableStream<VideoFrameEvent>({start:value=>{controller=value;},cancel:()=>{captureStopped=true;}});
const bounded=boundedCameraReader(source,error=>ingressErrors.push(error));
const producer=(async()=>{
  for(let n=0;n<seconds*fps&&!captureStopped;n++){
    const due=start+n*1000/fps;if(performance.now()<due)await sleep(due-performance.now());
    if(captureStopped)break;
    const pixels=new Uint8Array(width*height*3/2).fill(128);
    // Moving luma bars plus changing chroma. This is synthetic motion, not a speech/camera-content claim.
    for(let y=0;y<height;y++){const base=16+(Math.floor(y/24)+n)%180;pixels.fill(base,y*width,(y+1)*width);const x=(n*17+y)% (width-160);pixels.fill(235,y*width+x,y*width+x+160);}
    pixels.fill(96+n%64,width*height,width*height*5/4);
    received++;controller.enqueue({frame:new VideoFrame(pixels,width,height,VideoBufferType.I420),rotation:0,timestampUs:BigInt(n)*1_000_000n/30n} as VideoFrameEvent);
  }
  if(!captureStopped)controller.close();
})();
try{
  while(true){const next=await bounded.reader.read();if(next.done)break;const at=performance.now();
    await encoder.write(next.value,next.value.receivedAt);const elapsed=performance.now()-at;maxWriteMs=Math.max(maxWriteMs,elapsed);if(elapsed>1000/fps)writesOverFrame++;}
  await producer;await encoder.finish();bounded.reader.releaseLock();
}finally{clearInterval(sample);}
const elapsedMs=performance.now()-start,after=process.resourceUsage(),afterTicks=await ticks();
let decodedFrames=0;
for(const segment of segments){
  const child=spawn('ffprobe',['-v','error','-f','h264','-count_frames','-show_entries','stream=nb_read_frames,width,height','-of','json','pipe:0'],{stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{error+=bytes;});
  const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(error)));});
  child.stdin.end(segment.bytes);await done;const stream=JSON.parse(output).streams[0];
  if(stream.width!==width||stream.height!==height)throw new Error('encoded dimensions mismatch');
  decodedFrames+=Number(stream.nb_read_frames);
}
const metrics={platform:process.platform,arch:process.arch,seconds,quota:'docker --cpus=1 required',received,archivedFrames,decodedFrames,
  segments:segments.length,totalBytes,bitrateMbps:totalBytes*8/(seconds*1_000_000),elapsedMs,effectiveFps:received/(elapsedMs/1000),
  encoderAndChildCpuSeconds:(afterTicks-beforeTicks)/100,nodeCpuSeconds:(after.userCPUTime+after.systemCPUTime-before.userCPUTime-before.systemCPUTime)/1_000_000,
  maxEncoderRssBytes:maxEncoderRss,maxNodeRssBytes:maxNodeRss,peakChildren,maxWriteMs,writesOverFrame,
  sourceTimelineFrames:segments.reduce((sum,segment)=>sum+segment.sourceFrames.length,0),backlogFrames:received-archivedFrames,ingressErrors:ingressErrors.map(String),captureStopped,intermediateI420Files:0};
console.log(JSON.stringify(metrics,null,2));
if(ingressErrors.length)throw new Error('bounded ingress stopped capture');
if(received!==seconds*fps||archivedFrames!==received||decodedFrames!==received)throw new Error('frame accounting failed');
if(metrics.effectiveFps<29.9)throw new Error('720p30 quota qualification failed');
