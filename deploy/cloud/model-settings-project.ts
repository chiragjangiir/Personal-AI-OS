#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {ModelUsage,type ModelPriceFact} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-usage.ts';
import {ModelSettingsAuthority} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings.ts';
import {loadModelSettingsImport} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings-import.ts';
import {writeModelSettingsProjection} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings-projection.ts';

/** Trusted deployment import/export. Raw provider keys are accepted only on stdin and never echoed. */
function main(){
  const {values}=parseArgs({options:{directory:{type:'string'},master:{type:'string'},environment:{type:'string'},
    output:{type:'string'},profile:{type:'string'},revision:{type:'string'},group:{type:'string'},
    import:{type:'string'},prices:{type:'string'},'keys-stdin':{type:'boolean'},publish:{type:'boolean'},
    bootstrap:{type:'boolean'}}});
  for(const key of ['directory','master','environment','output','profile','revision','group'] as const)
    if(!values[key])throw Error('MODEL_SETTINGS_CLI_ARGUMENT_REQUIRED');
  if(values.group!=='brain'&&values.group!=='build')throw Error('MODEL_SETTINGS_CLI_GROUP_INVALID');
  if(values.bootstrap&&!values.import)throw Error('MODEL_SETTINGS_CLI_IMPORT_REQUIRED');
  const authority=ModelSettingsAuthority.open(values.directory!,{environment_id:values.environment!,master_key_file:values.master!});
  try{
    if(values.import){
      const keys=values['keys-stdin']?JSON.parse(readFileSync(0,'utf8')) as Record<string,string>:{};
      if(!values.bootstrap||authority.read().desired===0)authority.bootstrap(loadModelSettingsImport(values.import),keys);
    }else if(values['keys-stdin'])throw Error('MODEL_SETTINGS_CLI_IMPORT_REQUIRED');
    const revision=values.revision==='current'?authority.read().groups[values.group].effective:Number(values.revision);
    if(!Number.isSafeInteger(revision)||revision<1)throw Error('MODEL_SETTINGS_CLI_REVISION_INVALID');
    if(values.prices){
      const prices=JSON.parse(readFileSync(values.prices,'utf8')) as ModelPriceFact[];
      if(!Array.isArray(prices)||prices.some(price=>price.environment!==values.environment))throw Error('USAGE_PRICE_ENVIRONMENT_INVALID');
      new ModelUsage(authority.db,{notify:async()=>{}}).setPrices(prices);
    }
    const projection=writeModelSettingsProjection(authority,values.output!,values.profile!,revision,values.group,values.publish===true);
    console.log(JSON.stringify({environment_id:projection.environment_id,profile:projection.profile,revision:projection.revision,
      group:projection.group,configured:projection.configured,published:values.publish===true}));
  }finally{authority.close();}
}
try{main();}catch(error){
  const message=error instanceof Error?error.message:'';
  console.error(/^(?:MODEL|USAGE)_[A-Z_]+$/u.test(message)?message:'MODEL_SETTINGS_PROJECT_FAILED');
  process.exitCode=1;
}
