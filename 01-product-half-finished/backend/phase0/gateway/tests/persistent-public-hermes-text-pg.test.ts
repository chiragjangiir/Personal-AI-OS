import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import test from 'node:test';
import { canonical } from '../../../services/personal-aios-integration/src/contracts.ts';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DataPacketKind, RoomEvent } from '@livekit/rtc-node';
import { PosixStorage } from '../../../services/personal-aios-integration/src/storage.ts';
import { L3Service } from '../../../services/personal-aios-integration/src/memory/l3.ts';
import type { NativeClient, NativeRun } from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type { LiveKitCloudParticipantPort } from '../src/livekit-cloud-participant.ts';
import { createPersistentPublicExecutionOwner } from '../src/persistent-public-execution-owner.ts';
import { FORMAL_TEXT_INPUT_TOPIC, FORMAL_TEXT_OUTPUT_TOPIC } from '../src/personal-aios-formal-text.ts';
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
test('production execution assembly: PG/T03 same central HTTP/runtime directed OUT/ACK and no legacy', {skip:databaseUrl===undefined}, async()=>{
  const parsed=new URL(databaseUrl!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const admin=connect(databaseUrl!),name='formal_public_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
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
    const input={request:{requested_media:{data:true,audio:false,video:false},device_id:device,start:{kind:'explicit_user_start',modalities:['data'],device_id:device,started_at:at}},bearer:{principal,deviceId:device,capabilityRef:capability,scopes:operations},governance:wireGovernance(governance),authority:{},
      currentBinding:{realtimeSessionRef:started.realtimeSessionRef,deviceLeaseRef:started.deviceLeaseRef,continuityId:started.continuityId,connectionEpoch:started.connectionEpoch,credentialIdentity:'actual-terminal',credentialRoom:'fixture-room'},
      enabledMedia:{data:true,audio:false,video:false}} as unknown as RealtimeBootstrapConnectedInput;
    const resolver=createAppleCyclingTypedSourceResolver({t03,producer:{device_id:device,device_type:'phone',channel:'rtc_typed_text'},now:()=>now});
    const sourceAuthority=new FormalSourceAuthority({ownerContext:t03.ownerContext,readCurrentBinding:lookup=>service.readCurrentBinding(lookup),
      sameRef:(a,b)=>equality.same(a as never,b as never),resolveSource:resolver,now:()=>now});
    const source=await sourceAuthority.authenticate(sourceAuthority.credentialForBootstrap(input));
    assert.equal(source.principal_id,user);assert.equal(source.device_id,device);assert.equal(source.device_type,'phone');
    assert.equal(source.consent_ref,governance.consent_record_refs[0]!.ref_id);assert.equal('token_sha256' in source,false);
    const fixtureBase=join(process.cwd(),'../../../../.task-output');await mkdir(fixtureBase,{recursive:true});
    const root=await mkdtemp(join(fixtureBase,'paios-central-assembly-'));
    const listeners=new Map<string,(...args:readonly unknown[])=>void>(), publications:{body:any;options:any}[]=[], errors:unknown[]=[];
    const room={isConnected:true,remoteParticipants:new Map([['actual-terminal',{identity:'actual-terminal',trackPublications:new Map()}]]),on:(name:string,fn:(...args:readonly unknown[])=>void)=>listeners.set(name,fn),off:(name:string)=>listeners.delete(name),
      localParticipant:{publishData:async(bytes:Uint8Array,options:unknown)=>{publications.push({body:JSON.parse(Buffer.from(bytes).toString()),options});},
        // Formal text sends `ready` as a text stream (lk-2); record it like a data packet.
        sendText:async(text:string,options:unknown)=>{publications.push({body:JSON.parse(text),options});}}};
    let legacyBuilds=0,creates=0,pausedStatusEntered=false;let pauseStatus:Promise<void>|undefined;const runs=new Map<string,NativeRun>();
    const native:NativeClient={create:async body=>{creates++;const run={run_id:'assembly-run-'+creates,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return run;},status:async id=>{if(pauseStatus){pausedStatusEntered=true;await pauseStatus;}return {...runs.get(id)!};},cancel:async id=>({...runs.get(id)!,status:'cancelled'})};
    const owned=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',t03,readCurrentBinding:lookup=>service.readCurrentBinding(lookup),
      deviceId:device,participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,now:()=>now,
      onError:error=>errors.push(error),central:{
        storage:new PosixStorage(root),native:sourceClient(native),admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'assembly-fixture'},
        skill:'source-owned hermes text',max_event_bytes:8192,max_read_bytes:8192,l3:new L3Service(pool),
        http:{internal_token:'isolated-internal-provider-token-20261001',max_request_bytes:8192,request_timeout_ms:10000}}});
    if(owned.executionOwner!=='hermes_text')throw new Error('BAD_MODE');const {runtime,server}=owned.assembly;
    const eventually=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('ASSEMBLY_TIMEOUT');};
    try {
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
      const tool=async(name:string,args:unknown,toolID:string)=>{const response=await fetch(`http://127.0.0.1:${port}/internal/hermes/tools/${name}`,{method:'POST',headers:{Authorization:'Bearer isolated-internal-provider-token-20261001','Content-Type':'application/json'},
        body:JSON.stringify({context:{run_id:'assembly-run-1',session_id:started.continuityId,tool_call_id:toolID},args})});return {status:response.status,body:await response.json() as any};};
      assert.throws(()=>owned.bridge.assertBootstrapRequest!({...input.request,requested_media:{data:true,audio:true,video:false}}),/TEXT_ONLY_DATA/);
      assert.throws(()=>owned.bridge.assertBootstrapRequest!({...input.request,start:{...(input.request.start as Record<string,unknown>),modalities:['data','audio']}}),/TEXT_ONLY_DATA/);
      assert.equal(creates,0);owned.bridge.assertBootstrapRequest!(input.request);await owned.bridge.onBootstrapConnected!(input);
      const send=(body:unknown)=>listeners.get(RoomEvent.DataReceived)!(Buffer.from(JSON.stringify(body)),{identity:'actual-terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
      const text='  exact production source fixture 原文\r\n';send({operation:'submit',event_id:'assembly-event',captured_at:at,text});await eventually(()=>creates===1 && publications.some(packet=>packet.body.operation==='accepted'&&packet.body.admission.run_id==='assembly-run-1'));
      const dID=publications.find(packet=>packet.body.operation==='accepted'&&packet.body.admission.run_id==='assembly-run-1')!.body.processed_event_id,actualSource=await runtime.authenticate(owned.authority.credentialForBootstrap(input));
      const d=(await runtime.event(actualSource,started.continuityId,dID)).processed_event;
      assert.equal(d.principal_id,user);assert.equal(d.device_id,device);assert.equal(d.origin,'explicit_user_prompt');
      const read=await tool('paios_l5_read',{},'read');assert.equal(read.status,200);assert.equal(read.body.content,text);
      const memory=await tool('paios_l3_query',{},'memory');assert.equal(memory.status,200);
      const open=await tool('paios_open_reply',{reply_mode:'text',target_aliases:['source'],output_modes:['text'],receipt_refs:[],evidence_refs:[]},'open');assert.equal(open.status,200);assert.equal(open.body.status,'opened');
      runs.get('assembly-run-1')!.output='sealed same runtime output';runs.get('assembly-run-1')!.status='completed';
      // Existing admission terminal owner publishes the first result; no client result request.
      await eventually(()=>publications.some(packet=>packet.body.operation==='text_chunk'));
      const header=publications.find(packet=>packet.body.operation==='result_header')!.body,textPacket=publications.find(packet=>packet.body.operation==='text_chunk')!,chunk=textPacket.body.chunk;assert.equal(header.delivery_status,'unknown');assert.equal(chunk.text,'sealed same runtime output');
      assert.deepEqual(textPacket.options,{reliable:true,destination_identities:['actual-terminal'],topic:FORMAL_TEXT_OUTPUT_TOPIC});
      send({operation:'ack',processed_event_id:dID,ack:{output_id:chunk.output_id,reply_id:chunk.reply_id,reply_epoch:chunk.reply_epoch,target_device_id:device,route_version:chunk.route_version,highest_contiguous_seq:1,status:'rendered',observed_at:at}});await eventually(()=>publications.some(packet=>packet.body.operation==='ack_receipt'));
      assert.equal(publications.filter(packet=>packet.body.operation==='ack_receipt').length,1);assert.equal(legacyBuilds,0);assert.equal(creates,1);assert.deepEqual(errors,[]);
      assert.equal((await readdir(root)).some(name=>/conversation|remember|history/.test(name)),false);assert.ok(runtime.toolSchemas().some(schema=>schema.name==='paios_l3_query'));
      const beforeClosePublications=publications.length;let releaseStatus!:()=>void;pauseStatus=new Promise<void>(resolve=>{releaseStatus=resolve;});
      send({operation:'result',processed_event_id:dID});await eventually(()=>pausedStatusEntered);
      let closed=false;const closeFlight=Promise.resolve(owned.bridge.close!()).then(()=>{closed=true;});
      try {await new Promise(resolve=>setTimeout(resolve,15));assert.equal(closed,false);}
      finally {releaseStatus();await closeFlight;}
      assert.equal(publications.length,beforeClosePublications);assert.equal(listeners.has(RoomEvent.DataReceived),false);await owned.bridge.close!();

    } finally {await owned.bridge.close!();await rm(root,{recursive:true,force:true});}
    const forged={...input,bearer:{...input.bearer,principal:{opaque_ref:'forged'}}};
    await assert.rejects(sourceAuthority.authenticate(sourceAuthority.credentialForBootstrap(forged)),/AUTHORITY_DENIED/);
    await pool.query('UPDATE device_leases SET lease_version=lease_version+1,fencing_token=fencing_token+1 WHERE lease_ref_id=$1',[(started.deviceLeaseRef as any).ref_id]);
    const renewed=await sourceAuthority.revalidate(source);assert.equal(renewed.route_version,source.route_version);
    await pool.query('UPDATE realtime_sessions SET connection_epoch=connection_epoch+1 WHERE session_ref_id=$1',[(started.realtimeSessionRef as any).ref_id]);
    await assert.rejects(sourceAuthority.revalidate(source),/OWNER_BINDING_DENIED|AUTHORITY_CONFLICT/);
    console.log(JSON.stringify({canonical_user_id:user,canonical_device_id:device,consent_ref:source.consent_ref,initial_route:source.route_version,renewed_route:renewed.route_version,renewal_source:'direct-isolated-DB-version-fence-change',epoch_negative:'direct-isolated-DB-mutation',evidence:'formal-source-pg',database:name,actual_user_owner:true,opaque_principal_not_identity:true,consent_source:'T03',family_scope:'fixture-owned-phone',route_source:'typed-resolver-v2:T02-stable-binding+producer+T03-principal',pg_bootstrap:true}));
  } finally {await t03.close();await pool.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});

test('paired public gateway bootstraps phone and glasses into one Hermes owner with directed replies and single outreach', {skip:databaseUrl===undefined}, async()=>{
  const {Room}=await import('@livekit/rtc-node');
  const {createServer,request}=await import('node:http');
  const {generateKeyPairSync}=await import('node:crypto');
  const {pairDevice,revokePairedDevice}=await import('../src/paired-device-registration.ts');
  const {makeMacProductResourceFixture}=await import('./mac-product-resource-fixture.ts');
  const {createConfiguredProductResources,createPersistentPublicControlOwnerHandoff,createRayneoPersistentPublicControl}=await import('../src/rayneo-persistent-production-entrypoint.ts');
  const parsed=new URL(databaseUrl!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const admin=connect(databaseUrl!),name='paired_public_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  parsed.pathname='/'+name;const pool=connect(parsed.href);
  const base=join(process.cwd(),'../../../../.task-output');await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'paired-public-')),resourceFixture=makeMacProductResourceFixture(join(root,'resources'));
  const rooms:{room:InstanceType<typeof Room>;url:string;publications:{body:any;options:any}[]}[]=[],runs=new Map<string,NativeRun>(),nativeInputs:any[]=[];
  const originalConnect=Room.prototype.connect,originalDisconnect=Room.prototype.disconnect;
  // Replace only external SDK transport. The gateway participant, authority, source, runtime and output stay real.
  Room.prototype.connect=async function(url:string){
    const publications:{body:any;options:any}[]=[];rooms.push({room:this,url,publications});
    Object.defineProperty(this,'isConnected',{value:true,writable:true,configurable:true});
    this.localParticipant={trackPublications:new Map(),unpublishTrack:async()=>{},
      publishData:async(bytes:Uint8Array,options:unknown)=>{publications.push({body:JSON.parse(Buffer.from(bytes).toString()),options});},
      sendText:async(text:string,options:unknown)=>{publications.push({body:JSON.parse(text),options});}} as never;
  };
  Room.prototype.disconnect=async function(){Object.defineProperty(this,'isConnected',{value:false,writable:true,configurable:true});this.emit(RoomEvent.Disconnected,undefined as never);};
  let owner:Awaited<ReturnType<typeof createPersistentPublicControlOwnerHandoff>>|undefined;
  let control:Awaited<ReturnType<typeof createRayneoPersistentPublicControl>>|undefined;
  let server:ReturnType<typeof createServer>|undefined;
  const errors:unknown[]=[],storage=new PosixStorage(join(root,'central'));
  const eventually=async(predicate:()=>boolean|Promise<boolean>)=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('PAIRED_PUBLIC_TIMEOUT');};
  try {
    const migrations=new URL('../../../migrations/',import.meta.url);
    for(const file of (await readdir(migrations)).filter(file=>file.endsWith('.up.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
    const at=assertCanonicalTimestamp(new Date().toISOString()),identity=createProductionRealtimeIdentityPort({clock:{now:()=>at}});
    const register=async(device_type:'phone'|'glasses',ownerUserId?:string)=>{
      const raw=generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32);
      return pairDevice({pool,identity,registration:Buffer.from(JSON.stringify({device_type,capabilities:['display','speaker','chat_ui'],
        public_raw32_base64url:raw.toString('base64url'),public_sha256:createHash('sha256').update(raw).digest('hex')})),
        ...(ownerUserId?{ownerUserId}:{}),origin:'https://ai.example.invalid'});
    };
    const phone=await register('phone');
    const resources=createConfiguredProductResources({...resourceFixture.config,livekit_api_url:'http://127.0.0.1:7880',postgres:{...resourceFixture.config.postgres,database:name}});
    const native=sourceClient({create:async body=>{nativeInputs.push(JSON.parse(body.input));const run={run_id:`paired-run-${runs.size+1}`,session_id:body.session_id,
      conversation_session_id:body.session_id,status:'running'};runs.set(run.run_id,run);return {...run};},
      status:async(id:string)=>({...runs.get(id)!}),cancel:async(id:string)=>({...runs.get(id)!,status:'cancelled'})});
    owner=await createPersistentPublicControlOwnerHandoff({executionOwner:'hermes_text',pool,identity,postgresPassword:resources.postgresPassword,
      postgresReadiness:{owner:'isolated-test-postgres',environment:'production',isReady:()=>true},livekit:resources.livekit,
      ownerProtection:resources.ownerProtection,secretFileReader:resources.secretFileReader,policy:resources.policy,productResources:resources,
      inputReadiness:{owner:'paired-public-test-source',isReady:()=>true},central:{storage,native,skill:'fixed',max_event_bytes:8192,max_read_bytes:8192,
        admission:{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'paired-public'},
        http:{internal_token:'paired-public-controlled-token',max_request_bytes:16384,request_timeout_ms:5000}}});
    control=await createRayneoPersistentPublicControl(owner);
    server=createServer((req,res)=>{void control!.controller.handle(req,res).catch(error=>{errors.push(error);res.destroy();});});
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
    const requestTemplate=JSON.parse(await readFile(new URL('../../../tests/contracts/fixtures/realtime-public-control/bootstrap-request.valid.json',import.meta.url),'utf8'));
    const bootstrap=async(pair:typeof phone)=>{
      const requestId=`bootstrap-${pair.device_id}`,body={...requestTemplate,request_id:requestId,device_id:pair.device_id,
        start:{kind:'explicit_user_start',device_id:pair.device_id,modalities:['data'],started_at:new Date().toISOString()},
        requested_media:{audio:false,video:false,data:true},governance:pair.governance,
        idempotency_context:{...requestTemplate.idempotency_context,idempotency_key:requestId,
          idempotency_scope:{...requestTemplate.idempotency_context.idempotency_scope,user_id:pair.user_id}}};
      const bytes=Buffer.from(JSON.stringify(body));
      const answer=await new Promise<any>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/v1/realtime/bootstrap',method:'POST',agent:false,
        headers:{Host:'ai.example.invalid',Authorization:`Bearer ${pair.token}`,'Content-Type':'application/json','Content-Length':bytes.length,
          'X-Forwarded-For':'192.0.2.1','X-Forwarded-Host':'ai.example.invalid','X-Forwarded-Proto':'https',
          'X-PAIOS-Trusted-Edge':'tencent-nginx-loopback-v1','X-PAIOS-Trusted-Source-Family':'ipv4',
          'X-PAIOS-Proxy-Attestation':Buffer.alloc(32,3).toString('base64url')}},res=>{const chunks:Buffer[]=[];res.on('data',data=>chunks.push(Buffer.from(data)));
          res.on('end',()=>{const answer=JSON.parse(Buffer.concat(chunks).toString());try{assert.equal(res.statusCode,200,JSON.stringify(answer));resolve({...answer,identity:JSON.parse(Buffer.from(answer.livekit.participant_token.split('.')[1],'base64url').toString()).sub});}catch(error){reject(error);}});});
        req.removeHeader('Connection');req.on('error',reject);req.end(bytes);});
      const connected=rooms.at(-1)!,peer={identity:answer.identity,trackPublications:new Map()};
      connected.room.remoteParticipants.set(answer.identity,peer as never);
      connected.room.emit(RoomEvent.ParticipantConnected,peer as never);
      await eventually(()=>connected.publications.some(packet=>packet.body.operation==='ready'));
      return answer;
    };
    const enrollment=owner.composition.glassesEnrollment!,qr=await enrollment.issue(phone.token);
    const raw=generateKeyPairSync('x25519').publicKey.export({format:'der',type:'spki'}).subarray(-32);
    const registration={device_type:'glasses',capabilities:['display','speaker','chat_ui'],public_raw32_base64url:raw.toString('base64url'),public_sha256:createHash('sha256').update(raw).digest('hex')};
    const glasses=await enrollment.exchange(qr.token,registration);
    await assert.rejects(enrollment.exchange(qr.token,registration),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
    assert.deepEqual(await enrollment.exchange((await enrollment.issue(phone.token)).token,registration),glasses,'recovered output reuses the running terminal');
    const phoneBoot=await bootstrap(phone),glassBoot=await bootstrap(glasses);
    assert.equal(rooms.length,2);assert.deepEqual(rooms.map(room=>room.url),['ws://127.0.0.1:7880','ws://127.0.0.1:7880']);
    assert.equal(phoneBoot.central_text_transport.voice_transport,undefined);assert.equal(glassBoot.central_text_transport.voice_transport,undefined);
    assert.notEqual(phoneBoot.continuity_id,glassBoot.continuity_id);assert.notEqual(owner.participantForDevice!(phone.device_id),owner.participantForDevice!(glasses.device_id));
    assert.equal(owner.participantForDevice!(phone.device_id)!.snapshot().connected,true);
    assert.equal(owner.participantForDevice!(glasses.device_id)!.snapshot().connected,true);
    const send=(index:number,boot:any,text:string)=>rooms[index]!.room.emit(RoomEvent.DataReceived,
      Buffer.from(JSON.stringify({operation:'submit',event_id:`event-${index}`,captured_at:new Date().toISOString(),text})),
      {identity:boot.identity} as never,DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);
    send(1,glassBoot,'只回答眼镜');await eventually(()=>runs.size===1);
    await eventually(()=>rooms[1]!.publications.some(packet=>packet.body.operation==='accepted'&&packet.body.admission.run_id));
    const accepted=rooms[1]!.publications.find(packet=>packet.body.operation==='accepted'&&packet.body.admission.run_id)!.body;
    const runtime=owner.centralTextAssembly!.runtime;
    await eventually(async()=>(await runtime.tool('paios_open_reply',{context:{run_id:'paired-run-1',session_id:glassBoot.continuity_id,tool_call_id:'reply'},args:{reply_mode:'text'}}) as {status:string}).status==='opened');
    send(0,phoneBoot,'手机输入');await eventually(()=>runs.size===2);
    assert.deepEqual(nativeInputs.map(input=>[input.principal_id,input.device_id,input.device_type]),[[phone.user_id,glasses.device_id,'glasses'],[phone.user_id,phone.device_id,'phone']]);
    await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:phone.user_id,device_id:glasses.device_id,id:'paired-care',text:'当前手机提醒'});
    assert.equal(rooms[0]!.publications.filter(packet=>packet.body.operation==='ambient_reply'&&packet.body.text==='当前手机提醒').length,1);
    assert.equal(rooms[1]!.publications.filter(packet=>packet.body.operation==='ambient_reply').length,0);
    Object.assign(runs.get('paired-run-1')!,{status:'completed',output:'只回答眼镜'});
    await eventually(()=>rooms[1]!.publications.some(packet=>packet.body.operation==='text_chunk'&&packet.body.chunk.final));
    const reply=rooms[1]!.publications.find(packet=>packet.body.operation==='text_chunk')!;
    assert.equal(reply.body.chunk.target_device_id,glasses.device_id);assert.equal(reply.body.processed_event_id,accepted.processed_event_id);
    assert.deepEqual(reply.options.destination_identities,[glassBoot.identity]);
    assert.equal(rooms[0]!.publications.some(packet=>packet.body.operation==='text_chunk'),false);
    const e2eeFixture=JSON.parse(await readFile(new URL('../../../tests/contracts/fixtures/realtime-public-control/e2ee-key-resolve.valid.json',import.meta.url),'utf8'));
    const e2eeRequest={operation:'realtime_e2ee_key_resolve',request_id:'revoked-glass-key',
      idempotency_context:{...e2eeFixture.idempotency_context,idempotency_key:'revoked-glass-key',
        idempotency_scope:{...e2eeFixture.idempotency_context.idempotency_scope,user_id:glasses.user_id}},
      realtime_session_ref:glassBoot.realtime_session_ref,device_lease_ref:glassBoot.device_lease_ref,
      continuity_id:glassBoot.continuity_id,connection_epoch:glassBoot.connection_epoch,transport_aliases:glassBoot.transport_aliases,
      key_envelope_ref:glassBoot.e2ee_key_envelope.key_envelope_ref,key_index:glassBoot.e2ee_key_envelope.key_index,
      key_generation:glassBoot.e2ee_key_envelope.key_generation,device_id:glasses.device_id,
      recipient_device_credential_ref:glassBoot.recipient_device_credential_ref,
      participant_audience:glassBoot.transport_aliases.find((alias:any)=>alias.alias_type==='participant'),governance:glasses.governance};
    const glassBearer=await owner.persistentPublicPorts!.bearer.authorize({token:glasses.token,operation:'realtime_e2ee_key_resolve',request:e2eeRequest});
    await revokePairedDevice({pool,deviceId:glasses.device_id,ownerUserId:phone.user_id});
    await eventually(()=>!owner!.participantForDevice!(glasses.device_id)!.snapshot().connected);
    assert.equal(owner.participantForDevice!(phone.device_id)!.snapshot().connected,true);
    const beforeRevoked=rooms[1]!.publications.length;
    await runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id:phone.user_id,device_id:glasses.device_id,id:'revoked-glass-care',text:'撤销眼镜后的手机提醒'});
    assert.equal(owner.participantForDevice!(glasses.device_id)!.snapshot().connected,false);
    assert.equal(owner.participantForDevice!(phone.device_id)!.snapshot().connected,true);
    assert.equal(rooms[1]!.publications.length,beforeRevoked);
    assert.equal(rooms[0]!.publications.filter(packet=>packet.body.operation==='ambient_reply'&&packet.body.text==='撤销眼镜后的手机提醒').length,1);
    await assert.rejects(owner.persistentPublicPorts!.bearer.authorize({token:glasses.token,operation:'bootstrap',request:{device_id:glasses.device_id}}),/CONTROL_CAPABILITY_INVALID/);
    await assert.rejects(owner.composition.e2eeCiphertext.resolve({request:JSON.parse(JSON.stringify(e2eeRequest)),bearer:glassBearer,governance:glasses.governance}),/PAIRED_DEVICE_REVOKED/);
    assert.deepEqual(errors,[]);await control.close();control=undefined;
    assert.equal(owner.participantForDevice!(phone.device_id)!.snapshot().connected,false);
    assert.equal(owner.participantForDevice!(glasses.device_id)!.snapshot().connected,false);
  } finally {
    await control?.close();await owner?.centralTextAssembly?.close();
    if(server)await new Promise<void>(resolve=>{server!.close(()=>resolve());server!.closeAllConnections();});
    Room.prototype.connect=originalConnect;Room.prototype.disconnect=originalDisconnect;
    resourceFixture.cleanup();await rm(root,{recursive:true,force:true});await pool.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();
  }
});
