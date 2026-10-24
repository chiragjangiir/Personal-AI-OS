import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,principalAttribution,sha256,validateProcessed,voiceEvidence} from '../src/contracts.ts';
import type {WorkerRequest} from '../src/media/processing.ts';
import {SherpaAudioWorker} from '../src/media/sherpa-audio-worker.ts';
import type {SpeakerIdentifier,SpeakerIdentity,IdentifyInput} from '../src/voiceprint/contracts.ts';
import {controlledDetector,controlledEngine,transcribeWindow} from './speech-fixture.ts';

const marker=(samples:number,level:number)=>{const pcm=Buffer.alloc(samples*2);for(let n=0;n<samples;n++)pcm.writeInt16LE(level,n*2);return pcm;};
const base=1_760_000_000_000;

test('sherpa Silero stream keeps the VadStream contract: per-frame prefix hashes, events, terminal without flush',async()=>{
  const detector=controlledDetector(),stream=await detector.open(new AbortController().signal);
  assert.deepEqual(stream.model,detector.vad.vad_model);
  const input=Buffer.concat([marker(1024,1),marker(1024,0),marker(700,1)]),progress=[];let at=0;
  for(const width of [100,900,1,1747]){progress.push(...await stream.write(input.subarray(at*2,(at+width)*2)));at+=width;}
  assert.deepEqual(progress.map(p=>p.processed_samples),[512,1024,1536,2048,2560]);
  for(const item of progress)assert.equal(item.input_sha256,sha256(input.subarray(0,item.processed_samples*2)));
  assert.deepEqual(progress.map(({start,end})=>({start,end})),[{start:0,end:undefined},{start:undefined,end:undefined},
    {start:undefined,end:1024},{start:undefined,end:undefined},{start:2048,end:undefined}]);
  assert.deepEqual(await stream.finish(),{processed_samples:2560,uninferred_samples:188,input_sha256:sha256(input)});
  await assert.rejects(stream.write(marker(512,1)),/SILERO_STREAM_UNAVAILABLE/);
  assert.equal(detector.vad.opened,1);assert.equal(detector.vad.closed,1);
  const odd=await detector.open(new AbortController().signal);await assert.rejects(odd.write(new Uint8Array(3)),/SILERO_PCM/);
  await assert.rejects(detector.open(AbortSignal.abort()),/MEDIA_CANCELLED/);
});

test('closing a stream ends its pending native write; the detector still closes once',async()=>{
  const detector=controlledDetector({write:()=>new Promise(()=>{})}),stream=await detector.open(new AbortController().signal);
  const pending=stream.write(marker(1024,1));await stream.close();
  await assert.rejects(pending,/SILERO_STREAM_CLOSED/);await stream.close();
  assert.equal(detector.vad.closed,1);await assert.rejects(stream.finish(),/SILERO_STREAM_UNAVAILABLE/);
});

async function fixture(t:test.TestContext,pcm:Buffer,speakers?:SpeakerIdentifier) {
  const engine=controlledEngine();return {...await transcribeWindow(t,pcm,engine,speakers,base),engine};
}
const recorder=()=>{
  const calls:({level:number}&IdentifyInput)[]=[];
  const speakers:SpeakerIdentifier={model:{id:'controlled-speaker',sha256:digest('controlled-speaker'),dim:4},identify:async(embedding,input)=>{
    const level=embedding.indexOf(1);calls.push({level,...input});
    return (level===1?{kind:'owner',band:'verified',score:0.9}:level===2?{kind:'speaker',cluster_id:'12',score:0.7}:
      {kind:'unknown',reason:'low_quality'}) satisfies SpeakerIdentity;}};
  return {calls,speakers};
};

test('a window holding two utterances is split by the engine VAD; each gets text and an observed speaker label',async t=>{
  const {calls,speakers}=recorder();
  const {d,observation,engine}=await fixture(t,Buffer.concat([marker(4096,1),marker(4096,0),marker(4096,2),marker(4096,0)]),speakers);
  assert.deepEqual(observation.segments.map(({start_sample,end_sample_exclusive,text,speaker})=>({start_sample,end_sample_exclusive,text,speaker})),
    [{start_sample:0,end_sample_exclusive:4096,text:'utterance 1',speaker:'owner'},{start_sample:8192,end_sample_exclusive:12288,text:'utterance 2',speaker:'speaker:12'}]);
  assert.equal(d.content.transcript,'utterance 1 utterance 2');
  assert.ok(calls.every(call=>call.signal instanceof AbortSignal));
  assert.deepEqual(calls.map(({signal,...input})=>input),[{level:1,quality:1,principal_id:'owner',device_id:'glasses',speech_ms:256,observed_at:new Date(base+256).toISOString(),evidence_start_at:new Date(base).toISOString(),mode:'observe',channel:'glasses'},
    {level:2,quality:1,principal_id:'owner',device_id:'glasses',speech_ms:256,observed_at:new Date(base+768).toISOString(),evidence_start_at:new Date(base+512).toISOString(),mode:'observe',channel:'glasses'}]);
  assert.deepEqual(engine.calls,['transcribe:4096','embed:4096','transcribe:4096','embed:4096']);
  assert.equal(observation.model.id,'local-sherpa-audio');assert.equal(observation.model.version,'controlled-engine');
  assert.equal(observation.model.dtype,'int8');assert.equal(observation.model.native_metadata.vad_utterances,2);
  assert.equal(observation.model.native_metadata.speaker_sha256,engine.speaker_model.sha256);
  // With the registry attached the labels are trusted voiceprint evidence; owner mixed with another voice is not attributable.
  assert.deepEqual(d.speakers.map(s=>{const v=s as {identity_scope:string;voiceprint:string;score:number};return [v.identity_scope,v.voiceprint,v.score];}),
    [['local_voiceprint','owner',0.9],['local_voiceprint','speaker:12',0.7]]);
  assert.equal(principalAttribution(d),null);assert.equal(d.user_identity,'unknown');
});

test('a window of verified owner speech is owner-attributable; the label is only trusted from the registry-backed capability',async t=>{
  const owner:SpeakerIdentifier={model:{id:'controlled-speaker',sha256:digest('controlled-speaker'),dim:4},
    identify:async()=>({kind:'owner',band:'verified',score:0.88})};
  const {d}=await fixture(t,Buffer.concat([marker(20000,1),marker(4096,0)]),owner);
  assert.equal(principalAttribution(d),'owner_voice');assert.equal(d.user_identity,d.principal_id);
  const mismatched:SpeakerIdentifier={...owner,model:{id:'other',sha256:digest('other'),dim:4}};
  await assert.rejects(fixture(t,Buffer.concat([marker(20000,1),marker(4096,0)]),mismatched),/ALL_MEDIA_WORKERS_FAILED/,'a registry of another speaker model is refused (VOICEPRINT_SPEAKER_MODEL_MISMATCH inside the worker)');
});

test('one utterance keeps the whole window as text; unknown or too-short speech carries no speaker label',async t=>{
  const {calls,speakers}=recorder();
  const single=await fixture(t,Buffer.concat([marker(4096,3),marker(12288,0)]),speakers);
  assert.deepEqual(single.observation.segments.map(({start_sample,end_sample_exclusive,text,speaker})=>({start_sample,end_sample_exclusive,text,speaker})),
    [{start_sample:0,end_sample_exclusive:16384,text:'utterance 3',speaker:undefined}]);
  assert.deepEqual(single.engine.calls,['transcribe:16384','embed:4096']);assert.equal(calls.length,1);assert.equal(calls[0]!.level,3);
  const short=await fixture(t,Buffer.concat([marker(1024,1),marker(7168,0)]),speakers);
  assert.deepEqual(short.engine.calls,['transcribe:8192','embed:1024']);assert.equal(calls.length,1);
  assert.equal(short.observation.segments[0]!.speaker,undefined);
  assert.deepEqual(short.d.speakers.map(s=>(s as {voiceprint:string}).voiceprint),['unknown'],'unlabelled speech is recorded as unknown, never dropped');
  const silent=await fixture(t,marker(8192,0));
  assert.deepEqual(silent.engine.calls,['transcribe:8192']);assert.equal(silent.d.content.transcript,'');
  assert.equal(silent.observation.model.native_metadata.speaker_sha256,undefined);
});

test('an aborted request never reaches the engine',async()=>{
  const engine=controlledEngine(),worker=new SherpaAudioWorker(async()=>engine,controlledDetector());
  await assert.rejects(worker.analyze({} as WorkerRequest,AbortSignal.abort()),/MEDIA_CANCELLED/);
  assert.deepEqual(engine.calls,[]);assert.equal(worker.effects,'pure_analysis');
});

test('the engine keyword spotter runs on each utterance; its hit and the language travel as validated segment fields',async t=>{
  const engine=controlledEngine({wake:[2],lang:'zh'});
  const {d,observation}=await transcribeWindow(t,Buffer.concat([marker(4096,1),marker(4096,0),marker(4096,2),marker(4096,0)]),engine,undefined,base);
  const segments=observation.segments as {text:string;wake?:{keyword:string;end_sample:number};lang?:string}[];
  assert.deepEqual(segments.map(s=>[s.text,s.wake?.keyword,s.lang]),[['utterance 1',undefined,'zh'],['一米，utterance 2','依米','zh']]);
  // The spotter's hit position less its decode latency: where the words after the wake word begin.
  assert.equal(segments[1]!.wake!.end_sample,4096-5600<0?0:4096-5600);
  assert.equal(engine.calls.filter(call=>call==='kws_open').length,2);assert.equal(observation.model.native_metadata.wake_spotting,true);
  assert.equal(d.intent_class,'observation','a wake word alone never makes the captured D a request');
});

const turn=(t:test.TestContext,pcm:Buffer,engine:ReturnType<typeof controlledEngine>,speakers:SpeakerIdentifier)=>
  transcribeWindow(t,pcm,engine,speakers,base,'turn');
type TurnSegment={start_sample:number;end_sample_exclusive:number;text:string;speaker?:string;wake?:{keyword:string;end_sample:number}};
const spans=(segments:unknown[])=>(segments as TurnSegment[]).map(({start_sample,end_sample_exclusive,text,speaker,wake})=>
  ({start_sample,end_sample_exclusive,text,speaker,...(wake?{wake}:{})}));

test('a wake turn: a short request after "依米" said alone is identified together with the wake word, one embedding for the turn',async t=>{
  const {calls,speakers}=recorder(),engine=controlledEngine({wakeAlone:[5]});
  // The window starts at the wake word (0.51 s), a pause, then a 0.77 s request.
  const {d,observation}=await turn(t,Buffer.concat([marker(8192,5),marker(4096,0),marker(12288,1),marker(4096,0)]),engine,speakers);
  assert.deepEqual(spans(observation.segments),[
    {start_sample:0,end_sample_exclusive:8192,text:'',speaker:'owner',wake:{keyword:'依米',end_sample:8192}},
    {start_sample:12288,end_sample_exclusive:24576,text:'utterance 1',speaker:'owner'}]);
  // The wake word is heard and judged alone by its whole text, never transcribed as request words; one identity over both,
  // with the request alone embedded too for the registry's check.
  assert.deepEqual(engine.calls,['kws_open','transcribe:8192','embed:20480','embed:12288','transcribe:12288']);
  assert.deepEqual(calls.map(c=>[c.speech_ms,c.mode,c.observed_at,c.request?.embedding?.indexOf(1)]),[[1280,'verify',new Date(base+1536).toISOString(),1]]);
  assert.equal(calls[0]!.evidence_start_at,new Date(base).toISOString());
  assert.equal(calls[0]!.channel,'glasses');
  assert.equal(observation.model.native_metadata.speaker_evidence,'wake_and_request');assert.equal(d.content.transcript,'utterance 1');
  assert.deepEqual(d.speakers,[{identity_scope:'local_voiceprint',voiceprint:'owner',score:0.9,speech_ms:1280,segments:2}]);
  assert.equal(principalAttribution(d),'owner_voice','the wake word counts toward the owner\'s speech only as part of the turn');
});

test('a request long enough to identify alone stays request-only evidence; the wake word is no segment',async t=>{
  const {calls,speakers}=recorder(),engine=controlledEngine({wakeAlone:[5]});
  const {d,observation}=await turn(t,Buffer.concat([marker(8192,5),marker(4096,0),marker(28672,1),marker(4096,0)]),engine,speakers);
  assert.deepEqual(spans(observation.segments),[{start_sample:12288,end_sample_exclusive:40960,text:'utterance 1',speaker:'owner'}]);
  assert.deepEqual(engine.calls,['kws_open','transcribe:8192','embed:28672','transcribe:28672']);
  assert.deepEqual(calls.map(c=>[c.speech_ms,c.request]),[[1792,undefined]]);assert.equal(observation.model.native_metadata.speaker_evidence,'request');
  assert.equal(principalAttribution(d),'owner_voice');
});

test('words after the wake word in its own utterance are the request, cut where the wake word ends; no wake word, all request',async t=>{
  const {calls,speakers}=recorder(),inline=controlledEngine({wake:[1]});
  // One utterance (1.28 s) then silence: the spotter's cut sits 350 ms before the hit; the text carries words after 依米.
  const {observation}=await turn(t,Buffer.concat([marker(20480,1),marker(4096,0)]),inline,speakers);
  assert.deepEqual(spans(observation.segments),[
    {start_sample:0,end_sample_exclusive:18976,text:'',speaker:'owner',wake:{keyword:'依米',end_sample:18976}},
    {start_sample:18976,end_sample_exclusive:24576,text:'一米，utterance 1',speaker:'owner'}]);
  assert.deepEqual(calls.map(c=>c.speech_ms),[1280],'wake word and the short rest of the utterance: one turn identity');
  const plain=controlledEngine();
  const {observation:whole}=await turn(t,Buffer.concat([marker(8192,1),marker(4096,0),marker(8192,1),marker(4096,0)]),plain,speakers);
  assert.deepEqual(spans(whole.segments).map(s=>[s.start_sample,s.text,s.speaker]),[[0,'utterance 1','owner'],[12288,'utterance 1','owner']]);
  assert.equal(whole.model.native_metadata.speaker_evidence,'request');
});

// A follow-up turn's window: the replied request's speech, other talk in between, then the follow-up's own words.
const followUp=(t:test.TestContext,pcm:Buffer,engine:ReturnType<typeof controlledEngine>,speakers:SpeakerIdentifier,carrierEnd:number,requestStart:number)=>
  transcribeWindow(t,pcm,engine,speakers,base,'turn',{end_ms:base+carrierEnd/16,request_start_ms:base+requestStart/16});

test('a short follow-up is identified together with the replied request\'s speech, one embedding; the speech between is neither',async t=>{
  const {calls,speakers}=recorder(),engine=controlledEngine({wake:[3]});
  // Owner's request (1.02 s), someone else (voice 3, even with 依米 in it), then the owner's 0.51 s answer.
  const pcm=Buffer.concat([marker(16384,1),marker(8192,0),marker(8192,3),marker(8192,0),marker(8192,1),marker(4096,0)]);
  const {d,observation}=await followUp(t,pcm,engine,speakers,16384,40960);
  assert.deepEqual(spans(observation.segments),[{start_sample:0,end_sample_exclusive:16384,text:'',speaker:'owner'},
    {start_sample:40960,end_sample_exclusive:49152,text:'utterance 1',speaker:'owner'}]);
  // No wake word is looked for; carrier + answer embedded once, the answer alone too; only the answer is transcribed.
  assert.deepEqual(engine.calls,['embed:24576','embed:8192','transcribe:8192']);
  assert.deepEqual(calls.map(c=>[c.speech_ms,c.mode,c.request?.speech_ms,c.request?.embedding?.indexOf(1)]),[[1536,'verify',512,1]]);
  assert.equal(observation.model.native_metadata.speaker_evidence,'carrier_and_request');assert.equal(d.content.transcript,'utterance 1');
  assert.deepEqual(d.speakers,[{identity_scope:'local_voiceprint',voiceprint:'owner',score:0.9,speech_ms:1536,segments:2}]);
  assert.equal(principalAttribution(d),'owner_voice','the carrier counts toward the owner\'s speech only as part of the turn');
  assert.equal((d as unknown as Record<string,unknown>).speaker_carrier,undefined,'the carrier is input provenance, not a D field');
});

test('a follow-up\'s carrier is the replied request\'s most recent 1.5 s; a follow-up long enough to identify alone ignores it',async t=>{
  const {calls,speakers}=recorder(),engine=controlledEngine();
  const {observation}=await followUp(t,Buffer.concat([marker(40960,1),marker(8192,0),marker(8192,1),marker(4096,0)]),engine,speakers,40960,49152);
  assert.deepEqual(spans(observation.segments).map(s=>[s.start_sample,s.end_sample_exclusive,s.text]),[[16960,40960,''],[49152,57344,'utterance 1']]);
  assert.deepEqual(calls.map(c=>c.speech_ms),[2012]);
  const long=controlledEngine(),{observation:alone}=await followUp(t,Buffer.concat([marker(16384,1),marker(8192,0),marker(28672,1),marker(4096,0)]),
    long,speakers,16384,24576);
  assert.deepEqual(spans(alone.segments).map(s=>[s.start_sample,s.text,s.speaker]),[[24576,'utterance 1','owner']]);
  assert.deepEqual(long.calls,['embed:28672','transcribe:28672']);assert.equal(calls.at(-1)!.request,undefined);
  assert.equal(alone.model.native_metadata.speaker_evidence,'request');
});

test('short empty-text SenseVoice event crosses worker/finalizer/journal without gaining request authority',async t=>{
  const {senseVoiceTranscript}=await import('../src/voiceprint/contracts.ts');
  const {utterances}=await import('../src/ambient/lane.ts');
  assert.deepEqual(senseVoiceTranscript({text:'',lang:'<|nospeech|>',event:'<|Cough|>',emotion:'<|NEUTRAL|>'}),
    {text:'',event:'cough',emotion:'neutral'});
  assert.deepEqual(senseVoiceTranscript({text:' hi ',lang:'<|en|>',event:'<|Speech|>',emotion:'<|HAPPY|>'}),
    {text:'hi',lang:'en',emotion:'happy'});
  assert.deepEqual(senseVoiceTranscript({text:'',event:'<|Event_UNK|>',emotion:'<|EMO_UNKNOWN|>'}),{text:'',emotion:'unknown'});
  const engine=Object.assign(controlledEngine({wake:[1]}),{tagging_model:{id:'fixture',sha256:digest('tagger'),labels_sha256:digest('labels')},
    tag:async()=> 'throat_clearing' as const}),{calls,speakers}=recorder();engine.transcribe=async()=>({text:'',event:'cough',emotion:'neutral'});
  const {d,observation}=await transcribeWindow(t,Buffer.concat([marker(2048,1),marker(4096,0)]),engine,speakers,base);
  assert.deepEqual(calls,[]);assert.ok(!engine.calls.includes('kws_open'));
  assert.equal((observation.segments[0] as {event?:string}).event,'cough');
  assert.equal(utterances(d)[0]!.event,'cough');assert.equal(utterances(d)[0]!.text,'');
  assert.equal(d.intent_class,'observation');assert.equal(principalAttribution(d),null);
});

test('a short VAD-missed sound reaches the journal with no invented words, wake or owner identity',async t=>{
  const {utterances}=await import('../src/ambient/lane.ts'),{testJournal}=await import('./speech-fixture.ts');
  const engine=Object.assign(controlledEngine({wake:[1]}),{tagging_model:{id:'fixture',sha256:digest('tagger'),labels_sha256:digest('labels')},
    tag:async()=> 'wheeze' as const});
  const {d}=await transcribeWindow(t,marker(2048,0),engine,undefined,base);
  assert.equal(d.content.transcript,'');assert.deepEqual(engine.calls,[],'non-speech bypasses ASR, KWS and embedding');
  assert.equal(principalAttribution(d),null);
  const journal=await testJournal(t);
  const source={principal_id:d.principal_id,device_id:d.device_id,processed_event_id:d.processed_event_id,raw_ref:d.raw_ref,
    archive_revision:d.archive_revision,segment_id:d.segment_id!};
  journal.append(source,utterances(d));journal.append(source,utterances(d));
  const result=journal.search({principal_id:'owner',event:'wheeze',limit:10});
  assert.deepEqual(result.events.map(e=>[e.event,e.count,e.speaker,e.start_ms,e.end_ms]),[['wheeze',1,null,base,base+128]]);
});


test('trusted device identity keeps its call-only scope through utterance and wake-turn sample results',async t=>{
  const owner:SpeakerIdentifier={model:{id:'controlled-speaker',sha256:digest('controlled-speaker'),dim:4},
    identify:async(_embedding,input)=>{
      assert.equal(input.principal_id,'owner');assert.equal(input.device_id,'glasses');assert.equal(input.channel,'glasses');assert.equal(input.quality,1);
      return {kind:'owner',band:'verified',score:0.9,call_only:true};}};
  for(const mode of ['utterance','turn'] as const){
    const {d}=await transcribeWindow(t,Buffer.concat([marker(4096,1),marker(4096,0)]),controlledEngine(),owner,base,mode);
    validateProcessed(d);assert.equal(voiceEvidence(d),'owner');assert.equal(principalAttribution(d),'owner_voice');
    const ordinary=structuredClone(d);delete (ordinary.speakers[0] as {call_only?:true}).call_only;
    assert.equal(voiceEvidence(ordinary),'owner_uncertain','ordinary voiceprint evidence keeps its duration minimum');
    assert.equal((d.speakers[0] as {call_only?:true}).call_only,true);
    const observation=(d.content.audio_observations as unknown as {segments:{call_only?:true}[]}[])[0]!;
    assert.ok(observation.segments.every(segment=>segment.call_only===true));
  }
});


test('identity-only speech samples retain call-only scope, device binding and call identity',async()=>{
 const engine=controlledEngine(),pcm=marker(20000,1),time_range={kind:'interval' as const,timebase_id:'utc_epoch_ms',start_ms:base,end_ms:base+1250};
 const speakers:SpeakerIdentifier={model:engine.speaker_model,identify:async(_embedding,input)=>{
   assert.equal(input.call_id,'call-1');assert.equal(input.principal_id,'owner');assert.equal(input.device_id,'glasses');
   return {kind:'owner',band:'verified',score:0.9,call_only:true};}};
 const worker=new SherpaAudioWorker(async()=>engine,controlledDetector(),speakers);
 const request:WorkerRequest={input_contract:'paios.media.selected-pcm.v1',event_id:'identity',segment_id:'segment',archive_revision:'revision',
   principal_id:'owner',device_id:'glasses',call_id:'call-1',identity_channel:'glasses',coverage:{status:'complete',missing_ranges:[]},time_range,
   views:[{modality:'audio',format:'pcm_s16le:16000:1',ref:'identity-pcm',bytes:pcm,time_range,pcm_selection:{view_ref:`l5-view:${digest('identity-view')}`,track_id:'mic',stream_epoch:'epoch',seq:0,
     source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:1250},mapped_range:time_range,
     selected_source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:1250},
     sample_rate:16000,first_sample:0,end_sample_exclusive:20000,source_samples:20000,selected_sha256:sha256(pcm),rounding:'sample_starts_in_half_open_window_ceil_epsilon_snap'}}]};
 const result=await worker.analyzeIdentity(request,new AbortController().signal);
 assert.equal(result.segments[0]!.call_only,true);
 const cancelled=new AbortController(),abortingEngine={...engine,embed:async(samples:Float32Array)=>{const vector=await engine.embed(samples);cancelled.abort();return vector;}};
 const aborting=new SherpaAudioWorker(async()=>abortingEngine,controlledDetector(),{...speakers,identify:async()=>{assert.fail('cancelled embedding must not enter registry');}});
 await assert.rejects(aborting.analyzeIdentity(request,cancelled.signal),{name:'AbortError'});
});
