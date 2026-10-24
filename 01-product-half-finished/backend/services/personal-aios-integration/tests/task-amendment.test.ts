import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunAdmission} from '../src/admission.ts';
import {nativeRunStreamFixture,waitForNativeCondition} from './native-run-stream-fixture.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256,type NativeRun} from '../src/hermes-client.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {EVENT_SCHEMA,canonical,digest} from '../src/contracts.ts';

const NATIVE_REQUEST_TIMEOUT_MS=10000;
const until=(predicate:()=>boolean|Promise<boolean>)=>waitForNativeCondition(predicate,NATIVE_REQUEST_TIMEOUT_MS);

async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'paios-amend-')),storage=new PosixStorage(root);
  let creates=0,steers=0,lose=false;
  const runs=new Map<string,NativeRun>(),receipts=new Map<string,unknown>(),texts:string[]=[];
  const stream=nativeRunStreamFixture(runId=>runs.get(runId)!);
  const client=new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',NATIVE_REQUEST_TIMEOUT_MS,1048576,undefined,async(url,init)=>{
    const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    if(path==='/v1/runs'){
      const run={schema:'hermes.run.v2' as const,shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',
        run_id:`run-${++creates}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running',granted_toolsets:body.grant_toolsets};
      runs.set(run.run_id,run);return Response.json(run,{status:202});
    }
    if(path.endsWith('/events'))return stream.response(new URL(String(url)),init?.signal);
    const run=runs.get(path.split('/')[3]!);assert.ok(run);
    if(path.endsWith('/steer')){
      const key=body.amendment_id;let receipt=receipts.get(key);
      if(!receipt){steers++;texts.push(body.text);receipt={object:'hermes.run.steer',run_id:run.run_id,accepted:true,
        amendment_id:key,delivered_to:'delegate',delegate_task_ids:['child-1']};receipts.set(key,receipt);}
      if(lose){lose=false;throw new Error('RESPONSE_LOST');}
      return Response.json(receipt);
    }
    return Response.json(run);
  });
  const makeAdmission=()=>new RunAdmission(storage,client,{max_pending_events:4,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'test'});
  const admission=makeAdmission();
  const ingress=new UnifiedIngress(new RawArchive(storage,10000,()=> '2026-10-01T00:00:00.000Z'));
  const event=(id:string,text=id,principal='owner')=>ingress.accept({schema_version:EVENT_SCHEMA,event_id:id,device_id:'mac',device_type:'mac',
    captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from(text)}, {principal_id:principal,device_id:'mac',device_type:'mac',
    consent_ref:'consent',channel:'text',submission:'explicit_text'});
  t.after(async()=>{await admission.close();await rm(root,{recursive:true,force:true});});
  return {admission,makeAdmission,storage,event,runs,update:(runId:string,patch:Partial<NativeRun>)=>{Object.assign(runs.get(runId)!,patch);stream.update(runId);},texts,counts:()=>({creates,steers}),lose:()=>{lose=true;}};
}

test('detached native task frees owner turn; exact amendment reaches same task once',async t=>{
  const f=await fixture(t),original=await f.event('original'),followup=await f.event('followup','  追加：保留原图\n');
  await f.admission.admit(original,'conversation','skill');await until(()=>f.runs.has('run-1'));
  const queued=await f.admission.admit(followup,'conversation','skill');
  assert.equal(queued.state,'pending');assert.equal(queued.run_id,undefined);
  assert.equal(f.counts().creates,1);
  f.update('run-1',{turn_exit_reason:'delegation_waiting'});
  await until(()=>!!f.admission.find('run-2'));
  assert.equal(f.runs.get('run-1')!.status,'running','delegate remains active while next foreground starts');
  assert.equal(f.admission.find('run-2')!.record.idempotency_key,queued.idempotency_key);
  const targets=f.admission.taskTargets('owner');assert.equal(targets.length,2);
  const receipts=await Promise.all([f.admission.amend(followup,'conversation','run-1',followup.content.text!),
    f.admission.amend(followup,'conversation','run-1',followup.content.text!)]);
  assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0]!.delivered_to,'delegate');
  assert.deepEqual(f.texts,['  追加：保留原图\n']);assert.deepEqual(f.counts(),{creates:2,steers:1});
  assert.equal((await f.storage.list('run-amendment-intents')).length,1);
  assert.equal((await f.storage.list('run-amendment-receipts')).length,1);
});

test('lost steer response retains exact intent and same-key retry cannot duplicate native delivery',async t=>{
  const f=await fixture(t),original=await f.event('original'),followup=await f.event('followup','新增尺寸 90mm');
  await f.storage.publish('processed-events',digest({principal_id:'owner',processed_event_id:followup.processed_event_id}),Buffer.from(canonical(followup)));
  await f.admission.admit(original,'conversation','skill');await until(()=>!!f.admission.find('run-1'));
  f.lose();await assert.rejects(f.admission.amend(followup,'conversation','run-1',followup.content.text!),/RESPONSE_LOST/);
  assert.equal((await f.storage.list('run-amendment-intents')).length,1);
  assert.equal((await f.storage.list('run-amendment-receipts')).length,0);
  const pending=await f.admission.pendingAmendments('owner');assert.equal(pending.length,1);
  assert.equal(pending[0]!.text,followup.content.text);
  await assert.rejects(f.admission.amend(followup,'conversation','run-1','changed bytes'),/IMMUTABLE_CONFLICT/);
  assert.equal((await f.admission.reconcileAmendment('owner','conversation',pending[0]!.amendment_id)).status,'delivered');
  assert.deepEqual(await f.admission.pendingAmendments('owner'),[]);
  assert.deepEqual(f.counts(),{creates:1,steers:1});
  assert.equal((await f.admission.amend(followup,'other-conversation','run-1',followup.content.text!)).status,'delivered');
  await assert.rejects(f.admission.amend(followup,'conversation','missing-run',followup.content.text!),/TARGET_NOT_RUNNING/);
});

test('recovery retains detached poll and current turn barrier; original completion cannot release a newer turn',async t=>{
  const f=await fixture(t),first=await f.event('first'),second=await f.event('second'),third=await f.event('third');
  await f.admission.admit(first,'conversation','skill');await until(()=>!!f.admission.find('run-1'));
  f.update('run-1',{turn_exit_reason:'delegation_waiting'});
  await until(()=>f.admission.find('run-1')?.record.conversation_released===true);
  await f.admission.admit(second,'conversation','skill');await until(()=>!!f.admission.find('run-2'));
  await f.admission.admit(third,'conversation','skill');await f.admission.close();
  const restored=f.makeAdmission();t.after(()=>restored.close());await restored.recover();
  assert.equal(restored.find('run-1')?.record.conversation_released,true);assert.ok(restored.find('run-2'));
  f.update('run-1',{status:'completed'});await until(()=>!restored.find('run-1'));
  assert.equal(f.counts().creates,2,'old task completion cannot drop the current run barrier');
  f.update('run-2',{status:'completed'});await until(()=>!!restored.find('run-3'));
  assert.equal(f.counts().creates,3);
});

test('owner discovers and amends own task across sessions, including pending receipt recovery after reconnect',async t=>{
  const f=await fixture(t),original=await f.event('cron-origin'),followup=await f.event('call-followup','又补一句：尺寸改为90mm'),stranger=await f.event('stranger','伪造追加','other');
  await f.storage.publish('processed-events',digest({principal_id:'owner',processed_event_id:followup.processed_event_id}),Buffer.from(canonical(followup)));
  await f.admission.admit(original,'cron-session-A','skill');await until(()=>!!f.admission.find('run-1'));
  assert.equal(f.admission.taskTargets('owner')[0]!.session_id,'cron-session-A');
  assert.deepEqual(f.admission.taskTargets('other'),[]);
  await assert.rejects(f.admission.amend({...followup,user_identity:'unknown'},'call-session-B','run-1',followup.content.text!),/AMENDMENT_OWNER_REQUIRED/);
  await assert.rejects(f.admission.amend(stranger,'foreign-session','run-1',stranger.content.text!),/TARGET_NOT_RUNNING/);
  f.lose();await assert.rejects(f.admission.amend(followup,'call-session-B','run-1',followup.content.text!),/RESPONSE_LOST/);
  const pending=await f.admission.pendingAmendments('owner');assert.equal(pending[0]!.session_id,'call-session-B');
  assert.deepEqual(await f.admission.pendingAmendments('other'),[]);
  await assert.rejects(f.admission.reconcileAmendment('other','session-C',pending[0]!.amendment_id),/NOT_FOUND/);
  const received=await f.admission.reconcileAmendment('owner','new-session-C',pending[0]!.amendment_id);
  assert.equal(received.run_id,'run-1');assert.deepEqual(f.texts,[followup.content.text]);
  assert.deepEqual(f.counts(),{creates:1,steers:1});assert.deepEqual(await f.admission.pendingAmendments('owner'),[]);
});
