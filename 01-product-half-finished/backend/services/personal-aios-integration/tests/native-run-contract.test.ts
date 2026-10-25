import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sourceClient,decodeNativeRun,type NativeRun} from './native-source-fixture.ts';
const finalWire=JSON.parse(await readFile(new URL('./fixtures/native-final-response/native-proof.json',import.meta.url),'utf8')) as NativeRun;
const memWire=JSON.parse(await readFile(new URL('./fixtures/native-final-response/source-memory-wire.json',import.meta.url),'utf8')) as NativeRun;

test('actual native version producers share one profile/fixed scope/transcript boundary',()=>{
 const run=decodeNativeRun(finalWire,finalWire.profile_home);assert.equal(run.native_final_response_error,undefined);
 const memory=decodeNativeRun(memWire,memWire.profile_home);assert.equal('memory_receipt_source' in memory,false);
 assert.notEqual(memory.session_id,memory.conversation_session_id);
});
test('legacy/future version, foreign authenticated profile and invalid permission do not become acceptance',()=>{
 for(const wire of [{...finalWire,schema:undefined},{...finalWire,schema:'hermes.run.v3'},{...finalWire,memory_write:'true'},null,[]]){
  assert.throws(()=>decodeNativeRun(wire,finalWire.profile_home),/HERMES/);
 }
 assert.throws(()=>decodeNativeRun(finalWire,'/foreign-profile'),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
});
test('retired native write and receipt fields are rejected at the wire boundary',()=>{
 for(const key of ['memory_write','memory_receipt_source','native_memory_receipt_error'])
  assert.throws(()=>decodeNativeRun({...finalWire,[key]:{}}),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
 const changed=structuredClone(finalWire);changed.native_final_response!.sha256='0'.repeat(64);
 assert.equal(decodeNativeRun(changed).native_final_response_error,'NATIVE_FINAL_RESPONSE_BINDING_MISMATCH');
});
test('one NativeRun wire boundary rejects status or stop identity drift',()=>{assert.throws(()=>decodeNativeRun(finalWire,undefined,'foreign'),/HERMES_NATIVE_RUN_BINDING_INVALID/);});


test('care acceptance preserves rotated native identity and rejects an unisolated or obsolete producer',async()=>{
 const body={input:'care',instructions:'skill',session_id:'owner',care_decision:true as const};
 for(const [session_id,accepted] of [['rotated-tip',true],['owner',false]] as const){
  const run={run_id:'care-run',session_id,conversation_session_id:'owner',status:'running'};
  const client=sourceClient({create:async()=>run,status:async()=>run,cancel:async()=>({...run,status:'cancelled'})});
  if(accepted)assert.equal((await client.create(body,'care-key')).session_id,'rotated-tip');
  else await assert.rejects(client.create(body,'care-key'),/HERMES_RUN_SCOPE_NOT_ENFORCED/);
 }
});
