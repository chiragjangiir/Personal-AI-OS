import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {ModelUsage} from '../src/model-usage.ts';
import type {ModelSnapshot} from '../src/model-settings-contract.ts';

const actor={device_id:'phone',principal_id:'owner'};
const seed:ModelSnapshot={providers:[{id:'custom',display_name:'Custom',wire_protocol:'chat_completions',base_url:'https://models.example.com/v1',credential_ref:'credential-custom'}],
  roles:[{id:'brain',profile:'owner',provider_ref:'custom',model_id:'initial',parameters:{context_limit:32768,max_output_tokens:16},ordered_fallbacks:[],activation_boundary:'brain_idle'}]};
function fixture(activate=async()=>{}){const home=mkdtempSync(join(tmpdir(),'model-settings-test-')),options={environment_id:'test',master_key:Buffer.alloc(32,7),activate};
  const authority=ModelSettingsAuthority.open(home,options);authority.bootstrap(seed,{'credential-custom':'fake-current-key-1234'});
  return {home,options,authority,close(){authority.close();rmSync(home,{recursive:true,force:true});}};}
const changed=(id:string):ModelSnapshot=>({...structuredClone(seed),roles:[{...seed.roles[0]!,model_id:id}]});
test('settings probe uses one durable attempt, pause rejects before inference, and ledger replay does not duplicate',async()=>{
  const home=mkdtempSync(join(tmpdir(),'model-settings-probe-'));let usage:ModelUsage,calls=0;
  const authority=ModelSettingsAuthority.open(home,{environment_id:'test',master_key:Buffer.alloc(32,7),probeUsage:()=>usage,
    probe:async input=>{calls++;assert.equal(usage.recentAttempts('test','owner')[0]!.status,'started');
      return {status:'passed',http_status:200,safe_error:null,trace_id:input.trace_id!,actual_model:input.model_id,latency_ms:1,
        usage:{input_tokens:4,output_tokens:1},max_output_tokens:16,fallback_activated:false};}});
  try{
    usage=new ModelUsage(authority.db,{notify:async()=>{}});authority.bootstrap(seed,{'credential-custom':'fake-probe-key-1234'});
    const draft=authority.draft(actor,{expected_revision:1,...changed('probe-model')}),request={draft_id:draft.draft_id,profile:'owner',role:'brain'};
    usage.setPausePolicy('test','owner',true);usage.pause('test','owner');
    await assert.rejects(authority.testConnection(actor,request),/MODEL_USAGE_PAUSED/);assert.equal(calls,0);assert.equal(usage.summary('test','owner').attempts,0);
    usage.resume('test','owner');const result=await authority.testConnection(actor,request);
    const fact=usage.recentAttempts('test','owner')[0]!;assert.equal(calls,1);assert.equal(fact.attempt_id,result.trace_id);
    assert.equal(fact.status,'completed');assert.equal(fact.owner_chat,false);assert.equal(fact.cost.kind,'unknown');
    assert.equal(fact.source_context?.kind,'settings_probe');await usage.record(fact);assert.equal(usage.summary('test','owner').attempts,1);
  }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});
test('real connection probe retains cache usage and prices it with the frozen provider billing default',async t=>{
 const home=mkdtempSync(join(tmpdir(),'model-settings-probe-price-'));let usage:ModelUsage;
 const authority=ModelSettingsAuthority.open(home,{environment_id:'test',master_key:Buffer.alloc(32,7),probeUsage:()=>usage,
   allow_private_hosts:['api.deepseek.com']});
 t.after(()=>{authority.close();rmSync(home,{recursive:true,force:true});});
 const snapshot:ModelSnapshot={providers:[{...seed.providers[0]!,base_url:'https://api.deepseek.com/v1'}],
   roles:[{...seed.roles[0]!,model_id:'deepseek-flash'}]};
 authority.bootstrap(snapshot,{'credential-custom':'fake-probe-key'});
 usage=new ModelUsage(authority.db,{notify:async()=>{}});
 usage.setPrices([{environment:'test',provider_id:'custom',model_id:'deepseek-flash',currency:'CNY',price_version:'legacy',source:'Fixture standard rate',
   updated_at:'2026-10-25T00:00:00.000Z',input_per_million:2,output_per_million:8,cache_read_per_million:0.04,cache_write_per_million:0,input_tokens_include_cache:true}]);
 t.mock.method(globalThis,'fetch',async()=>Response.json({model:'deepseek-flash',usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:20}}}));
 const draft=authority.draft(actor,{expected_revision:1,...snapshot});
 const result=await authority.testConnection(actor,{draft_id:draft.draft_id,profile:'owner',role:'brain'});
 assert.equal(result.status,'passed');assert.equal(result.usage!.cached_tokens,20);
 const fact=usage.recentAttempts('test','owner')[0]!;
 assert.equal(fact.status,'completed');assert.equal(fact.cache_read_tokens,20);assert.equal(fact.cache_write_tokens,0);
 assert.deepEqual(fact.cost,{kind:'estimated',amount:0.000241,currency:'CNY'});
});
test('model settings CAS, nonce idempotence, safe idle and restart bind complete generations',async()=>{
  const f=fixture();try{
    const first=f.authority.draft(actor,{expected_revision:1,...changed('new')}),second=f.authority.draft(actor,{expected_revision:1,...changed('other')});
    const receipt=f.authority.commitDraft(actor,first.draft_id,'nonce-1');
    assert.equal(receipt.desired,2);assert.equal(f.authority.read().groups.brain.effective,1);
    assert.deepEqual(f.authority.commitDraft(actor,first.draft_id,'nonce-1'),receipt);
    assert.throws(()=>f.authority.commitDraft(actor,second.draft_id,'nonce-2'),/MODEL_SETTINGS_REVISION_CONFLICT/);
    assert.equal((await f.authority.activateIdle('brain',false)).status,'pending');
    f.authority.close();const recovered=ModelSettingsAuthority.open(f.home,f.options);
    assert.equal(recovered.read().desired,2);assert.equal(recovered.resolve('test','owner','brain',1).model_id,'initial');
    assert.equal((await recovered.activateIdle('brain',true)).status,'effective');
    assert.equal(recovered.resolve('test','owner','brain',2).parameters.context_limit,32768);recovered.close();
  }finally{f.close();}
});
test('failed activation retains old effective; undo is a new reverse revision',async()=>{
  const f=fixture(async()=>{throw Error('upstream may echo fake-current-key-1234');});try{
    const draft=f.authority.draft(actor,{expected_revision:1,...changed('new')});f.authority.commitDraft(actor,draft.draft_id,'change');
    const result=await f.authority.activateIdle('brain',true);assert.equal(result.status,'failed');assert.equal(result.effective,1);
    assert.ok(!JSON.stringify(result).includes('fake-current'));
    const undo=f.authority.draft(actor,{action:'undo',expected_revision:2,revision:1});const resultUndo=f.authority.commitDraft(actor,undo.draft_id,'undo');
    assert.equal(resultUndo.desired,3);assert.equal(f.authority.resolve('test','owner','brain',3).model_id,'initial');
  }finally{f.close();}
});
test('current-only AEAD vault never reports replaced-key undo success or returns secrets',async()=>{
  const f=fixture();try{
    const key=f.authority.keyDraft(actor,{expected_revision:1,credential_ref:'credential-custom',key:'fake-replacement-key-9876'});
    assert.ok(!JSON.stringify(key).includes('fake-replacement'));f.authority.commitDraft(actor,key.draft_id,'rotate');await f.authority.activateIdle('brain',true);
    assert.throws(()=>f.authority.draft(actor,{action:'undo',expected_revision:2,revision:1}),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/);
    const publicState=JSON.stringify(f.authority.read());assert.ok(!publicState.includes('fake-'));assert.ok(!publicState.includes('ciphertext'));
    const credential=f.authority.read().credentials['credential-custom'];assert.ok(credential);
    assert.deepEqual(credential,{configured:true,last4:'9876',updated_at:credential.updated_at,test_status:'untested'});
    assert.equal(f.authority.db.prepare('SELECT COUNT(*) n FROM model_credentials').get()!.n,1);
    assert.ok(!readFileSync(join(f.home,'model-settings.sqlite3')).includes(Buffer.from('fake-current-key')));
  }finally{f.close();}
});
test('resolution rejects environment mixing, inheritance cycles, unknown parameters and local edits',()=>{
  const f=fixture();try{
    assert.throws(()=>f.authority.resolve('production','owner','brain',1),/MODEL_SETTINGS_ENVIRONMENT_MISMATCH/);
    const snapshot=changed('other');snapshot.roles[0]!.parameters={bogus:1} as never;
    assert.throws(()=>f.authority.draft(actor,{expected_revision:1,...snapshot}),/MODEL_SETTINGS_PARAMETERS_INVALID/);
    const {provider_ref,model_id,...inherited}=seed.roles[0]!;snapshot.roles[0]={...inherited,inherit_from:'brain'};
    assert.throws(()=>f.authority.draft(actor,{expected_revision:1,...snapshot}),/MODEL_SETTINGS_INHERITANCE_CYCLE/);
  }finally{f.close();}
});
test('draft changes preserve complete imported roles and credential handles cannot cross profiles',()=>{
  const home=mkdtempSync(join(tmpdir(),'model-settings-import-'));
  const authority=ModelSettingsAuthority.open(home,{environment_id:'staging-fixture',master_key:Buffer.alloc(32,8)});
  try{
    const readonly={...seed.roles[0]!,profile:'executor',id:'executor.fast.manager',read_only:true,activation_boundary:'read_only' as const};
    authority.bootstrap({...seed,roles:[...seed.roles,readonly, {...seed.roles[0]!,profile:'workshop'}]}, {'credential-custom':'fake-profile-key-3456'});
    const draft=authority.draft(actor,{expected_revision:1,roles:[{...seed.roles[0]!,model_id:'updated'}]});
    assert.equal(authority.getDraft(actor,draft.draft_id).snapshot.roles.length,3);
    authority.commitDraft(actor,draft.draft_id,'patch');
    assert.equal(authority.resolve('staging-fixture','executor','executor.fast.manager',2).model_id,'initial');
    const main=authority.resolve('staging-fixture','owner','brain',2),build=authority.resolve('staging-fixture','workshop','brain',2);
    assert.notEqual(main.credential_handle,build.credential_handle);
    assert.throws(()=>authority.credential({environment_id:'staging-fixture',profile:'owner',revision:2,handle:build.credential_handle!}),/MODEL_SETTINGS_CREDENTIAL_SCOPE_DENIED/);
    assert.equal(authority.credential({environment_id:'staging-fixture',profile:'workshop',revision:2,handle:build.credential_handle!}),'fake-profile-key-3456');
    assert.throws(()=>authority.draft(actor,{expected_revision:2,roles:[{...readonly,model_id:'should-not-change'}]}),/MODEL_SETTINGS_ROLE_READ_ONLY/);
  }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});
test('first setup and a new provider can register a write-only opaque credential before binding it',()=>{
  const home=mkdtempSync(join(tmpdir(),'model-settings-first-')),authority=ModelSettingsAuthority.open(home,{environment_id:'new-owner',master_key:Buffer.alloc(32,9)});
  try{
    const key=authority.keyDraft(actor,{expected_revision:0,credential_ref:'credential-custom',key:'fake-first-key-3456'});
    authority.commitDraft(actor,key.draft_id,'first-key');
    const draft=authority.draft(actor,{expected_revision:1,...seed});authority.commitDraft(actor,draft.draft_id,'first-model');
    assert.equal(authority.read().desired,2);assert.equal(authority.resolve('new-owner','owner','brain',2).credential_version,1);
    assert.ok(!JSON.stringify(authority.read()).includes('fake-first'));
  }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});

test('desired key stays staged through busy/failure/restart; promotion waits for all affected groups',async()=>{
 const home=mkdtempSync(join(tmpdir(),'model-key-stage-'));let busy=true,broken=false;
 const options={environment_id:'test',master_key:Buffer.alloc(32,5),activate:async()=>{if(busy)throw Object.assign(Error('busy'),{code:'MODEL_SETTINGS_BUSY'});if(broken)throw Error('failed');}};
 let authority=ModelSettingsAuthority.open(home,options);
 try{
  authority.bootstrap({...seed,roles:[...seed.roles,{...seed.roles[0]!,profile:'workshop',activation_boundary:'build_idle'}]}, {'credential-custom':'fake-old-key-1234'});
  const old=authority.resolve('test','owner','brain',1),key=authority.keyDraft(actor,{expected_revision:1,credential_ref:'credential-custom',key:'fake-next-key-9876'});
  authority.commitDraft(actor,key.draft_id,'key');const next=authority.resolve('test','owner','brain',2);
  const reveal=(revision:number,handle:string)=>authority.credential({environment_id:'test',profile:'owner',revision,handle});
  assert.equal(reveal(1,old.credential_handle!),'fake-old-key-1234');assert.equal(reveal(2,next.credential_handle!),'fake-next-key-9876');
  assert.equal((await authority.activateIdle('brain',true)).status,'pending');busy=false;broken=true;
  assert.equal((await authority.activateIdle('brain',true)).status,'failed');assert.equal(reveal(1,old.credential_handle!),'fake-old-key-1234');
  authority.close();authority=ModelSettingsAuthority.open(home,options);assert.equal(reveal(1,old.credential_handle!),'fake-old-key-1234');
  broken=false;await authority.activateIdle('brain',true);assert.equal(reveal(1,old.credential_handle!),'fake-old-key-1234');
  await authority.activateIdle('build',true);assert.equal(reveal(2,next.credential_handle!),'fake-next-key-9876');
  assert.throws(()=>reveal(1,old.credential_handle!),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/);
  assert.throws(()=>authority.draft(actor,{action:'undo',expected_revision:2,revision:1}),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/);
  assert.equal(authority.db.prepare('SELECT COUNT(*) n FROM model_credentials').get()!.n,1);
  assert.ok(!(authority.db.prepare('SELECT body FROM model_drafts').all() as {body:string}[]).some(row=>row.body.includes('ciphertext')));
 }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});
test('undo before key activation cancels staged key; unused read-only providers never dirty active groups',async()=>{
 const f=fixture();try{
  const key=f.authority.keyDraft(actor,{expected_revision:1,credential_ref:'credential-custom',key:'fake-cancelled-key-5678'});f.authority.commitDraft(actor,key.draft_id,'key');
  const undo=f.authority.draft(actor,{action:'undo',expected_revision:2,revision:1});f.authority.commitDraft(actor,undo.draft_id,'undo');await f.authority.activateIdle('brain',true);
  const value=f.authority.resolve('test','owner','brain',3);assert.equal(f.authority.credential({environment_id:'test',profile:'owner',revision:3,handle:value.credential_handle!}),'fake-current-key-1234');
  assert.ok(!(f.authority.db.prepare('SELECT body FROM model_drafts').all() as {body:string}[]).some(row=>row.body.includes('ciphertext')));
  const before=f.authority.read().groups;const draft=f.authority.draft(actor,{expected_revision:3,providers:[{id:'unused',display_name:'Unused',wire_protocol:'chat_completions',base_url:'https://unused.example.com',credential_ref:null}],roles:[]});
  f.authority.commitDraft(actor,draft.draft_id,'unused');assert.deepEqual(f.authority.read().groups,before);
 }finally{f.close();}
});
test('overlapping rotations preserve each effective group generation until final promotion',async()=>{
 const f=fixture();try{
  const install=f.authority.draft(actor,{expected_revision:1,roles:[{...seed.roles[0]!,profile:'workshop',activation_boundary:'build_idle'}]});
  f.authority.commitDraft(actor,install.draft_id,'build');await f.authority.activateIdle('build',true);
  const first=f.authority.keyDraft(actor,{expected_revision:2,credential_ref:'credential-custom',key:'fake-second-key-2222'});f.authority.commitDraft(actor,first.draft_id,'first');
  await f.authority.activateIdle('brain',true);const middle=f.authority.resolve('test','owner','brain',3);
  const second=f.authority.keyDraft(actor,{expected_revision:3,credential_ref:'credential-custom',key:'fake-third-key-3333'});f.authority.commitDraft(actor,second.draft_id,'second');
  assert.equal(f.authority.credential({environment_id:'test',profile:'owner',revision:3,handle:middle.credential_handle!}),'fake-second-key-2222');
  await f.authority.activateIdle('build',true);
  assert.equal(f.authority.credential({environment_id:'test',profile:'owner',revision:3,handle:middle.credential_handle!}),'fake-second-key-2222');
  await f.authority.activateIdle('brain',true);assert.throws(()=>f.authority.credential({environment_id:'test',profile:'owner',revision:3,handle:middle.credential_handle!}),/MODEL_SETTINGS_KEY_REENTRY_REQUIRED/);
 }finally{f.close();}
});
test('native acknowledgement remains effective when pointer publication fails; restart preserves truth',async()=>{
 const home=mkdtempSync(join(tmpdir(),'model-pointer-')),options={environment_id:'test',master_key:Buffer.alloc(32,3),activate:async()=>{},onEffective:()=>{throw Error('disk');}};
 let authority=ModelSettingsAuthority.open(home,options);
 try{
  authority.bootstrap(seed,{'credential-custom':'fake-key-1234'});const draft=authority.draft(actor,{expected_revision:1,...changed('new')});authority.commitDraft(actor,draft.draft_id,'change');
  const state=await authority.activateIdle('brain',true);assert.equal(state.status,'effective');assert.equal(state.effective,2);assert.equal(state.error,'MODEL_SETTINGS_PROJECTION_PUBLISH_FAILED');
  authority.close();authority=ModelSettingsAuthority.open(home,options);assert.equal(authority.read().groups.brain.effective,2);
 }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});
test('test receipts cannot mark a different live generation passed and route commit invalidates prior test',async()=>{
 const home=mkdtempSync(join(tmpdir(),'model-tests-')),authority=ModelSettingsAuthority.open(home,{environment_id:'test',master_key:Buffer.alloc(32,4),probe:async input=>({status:'passed',latency_ms:1,http_status:200,safe_error:null,trace_id:input.trace_id!,actual_model:input.model_id,usage:null,max_output_tokens:16,fallback_activated:false})});
 try{
  authority.bootstrap(seed,{'credential-custom':'fake-key-1234'});
  const matching=authority.draft(actor,{expected_revision:1,roles:[]});await authority.testConnection(actor,{draft_id:matching.draft_id,profile:'owner',role:'brain'});
  const tested=authority.read().credentials['credential-custom'];assert.ok(tested);assert.equal(tested.test_status,'passed');
  const change=authority.draft(actor,{expected_revision:1,...changed('other')});authority.commitDraft(actor,change.draft_id,'route');
  const changedCredential=authority.read().credentials['credential-custom'];assert.ok(changedCredential);assert.equal(changedCredential.test_status,'untested');
  await authority.testConnection(actor,{draft_id:matching.draft_id,profile:'owner',role:'brain'});const currentCredential=authority.read().credentials['credential-custom'];assert.ok(currentCredential);assert.equal(currentCredential.test_status,'untested');
 }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});
test('inherited source model changes dirty each consuming activation group',()=>{
 const f=fixture();try{
  const base={...seed.roles[0]!,id:'base',activation_boundary:'build_idle' as const};
  const child={id:'child',profile:'owner',inherit_from:'base',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle' as const};
  const draft=f.authority.draft(actor,{expected_revision:1,roles:[base,child]});f.authority.commitDraft(actor,draft.draft_id,'inherit');
  const changed=f.authority.draft(actor,{expected_revision:2,roles:[{...base,model_id:'new-base'}]});f.authority.commitDraft(actor,changed.draft_id,'base-change');
  assert.equal(f.authority.read().groups.brain.desired,3);assert.equal(f.authority.read().groups.build.desired,3);
 }finally{f.close();}
});
test('an inherited disabled route does not require a credential for an inactive model',()=>{
 const home=mkdtempSync(join(tmpdir(),'model-disabled-')),authority=ModelSettingsAuthority.open(home,{environment_id:'test',master_key:Buffer.alloc(32,2)});
 try{
  authority.bootstrap({...seed,roles:[{...seed.roles[0]!,id:'base',disabled:true},{id:'child',profile:'owner',inherit_from:'base',parameters:{},ordered_fallbacks:[],activation_boundary:'brain_idle'}]});
  const draft=authority.draft(actor,{expected_revision:1,providers:[{...seed.providers[0]!,display_name:'Changed label'}],roles:[]});
  authority.commitDraft(actor,draft.draft_id,'disabled');assert.equal(authority.resolve('test','owner','child',2).disabled,true);
 }finally{authority.close();rmSync(home,{recursive:true,force:true});}
});
for(const failure of ['throws','busy'] as const)test(`checkpoint ${failure} after key promotion keeps saved/effective truth and retries cleanup`,async t=>{
 const f=fixture();try{
  const prepare=f.authority.db.prepare.bind(f.authority.db);
  const fault=t.mock.method(f.authority.db,'prepare',(sql:string)=>{
    if(sql==='PRAGMA wal_checkpoint(TRUNCATE)'){
      if(failure==='throws')throw Error('disk error may contain fake-secret-DO-NOT-EXPOSE');return {get:()=>({busy:1})} as never;
    }
    return prepare(sql);
  });
  const key=f.authority.keyDraft(actor,{expected_revision:1,credential_ref:'credential-custom',key:'fake-new-key-9876'});
  const receipt=f.authority.commitDraft(actor,key.draft_id,'key');assert.equal(receipt.desired,2);
  const state=await f.authority.activateIdle('brain',true);
  assert.equal(state.status,'effective');assert.equal(state.effective,2);assert.equal(state.error,'MODEL_SETTINGS_VAULT_CLEANUP_FAILED');
  assert.ok(!JSON.stringify(f.authority.read()).includes('fake-secret'));
  assert.ok(f.authority.db.prepare("SELECT 1 FROM meta WHERE key='keys_cleanup_pending'").get());
  const next=f.authority.resolve('test','owner','brain',2);
  assert.equal(f.authority.credential({environment_id:'test',profile:'owner',revision:2,handle:next.credential_handle!}),'fake-new-key-9876');
  assert.equal(f.authority.commitDraft(actor,key.draft_id,'key').desired,2);
  fault.mock.restore();
  if(failure==='busy'){
    f.authority.close();const recovered=ModelSettingsAuthority.open(f.home,f.options);
    try{assert.equal(recovered.read().groups.brain.effective,2);assert.equal(recovered.read().groups.brain.error,null);
      assert.equal(recovered.db.prepare("SELECT 1 FROM meta WHERE key='keys_cleanup_pending'").get(),undefined);}finally{recovered.close();}
  }else{
    assert.equal(f.authority.checkpointPendingKeys(),true);assert.equal(f.authority.read().groups.brain.error,null);
    assert.equal(f.authority.db.prepare("SELECT 1 FROM meta WHERE key='keys_cleanup_pending'").get(),undefined);
  }
 }finally{f.close();}
});

test('cleanup failure after a committed orphan credential returns saved receipt and preserves idempotence',t=>{
 const f=fixture();try{
  const prepare=f.authority.db.prepare.bind(f.authority.db);
  t.mock.method(f.authority.db,'prepare',(sql:string)=>{if(sql==='PRAGMA wal_checkpoint(TRUNCATE)')throw Error('checkpoint');return prepare(sql);});
  const draft=f.authority.keyDraft(actor,{expected_revision:1,credential_ref:'new-provider',key:'fake-orphan-key-1234'});
  const saved=f.authority.commitDraft(actor,draft.draft_id,'committed');assert.equal(saved.desired,2);
  assert.equal(saved.groups.brain.error,'MODEL_SETTINGS_VAULT_CLEANUP_FAILED');
  assert.equal(f.authority.commitDraft(actor,draft.draft_id,'committed').desired,2);
  assert.equal(f.authority.db.prepare('SELECT COUNT(*) n FROM model_revisions').get()!.n,2);
 }finally{f.close();}
});
