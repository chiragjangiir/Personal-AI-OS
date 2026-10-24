import {constants,promises as fs} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import type {StoragePort} from './storage.ts';
import {emitRuntimeEvent} from './self-events.ts';
import {ContractError} from './contracts.ts';

const derive=promisify(scrypt),KEY=createHash('sha256').update('paios.owner-override.v1').digest('hex');
const WINDOW=15*60*1000;
const validPassphrase=(value:string)=>value.length>0&&Array.from(value).length<=1024&&Buffer.byteLength(value)<=4096;
type Secret={schema:'paios.owner-override.secret.v1';salt:string;hash:string};
type State={enabled:boolean;expires_at:string|null;enabled_by_device:string|null;failures:{device:string;at:number}[]};
export type OwnerOverrideStatus={available:boolean;enabled:boolean;expires_at:string|null;enabled_by_device:string|null;remaining_s:number|null};
export async function createOwnerOverrideSecret(passphrase:string):Promise<Secret>{
  if(!validPassphrase(passphrase))throw new Error('OWNER_OVERRIDE_INVALID_PASSPHRASE');
  const salt=randomBytes(16).toString('hex');
  return {schema:'paios.owner-override.secret.v1',salt,hash:(await derive(passphrase,salt,64) as Buffer).toString('hex')};
}

/** One persisted owner switch; paired-device authentication remains with the runtime. */
export class OwnerOverride {
  private state:State|undefined;
  private chain:Promise<unknown>=Promise.resolve();
  private listeners=new Set<(status:OwnerOverrideStatus)=>void>();
  private timer:ReturnType<typeof setTimeout>|undefined;
  private closed=false;
  private readonly now:()=>number;
  private readonly ttl:number;
  private readonly options:{storage:StoragePort;secret_root?:string;ttl_s?:number;now?:()=>number};
  constructor(options:{storage:StoragePort;secret_root?:string;ttl_s?:number;now?:()=>number}){
    this.options=options;
    this.now=options.now??Date.now;this.ttl=options.ttl_s??86400;
    if(!Number.isSafeInteger(this.ttl)||this.ttl<0||!Number.isSafeInteger(this.ttl*1000)||this.now()+this.ttl*1000>8640000000000000)
      throw new ContractError('OWNER_OVERRIDE_INVALID_TTL');
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(work);this.chain=result.then(()=>{},()=>{});return result;
  }
  private async secret():Promise<Secret|null>{
    if(!this.options.secret_root)return null;
    let file:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{
      file=await fs.open(join(this.options.secret_root,'owner-override.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o7777)!==0o600||stat.size>1024)return null;
      const value=JSON.parse(await file.readFile('utf8')) as Secret;
      return value?.schema==='paios.owner-override.secret.v1'&&/^[a-f0-9]{32}$/.test(value.salt)&&/^[a-f0-9]{128}$/.test(value.hash)?value:null;
    }catch(error){
      if(error instanceof SyntaxError||['ENOENT','EACCES','EPERM','ELOOP'].includes((error as NodeJS.ErrnoException).code??''))return null;
      throw error;
    }finally{await file?.close();}
  }
  private async load(){
    if(this.state)return;
    let s:State;
    try{s=JSON.parse(Buffer.from(await this.options.storage.read('voiceprints',KEY)).toString());}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      s={enabled:false,expires_at:null,enabled_by_device:null,failures:[]};}
    const validExpiry=s&&typeof s.expires_at==='string'&&Number.isFinite(Date.parse(s.expires_at))&&new Date(s.expires_at).toISOString()===s.expires_at;
    if(!s||Array.isArray(s)||typeof s.enabled!=='boolean'||!(s.expires_at===null||validExpiry)||
      !(s.enabled_by_device===null||typeof s.enabled_by_device==='string'&&s.enabled_by_device.length>0)||!Array.isArray(s.failures)||s.failures.length>5||
      !s.failures.every(f=>f&&typeof f.device==='string'&&f.device.length>0&&Number.isSafeInteger(f.at)&&f.at>=0)||
      (s.enabled?!s.enabled_by_device:s.expires_at!==null||s.enabled_by_device!==null))
      throw new ContractError('OWNER_OVERRIDE_INVALID_STATE',500);
    this.state=s;this.arm();
  }
  private async save(next:State){
    if(!this.options.storage.replace)throw new Error('OWNER_OVERRIDE_MUTABLE_STORAGE_REQUIRED');
    await this.options.storage.replace('voiceprints',KEY,Buffer.from(JSON.stringify(next)));this.state=next;this.arm();
  }
  private snapshot(available:boolean):OwnerOverrideStatus{
    const s=this.state!,enabled=available&&s.enabled;
    return {available,enabled,expires_at:enabled?s.expires_at:null,enabled_by_device:enabled?s.enabled_by_device:null,
      remaining_s:enabled&&s.expires_at?Math.max(0,Math.ceil((Date.parse(s.expires_at)-this.now())/1000)):null};
  }
  private changed(kind:string,device?:string,previous?:State){
    emitRuntimeEvent({kind,at:this.now(),...(device?{device_id:device}:{})});
    if(previous&&previous.enabled===this.state!.enabled&&previous.expires_at===this.state!.expires_at&&previous.enabled_by_device===this.state!.enabled_by_device)return;
    const status=this.snapshot(true);for(const listener of this.listeners)listener(status);
  }
  private arm(){
    clearTimeout(this.timer);this.timer=undefined;
    if(this.closed||!this.state?.enabled||!this.state.expires_at)return;
    this.timer=setTimeout(()=>{void this.status().catch(()=>emitRuntimeEvent({kind:'owner_override_error',at:this.now(),code:'OWNER_OVERRIDE_EXPIRY_FAILED'}));},
      Math.min(2147483647,Math.max(1,Date.parse(this.state.expires_at)-this.now())));this.timer.unref();
  }
  private async expire(){
    if(this.state!.enabled&&this.state!.expires_at&&Date.parse(this.state!.expires_at)<=this.now()){
      await this.save({...this.state!,enabled:false,expires_at:null,enabled_by_device:null});this.changed('owner_override_expiry');
    }
  }
  async status():Promise<OwnerOverrideStatus>{return this.serial(async()=>{
    await this.load();await this.expire();this.arm();return this.snapshot(!!await this.secret());
  });}
  async active():Promise<boolean>{return (await this.status()).enabled;}
  async enable(device_id:string,passphrase:string):Promise<OwnerOverrideStatus>{return this.serial(async()=>{
    if(!device_id)throw new ContractError('OWNER_OVERRIDE_DEVICE_REQUIRED');
    await this.load();await this.expire();const secret=await this.secret();
    if(!secret){emitRuntimeEvent({kind:'owner_override_failure',at:this.now(),device_id,reason:'unavailable'});throw new ContractError('OWNER_OVERRIDE_UNAVAILABLE',503);}
    const now=this.now(),failures=this.state!.failures.filter(f=>f.at>now-WINDOW);
    if(failures.length>=5||failures.filter(f=>f.device===device_id).length>=5){
      emitRuntimeEvent({kind:'owner_override_failure',at:now,device_id,reason:'locked'});throw new ContractError('OWNER_OVERRIDE_LOCKED',429);
    }
    if(!validPassphrase(passphrase)||!timingSafeEqual(await derive(passphrase,secret.salt,64) as Buffer,Buffer.from(secret.hash,'hex'))){
      await this.save({...this.state!,failures:[...failures,{device:device_id,at:now}]});
      emitRuntimeEvent({kind:'owner_override_failure',at:now,device_id,reason:'passphrase'});throw new ContractError('OWNER_OVERRIDE_INVALID_PASSPHRASE',403);
    }
    const previous=this.state!;
    await this.save({enabled:true,expires_at:this.ttl?new Date(now+this.ttl*1000).toISOString():null,enabled_by_device:device_id,
      failures});
    this.changed('owner_override_enable',device_id,previous);return this.snapshot(true);
  });}
  async disable(device_id:string):Promise<OwnerOverrideStatus>{return this.serial(async()=>{
    if(!device_id)throw new ContractError('OWNER_OVERRIDE_DEVICE_REQUIRED');
    await this.load();await this.expire();
    if(this.state!.enabled){await this.save({...this.state!,enabled:false,expires_at:null,enabled_by_device:null});this.changed('owner_override_disable',device_id);}
    return this.snapshot(!!await this.secret());
  });}
  subscribe(listener:(status:OwnerOverrideStatus)=>void):()=>void{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  close(){this.closed=true;clearTimeout(this.timer);this.listeners.clear();}
}
