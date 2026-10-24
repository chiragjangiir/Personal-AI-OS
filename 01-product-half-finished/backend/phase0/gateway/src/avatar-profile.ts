import type {Pool} from 'pg';
import {ContractError,isIdentifier} from '../../../services/personal-aios-integration/src/contracts.ts';
import {AvatarProfileRepository, type AvatarCommandRecord, type AvatarProfileRecord, type AvatarProfileTransaction} from '../../../services/platform-data/src/avatar-profile-repository.ts';
import {ViduAvatarRequestRejected,type ViduAvatarAsset,type ViduAvatarAssets} from './vidu-avatar-assets.ts';

export interface AvatarLook {
  look_id:string;style:string;image_url:string;focus:{x:number;y:number};vidu_avatar_id?:string;
}
export interface AvatarProfile {
  version:number;look_id:string;style:string;image_url:string;focus:{x:number;y:number};updated_at:string;
}
export interface AvatarChangeInput {
  principal_id:string;device_id:string;command_id:string;expected_version:number;look_id:string;owner_request:string;focus?:{x:number;y:number};
}
export interface AvatarChangeResult {
  status:'ready'|'pending'|'failed'|'submission_uncertain'|'superseded'|'cancelled';
  profile:AvatarProfile|null;profile_version:number;command_id:string;error?:string;
}
export interface AvatarProfileStore {
  read(principal:string):Promise<AvatarProfileRecord|null>;
  outstanding():Promise<{principal_id:string;command_id:string}[]>;
  transact<T>(principal:string,work:(tx:AvatarProfileTransaction)=>Promise<T>):Promise<T>;
}
export function assertAvatarLook(look:AvatarLook) {
  if(!look||!isIdentifier(look.look_id)||typeof look.style!=='string'||!look.style.trim()||look.style.length>80||
    Object.keys(look).some(key=>!['look_id','style','image_url','focus','vidu_avatar_id'].includes(key))||
    typeof look.image_url!=='string'||!look.image_url.startsWith('https://')||look.image_url.length>2048||/\s/u.test(look.image_url)||
    !look.focus||Object.keys(look.focus).some(key=>!['x','y'].includes(key))||![look.focus.x,look.focus.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new ContractError('AVATAR_LOOK_INVALID');
  if(!URL.canParse(look.image_url))throw new ContractError('AVATAR_IMAGE_URL_INVALID');
  const url=new URL(look.image_url);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw new ContractError('AVATAR_IMAGE_URL_INVALID');
  if(look.vidu_avatar_id!==undefined&&(typeof look.vidu_avatar_id!=='string'||!look.vidu_avatar_id.trim()))throw new ContractError('AVATAR_LOOK_INVALID');
}
export class AvatarProfileService {
  readonly #store:AvatarProfileStore;
  readonly #looks:ReadonlyMap<string,AvatarLook>;
  readonly #assets:ViduAvatarAssets|undefined;
  readonly #resolveLook:((principal:string,id:string)=>Promise<AvatarLook|undefined>)|undefined;
  readonly #listeners=new Set<(principal:string,profile:AvatarProfile|null)=>void>();
  readonly #running=new Set<string>();
  readonly #flights=new Set<Promise<AvatarChangeResult>>();
  #maintenance:Promise<void>|undefined;
  #timer:ReturnType<typeof setInterval>|undefined;
  #tickRunning=false;
  #closed=false;
  #onError:(error:unknown)=>void=error=>{console.error('AVATAR_PROFILE_NOTIFICATION_FAILED',error);};
  constructor(input:{pool?:Pool;store?:AvatarProfileStore;looks:readonly AvatarLook[];assets?:ViduAvatarAssets;resolveLook?:(principal:string,id:string)=>Promise<AvatarLook|undefined>}) {
    if(!input.store&&!input.pool)throw new ContractError('AVATAR_POSTGRES_REQUIRED');
    this.#store=input.store??new AvatarProfileRepository(input.pool!);
    const looks=new Map<string,AvatarLook>();
    for(const look of input.looks){assertAvatarLook(look);if(looks.has(look.look_id))throw new ContractError('AVATAR_LOOK_DUPLICATE');looks.set(look.look_id,structuredClone(look));}
    this.#looks=looks;this.#assets=input.assets;this.#resolveLook=input.resolveLook;
  }
  looks():Omit<AvatarLook,'vidu_avatar_id'>[]{
    return [...this.#looks.values()].map(({vidu_avatar_id:_,...look})=>structuredClone(look));
  }
  async read(principal:string):Promise<AvatarProfile|null>{return (await this.#store.read(principal))?.active as AvatarProfile|null??null;}
  async snapshot(principal:string){
    const record=await this.#store.read(principal);
    return{profile:record?.active as AvatarProfile|null??null,profile_version:record?.version??0,loaded_receipts:record?.loaded_receipts??[]};
  }
  async history(principal:string){
    const record=await this.#store.read(principal);
    return{current_version:record?.version??0,recent_versions:this.#history(record).map(({version,profile})=>({version,profile}))};
  }
  #history(record:AvatarProfileRecord|null){
    return record?.recent_versions??(record?.version?[{version:record.version,profile:record.active,avatar_id:record.active_avatar_id}]:[]);
  }
  async loaded(principal:string,device_id:string,device_type:string,profile_version:number){
    let changed=false;
    const result=await this.#store.transact(principal,async tx=>{
      if(!Number.isSafeInteger(profile_version)||profile_version<0||profile_version>tx.profile.version)throw new ContractError('AVATAR_VERSION_CONFLICT');
      const receipts=tx.profile.loaded_receipts??[];
      const previous=receipts.find(receipt=>receipt.device_id===device_id);
      if(previous&&previous.profile_version>=profile_version)return;
      tx.profile.loaded_receipts=[...receipts.filter(receipt=>receipt.device_id!==device_id),
        {device_id,device_type,profile_version,loaded_at:new Date().toISOString()}].slice(-128);
      changed=true;return tx.profile.active as AvatarProfile|null;
    });
    if(changed)this.#notify(principal,result??null);
  }
  async readPreparation(principal:string,id?:string):Promise<AvatarChangeResult|null>{
    return this.#store.transact(principal,async tx=>{
      const commandId=id??tx.profile.requested_command;
      if(!commandId)return null;
      const command=await tx.command(commandId);
      return command?this.#result(command,tx.profile):null;
    });
  }
  async activeAvatarId(principal:string):Promise<string|null>{return(await this.#store.read(principal))?.active_avatar_id??null;}
  watch(listener:(principal:string,profile:AvatarProfile|null)=>void){this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};}
  #result(command:AvatarCommandRecord,profile:AvatarProfileRecord):AvatarChangeResult {
    return{command_id:command.command_id,status:command.cancelled_at?'cancelled':
      profile.requested_command!==command.command_id&&['queued','submitting','pending','submission_uncertain'].includes(command.state)?'superseded':
      ['queued','submitting'].includes(command.state)?'pending':command.state as AvatarChangeResult['status'],
      profile:profile.active as AvatarProfile|null,profile_version:profile.version,...(command.error?{error:command.error}:{})};
  }
  #promote(tx:AvatarProfileTransaction,command:AvatarCommandRecord,avatar:string|null) {
    const look=command.look as AvatarLook|null;
    const history=this.#history(tx.profile);
    tx.profile.version++;
    tx.profile.active=look?{version:tx.profile.version,look_id:look.look_id,style:look.style,image_url:look.image_url,
      focus:look.focus,updated_at:new Date().toISOString()}:null;
    tx.profile.recent_versions=[...history,{version:tx.profile.version,profile:tx.profile.active,avatar_id:avatar}].slice(-3);
    tx.profile.active_avatar_id=avatar;command.avatar_id=avatar;command.state='ready';command.error=null;
  }
  #notify(principal:string,profile:AvatarProfile|null){
    for(const listener of this.#listeners){try{listener(principal,structuredClone(profile));}catch(error){this.#onError(error);}}
  }
  #publish(principal:string,result:AvatarChangeResult) {
    if(result.status==='ready')this.#notify(principal,result.profile);
    return result;
  }
  #track(work:Promise<AvatarChangeResult>){
    this.#flights.add(work);void work.then(()=>this.#flights.delete(work),()=>this.#flights.delete(work));return work;
  }
  change(input:AvatarChangeInput):Promise<AvatarChangeResult> {
    if(this.#closed)return Promise.reject(new ContractError('AVATAR_PROFILE_CLOSED'));
    return this.#track(this.#change(input));
  }
  async #change(input:AvatarChangeInput):Promise<AvatarChangeResult> {
    if(!isIdentifier(input.principal_id)||!isIdentifier(input.device_id)||!isIdentifier(input.command_id)||!input.owner_request?.trim()||
      !Number.isSafeInteger(input.expected_version)||input.expected_version<0)throw new ContractError('AVATAR_CHANGE_INVALID');
    const catalogueLook=this.#looks.get(input.look_id)??await this.#resolveLook?.(input.principal_id,input.look_id);
    if(!catalogueLook)throw new ContractError('AVATAR_LOOK_UNKNOWN');
    const look={...catalogueLook,...(input.focus?{focus:input.focus}:{})};
    assertAvatarLook(look);
    let created=false;
    const result=await this.#store.transact(input.principal_id,async tx=>{
      const existing=await tx.command(input.command_id);
      if(existing){
        if(existing.reuse_version!==undefined||(existing.look as AvatarLook).look_id!==input.look_id||
          input.focus!==undefined&&((existing.look as AvatarLook).focus.x!==look.focus.x||(existing.look as AvatarLook).focus.y!==look.focus.y)||existing.expected_version!==input.expected_version||existing.device_id!==input.device_id||existing.owner_request!==input.owner_request)
          throw new ContractError('AVATAR_COMMAND_REUSED');
        return this.#result(existing,tx.profile);
      }
      if(input.expected_version!==tx.profile.version)throw new ContractError('AVATAR_VERSION_CONFLICT');
      if(!look.vidu_avatar_id&&!this.#assets)throw new ContractError('AVATAR_GENERATION_UNAVAILABLE');
      if(tx.profile.requested_command){
        const previous=await tx.command(tx.profile.requested_command);
        // An outstanding provider submission still owns its account reservation until reconciled.
        if(previous?.state==='queued'){previous.state='superseded';await tx.saveCommand(previous);}
      }
      const command:AvatarCommandRecord={principal_id:input.principal_id,command_id:input.command_id,device_id:input.device_id,
        expected_version:input.expected_version,owner_request:input.owner_request,look:structuredClone(look),state:'queued',avatar_id:null,error:null,created_at:new Date().toISOString()};
      tx.profile.requested_command=input.command_id;
      if(look.vidu_avatar_id)this.#promote(tx,command,look.vidu_avatar_id);
      await tx.saveCommand(command);created=true;return this.#result(command,tx.profile);
    });
    if(created&&result.status==='ready')return this.#publish(input.principal_id,result);
    return result.status==='pending'?this.reconcile(input.principal_id,input.command_id):result;
  }
  async cancel(principal:string,id:string):Promise<AvatarChangeResult>{
    return this.#store.transact(principal,async tx=>{
      const command=await tx.command(id);if(!command)throw new ContractError('AVATAR_COMMAND_UNKNOWN');
      if(command.state!=='ready'&&!command.cancelled_at){
        command.cancelled_at=new Date().toISOString();
        if(command.state==='queued')command.state='superseded';
        await tx.saveCommand(command);
      }
      return this.#result(command,tx.profile);
    });
  }
  reuse(input:{principal_id:string;device_id:string;command_id:string;expected_version:number;version:number;owner_request:string}):Promise<AvatarChangeResult>{
    if(this.#closed)return Promise.reject(new ContractError('AVATAR_PROFILE_CLOSED'));
    return this.#track(this.#reuse(input));
  }
  async #reuse(input:Parameters<AvatarProfileService['reuse']>[0]):Promise<AvatarChangeResult>{
    let created=false;
    const result=await this.#store.transact(input.principal_id,async tx=>{
      const existing=await tx.command(input.command_id);
      if(existing){
        if(existing.reuse_version!==input.version||existing.expected_version!==input.expected_version||existing.device_id!==input.device_id||existing.owner_request!==input.owner_request)throw new ContractError('AVATAR_COMMAND_REUSED');
        return this.#result(existing,tx.profile);
      }
      if(input.expected_version!==tx.profile.version)throw new ContractError('AVATAR_VERSION_CONFLICT');
      const target=input.version===0?{profile:null,avatar_id:null}:this.#history(tx.profile).find(item=>item.version===input.version);
      if(!target)throw new ContractError('AVATAR_VERSION_UNKNOWN');
      if(target.profile!==null&&!this.#assets)throw new ContractError('AVATAR_GENERATION_UNAVAILABLE');
      const command:AvatarCommandRecord={principal_id:input.principal_id,device_id:input.device_id,command_id:input.command_id,
        expected_version:input.expected_version,owner_request:input.owner_request,reuse_version:input.version,
        look:structuredClone(target.profile),avatar_id:target.avatar_id,state:'pending',error:null,created_at:new Date().toISOString(),submission_started_at:new Date().toISOString()};
      tx.profile.requested_command=input.command_id;
      if(target.profile===null)this.#promote(tx,command,target.avatar_id);
      await tx.saveCommand(command);created=true;return this.#result(command,tx.profile);
    });
    return result.status==='pending'?this.reconcile(input.principal_id,input.command_id):created?this.#publish(input.principal_id,result):result;
  }
  /** Restart-safe reconciliation never repeats a POST whose outcome is unknown. */
  reconcile(principal:string,id:string):Promise<AvatarChangeResult> {
    if(this.#closed)return Promise.reject(new ContractError('AVATAR_PROFILE_CLOSED'));
    return this.#track(this.#reconcile(principal,id));
  }
  async #reconcile(principal:string,id:string):Promise<AvatarChangeResult> {
    const key=JSON.stringify([principal,id]);
    let action:'create'|'get'|undefined;
    const current=await this.#store.transact(principal,async tx=>{
      const command=await tx.command(id);if(!command)throw new ContractError('AVATAR_COMMAND_UNKNOWN');
      if(this.#running.has(key))return{command,result:this.#result(command,tx.profile)};
      if(command.state==='submitting'&&Date.now()-Date.parse(command.submission_started_at!)>35_000){
        command.state='submission_uncertain';command.error='submission_uncertain';await tx.saveCommand(command);
      }else if(command.state==='queued'){
        if(tx.profile.requested_command!==id){command.state='superseded';await tx.saveCommand(command);}
        else if(this.#assets&&!await tx.creationBusy()){command.state='submitting';command.submission_started_at=new Date().toISOString();await tx.saveCommand(command);action='create';}
      }else if(this.#assets&&(command.state==='pending'||command.state==='failed'&&command.error==='processing_timeout')&&command.avatar_id)action='get';
      if(action)this.#running.add(key);
      return{command,result:this.#result(command,tx.profile)};
    }).catch(error=>{if(action)this.#running.delete(key);throw error;});
    if(!action)return current.result;
    try{
      let asset:ViduAvatarAsset;
      try{
        asset=action==='create'?await this.#assets!.create((current.command.look as AvatarLook).image_url,'paios-'+id):
          await this.#assets!.get(current.command.avatar_id!);
      }catch(error){
        if(action==='get'&&!(error instanceof ViduAvatarRequestRejected))throw error;
        return await this.#store.transact(principal,async tx=>{
          const command=(await tx.command(id))!;
          const rejected=error instanceof ViduAvatarRequestRejected;
          command.state=rejected?'failed':'submission_uncertain';command.error=rejected?'provider_rejected':'submission_uncertain';
          await tx.saveCommand(command);return this.#result(command,tx.profile);
        });
      }
      const result=await this.#store.transact(principal,async tx=>{
        const command=(await tx.command(id))!;
        if(['ready','failed','superseded'].includes(command.state)&&command.error!=='processing_timeout')return this.#result(command,tx.profile);
        command.avatar_id=asset.id;
        if(asset.state==='pending'){
          const timedOut=Date.now()-Date.parse(command.submission_started_at!)>300_000;
          command.state=timedOut?'failed':'pending';command.error=timedOut?'processing_timeout':null;
        }
        else if(command.cancelled_at||tx.profile.requested_command!==id){command.state='superseded';command.error=null;}
        else if(asset.state==='failed'){command.state='failed';command.error='provider_rejected';}
        else this.#promote(tx,command,asset.id);
        await tx.saveCommand(command);return this.#result(command,tx.profile);
      });
      return this.#publish(principal,result);
    }finally{this.#running.delete(key);}
  }
  start(onError:(error:unknown)=>void) {
    if(this.#timer)return;
    this.#onError=onError;this.#closed=false;
    const tick=()=>{
      if(this.#closed||this.#tickRunning)return;
      this.#tickRunning=true;
      this.#maintenance=this.reconcilePending().catch(onError).finally(()=>{this.#tickRunning=false;});
    };
    this.#timer=setInterval(tick,5_000);this.#timer.unref();tick();
  }
  async close(){
    this.#closed=true;if(this.#timer)clearInterval(this.#timer);this.#timer=undefined;
    await Promise.allSettled([...this.#flights,...(this.#maintenance?[this.#maintenance]:[])]);
  }
  /** Pending state is durable; timers carry no authoritative job state. */
  async reconcilePending():Promise<void> {
    if(!this.#assets)return;
    for(const command of await this.#store.outstanding()){
      if(this.#closed)break;
      await this.reconcile(command.principal_id,command.command_id);
    }
  }
}
export function createAvatarProfileService(input:ConstructorParameters<typeof AvatarProfileService>[0]){return new AvatarProfileService(input);}
