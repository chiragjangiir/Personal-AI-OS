import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAIOSRuntime,RunAdmission} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {OutputAuthority} from '../src/output.ts';
import {sha256} from '../src/contracts.ts';
import {PHONE_CAPABILITIES,GLASSES_CAPABILITIES} from '../src/source-authority.ts';

test('runtime capable phone attach executes the latest unexpired glasses request once; stops replace pending starts offline',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'movement-reconnect-')),storage=new PosixStorage(directory);
  const native={create:async()=>{throw new Error('unexpected admission');},status:async()=>{throw new Error('unexpected poll');},cancel:async()=>{throw new Error('unexpected cancel');}};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:86400000,policy_version:'movement-test'});
  let now=0;
  const devices=[['phone','phone',PHONE_CAPABILITIES],['glasses','glasses',GLASSES_CAPABILITIES]].map(([device_id,device_type,capabilities])=>({
    principal_id:'owner',device_id,device_type,capabilities,channel:'fixture',consent_ref:'fixture',route_version:'route',output_modes:['text'],token_sha256:sha256(String(device_id))}));
  const runtime=new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission,native,output:new OutputAuthority(storage),
    devices:devices as never,skill:'fixture',max_read_bytes:8192,movement:{now:()=>now,pending_ttl_ms:100}});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const phone=await runtime.authenticate('phone'),glasses=await runtime.authenticate('glasses');
  const sent:Record<string,unknown>[]=[];
  const attach=async()=>{const detach=await runtime.watchCare(phone,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'move',move:async(body,current)=>{if(!current||current())sent.push(body);}});await runtime.movementReady(phone);return detach;};
  const start=async()=>assert.equal((await runtime.move(glasses,{operation:'ride_control',action:'start'}) as {status:string}).status,'pending');
  await start();now=50;await start();
  const noMovement=await runtime.watchCare(phone,async()=>true);assert.equal(sent.length,0);noMovement();
  let detach=await attach();assert.deepEqual(sent,[{operation:'ride_control',action:'start',requested_by:'glasses'}]);detach();
  detach=await attach();assert.equal(sent.length,1);detach();
  await start();now+=100;detach=await attach();assert.equal(sent.length,1);detach();
  for(const operation of ['ride_control','nav_control'] as const){
    await start();await runtime.move(glasses,{operation,action:'stop'});
    detach=await attach();assert.equal(sent.length,2);assert.equal(sent.at(-1)!.action,'stop');detach();
  }
  const failures:Record<string,unknown>[]=[];
  const detachGlasses=await runtime.watchCare(glasses,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'glasses',deliver:async()=>{},move:async body=>{failures.push(body);}});await runtime.wearState(glasses,true);
  assert.equal((await runtime.move(glasses,{operation:'ride_control',action:'start'}) as {status:string}).status,'glasses_started');const detachFailed=await runtime.watchCare(phone,async()=>true,undefined,undefined,undefined,undefined,undefined,
    {session:'failed-move',move:async()=>{throw new Error('movement publication failed');}});
  await runtime.movementReady(phone);assert.equal(failures.at(-1)?.error_code,'MOVEMENT_DELIVERY_FAILED');
  await assert.rejects(runtime.move(glasses,{operation:'ride_control',action:'start'}),/movement publication failed/);
  detachFailed();detachGlasses();await start();detach=await attach();assert.equal(sent.length,3);assert.equal(sent.at(-1)!.action,'start');detach();
});
