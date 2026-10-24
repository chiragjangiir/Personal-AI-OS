import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentFixture,phone} from './payment-fixture.ts';
import {paymentMessageBytes,PAYMENT_OUTPUT_LIMIT,PAYMENT_ENVELOPE_ID} from '../src/payment/wire-budget.ts';
import {recordsProjection} from '../src/payment/projection.ts';

for(const tied of [false,true])test(`real SQLite record pages preserve all 50 ${tied?'equal':'distinct'} timestamps across byte/count boundaries`,async t=>{
  const f=await paymentFixture(t),payee='🧾'.repeat(200),items=Array(5).fill('🧾'.repeat(80)),opened:string[]=[];
  for(let n=0;n<50;n++){
    if(!tied)f.setNow(f.now+1);const card=await f.open({amount:100000000,payee});
    opened.push(card.payment_id);f.authority.store.updatePayment(card.payment_id,{items});await f.authority.cancel('owner',card.intent_id);
  }
  const expected=tied?opened.sort():opened.reverse();
  if(tied)assert.equal(new Set(f.authority.store.principalPayments('owner').map(p=>p.created_at_ms)).size,1);
  for(const limit of [undefined,2,50]){
    const found:string[]=[];let before:string|undefined;
    do{
      const page=(await f.authority.input(phone,{operation:'payment_records_get',request_id:PAYMENT_ENVELOPE_ID,...(before?{before}:{}),...(limit?{limit}:{})},PAYMENT_ENVELOPE_ID))!;
      const rows=page.items as Record<string,unknown>[];
      assert.ok(rows.length>0&&rows.length<=(limit??50));assert.ok(paymentMessageBytes(page)<=PAYMENT_OUTPUT_LIMIT);
      for(const row of rows){assert.equal(row.payee,payee);assert.equal(row.amount_fen,100000000);found.push(String(row.payment_id));}
      if(limit!==2)assert.ok(rows.length<50,'byte budget, not the default count, ends the page');
      before=page.next_before as string|undefined;
      if(before){assert.ok(before.length<=128);assert.deepEqual(JSON.parse(Buffer.from(before,'base64url').toString()),[Date.parse(String(rows.at(-1)!.at)),rows.at(-1)!.payment_id]);}
    }while(before);
    assert.deepEqual(found,expected);assert.equal(new Set(found).size,50);
  }
});

test('detail pages reach all global event sequences beyond 64 and preserve protected values and audit data',async t=>{
  const f=await paymentFixture(t),payee='🧾'.repeat(200),card=await f.open({amount:100000000,payee}),metadata='\u0000'.repeat(200);
  f.authority.store.updatePayment(card.payment_id,{items:Array(5).fill('🧾'.repeat(80))});
  for(let n=0;n<130;n++){
    f.authority.store.event({at_ms:f.now,principal_id:'owner',payment_id:card.payment_id,intent_id:card.intent_id,
      actor:'owner_phone',kind:`record_fixture_${n}`,data:{reason:metadata,detail:metadata,payee,amount_fen:100000000,items:Array(5).fill('🧾'.repeat(80))}});
    f.authority.store.event({at_ms:f.now,principal_id:'owner',actor:'system',kind:'unrelated_fixture',data:{}});
  }
  const original=f.authority.store.events(card.payment_id),found:string[]=[];let before_seq:number|undefined,pages=0,remaining=original.length;
  do{
    const response=(await f.authority.input(phone,{operation:'payment_record_get',request_id:PAYMENT_ENVELOPE_ID,payment_id:card.payment_id,...(before_seq?{before_seq}:{})},PAYMENT_ENVELOPE_ID))!;
    assert.ok(paymentMessageBytes(response)<=PAYMENT_OUTPUT_LIMIT);
    const timeline=response.timeline as {kind:string;data:Record<string,unknown>}[],payment=response.payment as Record<string,unknown>;
    assert.ok(timeline.length>0&&timeline.length<=64);
    assert.deepEqual(timeline.map(e=>e.kind),original.slice(remaining-timeline.length,remaining).map(e=>e.kind));
    if(pages===0)assert.ok(timeline.length<64,'byte budget ends the first page');
    assert.equal(payment.payment_id,card.payment_id);assert.equal(payment.payee,payee);assert.equal(payment.amount_fen,100000000);
    for(const entry of timeline.filter(e=>e.kind.startsWith('record_fixture_'))){assert.equal(entry.data.payee,payee);assert.equal(entry.data.amount_fen,100000000);assert.equal(entry.data.detail,'\u0000'.repeat(80));}
    found.unshift(...timeline.map(e=>e.kind));remaining-=timeline.length;before_seq=response.next_seq as number|undefined;
    if(before_seq)assert.equal(before_seq,original[remaining]!.seq);
    assert.equal(Boolean(before_seq),remaining>0);
    assert.ok(++pages<=original.length);
  }while(before_seq);
  assert.deepEqual(found,original.map(e=>e.kind));assert.equal(new Set(found).size,original.length);
  assert.deepEqual(f.authority.store.events(card.payment_id),original);
  assert.equal(original.at(-1)!.data.detail,metadata);
});

test('records accept only canonical bounded tuple cursors, never legacy timestamps',async t=>{
  const f=await paymentFixture(t),encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  for(const before of [new Date(f.now).toISOString(),'!',encode([f.now]),encode([f.now,'bad/id']),encode([1.5,'pay-id']),encode([Number.MAX_SAFE_INTEGER+1,'pay-id']),encode([f.now,'pay-id'])+'=',Buffer.from(`[ ${f.now},"pay-id"]`).toString('base64url')]){
    assert.throws(()=>recordsProjection(f.authority.store,'owner',before),{code:'FORMAL_PAYMENT_INPUT_INVALID'});
  }
});
