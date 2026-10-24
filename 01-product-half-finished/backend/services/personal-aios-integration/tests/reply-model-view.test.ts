import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,canonical,sha256} from '../src/contracts.ts';
import {policy} from './sealed-replay-check.ts';
async function fixture(t: TestContext) {
  const home=await fs.mkdtemp(join(tmpdir(),'paios-reply-model-view-'));const observed=Promise.withResolvers<void>();
  const storage=new PosixStorage(home);let input='';let terminal=false;
  const native={create:async(body:{input:string})=>{input=body.input;return {run_id:'run',session_id:'session',conversation_session_id:'session',status:'running'};},
    status:async()=>{observed.resolve();return ({run_id:'run',session_id:'session',conversation_session_id:'session',status:terminal?'completed':'running',output:'Opened cleanly: reply_id from prior native history'});},
    cancel:async()=>({run_id:'run',session_id:'session',conversation_session_id:'session',status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'text',consent_ref:'consent',route_version:'route',output_modes:['text','voice'],token_sha256:sha256('fixture')}];
  const output=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,policy),native,output,devices,skill:'fixed',max_read_bytes:8192});
  t.after(async()=>{try {await runtime.close();} finally {await fs.rm(home,{recursive:true,force:true});}});
  const source=await runtime.authenticate('fixture');
  const {processed_event:d}=await runtime.submit({schema_version:EVENT_SCHEMA,event_id:'input',device_id:'mac',device_type:'mac',captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('用户内容')},source,'session',true);
  await observed.promise;
  const context={run_id:'run',session_id:'session',tool_call_id:'open'};
  const ctx={...context,principal_id:'owner',d,target:{device_id:'mac',device_type:'mac' as const,route_version:'route',output_modes:devices[0]!.output_modes}};
  return {runtime,storage,output,source,d,context,ctx,input,complete:()=>{terminal=true;}};
}
for (const [mode,status,code] of [['text','opened',null],['none','silent',null],['voice','failed','TTS_NOT_CONFIGURED']] as const) {
  test(`model OPEN ${status} is minimal; authoritative receipt and same-call replay survive`,async t=>{
    const f=await fixture(t);const args={reply_mode:mode};
    const model=await f.runtime.tool('paios_open_reply',{context:f.context,args});
    assert.deepEqual(model,{status,error_code:code});
    const full=await f.output.open(f.ctx,args);
    assert.equal(full.status,status);assert.match(full.receipt_ref,/^out:/);assert.equal(full.reply_epoch,1);assert.equal(full.route_version,'route');assert.equal(full.phase,'final_buffer');
    assert.deepEqual(await f.runtime.tool('paios_open_reply',{context:f.context,args}),model);
    assert.deepEqual(await f.output.open(f.ctx,args),full);
    assert.deepEqual(await new OutputAuthority(f.storage,{listRunReceipts:async()=>({sources:[]})}).open(f.ctx,args),full);
    assert.equal(f.input,canonical(f.d));
    await assert.rejects(f.runtime.tool('paios_open_reply',{context:f.context,args:{reply_mode:mode==='none'?'text':'none'}}),/OUTPUT_REPLAY_CONFLICT/);
  });
}
test('rejected target retains reason without receipt identities',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.runtime.tool('paios_open_reply',{context:f.context,args:{reply_mode:'text',target_aliases:['other']}}),{status:'rejected',error_code:'OUTPUT_TARGET_DENIED'});
});
test('journal failure cannot return opened to model',async t=>{
  const f=await fixture(t);f.storage.publish=async()=>{throw new Error('controlled durable write failure');};
  await assert.rejects(f.runtime.tool('paios_open_reply',{context:f.context,args:{reply_mode:'text'}}),/controlled durable write failure/);
});
test('negative acceptance: prior native prose is still authoritative; candidate does not claim body isolation',async t=>{
  const f=await fixture(t);await f.runtime.tool('paios_open_reply',{context:f.context,args:{reply_mode:'text'}});f.complete();
  const result=await f.runtime.result(f.source,'session',f.d.processed_event_id);
  assert.equal(result.result.reply_text,'Opened cleanly: reply_id from prior native history');
  assert.equal(result.chunks.map(x=>x.text).join(''),result.result.reply_text);
  assert.ok(result.result.warnings.includes('FINAL_BUFFER_NO_VERIFIED_MESSAGE_BOUNDARY'));
});
