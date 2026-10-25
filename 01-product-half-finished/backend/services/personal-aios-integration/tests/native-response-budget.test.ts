import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync,promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HermesClient,NativeNotAcceptedError} from './native-source-fixture.ts';
import {ContractError} from '../src/contracts.ts';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';
const wire=JSON.parse(readFileSync(new URL('./fixtures/native-final-response/native-run-version-fixtures.json',import.meta.url),'utf8')).cli.running;
const body={input:'controlled D',instructions:'controlled skill',session_id:'session'};
const token='fixture-native-budget-token-abcdefghijkl';
async function fixture(t:test.TestContext,handler:(req:IncomingMessage,res:ServerResponse)=>void,budget:number,timeout=3000){
 const server=createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${token}`);if(req.url?.startsWith('/v1/runs'))assert.equal(req.headers['x-hermes-run-contract'],'hermes.run.v2');req.resume();handler(req,res);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 return {url:`http://127.0.0.1:${address.port}`,client:new HermesClient(`http://127.0.0.1:${address.port}`,token,timeout,budget)};
}
function unknown(error:unknown,code:string){return error instanceof ContractError&&!(error instanceof NativeNotAcceptedError)&&error.code===code;}
for(const method of ['create','get','cancel'] as const)
for(const length of ['chunked','declared'] as const)
test(`${method} ${length} response counts bytes and rejects overflow before native parsing`,async t=>{
 const text=JSON.stringify({...wire,output:'x'.repeat(256)});
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json',...(length==='declared'?{'Content-Length':Buffer.byteLength(text)}:{})});res.write(text.slice(0,70));res.end(text.slice(70));},64);
 await assert.rejects(method==='create'?f.client.create(body,'same-key'):method==='get'?f.client.status(wire.run_id):f.client.cancel(wire.run_id),e=>unknown(e,'HERMES_RESPONSE_TOO_LARGE'));
});
test('exact-byte valid native response preserves legal JSON and original create/get/cancel identities',async t=>{
 const text=JSON.stringify(wire);const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(text);},Buffer.byteLength(text));
 assert.deepEqual(await f.client.create(body,'same-key'),wire);assert.deepEqual(await f.client.status(wire.run_id),wire);assert.deepEqual(await f.client.cancel(wire.run_id),wire);
 await assert.rejects(f.client.status('foreign'),e=>unknown(e,'HERMES_NATIVE_RUN_BINDING_INVALID'));
});
for(const status of [401,429,503])
test(`error ${status} without length cannot claim native nonacceptance when over budget`,async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(status,{'Content-Type':'application/json'});res.write('{"error":{"code":"gateway_draining"}}');res.end(' '.repeat(128));},64);
 await assert.rejects(f.client.create(body,'same-key'),e=>unknown(e,'HERMES_RESPONSE_TOO_LARGE')&&(e as ContractError).status===status);
});
for(const invalid of ['json','utf8'] as const)
test(`successful malformed ${invalid} response remains unknown`,async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(invalid==='json'?'{"run_id":':Buffer.from([0xff]));},64);
 await assert.rejects(f.client.create(body,'same-key'),e=>unknown(e,'HERMES_INVALID_RESPONSE'));
});
test('bounded HTML error preserves HTTP auth status while malformed refusal stays unknown',async t=>{
 let status=401;const f=await fixture(t,(_req,res)=>{res.writeHead(status,{'Content-Type':status===401?'text/html':'application/json'});res.end('<html>unknown</html>');},64);
 await assert.rejects(f.client.create(body,'same-key'),e=>unknown(e,'HERMES_HTTP_401'));status=503;
 await assert.rejects(f.client.create(body,'same-key'),e=>unknown(e,'HERMES_HTTP_503'));
});
test('complete bounded fixed refusal alone preserves known-notaccepted and Retry-After',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(429,{'Content-Type':'application/json','Retry-After':'1'});res.end(JSON.stringify({error:{code:'rate_limit_exceeded'}}));},128);
 await assert.rejects(f.client.create(body,'same-key'),e=>e instanceof NativeNotAcceptedError&&e.nativeCode==='rate_limit_exceeded'&&e.retryAfterMs===1000);
 await assert.rejects(f.client.status(wire.run_id),e=>unknown(e,'HERMES_HTTP_429'));
});
test('one original readiness reader remains bounded for success and error response',async t=>{
 let status=200;const f=await fixture(t,(_req,res)=>{res.writeHead(status,{'Content-Type':'application/json'});res.write('{"platform":"hermes-agent",');res.end(' '.repeat(128));},64);
 await assert.rejects(f.client.ready(64),e=>unknown(e,'HERMES_READINESS_TOO_LARGE'));status=503;
 await assert.rejects(f.client.ready(64),e=>unknown(e,'HERMES_READINESS_TOO_LARGE'));
});
test('body timeout and caller cancellation keep original abort semantics, with no acceptance claim',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');},64,80);
 await assert.rejects(f.client.create(body,'same-key'),e=>!(e instanceof NativeNotAcceptedError)&&e instanceof Error&&['TimeoutError','AbortError'].includes(e.name));
 const abort=new AbortController();const work=f.client.create(body,'same-key',abort.signal);abort.abort();
 await assert.rejects(work,e=>!(e instanceof NativeNotAcceptedError)&&e instanceof Error&&e.name==='AbortError');
});
test('provisioned original max_read_bytes is the NativeRun response budget, with no new configuration',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(wire));},4096);
 const root=await fs.mkdtemp(join(tmpdir(),'native-budget-config-'));await fs.writeFile(join(root,'key'),token,{mode:0o600});await fs.writeFile(join(root,'skill'),'controlled skill');
 const config:CentralProvisionConfiguration={port:18898,storage_root:join(root,'storage'),lock_file:join(root,'lock'),hermes_base_url:f.url,hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),native_request_timeout_ms:3000,http_request_timeout_ms:3000,max_request_bytes:8192,max_event_bytes:8192,max_read_bytes:64,admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'budget'}};
 const provision=await provisionCentralResources(config);t.after(async()=>{await provision.release();await fs.rm(root,{recursive:true,force:true});});
 await assert.rejects(provision.native.create(body,'same-key'),e=>unknown(e,'HERMES_RESPONSE_TOO_LARGE'));
});
