import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelSettingsAuthority} from '../src/model-settings.ts';
test('trusted projection CLI imports only explicit same-environment versioned price facts',()=>{
 const home=mkdtempSync(join(tmpdir(),'model-price-cli-')),master=Buffer.alloc(32,9),masterFile=join(home,'master'),priceFile=join(home,'prices.json');
 writeFileSync(masterFile,master,{mode:0o600});
 const directory=join(home,'authority'),authority=ModelSettingsAuthority.open(directory,{environment_id:'test',master_key:master});
 authority.bootstrap({providers:[{id:'custom',display_name:'Custom',wire_protocol:'chat_completions',base_url:'https://example.test/v1',credential_ref:null}],
  roles:[{id:'brain',profile:'owner',provider_ref:'custom',model_id:'model',parameters:{context_limit:32768,max_output_tokens:16},ordered_fallbacks:[],activation_boundary:'brain_idle'}]});authority.close();
 const price={environment:'test',provider_id:'custom',model_id:'model',currency:'CNY',price_version:'synthetic-v1',source:'Synthetic test only',
  updated_at:'2026-10-23T00:00:00.000Z',input_per_million:2,output_per_million:3,cache_read_per_million:0,cache_write_per_million:0,input_tokens_include_cache:true};
 const cli=fileURLToPath(new URL('../../../../../deploy/cloud/model-settings-project.ts',import.meta.url));
 const run=()=>spawnSync(process.execPath,[cli,'--directory',directory,'--master',masterFile,'--environment','test','--output',join(home,'projection'),
  '--profile','owner','--revision','1','--group','brain','--prices',priceFile],{encoding:'utf8'});
 try{
  writeFileSync(priceFile,JSON.stringify([price]));const result=run();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).configured,true);
  const reopened=ModelSettingsAuthority.open(directory,{environment_id:'test',master_key:master});
  try{assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM model_usage_prices').get()!.n,1);}finally{reopened.close();}
  writeFileSync(priceFile,JSON.stringify([{...price,environment:'other'}]));const rejected=run();assert.equal(rejected.status,1);assert.match(rejected.stderr,/USAGE_PRICE_ENVIRONMENT_INVALID/);
 }finally{rmSync(home,{recursive:true,force:true});}
});
