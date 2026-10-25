import {randomUUID,createHmac} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonical,check,sha256} from './contracts.ts';
import {openOwnerDatabase,inTransaction} from './owner-db.ts';
import {ModelVault,loadModelMasterKey,type SealedModelKey} from './model-settings-vault.ts';
import {validateModelSnapshot,immutableReadOnly,modelRoleKey,type ModelSnapshot,type ModelResolution,type ModelRole,type SettingsAction,type SettingsDraftRequest} from './model-settings-contract.ts';
import {probeModelConnection} from './model-settings-probe.ts';
import {fetchModelCatalog} from './model-settings-catalog.ts';
import {defaultCacheWriteBilling,type ModelUsage,type UsageAttempt} from './model-usage.ts';

interface Actor {principal_id:string;device_id:string}
type Group='brain'|'build';
interface GroupState {desired:number;effective:number;status:'pending'|'applying'|'effective'|'failed';error:string|null}
interface Revision {revision:number;snapshot:ModelSnapshot;versions:Record<string,number>}
export interface ModelSettingsDraft extends Revision,Actor {
  draft_id:string;environment_id:string;action:SettingsAction;expected_revision:number;change_sha256:string;
  expires_at_ms:number;payload:Record<string,unknown>;preview:Record<string,unknown>;sealed_key?:SealedModelKey;
}
interface Options {
  environment_id:string;master_key?:Buffer;master_key_file?:string;now?:()=>number;allow_private_hosts?:readonly string[];
  activate?:(group:Group,revision:number,authority:ModelSettingsAuthority)=>Promise<void>;
  onAction?:(draft:ModelSettingsDraft)=>void;
  onEffective?:(group:Group,revision:number,authority:ModelSettingsAuthority)=>void;
  probe?:typeof probeModelConnection;
  probeUsage?:()=>ModelUsage;
}
const DDL=`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS model_revisions(revision INTEGER PRIMARY KEY,previous INTEGER,body TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS model_groups(name TEXT PRIMARY KEY,desired INTEGER NOT NULL,effective INTEGER NOT NULL,status TEXT NOT NULL,error TEXT) STRICT;
CREATE TABLE IF NOT EXISTS model_drafts(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS model_receipts(principal TEXT NOT NULL,device TEXT NOT NULL,nonce TEXT NOT NULL,draft TEXT NOT NULL,fingerprint TEXT,body TEXT NOT NULL,PRIMARY KEY(principal,device,nonce)) STRICT;`;

/** Owns persisted model facts. Native runtimes own inference and ordered fallback execution. */
export class ModelSettingsAuthority {
  public readonly db:DatabaseSync;
  readonly environment_id:string;
  private readonly vault:ModelVault;
  private readonly now:()=>number;
  private readonly options:Options;
  private readonly handleKey:Buffer;
  private readonly listeners=new Set<()=>void>();
  private readonly activating=new Map<Group,Promise<GroupState>>();
  private constructor(db:DatabaseSync,options:Options){
    this.db=db;this.options=options;this.environment_id=options.environment_id;this.now=options.now??Date.now;
    const environment=db.prepare("SELECT value FROM meta WHERE key='environment'").get() as {value:string}|undefined;
    check(!environment||environment.value===this.environment_id,'MODEL_SETTINGS_ENVIRONMENT_MISMATCH',503);
    db.prepare("INSERT OR IGNORE INTO meta VALUES('environment',?)").run(this.environment_id);
    const master=options.master_key??loadModelMasterKey(options.master_key_file!);
    this.handleKey=createHmac('sha256',master).update('model-settings-credential-handles-v1').digest();
    this.vault=new ModelVault(db,this.environment_id,master,this.now);
    for(const group of ['brain','build'])db.prepare("INSERT OR IGNORE INTO model_groups VALUES(?,0,0,'effective',NULL)").run(group);
    db.prepare("UPDATE model_groups SET status='pending',error=NULL WHERE status='applying'").run();
    this.checkpointPendingKeys();
  }
  static open(directory:string,options:Options):ModelSettingsAuthority {
    check(/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(options.environment_id)&&!!(options.master_key||options.master_key_file),'MODEL_SETTINGS_BOOTSTRAP_INVALID',503);
    const db=openOwnerDatabase(directory,'model-settings.sqlite3',DDL,'paios.model-settings.v1','MODEL_SETTINGS');
    try{return new ModelSettingsAuthority(db,options);}catch(error){db.close();throw error;}
  }
  close():void {if(this.db.isOpen)this.db.close();}
  watch(listener:()=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private changed():void {for(const listener of this.listeners)listener();}
  private latest():number {return Number(this.db.prepare('SELECT MAX(revision) revision FROM model_revisions').get()!.revision??0);}
  private revision(revision:number):Revision {
    if(revision===0)return {revision:0,snapshot:{providers:[],roles:[]},versions:{}};
    const row=this.db.prepare('SELECT body FROM model_revisions WHERE revision=?').get(revision) as {body:string}|undefined;
    check(row,'MODEL_SETTINGS_REVISION_UNKNOWN',404);return JSON.parse(row.body) as Revision;
  }
  readRevision(revision:number):Revision {return this.revision(revision);}
  private versions(snapshot:ModelSnapshot,preferred:Record<string,number>={}):Record<string,number> {
    return Object.fromEntries(snapshot.providers.filter(p=>p.credential_ref!==null).map(p=>[p.credential_ref!,preferred[p.credential_ref!]??this.vault.version(p.credential_ref!)??0]));
  }
  private keyDrafts():ModelSettingsDraft[] {
    return (this.db.prepare(`SELECT d.body FROM model_drafts d JOIN model_revisions r
      ON json_extract(r.actor,'$.draft_id')=d.id ORDER BY r.revision DESC`).all() as {body:string}[])
      .map(row=>JSON.parse(row.body) as ModelSettingsDraft).filter(draft=>!!draft.sealed_key);
  }
  private staged(ref:string,version:number,revision:number):SealedModelKey|undefined {
    return this.keyDrafts().find(draft=>draft.revision<=revision&&draft.sealed_key!.ref===ref&&draft.sealed_key!.version===version)?.sealed_key;
  }
  credentialConfigured(ref:string,version:number,revision:number):boolean {
    return version>0&&(this.vault.version(ref)===version||!!this.staged(ref,version,revision));
  }
  private groupFacts(value:Revision,group:Group) {
    const roles=value.snapshot.roles.filter(role=>role.activation_boundary===(group==='brain'?'brain_idle':'build_idle'));
    const inherited=new Map<string,ModelRole>();
    const refs=new Set(roles.flatMap(role=>{
      let route=role,disabled=false;
      for(;;){disabled||=!!route.disabled;if(route!==role)inherited.set(modelRoleKey(route),route);
        if(!route.inherit_from)break;route=value.snapshot.roles.find(candidate=>candidate.profile===role.profile&&candidate.id===route.inherit_from)!;}
      return disabled?[]:[route.provider_ref,...role.ordered_fallbacks.map(route=>route.provider_ref)];}));
    const providers=value.snapshot.providers.filter(provider=>refs.has(provider.id));
    const versions=Object.fromEntries(providers.filter(provider=>provider.credential_ref!==null).map(provider=>[provider.credential_ref!,value.versions[provider.credential_ref!]]));
    return {roles,inherited:[...inherited.values()],providers,versions};
  }
  /** A pending new key coexists with the effective key only until every user of it acknowledges activation. */
  private promoteKeys():boolean {
    const latest=this.revision(this.latest());let changed=false;
    const effective=this.db.prepare('SELECT name,effective FROM model_groups').all() as {name:Group;effective:number}[];
    for(const draft of this.keyDrafts()){
      const key=draft.sealed_key!,desired=latest.versions[key.ref]===key.version;
      if(!desired&&effective.some(group=>this.groupFacts(this.revision(group.effective),group.name).versions[key.ref]===key.version))continue;
      if(desired&&effective.some(group=>{const version=this.groupFacts(this.revision(group.effective),group.name).versions[key.ref];
        return version!==undefined&&version!==key.version;}))continue;
      if(desired&&this.vault.version(key.ref)!==key.version)this.vault.save(key);
      for(const row of this.db.prepare('SELECT id,body FROM model_drafts').all() as {id:string;body:string}[]){
        const candidate=JSON.parse(row.body) as ModelSettingsDraft;
        if(candidate.sealed_key?.ref===key.ref&&candidate.sealed_key.version<=key.version){delete candidate.sealed_key;
          this.db.prepare('UPDATE model_drafts SET body=? WHERE id=?').run(canonical(candidate),row.id);changed=true;}
      }
    }
    if(changed)this.db.prepare("INSERT INTO meta VALUES('keys_cleanup_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    return changed;
  }
  /** A checkpoint is cleanup after a durable key mutation, never the mutation's commit point. */
  checkpointPendingKeys():boolean {
    if(!this.db.prepare("SELECT 1 FROM meta WHERE key='keys_cleanup_pending'").get())return true;
    try{
      const result=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number};
      if(result.busy!==0)return false;
      this.db.prepare("DELETE FROM meta WHERE key='keys_cleanup_pending'").run();this.changed();return true;
    }catch{return false;}
  }
  /** Called only for an explicitly supplied deployment import, once. Never reads old runtime defaults. */
  bootstrap(snapshot:ModelSnapshot,keys:Record<string,string>={}):void {
    check(this.latest()===0,'MODEL_SETTINGS_ALREADY_IMPORTED',409);validateModelSnapshot(snapshot,this.options.allow_private_hosts);
    inTransaction(this.db,()=>{
      for(const [ref,key] of Object.entries(keys)){check(snapshot.providers.some(p=>p.credential_ref===ref),'MODEL_SETTINGS_CREDENTIAL_UNKNOWN');this.vault.save(this.vault.seal(ref,key));}
      const body:Revision={revision:1,snapshot:structuredClone(snapshot),versions:this.versions(snapshot)};
      this.db.prepare('INSERT INTO model_revisions VALUES(1,NULL,?,?,?)').run(canonical(body),canonical({source:'explicit_import'}),new Date(this.now()).toISOString());
      for(const group of ['brain','build'])this.db.prepare("UPDATE model_groups SET desired=1,effective=1,status='effective',error=NULL WHERE name=?").run(group);
    });this.changed();
  }
  read(){
    const desired=this.latest(),current=desired?this.revision(desired):undefined;
    const cleanupPending=!!this.db.prepare("SELECT 1 FROM meta WHERE key='keys_cleanup_pending'").get();
    const groups=Object.fromEntries(this.db.prepare('SELECT * FROM model_groups').all().map(row=>[row.name,{desired:row.desired,effective:row.effective,status:row.status,error:row.error??(cleanupPending?'MODEL_SETTINGS_VAULT_CLEANUP_FAILED':null)}])) as Record<Group,GroupState>;
    const refs=new Set([...(current?.snapshot.providers??[]).flatMap(provider=>provider.credential_ref?[provider.credential_ref]:[]),...Object.keys(current?.versions??{})]);
    const credentials=Object.fromEntries([...refs].map(ref=>[ref,this.vault.projection(ref,this.staged(ref,current!.versions[ref]??0,desired))]));
    return {environment_id:this.environment_id,desired,groups,providers:current?.snapshot.providers??[],roles:current?.snapshot.roles??[],credentials};
  }
  resolve(environment:string,profile:string,roleId:string,revision:number):ModelResolution {
    check(environment===this.environment_id,'MODEL_SETTINGS_ENVIRONMENT_MISMATCH',403);
    const value=this.revision(revision),roles=value.snapshot.roles;
    const role=roles.find(role=>role.profile===profile&&role.id===roleId);check(role,'MODEL_SETTINGS_ROLE_UNKNOWN',404);
    const chain:ModelRole[]=[role];while(chain.at(-1)!.inherit_from)chain.push(roles.find(candidate=>candidate.profile===profile&&candidate.id===chain.at(-1)!.inherit_from)!);
    const resolved=chain.at(-1)!,disabled=chain.some(role=>role.disabled===true);
    const parameters=Object.assign({},...chain.toReversed().map(role=>role.parameters));
    const credential=(ref:string|null)=>{
      if(ref===null)return {};const credential_version=value.versions[ref]??0;
      return {credential_version,credential_handle:createHmac('sha256',this.handleKey).update(canonical({environment_id:environment,profile,revision,ref,version:credential_version})).digest('base64url')};
    };
    if(disabled)return {environment_id:environment,profile,role:roleId,revision,disabled:true,parameters,ordered_fallbacks:[]};
    const provider=value.snapshot.providers.find(p=>p.id===resolved.provider_ref)!;
    const ordered_fallbacks=role.ordered_fallbacks.map(route=>{const provider=value.snapshot.providers.find(p=>p.id===route.provider_ref)!;return {...route,provider,...credential(provider.credential_ref)};});
    return {environment_id:environment,profile,role:roleId,revision,disabled:false,provider,model_id:resolved.model_id!,parameters,...credential(provider.credential_ref),ordered_fallbacks};
  }
  credential(input:{environment_id:string;profile:string;revision:number;handle:string}):string {
    check(input.environment_id===this.environment_id,'MODEL_SETTINGS_ENVIRONMENT_MISMATCH',403);
    const value=this.revision(input.revision);
    const routes=value.snapshot.roles.filter(role=>role.profile===input.profile&&!role.disabled).flatMap(role=>{
      const result=this.resolve(input.environment_id,input.profile,role.id,input.revision);return [result,...result.ordered_fallbacks];});
    const route=routes.find(route=>route.credential_handle===input.handle);check(route&&route.provider?.credential_ref,'MODEL_SETTINGS_CREDENTIAL_SCOPE_DENIED',403);
    return this.vault.reveal(route.provider.credential_ref,route.credential_version!,this.staged(route.provider.credential_ref,route.credential_version!,input.revision));
  }
  draft(source:Actor,request:SettingsDraftRequest){
    check(Number.isSafeInteger(request.expected_revision)&&request.expected_revision===this.latest(),'MODEL_SETTINGS_REVISION_CONFLICT',409);
    const action=request.action??'commit',current=this.revision(request.expected_revision);
    let snapshot=current.snapshot,versions=current.versions;
    if(action==='commit'){
      check(request.providers||request.roles,'MODEL_SETTINGS_SNAPSHOT_REQUIRED');
      const providers=new Map(current.snapshot.providers.map(provider=>[provider.id,provider]));
      const roles=new Map(current.snapshot.roles.map(role=>[modelRoleKey(role),role]));
      for(const provider of request.providers??[])providers.set(provider.id,provider);
      for(const role of request.roles??[])roles.set(modelRoleKey(role),role);
      snapshot={providers:[...providers.values()],roles:[...roles.values()]};
      validateModelSnapshot(snapshot,this.options.allow_private_hosts);immutableReadOnly(current.snapshot,snapshot);versions=this.versions(snapshot,current.versions);
    }else if(action==='undo'){
      check(Number.isSafeInteger(request.revision),'MODEL_SETTINGS_REVISION_UNKNOWN');const target=this.revision(request.revision!);
      snapshot=target.snapshot;versions=target.versions;this.requireKeys(snapshot,versions,undefined,request.revision!);
    }else if(action==='authorize_mac')check(typeof request.device_id==='string'&&typeof request.public_x963_b64==='string','MODEL_SETTINGS_MAC_KEY_REQUIRED');
    else if(action==='pause'){
      check(typeof request.pause_on_limit==='boolean','MODEL_SETTINGS_BUDGET_INVALID');
      check(request.owner_reserve_cny===undefined||Number.isFinite(request.owner_reserve_cny)&&request.owner_reserve_cny>=1&&Number.isSafeInteger(Math.round(request.owner_reserve_cny*1_000_000)),'MODEL_SETTINGS_RESERVE_INVALID');
    }else check(action==='resume','MODEL_SETTINGS_ACTION_INVALID');
    return this.saveDraft(source,action,request,snapshot,versions);
  }
  keyDraft(source:Actor,request:{expected_revision:number;credential_ref:string;key:string}){
    check(request.expected_revision===this.latest(),'MODEL_SETTINGS_REVISION_CONFLICT',409);const current=this.revision(request.expected_revision);
    check(typeof request.credential_ref==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(request.credential_ref),'MODEL_SETTINGS_CREDENTIAL_UNKNOWN');
    const version=Math.max(this.vault.version(request.credential_ref)??0,...(this.db.prepare('SELECT body FROM model_drafts').all() as {body:string}[]).map(row=>{const value=JSON.parse(row.body) as ModelSettingsDraft;return value.sealed_key?.ref===request.credential_ref?value.sealed_key.version:0;}))+1;
    const sealed=this.vault.seal(request.credential_ref,request.key,version),versions={...current.versions,[request.credential_ref]:sealed.version};
    return this.saveDraft(source,'set_key',{expected_revision:request.expected_revision,credential_ref:request.credential_ref},current.snapshot,versions,sealed);
  }
  private saveDraft(source:Actor,action:SettingsAction,payload:object,snapshot:ModelSnapshot,versions:Record<string,number>,sealed_key?:SealedModelKey){
    const draft:ModelSettingsDraft={...source,environment_id:this.environment_id,draft_id:randomUUID(),action,expected_revision:this.latest(),revision:this.latest()+1,
      snapshot:structuredClone(snapshot),versions:{...versions},payload:structuredClone(payload) as Record<string,unknown>,expires_at_ms:this.now()+300_000,
      change_sha256:sha256(canonical({action,payload,snapshot,versions,...(sealed_key?{key:{ref:sealed_key.ref,version:sealed_key.version,ciphertext:sealed_key.ciphertext}}:{})})),
      preview:{change_summary:(payload as SettingsDraftRequest).change_summary??action,provider_count:snapshot.providers.length,role_count:snapshot.roles.length,
        ...(sealed_key?{key:{credential_ref:sealed_key.ref,configured:true,last4:sealed_key.last4}}:{})},...(sealed_key?{sealed_key}:{})};
    this.db.prepare('INSERT INTO model_drafts VALUES(?,?)').run(draft.draft_id,canonical(draft));
    return this.publicDraft(draft);
  }
  private publicDraft(draft:ModelSettingsDraft){return {draft_id:draft.draft_id,action:draft.action,expected_revision:draft.expected_revision,change_sha256:draft.change_sha256,expires_at_ms:draft.expires_at_ms,principal_id:draft.principal_id,preview:draft.preview};}
  getDraft(source:Actor,id:string):ModelSettingsDraft {
    const row=this.db.prepare('SELECT body FROM model_drafts WHERE id=?').get(id) as {body:string}|undefined;check(row,'MODEL_SETTINGS_DRAFT_UNKNOWN',404);
    const draft=JSON.parse(row.body) as ModelSettingsDraft;
    check(draft.principal_id===source.principal_id&&draft.device_id===source.device_id,'MODEL_SETTINGS_DRAFT_SOURCE_MISMATCH',403);return draft;
  }
  private requireKeys(snapshot:ModelSnapshot,versions:Record<string,number>,staged?:SealedModelKey,revision=this.latest()):void {
    const refs=new Set(snapshot.roles.filter(role=>!role.disabled&&!role.read_only).flatMap(role=>{
      let selected=role;for(;;){if(selected.disabled)return [];if(!selected.inherit_from)break;
        selected=snapshot.roles.find(candidate=>candidate.profile===role.profile&&candidate.id===selected.inherit_from)!;}
      return [selected.provider_ref,...role.ordered_fallbacks.map(route=>route.provider_ref)].map(id=>snapshot.providers.find(p=>p.id===id)?.credential_ref).filter((ref):ref is string=>typeof ref==='string');}));
    for(const ref of refs){const version=versions[ref];check(version!==undefined&&version>0&&(staged?.ref===ref?staged.version===version:this.credentialConfigured(ref,version,revision)),'MODEL_SETTINGS_KEY_REENTRY_REQUIRED',409);}
  }
  cached(source:Actor,id:string,nonce:string,fingerprint?:string){
    const row=this.db.prepare('SELECT draft,fingerprint,body FROM model_receipts WHERE principal=? AND device=? AND nonce=?').get(source.principal_id,source.device_id,nonce) as {draft:string;fingerprint:string|null;body:string}|undefined;
    if(!row)return undefined;check(row.draft===id&&(row.fingerprint??undefined)===fingerprint,'MODEL_SETTINGS_NONCE_CONFLICT',409);return JSON.parse(row.body) as ReturnType<ModelSettingsAuthority['read']>;
  }
  commitDraft(source:Actor,id:string,nonce:string,fingerprint?:string){
    const cached=this.cached(source,id,nonce,fingerprint);if(cached)return cached;
    const draft=this.getDraft(source,id);check(draft.expires_at_ms>this.now(),'MODEL_SETTINGS_DRAFT_EXPIRED',409);
    check(draft.expected_revision===this.latest(),'MODEL_SETTINGS_REVISION_CONFLICT',409);
    if(['commit','undo','set_key'].includes(draft.action))this.requireKeys(draft.snapshot,draft.versions,draft.sealed_key);
    let purged=false;const result=inTransaction(this.db,()=>{
      const next={revision:draft.revision,snapshot:draft.snapshot,versions:draft.versions};
      this.db.prepare('INSERT INTO model_revisions VALUES(?,?,?,?,?)').run(draft.revision,draft.expected_revision,canonical(next),canonical({...source,action:draft.action,draft_id:id,change_sha256:draft.change_sha256,nonce}),new Date(this.now()).toISOString());
      if(['commit','undo','set_key'].includes(draft.action)){
        const previous=this.revision(draft.expected_revision);
        for(const group of ['brain','build'] as const){
          const before=canonical(this.groupFacts(previous,group)),after=canonical(this.groupFacts(draft,group));
          if(before!==after){
            this.db.prepare("UPDATE model_groups SET desired=?,status='pending',error=NULL WHERE name=?").run(draft.revision,group);
            for(const ref of Object.keys(this.groupFacts(draft,group).versions))this.vault.untested(ref);
          }
        }
      }
      this.options.onAction?.(draft);
      purged=this.promoteKeys();
      const receipt=this.read();this.db.prepare('INSERT INTO model_receipts VALUES(?,?,?,?,?,?)').run(source.principal_id,source.device_id,nonce,id,fingerprint??null,canonical(receipt));return receipt;
    });
    if(purged)this.checkpointPendingKeys();this.changed();return purged?this.read():result;
  }
  async activateIdle(group:Group,idle:boolean):Promise<GroupState>{
    const current=this.read().groups[group];check(current,'MODEL_SETTINGS_GROUP_UNKNOWN');
    if(!idle||current.desired===current.effective)return current;
    const existing=this.activating.get(group);if(existing)return existing;
    const work=(async()=>{
      this.db.prepare("UPDATE model_groups SET status='applying',error=NULL WHERE name=?").run(group);this.changed();
      try{
        check(this.options.activate,'MODEL_SETTINGS_ACTIVATOR_UNAVAILABLE',503);
        await this.options.activate(group,current.desired,this);
        const purged=inTransaction(this.db,()=>{
          this.db.prepare("UPDATE model_groups SET effective=?,status=CASE WHEN desired=? THEN 'effective' ELSE 'pending' END,error=NULL WHERE name=?").run(current.desired,current.desired,group);
          return this.promoteKeys();});
        if(purged)this.checkpointPendingKeys();
        try{this.options.onEffective?.(group,current.desired,this);}
        catch{this.db.prepare('UPDATE model_groups SET error=? WHERE name=?').run('MODEL_SETTINGS_PROJECTION_PUBLISH_FAILED',group);}
      }catch(error){
        const pending=(error as {code?:string}).code==='MODEL_SETTINGS_BUSY';
        this.db.prepare('UPDATE model_groups SET status=?,error=? WHERE name=?').run(pending?'pending':'failed',pending?null:'MODEL_SETTINGS_ACTIVATION_FAILED',group);
      }finally{this.activating.delete(group);this.changed();}
      return this.read().groups[group];
    })();this.activating.set(group,work);return work;
  }
  async testConnection(source:Actor,request:{draft_id:string;profile:string;role:string}){
    const draft=this.getDraft(source,request.draft_id);check(draft.expires_at_ms>this.now(),'MODEL_SETTINGS_DRAFT_EXPIRED',409);
    const role=draft.snapshot.roles.find(role=>role.profile===request.profile&&role.id===request.role);check(role&&!role.disabled,'MODEL_SETTINGS_ROLE_UNAVAILABLE');
    let route=role;while(route.inherit_from)route=draft.snapshot.roles.find(candidate=>candidate.profile===request.profile&&candidate.id===route.inherit_from)!;
    const provider=draft.snapshot.providers.find(provider=>provider.id===route.provider_ref)!;
    check(provider.credential_ref,'MODEL_SETTINGS_KEY_REQUIRED');const version=draft.versions[provider.credential_ref]!;
    const key=this.vault.reveal(provider.credential_ref,version,draft.sealed_key?.ref===provider.credential_ref?draft.sealed_key:this.staged(provider.credential_ref,version,draft.revision));
    const usage=this.options.probeUsage?.(),trace_id=randomUUID();
    const attempt:UsageAttempt={attempt_id:trace_id,request_id:trace_id,environment:this.environment_id,owner:source.principal_id,
      provider_id:provider.id,model_id:route.model_id!,role:role.id,revision:String(draft.expected_revision),owner_chat:false,
      captured_at:new Date(this.now()).toISOString(),status:'started',input_tokens:null,output_tokens:null,
      cost:{kind:'unknown',amount:null,currency:'CNY'},credential_version:version,original_usage:{},
      source_context:{kind:'settings_probe',draft_id:draft.draft_id,change_sha256:draft.change_sha256,...source}};
    if(usage){check(usage.admission(this.environment_id,source.principal_id,false).allowed,'MODEL_USAGE_PAUSED',409);await usage.record(attempt);}
    let result:Awaited<ReturnType<typeof probeModelConnection>>;
    try{result=await (this.options.probe??probeModelConnection)({provider,model_id:route.model_id!,parameters:{...route.parameters,...role.parameters},key,...(this.options.allow_private_hosts?{allow_private_hosts:this.options.allow_private_hosts}:{}),trace_id});}
    catch(error){if(usage)await usage.record({...attempt,status:'failed'});throw error;}
    const read=result.usage?.cached_tokens??result.usage?.cache_read_input_tokens,write=result.usage?.cache_creation_input_tokens;
    if(usage)await usage.record({...attempt,status:result.status==='passed'?'completed':'failed',
      input_tokens:result.usage?.input_tokens??result.usage?.prompt_tokens??null,
      output_tokens:result.usage?.output_tokens??result.usage?.completion_tokens??null,
      ...(read!==undefined?{cache_read_tokens:read}:{}),...(write!==undefined?{cache_write_tokens:write}:{}),
      original_usage:result.usage??{}},defaultCacheWriteBilling(provider,route.model_id!));
    const current=this.revision(this.latest());
    if(canonical(draft.snapshot)===canonical(current.snapshot)&&canonical(draft.versions)===canonical(current.versions))
      this.vault.tested(provider.credential_ref,version,result.status==='passed'?'passed':'failed');
    return {...result,probe_revision:draft.expected_revision,draft_id:draft.draft_id,change_sha256:draft.change_sha256};
  }
  async catalog(source:Actor,request:{draft_id:string;provider_ref:string;offset?:number}){
    const draft=this.getDraft(source,request.draft_id);check(draft.expires_at_ms>this.now(),'MODEL_SETTINGS_DRAFT_EXPIRED',409);
    const provider=draft.snapshot.providers.find(provider=>provider.id===request.provider_ref);check(provider,'MODEL_SETTINGS_PROVIDER_UNKNOWN',404);
    let key='';
    if(provider.catalog_capability!=='unavailable'&&provider.wire_protocol!=='local_onnx'&&provider.credential_ref){
      const ref=provider.credential_ref,version=draft.versions[ref]!;
      key=this.vault.reveal(ref,version,draft.sealed_key?.ref===ref?draft.sealed_key:this.staged(ref,version,draft.revision));
    }
    const result=await fetchModelCatalog({provider,key,...(this.options.allow_private_hosts?{allow_private_hosts:this.options.allow_private_hosts}:{}),now:this.now});
    const offset=request.offset??0;
    check(Number.isSafeInteger(offset)&&offset>=0&&(result.status!=='available'||offset<=result.models.length),'MODEL_SETTINGS_PAGE_INVALID');
    const page={...result,models:[] as typeof result.models,next_offset:null as number|null,
      draft_id:draft.draft_id,change_sha256:draft.change_sha256,provider_ref:provider.id,credential_ref:provider.credential_ref,
      credential_version:provider.credential_ref?draft.versions[provider.credential_ref]??0:null};
    for(let index=offset;index<result.models.length&&page.models.length<16;index++){
      const next={...page,models:[...page.models,result.models[index]!],next_offset:index+1<result.models.length?index+1:null};
      if(Buffer.byteLength(JSON.stringify(next))>8000){check(page.models.length>0,'MODEL_SETTINGS_ROW_TOO_LARGE',413);break;}
      page.models=next.models;page.next_offset=next.next_offset;
    }
    return page;
  }
}
