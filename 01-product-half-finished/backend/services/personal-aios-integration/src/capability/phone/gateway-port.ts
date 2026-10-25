import {check} from '../../contracts.ts';
import type {Receipt} from '../../../../../../../capability/sdk/ts/receipt.ts';
import type {PhoneGatewayPort,ReceiptContext} from './lifecycle.ts';

interface Binding {principal_id:string;run_id:string}
interface Fact {id:string;text:string;voice:string}
/** Structural subset of P1's ledger. No additional receipt, job, delivery or novelty store. */
export interface LedgerPort {
  admit(binding:Binding,call:{task_id:string;tool_call_id:string;tool_name:string;args:object},raw:unknown):Promise<unknown>;
  records(binding:Binding):Promise<{receipt:Receipt}[]>;
  novel(principal:string,facts:Fact[]):Promise<Fact[]>;
}
export interface PhoneGatewayBindings {
  enabled(packageId:string):boolean;
  ledger:LedgerPort;
  snapshotTool:string;
  /** Resolve protected errand-origins and admission, never executor-supplied run/principal fields. */
  jobRun(principal:string,jobId:string):Promise<Binding>;
  /** Link already-admitted snapshots into the reporting run in the same ledger; never admit or store them twice. */
  carry(binding:Binding,receipts:Receipt[]):Promise<void>;
  receiptFacts(receipts:Receipt[]):Fact[];
  renderFacts(facts:Fact[],outlet:'text'|'voice'):string;
}
/** Snapshot projection only. Reading the same revision is an immutable replay. */
export function latestReceipts(receipts:Receipt[]):Receipt[]{
  const jobs=new Map<string,Receipt>(),other:Receipt[]=[];
  for(const receipt of receipts){
    if(!receipt.job){other.push(receipt);continue;}
    const previous=jobs.get(receipt.job.id);
    if(!previous||previous.job!.revision<receipt.job.revision)jobs.set(receipt.job.id,receipt);
  }
  return [...other,...jobs.values()];
}
/** Bind this at platform composition after P1; the package selection and ledger are P1's existing objects. */
export function phoneGatewayPort(ports:PhoneGatewayBindings):PhoneGatewayPort {
  return {
    enabled:packageId=>ports.enabled(packageId),
    async record(context:ReceiptContext,raw:unknown){
      const job=(raw as Receipt|null)?.job;
      check(job&&job.id===context.job_id,'CAPABILITY_JOB_BINDING_REQUIRED',403);
      const binding=await ports.jobRun(context.principal_id,context.job_id!);
      check(binding.principal_id===context.principal_id,'CAPABILITY_JOB_SCOPE_DENIED',403);
      await ports.ledger.admit(binding,{task_id:context.origin_processed_event_id!,tool_call_id:`${job.id}:${job.revision}`,
        tool_name:ports.snapshotTool,args:{job_id:context.job_id}},raw);
    },
    async pending(context,jobIds){
      const receipts:Receipt[]=[];
      for(const jobId of jobIds){
        const binding=await ports.jobRun(context.principal_id,jobId);
        check(binding.principal_id===context.principal_id,'CAPABILITY_JOB_SCOPE_DENIED',403);
        receipts.push(...(await ports.ledger.records(binding)).map(record=>record.receipt).filter(receipt=>receipt.job?.id===jobId));
      }
      const latest=latestReceipts(receipts);
      if(context.run_id)await ports.carry({principal_id:context.principal_id,run_id:context.run_id},latest);
      const facts=await ports.ledger.novel(context.principal_id,ports.receiptFacts(latest));
      return {receipts:latest,fact_ids:facts.map(fact=>fact.id),text:ports.renderFacts(facts,'text'),voice:ports.renderFacts(facts,'voice')};
    },
  };
}
