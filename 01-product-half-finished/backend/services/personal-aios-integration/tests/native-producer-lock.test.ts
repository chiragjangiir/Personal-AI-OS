// Audit R1 producer closure: the single repo lock (upstream pin + native-context.patch) must reproduce exactly the
// producer this consumer pins. These checks tie both sides; they never relax hermes-client.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_RUN_SHAPE_SHA256} from '../src/hermes-client.ts';
import {sha256} from '../src/contracts.ts';

const repoRoot=fileURLToPath(new URL('../../../../../',import.meta.url));
const lockDir=join(repoRoot,'integrations/hermes/personal_aios'), lockPath=join(lockDir,'producer.lock.json');
const verifier=join(repoRoot,'integrations/hermes/verify-producer.mjs');
interface ProducerLock {schema:string;contract:string;upstream:{repository:string;commit:string};patch:{path:string;sha256:string};
  result_tree:string;shape_sha256:string;producer:{publisher:string;shape_schema:string};consumer:{pin:string;shape_schema:string}}
const lock=JSON.parse(readFileSync(lockPath,'utf8')) as ProducerLock;
const patchBytes=readFileSync(join(lockDir,lock.patch.path)), patch=patchBytes.toString('utf8');
const consumerSchema=fileURLToPath(new URL('../src/native-run.shape.schema.json',import.meta.url));

// One section per patched path; hunk bodies only (headers excluded).
function sections(text:string):Map<string,{created:boolean;body:string[]}> {
  const out=new Map<string,{created:boolean;body:string[]}>(); let current:{created:boolean;body:string[];inHunk:boolean}|undefined;
  for(const line of text.split('\n')){
    const header=/^diff --git a\/(\S+) b\/\S+$/u.exec(line);
    if(header){current={created:false,body:[],inHunk:false};out.set(header[1]!,current);continue;}
    if(!current)continue;
    if(!current.inHunk){if(line.startsWith('new file mode'))current.created=true; if(line.startsWith('@@'))current.inHunk=true; continue;}
    current.body.push(line);
  }
  return out;
}
const files=sections(patch);
const addedText=(path:string)=>(files.get(path)?.body ?? []).filter(line=>line.startsWith('+')).map(line=>line.slice(1)).join('\n');
function createdFile(path:string):string {
  const file=files.get(path); assert.ok(file?.created,`${path} must be created by the patch`);
  let out='';
  for(const line of file.body){
    if(line.startsWith('+'))out+=line.slice(1)+'\n';
    else if(line.startsWith('\\ No newline'))out=out.slice(0,-1);
    else if(!line.startsWith('@@') && line!=='')assert.fail(`unexpected line in created ${path}: ${line}`);
  }
  return out;
}

test('lock, consumer pin and consumer schema bytes are one fact',()=>{
  assert.equal(lock.schema,'paios.hermes-producer-lock.v1');
  assert.equal(lock.contract,'hermes.run.v2');
  assert.match(lock.upstream.commit,/^[0-9a-f]{40}$/u); assert.match(lock.result_tree,/^[0-9a-f]{40}$/u);
  assert.equal(lock.shape_sha256,NATIVE_RUN_SHAPE_SHA256);
  assert.equal(join(repoRoot,lock.consumer.shape_schema),consumerSchema);
  assert.equal(sha256(readFileSync(consumerSchema)),lock.shape_sha256);
  const client=readFileSync(join(repoRoot,lock.consumer.pin),'utf8');
  assert.ok(client.includes(`'X-Hermes-Run-Contract':'${lock.contract}'`),'consumer must request the locked contract');
  assert.ok(client.includes(`NATIVE_RUN_SHAPE_SHA256='${lock.shape_sha256}'`));
});

test('the archived patch is the single producer source and carries every contract producer the consumer needs',()=>{
  assert.equal(sha256(patchBytes),lock.patch.sha256);
  assert.deepEqual(readdirSync(lockDir).filter(name=>name.endsWith('.patch')),[lock.patch.path]);
  assert.deepEqual(readdirSync(join(repoRoot,'integrations/hermes')).filter(name=>name.endsWith('.patch')),[]);
  // Shape bytes the producer publishes are byte-identical to the consumer's pinned schema.
  assert.equal(sha256(createdFile(lock.producer.shape_schema)),lock.shape_sha256);
  const publisher=addedText(lock.producer.publisher);
  for(const literal of [`schema="${lock.contract}"`,`shape_sha256="${lock.shape_sha256}"`,'X-Hermes-Run-Contract','memory_receipt_source',
    'api_memory_write_request(body)','bind_api_memory_write(run.run_id'])
    assert.ok(publisher.includes(literal),`publisher hunk lacks ${literal}`);
  assert.match(createdFile('agent/final_response_evidence.py'),/"native_final_response"/u);
  assert.match(addedText('agent/turn_finalizer.py'),/result\["native_final_response"\] = proof/u);
  // memory_write is accepted on the authenticated run body and enforced where native memory is written.
  assert.match(addedText('gateway/session_context.py'),/def api_memory_write_request\(body\)/u);
  assert.match(addedText('tools/memory_tool_store.py'),/api_memory_write_allowed\(\)/u);
  assert.match(createdFile('tools/memory_tool_outcomes.py'),/api_memory_write_allowed\(run_id, session_id\)/u);
  // The speaker run scope the consumer sends for unverified voices is validated, isolated and enforced at dispatch.
  const scope=createdFile('gateway/run_scope.py');
  assert.match(scope,/def run_scope_request\(body, memory_write\)/u); assert.match(scope,/def guest_session_id\(conversation_session_id, guest_key\)/u);
  for(const literal of ['run_scope_request(body, memory_write)','guest_session_id(conversation_session_id, guest_key)','run_scope=run_scope'])
    assert.ok(publisher.includes(literal),`publisher hunk lacks ${literal}`);
  assert.match(scope,/def action_grants/u);
  assert.match(scope,/def bind_action_grants/u);
  assert.match(publisher,/granted_toolsets=granted_toolsets/u);
  assert.match(addedText('tools/environments/ssh.py'),/current_action_grants\(\) &/u);
  assert.match(addedText('agent/tool_executor.py'),/tool_block\(agent, ref\.name\)/u);
  assert.match(addedText('agent/conversation_loop.py'),/restrict_agent\(agent, getattr\(agent, "_paios_run_scope", None\)\)/u);
  assert.match(addedText('gateway/platforms/api_server.py'),/restrict_agent\(agent, run_scope\)/u);
});

const upstreamSource=process.env.PAIOS_HERMES_UPSTREAM_SOURCE ?? '/opt/personal-aios-runtime/hermes-agent';
const rebuildSkip=/^[a-z]+:\/\//u.test(upstreamSource) || existsSync(join(upstreamSource,'.git')) ? false :
  'no Hermes upstream objects; set PAIOS_HERMES_UPSTREAM_SOURCE to a hermes-agent clone or its git URL';
const verify=(...args:string[])=>{
  const run=spawnSync(process.execPath,[verifier,...args],{encoding:'utf8',timeout:600000});
  return {status:run.status,stdout:run.stdout,stderr:run.stderr};
};

test('clean upstream pin + repo patch rebuilds the locked tree, the fixture producer and a gate-accepted checkout',{skip:rebuildSkip},async t=>{
  const parent=await mkdtemp(join(tmpdir(),'paios-producer-')); t.after(()=>rm(parent,{recursive:true,force:true}));
  const kept=join(parent,'hermes-agent');
  const built=verify('--source',upstreamSource,'--keep',kept);
  assert.equal(built.status,0,built.stderr);
  assert.equal((JSON.parse(built.stdout) as {tree:string}).tree,lock.result_tree);
  const provenance=JSON.parse(readFileSync(new URL('./fixtures/native-final-response/provenance.json',import.meta.url),'utf8')) as
    {producer_lock:string;producer_source:string;source_sha256:string;wire:string};
  assert.equal(join(repoRoot,provenance.producer_lock),lockPath); assert.equal(provenance.wire,lock.contract);
  assert.equal(sha256(readFileSync(join(kept,provenance.producer_source))),provenance.source_sha256);
  const accepted=verify('--check-running',kept);
  assert.equal(accepted.status,0,accepted.stderr);
  await writeFile(join(kept,lock.producer.publisher),readFileSync(join(kept,lock.producer.publisher),'utf8')+'\n# drift\n');
  const drift=verify('--check-running',kept);
  assert.equal(drift.status,1); assert.match(drift.stderr,/RUNNING_TREE_DIRTY/u); assert.match(drift.stderr,/--export/u);
});

test('a tampered patch, or one without the shape producer, cannot pass as the locked producer',{skip:rebuildSkip},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'paios-producer-tamper-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const tampered=patch.replace(`shape_sha256="${lock.shape_sha256}"`,`shape_sha256="${'0'.repeat(64)}"`);
  assert.notEqual(tampered,patch);
  await writeFile(join(dir,'producer.lock.json'),JSON.stringify(lock)); await writeFile(join(dir,lock.patch.path),tampered);
  const result=verify('--source',upstreamSource,'--lock',join(dir,'producer.lock.json'));
  assert.equal(result.status,1);
  for(const code of ['PATCH_SHA_MISMATCH','REBUILT_TREE_MISMATCH','PRODUCER_CONTRACT_MISSING'])assert.match(result.stderr,new RegExp(code,'u'));
  // A self-consistent lock whose patch omits the shape producer is still refused.
  const old=patch.split('\ndiff --git ').filter(part=>!part.includes('native-run.shape.schema.json')).join('\ndiff --git ');
  await writeFile(join(dir,lock.patch.path),old);
  await writeFile(join(dir,'producer.lock.json'),JSON.stringify({...lock,patch:{...lock.patch,sha256:sha256(old)}}));
  const partial=verify('--source',upstreamSource,'--lock',join(dir,'producer.lock.json'));
  assert.equal(partial.status,1); assert.match(partial.stderr,/REBUILT_TREE_MISMATCH/u); assert.match(partial.stderr,/PRODUCER_SHAPE_MISMATCH/u);
});
