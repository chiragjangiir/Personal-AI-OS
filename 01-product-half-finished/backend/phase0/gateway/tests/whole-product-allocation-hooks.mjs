import './controlled-ffi-hooks.mjs';
import {registerHooks} from 'node:module';
// Observe actual source constructors. No production source or dependency is edited.
const symbol = Symbol.for('paios.controlled.whole-product.allocations');
globalThis[symbol] = {history:0,turnContext:0,qwen:0};
const observations = [
  ['rayneo-session-turn-context.ts','constructor(options: RayneoConversationRegistryOptions = {}) {','history'],
  ['rayneo-session-turn-context.ts','constructor(options: RayneoSessionTurnContextOptions = {}) {','turnContext'],
  ['qwen38-provider-adapter.ts',"    const profile = 'profile' in profileOrOptions ? profileOrOptions.profile : profileOrOptions;",'qwen'],
];
registerHooks({load(url,context,nextLoad){
  const result=nextLoad(url,context);
  let source=result.source;
  for(const [file,needle,key] of observations){
    if(url.endsWith('/src/'+file)){
      source=String(source);
      if(!source.includes(needle))throw new Error('CONTROLLED_ALLOCATION_SOURCE_DRIFT:'+file);
      source=source.replace(needle,needle+`\n    globalThis[Symbol.for('paios.controlled.whole-product.allocations')].${key}++;`);
    }
  }
  return {...result,source};
}});
