import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (row.status === 'pending' || row.remote_cleanup_pending > 0) return result(input, row.status === 'pending' ? 'accepted' : 'partial', {next: {waiting_on: 'external', check_with: input.policy.check_with ?? input.name},
    unknowns: [{about: '删除收尾', why: '尚有原件、本地或远端清理未完成'}]});
  if (row.status === 'committed' && row.receipt_ref || row.status === 'forgotten' || row.deleted !== undefined || row.status === 'deleted')
    return result(input, 'succeeded', {mutated: true, ...(row.receipt_ref ? {ref: row.receipt_ref} : {}),
      unknowns: row.residual ? Object.entries(row.residual).filter(([, state]) => state === 'not_run').map(([about]) => ({about, why: '未执行此范围的删除'})) : []});
  return unmapped(input);
}
