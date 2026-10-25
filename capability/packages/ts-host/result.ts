import {receipt, effect, value, unknown_fact, type Receipt, type State, type Next, type EffectKind,
  type Value} from '../../sdk/ts/receipt.ts';

export interface ToolPolicy {
  effect?: EffectKind; effect_by_arg?: Record<string, Record<string, EffectKind>>;
  target?: string; task_type?: string; retry?: Next['retry']; check_with?: string;
}
export interface ResultInput {
  name: string; args: Record<string, unknown>; result: unknown; policy: ToolPolicy; now: string;
}
export type ResultAdapter = (input: ResultInput) => Receipt;
export const object = (raw: unknown): Record<string, any> => raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
export function path(raw: unknown, selector: string): any {
  return selector.replace(/^\$\./u, '').split('.').reduce((held, key) => object(held)[key], raw);
}
export function effectClass(input: ResultInput): EffectKind | undefined {
  const policy = input.policy;
  if (policy.effect) return policy.effect;
  const [selector, branches] = Object.entries(policy.effect_by_arg!)[0]!;
  return branches[String(path(input.args, selector))];
}
const units: Record<string, string> = {
  bytes: 'byte', selected_bytes: 'byte', total_bytes: 'byte', latitude: 'degree', longitude: 'degree', lat: 'degree', lng: 'degree',
  accuracy: 'm', altitude: 'm', distance: 'm', speed: 'm/s', heart_rate: 'count/min', count: 'count', samples: 'count',
  done: 'count', total: 'count', deleted_events: 'count', erased_versions: 'count', version: 'none', revision: 'none',
  offset: 'none', next_offset: 'none', next_cursor: 'none', category: 'category-code', type: 'category-code',
  confidence: 'none', similarity: 'none', minutes: 'min', dur: 's', energy: 'kcal', dist: 'm',
  attempts: 'count', unknown_attempts: 'count', foreign_currency_attempts: 'count', observed_days: 'day',
};
const computed = new Set(['mean', 'avg', 'average', 'avg_7d', 'delta_from_7d_avg', 'observed_days', 'sum', 'min', 'max', 'count', 'samples', 'duration', 'distance_m', 'eta_s', 'known_cny', 'estimated_cny']);
/** Preserve the full business result; scalar facts additionally carry units and their observation clock. */
export function resultValues(input: ResultInput): Value[] {
  const values: Value[] = [];
  function walk(raw: unknown, key: string, inherited: {unit?: string | undefined; as_of: string; source: string; estimated?: boolean}, field = ''): void {
    if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
      let unit = units[field] ?? (/_ms$/u.test(field) ? 'ms' : /_m$/u.test(field) ? 'm' : /_s$/u.test(field) ? 's' :
        /_min$/u.test(field) ? 'min' : /_(?:yuan|cny)$/u.test(field) ? 'CNY' : /_usd$/u.test(field) ? 'USD' : /_fen$/u.test(field) ? 'fen' :
        /_tokens$/u.test(field) ? 'token' : ['value', 'mean', 'avg', 'average', 'sum', 'min', 'max', 'latest', 'last', 'avg_7d', 'delta_from_7d_avg', 'amount'].includes(field) ? inherited.unit ?? 'none' : 'none');
      if (typeof raw === 'boolean' || raw === null) unit = 'none';
      values.push(value(key || 'result', raw, unit, computed.has(field) || inherited.estimated ? 'computed' : 'observed', inherited.source, inherited.as_of));
    } else if (Array.isArray(raw)) raw.forEach((item, index) => walk(item, `${key}[${index}]`, inherited, field));
    else if (raw && typeof raw === 'object') {
      const row = object(raw);
      const observed = row.observed_at ?? row.committed_at ?? row.recorded_at ?? row.captured_at;
      const clock = typeof observed === 'string' && Number.isFinite(Date.parse(observed)) ? observed :
        typeof row.start_ms === 'number' ? new Date(row.start_ms).toISOString() : inherited.as_of;
      const source = typeof row.source === 'string' ? row.source : inherited.source;
      const context = {unit: typeof row.unit === 'string' ? row.unit : typeof row.currency === 'string' ? row.currency : inherited.unit,
        as_of: clock, source, estimated: row.kind === 'estimated' || inherited.estimated === true};
      for (const [name, item] of Object.entries(row)) walk(item, key ? `${key}.${name}` : name, context, name);
    }
  }
  walk(input.result, '', {as_of: input.now, source: `platform:${input.name}`});
  return values;
}
export function result(input: ResultInput, state: State, options: {
  reason?: string; next?: Partial<Next>; mutated?: boolean; evidence?: string; ref?: string | null;
  unknowns?: {about: string; why: string}[];
} = {}): Receipt {
  const kind = effectClass(input);
  const target = input.policy.target && path(input.args, input.policy.target);
  return receipt(state, {
    status: {ended_at: input.now, ...(options.reason ? {reason_code: options.reason} : {})},
    effects: options.mutated && kind && kind !== 'observe' ? [effect(kind,
      typeof target === 'string' ? target : input.name, input.policy.task_type ?? input.name,
      'service_ack', options.evidence ?? JSON.stringify(input.result), options.ref ?? null)] : [],
    values: resultValues(input), content: [{key: `platform:${input.name}`, text: JSON.stringify(input.result), provenance: 'observed'}],
    unknowns: options.unknowns ?? [], next: {retry: state === 'unknown' ? 'after_check' : input.policy.retry ?? 'forbidden',
      waiting_on: 'none', ...(state === 'unknown' ? {check_with: input.policy.check_with ?? input.name} : {}), ...options.next},
  });
}
export function unmapped(input: ResultInput): Receipt {
  return result(input, 'unknown', {reason: 'CAPABILITY_RESULT_UNMAPPED',
    unknowns: [unknown_fact('执行结果', '现有结果未提供可判定的状态')]});
}
export function failure(input: ResultInput, error: unknown): Receipt {
  const row = object(error), code = String(row.code ?? row.error_code ?? row.error ??
    (row.status === 'unavailable' ? 'PLATFORM_TOOL_UNAVAILABLE' : row.status === 'rejected' ? 'PLATFORM_TOOL_DENIED' :
      row.status === 'failed' ? 'PLATFORM_TOOL_FAILED' : 'PLATFORM_TOOL_ERROR'));
  const uncertain = /timeout|timed_?out|disconn|not_connected|not_received|econn|enet|ehost|enotfound|epipe|socket|premature_close|network|abort|transport|reconcile_required/iu.test(code) ||
    code === 'PLATFORM_TOOL_ERROR' || [500, 502, 504].includes(typeof row.status === 'number' ? row.status : row.http_status);
  return result(input, uncertain ? 'unknown' : 'failed', {reason: code,
    ...(uncertain ? {unknowns: [unknown_fact('执行结果', '中断不证明操作失败，须先核查')]} : {})});
}
/** Shared result states, before a family's shape-specific interpretation. No success default. */
export function common(input: ResultInput): Receipt | undefined {
  const row = object(input.result), status = row.status;
  if (['failed', 'rejected', 'unavailable'].includes(status) && !row.pending) return failure(input, row);
  if (status === 'reconcile_required' || status === 'unknown') return result(input, 'unknown', {
    reason: row.error_code ?? status, unknowns: [unknown_fact('执行结果', '需查询原操作的状态')]});
  if (['pending_approval', 'awaiting_owner_signature', 'key_required'].includes(status) || row.pending && row.error_code === 'CAMERA_APP_INACTIVE')
    return result(input, 'waiting', {reason: row.error_code ?? status, next: {retry: 'forbidden', waiting_on: 'owner',
      needs_confirmation: String(row.proposal_ref ?? object(row.draft).draft_id ?? row.error_code ?? status)}});
  if (row.error_code) return failure(input, row);
  return undefined;
}
