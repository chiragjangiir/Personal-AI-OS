import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {PaymentAuthority} from '../src/payment/authority.ts';
import {EVENT_SCHEMA,sha256,type RawEvent} from '../src/contracts.ts';
import {PHONE_CAPABILITIES} from '../src/source-authority.ts';

async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+5000;
  for(;;){const value=await read();if(done(value))return value;assert.ok(Date.now()<deadline,'runtime did not settle');await new Promise(resolve=>setTimeout(resolve,10));}
}
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'timeline-payment-')),storage=new PosixStorage(join(root,'storage'));
  const runs=new Map<string,NativeRun>(),errors:unknown[]=[];let sequence=0;
  const native:NativeClient={create:async body=>{const run:NativeRun={run_id:`run-${++sequence}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},
    status:async id=>runs.get(id)!,cancel:async id=>({...runs.get(id)!,status:'cancelled'})};
  const devices=[{principal_id:'owner',device_id:'phone',device_type:'phone' as const,channel:'fixture',consent_ref:'c',route_version:'r',capabilities:PHONE_CAPABILITIES,output_modes:['text'],token_sha256:sha256('phone')}];
  async function start(){
    const payment=PaymentAuthority.open(join(root,'payments'));
    const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,10000),native,payment,devices,skill:'test',max_read_bytes:10000,
      admission:new RunAdmission(storage,native,{max_pending_events:10,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'privacy-test'}),
      output:new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})}),automatic_output:{onError:error=>errors.push(error)}});
    await runtime.configureTimeline({directory:join(root,'timeline')});
    return {runtime,payment,source:await runtime.authenticate('phone')};
  }
  let current=await start();t.after(async()=>{await current.runtime.close();await rm(root,{recursive:true,force:true});});
  async function submit(event:string,session:string,payload:string|object,call=false){
    const {runtime,source}=current,raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:event,device_id:source.device_id,device_type:source.device_type,captured_at:new Date().toISOString(),source:{channel:'fixture'},
      media_type:typeof payload==='string'?'text':'app_event',mime:typeof payload==='string'?'text/plain;charset=utf-8':'application/json',representation:'uploaded_original',payload:Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload))};
    const accepted=call?await runtime.submitCallTurn(raw,source,session):await runtime.submit(raw,source,session,typeof payload==='string');
    const run=await until(()=>[...runs.values()].find(run=>run.conversation_session_id===session&&run.status==='running'),Boolean);
    await until(()=>runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'reply'},args:{reply_mode:'text'}}),value=>(value as {status:string}).status==='opened');
    return {run:run!,processed:accepted.processed_event.processed_event_id};
  }
  async function finish(item:Awaited<ReturnType<typeof submit>>,session:string,text:string){
    const {runtime,source}=current;item.run.output=text;item.run.status='completed';
    const final=await until(()=>runtime.result(source,session,item.processed),value=>value.result.reply_phase==='sealed');
    const first=final.chunks[0]!;
    await runtime.acknowledge(source,session,item.processed,{output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,target_device_id:first.target_device_id,route_version:first.route_version,
      highest_contiguous_seq:final.chunks.length,status:'rendered',observed_at:new Date().toISOString()});
    await runtime.result(source,session,item.processed);
    await until(()=>runtime.event(source,session,item.processed),value=>value.admission.state==='completed');
    return final;
  }
  return {get current(){return current;},errors,submit,finish,restart:async()=>{await current.runtime.close();current=await start();}};
}

for(const reconciliation of [false,true])test(reconciliation?
  'reconciliation lineage excludes delivered replies, later owner turns and call mirrors across restart':
  'authoritative payment lineage excludes delivered replies, later owner turns and call mirrors across restart',async t=>{
  const f=await fixture(t),session='payment-session';
  const payment=await f.submit('payment-update',session,reconciliation?
    {kind:'errand_result',principal_id:'owner',job_id:'job-0123456789ab',app:'千问',
      payment_reconciliation:{of_job:'job-a1b2c3d4e5f6',intent_id:'pi-original',state:'unknown'}}:
    {kind:'payment_update',event:'card_opened'});
  assert.equal((await f.finish(payment,session,'敏感付款结果')).result.private,'payment');
  const later=await f.submit('later-owner',session,'敏感的后续问题');await f.finish(later,session,'后续回答');
  const call=await f.submit('call-turn',session,{kind:'voice_turn',call_id:'call-1',turn:0,speaker:'owner',user:'电话中的付款问题',assistant:'电话中的付款回答'},true);
  await f.finish(call,session,'电话最终回答');
  assert.deepEqual(f.current.runtime.timeline!.page('owner').items,[]);
  await f.restart();assert.equal(f.current.payment.replyPrivacy('owner',session).private,'payment');
  const restored=await f.submit('restored-owner',session,'重启后的敏感问题');await f.finish(restored,session,'重启后的敏感回答');
  assert.deepEqual(f.current.runtime.timeline!.page('owner').items,[]);
  const ordinary=await f.submit('ordinary-owner','ordinary-session','付款这两个字不是隐私证据');
  assert.equal((await f.finish(ordinary,'ordinary-session','【已付款】只是普通文字')).result.private,undefined);
  assert.deepEqual(f.current.runtime.timeline!.page('owner').items.map(item=>item.text),['付款这两个字不是隐私证据','【已付款】只是普通文字']);
  assert.deepEqual(f.errors,[]);
});

for(const rendered of [true,'pending'] as const)test(`private scheduled final stays off shared timeline; render=${rendered}`,async t=>{
  const f=await fixture(t),session='scheduled-private';let shown='';
  t.mock.method(console,'warn',()=>{});
  f.current.payment.recordReplySource('owner',session,{kind:'payment_context'});
  const stop=await f.current.runtime.watchCare(f.current.source,async(_id,text,_reminder,privacy)=>{assert.equal(privacy?.private,'payment');shown=text;return rendered;});t.after(stop);
  const scheduled=await f.submit('private-scheduled',session,{kind:'scheduled_task',task:'办理后续工作'});
  await f.finish(scheduled,session,'付款后续结果');
  await until(()=>shown,text=>text==='付款后续结果');
  assert.deepEqual(f.current.runtime.timeline!.page('owner').items,[]);assert.deepEqual(f.errors,[]);
});
