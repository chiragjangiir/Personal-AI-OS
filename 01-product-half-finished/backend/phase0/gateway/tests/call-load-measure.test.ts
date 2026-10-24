/** Opt-in, offline source-composition measurement. No servers, devices or remote provider calls.
 * Marker VAD and controlled D replace interpretation; optional native audio inference runs on those candidates. Production storage,
 * admission, ambient candidates, camera conversion/JPEG/ffmpeg, PCM pacing and teardown run unchanged.
 * CALL_LOAD_MEASURE=1 node --test tests/call-load-measure.test.ts; one process per case for isolation.
 * CALL_LOAD_CYCLES=3 CALL_LOAD_IDLE_MS=10000 reuses one parent/runtime through ambient idle and three calls.
 * CALL_LOAD_NATIVE=1 uses production-pinned speech models on existing candidates/call PCM; turn/vision/provider remain excluded.
 * Family RSS includes all sampled descendants and native worker threads once in the parent.
 * Burst cadence is a stress scenario; 416 pages/20 min does not establish sustained 60 ms delivery.
 */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VideoFrame,VideoBufferType,TrackKind,TrackSource,RoomEvent,dispose} from '@livekit/rtc-node';
import {ReadableStream} from 'node:stream/web';
import {createVoiceCallSession} from '../src/voice-call-session.ts';
import {createViduComponentPlayout,RENDER_MS} from '../src/vidu-component-playout.ts';
import {createCallCamera,lumaGrid} from '../src/personal-aios-call-camera.ts';
import {callVideoResourcesSnapshot} from '../src/call-video-encoder.ts';
import {HealthStore} from '../../../services/personal-aios-integration/src/health/store.ts';
import {CareAuthority} from '../../../services/personal-aios-integration/src/care/authority.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {StreamArchive} from '../../../services/personal-aios-integration/src/stream-archive.ts';
import {MediaProcessor} from '../../../services/personal-aios-integration/src/media/processing.ts';
import {MediaService} from '../../../services/personal-aios-integration/src/media/service.ts';
import {PersonalAIOSRuntime,RunAdmission} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {OutputAuthority} from '../../../services/personal-aios-integration/src/output.ts';
import {sha256,ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import {PHONE_CAPABILITIES} from '../../../services/personal-aios-integration/src/source-authority.ts';
import {controlledDetector,testJournal} from '../../../services/personal-aios-integration/tests/speech-fixture.ts';

import {createCallVideoEncoder} from '../src/call-video-encoder.ts';
import {createFormalPcmIngress} from '../src/personal-aios-formal-pcm.ts';
import {createSourceMediaClock} from '../src/source-media-clock.ts';
import {callLoadFamilyProbe} from './call-load-family-probe.ts';
import {selectedAudioTimeline} from '../../../services/personal-aios-integration/src/media/sample-timeline.ts';
after(()=>{if(enabled)dispose();});
const enabled=process.env.CALL_LOAD_MEASURE==='1';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const summary=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return {count:s.length,total_ms:s.reduce((a,b)=>a+b,0),p99_ms:s[Math.floor(s.length*.99)]??0,max_ms:s.at(-1)??0};};
test('offline mixed live-call load measurement',{skip:!enabled},async t=>{
  const formal=process.env.CALL_LOAD_FORMAL==='1',soak=process.env.CALL_LOAD_SOAK==='1',nativeAudio=process.env.CALL_LOAD_NATIVE==='1';
  if(nativeAudio)assert.ok(formal&&process.env.PAIOS_MODEL_ROOT,'native measurement requires formal PCM and an explicit existing model root');
  const cycles=Number(process.env.CALL_LOAD_CYCLES??1),idleMs=Number(process.env.CALL_LOAD_IDLE_MS??(cycles>1?10000:0));
  assert.ok(Number.isInteger(cycles)&&cycles>=1&&cycles<=3);assert.ok(Number.isFinite(idleMs)&&idleMs>=0&&idleMs<=60000);
  const production=JSON.parse((await readFile(new URL('../../../../../deploy/cloud/cloud.json',import.meta.url),'utf8')).replaceAll('${PAIOS_MODEL_ROOT}',process.env.PAIOS_MODEL_ROOT??''));
  const duration=Number(process.env.CALL_LOAD_DURATION_MS??12000),mode=process.env.CALL_LOAD_CASE??'mixed';
  assert.ok(Number.isFinite(duration)&&duration>0&&duration<=120000);
  const useHealth=mode==='mixed'||mode==='health',useCamera=mode==='mixed'||mode==='camera',useAmbient=mode==='mixed'||mode==='ambient';
  const root=await mkdtemp(join(tmpdir(),'paios-call-load-')),times:Record<string,number[]>={},errors:string[]=[],jobs=new Set<Promise<unknown>>();
  let phase='setup',call:ReturnType<typeof createVoiceCallSession>|undefined;
  const failuresByPhase:Record<string,Record<string,number>>={};
  const record=(name:string,ms:number)=>(times[name]??=[]).push(ms);
  const timed=async<T>(name:string,work:()=>Promise<T>|T)=>{const at=performance.now();try{return await work();}finally{record(name,performance.now()-at);}};
  const fail=(error:unknown)=>{const code=String((error as any)?.code??(error as Error)?.message??error);errors.push(code);
    const bucket=failuresByPhase[`${phase}:${call?.pending()?'busy':'idle'}`]??={};bucket[code]=(bucket[code]??0)+1;};
  const startJob=(work:Promise<unknown>)=>{jobs.add(work);void work.catch(fail).finally(()=>jobs.delete(work));};
  const ownerDataBytes=Number(process.env.CALL_LOAD_OWNER_BYTES??production.max_read_bytes);
  const storage=new PosixStorage(join(root,'storage')),ab={max_chunk_bytes:1000000,max_total_bytes:64000000,max_chunks:2000,max_revisions:2000,max_seq:2000};
  const archive=new RawArchive(storage,1000000,undefined,ab),streamArchive=new StreamArchive(storage,ab),journal=await testJournal(t);
  const speechModule=nativeAudio?await import('../../../services/personal-aios-integration/src/voiceprint/engine.ts'):undefined;
  const speech=speechModule?await speechModule.LocalSpeechEngine.open(speechModule.parseLocalSpeechConfig(production.pcm.media.audio.config)):undefined;
  t.after(async()=>{await speech?.close();});
  let nativeCandidates=0,nativeSamples=0,nativeEmbeddings=0,nativeShortEmbeddings=0;
  let analyses=0;const worker={effects:'pure_analysis' as const,analyze:async(request:any,signal:AbortSignal)=>{analyses++;
    if(speech){
      const groups=selectedAudioTimeline(request);assert.equal(groups.length,1);const group=groups[0]!;
      assert.equal(group.sample_rate,16000);assert.ok(group.total_samples<=160000);
      const bytes=Buffer.concat(group.views.map(view=>Buffer.from(view.bytes))),samples=new Float32Array(group.total_samples);
      for(let n=0;n<samples.length;n++)samples[n]=bytes.readInt16LE(n*2)/32768;
      await timed('native_asr',()=>speech.transcribe(samples,signal));await timed('native_tag',()=>speech.tag(samples,signal));
      // Preserve the native readiness result, as SherpaAudioWorker does for a short final fragment.
      try{await timed('native_embed',()=>speech.embed(samples,signal));nativeEmbeddings++;}
      catch(error){if(error instanceof ContractError&&error.code==='SPEECH_INPUT_TOO_SHORT')nativeShortEmbeddings++;else throw error;}
      await timed('native_kws',async()=>{const kws=await speech.keywords!.open(signal);
        try{for(let at=0;at<samples.length;at+=1600)await kws.write(samples.subarray(at,at+1600));await kws.finish();}finally{await kws.close();}});
      nativeCandidates++;nativeSamples+=samples.length;
    }
    return {event_id:request.event_id,segment_id:request.segment_id,
    archive_revision:request.archive_revision,time_range:request.time_range,content:{transcript:'controlled ambient candidate'},speakers:[],warnings:['CONTROLLED_NOT_MODEL'],status:'partial' as const};}};
  const capability={id:'controlled',version:'fixture',modalities:['audio'],formats:['pcm_s16le:16000:1'],joint_av:false,healthy:true,permitted:true,max_duration_ms:10000,execution:'local',evidence:'deterministic_replay'} as const;
  const processingTimeout=nativeAudio?production.pcm.media.processing.timeout_ms:10000;
  const processor=new MediaProcessor(storage,new Map([['controlled',worker]]),{policy_version:'load-fixture',max_inflight:1,max_input_bytes:1000000,timeout_ms:processingTimeout,allow_external:false,allow_replay:true,allow_partial:true});
  const media=new MediaService({storage,archive,streamArchive,processor,capabilities:async()=>[capability as never],fixtureOnly:true,clockEvidence:'synthetic',
    align:{max_chunks:2000,max_visual_refs:10,max_frame_gap_ms:100,max_uncertainty_ms:2},max_segments:16,max_window_ms:10000,
    continuous:{detector:controlledDetector(),budget:formal?production.pcm.continuous.budget:{max_streams:2,max_pending_chunks:16,max_pending_candidates:16,max_chunk_bytes:1000000,block_samples:160000,overlap_samples:8000},onError:fail}});
  const native={create:async()=>{throw new Error('UNEXPECTED_NATIVE_RUN');},status:async()=>{throw new Error('UNEXPECTED_NATIVE_STATUS');},cancel:async()=>{throw new Error('UNEXPECTED_NATIVE_CANCEL');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:16,max_pending_bytes:1000000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'load-fixture'});
  const health=HealthStore.open(join(root,'health')),care=CareAuthority.open(join(root,'care'));
  const epoch=Date.now();
  const runtime:PersonalAIOSRuntime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),media,health,care,ambient_journal:journal,realtime_busy:()=>call?.pending()!==undefined,audio_route:async(_source,event)=>formal?pcm?.route(event):undefined,call_heard:(_p,_d,span)=>call?.heard(span)===true,
    devices:[{principal_id:'owner',device_id:'phone',device_type:'phone',capabilities:PHONE_CAPABILITIES,consent_ref:'fixture',channel:'fixture',route_version:'fixture',output_modes:['text'],token_sha256:sha256('load-token')}],skill:'controlled',max_read_bytes:ownerDataBytes,
    continuous_context:async(_s,_e,chunk)=>({session:'load',clock_maps:[{modality:'audio',track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:epoch,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture-clock'}]})});
  const source=await runtime.authenticate('load-token');
  const diagnostics={stdout:{} as Record<string,number>,stderr:{} as Record<string,number>};
  const tap=(stream:NodeJS.WriteStream,codes:Record<string,number>)=>{const original=stream.write;stream.write=function(chunk:any,...rest:any[]){for(const code of String(chunk).match(/\b(?:VOICE_CALL|FORMAL_PCM|CONTINUOUS|CALL_VIDEO|CALL_CAMERA|OWNER_DATA|VIDU_COMPONENT)_[A-Z0-9_]+\b/gu)??[])codes[code]=(codes[code]??0)+1;return original.apply(stream,[chunk,...rest] as any);} as typeof stream.write;return()=>{stream.write=original;};};
  const restoreStdout=tap(process.stdout,diagnostics.stdout),restoreStderr=tap(process.stderr,diagnostics.stderr);
  const ingest=health.ingest.bind(health);health.ingest=(...args)=>{const at=performance.now();try{return ingest(...args);}finally{record('health_store_sync',performance.now()-at);}};
  const synced=care.synced.bind(care);care.synced=(...args)=>{const at=performance.now();try{return synced(...args);}finally{record('care_sync',performance.now()-at);}};
  let healthAcked=0,healthStored=0,healthReplayed=0,vadFrames=0,vadSamples=0,pcmFrames=0;const rejectedHealth:number[]=[],memorySamples:unknown[]=[];let familyPeak={parent_rss:0,child_rss:0,total_rss:0,processes:[] as unknown[]};
  const healthBatch=(n:number)=>{const now=epoch+n*60;return {control_id:`batch-${n}`,metric:'stepCount',unit:'count',tz:'UTC',sources:['phone'],deleted:[],samples:Array.from({length:64},(_,i)=>({id:`00000000-0000-0000-0000-${String(n*100+i).padStart(12,'0')}`,s:now-1000,e:now,src:0,v:i}))};};
  const offerHealth=async(n:number)=>{const receipt=await runtime.ingestHealth(source,healthBatch(n),'load');assert.equal(receipt.stored,64);healthAcked++;healthStored+=receipt.stored;};
  let emit!:(event:any)=>void,paused=false,wire:any[]=[],sentSamples=0,healthSeq=0,ambientSeq=0,audioSeq=0,cameraSeq=0,archivedFrames=0;
  const gaps:number[]=[];let lastSend=0;
  const listeners=new Map<string,(...args:any[])=>void>();
  const socket={readyState:1,bufferedAmount:0,on:(event:string,fn:(...args:any[])=>void)=>{listeners.set(event,fn);return socket;},off:()=>socket,ping:()=>{},
    send:(packet:string|Buffer)=>{if(typeof packet==='string'){if(JSON.parse(packet).type===1)listeners.get('message')?.(JSON.stringify({type:2,payload:{conn_init_ack:{success:true}}}));return;}
      const now=performance.now();if(lastSend)gaps.push(now-lastSend);lastSend=now;sentSamples+=packet.length/2;},terminate:()=>socket.close(),close:()=>{socket.readyState=3;listeners.get('close')?.();}};
  const deliver=()=>{while(!paused&&wire.length)emit(wire.shift());};
  call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},componentVideo:true,...(formal?{turns:{config:{enabled:true,model:{path:'/fixture',sha256:'0'.repeat(64)},thinking_sound:{path:'/fixture',sha256:'0'.repeat(64),model:'fixture',voice:'fixture'}},score:async()=>1,thinking:new Int16Array(480)},identifySpeech:async()=>false,transcribeSpeech:async()=>'',classifySpeech:async()=>({stop:false,guests:'unchanged' as const}),openVad:async(signal:AbortSignal)=>{
      const vad=await speech?.openCallVad(signal),kws=await speech?.openCallKeywords(signal);
      return {write:async(samples:Float32Array)=>{vadFrames++;vadSamples+=samples.length;
        const events=vad?await vad.write(samples):[];if(kws)await kws.write(samples);return events;},
        close:async()=>{await vad?.close();await kws?.close();}};
    }}:{}),
    createPlayout:(_room,id,_reset,onError,_mode,budget)=>createViduComponentPlayout({id,budget,apiKey:'fixture',onMedia:async()=>{},onEnded:()=>{},onError,
      configuration:{provider:'vidu_component',api_key_file:'/fixture',base_url:'https://fixture.invalid',avatar_id:'avatar',component_model:'fixture',action_library_id:'fixture'},
      fetch:async(_url,init)=>init&&'method' in init&&init.method==='POST'?Response.json({live:{id:'fixture'},managed_rtc:{provider:'artc',app_id:'a',channel_id:'c',user_id:'u',token:'fixture',token_expire_at:'2000000000'}}):Response.json({live:{status:'ended',billed_seconds:0,credits_cost:0}}),
      connect:()=>{setImmediate(()=>listeners.get('open')?.());return socket as never;}}),
    createFront:callbacks=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({}),context:async()=>({}),close:()=>{},cancel:()=>{wire=[];},setOutputPaused:value=>{paused=value;if(!value)setImmediate(deliver);}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:fail});
  // Match call-video-encoder.test.ts pipe fixture; native x264 unavailable on this host.
  const fakeEncoder=join(root,'pipe-encoder');await writeFile(fakeEncoder,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.end(Buffer.alloc(8)));\n`);await chmod(fakeEncoder,0o700);
  const cameraListeners=new Map<string,(...args:any[])=>void>(),room={on:(e:string,f:any)=>cameraListeners.set(e,f),off:(e:string)=>cameraListeners.delete(e),remoteParticipants:new Map()};
  let cameraController:any;const camera=createCallCamera({participant:{roomPort:room} as never,sink:()=>()=>{},onError:fail,
    encoderFactory:(id,archive,project)=>createCallVideoEncoder(id,archive,process.env.CALL_LOAD_FFMPEG??fakeEncoder,project),
    archive:async segment=>{await timed('camera_archive',()=>writeFile(join(root,`segment-${segment.startedAt}.h264`),segment.bytes));archivedFrames+=segment.frameCount;},
    streamFactory:()=>new ReadableStream({start:c=>{cameraController=c;}})});
  let pcmController:any;const pcmListeners=new Map<string,(...args:any[])=>void>();
  const pcmRoom={on:(e:string,f:any)=>pcmListeners.set(e,f),off:(e:string)=>pcmListeners.delete(e),remoteParticipants:new Map(),isConnected:true};
  const pcmBinding={continuityId:'load',connectionEpoch:'1',userId:'owner',deviceId:'phone',purpose:'fixture',realtimeSessionRef:{ref_id:'fixture'},deviceLeaseRef:{ref_id:'fixture'}};
  const pcm:ReturnType<typeof createFormalPcmIngress>|undefined=formal?createFormalPcmIngress({participant:{roomPort:pcmRoom} as never,runtime,authority:{credentialForBootstrap:()=> 'load-token',capture:async()=>({binding:pcmBinding,trusted:source}),authenticate:async()=>source} as never,
    finishArchived:async snapshot=>{await runtime.finishContinuousMedia(snapshot.event,snapshot.chunk);},
    input_contract:production.pcm.input_contract,budget:production.pcm.budget,max_archive_chunk_bytes:1000000,onError:fail,
    clock:createSourceMediaClock(storage,{evidence:'synthetic',resolve:async(_binding,chunk)=>({modality:'audio',track_id:chunk.track_id,stream_epoch:chunk.stream_epoch,source_timebase_id:chunk.source_range.timebase_id,target_timebase_id:'utc_epoch_ms',offset_ms:epoch,drift_ppm:0,uncertainty_ms:1,basis_ref:'fixture'})}),
    streamFactory:()=>new ReadableStream({start:c=>{pcmController=c;}})}):undefined;
  pcm?.tap((samples,receipt)=>call!.pushPcm(samples,receipt));
  const originalConvert=VideoFrame.prototype.convert;
  VideoFrame.prototype.convert=function(type){const at=performance.now();try{return originalConvert.call(this,type);}finally{record(`convert_${type}`,performance.now()-at);}};
  const width=Number(process.env.CALL_LOAD_WIDTH??1280),height=Number(process.env.CALL_LOAD_HEIGHT??720),fps=Number(process.env.CALL_LOAD_FPS??30);
  const probe=new Uint8Array(width*height).fill(100);for(let n=0;n<100;n++){const at=performance.now();lumaGrid(probe,width,height);record('luma_grid_probe',performance.now()-at);}
  const pixels=new Uint8Array(width*height*4).fill(100);for(let n=3;n<pixels.length;n+=4)pixels[n]=255;
  const timers:NodeJS.Timeout[]=[];const repeat=(ms:number,fn:()=>void)=>timers.push(setInterval(fn,ms));
  let peak=process.memoryUsage(),peakJobs=0,peakCamera=callVideoResourcesSnapshot();const before=process.memoryUsage();
  const histogram=monitorEventLoopDelay({resolution:1}),liveHistogram=monitorEventLoopDelay({resolution:1});histogram.enable();
  const liveDelays:{cycle:number;p99_ms:number;max_ms:number}[]=[];
  const started=performance.now();let healthAckedDuringCall=0,loadEnd=started,during=process.memoryUsage(),resources=callVideoResourcesSnapshot();
  const phaseResources=()=>({camera:camera.snapshot(),video:callVideoResourcesSnapshot(),pcm:pcm?.snapshot(),call:call?.resourceSnapshot(),continuous:runtime.continuousMedia().snapshot(),jobs:jobs.size,speech:speech?.resourceSnapshot(),native_candidates:nativeCandidates,native_samples:nativeSamples,native_embeddings:nativeEmbeddings,native_short_embeddings:nativeShortEmbeddings});
  const nativeScope=nativeAudio?'real pinned native ASR/tagging/embedding, finite ambient KWS, dedicated call VAD/KWS; Smart Turn/vision/provider models excluded':'controlled source composition; native speech/turn/vision/provider model baselines excluded';
  const family=(soak||cycles>1)?callLoadFamilyProbe(()=>({phase,resources:phaseResources()}),fail,nativeScope):undefined;
  const phaseEnds:unknown[]=[],encoderPids=new Map<number,Set<number>>(),workerPids=new Map<number,Set<number>>();
  const checkpoint=async(name:string)=>{phase=name;await family?.sample();};
  const rates:unknown[]=[];let callStarted=0,callCamera=0,callHealth=0,pcmStarted=0,pcmElapsed=0,maxCameraCatchup=0,maxHealthCatchup=0,maxPcmCatchup=0;
  const producerWorst:Record<string,{duration_ms:number;count:number;samples:number;bytes:number;phase:string;at_ms:number}>={};
  const producerTime=(name:string,at:number,count:number,samples:number,bytes:number)=>{
    if(!count)return;const duration_ms=performance.now()-at;record(name,duration_ms);
    if(!producerWorst[name]||duration_ms>producerWorst[name]!.duration_ms)producerWorst[name]={duration_ms,count,samples,bytes,phase,at_ms:at-started};
  };
  const offerCallInputs=(complete=false)=>{
    if(!phase.startsWith('call-'))return;
    const elapsed=complete?duration:Math.min(duration,performance.now()-callStarted),cameraTarget=useCamera?Math.floor(elapsed*fps/1000):0,healthTarget=useHealth?Math.floor(elapsed/60):0;
    maxCameraCatchup=Math.max(maxCameraCatchup,cameraTarget-callCamera);maxHealthCatchup=Math.max(maxHealthCatchup,healthTarget-callHealth);
    const cameraAt=performance.now(),cameraCount=cameraTarget-callCamera;
    while(callCamera<cameraTarget){callCamera++;cameraSeq++;pixels[0]=cameraSeq%255;
      cameraController.enqueue({frame:new VideoFrame(pixels.slice(),width,height,VideoBufferType.RGBA),rotation:0,timestampUs:BigInt(callCamera)*BigInt(Math.round(1000000/fps))});}
    producerTime('source_camera_sync',cameraAt,cameraCount,cameraCount,cameraCount*pixels.byteLength);
    const healthAt=performance.now(),healthCount=healthTarget-callHealth;
    while(callHealth<healthTarget){callHealth++;const n=++healthSeq;startJob(timed('runtime_health',()=>offerHealth(n)).catch(error=>{if((error as any)?.code==='OWNER_DATA_INGEST_BACKLOG')rejectedHealth.push(n);throw error;}));}
    producerTime('source_health_sync',healthAt,healthCount,healthCount*64,0);
  };
  const offerPcm=()=>{pcmElapsed=performance.now()-pcmStarted;if(!pcm)return;const target=Math.floor(pcmElapsed/100);
    maxPcmCatchup=Math.max(maxPcmCatchup,target-pcmFrames);const at=performance.now(),count=target-pcmFrames;
    while(pcmFrames<target){pcmFrames++;pcmController.enqueue({data:new Int16Array(1600),sampleRate:16000,channels:1,samplesPerChannel:1600});}
    producerTime('source_pcm_sync',at,count,count*1600,count*1600*2);
  };
  try{
    if(pcm){await pcm.onBootstrapConnected({bearer:{deviceId:'phone'},enabledMedia:{audio:true},currentBinding:{credentialIdentity:'phone',connectionEpoch:'1'}} as never);pcmListeners.get(RoomEvent.TrackSubscribed)!({sid:'fixture-mic'},{kind:TrackKind.KIND_AUDIO,source:TrackSource.SOURCE_MICROPHONE,sid:'fixture-mic'},{identity:'phone'});}
    repeat(25,()=>{if(!phase.startsWith('call-')||soak&&paused)return;wire.push({type:'response.audio.delta',response_id:'reply',delta:Buffer.from(new Int16Array(2400).fill(++audioSeq).buffer).toString('base64')});deliver();});
    if(useHealth||useCamera)repeat(Math.min(60,1000/fps),offerCallInputs);
    pcmStarted=performance.now();if(pcm)repeat(100,offerPcm);
    if(useAmbient)repeat(250,()=>startJob(timed('ambient_append',async()=>{const n=ambientSeq++,samples=4096,payload=Buffer.alloc(samples*2);
      // Native measurement uses 1.024 s marker bursts and 0.512 s silence; the short controlled baseline stays unchanged.
      const voiced=nativeAudio?(n%6<4?samples:0):2048;for(let i=0;i<voiced;i++)payload.writeInt16LE(1,i*2);
      await runtime.appendMedia({schema_version:'paios.event.v1',event_id:'ambient-load',device_id:'phone',device_type:'phone',captured_at:new Date(epoch).toISOString(),source:{channel:'fixture'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload},source,
        {track_id:'mic',stream_epoch:'load',seq:n,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'load',start_ms:n*samples/16,end_ms:(n+1)*samples/16}});})));
    repeat(100,()=>{const m=process.memoryUsage();for(const key of Object.keys(m) as (keyof typeof m)[])peak[key]=Math.max(peak[key],m[key]);peakJobs=Math.max(peakJobs,jobs.size);memorySamples.push({at_ms:Math.round(performance.now()-started),phase,rss:m.rss,external:m.external,jobs:jobs.size});const r=callVideoResourcesSnapshot();
      if(phase.startsWith('call-')){const cycle=Number(phase.slice(5)),pids=encoderPids.get(cycle)??new Set<number>();for(const pid of r.encoder_pids)pids.add(pid);encoderPids.set(cycle,pids);
        const workers=workerPids.get(cycle)??new Set<number>(),worker=camera.snapshot()?.transform.pid;if(worker)workers.add(worker);workerPids.set(cycle,workers);}if(r.queued_bytes>peakCamera.queued_bytes)peakCamera=r;});
    if(idleMs){await checkpoint('ambient-idle');await sleep(idleMs);phaseEnds.push({phase,...phaseResources(),analyses});
      if(useAmbient&&idleMs>=1000)assert.ok(analyses>0,'idle ambient must exercise the existing controlled C/D analysis path');}
    for(let cycle=1;cycle<=cycles;cycle++){
      await checkpoint(`setup-${cycle}`);socket.readyState=1;lastSend=0;
      await call!.open(`load-${cycle}`,{video:true});emit({type:'response.created',response:{id:'reply'}});
      if(useCamera){await camera.onBootstrapConnected({enabledMedia:{video:true},currentBinding:{credentialIdentity:'phone'}} as never);
        cameraListeners.get(RoomEvent.TrackSubscribed)!({sid:`fixture-camera-${cycle}`},{kind:TrackKind.KIND_VIDEO,source:TrackSource.SOURCE_CAMERA,muted:false},{identity:'phone'});await sleep(20);}
      phase=`call-${cycle}`;callStarted=performance.now();callCamera=callHealth=0;liveHistogram.reset();liveHistogram.enable();
      const ackBefore=healthAcked;await sleep(duration);offerCallInputs(true);liveHistogram.disable();healthAckedDuringCall+=healthAcked-ackBefore;
      const requestedCamera=useCamera?Math.floor(duration*fps/1000):0,requestedHealth=useHealth?Math.floor(duration/60):0,elapsed=performance.now()-callStarted;
      rates.push({cycle,requested_duration_ms:duration,elapsed_ms:elapsed,camera:{requested:requestedCamera,offered:callCamera,offered_per_s:callCamera*1000/elapsed},health:{requested:requestedHealth,offered:callHealth,offered_per_s:callHealth*1000/elapsed}});
      assert.ok(callCamera>=requestedCamera);assert.ok(callHealth>=requestedHealth);
      liveDelays.push({cycle,p99_ms:liveHistogram.percentile(99)/1e6,max_ms:liveHistogram.max/1e6});
      loadEnd=performance.now();during=process.memoryUsage();resources=callVideoResourcesSnapshot();phaseEnds.push({phase,...phaseResources(),analyses});
      await checkpoint(`drain-${cycle}`);
      if(useCamera)await camera.onBootstrapConnected({enabledMedia:{video:false},currentBinding:{credentialIdentity:'phone'}} as never);
      await call!.closeAll();await Promise.allSettled([...jobs]);
      while(healthReplayed<rejectedHealth.length){await timed('health_replay',()=>offerHealth(rejectedHealth[healthReplayed]!));healthReplayed++;}
      await runtime.continuousMedia().drain();
      const analysesBeforeIdle=analyses;await checkpoint(`idle-${cycle}`);await sleep(idleMs);await family?.sample();
      if(useAmbient&&idleMs>=1000)assert.ok(analyses>analysesBeforeIdle,'ambient analysis must resume after each call in the same runtime');
      const idleResources=phaseResources();phaseEnds.push({phase,...idleResources,analyses});
      assert.equal(idleResources.video.readers,0);assert.equal(idleResources.video.encoders,0);assert.equal(call!.pending(),undefined);assert.equal(idleResources.camera,null);
      if(useCamera&&duration>=1000){assert.equal(workerPids.get(cycle)?.size,1,'one transform worker per camera track/call, not per frame');
        const alive=family?.report().samples.at(-1)?.previously_observed_children_still_alive??[];
        assert.ok(!alive.some((pid:number)=>workerPids.get(cycle)!.has(pid)),'the observed worker process exits after each call');}

    }
    offerPcm();for(const timer of timers)clearInterval(timer);await family?.sample();await family?.stop();
    const familyReport=family?.report();for(const row of familyReport?.samples??[])if(row.total_rss>familyPeak.total_rss)familyPeak={parent_rss:row.parent_rss,child_rss:row.child_rss,total_rss:row.total_rss,processes:row.processes.map((item:any)=>[item.pid,item.ppid,item.rss/1024])};
    histogram.disable();
    await pcm?.close();const pcmAfter=pcm?.snapshot();await camera.close();await call!.closeAll();await Promise.allSettled([...jobs]);const initiallyAcked=healthAcked-healthReplayed;for(let n=1;n<=healthSeq;n++){const samples=healthBatch(n).samples,rows=health.records('owner','stepCount',samples.map(s=>s.id)).sort((a,b)=>a.sample_id.localeCompare(b.sample_id));assert.deepEqual(rows.map(row=>({id:row.sample_id,s:row.start_ms,e:row.end_ms,v:row.value})),samples.map(({id,s,e,v})=>({id,s,e,v})));}await runtime.continuousMedia().drain();await runtime.close();await processor.close();health.close();const continuousAfter=runtime.continuousMedia().snapshot();
    if(nativeAudio){assert.ok(nativeCandidates>0,'native audio measurement must complete real selected-PCM inference');assert.ok(nativeEmbeddings>0,'native measurement must complete at least one ready speaker embedding');}
    const codes=Object.fromEntries([...new Set(errors)].map(code=>[code,errors.filter(e=>e===code).length]));
    for(const code of ['CONTINUOUS_CONTROL_BACKLOG','CONTINUOUS_CHUNK_BACKLOG','CONTINUOUS_CANDIDATE_BACKLOG','VOICE_CALL_PCM_CAPACITY','VIDU_COMPONENT_PLAYOUT_FAILED','CALL_VIDEO_BACKPRESSURE_FRAME_DROPPED','OWNER_DATA_INGEST_BACKLOG'])codes[code]??=0;
    const result={mode,soak,cycles,input_rates:{producer_worst:producerWorst,calls:rates,pcm:{elapsed_ms:pcmElapsed,requested_frames:pcm?Math.floor(pcmElapsed/100):0,offered_frames:pcmFrames,offered_samples_per_s:pcmFrames*1600*1000/pcmElapsed},max_catchup_batch:{camera:maxCameraCatchup,health:maxHealthCatchup,pcm:maxPcmCatchup}},native_audio:{enabled:nativeAudio,scope:nativeScope,completed_candidates:nativeCandidates,candidate_samples:nativeSamples,completed_embeddings:nativeEmbeddings,too_short_embeddings:nativeShortEmbeddings,processor_timeout_ms:processingTimeout,threads:nativeAudio?production.pcm.media.audio.config.num_threads:undefined,snapshot:speech?.resourceSnapshot()},idle_ms:idleMs,phase_ends:phaseEnds,worker_pid_generations:Object.fromEntries([...workerPids].map(([cycle,pids])=>[cycle,[...pids]])),encoder_pid_generations:Object.fromEntries([...encoderPids].map(([cycle,pids])=>[cycle,[...pids]])),scripted_wire_pending:wire.length,duration_ms:loadEnd-started,assumptions:{owner_data_budget_bytes:ownerDataBytes,formal_budget:formal?production.pcm.budget:undefined,health_samples_per_page:64,health_interval_ms:60,health_burst_duty_cycle:'continuous stress; observed 416/20min average is 0.347 pages/s',camera:{width,height,fps,input:'RGBA fixture; network decode excluded',recording:process.env.CALL_LOAD_FFMPEG?'real ffmpeg':'pipe fixture; x264 CPU excluded (available ffmpeg audio-only)'},ambient:nativeAudio?'controlled marker VAD; real candidate PCM ASR/tag/embed/finiteKWS; controlled D + real C/D storage+journal':'controlled VAD+analysis; real C/D storage+journal'},
      diagnostic_codes:diagnostics,failures_by_phase:failuresByPhase,continuous_after:continuousAfter,input_pcm:formal?{offered_frames:pcmFrames,offered_samples:pcmFrames*1600,vad_frames:vadFrames,vad_samples:vadSamples,archive:'real StreamArchive fixtureOnly; central credential fence + durable ingress excluded',after:pcmAfter,inference:nativeAudio?'native dedicated call VAD/KWS on the existing call PCM lane':'controlled silent VAD; no native model'}:'not exercised in comparable baseline',event_loop:{p99_ms:histogram.percentile(99)/1e6,max_ms:histogram.max/1e6,live_calls:liveDelays,live_max_p99_ms:Math.max(...liveDelays.map(value=>value.p99_ms)),live_max_ms:Math.max(...liveDelays.map(value=>value.max_ms))},work:Object.fromEntries(Object.entries(times).map(([key,value])=>[key,summary(value)])),
      counts:{health_pages:healthSeq,health_acked:healthAcked,health_initially_acked:initiallyAcked,health_replayed:healthReplayed,health_stored:healthStored,health_acked_during_call:healthAckedDuringCall,ambient_chunks:ambientSeq,analyses,camera_frames:cameraSeq,archived_frames:archivedFrames,audio_samples_sent:sentSamples},wire_gap:summary(gaps),codes,memory:{before,peak,during,after:process.memoryUsage(),peak_jobs:peakJobs,family_peak:familyPeak,family:familyReport,samples:memorySamples},camera:{peak:peakCamera,at_load_end:resources,after:callVideoResourcesSnapshot()}};
    restoreStdout();restoreStderr();console.log('CALL_LOAD_RESULT '+JSON.stringify(result));assert.equal(initiallyAcked+(codes.OWNER_DATA_INGEST_BACKLOG??0),healthSeq);assert.equal(healthAcked,healthSeq);assert.deepEqual(continuousAfter,{streams:0,pending_control:0,pending_chunks:0,pending_candidates:0});if(formal){assert.ok(pcmFrames>=Math.floor(pcmElapsed/100));assert.ok(vadFrames>0);assert.equal(pcmAfter?.pending_frames,0);assert.equal(pcmAfter?.pending_bytes,0);assert.equal(pcmAfter?.processing_pending_frames,0);}assert.equal(healthStored,healthAcked*64);assert.ok(result.event_loop.live_max_p99_ms<RENDER_MS,`live-call p99 loop delay exceeds renderer reserve ${RENDER_MS} ms`);assert.equal(result.camera.after.received_frames,cameraSeq);assert.equal(archivedFrames+result.camera.after.dropped_frames,cameraSeq);if(useCamera)assert.ok(archivedFrames>0);assert.equal(result.camera.after.readers,0);assert.equal(result.camera.after.encoders,0);assert.ok(errors.every(code=>['OWNER_DATA_INGEST_BACKLOG','CALL_VIDEO_BACKPRESSURE_FRAME_DROPPED','FORMAL_PCM_APPEND_BACKLOG','FORMAL_PCM_TAP_BACKPRESSURE','FORMAL_PCM_PROCESSING_BACKLOG','CONTINUOUS_CONTROL_BACKLOG','CONTINUOUS_CHUNK_BACKLOG','CONTINUOUS_CANDIDATE_BACKLOG','CONTINUOUS_ADMISSION_RECOVERED'].includes(code)),JSON.stringify(codes));
  }finally{restoreStdout();restoreStderr();for(const timer of timers)clearInterval(timer);await family?.stop();histogram.disable();liveHistogram.disable();VideoFrame.prototype.convert=originalConvert;await pcm?.close();await camera.close();await call!.closeAll();await Promise.allSettled([...jobs]);await runtime.continuousMedia().drain();await runtime.close();await processor.close();await speech?.close();health.close();await rm(root,{recursive:true,force:true});}
});
