import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, stat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ActionAuthority, initializeActionSchema} from '../src/actions/authority.ts';
import {L3Service} from '../src/memory/l3.ts';
import {MemoryToolAuthority} from '../src/memory/tools.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {UnifiedIngress} from '../src/ingress.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {OutputAuthority, type OutputContext} from '../src/output.ts';
import {canonical} from '../src/contracts.ts';
import {inspectWav} from '../src/tts.ts';

const require = createRequire(new URL('../../platform-data/package.json', import.meta.url));
const {Pool} = require('pg') as {Pool: new(config: Record<string,unknown>) => ConstructorParameters<typeof L3Service>[0]};
const database = process.env.PAIOS_L3_TEST_DATABASE_URL;
// Synthetic PCM is only a TTS lifecycle fixture; no playback or native model is claimed.
function wav() {
  const bytes=Buffer.alloc(46); bytes.write('RIFF'); bytes.writeUInt32LE(38,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(24000,24); bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32);
  bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(2,40); return bytes;
}

test('runtime and OUT retain independent real PostgreSQL receipts through source failures and recovery', {skip: !database}, async t => {
  const schema='paios_fixture_sources_'+randomUUID().replaceAll('-','').slice(0,16);
  const admin=new Pool({connectionString:database}); await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString:database,options:'-c search_path='+schema});
  const folder=await mkdtemp(join(tmpdir(),'paios-e15-source-')); const storage=new PosixStorage(folder);
  let memFail=false; let actFail=false; let memReads=0; let actReads=0; let syntheses=0; let nativeCreates=0;
  function faultPool(kind: 'l3'|'action') {
    return new Proxy(pool,{get(target,key) {
      if (key !== 'query') {const value=Reflect.get(target,key); return typeof value==='function' ? value.bind(target) : value;}
      return (...args: Parameters<typeof pool.query>) => {
        const sql=String(args[0]);
        const sourceRead=kind==='l3' ? sql.includes('SELECT receipt FROM paios_l3_receipts') : sql.includes('SELECT action_id FROM paios_action_invocations');
        if (sourceRead) {
          if (kind==='l3') memReads++; else actReads++;
          if (kind==='l3' ? memFail : actFail) return Promise.reject(new Error('injected source query unavailable'));
        }
        return pool.query(...args);
      };
    }});
  }
  const archive=new RawArchive(storage,4096); const ingress=new UnifiedIngress(archive);
  // The API transcript identity is distinct from the caller conversation identity.
  const terminal=(run_id:string)=>({run_id,session_id:'fixture-transcript:'+run_id,
    conversation_session_id:'fixture-session',status:'completed',output:'immutable final fixture'});
  const native={create:async()=>{nativeCreates++; throw new Error('must not execute a new native turn');},
    status:async(run_id:string)=>terminal(run_id),
    cancel:async(run_id:string)=>({...terminal(run_id),status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:10000,
    poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'fixture'});
  let runtime: PersonalAIOSRuntime;
  const out=new OutputAuthority(storage,{listRunReceipts:ctx=>runtime.runReceipts(ctx),resolveReceipt:(ref,ctx)=>runtime.resolveReceipt(ref,ctx),
    tts:{synthesize:async()=>{syntheses++; return inspectWav(wav());}}});
  try {
    await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf8'));
    await initializeActionSchema(pool);
    const l3=new L3Service(faultPool('l3')); const actions=new ActionAuthority(faultPool('action'),{local_notes_root:join(folder,'drafts')});
    runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:out,devices:[],skill:'fixture',max_read_bytes:4096,l3,actions});
    const memory=new MemoryToolAuthority({l3,archive,storage,lookupProcessed:async()=>undefined});
    const d=await ingress.accept({schema_version:'paios.event.v1',event_id:'actual-evidence',device_id:'mac',device_type:'mac',
      captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'test'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('isolated reversible receipt fixture')},
    {principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'test',submission:'explicit_text'});
    const base:OutputContext={principal_id:'owner',run_id:'both',session_id:'fixture-session',tool_call_id:'fixture-call',d,
      target:{device_id:'mac',device_type:'mac',route_version:'fixture-route',output_modes:['text','voice']}};
    const ctx=(run_id:string):OutputContext=>({...base,run_id});
    async function commitMemory(run:string) {
      const evidence={event_id:d.event_id,processed_event_id:d.processed_event_id,raw_ref:d.raw_ref,archive_revision:d.archive_revision,time_range:d.time_range};
      // Actual L3 owner commit; trusted authorization/evidence callbacks are explicit test fixtures.
      return l3.commit((await import('../src/memory/tools.ts')).prepareMemoryCommand({command_id:'cmd-'+run,operation:'create',expected_version:0,
        assertion:{assertion_id:'assertion-'+run,kind:'inference',subject_ref:{type:'known_person',id:'owner'},predicate:'test',value:run,
          scope:{principal_id:'owner',purpose:'test',situation:'test',role:'test',evaluation_frame:'test'},evidence_refs:[evidence],
          evidence_status:'available',unknown_conditions:[],conflicts:[],status:'candidate',applicability_status:'applicable',
          relation_to_peers:'independent',typed_scores:{},depends_on:[]},evidence_refs:[evidence]}),
      {authenticated:true,principal_id:'owner',run_id:run,context_ref:'fixture:'+run,authorize:async()=>true,evidenceAvailable:async()=>true});
    }
    async function commitAction(run:string) {
      const c={...ctx(run),authenticated:true};
      const request={business_intent_id:'note-'+run,parameter_version:1,action_type:'write_local_note' as const,
        target_device_id:'mac',expected_control_version:'local-note-v1',parameters:{text:'isolated draft '+run}};
      const pending=await actions.request(c,request);
      await actions.confirm({action_id:pending.action_id,payload_sha256:pending.payload_sha256},
        {authenticated:true,principal_id:'owner',device_id:'mac',source:'explicit_user_ui',consent_ref:'fixture-consent'});
      return actions.request(c,request);
    }
    const action=await commitAction('action-only'); const mem=await commitMemory('memory-only');
    const bothMem=await commitMemory('both'); const bothAction=await commitAction('both');
    const files=await readdir(join(folder,'drafts','notes'));
    const before=await Promise.all(files.map(file=>stat(join(folder,'drafts','notes',file))));
    memFail=true;
    const actionResult=await out.seal(ctx('action-only'),terminal('action-only'));
    assert.equal(actionResult.receipt_status,'partial'); assert.deepEqual(actionResult.actions,[JSON.parse(canonical(action))]);
    assert.deepEqual(actionResult.l3_updates,[]); assert.equal(actionResult.receipt_sources[0]?.status,'failed');
    assert.equal(actionResult.receipt_sources[1]?.status,'complete'); assert.ok(memReads>0 && actReads>0);
    memFail=false; actFail=true;
    const memResult=await out.seal(ctx('memory-only'),terminal('memory-only'));
    assert.equal(memResult.receipt_status,'partial'); assert.deepEqual(memResult.l3_updates,[JSON.parse(canonical(mem))]);
    assert.deepEqual(memResult.actions,[]);
    memFail=true;
    const unknown=await out.seal(ctx('empty'),terminal('empty'));
    assert.equal(unknown.receipt_status,'unknown'); assert.deepEqual(unknown.receipt_refs,[]);
    const retained=await out.seal(ctx('action-only'),terminal('action-only'));
    assert.equal(retained.receipt_status,'partial'); assert.deepEqual(retained.actions,actionResult.actions);
    // OPEN-authenticated facts survive both source failures, then persist across OUT restart.
    await out.open(ctx('both'),{reply_mode:'text_and_voice',receipt_refs:[bothMem.receipt_ref,bothAction.receipt_ref]});
    // The original OUT owner settles voice asynchronously. Receipt-source failure is independent.
    let partial=await out.seal(ctx('both'),terminal('both'));
    const settlementDeadline=Date.now()+3000;
    while(partial.voice_status!=='ready' && Date.now()<settlementDeadline) {
      assert.notEqual(partial.voice_status,'failed');
      await new Promise(resolve=>setTimeout(resolve,5));
      partial=(await out.readFinalized(ctx('both'))).result;
    }
    assert.equal(partial.voice_status,'ready');
    assert.equal(partial.receipt_status,'partial'); assert.equal(partial.receipt_refs.length,2); assert.equal(syntheses,1);
    const restarted=new OutputAuthority(storage,{listRunReceipts:context=>runtime.runReceipts(context),
      tts:{synthesize:async()=>{syntheses++; throw new Error('must not synthesize again');}}});
    assert.deepEqual((await restarted.seal(ctx('both'),terminal('both'))).receipt_refs,partial.receipt_refs);
    memFail=false; actFail=false;
    const recovered=await restarted.seal(ctx('both'),terminal('both'));
    assert.equal(recovered.receipt_status,'complete'); assert.equal(recovered.receipt_error,null);
    assert.equal(recovered.result_status,'completed'); assert.equal(recovered.reply_text,partial.reply_text);
    assert.ok(recovered.result_revision>partial.result_revision); assert.equal(syntheses,1); assert.equal(nativeCreates,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_action_execution')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_receipts')).rows[0].n,2);
    const after=await Promise.all(files.map(file=>stat(join(folder,'drafts','notes',file))));
    assert.deepEqual(after.map(f=>[f.ino,f.mtimeMs]),before.map(f=>[f.ino,f.mtimeMs]));
    const foreign=await runtime.runReceipts({...ctx('both'),principal_id:'other'});
    assert.ok(foreign.sources.every(source=>source.receipts.length===0));
    assert.deepEqual(await memory.runReceipts(ctx('memory-only')),[mem]);
    assert.deepEqual(await memory.runReceipts(ctx('new-run')),[]);
    assert.deepEqual(await actions.runReceipts({...ctx('new-run'),authenticated:true}),[]);
  } finally {await admission.close(); await pool.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end(); await rm(folder,{recursive:true,force:true});}
});
