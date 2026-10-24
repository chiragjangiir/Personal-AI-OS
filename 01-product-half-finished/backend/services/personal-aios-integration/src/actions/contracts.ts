import { canonical, check, digest, id, type ProcessedEvent } from '../contracts.ts';
export interface ActionRequest {
  action_id?: string; business_intent_id: string; parameter_version: number; action_type: 'write_local_note';
  target_device_id: string; expected_control_version: string; parameters: {text: string}; payload_sha256?: string;
}
export interface ActionCommand extends Omit<ActionRequest, 'payload_sha256' | 'action_id'> {action_id: string; payload_sha256: string}
export interface TrustedActionContext {
  authenticated: boolean; principal_id: string; run_id: string; session_id: string; tool_call_id: string;
  d: ProcessedEvent; target: {device_id: string};
}
export interface ActionConfirmation {action_id: string; payload_sha256: string}
export interface TrustedActionAuthorization {
  authenticated: boolean; principal_id: string; device_id: string; source: 'explicit_user_ui'; consent_ref: string;
}
export interface ActionReceipt {
  receipt_ref: string; action_id: string; action_type: 'write_local_note'; target_device_id: string;
  payload_sha256: string; status: 'pending_approval' | 'committed' | 'reconcile_required';
  execution_run_id: string | null; consent_ref: string | null; artifact_ref: string | null;
  artifact_sha256: string | null; bytes: number | null; recorded_at: string;
}
export function stableActionId(principal: string, intent: string, version: number): string {
  id(principal); id(intent); check(Number.isSafeInteger(version) && version > 0 && version <= 2147483647, 'ACTION_INVALID_VERSION');
  return `act:${digest({principal_id: principal, business_intent_id: intent, parameter_version: version})}`;
}
export function prepareAction(principal: string, args: ActionRequest): ActionCommand {
  check(args && typeof args === 'object' && !Array.isArray(args), 'ACTION_INVALID_REQUEST');
  check(Object.keys(args).every(k => ['action_id','business_intent_id','parameter_version','action_type',
    'target_device_id','expected_control_version','parameters','payload_sha256'].includes(k)), 'ACTION_UNKNOWN_ARGUMENT');
  const action_id = stableActionId(principal, args.business_intent_id, args.parameter_version);
  check(args.action_id === undefined || args.action_id === action_id, 'ACTION_UNSTABLE_ID');
  id(args.target_device_id); id(args.expected_control_version);
  check(args.action_type === 'write_local_note', 'ACTION_NOT_CONFIGURED');
  check(args.parameters && Object.keys(args.parameters).length === 1 && typeof args.parameters.text === 'string' &&
    args.parameters.text.trim().length > 0 && Buffer.byteLength(args.parameters.text) <= 65536, 'ACTION_INVALID_NOTE');
  const {payload_sha256: supplied, ...input} = args;
  const payload = {...input, action_id};
  const hash = digest(payload);
  check(supplied === undefined || supplied === hash, 'ACTION_DIGEST_MISMATCH', 409);
  canonical(payload);
  return {...payload, payload_sha256: hash};
}
