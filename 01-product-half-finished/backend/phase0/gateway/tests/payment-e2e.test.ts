import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {readFileSync} from 'node:fs';
import {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import {StreamArchive} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {controlledEngine} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import {passing} from '../../../services/personal-aios-integration/tests/payment-fixture.ts';
import {MAC_CAPABILITIES,StaticFixtureDeviceAuthority} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {SpeechEngine} from '../../../services/personal-aios-integration/src/voiceprint/contracts.ts';
import type {SpeechVad} from '../../../services/personal-aios-integration/src/media/silero-stream.ts';
import type {PaymentVoiceVerifier,PaymentPorts,VoiceVerdict,SettingsChange} from '../../../services/personal-aios-integration/src/payment/contracts.ts';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient,type NativeRun} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {keyPair,signed,phone,glasses} from '../../../services/personal-aios-integration/tests/payment-fixture.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {OutputAuthority} from '../../../services/personal-aios-integration/src/output.ts';
import {sha256,utc,type RawEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import {PaymentAuthority} from '../../../services/personal-aios-integration/src/payment/authority.ts';
import {parsePaymentConfig} from '../../../services/personal-aios-integration/src/payment/config.ts';
import {handlePaymentExecutor} from '../../../services/personal-aios-integration/src/payment/executor-api.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {dispatchPayment,paymentWire} from '../src/personal-aios-payment-wire.ts';

/** Server orchestration harness: synthetic PCM, native runs and verifier verdicts;
 * HTTP executor observations/results are posted manually, not produced by a driver.
 * This does not establish executor, real 4a scoring or physical-device acceptance.
 * A14.2 real-model fixture audio and staging fake-cashier acceptance remain separate gates. */
export interface HarnessOptions {config?:Record<string,unknown>;verifier?:PaymentVoiceVerifier;speech?:SpeechEngine&SpeechVad;capture?:(source:RegisteredDevice,text?:string)=>Buffer|Promise<Buffer>}
export async function fixture(t:test.TestContext,options:HarnessOptions={}){
  const directory=await mkdtemp(join(tmpdir(),'payment-wire-e2e-')),storage=new PosixStorage(directory);let serial=0,now=Date.parse('2026-10-14T04:00:00.000Z');
  t.mock.method(Date,'now',()=>now);
  const runs=new Map<string,NativeRun>(),budget={max_chunk_bytes:100000,max_total_bytes:1000000,max_chunks:100,max_revisions:100,max_seq:100};
  const native:NativeClient={create:async body=>{const run={run_id:`run-${++serial}`,session_id:`native-${serial}`,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},
    status:async run_id=>runs.get(run_id)!,cancel:async()=>{throw Error('unused');}};
  const mac:RegisteredDevice={...phone,device_id:'mac',device_type:'mac',capabilities:MAC_CAPABILITIES};
  const pairedDevices=[phone,glasses,mac],sourceAuthority=new StaticFixtureDeviceAuthority(pairedDevices.map(device=>({...device,token_sha256:sha256(`${device.device_id}-token`)})));
  const marker=controlledEngine(),speech=options.speech??{...marker,speaker_model:{...marker.speaker_model,dim:16},embed:async()=>Float32Array.from({length:16},(_,n)=>Number(n===0))},registry=new VoiceprintRegistry(storage,speech.speaker_model),streams=new StreamArchive(storage,budget);
  let verdict:VoiceVerdict=passing;
  const verifier=options.verifier??{verifyInitiating:async()=>passing,verifyPay:async()=>verdict};
  const config=parsePaymentConfig({enabled:true,executor_key_file:'/fixture/executor.key',...options.config});
  let authority:PaymentAuthority,runtime:PersonalAIOSRuntime;
  const build=()=>{
    authority=PaymentAuthority.open(join(directory,'payment'),{config,now:()=>now,verifier});
    const admission=new RunAdmission(storage,native,{max_pending_events:100,max_pending_bytes:1000000,max_event_age_ms:10000,
      poll_interval_ms:10000,native_idempotency_retention_ms:10000,policy_version:'payment-wire-e2e'});
    runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,100000,undefined,budget),admission,native,output:new OutputAuthority(storage),
      sourceAuthority,payment_devices:async principal=>pairedDevices.filter(device=>device.principal_id===principal),
      skill:'test',max_read_bytes:100000,payment:authority,voiceprint:registry,speech:async()=>speech,
      payment_ports:{enrolment_sentences:Array.from({length:8},(_,n)=>`fixture sentence ${n}`),forget:async()=>{await registry.forgetOwner();}}});
  };build();
  const clients:(()=>Promise<void>)[]=[];
  t.after(async()=>{for(const detach of clients)await detach();await runtime.close();await registry.close();await rm(directory,{recursive:true,force:true});});
  const base=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:true});addFormats.default(ajv,['uuid','date-time']);ajv.addFormat('paios-utc',{type:'string',validate:v=>{try{utc(v);return true;}catch{return false;}}});
  const defs={...base.$defs,...paymentWire.$defs};
  const input=Object.fromEntries(Object.entries({...base.inputs,...paymentWire.inputs}).map(([op,s])=>[op,ajv.compile({$defs:defs,...(s as {definition:object}).definition})]));
  const output=Object.fromEntries(Object.entries({...base.outputs,...paymentWire.outputs}).map(([op,s])=>[op,ajv.compile({$defs:defs,...s as object})]));
  async function record(source:RegisteredDevice,pcm?:Buffer,text?:string){
    pcm??=await options.capture?.(source,text)??Buffer.alloc(76800,4);
    const event_id=`pcm-${++serial}`,end=now,start=now-pcm.length/32;
    const result=await streams.append({schema_version:'paios.event.v1',event_id,device_id:source.device_id,device_type:source.device_type,captured_at:new Date(now).toISOString(),
      source:{channel:source.channel},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:pcm},
      {...source,submission:'observation'},new Date(now).toISOString(),{track_id:'microphone',stream_epoch:event_id,seq:0,modality:'audio',format:'pcm_s16le:16000:1',
        source_range:{kind:'interval',timebase_id:'utc_epoch_ms',stream_epoch:event_id,start_ms:start,end_ms:end}});
    return {raw_ref:result.event.raw_ref,archive_revision:result.event.archive_revision,start_ms:start,end_ms:end};
  }
  async function client(token:string){
    const source=await runtime.authenticate(token),messages:Record<string,unknown>[]=[],stops:(()=>void)[]=[];
    const changed=new Set<()=>void>();
    const receive=async(projection:Record<string,unknown>)=>{const framed={...projection,schema_version:'paios.central.text-envelope.v1',session_id:'session'};
      const validate=output[String(projection.operation)];assert.ok(validate);assert.equal(validate(framed),true,JSON.stringify(validate.errors));messages.push(framed);for(const wake of [...changed])wake();};
    const attach=async()=>{stops.push(await runtime.watchCare(source,async()=>false,undefined,undefined,undefined,undefined,undefined,{session:'session',deliver:async()=>{}}));
      stops.push(await runtime.watchPayments(source,receive));};
    const send=async(body:Record<string,unknown>)=>{const validate=input[String(body.operation)];assert.ok(validate);assert.equal(validate(body),true,JSON.stringify(validate.errors));
      let result:Record<string,unknown>|undefined;
      if(body.operation==='voiceprint_open'){await runtime.voiceprintOwner(source);result={operation:'voiceprint_sample',operation_id:body.operation_id,status:'recording'};}
      else if(body.operation==='voiceprint_commit'){const measured=await runtime.voiceprintSample(source,await record(source));result={operation:'voiceprint_sample',operation_id:body.operation_id,status:'measured',...measured};}
      else if(body.operation==='voiceprint_read'||body.operation==='voiceprint_enroll'){
        const enrolled=body.operation==='voiceprint_enroll'?await runtime.voiceprintEnroll(source,body.sample_ids as string[]):undefined;
        const owner=enrolled?.owner??await runtime.voiceprintOwner(source);
        result={operation:'voiceprint_owner',control_id:body.control_id,owner:{enrolled:owner.enrolled,reenrollment_required:owner.reenrollment_required,samples:owner.samples,
          ...(owner.updated_at?{updated_at:owner.updated_at}:{}),...(owner.consistency?{consistency_min:owner.consistency.min}:{})},...(enrolled?{enrollment:{status:enrolled.status}}:{})};
      }else result=await dispatchPayment(runtime,source,body);
      if(result)await receive(result);return result;};
    const detach=async()=>{for(const stop of stops.splice(0))stop();await runtime.paymentDetach(source);};
    const latest=(op:string)=>messages.filter(m=>m.operation===op).at(-1)!;
    const waitFor=async(op:string,accept:(frame:Record<string,unknown>)=>boolean)=>{
      while(!latest(op)||!accept(latest(op)))await new Promise<void>(resolve=>{const wake=()=>{changed.delete(wake);resolve();};changed.add(wake);});
      return latest(op);
    };
    clients.push(detach);return {source,messages,attach,send,detach,latest,waitFor};
  }
  async function submit(source:RegisteredDevice,prompt=true,session_id=`request-session-${++serial}`,text?:string){
    const event_id=`event-${++serial}`,audio=text?await record(source,undefined,text):undefined;
    const raw:RawEvent={schema_version:'paios.event.v1',event_id,device_id:source.device_id,device_type:source.device_type,captured_at:new Date(now).toISOString(),
      source:{channel:source.channel},media_type:text?'app_event':prompt?'text':'app_event',mime:text||!prompt?'application/json':'text/plain;charset=utf-8',representation:'uploaded_original',
      payload:Buffer.from(text?JSON.stringify({kind:'voice_turn',speaker:'owner',user:text,assistant:'',call_id:'synthetic-mirror',turn:serial,audio}):prompt?'帮我点一杯一点点，预算16.6元':JSON.stringify({kind:'payment_update',event:'card_opened'}))};
    const accepted=text?await runtime.submitCallTurn(raw,source,session_id):await runtime.submit(raw,source,session_id,prompt);let entry=accepted.admission;
    for(let n=0;!entry?.run_id&&n<100;n++){await new Promise(r=>setTimeout(r,5));entry=(await runtime.event(source,session_id,accepted.processed_event.processed_event_id)).admission;}
    assert.ok(entry?.run_id);return {run_id:entry.run_id,session_id,processed_event_id:accepted.processed_event.processed_event_id,raw};
  }
  const server=createServer((req,res)=>{void handlePaymentExecutor(req,res,authority,'fixture-executor-key',100000).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const executor=async(path:string,body?:object,key='fixture-executor-key')=>{const response=await fetch(`http://127.0.0.1:${address.port}/internal/payment/executor${path}`,
    {method:body?'POST':'GET',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json() as Record<string,unknown>};};
  const restart=async()=>{for(const detach of clients)await detach();await runtime.close();build();};
  const advance=async(ms:number)=>{now+=ms;await authority.tick();};
  return {get runtime(){return runtime;},get authority(){return authority;},get now(){return now;},registry,config,client,submit,executor,record,restart,advance,
    verdict:(next:VoiceVerdict)=>{verdict=next;}};
}

test('S1 server orchestration: owner tool → manual HTTP checkpoint/tap/result → phone records; source/replay guards',async t=>{
  const f=await fixture(t),iphone=await f.client('phone-token'),spectacles=await f.client('glasses-token');
  await spectacles.attach();
  const keys=keyPair(),challenge=await iphone.send({operation:'payment_challenge_get',request_id:'key-challenge',purpose:'keys_register'});
  const statement={purpose:'keys_register',role:'device',device_id:iphone.source.device_id,nonce:challenge!.nonce,key_sha256:sha256(Buffer.from(keys.public_x963_b64,'base64'))};
  const registration=await iphone.send({operation:'payment_keys_register',control_id:'register',role:'device',public_x963_b64:keys.public_x963_b64,...signed(keys,statement)});
  assert.equal(registration!.ok,true);
  const user=keyPair(),userChallenge=await iphone.send({operation:'payment_challenge_get',request_id:'user-key-challenge',purpose:'keys_register'});
  const userStatement={purpose:'keys_register',role:'user',device_id:'phone',nonce:userChallenge!.nonce,key_sha256:sha256(Buffer.from(user.public_x963_b64,'base64'))};
  await iphone.send({operation:'payment_keys_register',control_id:'register-user',role:'user',public_x963_b64:user.public_x963_b64,
    ...signed(user,userStatement),device_signature_b64:signed(keys,userStatement).signature_b64});
  const policy_version=(await iphone.send({operation:'payment_settings_get',request_id:'initial-settings'}))!.policy_version;
  const lockChallenge=await iphone.send({operation:'payment_challenge_get',request_id:'lock-challenge',purpose:'settings'}),change={kind:'phone_lock',enabled:true,relock_s:60};
  await iphone.send({operation:'payment_settings_set',control_id:'enable-lock',policy_version,change,
    ...signed(user,{purpose:'settings',device_id:'phone',nonce:lockChallenge!.nonce,policy_version,change})});
  const unlockChallenge=await iphone.send({operation:'payment_challenge_get',request_id:'unlock-challenge',purpose:'phone_unlock'});
  await iphone.send({operation:'phone_unlock',control_id:'unlock',...signed(user,{purpose:'phone_unlock',device_id:'phone',nonce:unlockChallenge!.nonce})});
  const run=await f.submit(iphone.source,true,'session'),call={context:{run_id:run.run_id,session_id:'session',tool_call_id:'buy-tea'},args:{action:'request',purpose:'奶茶',app:'千问',budget_yuan:16.6}};
  const intent=await f.runtime.tool('paios_payment',call) as Record<string,unknown>;assert.equal(intent.status,'accepted');
  assert.deepEqual(await f.runtime.tool('paios_payment',call),intent,'replayed owner tool call keeps one intent');
  assert.equal(f.runtime.paymentSource(run.run_id,intent.intent_id as string).allowed,true);
  assert.equal(f.runtime.paymentSource('foreign-run',intent.intent_id as string).allowed,false);
  await assert.rejects(f.runtime.tool('paios_payment',{...call,args:{...call.args,initiating:{kind:'voice'}}}),/UNKNOWN_TOOL_ARGUMENT/);
  const observation=await f.submit(iphone.source,false,'observation-session');
  assert.deepEqual(await f.runtime.tool('paios_payment',{...call,context:{...call.context,run_id:observation.run_id,session_id:'observation-session'}}),{status:'rejected',error_code:'PAYMENT_SOURCE_NOT_OWNER'});
  const checkpoint={intent_id:intent.intent_id,job_id:'job-wire-s1',seq:1,app:'千问',checkout:'cashier',amount_fen:1660,payee:'一点点',items:['香柠养乐多'],screen_sha256:'a'.repeat(64),read_at:new Date().toISOString()};
  assert.equal((await f.executor('/checkpoints',checkpoint,'wrong-key')).status,401);
  const opened=await f.executor('/checkpoints',checkpoint);assert.equal(opened.status,200);assert.deepEqual(await f.executor('/checkpoints',checkpoint),opened);
  const payment_id=String(opened.body.payment_id);await iphone.attach();
  const card=(iphone.messages.find(m=>m.operation==='payment_cards')!.cards as Record<string,unknown>[])[0]!;
  assert.equal(card.payment_id,payment_id);assert.equal(card.amount_fen,1660);assert.equal(card.state,'awaiting_owner');
  const notice=spectacles.messages.filter(m=>m.operation==='payment_notice').at(-1)!.notice as Record<string,unknown>;
  assert.equal(notice.payment_id,payment_id);assert.equal(notice.voice_hint,false,'typed request never gives glasses voice permission');
  const decision={operation:'payment_decide',control_id:'pay',payment_id,decision:'pay',...signed(keys,{purpose:'payment_decide',device_id:'phone',payment_id,decision:'pay',amount_fen:1660,payee_key:card.payee_key??null,nonce:card.decision_nonce})};
  await assert.rejects(spectacles.send(decision),/PAYMENT_TERMINAL_NOT_ALLOWED/);
  assert.equal((await iphone.send(decision))!.ok,true);assert.equal((await iphone.send(decision))!.ok,true);
  const poll=await f.executor(`/payments/${payment_id}`);assert.equal(poll.body.state,'granted');
  const grant=poll.body.grant as Record<string,unknown>;assert.equal(grant.amount_fen,1660);
  assert.equal((await f.executor(`/payments/${payment_id}/tap`,{grant_id:grant.grant_id,step:1,read_amount_fen:1661,screen_sha256:'b'.repeat(64)})).status,409);
  const tap={grant_id:grant.grant_id,step:1,read_amount_fen:1660,screen_sha256:'b'.repeat(64)};
  assert.equal((await f.executor(`/payments/${payment_id}/tap`,tap)).status,200);assert.equal((await f.executor(`/payments/${payment_id}/tap`,tap)).status,200);
  assert.equal((await f.executor(`/payments/${payment_id}/result`,{grant_id:grant.grant_id,outcome:'paid',signs:['支付成功'],screen_sha256:'c'.repeat(64)})).status,200);
  const record=await iphone.send({operation:'payment_record_get',request_id:'record',payment_id});
  assert.equal((record!.payment as Record<string,unknown>).state,'paid');
  assert.equal(f.authority.store.events(payment_id).filter(e=>e.kind==='grant_issued').length,1);
  await iphone.detach();await iphone.attach();
  const latest=iphone.messages.filter(m=>m.operation==='payment_cards').at(-1)!;assert.equal((latest.cards as Record<string,unknown>[])[0]!.state,'paid');
  assert.equal(JSON.stringify(iphone.messages).includes(String(grant.grant_id)),false,'device projections never leak executor grant');
  const update=f.authority.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='card_opened'").get() as {n:number};assert.equal(update.n,1);
});

type Harness=Awaited<ReturnType<typeof fixture>>;
type Client=Awaited<ReturnType<Harness['client']>>;
async function controls(t:test.TestContext,config:Record<string,unknown>={},ports:Pick<HarnessOptions,'verifier'|'speech'|'capture'>={}){
  const f=await fixture(t,{config,...ports}),iphone=await f.client('phone-token'),spectacles=await f.client('glasses-token'),dev=keyPair(),user=keyPair();
  await iphone.attach();await spectacles.attach();await f.runtime.wearState(spectacles.source,true,1);
  for(const [role,key] of [['device',dev],['user',user]] as const){
    const challenge=await iphone.send({operation:'payment_challenge_get',request_id:`challenge-${role}`,purpose:'keys_register'});
    const statement={purpose:'keys_register',role,device_id:'phone',nonce:challenge!.nonce,key_sha256:sha256(Buffer.from(key.public_x963_b64,'base64'))};
    await iphone.send({operation:'payment_keys_register',control_id:`register-${role}`,role,public_x963_b64:key.public_x963_b64,...signed(key,statement),
      ...(role==='user'?{device_signature_b64:signed(dev,statement).signature_b64}:{})});
  }
  let seq=0;
  const challenge=async(purpose:string)=>(await iphone.send({operation:'payment_challenge_get',request_id:`challenge-${++seq}`,purpose}))!.nonce;
  const settings=async(change:SettingsChange,key:typeof user|null=user)=>{
    const policy_version=Number((await iphone.send({operation:'payment_settings_get',request_id:`policy-${++seq}`}))!.policy_version);
    return iphone.send({operation:'payment_settings_set',control_id:`settings-${++seq}`,policy_version,change,
      ...(key?signed(key,{purpose:'settings',device_id:'phone',nonce:await challenge('settings'),policy_version,change}):{})});
  };
  const approved=new Set<unknown>();
  const approve=async()=>{const pending=(frame:Record<string,unknown>)=>(frame.approvals as Record<string,unknown>[]).find(a=>!approved.has(a.approval_id));
    const a=pending(await iphone.waitFor('payment_approvals',frame=>!!pending(frame)))!;assert.ok(a);
    const receipt=await iphone.send({operation:'payment_approval_decide',control_id:`approve-${++seq}`,approval_id:a.approval_id,decision:'approve',
      ...signed(user,{purpose:'approval',device_id:'phone',nonce:a.nonce,approval_id:a.approval_id,kind:a.kind,target_device_id:'glasses',decision:'approve'})});
    approved.add(a.approval_id);
    await spectacles.waitFor('payment_lock_state',frame=>a.kind==='glasses_unlock'?frame.locked===false:(frame.enrolment as Record<string,unknown>).granted===true);
    return receipt;};
  const unlock=async()=>iphone.send({operation:'phone_unlock',control_id:`unlock-${++seq}`,...signed(user,{purpose:'phone_unlock',device_id:'phone',nonce:await challenge('phone_unlock')})});
  const locks=async()=>{await settings({kind:'phone_lock',enabled:true,relock_s:60});await settings({kind:'glasses_lock',device_id:'glasses',enabled:true});
    await unlock();await spectacles.send({operation:'glasses_unlock_request',control_id:`request-${++seq}`,lock_cycle:1});await approve();};
  const seedVoice=async()=>{for(const channel of ['phone_app','glasses'] as const)await f.registry.enrollOwner({speaker_model:f.registry.model,channel,mode:'replace',
    samples:Array.from({length:5},()=>({embedding:Float32Array.from({length:f.registry.model.dim},(_,n)=>Number(n===0)),speech_ms:2400})),at:new Date(f.now).toISOString()});};
  const open=async(options:{voice?:Client;amount?:number;payee?:string}={})=>{
    const source=options.voice??iphone,run=await f.submit(source.source,true,`purchase-${++seq}`,options.voice?'帮我买奶茶':undefined);
    const intent=await f.runtime.tool('paios_payment',{context:{run_id:run.run_id,session_id:run.session_id,tool_call_id:`purchase-${seq}`},args:{action:'request',purpose:'奶茶',app:'千问'}}) as Record<string,unknown>;
    assert.equal(intent.status,'accepted');await new Promise<void>(resolve=>setImmediate(resolve));
    const response=await f.executor('/checkpoints',{intent_id:intent.intent_id,job_id:`job-harness-${++seq}`,seq:1,app:'千问',checkout:'cashier',amount_fen:options.amount??1660,
      payee:options.payee??'一点点',items:['奶茶'],screen_sha256:'a'.repeat(64),read_at:new Date(f.now).toISOString()});assert.equal(response.status,200);
    await iphone.waitFor('payment_cards',frame=>(frame.cards as Record<string,unknown>[]).some(c=>c.payment_id===response.body.payment_id));
    return {payment_id:String(response.body.payment_id),intent_id:String(intent.intent_id),run};
  };
  const status=async(id:string)=>(await f.executor(`/payments/${id}`)).body;
  const card=(id:string)=>(iphone.latest('payment_cards').cards as Record<string,unknown>[]).find(c=>c.payment_id===id)!;
  const pay=async(id:string)=>{const c=card(id);assert.ok(c);return iphone.send({operation:'payment_decide',control_id:`pay-${++seq}`,payment_id:id,decision:'pay',
    ...signed(dev,{purpose:'payment_decide',device_id:'phone',payment_id:id,decision:'pay',amount_fen:c.amount_fen,payee_key:c.payee_key??null,nonce:c.decision_nonce})});};
  const cancel=async(id:string)=>iphone.send({operation:'payment_decide',control_id:`cancel-${++seq}`,payment_id:id,decision:'cancel'});
  const complete=async(id:string)=>{const grant=(await status(id)).grant as Record<string,unknown>;assert.ok(grant);
    assert.equal((await f.executor(`/payments/${id}/tap`,{grant_id:grant.grant_id,step:1,read_amount_fen:grant.amount_fen,screen_sha256:'b'.repeat(64)})).status,200);
    assert.equal((await f.executor(`/payments/${id}/result`,{grant_id:grant.grant_id,outcome:'paid',signs:['支付成功'],screen_sha256:'c'.repeat(64)})).status,200);};
  const known=async()=>{const c=await open();await pay(c.payment_id);await complete(c.payment_id);await f.advance(f.config.auto.same_payee_window_s*1000+1);};
  const ready=async(auto=false)=>{await seedVoice();await locks();await known();await settings({kind:'voice',enabled:true});if(auto)await settings({kind:'auto',enabled:true});};
  const voice=async(source= spectacles)=>{await f.advance(2400);return f.submit(source.source,true,`pay-phrase-${++seq}`,'付吧');};
  await settings({kind:'phone_lock',enabled:true,relock_s:60});await unlock();
  return {...f,get runtime(){return f.runtime;},get authority(){return f.authority;},iphone,spectacles,dev,user,settings,approve,unlock,locks,seedVoice,open,status,card,pay,cancel,complete,known,ready,voice};
}

test('I1 merged typed effect consent grants no payment; lost signed decision receipt replays after relock without a second grant',async t=>{
  const f=await controls(t),c=await f.open();
  assert.equal((await f.runtime.effectConsent({...c.run,tool_call_id:'effect'},
    {kind:'external',task_type:'purchase',requested:true},true,true)).status,'allowed');
  assert.equal((await f.status(c.payment_id)).state,'awaiting_owner');
  assert.equal((await f.status(c.payment_id)).grant,undefined);
  const first=await f.pay(c.payment_id),grant=(await f.status(c.payment_id)).grant as Record<string,unknown>;
  await f.iphone.send({operation:'phone_presence',state:'locked'});
  const replay=await f.pay(c.payment_id);
  assert.equal(replay!.state,first!.state);
  assert.equal(((await f.status(c.payment_id)).grant as Record<string,unknown>).grant_id,grant.grant_id);
  assert.equal(f.authority.store.events(c.payment_id).filter(e=>e.kind==='grant_issued').length,1);
  assert.equal(f.authority.store.getGrant(c.payment_id)!.taps,0);
});

test('I1 delayed archived call phrase cannot pay a card created after that phrase was captured',async t=>{
  const f=await controls(t);await f.ready();
  const prior=await f.submit(f.iphone.source,true,'old-payment-phrase','付吧');
  await f.advance(3001);const card=await f.open({voice:f.iphone});
  await f.runtime.submitCallTurn(prior.raw,f.iphone.source,'old-payment-phrase');
  assert.equal((await f.status(card.payment_id)).state,'awaiting_owner');
  assert.equal((await f.status(card.payment_id)).grant,undefined);
  assert.equal(f.authority.store.events(card.payment_id).filter(e=>e.kind==='voice_ignored').at(-1)!.data.reason,'UTTERANCE_BEFORE_CARD');
  await f.voice(f.iphone);assert.equal((await f.status(card.payment_id)).state,'granted');
});

test('I1 archived call replay cannot reuse one voice decision across two existing cards',async t=>{
  const f=await controls(t);await f.ready();
  const older=await f.open({voice:f.iphone});await f.advance(1);
  const newer=await f.open({voice:f.iphone}),phrase=await f.voice(f.iphone);
  assert.equal((await f.status(newer.payment_id)).state,'granted');
  await f.advance(3001);await f.runtime.submitCallTurn(phrase.raw,f.iphone.source,phrase.session_id);
  assert.equal((await f.status(older.payment_id)).state,'awaiting_owner');
  assert.equal((await f.status(older.payment_id)).grant,undefined);
  assert.equal(f.authority.store.events().filter(e=>e.kind==='grant_issued'&&[older.payment_id,newer.payment_id].includes(e.payment_id??'')).length,1);
  assert.equal(f.authority.store.events(older.payment_id).filter(e=>e.kind==='voice_ignored').at(-1)!.data.reason,'UTTERANCE_REPLAY');
});

test('S2 S3 server orchestration: cancel/expiry accepts manually reported order cancellation',async t=>{
  const f=await controls(t,{card_ttl_s:5});
  for(const mode of ['cancel','expire']){
    const c=await f.open();if(mode==='cancel')await f.cancel(c.payment_id);else await f.advance(5000);
    assert.equal((await f.status(c.payment_id)).state,mode==='cancel'?'cancelled':'expired');
    assert.equal((await f.executor(`/payments/${c.payment_id}/order-cancel`,{outcome:'done',detail:'fake cashier cancelled unpaid order'})).status,200);
    const record=await f.iphone.send({operation:'payment_record_get',request_id:`record-${mode}`,payment_id:c.payment_id});
    assert.equal((record!.payment as Record<string,unknown>).order_cancel,'done');
  }
});
test('S4 server orchestration: manually reported amount change recards; instability leaves grant taps at zero',async t=>{
  const f=await controls(t,{max_recards_per_intent:1}),c=await f.open();await f.pay(c.payment_id);
  const grant=(await f.status(c.payment_id)).grant as Record<string,unknown>;
  const changed=await f.executor(`/payments/${c.payment_id}/amount-changed`,{grant_id:grant.grant_id,read_amount_fen:1860,payee:'一点点',items:['奶茶'],screen_sha256:'b'.repeat(64)});
  assert.equal(changed.status,200);assert.equal((await f.status(c.payment_id)).state,'superseded');
  const next=String((changed.body.next as Record<string,unknown>).payment_id);assert.equal(f.card(next).amount_fen,1860);
  assert.equal((await f.executor(`/payments/${next}/amount-changed`,{read_amount_fen:1960,payee:'一点点',items:['奶茶'],screen_sha256:'c'.repeat(64)})).status,409);
  assert.equal((await f.status(next)).state,'failed');assert.equal((await f.status(next)).reason,'AMOUNT_UNSTABLE');
  assert.equal(f.authority.store.getGrant(c.payment_id)!.taps,0);
});
test('S5 S6 fake-verifier runtime voice: glasses pays by voice; two other-speaker verdicts exhaust tries and pause auto',async t=>{
  const f=await controls(t);await f.ready();const first=await f.open({voice:f.spectacles});await f.voice();
  assert.equal((await f.status(first.payment_id)).state,'granted');await f.complete(first.payment_id);
  const record=await f.iphone.send({operation:'payment_record_get',request_id:'voice-record',payment_id:first.payment_id});
  assert.equal((record!.payment as Record<string,unknown>).method,'voice');assert.equal((record!.payment as Record<string,unknown>).terminal,'glasses');
  await f.advance(3001);const bad=await f.open({voice:f.spectacles});f.verdict({...passing,verdict:'fail',reason:'other_speaker'});
  for(let n=0;n<2;n++){await f.voice();assert.equal((await f.status(bad.payment_id)).reason,'VOICE_NOT_RECOGNIZED');await f.advance(3001);}
  await f.voice();assert.equal((await f.status(bad.payment_id)).reason,'VOICE_ATTEMPTS_EXHAUSTED');
  assert.ok(f.iphone.latest('payment_settings').paused_until);assert.equal((await f.status(bad.payment_id)).grant,undefined);
});
test('PR05 marker enrollment + fake verifier: Mac-only owner cannot authorize phone or glasses voice/auto',async t=>{
  let initiatingChecks=0,payChecks=0;
  const verifier:PaymentVoiceVerifier={verifyInitiating:async()=>{initiatingChecks++;return passing;},verifyPay:async()=>{payChecks++;return passing;}};
  const f=await controls(t,{}, {verifier});await f.ready(true);
  const mac=await f.runtime.authenticate('mac-token'),samples:string[]=[];
  // Mac enrolls through authenticated runtime + archived PCM, without attaching a payment watcher.
  for(let n=0;n<5;n++){
    const measured=await f.runtime.voiceprintSample(mac,await f.record(mac));
    assert.equal(measured.quality,'ok');assert.ok(measured.sample_id);samples.push(measured.sample_id);
  }
  const enrolled=await f.runtime.voiceprintEnroll(mac,samples);
  assert.equal(enrolled.status,'enrolled');assert.equal((await f.runtime.voiceprintOwner(mac)).enrolled,true);
  await f.registry.forgetOwner('phone_app');await f.registry.forgetOwner('glasses');
  const owner=await f.registry.owner();assert.equal(owner.enrolled,true);assert.equal(owner.reenrollment_required,false);
  assert.deepEqual(owner.channels.map(channel=>({channel:channel.channel,stale_model:channel.stale_model})),[{channel:'mac',stale_model:false}]);
  // Inspect the actual owner port bound by PersonalAIOSRuntime, rather than reconstructing its facts.
  const ports=(f.authority as unknown as {ports:PaymentPorts}).ports;
  assert.deepEqual(await ports.owner(mac.principal_id),{live:true,phone_app:false,glasses:false});
  const settings=await f.iphone.send({operation:'payment_settings_get',request_id:'mac-only-settings'});
  assert.equal(settings!.voice_enabled,true);assert.equal(settings!.auto_enabled,true);
  for(const terminal of [f.iphone,f.spectacles]){
    const c=await f.open({voice:terminal});
    assert.equal((await f.status(c.payment_id)).state,'awaiting_owner');
    assert.equal((await f.status(c.payment_id)).reason,'VOICE_UNAVAILABLE');
    await f.voice(terminal);await f.advance(f.config.auto.undo_s*1000);
    assert.equal((await f.status(c.payment_id)).state,'awaiting_owner');
    assert.equal((await f.status(c.payment_id)).reason,'VOICE_UNAVAILABLE');
    assert.equal((await f.status(c.payment_id)).grant,undefined);
    assert.equal(f.authority.store.events(c.payment_id).filter(event=>event.kind==='grant_issued').length,0);
    await f.cancel(c.payment_id);
  }
  assert.equal(initiatingChecks,2,'even explicit fake initiating passes cannot substitute for channel enrollment');
  assert.equal(payChecks,0,'Mac enrollment cannot reach pay verification on another capture channel');
});
test('S7 S8 S20 fake-verifier runtime auto: undo grants once, cancel prevents it, typed requests remain card-only',async t=>{
  const f=await controls(t);await f.ready(true);const c=await f.open({voice:f.spectacles});assert.equal((await f.status(c.payment_id)).state,'auto_pending');
  await f.advance(4999);assert.equal((await f.status(c.payment_id)).state,'auto_pending');await f.advance(1);await f.complete(c.payment_id);
  assert.equal(f.iphone.latest('payment_settings').today_auto_used_fen,1660);
  await f.advance(f.config.auto.same_payee_window_s*1000+1);
  const cancelled=await f.open({voice:f.spectacles});await f.cancel(cancelled.payment_id);await f.advance(5000);
  assert.equal((await f.status(cancelled.payment_id)).state,'cancelled');assert.equal((await f.status(cancelled.payment_id)).grant,undefined);
  const typed=await f.open();assert.equal((await f.status(typed.payment_id)).reason,'INITIATING_NOT_VOICE');
});
test('S9 S10 S11 S12 fake-verifier runtime auto: limits, first payee, recent payee and daily total require a card',async t=>{
  const f=await controls(t);await f.ready(true);
  for(const [options,reason] of [[{amount:6840},'OVER_AUTO_LIMIT'],[{payee:'new payee'},'NEW_PAYEE']] as const){
    const c=await f.open({voice:f.spectacles,...options});assert.equal((await f.status(c.payment_id)).reason,reason);await f.cancel(c.payment_id);}
  const first=await f.open({voice:f.spectacles});await f.advance(5000);await f.complete(first.payment_id);
  const recent=await f.open({voice:f.spectacles});assert.equal((await f.status(recent.payment_id)).reason,'SAME_PAYEE_RECENT');await f.cancel(recent.payment_id);
  await f.advance(f.config.auto.same_payee_window_s*1000+1);await f.settings({kind:'limits',auto_day_fen:2000});
  const day=await f.open({voice:f.spectacles});assert.equal((await f.status(day.payment_id)).reason,'OVER_AUTO_DAY_LIMIT');
});
test('S13 S14 wire identity: signed glasses approval, takeoff locks; Watch/Mac/model and foreign intent are denied',async t=>{
  const f=await controls(t);await f.ready();assert.equal(f.spectacles.latest('payment_lock_state').locked,false);
  const c=await f.open({voice:f.spectacles});await f.runtime.wearState(f.spectacles.source,false,2);await f.voice();
  assert.equal((await f.status(c.payment_id)).reason,'TERMINAL_LOCKED');
  assert.equal((f.spectacles.latest('payment_notice').notice as Record<string,unknown>).reason,'TERMINAL_LOCKED');
  for(const device_type of ['watch','mac'])await assert.rejects(dispatchPayment(f.runtime,{...f.iphone.source,device_type} as RegisteredDevice,
    {operation:'payment_decide',control_id:'wrong',payment_id:c.payment_id,decision:'cancel'}),/PAYMENT_TERMINAL_NOT_ALLOWED/);
  const observation=await f.submit(f.iphone.source,false),denied=await f.runtime.tool('paios_payment',{context:{...observation,tool_call_id:'model'},args:{action:'request',purpose:'tea',app:'千问'}}) as Record<string,unknown>;
  assert.equal(denied.error_code,'PAYMENT_SOURCE_NOT_OWNER');assert.equal(f.runtime.paymentSource('foreign-run',c.intent_id).allowed,false);
  assert.ok(f.authority.store.events().some(e=>e.kind==='intent_refused'));
  // The phone executor owns phone_task hook rejection of pay_limit_yuan; no executor/model hook is fabricated here.
});
test('S15 S19 server orchestration: missing result after manual tap times out; manual verification abort keeps order',async t=>{
  const f=await controls(t),crash=await f.open();await f.pay(crash.payment_id);const grant=(await f.status(crash.payment_id)).grant as Record<string,unknown>;
  await f.executor(`/payments/${crash.payment_id}/tap`,{grant_id:grant.grant_id,step:1,read_amount_fen:1660,screen_sha256:'b'.repeat(64)});
  await f.advance(f.config.result_timeout_s*1000);assert.equal((await f.status(crash.payment_id)).state,'outcome_unknown');
  await f.pay(crash.payment_id);assert.equal(f.authority.store.events(crash.payment_id).filter(e=>e.kind==='grant_issued').length,1);
  const verify=await f.open();await f.pay(verify.payment_id);const g=(await f.status(verify.payment_id)).grant as Record<string,unknown>;
  await f.executor(`/payments/${verify.payment_id}/abort`,{grant_id:g.grant_id,reason:'VERIFICATION_REQUIRED'});
  const record=await f.iphone.send({operation:'payment_record_get',request_id:'verify-record',payment_id:verify.payment_id});
  assert.equal((record!.payment as Record<string,unknown>).order_cancel,'not_needed');assert.equal(f.authority.store.getGrant(verify.payment_id)!.taps,0);
});
test('S16 real runtime reopen: undo becomes card, awaiting card survives and HTTP poll resumes',async t=>{
  const f=await controls(t);await f.ready(true);const auto=await f.open({voice:f.spectacles}),card=await f.open();
  assert.equal((await f.status(auto.payment_id)).state,'auto_pending');await f.restart();
  const phone2=await f.client('phone-token');await phone2.attach();
  assert.equal((await f.status(auto.payment_id)).state,'awaiting_owner');assert.equal((await f.status(auto.payment_id)).reason,'AUTO_INTERRUPTED');
  assert.equal((await f.status(card.payment_id)).state,'awaiting_owner');assert.ok((phone2.latest('payment_cards').cards as Record<string,unknown>[]).some(c=>c.payment_id===card.payment_id));
});
test('S17 wire settings: missing voiceprint, invalid signature, unsigned off, then forget cascades both methods off',async t=>{
  const f=await controls(t);await f.locks();await assert.rejects(f.settings({kind:'auto',enabled:true}),/PAYMENT_PREREQUISITE_MISSING/);
  await assert.rejects(f.settings({kind:'auto',enabled:true},f.dev),/PAYMENT_SIGNATURE_INVALID/);
  const beforeOff=Number(f.iphone.latest('payment_settings').policy_version);
  assert.equal((await f.settings({kind:'auto',enabled:false},null))!.ok,true);
  await f.seedVoice();
  // OFF avoids registry reads and owner-dependent snapshots. Refresh the public
  // settings before a separate signed enable, which requires the current version.
  const refreshed=await f.iphone.send({operation:'payment_settings_get',request_id:'after-off'});
  assert.ok(Number(refreshed!.policy_version)>beforeOff);
  await f.settings({kind:'voice',enabled:true});await f.settings({kind:'auto',enabled:true});await f.runtime.voiceprintForget(f.iphone.source);
  await f.iphone.waitFor('payment_settings',frame=>frame.voice_enabled===false&&frame.auto_enabled===false);
  assert.equal(f.iphone.latest('payment_settings').voice_enabled,false);assert.equal(f.iphone.latest('payment_settings').auto_enabled,false);
});
test('S18 marker speech, not real4a: wire approval grants eight archived glasses sentences, enroll consumes grant, later grant expires',async t=>{
  const f=await controls(t);await f.locks();await assert.rejects(f.spectacles.send({operation:'voiceprint_read',control_id:'no-grant'}),/VOICEPRINT_DEVICE_REQUIRED/);
  const grant=async()=>{await f.spectacles.send({operation:'voiceprint_enrol_request',control_id:'enrol-request'});await f.approve();};
  await grant();assert.equal((f.spectacles.latest('payment_lock_state').enrolment as Record<string,unknown>).granted,true);
  const samples:string[]=[];
  for(let n=0;n<8;n++){await f.spectacles.send({operation:'voiceprint_open',operation_id:`sentence-${n}`});
    const measured=await f.spectacles.send({operation:'voiceprint_commit',operation_id:`sentence-${n}`});samples.push(String(measured!.sample_id));}
  const enrolled=await f.spectacles.send({operation:'voiceprint_enroll',control_id:'enroll',sample_ids:samples});
  assert.equal((enrolled!.enrollment as Record<string,unknown>).status,'enrolled');assert.equal(await f.runtime.paymentEnrolmentAllowed(f.spectacles.source),false);
  await grant();await f.advance(f.config.enrolment.grant_ttl_s*1000);await assert.rejects(f.spectacles.send({operation:'voiceprint_read',control_id:'expired'}),/VOICEPRINT_ENROL_GRANT_EXPIRED/);
});
test('S21 fake-verifier D13: glasses off during undo, lease ends during verification, and signed tap after relock never grant',async t=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<VoiceVerdict>();let held=false;
  const verifier:PaymentVoiceVerifier={verifyInitiating:async()=>passing,verifyPay:async()=>{
    if(!held)return passing;entered.resolve();return release.promise;
  }};
  const f=await controls(t,{}, {verifier});await f.ready(true);const auto=await f.open({voice:f.spectacles});await f.runtime.wearState(f.spectacles.source,false,2);await f.advance(5000);
  assert.equal((await f.status(auto.payment_id)).reason,'TERMINAL_LOCKED');assert.equal((await f.status(auto.payment_id)).grant,undefined);await f.cancel(auto.payment_id);
  await f.settings({kind:'auto',enabled:false},null);const voice=await f.open({voice:f.iphone});
  held=true;const verifying=f.voice(f.iphone);
  try{
    // Entry is causal: the submission must reach the injected verifier before relock.
    // A rejected or prematurely completed submission fails this test immediately.
    await Promise.race([entered.promise,verifying.then(()=>{throw Error('voice submission completed before verifyPay entry');})]);
    assert.equal((await f.status(voice.payment_id)).state,'verifying');
    await f.iphone.send({operation:'phone_presence',state:'locked'});
  }finally{
    release.resolve(passing);await verifying;
  }
  assert.equal((await f.status(voice.payment_id)).reason,'TERMINAL_LOCKED');assert.equal((await f.status(voice.payment_id)).grant,undefined);
  await assert.rejects(f.pay(voice.payment_id),/PAYMENT_TERMINAL_LOCKED/);
});
