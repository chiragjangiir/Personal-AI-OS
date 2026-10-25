import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activityWire} from '../src/activity-wire.ts';
import {ActivityProjection} from '../../../services/personal-aios-integration/src/activity.ts';
import {receipt} from '../../../../../capability/sdk/ts/receipt.ts';
import {createFormalWireAjv} from '../src/personal-aios-formal-text.ts';
import {validateSimulatorOutput} from '../tools/mac-product-sim-client.ts';

for(const state of ['unknown','waiting'] as const)test(`v1 simulator retains the ${state} facts and accepts every projected activity item`,()=>{
  let packet:any;
  const projection=new ActivityProjection('owner','session','d:fixture',value=>{packet=value;},()=>Date.parse('2026-10-25T00:00:00Z'));
  projection.receipts([{id:'receipt',task_id:'task',tool_call_id:'call',tool:'fixture',invocation:'call',fingerprint:'body',receipt:receipt(state)}]);
  projection.event({event:'tool.started',run_id:'run',seq:1,timestamp:Date.now()/1000,tool:'fixture'} as never);
  const original=projection.snapshot()!.packet;
  const projected=activityWire(original as never) as typeof original;
  assert.equal(original.card.state,state);assert.equal(projected.card.state,state==='unknown'?'partial':'running');
  assert.match(projected.card.summary,state==='unknown'?/尚未核实/:/等待确认/);
  assert.equal('unknown' in projected.card.counts,false);assert.equal('waiting' in projected.card.counts,false);
  assert.notStrictEqual(projected.card,original.card);
  const contract=JSON.parse(readFileSync(process.env.PAIOS_OLD_WIRE_CONTRACT??new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const ajv=createFormalWireAjv(),validators={activity_update:ajv.compile({$defs:contract.$defs,...contract.outputs.activity_update})};
  const framed={...projected};
  assert.equal(validators.activity_update(framed),true,JSON.stringify(validators.activity_update.errors));
  assert.strictEqual(validateSimulatorOutput(framed,'reconnected-session',validators),framed);
  projection.close();
});
