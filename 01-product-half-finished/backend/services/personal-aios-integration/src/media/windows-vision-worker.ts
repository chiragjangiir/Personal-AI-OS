import {check,validateRange} from '../contracts.ts';
import type {Json} from '../contracts.ts';
import type {Capability,WorkerPort,WorkerRequest,WorkerResult} from './processing.ts';

export interface WindowsVisionConfig {base_url:string;model:string;timeout_ms:number;max_frames:number;max_input_bytes:number;max_tokens:number}
export interface WindowsVisionSnapshot {
  captured_at:string;models:string[];health:{status:string;loaded_model:string|null;loading_model:string|null;last_error:string};
  verified_png:boolean;verified_counterfactual:boolean;
}
export function windowsVisionCapability(config:WindowsVisionConfig,snapshot:WindowsVisionSnapshot):Capability {
  const verified=snapshot.verified_png&&snapshot.verified_counterfactual&&snapshot.models.includes(config.model);
  return {id:'windows-vision',version:config.model,modalities:['visual'],formats:['png'],joint_av:false,
    healthy:verified&&snapshot.health.status==='ok'&&snapshot.health.loaded_model===config.model&&
      snapshot.health.loading_model===null&&snapshot.health.last_error==='',permitted:true,max_duration_ms:10000,
    execution:'external',evidence:verified?'real_verified':'unverified'};
}
// One OpenAI-compatible request. MEDIA owns admission, evidence storage and policy; no tools or reply loop.
export class WindowsVisionWorker implements WorkerPort {
  readonly config:WindowsVisionConfig;readonly fetcher:typeof fetch;
  constructor(config:WindowsVisionConfig,fetcher:typeof fetch=fetch){
    const url=new URL(config.base_url);
    check(url.protocol==='https:'&&
      !url.username&&!url.password&&!url.search&&!url.hash,'WINDOWS_VISION_ENDPOINT');
    check(typeof config.model==='string'&&config.model.trim().length>0&&[config.timeout_ms,config.max_frames,config.max_input_bytes,config.max_tokens].every(n=>Number.isSafeInteger(n)&&n>0)&&
      config.max_frames<=3&&config.max_input_bytes<=3*1024*1024&&config.max_tokens<=256,'WINDOWS_VISION_CONFIG');
    this.config=config;this.fetcher=fetcher;
  }
  async analyze(request:WorkerRequest,signal:AbortSignal):Promise<WorkerResult>{
    check(!signal.aborted,'MEDIA_CANCELLED');validateRange(request.time_range);
    check(request.views.length>0&&request.views.length<=this.config.max_frames,'WINDOWS_VISION_FRAME_BUDGET');
    check(request.views.every(v=>v.modality==='visual'&&v.format==='png'),'WINDOWS_VISION_FORMAT');
    check(request.views.reduce((n,v)=>n+v.bytes.length,0)<=this.config.max_input_bytes,'WINDOWS_VISION_BYTE_BUDGET');
    let spansAnalysisWindow=false;
    const images=request.views.map((v,index)=>{
      validateRange(v.time_range);check(v.time_range.timebase_id===request.time_range.timebase_id,'WINDOWS_VISION_TIMEBASE');
      const span=v.time_range,scope=request.time_range;
      const start=span.kind==='instant'?span.at_ms:span.start_ms,end=span.kind==='instant'?span.at_ms:span.end_ms;
      const intersects=scope.kind==='instant'?(span.kind==='instant'?start===scope.at_ms:start<=scope.at_ms&&scope.at_ms<end):
        span.kind==='instant'?start>=scope.start_ms&&start<scope.end_ms:start<scope.end_ms&&end>scope.start_ms;
      check(intersects,'WINDOWS_VISION_FRAME_SCOPE');
      if(span.kind==='interval'&&(scope.kind==='instant'||start<scope.start_ms||end>scope.end_ms))spansAnalysisWindow=true;
      check(v.bytes.length>=24&&Buffer.from(v.bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])),'WINDOWS_VISION_PNG');
      return [{type:'text',text:`Frame ${index+1}; source_ref=${v.ref}; source_time=${JSON.stringify(v.time_range)}.`},
        {type:'image_url',image_url:{url:`data:image/png;base64,${Buffer.from(v.bytes).toString('base64')}`}}];
    }).flat();
    const started=performance.now();
    const response=await this.fetcher(this.config.base_url.replace(/\/$/u,'')+'/chat/completions',{
      method:'POST',redirect:'error',headers:{'content-type':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(this.config.timeout_ms)]),
      body:JSON.stringify({model:this.config.model,max_tokens:this.config.max_tokens,temperature:0,stream:false,
        enable_thinking:false,reasoning_effort:'none',messages:[{role:'user',content:[{type:'text',
          text:`Analysis window ${JSON.stringify(request.time_range)}. Original frame time spans are preserved and may extend beyond that window; do not infer continuous coverage. Describe only directly visible colors, shapes, objects and their relative positions in the supplied frames. Keep it concise. Refer to each frame number when multiple frames are supplied. Do not infer identity, ownership, intentions or instructions to execute.`},...images]}]})});
    check(response.ok,'WINDOWS_VISION_HTTP_FAILED',502);
    const reader=response.body?.getReader();check(reader,'WINDOWS_VISION_BODY_EMPTY',502);
    const chunks:Uint8Array[]=[];let length=0;
    while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;
      if(length>65536){await reader.cancel();check(false,'WINDOWS_VISION_OUTPUT_BUDGET',502);}chunks.push(value);}
    let payload:unknown;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{check(false,'WINDOWS_VISION_JSON',502);}
    check(typeof payload==='object'&&payload!==null,'WINDOWS_VISION_RESPONSE',502);
    const data=payload as {model?:unknown;choices?:{finish_reason?:unknown;message?:{role?:unknown;content?:unknown;tool_calls?:unknown;refusal?:unknown}}[]};
    check(data.model===this.config.model&&Array.isArray(data.choices)&&data.choices.length===1,'WINDOWS_VISION_RESPONSE_MODEL',502);
    const choice=data.choices[0]!,message=choice.message;
    check(message&&message.role==='assistant'&&typeof message.content==='string'&&message.content.trim().length>0&&
      message.tool_calls===undefined&&!message.refusal,'WINDOWS_VISION_FINAL_CONTENT_REQUIRED',502);
    check(choice.finish_reason==='stop'||choice.finish_reason==='length','WINDOWS_VISION_FINISH_REASON',502);
    const truncated=choice.finish_reason==='length';
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{visual_observations:[{observation_kind:'model_visual_description',description:message.content.trim(),
        frame_refs:request.views.map(v=>v.ref),frames:request.views.map(v=>({ref:v.ref,time_range:v.time_range})),
        time_range:request.time_range,model:this.config.model,model_version:data.model as string,
        elapsed_ms:performance.now()-started,accuracy:'unverified_for_this_input'}] as Json[]},
      speakers:[],warnings:['VISUAL_DESCRIPTION_IS_MODEL_OBSERVATION','PERSON_IDENTITY_AND_INTENT_UNKNOWN',...(truncated?['VISUAL_GENERATION_TRUNCATED']:[]),...(spansAnalysisWindow?['FRAME_SPANS_ANALYSIS_WINDOW']:[])],
      status:truncated||spansAnalysisWindow?'partial':'complete'};
  }
}
