import { RoomEvent, TrackKind, TrackSource, VideoStream, type RemoteTrack, type VideoFrame, type VideoFrameEvent } from '@livekit/rtc-node';
import type { ReadableStream, ReadableStreamDefaultReader } from 'node:stream/web';
import {createCameraTransforms,type CameraProjection} from './call-camera-transform.ts';
import {SourceMediaAdmissionError} from './source-media-admission.ts';
import {SourceMediaPermissionError} from './source-media-permission.ts';
export {lumaGrid,encodeCameraFrame} from './call-camera-transform.ts';
import { canonical, check, ContractError } from '../../../services/personal-aios-integration/src/contracts.ts';
import type { LiveKitCloudParticipantPort } from './livekit-cloud-participant.ts';
import { boundedCameraReader, createCallVideoEncoder, type CallVideoEncoder, type CallVideoEncoderFactory, type CallCameraSegment } from './call-video-encoder.ts';
export type { CallCameraSegment, CallVideoEncoder, CallVideoEncoderFactory } from './call-video-encoder.ts';
import type { RealtimeBootstrapConnectedInput } from './realtime-public-control-runtime.ts';

/** Call-only camera consumer. The paired phone publishes its camera only during a video call; a bounded latest-frame preview
 * checks luma changes off the event loop, and the live call's realtime front receives JPEG frames at an adaptive rate: 1 fps at
 * rest, 5 fps for a few seconds after visible change or when the user asks her to look, and one fresh frame as soon as
 * the user starts speaking. Every received frame enters a bounded H.264 segment encoder independently of model sampling. */
export type CameraAttention = 'speech' | 'look';
const REST_INTERVAL_MS = 1000, BURST_INTERVAL_MS = 200, BURST_MS = 6000;
// Change = at least ~2% of the block-averaged luma grid moved beyond sensor noise.
const CELL_DELTA = 18, MOTION_CELLS = 12;

export const changedCells = (a: Uint8Array, b: Uint8Array) => {
  let changed = 0;
  for (let n = 0; n < a.length; n++) if (Math.abs(a[n]! - b[n]!) > CELL_DELTA) changed++;
  return changed;
};

export function createCallCamera(options: {
  participant: LiveKitCloudParticipantPort;
  /** Optional JPEG projection for the live model; recording remains independent of this sink. */
  sink(): ((jpegBase64: string) => void) | undefined;
  archive?(segment: CallCameraSegment): Promise<void>;
  createArchive?(input:RealtimeBootstrapConnectedInput): (segment:CallCameraSegment)=>Promise<void>;
  encoderFactory?: CallVideoEncoderFactory;
  onError(error: unknown): void;
  onActiveChange?(active: boolean): void;
  streamFactory?: (track: RemoteTrack) => ReadableStream<VideoFrameEvent>;
  project?: (frame:VideoFrame)=>Promise<CameraProjection>;
  encode?: (frame: VideoFrame, rotation: number) => Promise<string | undefined>;
  now?: () => number;
}) {
  const streamFactory = options.streamFactory ?? (track => new VideoStream(track) as unknown as ReadableStream<VideoFrameEvent>);
  const now = options.now ?? Date.now;
  type Active = {track: RemoteTrack; reader: ReadableStreamDefaultReader<VideoFrameEvent & {receivedAt: number}>; stop(): Promise<void>; settled:Promise<void>; done?: Promise<void>; preview?: Promise<void>;failure?:unknown;recordingFailure?:unknown;transformSnapshot:ReturnType<typeof createCameraTransforms>['snapshot'];generation:number};
  const drain = async (recorder: CallVideoEncoder, current: Active) => {
    await recorder.finish();
    while (true) {const next = await current.reader.read(); if (next.done) break; await recorder.write(next.value, next.value.receivedAt);}
    await recorder.finish();
  };
  let archiveFailed = false;
  let registration:{binding:string;room:unknown;video:boolean}|undefined;
  let active: Active | undefined, target: RemoteTrack | undefined, detach: (() => void) | undefined, closed = false, generation = 0;
  let cameraActive = false, forceAt = -Infinity, burstUntil = -Infinity;
  const setActive = (value: boolean) => {
    if (cameraActive === value) return;
    cameraActive = value; options.onActiveChange?.(value);
  };
  const pending = new Set<Promise<unknown>>(),retiring=new Set<Promise<void>>();
  const stopActive = async (deactivate = true, join = true) => {
    const current = active; active = undefined;
    if (deactivate) setActive(false);
    if (current) {
      const done=current.done!;retiring.add(done);
      void done.then(()=>retiring.delete(done),()=>retiring.delete(done));
      try{await current.stop();}catch(error){throw new Error('CALL_CAMERA_SOURCE_STOP_FAILED',{cause:error});}
      if(join)await done;
    }
  };
  const consume = (track: RemoteTrack, archive:typeof options.archive) => {
    const admission = options.participant.admission;
    if (archive) check(track.sid, 'CALL_VIDEO_TRACK_ID_REQUIRED');
    const transforms=createCameraTransforms(),project=options.project??transforms.project,encode=options.encode??transforms.encode;
    let current:Active;
    const available=()=>!closed&&active===current&&admission?.admitted!==false;
    let previous: Uint8Array | undefined, lastSent = -Infinity, latest:(VideoFrameEvent & {receivedAt:number})|undefined, previewBusy=false;
    // Acquisition stays independent of recording. The preview retains only its active frame and the latest arrival.
    const live = (event: VideoFrameEvent & {receivedAt: number}) => {
      if (!available()) return;
      if (!options.sink()) {previous = undefined; return;}
      latest=event;if(previewBusy)return;previewBusy=true;
      const work=(async()=>{while(latest){
        const event=latest;latest=undefined;
        if(!available())break;
        const {frame,grid}=await project(event.frame),t=event.receivedAt;
        if(!available())break;
        if(previous&&changedCells(previous,grid)>=MOTION_CELLS)burstUntil=t+BURST_MS;
        previous=grid;
        if(!(forceAt>lastSent)&&t<lastSent+(t<burstUntil?BURST_INTERVAL_MS:REST_INTERVAL_MS))continue;
        lastSent=t;
        const base64=await encode(frame,event.rotation);
        if(base64&&available())options.sink()?.(base64);
      }})().catch(error=>options.onError(error)).finally(()=>{previewBusy=false;latest=undefined;});
      current.preview=work;pending.add(work);void work.finally(()=>pending.delete(work));
    };
    // Queue saturation only counts dropped frames and alerts once per episode; recording and the model's frames continue.
    current = {track,transformSnapshot:transforms.snapshot,generation, ...boundedCameraReader(streamFactory(track), error=>{current.failure??=error;}, now, options.onError, live)};
    let recorder = archive ? (options.encoderFactory ?? ((trackId,archive,project)=>createCallVideoEncoder(trackId,archive,undefined,project)))(track.sid!, archive,async frame=>(await project(frame)).frame) : undefined;
    active = current;
    setActive(true);
    let reported=false;
    const reportFailure=(error:unknown)=>{
      if(reported)return;reported=true;
      if(active===current)archiveFailed=true;
      const reason=error instanceof ContractError?error.code:error instanceof Error&&/^[A-Z][A-Z0-9_]*$/u.test(error.message.split(':')[0]!)?error.message.split(':')[0]:'CALL_CAMERA_CAPTURE_FAILED';
      console.warn(JSON.stringify({call_camera_capture:current.recordingFailure!==undefined?'recording_incomplete':'released',track_id:track.sid,reason}));
      options.onError(error);
    };
    const stopRecording=async(error:unknown)=>{
      current.recordingFailure??=error;const previous=recorder;recorder=undefined;
      reportFailure(current.recordingFailure);
      try{await previous?.discard?.();}catch(cleanup){options.onError(cleanup);}
    };
    current.done = (async () => {
      try {
        while (true) {
          const next = await current.reader.read();
          if(current.failure!==undefined)throw current.failure;
          if(current.recordingFailure!==undefined&&recorder)await stopRecording(current.recordingFailure);
          if (next.done) break;
          if (admission?.admitted === false) {await current.stop(); break;}
          if(recorder)try{await recorder.write(next.value,next.value.receivedAt);}
          catch(error){
            // Source revocation still ends acquisition. Storage/encoding failure only ends recording.
            if(error instanceof SourceMediaAdmissionError||error instanceof SourceMediaPermissionError||error instanceof ContractError&&[401,403,409,410].includes(error.status))throw error;
            await stopRecording(error);
          }
        }
        if(recorder)await drain(recorder,current);
      } catch (error) {
        current.failure??=error;
        await current.stop();
        await recorder?.discard?.();
        await current.reader.cancel();
        reportFailure(current.failure);
      } finally {
        // A replacement cannot retain another decoded preview while this encoder still owns its input.
        await current.preview;
        await transforms.close();
        current.reader.releaseLock();
        try{await current.settled;}catch(error){current.failure??=error;}
        if(current.failure!==undefined)reportFailure(current.failure);
        if (active === current) {active = undefined; setActive(false);}
      }
    })();
    pending.add(current.done);void current.done.then(()=>pending.delete(current.done!),error=>{pending.delete(current.done!);options.onError(error);});
  };
  const setup = async (input: RealtimeBootstrapConnectedInput) => {
    check(!closed,'CALL_CAMERA_CLOSED',503);
    const binding=canonical(input.currentBinding),roomPort=options.participant.roomPort;
    if(!archiveFailed&&registration?.binding===binding&&registration.room===roomPort&&registration.video===input.enabledMedia.video)return;
    registration=undefined;
    const expected = ++generation;
    detach?.(); detach = undefined;
    await stopActive(true,false);
    archiveFailed = false;
    check(!closed,'CALL_CAMERA_CLOSED',503);
    if (expected !== generation) return;
    if (!input.enabledMedia.video) {registration={binding,room:roomPort,video:false};return;}
    const room = options.participant.roomPort;
    check(room?.on && room.off && room.remoteParticipants, 'CALL_CAMERA_ROOM_REQUIRED', 503);
    const identity = input.currentBinding.credentialIdentity;
    check(typeof identity === 'string' && identity.length > 0, 'CALL_CAMERA_IDENTITY_REQUIRED');
    const archive=options.createArchive?.(input)??options.archive;
    const subscribed = (...args: readonly unknown[]) => {
      const [track, publication, participant] = args as [RemoteTrack, {kind?: TrackKind; source?: TrackSource; muted?: boolean}, {identity?: string}];
      if (closed || archiveFailed || expected !== generation || participant?.identity !== identity || active?.track === track ||
          publication?.kind !== TrackKind.KIND_VIDEO || publication.source !== TrackSource.SOURCE_CAMERA || publication.muted) return;
      const admission = options.participant.admission;
      if (admission?.admitted === false) return;
      target = track;
      // Replacing the reader does not turn off the published camera or the avatar.
      const stopped=stopActive(false);
      return Promise.all([stopped,...retiring]).then(() => {if (!closed && expected === generation && target === track && !active && !publication.muted && admission?.admitted !== false) consume(track,archive);})
        .catch(error => {if (target === track) {target = undefined; setActive(false);} options.onError(error);});
    };
    const stopped = () => {registration=undefined;target = undefined; void stopActive().catch(options.onError);};
    const retired = (...args: readonly unknown[]) => {
      const publication = args[0] as {kind?: TrackKind; source?: TrackSource; track?: RemoteTrack};
      if ((args[1] as {identity?: string})?.identity === identity && publication.kind === TrackKind.KIND_VIDEO &&
          publication.source === TrackSource.SOURCE_CAMERA && publication.track && publication.track === target) stopped();
    };
    const unsubscribed = (...args: readonly unknown[]) => {if (args[0] === target) stopped();};
    const unmuted = (...args: readonly unknown[]) => {
      const publication = args[0] as {track?: RemoteTrack};
      if (publication.track) subscribed(publication.track, publication, args[1]);
    };
    const participants = room.remoteParticipants;
    const rescan = () => {
      const attached:Promise<void>[]=[];
      for (const participant of participants.values())
        for (const publication of participant.trackPublications.values())
          if (publication.track) {const work=subscribed(publication.track, publication, participant);if(work)attached.push(work);}
      return Promise.all(attached);
    };
    // After an SDK reconnect the existing camera track may come back without a new TrackSubscribed: look again.
    const reconnected = () => {
      const admission = options.participant.admission;
      void Promise.all([stopActive(),admission?.promise]).then(() => {
        if (!closed && expected === generation && admission?.admitted !== false) return rescan();
      }).catch(options.onError);
    };
    const listeners: [string, (...args: readonly unknown[]) => void][] = [
      [RoomEvent.TrackSubscribed, subscribed], [RoomEvent.TrackUnsubscribed, unsubscribed],
      [RoomEvent.TrackMuted, retired], [RoomEvent.TrackUnpublished, retired], [RoomEvent.TrackUnmuted, unmuted],
      [RoomEvent.Reconnecting, stopped], [RoomEvent.Reconnected, reconnected], [RoomEvent.Disconnected, stopped],
    ];
    for (const [event, listener] of listeners) room.on(event, listener);
    detach = () => {for (const [event, listener] of listeners) room.off!(event, listener);};
    await rescan();
    if(!closed&&expected===generation)registration={binding,room:roomPort,video:true};
  };
  return {
    active: () => cameraActive,
    snapshot:()=>active?{track_id:active.track.sid,generation:active.generation,transform:active.transformSnapshot(),recording_failed:active.recordingFailure!==undefined}:null,
    pauseRecording:(error:unknown)=>{archiveFailed=true;if(active)active.recordingFailure??=error;},
    pause: (error:unknown) => {
      archiveFailed=true;
      if(active)active.failure??=error;
      return stopActive(true,false);
    },
    onBootstrapConnected: (input: RealtimeBootstrapConnectedInput) => {
      const work = setup(input).catch(error=>{throw error instanceof Error&&/^[A-Z][A-Z0-9_]*$/.test(error.message)?error:new Error('CALL_CAMERA_SOURCE_SETUP_FAILED',{cause:error});}); pending.add(work); void work.finally(() => pending.delete(work)).catch(() => undefined); return work;
    },
    /** speech: send the current view with the user's next words; look: also see at 5 fps for a few seconds. */
    focus: (reason: CameraAttention) => {
      const t = now(); forceAt = t;
      if (reason === 'look') burstUntil = t + BURST_MS;
    },
    close: async () => {
      closed = true; generation++;
      detach?.(); detach = undefined;
      const stopped=stopActive();
      const settled=await Promise.allSettled([stopped,...pending]);
      const rejected=settled.find(result=>result.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;
    },
  };
}
