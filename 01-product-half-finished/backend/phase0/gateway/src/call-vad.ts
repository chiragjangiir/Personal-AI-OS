import type {PcmArchiveSnapshot} from './personal-aios-formal-pcm.ts';
import type {TurnAudioReferences} from '../../../services/personal-aios-integration/src/voice/turn-collection.ts';
import {CALL_VAD_POLICY,type SpeechVadStream} from '../../../services/personal-aios-integration/src/voiceprint/engine.ts';
import type {KeywordStream} from '../../../services/personal-aios-integration/src/voiceprint/contracts.ts';
import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
const MAX_PENDING_SAMPLES=16384,KEEP_SAMPLES=21*16000;
export interface CallSpeech {samples:Float32Array;asr_samples:Float32Array;speech_ms:number;reason:'verify'|'keyword'|'end';keyword?:string;references?:TurnAudioReferences}
/** Physical detector tap only. The call decides identity and interruption; no ASR runs in this pump. */
export function callVad(open:(signal:AbortSignal)=>Promise<SpeechVadStream>,speech:(active:boolean,barge:boolean,detail?:CallSpeech)=>void,
  onError:(error:unknown)=>void,openKeywords?:(signal:AbortSignal)=>Promise<KeywordStream|undefined>) {
  const abort=new AbortController();let stream:SpeechVadStream|undefined,keywords:KeywordStream|undefined,buffer:number[]=[],ring:number[]=[],busy=false,closed=false,finishing=false;let pumping:Promise<void>|undefined;
  const packets:{length:number;offset:number;archive?:Promise<PcmArchiveSnapshot|undefined>}[]=[],sources:{start:number;end:number;offset:number;archive?:Promise<PcmArchiveSnapshot|undefined>}[]=[];
  const consumeRefs=(count:number,retain:boolean)=>{let at=tail;
    while(count&&packets.length){const p=packets[0]!,take=Math.min(count,p.length);
      if(retain)sources.push({start:at,end:at+take,offset:p.offset,...(p.archive?{archive:p.archive}:{})});
      p.length-=take;p.offset+=take;count-=take;at+=take;if(!p.length)packets.shift();}
  };
  const references=(from:number,to:number):TurnAudioReferences=>sources.filter(p=>p.end>from&&p.start<to).map(p=>{
    const offset=p.offset+Math.max(from-p.start,0),length=Math.min(p.end,to)-Math.max(p.start,from);
    const ref=Promise.resolve(p.archive).then(saved=>{if(!saved)throw new Error('CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE');
      const at=offset+(saved.sample_offset??0);return {event:saved.event,chunk:saved.chunk,sample_from:at,sample_to:at+length};});void ref.catch(()=>{});return ref;
  });
  let tail=0,start=-1,verifiedAt=0,keyword:string|undefined,latest:CallSpeech|undefined;
  const detail=(end:number,reason:CallSpeech['reason']):CallSpeech=>({samples:Float32Array.from(ring.slice(Math.max(0,start-(tail-ring.length)),Math.max(0,end-(tail-ring.length)))),asr_samples:Float32Array.from(ring.slice(Math.max(0,start-CALL_VAD_POLICY.min_silence_ms*16-(tail-ring.length)),Math.max(0,end-(tail-ring.length)))),speech_ms:(end-start)/16,reason,references:references(Math.max(start,tail-ring.length),end),...(keyword?{keyword}:{})});
  const decide=(at:number)=>{
    const end=at-CALL_VAD_POLICY.min_silence_ms*16;if(start<0)return;
    if(end-start>=6400&&end-verifiedAt>=6400){verifiedAt=end;speech(true,false,detail(end,'verify'));}
  };
  const fail=(error:unknown)=>{if(!closed){closed=true;
    if(start>=0&&tail>start)speech(false,false,detail(tail,'end'));
    abort.abort();void stream?.close();void keywords?.close();buffer=[];ring=[];onError(error);}};
  const pump=()=>{
    if(closed||busy||!stream||buffer.length<512)return;
    const samples=Float32Array.from(buffer.splice(0,Math.min(2048,Math.floor(buffer.length/512)*512)));busy=true;
    pumping=Promise.all([stream.write(samples),keywords?.write(samples)]).then(([events,hits])=>{
      if(closed)return;consumeRefs(samples.length,true);tail+=samples.length;ring.push(...samples);if(ring.length>KEEP_SAMPLES)ring.splice(0,ring.length-KEEP_SAMPLES);while(sources[0]&&sources[0].end<=tail-ring.length)sources.shift();
      if(hits?.length)keyword=hits[0]!.keyword;
      for(const e of events){
        if(e.start!==undefined){start=e.start;verifiedAt=start;keyword=hits?.[0]?.keyword;latest=undefined;speech(true,false);}
        if(e.end!==undefined){const utterance=detail(e.end,'end');latest=utterance;start=-1;speech(false,false,utterance);}else decide(e.at);
      }
      if(hits?.length){if(start>=0){const end=tail-CALL_VAD_POLICY.min_silence_ms*16;if(end>start)speech(true,false,detail(end,'keyword'));}
        else if(latest)speech(false,false,{...latest,reason:'keyword',keyword:hits[0]!.keyword});}
      decide(tail);
    }).catch(fail).finally(()=>{busy=false;pump();});
  };
  const ready=Promise.all([open(abort.signal),openKeywords?.(abort.signal)]).then(([value,kws])=>{stream=value;keywords=kws;if(closed){void value.close();void kws?.close();}else pump();}).catch(fail);
  return {ready,current:()=>start>=0?detail(tail-CALL_VAD_POLICY.min_silence_ms*16,'verify'):undefined,available:()=>!!stream&&!closed,push:(pcm:Int16Array,archive?:Promise<PcmArchiveSnapshot|undefined>)=>{
    if(closed||finishing)return;
    if(stream&&buffer.length+pcm.length>MAX_PENDING_SAMPLES){fail(new ContractError('VOICE_CALL_VAD_BACKLOG',503));return;}
    packets.push({length:pcm.length,offset:0,...(archive?{archive}:{})});void archive?.catch(()=>{});
    for(const v of pcm)buffer.push(v/32768);
    if(!stream&&buffer.length>2048){consumeRefs(buffer.length-2048,false);buffer.splice(0,buffer.length-2048);}pump();
  },finish:async()=>{
    finishing=true;const wasActive=start>=0;
    while(pumping){const work=pumping;await work;if(pumping===work)break;}
    if(start>=0&&buffer.length){consumeRefs(buffer.length,true);tail+=buffer.length;ring.push(...buffer);buffer=[];if(ring.length>KEEP_SAMPLES)ring.splice(0,ring.length-KEEP_SAMPLES);}
    const final=start>=0?detail(tail,'end'):wasActive?latest:undefined;
    closed=true;abort.abort();ring=[];buffer=[];void stream?.close();void keywords?.close();return final;
  },close:()=>{closed=true;abort.abort();buffer=[];ring=[];void stream?.close();void keywords?.close();}};
}
