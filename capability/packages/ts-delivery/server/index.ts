import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (['opened', 'silent'].includes(row.status)) return result(input, 'succeeded', {mutated: true});
  if (row.card_id || row.offer_id) return result(input, 'waiting', {mutated: true,
    ref: row.card_id ?? row.offer_id, next: {waiting_on: 'owner', retry: 'forbidden'},
    unknowns: [{about: '终端选择', why: '投递确认不等于主人已选择或接听'}]});
  return unmapped(input);
}
