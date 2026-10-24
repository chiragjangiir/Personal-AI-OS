import { canonical, check, ContractError, digest, isIdentifier, validateRange, type TimeRange } from '../contracts.ts';
export type AssertionStatus = 'candidate' | 'active' | 'retracted' | 'deleted';
export interface EvidenceRef { event_id: string; processed_event_id: string; raw_ref: string; archive_revision: string; segment_id?: string; native_session_id?: string; native_message_id?: string; time_range?: TimeRange; }
export interface Scope { principal_id: string; purpose: string; situation: string; role: string; evaluation_frame: string; valid_time?: {from: string; until?: string}; }
export interface TypedScore { value_or_interval: number | [number, number]; scale: [number, number]; basis_refs: string[]; scope_ref?: string; }
export interface L3Assertion {
  assertion_id: string; version: number; previous_version: number | null;
  kind: 'fact' | 'observation' | 'inference' | 'preference' | 'plan' | 'evaluation';
  subject_ref: {type: 'known_person' | 'speaker_cluster' | 'unknown_subject'; id: string};
  predicate: string; value: unknown; scope: Scope; evidence_refs: EvidenceRef[];
  confidence?: number; evidence_status: string; unknown_conditions: string[]; conflicts: string[];
  status: AssertionStatus; applicability_status: 'applicable' | 'stopped' | 'needs_reevaluation';
  hypothesis_group_id?: string; dimension?: string; branch_id?: string;
  relation_to_peers: 'independent' | 'compatible' | 'mutually_exclusive' | 'unknown';
  typed_scores: {interpretation_support?: TypedScore; criterion_priority?: TypedScore};
  depends_on: {assertion_id: string; version: number; dependency_kind: string}[];
  update_reason?: string; invalidation_scope?: Scope; authorizing_context_ref: string; created_at: string; effective_at?: string;
}
export type AssertionInput = Omit<L3Assertion, 'version' | 'previous_version' | 'created_at' | 'effective_at' | 'authorizing_context_ref'>;
export interface L3Command {command_id: string; payload_sha256: string; operation: 'create' | 'correct' | 'review' | 'delete' | 'retract' | 'deny'; expected_version: number; assertion: AssertionInput; evidence_refs: EvidenceRef[]; }
export interface TrustedL3Context {principal_id: string; run_id: string; context_ref: string; authenticated: boolean; authorize(command: L3Command): Promise<boolean>; evidenceAvailable(ref: EvidenceRef): Promise<boolean>; }
export interface L3Receipt {receipt_ref: string; command_id: string; payload_sha256: string; status: 'committed'; assertion_id: string; version: number; previous_version: number | null; authority_watermark: string; committed_at: string; invalidated: string[]; }
// Inspection is current metadata, not history retrieval or evidence availability validation.
export interface L3InvalidationCause {
  reason: string; command_id: string; receipt: L3Receipt | null;
  operation: L3Command['operation'] | 'forget' | null; changed_assertion_id: string | null;
  changed_version: number | null;
}
interface L3InspectionProvenance {
  provenance_status: 'complete' | 'partial'; unknown_conditions: string[];
  current_version: {operation: L3Command['operation'] | 'forget' | null; receipt: L3Receipt | null};
  invalidation_causes: L3InvalidationCause[];
}
export type L3Inspection = {status:'erased'; assertion_id:string; version:number; receipt:ForgetReceipt} |
  {status: 'not_found'; assertion_id: string} |
  ({status: 'deleted' | 'retracted' | 'invalidated'; assertion_id: string; version: number;
    applicability_status: 'stopped' | 'needs_reevaluation'} & L3InspectionProvenance) |
  ({status: 'found'; assertion: L3Assertion} & L3InspectionProvenance);
export function commandDigest(command: Omit<L3Command, 'payload_sha256'>): string {return digest(command);}
export function evidenceIdentity(ref: EvidenceRef): string {return canonical({raw_ref: ref.raw_ref, segment_id: ref.segment_id ?? null, time_range: ref.time_range ?? null});}
export function validateCommand(c: L3Command, principal: string): void {
  check(c && typeof c === 'object' && c.assertion && typeof c.assertion === 'object' &&
    c.assertion.scope && typeof c.assertion.scope === 'object' && c.assertion.subject_ref &&
    typeof c.assertion.subject_ref === 'object' && Array.isArray(c.assertion.evidence_refs) &&
    Array.isArray(c.evidence_refs) && Array.isArray(c.assertion.depends_on) && c.assertion.typed_scores &&
    typeof c.assertion.typed_scores === 'object' && !Array.isArray(c.assertion.typed_scores), 'L3_INVALID_COMMAND', 422);
  if (!c.command_id || !c.assertion.assertion_id || !Number.isSafeInteger(c.expected_version) || c.expected_version < 0) throw new ContractError('L3_INVALID_COMMAND', 422);
  // Every ID a write can persist must be addressable by the strict query/inspect/forget/receipt readers.
  const a0 = c.assertion;
  check([c.command_id, a0.assertion_id, a0.subject_ref.id, ...(Array.isArray(a0.depends_on) ? a0.depends_on.map(d => d?.assertion_id) : []),
    ...(['hypothesis_group_id', 'branch_id'] as const).filter(key => a0[key] !== undefined).map(key => a0[key])].every(isIdentifier),
    'L3_INVALID_ID', 422);
  const {payload_sha256, ...payload} = c;
  if (payload_sha256 !== commandDigest(payload)) throw new ContractError('L3_DIGEST_MISMATCH', 409);
  const a = c.assertion;
  if (a.evidence_refs.length > 200 || c.evidence_refs.length > 200 || a.depends_on.length > 64) throw new ContractError('L3_INPUT_BUDGET_EXCEEDED', 422);
  if (a.confidence !== undefined && (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1)) throw new ContractError('L3_INVALID_CONFIDENCE', 422);
  if (a.scope.principal_id !== principal) throw new ContractError('L3_SCOPE_DENIED', 403);
  check(['purpose','situation','role','evaluation_frame'].every(key =>
    typeof a.scope[key as keyof Scope] === 'string' && String(a.scope[key as keyof Scope]).length > 0), 'L3_INVALID_SCOPE', 422);
  if (!['create','correct','review','delete','retract','deny'].includes(c.operation)) throw new ContractError('L3_INVALID_OPERATION', 422);
  if (!['fact','observation','inference','preference','plan','evaluation'].includes(a.kind) || !['candidate','active','retracted','deleted'].includes(a.status)) throw new ContractError('L3_INVALID_ASSERTION', 422);
  if (!a.predicate || !a.subject_ref.id || !['known_person','speaker_cluster','unknown_subject'].includes(a.subject_ref.type)) throw new ContractError('L3_INVALID_SUBJECT', 422);
  if (!c.evidence_refs.length || !a.evidence_refs.length || [...c.evidence_refs, ...a.evidence_refs].some(e => !e || typeof e !== 'object' || !e.event_id || !e.processed_event_id || !/^l5:[a-f0-9]{64}$/u.test(e.raw_ref) || typeof e.archive_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(e.archive_revision))) throw new ContractError('L3_EVIDENCE_REQUIRED', 422);
  check([...c.evidence_refs, ...a.evidence_refs].every(e => isIdentifier(e.event_id) && isIdentifier(e.processed_event_id) &&
    (['segment_id', 'native_session_id', 'native_message_id'] as const).every(key => e[key] === undefined || isIdentifier(e[key]))),
    'L3_INVALID_ID', 422);
  for (const ref of [...c.evidence_refs, ...a.evidence_refs]) if (ref.time_range !== undefined) validateRange(ref.time_range);
  check(Object.keys(a.typed_scores).every(key => ['interpretation_support','criterion_priority'].includes(key)),
    'L3_INVALID_SCORE', 422);
  for (const score of Object.values(a.typed_scores)) {
    check(score && typeof score === 'object' && Array.isArray(score.scale) && score.scale.length === 2 &&
      Array.isArray(score.basis_refs) && score.basis_refs.length <= 200 &&
      (typeof score.value_or_interval === 'number' || Array.isArray(score.value_or_interval) && score.value_or_interval.length === 2),
      'L3_INVALID_SCORE', 422);
    const values = typeof score.value_or_interval === 'number' ? [score.value_or_interval] : score.value_or_interval;
    if (!score.scale.every(Number.isFinite) || score.scale[0] >= score.scale[1] || values.length < 1 || !values.every(v => Number.isFinite(v) && v >= score.scale[0] && v <= score.scale[1]) || (values.length === 2 && values[0]! > values[1]!)) throw new ContractError('L3_INVALID_SCORE', 422);
    if (!score.basis_refs.length || score.basis_refs.some(ref => !a.evidence_refs.some(e => e.raw_ref === ref))) throw new ContractError('L3_SCORE_WITHOUT_EVIDENCE', 422);
  }
  if (a.typed_scores.criterion_priority && (typeof a.typed_scores.criterion_priority.scope_ref !== 'string' || !a.typed_scores.criterion_priority.scope_ref)) throw new ContractError('L3_PRIORITY_SCOPE_REQUIRED', 422);
  if (new Set(a.evidence_refs.map(evidenceIdentity)).size !== a.evidence_refs.length) throw new ContractError('L3_DUPLICATE_EVIDENCE', 409);
}

/** Explicit trusted host contract, not an ordinary delete or model tool argument. */
export interface ForgetRequest {
 command_id:string; payload_sha256:string; principal_id:string; assertion_id:string;
 expected_version:number; scope:'l3_live_payloads_all_versions'; retention:'audit_metadata';
}
export interface TrustedForgetContext {
 authenticated:boolean; principal_id:string; run_id:string; context_ref:string;
 source:'explicit_user_request'; consent_ref:string;
 authorize(request:ForgetRequest):Promise<boolean>;
}
export interface ForgetReceipt {
 receipt_ref:string; command_id:string; payload_sha256:string; assertion_id:string; version:number;
 scope:'l3_live_payloads_all_versions'; status:'committed'; erased_versions:number;
 authority_watermark:string; committed_at:string; invalidated:string[]; consent_ref:string; authorizing_context_ref:string;
 residual:{audit:'retained'; proposal:'not_run'; l2:'not_run'; l4:'not_run'; l5:'not_run'; backups:'not_run'};
}
export function forgetDigest(request:Omit<ForgetRequest,'payload_sha256'>):string {return digest(request);}
