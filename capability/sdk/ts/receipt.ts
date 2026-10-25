/** Author helpers. The platform qualifies the receipt at its trust boundary. */
export type State = 'succeeded' | 'partial' | 'failed' | 'unknown' | 'running' |
  'accepted' | 'waiting' | 'cancelled' | 'rejected';
export type EffectKind = 'observe' | 'workspace' | 'owner_data' | 'send' | 'account' |
  'delete' | 'physical' | 'spend' | 'self_change';
export type Verification = 'verified' | 'service_ack' | 'not_verified' | 'unknown';
export type Provenance = 'observed' | 'computed' | 'inferred' | 'peer';
export interface Progress {done: number; total: number; unit: string}
export interface Status {
  state: State; started_at?: string; ended_at?: string | null;
  reason_code?: string; progress?: Progress;
}
export interface Effect {
  kind: EffectKind; target: string; action: string; verification: Verification;
  evidence: string; ref: string | null;
}
export interface Value {
  key: string; value: number | string | boolean | null; unit: string;
  provenance: Provenance; source: string; as_of: string;
}
export interface Content {key: string; text: string; provenance: Provenance}
export interface Unknown {about: string; why: string}
export interface Next {
  retry: 'forbidden' | 'allowed' | 'after_check'; check_with?: string | null;
  needs_confirmation?: string | null; waiting_on: 'none' | 'owner' | 'external' | 'time';
  waiting_detail?: string; until?: string | null;
}
export interface Receipt {
  receipt: 1; status: Status; effects: Effect[]; values: Value[];
  content: Content[]; unknowns: Unknown[]; next: Next;
  job?: {id: string; revision: number};
}
export interface ReceiptOptions {
  status?: Omit<Status, 'state'>; effects?: Effect[]; values?: Value[];
  content?: Content[]; unknowns?: Unknown[]; next?: Partial<Next>;
  job?: {id: string; revision: number};
}

export function receipt(state: State, options: ReceiptOptions = {}): Receipt {
  return {
    receipt: 1, status: {...options.status, state},
    effects: [...(options.effects ?? [])], values: [...(options.values ?? [])],
    content: [...(options.content ?? [])], unknowns: [...(options.unknowns ?? [])],
    next: {retry: state === 'unknown' ? 'after_check' : 'forbidden', waiting_on: 'none', ...options.next},
    ...(options.job === undefined ? {} : {job: {...options.job}}),
  };
}
export const succeeded = (options?: ReceiptOptions): Receipt => receipt('succeeded', options);
export const partial = (options?: ReceiptOptions): Receipt => receipt('partial', options);
export const failed = (options?: ReceiptOptions): Receipt => receipt('failed', options);
export const unknown = (options?: ReceiptOptions): Receipt => receipt('unknown', options);
export const running = (options?: ReceiptOptions): Receipt => receipt('running', options);
export const accepted = (options?: ReceiptOptions): Receipt => receipt('accepted', options);
export const waiting = (options?: ReceiptOptions): Receipt => receipt('waiting', options);
export const cancelled = (options?: ReceiptOptions): Receipt => receipt('cancelled', options);
/** Platform only: packages may construct this for tests, but admission rejects the claim. */
export const rejected = (options?: ReceiptOptions): Receipt => receipt('rejected', options);

export function effect(kind: EffectKind, target: string, action: string,
  verification: Verification, evidence: string, ref: string | null = null): Effect {
  return {kind, target, action, verification, evidence, ref};
}
export function value(key: string, value: Value['value'], unit: string,
  provenance: Provenance, source: string, as_of: string): Value {
  return {key, value, unit, provenance, source, as_of};
}
export const unknown_fact = (about: string, why: string): Unknown => ({about, why});

export function to_mcp_result(body: Receipt, summary?: string): {
  content: {type: 'text'; text: string}[]; structuredContent: Receipt;
} {
  const progress = body.status.progress;
  const text = summary ?? [body.status.state, body.status.reason_code,
    progress && `${progress.done}/${progress.total} ${progress.unit}`].filter(Boolean).join(' ');
  return {content: [{type: 'text', text: text.replace(/\s+/gu, ' ').trim()}],
    structuredContent: structuredClone(body)};
}
