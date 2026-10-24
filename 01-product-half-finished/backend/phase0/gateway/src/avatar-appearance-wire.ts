import {readFileSync} from 'node:fs';
import type {AnySchema} from 'ajv';
import {check,ContractError,isIdentifier} from '../../../services/personal-aios-integration/src/contracts.ts';
import {hasTerminalCapability} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {WireExtension} from './personal-aios-terminal-wire.ts';
import type {AvatarProfileService} from './avatar-profile.ts';

export interface AppearanceQuote {quote_id:string;price_text:string;scope_text:string}
export interface AppearancePricing {preparationQuote?:AppearanceQuote;callQuote?:AppearanceQuote;photoUploadAvailable?:boolean}
const contract=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/appearance-message.v1.json',import.meta.url),'utf8'));
const definition=(value:object):AnySchema=>({$defs:contract.$defs,...value});

/** Prices come only from deployment configuration. Absence keeps the paid operation unavailable. */
export function createAppearanceWire(avatar:Pick<AvatarProfileService,'looks'|'read'|'history'|'snapshot'|'readPreparation'|'change'|'reconcile'|'cancel'|'reuse'>,pricing:AppearancePricing={}):WireExtension {
  const quotes=structuredClone(pricing);
  return {
    inputs:Object.fromEntries(Object.entries(contract.inputs as Record<string,{definition:object;error:string}>).map(([op,input])=>[op,{...input,definition:definition(input.definition)}])),
    outputs:Object.fromEntries(Object.entries(contract.outputs as Record<string,object>).map(([op,output])=>[op,definition(output)])),
    handle:async(op,body,source,publish)=>{
      check(source.device_type==='mac'||source.device_type==='phone'&&hasTerminalCapability(source,'owner_unlock'),'AVATAR_APPEARANCE_OWNER_REQUIRED',403);
      if(op==='avatar_options'){
        const current=await avatar.readPreparation(source.principal_id);
        await publish({operation:'avatar_options_state',request_id:body.request_id,looks:avatar.looks(),photo_upload_available:quotes.photoUploadAvailable===true,
          ...await avatar.history(source.principal_id),
          ...(current?{current_preparation:current}:{}),
          ...(quotes.preparationQuote?{preparation_quote:quotes.preparationQuote}:{unavailable_reason:'尚未提供实际费用与使用范围，暂不能准备新形象。'}),
          ...(quotes.callQuote?{call_quote:quotes.callQuote}:{})});
        return;
      }
      try{
        if(op==='avatar_prepare'){
          check(quotes.preparationQuote!==undefined,'AVATAR_PREPARATION_UNAVAILABLE',503);
          const consent=body.confirmed_quote as AppearanceQuote;
          check(body.quote_id===quotes.preparationQuote.quote_id&&consent?.quote_id===quotes.preparationQuote.quote_id&&
            consent.price_text===quotes.preparationQuote.price_text&&consent.scope_text===quotes.preparationQuote.scope_text,'AVATAR_QUOTE_CHANGED',409);
        }
        const result=op==='avatar_prepare'?await avatar.change({principal_id:source.principal_id,device_id:source.device_id,
          command_id:body.command_id as string,look_id:body.look_id as string,expected_version:body.expected_version as number,
          owner_request:body.owner_request as string,focus:body.focus as {x:number;y:number}}):
          op==='avatar_cancel'?await avatar.cancel(source.principal_id,body.command_id as string):
          op==='avatar_reuse'?await avatar.reuse({principal_id:source.principal_id,device_id:source.device_id,command_id:body.command_id as string,
            expected_version:body.expected_version as number,version:body.version as number,owner_request:body.owner_request as string}):
          await avatar.reconcile(source.principal_id,body.command_id as string);
        await publish({operation:'avatar_preparation',request_id:body.request_id,...result});
      }catch(error){
        if(!(error instanceof ContractError))throw error;
        const current=op==='avatar_reconcile'?await avatar.readPreparation(source.principal_id,body.command_id as string):null;
        if(current){await publish({operation:'avatar_preparation',request_id:body.request_id,...current});return;}
        const {profile,profile_version}=await avatar.snapshot(source.principal_id);
        await publish({operation:'avatar_preparation',request_id:body.request_id,command_id:body.command_id,status:'failed',
          profile,profile_version,error:error.code});
      }
    }
  };
}

export function readAppearancePricing(value?:string):AppearancePricing {
  if(value===undefined||!value.trim())return {};
  const raw=JSON.parse(value) as Record<string,unknown>;
  check(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).every(key=>['preparationQuote','callQuote'].includes(key)),'AVATAR_QUOTE_CONFIG_INVALID');
  for(const key of ['preparationQuote','callQuote'])if(raw[key]!==undefined){
    const quote=raw[key] as Record<string,unknown>;
    check(quote&&typeof quote==='object'&&!Array.isArray(quote)&&Object.keys(quote).length===3&&
      Object.keys(quote).every(field=>['quote_id','price_text','scope_text'].includes(field))&&isIdentifier(quote.quote_id)&&
      typeof quote.price_text==='string'&&quote.price_text.trim().length>0&&quote.price_text.length<=160&&
      typeof quote.scope_text==='string'&&quote.scope_text.trim().length>0&&quote.scope_text.length<=1000,'AVATAR_QUOTE_CONFIG_INVALID');
  }
  return raw as unknown as AppearancePricing;
}
