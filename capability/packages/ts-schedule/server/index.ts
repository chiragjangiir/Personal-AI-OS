import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (Array.isArray(row.tasks) || Array.isArray(row.items)) return result(input, 'succeeded');
  if (typeof row.cancelled === 'boolean') return result(input, 'succeeded', {mutated: row.cancelled});
  if (row.queue_id) return result(input, 'accepted', {mutated: true, ref: row.queue_id,
    next: {waiting_on: 'external', check_with: input.name}, unknowns: [{about: '任务执行', why: '已入队不等于已执行'}]});
  if (row.delivered_to || row.status === 'delivered') return result(input, 'succeeded', {mutated: true});
  if (['pending', 'accepted'].includes(row.status)) return result(input, 'accepted', {next: {waiting_on: 'external', check_with: input.name}});
  return unmapped(input);
}
