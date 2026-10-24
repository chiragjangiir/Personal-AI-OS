import {sourceClient} from './native-source-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {createMainStop} from '../src/main.ts';
import {PosixStorage} from '../src/storage.ts';
import type {MediaService} from '../src/media/service.ts';
import type {NativeClient} from './native-source-fixture.ts';
const native:NativeClient={async create(){throw new Error('unused');},async status(){throw new Error('unused');},async cancel(){throw new Error('unused');}};
async function fixture(t:test.TestContext,media:{close():Promise<void>}) {
 const dir=await fs.mkdtemp(join(tmpdir(),'current-p-lifecycle-'));
 const assembly=createPersonalAIOSAssembly({storage:new PosixStorage(dir),native:sourceClient(native),skill:'controlled',max_event_bytes:8192,max_read_bytes:8192,
  media:media as unknown as MediaService,admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'lifecycle'},
  http:{internal_token:'synthetic-lifecycle-internal-secret',max_request_bytes:8192,request_timeout_ms:1000}});
 t.after(async()=>{await assembly.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});});
 const owners=assembly.runtime as unknown as {admission:{close():Promise<void>};output:{close():Promise<void>};mediaWork:Set<Promise<unknown>>};
 return {assembly,owners};
}
test('actual Runtime media rejection cannot release DB/lock before pending admission and output joins',async t=>{
 const primary=new Error('MEDIA_CLOSE'),a=Promise.withResolvers<void>(),o=Promise.withResolvers<void>(),events:string[]=[];
 const {assembly,owners}=await fixture(t,{close:async()=>{events.push('media');throw primary;}});
 owners.admission.close=async()=>{events.push('admission');await a.promise;events.push('admission.joined');};
 owners.output.close=async()=>{events.push('output');await o.promise;events.push('output.joined');};
 const stop=createMainStop(assembly,{close:async()=>{events.push('db');}},async()=>{events.push('lock');});
 let done=false;const outcome=stop().catch(error=>{done=true;return error;});
 await turn();const early=done,earlyRelease=events.includes('db');a.resolve();await turn();const beforeOutput=done;o.resolve();
 const result=await outcome;assert.equal(result,primary);assert.equal(early,false);assert.equal(earlyRelease,false);assert.equal(beforeOutput,false);
 assert.ok(events.indexOf('db')>events.indexOf('output.joined'));assert.ok(events.indexOf('db')>events.indexOf('admission.joined'));assert.equal(events.at(-1),'lock');
});
for(const synchronous of [false,true])test(`Runtime starts every close despite admission failure, synchronously=${synchronous}`,async t=>{
 const primary=new Error('ADMISSION_CLOSE'),other=new Error('OUTPUT_CLOSE'),calls:string[]=[];
 const {assembly,owners}=await fixture(t,{close:async()=>{calls.push('media');}});
 owners.admission.close=()=>{calls.push('admission');if(synchronous)throw primary;return Promise.reject(primary);};
 owners.output.close=()=>{calls.push('output');return Promise.reject(other);};
 const first=assembly.runtime.close();assert.equal(first,assembly.runtime.close());const error=await first.catch(error=>error);
 assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[primary,other]);assert.deepEqual([...calls].sort(),['admission','media','output']);
});
test('Runtime MEDIA close starts before pending mediaWork and joins late tracked work before close finishes',async t=>{
 const mediaStarted=Promise.withResolvers<void>(),mediaReleased=Promise.withResolvers<void>();let mediaCalls=0;
 const {assembly,owners}=await fixture(t,{close:async()=>{mediaCalls++;mediaStarted.resolve();await mediaReleased.promise;}});
 const work=mediaStarted.promise.then(()=>{const late=mediaReleased.promise.then(()=>{});owners.mediaWork.add(late);void late.finally(()=>owners.mediaWork.delete(late));});
 owners.mediaWork.add(work);void work.finally(()=>owners.mediaWork.delete(work));
 const first=assembly.runtime.close();await mediaStarted.promise;await turn();assert.equal(owners.mediaWork.size,1);let done=false;void first.then(()=>{done=true;});await turn();assert.equal(done,false);
 mediaReleased.resolve();await first;assert.equal(owners.mediaWork.size,0);assert.equal(mediaCalls,1);
});
test('Runtime media failure joins actual admission owned work and OutputAuthority synthesis tasks before main resources',async t=>{
 const primary=new Error('MEDIA_ACTUAL_CHILD_JOIN'),a=Promise.withResolvers<void>(),o=Promise.withResolvers<void>(),order:string[]=[];
 const {assembly,owners}=await fixture(t,{close:async()=>{throw primary;}});
 const admission=owners.admission as unknown as {owned:Set<Promise<unknown>>};
 const output=owners.output as unknown as {synthesis:Map<string,{abort:AbortController;task:Promise<void>;dequeue():void}>};
 const admissionTask=a.promise.then(()=>{order.push('admission.joined');});
 admission.owned.add(admissionTask);void admissionTask.then(()=>admission.owned.delete(admissionTask));
 const abort=new AbortController(),outputTask=o.promise.then(()=>{order.push('output.joined');});
 output.synthesis.set('controlled-owned-synthesis',{abort,task:outputTask,dequeue:()=>{}});
 const stop=createMainStop(assembly,{close:async()=>{order.push('db');}},async()=>{order.push('lock');});
 let done=false;const result=stop().catch(error=>{done=true;return error;});
 await turn();assert.equal(done,false);assert.equal(abort.signal.aborted,true);assert.deepEqual(order,[]);
 a.resolve();await turn();assert.equal(done,false);assert.deepEqual(order,['admission.joined']);o.resolve();
 assert.equal(await result,primary);assert.deepEqual(order,['admission.joined','output.joined','db','lock']);
});
