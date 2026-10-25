// Opt-in consumer contract against a producer built from this checkout's lock.
// From the repository root, install the checkout-owned producer and Python environment:
//   bash ci/install.sh gateway
// Then, from this Integration package directory, run:
//   PAIOS_HERMES_REBUILD_DIR=../../../../.scratch/hermes-source \
//   PAIOS_HERMES_PYTHON=../../../../.scratch/hermes-venv/bin/python \
//     node --test tests/native-producer-contract.test.ts
// Without the checkout-owned producer path, the test keeps its prerequisite skip. It uses a local deterministic
// OpenAI-protocol stub to check wire and memory-permission contracts, not model semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HermesClient, NATIVE_RUN_SHAPE_SHA256, type NativeRun} from '../src/hermes-client.ts';
import {sha256} from '../src/contracts.ts';
import {enabledToolSchemas} from '../src/tool-contracts.ts';
import {auxiliaryModelRoles} from '../src/model-settings-contract.ts';

const rebuilt=process.env.PAIOS_HERMES_REBUILD_DIR;
const python=process.env.PAIOS_HERMES_PYTHON ?? '/opt/personal-aios-runtime/hermes-agent/.venv/bin/python';
const repoRoot=fileURLToPath(new URL('../../../../../',import.meta.url));
const skip=!rebuilt ? 'set PAIOS_HERMES_REBUILD_DIR to a verify-producer.mjs --keep rebuild' :
  !existsSync(python) ? `Hermes python ${python} unavailable (PAIOS_HERMES_PYTHON)` : false;
const REPLY='stub reply for producer contract';
const serviceToken='producer-contract-private-service-token';

const modelRequests:{messages?:{role:string;content:unknown}[];tools?:{function?:{name?:string}}[]}[]=[];
function stubModel(internalKey:string):Server {
  return createServer(async(req,res)=>{
    if(req.url?.startsWith('/internal/hermes/tools/')){
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'opened'}));return;
    }
    if(req.url==='/internal/hermes/tool-contracts'){
      if(req.headers.authorization!=='Bearer '+internalKey){res.writeHead(401);res.end();return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(enabledToolSchemas({memory:false})));return;
    }
    let raw=''; for await (const chunk of req) raw+=String(chunk);
    if(req.url?.startsWith('/internal/model-settings/')){
      assert.equal(req.headers.authorization,'Bearer '+serviceToken);
      const body=JSON.parse(raw);
      res.writeHead(200,{'content-type':'application/json'});
      if(req.url.endsWith('/credential')){
        assert.deepEqual(body,{environment_id:'producer-contract',profile:'owner',revision:1,handle:'stub-key-v1'});
        res.end(JSON.stringify({key:'private-stub-key'}));
      }else{assert.equal(req.url,'/internal/model-settings/usage');res.end(JSON.stringify({recorded:true}));}
      return;
    }
    if(req.url?.endsWith('/models')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'stub-model',object:'model'}]}));return;}
    assert.equal(req.headers.authorization,'Bearer private-stub-key');
    const body=JSON.parse(raw||'{}') as {stream?:boolean;messages?:{role:string;content:unknown}[];tools?:{function?:{name?:string}}[]};
    modelRequests.push(body);
    const messages=body.messages ?? [], last=messages.at(-1), user=String([...messages].reverse().find(m=>m.role==='user')?.content ?? '');
    if(user.includes('slow'))await new Promise(resolve=>setTimeout(resolve,20000).unref());
    const budget=user.includes('budget contract probe'),remember=budget ? ['','budget fact'] : /remember: (.+)/u.exec(user);
    const message=budget ? {role:'assistant',content:null,tool_calls:[{id:'call_mem_'+modelRequests.length,type:'function',
      function:{name:'paios_open_reply',arguments:JSON.stringify({reply_mode:'text'})}}]} : {role:'assistant',content:REPLY};
    const reason='tool_calls' in message ? 'tool_calls' : 'stop', usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
    const base={id:'stub',created:1,model:'stub-model'};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message,finish_reason:reason}],usage}));return;}
    const delta='tool_calls' in message ? {...message,tool_calls:message.tool_calls.map((call,index)=>({index,...call}))} : message;
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const part of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:reason}],usage}])
      res.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',...part})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
}
const listen=(server:Server)=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as AddressInfo).port)));
async function freePort():Promise<number> {const probe=createServer(); const port=await listen(probe); await new Promise(r=>probe.close(r)); return port;}
async function until(read:()=>Promise<NativeRun>,done:(run:NativeRun)=>boolean,ms=180000):Promise<NativeRun> {
  const deadline=Date.now()+ms;
  for(;;){const run=await read(); if(done(run))return run; assert.ok(Date.now()<deadline,`timeout: ${JSON.stringify(run).slice(0,400)}`);
    await new Promise(resolve=>setTimeout(resolve,250));}
}
const terminal=(run:NativeRun)=>['completed','failed','cancelled','interrupted'].includes(run.status);

test('real rebuilt producer satisfies HermesClient create/status/replay/read-only-memory/stop',{skip,timeout:600000},async t=>{
  const dir=await realpath(rebuilt!);
  const gate=spawnSync(process.execPath,[join(repoRoot,'integrations/hermes/verify-producer.mjs'),'--check-running',dir],{encoding:'utf8'});
  assert.equal(gate.status,0,`the tree under test must be the locked producer:\n${gate.stderr}`);
  const parent=await mkdtemp(join(tmpdir(),'paios-producer-live-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const home=join(parent,'hermes-home'); await mkdir(home,{mode:0o700}); const profile=await realpath(home);
  await mkdir(join(home,'plugins'),{mode:0o700});
  await symlink(join(repoRoot,'integrations/hermes/personal_aios'),join(home,'plugins/personal_aios'));
  const internalKey='producer-contract-internal-fixture-key';await writeFile(join(home,'internal.key'),internalKey,{mode:0o600});
  const model=stubModel(internalKey); const modelPort=await listen(model);
  t.after(()=>{model.closeAllConnections(); model.close();});
  const baseUrl=`http://127.0.0.1:${modelPort}/v1`,projectionPath=join(home,'model-projection.json');
  const transport={model:{default:'stub-model',provider:'stub',base_url:baseUrl,key_env:'PAIOS_STUB_MODEL_KEY',
    context_length:65536,request_overrides:{max_tokens:128}},
    providers:{stub:{api:baseUrl,transport:'chat_completions',key_env:'PAIOS_STUB_MODEL_KEY'}},fallback_providers:[],
    delegation:{enabled:false},cron:{enabled:false},
    auxiliary:Object.fromEntries([...auxiliaryModelRoles,'call_intent'].map(task=>[task,{enabled:false}]))};
  await writeFile(projectionPath,JSON.stringify({environment_id:'producer-contract',profile:'owner',revision:1,
    group:'brain',configured:true,config:transport,credentials:[{name:'PAIOS_STUB_MODEL_KEY',handle:'stub-key-v1'}]}));
  await writeFile(join(home,'service.key'),serviceToken,{mode:0o600});
  await writeFile(join(home,'config.yaml'),JSON.stringify({...transport,
    model_settings:{environment_id:'producer-contract',profile:'owner',revision:1,group:'brain'},
    secrets:{environment:'profile',personal_aios:{enabled:true,projection:projectionPath}},
    agent:{max_turns:3,api_max_retries:0,auto_recovery_cycles:0},platform_toolsets:{api_server:['memory']},
    memory:{provider:'personal_aios',memory_enabled:false,user_profile_enabled:false},plugins:{entries:{personal_aios:{allow_tool_override:true}}},
    personal_aios:{internal_base_url:`http://127.0.0.1:${modelPort}`,internal_key_file:join(home,'internal.key')},
    compression:{enabled:false},platforms:{api_server:{enabled:true},personal_aios:{enabled:true}}}));
  await mkdir(join(home,'memories'));
  await writeFile(join(home,'memories','MEMORY.md'),'producer fact true');
  await writeFile(join(home,'memories','USER.md'),'');
  const port=await freePort(), key='producer-contract-'+sha256(parent).slice(0,24);
  const env={PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:dir,HERMES_HOME:home,
    API_SERVER_HOST:'127.0.0.1',API_SERVER_PORT:String(port),API_SERVER_KEY:key,PAIOS_MODEL_SETTINGS_PROJECTION:projectionPath,
    PAIOS_MODEL_SETTINGS_SERVICE_URL:`http://127.0.0.1:${modelPort}`,PAIOS_MODEL_SETTINGS_TOKEN_FILE:join(home,'service.key'),NO_PROXY:'127.0.0.1,localhost'};
  // The imported producer is the rebuilt tree, not the venv's editable install.
  const origin=spawnSync(python,['-c','import gateway.platforms.api_server_runs as a, gateway.session_context as b, tools.memory_tool as c\n'+
    'print(a.__file__); print(b.__file__); print(c.__file__)'],{cwd:dir,env,encoding:'utf8'});
  assert.equal(origin.status,0,origin.stderr);
  for(const file of origin.stdout.trim().split('\n'))assert.ok(file.startsWith(dir+'/'),`${file} not imported from ${dir}`);
  const child=spawn(python,[join(repoRoot,'integrations/hermes/personal_aios/run_api.py')],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
  let log=''; child.stdout.on('data',d=>{log+=String(d);}); child.stderr.on('data',d=>{log+=String(d);});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM'); await new Promise(r=>{const k=setTimeout(()=>child.kill('SIGKILL'),10000); child.once('exit',()=>{clearTimeout(k);r(null);});});}});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Hermes did not start:\n'+log)),180000);
    child.stdout.on('data',()=>{if(log.includes('Hermes native API ready')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Hermes exited ${code}:\n${log}`));});
  });
  const client=new HermesClient(`http://127.0.0.1:${port}`,key,60000,1<<20,profile);
  assert.equal(await client.ready(1<<16),true);
  const body=(session_id:string,input:string,_legacyPermission:boolean)=>({input,instructions:'Reply briefly.',session_id});
  const scope=(conversation_session_id:string)=>({conversation_session_id,profile_home:profile});

  const created=await client.create(body('conv-plain','producer contract probe',false),'contract-plain');
  assert.equal(created.schema,'hermes.run.v2'); assert.equal(created.shape_sha256,NATIVE_RUN_SHAPE_SHA256);
  assert.equal(created.profile_home,profile); assert.equal('memory_write' in created,false); assert.equal(created.replayed,false);
  const done=await until(()=>client.status(created.run_id,scope('conv-plain')),terminal);
  assert.equal(done.status,'completed',log); assert.equal(done.output,REPLY);
  assert.equal(done.native_final_response_error,undefined); assert.equal(done.native_final_response?.sha256,sha256(REPLY));
  assert.equal(done.native_final_response?.run_id,created.run_id);
  const replay=await client.create(body('conv-plain','producer contract probe',false),'contract-plain');
  assert.equal(replay.replayed,true); assert.equal(replay.run_id,created.run_id);

  const limited=await client.create(body('conv-budget','budget contract probe',false),'contract-budget');
  const handoff=await until(()=>client.status(limited.run_id,scope('conv-budget')),terminal);
  assert.equal(handoff.status,'failed',log);assert.equal(handoff.turn_exit_reason,'max_iterations_reached(3/3)');
  assert.equal(handoff.output,REPLY);assert.equal(handoff.native_final_response?.sha256,sha256(REPLY));
  assert.equal(handoff.native_final_response?.previous_message_role,'tool');
  assert.equal((await client.status(limited.run_id,scope('conv-budget'))).native_final_response?.message_id,handoff.native_final_response?.message_id);

  assert.ok(modelRequests.every(request=>(request.tools??[]).every(tool=>tool.function?.name!=='memory')));
  // Speaker run scope: a guest on the owner's conversation runs in its own transcript, sees neither the owner's history nor
  // MEMORY.md, is offered no memory tool and cannot write; an uncertain owner gets a fresh transcript with the same binding.
  const seen=modelRequests.length;
  const guest=await client.create({...body('conv-memory-true','remember: guest fact',false),run_scope:'guest',guest_key:'speaker:3:2026-10-09'},'contract-guest');
  assert.deepEqual([guest.run_scope,guest.conversation_session_id],['guest','conv-memory-true']);
  assert.match(guest.session_id!,/^paios-guest-[0-9a-f]{40}$/u);
  assert.equal((await until(()=>client.status(guest.run_id,scope('conv-memory-true')),terminal)).status,'completed',log);
  const guestRequests=modelRequests.slice(seen);
  assert.ok(guestRequests.length>0 && guestRequests.every(request=>!JSON.stringify(request.messages).includes('producer fact true')),'owner history or memory reached a guest');
  assert.ok(guestRequests.every(request=>(request.tools??[]).every(tool=>['web_search','web_extract','paios_open_reply'].includes(tool.function?.name ?? ''))));
  assert.ok(guestRequests.some(request=>JSON.stringify(request.messages).includes('访客模式')));
  const uncertainStart=modelRequests.length;
  const uncertain=await client.create({...body('conv-memory-true','remember: uncertain fact',false),run_scope:'owner_uncertain'},'contract-uncertain');
  assert.deepEqual([uncertain.run_scope,uncertain.conversation_session_id],['owner_uncertain','conv-memory-true']);
  assert.equal(uncertain.session_id,`paios-uncertain-${uncertain.run_id}`);
  assert.equal((await until(()=>client.status(uncertain.run_id,scope('conv-memory-true')),terminal)).status,'completed',log);
  const uncertainRequests=modelRequests.slice(uncertainStart);
  assert.ok(uncertainRequests.length>0 && uncertainRequests.every(request=>!JSON.stringify(request.messages).includes('producer fact true')),
    'owner history or memory reached an uncertain voice');
  const ownerStart=modelRequests.length;
  const owner=await client.create(body('conv-memory-true','confirmed request',true),'contract-confirmed');
  assert.equal((await until(()=>client.status(owner.run_id,scope('conv-memory-true')),terminal)).status,'completed',log);
  const ownerRequests=modelRequests.slice(ownerStart);
  assert.ok(ownerRequests.some(request=>JSON.stringify(request.messages).includes('producer fact true')));
  assert.ok(ownerRequests.every(request=>!JSON.stringify(request.messages).includes('uncertain fact')),'uncertain transcript reached owner history');
  assert.doesNotMatch(readFileSync(join(home,'memories','MEMORY.md'),'utf8'),/guest fact|uncertain fact/u);
  await assert.rejects(client.create({...body('conv-scope-bad','x',true),run_scope:'guest',guest_key:'bad key' },'contract-scope-bad'),
    (error:Error&{code?:string})=>error.code==='HERMES_HTTP_400');

  const slow=await client.create(body('conv-stop','slow contract probe',false),'contract-stop');
  await until(()=>client.status(slow.run_id,scope('conv-stop')),run=>run.status==='running');
  const stopping=await client.cancel(slow.run_id,scope('conv-stop'));
  assert.equal(stopping.run_id,slow.run_id); assert.ok(['stopping','cancelled'].includes(stopping.status),stopping.status);
  assert.equal((await until(()=>client.status(slow.run_id,scope('conv-stop')),terminal)).status,'cancelled');
});
