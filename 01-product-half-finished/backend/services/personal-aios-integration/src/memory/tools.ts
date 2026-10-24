import { Ajv, type ErrorObject } from 'ajv';
import { memoryCommandParameterSchema } from '../tool-contracts.ts';
import { canonical, check, ContractError, digest, id, principalAttribution, validateProcessed, type ProcessedEvent } from '../contracts.ts';
import type { RawArchive } from '../archive.ts';
import type { StoragePort } from '../storage.ts';
import { L3Service, type L3QueryPage } from './l3.ts';
import { commandDigest, forgetDigest, validateCommand, type ForgetRequest, type ForgetReceipt, type EvidenceRef, type L3Assertion, type L3Command,
  type L3Receipt, type L3Inspection, type Scope, type TrustedL3Context } from './contracts.ts';

export type MemoryCommandInput = Omit<L3Command, 'payload_sha256'> & {payload_sha256?: string};

export interface MemoryFieldError {path: string; reason: string}
export class MemoryArgumentError extends ContractError {
  readonly field_errors: MemoryFieldError[];
  constructor(code: string, fields: MemoryFieldError[]) {super(code); this.field_errors = fields;}
}
const commandSchema = memoryCommandParameterSchema();
// Compile shape from the same declaration. Value/domain constraints stay in validateCommand.
function parameterShape(schema: any): any {
  const shape: any = {};
  for (const key of ['type', 'required', 'additionalProperties'])
    if (Object.hasOwn(schema, key)) shape[key] = schema[key];
  if (schema.properties) shape.properties = Object.fromEntries(Object.entries(schema.properties)
    .map(([key, child]) => [key, parameterShape(child)]));
  if (schema.items) shape.items = parameterShape(schema.items);
  if (schema.oneOf) shape.anyOf = schema.oneOf.map(parameterShape);
  return shape;
}
const validateParameters = new Ajv({allErrors: true, strict: true}).compile(parameterShape(commandSchema));
function schemaProperty(schema: any, key: string): any {
  if (schema.properties && Object.hasOwn(schema.properties, key)) return schema.properties[key];
  return schema.oneOf?.map((branch: unknown) => schemaProperty(branch, key)).find(Boolean);
}
function safeFields(errors: ErrorObject[]): MemoryFieldError[] {
  return errors.slice(0, 8).map(error => {
    // Follow schema-owned names only. Never echo arbitrary caller keys or values.
    let schema: any = commandSchema;
    const parts: string[] = [];
    for (const part of error.instancePath.split('/').slice(1)) {
      if (schema.type === 'array' && /^\d+$/u.test(part)) {parts.push(`[${part}]`); schema = schema.items;}
      else if (schemaProperty(schema, part)) {
        parts.push((parts.length ? '.' : '') + part); schema = schemaProperty(schema, part);
      } else break;
    }
    if (error.keyword === 'required' && schemaProperty(schema, error.params.missingProperty))
      parts.push((parts.length ? '.' : '') + error.params.missingProperty);
    return {path: parts.join('') || '$', reason: error.keyword};
  });
}
// The model supplies business parameters; MEM derives the stable digest at its own boundary.
export function prepareMemoryCommand(args: unknown): L3Command {
  if (!(args !== null && typeof args === 'object' && !Array.isArray(args) &&
      Object.getPrototypeOf(args) === Object.prototype))
    throw new MemoryArgumentError('MEM_INVALID_COMMAND', [{path:'$', reason:'type'}]);
  if (!validateParameters(args)) {
    const fields = safeFields(validateParameters.errors!);
    const first = validateParameters.errors![0]!;
    const code = first.instancePath === '' && first.keyword === 'required' ? 'MEM_COMMAND_ARGUMENT_REQUIRED' :
      first.instancePath === '' && first.keyword === 'additionalProperties' ? 'MEM_UNKNOWN_COMMAND_ARGUMENT' :
      first.instancePath.startsWith('/assertion') ? 'MEM_INVALID_ASSERTION' :
      first.instancePath === '/command_id' ? 'INVALID_ID' : 'MEM_INVALID_COMMAND';
    throw new MemoryArgumentError(code, fields);
  }
  const {payload_sha256: supplied, ...payload} = args as Record<string, unknown>;
  id(payload.command_id);
  const expected = commandDigest(payload as unknown as Omit<L3Command, 'payload_sha256'>);
  check(supplied === undefined || supplied === expected, 'L3_DIGEST_MISMATCH', 409);
  return {...payload, payload_sha256: expected} as unknown as L3Command;
}

export interface TrustedMemoryContext {
  principal_id: string; run_id: string; session_id: string; tool_call_id: string; d: ProcessedEvent;
}
export interface SubjectResolutionRequest {
  context: TrustedMemoryContext;
  subject_ref: L3Assertion['subject_ref'];
  evidence_refs: EvidenceRef[];
}
export interface SubjectBoundContext {
  principal_id: string;
  subject_ref: L3Assertion['subject_ref'];
  authority_ref: string;
  evidence_processed_event_ids?: string[];
}
export interface MemoryToolConfig {
  l3: L3Service; archive: RawArchive; storage: StoragePort;
  lookupProcessed(principal_id: string, processed_event_id: string): Promise<ProcessedEvent | undefined>;
  // Real identity or produced-speaker authority; never a model tool argument or second MEM registry.
  resolveSubjectBoundContext?(request: SubjectResolutionRequest): Promise<SubjectBoundContext | undefined>;
}
export interface MemoryQuery {
  assertion_id?: string; status?: 'active' | 'candidate' | 'all'; scope?: Partial<Scope>; limit?: number; cursor?: string;
}
export interface PendingMemoryProposal {
  status: 'pending_approval'; command_id: string; payload_sha256: string; proposal_ref: string; assertion_id: string;
}
export interface MemoryConfirmationRequest {command_id: string; payload_sha256: string; proposal_ref?: string}
// Supplied only by the authenticated user/UI endpoint, never accepted in model tool arguments.
export interface TrustedMemoryAuthorization {
  authenticated: boolean; principal_id: string; source: 'explicit_user_ui'; consent_ref: string; scope: Scope;
}
export interface Proposal {principal_id: string; command: L3Command; context_ref: string;
  origin?: {run_id:string; session_id:string; tool_call_id:string; processed_event_id:string}}
export interface MemoryDecisionRequest {command_id:string; payload_sha256:string; decision:'approve'|'reject'; control_id:string}
export interface MemoryDecision extends MemoryDecisionRequest {
  principal_id:string; device_id:string; session_id:string; consent_ref:string; decided_at:string; decision_ref:string; event_id:string;
  payload:{kind:'memory_decision';layer:'l3';decision:'approve'|'reject';control_id:string;proposal_ref:string;decision_ref:string};
}

export interface MemoryProposalView {
  binding_status:'supported'; proposal_ref:string; command:L3Command;
  origin:NonNullable<Proposal['origin']>; decision:MemoryDecision|null; receipt:L3Receipt|null;
}

interface Confirmation {
  principal_id: string; command_id: string; payload_sha256: string;
  source: 'explicit_user_ui'; consent_ref: string; scope: Scope;
}
export type MemoryConfirmation = {status: 'confirmed'; command_id: string; payload_sha256: string; consent_ref: string} |
  {status: 'already_committed'; receipt: L3Receipt};

// MEM business authority. No passive extraction, second transaction writer, or L2/L4 loop.
export class MemoryToolAuthority {
  private readonly config: MemoryToolConfig;
  constructor(config: MemoryToolConfig) {this.config = config;}
  private context(context: TrustedMemoryContext): void {
    id(context.principal_id); id(context.run_id); id(context.session_id); id(context.tool_call_id);
    check(context.d.principal_id === context.principal_id, 'MEM_CONTEXT_SCOPE_DENIED', 403);
    validateProcessed(context.d);
  }
  private key(principal: string, command: string): string {
    return digest({principal_id: principal, command_id: command});
  }
  private partition(principal: string, session: string, run: string): string {
    id(principal); id(session); id(run);
    return `mp-${digest({principal_id: principal, session_id: session, run_id: run}).slice(0,32)}`;
  }
  private reference(ref: string): {namespace: string; key: string} {
    const match = /^l3-proposal:(mp-[a-f0-9]{32}):([a-f0-9]{64})$/u.exec(ref);
    check(match, 'MEM_PROPOSAL_REFERENCE_INVALID');
    return {namespace: match[1]!, key: match[2]!};
  }
  private async read<T>(namespace: string, key: string): Promise<T | undefined> {
    try {return JSON.parse(new TextDecoder().decode(await this.config.storage.read(namespace, key))) as T;}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  }
  private async publish<T>(namespace: string, key: string, value: T): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.config.storage.publish(namespace, key,
      Buffer.from(canonical(value))))) as T;
  }
  private receiptOwner(context: TrustedMemoryContext): {authenticated: true; principal_id: string} {
    // Receipt lookup authenticates ownership without dynamic D/evidence validation.
    id(context.principal_id); id(context.run_id); id(context.session_id); id(context.tool_call_id);
    return {authenticated: true, principal_id: context.principal_id};
  }
  async receipt(context: TrustedMemoryContext, request: MemoryConfirmationRequest | {command_id: string}): Promise<L3Receipt | undefined> {
    const owner = this.receiptOwner(context); id(request.command_id);
    return this.config.l3.receipt(owner, request.command_id,
      'payload_sha256' in request ? request.payload_sha256 : undefined);
  }
  async resolveReceipt(context: TrustedMemoryContext, receipt_ref: string): Promise<L3Receipt | undefined> {
    const prefix = `l3:${this.receiptOwner(context).principal_id}:`;
    check(receipt_ref.startsWith(prefix), 'MEM_RECEIPT_SCOPE_DENIED', 403);
    const found = await this.receipt(context, {command_id: receipt_ref.slice(prefix.length)});
    check(found === undefined || found.receipt_ref === receipt_ref, 'MEM_RECEIPT_IDENTITY_MISMATCH', 500);
    return found;
  }
  async runReceipts(context: TrustedMemoryContext): Promise<L3Receipt[]> {
    const owner = this.receiptOwner(context);
    return this.config.l3.receiptsForRun(owner, context.run_id);
  }
  async inspect(context: TrustedMemoryContext, request: {assertion_id: string}): Promise<L3Inspection> {
    this.context(context);
    check(Object.keys(request).every(key => key === 'assertion_id'), 'MEM_UNKNOWN_INSPECT_ARGUMENT');
    id(request.assertion_id);
    return this.config.l3.inspect(this.receiptOwner(context), request.assertion_id);
  }
  async query(context: TrustedMemoryContext, request: MemoryQuery = {}): Promise<L3QueryPage> {
    this.context(context);
    check(Object.keys(request).every(key => ['assertion_id', 'status', 'scope', 'limit', 'cursor'].includes(key)),
      'MEM_UNKNOWN_QUERY_ARGUMENT');
    if (request.assertion_id !== undefined) id(request.assertion_id);
    const status = request.status ?? 'all';
    check(['active', 'candidate', 'all'].includes(status), 'MEM_INVALID_QUERY');
    check(request.scope?.principal_id === undefined || request.scope.principal_id === context.principal_id,
      'MEM_SCOPE_DENIED', 403);
    const allowed = new Set(['principal_id', 'purpose', 'situation', 'role', 'evaluation_frame', 'valid_time']);
    if (request.scope) check(Object.keys(request.scope).every(k => allowed.has(k)), 'MEM_INVALID_SCOPE');
    // Scope filtering, ordering and the page budget belong to the L3 query authority, inside SQL.
    return this.config.l3.query(this.receiptOwner(context), request.assertion_id, status,
      {...(request.scope ? {scope: request.scope} : {}), ...(request.limit !== undefined ? {limit: request.limit} : {}),
        ...(request.cursor !== undefined ? {cursor: request.cursor} : {})});
  }
  private async evidenceAvailable(context: TrustedMemoryContext, ref: EvidenceRef): Promise<boolean> {
    // IDs and ranges come from the actual immutable D authority and actual L5, never model claims.
    const d = await this.config.lookupProcessed(context.principal_id, ref.processed_event_id);
    if (!d) return false;
    validateProcessed(d);
    if (d.principal_id !== context.principal_id || d.event_id !== ref.event_id ||
      d.processed_event_id !== ref.processed_event_id || (d.segment_id ?? undefined) !== ref.segment_id ||
      ref.time_range === undefined) return false;
    const direct = d.raw_ref === ref.raw_ref && d.archive_revision === ref.archive_revision &&
      canonical(d.time_range) === canonical(ref.time_range);
    if (!direct) {
      // A live-call D explicitly binds its transcript to the archived original audio.
      const app = d.content.app_event, observations = d.content.audio_observations;
      if (!app || typeof app !== 'object' || Array.isArray(app) || app.kind !== 'voice_turn' ||
        !Array.isArray(observations) || !observations.some(observation => observation && typeof observation === 'object' &&
          !Array.isArray(observation) && observation.observation_kind === 'sourced_speech' &&
          observation.evidence_status === 'archived_audio' && canonical(observation.evidence) === canonical({
            event_id:ref.event_id, processed_event_id:ref.processed_event_id, raw_ref:ref.raw_ref,
            archive_revision:ref.archive_revision, time_range:ref.time_range}))) return false;
      if (!await this.config.archive.validateEvidence(d)) return false;
      const original = await this.config.archive.readRecord(ref.raw_ref, context.principal_id, ref.archive_revision, {proof_only:true});
      if (original.event.device_id !== d.device_id || !['audio','livekit_tracks','muxed_av'].includes(original.event.media_type)) return false;
    }
    // No native message reader is configured: an arbitrary ID must never be presented as validated history.
    if (ref.native_message_id !== undefined) return false;
    if (ref.native_session_id !== undefined && (ref.native_session_id !== context.session_id ||
      d.processed_event_id !== context.d.processed_event_id)) return false;
    return this.config.archive.validateEvidence(d);
  }
  private async subjectAuthority(context: TrustedMemoryContext, command: L3Command): Promise<string> {
    const subject = command.assertion.subject_ref;
    if (subject.type === 'unknown_subject') return 'unknown';
    // The source-attributed principal of the D (typed prompt, owner call turn, "确认是我", verified owner voice) may be
    // named as itself; approval is separate.
    const attribution = principalAttribution(context.d);
    if (subject.type === 'known_person' && subject.id === context.principal_id && attribution) {
      const kind = {explicit_text: 'explicit', owner_call_turn: 'call-turn', owner_confirmation: 'voice-confirm', owner_voice: 'owner-voice', owner_gesture: 'owner-gesture',owner_override:'owner-override'}[attribution];
      return `${kind}:${context.d.processed_event_id}`;
    }
    const bound = await this.config.resolveSubjectBoundContext?.({context: structuredClone(context),
      subject_ref: {...subject}, evidence_refs: structuredClone(command.assertion.evidence_refs)});
    check(bound && bound.principal_id === context.principal_id &&
      bound.subject_ref?.type === subject.type && bound.subject_ref.id === subject.id &&
      typeof bound.authority_ref === 'string' && bound.authority_ref.length > 0,
      'MEM_SUBJECT_UNRESOLVED', 422);
    if (subject.type === 'speaker_cluster') {
      check(Array.isArray(bound.evidence_processed_event_ids) && bound.evidence_processed_event_ids.length > 0 &&
        bound.evidence_processed_event_ids.every(dId => command.assertion.evidence_refs.some(ref =>
          ref.processed_event_id === dId)), 'MEM_SUBJECT_UNRESOLVED', 422);
    }
    return bound.authority_ref;
  }
  private async confirmed(principal: string, command: L3Command, namespace: string): Promise<Confirmation | undefined> {
    const rejected=await this.read<MemoryDecision>(namespace.replace('mp-','md-'),this.key(principal,command.command_id));
    check(rejected?.decision !== 'reject','MEM_PROPOSAL_REJECTED',409);
    const saved = await this.read<Confirmation>('memory-confirmations', this.key(principal, command.command_id));
    if (!saved) return undefined;
    check(saved.principal_id === principal && saved.command_id === command.command_id &&
      saved.payload_sha256 === command.payload_sha256 && saved.source === 'explicit_user_ui' &&
      typeof saved.consent_ref === 'string' && saved.consent_ref.length > 0 &&
      canonical(saved.scope) === canonical(command.assertion.scope), 'MEM_CONFIRMATION_CONFLICT', 409);
    return saved;
  }
  private requiresConfirmation(command: L3Command, context: TrustedMemoryContext): boolean {
    const attribution=principalAttribution(context.d);
    if (attribution && attribution !== 'owner_gesture') return false;
    return command.operation !== 'create' || command.assertion.status !== 'candidate';
  }
  private pending(command: L3Command, principal: string, namespace: string): PendingMemoryProposal {
    return {status: 'pending_approval', command_id: command.command_id, payload_sha256: command.payload_sha256,
      proposal_ref: `l3-proposal:${namespace}:${this.key(principal, command.command_id)}`, assertion_id: command.assertion.assertion_id};
  }
  async commit(context: TrustedMemoryContext, args: MemoryCommandInput, originContext: TrustedMemoryContext | null = context, decision?: MemoryDecision): Promise<L3Receipt | PendingMemoryProposal> {
    const command = prepareMemoryCommand(args);
    const owner = this.receiptOwner(context); id(command.command_id);
    const {payload_sha256, ...payload} = command;
    check(commandDigest(payload) === payload_sha256, 'L3_DIGEST_MISMATCH', 409);
    check(command.assertion.scope.principal_id === owner.principal_id, 'L3_SCOPE_DENIED', 403);
    const prior = await this.config.l3.receipt(owner, command.command_id, command.payload_sha256);
    if (prior) return prior;
    const app=context.d.content.app_event;
    check(!app || typeof app!=='object' || Array.isArray(app) || app.kind!=='memory_decision' || decision,
      'MEM_DECISION_REFERENCE_REQUIRED',403);
    check(originContext,'MEM_ORIGIN_D_UNAVAILABLE',409);this.context(originContext);
    const namespace = this.partition(owner.principal_id, originContext.session_id, originContext.run_id);
    const proposedBefore = await this.read<Proposal>(namespace, this.key(owner.principal_id, command.command_id));
    check(proposedBefore === undefined || (proposedBefore.principal_id === owner.principal_id &&
      canonical(proposedBefore.command) === canonical(command) && proposedBefore.origin?.run_id===originContext.run_id &&
      proposedBefore.origin.session_id===originContext.session_id && proposedBefore.origin.processed_event_id===originContext.d.processed_event_id), 'MEM_COMMAND_CONFLICT', 409);
    this.context(context); validateCommand(command, owner.principal_id);
    const subjectAuthority = await this.subjectAuthority(originContext, command);
    const confirmation = decision ?? await this.confirmed(owner.principal_id, command, namespace);
    const trusted: TrustedL3Context = {authenticated: true, principal_id: owner.principal_id, run_id: context.run_id,
      context_ref: confirmation ? `consent:${confirmation.consent_ref}:${command.payload_sha256}:subject:${digest(subjectAuthority)}` :
        `tool:${digest({run_id: context.run_id, tool_call_id: context.tool_call_id, subject_authority_ref: subjectAuthority})}`,
      authorize: async c => !this.requiresConfirmation(c, context) || confirmation !== undefined,
      evidenceAvailable: ref => this.evidenceAvailable(originContext, ref)};
    if (!this.requiresConfirmation(command, context) || confirmation) return this.config.l3.commit(command, trusted);
    for (const ref of [...command.evidence_refs, ...command.assertion.evidence_refs]) {
      check(await this.evidenceAvailable(originContext, ref), 'L3_EVIDENCE_UNAVAILABLE', 409);
    }
    const key = this.key(owner.principal_id, command.command_id);
    const proposed = await this.publish<Proposal>(namespace, key,
      {principal_id: owner.principal_id, command, context_ref: trusted.context_ref,
        origin:{run_id:context.run_id,session_id:context.session_id,tool_call_id:context.tool_call_id,processed_event_id:context.d.processed_event_id}});
    check(proposed.principal_id === owner.principal_id && proposed.command.payload_sha256 === command.payload_sha256 &&
      canonical(proposed.command) === canonical(command), 'MEM_COMMAND_CONFLICT', 409);
    return this.pending(command, owner.principal_id, namespace);
  }
  async forget(context: TrustedMemoryContext, args: Omit<ForgetRequest, 'principal_id' | 'payload_sha256'>): Promise<ForgetReceipt> {
    this.receiptOwner(context);
    check(Object.keys(args).sort().join(',') === 'assertion_id,command_id,expected_version,retention,scope', 'L3_FORGET_SCOPE_INVALID', 422);
    const payload = {...args, principal_id: context.principal_id};
    const request = {...payload, payload_sha256: forgetDigest(payload)};
    const context_ref = `forget-${digest({run_id:context.run_id, tool_call_id:context.tool_call_id, processed_event_id:context.d.processed_event_id})}`;
    return this.config.l3.forget(request, {authenticated:true, principal_id:context.principal_id, run_id:context.run_id,
      context_ref, source:'explicit_user_request', consent_ref:context.d.consent_ref,
      authorize:async () => {this.context(context); const attribution=principalAttribution(context.d);
        return attribution !== null && attribution !== 'owner_gesture' && await this.config.archive.validateEvidence(context.d);}});
  }
  private async proposalApplicable(principal:string,assertion_id:string):Promise<boolean> {
    const current=await this.config.l3.inspect({authenticated:true,principal_id:principal},assertion_id);
    return current.status==='not_found'||current.status==='found';
  }
  async proposals(principal:string, session:string, run:string):Promise<MemoryProposalView[]> {
    id(principal);id(session);
    const namespace=this.partition(principal,session,run);
    const keys=await this.config.storage.list(namespace,256);
    check(keys.length<=256,'MEM_PROPOSAL_READ_BUDGET',413);
    const views:MemoryProposalView[]=[];
    for(const key of keys){
      const proposal=await this.read<Proposal>(namespace,key);
      if(!proposal || proposal.principal_id!==principal || !proposal.origin || proposal.origin.session_id!==session || proposal.origin.run_id!==run)continue;
      check(key===this.key(principal,proposal.command.command_id),'MEM_PROPOSAL_SCOPE_DENIED',403);
      const {payload_sha256,...payload}=proposal.command;
      check(commandDigest(payload)===payload_sha256,'L3_DIGEST_MISMATCH',409);
      if(!await this.proposalApplicable(principal,proposal.command.assertion.assertion_id))continue;
      views.push({binding_status:'supported',proposal_ref:`l3-proposal:${namespace}:${key}`,command:proposal.command,
        origin:proposal.origin,decision:await this.read<MemoryDecision>(namespace.replace('mp-','md-'),key) ?? null,
        receipt:await this.config.l3.receipt({authenticated:true,principal_id:principal},proposal.command.command_id,proposal.command.payload_sha256) ?? null});
    }
    return views;
  }
  async decide(request:MemoryDecisionRequest,actor:Omit<TrustedMemoryAuthorization,'scope'> & {device_id:string;session_id:string;run_id:string}) {
    check(Object.keys(request).length===4 && ['command_id','payload_sha256','decision','control_id'].every(key=>Object.hasOwn(request,key)),'MEM_DECISION_INVALID');
    check(actor.authenticated && actor.source==='explicit_user_ui','MEM_USER_CONFIRMATION_REQUIRED',403);
    id(request.command_id);id(request.control_id);id(actor.principal_id);id(actor.device_id);id(actor.session_id);
    check(['approve','reject'].includes(request.decision),'MEM_DECISION_INVALID');
    const namespace=this.partition(actor.principal_id,actor.session_id,actor.run_id);
    const key=this.key(actor.principal_id,request.command_id),proposal=await this.read<Proposal>(namespace,key);
    check(proposal?.origin,'MEM_PROPOSAL_BINDING_NOT_SUPPORTED',409);
    check(proposal.principal_id===actor.principal_id && proposal.origin.session_id===actor.session_id && proposal.origin.run_id===actor.run_id,'MEM_PROPOSAL_SCOPE_DENIED',403);
    check(request.payload_sha256===proposal.command.payload_sha256,'MEM_CONFIRMATION_DIGEST_MISMATCH',409);
    const {payload_sha256,...commandPayload}=proposal.command;check(commandDigest(commandPayload)===payload_sha256,'L3_DIGEST_MISMATCH',409);
    const receipt=await this.config.l3.receipt({authenticated:true,principal_id:actor.principal_id},request.command_id,payload_sha256);
    if(receipt)return {status:'already_committed' as const,receipt};
    check(await this.proposalApplicable(actor.principal_id,proposal.command.assertion.assertion_id),'MEM_PROPOSAL_TARGET_UNAVAILABLE',409);
    const proposal_ref=`l3-proposal:${namespace}:${key}`,decision_ref=`l3-decision:${namespace}:${key}`;
    const payload={kind:'memory_decision' as const,layer:'l3' as const,decision:request.decision,
      control_id:request.control_id,proposal_ref,decision_ref};
    const saved=await this.publish<MemoryDecision>(namespace.replace('mp-','md-'),key,{...request,principal_id:actor.principal_id,
      device_id:actor.device_id,session_id:actor.session_id,consent_ref:actor.consent_ref,
      decided_at:new Date().toISOString(),decision_ref,event_id:`memory-decision-${digest(payload)}`,payload});
    check(saved.principal_id===actor.principal_id && saved.device_id===actor.device_id && saved.session_id===actor.session_id && saved.payload_sha256===payload_sha256 &&
      saved.decision===request.decision && saved.control_id===request.control_id,'MEM_DECISION_CONFLICT',409);
    return {status:'decision_recorded' as const,decision:saved,proposal_ref:`l3-proposal:${namespace}:${key}`};
  }
  async commitProposal(context:TrustedMemoryContext,args:{proposal_ref:string;decision_ref:string}) {
    this.context(context);
    check(Object.keys(args).length===2,'MEM_UNKNOWN_COMMAND_ARGUMENT');
    const app=context.d.content.app_event;
    check(app && typeof app==='object' && !Array.isArray(app) && app.kind==='memory_decision' &&
      app.proposal_ref===args.proposal_ref && app.decision_ref===args.decision_ref,'MEM_DECISION_D_BINDING_DENIED',403);
    const {namespace,key}=this.reference(args.proposal_ref);
    check(args.decision_ref===`l3-decision:${namespace}:${key}`,'MEM_PROPOSAL_REFERENCE_INVALID');
    const proposal=await this.read<Proposal>(namespace,key),decision=await this.read<MemoryDecision>(namespace.replace('mp-','md-'),key);
    check(proposal?.origin && decision,'MEM_PROPOSAL_BINDING_NOT_SUPPORTED',409);
    check(key===this.key(context.principal_id,proposal.command.command_id) && proposal.principal_id===context.principal_id &&
      proposal.origin.session_id===context.session_id && namespace===this.partition(context.principal_id,context.session_id,proposal.origin.run_id) && decision.principal_id===context.principal_id &&
      decision.session_id===context.session_id && decision.payload_sha256===proposal.command.payload_sha256 &&
      decision.decision_ref===args.decision_ref,'MEM_PROPOSAL_SCOPE_DENIED',403);
    check(context.d.event_id===decision.event_id && canonical(app)===canonical(decision.payload) && context.d.device_id===decision.device_id &&
      context.d.captured_at===decision.decided_at,'MEM_DECISION_D_BINDING_DENIED',403);
    check(canonical(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await this.config.archive.read(
      context.d.raw_ref,context.principal_id,context.d.archive_revision))))===canonical(decision.payload),
      'MEM_DECISION_D_BINDING_DENIED',403);
    check(decision.decision==='approve','MEM_PROPOSAL_REJECTED',409);
    const originD=await this.config.lookupProcessed(context.principal_id,proposal.origin.processed_event_id);
    const originContext=originD ? {principal_id:context.principal_id,...proposal.origin,d:originD} : null;
    return this.commit(context,proposal.command,originContext,decision);
  }
  async confirm(request: MemoryConfirmationRequest, authorization: TrustedMemoryAuthorization): Promise<MemoryConfirmation> {
    check(authorization.authenticated && authorization.source === 'explicit_user_ui', 'MEM_USER_CONFIRMATION_REQUIRED', 403);
    id(authorization.principal_id); id(authorization.consent_ref); id(request.command_id);
    check(/^[a-f0-9]{64}$/u.test(request.payload_sha256), 'MEM_INVALID_DIGEST');
    const receipt = await this.config.l3.receipt({authenticated: true, principal_id: authorization.principal_id},
      request.command_id, request.payload_sha256);
    if (receipt) return {status: 'already_committed', receipt};
    const key = this.key(authorization.principal_id, request.command_id);
    const namespace=request.proposal_ref ? this.reference(request.proposal_ref).namespace : 'memory-proposals';
    check(!request.proposal_ref || this.reference(request.proposal_ref).key===key,'MEM_PROPOSAL_NOT_FOUND',404);
    check((await this.read<MemoryDecision>(namespace.replace('mp-','md-'),key))?.decision !== 'reject','MEM_PROPOSAL_REJECTED',409);
    const proposal = await this.read<Proposal>(namespace, key);
    check(proposal && proposal.principal_id === authorization.principal_id &&
      proposal.command.command_id === request.command_id, request.proposal_ref ? 'MEM_PROPOSAL_NOT_FOUND' : 'MEM_PROPOSAL_REFERENCE_REQUIRED', 404);
    check(!proposal.origin || namespace===this.partition(authorization.principal_id,proposal.origin.session_id,proposal.origin.run_id),'MEM_PROPOSAL_SCOPE_DENIED',403);
    const {payload_sha256, ...payload} = proposal.command;
    check(payload_sha256 === request.payload_sha256 && commandDigest(payload) === payload_sha256,
      'MEM_CONFIRMATION_DIGEST_MISMATCH', 409);
    check(authorization.scope.principal_id === authorization.principal_id &&
      canonical(authorization.scope) === canonical(proposal.command.assertion.scope), 'MEM_CONFIRMATION_SCOPE_DENIED', 403);
    check(await this.proposalApplicable(authorization.principal_id,proposal.command.assertion.assertion_id),'MEM_PROPOSAL_TARGET_UNAVAILABLE',409);
    const saved = await this.publish<Confirmation>('memory-confirmations', key, {principal_id: authorization.principal_id,
      command_id: request.command_id, payload_sha256, source: 'explicit_user_ui', consent_ref: authorization.consent_ref,
      scope: authorization.scope});
    check(saved.principal_id === authorization.principal_id && saved.command_id === request.command_id &&
      saved.payload_sha256 === payload_sha256 && canonical(saved.scope) === canonical(authorization.scope),
      'MEM_CONFIRMATION_CONFLICT', 409);
    return {status: 'confirmed', command_id: saved.command_id, payload_sha256: saved.payload_sha256,
      consent_ref: saved.consent_ref};
  }
}
