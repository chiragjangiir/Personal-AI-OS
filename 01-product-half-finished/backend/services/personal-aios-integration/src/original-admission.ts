import {canonical,check,ContractError,sha256} from './contracts.ts';
import type {StoragePort} from './storage.ts';
import {QuarantineReceiptFailure} from './unknown-clock.ts';

interface PendingRecord {schema:'paios.raw-ingress.v1';record:unknown;object_hash:string;bytes:number}
interface Stage<T> {record:unknown;cancelled:boolean;reserved:boolean;reported?:boolean;promise:Promise<{key:string;commit:Promise<T>}>}
interface Job<T> {reported?:boolean;failed?:boolean;record:PendingRecord;size:number;commit:Promise<T>;resolve:(result:T)=>void;reject:(error:unknown)=>void}
const LIMIT=64*1024*1024;
const retryable=(error:unknown)=>{
  if(error instanceof QuarantineReceiptFailure)error=error.cause;
  return !(error instanceof ContractError)&&
    ['ENOSPC','EIO','EMFILE','ENFILE','EBUSY','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE','ENETUNREACH'].includes((error as NodeJS.ErrnoException)?.code??'');
};
/** RawArchive owns the immutable input until ACK; this queue clones it only within its byte budget. */
export class OriginalAdmission<T> {
  private jobs=new Map<string,Job<T>>();private used=0;private stopped=false;
  private setup:Promise<void>|undefined;private staging:Promise<unknown>=Promise.resolve();
  private admissions=new Map<string,Stage<T>>();
  private wake:(()=>void)|undefined;
  private draining:Promise<void>|undefined;private timer:ReturnType<typeof setTimeout>|undefined;
  private storage:StoragePort;private publish:(record:unknown,payload:Uint8Array)=>Promise<T>;
  private alert:(error:unknown,record?:unknown)=>void;
  private authorize:(record:unknown)=>Promise<void>;
  private published:(record:unknown)=>Promise<void>;
  constructor(storage:StoragePort,publish:(record:unknown,payload:Uint8Array)=>Promise<T>,
    alert:(error:unknown,record?:unknown)=>void=()=>{},authorize:(record:unknown)=>Promise<void>=async()=>{},published:(record:unknown)=>Promise<void>=async()=>{}){
    this.storage=storage;this.publish=publish;this.alert=alert;this.authorize=authorize;this.published=published;}
  private report(error:unknown,record:unknown,state:{reported?:boolean}){if(!state.reported){state.reported=true;this.alert(error,record);}}
  private job(key:string,record:PendingRecord,size:number,reserved=false){
    let resolve!:(result:T)=>void,reject!:(error:unknown)=>void;
    const commit=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
    // Recovery jobs have no live producer. Preserve the rejected promise for later caller inspection.
    void commit.catch(()=>{});const job={record,size,commit,resolve,reject};
    this.jobs.set(key,job);if(!reserved)this.used+=size;return job;
  }
  recover():Promise<void>{
    if(!this.setup)this.setup=(async()=>{
      check(this.storage.publishIngress&&this.storage.removeIngress,'RAW_INGRESS_STORAGE_REQUIRED',503);
      for(const key of await this.storage.list('raw-ingress')){
        const install=async()=>{
          if(this.jobs.has(key))return;
          let bytes:Uint8Array;
          try{bytes=await this.storage.read('raw-ingress',key);}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return;throw error;}
          const record=JSON.parse(Buffer.from(bytes).toString()) as PendingRecord;
          check(record.schema==='paios.raw-ingress.v1'&&sha256(bytes)===key&&/^[a-f0-9]{64}$/.test(record.object_hash)&&
            Number.isSafeInteger(record.bytes)&&record.bytes>=0,'RAW_INGRESS_METADATA_INVALID',500);
          try{await this.authorize(record.record);}catch(error){if(error instanceof ContractError&&error.code==='RAW_DELETED')return;throw error;}
          const size=record.bytes+bytes.length;check(this.used+size<=LIMIT,'RAW_INGRESS_BUDGET_EXCEEDED',503);
          this.job(key,record,size);
        };
        await (this.storage.withOriginalWrite?this.storage.withOriginalWrite(install):install());
      }
      this.kick();
    })().catch(error=>{this.setup=undefined;throw error;});return this.setup;
  }
  async admit(record:unknown,payload:Uint8Array):Promise<{key:string;commit:Promise<T>}>{return (await this.admitMany([{record,payload}]))[0]!;}
  async admitMany(inputs:{record:unknown;payload:Uint8Array}[]):Promise<{key:string;commit:Promise<T>}[]>{
    check(!this.stopped,'RAW_INGRESS_CLOSED',503);
    const items=inputs.map(({record,payload})=>{
      const metadata=Buffer.from(canonical({schema:'paios.raw-ingress.v1',record,object_hash:sha256(payload),bytes:payload.length}));
      const pending=JSON.parse(metadata.toString()) as PendingRecord;
      return {metadata,key:sha256(metadata),size:payload.length+metadata.length,payload,pending,
        stage:{record:pending.record,cancelled:false,reserved:false,promise:undefined!} as Stage<T>};
    });
    const fresh=[...new Map(items.filter(x=>!this.jobs.has(x.key)&&!this.admissions.has(x.key)).map(x=>[x.key,x])).values()];
    check(fresh.reduce((n,x)=>n+x.size,0)<=LIMIT,'RAW_INGRESS_EVENT_TOO_LARGE',413);
    if(!fresh.length)return Promise.all(items.map(x=>this.admissions.get(x.key)?.promise??Promise.resolve({key:x.key,commit:this.jobs.get(x.key)!.commit})));
    const checkCurrent=()=>{for(const x of fresh)check(!x.stage.cancelled,'RAW_INGRESS_CANCELLED',410);check(!this.stopped,'RAW_INGRESS_CLOSED_BEFORE_ACK',503);};
    const work=async()=>{
      const admitted=new Map<string,{key:string;commit:Promise<T>}>();
      for(;;){
        checkCurrent();
        try{await this.recover();for(const x of fresh){const recovered=this.jobs.get(x.key);if(recovered)admitted.set(x.key,{key:x.key,commit:recovered.commit});}
          const pending=fresh.filter(x=>!admitted.has(x.key));
          const size=pending.filter(x=>!x.stage.reserved).reduce((n,x)=>n+x.size,0);
          if(size){
            while(this.used+size>LIMIT){await this.pause();checkCurrent();}
            for(const x of pending)if(!x.stage.reserved){this.used+=x.size;x.stage.reserved=true;x.payload=Uint8Array.from(x.payload);}
          }
          const records=pending.map(x=>({key:x.key,metadata:x.metadata,hash:x.pending.object_hash,payload:x.payload,
            beforeWrite:async()=>{checkCurrent();await this.authorize(x.pending.record);}}));
          if(records.length>1&&this.storage.publishIngressBatch)await this.storage.publishIngressBatch(records);
          else for(const x of records)await this.storage.publishIngress!(x.key,x.metadata,x.hash,x.payload,x.beforeWrite);
          break;}
        catch(error){if(!retryable(error))throw error;
          checkCurrent();for(const x of fresh)this.report(error,x.pending.record,x.stage);
          await this.pause();}
      }
      checkCurrent();for(const x of fresh)if(!admitted.has(x.key)){const job=this.job(x.key,x.pending,x.size,true);admitted.set(x.key,{key:x.key,commit:job.commit});}
      this.kick();return admitted;
    };
    const result=this.staging.then(work).catch(error=>{for(const x of fresh){if(x.stage.reserved)this.used-=x.size;this.report(error,x.pending.record,x.stage);}throw error;})
      .finally(()=>{for(const x of fresh)this.admissions.delete(x.key);});
    for(const x of fresh){x.stage.promise=result.then(admitted=>admitted.get(x.key)!);this.admissions.set(x.key,x.stage);}
    const outputs=items.map(x=>this.admissions.get(x.key)?.promise??Promise.resolve({key:x.key,commit:this.jobs.get(x.key)!.commit}));
    this.staging=result.catch(()=>{});return Promise.all(outputs);
  }
  private pause(){return new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);this.wake=()=>{clearTimeout(timer);resolve();};}).finally(()=>{this.wake=undefined;});}
  cancel(predicate:(record:unknown)=>boolean){
    for(const [key,job] of this.jobs)if(predicate(job.record.record)){
      this.jobs.delete(key);this.used-=job.size;job.reject(new ContractError('RAW_INGRESS_CANCELLED',410));}
    for(const stage of this.admissions.values())if(predicate(stage.record))stage.cancelled=true;
    if(!this.jobs.size&&this.timer){clearTimeout(this.timer);this.timer=undefined;}this.wake?.();
  }
  private kick(){
    if(this.draining||this.timer||this.stopped||![...this.jobs.values()].some(job=>!job.failed))return;
    this.draining=this.drain().finally(()=>{this.draining=undefined;this.kick();});
  }
  private async drain(){
    let retry=false;for(const [key,job] of [...this.jobs]){
      if(this.stopped)return;if(job.failed||this.jobs.get(key)!==job)continue;
      try{
        const payload=await this.storage.read('objects',job.record.object_hash);
        check(payload.length===job.record.bytes&&sha256(payload)===job.record.object_hash,'RAW_INGRESS_OBJECT_INVALID',500);
        if(!this.jobs.has(key))continue;const result=await this.publish(job.record.record,payload);
        if(this.jobs.get(key)!==job)continue;await this.storage.removeIngress!(key);await this.published(job.record.record);
        if(this.jobs.delete(key))this.used-=job.size;this.wake?.();job.resolve(result);
      }catch(error){
        if(!this.jobs.has(key))continue;this.report(error,job.record.record,job);if(this.stopped)return;
        if(!retryable(error)){job.failed=true;job.reject(error);continue;}
        retry=true;
      }
    }
    if(retry&&!this.stopped&&this.jobs.size){this.timer=setTimeout(()=>{this.timer=undefined;this.kick();},1000);this.timer.unref();}
  }
  async close(){
    const setup=this.setup;this.stopped=true;this.wake?.();if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    await Promise.allSettled([setup]);await this.staging;await this.draining;
    for(const job of this.jobs.values()){
      const error=new Error('RAW_INGRESS_PENDING_AT_CLOSE: durable input retained for recovery');
      this.report(error,job.record.record,job);job.reject(error);
    }
  }
}
