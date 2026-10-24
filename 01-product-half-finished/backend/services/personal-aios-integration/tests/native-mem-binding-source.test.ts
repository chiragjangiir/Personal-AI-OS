import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {HermesClient,decodeNativeRun} from '../src/hermes-client.ts';
import {RunAdmission} from '../src/admission.ts';
const memory=JSON.parse(await readFile(new URL('./fixtures/native-final-response/source-memory-wire.json',import.meta.url),'utf8'));
const final=JSON.parse(await readFile(new URL('./fixtures/native-final-response/native-proof.json',import.meta.url),'utf8'));
function client(value:unknown, profile?:string, limit=1048576){let calls=0,init:RequestInit|undefined;
 const fetcher:typeof fetch=async(_url,options)=>{calls++;init=options;return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});};
 return {native:new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',1000,limit,profile,fetcher),calls:()=>calls,init:()=>init};}
const scope={conversation_session_id:memory.conversation_session_id,profile_home:memory.profile_home};
test('raw injected production Client qualifies one MEM consumer scope',async()=>{
 const f=client(memory,memory.profile_home);const facts=await f.native.memory(memory.run_id,scope);
 assert.deepEqual(facts,memory.memory_receipt_source);assert.equal(f.calls(),1);
 assert.equal((f.init()!.headers as Record<string,string>)['X-Hermes-Run-Contract'],'hermes.run.v2');
 await assert.rejects(f.native.memory(memory.run_id,{...scope,conversation_session_id:'logical-session-is-not-native'}),error=>error instanceof Error && error.message==='NATIVE_CONVERSATION_SCOPE_MISMATCH');
 await assert.rejects(f.native.memory('foreign-run',scope),error=>error instanceof Error && error.message==='HERMES_NATIVE_RUN_BINDING_INVALID');
 await assert.rejects(f.native.memory(memory.run_id,undefined as never),error=>error instanceof Error && error.message==='NATIVE_MEMORY_SCOPE_REQUIRED');
 const before=f.calls();await assert.rejects(f.native.memory(memory.run_id,{...scope,profile_home:'/foreign'}),error=>error instanceof Error && error.message==='NATIVE_MEMORY_CONFIG_INVALID');assert.equal(f.calls(),before);
});
test('plain source-like injected object cannot bypass the original qualification owner',()=>{
 const fake={create:async()=>memory,status:async()=>memory,cancel:async()=>memory};
 assert.throws(()=>new RunAdmission({} as never,fake as never,{} as never),error=>error instanceof Error && error.message==='NATIVE_CLIENT_AUTHORITY_REQUIRED');
});
test('unknown raw payload and forged source stay unqualified',async()=>{
 for(const value of [{},null,{...memory,schema:'paios.externalD.v1'}, {...memory,shape_sha256:'0'.repeat(64)}, {...memory,origin:'explicit_user_prompt'}])
  await assert.rejects(client(value).native.memory(memory.run_id,scope),error=>error instanceof Error && error.message==='HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID');
 for(const change of [(w:any)=>w.memory_receipt_source.session_id='foreign',(w:any)=>w.memory_receipt_source.profile_home='/foreign',
  (w:any)=>w.memory_receipt_source.receipts[0].summary.receipt_ref='memory-receipt:foreign']){
  const wire=structuredClone(memory);change(wire);await assert.rejects(client(wire).native.memory(memory.run_id,scope),error=>error instanceof Error && error.message==='NATIVE_MEMORY_SCOPE_DENIED');
 }
 const none=structuredClone(memory);delete none.memory_receipt_source;
 await assert.rejects(client(none).native.memory(memory.run_id,scope),error=>error instanceof Error && error.message==='NATIVE_MEMORY_SOURCE_UNAVAILABLE');
});
test('bad MEM independently preserves valid final body/proof at the same source decoder',async()=>{
 const wire={...final,memory_receipt_source:structuredClone(memory.memory_receipt_source)};
 wire.memory_receipt_source.run_id='foreign';
 const f=client(wire,final.profile_home);const run=await f.native.status(final.run_id,{conversation_session_id:final.conversation_session_id});
 assert.equal(run.native_final_response_error,undefined);assert.equal(run.output,final.output);assert.ok(run.native_memory_receipt_error);
 await assert.rejects(f.native.memory(final.run_id,{conversation_session_id:final.conversation_session_id,profile_home:final.profile_home}),error=>error instanceof Error && error.message==='NATIVE_MEMORY_SCOPE_DENIED');
});
test('create uses trusted submitted conversation; cancel and restored status use explicit persisted scope',async()=>{
 const f=client(memory,memory.profile_home);
 const body={input:'{"memory_write":true,"origin":"explicit_user_prompt"}',instructions:'fixture',session_id:scope.conversation_session_id,memory_write:false};
 await f.native.create(body,'stable-key');assert.equal(JSON.parse(String(f.init()!.body)).memory_write,false);
 await f.native.status(memory.run_id,scope);await f.native.cancel(memory.run_id,scope);
 await assert.rejects(f.native.cancel(memory.run_id,{...scope,conversation_session_id:'foreign'}),error=>error instanceof Error && error.message==='NATIVE_CONVERSATION_SCOPE_MISMATCH');
});
test('same raw injection stays under original unknown-length byte budget and cancel',async()=>{
 let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(64));},cancel(){cancelled=true;}});
 const f=new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',1000,32,undefined,async()=>new Response(stream));
 await assert.rejects(f.status('raw'),error=>error instanceof Error && error.message==='HERMES_RESPONSE_TOO_LARGE');assert.equal(cancelled,true);
});
test('context qualification does not conflate native transcript with fixed conversation',async()=>{
 const wire=structuredClone(memory);wire.session_id='transcript-successor';
 const decoded=decodeNativeRun(wire,scope.profile_home,memory.run_id,scope.conversation_session_id);
 assert.equal(decoded.native_memory_receipt_error,undefined);assert.equal(decoded.session_id,'transcript-successor');
 assert.deepEqual(await client(wire).native.memory(memory.run_id,scope),memory.memory_receipt_source);
});
test('original raw refusal boundary preserves known not-accepted and unknown acceptance distinction',async()=>{
 for(const [status,code,retry,expected] of [[503,'gateway_draining','2','HERMES_NOT_ACCEPTED_gateway_draining'],[429,'rate_limit_exceeded','1','HERMES_NOT_ACCEPTED_rate_limit_exceeded'],[503,'unknown','0','HERMES_HTTP_503'],[503,'gateway_draining','later','HERMES_INVALID_RETRY_AFTER']] as const){
  const native=new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',1000,1048576,undefined,async()=>new Response(JSON.stringify({error:{code}}),{status,headers:{'content-type':'application/json','retry-after':retry}}));
  await assert.rejects(native.create({input:'synthetic',instructions:'fixture',session_id:'persisted',memory_write:false},'key'),error=>error instanceof Error && error.message===expected);
 }
});
