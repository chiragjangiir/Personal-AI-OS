import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../../../services/personal-aios-integration/src/main.ts';
import {VoiceprintPaymentVerifier,type PaymentVoiceVerifierOptions} from '../../../services/personal-aios-integration/src/voiceprint/payment-verify.ts';
import type {PaymentPorts} from '../../../services/personal-aios-integration/src/payment/contracts.ts';
import {PHONE_CAPABILITIES,GLASSES_CAPABILITIES} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {fakeSpeechConfig} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive,type StreamArchiveRecord} from '../../../services/personal-aios-integration/src/archive.ts';
import {StreamArchive,type TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import {pairedPaymentInventory,paymentClockMap} from '../src/personal-aios-payment-source.ts';
import {createSourceMediaClock} from '../src/source-media-clock.ts';
import type {SourceMediaCaptureBinding} from '../src/source-media-permission.ts';

const pairedRow=(device_id:string,user_id='owner',device_class='glasses')=>({device_id,user_id,device_class,recipient_public_key:'fixture-key',device_credential_ref:{id:device_id},media:['audio','data'],
  governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'fixture-consent'}],terminal_capabilities:device_class==='glasses'?GLASSES_CAPABILITIES:PHONE_CAPABILITIES},paired_at:'2026-10-15T00:00:00Z'});
test('I5 I15 production inventory reads fresh pairing rows, including offline devices, scoped to the principal',async()=>{
  let rows=[pairedRow('phone','owner','iphone'),pairedRow('offline'),pairedRow('foreign','another')],queries=0;
  const pool={query:async(sql:string)=>{queries++;assert.match(sql,/WHERE status = 'active'/);return {rows};}} as Parameters<typeof pairedPaymentInventory>[0];
  assert.deepEqual((await pairedPaymentInventory(pool,'owner')).map(d=>d.device_id),['phone','offline']);
  rows=[rows[0]!,pairedRow('new-offline')];
  assert.deepEqual((await pairedPaymentInventory(pool,'owner')).map(d=>d.device_id),['phone','new-offline']);
  assert.deepEqual(await pairedPaymentInventory(pool,'another'),[]);assert.equal(queries,3);
});
for(const enabled of [false,true])test(`I11 production provision and execution owner bind real payment dependencies (enabled=${enabled})`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'payment-composition-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const shipped=JSON.parse(await readFile(new URL('../../../../../deploy/cloud/cloud.json',import.meta.url),'utf8')) as CentralProvisionConfiguration;
  const key=join(root,'executor.key'),centralKey=join(root,'central.key'),cipher=join(root,'voiceprint.key'),skill=join(root,'skill'),model=join(root,'speaker.onnx');
  await writeFile(key,'fixture-executor-credential-at-least-32-bytes',{mode:0o600});await writeFile(centralKey,'fixture-central-credential-at-least-32-bytes',{mode:0o600});await writeFile(cipher,Buffer.alloc(32,7).toString('base64'),{mode:0o600});
  await writeFile(skill,'Fixture only');await writeFile(model,'Fixture identity; ONNX engine remains lazy');
  // Retain shipped payment/voiceprint settings. External voice, visual, cold storage and native-memory services are outside this startup check.
  const config:CentralProvisionConfiguration={storage_root:join(root,'storage'),lock_file:join(root,'lock'),port:19091,hermes_base_url:'http://127.0.0.1:1',hermes_key_file:centralKey,internal_key_file:centralKey,skill_file:skill,
    native_request_timeout_ms:shipped.native_request_timeout_ms,http_request_timeout_ms:shipped.http_request_timeout_ms,max_request_bytes:shipped.max_request_bytes,
    max_event_bytes:shipped.max_event_bytes,max_read_bytes:shipped.max_read_bytes,admission:shipped.admission,
    voiceprint:{...shipped.voiceprint!,speaker_model:{...shipped.voiceprint!.speaker_model,file:model},encryption_key_file:cipher},payment:{...shipped.payment as object,enabled,executor_key_file:key}};
  const provision=await provisionCentralResources(config);let owner:Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>|undefined;
  try{
    const t03={ownerContext:{resolve:async()=>{throw Error('NO_BOOTSTRAP_IN_STARTUP_CHECK');}},readCurrentAuthority:()=>({deviceType:'phone',capabilities:PHONE_CAPABILITIES})};
    const room={isConnected:true,remoteParticipants:new Map(),on:()=>{},off:()=>{},localParticipant:{sendText:async()=>{},publishData:async()=>{}}};
    owner=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',central:{...provision.resources,payment_devices:async()=>[]},deviceId:'phone',t03:t03 as never,readCurrentBinding:async()=>undefined,
      readCurrentBindingInAdmission:async()=>undefined,credentialFence:{verify:async()=>({active:false}),withAdmission:async()=>{throw Error('NO_CAPTURE_IN_STARTUP_CHECK');}} as never,
      participant:{roomPort:room} as never,onError:error=>assert.fail(String(error)),
      pcm:{producer:{device_type:'phone',channel:'rtc_pcm_and_text'},budget:{max_frame_samples:1024,max_pending_frames:4,max_pending_bytes:8192,max_samples:4096},
        clock:{evidence:'receipt_estimated',resolve:async()=>undefined},configuration:{fixture_only:false,stream_budget:{max_chunk_bytes:4096,max_total_bytes:32768,max_chunks:16,max_revisions:16,max_seq:16},
          alignment:{max_chunks:16,max_visual_refs:4,max_frame_gap_ms:100,max_uncertainty_ms:1000},processing:{policy_version:'payment-composition',max_inflight:1,max_input_bytes:32768,timeout_ms:1000,allow_external:false,allow_replay:false,allow_partial:true},
          max_segments:2,max_window_ms:10000,audio:{provider:'local_sherpa',config:fakeSpeechConfig(root)}}}});
    const payment=provision.resources.payment!,registry=provision.resources.voiceprint!,media=owner.media!;
    const bound=payment as unknown as {verifier:VoiceprintPaymentVerifier;ports:PaymentPorts};
    assert.equal(payment.config.enabled,enabled);assert.ok(bound.verifier instanceof VoiceprintPaymentVerifier);
    const verifier=(bound.verifier as unknown as {options:PaymentVoiceVerifierOptions}).options;
    assert.equal(verifier.archive,media.archive);assert.equal(verifier.archive,owner.assembly.runtime.existingArchive());assert.equal(verifier.registry,registry);
    assert.equal(verifier.engine,media.speech);assert.equal(verifier.detector,media.detector);
    const runtime=owner.assembly.runtime as unknown as {enrollment:{engine:unknown;detector:unknown};ambient:{payWindows:Map<string,unknown>}};
    assert.equal(runtime.enrollment.engine,media.speech);assert.equal(runtime.enrollment.detector,media.detector);
    assert.equal((await bound.verifier.verifyInitiating('owner',{device_id:'phone',device_type:'phone',raw_ref:'not-read',start_ms:1,end_ms:2,captured_at:new Date().toISOString()})).reason,'not_enrolled');
    const stop=bound.ports.openPayWindow!({principal_id:'owner',device_id:'phone',until_ms:Date.now()+10000,phrases:['付吧']},()=>assert.fail('NO_AUDIO_SUBMITTED'));
    assert.equal(runtime.ambient.payWindows.size,1);stop();assert.equal(runtime.ambient.payWindows.size,0);
    for(const channel of ['phone_app','glasses'] as const)await registry.enrollOwner({speaker_model:registry.model,channel,mode:'replace',samples:Array.from({length:5},()=>({embedding:Float32Array.from({length:registry.model.dim},(_,n)=>Number(n===0)),speech_ms:2400}))});
    await bound.ports.forget('owner','glasses');assert.equal((await registry.owner('glasses')).enrolled,false);assert.equal((await registry.owner('phone_app')).enrolled,true);
  }finally{await owner?.bridge.close?.();await provision.release();}
});
test('I5 source-clock adapter selects pinned receipt proof and rejects another binding or ambiguous audio tracks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'payment-clock-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage=new PosixStorage(root),budget={max_chunk_bytes:4096,max_total_bytes:32768,max_chunks:16,max_revisions:16,max_seq:16};
  const archive=new RawArchive(storage,4096,undefined,budget),streams=new StreamArchive(storage,budget);
  const base=Date.parse('2026-10-15T00:00:00Z'),binding={userId:'owner',deviceId:'phone',continuityId:'continuity',connectionEpoch:'1'} as SourceMediaCaptureBinding;
  const trusted={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'fixture',consent_ref:'fixture',submission:'observation'} as const;
  let providerCalls=0;
  const clock=createSourceMediaClock(storage,{evidence:'synthetic',resolveSpan:async()=>({modality:'audio',track_id:'anchor',stream_epoch:'anchor',source_timebase_id:'origin',target_timebase_id:'utc_epoch_ms',offset_ms:base,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-anchor'}),
    resolve:async(_binding,chunk)=>{providerCalls++;return {modality:chunk.modality,track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:base,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-track'};}},event=>archive.readStreamHeader(event));
  const span=await clock.sealSpan(binding,{span_id:'payment-span',modalities:['audio'],anchor_range:{kind:'instant',timebase_id:'origin',stream_epoch:'anchor',at_ms:0}});
  const append=async(track_id:string)=>{
    const chunk:TrackChunk=await clock.captureTrack(binding,{track_id,stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'ordinal',stream_epoch:'epoch',start_ms:0,end_ms:100}},span);
    return streams.append({schema_version:'paios.event.v1',event_id:span.event_id,device_id:'phone',device_type:'phone',...span.metadata,source:{channel:'fixture',capture_timing:span.capture_timing},media_type:'livekit_tracks',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200)},trusted,new Date(base).toISOString(),chunk);
  };
  const first=await append('mic'),record=await archive.readRecord(first.event.raw_ref,'owner',first.event.archive_revision);assert.equal(record.kind,'stream');
  let captured=binding;
  const map=paymentClockMap(()=>({clock,pcm:()=>({capture:async()=>({binding:captured,trusted})}) as never}));
  const utterance={device_id:'phone',device_type:'phone' as const,raw_ref:first.event.raw_ref,archive_revision:first.event.archive_revision,start_ms:base,end_ms:base+100,captured_at:new Date(base).toISOString()};
  const calls=providerCalls;assert.equal((await map('owner',utterance,record as StreamArchiveRecord)).track_id,'mic');assert.equal(providerCalls,calls,'archived selection must not recalibrate');
  await assert.rejects(map('foreign',utterance,record as StreamArchiveRecord),/PAYMENT_AUDIO_SOURCE_DENIED/);
  captured={...binding,connectionEpoch:'2'};await assert.rejects(map('owner',utterance,record as StreamArchiveRecord),/MEDIA_CLOCK_BASIS_DENIED/);captured=binding;
  const next=await append('second-mic'),ambiguous=await archive.readRecord(next.event.raw_ref,'owner',next.event.archive_revision);
  await assert.rejects(map('owner',utterance,ambiguous as StreamArchiveRecord),/PAYMENT_AUDIO_CLOCK_REQUIRED/);
});
