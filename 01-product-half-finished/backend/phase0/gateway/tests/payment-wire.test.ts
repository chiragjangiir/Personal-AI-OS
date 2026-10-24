import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {paymentWire,PAYMENT_WIRE_SHA256,mergePaymentWire,dispatchPayment} from '../src/personal-aios-payment-wire.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {utc} from '../../../services/personal-aios-integration/src/contracts.ts';
import {errandNotice} from '../src/errand-spool.ts';

const ajv=new Ajv({strict:true,coerceTypes:false});addFormats.default(ajv,['date-time']);
ajv.addFormat('paios-utc',{type:'string',validate:value=>{try{utc(value);return true;}catch{return false;}}});
const compile=(schema:object)=>ajv.compile({$defs:paymentWire.$defs,...schema});
const inputs=Object.fromEntries(Object.entries(paymentWire.inputs).map(([op,value])=>[op,compile(value.definition as object)]));
const outputs=Object.fromEntries(Object.entries(paymentWire.outputs).map(([op,value])=>[op,compile(value)]));

test('payment wire pins published v1 and validates all 80 examples across 15 inputs and 9 outputs',()=>{
  assert.equal(PAYMENT_WIRE_SHA256,'02468dc5412c932565d76ebe26fcb9e0f68b165ce178f0af24e657883f07de70');
  assert.equal(Object.keys(inputs).length,15);assert.equal(Object.keys(outputs).length,9);
  let count=0;
  for(const [operation,examples] of Object.entries(paymentWire.examples)){
    const validate=inputs[operation]??outputs[operation];assert.ok(validate,operation);
    for(const example of examples){assert.equal(validate(example),true,`${operation}: ${JSON.stringify(validate.errors)}`);count++;
      assert.equal(validate({...example,unexpected:true}),false,`${operation} rejects extra fields`);}
  }
  assert.equal(count,80);
  const base=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const submit=base.inputs.submit;mergePaymentWire(base);assert.equal(base.inputs.submit,submit);
  assert.equal(base.inputs.payment_decide,paymentWire.inputs.payment_decide);
  assert.equal(base.outputs.payment_notice,paymentWire.outputs.payment_notice);
});
test('signed payment controls reject malformed, missing and partial signatures before authority dispatch',()=>{
  for(const operation of ['payment_decide','payment_keys_register','phone_unlock','payment_approval_decide','voiceprint_channel_forget']){
    const signed=paymentWire.examples[operation]!.find(e=>e.signature_b64)!;
    assert.ok(signed,operation);
    for(const signature_b64 of ['%%%', 'abc', 'YWJj\n','YWJj_', 'a'.repeat(4097),null,undefined])
      assert.equal(inputs[operation]!({...signed,signature_b64}),false,`${operation}: ${signature_b64}`);
    assert.equal(inputs[operation]!({...signed,statement_b64:undefined}),false,operation);
  }
});
test('Payment wire stays integer v1; unlock requires a cycle, while legacy wear and lock snapshots remain valid',()=>{
  assert.equal(paymentWire.version,1);assert.equal(paymentWire.schema,'paios.payment.wire.v1');
  const request=paymentWire.examples.glasses_unlock_request![0]!;
  assert.equal(inputs.glasses_unlock_request!({...request,lock_cycle:undefined}),false);
  const base=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8'));
  const wear=ajv.compile({$defs:base.$defs,...base.inputs.wear_state.definition});
  const legacy={operation:'wear_state',control_id:'wear-1',worn:true};
  assert.equal(wear(legacy),true);assert.equal(wear({...legacy,lock_cycle:0}),true);
  const unlocked=paymentWire.examples.payment_lock_state!.find(e=>e.locked===false)!;
  for(const lock_cycle of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'1']){
    assert.equal(inputs.glasses_unlock_request!({...request,lock_cycle}),false);
    assert.equal(outputs.payment_lock_state!({...unlocked,lock_cycle}),false);
    assert.equal(wear({...legacy,lock_cycle}),false);
  }
});
test('D13 locked notice is redacted by schema, including voice hint, amount, payee and summary',()=>{
  const notice=paymentWire.examples.payment_notice!.find(e=>(e.notice as {reason?:string})?.reason==='TERMINAL_LOCKED')!;
  assert.ok(outputs.payment_notice!(notice));
  for(const extra of [{amount_fen:1660},{payee:'private'},{line:'private'},{voice_hint:true},{voice_hint:false},{decision_nonce:'a'.repeat(43)}])
    assert.equal(outputs.payment_notice!({...notice,notice:{...notice.notice as object,...extra}}),false);
});
test('iPhone payment contract has byte-identical parity with the shared contract',t=>{
  const app=new URL('../../../../../01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/payment-message.v1.json',import.meta.url);
  if(!existsSync(app)){t.skip('Integration gap: iPhone payment-message.v1.json copy is absent');return;}
  assert.equal(createHash('sha256').update(readFileSync(app)).digest('hex'),PAYMENT_WIRE_SHA256);
});
test('payment input routing permits only its declared terminal and preserves authority receipt',async()=>{
  const device=(device_type:string)=>({device_type}) as RegisteredDevice;
  let calls=0;const runtime={paymentInput:async()=>{calls++;return undefined;}};
  for(const [operation,examples] of Object.entries(paymentWire.examples).filter(([op])=>inputs[op])){
    const body=examples[0]!,kind=['glasses_unlock_request','glasses_lock','voiceprint_enrol_request'].includes(operation)?'glasses':'phone';
    const value=await dispatchPayment(runtime,device(kind),body);
    assert.deepEqual(value,typeof body.control_id==='string'?{operation:'payment_receipt',control_id:body.control_id,ok:true}:undefined);
    for(const wrong of ['mac','watch',kind==='phone'?'glasses':'phone'])await assert.rejects(dispatchPayment(runtime,device(wrong),body),/PAYMENT_TERMINAL_NOT_ALLOWED/);
  }
  assert.equal(calls,15);
  const receipt={operation:'payment_receipt',control_id:'c',ok:false,error_code:'PAYMENT_ALREADY_DECIDED'};
  assert.equal(await dispatchPayment({paymentInput:async()=>receipt},device('phone'),paymentWire.examples.payment_decide![0]!),receipt);
});
test('payment errand notices distinguish paid, unknown and previous executor prefix',()=>{
  const result={principal_id:'owner',job_id:'job-00000000',task:'order',success:true,finished_at:'2026-10-15T00:00:00.000Z'};
  for(const [prefix,title] of [['【已付款】','依米：已付款'],['【付款结果不明】','依米：付款结果不明，请核对'],['【可能已付款】','依米：可能已付款，请核对订单']]){
    assert.deepEqual(errandNotice({...result,answer:prefix+' 一点点 ¥16.60'}),{title,body:'解锁依米查看金额和收款方。'});
  }
});
