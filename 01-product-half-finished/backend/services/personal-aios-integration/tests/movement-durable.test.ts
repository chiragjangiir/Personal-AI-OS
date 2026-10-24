import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {PHONE_CAPABILITIES} from '../src/source-authority.ts';

test('real runtime acknowledges stored movement before a failed phone event projection',{timeout:10000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'movement-durable-'));
  const storage=new PosixStorage(root),order:string[]=[];
  const source={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'rtc_typed_text',
    capabilities:PHONE_CAPABILITIES,consent_ref:'consent',route_version:'route',output_modes:['text']} as const;
  const run={run_id:'move-run',session_id:'session',conversation_session_id:'session',status:'running'};
  let status='running';
  const native:NativeClient={create:async()=>({...run,status}),status:async()=>({...run,status}),cancel:async()=>{status='cancelled';return {...run,status};}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,
    poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'movement'});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,
    sourceAuthority:{revalidate:async()=>source} as never,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})})});
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  await runtime.watchCare(source as never,async()=>true,undefined,undefined,()=>true,undefined,undefined,
    {session:'session',move:async()=>{},event:async()=>{order.push('projection');throw new Error('controlled projection failure');}} as never);
  const submit=runtime.submit.bind(runtime);
  runtime.submit=async(...args)=>{const accepted=await submit(...args);order.push('stored');return accepted;};
  const body={operation:'ride_state' as const,ride_id:'00000000-0000-4000-8000-000000000001',state:'started' as const,
    at:'2026-10-18T00:00:00.000Z',started_by:'phone' as const};
  await assert.rejects(runtime.move(source as never,body,async()=>{order.push('ack');}),/controlled projection failure/);
  assert.deepEqual(order,['stored','ack','projection']);
});
