import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { L3Service } from '../src/memory/l3.ts';
import { MemoryArgumentError, MemoryToolAuthority, type TrustedMemoryContext, type TrustedMemoryAuthorization } from '../src/memory/tools.ts';
import { commandDigest, type AssertionInput, type EvidenceRef, type L3Command, type L3Receipt } from '../src/memory/contracts.ts';
import { ContractError, type ProcessedEvent, type TimeRange } from '../src/contracts.ts';

const require = createRequire(new URL('../../platform-data/package.json', import.meta.url));
const {Pool} = require('pg') as {Pool: new(config: Record<string, unknown>) => ConstructorParameters<typeof L3Service>[0]};
const database = process.env.PAIOS_L3_TEST_DATABASE_URL;
function ref(d: ProcessedEvent): EvidenceRef {
  return {event_id: d.event_id, processed_event_id: d.processed_event_id, raw_ref: d.raw_ref,
    archive_revision: d.archive_revision, time_range: d.time_range,
    ...(d.segment_id === null ? {} : {segment_id: d.segment_id})};
}
function assertion(d: ProcessedEvent, assertion_id: string): AssertionInput {
  return {assertion_id, kind: 'inference', subject_ref: {type: 'known_person', id: 'owner'},
    predicate: 'role', value: 'designer', scope: {principal_id: 'owner', purpose: 'advice',
      situation: 'packaging', role: 'design-coordinator', evaluation_frame: 'business'}, evidence_refs: [ref(d)],
    evidence_status: 'available', unknown_conditions: [], conflicts: [], status: 'candidate',
    applicability_status: 'applicable', relation_to_peers: 'independent', typed_scores: {}, depends_on: []};
}
function command(command_id: string, a: AssertionInput, operation: L3Command['operation'] = 'create', expected_version = 0): L3Command {
  const payload = {command_id, operation, expected_version, assertion: a, evidence_refs: a.evidence_refs};
  return {...payload, payload_sha256: commandDigest(payload)};
}
function committed(receipt: L3Receipt | {status: 'pending_approval'}): asserts receipt is L3Receipt {
  assert.equal(receipt.status, 'committed');
}

test('actual L5 → immutable D lookup → memory tools → isolated PostgreSQL', {skip: !database}, async t => {
  assert.ok(database);
  const url = new URL(database);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439'); assert.equal(url.username, 'l3test');
  const admin = new Pool({connectionString: database});
  const schema = `l3_tools_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`); console.info("isolated_schema_created",schema);
  const pool = new Pool({connectionString: database, options: `-c search_path=${schema}`});
  const directory = await mkdtemp(join(tmpdir(), 'paios-memory-tools-'));
  const storage = new PosixStorage(directory);
  const archive = new RawArchive(storage, 10000, () => '2026-10-01T00:00:00.000Z');
  const ingress = new UnifiedIngress(archive);
  const processed = new Map<string, ProcessedEvent>();
  const l3 = new L3Service(pool);
  const makeTools = (resolveSubjectBoundContext?: import('../src/memory/tools.ts').MemoryToolConfig['resolveSubjectBoundContext']) => new MemoryToolAuthority({l3, storage, archive,
    resolveSubjectBoundContext: resolveSubjectBoundContext ?? (async request =>
      // Fixture source knows the observed speaker; identity binding is distinct from approval.
      request.context.d.event_id === 'explicit' && request.subject_ref.type === 'known_person' && request.subject_ref.id === 'owner'
        ? {principal_id:'owner', subject_ref:request.subject_ref, authority_ref:'fixture-known-observed-owner'} : undefined),
    lookupProcessed: async (principal, dId) => {
      const d = processed.get(dId); return d?.principal_id === principal ? structuredClone(d) : undefined;
    }});
  const tools = makeTools();
  async function input(event_id: string, observation = false, range?: TimeRange): Promise<ProcessedEvent> {
    const d = await ingress.accept({schema_version: 'paios.event.v1', event_id, device_id: 'mac', device_type: 'mac',
      captured_at: '2026-10-01T00:00:00.000Z', source: {channel: 'text'}, media_type: 'text',
      mime: 'text/plain;charset=utf-8', representation: 'uploaded_original', payload: Buffer.from('记住，我是主人。' + event_id),
      ...(range ? {time_range: range} : {})}, {principal_id: 'owner', device_id: 'mac', device_type: 'mac',
      consent_ref: 'ingress-consent', channel: 'text', submission: observation ? 'observation' : 'explicit_text'});
    processed.set(d.processed_event_id, d); return d;
  }
  const ctx = (d: ProcessedEvent): TrustedMemoryContext => ({principal_id: 'owner', run_id: 'native-run',
    session_id: 'native-session', tool_call_id: 'native-tool-call', d});
  const authorization = (c: L3Command): TrustedMemoryAuthorization => ({authenticated: true,
    principal_id: 'owner', source: 'explicit_user_ui', consent_ref: 'ui-consent', scope: c.assertion.scope});
  async function confirm(c: L3Command, source = tools): Promise<void> {
    const d=processed.get(c.evidence_refs[0]!.processed_event_id)!;
    const proposal=await source.commit(ctx(d),c);
    assert.equal(proposal.status,'pending_approval');
    if(proposal.status!=='pending_approval')throw Error('expected original pending proposal');
    assert.equal((await tools.confirm({...c,proposal_ref:proposal.proposal_ref}, authorization(c))).status, 'confirmed');
  }
  try {
    await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql', import.meta.url), 'utf8'));
    const d = await input('explicit', true); const context = ctx(d);
    await t.test('candidate create commits once; actual candidate / active and scope filters', async () => {
      const c = command('candidate-command', assertion(d, 'candidate'));
      const receipt = await tools.commit(context, c); committed(receipt);
      assert.equal(receipt.version, 1);
      assert.deepEqual(await tools.commit(context, c), receipt);
      assert.equal(((await tools.query(context, {assertion_id: 'candidate', status: 'candidate'})).assertions).length, 1);
      assert.deepEqual((await tools.query(context, {assertion_id: 'candidate', status: 'active'})).assertions, []);
      assert.deepEqual((await tools.query(context, {scope: {purpose: 'unrelated'}})).assertions, []);
      assert.equal(((await tools.query(context, {scope: {situation: 'packaging'}})).assertions).length, 1);
    });
    await t.test('MEM inspect reuses trusted D/run/session/tool scope and rejects forged owner',async()=>{
      const found=await tools.inspect(context,{assertion_id:'candidate'});
      assert.equal(found.status,'found');
      await assert.rejects(tools.inspect({...context,principal_id:'foreign'},{assertion_id:'candidate'}),/MEM_CONTEXT_SCOPE_DENIED/);
      await assert.rejects(tools.inspect({...context,tool_call_id:''},{assertion_id:'candidate'}),/INVALID_ID/);
      await assert.rejects(tools.inspect(context,{assertion_id:'candidate',scope:{principal_id:'foreign'}} as unknown as {assertion_id:string}),/MEM_UNKNOWN_INSPECT_ARGUMENT/);
    });
    await t.test('trusted owner main turn commits active lifecycle without a second UI approval', async () => {
      const ownerD=await input('owner-explicit'); const ownerContext=ctx(ownerD);
      const active=command('owner-active',{...assertion(ownerD,'owner-direct'),status:'active'});
      committed(await tools.commit(ownerContext,active));
      const corrected=command('owner-correct',{...active.assertion,value:'coordinator'},'correct',1);
      const receipt=await tools.commit(ownerContext,corrected); committed(receipt);
      assert.equal(receipt.version,2);
      const deletion=command('owner-delete',corrected.assertion,'delete',2);
      committed(await tools.commit(ownerContext,deletion));
      assert.deepEqual((await tools.query(ownerContext,{assertion_id:'owner-direct'})).assertions,[]);
      assert.deepEqual(await tools.commit(ownerContext,active),await tools.receipt(ownerContext,active));
      const erase={command_id:'owner-forget',assertion_id:'owner-direct',expected_version:3,
        scope:'l3_live_payloads_all_versions' as const,retention:'audit_metadata' as const};
      await assert.rejects(tools.forget(context,erase),/AUTHORIZATION_REQUIRED/);
      const forgotten=await tools.forget(ownerContext,erase);
      assert.equal(forgotten.erased_versions,3); assert.equal(forgotten.residual.l4,'not_run');
      assert.equal((await tools.inspect(ownerContext,{assertion_id:'owner-direct'})).status,'erased');
      assert.deepEqual(await tools.forget({...ownerContext,d:{...ownerD,raw_ref:`l5:${'0'.repeat(64)}`}},erase),forgotten);
    });
    await t.test('active create requires exact proposal then UI confirmation; confirmation survives tool restart', async () => {
      const c = command('active-command', {...assertion(d, 'active'), status: 'active'});
      const pending = await tools.commit(context, c);
      assert.equal(pending.status, 'pending_approval');
      assert.deepEqual((await tools.query(context, {assertion_id: 'active'})).assertions, []);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_receipts WHERE command_id=$1', [c.command_id])).rows[0].n, 0);
      await confirm(c);
      const receipt = await makeTools().commit(context, c); committed(receipt);
      assert.equal(((await tools.query(context, {assertion_id: 'active', status: 'active'})).assertions).length, 1);
      assert.equal((await tools.confirm(c, {...authorization(c), scope: {...c.assertion.scope, purpose: 'now-unrelated'}})).status,
        'already_committed');
    });
    await t.test('concurrent decisions preserve one immutable source winner without a transaction write',async()=>{
      const c=command('decision-race',{...assertion(d,'decision-race'),status:'active'});
      const proposal=await tools.commit(context,c);assert.equal(proposal.status,'pending_approval');
      const actor={authenticated:true,principal_id:'owner',source:'explicit_user_ui' as const,consent_ref:'ui',
        device_id:'device',session_id:context.session_id,run_id:context.run_id};
      const base={command_id:c.command_id,payload_sha256:c.payload_sha256,control_id:'race'};
      const results=await Promise.allSettled(['approve','reject'].map(decision=>tools.decide({...base,decision:decision as 'approve'|'reject'},actor)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const lost=results.find(r=>r.status==='rejected');assert.ok(lost && lost.status==='rejected');
      assert.match(lost.reason.message,/MEM_DECISION_CONFLICT/);assert.equal(await tools.receipt(context,c),undefined);
    });
    await t.test('explicit words or JSON claims cannot authorize promotion', async () => {
      const c = command('promotion', {...assertion(d, 'candidate'), status: 'active'}, 'review', 1);
      assert.equal((await tools.commit(context, c)).status, 'pending_approval');
      assert.equal(((await tools.query(context, {assertion_id: 'candidate', status: 'candidate'})).assertions).length, 1);
      await assert.rejects(tools.confirm(c, {...authorization(c), source: 'model_json' as 'explicit_user_ui'}), /USER_CONFIRMATION_REQUIRED/);
      await assert.rejects(tools.confirm(c, {...authorization(c), authenticated: false}), /USER_CONFIRMATION_REQUIRED/);
      await confirm(c); committed(await tools.commit(context, c));
      assert.equal(((await tools.query(context, {assertion_id: 'candidate', status: 'active'})).assertions).length, 1);
    });
    await t.test('scope, command digest and caller ownership cannot be forged', async () => {
      const c = command('scope-proposal', {...assertion(d, 'scope'), status: 'active'});
      const proposal=await tools.commit(context,c);
      if(proposal.status!=='pending_approval')throw Error('expected original proposal');
      const request={...c,proposal_ref:proposal.proposal_ref};
      await assert.rejects(tools.confirm({...request, payload_sha256: '0'.repeat(64)}, authorization(c)), /DIGEST_MISMATCH/);
      await assert.rejects(tools.confirm(request, {...authorization(c), scope: {...c.assertion.scope, role: 'other'}}), /SCOPE_DENIED/);
      await assert.rejects(tools.confirm(request, {...authorization(c), principal_id: 'other'}), /PROPOSAL_NOT_FOUND/);
      await assert.rejects(tools.commit(context, {...c, payload_sha256: '0'.repeat(64)}), /DIGEST_MISMATCH/);
      await assert.rejects(tools.commit(context, command('scope-denied', {...assertion(d, 'scope-denied'),
        scope: {...c.assertion.scope, principal_id: 'other'}})), /SCOPE_DENIED/);
      await assert.rejects(tools.query(context, {scope: {principal_id: 'other'}}), /SCOPE_DENIED/);
      await assert.rejects(tools.query({...context, principal_id: 'other'}), /CONTEXT_SCOPE_DENIED/);
      // A pending identity cannot be replaced by a different candidate to bypass approval.
      await assert.rejects(tools.commit(context, command(c.command_id, assertion(d, 'scope'))), /COMMAND_CONFLICT/);
    });
    await t.test('every evidence coordinate must match authoritative D, with actual L5 availability', async () => {
      const actual = ref(d);
      const forged: EvidenceRef[] = [{...actual, event_id: 'wrong-event'}, {...actual, processed_event_id: 'missing-d'},
        {...actual, raw_ref: `l5:${'0'.repeat(64)}`}, {...actual, archive_revision: '0'.repeat(64)},
        {...actual, segment_id: 'invented-segment'}, {...actual, time_range: {kind: 'instant', timebase_id: 'utc_unix_ms', at_ms: 0}},
        {...actual, native_message_id: 'invented-native-message'}, {...actual, native_session_id: 'wrong-session'}];
      for (const [index, evidence] of forged.entries()) {
        const attempted=tools.commit(context, command(`forged-${index}`, {...assertion(d, `forged-${index}`),evidence_refs:[evidence]}));
        if (Object.hasOwn(evidence,'native_message_id')) {
          await assert.rejects(attempted,(error:any)=>error instanceof MemoryArgumentError && error.code==='MEM_INVALID_ASSERTION' &&
            error.field_errors.some((field:any)=>field.path==='assertion.evidence_refs[0]' && field.reason==='additionalProperties') && !JSON.stringify(error.field_errors).includes('native_message_id')); 
        } else await assert.rejects(attempted,/EVIDENCE_UNAVAILABLE/);
        assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts WHERE command_id=$1',[`forged-${index}`])).rows[0].count,'0');
      }
      const missingRange = {...actual}; delete missingRange.time_range;
      await assert.rejects(tools.commit(context, command('missing-range', {...assertion(d, 'missing-range'),
        evidence_refs: [missingRange]})),(error:any)=>error instanceof MemoryArgumentError && error.code==='MEM_INVALID_ASSERTION' &&
        error.field_errors.some((field:any)=>field.path==='assertion.evidence_refs[0].time_range' && field.reason==='required'));
      assert.equal((await pool.query('SELECT count(*) FROM paios_l3_receipts WHERE command_id=$1',['missing-range'])).rows[0].count,'0');
      const withSession = {...actual, native_session_id: context.session_id};
      committed(await tools.commit(context, command('verified-session', {...assertion(d, 'verified-session'),
        evidence_refs: [withSession]})));
    });
    await t.test('instant and interval ranges persist without tuple/numeric conversion', async () => {
      const interval = await input('interval', false, {kind: 'interval', timebase_id: 'capture_clock',
        start_ms: 100, end_ms: 400, stream_epoch: 'epoch'});
      const c = command('interval-command', assertion(interval, 'interval'));
      committed(await tools.commit(ctx(interval), c));
      assert.deepEqual(((await tools.query(context, {assertion_id: 'interval'})).assertions)[0]?.evidence_refs, [ref(interval)]);
    });
    await t.test('observation and unknown speaker cannot become owner facts by saying remember', async () => {
      const observed = await input('observed-remember', true); const observedContext = ctx(observed);
      await assert.rejects(tools.commit(observedContext, command('observed-owner', assertion(observed, 'observed-owner'))),
        /SUBJECT_UNRESOLVED/);
      await assert.rejects(tools.commit(observedContext, command('observed-active', {...assertion(observed, 'observed-active'),
        status: 'active'})), /SUBJECT_UNRESOLVED/);
      const unknown = {...assertion(observed, 'unknown'), subject_ref: {type: 'unknown_subject' as const, id: 'unknown'},
        unknown_conditions: ['speaker identity is not established']};
      committed(await tools.commit(observedContext, command('unknown-candidate', unknown)));
      const stored = ((await tools.query(observedContext, {assertion_id: 'unknown'})).assertions)[0]!;
      assert.equal(stored.subject_ref.type, 'unknown_subject'); assert.equal(observed.user_identity, 'unknown');
    });
    await t.test('arbitrary known-person IDs reject with 422; non-person records stay usable as unknown candidates', async () => {
      const bad = command('arbitrary-known-person', {...assertion(d, 'inspection-record'),
        subject_ref: {type: 'known_person', id: 'test-inspection-record'}});
      await assert.rejects(tools.commit(context, bad), (error: unknown) => error instanceof ContractError &&
        error.code === 'MEM_SUBJECT_UNRESOLVED' && error.status === 422);
      assert.equal(await tools.receipt(context, bad), undefined);
      assert.deepEqual((await tools.query(context, {assertion_id: 'inspection-record'})).assertions, []);
      const unknown = command('unknown-inspection-record', {...assertion(d, 'inspection-record'),
        subject_ref: {type: 'unknown_subject', id: 'test-inspection-record'}});
      const receipt = await tools.commit(context, unknown); committed(receipt);
      const stored = ((await tools.query(context, {assertion_id: 'inspection-record', status: 'candidate'})).assertions)[0]!;
      assert.deepEqual(stored.subject_ref, unknown.assertion.subject_ref);
      assert.equal(stored.status, 'candidate');
      // The rule verifies identity binding, not a keyword classifier: existing current-owner candidates remain legitimate.
      const owner = command('current-owner-known', assertion(d, 'current-owner-known'));
      committed(await tools.commit(context, owner));
      assert.equal(((await tools.query(context, {assertion_id: 'current-owner-known'})).assertions)[0]?.subject_ref.id, 'owner');
    });
    await t.test('unproduced speaker clusters stay unresolved; configured authority must bind exact subject and evidence', async () => {
      const observed = await input('speaker-unknown', true);
      const speakerCommand = command('unproduced-speaker', {...assertion(observed, 'unproduced-speaker'),
        subject_ref: {type: 'speaker_cluster', id: 'speaker-invented'}});
      await assert.rejects(tools.commit(ctx(observed), speakerCommand), (error: unknown) =>
        error instanceof ContractError && error.code === 'MEM_SUBJECT_UNRESOLVED' && error.status === 422);
      const wrongPrincipal = makeTools(async request => ({principal_id: 'other', subject_ref: request.subject_ref,
        authority_ref: 'speaker-producer', evidence_processed_event_ids: [observed.processed_event_id]}));
      await assert.rejects(wrongPrincipal.commit(ctx(observed), speakerCommand), /SUBJECT_UNRESOLVED/);
      const wrongEvidence = makeTools(async request => ({principal_id: 'owner', subject_ref: request.subject_ref,
        authority_ref: 'speaker-producer', evidence_processed_event_ids: ['not-produced-evidence']}));
      await assert.rejects(wrongEvidence.commit(ctx(observed), speakerCommand), /SUBJECT_UNRESOLVED/);
      const missingEvidence = makeTools(async request => ({principal_id: 'owner', subject_ref: request.subject_ref,
        authority_ref: 'speaker-producer'}));
      await assert.rejects(missingEvidence.commit(ctx(observed), speakerCommand), /SUBJECT_UNRESOLVED/);
      const unknown = command('speaker-unknown-candidate', {...assertion(observed, 'speaker-unknown-candidate'),
        subject_ref: {type: 'unknown_subject', id: 'unknown-speaker'}});
      committed(await tools.commit(ctx(observed), unknown));
      assert.equal(((await tools.query(ctx(observed), {assertion_id: 'speaker-unknown-candidate'})).assertions)[0]?.subject_ref.type,
        'unknown_subject');
    });
    await t.test('configured identity-port binding is separate from UI approval; losing it never rewrites prior receipts', async () => {
      // This test fixture is an external identity authority, not a MEM-owned registry or model response.
      const registered = {principal_id: 'owner', subject_ref: {type: 'known_person' as const, id: 'registered-person'},
        authority_ref: 'verified-identity-fixture'};
      const authority = makeTools(async request => request.context.principal_id === registered.principal_id &&
        request.subject_ref.type === registered.subject_ref.type && request.subject_ref.id === registered.subject_ref.id
        ? structuredClone(registered) : undefined);
      const candidate = command('registered-candidate', {...assertion(d, 'registered-candidate'), subject_ref: registered.subject_ref});
      const receipt = await authority.commit(context, candidate); committed(receipt);
      // Reconstruct MEM without the resolver: historical receipt still wins over new dynamic identity checks.
      assert.deepEqual(await makeTools().commit(context, candidate), receipt);
      assert.deepEqual(await tools.receipt(context, candidate), receipt);
      await assert.rejects(tools.commit({...context, principal_id: 'other'}, candidate), /SCOPE_DENIED/);
      await assert.rejects(tools.resolveReceipt({...context, principal_id: 'other'}, receipt.receipt_ref), /RECEIPT_SCOPE_DENIED/);
      const active = command('registered-active', {...assertion(d, 'registered-active'), status: 'active',
        subject_ref: registered.subject_ref});
      assert.equal((await authority.commit(context, active)).status, 'pending_approval');
      await confirm(active,authority);
      await assert.rejects(tools.commit(context, active), (error: unknown) => error instanceof ContractError &&
        error.code === 'MEM_SUBJECT_UNRESOLVED' && error.status === 422);
      assert.equal(await tools.receipt(context, active), undefined);
      committed(await authority.commit(context, active));
      const denied = command('registered-denial', candidate.assertion, 'deny', 1);
      await assert.rejects(tools.commit(context, denied), /SUBJECT_UNRESOLVED/);
      assert.deepEqual(await tools.commit(context, candidate), receipt);
      assert.equal(((await tools.query(context, {assertion_id: 'registered-candidate'})).assertions)[0]?.version, 1);
    });
    await t.test('JSON-only claim produces no receipt or assertion', async () => {
      const claimed = command('never-called-json', {...assertion(d, 'never-called'), status: 'active'});
      assert.equal(await tools.receipt(context, claimed), undefined);
      assert.deepEqual((await tools.query(context, {assertion_id: 'never-called'})).assertions, []);
    });
    await t.test('correct / deny require independent confirmations and preserve scoped invalidation', async () => {
      const base = command('role-create', assertion(d, 'role'));
      committed(await tools.commit(context, base));
      const dependent = command('dependent-create', {...assertion(d, 'dependent'),
        depends_on: [{assertion_id: 'role', version: 1, dependency_kind: 'role_basis'}]});
      committed(await tools.commit(context, dependent));
      const corrected = command('role-correct', {...assertion(d, 'role'), value: 'coordinator'}, 'correct', 1);
      assert.equal((await tools.commit(context, corrected)).status, 'pending_approval');
      await confirm(corrected);
      const correction = await tools.commit(context, corrected); committed(correction);
      assert.deepEqual(correction.invalidated, ['dependent']);
      assert.deepEqual((await tools.query(context, {assertion_id: 'dependent'})).assertions, []);
      const deny = command('role-deny', {...assertion(d, 'role'), value: 'coordinator'}, 'deny', 2);
      assert.equal((await tools.commit(context, deny)).status, 'pending_approval'); await confirm(deny);
      committed(await tools.commit(context, deny));
      assert.deepEqual((await tools.query(context, {assertion_id: 'role'})).assertions, []);
      assert.equal(((await tools.query(context, {assertion_id: 'interval'})).assertions).length, 1);
    });
    await t.test('delete candidate cannot resurrect; history receipt precedes missing evidence/changed scope', async () => {
      const c = command('delete-candidate-create', assertion(d, 'delete-candidate'));
      const original = await tools.commit(context, c); committed(original);
      const deletion = command('delete-candidate', assertion(d, 'delete-candidate'), 'delete', 1);
      assert.equal((await tools.commit(context, deletion)).status, 'pending_approval');
      await confirm(deletion); committed(await tools.commit(context, deletion));
      assert.deepEqual((await tools.query(context, {assertion_id: 'delete-candidate'})).assertions, []);
      processed.delete(d.processed_event_id);
      const afterRestart = makeTools();
      assert.deepEqual(await afterRestart.commit(context, c), original);
      assert.deepEqual(await afterRestart.receipt(context, c), original);
      assert.deepEqual(await afterRestart.resolveReceipt(context, original.receipt_ref), original);
      assert.equal(await afterRestart.receipt({...context, principal_id: 'other'}, {command_id: c.command_id}), undefined);
      await assert.rejects(afterRestart.resolveReceipt({...context, principal_id: 'other'}, original.receipt_ref), /RECEIPT_SCOPE_DENIED/);
      await assert.rejects(afterRestart.receipt(context, {...c, payload_sha256: '0'.repeat(64)}), /COMMAND_CONFLICT/);
      const newUnavailable = command('new-unavailable', assertion(d, 'new-unavailable'));
      await assert.rejects(afterRestart.commit(context, newUnavailable), /EVIDENCE_UNAVAILABLE/);
      processed.set(d.processed_event_id, d);
      const revive = command('candidate-revive', {...assertion(d, 'delete-candidate'), status: 'active'}, 'review', 2);
      await tools.commit(context, revive);
      await assert.rejects(confirm(revive), /MEM_PROPOSAL_TARGET_UNAVAILABLE/);
      await assert.rejects(tools.commit(await input('revive-owner').then(ctx),command('candidate-revive-direct',revive.assertion,'review',2)), /TOMBSTONE/);
    });
    await t.test('proposal bodies and new approvals obey current L3 deletion, erasure and dependency invalidation',async()=>{
      const ownerD=await input('proposal-owner');const ownerContext=ctx(ownerD);
      const pending=command('pending-no-head',{...assertion(d,'pending-no-head'),status:'active'});
      assert.equal((await tools.commit(context,pending)).status,'pending_approval');
      assert.ok((await tools.proposals('owner',context.session_id,context.run_id)).some(v=>v.command.command_id===pending.command_id));
      for(const lifecycle of ['delete','retract','forget','invalidated'] as const){
        const assertion_id=`proposal-${lifecycle}`;
        const base={...assertion(d,assertion_id),status:'active' as const};
        if(lifecycle==='invalidated'){
          const parent=command('proposal-parent',assertion(ownerD,'proposal-parent'));
          committed(await tools.commit(ownerContext,parent));
          base.depends_on=[{assertion_id:'proposal-parent',version:1,dependency_kind:'basis'}];
        }
        committed(await tools.commit(ownerContext,command(`base-${lifecycle}`,base)));
        const c=command(`stale-${lifecycle}`,{...base,value:'sensitive proposal body'},'correct',1);
        const proposal=await tools.commit(context,c);assert.equal(proposal.status,'pending_approval');
        if(proposal.status!=='pending_approval')throw Error('expected pending');
        assert.ok((await tools.proposals('owner',context.session_id,context.run_id)).some(v=>v.command.command_id===c.command_id));
        if(lifecycle==='forget')await tools.forget(ownerContext,{command_id:'erase-proposal',assertion_id,expected_version:1,
          scope:'l3_live_payloads_all_versions',retention:'audit_metadata'});
        else if(lifecycle==='invalidated')committed(await tools.commit(ownerContext,command('change-parent',
          {...assertion(ownerD,'proposal-parent'),value:'new basis'},'correct',1)));
        else committed(await tools.commit(ownerContext,command(`terminal-${lifecycle}`,base,lifecycle,1)));
        const views=await tools.proposals('owner',context.session_id,context.run_id);
        assert.equal(views.some(v=>v.command.command_id===c.command_id),false);
        await assert.rejects(tools.confirm({...c,proposal_ref:proposal.proposal_ref},authorization(c)),/MEM_PROPOSAL_TARGET_UNAVAILABLE/);
        await assert.rejects(tools.decide({command_id:c.command_id,payload_sha256:c.payload_sha256,decision:'approve',control_id:`decision-${lifecycle}`},
          {...authorization(c),device_id:'mac',session_id:context.session_id,run_id:context.run_id}),/MEM_PROPOSAL_TARGET_UNAVAILABLE/);
        assert.equal(await tools.receipt(context,c),undefined);
      }
    });
    await t.test('original corruption fails new evidence validation, with zero transaction artifacts', async () => {
      const corrupt = await input('corrupt-original');
      await writeFile(join(directory, 'objects', corrupt.payload_sha256), Buffer.from('tampered'));
      const c = command('corrupt-original', assertion(corrupt, 'corrupt-original'));
      await assert.rejects(archive.readRecord(corrupt.raw_ref, corrupt.principal_id, corrupt.archive_revision), /INTEGRITY_FAILURE/);
      assert.equal(await archive.validateEvidence(corrupt), false);
      await assert.rejects(tools.commit(ctx(corrupt), c), /L3_EVIDENCE_UNAVAILABLE/);
      assert.equal(await tools.receipt(ctx(corrupt), c), undefined);
      assert.deepEqual((await tools.query(context, {assertion_id: 'corrupt-original'})).assertions, []);
    });
    await t.test('run receipt callback reads committed PG facts after failed run with no OPEN and after restart', async () => {
      const failureContext = {...context, run_id: 'failed-without-open', tool_call_id: 'last-tool-before-failure'};
      const c = command('before-native-failure', assertion(d, 'before-native-failure'));
      const receipt = await tools.commit(failureContext, c); committed(receipt);
      // The fixture's later failed native state has no OPEN receipt and cannot alter L3's committed facts.
      const nativeTerminal = {run_id: failureContext.run_id, status: 'failed'};
      assert.equal(nativeTerminal.status, 'failed');
      const restarted = makeTools();
      const listRunReceipts = (accepted: TrustedMemoryContext) => restarted.runReceipts(accepted);
      processed.delete(d.processed_event_id);
      assert.deepEqual(await listRunReceipts(failureContext), [receipt]);
      assert.deepEqual(await listRunReceipts({...failureContext, principal_id: 'other'}), []);
      assert.deepEqual(await restarted.commit({...failureContext, run_id: 'later-native-run'}, c), receipt);
      assert.deepEqual(await listRunReceipts({...failureContext, run_id: 'later-native-run'}), []);
      assert.deepEqual(await listRunReceipts(failureContext), [receipt]);
      assert.equal((await pool.query('SELECT run_id FROM paios_l3_receipts WHERE principal_id=$1 AND command_id=$2',
        ['owner', c.command_id])).rows[0].run_id, failureContext.run_id);
      processed.set(d.processed_event_id, d);
    });
    await t.test('concurrent same confirmed command creates one version and identical receipts', async () => {
      const c = command('same-concurrent-command', {...assertion(d, 'same-concurrent'), status: 'active'});
      await tools.commit(context, c); await confirm(c);
      const results = await Promise.all(Array.from({length: 5}, () => makeTools().commit(context, c)));
      for (const result of results) assert.deepEqual(result, results[0]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_versions WHERE assertion_id=$1',
        ['same-concurrent'])).rows[0].n, 1);
    });
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); console.info("isolated_schema_dropped",schema); await admin.end();
    await rm(directory, {recursive: true, force: true});
  }
});
