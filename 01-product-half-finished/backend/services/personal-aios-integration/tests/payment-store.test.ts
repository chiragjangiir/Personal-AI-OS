import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentStore, payeeKey, canonical} from '../src/payment/store.ts';
import {sha256} from '../src/contracts.ts';
import type {Payment, PaymentIntent} from '../src/payment/contracts.ts';
const intent:PaymentIntent={intent_id:'pi-1',principal_id:'owner',run_id:'run-1',tool_call_id:'tool-1',session_id:'session-1',processed_event_id:'d-1',
  initiating:{kind:'text',device_id:'phone',device_type:'phone',captured_at_ms:1,lease_at_capture:false},initiating_text:null,
  purpose:'lunch',app:'qwen',budget_fen:null,created_at_ms:1,expires_at_ms:100,state:'open',closed_reason:null};
const payment:Payment={payment_id:'pay-1',intent_id:'pi-1',principal_id:'owner',job_id:'job',seq:1,supersedes:null,app:'qwen',checkout:'cashier',
  amount_fen:100,payee:'Shop',payee_key:'key',items:['lunch'],delivery:null,screen_sha256:'screen',state:'awaiting_owner',version:1,decision_nonce:'nonce',
  created_at_ms:10,expires_at_ms:100,auto_at_ms:null,voice_attempts:0,method:null,decided_by_device:null,decision:null,reason:null,notice:{line:'hello'},
  next_payment_id:null,order_cancel:null,finished_at_ms:null};
function fixture(t:test.TestContext):{store:PaymentStore;directory:string}{
  const directory=mkdtempSync(join(tmpdir(),'payment-store-')),store=PaymentStore.open(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {store,directory};
}
test('I12: append-only audit triggers, canonical hash chain and atomic rollback survive reopening',t=>{
  const {store,directory}=fixture(t);
  store.tx(()=>{store.insertIntent(intent);store.insertPayment(payment);store.event({at_ms:10,principal_id:'owner',kind:'card_opened',actor:'authority',payment_id:'pay-1',data:{z:1,a:{b:2}}});});
  store.tx(()=>store.event({at_ms:11,principal_id:'owner',kind:'voice_ignored',actor:'authority',data:{reason:'none'}}));
  assert.deepEqual(store.getIntent('pi-1'),intent);assert.deepEqual(store.getPayment('pay-1'),payment);
  assert.throws(()=>store.db.exec("UPDATE events SET kind='changed'"),/PAYMENT_AUDIT_IMMUTABLE/);
  assert.throws(()=>store.db.exec('DELETE FROM events'),/PAYMENT_AUDIT_IMMUTABLE/);
  assert.throws(()=>store.tx(()=>{store.updatePayment('pay-1',{state:'paid'});store.event({at_ms:12,principal_id:'owner',kind:'card_closed',actor:'authority',data:{}});throw Error('rollback');}));
  assert.equal(store.getPayment('pay-1')?.state,'awaiting_owner');assert.equal(store.events().length,2);
  store.close();const reopened=PaymentStore.open(directory);
  try{
    let previous='0'.repeat(64);
    for(const e of reopened.events()){
      const {seq,at_ms,kind,intent_id,payment_id,actor,device_id,data}=e;
      assert.equal(e.prev_hash,previous);assert.equal(e.hash,sha256(previous+canonical({seq,at_ms,kind,intent_id,payment_id,actor,device_id,data})));previous=e.hash;
    }
    assert.equal(statSync(join(directory,'payment.sqlite')).mode&0o777,0o600);
    reopened.db.prepare("UPDATE meta SET value='paios.payment-store.v2' WHERE key='schema'").run();
  }finally{reopened.close();}
  assert.throws(()=>PaymentStore.open(directory),/PAYMENT_STORE_SCHEMA_UNSUPPORTED/);
});
test('payee identity and query-derived usage/anomalies have no mutable counters',t=>{
  const {store}=fixture(t);store.insertIntent(intent);
  assert.equal(payeeKey('owner','qwen',' Ａ Shop! '),payeeKey('owner','qwen','a shop'));
  assert.notEqual(payeeKey('owner','qwen','Shop 一店'),payeeKey('owner','qwen','Shop 二店'));
  assert.equal(payeeKey('owner','qwen',null),null);
  for(const [n,state,method] of [[1,'paid','card'],[2,'outcome_unknown','auto'],[3,'cancelled','auto'],[4,'granted','auto']] as const){
    store.insertPayment({...payment,payment_id:`pay-${n}`,seq:n,state,method,created_at_ms:n*10});
    store.insertGrant({grant_id:`grant-${n}`,payment_id:`pay-${n}`,amount_fen:100,payee_key:'key',method,
      device_id:'phone',issued_at_ms:n*10,expires_at_ms:100,taps:0,first_tap_at_ms:null});
  }
  assert.equal(store.knownPayee('owner','key'),true);assert.equal(store.knownPayee('other','key'),false);
  assert.equal(store.recentSamePayee('owner','key','pay-1',30),true);
  assert.equal(store.recentSamePayee('owner','key','pay-4',30),false);
  assert.equal(store.autoUsed('owner',20,40),100);assert.equal(store.autoUsed('owner',0,41),200);
  for(const [at,kind,data] of [[10,'amount_changed',{}],[20,'voice_attempt',{verdict:'uncertain'}],[30,'voice_attempt',{verdict:'insufficient'}],[40,'voice_attempt',{verdict:'fail'}]] as const)
    store.event({at_ms:at,principal_id:'owner',kind,actor:'authority',data});
  assert.equal(store.anomalyCount('owner',10,40),2);assert.equal(store.anomalyCount('other',0,100),0);
  const policy={limits:{auto_order_fen:200},auto_enabled:true,principal_id:'owner',voice_enabled:true,version:1,paused_until_ms:null,updated_at_ms:10};
  store.setPolicy(policy);assert.deepEqual(store.policy('owner'),policy);
});
