import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission,type NativeClient} from './native-source-fixture.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {sha256} from '../src/contracts.ts';
import {GLASSES_CAPABILITIES} from '../src/source-authority.ts';

async function fixture(t:test.TestContext,ttl_ms=120000) {
  const root=await mkdtemp(join(tmpdir(),'paios-trust-window-')),storage=new PosixStorage(root);
  const registry=new VoiceprintRegistry(storage,{id:'synthetic',sha256:'a'.repeat(64),dim:16});
  let runs=0;
  const native:NativeClient={create:async()=>{runs++;throw new Error('unexpected admission');},status:async()=>{throw new Error('no run');},cancel:async()=>{throw new Error('no run');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,
    poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'synthetic-trust'});
  const device=(principal_id:string,device_id:string,device_type:'phone'|'glasses'|'mac')=>({principal_id,device_id,device_type,
    consent_ref:'fixture',channel:'fixture',route_version:'fixture',output_modes:['text'],token_sha256:sha256(device_id),
    ...(device_type==='glasses'?{capabilities:GLASSES_CAPABILITIES}:device_type==='mac'?{capabilities:['microphone','owner_unlock','chat_ui'] as const}:{})});
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,100000),admission,native,output:new OutputAuthority(storage),
    voiceprint:registry,voice_confirmation:{ttl_ms},skill:'fixture',max_read_bytes:100000,
    devices:[device('owner','phone','phone'),device('owner','glasses','glasses'),device('owner','mac','mac'),device('foreign','foreign-phone','phone')]});
  const phone=await runtime.authenticate('phone'),glasses=await runtime.authenticate('glasses'),mac=await runtime.authenticate('mac'),foreign=await runtime.authenticate('foreign-phone');
  const unwatch=await runtime.watchCare(glasses,async()=>true,undefined,undefined,()=>true,undefined,undefined,
    {session:'fixture-glasses',deliver:async()=>{}});
  await runtime.wearState(glasses,true);
  t.after(async()=>{unwatch();await runtime.close();await registry.close();await rm(root,{recursive:true,force:true});});
  return {runtime,registry,storage,phone,glasses,mac,foreign,runs:()=>runs};
}

test('manual device training uses the existing card and grants only after the correct biometric',async t=>{
  const f=await fixture(t),scope={principal_id:'owner',device_id:'glasses'};
  const devices=await f.runtime.voiceTrustDevices(f.phone);
  assert.equal(devices.active_voice_device_id,'glasses');
  assert.deepEqual(devices.voice_devices.map(d=>d.device_id),['glasses','phone']);
  const record=await f.runtime.openVoiceTrustWindow(f.phone,'manual','glasses','tap-1');
  assert.equal(record.source_device_id,'glasses');assert.equal(record.text,'接下来 1 分钟是我在说');
  assert.equal(f.registry.trustWindowActive(scope),false);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id}),/APP_UPDATE_REQUIRED/);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id,auth:'touch_id'}),/BIOMETRIC_INVALID/);
  await assert.rejects(f.runtime.confirmVoice(f.foreign,{confirmation_id:record.confirmation_id,auth:'face_id'}),/SCOPE_DENIED/);
  assert.equal(f.registry.trustWindowActive(scope),false);
  const accepted=await f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id,auth:'face_id'});
  assert.ok('approval' in accepted);assert.equal(f.registry.trustWindowActive(scope),true);
  assert.equal(f.registry.trustWindowActive(f.phone),false);assert.equal(f.runs(),0,'manual training never starts an assistant turn');
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  await f.runtime.close();assert.equal(f.registry.trustWindowActive(scope),false);
});

test('manual denial, expiry and cross-device target checks never open a window',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=await fixture(t);
  await assert.rejects(f.runtime.openVoiceTrustWindow(f.phone,'manual','foreign-phone','foreign'),/DEVICE_NOT_AVAILABLE/);
  await assert.rejects(f.runtime.openVoiceTrustWindow(f.glasses,'manual','glasses','glasses'),/DEVICE_REQUIRED/);
  const denied=await f.runtime.openVoiceTrustWindow(f.phone,'manual','phone','denied');
  await f.runtime.confirmVoice(f.phone,{confirmation_id:denied.confirmation_id,choice:'deny'});
  assert.equal(f.registry.trustWindowActive(f.phone),false);
  const expired=await f.runtime.openVoiceTrustWindow(f.phone,'manual','phone','expired');
  now+=120001;
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:expired.confirmation_id,auth:'face_id'}),/EXPIRED/);
  assert.equal(f.registry.trustWindowActive(f.phone),false);
});

test('a live call confirmation settles its pending turn once; denial and timeout remain observation only',async t=>{
  const f=await fixture(t,2000),abort=new AbortController();
  const pending=f.runtime.confirmCallSpeech(f.phone,'call-session',{call_id:'call-1',turn:0,user:'synthetic words'},abort.signal);
  let rows=await f.runtime.voiceConfirmations(f.phone);
  while(!rows.length){await new Promise(resolve=>setTimeout(resolve,1));rows=await f.runtime.voiceConfirmations(f.phone);}
  await f.runtime.confirmVoice(f.phone,{confirmation_id:rows[0]!.confirmation_id,auth:'face_id'});
  assert.equal(await pending,true);assert.equal(f.registry.trustWindowActive(f.phone),true);assert.equal(f.runs(),0);
  f.registry.clearTrustWindows();
  const denied=f.runtime.confirmCallSpeech(f.phone,'call-session',{call_id:'call-1',turn:1,user:'denied'},abort.signal);
  rows=await f.runtime.voiceConfirmations(f.phone);
  while(!rows.length){await new Promise(resolve=>setTimeout(resolve,1));rows=await f.runtime.voiceConfirmations(f.phone);}
  await f.runtime.confirmVoice(f.phone,{confirmation_id:rows[0]!.confirmation_id,choice:'deny'});
  assert.equal(await denied,false);assert.equal(f.registry.trustWindowActive(f.phone),false);
  const timeout=f.runtime.confirmCallSpeech(f.phone,'call-session',{call_id:'call-1',turn:2,user:'timeout'},abort.signal);
  const keepAlive=setTimeout(()=>{},3000);
  assert.equal(await timeout,false);clearTimeout(keepAlive);
  assert.equal(f.registry.trustWindowActive(f.phone),false);
});

test('Mac confirmation requires Touch ID and scopes training to that Mac',async t=>{
  const f=await fixture(t),record=await f.runtime.openVoiceTrustWindow(f.mac,'mac-session','mac','touch');
  await assert.rejects(f.runtime.confirmVoice(f.mac,{confirmation_id:record.confirmation_id,auth:'face_id'}),/BIOMETRIC_INVALID/);
  await f.runtime.confirmVoice(f.mac,{confirmation_id:record.confirmation_id,auth:'touch_id'});
  assert.equal(f.registry.trustWindowActive(f.mac),true);assert.equal(f.registry.trustWindowActive(f.phone),false);
});


test('manual biometric holds an already silent explicit call until hangup using the current source scope',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const f=await fixture(t),record=await f.runtime.openVoiceTrustWindow(f.phone,'manual','phone','silent-call');
  const scopes:unknown[]=[];
  await f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id,auth:'face_id'},scope=>{
    scopes.push(scope);return scope.principal_id==='owner'&&scope.device_id==='phone'?'silent-call':undefined;
  });
  assert.deepEqual(scopes,[{principal_id:'owner',device_id:'phone'}]);
  t.mock.timers.setTime(now+70000);
  assert.equal(f.registry.trustWindowActive(f.phone),true,'no speech or identify was needed to hold the live call');
  f.registry.closeTrustCall(f.phone,'silent-call');
  assert.equal(f.registry.trustWindowActive(f.phone),false);
});

test('manual biometric cannot hold a call from another source device',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const f=await fixture(t),record=await f.runtime.openVoiceTrustWindow(f.phone,'manual','glasses','other-source');
  await f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id,auth:'face_id'},scope=>
    scope.principal_id==='owner'&&scope.device_id==='phone'?'phone-call':undefined);
  assert.equal(f.registry.trustWindowActive(f.glasses),true);
  t.mock.timers.setTime(now+70000);
  assert.equal(f.registry.trustWindowActive(f.glasses),false);
  assert.equal(f.registry.trustWindowActive(f.phone),false);
});


test('manual approval retries resolve the current call using the original decision timestamp',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const f=await fixture(t),record=await f.runtime.openVoiceTrustWindow(f.phone,'manual','phone','approval-retry');
  const times:(string|undefined)[]=[];
  const currentCall=(_scope:{principal_id:string;device_id:string},confirmed_at?:string)=>{times.push(confirmed_at);return undefined;};
  await f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id,auth:'face_id'},currentCall);
  t.mock.timers.setTime(now+5000);
  await f.runtime.confirmVoice(f.phone,{confirmation_id:record.confirmation_id,auth:'face_id'},currentCall);
  assert.deepEqual(times,[new Date(now).toISOString(),new Date(now).toISOString()]);
});


test('live call replacements withdraw old cards from the device snapshot before expiry',async t=>{
  const f=await fixture(t),abort=new AbortController();t.after(()=>abort.abort());
  t.after(await f.runtime.watchCare(f.phone,async()=>true));await f.runtime.ownerInput(f.phone);
  const views:string[][]=[];
  t.after(await f.runtime.watchVoiceConfirmations(f.phone,async rows=>{views.push(rows.map(row=>row.confirmation_id));},error=>assert.fail(String(error))));
  const decisions:Promise<boolean>[]=[],ids:string[]=[];
  for(let turn=1;turn<=3;turn++){
    decisions.push(f.runtime.confirmCallSpeech(f.phone,'conversation',{call_id:'replace-call',turn,user:`uncertain-${turn}`},abort.signal));
    let rows=await f.runtime.voiceConfirmations(f.phone);
    while(rows.length!==1||rows[0]!.confirmation_id===ids.at(-1)){
      await new Promise(resolve=>setTimeout(resolve,1));rows=await f.runtime.voiceConfirmations(f.phone);
    }
    ids.push(rows[0]!.confirmation_id);
    if(turn>1)assert.equal(await decisions[turn-2],false);
  }
  while(views.at(-1)?.[0]!==ids[2])await new Promise(resolve=>setTimeout(resolve,1));
  assert.ok(views.every(rows=>rows.length<=1));assert.deepEqual(views.at(-1),[ids[2]]);
  await assert.rejects(f.runtime.confirmVoice(f.phone,{confirmation_id:ids[0]!,auth:'face_id'}),/EXPIRED/);
  assert.equal(f.registry.trustWindowActive(f.phone),false);
  await f.runtime.confirmVoice(f.phone,{confirmation_id:ids[2]!,auth:'face_id'});
  assert.equal(await decisions[2],true);assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
  assert.equal(f.runs(),0);
});

test('hangup during confirmation publication cannot republish an aborted card',async t=>{
  const f=await fixture(t),abort=new AbortController(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const publish=f.storage.publish.bind(f.storage);
  f.storage.publish=async(namespace,key,bytes)=>{
    if(namespace==='voice-confirmations'){entered.resolve();await release.promise;}
    return publish(namespace,key,bytes);
  };
  const pending=f.runtime.confirmCallSpeech(f.phone,'conversation',{call_id:'hangup-call',turn:1,user:'uncertain'},abort.signal);
  await entered.promise;abort.abort();release.resolve();assert.equal(await pending,false);
  assert.deepEqual(await f.runtime.voiceConfirmations(f.phone),[]);
});
