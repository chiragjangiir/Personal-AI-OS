import {createCameraTransforms} from './call-camera-transform.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setPriority } from 'node:os';
import { setImmediate as yieldToCall } from 'node:timers/promises';
import { VideoBufferType, type VideoFrame, type VideoFrameEvent } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultReader, type ReadableStreamDefaultController } from 'node:stream/web';

export type CallCameraSegment = {
  bytes: Buffer; mime: 'video/h264'; trackId: string; startedAt: number; endedAt: number;
  width: number; height: number; sourceWidth: number; sourceHeight: number; rotation: number;
  frameCount: number; sourceFrames: {timestampUs: string; receivedAt: number}[];
};
export type CallVideoEncoder = {write(event: VideoFrameEvent, receivedAt: number): Promise<void>; finish(): Promise<void>; discard?():Promise<void>};
export type CallVideoEncoderFactory = (trackId: string, archive: (segment: CallCameraSegment) => Promise<void>, project?:(frame:VideoFrame)=>Promise<VideoFrame>) => CallVideoEncoder;
export const CALL_VIDEO_SEGMENT_BYTES = 2 * 1024 * 1024;
export const CALL_VIDEO_QUEUE_BYTES = 64 * 1024 * 1024;
// A received frame cannot be split or evicted. Saturation can retain one final 4096² RGBA frame.
const MAX_FRAME_BYTES = 4096 * 4096 * 4;
const readers = new Set<() => {queued_bytes: number; queued_frames: number; stopped: boolean}>();
// Lifetime acquisition accounting survives reader retirement; the archive journal owns durable coverage.
const capture = {received_frames: 0, received_bytes: 0, dropped_frames: 0, dropped_bytes: 0, peak_queued_bytes: 0};
const encoders = new Set<() => {stdin_bytes: number; input_frame_bytes: number; encoded_bytes: number; finalized_bytes: number; pid: number | undefined}>();
export function callVideoResourcesSnapshot() {
  const queues = [...readers].map(read => read()), pipes = [...encoders].map(read => read());
  return {...capture, readers: queues.length, encoders: pipes.length, encoder_pids: pipes.flatMap(p => p.pid ? [p.pid] : []), queue_budget_bytes: CALL_VIDEO_QUEUE_BYTES,
    queue_max_retained_bytes: CALL_VIDEO_QUEUE_BYTES + MAX_FRAME_BYTES, segment_budget_bytes: CALL_VIDEO_SEGMENT_BYTES,
    queued_bytes: queues.reduce((n, q) => n + q.queued_bytes, 0), queued_frames: queues.reduce((n, q) => n + q.queued_frames, 0),
    stopped_readers: queues.filter(q => q.stopped).length, input_frame_bytes: pipes.reduce((n, p) => n + p.input_frame_bytes, 0), stdin_bytes: pipes.reduce((n, p) => n + p.stdin_bytes, 0),
    encoded_bytes: pipes.reduce((n, p) => n + p.encoded_bytes, 0), finalized_bytes: pipes.reduce((n, p) => n + p.finalized_bytes, 0)};
}
const SEGMENT_FRAMES = 60, IO_TIMEOUT_MS = 10_000;

/** SDK VideoStream ignores desiredSize. Drain into the byte-bounded queue. At actual saturation, count rejected
 * frames and report once per pressure episode through onPressure: an alert, never a capture failure. Keep acquiring
 * so capacity recovery resumes capture automatically. onError receives only failures that end acquisition.
 * stop() closes acquisition but preserves the already queued frames for the encoder to drain.
 * onFrame is the live consumer: it sees every acquired frame before the queue bound, so a slow encoder or archive
 * only costs the recording, never the live view. Its errors are alerts (onPressure), not acquisition failures. */
export function boundedCameraReader(source: ReadableStream<VideoFrameEvent>, onError: (error: unknown) => void, now = Date.now,
  onPressure: (error: unknown) => void = onError, onFrame?: (event: VideoFrameEvent & {receivedAt: number}) => void): {
  reader: ReadableStreamDefaultReader<VideoFrameEvent & {receivedAt: number}>; stop(): Promise<void>; settled:Promise<void>;
} {
  const upstream = source.getReader();
  let queuedBytes = 0, queuedFrames = 0, pressured = false,cancelled=false, framesSinceYield=0;
  const snapshot = () => ({queued_bytes: queuedBytes, queued_frames: queuedFrames, stopped});
  readers.add(snapshot);
  let stopped = false, controller!: ReadableStreamDefaultController<VideoFrameEvent & {receivedAt: number}>;
  const acquisition=Promise.withResolvers<void>();let cancellation:Promise<void>|undefined;
  const settled=acquisition.promise.then(()=>cancellation);
  void settled.catch(error=>onError(error));
  const stop = () => {
    if (!stopped) {
      stopped = true;
      cancellation=upstream.cancel().catch(error=>{throw new Error('CALL_VIDEO_SOURCE_CANCEL_FAILED',{cause:error});});
      void cancellation.catch(()=>undefined);
    }
    return acquisition.promise;
  };
  const stream = new ReadableStream<VideoFrameEvent & {receivedAt: number}>({start(value) {
    controller = value;
    void (async () => {
      try {
        while (!stopped) {
          const next = await upstream.read();
          if (next.done) break;
          if (next.value.frame.data.byteLength > MAX_FRAME_BYTES) throw new Error('CALL_VIDEO_FRAME_BYTES_INVALID');
          const bytes = next.value.frame.data.byteLength;
          capture.received_frames++; capture.received_bytes += bytes;
          if(cancelled){capture.dropped_frames++;capture.dropped_bytes+=bytes;continue;}
          const event = {...next.value, receivedAt: now()};
          if (onFrame) try {onFrame(event);} catch (error) {onPressure(error);}
          if (queuedBytes + bytes > CALL_VIDEO_QUEUE_BYTES) {
            capture.dropped_frames++; capture.dropped_bytes += bytes;
            if (!pressured) {pressured = true; onPressure(new Error('CALL_VIDEO_BACKPRESSURE_FRAME_DROPPED'));}
          } else {
            queuedBytes += bytes; queuedFrames++;
            capture.peak_queued_bytes = Math.max(capture.peak_queued_bytes, queuedBytes);
            controller.enqueue(event);
          }
          // SDK backlog reads can all resolve in the same microtask turn, including rejected frames.
          // Give live audio, room events and timers a turn between bounded acquisition batches.
          if (++framesSinceYield === 64) {framesSinceYield=0;await yieldToCall();}
        }
      } catch (error) {onError(error);void stop();}
      finally {stopped=true;if(!cancelled)controller.close();upstream.releaseLock();
        // An empty closed queue has nothing left to read; a later cancel() never reaches the source, so release it here.
        if(queuedFrames===0)readers.delete(snapshot);acquisition.resolve();}
    })();
  },async cancel(){
    cancelled=true;await stop();
    capture.dropped_frames+=queuedFrames;capture.dropped_bytes+=queuedBytes;
    queuedBytes=0;queuedFrames=0;readers.delete(snapshot);
  }}, {highWaterMark: CALL_VIDEO_QUEUE_BYTES, size: event => event.frame.data.byteLength});
  const reader = stream.getReader(), read = reader.read.bind(reader);
  reader.read = (async () => {
    const next = await read();
    if (next.done) readers.delete(snapshot);
    else {queuedBytes -= next.value.frame.data.byteLength; queuedFrames--; if (queuedBytes <= CALL_VIDEO_QUEUE_BYTES / 2) pressured = false;}
    return next;
  }) as typeof reader.read;
  return {reader, stop, settled};
}

/** One pipe-only x264 process per short segment. No decoded frame is written to disk. */
export function createCallVideoEncoder(trackId: string, archive: (segment: CallCameraSegment) => Promise<void>, ffmpeg = 'ffmpeg', project?:(frame:VideoFrame)=>Promise<VideoFrame>): CallVideoEncoder {
  type Encoding = {
    child: ReturnType<typeof spawn>; ready: Promise<unknown[]>; completion: Promise<void>; output: Buffer[]; size: number;
    width: number; height: number; rotation: number; frames: CallCameraSegment['sourceFrames'];
    failure?: Error; finalized?: CallCameraSegment;
  };
  let transform:ReturnType<typeof createCameraTransforms>|undefined;
  let current: Encoding | undefined, inputFrameBytes = 0,discarding:Promise<void>|undefined;
  const snapshot = () => ({stdin_bytes: current?.child.stdin?.writableLength ?? 0, input_frame_bytes: inputFrameBytes,
    pid: current && current.child.exitCode === null && current.child.signalCode === null ? current.child.pid : undefined,
    encoded_bytes: current?.output.reduce((n, bytes) => n + bytes.length, 0) ?? 0,
    finalized_bytes: current?.finalized?.bytes.length ?? 0});
  const begin = (event: VideoFrameEvent): Encoding => {
    const {width, height} = event.frame;
    if (width < 2 || height < 2 || width > 4096 || height > 4096 || width % 2 || height % 2) throw new Error('CALL_VIDEO_DIMENSIONS_INVALID');
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'rawvideo',
      '-pixel_format', 'yuv420p', '-video_size', `${width}x${height}`, '-framerate', '30', '-i', 'pipe:0',
      '-an', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-filter_threads', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1',
      '-b:v', '2M', '-maxrate', '2M', '-bufsize', '2M', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1'], {stdio: ['pipe', 'pipe', 'pipe']});
    // Archive encoding is background work: lowest CPU priority, so live call audio, readiness and the model's view
    // always win a busy host; the bounded queue absorbs the difference; a full-priority encoder can starve them.
    if (child.pid !== undefined) setPriority(child.pid, 19);
    let stderr = '';
    const state: Encoding = {child, ready: once(child,'spawn'), completion: Promise.resolve(), output: [], size: 0, width, height, rotation: event.rotation, frames: []};
    const fail = (error: Error) => {state.failure ??= error; child.kill('SIGKILL');};
    child.stdout!.on('data', (bytes: Buffer) => {
      state.size += bytes.length;
      if (state.size > CALL_VIDEO_SEGMENT_BYTES) fail(new Error('CALL_VIDEO_SEGMENT_LIMIT'));
      else state.output.push(bytes);
    });
    child.stderr!.on('data', (bytes: Buffer) => {stderr = (stderr + bytes.toString()).slice(-4096);});
    child.stdin!.on('error', fail);
    state.completion = new Promise<void>((resolve, reject) => {
      child.on('error', fail);
      child.once('close', code => code === 0 && !state.failure ? resolve() : reject(state.failure ?? new Error(`CALL_VIDEO_ENCODER_EXIT:${code}:${stderr}`)));
    });
    // A process can fail before the caller reaches finish(). Keep rejection observed without disguising it as success.
    void state.completion.catch(() => undefined);
    return state;
  };
  const finish = async () => {
    const state = current;
    if (!state) return;
    if (!state.finalized) {
      const timeout = setTimeout(() => state.child.kill('SIGKILL'), IO_TIMEOUT_MS);
      try {state.child.stdin!.end(); await state.completion;} finally {clearTimeout(timeout);}
      if (!state.size) throw new Error('CALL_VIDEO_EMPTY_SEGMENT');
      state.finalized = {bytes: Buffer.concat(state.output, state.size), mime: 'video/h264', trackId,
        startedAt: state.frames[0]!.receivedAt, endedAt: state.frames.at(-1)!.receivedAt,
        width: 1280, height: 720, sourceWidth: state.width, sourceHeight: state.height, rotation: state.rotation,
        frameCount: state.frames.length, sourceFrames: state.frames};
      state.output = [];
    }
    // Retain this exact finalized segment on failure. A retry cannot change its bytes or metadata.
    await archive(state.finalized);
    current = undefined; encoders.delete(snapshot);
    await transform?.close();transform=undefined;
  };
  // Terminal cleanup acknowledges resource release only. It does not acknowledge original coverage.
  const discard=()=>discarding??=(async()=>{
    const state=current;current=undefined;inputFrameBytes=0;encoders.delete(snapshot);
    await transform?.close();transform=undefined;
    if(!state)return;
    if(state.child.exitCode===null&&state.child.signalCode===null)state.child.kill('SIGKILL');
    await Promise.allSettled([state.completion]);
    state.output=[];delete state.finalized;state.frames=[];state.size=0;
  })().finally(()=>{discarding=undefined;});
  return {finish,discard, async write(event, receivedAt) {
    inputFrameBytes = event.frame.data.byteLength;
    try {
    if (current && (current.finalized || current.width !== event.frame.width || current.height !== event.frame.height || current.rotation !== event.rotation)) await finish();
    const state = current ??= begin(event); encoders.add(snapshot);
    await state.ready;
    if (state.failure) throw state.failure;
    const frame = event.frame.type === VideoBufferType.I420 ? event.frame : await(project?project(event.frame):(transform??=createCameraTransforms()).project(event.frame).then(value=>value.frame));
    inputFrameBytes += frame === event.frame ? 0 : frame.data.byteLength;
    if (frame.data.length !== frame.width * frame.height * 3 / 2) throw new Error('CALL_VIDEO_I420_SIZE_INVALID');
    // Await pipe consumption. Only one decoded frame is retained by this writer.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {state.child.kill('SIGKILL'); reject(new Error('CALL_VIDEO_PIPE_TIMEOUT'));}, IO_TIMEOUT_MS);
      state.child.stdin!.write(frame.data, error => {clearTimeout(timeout); error ? reject(error) : resolve();});
    });
    state.frames.push({timestampUs: event.timestampUs.toString(), receivedAt});
    if (state.frames.length === SEGMENT_FRAMES) await finish();
    } finally {inputFrameBytes = 0;}
  }};
}
