import {DurableCaptureDetached} from '../../../services/personal-aios-integration/src/archive.ts';
import {SourceMediaAdmissionError} from './source-media-admission.ts';
import {SourceClockUnavailableError,sourceStorageUnavailable,type SealedSourceSpan} from './source-media-clock.ts';
import type {UnknownClockRaw,QuarantinedOriginal} from '../../../services/personal-aios-integration/src/unknown-clock.ts';
import { AudioStream, RoomEvent, TrackKind, TrackSource, type RemoteTrack } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { ReadableStream, type ReadableStreamDefaultReader, type ReadableStreamDefaultController } from 'node:stream/web';
import { canonical, check, digest, type ArchivedEvent, type RawEvent } from '../../../services/personal-aios-integration/src/contracts.ts';
import type { PersonalAIOSRuntime,MediaAppendResult } from '../../../services/personal-aios-integration/src/runtime.ts';
import type { TrackChunk } from '../../../services/personal-aios-integration/src/stream-archive.ts';
import type { ArchivedSourceClock, SourceSpanDeclaration } from './source-media-clock.ts';
import { mappedRange } from '../../../services/personal-aios-integration/src/media/align.ts';
import type { AudioRoute } from '../../../services/personal-aios-integration/src/media/audio-consumption.ts';
import type { MediaProcessRequest } from '../../../services/personal-aios-integration/src/media/service.ts';
import type { FormalSourceAuthority } from './personal-aios-formal-source.ts';
import type { LiveKitCloudParticipantPort } from './livekit-cloud-participant.ts';
import type { RealtimeBootstrapConnectedInput } from './realtime-public-control-runtime.ts';
// How long a voice press waits for the microphone track to be subscribed before it is refused.
const VOICE_SOURCE_WAIT_MS = 3000;

type PcmCaptureContext={credential:object;capture:Awaited<ReturnType<FormalSourceAuthority['capture']>>;revision:number};
export interface PcmFrame {
  source_context?:PcmCaptureContext;
  captured_at_ms?:number;received_at_ms?:number;
  data: Int16Array; sampleRate: number; channels: number; samplesPerChannel: number;
}
export interface PcmCaptureBudget {
  archive_batch?:{max_delay_ms:number;max_frames:number;max_bytes:number};
  /** Ambient capacity; voice windows and live calls reserve the same bounded capacity. */
  max_frame_samples: number; max_pending_frames: number; max_pending_bytes: number; max_samples: number;
}
/** `sample_offset`: where this 100 ms frame starts inside the archived chunk that carries it (absent = at its start). */
export interface PcmArchiveSnapshot {event: ArchivedEvent; chunk: TrackChunk;sample_offset?:number;processing_admission?:MediaAppendResult['processing_admission'];processing_receipt_ref?:string|null}
export const pcmEventId = (continuity: string, epoch: string) => `pcm:${digest([continuity,epoch])}`;
/** What a button window is for: a spoken request (the voice frontend consumes it) or an owner voiceprint sample (archived
 *  only; the enrollment reads it, so it can never become a request). */
export type VoiceWindowPurpose = 'request' | 'voiceprint';
/** One capture span on the reader's sample axis. A voice window is its own epoch, so its raw original,
 * clock basis and audio consumer route never mix with ambient capture. */
// `archived`: the next archive seq of a joined ambient lane (one archived chunk per contiguous batch run, not per frame).
type PcmCallTrack={call_id:string;track:'pre_call_ambient'|'microphone'};
type PcmLane = {epoch: string; eventId: string; samples: number; seq: number; archived?: number; voice?: string; purpose?: VoiceWindowPurpose;context?:number;reported?:{captured_at_ms:number;received_at_ms:number};processingGap?:boolean;admissionGap?:boolean;captureGap?:boolean};
type WakePcm={context?:PcmCaptureContext;ready:Promise<void>;release?:Promise<void>;closing:boolean;call:string;seq:number;samples:number;lastEnd?:number;controller:ReadableStreamDefaultController<PcmFrame>;stream:ReadableStream<PcmFrame>};
type ActivePcm = {track?: RemoteTrack;wire?:WakePcm; reader?: ReadableStreamDefaultReader<PcmFrame>;
  admitted?:Promise<void>; stopped: boolean; cancellation?: Promise<void>; done?: Promise<void>;
  lane?: PcmLane; baseEpoch?: string; continuity?: string; durable?: Map<string, PcmArchiveSnapshot>; unpublished?:Map<string,string>;settle?: () => Promise<void>;
  /** Lanes whose archived input was reported exhausted; endLane queues that report behind the lane's own appends. */
  groups?:Map<string,PcmCallTrack>;bound?:Set<string>;principal?:string;finished?: Map<string,Promise<void>>; endLane?: (eventId: string,endedBy:string) => void};
/** Sole acquisition consumer on the explicit central PCM path. No model/Agent work in this loop. */
export function createFormalPcmIngress(options: {
  participant: LiveKitCloudParticipantPort; runtime: PersonalAIOSRuntime; authority: FormalSourceAuthority;
  budget: PcmCaptureBudget; clock: ArchivedSourceClock; onError(error: unknown): void;
  span?: SourceSpanDeclaration;
  /** Consumer contract of the ambient lanes; voice windows always keep the voice consumer. */
  input_contract?: 'frame_v1'|'interval_v2';
  streamFactory?: (track: RemoteTrack) => ReadableStream<PcmFrame>;
  finishArchived?: (snapshot:PcmArchiveSnapshot,endedBy?:string) => Promise<void>;
  finishUnpublished?: (rawRef:string,endedBy:string) => Promise<void>;
  onCapture?(active:boolean):void;
  onSource?(source:Awaited<ReturnType<FormalSourceAuthority['authenticate']>>):void;
  onCapturePaused?(reason:string,principal_id:string):void|Promise<void>;
  publicationWaitSignal?:AbortSignal;
  /** Set by the MEDIA owner: the largest chunk its archive and continuous reader accept. With archive_batch it joins
   *  each contiguous ambient run of a batch into one archived chunk (same PCM bytes, same axes); absent, one per frame. */
  max_archive_chunk_bytes?:number;
  /** A wake attempt releases this source-owned archive only after directed owner speech. */
  captureDecision?():Promise<boolean>|undefined;
}) {
  const {archive_batch:batch,...captureBudget}=options.budget;
  if(batch)check(Object.values(batch).every(n=>Number.isSafeInteger(n)&&n>0)&&batch.max_delay_ms<=1000&&batch.max_frames<=Math.min(64,options.budget.max_pending_frames)&&batch.max_bytes<=options.budget.max_pending_bytes&&batch.max_bytes>=options.budget.max_frame_samples*2,'FORMAL_PCM_BATCH_BUDGET');
  check(Object.values(captureBudget).every(n=>Number.isSafeInteger(n) && n>0), 'FORMAL_PCM_BUDGET');
  check(options.budget.max_frame_samples * 2 <= options.budget.max_pending_bytes, 'FORMAL_PCM_BUDGET');
  check(options.max_archive_chunk_bytes===undefined||Number.isSafeInteger(options.max_archive_chunk_bytes)&&options.max_archive_chunk_bytes>0,'FORMAL_PCM_BUDGET');
  const joinBytes=batch&&options.max_archive_chunk_bytes!==undefined?Math.min(batch.max_bytes,options.max_archive_chunk_bytes):undefined;
  const ambientSamples=Math.min(options.budget.max_samples,5*60*16000);
  // 100 ms SDK frames are the live/tap unit. Without archive_batch each frame is one archived chunk; with it, see archiveUnits.
  const streamFactory = options.streamFactory ?? (track=>new AudioStream(track,{sampleRate:16000,numChannels:1,frameSizeMs:100}));
  const closeCapture=new AbortController(),retainedIngressKeys=new Set<string>();
  const publicationWaitSignal=options.publicationWaitSignal?AbortSignal.any([closeCapture.signal,options.publicationWaitSignal]):closeCapture.signal;
  const pending = new Set<Promise<unknown>>();
  const pendingAppends = new Set<Promise<unknown>>();
  const instance = randomUUID();
  let generation = 0, closed = false, frames = 0, queuedBytes = 0, voiceFrames=0,voiceBytes=0,tapBytes=0,tapFrames=0,droppedFrames=0,droppedSamples=0,tapDroppedFrames=0,processingFrames=0,processingSkippedFrames=0;
  let currentSourceRoute:string|undefined,callId:string|undefined;
  let setupRevision=0,registration:{binding:string;audio:boolean;room:unknown;transport:'rtp'|'wire'}|undefined;
  let credential: object | undefined, detach: (()=>void) | undefined;
  let active: ActivePcm | undefined,wakeInput:WakePcm|undefined,lastInput:RealtimeBootstrapConnectedInput|undefined;
  // Settled each time a reader attaches, before its first frame: a press waiting for its microphone opens there.
  let attached=Promise.withResolvers<void>();
  let latest: PcmArchiveSnapshot | undefined, latestQuarantine:QuarantinedOriginal|undefined, failure: unknown, archiveFailure:unknown, captureFailure:unknown, closing: Promise<void> | undefined;
  // Only unpublished consumer choices stay in memory; settled choices belong to AudioConsumption.
  const voiceEvents = new Map<string, VoiceWindowPurpose>();
  // Live-call consumers read every validated frame, archived or not; they never own the reader or the archive.
  const taps = new Set<(pcm: Int16Array,archive?:Promise<PcmArchiveSnapshot|undefined>) => void|Promise<void>>();
  const hear=(pcm:Int16Array,archive?:Promise<PcmArchiveSnapshot|undefined>)=>{
    if(tapFrames>=options.budget.max_pending_frames||tapBytes+pcm.byteLength>options.budget.max_pending_bytes){
      if(tapDroppedFrames++===0)options.onError(new Error('FORMAL_PCM_TAP_BACKPRESSURE'));return Promise.resolve();
    }
    const work:Promise<void>[]=[];
    for(const tap of taps)try{work.push(Promise.resolve(tap(pcm,archive)).catch(error=>options.onError(error)).catch(fail));}
      catch(error){options.onError(error);}
    if(!work.length)return Promise.resolve();
    tapBytes+=pcm.byteLength;tapFrames++;
    return Promise.all(work).finally(()=>{tapBytes-=pcm.byteLength;tapFrames--;});
  };
  let pausedReason:string|undefined,sourceDevice:string|undefined;
  const transition=(state:string,reason:string)=>console.info(JSON.stringify({formal_pcm_source:state,reason,device_id:sourceDevice,source_generation:generation}));
  const retainDetached=(error:unknown)=>{if(!(error instanceof DurableCaptureDetached))return false;
    error.ingress_keys.forEach(key=>retainedIngressKeys.add(key));transition('retained','durable_pending_source_closed');return true;};
  const cancelReader=(current:ActivePcm)=>{
    if(!current.cancellation){
      const work=(current.reader?.cancel()??Promise.resolve()).catch(error=>{
        const failure=new Error('FORMAL_PCM_SOURCE_STOP_FAILED',{cause:error});captureFailure??=failure;throw failure;
      });
      current.cancellation=work;pending.add(work);
      void work.then(()=>pending.delete(work),()=>pending.delete(work));
    }
    return current.cancellation;
  };
  const stop = async (reason='requested_stop',route?:string) => {
    if(route&&route!==currentSourceRoute)return;
    registration=undefined;
    transition('detached',reason);
    options.onCapture?.(false);
    generation++;
    detach?.(); detach = undefined;
    const current = active;
    if (current) {
      current.stopped = true;
      await cancelReader(current);
    }
  };
  const fail = (error: unknown) => {
    if (failure === undefined) {
      failure = error;
      try { options.onError(error); } catch { /* reporting must not bypass cancellation */ }
    }
    void stop('source_failure').catch(error=>{captureFailure??=error;options.onError(error);});
  };
  const reportArchive=(error:unknown)=>{
    let cause=error;
    while(cause instanceof Error){
      if(['ENOSPC','EDQUOT','EIO','EROFS','EACCES'].includes((cause as NodeJS.ErrnoException).code??'')){
        archiveFailure=error;options.onError(new Error('FORMAL_PCM_ARCHIVE_UNAVAILABLE',{cause:error}));return;
      }
      cause=cause.cause;
    }
    fail(error);
  };
  const close = () => closing ??= (async () => {
    closed = true;closeCapture.abort();
    const stopped = stop('source_closed');
    const settled = await Promise.allSettled([stopped, active?.done, ...pendingAppends, ...pending]);
    const rejected = settled.find(result=>result.status === 'rejected');
    if (failure !== undefined) throw failure;
    if (captureFailure !== undefined) throw captureFailure;
    if (archiveFailure !== undefined) throw archiveFailure;
    if (rejected?.status === 'rejected') throw rejected.reason;
  })();
  const setup = async (input: RealtimeBootstrapConnectedInput) => {
    check(!closed, 'FORMAL_PCM_CLOSED', 503);
    const wire=wakeInput;
    const revision=++setupRevision,nextCredential=options.authority.credentialForBootstrap(input);
    const capture=await options.authority.capture(nextCredential);
    const source=await options.authority.authenticate(nextCredential);
    if(closed||revision!==setupRevision)return;
    options.onSource?.(source);
    const binding=canonical(input.currentBinding),roomPort=options.participant.roomPort;
    if(wire?.context){
      check(active?.wire===wire&&!active.stopped,'WAKE_PCM_SOURCE_REQUIRED',409);
      const original=wire.context.capture;
      check(capture.binding.userId===original.binding.userId&&capture.binding.deviceId===original.binding.deviceId&&
        capture.binding.continuityId===original.binding.continuityId&&source.device_type===original.trusted.device_type,
        'WAKE_PCM_SOURCE_CHANGED',403);
      if(registration?.room!==roomPort){
        check(roomPort?.on&&roomPort.off&&roomPort.isConnected!==false,'FORMAL_PCM_ROOM_REQUIRED',503);
        detach?.();const disconnected=()=>{void stop('room_disconnected').catch(options.onError);};
        roomPort.on(RoomEvent.Disconnected,disconnected);detach=()=>roomPort.off!(RoomEvent.Disconnected,disconnected);
      }
      wire.context={credential:nextCredential,capture,revision};credential=nextCredential;currentSourceRoute=source.route_version;
      registration={binding,audio:input.enabledMedia.audio,room:roomPort,transport:'wire'};
      return;
    }
    if(registration?.binding===binding&&(wire||registration.audio===input.enabledMedia.audio)&&registration.room===roomPort&&registration.transport===(wire?'wire':'rtp')){
      if(failure!==undefined)throw failure;
      return;
    }
    sourceDevice=input.bearer.deviceId;
    transition('enabled_media',input.enabledMedia.audio?'audio_enabled':'audio_disabled');
    const previous=active,stopping = stop('bootstrap_replaced'), expected = generation;
    void stopping.catch(options.onError);
    if(wire)await stopping;await previous?.admitted;
    if (closed || generation !== expected) return;
    active = undefined; latest = undefined; latestQuarantine=undefined; failure = undefined; pausedReason=undefined;
    credential = nextCredential;currentSourceRoute=source.route_version;
    if (!input.enabledMedia.audio&&!wire) {registration={binding,audio:false,room:roomPort,transport:'rtp'};return;}
    const room = options.participant.roomPort;
    check(room?.on && room.off && room.remoteParticipants && room.isConnected !== false, 'FORMAL_PCM_ROOM_REQUIRED', 503);
    if (closed || generation !== expected) return;
    try{await options.runtime.existingArchive().prepareCapture();}
    catch(error){if(!sourceStorageUnavailable(error))throw error;
      pausedReason='capture_storage_unavailable';transition('paused',pausedReason);options.onError(error);
      await options.onCapturePaused?.(pausedReason,capture.trusted.principal_id);return;}
    if (closed || generation !== expected) return;
    options.onCapture?.(true);
    const captureCredential = credential;
    const initialContext:PcmCaptureContext={credential:captureCredential,capture,revision};
    if(wire)wire.context=initialContext;
    let span:SealedSourceSpan|undefined,spanUnavailable=false;
    if(options.span)try{span=await options.clock.sealSpan(capture.binding,options.span);}
    catch(error){if(!(error instanceof SourceClockUnavailableError))throw error;if(error.code==='MEDIA_CLOCK_BASIS_STORAGE_UNAVAILABLE')options.onError(error);spanUnavailable=true;}
    const spanEventId=options.span?`span:${digest([capture.binding,options.span.span_id])}`:undefined;
    if (closed || generation !== expected) return;
    const identity = input.currentBinding.credentialIdentity;
    check(typeof identity === 'string' && identity.length > 0, 'FORMAL_PCM_IDENTITY_REQUIRED');
    const failSource=(error:unknown)=>{if(generation===expected)fail(error);else options.onError(error);};
    let attachments = 0; // every reader attachment (first, after a reconnect, after a republish) is its own capture epoch
    let pausing: Promise<void> | undefined;
    const attachReader = (makeReader:()=>ReadableStreamDefaultReader<PcmFrame>,sourceId:string,track?:RemoteTrack) => {
      const admission=options.participant.admission;
        check(!active,'FORMAL_PCM_TRACK_ACTIVE',409);
        const reader=makeReader();
        const current:ActivePcm = {reader,stopped:false,...(track?{track}:{}),...(wire?{wire}:{})};
        const admitted=Promise.withResolvers<void>();current.admitted=admitted.promise;
        const ownsCurrent=()=>active===current&&generation===expected;
        const failCurrent=(error:unknown)=>{
          if(ownsCurrent())fail(error);
          else if(error!==failure&&error!==captureFailure){captureFailure??=error;options.onError(error);}
        };
        const archiveError=(error:unknown)=>{
          // Admission refused these bytes before archival and completed their route teardown.
          // The append still rejects; this is not a failed archive drain or reader teardown.
          if(error instanceof SourceMediaAdmissionError&&error.teardown==='requested'){options.onError(error);return;}
          if(ownsCurrent())reportArchive(error);else failCurrent(error);
        };
        active = current;transition('reader_attached','microphone_subscribed');
        const baseEpoch = digest([instance,expected,input.currentBinding.connectionEpoch,sourceId,attachments++]);
        current.baseEpoch = baseEpoch; current.continuity = capture.binding.continuityId; current.durable = new Map(); current.unpublished=new Map();current.finished = new Map();current.groups=new Map();current.bound=new Set();current.principal=capture.trusted.principal_id;
        current.lane = {epoch:baseEpoch,eventId:spanEventId ?? pcmEventId(capture.binding.continuityId,baseEpoch),samples:0,seq:0};
        if(callId)current.groups.set(current.lane.eventId,{call_id:callId,track:'microphone'});
        const wake=attached;attached=Promise.withResolvers();wake.resolve();
        let receivedFrames=0,receivedSamples=0,sourceDroppedFrames=0,sourceDroppedSamples=0,durableFrames=0,terminalFrames=0;
        let total = 0,savedThrough=0,quarantineSavedThrough=0; const publications=new Map<Promise<unknown>,Set<string>>();
        let archiveDecision:Promise<boolean>|undefined;
        let tail = Promise.resolve(), publicationTail:Promise<unknown> = Promise.resolve();
        const finishing=new Set<Promise<void>>();
        type PendingFrame={raw:RawEvent;device:Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>;chunk:TrackChunk;settle:(snapshot?:PcmArchiveSnapshot)=>void;reject:(error:unknown)=>void;admitted:()=>void;ordinal:number;lane:PcmLane;gapBefore:boolean};
        let buffered:PendingFrame[]=[],bufferedBytes=0,batchTail=Promise.resolve(),batchTimer:ReturnType<typeof setTimeout>|undefined;
        const save=(archived:MediaAppendResult,sealedChunk:TrackChunk,ordinal:number,lane:PcmLane)=>{
          // A durable rejection proves these samples never entered detection. The next admission
          // declares that gap; an unknown receipt or a detector fault must remain an explicit failure.
          if(archived.processing_receipt_ref&&archived.processing_admission?.status==='failed'&&['CONTINUOUS_CHUNK_BACKLOG','CONTINUOUS_STREAM_BACKLOG','CONTINUOUS_CONTROL_BACKLOG']
            .includes(archived.processing_admission.error_code??''))lane.admissionGap=true;
          if(active===current)archiveFailure=undefined;const snapshot:PcmArchiveSnapshot={event:archived.event,chunk:structuredClone(sealedChunk),...(archived.processing_admission?{processing_admission:archived.processing_admission,processing_receipt_ref:archived.processing_receipt_ref??null}:{})};
          if(active===current&&ordinal>=savedThrough){latest=snapshot;savedThrough=ordinal;}
          const previous=current.durable!.get(archived.event.event_id);
          if(!previous||sealedChunk.seq>=previous.chunk.seq)current.durable!.set(archived.event.event_id,snapshot);
          return structuredClone(snapshot);
        };
        const processing=(count:number,onDurable:()=>void,lane:PcmLane,gapBefore:boolean)=>{
          const consume=processingFrames+count<=options.budget.max_pending_frames;
          if(consume)processingFrames+=count;
          else {lane.processingGap=true;if(!processingSkippedFrames)options.onError(new Error('FORMAL_PCM_PROCESSING_BACKLOG'));processingSkippedFrames+=count;}
          const resetConsume=consume&&(!!lane.processingGap||gapBefore);if(consume)lane.processingGap=false;
          return {onDurable:()=>{durableFrames+=count;onDurable();},beforeConsume:publicationTail,consume,
            ...(lane.purpose?{audioPurpose:lane.purpose}:{}),
            // Runtime reads this after beforeConsume: earlier publication may still report a rejection.
            get resetConsume(){const reset=resetConsume||!!lane.admissionGap;if(consume)lane.admissionGap=false;return reset;}};
        };
        const trackPublication=(work:Promise<unknown>,consume:boolean,count:number,eventIds:string[])=>{
          publications.set(work,new Set(eventIds));if(consume)publicationTail=work;
          void work.finally(()=>{publications.delete(work);terminalFrames+=count;if(consume)processingFrames-=count;}).catch(failCurrent);
        };
        current.settle=async()=>{if(batch)await flush();await tail;if(batch)await flush();await Promise.all([...publications.keys()]);};
        // Order exhaustion after durable appends, but never wait for model work before archiving the next lane.
        current.endLane=(eventId,endedBy)=>{tail=tail.then(async()=>{if(batch)await flush();
          const work=Promise.all([...publications].filter(([,ids])=>ids.has(eventId)).map(([work])=>work)).then(()=>finishLane(current,eventId,endedBy));finishing.add(work);void work.finally(()=>finishing.delete(work)).catch(failCurrent);
        }).catch(failCurrent);};
        // One archived chunk per contiguous ambient run: 100 ms SDK frames stay the live/tap unit, but each archived chunk
        // costs an object, a journal delta and its claims, so a batch must not archive five of them for 500 ms of audio.
        // Voice windows keep their own per-frame chunks. Bytes are concatenated unchanged; the axes are the frames' union.
        const archiveUnits=(group:PendingFrame[])=>{
          const runs:PendingFrame[][]=[];
          for(const frame of group){
            const run=runs.at(-1),last=run?.at(-1),a=last?.chunk.source_range,b=frame.chunk.source_range;
            const joins=joinBytes!==undefined&&run&&last&&!frame.lane.voice&&last.lane===frame.lane&&last.raw.event_id===frame.raw.event_id&&
              a?.kind==='interval'&&b.kind==='interval'&&a.timebase_id===b.timebase_id&&a.end_ms===b.start_ms&&frame.chunk.seq===last.chunk.seq+1&&
              last.chunk.clock_basis_ref===frame.chunk.clock_basis_ref&&run.reduce((n,x)=>n+x.raw.payload.length,0)+frame.raw.payload.length<=joinBytes;
            if(joins)run!.push(frame);else runs.push([frame]);
          }
          return runs.map(run=>{
            const first=run[0]!,last=run.at(-1)!;
            if(joinBytes===undefined||first.lane.voice)return {raw:first.raw,device:first.device,chunk:first.chunk,frames:[{frame:first,offset:0}]};
            const seq=first.lane.archived??0;first.lane.archived=seq+1;let offset=0;
            const frames=run.map(frame=>{const at=offset;offset+=frame.raw.payload.length/2;return {frame,offset:at};});
            const from=first.raw.time_range,to=last.raw.time_range;
            const time_range=from?.kind==='interval'&&to?.kind==='interval'&&from.timebase_id===to.timebase_id?{...from,end_ms:to.end_ms}:from;
            const range=first.chunk.source_range;check(range.kind==='interval'&&last.chunk.source_range.kind==='interval','FORMAL_PCM_FRAME_INVALID',422);
            return {raw:{...first.raw,...(time_range?{time_range}:{}),payload:run.length===1?first.raw.payload:Buffer.concat(run.map(x=>x.raw.payload))},device:first.device,
              chunk:{...first.chunk,seq,source_range:{...range,end_ms:last.chunk.source_range.end_ms}},frames};
          });
        };
        const flush=()=>{
          if(batchTimer){clearTimeout(batchTimer);batchTimer=undefined;}
          const group=buffered;buffered=[];bufferedBytes=0;if(!group.length)return batchTail;
          const acknowledged=Promise.withResolvers<void>();
          const lifecycle=processing(group.length,()=>{group.forEach(x=>x.admitted());acknowledged.resolve();},group[0]!.lane,group[0]!.gapBefore);
          const work=batchTail.then(async()=>{
            const units=archiveUnits(group);
            for(const unit of units)await bindCall(current,unit.raw.event_id,`l5:${digest({event_id:unit.raw.event_id,principal_id:unit.device.principal_id,device_id:unit.raw.device_id})}`);
            const archived=await options.runtime.appendMediaBatch(units.map(x=>({raw:x.raw,device:x.device,chunk:x.chunk})),{max_chunks:batch!.max_frames,max_bytes:batch!.max_bytes},publicationWaitSignal,lifecycle);
            for(let n=0;n<archived.length;n++){const unit=units[n]!,snapshot=save(archived[n]!,unit.chunk,unit.frames.at(-1)!.frame.ordinal,unit.frames[0]!.frame.lane);
              for(const {frame,offset} of unit.frames)frame.settle(offset?{...structuredClone(snapshot),sample_offset:offset}:structuredClone(snapshot));}
          }).catch(error=>{group.forEach(x=>x.admitted());if(retainDetached(error)){for(const {raw,device} of group)current.unpublished!.set(raw.event_id,`l5:${digest({event_id:raw.event_id,principal_id:device.principal_id,device_id:raw.device_id})}`);group.forEach(x=>x.settle());return;}group.forEach(x=>x.reject(error));archiveError(error);});
          void work.finally(()=>acknowledged.resolve()).catch(failCurrent);trackPublication(work,lifecycle.consume,group.length,group.map(x=>x.raw.event_id));batchTail=acknowledged.promise;return batchTail;
        };

        current.done = (async () => {
          try {
            while (!current.stopped && !closed) {
              const next = await reader.read();
              if (next.done || current.stopped || closed || admission?.admitted === false) break;
              const frame = next.value;receivedFrames++;
              const context=wire?(frame.source_context??initialContext):initialContext;
              if(wire&&current.lane!.context!==context.revision){
                if(current.lane!.samples>0)switchLane(current,'ambient',`capture:${context.revision}`);
                current.lane!.context=context.revision;
              }
              check(frame.data instanceof Int16Array && frame.sampleRate === 16000 && frame.channels === 1 &&
                Number.isSafeInteger(frame.samplesPerChannel) && frame.samplesPerChannel === frame.data.length &&
                frame.samplesPerChannel > 0 && frame.samplesPerChannel <= (wire?1600:options.budget.max_frame_samples),
                'FORMAL_PCM_FRAME_INVALID', 422);
              receivedSamples+=frame.samplesPerChannel;
              const bytes=frame.samplesPerChannel*2;
              const callFrame=!!callId&&!wire,voiceFrame=!!current.lane!.voice||callFrame;
              if(callFrame&&(voiceFrames>=options.budget.max_pending_frames||voiceBytes+bytes>options.budget.max_pending_bytes)){
                await tail;if(batch)await flush();
              }
              const full=!wire&&!callFrame&&((voiceFrame?voiceFrames:frames)>=options.budget.max_pending_frames||(voiceFrame?voiceBytes:queuedBytes)+bytes>options.budget.max_pending_bytes);
              // max_samples bounds one archived event; a long capture rolls to a fresh ambient lane.
              if (current.lane!.samples + frame.samplesPerChannel > ambientSamples && !current.lane!.voice)
                switchLane(current, 'ambient', `rollover:${total}`);
              check(current.lane!.samples + frame.samplesPerChannel <= options.budget.max_samples, 'FORMAL_PCM_SAMPLE_BUDGET', 413);
              const lane = current.lane!, eventId = lane.eventId, samples = lane.samples;
              if(wire)lane.context=context.revision;
              if(wire&&!lane.reported)lane.reported={captured_at_ms:frame.captured_at_ms!,received_at_ms:frame.received_at_ms!};
              const sourceStart=wire?frame.captured_at_ms!-lane.reported!.captured_at_ms:samples/16;
              if(full){
                lane.captureGap=true;sourceDroppedFrames++;sourceDroppedSamples+=frame.samplesPerChannel;droppedFrames++;droppedSamples+=frame.samplesPerChannel;lane.samples+=frame.samplesPerChannel;total+=frame.samplesPerChannel;
                if(!archiveFailure){archiveFailure=new Error('FORMAL_PCM_APPEND_BACKLOG');options.onError(archiveFailure);
                  const notice=options.runtime.archiveAlert('FORMAL_PCM_APPEND_BACKLOG',capture.trusted.principal_id).catch(options.onError);
                  pending.add(notice);void notice.finally(()=>pending.delete(notice));}
                // Archive backlog drops only the archived copy; live calls still hear every frame (no archive reference).
                void hear(frame.data);
                continue;
              }
              const gapBefore=!!lane.captureGap;lane.captureGap=false;
              let payload = Buffer.alloc(bytes);
              for (let n=0;n<frame.data.length;n++) payload.writeInt16LE(frame.data[n]!,n*2);
              const chunk: TrackChunk = {track_id:'microphone',stream_epoch:lane.epoch,seq:lane.seq++,modality:'audio',
                format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:`received-pcm:${lane.epoch}`,
                  stream_epoch:lane.epoch,start_ms:sourceStart,end_ms:sourceStart+frame.samplesPerChannel/16}};
              lane.samples += frame.samplesPerChannel; total += frame.samplesPerChannel;
              const ordinal=total;
              frames++; queuedBytes += bytes;if(voiceFrame){voiceFrames++;voiceBytes+=bytes;}
              const completion=Promise.withResolvers<PcmArchiveSnapshot|undefined>();
              const heard=hear(frame.data,completion.promise);
              const acknowledged=Promise.withResolvers<void>();let released=false,sourceRaw:RawEvent|undefined;
              const admitted=()=>{if(released)return;released=true;
                payload.fill(0);payload=Buffer.alloc(0);if(sourceRaw)sourceRaw.payload=new Uint8Array();
                frames--;queuedBytes-=bytes;if(wire)wire.samples-=frame.samplesPerChannel;if(voiceFrame){voiceFrames--;voiceBytes-=bytes;}acknowledged.resolve();};
              // Operation failures are reported by their capture/archive owner; this set owns draining.
              const retained=Promise.allSettled([completion.promise,heard]);
              pendingAppends.add(retained);void retained.then(()=>pendingAppends.delete(retained),()=>pendingAppends.delete(retained));
              const decision=archiveDecision??=options.captureDecision?.();
              const preparedInput=(async()=>{
                if(decision&&!await decision)return;
                let source:Awaited<ReturnType<PersonalAIOSRuntime['authenticate']>>,binding:Awaited<ReturnType<FormalSourceAuthority['capture']>>['binding'];
                try {source=await options.runtime.authenticate(context.credential);({binding}=await options.authority.capture(context.credential));}
                catch(error){
                  // Like formal control, a rejected source retires its room. The terminal then uses its existing
                  // cleanup + fresh bootstrap flow; neither expired continuity nor a revoked grant is extended here.
                  if(ownsCurrent()){
                    failCurrent(error);
                    const teardown=options.participant.disconnect();pending.add(teardown);
                    void teardown.then(()=>pending.delete(teardown),error=>{pending.delete(teardown);captureFailure??=error;options.onError(error);});
                  }
                  throw error;
                }
                let sealedChunk:TrackChunk,timing:Pick<SealedSourceSpan,'metadata'|'capture_timing'>;
                try {
                  if(spanUnavailable)throw new SourceClockUnavailableError('MEDIA_SPAN_CLOCK_UNAVAILABLE');
                  sealedChunk=span?await options.clock.captureTrack(binding,chunk,span):chunk;
                  timing=span??await options.clock.capture(binding,chunk,lane.reported);
                } catch(error) {
                  if(!(error instanceof SourceClockUnavailableError))throw error;
                  if(error.code==='MEDIA_CLOCK_BASIS_STORAGE_UNAVAILABLE')options.onError(error);
                  const isolated:UnknownClockRaw={schema_version:'paios.event.v1',event_id:eventId,
                    device_id:source.device_id,device_type:source.device_type,captured_at:null,capture_clock_status:'unknown',
                    source:{channel:source.channel,...(source.relay_device_id?{relay_device_id:source.relay_device_id}:{})},
                    media_type:options.span?'livekit_tracks':'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload};
                  return {source,isolated};
                }
                const raw:RawEvent={schema_version:'paios.event.v1',event_id:eventId,device_id:source.device_id,
                  device_type:source.device_type,...timing.metadata,source:{channel:source.channel,capture_timing:timing.capture_timing,
                    ...(source.relay_device_id?{relay_device_id:source.relay_device_id}:{})},media_type:span?.media_type??'audio',
                  mime:'audio/pcm',representation:'received_decoded_sample',payload};
                return {source,raw,sealedChunk};
              })();
              // Receipt owns these frames. Stopping the reader cannot discard their unfinished archive preparation.
              void preparedInput.catch(error=>{admitted();completion.reject(error);failCurrent(error);});
              const work=tail.then(async()=>{
                const ready=await preparedInput;if(!ready){admitted();completion.resolve(undefined);return;}
                const {source}=ready;
                if(ready.isolated){const isolated=ready.isolated;
                  const publishing=(async()=>{try{await bindCall(current,eventId,`l5:${digest({event_id:isolated.event_id,principal_id:source.principal_id,device_id:isolated.device_id})}`);const archived=await options.runtime.quarantineMedia(isolated,source,chunk,publicationWaitSignal,()=>{durableFrames++;isolated.payload=new Uint8Array();admitted();});
                    if(active===current&&ordinal>=quarantineSavedThrough){latestQuarantine=archived;quarantineSavedThrough=ordinal;}if(active===current)archiveFailure=undefined;completion.resolve(undefined);}
                    catch(error){if(retainDetached(error))completion.resolve(undefined);else{completion.reject(error);archiveError(error);}}finally{admitted();}})();
                  trackPublication(publishing,false,1,[eventId]);await acknowledged.promise;return;}
                const {raw,sealedChunk}=ready;sourceRaw=raw;
                if(batch){
                  if(buffered.length&&(gapBefore||buffered[0]!.raw.event_id!==raw.event_id||buffered.length>=batch.max_frames||bufferedBytes+payload.length>batch.max_bytes))void flush();
                  buffered.push({raw,device:source,chunk:sealedChunk,settle:snapshot=>completion.resolve(snapshot),reject:error=>completion.reject(error),admitted,ordinal,lane,gapBefore});bufferedBytes+=payload.length;
                  if(buffered.length>=batch.max_frames||bufferedBytes>=batch.max_bytes)void flush();
                  else batchTimer??=setTimeout(()=>{void flush();},batch.max_delay_ms);
                }else{const lifecycle=processing(1,admitted,lane,gapBefore);
                  const publishing=(async()=>{try{await bindCall(current,eventId,`l5:${digest({event_id:raw.event_id,principal_id:source.principal_id,device_id:raw.device_id})}`);completion.resolve(save(await options.runtime.appendMedia(raw,source,sealedChunk,publicationWaitSignal,lifecycle),sealedChunk,ordinal,lane));}
                  catch(error){if(retainDetached(error)){current.unpublished!.set(raw.event_id,`l5:${digest({event_id:raw.event_id,principal_id:source.principal_id,device_id:raw.device_id})}`);completion.resolve(undefined);}else{completion.reject(error);archiveError(error);}}finally{admitted();}})();
                  trackPublication(publishing,lifecycle.consume,1,[eventId]);await acknowledged.promise;}
              });
              tail = work.catch(error=>{admitted();completion.reject(error);failCurrent(error);});
              if(callFrame&&(voiceFrames>=options.budget.max_pending_frames||voiceBytes+options.budget.max_frame_samples*2>options.budget.max_pending_bytes)){
                await acknowledged.promise;
              }
            }
            // The refresh fence ends at durable ingress, before publication and model completion.
            if(batch)await flush();await tail;if(batch)await flush();await batchTail;admitted.resolve();
            await current.settle!();
            // Input exhaustion is separate from an acoustic pause; join after the append fence is released. Every
            // archived lane this reader owns ends here unless a lane switch already ended it.
            for (const eventId of new Set([...current.durable!.keys(),...current.unpublished!.keys()])) await finishLane(current, eventId);
          } catch (error) {failCurrent(error);} finally {
            if(batch)await flush();
            admitted.resolve();
            await Promise.allSettled([...finishing]);
            console.info(JSON.stringify({formal_pcm_source:'capture_closed',device_id:capture.trusted.device_id,track_id:sourceId,
              connection_epoch:capture.binding.connectionEpoch,source_generation:expected,base_epoch:baseEpoch,
              received_decoded_frames:receivedFrames,validated_received_samples:receivedSamples,dropped_frames:sourceDroppedFrames,
              dropped_samples:sourceDroppedSamples,durable_admitted_frames:durableFrames,publication_terminal_frames:terminalFrames}));
            transition('reader_detached',current.stopped?'source_stopped':'track_exhausted');
            reader.releaseLock();
            delete current.reader;
          }
        })();
        pending.add(current.done);void current.done.finally(()=>pending.delete(current.done!));
    };
    const subscribed=(...args:readonly unknown[])=>{
      const [track,publication,participant]=args as [RemoteTrack,{kind:TrackKind;source:TrackSource;sid?:string},{identity:string}];
      if(wire||closed||generation!==expected||participant?.identity!==identity||publication?.kind!==TrackKind.KIND_AUDIO||
        publication.source!==TrackSource.SOURCE_MICROPHONE||options.participant.admission?.admitted===false)return;
      if(pausing){void pausing.then(()=>subscribed(...args)).catch(failSource);return;}
      if(active?.track===track)return;
      try{attachReader(()=>streamFactory(track).getReader(),publication.sid??'microphone',track);}catch(error){failSource(error);}
    };
    const disconnected = () => {void stop('room_disconnected').catch(failSource);};
    // Transient interruptions (SDK reconnect, track republish) pause the reader but keep this registration, so the
    // reconnected room's track or the next subscription attaches a fresh reader. Only Disconnected stops for good.
    const pause = (): Promise<void> => {
      const current = active;
      if (!current) return pausing ?? Promise.resolve();
      return pausing ??= (async () => {
        current.stopped = true;
        await cancelReader(current); await current.done;
        if (active === current) active = undefined;
      })().finally(() => {pausing = undefined;});
    };
    const participants = room.remoteParticipants;
    const rescan = () => {
      for (const participant of participants.values())
        for (const publication of participant.trackPublications.values())
          if (publication.track) subscribed(publication.track,publication,participant);
    };
    const reconnecting = () => {if(wire)return;transition('reader_detaching','room_reconnecting_or_track_unsubscribed');void pause().catch(failSource);};
    const reconnected = () => {
      if(wire)return;
      const admission = options.participant.admission;
      void Promise.all([pause(),admission?.promise]).then(() => {
        if (!closed && generation === expected && admission?.admitted !== false) rescan();
      }).catch(failSource);
    };
    const unsubscribed = (...args: readonly unknown[]) => {
      if (args[0] === active?.track && (args[2] as {identity?:string}|undefined)?.identity === identity) reconnecting();
    };
    const listeners: [string,(...args:readonly unknown[])=>void][] = [
      [RoomEvent.TrackSubscribed,subscribed],[RoomEvent.TrackUnsubscribed,unsubscribed],
      [RoomEvent.Reconnecting,reconnecting],[RoomEvent.Reconnected,reconnected],[RoomEvent.Disconnected,disconnected],
    ];
    for (const [event,listener] of listeners) room.on(event,listener);
    detach = () => {for (const [event,listener] of listeners) room.off!(event,listener);};
    registration={binding,audio:input.enabledMedia.audio,room:roomPort,transport:wire?'wire':'rtp'};
    if(wire){if(!wire.closing)attachReader(()=>wire.stream.getReader(),`wake:${wire.call}`);}else rescan();
  };
  const bindCall=async(current:ActivePcm,eventId:string,rawRef:string)=>{
    const group=current.groups?.get(eventId);if(group&&!current.bound?.has(eventId)){await options.runtime.existingArchive().bindCallTrack(rawRef,{...group,principal_id:current.principal!});current.bound?.add(eventId);}
  };
  // Reports one archived span's input exhausted (once), so its continuous detection, detector slot and source handle end.
  const finishLane=async(current:ActivePcm,eventId:string,endedBy='source_exhausted')=>{
    const snapshot=current.durable?.get(eventId);
    const rawRef=current.unpublished?.get(eventId);
    let work=current.finished!.get(eventId);
    if(!work&&(snapshot||rawRef)){work=(async()=>{await bindCall(current,eventId,snapshot?.event.raw_ref??rawRef!);
      if(snapshot)await options.finishArchived?.(snapshot,endedBy);else await options.finishUnpublished?.(rawRef!,endedBy);})();
      current.finished!.set(eventId,work);}
    await work;
    // Pending publication owns the purpose until the consumer authority has durably selected it.
    if(voiceEvents.has(eventId)&&(!snapshot&&!rawRef||snapshot&&await options.runtime.archivedAudioRoute(snapshot.event)))voiceEvents.delete(eventId);
  };
  const switchLane=(current:ActivePcm,kind:'voice'|'ambient',operation:string,purpose:VoiceWindowPurpose='request',endedBy='bounded_rollover')=>{
    const ended=current.lane, epoch=digest([current.baseEpoch,kind,operation]);
    current.lane={epoch,eventId:pcmEventId(current.continuity!,epoch),samples:0,seq:0,...(kind==='voice'?{voice:operation,purpose}:{})};
    if(callId)current.groups?.set(current.lane.eventId,{call_id:callId,track:'microphone'});
    // A lane switch ends its prior capture, including committed or cancelled voice windows.
    if(ended){
      if(ended.voice&&ended.samples===0)voiceEvents.delete(ended.eventId);
      current.endLane?.(ended.eventId,endedBy);
    }
    return current.lane;
  };
  // Button windows cut the one reader's sample axis into capture spans. No second consumer, no Stop.
  const voice={
    // A press can land while the just-enabled microphone track is still being subscribed (every press outside a call
    // publishes it anew): wait briefly for its lane, and take it the moment the reader attaches, so no first syllable
    // is filed as ambient.
    open:async(operation:string,purpose:VoiceWindowPurpose='request')=>{
      for(let waited=0;!(active?.lane&&!active.stopped)&&!closed&&waited<VOICE_SOURCE_WAIT_MS;)
        waited+=await Promise.race([attached.promise.then(()=>0),new Promise<number>(resolve=>setTimeout(resolve,100,100))]);
      const current=active;
      check(current?.lane&&!current.stopped&&!closed,'FORMAL_PCM_VOICE_SOURCE_REQUIRED',409);
      check(!options.span,'FORMAL_PCM_VOICE_SPAN_UNSUPPORTED',409);
      check(!current.lane.voice,'FORMAL_PCM_VOICE_WINDOW_ACTIVE',409);
      check(voiceEvents.size<4096,'FORMAL_PCM_VOICE_WINDOW_BUDGET',429);
      voiceEvents.set(switchLane(current,'voice',operation,purpose).eventId,purpose);
    },
    // The window's event_id is the voice D's event_id; the device needs it to follow the turn's result.
    commit:async(operation:string,purpose:VoiceWindowPurpose='request'):Promise<{event_id:string;request:MediaProcessRequest}>=>{
      const current=active;
      check(current?.lane?.voice===operation&&current.lane.purpose===purpose&&credential,'FORMAL_PCM_VOICE_WINDOW_REQUIRED',409);
      const window=current.lane;switchLane(current,'ambient',operation,purpose,'voice_commit');
      await current.settle?.();
      const snapshot=current.durable?.get(window.eventId);
      check(snapshot&&window.samples>0,'FORMAL_PCM_VOICE_WINDOW_EMPTY',409);
      const {binding}=await options.authority.capture(credential);
      const maps=(await options.clock.archivedReceiptClockMaps(snapshot.event.principal_id,snapshot.event,binding))
        .filter(map=>map.modality==='audio'&&map.stream_epoch===window.epoch);
      check(maps.length===1,'FORMAL_PCM_VOICE_CLOCK_REQUIRED',409);
      await finishLane(current,window.eventId,'voice_commit');
      return {event_id:snapshot.event.event_id,request:{raw_ref:snapshot.event.raw_ref,archive_revision:snapshot.event.archive_revision,clock_maps:maps,
        time_range:mappedRange({kind:'interval',timebase_id:`received-pcm:${window.epoch}`,stream_epoch:window.epoch,
          start_ms:0,end_ms:window.samples/16},maps[0]!)}};
    },
    cancel:(operation:string)=>{
      const current=active;
      if(current?.lane?.voice!==operation)return false;
      switchLane(current,'ambient',operation,current.lane.purpose,'voice_cancel');return true;
    },
  };
  // The reader that carves lanes names each lane's consumer: a voice window goes to the voice frontend (a voiceprint
  // sample is archived only), an ambient lane to MEDIA on the configured contract (frame_v1 keeps the runtime's default).
  const route=async(event:ArchivedEvent):Promise<AudioRoute|undefined>=>{
    const scope={source_scope:event.device_id,capture_span:event.raw_ref,purpose_evidence_ref:event.consent_ref};
    const purpose=voiceEvents.get(event.event_id);
    if(purpose)return {consumer:purpose==='voiceprint'?'audit_only':'voice',...scope};
    const saved=await options.runtime.archivedAudioRoute(event);
    if(saved)return saved;
    return options.input_contract==='interval_v2'?{consumer:'media',input_contract:'interval_v2',...scope}:undefined;
  };
  const finishSession=async(endedBy='call_hangup',nextCallId?:string)=>{
    callId=nextCallId;
    const current=active;if(!current?.lane||current.lane.voice)return;
    const ended=current.lane;if(nextCallId)current.groups?.set(ended.eventId,{call_id:nextCallId,track:'pre_call_ambient'});
    switchLane(current,'ambient',randomUUID(),'request',endedBy);
    await current.settle?.();await finishLane(current,ended.eventId,endedBy);
  };
  const wake={
    open:(call:string):Promise<void>=>{
      check(!closed&&lastInput,'WAKE_PCM_SOURCE_REQUIRED',409);
      if(wakeInput?.closing)return wakeInput.release!.then(()=>wake.open(call));
      if(wakeInput){
        check(wakeInput.call===call,'WAKE_PCM_CALL_ACTIVE',409);
        if(wakeInput.context)check(active?.wire===wakeInput&&!active.stopped,'WAKE_PCM_SOURCE_REQUIRED',409);
        return wakeInput.ready;
      }
      check(!options.span,'FORMAL_PCM_VOICE_SPAN_UNSUPPORTED',409);
      let controller!:ReadableStreamDefaultController<PcmFrame>;
      const stream=new ReadableStream<PcmFrame>({start:value=>{controller=value;}});
      const selected:WakePcm={call,seq:0,samples:0,controller,stream,closing:false,ready:Promise.resolve()};wakeInput=selected;callId=call;
      selected.ready=setup(lastInput).then(()=>{
        check(!selected.closing,'WAKE_PCM_CALL_CLOSED',409);
        check(active?.wire===selected&&!active.stopped,'WAKE_PCM_SOURCE_REQUIRED',409);
      });
      return selected.ready;
    },
    append:async(call:string,frame:{seq:number;captured_at_ms:number;sample_rate:16000;pcm_s16le_base64:string})=>{
      const wire=wakeInput;check(wire?.call===call&&!wire.closing&&!closed&&
        !(active?.wire===wire&&active.stopped),'WAKE_PCM_CALL_REQUIRED',409);
      check(Number.isSafeInteger(frame.seq)&&frame.seq===wire.seq,'WAKE_PCM_SEQUENCE_INVALID',409);
      check(frame.sample_rate===16000&&Number.isFinite(frame.captured_at_ms)&&typeof frame.pcm_s16le_base64==='string'&&frame.pcm_s16le_base64.length<=4268&&
        /^[A-Za-z0-9+/]+={0,2}$/u.test(frame.pcm_s16le_base64),'WAKE_PCM_FRAME_INVALID',422);
      const bytes=Buffer.from(frame.pcm_s16le_base64,'base64'),samples=bytes.length/2;
      check(Number.isInteger(samples)&&samples>0&&samples<=1600&&bytes.toString('base64')===frame.pcm_s16le_base64,'WAKE_PCM_FRAME_INVALID',422);
      check(Number.isFinite(new Date(frame.captured_at_ms).getTime())&&
        (wire.lastEnd===undefined||frame.captured_at_ms>=wire.lastEnd-1),'WAKE_PCM_CAPTURE_TIME_INVALID',422);
      check(wire.samples*2+bytes.length<=options.budget.max_pending_bytes,'WAKE_PCM_BACKPRESSURE',429);
      const data=new Int16Array(samples);for(let n=0;n<samples;n++)data[n]=bytes.readInt16LE(n*2);
      wire.controller.enqueue({data,sampleRate:16000,channels:1,samplesPerChannel:samples,captured_at_ms:frame.captured_at_ms,received_at_ms:Date.now(),...(wire.context?{source_context:wire.context}:{})});
      wire.samples+=samples;wire.seq++;wire.lastEnd=frame.captured_at_ms+samples/16;
      await wire.ready;if(failure!==undefined)throw failure;
      check(active?.wire===wire&&!active.stopped,'WAKE_PCM_CALL_REQUIRED',409);
    },
    close:(call:string):Promise<void>=>{
      const wire=wakeInput;if(!wire||wire.call!==call)return Promise.resolve();
      if(wire.release)return wire.release;wire.closing=true;
      return wire.release=(async()=>{
        const [ready]=await Promise.allSettled([wire.ready]);
        const current=active?.wire===wire?active:undefined;
        if(current&&!current.stopped)wire.controller.close();
        // Release at the durable ingress fence. Existing pending owners retain publication/model completion.
        await current?.admitted;
        if(active===current)active=undefined;if(wakeInput===wire)wakeInput=undefined;
        if(failure!==undefined)throw failure;
        if(ready.status==='rejected'&&ready.reason?.code!=='WAKE_PCM_CALL_CLOSED')throw ready.reason;
        if(!closed&&lastInput&&!wakeInput)await setup(lastInput);
      })();
    },
  };
  return {voice,wake,route,finishSession,capturing:()=>!!active&&!active.stopped,tap:(listener:(pcm:Int16Array,archive?:Promise<PcmArchiveSnapshot|undefined>)=>void|Promise<void>)=>{taps.add(listener);return()=>{taps.delete(listener);};},onBootstrapConnected:(input:RealtimeBootstrapConnectedInput)=>{
      lastInput=input;
      const work=setup(input).catch(error=>{throw error instanceof Error&&/^[A-Z][A-Z0-9_]*$/.test(error.message)?error:new Error('FORMAL_PCM_SOURCE_SETUP_FAILED',{cause:error});});pending.add(work);
      void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
    },stop,close,
    drain:async()=>{await Promise.allSettled([active?.done,...pendingAppends]);},
    source:async()=>{check(credential,'FORMAL_PCM_SOURCE_NOT_CONNECTED',503);return options.runtime.authenticate(credential);},
    capture:async()=>{check(credential,'FORMAL_PCM_SOURCE_NOT_CONNECTED',503);return options.authority.capture(credential);},
    snapshot:()=>({voice_active:!!active?.lane?.voice&&!active.stopped&&!closed,pending_frames:frames,pending_bytes:queuedBytes,tap_pending_bytes:tapBytes,tap_pending_frames:tapFrames,max_pending_bytes:options.budget.max_pending_bytes,max_pending_frames:options.budget.max_pending_frames,dropped_frames:droppedFrames,dropped_samples:droppedSamples,tap_dropped_frames:tapDroppedFrames,processing_pending_frames:processingFrames,processing_skipped_frames:processingSkippedFrames,error:failure,archive_error:archiveFailure,paused_reason:pausedReason,pending_raw_keys:[...retainedIngressKeys],
      latest:latest ? structuredClone(latest) : undefined,
      latest_quarantine:latestQuarantine?structuredClone(latestQuarantine):undefined})};
}
