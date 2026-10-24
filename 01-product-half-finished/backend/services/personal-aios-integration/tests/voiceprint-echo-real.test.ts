// Real sherpa-onnx models on macOS-synthesized voices through the interval_v2 ambient lane, for the two rules that close the
// lane's identity gaps: (1) "依米" said alone and a short request ("关灯", too short to identify alone) are identified together
// as one turn and verify the owner; the owner's wake word followed by someone else's short request never does. (2) 依米's
// own TTS reply, learned from the system's own 24 kHz TTS output and heard back through a small speaker by the glasses,
// is journaled as 依米 and its "依米" opens no wake turn. Skips without the models or the voices; `say` runs serially.
// Voices: Tingting is the owner, Rocko the assistant's TTS voice (the spotter hears its "依米"), Sinji another person.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runScope,type ProcessedEvent} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {LocalSpeechEngine} from '../src/voiceprint/engine.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import {AssistantVoiceLearner} from '../src/voiceprint/assistant-voice.ts';
import type {WakeRequest} from '../src/ambient/lane.ts';
import {floats,realAmbientLane,realModelsPresent,realSpeechConfig,silence,synthesize} from './speech-fixture.ts';

const OWNER='Tingting',ASSISTANT='Rocko (中文（中国大陆）)',OTHER='Sinji';
const voices=(()=>{try {return existsSync('/usr/bin/afconvert')?execFileSync('/usr/bin/say',['-v','?'],{encoding:'utf8'}):'';} catch {return '';}})();
const present=[OWNER,ASSISTANT,OTHER].every(voice=>voices.split('\n').some(line=>line.startsWith(voice+' ')));
const T0=Date.parse('2026-10-09T10:00:00.000Z');
/** A phone or glasses speaker heard by a microphone: no bass under ~300 Hz, nothing above ~4 kHz. */
function speaker(pcm:Buffer):Buffer {
  const out=Buffer.alloc(pcm.length),hp=Math.exp(-2*Math.PI*300/16000),lp=Math.exp(-2*Math.PI*4000/16000);
  let x1=0,y=0,a=0,b=0;
  for(let n=0;n<pcm.length/2;n++){const x=pcm.readInt16LE(n*2);y=hp*(y+x-x1);x1=x;a=(1-lp)*y+lp*a;b=(1-lp)*a+lp*b;
    out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(b))),n*2);}
  return out;
}

test('real models: a short owner request after a split "依米" verifies as one turn; 依米\'s own reply heard back opens nothing',
  {skip:!realModelsPresent||!present?'sherpa models or macOS say voices absent':false,timeout:600000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'paios-voiceprint-echo-real-'));
  const engine=await LocalSpeechEngine.open(realSpeechConfig);
  t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  const say=(voice:string,text:string,rate?:number)=>synthesize(directory,voice,text,rate);
  const registry=new VoiceprintRegistry(new PosixStorage(join(directory,'voiceprints')),engine.speaker_model,{policy:{min_enroll_samples:3}});
  t.after(()=>registry.close());
  const samples=[];
  for(const text of ['今天下午三点提醒我去开会','帮我查一下明天北京的天气','我想点一杯少糖的珍珠奶茶']){
    const pcm=await say(OWNER,text);samples.push({embedding:await engine.embed(floats(pcm)),speech_ms:pcm.length/32});}
  assert.equal((await registry.enrollOwner({speaker_model:engine.speaker_model,channel:'file',mode:'replace',samples})).enrolled,true);
  // The assistant profile comes from what the system itself sends: two TTS replies at the system TTS's 24 kHz.
  const learner=new AssistantVoiceLearner(async()=>engine,registry,{policy:{interval_ms:1},onError:error=>assert.fail(String(error))});
  for(const [n,text] of ['好的，已经帮你把客厅的灯关掉了。','明天北京晴，最高气温二十三度，适合出门。'].entries()){
    const pcm=await say(ASSISTANT,text,24000),reply=learner.utterance('system_tts',24000);
    reply.push(new Int16Array(pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.length)));reply.end();
    for(let i=0;i<500&&((await registry.assistantVoices())[0]?.count??0)<=n;i++)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.deepEqual((await registry.assistantVoices()).map(v=>[v.voice,v.count]),[['system_tts',2]]);
  await learner.close();

  const conversation=Buffer.concat([silence(0.5),await say(OWNER,'依米。'),silence(0.6),await say(OWNER,'关灯。'),silence(2.0),
    speaker(await say(ASSISTANT,'依米在呢，灯已经关好了。')),silence(2.0),await say(OWNER,'依米。'),silence(0.6),await say(OTHER,'关灯。'),silence(2.0)]);
  const {storage,entries,bodies,seconds}=await realAmbientLane(t,directory,engine,registry,conversation,T0,2);
  t.diagnostic(`lane ${seconds.toFixed(1)} s for ${(conversation.length/32000).toFixed(1)} s of audio; journal: `+
    entries.map(e=>`${e.speaker}(${e.score})${e.wake?'*':''}:${e.text}`).join(' | '));
  // The reply was heard as 依米 — the spotter did hear its "依米", the journal keeps no wake word for it.
  const echo=entries.find(e=>e.speaker==='assistant');
  assert.ok(echo&&echo.wake===null&&/关好了/u.test(echo.text),JSON.stringify(entries.map(e=>[e.speaker,e.text])));
  const heard=await Promise.all((await storage.list('processed-media')).map(async key=>JSON.parse(Buffer.from(await storage.read('processed-media',key)).toString()) as ProcessedEvent));
  const reply=heard.find(d=>d.processed_event_id===echo.processed_event_id)!;
  const segments=(reply.content.audio_observations as {segments:{speaker?:string;wake?:{keyword:string}}[]}[])[0]!.segments;
  assert.ok(segments.some(s=>s.speaker==='assistant'&&s.wake?.keyword==='依米'),'the reply\'s 依米 reached the spotter');
  assert.deepEqual(entries.map(e=>e.wake),['依米',null,null,'依米',null]);

  // Two wake turns ran, none for the reply.
  assert.equal(bodies.length,2,'the reply opened no wake turn');
  const [owner,other]=bodies.map(body=>({...body,d:JSON.parse(body.input) as ProcessedEvent}));
  const evidence=(d:ProcessedEvent)=>(d.content.audio_observations as {model:{native_metadata:{speaker_evidence?:string}}}[])[0]!.model.native_metadata.speaker_evidence;
  const ownerWake=owner!.d.content.wake_request as unknown as WakeRequest;
  t.diagnostic(`owner turn: ${JSON.stringify(owner!.d.speakers)} ${ownerWake.text} | owner wake + other's request: ${JSON.stringify(other!.d.speakers)}`);
  assert.deepEqual([owner!.d.segment_basis,evidence(owner!.d),runScope(owner!.d),owner!.run_scope],['wake_turn','wake_and_request','owner',undefined]);
  assert.match(ownerWake.text,/关灯/u);assert.equal(ownerWake.wake_processed_event_id,entries[0]!.processed_event_id);
  assert.equal(evidence(other!.d),'wake_and_request');
  assert.notEqual(runScope(other!.d),'owner','the owner\'s wake word never lends the owner\'s voice to another person\'s request');
});
