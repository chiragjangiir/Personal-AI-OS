import type { Pool } from "pg";
import { withTransaction } from "./transaction.ts";
import { REALTIME_CONVERSATION_TURN_EVENT, REALTIME_CONVERSATION_TURN_SCOPE } from "./realtime-conversation-turn-postgres.ts";
import { REALTIME_E2EE_DURABLE_REPLAY_SCOPE } from "./realtime-e2ee-durable-replay-postgres.ts";

/** These scopes contain conversation content, including transcript text in request_fingerprint. */
export const CONVERSATION_RESET_SCOPES = Object.freeze([
  REALTIME_CONVERSATION_TURN_SCOPE, "final_transcript_evidence", REALTIME_E2EE_DURABLE_REPLAY_SCOPE,
]);
export const CONVERSATION_RESET_EVENTS = Object.freeze([
  REALTIME_CONVERSATION_TURN_EVENT, "realtime.transcript_segment.finalized.v1",
]);
export interface ConversationResetTable {
  schema: string; table: string; delete_rows: number; delete_bytes: number; keep_rows: number; keep_bytes: number;
}
export interface ConversationResetPlan {
  cutoff: string; executed: boolean; bytes_basis: "pg_column_size_logical_rows";
  tables: ConversationResetTable[];
}
export interface ConversationResetReferenceTargets {
  event_ids: string[]; processed_event_ids: string[]; raw_refs: string[];
  native_session_ids: string[]; native_message_ids: string[];
}
export interface ConversationResetReferenceCount {
  schema: string; field: string; total_refs: number; affected_refs: number;
}
const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';

const OUTBOX_SELECTION = `t.event_type = ANY($2::text[]) AND t.created_at < $1::timestamptz AND coalesce((CASE t.event_type
      WHEN 'realtime.conversation.turn.completed.v1' THEN t.payload->>'committed_at'
      WHEN 'realtime.transcript_segment.finalized.v1' THEN t.payload#>>'{segment,observedAt}'
      END)::timestamptz < $1::timestamptz,false)`;

/** Offline maintenance: callers stop writers and take a restore snapshot before execute.
 * L3 payloads, receipts, dependencies, tombstones and all memory authorities stay byte-for-byte intact.
 * Accepted-activity cursors, T04 receipts, session credentials and external-effect fences are rollback audit.
 * No append-only trigger is disabled. Logical row bytes do not imply immediate disk reclamation.
 */
export async function resetPostgresConversations(
  pool: Pool, options: { cutoff: string; execute?: boolean },
): Promise<ConversationResetPlan> {
  if (!Number.isFinite(Date.parse(options.cutoff)) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(options.cutoff)) {
    throw new TypeError("CONVERSATION_RESET_CUTOFF_INVALID");
  }
  const cutoff = new Date(options.cutoff).toISOString();
  return withTransaction(pool, async client => {
    if (options.execute) {
      await client.query("LOCK TABLE public.idempotency_ledger, public.outbox_events, public.outbox_consumer_dedupe IN ACCESS EXCLUSIVE MODE");
    }
    // Shared predicates drive preview and mutation; never age-delete unknown or protected authorities.
    const outbox = OUTBOX_SELECTION;
    const ledger = `t.scope = ANY($2::text[]) AND t.created_at < $1::timestamptz
      AND coalesce(t.completed_at,t.created_at) < $1::timestamptz AND coalesce((CASE t.scope
      WHEN 'realtime.conversation_turn.v1' THEN t.response->>'committed_at'
      WHEN 'final_transcript_evidence' THEN t.response->>'observedAt'
      END)::timestamptz,t.completed_at,t.created_at) < $1::timestamptz`;
    const dedupe = `EXISTS (SELECT 1 FROM public.outbox_events t WHERE t.event_id=d.event_id AND ${outbox})`;
    const params = [cutoff, CONVERSATION_RESET_EVENTS];
    const ledgerParams = [cutoff, CONVERSATION_RESET_SCOPES];
    const relations = await client.query<{ schema: string; table: string }>(`SELECT n.nspname AS schema, c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      ORDER BY n.nspname,c.relname`);
    for (const required of ["idempotency_ledger", "outbox_events", "outbox_consumer_dedupe"]) {
      if (!relations.rows.some(r => r.schema === "public" && r.table === required)) {
        throw new Error("CONVERSATION_RESET_SCHEMA_REQUIRED");
      }
    }
    const tables: ConversationResetTable[] = [];
    for (const relation of relations.rows) {
      const predicate = relation.schema !== "public" ? "false" : relation.table === "outbox_events" ? outbox
        : relation.table === "idempotency_ledger" ? ledger : relation.table === "outbox_consumer_dedupe" ? dedupe : "false";
      const alias = relation.table === "outbox_consumer_dedupe" && relation.schema === "public" ? "d" : "t";
      const result = await client.query(`SELECT count(*) FILTER (WHERE selected)::text AS delete_rows,
        coalesce(sum(bytes) FILTER (WHERE selected),0)::text AS delete_bytes,
        count(*) FILTER (WHERE NOT selected)::text AS keep_rows,
        coalesce(sum(bytes) FILTER (WHERE NOT selected),0)::text AS keep_bytes
        FROM (SELECT (${predicate}) AS selected,pg_column_size(${alias}) AS bytes
          FROM ${quoted(relation.schema)}.${quoted(relation.table)} ${alias}) inventory`, predicate === "false" ? [] : predicate === ledger ? ledgerParams : params);
      const row = result.rows[0]!;
      const counts = Object.fromEntries(["delete_rows", "delete_bytes", "keep_rows", "keep_bytes"].map(key => {
        const value = Number(row[key]);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("CONVERSATION_RESET_COUNT_INVALID");
        return [key, value];
      })) as Pick<ConversationResetTable, "delete_rows" | "delete_bytes" | "keep_rows" | "keep_bytes">;
      tables.push({ ...relation, ...counts });
    }
    if (options.execute) {
      // Dedupe goes first so explicit counts match even with the native FK cascade.
      for (const [table, alias, predicate, values] of [
        ["outbox_consumer_dedupe", "d", dedupe, params.slice(0, 2)],
        ["idempotency_ledger", "t", ledger, ledgerParams],
        ["outbox_events", "t", outbox, params.slice(0, 2)],
      ] as const) {
        const result = await client.query(`DELETE FROM public.${table} ${alias} WHERE ${predicate}`, values);
        if (result.rowCount !== tables.find(t => t.schema === "public" && t.table === table)!.delete_rows) {
          throw new Error("CONVERSATION_RESET_DELETE_COUNT_DRIFT");
        }
      }
    }
    return { cutoff, executed: options.execute === true, bytes_basis: "pg_column_size_logical_rows", tables };
  }, { isolation: "REPEATABLE READ", readOnly: !options.execute });
}

/** Count historical L3 references without returning IDs, assertion values, scores or source content.
 * Availability is owned by runtime.processed / RawArchive, not this immutable L3 evidence identity.
 */
export async function inspectPostgresConversationReferences(
  pool: Pool, targets: ConversationResetReferenceTargets, cutoff: string,
): Promise<ConversationResetReferenceCount[]> {
  return withTransaction(pool, async client => {
    const deletedNative = await client.query<{ ids: string[] }>(`SELECT coalesce(array_agg(DISTINCT id) FILTER(WHERE id IS NOT NULL),'{}'::text[]) AS ids
      FROM public.outbox_events t CROSS JOIN LATERAL unnest(ARRAY[t.event_id::text,t.payload->>'receipt_id',
        t.payload#>>'{evidenceRef,refId}',t.payload#>>'{evidence,transcriptSegmentRef,refId}']) id
      WHERE ${OUTBOX_SELECTION}`, [cutoff, CONVERSATION_RESET_EVENTS]);
    const nativeIds = deletedNative.rows[0]!.ids;
    const targetIds = [...nativeIds,...targets.event_ids,...targets.processed_event_ids,...targets.raw_refs,
      ...targets.native_session_ids,...targets.native_message_ids];
    const schemas = await client.query<{ schema: string }>(`SELECT n.nspname AS schema FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='paios_l3_payloads' AND c.relkind='r'
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' ORDER BY n.nspname`);
    const counts: ConversationResetReferenceCount[] = [];
    for (const { schema } of schemas.rows) {
      const table = quoted(schema) + '.paios_l3_payloads';
      const result = await client.query(`WITH evidence AS (
        SELECT 'assertion_payload.evidence_refs' AS field,e AS ref FROM ${table} p,
          jsonb_array_elements(p.assertion_payload->'evidence_refs') e
        UNION ALL SELECT 'command_payload.evidence_refs',e FROM ${table} p,
          jsonb_array_elements(p.command_payload->'evidence_refs') e
        UNION ALL SELECT 'command_payload.assertion.evidence_refs',e FROM ${table} p,
          jsonb_array_elements(p.command_payload#>'{assertion,evidence_refs}') e
      ), basis AS (
        SELECT 'assertion_payload.typed_scores.'||score.key||'.basis_refs' AS field,b #>> '{}' AS ref
        FROM ${table} p,jsonb_each(p.assertion_payload->'typed_scores') score,
          jsonb_array_elements(score.value->'basis_refs') b
        UNION ALL SELECT 'command_payload.assertion.typed_scores.'||score.key||'.basis_refs',b #>> '{}'
        FROM ${table} p,jsonb_each(p.command_payload#>'{assertion,typed_scores}') score,
          jsonb_array_elements(score.value->'basis_refs') b
      ), refs AS (
        SELECT field,(ref->>'event_id'=ANY($1::text[]) OR ref->>'processed_event_id'=ANY($2::text[])
          OR ref->>'raw_ref'=ANY($3::text[]) OR ref->>'native_session_id'=ANY($4::text[])
          OR ref->>'native_message_id'=ANY($5::text[])) AS affected FROM evidence
        UNION ALL SELECT field,ref=ANY($3::text[]) FROM basis
      ) SELECT field,count(*)::text AS total_refs,count(*) FILTER(WHERE affected)::text AS affected_refs
        FROM refs GROUP BY field ORDER BY field`,
      [[...nativeIds,...targets.event_ids], targets.processed_event_ids, targets.raw_refs, targets.native_session_ids, targets.native_message_ids]);
      for (const row of result.rows) counts.push({ schema, field: row.field,
        total_refs: Number(row.total_refs), affected_refs: Number(row.affected_refs) });
      const dependencies = await client.query(`SELECT count(*)::text AS total_refs,count(*) FILTER(WHERE v.assertion_id IS NULL)::text AS affected_refs
        FROM ${quoted(schema)}.paios_l3_dependencies d LEFT JOIN ${quoted(schema)}.paios_l3_versions v
        ON v.principal_id=d.principal_id AND v.assertion_id=d.dependency_id AND v.version=d.dependency_version`);
      counts.push({ schema, field: 'depends_on.missing_version', total_refs: Number(dependencies.rows[0]!.total_refs),
        affected_refs: Number(dependencies.rows[0]!.affected_refs) });
    }
    const contracts: Record<string, string[]> = {
      memory_candidates: ['$.evidence_refs[*]', '$.canonical_payload.evidence_refs[*]', '$.correction_intent.evidenceRefs[*]', '$.canonical_payload.correction_intent.evidence_refs[*]'],
      memory_versions: ['$.evidence_refs[*]', '$.canonical_payload.evidence_refs[*]', '$.correction_intent.evidenceRefs[*]', '$.canonical_payload.correction_intent.evidence_refs[*]'],
      memory_dream_deltas: ['$.source_refs[*]', '$.delta.source_refs[*]'],
      outbox_events: ['$.payload.final_transcript_evidence_ref', '$.payload.source_visual_refs[*]',
        '$.payload.segment.correction.previousTranscriptSegmentRef', '$.payload.evidence.supersedes.previousTranscriptSegmentRef',
        '$.payload.evidence.supersedes.previousFinalEvidenceRef'],
    };
    const protectedTables = await client.query<{ table: string }>(`SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`,
    [Object.keys(contracts)]);
    for (const { table } of protectedTables.rows) {
      for (const path of contracts[table]!) {
        const result = await client.query(`SELECT count(*)::text AS total_refs,
          count(*) FILTER(WHERE EXISTS(SELECT 1 FROM jsonb_each_text(ref) member WHERE member.value=ANY($2::text[])))::text AS affected_refs
          FROM public.${quoted(table)} t CROSS JOIN LATERAL jsonb_path_query(to_jsonb(t),$1::jsonpath) ref
          ${table === 'outbox_events' ? 'WHERE NOT ('+OUTBOX_SELECTION.replaceAll('$1','$3').replaceAll('$2','$4')+')' : ''}`,
        table === 'outbox_events' ? [path+' ? (@ != null)',targetIds,cutoff,CONVERSATION_RESET_EVENTS] : [path+' ? (@ != null)',targetIds]);
        counts.push({schema:'public',field:table+path.slice(1),total_refs:Number(result.rows[0]!.total_refs),
          affected_refs:Number(result.rows[0]!.affected_refs)});
      }
    }
    return counts;
  }, { isolation: "REPEATABLE READ", readOnly: true });
}
