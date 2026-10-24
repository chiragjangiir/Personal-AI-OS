import {readFileSync} from 'node:fs';
import type {AnySchema} from 'ajv';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import {hasTerminalCapability} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {coalescedPublication} from '../../../services/personal-aios-integration/src/publication.ts';
import type {WireExtension} from './personal-aios-terminal-wire.ts';
import type {AvatarProfileService} from './avatar-profile.ts';

const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/terminal-message.v1.json',import.meta.url),'utf8'));
const definition=(value:object):AnySchema=>({$defs:contract.$defs,...value});

/** Display state travels on the paired terminal's existing authenticated connection. */
export function createAvatarWire(avatar:Pick<AvatarProfileService,'snapshot'|'loaded'|'watch'>,onError:(error:unknown)=>void):WireExtension {
  const pumps=new Map<string,ReturnType<typeof coalescedPublication>>();
  const key=(source:{principal_id:string;device_id:string})=>JSON.stringify([source.principal_id,source.device_id]);
  return {
    inputs:Object.fromEntries(['avatar_sync','avatar_loaded'].map(op=>[op,{...contract.inputs[op],definition:definition(contract.inputs[op].definition)}])),
    outputs:{avatar_state:definition(contract.outputs.avatar_state)},
    handle:async(op,body,source,publish)=>{
      check(hasTerminalCapability(source,'display'),'AVATAR_DISPLAY_REQUIRED',403);
      if(op==='avatar_loaded')await avatar.loaded(source.principal_id,source.device_id,source.device_type,body.profile_version as number);
      await publish({operation:'avatar_state',...await avatar.snapshot(source.principal_id),
        ...(body.request_id===undefined?{}:{request_id:body.request_id})});
    },
    prepare:ctx=>{
      if(!hasTerminalCapability(ctx.device,'display'))return()=>{};
      const id=key(ctx.device);pumps.get(id)?.stop();
      const pump=coalescedPublication(async signal=>{
        const state=await avatar.snapshot(ctx.device.principal_id);
        if(ctx.current()&&!signal.aborted)await ctx.publish({operation:'avatar_state',...state},signal);
      },onError,5000,ctx.ready);
      pumps.set(id,pump);
      const unwatch=avatar.watch(principal=>{if(principal===ctx.device.principal_id)pump.push();});
      pump.push();
      return()=>{unwatch();pump.stop();if(pumps.get(id)===pump)pumps.delete(id);};
    },
    attach:ctx=>{pumps.get(key(ctx.device))?.push();return()=>{};}
  };
}
