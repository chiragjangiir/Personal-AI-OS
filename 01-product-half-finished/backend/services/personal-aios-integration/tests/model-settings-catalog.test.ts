import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import type {ModelProvider} from '../src/model-settings-contract.ts';

const source={device_id:'phone',principal_id:'owner'},now=Date.parse('2026-10-24T12:00:00.000Z');
const provider:ModelProvider={id:'custom',display_name:'Custom',wire_protocol:'chat_completions',base_url:'https://127.0.0.1/v1',credential_ref:'custom',catalog_capability:'models'};
function fixture(t:test.TestContext,selected=provider){
 const home=mkdtempSync(join(tmpdir(),'model-catalog-')),authority=ModelSettingsAuthority.open(home,{environment_id:'test',master_key:Buffer.alloc(32,7),now:()=>now,allow_private_hosts:['127.0.0.1']});
 t.after(()=>{authority.close();rmSync(home,{recursive:true,force:true});});
 authority.bootstrap({providers:[selected],roles:[]},{custom:'fake-current-key'});
 const draft=authority.keyDraft(source,{expected_revision:1,credential_ref:'custom',key:'fake-draft-key'});
 const read=(offset=0)=>authority.catalog(source,{draft_id:draft.draft_id,provider_ref:'custom',offset});
 return {authority,draft,read};
}
test('catalog reads frozen provider and staged key server-side, pages IDs, and returns only safe provenance',async t=>{
 const f=fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
  calls++;assert.equal(url.href,'https://127.0.0.1/v1/models');assert.equal(init.method,undefined);
  assert.deepEqual(init.headers,{Authorization:'Bearer fake-draft-key'});assert.equal(init.redirect,'error');
  return Response.json({data:Array.from({length:19},(_,i)=>({id:`vendor/model-${i}`,headers:{Authorization:'fake-draft-key'},secret:'fake-draft-key'}))});
 });
 const first=await f.read();assert.equal(first.status,'available');assert.equal(first.source,'provider_models_api');assert.equal(first.fetched_at,new Date(now).toISOString());
 assert.equal(first.credential_ref,'custom');assert.equal(first.credential_version,2);assert.equal(first.next_offset,16);assert.equal(first.models.length,16);
 const second=await f.read(first.next_offset!);assert.equal(second.models.length,3);assert.equal(second.next_offset,null);assert.equal(calls,2);
 assert.equal(f.authority.read().desired,1);assert.ok(!JSON.stringify(first).includes('fake-draft-key'));assert.ok(!JSON.stringify(first).includes('Authorization'));
 await assert.rejects(f.authority.catalog({...source,device_id:'other'},{draft_id:f.draft.draft_id,provider_ref:'custom'}),/MODEL_SETTINGS_DRAFT_SOURCE_MISMATCH/);
});
test('provider explicit no-list and model-list 404 are distinct from authorization and transport failures',async t=>{
 const f=fixture(t);let status=404;
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{message:'fake-draft-key',headers:{Authorization:'fake-draft-key'}}},{status}));
 const missing=await f.read();assert.equal(missing.status,'unavailable');assert.equal(missing.source,'provider_no_list');assert.equal(missing.message,'服务商未提供模型列表，可填写模型 ID');
 status=401;const rejected=await f.read();assert.equal(rejected.status,'failed');assert.equal(rejected.safe_error,'MODEL_SETTINGS_CATALOG_FAILED');assert.equal(rejected.message,null);
 assert.ok(!JSON.stringify(rejected).includes('fake-draft-key'));
 const unavailable=fixture(t,{...provider,catalog_capability:'unavailable'});
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('no network when provider has no list');});
 assert.equal((await unavailable.read()).status,'unavailable');
});
test('Anthropic uses its native list headers and pagination; malformed or credential-echo payloads never leak',async t=>{
 const f=fixture(t,{...provider,wire_protocol:'anthropic_messages'});let calls=0;
 t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
  assert.deepEqual(init.headers,{'x-api-key':'fake-draft-key','anthropic-version':'2023-06-01'});calls++;
  if(calls===1)return Response.json({data:[{id:'model-a',display_name:'Model A'}],has_more:true,last_id:'model-a'});
  assert.equal(url.searchParams.get('after_id'),'model-a');return Response.json({data:[{id:'model-b'}],has_more:false});
 });
 assert.deepEqual((await f.read()).models,[{id:'model-a',display_name:'Model A'},{id:'model-b'}]);
 t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{id:'fake-draft-key'}]}));
 const invalid=await f.read();assert.equal(invalid.status,'failed');assert.deepEqual(invalid.models,[]);assert.ok(!JSON.stringify(invalid).includes('fake-draft-key'));
});
test('Unicode catalog pages stay under the formal byte budget',async t=>{
 const f=fixture(t);
 t.mock.method(globalThis,'fetch',async()=>Response.json({data:Array.from({length:20},(_,i)=>({id:String(i)+'模'.repeat(190),display_name:'型'.repeat(200)}))}));
 const page=await f.read();assert.equal(page.status,'available');assert.ok(page.models.length<16);assert.ok(page.next_offset);assert.ok(Buffer.byteLength(JSON.stringify(page))<=8000);
});
