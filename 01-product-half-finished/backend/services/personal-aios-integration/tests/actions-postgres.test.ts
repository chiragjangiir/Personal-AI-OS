import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ActionAuthority, initializeActionSchema } from '../src/actions/authority.ts';
import { stableActionId, type ActionRequest, type TrustedActionContext } from '../src/actions/contracts.ts';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { PosixStorage } from '../src/storage.ts';
const require = createRequire(new URL('../../platform-data/package.json',import.meta.url));
const {Pool} = require('pg') as {Pool:new(config:Record<string,unknown>)=>ConstructorParameters<typeof ActionAuthority>[0]};
const database = process.env.PAIOS_ACTION_TEST_DATABASE_URL ?? process.env.PAIOS_L3_TEST_DATABASE_URL;
const request = (text='已审阅的隔离笔记草稿。',version=1):(ActionRequest & {action_id:string}) => ({action_id:stableActionId('owner','note-business',version),
  business_intent_id:'note-business',parameter_version:version,action_type:'write_local_note',target_device_id:'mac',
  expected_control_version:'local-note-v1',parameters:{text}});
const auth = {authenticated:true,principal_id:'owner',device_id:'mac',source:'explicit_user_ui' as const,consent_ref:'fixture-ui-consent'};

test('real isolated PostgreSQL and disk validate E16 action identity, authorization, replay and reconciliation', {skip:!database}, async t => {
  const schema='paios_fixture_actions_'+randomUUID().replaceAll('-','').slice(0,16);
  const admin=new Pool({connectionString:database}); await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString:database,options:'-c search_path='+schema});
  const folder=await fs.mkdtemp(join(tmpdir(),'paios-action-e16-'));
  const notes=join(folder,'notes-output');
  const archive=new RawArchive(new PosixStorage(join(folder,'l5')),4096);
  const ingress=new UnifiedIngress(archive);
  async function context(event:string,run:string):Promise<TrustedActionContext> {
    const d=await ingress.accept({schema_version:'paios.event.v1',event_id:event,device_id:'mac',device_type:'mac',
      captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'text'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('修改分析，但同一已授权动作不重复执行：'+event)},
    {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture-ingress',channel:'text',submission:'explicit_text'});
    return {authenticated:true,principal_id:'owner',run_id:run,session_id:'session',tool_call_id:'tool-'+event,d,target:{device_id:'mac'}};
  }
  try {
    await initializeActionSchema(pool);
    const authority=new ActionAuthority(pool,{local_notes_root:notes});
    const d1=await context('d1','run-d1'); const d2=await context('d2','run-d2');
    const first=request();
    const pending=await authority.request(d1,first);
    assert.equal(pending.status,'pending_approval');
    await assert.rejects(fs.readdir(join(notes,'notes')),/ENOENT/);
    const approval={action_id:first.action_id,payload_sha256:pending.payload_sha256};
    await t.test('UI exact digest/device and tool self-approval boundaries',async()=>{
      await assert.rejects(authority.confirm(approval,{...auth,authenticated:false}),/CONFIRMATION_REQUIRED/);
      await assert.rejects(authority.confirm(approval,{...auth,device_id:'other'}),/DEVICE_SCOPE_DENIED/);
      await assert.rejects(authority.confirm({...approval,payload_sha256:'0'.repeat(64)},auth),/DIGEST_MISMATCH/);
      await authority.confirm(approval,auth); // Fixture consent, not a claim the human approved a real daily action.
      await assert.rejects(authority.request(d1,{...first,approved:true} as ActionRequest),/UNKNOWN_ARGUMENT/);
    });
    const committed=await authority.request(d1,first);
    assert.equal(committed.status,'committed'); assert.equal(committed.execution_run_id,d1.run_id);
    const files=await fs.readdir(join(notes,'notes')); assert.equal(files.length,1);
    const path=join(notes,'notes',files[0]!); const bytes=await fs.readFile(path); assert.equal(bytes.toString(),first.parameters.text);
    const before=await fs.stat(path);
    await t.test('different immutable D/run replays original IO receipt and query shows actual invocation relation',async()=>{
      assert.notEqual(d1.d.processed_event_id,d2.d.processed_event_id);
      const replay=await authority.request(d2,first); assert.deepEqual(replay,committed);
      const after=await fs.stat(path); assert.equal(after.ino,before.ino); assert.equal(after.mtimeMs,before.mtimeMs);
      assert.deepEqual(await authority.runReceipts(d2),[committed]);
      assert.deepEqual(await authority.runReceipts(d1),[committed]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_ledger')).rows[0].n,1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_action_execution')).rows[0].n,1);
      await assert.rejects(authority.request({...d2,authenticated:false},first),/UNAUTHENTICATED/);
      await assert.rejects(authority.receipt({...d2,target:{device_id:'other'}},approval),/DEVICE_SCOPE_DENIED/);
      assert.deepEqual(await authority.request({...d2,d:{...d2.d,archive_status:'invalid'} as unknown as typeof d2.d},first),committed);
    });
    await t.test('changed parameters conflict; new parameter version gets distinct required UI authorization',async()=>{
      await assert.rejects(authority.request(d2,{...first,parameters:{text:'不同参数'}}),/PAYLOAD_CONFLICT/);
      const second=request('新版本必须重新授权。',2);
      const pending2=await authority.request(d2,second); assert.equal(pending2.status,'pending_approval');
      assert.equal((await fs.readdir(join(notes,'notes'))).length,1);
      await assert.rejects(authority.confirm({action_id:second.action_id,payload_sha256:approval.payload_sha256},auth),/DIGEST_MISMATCH/);
      await authority.confirm({action_id:second.action_id,payload_sha256:pending2.payload_sha256},{...auth,consent_ref:'fixture-ui-second'});
      assert.equal((await authority.request(d2,second)).status,'committed'); assert.equal((await fs.readdir(join(notes,'notes'))).length,2);
    });
    await t.test('independent process restart returns original committed receipt with current control version changed',async()=>{
      const script=`import {createRequire} from 'node:module';import {ActionAuthority} from ${JSON.stringify(new URL('../src/actions/authority.ts',import.meta.url).href)};
        const require=createRequire(${JSON.stringify(new URL('../../platform-data/package.json',import.meta.url).href)});const {Pool}=require('pg');
        const pool=new Pool({connectionString:process.env.PAIOS_ACTION_TEST_DATABASE_URL,options:${JSON.stringify('-c search_path='+schema)}});
        const a=new ActionAuthority(pool,{local_notes_root:${JSON.stringify(notes)},control_version:'changed-current'});
        process.stdout.write(JSON.stringify(await a.request(${JSON.stringify(d2)},${JSON.stringify(first)})));await pool.end();`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,PAIOS_ACTION_TEST_DATABASE_URL:database!}});
      assert.equal(child.status,0,child.stderr); assert.deepEqual(JSON.parse(child.stdout),committed);
      assert.equal((await fs.stat(path)).mtimeMs,before.mtimeMs);
    });
    await t.test('disk success plus lost receipt transaction leaves unknown; restart does not duplicate effect and explicit inspect reconciles',async()=>{
      const third=request('磁盘已写但数据库收据故障。',3); const p=await authority.request(d2,third);
      await authority.confirm({action_id:third.action_id,payload_sha256:p.payload_sha256},auth);
      await pool.query(`CREATE FUNCTION fail_action_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='committed' AND NEW.idempotency_key='${third.action_id}' THEN RAISE EXCEPTION 'LOST_RECEIPT'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER action_finish_fault BEFORE UPDATE ON idempotency_ledger FOR EACH ROW EXECUTE FUNCTION fail_action_finish()`);
      await assert.rejects(authority.request(d2,third),/LOST_RECEIPT/);
      const artifactCount=(await fs.readdir(join(notes,'notes'))).length; assert.equal(artifactCount,3);
      const restarted=new ActionAuthority(pool,{local_notes_root:notes});
      assert.equal((await restarted.request(d1,third)).status,'reconcile_required');
      assert.equal((await fs.readdir(join(notes,'notes'))).length,artifactCount);
      await pool.query('DROP TRIGGER action_finish_fault ON idempotency_ledger');
      const fixed=await restarted.reconcile(d1,{action_id:third.action_id,payload_sha256:p.payload_sha256});
      assert.equal(fixed.status,'committed'); assert.equal(fixed.execution_run_id,d2.run_id);
      assert.equal((await fs.readdir(join(notes,'notes'))).length,artifactCount);
      assert.deepEqual(await restarted.request(d1,third),fixed);
    });
    await t.test('unsafe disk failure leaves unknown with no blind retry; absent artifact reconciliation remains unknown',async()=>{
      const blockedRoot=join(folder,'blocked-root'); await fs.symlink(notes,blockedRoot);
      const blocked=new ActionAuthority(pool,{local_notes_root:blockedRoot});
      const fourth=request('禁止不安全目标。',4); const p=await blocked.request(d1,fourth);
      await blocked.confirm({action_id:fourth.action_id,payload_sha256:p.payload_sha256},auth);
      await assert.rejects(blocked.request(d1,fourth),/UNSAFE_STORAGE_ROOT/);
      const restored=new ActionAuthority(pool,{local_notes_root:join(folder,'empty')});
      assert.equal((await restored.request(d2,fourth)).status,'reconcile_required');
      assert.equal((await restored.reconcile(d2,{action_id:fourth.action_id,payload_sha256:p.payload_sha256})).status,'reconcile_required');
      assert.equal((await fs.readdir(join(notes,'notes'))).length,3);
      await assert.rejects(pool.query("UPDATE paios_action_proposals SET command='{}'"),/ACTION_IMMUTABLE/);
      await assert.rejects(pool.query("UPDATE paios_action_confirmations SET consent_ref='fake'"),/ACTION_IMMUTABLE/);
    });
    await t.test('concurrent approved requests have one durable effect claim and one immutable file',async()=>{
      const fifth=request('并发同一授权意图。',5); const p=await authority.request(d1,fifth);
      await authority.confirm({action_id:p.action_id,payload_sha256:p.payload_sha256},auth);
      const results=await Promise.all([authority.request(d1,fifth),authority.request(d2,fifth)]);
      assert.ok(results.some(r=>r.status==='committed'));
      const final=await authority.request(d2,fifth); assert.equal(final.status,'committed');
      assert.equal((await fs.readdir(join(notes,'notes'))).length,4);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_action_execution WHERE action_id=$1',[fifth.action_id])).rows[0].n,1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_ledger WHERE idempotency_key=$1',[fifth.action_id])).rows[0].n,1);
    });
  } finally {await pool.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end(); await fs.rm(folder,{recursive:true,force:true});}
});
