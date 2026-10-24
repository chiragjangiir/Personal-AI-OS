import {ContractError,check} from './contracts.ts';

type Commit=()=>unknown;
interface Pending {bytes:number;prepare:()=>Promise<Commit>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}
/** Owner-data ACKs wait for a commit. A busy realtime lane retains bounded pages without doing SQLite work. */
export class OwnerDataIngest {
  private readonly queue:Pending[]=[];
  private bytes=0;private running=false;private closed=false;
  private immediate:ReturnType<typeof setImmediate>|undefined;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private readonly busy:()=>boolean;private readonly maxBytes:number;
  constructor(busy:()=>boolean,maxBytes:number){this.busy=busy;this.maxBytes=maxBytes;}
  enqueue<T>(bytes:number,prepare:()=>Promise<()=>T>):Promise<T> {
    check(!this.closed,'RUNTIME_CLOSED',503);
    const retained=bytes+256;
    check(this.bytes+retained<=this.maxBytes,'OWNER_DATA_INGEST_BACKLOG',503);
    const result=new Promise<T>((resolve,reject)=>{
      this.queue.push({bytes:retained,prepare,resolve:value=>resolve(value as T),reject});
      this.bytes+=retained;
    });
    this.schedule();return result;
  }
  private schedule():void {
    if(this.closed||this.running||this.immediate||this.timer||!this.queue.length)return;
    if(this.busy())this.timer=setTimeout(()=>{this.timer=undefined;this.schedule();},50);
    else this.immediate=setImmediate(()=>{this.immediate=undefined;void this.run();});
  }
  private async run():Promise<void> {
    if(this.closed||this.busy()){this.schedule();return;}
    this.running=true;const job=this.queue[0]!;
    try {
      // Preparation resolves current source authority; an await can allow a call to open meanwhile.
      const commit=await job.prepare();
      if(this.closed||this.busy())return;
      job.resolve(commit());this.remove(job);
    }catch(error){job.reject(error);this.remove(job);}
    finally{this.running=false;this.schedule();}
  }
  private remove(job:Pending):void {
    if(this.queue[0]!==job)return;
    this.queue.shift();this.bytes-=job.bytes;
  }
  close():void {
    this.closed=true;clearImmediate(this.immediate);clearTimeout(this.timer);
    this.immediate=undefined;this.timer=undefined;
    for(const job of this.queue)job.reject(new ContractError('RUNTIME_CLOSED',503));
    this.queue.length=0;this.bytes=0;
  }
}
