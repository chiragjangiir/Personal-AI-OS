import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadMigrations,migrateDatabase} from '../src/schema-migrator.ts';
import test from 'node:test';
import {createPostgresPool} from '../src/postgres-pool.ts';
import {createProductionRealtimeIdentityPort} from '../src/realtime-identity-issuer.ts';
import {createProductionRealtimeCanonicalDeviceIdentityIssuer} from '../src/realtime-canonical-device-issuer.ts';
import {createApplePhysicalCanaryBindingPostgres} from '../src/apple-physical-canary-binding-postgres.ts';
import {withTransaction} from '../src/transaction.ts';
import {createRealtimeCredentialFence} from '../src/realtime-credential-fence.ts';
import {createSourceMediaPermission} from '../../../phase0/gateway/src/source-media-permission.ts';
import {FormalSourceAuthority} from '../../../phase0/gateway/src/personal-aios-formal-source.ts';
const url=process.env.PAIOS_WATCH_TEST_DATABASE_URL;
const connect=(value:string)=>{const u=new URL(value);return createPostgresPool({host:u.hostname,port:Number(u.port),database:u.pathname.slice(1),user:u.username,password:u.password,max:8});};
test('HTTPS Watch credentials: secret-free replay rotation, ownership, disconnected parent and revoke fence',{skip:!url},async t=>{
  const logs:unknown[][]=[];
  for(const method of ['log','info','warn','error','debug'] as const)t.mock.method(console,method,(...args:unknown[])=>{logs.push(args);});
  const parsed=new URL(url!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const admin=connect(url!),name='watch_credential_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  parsed.pathname='/'+name;const pool=connect(parsed.href);
  pool.on('connect',client=>{void client.query("SET lock_timeout='2s'");});
  const identity=createProductionRealtimeIdentityPort({clock:{now:()=>new Date().toISOString() as never}});
  const device=identity.createConnectionId({deviceId:'fixture',requestId:'phone'}),user=identity.createConnectionId({deviceId:device,requestId:'user'});
  const continuity=identity.createContinuityId({userId:user,requestId:'continuity'}),session=identity.createSessionRef({continuityId:continuity,userId:user,requestId:'session'});
  const lease=identity.createDeviceLeaseRef({sessionRef:session,deviceId:device,requestId:'lease'});
  const sid=(session as any).ref_id,lid=(lease as any).ref_id,expiresAt=new Date(Date.now()+3600000).toISOString();
  const auth={userId:user,deviceId:device,principalRef:user,expiresAt,purpose:'cycling_assistant',policyDecisionRef:{},capabilities:['audio','data']};
  const owner=()=>createApplePhysicalCanaryBindingPostgres({pool,identity,canonicalDeviceIssuer:createProductionRealtimeCanonicalDeviceIdentityIssuer(),formalPrimaryAuthority:{resolve:async value=>{assert.deepEqual(value,auth);return auth;}}});
  const api=owner(),governance={policy_decision_refs:[{}],consent_record_refs:[{ref_type:'ConsentRecord',ref_id:randomUUID()}]};
  try{
    const migrations=new URL('../../../migrations/',import.meta.url);
    assert.equal((await migrateDatabase(pool,fileURLToPath(migrations))).verified,loadMigrations(fileURLToPath(migrations)).length);
    assert.equal((await migrateDatabase(pool,fileURLToPath(migrations))).applied.length,0);
    await pool.query(`INSERT INTO paired_devices(device_id,user_id,device_class,token_sha256,recipient_public_key,recipient_public_key_sha256,device_credential_ref,media,governance,status,paired_at)
      VALUES($1,$2,'iphone',$3,$4,$3,'{}',ARRAY['audio','data'],$5,'active',now())`,[device,user,'a'.repeat(64),'a'.repeat(43),governance]);
    await pool.query(`INSERT INTO realtime_sessions(session_ref_id,realtime_session_ref,session_object_version,session_payload_sha256,user_id,continuity_id,continuity_ref,active_device_lease_ref,active_device_id,binding,state,connection_epoch,continuity_expires_at)
      VALUES($1,$2,'1',$3,$4,$5,'{}',$6,$7,'{"state":"disconnected"}','active',1,$8)`,[sid,session,(session as any).canonical_payload_sha256,user,continuity,lease,device,expiresAt]);
    await pool.query(`INSERT INTO device_leases(lease_ref_id,device_lease_ref,lease_object_version,lease_payload_sha256,session_ref_id,realtime_session_ref,continuity_ref,user_id,device_id,continuity_id,capabilities,purpose,policy_decision_ref,capability_scope,purpose_scope,policy_binding,state,lease_version,fencing_token,issued_at,acquired_at,expires_at)
      VALUES($1,$2,'1',$3,$4,$5,'{}',$6,$7,$8,'["audio","data"]','cycling_assistant','{}','{}','{}','{}','active',1,1,now(),now(),$9)`,[lid,lease,(lease as any).canonical_payload_sha256,sid,session,user,device,continuity,expiresAt]);
    const base={requestId:'register',idempotencyKey:'register',realtimeSessionRef:session,iphoneDeviceLeaseRef:lease,expectedPairVersion:'0',installationId:randomUUID(),ttlSeconds:600};
    const binding=await api.mutateFormal({...base,action:'register'},auth);
    assert.equal(binding.pairVersion,'1','register advances the canonical pair version from zero');
    const assertCurrentScope=async(pairVersion:string,watchDeviceId:string)=>{
      const formal=await api.readFormal({realtimeSessionRef:session,iphoneDeviceLeaseRef:lease},auth);
      assert.deepEqual(formal.pairState,{pairVersion,status:'active',requiresRebind:false});
      assert.equal(formal.binding?.pairVersion,pairVersion);
      assert.equal(formal.binding?.watch.deviceId,watchDeviceId);
    };
    await assertCurrentScope('1',binding.watch.deviceId);
    const issue={action:'issue' as const,requestId:randomUUID(),watchDeviceId:binding.watch.deviceId,installationId:binding.installationId,expectedPairVersion:binding.pairVersion};
    for(const drift of [{principalRef:'changed-principal'},{policyDecisionRef:{changed:true}},{deviceId:user},{purpose:'changed-purpose'}]){
      let reads=0;
      const changing=createApplePhysicalCanaryBindingPostgres({pool,identity,canonicalDeviceIssuer:createProductionRealtimeCanonicalDeviceIdentityIssuer(),
        formalPrimaryAuthority:{resolve:async()=>++reads===1?auth:{...auth,...drift}}});
      await assert.rejects(changing.credential({...issue,requestId:randomUUID()},auth),/watch_scope_denied/);
      assert.equal(reads,2);
    }
    const issued=await api.credential(issue,auth);assert.equal(issued.status,'credential');assert.ok(Date.parse(issued.expires_at as string)<=Date.parse(binding.expiresAt));
    assert.equal(issued.pair_version,'1');assert.equal(issued.watch_device_id,binding.watch.deviceId);
    await assertCurrentScope('1',binding.watch.deviceId);
    const {token:issuedToken,...issuedOutcome}=issued;
    const replayed=await owner().credential(issue,auth),{token:replayedToken,...replayedOutcome}=replayed;
    assert.deepEqual(replayedOutcome,issuedOutcome);assert.ok(replayedToken!==issuedToken);
    await assert.rejects(api.resolveCredential(issuedToken as string),/credential_invalid/);
    assert.equal((await api.resolveCredential(replayedToken as string)).binding.bindingId,binding.bindingId);
    const concurrent=await Promise.all([api.credential(issue,auth),api.credential(issue,auth)]);
    for(const result of concurrent){const {token,...outcome}=result;assert.deepEqual(outcome,issuedOutcome);assert.ok(token!==replayedToken);}
    assert.ok(concurrent[0]!.token!==concurrent[1]!.token);
    await assert.rejects(api.resolveCredential(replayedToken as string),/credential_invalid/);
    const valid=await Promise.allSettled(concurrent.map(result=>api.resolveCredential(result.token as string)));
    assert.equal(valid.filter(result=>result.status==='fulfilled').length,1,'concurrent replay leaves only its last committed rotation valid');
    for(const result of valid)if(result.status==='rejected')assert.match(result.reason.message,/credential_invalid/);
    await assert.rejects(api.credential({...issue,action:'refresh'},auth),/request_conflict/);
    const failedCAS={...issue,requestId:randomUUID(),expectedPairVersion:'3'};
    assert.deepEqual(await api.credential(failedCAS,auth),{status:'failed',reason:'pair_version_conflict'});
    const failedScope={...issue,requestId:randomUUID(),watchDeviceId:randomUUID()};
    assert.deepEqual(await api.credential(failedScope,auth),{status:'failed',reason:'watch_scope_denied'});
    assert.deepEqual(await owner().credential(failedScope,auth),{status:'failed',reason:'watch_scope_denied'});
    for(const token of ['', 'bad', 'x'.repeat(43)])await assert.rejects(api.resolveCredential(token),/credential_invalid/);
    assert.equal((await withTransaction(pool,c=>api.readWatchInAdmission(c,user,device,binding.watch.deviceId))).bindingId,binding.bindingId);
    await assert.rejects(withTransaction(pool,c=>api.readWatchInAdmission(c,user,device,randomUUID())),/watch_unregistered/);
    const token=concurrent[valid.findIndex(result=>result.status==='fulfilled')]!.token as string;
    const sourceOwner=new FormalSourceAuthority({watchCredentials:api,ownerContext:{resolve:async()=>{throw Error('phone must not connect');}},
      readCurrentBinding:async()=>({session:{userId:user,continuityId:continuity,connectionEpoch:'1'},lease:{purpose:'cycling_assistant'}} as never),sameRef:()=>false,resolveSource:async()=>{throw Error('relay forbidden');}});
    const source=await sourceOwner.authenticate(sourceOwner.credentialForWatch(token));
    assert.equal(source.channel,'watch_https');assert.equal(source.device_id,binding.watch.deviceId);assert.equal(source.output_target?.device_id,device);
    assert.equal((await sourceOwner.captureSource(source)).binding.continuityId,continuity);
    await sourceOwner.withVoiceAction(source,'audio',async()=>{assert.equal((await sourceOwner.revalidate(source)).device_id,binding.watch.deviceId);});
    // finalizeVoice produces transcript content, not app_event.origin. Phone reply/control must accept that D.
    const current={session:{state:'active',continuityState:'active',binding:{state:'connected',deviceId:device,
      realtimeSessionRef:session,deviceLeaseRef:lease,continuityId:continuity,connectionEpoch:'1'},userId:user,activeDeviceId:device,
      activeDeviceLeaseRef:lease,realtimeSessionRef:session,continuityId:continuity,connectionEpoch:'1',revision:'1',continuityExpiresAt:expiresAt},
      lease:{state:'active',deviceId:device,userId:user,realtimeSessionRef:session,deviceLeaseRef:lease,continuityId:continuity,
        purpose:'cycling_assistant',expiresAt,leaseVersion:'1',capabilities:['audio','data']}};
    const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),read=async()=>current as never;
    const fence=createRealtimeCredentialFence(pool);
    const permission=createSourceMediaPermission({readCurrentBinding:read,readCurrentBindingInAdmission:read,equality:{same} as never,
      credentialFence:fence,now:()=>new Date().toISOString()});
    const phoneOwner=new FormalSourceAuthority({watchCredentials:api,ownerContext:{resolve:async()=>({userId:user,deviceId:device}) as never},
      readCurrentBinding:read,readCurrentBindingInAdmission:read,sameRef:same,runControlPermission:permission,
      resolveSource:async()=>({device_type:'phone',capabilities:['microphone','display'],channel:'rtc_typed_text',consent_ref:governance.consent_record_refs[0]!.ref_id,
        route_version:'route:phone',output_modes:['text']}) as never,
      watchSnapshot:{readCurrentBindingSnapshot:async()=>({binding:current,formalWatchBinding:binding,
        formalWatchPairState:{status:'active',requiresRebind:false,pairVersion:'1'}})} as never});
    const phone=await phoneOwner.authenticate(phoneOwner.credentialForBootstrap({request:{},bearer:{deviceId:device},governance:{},
      enabledMedia:{data:true},currentBinding:{realtimeSessionRef:session,deviceLeaseRef:lease,continuityId:continuity,connectionEpoch:'1'}} as never));
    const audioD: any={principal_id:user,device_id:binding.watch.deviceId,device_type:'watch',origin:'device_observation',modality:'audio',
      source:{channel:'watch_https',relay_device_id:device},content:{transcript:{text:'你好',candidate_ref:'candidate:1',request_evidence_ref:'request:1'}}};
    await phoneOwner.verifyOutputRecipient(phone,audioD,source.route_version);
    await phoneOwner.verifyRunController(phone,audioD,source.route_version);
    for(const bad of [{...audioD,principal_id:randomUUID()},{...audioD,device_id:randomUUID()},
      {...audioD,source:{channel:'watch_https',relay_device_id:randomUUID()}}]){
      await assert.rejects(phoneOwner.verifyOutputRecipient(phone,bad as never,source.route_version));
      await assert.rejects(phoneOwner.verifyRunController(phone,bad as never,source.route_version));
    }
    await assert.rejects(phoneOwner.verifyOutputRecipient(phone,audioD,'wrong-route'),/SOURCE_OUTPUT_ROUTE_CHANGED/);
    await assert.rejects(phoneOwner.verifyRunController(phone,audioD,'wrong-route'),/SOURCE_CONTROL_BINDING_CHANGED/);
    await assert.rejects(phoneOwner.verifyOutputRecipient(phone,{...audioD,source:{channel:'watch_connectivity',relay_device_id:device}} as never,source.route_version),/SOURCE_OUTPUT_ORIGIN_REQUIRED/);
    const refresh={...issue,action:'refresh' as const,requestId:randomUUID()},firstRefresh=await api.credential(refresh,auth);
    const rotated=await owner().credential(refresh,auth);
    const {token:firstRefreshToken,...firstRefreshOutcome}=firstRefresh,{token:rotatedToken,...rotatedOutcome}=rotated;
    assert.deepEqual(rotatedOutcome,firstRefreshOutcome);assert.ok(rotatedToken!==firstRefreshToken);
    await assert.rejects(api.resolveCredential(firstRefreshToken as string),/credential_invalid/);
    assert.equal(rotated.pair_version,'1');assert.equal(rotated.watch_device_id,binding.watch.deviceId);
    await assertCurrentScope('1',binding.watch.deviceId);
    assert.ok(rotated.token!==token);await assert.rejects(api.resolveCredential(token),/credential_invalid/);
    await pool.query("UPDATE apple_physical_canary_bindings SET watch_token_expires_at=now()-interval '1 second' WHERE binding_id=$1",[binding.bindingId]);
    await assert.rejects(api.resolveCredential(rotated.token as string),/credential_expired/);
    const fresh=await api.credential({...issue,action:'refresh',requestId:randomUUID()},auth);
    assert.equal(fresh.pair_version,'1');await assertCurrentScope('1',binding.watch.deviceId);
    let entered!:()=>void,release!:()=>void;const inside=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    const freshSource=await sourceOwner.authenticate(sourceOwner.credentialForWatch(fresh.token as string));
    const admitted=sourceOwner.withVoiceAction(freshSource,'data',async()=>{
      entered();await gate;
      assert.equal((await sourceOwner.revalidate(freshSource)).device_id,binding.watch.deviceId);
      assert.equal((await sourceOwner.captureSource(freshSource)).trusted.device_id,binding.watch.deviceId);
      await sourceOwner.withVoiceAction(freshSource,'audio',async()=>undefined);
      return 'admitted';
    });await inside;
    const revoke=api.mutateFormal({realtimeSessionRef:session,iphoneDeviceLeaseRef:lease,action:'revoke',requestId:'revoke',idempotencyKey:'revoke',expectedPairVersion:'1'},auth);
    void revoke.catch(()=>undefined);
    let queued=false;
    for(let attempt=0;attempt<100&&!queued;attempt++){
      queued=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT binding_id FROM apple_physical_canary_bindings%'")).rows.length>0;
    }
    release();
    assert.equal(queued,true,'binding revoke must be queued before source revalidation');
    assert.equal(await admitted,'admitted');
    assert.equal((await revoke).pairVersion,'2','binding revoke advances the canonical pair version');
    assert.deepEqual((await api.readFormal({realtimeSessionRef:session,iphoneDeviceLeaseRef:lease},auth)).pairState,
      {pairVersion:'2',status:'revoked',requiresRebind:true});
    await assert.rejects(api.resolveCredential(fresh.token as string),/credential_revoked/);
    assert.deepEqual(await owner().credential(issue,auth),{status:'failed',reason:'pair_version_conflict'},'successful issue replay revalidates the current binding version');
    assert.deepEqual(await owner().credential(refresh,auth),{status:'failed',reason:'pair_version_conflict'},'successful refresh replay revalidates the current binding version');
    await assert.rejects(phoneOwner.verifyRunController(phone,audioD,source.route_version),/watch_unregistered/);
    await assert.rejects(sourceOwner.withVoiceAction(source,'data',async()=>assert.fail('revoked admission')),/credential_invalid|credential_revoked/);
    assert.deepEqual(await api.credential({...issue,action:'refresh',requestId:randomUUID()},auth),{status:'failed',reason:'pair_version_conflict'});
    await assert.rejects(withTransaction(pool,c=>api.readWatchInAdmission(c,user,device,binding.watch.deviceId)),/watch_unregistered/);
    const replaced=await api.mutateFormal({...base,action:'register',requestId:'new',idempotencyKey:'new',expectedPairVersion:'2'},auth);
    assert.equal(replaced.pairVersion,'3','register after revoke advances the canonical pair version');
    await assertCurrentScope('3',replaced.watch.deviceId);
    assert.deepEqual(await owner().credential(failedCAS,auth),{status:'failed',reason:'pair_version_conflict'});
    const next={...issue,watchDeviceId:replaced.watch.deviceId,installationId:replaced.installationId,expectedPairVersion:'3',requestId:randomUUID()};
    const nextIssued=await api.credential(next,auth);
    assert.equal(nextIssued.pair_version,'3');assert.equal(nextIssued.watch_device_id,replaced.watch.deviceId);
    await assertCurrentScope('3',replaced.watch.deviceId);
    const nextToken=nextIssued.token as string;
    const revokeRequest={...next,action:'revoke' as const,requestId:randomUUID()},revoked=await api.credential(revokeRequest,auth);
    await assert.rejects(api.resolveCredential(nextToken),/credential_revoked/);
    const afterRevoke=await api.credential({...next,requestId:randomUUID()},auth);
    assert.deepEqual(await owner().credential(revokeRequest,auth),revoked);
    await api.resolveCredential(afterRevoke.token as string); // Replaying the old revoke does not revoke a newer issue.
    assert.equal((await api.read(replaced.bindingId))?.status,'active');
    await assertCurrentScope('3',replaced.watch.deviceId); // Credential-only revoke does not advance binding scope.
    const replacement=await api.mutateFormal({...base,action:'replace',requestId:'replace',idempotencyKey:'replace',expectedPairVersion:'3'},auth);
    assert.equal(replacement.pairVersion,'4','replace advances the canonical pair version');
    assert.notEqual(replacement.watch.deviceId,replaced.watch.deviceId);
    const replacementRequest={...next,requestId:randomUUID(),watchDeviceId:replacement.watch.deviceId,installationId:replacement.installationId,expectedPairVersion:'4'};
    const replacementIssued=await api.credential(replacementRequest,auth);
    const replacementRefreshed=await api.credential({...replacementRequest,action:'refresh',requestId:randomUUID()},auth);
    assert.equal(replacementIssued.pair_version,'4');assert.equal(replacementRefreshed.pair_version,'4');
    assert.equal(replacementIssued.watch_device_id,replacement.watch.deviceId);assert.equal(replacementRefreshed.watch_device_id,replacement.watch.deviceId);
    assert.ok(replacementRefreshed.token!==replacementIssued.token);
    await assertCurrentScope('4',replacement.watch.deviceId);
    const active=replacementRefreshed.token as string;
    await pool.query("UPDATE paired_devices SET status='revoked',revoked_at=now() WHERE device_id=$1",[device]);
    await assert.rejects(api.resolveCredential(active),/watch_scope_denied/);
    await assert.rejects(owner().credential(replacementRequest,auth),/watch_scope_denied/,'successful replay revalidates current parent authority');
    const ledger=(await pool.query('SELECT row_to_json(ledger)::text AS value FROM idempotency_ledger ledger')).rows;
    assert.ok(ledger.length>0);
    const bearerPattern=/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;
    for(const row of ledger)assert.ok(!bearerPattern.test(row.value),'no ledger row contains a plaintext bearer token');
    const stored=(await pool.query("SELECT response FROM idempotency_ledger WHERE scope='apple.watch.credential' AND idempotency_key=$1",[user+':'+issue.requestId])).rows[0]!.response;
    assert.deepEqual(stored,issuedOutcome,'only the original non-secret credential outcome is durable');
    assert.ok(!bearerPattern.test(JSON.stringify(logs)),'no captured log contains a plaintext bearer token');
  }finally{await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}
});
