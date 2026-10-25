import type {Receipt} from '../../../../../../../capability/sdk/ts/receipt.ts';

export interface ReceiptContext {principal_id:string;run_id?:string;origin_processed_event_id?:string;job_id?:string}
export interface PendingFacts {receipts:Receipt[];fact_ids:string[];text:string;voice:string}
/** Implemented by the gateway's single ledger/renderer, including rendered/played delivery acknowledgements. */
export interface PhoneGatewayPort {
  enabled(packageId:string):boolean;
  record(context:ReceiptContext,receipt:unknown):Promise<void>;
  pending(context:ReceiptContext,jobIds:string[]):Promise<PendingFacts>;
}
export interface SelfCheckRequest {
  id:string;principal_id:string;source:'errand';failed_card:string;title:string;
  origin_processed_event_id?:string;evidence_ref:{tool:'phone_status';job_id:string};
  message_role:'system';owner_requested:false;
}
/** ensure uses the existing schedule/source authority's durable idempotency key. It must survive restarts. */
export interface PhoneSelfCheckPort {ensure(request:SelfCheckRequest):Promise<void>}
export interface PhoneReceiptJob {
  principal_id:string;job_id:string;capability_receipt?:unknown;origin_processed_event_id?:string;
  self_check_of?:string;title?:string;success?:boolean;terminal_reason?:string;
}

/** Policy only: task state, admission, authorization, novelty and delivery remain with their existing authorities. */
export class PhoneReceiptLifecycle {
  private readonly gateway:PhoneGatewayPort;
  private readonly selfChecks:PhoneSelfCheckPort;
  constructor(gateway:PhoneGatewayPort,selfChecks:PhoneSelfCheckPort){this.gateway=gateway;this.selfChecks=selfChecks;}
  enabled(){return this.gateway.enabled('phone');}
  async observe(job:PhoneReceiptJob,origin:string):Promise<void>{
    if(!this.enabled()||!job.capability_receipt)return;
    await this.gateway.record({principal_id:job.principal_id,origin_processed_event_id:origin,job_id:job.job_id},job.capability_receipt);
    if(job.success===false&&!job.self_check_of&&job.terminal_reason!=='cancelled_by_user')
      await this.failedCard(job,origin);
  }
  async failedCard(job:PhoneReceiptJob,origin:string):Promise<void>{
    if(!this.enabled()||job.self_check_of||job.terminal_reason==='cancelled_by_user')return;
    await this.selfChecks.ensure({id:`${job.job_id}:0`,principal_id:job.principal_id,source:'errand',failed_card:job.job_id,
      title:job.title??'检查未完成的任务',origin_processed_event_id:origin,
      evidence_ref:{tool:'phone_status',job_id:job.job_id},message_role:'system',owner_requested:false});
  }
  async context(context:ReceiptContext,jobIds:string[]){
    const facts=await this.gateway.pending(context,[...new Set(jobIds)]);
    return {receipt_facts:facts};
  }
}
