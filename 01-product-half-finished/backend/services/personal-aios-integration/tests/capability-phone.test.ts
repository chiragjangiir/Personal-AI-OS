import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneReceiptLifecycle,type PhoneGatewayPort,type SelfCheckRequest} from '../src/capability/phone/lifecycle.ts';
import {succeeded} from '../../../../../capability/sdk/ts/receipt.ts';

function fixture(){
  let enabled=true;const records:unknown[]=[],calls:unknown[]=[],checks=new Map<string,SelfCheckRequest>();
  const gateway:PhoneGatewayPort={enabled:()=>enabled,record:async(context,receipt)=>{records.push({context,receipt});},
    pending:async(context,jobIds)=>{calls.push({context,jobIds});return {receipts:[],fact_ids:[],text:'',voice:''};}};
  const policy=new PhoneReceiptLifecycle(gateway,{ensure:async request=>{checks.set(request.id,request);}});
  return {policy,records,calls,checks,disable:()=>{enabled=false;}};
}
test('phone follow-up reads novelty from the gateway authority, without previous report text',async()=>{
  const f=fixture(),context={principal_id:'owner',run_id:'run'};
  assert.deepEqual(await f.policy.context(context,['job-a','job-a']),{receipt_facts:{receipts:[],fact_ids:[],text:'',voice:''}});
  assert.deepEqual(f.calls,[{context,jobIds:['job-a']}]);
});
test('phone source identity and origin bind the receipt; failed card schedules one source-keyed system check',async()=>{
  const f=fixture(),receipt=succeeded({job:{id:'job-a',revision:2}});
  const job={principal_id:'owner',job_id:'job-a',success:false,terminal_reason:'failed',capability_receipt:receipt};
  await f.policy.observe(job,'d:owner');await f.policy.observe(job,'d:owner');
  assert.equal(f.records.length,2,'the ledger owns duplicate receipt admission');
  assert.equal(f.checks.size,1,'the existing scheduler owns durable source deduplication');
  assert.deepEqual(f.checks.get('job-a:0'),{id:'job-a:0',principal_id:'owner',source:'errand',failed_card:'job-a',
    title:'检查未完成的任务',origin_processed_event_id:'d:owner',evidence_ref:{tool:'phone_status',job_id:'job-a'},
    message_role:'system',owner_requested:false});
});
test('self-check outcomes and user cancellations cannot recursively schedule another check',async()=>{
  const f=fixture();
  for(const extra of [{self_check_of:'source:0'},{terminal_reason:'cancelled_by_user'}])
    await f.policy.observe({principal_id:'owner',job_id:'job-a',success:false,capability_receipt:succeeded(),...extra},'d:owner');
  assert.equal(f.checks.size,0);
});
test('phone family off preserves legacy path and performs no package writes',async()=>{
  const f=fixture();f.disable();await f.policy.observe({principal_id:'owner',job_id:'job-a',success:false,capability_receipt:succeeded()},'d:owner');
  assert.equal(f.records.length,0);assert.equal(f.checks.size,0);assert.equal(f.policy.enabled(),false);
});
