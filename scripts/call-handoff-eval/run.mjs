import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {cases} from './cases.mjs';
import {baseline} from './baseline.mjs';
import {baselineVariant,budgetedSocket,runCase,score} from './transport.mjs';
import {loadHostConfiguration} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/host-configuration.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2), arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const configPath=arg('--config'),out=arg('--out');
const variant=arg('--variant')??'both';
if(!['before','after','both'].includes(variant))throw Error('EVAL_VARIANT_INVALID');
const variantNames=variant==='both'?['before','after']:[variant];
if(!configPath||!out)throw Error('Usage: node scripts/call-handoff-eval/run.mjs --config CONFIG --out NEW_DIRECTORY [--key-env ENV]');
if(existsSync(out))throw Error('EVAL_OUTPUT_ALREADY_EXISTS: choose a new directory');
const config=await loadHostConfiguration(configPath),voice=config.voice_frontend;
if(!voice)throw Error('EVAL_VOICE_FRONTEND_REQUIRED');
// Credentials come only from the selected environment variable; never open config key_file.
const keyEnv=arg('--key-env')??'PAIOS_DASHSCOPE_API_KEY';
const apiKey=process.env[keyEnv];
if(!apiKey&&!args.includes('--dry-run'))throw Error('EVAL_CREDENTIAL_MISSING');
const gateway='01-product-half-finished/backend/phase0/gateway/src/';
const {dispose}=await import(pathToFileURL(createRequire(new URL('../../'+gateway+'../package.json',import.meta.url)).resolve('@livekit/rtc-node')).href);
const callPath='integrations/hermes/personal_aios/persona/yimi-call.md';
const [{frontInstructions,CALL_OBSERVE_TOOL},{CALL_HANDOFF_TOOL,CALL_SEARCH_TOOL},{createQwenVoiceResources},{WebSocket}]=await Promise.all([
  import(new URL('../../'+gateway+'voice-call-session.ts',import.meta.url)),
  import(new URL('../../'+gateway+'call-handoff.ts',import.meta.url)),
  import('../../01-product-half-finished/backend/services/personal-aios-integration/src/voice/qwen-resources.mjs'),
  import('../../01-product-half-finished/backend/services/qwen-embedded/server/src/voice/node-websocket.mjs'),
]);
const after=frontInstructions({identity:'owner',context:'主人喜欢散步。最近在聊旅行。'});
const before=baselineVariant(after,readFileSync(join(root,callPath),'utf8').trim(),baseline.call,
  CALL_HANDOFF_TOOL,baseline.description);
const variants={before,after:{instructions:after,tool:CALL_HANDOFF_TOOL}};
const budget={requests:0,sessions:0,limit:200};
const configuration={...voice,usable:true,apiKey,WebSocket:budgetedSocket(WebSocket,budget)};
const selected=voice.call?{model:voice.call.model,voice:voice.call.voice,dialect:voice.call.dialect??voice.dialect}:voice;
const manifest={baseline:baseline.revision,candidate:arg('--candidate')??process.env.PAIOS_CANDIDATE_SHA??null,input:'synthetic-owner-transcript-over-production-realtime-websocket',
  configured:{model:selected.model,voice:selected.voice,dialect:selected.dialect,region:voice.region,endpoint:voice.endpoint},
  key_env:keyEnv,credential_present:Boolean(apiKey),
  cases:cases.length,variants:variantNames,planned_sessions:cases.length*variantNames.length,budget_limit:budget.limit,
  search_tool_enabled:voice.call?.session_options?.enable_search!==false,
  scope:'First routing decision only; no real search, main-agent execution, microphone, ASR, or device acceptance.'};
if(args.includes('--dry-run')) {
  console.log(JSON.stringify({...manifest,status:'not_run',model_requests:0},null,2));
  dispose();process.exit(0);
}
mkdirSync(out,{recursive:true});
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
// Preserve the exact treatment and synthetic labels for review when the working tree is dirty.
writeFileSync(join(out,'inputs.json'),JSON.stringify({variants,cases},null,2));
const rows=[];
try {
  for(const [i,sample] of cases.entries()) {
    // Alternate ordering to reduce systematic time-order bias, while keeping each session isolated.
    for(const name of i%2?[...variantNames].reverse():variantNames) {
      const variant=variants[name];
      const result=await runCase({createResources:createQwenVoiceResources,configuration,instructions:variant.instructions,
        tools:[variant.tool,...(name==='after'?[CALL_OBSERVE_TOOL]:[]),...(voice.call?.session_options?.enable_search===false?[]:[CALL_SEARCH_TOOL])],sample});
      const row={id:sample.id,variant:name,expected:sample.expected,...result,...score(sample,result)};
      rows.push(row);writeFileSync(join(out,'results.json'),JSON.stringify(rows,null,2));
      console.log(JSON.stringify({id:sample.id,variant:name,route:result.route,route_pass:row.route_pass,requests:budget.requests}));
    }
  }
} catch(error) {
  writeFileSync(join(out,'failure.json'),JSON.stringify({message:String(error.message).replaceAll(apiKey,'[redacted]'),budget,completed:rows.length},null,2));
  throw Error('EVAL_FAILED: inspect failure.json; no automatic retry');
} finally {
  const summary=Object.fromEntries(['before','after'].map(name=>{
    const group=rows.filter(row=>row.variant===name);
    return [name,{completed:group.length,route_pass:group.filter(r=>r.route_pass).length,
      contract_pass:group.filter(r=>r.contract_pass).length,preservation_pass:group.filter(r=>r.preservation_pass).length,
      by_expected:Object.fromEntries(['handoff_to_brain','front_only','web_search','observe_call_turn'].map(route=>{
        const subset=group.filter(r=>r.expected===route);return [route,{total:subset.length,passed:subset.filter(r=>r.route_pass).length}];
      }))}];
  }));
  const paired=cases.map(sample=>{const pair=rows.filter(r=>r.id===sample.id);
    return {id:sample.id,before:pair.find(r=>r.variant==='before')?.route,after:pair.find(r=>r.variant==='after')?.route};});
  writeFileSync(join(out,'summary.json'),JSON.stringify({complete:rows.length===cases.length*variantNames.length,budget,summary,paired},null,2));
  if(rows.some(r=>r.variant==='after'&&(!r.route_pass||!r.contract_pass)))process.exitCode=1;
  // frontInstructions imports the native RTC module transitively; release its worker resources.
  dispose();
}
