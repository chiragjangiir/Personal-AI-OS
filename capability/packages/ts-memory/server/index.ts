import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (input.name === 'paios_l3_commit') {
    if (row.status === 'committed' && row.receipt_ref) return result(input, 'succeeded', {mutated: true, ref: row.receipt_ref});
    return unmapped(input);
  }
  if (['read', 'located', 'found', 'not_found', 'deleted', 'retracted', 'invalidated', 'erased'].includes(row.status) ||
    ['assertions', 'entries', 'frames', 'contacts'].some(key => Array.isArray(row[key])) ||
    input.name === 'paios_visual_analyze' && typeof input.result === 'string') {
    return result(input, 'succeeded', {unknowns: (row.unknown_conditions ?? []).map((why: string) => ({about: '来源', why}))});
  }
  return unmapped(input);
}
