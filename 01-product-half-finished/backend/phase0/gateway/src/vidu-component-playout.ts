import {emitRuntimeEvent} from '../../../services/personal-aios-integration/src/self-events.ts';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {boundedViduOperation,retireViduLive,type ViduLiveJournal} from './vidu-live-journal.ts';
import {check,ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import {CallPcmBudget,SKIP_FADE_SAMPLES,type CallPlayout,type CallPcmReservation} from './call-playout.ts';
import {VIDU_IDLE_MOTION,type VideoCallConfiguration,type ViduSocket} from './vidu-call-session.ts';
import type {CallReason,CallStateExtra} from './voice-call-session.ts';

const WebSocket=createRequire(new URL('../../../services/qwen-embedded/server/src/voice/node-websocket.mjs',import.meta.url))('ws');
// Vidu has no playback ACK: position and credit release use its measured 2.4 s render delay, never a receipt.
// Sends are paced to real time, so what Vidu holds stays at about RENDER_MS (+LEAD_MS); a reply arriving faster waits in `pending`
// under the call's one PCM budget (CALL_PCM_LIMITS, as in voice calls). A cap near RENDER_MS starved the feed and cut replies.
export const RENDER_MS=2400;
/** Reply audio leaves up to LEAD_MS ahead of that schedule, as the voice route's native AudioSource queues 100 ms: an
 * event-loop stall (GC, CPU throttling) shorter than that never leaves the renderer without audio. The thinking hum is
 * sent on the schedule itself, so skipping it never delays her reply. */
export const LEAD_MS=100;
const FRAME_SAMPLES=480;
type Tail={pcm:Int16Array;credit:CallPcmReservation};
/** Renderer transport only; the call owns input, turns, PCM admission and route changes. */
export function createViduComponentPlayout(options:{id:string;configuration:VideoCallConfiguration;apiKey:string;budget:CallPcmBudget;
  onMedia(media:NonNullable<CallStateExtra['media']>):Promise<void>;onEnded(reason:CallReason):void;onError(error:unknown):void;onReset?():void;onRetired?(pcm:Int16Array):void;journal?:ViduLiveJournal;
  fetch?:typeof fetch;connect?:(url:string,headers:{Authorization:string})=>ViduSocket}):CallPlayout&{action(action:unknown):{sent:boolean};takeUnplayed():Tail[]} {
  const config=options.configuration,http=options.fetch??fetch,headers={Authorization:`Token ${options.apiKey}`},conn_id=randomUUID();
  let socket:ViduSocket|undefined,live_id:string|undefined,seq=0,closed=false,failed=false,live=false,opening:Promise<void>|undefined,closing:Promise<void>|undefined;
  const ready=Promise.withResolvers<void>(),acquired=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<never>();
  void cancelled.promise.catch(()=>{});
  void ready.promise.catch(()=>{});
  let heartbeat:NodeJS.Timeout|undefined,retry:NodeJS.Timeout|undefined,timer:NodeJS.Timeout|undefined;
  let base=0,sentSamples=0,played=0,epoch=0,clip:(Tail&{offset:number})|undefined;
  const pending:(Tail&{offset:number})[]=[],history:(Tail&{start:number;offset:number;flushed:boolean})[]=[],waiters=new Set<()=>void>(),cleanupErrors:unknown[]=[];
  const stage=(name:string,fields:object={})=>{emitRuntimeEvent({vidu_component_stage:name,call_id:options.id,live_id,at:Date.now(),...fields});};
  const send=(type:number,payload:object={})=>socket!.send(JSON.stringify({type,live_id,conn_id,seq_id:++seq,payload}));
  const settle=()=>{for(const done of waiters)done();waiters.clear();};
  const stop=()=>{clearTimeout(timer);timer=undefined;clearTimeout(retry);clearInterval(heartbeat);settle();};
  const reap=()=>{const hadAudio=history.length>0,now=Date.now();let flushed=history.reduce((n,item)=>n+item.pcm.length,0)-Math.ceil((socket?.bufferedAmount??0)/2),through=0;
    for(const item of history){
      // A local WebSocket queue is not renderer audio. Start its render estimate only after the frame leaves that queue.
      if(!item.flushed&&flushed>=item.pcm.length){item.flushed=true;item.start=Math.max(item.start,now,through);}
      flushed-=item.pcm.length;through=item.start+item.pcm.length/24;
      if(!item.flushed)continue;
      const end=Math.min(item.pcm.length,Math.max(item.offset,Math.floor((now-item.start-RENDER_MS)*24)));
      if(end>item.offset){const retired=item.pcm.slice(item.offset,end);item.credit.release(end-item.offset);played+=end-item.offset;item.offset=end;options.onRetired?.(retired);}
    }while(history[0]?.offset===history[0]?.pcm.length&&history.length)history.shift();
    // Restore the idle request once at estimated audio drain, never infer gesture completion.
    if(hadAudio&&!history.length&&!pending.length&&live&&!closed&&!failed&&socket?.readyState===1)
      control(9,{text_msg:{msg_id:randomUUID(),content:VIDU_IDLE_MOTION,timestamp:now}});
    return played;};
  const takeUnplayed=()=>{reap();clearTimeout(timer);timer=undefined;settle();const tail=[...history,...pending].map(item=>({pcm:item.pcm.slice(item.offset),credit:item.credit}));
    history.length=pending.length=0;base=sentSamples=0;epoch++;return tail;};
  const discard=()=>{for(const item of takeUnplayed())item.credit.release(item.pcm.length,false);};
  const fail=(code:string)=>{if(failed||closed)return;failed=true;live=false;stop();const error=new ContractError(code,502);
    ready.reject(error);options.onError(error);options.onEnded('error');};
  const control=(type:number,payload:object={})=>{try{send(type,payload);return true;}catch{fail('VIDU_COMPONENT_CONTROL_FAILED');return false;}};
  const pump=()=>{
    timer=undefined;reap();if(closed||failed||!live)return;
    const now=Date.now(),lead=()=>pending[0]===clip?0:LEAD_MS;
    // A delayed timer is not a broken transport. Rebase once instead of closing a paid live or bursting overdue audio.
    if(socket!.readyState!==1){fail('VIDU_COMPONENT_CLOSED');return;}
    if(socket!.bufferedAmount>48*(RENDER_MS+LEAD_MS+FRAME_SAMPLES/24)){fail('VIDU_COMPONENT_PLAYOUT_FAILED');return;}
    if(pending.length&&now>base+sentSamples/24)base=now-sentSamples/24;
    for(let due=base+sentSamples/24;pending.length&&due<=now+lead();due=base+sentSamples/24){
      const head=pending[0]!,end=Math.min(head.pcm.length,head.offset+FRAME_SAMPLES),pcm=head.pcm.slice(head.offset,end);
      try{socket!.send(Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength));}catch{fail('VIDU_COMPONENT_PLAYOUT_FAILED');return;}
      // Vidu plays what it holds in order: a frame sent early starts on its schedule, one sent late when it arrives.
      const previous=history.at(-1);history.push({pcm,credit:head.credit,start:Math.max(now,due,previous?previous.start+previous.pcm.length/24:0),offset:0,flushed:socket!.bufferedAmount===0});sentSamples+=pcm.length;head.offset=end;
      if(end===head.pcm.length)pending.shift();
    }
    if(pending.length||history.length)timer=setTimeout(pump,pending.length?Math.max(0,Math.min(20,base+sentSamples/24-lead()-Date.now())):20);else settle();
  };
  const interrupt=(preserve=false)=>{discard();played=0;if(!preserve)options.budget.reset();
    if(live&&socket?.readyState===1){control(7);options.onReset?.();stage('flush');}};
  let retiring:Promise<void>|undefined;
  const cleanup=()=>live_id?(retiring??=(options.journal?options.journal.retire:retireViduLive)({baseUrl:config.base_url,id:live_id,apiKey:options.apiKey,fetch:http,connId:conn_id,...(socket?{socket,sendControl:send}:{}),
    connect:options.connect??((url,headers)=>new WebSocket(url,{headers})),...(options.journal?{journal:options.journal}:{})}).then(result=>stage('closed',{...result,played_samples:played,position:'estimate'}))):Promise.resolve();
  const controller=new AbortController();
  const open=()=>opening??=(async()=>{
    try{
      check(!closed,'VOICE_CALL_SUPERSEDED',409);check(config.component_model&&config.action_library_id,'VIDU_COMPONENT_CONFIGURATION_REQUIRED');
      const acquisition=(async()=>{const response=await http(`${config.base_url}/live/s_avatar/component`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},
        signal:controller.signal,body:JSON.stringify({model:config.component_model,avatar_id:config.avatar_id,managed_rtc:{provider:'artc'},action:{enabled:true,library_id:config.action_library_id}})});
      check(response.ok,'VIDU_COMPONENT_CREATE_FAILED',502);
      const created=await response.json() as {live:{id:string};managed_rtc:CallStateExtra['media']};
      check(typeof created.live?.id==='string'&&created.live.id.length>0,'VIDU_COMPONENT_CREATE_INVALID',502);live_id=created.live.id;options.journal?.remember(config.base_url,live_id);stage('created');acquired.resolve();
      if(closed||failed){try{await cleanup();}catch(error){options.onError(error);}throw new ContractError('VOICE_CALL_SUPERSEDED',409);}return created;})().finally(()=>acquired.resolve());
      const created=await Promise.race([boundedViduOperation(acquisition,10000,'VIDU_COMPONENT_CREATE_TIMEOUT'),cancelled.promise]);
      const url=new URL(config.base_url);url.protocol='wss:';url.pathname=`/live/v1/external-lives/${encodeURIComponent(created.live.id)}/stream`;url.searchParams.set('conn_id',conn_id);
      socket=options.connect?options.connect(url.href,headers):new WebSocket(url.href,{headers});
      socket!.on('open',()=>{if(closed||failed)return;
        if(control(1,{conn_init:{version:1}}))heartbeat=setInterval(()=>{
          try{if(socket?.readyState===1)socket.ping();}catch{fail('VIDU_COMPONENT_CONTROL_FAILED');}},5000);});
      socket!.on('close',()=>{live=false;if(!closed)fail('VIDU_COMPONENT_CLOSED');});
      socket!.on('error',()=>{if(!closed)fail('VIDU_COMPONENT_WS_FAILED');});
      socket!.on('message',raw=>{
        if(closed||failed)return;
        try{const event=JSON.parse(String(raw));
          if(event.type===2){const ack=event.payload.conn_init_ack;if(live)return;
            if(ack.success===true){clearTimeout(retry);live=true;
              if(control(9,{text_msg:{msg_id:randomUUID(),content:VIDU_IDLE_MOTION,timestamp:Date.now()}})){stage('ready');ready.resolve();}}
            else if(ack.error_code==='NOT_READY'){clearTimeout(retry);retry=setTimeout(()=>control(1,{conn_init:{version:1}}),500);}
            else fail('VIDU_COMPONENT_INIT_FAILED');
          }else if(event.type===6){live=false;stop();options.onEnded('force_hangup');}else if(event.type===103)fail('VIDU_COMPONENT_PROVIDER_FAILED');
        }catch{fail('VIDU_COMPONENT_SIGNAL_INVALID');}
      });
      const rtc=created.managed_rtc;
      check(rtc?.provider==='artc'&&[rtc.app_id,rtc.channel_id,rtc.user_id].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)&&
        typeof rtc.token==='string'&&rtc.token.length>0&&rtc.token.length<=8192&&typeof rtc.token_expire_at==='string'&&/^[1-9][0-9]{0,19}$/.test(rtc.token_expire_at),'VIDU_MEDIA_INVALID',502);
      await Promise.race([boundedViduOperation(ready.promise,10000,'VIDU_COMPONENT_INIT_TIMEOUT'),cancelled.promise]);
      check(!closed,'VOICE_CALL_SUPERSEDED',409);
      await Promise.race([boundedViduOperation(options.onMedia({...rtc,audio_input:'gateway'}),10000,'VIDU_COMPONENT_MEDIA_TIMEOUT'),cancelled.promise]);
      check(!closed,'VOICE_CALL_SUPERSEDED',409);
    }catch(error){controller.abort();failed=true;live=false;stop();throw error;}

  })();
  return {thinkingAtCommit:true,open,playedSamples:reap,takeUnplayed,push:(pcm,reservation,skippable)=>{
      if(closed||failed||!live){reservation?.release(pcm.length,false);return;}
      reap();if(!pending.length&&Date.now()>=base+sentSamples/24){base=Date.now();sentSamples=0;}
      const item={pcm:pcm.slice(),offset:0,credit:reservation??options.budget.reserve(pcm.length)};pending.push(item);if(skippable)clip=item;clearTimeout(timer);pump();
    },skip:()=>{const item=clip,index=item?pending.indexOf(item):-1;clip=undefined;if(!item||index<0)return 0;
      // Same rule as the voice track: unsent hum after a 40 ms fade (all of it if none was sent) is dropped and its credit returned.
      const keep=item.offset?Math.min(item.pcm.length,item.offset+SKIP_FADE_SAMPLES):0,dropped=item.pcm.length-keep;
      for(let i=item.offset;i<keep;i++)item.pcm[i]=Math.round(item.pcm[i]!*(keep-i)/(keep-item.offset));
      if(keep)item.pcm=item.pcm.subarray(0,keep);else pending.splice(index,1);item.credit.release(dropped,false);return dropped;},interrupt,drain:async()=>{const generation=epoch;reap();if((pending.length||history.length)&&generation===epoch&&!closed&&!failed)
      await new Promise<void>(resolve=>waiters.add(resolve));},action:action=>{
      const content=action==='wave'?'向镜头挥手':action==='heart'?'对镜头比心':action==='rest'?VIDU_IDLE_MOTION:typeof action==='string'?action.trim():undefined;
      check(content,'VIDU_GESTURE_UNSUPPORTED',422);if(!live||closed||failed)return {sent:false};
      const sent=control(9,{text_msg:{msg_id:randomUUID(),content,timestamp:Date.now()}});if(sent)stage('action',{action});return {sent};
    },close:()=>closing??=(async()=>{
      closed=true;controller.abort();discard();live=false;stop();ready.reject(new ContractError('VOICE_CALL_SUPERSEDED',409));
      cancelled.reject(new ContractError('VOICE_CALL_SUPERSEDED',409));
      const errors=cleanupErrors;
      if(opening&&!live_id)try{await boundedViduOperation(acquired.promise,10000,'VIDU_COMPONENT_ACQUISITION_UNRESOLVED');}catch(error){errors.push(error);}
      try{await cleanup();}catch(error){errors.push(...(error instanceof AggregateError?error.errors:[error]));}
      for(const error of errors)options.onError(error);if(errors.length)throw new AggregateError(errors,'VIDU_COMPONENT_CLEANUP_FAILED');
    })()};
}
