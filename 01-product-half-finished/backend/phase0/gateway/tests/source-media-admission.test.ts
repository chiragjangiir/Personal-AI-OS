import assert from 'node:assert/strict';
import test from 'node:test';
import {createSourceMediaAdmission,SourceMediaAdmissionError} from '../src/source-media-admission.ts';
import type {SourceMediaPermissionPort,SourceMediaCaptureBinding} from '../src/source-media-permission.ts';
import type {RawEvent,TrustedContext} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';
const trusted:TrustedContext={principal_id:'owner',device_id:'device',device_type:'glasses',consent_ref:'fixture',channel:'fixture',submission:'observation'};
const binding={userId:'owner',deviceId:'device'} as SourceMediaCaptureBinding;
const raw:RawEvent={schema_version:'paios.event.v1',event_id:'event',device_id:'device',device_type:'glasses',captured_at:'2030-01-01T00:00:00.000Z',source:{channel:'fixture'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200)};
const chunk:TrackChunk={track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'source',stream_epoch:'epoch',start_ms:0,end_ms:100}};
function fixture() {
  let locked=false,until=1000,uncertainty=1,denial:string|undefined,teardowns=0,failTeardown=false;
  const permission:SourceMediaPermissionPort={read:async()=>{throw new Error('preflight forbidden');},withPermission:async(_binding,modality,consume)=>{
    assert.equal(modality,'audio');if(denial)throw new Error(denial);return consume({authorizedMediaUntil:new Date(until).toISOString()} as never);
  }};
  const hook=createSourceMediaAdmission({permission,source:{capture:async()=>({binding,trusted})},clock:{read:async()=>({modality:'audio',track_id:'mic',stream_epoch:'epoch',source_timebase_id:'source',target_timebase_id:'utc_epoch_ms',offset_ms:0,drift_ppm:0,uncertainty_ms:uncertainty,basis_ref:'controlled-fixture-only'})},requestTeardown:async()=>{teardowns++;if(failTeardown)throw new Error('controlled collector failed');}}).withAppendAdmission!;
  return {hook,get locked(){return locked;},get teardowns(){return teardowns;},deny:(code:string)=>{denial=code;},until:(ms:number)=>{until=ms;},uncertainty:(ms:number)=>{uncertainty=ms;},failTeardown:()=>{failTeardown=true;}};
}
test('source callback preserves original IO errors and waits for append settlement',async()=>{
  const f=fixture();let release!:()=>void,enter!:()=>void;const entered=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r);
  const pending=f.hook(raw,trusted,chunk,async()=>{assert.equal(f.locked,false);enter();await wait;assert.equal(f.locked,false);return 'durable';});
  await entered;assert.equal(f.locked,false);release();assert.equal(await pending,'durable');assert.equal(f.locked,false);
  const io=new Error('ENOSPC');await assert.rejects(f.hook(raw,trusted,chunk,async()=>{throw io;}),e=>e===io);assert.equal(f.teardowns,0);
});
test('independent clock waterline includes uncertainty; malformed/time-overrun chunks never request physical teardown',async()=>{
  const f=fixture();f.until(100);await assert.rejects(f.hook(raw,trusted,chunk,async()=>assert.fail('must not append')),/MEDIA_SOURCE_RANGE_NOT_AUTHORIZED/);
  assert.equal(f.teardowns,0);f.uncertainty(0);assert.equal(await f.hook(raw,trusted,chunk,async()=>1),1);
  await assert.rejects(f.hook(raw,{...trusted,principal_id:'forged'},chunk,async()=>assert.fail()),/MEDIA_CAPTURE_CONTEXT_MISMATCH/);
  assert.equal(f.teardowns,0);
});
test('source expiry/revoke denial uses canonical caller teardown, preserves cause, and reports failure without hardware ACK',async()=>{
  const f=fixture();f.deny('LEASE_EXPIRED');
  await assert.rejects(f.hook(raw,trusted,chunk,async()=>assert.fail()),e=>e instanceof SourceMediaAdmissionError&&e.code==='LEASE_EXPIRED'&&e.teardown==='requested'&&(e.cause as Error).message==='LEASE_EXPIRED');
  f.failTeardown();f.deny('CREDENTIAL_FENCE_ACTIVE');
  await assert.rejects(f.hook(raw,trusted,chunk,async()=>assert.fail()),e=>e instanceof SourceMediaAdmissionError&&e.teardown==='failed');assert.equal(f.teardowns,2);
  f.deny('connection reset by peer');await assert.rejects(f.hook(raw,trusted,chunk,async()=>assert.fail()),/connection reset by peer/);
  assert.equal(f.teardowns,2);
});
