import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {cases} from './cases.mjs';
import {baselineVariant,budgetedSocket,runCase,score} from './transport.mjs';
import {createQwenVoiceResources} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/voice/qwen-resources.mjs';

const tools=[{type:'function',name:'handoff_to_brain',description:'test',parameters:{type:'object',properties:{}}}];
const handoff={difficulty:'查实际记录',intent:'查询今天手机和眼镜声纹相似度',thinking:'disabled'};
function fixture(route='handoff_to_brain',dialect='nested-audio',limit=200) {
  const sent=[],budget={requests:0,sessions:0,limit};
  class Socket extends EventEmitter {
    static OPEN=1;readyState=0;bufferedAmount=0;
    constructor(){super();setImmediate(()=>{this.readyState=1;this.emit('open');this.reply({type:'session.created',session:{}});});}
    reply(event){setImmediate(()=>{if(this.readyState===1)this.emit('message',Buffer.from(JSON.stringify(event)));});}
    send(body){
      const event=JSON.parse(body);sent.push(event);
      if(event.type==='session.update')this.reply({type:'session.updated',session:event.session});
      if(event.type==='conversation.item.create')this.reply({type:'conversation.item.created',item:event.item});
      if(event.type==='response.create'){
        this.reply({type:'response.created',response:{id:'r'}});
        if(route==='error')this.reply({type:'error',error:{code:'injected'}});
        else if(route==='close')setImmediate(()=>this.close());
        else if(route==='silent')return;
        else if(route==='malformed')this.reply({type:'response.function_call_arguments.done',response_id:'r',name:'handoff_to_brain',arguments:'{'});
        else if(route==='front_only')this.reply({type:'response.done',response:{id:'r',status:'completed',output:[]}});
        else this.reply({type:'response.function_call_arguments.done',response_id:'r',call_id:'tool-1',name:route,arguments:JSON.stringify(handoff)});
      }
    }
    close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
    terminate(){this.close();}
  }
  return {sent,budget,Socket:budgetedSocket(Socket,budget),configuration:{usable:true,provider:'dashscope',model:'configured-front',voice:'configured-front-voice',
    dialect:'nested-audio',transcription_model:'configured-asr',region:'cn-beijing',endpoint:'wss://offline.invalid',apiKey:'synthetic',
    call:{model:'configured-call',voice:'configured-call-voice',dialect,session_options:{enable_search:true}}}};
}
async function run(f,sample=cases[0],timeoutMs=2000){return runCase({createResources:createQwenVoiceResources,
  configuration:{...f.configuration,WebSocket:f.Socket},instructions:'synthetic owner instructions',tools,sample,timeoutMs});}

test('43 labels include side conversation, an explicit call and an ambiguous addressee; these are fixtures only',()=>{
  assert.equal(cases.length,43);assert.equal(new Set(cases.map(c=>c.id)).size,43);
  assert.deepEqual(Object.fromEntries(['handoff_to_brain','front_only','web_search','observe_call_turn'].map(route=>[route,cases.filter(c=>c.expected===route).length])),
    {handoff_to_brain:22,front_only:11,web_search:9,observe_call_turn:1});
});
test('baseline replaces only the call rules and description while retaining shared persona/context',()=>{
  const tool={name:'handoff_to_brain',description:'new',parameters:{x:1}};
  const result=baselineVariant('persona\nNEW\ncontext','NEW','OLD',tool,'old description');
  assert.equal(result.instructions,'persona\nOLD\ncontext');assert.equal(result.tool.description,'old description');
  assert.deepEqual(result.tool.parameters,tool.parameters);assert.equal(tool.description,'new');
  assert.throws(()=>baselineVariant('NEW NEW','NEW','OLD',tool,''),/NOT_UNIQUE/);
  assert.throws(()=>baselineVariant('NEW','NEW','OLD',tool,''),/DESCRIPTION_MISSING/);
});
for(const dialect of ['nested-audio','flat-smart-turn'])test(`production ${dialect}: call config preserved, first tool stops with one physical request and no tool output`,async()=>{
  const f=fixture('handoff_to_brain',dialect),result=await run(f);
  assert.equal(result.route,'handoff_to_brain');assert.deepEqual(result.arguments,handoff);
  assert.equal(f.budget.requests,1);assert.equal(f.budget.sessions,1);
  assert.equal(f.sent.filter(e=>e.type==='response.create').length,1);
  assert.equal(f.sent.filter(e=>e.item?.type==='function_call_output').length,0);
  assert.ok(f.sent.find(e=>e.type==='conversation.item.create').item.content.some(c=>c.text===cases[0].input));
  const session=f.sent.find(e=>e.type==='session.update').session;
  assert.equal(session.model,undefined); // model travels in websocket URL, never overridden by harness
  assert.equal((session.voice??session.audio?.output?.voice),'configured-call-voice');assert.deepEqual(session.tools,tools);
  assert.equal(session.enable_search,false);
});
test('each sample has a fresh session; direct completion stays front-only',async()=>{
  const f=fixture('front_only');assert.equal((await run(f)).route,'front_only');await run(f);
  assert.equal(f.budget.sessions,2);assert.equal(f.budget.requests,2);
});
test('physical request budget rejects before sending a model request',async()=>{
  const f=fixture('front_only','nested-audio',0);
  await assert.rejects(run(f),/BUDGET|CLOSE/);assert.equal(f.budget.requests,0);
  assert.equal(f.sent.filter(e=>e.type==='response.create').length,0);
});
test('second response on a single socket is blocked including a tool/retry continuation',()=>{
  class Base {send(){} close(){}}
  const budget={requests:0,sessions:0,limit:200},Socket=budgetedSocket(Base,budget),socket=new Socket();
  socket.send(JSON.stringify({type:'response.create'}));assert.throws(()=>socket.send(JSON.stringify({type:'response.create'})),/BUDGET/);
  assert.equal(budget.requests,1);
});
for(const route of ['error','close','malformed','silent'])test(`failed ${route} session cannot be scored as a model success`,async()=>{
  await assert.rejects(run(fixture(route),cases[0],route==='silent'?30:2000));
});
test('scoring distinguishes routing, parameter contract and intent condition preservation',()=>{
  const sample=cases.find(c=>c.id==='self-03');
  assert.deepEqual(score(sample,{route:'handoff_to_brain',arguments:handoff}),{route_pass:true,contract_pass:true,preservation_pass:true,missing:[]});
  assert.equal(score(sample,{route:'front_only'}).route_pass,false);
  assert.equal(score(sample,{route:'handoff_to_brain',arguments:{...handoff,thinking:'unknown'}}).contract_pass,false);
  assert.equal(score(sample,{route:'handoff_to_brain',arguments:{...handoff,intent:'查记录'}}).preservation_pass,false);
});

test('CLI dry-run reads no key_file and makes no model request or output artifact',()=>{
  const dir=mkdtempSync(join(tmpdir(),'call-handoff-eval-'));
  try {
    const config=join(dir,'config.json'),out=join(dir,'output');
    writeFileSync(config,JSON.stringify({voice_frontend:{...fixture().configuration,endpoint:'${PAIOS_DASHSCOPE_ENDPOINT}',key_file:join(dir,'missing-secret')}}));
    const child=spawnSync(process.execPath,[new URL('./run.mjs',import.meta.url).pathname,'--config',config,'--out',out,'--dry-run','--candidate','exported-candidate'],
      {encoding:'utf8',env:{...process.env,PATH:'/nonexistent',PAIOS_DASHSCOPE_API_KEY:'',PAIOS_DASHSCOPE_ENDPOINT:'wss://offline.invalid'},timeout:15000});
    assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
    assert.equal(result.credential_present,false);assert.equal(result.model_requests,0);
    assert.equal(result.candidate,'exported-candidate');assert.equal(result.planned_sessions,86);assert.equal(result.status,'not_run');assert.equal(existsSync(out),false);
    assert.equal(result.configured.endpoint,'wss://offline.invalid');
    const after=spawnSync(process.execPath,[new URL('./run.mjs',import.meta.url).pathname,'--config',config,'--out',out,'--dry-run','--variant','after'],
      {encoding:'utf8',env:{...process.env,PATH:'/nonexistent',PAIOS_DASHSCOPE_API_KEY:'',PAIOS_DASHSCOPE_ENDPOINT:'wss://offline.invalid'},timeout:15000});
    assert.equal(after.status,0,after.stderr);assert.equal(JSON.parse(after.stdout).planned_sessions,43);assert.deepEqual(JSON.parse(after.stdout).variants,['after']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
