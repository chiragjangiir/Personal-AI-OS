import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {ColdStorage} from '../src/cold-storage.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {sha256} from '../src/contracts.ts';

async function fixture(t:any,deadline=1000){
  const root=await mkdtemp(join(tmpdir(),'l5-http-')),objects=new Map<string,Buffer>(),requests:string[]=[];
  const state={corrupt:false,stall:false,ignoreRange:false,backupFolder:false,mkcolStatus:0,getStatus:0,
    getGate:undefined as Promise<void>|undefined,onGet:undefined as (()=>void)|undefined};
  const server=createServer(async(req,res)=>{
    requests.push(`${req.method} ${req.headers.range??'full'}`);
    assert.equal(req.headers.authorization,`Basic ${Buffer.from('scoped:secret').toString('base64')}`);
    if(state.stall)return;
    if(req.method==='GET'){state.onGet?.();await state.getGate;if(state.getStatus){res.writeHead(state.getStatus).end();return;}}
    if(req.method==='MKCOL'){const status=state.mkcolStatus||(state.backupFolder?405:201);if(status===201)state.backupFolder=true;res.writeHead(status).end();return;}
    if(req.method==='PUT'&&req.url?.startsWith('/backups/')&&!state.backupFolder){res.writeHead(409).end();return;}
    if(req.method==='PUT'){const parts:Buffer[]=[];for await(const p of req)parts.push(p);objects.set(req.url!,Buffer.concat(parts));res.writeHead(201).end();return;}
    if(req.method==='DELETE'){objects.delete(req.url!);res.writeHead(204).end();return;}
    let bytes=objects.get(req.url!);if(!bytes){res.writeHead(404).end();return;}
    if(state.corrupt){bytes=Buffer.from(bytes);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;}
    const range=/bytes=(\d+)-(\d+)/u.exec(req.headers.range??'');
    if(range&&!state.ignoreRange){const start=Number(range[1]),end=Number(range[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}).end(bytes.subarray(start,end+1));}
    else res.writeHead(200).end(bytes);
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  await writeFile(join(root,'password'),'secret\n');
  const config={url:`http://127.0.0.1:${(server.address() as any).port}`,username:'scoped',password_file:join(root,'password')};
  const cold=new ColdStorage(join(root,'hot'),config,deadline);
  t.after(async()=>{await cold.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});});
  return {cold,objects,requests,state,root,config};
}
const record=(text:string)=>({namespace:'raw',key:sha256(Buffer.from(text)),bytes:Buffer.from(text)});

test('PUT independently reads full pack before locations publish; corruption leaves no location',async t=>{
  const f=await fixture(t),r=record('exact original');f.state.corrupt=true;
  await assert.rejects(f.cold.move([r]),/COLD_COPY_INTEGRITY/u);assert.equal(await f.cold.contains(r.namespace,r.key),false);
  assert.equal((await f.cold.packs()).length,1);assert.deepEqual(await f.cold.packs(true),[]);
  assert.deepEqual(await f.cold.locations([r]),[]);assert.deepEqual(await f.cold.keys(r.namespace),[]);
  f.state.corrupt=false;const receipt=await f.cold.move([r]);assert.deepEqual(f.requests.slice(-2),['PUT full','GET full']);
  assert.deepEqual(await f.cold.records(receipt.pack),[r]);
  assert.deepEqual((await f.cold.packs(true)).map(p=>({...p})),[{key:receipt.pack,size:receipt.bytes}]);
  assert.deepEqual(await f.cold.keys(r.namespace),[r.key]);assert.deepEqual(await f.cold.keys('other'),[]);
  assert.deepEqual((await f.cold.locations([r],receipt.pack)).map(p=>({...p})),[{namespace:r.namespace,key:r.key,pack:receipt.pack,size:r.bytes.length,hash:r.key}]);
  assert.deepEqual(await f.cold.locations(undefined,receipt.pack),await f.cold.locations([r]));
  f.state.corrupt=true;await assert.rejects(f.cold.verifiedRecords([r]),/COLD_COPY_INTEGRITY/u);
  const corrupted={namespace:'objects',key:sha256('archived original'),bytes:Buffer.from('corrupt hot bytes')},before=f.requests.length;
  await assert.rejects(f.cold.move([corrupted]),/COLD_ORIGINAL_INTEGRITY/);assert.equal(f.requests.length,before);
  assert.equal(await f.cold.contains(corrupted.namespace,corrupted.key),false);
});

test('selected block range reads share in-flight work and reject ignored Range',async t=>{
  const f=await fixture(t),a=record('photo'),b=record('file');await f.cold.move([a,b]);f.requests.length=0;
  const reads=await Promise.all([f.cold.read(a.namespace,a.key),f.cold.read(b.namespace,b.key),f.cold.read(a.namespace,a.key)]);
  assert.deepEqual(reads,[a.bytes,b.bytes,a.bytes]);assert.equal(f.requests.length,3);assert.ok(f.requests.every(r=>r.startsWith('GET bytes=')));
  f.state.ignoreRange=true;await assert.rejects(f.cold.read(a.namespace,a.key),/COLD_RANGE_INVALID/u);
});

test('legacy L5P1 without block hashes validates every item in selected block',async t=>{
  const f=await fixture(t),a=record('legacy a'),b=record('legacy b'),receipt=await f.cold.move([a,b]);
  const encoded=gzipSync(Buffer.concat([a.bytes,b.bytes]));
  for(const invalid of [{namespace:b.namespace,key:b.key,hash:'0'.repeat(64)},
    {namespace:'objects',key:'0'.repeat(64),hash:b.key}]){
  const header=gzipSync(JSON.stringify({schema:'paios.cold.v1',blocks:[{codec:'gzip',offset:0,size:encoded.length,decoded:a.bytes.length+b.bytes.length}],
    items:[{namespace:a.namespace,key:a.key,hash:a.key,size:a.bytes.length,offset:0,block:0},
      {...invalid,size:b.bytes.length,offset:a.bytes.length,block:0}]}));
  const prefix=Buffer.alloc(8);prefix.write('L5P1');prefix.writeUInt32BE(header.length,4);
  // A historical location points at this key; Range validates items even when encoded-block hashes are absent.
  const bytes=Buffer.concat([prefix,header,encoded]);f.objects.set(`/${receipt.pack}.l5pack`,bytes);
  // Keep indexed size equal so header bounds model the old pack faithfully.
  const old=f.objects.get(`/${receipt.pack}.l5pack`)!;assert.ok(old.length<=receipt.bytes);
  await assert.rejects(f.cold.read(a.namespace,a.key),/COLD_OBJECT_INTEGRITY/u);
  }
});

test('HTTP deadline fails without publishing cold locations; legacy uses same bounded transport',async t=>{
  const f=await fixture(t,40),r=record('timeout');f.state.stall=true;
  await assert.rejects(f.cold.move([r]));assert.equal(await f.cold.contains(r.namespace,r.key),false);
  f.state.stall=false;f.objects.set('/originals/2026-10-14/capture.jpg',r.bytes);
  assert.deepEqual(await f.cold.download('originals/2026-10-14/capture.jpg'),r.bytes);
  await f.cold.delete('originals/2026-10-14/capture.jpg');assert.equal(f.objects.size,0);
});

test('explicit records reads freshly verify remote full hash and decoded objects',async t=>{
  const f=await fixture(t),r=record('snapshot closure'),receipt=await f.cold.move([r]);
  const data=f.objects.get(`/${receipt.pack}.l5pack`)!;f.requests.length=0;
  assert.deepEqual(await f.cold.records(receipt.pack),[r]);assert.deepEqual(f.requests,['GET full']);
  const corrupt=Buffer.from(data);corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;
  f.objects.set(`/${receipt.pack}.l5pack`,corrupt);
  await assert.rejects(f.cold.records(receipt.pack),/COLD_COPY_INTEGRITY/u);
  assert.deepEqual(f.requests,['GET full','GET full']);
});

test('authority upload independently verifies exact bytes before returning receipt',async t=>{
  const f=await fixture(t),bytes=Buffer.from('encrypted backup payload'),ref='backups/2026-10-14.age.parts-000000';
  assert.deepEqual(await f.cold.upload(ref,bytes),{size:bytes.length,hash:sha256(bytes)});
  assert.deepEqual(f.requests,['MKCOL full','PUT full','GET full']);f.state.corrupt=true;
  await assert.rejects(f.cold.upload(ref,bytes),/COLD_COPY_INTEGRITY/u);
});

test('accepted 64 MiB PCM packs losslessly and reads back within the shared codec budget',async t=>{
  const f=await fixture(t,5000),bytes=Buffer.alloc(64*1024*1024,0x5a),r={namespace:'objects',key:sha256(bytes),bytes,format:'pcm_s16le:16000:1'};
  const receipt=await f.cold.move([r]);assert.ok(receipt.bytes<bytes.length);
  const restored=await f.cold.read(r.namespace,r.key);assert.equal(restored.length,bytes.length);assert.equal(sha256(restored),r.key);
  await assert.rejects(f.cold.move([r,record('x')]),/COLD_SEGMENT_LIMIT/u);
});

test('corrupt original block leaves owner metadata independently Range readable',async t=>{
  const f=await fixture(t),metadata={...record('{"owner":"verified-owner"}'),namespace:'manifests'},original={...record('JPEG or H264 original'),namespace:'objects'};
  await f.cold.move([metadata,original]);f.state.corrupt=true;
  assert.deepEqual(await f.cold.read(metadata.namespace,metadata.key),metadata.bytes);
  await assert.rejects(f.cold.read(original.namespace,original.key),/COLD_BLOCK_INTEGRITY/u);
  assert.deepEqual(await f.cold.read(metadata.namespace,metadata.key),metadata.bytes);
});

test('backup folder creation rejects forbidden MKCOL before uploading; URL query and fragment reject',async t=>{
  const f=await fixture(t);f.state.mkcolStatus=403;
  await assert.rejects(f.cold.upload('backups/day.age',Buffer.from('encrypted')),/COLD_HTTP_FAILED/u);
  assert.deepEqual(f.requests,['MKCOL full']);
  const config={url:'https://example.test/dav?wrong=path',username:'scoped',password_file:'/unused'};
  assert.throws(()=>new ColdStorage('/unused',config),/COLD_URL_INVALID/u);
  assert.throws(()=>new ColdStorage('/unused',{...config,url:'https://example.test/dav#wrong'}),/COLD_URL_INVALID/u);
});


test('stalled then failing remote eviction leaves healthy hot ingress unfenced and stops the sweep',{timeout:5000},async t=>{
  const f=await fixture(t),storage=new PosixStorage(join(f.root,'capture'),{cold:f.config}),archive=new RawArchive(storage,65536);
  await storage.prepareCapture();
  for(const text of ['first retained original','second retained original']){
    const r={...record(text),namespace:'objects'};await storage.publish(r.namespace,r.key,r.bytes);await storage.moveCold([r]);
    const old=new Date(Date.now()-3*86400000);await utimes(join(storage.root,'objects',r.key),old,old);
  }
  let release!:()=>void,entered!:()=>void;f.state.getGate=new Promise<void>(done=>{release=done;});
  const started=new Promise<void>(done=>{entered=done;});f.state.onGet=entered;f.state.getStatus=503;f.requests.length=0;
  const eviction=archive.moveCold();const rejected=assert.rejects(eviction,/L5_COLD_VERIFICATION_FAILED/u);
  try{
    await started;
    const bytes=Buffer.alloc(320,7),captured_at=new Date().toISOString();
    const admitted=await archive.admitStream({schema_version:'paios.event.v1',event_id:'healthy-hot-call',device_id:'phone',device_type:'phone',captured_at,
      source:{channel:'livekit'},media_type:'livekit_tracks',mime:'audio/pcm',representation:'received_decoded_sample',payload:bytes},
      {principal_id:'owner',device_id:'phone',device_type:'phone',channel:'livekit',consent_ref:'fixture',submission:'observation'},
      {track_id:'microphone',stream_epoch:'call',seq:0,modality:'audio',format:'pcm_s16le:16000:1',
        source_range:{kind:'interval',timebase_id:'audio_pts',stream_epoch:'call',start_ms:0,end_ms:10}});
    const capture=await admitted.commit;assert.equal(capture.event.archive_status,'durable');
    assert.deepEqual(await storage.readHot('objects',sha256(bytes)),bytes);
  }finally{release();}
  await rejected;assert.deepEqual(f.requests,['GET full'],'first transport/integrity failure ends the sweep');
  assert.equal((await storage.listHot('objects')).length,3);await archive.close();await storage.close();
});

test('one pack owns input bytes through remote verification and releases on failure',async t=>{
  const f=await fixture(t),r=record('owned until remote verified');
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  f.state.getGate=release.promise;f.state.onGet=()=>entered.resolve();f.state.getStatus=503;
  const moving=f.cold.move([r]),failed=assert.rejects(moving,/COLD_HTTP_FAILED/);
  try{await entered.promise;const snapshot=f.cold.snapshot();
    assert.equal(snapshot.active,1);assert.equal(snapshot.input_bytes,r.bytes.length);
    assert.equal(snapshot.queued,0);assert.equal(snapshot.max_input_bytes,64*1024*1024);
    await assert.rejects(f.cold.move([r]),/COLD_BUDGET_BUSY/);
  }finally{release.resolve();}
  await failed;assert.equal(f.cold.snapshot().input_bytes,0);assert.equal(f.cold.snapshot().active,0);
  assert.equal(await f.cold.contains(r.namespace,r.key),false);
});

test('full-copy length mismatch is an integrity failure for both short and long remote packs',async t=>{
  const f=await fixture(t),r=record('length-proof original'),receipt=await f.cold.move([r]),ref=`/${receipt.pack}.l5pack`,saved=f.objects.get(ref)!;
  for(const remote of [saved.subarray(0,saved.length-1),Buffer.concat([saved,Buffer.from('x')])]){
    f.objects.set(ref,remote);await assert.rejects(f.cold.records(receipt.pack),/COLD_COPY_INTEGRITY/);
  }
  assert.deepEqual(r.bytes,Buffer.from('length-proof original'));
});


test('codec output failure keeps admission until its exact child exits and releases pending stdin',async t=>{
  const f=await fixture(t),bin=join(f.root,'bin'),pidFile=join(f.root,'codec-pids');await mkdir(bin);
  const savedPath=process.env.PATH,savedPid=process.env.PAIOS_TEST_CODEC_PIDS;
  await writeFile(join(bin,'ffmpeg'),`#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.PAIOS_TEST_CODEC_PIDS,process.pid+'\\n');
if(process.argv[process.argv.indexOf('-c:a')+1]==='pcm_s16le'){
  process.stdout.write(Buffer.alloc(1024));setInterval(()=>{},1000);
}else{process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('controlled encoded block'));}
`,{mode:0o700});
  process.env.PATH=bin+':'+savedPath;process.env.PAIOS_TEST_CODEC_PIDS=pidFile;
  t.after(()=>{process.env.PATH=savedPath;if(savedPid===undefined)delete process.env.PAIOS_TEST_CODEC_PIDS;else process.env.PAIOS_TEST_CODEC_PIDS=savedPid;});
  const bytes=Buffer.alloc(320),r={namespace:'objects',key:sha256(bytes),bytes,format:'pcm_s16le:16000:1'};
  await assert.rejects(f.cold.move([r]),/COLD_CODEC_OUTPUT_LIMIT/);
  const pids=(await readFile(pidFile,'utf8')).trim().split('\n').map(Number);assert.equal(pids.length,2);
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),(error:any)=>error.code==='ESRCH');
  assert.equal(f.cold.snapshot().active,0);assert.equal(f.cold.snapshot().input_bytes,0);
  assert.equal(await f.cold.contains(r.namespace,r.key),false);
  await f.cold.move([record('next accepted original')]);
});
