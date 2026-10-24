import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import type {TrustedContext} from '../src/contracts.ts';
import {webdav} from './stream-materialized-fixture.ts';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';

const MiB=1024*1024,namespace='objects';
const trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'upload',consent_ref:'fixture',submission:'observation'};
test('tier upload rate is a positive integer in kbps, validated before resources open',async()=>{
  const cold={url:'http://cold-webdav:5244/dav',username:'fixture',password_file:'/unused/password'};
  for(const max_upload_kbps of [0,-1,1.5,'2000',null,Infinity])
    await assert.rejects(provisionCentralResources({port:0,archive_tiering:{cold,max_upload_kbps}} as unknown as CentralProvisionConfiguration),/INVALID_ARCHIVE_TIERING/);
  for(const archive_tiering of [{cold},{cold,max_upload_kbps:2000}])
    await assert.rejects(provisionCentralResources({port:0,archive_tiering} as CentralProvisionConfiguration),/INVALID_SERVICE_PORT/);
});
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'l5-pacing-')),dav=await webdav(t,root);
  const storage=new PosixStorage(join(root,'hot'),{cold:dav.config}),archive=new RawArchive(storage,8*MiB);
  const notices:string[]=[];archive.setAlert(async reason=>{notices.push(reason);});
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(root,{recursive:true,force:true});});
  const publish=async(n:number,size:number)=>{const bytes=randomBytes(size);
    const event=await archive.archive({schema_version:'paios.event.v1',event_id:`file-${n}`,device_id:'phone',device_type:'phone',
      captured_at:new Date().toISOString(),source:{channel:'upload'},media_type:'file',mime:'application/octet-stream',representation:'uploaded_original',payload:bytes},trusted);
    return {key:event.payload_sha256,bytes};};
  return {dav,storage,archive,notices,publish};
}

test('busy defers uploads but still verifies and evicts old hot copies; idle resumes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {storage,archive,publish}=await fixture(t),old=await publish(1,1024);
  await archive.moveCold();const age=new Date(Date.now()-49*3600000);
  await fs.utimes(join(storage.root,namespace,old.key),age,age);
  const fresh=await publish(2,1024);let busy=true;
  const policy={busy:()=>busy,max_upload_kbps:2000};
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,0);
  await assert.rejects(storage.readHot(namespace,old.key),{code:'ENOENT'});
  assert.deepEqual(await storage.read(namespace,old.key),old.bytes);
  assert.equal(await storage.cold!.contains(namespace,fresh.key),false);
  busy=false;assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,1);
  assert.deepEqual(await storage.cold!.read(namespace,fresh.key),fresh.bytes);
});

test('8 MiB pack ceiling uses actual wire bytes and decimal kbps to pace the next start',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {storage,archive,publish}=await fixture(t);
  await publish(1,4*MiB);await publish(2,4*MiB);await publish(3,1);
  const batches:number[]=[],move=storage.moveCold.bind(storage);
  t.mock.method(storage,'moveCold',async(...[records,beforeUpload]:Parameters<PosixStorage['moveCold']>)=>{
    batches.push(records.reduce((sum,r)=>sum+r.bytes.length,0));return move(records,beforeUpload);
  });
  const policy={max_upload_kbps:2000},started=Date.now(),first=await archive.moveCold(2,started,policy);
  assert.equal(first.segments,1);assert.equal(batches.length,1);assert.ok(batches[0]!>=4*MiB&&batches[0]!<=8*MiB);
  const interval=Math.ceil(first.cold_bytes*8/2000);
  t.mock.timers.tick(interval-1);
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,0);
  assert.equal(batches.length,1);
  t.mock.timers.tick(1);
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,1);
  assert.equal(batches.length,2);assert.ok(batches[1]!>=4*MiB&&batches[1]!<=8*MiB);
});

test('a call beginning during packing blocks PUT without a failure alert or a lost candidate',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const {dav,storage,archive,notices,publish}=await fixture(t),record=await publish(1,1024);
  let busy=false,interrupt=true;const read=fs.readFile.bind(fs);
  t.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{
    const value=await read(...args);if(args[0]===dav.config.password_file&&interrupt){busy=true;interrupt=false;}return value;
  });
  const policy={busy:()=>busy,max_upload_kbps:2000};
  assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,0);
  assert.deepEqual(await fs.readdir(dav.directory),[]);assert.deepEqual(notices,[]);
  assert.equal(await storage.cold!.contains(namespace,record.key),false);
  busy=false;assert.equal((await archive.moveCold(2,Date.now(),policy)).segments,1);
  assert.deepEqual(await storage.cold!.read(namespace,record.key),record.bytes);
});
