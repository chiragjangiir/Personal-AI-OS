import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSettingsPage,modelSettingsState} from '../src/model-settings-view.ts';
import type {RegisteredDevice} from '../src/source-authority.ts';
const source={principal_id:'owner',device_id:'mac'} as RegisteredDevice;
function fixture(count=64){
  const providers=[{id:'api',display_name:'API',wire_protocol:'chat_completions',base_url:'https://example.test',credential_ref:'key'}];
  const roles=Array.from({length:count},(_,i)=>({id:`role-${i}`,profile:'owner',provider_ref:'api',model_id:'model',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'}));
  const snapshot={providers,roles},versions={key:1};let desired=1;
  const authority={read:()=>({environment_id:'test',desired,groups:{},...snapshot,credentials:{key:{configured:true,last4:'1234',updated_at:'now',test_status:'passed'}}}),
    readRevision:(revision:number)=>({revision,snapshot,versions}),getDraft:()=>({draft_id:'frozen',action:'commit',payload:{expected_revision:1,providers,roles,change_summary:'summary'},revision:2,snapshot,versions,sealed_key:{ciphertext:'never-return'}})};
  return {authority:authority as never,roles,setDesired:(value:number)=>{desired=value;}};
}
test('64 roles reassemble from bounded pages pinned to one revision despite desired changing',()=>{
  const f=fixture(),items:unknown[]=[];let offset=0;
  for(;;){const page=modelSettingsPage(f.authority,source,{revision:1,offset});
    assert.equal(page.revision,1);assert.ok(page.items.length<=8);assert.ok(Buffer.byteLength(JSON.stringify(page))<=8000);
    items.push(...page.items);f.setDesired(2);if(page.next_offset===null)break;offset=page.next_offset;
  }
  assert.equal(items.length,66);assert.deepEqual(items.filter((item:any)=>item.kind==='role').map((item:any)=>item.value),f.roles);
  assert.deepEqual(modelSettingsState(f.authority),{environment_id:'test',desired:2,groups:{}});
  const draft=modelSettingsPage(f.authority,source,{draft_id:'frozen'});assert.equal(draft.revision,2);assert.ok(!JSON.stringify(draft).includes('ciphertext'));
  assert.deepEqual(draft.draft,{draft_id:'frozen',action:'commit',payload:{expected_revision:1}});
});
test('pages split by UTF-8 bytes before row count, reject oversized row and invalid cursor',()=>{
  const f=fixture(10);for(const role of f.roles)role.model_id='依米'.repeat(400);
  const page=modelSettingsPage(f.authority,source);assert.ok(page.items.length<8);assert.ok(page.next_offset!==null);
  f.roles[0]!.model_id='依米'.repeat(2000);
  assert.throws(()=>modelSettingsPage(f.authority,source,{offset:1}),/MODEL_SETTINGS_ROW_TOO_LARGE/);
  assert.throws(()=>modelSettingsPage(f.authority,source,{offset:-1}),/MODEL_SETTINGS_PAGE_INVALID/);
  assert.throws(()=>modelSettingsPage(f.authority,source,{draft_id:'draft',revision:1}),/MODEL_SETTINGS_PAGE_INVALID/);
});


test('usage summary participates in the existing UTF-8 page budget',()=>{
  const f=fixture(10);for(const role of f.roles)role.model_id='依米'.repeat(400);
  const usage={environment:'test',owner:'owner',local_date:'2026-10-24',attempts:2,known_cny:1,estimated_cny:2,
    estimate_note:'按配置标准价估算，不含时段折扣，不是账单。',unknown_attempts:1,foreign_currency_attempts:0,subscription_remaining:'套餐余量未知',threshold_cny:10,pause_on_limit:false,paused:false,owner_reserve_cny:1,resumed_local_date:null};
  const page=modelSettingsPage(f.authority,source,{},usage);
  assert.deepEqual(page.usage,usage);assert.ok(page.next_offset!==null);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<=8000);
});
