import { canonical, check, ContractError, digest, id, sha256 } from '../contracts.ts';
import { withTransaction } from '../../../platform-data/src/transaction.ts';
type Pool = Parameters<typeof withTransaction>[0];
type PoolClient = Parameters<Parameters<typeof withTransaction>[1]>[0];
import { forgetDigest, type ForgetRequest, type ForgetReceipt, type TrustedForgetContext, commandDigest, evidenceIdentity, validateCommand, type L3Assertion, type L3Inspection, type L3InvalidationCause, type L3Command, type L3Receipt, type Scope, type TrustedL3Context } from './contracts.ts';

/** Query pages are bounded by row count in SQL and by serialized bytes here, so one principal's growing memory never
 *  turns a broad query into an all-or-nothing failure at the provider's response limit. */
export const L3_QUERY_DEFAULT_LIMIT = 50, L3_QUERY_MAX_LIMIT = 100, L3_QUERY_PAGE_BYTES = 256 * 1024;
export interface L3QueryOptions {scope?: Partial<Scope>; limit?: number; cursor?: string}
export interface L3QueryPage {assertions: L3Assertion[]; next_cursor: string | null; truncated: boolean}
type L3QueryFilter = {assertion_id: string | null; status: string; scope: Partial<Scope> | null};
// A cursor resumes after one assertion_id of exactly the query that produced it.
function encodeCursor(filter: L3QueryFilter, after: string): string {
  return Buffer.from(JSON.stringify({v: 1, q: digest(filter), after})).toString('base64url');
}
function decodeCursor(filter: L3QueryFilter, cursor: unknown): string {
  let parsed: {v?: unknown; q?: unknown; after?: unknown} | undefined;
  try { parsed = typeof cursor === 'string' && cursor.length <= 512 ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) : undefined; }
  catch { parsed = undefined; }
  check(parsed && parsed.v === 1 && typeof parsed.after === 'string' && parsed.after.length > 0, 'L3_QUERY_CURSOR_INVALID', 422);
  check(parsed.q === digest(filter), 'L3_QUERY_CURSOR_MISMATCH', 422);
  return parsed.after as string;
}

export function isL3Namespace(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(value);
}

/** L3 business authority. No L2/L4 writer, scheduler or model execution. */
export class L3Service {
  private readonly pool: Pool;
  private readonly accepted = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private accept<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ContractError('L3_CLOSED', 409));
    const pending = Promise.resolve().then(work);
    this.accepted.add(pending);
    void pending.then(() => this.accepted.delete(pending), () => this.accepted.delete(pending));
    return pending;
  }
  /** Join accepted writes; the provisioning owner still owns pool.end(). */
  close(): Promise<void> {
    return this.closing ??= Promise.allSettled([...this.accepted]).then(() => undefined);
  }
  constructor(pool: Pool) {this.pool = pool;}
  /** Borrow the fresh Public pool only when its existing SQL namespace matches this writer. */
  static async openExisting(pool: Pool, namespace: string): Promise<L3Service> {
    if (!isL3Namespace(namespace)) {
      throw new ContractError('L3_NAMESPACE_INVALID');
    }
    const versionKey = ['principal_id', 'assertion_id', 'version'];
    const receiptKey = ['principal_id', 'command_id'];
    const specs = [
      {name: 'paios_l3_versions',
        columns: 'principal_id:text,assertion_id:text,version:integer,audit:jsonb',
        key: versionKey, foreign: []},
      {name:'paios_l3_payloads',
        columns:'principal_id:text,assertion_id:text,version:integer,assertion_payload:jsonb,command_payload:jsonb',
        key:versionKey,foreign:[{key:versionKey,table:'paios_l3_versions',target:versionKey}]},
      {name:'paios_l3_forgotten',
        columns:'principal_id:text,assertion_id:text,version:integer,command_id:text,payload_sha256:text,receipt:jsonb',
        key:versionKey.slice(0,2),foreign:[{key:versionKey,table:'paios_l3_versions',target:versionKey},
          {key:receiptKey,table:'paios_l3_receipts',target:receiptKey,deferred:true}]},
      {name: 'paios_l3_heads',
        columns: 'principal_id:text,assertion_id:text,version:integer',
        key: versionKey.slice(0, 2),
        foreign: [{key: versionKey, table: 'paios_l3_versions', target: versionKey}]},
      {name: 'paios_l3_receipts',
        columns: 'principal_id:text,command_id:text,payload_sha256:text,run_id:text,receipt:jsonb,command_audit:jsonb',
        key: receiptKey, foreign: []},
      {name: 'paios_l3_dependencies',
        columns: 'principal_id:text,assertion_id:text,version:integer,dependency_id:text,dependency_version:integer',
        key: [...versionKey, 'dependency_id', 'dependency_version'], foreign: [
          {key: versionKey, table: 'paios_l3_versions', target: versionKey},
          {key: ['principal_id', 'dependency_id', 'dependency_version'], table: 'paios_l3_versions', target: versionKey}]},
      {name: 'paios_l3_invalidations',
        columns: 'principal_id:text,assertion_id:text,version:integer,command_id:text,reason:text',
        key: [...versionKey, 'command_id'], foreign: [
          {key: versionKey, table: 'paios_l3_versions', target: versionKey},
          {key: receiptKey, table: 'paios_l3_receipts', target: receiptKey, deferred: true}]},
    ];
    const result = await pool.query(`
      SELECT c.relname AS name, c.relkind AS kind, n.nspname AS namespace,
        c.oid = to_regclass(c.relname) AS visible,
        has_schema_privilege(n.oid, 'USAGE') AS schema_usage,
        CASE WHEN c.relkind = 'S' THEN
          (has_sequence_privilege(c.oid, 'USAGE') OR has_sequence_privilege(c.oid, 'UPDATE'))
          ELSE has_table_privilege(c.oid, 'SELECT') AND has_table_privilege(c.oid, 'INSERT') AND
            (c.relname <> 'paios_l3_heads' OR has_table_privilege(c.oid, 'UPDATE')) AND
            (c.relname <> 'paios_l3_payloads' OR has_table_privilege(c.oid, 'DELETE')) END AS permitted,
        (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
        (SELECT bool_and(a.attnotnull) FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS not_null,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'kind', k.contype, 'valid', k.convalidated,
          'key', (SELECT array_agg(a.attname ORDER BY s.ordinality) FROM unnest(k.conkey) WITH ORDINALITY s(num, ordinality)
            JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=s.num),
          'table', f.relname, 'namespace', fn.nspname,
          'target', (SELECT array_agg(a.attname ORDER BY s.ordinality) FROM unnest(k.confkey) WITH ORDINALITY s(num, ordinality)
            JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=s.num),
          'deferred', k.condeferrable AND k.condeferred)), '[]'::jsonb)
          FROM pg_constraint k LEFT JOIN pg_class f ON f.oid=k.confrelid
          LEFT JOIN pg_namespace fn ON fn.oid=f.relnamespace
          WHERE k.conrelid=c.oid AND k.contype IN ('p','f','u')) AS constraints
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
    `, [namespace, [...specs.map(spec => spec.name), 'paios_l3_watermark']]);
    const sameKey = (actual: unknown, expected: string[]) =>
      Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
    for (const spec of specs) {
      const table = result.rows.find(row => row.name === spec.name);
      if (!table || table.kind !== 'r' || table.namespace !== namespace || table.visible !== true ||
        table.schema_usage !== true || table.permitted !== true || table.columns !== spec.columns || table.not_null !== true) {
        throw new ContractError('L3_EXISTING_SCHEMA_REQUIRED', 503);
      }
      const constraints = table.constraints as {kind: string; valid: boolean; key: unknown;
        table: string; namespace: string; target: unknown; deferred: boolean}[];
      if (!Array.isArray(constraints) || !constraints.some(k => k.kind === 'p' && k.valid && sameKey(k.key, spec.key)) ||
        !spec.foreign.every(f => constraints.some(k => k.kind === 'f' && k.valid && sameKey(k.key, f.key) &&
          k.table === f.table && k.namespace === namespace && sameKey(k.target, f.target) &&
          (!('deferred' in f) || k.deferred === true)))) {
        throw new ContractError('L3_EXISTING_KEYS_REQUIRED', 503);
      }
      if (spec.name === 'paios_l3_forgotten' && constraints.some(k => k.kind === 'u' &&
        (sameKey(k.key, receiptKey) || sameKey(k.key, [...receiptKey].reverse())))) {
        throw new ContractError('L3_FORGET_MIGRATION_REQUIRED', 503);
      }
      if (spec.name === 'paios_l3_invalidations' && constraints.some(k => k.kind === 'f' &&
        sameKey(k.key, receiptKey) && k.deferred !== true)) {
        throw new ContractError('L3_EXISTING_KEYS_REQUIRED', 503);
      }
    }
    const sequence = result.rows.find(row => row.name === 'paios_l3_watermark');
    if (!sequence || sequence.kind !== 'S' || sequence.namespace !== namespace || sequence.visible !== true ||
      sequence.schema_usage !== true || sequence.permitted !== true) throw new ContractError('L3_EXISTING_SEQUENCE_REQUIRED', 503);
    const guards = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure($3) AND t.tgtype=27`,
      [namespace,['paios_l3_versions','paios_l3_receipts','paios_l3_dependencies','paios_l3_invalidations','paios_l3_forgotten'],
        namespace+'.paios_l3_immutable_guard()']);
    if (guards.rows[0]?.n!==5) throw new ContractError('L3_IMMUTABLE_GUARD_REQUIRED',503);
    // PostgreSQL 18 renders the migration's two exact shape constraints canonically.
    const shapes=await pool.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace=$1::regnamespace AND convalidated AND conname=ANY($2::text[]) ORDER BY conname`,
      [namespace,['l3_command_audit_shape','l3_version_audit_shape']]);
    if (sha256(JSON.stringify(shapes.rows))!=='cdf4cffafde114409e126b556e9e2c2b3944eb74e3adb0fdd9d62cc13ecc74f7')
      throw new ContractError('L3_AUDIT_SHAPE_REQUIRED',503);
    return new L3Service(pool);
  }

  async commit(command: L3Command, context: TrustedL3Context): Promise<L3Receipt> {
    const snapshot = structuredClone(command), trusted = {...context};
    return this.accept(() => this.commitAccepted(snapshot, trusted));
  }
  private async commitAccepted(command: L3Command, context: TrustedL3Context): Promise<L3Receipt> {
    if (!context.authenticated || !context.principal_id || !context.run_id || !context.context_ref) throw new ContractError('L3_UNAUTHENTICATED', 401);
    // Authenticate ownership and digest before any historical receipt is disclosed.
    const {payload_sha256, ...payload} = command;
    if (commandDigest(payload) !== payload_sha256) throw new ContractError('L3_DIGEST_MISMATCH', 409);
    if (command.assertion.scope.principal_id !== context.principal_id) throw new ContractError('L3_SCOPE_DENIED', 403);
    const replay = await this.receipt(context, command.command_id, command.payload_sha256);
    if (replay) return replay;
    return withTransaction(this.pool, async client => {
      // One per-principal lifecycle lock also prevents dependency creation racing invalidation.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [context.principal_id]);
      const prior = await client.query('SELECT payload_sha256, receipt FROM paios_l3_receipts WHERE principal_id=$1 AND command_id=$2', [context.principal_id, command.command_id]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_sha256 !== command.payload_sha256) throw new ContractError('L3_COMMAND_CONFLICT', 409);
        return prior.rows[0].receipt as L3Receipt;
      }
      const erased = await client.query('SELECT 1 FROM paios_l3_forgotten WHERE principal_id=$1 AND assertion_id=$2',
        [context.principal_id,command.assertion.assertion_id]);
      if (erased.rows.length) throw new ContractError('L3_FORGOTTEN',409);
      validateCommand(command, context.principal_id);
      if (!await context.authorize(command)) throw new ContractError('L3_AUTHORIZATION_REQUIRED', 403);
      for (const ref of [...command.evidence_refs, ...command.assertion.evidence_refs]) {
        if (!await context.evidenceAvailable(ref)) throw new ContractError('L3_EVIDENCE_UNAVAILABLE', 409);
      }
      const current = await this.head(client, context.principal_id, command.assertion.assertion_id);
      if ((current?.version ?? 0) !== command.expected_version) throw new ContractError('L3_VERSION_CONFLICT', 409);
      if ((command.operation === 'create') !== (current === undefined)) throw new ContractError('L3_OPERATION_CONFLICT', 409);
      if (current && (current.status === 'deleted' || current.status === 'retracted')) throw new ContractError('L3_TOMBSTONE', 409);
      if (current && canonical(current.scope) !== canonical(command.assertion.scope)) throw new ContractError('L3_SCOPE_CHANGE_REQUIRES_NEW_BRANCH', 409);
      if (command.operation === 'deny' && (!['inference', 'evaluation', 'preference', 'plan'].includes(command.assertion.kind) || !current || !['inference', 'evaluation', 'preference', 'plan'].includes(current.kind))) throw new ContractError('L3_DENIAL_CANNOT_REWRITE_FACT', 403);
      if (command.operation === 'deny' && (command.assertion.subject_ref.type !== 'known_person' || command.assertion.subject_ref.id !== context.principal_id || current?.subject_ref.type !== 'known_person' || current.subject_ref.id !== context.principal_id)) throw new ContractError('L3_DENIAL_SUBJECT_MISMATCH', 403);
      if (command.operation === 'review' && current?.status !== 'candidate') throw new ContractError('L3_NOT_CANDIDATE', 409);
      if (command.operation === 'review' && command.assertion.status !== 'active') throw new ContractError('L3_REVIEW_REQUIRES_ACTIVE', 422);
      if (command.operation === 'correct' && !['active','candidate'].includes(command.assertion.status)) throw new ContractError('L3_CORRECTION_REQUIRES_LIVE', 422);
      // Promotion keeps every business field and the applicable source unchanged.
      const promotion = current && command.operation === 'review' && current.applicability_status === 'applicable' && (() => {
        const {version, previous_version, created_at, effective_at, authorizing_context_ref, ...business} = current;
        return canonical({...business, status: 'active'}) === canonical(command.assertion);
      })();
      if (current) {
        const oldSupport = current.typed_scores.interpretation_support?.value_or_interval;
        const newSupport = command.assertion.typed_scores.interpretation_support?.value_or_interval;
        const max = (x: number | [number, number] | undefined) => x === undefined ? undefined : typeof x === 'number' ? x : x[1];
        const before = max(oldSupport), after = max(newSupport);
        const oldEvidence = new Set(current.evidence_refs.map(evidenceIdentity));
        if (before !== undefined && after !== undefined && after > before && command.assertion.evidence_refs.every(e => oldEvidence.has(evidenceIdentity(e)))) throw new ContractError('L3_REPEATED_EVIDENCE_SUPPORT_INCREASE', 409);
      }
      const status = command.operation === 'delete' ? 'deleted' : ['deny','retract'].includes(command.operation) ? 'retracted' : command.assertion.status;
      if (command.operation === 'create' && ['deleted','retracted'].includes(status)) throw new ContractError('L3_CREATE_TERMINAL', 422);
      for (const dependency of command.assertion.depends_on) {
        if (dependency.assertion_id === command.assertion.assertion_id) throw new ContractError('L3_SELF_DEPENDENCY', 422);
        const dep = await this.head(client, context.principal_id, dependency.assertion_id);
        const cyclic = await client.query(`WITH RECURSIVE ancestors(assertion_id,version) AS (SELECT $2::text,$3::integer UNION SELECT d.dependency_id,d.dependency_version FROM paios_l3_dependencies d JOIN ancestors a ON d.assertion_id=a.assertion_id AND d.version=a.version WHERE d.principal_id=$1) SELECT 1 FROM ancestors WHERE assertion_id=$4 LIMIT 1`, [context.principal_id,dependency.assertion_id,dependency.version,command.assertion.assertion_id]);
        if (cyclic.rows.length) throw new ContractError('L3_DEPENDENCY_CYCLE', 409);
        if (!dep || dep.version !== dependency.version || dep.applicability_status !== 'applicable' || !['active','candidate'].includes(dep.status)) throw new ContractError('L3_DEPENDENCY_INVALID', 409);
      }
      const now = new Date().toISOString();
      const assertion: L3Assertion = {...command.assertion, status, applicability_status: ['deleted','retracted'].includes(status) ? 'stopped' : 'applicable', version: command.expected_version + 1, previous_version: current?.version ?? null, created_at: now, effective_at:now, authorizing_context_ref: context.context_ref, ...(command.operation === 'deny' ? {invalidation_scope: command.assertion.scope} : {})};
      await client.query('INSERT INTO paios_l3_versions(principal_id, assertion_id, version, audit) VALUES($1,$2,$3,$4)', [context.principal_id, assertion.assertion_id, assertion.version,
        {schema:'l3.audit.v1',status:assertion.status,applicability_status:assertion.applicability_status}]);
      await client.query('INSERT INTO paios_l3_payloads VALUES($1,$2,$3,$4,$5)',
        [context.principal_id,assertion.assertion_id,assertion.version,assertion,command]);
      if (current) {
        const cas = await client.query('UPDATE paios_l3_heads SET version=$3 WHERE principal_id=$1 AND assertion_id=$2 AND version=$4', [context.principal_id, assertion.assertion_id, assertion.version, command.expected_version]);
        if (cas.rowCount !== 1) throw new ContractError('L3_VERSION_CONFLICT', 409);
      } else await client.query('INSERT INTO paios_l3_heads(principal_id, assertion_id, version) VALUES($1,$2,$3)', [context.principal_id, assertion.assertion_id, assertion.version]);
      for (const dependency of assertion.depends_on) await client.query('INSERT INTO paios_l3_dependencies VALUES($1,$2,$3,$4,$5)', [context.principal_id, assertion.assertion_id, assertion.version, dependency.assertion_id, dependency.version]);
      const invalidated = current && !promotion ? await this.invalidate(client, context.principal_id, current, command.command_id) : [];
      const watermark = await client.query("SELECT nextval('paios_l3_watermark')::text AS value");
      const receipt: L3Receipt = {receipt_ref: 'l3:' + context.principal_id + ':' + command.command_id, command_id: command.command_id, payload_sha256: command.payload_sha256, status: 'committed', assertion_id: assertion.assertion_id, version: assertion.version, previous_version: assertion.previous_version, authority_watermark: watermark.rows[0].value, committed_at: now, invalidated};
      await client.query(`INSERT INTO paios_l3_receipts
        (principal_id, command_id, payload_sha256, run_id, receipt, command_audit) VALUES($1,$2,$3,$4,$5,$6)`,
        [context.principal_id, command.command_id, command.payload_sha256, context.run_id, receipt, {schema:'l3.command-audit.v1',operation:command.operation,assertion_id:assertion.assertion_id,expected_version:command.expected_version}]);
      return receipt;
    });
  }
  async forget(request:ForgetRequest, context:TrustedForgetContext):Promise<ForgetReceipt> {
    const snapshot = structuredClone(request), trusted = {...context};
    return this.accept(() => this.forgetAccepted(snapshot, trusted));
  }
  private async forgetAccepted(request:ForgetRequest, context:TrustedForgetContext):Promise<ForgetReceipt> {
    if (!context.authenticated || context.source!=='explicit_user_request') throw new ContractError('L3_FORGET_AUTH_REQUIRED',403);
    for (const value of [context.principal_id,context.run_id,context.context_ref,context.consent_ref,request.command_id,request.assertion_id]) id(value);
    if (Object.keys(request).sort().join(',')!=='assertion_id,command_id,expected_version,payload_sha256,principal_id,retention,scope') throw new ContractError('L3_FORGET_SCOPE_INVALID',422);
    const {payload_sha256,...payload}=request;
    if (forgetDigest(payload)!==payload_sha256) throw new ContractError('L3_DIGEST_MISMATCH',409);
    if (request.principal_id!==context.principal_id) throw new ContractError('L3_SCOPE_DENIED',403);
    if (request.scope!=='l3_live_payloads_all_versions' || request.retention!=='audit_metadata' ||
      !Number.isSafeInteger(request.expected_version) || request.expected_version<1) throw new ContractError('L3_FORGET_SCOPE_INVALID',422);
    return withTransaction(this.pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[context.principal_id]);
      const prior=await client.query('SELECT payload_sha256,receipt FROM paios_l3_forgotten WHERE principal_id=$1 AND command_id=$2',[context.principal_id,request.command_id]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_sha256!==payload_sha256) throw new ContractError('L3_COMMAND_CONFLICT',409);
        return prior.rows[0].receipt as ForgetReceipt;
      }
      if (!await context.authorize(request)) throw new ContractError('L3_AUTHORIZATION_REQUIRED',403);
      if ((await client.query('SELECT 1 FROM paios_l3_receipts WHERE principal_id=$1 AND command_id=$2',[context.principal_id,request.command_id])).rows.length)
        throw new ContractError('L3_COMMAND_CONFLICT',409);
      const current=await this.head(client,context.principal_id,request.assertion_id);
      if (!current || current.version!==request.expected_version) throw new ContractError('L3_VERSION_CONFLICT',409);
      const dependencyInvalidations=await this.invalidate(client,context.principal_id,current,request.command_id);
      // Historical dependency pins remain sensitive even after a dependent gets a new head.
      // Forget the whole assertion lineage so neither inspection nor rebuilding can recover it.
      const closure=await client.query(`WITH RECURSIVE affected(assertion_id) AS (
        SELECT $2::text UNION SELECT d.assertion_id FROM paios_l3_dependencies d
        JOIN affected a ON d.dependency_id=a.assertion_id WHERE d.principal_id=$1)
        SELECT h.assertion_id,h.version FROM paios_l3_heads h JOIN affected a USING(assertion_id)
        WHERE h.principal_id=$1 AND NOT EXISTS(SELECT 1 FROM paios_l3_forgotten f
          WHERE f.principal_id=h.principal_id AND f.assertion_id=h.assertion_id)
        ORDER BY h.assertion_id`,[context.principal_id,request.assertion_id]);
      const affected=closure.rows.map(row=>row.assertion_id as string);
      const invalidated=[...new Set([...dependencyInvalidations,...affected.filter(id=>id!==request.assertion_id)])];
      const erased=await client.query('DELETE FROM paios_l3_payloads WHERE principal_id=$1 AND assertion_id=ANY($2::text[]) RETURNING version',
        [context.principal_id,affected]);
      if (erased.rows.length!==closure.rows.reduce((sum,row)=>sum+row.version,0)) throw new ContractError('L3_PAYLOAD_HISTORY_INCOMPLETE',503);
      const watermark=(await client.query("SELECT nextval('paios_l3_watermark')::text AS value")).rows[0].value;
      const now=new Date().toISOString();
      const receipt:ForgetReceipt={receipt_ref:'l3-forget:'+context.principal_id+':'+request.command_id,
        command_id:request.command_id,payload_sha256,assertion_id:request.assertion_id,version:current.version,
        scope:request.scope,status:'committed',erased_versions:erased.rows.length,authority_watermark:watermark,
        committed_at:now,invalidated,consent_ref:context.consent_ref,authorizing_context_ref:context.context_ref,residual:{audit:'retained',proposal:'not_run',l2:'not_run',l4:'not_run',l5:'not_run',backups:'not_run'}};
      const effect:L3Receipt={receipt_ref:'l3:'+context.principal_id+':'+request.command_id,
        command_id:request.command_id,payload_sha256,status:'committed',assertion_id:request.assertion_id,
        version:current.version,previous_version:current.previous_version,authority_watermark:watermark,committed_at:now,invalidated};
      await client.query('INSERT INTO paios_l3_receipts VALUES($1,$2,$3,$4,$5,$6)',[context.principal_id,request.command_id,
        payload_sha256,context.run_id,effect,{schema:'l3.command-audit.v1',operation:'forget',assertion_id:request.assertion_id,expected_version:current.version}]);
      for (const row of closure.rows) await client.query('INSERT INTO paios_l3_forgotten VALUES($1,$2,$3,$4,$5,$6)',
        [context.principal_id,row.assertion_id,row.version,request.command_id,payload_sha256,receipt]);
      return receipt;
    });
  }
  private async head(client: PoolClient, principal: string, id: string): Promise<L3Assertion | undefined> {
    const result = await client.query(`SELECT p.assertion_payload AS payload, EXISTS(SELECT 1 FROM paios_l3_invalidations i WHERE i.principal_id=v.principal_id AND i.assertion_id=v.assertion_id AND i.version=v.version) AS invalidated FROM paios_l3_heads h JOIN paios_l3_versions v USING(principal_id,assertion_id,version) JOIN paios_l3_payloads p USING(principal_id,assertion_id,version) WHERE h.principal_id=$1 AND h.assertion_id=$2`, [principal,id]);
    if (!result.rows[0]) return undefined;
    const a = result.rows[0].payload as L3Assertion;
    return result.rows[0].invalidated ? {...a, applicability_status: 'needs_reevaluation'} : a;
  }
  private async invalidate(client: PoolClient, principal: string, old: L3Assertion, command: string): Promise<string[]> {
    // Invalidate current dependents of every prior pinned source version, including pure promotions.
    // Immutable dependencies and version history stay available for audit.
    const result = await client.query(`WITH RECURSIVE affected(assertion_id,version) AS (
      SELECT d.assertion_id,d.version FROM paios_l3_dependencies d JOIN paios_l3_heads h USING(principal_id,assertion_id,version) WHERE d.principal_id=$1 AND d.dependency_id=$2 AND d.dependency_version<=$3
      UNION SELECT d.assertion_id,d.version FROM paios_l3_dependencies d JOIN paios_l3_heads h USING(principal_id,assertion_id,version) JOIN affected a ON d.dependency_id=a.assertion_id AND d.dependency_version<=a.version WHERE d.principal_id=$1)
      INSERT INTO paios_l3_invalidations SELECT $1,assertion_id,version,$4,'dependency_changed' FROM affected ON CONFLICT DO NOTHING RETURNING assertion_id`, [principal,old.assertion_id,old.version,command]);
    return result.rows.map(row => row.assertion_id as string);
  }
  async receipt(context: Pick<TrustedL3Context, 'authenticated' | 'principal_id'>,
    command_id: string, payload_sha256?: string): Promise<L3Receipt | undefined> {
    if (!context.authenticated || !context.principal_id) throw new ContractError('L3_UNAUTHENTICATED', 401);
    const result = await this.pool.query('SELECT payload_sha256, receipt FROM paios_l3_receipts WHERE principal_id=$1 AND command_id=$2',
      [context.principal_id, command_id]);
    if (!result.rows[0]) return undefined;
    if (payload_sha256 !== undefined && result.rows[0].payload_sha256 !== payload_sha256) throw new ContractError('L3_COMMAND_CONFLICT', 409);
    return result.rows[0].receipt as L3Receipt;
  }
  async receiptsForRun(context: Pick<TrustedL3Context, 'authenticated' | 'principal_id'>,
    run_id: string): Promise<L3Receipt[]> {
    if (!context.authenticated || !context.principal_id) throw new ContractError('L3_UNAUTHENTICATED', 401);
    id(run_id);
    const result = await this.pool.query(`SELECT receipt FROM paios_l3_receipts
      WHERE principal_id=$1 AND run_id=$2 ORDER BY (receipt->>'authority_watermark')::bigint`,
      [context.principal_id, run_id]);
    return result.rows.map(row => row.receipt as L3Receipt);
  }
  async inspect(context: Pick<TrustedL3Context, 'authenticated' | 'principal_id'>,
    assertion_id: string): Promise<L3Inspection> {
    if (!context.authenticated || !context.principal_id) throw new ContractError('L3_UNAUTHENTICATED', 401);
    id(assertion_id);
    // A single SQL statement owns one MVCC snapshot for head, version, receipt and causes.
    // Receipt linkage checks both persisted receipt identity and the original command target.
    const result = await this.pool.query(`SELECT p.assertion_payload AS payload, f.receipt AS forget_receipt, v.version,
      current_receipt.receipt, current_receipt.command_audit->>'operation' AS operation,
      COALESCE(causes.items, '[]'::jsonb) AS invalidation_causes
      FROM paios_l3_heads h JOIN paios_l3_versions v USING(principal_id,assertion_id,version)
      LEFT JOIN paios_l3_payloads p USING(principal_id,assertion_id,version)
      LEFT JOIN paios_l3_forgotten f ON f.principal_id=v.principal_id AND f.assertion_id=v.assertion_id
      LEFT JOIN LATERAL (SELECT r.receipt, r.command_audit FROM paios_l3_receipts r
        WHERE r.principal_id=v.principal_id AND r.receipt->>'assertion_id'=v.assertion_id
        AND r.receipt->>'version'=v.version::text
        AND r.command_audit->>'assertion_id'=v.assertion_id
        AND r.command_audit->>'expected_version'=(v.version-1)::text
        ORDER BY r.command_id LIMIT 1) current_receipt ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
        'reason', i.reason, 'command_id', i.command_id, 'receipt', r.receipt,
        'operation', r.command_audit->>'operation',
        'changed_assertion_id', r.command_audit->>'assertion_id',
        'changed_version', r.receipt->'version') ORDER BY i.command_id) AS items
        FROM paios_l3_invalidations i LEFT JOIN paios_l3_receipts r
          ON r.principal_id=i.principal_id AND r.command_id=i.command_id
        WHERE i.principal_id=v.principal_id AND i.assertion_id=v.assertion_id
          AND i.version=v.version) causes ON true
      WHERE h.principal_id=$1 AND h.assertion_id=$2`, [context.principal_id, assertion_id]);
    const row = result.rows[0];
    if (!row) return {status: 'not_found', assertion_id};
    if (row.forget_receipt) return {status:'erased',assertion_id,version:row.version,receipt:row.forget_receipt};
    if (!row.payload) throw new ContractError('L3_PAYLOAD_MISSING',503);
    const stored = row.payload as L3Assertion;
    const causes = row.invalidation_causes as L3InvalidationCause[];
    const terminal = ['deleted', 'retracted'].includes(stored.status);
    const assertion = {...stored, applicability_status: terminal ? 'stopped' as const :
      causes.length ? 'needs_reevaluation' as const : stored.applicability_status};
    const unknown_conditions: string[] = [];
    if (!row.receipt || !row.operation) unknown_conditions.push('CURRENT_VERSION_RECEIPT_OR_OPERATION_MISSING');
    if (causes.some(cause => !cause.receipt || !cause.operation || !cause.changed_assertion_id ||
      cause.changed_version === null)) unknown_conditions.push('INVALIDATION_PROVENANCE_INCOMPLETE');
    if (assertion.applicability_status !== 'applicable' && !terminal && !causes.length)
      unknown_conditions.push('APPLICABILITY_CAUSE_UNKNOWN');
    const provenance = {provenance_status: unknown_conditions.length ? 'partial' as const : 'complete' as const,
      unknown_conditions, current_version: {operation: row.operation ?? null, receipt: row.receipt ?? null},
      invalidation_causes: causes};
    // Inspection explains unavailability without returning terminal or invalidated fact payloads.
    if (terminal || assertion.applicability_status !== 'applicable') return {
      status: stored.status === 'deleted' ? 'deleted' : stored.status === 'retracted' ? 'retracted' : 'invalidated',
      assertion_id, version: stored.version,
      applicability_status: terminal ? 'stopped' : 'needs_reevaluation', ...provenance};
    return {status: 'found', assertion, ...provenance};
  }
  async query(context: Pick<TrustedL3Context, 'authenticated' | 'principal_id'>, assertion_id?: string,
    status: 'active' | 'candidate' | 'all' = 'all', options: L3QueryOptions = {}): Promise<L3QueryPage> {
    if (!context.authenticated || !context.principal_id) throw new ContractError('L3_UNAUTHENTICATED', 401);
    const limit = options.limit ?? L3_QUERY_DEFAULT_LIMIT;
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= L3_QUERY_MAX_LIMIT, 'L3_QUERY_LIMIT_INVALID', 422);
    const scope = options.scope && Object.keys(options.scope).length ? options.scope : null;
    const filter: L3QueryFilter = {assertion_id: assertion_id ?? null, status, scope};
    const after = options.cursor === undefined ? null : decodeCursor(filter, options.cursor);
    // Scope keys compare by exact JSON value inside SQL; ordering by assertion_id makes the cursor stable.
    const result = await this.pool.query(`SELECT h.assertion_id, p.assertion_payload AS payload FROM paios_l3_heads h JOIN paios_l3_versions v USING(principal_id,assertion_id,version) JOIN paios_l3_payloads p USING(principal_id,assertion_id,version)
      WHERE h.principal_id=$1 AND ($2::text IS NULL OR h.assertion_id=$2)
      AND p.assertion_payload->>'status' IN ('active','candidate') AND ($3::text='all' OR p.assertion_payload->>'status'=$3)
      AND p.assertion_payload->>'applicability_status'='applicable'
      AND NOT EXISTS(SELECT 1 FROM paios_l3_invalidations i WHERE i.principal_id=v.principal_id AND i.assertion_id=v.assertion_id AND i.version=v.version)
      AND ($4::text IS NULL OR h.assertion_id>$4)
      AND ($5::jsonb IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_each($5::jsonb) f WHERE p.assertion_payload->'scope'->f.key IS DISTINCT FROM f.value))
      ORDER BY h.assertion_id LIMIT $6`, [context.principal_id, assertion_id ?? null, status, after, scope, limit + 1]);
    const assertions: L3Assertion[] = []; let bytes = 0;
    for (const row of result.rows.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(row.payload));
      // The first row is always served so a single large assertion stays reachable page by page.
      if (assertions.length && bytes + size > L3_QUERY_PAGE_BYTES) break;
      assertions.push(row.payload as L3Assertion); bytes += size;
    }
    const truncated = result.rows.length > assertions.length;
    return {assertions, truncated,
      next_cursor: truncated ? encodeCursor(filter, assertions[assertions.length - 1]!.assertion_id) : null};
  }
}
