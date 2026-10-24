import type {CallTurn} from './voice-call-session.ts';

/** Observations only. Routing, playback and native admission retain their own authorities. */
export class CallTurnTelemetry {
  private rows=new Map<number,{at:number;audio?:number;usage:Map<string,unknown>;searchCalls:number;handoff?:CallTurn['handoff']}>();
  private previous='';
  private callId:string;private now:()=>number;private emit:(event:Record<string,unknown>)=>void;
  constructor(callId:string,now:()=>number,emit:(event:Record<string,unknown>)=>void){this.callId=callId;this.now=now;this.emit=emit;}
  input(turn:number){if(!this.rows.has(turn))this.rows.set(turn,{at:this.now(),usage:new Map(),searchCalls:0});}
  search(turn:number){const row=this.rows.get(turn);if(row)row.searchCalls++;}
  audio(turn:number){const row=this.rows.get(turn);if(row&&row.audio===undefined)row.audio=this.now();}
  usage(turn:number,response:string,value:unknown){const row=this.rows.get(turn);if(row&&value!==undefined)row.usage.set(response,value);}
  front(turn:CallTurn){
    const row=this.rows.get(turn.turn);if(!row||!turn.user)return;
    const text=turn.user.trim().replace(/\s+/gu,' '),repeated=text===this.previous;this.previous=text;
    row.handoff=turn.handoff;
    this.emitRow(turn.turn,'front_complete',row,{path:turn.route,difficulty:turn.handoff?.difficulty??(turn.route==='front_only'?'前台判断可直接回答':'前台未完成答复，沿用主脑配置'),
      handoff:turn.handoff??null,repeated_exactly:repeated,asked_again:null,interrupted:turn.interrupted});
    if(turn.route!=='handoff')this.rows.delete(turn.turn);
  }
  brain(turn:number){
    const row=this.rows.get(turn);if(row)this.emitRow(turn,'brain_complete',row,{path:'handoff',handoff:row.handoff??null});
    this.rows.delete(turn);
  }
  private emitRow(turn:number,phase:string,row:{at:number;audio?:number;usage:Map<string,unknown>;searchCalls:number},extra:Record<string,unknown>){
    const at=this.now();this.emit({voice_call_stage:'turn_metrics',call_id:this.callId,turn,phase,at,
      latency_origin:'front_input_commit',audio_boundary:'source_pcm_release',completion_origin:phase==='brain_complete'?'front_response_complete':'source_pcm_drain',first_audio_ms:row.audio===undefined?null:row.audio-row.at,completion_ms:at-row.at,
      usage:[...row.usage].map(([response_id,usage])=>({response_id,usage})),front_web_search_calls:row.searchCalls,
      token_cost:null,cost_status:'price_in_comparison_config',...extra});
  }
}
