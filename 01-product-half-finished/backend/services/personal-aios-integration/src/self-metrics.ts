import {check} from './contracts.ts';
import type {L3Service} from './memory/l3.ts';
import type {PosixStorage} from './storage.ts';
import type {VoiceprintRegistry} from './voiceprint/registry.ts';

type Event=Record<string,unknown>;
const percentiles=(values:number[])=>{
  values.sort((a,b)=>a-b);
  const p=(fraction:number)=>values.length?values[Math.max(0,Math.ceil(values.length*fraction)-1)]!:null;
  return {samples:values.length,min:values[0]??null,p50:p(.5),p95:p(.95),p99:p(.99),max:values.at(-1)??null};
};
export function runtimeAggregates(events:Event[]) {
  const stages:Record<string,number>=Object.create(null),failures:Record<string,number>=Object.create(null),latencies:Record<string,number[]>=Object.create(null),backlogs:Record<string,number>=Object.create(null);
  const speakers:Record<string,{verdicts:Record<string,number>;sources:Record<string,number>;scores:number[]}>=Object.create(null);
  const callStates:Record<string,number>=Object.create(null);
  let calls=0,turns=0;
  for(const e of events){
    const stage=String(e.voice_call_stage??e.voice_call_event??e.vidu_component_stage??e.avatar_call_stage??e.avatar_stage??e.ambient_stage??e.continuous_pcm_admission??e.kind??'unknown');
    stages[stage]=(stages[stage]??0)+1;
    if(e.voice_call_stage==='session_open')calls++;
    if(e.voice_call_stage==='turn_commit')turns++;
    if(e.voice_call_stage==='state'&&typeof e.state==='string')callStates[e.state]=(callStates[e.state]??0)+1;
    if(e.verdict!==undefined&&(e.voice_call_stage==='turn_speaker'||e.ambient_stage==='speaker_verdict')){const channel=String(e.channel??'unknown'),s=speakers[channel]??={verdicts:Object.create(null),sources:Object.create(null),scores:[]};
      const verdict=String(e.verdict);s.verdicts[verdict]=(s.verdicts[verdict]??0)+1;
      s.sources[stage]=(s.sources[stage]??0)+1;
      if(typeof e.score==='number'&&Number.isFinite(e.score))s.scores.push(e.score);}
    if(e.voice_call_event==='error'||e.central_text_failed!==undefined||e.kind==='error'||e.state==='failed'||e.continuous_pcm_admission==='rejected'||/failed|error|backpressure/.test(stage)){
      const kind=String(e.code??e.central_text_failed??stage);failures[kind]=(failures[kind]??0)+1;}
    for(const [key,value] of Object.entries(e))if(typeof value==='number'&&Number.isFinite(value)){
      if(key.endsWith('_ms')&&!['speech_ms','dropped_ms'].includes(key))(latencies[`${stage}.${key}`]??=[]).push(value);
      if(/backlog|queued|dropped/.test(key))backlogs[key]=Math.max(backlogs[key]??0,value);}
  }
  return {events:events.length,calls,turns,call_states:{...callStates},stages:{...stages},failures:{...failures},
    speakers:Object.fromEntries(Object.entries(speakers).map(([channel,s])=>{
      const count=Object.values(s.verdicts).reduce((sum,n)=>sum+n,0),verified=s.verdicts.owner??0,uncertain=s.verdicts.uncertain??0;
      const scored=s.scores.length,unscored=count-scored;
      return [channel,{count,counts:{verified,uncertain},rates:{verified:verified/count,uncertain:uncertain/count},
        scoring:{scored,unscored,scored_rate:scored/count,unscored_rate:unscored/count},
        verdicts:{...s.verdicts},sources:{...s.sources},
        scores:{...percentiles(s.scores),mean:scored?s.scores.reduce((a,b)=>a+b,0)/scored:null}}];})),
    latencies_ms:Object.fromEntries(Object.entries(latencies).map(([key,values])=>[key,percentiles(values)])),backlog_max:backlogs,
    interpretation:'Observed verdicts and similarity scores, not labeled accuracy. Verified means owner verdict; uncertain means uncertain verdict. Scored/unscored is an independent dimension, not additional verdicts. All speaker rates are fractions of that channel count; score statistics cover finite scores only. Sources distinguish live-call utterances from archived speech observations; these can overlap. Missing channels are unknown. Counts cover retained events in the queried window only.'};
}

export async function memoryLayerCounts(options:{principal:string;l3?:Pick<L3Service,'query'>;storage:PosixStorage;voiceprint?:Pick<VoiceprintRegistry,'owner'>;busy?:()=>boolean}) {
  // Status work yields to live calls. Runtime event queries remain available during a call.
  check(!options.busy?.(),'SELF_BACKGROUND_BUSY',409);
  let l3:unknown={status:'disabled'};
  if(options.l3){let count=0,cursor:string|undefined;
    do{check(!options.busy?.(),'SELF_BACKGROUND_BUSY',409);
      const page=await options.l3.query({authenticated:true,principal_id:options.principal},undefined,'all',{limit:100,...(cursor?{cursor}:{})});
      count+=page.assertions.length;cursor=page.next_cursor??undefined;
    }while(cursor&&count<10000);
    l3={assertions:count,complete:!cursor,scope:'applicable active and candidate assertions'};}
  let objects=0,hotBytes=0,complete=true;
  for await(const key of options.storage.hotKeys('objects')){
    check(!options.busy?.(),'SELF_BACKGROUND_BUSY',409);
    if(objects===10000){complete=false;break;}
    hotBytes+=await options.storage.hotSize('objects',key);objects++;
  }
  const cold=options.storage.cold;
  const packs=cold?await cold.packs(true):[];
  return {l3,l4:{source:'session_search',provided_by:'Hermes native tool'},
    l5:{hot_objects:objects,hot_bytes:hotBytes,hot_complete:complete,cold_configured:!!cold,
      cold_referenced_packs:packs.length,cold_pack_bytes:packs.reduce((sum,p)=>sum+p.size,0),
      scope:'Local original objects; cold referenced pack sizes include archive metadata. Hot and cold may overlap.'},
    voiceprint:options.voiceprint?await options.voiceprint.owner():{status:'disabled'}};
}
