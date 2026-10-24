import type {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import {speechQuality,type SpeechEmbeddingCache} from '../../../services/personal-aios-integration/src/voiceprint/contracts.ts';
import type {CallSpeakerEvidence} from './call-turn-manager.ts';

export type CallSpeechChannel='call'|'video'|'glasses'|'mac';
export function callSpeechChannel(source:{device_type?:string}|undefined,video=false):CallSpeechChannel {
  return source?.device_type==='glasses'?'glasses':source?.device_type==='mac'?'mac':video?'video':'call';
}

/** One call's temporary evidence. Durable identity and sample quality remain registry decisions. */
export function createCallSpeechIdentity(options:{
  registry?:Pick<VoiceprintRegistry,'model'|'matchCallAnchor'|'confirmDeviceOwner'>|undefined;
  enrollment:boolean;signal:AbortSignal;channel?:()=>CallSpeechChannel;
  trust_scope?:{principal_id:string;device_id:string};call_id?:string;
  identify(samples:Float32Array,speech_ms:number,signal:AbortSignal,observed_at?:string,cache?:SpeechEmbeddingCache):Promise<CallSpeakerEvidence>;
}) {
  let anchor:Float32Array|undefined;
  const clear=()=>{anchor=undefined;};
  options.signal.addEventListener('abort',clear,{once:true});
  const embedding=(evidence:CallSpeakerEvidence)=>typeof evidence==='object'?evidence.embedding:undefined;
  return {
    async identify(samples:Float32Array,speech_ms:number,signal:AbortSignal,observed_at=new Date().toISOString(),cache?:SpeechEmbeddingCache):Promise<CallSpeakerEvidence> {
      if(options.signal.aborted)return undefined;
      if(options.enrollment)return {verdict:'owner',call_only:true};
      const evidence=await options.identify(samples,speech_ms,signal,observed_at,cache);
      if(options.signal.aborted)return undefined;
      const vector=embedding(evidence);
      if(typeof evidence==='object'&&evidence.verdict==='owner'){
        if(vector&&!evidence.trust_window)anchor=vector.slice();
        return evidence;
      }
      if(typeof evidence==='object'&&evidence.verdict==='assistant')return evidence;
      if(vector&&anchor&&options.registry?.matchCallAnchor(vector,{anchor,speech_ms}).kind==='owner')return {verdict:'owner',call_only:true};
      return evidence;
    },
    async confirm(samples:Float32Array,speech_ms:number,observed_at:string,cache?:SpeechEmbeddingCache) {
      if(options.signal.aborted)return;
      const evidence=await options.identify(samples,speech_ms,options.signal,observed_at,cache);
      if(options.signal.aborted)return;
      const vector=embedding(evidence);
      if(vector&&options.registry)await options.registry.confirmDeviceOwner(vector,{channel:options.channel?.()??'call',speaker_model:options.registry.model,speech_ms,observed_at,quality:speechQuality(samples),...(options.trust_scope?{trust_scope:options.trust_scope}:{}),...(options.call_id?{call_id:options.call_id}:{})});
    },
    snapshot:()=>({anchored:!!anchor}),
  };
}
