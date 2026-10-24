import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {promises as fs} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {ReadableStream, type ReadableStreamDefaultController} from 'node:stream/web';
import {DataPacketKind,RoomEvent,TrackKind,TrackSource} from '@livekit/rtc-node';
import {createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import type {FormalPcmResources} from '../src/persistent-public-execution-owner.ts';
import {FORMAL_TEXT_INPUT_TOPIC} from '../src/personal-aios-formal-text.ts';
import type {PcmFrame} from '../src/personal-aios-formal-pcm.ts';
import type {LiveKitCloudParticipantPort} from '../src/livekit-cloud-participant.ts';
import type {RealtimeBootstrapConnectedInput} from '../src/realtime-public-control-runtime.ts';
import {createDeviceLease} from '../../../services/realtime-core/src/device-lease-state-machine.ts';
import type {RealtimeCurrentBindingProjection} from '../../../services/realtime-core/src/types.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {canonical,sha256,bindRaw,type RawEvent,type ProcessedEvent} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {NativeClient,NativeRun} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import type {Capability,WorkerPort,WorkerRequest} from '../../../services/personal-aios-integration/src/media/processing.ts';
import {controlledDetector,fakeSpeechConfig} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';
import type {MediaReplayConfiguration} from '../../../services/personal-aios-integration/src/media/configuration.ts';
import {parseMediaReplayConfiguration} from '../../../services/personal-aios-integration/src/media/setup.ts';

const sessionRef={ref_type:'RealtimeSession',ref_id:'01900000-0000-7000-8000-000000000001',object_version:'1',canonical_payload_sha256:'a'.repeat(64)} as const;
const leaseRef={...sessionRef,ref_type:'DeviceLease',ref_id:'01900000-0000-7000-8000-000000000002'} as const;
const principal={opaque:'controlled-principal'};
const packet={requested_media:{data:true,audio:true,video:false},start:{modalities:['data','audio']}};
const capability:Capability={id:'controlled-pcm',version:'source-fixture',modalities:['audio'],formats:['pcm_s16le:16000:1'],
  joint_av:false,healthy:true,permitted:true,max_duration_ms:10000,execution:'local',evidence:'deterministic_replay'};
export function waveform(variant=0,count=320):PcmFrame {
  const data=new Int16Array(count);
  for(let n=0;n<count;n++)data[n]=Math.round(Math.sin(n/(variant+7))*12000)+(variant?17:0);
  return {data,sampleRate:16000,channels:1,samplesPerChannel:count};
}
export function pcmBytes(frame:PcmFrame) {
  const bytes=Buffer.alloc(frame.data.length*2);
  for(let n=0;n<frame.data.length;n++)bytes.writeInt16LE(frame.data[n]!,n*2);
  return bytes;
}
export async function eventually(predicate:()=>boolean|Promise<boolean>) {
  for(let n=0;n<300;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('CONTROLLED_SOURCE_TEST_TIMEOUT');
}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

export async function fixture(t:TestContext, overrides:{budget?:Partial<FormalPcmResources['budget']>;clockMissing?:boolean;cancelWait?:Promise<void>;continuous?:boolean;span?:boolean}={}) {
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-unknown-pcm-'));
  const storage=new PosixStorage(join(directory,'data'));
  const base=Date.now();let now=base,blocked=false,locked=false,cancels=0,legacy=0,sourceReads=0,clockReads=0;
  let mutate:undefined|(()=>void),modelWait:Promise<void>|undefined,sourceWait:Promise<void>|undefined,clockWait:Promise<void>|undefined;
  let cancelSettled=false,streams=0;
  const contexts:{generation:string;locked:boolean}[]=[],errors:unknown[]=[],requests:WorkerRequest[]=[],nativeInputs:ProcessedEvent[]=[],admissions:unknown[]=[],raws:RawEvent[]=[],published:unknown[]=[];
  const runs=new Map<string,NativeRun>();
  const policy='controlled-policy';
  let lease=createDeviceLease({deviceLeaseRef:leaseRef,realtimeSessionRef:sessionRef,continuityId:'continuity',userId:'owner',
    deviceId:'phone',issuedAt:new Date(base).toISOString() as never,policy:{allowed:true,capabilities:['data','audio'],
      purpose:'assistant',leaseExpiresAt:new Date(base+1800000).toISOString() as never,revocable:true,policyDecisionRef:policy}});
  const session={realtimeSessionRef:sessionRef,userId:'owner',continuityId:'continuity',state:'active',continuityState:'active',
    connectionEpoch:'1',continuityExpiresAt:new Date(base+1800000).toISOString(),activeDeviceId:'phone',activeDeviceLeaseRef:leaseRef,
    revision:'1',binding:{state:'connected',realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',deviceId:'phone',connectionEpoch:'1'}};
  const input={request:{request_id:'controlled-bootstrap'},bearer:{principal,deviceId:'phone'},governance:{controlled:true},
    authority:{gateway:{identity:'controlled-gateway',roomName:'room'},credential_expires_at:new Date(base+60000).toISOString()},
    currentBinding:{realtimeSessionRef:sessionRef,deviceLeaseRef:leaseRef,continuityId:'continuity',connectionEpoch:'1',credentialIdentity:'terminal',credentialRoom:'room'},
    enabledMedia:{data:true,audio:true,video:false}} as unknown as RealtimeBootstrapConnectedInput;
  const t03={ownerContext:{resolve:async()=>({userId:'owner',deviceId:'phone',purpose:'assistant',capabilities:['data','audio'],occurredAt:new Date(now).toISOString()})},
    formalWatchPrimaryAuthority:{resolve:async()=>({userId:'owner',deviceId:'phone',principalRef:principal,policyDecisionRef:policy})},
    readCurrentAuthority:()=>({userId:'owner',deviceId:'phone',principal,policyDecisionRef:policy,allowedMediaCapabilities:['data','audio'],
      governance:{consent_record_refs:[{ref_type:'ConsentRecord',ref_id:'controlled-consent'}]}})};
  const listeners=new Map<string,Set<(...args:readonly unknown[])=>void>>();
  const emit=(event:string,...args:unknown[])=>{for(const listener of [...listeners.get(event)??[]])listener(...args);};
  const track=Object.freeze({controlled:'microphone'}),publication={kind:TrackKind.KIND_AUDIO,source:TrackSource.SOURCE_MICROPHONE,sid:'controlled-mic',track};
  const remoteParticipants=new Map<string, {identity:string;trackPublications:Map<string,typeof publication>}>();
  const addExisting=(identity='terminal')=>{const peer={identity,trackPublications:new Map([[publication.sid,publication]])};remoteParticipants.set(identity,peer);emit(RoomEvent.ParticipantConnected,peer);};
  const room={isConnected:true,remoteParticipants,on:(event:string,listener:(...args:readonly unknown[])=>void)=>{
    const group=listeners.get(event)??new Set();group.add(listener);listeners.set(event,group);},
    off:(event:string,listener:(...args:readonly unknown[])=>void)=>{listeners.get(event)?.delete(listener);},
    localParticipant:{sendText:async(_text:string)=>{},publishData:async(bytes:Uint8Array)=>{published.push(JSON.parse(Buffer.from(bytes).toString()));}},connect:async()=>{assert.fail('REAL_ROOM_CONNECT_FORBIDDEN');},disconnect:async()=>{assert.fail('BORROWED_ROOM_DISCONNECT_FORBIDDEN');}};
  let controller:ReadableStreamDefaultController<PcmFrame>;
  const streamFactory=()=>{streams++;return new ReadableStream<PcmFrame>({start:value=>{controller=value;},
    cancel:async()=>{cancels++;if(overrides.cancelWait)await overrides.cancelWait;cancelSettled=true;}});};
  const native:NativeClient={create:async body=>{
    nativeInputs.push(JSON.parse(body.input) as ProcessedEvent);
    const run={run_id:'controlled-native-'+nativeInputs.length,session_id:body.session_id,conversation_session_id:body.session_id,status:'running' as const};
    runs.set(run.run_id,run);return run;
  },status:async id=>({...runs.get(id)!}),cancel:async id=>{const run=runs.get(id)!;run.status='cancelled';return {...run};}};
  const worker:WorkerPort={analyze:async request=>{
    assert.equal(locked,false,'model must not hold capture fence');requests.push(structuredClone(request));
    if(modelWait)await modelWait;
    return {event_id:request.event_id,segment_id:request.segment_id,archive_revision:request.archive_revision,time_range:request.time_range,
      content:{transcript:'CONTROLLED SOURCE, NOT REAL ASR',audio_observations:['controlled PCM source']},speakers:[],
      warnings:['CONTROLLED_WORKER_NOT_REAL_MODEL'],status:'partial'};
  }};
  const configuration:MediaReplayConfiguration={fixture_only:true,
    stream_budget:{max_chunk_bytes:4096,max_total_bytes:32768,max_chunks:16,max_revisions:16,max_seq:16},
    alignment:{max_chunks:16,max_visual_refs:4,max_frame_gap_ms:100,max_uncertainty_ms:2},
    processing:{policy_version:'controlled-formal-pcm',max_inflight:2,max_input_bytes:32768,timeout_ms:10000,
      allow_external:false,allow_replay:true,allow_partial:true},max_segments:2,max_window_ms:10000,
    audio:{provider:'local_sherpa',config:fakeSpeechConfig(join(directory,'never-loaded'))}};
  const pcm:FormalPcmResources={configuration,producer:{device_type:'phone',channel:'rtc_pcm_and_text'},
    budget:{max_frame_samples:1024,max_pending_frames:4,max_pending_bytes:8192,max_samples:4096,...overrides.budget},streamFactory,
    ports:{workers:new Map([[capability.id,worker]]),capabilities:async()=>[capability],vad:{candidates:async request=>{
      assert.equal(locked,false);assert.equal(request.time_range.kind,'interval');
      const range=request.time_range as {start_ms:number;end_ms:number};
      return [{start_ms:range.start_ms,end_ms:range.end_ms,semantic_status:'open',basis:'controlled-not-silero'}];
    }}},...overrides.clockMissing?{}:{clock:{evidence:'synthetic',resolve:async(_binding,chunk)=>{clockReads++;if(clockWait)await clockWait;return {modality:chunk.modality,
      track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_timebase_id:chunk.source_range.timebase_id,
      target_timebase_id:'utc_epoch_ms',offset_ms:base+1,drift_ppm:0,uncertainty_ms:1,basis_ref:'controlled-clock-not-hardware'};}}}};
  if(overrides.span){
    pcm.span={span_id:'controlled-formal-span',modalities:['audio','visual'],anchor_range:{kind:'instant',timebase_id:'source-origin',stream_epoch:'span-origin',at_ms:50}};
    pcm.clock!.resolveSpan=async()=>({modality:'audio',track_id:'span-origin',stream_epoch:'span-origin',source_timebase_id:'source-origin',
      target_timebase_id:'utc_epoch_ms',offset_ms:base-50,drift_ppm:0,uncertainty_ms:1,basis_ref:'CONTROLLED_INDEPENDENT_SPAN_CLOCK'});
  }
  if(overrides.continuous){
    // Controlled marker detector in place of the speech engine's Silero; markers are not speech.
    pcm.continuous={budget:{max_streams:2,max_pending_chunks:8,max_pending_candidates:8,max_chunk_bytes:4096,block_samples:160000,overlap_samples:8000}};pcm.ports!.detector=controlledDetector();
  }
  const permissionReads:boolean[]=[];let fenceFailure:Error|undefined;
  const readCurrentBinding=async()=>{
    sourceReads++;if(sourceWait)await sourceWait;permissionReads.push(locked);return {session,lease} as unknown as RealtimeCurrentBindingProjection;};
  // This original controlled fence has no PostgreSQL admission client. Never invent one.
  let transactionReaderCalls=0;
  t.after(()=>{assert.equal(transactionReaderCalls,0);console.info('controlled_permission_reader_scope',JSON.stringify({pg_client:false,transaction_reader_calls:transactionReaderCalls}));});
  const options={executionOwner:'hermes_text' as const,pcm,t03:t03 as never,readCurrentBinding,
    readCurrentBindingInAdmission:async(client:unknown)=>{transactionReaderCalls++;assert.equal(client,undefined,'controlled fence supplies no PostgreSQL client');return readCurrentBinding();},deviceId:'phone',
    participant:{roomPort:room} as unknown as LiveKitCloudParticipantPort,now:()=>now,
    credentialFence:{verify:async()=>({active:blocked}),withAdmission:async(_tuple:unknown,consume:()=>Promise<unknown>)=>{
      const tuple=_tuple as {credentialGeneration:string};contexts.push({generation:tuple.credentialGeneration,locked});
      if(blocked)throw new Error('CREDENTIAL_FENCE_ACTIVE');
      mutate?.();locked=true;try{const committed=await consume();if(fenceFailure)throw fenceFailure;return committed;}finally{locked=false;}
    }} as never,
    central:{storage,native:sourceClient(native),admission:{max_pending_events:16,max_pending_bytes:65536,max_event_age_ms:60000,poll_interval_ms:5,
      native_idempotency_retention_ms:60000,policy_version:'controlled-source-admission'},skill:'controlled-source-no-model',
      max_event_bytes:4096,max_read_bytes:32768,http:{internal_token:'controlled-source-token-no-secret',max_request_bytes:65536,request_timeout_ms:10000}},
    onError:(error:unknown)=>{errors.push(error);}};
  let owner:Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>|undefined;
  t.after(async()=>{
    await Promise.resolve(owner?.bridge.close?.()).catch(()=>{});
    if(process.env.FORMAL_PCM_EVIDENCE_ROOT){await fs.mkdir(process.env.FORMAL_PCM_EVIDENCE_ROOT,{recursive:true});
      await fs.writeFile(join(directory,'source-result.json'),JSON.stringify({case:t.name,sourceReads,contexts,errors:errors.map(String),
        requests,nativeInputs,nativeRuns:[...runs.values()],admissions,raws,published,cancels,cancelSettled,streams,legacy,scope:'controlled-source-fake-model-native-synthetic-clock'},null,2));
      await fs.cp(directory,join(process.env.FORMAL_PCM_EVIDENCE_ROOT,basename(directory)),{recursive:true});}
    await fs.rm(directory,{recursive:true,force:true});
  });
  const create=async()=>{owner=await createPersistentPublicExecutionOwner(options);
    if(owner.executionOwner==='hermes_text'){const append=owner.assembly.runtime.appendMedia.bind(owner.assembly.runtime);
      owner.assembly.runtime.appendMedia=async(raw,source,chunk,publicationWaitSignal,lifecycle)=>{raws.push(structuredClone(raw));return append(raw,source,chunk,publicationWaitSignal,lifecycle);};}
    return owner;};
  return {storage,input,session,pcm,options,errors,requests,nativeInputs,contexts,permissionReads,create,raws,published,admissions,base,track,publication,addExisting,
    get owner(){assert.ok(owner?.executionOwner==='hermes_text');return owner;},
    get cancelSettled(){return cancelSettled;},get streams(){return streams;},get sourceReads(){return sourceReads;},get clockReads(){return clockReads;},get locked(){return locked;},get cancels(){return cancels;},get legacy(){return legacy;},
    feed:(frame=waveform())=>controller!.enqueue(frame),
    end:()=>controller!.close(),
    subscribe:(identity='terminal')=>{addExisting(identity);emit(RoomEvent.TrackSubscribed,track,publication,{identity});},
    unsubscribe:(selected:unknown)=>emit(RoomEvent.TrackUnsubscribed,selected,publication,{identity:'terminal'}),
    hostConnect:async()=>{room.isConnected=true;addExisting();},
    listenerCount:()=>[...listeners.values()].reduce((sum,group)=>sum+group.size,0),
    oldSubscribed:()=>[...listeners.get(RoomEvent.TrackSubscribed)??[]][0],
    sendText:(body:unknown)=>{if(!remoteParticipants.has('terminal')){const peer={identity:'terminal',trackPublications:new Map<string,typeof publication>()};remoteParticipants.set('terminal',peer);emit(RoomEvent.ParticipantConnected,peer);}
      emit(RoomEvent.DataReceived,Buffer.from(JSON.stringify(body)),{identity:'terminal'},DataPacketKind.KIND_RELIABLE,FORMAL_TEXT_INPUT_TOPIC);},
    disconnect:()=>emit(RoomEvent.Disconnected),
    failFenceCommit:(error:Error)=>{fenceFailure=error;},block:()=>{blocked=true;},renew:()=>{now=base+120000;lease={...lease,leaseVersion:'2' as never,expiresAt:new Date(base+2400000).toISOString() as never};},
    revokeAudio:()=>{lease={...lease,capabilities:['data']};},
    mutate:()=>{mutate=()=>{lease={...lease,leaseVersion:'2' as never};};},
    holdModel:(wait:Promise<void>)=>{modelWait=wait;},holdSource:(wait?:Promise<void>)=>{sourceWait=wait;},holdClock:(wait?:Promise<void>)=>{clockWait=wait;},
    expire:()=>{now=base+1800001;},
  };
}
export async function connect(f:Awaited<ReturnType<typeof fixture>>) {
  await f.create();f.owner.bridge.assertBootstrapRequest!(packet);await f.owner.bridge.onBootstrapConnected!(f.input);f.subscribe();
}
export async function latest(f:Awaited<ReturnType<typeof fixture>>,seq=0) {
  await eventually(()=>f.owner.pcmIngress?.snapshot().latest?.chunk.seq===seq);
  return f.owner.pcmIngress!.snapshot().latest!;
}
export async function request(f:Awaited<ReturnType<typeof fixture>>,snapshot:Awaited<ReturnType<typeof latest>>) {
  const source=await f.owner.authority.authenticate(f.owner.authority.credentialForBootstrap(f.input));
  const capture=await f.owner.authority.capture(f.owner.authority.credentialForBootstrap(f.input));
  const map=await f.owner.clock!.read(capture.binding,snapshot.chunk);assert.ok(map);
  assert.equal(snapshot.chunk.source_range.kind,'interval');
  const range=snapshot.chunk.source_range as {start_ms:number;end_ms:number};
  return {source,request:{raw_ref:snapshot.event.raw_ref,archive_revision:snapshot.event.archive_revision,
    time_range:{kind:'interval' as const,timebase_id:'utc_epoch_ms',start_ms:map.offset_ms+range.start_ms,end_ms:map.offset_ms+range.end_ms},clock_maps:[map]}};
}
