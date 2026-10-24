import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {decodeNativeRun,nativeConversationSession,type NativeRun} from './native-source-fixture.ts';
import {readSourceMemory} from './native-source-fixture.ts';
import {RunAdmission,type AdmissionEntry} from './native-source-fixture.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {OutputAuthority,type OutputContext} from '../src/output.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {EVENT_SCHEMA,sha256} from '../src/contracts.ts';
import {policy} from './sealed-replay-check.ts';

const nativeProof=decodeNativeRun(JSON.parse(await readFile(new URL('./fixtures/native-final-response/native-session-lineage-versioned.json',import.meta.url),'utf8')));
const scope=nativeConversationSession(nativeProof);
const device={principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'fixture',
  route_version:'fixture',output_modes:['text'],token_sha256:sha256('fixture-token')};
const invalidFields=[{}, {conversation_session_id:''}, {conversation_session_id:23}, {session_id:undefined},
  {session_id:''}, {session_id:23}];
async function setup(t:test.TestContext,initial:NativeRun,automatic=false) {
  const path=await mkdtemp(join(tmpdir(),'paios-lineage-consumer-'));
  const storage=new PosixStorage(path),statusRelease=Promise.withResolvers<void>();let creates=0;
  const native={create:async(body:{session_id:string})=>{assert.equal(body.session_id,scope);creates++;return structuredClone(initial);},
    status:async()=>{await statusRelease.promise;return structuredClone(nativeProof);},
    cancel:async()=>({...structuredClone(nativeProof),status:'cancelled'})};
  const admission=new RunAdmission(storage,native,policy);let owner:((entry:AdmissionEntry,native:NativeRun|undefined)=>Promise<void>)|undefined;
  const original=admission.setTerminalOwner.bind(admission);
  admission.setTerminalOwner=callback=>{owner=callback;original(callback);};
  let runtime:PersonalAIOSRuntime;const errors:unknown[]=[];
  const out=new OutputAuthority(storage,{listRunReceipts:context=>runtime.runReceipts(context),
    resolveReceipt:(ref,context)=>runtime.resolveReceipt(ref,context)});
  runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:out,
    devices:[device],skill:'source fixture',max_read_bytes:8192,
    native_memory_receipts:{enabled:true,profile_home:nativeProof.profile_home!},
    ...(automatic?{automatic_output:{onError:(error:unknown)=>errors.push(error)}}:{})});
  t.after(async()=>{statusRelease.resolve();await runtime.close();await rm(path,{recursive:true,force:true});});
  const trusted=await runtime.authenticate('fixture-token');
  const event={schema_version:EVENT_SCHEMA,event_id:'one-logical-d',device_id:'mac',device_type:'mac' as const,
    captured_at:'2026-10-02T00:00:00.000Z',source:{channel:'text'},media_type:'text' as const,
    mime:'text/plain;charset=utf-8',representation:'uploaded_original' as const,payload:Buffer.from('same original D')};
  const submitted=await runtime.submit(event,trusted,scope,true);
  const ctx:OutputContext={principal_id:'owner',run_id:nativeProof.run_id,session_id:scope,tool_call_id:'open',d:submitted.processed_event,
    target:{device_id:'mac',device_type:'mac',route_version:'fixture',output_modes:['text']}};
  return {runtime,admission,out,submitted,ctx,trusted,event,statusRelease,errors,owner:()=>owner!,creates:()=>creates};
}
async function eventually(predicate:()=>boolean) {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('existing admission owner did not reach expected state');
}
function damaged(fields:Record<string,unknown>):NativeRun {
  const value={...structuredClone(nativeProof),...fields};
  if(!Object.keys(fields).length)delete value.conversation_session_id;
  return value as NativeRun;
}

test('real native GET proof reaches existing Admission, L2 reader and OUT with one unchanged D/run',{timeout:10000},async t=>{
  assert.notEqual(nativeProof.session_id,scope);
  const f=await setup(t,nativeProof,true);
  await eventually(()=>!!f.admission.find(nativeProof.run_id,scope));
  assert.deepEqual(await f.runtime.tool('paios_open_reply',{context:{run_id:nativeProof.run_id,
    session_id:nativeProof.session_id!,tool_call_id:'foreign-active'},args:{reply_mode:'text'}}),
    {status:'pending',error_code:'RUN_BINDING_PENDING'});
  const opened=await f.runtime.tool('paios_open_reply',{context:{run_id:nativeProof.run_id,session_id:scope,tool_call_id:'open'},
    args:{reply_mode:'text'}});
  assert.ok(opened);const delivered=Promise.withResolvers<Awaited<ReturnType<PersonalAIOSRuntime['result']>>>();
  await f.runtime.subscribeResult(f.trusted,scope,f.submitted.processed_event.processed_event_id,
    async value=>delivered.resolve(value),error=>delivered.reject(error));
  f.statusRelease.resolve();const result=await delivered.promise;
  assert.equal(result.admission.run_id,nativeProof.run_id);assert.equal(result.admission.session_id,scope);
  assert.equal(result.result.receipt_status,'complete');
  assert.deepEqual(result.result.l2_updates,(nativeProof.memory_receipt_source as {receipts:{summary:unknown}[]}).receipts.map(r=>r.summary));
  const replay=await f.runtime.submit(f.event,f.trusted,scope,true);
  assert.deepEqual(replay.processed_event,f.submitted.processed_event);assert.equal(f.creates(),1);assert.equal(f.errors.length,0);
});

test('missing conversation or transcript identity rejects explicit new contract and source/OUT consumption',async t=>{
  const f=await setup(t,nativeProof);await eventually(()=>!!f.admission.find(nativeProof.run_id,scope));
  for(const fields of invalidFields){const bad=damaged(fields);
    assert.throws(()=>nativeConversationSession(bad),/NATIVE_(CONVERSATION_SCOPE|TRANSCRIPT_IDENTITY)_UNAVAILABLE/);
    // Raw wire type errors fail at the original decoder; absent/empty identities keep the native availability error.
    const expected=typeof bad.conversation_session_id==='number' || typeof bad.session_id==='number' ?
      /^HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID$/ : /NATIVE_(CONVERSATION_SCOPE|TRANSCRIPT_IDENTITY)_UNAVAILABLE/;
    await assert.rejects(readSourceMemory(bad,f.ctx,nativeProof.profile_home!),error=>error instanceof Error && expected.test(error.message));
    await assert.rejects(f.out.seal(f.ctx,bad),/NATIVE_(CONVERSATION_SCOPE|TRANSCRIPT_IDENTITY)_UNAVAILABLE/);
  }
});

test('legacy or malformed create stays in existing reconciliation owner without an inferred binding',async t=>{
  for(const fields of invalidFields){const f=await setup(t,damaged(fields));
    await eventually(()=>f.admission.get('owner',scope,f.submitted.processed_event.processed_event_id)?.state==='reconcile_required');
    assert.equal(f.admission.find(nativeProof.run_id,scope),undefined);assert.equal(f.creates(),1);
  }
});

test('terminal owner notifies and removes existing subscribers when native identity parsing fails',async t=>{
  for(const fields of invalidFields){const f=await setup(t,nativeProof,true);
    await eventually(()=>!!f.admission.find(nativeProof.run_id,scope));
    let notifications=0;const notified=Promise.withResolvers<void>();
    await f.runtime.subscribeResult(f.trusted,scope,f.submitted.processed_event.processed_event_id,
      async()=>assert.fail('invalid native identity cannot deliver a result'),error=>{
        assert.match(String(error),/NATIVE_(CONVERSATION_SCOPE|TRANSCRIPT_IDENTITY)_UNAVAILABLE/);
        notifications++;notified.resolve();});
    const entry=f.admission.find(nativeProof.run_id,scope)!;
    await assert.rejects(f.owner()(entry,damaged(fields)),/NATIVE_(CONVERSATION_SCOPE|TRANSCRIPT_IDENTITY)_UNAVAILABLE/);await notified.promise;
    await assert.rejects(f.owner()(entry,damaged(fields)),/NATIVE_(CONVERSATION_SCOPE|TRANSCRIPT_IDENTITY)_UNAVAILABLE/);assert.equal(notifications,1);assert.equal(f.errors.length,2);
  }
});
