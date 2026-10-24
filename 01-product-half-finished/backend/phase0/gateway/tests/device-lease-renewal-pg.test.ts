import { PublicControlProjection, projectBootstrap } from '../../../services/realtime-core/src/public-control-projection.ts';
import { createRealtimePublicControlSelfHostedCloudProjection } from '../src/realtime-public-control-self-hosted-cloud-projection.ts';
import { LiveKitCloudTokenSigner } from '../src/livekit-cloud-token-signer.ts';
import { createRealtimeCredentialFence, type CredentialFenceCanonicalRef } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import { FormalSourceAuthority, createAppleCyclingTypedSourceResolver } from '../src/personal-aios-formal-source.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import { createSourceMediaPermission } from '../src/source-media-permission.ts';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { canonical } from '../../../services/personal-aios-integration/src/contracts.ts';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import { createRealtimeAuthorityRepository } from '../../../services/platform-data/src/realtime-authority-repository.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import { RealtimeSessionService } from '../../../services/realtime-core/src/realtime-session-service.ts';
import { assertCanonicalTimestamp, assertDecimalCounter } from '../../../services/realtime-core/src/types.ts';
import { createT03AppleCyclingOwnerBundle } from '../src/t03-apple-cycling-owner-bundle.ts';
import { T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, T03_APPLE_CYCLING_AUTHORITY_SCHEMA, T03_APPLE_CYCLING_PURPOSE, wireGovernance } from '../src/t03-apple-cycling-lease-authority.ts';
const databaseUrl = process.env.PAIOS_LEASE_TEST_DATABASE_URL;
const connect = (url:string) => {const value=new URL(url);return createPostgresPool({host:value.hostname,port:Number(value.port),database:value.pathname.slice(1),user:value.username,password:value.password,max:2});};
test('actual T02/T03 lease issuance update, standard cloud credential refresh, media authority, CAS and Stop', {skip:databaseUrl===undefined}, async()=>{
  const parsed=new URL(databaseUrl!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const admin=connect(databaseUrl!),name='lease_contract_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  parsed.pathname='/'+name;const pool=connect(parsed.href);let now=Date.now(),at=assertCanonicalTimestamp(new Date(now).toISOString());
  const clock={now:()=>at},identity=createProductionRealtimeIdentityPort({clock}),equality=createProductionStructuralEquality();
  const user=identity.createConnectionId({deviceId:'source-fixture',requestId:'user'}),device=identity.createConnectionId({deviceId:user,requestId:'device'});
  const ref=(ref_type:string)=>({ref_type,ref_id:identity.createConnectionId({deviceId:device,requestId:ref_type}),object_version:'1',canonical_payload_sha256:'a'.repeat(64)});
  const operations=['bootstrap','realtime_e2ee_key_resolve','connected_credential_refresh','media_stop','end_continuity','handoff'];
  const governance={purpose_scopes:[T03_APPLE_CYCLING_PURPOSE],consent_record_refs:[ref('ConsentRecord')],policy_decision_refs:[ref('PolicyDecision')],
    purpose_token_refs:[ref('PurposeToken')],capability_grant_refs:[ref('CapabilityGrant')]};
  const principal={kind:'principal_ref',value:'fixture-opaque-not-user-id'},capability={kind:'capability_ref',value:'fixture-data-authority'};
  const record={schema:T03_APPLE_CYCLING_AUTHORITY_SCHEMA,grant_id:identity.createConnectionId({deviceId:device,requestId:'grant'}),
    issued_at_utc:new Date(now-1000).toISOString(),expires_at_utc:new Date(now+3600000).toISOString(),lease_expires_at_utc:new Date(now+3600000).toISOString(),
    user_id:user,device_id:device,principal_ref:principal,capability_ref:capability,scopes:operations,operation_scopes:operations,
    purpose:T03_APPLE_CYCLING_PURPOSE,allowed_media_capabilities:['data'],governance,consent:{watch_workout_metrics:['heart_rate','active_energy'],
      iphone_motion:['speed','location'],navigation:'user_toggle',audio_capture:'explicit_wake_or_tap_only',video_capture:'explicit_wake_or_tap_only',
      background_health:'platform_authorized',background_location:'platform_authorized'},revocable:true};
  let bytes=Buffer.from(canonical(record)+'\n');const t03=createT03AppleCyclingOwnerBundle({record:{path:T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,read:()=>bytes},
    expectedRecordSha256Port:{current:()=>createHash('sha256').update(bytes).digest('hex')},ownerProtection:{assertOwnerProtected(){}},now:()=>now});
  try {
    const migrations=new URL('../../../migrations/',import.meta.url);for(const file of (await readdir(migrations)).filter(file=>file.endsWith('.up.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
    const repository=createRealtimeAuthorityRepository(pool),makeService=()=>new RealtimeSessionService({repository,policy:t03.policy.port,
      activityAcceptance:t03.activityAcceptance.port,transportDisconnection:t03.transportDisconnection.port,identity,clock,equality});const service=makeService();
    t03.bindCurrentBinding(lookup=>service.readCurrentBinding(lookup));
    const bootstrapRequest={requestId:'formal-bootstrap',idempotencyKey:'formal-bootstrap',mode:'initial',userId:user,deviceId:device,
      capabilities:['data'],purpose:T03_APPLE_CYCLING_PURPOSE,occurredAt:at,governance:wireGovernance(governance)} as const;
    const started=await service.bootstrap(bootstrapRequest);
    const initialState=await service.readCurrentBinding({realtimeSessionRef:started.realtimeSessionRef});assert.ok(initialState);
    const cloud=createRealtimePublicControlSelfHostedCloudProjection({ livekitUrl:'wss://ai.example.invalid',now:()=>now});
    const publicProjection=new PublicControlProjection(service);
    const bootstrapCloud=await cloud.bootstrap({request:bootstrapRequest,projection:projectBootstrap(started),owner:{userId:user,deviceId:device,purpose:T03_APPLE_CYCLING_PURPOSE,capabilities:['data'],occurredAt:at},governance:wireGovernance(governance)});
    const sourceInput={request:{device_id:device,start:{device_id:device,started_at:at}},bearer:{principal,deviceId:device,capabilityRef:capability,scopes:operations},governance:wireGovernance(governance),authority:{},currentBinding:{realtimeSessionRef:started.realtimeSessionRef,deviceLeaseRef:started.deviceLeaseRef,continuityId:started.continuityId,connectionEpoch:started.connectionEpoch},enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
    const sourceAuthority=new FormalSourceAuthority({ownerContext:t03.ownerContext,readCurrentBinding:lookup=>service.readCurrentBinding(lookup),sameRef:(a,b)=>equality.same(a as never,b as never),resolveSource:createAppleCyclingTypedSourceResolver({t03,producer:{device_id:device,device_type:'phone',channel:'rtc_typed_text'},now:()=>now}),now:()=>now});
    const source=await sourceAuthority.authenticate(sourceAuthority.credentialForBootstrap(sourceInput));
    const firstTokenExpiry=bootstrapCloud.credentialExpiresAt;
    now+=660000; at=assertCanonicalTimestamp(new Date(now).toISOString());
    assert.ok(now>Date.parse(firstTokenExpiry));
    const refreshRequest={requestId:'actual-refresh',idempotencyKey:'actual-refresh',binding:started.binding,occurredAt:at,governance:wireGovernance(governance)};
    const refresh=await publicProjection.connectedRefresh(refreshRequest);
    const credential=await cloud.connectedRefresh({request:refreshRequest,projection:refresh,owner:{userId:user,deviceId:device,purpose:T03_APPLE_CYCLING_PURPOSE,capabilities:['data'],occurredAt:at},governance:wireGovernance(governance)});
    const signer=new LiveKitCloudTokenSigner({projectUrl:'wss://ai.example.invalid',apiKeyRef:{name:'fixture-key'},apiSecretRef:{name:'fixture-secret'},secretResolver:{async resolve(ref){return {read:()=>ref.name==='fixture-key'?'isolated-fixture-api-key':'isolated-fixture-secret-with-at-least-32-bytes',release(){}};}}});
    const signTime=Math.floor(Date.now()/1000);const token=await signer.sign(credential.credentialInput);
    const tokenParts=token.split('.');assert.equal(createHmac('sha256','isolated-fixture-secret-with-at-least-32-bytes').update(tokenParts[0]+'.'+tokenParts[1]).digest('base64url'),tokenParts[2]);
    const jwt=JSON.parse(Buffer.from(tokenParts[1]!, 'base64url').toString());
    assert.ok(Math.abs(jwt.exp-signTime-credential.credentialInput.ttlSeconds)<=2);assert.equal(jwt.video.canPublishData,true);
    assert.ok(Date.parse(credential.credentialExpiresAt)>Date.parse(firstTokenExpiry));
    assert.deepEqual(await service.readCurrentBinding({realtimeSessionRef:started.realtimeSessionRef}),initialState);
    const fence=createRealtimeCredentialFence(pool);
    const permission=createSourceMediaPermission({readCurrentBinding:lookup=>service.readCurrentBinding(lookup),readCurrentBindingInAdmission:(client,lookup)=>repository.readCurrentBindingInTransaction(client,lookup),equality,credentialFence:fence,now:()=>at});
    const binding={realtimeSessionRef:started.realtimeSessionRef,deviceLeaseRef:started.deviceLeaseRef as CredentialFenceCanonicalRef,continuityId:started.continuityId,connectionEpoch:started.connectionEpoch,userId:user,deviceId:device,purpose:T03_APPLE_CYCLING_PURPOSE};
    assert.equal((await permission.read(binding)).authorizedMediaUntil,started.leaseExpiresAt);
    const renewal={requestId:'lease-renew',idempotencyKey:'lease-renew',realtimeSessionRef:started.realtimeSessionRef,deviceLeaseRef:started.deviceLeaseRef,continuityId:started.continuityId,deviceId:device,expectedConnectionEpoch:started.connectionEpoch,expectedLeaseVersion:'1',expectedFencingToken:'1',ttlSeconds:86400,governance:wireGovernance(governance)};
    await assert.rejects(service.renewAppleCycling(renewal),/NOT_EXTENDING/);
    record.lease_expires_at_utc=new Date(now+7200000).toISOString();record.expires_at_utc=record.lease_expires_at_utc;
    record.grant_id=identity.createConnectionId({deviceId:device,requestId:'fresh-legitimate-grant'});
    bytes=Buffer.from(canonical(record)+'\n');
    await assert.rejects(service.renewAppleCycling({...renewal,ttlSeconds:1}),/REQUESTED_WINDOW_BELOW_ISSUED_LEASE/);
    const renewed=await service.renewAppleCycling(renewal);
    assert.equal(renewed.operation,'device_lease_renewal');assert.equal(renewed.receipt.operation,'device_lease_renewal');
    assert.equal(renewed.leaseExpiresAt,record.lease_expires_at_utc);assert.equal(renewed.continuityExpiresAt,started.continuityExpiresAt);
    const after=await service.readCurrentBinding({realtimeSessionRef:started.realtimeSessionRef});assert.deepEqual(after!.session,initialState!.session);
    assert.equal((await permission.read(binding)).authorizedMediaUntil,record.lease_expires_at_utc);
    const refreshedSource=await sourceAuthority.revalidate(source);assert.equal(refreshedSource.route_version,source.route_version);assert.equal(refreshedSource.device_id,source.device_id);
    const restarted=makeService();assert.equal((await restarted.renewAppleCycling(renewal)).receipt.replayed,true);
    await assert.rejects(restarted.renewAppleCycling({...renewal,requestId:'conflict'}),/IDEMPOTENCY_CONFLICT/);
    record.lease_expires_at_utc=new Date(now+10800000).toISOString();record.expires_at_utc=record.lease_expires_at_utc;bytes=Buffer.from(canonical(record)+'\n');
    const concurrent=await Promise.allSettled(['lease-cas-a','lease-cas-b'].map(id=>restarted.renewAppleCycling({...renewal,requestId:id,idempotencyKey:id,expectedLeaseVersion:'2',expectedFencingToken:'2'})));
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(concurrent.filter(r=>r.status==='rejected').length,1);
    const current=await service.readCurrentBinding({realtimeSessionRef:started.realtimeSessionRef});assert.equal(current!.lease.leaseVersion,'3');assert.deepEqual(current!.session,initialState!.session);
    const previousExpiry=current!.lease.expiresAt;now=Date.parse(previousExpiry)+1;at=assertCanonicalTimestamp(new Date(now).toISOString());
    record.issued_at_utc=new Date(now-1000).toISOString();record.expires_at_utc=new Date(now+3600000).toISOString();record.lease_expires_at_utc=record.expires_at_utc;
    bytes=Buffer.from(canonical(record)+'\n');
    const expiredLeaseRenewal={...renewal,requestId:'expired-lease-current-grant',idempotencyKey:'expired-lease-current-grant',expectedLeaseVersion:'3',expectedFencingToken:'3'};
    const {governance:omitted,...noAuthority}=expiredLeaseRenewal;await assert.rejects(service.renewAppleCycling(noAuthority),/AUTHORITY_REQUIRED/);
    const recovered=await service.renewAppleCycling(expiredLeaseRenewal);assert.equal(recovered.leaseVersion,'4');assert.equal(recovered.continuityExpiresAt,started.continuityExpiresAt);
    assert.equal((await permission.read(binding)).authorizedMediaUntil,record.lease_expires_at_utc);
    const terminal=await pool.query("SELECT operation,request_scope FROM realtime_terminal_facts WHERE request_scope='device_lease_renewal'");assert.equal(terminal.rows.length,3);assert.ok(terminal.rows.every(r=>r.operation==='device_lease_renewal'));
    await assert.rejects(pool.query(await readFile(new URL('../../../migrations/0011_device_lease_renewal.down.sql',import.meta.url),'utf8')),/violated by some row/);await pool.query('ROLLBACK');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM realtime_terminal_facts WHERE request_scope='device_lease_renewal'")).rows[0]!.count,3);
    await service.stop({operation:'media_stop',requestId:'stop-fence',idempotencyKey:'stop-fence',realtimeSessionRef:started.realtimeSessionRef,deviceLeaseRef:started.deviceLeaseRef,continuityId:started.continuityId,deviceId:device,expectedConnectionEpoch:started.connectionEpoch,expectedLeaseVersion:assertDecimalCounter('4'),occurredAt:at,governance:wireGovernance(governance),reason:'user_stop'});
    await assert.rejects(service.renewAppleCycling({...renewal,requestId:'after-stop',idempotencyKey:'after-stop',expectedLeaseVersion:'4',expectedFencingToken:'4'}),/SESSION_BINDING_INVALID|LEASE_BINDING_INVALID/);
    await assert.rejects(permission.read(binding),/NOT_CONNECTED|LEASE_NOT_ACTIVE/);
    const receiptBefore=await pool.query("SELECT response_hash,updated_at FROM idempotency_ledger WHERE scope='device_lease_renewal' AND idempotency_key='lease-renew'");
    const script=`import {createPostgresPool} from ${JSON.stringify(new URL('../../../services/platform-data/src/postgres-pool.ts',import.meta.url).href)};
      import {createRealtimeAuthorityRepository} from ${JSON.stringify(new URL('../../../services/platform-data/src/realtime-authority-repository.ts',import.meta.url).href)};
      import {createProductionRealtimeIdentityPort} from ${JSON.stringify(new URL('../../../services/platform-data/src/realtime-identity-issuer.ts',import.meta.url).href)};
      import {createProductionStructuralEquality} from ${JSON.stringify(new URL('../../../services/realtime-core/src/production-owner-ports.ts',import.meta.url).href)};
      import {RealtimeSessionService} from ${JSON.stringify(new URL('../../../services/realtime-core/src/realtime-session-service.ts',import.meta.url).href)};
      const input=JSON.parse(process.env.LEASE_REPLAY_INPUT),url=new URL(input.url),pool=createPostgresPool({host:url.hostname,port:Number(url.port),database:url.pathname.slice(1),user:url.username,password:url.password,max:1});
      try {const clock={now:()=>input.at},never=async()=>{throw new Error('REPLAY_CALLED_FRESH_AUTHORITY')};
      const service=new RealtimeSessionService({repository:createRealtimeAuthorityRepository(pool),clock,identity:createProductionRealtimeIdentityPort({clock}),equality:createProductionStructuralEquality(),policy:{evaluate:never},activityAcceptance:{verify:never},transportDisconnection:{verify:never}});
      const result=await service.renewAppleCycling(input.request);console.log(JSON.stringify({replayed:result.receipt.replayed,operation:result.operation,leaseExpiresAt:result.leaseExpiresAt}));}finally{await pool.end();}`;
    const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{env:{...process.env,LEASE_REPLAY_INPUT:JSON.stringify({url:parsed.href,at,request:renewal})},stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,errors);
    assert.deepEqual(JSON.parse(output),{replayed:true,operation:'device_lease_renewal',leaseExpiresAt:renewed.leaseExpiresAt});
    assert.deepEqual((await pool.query("SELECT response_hash,updated_at FROM idempotency_ledger WHERE scope='device_lease_renewal' AND idempotency_key='lease-renew'")).rows,receiptBefore.rows);
    console.log(JSON.stringify({evidence:'lease-contract-real-pg',database:name,token_signed_with_real_sdk:true,jwt_data_grant:true,jwt_signature_verified:true,refresh_after_first_token_expiry:true,refresh_deadlines_unchanged:true,new_grant_exact_lease:true,source_authority_stable_route:true,route_source:'typed-resolver-v2:T02-stable-binding+producer+T03-principal',continuity_unchanged:true,lease_cas_one_success:true,restart_separate_process_readonly_replay:true,expired_lease_fresh_grant_recovery:true,stop_blocks_renewal:true,rtc_network_and_hardware_verified:false}));
    signer.close();cloud.close?.();
  } finally {await t03.close();await pool.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});
