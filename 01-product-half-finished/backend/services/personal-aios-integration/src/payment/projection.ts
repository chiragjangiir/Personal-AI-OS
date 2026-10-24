import {check} from '../contracts.ts';
import {TERMINAL_STATES,type Payment,type PaymentConfig,type Limits,type PaymentPolicy} from './contracts.ts';
import type {PaymentStore} from './store.ts';
import {packPaymentItems,PAYMENT_ENVELOPE_ID,recordMetadataCaps,type PaymentFrame} from './wire-budget.ts';
export interface Methods {voice:{available:boolean;reason?:string;tries_left:number};auto:{available:boolean;reason?:string}}
const shownReasons=new Set(['INITIATING_NOT_VOICE','INITIATING_NOT_OWNER_VERIFIED','DIFFERENT_TERMINAL','TERMINAL_LOCKED','REQUEST_STALE','OVER_AUTO_LIMIT','OVER_AUTO_DAY_LIMIT','OVER_VOICE_LIMIT','OVER_BUDGET','NEW_PAYEE','PAYEE_UNREADABLE','SAME_PAYEE_RECENT','AUTO_PAUSED','VOICE_NOT_RECOGNIZED','VOICE_INSUFFICIENT','VOICE_ATTEMPTS_EXHAUSTED','VOICE_UNAVAILABLE','AMOUNT_CHANGED','AUTO_INTERRUPTED']);
const remaining=(deadline:number,now:number)=>Math.max(0,deadline-now);
const terminal=(store:PaymentStore,p:Payment)=>{
  const g=store.getGrant(p.payment_id);if(!g)return undefined;
  if(g.method==='card')return 'phone';
  const initiating=store.getIntent(p.intent_id)!.initiating;
  if(g.device_id===initiating.device_id&&(initiating.device_type==='phone'||initiating.device_type==='glasses'))return initiating.device_type;
  const event=store.events(p.payment_id).find(e=>e.kind==='decision_received'&&e.device_id===g.device_id);
  return event?.actor==='owner_glasses'?'glasses':event?.actor==='owner_phone'?'phone':undefined;
};
/** A7 cards expose no grant or scores. The only nonce is the paired phone's decision nonce. */
export function cardProjection(store:PaymentStore,p:Payment,now:number,methods:Methods,used:number):Record<string,unknown>{
  const decidable=['awaiting_owner','auto_pending','verifying'].includes(p.state),notice=p.notice??(p.reason&&shownReasons.has(p.reason)?{reason:p.reason}:undefined);
  const device=terminal(store,p);
  return {payment_id:p.payment_id,intent_id:p.intent_id,version:p.version,state:p.state,amount_fen:p.amount_fen,app:p.app,items:p.items,
    ...(p.payee?{payee:p.payee}:{}),...(p.payee_key?{payee_key:p.payee_key}:{}),...(p.delivery?{delivery:p.delivery}:{}),expires_in_ms:remaining(p.expires_at_ms,now),
    ...(p.state==='auto_pending'&&p.auto_at_ms!==null?{auto_in_ms:remaining(p.auto_at_ms,now)}:{}),...(decidable?{decision_nonce:p.decision_nonce}:{}),methods,
    ...(notice?{notice}:{}),...(p.finished_at_ms!==null?{result:{...(p.method?{method:p.method}:{}),...(device?{terminal:device}:{}),...(p.order_cancel?{order_cancel:p.order_cancel}:{}),finished_ago_ms:remaining(now,p.finished_at_ms)}}:{}),today_auto_used_fen:used};
}
export function noticeProjection(p:Payment|undefined,now:number,locked:boolean,methods?:Methods):Record<string,unknown>|null{
  if(!p)return null;
  if(locked)return {payment_id:p.payment_id,state:p.state,reason:'TERMINAL_LOCKED',expires_in_ms:remaining(p.expires_at_ms,now)};
  return {payment_id:p.payment_id,state:p.state,amount_fen:p.amount_fen,...(p.payee?{payee:p.payee}:{}),...(p.items.length?{line:Array.from(p.items.join('、')).slice(0,40).join('')}:{}),
    voice_hint:methods?.voice.available??false,...(p.reason&&shownReasons.has(p.reason)&&p.reason!=='TERMINAL_LOCKED'?{reason:p.reason}:{}),expires_in_ms:remaining(p.expires_at_ms,now)};
}
export function settingsProjection(input:{policy:PaymentPolicy;config:PaymentConfig;limits:Limits;used:number;phone:{enabled:boolean;unlocked:boolean;relock_s:number};
  glasses:{paired:boolean;device_id?:string;enabled:boolean;unlocked:boolean;worn:boolean};owner:{phone_app:boolean;glasses:boolean};keys:{device:boolean;user:boolean;registered_at?:string};missing:string[]}):Record<string,unknown>{
  const {policy:p,config:c}=input;
  return {wire_version:1,policy_version:p.version,voice_enabled:p.voice_enabled,auto_enabled:p.auto_enabled,...(p.paused_until_ms!==null?{paused_until:new Date(p.paused_until_ms).toISOString()}:{}),
    limits:input.limits,limit_max_fen:c.limits.max_settable_fen,today_auto_used_fen:input.used,locks:{phone:{...input.phone,relock_choices_s:c.locks.phone_relock_choices_s},glasses:input.glasses},
    voiceprint:input.owner,keys:input.keys,prerequisites:{voice:input.missing,auto:[...input.missing,...(!p.voice_enabled?['VOICE_PAY']:[])]}};
}
function recordItem(store:PaymentStore,p:Payment):Record<string,unknown>{const device=terminal(store,p);
  return {payment_id:p.payment_id,at:new Date(p.created_at_ms).toISOString(),app:p.app,...(p.payee?{payee:p.payee}:{}),summary:Array.from(p.items.join('、')).slice(0,400).join('')||p.app,
    amount_fen:p.amount_fen,state:p.state,...(p.method?{method:p.method}:{}),...(device?{terminal:device}:{})};}
export function recordsProjection(store:PaymentStore,principal:string,before?:string,limit=50,frame:PaymentFrame={}):Record<string,unknown>{
  let cursor:readonly [number,string]|undefined;
  if(before!==undefined){
    check(typeof before==='string'&&before.length<=128&&/^[A-Za-z0-9_-]+$/.test(before),'FORMAL_PAYMENT_INPUT_INVALID');
    let decoded:unknown;
    try{decoded=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{check(false,'FORMAL_PAYMENT_INPUT_INVALID');}
    check(Array.isArray(decoded)&&decoded.length===2&&Number.isSafeInteger(decoded[0])&&typeof decoded[1]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(decoded[1])&&
      Buffer.from(JSON.stringify(decoded)).toString('base64url')===before,'FORMAL_PAYMENT_INPUT_INVALID');
    cursor=decoded as [number,string];
  }
  check(Number.isSafeInteger(limit)&&limit>=1&&limit<=50,'FORMAL_PAYMENT_INPUT_INVALID');
  const payments=store.principalPayments(principal,cursor);
  const candidates=payments.slice(0,limit).map(p=>recordItem(store,p));
  const shape=(items:Record<string,unknown>[])=>{
    const last=payments[items.length-1];
    return {items,...(payments.length>items.length&&last?{next_before:Buffer.from(JSON.stringify([last.created_at_ms,last.payment_id])).toString('base64url')}:{})};
  };
  const page=packPaymentItems(candidates,items=>({operation:'payment_records',request_id:frame.request_id??PAYMENT_ENVELOPE_ID,...shape(items)}),frame.session_id);
  return shape(page);
}
const PUBLIC_EVENT_KEYS=new Set(['reason','state','method','decision','amount_fen','old_amount_fen','read_amount_fen','payee','items','outcome','detail','verdict','tries_left','change_kind','signed','enabled','relock_s','cause','turned_off','until_ms','kind']);
export function recordProjection(store:PaymentStore,principal:string,id:string,frame:PaymentFrame={},before_seq?:number):Record<string,unknown>{
  check(before_seq===undefined||(Number.isSafeInteger(before_seq)&&before_seq>=1),'FORMAL_PAYMENT_INPUT_INVALID');
  const p=store.getPayment(id);check(p&&p.principal_id===principal,'PAYMENT_RECORD_NOT_FOUND',404);const i=store.getIntent(p.intent_id)!;
  const payment={...recordItem(store,p),intent_id:p.intent_id,...(i.initiating_text?{initiating_text:i.initiating_text}:{}),...(p.order_cancel?{order_cancel:p.order_cancel}:{})};
  const source=store.recordEvents(id,before_seq);
  const events=source.slice(0,64).map(event=>({seq:event.seq,at:new Date(event.at_ms).toISOString(),kind:event.kind,
    ...(event.actor==='owner_phone'?{terminal:'phone'}:event.actor==='owner_glasses'?{terminal:'glasses'}:{}),
    data:Object.fromEntries(Object.entries(event.data).filter(([k])=>PUBLIC_EVENT_KEYS.has(k)).map(([key,value])=>
      [key,typeof value==='string'&&recordMetadataCaps[key]!==undefined?Array.from(value).slice(0,recordMetadataCaps[key]).join(''):value]))}));
  const shape=(entries:typeof events)=>({payment,timeline:entries.map(({seq,...entry})=>entry),...(source.length>entries.length&&entries.length?{next_seq:entries.at(-1)!.seq}:{})});
  const timeline=packPaymentItems(events,entries=>({operation:'payment_record',request_id:frame.request_id??PAYMENT_ENVELOPE_ID,...shape(entries)}),frame.session_id);
  const page=shape(timeline);page.timeline.reverse();return page;
}
