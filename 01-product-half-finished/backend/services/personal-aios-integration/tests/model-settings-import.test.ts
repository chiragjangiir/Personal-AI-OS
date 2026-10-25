import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
import {loadModelSettingsImport} from '../src/model-settings-import.ts';
import {projectModelSettings,writeModelSettingsProjection} from '../src/model-settings-projection.ts';
import {auxiliaryModelRoles} from '../src/model-settings-contract.ts';

const fixture=new URL('../../../../../deploy/cloud/model-settings-import.example.json',import.meta.url);
test('explicit import keeps approved routes and complete source role registration',()=>{
  const snapshot=loadModelSettingsImport(fixture);
  assert.equal(snapshot.roles.find(role=>role.profile==='owner'&&role.id==='brain')?.model_id,'deepseek-flash');
  assert.equal(snapshot.roles.find(role=>role.profile==='owner'&&role.id==='delegation')?.model_id,'deepseek-v4.1-flash');
  assert.deepEqual(snapshot.roles.find(role=>role.profile==='builder'&&role.id==='auxiliary.compression'),{
    id:'auxiliary.compression',profile:'builder',provider_ref:'paios-builder',model_id:'deepseek-v4.1-flash',
    parameters:{},ordered_fallbacks:[],activation_boundary:'build_idle'});
  assert.equal(snapshot.roles.filter(role=>role.profile==='executor').length,6);
  assert.ok(snapshot.roles.filter(role=>role.profile==='executor'||role.profile==='local').every(role=>role.read_only));
  assert.notEqual(snapshot.roles.find(role=>role.profile==='executor'&&role.id==='executor.fast.manager')?.provider_ref,
    snapshot.roles.find(role=>role.profile==='owner'&&role.id==='brain')?.provider_ref);
});
test('a staging profile disables every absent native task instead of inheriting the brain route',()=>{
  const directory=mkdtempSync(join(tmpdir(),'model-stage-roles-'));
  const authority=ModelSettingsAuthority.open(directory,{environment_id:'staging-fixture',master_key:Buffer.alloc(32,7)});
  try{
    authority.bootstrap({providers:[{id:'stage',display_name:'Stage',wire_protocol:'chat_completions',
      base_url:'https://stage.example/v1',credential_ref:'stage'}],roles:[{id:'brain',profile:'owner',provider_ref:'stage',model_id:'stage-model',
      parameters:{context_limit:262144,max_output_tokens:16},ordered_fallbacks:[],activation_boundary:'brain_idle'}]}, {stage:'fake-stage-key'});
    const projection=projectModelSettings(authority,'owner',1,'brain');
    const config=projection.config as Record<string,any>;
    assert.equal(projection.configured,true);
    assert.equal(config.delegation.enabled,false);
    assert.equal(config.cron.enabled,false);
    for(const role of auxiliaryModelRoles)assert.equal(config.auxiliary[role].enabled,false);
    assert.deepEqual(Object.keys(config.providers),['stage']);
  }finally{authority.close();rmSync(directory,{recursive:true,force:true});}
});
test('operator import CLI reads keys only from stdin and exports redacted projections',()=>{
  const directory=mkdtempSync(join(tmpdir(),'model-import-cli-'));
  try{
    const master=join(directory,'master.key');writeFileSync(master,Buffer.alloc(32,5),{mode:0o600});
    const cli=new URL('../../../../../deploy/cloud/model-settings-project.ts',import.meta.url);
    const result=spawnSync(process.execPath,[cli.pathname,'--directory',join(directory,'db'),'--master',master,
      '--environment','staging-fixture','--output',join(directory,'output'),'--profile','owner','--revision','1',
      '--group','brain','--import',fixture.pathname,'--keys-stdin'],{encoding:'utf8',
      input:JSON.stringify({deepseek:'fake-deepseek-key',opencode:'fake-opencode-key',siliconflow:'fake-siliconflow-key'})});
    assert.equal(result.status,0,result.stderr);
    assert.ok(!result.stdout.includes('fake-')&&!result.stderr.includes('fake-'));
    assert.equal(JSON.parse(result.stdout).published,false);
    const revision=join(directory,'output/revisions/1/owner.json');
    assert.equal(statSync(revision).mode&0o777,0o400);
    assert.ok(!readFileSync(revision,'utf8').includes('fake-'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('authority projections preserve imported native facts and prepare immutable revisions before publish',()=>{
  const directory=mkdtempSync(join(tmpdir(),'model-import-'));
  const authority=ModelSettingsAuthority.open(directory,{environment_id:'production',master_key:Buffer.alloc(32,7)});
  try{
    const snapshot=loadModelSettingsImport(fixture);
    authority.bootstrap(snapshot,{'deepseek':'fake-deepseek-key','opencode':'fake-opencode-key','siliconflow':'fake-siliconflow-key'});
    const expected=JSON.parse(readFileSync(new URL('./fixtures/model-settings-native-import.json',import.meta.url),'utf8'));
    for(const [profile,group] of [['owner','brain'],['workshop','build'],['builder','build']] as const){
      const projection=projectModelSettings(authority,profile,1,group);
      const config=structuredClone(projection.config) as Record<string,any>;
      const scrub=(value:any):any=>Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?
        Object.fromEntries(Object.entries(value).filter(([key])=>key!=='key_env').map(([key,item])=>[key,scrub(item)])):value;
      assert.deepEqual(scrub(config),expected[profile]);
      assert.equal(projection.configured,true);
      if(profile==='builder'){
        assert.deepEqual(authority.resolve('production','builder','auxiliary.compression',1).parameters,{});
        assert.deepEqual(config.auxiliary.compression.extra_body,{});
        assert.deepEqual(config.auxiliary.compression.fallback_chain,[]);
        assert.equal(config.auxiliary.compression.context_length,undefined);
        assert.equal(config.model.request_overrides.max_tokens,8192);
      }
      assert.ok(!JSON.stringify(projection).includes('fake-'));
      assert.equal(new Set(projection.credentials.map(value=>value.name)).size,projection.credentials.length);
    }
    writeModelSettingsProjection(authority,join(directory,'exports'),'owner',1,'brain',false);
    assert.throws(()=>readFileSync(join(directory,'exports/current.json')));
    writeModelSettingsProjection(authority,join(directory,'exports'),'owner',1,'brain',true);
    assert.equal(JSON.parse(readFileSync(join(directory,'exports/current.json'),'utf8')).revision,1);
    const actor={principal_id:'owner',device_id:'phone'};
    const changed={...snapshot.providers.find(provider=>provider.id==='deepseek-paios')!,base_url:'https://edited.example/v1'};
    const draft=authority.draft(actor,{expected_revision:1,providers:[changed]});
    assert.equal(authority.getDraft(actor,draft.draft_id).snapshot.providers.find(provider=>provider.id===changed.id)?.base_url,
      'https://edited.example/v1');
    assert.equal(authority.resolve('production','executor','executor.fast.manager',1).provider?.base_url,'https://api.deepseek.com');
  }finally{authority.close();rmSync(directory,{recursive:true,force:true});}
});
