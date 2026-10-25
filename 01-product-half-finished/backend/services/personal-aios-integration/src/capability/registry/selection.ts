import {readFileSync} from 'node:fs';
import {readPackage} from './registry.ts';
import type {EnabledPackageAuthority,PackageVersion,PackageContext} from './interfaces.ts';
import type {StoragePort} from '../../storage.ts';
import type {HermesClient} from '../../hermes-client.ts';
import type {CapabilityGateway} from '../gateway.ts';
import {mcpIdentity,type PackageTool} from '../packages.ts';
import {canonical,check,digest} from '../../contracts.ts';

/** The live projection of capability_packages. Registration owns evidence; this owner owns enabled CAS and transports. */
export class EnabledPackages implements EnabledPackageAuthority {
  private tail:Promise<unknown>=Promise.resolve();
  private storage:StoragePort;private gateway:CapabilityGateway;private native:HermesClient;
  private builtins:PackageVersion[];
  constructor(storage:StoragePort,gateway:CapabilityGateway,native:HermesClient){
    this.storage=storage;this.gateway=gateway;this.native=native;
    this.builtins=[...new Set([...gateway.tools.values()].map(row=>row.package))].map(name=>{
      const root=new URL(`../../../../../../../capability/packages/${name}/`,import.meta.url);
      const manifest=JSON.parse(readFileSync(new URL('plugin.json',root),'utf8'));
      return {name,version:manifest.version,digest:digest(manifest),root:root.pathname,manifest};
    });
  }
  private key(principal:string){return digest(principal);}
  private async state(principal:string):Promise<{principal:string;versions:PackageVersion[]}>{
    try{return JSON.parse(Buffer.from(await this.storage.read('capability-packages',this.key(principal))).toString());}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {principal,versions:[]};throw error;}
  }
  private async save(principal:string,versions:PackageVersion[]){
    await this.storage.replace!('capability-packages',this.key(principal),Buffer.from(canonical({principal,versions})));
  }
  private project(principal:string,versions:PackageVersion[]){
    for(const [name,tool] of this.gateway.tools)if(tool.principal_id===principal)this.gateway.tools.delete(name);
    for(const version of versions){
      const cap=version.manifest.extensions['ai.yimi.capability'];
      for(const [name,policy] of Object.entries(cap.tools)){
        const identity=mcpIdentity('yimi_shared',`${digest(principal).slice(0,8)}_${version.digest}_${version.name}__${name}`);
        this.gateway.tools.set(identity,{...policy as PackageTool,package:version.name,server:cap.runtime.server,name,
          scopes:cap.scopes,principal_id:principal,version_digest:version.digest,transport_name:identity});
      }
    }
  }
  async installed(principal:string){return this.enabled(principal);}
  async enabled(principal:string){return [...this.builtins,...(await this.state(principal)).versions];}
  async recover(){
    for(const key of await this.storage.list('capability-packages')){
      const state=JSON.parse(Buffer.from(await this.storage.read('capability-packages',key)).toString()) as {principal:string;versions:PackageVersion[]};
      for(const version of state.versions)await this.native.capability('package-prepare',{
        principal_id:state.principal,version,files:await readPackage(version.root)});
      await this.native.capability('package-activate',{principal_id:state.principal,sync:true,versions:state.versions});
      this.project(state.principal,state.versions);
    }
  }
  replace(context:PackageContext,change:{name:string;expected:string|null;next:PackageVersion|null}):Promise<void>{
    const work=this.tail.catch(()=>{}).then(async()=>{
      const principal=context.principal_id,state=await this.state(principal);
      const current=state.versions.find(row=>row.name===change.name);
      check((current?.digest??null)===change.expected,'ENABLED_PACKAGE_CHANGED',409);
      if(change.next)await this.native.capability('package-prepare',{principal_id:principal,version:change.next,files:await readPackage(change.next.root)});
      const next=state.versions.filter(row=>row.name!==change.name);if(change.next)next.push(change.next);
      // Persist even an empty first preimage, so restart recovery can remove an uncommitted host activation.
      await this.save(principal,state.versions);
      // During host replacement, no new call may run against a mismatched manifest version.
      this.project(principal,state.versions.filter(row=>row.name!==change.name));
      try{
        await this.native.capability('package-activate',{principal_id:principal,...change});
        await this.save(principal,next);
        this.project(principal,next);
      }catch(error){
        await this.native.capability('package-activate',{principal_id:principal,sync:true,versions:state.versions});
        this.project(principal,state.versions);throw error;
      }
    });
    this.tail=work;return work;
  }
}
