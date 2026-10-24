import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {sha256} from '../src/contracts.ts';

async function fixture(t:TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'l5-reserve-')),alerts:string[]=[];
  const storage=new PosixStorage(root,{min_free_bytes:100,min_free_inodes:10,
    onAlert:error=>alerts.push((error as Error).message)});
  const stat={bavail:1000,bsize:1,ffree:100};
  t.mock.method(fs,'statfs',async()=>({...stat}));
  t.after(async()=>{await storage.close();await fs.rm(root,{recursive:true,force:true});});
  return {storage,stat,alerts,root};
}

test('one reserve authority enforces bytes and inodes at the configured boundaries',async t=>{
  const {storage,stat}=await fixture(t);
  stat.bavail=110;stat.ffree=10;
  assert.equal(await storage.reserveFits(10),true);
  assert.equal(await storage.reserveFits(11),false);
  stat.ffree=9;
  assert.equal(await storage.reserveFits(0),false);
  await assert.rejects(storage.reserve(0),error=>(error as NodeJS.ErrnoException).code==='ENOSPC');
  stat.ffree=10;await storage.reserve(10);
});

test('inode pressure invokes the verified reserve policy before a real publication',async t=>{
  const {storage,stat,alerts}=await fixture(t),bytes=Buffer.from('original input');
  stat.ffree=9;const requests:number[]=[];
  storage.setReservePolicy(async pending=>{requests.push(pending);stat.ffree=10;});
  assert.deepEqual(await storage.publish('objects',sha256(bytes),bytes),bytes);
  assert.deepEqual(requests,[bytes.length]);
  assert.deepEqual(alerts,['L5_INODE_RESERVE_EMERGENCY']);
});

test('monitor reports each exhausted resource once per hour and resumes after recovery',async t=>{
  const {storage,stat,alerts}=await fixture(t);let now=10*60*60*1000,calls=0;
  t.mock.method(Date,'now',()=>now);
  storage.setReservePolicy(async pending=>{assert.equal(pending,0);calls++;});
  stat.bavail=99;stat.ffree=9;
  assert.equal(await storage.monitorReserve(),false);
  assert.equal(await storage.monitorReserve(),false);
  assert.deepEqual(alerts,['L5_DISK_RESERVE_EMERGENCY','L5_INODE_RESERVE_EMERGENCY']);
  now+=60*60*1000;
  assert.equal(await storage.monitorReserve(),false);
  assert.deepEqual(alerts,['L5_DISK_RESERVE_EMERGENCY','L5_INODE_RESERVE_EMERGENCY',
    'L5_DISK_RESERVE_EMERGENCY','L5_INODE_RESERVE_EMERGENCY']);
  stat.bavail=100;stat.ffree=10;
  assert.equal(await storage.monitorReserve(),true);await storage.reserve(0);
  assert.equal(calls,3);
});

test('failed reclamation preserves originals and rejects the write with ENOSPC',async t=>{
  const {storage,stat,root,alerts}=await fixture(t),original=Buffer.from('retain me');
  await storage.publish('objects',sha256(original),original);
  stat.bavail=99;stat.ffree=9;let calls=0;
  storage.setReservePolicy(async()=>{calls++;});
  await assert.rejects(storage.publish('objects',sha256('new'),Buffer.from('new')),
    error=>(error as NodeJS.ErrnoException).code==='ENOSPC');
  assert.equal(calls,1);
  assert.deepEqual(await fs.readdir(join(root,'objects')),[sha256(original)]);
  assert.deepEqual(await storage.read('objects',sha256(original)),original);
  assert.deepEqual(alerts,['L5_DISK_RESERVE_EMERGENCY','L5_INODE_RESERVE_EMERGENCY']);
});
