import assert from "node:assert/strict";
import { test } from "node:test";
import { L3Service } from "../../personal-aios-integration/src/memory/l3.ts";
import { resetPostgresConversations, inspectPostgresConversationReferences, CONVERSATION_RESET_EVENTS, CONVERSATION_RESET_SCOPES } from "../src/conversation-reset.ts";

const cutoff = "2026-10-18T10:14:00.000Z";
const old = "2026-10-18T10:13:59.000Z";
type Row = { completed_at?: string; response?: {committed_at?: string; observedAt?: string}; payload?: {committed_at?: string; segment?: {observedAt: string}}; created_at: string; scope?: string; idempotency_scope?: string; idempotency_key?: string; event_type?: string; event_id?: string };

function fixture(empty = false) {
  const rows: Record<string, Row[]> = {
    idempotency_ledger: empty ? [] : [
      ...CONVERSATION_RESET_SCOPES.map(scope => ({ scope, created_at: old, idempotency_key: scope })),
      { scope: CONVERSATION_RESET_SCOPES[0], created_at: cutoff, idempotency_key: "new" },
      { scope: "payment", created_at: old }, { scope: "memory.canonical_append", created_at: old },
    ],
    outbox_events: empty ? [] : [
      ...CONVERSATION_RESET_EVENTS.map((event_type, i) => ({ event_type, created_at: old, payload: {committed_at: old, segment: {observedAt: old}}, event_id: String(i) })),
      { event_type: CONVERSATION_RESET_EVENTS[0], created_at: cutoff, payload: {committed_at: cutoff}, event_id: "new" },
      { event_type: "realtime.t04.accepted_user_activity.v1", created_at: old, event_id: "audit" },
    ],
    outbox_consumer_dedupe: empty ? [] : [{ event_id: "0", created_at: old }, { event_id: "new", created_at: old }],
    paios_l3_payloads: empty ? [] : [{ created_at: old }],
    paios_l3_dependencies: empty ? [] : [{ created_at: old }],
    paios_l3_forgotten: empty ? [] : [{ created_at: old }],
    memory_versions: empty ? [] : [{ created_at: old }],
    paired_devices: empty ? [] : [{ created_at: old }],
  };
  const statements: string[] = [];
  let snapshot: typeof rows;
  let failDelete = false;
  const selected = (table: string, row: Row): boolean => {
    if (table === "outbox_events") return row.created_at < cutoff && (row.event_type === CONVERSATION_RESET_EVENTS[0] ? row.payload?.committed_at : row.payload?.segment?.observedAt)! < cutoff && CONVERSATION_RESET_EVENTS.includes(row.event_type!);
    if (table === "outbox_consumer_dedupe") return rows.outbox_events!.some(event => event.event_id === row.event_id && selected("outbox_events", event));
    return table === "idempotency_ledger" && row.created_at < cutoff && (row.completed_at ?? row.created_at) < cutoff && (row.response?.committed_at ?? row.response?.observedAt ?? row.completed_at ?? row.created_at) < cutoff && CONVERSATION_RESET_SCOPES.includes(row.scope!);
  };
  const client = {
    release() {},
    async query(sql: string, params: unknown[] = []): Promise<any> {
      statements.push(sql);
      if (sql === "BEGIN") snapshot = structuredClone(rows);
      if (sql === "ROLLBACK") Object.assign(rows, snapshot);
      if (sql.includes("FROM pg_class")) return { rows: Object.keys(rows).map(table => ({ schema: "public", table })) };
      if (sql.startsWith("SELECT count(*) FILTER")) {
        const table = /FROM "public"\."([^"]+)"/u.exec(sql)![1]!;
        const count = rows[table]!.filter(row => selected(table, row)).length;
        assert.equal(params.length, table === "idempotency_ledger" || table.startsWith("outbox_") ? 2 : 0);
        return { rows: [{ delete_rows: String(count), delete_bytes: String(count * 10), keep_rows: String(rows[table]!.length - count), keep_bytes: String((rows[table]!.length - count) * 10) }] };
      }
      if (sql.startsWith("DELETE")) {
        const table = /DELETE FROM public\.(\w+)/u.exec(sql)![1]!;
        const before = rows[table]!.length;
        rows[table] = rows[table]!.filter(row => !selected(table, row));
        if (failDelete && table === "outbox_events") throw new Error("delete failure");
        return { rows: [], rowCount: before - rows[table]!.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { rows, statements, pool: { connect: async () => client } as any, fail: () => { failDelete = true; } };
}

test("preview is read-only; execute removes content/replay/dedupe and preserves cutoff plus protected authorities", async () => {
  const f = fixture();
  const before = structuredClone(f.rows);
  const plan = await resetPostgresConversations(f.pool, { cutoff });
  assert.equal(plan.executed, false);
  assert.deepEqual(f.rows, before);
  assert(f.statements.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert(!f.statements.some(sql => /DELETE|ALTER|LOCK TABLE/u.test(sql)));
  const applied = await resetPostgresConversations(f.pool, { cutoff, execute: true });
  assert.deepEqual(applied.tables, plan.tables);
  assert.equal(f.rows.idempotency_ledger!.length, 3);
  assert.equal(f.rows.outbox_events!.length, 2);
  assert.equal(f.rows.outbox_consumer_dedupe!.length, 1);
  for (const table of ["paios_l3_payloads", "paios_l3_dependencies", "paios_l3_forgotten", "memory_versions", "paired_devices"]) assert.deepEqual(f.rows[table], before[table]);
  const again = await resetPostgresConversations(f.pool, { cutoff, execute: true });
  assert(again.tables.every(table => table.delete_rows === 0));
  assert(!f.statements.some(sql => /DISABLE|TRUNCATE/u.test(sql)));
});

test("empty reset twice is idempotent and failed mutation rolls the transaction back", async () => {
  const empty = fixture(true);
  for (let i = 0; i < 2; i++) assert((await resetPostgresConversations(empty.pool, { cutoff, execute: true })).tables.every(table => table.delete_rows === 0));
  const f = fixture();
  const before = structuredClone(f.rows);
  f.fail();
  await assert.rejects(resetPostgresConversations(f.pool, { cutoff, execute: true }), /delete failure/u);
  assert.deepEqual(f.rows, before);
  assert(f.statements.includes("ROLLBACK"));
});

test("timezone-free cutoff is rejected before connecting", async () => {
  await assert.rejects(resetPostgresConversations({} as any, { cutoff: "2026-10-18T10:14:00" }), /CUTOFF_INVALID/u);
});


test("creation and completion boundaries always preserve newer records despite earlier source observation", async () => {
  const f = fixture(true);
  f.rows.idempotency_ledger!.push(
    {scope: CONVERSATION_RESET_SCOPES[0], created_at: old, response: {committed_at: cutoff}},
    {scope: 'final_transcript_evidence', created_at: cutoff, response: {observedAt: old}},
    {scope: CONVERSATION_RESET_SCOPES[0], created_at: old, completed_at: cutoff, response: {committed_at: old}},
    {scope: 'final_transcript_evidence', created_at: old, completed_at: old, response: {observedAt: old}},
  );
  f.rows.outbox_events!.push(
    {event_type: CONVERSATION_RESET_EVENTS[0], created_at: old, payload: {committed_at: cutoff}},
    {event_type: CONVERSATION_RESET_EVENTS[1], created_at: cutoff, payload: {segment: {observedAt: old}}},
    {event_type: CONVERSATION_RESET_EVENTS[1], created_at: old, payload: {segment: {observedAt: old}}},
  );
  const result = await resetPostgresConversations(f.pool, {cutoff, execute: true});
  assert.equal(result.tables.find(t => t.table === 'idempotency_ledger')!.delete_rows, 1);
  assert.equal(result.tables.find(t => t.table === 'outbox_events')!.delete_rows, 1);
  assert.equal(f.rows.idempotency_ledger![0]!.response!.committed_at, cutoff);
  assert.equal(f.rows.outbox_events![0]!.payload!.committed_at, cutoff);
});

test("L3 reference inspection reports only counts across evidence, score basis and version dependencies", async () => {
  const statements: string[] = [];
  const targets = {event_ids:['event'],processed_event_ids:['processed'],raw_refs:['l5:private'],native_session_ids:['session'],native_message_ids:['message']};
  const client = {release(){}, async query(sql: string, params?: unknown[]) {
    statements.push(sql);
    if (sql.includes('array_agg(DISTINCT id)')) {
      assert(sql.includes("evidenceRef,refId"));
      assert(sql.includes("evidence,transcriptSegmentRef,refId"));
      assert(sql.includes('t.created_at < $1'));
      return {rows:[{ids:['deleted-pg-evidence-id']}]};
    }
    if (sql.includes("c.relname='paios_l3_payloads'")) return {rows:[{schema:'l3'}]};
    if (sql.includes("n.nspname='public'")) return {rows:[{table:'memory_versions'},{table:'outbox_events'}]};
    if (sql.includes('jsonb_path_query')) {
      assert.equal(typeof params![0], 'string');
      assert((params![1] as string[]).includes('l5:private'));
      assert((params![1] as string[]).includes('deleted-pg-evidence-id'));
      if (sql.includes('public."outbox_events"')) { assert(sql.includes('WHERE NOT (')); assert.equal(params![2],cutoff); }
      assert(String(params![0]).endsWith('? (@ != null)'));
      assert(!sql.includes('t,CROSS'));
      return {rows:[{total_refs:'2',affected_refs:'1'}]};
    }
    if (sql.startsWith('WITH evidence')) {
      assert.deepEqual(params, [['deleted-pg-evidence-id',...targets.event_ids],targets.processed_event_ids,targets.raw_refs,targets.native_session_ids,targets.native_message_ids]);
      for (const field of ['assertion_payload','command_payload','typed_scores','evidence_refs','basis_refs']) assert(sql.includes(field));
      return {rows:[{field:'assertion_payload.evidence_refs',total_refs:'3',affected_refs:'2'}]};
    }
    if (sql.includes('paios_l3_dependencies')) return {rows:[{total_refs:'1',affected_refs:'0'}]};
    return {rows:[]};
  }};
  const counts = await inspectPostgresConversationReferences({connect:async()=>client} as any,targets,cutoff);
  assert.deepEqual(counts.slice(0,2),[{schema:'l3',field:'assertion_payload.evidence_refs',total_refs:3,affected_refs:2},
    {schema:'l3',field:'depends_on.missing_version',total_refs:1,affected_refs:0}]);
  assert(counts.some(c=>c.field==='memory_versions.evidence_refs[*]'));
  assert(counts.some(c=>c.field.includes('previousFinalEvidenceRef')));
  assert(!JSON.stringify(counts).includes('private'));
  assert(!statements.some(sql=>/DELETE|INSERT|UPDATE/u.test(sql)));
});


test("native L3 query and inspect preserve assertions, evidence identities, score basis and receipts after reset", async () => {
  const f = fixture();
  const evidence = {event_id:'event-before-reset',processed_event_id:'processed-before-reset',raw_ref:'l5:'+ 'a'.repeat(64),archive_revision:'b'.repeat(64)};
  const assertion = {assertion_id:'preserved-assertion',version:1,previous_version:null,kind:'fact',subject_ref:{type:'known_person',id:'owner'},
    predicate:'preference',value:'preserved-value',scope:{principal_id:'owner',purpose:'memory',situation:'home',role:'user',evaluation_frame:'default'},
    evidence_refs:[evidence],evidence_status:'available-at-creation',unknown_conditions:[],conflicts:[],status:'active',applicability_status:'applicable',
    relation_to_peers:'independent',typed_scores:{interpretation_support:{value_or_interval:0.8,scale:[0,1],basis_refs:[evidence.raw_ref]}},
    depends_on:[],authorizing_context_ref:'context',created_at:old};
  const receipt = {receipt_ref:'l3:owner:create',command_id:'create',payload_sha256:'c'.repeat(64),status:'committed',assertion_id:assertion.assertion_id,
    version:1,previous_version:null,authority_watermark:'1',committed_at:old,invalidated:[]};
  Object.assign(f.rows.paios_l3_payloads![0]!, {assertion_payload:assertion,command_payload:{assertion,evidence_refs:[evidence]}});
  const stored = () => (f.rows.paios_l3_payloads![0] as any).assertion_payload;
  f.pool.query = async (sql: string) => {
    if (sql.startsWith('SELECT h.assertion_id')) return {rows:[{assertion_id:assertion.assertion_id,payload:stored()}]};
    if (sql.startsWith('SELECT p.assertion_payload')) return {rows:[{payload:stored(),version:1,receipt,operation:'create',invalidation_causes:[]}]};
    throw new Error('unexpected L3 read');
  };
  const service = new L3Service(f.pool);
  const context = {authenticated:true,principal_id:'owner'};
  const beforeQuery = await service.query(context);
  const beforeInspect = await service.inspect(context,assertion.assertion_id);
  await resetPostgresConversations(f.pool,{cutoff,execute:true});
  assert.deepEqual(await service.query(context),beforeQuery);
  assert.deepEqual(await service.inspect(context,assertion.assertion_id),beforeInspect);
  assert.deepEqual((await service.query(context)).assertions[0]!.evidence_refs,[evidence]);
  assert.equal(beforeInspect.status,'found');
  assert('provenance_status' in beforeInspect && beforeInspect.provenance_status==='complete');
  // Complete is receipt metadata; availability comes from runtime.processed/RawArchive and may now be absent.
  await service.close();
});
