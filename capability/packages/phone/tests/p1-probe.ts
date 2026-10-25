import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {phoneGatewayPort} from '../../../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/phone/gateway-port.ts';
import {accepted,succeeded,effect} from '../../../sdk/ts/receipt.ts';

const [directory,output]=process.argv.slice(2);
if(!directory||!output)throw new Error('usage: p1-probe.ts p1-capability-directory output.json');
const {ReceiptLedger}=await import(pathToFileURL(resolve(directory,'ledger.ts')).href);
const {receiptFacts,renderFacts}=await import(pathToFileURL(resolve(directory,'renderer.ts')).href);
const bytes=new Map<string,Uint8Array>();
const storage={read:async(ns:string,key:string)=>{const body=bytes.get(ns+key);if(!body)throw Object.assign(new Error('missing'),{code:'ENOENT'});return body;},
  replace:async(ns:string,key:string,body:Uint8Array)=>{bytes.set(ns+key,body);}};
const ledger=new ReceiptLedger(storage),binding={principal_id:'owner',run_id:'run'};
const carried:unknown[]=[];
const carry=async(binding:unknown,receipts:unknown)=>{carried.push({binding,receipts});};
const port=phoneGatewayPort({ledger,snapshotTool:'mcp__phone__phone_status',enabled:()=>true,jobRun:async()=>binding,carry,receiptFacts,renderFacts});
const context={principal_id:'owner',origin_processed_event_id:'d:owner',job_id:'job-0123456789ab'};
await port.record(context,accepted({job:{id:context.job_id,revision:1}}));
const final=succeeded({job:{id:context.job_id,revision:2},effects:[effect('physical','fixture','提交订单','verified','screen reread')]});
await port.record(context,final);await port.record(context,final);
assert.equal((await ledger.records(binding)).length,2);
const before=await port.pending({...context,run_id:'report-run'},[context.job_id]);
assert.deepEqual(before.receipts,[final]);assert.ok(before.fact_ids.length);
assert.deepEqual(carried,[{binding:{principal_id:'owner',run_id:'report-run'},receipts:[final]}]);
// Publication alone does not mark facts delivered. The next run still sees them.
assert.deepEqual((await port.pending(context,[context.job_id])).fact_ids,before.fact_ids);
await ledger.delivered('owner',before.fact_ids,'rendered:fixture-device');
// A recreated ledger reads the same durable delivery facts after restart.
const restarted=phoneGatewayPort({ledger:new ReceiptLedger(storage),snapshotTool:'mcp__phone__phone_status',enabled:()=>true,jobRun:async()=>binding,carry,receiptFacts,renderFacts});
assert.deepEqual((await restarted.pending(context,[context.job_id])).fact_ids,[]);
await assert.rejects(()=>port.record({...context,job_id:'job-ffffffffffff'},final),/CAPABILITY_JOB_BINDING_REQUIRED/u);
writeFileSync(output,JSON.stringify({passed:8,carry_stubbed:true,latest_revision:2,ack_required:true,restart_dedup:true,
  acknowledged_fact_ids:before.fact_ids,rendered_text:before.text,receipt:final},null,2)+'\n');
console.log('P1 ledger/novelty/latest-snapshot probe passed');
