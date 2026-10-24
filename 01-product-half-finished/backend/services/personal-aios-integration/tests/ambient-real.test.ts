// Real sherpa-onnx models on a macOS-synthesized multi-voice conversation through the interval_v2 ambient lane: Silero
// VAD candidates, SenseVoice text, the engine's keyword spotter, ERes2NetV2 embeddings against an enrolled owner, the
// journal, and wake turns (request audio analysed as one speaker turn) admitted to a fake Hermes. The owner speaks the way
// the owner's real recording did: "依米" alone, a pause, then the request with a mid-sentence pause. Skips without the
// models or the `say` voices; audio is generated at runtime. Voices: Tingting is the owner; Grandpa and Eddy are other
// people (Meijia scores in the owner's uncertain band).
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
import type {WakeRequest} from '../src/ambient/lane.ts';
import {floats,realAmbientLane,realModelsPresent,realSpeechConfig,silence,synthesize} from './speech-fixture.ts';

const OWNER='Tingting',NEIGHBOUR='Grandpa (中文（中国大陆）)',GUEST='Eddy (中文（中国大陆）)';
const voices=(()=>{try {return existsSync('/usr/bin/afconvert')?execFileSync('/usr/bin/say',['-v','?'],{encoding:'utf8'}):'';} catch {return '';}})();
const present=[OWNER,NEIGHBOUR,GUEST].every(voice=>voices.split('\n').some(line=>line.startsWith(voice+' ')));
const T0=Date.parse('2026-10-09T09:00:00.000Z');

test('real models: a multi-voice day lands in the journal; the owner\'s 依米 turn runs with the conversation, another speaker stays restricted',
  {skip:!realModelsPresent||!present?'sherpa models or macOS say voices absent':false,timeout:600000},async t=>{
  const started=performance.now(),directory=await mkdtemp(join(tmpdir(),'paios-ambient-real-'));
  const engine=await LocalSpeechEngine.open(realSpeechConfig);
  t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  const say=(voice:string,text:string)=>synthesize(directory,voice,text);
  // Owner enrollment from three of the owner's own sentences (production enrollment uses five).
  const registry=new VoiceprintRegistry(new PosixStorage(join(directory,'voiceprints')),engine.speaker_model,{policy:{min_enroll_samples:3}});
  t.after(()=>registry.close());
  const enroll=await Promise.all(['今天下午三点提醒我去开会','帮我查一下明天北京的天气','我想点一杯少糖的珍珠奶茶'].map(text=>say(OWNER,text)));
  const samples=[];for(const pcm of enroll)samples.push({embedding:await engine.embed(floats(pcm)),speech_ms:pcm.length/32});
  const enrolled=await registry.enrollOwner({speaker_model:engine.speaker_model,channel:'file',mode:'replace',samples});assert.equal(enrolled.enrolled,true);
  const conversation=Buffer.concat([silence(0.5),await say(NEIGHBOUR,'我们这个周末去爬山好不好？'),silence(1.2),
    await say(OWNER,'好啊，那我们就去香山吧。'),silence(1.2),await say(OWNER,'依米。'),silence(0.6),await say(OWNER,'帮我看看明天北京的天气，'),
    silence(0.6),await say(OWNER,'会不会下雨？'),silence(2.0),await say(GUEST,'依米，今天是几号，明天又是星期几？'),silence(2.0)]);
  const synthesized=performance.now();

  const {entries,bodies,seconds}=await realAmbientLane(t,directory,engine,registry,conversation,T0,2);
  t.diagnostic(`synthesis+enrollment ${((synthesized-started)/1000).toFixed(1)} s; lane ${seconds.toFixed(1)} s for `+
    `${(conversation.length/32000).toFixed(1)} s of audio; journal: ${entries.map(e=>`${e.speaker}${e.wake?'*':''}:${e.text}`).join(' | ')}`);
  // Neighbour, owner, the owner's "依米" alone (too short to identify), the request in two parts, the guest's inline wake.
  assert.equal(entries.length,6);
  assert.deepEqual(entries.map(e=>e.wake),[null,null,'依米',null,null,'依米']);
  assert.equal(entries[1]!.speaker,'owner');assert.equal(entries[3]!.speaker,'owner');
  assert.ok(entries[0]!.speaker?.startsWith('speaker:')&&entries[5]!.speaker?.startsWith('speaker:')&&entries[0]!.speaker!==entries[5]!.speaker,
    'two different other people');
  assert.equal(new Set(entries.map(e=>e.conversation_id)).size,1);

  assert.equal(bodies.length,2,'only the two wake turns run');
  const [owner,guest]=bodies.map(body=>({...body,d:JSON.parse(body.input) as ProcessedEvent}));
  const ownerWake=owner!.d.content.wake_request as unknown as WakeRequest,guestWake=guest!.d.content.wake_request as unknown as WakeRequest;
  // The request's identity comes from its own speech only: the owner, verified — no "确认是我" for a paused request.
  assert.deepEqual([runScope(owner!.d),owner!.run_scope,owner!.session_id],['owner',undefined,'continuity']);
  assert.match(ownerWake.text,/天气.*下雨/u);assert.doesNotMatch(ownerWake.text,/^(依|一|伊|衣)米|^意味/u);
  assert.equal(ownerWake.wake_processed_event_id,entries[2]!.processed_event_id);
  assert.deepEqual(ownerWake.context!.entries.map(e=>e.speaker),['说话人#'+entries[0]!.speaker!.slice(8),'主人']);
  assert.match(ownerWake.context!.entries.map(e=>e.text).join(''),/爬山.*香山/u);
  // The guest's request audio is cut where the wake word ends.
  assert.deepEqual([runScope(guest!.d),guest!.run_scope],['owner_uncertain','owner_uncertain']);assert.equal(guest!.guest_key,undefined);
  assert.equal(JSON.parse(guest!.input).voice_confirmation,null,'a measured guest voice never receives an identity-confirmation card');
  assert.match(guestWake.text,/几号/u);assert.doesNotMatch(guestWake.text,/^(依|一|伊|衣)米|^意味/u);assert.equal(guestWake.context,undefined);
  assert.equal(guest!.input.includes('香山'),false,'the guest run carries nothing of the owner\'s conversation');
  t.diagnostic(`owner request: ${ownerWake.text} | guest request: ${guestWake.text}`);
});
