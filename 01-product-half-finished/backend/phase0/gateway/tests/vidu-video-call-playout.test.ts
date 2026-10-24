import test from 'node:test';
import assert from 'node:assert/strict';
import {createViduComponentPlayout,LEAD_MS} from '../src/vidu-component-playout.ts';
import {CallPcmBudget} from '../src/call-playout.ts';
import {createVoiceCallSession,FIRST_AUDIO_CONFIRM_MS} from '../src/voice-call-session.ts';

// Regression: video reply audio must remain continuous and avoid premature truncation by
// VOICE_CALL_PCM_CAPACITY. One video call end to end: the realtime front streams the reply faster than real time and
// honours output pressure per message (as ws.pause does); the real Vidu component paces it on its estimated render clock.
const RENDER_MS=2400,FRAME=480;
function videoCall(t:import('node:test').TestContext) {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const frames:{at:number;value:number}[]=[],controls:number[]=[],motions:string[]=[],errors:unknown[]=[],inFlight:number[]=[];
  const listeners=new Map<string,(...args:any[])=>void>();let output!:ReturnType<typeof createViduComponentPlayout>,sent=0;
  const socket={readyState:1,bufferedAmount:0,on:(event:string,fn:(...args:any[])=>void)=>{listeners.set(event,fn);return socket;},off:()=>socket,ping:()=>{},
    send:(packet:string|Buffer)=>{
      if(typeof packet==='string'){const {type,payload}=JSON.parse(packet);controls.push(type);if(type===9)motions.push(payload.text_msg.content);
        if(type===1)listeners.get('message')?.(JSON.stringify({type:2,payload:{conn_init_ack:{success:true}}}));return;}
      const pcm=new Int16Array(packet.buffer,packet.byteOffset,packet.byteLength/2);frames.push({at:Date.now(),value:pcm[0]!});
      sent+=pcm.length;inFlight.push(sent-output.playedSamples!());},
    terminate:()=>socket.close(),close:()=>{socket.readyState=3;listeners.get('close')?.();}};
  // The provider: one delta per `deltaMs` of audio, generated `speed`× faster than real time. While output is paused the
  // generated deltas wait on the wire and arrive after resume, one message at a time, rechecking pressure between them.
  let emit!:(event:Record<string,unknown>)=>void,paused=false,pauses=0,wire:Record<string,unknown>[]=[],cancelled=0;
  const deliver=()=>{while(!paused&&wire.length)emit(wire.shift()!);};
  const reply=(id:string,seconds:number,deltaMs:number,speed:number)=>{
    const samples=deltaMs*24,count=Math.round(seconds*1000/deltaMs);let index=0;
    emit({type:'response.created',response:{id}});
    const produce=()=>{if(cancelled)return;
      if(index<count){wire.push({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(samples).fill(++index).buffer).toString('base64')});setTimeout(produce,deltaMs/speed);}
      else wire.push({type:'response.done',response:{id,status:'completed'}});deliver();};
    produce();return count;
  };
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},componentVideo:true,
    createPlayout:(_room,id,_reset,onError,_mode,budget)=>output=createViduComponentPlayout({id,budget,apiKey:'fixture-key',onMedia:async()=>{},onEnded:()=>{},onError,
      configuration:{provider:'vidu_component',api_key_file:'/fixture',base_url:'https://renderer.invalid',avatar_id:'avatar',component_model:'model',action_library_id:'gestures'},
      fetch:async(_url,init)=>init?.method==='POST'?Response.json({live:{id:'live'},managed_rtc:{provider:'artc',app_id:'a',channel_id:'c',user_id:'u',token:'fixture-rtc-token',token_expire_at:'2000000000'}})
        :Response.json({live:{status:'ended',billed_seconds:1,credits_cost:1}}),
      connect:()=>{setImmediate(()=>listeners.get('open')?.());return socket as never;}}),
    createFront:callbacks=>{emit=callbacks.onEvent;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},respond:async()=>({}),context:async()=>({}),close:()=>{},
      cancel:()=>{cancelled++;wire=[];},setOutputPaused:value=>{if(value&&!paused)pauses++;paused=value;if(!value)setTimeout(deliver,0);}};},
    onState:()=>{},onTranscript:()=>{},onTurn:()=>{},onError:error=>errors.push(error)});
  const run=(ms:number)=>{for(let step=0;step<ms;step+=10)t.mock.timers.tick(10);};
  return {call,frames,controls,motions,errors,inFlight,reply,run,socket,listeners,output:()=>output,
    emit:(event:Record<string,unknown>)=>emit(event),paused:()=>paused,pauses:()=>pauses};
}

for(const [seconds,deltaMs,speed] of [[12,100,4],[48,240,6],[9.6,1200,3]] as const)
  test(`a ${seconds} s video reply in ${deltaMs} ms deltas at ${speed}× real time plays whole, unbroken and bounded`,async t=>{
    const v=videoCall(t);
    try{
      await v.call.open('video',{video:true});
      const count=v.reply('answer',seconds,deltaMs,speed);v.run(seconds*1000+FIRST_AUDIO_CONFIRM_MS+RENDER_MS+500);
      assert.deepEqual(v.errors,[],'no capacity or stall interrupt');assert.ok(!v.controls.includes(7),'the renderer is never flushed');
      assert.equal(v.frames.length,seconds*24000/FRAME,'every sample reaches the renderer');
      assert.deepEqual([...new Set(v.frames.map(f=>f.value))],Array.from({length:count},(_,i)=>i+1),'in order');
      const span=v.frames.at(-1)!.at-v.frames[0]!.at;
      assert.ok(span<=seconds*1000,`the renderer feed never starves: ${seconds*1000} ms of audio took ${span} ms to send`);
      assert.ok(Math.max(...v.inFlight)<=(RENDER_MS+LEAD_MS+20)*24+FRAME,'renderer in-flight stays at its render delay plus the lead');
      assert.equal(v.paused(),false,'the front is not left paused');
      if(seconds>30)assert.ok(v.pauses()>0,'a long reply waits under the call cap instead of being cut');
    }finally{await v.call.closeAll();}
  });

test('barge-in during a long video reply flushes the renderer at once and sends nothing more',async t=>{
  const v=videoCall(t);
  try{
    await v.call.open('video',{video:true});v.reply('answer',30,100,4);v.run(3000);
    const before=v.frames.length;assert.ok(before>0);
    v.emit({type:'input_audio_buffer.speech_started'});
    assert.equal(v.controls.at(-1),7,'flush is the next renderer command');v.run(3000);
    assert.equal(v.frames.length,before,'no unsent or late reply audio follows the flush');assert.deepEqual(v.errors,[]);
  }finally{await v.call.closeAll();}
});

test('a late pump resynchronises without killing video or retiring unsent credit',async t=>{
  const v=videoCall(t);
  try{
    await v.call.open('stall',{video:true});
    v.output().push(new Int16Array(24000).fill(7));
    const before=v.frames.length;
    // Move wall time without executing timers: the host was blocked, rather than playing every overdue callback.
    t.mock.timers.setTime(Date.now()+RENDER_MS-LEAD_MS);
    t.mock.timers.tick(20);
    assert.deepEqual(v.errors,[]);assert.ok(v.frames.length>before,'sending resumes');
    assert.ok(v.frames.length-before<=1+LEAD_MS/20,'no overdue burst');
    assert.ok(v.output().playedSamples!()<=before*FRAME,'unsent samples are never retired');
    v.run(RENDER_MS+1000);
    assert.equal(v.frames.length,24000/FRAME);assert.equal(v.output().playedSamples!(),24000);
  }finally{await v.call.closeAll();}
});

for(const event of ['close','error'] as const)test(`a Vidu socket ${event} still fails the live`,async t=>{
  const v=videoCall(t);
  try{
    await v.call.open('dead',{video:true});v.output().push(new Int16Array(24000));
    if(event==='close')v.socket.close();else v.listeners.get('error')!(new Error('wire failed'));
    v.run(100);
    assert.equal((v.errors[0] as {code:string}).code,event==='close'?'VIDU_COMPONENT_CLOSED':'VIDU_COMPONENT_WS_FAILED');
  }finally{await v.call.closeAll();}
});

test('only transport backlog beyond the renderer horizon fails video',async t=>{
  const v=videoCall(t);
  try{
    await v.call.open('buffered',{video:true});
    v.socket.bufferedAmount=48*(RENDER_MS-LEAD_MS);
    v.output().push(new Int16Array(24000));assert.deepEqual(v.errors,[]);
    v.socket.bufferedAmount=48*(RENDER_MS+LEAD_MS+FRAME/24)+1;v.run(20);
    assert.match(String(v.errors[0]),/VIDU_COMPONENT_PLAYOUT_FAILED/);
  }finally{await v.call.closeAll();}
});

test('locally buffered audio receives no played credit until it reaches the renderer horizon',async t=>{
  const v=videoCall(t);
  try{
    await v.call.open('credit',{video:true});v.socket.bufferedAmount=480*2;
    v.output().push(new Int16Array(FRAME));v.run(RENDER_MS-LEAD_MS);
    assert.equal(v.output().playedSamples!(),0);
    v.socket.bufferedAmount=0;v.run(20);v.run(RENDER_MS-20);
    assert.equal(v.output().playedSamples!(),0,'render delay starts after the local queue drains');
    v.run(40);assert.equal(v.output().playedSamples!(),FRAME);
  }finally{await v.call.closeAll();}
});

test('Vidu sends idle framing and arbitrary live motion text without claiming completion',async t=>{
 const v=videoCall(t);
 try{
  await v.call.open('motion',{video:true});
  assert.match(v.motions[0]!,/头部保持画面中央/);assert.match(v.motions[0]!,/自然呼吸/);
  for(const action of ['微笑并点头','鼓掌','转一圈','跳舞','wave','heart','rest'])assert.deepEqual(v.output().action(action),{sent:true});
  assert.ok(v.motions.includes('转一圈'));assert.ok(v.motions.includes('跳舞'));
  assert.throws(()=>v.output().action('  '),/VIDU_GESTURE_UNSUPPORTED/);
  const before=v.motions.length;v.run(100);assert.equal(v.motions.length,before,'action-only completion is not guessed');
  v.output().push(new Int16Array(FRAME));
  t.mock.timers.setTime(Date.now()+RENDER_MS+20);
  assert.equal(v.output().playedSamples!(),FRAME,'position reaping can observe the drain before the pump');
  assert.equal(v.motions.length,before+1);assert.equal(v.motions.at(-1),v.motions[0],'estimated speech drain requests the initial idle pose once');
  v.output().playedSamples!();v.run(100);assert.equal(v.motions.length,before+1,'empty polls do not repeat the idle request');
  await v.call.closeAll();assert.deepEqual(v.output().action('点头'),{sent:false});assert.equal(v.motions.length,before+1);
 }finally{await v.call.closeAll();}
});


test('closing a renderer aborts its own pending acquisition before waiting for retirement',async()=>{
  const entered=Promise.withResolvers<void>(),request=Promise.withResolvers<Response>();let signal:AbortSignal|undefined;
  const output=createViduComponentPlayout({id:'cancel-create',budget:new CallPcmBudget(),apiKey:'fixture',
    configuration:{provider:'vidu_component',api_key_file:'/fixture',base_url:'https://renderer.invalid',avatar_id:'avatar',component_model:'model',action_library_id:'gestures'},
    onMedia:async()=>{},onEnded:()=>{},onError:()=>{},fetch:async(_url,init)=>{
      signal=init!.signal as AbortSignal;signal.addEventListener('abort',()=>request.reject(signal!.reason),{once:true});
      entered.resolve();return request.promise;
    }});
  const opening=assert.rejects(output.open());await entered.promise;const closing=output.close();
  try{assert.equal(signal?.aborted,true);await Promise.all([opening,closing]);}
  finally{request.reject(new Error('test cleanup'));await opening;await closing;}
});
