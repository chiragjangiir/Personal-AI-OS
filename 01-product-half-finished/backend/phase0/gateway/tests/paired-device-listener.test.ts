import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createPairedTerminalAuthorities} from '../src/paired-device-authority.ts';
import {issueDeviceGovernance} from '../src/paired-device-registration.ts';
import {PHONE_CAPABILITIES} from '../../../services/personal-aios-integration/src/source-authority.ts';

const USER='01900000-0000-7000-8000-000000000001';
const DEVICES=['01900000-0000-7000-8000-000000000002','01900000-0000-7000-8000-000000000003'];
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
  const active=new Set(DEVICES),clients:Listener[]=[];
  const control={connects:0,failConnections:0,connectGate:undefined as Promise<void>|undefined,
    catchupGate:undefined as Promise<void>|undefined,registrationGate:undefined as Promise<void>|undefined};
  const rows=DEVICES.map(device_id=>({device_id,user_id:USER,device_class:'iphone',recipient_public_key:'public-key',
    device_credential_ref:{ref_id:device_id},paired_at:'2026-10-01T00:00:00.000Z',
    ...issueDeviceGovernance({identity:{createConnectionId:()=>device_id},userId:USER,deviceId:device_id,
      deviceType:'phone',capabilities:PHONE_CAPABILITIES,publicKeySha256:'public-digest',pairedAt:'2026-10-01T00:00:00.000Z'})}));
  const query=async(sql:string,args:unknown[]=[])=>{
    const selected=rows.filter(row=>active.has(row.device_id)&&(!sql.includes('device_id = $1')||row.device_id===args[0]));
    if(sql.startsWith('SELECT device_id::text, user_id::text'))await control.registrationGate;
    return {rows:selected};
  };
  class Listener extends EventEmitter {
    statements:string[]=[];
    releases:(boolean|undefined)[]=[];
    async query(sql:string,args:unknown[]=[]){
      this.statements.push(sql);
      if(sql.startsWith('LISTEN ')||sql.startsWith('UNLISTEN '))return {rows:[]};
      await control.catchupGate;return query(sql,args);
    }
    release(destroy?:boolean){this.releases.push(destroy);}
  }
  const pool={query,connect:async()=>{
    control.connects++;
    if(control.failConnections>0){control.failConnections--;throw new Error('database unavailable');}
    const listener=new Listener();clients.push(listener);await control.connectGate;return listener;
  }};
  return {pool,active,clients,control};
}

test('LISTEN error invalidates readiness and reconnect catches revocation before becoming ready',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),devices=await createPairedTerminalAuthorities({pool:f.pool as never});
  t.after(()=>devices.close());devices.bindCurrentBinding(async()=>undefined);
  const revoked:string[]=[];devices.onRevoked(async id=>{revoked.push(id);});
  assert.equal(devices.readiness.isReady(),true);
  const first=f.clients[0]!;
  assert.doesNotThrow(()=>first.emit('error',new Error('connection lost')));
  first.emit('end');
  assert.equal(devices.readiness.isReady(),false);
  assert.equal(devices.bearer.isReady(),false);
  assert.equal(devices.readiness.current().authorityReady,false);
  assert.throws(()=>devices.readiness.assertReady(),/PAIRED_DEVICE_AUTHORITY_NOT_READY/);
  assert.deepEqual(first.releases,[true]);
  f.active.delete(DEVICES[0]!);
  const catchup=Promise.withResolvers<void>();f.control.catchupGate=catchup.promise;
  t.mock.timers.tick(100);await settled();
  assert.equal(f.control.connects,2);
  assert.deepEqual(f.clients[1]!.statements.slice(0,1),['LISTEN paired_device_revoked']);
  assert.equal(devices.readiness.isReady(),false,'re-LISTEN alone cannot restore readiness');
  catchup.resolve();await settled();
  assert.deepEqual(revoked,[DEVICES[0]]);
  assert.throws(()=>devices.forDevice(DEVICES[0]!),/PAIRED_DEVICE_REQUIRED/);
  assert.equal(devices.readiness.isReady(),true);
  await devices.close();t.mock.timers.tick(60000);await settled();
  assert.equal(f.control.connects,2);
});

test('LISTEN end reconnects with bounded backoff through repeated database failures',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),devices=await createPairedTerminalAuthorities({pool:f.pool as never});
  t.after(()=>devices.close());devices.bindCurrentBinding(async()=>undefined);
  f.control.failConnections=7;f.clients[0]!.emit('end');
  assert.equal(devices.readiness.isReady(),false);
  let attempts=1;
  for(const delay of [100,200,400,800,1600,3200,5000,5000]){
    t.mock.timers.tick(delay-1);await settled();assert.equal(f.control.connects,attempts);
    t.mock.timers.tick(1);await settled();assert.equal(f.control.connects,++attempts);
  }
  assert.equal(devices.readiness.isReady(),true);
  assert.equal(f.clients[1]!.statements[0],'LISTEN paired_device_revoked');
});

test('shutdown joins a pending reconnect without LISTEN or another reconnect',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),devices=await createPairedTerminalAuthorities({pool:f.pool as never});
  const connect=Promise.withResolvers<void>();
  t.after(async()=>{connect.resolve();await devices.close();});
  f.control.connectGate=connect.promise;f.clients[0]!.emit('end');
  t.mock.timers.tick(100);await settled();assert.equal(f.control.connects,2);
  const closing=devices.close();connect.resolve();await closing;
  assert.deepEqual(f.clients[1]!.statements,[]);
  assert.deepEqual(f.clients[1]!.releases,[true]);
  assert.equal(devices.readiness.current().closed,true);
  t.mock.timers.tick(60000);await settled();assert.equal(f.control.connects,2);
});

test('shutdown cancels a scheduled reconnect',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),devices=await createPairedTerminalAuthorities({pool:f.pool as never});
  f.clients[0]!.emit('end');await devices.close();
  t.mock.timers.tick(60000);await settled();assert.equal(f.control.connects,1);
});

test('live revocation retires its authority and notifies consumers while peers stay ready',async t=>{
  const f=fixture(),devices=await createPairedTerminalAuthorities({pool:f.pool as never});
  t.after(()=>devices.close());devices.bindCurrentBinding(async()=>undefined);
  const source=devices.forDevice(DEVICES[0]!),revocations:string[]=[];
  devices.onRevoked(async id=>{assert.equal(source.readiness.isReady(),false);revocations.push(id);});
  f.active.delete(DEVICES[0]!);
  f.clients[0]!.emit('notification',{channel:'paired_device_revoked',payload:DEVICES[0]});await settled();
  assert.deepEqual(revocations,[DEVICES[0]]);
  assert.throws(()=>devices.forDevice(DEVICES[0]!),/PAIRED_DEVICE_REQUIRED/);
  assert.equal(devices.readiness.isReady(),true);
});

test('revocation cannot be overwritten by a concurrent authority refresh',async t=>{
  const f=fixture(),devices=await createPairedTerminalAuthorities({pool:f.pool as never}),gate=Promise.withResolvers<void>();
  t.after(async()=>{gate.resolve();await devices.close();});
  f.control.registrationGate=gate.promise;
  const refresh=devices.register(DEVICES[0]!,true);await settled();
  f.active.delete(DEVICES[0]!);
  f.clients[0]!.emit('notification',{channel:'paired_device_revoked',payload:DEVICES[0]});await settled();
  gate.resolve();await assert.rejects(refresh,/PAIRED_DEVICE_REVOKED/);
  assert.throws(()=>devices.forDevice(DEVICES[0]!),/PAIRED_DEVICE_REQUIRED/);
  assert.equal(devices.terminals.length,1);
});
