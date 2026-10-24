import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PersonalAIOSRuntime,RunAdmission,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {Timeline} from '../src/timeline.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {DEFAULT_PAYMENT_CONFIG} from '../src/payment/config.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {MAC_CAPABILITIES,PHONE_CAPABILITIES,sourceSnapshot,type RegisteredDevice} from '../src/source-authority.ts';
import {ContractError,EVENT_SCHEMA,type RawEvent} from '../src/contracts.ts';

const policy={max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'queue-authority'};
async function fixture(t:test.TestContext,withPayment=false){
  const root=await mkdtemp(join(tmpdir(),'queue-authority-')),storage=new PosixStorage(root),created:any[]=[],runs=new Map<string,NativeRun>(),issued=new WeakSet<RegisteredDevice>(),revoked=new Set<string>(),routes=new Map<string,string>();
  const sourceAuthority={authenticate:async(credential:unknown)=>{
    const device_id=String(credential),device_type=device_id==='phone'?'phone':'mac';
    const source=sourceSnapshot({principal_id:'owner',device_id,device_type,capabilities:device_type==='mac'?MAC_CAPABILITIES:PHONE_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:routes.get(device_id)??`route-${device_id}`,output_modes:['text']});
    issued.add(source);return source;
  },revalidate:async(source:RegisteredDevice)=>{assert.ok(issued.has(source),'SOURCE_PROVENANCE_REQUIRED');if(revoked.has(source.device_id))throw new ContractError('SOURCE_REVOKED',403);return source;}};
  const native={create:async(body:{session_id:string;input:string})=>{created.push(JSON.parse(body.input));const run={run_id:`run-${created.length}`,conversation_session_id:body.session_id,session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},status:async(id:string)=>runs.get(id)!,cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'})};
  let admission!:RunAdmission;
  const open=async()=>{admission=new RunAdmission(storage,native,policy);const runtime=new PersonalAIOSRuntime({...(withPayment?{payment:PaymentAuthority.open(join(root,'payments'),{config:{...DEFAULT_PAYMENT_CONFIG,enabled:false}})}:{}),storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),sourceAuthority,skill:'fixed',max_read_bytes:8192});await runtime.configureTimeline({directory:join(root,'timeline')});return runtime;};
  let runtime=await open();t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const reopen=async()=>{await runtime.close();runtime=await open();return runtime;};
  const raw=(source:RegisteredDevice,id:string):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:id,device_id:source.device_id,device_type:source.device_type,captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('owner request')});
  const interrupt=async()=>{
    const old=await runtime.authenticate('mac-old'),row=runtime.timeline!.queue('owner','origin',{action:'add',task:'sort invoices'},{source_at_ms:Date.now(),run_id:"fixture-run",session_id:"fixture-session",tool_call_id:'fixture-add-1'}) as {queue_id:string};
    const publish=storage.publish.bind(storage);let once=true;
    storage.publish=async(namespace,key,bytes)=>{const saved=await publish(namespace,key,bytes);if(once&&namespace==='processed-events'){once=false;throw Error('interrupted before admission');}return saved;};
    await assert.rejects(runtime.desktopReady(old),/interrupted before admission/);storage.publish=publish;
    assert.equal(created.length,0);return {old,row};
  };
  const queueRow=(queue_id:string)=>{const db=new DatabaseSync(join(root,'timeline/timeline.sqlite'),{readOnly:true});try{return {...db.prepare('SELECT admitted_device_id,state FROM desktop_queue WHERE queue_id=?').get(queue_id)};}finally{db.close();}};
  return {storage,runtime,sourceAuthority,reopen,created,revoked,routes,raw,interrupt,queueRow,get admission(){return admission;}};
}
async function until(fn:()=>boolean){const deadline=Date.now()+3000;while(!fn()){assert.ok(Date.now()<deadline,'native create did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}

test('queue recovery never admits revoked or unavailable persisted source under a replacement Mac',async t=>{
  const f=await fixture(t),{old,row}=await f.interrupt(),runtime=await f.reopen();
  await runtime.desktopReady(await runtime.authenticate('mac-new'));
  assert.equal(f.created.length,0);assert.deepEqual(f.queueRow(row.queue_id),{admitted_device_id:null,state:'pending'});
  const stop=await runtime.watchCare(await runtime.authenticate('mac-old'),async()=>false);f.revoked.add('mac-old');
  await assert.rejects(runtime.submit(f.raw(old,'must-deny'),old,'denied-session',true),/SOURCE_REVOKED/);
  await runtime.desktopReady(await runtime.authenticate('mac-new'));stop();
  assert.equal(f.created.length,0);assert.deepEqual(f.queueRow(row.queue_id),{admitted_device_id:null,state:'pending'});
});

test('queue recovery reuses valid current source, freezes event identity, and records the actual source',async t=>{
  const f=await fixture(t),{row}=await f.interrupt(),runtime=await f.reopen();
  const current=await runtime.authenticate('mac-old');
  const stop=await runtime.watchCare(current,async()=>false);t.after(stop);
  await runtime.desktopReady(await runtime.authenticate('mac-new'));await until(()=>f.created.length===1);
  assert.equal(f.created[0].device_id,'mac-old');assert.equal(f.created[0].content.app_event.queue_id,row.queue_id);
  assert.deepEqual(f.queueRow(row.queue_id),{admitted_device_id:'mac-old',state:'admitted'});
  await runtime.desktopReady(current);assert.equal(f.created.length,1);
});

test('queue source authority drift stays pending with an explicit conflict',async t=>{
  const f=await fixture(t),{row}=await f.interrupt(),runtime=await f.reopen();f.routes.set('mac-old','changed-route');
  await assert.rejects(runtime.desktopReady(await runtime.authenticate('mac-old')),/DESKTOP_QUEUE_SOURCE_CONFLICT/);
  assert.equal(f.created.length,0);assert.deepEqual(f.queueRow(row.queue_id),{admitted_device_id:null,state:'pending'});
});

test('native queue tool replay is idempotent before and after cancellation, admission and restart; changed args conflict',async t=>{
  const f=await fixture(t);assert.throws(()=>f.runtime.timeline!.queue('owner','model-origin',{action:'add',task:'missing native call'}),/DESKTOP_QUEUE_TOOL_CALL_REQUIRED/);
  const phone=await f.runtime.authenticate('phone'),accepted=await f.runtime.submit(f.raw(phone,'owner'),phone,'owner-session',true);
  await until(()=>!!f.admission.get('owner','owner-session',accepted.processed_event.processed_event_id)?.run_id);
  const run_id=f.admission.get('owner','owner-session',accepted.processed_event.processed_event_id)!.run_id!;
  const call={context:{run_id,session_id:'owner-session',tool_call_id:'same-tool-call'},args:{action:'add',task:'sort invoices'}};
  const first=await f.runtime.tool('paios_desktop_queue',call) as {queue_id:string};
  const replay=await f.runtime.tool('paios_desktop_queue',call) as {queue_id:string};assert.equal(first.queue_id,replay.queue_id);
  await assert.rejects(f.runtime.tool('paios_desktop_queue',{...call,args:{...call.args,task:'different task'}}),/DESKTOP_QUEUE_TOOL_CALL_CONFLICT/);
  f.runtime.timeline!.queue('owner','unused',{action:'cancel',queue_id:first.queue_id});
  assert.equal((await f.runtime.tool('paios_desktop_queue',call) as {queue_id:string}).queue_id,first.queue_id);
  const secondCall={...call,context:{...call.context,tool_call_id:'second-call'}};
  const second=await f.runtime.tool('paios_desktop_queue',secondCall) as {queue_id:string};
  await f.runtime.desktopReady(await f.runtime.authenticate('mac'));await until(()=>f.created.length===2);
  assert.equal((await f.runtime.tool('paios_desktop_queue',secondCall) as {queue_id:string}).queue_id,second.queue_id);
  const runtime=await f.reopen();await f.admission.recover();
  assert.equal((await runtime.tool('paios_desktop_queue',secondCall) as {queue_id:string}).queue_id,second.queue_id);
  await runtime.desktopReady(await runtime.authenticate('mac'));assert.equal(f.created.length,2);
});

test('cancellation and TTL expiry while current-source authorization yields prevent queue admission',async t=>{
  const root=await mkdtemp(join(tmpdir(),'queue-await-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=sourceSnapshot({principal_id:'owner',device_id:'mac',device_type:'mac',capabilities:MAC_CAPABILITIES,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text']});
  for(const action of ['cancel','expire']){
    let now=Date.now(),submissions=0;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const store=new Timeline({directory:join(root,action),now:()=>now},new PosixStorage(join(root,action)),async()=>{submissions++;},{readOnly:async()=>undefined});
    const row=store.queue('owner','origin',{action:'add',task:'must not run',expires_in_minutes:1},{source_at_ms:Date.now(),run_id:'fixture-run',session_id:'fixture-session',tool_call_id:action}) as {queue_id:string};
    const work=store.ready(source,async()=>{entered.resolve();await release.promise;return source;});await entered.promise;
    if(action==='cancel')store.queue('owner','unused',{action:'cancel',queue_id:row.queue_id});else now+=60_001;
    release.resolve();await work;assert.equal(submissions,0);assert.deepEqual(store.queue('owner','unused',{action:'list'}),{items:[]});
    await store.close();
  }
});

test('queue receipts share the bounded seen lifecycle and compacted native calls cannot recreate work after restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'queue-replay-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let now=Date.now();const options={directory:join(root,'timeline'),now:()=>now,replay_window_ms:1000},storage=new PosixStorage(root);
  const submit=async()=>{},admission={readOnly:async()=>undefined},identity={run_id:'native-run',session_id:'native-session',tool_call_id:'native-call',source_at_ms:now};
  let store=new Timeline(options,storage,submit,admission);
  const args={action:'add',task:'only once'},row=store.queue('owner','origin',args,identity) as {queue_id:string};
  store.queue('owner','origin',{action:'cancel',queue_id:row.queue_id});now+=1001;store.purge();await store.close();
  const db=new DatabaseSync(join(root,'timeline/timeline.sqlite'),{readOnly:true});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'queue-call:%'").get()?.n,0);db.close();
  store=new Timeline(options,storage,submit,admission);t.after(()=>store.close());
  assert.throws(()=>store.queue('owner','origin',args,identity),/DESKTOP_QUEUE_REPLAY_EXPIRED/);
  const fresh=store.queue('owner','fresh-origin',args,{...identity,tool_call_id:'fresh-call',source_at_ms:now}) as {queue_id:string};
  assert.notEqual(fresh.queue_id,row.queue_id);assert.equal((store.queue('owner','unused',{action:'list'}) as {items:unknown[]}).items.length,1);
});

test('runtime shutdown retains payment privacy authority until an in-flight desktop queue admission drains',async t=>{
  const f=await fixture(t,true),mac=await f.runtime.authenticate('mac');
  const row=f.runtime.timeline!.queue('owner','origin',{action:'add',task:'sort invoices'},
    {source_at_ms:Date.now(),run_id:'origin-run',session_id:'origin-session',tool_call_id:'queue-close'}) as {queue_id:string};
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),revalidate=f.sourceAuthority.revalidate;
  let checks=0;
  t.mock.method(f.sourceAuthority,'revalidate',async(source:RegisteredDevice)=>{
    if(++checks===2){entered.resolve();await release.promise;}
    return revalidate(source);
  });
  const ready=f.runtime.desktopReady(mac);
  await entered.promise;
  const closing=f.runtime.close();release.resolve();
  await Promise.all([ready,closing]);
  assert.equal(f.queueRow(row.queue_id).state,'admitted');
});
