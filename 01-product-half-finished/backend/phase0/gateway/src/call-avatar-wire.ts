import {readFileSync} from 'node:fs';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import {hasTerminalCapability} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/src/runtime.ts';
import type {createFormalTextIngress} from './personal-aios-formal-text.ts';
import type {WireExtension} from './personal-aios-terminal-wire.ts';
import type {AppearanceQuote} from './avatar-appearance-wire.ts';

const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/call-avatar.v1.json',import.meta.url),'utf8'));
type CallPort=NonNullable<Parameters<typeof createFormalTextIngress>[0]['voice_call']>;
/** Optional call controls use the existing authenticated extension and call authority. */
export function createCallAvatarWire(runtime:PersonalAIOSRuntime,call:CallPort,onError:(error:unknown)=>void,quote?:AppearanceQuote):WireExtension {
  const currentQuote=quote?structuredClone(quote):undefined;
  return {inputs:contract.inputs,outputs:contract.outputs,
    handle:async(_op,body,source)=>{
      check(call.setAvatar&&call.avatarCommand,'VIDU_COMPONENT_REQUIRED',409);
      const id=body.call_id as string,avatar=body.avatar as boolean,revision=body.avatar_revision as number;
      if(avatar&&currentQuote){
        check(source.device_type==='glasses'||source.device_type==='phone'&&hasTerminalCapability(source,'owner_unlock'),
          'CALL_AVATAR_PHONE_CONFIRMATION_REQUIRED',403);
        const consent=body.confirmed_quote as AppearanceQuote|undefined;
        check(consent?.quote_id===currentQuote.quote_id&&consent.price_text===currentQuote.price_text&&
          consent.scope_text===currentQuote.scope_text,'CALL_AVATAR_QUOTE_CHANGED',409);
      }
      call.avatarCommand(id,{avatar,revision});
      await runtime.formalVoice(source,'audio',async()=>{await runtime.ownerInput(source);await call.setAvatar!(id,avatar,revision);});
    },
    prepare:ctx=>call.attach({transcript:()=>{},turn:()=>{},state:async(call_id,state,extra)=>{
      if(!ctx.current()||!extra||!((extra.avatar_revision??0)>0||extra.avatar===true))return;
      const avatar=extra.avatar===true&&!['closing','closed','failed'].includes(state);
      try{await ctx.publish({operation:'call_avatar_state',call_id,state,avatar,avatar_revision:extra.avatar_revision??0,
        ...(extra.error_code?{error_code:extra.error_code}:{}),...(avatar&&extra.media?{media:extra.media}:{})});}
      catch(error){onError(error);throw error;}
    }})};
}
