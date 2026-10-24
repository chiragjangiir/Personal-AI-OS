import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {readFileSync} from 'node:fs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {ContractError,check} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';

export interface WatchHttpContext {source:RegisteredDevice;session:string;pairVersion:string}
export interface WatchAudioMetadata {codec:string;sample_rate_hz:number;channels:number;duration_ms:number;mime:string}
export interface WatchHttpOwner {
  credential(token:string,input:Record<string,unknown>):Promise<unknown>;
  authenticate(token:string):Promise<WatchHttpContext>;
  utterance(context:WatchHttpContext,turn:string,metadata:WatchAudioMetadata,bytes:Uint8Array):Promise<unknown>;
  turn(context:WatchHttpContext,turn:string,signal:AbortSignal):Promise<unknown>;
}
const wire=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/watch-http.v1.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
addFormats.default(ajv,['uuid','date-time']);
const validate=(name:string)=>ajv.compile({$ref:`#/$defs/${name}`,$defs:wire.$defs});
const metadataValid=validate('utterance_metadata'),credentialValid=validate('credential_request');
const uploadValid=validate('utterance_response'),turnValid=validate('turn_response'),credentialResponseValid=validate('credential_response');
const uuid=ajv.compile({type:'string',format:'uuid'});
const headers=Object.keys(wire.$defs.utterance_metadata.properties) as string[];
const statuses:Record<string,number>={invalid_request:400,credential_missing:401,credential_invalid:401,credential_expired:401,
  credential_revoked:403,watch_unregistered:403,watch_scope_denied:403,turn_not_found:404,turn_conflict:409,
  pair_version_conflict:409,request_conflict:409,audio_too_large:413,audio_too_long:413,codec_unsupported:415,
  audio_invalid:422,not_heard:422,busy:429,service_unavailable:503,processing_failed:502};
export function isWatchHttpRoute(method:string|undefined,target:string):boolean {
  const path=target.split('?')[0];
  return method==='POST'&&(path==='/v1/watch/utterances'||path==='/v1/realtime/watch-binding/credential')||
    method==='GET'&&/^\/v1\/watch\/turns\/[^/?]+$/.test(path!);
}
function header(request:IncomingMessage,name:string):string|undefined {
  const values=request.rawHeaders.filter((_,i)=>i%2===1&&request.rawHeaders[i-1]!.toLowerCase()===name);
  check(values.length<=1,'invalid_request',400);return values[0];
}
function bearer(request:IncomingMessage):string {
  const value=header(request,'authorization');check(value,'credential_missing',401);
  check(/^Bearer [A-Za-z0-9._~-]+$/.test(value)&&value.length<=4096,'credential_invalid',401);return value.slice(7);
}
async function body(request:IncomingMessage,max:number,tooLarge='audio_too_large'):Promise<Buffer> {
  const length=header(request,'content-length');
  check(length===undefined||/^(0|[1-9][0-9]*)$/.test(length),'invalid_request',400);
  check(length===undefined||Number(length)<=max,tooLarge,tooLarge==='invalid_request'?400:413);
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of request.iterator({destroyOnReturn:false})){
    const value=Buffer.from(chunk);bytes+=value.length;check(bytes<=max,tooLarge,tooLarge==='invalid_request'?400:413);chunks.push(value);
  }
  return Buffer.concat(chunks,bytes);
}
/** HTTP framing only. Identity, archive, media, admission and result lifetime stay with their owners. */
export async function handleWatchHttp(request:IncomingMessage,response:ServerResponse,owner:WatchHttpOwner,
  authorize:()=>Promise<void>,onError:(error:unknown)=>void):Promise<void> {
  let turn:string|undefined;
  const cancel=new AbortController(),disconnect=()=>cancel.abort();
  response.once('close',disconnect);
  const send=(status:number,value:unknown)=>{if(!response.destroyed&&!response.writableEnded){
    response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));}};
  try {
    await authorize();const token=bearer(request),url=new URL(request.url!,'http://watch.invalid');
    let result:unknown,valid:ReturnType<typeof validate>;
    if(url.pathname==='/v1/realtime/watch-binding/credential'){
      check(url.search===''&&header(request,'content-type')==='application/json','invalid_request',400);
      let input:unknown;try{input=JSON.parse((await body(request,8192,'invalid_request')).toString('utf8'));}
      catch(error){if(error instanceof SyntaxError)throw new ContractError('invalid_request',400);throw error;}
      check(credentialValid(input),'invalid_request',400);
      result=await owner.credential(token,input as Record<string,unknown>);valid=credentialResponseValid;
    }else {
      const context=await owner.authenticate(token);
      if(request.method==='POST'){
        check(url.search==='','invalid_request',400);
        const metadata=Object.fromEntries(headers.map(name=>[name,header(request,name)]));
        if(uuid(metadata['x-watch-turn-id']))turn=metadata['x-watch-turn-id'];
        check(metadata['x-watch-codec']==='aac_lc'&&metadata['content-type']==='audio/mp4','codec_unsupported',415);
        check(!/^[1-9][0-9]*$/.test(metadata['x-watch-duration-ms']??'')||Number(metadata['x-watch-duration-ms'])<=30000,'audio_too_long',413);
        check(metadataValid(metadata),'invalid_request',400);
        turn=metadata['x-watch-turn-id']!;
        const bytes=await body(request,wire.transport.utterance.max_body_bytes);check(bytes.length>0,'audio_invalid',422);
        result=await owner.utterance(context,turn,{codec:metadata['x-watch-codec']!,mime:metadata['content-type']!,
          sample_rate_hz:Number(metadata['x-watch-sample-rate-hz']),channels:Number(metadata['x-watch-channels']),
          duration_ms:Number(metadata['x-watch-duration-ms'])},bytes);valid=uploadValid;
      }else {
        const id=url.pathname.slice('/v1/watch/turns/'.length);
        check(uuid(id)&&url.search==='?wait=25','invalid_request',400);turn=id;
        check(!header(request,'transfer-encoding')&&(!header(request,'content-length')||header(request,'content-length')==='0'),'invalid_request',400);
        result=await owner.turn(context,turn,cancel.signal);valid=turnValid;
      }
    }
    check(valid(result),'service_unavailable',503);
    const failure=result as {status?:string;reason?:string};send(failure.status==='failed'?statuses[failure.reason!]!:200,result);
  }catch(error){
    const code=(error as {reason?:string})?.reason??(error as {code?:string})?.code;
    const status=(error as {status?:number})?.status;
    const reason=code&&Object.hasOwn(statuses,code)?code:status===401?'credential_invalid':status===403?'watch_scope_denied':'service_unavailable';
    if(reason==='service_unavailable')onError(error);
    request.resume();send(statuses[reason]!,{status:'failed',...(turn?{turn_id:turn}:{}),reason});
  }finally {response.off('close',disconnect);}
}
