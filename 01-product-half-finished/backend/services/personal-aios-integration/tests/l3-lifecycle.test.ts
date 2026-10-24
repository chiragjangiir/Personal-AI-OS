import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {commandDigest,forgetDigest,type AssertionInput,type L3Command,type TrustedL3Context} from '../src/memory/contracts.ts';
const moduleUrl=process.env.L3_LIFECYCLE_MODULE??new URL('../src/memory/l3.ts',import.meta.url).href;
const {L3Service}=await import(moduleUrl);
const require=createRequire(new URL('../../platform-data/package.json',import.meta.url));
const {Pool}=require('pg');
const database=process.env.PAIOS_L3_TEST_DATABASE_URL;
const evidence={event_id:'controlled-e',processed_event_id:'controlled-d',raw_ref:'l5:'+'1'.repeat(64),archive_revision:'2'.repeat(64)};
const trusted:TrustedL3Context={authenticated:true,principal_id:'owner',run_id:'controlled-run',context_ref:'controlled-context',authorize:async()=>true,evidenceAvailable:async()=>true};
function assertion(id:string):AssertionInput{return {assertion_id:id,kind:'inference',subject_ref:{type:'known_person',id:'owner'},predicate:'role',value:'buyer',scope:{principal_id:'owner',purpose:'advice',situation:'packaging',role:'buyer',evaluation_frame:'business'},evidence_refs:[evidence],evidence_status:'available',unknown_conditions:[],conflicts:[],status:'candidate',applicability_status:'applicable',relation_to_peers:'compatible',typed_scores:{interpretation_support:{value_or_interval:0.4,scale:[0,1],basis_refs:[evidence.raw_ref]}},depends_on:[]};}
function command(id:string,a:AssertionInput,version=0,operation:L3Command['operation']='create'):L3Command{const c={command_id:id,operation,expected_version:version,assertion:a,evidence_refs:[evidence]};return {...c,payload_sha256:commandDigest(c)};}
async function fixture(t:TestContext){
 const url=new URL(database!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55439');assert.equal(url.username,'l3test');assert.equal(url.pathname,'/postgres');
 const schema='l3_lifecycle_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:database}),pool=new Pool({connectionString:database,options:'-c search_path='+schema});
 await admin.query('CREATE SCHEMA '+schema);
 t.after(async()=>{try{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');const absent=await admin.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1',[schema]);assert.equal(absent.rows[0].n,0);await record({event:'schema_dropped',schema});}finally{await admin.end();}});
 await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url),'utf8'));
 await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf8'));
 await pool.query(await readFile(new URL('../../../migrations/0018_l3_forget_dependency_closure.up.sql',import.meta.url),'utf8'));
 await record({event:'schema_created',schema});const service=await L3Service.openExisting(pool,schema);
 return {service,pool,schema};
}
async function record(value:unknown){if(process.env.L3_LIFECYCLE_EVIDENCE)await appendFile(process.env.L3_LIFECYCLE_EVIDENCE,JSON.stringify(value)+'\n');}
async function chain(f:Awaited<ReturnType<typeof fixture>>){
 const root=assertion('root'),child={...assertion('child'),depends_on:[{assertion_id:'root',version:1,dependency_kind:'role_basis'}]},leaf={...assertion('leaf'),depends_on:[{assertion_id:'child',version:1,dependency_kind:'plan_basis'}]};
 for(const a of [root,child,leaf])await f.service.commit(command('create-'+a.assertion_id,a),trusted);
 return {root,child,leaf};
}
for(const status of ['deleted','retracted']as const)test('correct cannot encode '+status,{skip:!database},async t=>{
 const f=await fixture(t),a=assertion('root');await f.service.commit(command('create',a),trusted);
 await assert.rejects(f.service.commit(command('bad-correct',{...a,status},1,'correct'),trusted),/L3_CORRECTION_REQUIRES_LIVE/);
 assert.equal(((await f.service.query(trusted,'root')).assertions)[0].version,1);assert.equal(await f.service.receipt(trusted,'bad-correct'),undefined);
});
test('pure review retains pinned transitive dependents and immutable fields',{skip:!database},async t=>{
 const f=await fixture(t),{root,child,leaf}=await chain(f),before=await f.pool.query('SELECT assertion_id,version,assertion_payload AS payload FROM paios_l3_payloads ORDER BY assertion_id,version');
 const review=await f.service.commit(command('review',{...root,status:'active'},1,'review'),trusted);assert.deepEqual(review.invalidated,[]);
 assert.deepEqual(((await f.service.query(trusted)).assertions).map((a:AssertionInput)=>a.assertion_id).sort(),['child','leaf','root']);
 for(const id of ['child','leaf']){const x=await f.service.inspect(trusted,id);assert.equal(x.status,'found');assert.equal(x.assertion.applicability_status,'applicable');assert.equal(x.assertion.version,1);assert.deepEqual(x.invalidation_causes,[]);}
 const after=await f.pool.query('SELECT assertion_id,version,assertion_payload AS payload FROM paios_l3_payloads WHERE version=1 ORDER BY assertion_id,version');assert.deepEqual(after.rows,before.rows);
 assert.deepEqual((await f.service.inspect(trusted,'child')).assertion.depends_on,child.depends_on);assert.deepEqual((await f.service.inspect(trusted,'leaf')).assertion.typed_scores,leaf.typed_scores);
 await record({event:'pure_review_receipt',review});
});
for(const operation of ['correct','delete','deny','retract']as const)test('promotion then '+operation+' invalidates original-version chain',{skip:!database},async t=>{
 const f=await fixture(t),{root,child}=await chain(f),reviewCommand=command('review',{...root,status:'active'},1,'review');await f.service.commit(reviewCommand,trusted);
 const later=await f.service.commit(command('later',{...root,status:'active',value:operation==='correct'?'seller':root.value},2,operation),trusted);
 assert.deepEqual(later.invalidated.sort(),['child','leaf']);assert.deepEqual((await f.service.query(trusted,'child')).assertions,[]);assert.deepEqual((await f.service.query(trusted,'leaf')).assertions,[]);
 for(const id of ['child','leaf']){const x=await f.service.inspect(trusted,id);assert.equal(x.provenance_status,'complete');assert.equal(x.status,'invalidated');assert.equal(x.version,1);assert.equal(x.applicability_status,'needs_reevaluation');assert.equal('assertion' in x,false);assert.equal(x.invalidation_causes[0].operation,operation);assert.equal(x.invalidation_causes[0].changed_version,3);assert.deepEqual(x.invalidation_causes[0].receipt,later);}
 assert.equal('assertion' in await f.service.inspect(trusted,'child'),false);
 const reviewReplay=await f.service.commit(reviewCommand,{...trusted,authorize:async()=>false,evidenceAvailable:async()=>false});assert.equal(reviewReplay.version,2);assert.deepEqual(reviewReplay.invalidated,[]);
 await record({event:'later_receipt',operation,later,reviewReplay});
});
for(const field of ['value','evidence','support','applicability','unknown_conditions']as const)test('changed review '+field+' still invalidates',{skip:!database},async t=>{
 const f=await fixture(t),{root}=await chain(f);let reviewed:AssertionInput={...root,status:'active'};
 if(field==='value')reviewed={...reviewed,value:'seller'};
 if(field==='evidence')reviewed={...reviewed,evidence_refs:[{...evidence,raw_ref:'l5:'+'3'.repeat(64)}],typed_scores:{interpretation_support:{...root.typed_scores.interpretation_support!,basis_refs:['l5:'+'3'.repeat(64)]}}};
 if(field==='support')reviewed={...reviewed,typed_scores:{interpretation_support:{...root.typed_scores.interpretation_support!,value_or_interval:0.3}}};
 if(field==='applicability')reviewed={...reviewed,applicability_status:'needs_reevaluation'};
 if(field==='unknown_conditions')reviewed={...reviewed,unknown_conditions:['unverified']};
 const r=await f.service.commit(command('review-change',reviewed,1,'review'),trusted);assert.deepEqual(r.invalidated.sort(),['child','leaf']);assert.deepEqual((await f.service.query(trusted,'child')).assertions,[]);
});
test('invalidated candidate review cannot revive old dependents automatically',{skip:!database},async t=>{
 const f=await fixture(t),{root,child}=await chain(f);const a=assertion('ancestor');await f.service.commit(command('ancestor',a),trusted);
 await f.service.commit(command('root-dep',{...root,depends_on:[{assertion_id:'ancestor',version:1,dependency_kind:'use'}]},1,'correct'),trusted);
 await f.service.commit(command('ancestor-correct',{...a,value:'seller'},1,'correct'),trusted);assert.equal((await f.service.inspect(trusted,'root')).applicability_status,'needs_reevaluation');
 await assert.rejects(f.service.commit(command('bad-review',{...root,status:'active',depends_on:[{assertion_id:'ancestor',version:1,dependency_kind:'use'}]},2,'review'),trusted),/L3_DEPENDENCY_INVALID/);
 const r=await f.service.commit(command('fixed-review',{...root,status:'active',depends_on:[{assertion_id:'ancestor',version:2,dependency_kind:'use'}]},2,'review'),trusted);assert.deepEqual(r.invalidated.sort(),['child','leaf']);
 assert.deepEqual((await f.service.query(trusted,'child')).assertions,[]);assert.equal('assertion' in await f.service.inspect(trusted,'child'),false);
});
test('receipt-first exact replay remains authorized, immutable and cold-process safe',{skip:!database},async t=>{
 const f=await fixture(t),a=assertion('root'),first=command('create',a),created=await f.service.commit(first,trusted),review=command('review',{...a,status:'active'},1,'review'),r=await f.service.commit(review,trusted);
 assert.deepEqual(await f.service.commit(first,{...trusted,authorize:async()=>false,evidenceAvailable:async()=>false}),created);
 const code=`import {createRequire}from'node:module';import{L3Service}from ${JSON.stringify(moduleUrl)};const {Pool}=createRequire(${JSON.stringify(new URL('../../platform-data/package.json',import.meta.url).href)})('pg');const p=new Pool({connectionString:process.env.PAIOS_L3_TEST_DATABASE_URL,options:${JSON.stringify('-c search_path='+f.schema)}});try{console.log(JSON.stringify(await new L3Service(p).commit(${JSON.stringify(review)},{...${JSON.stringify(trusted)},authorize:async()=>false,evidenceAvailable:async()=>false})));}finally{await p.end();}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:process.env});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),r);
 await assert.rejects(f.service.commit(review,{...trusted,authenticated:false}),/UNAUTHENTICATED/);await assert.rejects(f.service.commit(review,{...trusted,principal_id:'other'}),/SCOPE_DENIED/);await assert.rejects(f.service.commit({...review,payload_sha256:'bad'},trusted),/DIGEST_MISMATCH/);
 await assert.rejects(f.service.commit(command('review',{...a,status:'active',value:'other'},1,'review'),trusted),/COMMAND_CONFLICT/);
 const counts=await f.pool.query('SELECT (SELECT count(*)::int FROM paios_l3_versions) AS versions,(SELECT count(*)::int FROM paios_l3_receipts) AS receipts');assert.deepEqual(counts.rows,[{versions:2,receipts:2}]);
});

test('promotion at both dependency levels keeps exact pins and later source change reaches leaf',{skip:!database},async t=>{
 const f=await fixture(t),{root,child}=await chain(f);
 await f.service.commit(command('root-review',{...root,status:'active'},1,'review'),trusted);
 const childReview=await f.service.commit(command('child-review',{...child,status:'active',depends_on:[{assertion_id:'root',version:2,dependency_kind:'role_basis'}]},1,'review'),trusted);
 // Rebinding evidence is a changed review, so create a fresh leaf pinned to that successor.
 const leaf={...assertion('leaf-new'),depends_on:[{assertion_id:'child',version:2,dependency_kind:'plan_basis'}]};await f.service.commit(command('leaf-new',leaf),trusted);
 const childCandidate={...child,status:'candidate' as const,depends_on:[{assertion_id:'root',version:2,dependency_kind:'role_basis'}]};
 await f.service.commit(command('child-candidate',childCandidate,2,'correct'),trusted);
 const leaf3={...assertion('leaf-three'),depends_on:[{assertion_id:'child',version:3,dependency_kind:'plan_basis'}]};await f.service.commit(command('leaf-three',leaf3),trusted);
 const promotion=await f.service.commit(command('child-promotion',{...childCandidate,status:'active'},3,'review'),trusted);assert.deepEqual(promotion.invalidated,[]);
 assert.equal(((await f.service.query(trusted,'leaf-three')).assertions).length,1);
 const changed=await f.service.commit(command('root-correct',{...root,status:'active',value:'seller'},2,'correct'),trusted);
 assert(changed.invalidated.includes('child'));assert(changed.invalidated.includes('leaf-three'));assert.deepEqual((await f.service.query(trusted,'leaf-three')).assertions,[]);
 assert.equal((await f.service.inspect(trusted,'leaf-three')).version,1);assert.equal((await f.service.inspect(trusted,'child')).version,4);
 await record({event:'nested_promotions',childReview,promotion,changed});
});


test('strict forget erases historical derived payloads and preserves replay receipts',{skip:!database},async t=>{
 const f=await fixture(t),{root,child}=await chain(f);
 const original=command('create-root',root),rootReceipt=await f.service.receipt(trusted,original.command_id);
 // The new head no longer references root. Its old versions still contain derived content.
 await f.service.commit(command('child-independent',{...child,depends_on:[],value:'updated'},1,'correct'),trusted);
 await f.service.commit(command('unrelated',assertion('unrelated')),trusted);
 const request={command_id:'forget-root',principal_id:'owner',assertion_id:'root',expected_version:1,
  scope:'l3_live_payloads_all_versions' as const,retention:'audit_metadata' as const};
 const signed={...request,payload_sha256:forgetDigest(request)};
 const context={...trusted,source:'explicit_user_request' as const,consent_ref:'consent'};
 const receipt=await f.service.forget(signed,context);
 assert.equal(receipt.erased_versions,4);assert.deepEqual(receipt.invalidated.sort(),['child','leaf']);
 assert.deepEqual((await f.pool.query('SELECT assertion_id FROM paios_l3_payloads ORDER BY assertion_id')).rows,[{assertion_id:'unrelated'}]);
 for(const id of ['root','child','leaf']){
  assert.equal((await f.service.inspect(trusted,id)).status,'erased');
  assert.deepEqual((await f.service.query(trusted,id,'candidate')).assertions,[]);
  await assert.rejects(f.service.commit(command('revive-'+id,assertion(id)),trusted),/L3_FORGOTTEN/);
 }
 assert.deepEqual(await f.service.commit(original,{...trusted,authorize:async()=>false,evidenceAvailable:async()=>false}),rootReceipt);
 assert.deepEqual(await f.service.forget(signed,{...context,authorize:async()=>false}),receipt);
 const replay=new L3Service(f.pool);
 assert.deepEqual(await replay.forget(signed,{...context,authorize:async()=>false}),receipt);
 assert.equal((await f.service.query(trusted)).assertions.length,1);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM paios_l3_forgotten')).rows[0].n,3);
});

test('forget receipt failure rolls back all derived erasures and tombstones',{skip:!database},async t=>{
 const f=await fixture(t);await chain(f);
 await f.pool.query("CREATE FUNCTION fail_forget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command_id='forget-fault' THEN RAISE EXCEPTION 'forget receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_forget BEFORE INSERT ON paios_l3_receipts FOR EACH ROW EXECUTE FUNCTION fail_forget()");
 const request={command_id:'forget-fault',principal_id:'owner',assertion_id:'root',expected_version:1,
  scope:'l3_live_payloads_all_versions' as const,retention:'audit_metadata' as const};
 await assert.rejects(f.service.forget({...request,payload_sha256:forgetDigest(request)},
  {...trusted,source:'explicit_user_request',consent_ref:'consent'}),/forget receipt failure/);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM paios_l3_payloads')).rows[0].n,3);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM paios_l3_forgotten')).rows[0].n,0);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM paios_l3_invalidations')).rows[0].n,0);
 assert.equal((await f.service.query(trusted)).assertions.length,3);
});

test('new-command evidence is validated after acquiring the transaction lifecycle lock',async()=>{
 const trace:string[]=[];let available=true;
 const client={query:async(sql:string)=>{
  trace.push(sql);
  if(sql.includes('pg_advisory_xact_lock'))available=false;
  return {rows:[]};
 },release:()=>{trace.push('release');}};
 const pool={query:async()=>({rows:[]}),connect:async()=>client};
 const service=new L3Service(pool as never);
 await assert.rejects(service.commit(command('locked-evidence',assertion('root')),
  {...trusted,evidenceAvailable:async()=>{trace.push('evidence');return available;}}),/L3_EVIDENCE_UNAVAILABLE/);
 assert(trace.findIndex(sql=>sql.includes('pg_advisory_xact_lock'))<trace.indexOf('evidence'));
 assert(trace.includes('ROLLBACK'));assert(!trace.some(sql=>sql.startsWith('INSERT')));
});

test('a receipt committed during lock wait wins over newly revoked evidence',async()=>{
 const c=command('replayed-after-lock',assertion('root'));
 const receipt={receipt_ref:'l3:owner:'+c.command_id,command_id:c.command_id,payload_sha256:c.payload_sha256,
  status:'committed',assertion_id:'root',version:1,previous_version:null,authority_watermark:'1',committed_at:'2026-10-17T00:00:00.000Z',invalidated:[]};
 let checks=0;
 const client={query:async(sql:string)=>({rows:sql.includes('SELECT payload_sha256, receipt')?[{payload_sha256:c.payload_sha256,receipt}]:[]}),release:()=>{}};
 const service=new L3Service({query:async()=>({rows:[]}),connect:async()=>client} as never);
 assert.deepEqual(await service.commit(c,{...trusted,authorize:async()=>{checks++;return false;},evidenceAvailable:async()=>{checks++;return false;}}),receipt);
 assert.equal(checks,0);
});

test('inspection exposes only metadata for deleted, retracted and invalidated payloads',async()=>{
 const a={...assertion('sensitive'),value:'deleted private value',version:2,previous_version:1,
  created_at:'2026-10-17T00:00:00.000Z',authorizing_context_ref:'context'};
 for(const status of ['deleted','retracted','invalidated','active']as const){
  const payload={...a,status:status==='invalidated'?'active':status};
  const row={payload,version:2,forget_receipt:null,receipt:null,operation:null,
   invalidation_causes:status==='invalidated'?[{reason:'dependency_changed',command_id:'delete',
    receipt:null,operation:'delete',changed_assertion_id:'source',changed_version:2}]:[]};
  const service=new L3Service({query:async()=>({rows:[row]})}as never);
  const inspected=await service.inspect(trusted,'sensitive');
  assert.equal(inspected.status,status==='active'?'found':status);
  if(inspected.status==='found'){assert.deepEqual(inspected.assertion,payload);continue;}
  assert.equal('assertion' in inspected,false);
  assert.equal(JSON.stringify(inspected).includes('deleted private value'),false);
  assert.equal(JSON.stringify(inspected).includes(evidence.raw_ref),false);
  assert.equal('version' in inspected&&inspected.version,2);
  if(inspected.status==='invalidated')assert.deepEqual(inspected.invalidation_causes,row.invalidation_causes);
 }
});
