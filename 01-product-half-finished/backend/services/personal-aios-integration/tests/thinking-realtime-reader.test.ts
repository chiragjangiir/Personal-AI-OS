import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
const {createFrontRealtimeSession}=await import(new URL('../../qwen-embedded/server/src/voice/embedded-realtime-session.mjs',import.meta.url).href);
class Socket extends EventEmitter {
 static OPEN=1;static sockets:Socket[]=[];readyState=1;sent:Record<string,any>[]=[];acknowledgeUpdates=true;
 constructor(){super();Socket.sockets.push(this);queueMicrotask(()=>{this.emit('open');this.incoming({type:'session.created'});});}
 incoming(event:unknown){this.emit('message',Buffer.from(JSON.stringify(event)));}
 send(wire:string){const event=JSON.parse(wire);this.sent.push(event);if(event.type==='session.update'&&this.acknowledgeUpdates)queueMicrotask(()=>this.incoming({type:'session.updated'}));}
 close(){this.readyState=3;queueMicrotask(()=>this.emit('close'));}terminate(){this.close();}
}
async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('did not settle');}
function fixture(t:test.TestContext,mode='thinking'){
 const events:Record<string,any>[]=[],diagnostics:Record<string,any>[]=[],tools=[{type:'function',name:'handoff_to_brain',parameters:{type:'object'}}];
 const front=createFrontRealtimeSession({provider:'dashscope',model:'qwen3.8-omni-flash-realtime',dialect:'nested-audio',transcription_model:'test-asr',region:'cn-beijing',
  endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',voice:'unchanged-voice',apiKey:'synthetic-offline-only',WebSocket:Socket,
  conversation_mode:mode,instructions:'reader',session_options:{enable_search:true},tools,onTool:()=>assert.fail('thinking cannot execute tools'),
  onEvent:(event:Record<string,any>)=>events.push(event),onDiagnostic:(event:Record<string,any>)=>diagnostics.push(event)});
 t.after(async()=>{front.close();await front.join();});return {front,events,diagnostics,tools};
}
test('thinking source disables autonomous answers and tools without changing voice or ASR',async t=>{
 const {front}=fixture(t);await front.connect();const socket=Socket.sockets.at(-1)!;
 const session=socket.sent.find(event=>event.type==='session.update')!.session;
 assert.equal(session.turn_detection,null);assert.equal(session.enable_search,false);assert.deepEqual(session.tools,[]);
 assert.deepEqual(session.input_audio_transcription,{model:'test-asr'});assert.equal(session.audio.output.voice,'unchanged-voice');
 assert.equal((await front.requestReply()).skipped,true);assert.equal(socket.sent.some(event=>event.type==='response.create'),false);
});
test('mode commits only after acknowledgement and failed update preserves previous configuration',async t=>{
 const {front,tools}=fixture(t,'chat');await front.connect();const socket=Socket.sockets.at(-1)!;
 socket.acknowledgeUpdates=false;
 let acknowledged=false;const failed=front.setInstructions('new reader',{tools:[],conversation_mode:'thinking'}).then(()=>{acknowledged=true;});
 const rejected=assert.rejects(failed,/provider rejected/);
 await until(()=>socket.sent.filter(event=>event.type==='session.update').length===2);
 assert.equal(acknowledged,false);assert.equal(socket.sent.at(-1)!.session.turn_detection,null);
 socket.incoming({type:'error',error:{message:'provider rejected'}});await rejected;
 socket.acknowledgeUpdates=true;await front.setInstructions('still chat');
 const restored=socket.sent.filter(event=>event.type==='session.update').at(-1)!.session;
 assert.equal(restored.instructions,'still chat');assert.deepEqual(restored.tools,tools);assert.notEqual(restored.turn_detection,null);
 await front.setInstructions('reader',{conversation_mode:'thinking'});
 const thinking=socket.sent.filter(event=>event.type==='session.update').at(-1)!.session;
 assert.deepEqual(thinking.tools,[]);assert.equal(thinking.enable_search,false);assert.equal(thinking.turn_detection,null);
});
const audio=Buffer.from(new Int16Array(240).buffer).toString('base64');
async function readSentence(socket:Socket,index:number,sentence:string,{transcript=sentence as string|null,spoken=true}={}){
 await until(()=>socket.sent.filter(event=>event.type==='conversation.item.create').length===index+1);
 const item=socket.sent.filter(event=>event.type==='conversation.item.create').at(-1)!.item;
 assert.equal(item.role,'user');assert.equal(item.content[0].text,`【原文开始】\n${sentence}\n【原文结束】`);
 socket.incoming({type:'conversation.item.created',item});
 await until(()=>socket.sent.filter(event=>event.type==='response.create').length===index+1);
 const create=socket.sent.filter(event=>event.type==='response.create').at(-1)!;
 assert.deepEqual(create,{event_id:create.event_id,type:'response.create'});
 socket.incoming({type:'response.created',response:{id:`read-${index}`}});
 if(spoken)socket.incoming({type:'response.audio.delta',response_id:`read-${index}`,delta:audio});
 if(transcript!==null)socket.incoming({type:'response.audio_transcript.done',response_id:`read-${index}`,transcript});
 socket.incoming({type:'response.done',response:{id:`read-${index}`,status:'completed'}});
}
test('reader queues literal sentences with bare responses and only logs a transcript that differs from the source',async t=>{
 const {front,events,diagnostics}=fixture(t);await front.connect();const socket=Socket.sockets.at(-1)!;
 const read=front.respond('第一句。第二句！第三句。',()=>true,{message_id:'answer-1',source_turn:7});
 for(const [index,sentence] of ['第一句。','第二句！','第三句。'].entries()){
  await readSentence(socket,index,sentence,{transcript:index===1?'第二句':sentence});
  const transcript=events.filter(event=>event.type==='response.audio_transcript.done').at(-1)!;
  assert.equal(transcript.__voiceContext.message_id,'answer-1');assert.equal(transcript.__voiceContext.sentence_index,index);
  assert.equal(transcript.__voiceContext.response_id,`read-${index}`);assert.equal(transcript.__voiceContext.source_turn,7);
 }
 assert.equal((await read).completed,true,'a transcript difference keeps the answer read and delivered');
 assert.equal(socket.sent.filter(event=>event.type==='response.cancel').length,0);
 const mismatch=events.filter(event=>event.type.startsWith('thinking.readout_'));
 assert.deepEqual(mismatch.map(event=>event.type),['thinking.readout_transcript_mismatch']);
 assert.equal(mismatch[0]!.sentence_index,1);
 assert.deepEqual(mismatch[0]!.readout_fidelity,{message_id:'answer-1',sentence_index:1,response_id:'read-1',source_text:'第二句！',transcript_text:'第二句'});
 assert.equal(diagnostics.filter(event=>event.event==='thinking.readout_transcript_mismatch').length,1);
 const stale=await front.respond('不得朗读。',()=>false,{message_id:'answer-2'});assert.equal(stale.skipped,true);
 assert.equal(socket.sent.filter(event=>event.type==='conversation.item.create').length,3);
});

test('a spoken sentence without transcript evidence is logged and the answer continues',async t=>{
 const {front,events}=fixture(t);await front.connect();const socket=Socket.sockets.at(-1)!;
 const read=front.respond('第一句。第二句。',()=>true,{message_id:'no-transcript',source_turn:8});
 await readSentence(socket,0,'第一句。',{transcript:null});await readSentence(socket,1,'第二句。');
 assert.equal((await read).completed,true);
 assert.deepEqual(events.filter(event=>event.type.startsWith('thinking.readout_')).map(event=>event.type),['thinking.readout_transcript_missing']);
});

test('a completed readout with no audio stops the answer readout and reports failure',async t=>{
 const {front,events,diagnostics}=fixture(t);await front.connect();const socket=Socket.sockets.at(-1)!;
 const read=front.respond('第一句。第二句。',()=>true,{message_id:'silent',source_turn:8});
 await readSentence(socket,0,'第一句。',{transcript:null,spoken:false});
 assert.notEqual((await read).completed,true);
 assert.equal(socket.sent.filter(event=>event.type==='conversation.item.create').length,1);
 assert.deepEqual(events.filter(event=>event.type.startsWith('thinking.readout_')).map(event=>event.type),['thinking.readout_audio_missing']);
 assert.ok(diagnostics.some(event=>event.event==='thinking.readout_audio_missing'));
});

test('the last sentence read without audio still fails the answer delivery',async t=>{
 const {front}=fixture(t);await front.connect();const socket=Socket.sockets.at(-1)!;
 const read=front.respond('只有一句。',()=>true,{message_id:'silent-last'});
 await readSentence(socket,0,'只有一句。',{spoken:false});
 assert.deepEqual(await read,{failed:true,audioMissing:true});
});

test('interruption cancels the current readout, its queued sentences and late audio of the cancelled response',async t=>{
 const {front,events}=fixture(t);await front.connect();const socket=Socket.sockets.at(-1)!;
 const read=front.respond('第一句。第二句。第三句。',()=>true,{message_id:'interrupted',source_turn:9});
 await readSentence(socket,0,'第一句。');
 await until(()=>socket.sent.filter(event=>event.type==='response.create').length===2||socket.sent.filter(event=>event.type==='conversation.item.create').length===2);
 const item=socket.sent.filter(event=>event.type==='conversation.item.create').at(-1)!.item;socket.incoming({type:'conversation.item.created',item});
 await until(()=>socket.sent.filter(event=>event.type==='response.create').length===2);
 socket.incoming({type:'response.created',response:{id:'read-1'}});socket.incoming({type:'response.audio.delta',response_id:'read-1',delta:audio});
 const cancelled=front.cancel();
 socket.incoming({type:'response.audio.delta',response_id:'read-1',delta:audio});
 socket.incoming({type:'response.done',response:{id:'read-1',status:'cancelled'}});await cancelled;
 assert.equal((await read).completed,undefined);
 assert.equal(socket.sent.filter(event=>event.type==='conversation.item.create').length,2,'the third sentence is never queued after interruption');
 const late=events.filter(event=>event.type==='response.audio.delta'&&event.response_id==='read-1');
 assert.equal(late.at(-1)!.__voiceContext.suppressed,true,'late audio of the cancelled readout is marked suppressed');
 assert.equal(events.some(event=>event.type.startsWith('thinking.readout_')),false);
});
