import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPairedDeviceCapabilities} from '../src/paired-device-capabilities.ts';
import {issueDeviceGovernance} from '../src/paired-device-registration.ts';
import {createPairedDeviceAuthority,createPairedTerminalAuthorities,wireGovernanceOf} from '../src/paired-device-authority.ts';
import {createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import {RealtimePublicControlRuntime,type RealtimeBootstrapConnectedPort} from '../src/realtime-public-control-runtime.ts';
import {createProductionBootstrapConnectedOwner} from '../src/realtime-public-control-pg-composition.ts';
import {FormalTerminalSources} from '../src/personal-aios-formal-source.ts';
import type {TerminalCapability} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {CapabilityUpgradeRequest} from '../../../services/personal-aios-integration/src/voiceprint/confirmation.ts';

const DEVICE='01a145a5-cd92-7e23-8eec-11fade8d251e',USER='01900000-0000-7000-8000-000000000002';
const BASE:TerminalCapability[]=['display','microphone','notifications','chat_ui','desktop_tools'];
const NEXT:TerminalCapability[]=[...BASE,'speaker','camera'];
const identity={createConnectionId:({deviceId,requestId}:{deviceId:string;requestId:string})=>`${deviceId}:${requestId}`};
// A transaction-aware SQL fixture exercises the production grant owner; it does not prove PostgreSQL locking.
function fixture(){
  const issued=issueDeviceGovernance({identity,userId:USER,deviceId:DEVICE,deviceType:'mac',publicKeySha256:'public-key-digest',capabilities:BASE,pairedAt:'2026-10-01T00:00:00.000Z'});
  let row:any={device_id:DEVICE,user_id:USER,device_class:'mac',status:'active',recipient_public_key:'public-key',recipient_public_key_sha256:'public-key-digest',
    device_credential_ref:{ref_id:'original-device-credential'},token_sha256:createHash('sha256').update('paired-token').digest('hex'),paired_at:'2026-10-01T00:00:00.000Z',...issued};
  let snapshot:any;
  const requests:CapabilityUpgradeRequest[]=[],refreshes:string[]=[];
  const query=async(sql:string,args:any[]=[])=>{
    if(sql==='BEGIN'){snapshot=structuredClone(row);return {rows:[]};}
    if(sql==='COMMIT'||sql==='LISTEN paired_device_revoked'||sql==='UNLISTEN paired_device_revoked')return {rows:[]};
    if(sql==='ROLLBACK'){row=snapshot;return {rows:[]};}
    if(sql.startsWith('UPDATE paired_devices SET governance')){assert.equal(args[0],DEVICE);row.governance=JSON.parse(args[1]);if(args[2])row.media=args[2];return {rows:[]};}
    if(sql.startsWith('SELECT ')){
      let matches=row.status==='active';
      if(sql.includes('token_sha256 = $1'))matches&&=row.token_sha256===args[0];
      if(sql.includes('device_id = $1'))matches&&=row.device_id===args[0];
      if(sql.includes('user_id = $2'))matches&&=row.user_id===args[1];
      return {rows:matches?[structuredClone(row)]:[]};
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const pool={query,connect:async()=>({query,release:()=>{},on:()=>{},removeListener:()=>{}})};
  const service=createPairedDeviceCapabilities({pool:pool as never,identity,request:async(request)=>{requests.push(request);},refresh:async id=>{refreshes.push(id);
    return {governance:structuredClone(row.governance),capabilities:[...row.governance.terminal_capabilities],allowedMediaCapabilities:[...row.media]};}});
  return {service,pool,requests,refreshes,get row(){return row;}};
}

test('stale production Mac gains speaker/camera only after approval with canonical grants and unchanged pairing',async()=>{
  const f=fixture(),original=structuredClone(f.row);
  const pending=await f.service.declare('paired-token',NEXT);
  assert.deepEqual(pending.capabilities,BASE);assert.deepEqual(pending.media,['data','audio']);
  assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0]!.grant_ref,original.governance.capability_grant_refs[0]);
  await f.service.approve(f.requests[0]!);
  const expected=issueDeviceGovernance({identity,userId:USER,deviceId:DEVICE,deviceType:'mac',publicKeySha256:original.recipient_public_key_sha256,
    capabilities:[...NEXT].sort(),pairedAt:original.paired_at,version:2});
  assert.deepEqual(f.row.governance,{...expected.governance,capability_declaration:[...NEXT].sort()});
  assert.deepEqual(f.row.media,['data','audio','video']);
  for(const key of ['device_id','user_id','token_sha256','recipient_public_key','device_credential_ref','paired_at'])assert.deepEqual(f.row[key],original[key]);
  const approved=structuredClone(f.row);await f.service.approve(f.requests[0]!);assert.deepEqual(f.row,approved,'approval replay issues no new grant');
  const current=await f.service.declare('paired-token',[...NEXT].reverse());
  assert.deepEqual(current.governance,wireGovernanceOf(expected.governance));assert.deepEqual(current.capabilities,[...NEXT].sort());
  assert.equal(f.requests.length,1,'approved declaration does not request approval again');
});

test('declining or abandoning the request never widens grants; malformed and foreign requests are rejected',async()=>{
  const f=fixture();await f.service.declare('paired-token',NEXT);
  assert.deepEqual(f.row.governance.terminal_capabilities,BASE);
  await assert.rejects(f.service.declare('wrong-token',NEXT),/CONTROL_CAPABILITY_INVALID/);
  for(const invalid of [undefined,'speaker',['unknown'],['speaker','speaker']])await assert.rejects(f.service.declare('paired-token',invalid),/INVALID_TERMINAL_CAPABILITIES|TERMINAL_CAPABILITY_DENIED/);
  await assert.rejects(f.service.approve({...f.requests[0]!,principal_id:'foreign-owner'}),/PAIRED_DEVICE_REVOKED/);
  await assert.rejects(f.service.approve({...f.requests[0]!,grant_ref:{...f.requests[0]!.grant_ref,object_version:'99'}}),/CAPABILITY_GRANT_CHANGED/);
  assert.deepEqual(f.row.governance.terminal_capabilities,BASE);
});

test('declaration returns the applied authority when approval changes the grant during activation',async()=>{
  const f=fixture();
  const service=createPairedDeviceCapabilities({pool:f.pool as never,identity,request:async request=>{f.requests.push(request);},
    refresh:async deviceId=>{
      await f.service.approve(f.requests[0]!);
      return (await createPairedDeviceAuthority({pool:f.pool as never,deviceId})).readCurrentAuthority();
    }});
  const result=await service.declare('paired-token',NEXT);
  assert.deepEqual(result.capabilities,[...NEXT].sort());
  assert.deepEqual(result.governance,wireGovernanceOf(f.row.governance));
  assert.deepEqual(result.media,['data','audio','video']);
});

test('mixed removal takes effect immediately and stale approval cannot restore removed capabilities',async()=>{
  const f=fixture();await f.service.declare('paired-token',NEXT);const stale=f.requests[0]!;
  const mixed=NEXT.filter(capability=>capability!=='microphone');
  const result=await f.service.declare('paired-token',mixed);
  assert.equal(result.capabilities.includes('microphone'),false);assert.equal(result.capabilities.includes('speaker'),false);
  assert.deepEqual(result.media,['data']);
  assert.equal(f.row.governance.capability_grant_refs[0].object_version,'2');
  await assert.rejects(f.service.approve(stale),/CAPABILITY_DECLARATION_CHANGED/);
  await f.service.approve(f.requests.at(-1)!);
  assert.deepEqual(f.row.governance.terminal_capabilities,[...mixed].sort());assert.deepEqual(f.row.media,['data','video']);
  await assert.rejects(f.service.approve(stale),/CAPABILITY_DECLARATION_CHANGED/);
  const removed=await f.service.declare('paired-token',BASE.filter(c=>c!=='microphone'));
  assert.equal(removed.capabilities.includes('speaker'),false);assert.deepEqual(removed.media,['data']);
});

test('revocation before declaration or between declaration and approval prevents regrant',async()=>{
  const f=fixture();await f.service.declare('paired-token',NEXT);f.row.status='revoked';
  await assert.rejects(f.service.approve(f.requests[0]!),/PAIRED_DEVICE_REVOKED/);
  await assert.rejects(f.service.declare('paired-token',NEXT),/CONTROL_CAPABILITY_INVALID/);
  assert.equal(f.row.status,'revoked');assert.deepEqual(f.row.governance.terminal_capabilities,BASE);
});

test('mixed removal retires cached permission even when opening the approval fails',async t=>{
  const f=fixture(),aggregate=await createPairedTerminalAuthorities({pool:f.pool as never});t.after(()=>aggregate.close());
  const service=createPairedDeviceCapabilities({pool:f.pool as never,identity,
    request:async()=>{throw new Error('confirmation storage unavailable');},
    refresh:async id=>(await aggregate.register(id,true)).readCurrentAuthority()});
  await assert.rejects(service.declare('paired-token',NEXT.filter(capability=>capability!=='microphone')),/confirmation storage unavailable/);
  const capabilities=aggregate.forDevice(DEVICE).readCurrentAuthority().capabilities;
  assert.equal(capabilities.includes('microphone'),false);assert.equal(capabilities.includes('speaker'),false);
  assert.equal(capabilities.includes('camera'),false);
});

// Exercise the actual runtime response and production aggregate with controlled session/signing/transport ports.
// The attachment hook is controlled: PCM capture and source binding are outside this metadata regression.
async function nextBootstrap(bridge:RealtimeBootstrapConnectedPort,governance:unknown){
  const at=Date.parse('2026-10-19T12:00:00Z'),expires=new Date(at+600000).toISOString();
  const ref=(ref_type:string)=>({ref_type,ref_id:DEVICE,object_version:'1',canonical_payload_sha256:'a'.repeat(64)});
  const session=ref('RealtimeSession'),lease=ref('DeviceLease');
  const start={kind:'explicit_user_start',device_id:DEVICE,modalities:['data','audio'],started_at:new Date(at).toISOString()};
  const grants={room:'room',roomJoin:true,canPublish:true,canSubscribe:true,canPublishData:true,canPublishSources:['microphone']};
  const enabled={enabled:true,device_id:DEVICE,device_lease_ref:lease,start_binding:start,expires_at:expires};
  const authority={realtime_session_ref:session,device_lease_ref:lease,continuity_id:'controlled-continuity',connection_epoch:'1',
    transport_aliases:['controlled-room'],server_url:'wss://project.livekit.cloud',credential_expires_at:expires,continuity_expires_at:expires,
    terminal_room_name:'room',terminal_identity:'terminal',terminal_grants:grants,media_grants:{data:enabled,audio:enabled,video:{enabled:false}},governance,
    gateway:{roomName:'room',identity:'gateway',grants:{...grants,canPublish:false,canPublishSources:[]}}};
  const unused=async()=>{throw new Error('UNUSED_BOOTSTRAP_PORT');};
  let attached=0;
  const runtime=new RealtimePublicControlRuntime({governance:{evaluate:async()=>({accepted:true,refs:governance})},
    sessions:{bootstrap:async()=>authority,refresh:unused,endContinuity:unused},mediaStop:{claim:unused,complete:unused},
    deviceCredential:{resolve:async()=>ref('DeviceCredential')},
    e2ee:{issue:async()=>({envelope:{realtime_session_ref:session,continuity_id:authority.continuity_id,governance,key_envelope_ref:{value:'envelope'},
      key_index:0,key_generation:'1',expires_at:expires,scope:{device_id:DEVICE,channels:['audio','data'],distribution_mode:'application_controlled_envelope'}},
      roomOptions:{encryption:{}},release:()=>{}})},e2eeCiphertext:{resolve:unused},
    tokenSigner:{assertProjectUrl:()=>{},sign:async()=>'controlled-token',close:()=>{}},participant:{connect:async()=>{},disconnect:async()=>{},close:async()=>{},snapshot:()=>({connected:true})},
    bootstrapConnected:createProductionBootstrapConnectedOwner(undefined,{centralTextTransport:bridge.centralTextTransport,onBootstrapConnected:async()=>{attached++;}}),now:()=>at} as never);
  try {const result=await runtime.bootstrap({operation:'bootstrap',bootstrap_mode:'initial',request_id:'controlled-next-bootstrap',device_id:DEVICE,
    start,requested_media:{data:true,audio:true,video:false},governance},{deviceId:DEVICE,principal:USER} as never);
    assert.equal(attached,1);return result.central_text_transport as Record<string,unknown>;
  } finally {await runtime.close();}
}

test('approved stale Mac composes a real persistent call owner and exposes 120 second bootstrap rejoin metadata',async t=>{
  const f=fixture();
  const room={isConnected:true,remoteParticipants:new Map(),on:()=>{},off:()=>{}};
  // Media/native execution is controlled. The paired authority, persistent execution owner, call session and bridge are real.
  const assembly={runtime:{existingArchive:()=>({})}};
  const shared={assembly,sources:new FormalTerminalSources(),terminals:new Map(),admissions:new Map(),media:{service:{archiveChunkBytes:4096,archiveBudget:{max_chunk_bytes:4096}}}};
  const central={max_event_bytes:4096,storage:{},http:{},voice:{createFront:()=>{throw new Error('MODEL_CONNECTION_FORBIDDEN');}}};
  const pcm={producer:{device_type:'mac',channel:'rtc_pcm_and_text'},budget:{max_frame_samples:1024,max_pending_frames:4,max_pending_bytes:8192,max_samples:4096},
    clock:{evidence:'synthetic',resolve:async()=>undefined}};
  const create=async()=>createPersistentPublicExecutionOwner({executionOwner:'hermes_text',deviceId:DEVICE,central,pcm,sharedExecution:shared,
    t03:await createPairedDeviceAuthority({pool:f.pool as never,deviceId:DEVICE}),participant:{roomPort:room},
    credentialFence:{verify:async()=>({active:false}),withAdmission:async(_tuple:unknown,consume:()=>Promise<unknown>)=>consume()},
    readCurrentBinding:async()=>undefined,readCurrentBindingInAdmission:async()=>undefined,onError:error=>{throw error;}} as never);
  const stale=await create();
  assert.equal((await nextBootstrap(stale.bridge,wireGovernanceOf(f.row.governance))).call_rejoin_window_s,undefined,'old grant does not create a call owner');
  await stale.bridge.close!();
  await f.service.declare('paired-token',NEXT);await f.service.approve(f.requests[0]!);
  const upgraded=await create();t.after(()=>upgraded.bridge.close!());
  assert.equal((await nextBootstrap(upgraded.bridge,wireGovernanceOf(f.row.governance))).call_rejoin_window_s,120,'next runtime bootstrap carries actual call owner window');
  assert.equal(typeof upgraded.bridge.callRejoinForDevice,'function');
  assert.equal(upgraded.bridge.callRejoinForDevice!('other-device'),undefined);
  assert.equal(upgraded.bridge.callRejoinForDevice!(DEVICE),undefined,'no synthetic call was opened');
});


test('aggregate refresh replaces the cached grant, retains binding readiness and closes the old authority',async t=>{
  const f=fixture(),aggregate=await createPairedTerminalAuthorities({pool:f.pool as never});t.after(()=>aggregate.close());
  aggregate.bindCurrentBinding(async()=>undefined);
  const old=aggregate.forDevice(DEVICE),tokenSha256=f.row.token_sha256;
  const before=await aggregate.bearer.resolve({tokenSha256,operation:'bootstrap'});
  assert.equal(aggregate.readiness.isReady(),true);
  await f.service.declare('paired-token',NEXT);await f.service.approve(f.requests[0]!);
  assert.equal(old.readCurrentAuthority().capabilities.includes('speaker'),false,'cached projection changes only through its owner refresh');
  const current=await aggregate.register(DEVICE,true);
  assert.notEqual(current,old);assert.equal(aggregate.forDevice(DEVICE),current);assert.equal(aggregate.terminals.length,1);
  assert.equal(aggregate.readiness.isReady(),true);assert.equal(current.readiness.current().bound,true);
  assert.deepEqual(current.readCurrentAuthority().capabilities,[...NEXT].sort());
  await assert.rejects(old.readActiveAuthority(),/PAIRED_DEVICE_REVOKED/);
  assert.equal(await old.bearer.resolve({tokenSha256,operation:'bootstrap'}),undefined);
  const after=await aggregate.bearer.resolve({tokenSha256,operation:'bootstrap'});
  assert.equal(after!.deviceId,before!.deviceId);assert.equal(after!.tokenSha256,before!.tokenSha256);
  assert.deepEqual(after!.capabilityRef,f.row.governance.capability_grant_refs[0]);assert.notDeepEqual(after!.capabilityRef,before!.capabilityRef);
});
