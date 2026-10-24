import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createVoiceCallSession} from '../src/voice-call-session.ts';
const {createFrontRealtimeSession}=await import(new URL('../../../services/qwen-embedded/server/src/voice/embedded-realtime-session.mjs',import.meta.url).href);

// ws over TLS: everything sent in one tick stays in bufferedAmount until the write completes in a later macrotask
// (measured with ws 8.21.3 on a local wss socket: 4 x 256 kB sends -> 1 024 296 buffered, 0 after the writes).
class TlsSocket extends EventEmitter{
  static OPEN=1;static sockets:TlsSocket[]=[];readyState=0;bufferedAmount=0;stallAudio=false;sent:Record<string,any>[]=[];
  constructor(){super();TlsSocket.sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.emit('open');this.incoming({type:'session.created'});});}
  incoming(event:unknown){this.emit('message',Buffer.from(JSON.stringify(event)));}
  send(wire:string,done?:(error?:Error)=>void){const event=JSON.parse(wire),bytes=Buffer.byteLength(wire);this.sent.push(event);this.bufferedAmount+=bytes;
    if(!(this.stallAudio&&event.type==='input_audio_buffer.append'))setImmediate(()=>{this.bufferedAmount-=bytes;done?.();});
    if(event.type==='session.update')queueMicrotask(()=>this.incoming({type:'session.updated'}));
    if(event.type==='conversation.item.create')queueMicrotask(()=>this.incoming({type:'conversation.item.created',item:{id:event.item?.id}}));}
  close(){if(this.readyState===3)return;this.readyState=3;setImmediate(()=>this.emit('close'));}
  terminate(){this.close();}
}
const settle=async()=>{for(let i=0;i<4;i++){for(let j=0;j<32;j++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));}};
const asset={path:'/synthetic',sha256:'0'.repeat(64)};

const OWNER=1000,OTHER=2000;
function fixture(t:test.TestContext){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});TlsSocket.sockets=[];
  const lag={verdict:undefined as PromiseWithResolvers<void>|undefined,score:undefined as PromiseWithResolvers<void>|undefined};
  const errors:unknown[]=[],states:{state:string;error_code?:string}[]=[];let resets=0,samples=0,active=false;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},onError:error=>errors.push(error),
    turns:{config:{enabled:true,model:asset,thinking_sound:{...asset,model:'test',voice:'test'}},score:async()=>{await lag.score?.promise;return 1;},thinking:new Int16Array(480)} as never,
    classifySpeech:async()=>({stop:false,guests:'unchanged' as const}),transcribeSpeech:async()=>'帮我查一下明天北京的天气然后提醒我带伞',
    identifySpeech:async window=>{if(Math.round(window[0]!*32768)===OTHER)return undefined;await lag.verdict?.promise;return true;},
    openVad:async()=>({write:async(pcm:Float32Array)=>{const before=samples;samples+=pcm.length;const speech=pcm.some(v=>v!==0),changed=speech!==active;active=speech;
      return changed?[speech?{at:samples,start:before}:{at:samples,end:before}]:[];},close:async()=>{}}),
    // Component video (Vidu) cuts at commit: any reconnect flushes it and resets the phone's playback.
    createPlayout:()=>({thinkingAtCommit:true,open:async()=>{},push:()=>{},playedSamples:()=>0,interrupt:()=>{resets++;},drain:async()=>{},close:async()=>{}}),
    createFront:c=>createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'qwen3-asr-flash-realtime',
      region:'cn-beijing',endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',
      WebSocket:TlsSocket,manualTurns:true,instructions:c.instructions,onEvent:c.onEvent,onClose:c.onClose,onError:c.onError}),
    onState:(_id,state,extra)=>{states.push({state,...extra});},onTranscript:()=>{},onTurn:()=>{}});
  const push=async(value:number,count:number)=>{for(let i=0;i<count;i++){call.pushPcm(new Int16Array(512).fill(value));await settle();}};
  // The turn's audio after the last clear on that socket, and whether a reply followed its commit.
  const delivered=(socket:TlsSocket)=>{const sent=socket.sent.map(e=>e.type),commit=sent.lastIndexOf('input_audio_buffer.commit'),clear=sent.lastIndexOf('input_audio_buffer.clear');
    return {samples:commit<0?0:socket.sent.slice(clear+1,commit).filter(e=>e.type==='input_audio_buffer.append').reduce((n,e)=>n+Buffer.from(e.audio,'base64').length/2,0),
      replied:commit>=0&&sent.indexOf('response.create',commit)>commit};};
  const answered=async()=>{for(let i=0;i<200&&!TlsSocket.sockets.at(-1)!.sent.some(e=>e.type==='response.create');i++)await settle();
    const socket=TlsSocket.sockets.at(-1)!;socket.incoming({type:'response.created',response:{id:'answer'}});socket.incoming({type:'response.done',response:{id:'answer',status:'completed'}});await settle();};
  return {call,push,lag,errors,states,resets:()=>resets,delivered,answered};
}

test('c17635e0: a long owner turn whose stream an unknown onset cleared is uploaded within the transport budget and answered',async t=>{
  const f=fixture(t);await f.call.open('c17635e0');const socket=TlsSocket.sockets.at(-1)!;
  // Utterances 1-9: ~14 s of owner speech, streamed live.
  await f.push(OWNER,437);f.lag.verdict=Promise.withResolvers();f.lag.score=Promise.withResolvers();
  await f.push(0,8);
  // Utterance 10: 192 ms, no verdict. With utterance 9's verdict still pending,
  // the unknown onset clears the streamed input.
  await f.push(OTHER,1);assert.ok(socket.sent.some(e=>e.type==='input_audio_buffer.clear'),'the unknown onset cleared the streamed input');
  f.lag.verdict.resolve();await f.push(OTHER,5);await f.push(0,8);
  // Then utterance 9 scores and commits all 14 s at once.
  f.lag.score.resolve();await f.answered();
  assert.deepEqual(f.errors,[],'the commit neither fails nor terminates the transport');
  assert.equal(TlsSocket.sockets.length,1,'no reconnect');assert.equal(f.resets(),0,'no playback flush');
  assert.deepEqual(f.delivered(socket),{samples:437*512,replied:true},'the whole turn reaches the front once and gets a reply');
  await f.call.closeAll();
});

test('a front that loses its transport during the upload or at the commit replays the turn on the reconnected front',async t=>{
  for(const loss of ['upload','commit'] as const){
    const f=fixture(t);await f.call.open(`loss-${loss}`);const first=TlsSocket.sockets.at(-1)!;
    // upload: the stream was cleared, so the 3 s turn is uploaded at commit. commit: the turn was streamed whole.
    const speech=loss==='upload'?96:24;f.lag.score=Promise.withResolvers();
    await f.push(OWNER,speech);if(loss==='upload')f.lag.verdict=Promise.withResolvers();await f.push(0,8);
    if(loss==='upload'){await f.push(OTHER,1);f.lag.verdict!.resolve();await f.push(OTHER,5);await f.push(0,8);}
    // A stalled uplink: the next frame exceeds the bounded sender's budget and it terminates the socket.
    first.bufferedAmount+=loss==='upload'?400*1024:1024*1024;
    f.lag.score.resolve();await f.answered();
    assert.deepEqual(f.errors.filter(e=>/INPUT_AUDIO/.test(String(e))),[],'no turn error');
    assert.equal(TlsSocket.sockets.length,2,'one reconnect');assert.equal(first.sent.some(e=>e.type==='response.create'),false);
    assert.deepEqual(f.delivered(TlsSocket.sockets[1]!),{samples:speech*512,replied:true},'the reconnected front gets the whole turn and replies');
    await f.call.closeAll();t.mock.timers.reset();
  }
});

test('native delivery context follows provider audio and completion back to its source turn',async()=>{
  TlsSocket.sockets=[];const events:Record<string,any>[]=[];
  const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',region:'cn-beijing',
    endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'test-call-voice',apiKey:'synthetic-offline-only',
    WebSocket:TlsSocket,instructions:'Reply briefly.',onEvent:(event:Record<string,any>)=>events.push(event)});
  try{
    await front.connect();const delivering=front.respond('已核对完。',()=>true,{source_turn:7});await settle();
    const socket=TlsSocket.sockets.at(-1)!;assert.equal(socket.sent.some(event=>event.type==='response.create'),true);
    socket.incoming({type:'response.created',response:{id:'native'}});
    socket.incoming({type:'response.audio.delta',response_id:'native',delta:Buffer.from(new Int16Array(240).buffer).toString('base64')});
    socket.incoming({type:'response.done',response:{id:'native',status:'completed',usage:{input_tokens:3,output_tokens:2}}});
    await delivering;
    for(const type of ['response.created','response.audio.delta','response.done'])assert.equal(events.find(event=>event.type===type)?.__voiceContext.source_turn,7);
  }finally{front.close();}
});

test('a sub-budget write callback stall times out, informs the owner and replays the exact whole turn once',async t=>{
  const f=fixture(t);await f.call.open('upload-drain-timeout');const first=TlsSocket.sockets.at(-1)!;
  try{
    const speech=200;f.lag.score=Promise.withResolvers();await f.push(OWNER,speech);
    f.lag.verdict=Promise.withResolvers();await f.push(0,8);await f.push(OTHER,1);
    f.lag.verdict.resolve();await f.push(OTHER,5);await f.push(0,8);
    first.stallAudio=true;f.lag.score.resolve();await settle();
    assert.ok(first.bufferedAmount>0&&first.bufferedAmount<512*1024,'one frame is stuck below the existing byte limit');
    assert.equal(first.sent.some(e=>e.type==='input_audio_buffer.commit'),false,'the rest of the owner turn still waits for that write');
    t.mock.timers.tick(12287);await settle();assert.equal(TlsSocket.sockets.length,1);
    t.mock.timers.tick(1);await settle();await f.answered();
    const failure=f.states.findIndex(s=>s.state==='connecting'&&s.error_code==='REALTIME_AUDIO_UPLOAD_TIMEOUT');assert.ok(failure>=0);
    assert.ok(f.states.slice(failure+1).some(s=>s.state==='live'),'the call reports live after the timeout and recovery');
    assert.equal(TlsSocket.sockets.length,2,'one reconnect');assert.equal(first.readyState,3);
    assert.equal(first.sent.some(e=>e.type==='input_audio_buffer.commit'||e.type==='response.create'),false,'the old front never commits or requests a reply');
    const recovered=TlsSocket.sockets[1]!;assert.deepEqual(f.delivered(recovered),{samples:speech*512,replied:true});
    const commit=recovered.sent.findIndex(e=>e.type==='input_audio_buffer.commit');
    const exact=Buffer.concat(recovered.sent.slice(0,commit).filter(e=>e.type==='input_audio_buffer.append').map(e=>Buffer.from(e.audio,'base64')));
    assert.deepEqual(exact,Buffer.from(new Int16Array(speech*512).fill(OWNER).buffer),'replay contains every original owner sample, in order');
    assert.equal(recovered.sent.filter(e=>e.type==='input_audio_buffer.commit').length,1);assert.equal(recovered.sent.filter(e=>e.type==='response.create').length,1);
    assert.equal(f.errors.filter(e=>/REALTIME_AUDIO_UPLOAD_TIMEOUT/.test(String(e))).length,1);
  }finally{await f.call.closeAll();}
});
