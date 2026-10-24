import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha256} from '../src/contracts.ts';
import {decodeNativeRun,NATIVE_RUN_SHAPE_SHA256} from './native-source-fixture.ts';
const read=async(name:string)=>JSON.parse(await readFile(new URL('./fixtures/native-final-response/'+name,import.meta.url),'utf8'));
const final=await read('native-proof.json');const memory=await read('source-memory-wire.json');
test('pinned runtime source schema validates actual producer fixtures and rejects future/digest scope',async()=>{
 assert.equal(sha256(await readFile(new URL('../src/native-run.shape.schema.json',import.meta.url))),NATIVE_RUN_SHAPE_SHA256);
 assert.equal(decodeNativeRun(final).native_final_response_error,undefined);assert.equal(decodeNativeRun(memory).native_memory_receipt_error,undefined);
 for(const value of [{...final,shape_sha256:'0'.repeat(64)},{...final,schema:'hermes.run.v3'},{...final,shape_sha256:undefined}])assert.throws(()=>decodeNativeRun(value),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
});
test('MEM schema failure is independent from valid final proof and never derives coverage or authority',()=>{
 const run={...final,memory_receipt_source:structuredClone(memory.memory_receipt_source)};
 run.memory_receipt_source.receipts[0].summary.pending_id=42;
 const decoded=decodeNativeRun(run);assert.equal(decoded.native_memory_receipt_error,'NATIVE_MEMORY_SCOPE_OR_WIRE_INVALID');
 assert.equal(decoded.native_final_response_error,undefined);assert.equal(decoded.status,final.status);
 for(const mutate of [(source:any)=>source.receipts.push(...Array(257).fill(source.receipts[0])),(source:any)=>source.receipts[0].summary.run_id='foreign']){
  const bad={...final,memory_receipt_source:structuredClone(memory.memory_receipt_source)};mutate(bad.memory_receipt_source);
  assert.equal(decodeNativeRun(bad).native_memory_receipt_error,'NATIVE_MEMORY_SCOPE_OR_WIRE_INVALID');
 }
});
test('proof schema failure stays component failure; cross-network body binding remains mandatory',()=>{
 for(const mutate of [(proof:any)=>proof.message_id='1',(proof:any)=>proof.message_id=9007199254740992,(proof:any)=>proof.previous_message_id=9007199254740992,(proof:any)=>proof.phase='stream',(proof:any)=>proof.turn_id='',(proof:any)=>proof.sha256='0'.repeat(64)]){
  const bad=structuredClone(final);mutate(bad.native_final_response);const decoded=decodeNativeRun(bad);
  assert.equal(decoded.native_final_response_error,'NATIVE_FINAL_RESPONSE_BINDING_MISMATCH');assert.equal(decoded.status,final.status);
 }
});
