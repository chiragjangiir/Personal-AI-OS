import {check} from './contracts.ts';
import type {ModelProvider} from './model-settings-contract.ts';
import {validateModelDestination} from './model-settings-probe.ts';

interface CatalogInput {provider:ModelProvider;key:string;allow_private_hosts?:readonly string[];now?:()=>number}
/** Provider metadata only. Errors and upstream headers never enter the formal projection. */
export async function fetchModelCatalog(input:CatalogInput){
  const {provider,key}=input,fetched_at=new Date((input.now??Date.now)()).toISOString();
  const models:{id:string;display_name?:string}[]=[];
  const unavailable=()=>({status:'unavailable' as const,source:'provider_no_list',fetched_at,models,
    message:'服务商未提供模型列表，可填写模型 ID',safe_error:null});
  if(provider.catalog_capability==='unavailable'||provider.wire_protocol==='local_onnx')return unavailable();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10_000);
  try{
    await validateModelDestination(provider,input.allow_private_hosts);
    const anthropic=provider.wire_protocol==='anthropic_messages';
    const headers:Record<string,string>=anthropic?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:`Bearer ${key}`};
    let cursor:string|undefined,totalBytes=0;
    do{
      const url=new URL(provider.base_url.replace(/\/$/u,'')+'/models');
      if(anthropic){url.searchParams.set('limit','100');if(cursor)url.searchParams.set('after_id',cursor);}
      const response=await fetch(url,{headers,signal:controller.signal,redirect:'error'});
      if([404,405,501].includes(response.status)){await response.body?.cancel();return unavailable();}
      if(!response.ok){await response.body?.cancel();throw Error('MODEL_SETTINGS_CATALOG_REJECTED');}
      const reader=response.body!.getReader(),chunks:Uint8Array[]=[];
      try{for(;;){const part=await reader.read();if(part.done)break;totalBytes+=part.value.length;
        check(totalBytes<=2_097_152,'MODEL_SETTINGS_CATALOG_RESPONSE_LIMIT',502);chunks.push(part.value);}}
      finally{await reader.cancel();}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {data:unknown;has_more?:boolean;last_id?:unknown};
      check(Array.isArray(body.data),'MODEL_SETTINGS_CATALOG_RESPONSE_INVALID',502);
      for(const row of body.data){
        check(row&&typeof row==='object'&&typeof row.id==='string'&&row.id.length>0&&row.id.length<=200&&!/[\x00-\x1f\x7f]/u.test(row.id)&&(!key||!row.id.includes(key)),'MODEL_SETTINGS_CATALOG_RESPONSE_INVALID',502);
        const name=row.display_name;
        models.push({id:row.id,...(typeof name==='string'&&name.length<=200&&!/[\x00-\x1f\x7f]/u.test(name)&&(!key||!name.includes(key))?{display_name:name}:{})});
      }
      if(anthropic&&body.has_more){
        check(typeof body.last_id==='string'&&body.last_id.length>0&&body.last_id!==cursor,'MODEL_SETTINGS_CATALOG_RESPONSE_INVALID',502);cursor=body.last_id;
      }else cursor=undefined;
    }while(cursor);
    return {status:'available' as const,source:'provider_models_api',fetched_at,models,message:null,safe_error:null};
  }catch{
    return {status:'failed' as const,source:'provider_models_api',fetched_at,models:[] as typeof models,message:null,
      safe_error:controller.signal.aborted?'MODEL_SETTINGS_CATALOG_TIMEOUT':'MODEL_SETTINGS_CATALOG_FAILED'};
  }finally{clearTimeout(timeout);}
}
