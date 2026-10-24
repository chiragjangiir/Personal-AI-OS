import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionCentralResources} from '../src/main.ts';
import type {CentralProvisionConfiguration} from '../src/main.ts';
test('owner override TTL config rejects invalid shapes before opening resources',async()=>{
 for(const identity of [null,[],false,{unknown:true},{owner_override_ttl_s:-1},{owner_override_ttl_s:1.5},{owner_override_ttl_s:'86400'}])
  await assert.rejects(provisionCentralResources({identity} as unknown as CentralProvisionConfiguration),/OWNER_OVERRIDE_CONFIGURATION_INVALID/);
});
test('formal voice config rejects invalid source shapes before reading keys or opening resources',async()=>{
 for(const formal_voice of [null,[],false,1,'voice',{}, {transport:'unknown'}, {transport:'wav_byte_stream_v1',forged:true}, {device_id:'phone',transport:'wav_byte_stream_v1'}]) {
  await assert.rejects(provisionCentralResources({port:19091,tts:{provider:'dashscope'},formal_voice} as unknown as CentralProvisionConfiguration),/FORMAL_VOICE_CONFIGURATION_INVALID/);
 }
});
test('reply TTS config names its model, voice and rate; the optional tone instruction is nonempty text',async()=>{
 const valid={provider:'dashscope',model:'qwen-audio-3.0-tts-plus',voice:'longanlingxin',sample_rate:22050};
 for(const tts of [{provider:'dashscope'},{...valid,model:undefined},{...valid,voice:''},{...valid,sample_rate:0},{...valid,instruction:''},{...valid,instruction:' '},
  {...valid,instruction:'语'.repeat(501)},{...valid,instruction:7},{...valid,extra:true}])
  await assert.rejects(provisionCentralResources({port:19091,tts} as unknown as CentralProvisionConfiguration),/TTS_PROVIDER_NOT_CONFIGURED/,JSON.stringify(tts));
 // A valid block passes the shape check (provisioning then fails later on what the fixture leaves out).
 for(const tts of [valid,{...valid,instruction:'像熟悉的朋友自然聊天，避免播音腔。'}])
  await assert.rejects(provisionCentralResources({port:19091,tts} as unknown as CentralProvisionConfiguration),(error:Error)=>!/TTS_PROVIDER_NOT_CONFIGURED/.test(error.message));
});
test('voice frontend config rejects invalid shapes, public ws and relative key paths before reading keys',async()=>{
 const valid={provider:'dashscope',model:'qwen3.8-omni-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',key_file:'/nonexistent/dashscope.key',voice:'Tina',instructions:'只产候选。'};
 for(const voice_frontend of [null,[],'qwen',{},{...valid,extra:true},{...valid,provider:'openai'},{...valid,model:''},{...valid,dialect:'unknown'},
  {...valid,region:'us-east-1'},{...valid,endpoint:'ws://insecure.example/realtime'},{...valid,endpoint:'not a url'},
  {...valid,key_file:'relative/dashscope.key'},{...valid,voice:''},{...valid,instructions:' '}]) {
  await assert.rejects(provisionCentralResources({port:19091,voice_frontend} as unknown as CentralProvisionConfiguration),
   /VOICE_FRONTEND_CONFIGURATION_INVALID/);
 }
});
test('the live call front may run its own model and voice: any nonempty configured model, a plain voice name, exactly those keys',async()=>{
 const valid={provider:'dashscope',model:'qwen3.8-omni-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',key_file:'/nonexistent/dashscope.key',voice:'Tina',instructions:'只产候选。'};
 for(const call of [null,[],'qwen',{},{model:'qwen-audio-3.1-realtime-plus'},{model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1',extra:1},
  {model:'',voice:'x'},{model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:''},{model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'a b'},
  {model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1',expressive:'yes'},
  ...[null,'1800',199,6001,200.5,NaN,Infinity].map(silence_duration_ms=>({model:'qwen3.8-omni-flash-realtime',voice:'Tina',silence_duration_ms})),
  ...[null,[],{enable_search:'yes'},{temperature:2},{presence_penalty:3},{top_k:5}].map(session_options=>({model:'qwen3.8-omni-flash-realtime',voice:'Tina',session_options}))])
  await assert.rejects(provisionCentralResources({port:19091,voice_frontend:{...valid,call}} as unknown as CentralProvisionConfiguration),
   /VOICE_FRONTEND_CONFIGURATION_INVALID/,JSON.stringify(call));
 // A valid call block passes the shape check (provisioning then fails later, reading the absent key file).
 for (const silence_duration_ms of [200,1800,6000])
  await assert.rejects(provisionCentralResources({port:19091,hermes_key_file:'/nonexistent/h',internal_key_file:'/nonexistent/i',skill_file:'/nonexistent/s',
   voice_frontend:{...valid,call:{model:'qwen3.8-omni-flash-realtime',voice:'Tina',silence_duration_ms}}} as unknown as CentralProvisionConfiguration),
   (error:Error)=>!/VOICE_FRONTEND_CONFIGURATION_INVALID/.test(error.message));
 await assert.rejects(provisionCentralResources({port:19091,hermes_key_file:'/nonexistent/h',internal_key_file:'/nonexistent/i',skill_file:'/nonexistent/s',
  voice_frontend:{...valid,call:{model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1'}}} as unknown as CentralProvisionConfiguration),
  (error:Error)=>!/VOICE_FRONTEND_CONFIGURATION_INVALID/.test(error.message));
});
test('the call front gets the call model and voice; push-to-talk keeps the front model and voice; a blind call model sees no camera',async()=>{
 const {createQwenVoiceResources}=await import('../src/voice/qwen-resources.mjs');
 const base={usable:true,provider:'dashscope' as const,model:'qwen3.8-omni-flash-realtime' as const,region:'cn-beijing' as const,
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'Tina',apiKey:'synthetic-offline-only',instructions:'只产候选。'};
 const authority={authorizeWindow:async()=>true,authorizeFinal:async()=>true,onError:()=>{}} as never;
 const same=createQwenVoiceResources({configuration:base,...authority as object} as never) as unknown as {frontVision:boolean};
 const split=createQwenVoiceResources({configuration:{...base,call:{model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1'}},...authority as object} as never) as unknown as
  {frontVision:boolean;createFront(callbacks:object):unknown};
 assert.equal(same.frontVision,true);assert.equal(split.frontVision,false);
 // Construction opens no connection. A call on another model never inherits the front's dialect.
 assert.ok(split.createFront({instructions:'x',onEvent:()=>{}}));
 assert.throws(()=>createQwenVoiceResources({configuration:{...base,call:{model:'qwen-audio-3.1-realtime-plus',voice:'x'}},...authority as object} as never),/call\.dialect is required/);
});
test('expressive speech: on by default (speech emotion on the qwen-audio family, never sent to omni), off by config',async()=>{
 const {createQwenVoiceResources}=await import('../src/voice/qwen-resources.mjs');
 const sent:unknown[]=[];let socket!:Socket,address='';
 class Socket{static OPEN=1;readyState=0;bufferedAmount=0;terminated=0;handlers=new Map<string,((...a:unknown[])=>void)[]>();
  constructor(url:string){address=url;socket=this;setTimeout(()=>{this.readyState=1;this.emit('open');this.emit('message',Buffer.from(JSON.stringify({type:'session.created',session:{}})));},0);}
  on(event:string,handler:(...a:unknown[])=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),handler]);return this;}
  once(event:string,handler:(...a:unknown[])=>void){return this.on(event,handler);}
  emit(event:string,...args:unknown[]){for(const handler of this.handlers.get(event)??[])handler(...args);}
  send(body:string){const event=JSON.parse(body);sent.push(event);if(this.bufferedAmount)this.bufferedAmount+=Buffer.byteLength(body);
   if(event.type==='session.update')setTimeout(()=>this.emit('message',Buffer.from(JSON.stringify({type:'session.updated',session:event.session}))),0);}
  close(){this.readyState=3;this.emit('close');} terminate(){this.terminated++;this.close();}}
 const base={usable:true,provider:'dashscope' as const,model:'qwen3.8-omni-flash-realtime' as const,region:'cn-beijing' as const,
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'Tina',apiKey:'synthetic-offline-only',instructions:'只产候选。',WebSocket:Socket};
 const authority={authorizeWindow:async()=>true,authorizeFinal:async()=>true,onError:()=>{}};
 const update=async(call?:object)=>{sent.length=0;
  const resources=createQwenVoiceResources({configuration:{...base,...(call?{call}:{})},...authority} as never) as unknown as
   {frontExpressive:boolean;createFront(callbacks:object):{connect():Promise<unknown>;appendAudio(audio:string):void|number;appendImage(image:string):void;close():void}};
  const delivered:string[]=[];const front=resources.createFront({instructions:'x',onEvent:(event:{type:string})=>delivered.push(event.type)});await front.connect();
  if(!call){front.appendAudio(Buffer.alloc(640).toString('base64'));front.appendImage('camera-frame');
   front.appendImage('camera-frame');
   for(const type of ['input_audio_buffer.committed','input_audio_buffer.cleared']){socket.emit('message',Buffer.from(JSON.stringify({type})));front.appendImage('camera-frame');}
   const first=Buffer.alloc(640).toString('base64'),next=Buffer.alloc(640,1).toString('base64');
   const replayStart=sent.length,replayPcm=Buffer.alloc(320000,2);replayPcm.fill(3,160000);front.appendAudio(replayPcm.toString('base64'));front.appendAudio(next);
   const replayWire=sent.slice(replayStart) as {type:string;audio:string}[];
   assert.ok(replayWire.every(event=>Buffer.byteLength(JSON.stringify(event))<262144),'recovery appends respect the provider WebSocket frame limit');
   assert.deepEqual(Buffer.concat(replayWire.map(event=>Buffer.from(event.audio,'base64'))),Buffer.concat([replayPcm,Buffer.from(next,'base64')]),'wire chunking preserves every PCM sample in order');
   front.appendAudio(first);
   for(const event of [{type:'input_audio_buffer.speech_started',item_id:'failed',audio_start_ms:10280},
     {type:'conversation.item.input_audio_transcription.failed',item_id:'failed'}])socket.emit('message',Buffer.from(JSON.stringify(event)));
   assert.equal(delivered.includes('conversation.item.input_audio_transcription.failed'),false);
   for(const event of [{type:'input_audio_buffer.speech_stopped',item_id:'failed',audio_end_ms:10300},
     {type:'input_audio_buffer.committed',item_id:'failed'}])socket.emit('message',Buffer.from(JSON.stringify(event)));
   assert.deepEqual(delivered.slice(-2),['input_audio_buffer.committed','conversation.item.input_audio_transcription.failed']);
   socket.bufferedAmount=100*1024;front.appendAudio(replayPcm.toString('base64'));
   assert.equal(socket.terminated,1,'the existing total-buffer budget still terminates an overloaded stream');
  }
  front.close();
  return {url:address,expressive:resources.frontExpressive,events:sent as {type:string}[],session:(sent.find(e=>(e as {type:string}).type==='session.update') as {session:Record<string,unknown>}).session};};
 const plus=await update({model:'alternate-call',transcription_model:'alternate-call-asr',dialect:'flat-smart-turn',voice:'longanqian_v3.1'});
 assert.equal(new URL(plus.url).searchParams.get('model'),'alternate-call');
 assert.equal(plus.expressive,true);assert.equal(plus.session.enable_speech_emotion,true);assert.equal(plus.session.voice,'longanqian_v3.1');
 assert.deepEqual(plus.session.input_audio_transcription,{model:'alternate-call-asr',language:'zh'});
 const even=await update({model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1',expressive:false});
 assert.equal(even.expressive,false);assert.equal(even.session.enable_speech_emotion,false);
 assert.deepEqual(even.session.input_audio_transcription,{model:'qwen3-asr-flash-realtime',language:'zh'});
 const configuredOmni=await update({model:'qwen3.8-omni-flash-realtime',voice:'Tina',silence_duration_ms:1800});
 assert.equal((configuredOmni.session.turn_detection as {silence_duration_ms:number}).silence_duration_ms,1800);
 const configuredAudio=await update({model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1',silence_duration_ms:1800});
 assert.deepEqual(configuredAudio.session.turn_detection,plus.session.turn_detection,'audio smart_turn remains provider-controlled');
 const options={enable_search:true,temperature:0.8,presence_penalty:1.5};
 const searching=await update({model:'qwen3.8-omni-flash-realtime',voice:'Tina',session_options:options});
 assert.deepEqual({enable_search:searching.session.enable_search,temperature:searching.session.temperature,presence_penalty:searching.session.presence_penalty},options);
 const audioOptions=await update({model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanqian_v3.1',session_options:options});
 assert.equal('enable_search' in audioOptions.session||'temperature' in audioOptions.session,false,'audio-family sessions keep provider defaults');
 const omni=await update();
 assert.equal(omni.expressive,true);assert.equal('enable_speech_emotion' in omni.session,false,'omni models never get the audio-family field');
 assert.deepEqual(omni.session.input_audio_transcription,{model:'qwen3-asr-flash-realtime'},'3.1 source-language field is not documented for omni');
 for(let i=0;i<omni.events.length;i++)if(omni.events[i]!.type==='input_image_buffer.append')
  assert.equal(omni.events[i-1]!.type,'input_audio_buffer.append','each image establishes audio, even when the call holds PCM and the provider silently consumed an earlier buffer');
});
test('the greeting answers a user-role pickup event in the conversation (qwen-audio-3.1 refuses a response before any user message)',async()=>{
 // Provider contract: an out-of-band response.create with no user message → "Cannot create response: conversation has no messages
 // or no user message"; a system item is not enough; a user item first, then the response, is spoken on 3.1 and 3.8.
 const {createQwenVoiceResources}=await import('../src/voice/qwen-resources.mjs');
 const sent:Record<string,unknown>[]=[];
 class Socket{static OPEN=1;readyState=0;handlers=new Map<string,((...a:unknown[])=>void)[]>();
  constructor(){setTimeout(()=>{this.readyState=1;this.emit('open');this.reply({type:'session.created',session:{}});},0);}
  on(event:string,handler:(...a:unknown[])=>void){this.handlers.set(event,[...(this.handlers.get(event)??[]),handler]);return this;}
  once(event:string,handler:(...a:unknown[])=>void){return this.on(event,handler);}
  emit(event:string,...args:unknown[]){for(const handler of this.handlers.get(event)??[])handler(...args);}
  reply(event:object){setTimeout(()=>this.emit('message',Buffer.from(JSON.stringify(event))),0);}
  send(body:string){const event=JSON.parse(body);sent.push(event);
   if(event.type==='session.update')this.reply({type:'session.updated',session:event.session});
   if(event.type==='conversation.item.create')this.reply({type:'conversation.item.created',item:event.item});
   if(event.type==='response.create'){this.reply({type:'response.created',response:{id:'r1'}});this.reply({type:'response.done',response:{id:'r1',status:'completed'}});}}
  close(){this.readyState=3;this.emit('close');} terminate(){this.close();}}
 const resources=createQwenVoiceResources({configuration:{usable:true,provider:'dashscope',model:'qwen3.8-omni-flash-realtime',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'Tina',apiKey:'synthetic-offline-only',instructions:'x',WebSocket:Socket,
  call:{model:'qwen-audio-3.1-realtime-plus',dialect:'flat-smart-turn',voice:'longanlingxi'}},authorizeWindow:async()=>true,authorizeFinal:async()=>true,onError:()=>{}} as never) as unknown as
  {createFront(callbacks:object):{connect():Promise<unknown>;setInstructions(text:string):Promise<void>;greet(event:string,delivery:string):Promise<{completed?:boolean}>;close():void}};
 const front=resources.createFront({instructions:'x',onEvent:()=>{}});await front.connect();
 await front.setInstructions('updated identity scope and calm speech');
 const outcome=await front.greet('<call_event>电话刚接通，主人还没开口。</call_event>','把这句话说出来：喂~我在呢！');
 front.close();
 assert.equal(outcome.completed,true);
 const item=sent.findIndex(e=>e.type==='conversation.item.create'),response=sent.findIndex(e=>e.type==='response.create');
 assert.ok(item>=0&&response>item,'the user event goes in first');
 const created=sent[item] as {item:{role:string;content:{text:string}[]}},asked=sent[response] as {response:Record<string,unknown>};
 assert.equal(created.item.role,'user');assert.equal(created.item.content[0]!.text,'<call_event>电话刚接通，主人还没开口。</call_event>');
 assert.equal(asked.response.instructions,'updated identity scope and calm speech\n把这句话说出来：喂~我在呢！','response override retains the current persona and identity scope');
 assert.equal('conversation' in asked.response,false,'an in-conversation response: she remembers she greeted');
});


test('voiceprint trust window accepts configured durations, rejects invalid values before model loading',async()=>{
 const base={port:19091,voiceprint:{speaker_model:{file:'/nonexistent/speaker.onnx',dim:4},encryption_key_file:'/nonexistent/voice.key'},
   hermes_key_file:'/nonexistent/h',internal_key_file:'/nonexistent/i',skill_file:'/nonexistent/s'};
 for(const trust_window_ms of [0,-1,1.5,'60000',null,NaN,Infinity])
  await assert.rejects(provisionCentralResources({...base,voiceprint:{...base.voiceprint,trust_window_ms}} as unknown as CentralProvisionConfiguration),/VOICEPRINT_CONFIGURATION_INVALID/);
 for(const trust_window_ms of [1,60000,120000])
  await assert.rejects(provisionCentralResources({...base,voiceprint:{...base.voiceprint,trust_window_ms}} as unknown as CentralProvisionConfiguration),
   (error:Error)=>!/VOICEPRINT_CONFIGURATION_INVALID/.test(error.message));
});
