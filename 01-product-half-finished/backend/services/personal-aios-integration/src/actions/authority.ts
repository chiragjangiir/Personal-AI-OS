import { readFile } from 'node:fs/promises';
import { withTransaction } from '../../../platform-data/src/transaction.ts';
import { claimIdempotency, completeIdempotency, readIdempotency } from '../../../platform-data/src/idempotency-ledger.ts';
import { check, digest, id, validateProcessed } from '../contracts.ts';
import { LocalNoteExecutor, type NoteArtifact } from './local-note.ts';
import { prepareAction, type ActionCommand, type ActionRequest, type ActionReceipt,
  type ActionConfirmation, type TrustedActionContext, type TrustedActionAuthorization } from './contracts.ts';
type Pool = Parameters<typeof withTransaction>[0];
type Client = Parameters<Parameters<typeof withTransaction>[1]>[0];
export interface ActionConfig {local_notes_root: string; control_version?: string}

// Fixture composition only; canonical ledger DDL is read from its existing owner migration, not reimplemented.
export async function initializeActionSchema(pool: Pool): Promise<void> {
  const existing = await readFile(new URL('../../../../migrations/0001_idempotency_outbox.up.sql', import.meta.url), 'utf8');
  const ledger = existing.slice(existing.indexOf('CREATE TABLE IF NOT EXISTS idempotency_ledger'), existing.indexOf('CREATE TABLE IF NOT EXISTS outbox_events'));
  await withTransaction(pool, async client => {
    const schema = await client.query('SELECT current_schema() AS name');
    check(/^paios_fixture_[a-z0-9_]+$/u.test(schema.rows[0]?.name ?? ''), 'ACTION_ISOLATED_SCHEMA_REQUIRED');
    await client.query(ledger);
    await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  });
}

// Business action owner. PostgreSQL owns proposal/authorization/invocation facts; shared ledger owns effect state.
export class ActionAuthority {
  private readonly pool: Pool; private readonly notes: LocalNoteExecutor; private readonly controlVersion: string;
  constructor(pool: Pool, config: ActionConfig) {
    this.pool = pool; this.notes = new LocalNoteExecutor(config.local_notes_root);
    this.controlVersion = config.control_version ?? 'local-note-v1'; id(this.controlVersion);
  }
  private owner(ctx: TrustedActionContext): void {
    check(ctx.authenticated, 'ACTION_UNAUTHENTICATED', 401);
    id(ctx.principal_id); id(ctx.run_id); id(ctx.target.device_id);
  }
  private identity(principal: string, command: ActionCommand) {
    return {scope: `paios.action:${principal}`, idempotencyKey: command.action_id, requestHash: command.payload_sha256};
  }
  private async lock(client: Client, principal: string, action: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`action:${principal}:${action}`]);
  }
  private async proposal(client: Client, principal: string, action: string) {
    const query = await client.query('SELECT command,pending_receipt FROM paios_action_proposals WHERE principal_id=$1 AND action_id=$2', [principal,action]);
    return query.rows[0] as {command: ActionCommand; pending_receipt: ActionReceipt} | undefined;
  }
  private historical(ctx: TrustedActionContext, command: ActionCommand): void {
    check(command.target_device_id === ctx.target.device_id, 'ACTION_DEVICE_SCOPE_DENIED', 403);
  }
  private unknown(pending: ActionReceipt, run: string, consent: string): ActionReceipt {
    return {...pending, status: 'reconcile_required', execution_run_id: run, consent_ref: consent};
  }
  async request(ctx: TrustedActionContext, args: ActionRequest): Promise<ActionReceipt> {
    this.owner(ctx); const command = prepareAction(ctx.principal_id, args); this.historical(ctx, command);
    const decision = await withTransaction(this.pool, async client => {
      await this.lock(client, ctx.principal_id, command.action_id);
      let proposed = await this.proposal(client, ctx.principal_id, command.action_id);
      if (proposed) check(proposed.command.payload_sha256 === command.payload_sha256, 'ACTION_PAYLOAD_CONFLICT', 409);
      else {
        validateProcessed(ctx.d); check(ctx.d.principal_id === ctx.principal_id, 'ACTION_CONTEXT_SCOPE_DENIED', 403);
        check(command.expected_control_version === this.controlVersion, 'ACTION_CONTROL_VERSION_CONFLICT', 409);
        const receipt: ActionReceipt = {receipt_ref: `action:${ctx.principal_id}:${command.action_id}`,
          action_id: command.action_id, action_type: command.action_type, target_device_id: command.target_device_id,
          payload_sha256: command.payload_sha256, status: 'pending_approval', execution_run_id: null,
          consent_ref: null, artifact_ref: null, artifact_sha256: null, bytes: null, recorded_at: new Date().toISOString()};
        await client.query('INSERT INTO paios_action_proposals VALUES($1,$2,$3,$4,$5,$6,$7)',
          [ctx.principal_id,command.action_id,command.business_intent_id,command.parameter_version,command.payload_sha256,command,receipt]);
        proposed = {command, pending_receipt: receipt};
      }
      await client.query('INSERT INTO paios_action_invocations VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [ctx.principal_id,command.action_id,ctx.run_id]);
      const found = await readIdempotency(client, this.identity(ctx.principal_id, command));
      if (found?.status === 'committed') return {receipt: found.response as ActionReceipt, execute: false};
      const auth = await client.query('SELECT consent_ref,payload_sha256 FROM paios_action_confirmations WHERE principal_id=$1 AND action_id=$2', [ctx.principal_id,command.action_id]);
      if (!auth.rows[0]) return {receipt: proposed.pending_receipt, execute: false};
      check(auth.rows[0].payload_sha256 === command.payload_sha256, 'ACTION_AUTHORIZATION_CONFLICT', 409);
      const execution = await client.query('SELECT execution_run_id FROM paios_action_execution WHERE principal_id=$1 AND action_id=$2', [ctx.principal_id,command.action_id]);
      if (found) return {receipt: this.unknown(proposed.pending_receipt, execution.rows[0].execution_run_id, auth.rows[0].consent_ref), execute: false};
      check(command.expected_control_version === this.controlVersion, 'ACTION_CONTROL_VERSION_CONFLICT', 409);
      const claim = await claimIdempotency(client, this.identity(ctx.principal_id,command));
      check(claim.kind === 'new', 'ACTION_CLAIM_CONFLICT', 409);
      await client.query('INSERT INTO paios_action_execution VALUES($1,$2,$3)', [ctx.principal_id,command.action_id,ctx.run_id]);
      return {receipt: this.unknown(proposed.pending_receipt,ctx.run_id,auth.rows[0].consent_ref), execute: true};
    });
    if (!decision.execute) return decision.receipt;
    // External IO occurs only after a durable claim. Failure/restart leaves an unknown effect, never automatic reexecution.
    const artifact = await this.notes.execute(ctx.principal_id,command);
    return this.finish(ctx,command,decision.receipt,artifact);
  }
  private async finish(ctx: TrustedActionContext, command: ActionCommand, pending: ActionReceipt, artifact: NoteArtifact): Promise<ActionReceipt> {
    return withTransaction(this.pool, async client => {
      await this.lock(client,ctx.principal_id,command.action_id);
      const prior = await readIdempotency(client,this.identity(ctx.principal_id,command));
      if (prior?.status === 'committed') return prior.response as ActionReceipt;
      const receipt: ActionReceipt = {...pending,...artifact,status:'committed',recorded_at:new Date().toISOString()};
      await completeIdempotency(client,this.identity(ctx.principal_id,command),receipt,digest(receipt));
      return receipt;
    });
  }
  async confirm(request: ActionConfirmation, auth: TrustedActionAuthorization) {
    check(auth.authenticated && auth.source === 'explicit_user_ui', 'ACTION_UI_CONFIRMATION_REQUIRED', 403);
    id(auth.principal_id); id(auth.device_id); id(auth.consent_ref); id(request.action_id);
    check(/^[a-f0-9]{64}$/u.test(request.payload_sha256), 'ACTION_INVALID_DIGEST');
    return withTransaction(this.pool, async client => {
      await this.lock(client,auth.principal_id,request.action_id);
      const proposed = await this.proposal(client,auth.principal_id,request.action_id);
      check(proposed, 'ACTION_PROPOSAL_NOT_FOUND', 404);
      check(proposed.command.payload_sha256 === request.payload_sha256, 'ACTION_CONFIRMATION_DIGEST_MISMATCH', 409);
      check(proposed.command.target_device_id === auth.device_id, 'ACTION_DEVICE_SCOPE_DENIED', 403);
      await client.query('INSERT INTO paios_action_confirmations VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [auth.principal_id,request.action_id,request.payload_sha256,auth.consent_ref,auth.device_id,auth.source]);
      const saved = await client.query('SELECT consent_ref FROM paios_action_confirmations WHERE principal_id=$1 AND action_id=$2', [auth.principal_id,request.action_id]);
      return {status:'confirmed' as const,action_id:request.action_id,payload_sha256:request.payload_sha256,consent_ref:saved.rows[0].consent_ref as string};
    });
  }
  async receipt(ctx: TrustedActionContext, request: {action_id: string; payload_sha256?: string}): Promise<ActionReceipt | undefined> {
    this.owner(ctx); id(request.action_id);
    return withTransaction(this.pool, async client => {
      const proposed = await this.proposal(client,ctx.principal_id,request.action_id); if (!proposed) return undefined;
      this.historical(ctx,proposed.command);
      check(request.payload_sha256 === undefined || request.payload_sha256 === proposed.command.payload_sha256, 'ACTION_PAYLOAD_CONFLICT', 409);
      const found = await readIdempotency(client,this.identity(ctx.principal_id,proposed.command));
      if (found?.status === 'committed') return found.response as ActionReceipt;
      if (!found) return proposed.pending_receipt;
      const execution = await client.query('SELECT e.execution_run_id,c.consent_ref FROM paios_action_execution e JOIN paios_action_confirmations c USING(principal_id,action_id) WHERE e.principal_id=$1 AND e.action_id=$2', [ctx.principal_id,request.action_id]);
      return this.unknown(proposed.pending_receipt,execution.rows[0].execution_run_id,execution.rows[0].consent_ref);
    });
  }
  async resolveReceipt(ctx: TrustedActionContext, ref: string): Promise<ActionReceipt | undefined> {
    const prefix = `action:${ctx.principal_id}:`; check(ref.startsWith(prefix), 'ACTION_RECEIPT_SCOPE_DENIED', 403);
    return this.receipt(ctx,{action_id:ref.slice(prefix.length)});
  }
  async runReceipts(ctx: TrustedActionContext): Promise<ActionReceipt[]> {
    this.owner(ctx);
    const ids = await this.pool.query('SELECT action_id FROM paios_action_invocations WHERE principal_id=$1 AND run_id=$2 ORDER BY action_id', [ctx.principal_id,ctx.run_id]);
    const receipts: ActionReceipt[] = [];
    for (const row of ids.rows) {const found = await this.receipt(ctx,{action_id:row.action_id}); if (found) receipts.push(found);}
    return receipts;
  }
  async reconcile(ctx: TrustedActionContext, request: ActionConfirmation): Promise<ActionReceipt> {
    this.owner(ctx);
    const proposed = await withTransaction(this.pool, client => this.proposal(client,ctx.principal_id,request.action_id));
    check(proposed && proposed.command.payload_sha256 === request.payload_sha256, 'ACTION_PAYLOAD_CONFLICT', 409);
    this.historical(ctx,proposed.command);
    const prior = await this.receipt(ctx,request); check(prior, 'ACTION_PROPOSAL_NOT_FOUND', 404);
    if (prior.status !== 'reconcile_required') return prior;
    const artifact = await this.notes.inspect(ctx.principal_id,proposed.command);
    if (!artifact) return prior; // An absent artifact does not authorize retry of an unknown past effect.
    return this.finish(ctx,proposed.command,prior,artifact);
  }
}
