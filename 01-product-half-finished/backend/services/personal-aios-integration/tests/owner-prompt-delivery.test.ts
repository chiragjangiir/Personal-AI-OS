import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonalAIOSRuntime,RunAdmission,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,sha256} from '../src/contracts.ts';
import {policy} from './sealed-replay-check.ts';

const now='2026-10-01T00:00:00.000Z';
const wire=JSON.parse(await fs.readFile(new URL('./fixtures/native-final-response/native-proof.json',import.meta.url),'utf8')) as NativeRun;
for(const kind of ['owner','observation','model-none','model-after-tool','model-reopen-after-cancel'] as const)
test(`owner prompt delivery while a delegated child remains active: ${kind}`,{timeout:15000},async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'paios-owner-delivery-')),storage=new PosixStorage(root);
  const released=Promise.withResolvers<void>(),quickReady=Promise.withResolvers<void>(),completed=Promise.withResolvers<void>();
  const runs=new Map<string,NativeRun>();let creates=0,childActive=true,runtime:PersonalAIOSRuntime;
  const native={create:async()=>{
    const run:NativeRun={run_id:++creates===1?'long':'quick',session_id:'session',conversation_session_id:'session',status:'running'};
    runs.set(run.run_id,run);return {...run};
  },status:async(runId:string)=>{
    const run=runs.get(runId)!;
    if(runId==='long'){released.resolve();return {...run,turn_exit_reason:'delegation_waiting',output:'后台继续处理'};}
    quickReady.resolve();
    return {...run};
  },cancel:async(runId:string)=>({...runs.get(runId)!,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'consent',
    route_version:'route',output_modes:['text'],token_sha256:sha256('fixture')}];
  const errors:unknown[]=[],admission=new RunAdmission(storage,native,policy);
  runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,devices,skill:'fixed',max_read_bytes:8192,
    output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:error=>errors.push(error)}});
  t.after(async()=>{childActive=false;await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  const source=await runtime.authenticate('fixture');
  const submit=(event:string,explicit=true)=>runtime.submit({schema_version:EVENT_SCHEMA,event_id:event,device_id:'mac',device_type:'mac',captured_at:now,
    source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from(event)},source,'session',explicit);
  const first=await submit('long');await released.promise;
  // An actual delegation_waiting snapshot releases the conversational lane while its native run remains live.
  while(!(await admission.readOnly('owner','session',first.processed_event.processed_event_id))?.conversation_released)await new Promise(r=>setTimeout(r,5));
  const {processed_event:d}=await submit('quick',kind!=='observation');
  await quickReady.promise;
  if(kind==='model-none')await runtime.tool('paios_open_reply',{context:{run_id:'quick',session_id:'session',tool_call_id:'silent'},args:{reply_mode:'none'}});
  if(kind==='model-after-tool'){
    await runtime.tool('paios_open_reply',{context:{run_id:'quick',session_id:'session',tool_call_id:'selected'},args:{reply_mode:'text'}});
    await runtime.tool('paios_l5_read',{context:{run_id:'quick',session_id:'session',tool_call_id:'read'},args:{}});
  }
  if(kind==='model-reopen-after-cancel'){
    await runtime.cancelPlayback(source,'session',d.processed_event_id,1);
    await runtime.tool('paios_open_reply',{context:{run_id:'quick',session_id:'session',tool_call_id:'reopen'},args:{reply_mode:'text'}});
  }
  const output='我可以继续和你交谈。';
  Object.assign(runs.get('quick')!,{status:'completed',output,native_final_response:{...wire.native_final_response!,run_id:'quick',session_id:'session',
    after_tool_call_id:kind==='model-reopen-after-cancel'?'reopen':kind==='model-after-tool'?'read':null,
    after_tool_name:kind==='model-reopen-after-cancel'?'paios_open_reply':kind==='model-after-tool'?'paios_l5_read':null,
    previous_message_role:['model-reopen-after-cancel','model-after-tool'].includes(kind)?'tool':'user',sha256:sha256(output)}});
  let delivered:Awaited<ReturnType<PersonalAIOSRuntime['result']>>|undefined;
  await runtime.subscribeResult(source,'session',d.processed_event_id,async value=>{delivered=value;completed.resolve();},error=>{completed.reject(error);});
  await completed.promise;assert.equal(childActive,true);assert.equal(admission.find('long')?.record.state,'running');
  const value=delivered!;
  if(['owner','model-after-tool','model-reopen-after-cancel'].includes(kind)){
    assert.equal(value.result.reply_phase,'sealed');assert.equal(value.result.reply_mode,'text');
    assert.equal(value.result.reply_epoch,kind==='model-reopen-after-cancel'?2:1);
    assert.equal(value.chunks.map(chunk=>chunk.text).join(''),output);assert.equal(value.result.warnings.includes('OPEN_REQUIRED'),false);
    const chunk=value.chunks.at(-1)!;
    const ack={output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,
      route_version:chunk.route_version,highest_contiguous_seq:chunk.seq,status:'rendered' as const,observed_at:now};
    const receipt=await runtime.acknowledge(source,'session',d.processed_event_id,ack);assert.ok(receipt.receipt_ref);
    const replay=await runtime.result(source,'session',d.processed_event_id,{text_replay:'sealed'});
    assert.equal(replay.result.delivery_status,'rendered');assert.equal(replay.result.reply_id,value.result.reply_id);
    const journal=await Promise.all((await storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await storage.read('output-journal',key)).toString())));
    assert.ok(journal.some(entry=>entry.ack?.receipt_ref===receipt.receipt_ref));
  }else{
    assert.deepEqual(value.chunks,[]);assert.equal(value.result.reply_mode,'none');
    assert.equal(value.result.reply_phase,kind==='observation'?'failed':'sealed');
    assert.equal(value.result.warnings.includes('OPEN_REQUIRED'),kind==='observation');
  }
  assert.deepEqual(errors,[]);assert.equal(creates,2);
});
