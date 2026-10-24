import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createRealtimePublicOperationReceipts} from '../src/realtime-public-operation-receipts.ts';
const url=process.env.PAIOS_PG_TEST_URL??'postgresql://l3test@127.0.0.1:55439/postgres';
const input=(key:string,operation='bootstrap')=>({request:{operation,request_id:key,idempotency_context:{idempotency_key:key}},bearer:{principal:'synthetic-owner',deviceId:'synthetic-mac'}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const error=()=>Object.assign(new Error('CONTROLLED_NO_EFFECT'),{code:'CONTROLLED_NO_EFFECT',status:503});
test('original T02 ledger stores proven no-effect and unknown; cold exact replay, concurrency and failure publication preserve authority',{timeout:60000},async()=>{
 const schema='public_receipts_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:'-c search_path='+schema});
 try {
  await admin.query('CREATE SCHEMA '+schema);
  const migration=await readFile(new URL('../../../migrations/0001_idempotency_outbox.up.sql',import.meta.url),'utf8');await pool.query(migration.slice(0,migration.indexOf('CREATE TABLE IF NOT EXISTS outbox_events'))+'COMMIT;');
  const owner=createRealtimePublicOperationReceipts(pool);let calls=0;
  for(const operation of ['bootstrap','media_stop','handoff']) {
   const request=input('no-effect-'+operation,operation);
   await assert.rejects(owner.execute(request,async()=>{calls++;throw error();},undefined,'v1'),e=>(e as {operation_outcome:string}).operation_outcome==='not_executed');
   assert.equal((await owner.read(request))?.status,'failed');
   if(operation==='bootstrap'){const worker=`import {createRequire} from 'node:module';import {createRealtimePublicOperationReceipts} from ${JSON.stringify(new URL('../src/realtime-public-operation-receipts.ts',import.meta.url).href)};const {Pool}=createRequire(${JSON.stringify(new URL('../package.json',import.meta.url).href)})('pg');const pool=new Pool({connectionString:${JSON.stringify(url)},options:'-c search_path='+process.argv[1]});const owner=createRealtimePublicOperationReceipts(pool);try{await owner.execute(JSON.parse(process.argv[2]),async()=>{throw new Error('REEXECUTED');});}catch(e){process.stdout.write(JSON.stringify({message:e.message,outcome:e.operation_outcome,status:(await owner.read(JSON.parse(process.argv[2]))).status}));}finally{await pool.end();}`;const actual=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',worker,schema,JSON.stringify(request)],{encoding:'utf8',timeout:5000}));assert.deepEqual(actual,{message:'CONTROLLED_NO_EFFECT',outcome:'not_executed',status:'failed'});}
   const cold=createRealtimePublicOperationReceipts(pool);await assert.rejects(cold.execute(request,async()=>{throw new Error('REEXECUTED');},async()=>{throw new Error('REAUTHORIZED');}),{message:'CONTROLLED_NO_EFFECT',code:'CONTROLLED_NO_EFFECT',status:503});
   await assert.rejects(cold.read({...request,bearer:{...request.bearer,deviceId:'other'}}),/IDEMPOTENCY_CONFLICT/);
   await assert.rejects(cold.execute({...request,request:{...request.request,request_id:'changed'}},async()=>({})),/IDEMPOTENCY_CONFLICT/);
   let retryCalls=0;const result=await cold.execute(request,async begin=>{retryCalls++;begin();return {operation,status:'controlled_complete'};},async()=>{},'v1','not_executed_v1');assert.deepEqual(result,{operation,status:'controlled_complete'});assert.equal(retryCalls,1);assert.equal((await cold.read(request))?.status,'committed');assert.deepEqual(await cold.execute(request,async()=>{throw new Error('SUCCESS_REEXECUTED');}),result);
   const receipt=(await cold.read(request))!.response as {prior_not_executed:unknown[]};assert.equal(receipt.prior_not_executed.length,1);
  }
  assert.equal(calls,3);
  const replayWorker=`import {createRequire} from 'node:module';import {createRealtimePublicOperationReceipts} from ${JSON.stringify(new URL('../src/realtime-public-operation-receipts.ts',import.meta.url).href)};const {Pool}=createRequire(${JSON.stringify(new URL('../package.json',import.meta.url).href)})('pg');const pool=new Pool({connectionString:${JSON.stringify(url)},options:'-c search_path='+process.argv[1]});try{const result=await createRealtimePublicOperationReceipts(pool).execute(JSON.parse(process.argv[2]),async()=>{throw new Error('REEXECUTED');});process.stdout.write(JSON.stringify(result));}finally{await pool.end();}`;assert.deepEqual(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',replayWorker,schema,JSON.stringify(input('no-effect-bootstrap'))],{encoding:'utf8',timeout:5000})),{operation:'bootstrap',status:'controlled_complete'});
  for(const legacy of [true,false]) {
   const request=input('unknown-'+legacy);await assert.rejects(owner.execute(request,async begin=>{if(!legacy)begin();throw Object.assign(new Error('UNPROVEN_401'),{code:'UNPROVEN_401',status:401});},undefined,legacy?undefined:'v1'),e=>(e as {operation_outcome:string}).operation_outcome==='unknown');
   assert.equal((await owner.read(request))?.status,'indeterminate');await assert.rejects(owner.execute(request,async()=>{throw new Error('REEXECUTED');},async()=>{},'v1','not_executed_v1'),{message:'UNPROVEN_401',status:401});
  }
  const deniedInput=input('retry-denied');await assert.rejects(owner.execute(deniedInput,async()=>{throw error();},undefined,'v1'));const deniedBefore=await owner.read(deniedInput);let deniedCalls=0;await assert.rejects(owner.execute(deniedInput,async()=>{deniedCalls++;return {};},async()=>{throw new Error('CURRENT_T03_DENIED');},'v1','not_executed_v1'),/CURRENT_T03_DENIED/);assert.deepEqual(await owner.read(deniedInput),deniedBefore);assert.equal(deniedCalls,0);
  const budgetInput=input('bounded-retry');await assert.rejects(owner.execute(budgetInput,async()=>{throw error();},undefined,'v1'));for(let attempt=0;attempt<8;attempt++)await assert.rejects(owner.execute(budgetInput,async()=>{throw error();},async()=>{},'v1','not_executed_v1'),{message:'CONTROLLED_NO_EFFECT'});let excessEffects=0;await assert.rejects(owner.execute(budgetInput,async()=>{excessEffects++;return {};},async()=>{},'v1','not_executed_v1'),{code:'PUBLIC_OPERATION_RETRY_BUDGET',status:429});assert.equal(excessEffects,0);assert.equal((await owner.read(budgetInput))?.status,'failed');
  const retryUnknown=input('retry-becomes-unknown');await assert.rejects(owner.execute(retryUnknown,async()=>{throw error();},undefined,'v1'));await assert.rejects(owner.execute(retryUnknown,async begin=>{begin();throw new Error('RETRY_EFFECT_UNKNOWN');},async()=>{},'v1','not_executed_v1'),e=>(e as {operation_outcome:string}).operation_outcome==='unknown');assert.equal((await owner.read(retryUnknown))?.status,'indeterminate');await assert.rejects(owner.execute(retryUnknown,async()=>{throw new Error('REEXECUTED');},async()=>{},'v1','not_executed_v1'),{message:'RETRY_EFFECT_UNKNOWN'});
  const terminalInput=input('terminal-error','handoff'),terminal={operation:'handoff',status:'indeterminate',synthetic:true};await assert.rejects(owner.execute(terminalInput,async begin=>{begin();throw Object.assign(new Error('TERMINAL_FAILURE'),{code:'TERMINAL_FAILURE',status:503,terminalResult:terminal});},undefined,'v1'),e=>JSON.stringify((e as {terminalResult:unknown}).terminalResult)===JSON.stringify(terminal));await assert.rejects(createRealtimePublicOperationReceipts(pool).execute(terminalInput,async()=>{throw new Error('REEXECUTED');}),e=>JSON.stringify((e as {terminalResult:unknown}).terminalResult)===JSON.stringify(terminal));assert.equal((await owner.read(terminalInput))?.status,'indeterminate');
  // An idempotent operation (media stop) re-runs after an unknown outcome under its own effect authority; others replay it.
  const idem=input('idempotent-unknown','media_stop');let idemCalls=0;
  await assert.rejects(owner.execute(idem,async begin=>{idemCalls++;begin();throw Object.assign(new Error('STAGE_FAILED'),{code:'STAGE_FAILED',status:503});},async()=>{},'v1','idempotent_effect_v1'),e=>(e as {operation_outcome:string}).operation_outcome==='unknown');
  assert.equal((await owner.read(idem))?.status,'indeterminate');
  await assert.rejects(owner.execute(idem,async()=>{throw new Error('REEXECUTED');},async()=>{},'v1','not_executed_v1'),{message:'STAGE_FAILED'});
  let idemDenied=0;await assert.rejects(owner.execute(idem,async()=>{idemDenied++;return {};},async()=>{throw new Error('CURRENT_DENIED');},'v1','idempotent_effect_v1'),/CURRENT_DENIED/);assert.equal(idemDenied,0);
  assert.deepEqual(await owner.execute(idem,async begin=>{idemCalls++;begin();return {operation:'media_stop',status:'success'};},async()=>{},'v1','idempotent_effect_v1'),{operation:'media_stop',status:'success'});
  assert.equal(idemCalls,2);assert.equal((await owner.read(idem))?.status,'committed');
  assert.deepEqual(await owner.execute(idem,async()=>{throw new Error('SUCCESS_REEXECUTED');},async()=>{},'v1','idempotent_effect_v1'),{operation:'media_stop',status:'success'});
  const entered=deferred(),release=deferred(),request=input('concurrent');
  const pending=owner.execute(request,async begin=>{begin();entered.resolve();await release.promise;return {ok:true};},undefined,'v1');await entered.promise;
  await assert.rejects(owner.execute(request,async()=>{throw new Error('DUPLICATE_EFFECT');}),/PUBLIC_OPERATION_RECEIPT_IN_FLIGHT/);assert.equal((await owner.read(request))?.status,'in_flight');release.resolve();assert.deepEqual(await pending,{ok:true});
  const retryInput=input('retry-concurrent');await assert.rejects(owner.execute(retryInput,async()=>{throw error();},undefined,'v1'));const retryEntered=deferred(),retryRelease=deferred();let retryEffects=0;const retryWinner=owner.execute(retryInput,async begin=>{retryEffects++;begin();retryEntered.resolve();await retryRelease.promise;return {recovered:true};},async()=>{},'v1','not_executed_v1');await retryEntered.promise;await assert.rejects(owner.execute(retryInput,async()=>{retryEffects++;return {};},async()=>{},'v1','not_executed_v1'),/PUBLIC_OPERATION_RECEIPT_IN_FLIGHT/);retryRelease.resolve();await retryWinner;assert.equal(retryEffects,1);
  const raceInput=input('retry-cas-race');await assert.rejects(owner.execute(raceInput,async()=>{throw error();},undefined,'v1'));let authorizations=0,raceEffects=0;const bothAuth=deferred(),authRelease=deferred(),effectEntered=deferred(),effectRelease=deferred();const auth=async()=>{if(++authorizations===2)bothAuth.resolve();await authRelease.promise;};const work=async(begin:()=>void)=>{raceEffects++;begin();effectEntered.resolve();await effectRelease.promise;return {race:true};};const races=[owner.execute(raceInput,work,auth,'v1','not_executed_v1'),createRealtimePublicOperationReceipts(pool).execute(raceInput,work,auth,'v1','not_executed_v1')];const raced=Promise.allSettled(races);await bothAuth.promise;authRelease.resolve();await effectEntered.promise;effectRelease.resolve();const outcomes=await raced;assert.equal(raceEffects,1);assert(outcomes.some(x=>x.status==='fulfilled'));assert(outcomes.every(x=>x.status==='fulfilled'||String(x.reason).includes('IN_FLIGHT')));
  let fail=true;
  const faulty={connect:async()=>{const client=await pool.connect();return {query:async(sql:string,...args:unknown[])=>{if(fail&&sql.startsWith('UPDATE idempotency_ledger SET status'))throw new Error('CONTROLLED_RECEIPT_EIO');return (client.query as Function)(sql,...args);},release:()=>client.release()};}} as unknown as Pool;
  const broken=createRealtimePublicOperationReceipts(faulty),brokenInput=input('receipt-write-failure');
  await assert.rejects(broken.execute(brokenInput,async()=>{throw error();},undefined,'v1'),e=>e instanceof AggregateError&&String(e.cause).includes('CONTROLLED_NO_EFFECT'));
  // The failure is known to this process although its receipt did not land: another process sees a live claim, and
  // this process's next retry persists the known failure instead of answering IN_FLIGHT forever or re-running it.
  assert.equal((await owner.read(brokenInput))?.status,'in_flight');fail=false;await assert.rejects(owner.execute(brokenInput,async()=>{throw new Error('REEXECUTED');}),/PUBLIC_OPERATION_RECEIPT_IN_FLIGHT/);
  await assert.rejects(broken.execute(brokenInput,async()=>{throw new Error('REEXECUTED');}),{message:'CONTROLLED_NO_EFFECT',code:'CONTROLLED_NO_EFFECT'});assert.equal((await owner.read(brokenInput))?.status,'failed');
  let lose=true;
  const lossy={connect:async()=>{const client=await pool.connect();let terminal=false;return {query:async(sql:string,...args:unknown[])=>{if(sql.startsWith('UPDATE idempotency_ledger SET status'))terminal=true;const result=await (client.query as Function)(sql,...args);if(lose&&terminal&&sql==='COMMIT'){lose=false;throw new Error('LOST_COMMIT_REPLY');}return result;},release:()=>client.release()};}} as unknown as Pool;
  const lostInput=input('lost-terminal-commit');await assert.rejects(createRealtimePublicOperationReceipts(lossy).execute(lostInput,async()=>{throw error();},undefined,'v1'),{message:'CONTROLLED_NO_EFFECT'});assert.equal((await owner.read(lostInput))?.status,'failed');
  const casInput=input('lost-cas-commit');await assert.rejects(owner.execute(casInput,async()=>{throw error();},undefined,'v1'));let loseCas=true,casEffects=0;const lossyCas:Pool={connect:async()=>{const client=await pool.connect();let cas=false;return {query:async(sql:string,...args:unknown[])=>{if(sql.startsWith("UPDATE idempotency_ledger SET status='in_flight'"))cas=true;const result=await (client.query as Function)(sql,...args);if(loseCas&&cas&&sql==='COMMIT'){loseCas=false;throw new Error('LOST_CAS_REPLY');}return result;},release:()=>client.release()};}} as unknown as Pool;const casOwner=createRealtimePublicOperationReceipts(lossyCas);await assert.rejects(casOwner.execute(casInput,async()=>{casEffects++;return {};},async()=>{},'v1','not_executed_v1'),/POSTGRES_TRANSACTION_COMMIT/);assert.equal(casEffects,0);assert.equal((await owner.read(casInput))?.status,'in_flight');await assert.rejects(owner.execute(casInput,async()=>{casEffects++;return {};},async()=>{},'v1','not_executed_v1'),/IN_FLIGHT/);assert.equal(casEffects,0);
  // The claim's own process knows no attempt of its runs it any more: it recovers the claim at once and runs once.
  assert.deepEqual(await casOwner.execute(casInput,async()=>{casEffects++;return {recovered:'cas'};},async()=>{},'v1','not_executed_v1'),{recovered:'cas'});assert.equal(casEffects,1);assert.equal((await owner.read(casInput))?.status,'committed');
 } finally {await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');const remaining=(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rows.length;assert.equal(remaining,0);console.log(JSON.stringify({schema,cleanup_readback_remaining:remaining,host:'127.0.0.1',port:55439,database:'postgres',role:'l3test'}));await admin.end();}
});
test('a claim whose attempt died is recovered: crash, lost receipt write, lost receipt reply, legacy claim; stragglers are fenced',{timeout:60000},async()=>{
 const schema='public_receipts_rec_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:'-c search_path='+schema});
 try {
  await admin.query('CREATE SCHEMA '+schema);
  const migration=await readFile(new URL('../../../migrations/0001_idempotency_outbox.up.sql',import.meta.url),'utf8');await pool.query(migration.slice(0,migration.indexOf('CREATE TABLE IF NOT EXISTS outbox_events'))+'COMMIT;');
  const settle=()=>new Promise(resolve=>setTimeout(resolve,1300));
  // 1. The gateway process dies after its claim committed and before any receipt (real child process exit).
  for(const [operation,retry] of [['bootstrap','not_executed_v1'],['media_stop','idempotent_effect_v1'],['handoff','not_executed_v1']] as const) {
   const request=input('crash-'+operation,operation);
   const worker=`import {createRequire} from 'node:module';import {createRealtimePublicOperationReceipts} from ${JSON.stringify(new URL('../src/realtime-public-operation-receipts.ts',import.meta.url).href)};const {Pool}=createRequire(${JSON.stringify(new URL('../package.json',import.meta.url).href)})('pg');const pool=new Pool({connectionString:${JSON.stringify(url)},options:'-c search_path='+process.argv[1]});await createRealtimePublicOperationReceipts(pool).execute(JSON.parse(process.argv[2]),async begin=>{begin();process.exit(0);},async()=>{},'v1',process.argv[3]);`;
   execFileSync(process.execPath,['--input-type=module','-e',worker,schema,JSON.stringify(request),retry],{encoding:'utf8',timeout:10000});
   const restarted=createRealtimePublicOperationReceipts(pool,{staleClaimSeconds:1});let effects=0;
   assert.equal((await restarted.read(request))?.status,'in_flight');
   await assert.rejects(restarted.execute(request,async()=>{effects++;return {};},async()=>{},'v1',retry),/IN_FLIGHT/,'a fresh claim may still be live: never stolen');
   await settle();
   assert.deepEqual(await restarted.execute(request,async begin=>{effects++;begin();return {operation,status:'recovered'};},async()=>{},'v1',retry),{operation,status:'recovered'});
   assert.equal(effects,1);assert.equal((await restarted.read(request))?.status,'committed');
   assert.deepEqual(await createRealtimePublicOperationReceipts(pool).execute(request,async()=>{throw new Error('REEXECUTED');}),{operation,status:'recovered'});
  }
  // 2. A recovered attempt that fails records an explicit unknown outcome, not a permanent claim; Stop then re-runs.
  const unknownStop=input('crash-then-fail','media_stop');const dead=deferred();
  void createRealtimePublicOperationReceipts(pool).execute(unknownStop,async begin=>{begin();await dead.promise;return {};},async()=>{},'v1','idempotent_effect_v1').catch(()=>undefined);
  await new Promise(resolve=>setTimeout(resolve,100));await settle();
  const recoverer=createRealtimePublicOperationReceipts(pool,{staleClaimSeconds:1});
  await assert.rejects(recoverer.execute(unknownStop,async()=>{throw Object.assign(new Error('T11B_ADAPTER_IDEMPOTENCY_IN_FLIGHT'),{code:'T11B_ADAPTER_IDEMPOTENCY_IN_FLIGHT',status:503});},async()=>{},'v1','idempotent_effect_v1'),e=>(e as {operation_outcome:string}).operation_outcome==='unknown');
  assert.equal((await recoverer.read(unknownStop))?.status,'indeterminate');
  assert.deepEqual(await recoverer.execute(unknownStop,async()=>({operation:'media_stop',status:'success'}),async()=>{},'v1','idempotent_effect_v1'),{operation:'media_stop',status:'success'});
  // The dead attempt's straggler cannot overwrite the recovered terminal: its token no longer holds the claim.
  const stragglerStop=input('straggler','media_stop');const late=deferred();let stragglerDone:Promise<unknown>|undefined;
  stragglerDone=createRealtimePublicOperationReceipts(pool).execute(stragglerStop,async begin=>{begin();await late.promise;return {operation:'media_stop',status:'straggler'};},async()=>{},'v1','idempotent_effect_v1').then(()=>'resolved',e=>String((e as Error).message));
  await new Promise(resolve=>setTimeout(resolve,100));await settle();
  assert.deepEqual(await recoverer.execute(stragglerStop,async()=>({operation:'media_stop',status:'recovered'}),async()=>{},'v1','idempotent_effect_v1'),{operation:'media_stop',status:'recovered'});
  late.resolve();assert.match(String(await stragglerDone),/RECEIPT_UNSAVED/);
  assert.deepEqual((await recoverer.read(stragglerStop))?.response,{operation:'media_stop',status:'recovered'});
  // 3. The effect completed but the receipt write failed: the same process persists that known result on retry.
  let failWrite=true;
  const flaky={connect:async()=>{const client=await pool.connect();return {query:async(sql:string,...args:unknown[])=>{if(failWrite&&sql.startsWith('UPDATE idempotency_ledger SET status'))throw new Error('CONTROLLED_RECEIPT_EIO');return (client.query as Function)(sql,...args);},release:()=>client.release()};}} as unknown as Pool;
  const flakyOwner=createRealtimePublicOperationReceipts(flaky),written=input('effect-done-receipt-lost');let writes=0;
  await assert.rejects(flakyOwner.execute(written,async begin=>{writes++;begin();return {operation:'bootstrap',status:'bootstrap_accepted'};},async()=>{},'v1'),{code:'PUBLIC_OPERATION_RECEIPT_UNSAVED',status:503});
  assert.equal((await flakyOwner.read(written))?.status,'in_flight');
  await assert.rejects(flakyOwner.execute(written,async()=>{writes++;return {};},async()=>{},'v1'),{code:'PUBLIC_OPERATION_RECEIPT_UNSAVED'},'still unwritable: nothing re-runs');
  failWrite=false;
  assert.deepEqual(await flakyOwner.execute(written,async()=>{writes++;return {};},async()=>{},'v1'),{operation:'bootstrap',status:'bootstrap_accepted'});
  assert.equal(writes,1,'the known result is persisted, the bootstrap is not executed again');assert.equal((await flakyOwner.read(written))?.status,'committed');
  // 4. The receipt COMMIT landed but its reply was lost: the result is returned, not an error.
  let loseReply=true;
  const lossy={connect:async()=>{const client=await pool.connect();let terminal=false;return {query:async(sql:string,...args:unknown[])=>{if(sql.startsWith('UPDATE idempotency_ledger SET status'))terminal=true;const result=await (client.query as Function)(sql,...args);if(loseReply&&terminal&&sql==='COMMIT'){loseReply=false;throw new Error('LOST_COMMIT_REPLY');}return result;},release:()=>client.release()};}} as unknown as Pool;
  const lostReply=input('receipt-reply-lost','handoff');
  assert.deepEqual(await createRealtimePublicOperationReceipts(lossy).execute(lostReply,async()=>({operation:'handoff',status:'success'}),async()=>{},'v1'),{operation:'handoff',status:'success'});
  // 5. A claim written before claims carried an owner (stuck since an older gateway) is recovered once stale.
  const legacy=input('legacy-claim','media_stop');
  await pool.query("INSERT INTO idempotency_ledger (scope,idempotency_key,request_hash,status,claimed_at,created_at,updated_at) VALUES ('realtime.public.complete.media_stop','legacy-claim',$1,'in_flight',now()-interval '1 hour',now(),now())",[(await import('../src/idempotency-ledger.ts')).jsonHash({request:legacy.request,identity:{principal:legacy.bearer.principal,device_id:legacy.bearer.deviceId}})]);
  assert.deepEqual(await createRealtimePublicOperationReceipts(pool).execute(legacy,async()=>({operation:'media_stop',status:'success'}),async()=>{},'v1','idempotent_effect_v1'),{operation:'media_stop',status:'success'});
 } finally {await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
