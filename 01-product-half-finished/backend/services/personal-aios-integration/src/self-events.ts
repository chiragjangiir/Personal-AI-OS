import {mkdir, readdir, open, rename, rm, lstat, chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {channel} from 'node:diagnostics_channel';
import {join} from 'node:path';

type Event = Record<string, unknown>;
type Options = {directory:string;max_file_bytes?:number;files?:number;retention_ms?:number;max_queue_bytes?:number;now?:()=>number;onError?:(error:unknown)=>void};
type Query = {since?:number;until?:number;channel?:string};
const eventKeys = new Set(['voice_call_stage','voice_call_event','vidu_component_stage','avatar_stage','avatar_call_stage','call_stage','ambient_stage','continuous_pcm_admission','kind']);
const category = (value:unknown):value is string => typeof value==='string'&&/^[a-z][a-z_.]{0,63}$/.test(value);
const values:Record<string,Set<string>> = {
  channel:new Set(['unknown','voice_call','ambient','microphone','camera','avatar','call','continuous','phone','glasses','mac','watch','rtc_phone','rtc_glasses','rtc_mac','rtc_watch']),
  verdict:new Set(['owner','guest','assistant','other','unknown','non_owner','not_owner','uncertain','rejected','accepted']),
  status:new Set(['completed','cancelled','failed','incomplete','in_progress']),
  state:new Set(['live','closing','closed','failed','opening','connecting']),
  event:new Set(['play','cut','skipped']),mode:new Set(['audio','video','voice','avatar','manual','ambient']),
  path:new Set(['front_only','handoff']),phase:new Set(['front_complete','brain_complete']),
};
const metrics = new Set(('score probability count counts samples played_samples played_characters turn epoch prepared enabled owner dropped queued backlog queue_depth backlog_bytes queued_bytes dropped_bytes dropped_samples input_backlog output_backlog front_web_search_calls repeated_exactly interrupted').split(' '));
function logText(value:unknown):string {
  return String(value).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[redacted key]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[redacted]@')
    .replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]')
    .replace(/(["']?(?:password|secret|token|api[_-]?key|access_token|refresh_token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&},]+)/gi,'$1[redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_.-]+/g,'[redacted credential]').slice(0,2048);
}
function sanitize(input:Event, now:number):Event|undefined {
  const stage = Object.entries(input).find(([key,value])=>eventKeys.has(key)&&category(value))??
    (typeof input.central_text_failed==='string'?['central_text_failed','error']:undefined);
  if(!stage)return;
  // channel is the producing input device; unknown records absent metadata, never an output, recipient or routing result.
  const output:Event = {[stage[0]]:stage[1],at:typeof input.at==='number'&&Number.isFinite(input.at)?input.at:now,channel:'unknown'};
  for(const [key,value] of Object.entries(input)){
    if(Object.hasOwn(values,key)&&values[key]!.has(value as string))output[key]=value;
    if(key==='channel'&&typeof value==='string'&&/^rtc_[a-z_]{1,24}$/.test(value))output[key]=value;
    if((key==='code'||key==='central_text_failed')&&typeof value==='string'&&/^(?:[A-Z][A-Z0-9_]{1,63}|(?:Type|Range|Syntax|Reference)?Error)$/.test(value))output[key]=value;
    if((metrics.has(key)||/^[a-z_]{1,48}_(?:ms|backlog|count|bytes|samples)$/.test(key))&&
      (typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)))output[key]=value;
  }
  if(input.log_schema==='paios.runtime.log.v1'&&input.service==='gateway'&&typeof input.logger==='string'&&/^[a-zA-Z][\w.-]{0,127}$/.test(input.logger)&&
    ['DEBUG','INFO','WARNING','ERROR','CRITICAL'].includes(String(input.level))){
    Object.assign(output,{log_schema:input.log_schema,service:input.service,logger:input.logger,level:input.level,message:logText(input.message)});
    if(Array.isArray(input.frames))output.frames=input.frames.slice(0,3).map(logText);
    if(Array.isArray(input.cause_codes))output.cause_codes=input.cause_codes.filter(v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(v)).slice(0,8);
  }
  return output;
}
const bounded = (value:number|undefined, fallback:number) => {
  const n=value??fallback;if(!Number.isSafeInteger(n)||n<1)throw new RangeError('Invalid runtime event store bound');return n;
};

/** Retained metrics exclude private strings. Explicit producer logs add bounded, credential-redacted diagnostics. */
export class RuntimeEventStore {
  private readonly options:Required<Omit<Options,'onError'>> & Pick<Options,'onError'>;
  private chain:Promise<void>;
  private queued=0;private size=0;private closed=false;private failure:unknown;
  private counters={written:0,dropped:0,ignored:0,errors:0,rotations:0,query_truncated:false};
  constructor(options:Options){
    this.options={...options,max_file_bytes:bounded(options.max_file_bytes,4*1024*1024),files:bounded(options.files,4),
      retention_ms:bounded(options.retention_ms,7*86400000),max_queue_bytes:bounded(options.max_queue_bytes,256*1024),now:options.now??Date.now};
    this.chain=this.initialize().catch(error=>this.failed(error));
  }
  private path(index:number){return join(this.options.directory,`runtime-events.${index}.jsonl`);}
  private failed(error:unknown){if(this.failure)return;this.failure=error;this.counters.errors++;this.options.onError?.(error);}
  private async io(index:number, operation:'read'|'write'|'append', text=''){
    const flags=operation==='read'?constants.O_RDONLY:constants.O_WRONLY|constants.O_CREAT|(operation==='append'?constants.O_APPEND:constants.O_TRUNC);
    const file=await open(this.path(index),flags|constants.O_NOFOLLOW,0o600);
    try{await file.chmod(0o600);if(operation==='read')return await file.readFile('utf8');await file.writeFile(text);return '';}
    finally{await file.close();}
  }
  private async contents(index:number):Promise<string>{
    try{return await this.io(index,'read');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
  }
  private records(text:string):Event[]{
    const result:Event[]=[],lines=text.split('\n');
    for(const [index,line] of lines.entries()){
      if(!line)continue;
      let parsed:unknown;
      try{parsed=JSON.parse(line);}catch(error){
        if(index===lines.length-1&&!text.endsWith('\n'))break; // A crash can leave one incomplete final record.
        throw error;
      }
      if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
        const safe=sanitize(parsed as Event,this.options.now());if(safe&&Number(safe.at)>=this.options.now()-this.options.retention_ms&&Number(safe.at)<=this.options.now())result.push(safe);
      }
    }
    return result;
  }
  private async prune(){
    for(let i=0;i<this.options.files;i++){
      const path=this.path(i);let size:number;
      try{const entry=await lstat(path);if(!entry.isFile())throw new Error('Runtime event path is not a regular file');size=entry.size;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(size>this.options.max_file_bytes){await rm(path);continue;}
      const before=await this.contents(i),after=this.records(before).map(event=>JSON.stringify(event)+'\n').join('');
      if(before!==after)await this.io(i,'write',after);
    }
    this.size=Buffer.byteLength(await this.contents(0));
  }
  private async initialize(){
    await mkdir(this.options.directory,{recursive:true,mode:0o700});
    if(!(await lstat(this.options.directory)).isDirectory())throw new Error('Runtime event directory is not a directory');
    await chmod(this.options.directory,0o700);
    for(const file of await readdir(this.options.directory)){
      const match=/^runtime-events\.(\d+)\.jsonl$/.exec(file);
      if(match&&Number(match[1])>=this.options.files)await rm(join(this.options.directory,file));
    }
    await this.prune();
  }
  write(event:Event):void {
    if(this.closed||this.failure){this.counters.dropped++;return;}
    const safe=sanitize(event,this.options.now());if(!safe){this.counters.ignored++;return;}
    const line=JSON.stringify(safe)+'\n',bytes=Buffer.byteLength(line);
    if(bytes>this.options.max_file_bytes||bytes+this.queued>this.options.max_queue_bytes){this.counters.dropped++;return;}
    this.queued+=bytes;
    this.chain=this.chain.then(async()=>{
      if(this.failure)throw this.failure;
      if(Number(safe.at)<this.options.now()-this.options.retention_ms||Number(safe.at)>this.options.now()){this.counters.dropped++;return;}
      if(this.size+bytes>this.options.max_file_bytes){
        await rm(this.path(this.options.files-1),{force:true});
        for(let i=this.options.files-2;i>=0;i--)try{await rename(this.path(i),this.path(i+1));}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        this.size=0;this.counters.rotations++;
      }
      await this.io(0,'append',line);this.size+=bytes;this.counters.written++;
    }).catch(error=>{this.counters.dropped++;this.failed(error);}).finally(()=>{this.queued-=bytes;});
  }
  async flush():Promise<void>{await this.chain;if(this.failure)throw this.failure;}
  read(query:Query={}):Promise<Event[]>{
    const work=this.chain.then(async()=>{
      if(this.failure)throw this.failure;
      await this.prune();const events:Event[]=[];let matched=0;this.counters.query_truncated=false;
      for(let i=this.options.files-1;i>=0;i--)for(const event of this.records(await this.contents(i))){
        if(Number(event.at)<(query.since??-Infinity)||Number(event.at)>(query.until??Infinity)||query.channel!==undefined&&event.channel!==query.channel)continue;
        events[matched++%10000]=event;
      }
      this.counters.query_truncated=matched>10000;
      return matched>10000?[...events.slice(matched%10000),...events.slice(0,matched%10000)]:events;
    });
    this.chain=work.then(()=>{},error=>this.failed(error));return work;
  }
  async close():Promise<void>{this.closed=true;await this.flush();}
  snapshot(){return {...this.counters,queued_bytes:this.queued,closed:this.closed,max_file_bytes:this.options.max_file_bytes,
    files:this.options.files,max_disk_bytes:this.options.max_file_bytes*this.options.files,max_queue_bytes:this.options.max_queue_bytes,
    retention_ms:this.options.retention_ms,max_query_events:10000,counter_scope:'current gateway process; retained files survive restart',last_error:this.failure?'RUNTIME_EVENT_IO_FAILED':null};}
}

let sink:RuntimeEventStore|undefined;
export function installRuntimeEventStore(store:RuntimeEventStore):()=>void {
  if(sink)throw new Error('Runtime event store already installed');
  const bus=channel('paios.runtime.events'),listener=(message:unknown)=>store.write(message as Event);
  bus.subscribe(listener);sink=store;
  return ()=>{bus.unsubscribe(listener);if(sink===store)sink=undefined;};
}
export function emitRuntimeEvent(event:Event):void {
  const stage=Object.entries(event).find(([key,value])=>eventKeys.has(key)&&category(value));
  const failure=typeof event.central_text_failed==='string'?event.central_text_failed:undefined;
  const message=logText(event.message??event.error??failure??stage?.[1]??'runtime_event');
  const log={...event,at:typeof event.at==='number'?event.at:Date.now(),log_schema:'paios.runtime.log.v1',
    service:'gateway',logger:typeof event.logger==='string'&&/^[a-zA-Z][\w.-]{0,127}$/.test(event.logger)?event.logger:'paios.runtime',
    level:['DEBUG','INFO','WARNING','ERROR','CRITICAL'].includes(String(event.level))?event.level:failure?'ERROR':'INFO',message,
    ...(Array.isArray(event.at)?{frames:event.at.map(logText)}:{})};
  process.stderr.write(`${JSON.stringify(event)}\n`);
  sink?.write(log);
}
