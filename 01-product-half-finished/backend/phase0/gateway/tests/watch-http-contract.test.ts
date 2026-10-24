import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';

const wire=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/watch-http.v1.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
addFormats.default(ajv,['uuid','date-time']);
const validate=(name:string)=>ajv.compile({$ref:`#/$defs/${name}`,$defs:wire.$defs});
const id=wire.examples.heard.turn_id;

test('Watch normalized HTTP metadata freezes AAC-LC mono and exact limits',()=>{
  const accepts=validate('utterance_metadata'),sample=wire.examples.utterance_metadata;
  assert.equal(accepts(sample),true,ajv.errorsText(accepts.errors));
  for(const duration of ['1','9999','10000','29999','30000'])assert.equal(accepts({...sample,'x-watch-duration-ms':duration}),true,duration);
  for(const duration of ['0','30001','100000','01','1.5','-1'])assert.equal(accepts({...sample,'x-watch-duration-ms':duration}),false,duration);
  for(const change of [{unknown:true},{'x-watch-turn-id':'bad'},{'x-watch-codec':'pcm_s16le'},{'x-watch-channels':'2'},{'x-watch-sample-rate-hz':'48000'},{'content-type':'audio/aac'}])assert.equal(accepts({...sample,...change}),false);
  assert.equal(wire.transport.utterance.max_body_bytes,1_000_000);
  assert.equal(wire.transport.utterance.max_duration_ms,30_000);
});

test('Watch responses are strict disjoint states with bounded failure reasons',()=>{
  const upload=validate('utterance_response'),turn=validate('turn_response');
  for(const sample of [wire.examples.heard,wire.examples.failed])assert.equal(upload(sample),true,ajv.errorsText(upload.errors));
  for(const sample of [wire.examples.working,wire.examples.replied,wire.examples.failed]){
    assert.equal(turn(sample),true,ajv.errorsText(turn.errors));
    assert.equal(turn({...sample,unknown:true}),false);
  }
  for(const sample of [{status:'working'},{status:'replied',turn_id:id},{status:'working',turn_id:id,text:'stale'},{status:'failed',reason:'arbitrary'},{status:'replied',turn_id:id,text:'ok',audio_url:'forbidden'}])assert.equal(turn(sample),false);
  assert.equal(upload(wire.examples.replied),false);
  assert.equal(turn(wire.examples.heard),false);
  const query=validate('turn_query');
  assert.equal(query({wait:25}),true);
  for(const value of [{wait:26},{wait:25,principal:'other'},{wait:'25'}])assert.equal(query(value),false);
});

test('Watch credential exchange carries binding CAS and rejects caller-owned identity or routing',()=>{
  const request=validate('credential_request'),response=validate('credential_response');
  const sample={action:'issue',watch_device_id:id,installation_id:'f52c3502-6084-419a-a362-b003eeb332b7',expected_pair_version:'1',request_id:'7d5bdac6-d072-4003-b79c-a89f8dd06c7d'};
  for(const action of ['issue','refresh','revoke'])assert.equal(request({...sample,action}),true);
  for(const mutation of [{principal:'other'},{token:'caller-token'},{session_id:'other'},{expected_pair_version:'0'},{expected_pair_version:1},{action:'register'},{watch_device_id:'not-uuid'}])assert.equal(request({...sample,...mutation}),false);
  const credential={status:'credential',watch_device_id:id,installation_id:sample.installation_id,pair_version:'1',token:'opaque-test-only',expires_at:'2026-10-22T00:00:00.000Z'};
  assert.equal(response(credential),true,ajv.errorsText(response.errors));
  assert.equal(response({...credential,server:'https://caller.invalid'}),false);
  assert.equal(response({status:'revoked',watch_device_id:id,installation_id:sample.installation_id,pair_version:'2'}),true);
  assert.equal(response({status:'failed',reason:'pair_version_conflict'}),true);
});
