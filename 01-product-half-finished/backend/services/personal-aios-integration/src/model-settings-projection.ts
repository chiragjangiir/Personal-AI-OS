import {mkdirSync,writeFileSync,readFileSync,existsSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {canonical,check,sha256} from './contracts.ts';
import type {ModelSettingsAuthority} from './model-settings.ts';
import {auxiliaryModelRoles,type ModelParameters,type ModelResolution,type ModelProvider} from './model-settings-contract.ts';

const keyName=(ref:string)=>`PAIOS_MODEL_KEY_${sha256(ref).slice(0,24).toUpperCase()}`;
function requestParameters(parameters:ModelParameters):Record<string,unknown> {
  return {...(parameters.max_output_tokens===undefined?{}:{max_tokens:parameters.max_output_tokens}),
    ...(parameters.temperature===undefined?{}:{temperature:parameters.temperature}),
    ...(parameters.thinking?{thinking:{type:parameters.thinking.enabled?'enabled':'disabled',
      ...(parameters.thinking.budget===undefined?{}:{budget_tokens:parameters.thinking.budget})}}:{}),
    ...(parameters.reasoning_effort?{reasoning_effort:parameters.reasoning_effort}:{})};
}
function sdkOverrides(parameters:ModelParameters):Record<string,unknown> {
  const {thinking,...standard}=requestParameters(parameters);
  return {...standard,...(thinking?{extra_body:{thinking}}:{})};
}
/** Converts resolved facts to native Hermes fields; it never resolves or executes fallback. */
export function projectModelSettings(authority:ModelSettingsAuthority,profile:string,revision:number,group:'brain'|'build'){
  check(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profile)&&Number.isSafeInteger(revision)&&revision>=0,'MODEL_SETTINGS_PROJECTION_INVALID');
  const snapshot=authority.readRevision(revision).snapshot,providers:Record<string,Record<string,unknown>>={},bindings=new Map<string,{name:string;handle:string}>();
  let configured=true;
  const credential=(provider:ModelProvider,handle?:string,version?:number)=>{
    if(provider.credential_ref===null)return {};
    const name=keyName(provider.credential_ref);check(handle,'MODEL_SETTINGS_CREDENTIAL_HANDLE_REQUIRED');bindings.set(name,{name,handle});
    if(!version||!authority.credentialConfigured(provider.credential_ref,version,revision))configured=false;return {key_env:name};
  };
  const route=(resolution:Pick<ModelResolution,'provider'|'model_id'|'parameters'|'credential_handle'|'credential_version'>)=>{
    const provider=resolution.provider!,body=requestParameters(resolution.parameters),binding=credential(provider,resolution.credential_handle,resolution.credential_version);
    if(!providers[provider.id])providers[provider.id]={api:provider.base_url,transport:provider.wire_protocol,...binding,
      ...(resolution.parameters.context_limit?{context_length:resolution.parameters.context_limit}:{}),
      ...(Object.keys(body).length?{extra_body:body}:{}),...(provider.session_affinity?{session_affinity_header:provider.session_affinity}:{})};
    return {provider:provider.id,model:resolution.model_id!,base_url:provider.base_url,api_mode:provider.wire_protocol,...binding,
      ...(Object.keys(body).length?{request_overrides:sdkOverrides(resolution.parameters)}:{}),...(resolution.parameters.context_limit?{context_length:resolution.parameters.context_limit}:{})};
  };
  const resolved=snapshot.roles.filter(role=>role.profile===profile&&role.activation_boundary===(group==='brain'?'brain_idle':'build_idle'))
    .map(role=>authority.resolve(authority.environment_id,profile,role.id,revision));
  const main=resolved.find(role=>role.role==='brain'||role.role==='build.workshop');
  const config:Record<string,unknown>={model:{enabled:false},providers,fallback_providers:[],
    delegation:{enabled:false,max_concurrent_children:3,max_spawn_depth:2,oneshot_max_children:0,child_timeout_seconds:0},
    auxiliary:{transient_retries:2,...Object.fromEntries([...auxiliaryModelRoles,'call_intent'].map(role=>[role,{enabled:false}])),
      title_generation:{enabled:false,model_upgrade_enabled:false}},
    cron:{enabled:false,wrap_response:false,allowed_scripts:['personal-aios-reminder.py','personal-aios-task.py']}};
  const native=(value:ModelResolution)=>({...route(value),fallback_providers:value.ordered_fallbacks.map(routeValue=>route({provider:routeValue.provider,model_id:routeValue.model_id,
    parameters:routeValue.parameters,...(routeValue.credential_handle?{credential_handle:routeValue.credential_handle}:{}),...(routeValue.credential_version===undefined?{}:{credential_version:routeValue.credential_version})}))});
  if(!main||main.disabled)configured=false;
  else{
    check(main.parameters.context_limit!==undefined&&main.parameters.max_output_tokens!==undefined,'MODEL_SETTINGS_MODEL_BUDGET_REQUIRED',409);
    const primary=native(main),{model:modelId,...modelConfig}=primary;
    config.model={...modelConfig,default:modelId};delete (config.model as Record<string,unknown>).fallback_providers;
    config.fallback_providers=primary.fallback_providers;
    for(const value of resolved.filter(value=>value!==main)){
      if(value.role.startsWith('auxiliary.')||value.role==='call.intent'){
        const auxiliary=(resolution:ModelResolution)=>{
          const {request_overrides,fallback_providers,...selection}=native(resolution);
          return {...selection,role_id:resolution.role,extra_body:requestParameters(resolution.parameters),fallback_chain:resolution.ordered_fallbacks.map(fallback=>{
            const {request_overrides,...selection}=route({provider:fallback.provider,model_id:fallback.model_id,parameters:fallback.parameters,
              ...(fallback.credential_handle?{credential_handle:fallback.credential_handle}:{}),...(fallback.credential_version===undefined?{}:{credential_version:fallback.credential_version})});
            return {...selection,extra_body:requestParameters(fallback.parameters)};})};
        };
        (config.auxiliary as Record<string,unknown>)[value.role==='call.intent'?'call_intent':value.role.slice(10)]=value.disabled?
          {enabled:false,...(value.role==='auxiliary.title_generation'?{model_upgrade_enabled:false}:{})}:auxiliary(value);
      }
      else if(value.role==='delegation')config.delegation={...config.delegation as object,...(value.disabled?{enabled:false}:{enabled:true,...native(value)})};
      else if(value.role==='cron')config.cron={...config.cron as object,...(value.disabled?{enabled:false}:{enabled:true,...native(value),model_provider:value.provider!.id})};
      else if(value.role==='build.repair'&&!value.disabled)config.workshop={repair:native(value)};
    }
  }
  return {environment_id:authority.environment_id,profile,revision,group,config,credentials:[...bindings.values()],configured};
}
/** Immutable revision files are prepared before native activation. Only its acknowledgement publishes current. */
export function writeModelSettingsProjection(authority:ModelSettingsAuthority,directory:string,profile:string,revision:number,group:'brain'|'build',publish=false){
  const projection=projectModelSettings(authority,profile,revision,group),bytes=canonical(projection)+'\n';
  const target=join(directory,'revisions',String(revision),profile+'.json');mkdirSync(join(directory,'revisions',String(revision)),{recursive:true,mode:0o700});
  if(existsSync(target))check(readFileSync(target,'utf8')===bytes,'MODEL_SETTINGS_PROJECTION_IMMUTABLE',409);
  else writeFileSync(target,bytes,{mode:0o400,flag:'wx'});
  if(publish){const current=join(directory,group==='brain'?'current.json':'build-current.json'),pending=current+'.'+randomUUID()+'.pending';
    try{writeFileSync(pending,bytes,{mode:0o400,flag:'wx'});renameSync(pending,current);}finally{rmSync(pending,{force:true});}}
  return projection;
}
