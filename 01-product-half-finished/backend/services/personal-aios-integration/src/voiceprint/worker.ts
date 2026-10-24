import {Worker} from 'node:worker_threads';
import {check,ContractError} from '../contracts.ts';
import {TURN_WINDOW_MAX_MS} from './contracts.ts';
import type {SpeechCall,ThreadConfig,ThreadReply,ThreadRequest} from './engine.ts';

type Outcome={value:unknown}|{error:unknown};
interface Job {call:SpeechCall;bytes:number;control:boolean;reject(error:unknown):void;dispatched():void;settle(outcome:Outcome):void}
// The longest supported turn is 60 seconds at 16 kHz. Admission owns exact-size copies, then transfers them to native.
export const SPEECH_INPUT_BYTES=TURN_WINDOW_MAX_MS*16*Float32Array.BYTES_PER_ELEMENT,SPEECH_QUEUE_BYTES=8*1024*1024;
/** The shared bounded transport. Each worker executes one native call at a time. */
export class SpeechWorker {
  private readonly worker:Worker;private readonly timeout_ms:number;private readonly max_queue:number;private readonly queue:Job[]=[];
  private active:{job:Job;id:number;timer:ReturnType<typeof setTimeout>;done:PromiseWithResolvers<void>}|undefined;
  private next=1;private failure:ContractError|undefined;private closing:Promise<void>|undefined;
  private admittedBytes=0;private controls=0;private native:unknown=null;private termination:Promise<void>|undefined;private readonly max_controls:number;
  static async open(thread:URL,workerData:ThreadConfig,timeout_ms:number,max_queue=64):Promise<{worker:SpeechWorker;version:string;dim:number}> {
    const worker=new Worker(thread,{workerData});
    const loading=Promise.withResolvers<{version:string;dim:number;resources?:unknown}>(),failed=()=>loading.reject(new ContractError('SPEECH_ENGINE_LOAD_FAILED',503));
    const loaded=(m:{ready?:boolean;version?:unknown;dim?:unknown;resources?:unknown})=>m.ready===true&&typeof m.version==='string'&&
      Number.isSafeInteger(m.dim)&&Number(m.dim)>0?loading.resolve({version:m.version,dim:Number(m.dim),resources:m.resources}):failed();
    const timer=setTimeout(failed,timeout_ms);
    worker.once('message',loaded).once('error',failed).once('exit',failed);
    try {const ready=await loading.promise;const owner=new SpeechWorker(worker,timeout_ms,max_queue,workerData.max_streams);owner.native=ready.resources??null;return {...ready,worker:owner};}
    catch(error){await worker.terminate();throw error;}
    finally {clearTimeout(timer);worker.off('message',loaded).off('error',failed).off('exit',failed);}
  }
  private constructor(worker:Worker,timeout_ms:number,max_queue:number,max_controls:number) {
    this.worker=worker;this.timeout_ms=timeout_ms;this.max_queue=max_queue;this.max_controls=max_controls;
    worker.on('message',(reply:ThreadReply|{resources:unknown})=>{
      if('resources' in reply)this.native=reply.resources;else this.reply(reply);
    });
    worker.on('error',()=>this.fail('SPEECH_ENGINE_FAILED'));
    worker.on('exit',()=>{if(!this.closing)this.fail('SPEECH_ENGINE_EXITED');});worker.unref();
  }
  get failed():boolean {return this.failure!==undefined;}
  ensureOpen():void {check(!this.failure&&!this.closing,this.failure?.code??'SPEECH_ENGINE_CLOSED',503);}
  available():boolean {return !this.failure&&!this.closing&&this.queue.length<this.max_queue&&this.admittedBytes<SPEECH_QUEUE_BYTES;}
  snapshot() {return {pending_jobs:this.queue.length,active_jobs:Number(!!this.active),admitted_bytes:this.admittedBytes,
    pending_controls:this.controls,max_controls:this.max_controls,max_pending_jobs:this.max_queue,max_input_bytes:SPEECH_INPUT_BYTES,max_admitted_bytes:SPEECH_QUEUE_BYTES,native:this.native};}
  idle():boolean {return this.available()&&!this.active&&this.queue.length===0;}
  close():Promise<void> {
    return this.closing??=(async()=>{
      for(const job of this.queue.splice(0))job.settle({error:new ContractError('SPEECH_ENGINE_CLOSED',503)});
      if(this.failure){await this.terminate();return;}
      await this.active?.done.promise;await this.terminate();
    })();
  }
  async closeStream(call:Extract<SpeechCall,{op:'vad_close'|'kws_close'}>):Promise<void> {
    if(this.failure||this.closing){await this.close();return;}
    try {await this.call(call);} catch(error) {this.fail('SPEECH_STREAM_CLOSE_FAILED');await this.close();throw error;}
  }
  private terminate():Promise<void> {
    return this.termination??=this.worker.terminate().then(()=>{
      const active=this.active;this.active=undefined;
      if(active){clearTimeout(active.timer);active.job.settle({error:this.failure??new ContractError('SPEECH_ENGINE_CLOSED',503)});active.done.resolve();}
    });
  }
  call<T>(call:SpeechCall,signal?:AbortSignal):Promise<T> {
    const bytes='samples' in call?call.samples.byteLength:0,control=call.op==='vad_close'||call.op==='kws_close';
    try {
      this.ensureOpen();
      check(!signal?.aborted,'SPEECH_CANCELLED',409);check(control?this.controls<this.max_controls:this.queue.filter(job=>!job.control).length<this.max_queue,'SPEECH_ENGINE_BUSY',503);
      check(bytes<=SPEECH_INPUT_BYTES,'SPEECH_INPUT_BUDGET',413);
      check(this.admittedBytes+bytes<=SPEECH_QUEUE_BYTES,'SPEECH_ENGINE_BUSY',503);
    } catch(error) {return Promise.reject(error);}
    if('samples' in call)call={...call,samples:call.samples.slice()};
    this.admittedBytes+=bytes;if(control)this.controls++;
    const result=Promise.withResolvers<T>();
    const drop=(code:string,status:number)=>{const at=this.queue.indexOf(job);if(at>=0){this.queue.splice(at,1);job.settle({error:new ContractError(code,status)});}};
    const abort=()=>drop('SPEECH_CANCELLED',409),deadline=setTimeout(()=>drop('SPEECH_TIMEOUT',503),this.timeout_ms);
    const job:Job={call,bytes,control,reject:result.reject,dispatched:()=>{clearTimeout(deadline);signal?.removeEventListener('abort',abort);},
      settle:outcome=>{this.admittedBytes-=bytes;if(control)this.controls--;job.dispatched();if('error' in outcome)result.reject(outcome.error);else result.resolve(outcome.value as T);}};
    signal?.addEventListener('abort',abort,{once:true});
    const priority=control||call.op.startsWith('vad_'),at=control?this.queue.findIndex(x=>!x.control):priority?this.queue.findIndex(x=>!x.control&&!x.call.op.startsWith('vad_')):-1;
    if(at<0)this.queue.push(job);else this.queue.splice(at,0,job);this.pump();
    return result.promise;
  }
  private pump():void {
    if(this.active||this.failure||!this.queue.length)return;
    const job=this.queue.shift()!,id=this.next++;job.dispatched();
    // The watchdog covers native execution only; a hung native call cannot be interrupted, so the thread is discarded.
    this.active={job,id,done:Promise.withResolvers<void>(),timer:setTimeout(()=>this.fail('SPEECH_ENGINE_TIMEOUT'),this.timeout_ms)};
    this.worker.ref();
    try {this.worker.postMessage({...job.call,id} satisfies ThreadRequest,'samples' in job.call?[job.call.samples.buffer as ArrayBuffer]:[]);}
    catch(error) {this.complete({error});}
  }
  private reply(reply:ThreadReply):void {
    if(this.failure)return;
    if(!this.active||reply?.id!==this.active.id)return this.fail('SPEECH_ENGINE_PROTOCOL');
    this.complete(reply.ok?{value:reply.value}:{error:new ContractError(reply.code,reply.status)});
  }
  private complete(outcome:Outcome):void {
    const active=this.active!;this.active=undefined;clearTimeout(active.timer);
    active.job.settle(outcome);active.done.resolve();
    if(!this.queue.length)this.worker.unref();
    this.pump();
  }
  private fail(code:string):void {
    if(this.failure)return;
    this.failure=new ContractError(code,503);
    const active=this.active;
    if(active){clearTimeout(active.timer);active.job.reject(this.failure);}
    for(const job of this.queue.splice(0))job.settle({error:this.failure});
    // Failure is already surfaced; close() observes termination errors and joins this exact attempt.
    void this.terminate().catch(()=>undefined);
  }
}
