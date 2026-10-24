import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {createPersonalAIOSServer} from '../src/server.ts';
import type {PersonalAIOSRuntime} from '../src/runtime.ts';
import {HttpBodyBudget,readBody} from '../src/http-body.ts';

const incoming=(parts:Buffer[],length?:number)=>Object.assign(Readable.from(parts),{headers:length===undefined?{}:{'content-length':String(length)}}) as IncomingMessage;
test('body byte and request capacity reject before reading and release once',async()=>{
  const budget=new HttpBodyBudget(10,2),first=budget.acquire(incoming([],7),10);
  assert.throws(()=>budget.acquire(incoming([],4),10),/REQUEST_BODY_BUSY/);
  const second=budget.acquire(incoming([],3),10);assert.equal(budget.snapshot().reserved_bytes,10);
  assert.throws(()=>budget.acquire(incoming([],0),10),/REQUEST_BODY_BUSY/);
  first();first();assert.equal(budget.snapshot().reserved_bytes,3);second();
  const unknown=budget.acquire(incoming([]),10);assert.equal(budget.snapshot().reserved_bytes,10);unknown();
  assert.deepEqual(budget.snapshot(),{active:0,reserved_bytes:0,max_bytes:10,max_requests:2});
  assert.throws(()=>budget.acquire(incoming([],11),10),/REQUEST_TOO_LARGE/);
});
test('body framing preserves bytes and rejects known and unknown overrun',async()=>{
  const parts=[Buffer.from('ab'),Buffer.from('cd')];
  assert.deepEqual(await readBody(incoming(parts,4),4),Buffer.from('abcd'));
  assert.deepEqual(await readBody(incoming(parts),4),Buffer.from('abcd'));
  await assert.rejects(readBody(incoming(parts,3),4),/REQUEST_TOO_LARGE/);
  await assert.rejects(readBody(incoming(parts),3),/REQUEST_TOO_LARGE/);
  await assert.rejects(readBody(incoming(parts,5),5),/REQUEST_BODY_TRUNCATED/);
});
test('HTTP lease stays active through archive publication and returns after failure',async t=>{
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const runtime={authenticate:async()=>({device_id:'phone',device_type:'phone',channel:'http'}),
    archiveUpload:async()=>{entered.resolve();await finish.promise;throw new Error('publication failed');}} as unknown as PersonalAIOSRuntime;
  const server=createPersonalAIOSServer(runtime,{internal_token:'fixture-internal-token-at-least-24',max_request_bytes:1024,request_timeout_ms:1000});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.closeAndDrain());
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const body=JSON.stringify({event_id:'test',captured_at:'2026-10-15T00:00:00Z',payload_base64:'eA==',mime:'application/octet-stream',media_type:'file',representation:'uploaded_original'});
  const response=fetch(`http://127.0.0.1:${address.port}/v1/originals`,{method:'POST',headers:{Authorization:'Bearer fixture'},body});
  await entered.promise;assert.equal(server.bodyBudgetSnapshot().active,1);assert.equal(server.bodyBudgetSnapshot().reserved_bytes,Buffer.byteLength(body));
  finish.resolve();assert.equal((await response).status,500);assert.equal(server.bodyBudgetSnapshot().active,0);
});

for(const route of ['payment','desktop'] as const)test(`shared HTTP lease covers the delegated ${route} consumer until failure`,async t=>{
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  const token='fixture-internal-token-at-least-24',paymentKey='fixture-distinct-executor-key';
  const runtime={paymentAuthority:route==='payment'?{checkpoint:async()=>{
    entered.resolve();await finish.promise;throw new Error('payment publication failed');}}:undefined} as unknown as PersonalAIOSRuntime;
  const server=createPersonalAIOSServer(runtime,{internal_token:token,payment_key:paymentKey,max_request_bytes:1024,request_timeout_ms:1000,
    ...(route==='desktop'?{desktop:async(request:IncomingMessage)=>{
      await readBody(request,1024);entered.resolve();await finish.promise;throw new Error('desktop publication failed');}}:{})});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>{finish.resolve();return server.closeAndDrain();});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const path=route==='payment'?'/internal/payment/executor/checkpoints':'/internal/desktop/mcp';
  const response=fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${route==='payment'?paymentKey:token}`},body:'{}'});
  await entered.promise;
  assert.equal(server.bodyBudgetSnapshot().active,1);assert.equal(server.bodyBudgetSnapshot().reserved_bytes,2);
  finish.resolve();assert.equal((await response).status,500);assert.equal(server.bodyBudgetSnapshot().active,0);
});

test('authenticated resource snapshots expose actual owner queues and event-loop delay',async t=>{
  const token='fixture-internal-token-at-least-24';
  const runtime={existingArchive:()=>({packingSnapshot:()=>({active:1,queued:2})})} as unknown as PersonalAIOSRuntime;
  const server=createPersonalAIOSServer(runtime,{internal_token:token,max_request_bytes:1024,request_timeout_ms:1000,
    resource_snapshot:()=>({encoder_backlog:2048,call_video:{queued_bytes:2048}})});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.closeAndDrain());
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/internal/resources`;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200);
  const data=await response.json() as {encoder_backlog:number;gateway_packing_backlog:number;gateway_event_loop_delay:{unit:string};memory:{rss:number};v8:{heap_size_limit:number}};
  assert.equal(data.encoder_backlog,2048);assert.equal(data.gateway_packing_backlog,3);
  assert.equal(data.gateway_event_loop_delay.unit,'milliseconds');assert.ok(data.memory.rss>0&&data.v8.heap_size_limit>0);
});
