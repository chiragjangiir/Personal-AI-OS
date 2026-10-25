import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readBody} from './http-body.ts';
import {check,ContractError} from './contracts.ts';
import type {PersonalAIOSRuntime} from './runtime.ts';

/** Inference-service transport. Agent MCP credentials never authorize these routes. */
export async function handleModelSettingsHttp(request:IncomingMessage,response:ServerResponse,runtime:PersonalAIOSRuntime,
  serviceToken:string,maxBytes:number):Promise<boolean> {
  const path=new URL(request.url??'/','http://localhost').pathname;
  if(!path.startsWith('/internal/model-settings/'))return false;
  let status=200,result:unknown;
  try{
    const supplied=Buffer.from(request.headers.authorization??''),expected=Buffer.from(`Bearer ${serviceToken}`);
    check(serviceToken.length>=24&&supplied.length===expected.length&&timingSafeEqual(supplied,expected),'MODEL_SETTINGS_SERVICE_AUTH_REQUIRED',401);
    check(request.method==='POST','METHOD_NOT_ALLOWED',405);
    check(['credential','usage','admission'].some(name=>path===`/internal/model-settings/${name}`),'ROUTE_NOT_FOUND',404);
    let body:unknown;
    try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBody(request,maxBytes)));}
    catch(error){if(error instanceof ContractError)throw error;throw new ContractError('INVALID_REQUEST_JSON');}
    check(body&&typeof body==='object'&&!Array.isArray(body),'REQUEST_OBJECT_REQUIRED');
    const value=body as Record<string,unknown>,authority=runtime.modelSettingsAuthority;
    check(authority,'MODEL_SETTINGS_UNAVAILABLE',503);
    if(path.endsWith('/usage')){await runtime.recordModelWireAttempt(value);result={recorded:true};}
    else if(path.endsWith('/admission'))result=await runtime.modelUsageAdmission(value);
    else{
      const fields=['environment_id','profile','revision','handle'];
      check(Object.keys(value).length===fields.length&&Object.keys(value).every(key=>fields.includes(key))&&
        value.environment_id===authority.environment_id&&typeof value.profile==='string'&&Number.isSafeInteger(value.revision)&&Number(value.revision)>0,
        'MODEL_SETTINGS_SERVICE_REQUEST_INVALID');
      check(typeof value.handle==='string','MODEL_SETTINGS_SERVICE_REQUEST_INVALID');
      result={key:authority.credential(value as {environment_id:string;profile:string;revision:number;handle:string})};
    }
  }catch(error){
    const known=error instanceof ContractError,code=known?error.code:error instanceof Error&&/^USAGE_[A-Z_]+$/u.test(error.message)?error.message:'MODEL_SETTINGS_SERVICE_FAILED';
    status=known?error.status:code.startsWith('USAGE_')?400:500;result={error:{code}};
  }
  response.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(result));return true;
}
