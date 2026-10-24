import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {AppleWatchCredentialError} from '../../platform-data/src/apple-physical-canary-binding-postgres.ts';
import {PersonalAIOSRuntime,RunAdmission,sourceClient} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {OutputAuthority} from '../src/output.ts';
import {configureMediaReplay} from '../src/media/setup.ts';
import {FfmpegDemux} from '../src/media/ffmpeg-demux.ts';
import {LocalMediaExecution} from '../src/media/local-execution.ts';
import {createFormalVoiceAuthority} from '../src/voice/formal-authority.ts';
import {ContractError,digest,type ProcessedEvent} from '../src/contracts.ts';
import {sourceSnapshot,type RegisteredDevice,type SourceDeviceAuthority} from '../src/source-authority.ts';
import type {VoiceResources} from '../src/voice/contracts.ts';
import type {WatchAudioMetadata} from '../src/runtime.ts';
const turn='01cae96e-4a0a-4926-80f2-4a5492d71383';
const metadata:WatchAudioMetadata={codec:'aac_lc',sample_rate_hz:16000,channels:1,duration_ms:1000,mime:'audio/mp4'};
const source=sourceSnapshot({principal_id:'owner',device_id:'watch',device_type:'watch',consent_ref:'consent',channel:'watch_https',
 relay_device_id:'phone',output_target:{device_id:'phone',device_type:'phone'},output_modes:['text'],route_version:'watch-route'});
const root=resolve(import.meta.dirname,'../../../../../');
const toolchain=process.env.PAIOS_DEMUX_TOOLCHAIN??'/opt/personal-aios-runtime/toolchains/ffmpeg-8.0.3-minimal/bin';
async function fixture(t:test.TestContext,samples=16000){
 const scratch=join(root,'.scratch','watch-runtime');await mkdir(scratch,{recursive:true});
 const directory=await mkdtemp(join(scratch,'case-')),storage=new PosixStorage(join(directory,'l5'));
 const fixtureAudio=join(directory,'utterance.m4a');
 await promisify(execFile)(join(toolchain,'ffmpeg'),['-hide_banner','-nostdin','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=2','-af',`atrim=end_sample=${samples}`,'-ac','1','-c:a','aac','-profile:a','aac_low','-movie_timescale','16000','-f','mp4',fixtureAudio]);
 const bytes=await readFile(fixtureAudio);
 let opens=0,creates=0,confirmations=0,revoked=false,running=false,transcript:string|null='查询天气',allowCandidate:Promise<void>=Promise.resolve();
 const inputCommitted=Promise.withResolvers<void>();
 const logical=new Map<string,{run_id:string;session_id:string;conversation_session_id:string;status:string;output?:string}>();
 const instances:PersonalAIOSRuntime[]=[];let failNamespace='',afterWrite=false,failOnce=false;
 let pausedWrite:{namespace:string;entered:ReturnType<typeof Promise.withResolvers<void>>;release:ReturnType<typeof Promise.withResolvers<void>>}|undefined;
 const publish=storage.publish.bind(storage);
 storage.publish=async(namespace,key,value)=>{
  const pause=pausedWrite;if(pause&&namespace===pause.namespace){pause.entered.resolve();await pause.release.promise;}
  if(failOnce&&namespace===failNamespace){failOnce=false;if(afterWrite)await publish(namespace,key,value);throw Object.assign(new Error('injected storage failure'),{code:'EIO'});}
  return publish(namespace,key,value);
 };
 const authority:SourceDeviceAuthority={authenticate:async()=>source,revalidate:async value=>{if(revoked)throw new AppleWatchCredentialError('credential_revoked',403);return value;},
  verifyOutputRecipient:async(value,d)=>{assert.equal(value.device_id,'phone');assert.equal(d.source.relay_device_id,'phone');},
  withVoiceAction:async(value,_modality,work)=>{await authority.revalidate(value);return work();}};
 const opened=new Set<string>();let activeRuntime:PersonalAIOSRuntime;
 const native={create:async(body:any,key:string)=>{if(!logical.has(key)){creates++;logical.set(key,{run_id:`run-${key}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'});}return logical.get(key)!;},
  status:async(id:string)=>{const value=[...logical.values()].find(v=>v.run_id===id)!;
   if(!opened.has(id)){await activeRuntime.tool('paios_open_reply',{context:{run_id:id,session_id:'phone-session',tool_call_id:'native-open'},args:{reply_mode:'text',target_aliases:['source'],output_modes:['text']}});opened.add(id);}
   return {...value,status:running?'running':'completed',...(running?{}:{output:'同一个电话会话的回答。'})};},
  cancel:async()=>{throw new Error('wait must not cancel run');}};
 async function instance(timeout=5000){
  const execution=await LocalMediaExecution.create({runtime:directory,slots:2});
  const demux=await FfmpegDemux.create(join(toolchain,'ffmpeg'),join(toolchain,'ffprobe'),join(directory,'decoders'),
   {timeout_ms:10000,max_input_bytes:1000000,max_output_bytes:1000000,max_chunks:128,max_pixels:4096,max_metadata_bytes:1000000,max_duration_ms:30000},execution);
  const configured=await configureMediaReplay(storage,{fixture_only:true,
   stream_budget:{max_chunk_bytes:1000000,max_total_bytes:1000000,max_chunks:128,max_revisions:128,max_seq:128},
   processing:{policy_version:'watch-test',max_inflight:2,max_input_bytes:1000000,timeout_ms:timeout,allow_external:false,allow_replay:true,allow_partial:true},
   alignment:{max_chunks:128,max_visual_refs:1,max_frame_gap_ms:100,max_uncertainty_ms:1},max_segments:8,max_window_ms:100,
   windows_vision:{config:{base_url:'https://fixture.invalid',model:'controlled',timeout_ms:1000,max_frames:1,max_input_bytes:1000000,max_tokens:32}}},1000000,fetch,undefined,
   {workers:new Map(),capabilities:async()=>[],vad:{candidates:async()=>[]},demux});
  const {archive,service:media}=configured;t.after(()=>execution.close());
  const formal=createFormalVoiceAuthority(storage);
  const voice:VoiceResources={configured:true,...formal,recordConfirmation:async(...args)=>{confirmations++;return formal.recordConfirmation(...args);},onError:()=>{},
   create:callbacks=>{opens++;let active=true,pcmBytes=0;return {connect:async()=>{},appendAudio:audio=>{pcmBytes+=Buffer.from(audio,'base64').length;},
    commitInput:()=>{assert.equal(pcmBytes,samples*2);inputCommitted.resolve();void allowCandidate.then(()=>{if(!active||transcript===null)return;if(transcript==='provider-failed'){callbacks.onEvent({type:'conversation.item.input_audio_transcription.failed'});return;}callbacks.onCandidate({kind:'transcript',event:{type:'conversation.item.input_audio_transcription.completed',item_id:'first',transcript},
     connectionId:'connection',connectionEpoch:1,provider:'controlled',model:'asr',region:'fixture'});
     callbacks.onCandidate({kind:'transcript',event:{type:'conversation.item.input_audio_transcription.completed',item_id:'second',transcript:'不得采用第二候选'},
      connectionId:'connection',connectionEpoch:1,provider:'controlled',model:'asr',region:'fixture'});});},
    identity:()=>({connectionId:'connection',connectionEpoch:1}),close:()=>{active=false;},join:async()=>{}};}};
  const admission=new RunAdmission(storage,native,{max_pending_events:32,max_pending_bytes:1000000,max_event_age_ms:100000,
   poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'watch-test'});
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,sourceAuthority:authority,output:new OutputAuthority(storage),media,voice,
   skill:'watch-test',max_read_bytes:1000000,automatic_output:{onError:()=>{}}});activeRuntime=runtime;instances.push(runtime);await runtime.configureTimeline({directory:join(directory,'timeline')});
  return {runtime,admission,archive,media,execution,demux,upload:(data=bytes,meta=metadata,id=turn)=>runtime.watchUtterance(source,'phone-session','1',id,meta,data)};
 }
 t.after(async()=>{for(const runtime of instances)await runtime.close();await rm(directory,{recursive:true,force:true});});
 return {storage,bytes,instance,inputCommitted:inputCommitted.promise,counts:()=>({opens,creates,confirmations}),fail:(namespace:string,written=false)=>{failNamespace=namespace;afterWrite=written;failOnce=true;},
  holdWrite:(namespace:string)=>{const pause={namespace,entered:Promise.withResolvers<void>(),release:Promise.withResolvers<void>()};pausedWrite=pause;return {entered:pause.entered.promise,release:()=>{pausedWrite=undefined;pause.release.resolve();}};},
  transcript:(text:string|null)=>{transcript=text;},revoked:()=>{revoked=true;},running:(value:boolean)=>{running=value;},hold:()=>{const gate=Promise.withResolvers<void>();allowCandidate=gate.promise;return gate;}};
}
async function settled(predicate:()=>boolean|Promise<boolean>){for(let n=0;n<2000;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('did not settle');}
test('real AAC archives original metadata before ASR; concurrent/lost response/restart uses first transcript and one D/run',async t=>{
 const f=await fixture(t),a=await f.instance(),gate=f.hold();
 const calls=Array.from({length:8},()=>a.upload());await settled(()=>f.counts().opens===1);
 const intents=await f.storage.list('watch-turns');assert.equal(intents.length,1);
 const key=intents[0]!,intent=JSON.parse(Buffer.from(await f.storage.read('watch-turns',key)).toString());
 const archived=await a.archive.locate(`l5:${digest({principal_id:'owner',event_id:intent.operation})}`,'owner');
 assert.deepEqual(await a.archive.read(archived.raw_ref,'owner',archived.archive_revision),f.bytes);
 const info=JSON.parse(Buffer.from(await f.storage.read('original-source-metadata',archived.raw_ref.slice(3))).toString());
 assert.deepEqual(info.metadata,metadata);assert.equal(info.turn_id,turn);assert.equal(f.counts().creates,0);
 gate.resolve();const replies=await Promise.all(calls);assert.ok(replies.every(reply=>reply.status==='heard'&&reply.heard==='查询天气'));
 await settled(()=>f.counts().creates===1);assert.equal((await f.storage.list('processed-media')).length,1);
 const d=JSON.parse(Buffer.from(await f.storage.read('watch-turn-media',key)).toString()) as ProcessedEvent;
 assert.equal(d.origin,'device_observation');assert.equal(d.media_type,'audio');assert.equal(d.representation,'uploaded_original');assert.equal(d.source.channel,'watch_https');assert.equal(await a.archive.validateEvidence(d),true);
 assert.deepEqual(await a.upload(),replies[0]);await a.runtime.close();const b=await f.instance();assert.deepEqual(await b.upload(),replies[0]);
 assert.deepEqual(await b.runtime.watchTurn(source,'phone-session','1',turn),{status:'replied',turn_id:turn,text:'同一个电话会话的回答。'});
 const phone=sourceSnapshot({...source,device_type:'phone',device_id:'phone',channel:'phone-fixture',output_target:undefined,relay_device_id:undefined} as unknown as RegisteredDevice);
 const page=b.runtime.timeline!.page(phone.principal_id,{after_seq:0});assert.deepEqual(page.items.map(item=>[item.kind,item.text]),[['owner','查询天气'],['yimi','同一个电话会话的回答。']]);
 const canonicalPhone=await b.runtime.result(phone,'phone-session',d.processed_event_id,{text_replay:'sealed'});assert.equal(canonicalPhone.result.reply_text,'同一个电话会话的回答。');assert.equal((canonicalPhone.result.output_plan[0] as {target_device_id:string}).target_device_id,'phone');
 await b.runtime.watchTurn(source,'phone-session','1',turn);assert.equal(b.runtime.timeline!.page(phone.principal_id,{after_seq:0}).items.length,2);
 assert.deepEqual(f.counts(),{opens:1,creates:1,confirmations:1});
 await assert.rejects(b.upload(Buffer.concat([f.bytes,Buffer.from([0])])),/turn_conflict/);
 await assert.rejects(b.upload(f.bytes,{...metadata,duration_ms:999}),/turn_conflict/);
 await assert.rejects(b.runtime.watchTurn({...source,device_id:'other'},'phone-session','1',turn),/turn_not_found/);
});
test('no speech and invalid decoded duration retain original; frozen failure outcomes replay without ASR/run',async t=>{
 const f=await fixture(t),a=await f.instance();f.transcript('');
 assert.deepEqual(await a.upload(),{status:'failed',turn_id:turn,reason:'not_heard'});
 assert.deepEqual(await a.upload(),{status:'failed',turn_id:turn,reason:'not_heard'});assert.equal((await f.storage.list('manifests')).length,1);
 const id='831a8900-0404-462c-a471-164c7fce363d';assert.deepEqual(await a.upload(f.bytes,{...metadata,duration_ms:900},id),{status:'failed',turn_id:id,reason:'audio_invalid'});
 assert.equal((await f.storage.list('manifests')).length,2);assert.deepEqual(f.counts(),{opens:1,creates:0,confirmations:0});
});
for(const [namespace,written] of [['voice-confirmations',false],['processed-media-inputs',false],['processed-media',true],['audio-consumer-results',false],['watch-turn-media',false],['admissions',true],['watch-turn-outcomes',false]] as const){
 test(`restart recovers exact confirmation at ${namespace} ${written?'after':'before'} publication without ASR or another run`,async t=>{
  const f=await fixture(t),a=await f.instance();f.fail(namespace,written);await assert.rejects(a.upload(),/injected storage failure|ACCEPTANCE_UNKNOWN/);
  assert.deepEqual(await f.storage.list('watch-turn-outcomes'),[]);await a.runtime.close();const b=await f.instance();
  const get=await b.runtime.watchTurn(source,'phone-session','1',turn);assert.equal(get.status,'replied');
  const reply=await b.upload();assert.equal(reply.status,'heard');await settled(()=>f.counts().creates===1);
  assert.deepEqual(await b.runtime.watchTurn(source,'phone-session','1',turn),{status:'replied',turn_id:turn,text:'同一个电话会话的回答。'});
  assert.deepEqual(f.counts(),{opens:1,creates:1,confirmations:1});assert.equal((await f.storage.list('processed-media')).length,1);
 });
}
test('GET observes canonical completion; disconnect releases subscription without cancelling work; revocation remains403',async t=>{
 const f=await fixture(t),a=await f.instance();f.running(true);assert.equal((await a.upload()).status,'heard');await settled(()=>f.counts().creates===1);
 const cancel=new AbortController(),wait=a.runtime.watchTurn(source,'phone-session','1',turn,cancel.signal);await new Promise(resolve=>setImmediate(resolve));cancel.abort();
 assert.deepEqual(await wait,{status:'working',turn_id:turn});assert.equal((a.runtime as any).resultListeners.size,0);
 const reply=a.runtime.watchTurn(source,'phone-session','1',turn);await new Promise(resolve=>setImmediate(resolve));f.running(false);
 assert.equal((await reply).status,'replied');assert.equal((a.runtime as any).resultListeners.size,0);
 f.revoked();await assert.rejects(a.runtime.watchTurn(source,'phone-session','1',turn),error=>error instanceof AppleWatchCredentialError&&error.reason==='credential_revoked'&&error.status===403);
});

test('GET returns working at25 seconds and releases subscription while native processing continues',async t=>{
 const f=await fixture(t),a=await f.instance();f.running(true);assert.equal((await a.upload()).status,'heard');await settled(()=>f.counts().creates===1);
 const started=performance.now();assert.deepEqual(await a.runtime.watchTurn(source,'phone-session','1',turn),{status:'working',turn_id:turn});
 assert.ok(performance.now()-started>=24900);await settled(()=>(a.runtime as any).resultListeners.size===0);
 assert.equal(f.counts().creates,1);f.running(false);assert.equal((await a.runtime.watchTurn(source,'phone-session','1',turn)).status,'replied');
});

test('known provider ASR failure and no-transcript timeout persist frozen failures without retrying cloud',async t=>{
 for(const [text,reason] of [['provider-failed','processing_failed'],[null,'not_heard']] as const){
  const f=await fixture(t),a=await f.instance(text===null?50:5000);f.transcript(text);
  if(text===null)t.mock.timers.enable({apis:['setTimeout']});
  const upload=a.upload();if(text===null){await f.inputCommitted;t.mock.timers.tick(50);}
  assert.deepEqual(await upload,{status:'failed',turn_id:turn,reason});assert.deepEqual(await a.upload(),{status:'failed',turn_id:turn,reason});
  assert.deepEqual(await a.runtime.watchTurn(source,'phone-session','1',turn),{status:'failed',turn_id:turn,reason});
  assert.deepEqual(f.counts(),{opens:1,creates:0,confirmations:0});assert.equal((await f.storage.list('manifests')).length,1);
 }
});

test('native events abort joins an active status observation before returning',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let observed=false,ended=false;
 const native=sourceClient({
  create:async()=>{throw new Error('no create');},cancel:async()=>{throw new Error('no cancel');},
  status:async()=>{entered.resolve();await release.promise;observed=true;
   return {run_id:'run-close',session_id:'session-close',status:'running'};}
 });
 const abort=new AbortController(),events=native.events('run-close',()=>{},abort.signal).then(()=>{ended=true;});
 try{
  await entered.promise;abort.abort();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,false,'events must retain the active native observation after abort');
  release.resolve();await events;assert.equal(observed,true);assert.equal(ended,true);
 }finally{release.resolve();await events;}
});

test('real credential authority revocation during an active result poll propagates403 and releases the subscription',async t=>{
 const f=await fixture(t),a=await f.instance();f.running(true);assert.equal((await a.upload()).status,'heard');await settled(()=>f.counts().creates===1);
 const wait=a.runtime.watchTurn(source,'phone-session','1',turn);
 const rejected=assert.rejects(wait,error=>error instanceof AppleWatchCredentialError&&error.reason==='credential_revoked'&&error.status===403);
 await settled(()=>(a.runtime as any).resultListeners.size===1);f.revoked();f.running(false);await rejected;
 await settled(()=>(a.runtime as any).resultListeners.size===0);assert.equal(f.counts().creates,1);
});
test('real credential revocation inside accepted ASR confirmation propagates403 without a failed turn receipt',async t=>{
 const f=await fixture(t),a=await f.instance(),gate=f.hold();
 const upload=a.upload(),rejected=assert.rejects(upload,error=>error instanceof AppleWatchCredentialError&&error.reason==='credential_revoked'&&error.status===403);
 await settled(()=>f.counts().opens===1);f.revoked();gate.resolve();await rejected;
 assert.deepEqual(await f.storage.list('watch-turn-outcomes'),[]);assert.equal((await f.storage.list('manifests')).length,1);
 assert.deepEqual(f.counts(),{opens:1,creates:0,confirmations:0});
});

for(const samples of [15999,16001])test(`fractional-millisecond decoded PCM owns full ${samples}-sample ASR window with1000ms header`,async t=>{
 const f=await fixture(t,samples),a=await f.instance();assert.equal((await a.upload()).status,'heard');await settled(()=>f.counts().creates===1);
 const key=(await f.storage.list('watch-turn-media'))[0]!,d=JSON.parse(Buffer.from(await f.storage.read('watch-turn-media',key)).toString()) as ProcessedEvent;
 assert.equal(d.time_range.kind,'interval');if(d.time_range.kind!=='interval')assert.fail('expected interval');
 assert.equal(d.time_range.end_ms-d.time_range.start_ms,samples/16);assert.equal(d.coverage?.status,'complete');assert.equal(await a.archive.validateEvidence(d),true);
 const original=await a.archive.locate(d.raw_ref,'owner');assert.deepEqual(original.time_range,{kind:'interval',timebase_id:'watch-media',start_ms:0,end_ms:1000});
 const stored=JSON.parse(Buffer.from(await f.storage.read('original-source-metadata',d.raw_ref.slice(3))).toString());assert.equal(stored.metadata.duration_ms,1000);
 assert.deepEqual(f.counts(),{opens:1,creates:1,confirmations:1});
});

test('GET restores a heard turn after shutdown before native binding completes, without another ASR or confirmation',async t=>{
 const f=await fixture(t),a=await f.instance(),gate=f.holdWrite('run-bindings');
 try{
  assert.equal((await a.upload()).status,'heard');await gate.entered;
  const closing=a.runtime.close();await new Promise(resolve=>setImmediate(resolve));gate.release();await closing;
  assert.equal((await f.storage.list('run-terminals')).length,0);const b=await f.instance();
  assert.deepEqual(await b.runtime.watchTurn(source,'phone-session','1',turn),{status:'replied',turn_id:turn,text:'同一个电话会话的回答。'});
  assert.deepEqual(f.counts(),{opens:1,creates:1,confirmations:1});assert.equal(b.runtime.timeline!.page('owner').items.filter(item=>item.kind==='yimi').length,1);
 }finally{gate.release();}
});
for(const delivery of ['watch-get','subscription'] as const)
test(`sealed text projects the timeline before ${delivery} returns while the seal publisher is held`,{timeout:15000},async t=>{
 const f=await fixture(t),a=await f.instance(),sealed=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const publish=f.storage.publish.bind(f.storage);let journalWrites=0,stop:(()=>void)|undefined;
 f.storage.publish=async(namespace,key,value)=>{
  const stored=await publish(namespace,key,value);
  if(namespace==='output-journal'){
   journalWrites++;
   if(JSON.parse(Buffer.from(value).toString()).operation==='seal'){sealed.resolve();await release.promise;}
  }
  return stored;
 };
 const hers=()=>a.runtime.timeline!.page('owner').items.filter(item=>item.kind==='yimi');
 try{
  assert.equal((await a.upload()).status,'heard');await sealed.promise;
  assert.equal(hers().length,0);const before=journalWrites;
  if(delivery==='watch-get'){
   assert.deepEqual(await a.runtime.watchTurn(source,'phone-session','1',turn),{status:'replied',turn_id:turn,text:'同一个电话会话的回答。'});
  }else{
   const outcome=JSON.parse(Buffer.from(await f.storage.read('watch-turn-outcomes',(await f.storage.list('watch-turn-outcomes'))[0]!)).toString());
   const received=Promise.withResolvers<void>();
   stop=await a.runtime.subscribeResult(source,'phone-session',outcome.processed_event_id,async value=>{
    assert.equal(hers().length,1);assert.equal(value.result.reply_text,'同一个电话会话的回答。');received.resolve();
   },received.reject);
   await received.promise;
  }
  assert.equal(hers().length,1);assert.equal(journalWrites,before,'consumer projections keep the sealed journal read-only');
  release.resolve();await a.admission.close();
  assert.equal(hers().length,1,'the seal callback and both consumer projections share the same item identity');
  assert.deepEqual(f.counts(),{opens:1,creates:1,confirmations:1});
 }finally{release.resolve();stop?.();}
});
test('decoder capacity is retryable busy and unavailable attempts never become invalid-audio outcomes',async t=>{
 const f=await fixture(t),a=await f.instance(),signal=new AbortController().signal;
 const first=await a.execution.reserve('decode',signal,10000),second=await a.execution.reserve('decode',signal,10000);
 try{await assert.rejects(a.upload(),error=>error instanceof ContractError&&error.code==='busy'&&error.status===429);
  assert.deepEqual(await f.storage.list('watch-turn-outcomes'),[]);assert.equal((await f.storage.list('manifests')).length,1);
 }finally{await Promise.all([first.release(),second.release()]);}
 const prepare=a.demux.prepare.bind(a.demux);a.demux.prepare=async()=>{throw new ContractError('DEMUX_ATTEMPT_UNKNOWN',503);};
 await assert.rejects(a.upload(),error=>error instanceof ContractError&&error.code==='service_unavailable'&&error.status===503);
 assert.deepEqual(await f.storage.list('watch-turn-outcomes'),[]);a.demux.prepare=prepare;
 assert.equal((await a.upload()).status,'heard');await settled(()=>f.counts().creates===1);assert.deepEqual(f.counts(),{opens:1,creates:1,confirmations:1});
});

test('actual malformed MP4 decoder failure is audio_invalid and retains exact original without ASR',async t=>{
 const f=await fixture(t),a=await f.instance(),invalid=Buffer.from('not an MPEG-4 audio container');
 assert.deepEqual(await a.upload(invalid),{status:'failed',turn_id:turn,reason:'audio_invalid'});
 assert.deepEqual(await a.upload(invalid),{status:'failed',turn_id:turn,reason:'audio_invalid'});
 const intent=JSON.parse(Buffer.from(await f.storage.read('watch-turns',(await f.storage.list('watch-turns'))[0]!)).toString());
 const original=await a.archive.locate(`l5:${digest({principal_id:'owner',event_id:intent.operation})}`,'owner');
 assert.deepEqual(await a.archive.read(original.raw_ref,'owner',original.archive_revision),invalid);assert.deepEqual(f.counts(),{opens:0,creates:0,confirmations:0});
});
