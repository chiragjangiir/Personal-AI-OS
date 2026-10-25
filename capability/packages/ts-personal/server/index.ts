import {common, object, result, unmapped, type ResultInput} from '../../ts-host/result.ts';
/** Canonicalize the legacy combined read/write arguments before selecting their declared class. */
export function prepareCall(name:string,args:Record<string,unknown>){
  const {_operation:_untrusted,...business}=args;
  const keys=Object.keys(business).filter(key=>!['_context','owner_requested'].includes(key));
  const operation=name==='paios_people'?(business.forget!==undefined?'delete':
    business.face_recognition!==undefined||business.recognition_hints!==undefined?'update':'read'):
    name==='paios_visual_capture_policy'?(keys.length?'update':'read'):undefined;
  return {args:operation?{...business,_operation:operation}:business,business};
}
export function mapResult(input: ResultInput) {
  const prepared=prepareCall(input.name,input.args);input={...input,args:prepared.args};
  const base = common(input); if (base) return base;
  const row = object(input.result);
  if (input.name === 'paios_action_request') return row.status === 'committed' ?
    result(input, 'succeeded', {mutated: true, ref: row.receipt_ref ?? row.action_id}) : unmapped(input);
  if (input.name === 'paios_avatar') {
    if (input.args.action === 'list' && Array.isArray(row.looks) || input.args.action === 'get' &&
      (input.result === null || row.profile_version !== undefined || row.version !== undefined)) return result(input, 'succeeded');
    if (row.status === 'ready') return result(input, 'succeeded', {mutated: true});
    if (row.status === 'pending') return result(input, 'accepted', {next: {waiting_on: 'external', check_with: input.name}});
    if (row.status === 'submission_uncertain') return result(input, 'unknown', {reason: row.error ?? 'AVATAR_SUBMISSION_UNCERTAIN',
      unknowns: [{about: '外观提交', why: '服务尚未确认是否接受'}]});
    if (['cancelled', 'superseded'].includes(row.status)) return result(input, 'cancelled', {reason: row.status});
    return unmapped(input);
  }
  if (input.name === 'paios_people' && (row.face_recognition !== undefined || row.forgotten !== undefined || row.deleted !== undefined) ||
    input.name === 'paios_speaker_name' && (row.cluster_id !== undefined || row.display_name !== undefined) ||
    input.name === 'paios_visual_capture_policy' && row.enabled !== undefined) return result(input, 'succeeded', {
    mutated: Object.keys(prepared.business).length > 0});
  return unmapped(input);
}
