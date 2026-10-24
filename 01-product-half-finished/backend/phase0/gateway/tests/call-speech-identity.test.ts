import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceprintRegistry} from '../../../services/personal-aios-integration/src/voiceprint/registry.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {speechQuality} from '../../../services/personal-aios-integration/src/voiceprint/contracts.ts';
import {createCallSpeechIdentity,type CallSpeechChannel} from '../src/call-speech-identity.ts';
import {createCallTurnManager,type CallSpeakerEvidence} from '../src/call-turn-manager.ts';

const MODEL={id:'call-identity-synthetic',sha256:'d'.repeat(64),dim:16};
const AT=Date.parse('2026-10-18T10:00:00Z');
const at=(n:number)=>new Date(AT+n*2000).toISOString();
function vector(base:number,seed=0,sign=1){
  const e=new Float32Array(16);e[0]=base;e[1]=sign*Math.sqrt(1-base*base);e[2]=seed*.002;
  const norm=Math.hypot(...e);return e.map(v=>v/norm);
}
const pcm=(marker:number,ms=1500)=>new Float32Array(ms*16).fill(marker/100);
async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'call-speech-identity-'));
  const registry=new VoiceprintRegistry(new PosixStorage(root),MODEL);
  t.after(async()=>{await registry.close();await rm(root,{recursive:true,force:true});});
  await registry.enrollOwner({speaker_model:MODEL,channel:'file',mode:'replace',
    samples:Array.from({length:5},()=>({embedding:vector(1),speech_ms:2000})),at:at(0)});
  let reads=0,sequence=0;
  const vectors=new Map<number,Float32Array>();
  const call=(enrollment=false,channel:CallSpeechChannel='call',trustCall=true)=>{
    const controller=new AbortController(),scope={principal_id:'owner',device_id:`device-${++sequence}`},call_id=`call-${sequence}`;
    controller.signal.addEventListener('abort',()=>registry.closeTrustCall(scope,call_id),{once:true});
    const helper=createCallSpeechIdentity({registry,enrollment,channel:()=>channel,trust_scope:scope,...(trustCall?{call_id}:{}),signal:controller.signal,identify:async(samples,ms,_signal,observed)=>{
      reads++;
      const embedding=vectors.get(Math.round(samples[0]!*100))!;
      const identity=await registry.identify(embedding,{speech_ms:ms,mode:'call',observed_at:observed!,channel,...scope,...(trustCall?{call_id}:{}),quality:speechQuality(samples)});
      const verdict=identity.kind==='owner'?(identity.band==='verified'?'owner':'uncertain'):
        identity.kind==='speaker'?'guest':identity.kind;
      return {verdict,embedding,...(identity.kind==='owner'?{score:identity.score,...(identity.call_only?{call_only:true as const}:{}),...(identity.trust_window?{trust_window:true as const}:{})}:{})} as CallSpeakerEvidence;
    }});
    const confirm=helper.confirm;
    helper.confirm=async(samples,ms,observed,cache)=>{registry.openTrustWindow(scope,{...(trustCall?{call_id}:{}),channel,at:observed});await confirm(samples,ms,observed,cache);};
    return {helper,controller,identify:(marker:number,ms=1500,n=0)=>helper.identify(pcm(marker,ms),ms,controller.signal,at(n))};
  };
  return {registry,vectors,call,reads:()=>reads};
}

test('raw verified owner anchors 200 ms call-only matching at the .65 threshold',async t=>{
  const f=await fixture(t),c=f.call();
  f.vectors.set(1,vector(1));f.vectors.set(2,vector(.66));f.vectors.set(3,vector(.649));f.vectors.set(4,vector(0,0,-1));
  assert.equal(f.registry.policy.thresholds.owner_verified,.65);
  assert.equal((await c.identify(1) as {verdict:string}).verdict,'owner');
  assert.deepEqual(c.helper.snapshot(),{anchored:true});
  assert.deepEqual(await c.identify(2,200),{verdict:'owner',call_only:true});
  for(const [marker,ms] of [[2,199],[3,200],[4,1500]] as const)
    assert.notEqual((await c.identify(marker,ms) as {verdict:string}).verdict,'owner');
  assert.equal((await f.registry.owner('call')).samples,1,'only the original independently verified window teaches the library');
});

test('Face ID admits every later turn while only matching quality independent windows teach future calls',async t=>{
  const f=await fixture(t),c=f.call();
  for(let n=1;n<=8;n++)f.vectors.set(n,vector(.2,n));
  f.vectors.set(9,vector(.2,0,-1));f.vectors.set(100,vector(.2,10));
  await c.helper.confirm(pcm(1),1500,at(1));
  assert.deepEqual(c.helper.snapshot(),{anchored:false});
  assert.equal((await c.identify(9,1500,2) as {call_only?:true}).call_only,true,'this call keeps the biometric decision across speaker changes');
  assert.deepEqual(c.helper.snapshot(),{anchored:false},'a different voice admitted by the trust window cannot seed a voiceprint anchor');
  await c.identify(100,1500,3); // amplitude 1 is clipped, so this sample cannot teach the library.
  await c.identify(2,999,4);
  assert.equal((await f.registry.owner('call')).samples,1);
  await c.identify(2,1500,5);await c.identify(2,1500,6); // duplicate
  await c.identify(3,1500,5); // overlap with the last accepted window
  assert.equal((await f.registry.owner('call')).samples,2);
  for(let n=3;n<=5;n++)await c.identify(n,1500,7+n);
  assert.equal((await f.registry.owner('call')).samples,5);
  const next=f.call(),result=await next.identify(6,1500,20);
  assert.equal((result as {verdict:string}).verdict,'owner');assert.equal((result as {call_only?:true}).call_only,true);
  assert.deepEqual(next.helper.snapshot(),{anchored:true},'a learned-set voiceprint verdict can seed the next call anchor');
  assert.deepEqual(await next.identify(6,200,20),{verdict:'owner',call_only:true},'short speech may use that voiceprint anchor');
  c.controller.abort();assert.deepEqual(c.helper.snapshot(),{anchored:false});
  assert.equal(await c.identify(1,1500,21),undefined);
  const independent=f.call();assert.deepEqual(independent.helper.snapshot(),{anchored:false});
  assert.notEqual((await independent.identify(9,1500,22) as {verdict:string}).verdict,'owner');
});

test('enrollment replies as owner without running identity or persisting call samples',async t=>{
  const f=await fixture(t),c=f.call(true);
  for(const ms of [200,1500])assert.deepEqual(await c.identify(99,ms),{verdict:'owner',call_only:true});
  assert.equal(f.reads(),0);assert.equal((await f.registry.owner('call')).samples,0);
});

const settle=async()=>{for(let n=0;n<20;n++)await new Promise<void>(resolve=>setImmediate(resolve));};
test('manager approval answers and learns; denial observes once and cannot commit',async t=>{
  for(const approved of [true,false]){
    const f=await fixture(t),c=f.call();f.vectors.set(1,vector(.5));
    const commits:boolean[]=[],observations:string[]=[],errors:unknown[]=[];let cards=0;
    const decision=Promise.withResolvers<void>(),answered=Promise.withResolvers<void>();let clock=AT+5000;
    const manager=createCallTurnManager({config:{enabled:true},now:()=>clock,identify:c.helper.identify,
      confirm:async(samples,text,_references,_signal,observed,cache)=>{
        cards++;if(approved)await c.helper.confirm(samples,samples.length/16,observed,cache);
        else observations.push(text); // The confirmation callback owns denial's observation.
        decision.resolve();return approved;
      },transcribe:async()=> '请告诉我天气',classify:async()=>({stop:false,guests:'unchanged',directed:true}),score:async()=>1,
      commit:async(_samples,owner,text)=>{await text;commits.push(owner);answered.resolve();},
      observation:text=>observations.push(text),context:async()=>{},interrupt:()=>{},thinking:()=>{},onError:e=>errors.push(e)});
    t.after(()=>manager.close());manager.start();
    const samples=pcm(1);manager.speech({samples,asr_samples:samples,speech_ms:1500,reason:'end'});
    await decision.promise;if(approved)await answered.promise;await settle();
    assert.deepEqual(errors,[]);assert.deepEqual(commits,approved?[true]:[]);
    assert.equal(observations.length,approved?0:1);assert.equal((await f.registry.owner('call')).samples,approved?1:0);
    if(approved){
      clock+=2000;manager.replyEnded();manager.start();const short=pcm(1,200);
      manager.speech({samples:short,asr_samples:short,speech_ms:200,reason:'end'});await settle();
      assert.deepEqual(commits,[true,true]);assert.equal(cards,1,'confirmed call speech uses its anchor without another card');
    }
    await manager.close();c.controller.abort();
  }
});

test('call-only owner evidence cannot authorize guest replies',async t=>{
  const f=await fixture(t),c=f.call();f.vectors.set(1,vector(.2));f.vectors.set(2,vector(.2,0,-1));
  await c.helper.confirm(pcm(1),1500,at(1));
  const commits:boolean[]=[],observations:string[]=[],errors:unknown[]=[];
  let text='允许其他人向你提问';
  const manager=createCallTurnManager({config:{enabled:true},now:()=>AT+5000,identify:c.helper.identify,
    transcribe:async()=>text,classify:async()=>({stop:false,guests:'allow'}),score:async()=>1,
    commit:async(_samples,owner)=>{commits.push(owner);},observation:value=>observations.push(value),
    context:async()=>{},interrupt:()=>{},thinking:()=>{},onError:e=>errors.push(e)});
  t.after(()=>manager.close());manager.start();let samples=pcm(1);
  manager.speech({samples,asr_samples:samples,speech_ms:1500,reason:'end'});await settle();
  assert.deepEqual(commits,[true]);manager.replyEnded();
  // The ended biometric scope cannot supply owner evidence or inherit a guest grant.
  c.controller.abort();
  text='我也想问天气';manager.start();samples=pcm(2);
  manager.speech({samples,asr_samples:samples,speech_ms:1500,reason:'end'});await settle();
  assert.deepEqual(errors,[]);assert.deepEqual(commits,[true]);
});


test('biometric confirmation retains the original turn beyond the scoring deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const approval=Promise.withResolvers<boolean>(),commits:boolean[]=[],errors:unknown[]=[];
  const manager=createCallTurnManager({config:{enabled:true,max_wait_ms:10},identify:async()=>({verdict:'uncertain'}),
    classify:async()=>({stop:false,guests:'unchanged',directed:true}),confirm:()=>approval.promise,transcribe:async()=> '请告诉我天气',score:async()=>1,
    commit:async(_samples,owner)=>{commits.push(owner);},context:async()=>{},interrupt:()=>{},thinking:()=>{},onError:error=>errors.push(error)});
  t.after(()=>manager.close());manager.start();const samples=pcm(1);
  manager.speech({samples,asr_samples:samples,speech_ms:1500,reason:'end'});await settle();
  t.mock.timers.tick(20);await settle();
  assert.equal(manager.snapshot().pending_candidates,1);assert.equal(manager.snapshot().closed,false);assert.deepEqual(commits,[]);
  approval.resolve(true);await settle();
  assert.deepEqual(commits,[true]);assert.deepEqual(errors,[]);
  await manager.close();assert.equal(manager.snapshot().retained_bytes,0);
});


test('biometric confirmation learns glasses and Mac in their own capture chains without holding ambient trust',async t=>{
  t.mock.timers.enable({apis:['Date'],now:AT+15000});
  const f=await fixture(t);f.vectors.set(1,vector(.2));
  for(const channel of ['glasses','mac'] as const){
    const c=f.call(false,channel,false);await c.helper.confirm(pcm(1),1500,at(1));
    assert.equal((await f.registry.diagnostics()).sets.find(set=>set.kind==='learned'&&set.channel===channel)?.samples,1);
    assert.equal((await f.registry.owner('call')).samples,0);
    assert.equal((await c.identify(1,200,2) as {verdict:string}).verdict,'owner');
    c.controller.abort();
  }
});
