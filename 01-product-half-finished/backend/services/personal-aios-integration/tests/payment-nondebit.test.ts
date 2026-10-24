import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {paymentFixture} from './payment-fixture.ts';
import {handlePaymentExecutor} from '../src/payment/executor-api.ts';
import {DEVICE_CLOCK_LEAD_MS} from '../../realtime-core/src/types.ts';

async function ready(t:test.TestContext,checkout:'order_card'|'cashier'='order_card'){
  const f=await paymentFixture(t),request=await f.request();
  const card=await f.authority.checkpoint({intent_id:String(request.intent_id),job_id:'job-proof',seq:1,app:'千问',checkout,
    amount_fen:1660,payee:'shop-A',items:['tea'],screen_sha256:'a'.repeat(64),read_at:new Date(f.now).toISOString()});
  const id=String(card.payment_id);await f.pay(id);const grant=f.authority.store.getGrant(id)!;
  const binding={order_id:'order-A',order_namespace:'com.aliyun.tongyi',payee:'shop-A',amount_fen:1660,
    item_identity:[['sku','tea-A'],['quantity','1']]};
  const first={grant_id:grant.grant_id,step:1,read_amount_fen:1660,screen_sha256:'b'.repeat(64),order_binding:binding};
  const proof={state:'unpaid',scope:'current_order',transition:'order_card_to_cashier',signs:['支付状态：未支付'],read_at:new Date(f.now).toISOString()};
  const second={...first,step:2,screen_sha256:'c'.repeat(64),non_debit:proof};
  return {f,id,first,second};
}

test('one grant admits only a proven bound continuation; replay and restart preserve admission',async t=>{
  const {f,id,first,second}=await ready(t);
  assert.deepEqual(await f.authority.tap(id,first),{ok:true});f.reopen();
  const ack={ok:true,non_debit_admitted:true};assert.deepEqual(await f.authority.tap(id,second),ack);
  assert.deepEqual(await f.authority.tap(id,second),ack);f.setNow(f.authority.store.getGrant(id)!.expires_at_ms+1000);
  f.reopen();assert.deepEqual(await f.authority.tap(id,second),ack);
  assert.equal(f.authority.store.getGrant(id)!.taps,2);
  assert.equal(f.authority.store.events(id).filter(e=>e.kind==='tap_started').length,2);
  await assert.rejects(f.authority.tap(id,{...second,step:3}),/PAYMENT_TAP_LIMIT/);
  await assert.rejects(f.authority.tap(id,{...second,non_debit:{...second.non_debit,signs:['different']}}),/PAYMENT_ALREADY_DECIDED/);
});

test('missing or malformed current-order proof never consumes step two',async t=>{
  const {f,id,first,second}=await ready(t);await f.authority.tap(id,first);
  for(const proof of [undefined,null,{}, {...second.non_debit,state:'paid'}, {...second.non_debit,scope:'history'},
    {...second.non_debit,transition:'same_page'}, {...second.non_debit,signs:[]},
    {...second.non_debit,signs:Array(17).fill('unpaid')}, {...second.non_debit,signs:['x'.repeat(201)]},
    {...second.non_debit,read_at:'2026-02-30T00:00:00.000Z'}, {...second.non_debit,read_at:'yesterday'}]){
    await assert.rejects(f.authority.tap(id,{...second,non_debit:proof}),/PAYMENT_NON_DEBIT_REQUIRED/);
    assert.equal(f.authority.store.getGrant(id)!.taps,1);
  }
  assert.deepEqual(await f.authority.tap(id,second),{ok:true,non_debit_admitted:true});
});

test('missing, incomplete and conflicting order bindings cannot admit continuation',async t=>{
  const {f,id,first,second}=await ready(t);await f.authority.tap(id,first);
  for(const binding of [undefined,null,{}, {...first.order_binding,order_id:null}, {...first.order_binding,item_identity:[]}])
    await assert.rejects(f.authority.tap(id,{...second,order_binding:binding}),/PAYMENT_NON_DEBIT_REQUIRED/);
  for(const patch of [{order_id:'other'}, {order_namespace:'com.other.app'}, {payee:'shop-B'}, {amount_fen:1800},
    {item_identity:[['sku','other'],['quantity','1']]}])
    await assert.rejects(f.authority.tap(id,{...second,order_binding:{...first.order_binding,...patch}}),/PAYMENT_ORDER_MISMATCH/);
  assert.equal(f.authority.store.getGrant(id)!.taps,1);
});

test('legacy or nullable first binding permits one input only, including after restart',async t=>{
  for(const binding of [undefined,{order_id:null,order_namespace:null,payee:'shop-A',amount_fen:1660,item_identity:[]}])
    await t.test(binding?'nullable':'legacy',async t=>{
      const {f,id,first,second}=await ready(t);const {order_binding,...legacy}=first;
      await f.authority.tap(id,binding?{...legacy,order_binding:binding}:legacy);f.reopen();
      await assert.rejects(f.authority.tap(id,second),/PAYMENT_NON_DEBIT_REQUIRED/);
      assert.equal(f.authority.store.getGrant(id)!.taps,1);
    });
});

test('first binding is bounded and tied to authorized amount and payee',async t=>{
  const {f,id,first}=await ready(t);
  for(const patch of [{order_id:'x'.repeat(201)}, {item_identity:[['sku','']]}, {item_identity:[['sku','a'],['sku','b']]}])
    await assert.rejects(f.authority.tap(id,{...first,order_binding:{...first.order_binding,...patch}}),/PAYMENT_NON_DEBIT_REQUIRED/);
  for(const patch of [{amount_fen:1800},{payee:'other'}])
    await assert.rejects(f.authority.tap(id,{...first,order_binding:{...first.order_binding,...patch}}),/PAYMENT_ORDER_MISMATCH/);
  assert.equal(f.authority.store.getGrant(id)!.taps,0);
});

test('checkpoint-open phase does not override the executor first-input forward attestation',async t=>{
  const {f,id,first,second}=await ready(t,'cashier');await f.authority.tap(id,first);
  assert.deepEqual(await f.authority.tap(id,second),{ok:true,non_debit_admitted:true});
});

test('pre-order to unpaid attestation admits continuation without a second evidence interpreter',async t=>{
  const {f,id,first,second}=await ready(t);await f.authority.tap(id,first);
  assert.deepEqual(await f.authority.tap(id,{...second,non_debit:{...second.non_debit,transition:'pre_order_to_unpaid'}}),
    {ok:true,non_debit_admitted:true});
});

test('stale, early, future and out-of-lifetime attestations leave the durable first tap unchanged',async t=>{
  const {f,id,first,second}=await ready(t);f.setNow(f.now+10);await f.authority.tap(id,first);f.reopen();
  const grant=f.authority.store.getGrant(id)!,payment=f.authority.store.getPayment(id),events=f.authority.store.events(id);
  for(const at of [Date.parse('2020-01-01T00:00:00.000Z'),grant.first_tap_at_ms!-1,grant.issued_at_ms-1,
    f.now+DEVICE_CLOCK_LEAD_MS+1,grant.expires_at_ms,Date.parse('2099-01-01T00:00:00.000Z')]){
    await assert.rejects(f.authority.tap(id,{...second,non_debit:{...second.non_debit,read_at:new Date(at).toISOString()}}),{code:'PAYMENT_NON_DEBIT_REQUIRED',status:409});
    assert.deepEqual(f.authority.store.getGrant(id),grant);assert.deepEqual(f.authority.store.getPayment(id),payment);assert.deepEqual(f.authority.store.events(id),events);
  }
  assert.deepEqual(await f.authority.tap(id,{...second,non_debit:{...second.non_debit,read_at:new Date(grant.first_tap_at_ms!).toISOString()}}),{ok:true,non_debit_admitted:true});
});

test('authority clock tolerance and exclusive grant deadline bound a new attestation',async t=>{
  const {f,id,first,second}=await ready(t);await f.authority.tap(id,first);const grant=f.authority.store.getGrant(id)!;
  f.setNow(grant.first_tap_at_ms!-DEVICE_CLOCK_LEAD_MS-1);
  await assert.rejects(f.authority.tap(id,second),{code:'PAYMENT_NON_DEBIT_REQUIRED',status:409});assert.equal(f.authority.store.getGrant(id)!.taps,1);
  f.setNow(grant.first_tap_at_ms!-DEVICE_CLOCK_LEAD_MS);
  assert.deepEqual(await f.authority.tap(id,second),{ok:true,non_debit_admitted:true},'the existing tolerance boundary is inclusive');
  const next=await ready(t);await next.f.authority.tap(next.id,next.first);const deadline=next.f.authority.store.getGrant(next.id)!.expires_at_ms;
  assert.deepEqual(await next.f.authority.tap(next.id,{...next.second,non_debit:{...next.second.non_debit,read_at:new Date(deadline-1).toISOString()}}),{ok:true,non_debit_admitted:true});
});

test('Attestation replay probes: no first tap, expired new request, and changed body cannot consume another input',async t=>{
  const {f,id,first,second}=await ready(t);
  await assert.rejects(f.authority.tap(id,second),{code:'PAYMENT_TAP_LIMIT',status:409});assert.equal(f.authority.store.getGrant(id)!.taps,0);
  await f.authority.tap(id,first);await assert.rejects(f.authority.tap(id,{...first,screen_sha256:'d'.repeat(64)}),{code:'PAYMENT_ALREADY_DECIDED',status:409});
  f.setNow(f.authority.store.getGrant(id)!.expires_at_ms);
  await assert.rejects(f.authority.tap(id,second),{code:'PAYMENT_GRANT_EXPIRED',status:409});assert.equal(f.authority.store.getGrant(id)!.taps,1);
});

test('actual executor HTTP accepts only strict scalar enums and the complete step-two JSON shape',async t=>{
  const {f,id,first,second}=await ready(t),key='isolated-executor-fixture-key',server=createServer((req,res)=>{void handlePaymentExecutor(req,res,f.authority,key,32768);});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const post=async(body:unknown)=>{const r=await fetch(`http://127.0.0.1:${address.port}/internal/payment/executor/payments/${id}/tap`,
    {method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  assert.deepEqual(await post(first),{status:200,body:{ok:true}});const grant=f.authority.store.getGrant(id),events=f.authority.store.events(id);
  const malformed:unknown[]=[{...second,extra:true},{...second,order_binding:[]},{...second,non_debit:[]},
    {...second,non_debit:{...second.non_debit,state:'pre_order',transition:'pre_order_to_unpaid'}}];
  for(const field of ['state','scope','transition'] as const)for(const value of [[second.non_debit[field]],{value:second.non_debit[field]},null,true,1])
    malformed.push({...second,non_debit:{...second.non_debit,[field]:value}});
  malformed.push({...second,non_debit:{...second.non_debit,state:'pre_order',transition:['pre_order_to_unpaid']}});
  for(const body of malformed)assert.deepEqual(await post(body),{status:409,body:{error_code:'PAYMENT_NON_DEBIT_REQUIRED'}});
  for(const [patch,code,status] of [[[], 'PAYMENT_AMOUNT_INVALID',400],[{...second,step:[2]},'PAYMENT_TAP_LIMIT',409],
    [{...second,grant_id:[second.grant_id]},'PAYMENT_GRANT_INVALID',409],[{...second,read_amount_fen:[1660]},'PAYMENT_AMOUNT_INVALID',400],
    [{...second,screen_sha256:{}},'PAYMENT_AMOUNT_INVALID',400]] as const)assert.deepEqual(await post(patch),{status,body:{error_code:code}});
  assert.deepEqual(f.authority.store.getGrant(id),grant);assert.deepEqual(f.authority.store.events(id),events);
  assert.deepEqual(await post(second),{status:200,body:{ok:true,non_debit_admitted:true}});
});

test('Forged signs remain an executor attestation boundary, not a second vocabulary interpreter',async t=>{
  const {f,id,first,second}=await ready(t);await f.authority.tap(id,first);
  assert.deepEqual(await f.authority.tap(id,{...second,non_debit:{...second.non_debit,signs:['支付状态：已支付']}}),{ok:true,non_debit_admitted:true});
});

test('executor result, abort and cancellation enums also reject array/object coercion',async t=>{
  const {f,id,first}=await ready(t);await f.authority.tap(id,first);const grant=f.authority.store.getGrant(id)!,events=f.authority.store.events(id);
  for(const outcome of [['paid'],{value:'paid'}])await assert.rejects(f.authority.result(id,{grant_id:grant.grant_id,outcome,signs:[],screen_sha256:'d'.repeat(64)}),{code:'PAYMENT_AMOUNT_INVALID',status:400});
  for(const reason of [['JOB_CANCELLED'],{value:'JOB_CANCELLED'}])await assert.rejects(f.authority.abort(id,{grant_id:grant.grant_id,reason}),{code:'PAYMENT_AMOUNT_INVALID',status:400});
  for(const outcome of [['done'],{value:'done'}])await assert.rejects(f.authority.orderCancel(id,{outcome}),{code:'PAYMENT_AMOUNT_INVALID',status:400});
  assert.deepEqual(f.authority.store.getGrant(id),grant);assert.deepEqual(f.authority.store.events(id),events);assert.equal(f.authority.store.getPayment(id)!.state,'paying');
});
