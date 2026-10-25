import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (input.name === 'paios_model_settings_read' && row.revision !== undefined) return result(input, 'succeeded', {unknowns: [
    ...(row.usage?.subscription_remaining === '套餐余量未知' ? [{about: '套餐余量', why: '提供方未提供套餐余量'}] : []),
    ...(row.attempts ?? []).filter((attempt: any) => attempt.cost?.kind === 'unknown')
      .map((attempt: any) => ({about: `费用:${attempt.attempt_id}`, why: '调用成本未知'})),
  ]});
  return unmapped(input);
}
