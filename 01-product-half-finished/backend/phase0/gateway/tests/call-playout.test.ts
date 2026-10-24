import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {AudioSource,dispose} from '@livekit/rtc-node';
import {createCallPlayout,SKIP_FADE_SAMPLES} from '../src/call-playout.ts';

after(()=>dispose());

// Use the installed native SDK: captureFrame keeps re-arming waitForPlayout while
// the 100 ms native queue consumes a longer reply. No simulated drain or SDK fields.
test('played sample position advances during continuous SDK capture before drain resolves',async()=>{
  const errors:unknown[]=[],archived:Int16Array[]=[],subscribed=Promise.withResolvers<void>();
  const output=createCallPlayout({localParticipant:{publishTrack:async()=>({sid:'audio',waitForSubscription:()=>subscribed.promise}),
    unpublishTrack:async()=>{}}},'position',()=>{},error=>errors.push(error),undefined,pcm=>archived.push(pcm));
  try{
    await output.open();output.push(new Int16Array(24000));
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(output.playedSamples!(),0,'PCM waiting for subscription has not played');
    assert.equal(archived.length,0,'unsubscribed PCM is not archived as reply output');
    subscribed.resolve();let drained=false;const drain=output.drain().then(()=>{drained=true;});
    await new Promise(resolve=>setTimeout(resolve,200));
    const position=output.playedSamples!();
    assert.ok(position>0&&position<24000,`mid-reply played samples: ${position}`);
    assert.ok(archived.length>0,'archive callbacks coexist with the live playhead');
    assert.equal(drained,false,'continuous capture is still active');
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.ok(output.playedSamples!()>=position,'position is monotonic');
    output.interrupt();assert.equal(output.playedSamples!(),0,'replacement output starts at zero');
    const atCut=archived.length;await drain;assert.equal(archived.length,atCut,'retired output cannot archive late frames');assert.deepEqual(errors,[]);
  }finally{await output.close();}
});


test('fresh-room audio rebind does not await departed-room unpublish and keeps position and archive ownership',async t=>{
  const oldClose=Promise.withResolvers<void>(),retired:string[]=[],archived:number[]=[];let fresh=0;
  t.mock.method(AudioSource.prototype,'captureFrame',async()=>{});
  const output=createCallPlayout({localParticipant:{publishTrack:async()=>({sid:'old-room',waitForSubscription:async()=>{}}),
    unpublishTrack:async sid=>{retired.push(sid);await oldClose.promise;}}},'rejoin',()=>{},error=>assert.fail(String(error)),undefined,pcm=>archived.push(...pcm));
  try{
    await output.open();output.push(new Int16Array(480).fill(1));await output.drain();assert.equal(output.playedSamples!(),480);
    const rebinding=output.rebindRoom!({localParticipant:{publishTrack:async()=>{fresh++;return {sid:'fresh-room',waitForSubscription:async()=>{}};},unpublishTrack:async()=>{}}});
    await new Promise(setImmediate);assert.equal(fresh,1,'a hung departed room cannot gate replacement publication');await rebinding;
    output.push(new Int16Array(960).fill(2));await output.drain();assert.equal(output.playedSamples!(),1440);
    assert.deepEqual(archived,[...new Array(480).fill(1),...new Array(960).fill(2)]);assert.deepEqual(retired,['old-room']);
    output.interrupt();assert.equal(output.playedSamples!(),0);
  }finally{oldClose.resolve();await output.close();}
});

test('skip ends the thinking clip on the same track: a 40 ms fade once it started, nothing if it never did',async t=>{
  const gates:(()=>void)[]=[],archived:number[]=[];let published=0;
  t.mock.method(AudioSource.prototype,'captureFrame',()=>new Promise<void>(resolve=>gates.push(resolve)));
  const output=createCallPlayout({localParticipant:{publishTrack:async()=>{published++;return {sid:'hum',waitForSubscription:async()=>{}};},unpublishTrack:async()=>{}}},
    'skip',()=>{},error=>assert.fail(String(error)),undefined,pcm=>archived.push(...pcm));
  const pump=async(samples:number)=>{while(archived.length<samples){if(gates.length)gates.shift()!();await new Promise(setImmediate);}};
  try{
    await output.open();assert.equal(output.skip!(),0,'nothing to skip');
    output.push(new Int16Array(4800).fill(1000),undefined,true);
    await pump(960);while(!gates.length)await new Promise(setImmediate);
    assert.equal(output.skip!(),4800-1440-SKIP_FADE_SAMPLES,'two frames played and one queued; the rest after the fade never plays');
    assert.equal(output.skip!(),0,'a clip is skipped once');
    output.push(new Int16Array(480).fill(7));await pump(1440+SKIP_FADE_SAMPLES+480);
    assert.deepEqual(archived.slice(0,1440),new Array(1440).fill(1000));
    const fade=archived.slice(1440,1440+SKIP_FADE_SAMPLES);
    assert.ok(fade[0]===1000&&fade.at(-1)!<=2&&fade.every((v,i)=>!i||v<=fade[i-1]!),'linear fade to silence');
    assert.deepEqual(archived.slice(1440+SKIP_FADE_SAMPLES),new Array(480).fill(7),'her reply follows the fade at once');
    assert.equal(output.playedSamples!(),1440+SKIP_FADE_SAMPLES+480);assert.equal(published,1,'same track; nothing retired');
    output.push(new Int16Array(480).fill(5));output.push(new Int16Array(2400).fill(9),undefined,true);
    assert.equal(output.skip!(),2400,'a clip still queued behind other audio is dropped whole');
    output.push(new Int16Array(480).fill(7));await pump(archived.length+960);
    assert.deepEqual(archived.slice(-960),[...new Array(480).fill(5),...new Array(480).fill(7)]);
  }finally{for(const gate of gates.splice(0))gate();await output.close();}
});
