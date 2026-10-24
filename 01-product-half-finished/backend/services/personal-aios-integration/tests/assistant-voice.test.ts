// The assistant voice learner: the system's own outgoing speech (system TTS replies, the live call's voice) becomes the
// registry's assistant profile — resampled, bounded, rate-limited, never in the way of listening or of speaking.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {inspectWav,type TtsAudio,type TtsPort} from '../src/tts.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {AssistantVoiceLearner,learningTts,to16k,type AssistantVoiceEngine} from '../src/voiceprint/assistant-voice.ts';

const MODEL={id:'controlled-speaker',sha256:digest('controlled-speaker'),dim:16};
const tone=(rate:number,seconds:number,hz:number,amplitude=8000)=>Int16Array.from({length:Math.round(rate*seconds)},(_,n)=>Math.round(amplitude*Math.sin(2*Math.PI*hz*n/rate)));
const crossings=(x:Float32Array)=>x.reduce((n,v,i)=>i&&(x[i-1]!<0)!==(v<0)?n+1:n,0);
function wav(samples:Int16Array,rate:number):Uint8Array {
  const data=Buffer.from(samples.buffer,samples.byteOffset,samples.byteLength),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+data.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);
  header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);
  header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
  return Buffer.concat([header,data]);
}
async function setup(t:test.TestContext,options:{available?:()=>boolean;model?:typeof MODEL}={}) {
  const directory=await mkdtemp(join(tmpdir(),'paios-assistant-voice-'));
  const registry=new VoiceprintRegistry(new PosixStorage(directory),MODEL);
  t.after(async()=>{await registry.close();await rm(directory,{recursive:true,force:true});});
  const embedded:number[]=[],errors:unknown[]=[];let clock=0;
  const engine:AssistantVoiceEngine={speaker_model:options.model??MODEL,idle:options.available??(()=>true),
    embed:async samples=>{embedded.push(samples.length);const v=new Float32Array(16);v[0]=1;v[1]=0.1;return v;}};
  const learner=new AssistantVoiceLearner(async()=>engine,registry,{onError:error=>errors.push(error),now:()=>clock});
  const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));await (learner as unknown as {active?:Promise<void>}).active;};
  return {registry,learner,embedded,errors,settle,advance:(ms:number)=>{clock+=ms;}};
}

test('resampling to 16 kHz keeps the voice band and drops what 16 kHz cannot carry',()=>{
  const low=to16k(tone(24000,1,1000),24000);
  assert.equal(low.length,16000);assert.ok(Math.abs(crossings(low)-2000)<=2,'a 1 kHz tone stays 1 kHz');
  assert.ok(Math.abs(Math.max(...low)-8000/32768)<0.01,'and keeps its level');
  const high=to16k(tone(24000,1,10000),24000).subarray(100,-100);
  assert.ok(Math.max(...high.map(Math.abs))<0.01*8000/32768,'10 kHz is filtered (< -40 dB), not folded into the voice band');
  assert.deepEqual(to16k(Int16Array.from([16384,-16384]),16000),Float32Array.from([0.5,-0.5]));
  assert.throws(()=>to16k(new Int16Array(4),7999),/ASSISTANT_VOICE_RATE_INVALID/);
});

test('an outgoing utterance becomes one bounded assistant sample; one per source per interval, none while the engine is busy',async t=>{
  let busy=false;
  const f=await setup(t,{available:()=>!busy});
  // 20 s of speech at 24 kHz between silences: trimmed and capped at 8 s, resampled to 16 kHz.
  const speech=f.learner.utterance('system_tts',24000);
  speech.push(new Int16Array(24000*0.5));for(let n=0;n<20;n++)speech.push(tone(24000,1,300));speech.end();speech.end();
  await f.settle();assert.deepEqual(f.errors,[]);
  assert.equal(f.embedded.length,3);assert.ok(f.embedded.every(n=>n<=3000*16));
  assert.ok(f.embedded.reduce((a,b)=>a+b,0)>=7000*16);
  assert.deepEqual((await f.registry.assistantVoices()).map(v=>[v.voice,v.count]),[['system_tts',1]]);
  // Within the interval the same source is not sampled again; another source is.
  const again=f.learner.utterance('system_tts',24000);again.push(tone(24000,3,300));again.end();await f.settle();
  const call=f.learner.stream('realtime_call',24000);call('r1',tone(24000,1,300));call('r1',tone(24000,1.5,300));call('r1',null);await f.settle();
  assert.equal(f.embedded.length,4);
  // Too little speech teaches nothing; a busy engine is left alone and does not use up the interval.
  f.advance(60000);
  const short=f.learner.utterance('system_tts',24000);short.push(tone(24000,1,300));short.push(new Int16Array(48000));short.end();await f.settle();
  busy=true;const skipped=f.learner.utterance('system_tts',24000);skipped.push(tone(24000,3,300));skipped.end();await f.settle();
  assert.equal(f.embedded.length,4);
  busy=false;const later=f.learner.utterance('system_tts',24000);later.push(tone(24000,3,300));later.end();await f.settle();
  assert.equal(f.embedded.length,5);
  assert.deepEqual((await f.registry.assistantVoices()).map(v=>[v.voice,v.count]),[['system_tts',2],['realtime_call',1]]);
  await f.learner.close();
  const closed=f.learner.utterance('realtime_call',24000);f.advance(60000);closed.push(tone(24000,3,300));closed.end();await f.settle();
  assert.equal(f.embedded.length,5,'a closed learner takes nothing');
});

test('a keyed stream ends an utterance when the next one starts; the TTS port returns its audio untouched and never fails for learning',async t=>{
  const f=await setup(t);
  const call=f.learner.stream('realtime_call',24000);
  call('r1',tone(24000,2,300));call('r2',tone(24000,0.5,300));await f.settle();
  assert.equal(f.embedded.length,1,'r1 ended when r2 began');
  const audio=inspectWav(wav(tone(24000,2.5,300),24000)),port:TtsPort={synthesize:async()=>audio};
  f.advance(60000);
  const spoken=await learningTts(port,f.learner).synthesize('好的，已经关灯了。','request');await f.settle();
  assert.equal(spoken,audio);assert.equal(f.embedded.length,2);
  assert.deepEqual((await f.registry.assistantVoices()).map(v=>v.voice).sort(),['realtime_call','system_tts']);
  const broken:TtsPort={synthesize:async()=>({...audio,bytes:new Uint8Array(10)}) as TtsAudio};
  f.advance(60000);
  assert.equal((await learningTts(broken,f.learner).synthesize('x','r')).bytes.length,10);
  assert.match(String((f.errors[0] as Error).message),/TTS_INVALID_WAV/);
});

test('an engine of another speaker model is refused, reported, and teaches nothing',async t=>{
  const f=await setup(t,{model:{...MODEL,sha256:'d'.repeat(64)}});
  const speech=f.learner.utterance('system_tts',16000);speech.push(tone(16000,3,300));speech.end();await f.settle();
  assert.deepEqual(f.embedded,[]);assert.match(String((f.errors[0] as Error).message),/VOICEPRINT_SPEAKER_MODEL_MISMATCH/);
  assert.deepEqual(await f.registry.assistantVoices(),[]);
});

test('streamed playback learns one utterance from the emitted audio at its provider rate',async t=>{
  const f=await setup(t),audio=inspectWav(wav(tone(22050,1,300),22050));
  const port:TtsPort={synthesize:async()=>audio,stream:async function*(){yield audio;yield audio;}};
  const emitted:TtsAudio[]=[];
  for await(const chunk of learningTts(port,f.learner).stream!('逐字文本。','stream'))emitted.push(chunk);
  await f.settle();
  assert.deepEqual(emitted,[audio,audio]);assert.deepEqual(f.errors,[]);
  assert.equal(f.embedded.length,1);assert.ok(f.embedded[0]!>=30000);
  assert.deepEqual((await f.registry.assistantVoices()).map(v=>[v.voice,v.count]),[['system_tts',1]]);
});
