import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after} from 'node:test';
import {OutputAuthority} from '../src/output.ts';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage,type StoragePort} from '../src/storage.ts';
import {bindRaw,sha256,type TrustedContext} from '../src/contracts.ts';
import {QuarantineReceiptFailure,type UnknownClockRaw} from '../src/unknown-clock.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {createSourceMediaAdmission} from '../../../phase0/gateway/src/source-media-admission.ts';
import {createSourceMediaClock,SourceClockUnavailableError} from '../../../phase0/gateway/src/source-media-clock.ts';
import {createSourceMediaPermission} from '../../../phase0/gateway/src/source-media-permission.ts';
import {createDeviceLease} from '../../realtime-core/src/device-lease-state-machine.ts';
import {createProductionStructuralEquality} from '../../realtime-core/src/production-owner-ports.ts';
const at='2030-01-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'device',device_type:'phone',consent_ref:'consent',channel:'rtc',submission:'observation'};
const raw=(modality:'audio'|'visual'='audio'):UnknownClockRaw=>({schema_version:'paios.event.v1',event_id:'event',device_id:'device',device_type:'phone',captured_at:null,capture_clock_status:'unknown',source:{channel:'rtc'},media_type:modality,mime:modality==='audio'?'audio/pcm':'image/jpeg',representation:'received_decoded_sample',payload:Buffer.from([1,2,3,4])});
const chunk=(modality:'audio'|'visual'='audio')=>({track_id:modality==='audio'?'mic':'cam',stream_epoch:'epoch',seq:0,modality,format:modality==='audio'?'pcm_s16le:16000:1':'jpeg',source_range:{kind:'interval' as const,timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:100}});
const ref={ref_type:'RealtimeSession',ref_id:'01900000-0000-7000-8000-000000000001',object_version:'1',canonical_payload_sha256:'a'.repeat(64)} as const;
const leaseRef={...ref,ref_type:'DeviceLease',ref_id:'01900000-0000-7000-8000-000000000002'} as const;
const binding={realtimeSessionRef:ref,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',userId:'owner',deviceId:'device',purpose:'assistant'};
const temporaryRoots:string[]=[];
after(async()=>{for(const root of temporaryRoots)await rm(root,{recursive:true,force:true});});
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'paios-unknown-core-'));temporaryRoots.push(root);
 const storage=new PosixStorage(root);
 let now=at,teardown=0,locked=false;
 const lease=createDeviceLease({deviceLeaseRef:leaseRef,realtimeSessionRef:ref,continuityId:'continuity',userId:'owner',deviceId:'device',issuedAt:at as never,policy:{allowed:true,capabilities:['audio','video'],purpose:'assistant',leaseExpiresAt:'2030-01-01T00:30:00.000Z' as never,revocable:true,policyDecisionRef:'policy'}});
 let current={lease,session:{realtimeSessionRef:ref,userId:'owner',continuityId:'continuity',state:'active',continuityState:'active',connectionEpoch:'1',continuityExpiresAt:'2030-01-01T00:30:00.000Z',activeDeviceId:'device',activeDeviceLeaseRef:leaseRef,revision:'1',binding:{...binding,state:'connected'}}};
 const permission=createSourceMediaPermission({readCurrentBinding:async()=>current as never,equality:createProductionStructuralEquality(),now:()=>now,credentialFence:{verify:async()=>({active:false}),withAdmission:async(_t,fn)=>{locked=true;try{return await fn();}finally{locked=false;}}}});
 const archive=new RawArchive(storage,4096,()=>now);
 const admission=createSourceMediaAdmission({source:{capture:async()=>({trusted,binding})},permission,clock:{read:async()=>undefined},requestTeardown:async()=>{teardown++;}});
 const save=(r=raw(),c=chunk())=>admission.withQuarantineAdmission(r,trusted,c,scope=>{assert.equal(locked,false);return archive.archiveUnknownClock(r,trusted,c,scope);});
 return {archive,storage,save,admission,setNow:(n:string)=>now=n,get teardown(){return teardown;},deny:()=>{current={...current,lease:{...current.lease,capabilities:['data']}};}};
}
test('PCM and visual unknown UTC originals are durably retrievable, transport time separate, no valid B/D',async()=>{
 const f=await fixture();for(const modality of ['audio','visual'] as const){const receipt=await f.save(raw(modality),chunk(modality));
 const record=await f.archive.readUnknownClock(receipt.quarantine_ref,'owner',receipt.archive_revision);
 assert.deepEqual(record.bytes,raw().payload);assert.equal(receipt.event.captured_at,null);assert.equal(receipt.event.received_at,at);
 assert.equal(receipt.event.capture_clock_status,'unknown');assert.deepEqual(receipt.chunk,chunk(modality));
 assert.equal(receipt.authorization.historical_capture_range,'unverified');
 assert.throws(()=>bindRaw({...raw(modality),captured_at:null} as never,trusted,at),/INVALID_CAPTURED_AT/);
 await assert.rejects(f.archive.readUnknownClock(receipt.quarantine_ref,'other',receipt.archive_revision),/RAW_ACCESS_DENIED/);
 await assert.rejects(f.archive.locate(receipt.quarantine_ref,'owner'),/INVALID_RAW_REF/);}
 assert.deepEqual(await f.storage.list('processed-events'),[]);assert.deepEqual(await f.storage.list('admission-inputs'),[]);
});
test('immutable slot concurrency/idempotency across archive instances; payload,metadata,range and binding conflicts',async()=>{
 const f=await fixture(),other=new RawArchive(f.storage,4096,()=>at);
 const receipts=await Promise.all(Array.from({length:8},(_,i)=>(i%2?other:f.archive).archiveUnknownClock(raw(),trusted,chunk(),binding)));
 assert.equal(new Set(receipts.map(r=>r.archive_revision)).size,1);
 f.setNow('2030-01-01T00:01:00.000Z');assert.deepEqual(await f.save(),receipts[0]);
 for(const [r,c,b] of [[{...raw(),payload:Buffer.from([5])},chunk(),binding],[{...raw(),mime:'other'},chunk(),binding],[raw(),{...chunk(),source_range:{...chunk().source_range,end_ms:101}},binding],[raw(),chunk(),{...binding,connectionEpoch:'2'}]] as const)
 await assert.rejects(f.archive.archiveUnknownClock(r,trusted,c,b),/QUARANTINE_SLOT_CONFLICT/);
 assert.equal((await f.storage.list('quarantine-manifests')).length,1);
});
test('ungranted and expired capture never publish, teardown uses shared source admission',async()=>{
 const f=await fixture();f.deny();await assert.rejects(f.save(),/MEDIA_MODALITY_NOT_AUTHORIZED/);assert.equal(f.teardown,1);
 const expired=await fixture();expired.setNow('2030-01-01T00:30:00.000Z');await assert.rejects(expired.save(),/LEASE_EXPIRED/);assert.equal(expired.teardown,1);
 assert.deepEqual(await expired.storage.list('objects'),[]);
 await assert.rejects(f.admission.withQuarantineAdmission(raw(),{...trusted,principal_id:'forged'},chunk(),async()=>assert.fail()),/MEDIA_CAPTURE_CONTEXT_MISMATCH/);
});
test('object EIO stays original IO failure; receipt EIO reports published object and permits explicit retry',async()=>{
 const f=await fixture();let fail='objects';const fault:StoragePort={...f.storage,read:(n,k)=>f.storage.read(n,k),list:n=>f.storage.list(n),removePending:k=>f.storage.removePending(k),publish:(n,k,b)=>{if(n===fail)throw Object.assign(new Error('EIO'),{code:'EIO'});return f.storage.publish(n,k,b);}};
 const a=new RawArchive(fault,4096,()=>at);await assert.rejects(a.archiveUnknownClock(raw(),trusted,chunk(),binding),e=>(e as Error).message==='EIO');
 fail='quarantine-manifests';await assert.rejects(a.archiveUnknownClock(raw(),trusted,chunk(),binding),e=>e instanceof QuarantineReceiptFailure&&e.object_published&&e.payload_sha256===sha256(raw().payload)&&(e.cause as Error).message==='EIO');
 assert.deepEqual(await f.storage.read('objects',sha256(raw().payload)),raw().payload);fail='none';assert.equal((await a.archiveUnknownClock(raw(),trusted,chunk(),binding)).archive_status,'quarantined');
});
test('clock known to missing is explicit; bad map and basis IO cannot become unknown',async()=>{
 const f=await fixture();let missing=false,bad=false;
 const provider={evidence:'synthetic' as const,resolve:async()=>missing?undefined:{modality:'audio' as const,track_id:'mic',stream_epoch:'epoch',source_timebase_id:'samples',target_timebase_id:bad?'wrong':'utc_epoch_ms',offset_ms:Date.parse(at),drift_ppm:0,uncertainty_ms:0,basis_ref:'controlled'}};
 const clock=createSourceMediaClock(f.storage,provider);assert.equal((await clock.capture(binding,chunk())).metadata.captured_at,at);
 missing=true;await assert.rejects(clock.capture(binding,chunk()),e=>e instanceof SourceClockUnavailableError);missing=false;bad=true;
 await assert.rejects(clock.capture(binding,chunk()),e=>!(e instanceof SourceClockUnavailableError));
 bad=false;const fault={read:(n:string,k:string)=>f.storage.read(n,k),list:(n:string)=>f.storage.list(n),removePending:(k:string)=>f.storage.removePending(k),publish:async()=>{throw new Error('EIO');}};
 await assert.rejects(createSourceMediaClock(fault,provider).capture(binding,chunk()),e=>!(e instanceof SourceClockUnavailableError)&&(e as Error).message==='EIO');
});
test('runtime uses sole source registry, has no MEDIA/run path, refuses forged and closed handles',async()=>{
 const f=await fixture();let revalidations=0,valid=true;
 const source={...trusted,route_version:'route',output_modes:['text']};const {submission:_s,...device}=source;
 const runtime=new PersonalAIOSRuntime({storage:f.storage,archive:f.archive,native:{} as never,admission:{setEventOwner:()=>{},setOwnerOrigin:()=>{},setCatalogGrants:()=>{},setVoiceConfirmation:()=>{},setRunOwner:(owner:unknown)=>{assert.equal(typeof owner,'function');},setWorkOwner:(owner:unknown)=>{assert.equal(typeof owner,'function');},setStateOwner:(owner:unknown)=>{assert.equal(typeof owner,'function');},close:async()=>{}} as never,output:new OutputAuthority(f.storage),skill:'skill',max_read_bytes:4096,sourceAuthority:{authenticate:async()=>device,revalidate:async handle=>{revalidations++;assert.equal(handle,device);if(!valid)throw new Error('SOURCE_BINDING_INACTIVE');return device;}},quarantine_admission:createSourceMediaAdmission({source:{capture:async()=>({binding,trusted:{...device,submission:'observation'}})},permission:{read:async()=>assert.fail(),withPermission:async(_b,_m,consume)=>consume({authorizedMediaUntil:at} as never)},clock:{read:async()=>undefined},requestTeardown:async()=>{}}).withQuarantineAdmission});
 assert.equal((await runtime.quarantineMedia(raw(),device,chunk())).archive_status,'quarantined');assert.equal(revalidations,1);
 valid=false;await assert.rejects(runtime.quarantineMedia({...raw(),event_id:'other'},device,chunk()),/SOURCE_BINDING_INACTIVE/);
 await assert.rejects(runtime.quarantineMedia(raw(),{...device},chunk()));
 // Close needs only runtime-owned admission close here; no native/worker work was admitted.
 await runtime.close();await assert.rejects(runtime.quarantineMedia(raw(),device,chunk()),/RUNTIME_CLOSED/);
 assert.deepEqual(await f.storage.list('processed-events'),[]);
});

test('unknown-clock durable admission rejects malformed sources before writing or acknowledging a job',async()=>{
 const f=await fixture();
 for(const attempt of [
  ()=>f.archive.admitUnknownClock({...raw(),captured_at:at} as unknown as UnknownClockRaw,trusted,chunk(),binding),
  ()=>f.archive.admitUnknownClock(raw(),trusted,{...chunk(),seq:-1},binding),
  ()=>f.archive.admitUnknownClock(raw(),trusted,{...chunk(),source_range:{...chunk().source_range,timebase_id:'utc_epoch_ms'}},binding),
  ()=>f.archive.admitUnknownClock({...raw(),payload:Buffer.alloc(4097)},trusted,chunk(),binding),
  ()=>f.archive.admitUnknownClock({...raw(),device_id:'forged'},trusted,chunk(),binding),
 ])await assert.rejects(attempt());
 assert.deepEqual(await f.storage.list('raw-ingress'),[]);assert.deepEqual(await f.storage.list('objects'),[]);
 assert.deepEqual(await f.storage.list('quarantine-manifests'),[]);
});
