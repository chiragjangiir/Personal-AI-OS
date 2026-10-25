import test from 'node:test';
import {channel} from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import {mkdtemp,rm,appendFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,HermesClient,NATIVE_RUN_SHAPE_SHA256,type NativeRun,type PendingVoiceConfirmation,type ErrandProgress} from './native-source-fixture.ts';
import {HealthStore} from '../src/health/store.ts';
import {RuntimeEventStore,installRuntimeEventStore} from '../src/self-events.ts';
import {PosixStorage} from '../src/storage.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {EVENT_SCHEMA,sha256,runScope,principalAttribution,ownerActionGrant,type RawEvent} from '../src/contracts.ts';
import {PHONE_CAPABILITIES,MAC_CAPABILITIES,GLASSES_CAPABILITIES,StaticFixtureDeviceAuthority,type RegisteredDevice} from '../src/source-authority.ts';
import {nativeApprovalId} from '../src/voiceprint/confirmation.ts';
import {parseErrandResult} from '../../../phase0/gateway/src/errand-spool.ts';
import {buildTimelineContext} from '../src/timeline.ts';

async function fixture(t:test.TestContext,notifications?:{title:string;body:string}[]|((notice:{title:string;body:string})=>Promise<void>),voice?:{calls:number},stagingOutreach?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['staging_outreach'],historyWait?:{aborted:number}){
  const root=await mkdtemp(join(tmpdir(),'paios-timeline-runtime-')),storage=new PosixStorage(join(root,'storage'));
  const runs=new Map<string,NativeRun>(),inputs=new Map<string,{input:string;run_scope?:string;guest_key?:string}>(),decisions:unknown[]=[],mirrors=new Map<string,{session:string;input:string;captured_at:string}>(),bodies:{input:string;instructions:string;session_id:string}[]=[];let sequence=0;
  const histories=new Map<string,{role:string;content:string;timestamp:number;tool_calls?:unknown}[]>();
  // Exercise HermesClient's actual wire decoder and approval response validation.
  const native=new HermesClient('http://127.0.0.1:1','fixture-token-abcdefghijklmnop',1000000,1048576,undefined,async(input,init)=>{
    const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    if(path==='/v1/paios/front-turn'){
      const session=`native-front-${body.session_id}`;
      // The native endpoint is idempotent per processed event: a replay returns the same transcript without a second message.
      if(!mirrors.has(body.processed_event_id)){
        const messages=histories.get(session)??[];histories.set(session,messages);
        messages.push({role:'user',content:body.input,timestamp:Date.parse(body.captured_at)/1000});
      }
      mirrors.set(body.processed_event_id,{session,input:body.input,captured_at:body.captured_at});
      return Response.json({session_id:session,processed_event_id:body.processed_event_id});
    }
    if(path==='/api/sessions'){
      if(historyWait)await new Promise<void>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>{historyWait.aborted++;reject(init!.signal!.reason);},{once:true}));
      return Response.json({data:[...histories.keys()].reverse().map(id=>({id}))});
    }
    if(path.startsWith('/api/sessions/'))return Response.json({data:histories.get(decodeURIComponent(path.split('/')[3]!))??[]});
    if(path==='/v1/runs'){
      inputs.set(body.session_id,body);
      bodies.push(body);const messages=histories.get(body.session_id)??[];histories.set(body.session_id,messages);
      messages.push({role:'user',content:body.input,timestamp:Date.now()/1000});
      const run:NativeRun={run_id:`run-${++sequence}`,session_id:body.care_decision?`care-${sequence}`:body.session_id,conversation_session_id:body.session_id,status:'running',...(body.care_decision?{}:{})};runs.set(run.run_id,run);
      return Response.json({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',...run,granted_toolsets:body.grant_toolsets??[],...(body.run_scope?{run_scope:body.run_scope}:{})},{status:202});
    }
    const run=runs.get(path.split('/')[3]!)!;
    if(path.endsWith('/events')){
      let timer:ReturnType<typeof setTimeout>|undefined,closed=false,seq=0,previous='';
      return new Response(new ReadableStream<Uint8Array>({start(controller){
        const close=()=>{if(closed)return;closed=true;clearTimeout(timer);controller.close();};
        init?.signal?.addEventListener('abort',close,{once:true});
        const emit=(event:Record<string,unknown>)=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({run_id:run.run_id,timestamp:Date.now()/1000,...event})}\n\n`));
        const observe=()=>{
          if(closed)return;
          const current=JSON.stringify(run);
          if(current!==previous){
            emit({event:previous?'run.updated':'run.snapshot',seq:++seq,activity_events:[],
              run:{schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',...run}});
            if(!previous)emit({event:'message.interim',seq:++seq,text:'正在核对日程'});
            previous=current;
          }
          if(['completed','failed','cancelled','canceled','interrupted','expired'].includes(run.status)){close();return;}
          timer=setTimeout(observe,5);
        };observe();
      },cancel(){closed=true;clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}});
    }
    if(path.endsWith('/approval')){
      decisions.push(body);run.approval_results=[{...run.approval!,choice:body.choice,reason:'resolved',
        ...(body.confirmation?{confirmation:{...body.confirmation,confirmed_at:'2026-10-22T00:00:00.000Z'}}:{})}];delete run.approval;run.status='running';
      return Response.json({object:'hermes.run.approval_response',run_id:run.run_id,request_id:body.request_id,choice:body.choice,
        ...(run.approval_results[0]!.confirmation?{confirmation:run.approval_results[0]!.confirmation}:{})});
    }
    if(path.endsWith('/stop'))run.status='cancelled';
    return Response.json({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',...run});
  });
  const devices=[['phone','phone','owner',PHONE_CAPABILITIES],['mac','mac','owner',MAC_CAPABILITIES],['glasses','glasses','owner',GLASSES_CAPABILITIES],['foreign','mac','other',MAC_CAPABILITIES]].map(([device_id,device_type,principal_id,capabilities])=>({
    principal_id,device_id,device_type,capabilities,channel:'fixture',consent_ref:'fixture',route_version:'route',output_modes:voice?['text','voice']:['text'],token_sha256:sha256(String(device_id))}));
  const health=HealthStore.open(join(root,'health'));
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'timeline-test'});
  const output=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]}),...(voice?{tts:{synthesize:async()=>{voice.calls++;throw new Error('UNEXPECTED_CALL_TTS');}}}:{})});
  const authority=Object.assign(new StaticFixtureDeviceAuthority([...devices,
    {...devices[0],channel:'background_scheduled',token_sha256:sha256('scheduled')} ] as never),{
    scheduled:async()=>authority.authenticate('scheduled')});
  const errors:unknown[]=[],archive=new RawArchive(storage,8192),runtime=new PersonalAIOSRuntime({storage,archive,native,health,
    admission,
    output,sourceAuthority:authority,skill:'controlled',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)},
    ...(stagingOutreach?{staging_outreach:stagingOutreach}:{}),
    ...(notifications?{notify:async(notice:{title:string;body:string})=>{if(typeof notifications==='function')await notifications(notice);else notifications.push(notice);}}:{})});
  await runtime.configureTimeline({directory:join(root,'timeline')});
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const [phone,mac,glasses,foreign]=await Promise.all(['phone','mac','glasses','foreign'].map(id=>runtime.authenticate(id)));
  const raw=(source:RegisteredDevice,event_id:string,payload:string|object):RawEvent=>({schema_version:EVENT_SCHEMA,event_id,device_id:source.device_id,device_type:source.device_type,
    captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:typeof payload==='string'?'text':'app_event',mime:typeof payload==='string'?'text/plain;charset=utf-8':'application/json',representation:'uploaded_original',payload:Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload))});
  return {runtime,output,archive,storage,native,admission,health,authority,root,phone:phone!,mac:mac!,glasses:glasses!,foreign:foreign!,raw,runs,inputs,decisions,errors,mirrors,bodies,histories};
}
const ownerConfirmation=(run_id:string,request_id='')=>({confirmation_id:nativeApprovalId('owner',run_id,request_id),
  confirmed_by:'owner',surface:{device_id:'phone',device_type:'phone'},confirmed_at:'2026-10-22T00:00:00.000Z'});
async function until<T>(read:()=>T|Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+5000;
  for(;;){const value=await read();if(done(value))return value;assert.ok(Date.now()<deadline,'public runtime observation did not settle');await new Promise(resolve=>setTimeout(resolve,10));}
}

test('typed submission survives its native history deadline without resending or claiming history is empty',async t=>{
  const historyWait={aborted:0},f=await fixture(t,undefined,undefined,undefined,historyWait);
  const accepted=await f.runtime.submit(f.raw(f.phone,'history-deadline','controlled request'),f.phone,'history-deadline-session',true);
  assert.equal(accepted.processed_event.event_id,'history-deadline');
  assert.equal(historyWait.aborted,1,'the existing timeline deadline cancels the stalled history HTTP read');
  await until(()=>f.bodies.length,count=>count===1);
  assert.match(f.bodies[0]!.instructions,/【同一条时间线】暂不可读取，不能据此认定此前没有对话。/);
  assert.equal(f.bodies[0]!.session_id,'history-deadline-session');
  const admitted=await until(()=>f.runtime.event(f.phone,'history-deadline-session',accepted.processed_event.processed_event_id),value=>value.admission.run_id==='run-1');
  assert.equal(admitted.admission.run_id,'run-1');
  assert.equal(f.bodies.length,1,'the first submitted D starts one native run without a terminal resend');
});

test('timeline history deadline handling preserves caller cancellation and actual service errors',async()=>{
  const caller=new AbortController(),cancelled=new Error('controlled caller cancellation');caller.abort(cancelled);
  await assert.rejects(buildTimelineContext({signal:caller.signal,sessionOwner:async()=>undefined},'owner','session'),error=>error===cancelled);
  for(const failure of [new Error('controlled history failure'),new DOMException('controlled upstream timeout','TimeoutError')])
    await assert.rejects(buildTimelineContext({sessionOwner:async()=>undefined,
      native:{sessions:async()=>{throw failure;},messages:async()=>[]}},'owner','session'),error=>error===failure);
});

test('package confirmation uses the existing owner surface and starts exactly one new native run for its result',async t=>{
  const f=await fixture(t),session='package-confirmation';
  await f.runtime.submit(f.raw(f.phone,'package-request','把消息发给小李'),f.phone,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  const bound=await until(()=>f.admission.find(run!.run_id,session),value=>!!value);
  const receipts:unknown[]=[],executed:unknown[]=[];
  await f.runtime.attachCapabilityConsent({
    spend:async()=>({action:'block',message:'CASHIER_REQUIRED'}),selfChange:async()=>({action:'block',message:'RELEASE_REQUIRED'}),
    execute:async call=>{
      const source=await f.runtime.scheduleContext(call.consent.context);assert.equal(source.allow_owner_mutation,true);
      await assert.rejects(f.runtime.scheduleContext({...call.consent.context,tool_call_id:'other-call'}),/SCHEDULE_RUN_BINDING_REQUIRED/);
      executed.push(call.args);return {receipt:1,status:{state:'succeeded'},effects:[],values:[],content:[],unknowns:[],next:{retry:'forbidden',waiting_on:'none'}};
    },
    receipt:async(_,body)=>{receipts.push(body);},error:error=>f.errors.push(error),
    followUp:async(call,body,id)=>{await f.runtime.capabilityFollowUp(call,{receipt_ref:'fixture-ledger-result',model_view:JSON.stringify(body)},id);}
  });
  await f.runtime.capabilityConsent!.decide({tool_name:'send_message',task_id:'native-child',args:{target:'email:fixture@example.com',message:'原文'},
    idempotency_key:'fixture-key',admission:bound!,check_with:'message_status',consent:{
      context:{run_id:run!.run_id,session_id:session,tool_call_id:'send'},effect:'send',target:'email:fixture@example.com',
      task_type:'send_message:email:send',owner_requested:true,scope_allowed:true,consent_required:true}});
  const [card]=await f.runtime.voiceConfirmations(f.phone);assert.equal(card!.kind,'native_approval');
  await f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'waiting'},args:{reply_mode:'none'}});
  run!.status='completed';
  await until(()=>f.runtime.event(f.phone,session,bound!.d.processed_event_id),value=>value.admission.state==='completed');
  await f.runtime.confirmVoice(f.phone,{confirmation_id:card!.confirmation_id,choice:'approve'});
  await until(()=>f.runs.size,value=>value===2);
  await assert.rejects(f.runtime.scheduleContext({run_id:run!.run_id,session_id:session,tool_call_id:'send'}),/SCHEDULE_RUN_BINDING_REQUIRED/);
  const result=f.bodies.at(-1)!;assert.ok(result.input.includes('capability_result'));
  assert.ok(result.input.includes('fixture-ledger-result'));
  assert.ok(result.input.includes('model_view'));
  await f.runtime.confirmVoice(f.phone,{confirmation_id:card!.confirmation_id,choice:'approve'});
  await until(()=>f.storage.list('capability-followup-inputs'),value=>value.length===1);
  assert.equal(executed.length,1);assert.equal(f.runs.size,2);
  const followup=JSON.parse(result.input) as import('../src/contracts.ts').ProcessedEvent;
  assert.deepEqual(await ownerActionGrant(followup,async()=>bound!.d,{payment_source:{...f.phone,chat_ui:true}}),[]);
});

test('rollback system notice persists offline, retries through existing delivery, and deduplicates its timeline and event',async t=>{
  const events:unknown[]=[],bus=channel('paios.runtime.events'),listener=(event:unknown)=>events.push(event);
  bus.subscribe(listener);t.after(()=>bus.unsubscribe(listener));
  const f=await fixture(t),value={principal_id:'owner',device_id:'phone',id:'release-rollback:drill-1',text:'系统消息：已回退。',captured_at:new Date().toISOString(),
    system_event:{type:'release_rollback' as const,release_id:'drill-1',reason:'unhealthy_window' as const,
      images:[{service:'gateway',variable:'PAIOS_GATEWAY_IMAGE',candidate:`sha256:${'a'.repeat(64)}`,previous:`sha256:${'b'.repeat(64)}`}]}};
  const store=new RuntimeEventStore({directory:join(f.root,'runtime-events')}),detach=installRuntimeEventStore(store);
  t.after(async()=>{detach();await store.close();});
  await assert.rejects(f.runtime.scheduledDelivery(value),/CARE_OUTREACH_UNAVAILABLE/);
  const first=await store.read();
  assert.equal(first.length,1);
  assert.deepEqual(first.map(({kind,status})=>({kind,status})),[{kind:'release_rollback',status:'completed'}]);
  assert.equal((await f.storage.list('system-events')).length,1);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>[item.item_id,item.kind,item.via]),[[value.id,'notice','proactive']]);
  let delivered=0;
  const stopCare=await f.runtime.watchCare(f.phone,async(id,text)=>{assert.equal(id,value.id);assert.equal(text,value.text);delivered++;return true;});
  t.after(stopCare);
  await f.runtime.scheduledDelivery(value);
  await f.runtime.scheduledDelivery(value);
  assert.equal(delivered,1);
  assert.equal((await f.storage.list('system-notice-deliveries')).length,1);
  assert.equal(f.runtime.timeline!.page('owner').items.length,1);
  await assert.rejects(f.runtime.scheduledDelivery({...value,text:'different evidence'}),/SYSTEM_EVENT_CONFLICT/);
  assert.equal(f.runs.size,0);
  assert.deepEqual(events.map(event=>(event as {kind:string}).kind),['release_rollback']);
  assert.deepEqual(await store.read(),first,'notification retries and duplicate delivery do not repeat diagnostics');
  detach();await stopCare();
  const detached={...value,id:'release-rollback:drill-detached',system_event:{...value.system_event,release_id:'drill-detached'}};
  await assert.rejects(f.runtime.scheduledDelivery(detached),/CARE_OUTREACH_UNAVAILABLE/);
  assert.equal(f.runtime.timeline!.page('owner').items.length,2);
  assert.equal(events.length,2,'the producer still publishes after the store detaches');
  assert.deepEqual(await store.read(),first,'detach removes the installed bus listener');
});

test('parallel rollback delivery has one sender and malformed system evidence is rejected',async t=>{
  const f=await fixture(t),value={principal_id:'owner',device_id:'phone',id:'release-rollback:drill-2',text:'系统消息：已回退。',captured_at:new Date().toISOString(),
    system_event:{type:'release_rollback' as const,release_id:'drill-2',reason:'restart_storm' as const,
      images:[{service:'gateway',variable:'PAIOS_GATEWAY_IMAGE',candidate:`sha256:${'a'.repeat(64)}`,previous:`sha256:${'b'.repeat(64)}`}]}};
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();let delivered=0;
  t.after(await f.runtime.watchCare(f.phone,async()=>{delivered++;entered.resolve();await leave.promise;return true;}));
  const first=f.runtime.scheduledDelivery(value);await entered.promise;
  await assert.rejects(f.runtime.scheduledDelivery(value),/SYSTEM_NOTICE_IN_FLIGHT/);
  leave.resolve();await first;
  assert.equal(delivered,1);
  await assert.rejects(f.runtime.scheduledDelivery({...value,system_event:null as never}),/SYSTEM_EVENT_REQUIRED/);
});

test('依米 shipped-repair and 改回去 notices use the same durable system-notice path and reject malformed evidence',async t=>{
  const events:unknown[]=[],bus=channel('paios.runtime.events'),listener=(event:unknown)=>events.push(event);
  bus.subscribe(listener);t.after(()=>bus.unsubscribe(listener));
  const f=await fixture(t),delivered:string[]=[];
  t.after(await f.runtime.watchCare(f.phone,async(id)=>{delivered.push(id);return true;}));
  const shipped={principal_id:'owner',device_id:'phone',id:'release-shipped:0123abcd-20261020T010000Z',text:'系统消息：依米修好了「x」。',captured_at:new Date().toISOString(),
    system_event:{type:'release_shipped' as const,release_id:'0123abcd-20261020T010000Z',request_id:'a1b2c3d4e5f6',commit:'c'.repeat(40)}};
  const reverted={...shipped,id:'release-reverted:0123abcd-20261020T010000Z',text:'系统消息：已按你的要求换回上一个版本。',
    system_event:{type:'release_reverted' as const,release_id:'0123abcd-20261020T010000Z',commit:'d'.repeat(40)}};
  await f.runtime.scheduledDelivery(shipped);await f.runtime.scheduledDelivery(shipped);await f.runtime.scheduledDelivery(reverted);
  assert.deepEqual(delivered,[shipped.id,reverted.id]);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>[item.item_id,item.kind,item.via]),[[shipped.id,'notice','proactive'],[reverted.id,'notice','proactive']]);
  assert.deepEqual(events.map(event=>(event as {kind:string}).kind),['release_shipped','release_reverted']);
  await assert.rejects(f.runtime.scheduledDelivery({...shipped,id:'release-shipped:other',system_event:{...shipped.system_event,release_id:'other',commit:'short'}}),/SYSTEM_EVENT_REQUIRED/);
  await assert.rejects(f.runtime.scheduledDelivery({...shipped,id:'release-rollback:0123abcd-20261020T010000Z'}),/SYSTEM_EVENT_REQUIRED/);
  await assert.rejects(f.runtime.scheduledDelivery({...shipped,id:'release-shipped:x2',system_event:{...shipped.system_event,release_id:'x2',request_id:'NOT-HEX'}}),/SYSTEM_EVENT_REQUIRED/);
});

test('rollback context carries the current owner utterance exactly and never observation text',async t=>{
  const f=await fixture(t),words=['请把依米服务器软件退回上一版。','刚部署的服务器软件不合适，恢复部署前那版。',
    '撤销这次依米服务端软件更新，用之前的版本。','  换回原来的。\r\n"保留原话" e\u0301 🐦\t'+'先前版本。'.repeat(110)];
  for(const [index,text] of words.entries()){
    const session=`rollback-${index}`,accepted=await f.runtime.submit(f.raw(f.phone,session,text),f.phone,session,true);
    const run=await until(()=>f.admission.get('owner',session,accepted.processed_event.processed_event_id)?.run_id,Boolean);
    const context={run_id:run!,session_id:session,tool_call_id:`rollback-call-${index}`};
    assert.deepEqual(Buffer.from((await f.runtime.scheduleContext(context)).owner_request_text!),Buffer.from(text));
    await assert.rejects(f.runtime.scheduleContext({...context,session_id:'unbound'}),/SCHEDULE_RUN_BINDING_REQUIRED/);
  }
  const observed=await f.runtime.submit(f.raw(f.phone,'rollback-observation',{kind:'device_status',text:'换回原来的。'}),f.phone,'observation',false);
  const run=await until(()=>f.admission.get('owner','observation',observed.processed_event.processed_event_id)?.run_id,Boolean);
  const context=await f.runtime.scheduleContext({run_id:run!,session_id:'observation',tool_call_id:'observation-call'});
  assert.equal(context.allow_owner_mutation,false);assert.equal(context.owner_request_text,null);
});

test('call observations reach the main turn with archived audio and only verified owner speech grants instructions',async t=>{
  const f=await fixture(t),end=Date.now(),start=end-200;
  const original=await f.archive.archive({schema_version:EVENT_SCHEMA,event_id:'call-audio',device_id:f.phone.device_id,device_type:f.phone.device_type,
    captured_at:new Date(start).toISOString(),source:{channel:f.phone.channel},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:start,end_ms:end},payload:Buffer.alloc(6400)}, {...f.phone,submission:'observation'});
  for(const speaker of ['owner','owner_uncertain','speaker:1','unknown']){
    const session=`call-${speaker}`,accepted=await f.runtime.submitCallTurn(f.raw(f.phone,`speech-${speaker}`,{kind:'voice_turn',call_id:'call',turn:0,
      speaker,user:speaker==='unknown'?'电视剧里的人说他中了五百万':'周五交方案',assistant:'',audio:{raw_ref:original.raw_ref,archive_revision:original.archive_revision,start_ms:start,end_ms:end}}),f.phone,session);
    const input=await until(()=>f.inputs.get(session),Boolean),d=JSON.parse(input!.input);
    const confirmation=speaker==='owner_uncertain'?f.runtime.voiceConfirmationFact(accepted.processed_event):null;
    if(speaker==='owner_uncertain')assert.equal(confirmation,null,'archived call observations never reopen a live identity card');
    assert.deepEqual(d,speaker==='owner'?accepted.processed_event:{...accepted.processed_event,voice_confirmation:confirmation});
    assert.ok(Array.isArray(d.content.audio_observations));
    const observation=d.content.audio_observations[0] as {speaker_ref:string;instruction_eligible:boolean;evidence_status:string;
      evidence:{raw_ref:string;processed_event_id:string}};
    assert.equal(observation.speaker_ref,speaker);assert.equal(observation.instruction_eligible,speaker==='owner');
    assert.equal(observation.evidence.raw_ref,original.raw_ref);assert.equal(observation.evidence.processed_event_id,d.processed_event_id);
    assert.equal(observation.evidence_status,'archived_audio');
    assert.equal(Object.hasOwn(input!,'memory_write'),false);assert.equal(principalAttribution(d),speaker==='owner'?'owner_call_turn':null);
    assert.equal(input!.run_scope,speaker==='owner'?undefined:speaker==='owner_uncertain'?'owner_uncertain':'guest');
    if(speaker==='speaker:1')assert.ok(input!.guest_key?.startsWith('speaker:1:'));
    assert.deepEqual(await ownerActionGrant(d),speaker==='owner'?['desktop','terminal','file']:[]);
    const run=await until(()=>f.admission.get('owner',session,d.processed_event_id)?.run_id,Boolean);
    const context={run_id:run!,session_id:session,tool_call_id:`rollback-${speaker}`};
    if(speaker==='owner')assert.equal((await f.runtime.scheduleContext(context)).owner_request_text,d.content.app_event.user);
    else await assert.rejects(f.runtime.scheduleContext(context),/SCHEDULE_OWNER_REQUIRED/);
    assert.equal((await f.archive.read(observation.evidence.raw_ref,'owner',original.archive_revision)).length,6400);
    if(speaker!=='owner'){
      const text=`${speaker==='owner_uncertain'?'声音待确认':'未确认说话人'}：${d.content.app_event.user}`;
      assert.ok(f.runtime.timeline!.observations('owner').some(line=>line.text===text));
      assert.ok(!f.runtime.timeline!.page('owner').items.some(item=>item.text===text));
    }
  }
  await assert.rejects(f.runtime.submitCallTurn(f.raw(f.phone,'foreign-audio',{kind:'voice_turn',call_id:'call',turn:1,speaker:'owner',user:'x',
    audio:{raw_ref:original.raw_ref,archive_revision:'f'.repeat(64),start_ms:start,end_ms:end}}),f.phone,'bad-session'));
  const ownerItem=f.runtime.timeline!.page('owner').items.find(item=>item.text==='周五交方案')!;
  assert.ok(ownerItem);await f.archive.delete(original.raw_ref,'owner');
  assert.ok(!f.runtime.timeline!.page('owner').items.some(item=>item.item_id===ownerItem.item_id));
  const d=JSON.parse(f.inputs.get('call-owner')!.input);
  await assert.rejects(f.runtime.event(f.phone,'call-owner',d.processed_event_id),/RAW_DELETED/);
});

test('typed phone and Mac finals enter the conversation when sealed, before any ACK; a later ACK never duplicates them; attested call transcripts mirror the owner conversation',async t=>{
  const f=await fixture(t,[]);
  for(const source of [f.phone,f.mac]){
    const session=`session-${source.device_id}`,event=`typed-${source.device_id}`,raw=f.raw(source,event,`来自${source.device_id}`);
    const accepted=await f.runtime.submit(raw,source,session,true),d=accepted.processed_event;
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
    await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
    run!.output=`答复${source.device_id}`;run!.status='completed';
    const final=await until(()=>f.runtime.result(source,session,d.processed_event_id),value=>value.result.reply_phase==='sealed');
    // Zero ACKs: the owner left the app before her reply finished. What she said is history; delivery stays per device.
    assert.equal(final.result.delivery_status,'unknown');
    assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${d.processed_event_id}`).length,1);
    await acknowledge(f.runtime,source,session,d.processed_event_id,final);
    assert.equal((await f.runtime.result(source,session,d.processed_event_id)).result.delivery_status,'rendered');
    await f.runtime.submit(raw,source,session,true);await f.runtime.result(source,session,d.processed_event_id);
    const items=f.runtime.timeline!.page('owner').items;
    assert.equal(items.filter(item=>item.item_id===`me-${event}`).length,1);assert.equal(items.filter(item=>item.item_id===`her-${d.processed_event_id}`).length,1);
    assert.equal(items.find(item=>item.item_id===`me-${event}`)!.source_class,source.device_type==='phone'?'iphone':'mac');
    assert.equal(items.find(item=>item.item_id===`her-${d.processed_event_id}`)!.text,run!.output);
  }
  const before=f.runtime.timeline!.page('owner').items;
  const call=await f.runtime.submitCallTurn(f.raw(f.phone,'call-turn',{kind:'voice_turn',call_id:'call-1',turn:0,speaker:'owner',user:'电话里的话',assistant:'电话答复'}),f.phone,'call-session');
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id==='call-session'),value=>!!value);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:'call-session',tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
  run!.output='电话的最终答复';run!.status='completed';
  await until(()=>f.runtime.event(f.phone,'call-session',call.processed_event.processed_event_id),value=>value.admission.state==='completed');
  await f.runtime.result(f.phone,'call-session',call.processed_event.processed_event_id);
  await until(()=>f.runtime.timeline!.page('owner').items.some(item=>item.text==='电话的最终答复'),Boolean);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.slice(0,before.length),before);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.slice(before.length).map(item=>item.text),['电话里的话','电话答复','电话的最终答复']);assert.deepEqual(f.runtime.timeline!.page('other').items,[]);assert.deepEqual(f.errors,[]);
});

test('front-only call turns reuse the owner timeline without native admission; explicit handoffs and legacy turns still admit',async t=>{
  const f=await fixture(t);
  const turn={kind:'voice_turn',call_id:'front-call',turn:0,user:'你好',assistant:'你好呀',route:'front_only',speaker:'owner'};
  const raw=f.raw(f.phone,'front-turn',turn);
  const accepted=await f.runtime.submitCallTurn(raw,f.phone,'front-session');
  assert.equal(accepted.admission,null);assert.equal(f.runs.size,0);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),['你好','你好呀']);
  await f.runtime.submitCallTurn(raw,f.phone,'front-session');
  assert.equal(f.runtime.timeline!.page('owner').items.length,2);assert.equal(f.runs.size,0);
  assert.equal(f.mirrors.size,1);
  const context=await f.runtime.callContext(f.phone,'next-call',undefined,'UTC',undefined,'owner');
  assert.match(context,/主人：你好/);assert.match(context,/依米：你好呀/);
  assert.equal(context.match(/你好呀/gu)?.length,1,'the native voice_turn contains the spoken reply once');
  assert.doesNotMatch(await f.runtime.callContext(f.foreign,'foreign-call',undefined,'UTC',undefined,'owner'),/你好呀/);
  assert.deepEqual(accepted.processed_event.content.app_event,turn);
  const handoff=await f.runtime.submitCallTurn(f.raw(f.phone,'handoff-turn',{...turn,turn:1,route:'handoff',handoff:{difficulty:'complex',intent:'安排明天',thinking:'enabled'}}),f.phone,'handoff-session');
  // The gateway watches progress only after the admission carries its run (on_admission); the native run starts first.
  await until(()=>f.runtime.event(f.phone,'handoff-session',handoff.processed_event.processed_event_id),value=>!!value.admission.run_id);
  assert.equal(f.runs.size,1);
  const progress:string[]=[],progressAbort=new AbortController();
  await f.runtime.watchCallProgress(f.phone,'handoff-session',handoff.processed_event.processed_event_id,text=>{progress.push(text);progressAbort.abort();},progressAbort.signal);
  assert.deepEqual(progress,['正在核对日程']);assert.equal([...f.runs.values()][0]!.status,'running');
  await assert.rejects(f.runtime.watchCallProgress(f.foreign,'handoff-session',handoff.processed_event.processed_event_id,()=>{},new AbortController().signal),/SESSION_SCOPE_DENIED/);
  await f.runtime.submitCallTurn(f.raw(f.phone,'legacy-turn',{kind:'voice_turn',call_id:'legacy-call',turn:0,user:'记住这件事',assistant:'好的'}),f.phone,'legacy-session');
  await until(()=>f.runs.size,value=>value===2);
  const other=await f.runtime.submitCallTurn(f.raw(f.phone,'other-front-turn',{...turn,turn:2,user:'旁边有人在说话',speaker:'unknown'}),f.phone,'other-session');
  assert.notEqual(other.admission,null);assert.equal(f.mirrors.size,1);
  await until(()=>f.runs.size,value=>value===3);
  const minimal=await f.runtime.submitCallTurn(f.raw(f.phone,'legacy-minimal-turn',{kind:'voice_turn',speaker:'owner',user:'旧协议只有原话',assistant:'收到',route:'front_only'}),f.phone,'legacy-minimal-session');
  assert.equal(minimal.admission,null);
  assert.ok(f.runtime.timeline!.page('owner').items.some(item=>item.text==='旧协议只有原话'));
  assert.deepEqual(f.errors,[]);
});

test('owner speech directed at another person stays sourced context without instruction eligibility or native admission',async t=>{
  const f=await fixture(t);
  const turn={kind:'voice_turn',call_id:'side-call',turn:0,user:'你先坐，我打个电话',assistant:'',route:'front_only',speaker:'owner',addressed_to_assistant:false};
  const accepted=await f.runtime.submitCallTurn(f.raw(f.phone,'side-turn',turn),f.phone,'side-session');
  assert.equal(accepted.admission,null);assert.equal(f.runs.size,0);assert.equal(f.mirrors.size,1);
  const [observation]=accepted.processed_event.content.audio_observations as {speaker_ref:string;instruction_eligible:boolean;text:string}[];
  assert.equal(observation!.speaker_ref,'owner');assert.equal(observation!.instruction_eligible,false);assert.equal(observation!.text,turn.user);
  assert.deepEqual(accepted.processed_event.content.app_event,turn);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),[turn.user]);assert.deepEqual(f.errors,[]);
});

test('detached native task publishes its initial acknowledgement once while the next owner turn runs; final seal stays separate',async t=>{
  const f=await fixture(t),session='dispatch-session';
  assert.deepEqual(f.runtime.turnWork('owner'),{foreground_replies:[],background_work_count:0});
  const original=await f.runtime.submit(f.raw(f.mac,'original-task','整理这批资料'),f.mac,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  run!.output='我去整理，完成后告诉你。';run!.turn_exit_reason='delegation_waiting';
  const ackId=`dispatch-${original.processed_event.processed_event_id}`;
  await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.item_id===ackId));
  const ack=f.runtime.timeline!.page('owner').items.find(item=>item.item_id===ackId)!;
  assert.equal(ack.kind,'notice');assert.equal(ack.text,run!.output);assert.equal(run!.status,'running');
  assert.equal(f.runtime.turnWork('owner').background_work_count,1);
  assert.equal(f.runtime.turnWork('other').background_work_count,0);
  await f.runtime.submit(f.raw(f.mac,'next-owner-turn','再检查一下日期'),f.mac,session,true);
  await until(()=>f.runs.size,size=>size===2);
  assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===ackId).length,1);
  await f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'final-open'},args:{reply_mode:'text'}});
  run!.output='资料已整理，日期也已核对。';run!.turn_exit_reason='completed';run!.status='completed';
  await until(()=>f.runtime.result(f.mac,session,original.processed_event.processed_event_id),value=>value.result.reply_phase==='sealed');
  const items=f.runtime.timeline!.page('owner').items;
  assert.equal(items.filter(item=>item.item_id===ackId).length,1);
  assert.equal(items.find(item=>item.item_id===`her-${original.processed_event.processed_event_id}`)?.text,run!.output);
  assert.equal(f.runtime.turnWork('owner').background_work_count,0);
  assert.deepEqual(f.errors,[]);
});

test('repeated delegation waits retain each opened reply across owner turns and terminal replay',async t=>{
  const f=await fixture(t),session='repeated-dispatch';
  const accepted=await f.runtime.submit(f.raw(f.mac,'multi-stage','整理资料，再核对日期'),f.mac,session,true),d=accepted.processed_event.processed_event_id;
  const run=await until(()=>[...f.runs.values()][0],value=>!!value);
  await until(()=>f.runtime.event(f.mac,session,d),value=>!!value.admission.run_id);
  const messages=f.histories.get(session)!,at=Date.now()/1000;
  const waitReply=async(id:string,text:string)=>{
    await f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:id},args:{reply_mode:'text'}});
    messages.push({role:'tool',content:'{}',timestamp:at,tool_call_id:id} as never,
      {role:'assistant',content:text,timestamp:at,finish_reason:'stop'} as never);
    Object.assign(run,{output:text,turn_exit_reason:'delegation_waiting'});
    await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.text===text));
  };
  await waitReply('open-first','我先整理资料。');
  await f.runtime.submit(f.raw(f.mac,'interleaved-owner','我还在，先告诉我现在几点'),f.mac,session,true);
  await until(()=>f.runs.size,size=>size===2);
  await waitReply('open-second','资料整理好了，我继续核对日期。');
  await f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:'open-final'},args:{reply_mode:'text'}});
  Object.assign(run,{output:'日期核对完成。',turn_exit_reason:'completed',status:'completed'});
  await until(()=>f.runtime.result(f.mac,session,d),value=>value.result.reply_phase==='sealed');
  await f.runtime.result(f.mac,session,d);
  const replies=f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${d}`||item.item_id.startsWith(`dispatch-${d}`));
  assert.deepEqual(replies.map(item=>[item.item_id,item.text]),[
    [`dispatch-${d}`,'我先整理资料。'],[`dispatch-${d}:2`,'资料整理好了，我继续核对日期。'],[`her-${d}`,'日期核对完成。']]);
  assert.equal(f.runs.get('run-2')!.status,'running','older task finalization leaves the current owner turn running');
  assert.deepEqual(f.errors,[]);
});

test('detached task link, progress, choice and first-send approval reach the owner during a newer turn; cancel keeps that turn',async t=>{
  const f=await fixture(t),session='interleaved-interim',cards:unknown[]=[],approvals:PendingVoiceConfirmation[][]=[];
  t.after(await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session,deliver:async card=>{cards.push(card);}}));
  await f.runtime.ownerInput(f.phone);
  t.after(await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{approvals.push(rows);},error=>f.errors.push(error)));
  const original=await f.runtime.submit(f.raw(f.phone,'child-origin','发消息前先让我确认'),f.phone,session,true);
  const run=await until(()=>[...f.runs.values()][0],value=>!!value);
  const context={run_id:run.run_id,session_id:session,tool_call_id:'link'};
  await until(()=>f.runtime.event(f.phone,session,original.processed_event.processed_event_id),value=>!!value.admission.run_id);
  await f.runtime.tool('paios_open_reply',{context,args:{reply_mode:'text'}});
  Object.assign(run,{turn_exit_reason:'delegation_waiting',output:'请打开云手机链接：https://phone.example.test/session/isolated'});
  await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.text===run.output));
  await f.runtime.submit(f.raw(f.phone,'newer-turn','先回答我另一个问题'),f.phone,session,true);
  await until(()=>f.runs.size,size=>size===2);
  await f.runtime.tool('paios_open_reply',{context:{...context,tool_call_id:'progress'},args:{reply_mode:'text'}});
  run.output='你刚问的进度：收件人已核对，等待你的选择。';
  await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.text===run.output));
  const question=await f.runtime.tool('paios_terminal_question',{context:{...context,tool_call_id:'choice'},
    args:{question:'选择哪一个收件人？',options:[{id:'a',label:'张一',lines:[]},{id:'b',label:'张二',lines:[]}]}});
  assert.deepEqual(cards,[question]);
  run.approval={request_id:'first-send',question:'首次向张一发送这类消息，是否确认？',expires_at_ms:Date.now()+60000};
  run.status='waiting_for_approval';
  const pending=await until(()=>approvals.at(-1)??[],rows=>rows.some(row=>row.text===run.approval!.question));
  assert.equal(f.runs.get('run-2')!.status,'running');
  await f.runtime.confirmVoice(f.phone,{confirmation_id:pending[0]!.confirmation_id,choice:'approve'});
  assert.deepEqual(f.decisions.map(({confirmation,...decision}:any)=>decision),[{request_id:'first-send',choice:'once'}]);
  await f.runtime.cancelRunControl(f.phone,session,original.processed_event.processed_event_id);
  await until(()=>f.runtime.event(f.phone,session,original.processed_event.processed_event_id),value=>value.admission.state==='cancelled');
  assert.equal(f.runs.get('run-2')!.status,'running');
  assert.deepEqual(f.errors,[]);
});

test('a run resumed by delegated results keeps both opened replies: the earlier one reaches the timeline before the sealed one',async t=>{
  const f=await fixture(t),session='resumed-session';
  const original=await f.runtime.submit(f.raw(f.mac,'compound-task','改 Excel、发微信、开净化器'),f.mac,session,true),d=original.processed_event.processed_event_id;
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  await until(()=>f.runtime.event(f.mac,session,d),value=>!!value.admission.run_id);
  const at=Date.now()/1000,summary='几件事分开说：Excel 算完了，微信也发了。',followUp='空气净化器办好了。';
  const open=(id:string)=>({role:'assistant',content:'',timestamp:at,tool_calls:[{id,type:'function',function:{name:'paios_open_reply',arguments:'{"reply_mode":"text"}'}}]});
  const opened=(id:string)=>({role:'tool',content:'{"status": "opened", "error_code": null}',timestamp:at,tool_call_id:id,tool_name:'paios_open_reply'});
  // Regression: the native delegation completion was already queued, so the run resumed right after its first final reply.
  await f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open-summary'},args:{reply_mode:'text'}});
  f.histories.get(session)!.push(open('open-summary'),opened('open-summary'),{role:'assistant',content:summary,timestamp:at,finish_reason:'stop'} as never,
    {role:'user',content:'Native delegated work completed. Synthesize the verified results for the owner.',timestamp:at});
  await f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open-follow-up'},args:{reply_mode:'text'}});
  f.histories.get(session)!.push(open('open-follow-up'),opened('open-follow-up'),{role:'assistant',content:followUp,timestamp:at,finish_reason:'stop'} as never);
  Object.assign(run!,{output:followUp,status:'completed'});
  await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.item_id===`her-${d}`));
  const items=f.runtime.timeline!.page('owner').items.filter(item=>item.kind!=='owner');
  assert.deepEqual(items.map(item=>[item.item_id,item.text]),[[`dispatch-${d}`,summary],[`her-${d}`,followUp]]);
  assert.equal((await f.runtime.result(f.mac,session,d)).result.reply_text,followUp);
  assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.text===summary).length,1);
  assert.deepEqual(f.errors,[]);
});

test('a result subscription to a D that ended without a run fails instead of waiting forever',async t=>{
  const f=await fixture(t),session='ended-unsent';
  await f.runtime.submit(f.raw(f.mac,'busy-turn','先做这个'),f.mac,session,true);
  await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  const queued=await f.runtime.submit(f.raw(f.mac,'queued-turn','再做那个'),f.mac,session,true),d=queued.processed_event.processed_event_id;
  await f.runtime.cancelRunControl(f.mac,session,d);
  await until(()=>f.runtime.event(f.mac,session,d),value=>value.admission.state==='cancelled');
  // The errand spool resubscribes on every sweep; a silent wait here kept a finished errand `.done` forever.
  const failed=Promise.withResolvers<unknown>();
  await f.runtime.subscribeResult(f.mac,session,d,async()=>{failed.reject(new Error('no result exists'));},failed.resolve);
  assert.match(String((await failed.promise as {code?:string}).code),/RUN_NOT_ACCEPTED/);
});

for(const outbound of [true,false])test(`shared tool cap reports incomplete work once without OPEN or a successful final seal; notifier=${outbound}`,async t=>{
  const notifications:{title:string;body:string}[]=[],f=await fixture(t,outbound?notifications:undefined),session='cap-session';
  const accepted=await f.runtime.submit(f.raw(f.mac,'cap-task','整理资料并检查缺失项'),f.mac,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  run!.output='已完成：整理了三份资料。尚缺：核对第四份日期。';run!.turn_exit_reason='tool_call_cap_reached';run!.status='failed';
  const noticeId=`cap-${accepted.processed_event.processed_event_id}`;
  await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.item_id===noticeId));
  if(outbound)await until(()=>notifications,list=>list.length===1);
  const notice=f.runtime.timeline!.page('owner').items.find(item=>item.item_id===noticeId)!;
  assert.equal(notice.kind,'notice');assert.match(notice.text,/任务未完成/);assert.ok(notice.text.includes(run!.output));
  if(outbound)assert.equal(notifications[0]!.body,notice.text);
  for(let n=0;n<2;n++){
    const result=await f.runtime.result(f.mac,session,accepted.processed_event.processed_event_id);
    assert.equal(result.admission.state,'failed');assert.equal(result.result.reply_phase,'failed');assert.equal(result.result.reply_text,'');assert.deepEqual(result.result.output_plan,[]);
  }
  assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===noticeId).length,1);assert.equal(notifications.length,outbound?1:0);
  assert.equal(f.runtime.timeline!.page('owner').items.some(item=>item.item_id===`her-${accepted.processed_event.processed_event_id}`),false);assert.deepEqual(f.errors,[]);
});

test('I12 native pending set is read-only on Mac, scoped to its principal, and settles through the phone only',async t=>{
  const f=await fixture(t),phoneViews:PendingVoiceConfirmation[][]=[],macViews:PendingVoiceConfirmation[][]=[],foreignViews:PendingVoiceConfirmation[][]=[];
  t.after(await f.runtime.watchCare(f.phone,async()=>true));t.after(await f.runtime.watchCare(f.mac,async()=>true));await f.runtime.ownerInput(f.phone);
  const fail=(error:unknown)=>assert.fail(String(error));
  t.after(await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{phoneViews.push(rows);},fail));
  t.after(await f.runtime.watchVoiceConfirmations(f.mac,async rows=>{macViews.push(rows);},fail,true));
  t.after(await f.runtime.watchVoiceConfirmations(f.foreign,async rows=>{foreignViews.push(rows);},fail,true));
  await assert.rejects(f.runtime.watchVoiceConfirmations(f.mac,async()=>{},fail),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await assert.rejects(f.runtime.watchVoiceConfirmations(f.glasses,async()=>{},fail,true),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  await f.runtime.submit(f.raw(f.phone,'approval-event','请执行这次操作'),f.phone,'approval-session',true);
  const run=await until(()=>[...f.runs.values()][0],value=>!!value);
  run!.approval={request_id:'approval-1',question:'允许模拟操作吗？',expires_at_ms:Date.now()+60000};run!.status='waiting_for_approval';
  const pending=await until(()=>macViews.at(-1)??[],rows=>rows.length===1),id=pending[0]!.confirmation_id;
  await until(()=>phoneViews.at(-1)??[],rows=>rows.some(row=>row.confirmation_id===id));
  assert.equal(pending[0]!.kind,'native_approval');assert.equal(pending[0]!.text,'允许模拟操作吗？');
  assert.deepEqual((phoneViews.at(-1)??[]).map(row=>row.confirmation_id),pending.map(row=>row.confirmation_id));
  for(const choice of ['approve','deny'] as const)await assert.rejects(f.runtime.confirmVoice(f.mac,{confirmation_id:id,choice}),/VOICE_CONFIRMATION_DEVICE_REQUIRED/);
  assert.deepEqual(f.decisions,[]);assert.ok(foreignViews.every(rows=>rows.length===0));
  await f.runtime.confirmVoice(f.phone,{confirmation_id:id,choice:'approve'});
  await until(()=>macViews.at(-1),rows=>rows?.length===0);await until(()=>phoneViews.at(-1),rows=>rows?.length===0);
  assert.deepEqual(f.decisions.map(({confirmation,...decision}:any)=>decision),[{request_id:'approval-1',choice:'once'}]);assert.deepEqual(f.errors,[]);
});

test('native cron failure enters the original owner session once without becoming an owner instruction',async t=>{
  const f=await fixture(t),session='owner-cron-origin';
  const origin=await f.runtime.submit(f.raw(f.phone,'create-cron','以后只读查价格'),f.phone,session,true);
  const ownerRun=await until(()=>[...f.runs.values()][0],value=>!!value);ownerRun!.status='completed';ownerRun!.output='';
  const failure={failure_source:'cron',job_id:'cron-job:fire-one',title:'定时查价格',task:'只读查价格',
    terminal_reason:'failed',answer:'第1步模型等待超时',evidence_ref:{tool:'cronjob_manage',action:'list',job_id:'cron-job'}};
  const request={principal_id:'owner',device_id:'phone',job_id:'cron-job',occurrence_id:'failure:fire-one',
    captured_at:new Date().toISOString(),origin_processed_event_id:origin.processed_event.processed_event_id,prompt:'只读查价格',skills:[],failure};
  const first=await f.runtime.scheduledTask(request),again=await f.runtime.scheduledTask(request);
  assert.equal(first.processed_event.processed_event_id,again.processed_event.processed_event_id);
  await until(()=>f.bodies.length,count=>count===2);
  const input=JSON.parse(f.bodies[1]!.input);
  assert.equal(f.bodies[1]!.session_id,session);assert.equal(input.origin,'device_observation');
  assert.equal(principalAttribution(input),null);assert.equal(input.content.app_event.kind,'task_failure');
  assert.deepEqual(input.content.app_event.evidence_ref,failure.evidence_ref);
  assert.equal(input.content.app_event.title,failure.title);
  assert.deepEqual(f.bodies[1]!.grant_toolsets,['desktop','terminal','file']);
  [...f.runs.values()][1]!.status='completed';
});

for(const kind of ['scheduled_task','build_task'])test(`failed admitted ${kind} reports to the original owner session`,async t=>{
  const f=await fixture(t),session=`owner-${kind}`;
  const origin=await f.runtime.submit(f.raw(f.phone,`create-${kind}`,'检查并修复问题'),f.phone,session,true);
  const ownerRun=await until(()=>[...f.runs.values()][0],value=>!!value);ownerRun!.status='completed';ownerRun!.output='';
  const accepted=await f.runtime.scheduledTask({principal_id:'owner',device_id:'phone',job_id:'background-job',occurrence_id:'once',
    captured_at:new Date().toISOString(),origin_processed_event_id:origin.processed_event.processed_event_id,prompt:'只读检查',skills:[],
    ...(kind==='build_task'?{build_input_ref:origin.processed_event.processed_event_id}:{})});
  const run=await until(()=>[...f.runs.values()][1],value=>!!value);
  run!.status='failed';run!.output='native model step 1 failed';run!.updated_at=Date.now()/1000;
  await until(()=>f.bodies.length,count=>count===3);
  const body=f.bodies[2]!,app=JSON.parse(body.input).content.app_event;
  assert.equal(body.session_id,session);assert.equal(app.kind,'task_failure');assert.equal(app.terminal_reason,'failed');
  assert.equal(app.failure_source,kind==='build_task'?'workshop':'cron');
  assert.deepEqual(app.evidence_ref,{tool:'session_search',session_id:run!.session_id,run_id:run!.run_id});
  assert.equal(app.answer,'native model step 1 failed');
  assert.notEqual(accepted.processed_event.processed_event_id,JSON.parse(body.input).processed_event_id);
  [...f.runs.values()][2]!.status='completed';
});

for(const terminal_reason of ['timed_out','failed','error','interrupted','cancelled_by_user'])
test(`phone ${terminal_reason} enters the main session once as source evidence`,async t=>{
  const f=await fixture(t),job_id='job-0123456789ab',session=`failure-${terminal_reason}`;
  const evidence={tool:'phone_status',job_id},result=parseErrandResult({principal_id:'owner',job_id,
    task:'只读查千问香辣蟹价格',title:'查香辣蟹价格',app:'千问',tier:'thorough',success:false,
    answer:'模型第1步等待到任务期限',terminal_reason,finished_at:new Date().toISOString(),evidence_ref:evidence});
  const raw=f.raw(f.mac,`errand:${job_id}`,{kind:'errand_result',...result});
  const first=await f.runtime.submitErrand(raw,f.mac,session);
  const replay=await f.runtime.submitErrand(raw,f.mac,session);
  assert.equal(first.processed_event.processed_event_id,replay.processed_event.processed_event_id);
  const run=await until(()=>[...f.runs.values()][0],value=>!!value);
  assert.equal(f.bodies.length,1);
  const input=JSON.parse(f.bodies[0]!.input);
  assert.equal(input.origin,'device_observation');
  assert.equal(principalAttribution(input),null);
  assert.equal(input.content.app_event.title,'查香辣蟹价格');
  assert.equal(input.content.app_event.terminal_reason,terminal_reason);
  assert.deepEqual(input.content.app_event.evidence_ref,evidence);
  assert.equal(input.content.text,undefined,'the failure must not become owner speech');
  assert.equal(f.bodies[0]!.session_id,session);
  run!.status='completed';run!.output='';
});

test('C8.2 errand and proactive finals dedupe outreach; C6.4 queued runs cannot open phone consent',async t=>{
  const f=await fixture(t),outreach:{id:string;text:string}[]=[];
  t.after(await f.runtime.watchCare(f.phone,async(id,text)=>{outreach.push({id,text});return true;}));
  for(const kind of ['errand_result','scheduled_task','desktop_queue_task']){
    const session=`producer-${kind}`,accepted=await f.runtime.submit(f.raw(f.mac,session,{kind,job_id:'job-one',queue_id:'dq-test',task:'整理发票'}),f.mac,session,false);
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
    if(kind==='desktop_queue_task'){
      run!.approval={request_id:'queue-consent',question:'不应打开这次确认',expires_at_ms:Date.now()+60000};run!.status='waiting_for_approval';
      await until(()=>f.decisions,rows=>rows.length===1);
      assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);delete run!.approval;run!.status='running';
    }
    await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
    run!.output=`完成 ${kind}`;run!.status='completed';
    const id=`her-${accepted.processed_event.processed_event_id}`;
    const final=await until(()=>f.runtime.result(f.mac,session,accepted.processed_event.processed_event_id),value=>value.result.reply_phase==='sealed');
    if(kind==='errand_result')await acknowledge(f.runtime,f.mac,session,accepted.processed_event.processed_event_id,final);
    await until(()=>f.runtime.timeline!.page('owner').items,items=>items.some(item=>item.item_id===id));
    await f.runtime.result(f.mac,session,accepted.processed_event.processed_event_id);
    if(kind!=='errand_result')await until(()=>outreach,rows=>rows.some(row=>row.id===accepted.processed_event.processed_event_id));
    const items=f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===id);
    // The sealed reply is the first writer and classifies itself; outreach's later delivery dedups on the same item id.
    assert.equal(items.length,1);assert.equal(items[0]!.text,run!.output);assert.equal(items[0]!.via,kind==='scheduled_task'?'proactive':'errand');
  }
  const reminder={captured_at:new Date().toISOString(),principal_id:'owner',device_id:'phone',id:'reminder-one',text:'该休息了'};
  await f.runtime.scheduledDelivery(reminder);await f.runtime.scheduledDelivery(reminder);
  assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.item_id==='her-reminder-one').length,1);
  assert.deepEqual(f.decisions.map(({confirmation,...decision}:any)=>decision),[{request_id:'queue-consent',choice:'deny'}]);assert.deepEqual(f.errors,[]);
});

for(const phoneOnline of [false,true])test(`reminder reaches latest Mac and shared chat with unworn glasses; phone online=${phoneOnline}`,async t=>{
  const f=await fixture(t),shown:string[]=[],spoken:string[]=[],warnings:string[]=[];
  t.mock.method(console,'warn',(message:string)=>{warnings.push(message);});
  const attach=async(source:RegisteredDevice)=>{
    t.after(await f.runtime.watchCare(source,async()=>{shown.push(source.device_id);return 'pending';},async()=>{spoken.push(source.device_id);return false;},
      undefined,undefined,undefined,undefined,source===f.glasses?{session:'reminder',deliver:async()=>{}}:undefined));
  };
  await attach(f.glasses);await f.runtime.wearState(f.glasses,false);
  if(phoneOnline){await attach(f.phone);await f.runtime.ownerInput(f.phone);}
  await attach(f.mac);await f.runtime.ownerInput(f.mac);
  assert.deepEqual(f.runtime.terminals('owner').map(source=>source.device_id),phoneOnline?['mac','phone']:['mac']);
  const reminder={principal_id:'owner',device_id:'mac',id:'reminder-reach',reminder_id:'walk-once',text:'测试提醒：起来走两步',captured_at:new Date().toISOString()};
  await f.runtime.scheduledDelivery(reminder);
  assert.deepEqual(spoken,phoneOnline?['mac','phone']:['mac'],'publishing ambient_reply does not confirm speech');
  assert.deepEqual(shown,phoneOnline?['mac','phone']:['mac'],'pending publication must not block the next ranked display');
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>[item.item_id,item.text,item.via]),[['her-reminder-reach',reminder.text,'proactive']]);
  assert.deepEqual(f.runtime.timeline!.page(f.mac.principal_id).items.map(item=>item.text),[reminder.text]);
  assert.deepEqual(f.runtime.timeline!.page(f.phone.principal_id).items.map(item=>item.text),[reminder.text]);
  await f.runtime.scheduledDelivery(reminder);
  assert.equal(f.runtime.timeline!.page('owner').items.length,1);
  assert.ok(warnings.every(line=>JSON.parse(line).reason==='notification_unavailable'));assert.deepEqual(f.errors,[]);
});

test('online phone retains confirmed reminder delivery with unworn glasses',async t=>{
  const f=await fixture(t),shown:string[]=[];
  t.after(await f.runtime.watchCare(f.glasses,async()=>{shown.push('glasses');return true;},undefined,undefined,undefined,undefined,undefined,{session:'reminder',deliver:async()=>{}}));
  t.after(await f.runtime.watchCare(f.phone,async()=>{shown.push('phone');return true;}));await f.runtime.ownerInput(f.phone);
  await f.runtime.scheduledDelivery({principal_id:'owner',device_id:'phone',id:'online-phone',text:'起来走两步',captured_at:new Date().toISOString()});
  assert.deepEqual(shown,['phone']);assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),['起来走两步']);
});

test('worn live glasses take reminder speech before the most recent Mac and persist it for both chats',async t=>{
  const f=await fixture(t),spoken:string[]=[];let shown=0;
  t.after(await f.runtime.watchCare(f.mac,async()=>{shown++;return true;},async()=>{spoken.push('mac');return true;}));
  t.after(await f.runtime.watchCare(f.glasses,async()=>{shown++;return true;},async()=>{spoken.push('glasses');return true;},undefined,()=>true,undefined,undefined,{session:'reminder',deliver:async()=>{}}));
  await f.runtime.wearState(f.glasses,true);await f.runtime.ownerInput(f.mac);
  assert.deepEqual(f.runtime.terminals('owner').map(source=>source.device_id),['glasses','mac']);
  await f.runtime.scheduledDelivery({principal_id:'owner',device_id:'mac',id:'worn-glasses',text:'起来走两步',captured_at:new Date().toISOString()});
  assert.deepEqual(spoken,['glasses']);assert.equal(shown,0);assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),['起来走两步']);
});

test('ordinary reminder replay sends one notification and retains its receipt across runtime restart',async t=>{
  const notices:{title:string;body:string}[]=[],f=await fixture(t,notices);
  const value={principal_id:'owner',device_id:'phone',id:'ordinary-reminder-replay',reminder_id:'ordinary-reminder-replay',
    text:'fixture reminder',captured_at:new Date().toISOString()};
  await f.runtime.scheduledDelivery(value);await f.runtime.scheduledDelivery(value);
  const count=f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${value.id}`).length;
  console.log('REMINDER_REPLAY_OBSERVATION',JSON.stringify({timeline_items:count,notification_calls:notices.length}));
  assert.equal(count,1);assert.equal(notices.length,1);
  assert.equal((await f.storage.list('scheduled-deliveries')).length,1);
  await assert.rejects(f.runtime.scheduledDelivery({...value,text:'conflicting reminder'}),/SCHEDULE_DELIVERY_CONFLICT/);
  await f.runtime.close();
  const admission=new RunAdmission(f.storage,f.native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:100000,
    poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'timeline-test'});
  const output=new OutputAuthority(f.storage,{listRunReceipts:async()=>({sources:[]})});
  const restarted=new PersonalAIOSRuntime({storage:f.storage,archive:f.archive,native:f.native,health:f.health,admission,output,
    devices:[],skill:'controlled',max_read_bytes:8192,notify:async notice=>{notices.push(notice);}});
  try{await restarted.scheduledDelivery(value);assert.equal(notices.length,1);}finally{await restarted.close();}
});

test('parallel ordinary reminder replays share delivery and reject conflicting input',async t=>{
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();let notifications=0;
  const f=await fixture(t,async()=>{notifications++;entered.resolve();await leave.promise;});
  const value={principal_id:'owner',device_id:'phone',id:'parallel-reminder',text:'fixture reminder',captured_at:new Date().toISOString()};
  const first=f.runtime.scheduledDelivery(value);await entered.promise;
  const replay=f.runtime.scheduledDelivery(value);
  const conflict=assert.rejects(f.runtime.scheduledDelivery({...value,text:'conflicting reminder'}),/SCHEDULE_DELIVERY_CONFLICT/);
  leave.resolve();await Promise.all([first,replay,conflict]);
  assert.equal(notifications,1);assert.equal((await f.storage.list('scheduled-deliveries')).length,1);
});

test('failed ordinary reminder notification surfaces the error and remains retryable',async t=>{
  let attempts=0;const f=await fixture(t,async()=>{if(++attempts===1)throw new Error('NOTIFICATION_OFFLINE');});
  const value={principal_id:'owner',device_id:'phone',id:'retry-reminder',text:'fixture reminder',captured_at:new Date().toISOString()};
  await assert.rejects(f.runtime.scheduledDelivery(value),/NOTIFICATION_OFFLINE/);
  assert.deepEqual(await f.storage.list('scheduled-deliveries'),[]);
  await f.runtime.scheduledDelivery(value);await f.runtime.scheduledDelivery(value);
  assert.equal(attempts,2);assert.equal((await f.storage.list('scheduled-deliveries')).length,1);
  assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${value.id}`).length,1);
});

test('offline reminder survives unavailable live delivery and is visible on the next chat sync',async t=>{
  const f=await fixture(t),reminder={principal_id:'owner',device_id:'mac',id:'offline-reminder',text:'离线提醒',captured_at:new Date().toISOString()};
  await assert.rejects(f.runtime.scheduledDelivery(reminder),/CARE_OUTREACH_UNAVAILABLE/);
  t.after(await f.runtime.watchCare(f.mac,async()=>true));
  assert.deepEqual(f.runtime.timeline!.page(f.mac.principal_id).items.map(item=>item.text),[reminder.text]);
  assert.deepEqual(f.runtime.timeline!.page(f.phone.principal_id).items.map(item=>item.text),[reminder.text]);
});

test('full errand snapshot reaches inactive phone and Mac while glasses retain the existing inactive view',async t=>{
  const f=await fixture(t),views=new Map<string,ErrandProgress[][]>();
  for(const source of [f.phone,f.mac,f.glasses]){
    const rows:ErrandProgress[][]=[];views.set(source.device_id,rows);
    t.after(await f.runtime.watchCare(source,async()=>true,undefined,undefined,undefined,{deliver:async()=>false,reply:async()=>false,progress:async running=>{rows.push(running);return true;}}));
  }
  const running:ErrandProgress[]=[{job_id:'job-123456abcdef',title:'整理发票',app:'电脑',state:'running',started_at:new Date().toISOString(),step:1,max_steps:4}];
  await f.runtime.ownerInput(f.phone);assert.equal(f.runtime.activeTerminal(f.mac),false);
  await f.runtime.errandProgress('owner',running,error=>assert.fail(String(error)));
  await until(()=>views.get('mac')!.at(-1),rows=>JSON.stringify(rows)===JSON.stringify(running));
  for(const id of ['phone','mac'])assert.deepEqual(views.get(id)!.at(-1),running);assert.deepEqual(views.get('glasses')!.at(-1),[]);
  await f.runtime.ownerInput(f.mac);assert.equal(f.runtime.activeTerminal(f.phone),false);
  await f.runtime.errandProgress('owner',[],error=>assert.fail(String(error)));
  await until(()=>views.get('mac')!.at(-1),rows=>rows?.length===0);
  for(const id of ['phone','mac','glasses'])assert.deepEqual(views.get(id)!.at(-1),[]);
});

test('desktop queue rejects unconfirmed guest gestures and proactive-care runs before any entry is stored',async t=>{
  const f=await fixture(t),session='guest-gesture-session';
  t.after(await f.runtime.watchCare(f.glasses,async()=>true,undefined,undefined,undefined,undefined,undefined,{session,deliver:async()=>{}}));
  await f.runtime.wearState(f.glasses,true);await f.runtime.ownerInput(f.glasses);
  await f.runtime.submit(f.raw(f.phone,'owner-question','请给眼镜发一个选项'),f.phone,session,true);
  const owner=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  const card=await until(()=>f.runtime.tool('paios_terminal_question',{context:{run_id:owner!.run_id,session_id:session,tool_call_id:'question'},args:{question:'稍后再做吗？',options:[{id:'yes',label:'稍后再做',lines:[]},{id:'no',label:'取消',lines:[]}]}}),value=>typeof(value as {card_id?:string}).card_id==='string') as {card_id:string};
  await f.runtime.tool('paios_open_reply',{context:{run_id:owner!.run_id,session_id:session,tool_call_id:'silent'},args:{reply_mode:'none'}});owner!.status='completed';
  const guest=await f.runtime.submitGlassesGesture({event_id:'guest-answer',captured_at:new Date().toISOString()},f.glasses,{card_id:card.card_id,kind:'nod'});
  assert.equal(runScope(guest.processed_event),'guest');
  await f.runtime.submit(f.raw(f.phone,'care',{kind:'proactive_care',care_id:'care-1',text:'care suggestion'}),f.phone,'scope-care',false);
  for(const [id,runSession] of [['guest-answer',session],['care','scope-care']]){
    const run=await until(()=>[...f.runs.values()].find(value=>value.run_id!==owner!.run_id&&value.conversation_session_id===runSession),value=>!!value);
    await until(async()=>{let result:unknown;
      try {result=await f.runtime.tool('paios_desktop_queue',{context:{run_id:run!.run_id,session_id:runSession!,tool_call_id:`queue-${id}`},args:{action:'add',task:'must not be queued'}});}
      catch(error){assert.match(String(error),/DESKTOP_QUEUE_OWNER_REQUIRED/);return true;}
      assert.equal((result as {error_code?:string}).error_code,'RUN_BINDING_PENDING');return false;
    },Boolean);
  }
  assert.deepEqual(f.runtime.timeline!.queue('owner','scope-check',{action:'list'}),{items:[]});assert.deepEqual(f.errors,[]);
});


test('Amendment3 owner scope excludes a real guest reply from the shared timeline',async t=>{
  const f=await fixture(t),session='guest-private-session';
  t.after(await f.runtime.watchCare(f.glasses,async()=>true,undefined,undefined,undefined,undefined,undefined,{session,deliver:async()=>{}}));
  await f.runtime.wearState(f.glasses,true);await f.runtime.ownerInput(f.glasses);
  await f.runtime.submit(f.raw(f.phone,'private-question','请给眼镜发一个选项'),f.phone,session,true);
  const owner=await until(()=>[...f.runs.values()].find(run=>run.conversation_session_id===session),Boolean);
  const card=await until(()=>f.runtime.tool('paios_terminal_question',{context:{run_id:owner!.run_id,session_id:session,tool_call_id:'question'},args:{question:'稍后再做吗？',options:[{id:'yes',label:'稍后再做',lines:[]},{id:'no',label:'取消',lines:[]}]}}),value=>typeof(value as {card_id?:string}).card_id==='string') as {card_id:string};
  await f.runtime.tool('paios_open_reply',{context:{run_id:owner!.run_id,session_id:session,tool_call_id:'silent'},args:{reply_mode:'none'}});owner!.status='completed';
  const guest=await f.runtime.submitGlassesGesture({event_id:'private-guest-answer',captured_at:new Date().toISOString()},f.glasses,{card_id:card.card_id,kind:'nod'});
  assert.equal(runScope(guest.processed_event),'guest');
  const run=await until(()=>[...f.runs.values()].find(value=>value.run_id!==owner!.run_id&&value.conversation_session_id===session),Boolean);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
  run!.output='private guest response';run!.status='completed';
  await until(()=>f.runtime.event(f.glasses,session,guest.processed_event.processed_event_id),value=>value.admission.state==='completed');
  await f.runtime.result(f.glasses,session,guest.processed_event.processed_event_id);
  assert.ok(f.runtime.timeline!.page('owner').items.every(item=>item.text!=='private guest response'&&item.item_id!==`me-${guest.processed_event.event_id}`));
});

test('principal progress is isolated and a blocked recipient cannot block another recipient or close',async t=>{
  const f=await fixture(t),blocked=Promise.withResolvers<void>(),seen=new Map<string,ErrandProgress[][]>();
  for(const source of [f.phone,f.mac,f.foreign]){
    seen.set(source.device_id,[]);
    t.after(await f.runtime.watchCare(source,async()=>true,undefined,undefined,undefined,{deliver:async()=>false,reply:async()=>false,progress:async rows=>{
      seen.get(source.device_id)!.push(rows);if(source.device_id==='phone')await blocked.promise;return true;
    }}));
  }
  const job=(id:string):ErrandProgress=>({job_id:id,title:id,app:'desktop',state:'running',started_at:new Date().toISOString(),step:1,max_steps:4});
  await f.runtime.errandProgress('owner',[job('owner-private')],error=>assert.fail(String(error)));
  await until(()=>seen.get('mac')!.at(-1),Boolean);assert.equal(seen.get('foreign')!.length,0);
  for(let n=0;n<400;n++)await f.runtime.errandProgress('owner',[job(`latest-${n}`)],error=>assert.fail(String(error)));
  assert.equal(seen.get('phone')!.length,1);assert.equal(seen.get('mac')!.at(-1)![0]!.job_id,'latest-399');
  await f.runtime.errandProgress('other',[job('foreign-private')],error=>assert.fail(String(error)));
  await until(()=>seen.get('foreign')!.at(-1),Boolean);assert.equal(seen.get('mac')!.at(-1)![0]!.job_id,'latest-399');
  const closed=await Promise.race([f.runtime.close().then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))]);assert.equal(closed,true);blocked.resolve();
});

test('400 confirmation changes retain one latest snapshot and a stalled confirmation cannot block close',async t=>{
  const f=await fixture(t),blocked=Promise.withResolvers<void>();let delivered=0;
  const stop=await f.runtime.watchVoiceConfirmations(f.mac,async()=>{delivered++;if(delivered===1)await blocked.promise;},error=>assert.fail(String(error)),true);
  await until(()=>delivered,n=>n===1);for(let n=0;n<400;n++)f.runtime.terminalChanged(f.mac);
  assert.equal(delivered,1);blocked.resolve();await until(()=>delivered,n=>n===2);stop();
  const stuck=Promise.withResolvers<void>();let entered=false;
  await f.runtime.watchVoiceConfirmations(f.mac,async()=>{entered=true;await stuck.promise;},error=>assert.fail(String(error)),true);await until(()=>entered,Boolean);
  const closed=await Promise.race([f.runtime.close().then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))]);assert.equal(closed,true);stuck.resolve();
});

test('owner forget uses the same durable removal authority and Mac cannot forget',async t=>{
  const f=await fixture(t),raw=f.raw(f.phone,'forget-me','owner text'),accepted=await f.runtime.submit(raw,f.phone,'forget-session',true),seq=f.runtime.timeline!.head('owner');
  await assert.rejects(f.runtime.forgetTimeline(f.mac,[accepted.processed_event.processed_event_id]),/TIMELINE_OWNER_REQUIRED/);
  assert.equal(await f.runtime.forgetTimeline(f.phone,[accepted.processed_event.processed_event_id]),1);
  assert.deepEqual(f.runtime.timeline!.page('owner',{after_seq:seq}).removals?.map(row=>row.removed_seqs),[[seq]]);
  assert.deepEqual(f.runtime.timeline!.page('owner').items,[]);
  await f.runtime.submit(raw,f.phone,'forget-session',true);
  const run=await until(()=>[...f.runs.values()].find(run=>run.conversation_session_id==='forget-session'),Boolean);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:'forget-session',tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
  run!.output='late forgotten final';run!.status='completed';
  await until(()=>f.runtime.event(f.phone,'forget-session',accepted.processed_event.processed_event_id),value=>value.admission.state==='completed');
  await f.runtime.result(f.phone,'forget-session',accepted.processed_event.processed_event_id);
  assert.deepEqual(f.runtime.timeline!.page('owner').items,[]);
});


test('a final sealed before a restart whose timeline write failed is recorded once by recovery, without any client',async t=>{
  const f=await fixture(t),session='crash-seam',accepted=await f.runtime.submit(f.raw(f.phone,'crash-seam','finish this'),f.phone,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
  const append=f.runtime.timeline!.append.bind(f.runtime.timeline!);
  f.runtime.timeline!.append=item=>{if(item.kind==='yimi')throw Error('injected timeline insertion failure');return append(item);};
  run!.output='durable final';run!.status='completed';
  // The automatic output seals the reply durably, then the timeline write fails: the output obligation stays pending.
  await until(()=>f.errors,errors=>errors.some(error=>/injected timeline/.test(String(error))));
  assert.ok(f.runtime.timeline!.page('owner').items.every(item=>item.kind!=='yimi'));assert.ok((await f.storage.list('output-journal')).length>0);await f.runtime.close();
  const admission=new RunAdmission(f.storage,f.native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'timeline-test'}),errors:unknown[]=[];
  const runtime=new PersonalAIOSRuntime({storage:f.storage,archive:new RawArchive(f.storage,8192),admission,native:f.native,
    output:new OutputAuthority(f.storage,{listRunReceipts:async()=>({sources:[]})}),devices:[{...f.phone,token_sha256:sha256('phone')}],skill:'controlled',max_read_bytes:8192,automatic_output:{onError:error=>errors.push(error)}});t.after(()=>runtime.close());
  await runtime.configureTimeline({directory:join(f.root,'timeline')});await admission.recover();await until(()=>runtime.timeline!.page('owner').items,items=>items.some(item=>item.text==='durable final'));
  await runtime.result((await runtime.authenticate('phone'))!,session,accepted.processed_event.processed_event_id);
  await admission.recover();assert.equal(runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${accepted.processed_event.processed_event_id}`).length,1);assert.deepEqual(errors,[]);await runtime.close();
});

async function acknowledge(runtime:PersonalAIOSRuntime,source:RegisteredDevice,session:string,processed:string,value:Awaited<ReturnType<PersonalAIOSRuntime['result']>>) {
  const chunks=value.chunks,first=chunks[0]!;
  await runtime.acknowledge(source,session,processed,{output_id:first.output_id,reply_id:first.reply_id,reply_epoch:first.reply_epoch,
    target_device_id:first.target_device_id,route_version:first.route_version,highest_contiguous_seq:chunks.length,status:'rendered',observed_at:new Date().toISOString()});
}

// Observation probe for the delivery authority.
test('A5 unattributed and care inputs are absent; owner-terminal finals enter once sealed; care candidates and silent outputs stay absent',async t=>{
  const f=await fixture(t);
  for(const kind of ['device_status','proactive_care','silent']){
    const session=`delivery-${kind}`,accepted=await f.runtime.submit(f.raw(f.phone,session,{kind:kind==='silent'?'device_status':kind,text:'unattributed'}),f.phone,session,false);
    const d=accepted.processed_event;
    assert.equal(f.runtime.timeline!.page('owner').items.some(item=>item.kind==='owner'),false);
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);
    await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:kind==='silent'?'none':'text'}}),value=>['opened','silent'].includes((value as {status:string}).status));
    run!.output=`delivered ${kind}`;run!.status='completed';
    const final=await until(()=>f.runtime.result(f.phone,session,d.processed_event_id),value=>value.result.reply_phase==='sealed');
    // A care run's final is a candidate; only what care actually says reaches the timeline, through outreach.
    const said=kind==='device_status';
    assert.equal(f.runtime.timeline!.page('owner').items.find(item=>item.item_id===`her-${d.processed_event_id}`)?.text,said?run!.output:undefined);
    if(kind!=='silent'){
      await acknowledge(f.runtime,f.phone,session,d.processed_event_id,final);
      assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${d.processed_event_id}`).length,said?1:0);
    }
  }
  assert.equal(f.runtime.timeline!.page('owner').items.length,1);
});

test('a barge-in after the seal keeps the full sealed text once; a stop before the seal and a failed run record no reply',async t=>{
  const f=await fixture(t);
  const start=async(session:string)=>{
    const accepted=await f.runtime.submit(f.raw(f.phone,session,`问题${session}`),f.phone,session,true),d=accepted.processed_event;
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);
    await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
    return {d,run:run!,epoch:1}; // The run's first open is its first reply epoch.
  };
  const hers=(d:{processed_event_id:string})=>f.runtime.timeline!.page('owner').items.filter(item=>item.item_id===`her-${d.processed_event_id}`);
  // Barge-in after the seal: clients received the whole sealed text, so the history keeps all of it, once.
  const late=await start('barge-late');late.run.output='说完的整段答复';late.run.status='completed';
  await until(()=>f.runtime.result(f.phone,'barge-late',late.d.processed_event_id),value=>value.result.reply_phase==='sealed');
  await f.runtime.cancelPlayback(f.phone,'barge-late',late.d.processed_event_id,late.epoch);
  const interrupted=await f.runtime.result(f.phone,'barge-late',late.d.processed_event_id);
  assert.equal(interrupted.result.reply_phase,'interrupted');assert.deepEqual(interrupted.chunks,[]);
  assert.deepEqual(hers(late.d).map(item=>item.text),['说完的整段答复']);
  // A stop before the seal: no text was sealed or sent, so nothing of hers is recorded.
  const early=await start('barge-early');await f.runtime.cancelPlayback(f.phone,'barge-early',early.d.processed_event_id,early.epoch);
  early.run.output='被打断前没发出的答复';early.run.status='completed';
  const stopped=await until(()=>f.runtime.result(f.phone,'barge-early',early.d.processed_event_id),value=>value.result.reply_phase!=='failed'||value.admission.state==='completed');
  assert.equal(stopped.result.reply_phase,'interrupted');assert.deepEqual(hers(early.d),[]);
  // A failed run has no reply text; the owner's question stays without an answer item.
  const failed=await start('failed-run');failed.run.status='failed';
  const result=await until(()=>f.runtime.result(f.phone,'failed-run',failed.d.processed_event_id),value=>value.admission.state==='failed');
  assert.equal(result.result.reply_phase,'failed');assert.deepEqual(hers(failed.d),[]);
  assert.equal(f.runtime.timeline!.page('owner').items.filter(item=>item.kind==='owner').length,3);assert.deepEqual(f.errors,[]);
});

test('raw deletion removes projected processed IDs through timeline removal and blocks replay',async t=>{
  const f=await fixture(t),accepted=await f.runtime.submit(f.raw(f.phone,'delete-raw','owner request'),f.phone,'delete-raw',true),d=accepted.processed_event;
  const cursor=f.runtime.timeline!.head('owner');assert.equal(f.runtime.timeline!.page('owner').items.length,1);
  await f.archive.delete(d.raw_ref,'owner');
  const page=f.runtime.timeline!.page('owner',{after_seq:cursor});
  assert.equal(f.runtime.timeline!.page('owner').items.length,0);assert.equal(page.removals?.length,1);
  await f.runtime.timeline!.input(d,'delete-raw');assert.equal(f.runtime.timeline!.page('owner').items.length,0);
});


test('raw-delete intent committed before interrupted callback removes timeline text on restart',async t=>{
  const f=await fixture(t),session='delete-crash',accepted=await f.runtime.submit(f.raw(f.phone,session,'remove after crash'),f.phone,session,true),d=accepted.processed_event;
  const cursor=f.runtime.timeline!.head('owner'),publish=f.storage.publishIngressMeta.bind(f.storage);
  f.storage.publishIngressMeta=async(namespace,key,bytes)=>{
    const saved=await publish(namespace,key,bytes);
    if(namespace==='owner-deletions')throw Error('interrupted after deletion intent');
    return saved;
  };
  await assert.rejects(f.archive.delete(d.raw_ref,'owner'),/interrupted after deletion intent/);
  assert.equal((await f.storage.list('owner-deletions')).length,1);
  assert.equal(f.runtime.timeline!.page('owner').items.length,1);
  f.storage.publishIngressMeta=publish;await f.runtime.close();
  const archive=new RawArchive(f.storage,8192),admission=new RunAdmission(f.storage,f.native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'timeline-test'});
  const runtime=new PersonalAIOSRuntime({storage:f.storage,archive,admission,native:f.native,output:new OutputAuthority(f.storage,{listRunReceipts:async()=>({sources:[]})}),
    devices:[{...f.phone,token_sha256:sha256('phone')}],skill:'controlled',max_read_bytes:8192});t.after(()=>runtime.close());
  await runtime.configureTimeline({directory:join(f.root,'timeline')});
  assert.deepEqual(runtime.timeline!.page('owner').items,[]);
  const removed=runtime.timeline!.page('owner',{after_seq:cursor});assert.deepEqual(removed.removals?.map(row=>row.removed_seqs),[[cursor]]);
  await runtime.timeline!.input(d,session);assert.deepEqual(runtime.timeline!.page('owner').items,[]);
  await archive.delete(d.raw_ref,'owner');assert.equal(runtime.timeline!.head('owner'),removed.head_seq);
});


test('A6.4 explicit Mac attachments become metadata-only owner chips and replay creates no duplicate',async t=>{
  const f=await fixture(t),attachments=[{grant_id:'grant-invoice',path:'/Users/owner/Downloads/发票.pdf',name:'发票.pdf',kind:'pdf' as const,size:0}];
  const raw={...f.raw(f.mac,'attached-file','整理这个文件'),attachments};
  await f.runtime.submit(raw,f.mac,'attached-session',true);
  await f.runtime.submit(raw,f.mac,'attached-session',true);
  const rows=f.runtime.timeline!.page('owner').items;
  assert.equal(rows.length,1);assert.equal(rows[0]!.kind,'owner');assert.equal(rows[0]!.text,'整理这个文件');
  assert.deepEqual(rows[0]!.attachments,[{name:'发票.pdf',kind:'pdf',size:0}]);
  const serialized=JSON.stringify(rows);assert.ok(!serialized.includes('grant-invoice'));assert.ok(!serialized.includes('/Users/owner'));
});

test('a failed confirmation or progress publication is reported, keeps the terminal, and its latest state is retried',async t=>{
  // A failed confirmations send must not kill that publisher for the connection (later prompts never arrived) and a
  // failed progress send disconnected the terminal. Liveness belongs to the SDK's room events, not to one publication.
  const f=await fixture(t),errors:unknown[]=[],progress:ErrandProgress[][]=[];let confirmations=0,disconnects=0;
  t.after(await f.runtime.watchVoiceConfirmations(f.mac,async()=>{if(++confirmations===1)throw new Error('SDK_PUBLISH_FAILED');},error=>errors.push(error),true));
  await until(()=>confirmations,n=>n===2);
  t.after(await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,{deliver:async()=>false,reply:async()=>false,progress:async rows=>{
    progress.push(rows);if(progress.length===1)throw new Error('SDK_PUBLISH_FAILED');return true;}},async()=>{disconnects++;}));
  await f.runtime.errandProgress('owner',[{job_id:'job-a',title:'a',app:'desktop',state:'running',started_at:new Date().toISOString(),step:1,max_steps:4}],error=>errors.push(error));
  await until(()=>progress.length,n=>n===2);
  assert.deepEqual(progress.map(rows=>rows.map(row=>row.job_id)),[['job-a'],['job-a']],'the failed snapshot is retried, not dropped');
  assert.equal(disconnects,0);assert.equal(errors.length,2);assert.ok(errors.every(error=>/SDK_PUBLISH_FAILED/.test(String(error))));
});

for(const state of ['same-call','closed','new-call','non-voice'] as const)
test(`voice-origin queue completion stays bound to its original call and reaches attached app: ${state}`,async t=>{
  const notices:{title:string;body:string}[]=[],f=await fixture(t,async notice=>{notices.push(notice);});
  const spoken:{text:string;origin:unknown}[]=[],shown:string[]=[],session='voice-queue-origin';
  let otherDeviceSpeech=0;
  t.after(await f.runtime.watchCare(f.phone,async(_id,text)=>{shown.push(text);return true;},async(text,origin)=>{
    spoken.push({text,origin});
    // The transport alone knows the currently live call. Only its exact original call may accept speech.
    return state==='non-voice'||state==='same-call'&&origin?.call_id==='original-call';
  }));
  t.after(await f.runtime.watchCare(f.mac,async()=>true,async()=>{otherDeviceSpeech++;return true;}));
  const accepted=state==='non-voice'?
    await f.runtime.submit(f.raw(f.phone,'queue-origin','整理发票'),f.phone,session,true):
    await f.runtime.submitCallTurn(f.raw(f.phone,'queue-origin',{kind:'voice_turn',call_id:'original-call',turn:0,speaker:'owner',user:'整理发票',assistant:'我来处理'}),f.phone,session);
  const origin=await until(()=>[...f.runs.values()].find(run=>run.conversation_session_id===session),Boolean);
  await until(()=>f.runtime.tool('paios_desktop_queue',{context:{run_id:origin!.run_id,session_id:session,tool_call_id:'queue'},args:{action:'add',task:'整理发票'}}),value=>!!(value as {queue_id?:string}).queue_id);
  await f.runtime.desktopReady(f.mac);
  const work=await until(()=>[...f.runs.values()].find(run=>run.run_id!==origin!.run_id),Boolean);
  const workSession=work!.conversation_session_id!;
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:work!.run_id,session_id:workSession,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
  work!.output='发票已经整理好了';work!.status='completed';
  await until(()=>spoken,rows=>rows.length===1);
  if(state==='closed'||state==='new-call'){
    await until(()=>shown,rows=>rows.length===1);
    assert.deepEqual(shown,['发票已经整理好了']);
  }
  assert.deepEqual(notices,[]);
  assert.equal(otherDeviceSpeech,0);
  const row=f.runtime.timeline!.page('owner').items.find(item=>item.text==='发票已经整理好了');assert.ok(row);
  const result=await f.runtime.result(f.mac,workSession,row.item_id.slice(4));assert.equal(result.result.reply_text,'发票已经整理好了');
  assert.deepEqual(spoken,[{text:'发票已经整理好了',origin:state==='non-voice'?undefined:{device_id:'phone',call_id:'original-call',identity:'owner',turn:0,message_id:result.result.processed_event_id}}]);
  assert.notEqual(accepted.processed_event.processed_event_id,result.result.processed_event_id);
  assert.deepEqual(f.errors,[]);
});

test('captured server call archives its turn and close after transport expiry while stale public requests stay denied',async t=>{
  const f=await fixture(t),session='captured-call-session',call_id='captured-call';
  const captured=await f.runtime.captureCall(f.phone,session,call_id);
  assert.ok(Object.isFrozen(captured)&&Object.isFrozen(captured.source));
  const inactive=Object.assign(new Error('SOURCE_BINDING_INACTIVE'),{code:'SOURCE_BINDING_INACTIVE'});
  const revalidation=t.mock.method(f.authority,'revalidate',async()=>{throw inactive;});
  const turn={kind:'voice_turn',call_id,turn:0,user:'controlled captured input',assistant:'controlled spoken answer',route:'front_only',speaker:'owner'};
  const raw=f.raw(f.phone,'captured-turn',turn),closed={reason:'disconnected',final_turn:0,processed_event_ids:[] as string[],closed_at:new Date().toISOString()};
  await assert.rejects(f.runtime.submitCallTurn(raw,f.phone,session),error=>error===inactive);
  await assert.rejects(f.runtime.closeCall(f.phone,session,{...closed,call_id}),error=>error===inactive);
  await assert.rejects(f.runtime.captureCall(f.phone,session,'new-call'),error=>error===inactive);
  const denied=revalidation.mock.callCount();
  assert.equal(captured.locate(),undefined,'a captured location read does not renew transport authorization');
  await assert.rejects(captured.turn(f.raw(f.phone,'foreign-call-turn',{...turn,call_id:'another-call'})),{code:'CALL_TURN_BINDING_DENIED'});
  const saved=await captured.turn(raw);
  assert.equal(saved.admission,null);
  assert.equal(f.mirrors.get(saved.processed_event.processed_event_id)?.session,`native-front-${session}`);
  const archived=await f.archive.readRecord(saved.processed_event.raw_ref,'owner',saved.processed_event.archive_revision,{maxReadBytes:8192});
  assert.equal(archived.kind,'original');
  const sealed=await captured.close({...closed,processed_event_ids:[saved.processed_event.processed_event_id]});
  assert.ok('processed_event' in sealed);
  assert.deepEqual(sealed.processed_event.content.app_event,{kind:'call_closed',...closed,call_id,processed_event_ids:[saved.processed_event.processed_event_id]});
  assert.equal(revalidation.mock.callCount(),denied,'server finalization never revalidates the expired transport');
});

test('call close observation admits without live native history or replaying task text; false wakes never start a brain run',async t=>{
  const f=await fixture(t),session='close-context';
  const task=await f.runtime.submitCallTurn(f.raw(f.phone,'authorized-work',{kind:'voice_turn',call_id:'call',turn:0,speaker:'owner',user:'整理发票',assistant:'我来做'}),f.phone,session);
  await until(()=>f.runs.size,size=>size===1);const original=[...f.runs.values()][0]!;
  const historyUnavailable=async()=>{throw new Error('NATIVE_HISTORY_UNAVAILABLE');};
  const sessions=t.mock.method(f.native,'sessions',historyUnavailable),messages=t.mock.method(f.native,'messages',historyUnavailable);
  const closed={call_id:'call',reason:'goodbye',final_turn:0,processed_event_ids:[task.processed_event.processed_event_id],closed_at:new Date().toISOString()};
  const first=await f.runtime.closeCall(f.phone,session,closed),again=await f.runtime.closeCall(f.phone,session,closed);
  assert.ok('processed_event' in first&&'processed_event' in again);
  assert.equal(first.processed_event.processed_event_id,again.processed_event.processed_event_id);
  assert.equal(runScope(first.processed_event),'owner','paired device context scope is distinct from action permission');
  assert.deepEqual(await ownerActionGrant(first.processed_event),[]);
  assert.deepEqual(first.processed_event.content.app_event,{kind:'call_closed',...closed});
  assert.equal(original.status,'running','hangup does not cancel the authorized task');original.status='completed';
  await until(()=>f.runs.size,size=>size===2);
  await f.runtime.closeCall(f.phone,session,{...closed,call_id:'false',reason:'false_wake',processed_event_ids:[]});
  assert.equal(sessions.mock.callCount(),0);assert.equal(messages.mock.callCount(),0);
  assert.equal(f.runs.size,2);assert.deepEqual(f.errors,[]);
});

for(const failFirst of [false,true])
test(`closed call completion with no displayed text reuses sealed OUT and notifies once; retry=${failFirst}`,async t=>{
  const notices:{title:string;body:string}[]=[];let attempts=0;
  const f=await fixture(t,async notice=>{if(++attempts===1&&failFirst)throw new Error('PUSH_UNAVAILABLE');notices.push(notice);}),session='closed-result';
  t.after(await f.runtime.watchCare(f.phone,async()=>false));
  const {processed_event:d}=await f.runtime.submitCallTurn(f.raw(f.phone,'closed-work',{kind:'voice_turn',call_id:'ended',turn:0,speaker:'owner',user:'整理发票',assistant:'我来做'}),f.phone,session);
  const run=await until(()=>[...f.runs.values()][0],value=>!!value);assert.ok(run);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),value=>(value as {status?:string}).status==='opened');
  run.output='发票整理完成';run.status='completed';await until(()=>f.runtime.event(f.phone,session,d.processed_event_id),value=>value.admission.state==='completed');
  const final=await f.runtime.result(f.phone,session,d.processed_event_id);
  await acknowledge(f.runtime,f.phone,session,d.processed_event_id,final);
  await until(()=>attempts,n=>n>=1);
  if(failFirst){await until(()=>f.errors.length,n=>n===1);assert.match(String(f.errors[0]),/PUSH_UNAVAILABLE/);f.errors.length=0;}
  await Promise.all([f.runtime.persistCallResult(f.phone,session,d.processed_event_id),f.runtime.persistCallResult(f.phone,session,d.processed_event_id)]);
  await f.runtime.persistCallResult(f.phone,session,d.processed_event_id);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),['整理发票','我来做','发票整理完成']);
  assert.deepEqual(notices,[{title:'依米',body:'发票整理完成'}]);assert.equal(attempts,failFirst?2:1);
  assert.equal(f.runs.size,1);assert.deepEqual(f.errors,[]);
});


test('late-night voice, avatar, text and message share earlier owner and Yimi turns from Hermes, then Mac and glasses continue',async t=>{
  const f=await fixture(t);
  const finish=async(source:RegisteredDevice,session:string,raw:RawEvent,reply:string,call=false)=>{
    const accepted=call?await f.runtime.submitCallTurn(raw,source,session):await f.runtime.submit(raw,source,session,true);
    const run=await until(()=>[...f.runs.values()].find(r=>r.conversation_session_id===session),r=>!!r);
    await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:call?'none':'text'}}),v=>(v as {status?:string}).status===(call?'silent':'opened'));
    if(!call)f.histories.get(session)!.push({role:'assistant',content:reply,timestamp:Date.now()/1000});
    run!.output=reply;run!.status='completed';
    await until(()=>f.runtime.event(source,session,accepted.processed_event.processed_event_id),v=>v.admission.state==='completed');
    await f.runtime.result(source,session,accepted.processed_event.processed_event_id);
    return f.bodies.find(b=>b.session_id===session)!.instructions;
  };
  const voice={kind:'voice_turn',call_id:'late-call',turn:0,user:'今晚要把方案写完',assistant:'这么晚还没睡呀？',interrupted:false,speaker:'owner'};
  await finish(f.phone,'late-voice',f.raw(f.phone,'late-voice',voice),'',true);
  const avatar=await f.runtime.callContext(f.phone,'late-avatar');
  for(const text of [voice.user,voice.assistant])assert.ok(avatar.includes(text),avatar);
  const avatarTurn={...voice,call_id:'late-avatar',user:'写完这段就睡',assistant:'好，我陪你收个尾。'};
  const avatarInstructions=await finish(f.phone,'late-avatar',f.raw(f.phone,'late-avatar',avatarTurn),'',true);
  assert.ok(avatarInstructions.includes(voice.assistant));
  const typed=await finish(f.phone,'late-text',f.raw(f.phone,'late-text','帮我看这段方案'),'这段可以收尾了。');
  for(const text of [voice.user,voice.assistant,avatarTurn.user,avatarTurn.assistant])assert.ok(typed.includes(text),typed);
  const message=await finish(f.phone,'late-message',f.raw(f.phone,'late-message','我发到微信了'),'收到，继续刚才的方案。');
  for(const text of [voice.assistant,avatarTurn.assistant,'帮我看这段方案','这段可以收尾了。'])assert.ok(message.includes(text),message);
  const mac=await finish(f.mac,'late-mac',f.raw(f.mac,'late-mac','电脑上接着看'),'好，接着看。');
  assert.ok(mac.includes('我发到微信了')&&mac.includes('收到，继续刚才的方案。'));
  f.runtime.timeline!.append({principal_id:'owner',item_id:'cache-only',kind:'yimi',via:'text',text:'UI缓存不是原生会话',at_ms:Date.now()});
  const glasses=await f.runtime.callContext(f.glasses,'late-glasses');
  assert.ok(!glasses.includes('UI缓存不是原生会话'));
  assert.ok(glasses.includes('电脑上接着看')&&glasses.includes('好，接着看。'));
  assert.deepEqual(f.errors,[]);
});


test('explicit senses use fresh phone fixes and timestamped health samples without enabling capture',async t=>{
  const f=await fixture(t),session='senses-session';
  await f.runtime.submit(f.raw(f.phone,'senses-request','看看我的位置和心率'),f.phone,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  const invoke=(sense:string)=>f.runtime.tool('paios_senses',{context:{run_id:run!.run_id,session_id:session,tool_call_id:`sense-${sense}`},args:{sense}});
  assert.deepEqual(await until(()=>invoke('heart_rate'),value=>(value as {status:string}).status!=='pending'),{status:'unavailable',error_code:'HEART_RATE_SAMPLE_NOT_AVAILABLE'});
  const observed=Date.now()-60000;
  f.health.ingest('owner','phone',{control_id:'heart-page',metric:'heartRate',unit:'count/min',tz:'UTC',sources:['Apple Watch'],
    samples:[{id:'00000000-0000-0000-0000-000000000001',s:observed,e:observed,src:0,v:72}],deleted:[]});
  const heart=await invoke('heart_rate') as {status:string;value:number;observed_at:string;measurement_requested:boolean;source:string};
  assert.equal(heart.status,'known_sample');assert.equal(heart.value,72);assert.equal(heart.observed_at,new Date(observed).toISOString());
  assert.equal(heart.measurement_requested,false);assert.equal(heart.source,'Apple Watch');
  let requests=0;
  const stop=await f.runtime.watchCare(f.phone,async()=>true,undefined,undefined,undefined,undefined,undefined,{session,locate:async()=>{requests++;await f.runtime.locate(f.phone,
    {latitude:25.03,longitude:121.56,accuracy_m:10,datum:'wgs84',observed_at:new Date().toISOString()});}});
  t.after(stop);
  const position=await invoke('phone_location') as {status:string;location:{latitude:number}};
  assert.equal(position.status,'observed');assert.equal(position.location.latitude,25.03);assert.equal(requests,1);
  assert.deepEqual(await invoke('glasses_photo'),{status:'unavailable',error_code:'GLASSES_NOT_CONNECTED'});
  await assert.rejects(invoke('arbitrary'),/SENSE_ARGUMENT_INVALID/u);
});


test('effect consent persists exact person and task type and rejects observation authority',async t=>{
  const f=await fixture(t),session='effect-session';
  await f.runtime.submit(f.raw(f.phone,'effect-request','给小李发消息'),f.phone,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  const context={run_id:run!.run_id,session_id:session,tool_call_id:'effect-one'},effect={kind:'send',recipient:'contact:li',task_type:'wechat_message',requested:true};
  await until(()=>f.runtime.effectConsent(context,effect).catch(()=>undefined),value=>!!value);
  assert.equal((await f.runtime.effectConsent(context,effect)).status,'confirmation_required');
  assert.equal((await f.runtime.effectConsent(context,effect,true,false,'',ownerConfirmation(context.run_id))).status,'allowed');
  assert.equal((await f.runtime.effectConsent({...context,tool_call_id:'effect-two'},effect)).status,'allowed');
  const unsolicited={...effect,requested:false};
  assert.equal((await f.runtime.effectConsent(context,unsolicited)).status,'confirmation_required');
  assert.equal((await f.runtime.effectConsent(context,unsolicited,true,false,'',ownerConfirmation(context.run_id))).status,'allowed');
  assert.equal((await f.runtime.effectConsent({...context,tool_call_id:'effect-unsolicited'},unsolicited)).status,'confirmation_required');
  assert.equal((await f.runtime.effectConsent(context,{...effect,recipient:'contact:wang'})).status,'confirmation_required');
  assert.equal((await f.runtime.effectConsent(context,{...effect,task_type:'public_post'})).status,'confirmation_required');
  assert.equal((await f.runtime.effectConsent(context,{kind:'file_edit',task_type:'organize_files',requested:true})).status,'allowed');
  for(const kind of ['login','delete']){
    assert.equal((await f.runtime.effectConsent(context,{kind,task_type:kind,requested:true})).status,'allowed');
    assert.equal((await f.runtime.effectConsent(context,{kind,task_type:kind,requested:false})).status,'confirmation_required');
  }
  await assert.rejects(f.runtime.effectConsent(context,{kind:'send',task_type:'wechat_message',requested:true}),/EFFECT_CLASSIFICATION_REQUIRED/u);
  await f.runtime.submit(f.raw(f.phone,'no-owner-effect',{kind:'health_update'}),f.phone,'effect-observation',false);
  const other=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id==='effect-observation'),value=>!!value);
  const denied=await until(()=>f.runtime.effectConsent({run_id:other!.run_id,session_id:'effect-observation',tool_call_id:'observe-send'},effect,true).catch(error=>error.code),value=>value!=='RUN_BINDING_REQUIRED');
  assert.equal(denied,'OWNER_REQUEST_REQUIRED');
});


test('an approved effect returns the durable id of the owner card that approved it',async t=>{
  const f=await fixture(t),session='effect-card-session',views:PendingVoiceConfirmation[][]=[];
  t.after(await f.runtime.watchCare(f.phone,async()=>true));await f.runtime.ownerInput(f.phone);
  t.after(await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{views.push(rows);},error=>assert.fail(String(error))));
  await f.runtime.submit(f.raw(f.phone,'effect-card-request','把结果发给小李'),f.phone,session,true);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),value=>!!value);
  const context={run_id:run!.run_id,session_id:session,tool_call_id:'send-file'},effect={kind:'send',recipient:'wechat:li',task_type:'send_file',requested:true};
  await until(()=>f.runtime.effectConsent(context,effect).catch(()=>undefined),value=>value?.status==='confirmation_required');
  // The effect gate names its card with this request id; the phone answers that card.
  run!.approval={request_id:'effect-card-1',question:'请确认：发送内容',expires_at_ms:Date.now()+60000};run!.status='waiting_for_approval';
  const [card]=await until(()=>views.at(-1)??[],rows=>rows.length===1);
  const response=await f.runtime.confirmVoice(f.phone,{confirmation_id:card!.confirmation_id,choice:'approve'});
  assert.deepEqual(response,{approval:{...ownerConfirmation(context.run_id,'effect-card-1'),choice:'approve'}});
  assert.deepEqual(f.decisions.at(-1),{request_id:'effect-card-1',choice:'once',
    confirmation:{confirmation_id:card!.confirmation_id,confirmed_by:'owner',surface:{device_id:'phone',device_type:'phone'}}});
  await assert.rejects(f.runtime.effectConsent(context,effect,true,false,'effect-card-1'),/EFFECT_CONFIRMATION_RECEIPT_REQUIRED/);
  const confirmation=run!.approval_results![0]!.confirmation!;
  const approved=await f.runtime.effectConsent(context,effect,true,false,'effect-card-1',confirmation);
  assert.deepEqual(approved,{status:'allowed',approval:{...confirmation,choice:'once',decision_status:'resolved',decision:'approved',
    decision_source:'effect_consent_record',confirmation_evidence:{actor_type:'authenticated_owner_principal',
      physical_actor:'unknown',card_rendering:'unknown'},decided_by:'owner',
    decided_at:approved.approval!.decided_at,remembered:true,reused:false}});
  assert.ok(Date.parse(approved.approval!.decided_at as string)>0);
  const decision=await until(()=>f.storage.read('voice-confirmation-decisions',card!.confirmation_id).catch(()=>undefined),Boolean);
  assert.equal(JSON.parse(Buffer.from(decision!).toString()).choice,'once');
  const reused=await f.runtime.effectConsent({...context,tool_call_id:'send-again'},{...effect,summary:'第二次'});
  assert.deepEqual(reused,{status:'allowed',approval:{...approved.approval,reused:true}});
  const [consentKey]=await f.storage.list('effect-consents');
  const legacy=JSON.parse(Buffer.from(await f.storage.read('effect-consents',consentKey!)).toString());
  delete legacy.confirmed_by;delete legacy.surface;
  await f.storage.replace('effect-consents',consentKey!,Buffer.from(JSON.stringify(legacy)));
  const historical=await f.runtime.effectConsent(context,effect);
  assert.deepEqual(historical.approval,{...approved.approval,confirmed_by:'owner',surface:null,reused:true});
  assert.deepEqual(await f.runtime.effectConsent(context,{kind:'read',task_type:'lookup',requested:true}),{status:'allowed'});
  assert.deepEqual(f.errors,[]);
});

test('effect summary is display only across fresh sessions and never persisted in consent',async t=>{
  const f=await fixture(t),effect={kind:'send',recipient:'email:li@example.com',task_type:'send_message:email:send',requested:true,summary:'这是确认界面的短预览'};
  const context=async(session:string)=>{
    await f.runtime.submit(f.raw(f.phone,session,'给小李发邮件'),f.phone,session,true);
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);
    await until(()=>f.admission.find(run!.run_id,session),Boolean);
    return {run_id:run!.run_id,session_id:session,tool_call_id:'send-email'};
  };
  const first=await context('summary-first');
  const decision=await f.runtime.effectConsent(first,effect);
  assert.equal(decision.status,'confirmation_required');
  assert.equal('summary' in (decision.scope??{}),false);
  assert.equal((await f.runtime.effectConsent(first,effect,true,false,'',ownerConfirmation(first.run_id))).status,'allowed');
  const fresh=await context('summary-fresh');
  assert.equal((await f.runtime.effectConsent(fresh,{...effect,summary:'换了内容，同人同类不再问'})).status,'allowed');
  const keys=await f.storage.list('effect-consents');assert.equal(keys.length,1);
  const stored=JSON.parse(Buffer.from(await f.storage.read('effect-consents',keys[0]!)).toString());
  assert.equal('summary' in stored,false);assert.equal(JSON.stringify(stored).includes(effect.summary),false);
  assert.equal((await f.runtime.effectConsent(fresh,{...effect,recipient:'email:wang@example.com'})).status,'confirmation_required');
  for(const summary of ['字'.repeat(241),42,null])await assert.rejects(f.runtime.effectConsent(fresh,{...effect,summary}),/EFFECT_CLASSIFICATION_REQUIRED/u);
});

test('effect gate preserves only the existing affirmative ride-card authority',async t=>{
  const f=await fixture(t),ingress=new UnifiedIngress(f.archive),effect={kind:'external',task_type:'ride_request',requested:true};
  for(const answer of ['yes','no']){
    const session=`ride-effect-${answer}`,d=await ingress.accept(f.raw(f.glasses,`ride-card-${answer}`,{kind:'glasses_gesture',intent:'ride',answer}),{...f.glasses,submission:'owner_gesture'});
    await f.admission.admit(d,session,'controlled');
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);
    const context={run_id:run!.run_id,session_id:session,tool_call_id:'ride-effect'};
    await until(()=>f.admission.find(run!.run_id,session),Boolean);
    assert.equal(f.runtime.paymentSource(run!.run_id).ride_allowed,answer==='yes');
    if(answer==='yes')assert.equal((await f.runtime.effectConsent(context,effect,false,true)).status,'allowed');
    else await assert.rejects(f.runtime.effectConsent(context,effect,false,true),/OWNER_REQUEST_REQUIRED/u);
    await assert.rejects(f.runtime.effectConsent(context,effect,false,false),/OWNER_REQUEST_REQUIRED/u);
    for(const kind of ['send','login','delete'])await assert.rejects(f.runtime.effectConsent(context,{...effect,kind,recipient:'contact:li'},false,true),/OWNER_REQUEST_REQUIRED/u);
  }
});


test('call backend replies select text at OUT while ordinary voice replies retain their mode',async t=>{
  const voice={calls:0},f=await fixture(t,[],voice);
  for(const call of [true,false]){
    const session=call?'call-text-output':'ordinary-voice-output';
    const accepted=call?await f.runtime.submitCallTurn(f.raw(f.phone,session,{kind:'voice_turn',call_id:'closed-call',turn:0,
      speaker:'owner',user:'整理发票',assistant:'我来处理',route:'handoff'}),f.phone,session):
      await f.runtime.submit(f.raw(f.phone,session,'整理发票'),f.phone,session,true);
    const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);
    await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'voice-open'},
      args:{reply_mode:'voice'}}),value=>(value as {status?:string}).status==='opened');
    const journal=await Promise.all((await f.storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('output-journal',key)).toString())));
    assert.ok(journal.some(entry=>entry.open?.reply_mode===(call?'text':'voice')));
    if(call){
      run!.output='发票整理完成';run!.status='completed';
      await until(()=>f.runtime.event(f.phone,session,accepted.processed_event.processed_event_id),value=>value.admission.state==='completed');
      const result=await f.runtime.result(f.phone,session,accepted.processed_event.processed_event_id);
      assert.equal(result.result.reply_mode,'text');assert.equal(result.result.voice_status,'none');
    }
  }
  assert.equal(voice.calls,0);assert.deepEqual(f.errors,[]);
});


test('a stale missing-delivery read cannot send a second push after the automatic sender releases its flight',async t=>{
  const notices:{title:string;body:string}[]=[],f=await fixture(t,notices),session='stale-notification-read';
  t.after(await f.runtime.watchCare(f.phone,async()=>false));
  const {processed_event:d}=await f.runtime.submitCallTurn(f.raw(f.phone,'stale-result',{kind:'voice_turn',call_id:'ended',turn:0,
    speaker:'owner',user:'整理发票',assistant:'我来做'}),f.phone,session);
  const run=await until(()=>[...f.runs.values()][0],Boolean);assert.ok(run);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),
    value=>(value as {status?:string}).status==='opened');
  const release=Promise.withResolvers<void>(),read=f.output.callResultDelivered.bind(f.output);let hold=true,entered=false,reads=0;
  t.mock.method(f.output,'callResultDelivered',async(...args:Parameters<typeof read>)=>{
    const delivered=await read(...args);reads++;
    if(hold&&!delivered){hold=false;entered=true;await release.promise;}return delivered;
  });
  run.output='发票整理完成';run.status='completed';
  try{
    await until(()=>entered,Boolean);await f.runtime.persistCallResult(f.phone,session,d.processed_event_id);
    assert.equal(notices.length,1);release.resolve();await until(()=>reads,n=>n>=4);
    assert.deepEqual(notices,[{title:'依米',body:'发票整理完成'}]);assert.deepEqual(f.errors,[]);
  }finally{release.resolve();}
});

for(const state of ['offline','original-call','different-call','authoritative-text'] as const)
test(`accepted call result delivery follows original D and OUT after native completion: ${state}`,async t=>{
  const notices:{title:string;body:string}[]=[],voice={calls:0},f=await fixture(t,state==='original-call'?undefined:notices,voice),session=`accepted-${state}`;
  const attempts:unknown[]=[],spoken:string[]=[];let shown=0;
  if(state!=='offline')t.after(await f.runtime.watchCare(f.phone,async()=>{shown++;return true;},async(text,origin)=>{
    attempts.push(origin);if(state==='authoritative-text')return 'text';if(state!=='original-call')return false;spoken.push(text);return true;
  }));
  const {processed_event:d}=await f.runtime.submitCallTurn(f.raw(f.phone,'accepted-call',{kind:'voice_turn',call_id:'original',turn:3,
    speaker:'owner',user:'整理发票',assistant:'我来处理'}),f.phone,session);
  const run=await until(()=>[...f.runs.values()][0],Boolean);assert.ok(run);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'voice'}}),
    value=>(value as {status?:string}).status==='opened');
  run.output='发票整理完成';run.status='completed';
  await until(async()=>{const rows=await Promise.all((await f.storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('output-journal',key)).toString())));return rows.filter(row=>row.callDelivery).length;},n=>n===1);
  await f.runtime.persistCallResult(f.phone,session,d.processed_event_id);await f.runtime.persistCallResult(f.phone,session,d.processed_event_id);
  assert.equal(voice.calls,0);assert.deepEqual(f.errors,[]);
  if(state==='authoritative-text')assert.equal(shown,0,'authoritative text delivery ends the original delivery without another publication');
  assert.deepEqual(spoken,state==='original-call'?['发票整理完成']:[]);
  assert.deepEqual(notices,state==='offline'?[{title:'依米',body:'发票整理完成'}]:[]);
  const replies=f.runtime.timeline!.page('owner').items.filter(item=>item.text==='发票整理完成');
  assert.equal(replies.length,state==='original-call'?0:1,'live speech remains native-conversation-owned; closed text uses reach once');
  if(state!=='offline')assert.deepEqual(attempts,[{device_id:'phone',call_id:'original',identity:'owner',turn:3,message_id:d.processed_event_id}]);
  const rows=await Promise.all((await f.storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('output-journal',key)).toString())));
  assert.equal(rows.find(row=>row.callDelivery).callDelivery.via,state==='original-call'?'voice':state==='offline'?'text_notification':'text');
});


for(const scope of ['owner','guest','owner_uncertain','payment-private'] as const)
test(`staging call-result attempts stay isolated from device delivery: ${scope}`,async t=>{
  let attempts=0,shown=0,spoken=0,notified=0;
  const f=await fixture(t,async()=>{notified++;},undefined,async message=>{
    await appendFile(join(f.root,'staging-attempts.jsonl'),JSON.stringify(message)+'\n');attempts++;
  }),session=`staging-${scope}`;
  t.after(await f.runtime.watchCare(f.phone,async()=>{shown++;return true;},async()=>{spoken++;return true;}));
  const accepted=scope==='payment-private'?
    await f.runtime.submit(f.raw(f.phone,'private-reconciliation',{kind:'errand_result',job_id:'job-reconcile',task:'只读核对订单',
      voice_session_id:'original-call',payment_reconciliation:{of_job:'job-original'},answer:'付款核对结果'}),f.phone,session,false):
    await f.runtime.submitCallTurn(f.raw(f.phone,'staging-turn',{kind:'voice_turn',call_id:'original-call',turn:0,
      speaker:scope==='guest'?'speaker:1':scope,user:'帮我核对',assistant:'我来处理'}),f.phone,session);
  const run=await until(()=>[...f.runs.values()].find(value=>value.conversation_session_id===session),Boolean);assert.ok(run);
  await until(()=>f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:'open'},args:{reply_mode:'text'}}),
    value=>(value as {status?:string}).status==='opened');
  run.output=`核对完成-${scope}`;run.status='completed';
  await until(()=>f.admission.find(run.run_id,session),entry=>entry===undefined);
  assert.deepEqual({shown,spoken,notified},{shown:0,spoken:0,notified:0});assert.deepEqual(f.errors,[]);
  const rows=await Promise.all((await f.storage.list('output-journal')).map(async key=>JSON.parse(Buffer.from(await f.storage.read('output-journal',key)).toString())));
  assert.equal(rows.filter(row=>row.callDelivery).length,0,'staged attempts are not actual voice or notification receipts');
  const replies=f.runtime.timeline!.page('owner').items.filter(item=>item.text===run.output);
  if(scope==='owner'){
    assert.equal(attempts,1);assert.equal(replies.length,1);assert.equal(replies[0]!.via,'proactive');
    const staged=(await readFile(join(f.root,'staging-attempts.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(staged,[{principal_id:'owner',device_id:'phone',id:accepted.processed_event.processed_event_id,text:run.output,suggestion:false}]);
  }else{
    assert.equal(attempts,0);assert.equal(replies.length,0);
    if(scope==='payment-private')assert.equal((await f.runtime.result(f.phone,session,accepted.processed_event.processed_event_id)).result.private,'payment');
  }
});


test('turn work combines live front and admitted call work without reopening a closed call',async t=>{
  const f=await fixture(t),changes:unknown[]=[];
  const stop=await f.runtime.watchTurnWork(f.phone,()=>changes.push(f.runtime.turnWork('owner')));t.after(stop);
  f.runtime.callReplyState(f.phone,'call-one',0,true);
  assert.deepEqual(f.runtime.turnWork('owner').foreground_replies,[{call_id:'call-one',turn:0}]);
  f.runtime.callReplyState(f.phone,'call-one',1,true);
  f.runtime.callReplyState(f.phone,'call-one',0,false);
  assert.deepEqual(f.runtime.turnWork('owner').foreground_replies,[{call_id:'call-one',turn:1}],'a late old response cannot clear the current reply');
  f.runtime.callReplyState(f.phone,'call-one',1,false);
  const accepted=await f.runtime.submitCallTurn(f.raw(f.phone,'call-work',{kind:'voice_turn',call_id:'call-one',turn:2,
    user:'整理资料',assistant:'',speaker:'owner',route:'handoff',handoff:{difficulty:'complex',intent:'整理资料',thinking:'enabled'}}),f.phone,'call-session');
  const run=await until(()=>[...f.runs.values()][0],value=>!!value);
  f.runtime.callReplyState(f.phone,'call-one',1,false,true);
  assert.deepEqual(f.runtime.turnWork('owner'),{foreground_replies:[],background_work_count:1},'retained admission with no live call source is background, including after restart');
  f.runtime.callReplyState(f.phone,'call-one',2,false,false);
  assert.deepEqual(f.runtime.turnWork('owner').foreground_replies,[{call_id:'call-one',turn:2}]);
  f.runtime.callReplyState(f.phone,'call-one',2,false,true);
  assert.deepEqual(f.runtime.turnWork('owner'),{foreground_replies:[],background_work_count:1});
  f.runtime.callReplyState(f.phone,'call-two',0,true);
  assert.deepEqual(f.runtime.turnWork('owner'),{foreground_replies:[{call_id:'call-two',turn:0}],background_work_count:1});
  run!.turn_exit_reason='delegation_waiting';
  await until(()=>f.runtime.event(f.phone,'call-session',accepted.processed_event.processed_event_id),value=>value.admission.conversation_released===true);
  assert.equal(f.runtime.turnWork('owner').background_work_count,1,'detachment does not double count the closed call');
  await f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:'call-session',tool_call_id:'done'},args:{reply_mode:'none'}});
  run!.status='completed';run!.turn_exit_reason='completed';run!.output='';
  await until(()=>f.runtime.turnWork('owner').background_work_count,value=>value===0);
  assert.deepEqual(f.runtime.turnWork('owner').foreground_replies,[{call_id:'call-two',turn:0}]);
  assert.deepEqual(f.runtime.turnWork('other'),{foreground_replies:[],background_work_count:0});
  assert.ok(changes.length>4);
});


test('call retry rejoins live work and retries a failed turn exactly once per control id with original speech evidence',async t=>{
  const f=await fixture(t),session='retry-call-session',end=Date.now(),start=end-100;
  const audio=await f.archive.archive({...f.raw(f.phone,'retry-audio',''),media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:start,end_ms:end},payload:Buffer.alloc(3200)}, {...f.phone,submission:'observation'});
  const evidence={raw_ref:audio.raw_ref,archive_revision:audio.archive_revision,start_ms:start,end_ms:end};
  const accepted=await f.runtime.submitCallTurn(f.raw(f.phone,'retry-turn',{kind:'voice_turn',call_id:'retry-call',turn:2,
    speaker:'owner',user:'整理资料',assistant:'',route:'handoff',audio:evidence}),f.phone,session),d=accepted.processed_event;
  await until(()=>f.inputs.get(session),Boolean);
  const original=await until(()=>[...f.runs.values()].find(run=>run.conversation_session_id===session),Boolean);
  await until(()=>f.runtime.event(f.phone,session,d.processed_event_id),value=>!!value.admission.run_id);
  const joined=await f.runtime.retryCallTurn(f.phone,session,d.processed_event_id,'still-running','retry-call');
  assert.equal(joined.processed_event.processed_event_id,d.processed_event_id);
  assert.equal(joined.admission?.run_id,original!.run_id);assert.equal(f.runs.size,1);
  await assert.rejects(f.runtime.retryCallTurn(f.phone,session,d.processed_event_id,'wrong-call','foreign-call'),/CALL_RETRY_SCOPE_DENIED/);
  await assert.rejects(f.runtime.retryCallTurn(f.foreign,session,d.processed_event_id,'foreign-principal','retry-call'),/SESSION_SCOPE_DENIED/);
  original!.status='failed';
  await until(()=>f.runtime.event(f.phone,session,d.processed_event_id),value=>value.admission.state==='failed');
  const retry=await f.runtime.retryCallTurn(f.phone,session,d.processed_event_id,'retry-once','retry-call');
  const replay=await f.runtime.retryCallTurn(f.phone,session,d.processed_event_id,'retry-once','retry-call');
  assert.notEqual(retry.processed_event.processed_event_id,d.processed_event_id);
  assert.equal(replay.processed_event.processed_event_id,retry.processed_event.processed_event_id);
  assert.equal(retry.processed_event.captured_at,d.captured_at);
  assert.deepEqual((retry.processed_event.content.app_event as {audio:unknown}).audio,evidence);
  assert.equal((retry.processed_event.content.app_event as {speaker:string}).speaker,'owner');
  assert.equal((retry.processed_event.content.app_event as {retry_of_processed_event_id:string}).retry_of_processed_event_id,d.processed_event_id);
  await until(()=>f.runs.size,count=>count===2);
  const completed=[...f.runs.values()].find(run=>run.run_id!==original!.run_id)!;completed.status='completed';completed.output='整理完成';
  await until(()=>f.runtime.event(f.phone,session,retry.processed_event.processed_event_id),value=>value.admission.state==='completed');
  await assert.rejects(f.runtime.retryCallTurn(f.phone,session,retry.processed_event.processed_event_id,'already-done','retry-call'),/CALL_RETRY_NOT_FAILED/);
});

test('early call handoff admits before audio and completes without duplicate run or owner row',async t=>{
  const f=await fixture(t),session='early-handoff',turn={kind:'voice_turn',call_id:'early-call',turn:0,speaker:'owner',
    user:'帮我整理明天的安排',assistant:'',route:'handoff',handoff:{difficulty:'complex',intent:'整理安排',thinking:'enabled'}};
  const early=await f.runtime.submitCallTurn(f.raw(f.phone,'early-turn:handoff',{...turn,phase:'handoff'}),f.phone,session);
  await until(()=>f.runtime.event(f.phone,session,early.processed_event.processed_event_id),value=>!!value.admission.run_id);
  const end=Date.now(),start=end-200;
  const audio=await f.archive.archive({schema_version:EVENT_SCHEMA,event_id:'early-audio',device_id:f.phone.device_id,device_type:f.phone.device_type,
    captured_at:new Date(start).toISOString(),source:{channel:f.phone.channel},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',
    time_range:{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:start,end_ms:end},payload:Buffer.alloc(6400)},{...f.phone,submission:'observation'});
  const final=await f.runtime.submitCallTurn(f.raw(f.phone,'early-turn',{...turn,phase:'complete',handoff_event_id:'early-turn:handoff',assistant:'我来整理',
    audio:{raw_ref:audio.raw_ref,archive_revision:audio.archive_revision,start_ms:start,end_ms:end}}),f.phone,session);
  assert.equal(final.admission,null);assert.equal(f.runs.size,1);assert.equal(f.mirrors.size,0);
  assert.equal((final.processed_event.content.audio_observations as {evidence_status:string}[])[0]!.evidence_status,'archived_audio');
  assert.match(Buffer.from(await f.archive.read(final.processed_event.raw_ref,'owner',final.processed_event.archive_revision)).toString(),/我来整理/);
  await until(()=>f.runtime.timeline!.page('owner').items.length,n=>n===2);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),[turn.user,'我来整理']);
  await assert.rejects(f.runtime.submitCallTurn(f.raw(f.phone,'wrong-completion',{...turn,turn:1,phase:'complete',handoff_event_id:'early-turn:handoff'}),f.phone,session),/CALL_HANDOFF_CONFLICT/);
});

test('new call handoff preserves session serialization and old reply sees the completed goal',async t=>{
  const f=await fixture(t),session='current-call',turn={kind:'voice_turn',call_id:'ongoing-call',speaker:'owner',assistant:'',route:'handoff',
    phase:'handoff',handoff:{difficulty:'complex',intent:'安排会议',thinking:'disabled'}};
  const first=await f.runtime.submitCallTurn(f.raw(f.phone,'first:handoff',{...turn,turn:0,user:'安排一个会议'}),f.phone,session);
  const firstRun=await until(()=>f.runtime.event(f.phone,session,first.processed_event.processed_event_id),value=>!!value.admission.run_id);
  const old=f.runs.get(firstRun.admission.run_id!)!,latest='目标已经补全：明天下午三点和小王开会';
  const next=await f.runtime.submitCallTurn(f.raw(f.phone,'next:handoff',{...turn,turn:1,user:latest}),f.phone,session);
  assert.equal(next.admission!.state,'pending');
  assert.equal(old.status,'running');assert.equal(f.runs.size,1);
  await until(()=>f.runtime.timeline!.conversation('owner',session),value=>value.some(line=>line.text===latest));
  const opened=await f.runtime.tool('paios_open_reply',{context:{run_id:old.run_id,session_id:session,tool_call_id:'current-open'},args:{reply_mode:'text'}}) as {status:string;current_call_context:{text:string}[]};
  assert.equal(opened.status,'opened');assert.ok(opened.current_call_context.some(line=>line.text===latest));
  old.status='completed';
  await until(()=>f.runtime.event(f.phone,session,next.processed_event.processed_event_id),value=>!!value.admission.run_id);
  assert.equal(f.runs.size,2);
});

test('call handoff does not wait for timeline input or native history publication',async t=>{
  const f=await fixture(t),session='blocked-call';
  const input=f.runtime.timeline!.input.bind(f.runtime.timeline),messages=f.native.messages.bind(f.native);
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
  f.runtime.timeline!.input=async(...args)=>{await blocked;return input(...args);};
  f.native.messages=async(...args)=>{await blocked;return messages(...args);};
  try {
    const accepted=await f.runtime.submitCallTurn(f.raw(f.phone,'unblocked:handoff',{kind:'voice_turn',call_id:'unblocked',turn:0,speaker:'owner',user:'查一下日程',
      assistant:'',route:'handoff',phase:'handoff',handoff:{difficulty:'complex',intent:'日程',thinking:'disabled'}}),f.phone,session);
    await until(()=>f.runtime.event(f.phone,session,accepted.processed_event.processed_event_id),value=>!!value.admission.run_id);
    assert.equal(f.runs.size,1);assert.equal(f.runtime.timeline!.page('owner').items.length,0);
  } finally {release();}
});

for(const early of [false,true])test(`call transcript with an audio archive gap stays durable, visible and admitted once: early=${early}`,async t=>{
  const f=await fixture(t),session='audio-gap',turn={kind:'voice_turn',call_id:'gap-call',turn:1,speaker:'owner',
    user:'每个月存两千元，一年能存多少',assistant:'我来算一下',route:'handoff'},audio_gap={reason:'CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE'};
  const summary='算一下一年的存款';
  const handoff=early?await f.runtime.submitCallTurn(f.raw(f.phone,'gap:handoff',{...turn,user:summary,assistant:'',phase:'handoff'}),f.phone,session):undefined;
  if(early)await until(()=>f.runtime.timeline!.page('owner').items.length,n=>n===1);
  const before=f.runtime.timeline!.page('owner'),earlyRow=before.items[0];
  const final=await f.runtime.submitCallTurn(f.raw(f.phone,'gap-final',{...turn,audio_gap,
    ...(early?{phase:'complete',handoff_event_id:'gap:handoff'}:{})}),f.phone,session);
  await until(()=>f.runs.size,n=>n===1);
  const observation=(final.processed_event.content.audio_observations as any[])[0];
  assert.equal(observation.text,turn.user);assert.equal(observation.evidence_status,'transcript_only');assert.deepEqual(observation.audio_gap,audio_gap);
  const original=JSON.parse(Buffer.from(await f.archive.read(final.processed_event.raw_ref,'owner',final.processed_event.archive_revision)).toString());
  assert.deepEqual(original.audio_gap,audio_gap);assert.equal(original.user,turn.user);
  await until(()=>f.runtime.timeline!.page('owner').items.length,n=>n===2);
  assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),[turn.user,turn.assistant]);
  if(early){
    const updates=f.runtime.timeline!.page('owner',{after_seq:before.head_seq});
    assert.ok(updates.removals?.some(removal=>removal.removed_seqs.includes(earlyRow!.seq)));
    assert.ok(updates.items.some(item=>item.kind==='owner'&&item.text===turn.user));
    const canonical=f.runtime.timeline!.page('owner');
    await f.runtime.timeline!.input(final.processed_event,session);
    await f.runtime.timeline!.input(handoff!.processed_event,session);
    assert.deepEqual(f.runtime.timeline!.page('owner'),canonical,'replay keeps the canonical owner row and never restores the intent');
    const run=[...f.runs.values()][0]!;
    const opened=await f.runtime.tool('paios_open_reply',{context:{run_id:run.run_id,session_id:session,tool_call_id:'canonical-open'},args:{reply_mode:'text'}}) as {current_call_context:{text:string}[]};
    assert.ok(opened.current_call_context.some(line=>line.text===turn.user));
    assert.ok(!opened.current_call_context.some(line=>line.text===summary));
  }
  assert.equal(f.runs.size,1);assert.equal(final.admission===null,early);assert.deepEqual(f.errors,[]);
});


test('canonical call owner text survives completion before its delayed early timeline projection',async t=>{
  const f=await fixture(t),session='late-asr-projection',summary='查一下明天的安排',canonical='明天下午三点和小王开会';
  const turn={kind:'voice_turn',call_id:'late-asr',turn:0,speaker:'owner',assistant:'',route:'handoff',
    handoff:{difficulty:'complex',intent:summary,thinking:'disabled'}};
  const input=f.runtime.timeline!.input.bind(f.runtime.timeline),gate=Promise.withResolvers<void>();
  f.runtime.timeline!.input=async(...args)=>{
    if((args[0].content.app_event as {phase?:string})?.phase==='handoff')await gate.promise;
    return input(...args);
  };
  try {
    const early=await f.runtime.submitCallTurn(f.raw(f.phone,'late-asr:handoff',{...turn,user:summary,phase:'handoff'}),f.phone,session);
    const final=await f.runtime.submitCallTurn(f.raw(f.phone,'late-asr-final',{...turn,user:canonical,phase:'complete',handoff_event_id:'late-asr:handoff',
      audio_gap:{reason:'CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE'}}),f.phone,session);
    assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),[canonical]);
    gate.resolve();await f.runtime.timeline!.input(early.processed_event,session);
    await f.runtime.timeline!.input(final.processed_event,session);
    assert.deepEqual(f.runtime.timeline!.page('owner').items.map(item=>item.text),[canonical]);
    assert.deepEqual(f.runtime.timeline!.conversation('owner',session).map(line=>line.text),[canonical]);
  } finally {gate.resolve();}
});


test('late canonical text for an older call turn preserves the newer owner goal as latest context',async t=>{
  const f=await fixture(t),session='late-asr-order',now=Date.now(),oldTime=new Date(now-2000).toISOString(),newTime=new Date(now-1000).toISOString();
  const turn={kind:'voice_turn',call_id:'ordered-asr',speaker:'owner',assistant:'',route:'handoff',
    handoff:{difficulty:'complex',intent:'核对安排',thinking:'disabled'}};
  await f.runtime.submitCallTurn({...f.raw(f.phone,'ordered-old:handoff',{...turn,turn:0,user:'旧目标摘要',phase:'handoff'}),captured_at:oldTime},f.phone,session);
  await until(()=>f.runtime.timeline!.page('owner').items.length,n=>n===1);
  await f.runtime.submitCallTurn({...f.raw(f.phone,'ordered-new:handoff',{...turn,turn:1,user:'最新目标：明天下午四点开会',phase:'handoff'}),captured_at:newTime},f.phone,session);
  await until(()=>f.runtime.timeline!.page('owner').items.length,n=>n===2);
  await f.runtime.submitCallTurn(f.raw(f.phone,'ordered-old-final',{...turn,turn:0,user:'旧目标的完整原话',phase:'complete',handoff_event_id:'ordered-old:handoff',
    audio_gap:{reason:'CALL_TURN_ARCHIVE_REFERENCE_UNAVAILABLE'}}),f.phone,session);
  const context=f.runtime.timeline!.conversation('owner',session);
  assert.deepEqual(context.map(line=>line.text),['旧目标的完整原话','最新目标：明天下午四点开会']);
  assert.equal(context[0]!.at,Date.parse(oldTime));assert.equal(context[1]!.at,Date.parse(newTime));
  const run=await until(()=>[...f.runs.values()][0],Boolean);
  const opened=await f.runtime.tool('paios_open_reply',{context:{run_id:run!.run_id,session_id:session,tool_call_id:'ordered-open'},args:{reply_mode:'text'}}) as {current_call_context:{text:string}[]};
  assert.equal(opened.current_call_context.at(-1)!.text,'最新目标：明天下午四点开会');
});

test('host repair failure replays once into its real owner session with release_status evidence',async t=>{
  const f=await fixture(t),session='self-repair-owner';
  const origin=await f.runtime.submit(f.raw(f.phone,'repair-original','修好执行器卡住的问题'),f.phone,session,true);
  const ownerRun=await until(()=>[...f.runs.values()][0],Boolean);ownerRun!.status='completed';ownerRun!.output='';
  const request_id='012345abcdef',failure={failure_source:'workshop' as const,job_id:request_id,title:'执行器卡住',
    task:'修好执行器卡住的问题',answer:'suites: regression failed',terminal_reason:'failed' as const,
    evidence_ref:{tool:'skills_hub' as const,action:'release_status' as const,request_id}};
  const value={principal_id:'owner',device_id:'phone',id:`task-failure:${request_id}`,text:'修复测试失败。',captured_at:new Date().toISOString(),
    system_event:{type:'task_failure' as const,request_id,origin_processed_event_id:origin.processed_event.processed_event_id,failure}};
  await f.runtime.scheduledDelivery(value as never);await f.runtime.scheduledDelivery(value as never);
  await until(()=>f.bodies.length,count=>count===2);
  const body=f.bodies[1]!,d=JSON.parse(body.input),app=d.content.app_event;
  assert.equal(body.session_id,session);assert.equal(app.kind,'task_failure');
  assert.equal(app.origin_processed_event_id,origin.processed_event.processed_event_id);
  assert.equal(principalAttribution(d),null,'a host failure never becomes owner speech');
  assert.deepEqual(app.evidence_ref,failure.evidence_ref);assert.equal(app.answer,failure.answer);
  assert.equal(f.runs.size,2,'notice retries admit exactly one main-session failure turn');
  await assert.rejects(f.runtime.scheduledDelivery({...value,system_event:{...value.system_event,failure:{...failure,answer:'different'}}} as never),/SYSTEM_EVENT_CONFLICT/);
  [...f.runs.values()][1]!.status='completed';
});

for(const speaker of ['speaker:guest','owner_uncertain'])test(`host repair notices cannot borrow ${speaker} authority`,async t=>{
  const f=await fixture(t),session=`repair-${speaker}`;
  const origin=await f.runtime.submitCallTurn(f.raw(f.phone,'unverified-repair',{kind:'voice_turn',call_id:'call',turn:0,speaker,user:'修好它'}),f.phone,session);
  const request_id='abcdef012345',failure={failure_source:'workshop',job_id:request_id,title:'修复',task:'修好它',answer:'build failed',terminal_reason:'failed',
    evidence_ref:{tool:'skills_hub',action:'release_status',request_id}};
  await assert.rejects(f.runtime.scheduledDelivery({principal_id:'owner',device_id:'phone',id:`task-failure:${request_id}`,text:'构建失败。',captured_at:new Date().toISOString(),
    system_event:{type:'task_failure',request_id,origin_processed_event_id:origin.processed_event.processed_event_id,failure}} as never),/RELEASE_OWNER_REQUIRED/);
});

for(const choice of ['approve','deny'] as const)test(`protected candidate reaches the existing owner confirmation surface: ${choice}`,async t=>{
  const f=await fixture(t),session=`release-consent-${choice}`,views:PendingVoiceConfirmation[][]=[];
  t.after(await f.runtime.watchCare(f.phone,async()=>true));
  t.after(await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{views.push(rows);},error=>{throw error;}));
  const origin=await f.runtime.submit(f.raw(f.phone,'baseline-repair','修好付款门禁的误判'),f.phone,session,true);
  const ownerRun=await until(()=>[...f.runs.values()][0],Boolean);ownerRun!.status='completed';ownerRun!.output='';
  const request_id='fedcba987654',value={principal_id:'owner',device_id:'phone',id:`release-approval-required:${request_id}`,
    text:'这个候选涉及付款门禁，需要确认。',captured_at:new Date().toISOString(),
    system_event:{type:'release_approval_required' as const,request_id,origin_processed_event_id:origin.processed_event.processed_event_id,
      base:'a'.repeat(40),commit:'b'.repeat(40),paths:['integrations/connectors/phone_executor/payment_guard.py']}};
  await f.runtime.scheduledDelivery(value);await f.runtime.scheduledDelivery(value);
  const run=await until(()=>[...f.runs.values()][1],Boolean),body=f.bodies[1]!;
  assert.equal(body.session_id,session);assert.equal(JSON.parse(body.input).content.app_event.kind,'release_approval_required');
  assert.equal(principalAttribution(JSON.parse(body.input)),null);assert.equal(f.runs.size,2);
  run!.approval={request_id:'release-bound-decision',question:'是否允许这次付款门禁修复？',expires_at_ms:Date.now()+60000};
  run!.status='waiting_for_approval';
  const pending=await until(()=>views.at(-1)??[],rows=>rows.length===1);
  await f.runtime.confirmVoice(f.phone,{confirmation_id:pending[0]!.confirmation_id,choice});
  assert.deepEqual(f.decisions.map(({confirmation,...decision}:any)=>decision),[{request_id:'release-bound-decision',choice:choice==='approve'?'once':'deny'}]);
  run!.status='completed';
});
