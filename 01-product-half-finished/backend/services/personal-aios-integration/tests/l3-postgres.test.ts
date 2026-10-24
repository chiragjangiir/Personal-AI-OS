import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { digest, type TimeRange } from '../src/contracts.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { L3Service } from '../src/memory/l3.ts';
import { commandDigest, type AssertionInput, type L3Command, type TrustedL3Context } from '../src/memory/contracts.ts';
const require = createRequire(new URL('../../platform-data/package.json', import.meta.url));
const {Pool} = require('pg') as {Pool: new(config: Record<string, unknown>) => ConstructorParameters<typeof L3Service>[0]};
const database = process.env.PAIOS_L3_TEST_DATABASE_URL;
const evidence = {event_id:'e',processed_event_id:'d',raw_ref:'l5:' + '1'.repeat(64),archive_revision:digest({event:'e',payload:'original'})};
function assertion(id: string): AssertionInput {return {assertion_id:id,kind:'inference',subject_ref:{type:'known_person',id:'owner'},predicate:'role',value:'buyer',scope:{principal_id:'owner',purpose:'advice',situation:'packaging',role:'buyer',evaluation_frame:'business'},evidence_refs:[evidence],evidence_status:'available',unknown_conditions:[],conflicts:[],status:'candidate',applicability_status:'applicable',hypothesis_group_id:'roles',dimension:'role',branch_id:id,relation_to_peers:'compatible',typed_scores:{interpretation_support:{value_or_interval:0.4,scale:[0,1],basis_refs:[evidence.raw_ref]}},depends_on:[]};}
function command(id: string, a: AssertionInput, expected_version=0, operation: L3Command['operation']='create'): L3Command {const c={command_id:id,operation,expected_version,assertion:a,evidence_refs:[evidence]}; return {...c,payload_sha256:commandDigest(c)};}
const trusted: TrustedL3Context={principal_id:'owner',run_id:'r',context_ref:'trusted:r',authenticated:true,authorize:async()=>true,evidenceAvailable:async()=>true};
test('real PostgreSQL L3 transactions, restart replay, CAS, tombstone and scoped invalidation', {skip:!database}, async t=>{
  const fixtureUrl = new URL(database!);
  assert.equal(fixtureUrl.hostname, '127.0.0.1');
  assert.equal(fixtureUrl.port, '55439');
  assert.equal(fixtureUrl.username, 'l3test');
  assert.equal(fixtureUrl.pathname, '/postgres');
  const admin = new Pool({connectionString:database});
  const schema='l3_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE SCHEMA '+schema); console.info('isolated_schema_created',schema);
  const pool = new Pool({connectionString:database,options:'-c search_path='+schema});
  let service: L3Service;
  let poolClosing: Promise<void> | undefined;
  try {
    await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf8'));
    await assert.rejects(L3Service.openExisting(pool, schema), /L3_FORGET_MIGRATION_REQUIRED/);
    await pool.query(await readFile(new URL('../../../migrations/0018_l3_forget_dependency_closure.up.sql',import.meta.url),'utf8'));
    service = await L3Service.openExisting(pool, schema);
    await t.test('existing-resource catalog rejects missing schema, wrong type/key/deferred FK and namespace without SET', async () => {
      await assert.rejects(L3Service.openExisting(pool, 'public'), /L3_EXISTING_SCHEMA_REQUIRED/);
      await assert.rejects(L3Service.openExisting(pool, 'bad;namespace'), /L3_NAMESPACE_INVALID/);
      const client = await pool.connect();
      try {
        for (const [sql, reason] of [
          ['ALTER TABLE paios_l3_versions RENAME TO missing_versions', /L3_EXISTING_SCHEMA_REQUIRED/],
          ['ALTER TABLE paios_l3_payloads ALTER COLUMN assertion_payload TYPE text USING assertion_payload::text', /L3_EXISTING_SCHEMA_REQUIRED/],
          ['ALTER TABLE paios_l3_receipts DROP CONSTRAINT paios_l3_receipts_pkey CASCADE', /L3_EXISTING_KEYS_REQUIRED/],
          ['ALTER TABLE paios_l3_invalidations ALTER CONSTRAINT paios_l3_invalidations_principal_id_command_id_fkey NOT DEFERRABLE', /L3_EXISTING_KEYS_REQUIRED/],
          ['ALTER TABLE paios_l3_invalidations ADD CONSTRAINT immediate_receipt FOREIGN KEY(principal_id, command_id) REFERENCES paios_l3_receipts NOT DEFERRABLE', /L3_EXISTING_KEYS_REQUIRED/],
          ['ALTER TABLE paios_l3_forgotten ADD CONSTRAINT old_forget_unique UNIQUE(command_id,principal_id)', /L3_FORGET_MIGRATION_REQUIRED/],
          ['ALTER SEQUENCE paios_l3_watermark RENAME TO missing_watermark', /L3_EXISTING_SEQUENCE_REQUIRED/],
        ] as const) {
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await assert.rejects(L3Service.openExisting(client as unknown as ConstructorParameters<typeof L3Service>[0], schema), reason);
          } finally { await client.query('ROLLBACK'); }
        }
        const observed: unknown[] = [];
        const capture = {query: async (sql: string, parameters: unknown[]) => {
          const result = await client.query(sql, parameters); observed.push(result.rows); return result;
        }} as unknown as ConstructorParameters<typeof L3Service>[0];
        await L3Service.openExisting(capture, schema);
        const snapshot = observed[0] as Record<string, unknown>[];
        for (const change of ['permission', 'visibility', 'column-order']) {
          const rows = structuredClone(snapshot);
          const table = rows.find(row => row.name === 'paios_l3_dependencies')!;
          if (change === 'permission') table.permitted = false;
          if (change === 'visibility') table.visible = false;
          if (change === 'column-order') table.columns = 'assertion_id:text,principal_id:text,version:integer,dependency_id:text,dependency_version:integer';
          await assert.rejects(L3Service.openExisting({query: async () => ({rows})} as never, schema), /L3_EXISTING_SCHEMA_REQUIRED/);
        }
        const before = await client.query('SHOW search_path');
        await L3Service.openExisting(client as unknown as ConstructorParameters<typeof L3Service>[0], schema);
        assert.deepEqual((await client.query('SHOW search_path')).rows, before.rows);
      } finally { client.release(); }
    });

    const first=command('create-role',assertion('role'));
    const receipt=await service.commit(first,trusted);
    await t.test('cross-process exact replay before dynamic authorization and evidence', async()=>{
      const script=`import {createRequire} from 'node:module';import {L3Service} from ${JSON.stringify(new URL('../src/memory/l3.ts',import.meta.url).href)};const require=createRequire(${JSON.stringify(new URL('../../platform-data/package.json',import.meta.url).href)});const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.PAIOS_L3_TEST_DATABASE_URL,options:${JSON.stringify('-c search_path='+schema)}});const s=new L3Service(pool);const r=await s.commit(${JSON.stringify(first)},{principal_id:'owner',run_id:'new-run',context_ref:'new',authenticated:true,authorize:async()=>false,evidenceAvailable:async()=>false});process.stdout.write(JSON.stringify(r));await pool.end();`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:process.env});
      assert.equal(child.status,0,child.stderr); assert.deepEqual(JSON.parse(child.stdout),receipt);
      await assert.rejects(service.commit(first,{...trusted,authenticated:false}),/UNAUTHENTICATED/);
      await assert.rejects(service.commit(first,{...trusted,principal_id:'other'}),/SCOPE_DENIED/);
      await assert.rejects(service.commit({...first,payload_sha256:'bad'},trusted),/DIGEST_MISMATCH/);
      await assert.rejects(service.commit(command('create-role',{...assertion('role'),value:'other'}),trusted),/COMMAND_CONFLICT/);
    });
    await t.test('transaction persists original run ownership and read-only receipts survive replay by another run',async()=>{
      assert.equal((await pool.query('SELECT run_id FROM paios_l3_receipts WHERE principal_id=$1 AND command_id=$2',
        ['owner',first.command_id])).rows[0].run_id,trusted.run_id);
      assert.deepEqual(await service.receiptsForRun(trusted,trusted.run_id),[receipt]);
      assert.deepEqual(await service.receiptsForRun({...trusted,principal_id:'other'},trusted.run_id),[]);
      await assert.rejects(service.receiptsForRun({...trusted,authenticated:false},trusted.run_id),/UNAUTHENTICATED/);
      assert.deepEqual(await service.commit(first,{...trusted,run_id:'later-run',authorize:async()=>false,
        evidenceAvailable:async()=>false}),receipt);
      assert.deepEqual(await service.receiptsForRun(trusted,'later-run'),[]);
      assert.deepEqual(await service.receiptsForRun(trusted,trusted.run_id),[receipt]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_receipts WHERE command_id=$1',
        [first.command_id])).rows[0].n,1);
    });
    await t.test('multiple scoped branches and transitive dependencies coexist',async()=>{
      await service.commit(command('create-domain',{...assertion('domain'),dimension:'domain',value:'packaging'}),trusted);
      await service.commit(command('create-peer',assertion('peer')),trusted);
      await service.commit(command('create-dependent',{...assertion('advice'),depends_on:[{assertion_id:'role',version:1,dependency_kind:'role_basis'}]}),trusted);
      await service.commit(command('create-grandchild',{...assertion('plan'),depends_on:[{assertion_id:'advice',version:1,dependency_kind:'plan_basis'}]}),trusted);
      assert.equal(((await service.query(trusted)).assertions).length,5);
    });
    await t.test('inspect candidate/active preserves source fields and current receipt',async()=>{
      for (const assertion_id of ['role','domain']) {
        const a=((await service.query(trusted,assertion_id)).assertions)[0]!;
        const inspection=await service.inspect(trusted,assertion_id);
        assert.equal(inspection.status,'found'); if(inspection.status!=='found') throw Error('missing');
        assert.deepEqual(inspection.assertion,a); assert.equal(inspection.provenance_status,'complete');
        assert.equal(inspection.current_version.receipt?.version,a.version);
        assert.equal(inspection.current_version.operation,'create'); assert.deepEqual(inspection.invalidation_causes,[]);
      }
    });
    await t.test('duplicate evidence does not raise support',async()=>{
      await assert.rejects(service.commit(command('repeat-score',{...assertion('peer'),typed_scores:{interpretation_support:{value_or_interval:0.8,scale:[0,1],basis_refs:[evidence.raw_ref]}}},1,'correct'),trusted),/REPEATED_EVIDENCE/);
      await assert.rejects(service.commit(command('duplicate-evidence',{...assertion('peer'),evidence_refs:[evidence,evidence]},1,'correct'),trusted),/DUPLICATE_EVIDENCE/);
    });
    await t.test('new independent evidence can strengthen support and JSON alone never commits',async()=>{
      const extra={...evidence,event_id:'e2',processed_event_id:'d2',raw_ref:'l5:' + '2'.repeat(64)};
      const a={...assertion('strengthened'),evidence_refs:[evidence,extra],typed_scores:{interpretation_support:{value_or_interval:0.8,scale:[0,1] as [number,number],basis_refs:[evidence.raw_ref,extra.raw_ref]}}};
      const uncalled=command('json-only',a);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_receipts WHERE command_id=$1',[uncalled.command_id])).rows[0].n,0);
      await service.commit(command('strengthen-create',assertion('strengthened')),trusted);
      await service.commit(command('strengthen',a,1,'correct'),trusted);
      assert.equal(((await service.query(trusted,'strengthened')).assertions)[0]?.typed_scores.interpretation_support?.value_or_interval,0.8);
    });
    await t.test('concurrent corrections commit exactly one successor',async()=>{
      const results=await Promise.allSettled(['one','two'].map(x=>service.commit(command('correct-'+x,{...assertion('peer'),value:x},1,'correct'),trusted)));
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.match(String((results.find(x=>x.status==='rejected') as PromiseRejectedResult).reason),/VERSION_CONFLICT/);
      assert.equal(((await service.query(trusted,'peer')).assertions)[0]?.version,2);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM paios_l3_versions WHERE assertion_id='peer'")).rows[0].n,2);
    });
    await t.test('explicit denial stops matching branch and transitive uses only',async()=>{
      const denied=await service.commit(command('deny-role',assertion('role'),1,'deny'),trusted);
      assert.deepEqual(denied.invalidated.sort(),['advice','plan']);
      assert.deepEqual(((await service.query(trusted)).assertions).map(x=>x.assertion_id).sort(),['domain','peer','strengthened']);
      await assert.rejects(service.commit(command('recreate-role',assertion('role'),2,'review'),trusted),/TOMBSTONE/);
      await assert.rejects(service.commit(command('bad-dependency',{...assertion('new'),depends_on:[{assertion_id:'advice',version:1,dependency_kind:'use'}]}),trusted),/DEPENDENCY_INVALID/);
      assert.deepEqual(await service.commit(first,{...trusted,authorize:async()=>false}),receipt);
    });
    await t.test('candidate deletion cannot revive through query or review',async()=>{
      const created=command('candidate-create',assertion('candidate'));
      await service.commit(created,trusted);
      const deletion=await service.commit(command('candidate-delete',assertion('candidate'),1,'delete'),trusted);
      assert.equal(deletion.version,2); assert.deepEqual((await service.query(trusted,'candidate')).assertions,[]);
      await assert.rejects(service.commit(command('candidate-review',{...assertion('candidate'),status:'active'},2,'review'),trusted),/TOMBSTONE/);
      await assert.rejects(service.commit(command('candidate-rebuild',assertion('candidate')),trusted),/VERSION_CONFLICT/);
      assert.equal((await service.commit(created,trusted)).version,1);
    });
    await t.test('inspect actual denial/deletion and dependency causes without reviving independent branches',async()=>{
      const denied=await service.inspect(trusted,'role'); const deleted=await service.inspect(trusted,'candidate');
      assert.equal(denied.status,'retracted'); assert.equal(deleted.status,'deleted');
      if(denied.status!=='retracted'||deleted.status!=='deleted') throw Error('missing');
      assert.equal(denied.applicability_status,'stopped');assert.equal('assertion' in denied,false);
      assert.equal(denied.current_version.operation,'deny');assert.equal(denied.current_version.receipt?.command_id,'deny-role');
      assert.equal('assertion' in deleted,false);assert.equal(deleted.current_version.operation,'delete');
      for(const assertion_id of ['advice','plan']) {
        const result=await service.inspect(trusted,assertion_id); assert.equal(result.status,'invalidated');
        if(result.status!=='invalidated') throw Error('missing');
        assert.equal('assertion' in result,false);assert.equal(result.applicability_status,'needs_reevaluation');
        assert.equal(result.version,1);assert.equal(result.provenance_status,'complete');
        assert.deepEqual(result.invalidation_causes.map(c=>[c.reason,c.command_id,c.operation,c.changed_assertion_id,c.changed_version]),
          [['dependency_changed','deny-role','deny','role',2]]);
        assert.equal(result.invalidation_causes[0]?.receipt?.command_id,'deny-role');
        assert.equal(result.current_version.receipt?.assertion_id,assertion_id);
        assert.deepEqual((await service.query(trusted,assertion_id)).assertions,[]);
      }
      const independent=await service.inspect(trusted,'domain');assert.equal(independent.status,'found');
      if(independent.status==='found') assert.deepEqual(independent.assertion,((await service.query(trusted,'domain')).assertions)[0]);
    });
    await t.test('inspect missing/cross-owner/auth rejection and repeated reads cause zero writes',async()=>{
      const snapshot=async()=> (await pool.query(`SELECT jsonb_build_object(
        'heads',(SELECT jsonb_agg(h ORDER BY assertion_id) FROM paios_l3_heads h),
        'versions',(SELECT jsonb_agg(v ORDER BY assertion_id,version) FROM paios_l3_versions v),
        'payloads',(SELECT jsonb_agg(p ORDER BY assertion_id,version) FROM paios_l3_payloads p),
        'receipts',(SELECT jsonb_agg(r ORDER BY command_id) FROM paios_l3_receipts r),
        'invalidations',(SELECT jsonb_agg(i ORDER BY assertion_id,command_id) FROM paios_l3_invalidations i),
        'dependencies',(SELECT jsonb_agg(d ORDER BY assertion_id,version) FROM paios_l3_dependencies d),
        'watermark',(SELECT last_value FROM paios_l3_watermark)) AS state`)).rows[0].state;
      const before=await snapshot();
      assert.deepEqual(await service.inspect(trusted,'missing'),{status:'not_found',assertion_id:'missing'});
      assert.deepEqual(await service.inspect({...trusted,principal_id:'foreign'},'role'),{status:'not_found',assertion_id:'role'});
      await assert.rejects(service.inspect({...trusted,authenticated:false},'role'),/UNAUTHENTICATED/);
      await assert.rejects(service.inspect(trusted,''),/INVALID_ID/);
      for(let n=0;n<8;n++) await service.inspect(trusted,'plan');
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('missing current receipt is partial without invented operation or receipt',async()=>{
      const orphan={...assertion('orphan'),version:1,previous_version:null,created_at:'2026-10-02T00:00:00Z',authorizing_context_ref:'fixture'};
      await pool.query('INSERT INTO paios_l3_versions VALUES($1,$2,1,$3)',
        ['owner','orphan',{schema:'l3.audit.v1',status:orphan.status,applicability_status:orphan.applicability_status}]);
      await pool.query('INSERT INTO paios_l3_payloads VALUES($1,$2,1,$3,$4)',['owner','orphan',orphan,{}]);
      await pool.query('INSERT INTO paios_l3_heads VALUES($1,$2,1)',['owner','orphan']);
      const result=await service.inspect(trusted,'orphan');assert.equal(result.status,'found');
      if(result.status!=='found') throw Error('missing');
      assert.equal(result.provenance_status,'partial');assert.deepEqual(result.current_version,{operation:null,receipt:null});
      assert.deepEqual(result.unknown_conditions,['CURRENT_VERSION_RECEIPT_OR_OPERATION_MISSING']);
    });
    await t.test('receipt failure rolls back successor, head and invalidations',async()=>{
      await pool.query("CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command_id='fault' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fault BEFORE INSERT ON paios_l3_receipts FOR EACH ROW EXECUTE FUNCTION fail_receipt()");
      await assert.rejects(service.commit(command('fault',{...assertion('peer'),value:'rollback'},2,'correct'),trusted),/injected failure/);
      assert.equal(((await service.query(trusted,'peer')).assertions)[0]?.version,2);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM paios_l3_versions WHERE assertion_id='peer'")).rows[0].n,2);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM paios_l3_receipts WHERE command_id='fault'")).rows[0].n,0);
    });
    await t.test('concurrent first insert has one durable head and no dangling successor',async()=>{
      const results=await Promise.allSettled(['a','b'].map(x=>service.commit(command('first-'+x,assertion('first-race')),trusted)));
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM paios_l3_versions WHERE assertion_id='first-race'")).rows[0].n,1);
    });
    await t.test('shared digest and actual L5/D evidence preserve instant and interval contracts',async()=>{
      const directory=await mkdtemp(join(tmpdir(),'paios-l3-evidence-'));
      const archive=new RawArchive(new PosixStorage(directory),1024);
      const ingress=new UnifiedIngress(archive);
      try {
        const ranges: TimeRange[]=[{kind:'instant',timebase_id:'utc_unix_ms',at_ms:1000},{kind:'interval',timebase_id:'capture_clock',start_ms:100,end_ms:400,stream_epoch:'epoch-1'}];
        for (const [index,time_range] of ranges.entries()) {
          const d=await ingress.accept({schema_version:'paios.event.v1',event_id:'actual-l5-'+index,device_id:'mac-test',device_type:'mac',captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'test'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('store evidence '+index),time_range},{principal_id:'owner',device_id:'mac-test',device_type:'mac',consent_ref:'consent-test',channel:'test',submission:'explicit_text'});
          const ref={event_id:d.event_id,processed_event_id:d.processed_event_id,raw_ref:d.raw_ref,archive_revision:d.archive_revision,time_range:d.time_range};
          const c=command('actual-l5-commit-'+index,{...assertion('actual-l5-'+index),evidence_refs:[ref],typed_scores:{}});
          c.evidence_refs=[ref];
          const {payload_sha256:_digest,...payload}=c;c.payload_sha256=commandDigest(payload);
          assert.equal(c.payload_sha256,digest(payload));
          const bound={...trusted,evidenceAvailable:async(e: import('../src/memory/contracts.ts').EvidenceRef)=>{
            assert.equal(e.archive_revision,d.archive_revision);assert.deepEqual(e.time_range,d.time_range);
            assert.equal(e.event_id,d.event_id);assert.equal(e.processed_event_id,d.processed_event_id);
            return Buffer.from(await archive.read(e.raw_ref,'owner',e.archive_revision)).equals(Buffer.from('store evidence '+index));
          }};
          await service.commit(c,bound);
          const stored=((await service.query(trusted,'actual-l5-'+index)).assertions)[0]!;
          assert.deepEqual(stored.evidence_refs,[ref]);
          assert.deepEqual(await service.commit(c,{...trusted,authorize:async()=>false,evidenceAvailable:async()=>false}),(await pool.query('SELECT receipt FROM paios_l3_receipts WHERE command_id=$1',[c.command_id])).rows[0].receipt);
        }
      } finally {await rm(directory,{recursive:true,force:true});}
    });
    await t.test('old numeric archive revision and tuple ranges reject without conversion',async()=>{
      const invalidRevision={...evidence,archive_revision:1} as unknown as typeof evidence;
      const revisionCommand=command('numeric-revision',{...assertion('numeric'),evidence_refs:[invalidRevision],typed_scores:{}});
      await assert.rejects(service.commit(revisionCommand,trusted),/L3_EVIDENCE_REQUIRED/);
      const invalidRange={...evidence,time_range:[0,1] as unknown as TimeRange};
      await assert.rejects(service.commit(command('tuple-range',{...assertion('tuple'),evidence_refs:[invalidRange],typed_scores:{}}),trusted),/INVALID_/);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM paios_l3_receipts WHERE command_id IN ('numeric-revision','tuple-range')")).rows[0].n,0);
    });
    await t.test('immutable versions, new-write evidence and authority checks',async()=>{
      await assert.rejects(pool.query("UPDATE paios_l3_versions SET audit='{}'"),/immutable/);
      await assert.rejects(service.commit(command('no-authority',assertion('unauthed')),{...trusted,authorize:async()=>false}),/AUTHORIZATION_REQUIRED/);
      await assert.rejects(service.commit(command('no-evidence',assertion('missing')),{...trusted,evidenceAvailable:async()=>false}),/EVIDENCE_UNAVAILABLE/);
      await service.commit(command('objective-create',{...assertion('objective'),kind:'fact'}),trusted);
      await assert.rejects(service.commit(command('objective-mislabel-denial',assertion('objective'),1,'deny'),trusted),/CANNOT_REWRITE_FACT/);
      await assert.rejects(service.commit(command('fact-denial',{...assertion('domain'),kind:'fact'},1,'deny'),trusted),/CANNOT_REWRITE_FACT/);
    });
    await t.test('explicit source drain then pool close waits for an accepted L3 write and its durable receipt', async () => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      const ready = new Promise<void>(resolve => {entered = resolve;});
      const work = service.commit(command('held-before-close', assertion('held-before-close')),
        {...trusted, authorize: async () => {entered(); await gate; return true;}});
      await ready;
      let ended = false;
      poolClosing = service.close().then(() => pool.end()).then(() => {ended = true;});
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(ended, false);
      } finally {release();}
      const receipt = await work;
      await poolClosing;
      assert.equal(ended, true);
      assert.equal(receipt.status, 'committed');
      const stored = await admin.query('SELECT receipt FROM ' + schema + '.paios_l3_receipts WHERE command_id=$1',
        ['held-before-close']);
      assert.deepEqual(stored.rows[0].receipt, receipt);
    });
  } finally {await (poolClosing ?? pool.end());await admin.query('DROP SCHEMA '+schema+' CASCADE'); console.info('isolated_schema_dropped',schema);await admin.end();}
});
