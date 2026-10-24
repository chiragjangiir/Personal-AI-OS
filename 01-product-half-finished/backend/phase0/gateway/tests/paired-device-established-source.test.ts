import { createHash } from 'node:crypto';
import { pairDevice, parseDeviceRegistration, revokePairedDevice, createGlassesEnrollment } from '../src/paired-device-registration.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalCapabilities, MAC_CAPABILITIES, PHONE_CAPABILITIES, GLASSES_CAPABILITIES, WATCH_CAPABILITIES, hasTerminalCapability } from '../../../services/personal-aios-integration/src/source-authority.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairedTerminalAuthorities, createPairedDeviceAuthority } from '../src/paired-device-authority.ts';
import { FormalSourceAuthority, FormalTerminalSources, createAppleCyclingTypedSourceResolver } from '../src/personal-aios-formal-source.ts';
import { canonical } from '../../../services/personal-aios-integration/src/contracts.ts';
import type { RealtimeBootstrapConnectedInput } from '../src/realtime-public-control-runtime.ts';
import type { RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';

const DEVICE = '0190f0f0-0000-7000-8000-000000000001', USER = '0190f0f0-0000-7000-8000-000000000002';
const T0 = Date.parse('2026-10-09T10:00:00.000Z'), MIN = 60_000;
const ref = (id: string) => [{ref_id: id}];
const pool = {query: async () => ({rows: [{device_id: DEVICE, user_id: USER, recipient_public_key: 'pk', device_credential_ref: {},
  media: ['audio', 'data', 'video'], paired_at: '2026-10-06T00:00:00.000Z', governance: {purpose_scopes: ['cycling_assistant'],
    consent_record_refs: ref('c'), policy_decision_refs: ref('p'), purpose_token_refs: ref('t'), capability_grant_refs: ref('g')}}]})};
const bootstrap = {operation: 'bootstrap' as const, request: {start: {started_at: new Date(T0).toISOString()}, requested_media: {audio: true, video: false, data: true}},
  bearer: {deviceId: DEVICE, principal: USER} as never, governance: {}};

test('start freshness gates only a new Start; an established source stays authorized by its live session and lease', async () => {
  let clock = T0 + 1_000;
  const authority = await createPairedDeviceAuthority({pool: pool as never, now: () => clock});
  const started = await authority.ownerContext.resolve(bootstrap);
  assert.equal(started.userId, USER, 'fresh Start admitted');
  assert.deepEqual(started.capabilities, ['audio', 'data'], 'the lease requests only enabled media, even when the paired phone allows video');
  assert.equal(authority.readCurrentAuthority().capabilities.includes('health'),true,'existing phone pairing retains health');
  assert.equal(authority.readCurrentAuthority().capabilities.includes('contacts'),true,'existing phone pairing retains contacts');

  clock = T0 + 10 * MIN + 1;
  await assert.rejects(authority.ownerContext.resolve(bootstrap), /PAIRED_DEVICE_START_TIME_INVALID/, 'a stale new Start is still refused');
  assert.equal((await authority.ownerContext.resolve({...bootstrap, phase: 'established'})).deviceId, DEVICE);
  await assert.rejects(authority.ownerContext.resolve({...bootstrap, phase: 'established', bearer: {deviceId: 'other', principal: USER} as never}),
    /PAIRED_DEVICE_BEARER_MISMATCH/, 'established reads still check the bearer');

  // The formal source itself, as the gateway wires it: the paired authority is its owner context.
  let leaseExpires = T0 + 24 * 60 * MIN;
  const binding = () => ({
    session: {realtimeSessionRef: 's', userId: USER, continuityId: 'c', state: 'active', continuityState: 'active', connectionEpoch: '1',
      continuityExpiresAt: new Date(T0 + 24 * 60 * MIN).toISOString(), activeDeviceId: DEVICE, activeDeviceLeaseRef: 'l',
      binding: {state: 'connected', realtimeSessionRef: 's', deviceLeaseRef: 'l', continuityId: 'c', deviceId: DEVICE, connectionEpoch: '1'}},
    lease: {deviceLeaseRef: 'l', realtimeSessionRef: 's', continuityId: 'c', userId: USER, deviceId: DEVICE, state: 'active',
      expiresAt: new Date(leaseExpires).toISOString(), purpose: 'cycling_assistant', policyDecisionRef: {ref_id: 'p'}, capabilities: ['data', 'audio']}}) as unknown as RealtimeCurrentBindingProjection;
  authority.bindCurrentBinding(async () => binding());
  const refreshed = await authority.ownerContext.resolve({operation: 'connected_credential_refresh',
    request: {continuity_id: 'c'}, bearer: bootstrap.bearer, governance: {}});
  assert.deepEqual(refreshed.capabilities, binding().lease.capabilities, 'refresh retains the granted lease subset');
  const source = new FormalSourceAuthority({ownerContext: authority.ownerContext, readCurrentBinding: async () => binding(),
    sameRef: (a, b) => canonical(a) === canonical(b), now: () => clock,
    resolveSource: async () => ({device_type: 'phone' as const, channel: 'rtc_typed_text', consent_ref: 'consent', route_version: 'r', output_modes: ['text']})});
  const input = {request: bootstrap.request, bearer: bootstrap.bearer, governance: {}, enabledMedia: {data: true, audio: true, video: false},
    currentBinding: {realtimeSessionRef: 's', deviceLeaseRef: 'l', continuityId: 'c', connectionEpoch: '1', credentialIdentity: 'phone'}} as unknown as RealtimeBootstrapConnectedInput;
  const credential = source.credentialForBootstrap(input);

  clock = T0 + 45 * MIN;
  assert.equal((await source.authenticate(credential)).principal_id, USER, '45 minutes in, typed input is still accepted');
  leaseExpires = T0 + 50 * MIN;
  clock = T0 + 50 * MIN + 1;
  await assert.rejects(source.authenticate(credential), /SOURCE_BINDING_INACTIVE/, 'an expired lease ends it');
  leaseExpires = T0 + 25 * 60 * MIN;
  assert.equal((await source.authenticate(credential)).device_id, DEVICE, 'an authority-renewed lease recovers the same live binding');
  clock = T0 + 24 * 60 * MIN;
  await assert.rejects(source.authenticate(credential), /SOURCE_BINDING_INACTIVE/, 'renewing a lease never revives expired continuity');
});

test('expired continuity recovers only through fresh host bootstrap; old epoch and revoked pairing remain denied',async()=>{
  let clock=T0,revoked=false;
  const authority=await createPairedDeviceAuthority({pool:{query:async()=>revoked?{rows:[]}:pool.query()} as never,now:()=>clock});
  const current={session:{realtimeSessionRef:'s',userId:USER,continuityId:'c',state:'active',continuityState:'active',connectionEpoch:'1',
    continuityExpiresAt:new Date(T0+24*60*MIN).toISOString(),activeDeviceId:DEVICE,activeDeviceLeaseRef:'l',
    binding:{state:'connected',realtimeSessionRef:'s',deviceLeaseRef:'l',continuityId:'c',deviceId:DEVICE,connectionEpoch:'1'}},
    lease:{deviceLeaseRef:'l',realtimeSessionRef:'s',continuityId:'c',userId:USER,deviceId:DEVICE,state:'active',
      expiresAt:new Date(T0+24*60*MIN).toISOString(),purpose:'cycling_assistant',policyDecisionRef:{ref_id:'p'},capabilities:['data','audio']}};
  const source=new FormalSourceAuthority({ownerContext:authority.ownerContext,readCurrentBinding:async()=>current as unknown as RealtimeCurrentBindingProjection,
    sameRef:(a,b)=>canonical(a)===canonical(b),now:()=>clock,
    resolveSource:async()=>({device_type:'phone',channel:'rtc_typed_text',consent_ref:'consent',route_version:'r',output_modes:['text']})});
  const input={request:bootstrap.request,bearer:bootstrap.bearer,governance:{},enabledMedia:{data:true,audio:true,video:false},
    currentBinding:{realtimeSessionRef:'s',deviceLeaseRef:'l',continuityId:'c',connectionEpoch:'1',credentialIdentity:'phone'}} as unknown as RealtimeBootstrapConnectedInput;
  const old=source.credentialForBootstrap(input);await source.authenticate(old);
  clock=T0+24*60*MIN+1;
  await assert.rejects(source.authenticate(old),/SOURCE_BINDING_INACTIVE/);
  // Simulate the existing T02 fresh bootstrap result, not a local extension of the expired credential.
  current.session.realtimeSessionRef=current.session.binding.realtimeSessionRef=current.lease.realtimeSessionRef='fresh-session';
  current.session.activeDeviceLeaseRef=current.session.binding.deviceLeaseRef=current.lease.deviceLeaseRef='fresh-lease';
  current.session.continuityId=current.session.binding.continuityId=current.lease.continuityId='fresh-continuity';
  current.session.continuityExpiresAt=current.lease.expiresAt=new Date(clock+24*60*MIN).toISOString();
  await assert.rejects(source.authenticate(old),/SOURCE_OWNER_BINDING_DENIED/);
  const fresh=source.credentialForBootstrap({...input,request:{...input.request,start:{started_at:new Date(clock).toISOString()}},
    currentBinding:{...input.currentBinding,realtimeSessionRef:'fresh-session' as never,deviceLeaseRef:'fresh-lease' as never,continuityId:'fresh-continuity'}});
  assert.equal((await source.authenticate(fresh)).device_id,DEVICE);
  current.session.connectionEpoch=current.session.binding.connectionEpoch='2';
  await assert.rejects(source.authenticate(fresh),/SOURCE_OWNER_BINDING_DENIED/);
  current.session.connectionEpoch=current.session.binding.connectionEpoch='1';revoked=true;
  await assert.rejects(source.authenticate(fresh),/PAIRED_DEVICE_REVOKED/);
});

test('cleanup stays the owner\'s right after the continuity ran out; new media and credentials do not', async () => {
  const clock = T0 + 30 * 60 * MIN; // past both the continuity deadline and the lease
  const authority = await createPairedDeviceAuthority({pool: pool as never, now: () => clock});
  let state = 'active';
  const binding = () => ({
    session: {realtimeSessionRef: {ref_id: 's'}, userId: USER, continuityId: 'c', state, continuityState: state, connectionEpoch: '1',
      continuityExpiresAt: new Date(T0 + 24 * 60 * MIN).toISOString(), activeDeviceId: DEVICE, activeDeviceLeaseRef: {ref_id: 'l'},
      binding: {state: 'connected', deviceId: DEVICE}},
    lease: {deviceLeaseRef: {ref_id: 'l'}, userId: USER, deviceId: DEVICE, state: 'active', expiresAt: new Date(T0 + 24 * 60 * MIN).toISOString(),
      purpose: 'cycling_assistant', policyDecisionRef: {ref_id: 'p'}, capabilities: ['data', 'audio']}}) as unknown as RealtimeCurrentBindingProjection;
  authority.bindCurrentBinding(async () => binding());
  const resolve = (operation: string) => authority.ownerContext.resolve({operation: operation as never, request: {realtime_session_ref: {ref_id: 's'}},
    bearer: bootstrap.bearer, governance: {}});
  assert.equal((await resolve('media_stop')).deviceId, DEVICE, 'a Stop pressed after the continuity expired still cleans up');
  assert.equal((await resolve('end_continuity')).deviceId, DEVICE);
  await assert.rejects(resolve('connected_credential_refresh'), /PAIRED_DEVICE_BINDING_INVALID/, 'no fresh credential for an expired continuity');
  await assert.rejects(resolve('handoff'), /PAIRED_DEVICE_BINDING_INVALID/);
  state = 'terminal';
  await assert.rejects(resolve('media_stop'), /PAIRED_DEVICE_BINDING_INVALID/, 'an ended or superseded session is not re-opened for cleanup');
});

test('I14 enrollment tokens are single-use, five-minute, class-bound and active-phone-bound; their bearer, E2EE recipient and declared capabilities stay separate', async t => {
  const rows:Record<string,unknown>[]=[];
  let grants:{token:string;phone:Record<string,unknown>;expires:string;deviceClass:string}[]=[], snapshot:{rows:typeof rows;grants:typeof grants};
  const directory=mkdtempSync(join(tmpdir(),'a2-enrollment-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let requireArtifact=false;
  const query=async(sql:string,args:unknown[]=[])=>{
    if(sql==='BEGIN') snapshot=structuredClone({rows,grants});
    if(sql==='ROLLBACK') {rows.splice(0,rows.length,...snapshot.rows);grants=snapshot.grants.map(grant=>({...grant,phone:rows.find(row=>row.device_id===grant.phone.device_id)!}));}
    if(sql==='COMMIT'&&requireArtifact&&rows.length>snapshot.rows.length){const row=rows.at(-1)!;assert.equal(JSON.parse(readFileSync(join(directory,`${row.device_class==='iphone'?'phone':row.device_class as string}-pairing.${row.device_id}.v1.json`),'utf8')).device_id,row.device_id,'primary artifact exists before COMMIT');}
    if(sql.startsWith('INSERT INTO terminal_enrollments')){const phone=rows.find(row=>row.token_sha256===args[1]&&row.status==='active'&&row.device_class==='iphone');
      if(!phone)return {rows:[]};grants=grants.filter(grant=>grant.phone!==phone||grant.deviceClass!==args[3]);grants.push({token:args[0] as string,phone,expires:args[2] as string,deviceClass:args[3] as string});return {rows:[{phone_device_id:phone.device_id}]};}
    if(sql.startsWith('SELECT p.user_id')){const grant=grants.find(grant=>grant.token===args[0]&&grant.deviceClass===args[2]&&grant.phone.status==='active'&&grant.expires>(args[1] as string));return {rows:grant?[{user_id:grant.phone.user_id,phone_device_id:grant.phone.device_id,expires_at:grant.expires}]:[]};}
    if(sql.startsWith('DELETE FROM terminal_enrollments')){grants=grants.filter(grant=>grant.token!==args[0]);return {rows:[]};}
    if(sql.includes('WHERE recipient_public_key_sha256 = $1'))return {rows:rows.filter(row=>row.status==='active'&&row.recipient_public_key_sha256===args[0])};
    if(sql.startsWith('SELECT user_id::text FROM paired_devices WHERE device_id'))return {rows:rows.filter(row=>row.device_id===args[0]&&row.status==='active'&&row.device_class==='iphone')};
    if(sql.startsWith('SELECT user_id')) return {rows:rows.length?[{user_id:rows[0]!.user_id}]:[]};
    if(sql.startsWith('WITH revoked AS')){
      const selected=rows.filter(row=>row.device_id===args[0]&&row.user_id===args[1]);for(const row of selected)row.status='revoked';return {rows:selected};
    }
    if(sql.startsWith('UPDATE paired_devices SET governance')){const row=rows.find(row=>row.device_id===args[0])!;(row.governance as Record<string,unknown>).pairing_exchange_receipts=JSON.parse(String(args[1]));return {rows:[]};}
    if(sql.startsWith('UPDATE paired_devices')) {const revoked=rows.filter(row=>row.status==='active'&&row.user_id===args[0]&&
      (row.recipient_public_key_sha256===args[2]||args[3]==='iphone'&&row.device_class==='iphone'));for(const row of revoked)row.status='revoked';return {rows:revoked};}
    if(sql.startsWith('INSERT INTO paired_devices')) {rows.push({device_id:args[0],user_id:args[1],token_sha256:args[2],recipient_public_key:args[3],
      recipient_public_key_sha256:args[4],device_credential_ref:JSON.parse(args[5] as string),media:args[6],governance:JSON.parse(args[7] as string),
      paired_at:args[8],device_class:args[9],label:args[10],status:'active'});return {rows:[]};}
    if(sql.includes('WHERE device_id = $1'))return {rows:rows.filter(row=>row.status==='active'&&row.device_id===args[0])};
    if(sql.includes('token_sha256 ='))return {rows:rows.filter(row=>row.status==='active'&&row.token_sha256===args[0])};
    if(sql.includes('FROM paired_devices'))return {rows:rows.filter(row=>row.status==='active')};
    return {rows:[]};
  };
  const db={query,connect:async()=>({query,release(){},on(){},removeListener(){}})};
  let sequence=0;const identity={createConnectionId:()=>`id-${++sequence}`};
  const registration=(fill:number,device_type?:string,capabilities?:string[])=>{
    const bytes=Buffer.alloc(32,fill);return Buffer.from(JSON.stringify({public_raw32_base64url:bytes.toString('base64url'),
      public_sha256:createHash('sha256').update(bytes).digest('hex'),...(device_type?{device_type}:{}),...(capabilities?{capabilities}:{})}));
  };
  const phone=await pairDevice({pool:db as never,identity,ownerUserId:USER,registration:registration(1),origin:'https://api.example:9443',now:()=>T0});
  const glasses=await pairDevice({origin:'https://api.example:9443',pool:db as never,identity,ownerUserId:USER,registration:registration(2,'glasses',[...GLASSES_CAPABILITIES,'local_wake']),now:()=>T0+1});
  assert.equal(rows.filter(row=>row.status==='active').length,2);
  assert.deepEqual(Object.keys(phone).sort(),['schema','origin','device_id','user_id','token','governance','media','paired_at'].sort(),'the installed iPhone importer accepts exactly this closed contract');
  assert.equal(phone.origin,'https://api.example:9443');
  assert.deepEqual(terminalCapabilities({device_type:'watch'}),WATCH_CAPABILITIES);
  assert.equal(terminalCapabilities({device_type:'phone'}).includes('owner_unlock'),true);
  for(const type of ['glasses','watch'])assert.throws(()=>terminalCapabilities({device_type:type,capabilities:['owner_unlock']}),/TERMINAL_CAPABILITY_DENIED/);
  assert.equal(phone.user_id,glasses.user_id);assert.notEqual(phone.device_id,glasses.device_id);
  assert.deepEqual(glasses.media,['data','audio','video']);assert.equal(glasses.capabilities!.includes('location'),false);
  assert.throws(()=>parseDeviceRegistration(registration(3,'glasses',['contacts'])),/CAPABILITY_DENIED/);
  assert.throws(()=>parseDeviceRegistration(registration(3,'glasses',['unknown'])),/INVALID_TERMINAL_CAPABILITIES/);
  await assert.rejects(pairDevice({pool:db as never,identity,registration:registration(3),origin:'http://api.example'}),/DEVICE_PAIRING_ORIGIN_INVALID/);
  await assert.rejects(pairDevice({pool:db as never,identity,registration:registration(3),origin:'https://api.example/path'}),/INVALID_LIVEKIT_CLOUD_URL/);
  const devices=await createPairedTerminalAuthorities({pool:db as never,now:()=>T0+2});
  const phoneOwner=devices.forDevice(phone.device_id),glassesOwner=devices.forDevice(glasses.device_id);
  await assert.rejects(glassesOwner.place.credential(glasses.token,{device_id:glasses.device_id,action:'issue'}),/PLACE_CREDENTIAL_DENIED/);
  const bearer=await devices.bearer.resolve({tokenSha256:createHash('sha256').update(glasses.token).digest('hex'),operation:'bootstrap'});
  assert.equal(bearer?.deviceId,glasses.device_id);
  const key=await devices.recipientCredential.port.resolve!({deviceId:glasses.device_id,credentialRef:rows[1]!.device_credential_ref} as never);
  assert.equal(Buffer.from(key!.publicKey as Uint8Array).toString('base64url'),rows[1]!.recipient_public_key);
  assert.equal(await phoneOwner.recipientCredential.port.resolve!({deviceId:glasses.device_id,credentialRef:rows[1]!.device_credential_ref} as never),undefined);
  let admissionQueries=0;
  const admissionClient={query:async(sql:string,args:unknown[])=>{admissionQueries++;return query(sql,args);}};
  await glassesOwner.ownerContext.resolve({operation:'bootstrap',phase:'established',request:bootstrap.request,
    bearer:{deviceId:glasses.device_id,principal:USER} as never,governance:{}},admissionClient as never);
  await glassesOwner.formalWatchPrimaryAuthority.resolve(bearer,admissionClient as never);
  assert.equal(admissionQueries,2,'source revalidation reuses the held admission client');
  const projection=glassesOwner.readCurrentAuthority();
  const resolver=createAppleCyclingTypedSourceResolver({t03:glassesOwner,producer:{device_id:glasses.device_id,device_type:'glasses',channel:'rtc_typed_text'},
    playback:{device_id:glasses.device_id,transport:'wav_byte_stream_v1'}});
  const source=await resolver({userId:USER,deviceId:glasses.device_id} as never,
    {session:{realtimeSessionRef:'s',connectionEpoch:'1'},lease:{deviceLeaseRef:'l',capabilities:['data','audio','video'],policyDecisionRef:projection.policyDecisionRef}} as never,
    {bearer} as never);
  assert.deepEqual(source.output_modes,['text','voice']);assert.equal(hasTerminalCapability(source,'health'),false);
  assert.equal(hasTerminalCapability(source,'continuous_audio'),true);assert.equal(hasTerminalCapability(source,'contacts'),false);
  assert.equal(hasTerminalCapability(source,'local_wake'),true);
  assert.equal(hasTerminalCapability({...source,capabilities:['location']},'location'),true);
  await pairDevice({origin:'https://api.example:9443',pool:db as never,identity,registration:registration(2,'glasses',['display','microphone']),now:()=>T0+3});
  assert.equal(rows[0]!.status,'active');assert.equal(rows[1]!.status,'revoked');assert.equal(rows.filter(row=>row.status==='active').length,2);
  assert.equal(await devices.bearer.resolve({tokenSha256:createHash('sha256').update(glasses.token).digest('hex'),operation:'bootstrap'}),undefined);
  await assert.rejects(glassesOwner.ownerContext.resolve({operation:'bootstrap',phase:'established',request:bootstrap.request,
    bearer:{deviceId:glasses.device_id,principal:USER} as never,governance:{}}),/PAIRED_DEVICE_REVOKED/);
  await assert.rejects(glassesOwner.recipientCredential.port.resolve!({deviceId:glasses.device_id,credentialRef:rows[1]!.device_credential_ref} as never),/PAIRED_DEVICE_REVOKED/);
  assert.equal((await phoneOwner.ownerContext.resolve({operation:'bootstrap',phase:'established',request:bootstrap.request,
    bearer:{deviceId:phone.device_id,principal:USER} as never,governance:{}})).deviceId,phone.device_id);
  assert.equal('deviceId' in devices,false,'aggregate ports have no hidden primary terminal');
  assert.equal('readCurrentAuthority' in devices,false);
  const newPhone=await pairDevice({origin:'https://api.example:9443',pool:db as never,identity,registration:registration(3),now:()=>T0+4});
  assert.equal(rows[0]!.status,'revoked','a replacement phone with a new key revokes the prior phone');
  assert.equal(rows[2]!.status,'active','phone replacement retains glasses');
  const replacementOwner=await createPairedDeviceAuthority({pool:db as never,deviceId:newPhone.device_id,now:()=>T0+5});
  await assert.rejects(revokePairedDevice({pool:db as never,deviceId:newPhone.device_id,ownerUserId:'foreign'}),/PAIRED_DEVICE_REQUIRED/);
  assert.equal((await revokePairedDevice({pool:db as never,deviceId:newPhone.device_id,ownerUserId:USER})).status,'revoked');
  assert.equal((await revokePairedDevice({pool:db as never,deviceId:newPhone.device_id,ownerUserId:USER})).status,'revoked','repeated revoke is idempotent');
  assert.equal(await replacementOwner.bearer.resolve({tokenSha256:createHash('sha256').update(newPhone.token).digest('hex'),operation:'bootstrap'}),undefined);
  await assert.rejects(replacementOwner.ownerContext.resolve({operation:'bootstrap',phase:'established',request:bootstrap.request,
    bearer:{deviceId:newPhone.device_id,principal:USER} as never,governance:{}}),/PAIRED_DEVICE_REVOKED/);
  await assert.rejects(replacementOwner.recipientCredential.port.resolve!({deviceId:newPhone.device_id,credentialRef:rows[3]!.device_credential_ref} as never),/PAIRED_DEVICE_REVOKED/);
  await replacementOwner.close();
  await assert.rejects(phoneOwner.ownerContext.resolve({operation:'bootstrap',phase:'established',request:bootstrap.request,
    bearer:{deviceId:phone.device_id,principal:USER} as never,governance:{}}),/PAIRED_DEVICE_REVOKED/);
  requireArtifact=true;
  const pairedPhone=await pairDevice({origin:'https://api.example:9443',pool:db as never,identity,registration:registration(4),artifactDirectory:directory,now:()=>T0});
  assert.deepEqual(await pairDevice({origin:'https://api.example:9443',pool:db as never,identity,registration:registration(4),artifactDirectory:directory,now:()=>T0+1}),pairedPhone,'lost CLI output does not rotate the phone');
  const artifactPath=join(directory,`phone-pairing.${pairedPhone.device_id}.v1.json`);
  const artifactBefore=readFileSync(artifactPath,'utf8'), sequenceBefore=sequence;
  const canonicalOrigin='https://bj.example.invalid:9443';
  const migratedPairing=await pairDevice({pool:db as never,identity,registration:registration(4),
    artifactDirectory:directory,origin:canonicalOrigin,now:()=>T0+2});
  assert.deepEqual(migratedPairing,{...pairedPhone,origin:canonicalOrigin},'existing token, device, governance and paired_at survive an origin change');
  assert.equal(sequence,sequenceBefore,'origin change allocates no identity');
  assert.equal(readFileSync(artifactPath,'utf8'),artifactBefore,'origin announcement does not rewrite the saved artifact');
  let time=T0,activationFailure=false;
  let activationBarrier:undefined|{entered:()=>void;resume:Promise<void>};
  const enrollment=createGlassesEnrollment({pool:db as never,identity,origin:pairedPhone.origin,artifactDirectory:directory,now:()=>time,
    activate:async deviceId=>{if(activationFailure)throw new Error('ACTIVATION_FAILED');if(activationBarrier){activationBarrier.entered();await activationBarrier.resume;}await devices.register(deviceId);}});
  await assert.rejects(enrollment.issue(glasses.token),/PAIRED_PHONE_REQUIRED/);
  await assert.rejects(enrollment.issue(newPhone.token),/PAIRED_PHONE_REQUIRED/);
  const qr=await enrollment.issue(pairedPhone.token),recipient=JSON.parse(registration(5,'glasses').toString());
  const enrolled=await enrollment.exchange(qr.token,recipient);
  assert.equal((await devices.bearer.resolve({tokenSha256:createHash('sha256').update(enrolled.token).digest('hex'),operation:'bootstrap'}))?.deviceId,enrolled.device_id,'new glasses authenticate without restart');
  await t.test('committed glasses result survives a lost response and service recreation',async()=>{
    const restarted=createGlassesEnrollment({pool:db as never,identity,origin:pairedPhone.origin,artifactDirectory:directory,now:()=>time,activate:async()=>{}});
    assert.deepEqual(await restarted.exchange(qr.token,recipient),enrolled);
    await assert.rejects(pairDevice({pool:db as never,identity,origin:pairedPhone.origin,artifactDirectory:directory,registration:Buffer.from(JSON.stringify(recipient)),enrollmentToken:qr.token,enrollmentClass:'mac',now:()=>time}),/DEVICE_REGISTRATION_TYPE_MISMATCH/);
    for(const changed of [{...recipient,label:'changed'},JSON.parse(registration(9,'glasses').toString())])
      await assert.rejects(restarted.exchange(qr.token,changed),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
  });
  await t.test('activation failure after commit recovers the same device and bearer',async()=>{
    const code=await enrollment.issue(pairedPhone.token),value=JSON.parse(registration(12,'glasses').toString());activationFailure=true;
    await assert.rejects(enrollment.exchange(code.token,value),/ACTIVATION_FAILED/);activationFailure=false;
    const committed=rows.at(-1)!;const recovered=await enrollment.exchange(code.token,value);
    assert.equal(recovered.device_id,committed.device_id);assert.equal(createHash('sha256').update(recovered.token).digest('hex'),committed.token_sha256);
  });
  await t.test('overlapping exchanges return one committed result; revocation wins on retry',async()=>{
    const code=await enrollment.issue(pairedPhone.token),value=JSON.parse(registration(13,'glasses').toString());
    let entered!:()=>void,resume!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});const released=new Promise<void>(r=>{resume=r;});
    activationBarrier={entered,resume:released};const first=enrollment.exchange(code.token,value);await waiting;activationBarrier=undefined;
    try {const retry=await enrollment.exchange(code.token,value);resume();assert.deepEqual(await first,retry);
      await revokePairedDevice({pool:db as never,deviceId:retry.device_id,ownerUserId:USER});
      await assert.rejects(enrollment.exchange(code.token,value),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
    } finally {resume();await first;}
  });
  assert.deepEqual(await enrollment.exchange((await enrollment.issue(pairedPhone.token)).token,recipient),enrolled,'lost exchange output recovers the same artifact with a new QR');
  const macRegistration=JSON.parse(registration(7,'mac',[...MAC_CAPABILITIES]).toString());macRegistration.label='示例用户的 MacBook Pro';
  const glassesCode=await enrollment.issue(pairedPhone.token);
  await assert.rejects(enrollment.issue(pairedPhone.token,'mac'),/MAC_REVERSE_PAIRING_REQUIRED/);
  await assert.rejects(enrollment.exchange(glassesCode.token,macRegistration,'mac'),/MAC_REVERSE_PAIRING_REQUIRED/);
  const pairMac=async(value:Record<string,unknown>)=>{
    const result=await pairDevice({origin:'https://api.example:9443',pool:db as never,identity,registration:Buffer.from(JSON.stringify(value)),artifactDirectory:directory,now:()=>time});
    await devices.register(result.device_id);return result;
  };
  const mac=await pairMac(macRegistration);
  assert.equal(mac.device_type,'mac');assert.deepEqual(mac.media,['data','audio','video']);
  assert.equal(rows.find(row=>row.device_id===mac.device_id)!.label,macRegistration.label);
  assert.equal((await devices.forDevice(mac.device_id).readActiveAuthority()).deviceType,'mac','Mac activates without restart');
  assert.equal(rows.find(row=>row.device_id===pairedPhone.device_id)!.status,'active','Mac never revokes phone');
  assert.equal(rows.find(row=>row.device_id===enrolled.device_id)!.status,'active','Mac never revokes glasses');
  const secondMac=await pairMac(JSON.parse(registration(8,'mac',['display','chat_ui','desktop_tools']).toString()));
  assert.deepEqual(secondMac.media,['data']);assert.equal(rows.find(row=>row.device_id===mac.device_id)!.status,'active','multiple Macs coexist');
  await enrollment.exchange(glassesCode.token,recipient);
  const expired=await enrollment.issue(pairedPhone.token);time+=300_000;
  await assert.rejects(enrollment.exchange(expired.token,recipient),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
  await assert.rejects(enrollment.exchange(qr.token,recipient),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
  const pending=await enrollment.issue(pairedPhone.token);
  await assert.rejects(enrollment.exchange(pending.token,JSON.parse(registration(6,'phone').toString())),/DEVICE_REGISTRATION_TYPE_MISMATCH/);
  await assert.rejects(enrollment.exchange(pending.token,JSON.parse(registration(4,'glasses').toString())),/DEVICE_REGISTRATION_TYPE_MISMATCH/);
  const failed=createGlassesEnrollment({pool:db as never,identity,origin:pairedPhone.origin,artifactDirectory:join(directory,'missing'),now:()=>time,activate:async()=>{throw new Error('MUST_NOT_ACTIVATE');}});
  await assert.rejects(failed.exchange(pending.token,JSON.parse(registration(6,'glasses').toString())),/ENOENT/);
  assert.equal((await enrollment.exchange(pending.token,JSON.parse(registration(6,'glasses').toString()))).user_id,pairedPhone.user_id,'artifact failure rolls back capability consumption');
  const phoneBound=await enrollment.issue(pairedPhone.token);await enrollment.exchange(phoneBound.token,recipient);
  const revoked=await enrollment.issue(pairedPhone.token);await revokePairedDevice({pool:db as never,deviceId:pairedPhone.device_id,ownerUserId:USER});
  await assert.rejects(enrollment.exchange(revoked.token,recipient),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
  await assert.rejects(enrollment.exchange(phoneBound.token,recipient),/GLASSES_ENROLLMENT_EXPIRED_OR_USED/);
  await devices.close();
});

const pgUrl=process.env.PAIOS_FORMAL_SOURCE_TEST_DATABASE_URL;
test('actual PG concurrent phone enrollment keeps one owner and phone; revocation notifications are commit-coupled', {skip:pgUrl===undefined}, async t=>{
  const {randomUUID}=await import('node:crypto'),{readFile,readdir}=await import('node:fs/promises');
  const {createPostgresPool}=await import('../../../services/platform-data/src/postgres-pool.ts');
  const {createProductionRealtimeIdentityPort}=await import('../../../services/platform-data/src/realtime-identity-issuer.ts');
  const parsed=new URL(pgUrl!);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');
  const connect=()=>createPostgresPool({host:parsed.hostname,port:Number(parsed.port),user:parsed.username,database:parsed.pathname.slice(1),max:3});
  const admin=connect(),name='paired_notify_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);parsed.pathname='/'+name;
  const pool=connect();let devices:Awaited<ReturnType<typeof createPairedTerminalAuthorities>>|undefined;
  try {
    const migrations=new URL('../../../migrations/',import.meta.url);
    for(const file of (await readdir(migrations)).filter(file=>file.endsWith('.up.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
    const identity=createProductionRealtimeIdentityPort({clock:{now:()=>new Date().toISOString() as never}});
    const registration=(fill:number,device_type='phone')=>{const raw=Buffer.alloc(32,fill);return Buffer.from(JSON.stringify({device_type,public_raw32_base64url:raw.toString('base64url'),public_sha256:createHash('sha256').update(raw).digest('hex')}));};
    const concurrent=await Promise.all([4,5,6].map(fill=>pairDevice({origin:'https://api.example:9443',pool,identity,registration:registration(fill)})));
    assert.equal(new Set(concurrent.map(device=>device.user_id)).size,1,'first enrollments share the installation owner');
    const activePhones=await pool.query("SELECT device_id::text FROM paired_devices WHERE status='active' AND device_class='iphone'");
    assert.equal(activePhones.rows.length,1,'concurrent enrollment leaves exactly one active phone');
    assert.ok(concurrent.some(device=>device.device_id===activePhones.rows[0]!.device_id));
    const phone=await pairDevice({origin:'https://api.example:9443',pool,identity,registration:registration(1)}),glasses=await pairDevice({origin:'https://api.example:9443',pool,identity,registration:registration(2,'glasses')});
    devices=await createPairedTerminalAuthorities({pool});
    const issued=await devices.place.credential(phone.token,{device_id:phone.device_id,action:'issue'});
    const digest=(token:unknown)=>createHash('sha256').update(token as string).digest('hex');
    assert.equal((await pool.query('SELECT place_token_sha256 FROM paired_devices WHERE device_id=$1',[phone.device_id])).rows[0]!.place_token_sha256,digest(issued.token));
    assert.equal((await devices.bearer.resolve({tokenSha256:digest(issued.token),operation:'place_upload'}))?.deviceId,phone.device_id);
    assert.equal(await devices.bearer.resolve({tokenSha256:digest(issued.token),operation:'bootstrap'}),undefined);
    const rotated=await devices.place.credential(phone.token,{device_id:phone.device_id,action:'rotate'});
    assert.equal(await devices.place.resolve(digest(issued.token)),undefined);
    await devices.place.credential(phone.token,{device_id:phone.device_id,action:'revoke'});
    assert.equal(await devices.place.resolve(digest(rotated.token)),undefined);

    let resolve!:(id:string)=>void;const notifications:string[]=[];
    const next=()=>new Promise<string>((done,reject)=>{const timer=setTimeout(()=>reject(new Error('REVOCATION_NOTIFY_TIMEOUT')),2000);resolve=id=>{clearTimeout(timer);done(id);};});
    devices.onRevoked(async id=>{notifications.push(id);resolve(id);});
    let notified=next();await revokePairedDevice({pool,deviceId:glasses.device_id,ownerUserId:phone.user_id});assert.equal(await notified,glasses.device_id);
    const transaction=await pool.connect();
    try {await transaction.query('BEGIN');await revokePairedDevice({pool:{query:transaction.query.bind(transaction)} as never,deviceId:phone.device_id,ownerUserId:phone.user_id});await transaction.query('ROLLBACK');} finally {transaction.release();}
    notified=next();const replacement=await pairDevice({origin:'https://api.example:9443',pool,identity,registration:registration(3)});assert.equal(await notified,phone.device_id);
    assert.deepEqual(notifications,[glasses.device_id,phone.device_id]);
    assert.equal((await pool.query("SELECT device_id::text FROM paired_devices WHERE status='active'")).rows[0]!.device_id,replacement.device_id);
    await Promise.all([7,8].map(fill=>pairDevice({origin:'https://api.example:9443',pool,identity,registration:registration(fill)})));
    assert.equal((await pool.query("SELECT device_id FROM paired_devices WHERE status='active' AND device_class='iphone'")).rows.length,1,'concurrent replacements keep one active phone');
    const directory=mkdtempSync(join(tmpdir(),'mac-pg-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const currentPhone=await pairDevice({origin:'https://api.example:9443',pool,identity,registration:registration(10)});let time=Date.now();
    // Real PostgreSQL owns nonce consumption/concurrency; the HTTP suite covers signed owner verification.
    const enrollment=createGlassesEnrollment({pool,identity,origin:currentPhone.origin,artifactDirectory:directory,now:()=>time,
      activate:async()=>{},verifyMacApproval:async()=>{}});
    const raw=Buffer.alloc(32,11),macRegistration={label:'书房 Mac',device_type:'mac',capabilities:[...MAC_CAPABILITIES],
      public_raw32_base64url:raw.toString('base64url'),public_sha256:createHash('sha256').update(raw).digest('hex')};
    const qr=await enrollment.requestMac(macRegistration);
    assert.deepEqual(await enrollment.previewMac(currentPhone.token,qr.nonce),{label:'书房 Mac',public_key_sha256:macRegistration.public_sha256,expires_at:qr.expires_at,status:'pending'});
    assert.equal((await enrollment.exchangeMac(qr.nonce,qr.poll_token) as {status:string}).status,'pending');
    await enrollment.approveMac(currentPhone.token,qr.nonce,{});
    assert.equal((await enrollment.previewMac(currentPhone.token,qr.nonce)).status,'approved');
    const exchanges=await Promise.allSettled([enrollment.exchangeMac(qr.nonce,qr.poll_token),enrollment.exchangeMac(qr.nonce,qr.poll_token)]);
    const success=exchanges.filter(result=>result.status==='fulfilled'),failure=exchanges.filter(result=>result.status==='rejected');
    assert.equal(success.length,2);assert.equal(failure.length,0);assert.deepEqual(success[0]!.value,success[1]!.value);
    const paired=success[0]!.value;assert.ok('device_id' in paired);
    assert.equal((await enrollment.previewMac(currentPhone.token,qr.nonce)).status,'connected');
    const stored=(await pool.query('SELECT recipient_public_key,media,user_id::text FROM paired_devices WHERE device_id = $1',[paired.device_id])).rows[0]!;
    assert.equal(stored.recipient_public_key,macRegistration.public_raw32_base64url);assert.equal(stored.user_id,currentPhone.user_id);
    assert.deepEqual(stored.media,['data','audio','video']);
    assert.equal((await pool.query('SELECT 1 FROM mac_pairing_requests WHERE nonce_sha256 = $1',[digest(qr.nonce)])).rows.length,0);
    const expired=await enrollment.requestMac(macRegistration);time+=300_000;
    await assert.rejects(enrollment.approveMac(currentPhone.token,expired.nonce,{}),{code:'MAC_PAIRING_APPROVAL_DENIED',status:403});
    await assert.rejects(enrollment.exchangeMac(expired.nonce,expired.poll_token),{code:'MAC_PAIRING_EXPIRED_OR_USED',status:403});
    const revoked=await enrollment.requestMac(macRegistration);await enrollment.approveMac(currentPhone.token,revoked.nonce,{});
    await revokePairedDevice({pool,deviceId:currentPhone.device_id,ownerUserId:currentPhone.user_id});
    await assert.rejects(enrollment.exchangeMac(revoked.nonce,revoked.poll_token),{code:'MAC_PAIRING_EXPIRED_OR_USED',status:403});
    await assert.rejects(enrollment.approveMac(currentPhone.token,(await enrollment.requestMac(macRegistration)).nonce,{}),{code:'MAC_PAIRING_APPROVAL_DENIED',status:403});

  } finally {await devices?.close();await pool.end();await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});


test('place credential is phone-only, scoped, rotated and revoked without any live session',async()=>{
  const normal='paired-normal-token-123456',hash=(token:string)=>createHash('sha256').update(token).digest('hex');
  let placeDigest:string|null=null,active=true;
  const record={device_id:DEVICE,user_id:USER,device_class:'iphone',recipient_public_key:'pk',device_credential_ref:{},media:['data'],
    paired_at:new Date(T0).toISOString(),governance:{purpose_scopes:['cycling_assistant'],consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'c'}],
      policy_decision_refs:ref('p'),purpose_token_refs:ref('t'),capability_grant_refs:ref('g')}};
  const query=async(sql:string,args:unknown[]=[])=>{
    if(sql.startsWith('UPDATE')){
      if(!active||args[0]!==DEVICE||args[1]!==hash(normal)||sql.includes('IS NULL')&&placeDigest!==null)return {rows:[]};
      placeDigest=args[2] as string|null;return {rows:[{device_id:DEVICE}]};
    }
    if(sql.includes('WHERE place_token_sha256'))return {rows:active&&args[0]===placeDigest?[{device_id:DEVICE}]:[]};
    if(sql.includes('WHERE token_sha256'))return {rows:active&&args[0]===hash(normal)?[{device_id:DEVICE}]:[]};
    return {rows:active?[record]:[]};
  };
  const authority=await createPairedDeviceAuthority({pool:{query} as never,deviceId:DEVICE,now:()=>T0});
  await assert.rejects(authority.place.credential('foreign',{device_id:DEVICE,action:'issue'}),/PLACE_CREDENTIAL_DENIED/);
  const issued=await authority.place.credential(normal,{device_id:DEVICE,action:'issue'}),token=issued.token as string;
  assert.equal(placeDigest,hash(token));assert.notEqual(placeDigest,token,'PG stores only the digest');
  await assert.rejects(authority.place.credential(normal,{device_id:DEVICE,action:'issue'}),/PLACE_CREDENTIAL_DENIED/);
  assert.equal(await authority.bearer.resolve({tokenSha256:hash(normal),operation:'place_upload'}),undefined);
  for(const operation of ['bootstrap','realtime_e2ee_key_resolve','connected_credential_refresh','media_stop','end_continuity','handoff'] as const)
    assert.equal(await authority.bearer.resolve({tokenSha256:hash(token),operation}),undefined);
  assert.deepEqual((await authority.bearer.resolve({tokenSha256:hash(token),operation:'place_upload'}))?.scopes,['place_upload']);
  await assert.rejects(authority.place.credential(token,{device_id:DEVICE,action:'rotate'}),/PLACE_CREDENTIAL_DENIED/);
  const registry=new FormalTerminalSources(),sourceOwner=new FormalSourceAuthority({credentialRegistry:registry,place:authority.place,
    scheduled:{deviceId:DEVICE,read:authority.readActiveAuthority},
    ownerContext:authority.ownerContext,sameRef:()=>false,readCurrentBinding:async()=>{throw new Error('NO_LIVE_SESSION');},
    resolveSource:async()=>{throw new Error('NO_BOOTSTRAP_SOURCE');}});
  await assert.rejects(registry.authenticate({token}),/SOURCE_HOST_CREDENTIAL_REQUIRED/);
  const source=await registry.authenticate(sourceOwner.credentialForPlace(token));
  assert.equal(source.device_id,DEVICE);assert.equal(source.channel,'background_place');
  assert.equal((await registry.revalidate(source)).principal_id,USER);
  const scheduled=await registry.scheduled(USER,DEVICE);assert.equal(scheduled.channel,'background_scheduled');
  assert.equal((await registry.revalidate(scheduled)).device_id,DEVICE);
  await assert.rejects(registry.scheduled('another-owner',DEVICE),/SCHEDULE_OWNER_REQUIRED/);
  await assert.rejects(registry.scheduled(USER,'another-device'),/SCHEDULE_DEVICE_REQUIRED/);
  await assert.rejects(registry.revalidate({...scheduled}),/SOURCE_PROVENANCE_REQUIRED/);
  await assert.rejects(registry.withVoiceAction(source,'audio',async()=>true),/VOICE_PRIMARY_SOURCE_REQUIRED/);
  const next=await authority.place.credential(normal,{device_id:DEVICE,action:'rotate'});
  await assert.rejects(registry.revalidate(source),/PLACE_CAPABILITY_INVALID/);
  const current=await registry.authenticate(sourceOwner.credentialForPlace(next.token as string));
  await authority.place.credential(normal,{device_id:DEVICE,action:'revoke'});
  await assert.rejects(registry.revalidate(current),/PLACE_CAPABILITY_INVALID/);
  const last=await authority.place.credential(normal,{device_id:DEVICE,action:'issue'});active=false;
  await assert.rejects(registry.revalidate(scheduled),/PAIRED_DEVICE_REVOKED/);
  await assert.rejects(registry.authenticate(sourceOwner.credentialForPlace(last.token as string)),/PLACE_CAPABILITY_INVALID/);
  await authority.close();
});

test('desktop_tools belongs only to mac; biometric owner_unlock is explicit on Mac',()=>{
  assert.equal(PHONE_CAPABILITIES.includes('desktop_tools'),false);
  assert.deepEqual(terminalCapabilities({device_type:'mac',capabilities:MAC_CAPABILITIES}),MAC_CAPABILITIES);
  for(const device_type of ['phone','glasses','watch']) assert.throws(()=>terminalCapabilities({device_type,capabilities:['desktop_tools']}),/TERMINAL_CAPABILITY_DENIED/);
  assert.equal(MAC_CAPABILITIES.includes('owner_unlock'),false);
  assert.ok(terminalCapabilities({device_type:'mac',capabilities:[...MAC_CAPABILITIES,'owner_unlock']}).includes('owner_unlock'));
  for(const capability of ['health','continuous_audio'] as const) assert.throws(()=>terminalCapabilities({device_type:'mac',capabilities:[...MAC_CAPABILITIES,capability]}),/TERMINAL_CAPABILITY_DENIED/);
  const raw=Buffer.alloc(32,9),registration={device_type:'mac',public_raw32_base64url:raw.toString('base64url'),public_sha256:createHash('sha256').update(raw).digest('hex'),capabilities:MAC_CAPABILITIES};
  assert.ok(parseDeviceRegistration(Buffer.from(JSON.stringify({...registration,capabilities:[...MAC_CAPABILITIES,'owner_unlock']}))).capabilities.includes('owner_unlock'));
  for(const capabilities of [undefined,['display','chat_ui'],['desktop_tools','chat_ui'],['desktop_tools','display'],[...MAC_CAPABILITIES,'unknown']]) assert.throws(()=>parseDeviceRegistration(Buffer.from(JSON.stringify({...registration,capabilities}))),/TERMINAL_CAPABILITY_DENIED/);
  for(const label of ['', 'x'.repeat(65),'bad\nlabel']) assert.throws(()=>parseDeviceRegistration(Buffer.from(JSON.stringify({...registration,label}))),/DEVICE_REGISTRATION_LABEL_INVALID/);
});
