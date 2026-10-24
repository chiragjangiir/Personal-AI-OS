import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFormalWireAjv} from '../src/personal-aios-formal-text.ts';

test('phone and gateway share fresh-fix failure reasons and nullable cached age',()=>{
  const root=new URL('../../../../../',import.meta.url);
  const bytes=readFileSync(new URL('integrations/contracts/formal-message.v1.json',root));
  assert.deepEqual(readFileSync(new URL('01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts/formal-message.v1.json',root)),bytes);
  const wire=JSON.parse(bytes.toString()),validate=createFormalWireAjv().compile({$defs:wire.$defs,...wire.inputs.location_update.definition});
  for(const reason of ['timeout','permission_denied','permission_restricted','permission_not_determined','reduced_accuracy','background_when_in_use'])
    for(const age of [null,240000])assert.equal(validate({operation:'location_update',request_id:'navigation:fix',location:null,unavailable_reason:reason,cached_fix_age_ms:age}),true,JSON.stringify(validate.errors));
  for(const age of [-1,0.5,'240000'])assert.equal(validate({operation:'location_update',location:null,unavailable_reason:'timeout',cached_fix_age_ms:age}),false);
  assert.equal(validate({operation:'location_update',location:{latitude:3,longitude:4,accuracy_m:10,datum:'wgs84',observed_at:new Date().toISOString()},request_id:'navigation:fix'}),true);
});
