import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sourceClient,decodeNativeRun,type NativeRun} from './native-source-fixture.ts';
const finalWire=JSON.parse(await readFile(new URL('./fixtures/native-final-response/native-proof.json',import.meta.url),'utf8')) as NativeRun;
const memWire=JSON.parse(await readFile(new URL('./fixtures/native-final-response/source-memory-wire.json',import.meta.url),'utf8')) as NativeRun;

test('actual native version producers share one profile/fixed scope/transcript boundary',()=>{
 const run=decodeNativeRun(finalWire,finalWire.profile_home);assert.equal(run.native_final_response_error,undefined);
 const memory=decodeNativeRun(memWire,memWire.profile_home);assert.equal(memory.native_memory_receipt_error,undefined);
 assert.notEqual(memory.session_id,memory.conversation_session_id);
});
test('legacy/future version, foreign authenticated profile and invalid permission do not become acceptance',()=>{
 for(const wire of [{...finalWire,schema:undefined},{...finalWire,schema:'hermes.run.v3'},{...finalWire,memory_write:'true'},null,[]]){
  assert.throws(()=>decodeNativeRun(wire,finalWire.profile_home),/HERMES/);
 }
 assert.throws(()=>decodeNativeRun(finalWire,'/foreign-profile'),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
});
test('wire receipt forgery rejects source projection while retaining independent native final facts',()=>{
 for(const key of ['profile_home','run_id','session_id','receipt_ref'] as const){
  const wire=structuredClone(memWire);const source=wire.memory_receipt_source as {receipts:{summary:Record<string,unknown>}[]};
  source.receipts[0]!.summary[key]='foreign';
  const decoded=decodeNativeRun(wire,wire.profile_home);assert.equal(decoded.native_memory_receipt_error,'NATIVE_MEMORY_SCOPE_OR_WIRE_INVALID');assert.equal(decoded.status,'completed');
 }
 const wire=structuredClone(memWire);const source=wire.memory_receipt_source as {receipts:{summary:Record<string,unknown>}[]};
 source.receipts[0]!.summary.content='model claims memory';assert.ok(decodeNativeRun(wire).native_memory_receipt_error);
});
test('bad proof only marks body evidence, and MEM-only wire failure cannot revoke a valid final proof',()=>{
 const bad={...finalWire,native_final_response:null};assert.equal(decodeNativeRun(bad).native_final_response,null);
 const changed=structuredClone(finalWire);(changed.native_final_response as {sha256:string}).sha256='0'.repeat(64);
 assert.equal(decodeNativeRun(changed).native_final_response_error,'NATIVE_FINAL_RESPONSE_BINDING_MISMATCH');
 const withBadMemory={...finalWire,memory_receipt_source:{...memWire.memory_receipt_source as object,run_id:'foreign'}};
 const decoded=decodeNativeRun(withBadMemory);assert.ok(decoded.native_memory_receipt_error);assert.equal(decoded.native_final_response_error,undefined);
});

test('one NativeRun wire boundary rejects status or stop identity drift',()=>{assert.throws(()=>decodeNativeRun(finalWire,undefined,'foreign'),/HERMES_NATIVE_RUN_BINDING_INVALID/);});


test('care acceptance preserves rotated native identity and rejects an unisolated or write-enabled producer',async()=>{
 const body={input:'care',instructions:'skill',session_id:'owner',memory_write:false,care_decision:true as const};
 for(const [session_id,memory_write,accepted] of [['rotated-tip',false,true],['owner',false,false],['care-tip',true,false]] as const){
  const run={run_id:'care-run',session_id,conversation_session_id:'owner',memory_write,status:'running'};
  const client=sourceClient({create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})});
  if(accepted)assert.equal((await client.create(body,'care-key')).session_id,'rotated-tip');
  else await assert.rejects(client.create(body,'care-key'),/HERMES_RUN_SCOPE_NOT_ENFORCED/);
 }
});
