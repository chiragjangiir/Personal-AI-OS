import assert from 'node:assert/strict';
import test from 'node:test';
import {createReceiptClockProvider} from '../src/source-media-receipt-clock.ts';
const binding={continuityId:'continuity'} as never;
const chunk=(epoch:string,start:number,end:number)=>({track_id:'microphone',stream_epoch:epoch,seq:0,modality:'audio' as const,format:'pcm_s16le:16000:1',
  source_range:{kind:'interval' as const,timebase_id:`received-pcm:${epoch}`,stream_epoch:epoch,start_ms:start,end_ms:end}});
test('receipt clock anchors once per capture span and declares its class and uncertainty',async()=>{
  let now=10_000;const clock=createReceiptClockProvider({uncertainty_ms:400,now:()=>now});
  assert.equal(clock.evidence,'receipt_estimated');
  const first=await clock.resolve(binding,chunk('a',0,20));
  now=99_999;const later=await clock.resolve(binding,chunk('a',20,40));
  assert.deepEqual(later,first);assert.equal(first!.offset_ms,10_000-20);assert.equal(first!.uncertainty_ms,400);
  assert.equal(first!.target_timebase_id,'utc_epoch_ms');assert.equal(first!.source_timebase_id,'received-pcm:a');
  const other=await clock.resolve(binding,chunk('b',0,20));assert.equal(other!.offset_ms,99_999-20);
});
test('receipt clock estimates received visual instants and invalid uncertainty; anchors stay bounded',async()=>{
  const clock=createReceiptClockProvider({uncertainty_ms:100,max_anchors:2,now:()=>1});
  const visual=await clock.resolve(binding,{...chunk('v',0,0),modality:'visual',source_range:{kind:'instant',stream_epoch:'v',timebase_id:'t',at_ms:1}});assert.equal(visual!.modality,'visual');assert.equal(visual!.offset_ms,0);
  for(const epoch of ['x','y','z'])await clock.resolve(binding,chunk(epoch,0,10));
  for(const uncertainty_ms of [0,-1,1.5,10_001])assert.throws(()=>createReceiptClockProvider({uncertainty_ms}),/RECEIPT_CLOCK_UNCERTAINTY_INVALID/);
});
