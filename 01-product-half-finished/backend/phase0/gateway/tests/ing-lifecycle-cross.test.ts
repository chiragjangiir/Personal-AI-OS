import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,connect,eventually,waveform,pcmBytes} from './current-unknown-harness.ts';
import {createMainStop} from '../../../services/personal-aios-integration/src/main.ts';
import {type UnknownClockRaw} from '../../../services/personal-aios-integration/src/unknown-clock.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/runtime.ts';
import type {TrackChunk} from '../../../services/personal-aios-integration/src/stream-archive.ts';

for(const heldNamespace of ['objects','quarantine-manifests']) test(`held quarantine ${heldNamespace} detaches its producer waiter but joins physical publication before actual lock unlink`,async t=>{
 const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);
 const directory=await fs.mkdtemp(join(tmpdir(),'paios-cross-lock-')),lock=join(directory,'owner.lock');await fs.writeFile(lock,'controlled-owner');
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const release=Promise.withResolvers<void>();t.after(()=>release.resolve());let enteredPublication=false;
 const original=f.storage.publish.bind(f.storage);f.storage.publish=async(namespace,key,bytes)=>{if(namespace===heldNamespace){enteredPublication=true;await release.promise;}return original(namespace,key,bytes);};
 let saved:any;const runtime=f.owner.assembly.runtime,owned=runtime.quarantineMedia.bind(runtime);runtime.quarantineMedia=(raw,source,chunk,publicationWaitSignal)=>{saved={raw:structuredClone(raw),source,chunk:structuredClone(chunk)};return owned(raw,source,chunk,publicationWaitSignal);};
 try{f.feed();await eventually(()=>enteredPublication);assert.equal(f.locked,false);assert.ok(f.permissionReads.includes(true),'permission snapshot reread inside controlled admission fence');
 let runtimeJoined=false,resourcesClosed=false;const order:string[]=[];
 const runtimeClose=f.owner.assembly.runtime.close().then(()=>{runtimeJoined=true;order.push('runtime');});
 const stop=f.owner.pcmIngress!.stop();
 await assert.rejects(owned(saved.raw,saved.source,saved.chunk),(e:any)=>e.code==='RUNTIME_CLOSED');
 const mainStop=createMainStop({close:()=>Promise.resolve(f.owner.bridge.close!())},
  {close:async()=>{assert.equal(f.locked,false);order.push('database');}},async()=>{await fs.unlink(lock);order.push('lock');});
 const first=mainStop();assert.equal(mainStop(),first);const cleanup=first.then(()=>{resourcesClosed=true;});
 await eventually(()=>runtimeJoined);assert.equal(runtimeJoined,true);assert.equal(resourcesClosed,false);assert.ok(await fs.stat(lock));assert.equal(f.locked,false);assert.ok(f.permissionReads.includes(true),'permission snapshot reread inside controlled admission fence');
 release.resolve();await Promise.all([stop,runtimeClose,cleanup]);
 assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);assert.equal(runtimeJoined,true);assert.equal(resourcesClosed,true);await assert.rejects(fs.stat(lock),{code:'ENOENT'});
 assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);assert.equal(f.owner.pcmIngress!.snapshot().pending_raw_keys.length,1);assert.deepEqual(await f.storage.list('raw-ingress'),[]);
 const [key]=await f.storage.list('quarantine-manifests');assert.ok(key);const q=JSON.parse(Buffer.from(await f.storage.read('quarantine-manifests',key)).toString());assert.equal(q.event.captured_at,null);assert.equal(q.authorization.historical_capture_range,'unverified');
 assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,pcmBytes(waveform()));
 assert.equal(f.locked,false);assert.ok(order.indexOf('database')>order.indexOf('runtime'));assert.equal(order.at(-1),'lock');
 assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
 }finally{release.resolve();}
});
for(const failedNamespace of ['objects','quarantine-manifests']) test(`quarantine ${failedNamespace} EIO retains durable input, automatically recovers, and fresh requests recheck permission`,async t=>{
 let failed=true;t.after(()=>{failed=false;});const f=await fixture(t);f.pcm.clock!.resolve=async()=>undefined;await connect(f);
 const primary=Object.assign(new Error(`WRITE_EIO_${failedNamespace}`),{code:'EIO'}),original=f.storage.publish.bind(f.storage);let attempts=0;
 let saved:{raw:UnknownClockRaw;source:RegisteredDevice;chunk:TrackChunk}|undefined;
 const runtime=f.owner.assembly.runtime,owned=runtime.quarantineMedia.bind(runtime);
 runtime.quarantineMedia=(raw,source,chunk,publicationWaitSignal)=>{saved={raw:structuredClone(raw),source,chunk:structuredClone(chunk)};return owned(raw,source,chunk,publicationWaitSignal);};
 f.storage.publish=async(n,k,b)=>{if(n===failedNamespace){attempts++;if(failed)throw primary;}return original(n,k,b);};
 try{
  f.feed();await eventually(()=>attempts>=2);assert.ok(saved);assert.equal(f.owner.pcmIngress!.snapshot().pending_frames,1);
  assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,saved.raw.payload.byteLength);
  assert.equal(f.owner.pcmIngress!.snapshot().latest_quarantine,undefined);assert.equal((await f.storage.list('raw-ingress')).length,1);
  assert.deepEqual(await f.storage.list('quarantine-manifests'),[]);assert.equal(f.locked,false);assert.ok(f.permissionReads.includes(true));
  failed=false;await eventually(()=>!!f.owner.pcmIngress!.snapshot().latest_quarantine);const q=f.owner.pcmIngress!.snapshot().latest_quarantine!;
  assert.equal(q.event.captured_at,null);assert.equal(q.authorization.historical_capture_range,'unverified');
  assert.deepEqual((await f.owner.media!.archive.readUnknownClock(q.quarantine_ref,'owner',q.archive_revision)).bytes,Buffer.from(saved.raw.payload));
  await f.owner.pcmIngress!.stop();await f.owner.pcmIngress!.drain();assert.equal(f.owner.pcmIngress!.snapshot().pending_bytes,0);
  assert.deepEqual(await f.storage.list('raw-ingress'),[]);f.revokeAudio();const reads=f.sourceReads;
  await assert.rejects(owned(saved.raw,saved.source,saved.chunk));assert.ok(f.sourceReads>reads,'fresh admission rechecks current permission');
  assert.equal((await f.storage.list('quarantine-manifests')).length,1);assert.equal(f.requests.length,0);assert.equal(f.nativeInputs.length,0);
  const order:string[]=[];const close=createMainStop({close:async()=>{await f.owner.bridge.close!();order.push('runtime');}},
   {close:async()=>{assert.equal(f.locked,false);order.push('db');}},async()=>{order.push('lock');});
  const closing=close();assert.equal(close(),closing);await closing;assert.deepEqual(order,['runtime','db','lock']);
 }finally{failed=false;}
});
