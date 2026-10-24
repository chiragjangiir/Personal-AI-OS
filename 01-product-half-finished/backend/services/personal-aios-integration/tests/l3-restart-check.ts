import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {digest} from '../src/contracts.ts';
import {L3Service} from '../src/memory/l3.ts';
import {commandDigest, type AssertionInput, type L3Command, type TrustedL3Context} from '../src/memory/contracts.ts';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../../platform-data/package.json',import.meta.url));
if(!process.env.PAIOS_L3_TEST_DATABASE_URL || !process.env.PAIOS_L3_RESTART_SNAPSHOT) throw new Error('explicit isolated database and snapshot required');
const snapshot=process.env.PAIOS_L3_RESTART_SNAPSHOT;
const schema=process.env.PAIOS_L3_RESTART_SCHEMA;
assert.ok(schema && /^paios_fixture_[a-f0-9]{32}$/.test(schema),'explicit owned random restart schema required');
const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.PAIOS_L3_TEST_DATABASE_URL,options:'-c search_path='+schema});
const context: TrustedL3Context={authenticated:true,principal_id:'owner',run_id:'run',context_ref:'restart-context',authorize:async()=>true,evidenceAvailable:async()=>true};
if(process.argv[2]==='before'){
await pool.query('CREATE SCHEMA '+schema);
await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url),'utf8'));
await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf8'));
const e={event_id:'e',processed_event_id:'d',raw_ref:'l5:'+'1'.repeat(64),archive_revision:digest({event:'e',payload:'restart-original'})};
const a: AssertionInput={assertion_id:'restart',kind:'fact',subject_ref:{type:'known_person',id:'owner'},predicate:'pref',value:'tea',scope:{principal_id:'owner',purpose:'test',situation:'test',role:'test',evaluation_frame:'test'},evidence_refs:[e],evidence_status:'available',unknown_conditions:[],conflicts:[],status:'active',applicability_status:'applicable',relation_to_peers:'independent',typed_scores:{},depends_on:[]};
const payload: Omit<L3Command,'payload_sha256'>={command_id:'restart-create',operation:'create',expected_version:0,assertion:a,evidence_refs:[e]};const c={...payload,payload_sha256:commandDigest(payload)};
const receipt=await new L3Service(pool).commit(c,context);
await writeFile(snapshot,JSON.stringify({c,receipt}));
console.log('before: committed version '+receipt.version);
}else{
const {c,receipt}=JSON.parse(await readFile(snapshot,'utf8'));
assert.deepEqual(await new L3Service(pool).commit(c,{...context,authorize:async()=>false,evidenceAvailable:async()=>false}),receipt);
assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_versions')).rows[0].n,1);
console.log('after: exact receipt/version after process restart (server restart separately required), 1 immutable version');
await pool.query('DROP SCHEMA '+schema+' CASCADE');
}
await pool.end();
