import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv} from 'ajv';
import {utc} from '../../../services/personal-aios-integration/src/contracts.ts';

const root=new URL('../../../../../',import.meta.url);
const bytes=readFileSync(new URL('integrations/contracts/formal-message.v1.json',root));
const wire=JSON.parse(bytes.toString());
const {fixtures}=JSON.parse(readFileSync(new URL('integrations/contracts/activity-update.fixtures.json',root),'utf8'));
const ajv=new Ajv({strict:true});
ajv.addFormat('paios-utc',{type:'string',validate:value=>{try{utc(value);return true;}catch{return false;}}});
const accepts=ajv.compile({$defs:wire.$defs,...wire.outputs.activity_update});

for(const [name,fixture] of Object.entries(fixtures))test(`activity contract accepts shared ${name} fixture`,()=>{
  assert.equal(accepts(fixture),true,JSON.stringify(accepts.errors));
});

test('activity contract allows a generic card with no items and cancelled terminal snapshots',()=>{
  const card={...fixtures.single_running.card,summary_source:'generic',items:[]};
  assert.equal(accepts({...fixtures.single_running,card}),true,JSON.stringify(accepts.errors));
  assert.equal(accepts({...fixtures.single_running,card:{...card,state:'cancelled',completed_at:card.observed_at}}),true);
});

test('activity contract rejects private fields and unknown envelope, card, count and item fields',()=>{
  const base=fixtures.single_running;
  const invalid=[{...base,run_id:'private-run'},{...base,schema_version:wire.schema},
    {...base,card:{...base.card,preview:'private arguments'}},
    {...base,card:{...base.card,counts:{...base.card.counts,queued:0}}},
    {...base,card:{...base.card,items:[{...base.card.items[0],tool:'terminal'}]}}];
  for(const packet of invalid)assert.equal(accepts(packet),false,JSON.stringify(packet));
});

test('activity contract rejects missing lineage, invalid IDs, states, lengths and unbounded snapshots',()=>{
  const base=fixtures.single_running;
  const {processed_event_id:_,...unbound}=base;
  const invalid=[unbound,{...base,session_id:'非ASCII'},
    ...[{id:'a'.repeat(201)},{revision:0},{revision:1.5},{state:'queued'},
      {summary:'文'.repeat(49)},{summary:'第一行\n第二行'},{step_summary:'文'.repeat(65)},
      {summary_source:'reasoning'},{elapsed_ms:-1},{elapsed_ms:9007199254740992},
      {observed_at:'2026-02-30T00:00:00.000Z'},{omitted_items:-1},
      {counts:{...base.card.counts,running:-1}},
      {items:Array.from({length:9},()=>base.card.items[0])},
      {items:[{...base.card.items[0],kind:'tool'}]},
      {items:[{...base.card.items[0],state:'partial'}]},
      {items:[{...base.card.items[0],summary:'文'.repeat(49)}]},
    ].map(card=>({...base,card:{...base.card,...card}}))];
  for(const packet of invalid)assert.equal(accepts(packet),false,JSON.stringify(packet));
});

test('activity contract requires terminal completion and safe failure reasons',()=>{
  for(const state of ['succeeded','failed','partial','cancelled']){
    const packet={...fixtures.failed_timeout,card:{...fixtures.failed_timeout.card,state}};
    const {completed_at:_,...card}=packet.card;
    assert.equal(accepts({...packet,card}),false,state);
  }
  for(const name of ['failed_timeout','partial_done']){
    const packet=fixtures[name],{failure_reason:_,...card}=packet.card;
    assert.equal(accepts({...packet,card}),false,name);
    assert.equal(accepts({...packet,card:{...card,failure_reason:'文'.repeat(97)}}),false,name);
  }
  const packet=fixtures.failed_timeout,{failure_reason:_,...item}=packet.card.items[0];
  assert.equal(accepts({...packet,card:{...packet.card,items:[item]}}),false);
});

test('activity contract copies remain byte identical for Apple and glasses',()=>{
  for(const path of [
    '01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/formal-message.v1.json',
    '01-product-half-finished/glasses-android/app/src/test/resources/formal-message.v1.json',
  ])assert.deepEqual(readFileSync(new URL(path,root)),bytes,path);
});
