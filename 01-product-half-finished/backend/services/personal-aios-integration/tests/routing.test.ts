import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, sha256, type ProcessedEvent, type RawEvent } from '../src/contracts.ts';
import { PosixStorage, type StoragePort } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { PersonalAIOSRuntime, type FixtureRegisteredDevice } from './native-source-fixture.ts';
import { OutputTargetAuthority } from '../src/routing.ts';
import type { NativeClient, NativeRun } from './native-source-fixture.ts';
const token='route-registry-test-token';
const now='2026-10-01T00:00:00.000Z';
const registration:FixtureRegisteredDevice={principal_id:'owner',device_id:'mac',device_type:'mac',channel:'text',
  consent_ref:'test-consent',token_sha256:sha256(token),route_version:'route-1',output_modes:['text']};
const raw=(event:string):RawEvent=>({schema_version:'paios.event.v1',event_id:event,device_id:'mac',device_type:'mac',
  captured_at:now,source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('actual source '+event)});
async function setup(t:test.TestContext) {
  const root=await fs.mkdtemp(join(tmpdir(),'paios-route-'));
  const instances:PersonalAIOSRuntime[]=[];
  t.after(async()=>{await Promise.all(instances.map(rt=>rt.close()));await fs.rm(root,{recursive:true,force:true});});
  const storage=new PosixStorage(root); const runs=new Map<string,NativeRun>(); const keys=new Map<string,string>(); let creates=0;
  const native:NativeClient={create:async(body,key)=>{
    const d=JSON.parse(body.input) as ProcessedEvent;
    const snapshot=await new OutputTargetAuthority(storage).read(d); // Producer must durably publish route before admission reaches native.
    assert.equal(snapshot.device_id,d.device_id);
    const previous=keys.get(key); if(previous) return {...runs.get(previous)!};
    creates++; const run={run_id:'run-'+creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
    runs.set(run.run_id,run); keys.set(key,run.run_id); return {...run};
  },status:async run=>({...runs.get(run)!}),cancel:async run=>({...runs.get(run)!})};
  function runtime(device:FixtureRegisteredDevice, port:StoragePort=storage) {
    const archive=new RawArchive(port,4096);
    const admission=new RunAdmission(port,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
      poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'routing-test'});
    const rt=new PersonalAIOSRuntime({storage:port,archive,admission,native,output:new OutputAuthority(port,{listRunReceipts:async()=>({sources:[{source:"l3",status:"complete",error:null,receipts:[]}]})}),
      devices:[device],skill:'fixed',max_read_bytes:4096}); instances.push(rt); return rt;
  }
  async function bound(rt:PersonalAIOSRuntime,d:ProcessedEvent) {
    for(let i=0;i<100;i++) {const e=await rt.event((await rt.authenticate(token)),'session',d.processed_event_id); if(e.admission.run_id) return e.admission.run_id;
      await new Promise(resolve=>setTimeout(resolve,5));}
    throw new Error('BOUND_TIMEOUT');
  }
  async function open(rt:PersonalAIOSRuntime,run:string,args:Record<string,unknown>={reply_mode:'text'}) {
    return rt.tool('paios_open_reply',{context:{run_id:run,session_id:'session',tool_call_id:'open'},args});
  }
  function finish(run:string) {Object.assign(runs.get(run)!,{status:'completed',output:'trusted native final fixture'});}
  return {root,storage,runtime,bound,open,finish,creates:()=>creates};
}
test('runtime producer/OUT consumer restart preserves old route/modes and ACK; fresh D gets new snapshot',async t=>{
  const f=await setup(t); const one=f.runtime(registration);
  const first=await one.submit(raw('first'),(await one.authenticate(token)),'session',true); const d=first.processed_event;
  const run=await f.bound(one,d); await f.open(one,run,{reply_mode:'voice'}); f.finish(run);
  const initial=await one.result((await one.authenticate(token)),'session',d.processed_event_id);
  assert.equal(initial.result.reply_mode,'text'); assert.equal(initial.result.voice_status,'none');
  assert.equal(initial.chunks[0]?.route_version,'route-1'); await one.close();
  const changed={...registration,route_version:'route-2',output_modes:['voice']}; const two=f.runtime(changed);
  const replay=await two.submit(raw('first'),(await two.authenticate(token)),'session',true);
  assert.equal(replay.processed_event.processed_event_id,d.processed_event_id); assert.equal(f.creates(),1);
  const after=await two.result((await two.authenticate(token)),'session',d.processed_event_id);
  assert.equal(after.chunks[0]?.route_version,'route-1'); assert.deepEqual(after.result.output_plan,initial.result.output_plan);
  const snapshot=await new OutputTargetAuthority(f.storage).read(d); assert.deepEqual(snapshot.output_modes,['text']);
  const chunk=after.chunks[0]!;
  const ack={output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:'mac',route_version:'route-1',
    highest_contiguous_seq:1,status:'rendered' as const,observed_at:now};
  await assert.rejects(two.acknowledge((await two.authenticate(token)),'session',d.processed_event_id,{...ack,route_version:'route-2'}),/BINDING_MISMATCH/);
  await two.acknowledge((await two.authenticate(token)),'session',d.processed_event_id,ack);
  assert.equal((await two.result((await two.authenticate(token)),'session',d.processed_event_id)).result.delivery_status,'rendered');
  const fresh=await two.submit(raw('second'),(await two.authenticate(token)),'session',true);
  const next=await new OutputTargetAuthority(f.storage).read(fresh.processed_event);
  assert.equal(next.route_version,'route-2'); assert.deepEqual(next.output_modes,['voice']);
  assert.equal((await f.storage.list('output-targets')).length,2);
});
test('forged model/device routing and ownership drift cannot replace trusted snapshot',async t=>{
  const f=await setup(t); const rt=f.runtime(registration);
  await assert.rejects(rt.submit(raw('forged'),{...(await rt.authenticate(token)),route_version:'model-route'},'session',true),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  const first=await rt.submit(raw('first'),(await rt.authenticate(token)),'session',true); const run=await f.bound(rt,first.processed_event);
  await assert.rejects(f.open(rt,run,{reply_mode:'text',target_device_id:'evil'}),/UNKNOWN_TOOL_ARGUMENT/);
  const denied=await f.open(rt,run,{reply_mode:'text',target_aliases:['evil']}); assert.equal((denied as {status:string}).status,'rejected');
  const routes=new OutputTargetAuthority(f.storage);
  await assert.rejects(routes.capture(first.processed_event,{...registration,principal_id:'other'}),/SOURCE_DENIED/);
  await assert.rejects(routes.read({...first.processed_event,revision:2}),/SCOPE_CONFLICT/);
  const other={...registration,principal_id:'other',device_id:'other-mac',token_sha256:sha256('other-token')};
  await assert.rejects(rt.result(other,'session',first.processed_event.processed_event_id),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  assert.equal((await routes.read(first.processed_event)).route_version,'route-1');
});
test('legacy finalized D without actual snapshot errors rather than guessing current config, even with OUT journal',async t=>{
  const f=await setup(t); const rt=f.runtime(registration);
  const first=await rt.submit(raw('legacy'),(await rt.authenticate(token)),'session',true); const run=await f.bound(rt,first.processed_event);
  await f.open(rt,run); f.finish(run); await rt.result((await rt.authenticate(token)),'session',first.processed_event.processed_event_id);
  const key=digest({principal_id:first.processed_event.principal_id,processed_event_id:first.processed_event.processed_event_id});
  await fs.unlink(join(f.root,'output-targets',key)); await rt.close();
  const restarted=f.runtime({...registration,route_version:'route-current',output_modes:['voice']});
  await assert.rejects(restarted.result((await restarted.authenticate(token)),'session',first.processed_event.processed_event_id),/LEGACY_OUTPUT_TARGET_REQUIRED/);
  await assert.rejects(restarted.submit(raw('legacy'),(await restarted.authenticate(token)),'session',true),/LEGACY_OUTPUT_TARGET_REQUIRED/);
  assert.deepEqual(await f.storage.list('output-targets'),[]);
  // Explicit fixture repair from known original configuration; never an automatic current-config fallback.
  await new OutputTargetAuthority(f.storage).capture(first.processed_event,registration);
  assert.equal((await restarted.result((await restarted.authenticate(token)),'session',first.processed_event.processed_event_id)).chunks[0]?.route_version,'route-1');
});
test('snapshot publication failure prevents D publication/admission and source retry recovers',async t=>{
  const f=await setup(t); let fail=true;
  const port:StoragePort={read:(n,k)=>f.storage.read(n,k),list:n=>f.storage.list(n),removePending:k=>f.storage.removePending(k),
    publish:async(n,k,b)=>{if(n==='output-targets'&&fail){fail=false;throw new Error('ROUTE_DISK_FAILURE');}return f.storage.publish(n,k,b);}};
  const rt=f.runtime(registration,port);
  await assert.rejects(rt.submit(raw('failed'),(await rt.authenticate(token)),'session',true),/ROUTE_DISK_FAILURE/);
  assert.deepEqual(await f.storage.list('processed-events'),[]); assert.deepEqual(await f.storage.list('admissions'),[]); assert.equal(f.creates(),0);
  const repaired=await rt.submit(raw('failed'),(await rt.authenticate(token)),'session',true);
  assert.equal((await new OutputTargetAuthority(f.storage).read(repaired.processed_event)).route_version,'route-1');
  await f.bound(rt,repaired.processed_event); assert.equal(f.creates(),1);
});
