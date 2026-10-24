import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RunAdmission} from './native-source-fixture.ts';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {LocalMediaExecution} from '../src/media/local-execution.ts';
import {FfmpegDemux,type DecoderBudget} from '../src/media/ffmpeg-demux.ts';
import {MediaProcessor,FeatureReplayWorker,type Capability} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';
import {digest,canonical,sha256,type TrustedContext} from '../src/contracts.ts';
import type {DemuxPort} from '../src/media/tracks.ts';
function traceDecoder(decoder:FfmpegDemux, decoderId:string, count:()=>void, transform:(value:Awaited<ReturnType<FfmpegDemux['demux']>>)=>Awaited<ReturnType<FfmpegDemux['demux']>> = value=>value):DemuxPort {
  return {decoder_id:decoderId,demux:async(...args)=>transform(await decoder.demux(...args)),
    prepare:async signal=>{
      const admission=await decoder.prepare(signal);
      return {assertReady:()=>admission.assertReady(),release:()=>admission.release(),
        execute:async(original,bytes)=>{count();return transform(await admission.execute(original,bytes));}};
    }};
}
const run=promisify(execFile);
const toolchain=process.env.PAIOS_DEMUX_TOOLCHAIN??'/opt/personal-aios-runtime/toolchains/ffmpeg-8.0.3-minimal/bin';
const budget:DecoderBudget={timeout_ms:5000,max_input_bytes:1000000,max_output_bytes:1000000,max_chunks:128,max_pixels:4096,max_metadata_bytes:1000000,max_duration_ms:2000};
const trusted:TrustedContext={principal_id:'owner',device_id:'mac',device_type:'mac',consent_ref:'fixture',channel:'upload',submission:'observation'};
async function fixture(t:test.TestContext) {
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-demux-'));const storage=new PosixStorage(join(directory,'l5'));
  const output=join(directory,'synthetic.mp4');
  await run(join(toolchain,'ffmpeg'),['-hide_banner','-nostdin','-y','-f','lavfi','-i','testsrc=size=32x24:rate=5:duration=1',
    '-itsoffset','0.2','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=0.8','-c:v','mpeg4','-c:a','aac','-pix_fmt','yuv420p','-avoid_negative_ts','disabled',output]);
  const bytes=await fs.readFile(output);assert.ok(bytes.length<1000000);
  const archive=new RawArchive(storage,1000000);
  const original=await archive.archive({schema_version:'paios.event.v1',event_id:'uploaded-clip',device_id:'mac',device_type:'mac',
    captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'upload'},media_type:'muxed_av',mime:'video/mp4',representation:'uploaded_original',payload:bytes},trusted);
  const execution=await LocalMediaExecution.create({runtime:directory,slots:1});
  const decoder=await FfmpegDemux.create(join(toolchain,'ffmpeg'),join(toolchain,'ffprobe'),join(directory,'decoders'),budget,execution);
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {directory,storage,archive,original,decoder,bytes,execution};
}

test('actual original MP4→PTS-linked immutable derived objects→C/MEDIA→D; restart and replay do not decode again',async t=>{
  const f=await fixture(t);let decodes=0,workers=0;
  const port:DemuxPort=traceDecoder(f.decoder,f.decoder.decoder_id,()=>{decodes++;});
  const records=await Promise.all([f.archive.deriveMedia(f.original,port,new AbortController().signal),f.archive.deriveMedia(f.original,port,new AbortController().signal)]);
  assert.equal(records[0]!.ref,records[1]!.ref);assert.equal(records[0]!.settlement_coverage,'complete');assert.equal(decodes,1);
  const derived=records[0]!;const audio=derived.manifest.chunks.filter(c=>c.modality==='audio'),video=derived.manifest.chunks.filter(c=>c.modality==='visual');
  assert.equal(video.length,5);assert.ok(audio.length>1);assert.ok(audio[0]!.pts.pts_time>0.1);assert.equal(video[0]!.pts.pts_time,0);
  for(const chunk of derived.manifest.chunks) {
    assert.equal(chunk.representation,'derived');assert.equal(chunk.derived_from,f.original.raw_ref);
    assert.equal(chunk.original_archive_revision,f.original.archive_revision);assert.equal(chunk.original_payload_sha256,sha256(f.bytes));
    assert.equal(sha256(await f.storage.read('objects',chunk.object_hash)),chunk.object_hash);
  }
  const restarted=new RawArchive(f.storage,1000000);assert.deepEqual(await restarted.read(f.original.raw_ref,'owner',f.original.archive_revision),f.bytes);
  const replay=await restarted.deriveMedia(f.original,port,new AbortController().signal);assert.equal(replay.ref,derived.ref);assert.equal(decodes,1);
  const maps=[...new Map(derived.manifest.chunks.map(c=>[c.track_id,c])).values()].map(c=>({modality:c.modality,track_id:c.track_id,stream_epoch:c.stream_epoch,
    source_timebase_id:c.source_range.timebase_id,target_timebase_id:'container-common',offset_ms:0,drift_ppm:0,uncertainty_ms:0,basis_ref:derived.ref}));
  const cap:Capability={id:'controlled',version:'fixture',modalities:['audio','visual'],formats:['png','pcm_s16le:16000:1'],joint_av:true,healthy:true,permitted:true,max_duration_ms:2000,evidence:'deterministic_replay',execution:'local'};
  const processor=new MediaProcessor(f.storage,new Map([['controlled',{analyze:async(request,signal)=>{workers++;return new FeatureReplayWorker().analyze(request,signal);}}]]),
    {policy_version:'demux-fixture',max_inflight:2,max_input_bytes:1000000,timeout_ms:1000,allow_external:false,allow_replay:true,allow_partial:true});
  const service=new MediaService({storage:f.storage,archive:restarted,streamArchive:new StreamArchive(f.storage,{max_chunk_bytes:1000000,max_total_bytes:1000000,max_chunks:128,max_revisions:16,max_seq:128}),
    localExecution:f.execution,processor,capabilities:async()=>[cap],demux:port,vad:{candidates:async()=>[{start_ms:200,end_ms:800,semantic_status:'open',basis:'controlled'}]},
    align:{max_chunks:128,max_visual_refs:16,max_frame_gap_ms:250,max_uncertainty_ms:1},max_segments:4,max_window_ms:2000,fixtureOnly:true});
  const request={raw_ref:f.original.raw_ref,archive_revision:f.original.archive_revision,time_range:{kind:'interval' as const,timebase_id:'container-common',start_ms:0,end_ms:1040},clock_maps:maps};
  const result=await service.process('owner',request);assert.equal(result.processed_events.length,1);
  const d=result.processed_events[0]!;assert.equal(d.raw_ref,f.original.raw_ref);assert.equal(d.archive_revision,f.original.archive_revision);assert.equal(d.payload_sha256,sha256(f.bytes));
  assert.equal(d.media_type,'muxed_av');assert.equal(d.representation,'uploaded_original');assert.equal(d.quality.status,'partial');
  assert.ok(d.continuation!.basis_refs.includes(derived.ref));assert.equal(await restarted.validateEvidence(d),true);
  const repeated=await service.process('owner',request);assert.deepEqual(repeated,result);assert.equal(decodes,1);assert.equal(workers,1);
  const nativeEntered=Promise.withResolvers<void>(),logicalRuns=new Map<string,unknown>();
  const native={create:async(_body:unknown,key:string)=>{logicalRuns.set(key,d);nativeEntered.resolve();return {run_id:'controlled-run',session_id:'session',conversation_session_id:'session',status:'running'};},
    status:async()=>({run_id:'controlled-run',session_id:'session',conversation_session_id:'session',status:'running'}),cancel:async()=>{throw new Error('unexpected cancellation');}};
  const admission=new RunAdmission(f.storage,native,{max_pending_events:4,max_pending_bytes:1000000,max_event_age_ms:10000,
    poll_interval_ms:10000,native_idempotency_retention_ms:86400000,policy_version:'demux-fixture'});
  await admission.admit(d,'session','fixed');await nativeEntered.promise;
  await admission.admit(repeated.processed_events[0]!,'session','fixed');assert.equal(logicalRuns.size,1);await admission.close();
  assert.equal(await restarted.validateEvidence({...d,archive_revision:'0'.repeat(64)}),false);
  await service.close();
});

test('source/hash/PTS mismatch refuses evidence and decoder contract drift retains original',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.archive.deriveMedia({...f.original,payload_sha256:'0'.repeat(64)},f.decoder,new AbortController().signal),/DERIVATION_SOURCE_MISMATCH/);
  const port:DemuxPort=traceDecoder(f.decoder,'invalid-output',()=>{},result=>({...result,decoder_id:'invalid-output',event_id:'different'}));
  await assert.rejects(f.archive.deriveMedia(f.original,port,new AbortController().signal),/DEMUX_DERIVATION_CONTRACT_INVALID/);
  await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(f.original,port,new AbortController().signal),/DEMUX_ATTEMPT_UNKNOWN/);
  assert.deepEqual(await f.archive.read(f.original.raw_ref,'owner',f.original.archive_revision),f.bytes);
  const derived=await f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal);
  const chunk=derived.manifest.chunks[0]!;await fs.writeFile(join(f.directory,'l5','objects',chunk.object_hash),Buffer.from('tampered'));
  await assert.rejects(f.archive.readDerivation(f.original,derived.ref),/DERIVATION_OBJECT_INTEGRITY/);
});

test('byte/frame/duration budgets and failed decoder settle explicitly without automatic rerun',async t=>{
  const f=await fixture(t);
  for(const overrides of [{max_output_bytes:32},{max_chunks:1},{max_duration_ms:10},{max_pixels:1}]) {
    const decoder=await FfmpegDemux.create(join(toolchain,'ffmpeg'),join(toolchain,'ffprobe'),join(f.directory,'decoders'),{...budget,...overrides},f.execution);
    await assert.rejects(f.archive.deriveMedia(f.original,decoder,new AbortController().signal),/DEMUX_.*(BUDGET|MISMATCH)/);
    await assert.rejects(f.archive.deriveMedia(f.original,decoder,new AbortController().signal),/DEMUX_PREVIOUS_FAILED/);
  }
  let calls=0;const failed:DemuxPort={decoder_id:'controlled-failed-exit',demux:async()=>{throw new Error('DEMUX_DECODER_FAILED:1');},prepare:async signal=>{const admission=await f.decoder.prepare(signal);return {...admission,execute:async()=>{calls++;throw new Error('DEMUX_DECODER_FAILED:1');}};}};
  await assert.rejects(f.archive.deriveMedia(f.original,failed,new AbortController().signal),/DEMUX_DECODER_FAILED/);
  await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(f.original,failed,new AbortController().signal),/DEMUX_PREVIOUS_FAILED/);assert.equal(calls,1);
  assert.equal((await f.storage.list('manifests')).length,1);
});

test('actual CLI timeout and caller abort join child exit and preserve durable original failure',async t=>{
  const f=await fixture(t);
  await fs.mkdir(join(f.directory,'decoders'),{recursive:true,mode:0o700});
  const slow=join(f.directory,'slow-probe');const marker=join(f.directory,'probe.pid');
  // exec preserves the observed CLI PID through cancellation, without a platform compiler prerequisite.
  await fs.writeFile(slow,`#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(marker+".tmp")}\nmv ${JSON.stringify(marker+".tmp")} ${JSON.stringify(marker)}\nexec sleep 300\n`,{mode:0o700});
  const timeout=await FfmpegDemux.create(join(toolchain,'ffmpeg'),slow,join(f.directory,'decoders'),{...budget,timeout_ms:100},f.execution);
  await assert.rejects(f.archive.deriveMedia(f.original,timeout,new AbortController().signal),/DEMUX_TIMEOUT/);
  const killed=await fs.readFile(marker,'utf8').then(Number,error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(killed!==undefined)assert.throws(()=>process.kill(killed,0),{code:'ESRCH'});
  assert.deepEqual(await fs.readdir(join(f.directory,'decoders')),[]);
  await fs.rm(marker,{force:true});
  const cancellable=await FfmpegDemux.create(join(toolchain,'ffmpeg'),slow,join(f.directory,'decoders'),budget,f.execution);
  const entered=Promise.withResolvers<number>();
  const watcher=watch(f.directory,(_event,file)=>{
    if(file==='probe.pid')void fs.readFile(marker,'utf8').then(value=>{const pid=Number(value);if(pid>0)entered.resolve(pid);},()=>{});
  });
  const abort=new AbortController();const operation=f.archive.deriveMedia(f.original,cancellable,abort.signal);
  const rejected=assert.rejects(operation,/DEMUX_CANCELLED/);
  let childPid:number;
  try {
    childPid=await Promise.race([entered.promise,operation.then(()=>{throw new Error('unexpected decoder success');})]);
    abort.abort();await rejected;
  } finally {watcher.close();abort.abort();await rejected;}
  assert.throws(()=>process.kill(childPid!,0),{code:'ESRCH'});
  assert.deepEqual(await fs.readdir(join(f.directory,'decoders')),[]);
  await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(f.original,cancellable,new AbortController().signal),/DEMUX_PREVIOUS_FAILED/);
  assert.deepEqual(await f.archive.read(f.original.raw_ref,'owner',f.original.archive_revision),f.bytes);
});

test('lost derivation publication is unknown on restart; known durable manifest replays without decoder',async t=>{
  const f=await fixture(t);let calls=0;
  const port:DemuxPort=traceDecoder(f.decoder,f.decoder.decoder_id,()=>{calls++;});
  const publish=f.storage.publish.bind(f.storage);
  f.storage.publish=async(space,key,bytes)=>{if(space==='derived-manifests')throw Object.assign(new Error('disk failure'),{code:'ENOSPC'});return publish(space,key,bytes);};
  await assert.rejects(f.archive.deriveMedia(f.original,port,new AbortController().signal),/disk failure/);
  f.storage.publish=publish;
  await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(f.original,port,new AbortController().signal),/DEMUX_ATTEMPT_UNKNOWN/);
  assert.equal(calls,1);assert.deepEqual(await f.archive.read(f.original.raw_ref,'owner',f.original.archive_revision),f.bytes);
  const second:DemuxPort=traceDecoder(f.decoder,'independent-explicit-profile',()=>{calls++;},decoded=>({...decoded,decoder_id:'independent-explicit-profile'}));
  f.storage.publish=async(space,key,bytes)=>{if(space==='derivation-settlements')throw new Error('settlement lost');return publish(space,key,bytes);};
  await assert.rejects(f.archive.deriveMedia(f.original,second,new AbortController().signal),/settlement lost/);
  f.storage.publish=publish;
  const restored=await new RawArchive(f.storage,1000000).deriveMedia(f.original,second,new AbortController().signal);
  assert.ok(restored.ref.startsWith('l5-derived:'));assert.equal(restored.settlement_coverage,'missing');assert.equal(calls,2);
});

test('derived manifest cannot change PTS or original source while retaining valid structural hashes',async t=>{
  const f=await fixture(t);const derived=await f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal);
  const manifest=structuredClone(derived.manifest);const chunk=manifest.chunks[0]!;chunk.pts.pts_time+=0.5;
  const {fingerprint:_old,received_at:_received,...detail}=chunk;chunk.fingerprint=digest(detail);
  const key=derived.ref.split(':')[1]!;const path=join(f.directory,'l5','derived-manifests',key);
  await fs.writeFile(path,canonical(manifest));
  await assert.rejects(f.archive.readDerivation(f.original,`l5-derived:${key}:${digest(manifest)}`),/DERIVATION_PTS_MISMATCH/);
  manifest.event.payload_sha256='0'.repeat(64);await fs.writeFile(path,canonical(manifest));
  await assert.rejects(f.archive.readDerivation(f.original,`l5-derived:${key}:${digest(manifest)}`),/DERIVATION_SOURCE_MISMATCH/);
});

test('actual ffprobe rejects a durable invalid MP4; independent owners never duplicate decoder execution',async t=>{
  const f=await fixture(t);
  const invalid=await f.archive.archive({schema_version:'paios.event.v1',event_id:'invalid-mp4',device_id:'mac',device_type:'mac',
    captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'upload'},media_type:'muxed_av',mime:'video/mp4',representation:'uploaded_original',payload:Buffer.from('not an MP4')},trusted);
  await assert.rejects(f.archive.deriveMedia(invalid,f.decoder,new AbortController().signal),/DEMUX_DECODER_FAILED/);
  await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(invalid,f.decoder,new AbortController().signal),/DEMUX_PREVIOUS_FAILED/);
  assert.equal(Buffer.from(await f.archive.read(invalid.raw_ref,'owner',invalid.archive_revision)).toString(),'not an MP4');
  let decodes=0;const port:DemuxPort=traceDecoder(f.decoder,f.decoder.decoder_id,()=>{decodes++;});
  const second=new RawArchive(f.storage,1000000);
  const results=await Promise.allSettled([f.archive.deriveMedia(f.original,port,new AbortController().signal),second.deriveMedia(f.original,port,new AbortController().signal)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&/DEMUX_ATTEMPT_UNKNOWN|DEMUX_BUSY/.test(String(r.reason))).length,1);
  assert.equal(decodes,1);
});


test('one actual byte budget spans PNG plus PCM; decoder work never writes media output files',async t=>{
  const f=await fixture(t);const normal=await f.decoder.demux(f.original,f.bytes,new AbortController().signal);
  const audioBytes=normal.chunks.filter(c=>c.modality==='audio').reduce((n,c)=>n+c.data.length,0);
  const videoBytes=normal.chunks.filter(c=>c.modality==='visual').reduce((n,c)=>n+c.data.length,0);
  assert.ok(audioBytes>videoBytes);
  // Each modality fits on its own, but the combined result exceeds this single budget.
  const decoder=await FfmpegDemux.create(join(toolchain,'ffmpeg'),join(toolchain,'ffprobe'),join(f.directory,'decoders'),{...budget,max_output_bytes:audioBytes},f.execution);
  await assert.rejects(f.archive.deriveMedia(f.original,decoder,new AbortController().signal),/DEMUX_OUTPUT_BUDGET/);
  assert.deepEqual(await fs.readdir(join(f.directory,'decoders')),[]);
  const writer=join(f.directory,'bounded-writer'),report=join(f.directory,'writer-report');
  await fs.writeFile(writer,`#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(report)},[process.pid,...fs.readdirSync('.')].join('\\n')+'\\n');\nconst bytes=Buffer.alloc(4096);for(;;)fs.writeSync(1,bytes);\n`,{mode:0o700});
  const oversized=await FfmpegDemux.create(writer,join(toolchain,'ffprobe'),join(f.directory,'decoders'),{...budget,max_output_bytes:1024},f.execution);
  await assert.rejects(f.archive.deriveMedia(f.original,oversized,new AbortController().signal),/DEMUX_OUTPUT_BUDGET/);
  const lines=(await fs.readFile(report,'utf8')).trim().split('\n'),pid=Number(lines[0]);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.deepEqual(lines.slice(1).filter(name=>name!=='.'&&name!=='..'),['original.mp4']);
  assert.deepEqual(await fs.readdir(join(f.directory,'decoders')),[]);
});

test('missing completion record preserves verified manifest effect; conflicting settlements reject replay',async t=>{
  const f=await fixture(t);let calls=0;
  const port:DemuxPort=traceDecoder(f.decoder,f.decoder.decoder_id,()=>{calls++;});
  const derived=await f.archive.deriveMedia(f.original,port,new AbortController().signal);
  assert.equal(derived.settlement_coverage,'complete');const key=derived.ref.split(':')[1]!;
  const path=join(f.directory,'l5','derivation-settlements',key),saved=JSON.parse(await fs.readFile(path,'utf8'));
  await fs.unlink(path);
  const recovered=await new RawArchive(f.storage,1000000).deriveMedia(f.original,port,new AbortController().signal);
  assert.equal(recovered.ref,derived.ref);assert.equal(recovered.settlement_coverage,'missing');assert.equal(calls,1);
  assert.equal((await f.archive.readDerivation(f.original,derived.ref)).settlement_coverage,'missing');
  for(const changed of [{...saved,outcome:'failed',error_code:'contradiction'}, {...saved,attempt_id:'wrong-attempt'},
    {...saved,manifest_ref:'l5-derived:wrong'}, {...saved,error_code:'contradictory-error'}, {...saved,outcome:'unknown'}]) {
    await fs.writeFile(path,canonical(changed));
    await assert.rejects(f.archive.readDerivation(f.original,derived.ref),/DERIVATION_SETTLEMENT_CONFLICT/);
    await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(f.original,port,new AbortController().signal),/DERIVATION_SETTLEMENT_CONFLICT/);
  }
  await fs.writeFile(path,canonical(saved));
  assert.equal((await f.archive.readDerivation(f.original,derived.ref)).settlement_coverage,'complete');assert.equal(calls,1);
  const manifestPath=join(f.directory,'l5','derived-manifests',key),manifestBytes=await fs.readFile(manifestPath);
  await fs.unlink(manifestPath);
  await assert.rejects(new RawArchive(f.storage,1000000).deriveMedia(f.original,port,new AbortController().signal),/DERIVATION_SETTLEMENT_CONFLICT/);
  assert.equal(calls,1);await fs.writeFile(manifestPath,manifestBytes);
});


test('pre-attempt busy/closed/cancelled creates no durable attempt; release permits same original and cached replay uses no slot',async t=>{
  const f=await fixture(t);
  const held=await f.execution.reserve('audio',new AbortController().signal,5000);
  await assert.rejects(f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal),/DEMUX_BUSY/);
  assert.deepEqual(await f.storage.list('derivation-attempts'),[]);
  assert.deepEqual(await f.storage.list('derivation-settlements'),[]);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(f.archive.deriveMedia(f.original,f.decoder,cancelled.signal),/DEMUX_CANCELLED/);
  assert.deepEqual(await f.storage.list('derivation-attempts'),[]);
  await held.release();
  const completed=await f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal);
  const busy=await f.execution.reserve('audio',new AbortController().signal,5000);
  assert.equal((await new RawArchive(f.storage,1000000).deriveMedia(f.original,f.decoder,new AbortController().signal)).ref,completed.ref);
  await busy.release();
  await f.execution.close();
  assert.equal((await new RawArchive(f.storage,1000000).deriveMedia(f.original,f.decoder,new AbortController().signal)).ref,completed.ref);
  const other=await f.archive.archive({schema_version:'paios.event.v1',event_id:'closed-before-attempt',device_id:'mac',device_type:'mac',
    captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'upload'},media_type:'muxed_av',mime:'video/mp4',representation:'uploaded_original',payload:f.bytes},trusted);
  await assert.rejects(f.archive.deriveMedia(other,f.decoder,new AbortController().signal),/DEMUX_CLOSED/);
  assert.equal((await f.storage.list('derivation-attempts')).length,1);
});

test('an audio child holding the shared audio lease blocks the real decoder before durable admission',async t=>{
  const f=await fixture(t);
  const script=join(f.directory,'audio-hold.cjs');
  const marker=join(f.directory,'audio-started');
  await fs.writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdin.resume();setInterval(()=>{},1000);`);
  const abort=new AbortController(),reservation=await f.execution.reserve('audio',abort.signal,2000);
  const entered=Promise.withResolvers<void>();
  const watcher=watch(f.directory,(_event,file)=>{
    if(file==='audio-started')entered.resolve();
  });
  watcher.on('error',entered.reject);
  const work=reservation.run({executable:process.execPath,args:[script],cwd:f.directory,stdin_limit_bytes:0,stdout_limit_bytes:1024,
    stderr_limit_bytes:1024,stderr_mode:'tail'});
  const rejected=assert.rejects(work,/MEDIA_CANCELLED/);
  try {
    await Promise.race([entered.promise,work.then(()=>{throw new Error('audio child exited before ready');})]);
    assert.ok(await fs.stat(marker));
    await assert.rejects(f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal),/DEMUX_BUSY/);
    assert.deepEqual(await f.storage.list('derivation-attempts'),[]);
  } finally {
    watcher.close();abort.abort();
    try {await rejected;} finally {await reservation.release();}
  }
  const derived=await f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal);
  assert.ok(derived.manifest.chunks.some(chunk=>chunk.modality==='audio'));
});

async function audioFixture(t:test.TestContext,options:{rate?:number;channels?:number;duration?:number;codec?:string}={}) {
  const directory=await fs.mkdtemp(join(tmpdir(),'paios-aac-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const output=join(directory,'utterance.mp4'),codec=options.codec??'aac';
  await run(join(toolchain,'ffmpeg'),['-hide_banner','-nostdin','-y','-f','lavfi','-i',
    `sine=frequency=440:sample_rate=${options.rate??16000}:duration=${options.duration??1}`,
    '-ac',String(options.channels??1),'-c:a',codec,...(codec==='aac'?['-profile:a','aac_low']:[]),'-f',codec==='aac'?'mp4':'mov',output]);
  const bytes=await fs.readFile(output),storage=new PosixStorage(join(directory,'l5')),archive=new RawArchive(storage,1000000);
  const original=await archive.archive({schema_version:'paios.event.v1',event_id:'watch-utterance',device_id:'watch',device_type:'watch',
    captured_at:'2026-10-16T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/mp4',representation:'uploaded_original',payload:bytes},
    {...trusted,device_id:'watch',device_type:'watch',channel:'watch_connectivity'});
  const execution=await LocalMediaExecution.create({runtime:directory,slots:1});
  const decoder=await FfmpegDemux.create(join(toolchain,'ffmpeg'),join(toolchain,'ffprobe'),join(directory,'decoders'),
    {...budget,timeout_ms:10000,max_chunks:1024,max_output_bytes:2000000,max_duration_ms:60000},execution);
  return {archive,original,decoder,storage,bytes};
}
test('real Watch AAC-LC MP4 preserves original and derives exact 16k mono s16le duration with durable replay',async t=>{
  for(const duration of [1,30]) {
    const f=await audioFixture(t,{duration});
    const result=await f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal),chunks=result.manifest.chunks;
    assert.equal(chunks.length,1);assert.ok(chunks.every(c=>c.modality==='audio'&&c.format==='pcm_s16le:16000:1'&&c.mime==='audio/pcm'));
    const pcm=Buffer.concat(await Promise.all(chunks.map(c=>f.storage.read('objects',c.object_hash))));
    assert.equal(pcm.length/32,duration*1000);assert.ok(pcm.some(byte=>byte!==0));
    assert.equal(chunks[0]!.source_range.kind,'interval');
    const last=chunks.at(-1)!;assert.equal(last.source_range.kind==='interval'&&last.source_range.end_ms,duration*1000);
    assert.deepEqual(await f.archive.read(f.original.raw_ref,'owner',f.original.archive_revision),f.bytes);
    const replay=await new RawArchive(f.storage,1000000).deriveMedia(f.original,f.decoder,new AbortController().signal);
    assert.equal(replay.ref,result.ref);
  }
});
test('real MP4 properties reject non-AAC, wrong rate/channels and actual duration over 30s',async t=>{
  for(const options of [{codec:'pcm_s16le'},{rate:8000},{channels:2},{duration:30.1}]) {
    const f=await audioFixture(t,options);
    await assert.rejects(f.archive.deriveMedia(f.original,f.decoder,new AbortController().signal),
      options.duration?/DEMUX_DURATION_BUDGET/:/DEMUX_AUDIO_CODEC_UNSUPPORTED/);
    assert.deepEqual(await f.archive.read(f.original.raw_ref,'owner',f.original.archive_revision),f.bytes);
    assert.deepEqual(await f.storage.list('derived-manifests'),[]);
  }
});
