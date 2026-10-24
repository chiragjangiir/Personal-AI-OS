import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer,request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {handleWatchHttp,isWatchHttpRoute,type WatchHttpOwner} from '../src/watch-http.ts';
import {isRealtimePublicControlRoute} from '../src/realtime-public-control-controller.ts';
import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';

const turn=randomUUID(),token='a'.repeat(43);
const metadata={'X-Watch-Turn-ID':turn,'X-Watch-Codec':'aac_lc','X-Watch-Sample-Rate-Hz':'16000',
  'X-Watch-Channels':'1','X-Watch-Duration-Ms':'1000','Content-Type':'audio/mp4',Authorization:`Bearer ${token}`};
const context={source:{device_id:randomUUID(),principal_id:randomUUID()} as never,session:'owner-session',pairVersion:'2'};
async function fixture(run:(base:string,owner:WatchHttpOwner)=>Promise<void>,overrides:Partial<WatchHttpOwner>={}){
  const owner:WatchHttpOwner={credential:async()=>({status:'revoked',watch_device_id:randomUUID(),installation_id:randomUUID(),pair_version:'2'}),
    authenticate:async value=>{assert.equal(value,token);return context;},
    utterance:async()=>({status:'heard',turn_id:turn,heard:'first'}),turn:async()=>({status:'working',turn_id:turn}),...overrides};
  const errors:unknown[]=[];
  const server=createServer((request,response)=>{void handleWatchHttp(request,response,owner,async()=>{},error=>{errors.push(error);});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await run(`http://127.0.0.1:${(server.address() as {port:number}).port}`,owner);assert.deepEqual(errors,[]);}
  finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
const post=(base:string,headers=metadata,body:Uint8Array=new Uint8Array([1,2,3]))=>fetch(base+'/v1/watch/utterances',{method:'POST',headers,body});

test('direct Watch routes are registered at the public edge, including strict-query rejection targets',()=>{
  const edge=readFileSync(new URL('../../../../../deploy/tencent/nginx/paios-ai-roaming.conf',import.meta.url),'utf8');
  assert.ok(edge.includes('"HTTP/2.0:POST:/v1/realtime/watch-binding/credential" 1;'));
  assert.ok(edge.includes('location = /v1/realtime/watch-binding/credential {'));
  assert.ok(edge.includes('location = /v1/watch/utterances {'));
  assert.ok(edge.includes('location ~ ^/v1/watch/turns/[^/]+$ {'));
  assert.ok(edge.includes('client_max_body_size 1000000;'));
  for(const header of ['Turn-ID','Codec','Sample-Rate-Hz','Channels','Duration-Ms'])assert.ok(edge.includes(`proxy_set_header X-Watch-${header} $http_x_watch_${header.toLowerCase().replaceAll('-','_')};`));
  for(const [method,path] of [['POST','/v1/watch/utterances'],['POST','/v1/realtime/watch-binding/credential'],['GET',`/v1/watch/turns/${turn}?wait=25`],['GET',`/v1/watch/turns/${turn}?wait=25&principal=forged`]]){
    assert.equal(isWatchHttpRoute(method,path!),true);assert.equal(isRealtimePublicControlRoute(method,path!),true);
  }
  assert.equal(isWatchHttpRoute('POST',`/v1/watch/turns/${turn}`),false);
});
test('upload preserves actual bytes and converts only frozen metadata',async()=>fixture(async base=>{
  const reply=await post(base);assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{status:'heard',turn_id:turn,heard:'first'});
},{utterance:async(auth,id,fields,bytes)=>{
  assert.equal(auth,context);assert.equal(id,turn);assert.deepEqual(fields,{codec:'aac_lc',sample_rate_hz:16000,channels:1,duration_ms:1000,mime:'audio/mp4'});
  assert.deepEqual(Buffer.from(bytes),Buffer.from([1,2,3]));return {status:'heard',turn_id:turn,heard:'first'};
}}));
test('missing, malformed and authority-rejected credentials use frozen failures',async()=>fixture(async base=>{
  for(const [authorization,reason,status] of [[undefined,'credential_missing',401],['wrong','credential_invalid',401],[`Bearer ${token}`,'credential_revoked',403]] as const){
    const headers:Record<string,string>={...metadata};delete headers.Authorization;if(authorization)headers.Authorization=authorization;
    const reply=await post(base,headers as typeof metadata);assert.equal(reply.status,status);assert.deepEqual(await reply.json(),{status:'failed',reason});
  }
},{authenticate:async()=>{throw Object.assign(new Error('credential_revoked'),{reason:'credential_revoked'});}}));
test('actual chunked byte count is bounded even without content-length',async()=>fixture(async base=>{
  const reply=await new Promise<{status:number;body:unknown}>((resolve,reject)=>{
    const req=httpRequest(base+'/v1/watch/utterances',{method:'POST',headers:metadata},res=>{
      let text='';res.on('data',bytes=>text+=bytes);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(text)}));});
    req.on('error',reject);req.write(Buffer.alloc(600_000));req.end(Buffer.alloc(400_001));
  });
  assert.equal(reply.status,413);assert.deepEqual(reply.body,{status:'failed',turn_id:turn,reason:'audio_too_large'});
},{utterance:async()=>{assert.fail('oversize must not reach media owner');}}));
test('empty and invalid wire metadata fail before media; no-speech owner failure survives framing',async()=>fixture(async base=>{
  for(const [headers,bytes,reason,status] of [[metadata,new Uint8Array(),'audio_invalid',422],
    [{...metadata,'X-Watch-Channels':'2'},new Uint8Array([1]),'invalid_request',400],
    [{...metadata,'X-Watch-Codec':'mp3'},new Uint8Array([1]),'codec_unsupported',415],
    [metadata,new Uint8Array([1]),'not_heard',422]] as const){
    const reply=await post(base,headers as typeof metadata,bytes);assert.equal(reply.status,status);assert.equal((await reply.json() as {reason:string}).reason,reason);
  }
},{utterance:async()=>({status:'failed',turn_id:turn,reason:'not_heard'})}));
test('turn GET forwards authenticated context and rejects extra or duplicate query keys',async()=>fixture(async base=>{
  for(const query of ['wait=25&principal=forged','wait=25&wait=25','wait=24']){
    const reply=await fetch(base+`/v1/watch/turns/${turn}?${query}`,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(reply.status,400);assert.equal((await reply.json() as {reason:string}).reason,'invalid_request');
  }
  const reply=await fetch(base+`/v1/watch/turns/${turn}?wait=25`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{status:'working',turn_id:turn});
},{turn:async(auth,id)=>{assert.equal(auth,context);assert.equal(id,turn);return {status:'working',turn_id:id};}}));
test('disconnect aborts only the result wait supplied to its owner',async()=>{
  const attached=Promise.withResolvers<void>(),released=Promise.withResolvers<void>();
  await fixture(async base=>{
    const cancel=new AbortController();const pending=fetch(base+`/v1/watch/turns/${turn}?wait=25`,{headers:{Authorization:`Bearer ${token}`},signal:cancel.signal});
    await attached.promise;cancel.abort();await assert.rejects(pending);await released.promise;
  },{turn:async(_auth,id,signal)=>{attached.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{released.resolve();resolve();},{once:true}));return {status:'working',turn_id:id};}});
});
test('credential endpoint rejects caller-selected identity and returns frozen owner outcomes',async()=>fixture(async base=>{
  const input={action:'revoke',watch_device_id:randomUUID(),installation_id:randomUUID(),expected_pair_version:'2',request_id:randomUUID()};
  const send=(value:unknown)=>fetch(base+'/v1/realtime/watch-binding/credential',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
  const denied=await send({...input,principal:'forged'});assert.equal(denied.status,400);
  const accepted=await send(input);assert.equal(accepted.status,200);assert.equal((await accepted.json() as {status:string}).status,'revoked');
},{credential:async(value,input)=>{assert.equal(value,token);assert.equal(input.action,'revoke');return {status:'revoked',watch_device_id:input.watch_device_id,installation_id:input.installation_id,pair_version:'2'};}}));
test('runtime conflict remains HTTP 409 and never changes turn identity',async()=>fixture(async base=>{
  const reply=await post(base);assert.equal(reply.status,409);assert.deepEqual(await reply.json(),{status:'failed',turn_id:turn,reason:'turn_conflict'});
},{utterance:async()=>{throw new ContractError('turn_conflict',409);}}));
