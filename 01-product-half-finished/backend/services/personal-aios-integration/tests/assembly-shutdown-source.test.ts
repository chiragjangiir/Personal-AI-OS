import {sourceClient} from './native-source-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {createMainStop,withShutdownDrain,joinShutdown,shutdownSignal} from '../src/main.ts';
import {PosixStorage} from '../src/storage.ts';
import {sha256} from '../src/contracts.ts';
import {acquireProcessLock} from '../src/process-lock.ts';
import type {NativeClient} from './native-source-fixture.ts';
const failure = new Error('controlled owner failure');
const native: NativeClient = {async create() {throw new Error('not used');}, async status() {throw new Error('not used');}, async cancel() {throw new Error('not used');}};
async function fixture(t: test.TestContext) {
  const dir=await fs.mkdtemp(join(tmpdir(),'paios-assembly-shutdown-'));
  const storage=new PosixStorage(dir);
  const assembly=createPersonalAIOSAssembly({storage,native:sourceClient(native),skill:'controlled skill',max_event_bytes:8192,max_read_bytes:8192,
    admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'shutdown-source'},
    http:{internal_token:'synthetic-shutdown-internal-token',max_request_bytes:8192,request_timeout_ms:1000}});
  t.after(async()=>{await new Promise<void>(resolve=>{assembly.server.close(()=>resolve());assembly.server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});});
  return {assembly,storage};
}
for (const rejecting of ['http','runtime'] as const) test(`assembly joins delayed sibling after ${rejecting} rejection and preserves single error`, async t=>{
  const {assembly}=await fixture(t); const release=Promise.withResolvers<void>(); const calls:string[]=[];
  assembly.server.closeAndDrain=()=>{calls.push('http');return rejecting==='http'?Promise.reject(failure):release.promise;};
  assembly.runtime.close=()=>{calls.push('runtime');return rejecting==='runtime'?Promise.reject(failure):release.promise;};
  const stop=assembly.close();assert.equal(assembly.close(),stop);let done=false;const outcome=stop.then(()=>{done=true;return null;},error=>{done=true;return error;});
  await turn();assert.equal(done,false);assert.deepEqual(calls,['http','runtime']);release.resolve();assert.equal(await outcome,failure);assert.equal(assembly.close(),stop);
});
test('assembly invokes and joins sibling even when close throws synchronously',async t=>{
  const {assembly}=await fixture(t);const release=Promise.withResolvers<void>();let joined=false;
  assembly.server.closeAndDrain=()=>{throw failure;};assembly.runtime.close=async()=>{await release.promise;joined=true;};
  const stop=assembly.close();const outcome=stop.catch(error=>error);await turn();assert.equal(joined,false);release.resolve();assert.equal(await outcome,failure);assert.equal(joined,true);
});
test('assembly retains both independent close errors',async t=>{
  const {assembly}=await fixture(t);const other=new Error('second owner failure');
  assembly.server.closeAndDrain=()=>Promise.reject(failure);assembly.runtime.close=()=>Promise.reject(other);
  const outcome=await assembly.close().catch(error=>error);assert.ok(outcome instanceof AggregateError);assert.deepEqual(outcome.errors,[failure,other]);
});
test('actual HTTP close failure still joins dispatched route storage write before resource cleanup',async t=>{
  const {assembly,storage}=await fixture(t);const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  assembly.runtime.authenticate=async()=>{entered.resolve();await release.promise;await storage.publish('shutdown-route',sha256('joined'),Buffer.from('joined'));throw new Error('controlled authentication failure');};
  await new Promise<void>(resolve=>assembly.server.listen(0,'127.0.0.1',resolve));const address=assembly.server.address();assert.ok(address&&typeof address!=='string');
  const request=fetch(`http://127.0.0.1:${address.port}/v1/events/unknown?session_id=session`,{headers:{Authorization:'Bearer synthetic-route-token'}}).catch(()=>undefined);await entered.promise;
  const close=assembly.server.close.bind(assembly.server);
  assembly.server.close=(callback?: (error?: Error)=>void)=>close(()=>callback?.(failure));
  const order:string[]=[];const stop=createMainStop(assembly,{async close(){assert.equal(Buffer.from(await storage.read('shutdown-route',sha256('joined'))).toString(),'joined');order.push('db');}},async()=>{order.push('lock');});
  const first=stop();assert.equal(stop(),first);let finished=false;const outcome=first.catch(error=>{finished=true;return error;});await turn();assert.equal(finished,false);assert.deepEqual(order,[]);
  release.resolve();assert.equal(await outcome,failure);await request;assert.deepEqual(order,['db','lock']);
});
for(const failed of ['none','assembly','database','release','all'] as const) test(`main source owner cleanup order and stable repeated close: ${failed}`,async()=>{
  const order:string[]=[];const errors={assembly:new Error('assembly failure'),database:new Error('db failure'),release:new Error('release failure')};
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const stop=createMainStop({async close(){order.push('assembly-enter');entered.resolve();await release.promise;order.push('assembly-joined');if(failed==='assembly'||failed==='all')throw errors.assembly;}},
    {async close(){order.push('database');if(failed==='database'||failed==='all')throw errors.database;}},async()=>{order.push('release');if(failed==='release'||failed==='all')throw errors.release;});
  const first=stop();assert.equal(stop(),first);const outcome=first.then(()=>undefined,error=>error);await entered.promise;await turn();assert.deepEqual(order,['assembly-enter']);release.resolve();const result=await outcome;
  assert.deepEqual(order,['assembly-enter','assembly-joined','database','release']);assert.equal(stop(),first);await stop().catch(()=>{});assert.equal(order.length,4);
  if(failed==='all'){assert.ok(result instanceof AggregateError);assert.deepEqual(result.errors,[errors.assembly,errors.database,errors.release]);}
  else assert.equal(result,failed==='none'?undefined:errors[failed]);
});
test('main catches synchronous owner errors and still releases once in order',async()=>{
  const order:string[]=[];const other=new Error('sync database');const stop=createMainStop({close(){order.push('assembly');throw failure;}},
    {close(){order.push('database');throw other;}},async()=>{order.push('lock');});
  const result=await stop().catch(error=>error);assert.ok(result instanceof AggregateError);assert.deepEqual(result.errors,[failure,other]);assert.deepEqual(order,['assembly','database','lock']);
});
test('real assembly normal close is shared and fulfills only after both owners',async t=>{
  const {assembly}=await fixture(t);const first=assembly.close();assert.equal(first,assembly.close());await first;
});


test('nested shutdown shares its bounded budget and retains the lock until process exit',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const gate=Promise.withResolvers<void>(),order:string[]=[];
  let outerSignal:AbortSignal|undefined,innerSignal:AbortSignal|undefined;
  const stop=createMainStop({close:()=>withShutdownDrain(async()=>{
    outerSignal=shutdownSignal();await joinShutdown(()=>withShutdownDrain(async()=>{innerSignal=shutdownSignal();await gate.promise;},105000));
  })},{close:async()=>{order.push('database');}},async()=>{order.push('release');},30000);
  const closing=stop().catch(error=>error);await turn();assert.equal(outerSignal,innerSignal);
  t.mock.timers.tick(14999);await turn();assert.deepEqual(order,[]);
  t.mock.timers.tick(1);const error=await closing;assert.ok(error instanceof AggregateError);assert.equal(outerSignal?.aborted,true);
  assert.deepEqual(order,['database']);gate.resolve();await turn();assert.deepEqual(order,['database']);
});

test('shutdown final release has only the remainder of the same budget',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const owner=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();let released=false,finished=false;
  const stop=createMainStop({close:()=>owner.promise},undefined,async()=>{released=true;await gate.promise;},30000);
  const closing=stop().catch(error=>{finished=true;return error;});await turn();
  t.mock.timers.tick(10000);owner.resolve();await turn();assert.equal(released,true);
  t.mock.timers.tick(19999);await turn();assert.equal(finished,false);
  t.mock.timers.tick(1);assert.match((await closing).message,/SHUTDOWN_RELEASE_EXPIRED/);gate.resolve();
});


test('shutdown budget rejects invalid configuration before creating a drain context',async()=>{
  for(const ms of [0,15000,105001,NaN,Infinity,30000.5])await assert.rejects(withShutdownDrain(async()=>{},ms),/SHUTDOWN_DRAIN_INVALID/);
});

for(const nested of [false,true])test(`timed-out ${nested?'nested':'direct'} mutation owner retains the actual process lock`,async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'paios-shutdown-lock-')),path=join(dir,'owner.lock');
  const release=await acquireProcessLock(path),gate=Promise.withResolvers<void>();
  t.after(async()=>{gate.resolve();await turn();await release();await fs.rm(dir,{recursive:true,force:true});});
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  let mutationSettled=false;
  const write=async()=>{await gate.promise;mutationSettled=true;};
  const stop=createMainStop({close:async()=>{
    if(nested)await joinShutdown(write).catch(()=>{});else await write();
  }},undefined,release,30000);
  const closing=stop().catch(error=>error);await turn();t.mock.timers.tick(15000);
  assert.ok(await closing instanceof Error);assert.equal(mutationSettled,false);
  await assert.rejects(acquireProcessLock(path),/PERSONAL_AIOS_ALREADY_RUNNING/);
  gate.resolve();await turn();assert.equal(mutationSettled,true);
  await assert.rejects(acquireProcessLock(path),/PERSONAL_AIOS_ALREADY_RUNNING/);
});
