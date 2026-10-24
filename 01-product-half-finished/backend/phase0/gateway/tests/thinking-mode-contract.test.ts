import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv} from 'ajv';

const root = new URL('../../../../../', import.meta.url);
const bytes = readFileSync(new URL('integrations/contracts/formal-message.v1.json', root));
const wire = JSON.parse(bytes.toString());
const ajv = new Ajv({strict:true});
ajv.addFormat('paios-utc', {type:'string', validate:()=>true});
const input = (operation:string) => ajv.compile({$defs:wire.$defs,...wire.inputs[operation].definition});
const output = (operation:string) => ajv.compile({$defs:wire.$defs,...wire.outputs[operation]});
const envelope = {schema_version:wire.schema,session_id:'session',call_id:'call'};

test('shared call contract preserves chat default and accepts only explicit conversation modes', () => {
  const open=input('call_open'), change=input('call_set_conversation_mode'), retry=input('call_retry');
  assert.equal(retry({operation:'call_retry',call_id:'call',control_id:'retry-1',processed_event_id:'D'}),true);
  assert.equal(retry({operation:'call_retry',call_id:'call',control_id:'retry-1'}),false);
  assert.equal(open({operation:'call_open',call_id:'call'}),true);
  for (const conversation_mode of ['chat','thinking']) {
    assert.equal(open({operation:'call_open',call_id:'call',conversation_mode}),true);
    assert.equal(change({operation:'call_set_conversation_mode',call_id:'call',control_id:'mode-1',conversation_mode}),true);
  }
  for (const invalid of [null,'ambient',true]) {
    assert.equal(open({operation:'call_open',call_id:'call',conversation_mode:invalid}),false);
    assert.equal(change({operation:'call_set_conversation_mode',call_id:'call',control_id:'mode-1',conversation_mode:invalid}),false);
  }
  assert.equal(change({operation:'call_set_conversation_mode',call_id:'call',conversation_mode:'thinking'}),false);
});

test('mode receipt identifies the call and acknowledged mode; event controls retain their event identity', () => {
  const receipt=output('control_receipt');
  const mode={...envelope,operation:'control_receipt',control_id:'mode-1',requested_operation:'call_set_conversation_mode',receipt:{conversation_mode:'thinking'}};
  assert.equal(receipt(mode),true,JSON.stringify(receipt.errors));
  const {call_id:_,...withoutCall}=mode;
  assert.equal(receipt(withoutCall),false);
  assert.equal(receipt({...mode,receipt:{}}),false);
  assert.equal(receipt({...mode,requested_operation:'cancel_run',receipt:{status:'running'}}),false);
  assert.equal(receipt({...withoutCall,requested_operation:'cancel_run',processed_event_id:'D',receipt:{status:'running'}}),true);
  assert.equal(receipt({...mode,requested_operation:'call_retry',processed_event_id:'D',receipt:{processed_event_id:'D-retried',state:'running'}}),true);
});

test('call snapshots carry explicit failure actions and original readout lineage without changing transcripts', () => {
  const state=output('call_state'), transcript=output('call_transcript');
  const packet={...envelope,operation:'call_state',state:'live',conversation_mode:'thinking',processed_event_id:'D',
    thinking_status:{state:'readout_mismatch',text:'这句朗读与文字不一致，请以文字为准',actions:['switch_to_chat']},
    readout_fidelity:{message_id:'message',sentence_index:0,response_id:'response',source_text:'金额 1.20 元。',transcript_text:'金额 12 元。',notice:'请以文字为准'}};
  assert.equal(state(packet),true,JSON.stringify(state.errors));
  assert.equal(state({...packet,thinking_status:{state:'failed',text:'主脑没连上',actions:['retry','switch_to_chat']}}),true);
  assert.equal(state({...packet,thinking_status:{state:'failed',text:'失败',actions:['automatic_fallback']}}),false);
  assert.equal(state({...packet,readout_fidelity:{...packet.readout_fidelity,sentence_index:-1}}),false);
  assert.equal(transcript({...envelope,operation:'call_transcript',turn:1,role:'main_agent',text:'金额 1.20 元。',final:true,message_id:'message'}),true);
});

test('Apple and glasses consume the exact shared formal contract bytes', () => {
  for (const path of [
    '01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/formal-message.v1.json',
    '01-product-half-finished/glasses-android/app/src/test/resources/formal-message.v1.json',
  ]) assert.deepEqual(readFileSync(new URL(path,root)),bytes,path);
});
