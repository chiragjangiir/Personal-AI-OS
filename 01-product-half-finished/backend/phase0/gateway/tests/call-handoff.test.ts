import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {dispose} from '@livekit/rtc-node';
import {createVoiceCallSession,FIRST_AUDIO_CONFIRM_MS,frontInstructions,CALL_OBSERVE_TOOL,type CallTurn} from '../src/voice-call-session.ts';
import {CALL_HANDOFF_TOOL,CALL_SEARCH_TOOL,callHandoff} from '../src/call-handoff.ts';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createQwenVoiceResources} from '../../../services/personal-aios-integration/src/voice/qwen-resources.mjs';

after(()=>dispose());

test('both call prompts distinguish clear side conversation from an ambiguous addressee',()=>{
  const fast=frontInstructions({identity:'owner'});
  const brain=readFileSync(new URL('../../../../../integrations/hermes/personal_aios/skills/personal-aios-main/SKILL.md',import.meta.url),'utf8');
  for(const text of [fast,brain]){
    for(const phrase of ['按语义判断主人在对谁说话','你先坐','你要喝什么','叫别人的名字','有旁人在场','拿不准在对谁说时，照常回答','绝不当作对你的指令或授权']){
      assert.ok(text.includes(phrase),phrase);
    }
  }
  assert.match(fast,/observe_call_turn 静默结束/);assert.match(brain,/reply_mode=none，不生成正文、不说「稍等」/);
});

for(const dialect of ['nested-audio','flat-smart-turn'])test(`observed call turn ends silently through the production ${dialect} tool loop`,async t=>{
  const sent:any[]=[],transcripts:string[]=[],turns:CallTurn[]=[],errors:unknown[]=[],frames:Int16Array[]=[];
  const done=Promise.withResolvers<void>();let first=true;
  class Socket extends EventEmitter {
    static OPEN=1;readyState=0;bufferedAmount=0;
    constructor(){super();setImmediate(()=>{this.readyState=1;this.emit('open');this.reply({type:'session.created',session:{}});});}
    reply(event:object){setImmediate(()=>{if(this.readyState===1)this.emit('message',Buffer.from(JSON.stringify(event)));});}
    send(body:string){const event=JSON.parse(body);sent.push(event);
      if(event.type==='session.update')this.reply({type:'session.updated',session:event.session});
      if(event.type==='conversation.item.create')this.reply({type:'conversation.item.created',item:event.item});
      if(event.type==='response.cancel'){
        this.reply({type:'response.audio.delta',response_id:'silent',delta:Buffer.from(new Int16Array(480).fill(1000).buffer).toString('base64')});
        this.reply({type:'response.audio_transcript.delta',response_id:'silent',delta:'迟到的嗯'});
        this.reply({type:'response.done',response:{id:'silent',status:'cancelled',output:[]}});
      }
      if(event.type==='response.create'){
        const id=first?'silent':'answer';this.reply({type:'response.created',response:{id}});
        if(first){first=false;this.reply({type:'response.function_call_arguments.done',response_id:id,call_id:'observe',name:'observe_call_turn',arguments:'{}'});
        }else this.reply({type:'response.done',response:{id,status:'completed',output:[]}});
      }
    }
    close(){this.readyState=3;this.emit('close');}terminate(){this.close();}
  }
  const resources=createQwenVoiceResources({configuration:{usable:true,provider:'dashscope',model:'configured-front',voice:'configured-voice',
    dialect,region:'cn-beijing',endpoint:'wss://offline.example/realtime',apiKey:'synthetic',WebSocket:Socket},onError:(e:unknown)=>errors.push(e)} as never) as any;
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},createFront:callbacks=>resources.createFront(callbacks),
    createPlayout:()=>({open:async()=>{},push:pcm=>{frames.push(pcm);},interrupt:()=>{},drain:async()=>{},close:async()=>{}}),
    onState:()=>{},onTranscript:(_id,_turn,role,text)=>{if(role==='assistant')transcripts.push(text);},
    onTurn:turn=>{turns.push(turn);done.resolve();},onError:e=>errors.push(e)});
  t.after(()=>call.closeAll());await call.open('side-conversation',{context:'旁边有客人。'});
  await call.request('你先坐，我打个电话',{call_id:'side-conversation',identity:'owner'});await done.promise;
  await new Promise(setImmediate);
  assert.deepEqual(frames,[]);assert.deepEqual(transcripts,[]);
  assert.deepEqual(turns.map(turn=>[turn.user,turn.assistant,turn.speaker,turn.route,turn.addressed_to_assistant]),[['你先坐，我打个电话','','owner','front_only',false]]);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);
  assert.equal(sent.filter(e=>e.type==='response.cancel').length,1,'terminal tool cancels native generation rather than waiting for a tool result');
  assert.equal(sent.filter(e=>e.item?.type==='function_call_output').length,0,'discardReply prevents a spoken tool continuation');
  assert.ok(sent.find(e=>e.type==='session.update').session.tools.some((tool:any)=>tool.name===CALL_OBSERVE_TOOL.name));
  assert.equal(await call.request('依米，接着聊',{call_id:'side-conversation',identity:'owner'}),true,'the next turn is not blocked by silence');
  assert.equal(sent.filter(e=>e.type==='response.create').length,2);assert.deepEqual(errors,[]);
});
type Front=Parameters<Parameters<typeof createVoiceCallSession>[0]['createFront']>[0];
const note={difficulty:'需要比较多项条件',intent:'比较方案并说明取舍',thinking:'enabled' as const};
const tick=async(t:test.TestContext)=>{t.mock.timers.tick(FIRST_AUDIO_CONFIRM_MS);await new Promise(r=>setImmediate(r));};
function fixture(t:test.TestContext,reply:(front:Front)=>unknown=()=>({completed:true}),managed=false,delivery?:(front:Front,context?:{source_turn?:number})=>Promise<unknown>){
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  let front!:Front;const contexts:string[]=[],deliveries:{text:string;valid:()=>boolean;context:{source_turn?:number}|undefined}[]=[];const turns:CallTurn[]=[],dispatches:CallTurn[]=[],searches:string[]=[],events:Record<string,unknown>[]=[],errors:unknown[]=[],audioReceipts:unknown[]=[],played:number[]=[];let position=0,detected=false;
  const asset={path:'/synthetic',sha256:'0'.repeat(64)};
  const call=createVoiceCallSession({room:()=>({}),greeting:{enabled:false},
    ...(managed?{turns:{config:{enabled:true,model:asset,thinking_sound:{...asset,model:'test',voice:'test'}},score:async()=>1,thinking:new Int16Array(480).fill(777)},
      identifySpeech:async()=>true,transcribeSpeech:async()=>'',classifySpeech:async()=>({stop:false,guests:'unchanged' as const}),
      openVad:async()=>({write:async(samples:Float32Array)=>{if(detected)return [];detected=true;return [{at:samples.length,start:0}];},close:async()=>{}})}:{}),
    createFront:callbacks=>{front=callbacks;return {connect:async()=>{},appendAudio:()=>{},appendImage:()=>{},
      hear:async text=>{if(typeof text==='string')contexts.push(text);},requestReply:async()=>reply(front),respond:async(text,valid,context)=>{deliveries.push({text,valid:valid??(()=>true),context});return delivery?delivery(front,context):{completed:true};},context:async()=>{},close:()=>{}};},
    searchCall:async query=>{searches.push(query);return {success:true,data:{web:[{title:'public',url:'https://example.org'}]}};},
    createPlayout:()=>({open:async()=>{},push:(pcm,credit)=>{played.push(pcm[0]!);position+=pcm.length;credit?.release(pcm.length);},playedSamples:()=>position,interrupt:()=>{position=0;},drain:async()=>{},close:async()=>{}}),
    onState:()=>{},onTranscript:()=>{},onTurn:(turn,audio)=>{(turn.phase==='handoff'?dispatches:turns).push(turn);if(audio)audioReceipts.push(audio);},onDiagnostic:event=>events.push(event),onError:error=>errors.push(error)});
  t.after(()=>call.closeAll());return {call,get front(){return front;},turns,dispatches,searches,events,errors,audioReceipts,played,deliveries,contexts};
}
function audio(front:Front,id:string,text:string,mixed=false,sourceTurn?:number){
  const emit=(event:Record<string,unknown>)=>front.onEvent({...event,...(sourceTurn===undefined?{}:{__voiceContext:{source_turn:sourceTurn}})});
  emit({type:'response.created',response:{id}});
  emit({type:'response.audio_transcript.delta',response_id:id,delta:text});
  emit({type:'response.audio.delta',response_id:id,delta:Buffer.from(new Int16Array(240).fill(1000).buffer).toString('base64')});
  emit({type:'response.done',response:{id,status:'completed',usage:{input_tokens:12,output_tokens:8},output:mixed?[{type:'function_call'}]:[]}});
}
test('owner instructions name self data and immediate handoff without leaking that capability into guest scope',()=>{
  const owner=frontInstructions({identity:'owner',context:'最近聊过旅行。'});
  for(const term of ['立即调用 handoff_to_brain','runtime_query','runtime_status','声纹','通话','日程','提醒','web_search','深入推理'])assert.ok(owner.includes(term),term);
  assert.match(owner,/不必先自己查或尝试回答/);assert.match(owner,/背景不能代替实时查询或记录核对/);
  assert.match(owner,/先调用工具，再回应/);assert.match(owner,/不会启动任何查询、记忆写入或操作/);
  assert.match(CALL_HANDOFF_TOOL.description,/自己的实时运行数据/);assert.match(CALL_HANDOFF_TOOL.description,/不必先自己查/);
  for(const identity of ['pending','owner_uncertain','guest'] as const){
    const scoped=frontInstructions({identity,context:'PRIVATE'});
    assert.doesNotMatch(scoped,/PRIVATE|runtime_query|runtime_status|立即调用 handoff_to_brain/);
  }
});
test('provider session.update carries owner tools on connect and acknowledged scope updates',async()=>{
  for(const dialect of ['nested-audio','flat-smart-turn']){
    const sent:any[]=[],errors:unknown[]=[];
    class Socket extends EventEmitter {
      static OPEN=1;readyState=0;bufferedAmount=0;
      constructor(){super();setImmediate(()=>{this.readyState=1;this.emit('open');this.reply({type:'session.created',session:{}});});}
      reply(event:object){setImmediate(()=>this.emit('message',Buffer.from(JSON.stringify(event))));}
      send(body:string){const event=JSON.parse(body);sent.push(event);if(event.type==='session.update')this.reply({type:'session.updated',session:event.session});}
      close(){this.readyState=3;this.emit('close');}terminate(){this.close();}
    }
    const resources=createQwenVoiceResources({configuration:{usable:true,provider:'dashscope',model:'configured-front',voice:'configured-voice',
      dialect,region:'cn-beijing',endpoint:'wss://offline.example/realtime',apiKey:'synthetic-offline-only',WebSocket:Socket,
      call:{model:'configured-front',voice:'configured-voice',session_options:{enable_search:true}}},onError:(error:unknown)=>errors.push(error)} as never) as any;
    const owner=frontInstructions({identity:'owner'}),tools=[CALL_HANDOFF_TOOL,CALL_SEARCH_TOOL];
    const front=resources.createFront({instructions:owner,tools,onTool:()=>({accepted:true}),onEvent:()=>{}});
    try{
      await front.connect();
      const initial=sent.find(event=>event.type==='session.update').session;
      assert.deepEqual(initial.tools,tools);assert.equal(initial.instructions,owner);assert.equal(initial.enable_search,false);
      await front.setInstructions(frontInstructions({identity:'guest'}),{tools:[CALL_SEARCH_TOOL]});
      assert.deepEqual(sent.filter(event=>event.type==='session.update').at(-1).session.tools,[CALL_SEARCH_TOOL]);
      await front.setInstructions(owner,{tools});
      assert.deepEqual(sent.filter(event=>event.type==='session.update').at(-1).session.tools,tools);
      assert.deepEqual(errors,[]);
    }finally{front.close();}
  }
});
test('front self-answer retains memory, public search and the complete requested count through 100',async t=>{
  const count=Array.from({length:100},(_,i)=>i+1).join('，');
  const f=fixture(t,front=>{audio(front,'count',count);return {completed:true};});
  await f.call.open('count',{context:'主人喜欢散步。最近在聊天终端讨论旅行。'});
  assert.match(f.front.instructions,/主人喜欢散步/);assert.match(f.front.instructions,/最近在聊天终端/);
  assert.match(f.front.instructions,/数数、讲故事、朗读或逐项念清单，就完整说完/);
  assert.doesNotMatch(f.front.instructions,/一般一两句|长清单.*不要/);
  assert.deepEqual(f.front.tools?.map((tool:any)=>tool.name),['handoff_to_brain','observe_call_turn','web_search']);
  await f.front.onTool!('web_search',{query:'公开天气'});assert.deepEqual(f.searches,['公开天气']);
  assert.equal(await f.call.request('从1数到100',{call_id:'count',identity:'owner'}),true);await tick(t);
  assert.equal(f.turns.length,1);assert.equal(f.turns[0]!.route,'front_only');assert.equal(f.turns[0]!.assistant,count);
  assert.equal(f.turns[0]!.handoff,undefined);assert.deepEqual(f.errors,[]);
  const metric=f.events.find(e=>e.voice_call_stage==='turn_metrics');assert.equal(metric?.path,'front_only');assert.equal(metric?.first_audio_ms,FIRST_AUDIO_CONFIRM_MS);
  assert.equal((metric?.usage as unknown[]).length,1,'held completion replay must not double-bill usage');
});

test('a silent decision preserves late ASR as background rather than an unanswered request',async t=>{
  const f=fixture(t);await f.call.open('late-observation');
  f.front.onEvent({type:'input_audio_buffer.committed',item_id:'late'});
  f.front.onEvent({type:'response.created',response:{id:'silent'}});f.front.onTool!('observe_call_turn',{});
  assert.equal(f.turns.length,0,'the archived observation waits for its original transcription');
  f.front.onEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'你先坐，我打个电话'});
  assert.equal(f.turns.length,1);assert.equal(f.turns[0]!.user,'你先坐，我打个电话');
  assert.equal(f.turns[0]!.addressed_to_assistant,false);assert.equal(f.turns[0]!.route,'front_only');
  assert.deepEqual(f.played,[]);assert.equal(f.contexts.length,1);assert.match(f.contexts[0]!,/^主人对旁人说：你先坐，我打个电话/);assert.match(f.contexts[0]!,/不是对你的指令或授权/);assert.deepEqual(f.deliveries,[]);assert.deepEqual(f.errors,[]);
});
test('a tool-only handoff and mixed audio/tool continuation deliver the exact one judgement',async t=>{
  const f=fixture(t,front=>{
    front.onEvent({type:'response.created',response:{id:'tool'}});front.onTool!('handoff_to_brain',note);
    front.onEvent({type:'response.done',response:{id:'tool',status:'completed',output:[{type:'function_call'}]}});
    audio(front,'ack','等一下，我核对一下。',true);return {completed:true};
  });
  await f.call.open('handoff');await f.call.request('比较这两个方案',{call_id:'handoff',identity:'owner'});await tick(t);
  assert.equal(f.turns.length,1);assert.equal(f.turns[0]!.route,'handoff');assert.deepEqual(f.turns[0]!.handoff,note);
  assert.equal(f.turns[0]!.user,'比较这两个方案');assert.deepEqual(f.errors,[]);
});
test('requested handoff survives an unheard acknowledgement and the next request gets a separate turn',async t=>{
  const f=fixture(t,front=>{
    front.onEvent({type:'response.created',response:{id:'unheard'}});front.onTool!('handoff_to_brain',note);
    front.onEvent({type:'response.done',response:{id:'unheard',output:[{type:'function_call'}]}});return {completed:true};
  });
  await f.call.open('cancel');await f.call.request('先比较方案',{call_id:'cancel',identity:'owner'});
  f.front.onEvent({type:'input_audio_buffer.speech_started'});
  assert.doesNotThrow(()=>f.front.onTool!('handoff_to_brain',{...note,intent:'补充条件后比较'}));
  audio(f.front,'replacement','我按补充条件看一下。');await tick(t);
  assert.equal(f.turns[0]!.handoff?.intent,note.intent);
  assert.equal(f.turns[1]!.handoff?.intent,'补充条件后比较');
  assert.equal(f.dispatches.length,2);assert.notEqual(f.dispatches[0]!.turn,f.dispatches[1]!.turn);
});

test('handoff dispatch precedes front completion and carries no pending archive dependency',async t=>{
  const reply=Promise.withResolvers<unknown>(),f=fixture(t,front=>{
    front.onEvent({type:'response.created',response:{id:'decision'}});front.onTool!('handoff_to_brain',note);
    return reply.promise;
  });
  await f.call.open('early');const requested=f.call.request('比较方案',{call_id:'early',identity:'owner'});
  await new Promise(setImmediate);
  assert.equal(f.dispatches.length,1);assert.equal(f.turns.length,0);assert.equal(f.audioReceipts.length,0);
  assert.throws(()=>f.front.onTool!('handoff_to_brain',note),/CALL_HANDOFF_ALREADY_REQUESTED/);
  audio(f.front,'ack','等一下。');reply.resolve({completed:true});await requested;await tick(t);
  assert.equal(f.dispatches.length,1);assert.equal(f.turns.length,1);assert.equal(f.turns[0]!.phase,'complete');
  assert.equal(f.turns[0]!.turn,f.dispatches[0]!.turn);assert.deepEqual(f.errors,[]);
});

test('handoff before ASR seals its original turn on interruption and preserves late transcription',async t=>{
  const f=fixture(t);await f.call.open('late-asr');
  f.front.onEvent({type:'input_audio_buffer.committed',item_id:'pending-text'});
  f.front.onEvent({type:'response.created',response:{id:'tool-before-asr'}});
  f.front.onTool!('handoff_to_brain',note);
  f.front.onEvent({type:'input_audio_buffer.speech_started'});
  assert.equal(f.turns.length,0,'final archive still waits for the original ASR');
  f.front.onEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'pending-text',transcript:'原始请求'});
  assert.equal(f.turns.length,1);assert.equal(f.turns[0]!.user,'原始请求');assert.equal(f.turns[0]!.phase,'complete');
  assert.doesNotThrow(()=>f.front.onTool!('handoff_to_brain',{...note,intent:'下一条请求'}));
  await f.call.closeAll();assert.equal(f.turns[1]!.user,'下一条请求');
  assert.equal(f.dispatches.length,2);assert.notEqual(f.dispatches[0]!.turn,f.dispatches[1]!.turn);
});
test('concurrent text request cannot overwrite the request that owns the current reply',async t=>{
  const pending=Promise.withResolvers<unknown>(),f=fixture(t,()=>pending.promise);
  await f.call.open('busy');const first=f.call.request('请求A',{call_id:'busy',identity:'owner'});await new Promise(r=>setImmediate(r));
  assert.equal(await f.call.request('请求B',{call_id:'busy',identity:'owner'}),false);
  audio(f.front,'A','答复A');pending.resolve({completed:true});await first;await tick(t);
  assert.equal(f.turns[0]!.user,'请求A');assert.equal(f.turns[0]!.assistant,'答复A');
});
test('public search stays available in guest scope while private handoff is denied',async t=>{
  const f=fixture(t);await f.call.open('guest',{mode:'ambient'});
  for(const identity of ['pending','owner_uncertain'] as const){
    await f.call.identify('guest',identity);
    assert.deepEqual(f.front.tools?.map((tool:any)=>tool.name),['web_search']);
    assert.throws(()=>f.front.onTool!('handoff_to_brain',note),/CALL_HANDOFF_DENIED/);
  }
  await f.call.identify('guest','owner');
  assert.deepEqual(f.front.tools?.map((tool:any)=>tool.name),['handoff_to_brain','observe_call_turn','web_search']);
  await f.call.identify('guest','guest');
  assert.deepEqual(f.front.tools?.map((tool:any)=>tool.name),['web_search']);
  await f.front.onTool!('web_search',{query:'public fact'});
  assert.throws(()=>f.front.onTool!('handoff_to_brain',note),/CALL_HANDOFF_DENIED/);
  assert.throws(()=>callHandoff({...note,thinking:'auto'}),/CALL_HANDOFF_INVALID/);
  assert.throws(()=>callHandoff({...note,difficulty:''}),/CALL_HANDOFF_INVALID/);
});
test('an initial ambient request retains its original archived audio for voice authorization',async t=>{
  const f=fixture(t,front=>{front.onTool!('handoff_to_brain',note);audio(front,'ambient-ack','等一下。');return {completed:true};});
  const original={raw_ref:'l5:'+'a'.repeat(64),archive_revision:'b'.repeat(64),start_ms:90000,end_ms:90500};
  await f.call.open('ambient',{mode:'ambient'});await f.call.identify('ambient','owner');
  await f.call.request('帮我买杯奶茶',{call_id:'ambient',identity:'owner',audio:original});await tick(t);
  assert.equal(f.turns[0]!.route,'handoff');assert.deepEqual(await f.audioReceipts[0],{status:'fulfilled',value:original});
});
test('an unfinished front preserves the unanswered request for the existing native fallback',async t=>{
  const f=fixture(t);await f.call.open('unfinished');await f.call.request('请帮我查记录',{call_id:'unfinished',identity:'owner'});
  await f.call.closeAll();assert.equal(f.turns[0]!.route,'handoff');assert.equal(f.turns[0]!.user,'请帮我查记录');
  assert.equal(f.turns[0]!.handoff,undefined,'missing judgement retains configured native defaults');
});


test('a new detected utterance cancels the previous handoff waiting sound before identity finishes',async t=>{
  const f=fixture(t,front=>{front.onTool!('handoff_to_brain',note);audio(front,'wait-ack','等一下。');return {completed:true};},true);
  await f.call.open('waiting');await f.call.request('比较两个方案',{call_id:'waiting',identity:'owner'});await tick(t);
  assert.equal(f.turns[0]!.route,'handoff');assert.deepEqual(f.played,[1000]);
  t.mock.timers.tick(500);f.call.pushPcm(new Int16Array(512).fill(1000));await new Promise(r=>setImmediate(r));
  t.mock.timers.tick(2500);await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.played,[1000],'the old request cannot play its thinking sound during new speech');assert.deepEqual(f.errors,[]);
});

test('handoff emits one factual status without acoustic turns and a matching result cancels its queued guard',async t=>{
  const f=fixture(t,front=>{front.onTool!('handoff_to_brain',note);audio(front,'ack','等一下。');return {completed:true};});
  await f.call.open('status');await f.call.request('比较方案',{call_id:'status',identity:'owner'});await tick(t);
  t.mock.timers.tick(1999);assert.equal(f.deliveries.length,0);
  t.mock.timers.tick(1);await new Promise(r=>setImmediate(r));
  assert.equal(f.deliveries.length,1);assert.match(f.deliveries[0]!.text,/结果还没有返回/);
  assert.deepEqual(f.deliveries[0]!.context,{source_turn:0});assert.equal(f.deliveries[0]!.valid(),true);
  t.mock.timers.tick(5000);assert.equal(f.deliveries.length,1);
  await f.call.respond('实际进度',{call_id:'status',identity:'owner',turn:0,progress:true});
  assert.equal(f.deliveries[0]!.valid(),false);assert.deepEqual(f.errors,[]);
});
test('a previous result cannot cancel the next handoff status and a new request invalidates the old queued status',async t=>{
  let sequence=0;const f=fixture(t,front=>{front.onTool!('handoff_to_brain',note);audio(front,`ack-${++sequence}`,'等一下。');return {completed:true};});
  await f.call.open('ordered');await f.call.request('第一件事',{call_id:'ordered',identity:'owner'});await tick(t);
  t.mock.timers.tick(2000);await new Promise(r=>setImmediate(r));const old=f.deliveries[0]!;
  assert.equal(old.valid(),true);
  await f.call.request('第二件事',{call_id:'ordered',identity:'owner'});await tick(t);assert.equal(old.valid(),false);
  await f.call.respond('第一件结果',{call_id:'ordered',identity:'owner',turn:0});
  t.mock.timers.tick(2000);await new Promise(r=>setImmediate(r));
  assert.equal(f.deliveries.length,3);assert.deepEqual(f.deliveries[2]!.context,{source_turn:1});assert.equal(f.deliveries[2]!.valid(),true);
  await f.call.closeAll();assert.equal(f.deliveries[2]!.valid(),false);
});
test('native delivery PCM and usage stay on the source turn until brain completion',async t=>{
  const f=fixture(t,front=>{front.onTool!('handoff_to_brain',note);front.onEvent({type:'response.created',response:{id:'tool'}});
    front.onEvent({type:'response.done',response:{id:'tool',status:'completed'}});return {completed:true};},false,
    async(front,context)=>{audio(front,'brain-final','比较结果。',false,context?.source_turn);return {completed:true};});
  await f.call.open('metrics');await f.call.request('比较方案',{call_id:'metrics',identity:'owner'});await tick(t);
  assert.equal(f.turns[0]!.route,'handoff');
  const speaking=f.call.respond('实际结果',{call_id:'metrics',identity:'owner',turn:0});await new Promise(r=>setImmediate(r));
  assert.equal(f.events.some(e=>e.phase==='brain_complete'),false,'held PCM has not reached the source output yet');
  await tick(t);assert.equal(await speaking,true);
  const metric=f.events.find(e=>e.phase==='brain_complete');
  assert.equal(metric?.turn,0);assert.notEqual(metric?.first_audio_ms,null);assert.equal(metric?.audio_boundary,'source_pcm_release');
  assert.equal((metric?.usage as {response_id:string}[]).some(row=>row.response_id==='brain-final'),true);
});

test('a native final dropped before source PCM release cannot report brain completion',async t=>{
  const f=fixture(t,front=>{front.onTool!('handoff_to_brain',note);audio(front,'ack','等一下。');return {completed:true};},false,
    async(front,context)=>{audio(front,'dropped-final','实际结果。',false,context?.source_turn);return {completed:true};});
  await f.call.open('dropped-final');await f.call.request('比较方案',{call_id:'dropped-final',identity:'owner'});await tick(t);
  const speaking=f.call.respond('实际结果',{call_id:'dropped-final',identity:'owner',turn:0});await new Promise(r=>setImmediate(r));
  f.front.onEvent({type:'input_audio_buffer.speech_started'});
  assert.equal(await speaking,false);assert.equal(f.events.some(e=>e.phase==='brain_complete'),false);
});
