import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {L3Service, L3_QUERY_MAX_LIMIT, L3_QUERY_PAGE_BYTES} from '../src/memory/l3.ts';
import {prepareMemoryCommand} from '../src/memory/tools.ts';
import {commandDigest, forgetDigest, validateCommand, type AssertionInput, type L3Command, type TrustedL3Context} from '../src/memory/contracts.ts';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
import {IDENTIFIER_PATTERN, isIdentifier} from '../src/contracts.ts';

const require = createRequire(new URL('../../platform-data/package.json', import.meta.url));
const {Pool} = require('pg');
const database = process.env.PAIOS_L3_TEST_DATABASE_URL;
const evidence = {event_id: 'controlled-e', processed_event_id: 'controlled-d', raw_ref: 'l5:' + '1'.repeat(64), archive_revision: '2'.repeat(64),
  time_range: {kind: 'instant' as const, timebase_id: 'utc_unix_ms', at_ms: 1}};
const trusted: TrustedL3Context = {authenticated: true, principal_id: 'owner', run_id: 'controlled-run', context_ref: 'controlled-context',
  authorize: async () => true, evidenceAvailable: async () => true};
const scope = (purpose = 'advice') => ({principal_id: 'owner', purpose, situation: 'packaging', role: 'buyer', evaluation_frame: 'business'});
function assertion(id: string, extra: Partial<AssertionInput> = {}): AssertionInput {
  return {assertion_id: id, kind: 'preference', subject_ref: {type: 'known_person', id: 'owner'}, predicate: 'likes', value: 'tea',
    scope: scope(), evidence_refs: [evidence], evidence_status: 'available', unknown_conditions: [], conflicts: [], status: 'candidate',
    applicability_status: 'applicable', relation_to_peers: 'independent', typed_scores: {}, depends_on: [], ...extra};
}
function command(id: string, a: AssertionInput, version = 0, operation: L3Command['operation'] = 'create'): L3Command {
  const c = {command_id: id, operation, expected_version: version, assertion: a, evidence_refs: [evidence]};
  return {...c, payload_sha256: commandDigest(c)};
}
async function fixture(t: TestContext) {
  const url = new URL(database!); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439');
  const schema = 'l3_paging_' + randomUUID().replaceAll('-', ''), admin = new Pool({connectionString: database});
  const pool = new Pool({connectionString: database, options: '-c search_path=' + schema});
  await admin.query('CREATE SCHEMA ' + schema);
  t.after(async () => { try { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); } finally { await admin.end(); } });
  for (const file of ['0009_hermes_l3.up.sql', '0012_l3_payload_audit_split.up.sql', '0018_l3_forget_dependency_closure.up.sql'])
    await pool.query(await readFile(new URL('../../../migrations/' + file, import.meta.url), 'utf8'));
  return L3Service.openExisting(pool, schema);
}
async function all(service: L3Service, status: 'all' | 'candidate' | 'active' = 'all', options: Parameters<L3Service['query']>[3] = {}) {
  const ids: string[] = []; let cursor: string | undefined; let pages = 0;
  do {
    const page = await service.query(trusted, undefined, status, {...options, ...(cursor ? {cursor} : {})});
    // Each page fits the provider's 1 MiB response read with headroom.
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1048576 - 65536);
    ids.push(...page.assertions.map(a => a.assertion_id)); pages++;
    assert.equal(page.truncated, page.next_cursor !== null);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return {ids, pages};
}

test('one identifier rule: public schema pattern and server validators agree', () => {
  const schemas = enabledToolSchemas({memory: true});
  const query = schemas.find(s => s.name === 'paios_l3_query')!;
  assert.equal((query.parameters.properties.assertion_id as {pattern: string}).pattern, IDENTIFIER_PATTERN);
  for (const value of ['my preference', 'x'.repeat(201), '-lead', 'a/b', '', 'ok:1', 'x'.repeat(200)])
    assert.equal(isIdentifier(value), new RegExp(IDENTIFIER_PATTERN, 'u').test(value), value);
});

test('a write rejects every ID shape the strict readers would refuse (no DB needed)', () => {
  const invalid = ['my preference', 'x'.repeat(201), '-lead', 'a/b', 'é'];
  for (const bad of invalid) {
    for (const make of [
      (v: string) => command('cmd', assertion(v)),
      (v: string) => command(v, assertion('ok')),
      (v: string) => command('cmd', assertion('ok', {subject_ref: {type: 'unknown_subject', id: v}})),
      (v: string) => command('cmd', assertion('ok', {depends_on: [{assertion_id: v, version: 1, dependency_kind: 'basis'}]})),
      (v: string) => command('cmd', assertion('ok', {branch_id: v})),
      (v: string) => command('cmd', assertion('ok', {evidence_refs: [{...evidence, segment_id: v}]})),
    ]) assert.throws(() => validateCommand(make(bad), 'owner'), /L3_INVALID_ID|L3_INVALID_COMMAND/, bad);
    // The model-facing boundary derives the digest and reaches the same domain rule on commit.
    const {payload_sha256: _digest, ...args} = command('cmd', assertion(bad));
    assert.throws(() => validateCommand(prepareMemoryCommand(args), 'owner'), /L3_INVALID_ID/);
  }
  assert.doesNotThrow(() => validateCommand(command('cmd', assertion('pref:tea.v1-ok_2')), 'owner'));
});

test('property: every ID a write accepts is queryable, inspectable and forgettable', {skip: !database}, async t => {
  const service = await fixture(t);
  const candidates = ['simple', 'pref:tea.v1-ok_2', 'x'.repeat(200), 'my preference', 'x'.repeat(201), '-lead', 'a/b'];
  for (const [index, candidate] of candidates.entries()) {
    const written = await service.commit(command('create-' + index, assertion(candidate)), trusted).then(() => true, error => {
      assert.match(String(error), /L3_INVALID_ID/); return false; });
    assert.equal(written, isIdentifier(candidate), candidate);
    if (!written) { await assert.rejects(service.inspect(trusted, candidate), /INVALID_ID/); continue; }
    assert.equal((await service.query(trusted, candidate)).assertions.length, 1);
    assert.equal((await service.inspect(trusted, candidate)).status, 'found');
    const request = {command_id: 'forget-' + index, principal_id: 'owner', assertion_id: candidate, expected_version: 1,
      scope: 'l3_live_payloads_all_versions' as const, retention: 'audit_metadata' as const};
    const receipt = await service.forget({...request, payload_sha256: forgetDigest(request)},
      {authenticated: true, principal_id: 'owner', run_id: 'controlled-run', context_ref: 'controlled-context',
        source: 'explicit_user_request', consent_ref: 'consent-1', authorize: async () => true});
    assert.equal(receipt.status, 'committed');
  }
});

test('many small assertions: bounded pages, stable cursor, every match exactly once in order', {skip: !database}, async t => {
  const service = await fixture(t);
  const ids = Array.from({length: 130}, (_, i) => `pref-${String(i).padStart(3, '0')}`);
  for (const id of ids) await service.commit(command('c-' + id, assertion(id)), trusted);
  const first = await service.query(trusted);
  assert.equal(first.assertions.length, 50); assert.equal(first.truncated, true);
  const max = await service.query(trusted, undefined, 'all', {limit: L3_QUERY_MAX_LIMIT});
  assert.equal(max.assertions.length, 100);
  const walked = await all(service);
  assert.deepEqual(walked.ids, ids); assert.equal(walked.pages, 3);
  assert.deepEqual((await all(service, 'all', {limit: 7})).ids, ids);
  // A cursor belongs to its own query; misuse and malformed values are explicit errors, not silent restarts.
  await assert.rejects(service.query(trusted, undefined, 'candidate', {cursor: first.next_cursor!}), /L3_QUERY_CURSOR_MISMATCH/);
  await assert.rejects(service.query(trusted, undefined, 'all', {cursor: 'not-a-cursor'}), /L3_QUERY_CURSOR_INVALID/);
  for (const limit of [0, 101, 1.5]) await assert.rejects(service.query(trusted, undefined, 'all', {limit}), /L3_QUERY_LIMIT_INVALID/);
});

test('beyond the old 1 MiB failure point: large assertions page by bytes and a single oversized item stays reachable', {skip: !database}, async t => {
  const service = await fixture(t);
  const ids = Array.from({length: 12}, (_, i) => `big-${String(i).padStart(2, '0')}`);
  for (const id of ids) await service.commit(command('c-' + id, assertion(id, {value: 'v'.repeat(120 * 1024)})), trusted);
  await service.commit(command('c-huge', assertion('huge', {value: 'h'.repeat(L3_QUERY_PAGE_BYTES + 1024)})), trusted);
  const walked = await all(service);
  assert.deepEqual(walked.ids, [...ids, 'huge']);
  assert.ok(walked.pages >= 7, String(walked.pages));
  const huge = await service.query(trusted, 'huge');
  assert.equal(huge.assertions.length, 1); assert.equal(huge.truncated, false);
});

test('scope filtering runs in SQL with exact per-key equality across pages', {skip: !database}, async t => {
  const service = await fixture(t);
  const timed = {...scope('travel'), valid_time: {from: '2026-01-01T00:00:00.000Z', until: '2026-12-31T00:00:00.000Z'}};
  for (let i = 0; i < 60; i++) await service.commit(command('a-' + i, assertion(`advice-${String(i).padStart(2, '0')}`)), trusted);
  for (let i = 0; i < 5; i++) await service.commit(command('t-' + i, assertion(`travel-${i}`, {scope: timed})), trusted);
  assert.deepEqual((await all(service, 'all', {scope: {purpose: 'travel'}})).ids, ['travel-0', 'travel-1', 'travel-2', 'travel-3', 'travel-4']);
  assert.equal((await all(service, 'all', {scope: {purpose: 'advice', situation: 'packaging'}})).ids.length, 60);
  assert.equal((await all(service, 'all', {scope: {valid_time: timed.valid_time}})).ids.length, 5);
  // Equality, not containment: a partial valid_time object does not match a stored {from, until}.
  assert.equal((await all(service, 'all', {scope: {valid_time: {from: timed.valid_time.from}}})).ids.length, 0);
  assert.equal((await all(service, 'all', {scope: {purpose: 'unrelated'}})).ids.length, 0);
});
