import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createViduLiveJournal} from '../src/vidu-live-journal.ts';
import assert from 'node:assert/strict';
import {createAvatarCallPlayout} from '../src/avatar-call-playout.ts';
import {CallPcmBudget,CALL_PCM_LIMITS,SKIP_FADE_SAMPLES,type CallPlayout} from '../src/call-playout.ts';
import {createViduComponentPlayout,LEAD_MS,RENDER_MS} from '../src/vidu-component-playout.ts';
import {VIDU_COMPONENT_RULES,VIDU_GESTURE_TOOL,VIDU_IDLE_MOTION} from '../src/vidu-call-session.ts';

function harness(ready=true,enabled=true) {
  const archived:number[]=[],logs:Record<string,unknown>[]=[],spoken:number[]=[],resets:string[]=[],sent:(string|Buffer)[]=[],tokens:unknown[]=[];
  const pressure:boolean[]=[],budget=new CallPcmBudget(paused=>pressure.push(paused));
  let opened=0,interrupted=0,probes=0,voicePlayed=0;
  const voice:CallPlayout={open:async()=>{opened++;},push:(pcm,credit)=>{for(const sample of pcm)spoken.push(sample);credit?.release(pcm.length);},playedSamples:()=>voicePlayed,interrupt:preserve=>{interrupted++;voicePlayed=0;if(!preserve)budget.reset();},drain:async()=>{},close:async()=>{}};
  const ws={bufferedAmount:0,onopen:undefined as undefined|(()=>void),onmessage:undefined as undefined|((event:{data:string})=>void),
    onerror:undefined as undefined|(()=>void),onclose:undefined as undefined|((event?:{code:number;reason:string})=>void),close:()=>{},send:(data:string|Buffer)=>sent.push(data)};
  const emit=(message:object)=>ws.onmessage?.({data:JSON.stringify(message)});
  const output=createAvatarCallPlayout({room:{},id:'call',enabled,origin:'https://avatar.test:9443',token:'worker-credential',voice,budget,onPlayed:pcm=>archived.push(...pcm),log:record=>logs.push(record),reset:sid=>resets.push(sid),onError:()=>{},
    participant:{snapshot:()=>({connected:true,transportState:'connected',roomName:'call-room',projectUrl:'wss://ai.example.invalid'}),
      withEncryptionKey:async(use:(key:Uint8Array)=>Promise<unknown>)=>use(new Uint8Array(32))} as never,
    signer:{sign:async(input:unknown)=>{tokens.push(input);return 'participant-jwt';}} as never,
    fetch:async url=>{assert.equal(url,'https://avatar.test:9443/health');probes++;return {ok:true,json:async()=>({ready})} as never;},
    socket:url=>{assert.equal(url,'wss://avatar.test:9443/call');setImmediate(()=>{ws.onopen?.();emit({type:'ready',sid:'avatar-audio'});});return ws as unknown as WebSocket;}});
  return {output,voice,budget,ws,emit,logs,spoken,archived,resets,sent,tokens,pressure,opened:()=>opened,interrupted:()=>interrupted,probes:()=>probes,playVoice:(samples:number)=>{voicePlayed+=samples;}};
}

function componentHarness(createGate?:Promise<void>,connecting=false,mediaGate?:Promise<void>,ack=true,journal?:ReturnType<typeof createViduLiveJournal>) {
  const mediaEntered=Promise.withResolvers<void>();
  const retired:number[]=[],packets:(string|Buffer)[]=[],creates:any[]=[],media:unknown[]=[],errors:unknown[]=[],pressure:boolean[]=[],billingStatuses:string[]=[];let billingQueries=0;
  const budget=new CallPcmBudget(paused=>pressure.push(paused)),listeners=new Map<string,(...args:any[])=>void>();
  const socket={readyState:connecting?0:1,bufferedAmount:0,on:(event:string,fn:(...args:any[])=>void)=>{listeners.set(event,fn);return socket;},off:()=>socket,
    send:(packet:string|Buffer)=>{packets.push(Buffer.isBuffer(packet)?Buffer.from(packet):packet);if(typeof packet==='string'&&JSON.parse(packet).type===1&&ack)
      listeners.get('message')?.(JSON.stringify({type:2,payload:{conn_init_ack:{success:true}}}));},ping:()=>{},terminate:()=>{socket.readyState=3;listeners.get('close')?.();},close:()=>{socket.readyState=3;listeners.get('close')?.();}};
  const output=createViduComponentPlayout({id:'component',budget,...(journal?{journal}:{}),apiKey:'fixture-key',configuration:{provider:'vidu_component',api_key_file:'/fixture',
    base_url:'https://renderer.invalid',avatar_id:'operator-avatar',component_model:'render-model',action_library_id:'gesture-library'},
    onMedia:async rtc=>{media.push(rtc);mediaEntered.resolve();await mediaGate;},onEnded:()=>{},onError:error=>errors.push(error),onRetired:pcm=>retired.push(...pcm),
    fetch:async(_url,init)=>{if(init?.method==='POST'){creates.push(JSON.parse(String(init.body)));await createGate;return Response.json({live:{id:'render-live'},managed_rtc:{provider:'artc',app_id:'a',channel_id:'c',user_id:'u',token:'fixture-rtc-token',token_expire_at:'2000000000'}});}
      billingQueries++;return Response.json({live:{status:billingStatuses.shift()??'ended',billed_seconds:1,credits_cost:1}});},connect:(url,headers)=>{assert.match(url,/^wss:\/\/renderer.invalid\/live\/v1\/external-lives\/render-live\/stream\?conn_id=/);
      assert.equal(headers.Authorization,'Token fixture-key');if(!connecting)setImmediate(()=>listeners.get('open')?.());return socket;}});
  return {output,retired,packets,creates,media,mediaEntered:mediaEntered.promise,errors,pressure,socket,budget,billingStatuses,billingQueries:()=>billingQueries,opened:()=>{socket.readyState=1;listeners.get('open')?.();}};
}

test('component routes first PCM and gestures to Vidu only; interrupt flushes buffered and late local PCM',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  assert.deepEqual(h.creates,[{model:'render-model',avatar_id:'operator-avatar',managed_rtc:{provider:'artc'},action:{enabled:true,library_id:'gesture-library'}}]);
  assert.equal((h.media[0] as any).audio_input,'gateway');
  h.output.push(new Int16Array(60000).fill(7));assert.deepEqual(h.pressure,[],'2.5 s of reply is far below the call cap');
  const lead=LEAD_MS/20+1;assert.equal(h.packets.filter(Buffer.isBuffer).length,lead,'the first LEAD_MS of reply leaves before a pacing timer');
  const first=h.packets.find(Buffer.isBuffer) as Buffer;assert.equal(first.length,960);assert.ok(new Int16Array(first.buffer,first.byteOffset,480).every(v=>v===7));
  const drain=h.output.drain();h.output.interrupt();await drain;t.mock.timers.tick(3000);
  assert.equal(h.packets.filter(Buffer.isBuffer).length,lead,'cancelled PCM is never replayed');
  assert.equal(JSON.parse(h.packets.filter(p=>typeof p==='string').at(-1) as string).type,7);
  h.output.push(new Int16Array(480).fill(9));assert.equal(h.packets.filter(Buffer.isBuffer).length,lead+1);
  const flushes=h.packets.filter(p=>typeof p==='string'&&JSON.parse(p).type===7).length;t.mock.timers.tick(5000);
  h.output.push(new Int16Array(480).fill(11));assert.equal(h.packets.filter(Buffer.isBuffer).length,lead+2,'speech after an idle thinking gap still streams');
  assert.equal(h.packets.filter(p=>typeof p==='string'&&JSON.parse(p).type===7).length,flushes);
  for(const action of ['wave','heart','rest','dance'])assert.deepEqual(h.output.action(action),{sent:true});
  assert.throws(()=>h.output.action('  '),/VIDU_GESTURE_UNSUPPORTED/);
  assert.deepEqual(h.packets.filter(p=>typeof p==='string').map(p=>JSON.parse(p as string)).filter(p=>p.type===9).map(p=>p.payload.text_msg.content),
    [VIDU_IDLE_MOTION,VIDU_IDLE_MOTION,'向镜头挥手','对镜头比心',VIDU_IDLE_MOTION,'dance']);
  await h.output.close();assert.deepEqual(h.errors,[]);assert.deepEqual(h.output.action('dance'),{sent:false});
  assert.equal(VIDU_GESTURE_TOOL.parameters.properties.action.type,'string');assert.equal('enum' in VIDU_GESTURE_TOOL.parameters.properties.action,false);
  assert.match(VIDU_COMPONENT_RULES,/没有动作完成回执/);assert.match(VIDU_COMPONENT_RULES,/不能另生成视频代替/);
  assert.match(VIDU_COMPONENT_RULES,/先调用工具再说话/);assert.match(VIDU_COMPONENT_RULES,/工具没有确认发出就说明现在做不了/);
});

test('component fails transport backlog beyond its render horizon and preserves unheard reply credit',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  h.output.push(new Int16Array(960));t.mock.timers.tick(311);
  assert.equal(h.packets.filter(Buffer.isBuffer).length,2,'the measured native-speech pause does not cut the reply');assert.deepEqual(h.errors,[]);
  h.socket.bufferedAmount=48*(RENDER_MS+LEAD_MS+480/24)+1;const frames=h.packets.filter(Buffer.isBuffer).length;
  h.output.push(new Int16Array(24000));assert.equal(h.packets.filter(Buffer.isBuffer).length,frames);
  assert.equal(h.output.takeUnplayed().reduce((n,item)=>{item.credit.release(item.pcm.length,false);return n+item.pcm.length;},0),24960);assert.match(String(h.errors[0]),/VIDU_COMPONENT_PLAYOUT_FAILED/);await h.output.close();
});

test('reply audio leaves LEAD_MS ahead, so an event-loop stall shorter than that never starves the renderer',async t=>{
  // At 2 CPUs a video call was CFS-throttled several times a second; every gateway thread, this pacing timer
  // included, stalled for tens of ms. Zero lead turned each stall into a hole in what Vidu renders.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  const ahead=()=>h.packets.filter(Buffer.isBuffer).length*20-(Date.now()-1000000);
  try{
    h.output.push(new Int16Array(24000*3));for(let step=0;step<50;step++)t.mock.timers.tick(20);
    assert.ok(ahead()>=LEAD_MS,`steady feed runs ${ahead()} ms ahead of the schedule`);
    t.mock.timers.setTime(Date.now()+LEAD_MS-20);
    assert.ok(ahead()>=0,`after a ${LEAD_MS-20} ms stall the renderer still holds ${ahead()} ms`);
    t.mock.timers.tick(0);assert.ok(ahead()>=LEAD_MS,'the first timer after the stall restores the lead');assert.deepEqual(h.errors,[]);
  }finally{await h.output.close();}
});

test('component cancellation owns creation or WS connect until late acquired billing is verified',async()=>{
  for(const point of ['create','connect']){
    const gate=Promise.withResolvers<void>(),h=componentHarness(gate.promise,true);
    const opening=h.output.open();const rejected=assert.rejects(opening,/VOICE_CALL_SUPERSEDED/);
    if(point==='connect'){gate.resolve();await new Promise(setImmediate);assert.equal(h.media.length,0);}
    const closing=h.output.close();gate.resolve();await new Promise(setImmediate);h.opened();await rejected;await closing;await new Promise(setImmediate);
    h.output.push(new Int16Array(480));
    assert.deepEqual(h.packets.filter(p=>typeof p==='string').map(p=>JSON.parse(p as string).type),[1,7,5],'late control connect initializes then hangs up without starting playback');
    assert.equal(h.packets.filter(Buffer.isBuffer).length,0);assert.equal(h.media.length,0);assert.deepEqual(h.errors,[]);
  }
});

test('component inferred playhead transfers unheard PCM with original credit and resets on interruption',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  const pcm=Int16Array.from({length:1440},(_,i)=>i);h.output.push(pcm);
  t.mock.timers.tick(25);t.mock.timers.tick(15);
  assert.equal(h.packets.filter(Buffer.isBuffer).length,3,'late frame retains cumulative 40 ms deadline');
  assert.equal(h.output.playedSamples!(),0,'sent PCM is not a playback receipt');
  t.mock.timers.tick(2370);assert.equal(h.output.playedSamples!(),240);
  const tail=h.output.takeUnplayed();assert.deepEqual(tail.flatMap(item=>[...item.pcm]),[...pcm.slice(240)]);
  assert.equal(h.output.playedSamples!(),240,'tail transfer preserves the route offset');assert.deepEqual(h.retired,[...pcm.slice(0,240)],'only newly estimated slices archive; transferred tail belongs to its consuming route');
  const held=h.budget.reserve(CALL_PCM_LIMITS.max_samples-1200);assert.throws(()=>h.budget.reserve(1),/VOICE_CALL_PCM_CAPACITY/);
  for(const item of tail)item.credit.release(item.pcm.length);held.release(CALL_PCM_LIMITS.max_samples-1200);
  h.output.interrupt();assert.equal(h.output.playedSamples!(),0);await h.output.close();
});

test('component skip ends a started thinking clip with a 40 ms fade and returns its credit; an unsent clip is dropped whole',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  const audio=()=>h.packets.filter(Buffer.isBuffer).flatMap(b=>[...new Int16Array(b.buffer,b.byteOffset,b.byteLength/2)]);
  try{
    assert.equal(h.output.skip!(),0,'nothing to skip');
    h.output.push(new Int16Array(4800).fill(1000),undefined,true);t.mock.timers.tick(20);t.mock.timers.tick(20);
    assert.equal(audio().length,1440);assert.equal(h.output.skip!(),4800-1440-SKIP_FADE_SAMPLES);assert.equal(h.output.skip!(),0,'skipped once');
    h.output.push(new Int16Array(480).fill(7));t.mock.timers.tick(200);
    const sent=audio(),fade=sent.slice(1440,1440+SKIP_FADE_SAMPLES);
    assert.equal(sent.length,1440+SKIP_FADE_SAMPLES+480);assert.ok(fade[0]===1000&&fade.at(-1)!<=2&&fade.every((v,i)=>!i||v<=fade[i-1]!),'linear fade');
    assert.deepEqual(sent.slice(-480),new Array(480).fill(7),'her reply follows the faded hum');
    h.output.push(new Int16Array(4800).fill(5));h.output.push(new Int16Array(2400).fill(9),undefined,true);
    assert.equal(h.output.skip!(),2400,'a clip still queued behind other audio is dropped whole');h.output.push(new Int16Array(480).fill(7));t.mock.timers.tick(400);
    assert.equal(audio().length,sent.length+4800+480,'no sample of the dropped clip is sent');
    assert.deepEqual(audio().slice(-5280),[...new Array(4800).fill(5),...new Array(480).fill(7)]);
    t.mock.timers.tick(3000);h.output.playedSamples!();const all=h.budget.reserve(CALL_PCM_LIMITS.max_samples);all.release(CALL_PCM_LIMITS.max_samples);
  }finally{await h.output.close();}
});

test('component pressure follows the call cap; renderer in-flight stays at its render delay and drains without ACK',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  const sent=()=>h.packets.filter(Buffer.isBuffer).reduce((n,p)=>n+(p as Buffer).length/2,0);
  h.output.push(new Int16Array(CALL_PCM_LIMITS.pause_samples));assert.deepEqual(h.pressure,[true],'what waits is bounded by the call cap');
  for(let frame=0;frame<400;frame++){t.mock.timers.tick(20);assert.ok(sent()-h.output.playedSamples!()<=(RENDER_MS+LEAD_MS)*24+960,'paced to real time');}
  assert.deepEqual(h.pressure,[true]);
  for(let frame=0;frame<(16000-8000+RENDER_MS)/20;frame++)t.mock.timers.tick(20);
  assert.deepEqual(h.pressure,[true,false],'estimated playback releases pressure without ACK');await h.output.close();
});

test('component failed control sends cannot prevent socket and terminal billing cleanup',async()=>{
  for(const type of [1,7,9,5]){
    const h=componentHarness(),send=h.socket.send;let closed=0,armed=type!==9;
    h.socket.send=packet=>{if(armed&&typeof packet==='string'&&JSON.parse(packet).type===type)throw new Error(`send-${type}`);send(packet);};
    const close=h.socket.close;h.socket.close=()=>{closed++;close();};
    if(type===1)await assert.rejects(h.output.open(),/VIDU_COMPONENT_CONTROL_FAILED/);else await h.output.open();
    armed=true;if(type===9)assert.deepEqual(h.output.action('wave'),{sent:false});if(type===7)h.output.interrupt();
    if(type===7||type===5)await assert.rejects(h.output.close(),/VIDU_COMPONENT_CLEANUP_FAILED/);else await h.output.close();
    assert.equal(closed,1);assert.equal(h.billingQueries(),1);assert.ok(h.errors.length);
  }
});

test('component send failure preserves sent and unsent tail for phone fallback',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  // The lead sends LEAD_MS/20+1 frames at once; the next one goes out on the first timer and fails there.
  const samples=480*(LEAD_MS/20+2);h.output.push(new Int16Array(samples).fill(4));const send=h.socket.send;
  h.socket.send=packet=>{if(Buffer.isBuffer(packet))throw new Error('binary-send');send(packet);};t.mock.timers.tick(20);
  assert.match(String(h.errors[0]),/VIDU_COMPONENT_PLAYOUT_FAILED/);
  const tail=h.output.takeUnplayed();assert.deepEqual(tail.flatMap(item=>[...item.pcm]),Array(samples).fill(4));
  for(const item of tail)item.credit.release(item.pcm.length);await h.output.close();
});

test('component ping and close exceptions surface while billing still reaches terminal',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1000000});const h=componentHarness();await h.output.open();
  h.socket.ping=()=>{throw new Error('ping');};t.mock.timers.tick(5000);
  assert.match(String(h.errors[0]),/VIDU_COMPONENT_CONTROL_FAILED/);
  h.socket.close=()=>{throw new Error('close');};await assert.rejects(h.output.close(),/VIDU_COMPONENT_CLEANUP_FAILED/);
  assert.equal(h.socket.readyState,3);assert.equal(h.billingQueries(),1);
  const errors=h.errors.length;t.mock.timers.tick(10000);assert.equal(h.errors.length,errors,'heartbeat was cleared');
});

test('component force-terminates missing close and polls until terminal billing',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  let terminated=0;h.socket.close=()=>{};h.socket.terminate=()=>{terminated++;};h.billingStatuses.push('on_live','ending','ended');
  const closing=h.output.close();t.mock.timers.tick(500);
  for(let n=0;n<30;n++){await Promise.resolve();t.mock.timers.tick(250);}
  await closing;assert.equal(terminated,1);assert.equal(h.billingQueries(),3);assert.deepEqual(h.errors,[]);
});

test('component late POST cancellation owns CONNECTING termination through provider grace',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const gate=Promise.withResolvers<void>(),h=componentHarness(gate.promise,true);
  h.billingStatuses.push(...Array(15).fill('ending'),'ended');const opening=assert.rejects(h.output.open(),/VOICE_CALL_SUPERSEDED/);
  const closing=h.output.close();gate.resolve();
  for(let n=0;n<160;n++){await new Promise(setImmediate);t.mock.timers.tick(1000);}
  await opening;await closing;assert.equal(h.socket.readyState,3);assert.equal(h.billingQueries(),16);assert.deepEqual(h.errors,[]);
});

test('component nonterminal billing explicitly fails cleanup',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const h=componentHarness();await h.output.open();
  h.billingStatuses.push(...Array(21).fill('ending'));const closing=assert.rejects(h.output.close(),/VIDU_COMPONENT_CLEANUP_FAILED/);
  for(let n=0;n<180;n++){await Promise.resolve();t.mock.timers.tick(1000);}await closing;
  assert.equal(h.billingQueries(),21);assert.ok(h.errors.some(error=>String(error).includes('VIDU_BILLING_TERMINAL_UNVERIFIED')));
});

test('component blocked POST close returns promptly and late ID is still closed and verified',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const gate=Promise.withResolvers<void>(),h=componentHarness(gate.promise);
  const opening=assert.rejects(h.output.open(),/VOICE_CALL_SUPERSEDED/);const closing=assert.rejects(h.output.close(),/VIDU_COMPONENT_CLEANUP_FAILED/);
  t.mock.timers.tick(10000);await closing;await opening;
  assert.equal(h.billingQueries(),0);gate.resolve();await new Promise(setImmediate);
  assert.equal(h.socket.readyState,3);assert.equal(h.billingQueries(),1);assert.equal(h.media.length,0);
});

for(const point of ['POST','connect','init','media'] as const)test(`component bounds stalled ${point} without ending logical call`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const gate=Promise.withResolvers<void>();
  const h=componentHarness(point==='POST'?gate.promise:undefined,point==='connect',point==='media'?gate.promise:undefined,point!=='init');
  const timeout=point==='POST'?'CREATE':point==='media'?'MEDIA':'INIT';
  const opening=assert.rejects(h.output.open(),new RegExp(`VIDU_COMPONENT_${timeout}_TIMEOUT`));
  if(point==='media')await h.mediaEntered;else await new Promise(setImmediate);
  t.mock.timers.tick(10000);await opening;
  const closing=point==='POST'?assert.rejects(h.output.close(),/VIDU_COMPONENT_CLEANUP_FAILED/):h.output.close();t.mock.timers.tick(point==='POST'?10000:500);await closing;
  if(point==='POST'){gate.resolve();await new Promise(setImmediate);}
  assert.equal(h.socket.readyState,3);assert.equal(h.billingQueries(),1);
  gate.resolve();await new Promise(setImmediate);
});

test('component blocked media announcement cannot hold socket teardown',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});const gate=Promise.withResolvers<void>(),h=componentHarness(undefined,false,gate.promise);
  const opening=assert.rejects(h.output.open(),/VOICE_CALL_SUPERSEDED/);await h.mediaEntered;assert.equal(h.media.length,1);
  await h.output.close();await opening;assert.equal(h.socket.readyState,3);assert.equal(h.billingQueries(),1);gate.resolve();
});

test('component restart journal reaps persisted ownership only after terminal billing',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'vidu-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'sessions.json');
  createViduLiveJournal(path).remember('https://renderer.invalid','render-live');
  const journal=createViduLiveJournal(path),h=componentHarness();await h.output.open();let queries=0;
  await journal.reconcile({apiKey:'fixture-key',connect:()=>h.socket as never,fetch:async()=>{queries++;return Response.json({live:{status:'ended',billed_seconds:15.4,credits_cost:2.1}});}});
  assert.equal(queries,1);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),[]);await h.output.close();
});

test('component restart keeps journal entry when terminal billing lacks finite totals',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const dir=mkdtempSync(join(tmpdir(),'vidu-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'sessions.json');
  const journal=createViduLiveJournal(path);journal.remember('https://renderer.invalid','render-live');
  const cleanup=assert.rejects(journal.reconcile({apiKey:'fixture-key',connect:()=>({readyState:3}) as never,
    fetch:async()=>Response.json({live:{status:'ended',billed_seconds:null,credits_cost:0}})}),/VIDU_RESTART_CLEANUP_FAILED/);
  for(let n=0;n<180;n++){await Promise.resolve();t.mock.timers.tick(1000);}await cleanup;
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),[{baseUrl:'https://renderer.invalid',id:'render-live'}]);
});

test('avatar token is room-bound, short-lived, publish-only; raw audio stays out of the room',async()=>{
  const h=harness();await h.output.open();
  assert.deepEqual(h.tokens,[{room:'call-room',identity:'yimi-avatar',ttlSeconds:60,
    grants:{room:'call-room',roomJoin:true,canPublish:true,canSubscribe:false,canPublishData:false,canPublishSources:['microphone','camera']}}]);
  assert.equal(JSON.parse(h.sent[0] as string).token,'participant-jwt');
  assert.equal(JSON.parse(h.sent[0] as string).authorization,'Bearer worker-credential');
  assert.equal(JSON.parse(h.sent[0] as string).url,'wss://ai.example.invalid');
  h.output.push(new Int16Array([1,2,3]));
  assert.deepEqual(h.spoken,[]);assert.equal(h.opened(),0);
  const packet=h.sent[1] as Buffer;assert.equal(packet.readUInt32LE(),0);assert.deepEqual([...new Int16Array(packet.buffer,packet.byteOffset+4,3)],[1,2,3]);
  await h.output.close();
});

test('unavailable avatar renderer opens the existing voice playout without minting a token',async()=>{
  const h=harness(false);await h.output.open();h.output.push(new Int16Array([7,8]));
  assert.equal(h.opened(),1);assert.deepEqual(h.tokens,[]);assert.deepEqual(h.spoken,[7,8]);await h.output.close();
});

test('worker drop retires its SID and replays only unacknowledged audio',async()=>{
  const h=harness();await h.output.open();h.output.push(new Int16Array([1,2,3,4]));
  h.emit({type:'played',epoch:0,samples:2});assert.deepEqual(h.archived,[1,2],'only worker acknowledged samples reach raw reply archive');h.ws.onclose?.();h.output.push(new Int16Array([5]));
  assert.deepEqual(h.spoken,[3,4,5]);assert.deepEqual(h.resets,['avatar-audio']);await h.output.close();
});

test('barge-in drops pending audio and stale acknowledgements, and resets the worker epoch',async()=>{
  const h=harness();await h.output.open();h.output.push(new Int16Array([1,2]));h.output.interrupt();
  assert.deepEqual(JSON.parse(h.sent[2] as string),{type:'interrupt',epoch:1});
  h.emit({type:'played',epoch:0,samples:2});assert.deepEqual(h.archived,[],'stale acknowledgements archive no retired audio');h.emit({type:'reset',epoch:1,sid:'replacement'});
  h.output.push(new Int16Array([3,4]));assert.equal((h.sent[3] as Buffer).readUInt32LE(),1);
  h.ws.onclose?.();assert.deepEqual(h.spoken,[3,4]);assert.ok(h.resets.includes('replacement'));await h.output.close();
});

test('a thinking cut preserves held reply admission and releases only unplayed avatar PCM',async()=>{
  const h=harness();await h.output.open();const held=h.budget.reserve(CALL_PCM_LIMITS.max_samples-24000);
  h.output.push(new Int16Array(24000));h.output.interrupt(true);
  const next=h.budget.reserve(24000);assert.throws(()=>h.budget.reserve(1),/VOICE_CALL_PCM_CAPACITY/);
  held.release(CALL_PCM_LIMITS.max_samples-24000);next.release(24000);await h.output.close();
});

test('drain waits for synchronized worker playback and completes when the worker drops',async()=>{
  const h=harness();await h.output.open();let drained=false;
  h.output.push(new Int16Array([1]));const drain=h.output.drain().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);
  h.emit({type:'played',epoch:0,samples:1});h.emit({type:'drained',epoch:0});await drain;
  const dropped=h.output.drain();h.ws.onclose?.();await dropped;await h.output.close();
});

test('late worker events cannot revive a closed playout',async()=>{
  const h=harness();await h.output.open();await h.output.close();h.emit({type:'ready',sid:'late'});h.output.push(new Int16Array([1]));
  assert.deepEqual(h.spoken,[]);
});

test('late audio-track reset from an interrupted epoch retires that SID',async()=>{
  const h=harness();await h.output.open();h.output.interrupt();h.output.interrupt();
  h.emit({type:'reset',epoch:1,sid:'stale'});h.emit({type:'reset',epoch:2,sid:'current'});h.ws.onclose?.();
  assert.ok(h.resets.includes('stale'));assert.ok(h.resets.includes('current'));await h.output.close();
});

test('voice calls never probe the avatar renderer; voice-video-voice-video switches use the current publisher',async()=>{
  const h=harness(true,false);await h.output.open();h.output.push(new Int16Array([1]));
  assert.equal(h.probes(),0);assert.deepEqual(h.tokens,[]);assert.deepEqual(h.spoken,[1]);
  h.output.setVideo(true);await h.output.open();h.output.push(new Int16Array([2,3]));
  h.emit({type:'played',epoch:0,samples:1});h.output.setVideo(false);h.output.push(new Int16Array([4]));
  assert.deepEqual(h.spoken,[1,3,4]);assert.ok(h.resets.includes('avatar-audio'));
  h.output.setVideo(true);await h.output.open();h.output.push(new Int16Array([5]));
  assert.equal(h.probes(),2);assert.deepEqual(h.spoken,[1,3,4]);await h.output.close();
});

test('video attachment waits for raw voice already queued, then changes publisher',async()=>{
  const h=harness(true,false);await h.output.open();
  let finish!:()=>void,started!:()=>void;const draining=new Promise<void>(resolve=>{started=resolve;});
  h.voice.drain=()=>new Promise<void>(resolve=>{finish=resolve;started();});
  h.output.setVideo(true);const opened=h.output.open();await draining;
  h.output.push(new Int16Array([1]));assert.deepEqual(h.spoken,[1]);
  finish();await opened;h.output.push(new Int16Array([2]));assert.deepEqual(h.spoken,[1]);await h.output.close();
});

test('switching back to voice during attachment cannot revive avatar routing',async()=>{
  const h=harness(true,false);await h.output.open();
  let finish!:()=>void,started!:()=>void;const draining=new Promise<void>(resolve=>{started=resolve;});
  h.voice.drain=()=>new Promise<void>(resolve=>{finish=resolve;started();});
  h.output.setVideo(true);const opened=h.output.open();await draining;
  h.output.setVideo(false);finish();await opened;h.emit({type:'ready',sid:'stale'});
  h.output.push(new Int16Array([1]));assert.deepEqual(h.spoken,[1]);await h.output.close();
});


test('an eighteen-second burst applies pressure and stays on avatar until cumulative played ACK drains it',async()=>{
  const h=harness();await h.output.open();h.ws.bufferedAmount=24000*2*18;
  for(let n=0;n<18;n++)h.output.push(new Int16Array(24000).fill(n));
  assert.equal(h.sent.filter(Buffer.isBuffer).length,18);assert.deepEqual(h.spoken,[]);assert.deepEqual(h.pressure,[true]);
  assert.equal(h.logs.some(record=>record.avatar_call_stage==='fallback'),false);
  const drain=h.output.drain();h.emit({type:'played',epoch:0,samples:24000*10});assert.deepEqual(h.pressure,[true,false]);
  h.emit({type:'played',epoch:0,samples:24000*18});
  h.emit({type:'drained',epoch:0});await drain;h.ws.onclose?.();assert.deepEqual(h.spoken,[]);
  await h.output.close();
});

test('heartbeats cannot conceal stalled PCM or a drained-ACK stall; fallback replays only unacknowledged samples',async t=>{
  const h=harness();await h.output.open();t.mock.timers.enable({apis:['setTimeout']});
  h.output.push(new Int16Array([1,2,3]));h.emit({type:'played',epoch:0,samples:1});
  t.mock.timers.tick(CALL_PCM_LIMITS.no_progress_ms-1);h.emit({type:'heartbeat'});assert.deepEqual(h.spoken,[]);
  t.mock.timers.tick(1);assert.deepEqual(h.spoken,[2,3]);assert.ok(h.resets.includes('avatar-audio'));
  await h.output.open();h.output.push(new Int16Array([4]));h.emit({type:'played',epoch:0,samples:1});
  const drained=h.output.drain();t.mock.timers.tick(CALL_PCM_LIMITS.no_progress_ms);await drained;
  assert.deepEqual(h.spoken,[2,3]);assert.equal(h.logs.filter(record=>record.reason==='playout_stalled').length,2);await h.output.close();
});

test('a later reply reattaches after worker failure and logs only public transition fields',async()=>{
  const h=harness();await h.output.open();h.output.push(new Int16Array([1,2,3]));
  h.emit({type:'played',epoch:0,samples:2});h.ws.onclose?.({code:1011,reason:'avatar_task_failed'});
  assert.deepEqual(h.spoken,[3]);await h.output.open();h.output.push(new Int16Array([4]));
  assert.equal(h.probes(),2);assert.deepEqual(h.spoken,[3]);
  h.output.setVideo(false);h.output.setVideo(true);await h.output.open();
  assert.deepEqual(h.logs.filter(record=>record.avatar_call_stage==='fallback').map(({reason,code})=>({reason,code})),
    [{reason:'worker_task_failed',code:1011},{reason:'video_off',code:undefined}]);
  assert.deepEqual(h.logs.filter(record=>record.avatar_call_stage==='video').map(record=>record.enabled),[false,true]);
  assert.equal(h.logs.filter(record=>record.avatar_call_stage==='ready').length,3);
  assert.ok(h.logs.every(record=>Object.keys(record).every(key=>['avatar_call_stage','call','epoch','at','reason','code','enabled'].includes(key))));
  await h.output.close();
});


test('played position follows worker ACKs and voice fallback without counting queued samples twice',async()=>{
  const h=harness(true,false);await h.output.open();h.output.push(new Int16Array(4));h.playVoice(4);
  assert.equal(h.output.playedSamples!(),4);
  h.output.setVideo(true);await h.output.open();h.output.push(new Int16Array(6));
  assert.equal(h.output.playedSamples!(),4,'worker admission is not playback');
  h.emit({type:'played',epoch:0,samples:2});assert.equal(h.output.playedSamples!(),6);
  h.ws.onclose?.();assert.equal(h.output.playedSamples!(),6,'fallback keeps acknowledged position');
  h.playVoice(4);assert.equal(h.output.playedSamples!(),10,'only unacknowledged PCM is replayed');
  await h.output.open();assert.equal(h.output.playedSamples!(),10,'reattachment retains voice progress');
  h.output.push(new Int16Array(3));h.output.interrupt();
  h.emit({type:'played',epoch:0,samples:3});assert.equal(h.output.playedSamples!(),0,'interrupt resets position and ignores stale ACK');
  await h.output.close();
});


test('retained terminal failure retries after pace under same owner and excludes active IDs',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const dir=mkdtempSync(join(tmpdir(),'vidu-retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'sessions.json');
  const journal=createViduLiveJournal(path);t.after(()=>journal.stop());journal.remember('https://renderer.invalid','retained-id');
  let terminal=false,queries=0;const ids:string[]=[];
  const options={apiKey:'fixture-key',connect:()=>({readyState:3}) as never,fetch:async(url:unknown)=>{
    queries++;ids.push(String(url));return Response.json({live:{status:terminal?'ended':'active',billed_seconds:1,credits_cost:0}});}};
  const first=assert.rejects(journal.retire({...options,baseUrl:'https://renderer.invalid',id:'retained-id'}),/VIDU_COMPONENT_CLEANUP_FAILED/);
  for(let n=0;n<21;n++){await new Promise(setImmediate);if(n<20)t.mock.timers.tick(1000);}await first;
  assert.equal(queries,21);assert.equal(journal.size,1);journal.remember('https://renderer.invalid','active-id');
  terminal=true;t.mock.timers.tick(29999);await new Promise(setImmediate);assert.equal(queries,21);
  t.mock.timers.tick(1);await new Promise(setImmediate);assert.equal(queries,22);
  assert.ok(ids.every(url=>url.endsWith('/retained-id')));
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),[{baseUrl:'https://renderer.invalid',id:'active-id'}]);
  t.mock.timers.tick(30000);await new Promise(setImmediate);assert.equal(queries,22);
});


test('failed component close remains journal-owned with one retirement and paced later release',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const dir=mkdtempSync(join(tmpdir(),'vidu-close-retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const journal=createViduLiveJournal(join(dir,'sessions.json'));t.after(()=>journal.stop());let retried=0;
  await journal.reconcile({apiKey:'fixture-key',connect:()=>({readyState:3}) as never,
    fetch:async()=>{retried++;return Response.json({live:{status:'ended',billed_seconds:2,credits_cost:0}});}});
  const h=componentHarness(undefined,false,undefined,true,journal);await h.output.open();h.billingStatuses.push(...Array(21).fill('active'));
  const closing=assert.rejects(h.output.close(),/VIDU_COMPONENT_CLEANUP_FAILED/);
  const duplicate=assert.rejects(journal.retire({apiKey:'fixture-key',baseUrl:'https://renderer.invalid',id:'render-live',
    fetch:async()=>{throw new Error('DUPLICATE_RETIREMENT');}}),/VIDU_COMPONENT_CLEANUP_FAILED/);
  for(let n=0;n<21;n++){await new Promise(setImmediate);if(n<20)t.mock.timers.tick(1000);}await closing;await duplicate;
  assert.equal(h.billingQueries(),21);assert.equal(journal.size,1);assert.equal(retried,0);
  assert.equal(h.packets.filter(p=>typeof p==='string'&&JSON.parse(p).type===5).length,1);
  t.mock.timers.tick(29999);await new Promise(setImmediate);assert.equal(retried,0);
  t.mock.timers.tick(1);await new Promise(setImmediate);assert.equal(retried,1);assert.equal(journal.size,0);
});
