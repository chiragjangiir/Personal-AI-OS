import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){if(s==='@livekit/rtc-ffi-bindings')return{url:new URL('./controlled-ffi-bindings.mjs',import.meta.url).href,shortCircuit:true};return n(s,c);}});
