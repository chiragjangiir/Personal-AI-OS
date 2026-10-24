import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPairedTerminalAuthorities} from '../src/paired-device-authority.ts';
import {createPersistentPublicExecutionHost,createPersistentPublicExecutionOwner} from '../src/persistent-public-execution-owner.ts';
import {HermesClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';

const USER='01952f00-0000-7000-8000-000000000501',DEVICE='01952f00-0000-7000-8000-000000000502';
function database(){
  const rows:Record<string,unknown>[]=[],queries:string[]=[];
  let releases=0;
  const query=async(sql:string)=>{queries.push(sql);return {rows:sql.includes('FROM paired_devices')?rows:[]};};
  const pool={query,connect:async()=>({query,on(){},removeListener(){},release(){releases++;}})};
  return {rows,queries,pool,releases:()=>releases};
}
const paired=()=>({device_id:DEVICE,user_id:USER,device_class:'iphone',paired_at:'2026-10-23T00:00:00.000Z',
  recipient_public_key:'A'.repeat(43),device_credential_ref:{},media:['data'],
  governance:{purpose_scopes:['cycling_assistant'],consent_record_refs:[{ref_id:'c'}],policy_decision_refs:[{ref_id:'p'}],
    purpose_token_refs:[{ref_id:'t'}],capability_grant_refs:[{ref_id:'g'}]}});

test('fresh owner starts with zero devices; restart loads the real pairing and enforces the same owner',async()=>{
  const db=database();
  const empty=await createPairedTerminalAuthorities({pool:db.pool as never,ownerUserId:USER});
  assert.deepEqual(empty.terminals,[]);assert.equal(empty.readiness.isReady(),true);
  assert.equal(empty.readiness.current().bound,false);assert.equal(empty.readiness.current().closed,false);
  assert.equal(await empty.bearer.resolve({tokenSha256:'unknown',operation:'bootstrap'}),undefined);
  assert.throws(()=>empty.forDevice(DEVICE),/PAIRED_DEVICE_REQUIRED/);
  assert.equal(db.queries.some(sql=>/INSERT|UPDATE|DELETE/.test(sql)),false);
  await empty.close();assert.equal(db.releases(),1);
  assert.equal(empty.readiness.isReady(),false);assert.equal(empty.bearer.isReady(),false);
  assert.throws(()=>empty.readiness.assertReady(),/PAIRED_DEVICE_AUTHORITY_NOT_READY/);
  db.rows.push(paired());
  const restored=await createPairedTerminalAuthorities({pool:db.pool as never,ownerUserId:USER});
  assert.equal(restored.terminals.length,1);assert.equal(restored.forDevice(DEVICE).readCurrentAuthority().userId,USER);
  await restored.close();assert.equal(db.releases(),2);
  await assert.rejects(createPairedTerminalAuthorities({pool:db.pool as never,ownerUserId:'other'}),/PAIRED_DEVICE_OWNER_MISMATCH/);
});

function resources(root:string){
  return {storage:new PosixStorage(root),native:new HermesClient('http://127.0.0.1:1','synthetic-internal-token-0001',1000,8192),
    admission:{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:60000,poll_interval_ms:5,
      native_idempotency_retention_ms:60000,policy_version:'first-run'},skill:'first-run',max_event_bytes:8192,max_read_bytes:8192,
    http:{internal_token:'synthetic-internal-token-0001',max_request_bytes:8192,request_timeout_ms:1000}};
}

test('one real host assembly serves before pairing and is reused by the terminal owner',async()=>{
  const root=await mkdtemp(join(tmpdir(),'paios-unpaired-host-')),db=database(),errors:unknown[]=[];
  const central=resources(root);
  const host=await createPersistentPublicExecutionHost({executionOwner:'hermes_text',central,onError:error=>errors.push(error)});
  let terminal:Awaited<ReturnType<typeof createPersistentPublicExecutionOwner>>|undefined;
  let devices:Awaited<ReturnType<typeof createPairedTerminalAuthorities>>|undefined;
  try {
    assert.equal(host.terminals.size,0);assert.deepEqual(host.assembly.runtime.terminals(USER),[]);
    await new Promise<void>(resolve=>host.assembly.server.listen(0,'127.0.0.1',resolve));
    const address=host.assembly.server.address();assert.ok(address&&typeof address==='object');
    const response=await fetch(`http://127.0.0.1:${address.port}/health`);assert.equal(response.status,200);
    db.rows.push(paired());devices=await createPairedTerminalAuthorities({pool:db.pool as never,ownerUserId:USER});
    terminal=await createPersistentPublicExecutionOwner({executionOwner:'hermes_text',central,sharedExecution:host,
      deviceId:DEVICE,t03:devices.forDevice(DEVICE),readCurrentBinding:async()=>undefined,
      participant:{roomPort:{on(){},off(){}}} as never,onError:error=>errors.push(error)});
    assert.equal(terminal.assembly,host.assembly);assert.equal(terminal.sharedExecution,host);assert.equal(host.terminals.size,1);
    await terminal.bridge.close!();assert.equal(host.assembly.server.listening,true,'terminal teardown retains the host listener');
    assert.deepEqual(errors,[]);
  } finally {await terminal?.bridge.close?.();await devices?.close();await host.closeResources();await host.assembly.close();await rm(root,{recursive:true,force:true});}
});

test('host initialization failure releases the already started errand spool',async t=>{
  const root=await mkdtemp(join(tmpdir(),'paios-host-failure-')),blocked=join(root,'blocked');
  await writeFile(blocked,'regular file prevents timeline directory creation');
  const intervals=new Set<ReturnType<typeof setInterval>>(),start=globalThis.setInterval,stop=globalThis.clearInterval;
  t.mock.method(globalThis,'setInterval',(...args:Parameters<typeof setInterval>)=>{
    const timer=start(...args);intervals.add(timer);return timer;
  });
  t.mock.method(globalThis,'clearInterval',(timer:Parameters<typeof clearInterval>[0])=>{
    intervals.delete(timer as ReturnType<typeof setInterval>);return stop(timer);
  });
  try {
    await assert.rejects(createPersistentPublicExecutionHost({executionOwner:'hermes_text',
      central:{...resources(root),timeline:{directory:blocked}},errandSpool:join(root,'errands'),onError:error=>{throw error;}}),
      error=>['EEXIST','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''));
    assert.equal(intervals.size,0,'failed host must retire its acquired spool timer');
  } finally {t.mock.restoreAll();await rm(root,{recursive:true,force:true});}
});
