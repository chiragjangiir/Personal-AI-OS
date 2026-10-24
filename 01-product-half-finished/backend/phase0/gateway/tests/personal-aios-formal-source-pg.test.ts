import test from 'node:test';
import { canonical } from '../../../services/personal-aios-integration/src/contracts.ts';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import { createRealtimeAuthorityRepository } from '../../../services/platform-data/src/realtime-authority-repository.ts';
import { createProductionRealtimeIdentityPort } from '../../../services/platform-data/src/realtime-identity-issuer.ts';
import { createProductionStructuralEquality } from '../../../services/realtime-core/src/production-owner-ports.ts';
import { RealtimeSessionService } from '../../../services/realtime-core/src/realtime-session-service.ts';
import { assertCanonicalTimestamp } from '../../../services/realtime-core/src/types.ts';
import { createT03AppleCyclingOwnerBundle } from '../src/t03-apple-cycling-owner-bundle.ts';
import { T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH, T03_APPLE_CYCLING_AUTHORITY_SCHEMA, T03_APPLE_CYCLING_PURPOSE, wireGovernance } from '../src/t03-apple-cycling-lease-authority.ts';
import { FormalSourceAuthority, createAppleCyclingTypedSourceResolver } from '../src/personal-aios-formal-source.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
const databaseUrl = process.env.PAIOS_FORMAL_SOURCE_TEST_DATABASE_URL;
const connect = (url:string) => {const value=new URL(url);return createPostgresPool({host:value.hostname,port:Number(value.port),database:value.pathname.slice(1),user:value.username,password:value.password,max:2});};
test('actual T02 PostgreSQL bootstrap + existing T03 bearer owner/consent + producer family scope; fresh source fence', {skip:databaseUrl===undefined}, async()=>{
  const parsed=new URL(databaseUrl!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const admin=connect(databaseUrl!),name='formal_source_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  parsed.pathname='/'+name;const pool=connect(parsed.href),now=Date.now(),at=assertCanonicalTimestamp(new Date(now).toISOString());
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
  const bytes=Buffer.from(canonical(record)+'\n'),t03=createT03AppleCyclingOwnerBundle({record:{path:T03_APPLE_CYCLING_AUTHORITY_RECORD_PATH,read:()=>bytes},
    expectedRecordSha256:createHash('sha256').update(bytes).digest('hex'),ownerProtection:{assertOwnerProtected(){}},now:()=>now});
  try {
    const migrations=new URL('../../../migrations/',import.meta.url);for(const file of (await readdir(migrations)).filter(file=>file.endsWith('.up.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
    const repository=createRealtimeAuthorityRepository(pool),service=new RealtimeSessionService({repository,policy:t03.policy.port,
      activityAcceptance:t03.activityAcceptance.port,transportDisconnection:t03.transportDisconnection.port,identity,clock,equality});
    t03.bindCurrentBinding(lookup=>service.readCurrentBinding(lookup));
    const started=await service.bootstrap({requestId:'formal-bootstrap',idempotencyKey:'formal-bootstrap',mode:'initial',userId:user,deviceId:device,
      capabilities:['data'],purpose:T03_APPLE_CYCLING_PURPOSE,occurredAt:at,governance:wireGovernance(governance)});
    const current=await service.readCurrentBinding({realtimeSessionRef:started.realtimeSessionRef});assert.ok(current);
    assert.equal(current.session.userId,user);assert.equal(current.lease.userId,user);assert.equal(current.session.binding.state,'connected');
    const input={request:{device_id:device,start:{device_id:device,started_at:at}},bearer:{principal,deviceId:device,capabilityRef:capability,scopes:operations},governance:wireGovernance(governance),authority:{},
      currentBinding:{realtimeSessionRef:started.realtimeSessionRef,deviceLeaseRef:started.deviceLeaseRef,continuityId:started.continuityId,connectionEpoch:started.connectionEpoch},
      enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
    const resolver=createAppleCyclingTypedSourceResolver({t03,producer:{device_id:device,device_type:'phone',channel:'rtc_typed_text'},now:()=>now});
    const sourceAuthority=new FormalSourceAuthority({ownerContext:t03.ownerContext,readCurrentBinding:lookup=>service.readCurrentBinding(lookup),
      sameRef:(a,b)=>equality.same(a as never,b as never),resolveSource:resolver,now:()=>now});
    const source=await sourceAuthority.authenticate(sourceAuthority.credentialForBootstrap(input));
    assert.equal(source.principal_id,user);assert.equal(source.device_id,device);assert.equal(source.device_type,'phone');
    assert.equal(source.consent_ref,governance.consent_record_refs[0]!.ref_id);assert.equal('token_sha256' in source,false);
    const forged={...input,bearer:{...input.bearer,principal:{opaque_ref:'forged'}}};
    await assert.rejects(sourceAuthority.authenticate(sourceAuthority.credentialForBootstrap(forged)),/AUTHORITY_DENIED/);
    await pool.query('UPDATE device_leases SET lease_version=lease_version+1,fencing_token=fencing_token+1 WHERE lease_ref_id=$1',[(started.deviceLeaseRef as any).ref_id]);
    const renewed=await sourceAuthority.revalidate(source);assert.equal(renewed.route_version,source.route_version);
    await pool.query('UPDATE realtime_sessions SET connection_epoch=connection_epoch+1 WHERE session_ref_id=$1',[(started.realtimeSessionRef as any).ref_id]);
    await assert.rejects(sourceAuthority.revalidate(source),/OWNER_BINDING_DENIED|AUTHORITY_CONFLICT/);
    console.log(JSON.stringify({canonical_user_id:user,canonical_device_id:device,consent_ref:source.consent_ref,initial_route:source.route_version,renewed_route:renewed.route_version,renewal_source:'direct-isolated-DB-version-fence-change',epoch_negative:'direct-isolated-DB-mutation',evidence:'formal-source-pg',database:name,actual_user_owner:true,opaque_principal_not_identity:true,consent_source:'T03',family_scope:'fixture-owned-phone',route_source:'typed-resolver-v2:T02-stable-binding+producer+T03-principal',pg_bootstrap:true}));
  } finally {await t03.close();await pool.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});
