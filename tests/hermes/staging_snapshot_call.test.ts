import assert from 'node:assert/strict';
import test from 'node:test';
import {createVoiceCallSession} from '../../01-product-half-finished/backend/phase0/gateway/src/voice-call-session.ts';

test('snapshot authority reports an opening and live call even without a turn manager',async()=>{
  const connecting=Promise.withResolvers<void>();
  const call=createVoiceCallSession({room:()=>({}),
    createPlayout:()=>({open:async()=>{},push:()=>{},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    createFront:()=>({connect:()=>connecting.promise,appendAudio:()=>0,appendImage:()=>{},context:async()=>{},
      respond:async()=>({completed:true}),cancel:()=>{},close:()=>{}}),
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>{throw error;}});
  assert.equal(call.resourceSnapshot(),null);
  const opening=call.open('snapshot-call');
  assert.equal(call.resourceSnapshot()?.call_id,'snapshot-call');
  assert.equal(call.active(),undefined);
  connecting.resolve();await opening;
  assert.equal(call.active(),'snapshot-call');
  assert.equal(call.resourceSnapshot()?.call_id,'snapshot-call');
  await call.closeAll();assert.equal(call.resourceSnapshot(),null);
});
