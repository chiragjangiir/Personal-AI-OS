import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceCallSession,type FrontSession} from '../src/voice-call-session.ts';
import type {VadEvent} from '../../../services/personal-aios-integration/src/voiceprint/engine.ts';
import {callVad,type CallSpeech} from '../src/call-vad.ts';

const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('VAD backlog keeps unverified PCM local and recovers the detector without closing the call',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const blocked=Promise.withResolvers<VadEvent[]>(),errors:unknown[]=[],states:{id:string;state:string}[]=[];
  const fronts:{emit:(event:Record<string,unknown>)=>void;audio:number[];cancelled:number;closed:number}[]=[];
  let detectors=0,aborts=0,writes=0,played=0,resets=0,outputsClosed=0,samples=0;
  const session=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    turns:{config:{enabled:true,model:{path:'/synthetic',sha256:'0'.repeat(64)},thinking_sound:{path:'/synthetic',sha256:'0'.repeat(64),model:'test',voice:'test'}},score:async()=>1,thinking:new Int16Array(480)},
    identifySpeech:async()=>false,transcribeSpeech:async()=>'',classifySpeech:async()=>({stop:false,guests:'unchanged'}),
    createFront:callbacks=>{
      const front={emit:callbacks.onEvent,audio:[] as number[],cancelled:0,closed:0};fronts.push(front);
      return {connect:async()=>{},appendImage:()=>{},appendAudio:base64=>{front.audio.push(Buffer.from(base64,'base64').readInt16LE());},
        respond:async()=>({completed:true}),context:async()=>{},cancel:()=>{front.cancelled++;},close:()=>{front.closed++;}} satisfies FrontSession;
    },
    createPlayout:()=>({open:async()=>{},push:()=>{played++;},interrupt:()=>{resets++;},playedSamples:()=>played*480,drain:async()=>{},close:async()=>{outputsClosed++;}}),
    openVad:async signal=>{
      const detector=++detectors;let started=false;samples=0;signal.addEventListener('abort',()=>{aborts++;},{once:true});
      return {write:async(pcm:Float32Array)=>{writes++;samples+=pcm.length;if(detector===1)return blocked.promise;
        if(started)return [];started=true;return [{at:samples,start:samples-pcm.length}];},close:async()=>{}};
    },
    onState:(id,state)=>states.push({id,state}),onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  t.after(()=>session.closeAll());
  await session.open('blocked');const first=fronts[0]!;
  first.emit({type:'response.created',response:{id:'answer'}});
  first.emit({type:'response.audio.delta',response_id:'answer',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  t.mock.timers.tick(0);await settle();
  session.pushPcm(new Int16Array(512).fill(100));assert.equal(writes,1,'first write owns the blocked detector');
  for(let i=0;i<33;i++)session.pushPcm(new Int16Array(512).fill(200+i));
  await settle();
  assert.equal(session.active(),'blocked');assert.equal(session.pending(),'blocked');assert.equal(first.closed,0);
  assert.equal(outputsClosed,0);assert.equal(aborts,1);assert.equal(writes,1);
  assert.equal(errors.length,1);assert.match(String(errors[0]),/VOICE_CALL_VAD_BACKLOG/);
  assert.deepEqual(states,[{id:'blocked',state:'opening'},{id:'blocked',state:'live'}]);
  assert.deepEqual(first.audio,[],'overflow cannot expose microphone input to automatic provider interruption during playback');
  assert.equal(played,1);first.emit({type:'input_audio_buffer.speech_started'});
  assert.equal(first.cancelled,0,'provider onset alone still cannot cancel');
  first.emit({type:'conversation.item.input_audio_transcription.completed',transcript:'喂，嗯'});assert.equal(first.cancelled,0);
  first.emit({type:'conversation.item.input_audio_transcription.completed',transcript:'等一下，我有另一个问题'});
  assert.equal(first.cancelled,0,'provider transcript has no local owner authority after detector failure');assert.equal(resets,0);
  first.emit({type:'response.audio.delta',response_id:'answer',delta:Buffer.from(new Int16Array(480).buffer).toString('base64')});
  assert.equal(played,2,'provider speech cannot suppress the existing reply');
  session.pushPcm(new Int16Array(512).fill(900));assert.deepEqual(first.audio,[]);
  blocked.reject(new Error('late detector failure'));await settle();
  assert.equal(errors.length,1,'late rejection and subsequent PCM do not log the same failure twice');
  first.emit({type:'response.done',response:{id:'answer',status:'completed'}});await settle();
  assert.deepEqual(first.audio,[],'drain cannot release unverified or overflowed microphone audio');
  session.pushPcm(new Int16Array(512).fill(901));assert.deepEqual(first.audio,[]);assert.equal(detectors,2,'the next microphone frame replaces the failed detector');
  assert.equal(session.active(),'blocked');
  assert.ok(states.every(s=>s.state!=='failed'&&s.state!=='closing'&&s.state!=='closed'));
  await session.close('blocked','button');await session.open('fresh');assert.equal(detectors,3);
  const fresh=fronts[1]!;fresh.emit({type:'response.created',response:{id:'fresh-answer'}});
  for(let i=0;i<42;i++){session.pushPcm(new Int16Array(512).fill(1000));await settle();}
  assert.equal(session.active(),'fresh');assert.ok(writes>1);assert.equal(fresh.cancelled,0,'fresh VAD alone still has no speaker authority');
  assert.equal(first.cancelled,0);assert.equal(errors.length,1);
});

test('a scheduling burst above 256 ms drains without losing sustained speech or failing the detector',async()=>{
  const blocked=Promise.withResolvers<VadEvent[]>(),errors:unknown[]=[],decisions:boolean[]=[];
  let samples=0,writes=0;
  const vad=callVad(async()=>({write:async pcm=>{
    samples+=pcm.length;writes++;
    return writes===1?blocked.promise:[{at:samples}];
  },close:async()=>{}}),(active,barge)=>{if(active)decisions.push(barge);},error=>errors.push(error));
  try{
    await vad.ready;
    vad.push(new Int16Array(512));
    for(let i=0;i<28;i++)vad.push(new Int16Array(512));
    assert.equal(writes,1,'a single inference stays in flight');
    assert.equal(vad.available(),true,'queued burst remains within bounded live input');
    blocked.resolve([{at:512,start:0}]);
    for(let i=0;i<12;i++)await settle();
    for(let i=0;i<16;i++){vad.push(new Int16Array(512));await settle();}
    assert.equal(samples,45*512,'every queued sample reaches the same detector');
    assert.ok(decisions.length>=3&&decisions.every(value=>value===false),'physical VAD reports progress without making interruption decisions');
    assert.deepEqual(errors,[]);
  }finally{vad.close();}
});

test('a keyword at VAD onset emits no empty speech and preserves the later single speech end',async()=>{
  const events:{active:boolean;detail:CallSpeech|undefined}[]=[],errors:unknown[]=[];let frames=0,keywordFrames=0;
  const vad=callVad(async()=>({write:async()=>{
    frames++;return frames===1?[{at:512,start:0}]:frames===8?[{at:4096,end:2048}]:[];
  },close:async()=>{}}),(active,_barge,detail)=>events.push({active,detail}),error=>errors.push(error),
    async()=>({write:async()=>++keywordFrames===1?[{keyword:'停',at_sample:512}]:[],finish:async()=>[],close:async()=>{}}));
  try{
    await vad.ready;vad.push(new Int16Array(512).fill(1000));await settle();
    assert.equal(events.length,1);assert.equal(events[0]!.active,true);assert.equal(events[0]!.detail,undefined);
    for(let i=1;i<8;i++){vad.push(new Int16Array(512).fill(1000));await settle();}
    const speech=events.flatMap(event=>event.detail?[event.detail]:[]);
    assert.ok(speech.length>0&&speech.every(detail=>detail.samples.length>0&&detail.asr_samples.length>0&&detail.speech_ms>0));
    const ended=events.filter(event=>event.detail?.reason==='end');
    assert.equal(ended.length,1);assert.equal(ended[0]!.active,false);assert.equal(ended[0]!.detail!.samples.length,2048);
    assert.deepEqual(errors,[]);
  }finally{vad.close();}
});

test('VAD references follow the processed sample axis and trim exact source chunks without duplicating audio',async()=>{
  let at=0;const events:CallSpeech[]=[],errors:unknown[]=[];
  const vad=callVad(async()=>({write:async pcm=>{at+=pcm.length;return at===512?[{at,start:128}]:at===2048?[{at,end:1152}]:[];},close:async()=>{}}),
    (_active,_barge,detail)=>{if(detail?.reason==='end')events.push(detail);},error=>errors.push(error));
  try{
    await vad.ready;
    for(let seq=0;seq<4;seq++){const saved={event:{raw_ref:'l5:source',archive_revision:`rev:${seq}`},chunk:{seq}} as unknown as import('../src/personal-aios-formal-pcm.ts').PcmArchiveSnapshot;
      vad.push(new Int16Array(512).fill(seq),Promise.resolve(saved));await settle();}
    assert.equal(events.length,1);const speech=events[0]!,refs=await Promise.all(speech.references!);
    assert.equal(speech.samples.length,1024);assert.deepEqual(refs.map(ref=>'chunk' in ref?[ref.chunk.seq,ref.sample_from,ref.sample_to]:null),[[0,128,512],[1,0,512],[2,0,128]]);
    assert.deepEqual(refs.map(ref=>'event' in ref?ref.event.archive_revision:null),['rev:0','rev:1','rev:2']);assert.deepEqual(errors,[]);
  }finally{vad.close();}
});
