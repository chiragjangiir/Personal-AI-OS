import {readFileSync} from 'node:fs';
import type {AnySchema} from 'ajv';
import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {PersonalAIOSRuntime} from '../../../services/personal-aios-integration/src/runtime.ts';
import type {WireExtension} from './personal-aios-terminal-wire.ts';

const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/owner-override-message.v1.json',import.meta.url),'utf8'));
const definition=(value:object):AnySchema=>({$defs:contract.$defs,...value});

/** Controls and live status reuse the paired terminal's authenticated formal-text connection. */
export function createOwnerOverrideWire(runtime:PersonalAIOSRuntime,onError:(error:unknown)=>void):WireExtension {
  return {
    inputs:Object.fromEntries(Object.entries(contract.inputs as Record<string,{definition:object;error:string}>).map(([op,input])=>
      [op,{...input,definition:definition(input.definition)}])),
    outputs:Object.fromEntries(Object.entries(contract.outputs as Record<string,object>).map(([op,output])=>[op,definition(output)])),
    handle:async(op,body,source,publish)=>{
      let error_code:string|undefined;
      try {
        if(op!=='owner_override_status')await runtime.ownerOverrideControl(source,op==='owner_override_enable'?'enable':'disable',body.passphrase as string|undefined);
      } catch(error){if(!(error instanceof ContractError))throw error;error_code=error.code;}
      await publish({operation:'owner_override_status',control_id:body.control_id,
        owner_override:await runtime.ownerOverrideStatus(source),...(error_code?{error_code}:{})});
    },
    prepare:ctx=>{
      let stopped=false,stop:(()=>void)|undefined;
      void runtime.watchOwnerOverrideStatus(ctx.device,async(status,signal)=>{
        if(ctx.current()&&!signal.aborted)await ctx.publish({operation:'owner_override_status',owner_override:status},signal);
      },onError,ctx.ready).then(unwatch=>{if(stopped)unwatch();else stop=unwatch;},onError);
      return()=>{stopped=true;stop?.();};
    }
  };
}
