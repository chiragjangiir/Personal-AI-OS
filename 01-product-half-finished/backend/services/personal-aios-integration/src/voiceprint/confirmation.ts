import { canonical, check, ContractError, digest, type ProcessedEvent } from '../contracts.ts';
import type {TerminalCapability} from '../source-authority.ts';
import type { StoragePort } from '../storage.ts';
import type {NativeApproval,NativeApprovalResult,OwnerConfirmation} from '../hermes-client.ts';
import type {FrozenCall} from '../capability/consent/call.ts';

export interface CapabilityUpgradeRequest {
  principal_id:string; device_id:string; capabilities:readonly TerminalCapability[]; grant_ref:Record<string,unknown>;
}
export interface VoiceConfirmation {
  schema: 'paios.voice-confirmation.v1'; confirmation_id: string; principal_id: string; session_id: string;
  processed_event_id: string; source_device_id: string; created_at_ms: number; expires_at_ms: number;
  kind?:'native_approval'|'capability_upgrade'|'capability_call'; capability_upgrade?:CapabilityUpgradeRequest; native_run_id?:string; approval_request_id?:string; text?:string;
  capability_call?:FrozenCall;
}
export interface VoiceConfirmationDecision {
  schema: 'paios.voice-confirmation-decision.v1'; confirmation_id: string; device_id: string; confirmed_at: string;
  choice?:'once'|'deny'; reason?:NativeApprovalResult['reason']; source?:'native'; confirmation?:OwnerConfirmation;
}

/** The durable id of one native approval card and its decision record. */
export const nativeApprovalId=(principal_id:string,run_id:string,request_id:string)=>digest({principal_id,run_id,request_id});

/** "确认是我" for an owner_uncertain voice request: one durable record per (principal, D) with a bounded TTL, and a
 *  first-winner decision so one confirmation re-admits the request exactly once. A newer identity prompt
 *  withdraws the previous one in the same conversation. The in-memory index only serves the
 *  phone's pending list (and its watchers, told of every change: open, decision, expiry); a restart forgets the list,
 *  never a record or a decision. */
export class VoiceConfirmations {
  private readonly storage: StoragePort; private readonly ttlMs: number; private readonly maxPending: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, VoiceConfirmation>();
  private readonly waiting = new Map<string, (approved:boolean)=>void>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private opening: Promise<void> = Promise.resolve();
  private callExpiry:((record:VoiceConfirmation)=>Promise<void>)|undefined;
  setCallExpiryHandler(handler:((record:VoiceConfirmation)=>Promise<void>)|undefined):void {this.callExpiry=handler;this.schedule();}
  callExpired(record:VoiceConfirmation):boolean {return record.expires_at_ms<=this.now();}
  constructor(storage: StoragePort, options: {ttl_ms?: number; max_pending?: number; now?: () => number} = {}) {
    this.storage = storage; this.ttlMs = options.ttl_ms ?? 120000; this.maxPending = options.max_pending ?? 64;
    this.now = options.now ?? Date.now;
    check(Number.isSafeInteger(this.ttlMs) && this.ttlMs > 0 && this.ttlMs <= 3600000 &&
      Number.isSafeInteger(this.maxPending) && this.maxPending > 0, 'VOICE_CONFIRMATION_POLICY_INVALID');
  }
  private async read<T>(namespace: string, key: string): Promise<T | undefined> {
    try { return JSON.parse(Buffer.from(await this.storage.read(namespace, key)).toString('utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  /** Expired records leave the list; their principals' watchers hear about it. */
  private prune(at: number): void {
    const gone = new Set<string>();
    for (const [key, record] of this.pending) if (record.expires_at_ms <= at) {this.pending.delete(key); this.waiting.get(key)?.(false); gone.add(record.principal_id);
      if(record.kind==='capability_call')void this.callExpiry?.(record).catch(()=>{});}
    for (const principal of gone) this.changed(principal);
  }
  private changed(principal: string): void {
    for (const watcher of this.watchers.get(principal) ?? []) {try {watcher();} catch { /* a watcher's failure is its own */ }}
  }
  /** One timer for the earliest expiry while anyone watches, so a prompt disappears when it can no longer be answered. */
  private schedule(): void {
    if (this.expiry) {clearTimeout(this.expiry); this.expiry = undefined;}
    if ((!this.watchers.size&&!this.waiting.size&&!this.callExpiry) || !this.pending.size) return;
    const next = Math.min(...[...this.pending.values()].map(record => record.expires_at_ms));
    this.expiry = setTimeout(() => {this.expiry = undefined; this.prune(this.now()); this.schedule();}, Math.max(0, next - this.now()) + 5);
    this.expiry.unref?.();
  }
  /** `changed` runs (read `list`) whenever this principal's pending set changes. Returns the unsubscribe. */
  watch(principal: string, changed: () => void): () => void {
    const set = this.watchers.get(principal) ?? new Set<() => void>();
    set.add(changed); this.watchers.set(principal, set); this.schedule();
    return () => {set.delete(changed); if (!set.size && this.watchers.get(principal) === set) this.watchers.delete(principal); this.schedule();};
  }
  close(): void {for(const finish of this.waiting.values())finish(false);this.watchers.clear(); this.schedule();}
  /** A live call retains its candidate, not another admission. Expiry, eviction and hang-up settle observation-only. */
  async wait(d:ProcessedEvent,session:string,signal:AbortSignal):Promise<boolean> {
    if(signal.aborted)return false;
    const key=digest({principal_id:d.principal_id,processed_event_id:d.processed_event_id});
    const result=Promise.withResolvers<boolean>();
    const finish=(approved:boolean)=>{this.waiting.delete(key);signal.removeEventListener('abort',cancel);
      const record=this.pending.get(key);if(this.pending.delete(key)&&record)this.changed(record.principal_id);
      this.schedule();result.resolve(approved);};
    const cancel=()=>finish(false);
    this.waiting.set(key,finish);signal.addEventListener('abort',cancel,{once:true});
    try {
      await this.open(d,session,undefined,signal);
      if(signal.aborted)finish(false);
      else {const decision=await this.read<VoiceConfirmationDecision>('voice-confirmation-decisions',key);
        if(decision)finish(decision.choice!=='deny');}
      return await result.promise;
    } finally {if(this.waiting.get(key)===finish)finish(false);}
  }
  live(confirmationId:string):boolean {this.prune(this.now());return this.waiting.has(confirmationId);}
  open(d: ProcessedEvent, session: string, text?:string, signal?:AbortSignal): Promise<VoiceConfirmation> {
    const opened=this.opening.then(()=>this.openIdentity(d,session,text,signal));
    // Serialize publication so slow storage cannot put an older prompt back after its replacement.
    this.opening=opened.then(()=>{},()=>{});
    return opened;
  }
  private async withdraw(record:VoiceConfirmation,reason?:NativeApprovalResult['reason']):Promise<void> {
    const decision:VoiceConfirmationDecision={schema:'paios.voice-confirmation-decision.v1',confirmation_id:record.confirmation_id,
      device_id:record.source_device_id,confirmed_at:new Date(this.now()).toISOString(),choice:'deny',...(reason?{reason}:{})};
    await this.storage.publish('voice-confirmation-decisions',record.confirmation_id,Buffer.from(canonical(decision)));
    this.pending.delete(record.confirmation_id);this.waiting.get(record.confirmation_id)?.(false);
    this.changed(record.principal_id);this.schedule();
    if(record.kind==='capability_call')await this.callExpiry?.(record);
  }
  async cancelCalls(principal:string,processedEventId:string):Promise<void>{
    for(const record of this.pending.values())if(record.kind==='capability_call'&&record.principal_id===principal&&
      record.processed_event_id===processedEventId)await this.withdraw(record,'interrupted');
  }
  private async openIdentity(d: ProcessedEvent, session: string, text?:string, signal?:AbortSignal): Promise<VoiceConfirmation> {
    const at = this.now(), confirmation_id = digest({principal_id: d.principal_id, processed_event_id: d.processed_event_id});
    const proposed: VoiceConfirmation = {schema: 'paios.voice-confirmation.v1', confirmation_id, principal_id: d.principal_id,
      session_id: session, processed_event_id: d.processed_event_id, source_device_id: d.device_id, created_at_ms: at, expires_at_ms: at + this.ttlMs,...(text?{text}:{})};
    const saved = JSON.parse(Buffer.from(await this.storage.publish('voice-confirmations', confirmation_id,
      Buffer.from(canonical(proposed)))).toString('utf8')) as VoiceConfirmation;
    check(saved.principal_id === d.principal_id && saved.processed_event_id === d.processed_event_id && saved.session_id === session,
      'VOICE_CONFIRMATION_CONFLICT', 409);
    if(signal?.aborted||await this.read('voice-confirmation-decisions',confirmation_id))return saved;
    this.prune(at);
    for(const record of this.pending.values())if(!record.kind&&record.confirmation_id!==confirmation_id&&
      record.principal_id===d.principal_id&&record.session_id===session)await this.withdraw(record);
    if(signal?.aborted)return saved;
    if (!this.pending.has(confirmation_id) && saved.expires_at_ms > at) {
      if (this.pending.size >= this.maxPending) {
        const evicted = this.pending.keys().next().value!, principal = this.pending.get(evicted)!.principal_id;
        this.pending.delete(evicted); this.waiting.get(evicted)?.(false); this.changed(principal);
      }
      this.pending.set(confirmation_id, saved); this.changed(saved.principal_id); this.schedule();
    }
    return saved;
  }
  list(principal: string): VoiceConfirmation[] {
    this.prune(this.now());
    return [...this.pending.values()].filter(record => record.principal_id === principal).map(record => ({...record}));
  }
  private async approvalRecord(d:ProcessedEvent,session:string,runId:string,approval:NativeApproval,call?:FrozenCall):Promise<VoiceConfirmation> {
    const confirmation_id=nativeApprovalId(d.principal_id,runId,approval.request_id);
    const proposed:VoiceConfirmation={schema:'paios.voice-confirmation.v1',confirmation_id,principal_id:d.principal_id,
      session_id:session,processed_event_id:d.processed_event_id,source_device_id:d.device_id,created_at_ms:this.now(),
      expires_at_ms:approval.expires_at_ms,kind:call?'capability_call':'native_approval',native_run_id:runId,approval_request_id:approval.request_id,text:approval.question,
      ...(call?{capability_call:call}:{})};
    const record=JSON.parse(Buffer.from(await this.storage.publish('voice-confirmations',confirmation_id,Buffer.from(canonical(proposed)))).toString('utf8')) as VoiceConfirmation;
    check(record.kind===proposed.kind&&record.native_run_id===runId&&record.approval_request_id===approval.request_id&&record.principal_id===d.principal_id&&
      record.processed_event_id===d.processed_event_id&&record.session_id===session&&record.text===approval.question&&
      record.expires_at_ms===approval.expires_at_ms&&(!call||canonical(record.capability_call)===canonical(call)),'VOICE_CONFIRMATION_CONFLICT',409);
    return record;
  }
  async openApproval(d:ProcessedEvent,session:string,runId:string,approval:NativeApproval):Promise<boolean> {
    const record=await this.approvalRecord(d,session,runId,approval);
    if(record.expires_at_ms<=this.now()||this.pending.has(record.confirmation_id)||
      await this.read('voice-confirmation-decisions',record.confirmation_id))return false;
    this.pending.set(record.confirmation_id,record);this.changed(record.principal_id);this.schedule();return true;
  }
  /** Uses the same card, TTL and first-winner store as native approval, without a native wait. */
  async openCall(call:FrozenCall,requestId:string,question:string):Promise<VoiceConfirmation> {
    const key=nativeApprovalId(call.admission.d.principal_id,call.consent.context.run_id,requestId);
    const prior=await this.read<VoiceConfirmation>('voice-confirmations',key);
    const record=await this.approvalRecord(call.admission.d,call.consent.context.session_id,call.consent.context.run_id,
      {request_id:requestId,question,expires_at_ms:prior?.expires_at_ms??this.now()+this.ttlMs},call);
    if(!await this.read('voice-confirmation-decisions',key)){
      if(record.expires_at_ms<=this.now())await this.callExpiry?.(record);
      else {this.pending.set(key,record);this.changed(record.principal_id);this.schedule();}
    }
    return record;
  }
  async expireCall(record:VoiceConfirmation):Promise<VoiceConfirmationDecision> {
    check(record.kind==='capability_call'&&record.expires_at_ms<=this.now(),'VOICE_CONFIRMATION_NOT_EXPIRED',409);
    return JSON.parse(Buffer.from(await this.storage.publish('voice-confirmation-decisions',record.confirmation_id,Buffer.from(canonical({
      schema:'paios.voice-confirmation-decision.v1',confirmation_id:record.confirmation_id,device_id:record.source_device_id,
      confirmed_at:new Date(this.now()).toISOString(),choice:'deny',reason:'timeout'})))).toString());
  }
  async openCapabilityUpgrade(request:CapabilityUpgradeRequest,text:string):Promise<{
    record:VoiceConfirmation; approved:boolean; opened:boolean;
  }|undefined> {
    const at=this.now(),confirmation_id=digest({kind:'capability_upgrade',...request});
    const decided=await this.read<VoiceConfirmationDecision>('voice-confirmation-decisions',confirmation_id);
    if(decided?.choice==='deny')return undefined;
    if(decided)return {record:(await this.read<VoiceConfirmation>('voice-confirmations',confirmation_id))!,approved:true,opened:false};
    const proposed:VoiceConfirmation={schema:'paios.voice-confirmation.v1',confirmation_id,principal_id:request.principal_id,
      session_id:`capability-upgrade:${confirmation_id}`,processed_event_id:`capability-upgrade:${confirmation_id}`,
      source_device_id:request.device_id,created_at_ms:at,expires_at_ms:at+this.ttlMs,
      kind:'capability_upgrade',capability_upgrade:request,text};
    let record=await this.read<VoiceConfirmation>('voice-confirmations',confirmation_id);
    if(!record)record=JSON.parse(Buffer.from(await this.storage.publish('voice-confirmations',confirmation_id,
      Buffer.from(canonical(proposed)))).toString('utf8')) as VoiceConfirmation;
    const renewed=record.expires_at_ms<=at;
    if(renewed){record={...record,created_at_ms:at,expires_at_ms:at+this.ttlMs};
      await this.storage.replace!('voice-confirmations',confirmation_id,Buffer.from(canonical(record)));}
    const decision=await this.read<VoiceConfirmationDecision>('voice-confirmation-decisions',confirmation_id);
    if(decision?.choice==='deny')return undefined;
    if(decision)return {record,approved:true,opened:false};
    this.prune(at);
    const opened=renewed||!this.pending.has(confirmation_id);
    if(opened){
      if(this.pending.size>=this.maxPending){
        const evicted=this.pending.keys().next().value!,principal=this.pending.get(evicted)!.principal_id;
        this.pending.delete(evicted);this.waiting.get(evicted)?.(false);this.changed(principal);
      }
      this.pending.set(confirmation_id,record);this.changed(record.principal_id);this.schedule();
    }
    return {record,approved:!!decision,opened};
  }
  completeCapabilityUpgrade(record:VoiceConfirmation):void {
    if(this.pending.delete(record.confirmation_id)){this.changed(record.principal_id);this.schedule();}
  }
  async settleApproval(d:ProcessedEvent,session:string,runId:string,result:NativeApprovalResult):Promise<void> {
    const record=await this.approvalRecord(d,session,runId,result);
    const proposed:VoiceConfirmationDecision={schema:'paios.voice-confirmation-decision.v1',confirmation_id:record.confirmation_id,
      device_id:result.confirmation?.surface.device_id??record.source_device_id,
      confirmed_at:result.confirmation?.confirmed_at??new Date(this.now()).toISOString(),source:'native',choice:result.choice,reason:result.reason,
      ...(result.confirmation?{confirmation:result.confirmation}:{})};
    const saved=JSON.parse(Buffer.from(await this.storage.publish('voice-confirmation-decisions',record.confirmation_id,
      Buffer.from(canonical(proposed)))).toString('utf8')) as VoiceConfirmationDecision;
    check(saved.choice===result.choice&&saved.reason===result.reason,'VOICE_CONFIRMATION_CONFLICT',409);
    if(this.pending.delete(record.confirmation_id)){this.changed(record.principal_id);this.schedule();}
  }
  async record(confirmationId:unknown,principal:string):Promise<VoiceConfirmation> {
    check(typeof confirmationId==='string'&&/^[a-f0-9]{64}$/u.test(confirmationId),'VOICE_CONFIRMATION_ID_INVALID');
    const record=await this.read<VoiceConfirmation>('voice-confirmations',confirmationId);
    if(!record)throw new ContractError('VOICE_CONFIRMATION_NOT_FOUND',404);
    check(record.confirmation_id===confirmationId&&record.principal_id===principal,'VOICE_CONFIRMATION_SCOPE_DENIED',403);
    return record;
  }
  /** The confirming device's tap. Expired and foreign records are refused; a repeat by the same device replays. */
  async decide(confirmationId: unknown, device: {principal_id: string; device_id: string;device_type?:string},choice:'approve'|'deny'='approve'):
    Promise<{record: VoiceConfirmation; decision: VoiceConfirmationDecision}> {
    const record = await this.record(confirmationId,device.principal_id);
    check(!record.kind||record.kind==='capability_upgrade'||record.kind==='capability_call','VOICE_CONFIRMATION_KIND_INVALID');
    const key=record.confirmation_id;
    let decision = await this.read<VoiceConfirmationDecision>('voice-confirmation-decisions', key);
    if (!decision) {
      const at = this.now();
      check(at < record.expires_at_ms, 'VOICE_CONFIRMATION_EXPIRED', 410);
      const proposed: VoiceConfirmationDecision = {schema: 'paios.voice-confirmation-decision.v1', confirmation_id: key,
        device_id: device.device_id, confirmed_at: new Date(at).toISOString(),...(choice==='deny'?{choice:'deny' as const}:{}),
        ...(record.kind==='capability_call'?{confirmation:{confirmation_id:key,confirmed_by:device.principal_id,
          surface:{device_id:device.device_id,device_type:device.device_type!},confirmed_at:new Date(at).toISOString()}}:{})};
      decision = JSON.parse(Buffer.from(await this.storage.publish('voice-confirmation-decisions', key,
        Buffer.from(canonical(proposed)))).toString('utf8')) as VoiceConfirmationDecision;
    }
    check(decision.device_id === device.device_id, 'VOICE_CONFIRMATION_ALREADY_DECIDED', 409);
    check((decision.choice==='deny')===(choice==='deny'),'VOICE_CONFIRMATION_ALREADY_DECIDED',409);
    if ((record.kind!=='capability_upgrade'||choice==='deny')&&this.pending.delete(key)) {this.changed(record.principal_id); this.schedule();}
    this.waiting.get(key)?.(choice==='approve');
    return {record, decision};
  }
}
