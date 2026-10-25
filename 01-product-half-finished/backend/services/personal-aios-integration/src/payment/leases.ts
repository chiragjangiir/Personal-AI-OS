import {randomUUID} from 'node:crypto';
import {check} from '../contracts.ts';
import {hasTerminalCapability,type RegisteredDevice} from '../source-authority.ts';
import {TerminalCards,type TerminalWearSession} from '../terminal-cards.ts';
import {PaymentKeys,paymentNonce} from './keys.ts';
import {PAYMENT_LIVE_LIMIT} from './wire-budget.ts';
import type {PaymentConfig,LockRow,SignedInput} from './contracts.ts';
import type {PaymentStore} from './store.ts';
export interface PhoneLease {lease_id:string;device_id:string;issued_at:number;foreground:boolean;background_since:number|null;max_until:number}
export type ApprovalKind='glasses_unlock'|'voiceprint_enrol'|'voice_enrollment';
/** voiceprint_enrol: the fixed payment sentences; voice_enrollment: an ordinary conversation supplement on this glasses. */
export type GrantKind=Exclude<ApprovalKind,'glasses_unlock'>;
interface Approval {approval_id:string;kind:ApprovalKind;source:RegisteredDevice;device_label:string;nonce:string;expires_at:number;binding:TerminalWearSession}
interface EnrolmentGrant {expires_at_ms:number;binding:TerminalWearSession}
/** Phone presence and approval authority. Glasses lease ownership remains in TerminalCards. */
export class PaymentLeases {
  private readonly phones=new Map<string,PhoneLease&{source:RegisteredDevice}>();
  private readonly pending=new Map<string,Approval>();
  private readonly grants=new Map<string,EnrolmentGrant>();
  private readonly now:()=>number;
  private readonly options:{store:PaymentStore;keys:PaymentKeys;terminals:TerminalCards;config:PaymentConfig;revalidate:(s:RegisteredDevice)=>Promise<RegisteredDevice>;lock:(s:RegisteredDevice)=>LockRow|undefined;now?:()=>number};
  constructor(options:{store:PaymentStore;keys:PaymentKeys;terminals:TerminalCards;config:PaymentConfig;revalidate:(s:RegisteredDevice)=>Promise<RegisteredDevice>;lock:(s:RegisteredDevice)=>LockRow|undefined;now?:()=>number}) {this.options=options;this.now=options.now??Date.now;}
  private key(s:RegisteredDevice):string {return JSON.stringify([s.principal_id,s.device_id]);}
  private grantKey(s:RegisteredDevice,kind:GrantKind):string {return JSON.stringify([s.principal_id,s.device_id,kind]);}
  private event(s:RegisteredDevice,kind:string,data:Record<string,unknown>,phone=false):void {
    this.options.store.event({at_ms:this.now(),principal_id:s.principal_id,kind,actor:phone?'owner_phone':'authority',device_id:s.device_id,data});
  }
  private async active(s:RegisteredDevice,type?:'phone'|'glasses'):Promise<void> {
    const current=await this.options.revalidate(s);
    check((type===undefined||current.device_type===type)&&(current.device_type!=='phone'||hasTerminalCapability(current,'owner_unlock')),type==='glasses'?'VOICEPRINT_DEVICE_REQUIRED':'PAYMENT_SETTINGS_DEVICE_REQUIRED',403);
  }
  async unlock(source:RegisteredDevice,input:SignedInput):Promise<PhoneLease> {
    await this.active(source,'phone');check(this.options.lock(source)?.enabled,'LOCK_NOT_ENABLED',409);
    const signed=await this.options.keys.verify(source,'phone_unlock',input,{});
    check(this.options.lock(source)?.enabled,'LOCK_NOT_ENABLED',409);
    const lease:PhoneLease={lease_id:`lease-${randomUUID()}`,device_id:source.device_id,issued_at:this.now(),foreground:true,background_since:null,max_until:this.now()+this.options.config.locks.phone_lease_max_s*1000};
    return signed.commit(()=>{this.event(source,'lease_started',{device_id:source.device_id,device_type:'phone',lease_id:lease.lease_id});this.phones.set(this.key(source),{...lease,source});return {...lease};});
  }
  async presence(source:RegisteredDevice,state:'foreground'|'background'|'locked'):Promise<void> {
    await this.active(source,'phone');check(['foreground','background','locked'].includes(state),'PAYMENT_PRESENCE_INVALID');
    if(state==='locked'){this.options.keys.clear(source);this.lock(source,'locked');return;}
    if(!await this.valid(source))return;
    const lease=this.phones.get(this.key(source))!;lease.foreground=state==='foreground';
    if(state==='foreground')lease.background_since=null;
    else if(lease.background_since===null)lease.background_since=this.now();
  }
  async detach(source:RegisteredDevice):Promise<void> {
    if(source.device_type==='phone')await this.presence(source,'background');else {await this.active(source);this.lock(source,'disconnect');}
  }
  async valid(source:RegisteredDevice,at_ms=this.now()):Promise<boolean> {
    await this.active(source);
    return this.validNow(source,at_ms);
  }
  /** Call after source revalidation, inside the same synchronous transaction that issues a grant. */
  validNow(source:RegisteredDevice,at_ms=this.now()):boolean {
    if(!this.options.lock(source)?.enabled){
      if(source.device_type!=='glasses'||this.options.terminals.lease(source))this.lock(source,'disabled');return false;
    }
    if(source.device_type==='glasses'){const lease=this.options.terminals.lease(source);return lease!==undefined&&lease.approved_at<=at_ms&&at_ms<lease.max_until;}
    if(source.device_type!=='phone')return false;
    const lease=this.phones.get(this.key(source));if(!lease)return false;
    const relock=this.options.lock(source)!.relock_s??this.options.config.locks.phone_relock_s;
    if(this.now()>=lease.max_until||!lease.foreground&&this.now()-lease.background_since!>relock*1000){this.lock(source,'expired');return false;}
    return lease.issued_at<=at_ms&&at_ms<lease.max_until&&(lease.foreground||at_ms-lease.background_since!<=relock*1000);
  }
  lock(source:RegisteredDevice,reason:string):void {
    const lease=source.device_type==='glasses'?this.options.terminals.lock(source):this.phones.get(this.key(source));
    if(lease){this.event(source,'lease_ended',{device_id:source.device_id,device_type:source.device_type,lease_id:lease.lease_id,reason});this.phones.delete(this.key(source));}
  }
  private prune(changed=false):void {
    for(const [id,a] of this.pending){
      const binding=changed?this.options.terminals.wearSession(a.source):a.binding;
      if(a.expires_at<=this.now()||!binding||binding.connection!==a.binding.connection||binding.since!==a.binding.since||binding.wear!==a.binding.wear||binding.lock_cycle!==a.binding.lock_cycle)this.pending.delete(id);
    }
  }
  async requestApproval(source:RegisteredDevice,kind:ApprovalKind,device_label=source.device_id,lock_cycle?:number,initial:TerminalWearSession|null=this.options.terminals.wearSession(source)??null):Promise<string> {
    await this.active(source,'glasses');check(kind==='glasses_unlock'||kind==='voiceprint_enrol'||kind==='voice_enrollment','PAYMENT_APPROVAL_KIND_INVALID');
    let binding=this.options.terminals.wearSession(source);check(binding,'GLASSES_NOT_WORN',409);
    check(initial&&initial.connection===binding.connection&&initial.since===binding.since&&initial.wear===binding.wear&&initial.lock_cycle===binding.lock_cycle,'APPROVAL_WEAR_CHANGED',409);
    if(kind==='glasses_unlock'){
      check(lock_cycle!==undefined,'PAYMENT_LOCK_CYCLE_INVALID');
      this.options.terminals.requestCycle(source,lock_cycle);binding=this.options.terminals.wearSession(source)!;
    }
    if(kind==='glasses_unlock')check(this.options.lock(source)?.enabled,'LOCK_NOT_ENABLED',409);
    else if(this.options.lock(source)?.enabled)check(await this.valid(source),'GLASSES_LOCKED',403);
    this.prune(true);
    const own=[...this.pending.values()].filter(a=>a.source.principal_id===source.principal_id);
    check(own.length<PAYMENT_LIVE_LIMIT,'APPROVAL_BUSY',409);
    const approval:Approval={approval_id:`apr-${randomUUID()}`,kind,source,device_label,nonce:paymentNonce(),binding,expires_at:this.now()+(kind==='glasses_unlock'?this.options.config.locks.glasses_unlock_request_ttl_s:this.options.config.enrolment.request_ttl_s)*1000};
    this.event(source,'approval_requested',{approval_id:approval.approval_id,kind,target_device_id:source.device_id});
    this.pending.set(approval.approval_id,approval);return approval.approval_id;
  }
  async approvals(source:RegisteredDevice):Promise<Record<string,unknown>[]> {
    await this.active(source,'phone');this.prune();
    return [...this.pending.values()].filter(a=>a.source.principal_id===source.principal_id).map(a=>({approval_id:a.approval_id,kind:a.kind,target_device_id:a.source.device_id,device_label:a.device_label,expires_in_ms:a.expires_at-this.now(),nonce:a.nonce}));
  }
  /** Leaving enrollment cancels its pending approvals and any grant that beat the cancellation. */
  async cancelApproval(source:RegisteredDevice,kind:GrantKind):Promise<void> {
    await this.active(source,'glasses');
    const pending=[...this.pending.values()].filter(a=>this.key(a.source)===this.key(source)&&a.kind===kind);
    const grant=this.grants.get(this.grantKey(source,kind));
    this.options.store.tx(()=>{
      for(const a of pending)this.event(source,'approval_cancelled',{approval_id:a.approval_id,kind,target_device_id:source.device_id});
      if(grant)this.event(source,'enrolment_grant_consumed',{device_id:source.device_id,kind,expires_at_ms:grant.expires_at_ms});
    });
    for(const a of pending)this.pending.delete(a.approval_id);
    this.grants.delete(this.grantKey(source,kind));
  }
  async decideApproval(source:RegisteredDevice,input:SignedInput&{approval_id:string;decision:'approve'|'deny'}):Promise<void> {
    await this.active(source,'phone');const a=this.pending.get(input.approval_id);
    check(a&&a.source.principal_id===source.principal_id,'APPROVAL_NOT_FOUND',404);
    check(a.expires_at>this.now(),'APPROVAL_EXPIRED',410);
    check(input.decision==='approve'||input.decision==='deny','PAYMENT_APPROVAL_DECISION_INVALID');
    const apply=()=>{
      check(this.pending.get(a.approval_id)===a,'APPROVAL_NOT_FOUND',404);
      check(a.expires_at>this.now(),'APPROVAL_EXPIRED',410);
      const approving=input.decision==='approve',binding=this.options.terminals.wearSession(a.source);
      if(approving)check(binding&&binding.connection===a.binding.connection&&binding.since===a.binding.since&&binding.wear===a.binding.wear&&binding.lock_cycle===a.binding.lock_cycle,'APPROVAL_WEAR_CHANGED',409);
      if(approving&&a.kind==='glasses_unlock')check(this.options.lock(a.source)?.enabled,'LOCK_NOT_ENABLED',409);
      const lease_id=`lease-${randomUUID()}`,expires_at_ms=this.now()+this.options.config.enrolment.grant_ttl_s*1000;
      this.options.store.tx(()=>{
        if(approving&&a.kind==='glasses_unlock')this.event(a.source,'lease_started',{device_id:a.source.device_id,device_type:'glasses',lease_id});
        if(approving&&a.kind!=='glasses_unlock')this.event(a.source,'enrolment_grant_issued',{device_id:a.source.device_id,kind:a.kind,expires_at_ms});
        this.event(source,'approval_decided',{approval_id:a.approval_id,kind:a.kind,target_device_id:a.source.device_id,decision:input.decision},true);
      });
      if(approving&&a.kind==='glasses_unlock')this.options.terminals.grantLease(a.source,a.binding,this.now()+this.options.config.locks.glasses_lease_max_s*1000,lease_id);
      if(approving&&a.kind!=='glasses_unlock')this.grants.set(this.grantKey(a.source,a.kind),{expires_at_ms,binding:a.binding});
      this.pending.delete(a.approval_id);
    };
    if(input.decision==='deny'){apply();return;}
    const signed=await this.options.keys.verify(source,'approval',input,{approval_id:a.approval_id,kind:a.kind,target_device_id:a.source.device_id,decision:'approve'},a.nonce);
    await this.active(a.source,'glasses');
    if(a.kind!=='glasses_unlock'&&this.options.lock(a.source)?.enabled)check(await this.valid(a.source),'GLASSES_LOCKED',403);
    signed.commit(apply);
  }
  async enrolment(source:RegisteredDevice,requireLive=false,kind:GrantKind='voiceprint_enrol'):Promise<{expires_at_ms:number}|undefined> {
    await this.active(source,'glasses');this.prune();const grant=this.grants.get(this.grantKey(source,kind));
    if(!grant)return undefined;
    if(grant.expires_at_ms<=this.now()){check(!requireLive,'VOICEPRINT_ENROL_GRANT_EXPIRED',410);return undefined;}
    const binding=this.options.terminals.wearSession(source);
    if(!binding||binding.connection!==grant.binding.connection||binding.wear!==grant.binding.wear)return undefined;
    if(this.options.lock(source)?.enabled&&!await this.valid(source))return undefined;
    return {expires_at_ms:grant.expires_at_ms};
  }
  async consumeEnrolment(source:RegisteredDevice,status:string,kind:GrantKind='voiceprint_enrol'):Promise<void> {
    const grant=await this.enrolment(source,true,kind);check(grant,'VOICEPRINT_ENROL_GRANT_EXPIRED',410);
    if(status==='enrolled'||status==='discarded'){this.event(source,'enrolment_grant_consumed',{device_id:source.device_id,kind,expires_at_ms:grant.expires_at_ms});this.grants.delete(this.grantKey(source,kind));}
  }
  nextDeadline():number|undefined {
    const deadlines=[...this.pending.values()].map(a=>a.expires_at).concat([...this.grants.values()].filter(g=>g.expires_at_ms>this.now()).map(g=>g.expires_at_ms));
    for(const lease of this.phones.values()){
      const relock=this.options.lock(lease.source)?.relock_s??this.options.config.locks.phone_relock_s;
      deadlines.push(Math.min(lease.max_until,lease.foreground?Infinity:lease.background_since!+relock*1000+1));
    }
    return deadlines.length?Math.min(...deadlines):undefined;
  }
  sweep():void {
    this.prune();
    for(const lease of this.phones.values()){
      const relock=this.options.lock(lease.source)?.relock_s??this.options.config.locks.phone_relock_s;
      if(this.now()>=lease.max_until||!lease.foreground&&this.now()-lease.background_since!>relock*1000)this.lock(lease.source,'expired');
    }
  }
  clear(source?:RegisteredDevice,reason='revoked'):void {
    if(!source){this.phones.clear();this.pending.clear();this.grants.clear();return;}
    this.lock(source,reason);
    for(const kind of ['voiceprint_enrol','voice_enrollment'] as const)this.grants.delete(this.grantKey(source,kind));
    for(const [id,a] of this.pending)if(this.key(a.source)===this.key(source))this.pending.delete(id);
  }
}
