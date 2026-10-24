import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceClient,HermesClient,type NativeClient,type NativeRun} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
const body={input:'controlled',instructions:'fixed',session_id:'shared',memory_write:false};
function fixture(run:NativeRun):NativeClient{return {create:async()=>run,status:async()=>run,cancel:async()=>run};}
test('reused raw-fetch seam still rejects future source schema',async()=>{
 const run:NativeRun={run_id:'one',session_id:'shared',conversation_session_id:'shared',status:'completed'};Reflect.set(run,'schema','future');const client=sourceClient(fixture(run));
 await assert.rejects(client.status('one'),/VERSION_OR_SCOPE_INVALID/);
});
test('reused raw-fetch seam preserves cross-run and conversation binding rejection',async()=>{
 const client=sourceClient(fixture({run_id:'other',session_id:'shared',conversation_session_id:'foreign',status:'completed'}));
 await assert.rejects(client.status('wanted'),/RUN_BINDING_INVALID/);await assert.rejects(client.create(body,'stable-key'),/CONVERSATION_SCOPE_MISMATCH/);
});
test('one original client qualification preserves grant, key, cancel and deferred native state',async()=>{
 const release=Promise.withResolvers<void>();let calls=0,stops=0;const native:NativeClient={create:async(actual,key)=>{assert.deepEqual(actual,body);assert.equal(key,'stable-key');calls++;await release.promise;return {run_id:'one',session_id:'shared',conversation_session_id:'shared',status:'running'};},status:async id=>({run_id:id,session_id:'shared',conversation_session_id:'shared',status:'completed'}),cancel:async id=>{stops++;return {run_id:id,session_id:'shared',conversation_session_id:'shared',status:'running'};}};
 const client=sourceClient(native);assert.ok(client instanceof HermesClient);assert.equal(sourceClient(native),client);let done=false;const pending=client.create(body,'stable-key').then(value=>{done=true;return value;});await Promise.resolve();assert.equal(done,false);release.resolve();assert.equal((await pending).status,'running');assert.equal((await client.cancel('one')).status,'running');assert.equal(calls,1);assert.equal(stops,1);
});
