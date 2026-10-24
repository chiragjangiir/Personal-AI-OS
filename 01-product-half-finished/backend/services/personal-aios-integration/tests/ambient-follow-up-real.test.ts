// Real sherpa-onnx models on macOS-synthesized speech, for the two fixes after the owner's first field test: (1) the owner
// enrolled from clean WAV files (`file`) and again through the phone app's capture chain (`phone_app`) is recognized through
// that chain only thanks to its own set — the WAV set alone leaves it in doubt, as the field's 0.42 left the owner a
// stranger; (2) through the interval_v2 ambient lane fed by that chain: "依米, …" → the reply is delivered → the owner's next
// words without the wake word run as the owner's follow-up turn; (3) a short answer to 依米's question ("杭州", too short to
// identify alone) is identified together with the question's request: the owner's verifies, another voice's never does.
// Skips without the models, `say` or `afconvert`; `say` and `afconvert` run serially with timeouts. Tingting is the owner,
// Eddy another person.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {principalAttribution,runScope,type ProcessedEvent} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {LocalSpeechEngine} from '../src/voiceprint/engine.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';
import type {FollowUpRequest,WakeRequest} from '../src/ambient/lane.ts';
import {floats,realAmbientLane,realModelsPresent,realSpeechConfig,silence,synthesize,wavData,wavFile} from './speech-fixture.ts';

const OWNER='Tingting',OTHER='Eddy (中文（中国大陆）)',T0=Date.parse('2026-10-09T11:00:00.000Z');
const voices=(()=>{try {return existsSync('/usr/bin/afconvert')?execFileSync('/usr/bin/say',['-v','?'],{encoding:'utf8'}):'';} catch {return '';}})();
const present=[OWNER,OTHER].every(voice=>voices.split('\n').some(line=>line.startsWith(voice+' ')));
/** The phone app's capture chain, simulated (the field's is WebRTC AEC/NS/AGC + Opus at 16 kHz): band-limited to
 *  300-3400 Hz, an AGC that lifts quiet speech, a noise floor, soft clipping, then an AAC 16 kbps round trip. On Tingting it
 *  moves embeddings away from clean speech; compare clean enrollment with channel-matched enrollment. */
async function phoneChain(directory:string,pcm:Buffer,seed:number):Promise<Buffer> {
  const out=Buffer.alloc(pcm.length),hp=Math.exp(-2*Math.PI*300/16000),lp=Math.exp(-2*Math.PI*3400/16000);
  let x1=0,y=0,a=0,b=0,envelope=1000,state=seed;
  const noise=()=>{state=(state*1103515245+12345)&0x7fffffff;return state/0x7fffffff-0.5;};
  for(let n=0;n<pcm.length/2;n++){
    const x=pcm.readInt16LE(n*2);y=hp*(y+x-x1);x1=x;a=(1-lp)*y+lp*a;b=(1-lp)*a+lp*b;
    envelope=Math.max(Math.abs(b),envelope*0.9995);
    const v=Math.tanh((b*Math.min(4,6000/Math.max(envelope,300))+noise()*300)/20000)*20000;
    out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v))),n*2);
  }
  const base=join(directory,`phone-${seed}`);
  await writeFile(`${base}.wav`,wavFile(out));
  execFileSync('/usr/bin/afconvert',['-f','m4af','-d','aac','-b','16000',`${base}.wav`,`${base}.m4a`],{timeout:60000});
  execFileSync('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',`${base}.m4a`,`${base}-back.wav`],{timeout:60000});
  return Buffer.from(wavData(await readFile(`${base}-back.wav`)));
}

test('real models: the owner is recognized through the app\'s chain by its own set; 依米 → reply → a follow-up without the wake word runs',
  {skip:!realModelsPresent||!present?'sherpa models or macOS say voice absent':false,timeout:600000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'paios-follow-up-real-'));
  const engine=await LocalSpeechEngine.open(realSpeechConfig);
  t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  const say=(text:string)=>synthesize(directory,OWNER,text);
  const registry=new VoiceprintRegistry(new PosixStorage(join(directory,'voiceprints')),engine.speaker_model,{policy:{min_enroll_samples:3}});
  t.after(()=>registry.close());
  const sample=async(pcm:Buffer)=>({embedding:await engine.embed(floats(pcm)),speech_ms:pcm.length/32});
  const verify=async(pcm:Buffer)=>registry.identify(await engine.embed(floats(pcm)),{speech_ms:pcm.length/32,observed_at:new Date(T0).toISOString(),mode:'verify'});
  const sentences=[];for(const text of ['今天下午三点提醒我去开会','帮我查一下明天北京的天气','我想点一杯少糖的珍珠奶茶','这个周末我们一起去爬山吧'])
    sentences.push(await say(text));
  const file=[];for(const pcm of sentences)file.push(await sample(pcm));
  assert.equal((await registry.enrollOwner({speaker_model:engine.speaker_model,channel:'file',mode:'replace',samples:file})).enrolled,true);
  const heldOut=await phoneChain(directory,await say('给妈妈发个消息说我晚点到家'),99);
  const before=await verify(heldOut);
  assert.ok(!(before.kind==='owner'&&before.band==='verified'),`the WAV set alone must not verify the app's chain: ${JSON.stringify(before)}`);
  // "她了解你 → 我的声音" in the app: the same sentences, through the app's chain, become the phone_app set.
  const app=[];for(const [n,pcm] of sentences.entries())app.push(await sample(await phoneChain(directory,pcm,n+1)));
  const enrolled=await registry.enrollOwner({speaker_model:engine.speaker_model,channel:'phone_app',mode:'replace',samples:app});
  assert.deepEqual(enrolled.channels.map(c=>c.channel),['file','phone_app']);
  const after=await verify(heldOut);
  assert.deepEqual([after.kind,after.kind==='owner'&&after.band],['owner','verified']);
  assert.deepEqual([(await verify(await say('请帮我叫一辆车去机场'))).kind],['owner'],'the clean channel still is the owner');
  t.diagnostic(`held-out through the app chain: WAV set only ${JSON.stringify(before)}; with the app set ${JSON.stringify(after)}; `+
    `consistency file ${JSON.stringify(enrolled.channels[0]!.consistency)} app ${JSON.stringify(enrolled.channels[1]!.consistency)}`);

  // The ambient lane hears the app's chain: the wake turn, its reply delivered, then the owner goes on without the wake word.
  const asked=Buffer.concat([silence(0.5),await phoneChain(directory,await say('依米，帮我看看明天会不会下雨。'),21),silence(2.0)]);
  const answer=Buffer.concat([silence(1.2),await phoneChain(directory,await say('我在杭州，明天会下雨吗？'),22),silence(2.0)]);
  const {entries,bodies,seconds}=await realAmbientLane(t,directory,engine,registry,[asked,answer],T0,2,['你在哪个城市？我帮你查一下明天的天气。']);
  t.diagnostic(`lane ${seconds.toFixed(1)} s; journal: ${entries.map(e=>`${e.speaker}${e.wake?'*':''}:${e.text}`).join(' | ')}`);
  assert.equal(bodies.length,2,'the wake turn and its follow-up');
  const [wake,follow]=bodies.map(body=>({...body,d:JSON.parse(body.input) as ProcessedEvent}));
  const wakeRequest=wake!.d.content.wake_request as unknown as WakeRequest,followRequest=follow!.d.content.wake_request as unknown as FollowUpRequest;
  assert.deepEqual([wakeRequest.kind,runScope(wake!.d)],['ambient_wake','owner']);assert.match(wakeRequest.text,/下雨/u);
  assert.deepEqual([followRequest.kind,followRequest.follows_processed_event_id,runScope(follow!.d),follow!.run_scope,follow!.session_id],
    ['ambient_follow_up',wake!.d.processed_event_id,'owner',undefined,'continuity']);
  assert.match(followRequest.text,/杭州/u);assert.equal(entries.at(-1)!.wake,null,'no wake word in the follow-up');
  assert.match(followRequest.context!.entries.map(e=>e.text).join(''),/下雨/u,'the owner\'s follow-up carries the conversation');
  t.diagnostic(`wake request: ${wakeRequest.text} | follow-up: ${followRequest.text}`);
});

test('real models: a short answer to 依米\'s question is identified with the question\'s request: the owner\'s verifies, another voice\'s does not',
  {skip:!realModelsPresent||!present?'sherpa models or macOS say voices absent':false,timeout:600000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'paios-short-follow-up-real-'));
  const engine=await LocalSpeechEngine.open(realSpeechConfig);
  t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  const registry=new VoiceprintRegistry(new PosixStorage(join(directory,'voiceprints')),engine.speaker_model,{policy:{min_enroll_samples:3}});
  t.after(()=>registry.close());
  const file=[];for(const text of ['今天下午三点提醒我去开会','帮我查一下明天北京的天气','我想点一杯少糖的珍珠奶茶','这个周末我们一起去爬山吧']){
    const pcm=await synthesize(directory,OWNER,text);file.push({embedding:await engine.embed(floats(pcm)),speech_ms:pcm.length/32});}
  assert.equal((await registry.enrollOwner({speaker_model:engine.speaker_model,channel:'file',mode:'replace',samples:file})).enrolled,true);
  const asked=Buffer.concat([silence(0.5),await synthesize(directory,OWNER,'依米，帮我看看明天会不会下雨。'),silence(2.0)]);
  const answer=async(voice:string,text:string)=>Buffer.concat([silence(1.2),await synthesize(directory,voice,text),silence(2.0)]);
  const lane=async(name:string,reply:Buffer)=>{
    const {entries,bodies}=await realAmbientLane(t,join(directory,name),engine,registry,[asked,reply],T0,2,['你在哪个城市？我帮你查一下明天的天气。']);
    assert.equal(bodies.length,2,`${name}: the wake turn and its follow-up`);
    const follow=JSON.parse(bodies[1]!.input) as ProcessedEvent,framing=follow.content.wake_request as unknown as FollowUpRequest;
    const observation=(follow.content.audio_observations as {model:{native_metadata:{speaker_evidence:string}}}[])[0]!;
    t.diagnostic(`${name}: journal ${entries.map(e=>`${e.speaker}(${e.end_ms-e.start_ms} ms):${e.text}`).join(' | ')}; follow-up ${framing.text} `+
      `${JSON.stringify(follow.speakers)} ${observation.model.native_metadata.speaker_evidence}`);
    assert.equal(framing.kind,'ambient_follow_up');assert.equal(entries.at(-1)!.speaker,null,'too short for ambient listening to identify');
    assert.equal(observation.model.native_metadata.speaker_evidence,'carrier_and_request');
    return follow;
  };
  const owner=await lane('owner',await answer(OWNER,'杭州。'));
  assert.deepEqual([runScope(owner),principalAttribution(owner)],['owner','owner_voice']);
  const other=await lane('other',await answer(OTHER,'杭州。'));
  assert.notEqual(runScope(other),'owner');assert.equal(principalAttribution(other),null,'another voice never borrows the owner\'s request');
});
