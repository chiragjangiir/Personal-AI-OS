import test from 'node:test';
import assert from 'node:assert/strict';
import {decideAuto,decideCard,decideVoice,decideVoiceResult,decideSettings} from '../src/payment/decide.ts';
import type {AutoFacts,CardFacts,VoiceFacts,SettingsFacts} from '../src/payment/decide.ts';
import {parsePaymentConfig,effectiveLimits} from '../src/payment/config.ts';
import type {Payment,PaymentIntent,PaymentPolicy,VoiceVerdict} from '../src/payment/contracts.ts';
const verdict:VoiceVerdict={verdict:'pass',initiating:{score:0.9,speech_ms:2000},channel:'phone_app',speaker_model:'test'};
const intent:PaymentIntent={intent_id:'pi',principal_id:'owner',run_id:'run',tool_call_id:'tool',session_id:'session',processed_event_id:'d',
  initiating:{kind:'voice',device_id:'phone',device_type:'phone',captured_at_ms:1000,lease_at_capture:true,verdict},initiating_text:null,
  purpose:'lunch',app:'qwen',budget_fen:null,created_at_ms:1000,expires_at_ms:100000,state:'bound',closed_reason:null};
const payment:Payment={payment_id:'pay',intent_id:'pi',principal_id:'owner',job_id:'job',seq:1,supersedes:null,app:'qwen',checkout:'cashier',amount_fen:100,
  payee:'Shop',payee_key:'key',items:['lunch'],delivery:null,screen_sha256:'screen',state:'awaiting_owner',version:1,decision_nonce:'nonce',
  created_at_ms:1000,expires_at_ms:100000,auto_at_ms:null,voice_attempts:0,method:null,decided_by_device:null,decision:null,reason:null,notice:null,
  next_payment_id:null,order_cancel:null,finished_at_ms:null};
const policy:PaymentPolicy={principal_id:'owner',version:1,voice_enabled:true,auto_enabled:true,limits:{},paused_until_ms:null,updated_at_ms:1000};
const config=parsePaymentConfig(),actor={device_id:'phone',device_type:'phone',owner_unlock:true,active:true};
const base={principal_id:'owner',now:2000,payment,intent,policy,config,locks_ok:true,lease_now:true,known_payee:true,limits:effectiveLimits(policy,config)};
const card=():CardFacts=>structuredClone({...base,actor,key_known:true,signature_valid:true,statement_matches:true,actor_lock_enabled:true});
const voice=():VoiceFacts=>structuredClone({...base,utterance:{device_id:'phone',device_type:'phone',raw_ref:'raw',start_ms:1500,end_ms:2000,captured_at:new Date(2000).toISOString()},active:true,lease_at_capture:true,enrolled:true});
const auto=():AutoFacts=>structuredClone({...base,auto_used_today:0,recent_same_payee:false,stage:'initial',enrolled:true});
const settings=():SettingsFacts=>structuredClone({actor,policy,config,change:{kind:'voice',enabled:true},policy_version:1,signature_present:true,signature_valid:true,live_owner:true,phone_lock:true,locks_ok:true,device_keys:true});
test('I1 I2 I4 I5: C1–C8 first failure, decision replay and grant-time lease',()=>{
  const cases:[string,(f:CardFacts)=>void][]=[
    ['PAYMENT_NOT_FOUND',f=>{delete f.payment;f.key_known=false;}],
    ['PAYMENT_ALREADY_DECIDED',f=>{f.payment!.decision='cancel';f.payment!.state='paid';}],
    ['PAYMENT_NOT_PENDING',f=>{f.payment!.state='paid';f.now=200000;}],
    ['PAYMENT_EXPIRED',f=>{f.now=100000;f.actor.active=false;}],
    ['PAYMENT_TERMINAL_NOT_ALLOWED',f=>{f.actor.device_type='glasses';f.key_known=false;}],
    ['PAYMENT_DEVICE_KEY_UNKNOWN',f=>{f.key_known=false;f.signature_valid=false;}],
    ['PAYMENT_SIGNATURE_INVALID',f=>{f.statement_matches=false;f.lease_now=false;}],
    ['PAYMENT_TERMINAL_LOCKED',f=>{f.lease_now=false;f.config.card.max_amount_fen=1;}],
    ['PAYMENT_LIMIT_EXCEEDED',f=>{f.config.card.max_amount_fen=1;}],
  ];
  for(const [code,mutate] of cases){const f=card();mutate(f);assert.equal((decideCard(f) as {code:string}).code,code);}
  const f=card();Object.assign(f.payment!,{state:'paid',decision:'pay',decided_by_device:'phone'});f.now=200000;
  assert.deepEqual(decideCard(f),{kind:'replay'});
});
test('strict card admission requires an enabled paying-terminal lock and current lease, independently of glasses',()=>{
  for(const lease of [false,true]){
    const f=card();f.actor_lock_enabled=false;f.lease_now=lease;
    assert.deepEqual(decideCard(f),{kind:'reject',code:'PAYMENT_TERMINAL_LOCKED',status:403});
  }
  const f=card();f.locks_ok=false;
  assert.deepEqual(decideCard(f),{kind:'grant',method:'card',device_id:'phone'});
});
test('I5 I16: V1–V12 first failure and V14 discards stale verification',()=>{
  const cases:[string,(f:VoiceFacts)=>void][]=[
    ['NO_PENDING_PAYMENT',f=>{f.payment!.state='auto_pending';f.active=false;}],
    ['TERMINAL_NOT_ALLOWED',f=>{f.active=false;f.policy.voice_enabled=false;}],
    ['VOICE_DISABLED',f=>{f.policy.voice_enabled=false;f.locks_ok=false;}],
    ['LOCKS_NOT_ENABLED',f=>{f.locks_ok=false;f.lease_at_capture=false;}],
    ['TERMINAL_LOCKED',f=>{f.lease_at_capture=false;f.payment!.voice_attempts=2;}],
    ['VOICE_ATTEMPTS_EXHAUSTED',f=>{f.payment!.voice_attempts=2;f.intent.initiating.kind='text';}],
    ['INITIATING_NOT_VOICE',f=>{f.intent.initiating.kind='text';f.intent.initiating.device_id='other';}],
    ['DIFFERENT_TERMINAL',f=>{f.intent.initiating.device_id='other';f.intent.initiating.lease_at_capture=false;}],
    ['TERMINAL_LOCKED',f=>{f.intent.initiating.lease_at_capture=false;f.intent.initiating.captured_at_ms=-999999;}],
    ['REQUEST_STALE',f=>{f.intent.initiating.captured_at_ms=-999999;f.limits.voice_order_fen=1;}],
    ['OVER_VOICE_LIMIT',f=>{f.limits.voice_order_fen=1;f.intent.budget_fen=1;}],
    ['OVER_BUDGET',f=>{f.intent.budget_fen=1;f.payment!.payee_key=null;}],
    ['PAYEE_UNREADABLE',f=>{f.payment!.payee_key=null;f.known_payee=false;}],
    ['NEW_PAYEE',f=>{f.known_payee=false;}],
  ];
  for(const [reason,mutate] of cases){const f=voice();mutate(f);assert.equal((decideVoice(f) as {reason:string}).reason,reason);}
  assert.deepEqual(decideVoice(voice()),{kind:'verify'});
  const f=voice();f.payment!.state='verifying';assert.deepEqual(decideVoiceResult(f,verdict),{kind:'grant',method:'voice',device_id:'phone'});
  f.lease_now=false;assert.deepEqual(decideVoiceResult(f,verdict),{kind:'card_only',reason:'TERMINAL_LOCKED'});
  for(const [v,reason] of [['unavailable','VOICE_UNAVAILABLE'],['insufficient','VOICE_INSUFFICIENT'],['uncertain','VOICE_NOT_RECOGNIZED'],['fail','VOICE_NOT_RECOGNIZED']] as const)
    assert.deepEqual(decideVoiceResult(f,{...verdict,verdict:v}),{kind:'card_only',reason});
  f.payment!.state='granted';assert.deepEqual(decideVoiceResult(f,verdict),{kind:'drop'});
});
test('I5 I16: A1–A9 first failure, cached verdict only skipped at undo completion',()=>{
  const cases:[string,(f:AutoFacts)=>void][]=[
    ['AUTO_DISABLED',f=>{f.policy.voice_enabled=false;f.policy.paused_until_ms=3000;}],
    ['AUTO_PAUSED',f=>{f.policy.paused_until_ms=3000;f.locks_ok=false;}],
    ['LOCKS_NOT_ENABLED',f=>{f.locks_ok=false;f.intent.initiating.kind='text';}],
    ['INITIATING_NOT_VOICE',f=>{f.intent.initiating.kind='text';f.lease_now=false;}],
    ['TERMINAL_LOCKED',f=>{f.lease_now=false;f.intent.initiating.captured_at_ms=-999999;}],
    ['REQUEST_STALE',f=>{f.intent.initiating.captured_at_ms=-999999;f.limits.auto_order_fen=1;}],
    ['OVER_AUTO_LIMIT',f=>{f.limits.auto_order_fen=1;f.limits.auto_day_fen=1;}],
    ['OVER_AUTO_DAY_LIMIT',f=>{f.auto_used_today=15000;f.intent.budget_fen=1;}],
    ['OVER_BUDGET',f=>{f.intent.budget_fen=1;f.payment!.payee_key=null;}],
    ['PAYEE_UNREADABLE',f=>{f.payment!.payee_key=null;f.known_payee=false;}],
    ['NEW_PAYEE',f=>{f.known_payee=false;f.recent_same_payee=true;}],
    ['SAME_PAYEE_RECENT',f=>{f.recent_same_payee=true;delete f.intent.initiating.verdict;}],
    ['VOICE_UNAVAILABLE',f=>{delete f.intent.initiating.verdict;}],
    ['INITIATING_NOT_OWNER_VERIFIED',f=>{f.intent.initiating.verdict!.verdict='fail';}],
  ];
  for(const [reason,mutate] of cases){const f=auto();mutate(f);assert.equal((decideAuto(f) as {reason:string}).reason,reason);}
  assert.deepEqual(decideAuto(auto()),{kind:'auto_pending'});
  const f=auto();f.stage='grant';f.payment!.state='auto_pending';delete f.intent.initiating.verdict;
  assert.deepEqual(decideAuto(f),{kind:'grant',method:'auto',device_id:'phone'});
  f.lease_now=false;assert.deepEqual(decideAuto(f),{kind:'card_only',reason:'TERMINAL_LOCKED'});
});
test('I6 I7: P1–P7 settings signatures and prerequisites; off/dispute remain unsigned',()=>{
  const cases:[string,(f:SettingsFacts)=>void][]=[
    ['PAYMENT_SETTINGS_DEVICE_REQUIRED',f=>{f.actor.active=false;f.policy_version=0;}],
    ['PAYMENT_POLICY_VERSION_STALE',f=>{f.policy_version=0;f.signature_present=false;}],
    ['PAYMENT_SIGNATURE_REQUIRED',f=>{f.signature_present=false;f.signature_valid=false;}],
    ['PAYMENT_SIGNATURE_INVALID',f=>{f.signature_valid=false;f.live_owner=false;}],
    ['PAYMENT_PREREQUISITE_MISSING',f=>{f.live_owner=false;}],
    ['PAYMENT_LIMIT_OUT_OF_RANGE',f=>{f.change={kind:'limits',auto_order_fen:0};}],
    ['PAYMENT_LIMIT_OUT_OF_RANGE',f=>{f.change={kind:'relock',relock_s:2};}],
  ];
  for(const [code,mutate] of cases){const f=settings();mutate(f);assert.equal((decideSettings(f) as {code:string}).code,code);}
  for(const change of [{kind:'voice',enabled:false},{kind:'auto',enabled:false},{kind:'dispute'}] as const){
    const f=settings();f.change=change;f.signature_present=false;f.live_owner=false;assert.deepEqual(decideSettings(f),{kind:'allow'});
  }
  const f=settings();f.change={kind:'auto',enabled:true};f.policy.voice_enabled=false;
  assert.deepEqual(decideSettings(f),{kind:'reject',code:'PAYMENT_PREREQUISITE_MISSING',status:409,missing:['VOICE_PAY']});
  assert.deepEqual(decideSettings(settings()),{kind:'allow'});
});
