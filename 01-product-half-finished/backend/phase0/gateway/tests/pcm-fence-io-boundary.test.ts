import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDeviceLease} from '../../../services/realtime-core/src/device-lease-state-machine.ts';
import {createProductionStructuralEquality} from '../../../services/realtime-core/src/production-owner-ports.ts';
import {createRealtimeCredentialFence} from '../../../services/platform-data/src/realtime-credential-fence.ts';
import {RealtimeAuthorityRepository} from '../../../services/platform-data/src/realtime-authority-repository.ts';
import {isManagedTransactionClient,withTransaction} from '../../../services/platform-data/src/transaction.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {StreamArchive} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {createSourceMediaPermission} from '../src/source-media-permission.ts';
import {createSourceMediaAdmission} from '../src/source-media-admission.ts';
const at='2030-01-01T00:00:00.000Z',until='2030-01-01T00:30:00.000Z';
const session={ref_type:'RealtimeSession',ref_id:'01900000-0000-7000-8000-000000000001',object_version:'1',canonical_payload_sha256:'a'.repeat(64)};
const leaseRef={...session,ref_type:'DeviceLease',ref_id:'01900000-0000-7000-8000-000000000002'};
const binding={realtimeSessionRef:session,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',userId:'owner',deviceId:'phone',purpose:'assistant'} as never;
const trusted={principal_id:'owner',device_id:'phone',device_type:'phone',consent_ref:'consent',channel:'livekit',submission:'observation'} as const;
const raw={schema_version:'paios.event.v1',event_id:'pcm-boundary',device_id:'phone',device_type:'phone',captured_at:at,source:{channel:'livekit'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200)} as const;
const chunk={track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:100}} as const;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
function fixture() {
 let active=false,borrowed=0,failCommit=false,failRelease=false;
 const queued:(()=>void)[]=[];const statements:string[]=[];
 const client={query:async(sql:string,params:unknown[]=[])=>{
  statements.push(sql);
  if(sql==='COMMIT'&&failCommit){failCommit=false;throw new Error('commit connection lost');}
  if(sql.includes('FROM public.realtime_external_effects'))return {rows:active?[{effect_state:'committed',stage_state:{},fencing_epoch:'1',credential_generation:params[5]}]:[]};
  return {rows:[]};
 },release:()=>{assert.equal(borrowed,1);borrowed=0;queued.shift()?.();if(failRelease){failRelease=false;throw new Error('release failed');}}};
 const pool={connect:async()=>{if(borrowed)await new Promise<void>(r=>queued.push(r));assert.equal(borrowed,0);borrowed++;return client;}};
 const fence=createRealtimeCredentialFence(pool as never);
 const lease=createDeviceLease({deviceLeaseRef:leaseRef,realtimeSessionRef:session,continuityId:'continuity',userId:'owner',deviceId:'phone',issuedAt:at as never,policy:{allowed:true,capabilities:['audio'],purpose:'assistant',leaseExpiresAt:until as never,revocable:true,policyDecisionRef:'policy'}});
 let current={lease,session:{realtimeSessionRef:session,userId:'owner',continuityId:'continuity',state:'active',continuityState:'active',connectionEpoch:'1',continuityExpiresAt:until,activeDeviceId:'phone',activeDeviceLeaseRef:leaseRef,revision:'1',binding:{...(binding as object),state:'connected'}}} as never;
 const permission=createSourceMediaPermission({readCurrentBinding:async()=>withTransaction(pool as never,async()=>current),readCurrentBindingInAdmission:async(c)=>{assert.equal(c,client);assert.equal(isManagedTransactionClient(c),true);return current;},equality:createProductionStructuralEquality(),credentialFence:fence,now:()=>at});
 const admission=createSourceMediaAdmission({permission,source:{capture:async()=>withTransaction(pool as never,async()=>({binding,trusted}))},clock:{read:async()=>({modality:'audio',track_id:'mic',stream_epoch:'epoch',source_timebase_id:'samples',target_timebase_id:'utc_epoch_ms',offset_ms:Date.parse(at),drift_ppm:0,uncertainty_ms:0,basis_ref:'fixture'})},requestTeardown:async()=>{}});
 return {pool,client,fence,permission,admission,statements,get borrowed(){return borrowed;},get current(){return current;},set current(value){current=value;},failCommit:()=>{failCommit=true;},failRelease:()=>{failRelease=true;},activate:()=>{active=true;}};
}
test('max1 source reader, concurrent blocking archive, Stop and later admission',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();let captures=0;
 const task=f.admission.withAppendAdmission!(raw as never,trusted,chunk,async()=>{assert.equal(f.borrowed,0);captures++;entered.resolve();await release.promise;assert.equal(f.borrowed,0);return 'durable';});
 await entered.promise;
 // Changing current authority at Stop rejects later admissions, without waiting for archive IO.
 const snapshot=await f.permission.read(binding);
 await withTransaction(f.pool as never,async c=>{await f.fence.lock(c,snapshot.credentialFenceTuple);f.activate();});
 await assert.rejects(f.permission.withPermission(binding,'audio',async()=>assert.fail()),/CREDENTIAL_FENCE_ACTIVE/);
 assert.equal(captures,1);release.resolve();assert.equal(await task,'durable');assert.equal(f.borrowed,0);
});
test('six admissions release max1 pool before slow archive and recheck generation under lock',async()=>{
 const f=fixture(),hold=deferred();let entered=0;
 const tasks=Array.from({length:6},()=>f.permission.withPermission(binding,'audio',async()=>{entered++;await hold.promise;return entered;}));
 // Wait with a bounded deadline, rather than allowing pool starvation to hang the test.
 await Promise.race([new Promise<void>(async(resolve,reject)=>{try{while(entered<6)await new Promise(r=>setImmediate(r));resolve();}catch(e){reject(e);}}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('max1 admission starvation')),1000);t.unref();})]);
 assert.equal(f.borrowed,0);hold.resolve();await Promise.all(tasks);
 const before=(f.current as any).lease;
 let reads=0;const p=createSourceMediaPermission({readCurrentBinding:async()=>f.current,readCurrentBindingInAdmission:async()=>{reads++;return {...(f.current as any),lease:{...before,leaseVersion:'2'}};},equality:createProductionStructuralEquality(),credentialFence:f.fence,now:()=>at});
 await assert.rejects(p.withPermission(binding,'audio',async()=>assert.fail()),/MEDIA_PERMISSION_CHANGED/);assert.equal(reads,1);
});
test('failed COMMIT and release do not run archive callback',async()=>{
 const f=fixture();let calls=0;
 // Fail only the fence transaction, after advisory read has completed.
 const p=createSourceMediaPermission({readCurrentBinding:async()=>f.current,readCurrentBindingInAdmission:async()=>f.current,equality:createProductionStructuralEquality(),credentialFence:f.fence,now:()=>at});
 f.failCommit();await assert.rejects(p.withPermission(binding,'audio',async()=>{calls++;}),/POSTGRES_TRANSACTION_COMMIT/);
 f.failRelease();await assert.rejects(p.withPermission(binding,'audio',async()=>{calls++;}),/release failed/);
 assert.equal(calls,0);assert.equal(f.borrowed,0);
});
test('T02 reader reuses managed client and refuses unmanaged clients',async()=>{
 const f=fixture(),repository=new RealtimeAuthorityRepository(f.pool as never);
 await assert.rejects(repository.readCurrentBindingInTransaction(f.client as never,{realtimeSessionRef:session}),/managed transaction client/);
 await withTransaction(f.pool as never,async c=>{assert.equal(await repository.readCurrentBindingInTransaction(c,{realtimeSessionRef:session}),undefined);assert.equal(f.borrowed,1);});
 assert.equal(f.statements.filter(s=>s==='BEGIN').length,1);assert.equal(f.borrowed,0);
});
test('real L5 retry/dedup, IO failure and fence close retain owner semantics',async t=>{
 const f=fixture();const root=await fs.mkdtemp(join(tmpdir(),'paios-pcm-fence-'));
 t.after(async()=>{await fs.rm(root,{recursive:true});await assert.rejects(fs.stat(root),error=>(error as NodeJS.ErrnoException).code==='ENOENT');t.diagnostic('owned temporary directory removed: '+root);});
 const storage=new PosixStorage(root);const archive=new StreamArchive(storage,{max_chunk_bytes:4096,max_total_bytes:65536,max_chunks:64,max_revisions:64,max_seq:64});
 const append=()=>f.admission.withAppendAdmission!(raw as never,trusted,chunk,async()=>{assert.equal(f.borrowed,0);return archive.append(raw as never,trusted,at,chunk);});
 const first=await append();assert.deepEqual(await append(),first);assert.equal((await archive.head(first.event.raw_ref))?.revision,1);
 const error=new Error('ENOSPC');await assert.rejects(f.permission.withPermission(binding,'audio',async()=>{assert.equal(f.borrowed,0);throw error;}),e=>e===error);
 const gate=deferred(),entered=deferred();const pending=f.permission.withPermission(binding,'audio',async()=>{entered.resolve();await gate.promise;return archive.append(raw as never,trusted,at,chunk);});
 await entered.promise;await f.fence.close();await assert.rejects(append(),/CREDENTIAL_FENCE_CLOSED/);gate.resolve();assert.deepEqual(await pending,first);
 assert.equal((await archive.head(first.event.raw_ref))?.revision,1);assert.equal(f.borrowed,0);
});

test('real fence without borrowed-client reader fails before archive, never uses pooled fallback',async()=>{
 const f=fixture();const permission=createSourceMediaPermission({readCurrentBinding:async()=>f.current,equality:createProductionStructuralEquality(),credentialFence:f.fence,now:()=>at});
 await assert.rejects(permission.withPermission(binding,'audio',async()=>assert.fail()),/MEDIA_ADMISSION_READER_REQUIRED/);assert.equal(f.borrowed,0);
});
