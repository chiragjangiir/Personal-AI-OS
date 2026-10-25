import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sha256} from '../src/contracts.ts';
import {decodeNativeRun,NATIVE_RUN_SHAPE_SHA256} from './native-source-fixture.ts';
const read=async(name:string)=>JSON.parse(await readFile(new URL('./fixtures/native-final-response/'+name,import.meta.url),'utf8'));
const final=await read('native-proof.json');const memory=await read('source-memory-wire.json');
test('pinned runtime source schema validates actual producer fixtures and rejects future/digest scope',async()=>{
 assert.equal(sha256(await readFile(new URL('../src/native-run.shape.schema.json',import.meta.url))),NATIVE_RUN_SHAPE_SHA256);
 assert.equal(decodeNativeRun(final).native_final_response_error,undefined);assert.equal('memory_receipt_source' in decodeNativeRun(memory),false);
 for(const value of [{...final,shape_sha256:'0'.repeat(64)},{...final,schema:'hermes.run.v3'},{...final,shape_sha256:undefined}])assert.throws(()=>decodeNativeRun(value),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
});
test('retired memory receipt fields are outside the new pinned wire shape',()=>{
 for(const key of ['memory_receipt_source','native_memory_receipt_error','memory_write'])
  assert.throws(()=>decodeNativeRun({...final,[key]:null}),/HERMES_NATIVE_RUN_VERSION_OR_SCOPE_INVALID/);
});
