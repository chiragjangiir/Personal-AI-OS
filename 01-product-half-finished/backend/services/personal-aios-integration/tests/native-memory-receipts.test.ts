import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {sourceClient} from './native-source-fixture.ts';
import {OutputAuthority, type OutputContext} from '../src/output.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {decodeNativeRun,type NativeRun} from './native-source-fixture.ts';

const profile='/isolated/native-fixture';
const receipt=(status='committed',suffix='1')=>({schema:'hermes.memory_receipt.v1',profile_home:profile,run_id:'native-fixture-run',session_id:'fixture-session',receipt_ref:'memory-receipt:'+suffix.repeat(32),
  attempt_ref:'memory-attempt:'+suffix.repeat(32),
  tool_call_id:'fixture-'+suffix,operation:'add',target:'memory',status,created_at:100,settled_at:101,pending_id:null,predecessor_ref:null});
function run(receipts: Record<string,unknown>[]=[], status='settled', runId='native-fixture-run'): NativeRun {
  // This is an internal domain mock. The actual producer/decoder is exercised below.
  return {schema:'hermes.run.v2',profile_home:profile,run_id:runId,session_id:'fixture-session',conversation_session_id:'fixture-session',status:'completed',output:'sealed final fixture',
    memory_receipt_source:{schema:'hermes.memory_source.v2',profile_home:profile,run_id:runId,session_id:'fixture-session',source:'l2',status:status==='settled'?'complete':'partial',
      error:status==='settled'?null:'NATIVE_MEMORY_COVERAGE_UNKNOWN',
      receipts:receipts.filter(r=>r.status!=='unknown').map(r=>({receipt_ref:r.receipt_ref,status:r.status,kind:'l2',summary:r})),
      unsettled_attempts:receipts.filter(r=>r.status==='unknown')}};
}
async function fixture(t: test.TestContext, home=profile) {
  const path=await mkdtemp(join(tmpdir(),'paios-native-source-')); t.after(()=>rm(path,{recursive:true,force:true}));
  const storage=new PosixStorage(path); const archive=new RawArchive(storage,4096);
  const d=await new UnifiedIngress(archive).accept({schema_version:'paios.event.v1',event_id:'fixture-event',device_id:'mac',device_type:'mac',
    captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'test'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('source binding fixture')},
    {principal_id:'owner',device_id:'mac',device_type:'mac',channel:'test',consent_ref:'fixture',submission:'explicit_text'});
  const ctx:OutputContext={principal_id:'owner',run_id:'native-fixture-run',session_id:'fixture-session',tool_call_id:'open',d,
    target:{device_id:'mac',device_type:'mac',route_version:'fixture-route',output_modes:['text']}};
  let source=run(); let reads=0; let creates=0;
  const native={create:async()=>{creates++; throw new Error('no native execution');},status:async()=>{reads++; return source;},
    cancel:async()=>{throw new Error('no cancellation');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:10000,
    poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'fixture'});
  t.after(()=>admission.close()); let runtime:PersonalAIOSRuntime;
  const config={listRunReceipts:(context:OutputContext)=>runtime.runReceipts(context),
    resolveReceipt:(ref:string,context:OutputContext)=>runtime.resolveReceipt(ref,context)};
  const out=new OutputAuthority(storage,config);
  runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:out,devices:[],skill:'fixture',max_read_bytes:4096,
    native_memory_receipts:{enabled:true,profile_home:home}});
  return {path,storage,ctx,out,config,runtime,reader:{read:async(value:NativeRun,context:OutputContext)=>sourceClient({status:async()=>value,create:async()=>{throw new Error('no create');},cancel:async()=>{throw new Error('no cancel');}}).memory(context.run_id,{conversation_session_id:context.session_id,profile_home:home})},
    set:(value:NativeRun)=>{source=value;},counts:()=>({reads,creates})};
}

test('native source reads actual settlements, excludes unknown attempts and reconciles only receipt state',async t=>{
  const {ctx,out,runtime,set,counts,storage,config}=await fixture(t); const committed=receipt();
  const unknown={...receipt('unknown','2'),receipt_ref:'memory-attempt:'+'2'.repeat(32),settled_at:null};
  set(run([committed,unknown],'unknown'));
  assert.equal((await runtime.runReceipts(ctx)).sources[2]?.status,'partial');
  assert.equal(await runtime.resolveReceipt(unknown.receipt_ref,ctx),null);
  assert.deepEqual((await runtime.resolveReceipt(committed.receipt_ref,ctx))?.summary,committed);
  await out.open(ctx,{reply_mode:'text',receipt_refs:[committed.receipt_ref]});
  const partial=await out.seal(ctx,run());
  assert.equal(partial.receipt_status,'partial'); assert.equal(partial.receipt_sources[2]?.error,'NATIVE_MEMORY_COVERAGE_UNKNOWN');
  assert.deepEqual(partial.l2_updates,[committed]); assert.equal(partial.result_status,'failed');
  set(run([{...committed,status:'failed'}]));
  const conflict=await out.seal(ctx,run());
  assert.equal(conflict.receipt_error,'NATIVE_MEMORY_RECEIPT_CONFLICT'); assert.deepEqual(conflict.l2_updates,[committed]);
  set({...run(),memory_receipt_source:{...run().memory_receipt_source as object,status:'failed',error:'source_read_unavailable'}});
  const unavailable=await new OutputAuthority(storage,config).seal(ctx,run());
  assert.deepEqual(unavailable.l2_updates,[committed]); assert.equal(unavailable.receipt_status,'partial');
  set(run([committed]));
  const recovered=await out.seal(ctx,run()); assert.equal(recovered.receipt_status,'complete');
  assert.equal(recovered.result_status,'completed'); assert.equal(recovered.reply_text,partial.reply_text);
  assert.ok(recovered.result_revision>partial.result_revision); assert.equal(counts().creates,0);
});

test('native source rejects scope/provenance/conflicts and distinguishes empty coverage from unavailable',async t=>{
  const {ctx,reader,out,set}=await fixture(t); const actual=receipt();
  for (const bad of [{...run([actual]),run_id:'foreign'}, {...run([actual]),conversation_session_id:'foreign'}])
    await assert.rejects(reader.read(bad,ctx),/NATIVE_MEMORY|HERMES_NATIVE_RUN_BINDING|NATIVE_CONVERSATION_SCOPE/);
  // Wire mutations are rejected once by the HTTP decoder. The reader projects domain receipts.
  const wire = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('./fixtures/native-final-response/source-memory-wire.json',import.meta.url),'utf8'));
  for (const key of ['profile_home','run_id','session_id','schema','receipt_ref','content']) {
    const bad=structuredClone(wire); bad.memory_receipt_source.receipts[0].summary[key]='foreign';
    assert.equal(decodeNativeRun(bad,wire.profile_home).native_memory_receipt_error,'NATIVE_MEMORY_SCOPE_OR_WIRE_INVALID');
  }
  assert.equal((await reader.read(run(),ctx)).status,'complete');
  assert.equal((await reader.read({...run(),session_id:'actual-transcript-successor'},ctx)).status,'complete');
  assert.equal((await reader.read(run([],'unknown'),ctx)).status,'partial');
  const unknownCtx={...ctx,run_id:'unknown-empty'};
  set(run([],'unknown',unknownCtx.run_id));
  assert.equal((await out.seal(unknownCtx,{...run(),run_id:unknownCtx.run_id})).receipt_status,'unknown');
  for (const reason of ['run_not_instrumented','source_read_unavailable']) {
    const unavailable={...run(),memory_receipt_source:{...run().memory_receipt_source as object,status:'failed',error:reason}};
    assert.equal((await reader.read(unavailable,ctx)).status,'failed'); set(unavailable);
    const isolated={...ctx,run_id:'unavailable-'+reason};
    set({...unavailable,run_id:isolated.run_id,
      memory_receipt_source:{...unavailable.memory_receipt_source,run_id:isolated.run_id}});
    assert.equal((await out.seal(isolated,{...run(),run_id:isolated.run_id})).receipt_status,'unknown');
  }
  set(run([actual,{...actual,status:'failed'}]));
  assert.ok((await out.seal(ctx,run())).warnings.includes('RUN_RECEIPTS_CONFLICT'));
});

test('real native temporary MemoryStore/SessionDB pending successors and source recovery reach OUT',async t=>{
  const sourceRoot=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT ?? '/opt/personal-aios-runtime/hermes-agent';
  const python=process.env.PAIOS_HERMES_PYTHON??join(sourceRoot,'.venv','bin','python');
  try {await access(python); await access(join(sourceRoot,'hermes_state_memory_outcomes.py'));}
  catch {t.skip('isolated native source checkout/venv unavailable'); return;}
  const parent=await mkdtemp(join(tmpdir(),'paios-real-native-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const home=join(parent,'profile');
  const stdout=execFileSync(python,[new URL('./native-memory-fixture.py',import.meta.url).pathname,home],
    {cwd:sourceRoot,env:{...process.env,PYTHONPATH:sourceRoot,HERMES_HOME:home,PAIOS_NATIVE_CONTRACT_SOURCE_ROOT:process.env.PAIOS_NATIVE_CONTRACT_SOURCE_ROOT??sourceRoot},encoding:'utf8',timeout:30000,maxBuffer:262144});
  const actual=JSON.parse(stdout) as {profile_home:string;pending:NativeRun;approved:NativeRun;partial:NativeRun;complete:NativeRun;gap:NativeRun;completion_preserved_file:boolean};
  for(const key of ['pending','approved','partial','complete','gap'] as const)actual[key]=decodeNativeRun(actual[key],actual.profile_home);
  const {ctx,out,set,runtime,storage,config,counts}=await fixture(t,actual.profile_home);
  set(actual.pending); const pending=await runtime.runReceipts(ctx);
  const original=pending.sources[2]!.receipts.find(receipt=>receipt.status==='pending_approval'); assert.ok(original);
  await out.open(ctx,{reply_mode:'text',receipt_refs:[original.receipt_ref]});
  set(actual.approved); const approved=await runtime.runReceipts(ctx);
  assert.deepEqual(approved.sources[2]!.receipts.find(receipt=>receipt.receipt_ref===original.receipt_ref),original);
  const successor=approved.sources[2]!.receipts.find(receipt=>(receipt.summary as {predecessor_ref?:string}).predecessor_ref===original.receipt_ref);
  assert.ok(successor); assert.equal(successor.status,'committed'); assert.notEqual(successor.receipt_ref,original.receipt_ref);
  set(actual.partial); const partial=await out.seal(ctx,actual.complete);
  assert.equal(partial.receipt_status,'partial'); assert.ok(partial.l2_updates.some(r=>(r as {status:string}).status==='rejected'));
  set(actual.complete); const complete=await new OutputAuthority(storage,config).seal(ctx,actual.complete);
  assert.equal(complete.receipt_status,'complete'); assert.deepEqual(complete.l2_updates,partial.l2_updates);
  assert.ok(complete.result_revision>partial.result_revision); assert.equal(counts().creates,0); assert.ok(actual.completion_preserved_file);
  set(actual.gap); const gapCtx={...ctx,run_id:'native-gap-run'};
  const gap=await out.seal(gapCtx,actual.gap);
  assert.equal(gap.receipt_status,'partial'); assert.equal(gap.l2_updates.length,1);
  assert.ok(gap.l2_updates.every(r=>(r as {status:string}).status!=='unknown'));
  const gapSource=actual.gap.memory_receipt_source as {unsettled_attempts:{status:string}[]};
  assert.equal(gapSource.unsettled_attempts.filter(r=>r.status==='unknown').length,1);
});


test('actual producer facts pass through Client and original MEM reader by one reference into receipt business tools',async t=>{
  const wire=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/native-final-response/source-memory-wire.json',import.meta.url),'utf8'));
  const client=sourceClient({status:async()=>wire,create:async()=>{throw new Error('no create');},cancel:async()=>{throw new Error('no cancel');}});
  let qualified:NativeRun|undefined;const originalStatus=client.status.bind(client);
  client.status=async(...args)=>{qualified=await originalStatus(...args);return qualified;};
  const facts=await client.memory(wire.run_id,{conversation_session_id:wire.conversation_session_id,profile_home:wire.profile_home});
  assert.strictEqual(facts,qualified!.memory_receipt_source);assert.deepEqual(facts,wire.memory_receipt_source);
  for(const receipt of facts.receipts){assert.deepEqual(Object.keys(receipt.summary as object).sort(),
    ['schema','profile_home','run_id','session_id','receipt_ref','attempt_ref','tool_call_id','operation','target','status','created_at','settled_at','pending_id','predecessor_ref'].sort());}
});
