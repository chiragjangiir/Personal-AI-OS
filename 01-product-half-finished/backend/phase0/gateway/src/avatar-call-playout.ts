import {emitRuntimeEvent} from '../../../services/personal-aios-integration/src/self-events.ts';
import {createCallPlayout,CallPcmBudget,CALL_PCM_LIMITS,type CallPcmReservation,type CallPlayout,type PublishingRoom} from './call-playout.ts';
import type {LiveKitCloudParticipantPort} from './livekit-cloud-participant.ts';
import type {LiveKitCloudTokenSignerPort} from './livekit-cloud-token-signer.ts';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';

/** PCM goes directly to the avatar renderer, never through a second room subscription. Only its synchronized output is audible.
 * Retain unacknowledged samples so a failed worker can hand playback back to the existing voice track. */
export function createAvatarCallPlayout(options:{room:PublishingRoom;id:string;enabled:boolean;origin:string;token:string;
  participant:LiveKitCloudParticipantPort;signer:LiveKitCloudTokenSignerPort;reset:(sid:string)=>void;onError:(error:unknown)=>void;
  onPlayed?:(pcm:Int16Array)=>void;fetch?:typeof fetch;socket?:(url:string)=>WebSocket;voice?:CallPlayout;budget?:CallPcmBudget;log?:(record:Record<string,unknown>)=>void}):CallPlayout&{setVideo(enabled:boolean):void} {
  const budget=options.budget??new CallPcmBudget();
  const voice=options.voice??createCallPlayout(options.room,options.id,options.reset,options.onError,budget,options.onPlayed);
  const fetcher=options.fetch??fetch;
  let socket:WebSocket|undefined,active=false,closed=false,epoch=0,sent=0,played=0,lastSeen=0,sid:string|undefined;
  let pending:{pcm:Int16Array;credit:CallPcmReservation}[]=[],opening:Promise<void>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
  let video=options.enabled,started=false,generation=0,playedOffset=0;
  const drains=new Set<()=>void>();
  const settle=()=>{for(const done of drains)done();drains.clear();};
  const log=(stage:string,fields:Record<string,unknown>={})=>{
    const record={avatar_call_stage:stage,call:options.id.slice(-8),epoch,at:Date.now(),...fields};
    if(options.log)options.log(record);else emitRuntimeEvent(record);
  };
  const fallback=(reason:string,code?:number)=>{
    if(!closed)log('fallback',{reason,...(code===undefined?{}:{code})});
    opening=undefined;
    if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;
    const wasActive=active;if(wasActive)playedOffset+=played;active=false;socket?.close();socket=undefined;
    if(sid){options.reset(sid);sid=undefined;}
    const replay=pending;pending=[];sent=played=0;settle();
    if(wasActive&&!closed){budget.progress();for(const {pcm,credit} of replay)voice.push(pcm,credit);}
  };
  const control=(type:string)=>socket?.send(JSON.stringify({type,epoch}));
  const stalled=(error:Error)=>{if(!pending.length&&!drains.size)options.onError(error);else fallback('playout_stalled');};
  const open=()=>{
    if(closed||active)return Promise.resolve();
    started=true;return opening??=(async()=>{
    const expected=generation;
    if(!video){await voice.open();return;}
    let failureReason='open_failed',failureCode:number|undefined;
    log('open');
    try{
      failureReason='health_failed';
      const health=await fetcher(`${options.origin}/health`,{signal:AbortSignal.timeout(1500)});
      if(closed||expected!==generation)return;
      check(health.ok&&(await health.json() as {ready?:boolean}).ready,'AVATAR_UNAVAILABLE',503);
      failureReason='room_unavailable';
      const snapshot=options.participant.snapshot();
      check(snapshot.connected&&snapshot.roomName&&snapshot.projectUrl&&options.participant.withEncryptionKey,'AVATAR_ROOM_REQUIRED',503);
      failureReason='token_failed';
      const token=await options.signer.sign({room:snapshot.roomName,identity:'yimi-avatar',ttlSeconds:60,
        grants:{room:snapshot.roomName,roomJoin:true,canPublish:true,canSubscribe:false,canPublishData:false,canPublishSources:['microphone','camera']}});
      if(closed||expected!==generation)return;
      failureReason='transport_failed';
      const ws=socket=(options.socket??(url=>new WebSocket(url)))(`${options.origin.replace('https:','wss:')}/call`);
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{failureReason='connect_timeout';reject(new Error('AVATAR_CONNECT_TIMEOUT'));},15000);
        const finish=(error?:unknown)=>{clearTimeout(timer);error?reject(error):resolve();};
        ws.onopen=()=>{void options.participant.withEncryptionKey!(async key=>{
          if(socket===ws&&!closed)ws.send(JSON.stringify({authorization:`Bearer ${options.token}`,url:snapshot.projectUrl,token,key:Buffer.from(key).toString('base64'),pcm_budget:CALL_PCM_LIMITS}));
        }).catch(finish);};
        ws.onerror=()=>{failureReason='transport_failed';finish(new Error('AVATAR_TRANSPORT_FAILED'));if(socket===ws&&active)fallback(failureReason);};
        ws.onclose=event=>{failureReason=event?.code===1011&&event.reason==='avatar_task_failed'?'worker_task_failed':'transport_closed';
          failureCode=event?.code;finish(new Error('AVATAR_DISCONNECTED'));
          if(socket===ws&&active)fallback(failureReason,failureCode);};
        ws.onmessage=event=>{
          if(socket!==ws||closed)return;
          try{
            const message=JSON.parse(String(event.data));lastSeen=Date.now();
            if(message.type==='ready'){sid=message.sid;clearTimeout(timer);
              // Finish the raw voice already queued before changing publishers mid-reply.
              void voice.drain().then(()=>{if(socket===ws&&!closed){playedOffset+=voice.playedSamples?.()??0;voice.interrupt(true);active=true;budget.watch(stalled);log('ready');
                if(epoch){options.reset(sid!);control('interrupt');}}finish();}).catch(finish);}
            else if(message.type==='reset'){
              if(message.epoch!==epoch)options.reset(message.sid);
              else{if(sid)options.reset(sid);sid=message.sid;}}
            else if(message.type==='played'&&message.epoch===epoch){
              check(Number.isSafeInteger(message.samples)&&message.samples>=played&&message.samples<=sent,'AVATAR_ACK_INVALID');
              let count=message.samples-played;played=message.samples;
              while(count&&pending.length){const head=pending[0]!,take=Math.min(count,head.pcm.length);if(options.onPlayed)try{options.onPlayed(head.pcm.slice(0,take));}catch(error){options.onError(error);}head.credit.release(take);count-=take;
                if(take===head.pcm.length)pending.shift();else head.pcm=head.pcm.slice(take);}
            }else if(message.type==='drained'&&message.epoch===epoch)settle();
          }catch(error){failureReason='protocol_invalid';options.onError(error);if(active)fallback(failureReason);finish(error);}
        };
      });
      if(closed||expected!==generation||socket!==ws)return;
      lastSeen=Date.now();heartbeat=setInterval(()=>{if(Date.now()-lastSeen>2500)fallback('heartbeat_timeout');},1000);heartbeat.unref();
    }catch(error){if(closed||expected!==generation)return;options.onError(error);fallback(failureReason,failureCode);await voice.open();}
  })();};
  return {open,rebindRoom:room=>voice.rebindRoom!(room),setVideo:enabled=>{
      if(closed||video===enabled)return;
      video=enabled;log('video',{enabled});generation++;opening=undefined;
      if(!video)fallback('video_off');else if(started)void open().catch(options.onError);
    },skip:()=>active?0:voice.skip?.()??0,push:(pcm,reservation,skippable)=>{
      if(closed)return;
      if(!active){voice.push(pcm,reservation,skippable);return;}
      const credit=reservation??budget.reserve(pcm.length);
      pending.push({pcm:pcm.slice(),credit});sent+=pcm.length;
      const bytes=Buffer.allocUnsafe(4+pcm.byteLength);bytes.writeUInt32LE(epoch);
      Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength).copy(bytes,4);
      if(socket!.bufferedAmount+bytes.length>CALL_PCM_LIMITS.max_samples*2+4){fallback('transport_capacity');return;}
      try{socket!.send(bytes);}catch(error){options.onError(error);fallback('send_failed');}
    },interrupt:preserveBudget=>{
      if(preserveBudget)for(const {pcm,credit} of pending)credit.release(pcm.length,false);
      pending=[];sent=played=playedOffset=0;epoch++;voice.interrupt(preserveBudget);
      if(active)budget.watch(stalled);
      if(active){if(sid)options.reset(sid);try{control('interrupt');}catch(error){options.onError(error);fallback('send_failed');}}
      settle();
    },playedSamples:()=>closed?0:playedOffset+(active?played:voice.playedSamples?.()??0),drain:async()=>{
      if(active)await budget.wait(new Promise<void>(resolve=>{drains.add(resolve);try{control('drain');}catch(error){options.onError(error);fallback('send_failed');}})).catch(error=>{if(active)throw error;});
      if(!active)await voice.drain();
    },close:async()=>{closed=true;generation++;pending=[];budget.reset();fallback('closed');await voice.close();}};
}
