import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ModelUsage} from '../src/model-usage.ts';
import {RunAdmission} from '../src/admission.ts';
import {HermesClient,NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {PosixStorage} from '../src/storage.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RawArchive} from '../src/archive.ts';
import {EVENT_SCHEMA} from '../src/contracts.ts';

test('budget gate retains durable pending work; resume starts it through existing admission',async t=>{
  const path=await mkdtemp(join(tmpdir(),'model-usage-admission-')),db=new DatabaseSync(':memory:');let creates=0;
  const native=new HermesClient('http://127.0.0.1:1','fake-token-abcdefghijklmnop',1000,1048576,undefined,async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.pathname,'/v1/runs');creates++;
    const body=JSON.parse(String(init?.body));
    return Response.json({schema:'hermes.run.v2',shape_sha256:NATIVE_RUN_SHAPE_SHA256,profile_home:'/fixture',
      run_id:'usage-run',session_id:body.session_id,conversation_session_id:body.session_id,status:'completed',granted_toolsets:[]},{status:202});
  });
  const storage=new PosixStorage(path),admission=new RunAdmission(storage,native,{max_pending_events:4,max_pending_bytes:100000,
    max_event_age_ms:10000,poll_interval_ms:1000,native_idempotency_retention_ms:86400000,policy_version:'usage-test'});
  t.after(async()=>{await admission.close();db.close();await rm(path,{recursive:true,force:true});});
  const usage=new ModelUsage(db,{notify:async()=>{},resumeWork:()=>admission.resumePaidWork()});
  admission.setPaidAdmission(entry=>usage.admission('staging',entry.d.principal_id,false).allowed);
  usage.pause('staging','owner');
  const ingress=new UnifiedIngress(new RawArchive(storage,10000,()=>new Date().toISOString()));
  const d=await ingress.accept({schema_version:EVENT_SCHEMA,event_id:'usage-event',device_id:'mac',device_type:'mac',
    captured_at:new Date().toISOString(),source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',
    representation:'uploaded_original',payload:Buffer.from('continue task')},
  {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'consent',channel:'text',submission:'explicit_text'});
  const accepted=await admission.admit(d,'session','skill');assert.equal(accepted.state,'pending');assert.equal(creates,0);
  assert.equal((await storage.list('admissions')).length,1);
  usage.resume('staging','owner');
  for(let n=0;n<100&&creates===0;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(creates,1);
});
