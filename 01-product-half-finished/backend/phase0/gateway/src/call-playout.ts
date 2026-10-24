import {emitRuntimeEvent} from '../../../services/personal-aios-integration/src/self-events.ts';
import {AudioFrame,AudioSource,LocalAudioTrack,TrackPublishOptions,TrackSource} from '@livekit/rtc-node';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
export type PublishingRoom={localParticipant?:{publishTrack?(track:LocalAudioTrack,options:TrackPublishOptions):Promise<{sid?:string;waitForSubscription():Promise<void>}>;
  unpublishTrack?(sid:string,stopOnUnpublish?:boolean):Promise<void>}};
export const CALL_PCM_LIMITS=Object.freeze({max_samples:30*24000,pause_samples:16*24000,resume_samples:8*24000,no_progress_ms:15000});
/** 40 ms at 24 kHz: how a skipped clip that already started ends. */
export const SKIP_FADE_SAMPLES=960;
export type CallPcmReservation={release(samples:number,progress?:boolean):void};
/** One per-call admission and progress authority, shared by held speech and both output routes. Video uses the same
 * limits: the renderer's in-flight PCM is bounded by its real-time pacing (about its render delay), not by this cap. */
export class CallPcmBudget {
  private samples=0;private generation=0;private paused=false;private timer:ReturnType<typeof setTimeout>|undefined;
  private stall:(error:Error)=>void=()=>{};private waits=new Set<{resolve():void;reject(error:Error):void}>();
  private pressure:(paused:boolean)=>void;private readonly limits=CALL_PCM_LIMITS;
  constructor(pressure:(paused:boolean)=>void=()=>{}){this.pressure=pressure;}
  reserve(samples:number):CallPcmReservation {
    check(this.samples+samples<=this.limits.max_samples,'VOICE_CALL_PCM_CAPACITY',429);
    this.samples+=samples;this.updatePressure();this.arm();
    const generation=this.generation;let retained=samples;
    return {release:(count,progress=true)=>{if(generation!==this.generation)return;check(count<=retained,'VOICE_CALL_PCM_CREDIT');
      retained-=count;this.samples-=count;this.updatePressure();if(progress||!this.samples&&!this.waits.size)this.progress();}};
  }
  watch(stall:(error:Error)=>void){this.stall=stall;this.arm();}
  progress(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.arm();}
  async wait(work:Promise<void>){
    const done=Promise.withResolvers<void>();this.waits.add(done);this.arm();
    try{await Promise.race([work,done.promise]);}finally{this.waits.delete(done);if(!this.samples&&!this.waits.size){clearTimeout(this.timer);this.timer=undefined;}}
  }
  reset(){this.generation++;this.samples=0;if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    for(const done of this.waits)done.resolve();this.waits.clear();this.updatePressure();}
  refreshPressure(){this.pressure(this.paused);}
  private updatePressure(){const paused=this.paused?this.samples>this.limits.resume_samples:this.samples>=this.limits.pause_samples;
    if(paused!==this.paused){this.paused=paused;this.pressure(paused);}}
  private arm(){if(this.timer||!this.samples&&!this.waits.size)return;
    this.timer=setTimeout(()=>{this.timer=undefined;const error=new Error('VOICE_CALL_PCM_STALLED');
      for(const done of this.waits)done.reject(error);this.waits.clear();this.stall(error);},this.limits.no_progress_ms);this.timer.unref();}
}
export interface CallPlayout {open():Promise<void>;push(pcm:Int16Array,reservation?:CallPcmReservation,skippable?:boolean):void;interrupt(preserveBudget?:boolean):void;drain():Promise<void>;close():Promise<void>;thinkingAtCommit?:boolean;setCallAvatar?(enabled:boolean,revision?:number):Promise<void>;
  rebindRoom?(room:PublishingRoom):Promise<void>;
  /** 24 kHz output position since interrupt; Vidu is a labeled estimate, never a playback acknowledgement. */
  playedSamples?():number;
  /** Ends the latest skippable push (the thinking sound) on the same track; returns the samples it will never play. */
  skip?():number}
/** Owns the call's output. An interrupted track is retired, never reused: the phone mutes its SID to discard its jitter
 * buffer. Its replacement is published during the user's speech; audio waits for the SDK's first subscription. */
export function createCallPlayout(room:PublishingRoom,id:string,reset:(sid:string)=>void,onError:(error:unknown)=>void,budget=new CallPcmBudget(),onPlayed?:(pcm:Int16Array)=>void):CallPlayout {
  check(room.localParticipant?.publishTrack&&room.localParticipant.unpublishTrack,'VOICE_CALL_ROOM_REQUIRED',503);
  type Output={source:AudioSource;track:LocalAudioTrack;sid?:string;stopped:boolean;started:boolean;audio:boolean;stop:ReturnType<typeof Promise.withResolvers<void>>;
    room:PublishingRoom;captured:number;played:number;ready:Promise<void>;queue:Promise<void>;closing?:Promise<void>};
  let current:Output|undefined,closed=false,epoch=0,position=0,clip:{skip:boolean;length:number;unsent:number}|undefined;
  const retiring=new Set<Promise<void>>();
  const observe=(out:Output)=>{void out.queue.catch(error=>{
    if(!out.stopped){void retire(out);budget.reset();onError(new Error('VOICE_CALL_PLAYOUT_FAILED',{cause:error}));}
  });};
  const retire=(out:Output):Promise<void>=>{
    if(out.closing)return out.closing;
    if(current===out)current=undefined;
    out.stopped=true;out.stop.resolve();out.source.clearQueue();if(out.sid)reset(out.sid);
    const work=(async()=>{
      if(out.sid)await out.room.localParticipant!.unpublishTrack!(out.sid,true).catch(onError);
      await out.track.close(true).catch(onError);await out.source.close().catch(onError);
    })();
    out.closing=work;retiring.add(work);void work.finally(()=>retiring.delete(work));return work;
  };
  const acquire=()=>{
    check(!closed,'VOICE_CALL_PLAYOUT_CLOSED',409);
    if(current){budget.watch(error=>{void retire(current!);budget.reset();onError(error);});return current;}
    const source=new AudioSource(24000,1,100),track=LocalAudioTrack.createAudioTrack(`paios-call-${id}-${epoch++}`,source);
    const out:Output={source,track,room,stopped:false,started:false,audio:false,captured:0,played:0,stop:Promise.withResolvers<void>(),ready:Promise.resolve(),queue:Promise.resolve()};current=out;
    budget.watch(error=>{void retire(out);budget.reset();onError(error);});
    let subscribed:Promise<void>=Promise.resolve();
    const publish=new TrackPublishOptions();publish.source=TrackSource.SOURCE_MICROPHONE;
    out.ready=room.localParticipant!.publishTrack!(track,publish).then(result=>{
      const sid=result.sid??track.sid;if(sid)out.sid=sid;
      if(out.stopped&&out.sid){reset(out.sid);return out.room.localParticipant!.unpublishTrack!(out.sid,true).catch(onError);}
      check(typeof result.waitForSubscription==='function','VOICE_CALL_SUBSCRIPTION_REQUIRED',502);
      subscribed=Promise.race([result.waitForSubscription(),out.stop.promise]);
    });
    out.queue=Promise.race([out.ready.then(()=>subscribed),out.stop.promise]);observe(out);return out;
  };
  const playedSamples=()=>{const out=current;if(!out)return position;
    // rtc-node reports milliseconds on a monotonic clock. A room change preserves the turn's output position.
    return position+(out.played=Math.max(out.played,Math.floor(out.captured-out.source.queuedDuration*24)));};
  return {open:()=>acquire().ready,
    rebindRoom:async next=>{position=playedSamples();const out=current;current=undefined;room=next;
      if(out)void retire(out);if(!closed)await acquire().ready;},
    push:(pcm,reservation,skippable=false)=>{
      if(closed)return;
      const credit=reservation??budget.reserve(pcm.length),out=acquire(),segment=skippable?{skip:false,length:pcm.length,unsent:pcm.length}:undefined;
      if(segment)clip=segment;
      out.audio=true;let remaining=pcm.length;out.queue=out.queue.then(async()=>{
        let end=pcm.length,fadeFrom=end;
        for(let offset=0;offset<end&&!out.stopped;offset+=480){
          if(segment?.skip&&fadeFrom===pcm.length){
            // A skipped clip that already started fades out; one that never started is dropped whole.
            fadeFrom=offset;end=segment.unsent<segment.length?Math.min(pcm.length,offset+SKIP_FADE_SAMPLES):offset;if(offset>=end)break;}
          const frame=pcm.slice(offset,Math.min(end,offset+480));
          if(end<pcm.length)for(let i=0;i<frame.length;i++)frame[i]=Math.round(frame[i]!*(end-offset-i)/(end-fadeFrom));
          if(segment)segment.unsent-=frame.length;
          // The SDK queues duration synchronously, before its native capture callback completes.
          const capture=out.source.captureFrame(new AudioFrame(frame,24000,1,frame.length));out.captured+=frame.length;
          await Promise.race([capture,out.stop.promise]);
          if(out.stopped)return;if(onPlayed)try{onPlayed(frame);}catch(error){onError(error);}credit.release(frame.length);remaining-=frame.length;
          if(!out.started&&!out.stopped){out.started=true;
            emitRuntimeEvent({voice_call_stage:'first_playout_frame',call:id.slice(-8),track_sid:out.sid,at:Date.now()});}
        }
      }).finally(()=>{if(remaining)credit.release(remaining,false);if(clip===segment)clip=undefined;});observe(out);
    },
    skip:()=>{const s=clip;clip=undefined;if(!s||s.skip)return 0;s.skip=true;
      return s.unsent<s.length?Math.max(0,s.unsent-SKIP_FADE_SAMPLES):s.unsent;},
    interrupt:preserveBudget=>{if(closed)return;clip=undefined;if(!preserveBudget)budget.reset();position=0;const out=current;current=undefined;if(out)void retire(out);acquire();},playedSamples,
    drain:async()=>{const out=current;if(out?.audio)await budget.wait(out.queue.then(async()=>{if(!out.stopped)await out.source.waitForPlayout();}));},
    close:async()=>{closed=true;clip=undefined;budget.reset();const out=current;current=undefined;if(out)await retire(out);await Promise.all(retiring);}};
}
