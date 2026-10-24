import type {CardReason, Initiating, Limits, Payment, PaymentConfig, PaymentIntent, PaymentMethod, PaymentPolicy, SettingsChange, UtteranceRef, VoiceVerdict} from './contracts.ts';

export type Decision={kind:'grant';method:PaymentMethod;device_id:string}|{kind:'card_only';reason:CardReason}|
  {kind:'reject';code:string;status:number;missing?:string[]}|{kind:'replay'}|{kind:'ignore';reason:string}|
  {kind:'verify'}|{kind:'drop'}|{kind:'auto_pending'}|{kind:'allow'};
export interface ActorFacts {device_id:string;device_type:string;owner_unlock:boolean;active:boolean}
export interface DecisionFacts {
  principal_id:string;now:number;payment?:Payment;intent:PaymentIntent;policy:PaymentPolicy;config:PaymentConfig;
  locks_ok:boolean;lease_now:boolean;known_payee:boolean;limits:Limits;
}
export interface CardFacts extends DecisionFacts {
  actor:ActorFacts;key_known:boolean;signature_valid:boolean;statement_matches:boolean;actor_lock_enabled:boolean;
}
export interface VoiceFacts extends DecisionFacts {
  utterance:UtteranceRef;active:boolean;lease_at_capture:boolean;enrolled:boolean;
}
export interface AutoFacts extends DecisionFacts {auto_used_today:number;recent_same_payee:boolean;stage:'initial'|'grant';enrolled:boolean}
export interface SettingsFacts {
  actor:ActorFacts;policy:PaymentPolicy;config:PaymentConfig;change:SettingsChange|{kind:'dispute'}|{kind:'voiceprint_channel_forget'};
  policy_version:number;signature_present:boolean;signature_valid:boolean;live_owner:boolean;phone_lock:boolean;
  locks_ok:boolean;device_keys:boolean;
}
const reject=(code:string,status:number,missing?:string[]):Decision=>missing?{kind:'reject',code,status,missing}:{kind:'reject',code,status};
const card=(reason:CardReason):Decision=>({kind:'card_only',reason});
const phone=(actor:ActorFacts)=>actor.device_type==='phone'&&actor.owner_unlock&&actor.active;
const voiceTerminal=(type:string)=>type==='phone'||type==='glasses';
const stale=(initiating:Initiating,f:DecisionFacts)=>f.now-initiating.captured_at_ms>f.config.request_freshness_s*1000;

/** C1–C8. Identity, replay and state checks precede cryptographic input facts. */
export function decideCard(f:CardFacts):Decision {
  const p=f.payment;
  if(!p||p.principal_id!==f.principal_id)return reject('PAYMENT_NOT_FOUND',404);
  if(p.decision!==null)return p.decided_by_device===f.actor.device_id&&p.decision==='pay'?{kind:'replay'}:reject('PAYMENT_ALREADY_DECIDED',409);
  if(!['awaiting_owner','auto_pending','verifying'].includes(p.state))return reject('PAYMENT_NOT_PENDING',409);
  if(f.now>=p.expires_at_ms)return reject('PAYMENT_EXPIRED',410);
  if(!phone(f.actor))return reject('PAYMENT_TERMINAL_NOT_ALLOWED',403);
  if(!f.key_known)return reject('PAYMENT_DEVICE_KEY_UNKNOWN',403);
  if(!f.signature_valid||!f.statement_matches)return reject('PAYMENT_SIGNATURE_INVALID',403);
  if(!f.actor_lock_enabled||!f.lease_now)return reject('PAYMENT_TERMINAL_LOCKED',403);
  if(f.config.card.max_amount_fen!==null&&p.amount_fen>f.config.card.max_amount_fen)return reject('PAYMENT_LIMIT_EXCEEDED',403);
  return {kind:'grant',method:'card',device_id:f.actor.device_id};
}
/** V1–V12. The authority selects the newest eligible card before assembling these facts. */
export function decideVoice(f:VoiceFacts):Decision {
  const p=f.payment,i=f.intent.initiating;
  if(!p||p.principal_id!==f.principal_id||p.state!=='awaiting_owner'||f.now>=p.expires_at_ms)return {kind:'ignore',reason:'NO_PENDING_PAYMENT'};
  if(f.utterance.start_ms<p.created_at_ms)return {kind:'ignore',reason:'UTTERANCE_BEFORE_CARD'};
  if(!voiceTerminal(f.utterance.device_type)||!f.active)return {kind:'ignore',reason:'TERMINAL_NOT_ALLOWED'};
  if(!f.policy.voice_enabled)return card('VOICE_DISABLED');
  if(!f.locks_ok)return card('LOCKS_NOT_ENABLED');
  if(!f.enrolled)return card('VOICE_UNAVAILABLE');
  if(!f.lease_at_capture)return card('TERMINAL_LOCKED');
  if(p.voice_attempts>=f.config.voice.max_attempts_per_card)return card('VOICE_ATTEMPTS_EXHAUSTED');
  if(i.kind!=='voice')return card('INITIATING_NOT_VOICE');
  if(f.config.voice.require_same_terminal&&i.device_id!==f.utterance.device_id)return card('DIFFERENT_TERMINAL');
  if(!i.lease_at_capture)return card('TERMINAL_LOCKED');
  if(stale(i,f))return card('REQUEST_STALE');
  if(p.amount_fen>f.limits.voice_order_fen)return card('OVER_VOICE_LIMIT');
  if(f.intent.budget_fen!==null&&p.amount_fen>f.intent.budget_fen)return card('OVER_BUDGET');
  if(p.payee_key===null)return card('PAYEE_UNREADABLE');
  if(!f.known_payee)return card('NEW_PAYEE');
  return {kind:'verify'};
}
/** V13–V14. The authority records attempt counts and anomalies from the verifier verdict. */
export function decideVoiceResult(f:VoiceFacts,verdict:VoiceVerdict):Decision {
  const p=f.payment;
  // A winning card tap, cancellation or expiry invalidates the asynchronous result.
  if(!p||p.state!=='verifying'||f.now>=p.expires_at_ms)return {kind:'drop'};
  if(!f.enrolled)return card('VOICE_UNAVAILABLE');
  if(verdict.verdict==='unavailable')return card('VOICE_UNAVAILABLE');
  if(verdict.verdict==='insufficient')return card('VOICE_INSUFFICIENT');
  if(verdict.verdict!=='pass')return card('VOICE_NOT_RECOGNIZED');
  if(!f.lease_now)return card('TERMINAL_LOCKED');
  return {kind:'grant',method:'voice',device_id:f.utterance.device_id};
}
/** A1–A9. The cached initiating verdict is checked only when the undo window starts. */
export function decideAuto(f:AutoFacts):Decision {
  const p=f.payment,i=f.intent.initiating;
  if(!f.policy.auto_enabled||!f.policy.voice_enabled)return card('AUTO_DISABLED');
  if(f.policy.paused_until_ms!==null&&f.policy.paused_until_ms>f.now)return card('AUTO_PAUSED');
  if(!f.locks_ok)return card('LOCKS_NOT_ENABLED');
  if(i.kind!=='voice'||!voiceTerminal(i.device_type))return card('INITIATING_NOT_VOICE');
  if(!f.enrolled)return card('VOICE_UNAVAILABLE');
  if(!i.lease_at_capture||!f.lease_now)return card('TERMINAL_LOCKED');
  if(stale(i,f))return card('REQUEST_STALE');
  if(!p||p.principal_id!==f.principal_id)return reject('PAYMENT_NOT_FOUND',404);
  if(p.amount_fen>f.limits.auto_order_fen)return card('OVER_AUTO_LIMIT');
  if(f.auto_used_today+p.amount_fen>f.limits.auto_day_fen)return card('OVER_AUTO_DAY_LIMIT');
  if(f.intent.budget_fen!==null&&p.amount_fen>f.intent.budget_fen)return card('OVER_BUDGET');
  if(p.payee_key===null)return card('PAYEE_UNREADABLE');
  if(!f.known_payee)return card('NEW_PAYEE');
  if(f.recent_same_payee)return card('SAME_PAYEE_RECENT');
  if(f.stage==='initial'){
    if(!i.verdict||i.verdict.verdict==='unavailable')return card('VOICE_UNAVAILABLE');
    if(i.verdict.verdict!=='pass')return card('INITIATING_NOT_OWNER_VERIFIED');
    return {kind:'auto_pending'};
  }
  if(p.state!=='auto_pending')return {kind:'drop'};
  if(f.now>=p.expires_at_ms)return reject('PAYMENT_EXPIRED',410);
  return {kind:'grant',method:'auto',device_id:i.device_id};
}
/** P1–P7. The authority owns mutation, version increment and cascades after allow. */
export function decideSettings(f:SettingsFacts):Decision {
  if(!phone(f.actor))return reject('PAYMENT_SETTINGS_DEVICE_REQUIRED',403);
  if(f.policy_version!==f.policy.version)return reject('PAYMENT_POLICY_VERSION_STALE',409);
  const c=f.change;
  if(c.kind==='dispute'||((c.kind==='voice'||c.kind==='auto')&&!c.enabled))return {kind:'allow'};
  if(!f.signature_present)return reject('PAYMENT_SIGNATURE_REQUIRED',403);
  if(!f.signature_valid)return reject('PAYMENT_SIGNATURE_INVALID',403);
  const missing:string[]=[];
  if(c.kind==='voice'||c.kind==='auto'){
    if(!f.live_owner)missing.push('VOICEPRINT');
    if(!f.phone_lock)missing.push('PHONE_LOCK');
    if(!f.locks_ok&&f.phone_lock)missing.push('GLASSES_LOCK');
    if(!f.device_keys)missing.push('DEVICE_KEYS');
    if(c.kind==='auto'&&!f.policy.voice_enabled)missing.push('VOICE_PAY');
    if(missing.length)return reject('PAYMENT_PREREQUISITE_MISSING',409,missing);
  }
  if(c.kind==='phone_lock'&&c.enabled&&!f.device_keys)return reject('PAYMENT_PREREQUISITE_MISSING',409,['DEVICE_KEYS']);
  if(c.kind==='limits'&&Object.entries(c).some(([k,v])=>k!=='kind'&&(!Number.isSafeInteger(v)||Number(v)<=0||Number(v)>f.config.limits.max_settable_fen)))return reject('PAYMENT_LIMIT_OUT_OF_RANGE',400);
  if((c.kind==='relock'||c.kind==='phone_lock')&&c.relock_s!==undefined&&!f.config.locks.phone_relock_choices_s.includes(c.relock_s))return reject('PAYMENT_LIMIT_OUT_OF_RANGE',400);
  return {kind:'allow'};
}
