// Real sherpa-onnx models on macOS-synthesized speech (generated at runtime, never committed). Skips when the models
// or the `say` voices are absent. Thresholds here only separate two TTS voices; real ones calibrate on enrollment.
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSpeechEngine} from '../src/voiceprint/engine.ts';
import {SherpaSileroStreamFactory} from '../src/media/silero-stream.ts';
import {embedSpeech,SPEAKER_WINDOW_SAMPLES,type SpeakerIdentifier} from '../src/voiceprint/contracts.ts';
import {floats,realModelsPresent,realSpeechConfig,sayPresent,silence,synthesize,transcribeWindow,VOICE_A,VOICE_B} from './speech-fixture.ts';

const real={skip:!realModelsPresent||!sayPresent?'sherpa models or macOS say voices absent':false};
let engine:LocalSpeechEngine,root:string,openMs=0;
const clip:Record<string,Buffer>={};
const timed=async<T>(run:()=>Promise<T>):Promise<[T,number]>=>{const start=performance.now();const value=await run();return [value,performance.now()-start];};
const cosine=(a:Float32Array,b:Float32Array)=>{let dot=0,x=0,y=0;for(let n=0;n<a.length;n++){dot+=a[n]!*b[n]!;x+=a[n]!**2;y+=b[n]!**2;}return dot/Math.sqrt(x*y);};
before(async()=>{
  if(real.skip)return;
  root=await fs.mkdtemp(join(tmpdir(),'paios-speech-real-'));
  const lines={barewake:[VOICE_A,'依米。'],wake:[VOICE_A,'依米，帮我看看明天会不会下雨。'],plain:[VOICE_A,'帮我看看明天会不会下雨。'],a1:[VOICE_A,'今天中午我们去吃面条吧。'],
    a2:[VOICE_A,'我下午要去银行办点事情。'],b1:[VOICE_B,'好的，下午三点再开会。'],b2:[VOICE_B,'这个周末天气应该不错。'],
    mixed:[VOICE_A,'请打开电脑上的 WiFi，然后检查网络。']} as const;
  for(const [name,[voice,text]] of Object.entries(lines))clip[name]=await synthesize(root,voice,text);
  [engine,openMs]=await timed(()=>LocalSpeechEngine.open(realSpeechConfig));
});
after(async()=>{await engine?.close();if(root)await fs.rm(root,{recursive:true,force:true});});

test('SenseVoice transcribes synthesized Mandarin through the engine thread',real,async t=>{
  const [result,ms]=await timed(()=>engine.transcribe(floats(clip.plain!)));
  assert.match(result.text,/明天.*下雨/u);assert.equal(result.lang,'zh');
  t.diagnostic(`model load ${openMs.toFixed(0)} ms (pins verified, 4 models); transcribe ${ms.toFixed(0)} ms for ${(clip.plain!.length/32000).toFixed(2)} s: ${result.text}`);
  assert.match(engine.version,/^sherpa-onnx@1\.13\.8\+[a-f0-9]{16}$/u);
});

test('Chinese source language keeps embedded English words readable',real,async t=>{
  const result=await engine.transcribe(floats(clip.mixed!));
  assert.equal(result.lang,'zh');assert.match(result.text,/打开.*电脑/u);
  assert.match(result.text,/wi[\s-]?fi/iu);assert.match(result.text,/检查.*网络/u);
  t.diagnostic(result.text);
});

test('two voices give separable speaker embeddings',real,async t=>{
  const vectors:Record<string,Float32Array>={};let spent=0;
  for(const name of ['a1','a2','b1','b2']){const [vector,ms]=await timed(()=>engine.embed(floats(clip[name]!)));vectors[name]=vector;spent+=ms;}
  assert.equal(vectors.a1!.length,192);
  const same=[cosine(vectors.a1!,vectors.a2!),cosine(vectors.b1!,vectors.b2!)],cross=[vectors.b1!,vectors.b2!].flatMap(b=>[cosine(vectors.a1!,b),cosine(vectors.a2!,b)]);
  t.diagnostic(`embed avg ${(spent/4).toFixed(0)} ms; same-voice cosine ${same.map(v=>v.toFixed(2)).join(',')}; cross-voice ${cross.map(v=>v.toFixed(2)).join(',')}`);
  assert.ok(Math.min(...same)>Math.max(...cross),'every same-voice pair is closer than every cross-voice pair');
});

test('the Silero detector splits a two-utterance window and the consumer labels each utterance by voice',real,async t=>{
  const window=Buffer.concat([silence(0.3),clip.a1!,silence(0.9),clip.b1!,silence(0.6)]);
  const stream=await new SherpaSileroStreamFactory(async()=>engine).open(new AbortController().signal);
  const [progress,vadMs]=await timed(()=>stream.write(window));const terminal=await stream.finish();
  const starts=progress.filter(p=>p.start!==undefined).map(p=>p.start!),ends=progress.filter(p=>p.end!==undefined).map(p=>p.end!);
  assert.ok(starts.length>=2);assert.equal(ends.length,starts.length);assert.ok(starts.every((start,n)=>start<ends[n]!&&(n===0||ends[n-1]!<start)));
  assert.ok(starts.some(start=>Math.abs(start-(0.3+0.9)*16000-clip.a1!.length/2)<8000),'second voice starts near its true onset');
  assert.equal(terminal.processed_samples+terminal.uninferred_samples,window.length/2);
  const enrolled=await engine.embed(floats(clip.a2!)),calls:{speech_ms:number;mode:string}[]=[];
  const speakers:SpeakerIdentifier={model:engine.speaker_model,identify:async(embedding,input)=>{calls.push(input);
    return cosine(embedding,enrolled)>0.5?{kind:'owner',band:'verified',score:cosine(embedding,enrolled)}:{kind:'speaker',cluster_id:'b',score:0.5};}};
  const [{d,observation},ms]=await timed(()=>transcribeWindow(t,window,engine,speakers));
  t.diagnostic(`VAD ${vadMs.toFixed(0)} ms for ${(window.length/32000).toFixed(2)} s; whole window (VAD+ASR+embedding+D) ${ms.toFixed(0)} ms; ${d.content.transcript}`);
  assert.equal(observation.segments.length,starts.length);
  const voices=observation.segments.map(s=>s.speaker).filter((speaker,n,all)=>n===0||speaker!==all[n-1]);
  assert.deepEqual(voices,['owner','speaker:b'],'short acoustic pauses preserve speaker ordering');
  assert.match(String(d.content.transcript),/今天中午.*面条/u);assert.match(String(d.content.transcript),/下午(?:三|3)点.*开会/u);
  assert.equal(calls.length,starts.length);assert.ok(calls.every(c=>c.mode==='observe'&&c.speech_ms>=250));
});

test('keyword spotting hits 依米 and stays silent on the same request without it',real,async t=>{
  const spot=async(pcm:Buffer)=>{const stream=await engine.keywords!.open(new AbortController().signal),samples=floats(pcm),hits=[];
    for(let at=0;at<samples.length;at+=1600)hits.push(...await stream.write(samples.subarray(at,at+1600)));
    return [...hits,...await stream.finish()];};
  const [wake,ms]=await timed(()=>spot(clip.wake!));const plain=await spot(clip.plain!);
  t.diagnostic(`KWS ${ms.toFixed(0)} ms for ${(clip.wake!.length/32000).toFixed(2)} s streamed in 100 ms chunks; hits ${JSON.stringify(wake)}`);
  assert.equal(wake.length,1);assert.equal(wake[0]!.keyword,'依米');assert.ok(wake[0]!.at_sample<=clip.wake!.length/2);
  assert.deepEqual(plain,[]);
});

test('abort drops queued inference before dispatch; close joins the running call and refuses later ones',real,async()=>{
  const own=await LocalSpeechEngine.open(realSpeechConfig),long=floats(Buffer.concat([clip.a1!,clip.b1!,clip.a2!])),queued=new AbortController();
  // ASR and identity are independent lanes. Queue cancellation behind work in the same speaker lane.
  const running=own.transcribe(long),embedding=own.embed(long),dropped=own.embed(long,queued.signal),behind=own.transcribe(floats(clip.plain!));
  queued.abort();await assert.rejects(dropped,/SPEECH_CANCELLED/);
  const settled=behind.then(()=>'resolved',(error:Error)=>error.message);
  await own.close();
  assert.match((await running).text,/面条/u);assert.equal((await embedding).length,192);assert.equal(await settled,'SPEECH_ENGINE_CLOSED');
  await assert.rejects(own.transcribe(long),/SPEECH_ENGINE_CLOSED/);await assert.rejects(own.keywords!.open(new AbortController().signal),/SPEECH_ENGINE_CLOSED/);
});


test('ambient endpoint closes a bare wake with bounded silence',real,async t=>{
  const samples=floats(Buffer.concat([silence(.3),clip.barewake!,silence(.7)])),vad=await engine.openVad(new AbortController().signal);
  try {
    const events=await vad.write(samples.subarray(0,Math.floor(samples.length/512)*512)),ends=events.filter(e=>e.end!==undefined);
    assert.equal(ends.length,1,'a bare wake remains one complete candidate');
    assert.ok(ends.every(e=>(e.at-e.end!)/16<=384),'endpoint stays within one 32ms detector frame of the 352ms policy');
    t.diagnostic(`native ambient endpoint ${ends.map(e=>(e.at-e.end!)/16).join('/')}ms; early wake at ${ends[0]!.at/16}ms`);
  }finally{await vad.close();}
});

test('pinned AudioSet tagger accepts sub-second input without a native crash or silence health claim',real,async t=>{
  for(const ms of [100,300,1000,3000])assert.equal(await engine.tag(new Float32Array(ms*16)),undefined);
  assert.equal(await engine.tag(floats(clip.plain!)),undefined,'ordinary owner speech is not a health sound');
  t.diagnostic(`AudioSet ${engine.tagging_model!.id}: pinned model/labels, four short silent windows and Mandarin speech`);
});

test('canonical speaker windows preserve short speech and long-utterance identity; tagger keeps its 10 s budget',real,async t=>{
  const voice=(names:string[],seconds:number)=>{const parts:Buffer[]=[];let n=0;
    while(parts.reduce((sum,p)=>sum+p.length,0)<seconds*32000){parts.push(clip[names[n++%names.length]!]!,silence(0.2));}
    return floats(Buffer.concat(parts).subarray(0,seconds*32000));};
  const short=floats(clip.a1!).subarray(0,SPEAKER_WINDOW_SAMPLES);
  assert.deepEqual(await embedSpeech(engine,short),await engine.embed(short));
  const enrolledA=await embedSpeech(engine,floats(clip.a2!)),enrolledB=await embedSpeech(engine,floats(clip.b2!)),rows:string[]=[];
  for(const seconds of [10,15,25,40,60])for(const [name,names] of [['A',['a1','a2','plain']],['B',['b1','b2']]] as const){
    const sizes:number[]=[],input=voice([...names],seconds),windowed=await embedSpeech({embed:async part=>{
      sizes.push(part.length);return engine.embed(part);}},input);
    assert.equal(cosine(windowed,enrolledA)>cosine(windowed,enrolledB)?'A':'B',name);
    assert.ok(sizes.every(size=>size<=SPEAKER_WINDOW_SAMPLES));
    assert.equal(sizes.reduce((a,b)=>a+b,0),input.length);
    rows.push(`${name} ${seconds}s: ${sizes.length} windows; vs A ${cosine(windowed,enrolledA).toFixed(2)}, vs B ${cosine(windowed,enrolledB).toFixed(2)}`);
  }
  t.diagnostic(rows.join('; '));
  await assert.rejects(engine.tag(new Float32Array(160001)),/SPEECH_INPUT_BUDGET/);assert.equal(await engine.tag(new Float32Array(160000)),undefined);
});
