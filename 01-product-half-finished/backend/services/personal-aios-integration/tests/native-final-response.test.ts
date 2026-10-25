import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutputAuthority, type OutputContext,type OutputConfig,type OpenReplyRequest} from '../src/output.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {EVENT_SCHEMA,sha256} from '../src/contracts.ts';
import {inspectWav} from '../src/tts.ts';
import {decodeNativeRun,type NativeRun,type NativeFinalResponse} from './native-source-fixture.ts';
const root=tmpdir();
const fromNative=decodeNativeRun(JSON.parse(await fs.readFile(new URL('./fixtures/native-final-response/native-proof.json',import.meta.url),'utf8'))) as NativeRun & {native_final_response:NativeFinalResponse};
async function fixture(t:test.TestContext,tts?:OutputConfig['tts'],mode:OpenReplyRequest['reply_mode']='text'){
 const path=await fs.mkdtemp(join(root,'out-'));t.after(()=>fs.rm(path,{recursive:true,force:true}));
 const storage=new PosixStorage(path),d=await new UnifiedIngress(new RawArchive(storage,4096)).accept({schema_version:EVENT_SCHEMA,event_id:'event',device_id:'mac',device_type:'mac',captured_at:'2026-10-05T00:00:00.000Z',source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('prompt')},
 {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'consent',channel:'text',submission:'explicit_text'});
 const ctx:OutputContext={principal_id:'owner',run_id:'run',session_id:'conversation',tool_call_id:'open',d,target:{device_id:'mac',device_type:'mac',route_version:'route',output_modes:['text','voice']}};
 const out=new OutputAuthority(storage,{...(tts?{tts}:{}),chunkChars:8});await out.open(ctx,{reply_mode:mode==='none'?'none':tts?'text_and_voice':mode});return {out,ctx,storage};
}
test('actual native SQLite row proof binds existing OPEN epoch and preserves legal JSON',async t=>{
 const {out,ctx,storage}=await fixture(t),run=structuredClone(fromNative);
 const result=await out.seal(ctx,run),chunks=await out.chunks(ctx,run);
 assert.equal(result.result_status,'completed');assert.equal(result.reply_text,run.output);
 assert.equal(chunks.map(x=>x.text).join(''),run.output);assert.match(chunks[0]!.message_ref,/^native-message:session:/);
 assert.equal(result.native_final_response!.reply_epoch,1);assert.equal(result.native_final_response!.message_id,run.native_final_response.message_id);
 assert.ok(result.warnings.includes('FINAL_BUFFER_DURABLE_ASSISTANT_BOUNDARY'));assert.equal(result.delivery_status,'unknown');
 const durable=await new OutputAuthority(storage).readSealedText(ctx);assert.deepEqual(durable.result.native_final_response,result.native_final_response);
});
test('turn-limit final keeps its proven text, durable replay and voice',async t=>{
 const b=Buffer.alloc(48);b.write('RIFF');b.writeUInt32LE(40,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);
 b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4,40);
 const voiced=Promise.withResolvers<void>();let calls=0;
 const {out,ctx,storage}=await fixture(t,{synthesize:async text=>{calls++;assert.equal(text,fromNative.output);return inspectWav(b);}});
 out.setVoiceOwner(async context=>{if((await out.readFinalized(context)).result.voice_status==='ready')voiced.resolve();});
 const run=decodeNativeRun({...fromNative,status:'failed',turn_exit_reason:'max_iterations_reached(8/8)'});
 const result=await out.seal(ctx,run);assert.equal(result.run_status,'failed');assert.equal(result.result_status,'completed');
 assert.equal(result.reply_text,run.output);assert.ok(result.native_final_response);assert.equal(result.failure_notice,undefined);
 await voiced.promise;const durable=await new OutputAuthority(storage).readSealedText(ctx);
 assert.equal(durable.chunks.map(c=>c.text).join(''),run.output);assert.equal(durable.voice_chunks.length,1);assert.equal(calls,1);
 await assert.rejects(out.seal(ctx,{...run,turn_exit_reason:'provider_error'}),/OUTPUT_REPLAY_CONFLICT/);
});
test('turn limit without a proven final exposes an honest receipt-based notice, never model text or voice',async t=>{
 let calls=0;const {ctx,storage}=await fixture(t,{synthesize:async()=>{calls++;throw Error('must not synthesize');}});
 const statuses=['committed','pending_approval','reconcile_required'];
 const out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[{source:'action',status:'complete',error:null,
  receipts:statuses.map(status=>({receipt_ref:status,status,kind:'action',summary:{status}}))}]}),tts:{synthesize:async()=>{calls++;throw Error('must not synthesize');}}});
 for(const run_id of ['run','no-open']){
  const run:NativeRun={...fromNative,run_id,status:'failed',turn_exit_reason:'max_iterations_reached(2/2)',output:'unproven summary'};delete run.native_final_response;
  const value=await out.seal({...ctx,run_id},decodeNativeRun(run));assert.equal(value.reply_text,'');assert.equal(value.result_status,'failed');
  assert.match(value.failure_notice!,/依米.*用完了步骤/);assert.match(value.failure_notice!,/1 项已完成，1 项待你确认，1 项结果待核对/);
  assert.deepEqual(await out.chunks({...ctx,run_id},run),[]);assert.equal(calls,0);
 }
});
test('unproven fallback remains explicitly unverified and preserves code or JSON',async t=>{
 const {out,ctx}=await fixture(t);const run:NativeRun={...fromNative,output:'```json\n{"reply_id":"a user requested field"}\n```'};delete run.native_final_response;
 const result=await out.seal(ctx,run);assert.equal(result.reply_text,run.output);assert.ok(result.warnings.includes('FINAL_BUFFER_NO_VERIFIED_MESSAGE_BOUNDARY'));
 assert.equal(result.native_final_response,undefined);
});
const changes:Record<string,(p:NativeFinalResponse)=>void>={hash:(p:NativeFinalResponse)=>p.sha256='0'.repeat(64),run:(p:NativeFinalResponse)=>p.run_id='other',session:(p:NativeFinalResponse)=>p.session_id='other',phase:(p:NativeFinalResponse)=>(p as {phase:string}).phase='stream',row:(p:NativeFinalResponse)=>p.message_id=0,turn:(p:NativeFinalResponse)=>p.turn_id='',open:(p:NativeFinalResponse)=>p.after_tool_call_id='other-open',toolname:(p:NativeFinalResponse)=>p.after_tool_name='paios_l5_read'};
for(const status of ['completed','failed'])for(const [label,change] of Object.entries(changes)){
 test(`received ${label} drift fails ${status} reply without TTS`,async t=>{
  let calls=0;const {out,ctx}=await fixture(t,{synthesize:async()=>{calls++;throw new Error('must not synthesize');}});
  const run=structuredClone(fromNative);run.status=status;if(status==='failed')run.turn_exit_reason='max_iterations_reached(8/8)';change(run.native_final_response);const result=await out.seal(ctx,decodeNativeRun(run));
  assert.equal(result.reply_status,['open','toolname'].includes(label)?'partial':'failed');assert.equal(result.reply_text,'');assert.equal(result.run_status,status);assert.equal(result.delivery_status,'unknown');assert.equal(calls,0);
  assert.deepEqual(await out.chunks(ctx,decodeNativeRun(run)),[]);assert.equal(result.native_final_response,undefined);assert.ok(result.warnings.includes(['open','toolname'].includes(label)?'OPEN_PHASE_INVALIDATED_BY_NATIVE_BOUNDARY':'NATIVE_FINAL_RESPONSE_BINDING_MISMATCH'));
 });
}
test('source revalidation failure cannot silently fall back',async t=>{
 const {out,ctx}=await fixture(t);const result=await out.seal(ctx,{...fromNative,native_final_response_error:'NATIVE_FINAL_RESPONSE_SOURCE_UNAVAILABLE'});
 assert.equal(result.reply_status,'failed');assert.equal(result.reply_text,'');
});
test('later OPEN epoch rejects earlier proven assistant',async t=>{
 const {out,ctx}=await fixture(t);await out.open({...ctx,tool_call_id:'open-later'},{reply_mode:'text'});
 const result=await out.seal(ctx,fromNative);assert.equal(result.reply_epoch,2);assert.equal(result.reply_phase,'interrupted');
});
test('cancelled epoch suppresses matching proof and body',async t=>{
 const {out,ctx}=await fixture(t);await out.cancel(ctx,1);const result=await out.seal(ctx,fromNative);
 assert.equal(result.reply_phase,'interrupted');assert.equal(result.reply_text,'');assert.equal(result.native_final_response,undefined);
});
test('sealed replay rejects changed evidence and body, even if new body has matching hash',async t=>{
 const {out,ctx}=await fixture(t);await out.seal(ctx,fromNative);const run=structuredClone(fromNative);run.output='different';run.native_final_response.sha256=sha256(run.output);
 await assert.rejects(out.seal(ctx,run),/OUTPUT_REPLAY_CONFLICT/);
});

test('platform receipt read failure preserves actual native proof and body independently',async t=>{
 const {ctx,storage}=await fixture(t);const run=decodeNativeRun(JSON.parse(await fs.readFile(new URL('./fixtures/native-final-response/native-proof-memory-failure.json',import.meta.url),'utf8')));
 const out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[{source:'l3',status:'failed',error:'L3_UNAVAILABLE',receipts:[]}]})});
 const result=await out.seal(ctx,run);assert.equal(result.receipt_status,'unknown');assert.equal(result.receipt_sources[0]!.status,'failed');assert.equal(result.reply_text,run.output);assert.equal(result.reply_status,'complete');assert.ok(result.native_final_response);
 assert.deepEqual(result.l3_updates,[]);assert.deepEqual(result.actions,[]);assert.equal('memory_receipt_source' in run,false);
});
test('E15 silent completed ignores all real API proof shapes, retains pending receipts, and makes no body/TTS',async t=>{
 let calls=0;const f=await fixture(t,{synthesize:async()=>{calls++;throw new Error('silent must not synthesize');}},'none');
 const receipt={receipt_ref:'l3:controlled',status:'pending_approval',kind:'l3' as const,summary:{status:'pending_approval',receipt_ref:'l3:controlled'}};
 const out=new OutputAuthority(f.storage,{tts:{synthesize:async()=>{calls++;throw new Error('silent must not synthesize');}},listRunReceipts:async()=>({sources:[{source:'l3',status:'complete',error:null,receipts:[receipt]}]})});
 const missing=structuredClone(fromNative) as NativeRun;delete missing.native_final_response;
 const cases:NativeRun[]=[missing,{...fromNative,native_final_response:null},{...fromNative,native_final_response_error:'NATIVE_FINAL_RESPONSE_SOURCE_UNAVAILABLE'},structuredClone(fromNative)];
 for(const run of cases){
  const result=await out.seal(f.ctx,run);assert.equal(result.run_status,'completed');assert.equal(result.reply_status,'none');assert.equal(result.result_status,'completed');
  assert.equal(result.reply_text,'');assert.deepEqual(await out.chunks(f.ctx,run),[]);assert.deepEqual(await out.voiceChunks(f.ctx,run),[]);assert.deepEqual(result.l3_updates,[receipt.summary]);
  assert.equal(result.native_final_response,undefined);assert.equal(result.delivery_status,'unknown');assert.equal(calls,0);
 }
});

test('E15 cancelled native run remains interrupted with silent OPEN',async t=>{
 const {out,ctx}=await fixture(t,undefined,'none');const run={...fromNative,status:'cancelled'};
 const result=await out.seal(ctx,run);assert.equal(result.result_status,'interrupted');assert.equal(result.reply_phase,'interrupted');assert.equal(result.run_status,'cancelled');assert.equal(result.reply_text,'');assert.deepEqual(await out.chunks(ctx,run),[]);
});

test('actual native OPEN/tool/interim sequences close old epoch at existing seal owner; reopened epoch succeeds',async t=>{
 const sequences=JSON.parse(await fs.readFile(new URL('./fixtures/native-final-response/native-sequences.json',import.meta.url),'utf8')) as {case:string;native:NativeRun}[];
 for(const sequence of sequences){
  const {out,ctx}=await fixture(t);
  if(['parallel-read-open','open-read-reopen','parallel-two-open'].includes(sequence.case))await out.open({...ctx,tool_call_id:'open-again'},{reply_mode:'text'});
  const result=await out.seal(ctx,sequence.native);
  if(['parallel-read-open','open-read-reopen','parallel-two-open'].includes(sequence.case)){
   assert.equal(result.reply_status,'complete');assert.equal(result.native_final_response!.reply_epoch,2);assert.equal(result.reply_text,sequence.native.output);
  }else{
   assert.equal(result.reply_phase,'interrupted');assert.equal(result.run_status,'completed');assert.equal(result.reply_text,'');assert.ok(result.warnings.includes('OPEN_PHASE_INVALIDATED_BY_NATIVE_BOUNDARY'));
   const durable=await out.readFinalized(ctx);assert.equal(durable.result.reply_phase,'interrupted');assert.deepEqual(durable.chunks,[]);
  }
 }
});

test('sealed body survives later native diagnostic error and missing proof, but identity drift still conflicts',async t=>{
 const {out,ctx,storage}=await fixture(t);const first=await out.seal(ctx,fromNative);
 const transient={...fromNative,native_final_response_error:'NATIVE_FINAL_RESPONSE_SOURCE_UNAVAILABLE'};
 assert.equal((await out.seal(ctx,transient)).reply_text,first.reply_text);
 const missing:NativeRun={...transient};delete missing.native_final_response;
 assert.equal((await out.seal(ctx,missing)).reply_text,first.reply_text);
 assert.equal((await new OutputAuthority(storage).readSealedText(ctx)).result.reply_text,first.reply_text);
 const drift=structuredClone(fromNative);drift.native_final_response.message_id++;
 await assert.rejects(out.seal(ctx,drift),/OUTPUT_REPLAY_CONFLICT/);
});

test('actual GET compaction and transient proof read preserve already sealed text and durable ACK owner',async t=>{
 const {out,ctx}=await fixture(t);
 const wires=JSON.parse(await fs.readFile(new URL('./fixtures/native-final-response/native-lifecycle.json',import.meta.url),'utf8')) as NativeRun[];
 const first=await out.seal(ctx,wires[0]!);
 const chunks=await out.chunks(ctx,wires[0]!);const chunk=chunks[0]!;
 const receipt=await out.ack(ctx,{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:chunk.target_device_id,route_version:chunk.route_version,highest_contiguous_seq:chunks.length,status:'rendered',observed_at:'2026-10-05T00:00:00.000Z'});
 assert.ok(receipt.receipt_ref);
 for(const run of wires.slice(1)){const replay=await out.seal(ctx,run);assert.equal(replay.reply_text,first.reply_text);assert.equal(replay.delivery_status,'rendered');}
 assert.equal((await out.readSealedText(ctx)).result.reply_text,first.reply_text);
});
