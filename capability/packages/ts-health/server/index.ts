import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (row.metric) return result(input, 'succeeded', {unknowns: row.synced_at === null ?
    [{about: '健康同步', why: '无同步时间；无样本不证明健康正常或权限状态'}] : []});
  return unmapped(input);
}
