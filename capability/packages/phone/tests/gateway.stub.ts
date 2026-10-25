// Test-only merge interface: manifest policy calls the existing consent authority.
import {effectConsent} from '../../../../01-product-half-finished/backend/services/personal-aios-integration/src/effect-consent.ts';
const legacyKind:Record<string,string>={observe:'read',physical:'external',send:'send',account:'login',owner_data:'file_edit',delete:'delete',spend:'external'};
export async function decide(ports:Parameters<typeof effectConsent>[0],context:Parameters<typeof effectConsent>[1],
  policy:{effect_by_arg:Record<string,Record<string,string>>},args:{task_type:string;recipient?:string;owner_requested:boolean}){
  const kind=policy.effect_by_arg['$.task_type']![args.task_type]!;
  return effectConsent(ports,context,{kind:legacyKind[kind],task_type:args.task_type,requested:args.owner_requested,
    ...(kind==='send'?{recipient:args.recipient}:{})});
}
