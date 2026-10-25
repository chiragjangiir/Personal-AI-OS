import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
export function mapResult(input: ResultInput) {
  const base = common(input); if (base) return base;
  const row = object(input.result);
  const unknowns: {about: string; why: string}[] = [];
  if (row.phone_recording === 'unconfirmed') unknowns.push({about: '手机骑行记录', why: '尚未收到手机记录确认'});
  if (row.glasses_status === 'not_connected') unknowns.push({about: '眼镜展示', why: '眼镜未连接；保留的模式或路线并不证明已展示'});
  if (row.phone_reason) unknowns.push({about: '手机定位', why: row.phone_reason});
  if (['requested', 'pending', 'glasses_started', 'glasses_stopped'].includes(row.status)) return result(input, 'accepted', {
    unknowns, next: {waiting_on: 'external', check_with: input.policy.check_with ?? input.name}});
  if (row.nav_id && row.distance_m !== undefined) return result(input, unknowns.length ? 'partial' : 'succeeded', {mutated: true, unknowns});
  if (['no_active_navigation', 'no_alternative'].includes(row.status)) return result(input, 'succeeded');
  if (row.status === 'stopped') return result(input, 'succeeded', {mutated: true, unknowns});
  if (['known_sample', 'last_known', 'observed', 'captured'].includes(row.status) || row.visual_frame_id || row.ride_mode !== undefined ||
    row.view || Array.isArray(row.items)) return result(input, 'succeeded', {mutated: input.name === 'paios_geofences' && input.args.action !== 'list', unknowns});
  return unmapped(input);
}
